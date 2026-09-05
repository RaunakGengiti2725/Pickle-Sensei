/**
 * stress POST /v1/sessions — REAL Postgres half.
 *
 * stress_route_post_v1_sessions_fuzz.test.ts drives the real handler over a
 * MODELLED sessions table. This file pins the model's assumptions against a
 * disposable postgres:16 with shim_auth.sql + every migration applied
 * (./xc_pg_up.sh), executing exactly the two statements PostgREST derives
 * from createSession() (index.ts):
 *
 *   upsert({id,user_id,started_at}, {onConflict:"id", ignoreDuplicates:true})
 *     → INSERT INTO public.sessions (id, user_id, started_at) VALUES (…)
 *       ON CONFLICT (id) DO NOTHING
 *   select("id").eq("id",…).eq("user_id",…).maybeSingle()
 *     → SELECT id FROM public.sessions WHERE id = … AND user_id = …
 *
 * as role `authenticated` with `request.jwt.claim.sub` = the caller, so RLS,
 * grants, the profiles FK and ON CONFLICT semantics are the real ones.
 *
 *   ./xc_pg_up.sh                      # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_PG_ITER=300 STRESS_OUT=/tmp/stress \
 *     deno test -A --no-check --config deno.json stress_route_post_v1_sessions_pg.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 * Seeded (STRESS_SEED); every scenario row records its seed and inputs.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  caseSeed,
  defaultOutDir,
  envInt,
  envSeeds,
  poolUser,
  Prng,
} from "./stress_route_post_v1_sessions_lib.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const ITER = envInt("STRESS_PG_ITER", 40);
const BASE_SEED = envInt("STRESS_SEED", 20260904);
const ONLY = envSeeds("STRESS_PG_SEEDS");
const OUT_DIR = Deno.env.get("STRESS_OUT") || defaultOutDir();
const LANES = envInt("STRESS_PG_LANES", 16);

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

/** The handler's own validator accepts years 2000 ≤ y < 2100 — these are the
 * instants at and beside those edges plus the calendar corners. */
const BOUNDARY_STARTED_AT = [
  "2000-01-01T00:00:00.000Z",
  "2000-02-29T23:59:59.999Z",
  "2024-02-29T12:00:00.000Z",
  "2099-12-31T23:59:59.999Z",
  "2038-01-19T03:14:07.000Z",
  "2038-01-19T03:14:08.000Z",
  "1970-01-01T00:00:00.000Z",
  "9999-12-31T23:59:59.999Z",
];

interface PgStep {
  op: "insert" | "select";
  asUser: string;
  id: string;
  userId: string;
  startedAt?: string;
  /** rows affected (insert) or rows returned (select) */
  rows: number | null;
  sqlstate: string | null;
  message: string | null;
}

interface PgScenario {
  seed: number;
  kind: string;
  steps: PgStep[];
  finalRow: {
    user_id: string;
    started_at: string;
    kind: string;
    event_count: number;
    ended_at: string | null;
  } | null;
  violations: string[];
  notes: string[];
  ok: boolean;
}

interface PgReport {
  meta: {
    pgUrlHost: string;
    baseSeed: number;
    iterations: number;
    lanes: number;
    startedAt: string;
    finishedAt: string;
  };
  summary: {
    scenarios: number;
    statements: number;
    failedSeeds: number[];
    kinds: Record<string, number>;
    sqlstates: Record<string, number>;
  };
  scenarios: PgScenario[];
}

const PG_ERROR_RE = /^(\d{2}[0-9A-Z]{3})$/;

function pgError(error: unknown): { sqlstate: string; message: string } {
  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    const code = typeof rec.code === "string" && PG_ERROR_RE.test(rec.code) ? rec.code : "?????";
    const message = typeof rec.message === "string" ? rec.message : String(error);
    return { sqlstate: code, message };
  }
  return { sqlstate: "?????", message: String(error) };
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
}

/** Exactly what PostgREST does for the handler's upsert (return=minimal):
 * one statement in its own transaction as the caller. A raised error aborts
 * and rolls back that transaction — recorded as the step's sqlstate. */
async function handlerInsert(
  sql: Sql,
  asUserId: string,
  id: string,
  userId: string,
  startedAt: string,
  gate?: { ready: () => void; open: Promise<void> },
): Promise<PgStep> {
  const step: PgStep = {
    op: "insert",
    asUser: asUserId,
    id,
    userId,
    startedAt,
    rows: null,
    sqlstate: null,
    message: null,
  };
  try {
    const count = await sql.begin(async (tx) => {
      await asUser(tx as unknown as Tx, asUserId);
      if (gate) {
        gate.ready();
        await gate.open;
      }
      const r = await tx.unsafe(
        `insert into public.sessions (id, user_id, started_at) values ($1, $2, $3) on conflict (id) do nothing`,
        [id, userId, startedAt],
      );
      return r.count;
    });
    step.rows = Number(count);
  } catch (error) {
    const e = pgError(error);
    step.sqlstate = e.sqlstate;
    step.message = e.message;
  }
  return step;
}

