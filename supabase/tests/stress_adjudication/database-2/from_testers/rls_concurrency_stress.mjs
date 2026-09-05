#!/usr/bin/env node
/**
 * db-rls-matrix × concurrency — seeded two-user stress harness.
 *
 * Drives the REAL schema (shim_auth.sql + shim_hosted_uid.sql + every
 * migration, see ./pg_up.sh) with N independent `pg` connections. Every lane
 * runs its own transaction as role `authenticated` with a hosted-shaped
 * `request.jwt.claims` JSON (sub = the lane's user), waits on a barrier and
 * fires after a seeded jitter, so per-user advisory locks, row locks and RLS
 * genuinely contend between two users (A, B) plus an anon lane.
 *
 * Every iteration is replayable from its seed:
 *   STRESS_PG_URL=... STRESS_ITER_SEED=<iterSeed> node rls_concurrency_stress.mjs
 *
 * Campaign:
 *   STRESS_PG_URL=... STRESS_SEED=<campaignSeed> STRESS_ITER=<n> node rls_concurrency_stress.mjs
 *
 * Env:
 *   STRESS_PG_URL     required, throwaway postgres (never a hosted project)
 *   STRESS_SEED       campaign seed (default 1)
 *   STRESS_ITER       iterations (default 24 — fast enough for the suite)
 *   STRESS_ITER_SEED  replay exactly one iteration seed (overrides the two above)
 *   STRESS_SCENARIO   restrict the scheduler to one scenario name
 *   STRESS_OUT        directory for results.json / failures (default ./out)
 *   STRESS_LANE_TIMEOUT_MS  per-statement bound (default 8000); a hit is a finding
 *   STRESS_ITER_TIMEOUT_MS  per-iteration wall bound (default 30000)
 *
 * Exit code: 0 when every executed iteration PASSED, 1 when any FAILED or
 * ERRORED, 2 on harness misconfiguration.
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..", "..", "..");
// `pg` is a workspace dependency of packages/database (pnpm keeps it there);
// resolve it from that package so this file adds no new dependency.
const require = createRequire(join(ROOT, "packages", "database", "package.json"));
const pg = require("pg");

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const PG_URL = process.env.STRESS_PG_URL ?? "";
if (!PG_URL) {
  console.error("STRESS_PG_URL is required (run ./pg_up.sh first)");
  process.exit(2);
}
if (!/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(PG_URL)) {
  console.error("STRESS_PG_URL must point at 127.0.0.1/localhost (throwaway only)");
  process.exit(2);
}
const CAMPAIGN_SEED = Number(process.env.STRESS_SEED ?? 1);
const ITER = Number(process.env.STRESS_ITER ?? 24);
const ITER_SEED = process.env.STRESS_ITER_SEED ? Number(process.env.STRESS_ITER_SEED) : null;
const ONLY_SCENARIO = process.env.STRESS_SCENARIO ?? "";
const OUT_DIR = resolve(process.env.STRESS_OUT ?? join(HERE, "out"));
const LANE_TIMEOUT_MS = Number(process.env.STRESS_LANE_TIMEOUT_MS ?? 8000);
const ITER_TIMEOUT_MS = Number(process.env.STRESS_ITER_TIMEOUT_MS ?? 30000);
const KEEP_ROWS = process.env.STRESS_KEEP === "1";
// free_rating_ledger rows outlive the account on purpose, so a replay of the
// same seed against the same database must not reuse the sign-in identity —
// the identity subject carries a per-process nonce; everything else is seeded.
const RUN_NONCE = process.pid.toString(36) + Date.now().toString(36);
const MAX_LANES = 16;

// ─────────────────────────────────────────────────────────────────────────────
// Seeded PRNG (mulberry32) + per-iteration seed derivation (splitmix-ish)
// ─────────────────────────────────────────────────────────────────────────────
class Prng {
  constructor(seed) {
    this.s = seed >>> 0;
  }
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo, hi) {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick(arr) {
    return arr[this.int(0, arr.length - 1)];
  }
  bool(p = 0.5) {
    return this.next() < p;
  }
  uuid() {
    const b = new Uint8Array(16);
    for (let i = 0; i < 16; i++) b[i] = this.int(0, 255);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}
function deriveIterSeed(campaignSeed, i) {
  let x = (campaignSeed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Connections
// ─────────────────────────────────────────────────────────────────────────────
async function connect(n) {
  const clients = [];
  for (let i = 0; i < n; i++) {
    const c = new pg.Client({ connectionString: PG_URL });
    await c.connect();
    clients.push(c);
  }
  return clients;
}

const claims = (uid) => JSON.stringify({ sub: uid, role: "authenticated", aud: "authenticated" });

/**
 * A lane: one transaction on one connection. `setup` runs before the barrier
 * (BEGIN + role + claims), `op` fires after it. Never throws: errors are
 * returned as { error: { code, message } } so invariants can be asserted on
 * the whole burst. Always ends the transaction (COMMIT unless op asked for
 * ROLLBACK or errored → ROLLBACK).
 */
async function lane(client, { isolation, user, role, jitterMs, barrier, op, commit = true }) {
  const out = { user: user ? user.tag : role, role, isolation, jitterMs };
  const t0 = Date.now();
  try {
    await client.query(`begin isolation level ${isolation}`);
    await client.query(`set local statement_timeout = ${LANE_TIMEOUT_MS}`);
    await client.query(`set local lock_timeout = ${LANE_TIMEOUT_MS}`);
    await client.query(`set local role ${role}`);
    if (user) {
      await client.query("select set_config('request.jwt.claims', $1, true)", [claims(user.id)]);
    } else {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ role }),
      ]);
    }
    await barrier.wait();
    if (jitterMs > 0) await sleep(jitterMs);
    const t1 = Date.now();
    out.startMs = t1;
    out.result = await op(client, user);
    out.endMs = Date.now();
    await client.query(commit ? "commit" : "rollback");
    out.committed = commit;
  } catch (e) {
    // A statement error and a COMMIT error look the same to the caller, but
    // only the first leaves `result` unset: a lane that produced a result and
    // then failed to commit has no side effects, so its result must not count
    // towards any invariant (SERIALIZABLE aborts land here).
    out.committed = false;
    out.endMs = out.endMs ?? Date.now();
    out.error = { code: e.code ?? null, message: String(e.message).slice(0, 200) };
    try {
      await client.query("rollback");
    } catch {
      /* connection in unknown state; the campaign reconnects it */
      out.connectionBroken = true;
    }
  }
  out.durationMs = out.endMs - t0;
  return out;
}

