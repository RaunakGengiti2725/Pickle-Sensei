/**
 * stress: permit release/consume — REAL Postgres half.
 *
 * The finalize route (supabase/functions/api/index.ts finalizeAnalysisPermitRoute)
 * does not call an RPC; it issues, as the `authenticated` role under RLS:
 *
 *   SELECT id,status,outcome,created_at FROM analysis_permits WHERE id=$1 AND user_id=$2
 *   UPDATE analysis_permits SET status='finalized', outcome=$3
 *     WHERE id=$1 AND user_id=$2 AND status='reserved' RETURNING id,status,outcome,created_at
 *   SELECT … (re-read when the UPDATE matched 0 rows)
 *
 * while the consume path (POST /v1/shots:sync) calls apply_synced_shot(jsonb),
 * which takes the per-user advisory lock and `SELECT … FOR UPDATE`s the same
 * row. This file drives EXACTLY those statements from N independent
 * connections, each in its own transaction as `authenticated` with the
 * caller's JWT sub, released together from a barrier, on a disposable
 * postgres:16 with shim_auth.sql + every migration applied:
 *
 *   ./xc_pg_up.sh                                  # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *   STRESS_PG_ROUNDS=8 STRESS_PG_LANES=12 XC_OUT_DIR=/tmp/stress-pg/ \
 *     deno test -A --no-check --config deno.json stress_permit_release_pg.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass. Never points at a hosted project.
 *
 * Seeded (STRESS_SEED): every user id / key / shot id / lane outcome comes
 * from the PRNG; a failing scenario replays with the printed command.
 */
import postgres from "postgres";
import { assert } from "@std/assert";
import {
  envInt,
  histogram,
  type Invariant,
  Prng,
  type ScenarioReport,
  writeReport,
} from "./xc_concurrency_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = envInt("STRESS_PG_LANES", 12);
const ROUNDS = envInt("STRESS_PG_ROUNDS", 3);
const SEED = envInt("STRESS_SEED", 20260904);
/** Per-round wall-time bound: a lane still blocked after this is a deadlock. */
const TIMEOUT_MS = envInt("STRESS_TIMEOUT_MS", 20_000);

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const RELEASABLE = [
  "low_confidence",
  "cancelled",
  "failed",
  "unsupported",
  "incorrect_recognition",
] as const;
const PERMIT_COLUMNS = "id, status, outcome, created_at";

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

function shotPayload(
  id: string,
  analysisPermitId: string,
  overrides: Record<string, unknown> = {},
) {
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

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

interface LaneRow {
  round: number;
  lane: number;
  op: string;
  result: string;
  detail?: string;
  serverStartMs: number;
  serverEndMs: number;
  clientMs: number;
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

async function createUser(sql: Sql, userId: string, identity: { provider: string; sub: string }) {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `delete from auth.users u using auth.identities i
      where i.user_id = u.id and i.provider = '${identity.provider}' and i.provider_id = '${identity.sub}'`,
  );
  await sql.unsafe(
    `delete from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('${identity.provider}', '${identity.sub}')`,
  );
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('${identity.provider}', '${identity.sub}', '${userId}', '{"sub":"${identity.sub}"}')`,
  );
}

async function serverNowMs(tx: Tx): Promise<number> {
  const r = await tx.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

/** Owner-side reservation through the real RPC (what POST /v1/analysis-permits does). */
async function reserveAs(
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

/** The route's statements, verbatim in shape. Returns what the route would
 * have decided: 200 (matched or settled-same), 409 (settled-other), 404. */
async function releaseLikeRoute(
  tx: Tx,
  permitId: string,
  userId: string,
  outcome: string,
  op: string,
) {
  const t0 = await serverNowMs(tx);
  const found = await tx.unsafe(
    `select ${PERMIT_COLUMNS} from public.analysis_permits where id = '${permitId}' and user_id = '${userId}'`,
  );
  let result: string;
  let detail: string;
  if (found.length === 0) {
    result = "404";
    detail = "not_found";
  } else if (found[0].status !== "reserved") {
    result = found[0].outcome === outcome ? "200.pre" : "409.pre";
    detail = `pre=${found[0].status}/${found[0].outcome}`;
  } else {
    const updated = await tx.unsafe(
      `update public.analysis_permits set status = 'finalized', outcome = '${outcome}'
        where id = '${permitId}' and user_id = '${userId}' and status = 'reserved'
        returning ${PERMIT_COLUMNS}`,
    );
    if (updated.length === 1) {
      result = "200.won";
      detail = `won=${updated[0].status}/${updated[0].outcome}`;
    } else if (updated.length === 0) {
      const settled = await tx.unsafe(
        `select ${PERMIT_COLUMNS} from public.analysis_permits where id = '${permitId}' and user_id = '${userId}'`,
      );
      const row = settled[0];
      result = row && row.outcome === outcome ? "200.settled" : "409.settled";
      detail = `settled=${row?.status}/${row?.outcome}`;
    } else {
      result = "5xx.multi";
      detail = `updated ${updated.length} rows`;
    }
  }
  const t1 = await serverNowMs(tx);
  return { op, result, detail: `${outcome} ${detail}`, serverStartMs: t0, serverEndMs: t1 };
}

async function applyRpc(tx: Tx, shot: Record<string, unknown>, op: string) {
  const t0 = await serverNowMs(tx);
  const r = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as result`, [
    JSON.stringify(shot),
  ]);
  const t1 = await serverNowMs(tx);
  return { op, result: String(r[0].result), serverStartMs: t0, serverEndMs: t1 };
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
    detail: r[0].permit_id ? String(r[0].permit_id) : "",
    serverStartMs: t0,
    serverEndMs: t1,
  };
}

