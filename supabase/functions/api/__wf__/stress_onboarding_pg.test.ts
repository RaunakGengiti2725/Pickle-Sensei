/**
 * stress/onboarding — Postgres-backed leg of the `PUT /v1/me/onboarding` stress
 * campaign (lens: failure-load).
 *
 * The route's only database write is one PostgREST call:
 *
 *   profiles.update(patch).eq("id", authed.id).select(...).maybeSingle()
 *
 * which PostgREST executes as `UPDATE public.profiles SET … WHERE id = $1
 * RETURNING …` under `role authenticated` with `request.jwt.claim.sub` set.
 * The in-process harness (stress_onboarding_harness.ts) models that call; this
 * file replays the SAME statements against a disposable postgres:16 with every
 * migration applied (./xc_pg_up.sh), so the model's two load-bearing
 * assumptions are checked against the real schema:
 *
 *   PG1  every payload the route accepts (oracle → 200) is accepted by the
 *        table too — column grants, CHECK constraints (handedness/gender
 *        enums, `profiles_text_bounds`, `profiles_first_name_length`) and
 *        the `onboarding_state` enum all admit the exact patch the route
 *        sends, and RETURNING gives the row back (`!updated.data` → 503
 *        would otherwise fire for a VALID request);
 *   PG2  duplicate delivery is idempotent — replaying the same PUT (mobile
 *        retry after a lost response) yields the same row, no error;
 *   PG3  the row is owner-scoped — the identical statement issued under
 *        another user's `sub` updates 0 rows (RLS), which is exactly the
 *        `maybeSingle() → null` the route maps to 503, never a cross-user
 *        write;
 *   PG4  the route's caps are ≤ the table's: the longest values the route
 *        admits (64/64/256 chars incl. astral code points, first_name 40)
 *        never trip a NOT VALID size cap after deploy.
 *
 * Plus a small latency sample (STRESS_PG_ITER sequential updates) so the DB
 * leg of the request has a measured p50/p95 alongside the in-process numbers.
 *
 * Ignored unless STRESS_PG_URL (or XC_PG_URL / PICKLE_AUDIT_PG_URL) points at a
 * disposable database. Never points at a hosted project.
 *
 *   ./xc_pg_up.sh && XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_PG_ITER=1000 deno test -A --no-check --config deno.json stress_onboarding_pg.test.ts
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  envInt,
  expectedFor,
  fuzzOnboardingBody,
  GENDERS,
  histogram,
  type Invariant,
  latencyStats,
  Prng,
  round,
  STRESS_SEED,
  type StressReport,
  userIdAt,
  writeReport,
} from "./stress_onboarding_harness.ts";

const PG_URL =
  Deno.env.get("STRESS_PG_URL") ??
  Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ??
  "";
const ignore = PG_URL === "";
const PG_ITER = envInt("STRESS_PG_ITER", 48);
const PG_USERS = envInt("STRESS_PG_USERS", 16);

type Sql = ReturnType<typeof postgres>;

/** Exactly the columns the route selects back (index.ts PUT /v1/me/onboarding). */
const RETURNING =
  "skill_level, handedness, primary_goal, biggest_problem, focus_checkpoint, first_name, gender";

const PATCH_COLUMNS = [
  "skill_level",
  "handedness",
  "primary_goal",
  "biggest_problem",
  "focus_checkpoint",
  "onboarding_state",
  "first_name",
  "gender",
] as const;

interface PgRow {
  id: string;
  seed: number;
  user: string;
  kind: "fuzz" | "duplicate" | "cross_user" | "max_len";
  patchColumns: string[];
  rows: number;
  sqlstate?: string;
  message?: string;
  durationMs: number;
  matches?: boolean;
}

function pgUserId(index: number): string {
  return userIdAt(0x5000_0000 + index);
}

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
       values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
  const profile = await sql.unsafe(`select id from public.profiles where id = '${userId}'`);
  assertEquals(profile.length, 1, "signup trigger must provision the profile row");
}

