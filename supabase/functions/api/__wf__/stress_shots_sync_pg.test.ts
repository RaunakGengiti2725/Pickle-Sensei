// stress: POST /v1/shots:sync's DATABASE half on a REAL postgres:16 with
// supabase/tests/shim_auth.sql + every migration applied (./xc_pg_up.sh).
//
// Each "lane" is what one edge isolate does for one request, on its own
// connection in its own transaction as role `authenticated` with the caller's
// JWT sub, released from a barrier so N copies genuinely run at once:
//   1. the route's replay lookup — select id from public.shots where user_id
//      = auth.uid() and id in (<batch>)  (RLS applies)
//   2. public.apply_synced_shot(jsonb) once per id the lookup did not return
//   3. COMMIT
//
//   PGS1  duplicate delivery — the same 1..3-shot batch from N lanes at once,
//         then a sequential re-delivery: one row per shot, permit finalized
//         once, ledger charged once, EVERY lane told accepted, replay = 0 RPC
//   PGS2  free-rating double-spend — N distinct scored shots (a) all on one
//         reserved permit, (b) on legacy-minted permits, (c) after the
//         account that spent both ratings is deleted and re-created with the
//         same provider subject: never more than 2 lifetime scored shots
//   PGS3  RPC boundary — payloads the edge parser lets through that the RPC
//         must answer with a contract code (foreign permit, foreign session,
//         finalized permit, unknown session), never a SQL error
//   PGS4  hot-path cost — the route's SQL sequence for batches of 1 / 8 / 50 /
//         200 new shots (premium): PostgREST round trips = 1 + N, per-RPC and
//         per-batch latency on this local Postgres
//
// Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
// ignored run is NOT a pass. Seeded by STRESS_SEED; scale by STRESS_PG_LANES
// (default 12) and STRESS_PG_ROUNDS (default 4). Results:
// artifacts/stress-shots-sync/latest/pg.json.
//
//   ./xc_pg_up.sh
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres STRESS_SEED=20260904 \
//     deno test -A --no-check --config deno.json stress_shots_sync_pg.test.ts

import postgres from "postgres";
import { assert } from "@std/assert";
import { envInt, histogram, Prng, summarize, writeArtifact } from "./stress_shots_sync_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const LANES = envInt("STRESS_PG_LANES", 12);
const ROUNDS = envInt("STRESS_PG_ROUNDS", 4);

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

function shot(
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
    phases: [{ key: "prep", startMs: 0, representativeMs: 40, endMs: 80, confidence: 0.8 }],
    checkpoints: [
      {
        key: "paddle_ready",
        score: 60,
        confidence: 0.7,
        band: "green",
        direction: "none",
        severity: 0.2,
        applicable: true,
      },
    ],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

interface LaneRow {
  scenario: string;
  round: number;
  lane: number;
  user: string;
  batch: string[];
  replayHits: string[];
  rpc: Array<{ id: string; result: string; ms: number }>;
  /** the route's per-shot verdicts for this lane */
  verdicts: Record<string, string>;
  sqlError?: string;
  serverStartMs: number;
  serverEndMs: number;
  clientMs: number;
}

interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
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

async function serverNowMs(tx: Tx): Promise<number> {
  const r = await tx.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

/** Every user this file creates carries this email domain so a scenario can
 * sweep the previous run's users (and, via cascade, their shots — otherwise a
 * seeded shot id that belonged to a user from a run at a different scale
 * would collide as shot.id_conflict). */
const USER_EMAIL_DOMAIN = "stress-shots-sync.test";

/** Owner-role setup. Seeded ids repeat across runs against the same
 * disposable DB, so an earlier run's user (and, because it survives deletion
 * by design, its identity's ledger row) is removed first. */
async function createUser(
  sql: Sql,
  userId: string,
  identity: { provider: string; sub: string },
  opts: { keepLedger?: boolean; premium?: boolean } = {},
) {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `delete from auth.users u using auth.identities i
      where i.user_id = u.id and i.provider = '${identity.provider}' and i.provider_id = '${identity.sub}'`,
  );
  if (!opts.keepLedger) {
    await sql.unsafe(
      `delete from public.free_rating_ledger
        where identity_hash = public.free_rating_identity_hash('${identity.provider}', '${identity.sub}')`,
    );
  }
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@${USER_EMAIL_DOMAIN}', '{"provider":"${identity.provider}"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('${identity.provider}', '${identity.sub}', '${userId}', '{"sub":"${identity.sub}"}')`,
  );
  if (opts.premium) {
    await sql.unsafe(
      `insert into public.billing_entitlements (user_id, premium, product_key, expires_at) values ('${userId}', true, 'pickle_sensei_pro_lifetime', null)`,
    );
  }
}

/** reserve_analysis_permit as the user (the app's real path to a permit). */
async function reserve(
  sql: Sql,
  userId: string,
  key: string,
): Promise<{ result: string; permitId: string | null }> {
  let out = { result: "", permitId: null as string | null };
  await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
    const r = await tx.unsafe(
      `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
    );
    out = { result: String(r[0].result), permitId: r[0].permit_id ? String(r[0].permit_id) : null };
  });
  return out;
}

