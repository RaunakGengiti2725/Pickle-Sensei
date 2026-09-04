/**
 * xc-matrix-concurrency-edge — DIRECT Postgres half of the matrix.
 *
 * The in-process edge matrix (xc_edge_concurrency_matrix.test.ts) proves the
 * handler's behaviour over a *modelled* database. This file drives the REAL
 * RPCs — reserve_analysis_permit(text), apply_synced_shot(jsonb),
 * access_state(), lifetime_scored_count(), the free_rating_ledger trigger —
 * on a disposable postgres:16 with shim_auth.sql + every migration applied
 * (./xc_pg_up.sh), using N INDEPENDENT connections, each in its own
 * transaction as role `authenticated` with the caller's JWT sub, released
 * from a barrier so the per-user advisory xact locks genuinely contend.
 *
 *   ./xc_pg_up.sh                      # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     XC_OUT_DIR=/tmp/xc-pg/ deno test -A --no-check --config deno.json xc_pg_rpc_concurrency.test.ts
 *
 * Without XC_PG_URL (alias: PICKLE_AUDIT_PG_URL) every test is `ignore`d — and
 * an ignored run is NOT a pass; the coordinator report records it as UNKNOWN.
 *
 * Every scenario writes <XC_OUT_DIR>/<scenario>.json (inputs, per-lane rows
 * with server-side clock_timestamp() start/end so overlap is provable,
 * invariants, counters, heap, replay command). Seeded: XC_SEED drives every
 * user id / key / shot id; a failure replays with the printed command.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  envInt,
  histogram,
  type Invariant,
  Prng,
  type ScenarioReport,
  writeReport,
  XC_ROUNDS,
  XC_SEED,
} from "./xc_concurrency_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = envInt("XC_PG_LANES", 16);

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

interface LaneRow {
  round: number;
  lane: number;
  op: string;
  result: string;
  permitId?: string;
  /** server clock_timestamp() at RPC start / end (ms since epoch) */
  serverStartMs: number;
  serverEndMs: number;
  clientMs: number;
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
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

/** A barrier: every lane awaits `gate` after its transaction is open and its
 * role/sub are set, so the RPCs are issued from N concurrently-open
 * transactions (advisory xact locks then serialize them for real). */
function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

/** Seeded ids repeat across runs against the same disposable DB, so setup
 * first removes what an earlier run with this seed left behind (the user
 * cascade, and — because it survives deletion BY DESIGN — the identity's
 * ledger row). Owner-role setup only; PG6 exercises the ledger's survival
 * through a real cascade without touching this path. */
async function createUser(
  sql: Sql,
  userId: string,
  identity?: { provider: string; sub: string },
  opts: { keepLedger?: boolean } = {},
) {
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

/** Run `fn` on `lanes` independent connections; each lane opens a tx, sets
 * the caller, waits at the barrier, then runs fn and COMMITs (so lanes see
 * each other's outcomes — the property under test). */
async function burst(
  sql: Sql,
  lanes: number,
  userIdFor: (lane: number) => string,
  fn: (tx: Tx, lane: number) => Promise<Omit<LaneRow, "round" | "lane" | "clientMs">>,
  round: number,
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
        const t0 = performance.now();
        const out = await fn(tx as unknown as Tx, lane);
        rows.push({
          round,
          lane,
          clientMs: Math.round((performance.now() - t0) * 100) / 100,
          ...out,
        });
      }),
    ),
  );
  // Wait until every lane holds an open transaction before firing.
  while (ready < lanes) await new Promise((r) => setTimeout(r, 1));
  b.open();
  await all;
  rows.sort((a, b) => a.lane - b.lane);
  return rows;
}

/** Server clock (ms since epoch) read inside the lane's own transaction —
 * separate statements before/after the RPC so the window brackets the call
 * (a single select list would evaluate both clock_timestamp() calls after a
 * set-returning FROM item and report a zero-length window). */
