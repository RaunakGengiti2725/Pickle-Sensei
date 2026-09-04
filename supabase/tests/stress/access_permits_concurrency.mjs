#!/usr/bin/env node
// Concurrency stress harness for the DB access/permit unit:
//   public.access_state(), public.reserve_analysis_permit(text),
//   public.apply_synced_shot(jsonb), public.analysis_permits,
//   public.access_lock_key(uuid) and the free-rating identity ledger.
//
// Every iteration is a seeded program (mulberry32 PRNG) of N lanes, each lane
// one independently-opened transaction (own connection, `set local role
// authenticated` + `set local request.jwt.claim.sub`), released together
// through a barrier so the RPCs genuinely contend on the per-user advisory
// lock. After every lane commits, owner-side state is snapshotted and the
// invariants below are asserted. Results are a JSON table (seed → outcome).
//
//   node supabase/tests/stress/access_permits_concurrency.mjs
//
// Environment:
//   STRESS_PG_URL   postgres URL (see db_up.sh). Without it the run is
//                   SKIPPED (exit 0, clearly labelled — a skip is not a pass).
//   STRESS_ITER     mixed-scheduler iterations (default 20; campaign: 500)
//   STRESS_ROUNDS   rounds per fixed scenario (default 3; campaign: 30)
//   STRESS_SEED     root seed (default 20260904)
//   STRESS_REPLAY   "<scenario>:<seed>" — run exactly one iteration, dump lanes
//   STRESS_OUT_DIR  artifact dir (default artifacts/stress/db-access-state-permits/latest)
//   STRESS_LANE_MAX max lanes per mixed iteration (default 12)
//
// Invariants (per iteration, per user unless noted):
//   H1  no double spend: never-premium user has <= 2 scored shots, ledger <= 2
//   H2  idempotency: one permit id per (user, key) across all accepted lanes
//   H3  duplicate shot: <= 1 row per shot id; same (shot, permit) lanes agree
//   H4  permit accounting: finalized/scored == RPC-scored shots,
//       released/low_confidence == low_confidence shots
//   H5  no phantom rows: permit rows == pre-state + distinct accepted reserves
//   H6  access_state() agrees with owner-side state (scored, reserved, premium)
//   H7  soft cap (no skew/over-issue/direct writes): fresh reserved + min(scored,2) <= 2
//   H8  no lost update: a client release (1 row) and an accepted apply never
//       both settle the same permit; settled permits never revert to reserved
//   H9  cross-user isolation: probes see/modify 0 rows, foreign permit ids not found
//   H10 no deadlock / hang / unexpected SQLSTATE; bounded wall time
//   H11 ledger in step: every identity of a user carries the same count == scored shots
//   H12 result vocabulary: RPCs only return documented codes
//
// New file only — production code and existing tests are untouched.

import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..", "..");

function loadPg() {
  for (const anchor of [
    "package.json",
    "packages/database/package.json",
    "services/api/package.json",
  ]) {
    try {
      return createRequire(path.join(ROOT, anchor))("pg");
    } catch {
      // try the next workspace that depends on pg
    }
  }
  throw new Error("stress: cannot resolve the `pg` package from the workspace (run pnpm install)");
}

const PG_URL = process.env.STRESS_PG_URL ?? "";
const ITER = envInt("STRESS_ITER", 20);
const ROUNDS = envInt("STRESS_ROUNDS", 3);
const ROOT_SEED = envInt("STRESS_SEED", 20260904);
const LANE_MAX = envInt("STRESS_LANE_MAX", 12);
const REPLAY = process.env.STRESS_REPLAY ?? "";
const OUT_DIR = path.resolve(
  ROOT,
  process.env.STRESS_OUT_DIR ?? "artifacts/stress/db-access-state-permits/latest",
);
const ITER_WALL_MS = 15_000;
const STATEMENT_TIMEOUT = "10s";

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return Math.floor(n);
}

if (!PG_URL) {
  console.log(
    "stress/access_permits_concurrency: SKIPPED — STRESS_PG_URL is not set (a skip is NOT a pass)",
  );
  process.exit(0);
}

// ── seeded scheduler ────────────────────────────────────────────────────────

class Prng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.state = seed >>> 0;
  }
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo, hi) {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p) {
    return this.next() < p;
  }
  pick(items) {
    return items[this.int(0, items.length - 1)];
  }
  weighted(entries) {
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [v, w] of entries) {
      r -= w;
      if (r < 0) return v;
    }
    return entries[entries.length - 1][0];
  }
  uuid() {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
}

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const iterSeed = (scenario, i) =>
  (fnv1a(`${ROOT_SEED}:${scenario}:${i}`) ^ (ROOT_SEED >>> 0)) >>> 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function shotPayload(id, permitId, resultKind) {
  const scored = resultKind === "scored";
  return {
    id,
    analysisPermitId: permitId,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    overallScore: scored ? 7 : null,
    confidence: scored ? 0.9 : 0.2,
    resultKind,
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
  };
}

const RESERVE_CODES = new Set(["accepted", "access.paywall_required", "auth.required"]);
const APPLY_CODES = new Set([
  "accepted",
  "auth.required",
  "access.permit_not_found",
  "access.permit_not_reserved",
  "access.permit_expired",
  "access.paywall_required",
  "shot.session_not_found",
  "shot.id_conflict",
]);

// ── db helpers ──────────────────────────────────────────────────────────────

const pg = loadPg();
const pool = new pg.Pool({ connectionString: PG_URL, max: Math.max(LANE_MAX, 16) + 6 });

async function owner(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}

/** Owner-side user provisioning through the auth trigger path (same as
 * security_regression.sql). Seeded ids repeat across runs against the same
 * disposable DB, so setup first removes what an earlier run left behind —
 * including the identity's ledger row, which survives deletion BY DESIGN. */
async function createUser(uid, identities, { keepLedger = false } = {}) {
  await owner(`delete from auth.users where id = $1`, [uid]);
  for (const id of identities) {
    await owner(
      `delete from auth.users u using auth.identities i
        where i.user_id = u.id and i.provider = $1 and i.provider_id = $2`,
      [id.provider, id.sub],
    );
    if (!keepLedger) {
      await owner(
        `delete from public.free_rating_ledger
          where identity_hash = public.free_rating_identity_hash($1, $2)`,
        [id.provider, id.sub],
      );
    }
  }
  await owner(
    `insert into auth.users (id, email, raw_app_meta_data)
      values ($1, $2, $3::jsonb)`,
    [uid, `${uid}@example.com`, JSON.stringify({ provider: identities[0]?.provider ?? "google" })],
  );
  for (const id of identities) {
    await owner(
      `insert into auth.identities (provider, provider_id, user_id, identity_data)
        values ($1, $2, $3, $4::jsonb)`,
      [id.provider, id.sub, uid, JSON.stringify({ sub: id.sub, email: `${uid}@example.com` })],
    );
  }
}

async function setPremium(uid, mode) {
  await owner(`delete from public.billing_entitlements where user_id = $1`, [uid]);
  if (mode === "none") return;
  const expires = mode === "expired" ? "now() - interval '1 second'" : "null";
  await owner(
    `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
      values ($1, true, 'pickle_sensei_pro', ${expires})`,
    [uid],
  );
}

async function asUser(client, uid) {
  await client.query(`set local role authenticated`);
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? ""]);
}

async function serverNowMs(client) {
  const r = await client.query(`select extract(epoch from clock_timestamp()) * 1000 as ms`);
  return Number(r.rows[0].ms);
}

/** Barrier: every lane opens its transaction + sets its principal, then waits
 * for `gate` so all N statements are issued from concurrently-open txns. */
function barrier() {
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  return { gate, open };
}

/** Run `lanes` concurrently, one transaction each. Every lane returns a row
 * {lane, op, result, sqlstate?, serverStartMs, serverEndMs, clientMs, ...}. */