/** A permit minted outside reserve_analysis_permit (every build before it existed could). */
async function legacyPermit(sql: Sql, userId: string, key: string): Promise<string> {
  const r = await sql.unsafe(
    `insert into public.analysis_permits (user_id, idempotency_key) values ('${userId}', '${key}') returning id::text as id`,
  );
  return String(r[0].id);
}

/** Exactly the route's DB sequence for one request, inside one open tx. */
async function routeSequence(
  tx: Tx,
  userId: string,
  batch: Array<Record<string, unknown>>,
): Promise<Omit<LaneRow, "scenario" | "round" | "lane" | "clientMs">> {
  const ids = batch.map((s) => String(s.id));
  const t0 = await serverNowMs(tx);
  const verdicts: Record<string, string> = {};
  const rpc: LaneRow["rpc"] = [];
  let replayHits: string[] = [];
  let sqlError: string | undefined;
  try {
    const existing = await tx.unsafe(
      `select id::text as id from public.shots where user_id = auth.uid() and id in (${ids.map((id) => `'${id}'`).join(",")})`,
    );
    replayHits = existing.map((r) => String(r.id));
    for (const s of batch) {
      const id = String(s.id);
      if (replayHits.includes(id)) {
        verdicts[id] = "accepted";
        continue;
      }
      const c0 = performance.now();
      const r = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as result`, [
        JSON.stringify(s),
      ]);
      const result = String(r[0].result);
      rpc.push({ id, result, ms: Math.round((performance.now() - c0) * 100) / 100 });
      verdicts[id] = result;
    }
  } catch (error) {
    // PostgREST would surface this as an error → the route answers shot.write_failed
    sqlError = error instanceof Error ? error.message : String(error);
    throw error;
  }
  const t1 = await serverNowMs(tx);
  return {
    user: userId,
    batch: ids,
    replayHits,
    rpc,
    verdicts,
    sqlError,
    serverStartMs: t0,
    serverEndMs: t1,
  };
}

/** N lanes, each its own connection + tx as `userIdFor(lane)`, released
 * together; each lane runs the route's sequence for `batchFor(lane)` and COMMITs. */
async function burst(
  sql: Sql,
  scenario: string,
  round: number,
  lanes: number,
  userIdFor: (lane: number) => string,
  batchFor: (lane: number) => Array<Record<string, unknown>>,
): Promise<LaneRow[]> {
  const b = barrier();
  let ready = 0;
  const rows: LaneRow[] = [];
  const all = Promise.all(
    Array.from({ length: lanes }, async (_, lane) => {
      const batch = batchFor(lane);
      const t0 = performance.now();
      try {
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, userIdFor(lane));
          ready += 1;
          await b.gate;
          const out = await routeSequence(tx as unknown as Tx, userIdFor(lane), batch);
          rows.push({
            scenario,
            round,
            lane,
            clientMs: Math.round((performance.now() - t0) * 100) / 100,
            ...out,
          });
        });
      } catch (error) {
        ready += 1;
        rows.push({
          scenario,
          round,
          lane,
          user: userIdFor(lane),
          batch: batch.map((s) => String(s.id)),
          replayHits: [],
          rpc: [],
          verdicts: Object.fromEntries(batch.map((s) => [String(s.id), "shot.write_failed"])),
          sqlError: error instanceof Error ? error.message : String(error),
          serverStartMs: 0,
          serverEndMs: 0,
          clientMs: Math.round((performance.now() - t0) * 100) / 100,
        });
      }
    }),
  );
  while (ready < lanes) await new Promise((r) => setTimeout(r, 1));
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

async function ownerState(sql: Sql, userId: string) {
  const shots = await sql.unsafe(
    `select count(*)::int as n, count(*) filter (where result_kind = 'scored')::int as scored,
            count(distinct id)::int as distinct_ids from public.shots where user_id = '${userId}'`,
  );
  const details = await sql.unsafe(
    `select (select count(*) from public.shot_phases where user_id = '${userId}')::int as phases,
            (select count(*) from public.shot_checkpoints where user_id = '${userId}')::int as checkpoints`,
  );
  const permits = await sql.unsafe(
    `select status, coalesce(outcome, '') as outcome, count(*)::int as n from public.analysis_permits where user_id = '${userId}' group by 1, 2 order by 1, 2`,
  );
  const ledger = await sql.unsafe(
    `select l.scored_count from public.free_rating_ledger l
       join auth.identities i on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
      where i.user_id = '${userId}'`,
  );
  let access = { premium: false, scored_count: -1, reserved_count: -1 };
  await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
    const r = await tx.unsafe(
      `select premium, scored_count, reserved_count from public.access_state()`,
    );
    access = {
      premium: Boolean(r[0].premium),
      scored_count: Number(r[0].scored_count),
      reserved_count: Number(r[0].reserved_count),
    };
  });
  return {
    shots: Number(shots[0].n),
    scoredShots: Number(shots[0].scored),
    distinctIds: Number(shots[0].distinct_ids),
    phases: Number(details[0].phases),
    checkpoints: Number(details[0].checkpoints),
    permits: permits.map((p) => `${p.status}/${p.outcome}=${p.n}`),
    ledger: ledger.map((l) => Number(l.scored_count)),
    access,
  };
}

interface ScenarioResult {
  scenario: string;
  seed: number;
  lanes: number;
  rounds: number;
  invariants: Invariant[];
  verdictHistogram: Record<string, number>;
  lanesOverlappingAnotherLane: number;
  rows: LaneRow[];
  observations: Record<string, unknown>;
  durationMs: number;
  replayCommand: string;
}

const results: ScenarioResult[] = [];
let rpcCalls = 0;

async function scenario(
  name: string,
  run: (
    sql: Sql,
    prng: Prng,
    rows: LaneRow[],
    inv: (n: string, holds: boolean, detail: string) => void,
    obs: Record<string, unknown>,
  ) => Promise<void>,
): Promise<ScenarioResult> {
  const sql = postgres(PG_URL, { max: LANES + 2 });
  const prng = new Prng((STRESS_SEED ^ fnv1a(name)) >>> 0);
  const rows: LaneRow[] = [];
  const invariants: Invariant[] = [];
  const observations: Record<string, unknown> = {};
  const t0 = performance.now();
  try {
    await sql.unsafe(`delete from auth.users where email like '%@${USER_EMAIL_DOMAIN}'`);
    await run(
      sql,
      prng,
      rows,
      (n, holds, detail) => invariants.push({ name: n, holds, detail }),
      observations,
    );
  } finally {
    await sql.end();
  }
  rpcCalls += rows.reduce((n, r) => n + r.rpc.length, 0);
  const result: ScenarioResult = {
    scenario: name,
    seed: STRESS_SEED,
    lanes: LANES,
    rounds: ROUNDS,
    invariants,
    verdictHistogram: histogram(rows.flatMap((r) => Object.values(r.verdicts))),
    lanesOverlappingAnotherLane: overlapCount(rows.filter((r) => r.serverStartMs > 0)),
    rows,
    observations,
    durationMs: Math.round(performance.now() - t0),
    replayCommand: `XC_PG_URL=<from ./xc_pg_up.sh> STRESS_SEED=${STRESS_SEED} STRESS_PG_LANES=${LANES} STRESS_PG_ROUNDS=${ROUNDS} deno test -A --no-check --config deno.json stress_shots_sync_pg.test.ts --filter "${name}"`,
  };
  results.push(result);
  const broken = invariants.filter((i) => !i.holds);
  console.log(
    `[stress pg] ${name}: ${rows.length} lanes, ${invariants.length - broken.length} held, ${broken.length} broken, overlap ${result.lanesOverlappingAnotherLane}/${rows.length}`,
  );
  for (const i of broken) console.log(`[stress pg]   BROKEN ${i.name} — ${i.detail}`);
  return result;
}

function assertHeld(result: ScenarioResult) {
  const broken = result.invariants.filter((i) => !i.holds);
  assert(
    broken.length === 0,
    `${result.scenario}: ${broken.map((i) => `${i.name}: ${i.detail}`).join(" | ")}\nreplay: ${result.replayCommand}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PGS1 — duplicate delivery of the same batch
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress PGS1: same 1..3-shot batch delivered by N concurrent lanes, then re-delivered — one row per shot, permit finalized once, ledger charged once, every lane accepted",
  ignore,
  async fn() {
    const result = await scenario("PGS1 duplicate delivery", async (sql, prng, rows, inv, obs) => {
      const rounds: unknown[] = [];
      for (let r = 0; r < ROUNDS; r++) {
        const uid = prng.uuid();
        const premium = r % 2 === 1;
        await createUser(sql, uid, { provider: "google", sub: `g-${uid}` }, { premium });
        const n = premium ? prng.int(1, 3) : prng.int(1, 2);
        const batch: Array<Record<string, unknown>> = [];
        for (let k = 0; k < n; k++) {
          const permit = await reserve(sql, uid, `pgs1-${r}-${k}-${prng.uuid()}`);
          assert(
            permit.result === "accepted" && permit.permitId,
            `setup: reserve → ${permit.result}`,
          );
          batch.push(shot(prng.uuid(), permit.permitId));
        }
        const out = await burst(
          sql,
          "PGS1",
          r,
          LANES,
          () => uid,
          () => batch,
        );
        rows.push(...out);
        const state = await ownerState(sql, uid);
        const allAccepted = out.every((row) =>
          batch.every((s) => row.verdicts[String(s.id)] === "accepted"),
        );
        inv(
          `round ${r}: every lane told accepted for every shot`,
          allAccepted,
          JSON.stringify(histogram(out.flatMap((row) => Object.values(row.verdicts)))),
        );
        inv(
          `round ${r}: exactly ${n} rows, ${n} distinct ids, details written once`,
          state.shots === n &&
            state.distinctIds === n &&
            state.phases === n &&
            state.checkpoints === n,
          JSON.stringify(state),
        );
        inv(
          `round ${r}: every permit finalized exactly once`,
          state.permits.join() === `finalized/scored=${n}`,
          state.permits.join(","),
        );
        // the ledger trigger counts every scored insert (premium included — the
        // allowance is bypassed for premium, the count is not); N lanes → n, not N×n
        inv(
          `round ${r}: ledger charged exactly ${n} (not ${LANES}×), access scored_count ${n}, premium=${premium}`,
          state.ledger.join() === String(n) &&
            state.access.scored_count === n &&
            state.access.reserved_count === 0 &&
            state.access.premium === premium,
          JSON.stringify({ ledger: state.ledger, access: state.access }),
        );
        inv(
          `round ${r}: no lane hit a SQL error`,
          out.every((row) => !row.sqlError),
          out
            .map((row) => row.sqlError ?? "")
            .filter(Boolean)
            .join(" | ") || "none",
        );
        // sequential re-delivery: the replay lookup must answer, zero RPCs
        const again = await burst(
          sql,
          "PGS1-replay",
          r,
          1,
          () => uid,
          () => batch,
        );
        rows.push(...again);
        inv(
          `round ${r}: re-delivery = replay hits ${n}, 0 RPC, all accepted`,
          again[0].replayHits.length === n &&
            again[0].rpc.length === 0 &&
            batch.every((s) => again[0].verdicts[String(s.id)] === "accepted"),
          JSON.stringify({ hits: again[0].replayHits.length, rpc: again[0].rpc.length }),
        );
        const rpcVerdicts = histogram(out.flatMap((row) => row.rpc.map((x) => x.result)));
        rounds.push({
          round: r,
          user: uid,
          premium,
          shots: n,
          rpcVerdicts,
          winnersViaRpc: out.flatMap((row) => row.rpc).filter((x) => x.result === "accepted")
            .length,
        });
      }
      obs.rounds = rounds;
    });
    result.invariants.push({
      name: "lanes genuinely overlapped",
      holds: result.lanesOverlappingAnotherLane > 0,
      detail: `${result.lanesOverlappingAnotherLane}/${result.rows.length}`,
    });
    assertHeld(result);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PGS2 — free-rating double-spend
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress PGS2: free-rating double-spend — N distinct scored shots on one permit / on legacy permits / after delete+re-create — never more than 2 lifetime scored shots",
  ignore,
  async fn() {
    const result = await scenario("PGS2 double spend", async (sql, prng, rows, inv, obs) => {
      const observed: unknown[] = [];
      for (let r = 0; r < ROUNDS; r++) {
        // (a) one reserved permit, N distinct shots claiming it at once
        {
          const uid = prng.uuid();
          await createUser(sql, uid, { provider: "apple", sub: `a-${uid}` });
          const permit = await reserve(sql, uid, `pgs2a-${r}-${prng.uuid()}`);
          assert(permit.permitId, "setup: reserve");
          const ids = Array.from({ length: LANES }, () => prng.uuid());
          const out = await burst(
            sql,
            "PGS2a",
            r,
            LANES,
            () => uid,
            (lane) => [shot(ids[lane], permit.permitId!)],
          );
          rows.push(...out);
          const h = histogram(out.flatMap((row) => Object.values(row.verdicts)));
          const state = await ownerState(sql, uid);
          inv(
            `round ${r}a: one permit → exactly 1 accepted, rest access.permit_not_reserved`,
            h.accepted === 1 &&
              h["access.permit_not_reserved"] === LANES - 1 &&
              Object.keys(h).length === 2,
            JSON.stringify(h),
          );
          inv(
            `round ${r}a: 1 scored row, permit finalized once, ledger 1, access scored 1`,
            state.scoredShots === 1 &&
              state.permits.join() === "finalized/scored=1" &&
              state.ledger.join() === "1" &&
              state.access.scored_count === 1,
            JSON.stringify(state),
          );
          observed.push({ round: r, variant: "a", h, state });
        }
        // (b) N legacy permits (one per lane), N distinct scored shots at once
        {
          const uid = prng.uuid();
          await createUser(sql, uid, { provider: "google", sub: `g-${uid}` });
          const permits: string[] = [];
          for (let i = 0; i < LANES; i++)
            permits.push(await legacyPermit(sql, uid, `pgs2b-${r}-${i}`));
          const ids = Array.from({ length: LANES }, () => prng.uuid());
          const out = await burst(
            sql,
            "PGS2b",
            r,
            LANES,
            () => uid,
            (lane) => [shot(ids[lane], permits[lane])],
          );
          rows.push(...out);
          const h = histogram(out.flatMap((row) => Object.values(row.verdicts)));
          const state = await ownerState(sql, uid);
          inv(
            `round ${r}b: legacy permits → exactly 2 accepted, ${LANES - 2} access.paywall_required`,
            h.accepted === 2 &&
              h["access.paywall_required"] === LANES - 2 &&
              Object.keys(h).length === 2,
            JSON.stringify(h),
          );
          inv(
            `round ${r}b: 2 scored rows, 2 finalized, ${LANES - 2} released/free_limit_exceeded, ledger 2`,
            state.scoredShots === 2 &&
              state.permits.includes("finalized/scored=2") &&
              state.permits.includes(`released/free_limit_exceeded=${LANES - 2}`) &&
              state.ledger.join() === "2" &&
              state.access.scored_count === 2 &&
              state.access.reserved_count === 0,
            JSON.stringify(state),
          );
          // a third reservation after the spend must be refused
          const third = await reserve(sql, uid, `pgs2b-third-${r}`);
          inv(
            `round ${r}b: third reserve after spend → access.paywall_required`,
            third.result === "access.paywall_required",
            third.result,
          );
          observed.push({ round: r, variant: "b", h, state, third: third.result });
        }
        // (c) spend both, delete the account, re-create with the same subject, N legacy permits, N shots at once
        {
          const uid = prng.uuid();
          const sub = `a-${uid}`;
          await createUser(sql, uid, { provider: "apple", sub });
          const p1 = await reserve(sql, uid, `pgs2c-1-${r}`);
          const p2 = await reserve(sql, uid, `pgs2c-2-${r}`);
          assert(p1.permitId && p2.permitId, "setup: two reserves");
          const first = await burst(
            sql,
            "PGS2c-spend",
            r,
            1,
            () => uid,
            () => [shot(prng.uuid(), p1.permitId!), shot(prng.uuid(), p2.permitId!)],
          );
          rows.push(...first);
          assert(
            Object.values(first[0].verdicts).every((v) => v === "accepted"),
            `setup: spend both → ${JSON.stringify(first[0].verdicts)}`,
          );
          await sql.unsafe(`delete from auth.users where id = '${uid}'`);
          const uid2 = prng.uuid();
          await createUser(sql, uid2, { provider: "apple", sub }, { keepLedger: true });
          const permits: string[] = [];
          for (let i = 0; i < LANES; i++)
            permits.push(await legacyPermit(sql, uid2, `pgs2c-${r}-${i}`));
          const ids = Array.from({ length: LANES }, () => prng.uuid());
          const out = await burst(
            sql,
            "PGS2c",
            r,
            LANES,
            () => uid2,
            (lane) => [shot(ids[lane], permits[lane])],
          );
          rows.push(...out);
          const h = histogram(out.flatMap((row) => Object.values(row.verdicts)));
          const state = await ownerState(sql, uid2);
          inv(
            `round ${r}c: re-created identity → every lane access.paywall_required`,
            h["access.paywall_required"] === LANES && Object.keys(h).length === 1,
            JSON.stringify(h),
          );
          inv(
            `round ${r}c: 0 rows for the new account, ledger still 2, access scored_count 2`,
            state.shots === 0 && state.ledger.join() === "2" && state.access.scored_count === 2,
            JSON.stringify(state),
          );
          const reserveAgain = await reserve(sql, uid2, `pgs2c-again-${r}`);
          inv(
            `round ${r}c: reserve on the re-created account → access.paywall_required`,
            reserveAgain.result === "access.paywall_required",
            reserveAgain.result,
          );
          observed.push({ round: r, variant: "c", h, state });
        }
      }
      obs.rounds = observed;
    });
    result.invariants.push({
      name: "lanes genuinely overlapped",
      holds: result.lanesOverlappingAnotherLane > 0,
      detail: `${result.lanesOverlappingAnotherLane}/${result.rows.length}`,
    });
    assertHeld(result);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PGS3 — the RPC boundary: payloads the edge parser lets through
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress PGS3: RPC boundary — foreign permit, finalized permit, foreign/unknown session, abstention — contract codes, never a SQL error",
  ignore,
  async fn() {
    const result = await scenario("PGS3 rpc boundary", async (sql, prng, rows, inv, obs) => {
      const owner = prng.uuid();
      const other = prng.uuid();
      await createUser(sql, owner, { provider: "google", sub: `g-${owner}` }, { premium: true });
      await createUser(sql, other, { provider: "google", sub: `g-${other}` }, { premium: true });
      const ownPermit = (await reserve(sql, owner, `pgs3-own-${prng.uuid()}`)).permitId!;
      const otherPermit = (await reserve(sql, other, `pgs3-other-${prng.uuid()}`)).permitId!;
      const spent = (await reserve(sql, owner, `pgs3-spent-${prng.uuid()}`)).permitId!;
      const spend = await burst(
        sql,
        "PGS3-setup",
        0,
        1,
        () => owner,
        () => [shot(prng.uuid(), spent)],
      );
      rows.push(...spend);
      const otherSession = prng.uuid();
      await sql.unsafe(
        `insert into public.sessions (id, user_id, started_at) values ('${otherSession}', '${other}', now())`,
      );
      const abstainPermit = (await reserve(sql, owner, `pgs3-abstain-${prng.uuid()}`)).permitId!;

      const cases: Array<{ name: string; payload: Record<string, unknown>; expect: string }> = [
        {
          name: "another user's permit",
          payload: shot(prng.uuid(), otherPermit),
          expect: "access.permit_not_found",
        },
        {
          name: "unknown permit",
          payload: shot(prng.uuid(), prng.uuid()),
          expect: "access.permit_not_found",
        },
        {
          name: "already-finalized permit, new shot id",
          payload: shot(prng.uuid(), spent),
          expect: "access.permit_not_reserved",
        },
        {
          name: "another user's session",
          payload: shot(prng.uuid(), ownPermit, { sessionId: otherSession }),
          expect: "shot.session_not_found",
        },
        {
          name: "unknown session",
          payload: shot(prng.uuid(), ownPermit, { sessionId: prng.uuid() }),
          expect: "shot.session_not_found",
        },
        {
          name: "abstention (low_confidence) releases the permit",
          payload: shot(prng.uuid(), abstainPermit, {
            resultKind: "low_confidence",
            overallScore: null,
          }),
          expect: "accepted",
        },
        {
          name: "empty phases/checkpoints",
          payload: shot(prng.uuid(), ownPermit, { phases: [], checkpoints: [] }),
          expect: "accepted",
        },
      ];
      const out: Record<string, string> = {};
      for (const c of cases) {
        const lane = await burst(
          sql,
          "PGS3",
          0,
          1,
          () => owner,
          () => [c.payload],
        );
        rows.push(...lane);
        const verdict = lane[0].verdicts[String(c.payload.id)];
        out[c.name] = lane[0].sqlError ? `SQL ERROR: ${lane[0].sqlError}` : verdict;
        inv(`${c.name} → ${c.expect}`, verdict === c.expect && !lane[0].sqlError, out[c.name]);
      }
      const state = await ownerState(sql, owner);
      inv(
        "owner state: 3 rows (spent, abstention, empty-details), 2 scored, abstention permit released",
        state.shots === 3 &&
          state.scoredShots === 2 &&
          state.permits.includes("released/low_confidence=1") &&
          state.permits.includes("finalized/scored=2"),
        JSON.stringify(state),
      );
      obs.cases = out;
      obs.ownerState = state;
    });
    assertHeld(result);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PGS4 — hot-path cost on real Postgres
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress PGS4: hot-path cost — the route's SQL sequence for batches of 1/8/50/200 new shots (premium): round trips = 1 + N",
  ignore,
  async fn() {
    const result = await scenario("PGS4 hot path cost", async (sql, prng, rows, inv, obs) => {
      const uid = prng.uuid();
      await createUser(sql, uid, { provider: "google", sub: `g-${uid}` }, { premium: true });
      const sizes = [1, 8, 50, 200];
      const table: unknown[] = [];
      for (const n of sizes) {
        const batch: Array<Record<string, unknown>> = [];
        for (let k = 0; k < n; k++) {
          const permit = await reserve(sql, uid, `pgs4-${n}-${k}-${prng.uuid()}`);
          assert(permit.permitId, `setup: reserve → ${permit.result}`);
          batch.push(shot(prng.uuid(), permit.permitId));
        }
        const lane = (
          await burst(
            sql,
            `PGS4-${n}`,
            0,
            1,
            () => uid,
            () => batch,
          )
        )[0];
        rows.push(lane);
        const rpcMs = lane.rpc.map((x) => x.ms);
        const roundTrips = 1 + lane.rpc.length;
        inv(
          `batch ${n}: all accepted, round trips = ${1 + n}`,
          lane.rpc.every((x) => x.result === "accepted") && roundTrips === 1 + n,
          `roundTrips=${roundTrips} verdicts=${JSON.stringify(histogram(lane.rpc.map((x) => x.result)))}`,
        );
        table.push({
          batch: n,
          postgrestRoundTrips: roundTrips,
          rpcLatencyMs: summarize(rpcMs),
          batchServerMs: Math.round((lane.serverEndMs - lane.serverStartMs) * 100) / 100,
          batchClientMs: lane.clientMs,
        });
      }
      const state = await ownerState(sql, uid);
      inv(
        "owner state: 259 rows, 259 finalized permits",
        state.shots === 259 && state.permits.join() === "finalized/scored=259",
        JSON.stringify(state),
      );
      obs.table = table;
      obs.note =
        "local docker postgres:16 over loopback; hosted PostgREST adds an HTTP hop per round trip";
    });
    assertHeld(result);
  },
});

Deno.test({
  name: "stress PG: write pg.json",
  ignore,
  async fn() {
    const path = await writeArtifact("pg.json", {
      suite: "stress_shots_sync_pg",
      seed: STRESS_SEED,
      lanes: LANES,
      rounds: ROUNDS,
      scenarios: results.length,
      lanesExecuted: results.reduce((n, r) => n + r.rows.length, 0),
      rpcCalls,
      held: results.flatMap((r) => r.invariants).filter((i) => i.holds).length,
      broken: results.flatMap((r) =>
        r.invariants
          .filter((i) => !i.holds)
          .map((i) => ({ scenario: r.scenario, ...i, replayCommand: r.replayCommand })),
      ),
      results,
    });
    console.log(`[stress pg] ${results.length} scenarios, ${rpcCalls} RPC calls → ${path}`);
  },
});