async function serverNowMs(tx: Tx): Promise<number> {
  const r = await tx.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

async function reserveRpc(tx: Tx, key: string, op: string) {
  const t0 = await serverNowMs(tx);
  const r = await tx.unsafe(
    `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
  );
  const t1 = await serverNowMs(tx);
  return {
    op,
    result: String(r[0].result),
    permitId: r[0].permit_id ? String(r[0].permit_id) : undefined,
    serverStartMs: t0,
    serverEndMs: t1,
  };
}

async function applyRpc(tx: Tx, shot: Record<string, unknown>, op: string) {
  const t0 = await serverNowMs(tx);
  const r = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as result`, [
    JSON.stringify(shot),
  ]);
  const t1 = await serverNowMs(tx);
  return {
    op,
    result: String(r[0].result),
    serverStartMs: t0,
    serverEndMs: t1,
  };
}

async function accessState(sql: Sql, userId: string) {
  let out: { premium: boolean; scored_count: number; reserved_count: number } | undefined;
  await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
    const r = await tx.unsafe(
      `select premium, scored_count, reserved_count from public.access_state()`,
    );
    out = {
      premium: Boolean(r[0].premium),
      scored_count: Number(r[0].scored_count),
      reserved_count: Number(r[0].reserved_count),
    };
  });
  return out!;
}

async function ownerCounts(sql: Sql, userId: string) {
  const shots = await sql.unsafe(
    `select count(*)::int as n, count(*) filter (where result_kind = 'scored')::int as scored from public.shots where user_id = '${userId}'`,
  );
  const permits = await sql.unsafe(
    `select status, coalesce(outcome, '') as outcome, count(*)::int as n from public.analysis_permits where user_id = '${userId}' group by 1, 2 order by 1, 2`,
  );
  const ledger = await sql.unsafe(
    `select l.scored_count from public.free_rating_ledger l
       join auth.identities i on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
      where i.user_id = '${userId}'`,
  );
  return {
    shots: Number(shots[0].n),
    scoredShots: Number(shots[0].scored),
    permits: permits.map((p) => `${p.status}/${p.outcome}=${p.n}`),
    ledger: ledger.map((l) => Number(l.scored_count)),
  };
}

/** Lanes whose server-side windows overlapped at least one other lane. */
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

function inv(invariants: Invariant[], name: string, holds: boolean, detail: string) {
  invariants.push({ name, holds, detail });
}

function replay(filter: string): string {
  return `XC_PG_URL=<from ./xc_pg_up.sh> XC_SEED=${XC_SEED} XC_PG_LANES=${LANES} XC_ROUNDS=${XC_ROUNDS} deno test -A --no-check --config deno.json xc_pg_rpc_concurrency.test.ts --filter "${filter}"`;
}