/** The pg_cron statement from 20260831000000_scale_and_security.sql, run as the owner. */
async function sweepRpc(tx: Tx, op: string) {
  const t0 = await serverNowMs(tx);
  const r = await tx.unsafe(
    `with u as (update public.analysis_permits set status = 'released', outcome = 'expired'
       where status = 'reserved' and created_at < now() - interval '24 hours' returning 1)
     select count(*)::int as n from u`,
  );
  const t1 = await serverNowMs(tx);
  return { op, result: `swept.${r[0].n}`, serverStartMs: t0, serverEndMs: t1 };
}

interface Lane {
  userId: string | null; // null → owner (postgres) — used only for the cron sweep lane
  run: (tx: Tx) => Promise<Omit<LaneRow, "round" | "lane" | "clientMs">>;
}

/** Every lane opens its own transaction (own connection), sets its caller,
 * waits at the barrier, runs, COMMITs. Bounded by TIMEOUT_MS. */
async function burst(
  sql: Sql,
  lanes: Lane[],
  round: number,
): Promise<{ rows: LaneRow[]; timedOut: boolean }> {
  const b = barrier();
  let ready = 0;
  const rows: LaneRow[] = [];
  const all = Promise.all(
    lanes.map((lane, i) =>
      sql.begin(async (tx) => {
        if (lane.userId) await asUser(tx as unknown as Tx, lane.userId);
        ready += 1;
        await b.gate;
        const t0 = performance.now();
        const out = await lane.run(tx as unknown as Tx);
        rows.push({
          round,
          lane: i,
          clientMs: Math.round((performance.now() - t0) * 100) / 100,
          ...out,
        });
      }),
    ),
  );
  while (ready < lanes.length) await new Promise((r) => setTimeout(r, 1));
  b.open();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), TIMEOUT_MS);
  });
  const outcome = await Promise.race([all.then(() => "done" as const), guard]);
  if (timer !== undefined) clearTimeout(timer);
  rows.sort((a, b) => a.lane - b.lane);
  return { rows, timedOut: outcome === "timeout" };
}

async function permitState(sql: Sql, permitId: string) {
  const r = await sql.unsafe(
    `select status, coalesce(outcome, '') as outcome, user_id::text as user_id from public.analysis_permits where id = '${permitId}'`,
  );
  return r[0]
    ? { status: String(r[0].status), outcome: String(r[0].outcome), userId: String(r[0].user_id) }
    : null;
}

async function ownerCounts(sql: Sql, userId: string) {
  const shots = await sql.unsafe(
    `select count(*)::int as n, count(*) filter (where result_kind = 'scored')::int as scored from public.shots where user_id = '${userId}'`,
  );
  const permits = await sql.unsafe(
    `select status, coalesce(outcome, '') as outcome, count(*)::int as n from public.analysis_permits where user_id = '${userId}' group by 1, 2 order by 1, 2`,
  );
  const live = await sql.unsafe(
    `select count(*)::int as n from public.analysis_permits where user_id = '${userId}' and status = 'reserved' and created_at > now() - interval '24 hours'`,
  );
  return {
    shots: Number(shots[0].n),
    scoredShots: Number(shots[0].scored),
    permits: permits.map((p) => `${p.status}/${p.outcome}=${p.n}`),
    liveReserved: Number(live[0].n),
  };
}