async function burst(lanes, { isolation = null } = {}) {
  const { gate, open } = barrier();
  const allReady = barrier();
  let readyCount = 0;
  const markReady = () => {
    readyCount += 1;
    if (readyCount === lanes.length) allReady.open();
  };
  const t0 = performance.now();
  const results = lanes.map(async (lane, i) => {
    const row = {
      lane: i,
      op: lane.op,
      uid: lane.uid ?? null,
      role: lane.role,
      args: lane.args ?? {},
      result: null,
    };
    let client;
    try {
      client = await pool.connect();
    } catch (e) {
      markReady();
      return {
        ...row,
        result: "ERROR",
        sqlstate: e.code ?? "JS",
        error: String(e.message ?? e).slice(0, 300),
      };
    }
    let setupDone = false;
    try {
      await client.query("begin");
      await client.query(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
      if (isolation) await client.query(`set transaction isolation level ${isolation}`);
      if (lane.role === "anon") {
        await client.query(`set local role anon`);
      } else if (lane.role !== "owner") {
        await asUser(client, lane.uid ?? null);
      }
      setupDone = true;
      markReady();
      await gate;
      if (lane.delayMs) await sleep(lane.delayMs);
      row.serverStartMs = await serverNowMs(client);
      const c0 = performance.now();
      row.result = await lane.run(client, row);
      row.clientMs = Math.round((performance.now() - c0) * 100) / 100;
      row.serverEndMs = await serverNowMs(client);
      await client.query("commit");
    } catch (e) {
      if (!setupDone) markReady();
      row.result = "ERROR";
      row.sqlstate = e.code ?? "JS";
      row.error = String(e.message ?? e).slice(0, 300);
      if (e.detail) row.errorDetail = String(e.detail).slice(0, 600);
      if (e.where) row.errorWhere = String(e.where).slice(0, 600);
      try {
        await client.query("rollback");
      } catch {
        // connection already gone
      }
    } finally {
      client.release();
    }
    return row;
  });
  // let every lane open its transaction before releasing them together
  await allReady.gate;
  open();
  const rows = await Promise.all(results);
  return { rows, wallMs: Math.round(performance.now() - t0) };
}

// RPC wrappers — return the documented status string.
async function reserveRpc(client, key, row) {
  const r = await client.query(`select * from public.reserve_analysis_permit($1)`, [key]);
  const out = r.rows[0];
  if (out?.permit_id) row.permitId = out.permit_id;
  return out?.result ?? "NO_ROW";
}

async function applyRpc(client, payload) {
  const r = await client.query(`select public.apply_synced_shot($1::jsonb) as result`, [
    JSON.stringify(payload),
  ]);
  return r.rows[0]?.result ?? "NO_ROW";
}

/** The edge fn's POST /v1/analysis-permits/:id/finalize write, verbatim. */
async function releaseSql(client, permitId, uid, outcome) {
  const r = await client.query(
    `update public.analysis_permits set status = 'finalized', outcome = $3
      where id = $1 and user_id = $2 and status = 'reserved' returning id`,
    [permitId, uid, outcome],
  );
  return r.rowCount === 1 ? "released" : "released_0rows";
}

async function accessStateRpc(client, row) {
  const r = await client.query(`select * from public.access_state()`);
  const a = r.rows[0];
  const text = `premium=${a.premium} scored=${a.scored_count} reserved=${a.reserved_count}`;
  if (row) {
    row.access = text;
    return "access_state";
  }
  return text;
}

async function accessStateAs(uid) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await asUser(client, uid);
    const r = await client.query(`select * from public.access_state()`);
    await client.query("commit");
    return r.rows[0];
  } finally {
    client.release();
  }
}

async function ownerSnapshot(uid) {
  const permits = await owner(
    `select id, idempotency_key, status, outcome,
            (created_at > now() - interval '24 hours') as fresh
       from public.analysis_permits where user_id = $1 order by created_at, id`,
    [uid],
  );
  const shots = await owner(
    `select id, result_kind, overall_score from public.shots where user_id = $1 order by created_at, id`,
    [uid],
  );
  const ledger = await owner(
    `select i.provider, i.provider_id, l.scored_count
       from auth.identities i
       left join public.free_rating_ledger l
         on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
      where i.user_id = $1 order by i.provider`,
    [uid],
  );
  return { permits, shots, ledger };
}

async function ownerInsertPermit(uid, key) {
  const r = await owner(
    `insert into public.analysis_permits (user_id, idempotency_key) values ($1, $2) returning id`,
    [uid, key],
  );
  return r[0].id;
}

/** Sequentially spend `n` free ratings through the real RPC path. */
async function spendRatings(uid, n, prng) {
  const client = await pool.connect();
  try {
    for (let i = 0; i < n; i++) {
      await client.query("begin");
      await asUser(client, uid);
      const row = {};
      const res = await reserveRpc(client, `pre-${i}-${prng.uuid()}`, row);
      if (res !== "accepted") throw new Error(`pre-state reserve #${i} → ${res}`);
      const applied = await applyRpc(client, shotPayload(prng.uuid(), row.permitId, "scored"));
      if (applied !== "accepted") throw new Error(`pre-state apply #${i} → ${applied}`);
      await client.query("commit");
    }
  } finally {
    client.release();
  }
}

async function reservePermits(uid, keys) {
  const client = await pool.connect();
  const ids = [];
  try {
    for (const key of keys) {
      await client.query("begin");
      await asUser(client, uid);
      const row = {};
      const res = await reserveRpc(client, key, row);
      await client.query("commit");
      if (res !== "accepted") throw new Error(`pre-state reserve ${key} → ${res}`);
      ids.push(row.permitId);
    }
  } finally {
    client.release();
  }
  return ids;
}

// ── invariant checking ──────────────────────────────────────────────────────

function histogram(rows) {
  const h = {};
  for (const r of rows) h[r.result] = (h[r.result] ?? 0) + 1;
  return h;
}