function makeBarrier(n) {
  let count = 0;
  let release;
  const p = new Promise((r) => (release = r));
  return {
    wait() {
      count += 1;
      if (count >= n) release();
      return p;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner-side fixtures (run as the connection owner = table owner; auth.uid() is
// NULL there exactly like a service-role write on hosted Supabase)
// ─────────────────────────────────────────────────────────────────────────────
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

function shotPayload(id, permitId, o = {}) {
  const scored = o.resultKind !== "low_confidence";
  return {
    id,
    analysisPermitId: permitId,
    sessionId: o.sessionId ?? null,
    shotType: o.shotType ?? "forehand_drive",
    cameraView: "side",
    capturedAt: o.capturedAt ?? new Date().toISOString(),
    startMs: 0,
    contactMs: 400,
    endMs: 900,
    overallScore: scored ? (o.overallScore ?? 7.25) : null,
    confidence: scored ? 0.91 : 0.2,
    resultKind: scored ? "scored" : "low_confidence",
    versionVector: VERSION_VECTOR,
    phases: o.phases ?? [
      { key: "prepare", startMs: 0, representativeMs: 100, endMs: 300, confidence: 0.9 },
      { key: "contact", startMs: 300, representativeMs: 400, endMs: 500, confidence: 0.95 },
    ],
    checkpoints: o.checkpoints ?? [
      {
        key: "paddle_prep",
        score: 70,
        confidence: 0.9,
        band: "green",
        direction: "ok",
        severity: 0.1,
        applicable: true,
      },
    ],
  };
}

async function mkUser(owner, rng, tag, opts = {}) {
  const id = rng.uuid();
  const provider = opts.provider ?? rng.pick(["apple", "google"]);
  const providerId = `stress-${RUN_NONCE}-${tag}-${rng.uuid()}`;
  await owner.query(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ($1, $2, jsonb_build_object('provider', $3::text))`,
    [id, `${tag}-${id.slice(0, 8)}@stress.local`, provider],
  );
  await owner.query(
    `insert into auth.identities (provider_id, user_id, identity_data, provider)
     values ($1, $2, jsonb_build_object('sub', $1::text), $3)`,
    [providerId, id, provider],
  );
  return { id, tag, provider, providerId };
}

async function seedScoredShots(owner, user, n, rng) {
  for (let i = 0; i < n; i++) {
    await owner.query(
      `insert into public.shots (
         id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
         overall_score, analysis_confidence, result_kind, app_version, model_bundle_version,
         pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version,
         scoring_model_version, shot_config_version, source)
       values ($1, $2, 'forehand_drive', 'side', now() - interval '1 day', 0, 400, 900,
         6.5, 0.9, 'scored', '1.0.0', 'b', 'p', 'pa', 's', 'ph', 'sc', 'c', 'real')`,
      [rng.uuid(), user.id],
    );
  }
}

async function seedLegacyPermits(owner, user, n, rng) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = await owner.query(
      `insert into public.analysis_permits (user_id, idempotency_key) values ($1, $2) returning id`,
      [user.id, `legacy-${rng.uuid()}`],
    );
    ids.push(r.rows[0].id);
  }
  return ids;
}

async function setPremium(owner, user, { expiresAt = null } = {}) {
  await owner.query(
    `insert into public.billing_entitlements (user_id, premium, expires_at)
     values ($1, true, $2)
     on conflict (user_id) do update set premium = true, expires_at = excluded.expires_at`,
    [user.id, expiresAt],
  );
}

async function userState(owner, user) {
  const r = await owner.query(
    `select
       (select count(*)::int from public.shots where user_id = $1 and result_kind = 'scored') as scored,
       (select count(*)::int from public.shots where user_id = $1) as shots,
       (select count(*)::int from public.analysis_permits where user_id = $1 and status = 'reserved'
          and created_at > now() - interval '24 hours') as reserved,
       (select count(*)::int from public.analysis_permits where user_id = $1) as permits,
       (select count(*)::int from public.analysis_permits where user_id = $1 and status = 'finalized') as finalized,
       (select count(*)::int from public.sessions where user_id = $1) as sessions,
       (select coalesce(array_agg(l.scored_count order by i.provider), '{}') from auth.identities i
          left join public.free_rating_ledger l
            on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
          where i.user_id = $1) as ledger,
       (select count(*)::int from auth.identities where user_id = $1) as identities,
       exists(select 1 from public.profiles where id = $1) as profile_exists`,
    [user.id],
  );
  return r.rows[0];
}

async function asUserScalar(owner, user, sql) {
  // Evaluate an RLS-scoped expression as the user (own transaction, rolled back).
  await owner.query("begin");
  try {
    await owner.query("set local role authenticated");
    await owner.query("select set_config('request.jwt.claims', $1, true)", [claims(user.id)]);
    const r = await owner.query(sql);
    return r.rows[0];
  } finally {
    await owner.query("rollback");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ops (what a lane fires after the barrier)
// ─────────────────────────────────────────────────────────────────────────────
const ops = {
  reserve: (key) => async (c) => {
    const r = await c.query("select * from public.reserve_analysis_permit($1)", [key]);
    return { op: "reserve", key, result: r.rows[0].result, permitId: r.rows[0].permit_id };
  },
  sync: (payload) => async (c) => {
    const r = await c.query("select public.apply_synced_shot($1::jsonb) as r", [
      JSON.stringify(payload),
    ]);
    return {
      op: "sync",
      shotId: payload.id,
      permitId: payload.analysisPermitId,
      resultKind: payload.resultKind,
      result: r.rows[0].r,
    };
  },
  access: () => async (c) => {
    const r = await c.query("select * from public.access_state()");
    return { op: "access", ...r.rows[0] };
  },
  sql:
    (label, text, params = []) =>
    async (c) => {
      const r = await c.query(text, params);
      return { op: label, rowCount: r.rowCount, rows: r.rows.slice(0, 4) };
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// Invariant helpers
// ─────────────────────────────────────────────────────────────────────────────
function violation(list, name, detail) {
  list.push({ name, detail });
}
/**
 * Count expectation. Under READ COMMITTED (what PostgREST runs) the count is
 * exact. Under SERIALIZABLE — which no code path claims; we run it as a bonus —
 * lanes may be aborted with 40001 (retryable), so `got` may fall short of
 * `want` but must never exceed it.
 */
function expectCount(ctx, name, got, want, detail) {
  const ok = ctx.isolation === "serializable" ? got <= want : got === want;
  if (!ok) violation(ctx.v, name, { got, want, ...detail });
}
const RETRYABLE = new Set(["shot.write_failed:40001"]);
function nonRetryable(arr) {
  return arr.filter((r) => !RETRYABLE.has(r));
}
function laneErrors(lanes) {
  return lanes.filter((l) => l.error);
}
/** Lanes whose work actually landed (result produced AND transaction committed). */
function committedLanes(lanes, pred = () => true) {
  return lanes.filter((l) => l.committed && l.result && pred(l));
}
function results(lanes, pred = () => true) {
  return lanes.filter((l) => !l.error && pred(l)).map((l) => l.result.result);
}
function count(arr, v) {
  return arr.filter((x) => x === v).length;
}
function checkNoDeadlockOrTimeout(v, lanes) {
  for (const l of laneErrors(lanes)) {
    if (l.error.code === "40P01") violation(v, "deadlock_detected", l);
    if (l.error.code === "57014" || l.error.code === "55P03") violation(v, "lane_timeout", l);
  }
  for (const l of lanes) {
    if (l.durationMs > LANE_TIMEOUT_MS + 2000) violation(v, "lane_wall_time_exceeded", l);
  }
}
async function checkLedgerConsistency(v, owner, user, label = "") {
  const st = await userState(owner, user);
  // Every identity of a user must carry the SAME count, equal to the user's
  // scored shots (fresh identities → ledger == scored). AGENTS.md: "every
  // identity of the user is set to identity-max + 1".
  const counts = st.ledger.map((x) => (x === null ? 0 : x));
  const want = st.scored;
  if (counts.some((c) => c !== want)) {
    violation(v, "ledger_out_of_step" + label, { user: user.tag, ledger: counts, scored: want });
  }
  return st;
}
async function checkFreeLimit(v, owner, user, { premium = false, legacyPermits = 0 } = {}) {
  const st = await userState(owner, user);
  if (!premium) {
    if (st.scored > 2) violation(v, "free_limit_exceeded", { user: user.tag, ...st });
    if (legacyPermits === 0 && st.scored + st.reserved > 2) {
      violation(v, "scored_plus_reserved_exceeds_2", { user: user.tag, ...st });
    }
  }
  return st;
}
async function checkNoOrphans(v, owner) {
  const r = await owner.query(`
    select 'shots' t, count(*)::int n from public.shots s where not exists (select 1 from public.profiles p where p.id = s.user_id)
    union all select 'analysis_permits', count(*)::int from public.analysis_permits s where not exists (select 1 from public.profiles p where p.id = s.user_id)
    union all select 'sessions', count(*)::int from public.sessions s where not exists (select 1 from public.profiles p where p.id = s.user_id)
    union all select 'shot_phases', count(*)::int from public.shot_phases s where not exists (select 1 from public.profiles p where p.id = s.user_id)
    union all select 'shot_checkpoints', count(*)::int from public.shot_checkpoints s where not exists (select 1 from public.profiles p where p.id = s.user_id)
    union all select 'consent_records', count(*)::int from public.consent_records s where not exists (select 1 from public.profiles p where p.id = s.user_id)
    union all select 'profiles_without_auth_user', count(*)::int from public.profiles s where not exists (select 1 from auth.users u where u.id = s.id)
  `);
  for (const row of r.rows) if (row.n > 0) violation(v, "orphan_rows", row);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios. Each returns { lanes, params, violations }.
// ─────────────────────────────────────────────────────────────────────────────
const scenarios = {};

/** S1 — same idempotency key ×N for A, while B reserves the SAME key text. */
scenarios.permit_same_key = async (ctx) => {
  const {
    rng,
    owner,
    users: [A, B],
    v,
  } = ctx;
  const key = `k-${rng.uuid()}`;
  const nA = rng.int(3, 10);
  const nB = rng.int(1, 4);
  const specs = [
    ...Array.from({ length: nA }, () => ({ user: A, op: ops.reserve(key) })),
    ...Array.from({ length: nB }, () => ({ user: B, op: ops.reserve(key) })),
  ];
  const lanes = await ctx.burst(specs);
  const rA = lanes.filter((l) => l.user === "A");
  const rB = lanes.filter((l) => l.user === "B");
  // Under SERIALIZABLE a lane may abort with 40001 and be retried by the
  // caller; that is not an anomaly. Everything else is.
  const fatal = laneErrors(lanes).filter(
    (l) => !(ctx.isolation === "serializable" && l.error.code === "40001"),
  );
  if (fatal.length) violation(v, "lane_error", fatal);
  if (results(rA).some((r) => r !== "accepted"))
    violation(v, "same_key_not_all_accepted", results(rA));
  const idsA = new Set(rA.filter((l) => !l.error).map((l) => l.result.permitId));
  const idsB = new Set(rB.filter((l) => !l.error).map((l) => l.result.permitId));
  // One key ⇒ at most one permit id, and exactly one when any lane committed.
  if (idsA.size > 1) violation(v, "same_key_multiple_permit_ids", [...idsA]);
  if (idsB.size > 1) violation(v, "same_key_multiple_permit_ids_B", [...idsB]);
  if (ctx.isolation !== "serializable" && (idsA.size !== 1 || idsB.size !== 1)) {
    violation(v, "same_key_no_permit_under_read_committed", { idsA: [...idsA], idsB: [...idsB] });
  }
  for (const id of idsA) if (idsB.has(id)) violation(v, "permit_shared_across_users", id);
  const st = await userState(owner, A);
  if (st.permits !== idsA.size) violation(v, "duplicate_permit_rows", { st, ids: [...idsA] });
  const stB = await userState(owner, B);
  if (stB.permits !== idsB.size) violation(v, "duplicate_permit_rows_B", { stB, ids: [...idsB] });
  return { key, nA, nB, idsA: idsA.size, idsB: idsB.size };
};

/** S2 — distinct keys ×N for A and B concurrently, with k pre-scored shots. */
scenarios.permit_distinct_keys = async (ctx) => {
  const {
    rng,
    owner,
    users: [A, B],
    v,
  } = ctx;
  const preA = rng.int(0, 2);
  const preB = rng.int(0, 2);
  const premiumB = rng.bool(0.3);
  await seedScoredShots(owner, A, preA, rng);
  await seedScoredShots(owner, B, preB, rng);
  if (premiumB) await setPremium(owner, B);
  const nA = rng.int(3, 10);
  const nB = rng.int(2, 6);
  const specs = [
    ...Array.from({ length: nA }, () => ({ user: A, op: ops.reserve(`k-${rng.uuid()}`) })),
    ...Array.from({ length: nB }, () => ({ user: B, op: ops.reserve(`k-${rng.uuid()}`) })),
  ];
  const lanes = await ctx.burst(specs);
  if (laneErrors(lanes).length) violation(v, "lane_error", laneErrors(lanes));
  const rA = results(lanes, (l) => l.user === "A");
  const rB = results(lanes, (l) => l.user === "B");
  const wantA = Math.min(nA, Math.max(0, 2 - preA));
  const accA = count(rA, "accepted");
  expectCount(ctx, "reserve_accept_count_A", accA, wantA, { rA });
  if (accA + count(rA, "access.paywall_required") !== rA.length)
    violation(v, "reserve_result_partition_A", rA);
  const wantB = premiumB ? nB : Math.min(nB, Math.max(0, 2 - preB));
  const accB = count(rB, "accepted");
  expectCount(ctx, "reserve_accept_count_B", accB, wantB, { rB });
  const stA = await checkFreeLimit(v, owner, A);
  if (stA.reserved !== accA) violation(v, "reserved_rows_A_ne_accepted", { stA, accA });
  const stB = await checkFreeLimit(v, owner, B, { premium: premiumB });
  if (stB.reserved !== accB) violation(v, "reserved_rows_B_ne_accepted", { stB, accB });
  return { preA, preB, premiumB, nA, nB, accA, accB };
};

/** S3 — same shot id: A syncs it ×N (dup outbox flush) while B syncs the SAME id with B's own permit. */
scenarios.sync_same_shot_two_actors = async (ctx) => {
  const {
    rng,
    owner,
    users: [A, B],
    v,
  } = ctx;
  const shotId = rng.uuid();
  const [pA] = await seedLegacyPermits(owner, A, 1, rng);
  const [pB] = await seedLegacyPermits(owner, B, 1, rng);
  const kind = rng.pick(["scored", "scored", "low_confidence"]);
  const nA = rng.int(2, 8);
  const nB = rng.int(1, 4);
  const specs = [
    ...Array.from({ length: nA }, () => ({
      user: A,
      op: ops.sync(shotPayload(shotId, pA, { resultKind: kind })),
    })),
    ...Array.from({ length: nB }, () => ({
      user: B,
      op: ops.sync(shotPayload(shotId, pB, { resultKind: kind })),
    })),
  ];
  const lanes = await ctx.burst(specs);
  if (laneErrors(lanes).length) violation(v, "lane_error", laneErrors(lanes));
  const rA = nonRetryable(results(lanes, (l) => l.user === "A"));
  const rB = nonRetryable(results(lanes, (l) => l.user === "B"));
  const owned = await owner.query("select user_id from public.shots where id = $1", [shotId]);
  if (owned.rowCount !== 1) {
    violation(v, "shot_row_count", owned.rowCount);
    return { shotId, kind, nA, nB, winner: null, rA, rB };
  }
  const winner = owned.rows[0].user_id === A.id ? "A" : owned.rows[0].user_id === B.id ? "B" : null;
  const [rW, rL, W, L] = winner === "A" ? [rA, rB, A, B] : [rB, rA, B, A];
  if (rW.some((r) => r !== "accepted"))
    violation(v, "winner_lanes_not_all_accepted", { winner, rW });
  if (rL.some((r) => r !== "shot.id_conflict"))
    violation(v, "loser_lanes_not_id_conflict", { winner, rL });
  const stW = await userState(owner, W);
  const stL = await userState(owner, L);
  if (stW.finalized !== (kind === "scored" ? 1 : 0)) violation(v, "winner_permit_state", stW);
  if (stW.scored !== (kind === "scored" ? 1 : 0)) violation(v, "winner_scored_count", stW);
  if (stL.shots !== 0 || stL.scored !== 0) violation(v, "loser_gained_rows", stL);
  if (stL.reserved !== 1) violation(v, "loser_permit_consumed_without_row", stL);
  const phases = await owner.query(
    "select count(*)::int n, count(distinct user_id)::int u from public.shot_phases where shot_id = $1",
    [shotId],
  );
  if (phases.rows[0].n !== 2 || phases.rows[0].u !== 1) violation(v, "detail_rows", phases.rows[0]);
  await checkLedgerConsistency(v, owner, A);
  await checkLedgerConsistency(v, owner, B);
  return { shotId, kind, nA, nB, winner };
};

/** S4 — distinct scored shots ×N per user with N legacy-reserved permits → backstop. */
scenarios.sync_distinct_backstop = async (ctx) => {
  const {
    rng,
    owner,
    users: [A, B],
    v,
  } = ctx;
  const preA = rng.int(0, 2);
  const premiumA = rng.bool(0.25);
  await seedScoredShots(owner, A, preA, rng);
  if (premiumA) await setPremium(owner, A);
  const nA = rng.int(3, 8);
  const nB = rng.int(1, 5);
  const permitsA = await seedLegacyPermits(owner, A, nA, rng);
  const permitsB = await seedLegacyPermits(owner, B, nB, rng);
  const specs = [
    ...permitsA.map((p) => ({ user: A, op: ops.sync(shotPayload(rng.uuid(), p)) })),
    ...permitsB.map((p) => ({ user: B, op: ops.sync(shotPayload(rng.uuid(), p)) })),
  ];
  const lanes = await ctx.burst(specs);
  if (laneErrors(lanes).length) violation(v, "lane_error", laneErrors(lanes));
  const rA = nonRetryable(results(lanes, (l) => l.user === "A"));
  const rB = nonRetryable(results(lanes, (l) => l.user === "B"));
  const wantA = premiumA ? nA : Math.min(nA, Math.max(0, 2 - preA));
  const wantB = Math.min(nB, 2);
  const accA = count(rA, "accepted");
  const payA = count(rA, "access.paywall_required");
  expectCount(ctx, "sync_accept_count_A", accA, wantA, { rA });
  if (accA + payA !== rA.length) violation(v, "sync_result_partition_A", rA);
  if (ctx.isolation !== "serializable" && payA !== nA - wantA)
    violation(v, "sync_denied_count_A", rA);
  expectCount(ctx, "sync_accept_count_B", count(rB, "accepted"), wantB, { rB });
  const stA = await checkFreeLimit(v, owner, A, { premium: premiumA, legacyPermits: nA });
  if (stA.scored !== preA + accA) violation(v, "scored_rows_A_ne_accepted", { stA, accA });
  if (stA.finalized !== accA) violation(v, "finalized_A_ne_accepted", { stA, accA });
  const rel = await owner.query(
    "select count(*)::int n from public.analysis_permits where user_id=$1 and status='released' and outcome='free_limit_exceeded'",
    [A.id],
  );
  if (rel.rows[0].n !== payA)
    violation(v, "released_free_limit_A_ne_paywalled", { rel: rel.rows[0], payA });
  await checkFreeLimit(v, owner, B, { legacyPermits: nB });
  await checkLedgerConsistency(v, owner, A);
  await checkLedgerConsistency(v, owner, B);
  return { preA, premiumA, nA, nB };
};

/** S5 — reserve races sync on the last free rating (both users), plus access reads. */
scenarios.reserve_vs_sync_last_free = async (ctx) => {
  const {
    rng,
    owner,
    users: [A, B],
    v,
  } = ctx;
  await seedScoredShots(owner, A, 1, rng);
  const [pA] = await seedLegacyPermits(owner, A, 1, rng);
  const nRes = rng.int(2, 6);
  const specs = [
    { user: A, op: ops.sync(shotPayload(rng.uuid(), pA)) },
    ...Array.from({ length: nRes }, () => ({ user: A, op: ops.reserve(`k-${rng.uuid()}`) })),
    { user: A, op: ops.access() },
    { user: B, op: ops.reserve(`k-${rng.uuid()}`) },
    { user: B, op: ops.access() },
  ];
  const lanes = await ctx.burst(specs);
  if (laneErrors(lanes).length) violation(v, "lane_error", laneErrors(lanes));
  const sync = lanes.find((l) => l.user === "A" && l.result?.op === "sync");
  const res = lanes
    .filter((l) => l.user === "A" && l.result?.op === "reserve")
    .map((l) => l.result.result);
  const st = await checkFreeLimit(v, owner, A, { legacyPermits: 1 });
  // Either the sync won (scored=2, every reserve paywalled) or a reserve won
  // first — then the legacy permit + the new reserved permit cover the last
  // rating and the sync still passes the backstop (scored=2 → the reserve
  // that won is now an over-issued hold, which access math must show).
  if (sync?.committed && sync.result?.result === "accepted") {
    if (st.scored !== 2) violation(v, "sync_accepted_but_scored_ne_2", st);
  } else if (!(
    ctx.isolation === "serializable" &&
    (sync?.error?.code === "40001" || RETRYABLE.has(sync?.result?.result))
  )) {
    violation(v, "sync_unexpected_result", sync);
  }
  if (count(res, "accepted") > 1) violation(v, "more_than_one_reserve_on_last_free", res);
  const acc = await asUserScalar(owner, A, "select * from public.access_state()");
  if (acc.scored_count !== st.scored) violation(v, "access_scored_count", { acc, st });
  if (acc.reserved_count !== st.reserved) violation(v, "access_reserved_mismatch", { acc, st });
  const accB = await asUserScalar(owner, B, "select * from public.access_state()");
  if (accB.scored_count !== 0) violation(v, "cross_user_access_state_leak", accB);
  await checkLedgerConsistency(v, owner, A);
  return { nRes, syncResult: sync?.result?.result, reserves: res };
};

/** S6 — two-user × anon RLS matrix under concurrency: B and anon attack A's rows while A legitimately writes them. */
scenarios.cross_user_matrix = async (ctx) => {
  const {
    rng,
    owner,
    users: [A, B],
    v,
  } = ctx;
  // A's fixtures
  const sessionId = rng.uuid();
  await owner.query(
    "insert into public.sessions (id, user_id, started_at) values ($1, $2, now() - interval '1 hour')",
    [sessionId, A.id],
  );
  const [permitA] = await seedLegacyPermits(owner, A, 1, rng);
  const shotId = rng.uuid();
  await owner.query(
    `insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
       overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
       paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
     values ($1, $2, $3, 'forehand_drive', 'side', now(), 0, 400, 900, 6.5, 0.9, 'scored', '1','b','p','pa','s','ph','sc','c','real')`,
    [shotId, A.id, sessionId],
  );
  await owner.query(
    "insert into public.user_saved_drills (user_id, slug) values ($1, 'dink-basics')",
    [A.id],
  );
  await owner.query(
    "insert into public.consent_records (user_id, scope, action, consent_version) values ($1, 'video_analysis', 'grant', 'v1')",
    [A.id],
  );
  await owner.query("insert into public.account_deletion_requests (user_id) values ($1)", [A.id]);
  await setPremium(owner, A);
  const before = await owner.query(
    `select md5(string_agg(x::text, '|' order by x::text)) h from (
       select 'profiles' t, row_to_json(p)::text x from public.profiles p where id = $1
       union all select 'shots', row_to_json(s)::text from public.shots s where user_id = $1
       union all select 'consent', row_to_json(c)::text from public.consent_records c where user_id = $1
       union all select 'drills', row_to_json(d)::text from public.user_saved_drills d where user_id = $1
       union all select 'billing', row_to_json(b)::text from public.billing_entitlements b where user_id = $1
       union all select 'deletion', row_to_json(r)::text from public.account_deletion_requests r where user_id = $1
     ) q`,
    [A.id],
  );
  const endedAt = new Date(Date.now() - 60_000).toISOString();
  const bAttacks = [
    ops.sql("B_select_A_shots", "select id from public.shots where user_id = $1", [A.id]),
    ops.sql("B_select_A_shots_by_id", "select id from public.shots where id = $1", [shotId]),
    ops.sql("B_update_A_session", "update public.sessions set ended_at = now() where id = $1", [
      sessionId,
    ]),
    ops.sql("B_delete_A_session", "delete from public.sessions where id = $1", [sessionId]),
    ops.sql(
      "B_insert_session_as_A",
      "insert into public.sessions (id, user_id, started_at) values ($1, $2, now())",
      [rng.uuid(), A.id],
    ),
    ops.sql(
      "B_upsert_A_session_id",
      "insert into public.sessions (id, user_id, started_at) values ($1, $2, now()) on conflict (id) do nothing",
      [sessionId, B.id],
    ),
    ops.sql(
      "B_update_A_permit",
      "update public.analysis_permits set status = 'released', outcome = 'cancelled' where id = $1",
      [permitA],
    ),
    ops.sql("B_delete_A_permit", "delete from public.analysis_permits where id = $1", [permitA]),
    ops.sql(
      "B_insert_permit_as_A",
      "insert into public.analysis_permits (user_id, idempotency_key) values ($1, $2)",
      [A.id, `b-${rng.uuid()}`],
    ),
    ops.sql("B_sync_with_A_permit", "select public.apply_synced_shot($1::jsonb) r", [
      JSON.stringify(shotPayload(rng.uuid(), permitA)),
    ]),
    ops.sql("B_delete_A_shot", "delete from public.shots where id = $1", [shotId]),
    ops.sql(
      "B_update_A_profile",
      "update public.profiles set onboarding_state = 'complete', provider = 'evil' where id = $1",
      [A.id],
    ),
    ops.sql("B_select_A_profile", "select id from public.profiles where id = $1", [A.id]),
    ops.sql(
      "B_insert_consent_as_A",
      "insert into public.consent_records (user_id, scope, action) values ($1, 'model_training', 'withdraw')",
      [A.id],
    ),
    ops.sql("B_select_A_consent", "select id from public.consent_records where user_id = $1", [
      A.id,
    ]),
    ops.sql("B_delete_A_drill", "delete from public.user_saved_drills where user_id = $1", [A.id]),
    ops.sql(
      "B_insert_drill_as_A",
      "insert into public.user_saved_drills (user_id, slug) values ($1, 'x-drill') on conflict do nothing",
      [A.id],
    ),
    ops.sql(
      "B_select_A_billing",
      "select premium from public.billing_entitlements where user_id = $1",
      [A.id],
    ),
    ops.sql(
      "B_upsert_A_deletion_request",
      "insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at) values ($1, gen_random_uuid(), now(), now() + interval '15 minutes') on conflict (user_id) do update set challenge = excluded.challenge, user_id = excluded.user_id",
      [A.id],
    ),
    ops.sql(
      "B_select_A_deletion_request",
      "select challenge from public.account_deletion_requests where user_id = $1",
      [A.id],
    ),
    ops.sql("B_select_ledger", "select * from public.free_rating_ledger"),
    ops.sql("B_select_A_rank", "select * from public.player_rank_state where user_id = $1", [A.id]),
    ops.sql("B_select_A_phases", "select * from public.shot_phases where shot_id = $1", [shotId]),
    ops.sql(
      "B_insert_phase_on_A_shot",
      "insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence) values ($1, $2, 'evil', 0, 0, 0, 0.5)",
      [shotId, B.id],
    ),
    ops.sql("B_select_A_identities", "select * from auth.identities where user_id = $1", [A.id]),
    ops.sql("B_lifetime_count", "select public.lifetime_scored_count() n"),
  ];
  const anonAttacks = [
    ops.sql("anon_select_shots", "select id from public.shots"),
    ops.sql("anon_select_profiles", "select id from public.profiles"),
    ops.sql("anon_select_permits", "select id from public.analysis_permits"),
    ops.sql(
      "anon_insert_session",
      "insert into public.sessions (id, user_id, started_at) values ($1, $2, now())",
      [rng.uuid(), A.id],
    ),
    ops.sql("anon_reserve", "select * from public.reserve_analysis_permit('anon')"),
    ops.sql("anon_access", "select * from public.access_state()"),
    ops.sql("anon_sync", "select public.apply_synced_shot('{}'::jsonb)"),
    ops.sql("anon_select_ledger", "select * from public.free_rating_ledger"),
    ops.sql("anon_select_billing", "select * from public.billing_entitlements"),
    ops.sql("anon_select_deletion", "select * from public.account_deletion_requests"),
    ops.sql("anon_select_webhook", "select * from public.webhook_events"),
    ops.sql("anon_select_progress", "select * from public.progress_daily"),
  ];
  // A's legitimate concurrent writes on the SAME rows B is attacking.
  const aWrites = [
    {
      user: A,
      op: ops.sql(
        "A_finalize_session",
        "update public.sessions set ended_at = $2 where id = $1 and user_id = $3 and ended_at is null",
        [sessionId, endedAt, A.id],
      ),
    },
    {
      user: A,
      op: ops.sql(
        "A_finalize_permit",
        "update public.analysis_permits set status = 'finalized', outcome = 'scored' where id = $1 and user_id = $2 and status = 'reserved'",
        [permitA, A.id],
      ),
    },
    {
      user: A,
      op: ops.sql("A_read_own_shots", "select id from public.shots where user_id = $1", [A.id]),
    },
  ];
  const pickN = (arr, n) => {
    const copy = [...arr];
    const out = [];
    while (out.length < n && copy.length) out.push(copy.splice(rng.int(0, copy.length - 1), 1)[0]);
    return out;
  };
  const nB = rng.int(6, 11);
  const nAnon = rng.int(1, 3);
  const specs = [
    ...aWrites,
    ...pickN(bAttacks, nB).map((op) => ({ user: B, op })),
    ...pickN(anonAttacks, nAnon).map((op) => ({ role: "anon", op })),
  ];
  const lanes = await ctx.burst(specs);
  // Assertions
  for (const l of lanes) {
    if (l.user === "A") {
      if (l.error) violation(v, "A_own_write_failed", l);
      continue;
    }
    if (l.role === "anon") {
      if (!l.error || l.error.code !== "42501") violation(v, "anon_not_denied", l);
      continue;
    }
    // B lanes: allowed outcomes are permission denied (42501) OR a no-op
    // (0 rows / empty result / RPC deny code). Anything that touched A is a breach.
    if (l.error) {
      const retryable = ctx.isolation === "serializable" && l.error.code === "40001";
      if (l.error.code !== "42501" && !retryable) violation(v, "B_unexpected_error", l);
      continue;
    }
    const r = l.result;
    const label = r.op;
    if (label.startsWith("B_select") || label === "B_lifetime_count") {
      if (label === "B_lifetime_count") {
        if (r.rows[0].n !== 0) violation(v, "B_lifetime_count_leak", r);
      } else {
        // Rows B itself managed to attach to A's shot are reported by
        // B_attached_detail_to_A_shot; a read leak is A-OWNED rows B can see.
        const leaked = r.rows.filter((row) => row.user_id === undefined || row.user_id === A.id);
        if (leaked.length) violation(v, "B_read_A_rows", { op: r.op, rows: leaked });
      }
    } else if (label === "B_sync_with_A_permit") {
      if (r.rows[0].r !== "access.permit_not_found") violation(v, "B_sync_with_A_permit_result", r);
    } else if (r.rowCount !== 0) {
      violation(v, "B_wrote_A_rows", r);
    }
  }
  const after = await owner.query(
    `select md5(string_agg(x::text, '|' order by x::text)) h from (
       select 'profiles' t, row_to_json(p)::text x from public.profiles p where id = $1
       union all select 'shots', row_to_json(s)::text from public.shots s where user_id = $1
       union all select 'consent', row_to_json(c)::text from public.consent_records c where user_id = $1
       union all select 'drills', row_to_json(d)::text from public.user_saved_drills d where user_id = $1
       union all select 'billing', row_to_json(b)::text from public.billing_entitlements b where user_id = $1
       union all select 'deletion', row_to_json(r)::text from public.account_deletion_requests r where user_id = $1
     ) q`,
    [A.id],
  );
  if (before.rows[0].h !== after.rows[0].h)
    violation(v, "A_untouched_rows_changed", { before: before.rows[0].h, after: after.rows[0].h });
  const sess = await owner.query("select user_id, ended_at from public.sessions where id = $1", [
    sessionId,
  ]);
  if (sess.rowCount !== 1 || sess.rows[0].user_id !== A.id)
    violation(v, "A_session_lost_or_stolen", sess.rows);
  if (new Date(sess.rows[0]?.ended_at).toISOString() !== endedAt)
    violation(v, "A_session_ended_at_overwritten", { got: sess.rows[0]?.ended_at, endedAt });
  const perm = await owner.query(
    "select status, outcome, user_id from public.analysis_permits where id = $1",
    [permitA],
  );
  if (
    perm.rowCount !== 1 ||
    perm.rows[0].status !== "finalized" ||
    perm.rows[0].outcome !== "scored"
  )
    violation(v, "A_permit_state_tampered", perm.rows);
  const stB = await userState(owner, B);
  if (stB.shots !== 0 || stB.sessions !== 0 || stB.permits !== 0)
    violation(v, "B_gained_rows", stB);
  const extraSessions = await owner.query(
    "select count(*)::int n from public.sessions where user_id = $1",
    [A.id],
  );
  if (extraSessions.rows[0].n !== 1) violation(v, "A_session_count", extraSessions.rows[0]);
  const phases = await owner.query(
    "select count(*)::int n from public.shot_phases where shot_id = $1",
    [shotId],
  );
  if (phases.rows[0].n !== 0) violation(v, "B_attached_detail_to_A_shot", phases.rows[0]);
  return { nB, nAnon, sessionId, shotId };
};

/** S7 — identity linked (GoTrue insert on auth.identities) WHILE a scored shot syncs. */
scenarios.identity_link_during_scored_sync = async (ctx) => {
  const {
    rng,
    owner,
    users: [A, B],
    v,
  } = ctx;
  const pre = rng.int(0, 1);
  await seedScoredShots(owner, A, pre, rng);
  const [pA] = await seedLegacyPermits(owner, A, 1, rng);
  const specs = [
    { user: A, op: ops.sync(shotPayload(rng.uuid(), pA)) },
    {
      role: "postgres",
      op: async (c) => {
        // GoTrue links identities with its own (service) connection — no JWT.
        const provider = A.provider === "apple" ? "google" : "apple";
        const providerId = `stress-${RUN_NONCE}-link-${rng.uuid()}`;
        await c.query(
          `insert into auth.identities (provider_id, user_id, identity_data, provider)
           values ($1, $2, jsonb_build_object('sub', $1::text), $3)`,
          [providerId, A.id, provider],
        );
        return { op: "link_identity", provider, providerId };
      },
    },
    { user: B, op: ops.reserve(`k-${rng.uuid()}`) },
  ];
  const lanes = await ctx.burst(specs);
  if (laneErrors(lanes).length) violation(v, "lane_error", laneErrors(lanes));
  const st = await checkLedgerConsistency(v, owner, A);
  // Second-order effect: delete the account, sign in again with ONLY the
  // late-linked identity → lifetime count must still be `scored`.
  const link = lanes.find((l) => l.result?.op === "link_identity")?.result;
  let recreated = null;
  if (link) {
    await owner.query("delete from auth.users where id = $1", [A.id]);
    const A2 = { id: rng.uuid(), tag: "A2" };
    await owner.query("insert into auth.users (id, email) values ($1, $2)", [
      A2.id,
      `a2-${A2.id.slice(0, 8)}@stress.local`,
    ]);
    await owner.query(
      `insert into auth.identities (provider_id, user_id, identity_data, provider)
       values ($1, $2, jsonb_build_object('sub', $1::text), $3)`,
      [link.providerId, A2.id, link.provider],
    );
    const acc = await asUserScalar(owner, A2, "select * from public.access_state()");
    recreated = acc;
    if (acc.scored_count !== st.scored) {
      violation(v, "late_linked_identity_lost_ratings_after_recreate", {
        recreatedScoredCount: acc.scored_count,
        expected: st.scored,
        ledgerBefore: st.ledger,
      });
    }
    ctx.extraUsers.push(A2);
  }
  return { pre, ledger: st.ledger, scored: st.scored, recreated };
};

/** S8 — account deletion (service cascade) racing the user's own RPC calls. */
scenarios.deletion_during_requests = async (ctx) => {
  const {
    rng,
    owner,
    users: [A, B],
    v,
  } = ctx;
  const pre = rng.int(0, 1);
  await seedScoredShots(owner, A, pre, rng);
  const permits = await seedLegacyPermits(owner, A, 2, rng);
  const sessionId = rng.uuid();
  const specs = [
    { user: A, op: ops.sync(shotPayload(rng.uuid(), permits[0])) },
    {
      user: A,
      op: ops.sync(shotPayload(rng.uuid(), permits[1], { resultKind: "low_confidence" })),
    },
    { user: A, op: ops.reserve(`k-${rng.uuid()}`) },
    {
      user: A,
      op: ops.sql(
        "A_insert_session",
        "insert into public.sessions (id, user_id, started_at) values ($1, $2, now()) on conflict (id) do nothing",
        [sessionId, A.id],
      ),
    },
    {
      user: A,
      op: ops.sql(
        "A_consent",
        "insert into public.consent_records (user_id, scope, action) values ($1, 'video_analysis', 'grant')",
        [A.id],
      ),
    },
    { user: A, op: ops.access() },
    {
      role: "postgres",
      op: async (c) => {
        const r = await c.query("delete from auth.users where id = $1", [A.id]);
        return { op: "delete_account", rowCount: r.rowCount };
      },
    },
    { user: B, op: ops.reserve(`k-${rng.uuid()}`) },
  ];
  const lanes = await ctx.burst(specs);
  const allowed = new Set(["23503", "42501", "P0001", "23505", "40001"]);
  for (const l of laneErrors(lanes)) {
    if (!allowed.has(l.error.code) && l.error.code !== "40P01")
      violation(v, "unexpected_error_code", l);
  }
  checkNoDeadlockOrTimeout(v, lanes);
  await checkNoOrphans(v, owner);
  const del = lanes.find((l) => l.result?.op === "delete_account" || l.role === "postgres");
  const exists = await owner.query("select 1 from auth.users where id = $1", [A.id]);
  // A 40001 on the delete lane under SERIALIZABLE is the caller's cue to retry,
  // not a lost deletion; a deadlock (40P01) is reported by
  // checkNoDeadlockOrTimeout above and still fails the iteration.
  const deleteRetryable = ctx.isolation === "serializable" && del?.error?.code === "40001";
  if (exists.rowCount !== 0) {
    if (!deleteRetryable)
      violation(v, "account_not_deleted", { deleteLaneError: del?.error ?? null });
    // Recover so the ledger check below still sees the deleted-account state.
    await owner.query("delete from auth.users where id = $1", [A.id]);
  }
  // Ledger must retain max(pre, pre + accepted scored) for A's identity.
  const accepted = committedLanes(
    lanes,
    (l) =>
      l.result.op === "sync" && l.result.resultKind === "scored" && l.result.result === "accepted",
  ).length;
  const led = await owner.query(
    "select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash($1, $2)",
    [A.provider, A.providerId],
  );
  const ledgerCount = led.rows[0]?.scored_count ?? 0;
  if (ledgerCount < pre + accepted)
    violation(v, "ledger_lost_after_deletion", { ledgerCount, pre, accepted });
  const stB = await userState(owner, B);
  const bLane = lanes.find((l) => l.user === "B");
  if (stB.reserved !== 1 && !(ctx.isolation === "serializable" && bLane?.error?.code === "40001"))
    violation(v, "B_collateral", stB);
  return { pre, accepted, ledgerCount, lanes: lanes.map((l) => l.result?.op ?? l.error?.code) };
};

/** S9 — two devices of A create the same session + finalize it ×N; B upserts the same id. */
scenarios.session_two_devices = async (ctx) => {
  const {
    rng,
    owner,
    users: [A, B],
    v,
  } = ctx;
  const sessionId = rng.uuid();
  const startedAt = new Date(Date.now() - 3_600_000).toISOString();
  const nIns = rng.int(2, 5);
  const specs = [
    ...Array.from({ length: nIns }, () => ({
      user: A,
      op: ops.sql(
        "A_upsert_session",
        "insert into public.sessions (id, user_id, started_at) values ($1, $2, $3) on conflict (id) do nothing",
        [sessionId, A.id, startedAt],
      ),
    })),
    {
      user: B,
      op: ops.sql(
        "B_upsert_session",
        "insert into public.sessions (id, user_id, started_at) values ($1, $2, $3) on conflict (id) do nothing",
        [sessionId, B.id, startedAt],
      ),
    },
  ];
  const lanes = await ctx.burst(specs);
  if (laneErrors(lanes).length) violation(v, "lane_error", laneErrors(lanes));
  const row = await owner.query("select user_id from public.sessions where id = $1", [sessionId]);
  if (row.rowCount !== 1) {
    violation(v, "session_row_count", row.rowCount);
    return { sessionId, nIns };
  }
  const inserted = lanes.filter((l) => l.result?.rowCount === 1);
  if (inserted.length !== 1)
    violation(
      v,
      "session_insert_winner_count",
      inserted.map((l) => l.user),
    );
  const winner = row.rows[0]?.user_id === A.id ? "A" : "B";
  // Finalize burst as the winner: edge-fn shape (read ended_at is null, then
  // UPDATE without an `ended_at is null` guard — index.ts finalizeSession).
  const W = winner === "A" ? A : B;
  const nFin = rng.int(2, 6);
  const stamps = Array.from({ length: nFin }, (_, i) =>
    new Date(Date.now() - 1000 + i).toISOString(),
  );
  const fin = await ctx.burst(
    stamps.map((ts) => ({
      user: W,
      op: async (c) => {
        const cur = await c.query(
          "select ended_at from public.sessions where id = $1 and user_id = $2",
          [sessionId, W.id],
        );
        if (cur.rowCount !== 1) return { op: "finalize", found: false };
        if (cur.rows[0].ended_at !== null) return { op: "finalize", skipped: true };
        const u = await c.query(
          "update public.sessions set ended_at = $2 where id = $1 and user_id = $3",
          [sessionId, ts, W.id],
        );
        return { op: "finalize", updated: u.rowCount, ts };
      },
    })),
  );
  if (laneErrors(fin).some((l) => l.error.code !== "40001" || ctx.isolation !== "serializable"))
    violation(v, "finalize_lane_error", laneErrors(fin));
  const updates = committedLanes(fin, (l) => l.result.updated === 1);
  const final = await owner.query("select ended_at from public.sessions where id = $1", [
    sessionId,
  ]);
  const finalTs = final.rows[0]?.ended_at ? new Date(final.rows[0].ended_at).toISOString() : null;
  if (!finalTs) violation(v, "session_not_finalized", final.rows);
  if (updates.length > 1) {
    // "Stamps ended_at once (a replay never moves it)" is violated when two
    // concurrent finalizes both observe NULL and both write.
    violation(v, "session_finalize_stamped_more_than_once", {
      updates: updates.length,
      stamps: updates.map((l) => l.result.ts),
      finalTs,
    });
  }
  return { sessionId, winner, nIns, nFin, updates: updates.length };
};

/** S10 — client permit release/finalize (edge-fn shape) racing apply_synced_shot on the same permit. */
scenarios.permit_client_vs_rpc = async (ctx) => {
  const {
    rng,
    owner,
    users: [A, B],
    v,
  } = ctx;
  const [pA] = await seedLegacyPermits(owner, A, 1, rng);
  const shotId = rng.uuid();
  const kind = rng.pick(["scored", "low_confidence"]);
  const clientOutcome = rng.pick(["cancelled", "failed", "low_confidence"]);
  const nSync = rng.int(1, 3);
  const nClient = rng.int(1, 3);
  const specs = [
    ...Array.from({ length: nSync }, () => ({
      user: A,
      op: ops.sync(shotPayload(shotId, pA, { resultKind: kind })),
    })),
    ...Array.from({ length: nClient }, () => ({
      user: A,
      op: ops.sql(
        "A_client_release",
        "update public.analysis_permits set status = 'released', outcome = $2 where id = $1 and user_id = $3 and status = 'reserved'",
        [pA, clientOutcome, A.id],
      ),
    })),
    {
      user: B,
      op: ops.sql(
        "B_release_A_permit",
        "update public.analysis_permits set status = 'released', outcome = 'cancelled' where id = $1 and status = 'reserved'",
        [pA],
      ),
    },
  ];
  const lanes = await ctx.burst(specs);
  if (laneErrors(lanes).length) violation(v, "lane_error", laneErrors(lanes));
  checkNoDeadlockOrTimeout(v, lanes);
  const syncs = nonRetryable(results(lanes, (l) => l.result?.op === "sync"));
  if (ctx.isolation === "serializable" && syncs.length === 0) {
    await checkLedgerConsistency(v, owner, A);
    return { kind, clientOutcome, nSync, nClient, syncs: [], retried: true };
  }
  const releases = lanes.filter(
    (l) => l.result?.op === "A_client_release" && l.result.rowCount === 1,
  ).length;
  const bRel = lanes.find((l) => l.result?.op === "B_release_A_permit");
  if (bRel && bRel.result.rowCount !== 0) violation(v, "B_released_A_permit", bRel);
  const perm = await owner.query(
    "select status, outcome from public.analysis_permits where id = $1",
    [pA],
  );
  const st = await userState(owner, A);
  const syncAccepted = count(syncs, "accepted");
  if (releases > 1) violation(v, "permit_released_twice", { releases });
  if (syncAccepted > 0 && releases > 0)
    violation(v, "permit_consumed_and_released", { syncs, releases, perm: perm.rows[0] });
  if (syncAccepted > 0) {
    if (st.shots !== 1) violation(v, "shot_rows", st);
    if (
      perm.rows[0].status !== (kind === "scored" ? "finalized" : "released") ||
      perm.rows[0].outcome !== kind
    )
      violation(v, "permit_state_after_sync", perm.rows[0]);
    if (syncs.some((r) => r !== "accepted")) violation(v, "dup_sync_not_idempotent", syncs);
  } else {
    if (releases !== 1)
      violation(v, "no_sync_and_no_release", { syncs, releases, perm: perm.rows[0] });
    if (syncs.some((r) => r !== "access.permit_not_reserved"))
      violation(v, "sync_after_release_result", syncs);
    if (st.shots !== 0) violation(v, "shot_written_without_permit", st);
    if (perm.rows[0].outcome !== clientOutcome) violation(v, "release_outcome", perm.rows[0]);
  }
  await checkLedgerConsistency(v, owner, A);
  void B;
  return { kind, clientOutcome, nSync, nClient, syncs, releases, perm: perm.rows[0] };
};

/** S11 — seeded random op soup for both users; global invariants afterwards. */
scenarios.mixed_ops_soup = async (ctx) => {
  const {
    rng,
    owner,
    users: [A, B],
    v,
  } = ctx;
  const premiumA = rng.bool(0.3);
  if (premiumA) await setPremium(owner, A);
  const preB = rng.int(0, 2);
  await seedScoredShots(owner, B, preB, rng);
  const sessA = rng.uuid();
  const sessB = rng.uuid();
  await owner.query(
    "insert into public.sessions (id, user_id, started_at) values ($1, $2, now()), ($3, $4, now())",
    [sessA, A.id, sessB, B.id],
  );
  const rounds = rng.int(2, 4);
  const perRound = rng.int(6, MAX_LANES);
  const permitsOf = { A: [], B: [] };
  const allLanes = [];
  for (let r = 0; r < rounds; r++) {
    const specs = [];
    for (let i = 0; i < perRound; i++) {
      const U = rng.bool(0.6) ? A : B;
      const bag = permitsOf[U.tag];
      const kind = rng.pick([
        "reserve",
        "reserve",
        "sync",
        "sync",
        "sync_low",
        "access",
        "release",
        "session_end",
        "consent",
        "drill",
        "dup_reserve",
      ]);
      if (kind === "reserve") {
        specs.push({ user: U, op: ops.reserve(`k-${rng.uuid()}`) });
      } else if (kind === "dup_reserve") {
        specs.push({ user: U, op: ops.reserve(`dup-${U.tag}-${r}`) });
      } else if ((kind === "sync" || kind === "sync_low") && bag.length) {
        const p = rng.pick(bag);
        specs.push({
          user: U,
          op: ops.sync(
            shotPayload(rng.uuid(), p, {
              resultKind: kind === "sync" ? "scored" : "low_confidence",
              sessionId: rng.bool() ? (U === A ? sessA : sessB) : null,
            }),
          ),
        });
      } else if (kind === "release" && bag.length) {
        specs.push({
          user: U,
          op: ops.sql(
            "release",
            "update public.analysis_permits set status='released', outcome='cancelled' where id=$1 and user_id=$2 and status='reserved'",
            [rng.pick(bag), U.id],
          ),
        });
      } else if (kind === "session_end") {
        specs.push({
          user: U,
          op: ops.sql(
            "session_end",
            "update public.sessions set ended_at = now() where id = $1 and user_id = $2 and ended_at is null",
            [U === A ? sessA : sessB, U.id],
          ),
        });
      } else if (kind === "consent") {
        specs.push({
          user: U,
          op: ops.sql(
            "consent",
            "insert into public.consent_records (user_id, scope, action) values ($1, 'video_analysis', $2)",
            [U.id, rng.pick(["grant", "withdraw"])],
          ),
        });
      } else if (kind === "drill") {
        specs.push({
          user: U,
          op: ops.sql(
            "drill",
            rng.bool()
              ? "insert into public.user_saved_drills (user_id, slug) values ($1, 'dink') on conflict do nothing"
              : "delete from public.user_saved_drills where user_id = $1 and slug = 'dink'",
            [U.id],
          ),
        });
      } else {
        specs.push({ user: U, op: ops.access() });
      }
    }
    const lanes = await ctx.burst(specs);
    allLanes.push(...lanes);
    for (const l of lanes) {
      if (l.committed && l.result?.op === "reserve" && l.result.result === "accepted")
        permitsOf[l.user].push(l.result.permitId);
    }
  }
  const fatal = laneErrors(allLanes).filter(
    (l) => !(ctx.isolation === "serializable" && l.error.code === "40001"),
  );
  if (fatal.length) violation(v, "lane_error", fatal);
  checkNoDeadlockOrTimeout(v, allLanes);
  const stA = await checkFreeLimit(v, owner, A, { premium: premiumA });
  const stB = await checkFreeLimit(v, owner, B);
  await checkLedgerConsistency(v, owner, A);
  await checkLedgerConsistency(v, owner, B);
  // Every accepted sync produced exactly one shot row; every permit id we hold is owned by its user.
  const acceptedScored = committedLanes(
    allLanes,
    (l) =>
      l.result.op === "sync" && l.result.result === "accepted" && l.result.resultKind === "scored",
  ).length;
  const acceptedLow = committedLanes(
    allLanes,
    (l) =>
      l.result.op === "sync" &&
      l.result.result === "accepted" &&
      l.result.resultKind === "low_confidence",
  ).length;
  if (stA.shots + stB.shots !== acceptedScored + acceptedLow + preB)
    violation(v, "shot_rows_ne_accepted_syncs", { stA, stB, acceptedScored, acceptedLow, preB });
  if (stA.scored + stB.scored !== acceptedScored + preB)
    violation(v, "scored_rows_ne_accepted_scored", { stA, stB, acceptedScored, preB });
  for (const tag of ["A", "B"]) {
    if (!permitsOf[tag].length) continue;
    // Duplicate reserve calls share an idempotency key on purpose, so the same
    // permit id legitimately comes back more than once — count distinct ids.
    const ids = [...new Set(permitsOf[tag])];
    const owned = await owner.query(
      "select count(*)::int n from public.analysis_permits where id = any($1::uuid[]) and user_id = $2",
      [ids, tag === "A" ? A.id : B.id],
    );
    if (owned.rows[0].n !== ids.length)
      violation(v, "permit_owner_mismatch", { tag, owned: owned.rows[0].n, held: ids.length, ids });
  }
  // A permit can be consumed by at most one shot; a shot can reference … (RPC keeps no FK) so
  // check finalized permits == scored syncs accepted per user (premium or not).
  const fin = await owner.query(
    "select user_id, count(*)::int n from public.analysis_permits where status='finalized' group by user_id",
  );
  const finA = fin.rows.find((r) => r.user_id === A.id)?.n ?? 0;
  const finB = fin.rows.find((r) => r.user_id === B.id)?.n ?? 0;
  if (finA !== stA.scored) violation(v, "finalized_ne_scored_A", { finA, scored: stA.scored });
  if (finB !== stB.scored - preB)
    violation(v, "finalized_ne_scored_B", { finB, scored: stB.scored, preB });
  await checkNoOrphans(v, owner);
  return { premiumA, preB, rounds, perRound, lanes: allLanes.length, stA, stB };
};

/** S12 — clock edges: premium expiring during the burst; permits at the 24h boundary. */
scenarios.clock_skew_edges = async (ctx) => {
  const {
    rng,
    owner,
    users: [A, B],
    v,
  } = ctx;
  await seedScoredShots(owner, A, 2, rng);
  const expiresInMs = rng.int(-20, 60);
  await setPremium(owner, A, { expiresAt: new Date(Date.now() + expiresInMs).toISOString() });
  const nA = rng.int(3, 8);
  const permitsA = await seedLegacyPermits(owner, A, nA, rng);
  // B: permits straddling the 24h expiry boundary (created_at skewed by owner).
  const nB = rng.int(2, 5);
  const permitsB = await seedLegacyPermits(owner, B, nB, rng);
  const skews = permitsB.map(() =>
    rng.pick([
      "23 hours 59 minutes 59.9 seconds",
      "24 hours",
      "24 hours 1 second",
      "1 hour",
      "-1 hour",
    ]),
  );
  for (let i = 0; i < nB; i++) {
    await owner.query(
      "update public.analysis_permits set created_at = now() - $2::interval where id = $1",
      [permitsB[i], skews[i]],
    );
  }
  const specs = [
    ...permitsA.map((p) => ({
      user: A,
      op: ops.sync(
        shotPayload(rng.uuid(), p, {
          capturedAt: new Date(Date.now() + rng.int(-86_400_000, 86_400_000)).toISOString(),
        }),
      ),
    })),
    ...permitsB.map((p) => ({ user: B, op: ops.sync(shotPayload(rng.uuid(), p)) })),
  ];
  const lanes = await ctx.burst(specs);
  if (laneErrors(lanes).length) violation(v, "lane_error", laneErrors(lanes));
  const rA = nonRetryable(committedLanes(lanes, (l) => l.user === "A").map((l) => l.result.result));
  const rB = committedLanes(lanes, (l) => l.user === "B" && !RETRYABLE.has(l.result?.result));
  const stA = await userState(owner, A);
  const acceptedA = count(rA, "accepted");
  const paywalledA = count(rA, "access.paywall_required");
  // Premium may lapse mid-burst: accepted+paywalled must add up, every
  // paywalled permit must be released, every accepted one finalized, and the
  // scored count must equal 2 + accepted (never more, never less).
  if (acceptedA + paywalledA !== rA.length) violation(v, "A_result_partition", rA);
  if (stA.scored !== 2 + acceptedA) violation(v, "A_scored_ne_accepted", { stA, acceptedA });
  if (stA.finalized !== acceptedA) violation(v, "A_finalized_ne_accepted", { stA, acceptedA });
  const relA = await owner.query(
    "select count(*)::int n from public.analysis_permits where user_id=$1 and status='released'",
    [A.id],
  );
  if (relA.rows[0].n !== paywalledA)
    violation(v, "A_released_ne_paywalled", { rel: relA.rows[0], paywalledA });
  // B: a permit older than or exactly 24h → access.permit_expired + released/expired; fresher → accepted (≤2 free).
  let expectAccept = 0;
  let expiredSeen = 0;
  for (let i = 0; i < nB; i++) {
    const l = rB.find((x) => x.result?.permitId === permitsB[i]);
    const expired = skews[i].startsWith("24 hours");
    if (expired) {
      if (l && l.result?.result !== "access.permit_expired")
        violation(v, "B_expired_permit_result", { skew: skews[i], r: l.result });
      if (l?.result?.result === "access.permit_expired") expiredSeen += 1;
    } else {
      expectAccept += 1;
    }
  }
  const acceptedB = rB.filter((l) => l.result?.result === "accepted").length;
  expectCount(ctx, "B_accept_count", acceptedB, Math.min(2, expectAccept), {
    expectAccept,
    rB: rB.map((l) => l.result?.result),
  });
  if (ctx.isolation !== "serializable" && acceptedB !== Math.min(2, expectAccept))
    violation(v, "B_accept_count_exact", { acceptedB, expectAccept });
  const stB = await checkFreeLimit(v, owner, B, { legacyPermits: nB });
  if (stB.scored !== acceptedB) violation(v, "B_scored_ne_accepted", { stB, acceptedB });
  const expiredRows = await owner.query(
    "select count(*)::int n from public.analysis_permits where user_id=$1 and status='released' and outcome='expired'",
    [B.id],
  );
  if (expiredRows.rows[0].n !== expiredSeen)
    violation(v, "B_expired_rows_ne_results", { rows: expiredRows.rows[0], expiredSeen });
  await checkLedgerConsistency(v, owner, A);
  await checkLedgerConsistency(v, owner, B);
  return { expiresInMs, nA, acceptedA, nB, skews, acceptedB, stB };
};

/** S13 — pooled-connection claim rotation: the SAME transaction switches sub/role between statements. */
scenarios.claims_rotation_in_tx = async (ctx) => {
  const {
    rng,
    owner,
    users: [A, B],
    v,
  } = ctx;
  const [pA] = await seedLegacyPermits(owner, A, 1, rng);
  const sessA = rng.uuid();
  await owner.query(
    "insert into public.sessions (id, user_id, started_at) values ($1, $2, now())",
    [sessA, A.id],
  );
  const nRot = rng.int(2, 6);
  const specs = Array.from({ length: nRot }, (_, i) => ({
    user: i % 2 ? B : A,
    op: async (c, u) => {
      const other = u.id === A.id ? B : A;
      const before = await c.query("select count(*)::int n from public.analysis_permits");
      // token rotation / logout mid-transaction: claims become the other user's, then anon
      await c.query("select set_config('request.jwt.claims', $1, true)", [claims(other.id)]);
      const asOther = await c.query("select count(*)::int n from public.analysis_permits");
      const reserve = await c.query("select result from public.reserve_analysis_permit($1)", [
        `rot-${rng.uuid()}`,
      ]);
      await c.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ role: "anon" }),
      ]);
      const asNone = await c.query("select count(*)::int n from public.analysis_permits");
      const rNone = await c.query("select result from public.reserve_analysis_permit('none')");
      const syncNone = await c.query("select public.apply_synced_shot($1::jsonb) r", [
        JSON.stringify(shotPayload(rng.uuid(), pA)),
      ]);
      return {
        op: "rotate",
        me: u.tag,
        before: before.rows[0].n,
        asOther: asOther.rows[0].n,
        reserve: reserve.rows[0].result,
        asNone: asNone.rows[0].n,
        rNone: rNone.rows[0].result,
        syncNone: syncNone.rows[0].r,
      };
    },
  }));
  const lanes = await ctx.burst(specs);
  if (laneErrors(lanes).length) violation(v, "lane_error", laneErrors(lanes));
  for (const l of lanes) {
    const r = l.result;
    if (!r) continue;
    if (r.asNone !== 0) violation(v, "no_sub_sees_rows", r);
    if (r.rNone !== "auth.required") violation(v, "no_sub_reserve", r);
    if (r.syncNone !== "auth.required") violation(v, "no_sub_sync", r);
    // The rotated-to identity's own allowance decides: accepted while it has
    // free ratings left, paywalled once its two are spoken for. Anything else
    // (e.g. auth.required, or a permit for the pre-rotation identity) is a bug.
    if (r.reserve !== "accepted" && r.reserve !== "access.paywall_required")
      violation(v, "rotated_reserve", r);
  }
  // Reserves made after rotation belong to the rotated-to identity, never the original.
  const stA = await userState(owner, A);
  const stB = await userState(owner, B);
  const acceptedToA = committedLanes(
    lanes,
    (l) => l.result.me === "B" && l.result.reserve === "accepted",
  ).length;
  const acceptedToB = committedLanes(
    lanes,
    (l) => l.result.me === "A" && l.result.reserve === "accepted",
  ).length;
  if (stA.permits !== 1 + acceptedToA)
    violation(v, "A_permit_count_after_rotation", { stA, acceptedToA });
  if (stB.permits !== acceptedToB)
    violation(v, "B_permit_count_after_rotation", { stB, acceptedToB });
  if (stA.reserved > 2 + 1) violation(v, "A_over_reserved_after_rotation", stA);
  if (stB.reserved > 2) violation(v, "B_over_reserved_after_rotation", stB);
  return { nRot, acceptedToA, acceptedToB };
};

/** S14 — direct-table scored INSERT race (bypassing the RPC) from two devices of A + B. */
scenarios.direct_scored_insert_race = async (ctx) => {
  const {
    rng,
    owner,
    users: [A, B],
    v,
  } = ctx;
  const pre = rng.int(0, 2);
  await seedScoredShots(owner, A, pre, rng);
  const nPermits = rng.int(0, 3);
  await seedLegacyPermits(owner, A, nPermits, rng);
  const n = rng.int(3, 10);
  const insertSql = `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
      overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
    values ($1, $2, 'forehand_drive', 'side', now(), 0, 400, 900, 6.5, 0.9, 'scored', '1','b','p','pa','s','ph','sc','c','real')`;
  const specs = [
    ...Array.from({ length: n }, () => ({
      user: A,
      op: ops.sql("A_direct_scored", insertSql, [rng.uuid(), A.id]),
    })),
    { user: B, op: ops.sql("B_direct_scored_as_A", insertSql, [rng.uuid(), A.id]) },
  ];
  const lanes = await ctx.burst(specs);
  checkNoDeadlockOrTimeout(v, lanes);
  const okA = lanes.filter((l) => l.user === "A" && !l.error).length;
  const denied = lanes.filter((l) => l.user === "A" && l.error?.code === "42501").length;
  const retried = lanes.filter((l) => l.user === "A" && l.error?.code === "40001").length;
  const want = nPermits === 0 ? 0 : Math.min(n, Math.max(0, 2 - pre));
  expectCount(ctx, "direct_scored_insert_count", okA, want, { n, pre, nPermits });
  if (okA + denied + (ctx.isolation === "serializable" ? retried : 0) !== n)
    violation(v, "direct_scored_result_partition", laneErrors(lanes));
  const b = lanes.find((l) => l.user === "B");
  if (!b.error || (b.error.code !== "42501" && b.error.code !== "40001"))
    violation(v, "B_inserted_as_A", b);
  const st = await checkFreeLimit(v, owner, A, { legacyPermits: nPermits });
  if (st.scored !== pre + okA) violation(v, "scored_after_direct_ne_ok", { st, okA });
  await checkLedgerConsistency(v, owner, A);
  return { pre, nPermits, n, okA, denied };
};

/** S15 — detail-row squatting: B races A's sync by inserting shot_phases/shot_checkpoints rows keyed on A's shot id. */
scenarios.detail_squat_lost_write = async (ctx) => {
  const {
    rng,
    owner,
    users: [A, B],
    v,
  } = ctx;
  const [pA] = await seedLegacyPermits(owner, A, 1, rng);
  const shotId = rng.uuid();
  const payload = shotPayload(shotId, pA);
  const squatPhase = rng.pick(payload.phases).key;
  const squatCheckpoint = payload.checkpoints[0].key;
  const nB = rng.int(1, 3);
  // Half the iterations let B squat the (shot_id, phase_key) slot BEFORE A's
  // sync (the deterministic ordering); the rest race it.
  const preSquat = rng.bool(0.5);
  if (preSquat) {
    const pre = await ctx.burst([
      {
        user: B,
        op: ops.sql(
          "B_pre_squat_phase",
          "insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence) values ($1, $2, $3, 0, 0, 0, 0.5)",
          [shotId, B.id, squatPhase],
        ),
      },
    ]);
    if (pre[0].error && !["42501", "23503"].includes(pre[0].error.code))
      violation(v, "B_pre_squat_unexpected_error", pre[0]);
  }
  const specs = [
    { user: A, op: ops.sync(payload) },
    ...Array.from({ length: nB }, (_, i) => ({
      user: B,
      op:
        i % 2 === 0
          ? ops.sql(
              "B_squat_phase",
              "insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence) values ($1, $2, $3, 0, 0, 0, 0.5) on conflict do nothing",
              [shotId, B.id, squatPhase],
            )
          : ops.sql(
              "B_squat_checkpoint",
              "insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable) values ($1, $2, $3, 1, 0.5, 'red', 'evil', 0.9, true) on conflict do nothing",
              [shotId, B.id, squatCheckpoint],
            ),
    })),
  ];
  const lanes = await ctx.burst(specs);
  const sync = lanes.find((l) => l.user === "A");
  const bLanes = lanes.filter((l) => l.user === "B");
  for (const l of bLanes) {
    if (l.error && !["42501", "23503", "40001"].includes(l.error.code))
      violation(v, "B_unexpected_error", l);
  }
  const squatted = bLanes.filter((l) => l.result?.rowCount === 1);
  if (sync?.result?.result !== "accepted") {
    if (!(
      ctx.isolation === "serializable" &&
      (sync?.error?.code === "40001" || RETRYABLE.has(sync?.result?.result))
    ))
      violation(v, "A_sync_result", sync);
    return {
      shotId,
      nB,
      preSquat,
      squatted: squatted.length,
      sync: sync?.result?.result ?? sync?.error,
    };
  }
  // A's sync was accepted → A's own detail rows must all exist and be A's.
  const ownPhases = await asUserScalar(
    owner,
    A,
    `select count(*)::int n from public.shot_phases where shot_id = '${shotId}'`,
  );
  const ownCps = await asUserScalar(
    owner,
    A,
    `select count(*)::int n from public.shot_checkpoints where shot_id = '${shotId}'`,
  );
  const foreign = await owner.query(
    `select (select count(*)::int from public.shot_phases where shot_id = $1 and user_id <> $2) p,
            (select count(*)::int from public.shot_checkpoints where shot_id = $1 and user_id <> $2) c`,
    [shotId, A.id],
  );
  if (foreign.rows[0].p + foreign.rows[0].c > 0)
    violation(v, "foreign_detail_rows_on_A_shot", foreign.rows[0]);
  if (ownPhases.n !== payload.phases.length)
    violation(v, "A_phase_rows_lost", {
      got: ownPhases.n,
      want: payload.phases.length,
      squatted: squatted.length,
      preSquat,
      squatPhase,
    });
  if (ownCps.n !== payload.checkpoints.length)
    violation(v, "A_checkpoint_rows_lost", {
      got: ownCps.n,
      want: payload.checkpoints.length,
      squatted: squatted.length,
      preSquat,
    });
  // Replay of the same sync must be idempotent and must not repair anything silently either way.
  const replay = await ctx.burst([{ user: A, op: ops.sync(payload) }]);
  if (replay[0].result?.result !== "accepted") violation(v, "A_replay_not_accepted", replay[0]);
  return {
    shotId,
    nB,
    preSquat,
    squatted: squatted.length,
    ownPhases: ownPhases.n,
    ownCps: ownCps.n,
    foreign: foreign.rows[0],
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Iteration driver
// ─────────────────────────────────────────────────────────────────────────────
const SCENARIO_NAMES = Object.keys(scenarios);

async function runIteration(iterSeed, pool) {
  const rng = new Prng(iterSeed);
  const name = ONLY_SCENARIO || rng.pick(SCENARIO_NAMES);
  const isolation = rng.bool(0.8) ? "read committed" : "serializable";
  const maxJitter = rng.pick([0, 0, 2, 5, 15]);
  const owner = pool.owner;
  const A = await mkUser(owner, rng, "A");
  const B = await mkUser(owner, rng, "B");
  const v = [];
  const ctx = {
    rng,
    owner,
    users: [A, B],
    v,
    extraUsers: [],
    isolation,
    async burst(specs) {
      if (specs.length > pool.lanes.length)
        throw new Error(`burst of ${specs.length} exceeds ${pool.lanes.length} lanes`);
      const barrier = makeBarrier(specs.length);
      const jitters = specs.map(() => (maxJitter ? rng.int(0, maxJitter) : 0));
      const lanes = await Promise.all(
        specs.map((s, i) =>
          lane(pool.lanes[i], {
            isolation,
            user: s.user ?? null,
            role: s.role ?? (s.user ? "authenticated" : "anon"),
            jitterMs: jitters[i],
            barrier,
            op: s.op,
          }),
        ),
      );
      return lanes;
    },
  };
  const t0 = Date.now();
  let params = null;
  let harnessError = null;
  const timer = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`iteration wall time > ${ITER_TIMEOUT_MS}ms`)), ITER_TIMEOUT_MS),
  );
  try {
    params = await Promise.race([scenarios[name](ctx), timer]);
  } catch (e) {
    harnessError = { message: String(e.message).slice(0, 300), code: e.code ?? null };
  }
  const wallMs = Date.now() - t0;
  // Serializable lanes may legitimately hit 40001; a harness-level "lane_error"
  // whose every error is 40001 is a retryable outcome, not a finding — record
  // it separately so the table stays honest.
  const pureSerializationFailures = v.filter(
    (x) =>
      x.name === "lane_error" &&
      Array.isArray(x.detail) &&
      x.detail.every((l) => l.error?.code === "40001"),
  );
  const violations = v
    .filter((x) => !pureSerializationFailures.includes(x))
    .map((x) => ({ name: x.name, detail: x.detail }));
  // cleanup (ledger rows are retained by design; users are unique per iteration).
  // STRESS_KEEP=1 leaves the iteration's rows in place for post-mortem SQL.
  if (!KEEP_ROWS) {
    for (const u of [A, B, ...ctx.extraUsers]) {
      await owner.query("delete from auth.users where id = $1", [u.id]);
    }
    await owner.query("delete from public.billing_entitlements where user_id in ($1, $2)", [
      A.id,
      B.id,
    ]);
  }
  return {
    iterSeed,
    scenario: name,
    isolation,
    maxJitter,
    users: { A: A.id, B: B.id },
    params,
    wallMs,
    serializationFailures: pureSerializationFailures.length,
    violations,
    harnessError,
    outcome: harnessError ? "ERROR" : violations.length ? "FAIL" : "PASS",
    replay: `STRESS_PG_URL=$STRESS_PG_URL STRESS_ITER_SEED=${iterSeed} node supabase/tests/stress/rls_concurrency_stress.mjs`,
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const clients = await connect(MAX_LANES + 1);
  const pool = { owner: clients[0], lanes: clients.slice(1) };
  const seeds =
    ITER_SEED !== null
      ? [ITER_SEED]
      : Array.from({ length: ITER }, (_, i) => deriveIterSeed(CAMPAIGN_SEED, i));
  const rows = [];
  const started = new Date().toISOString();
  for (let i = 0; i < seeds.length; i++) {
    let row;
    try {
      row = await runIteration(seeds[i], pool);
    } catch (e) {
      row = {
        iterSeed: seeds[i],
        outcome: "ERROR",
        harnessError: { message: String(e.message).slice(0, 300), code: e.code ?? null },
      };
    }
    rows.push(row);
    const tag = row.outcome === "PASS" ? "ok  " : row.outcome;
    console.log(
      `[${String(i + 1).padStart(4)}/${seeds.length}] ${tag} seed=${row.iterSeed} ${row.scenario ?? "?"} ${row.isolation ?? ""} ${row.wallMs ?? "?"}ms${row.violations?.length ? " " + row.violations.map((x) => x.name).join(",") : ""}${row.harnessError ? " ERR " + row.harnessError.message : ""}`,
    );
    // Reconnect any lane whose connection broke.
    for (let k = 0; k < pool.lanes.length; k++) {
      try {
        await pool.lanes[k].query("select 1");
      } catch {
        try {
          await pool.lanes[k].end();
        } catch {
          /* already gone */
        }
        pool.lanes[k] = new pg.Client({ connectionString: PG_URL });
        await pool.lanes[k].connect();
      }
    }
  }
  const byScenario = {};
  for (const r of rows) {
    const s = (byScenario[r.scenario ?? "?"] ??= { PASS: 0, FAIL: 0, ERROR: 0 });
    s[r.outcome] += 1;
  }
  const summary = {
    campaignSeed: ITER_SEED !== null ? null : CAMPAIGN_SEED,
    iterSeedOverride: ITER_SEED,
    started,
    finished: new Date().toISOString(),
    executed: rows.length,
    pass: rows.filter((r) => r.outcome === "PASS").length,
    fail: rows.filter((r) => r.outcome === "FAIL").length,
    error: rows.filter((r) => r.outcome === "ERROR").length,
    lanesExecuted: rows.reduce((n, r) => n + (r.params?.lanes ?? 0), 0),
    serializationFailures: rows.reduce((n, r) => n + (r.serializationFailures ?? 0), 0),
    maxWallMs: Math.max(...rows.map((r) => r.wallMs ?? 0)),
    byScenario,
    laneTimeoutMs: LANE_TIMEOUT_MS,
    iterTimeoutMs: ITER_TIMEOUT_MS,
    failingSeeds: rows
      .filter((r) => r.outcome !== "PASS")
      .map((r) => ({
        iterSeed: r.iterSeed,
        scenario: r.scenario,
        outcome: r.outcome,
        violations: (r.violations ?? []).map((x) => x.name),
        replay: r.replay,
      })),
  };
  const out = { summary, table: rows };
  const file = join(
    OUT_DIR,
    ITER_SEED !== null ? `replay-${ITER_SEED}.json` : `results-seed${CAMPAIGN_SEED}-n${ITER}.json`,
  );
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`wrote ${file}`);
  for (const c of clients) await c.end();
  process.exit(summary.fail + summary.error === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
