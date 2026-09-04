// stress-edge-authenticate-concurrency — REAL Postgres half.
//
// The in-process file (stress_edge_authenticate_concurrency.test.ts) proves
// what authenticate() + the permit route do over a MODELLED database. Where
// the route hits Postgres RPCs (`reserve_analysis_permit(text)`,
// `access_state()`), this file drives the real functions on a disposable
// postgres:16 with shim_auth.sql + every migration applied (./xc_pg_up.sh),
// from N INDEPENDENT connections, each in its own transaction as role
// `authenticated` with the caller's JWT sub — i.e. exactly the principal the
// edge handler's authenticated PostgREST call carries — released from a
// barrier so the per-user advisory xact locks genuinely contend.
//
// "Two actors on one row" here = two (or three) SESSIONS of the same user
// (device1, device2, legacy provider-token bearer): they share auth.uid(),
// so their concurrent reservations race on the same permit rows / ledger.
// A second user with the SAME idempotency-key strings is the "two actors on
// one id" case: keys are per user and must never cross.
//
//   ./xc_pg_up.sh                       # prints XC_PG_URL
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     STRESS_PG_ITER=32 STRESS_OUT_DIR=/tmp/stress-pg/ \
//     deno test -A --no-check --config deno.json stress_pg_authenticate_two_actors.test.ts
//
// Without XC_PG_URL (aliases: PICKLE_AUDIT_PG_URL, STRESS_PG_URL) every test
// is `ignore`d — an ignored run is NOT a pass.
//
// Seeded: STRESS_SEED (+ scenario, iteration) drives every user id / key /
// lane plan; STRESS_REPLAY_SEED replays a single iteration.

import postgres from "postgres";
import { assert } from "@std/assert";
import { envInt, histogram, type Invariant, Prng } from "./xc_concurrency_harness.ts";

const PG_URL =
  Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ??
  Deno.env.get("STRESS_PG_URL") ??
  "";
const ignore = PG_URL === "";

const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_PG_ITER = envInt("STRESS_PG_ITER", 3);
const STRESS_PG_LANES = envInt("STRESS_PG_LANES", 12);
const STRESS_ITER_BUDGET_MS = envInt("STRESS_ITER_BUDGET_MS", 20_000);
const REPLAY_SEED = (() => {
  const raw = Deno.env.get("STRESS_REPLAY_SEED");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) >>> 0 : null;
})();

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function iterationSeed(scenario: string, iter: number): number {
  if (REPLAY_SEED !== null) return REPLAY_SEED;
  let x = (STRESS_SEED ^ fnv1a(scenario) ^ Math.imul(iter + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-edge-authenticate-concurrency/latest/",
    import.meta.url,
  ).pathname;
}

const SCENARIOS = [
  "stress_pg_A_three_sessions_one_user",
  "stress_pg_B_two_users_same_keys",
] as const;
type ScenarioName = (typeof SCENARIOS)[number];

function replayCommand(scenario: ScenarioName, seed: number): string {
  return `XC_PG_URL=<from ./xc_pg_up.sh> STRESS_REPLAY_SEED=${seed} STRESS_PG_LANES=${STRESS_PG_LANES} deno test -A --no-check --config deno.json stress_pg_authenticate_two_actors.test.ts --filter "${scenario}"`;
}

interface LaneRow {
  lane: number;
  actor: string;
  userId: string;
  key: string;
  result: string;
  permitId?: string;
  serverStartMs: number;
  serverEndMs: number;
  clientMs: number;
}

interface IterationResult {
  scenario: ScenarioName;
  iter: number;
  seed: number;
  outcome: "HELD" | "BROKEN";
  durationMs: number;
  lanes: number;
  lanesOverlappingAnotherLane: number;
  resultHistogram: Record<string, number>;
  invariants: Invariant[];
  observations: Record<string, unknown>;
  replay: string;
}

const results: IterationResult[] = [];

function inv(list: Invariant[], name: string, holds: boolean, detail: string): void {
  list.push({ name, holds, detail });
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

async function createUser(sql: Sql, userId: string, providerSub: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `delete from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('google', '${providerSub}')`,
  );
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', '${providerSub}', '${userId}', '{"sub":"${providerSub}"}')`,
  );
}