function checkUser(u, rows, snap, access, ctx, violations) {
  const tag = `user ${u.name}`;
  const mine = rows.filter((r) => r.uid === u.uid && r.role !== "owner");
  const scoredShots = snap.shots.filter((s) => s.result_kind === "scored").length;
  const lowShots = snap.shots.filter((s) => s.result_kind === "low_confidence").length;
  const ledgerVals = snap.ledger.map((l) => l.scored_count ?? 0);
  const ledgerMax = Math.max(0, ...ledgerVals);
  const finalizedScored = snap.permits.filter(
    (p) => p.status === "finalized" && p.outcome === "scored",
  ).length;
  const releasedLow = snap.permits.filter(
    (p) => p.status === "released" && p.outcome === "low_confidence",
  ).length;
  const freshReserved = snap.permits.filter((p) => p.status === "reserved" && p.fresh).length;
  const directAccepted = mine.filter(
    (r) => r.op === "direct_insert_scored" && r.result === "inserted",
  ).length;

  // H1
  if (!u.everPremium) {
    if (scoredShots > 2) violations.push(`H1 ${tag}: ${scoredShots} scored shots for a free user`);
    if (ledgerMax > 2) violations.push(`H1 ${tag}: ledger ${ledgerMax} > 2 for a free user`);
  }
  // H2
  const byKey = new Map();
  for (const r of mine.filter((r) => r.op === "reserve" && r.result === "accepted")) {
    const set = byKey.get(r.args.key) ?? new Set();
    set.add(r.permitId);
    byKey.set(r.args.key, set);
  }
  for (const [key, ids] of byKey) {
    if (ids.size !== 1) violations.push(`H2 ${tag}: key ${key} produced ${ids.size} permit ids`);
    const rowsForKey = snap.permits.filter((p) => p.idempotency_key === key);
    if (rowsForKey.length !== 1)
      violations.push(`H2 ${tag}: key ${key} has ${rowsForKey.length} rows`);
  }
  // H3
  const shotIds = snap.shots.map((s) => s.id);
  if (new Set(shotIds).size !== shotIds.length) violations.push(`H3 ${tag}: duplicate shot rows`);
  const byShot = new Map();
  for (const r of mine.filter((r) => r.op === "apply")) {
    const k = `${r.args.shotId}|${r.args.permitId}`;
    const arr = byShot.get(k) ?? [];
    arr.push(r.result);
    byShot.set(k, arr);
  }
  for (const [k, results] of byShot) {
    const acc = results.filter((x) => x === "accepted").length;
    if (acc > 0 && acc !== results.length) {
      violations.push(`H3 ${tag}: same (shot|permit) ${k} disagreed: ${results.join(",")}`);
    }
  }
  // H4
  if (finalizedScored !== scoredShots - directAccepted) {
    violations.push(
      `H4 ${tag}: finalized/scored permits ${finalizedScored} != RPC-scored shots ${scoredShots - directAccepted}`,
    );
  }
  if (releasedLow !== lowShots) {
    violations.push(
      `H4 ${tag}: released/low_confidence permits ${releasedLow} != low_confidence shots ${lowShots}`,
    );
  }
  // H5
  const acceptedNew = new Set(
    mine.filter((r) => r.op === "reserve" && r.result === "accepted").map((r) => r.permitId),
  );
  for (const id of u.prePermitIds) acceptedNew.delete(id);
  const expectedRows = u.preScored + u.prePermitIds.length + acceptedNew.size;
  if (snap.permits.length !== expectedRows) {
    violations.push(`H5 ${tag}: ${snap.permits.length} permit rows, expected ${expectedRows}`);
  }
  // H6
  const expectedScored = Math.max(scoredShots, ledgerMax);
  if (Number(access.scored_count) !== expectedScored) {
    violations.push(
      `H6 ${tag}: access_state.scored_count ${access.scored_count} != ${expectedScored}`,
    );
  }
  if (!ctx.skew && Number(access.reserved_count) !== freshReserved) {
    violations.push(
      `H6 ${tag}: access_state.reserved_count ${access.reserved_count} != ${freshReserved}`,
    );
  }
  if (access.premium !== u.premiumNow) {
    violations.push(`H6 ${tag}: access_state.premium ${access.premium} != ${u.premiumNow}`);
  }
  // H7
  if (!ctx.skew && !u.everPremium && !u.overIssued && directAccepted === 0) {
    if (freshReserved + Math.min(scoredShots, 2) > 2) {
      violations.push(
        `H7 ${tag}: fresh reserved ${freshReserved} + min(scored,2) ${Math.min(scoredShots, 2)} > 2`,
      );
    }
  }
  // H8
  const settledByRelease = new Set(
    mine.filter((r) => r.op === "release" && r.result === "released").map((r) => r.args.permitId),
  );
  // A second `accepted` for a shot id another lane already inserted is the
  // documented duplicate-sync replay (20260906000000): it returns accepted
  // WITHOUT consuming the permit it was handed, so that permit legitimately
  // stays reserved (pg_cron sweeps it). Only the lane that actually inserted
  // the shot settles a permit.
  const applyAccepted = mine.filter((r) => r.op === "apply" && r.result === "accepted");
  const firstForShot = new Map();
  for (const r of applyAccepted) {
    const prev = firstForShot.get(r.args.shotId);
    if (!prev || (r.serverStartMs ?? 0) < (prev.serverStartMs ?? 0))
      firstForShot.set(r.args.shotId, r);
  }
  const replayPermits = new Set(
    applyAccepted.filter((r) => firstForShot.get(r.args.shotId) !== r).map((r) => r.args.permitId),
  );
  const settledByApply = new Set(
    applyAccepted.filter((r) => !replayPermits.has(r.args.permitId)).map((r) => r.args.permitId),
  );
  for (const id of settledByRelease) {
    if (settledByApply.has(id))
      violations.push(`H8 ${tag}: permit ${id} settled by BOTH release and apply`);
    const p = snap.permits.find((x) => x.id === id);
    if (!p || p.status !== "finalized")
      violations.push(`H8 ${tag}: released permit ${id} is ${p?.status}`);
  }
  for (const id of settledByApply) {
    const p = snap.permits.find((x) => x.id === id);
    if (!p || p.status === "reserved")
      violations.push(`H8 ${tag}: applied permit ${id} is ${p?.status}`);
  }
  // H11
  if (snap.ledger.length > 0) {
    const distinct = new Set(ledgerVals);
    if (distinct.size !== 1) {
      violations.push(
        `H11 ${tag}: identities out of step: ${snap.ledger.map((l) => `${l.provider}=${l.scored_count ?? 0}`).join(" ")}`,
      );
    }
    if (ledgerMax !== scoredShots) {
      violations.push(`H11 ${tag}: ledger ${ledgerMax} != scored shots ${scoredShots}`);
    }
  }
  // H12
  for (const r of mine) {
    if (r.op === "reserve" && r.result !== "ERROR" && !RESERVE_CODES.has(r.result)) {
      violations.push(`H12 ${tag}: reserve returned ${r.result}`);
    }
    if (r.op === "apply" && r.result !== "ERROR" && !APPLY_CODES.has(r.result)) {
      violations.push(`H12 ${tag}: apply returned ${r.result}`);
    }
  }
}

function checkCommon(rows, wallMs, violations, { allowedSqlstates = new Set() } = {}) {
  for (const r of rows) {
    if (r.result !== "ERROR") continue;
    if (r.role === "anon" && r.sqlstate === "42501") continue;
    if (allowedSqlstates.has(r.sqlstate)) continue;
    violations.push(`H10 lane ${r.lane} ${r.op}: SQLSTATE ${r.sqlstate} ${r.error}`);
  }
  for (const r of rows) {
    if (r.role === "anon" && r.result !== "ERROR")
      violations.push(`H9 lane ${r.lane}: anon call succeeded (${r.result})`);
    if (r.role === "noauth" && r.op === "reserve" && r.result !== "auth.required") {
      violations.push(`H9 lane ${r.lane}: unauthenticated reserve → ${r.result}`);
    }
    if (r.op === "probe_cross" && r.result !== "0/0/0")
      violations.push(`H9 lane ${r.lane}: cross-user probe saw ${r.result}`);
    if (r.op === "apply" && r.args.foreign && r.result !== "access.permit_not_found") {
      violations.push(`H9 lane ${r.lane}: foreign permit → ${r.result}`);
    }
  }
  if (wallMs > ITER_WALL_MS) violations.push(`H10 wall time ${wallMs}ms > ${ITER_WALL_MS}ms`);
}

// ── mixed scheduler ─────────────────────────────────────────────────────────