async function scenario(
  name: string,
  label: string,
  run: (
    sql: Sql,
    prng: Prng,
    rows: LaneRow[],
    invariants: Invariant[],
    inputs: Record<string, unknown>,
    observations: Record<string, unknown>,
  ) => Promise<void>,
): Promise<ScenarioReport> {
  const sql = postgres(PG_URL, { max: LANES + 2 });
  const prng = new Prng((XC_SEED ^ fnv1a(name)) >>> 0);
  const rows: LaneRow[] = [];
  const invariants: Invariant[] = [];
  const inputs: Record<string, unknown> = {};
  const observations: Record<string, unknown> = {};
  const heapBefore = Deno.memoryUsage();
  const t0 = performance.now();
  try {
    await run(sql, prng, rows, invariants, inputs, observations);
  } finally {
    await sql.end();
  }
  const report: ScenarioReport = {
    scenario: name,
    label,
    seed: XC_SEED,
    scale: { lanes: LANES, rounds: XC_ROUNDS },
    inputs,
    statusHistogram: histogram(rows.map((r) => `${r.op}:${r.result}`)),
    counters: {
      lanesOverlappingAnotherLane: overlapCount(rows),
      rows: rows.length,
    },
    invariants,
    observations,
    timeline: rows.map((r) => ({
      t: r.serverStartMs,
      op: r.op,
      detail: `round=${r.round} lane=${r.lane} → ${r.result}`,
    })),
    requests: rows as unknown as Array<Record<string, unknown>>,
    durationMs: Math.round(performance.now() - t0),
    heap: { before: heapBefore, after: Deno.memoryUsage() },
    replay: replay(label),
  };
  const path = await writeReport(report);
  console.log(
    `[xc-pg] ${name}: ${report.durationMs}ms rss=${report.heap.after.rss} heapUsed=${report.heap.after.heapUsed} → ${path}`,
  );
  for (const i of invariants) {
    if (!i.holds) console.log(`[xc-pg]   BROKEN ${i.name} — ${i.detail}`);
  }
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// PG1 — same idempotency key from N concurrent transactions
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "xc PG1: reserve_analysis_permit same key ×N concurrent transactions — all accepted, ONE permit id, ONE row",
  ignore,
  async fn() {
    const report = await scenario(
      "pg1_same_key_reserve",
      "xc PG1",
      async (sql, prng, rows, invariants, inputs) => {
        const users: string[] = [];
        for (let r = 0; r < XC_ROUNDS; r++) {
          const uid = prng.uuid();
          users.push(uid);
          await createUser(sql, uid);
          const key = `same-${r}-${prng.uuid()}`;
          const out = await burst(
            sql,
            LANES,
            () => uid,
            (tx) => reserveRpc(tx, key, "reserve.sameKey"),
            r,
          );
          rows.push(...out);
          const ids = new Set(out.map((x) => x.permitId));
          const counts = await ownerCounts(sql, uid);
          inv(
            invariants,
            `round ${r}: all ${LANES} lanes accepted`,
            out.every((x) => x.result === "accepted"),
            JSON.stringify(histogram(out.map((x) => x.result))),
          );
          inv(
            invariants,
            `round ${r}: one permit id, one row`,
            ids.size === 1 && counts.permits.join() === "reserved/=1",
            `ids=${ids.size} permits=${counts.permits.join(",")}`,
          );
        }
        inputs.users = users;
      },
    );
    inv(
      report.invariants,
      "lanes genuinely overlapped",
      report.counters.lanesOverlappingAnotherLane > 0,
      `${report.counters.lanesOverlappingAnotherLane}/${report.counters.rows}`,
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PG2 — N different keys, free account: never more than two reservations
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "xc PG2: reserve_analysis_permit different keys ×N concurrent — exactly 2 accepted, rest access.paywall_required, 2 rows",
  ignore,
  async fn() {
    const report = await scenario(
      "pg2_diff_key_free_limit",
      "xc PG2",
      async (sql, prng, rows, invariants, inputs) => {
        const users: string[] = [];
        for (let r = 0; r < XC_ROUNDS; r++) {
          const uid = prng.uuid();
          users.push(uid);
          await createUser(sql, uid, { provider: "google", sub: `g-${uid}` });
          const keys = Array.from({ length: LANES }, (_, i) => `diff-${r}-${i}-${prng.uuid()}`);
          const out = await burst(
            sql,
            LANES,
            () => uid,
            (tx, lane) => reserveRpc(tx, keys[lane], "reserve.diffKey"),
            r,
          );
          rows.push(...out);
          const h = histogram(out.map((x) => x.result));
          const counts = await ownerCounts(sql, uid);
          const access = await accessState(sql, uid);
          inv(
            invariants,
            `round ${r}: exactly 2 accepted + ${LANES - 2} paywall`,
            h.accepted === 2 &&
              h["access.paywall_required"] === LANES - 2 &&
              Object.keys(h).length === 2,
            JSON.stringify(h),
          );
          inv(
            invariants,
            `round ${r}: exactly 2 reserved rows; access_state reserved=2 scored=0`,
            counts.permits.join() === "reserved/=2" &&
              access.reserved_count === 2 &&
              access.scored_count === 0,
            `permits=${counts.permits.join(",")} access=${JSON.stringify(access)}`,
          );
        }
        inputs.users = users;
      },
    );
    inv(
      report.invariants,
      "lanes genuinely overlapped",
      report.counters.lanesOverlappingAnotherLane > 0,
      `${report.counters.lanesOverlappingAnotherLane}/${report.counters.rows}`,
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PG3 — the SAME shot id applied from N concurrent transactions
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "xc PG3: apply_synced_shot same shot id ×N concurrent — one row, permit finalized once, one rating spent; every lane accepted (idempotent replay)",
  ignore,
  async fn() {
    const report = await scenario(
      "pg3_same_shot_apply",
      "xc PG3",
      async (sql, prng, rows, invariants, inputs, observations) => {
        const users: string[] = [];
        const loserCodes: string[] = [];
        for (let r = 0; r < XC_ROUNDS; r++) {
          const uid = prng.uuid();
          users.push(uid);
          await createUser(sql, uid, { provider: "apple", sub: `a-${uid}` });
          let permitId = "";
          await sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, uid);
            const res = await reserveRpc(
              tx as unknown as Tx,
              `p-${r}-${prng.uuid()}`,
              "reserve.setup",
            );
            assertEquals(res.result, "accepted");
            permitId = res.permitId!;
          });
          const shotId = prng.uuid();
          const payload = shotPayload(shotId, permitId);
          const out = await burst(
            sql,
            LANES,
            () => uid,
            (tx) => applyRpc(tx, payload, "apply.sameShot"),
            r,
          );
          rows.push(...out);
          const h = histogram(out.map((x) => x.result));
          const counts = await ownerCounts(sql, uid);
          const access = await accessState(sql, uid);
          for (const x of out) {
            if (x.result !== "accepted") loserCodes.push(x.result);
          }
          inv(
            invariants,
            `round ${r}: exactly one shot row, one finalized permit, scored_count=1, ledger=1`,
            counts.shots === 1 &&
              counts.scoredShots === 1 &&
              counts.permits.join() === "finalized/scored=1" &&
              access.scored_count === 1 &&
              counts.ledger.join() === "1",
            `shots=${counts.shots} permits=${counts.permits.join(",")} access=${JSON.stringify(
              access,
            )} ledger=${counts.ledger}`,
          );
          inv(
            invariants,
            `round ${r}: at least one lane accepted; no lane 'shot.write_failed' / 'shot.id_conflict'`,
            (h.accepted ?? 0) >= 1 && !Object.keys(h).some((k) => k.startsWith("shot.")),
            JSON.stringify(h),
          );
          // Idempotency contract: the server holds this user's row for this
          // shot id, so EVERY copy of the sync is an accepted replay. A copy
          // that serialized behind the winner on the advisory lock must not
          // be told a permanent verdict (access.permit_not_reserved) that the
          // mobile outbox treats as a contract rejection and burns an attempt
          // on — the RPC re-checks ownership after taking the lock.
          inv(
            invariants,
            `round ${r}: every lane accepted (loser of the same-shot race replays as accepted)`,
            (h.accepted ?? 0) === LANES,
            JSON.stringify(h),
          );
        }
        inputs.users = users;
        observations.loserVerdicts = histogram(loserCodes);
      },
    );
    inv(
      report.invariants,
      "lanes genuinely overlapped",
      report.counters.lanesOverlappingAnotherLane > 0,
      `${report.counters.lanesOverlappingAnotherLane}/${report.counters.rows}`,
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PG4 — over-issued permits: N reserved permits, N concurrent scored shots
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "xc PG4: free-limit backstop — N legacy-reserved permits, N concurrent DISTINCT scored shots → exactly 2 accepted, rest access.paywall_required + released",
  ignore,
  async fn() {
    const report = await scenario(
      "pg4_backstop_over_issued_permits",
      "xc PG4",
      async (sql, prng, rows, invariants, inputs) => {
        const users: string[] = [];
        for (let r = 0; r < XC_ROUNDS; r++) {
          const uid = prng.uuid();
          users.push(uid);
          await createUser(sql, uid, { provider: "google", sub: `g-${uid}` });
          // Over-issue as the table owner (what pre-reserve_analysis_permit builds could do).
          const permitIds: string[] = [];
          for (let i = 0; i < LANES; i++) {
            const ins = await sql.unsafe(
              `insert into public.analysis_permits (user_id, idempotency_key) values ('${uid}', 'legacy-${r}-${i}') returning id::text as id`,
            );
            permitIds.push(String(ins[0].id));
          }
          const shotIds = Array.from({ length: LANES }, () => prng.uuid());
          const out = await burst(
            sql,
            LANES,
            () => uid,
            (tx, lane) =>
              applyRpc(tx, shotPayload(shotIds[lane], permitIds[lane]), "apply.distinctShot"),
            r,
          );
          rows.push(...out);
          const h = histogram(out.map((x) => x.result));
          const counts = await ownerCounts(sql, uid);
          const access = await accessState(sql, uid);
          inv(
            invariants,
            `round ${r}: exactly 2 accepted, ${LANES - 2} access.paywall_required`,
            h.accepted === 2 &&
              h["access.paywall_required"] === LANES - 2 &&
              Object.keys(h).length === 2,
            JSON.stringify(h),
          );
          inv(
            invariants,
            `round ${r}: 2 scored shots, 2 finalized + ${
              LANES - 2
            } released/free_limit_exceeded permits, scored_count=2, ledger=2`,
            counts.scoredShots === 2 &&
              counts.permits.join(",") ===
                `finalized/scored=2,released/free_limit_exceeded=${LANES - 2}` &&
              access.scored_count === 2 &&
              access.reserved_count === 0 &&
              counts.ledger.join() === "2",
            `shots=${counts.scoredShots} permits=${counts.permits.join(
              ",",
            )} access=${JSON.stringify(access)} ledger=${counts.ledger}`,
          );
        }
        inputs.users = users;
      },
    );
    inv(
      report.invariants,
      "lanes genuinely overlapped",
      report.counters.lanesOverlappingAnotherLane > 0,
      `${report.counters.lanesOverlappingAnotherLane}/${report.counters.rows}`,
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PG5 — reserve racing apply: 1 scored + 1 reserved; apply the reserved permit
//       WHILE N-1 lanes try to reserve new keys
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "xc PG5: reserve_analysis_permit racing apply_synced_shot on the last free rating — no third reservation in either ordering",
  ignore,
  async fn() {
    const report = await scenario(
      "pg5_reserve_vs_apply_race",
      "xc PG5",
      async (sql, prng, rows, invariants, inputs) => {
        const users: string[] = [];
        for (let r = 0; r < XC_ROUNDS; r++) {
          const uid = prng.uuid();
          users.push(uid);
          await createUser(sql, uid, { provider: "google", sub: `g-${uid}` });
          // Spend rating #1, reserve permit #2.
          let p2 = "";
          await sql.begin(async (tx) => {
            const t = tx as unknown as Tx;
            await asUser(t, uid);
            const p1 = await reserveRpc(t, `p1-${r}`, "setup");
            assertEquals(p1.result, "accepted");
            assertEquals(
              (await applyRpc(t, shotPayload(prng.uuid(), p1.permitId!), "setup")).result,
              "accepted",
            );
            const res = await reserveRpc(t, `p2-${r}`, "setup");
            assertEquals(res.result, "accepted");
            p2 = res.permitId!;
          });
          const shotId = prng.uuid();
          const keys = Array.from({ length: LANES }, (_, i) => `race-${r}-${i}-${prng.uuid()}`);
          const out = await burst(
            sql,
            LANES,
            () => uid,
            (tx, lane) =>
              lane === 0
                ? applyRpc(tx, shotPayload(shotId, p2), "apply.lastRating")
                : reserveRpc(tx, keys[lane], "reserve.duringApply"),
            r,
          );
          rows.push(...out);
          const applyRes = out.find((x) => x.op === "apply.lastRating")!;
          const reserves = out.filter((x) => x.op === "reserve.duringApply");
          const counts = await ownerCounts(sql, uid);
          const access = await accessState(sql, uid);
          inv(
            invariants,
            `round ${r}: apply accepted; every concurrent reserve paywalled`,
            applyRes.result === "accepted" &&
              reserves.every((x) => x.result === "access.paywall_required"),
            `apply=${applyRes.result} reserves=${JSON.stringify(
              histogram(reserves.map((x) => x.result)),
            )}`,
          );
          inv(
            invariants,
            `round ${r}: scored=2, reserved=0, exactly 2 finalized permits`,
            access.scored_count === 2 &&
              access.reserved_count === 0 &&
              counts.permits.join() === "finalized/scored=2",
            `access=${JSON.stringify(access)} permits=${counts.permits.join(",")}`,
          );
        }
        inputs.users = users;
      },
    );
    inv(
      report.invariants,
      "lanes genuinely overlapped",
      report.counters.lanesOverlappingAnotherLane > 0,
      `${report.counters.lanesOverlappingAnotherLane}/${report.counters.rows}`,
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PG6 — identity ledger survives account deletion; re-created account's
//       concurrent reservations are all paywalled
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "xc PG6: identity ledger — spend 2, delete account, re-create with the same provider subject → N concurrent reserves all paywalled, scored_count=2",
  ignore,
  async fn() {
    const report = await scenario(
      "pg6_identity_ledger_recreate",
      "xc PG6",
      async (sql, prng, rows, invariants, inputs) => {
        const pairs: Array<{ old: string; next: string; sub: string }> = [];
        for (let r = 0; r < XC_ROUNDS; r++) {
          const sub = `apple-sub-${r}-${prng.uuid()}`;
          const oldUid = prng.uuid();
          await createUser(sql, oldUid, { provider: "apple", sub });
          await sql.begin(async (tx) => {
            const t = tx as unknown as Tx;
            await asUser(t, oldUid);
            for (let i = 0; i < 2; i++) {
              const p = await reserveRpc(t, `spend-${r}-${i}`, "setup");
              assertEquals(p.result, "accepted");
              assertEquals(
                (await applyRpc(t, shotPayload(prng.uuid(), p.permitId!), "setup")).result,
                "accepted",
              );
            }
          });
          const before = await ownerCounts(sql, oldUid);
          // Account deletion: auth.users cascade (identities, profiles, shots, permits all go).
          await sql.unsafe(`delete from auth.users where id = '${oldUid}'`);
          const newUid = prng.uuid();
          await createUser(
            sql,
            newUid,
            { provider: "apple", sub },
            {
              keepLedger: true,
            },
          );
          pairs.push({ old: oldUid, next: newUid, sub });
          const out = await burst(
            sql,
            LANES,
            () => newUid,
            (tx, lane) => reserveRpc(tx, `recreated-${r}-${lane}`, "reserve.recreatedAccount"),
            r,
          );
          rows.push(...out);
          const h = histogram(out.map((x) => x.result));
          const after = await ownerCounts(sql, newUid);
          const access = await accessState(sql, newUid);
          inv(
            invariants,
            `round ${r}: old account had 2 scored + ledger 2 before deletion`,
            before.scoredShots === 2 && before.ledger.join() === "2",
            JSON.stringify(before),
          );
          inv(
            invariants,
            `round ${r}: recreated account — every concurrent reserve paywalled, 0 rows, access scored_count=2`,
            h["access.paywall_required"] === LANES &&
              after.permits.length === 0 &&
              access.scored_count === 2 &&
              after.ledger.join() === "2",
            `${JSON.stringify(h)} permits=${after.permits.join(",")} access=${JSON.stringify(
              access,
            )} ledger=${after.ledger}`,
          );
        }
        inputs.accounts = pairs;
      },
    );
    inv(
      report.invariants,
      "lanes genuinely overlapped",
      report.counters.lanesOverlappingAnotherLane > 0,
      `${report.counters.lanesOverlappingAnotherLane}/${report.counters.rows}`,
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PG7 — grant-surface probe (not concurrency): the client role may NOT write a
//       scored shot WITHOUT a permit by inserting into public.shots directly.
//       Contract: 20260905000000_scored_shot_write_gate.sql (DB-01) — the
//       BEFORE INSERT trigger enforce_scored_shot_permit() refuses a scored row
//       from a client session that has no live reserved permit (42501), so the
//       free-rating rule no longer lives only in the RPCs. TRUNCATE/TRIGGER
//       grants are recorded as observations (they come from the hosted-like
//       default privileges and are not reachable through PostgREST).
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "xc PG7: role authenticated cannot INSERT a scored shot into public.shots directly (no permit, no RPC) — the table-layer permit gate refuses it, scored_count stays 0, no ledger row",
  ignore,
  async fn() {
    const report = await scenario(
      "pg7_direct_insert_grant_probe",
      "xc PG7",
      async (sql, prng, rows, invariants, inputs, observations) => {
        const uid = prng.uuid();
        await createUser(sql, uid, { provider: "google", sub: `g-${uid}` });
        inputs.user = uid;
        const results: string[] = [];
        for (let i = 0; i < 3; i++) {
          const id = prng.uuid();
          let result = "inserted";
          try {
            await sql.begin(async (tx) => {
              const t = tx as unknown as Tx;
              await asUser(t, uid);
              const t0 = performance.now();
              await t.unsafe(
                `insert into public.shots (
                 id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
                 app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version,
                 phase_model_version, scoring_model_version, shot_config_version
               ) values ('${id}', '${uid}', 'drive', now(), 0, 1000, 5.5, 0.9, 'scored',
                 '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1')`,
              );
              rows.push({
                round: 0,
                lane: i,
                op: "shots.insert.direct",
                result,
                serverStartMs: 0,
                serverEndMs: 0,
                clientMs: Math.round((performance.now() - t0) * 100) / 100,
              });
            });
          } catch (error) {
            result = `denied: ${error instanceof Error ? error.message : String(error)}`;
            rows.push({
              round: 0,
              lane: i,
              op: "shots.insert.direct",
              result,
              serverStartMs: 0,
              serverEndMs: 0,
              clientMs: 0,
            });
          }
          results.push(result);
        }
        const counts = await ownerCounts(sql, uid);
        const access = await accessState(sql, uid);
        const grants = await sql.unsafe(
          `select privilege_type from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'public' and table_name = 'shots' order by 1`,
        );
        // TRUNCATE is not subject to RLS. Probe it inside a transaction that is
        // always rolled back, so the disposable DB is left as it was.
        let truncate = "not attempted";
        const totalBefore = Number(
          (await sql.unsafe(`select count(*)::int as n from public.shots`))[0].n,
        );
        try {
          await sql.begin(async (tx) => {
            const t = tx as unknown as Tx;
            await asUser(t, uid);
            await t.unsafe(`truncate public.shots cascade`);
            await t.unsafe(`reset role`);
            const n = Number((await t.unsafe(`select count(*)::int as n from public.shots`))[0].n);
            truncate = `succeeded: ${totalBefore} rows (all users) → ${n}; rolled back`;
            throw new Error("xc-rollback");
          });
        } catch (error) {
          if (!(error instanceof Error && error.message === "xc-rollback")) {
            truncate = `denied: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        const totalAfter = Number(
          (await sql.unsafe(`select count(*)::int as n from public.shots`))[0].n,
        );
        assertEquals(totalAfter, totalBefore, "truncate probe must have been rolled back");
        observations.results = results;
        observations.grantsOnShotsForAuthenticated = grants.map((g) => String(g.privilege_type));
        observations.truncateAsAuthenticated = truncate;
        observations.counts = counts;
        observations.access = access;
        observations.reachability =
          "UNKNOWN from this harness: requires a PostgREST call with the project's publishable (anon) key + the user's session JWT; the mobile bundle does not embed the anon key (INFERRED from apps/mobile/src/config/runtimeConfig.ts).";
        inv(
          invariants,
          "3 direct scored inserts with zero permits are all denied by the permit gate; scored_count=0, no ledger row",
          results.every(
            (x) =>
              x.startsWith("denied:") && x.includes("requires a live reserved analysis permit"),
          ) &&
            counts.shots === 0 &&
            counts.scoredShots === 0 &&
            access.scored_count === 0 &&
            counts.ledger.length === 0,
          `results=${JSON.stringify(results)} counts=${JSON.stringify(
            counts,
          )} access=${JSON.stringify(access)}`,
        );
      },
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Matrix roll-up
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "xc-pg: write matrix.json",
  ignore,
  async fn() {
    const { outDir } = await import("./xc_concurrency_harness.ts");
    const dir = outDir();
    const scenarios: Array<Record<string, unknown>> = [];
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.startsWith("pg") || !e.name.endsWith(".json")) {
        continue;
      }
      const r = JSON.parse(await Deno.readTextFile(`${dir}${e.name}`)) as ScenarioReport;
      scenarios.push({
        scenario: r.scenario,
        label: r.label,
        seed: r.seed,
        scale: r.scale,
        durationMs: r.durationMs,
        statusHistogram: r.statusHistogram,
        counters: r.counters,
        invariants: {
          total: r.invariants.length,
          broken: r.invariants.filter((i) => !i.holds).map((i) => i.name),
        },
        heapUsedAfter: r.heap.after.heapUsed,
        rssAfter: r.heap.after.rss,
        replay: r.replay,
      });
    }
    scenarios.sort((a, b) => String(a.scenario).localeCompare(String(b.scenario)));
    assert(scenarios.length >= 7, `expected ≥7 pg scenario reports, found ${scenarios.length}`);
    const path = `${dir}matrix_pg.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          deno: Deno.version,
          env: { XC_SEED, XC_PG_LANES: LANES, XC_ROUNDS },
          scenarios,
        },
        null,
        2,
      ),
    );
    console.log(`[xc-pg] matrix → ${path}`);
  },
});