async function serverNowMs(tx: Tx): Promise<number> {
  const r = await tx.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

interface Plan {
  lane: number;
  actor: string;
  userId: string;
  key: string;
}

/** N independent connections, each: BEGIN, set role/sub, wait at the barrier,
 * reserve, COMMIT — so the lanes contend on the per-user advisory xact lock
 * and see each other's committed outcomes. */
async function burst(sql: Sql, plan: Plan[]): Promise<LaneRow[]> {
  const b = barrier();
  let ready = 0;
  const rows: LaneRow[] = [];
  const all = Promise.all(
    plan.map((p) =>
      sql.begin(async (raw) => {
        const tx = raw as unknown as Tx;
        await asUser(tx, p.userId);
        ready += 1;
        await b.gate;
        const c0 = performance.now();
        const t0 = await serverNowMs(tx);
        const r = await tx.unsafe(
          `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${p.key}') x`,
        );
        const t1 = await serverNowMs(tx);
        rows.push({
          lane: p.lane,
          actor: p.actor,
          userId: p.userId,
          key: p.key,
          result: String(r[0].result),
          permitId: r[0].permit_id ? String(r[0].permit_id) : undefined,
          serverStartMs: t0,
          serverEndMs: t1,
          clientMs: Math.round((performance.now() - c0) * 100) / 100,
        });
      }),
    ),
  );
  while (ready < plan.length) await new Promise((r) => setTimeout(r, 1));
  b.open();
  await all;
  rows.sort((a, b) => a.lane - b.lane);
  return rows;
}

function overlapCount(rows: LaneRow[]): number {
  let n = 0;
  for (const a of rows) {
    if (
      rows.some(
        (b) => b !== a && a.serverStartMs < b.serverEndMs && b.serverStartMs < a.serverEndMs,
      )
    )
      n++;
  }
  return n;
}

async function permitRows(sql: Sql, userId: string) {
  const r = await sql.unsafe(
    `select id::text as id, idempotency_key, status from public.analysis_permits where user_id = '${userId}' order by created_at`,
  );
  return r.map((p) => ({
    id: String(p.id),
    key: String(p.idempotency_key),
    status: String(p.status),
  }));
}

async function accessState(sql: Sql, userId: string) {
  let out = { premium: false, scored_count: -1, reserved_count: -1 };
  await sql.begin(async (raw) => {
    const tx = raw as unknown as Tx;
    await asUser(tx, userId);
    const r = await tx.unsafe(
      `select premium, scored_count, reserved_count from public.access_state()`,
    );
    out = {
      premium: Boolean(r[0].premium),
      scored_count: Number(r[0].scored_count),
      reserved_count: Number(r[0].reserved_count),
    };
  });
  return out;
}

async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`stress-pg: ${label} did not settle within ${STRESS_ITER_BUDGET_MS}ms`)),
      STRESS_ITER_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runScenario(
  scenario: ScenarioName,
  body: (
    sql: Sql,
    prng: Prng,
    seed: number,
    invariants: Invariant[],
    observations: Record<string, unknown>,
  ) => Promise<LaneRow[]>,
): Promise<IterationResult[]> {
  const sql = postgres(PG_URL, { max: STRESS_PG_LANES * 2 + 4 });
  const out: IterationResult[] = [];
  try {
    const iterations = REPLAY_SEED !== null ? 1 : STRESS_PG_ITER;
    for (let iter = 0; iter < iterations; iter++) {
      const seed = iterationSeed(scenario, iter);
      const prng = new Prng(seed);
      const invariants: Invariant[] = [];
      const observations: Record<string, unknown> = {};
      const t0 = performance.now();
      let rows: LaneRow[] = [];
      let hang: string | null = null;
      try {
        rows = await bounded(
          body(sql, prng, seed, invariants, observations),
          `${scenario}#${iter} seed=${seed}`,
        );
      } catch (error) {
        hang = error instanceof Error ? error.message : String(error);
      }
      const durationMs = Math.round(performance.now() - t0);
      inv(
        invariants,
        `bounded wall time (no deadlock): iteration settled within ${STRESS_ITER_BUDGET_MS}ms`,
        hang === null,
        hang ?? `${durationMs}ms`,
      );
      const result: IterationResult = {
        scenario,
        iter,
        seed,
        outcome: invariants.every((i) => i.holds) ? "HELD" : "BROKEN",
        durationMs,
        lanes: rows.length,
        lanesOverlappingAnotherLane: overlapCount(rows),
        resultHistogram: histogram(rows.map((r) => `${r.actor}:${r.result}`)),
        invariants,
        observations,
        replay: replayCommand(scenario, seed),
      };
      out.push(result);
      results.push(result);
      if (result.outcome === "BROKEN" || REPLAY_SEED !== null) {
        const dir = outDir();
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(
          `${dir}${scenario}.seed-${seed}.json`,
          JSON.stringify({ ...result, requests: rows }, null, 2),
        );
      }
    }
  } finally {
    await sql.end();
  }
  const broken = out.filter((r) => r.outcome === "BROKEN");
  console.log(
    `[stress-pg] ${scenario}: ${out.length} iterations, ${out.reduce((n, r) => n + r.lanes, 0)} lanes, ${out.reduce(
      (n, r) => n + r.lanesOverlappingAnotherLane,
      0,
    )} overlapping, ${broken.length} BROKEN`,
  );
  for (const r of broken) {
    for (const i of r.invariants.filter((i) => !i.holds)) {
      console.log(`[stress-pg]   BROKEN seed=${r.seed} ${i.name} — ${i.detail}`);
    }
    console.log(`[stress-pg]   replay: ${r.replay}`);
  }
  assert(
    broken.length === 0,
    broken
      .map(
        (r) =>
          `seed=${r.seed}: ${r.invariants
            .filter((i) => !i.holds)
            .map((i) => `${i.name} (${i.detail})`)
            .join("; ")}\n  replay: ${r.replay}`,
      )
      .join("\n"),
  );
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// PG-A — three sessions of ONE user (device1, device2, legacy provider-token
// bearer → same auth.uid()) reserve at once: shared key across actors → one
// permit id; ≤ 2 live reservations total; one row per key; access_state()
// agrees; lanes genuinely overlapped on the server.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: SCENARIOS[0],
  ignore,
  async fn() {
    await runScenario(SCENARIOS[0], async (sql, prng, seed, invariants, observations) => {
      const userId = prng.uuid();
      await createUser(sql, userId, `google-${seed}-${prng.uuid()}`);
      const actors = ["device1", "device2", "legacy_provider_bearer"];
      const sharedKey = `shared-${seed}-${prng.uuid()}`;
      const sharedLanes = Math.max(3, Math.floor(STRESS_PG_LANES / 3));
      const plan: Plan[] = prng
        .shuffle(
          Array.from({ length: STRESS_PG_LANES }, (_, i) => ({
            actor: actors[prng.int(0, 2)],
            key: i < sharedLanes ? sharedKey : `k-${i}-${prng.uuid()}`,
          })),
        )
        .map((p, lane) => ({ ...p, lane, userId }));
      const rows = await burst(sql, plan);
      const shared = rows.filter((r) => r.key === sharedKey);
      const sharedIds = new Set(
        shared.filter((r) => r.result === "accepted").map((r) => r.permitId),
      );
      const accepted = rows.filter((r) => r.result === "accepted");
      const acceptedIds = new Set(accepted.map((r) => r.permitId));
      const paywalled = rows.filter((r) => r.result === "access.paywall_required");
      const permits = await permitRows(sql, userId);
      const reserved = permits.filter((p) => p.status === "reserved");
      const access = await accessState(sql, userId);
      inv(
        invariants,
        `shared key from ${new Set(shared.map((r) => r.actor)).size} actor(s) × ${shared.length} lanes → one permit id (or all paywalled)`,
        sharedIds.size <= 1 &&
          shared.every((r) => r.result === "accepted" || r.result === "access.paywall_required"),
        `ids=${sharedIds.size} ${JSON.stringify(histogram(shared.map((r) => r.result)))}`,
      );
      inv(
        invariants,
        "≤ 2 live reservations across all sessions of the user (no double spend); every other lane access.paywall_required",
        reserved.length <= 2 &&
          acceptedIds.size <= 2 &&
          accepted.length + paywalled.length === rows.length,
        `reserved_rows=${reserved.length} accepted_ids=${acceptedIds.size} accepted=${accepted.length} paywalled=${paywalled.length} other=${
          rows.length - accepted.length - paywalled.length
        }`,
      );
      inv(
        invariants,
        "one row per distinct accepted permit id and per idempotency key (no duplicate rows)",
        permits.length === acceptedIds.size &&
          new Set(permits.map((p) => p.key)).size === permits.length,
        `rows=${permits.length} ids=${acceptedIds.size} keys=${new Set(permits.map((p) => p.key)).size}`,
      );
      inv(
        invariants,
        "access_state().reserved_count equals the live reservation rows (no lost update)",
        access.reserved_count === reserved.length &&
          access.scored_count === 0 &&
          access.premium === false,
        JSON.stringify(access),
      );
      inv(
        invariants,
        "lanes genuinely overlapped on the server (advisory lock contention, not a sequential run)",
        rows.length < 2 || overlapCount(rows) >= 2,
        `overlapping=${overlapCount(rows)}/${rows.length}`,
      );
      observations.plan = histogram(
        plan.map((p) => `${p.actor}:${p.key === sharedKey ? "shared" : "distinct"}`),
      );
      observations.reserved = reserved.length;
      observations.maxServerMs = Math.max(...rows.map((r) => r.serverEndMs - r.serverStartMs));
      return rows;
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PG-B — two users, the SAME idempotency-key strings, concurrently: keys are
// per user (never cross), each user independently ≤ 2 live reservations,
// each shared key resolves to one permit id PER USER, no duplicate rows.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: SCENARIOS[1],
  ignore,
  async fn() {
    await runScenario(SCENARIOS[1], async (sql, prng, seed, invariants, observations) => {
      const userA = prng.uuid();
      const userB = prng.uuid();
      await createUser(sql, userA, `google-${seed}-A-${prng.uuid()}`);
      await createUser(sql, userB, `google-${seed}-B-${prng.uuid()}`);
      const perUser = Math.max(4, Math.floor(STRESS_PG_LANES / 2));
      const keys = Array.from({ length: perUser }, (_, i) =>
        i < 2 ? `shared-${seed}` : `k-${i}-${seed}-${prng.uuid()}`,
      );
      const plan: Plan[] = prng
        .shuffle([
          ...keys.map((key) => ({ actor: "userA", userId: userA, key })),
          ...keys.map((key) => ({ actor: "userB", userId: userB, key })),
        ])
        .map((p, lane) => ({ ...p, lane }));
      const rows = await burst(sql, plan);
      const [permitsA, permitsB] = await Promise.all([
        permitRows(sql, userA),
        permitRows(sql, userB),
      ]);
      const idsA = new Set(permitsA.map((p) => p.id));
      const idsB = new Set(permitsB.map((p) => p.id));
      const cross = [...idsA].filter((id) => idsB.has(id)).length;
      const acceptedA = rows.filter((r) => r.actor === "userA" && r.result === "accepted");
      const acceptedB = rows.filter((r) => r.actor === "userB" && r.result === "accepted");
      const sharedA = new Set(
        acceptedA.filter((r) => r.key === `shared-${seed}`).map((r) => r.permitId),
      );
      const sharedB = new Set(
        acceptedB.filter((r) => r.key === `shared-${seed}`).map((r) => r.permitId),
      );
      inv(
        invariants,
        "the same key string used by two users never resolves to the same permit (keys are per user; no cross-user rows)",
        cross === 0 &&
          permitsA.every((p) => !idsB.has(p.id)) &&
          rows.every(
            (r) =>
              !r.permitId || (r.actor === "userA" ? idsA.has(r.permitId) : idsB.has(r.permitId)),
          ),
        `cross_ids=${cross} rowsA=${permitsA.length} rowsB=${permitsB.length}`,
      );
      inv(
        invariants,
        "each user independently: ≤ 2 live reservations, rest access.paywall_required",
        permitsA.filter((p) => p.status === "reserved").length <= 2 &&
          permitsB.filter((p) => p.status === "reserved").length <= 2 &&
          rows.every((r) => r.result === "accepted" || r.result === "access.paywall_required"),
        `${JSON.stringify(histogram(rows.map((r) => `${r.actor}:${r.result}`)))} reservedA=${
          permitsA.filter((p) => p.status === "reserved").length
        } reservedB=${permitsB.filter((p) => p.status === "reserved").length}`,
      );
      inv(
        invariants,
        "shared key → one permit id per user; one row per key per user",
        sharedA.size <= 1 &&
          sharedB.size <= 1 &&
          new Set(permitsA.map((p) => p.key)).size === permitsA.length &&
          new Set(permitsB.map((p) => p.key)).size === permitsB.length,
        `sharedA=${sharedA.size} sharedB=${sharedB.size}`,
      );
      inv(
        invariants,
        "lanes genuinely overlapped on the server",
        overlapCount(rows) >= 2,
        `overlapping=${overlapCount(rows)}/${rows.length}`,
      );
      observations.perUser = perUser;
      observations.rowsA = permitsA.length;
      observations.rowsB = permitsB.length;
      return rows;
    });
  },
});

Deno.test({
  name: "stress-pg: write results-pg.json (seed → outcome table)",
  ignore,
  async fn() {
    const dir = outDir();
    await Deno.mkdir(dir, { recursive: true });
    const table = {
      generatedAt: new Date().toISOString(),
      scale: { STRESS_SEED, STRESS_PG_ITER, STRESS_PG_LANES, replaySeed: REPLAY_SEED },
      totals: {
        iterations: results.length,
        lanes: results.reduce((n, r) => n + r.lanes, 0),
        overlapping: results.reduce((n, r) => n + r.lanesOverlappingAnotherLane, 0),
        held: results.filter((r) => r.outcome === "HELD").length,
        broken: results.filter((r) => r.outcome === "BROKEN").length,
        wallMs: results.reduce((n, r) => n + r.durationMs, 0),
      },
      results,
    };
    const path = `${dir}results-pg.json`;
    await Deno.writeTextFile(path, JSON.stringify(table, null, 2));
    console.log(
      `[stress-pg] results: ${table.totals.iterations} iterations / ${table.totals.lanes} lanes / ${table.totals.held} HELD / ${table.totals.broken} BROKEN → ${path}`,
    );
    assert(results.length > 0, "stress-pg: no iterations ran");
  },
});
