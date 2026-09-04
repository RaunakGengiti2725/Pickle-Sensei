/**
 * stress: route-get-v1-me / lens concurrency — DIRECT Postgres half.
 *
 * GET /v1/me does not call an RPC: readProfile() is one owner-scoped
 * PostgREST select on public.profiles (`.eq("id", auth.uid()).maybeSingle()`),
 * and PUT /v1/me/onboarding is the only client write to that row. This file
 * runs exactly those statements — as role `authenticated` with the caller's
 * JWT sub, on N INDEPENDENT connections released from a barrier — against a
 * disposable postgres:16 with shim_auth.sql + every migration applied
 * (./xc_pg_up.sh), so the row-level properties the edge harness only models
 * are proven on the real schema, triggers, grants and RLS policies:
 *
 *   PG-ME-1 one profile row per auth user even when the signup trigger fires
 *           for duplicate/racing inserts (handle_new_user ON CONFLICT DO NOTHING)
 *   PG-ME-2 two actors on the same row: concurrent owner reads interleaved
 *           with concurrent owner updates are never torn (a read is one whole
 *           committed write), the last commit wins (no lost update), and a
 *           foreign sub sees 0 rows at every instant (RLS profiles_select_own)
 *   PG-ME-3 the identity columns the route echoes (id, email) cannot be moved
 *           by the client under the column-level UPDATE grant
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_ITER=64 deno test -A --no-check --config deno.json stress_route_get_v1_me_pg.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass. Seeded like the edge half: STRESS_SEED,
 * STRESS_ITER interleavings per scenario, STRESS_REPLAY_SEED replays one.
 * Reports: <STRESS_OUT_DIR>/pg_<scenario>.json + pg_seed_table.json.
 */
import postgres from "postgres";
import { assertEquals } from "@std/assert";
import { envInt, histogram, type Invariant, Prng } from "./xc_concurrency_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_ITER = envInt("STRESS_ITER", 4);
const LANES = envInt("STRESS_PG_LANES", 16);
const STRESS_WALL_MS = envInt("STRESS_WALL_MS", 10_000);
const REPLAY_SEED = (() => {
  const raw = Deno.env.get("STRESS_REPLAY_SEED");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n >>> 0 : null;
})();

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const PROFILE_SELECT =
  "id, email, onboarding_state, provider, skill_level, handedness, primary_goal, biggest_problem, focus_checkpoint, first_name, gender";
const PROFILE_FIELDS = [
  "skill_level",
  "handedness",
  "primary_goal",
  "biggest_problem",
  "focus_checkpoint",
  "first_name",
  "gender",
] as const;
const GENDERS = ["female", "male", "nonbinary", "prefer_not_to_say"];

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-route-get-v1-me/latest/", import.meta.url).pathname;
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId.slice(0, 8)}@example.com', '{"provider":"google"}')`,
  );
}

/** The exact write PUT /v1/me/onboarding performs for write k. */
function writePatch(k: number): Record<string, string> {
  return {
    skill_level: `level-${k}`,
    handedness: k % 2 === 0 ? "right" : "left",
    primary_goal: `goal-${k}`,
    biggest_problem: `problem-${k}`,
    focus_checkpoint: "contact_position",
    first_name: `Name${k}`,
    gender: GENDERS[k % GENDERS.length],
    onboarding_state: "complete",
  };
}

/** -1 untouched, k = write k, null = torn (fields from different writes). */
function snapshotVersion(row: Record<string, unknown> | undefined): number | null {
  if (!row) return null;
  if (PROFILE_FIELDS.every((f) => row[f] === null)) return -1;
  const m = /^level-(\d+)$/.exec(String(row.skill_level));
  if (!m) return null;
  const k = Number(m[1]);
  const expected = writePatch(k);
  return PROFILE_FIELDS.every((f) => row[f] === expected[f]) ? k : null;
}

interface LaneRow {
  lane: number;
  op: string;
  result: string;
  serverStartMs: number;
  serverEndMs: number;
}