async function mixedIteration(seed) {
  const prng = new Prng(seed);
  const users = [];
  for (const name of ["A", "B"]) {
    const uid = prng.uuid();
    const identities = [{ provider: prng.pick(["apple", "google"]), sub: `${name}-${uid}` }];
    if (prng.chance(0.2))
      identities.push({
        provider: identities[0].provider === "apple" ? "google" : "apple",
        sub: `${name}2-${uid}`,
      });
    await createUser(uid, identities);
    const premiumMode = prng.weighted([
      ["none", 0.8],
      ["active", 0.15],
      ["expired", 0.05],
    ]);
    await setPremium(uid, premiumMode);
    const preScored = premiumMode === "active" ? prng.int(0, 3) : prng.int(0, 2);
    await spendRatings(uid, preScored, prng);
    const room = premiumMode === "active" ? 3 : Math.max(0, 2 - preScored);
    const preReserved = prng.int(0, room);
    const prePermitIds = await reservePermits(
      uid,
      Array.from({ length: preReserved }, (_, i) => `pre-r${i}`),
    );
    let overIssued = false;
    if (premiumMode !== "active" && prng.chance(0.1)) {
      overIssued = true;
      prePermitIds.push(await ownerInsertPermit(uid, `over-${prng.uuid()}`));
    }
    users.push({
      name,
      uid,
      identities,
      premiumMode,
      everPremium: premiumMode === "active",
      premiumNow: premiumMode === "active",
      preScored,
      prePermitIds,
      overIssued,
      finalizedPreIds: [],
    });
  }
  // one pre-state permit already finalized (client cancel) so lanes can hit a settled row
  for (const u of users) {
    if (u.prePermitIds.length > 0 && prng.chance(0.25)) {
      const id = u.prePermitIds[u.prePermitIds.length - 1];
      await owner(
        `update public.analysis_permits set status='finalized', outcome='cancelled' where id = $1`,
        [id],
      );
      u.finalizedPreIds.push(id);
    }
  }
  // clock skew: one reserved permit sits exactly at the 24h boundary
  let skew = false;
  for (const u of users) {
    const live = u.prePermitIds.filter((id) => !u.finalizedPreIds.includes(id));
    if (live.length > 0 && prng.chance(0.12)) {
      skew = true;
      const deltaMs = prng.int(-60, 60);
      await owner(
        `update public.analysis_permits
            set created_at = now() - interval '24 hours' + ($2::int * interval '1 millisecond')
          where id = $1`,
        [live[0], deltaMs],
      );
    }
  }

  const laneCount = prng.int(4, LANE_MAX);
  const keyPool = (u) => [`k0-${u.name}`, `k1-${u.name}`, `k2-${u.name}`];
  const shotPool = (u) => [prng.uuid(), prng.uuid(), prng.uuid()];
  const shots = { A: shotPool(users[0]), B: shotPool(users[1]) };
  const lanes = [];
  for (let i = 0; i < laneCount; i++) {
    const u = prng.pick(users);
    const other = users.find((x) => x !== u);
    const op = prng.weighted([
      ["reserve", 30],
      ["apply", 30],
      ["release", 10],
      ["access_state", 8],
      ["sweep", 3],
      ["noauth", 4],
      ["anon", 2],
      ["probe_cross", 5],
      ["direct_insert_scored", 3],
      ["link_identity", 3],
      ["reserve_then_apply", 6],
    ]);
    const delayMs = prng.chance(0.5) ? 0 : prng.int(1, 20);
    const base = { op, uid: u.uid, role: "user", delayMs };
    switch (op) {
      case "reserve": {
        const key = prng.chance(0.6) ? prng.pick(keyPool(u)) : `fresh-${prng.uuid()}`;
        lanes.push({ ...base, args: { key }, run: (c, row) => reserveRpc(c, key, row) });
        break;
      }
      case "apply": {
        const own = u.prePermitIds;
        const source = prng.weighted([
          ["own", own.length > 0 ? 70 : 0],
          ["foreign", other.prePermitIds.length > 0 ? 10 : 0],
          ["random", 10],
        ]);
        const permitId =
          source === "own"
            ? prng.pick(own)
            : source === "foreign"
              ? prng.pick(other.prePermitIds)
              : prng.uuid();
        const shotId = prng.chance(0.5) ? prng.pick(shots[u.name]) : prng.uuid();
        const kind = prng.chance(0.75) ? "scored" : "low_confidence";
        lanes.push({
          ...base,
          args: { shotId, permitId, kind, foreign: source === "foreign" },
          run: (c) => applyRpc(c, shotPayload(shotId, permitId, kind)),
        });
        break;
      }
      case "release": {
        const pool = u.prePermitIds.length > 0 ? u.prePermitIds : other.prePermitIds;
        if (pool.length === 0) {
          lanes.push({
            ...base,
            op: "access_state",
            args: {},
            run: (c, row) => accessStateRpc(c, row),
          });
          break;
        }
        const permitId = prng.pick(pool);
        const outcome = prng.pick(["cancelled", "failed", "low_confidence"]);
        lanes.push({
          ...base,
          args: { permitId, outcome },
          run: (c) => releaseSql(c, permitId, u.uid, outcome),
        });
        break;
      }
      case "access_state":
        lanes.push({ ...base, args: {}, run: (c, row) => accessStateRpc(c, row) });
        break;
      case "sweep":
        lanes.push({
          ...base,
          role: "owner",
          uid: null,
          args: {},
          run: async (c) => {
            const r = await c.query(
              `update public.analysis_permits set status = 'released', outcome = 'expired'
                where status = 'reserved' and created_at < now() - interval '24 hours'`,
            );
            return `swept=${r.rowCount}`;
          },
        });
        break;
      case "noauth":
        lanes.push({
          ...base,
          role: "noauth",
          uid: null,
          op: "reserve",
          args: { key: "noauth", noauth: true },
          run: (c, row) => reserveRpc(c, "noauth", row),
        });
        break;
      case "anon":
        lanes.push({
          ...base,
          role: "anon",
          uid: null,
          op: "reserve",
          args: { key: "anon" },
          run: (c, row) => reserveRpc(c, "anon", row),
        });
        break;
      case "probe_cross":
        lanes.push({
          ...base,
          args: { target: other.uid },
          run: async (c) => {
            const seen = await c.query(
              `select count(*)::int as n from public.analysis_permits where user_id = $1`,
              [other.uid],
            );
            const upd = await c.query(
              `update public.analysis_permits set status = 'released', outcome = 'hijack' where user_id = $1`,
              [other.uid],
            );
            const del = await c.query(`delete from public.analysis_permits where user_id = $1`, [
              other.uid,
            ]);
            return `${seen.rows[0].n}/${upd.rowCount}/${del.rowCount}`;
          },
        });
        break;
      case "direct_insert_scored":
        lanes.push({
          ...base,
          args: {},
          run: async (c) => {
            try {
              await c.query("savepoint direct");
              await c.query(
                `insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at,
                   start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind,
                   app_version, model_bundle_version, pose_model_version, paddle_model_version,
                   stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
                 values ($1, $2, null, 'dink', 'side', now(), 0, 100, 200, 7, 0.9, 'scored',
                   '1.0.0','b','p','pd','s','ph','sc','c','real')`,
                [prng.uuid(), u.uid],
              );
              await c.query("release savepoint direct");
              return "inserted";
            } catch (e) {
              await c.query("rollback to savepoint direct");
              return `denied:${e.code}`;
            }
          },
        });
        break;
      case "link_identity": {
        const provider = u.identities.some((i) => i.provider === "google") ? "apple" : "google";
        const sub = `link-${prng.uuid()}`;
        u.identities.push({ provider, sub });
        // the sub is seed-derived: a replay must not inherit the ledger row a
        // previous run left for it (that is the "identity arriving with
        // history" path, exercised deliberately in F5d, not here)
        await owner(
          `delete from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash($1, $2)`,
          [provider, sub],
        );
        lanes.push({
          ...base,
          role: "owner",
          uid: u.uid,
          args: { provider, sub },
          run: async (c) => {
            await c.query(
              `insert into auth.identities (provider, provider_id, user_id, identity_data) values ($1, $2, $3, $4::jsonb)`,
              [provider, sub, u.uid, JSON.stringify({ sub })],
            );
            return "linked";
          },
        });
        break;
      }
      case "reserve_then_apply": {
        const key = `rta-${prng.uuid()}`;
        const shotId = prng.uuid();
        const kind = prng.chance(0.8) ? "scored" : "low_confidence";
        lanes.push({
          ...base,
          args: { key, shotId, kind },
          run: async (c, row) => {
            const res = await reserveRpc(c, key, row);
            if (res !== "accepted") return `reserve:${res}`;
            const applied = await applyRpc(c, shotPayload(shotId, row.permitId, kind));
            return `apply:${applied}`;
          },
        });
        break;
      }
    }
  }

  const { rows, wallMs } = await burst(lanes);
  const violations = [];
  checkCommon(rows, wallMs, violations);
  const snaps = {};
  for (const u of users) {
    const snap = await ownerSnapshot(u.uid);
    const access = await accessStateAs(u.uid);
    snaps[u.name] = { snap, access };
    // reserve_then_apply lanes are compound; fold their accepted reserves into H5's expectation
    const compound = rows.filter((r) => r.uid === u.uid && r.op === "reserve_then_apply");
    const asReserve = compound
      .filter((r) => r.permitId)
      .map((r) => ({ ...r, op: "reserve", result: "accepted", args: { key: r.args.key } }));
    const asApply = compound
      .filter((r) => r.result?.startsWith("apply:"))
      .map((r) => ({
        ...r,
        op: "apply",
        result: r.result.slice(6),
        args: { shotId: r.args.shotId, permitId: r.permitId },
      }));
    // link_identity lanes run as owner but belong to the user for H11
    checkUser(u, [...rows, ...asReserve, ...asApply], snap, access, { skew }, violations);
  }
  for (const r of rows) {
    if (r.op === "reserve_then_apply" && r.result !== "ERROR") {
      const [phase, code] = r.result.split(":");
      if (phase === "reserve" && !RESERVE_CODES.has(code))
        violations.push(`H12 reserve_then_apply reserve → ${code}`);
      if (phase === "apply" && !APPLY_CODES.has(code))
        violations.push(`H12 reserve_then_apply apply → ${code}`);
    }
  }
  return {
    scenario: "mixed",
    seed,
    lanes: lanes.length,
    users: users.map((u) => ({
      name: u.name,
      premium: u.premiumMode,
      preScored: u.preScored,
      prePermits: u.prePermitIds.length,
      overIssued: u.overIssued,
      identities: u.identities.length,
    })),
    skew,
    histogram: histogram(rows),
    wallMs,
    violations,
    outcome: violations.length === 0 ? "HELD" : "BROKEN",
    detail: { rows, snaps },
  };
}

// ── fixed scenarios ─────────────────────────────────────────────────────────