async function accessState(sql: Sql, userId: string) {
  let out = { premium: false, scored_count: -1, reserved_count: -1 };
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
  return out;
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

function inv(invariants: Invariant[], name: string, holds: boolean, detail: string) {
  invariants.push({ name, holds, detail });
}

function replay(filter: string): string {
  return `XC_PG_URL=<from ./xc_pg_up.sh> STRESS_SEED=${SEED} STRESS_PG_LANES=${LANES} STRESS_PG_ROUNDS=${ROUNDS} deno test -A --no-check --config deno.json stress_permit_release_pg.test.ts --filter "${filter}"`;
}

const pick = <T>(prng: Prng, items: readonly T[]): T => items[prng.int(0, items.length - 1)];
/** The outcome a release lane asked for (first token of its detail). */
const requestedOf = (row: LaneRow): string => (row.detail ?? "").split(" ")[0];

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
  const sql = postgres(PG_URL, { max: LANES + 4 });
  const prng = new Prng((SEED ^ fnv1a(name)) >>> 0);
  const rows: LaneRow[] = [];
  const invariants: Invariant[] = [];
  const inputs: Record<string, unknown> = {};
  const observations: Record<string, unknown> = {};
  const heapBefore = Deno.memoryUsage();
  const t0 = performance.now();
  try {
    await run(sql, prng, rows, invariants, inputs, observations);
  } catch (error) {
    inv(invariants, "scenario ran without throwing", false, String(error));
  } finally {
    await sql.end({ timeout: 5 });
  }
  inv(
    invariants,
    "lanes genuinely overlapped on the server",
    overlapCount(rows) > 0,
    `${overlapCount(rows)}/${rows.length}`,
  );
  inv(
    invariants,
    "no lane produced a 5xx-class result",
    rows.every((r) => !r.result.startsWith("5xx")),
    JSON.stringify(histogram(rows.map((r) => r.result))),
  );
  const slowest = rows.reduce((m, r) => Math.max(m, r.clientMs), 0);
  inv(
    invariants,
    `bounded latency: slowest lane < ${TIMEOUT_MS / 2}ms`,
    slowest < TIMEOUT_MS / 2,
    `slowest=${slowest}ms`,
  );
  const report: ScenarioReport = {
    scenario: name,
    label,
    seed: SEED,
    scale: { lanes: LANES, rounds: ROUNDS },
    inputs,
    statusHistogram: histogram(rows.map((r) => `${r.op}:${r.result}`)),
    counters: {
      lanesOverlappingAnotherLane: overlapCount(rows),
      rows: rows.length,
      rounds: ROUNDS,
    },
    invariants,
    observations,
    timeline: rows.map((r) => ({
      t: r.serverStartMs,
      op: r.op,
      detail: `round=${r.round} lane=${r.lane} → ${r.result} ${r.detail ?? ""}`,
    })),
    requests: rows as unknown as Array<Record<string, unknown>>,
    durationMs: Math.round(performance.now() - t0),
    heap: { before: heapBefore, after: Deno.memoryUsage() },
    replay: replay(label),
  };
  const path = await writeReport(report);
  console.log(`[stress-pg] ${name}: ${rows.length} lanes, ${report.durationMs}ms → ${path}`);
  for (const i of invariants)
    if (!i.holds) console.log(`[stress-pg]   BROKEN ${i.name} — ${i.detail}`);
  return report;
}

function assertReport(report: ScenarioReport) {
  const broken = report.invariants.filter((i) => !i.holds);
  assert(
    broken.length === 0,
    `${report.scenario}: ${broken.map((i) => `${i.name}: ${i.detail}`).join("\n")}\nreplay: ${report.replay}`,
  );
}

async function newUser(sql: Sql, prng: Prng): Promise<string> {
  const uid = prng.uuid();
  await createUser(sql, uid, { provider: "google", sub: `sub-${uid}` });
  return uid;
}

// ── PGS1: duplicate release, one outcome ─────────────────────────────────────