/** Exactly what PostgREST does for the handler's owner lookup. */
async function handlerSelect(
  sql: Sql,
  asUserId: string,
  id: string,
  userId: string,
): Promise<PgStep> {
  const step: PgStep = {
    op: "select",
    asUser: asUserId,
    id,
    userId,
    rows: null,
    sqlstate: null,
    message: null,
  };
  try {
    const n = await sql.begin(async (tx) => {
      await asUser(tx as unknown as Tx, asUserId);
      const r = await tx.unsafe(`select id from public.sessions where id = $1 and user_id = $2`, [
        id,
        userId,
      ]);
      return r.length;
    });
    step.rows = Number(n);
  } catch (error) {
    const e = pgError(error);
    step.sqlstate = e.sqlstate;
    step.message = e.message;
  }
  return step;
}

/** One handler invocation = the two statements, each in its own PostgREST
 * transaction (PostgREST wraps every request separately — mirror that). */
async function handlerCall(
  sql: Sql,
  caller: string,
  id: string,
  startedAt: string,
): Promise<PgStep[]> {
  const insert = await handlerInsert(sql, caller, id, caller, startedAt);
  const select = await handlerSelect(sql, caller, id, caller);
  return [insert, select];
}

async function ownerRow(sql: Sql, id: string): Promise<PgScenario["finalRow"]> {
  const rows = await sql.unsafe(
    `select user_id::text as user_id, to_char(started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as started_at,
            kind, event_count, ended_at::text as ended_at
       from public.sessions where id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    user_id: r.user_id,
    started_at: r.started_at,
    kind: r.kind,
    event_count: Number(r.event_count),
    ended_at: r.ended_at,
  };
}

async function ensureUsers(sql: Sql, users: string[]): Promise<void> {
  for (const userId of users) {
    await sql.unsafe(`delete from auth.users where id = $1`, [userId]);
    await sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, '{"provider":"google"}')`,
      [userId, `${userId}@example.com`],
    );
  }
}

/** Handler-equivalent status for a (insert, select) pair, per createSession(). */
function handlerStatus(steps: PgStep[]): number {
  const [insert, select] = steps;
  if (insert.sqlstate) return 503;
  if (select.sqlstate) return 503;
  return select.rows === 1 ? 200 : 409;
}