const scenarios = {
  mixed: mixedIteration,

  /** F1: client cancel racing the scored sync of the same permit. */
  async cancel_vs_apply(seed) {
    const prng = new Prng(seed);
    const uid = prng.uuid();
    await createUser(uid, [{ provider: "apple", sub: `a-${uid}` }]);
    await setPremium(uid, "none");
    const [p] = await reservePermits(uid, ["p"]);
    const shotId = prng.uuid();
    const lanes = [];
    for (let i = 0; i < 2; i++) {
      lanes.push({
        op: "apply",
        uid,
        role: "user",
        delayMs: prng.int(0, 8),
        args: { shotId, permitId: p, kind: "scored" },
        run: (c) => applyRpc(c, shotPayload(shotId, p, "scored")),
      });
      lanes.push({
        op: "release",
        uid,
        role: "user",
        delayMs: prng.int(0, 8),
        args: { permitId: p, outcome: "cancelled" },
        run: (c) => releaseSql(c, p, uid, "cancelled"),
      });
    }
    const { rows, wallMs } = await burst(lanes);
    const violations = [];
    checkCommon(rows, wallMs, violations);
    const snap = await ownerSnapshot(uid);
    const access = await accessStateAs(uid);
    const permit = snap.permits[0];
    const shotRecorded = snap.shots.length === 1;
    const applyAccepted = rows.filter((r) => r.op === "apply" && r.result === "accepted").length;
    const releaseWon = rows.filter((r) => r.op === "release" && r.result === "released").length;
    if (releaseWon > 1) violations.push(`H8 release succeeded ${releaseWon} times`);
    if (shotRecorded && !(permit.status === "finalized" && permit.outcome === "scored"))
      violations.push(`H8 shot recorded but permit ${permit.status}/${permit.outcome}`);
    if (!shotRecorded && !(permit.status === "finalized" && permit.outcome === "cancelled"))
      violations.push(`H8 no shot but permit ${permit.status}/${permit.outcome}`);
    if (shotRecorded && releaseWon > 0) violations.push(`H8 both release and apply settled ${p}`);
    if (shotRecorded && applyAccepted !== 2)
      violations.push(`H3 shot recorded but only ${applyAccepted}/2 apply lanes accepted`);
    if (!shotRecorded && applyAccepted !== 0)
      violations.push(`H3 apply accepted ${applyAccepted} but no shot row`);
    if (
      !shotRecorded &&
      !rows.filter((r) => r.op === "apply").every((r) => r.result === "access.permit_not_reserved")
    )
      violations.push(`H12 losers: ${rows.filter((r) => r.op === "apply").map((r) => r.result)}`);
    if (Number(access.scored_count) !== snap.shots.length)
      violations.push(`H6 scored_count ${access.scored_count} != ${snap.shots.length}`);
    if (Number(access.reserved_count) !== 0)
      violations.push(`H6 reserved_count ${access.reserved_count} != 0`);
    return {
      scenario: "cancel_vs_apply",
      seed,
      lanes: lanes.length,
      histogram: histogram(rows),
      wallMs,
      violations,
      outcome: violations.length ? "BROKEN" : "HELD",
      detail: { rows, snap, access },
    };
  },

  /** F2: releasing one of two live permits while N distinct-key reserves race for the freed slot. */
  async release_vs_reserve(seed) {
    const prng = new Prng(seed);
    const uid = prng.uuid();
    await createUser(uid, [{ provider: "google", sub: `g-${uid}` }]);
    await setPremium(uid, "none");
    const [p1] = await reservePermits(uid, ["p1", "p2"]);
    const n = prng.int(4, 10);
    const lanes = [
      {
        op: "release",
        uid,
        role: "user",
        delayMs: prng.int(0, 10),
        args: { permitId: p1, outcome: "cancelled" },
        run: (c) => releaseSql(c, p1, uid, "cancelled"),
      },
    ];
    for (let i = 0; i < n; i++) {
      const key = `r${i}`;
      lanes.push({
        op: "reserve",
        uid,
        role: "user",
        delayMs: prng.int(0, 10),
        args: { key },
        run: (c, row) => reserveRpc(c, key, row),
      });
    }
    const { rows, wallMs } = await burst(lanes);
    const violations = [];
    checkCommon(rows, wallMs, violations);
    const snap = await ownerSnapshot(uid);
    const access = await accessStateAs(uid);
    const accepted = rows.filter((r) => r.op === "reserve" && r.result === "accepted").length;
    const fresh = snap.permits.filter((p) => p.status === "reserved" && p.fresh).length;
    if (accepted > 1) violations.push(`H7 ${accepted} reserves accepted after a single release`);
    if (fresh > 2) violations.push(`H7 ${fresh} live reserved permits`);
    if (Number(access.reserved_count) !== fresh)
      violations.push(`H6 reserved_count ${access.reserved_count} != ${fresh}`);
    if (snap.permits.length !== 2 + accepted)
      violations.push(`H5 ${snap.permits.length} rows != ${2 + accepted}`);
    return {
      scenario: "release_vs_reserve",
      seed,
      lanes: lanes.length,
      histogram: histogram(rows),
      wallMs,
      violations,
      outcome: violations.length ? "BROKEN" : "HELD",
      detail: { rows, snap, access },
    };
  },

  /** F3: premium has no cap; the moment it expires every reserve is paywalled. */
  async premium_expiry(seed) {
    const prng = new Prng(seed);
    const uid = prng.uuid();
    await createUser(uid, [{ provider: "apple", sub: `a-${uid}` }]);
    await setPremium(uid, "active");
    const n = prng.int(6, 12);
    const r1 = await burst(
      Array.from({ length: n }, (_, i) => ({
        op: "reserve",
        uid,
        role: "user",
        delayMs: prng.int(0, 5),
        args: { key: `k${i}` },
        run: (c, row) => reserveRpc(c, `k${i}`, row),
      })),
    );
    const permitIds = r1.rows.map((r) => r.permitId).filter(Boolean);
    const r2 = await burst(
      permitIds.map((p) => {
        const shotId = prng.uuid();
        return {
          op: "apply",
          uid,
          role: "user",
          delayMs: prng.int(0, 5),
          args: { shotId, permitId: p, kind: "scored" },
          run: (c) => applyRpc(c, shotPayload(shotId, p, "scored")),
        };
      }),
    );
    await setPremium(uid, "expired");
    const r3 = await burst(
      Array.from({ length: 6 }, (_, i) => ({
        op: "reserve",
        uid,
        role: "user",
        delayMs: prng.int(0, 5),
        args: { key: `x${i}` },
        run: (c, row) => reserveRpc(c, `x${i}`, row),
      })),
    );
    const rows = [...r1.rows, ...r2.rows, ...r3.rows];
    const wallMs = r1.wallMs + r2.wallMs + r3.wallMs;
    const violations = [];
    checkCommon(rows, wallMs, violations);
    const snap = await ownerSnapshot(uid);
    const access = await accessStateAs(uid);
    if (r1.rows.some((r) => r.result !== "accepted"))
      violations.push(`premium reserve refused: ${JSON.stringify(histogram(r1.rows))}`);
    if (r2.rows.some((r) => r.result !== "accepted"))
      violations.push(`premium apply refused: ${JSON.stringify(histogram(r2.rows))}`);
    if (r3.rows.some((r) => r.result !== "access.paywall_required"))
      violations.push(
        `expired premium reserve not paywalled: ${JSON.stringify(histogram(r3.rows))}`,
      );
    if (snap.shots.length !== n) violations.push(`H4 ${snap.shots.length} shots != ${n}`);
    if (
      Number(access.scored_count) !== n ||
      access.premium !== false ||
      Number(access.reserved_count) !== 0
    )
      violations.push(`H6 access ${JSON.stringify(access)}`);
    const ledger = snap.ledger.map((l) => l.scored_count);
    if (ledger.join() !== String(n)) violations.push(`H11 ledger ${ledger} != ${n}`);
    return {
      scenario: "premium_expiry",
      seed,
      lanes: rows.length,
      histogram: histogram(rows),
      wallMs,
      violations,
      outcome: violations.length ? "BROKEN" : "HELD",
      detail: { rows, snap, access },
    };
  },

  /** F4: a reserved permit sitting exactly on the 24h boundary while an apply and reserves race. */
  async skew_boundary(seed) {
    const prng = new Prng(seed);
    const uid = prng.uuid();
    await createUser(uid, [{ provider: "google", sub: `g-${uid}` }]);
    await setPremium(uid, "none");
    await spendRatings(uid, 1, prng);
    const [p] = await reservePermits(uid, ["edge"]);
    const deltaMs = prng.int(-40, 40);
    await owner(
      `update public.analysis_permits set created_at = now() - interval '24 hours' + ($2::int * interval '1 millisecond') where id = $1`,
      [p, deltaMs],
    );
    const shotId = prng.uuid();
    const lanes = [
      {
        op: "apply",
        uid,
        role: "user",
        delayMs: prng.int(0, 30),
        args: { shotId, permitId: p, kind: "scored" },
        run: (c) => applyRpc(c, shotPayload(shotId, p, "scored")),
      },
      {
        op: "sweep",
        uid: null,
        role: "owner",
        delayMs: prng.int(0, 30),
        args: {},
        run: async (c) =>
          `swept=${(await c.query(`update public.analysis_permits set status='released', outcome='expired' where status='reserved' and created_at < now() - interval '24 hours'`)).rowCount}`,
      },
    ];
    for (let i = 0; i < 4; i++) {
      const key = `s${i}`;
      lanes.push({
        op: "reserve",
        uid,
        role: "user",
        delayMs: prng.int(0, 30),
        args: { key },
        run: (c, row) => reserveRpc(c, key, row),
      });
    }
    const { rows, wallMs } = await burst(lanes);
    const violations = [];
    checkCommon(rows, wallMs, violations);
    const snap = await ownerSnapshot(uid);
    const access = await accessStateAs(uid);
    const scored = snap.shots.filter((s) => s.result_kind === "scored").length;
    if (scored > 2) violations.push(`H1 ${scored} scored shots`);
    if (Number(access.scored_count) !== scored)
      violations.push(`H6 scored_count ${access.scored_count} != ${scored}`);
    const edge = snap.permits.find((x) => x.id === p);
    if (!["reserved", "finalized", "released"].includes(edge.status))
      violations.push(`H8 edge permit ${edge.status}`);
    const applyRes = rows.find((r) => r.op === "apply").result;
    if (applyRes === "accepted" && !(edge.status === "finalized" && edge.outcome === "scored"))
      violations.push(`H8 apply accepted but permit ${edge.status}/${edge.outcome}`);
    if (
      applyRes === "access.permit_expired" &&
      !(edge.status === "released" && edge.outcome === "expired")
    )
      violations.push(`H8 expired but permit ${edge.status}/${edge.outcome}`);
    const accepted = rows.filter((r) => r.op === "reserve" && r.result === "accepted").length;
    if (accepted > 1) violations.push(`H7 ${accepted} new reserves accepted with 1 rating left`);
    return {
      scenario: "skew_boundary",
      seed,
      lanes: lanes.length,
      deltaMs,
      histogram: histogram(rows),
      wallMs,
      violations,
      outcome: violations.length ? "BROKEN" : "HELD",
      detail: { rows, snap, access },
    };
  },

  /** F5: linking a second identity while a scored sync commits — the ledger
   * must leave every identity of the user at the same lifetime count. Random
   * timing per round; F5d below is the deterministic ordering. */
  async link_vs_scored(seed) {
    const prng = new Prng(seed);
    const uid = prng.uuid();
    await createUser(uid, [{ provider: "apple", sub: `a-${uid}` }]);
    await setPremium(uid, "none");
    await spendRatings(uid, 1, prng);
    const [p] = await reservePermits(uid, ["p"]);
    const shotId = prng.uuid();
    const sub = `g-${uid}`;
    await owner(
      `delete from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', $1)`,
      [sub],
    );
    const lanes = [
      {
        op: "apply",
        uid,
        role: "user",
        delayMs: prng.int(0, 6),
        args: { shotId, permitId: p, kind: "scored" },
        run: (c) => applyRpc(c, shotPayload(shotId, p, "scored")),
      },
      {
        op: "link_identity",
        uid,
        role: "owner",
        delayMs: prng.int(0, 6),
        args: { provider: "google", sub },
        run: async (c) => {
          await c.query(
            `insert into auth.identities (provider, provider_id, user_id, identity_data) values ('google', $1, $2, $3::jsonb)`,
            [sub, uid, JSON.stringify({ sub })],
          );
          return "linked";
        },
      },
    ];
    const { rows, wallMs } = await burst(lanes);
    const violations = [];
    checkCommon(rows, wallMs, violations);
    const snap = await ownerSnapshot(uid);
    const access = await accessStateAs(uid);
    const scored = snap.shots.filter((s) => s.result_kind === "scored").length;
    const vals = snap.ledger.map((l) => `${l.provider}=${l.scored_count ?? 0}`);
    if (new Set(snap.ledger.map((l) => l.scored_count ?? 0)).size !== 1)
      violations.push(
        `H11 identities out of step after link: ${vals.join(" ")} (scored shots ${scored})`,
      );
    if (Math.max(...snap.ledger.map((l) => l.scored_count ?? 0)) !== scored)
      violations.push(`H11 ledger max != scored ${scored}: ${vals.join(" ")}`);
    if (Number(access.scored_count) !== scored)
      violations.push(`H6 scored_count ${access.scored_count} != ${scored}`);
    return {
      scenario: "link_vs_scored",
      seed,
      lanes: lanes.length,
      histogram: histogram(rows),
      ledger: vals,
      wallMs,
      violations,
      outcome: violations.length ? "BROKEN" : "HELD",
      detail: { rows, snap, access },
    };
  },

  /** F5d: deterministic ordering of F5 — the scored sync's transaction is held
   * open while the identity link runs (GoTrue commits in its own transaction
   * and holds no advisory lock), then committed. Then the account is deleted
   * and re-created holding ONLY the late-linked identity: its lifetime count
   * must still be the spent total. */
  async link_vs_scored_ordered(seed) {
    const prng = new Prng(seed);
    const uid = prng.uuid();
    const appleSub = `a-${uid}`;
    const googleSub = `g-${uid}`;
    await createUser(uid, [{ provider: "apple", sub: appleSub }]);
    await owner(
      `delete from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', $1)`,
      [googleSub],
    );
    await setPremium(uid, "none");
    await spendRatings(uid, 1, prng);
    const [p] = await reservePermits(uid, ["p"]);
    const shotId = prng.uuid();
    const t0 = performance.now();
    const a = await pool.connect();
    const rows = [];
    let linkPromise;
    try {
      await a.query("begin");
      await a.query(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
      await asUser(a, uid);
      const applied = await applyRpc(a, shotPayload(shotId, p, "scored"));
      rows.push({
        lane: 0,
        op: "apply",
        uid,
        role: "user",
        args: { shotId, permitId: p },
        result: applied,
      });
      // identity link starts while the sync is uncommitted
      linkPromise = (async () => {
        const b = await pool.connect();
        try {
          await b.query("begin");
          await b.query(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
          await b.query(
            `insert into auth.identities (provider, provider_id, user_id, identity_data) values ('google', $1, $2, $3::jsonb)`,
            [googleSub, uid, JSON.stringify({ sub: googleSub })],
          );
          await b.query("commit");
          return {
            lane: 1,
            op: "link_identity",
            uid,
            role: "owner",
            args: { provider: "google", sub: googleSub },
            result: "linked",
          };
        } catch (e) {
          await b.query("rollback").catch(() => {});
          return {
            lane: 1,
            op: "link_identity",
            uid,
            role: "owner",
            args: {},
            result: "ERROR",
            sqlstate: e.code,
            error: String(e.message),
          };
        } finally {
          b.release();
        }
      })();
      await sleep(150); // let the link reach the ledger write (it blocks on the sync's ledger row)
      await a.query("commit");
    } finally {
      a.release();
    }
    rows.push(await linkPromise);
    const wallMs = Math.round(performance.now() - t0);
    const violations = [];
    checkCommon(rows, wallMs, violations);
    const snap = await ownerSnapshot(uid);
    const scored = snap.shots.filter((s) => s.result_kind === "scored").length;
    const vals = snap.ledger.map((l) => `${l.provider}=${l.scored_count ?? 0}`);
    if (new Set(snap.ledger.map((l) => l.scored_count ?? 0)).size !== 1)
      violations.push(
        `H11 identities out of step after link: ${vals.join(" ")} (scored shots ${scored})`,
      );
    // delete the account, sign in again holding ONLY the late-linked identity
    await owner(`delete from auth.users where id = $1`, [uid]);
    const uid2 = prng.uuid();
    await createUser(uid2, [{ provider: "google", sub: googleSub }], { keepLedger: true });
    const access2 = await accessStateAs(uid2);
    const reserve2 = await burst([
      {
        op: "reserve",
        uid: uid2,
        role: "user",
        args: { key: "again" },
        run: (c, row) => reserveRpc(c, "again", row),
      },
    ]);
    rows.push(...reserve2.rows);
    if (Number(access2.scored_count) !== scored)
      violations.push(
        `H1 recreated account (google only) sees scored_count ${access2.scored_count}, identity spent ${scored}`,
      );
    if (scored >= 2 && reserve2.rows[0].result !== "access.paywall_required")
      violations.push(
        `H1 recreated account reserved a permit after ${scored} spent ratings (${reserve2.rows[0].result})`,
      );
    await owner(`delete from auth.users where id = $1`, [uid2]);
    return {
      scenario: "link_vs_scored_ordered",
      seed,
      lanes: rows.length,
      histogram: histogram(rows),
      ledger: vals,
      recreated: { scored_count: Number(access2.scored_count), reserve: reserve2.rows[0].result },
      wallMs,
      violations,
      outcome: violations.length ? "BROKEN" : "HELD",
      detail: { rows, snap, access2 },
    };
  },

  /** F6: account deletion in the middle of a burst; the recreated account's
   * lifetime count must include every scored sync that was accepted. */
  async delete_during_burst(seed) {
    const prng = new Prng(seed);
    const uid = prng.uuid();
    const sub = `a-${uid}`;
    await createUser(uid, [{ provider: "apple", sub }]);
    await setPremium(uid, "none");
    await spendRatings(uid, 1, prng);
    const [p1] = await reservePermits(uid, ["p1"]);
    const shotId = prng.uuid();
    const lanes = [
      {
        op: "apply",
        uid,
        role: "user",
        delayMs: prng.int(0, 10),
        args: { shotId, permitId: p1, kind: "scored" },
        run: (c) => applyRpc(c, shotPayload(shotId, p1, "scored")),
      },
      {
        op: "delete_user",
        uid: null,
        role: "owner",
        delayMs: prng.int(0, 10),
        args: { uid },
        run: async (c) =>
          `deleted=${(await c.query(`delete from auth.users where id = $1`, [uid])).rowCount}`,
      },
    ];
    for (let i = 0; i < 3; i++) {
      const key = `d${i}`;
      lanes.push({
        op: "reserve",
        uid,
        role: "user",
        delayMs: prng.int(0, 10),
        args: { key },
        run: (c, row) => reserveRpc(c, key, row),
      });
    }
    const { rows, wallMs } = await burst(lanes);
    const violations = [];
    checkCommon(rows, wallMs, violations, { allowedSqlstates: new Set(["23503"]) });
    const applyRes = rows.find((r) => r.op === "apply").result;
    const ledgerBefore =
      (
        await owner(
          `select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple', $1)`,
          [sub],
        )
      )[0]?.scored_count ?? 0;
    const expectedSpent = 1 + (applyRes === "accepted" ? 1 : 0);
    if (ledgerBefore !== expectedSpent)
      violations.push(
        `H11 ledger ${ledgerBefore} != accepted scored syncs ${expectedSpent} (apply → ${applyRes})`,
      );
    const uid2 = prng.uuid();
    await createUser(uid2, [{ provider: "apple", sub }], { keepLedger: true });
    const access2 = await accessStateAs(uid2);
    const again = await burst([
      {
        op: "reserve",
        uid: uid2,
        role: "user",
        args: { key: "again" },
        run: (c, row) => reserveRpc(c, "again", row),
      },
    ]);
    rows.push(...again.rows);
    if (Number(access2.scored_count) !== expectedSpent)
      violations.push(`H6 recreated scored_count ${access2.scored_count} != ${expectedSpent}`);
    if (expectedSpent >= 2 && again.rows[0].result !== "access.paywall_required")
      violations.push(`H1 recreated account reserved after ${expectedSpent} spent`);
    if (expectedSpent < 2 && again.rows[0].result !== "accepted")
      violations.push(
        `recreated account with ${expectedSpent} spent could not reserve (${again.rows[0].result})`,
      );
    await owner(`delete from auth.users where id = $1`, [uid2]);
    return {
      scenario: "delete_during_burst",
      seed,
      lanes: rows.length,
      histogram: histogram(rows),
      wallMs,
      violations,
      outcome: violations.length ? "BROKEN" : "HELD",
      detail: { rows, access2, ledgerBefore },
    };
  },

  /** F7: the RPCs document READ COMMITTED (PostgREST's default). Run the
   * same-key / distinct-key reserve bursts and an over-issued apply burst
   * under REPEATABLE READ and SERIALIZABLE and record what happens. The hard
   * invariant (<= 2 scored shots) is asserted; serialization errors (40001)
   * are recorded, not counted as failures — they are the isolation level
   * doing its job and PostgREST retries nothing here. */
  async isolation_levels(seed) {
    const prng = new Prng(seed);
    const out = {};
    const violations = [];
    const rowsAll = [];
    let total = 0;
    let wall = 0;
    for (const isolation of ["repeatable read", "serializable"]) {
      const uid = prng.uuid();
      await createUser(uid, [{ provider: "google", sub: `g-${uid}` }]);
      await setPremium(uid, "none");
      const same = await burst(
        Array.from({ length: 6 }, () => ({
          op: "reserve",
          uid,
          role: "user",
          delayMs: prng.int(0, 3),
          args: { key: "same" },
          run: (c, row) => reserveRpc(c, "same", row),
        })),
        { isolation },
      );
      const diff = await burst(
        Array.from({ length: 6 }, (_, i) => ({
          op: "reserve",
          uid,
          role: "user",
          delayMs: prng.int(0, 3),
          args: { key: `d${i}` },
          run: (c, row) => reserveRpc(c, `d${i}`, row),
        })),
        { isolation },
      );
      const snap1 = await ownerSnapshot(uid);
      // over-issue: 4 owner-minted permits, 4 concurrent scored applies
      const uid2 = prng.uuid();
      await createUser(uid2, [{ provider: "google", sub: `g-${uid2}` }]);
      await setPremium(uid2, "none");
      const permits = [];
      for (let i = 0; i < 4; i++) permits.push(await ownerInsertPermit(uid2, `o${i}`));
      const applies = await burst(
        permits.map((p) => {
          const shotId = prng.uuid();
          return {
            op: "apply",
            uid: uid2,
            role: "user",
            delayMs: prng.int(0, 3),
            args: { shotId, permitId: p, kind: "scored" },
            run: (c) => applyRpc(c, shotPayload(shotId, p, "scored")),
          };
        }),
        { isolation },
      );
      const snap2 = await ownerSnapshot(uid2);
      const scored2 = snap2.shots.filter((s) => s.result_kind === "scored").length;
      const errs = [...same.rows, ...diff.rows, ...applies.rows].filter(
        (r) => r.result === "ERROR",
      );
      // 40001 (serialization) and 23505 (the post-lock idempotency re-check
      // reads a snapshot older than the winner's commit) are what these
      // isolation levels do to code written for READ COMMITTED; they are
      // recorded per level below, not counted as invariant breaks.
      for (const r of errs)
        if (r.sqlstate !== "40001" && r.sqlstate !== "23505")
          violations.push(`H10 ${isolation} ${r.op} SQLSTATE ${r.sqlstate}`);
      if (scored2 > 2)
        violations.push(`H1 ${isolation}: ${scored2} scored shots from 4 over-issued permits`);
      const sameIds = new Set(
        same.rows.filter((r) => r.result === "accepted").map((r) => r.permitId),
      );
      if (sameIds.size > 1)
        violations.push(`H2 ${isolation}: same key minted ${sameIds.size} permits`);
      out[isolation] = {
        same_key: histogram(same.rows),
        distinct_key: histogram(diff.rows),
        distinct_key_permits_minted: snap1.permits.length,
        over_issued_apply: histogram(applies.rows),
        scored_shots_from_4_permits: scored2,
        ledger: snap2.ledger.map((l) => l.scored_count),
        serialization_failures_40001: errs.filter((r) => r.sqlstate === "40001").length,
        unique_violations_23505: errs.filter((r) => r.sqlstate === "23505").length,
        errors: errs.map((r) => `${r.op}:${r.sqlstate}`),
      };
      rowsAll.push(...same.rows, ...diff.rows, ...applies.rows);
      total += same.rows.length + diff.rows.length + applies.rows.length;
      wall += same.wallMs + diff.wallMs + applies.wallMs;
    }
    return {
      scenario: "isolation_levels",
      seed,
      lanes: total,
      histogram: histogram(rowsAll),
      isolation: out,
      wallMs: wall,
      violations,
      outcome: violations.length ? "BROKEN" : "HELD",
      detail: { isolation: out, rows: rowsAll },
    };
  },

  /** F8: logout / rotation during a request — lanes whose JWT subject is
   * empty (revoked session), anon-role lanes, and a lane whose subject
   * switches mid-transaction (a pooled connection re-used by another user)
   * must never write under the wrong principal. */
  async rotation_logout(seed) {
    const prng = new Prng(seed);
    const a = prng.uuid();
    const b = prng.uuid();
    await createUser(a, [{ provider: "apple", sub: `a-${a}` }]);
    await createUser(b, [{ provider: "google", sub: `g-${b}` }]);
    await setPremium(a, "none");
    await setPremium(b, "none");
    const lanes = [
      {
        op: "reserve",
        uid: a,
        role: "user",
        delayMs: prng.int(0, 5),
        args: { key: "ka" },
        run: (c, row) => reserveRpc(c, "ka", row),
      },
      {
        op: "reserve",
        uid: null,
        role: "noauth",
        delayMs: prng.int(0, 5),
        args: { key: "logged-out", noauth: true },
        run: (c, row) => reserveRpc(c, "logged-out", row),
      },
      {
        op: "reserve",
        uid: null,
        role: "anon",
        delayMs: prng.int(0, 5),
        args: { key: "anon" },
        run: (c, row) => reserveRpc(c, "anon", row),
      },
      {
        op: "access_state",
        uid: null,
        role: "noauth",
        delayMs: prng.int(0, 5),
        args: {},
        run: (c, row) => accessStateRpc(c, row),
      },
      {
        op: "rotate_mid_txn",
        uid: a,
        role: "user",
        delayMs: prng.int(0, 5),
        args: { from: a, to: b },
        run: async (c, row) => {
          const first = await reserveRpc(c, "rot-1", row);
          const firstPermit = row.permitId;
          await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [b]);
          const second = await reserveRpc(c, "rot-2", row);
          const whoOwnsSecond = row.permitId
            ? (
                await c.query(`select user_id from public.analysis_permits where id = $1`, [
                  row.permitId,
                ])
              ).rows[0]?.user_id
            : null;
          const seeFirst = firstPermit
            ? (
                await c.query(
                  `select count(*)::int as n from public.analysis_permits where id = $1`,
                  [firstPermit],
                )
              ).rows[0].n
            : null;
          return `${first}/${second}/second_owner=${whoOwnsSecond === b ? "B" : whoOwnsSecond === a ? "A" : "none"}/first_visible_as_B=${seeFirst}`;
        },
      },
    ];
    const { rows, wallMs } = await burst(lanes);
    const violations = [];
    checkCommon(rows, wallMs, violations);
    const rot = rows.find((r) => r.op === "rotate_mid_txn").result;
    if (rot !== "accepted/accepted/second_owner=B/first_visible_as_B=0")
      violations.push(`H9 rotation lane: ${rot}`);
    const snapA = await ownerSnapshot(a);
    const snapB = await ownerSnapshot(b);
    if (snapA.permits.length !== 2)
      violations.push(`H5 A has ${snapA.permits.length} permits (expected ka + rot-1)`);
    if (snapB.permits.length !== 1 || snapB.permits[0].idempotency_key !== "rot-2")
      violations.push(
        `H9 B permits ${JSON.stringify(snapB.permits.map((p) => p.idempotency_key))}`,
      );
    if (
      (
        await owner(
          `select count(*)::int as n from public.analysis_permits where idempotency_key in ('logged-out','anon')`,
        )
      )[0].n !== 0
    )
      violations.push(`H9 unauthenticated lane minted a permit`);
    const noauthAccess = rows.find((r) => r.op === "access_state").access;
    if (noauthAccess !== "premium=false scored=0 reserved=0")
      violations.push(`H9 unauthenticated access_state → ${noauthAccess}`);
    return {
      scenario: "rotation_logout",
      seed,
      lanes: lanes.length,
      histogram: histogram(rows),
      wallMs,
      violations,
      outcome: violations.length ? "BROKEN" : "HELD",
      detail: { rows, snapA, snapB },
    };
  },
};

// ── driver ──────────────────────────────────────────────────────────────────

function heap() {
  const m = process.memoryUsage();
  return {
    rssMb: +(m.rss / 1048576).toFixed(1),
    heapUsedMb: +(m.heapUsed / 1048576).toFixed(1),
    heapTotalMb: +(m.heapTotal / 1048576).toFixed(1),
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const t0 = performance.now();
  await owner("select 1");
  const table = [];
  const plan = [];
  if (REPLAY) {
    const [scenario, seedStr] = REPLAY.split(":");
    if (!scenarios[scenario])
      throw new Error(`unknown scenario ${scenario}; known: ${Object.keys(scenarios).join(", ")}`);
    plan.push({ scenario, seed: Number(seedStr) >>> 0, i: 0 });
  } else {
    for (let i = 0; i < ITER; i++) plan.push({ scenario: "mixed", seed: iterSeed("mixed", i), i });
    for (const name of Object.keys(scenarios)) {
      if (name === "mixed") continue;
      for (let i = 0; i < ROUNDS; i++) plan.push({ scenario: name, seed: iterSeed(name, i), i });
    }
  }
  const failures = [];
  const heapSamples = [];
  let idx = 0;
  for (const step of plan) {
    idx += 1;
    let res;
    try {
      res = await scenarios[step.scenario](step.seed);
    } catch (e) {
      res = {
        scenario: step.scenario,
        seed: step.seed,
        lanes: 0,
        histogram: {},
        wallMs: 0,
        violations: [`HARNESS ERROR ${e.code ?? ""} ${String(e.message ?? e).slice(0, 300)}`],
        outcome: "BROKEN",
        detail: { stack: String(e.stack ?? "").slice(0, 2000) },
      };
    }
    const { detail, ...row } = res;
    row.i = step.i;
    row.replay = `STRESS_PG_URL=… STRESS_REPLAY=${step.scenario}:${step.seed} node supabase/tests/stress/access_permits_concurrency.mjs`;
    table.push(row);
    if (row.outcome === "BROKEN" || REPLAY) {
      const file = path.join(OUT_DIR, `iter_${step.scenario}_${step.seed}.json`);
      fs.writeFileSync(file, JSON.stringify({ ...row, detail }, null, 2));
      row.artifact = path.relative(ROOT, file);
      if (row.outcome === "BROKEN") failures.push(row);
    }
    if (idx % 50 === 0 || idx === plan.length) heapSamples.push({ idx, ...heap() });
    const mark = row.outcome === "HELD" ? "ok  " : "FAIL";
    console.log(
      `${mark} ${row.scenario.padEnd(24)} #${String(step.i).padStart(3)} seed=${row.seed} lanes=${row.lanes} ${row.wallMs}ms ${JSON.stringify(row.histogram)}${row.violations.length ? "\n     " + row.violations.join("\n     ") : ""}`,
    );
  }
  const scenariosExecuted = table.reduce((s, r) => s + r.lanes, 0);
  const summary = {
    rootSeed: ROOT_SEED,
    iter: ITER,
    rounds: ROUNDS,
    laneMax: LANE_MAX,
    iterations: table.length,
    lanesExecuted: scenariosExecuted,
    held: table.filter((r) => r.outcome === "HELD").length,
    broken: failures.length,
    brokenByScenario: Object.fromEntries(
      Object.keys(scenarios).map((s) => [s, failures.filter((f) => f.scenario === s).length]),
    ),
    iterationsByScenario: Object.fromEntries(
      Object.keys(scenarios).map((s) => [s, table.filter((f) => f.scenario === s).length]),
    ),
    maxWallMs: Math.max(0, ...table.map((r) => r.wallMs)),
    totalMs: Math.round(performance.now() - t0),
    heap: heapSamples,
    pgVersion: (await owner("select version()"))[0].version,
    failingSeeds: failures.map((f) => ({
      scenario: f.scenario,
      seed: f.seed,
      violations: f.violations,
    })),
  };
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(table, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(
    `\n${summary.held}/${summary.iterations} iterations HELD, ${summary.broken} BROKEN, ${scenariosExecuted} lanes, ${summary.totalMs}ms → ${path.relative(ROOT, OUT_DIR)}/`,
  );
  await pool.end();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(2);
});