Deno.test({
  name: "stress PGS1: release same outcome ×N concurrent transactions — exactly one UPDATE matches, every lane 200, one row",
  ignore,
  async fn() {
    const report = await scenario(
      "pgs1_release_dup_same_outcome",
      "stress PGS1",
      async (sql, prng, rows, invariants, inputs) => {
        const rounds: unknown[] = [];
        for (let r = 0; r < ROUNDS; r++) {
          const uid = await newUser(sql, prng);
          const reserved = await reserveAs(sql, uid, `k-${r}-${prng.uuid()}`);
          assert(
            reserved.result === "accepted" && reserved.permitId,
            `precondition reserve: ${reserved.result}`,
          );
          const permitId = reserved.permitId;
          const outcome = pick(prng, RELEASABLE);
          const { rows: out, timedOut } = await burst(
            sql,
            Array.from({ length: LANES }, () => ({
              userId: uid,
              run: (tx: Tx) => releaseLikeRoute(tx, permitId, uid, outcome, "release"),
            })),
            r,
          );
          rows.push(...out);
          const state = await permitState(sql, permitId);
          const counts = await ownerCounts(sql, uid);
          rounds.push({
            uid,
            permitId,
            outcome,
            results: histogram(out.map((x) => x.result)),
            state,
          });
          inv(
            invariants,
            `round ${r}: no deadlock (burst finished within ${TIMEOUT_MS}ms)`,
            !timedOut,
            `${out.length}/${LANES} lanes done`,
          );
          inv(
            invariants,
            `round ${r}: every lane is a 200`,
            out.every((x) => x.result.startsWith("200")),
            JSON.stringify(histogram(out.map((x) => x.result))),
          );
          inv(
            invariants,
            `round ${r}: exactly one lane's UPDATE matched`,
            out.filter((x) => x.result === "200.won").length === 1,
            JSON.stringify(histogram(out.map((x) => x.result))),
          );
          inv(
            invariants,
            `round ${r}: row finalized/${outcome}, single row`,
            state?.status === "finalized" &&
              state?.outcome === outcome &&
              counts.permits.join() === `finalized/${outcome}=1`,
            `${state?.status}/${state?.outcome} ${counts.permits}`,
          );
          const acc = await accessState(sql, uid);
          inv(
            invariants,
            `round ${r}: access_state reserved_count=0 scored_count=0`,
            acc.reserved_count === 0 && acc.scored_count === 0,
            JSON.stringify(acc),
          );
        }
        inputs.rounds = rounds;
      },
    );
    assertReport(report);
  },
});

// ── PGS2: conflicting outcomes ───────────────────────────────────────────────

Deno.test({
  name: "stress PGS2: release with conflicting outcomes ×N — one winner, losers see the winner (409), winner never flips",
  ignore,
  async fn() {
    const report = await scenario(
      "pgs2_release_dup_mixed_outcomes",
      "stress PGS2",
      async (sql, prng, rows, invariants, inputs) => {
        const rounds: unknown[] = [];
        for (let r = 0; r < ROUNDS; r++) {
          const uid = await newUser(sql, prng);
          const reserved = await reserveAs(sql, uid, `k-${r}-${prng.uuid()}`);
          assert(reserved.result === "accepted" && reserved.permitId);
          const permitId = reserved.permitId;
          const outcomes = Array.from({ length: LANES }, () => pick(prng, RELEASABLE));
          const { rows: out, timedOut } = await burst(
            sql,
            outcomes.map((o) => ({
              userId: uid,
              run: (tx: Tx) => releaseLikeRoute(tx, permitId, uid, o, "release"),
            })),
            r,
          );
          rows.push(...out);
          const state = await permitState(sql, permitId);
          const winner = state?.outcome ?? "";
          const won = out.filter((x) => x.result === "200.won");
          rounds.push({
            uid,
            permitId,
            outcomes: histogram(outcomes),
            winner,
            results: histogram(out.map((x) => x.result)),
          });
          inv(invariants, `round ${r}: no deadlock`, !timedOut, `${out.length}/${LANES}`);
          inv(
            invariants,
            `round ${r}: exactly one UPDATE matched and it wrote the row's outcome`,
            won.length === 1 && requestedOf(won[0]) === winner,
            `won=${won.map(requestedOf)} row=${winner}`,
          );
          inv(
            invariants,
            `round ${r}: 200 ⇔ requested the winner, 409 ⇔ another outcome; nobody 404/5xx`,
            out.every((x) =>
              requestedOf(x) === winner ? x.result.startsWith("200") : x.result.startsWith("409"),
            ),
            JSON.stringify(out.map((x) => `${requestedOf(x)}→${x.result}`)),
          );
          inv(
            invariants,
            `round ${r}: every loser's re-read saw the final row (no torn read)`,
            out
              .filter((x) => x.result.endsWith(".settled"))
              .every((x) => (x.detail ?? "").includes(`settled=finalized/${winner}`)),
            JSON.stringify(out.filter((x) => x.result.endsWith(".settled")).map((x) => x.detail)),
          );
          inv(
            invariants,
            `round ${r}: row finalized`,
            state?.status === "finalized" && RELEASABLE.includes(winner as never),
            `${state?.status}/${winner}`,
          );
        }
        inputs.rounds = rounds;
      },
    );
    assertReport(report);
  },
});

