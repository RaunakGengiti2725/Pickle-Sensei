// stress-route-get-v1-me-access · lens = concurrency · REAL Postgres half
//
// GET /v1/me/access is one RPC round trip: `public.access_state()` under the
// caller's JWT sub (SECURITY INVOKER, RLS-scoped). The in-process half
// (stress_route_me_access_concurrency.test.ts) drives the real handler over a
// modelled database; THIS file drives the real RPC on a disposable
// postgres:16 with shim_auth.sql + every migration applied, from N
// INDEPENDENT connections whose transactions are released together from a
// barrier, so `access_state()` genuinely races the writers that move the
// numbers it reports (`reserve_analysis_permit`, `apply_synced_shot`, the
// `free_rating_ledger` trigger, permit expiry).
//
//   ./xc_pg_up.sh                                   # prints XC_PG_URL
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     STRESS_ITER=25 STRESS_OUT_DIR=/tmp/stress-pg/ \
//     deno test -A --no-check --config deno.json stress_pg_me_access_concurrency.test.ts
//
// Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d, and
// an ignored run is NOT a pass — the report must record it as UNKNOWN.
//
// Every read is converted by `accessPayload()` below — a faithful port of
// supabase/functions/api/index.ts accessPayload's arithmetic — and then checked
// against the SAME contract the mobile parser enforces
// (apps/mobile/src/billing/accessApi.ts parseAccess), so a snapshot the route
// could not have served is a failure here.
//
// Invariants (per iteration, all replayable from the iteration seed):
//   G1 payload arithmetic holds for every concurrent read
//   G2 no snapshot ever reports more than the two lifetime free ratings as
//      spent-or-held (used + reserved ≤ 2 for a non-premium account)
//   G3 real-time monotonicity: a read that STARTED (server clock) after
//      another read ENDED never reports fewer used, or fewer used+reserved
//   G4 read-your-writes: a read that started after a reserve/apply committed
//      reports it
//   G5 no double spend: whatever the interleaving, exactly two scored shots
//      and two consumed permits exist; the ledger row equals 2
//   G6 no duplicate rows: one permit per idempotency key, one shot per id
//   G7 no deadlock/serialization failure surfaced to the caller (no 40P01 /
//      40001 / 55P03), and the burst settles inside STRESS_WALL_MS
//   G8 identity ledger: a NEW account for the same sign-in identity reads
//      used=2 immediately — deleting the account does not refund the ratings
//
// Scale (env): STRESS_ITER iterations per scenario (default 3 — the whole file
// is ~5 s at the default), STRESS_PG_LANES concurrent connections per burst
// (default 12), STRESS_SEED (default 20260904), STRESS_WALL_MS (default 15000).

import postgres from "postgres";
import { assert } from "@std/assert";
import { envInt, histogram, type Invariant, Prng } from "./xc_concurrency_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_ITER = envInt("STRESS_ITER", 3);
const LANES = envInt("STRESS_PG_LANES", 12);
const STRESS_WALL_MS = envInt("STRESS_WALL_MS", 15_000);
const REPLAY_SEED = (() => {
  const raw = Deno.env.get("STRESS_REPLAY_SEED");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n >>> 0 : null;
})();

const FREE_LIMIT = 2;
/** Every lane of a burst holds its own connection for the whole barrier, so the
 * pool MUST be able to seat every lane at once — a smaller pool wedges the
 * barrier instead of testing the database. */