Deno.test({
  name: "stress POST /v1/sessions — real Postgres: ON CONFLICT DO NOTHING + owner lookup under RLS (seeded)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: LANES + 2, onnotice: () => {} });
    const startedAt = new Date().toISOString();
    const users = [poolUser(0x50), poolUser(0x51), poolUser(0x52)];
    const ghost = poolUser(0x5f); // never created: no auth.users, no profile
    try {
      await ensureUsers(sql, users);
      const seeds =
        ONLY && ONLY.length > 0
          ? ONLY
          : Array.from({ length: ITER }, (_, i) => caseSeed(BASE_SEED, i));
      const scenarios: PgScenario[] = [];
      let statements = 0;
      for (const seed of seeds) {
        const rng = new Prng(seed);
        const kind = rng.pick([
          "first-delivery",
          "first-delivery",
          "replay-same-user",
          "replay-same-user-different-started-at",
          "same-id-other-user",
          "cross-user-spoofed-user-id",
          "no-profile-user",
          "burst-same-id",
        ] as const);
        const id = rng.uuid();
        const owner = rng.pick(users);
        const other = users.find((u) => u !== owner) ?? users[1];
        const startedA = rng.chance(0.4)
          ? rng.pick(BOUNDARY_STARTED_AT)
          : new Date(
              Date.UTC(
                2000 + rng.int(0, 99),
                rng.int(0, 11),
                rng.int(1, 28),
                rng.int(0, 23),
                rng.int(0, 59),
                rng.int(0, 59),
                rng.int(0, 999),
              ),
            ).toISOString();
        const startedB = rng.pick(BOUNDARY_STARTED_AT);
        const scenario: PgScenario = {
          seed,
          kind,
          steps: [],
          finalRow: null,
          violations: [],
          notes: [],
          ok: true,
        };
        const inRange = (iso: string) => {
          const y = Number(iso.slice(0, 4));
          return y >= 2000 && y < 2100;
        };

        const expectRow = (row: PgScenario["finalRow"], userId: string, started: string) => {
          if (!row) {
            scenario.violations.push("expected a sessions row, found none");
            return;
          }
          if (row.user_id !== userId)
            scenario.violations.push(`row user_id ${row.user_id} ≠ ${userId}`);
          if (row.started_at !== started)
            scenario.violations.push(`row started_at ${row.started_at} ≠ ${started}`);
          if (row.kind !== "practice") scenario.violations.push(`row kind ${row.kind} ≠ practice`);
          if (row.event_count !== 0)
            scenario.violations.push(`row event_count ${row.event_count} ≠ 0`);
          if (row.ended_at !== null)
            scenario.violations.push(`row ended_at ${row.ended_at} ≠ null`);
        };

        switch (kind) {
          case "first-delivery": {
            const steps = await handlerCall(sql, owner, id, startedA);
            scenario.steps.push(...steps);
            const status = handlerStatus(steps);
            if (status !== 200)
              scenario.violations.push(
                `first delivery → ${status}, expected 200 (${steps.map((s) => s.sqlstate ?? s.rows).join("/")})`,
              );
            if (steps[0].rows !== 1)
              scenario.violations.push(`insert affected ${steps[0].rows} rows, expected 1`);
            expectRow(await ownerRow(sql, id), owner, startedA);
            break;
          }
          case "replay-same-user":
          case "replay-same-user-different-started-at": {
            const first = await handlerCall(sql, owner, id, startedA);
            const replay = await handlerCall(
              sql,
              owner,
              id,
              kind === "replay-same-user" ? startedA : startedB,
            );
            scenario.steps.push(...first, ...replay);
            if (handlerStatus(first) !== 200)
              scenario.violations.push(`first → ${handlerStatus(first)}`);
            if (handlerStatus(replay) !== 200)
              scenario.violations.push(`replay → ${handlerStatus(replay)}, expected 200`);
            if (replay[0].rows !== 0)
              scenario.violations.push(
                `replay insert affected ${replay[0].rows} rows, expected 0 (DO NOTHING)`,
              );
            if (replay[0].sqlstate)
              scenario.violations.push(`replay insert raised ${replay[0].sqlstate}`);
            expectRow(await ownerRow(sql, id), owner, startedA); // first write wins
            break;
          }
          case "same-id-other-user": {
            const first = await handlerCall(sql, owner, id, startedA);
            const theft = await handlerCall(sql, other, id, startedB);
            scenario.steps.push(...first, ...theft);
            if (handlerStatus(first) !== 200)
              scenario.violations.push(`first → ${handlerStatus(first)}`);
            const status = handlerStatus(theft);
            if (status !== 409)
              scenario.violations.push(`other user same id → ${status}, expected 409`);
            if (theft[0].sqlstate)
              scenario.violations.push(
                `other-user insert raised ${theft[0].sqlstate} (expected silent DO NOTHING)`,
              );
            if (theft[0].rows !== 0)
              scenario.violations.push(`other-user insert affected ${theft[0].rows} rows`);
            if (theft[1].rows !== 0)
              scenario.violations.push(`other user can see the owner's row through RLS`);
            expectRow(await ownerRow(sql, id), owner, startedA);
            break;
          }
          case "cross-user-spoofed-user-id": {
            // Not reachable through the handler (user_id is always authed.id) —
            // pins the RLS WITH CHECK the in-memory model reproduces as 42501.
            const step = await handlerInsert(sql, other, id, owner, startedA);
            scenario.steps.push(step);
            if (step.sqlstate !== "42501")
              scenario.violations.push(
                `spoofed user_id → ${step.sqlstate ?? "no error"}, expected 42501`,
              );
            if (await ownerRow(sql, id)) scenario.violations.push("spoofed insert created a row");
            break;
          }
          case "no-profile-user": {
            const steps = await handlerCall(sql, ghost, id, startedA);
            scenario.steps.push(...steps);
            if (steps[0].sqlstate !== "23503")
              scenario.violations.push(
                `no-profile insert → ${steps[0].sqlstate ?? "no error"}, expected 23503`,
              );
            if (handlerStatus(steps) !== 503)
              scenario.violations.push(`no-profile → ${handlerStatus(steps)}, expected 503`);
            if (await ownerRow(sql, id))
              scenario.violations.push("no-profile insert created a row");
            break;
          }
          case "burst-same-id": {
            // LANES concurrent deliveries of one id: the owner's replays plus
            // other users racing for the same id. Exactly one row, no lane errors.
            const laneUsers = Array.from({ length: LANES }, () =>
              rng.chance(0.7) ? owner : other,
            );
            let ready = 0;
            let open!: () => void;
            const gate = { ready: () => (ready += 1), open: new Promise<void>((r) => (open = r)) };
            const inserts = Promise.all(
              laneUsers.map((caller, lane) =>
                handlerInsert(sql, caller, id, caller, lane % 2 === 0 ? startedA : startedB, gate),
              ),
            );
            while (ready < LANES) await new Promise((r) => setTimeout(r, 1));
            open();
            const laneSteps = await inserts;
            scenario.steps.push(...laneSteps);
            const created = laneSteps.filter((s) => s.rows === 1).length;
            const raised = laneSteps.filter((s) => s.sqlstate);
            if (created !== 1)
              scenario.violations.push(`${created} lanes reported an insert, expected exactly 1`);
            if (raised.length > 0)
              scenario.violations.push(
                `${raised.length} lane(s) raised: ${[...new Set(raised.map((s) => s.sqlstate))].join(",")}`,
              );
            const winner = laneSteps.find((s) => s.rows === 1);
            const row = await ownerRow(sql, id);
            if (winner && row) expectRow(row, winner.userId, winner.startedAt ?? "");
            else if (!row) scenario.violations.push("burst left no row");
            const count = await sql.unsafe(
              `select count(*)::int as n from public.sessions where id = $1`,
              [id],
            );
            if (Number(count[0].n) !== 1) scenario.violations.push(`${count[0].n} rows for one id`);
            break;
          }
        }
        // Out-of-range instants never reach the database (the handler's
        // validator refuses them); timestamptz would store them, so the
        // handler is the only guard — recorded, not a violation.
        if (
          !inRange(startedA) &&
          scenario.steps[0]?.op === "insert" &&
          scenario.steps[0].sqlstate === null &&
          scenario.steps[0].rows === 1
        ) {
          scenario.notes.push(
            `db accepted out-of-range started_at ${startedA}; the handler validator is the only guard`,
          );
        }
        statements += scenario.steps.length;
        scenario.finalRow = await ownerRow(sql, id);
        scenario.ok = scenario.violations.length === 0;
        scenarios.push(scenario);
      }

      const kinds: Record<string, number> = {};
      const sqlstates: Record<string, number> = {};
      for (const s of scenarios) {
        kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
        for (const st of s.steps)
          if (st.sqlstate) sqlstates[st.sqlstate] = (sqlstates[st.sqlstate] ?? 0) + 1;
      }
      const failed = scenarios.filter((s) => !s.ok).map((s) => s.seed);
      const report: PgReport = {
        meta: {
          pgUrlHost: new URL(PG_URL).host,
          baseSeed: BASE_SEED,
          iterations: seeds.length,
          lanes: LANES,
          startedAt,
          finishedAt: new Date().toISOString(),
        },
        summary: { scenarios: scenarios.length, statements, failedSeeds: failed, kinds, sqlstates },
        scenarios,
      };
      await Deno.mkdir(OUT_DIR, { recursive: true });
      const path = `${OUT_DIR}/pg_sessions.json`;
      await Deno.writeTextFile(path, JSON.stringify(report, null, 1));
      console.log(`[stress-pg] ${statements} statements / ${scenarios.length} scenarios → ${path}`);
      console.log(
        `[stress-pg] kinds ${JSON.stringify(kinds)} sqlstates ${JSON.stringify(sqlstates)}`,
      );
      if (failed.length > 0) {
        for (const s of scenarios.filter((x) => !x.ok).slice(0, 10)) {
          console.log(`--- ${s.seed} ${s.kind}\n   ${s.violations.join("\n   ")}`);
        }
        console.log(
          `[stress-pg] replay: STRESS_PG_SEEDS=${failed.join(",")} XC_PG_URL=… deno test -A --no-check --config deno.json stress_route_post_v1_sessions_pg.test.ts`,
        );
      }
      assertEquals(failed, [], `failed seeds: ${failed.join(",")}`);
      assert(scenarios.length === seeds.length);
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
});

Deno.test({
  name: "stress POST /v1/sessions — real Postgres: authenticated grants cover the handler's INSERT/SELECT and UPDATE is exactly ended_at",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      const cols = await sql.unsafe(
        `select privilege_type, column_name from information_schema.column_privileges
          where grantee = 'authenticated' and table_schema = 'public' and table_name = 'sessions'
          order by privilege_type, column_name`,
      );
      const byPriv: Record<string, string[]> = {};
      for (const r of cols) (byPriv[r.privilege_type] ??= []).push(r.column_name);
      // The handler's INSERT payload must be insertable…
      for (const c of ["id", "user_id", "started_at"])
        assert(byPriv.INSERT?.includes(c), `INSERT grant lacks ${c}`);
      // …the owner lookup must be selectable…
      for (const c of ["id", "user_id"])
        assert(byPriv.SELECT?.includes(c), `SELECT grant lacks ${c}`);
      // …and the defense-in-depth column UPDATE grant is exactly ended_at
      // (AGENTS.md: "sessions move only ended_at").
      assertEquals(byPriv.UPDATE ?? [], ["ended_at"]);
      await Deno.mkdir(OUT_DIR, { recursive: true });
      await Deno.writeTextFile(
        `${OUT_DIR}/pg_sessions_grants.json`,
        JSON.stringify(byPriv, null, 1),
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
});