// ── PGS3: release vs consume (apply_synced_shot) ─────────────────────────────

Deno.test({
  name: "stress PGS3: release UPDATE racing apply_synced_shot(scored) — one terminal state, ≤1 shot, no double spend",
  ignore,
  async fn() {
    const report = await scenario(
      "pgs3_release_vs_consume",
      "stress PGS3",
      async (sql, prng, rows, invariants, inputs, observations) => {
        const rounds: unknown[] = [];
        let consumeWins = 0;
        let releaseWins = 0;
        for (let r = 0; r < ROUNDS; r++) {
          const uid = await newUser(sql, prng);
          const reserved = await reserveAs(sql, uid, `k-${r}-${prng.uuid()}`);
          assert(reserved.result === "accepted" && reserved.permitId);
          const permitId = reserved.permitId;
          const releases = Math.max(1, Math.floor(LANES / 2));
          const applies = Math.max(1, LANES - releases);
          const sameShot = prng.int(0, 1) === 1;
          const shotIds = Array.from({ length: applies }, () => prng.uuid());
          const outcomes = Array.from({ length: releases }, () => pick(prng, RELEASABLE));
          const lanes: Lane[] = [
            ...outcomes.map((o) => ({
              userId: uid,
              run: (tx: Tx) => releaseLikeRoute(tx, permitId, uid, o, "release"),
            })),
            ...shotIds.map((id) => ({
              userId: uid,
              run: (tx: Tx) =>
                applyRpc(tx, shotPayload(sameShot ? shotIds[0] : id, permitId), "apply"),
            })),
          ];
          const { rows: out, timedOut } = await burst(sql, prng.shuffle(lanes), r);
          rows.push(...out);
          const rel = out.filter((x) => x.op === "release");
          const app = out.filter((x) => x.op === "apply");
          const state = await permitState(sql, permitId);
          const counts = await ownerCounts(sql, uid);
          const acc = await accessState(sql, uid);
          const consumed = counts.shots > 0;
          if (consumed) consumeWins++;
          else releaseWins++;
          rounds.push({
            uid,
            permitId,
            sameShot,
            releases,
            applies,
            terminal: `${state?.status}/${state?.outcome}`,
            release: histogram(rel.map((x) => x.result)),
            apply: histogram(app.map((x) => x.result)),
            counts,
            acc,
          });
          inv(invariants, `round ${r}: no deadlock`, !timedOut, `${out.length}/${LANES}`);
          inv(
            invariants,
            `round ${r}: at most one shot row, scored ≤ 1`,
            counts.shots <= 1 && counts.scoredShots <= 1,
            JSON.stringify(counts),
          );
          inv(
            invariants,
            `round ${r}: permit not left reserved`,
            state?.status !== "reserved",
            `${state?.status}/${state?.outcome}`,
          );
          if (consumed) {
            inv(
              invariants,
              `round ${r}: consume won → permit finalized/scored`,
              state?.status === "finalized" && state?.outcome === "scored",
              `${state?.status}/${state?.outcome}`,
            );
            inv(
              invariants,
              `round ${r}: consume won → every release lane is 409 (never 200.won)`,
              rel.every((x) => x.result.startsWith("409")),
              JSON.stringify(histogram(rel.map((x) => x.result))),
            );
            inv(
              invariants,
              `round ${r}: consume won → ${sameShot ? "same shot: every apply accepted (replay)" : "distinct shots: one accepted, rest permit_not_reserved"}`,
              sameShot
                ? app.every((x) => x.result === "accepted")
                : app.filter((x) => x.result === "accepted").length === 1 &&
                    app
                      .filter((x) => x.result !== "accepted")
                      .every((x) => x.result === "access.permit_not_reserved"),
              JSON.stringify(histogram(app.map((x) => x.result))),
            );
            inv(
              invariants,
              `round ${r}: access_state scored_count=1 reserved_count=0`,
              acc.scored_count === 1 && acc.reserved_count === 0,
              JSON.stringify(acc),
            );
          } else {
            inv(
              invariants,
              `round ${r}: release won → permit finalized with a requested outcome, exactly one UPDATE matched`,
              state?.status === "finalized" &&
                RELEASABLE.includes((state?.outcome ?? "") as never) &&
                rel.filter((x) => x.result === "200.won").length === 1,
              `${state?.status}/${state?.outcome} ${JSON.stringify(histogram(rel.map((x) => x.result)))}`,
            );
            inv(
              invariants,
              `round ${r}: release won → every apply is access.permit_not_reserved`,
              app.every((x) => x.result === "access.permit_not_reserved"),
              JSON.stringify(histogram(app.map((x) => x.result))),
            );
            inv(
              invariants,
              `round ${r}: access_state scored_count=0 reserved_count=0`,
              acc.scored_count === 0 && acc.reserved_count === 0,
              JSON.stringify(acc),
            );
          }
        }
        inputs.rounds = rounds;
        observations.consumeWins = consumeWins;
        observations.releaseWins = releaseWins;
      },
    );
    assertReport(report);
  },
});