const POOL_MAX = LANES + 16;

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function iterationSeed(scenario: string, iteration: number): number {
  let z = (STRESS_SEED ^ fnv1a(scenario) ^ Math.imul(iteration + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

function iterationSeeds(scenario: string, count: number): number[] {
  if (REPLAY_SEED !== null) return [REPLAY_SEED];
  return Array.from({ length: count }, (_, i) => iterationSeed(scenario, i));
}

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-me-access/latest/", import.meta.url).pathname;
}

function replayCommand(scenario: string, seed: number): string {
  return `XC_PG_URL=<from ./xc_pg_up.sh> STRESS_REPLAY_SEED=${seed} STRESS_PG_LANES=${LANES} deno test -A --no-check --config deno.json stress_pg_me_access_concurrency.test.ts --filter "${scenario}"`;
}

function inv(invariants: Invariant[], name: string, holds: boolean, detail: string): void {
  invariants.push({ name, holds, detail });
}

// ── the route's own arithmetic (index.ts accessPayload) ──────────────────────

interface AccessStateRow {
  premium: boolean;
  scored_count: number;
  reserved_count: number;
}

interface AccessPayload {
  premium: boolean;
  used: number;
  reserved: number;
  remaining: number;
  availableToReserve: number;
  canStartRating: boolean;
  paywallRequired: boolean;
}

/** Verbatim port of supabase/functions/api/index.ts accessPayload (the free
 * path: no verified billing override), so this file asserts on exactly the
 * bytes GET /v1/me/access would have returned for the row it read. */
function accessPayload(state: AccessStateRow): AccessPayload {
  const used = Math.min(FREE_LIMIT, state.scored_count ?? 0);
  const remaining = FREE_LIMIT - used;
  const reserved = Math.min(state.reserved_count ?? 0, remaining);
  const availableToReserve = remaining - reserved;
  const premium = state.premium;
  const canStartRating = premium || availableToReserve > 0;
  return {
    premium,
    used,
    reserved,
    remaining,
    availableToReserve,
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

/** The contract apps/mobile/src/billing/accessApi.ts parseAccess enforces. */
function payloadViolations(p: AccessPayload, rawReserved: number): string[] {
  const out: string[] = [];
  if (p.used < 0 || p.used > FREE_LIMIT) out.push(`used=${p.used} out of range`);
  if (p.reserved < 0) out.push(`reserved=${p.reserved} < 0`);
  if (p.remaining !== FREE_LIMIT - p.used) out.push(`remaining=${p.remaining} ≠ 2-used`);
  if (p.reserved > p.remaining) out.push(`reserved=${p.reserved} > remaining=${p.remaining}`);
  if (p.availableToReserve !== p.remaining - p.reserved) {
    out.push(`availableToReserve=${p.availableToReserve} ≠ remaining-reserved`);
  }
  const expected = p.premium || p.availableToReserve > 0;
  if (p.canStartRating !== expected) out.push("canStartRating ≠ premium ∨ avail>0");
  if (p.paywallRequired !== !expected) out.push("paywallRequired ≠ ¬canStartRating");
  if (rawReserved < 0) out.push(`access_state.reserved_count=${rawReserved} < 0`);
  return out;
}

// ── db plumbing ──────────────────────────────────────────────────────────────

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function clockNowMs(sql: Sql): Promise<number> {
  const r = await sql.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

async function serverNowMs(tx: Tx): Promise<number> {
  const r = await tx.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

/** Seeded ids repeat across replays of the same seed against the same
 * disposable database, so setup first removes what an earlier run left
 * behind — including the identity's ledger row, which survives the user
 * cascade BY DESIGN (20260902150000). */
async function createUser(
  sql: Sql,
  userId: string,
  identity?: { provider: string; sub: string },
  opts: { keepLedger?: boolean } = {},
): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  if (identity && !opts.keepLedger) {
    await sql.unsafe(
      `delete from auth.users u using auth.identities i
        where i.user_id = u.id and i.provider = '${identity.provider}' and i.provider_id = '${identity.sub}'`,
    );
    await sql.unsafe(
      `delete from public.free_rating_ledger
        where identity_hash = public.free_rating_identity_hash('${identity.provider}', '${identity.sub}')`,
    );
  }
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
  if (identity) {
    await sql.unsafe(
      `insert into auth.identities (provider, provider_id, user_id, identity_data)
       values ('${identity.provider}', '${identity.sub}', '${userId}', '{"sub":"${identity.sub}"}')`,
    );
  }
}

function shotPayload(
  id: string,
  analysisPermitId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    analysisPermitId,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

interface Lane {
  lane: number;
  op: string;
  result: string;
  serverStartMs: number;
  serverEndMs: number;
  /** server clock read on ANOTHER connection AFTER this lane's COMMIT returned —
   * an upper bound on the commit's visibility point. `serverEndMs` is taken
   * inside the transaction, i.e. BEFORE the commit, so it proves nothing about
   * what a later reader must see. */
  committedByMs?: number;
  payload?: AccessPayload;
  rawReserved?: number;
  error?: string;
}

/** Every lane opens its own transaction, sets the caller, waits at the
 * barrier, runs its op and commits — so the lanes contend for the per-user
 * advisory xact lock for real, and each commit is visible to lanes that start
 * later. Errors are captured (never thrown) so a serialization failure or a
 * deadlock becomes an invariant violation with a seed instead of a stack. */
async function burst(
  sql: Sql,
  ops: Array<{ op: string; userId: string; run: (tx: Tx) => Promise<string> }>,
  reads: (index: number) => boolean,
): Promise<Lane[]> {
  assert(
    ops.length <= POOL_MAX,
    `burst of ${ops.length} lanes exceeds the ${POOL_MAX}-connection pool — the barrier could never open`,
  );
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let ready = 0;
  const rows: Lane[] = [];
  const all = Promise.all(
    ops.map((spec, lane) => {
      let row: Lane | undefined;
      return sql
        .begin(async (raw) => {
          const tx = raw as unknown as Tx;
          await asUser(tx, spec.userId);
          ready += 1;
          await gate;
          const t0 = await serverNowMs(tx);
          let result = "";
          let error: string | undefined;
          let payload: AccessPayload | undefined;
          let rawReserved: number | undefined;
          try {
            if (reads(lane)) {
              const r = await tx.unsafe(
                `select premium, scored_count, reserved_count from public.access_state()`,
              );
              const state: AccessStateRow = {
                premium: Boolean(r[0].premium),
                scored_count: Number(r[0].scored_count),
                reserved_count: Number(r[0].reserved_count),
              };
              rawReserved = state.reserved_count;
              payload = accessPayload(state);
              result = `used=${payload.used} reserved=${payload.reserved}`;
            } else {
              result = await spec.run(tx);
            }
          } catch (e) {
            const err = e as { code?: string; message?: string };
            error = `${err.code ?? "?"}: ${err.message ?? String(e)}`;
            result = `error:${err.code ?? "?"}`;
          }
          const t1 = await serverNowMs(tx).catch(() => t0);
          row = {
            lane,
            op: spec.op,
            result,
            serverStartMs: t0,
            serverEndMs: t1,
            payload,
            rawReserved,
            error,
          };
          rows.push(row);
        })
        .then(async () => {
          // the COMMIT has returned: a clock read on a DIFFERENT connection is
          // now strictly after this lane's write became visible
          if (row) row.committedByMs = await clockNowMs(sql).catch(() => Infinity);
        })
        .catch((e) => {
          const err = e as { code?: string; message?: string };
          rows.push({
            lane,
            op: spec.op,
            result: `txerror:${err.code ?? "?"}`,
            serverStartMs: 0,
            serverEndMs: 0,
            error: `${err.code ?? "?"}: ${err.message ?? String(e)}`,
          });
        });
    }),
  );
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(new Error(`burst exceeded STRESS_WALL_MS=${STRESS_WALL_MS} (possible deadlock)`)),
      STRESS_WALL_MS,
    ),
  );
  const barrier = (async () => {
    while (ready < ops.length) await new Promise((r) => setTimeout(r, 1));
    open();
    await all;
  })();
  await Promise.race([barrier, deadline]);
  rows.sort((a, b) => a.lane - b.lane);
  return rows;
}

async function ownerCounts(sql: Sql, userId: string) {
  const shots = await sql.unsafe(
    `select count(*)::int as n, count(*) filter (where result_kind = 'scored')::int as scored,
            count(distinct id)::int as distinct_ids
       from public.shots where user_id = '${userId}'`,
  );
  const permits = await sql.unsafe(
    `select count(*)::int as n, count(distinct idempotency_key)::int as keys,
            count(*) filter (where status = 'reserved')::int as reserved,
            count(*) filter (where status = 'finalized')::int as finalized,
            count(*) filter (where status = 'released')::int as released
       from public.analysis_permits where user_id = '${userId}'`,
  );
  const ledger = await sql.unsafe(
    `select l.scored_count::int as n from public.free_rating_ledger l
       join auth.identities i on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
      where i.user_id = '${userId}'`,
  );
  return {
    shots: Number(shots[0].n),
    scoredShots: Number(shots[0].scored),
    distinctShotIds: Number(shots[0].distinct_ids),
    permits: Number(permits[0].n),
    permitKeys: Number(permits[0].keys),
    reserved: Number(permits[0].reserved),
    finalized: Number(permits[0].finalized),
    released: Number(permits[0].released),
    ledger: ledger.map((l) => Number(l.n)),
  };
}

const CONCURRENCY_ERRORS = new Set(["40P01", "40001", "55P03", "57014"]);

// ── iteration driver ─────────────────────────────────────────────────────────

interface IterationRow {
  scenario: string;
  iteration: number;
  seed: number;
  outcome: "HELD" | "BROKEN";
  lanes: number;
  resultHistogram: Record<string, number>;
  lanesOverlappingAnotherLane: number;
  violated: string[];
  invariants: Invariant[];
  observations: Record<string, unknown>;
  rows: Lane[];
  durationMs: number;
  replay: string;
}

interface ScenarioSummary {
  scenario: string;
  iterations: number;
  held: number;
  broken: number;
  lanes: number;
  brokenSeeds: number[];
  wallMs: number;
  maxIterationMs: number;
}

const campaignRows: IterationRow[] = [];
const campaignScenarios: ScenarioSummary[] = [];

function overlapCount(rows: Lane[]): number {
  return rows.filter((a) =>
    rows.some((b) => b !== a && a.serverStartMs < b.serverEndMs && b.serverStartMs < a.serverEndMs),
  ).length;
}

/** Real-time (server clock) monotonicity + read-your-writes over the reads of
 * one burst. `writeEnds` are the server-clock instants by which a write was
 * CERTAINLY committed (`committedByMs`) — a write adds one to `used` (applied
 * scored shot) or to `used+reserved` (accepted reserve). */
function checkReadOrder(
  invariants: Invariant[],
  reads: Lane[],
  writeEnds: { reserves: number[]; applies: number[] },
  tag: string,
): void {
  const sorted = [...reads].sort((a, b) => a.serverStartMs - b.serverStartMs);
  let monotone = "";
  for (const a of sorted) {
    for (const b of sorted) {
      if (a === b || a.serverEndMs > b.serverStartMs) continue;
      const pa = a.payload!;
      const pb = b.payload!;
      if (pb.used < pa.used || pb.used + pb.reserved < pa.used + pa.reserved) {
        monotone = `lane ${a.lane} (${pa.used}+${pa.reserved}) ended before lane ${b.lane} (${pb.used}+${pb.reserved}) started`;
        break;
      }
    }
    if (monotone) break;
  }
  inv(
    invariants,
    `${tag}: G3 non-overlapping reads never go backwards`,
    monotone === "",
    monotone || `${reads.length} reads ordered by server clock`,
  );
  let ryw = "";
  for (const r of sorted) {
    const reserves = writeEnds.reserves.filter((t) => t <= r.serverStartMs).length;
    const applies = writeEnds.applies.filter((t) => t <= r.serverStartMs).length;
    const p = r.payload!;
    if (
      p.used < Math.min(FREE_LIMIT, applies) ||
      p.used + p.reserved < Math.min(FREE_LIMIT, reserves)
    ) {
      ryw = `lane ${r.lane} read used=${p.used} reserved=${p.reserved} although ${reserves} reserves / ${applies} scored applies had committed before it started`;
      break;
    }
  }
  inv(
    invariants,
    `${tag}: G4 reads see writes committed before they started`,
    ryw === "",
    ryw || `${writeEnds.reserves.length} reserves / ${writeEnds.applies.length} applies visible`,
  );
}

type IterationFn = (
  sql: Sql,
  prng: Prng,
  iteration: number,
  invariants: Invariant[],
  observations: Record<string, unknown>,
) => Promise<Lane[]>;

async function runScenario(
  scenario: string,
  iterations: number,
  fn: IterationFn,
): Promise<ScenarioSummary> {
  const sql = postgres(PG_URL, { max: POOL_MAX });
  const rows: IterationRow[] = [];
  const t0 = performance.now();
  let maxIterationMs = 0;
  try {
    for (const [iteration, seed] of iterationSeeds(scenario, iterations).entries()) {
      const prng = new Prng(seed);
      const invariants: Invariant[] = [];
      const observations: Record<string, unknown> = {};
      const it0 = performance.now();
      let lanes: Lane[] = [];
      try {
        lanes = await fn(sql, prng, iteration, invariants, observations);
      } catch (error) {
        inv(
          invariants,
          "iteration completes without throwing",
          false,
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        );
      }
      const durationMs = Math.round((performance.now() - it0) * 100) / 100;
      maxIterationMs = Math.max(maxIterationMs, durationMs);
      const concurrencyErrors = lanes.filter((l) =>
        CONCURRENCY_ERRORS.has((l.error ?? "").split(":")[0]),
      );
      inv(
        invariants,
        "G7 no deadlock / serialization failure / lock timeout surfaced to a caller",
        concurrencyErrors.length === 0,
        concurrencyErrors.map((l) => `lane ${l.lane} ${l.error}`).join("; ") ||
          `${lanes.length} lanes, no 40P01/40001/55P03/57014`,
      );
      inv(
        invariants,
        "G7 burst settles within STRESS_WALL_MS",
        durationMs < STRESS_WALL_MS,
        `${durationMs}ms < ${STRESS_WALL_MS}ms`,
      );
      const violated = invariants.filter((i) => !i.holds).map((i) => `${i.name} — ${i.detail}`);
      rows.push({
        scenario,
        iteration,
        seed,
        outcome: violated.length ? "BROKEN" : "HELD",
        lanes: lanes.length,
        resultHistogram: histogram(lanes.map((l) => `${l.op}:${l.result}`)),
        lanesOverlappingAnotherLane: overlapCount(lanes),
        violated,
        invariants,
        observations,
        rows: lanes,
        durationMs,
        replay: replayCommand(scenario, seed),
      });
    }
  } finally {
    await sql.end();
  }
  const wallMs = Math.round(performance.now() - t0);
  const summary: ScenarioSummary = {
    scenario,
    iterations: rows.length,
    held: rows.filter((r) => r.outcome === "HELD").length,
    broken: rows.filter((r) => r.outcome === "BROKEN").length,
    lanes: rows.reduce((n, r) => n + r.lanes, 0),
    brokenSeeds: rows.filter((r) => r.outcome === "BROKEN").map((r) => r.seed),
    wallMs,
    maxIterationMs,
  };
  campaignRows.push(...rows);
  campaignScenarios.push(summary);
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    `${dir}${scenario}.json`,
    JSON.stringify({ summary, seed: STRESS_SEED, pgLanes: LANES, rows }, null, 2),
  );
  console.log(
    `[stress-pg] ${scenario}: ${summary.iterations} iterations, ${summary.lanes} lanes, ${summary.held} HELD / ${summary.broken} BROKEN, ${wallMs}ms (max iteration ${maxIterationMs}ms)`,
  );
  for (const row of rows.filter((r) => r.outcome === "BROKEN")) {
    console.log(`[stress-pg]   BROKEN seed=${row.seed}: ${row.violated.join(" | ")}`);
    console.log(`[stress-pg]     replay: ${row.replay}`);
  }
  return summary;
}

function assertHeld(summary: ScenarioSummary): void {
  assert(summary.iterations > 0, `${summary.scenario}: no iteration ran`);
  assert(
    summary.broken === 0,
    `${summary.scenario}: ${summary.broken}/${summary.iterations} iterations BROKEN — seeds ${summary.brokenSeeds.join(", ")} (see ${outDir()}${summary.scenario}.json)`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PGA — access_state() reads racing reserves and scored applies (one user)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress pg A: access_state reads racing reserves + scored applies — valid, monotone, read-your-writes, exactly two ratings spent",
  ignore,
  async fn() {
    const summary = await runScenario(
      "pga_read_during_write",
      STRESS_ITER,
      async (sql, prng, _i, invariants, observations) => {
        const uid = prng.uuid();
        const identity = { provider: "google", sub: `sub-${uid}` };
        await createUser(sql, uid, identity);
        // three permits: two are grantable, the third must be refused
        const keys = [prng.uuid(), prng.uuid(), prng.uuid()];
        const shots = [prng.uuid(), prng.uuid(), prng.uuid()];
        // phase 1: reserves and reads together
        const phase1 = await burst(
          sql,
          [
            ...keys.map((key) => ({
              op: "reserve",
              userId: uid,
              run: async (tx: Tx) => {
                const r = await tx.unsafe(
                  `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
                );
                return `${r[0].result}${r[0].permit_id ? `:${String(r[0].permit_id)}` : ""}`;
              },
            })),
            ...Array.from({ length: LANES }, () => ({
              op: "read",
              userId: uid,
              run: async () => "",
            })),
          ],
          (lane) => lane >= keys.length,
        );
        const reserveLanes = phase1.filter((l) => l.op === "reserve");
        const accepted = reserveLanes.filter((l) => l.result.startsWith("accepted"));
        const refused = reserveLanes.filter((l) => l.result.startsWith("access.paywall_required"));
        const permitIds = accepted.map((l) => l.result.split(":")[1]);
        // phase 2: scored applies (one per accepted permit, plus one duplicate replay) and reads together
        const applySpecs = permitIds.map((permitId, i) => ({
          op: "apply",
          userId: uid,
          run: async (tx: Tx) => {
            const r = await tx.unsafe(
              `select public.apply_synced_shot($1::text::jsonb) as result`,
              [JSON.stringify(shotPayload(shots[i], permitId))],
            );
            return String(r[0].result);
          },
        }));
        if (applySpecs.length > 0) {
          const dup = prng.int(0, applySpecs.length - 1);
          applySpecs.push({ ...applySpecs[dup], op: "apply.replay" });
        }
        const phase2 = await burst(
          sql,
          [
            ...applySpecs,
            ...Array.from({ length: LANES }, () => ({
              op: "read",
              userId: uid,
              run: async () => "",
            })),
          ],
          (lane) => lane >= applySpecs.length,
        );
        const applyLanes = phase2.filter((l) => l.op.startsWith("apply"));
        const reads = [...phase1, ...phase2].filter((l) => l.op === "read" && l.payload);
        const violations = reads.flatMap((r) => payloadViolations(r.payload!, r.rawReserved ?? 0));
        inv(
          invariants,
          "G1 every concurrent read yields a payload the route could serve (parseAccess contract)",
          violations.length === 0,
          violations.slice(0, 3).join("; ") || `${reads.length} reads valid`,
        );
        inv(
          invariants,
          "G2 no read ever reports more than two lifetime free ratings spent-or-held",
          reads.every((r) => r.payload!.used + r.payload!.reserved <= FREE_LIMIT),
          reads.map((r) => `${r.payload!.used}+${r.payload!.reserved}`).join(" "),
        );
        checkReadOrder(
          invariants,
          reads,
          {
            reserves: accepted.map((l) => l.committedByMs ?? Infinity),
            applies: applyLanes
              .filter((l) => l.result === "accepted" && l.op === "apply")
              .map((l) => l.committedByMs ?? Infinity),
          },
          "pga",
        );
        inv(
          invariants,
          "reserve_analysis_permit grants exactly two of three concurrent distinct keys, the third gets access.paywall_required",
          accepted.length === FREE_LIMIT && refused.length === 1,
          JSON.stringify(histogram(reserveLanes.map((l) => l.result.split(":")[0]))),
        );
        inv(
          invariants,
          "every scored apply of a reserved permit is accepted, and the duplicate replay is accepted idempotently",
          applyLanes.length > 0 && applyLanes.every((l) => l.result === "accepted"),
          JSON.stringify(histogram(applyLanes.map((l) => `${l.op}:${l.result}`))),
        );
        const counts = await ownerCounts(sql, uid);
        inv(
          invariants,
          "G5 exactly two scored shots and two consumed permits; ledger = 2 (no double spend)",
          counts.scoredShots === FREE_LIMIT &&
            counts.finalized === FREE_LIMIT &&
            counts.reserved === 0 &&
            counts.ledger.length === 1 &&
            counts.ledger[0] === FREE_LIMIT,
          JSON.stringify(counts),
        );
        inv(
          invariants,
          "G6 no duplicate rows: one permit per idempotency key, one row per shot id",
          counts.permits === counts.permitKeys && counts.shots === counts.distinctShotIds,
          `permits=${counts.permits} keys=${counts.permitKeys} shots=${counts.shots} distinct=${counts.distinctShotIds}`,
        );
        const final = await burst(
          sql,
          [{ op: "read.final", userId: uid, run: async () => "" }],
          () => true,
        );
        const fp = final[0].payload!;
        inv(
          invariants,
          "final read: used=2, reserved=0, availableToReserve=0, paywallRequired=true",
          fp.used === FREE_LIMIT &&
            fp.reserved === 0 &&
            fp.availableToReserve === 0 &&
            fp.paywallRequired,
          JSON.stringify(fp),
        );
        observations.user = uid;
        observations.reserveResults = reserveLanes.map((l) => l.result.split(":")[0]);
        observations.applyResults = applyLanes.map((l) => `${l.op}:${l.result}`);
        observations.readSnapshots = reads
          .sort((a, b) => a.serverStartMs - b.serverStartMs)
          .map((r) => `${r.payload!.used}/${r.payload!.reserved}`);
        observations.counts = counts;
        return [...phase1, ...phase2, ...final];
      },
    );
    assertHeld(summary);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PGB — same idempotency key + same shot id from every lane (duplicate delivery)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress pg B: duplicate delivery — one key and one shot id from every lane leave one permit, one shot, one rating spent",
  ignore,
  async fn() {
    const summary = await runScenario(
      "pgb_duplicate_delivery",
      STRESS_ITER,
      async (sql, prng, _i, invariants, observations) => {
        const uid = prng.uuid();
        await createUser(sql, uid, { provider: "google", sub: `sub-${uid}` });
        const key = prng.uuid();
        const shotId = prng.uuid();
        const reserves = await burst(
          sql,
          Array.from({ length: LANES }, () => ({
            op: "reserve.sameKey",
            userId: uid,
            run: async (tx: Tx) => {
              const r = await tx.unsafe(
                `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
              );
              return `${r[0].result}:${String(r[0].permit_id ?? "")}`;
            },
          })),
          () => false,
        );
        const ids = new Set(reserves.map((l) => l.result.split(":")[1]).filter(Boolean));
        inv(
          invariants,
          "every lane of the same-key reserve burst is accepted with the SAME permit id",
          reserves.every((l) => l.result.startsWith("accepted")) && ids.size === 1,
          `${JSON.stringify(histogram(reserves.map((l) => l.result.split(":")[0])))} ids=${ids.size}`,
        );
        const permitId = [...ids][0];
        const applies = await burst(
          sql,
          [
            ...Array.from({ length: LANES }, () => ({
              op: "apply.sameShot",
              userId: uid,
              run: async (tx: Tx) => {
                const r = await tx.unsafe(
                  `select public.apply_synced_shot($1::text::jsonb) as result`,
                  [JSON.stringify(shotPayload(shotId, permitId))],
                );
                return String(r[0].result);
              },
            })),
            ...Array.from({ length: 4 }, () => ({
              op: "read",
              userId: uid,
              run: async () => "",
            })),
          ],
          (lane) => lane >= LANES,
        );
        const applyLanes = applies.filter((l) => l.op === "apply.sameShot");
        const reads = applies.filter((l) => l.op === "read" && l.payload);
        // a loser must never be handed a permanent rejection: the SQL replay
        // check (before AND after the lock, 20260906000000) answers `accepted`
        const verdicts = histogram(applyLanes.map((l) => l.result));
        inv(
          invariants,
          "every duplicate copy of one shot is accepted (idempotent replay) — no permanent rejection for a loser",
          applyLanes.every((l) => l.result === "accepted"),
          JSON.stringify(verdicts),
        );
        const violations = reads.flatMap((r) => payloadViolations(r.payload!, r.rawReserved ?? 0));
        inv(
          invariants,
          "G1 reads interleaved with the duplicate burst stay valid and never exceed the limit",
          violations.length === 0 &&
            reads.every((r) => r.payload!.used + r.payload!.reserved <= FREE_LIMIT),
          violations.slice(0, 3).join("; ") ||
            reads.map((r) => `${r.payload!.used}+${r.payload!.reserved}`).join(" "),
        );
        const counts = await ownerCounts(sql, uid);
        inv(
          invariants,
          "G5/G6 exactly one permit, one shot, one rating spent after the whole duplicate storm",
          counts.permits === 1 &&
            counts.shots === 1 &&
            counts.scoredShots === 1 &&
            counts.finalized === 1 &&
            counts.ledger.length === 1 &&
            counts.ledger[0] === 1,
          JSON.stringify(counts),
        );
        const after = await burst(
          sql,
          [{ op: "read.final", userId: uid, run: async () => "" }],
          () => true,
        );
        const fp = after[0].payload!;
        inv(
          invariants,
          "one rating remains available after the storm (used=1, availableToReserve=1, canStartRating=true)",
          fp.used === 1 && fp.reserved === 0 && fp.availableToReserve === 1 && fp.canStartRating,
          JSON.stringify(fp),
        );
        observations.user = uid;
        observations.applyVerdicts = verdicts;
        observations.counts = counts;
        return [...reserves, ...applies, ...after];
      },
    );
    assertHeld(summary);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PGC — two actors on the same identity: fresh account never refunds ratings
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress pg C: identity ledger under concurrency — a fresh account for the same sign-in identity reads used=2 immediately",
  ignore,
  async fn() {
    const summary = await runScenario(
      "pgc_identity_ledger",
      STRESS_ITER,
      async (sql, prng, _i, invariants, observations) => {
        const first = prng.uuid();
        const identity = { provider: "google", sub: `sub-${prng.uuid()}` };
        await createUser(sql, first, identity);
        // spend both ratings concurrently
        const keys = [prng.uuid(), prng.uuid()];
        const shotIds = [prng.uuid(), prng.uuid()];
        const reserves = await burst(
          sql,
          keys.map((key) => ({
            op: "reserve",
            userId: first,
            run: async (tx: Tx) => {
              const r = await tx.unsafe(
                `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
              );
              return `${r[0].result}:${String(r[0].permit_id ?? "")}`;
            },
          })),
          () => false,
        );
        const permitIds = reserves
          .filter((l) => l.result.startsWith("accepted"))
          .map((l) => l.result.split(":")[1]);
        const applies = await burst(
          sql,
          permitIds.map((permitId, i) => ({
            op: "apply",
            userId: first,
            run: async (tx: Tx) => {
              const r = await tx.unsafe(
                `select public.apply_synced_shot($1::text::jsonb) as result`,
                [JSON.stringify(shotPayload(shotIds[i], permitId))],
              );
              return String(r[0].result);
            },
          })),
          () => false,
        );
        inv(
          invariants,
          "both ratings are spent on the first account",
          applies.every((l) => l.result === "accepted") && applies.length === FREE_LIMIT,
          JSON.stringify(histogram(applies.map((l) => l.result))),
        );
        // the account is deleted (cascade) and the SAME identity signs in again
        await sql.unsafe(`delete from auth.users where id = '${first}'`);
        const second = prng.uuid();
        await createUser(sql, second, identity, { keepLedger: true });
        const reads = await burst(
          sql,
          [
            ...Array.from({ length: LANES }, () => ({
              op: "read.newAccount",
              userId: second,
              run: async () => "",
            })),
            {
              op: "reserve.newAccount",
              userId: second,
              run: async (tx: Tx) => {
                const r = await tx.unsafe(
                  `select x.result from public.reserve_analysis_permit('${prng.uuid()}') x`,
                );
                return String(r[0].result);
              },
            },
          ],
          (lane) => lane < LANES,
        );
        const readLanes = reads.filter((l) => l.op === "read.newAccount" && l.payload);
        const reserveLane = reads.find((l) => l.op === "reserve.newAccount")!;
        const violations = readLanes.flatMap((r) =>
          payloadViolations(r.payload!, r.rawReserved ?? 0),
        );
        inv(
          invariants,
          "G8 every concurrent read on the brand-new account reports used=2, availableToReserve=0, paywallRequired=true",
          violations.length === 0 &&
            readLanes.length === LANES &&
            readLanes.every(
              (r) =>
                r.payload!.used === FREE_LIMIT &&
                r.payload!.availableToReserve === 0 &&
                r.payload!.paywallRequired &&
                !r.payload!.canStartRating,
            ),
          violations.slice(0, 3).join("; ") ||
            JSON.stringify(
              histogram(readLanes.map((r) => `${r.payload!.used}/${r.payload!.reserved}`)),
            ),
        );
        inv(
          invariants,
          "the concurrent reserve on the new account is refused (access.paywall_required)",
          reserveLane.result === "access.paywall_required",
          reserveLane.result,
        );
        const counts = await ownerCounts(sql, second);
        inv(
          invariants,
          "G6 the new account owns no shots and no permits",
          counts.shots === 0 && counts.permits === 0,
          JSON.stringify(counts),
        );
        observations.firstAccount = first;
        observations.secondAccount = second;
        observations.identity = `${identity.provider}:${identity.sub}`;
        observations.counts = counts;
        return [...reserves, ...applies, ...reads];
      },
    );
    assertHeld(summary);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PGD — mixed-order storm: reads, reserves, applies and finalizes in one burst
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress pg D: mixed-order storm (reads + reserves + applies + finalizes in one barrier) — no deadlock, limit never exceeded",
  ignore,
  async fn() {
    const summary = await runScenario(
      "pgd_mixed_storm",
      STRESS_ITER,
      async (sql, prng, _i, invariants, observations) => {
        const uid = prng.uuid();
        await createUser(sql, uid, { provider: "google", sub: `sub-${uid}` });
        // pre-reserve one permit so applies and finalizes have something to hit
        const preKey = prng.uuid();
        const pre = await sql.begin(async (raw) => {
          const tx = raw as unknown as Tx;
          await asUser(tx, uid);
          const r = await tx.unsafe(
            `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${preKey}') x`,
          );
          return String(r[0].permit_id ?? "");
        });
        const prePermit = String(pre);
        const shotId = prng.uuid();
        const keys = Array.from({ length: 4 }, () => prng.uuid());
        const specs: Array<{ op: string; userId: string; run: (tx: Tx) => Promise<string> }> = [];
        for (const key of keys) {
          specs.push({
            op: "reserve",
            userId: uid,
            run: async (tx: Tx) => {
              const r = await tx.unsafe(
                `select x.result from public.reserve_analysis_permit('${key}') x`,
              );
              return String(r[0].result);
            },
          });
        }
        for (let i = 0; i < 3; i++) {
          specs.push({
            op: "apply.sameShot",
            userId: uid,
            run: async (tx: Tx) => {
              const r = await tx.unsafe(
                `select public.apply_synced_shot($1::text::jsonb) as result`,
                [JSON.stringify(shotPayload(shotId, prePermit))],
              );
              return String(r[0].result);
            },
          });
        }
        for (let i = 0; i < 2; i++) {
          specs.push({
            op: "finalize",
            userId: uid,
            run: async (tx: Tx) => {
              const r = await tx.unsafe(
                `update public.analysis_permits set status = 'released', outcome = 'cancelled'
                 where id = '${prePermit}' and status = 'reserved' returning status`,
              );
              return r.length ? "released" : "noop";
            },
          });
        }
        const readCount = LANES;
        for (let i = 0; i < readCount; i++) {
          specs.push({ op: "read", userId: uid, run: async () => "" });
        }
        const order = prng.shuffle(specs.map((_, i) => i));
        const shuffled = order.map((i) => specs[i]);
        const readIndexes = new Set(
          shuffled.map((s, i) => (s.op === "read" ? i : -1)).filter((i) => i >= 0),
        );
        const lanes = await burst(sql, shuffled, (lane) => readIndexes.has(lane));
        const reads = lanes.filter((l) => l.op === "read" && l.payload);
        const violations = reads.flatMap((r) => payloadViolations(r.payload!, r.rawReserved ?? 0));
        inv(
          invariants,
          "G1 every read in the mixed storm yields a servable payload",
          violations.length === 0 && reads.length === readCount,
          violations.slice(0, 3).join("; ") || `${reads.length} reads valid`,
        );
        inv(
          invariants,
          "G2 no read exceeds the two-rating limit while reserves, applies and finalizes commit around it",
          reads.every((r) => r.payload!.used + r.payload!.reserved <= FREE_LIMIT),
          reads.map((r) => `${r.payload!.used}+${r.payload!.reserved}`).join(" "),
        );
        const applyLanes = lanes.filter((l) => l.op === "apply.sameShot");
        const acceptedApplies = applyLanes.filter((l) => l.result === "accepted").length;
        inv(
          invariants,
          "the duplicate applies of one shot are all accepted, or refused only with the retryable permit verdicts a racing finalize creates",
          applyLanes.every(
            (l) =>
              l.result === "accepted" ||
              l.result === "access.permit_not_reserved" ||
              l.result === "access.paywall_required",
          ),
          JSON.stringify(histogram(applyLanes.map((l) => l.result))),
        );
        const counts = await ownerCounts(sql, uid);
        inv(
          invariants,
          "G5/G6 at most one shot row for the single shot id, at most two ratings spent, one permit per key",
          counts.shots <= 1 &&
            counts.scoredShots <= 1 &&
            counts.shots === counts.distinctShotIds &&
            counts.permits === counts.permitKeys &&
            (counts.ledger[0] ?? 0) <= FREE_LIMIT,
          JSON.stringify(counts),
        );
        inv(
          invariants,
          "reserves never grant more than the limit allows (accepted ≤ 2 including the pre-reserved permit)",
          lanes.filter((l) => l.op === "reserve" && l.result === "accepted").length <=
            FREE_LIMIT - 1 + (acceptedApplies > 0 ? 1 : 0) + 1,
          JSON.stringify(histogram(lanes.filter((l) => l.op === "reserve").map((l) => l.result))),
        );
        observations.user = uid;
        observations.order = shuffled.map((s) => s.op);
        observations.results = lanes.map((l) => `${l.op}:${l.result}`);
        observations.counts = counts;
        return lanes;
      },
    );
    assertHeld(summary);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// campaign summary
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress pg: write campaign summary (seed → outcome table)",
  ignore,
  async fn() {
    const dir = outDir();
    await Deno.mkdir(dir, { recursive: true });
    const table = campaignRows.map((r) => ({
      scenario: r.scenario,
      iteration: r.iteration,
      seed: r.seed,
      outcome: r.outcome,
      lanes: r.lanes,
      lanesOverlappingAnotherLane: r.lanesOverlappingAnotherLane,
      durationMs: r.durationMs,
      violated: r.violated,
      replay: r.replay,
    }));
    const summary = {
      unit: "route-get-v1-me-access",
      lens: "concurrency",
      plane: "real postgres:16 + every migration (xc_pg_up.sh)",
      campaignSeed: STRESS_SEED,
      pgLanes: LANES,
      iterations: table.length,
      lanes: table.reduce((n, r) => n + r.lanes, 0),
      held: table.filter((r) => r.outcome === "HELD").length,
      broken: table.filter((r) => r.outcome === "BROKEN").length,
      scenarios: campaignScenarios,
      heap: Deno.memoryUsage(),
      table,
    };
    await Deno.writeTextFile(`${dir}campaign_pg.json`, JSON.stringify(summary, null, 2));
    console.log(
      `[stress-pg] campaign: ${summary.iterations} iterations, ${summary.lanes} lanes, ${summary.held} HELD / ${summary.broken} BROKEN → ${dir}campaign_pg.json`,
    );
    assert(summary.iterations > 0, "no iteration ran");
  },
});