/** The PostgREST-equivalent statement, parameterized exactly like the route's patch. */
async function routeUpdate(
  sql: Sql,
  asSub: string,
  targetId: string,
  patch: Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[]; sqlstate?: string; message?: string }> {
  const cols = PATCH_COLUMNS.filter((c) => c in patch);
  const set = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
  const params = cols.map((c) => patch[c] as string);
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role authenticated`);
      await tx.unsafe(`set local request.jwt.claim.sub = '${asSub}'`);
      return await tx.unsafe(
        `update public.profiles set ${set} where id = '${targetId}' returning ${RETURNING}`,
        params,
      );
    });
    return { rows: rows as unknown as Record<string, unknown>[] };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { rows: [], sqlstate: e.code, message: e.message };
  }
}

function rowMatchesPatch(row: Record<string, unknown>, patch: Record<string, unknown>): boolean {
  for (const col of Object.keys(patch)) {
    if (col === "onboarding_state") continue; // not in RETURNING; checked separately
    if (row[col] !== patch[col]) return false;
  }
  return true;
}

Deno.test({
  name: "stress/onboarding pg: PUT patch vs real schema (grants, checks, RLS, idempotency, latency)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const rows: PgRow[] = [];
    const invariants: Invariant[] = [];
    const latencies: number[] = [];
    try {
      const users = Array.from({ length: PG_USERS }, (_, i) => pgUserId(i));
      for (const u of users) await createUser(sql, u);

      // PG1 + latency: seeded oracle-200 payloads → real UPDATE … RETURNING.
      const rng = new Prng(STRESS_SEED ^ 0x9e37);
      let accepted = 0;
      let i = 0;
      while (accepted < PG_ITER) {
        const seed = rng.int(0xffffffff);
        const body = fuzzOnboardingBody(new Prng(seed));
        const expected = expectedFor(body);
        if (expected.status !== 200 || !expected.patch) continue;
        const user = users[i++ % users.length];
        const started = performance.now();
        const r = await routeUpdate(sql, user, user, expected.patch);
        const durationMs = performance.now() - started;
        latencies.push(durationMs);
        rows.push({
          id: `PG1-${accepted}`,
          seed,
          user,
          kind: "fuzz",
          patchColumns: Object.keys(expected.patch),
          rows: r.rows.length,
          sqlstate: r.sqlstate,
          message: r.message,
          durationMs: round(durationMs),
          matches: r.rows.length === 1 ? rowMatchesPatch(r.rows[0], expected.patch) : false,
        });
        accepted++;
      }
      const pg1 = rows.filter((r) => r.kind === "fuzz");
      invariants.push({
        name: "PG1 every route-accepted patch is accepted by the table and RETURNING yields the row",
        holds: pg1.every((r) => r.rows === 1 && r.matches && !r.sqlstate),
        detail: `${pg1.filter((r) => r.rows === 1 && r.matches).length}/${pg1.length} ok; sqlstates=${JSON.stringify(histogram(pg1.map((r) => r.sqlstate ?? "none")))}`,
      });
      const state = await sql.unsafe(
        `select count(*)::int as n from public.profiles where id = any($1::uuid[]) and onboarding_state = 'complete'`,
        [users],
      );
      invariants.push({
        name: "PG1b onboarding_state flips to 'complete' for every updated owner",
        holds: state[0].n === users.length,
        detail: `${state[0].n}/${users.length} complete`,
      });

      // PG2 duplicate delivery: same PUT twice → identical row, no error.
      const dupSeed = pg1[0].seed;
      const dupPatch = expectedFor(fuzzOnboardingBody(new Prng(dupSeed))).patch!;
      const first = await routeUpdate(sql, users[0], users[0], dupPatch);
      const second = await routeUpdate(sql, users[0], users[0], dupPatch);
      rows.push({
        id: "PG2",
        seed: dupSeed,
        user: users[0],
        kind: "duplicate",
        patchColumns: Object.keys(dupPatch),
        rows: second.rows.length,
        sqlstate: second.sqlstate,
        durationMs: 0,
        matches: JSON.stringify(first.rows) === JSON.stringify(second.rows),
      });
      invariants.push({
        name: "PG2 duplicate PUT is idempotent (same row, no error)",
        holds:
          first.rows.length === 1 &&
          second.rows.length === 1 &&
          JSON.stringify(first.rows) === JSON.stringify(second.rows),
        detail: `first=${first.rows.length} second=${second.rows.length} sqlstate=${second.sqlstate ?? "none"}`,
      });

      // PG3 cross-user: user B's sub against user A's id → 0 rows, A unchanged.
      const before = await sql.unsafe(`select ${RETURNING} from public.profiles where id = $1`, [
        users[0],
      ]);
      const forged = await routeUpdate(sql, users[1], users[0], {
        ...dupPatch,
        first_name: "Mallory",
        biggest_problem: "forged",
      });
      const after = await sql.unsafe(`select ${RETURNING} from public.profiles where id = $1`, [
        users[0],
      ]);
      rows.push({
        id: "PG3",
        seed: dupSeed,
        user: users[1],
        kind: "cross_user",
        patchColumns: Object.keys(dupPatch),
        rows: forged.rows.length,
        sqlstate: forged.sqlstate,
        durationMs: 0,
        matches: JSON.stringify(before) === JSON.stringify(after),
      });
      invariants.push({
        name: "PG3 another user's sub updates 0 rows (RLS) and leaves the owner row untouched",
        holds:
          forged.rows.length === 0 &&
          !forged.sqlstate &&
          JSON.stringify(before) === JSON.stringify(after),
        detail: `rows=${forged.rows.length} sqlstate=${forged.sqlstate ?? "none"} unchanged=${JSON.stringify(before) === JSON.stringify(after)}`,
      });

      // PG4 the route's maxima vs the table's NOT VALID caps (incl. astral chars:
      // the route measures UTF-16 units, Postgres length() counts code points,
      // so the route's cap is the tighter one — pin that).
      const astral = "\u{1F3D3}"; // 🏓 = 2 UTF-16 units, 1 code point
      const maxPatches: Record<string, Record<string, unknown>> = {
        ascii: {
          skill_level: "s".repeat(64),
          handedness: "left",
          primary_goal: "g".repeat(64),
          biggest_problem: "p".repeat(256),
          focus_checkpoint: "contact_position",
          onboarding_state: "complete",
          first_name: "n".repeat(40),
          gender: GENDERS[3],
        },
        astral: {
          skill_level: astral.repeat(32),
          handedness: "right",
          primary_goal: astral.repeat(32),
          biggest_problem: astral.repeat(128),
          focus_checkpoint: "contact_position",
          onboarding_state: "complete",
          first_name: astral.repeat(20),
          gender: GENDERS[0],
        },
      };
      let n = 0;
      for (const [label, patch] of Object.entries(maxPatches)) {
        const user = users[2 + n++];
        const r = await routeUpdate(sql, user, user, patch);
        rows.push({
          id: `PG4-${label}`,
          seed: 0,
          user,
          kind: "max_len",
          patchColumns: Object.keys(patch),
          rows: r.rows.length,
          sqlstate: r.sqlstate,
          message: r.message,
          durationMs: 0,
          matches: r.rows.length === 1 ? rowMatchesPatch(r.rows[0], patch) : false,
        });
      }
      const pg4 = rows.filter((r) => r.kind === "max_len");
      invariants.push({
        name: "PG4 route maxima (64/64/256/40, ascii + astral) fit every table cap",
        holds: pg4.every((r) => r.rows === 1 && r.matches),
        detail: pg4.map((r) => `${r.id}:rows=${r.rows}:${r.sqlstate ?? "ok"}`).join(" "),
      });

      const report: StressReport = {
        campaign: "onboarding_pg",
        seed: STRESS_SEED,
        scale: { iterations: PG_ITER, users: PG_USERS },
        replay: `STRESS_SEED=${STRESS_SEED} STRESS_PG_ITER=${PG_ITER} STRESS_PG_USERS=${PG_USERS} XC_PG_URL=<disposable> deno test -A --no-check --config deno.json stress_onboarding_pg.test.ts`,
        redis: false,
        rows,
        aggregates: {
          updateLatencyMs: latencyStats(latencies),
          sqlstates: histogram(rows.map((r) => r.sqlstate ?? "none")),
        },
        invariants,
        broken: rows.filter(
          (r) =>
            (r.kind !== "cross_user" && (r.rows !== 1 || r.matches === false || r.sqlstate)) ||
            (r.kind === "cross_user" && (r.rows !== 0 || r.sqlstate)),
        ),
        startedAt,
        durationMs: round(performance.now() - t0),
      };
      await writeReport(report);
      for (const inv of invariants) assert(inv.holds, `${inv.name}: ${inv.detail}`);
    } finally {
      await sql.unsafe(`reset role`).catch(() => {});
      await sql.end({ timeout: 5 });
    }
  },
});