// ── PGS4: two actors — B attacks A's permit id under RLS ─────────────────────

Deno.test({
  name: "stress PGS4: another user's release/consume against A's permit id — RLS yields 404 / permit_not_found, A's row untouched",
  ignore,
  async fn() {
    const report = await scenario(
      "pgs4_two_actors_same_row",
      "stress PGS4",
      async (sql, prng, rows, invariants, inputs) => {
        const rounds: unknown[] = [];
        for (let r = 0; r < ROUNDS; r++) {
          const a = await newUser(sql, prng);
          const b = await newUser(sql, prng);
          const reserved = await reserveAs(sql, a, `k-${r}-${prng.uuid()}`);
          assert(reserved.result === "accepted" && reserved.permitId);
          const permitId = reserved.permitId;
          const aLanes = prng.int(0, 2);
          const aOutcome = pick(prng, RELEASABLE);
          const lanes: Lane[] = [
            ...Array.from({ length: Math.max(1, LANES - 1 - aLanes) }, () => ({
              userId: b,
              run: (tx: Tx) =>
                releaseLikeRoute(tx, permitId, b, pick(prng, RELEASABLE), "release.B"),
            })),
            {
              userId: b,
              run: (tx: Tx) => applyRpc(tx, shotPayload(prng.uuid(), permitId), "apply.B"),
            },
            ...Array.from({ length: aLanes }, () => ({
              userId: a,
              run: (tx: Tx) => releaseLikeRoute(tx, permitId, a, aOutcome, "release.A"),
            })),
          ];
          // B also tries the route's UPDATE without the user_id predicate (as if the edge were buggy) — RLS alone must stop it.
          lanes.push({
            userId: b,
            run: async (tx: Tx) => {
              const t0 = await serverNowMs(tx);
              const u = await tx.unsafe(
                `update public.analysis_permits set status = 'finalized', outcome = 'cancelled' where id = '${permitId}' returning id`,
              );
              const t1 = await serverNowMs(tx);
              return {
                op: "rawUpdate.B",
                result: `matched.${u.length}`,
                serverStartMs: t0,
                serverEndMs: t1,
              };
            },
          });
          const { rows: out, timedOut } = await burst(sql, prng.shuffle(lanes), r);
          rows.push(...out);
          const state = await permitState(sql, permitId);
          const bCounts = await ownerCounts(sql, b);
          const relB = out.filter((x) => x.op === "release.B");
          const appB = out.find((x) => x.op === "apply.B");
          const raw = out.find((x) => x.op === "rawUpdate.B");
          const relA = out.filter((x) => x.op === "release.A");
          rounds.push({
            a,
            b,
            permitId,
            aLanes,
            aOutcome,
            B: histogram(relB.map((x) => x.result)),
            applyB: appB?.result,
            raw: raw?.result,
            terminal: `${state?.status}/${state?.outcome}`,
          });
          inv(invariants, `round ${r}: no deadlock`, !timedOut, `${out.length}/${lanes.length}`);
          inv(
            invariants,
            `round ${r}: every B release is 404 (RLS hides the row)`,
            relB.every((x) => x.result === "404"),
            JSON.stringify(histogram(relB.map((x) => x.result))),
          );
          inv(
            invariants,
            `round ${r}: B's consume is access.permit_not_found`,
            appB?.result === "access.permit_not_found",
            String(appB?.result),
          );
          inv(
            invariants,
            `round ${r}: B's raw UPDATE (no user_id predicate) matched 0 rows`,
            raw?.result === "matched.0",
            String(raw?.result),
          );
          inv(
            invariants,
            `round ${r}: no shot row for B`,
            bCounts.shots === 0,
            JSON.stringify(bCounts),
          );
          inv(invariants, `round ${r}: row still A's`, state?.userId === a, String(state?.userId));
          if (aLanes === 0)
            inv(
              invariants,
              `round ${r}: A silent → row untouched (reserved)`,
              state?.status === "reserved" && state?.outcome === "",
              `${state?.status}/${state?.outcome}`,
            );
          else
            inv(
              invariants,
              `round ${r}: A's own release lands (200) → finalized/${aOutcome}`,
              relA.every((x) => x.result.startsWith("200")) &&
                state?.status === "finalized" &&
                state?.outcome === aOutcome,
              `${JSON.stringify(histogram(relA.map((x) => x.result)))} ${state?.status}/${state?.outcome}`,
            );
        }
        // Column grant: the route may only move status/outcome. Forging created_at (to un-expire a hold) must be refused.
        const uid = await newUser(sql, prng);
        const reserved = await reserveAs(sql, uid, `grant-${prng.uuid()}`);
        let grantError = "";
        try {
          await sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, uid);
            await tx.unsafe(
              `update public.analysis_permits set created_at = now() where id = '${reserved.permitId}'`,
            );
          });
        } catch (error) {
          grantError = String((error as { code?: string }).code ?? error);
        }
        inv(
          invariants,
          "authenticated cannot UPDATE created_at on analysis_permits (42501)",
          grantError === "42501",
          grantError || "update succeeded",
        );
        inputs.rounds = rounds;
      },
    );
    assertReport(report);
  },
});