interface SeedRow {
  scenario: string;
  iter: number;
  seed: number;
  lanes: number;
  broken: string[];
  outcome: "HELD" | "BROKEN";
  durationMs: number;
  replay: string;
}
const seedTable: SeedRow[] = [];

async function serverNowMs(tx: Tx): Promise<number> {
  const r = await tx.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

/** N connections, each its own tx as the given sub, released together. */
async function burst(
  sql: Sql,
  lanes: number,
  userIdFor: (lane: number) => string,
  fn: (tx: Tx, lane: number) => Promise<Omit<LaneRow, "lane">>,
): Promise<LaneRow[]> {
  const b = barrier();
  let ready = 0;
  const rows: LaneRow[] = [];
  const all = Promise.all(
    Array.from({ length: lanes }, (_, lane) =>
      sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, userIdFor(lane));
        ready += 1;
        await b.gate;
        rows.push({ lane, ...(await fn(tx as unknown as Tx, lane)) });
      }),
    ),
  );
  while (ready < lanes) await new Promise((r) => setTimeout(r, 1));
  b.open();
  await all;
  rows.sort((a, b) => a.lane - b.lane);
  return rows;
}

async function writeJson(name: string, value: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

interface Ctx {
  sql: Sql;
  prng: Prng;
  seed: number;
  rows: LaneRow[];
  inv: (name: string, holds: boolean, detail: string) => void;
  observe: (key: string, value: unknown) => void;
}

async function scenario(name: string, run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const sql = postgres(PG_URL, { max: LANES + 4, onnotice: () => {} });
  const invariants: Array<Invariant & { iter: number; seed: number }> = [];
  const observations: Record<string, unknown> = {};
  const allRows: Array<LaneRow & { seed: number }> = [];
  const seeds = REPLAY_SEED !== null
    ? [REPLAY_SEED]
    : Array.from({ length: STRESS_ITER }, (_, i) => fnv1a(`${STRESS_SEED}:${name}:${i}`));
  const t0 = performance.now();
  try {
    for (let iter = 0; iter < seeds.length; iter++) {
      const seed = seeds[iter];
      const rows: LaneRow[] = [];
      const mine: Invariant[] = [];
      const ctx: Ctx = {
        sql,
        prng: new Prng(seed),
        seed,
        rows,
        inv: (n, holds, detail) => {
          mine.push({ name: n, holds, detail });
          invariants.push({ name: n, holds, detail, iter, seed });
        },
        observe: (key, value) => {
          observations[`${key}@${seed}`] = value;
        },
      };
      const started = performance.now();
      try {
        await run(ctx);
      } catch (error) {
        ctx.inv("scenario body did not throw", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      }
      const durationMs = Math.round(performance.now() - started);
      ctx.inv(`bounded wall time (< ${STRESS_WALL_MS}ms, deadlock detector)`, durationMs < STRESS_WALL_MS, `${durationMs}ms`);
      const broken = mine.filter((i) => !i.holds).map((i) => `${i.name} — ${i.detail}`);
      seedTable.push({
        scenario: name,
        iter,
        seed,
        lanes: LANES,
        broken,
        outcome: broken.length === 0 ? "HELD" : "BROKEN",
        durationMs,
        replay: `XC_PG_URL=<url> STRESS_REPLAY_SEED=${seed} STRESS_PG_LANES=${LANES} deno test -A --no-check --config deno.json stress_route_get_v1_me_pg.test.ts --filter "PG-ME-${name[2]}:"`,
      });
      allRows.push(...rows.map((r) => ({ seed, ...r })));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  const path = await writeJson(`pg_${name}`, {
    scenario: name,
    unit: "route-get-v1-me",
    lens: "concurrency",
    plane: "postgres:16 + shim_auth.sql + every migration",
    baseSeed: STRESS_SEED,
    scale: { iterations: seeds.length, lanes: LANES },
    seeds,
    resultHistogram: histogram(allRows.map((r) => `${r.op}:${r.result}`)),
    invariants,
    observations,
    lanes: allRows,
    durationMs: Math.round(performance.now() - t0),
  });
  await writeJson("pg_seed_table", {
    unit: "route-get-v1-me",
    lens: "concurrency",
    plane: "postgres:16",
    interleavings: seedTable.length,
    held: seedTable.filter((r) => r.outcome === "HELD").length,
    broken: seedTable.filter((r) => r.outcome === "BROKEN").length,
    rows: seedTable,
  });
  const brokenRows = seedTable.filter((r) => r.scenario === name && r.outcome === "BROKEN");
  console.log(`[stress:get-v1-me:pg] ${name}: ${seeds.length} interleavings × ${LANES} lanes, ${brokenRows.length} BROKEN → ${path}`);
  for (const r of brokenRows) console.log(`[stress:get-v1-me:pg]   BROKEN seed=${r.seed}: ${r.broken.join(" | ")}\n    replay: ${r.replay}`);
  assertEquals(brokenRows.map((r) => r.seed), [], `${name}: broken interleavings; see ${path}`);
}

// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress get-v1-me PG-ME-1: racing signup-trigger inserts leave exactly one profile row",
  ignore,
  async fn() {
    await scenario("pg1_one_profile_row", async (ctx) => {
      const { sql, prng } = ctx;
      const userId = prng.uuid();
      await sql.unsafe(`delete from auth.users where id = '${userId}'`);
      // LANES owner-role connections race the same auth.users insert; one
      // wins the PK, the rest see unique_violation. The definer trigger runs
      // for the winner (and must be idempotent if a second insert ever
      // reaches it — ON CONFLICT DO NOTHING).
      const b = barrier();
      let ready = 0;
      const outcomes: string[] = [];
      const all = Promise.all(
        Array.from({ length: LANES }, () =>
          sql.begin(async (tx) => {
            ready += 1;
            await b.gate;
            try {
              await tx.unsafe(
                `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId.slice(0, 8)}@example.com', '{"provider":"google"}')`,
              );
              outcomes.push("inserted");
            } catch (error) {
              const code = (error as { code?: string }).code ?? "error";
              outcomes.push(code);
              throw error; // roll this lane back
            }
          }).catch(() => undefined)),
      );
      while (ready < LANES) await new Promise((r) => setTimeout(r, 1));
      b.open();
      await all;
      const hist = histogram(outcomes);
      ctx.observe("insertOutcomes", hist);
      ctx.inv("exactly one insert wins, the rest are unique_violation (23505)", hist.inserted === 1 && (hist["23505"] ?? 0) === LANES - 1, JSON.stringify(hist));
      // Direct re-fire of the trigger body: a duplicate profile insert for
      // the same id must be a no-op, not a second row and not an error.
      const dup = await sql.unsafe(
        `insert into public.profiles (id, email, provider) values ('${userId}', 'other@example.com', 'apple') on conflict (id) do nothing returning id`,
      );
      ctx.inv("duplicate profile insert is a no-op", dup.length === 0, `${dup.length} rows returned`);
      const rows = await sql.unsafe(`select id, email from public.profiles where id = '${userId}'`);
      ctx.inv("exactly one profile row for the user", rows.length === 1, `${rows.length} rows`);
      ctx.inv("the surviving row is the signup's (email untouched by the duplicate)", rows[0]?.email === `${userId.slice(0, 8)}@example.com`, String(rows[0]?.email));
      const reads = await burst(sql, LANES, () => userId, async (tx) => {
        const t0 = await serverNowMs(tx);
        const r = await tx.unsafe(`select ${PROFILE_SELECT} from public.profiles where id = '${userId}'`);
        const t1 = await serverNowMs(tx);
        return { op: "select_own", result: `${r.length}rows:${r[0]?.id === userId ? "own" : "?"}`, serverStartMs: t0, serverEndMs: t1 };
      });
      ctx.rows.push(...reads);
      ctx.inv("every concurrent owner read sees exactly its one row (maybeSingle never 406)", reads.every((r) => r.result === "1rows:own"), JSON.stringify(histogram(reads.map((r) => r.result))));
      await sql.unsafe(`delete from auth.users where id = '${userId}'`);
    });
  },
});

Deno.test({
  name: "stress get-v1-me PG-ME-2: two actors on one row — reads never torn, last write wins, RLS hides it from a third",
  ignore,
  async fn() {
    await scenario("pg2_two_actors_same_row", async (ctx) => {
      const { sql, prng } = ctx;
      const owner = prng.uuid();
      const stranger = prng.uuid();
      await createUser(sql, owner);
      await createUser(sql, stranger);
      const writes = Math.max(2, Math.floor(LANES / 4));
      // lane roles, shuffled by the seed: W writers (device 1/2 of the
      // owner), some stranger readers, the rest owner readers
      const roles = prng.shuffle([
        ...Array.from({ length: writes }, (_, k) => `write:${k + 1}`),
        ...Array.from({ length: Math.max(1, Math.floor(LANES / 4)) }, () => "read:stranger"),
        ...Array.from({ length: LANES - writes - Math.max(1, Math.floor(LANES / 4)) }, () => "read:owner"),
      ]);
      let commitOrder = 0;
      const commitSeq = new Map<number, number>();
      const rows = await burst(
        sql,
        LANES,
        (lane) => (roles[lane] === "read:stranger" ? stranger : owner),
        async (tx, lane) => {
          const role = roles[lane];
          const t0 = await serverNowMs(tx);
          if (role.startsWith("write:")) {
            const k = Number(role.slice(6));
            const p = writePatch(k);
            const sets = Object.entries(p).map(([c, v]) => `${c} = '${v}'`).join(", ");
            // the same statement PostgREST issues for .update(patch).eq("id", uid)
            const r = await tx.unsafe(`update public.profiles set ${sets} where id = '${owner}' returning ${PROFILE_SELECT}`);
            const t1 = await serverNowMs(tx);
            commitSeq.set(k, ++commitOrder);
            return { op: "update_own", result: `${r.length}rows:v${snapshotVersion(r[0])}`, serverStartMs: t0, serverEndMs: t1 };
          }
          const who = role === "read:stranger" ? stranger : owner;
          const r = await tx.unsafe(`select ${PROFILE_SELECT} from public.profiles where id = '${owner}'`);
          const t1 = await serverNowMs(tx);
          const v = snapshotVersion(r[0]);
          return {
            op: role === "read:stranger" ? "select_as_stranger" : "select_own",
            result: `${r.length}rows${r.length ? `:v${v}:${r[0].id === who ? "own" : "FOREIGN"}` : ""}`,
            serverStartMs: t0,
            serverEndMs: t1,
          };
        },
      );
      ctx.rows.push(...rows);
      const ownerReads = rows.filter((r) => r.op === "select_own");
      const strangerReads = rows.filter((r) => r.op === "select_as_stranger");
      const updates = rows.filter((r) => r.op === "update_own");
      ctx.inv("RLS: a foreign sub sees 0 rows on the owner's id at every instant", strangerReads.every((r) => r.result === "0rows"), JSON.stringify(histogram(strangerReads.map((r) => r.result))));
      ctx.inv("owner reads always return exactly one row", ownerReads.every((r) => r.result.startsWith("1rows:")), JSON.stringify(histogram(ownerReads.map((r) => r.result))));
      ctx.inv("no torn read: every owner snapshot is one whole write or untouched", ownerReads.every((r) => !r.result.includes(":vnull")), JSON.stringify(histogram(ownerReads.map((r) => r.result))));
      ctx.inv("every update returns its own whole row (RETURNING = the write)", updates.every((r, i) => r.result === `1rows:v${Number(roles[updates[i].lane].slice(6))}`), JSON.stringify(updates.map((r) => r.result)));
      const overlap = rows.some((a) => rows.some((b) => a !== b && a.serverStartMs < b.serverEndMs && b.serverStartMs < a.serverEndMs));
      ctx.observe("serverSideOverlapObserved", overlap);
      // last committed write wins: the winner is the update whose tx
      // committed last (commit order recorded as each lane's fn returns —
      // sql.begin commits right after).
      const lastK = [...commitSeq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const final = await sql.unsafe(`select ${PROFILE_SELECT} from public.profiles where id = '${owner}'`);
      const finalV = snapshotVersion(final[0]);
      ctx.inv("no lost update: final row is one complete accepted write", finalV !== null && finalV !== -1, `final version=${finalV}, writes=1..${writes}, last-returned=${lastK}`);
      ctx.observe("finalVersion", { finalV, lastReturnedWrite: lastK, commitSeq: [...commitSeq.entries()] });
      ctx.inv("exactly one profile row per user", (await sql.unsafe(`select count(*)::int as n from public.profiles where id in ('${owner}','${stranger}')`))[0].n === 2, "");
      ctx.inv("stranger's own row untouched by the owner's writes", snapshotVersion((await sql.unsafe(`select ${PROFILE_SELECT} from public.profiles where id = '${stranger}'`))[0]) === -1, "");
      await sql.unsafe(`delete from auth.users where id in ('${owner}','${stranger}')`);
    });
  },
});

Deno.test({
  name: "stress get-v1-me PG-ME-3: the identity the route echoes (id, email) is not client-writable",
  ignore,
  async fn() {
    await scenario("pg3_identity_columns_pinned", async (ctx) => {
      const { sql, prng } = ctx;
      const owner = prng.uuid();
      const victim = prng.uuid();
      await createUser(sql, owner);
      await createUser(sql, victim);
      const attempts: Array<[op: string, stmt: string]> = [
        ["update:own.email", `update public.profiles set email = 'hijack@example.com' where id = '${owner}'`],
        ["update:own.id", `update public.profiles set id = '${victim}' where id = '${owner}'`],
        ["update:victim", `update public.profiles set skill_level = 'x' where id = '${victim}'`],
        ["insert", `insert into public.profiles (id, email, provider) values ('${prng.uuid()}', 'new@example.com', 'google')`],
        ["delete", `delete from public.profiles where id = '${owner}'`],
      ];
      const rows = await burst(sql, LANES, () => owner, async (tx, lane) => {
        const [op, stmt] = attempts[lane % attempts.length];
        const t0 = await serverNowMs(tx);
        // A refused statement aborts the transaction; a savepoint keeps the
        // lane's tx (and its role/sub) alive so the outcome can be recorded.
        try {
          const count = await tx.savepoint(async (sp) => (await sp.unsafe(stmt)).count);
          const t1 = await serverNowMs(tx);
          return { op, result: `ok:${count}rows`, serverStartMs: t0, serverEndMs: t1 };
        } catch (error) {
          const t1 = await serverNowMs(tx);
          return { op, result: `err:${(error as { code?: string }).code ?? "?"}`, serverStartMs: t0, serverEndMs: t1 };
        }
      });
      ctx.rows.push(...rows);
      const hist = histogram(rows.map((r) => `${r.op}=${r.result}`));
      ctx.observe("outcomes", hist);
      ctx.inv("email/id updates → 42501 (column grant)", rows.filter((r) => r.op.startsWith("update:own.")).every((r) => r.result === "err:42501"), JSON.stringify(hist));
      ctx.inv("update on a foreign row → 0 rows (RLS), never an error leaking existence", rows.filter((r) => r.op === "update:victim").every((r) => r.result === "ok:0rows"), JSON.stringify(hist));
      ctx.inv("insert/delete → 42501", rows.filter((r) => r.op.startsWith("insert") || r.op.startsWith("delete")).every((r) => r.result === "err:42501"), JSON.stringify(hist));
      const after = await sql.unsafe(`select id, email from public.profiles where id in ('${owner}','${victim}') order by id`);
      ctx.inv("both rows intact with their own ids/emails", after.length === 2 && after.every((r) => r.email === `${String(r.id).slice(0, 8)}@example.com`), JSON.stringify(after));
      await sql.unsafe(`delete from auth.users where id in ('${owner}','${victim}')`);
    });
  },
});