// ── PGS5: expired hold — release lanes vs the cron sweep vs consume ──────────

Deno.test({
  name: "stress PGS5: 24h-expired permit — release UPDATEs race the pg_cron sweep and a scored apply; one terminal state, no scored shot",
  ignore,
  async fn() {
    const report = await scenario(
      "pgs5_expired_sweep_race",
      "stress PGS5",
      async (sql, prng, rows, invariants, inputs, observations) => {
        const rounds: unknown[] = [];
        let sweptWins = 0;
        let releaseWins = 0;
        for (let r = 0; r < ROUNDS; r++) {
          const uid = await newUser(sql, prng);
          const reserved = await reserveAs(sql, uid, `k-${r}-${prng.uuid()}`);
          assert(reserved.result === "accepted" && reserved.permitId);
          const permitId = reserved.permitId;
          await sql.unsafe(
            `update public.analysis_permits set created_at = now() - interval '24 hours' - make_interval(secs => ${prng.int(1, 3600)}) where id = '${permitId}'`,
          );
          const releases = Math.max(1, LANES - 2);
          const outcomes = Array.from({ length: releases }, () => pick(prng, RELEASABLE));
          const lanes: Lane[] = [
            ...outcomes.map((o) => ({
              userId: uid,
              run: (tx: Tx) => releaseLikeRoute(tx, permitId, uid, o, "release"),
            })),
            { userId: null, run: (tx: Tx) => sweepRpc(tx, "sweep") },
            {
              userId: uid,
              run: (tx: Tx) => applyRpc(tx, shotPayload(prng.uuid(), permitId), "apply"),
            },
          ];
          const { rows: out, timedOut } = await burst(sql, prng.shuffle(lanes), r);
          rows.push(...out);
          const rel = out.filter((x) => x.op === "release");
          const sweep = out.find((x) => x.op === "sweep");
          const app = out.find((x) => x.op === "apply");
          const state = await permitState(sql, permitId);
          const counts = await ownerCounts(sql, uid);
          const acc = await accessState(sql, uid);
          const terminal = `${state?.status}/${state?.outcome}`;
          if (state?.outcome === "expired") sweptWins++;
          else releaseWins++;
          rounds.push({
            uid,
            permitId,
            terminal,
            release: histogram(rel.map((x) => x.result)),
            sweep: sweep?.result,
            apply: app?.result,
            counts,
            acc,
          });
          inv(invariants, `round ${r}: no deadlock`, !timedOut, `${out.length}/${lanes.length}`);
          inv(
            invariants,
            `round ${r}: exactly one terminal state — finalized/<requested> or released/expired`,
            (state?.status === "finalized" &&
              RELEASABLE.includes((state?.outcome ?? "") as never)) ||
              (state?.status === "released" && state?.outcome === "expired"),
            terminal,
          );
          inv(
            invariants,
            `round ${r}: expired permit never consumed (apply ≠ accepted, no scored shot)`,
            app?.result !== "accepted" && counts.scoredShots === 0,
            `${app?.result} ${JSON.stringify(counts)}`,
          );
          inv(
            invariants,
            `round ${r}: release lanes 200 ⇔ requested the terminal outcome, else 409`,
            rel.every((x) =>
              requestedOf(x) === state?.outcome
                ? x.result.startsWith("200")
                : x.result.startsWith("409"),
            ),
            JSON.stringify(rel.map((x) => `${requestedOf(x)}→${x.result}`)),
          );
          inv(
            invariants,
            `round ${r}: at most one release UPDATE matched`,
            rel.filter((x) => x.result === "200.won").length <= 1,
            JSON.stringify(histogram(rel.map((x) => x.result))),
          );
          inv(
            invariants,
            `round ${r}: access_state reserved_count=0 (stale hold not counted)`,
            acc.reserved_count === 0,
            JSON.stringify(acc),
          );
        }
        inputs.rounds = rounds;
        observations.sweptWins = sweptWins;
        observations.releaseWins = releaseWins;
      },
    );
    assertReport(report);
  },
});

// ── PGS6: release frees a slot while new keys reserve — never > 2 live ───────

Deno.test({
  name: "stress PGS6: free account at the 2-permit cap — releasing one while N new keys reserve frees exactly one slot",
  ignore,
  async fn() {
    const report = await scenario(
      "pgs6_release_frees_slot",
      "stress PGS6",
      async (sql, prng, rows, invariants, inputs) => {
        const rounds: unknown[] = [];
        for (let r = 0; r < ROUNDS; r++) {
          const uid = await newUser(sql, prng);
          const p1 = await reserveAs(sql, uid, `cap1-${r}-${prng.uuid()}`);
          const p2 = await reserveAs(sql, uid, `cap2-${r}-${prng.uuid()}`);
          assert(
            p1.result === "accepted" && p2.result === "accepted" && p1.permitId,
            "precondition: two live permits",
          );
          const third = await reserveAs(sql, uid, `cap3-${r}-${prng.uuid()}`);
          inv(
            invariants,
            `round ${r}: precondition — third key paywalled at the cap`,
            third.result === "access.paywall_required",
            third.result,
          );
          const releaseLanes = Math.max(1, Math.floor(LANES / 3));
          const outcome = pick(prng, RELEASABLE);
          const p1Id = p1.permitId;
          const lanes: Lane[] = [
            ...Array.from({ length: releaseLanes }, () => ({
              userId: uid,
              run: (tx: Tx) => releaseLikeRoute(tx, p1Id, uid, outcome, "release"),
            })),
            ...Array.from({ length: LANES - releaseLanes }, (_, i) => ({
              userId: uid,
              run: (tx: Tx) => reserveRpc(tx, `new-${r}-${i}-${prng.uuid()}`, "reserve.new"),
            })),
          ];
          const { rows: out, timedOut } = await burst(sql, prng.shuffle(lanes), r);
          rows.push(...out);
          const rel = out.filter((x) => x.op === "release");
          const res = out.filter((x) => x.op === "reserve.new");
          const accepted = res.filter((x) => x.result === "accepted");
          const counts = await ownerCounts(sql, uid);
          const acc = await accessState(sql, uid);
          rounds.push({
            uid,
            p1: p1Id,
            outcome,
            release: histogram(rel.map((x) => x.result)),
            reserve: histogram(res.map((x) => x.result)),
            counts,
            acc,
          });
          inv(invariants, `round ${r}: no deadlock`, !timedOut, `${out.length}/${LANES}`);
          inv(
            invariants,
            `round ${r}: release lanes all 200, exactly one matched`,
            rel.every((x) => x.result.startsWith("200")) &&
              rel.filter((x) => x.result === "200.won").length === 1,
            JSON.stringify(histogram(rel.map((x) => x.result))),
          );
          inv(
            invariants,
            `round ${r}: at most ONE new key accepted (only one slot was freed)`,
            accepted.length <= 1,
            JSON.stringify(histogram(res.map((x) => x.result))),
          );
          inv(
            invariants,
            `round ${r}: rejected new keys are paywall_required`,
            res
              .filter((x) => x.result !== "accepted")
              .every((x) => x.result === "access.paywall_required"),
            JSON.stringify(histogram(res.map((x) => x.result))),
          );
          inv(
            invariants,
            `round ${r}: live reserved ≤ 2 and = 1 + accepted`,
            counts.liveReserved <= 2 && counts.liveReserved === 1 + accepted.length,
            JSON.stringify(counts),
          );
          inv(
            invariants,
            `round ${r}: unique permit ids across accepted reserves`,
            new Set(accepted.map((x) => x.detail)).size === accepted.length,
            JSON.stringify(accepted.map((x) => x.detail)),
          );
          inv(
            invariants,
            `round ${r}: access_state reserved_count matches live rows`,
            acc.reserved_count === counts.liveReserved,
            `${JSON.stringify(acc)} live=${counts.liveReserved}`,
          );
        }
        inputs.rounds = rounds;
      },
    );
    assertReport(report);
  },
});
