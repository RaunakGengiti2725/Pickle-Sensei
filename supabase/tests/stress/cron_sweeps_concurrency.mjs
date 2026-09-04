#!/usr/bin/env node
// db-pg-cron-sweeps × concurrency — seeded stress harness against REAL Postgres.
//
// Unit under test: the three pg_cron maintenance sweeps scheduled by
// supabase/migrations/20260831000000_scale_and_security.sql
//   expire-stale-analysis-permits   (permits reserved > 24h → released/expired)
//   purge-expired-deletion-requests (account_deletion_requests past expires_at + 1d)
//   purge-old-webhook-events        (webhook_events older than 90d)
// racing the live write paths that touch the same rows: reserve_analysis_permit,
// apply_synced_shot, the finalize UPDATE the edge fn issues, the deletion-
// request upsert, the webhook audit upsert, plus a second actor (RLS).
//
// The stock postgres:16 image has no pg_cron, so the migration skips
// scheduling; this harness extracts the EXACT scheduled SQL strings from the
// migration file and runs them as the job owner (postgres), which is how
// pg_cron executes them (job owner = the role that called cron.schedule).
//
// Every iteration is a pure function of its seed: users, permit ages around
// the 24h boundary (clock skew of a few ms either side), deletion-request and
// webhook ages around their retention boundaries, the lane mix, the per-lane
// pg_sleep jitter, duplicate/cancelled lanes. All lanes open their own
// connection + transaction, set role/claims, wait at a barrier, then fire
// (Promise.all) — so the sweep UPDATE/DELETEs genuinely interleave with the
// RPCs and row-level locks.
//
//   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres \
//   STRESS_ITER=600 node supabase/tests/stress/cron_sweeps_concurrency.mjs
//
//   --seed <n>       replay ONE iteration from its seed (prints the JSON row)
//   --repeat <k>     replay that seed k times (flake rate)
//   STRESS_ITER      iterations (default 20 — small enough for the suite)
//   STRESS_SEED      campaign base seed (default 20260904)
//   STRESS_OUT       report dir (default artifacts/stress/db-pg-cron-sweeps/latest)
//   STRESS_SERIALIZABLE=1  run the sweep lanes under SERIALIZABLE (probe; the
//                    scheduled SQL carries no isolation clause, so pg_cron
//                    runs it at the server default READ COMMITTED)
//
// Exit code: 0 when every executed iteration held every invariant, 1 otherwise.
// Report: <out>/report.json (seed → outcome table), <out>/failures.json.

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
// `pg` is a dependency of @pickle/database — resolve it from there so this
// harness needs no package.json / lockfile of its own.
const require = createRequire(resolve(ROOT, "packages/database/package.json"));
const { Pool } = require("pg");

// ── config ──────────────────────────────────────────────────────────────────

const PG_URL = process.env.STRESS_PG_URL ?? "";
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const envInt = (name, dflt) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
};
const ITER = argValue("--iter") ? Number(argValue("--iter")) : envInt("STRESS_ITER", 20);
const BASE_SEED = envInt("STRESS_SEED", 20260904);
const REPLAY_SEED = argValue("--seed") ? Number(argValue("--seed")) >>> 0 : null;
const REPEAT = argValue("--repeat") ? Number(argValue("--repeat")) : 1;
const OUT_DIR = resolve(
  ROOT,
  process.env.STRESS_OUT ?? "artifacts/stress/db-pg-cron-sweeps/latest",
);
const SERIALIZABLE_SWEEPS = process.env.STRESS_SERIALIZABLE === "1";
// public.free_rating_ledger has no FK and is meant to SURVIVE account deletion
// (20260902150000), so a seed's identity subject must be unique per campaign
// run or the second run of the same seed inherits the first run's spent free
// ratings. Everything else about an iteration is a pure function of its seed;
// pass STRESS_NONCE to reproduce a run's ledger state exactly.
const NONCE = process.env.STRESS_NONCE ?? `${Date.now().toString(36)}${process.pid.toString(36)}`;
const LANE_TIMEOUT_MS = 10_000;
const ITER_WALL_BOUND_MS = 20_000;
const MIGRATION = resolve(ROOT, "supabase/migrations/20260831000000_scale_and_security.sql");

if (!PG_URL) {
  console.error("STRESS_PG_URL is required (see supabase/tests/stress/pg_up.sh)");
  process.exit(2);
}

// ── seeded rng (mulberry32, same as __wf__/xc_concurrency_harness.ts) ───────

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
  uuid() {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
  shuffle(items) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
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

// ── the scheduled SQL, extracted verbatim from the migration ────────────────

function extractCronJobs(sqlText) {
  const jobs = {};
  const re = /cron\.schedule\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'((?:[^']|'')*)'\s*\)/g;
  for (const m of sqlText.matchAll(re)) {
    jobs[m[1]] = { schedule: m[2], sql: m[3].replace(/''/g, "'") };
  }
  return jobs;
}

const CRON = extractCronJobs(readFileSync(MIGRATION, "utf8"));
for (const name of [
  "expire-stale-analysis-permits",
  "purge-expired-deletion-requests",
  "purge-old-webhook-events",
]) {
  if (!CRON[name]) throw new Error(`cron job ${name} not found in ${MIGRATION}`);
}
// STRESS_MUTANT rewrites ONE retention window in the sweep SQL the harness
// runs (never the migration). It exists to prove the invariants have teeth: a
// sweep that collects rows earlier than the migration says must be reported
// BROKEN. Unset in normal runs.
const MUTANT = process.env.STRESS_MUTANT ?? "";
const MUTANTS = {
  "": (name, sql) => sql,
  "permit-sweep-1h": (name, sql) =>
    name === "expire-stale-analysis-permits"
      ? sql.replace("interval '24 hours'", "interval '1 hour'")
      : sql,
  "deletion-sweep-0d": (name, sql) =>
    name === "purge-expired-deletion-requests" ? sql.replace("- interval '1 day'", "") : sql,
  "webhook-sweep-1d": (name, sql) =>
    name === "purge-old-webhook-events"
      ? sql.replace("interval '90 days'", "interval '1 day'")
      : sql,
  // not a sweep: drops the `status = 'reserved'` guard from the finalize UPDATE
  // the harness issues, i.e. the blind-write version of the edge route. Proves
  // the lost-update / no-double-consume invariants catch it.
  "finalize-no-status-guard": (name, sql) => sql,
};
if (!(MUTANT in MUTANTS)) throw new Error(`unknown STRESS_MUTANT ${MUTANT}`);
const mutate = MUTANTS[MUTANT];

const SWEEP_PERMITS = mutate(
  "expire-stale-analysis-permits",
  CRON["expire-stale-analysis-permits"].sql,
);
const SWEEP_DELETIONS = mutate(
  "purge-expired-deletion-requests",
  CRON["purge-expired-deletion-requests"].sql,
);
const SWEEP_WEBHOOKS = mutate("purge-old-webhook-events", CRON["purge-old-webhook-events"].sql);

// ── sql helpers ─────────────────────────────────────────────────────────────

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

function shotPayload(id, analysisPermitId, resultKind) {
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
    overallScore: resultKind === "scored" ? 7 : null,
    confidence: resultKind === "scored" ? 0.9 : 0.2,
    resultKind,
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
  };
}

const uuidRe = /^[0-9a-f-]{36}$/;
const lit = (uuid) => {
  if (!uuidRe.test(uuid)) throw new Error(`not a uuid: ${uuid}`);
  return `'${uuid}'`;
};

async function asUser(client, userId) {
  await client.query(`set local role authenticated`);
  await client.query(`set local request.jwt.claim.sub = ${lit(userId)}`);
}
async function asServiceRole(client) {
  await client.query(`set local role service_role`);
}

const nowMs = async (client) =>
  Number(
    (await client.query(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms`))
      .rows[0].ms,
  );

// ── scenario plan ───────────────────────────────────────────────────────────

const H = 3_600_000;
const D = 24 * H;

/** permit age buckets (ms). "edge" buckets straddle the 24h boundary by a few
 * hundred ms so the permit flips from live to stale WHILE the burst runs —
 * the clock-skew case where sweep, apply and reserve may disagree. */
function permitAge(prng) {
  const bucket = prng.pick(["live", "live", "edgeMinus", "edgePlus", "stale", "stale"]);
  switch (bucket) {
    case "live":
      return { bucket, ageMs: prng.int(1_000, 23 * H) };
    case "edgeMinus":
      return { bucket, ageMs: D - prng.int(0, 400) };
    case "edgePlus":
      return { bucket, ageMs: D + prng.int(0, 400) };
    default:
      return { bucket, ageMs: D + prng.int(1_000, 72 * H) };
  }
}

/** deletion-request expires_at relative to now (ms; negative = past) */
function deletionExpiry(prng) {
  const bucket = prng.pick(["fresh", "recent", "edgeMinus", "edgePlus", "stale"]);
  switch (bucket) {
    case "fresh":
      return { bucket, offsetMs: 15 * 60_000 };
    case "recent":
      return { bucket, offsetMs: -prng.int(60_000, 20 * H) };
    case "edgeMinus":
      return { bucket, offsetMs: -(D - prng.int(0, 400)) };
    case "edgePlus":
      return { bucket, offsetMs: -(D + prng.int(0, 400)) };
    default:
      return { bucket, offsetMs: -(D + prng.int(1_000, 5 * D)) };
  }
}

function webhookAge(prng) {
  const bucket = prng.pick(["fresh", "edgeMinus", "edgePlus", "old"]);
  switch (bucket) {
    case "fresh":
      return { bucket, ageMs: prng.int(1_000, 89 * D) };
    case "edgeMinus":
      return { bucket, ageMs: 90 * D - prng.int(0, 400) };
    case "edgePlus":
      return { bucket, ageMs: 90 * D + prng.int(0, 400) };
    default:
      return { bucket, ageMs: 90 * D + prng.int(1_000, 200 * D) };
  }
}

function plan(seed) {
  const prng = new Prng(seed);
  const userA = prng.uuid();
  const userB = prng.uuid();
  const premiumA = prng.chance(0.2);
  const preScoredA = premiumA ? 0 : prng.pick([0, 0, 1, 2]);
  // legacy over-issue: a free account holding more reserved permits than its
  // allowance (every build before reserve_analysis_permit could do this)
  const overIssued = !premiumA && prng.chance(0.25);
  const permitCount = prng.int(2, 4);
  const permits = Array.from({ length: permitCount }, (_, i) => ({
    id: prng.uuid(),
    key: `k-${seed}-${i}`,
    ...permitAge(prng),
  }));
  const permitsB = [
    { id: prng.uuid(), key: `kb-${seed}`, bucket: "live", ageMs: prng.int(1_000, 2 * H) },
  ];
  const deletion = prng.chance(0.85) ? { challenge: prng.uuid(), ...deletionExpiry(prng) } : null;
  const webhooks = Array.from({ length: prng.int(1, 3) }, (_, i) => ({
    id: `evt-${seed}-${i}`,
    ...webhookAge(prng),
  }));

  const lanes = [];
  const push = (lane) => lanes.push({ ...lane, delayMs: prng.int(0, 25) });

  // sweeps (pg_cron job owner). Two concurrent permit sweeps = the
  // "duplicate call" case (an overlapping run of the same job).
  push({ op: "sweep.permits", actor: "owner" });
  if (prng.chance(0.4)) push({ op: "sweep.permits", actor: "owner" });
  push({ op: "sweep.deletions", actor: "owner" });
  push({ op: "sweep.webhooks", actor: "owner" });

  // user A live writes on its own permits
  for (const p of permits) {
    const roll = prng.next();
    if (roll < 0.45) {
      const shotId = prng.uuid();
      const kind = prng.chance(0.8) ? "scored" : "low_confidence";
      push({ op: "apply", actor: "A", permitId: p.id, shotId, resultKind: kind });
      if (prng.chance(0.35)) {
        // duplicate call: the same sync fires twice (outbox retry)
        push({ op: "apply", actor: "A", permitId: p.id, shotId, resultKind: kind });
      }
      if (prng.chance(0.2)) {
        // cancel-during-call: the client disconnects → the tx is rolled back
        push({
          op: "apply",
          actor: "A",
          permitId: p.id,
          shotId: prng.uuid(),
          resultKind: kind,
          rollback: true,
        });
      }
    } else if (roll < 0.7) {
      push({
        op: "finalize",
        actor: "A",
        permitId: p.id,
        outcome: prng.pick(["cancelled", "low_confidence", "failed"]),
      });
      if (prng.chance(0.3))
        push({ op: "finalize", actor: "A", permitId: p.id, outcome: "cancelled" });
    } else if (roll < 0.85) {
      // idempotent replay of the reservation that minted this permit
      push({ op: "reserve", actor: "A", key: p.key, replayOf: p.id });
    }
    // second actor on the same row/id
    if (prng.chance(0.3)) {
      push({ op: "apply", actor: "B", permitId: p.id, shotId: prng.uuid(), resultKind: "scored" });
    }
    if (prng.chance(0.2))
      push({ op: "finalize", actor: "B", permitId: p.id, outcome: "cancelled" });
  }
  // fresh reservations while the sweep may be releasing stale ones
  const newReserves = prng.int(0, 2);
  for (let i = 0; i < newReserves; i++)
    push({ op: "reserve", actor: "A", key: `new-${seed}-${i}` });
  if (prng.chance(0.5)) push({ op: "access_state", actor: "A" });
  // B on its own permit (must be untouched by anything A does)
  if (prng.chance(0.5)) {
    push({
      op: "apply",
      actor: "B",
      permitId: permitsB[0].id,
      shotId: prng.uuid(),
      resultKind: "scored",
    });
  }

  // deletion request lifecycle
  const deletionUpserts = prng.int(0, 2);
  for (let i = 0; i < deletionUpserts; i++) {
    push({ op: "deletion.upsert", actor: "A", challenge: prng.uuid() });
  }
  if (prng.chance(0.5)) push({ op: "deletion.read", actor: "A" });
  if (prng.chance(0.3)) push({ op: "deletion.read", actor: "B" });

  // webhook audit log (service role): a replay of an old event and a new one
  for (const w of webhooks) {
    if (prng.chance(0.5)) push({ op: "webhook.log", actor: "service", eventId: w.id });
  }
  push({ op: "webhook.log", actor: "service", eventId: `evt-${seed}-new` });
  if (prng.chance(0.3)) push({ op: "webhook.read_as_user", actor: "A" });

  return {
    seed,
    userA,
    userB,
    premiumA,
    preScoredA,
    overIssued,
    permits,
    permitsB,
    deletion,
    webhooks,
    lanes: prng.shuffle(lanes),
  };
}

// ── setup / teardown (owner) ────────────────────────────────────────────────

async function createUser(client, userId, sub) {
  await client.query(
    `insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, '{"provider":"google"}')`,
    [userId, `${userId}@example.com`],
  );
  await client.query(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', $1, $2, jsonb_build_object('sub', $1::text))`,
    [sub, userId],
  );
}

async function setup(pool, p) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await createUser(c, p.userA, `sub-a-${p.seed}-${NONCE}`);
    await createUser(c, p.userB, `sub-b-${p.seed}-${NONCE}`);
    if (p.premiumA) {
      await c.query(
        `insert into public.billing_entitlements (user_id, premium, expires_at) values ($1, true, null)`,
        [p.userA],
      );
    }
    for (const permit of p.permits) {
      await c.query(
        `insert into public.analysis_permits (id, user_id, idempotency_key, status, created_at)
         values ($1, $2, $3, 'reserved', clock_timestamp() - ($4::float8 * interval '1 millisecond'))`,
        [permit.id, p.userA, permit.key, permit.ageMs],
      );
    }
    if (!p.overIssued && !p.premiumA) {
      // Keep the free allowance honest: a legitimately-issued free account holds
      // at most (2 - preScored) LIVE reserved permits. Surplus live permits are
      // aged past the sweep boundary instead of being finalized, so they stay
      // reserved rows the sweep must collect.
      const live = p.permits.filter((x) => x.ageMs < D);
      const allowed = Math.max(2 - p.preScoredA, 0);
      for (const extra of live.slice(allowed)) {
        extra.bucket = "stale";
        extra.ageMs = D + 2 * H;
        extra.agedForAllowance = true;
        await c.query(
          `update public.analysis_permits
              set created_at = clock_timestamp() - ($2::float8 * interval '1 millisecond')
            where id = $1`,
          [extra.id, extra.ageMs],
        );
      }
    }
    for (let i = 0; i < p.preScoredA; i++) {
      // owner write (no JWT sub): the write gate leaves it alone, the ledger
      // trigger records it — an already-spent rating from a previous device.
      await c.query(
        `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
           overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
           paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version,
           shot_config_version, source)
         values (gen_random_uuid(), $1, 'dink', 'side', now() - interval '2 days', 0, 100, 200, 6.5, 0.9, 'scored',
           '1.0.0','b','p','pd','s','ph','sc','c','real')`,
        [p.userA],
      );
    }
    for (const permit of p.permitsB) {
      await c.query(
        `insert into public.analysis_permits (id, user_id, idempotency_key, status, created_at)
         values ($1, $2, $3, 'reserved', clock_timestamp() - ($4::float8 * interval '1 millisecond'))`,
        [permit.id, p.userB, permit.key, permit.ageMs],
      );
    }
    if (p.deletion) {
      await c.query(
        `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
         values ($1, $2, clock_timestamp() + ($3::float8 * interval '1 millisecond') - interval '15 minutes',
                 clock_timestamp() + ($3::float8 * interval '1 millisecond'))`,
        [p.userA, p.deletion.challenge, p.deletion.offsetMs],
      );
    }
    for (const w of p.webhooks) {
      await c.query(
        `insert into public.webhook_events (id, provider, event_type, app_user_id, payload, received_at)
         values ($1, 'revenuecat', 'RENEWAL', $2, '{"stress":true}', clock_timestamp() - ($3::float8 * interval '1 millisecond'))`,
        [w.id, p.userA, w.ageMs],
      );
    }
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function teardown(pool, p) {
  await pool.query(`delete from auth.users where id = any($1::uuid[])`, [[p.userA, p.userB]]);
  await pool.query(`delete from public.webhook_events where id like $1`, [`evt-${p.seed}-%`]);
}

// ── lanes ───────────────────────────────────────────────────────────────────

const EXPECTED_VERDICTS = new Set([
  "accepted",
  "access.permit_not_found",
  "access.permit_not_reserved",
  "access.permit_expired",
  "access.paywall_required",
]);

/** Runs one sweep statement. pg_cron itself runs each job in its own
 * transaction at the cluster default (READ COMMITTED) and, on failure, simply
 * logs it and retries at the next tick — the sweeps are idempotent, so that is
 * safe. Under STRESS_SERIALIZABLE the same statement legitimately raises 40001
 * against a concurrent writer; the retrying-caller behaviour is modelled here
 * (bounded), and a lane that never succeeds is still reported as a failure. */
async function runSweep(client, sql, row) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await client.query(sql);
      row.result = "ok";
      row.rows = r.rowCount;
      return;
    } catch (e) {
      if (e.code !== "40001" || !SERIALIZABLE_SWEEPS || attempt >= 3) throw e;
      row.retries = attempt + 1;
      row.sqlstate = e.code;
      await client.query("rollback");
      await client.query("begin");
      await client.query(`set local statement_timeout = '${LANE_TIMEOUT_MS}ms'`);
      await client.query(`set transaction isolation level serializable`);
    }
  }
}

async function runLane(pool, p, lane, gate) {
  const client = await pool.connect();
  const row = {
    ...lane,
    result: null,
    rows: null,
    sqlstate: null,
    error: null,
    retries: 0,
    serverStartMs: 0,
    serverEndMs: 0,
  };
  const t0 = performance.now();
  try {
    await client.query("begin");
    await client.query(`set local statement_timeout = '${LANE_TIMEOUT_MS}ms'`);
    if (lane.actor === "owner" && SERIALIZABLE_SWEEPS) {
      await client.query(`set transaction isolation level serializable`);
    }
    if (lane.actor === "A") await asUser(client, p.userA);
    if (lane.actor === "B") await asUser(client, p.userB);
    if (lane.actor === "service") await asServiceRole(client);
    await gate;
    if (lane.delayMs > 0) await client.query(`select pg_sleep($1::float8 / 1000)`, [lane.delayMs]);
    row.serverStartMs = await nowMs(client);
    row.isolation = (
      await client.query(`show transaction_isolation`)
    ).rows[0].transaction_isolation;
    switch (lane.op) {
      case "sweep.permits":
        await runSweep(client, SWEEP_PERMITS, row);
        break;
      case "sweep.deletions":
        await runSweep(client, SWEEP_DELETIONS, row);
        break;
      case "sweep.webhooks":
        await runSweep(client, SWEEP_WEBHOOKS, row);
        break;
      case "apply": {
        const r = await client.query(`select public.apply_synced_shot($1::jsonb) as result`, [
          JSON.stringify(shotPayload(lane.shotId, lane.permitId, lane.resultKind)),
        ]);
        row.result = r.rows[0].result;
        break;
      }
      case "finalize": {
        // mirrors finalizeAnalysisPermitRoute (index.ts): PostgREST PATCH with
        // eq(id).eq(user_id).eq(status,'reserved')
        const guard = MUTANT === "finalize-no-status-guard" ? "" : `and status = 'reserved'`;
        const r = await client.query(
          `update public.analysis_permits set status = 'finalized', outcome = $1
           where id = $2 and user_id = $3 ${guard}
           returning status, outcome`,
          [lane.outcome, lane.permitId, lane.actor === "A" ? p.userA : p.userB],
        );
        row.rows = r.rowCount;
        row.result = r.rowCount === 1 ? "finalized" : "no_row";
        break;
      }
      case "reserve": {
        const r = await client.query(`select * from public.reserve_analysis_permit($1)`, [
          lane.key,
        ]);
        const out = r.rows[0];
        row.result = out.result;
        row.permitId = out.permit_id ?? null;
        row.permitStatus = out.permit_status ?? null;
        break;
      }
      case "access_state": {
        const r = await client.query(`select * from public.access_state()`);
        row.result = "ok";
        row.access = {
          premium: r.rows[0].premium,
          scored: Number(r.rows[0].scored_count),
          reserved: Number(r.rows[0].reserved_count),
        };
        break;
      }
      case "deletion.upsert": {
        // requestAccountDeletion: PostgREST upsert(onConflict user_id) — every
        // payload column lands in DO UPDATE
        const r = await client.query(
          `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
           values ($1, $2, now(), now() + interval '15 minutes')
           on conflict (user_id) do update
             set challenge = excluded.challenge, created_at = excluded.created_at, expires_at = excluded.expires_at
           returning challenge`,
          [p.userA, lane.challenge],
        );
        row.rows = r.rowCount;
        row.result = "ok";
        break;
      }
      case "deletion.read": {
        // confirmAccountDeletion's read: select ... eq(user_id, authed.id)
        const r = await client.query(
          `select challenge, created_at, expires_at from public.account_deletion_requests where user_id = $1`,
          [lane.actor === "A" ? p.userA : p.userB],
        );
        row.rows = r.rowCount;
        row.result = r.rowCount === 0 ? "none" : `challenge:${r.rows[0].challenge}`;
        break;
      }
      case "webhook.log": {
        // webhook route: select id → upsert(onConflict id, ignoreDuplicates)
        const seen = await client.query(`select id from public.webhook_events where id = $1`, [
          lane.eventId,
        ]);
        const r = await client.query(
          `insert into public.webhook_events (id, provider, event_type, app_user_id, payload)
           values ($1, 'revenuecat', 'RENEWAL', $2, '{"stress":"replay"}')
           on conflict (id) do nothing`,
          [lane.eventId, p.userA],
        );
        row.seen = seen.rowCount;
        row.rows = r.rowCount;
        row.result =
          seen.rowCount === 1 ? "duplicate" : r.rowCount === 1 ? "inserted" : "conflict_after_miss";
        break;
      }
      case "webhook.read_as_user": {
        // savepoint: the expected 42501 aborts the transaction otherwise
        await client.query(`savepoint probe`);
        try {
          await client.query(`select id from public.webhook_events limit 1`);
          row.result = "readable";
          await client.query(`release savepoint probe`);
        } catch (e) {
          row.result = `denied:${e.code}`;
          await client.query(`rollback to savepoint probe`);
        }
        break;
      }
      default:
        throw new Error(`unknown lane op ${lane.op}`);
    }
    row.serverEndMs = await nowMs(client);
    if (lane.rollback) {
      await client.query("rollback");
      row.result = `rolled_back(${row.result})`;
    } else {
      await client.query("commit");
    }
  } catch (e) {
    row.error = String(e.message ?? e);
    row.sqlstate = e.code ?? null;
    row.result = `error:${e.code ?? "?"}`;
    await client.query("rollback").catch(() => {});
  } finally {
    row.clientMs = Math.round((performance.now() - t0) * 10) / 10;
    client.release();
  }
  return row;
}

// ── invariants ──────────────────────────────────────────────────────────────

async function observe(pool, p) {
  const permits = (
    await pool.query(
      `select id, user_id, status, outcome, idempotency_key,
              (extract(epoch from created_at) * 1000)::float8 as created_ms
       from public.analysis_permits where user_id = any($1::uuid[]) order by created_at`,
      [[p.userA, p.userB]],
    )
  ).rows;
  const shots = (
    await pool.query(
      `select id, user_id, result_kind from public.shots where user_id = any($1::uuid[])`,
      [[p.userA, p.userB]],
    )
  ).rows;
  const ledger = (
    await pool.query(
      `select i.user_id, coalesce(l.scored_count, 0)::int as scored_count
       from auth.identities i
       left join public.free_rating_ledger l
         on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
       where i.user_id = any($1::uuid[])`,
      [[p.userA, p.userB]],
    )
  ).rows;
  const deletion =
    (
      await pool.query(
        `select user_id, challenge, (extract(epoch from expires_at) * 1000)::float8 as expires_ms
       from public.account_deletion_requests where user_id = $1`,
        [p.userA],
      )
    ).rows[0] ?? null;
  const webhooks = (
    await pool.query(
      `select id, (extract(epoch from received_at) * 1000)::float8 as received_ms
       from public.webhook_events where id like $1 order by id`,
      [`evt-${p.seed}-%`],
    )
  ).rows;
  return { permits, shots, ledger, deletion, webhooks };
}

/** the sweepable rows of this iteration, keyed by row id, with the server
 * timestamp that decides eligibility. Planned ages are relative to the
 * INSERT's clock_timestamp(), so only these values may be compared against a
 * sweep's clock. */
async function snapshot(pool, p) {
  const rows = new Map();
  for (const r of (
    await pool.query(
      `select id, status, outcome, (extract(epoch from created_at) * 1000)::float8 as ms
       from public.analysis_permits where user_id = any($1::uuid[])`,
      [[p.userA, p.userB]],
    )
  ).rows) {
    rows.set(`permit:${r.id}`, {
      kind: "permit",
      id: r.id,
      eligibleAtMs: r.ms + D,
      swept: r.outcome === "expired",
    });
  }
  for (const r of (
    await pool.query(
      `select user_id, (extract(epoch from expires_at) * 1000)::float8 as ms
       from public.account_deletion_requests where user_id = any($1::uuid[])`,
      [[p.userA, p.userB]],
    )
  ).rows) {
    rows.set(`deletion:${r.user_id}`, {
      kind: "deletion",
      id: r.user_id,
      eligibleAtMs: r.ms + D,
      swept: false,
    });
  }
  for (const r of (
    await pool.query(
      `select id, (extract(epoch from received_at) * 1000)::float8 as ms
       from public.webhook_events where id like $1`,
      [`evt-${p.seed}-%`],
    )
  ).rows) {
    rows.set(`webhook:${r.id}`, {
      kind: "webhook",
      id: r.id,
      eligibleAtMs: r.ms + 90 * D,
      swept: false,
    });
  }
  return rows;
}

/** what the second sweep pass collected that the first one left behind */
function sweptBetween(before, after) {
  const changed = [];
  for (const [key, row] of before) {
    const now = after.get(key);
    if (!now) changed.push({ ...row, change: "deleted" });
    else if (!row.swept && now.swept) changed.push({ ...now, change: "expired" });
  }
  return changed;
}

function checkInvariants(p, lanes, obs, marks) {
  const failures = [];
  const fail = (invariant, detail) => failures.push({ invariant, detail });
  const permitById = new Map(obs.permits.map((r) => [r.id, r]));
  const shotIds = new Set(obs.shots.map((s) => s.id));
  const scoredA = obs.shots.filter(
    (s) => s.user_id === p.userA && s.result_kind === "scored",
  ).length;
  const scoredB = obs.shots.filter(
    (s) => s.user_id === p.userB && s.result_kind === "scored",
  ).length;

  // I1 — no lane error (deadlock 40P01, serialization 40001, timeout 57014, anything)
  for (const l of lanes) {
    if (l.error) fail("I1.no_lane_error", `${l.op}/${l.actor} sqlstate=${l.sqlstate} ${l.error}`);
    if (
      l.op === "apply" &&
      !l.error &&
      !EXPECTED_VERDICTS.has(l.result.replace(/^rolled_back\((.*)\)$/, "$1"))
    ) {
      fail("I1.no_lane_error", `apply returned unexpected verdict ${l.result}`);
    }
    if (l.clientMs > LANE_TIMEOUT_MS) fail("I11.bounded_wall_time", `${l.op} took ${l.clientMs}ms`);
  }

  // I2 — free limit: a non-premium account never exceeds two lifetime scored
  // ratings, and the identity ledger equals the account's scored count.
  if (!p.premiumA && scoredA > 2) fail("I2.free_limit", `user A has ${scoredA} scored shots`);
  const ledgerA = obs.ledger.find((l) => l.user_id === p.userA);
  if (!ledgerA || ledgerA.scored_count !== scoredA) {
    fail("I2.ledger_matches_scored", `ledger=${ledgerA?.scored_count} scored=${scoredA}`);
  }

  // I3 — the sweep (and apply's own expiry) only ever expire permits that were
  // really older than 24h. The bound is the LAST moment a sweep could have run
  // (finalSweepEndMs): a permit that crosses the boundary mid-campaign is
  // legitimately collectable by any sweep after the crossing.
  for (const r of obs.permits) {
    if (r.outcome === "expired") {
      if (r.status !== "released") fail("I3.expired_is_released", `${r.id} status=${r.status}`);
      if (r.created_ms >= marks.finalSweepEndMs - D) {
        fail(
          "I3.sweep_only_stale",
          `${r.id} expired but age at the last sweep was ${(marks.finalSweepEndMs - r.created_ms) / 1000}s`,
        );
      }
    }
  }
  // …and after the final sweep, no stale permit is still reserved
  for (const r of obs.permits) {
    if (r.status === "reserved" && r.created_ms < marks.finalSweepStartMs - D) {
      fail(
        "I3.sweep_complete",
        `${r.id} reserved but ${(marks.finalSweepStartMs - r.created_ms) / 1000}s old after the final sweep`,
      );
    }
  }
  // I10 — sweep idempotency, modulo the clock: back-to-back passes must be
  // no-ops EXCEPT for a row that became eligible between the two passes (an
  // "edge" row crossing its boundary mid-campaign). Anything else the second
  // pass touched is a row the first pass should already have collected.
  for (const c of marks.pass2Changes) {
    if (c.eligibleAtMs <= marks.finalSweepStartMs) {
      fail(
        "I10.sweep_idempotent",
        `second pass ${c.change} ${c.kind} ${c.id}, eligible ${(marks.finalSweepStartMs - c.eligibleAtMs) / 1000}s before the first pass`,
      );
    }
  }

  // I4/I5 — accepted apply ⇒ exactly one shot row + permit consumed; rejected
  // apply ⇒ no row unless a duplicate lane of the same shot was accepted.
  const acceptedShots = new Set(
    lanes.filter((l) => l.op === "apply" && l.result === "accepted").map((l) => l.shotId),
  );
  for (const l of lanes.filter((x) => x.op === "apply")) {
    const has = shotIds.has(l.shotId);
    if (l.result === "accepted") {
      if (!has) fail("I4.accepted_shot_persisted", `${l.shotId} accepted but missing`);
      const permit = permitById.get(l.permitId);
      const expected =
        l.resultKind === "scored" ? ["finalized", "scored"] : ["released", "low_confidence"];
      if (!permit || permit.status !== expected[0] || permit.outcome !== expected[1]) {
        fail(
          "I4.accepted_permit_consumed",
          `${l.permitId} is ${permit?.status}/${permit?.outcome}, want ${expected.join("/")}`,
        );
      }
    } else if (!acceptedShots.has(l.shotId) && has) {
      fail("I5.rejected_shot_absent", `${l.shotId} rejected (${l.result}) but a row exists`);
    }
    if (
      l.actor === "B" &&
      p.permits.some((x) => x.id === l.permitId) &&
      l.result !== "access.permit_not_found"
    ) {
      fail("I12.rls_cross_user_permit", `B applying A's permit got ${l.result}`);
    }
  }
  if (obs.shots.length !== shotIds.size) fail("I4.no_duplicate_rows", "duplicate shot ids");

  // I6 — a finalized permit is never re-flipped by the sweep
  for (const r of obs.permits) {
    if (r.status === "finalized" && r.outcome === "expired") fail("I6.finalized_not_expired", r.id);
  }
  for (const l of lanes.filter((x) => x.op === "finalize")) {
    if (l.actor === "B" && l.rows !== 0)
      fail("I12.rls_cross_user_finalize", `B finalized A's permit ${l.permitId}`);
    if (l.actor === "A" && l.rows === 1) {
      const permit = permitById.get(l.permitId);
      const twin = lanes.filter(
        (x) => x.op === "finalize" && x.actor === "A" && x.permitId === l.permitId && x.rows === 1,
      );
      if (twin.length > 1)
        fail("I6.finalize_once", `${l.permitId} finalized by ${twin.length} lanes`);
      if (
        !permit ||
        permit.status !== "finalized" ||
        !twin.some((t) => t.outcome === permit.outcome)
      ) {
        fail("I6.finalize_persisted", `${l.permitId} is ${permit?.status}/${permit?.outcome}`);
      }
    }
  }
  // no lost update: every permit row ends in a state some lane (or the sweep) wrote
  for (const r of obs.permits.filter((x) => x.user_id === p.userA)) {
    const setup = p.permits.find((x) => x.id === r.id);
    if (!setup) continue; // minted by a reserve lane
    const writers = lanes.filter((l) => l.permitId === r.id && !l.error && !l.rollback);
    const reachable = new Set(["reserved/null", "released/expired"]);
    for (const w of writers) {
      if (w.op === "finalize" && w.rows === 1) reachable.add(`finalized/${w.outcome}`);
      if (w.op === "apply" && w.result === "accepted") {
        reachable.add(w.resultKind === "scored" ? "finalized/scored" : "released/low_confidence");
      }
      if (w.op === "apply" && w.result === "access.paywall_required")
        reachable.add("released/free_limit_exceeded");
    }
    if (!reachable.has(`${r.status}/${r.outcome}`)) {
      fail(
        "I6.no_lost_update",
        `${r.id} is ${r.status}/${r.outcome}; reachable=${[...reachable].join(",")}`,
      );
    }
  }

  // I7 — reservation accounting (only when no permit straddles the boundary
  // and the account was not over-issued: then scored + live reserved ≤ 2)
  const edgy = p.permits.some((x) => x.bucket === "edgeMinus" || x.bucket === "edgePlus");
  if (!p.premiumA && !p.overIssued && !edgy) {
    const live = obs.permits.filter(
      (r) =>
        r.user_id === p.userA && r.status === "reserved" && r.created_ms > marks.burstEndMs - D,
    ).length;
    if (scoredA + live > 2) fail("I7.allowance", `scored=${scoredA} live=${live}`);
  }
  for (const l of lanes.filter((x) => x.op === "reserve" && x.replayOf)) {
    if (l.result !== "accepted" || l.permitId !== l.replayOf) {
      fail("I8.reserve_idempotent", `replay of ${l.key} → ${l.result} ${l.permitId}`);
    }
  }
  for (const l of lanes.filter(
    (x) => x.op === "reserve" && !x.replayOf && x.result === "accepted",
  )) {
    const twins = lanes.filter(
      (x) => x.op === "reserve" && x.key === l.key && x.result === "accepted",
    );
    if (new Set(twins.map((t) => t.permitId)).size !== 1) fail("I8.reserve_no_duplicate", l.key);
  }
  // B's world is untouched by A
  if (scoredB > 1) fail("I12.user_b_isolated", `B scored=${scoredB}`);

  // I9 — deletion requests
  const upserts = lanes.filter((l) => l.op === "deletion.upsert" && !l.error);
  if (upserts.length > 0) {
    const winner = upserts.reduce((a, b) => (b.serverEndMs > a.serverEndMs ? b : a));
    if (!obs.deletion) fail("I9.fresh_request_survives", "row missing after upsert(s)");
    else if (obs.deletion.challenge !== winner.challenge) {
      fail(
        "I9.last_writer_wins",
        `row challenge=${obs.deletion.challenge} winner=${winner.challenge}`,
      );
    }
  } else if (p.deletion) {
    const seeded = marks.setupSnap.get(`deletion:${p.userA}`);
    const expiresMs = seeded.eligibleAtMs - D;
    const staleAtFinal = expiresMs < marks.finalSweepStartMs - D;
    const liveAtEnd = expiresMs >= marks.finalSweepEndMs - D;
    if (staleAtFinal && obs.deletion)
      fail("I9.purge_complete", `stale request (${p.deletion.bucket}) survived`);
    if (liveAtEnd && !obs.deletion)
      fail("I9.retention_grace", `request (${p.deletion.bucket}) purged inside the 1-day grace`);
  }
  for (const l of lanes.filter((x) => x.op === "deletion.read" && x.actor === "B")) {
    if (l.rows !== 0) fail("I12.rls_deletion_request", "B read A's deletion request");
  }

  // I13 — webhook audit log
  const whById = new Map(obs.webhooks.map((w) => [w.id, w]));
  const logged = lanes.filter((l) => l.op === "webhook.log" && !l.error);
  for (const l of logged) {
    if (l.eventId.endsWith("-new") && !whById.has(l.eventId))
      fail("I13.fresh_event_survives", l.eventId);
    if (l.result === "inserted" && !whById.has(l.eventId)) {
      fail("I13.replayed_insert_survives", `${l.eventId} inserted (received_at=now) then purged`);
    }
  }
  for (const w of p.webhooks) {
    const row = whById.get(w.id);
    const replayed = logged.some((l) => l.eventId === w.id && l.result === "inserted");
    const receivedMs = marks.setupSnap.get(`webhook:${w.id}`).eligibleAtMs - 90 * D;
    const staleAtFinal = receivedMs < marks.finalSweepStartMs - 90 * D;
    const liveAtEnd = receivedMs >= marks.finalSweepEndMs - 90 * D;
    if (staleAtFinal && row && !replayed && row.received_ms < marks.finalSweepStartMs - 90 * D) {
      fail("I13.purge_complete", `${w.id} (${w.bucket}) survived the final sweep`);
    }
    if (liveAtEnd && !row)
      fail("I13.retention_window", `${w.id} (${w.bucket}) purged before 90 days`);
  }
  for (const l of lanes.filter((x) => x.op === "webhook.read_as_user")) {
    if (!l.result.startsWith("denied:42501"))
      fail("I12.rls_webhook_events", `authenticated read → ${l.result}`);
  }

  return failures;
}

// ── one iteration ───────────────────────────────────────────────────────────

async function runIteration(pool, seed) {
  const p = plan(seed);
  const t0 = performance.now();
  const marks = {};
  let lanes = [];
  let failures = [];
  let obs = null;
  try {
    await setup(pool, p);
    marks.setupSnap = await snapshot(pool, p);
    marks.setupNowMs = await nowMs(pool);
    let open;
    const gate = new Promise((r) => (open = r));
    const pending = p.lanes.map((lane) => runLane(pool, p, lane, gate));
    // every lane has its connection + transaction open before anyone fires
    await new Promise((r) => setImmediate(r));
    open();
    const bound = new Promise((_, rej) =>
      setTimeout(
        () => rej(new Error(`iteration exceeded ${ITER_WALL_BOUND_MS}ms wall bound`)),
        ITER_WALL_BOUND_MS,
      ),
    );
    lanes = await Promise.race([Promise.all(pending), bound]);
    marks.burstEndMs = await nowMs(pool);
    // pg_cron's next tick: run each sweep twice more; the second pass must be a no-op
    marks.finalSweepStartMs = await nowMs(pool);
    marks.finalSweep1Rows = (await pool.query(SWEEP_PERMITS)).rowCount;
    marks.finalDeletion1Rows = (await pool.query(SWEEP_DELETIONS)).rowCount;
    marks.finalWebhook1Rows = (await pool.query(SWEEP_WEBHOOKS)).rowCount;
    const afterPass1 = await snapshot(pool, p);
    marks.finalSweep2Rows = (await pool.query(SWEEP_PERMITS)).rowCount;
    marks.finalDeletion2Rows = (await pool.query(SWEEP_DELETIONS)).rowCount;
    marks.finalWebhook2Rows = (await pool.query(SWEEP_WEBHOOKS)).rowCount;
    marks.finalSweepEndMs = await nowMs(pool);
    marks.pass2Changes = sweptBetween(afterPass1, await snapshot(pool, p));
    obs = await observe(pool, p);
    failures = checkInvariants(p, lanes, obs, marks);
  } catch (e) {
    failures.push({ invariant: "I0.iteration_ran", detail: String(e.message ?? e) });
  } finally {
    await teardown(pool, p).catch((e) =>
      failures.push({ invariant: "I0.teardown", detail: String(e.message) }),
    );
  }
  const wallMs = Math.round(performance.now() - t0);
  const overlap = lanes.filter((l) => l.serverStartMs > 0).length > 1 ? overlapCount(lanes) : 0;
  return {
    seed,
    outcome: failures.length === 0 ? "HELD" : "BROKEN",
    failures,
    wallMs,
    lanes: lanes.length,
    concurrentPairs: overlap,
    inputs: {
      premiumA: p.premiumA,
      preScoredA: p.preScoredA,
      overIssued: p.overIssued,
      permits: p.permits.map((x) => ({
        bucket: x.bucket,
        ageMs: x.ageMs,
        agedForAllowance: Boolean(x.agedForAllowance),
      })),
      deletion: p.deletion ? { bucket: p.deletion.bucket, offsetMs: p.deletion.offsetMs } : null,
      webhooks: p.webhooks.map((x) => ({ bucket: x.bucket, ageMs: x.ageMs })),
      laneMix: histogram(p.lanes.map((l) => `${l.op}/${l.actor}${l.rollback ? "/rollback" : ""}`)),
    },
    lanesDetail: lanes.map((l) => ({
      op: l.op,
      actor: l.actor,
      result: l.result,
      rows: l.rows ?? undefined,
      sqlstate: l.sqlstate ?? undefined,
      isolation: l.isolation,
      retries: l.retries,
      delayMs: l.delayMs,
      serverMs: Math.round(l.serverEndMs - l.serverStartMs),
      clientMs: l.clientMs,
      permitId: l.permitId,
      shotId: l.shotId,
    })),
    sweeps: {
      finalPass1: [marks.finalSweep1Rows, marks.finalDeletion1Rows, marks.finalWebhook1Rows],
      finalPass2: [marks.finalSweep2Rows, marks.finalDeletion2Rows, marks.finalWebhook2Rows],
    },
    final: obs
      ? {
          permitsA: obs.permits
            .filter((r) => r.user_id === p.userA)
            .map((r) => `${r.status}/${r.outcome}`),
          scoredA: obs.shots.filter((s) => s.user_id === p.userA && s.result_kind === "scored")
            .length,
          ledgerA: obs.ledger.find((l) => l.user_id === p.userA)?.scored_count,
          deletionRow: Boolean(obs.deletion),
          webhookRows: obs.webhooks.map((w) => w.id),
        }
      : null,
    replay:
      `STRESS_PG_URL=$STRESS_PG_URL node supabase/tests/stress/cron_sweeps_concurrency.mjs --seed ${seed}` +
      ` # ledger-identical replay: STRESS_NONCE=${NONCE}`,
  };
}

function overlapCount(lanes) {
  let n = 0;
  const rows = lanes.filter((l) => l.serverStartMs > 0 && l.serverEndMs > 0);
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (
        rows[i].serverStartMs < rows[j].serverEndMs &&
        rows[j].serverStartMs < rows[i].serverEndMs
      )
        n++;
    }
  }
  return n;
}

function histogram(items) {
  const h = {};
  for (const i of items) h[i] = (h[i] ?? 0) + 1;
  return h;
}

// ── one-off probes (not seeded; recorded once per campaign) ─────────────────

async function probeEnvironment(pool) {
  const version = (await pool.query(`select version()`)).rows[0].version;
  const pgCron =
    (await pool.query(`select 1 from pg_extension where extname = 'pg_cron'`)).rowCount === 1;
  const pgCronAvailable =
    (await pool.query(`select 1 from pg_available_extensions where name = 'pg_cron'`)).rowCount ===
    1;
  const isolation = (await pool.query(`show default_transaction_isolation`)).rows[0]
    .default_transaction_isolation;
  return {
    version,
    pgCronInstalled: pgCron,
    pgCronAvailable,
    defaultIsolation: isolation,
    cron: CRON,
  };
}

/** Does the stale-permit sweep use analysis_permits_reserved_created_idx once
 * the table is large? (20260902130200_permits_reserved_sweep_index.sql) */
async function probeSweepPlan(pool) {
  const uid = "00000000-0000-4000-8000-00000000feed";
  const c = await pool.connect();
  try {
    await c.query("begin");
    await createUser(c, uid, `sub-plan-probe-${NONCE}`);
    await c.query(
      `insert into public.analysis_permits (user_id, idempotency_key, status, created_at)
       select $1, 'plan-' || g, case when g % 50 = 0 then 'reserved' else 'finalized' end,
              now() - (g || ' seconds')::interval
       from generate_series(1, 20000) g`,
      [uid],
    );
    await c.query(`analyze public.analysis_permits`);
    const plan = (await c.query(`explain (format json) ${SWEEP_PERMITS}`)).rows[0]["QUERY PLAN"];
    const text = JSON.stringify(plan);
    await c.query("rollback");
    return {
      usesReservedIndex: text.includes("analysis_permits_reserved_created_idx"),
      planNodes: [...text.matchAll(/"Node Type":"([^"]+)"/g)].map((m) => m[1]),
    };
  } finally {
    c.release();
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const pool = new Pool({ connectionString: PG_URL, max: 40 });
  mkdirSync(OUT_DIR, { recursive: true });
  const started = new Date().toISOString();
  const env = await probeEnvironment(pool);
  const sweepPlan = await probeSweepPlan(pool);

  const seeds =
    REPLAY_SEED !== null
      ? Array.from({ length: REPEAT }, () => REPLAY_SEED)
      : Array.from({ length: ITER }, (_, i) => fnv1a(`${BASE_SEED}:${i}`));

  const results = [];
  const t0 = performance.now();
  for (const seed of seeds) {
    const r = await runIteration(pool, seed);
    results.push(r);
    if (r.outcome !== "HELD") {
      console.error(
        `seed ${seed} BROKEN: ${r.failures.map((f) => `${f.invariant}: ${f.detail}`).join(" | ")}`,
      );
    }
  }
  const wallMs = Math.round(performance.now() - t0);
  await pool.end();

  const broken = results.filter((r) => r.outcome !== "HELD");
  const invariantHits = histogram(broken.flatMap((r) => r.failures.map((f) => f.invariant)));
  const laneTotals = results.reduce((n, r) => n + r.lanes, 0);
  const report = {
    unit: "db-pg-cron-sweeps",
    lens: "concurrency",
    started,
    baseSeed: BASE_SEED,
    replaySeed: REPLAY_SEED,
    mutant: MUTANT || null,
    identityNonce: NONCE,
    serializableSweeps: SERIALIZABLE_SWEEPS,
    env,
    sweepPlan,
    iterations: results.length,
    lanesExecuted: laneTotals,
    concurrentPairs: results.reduce((n, r) => n + r.concurrentPairs, 0),
    sweepSerializationRetries: results.reduce(
      (n, r) =>
        n +
        Object.values(r.lanesDetail)
          .flat()
          .filter((l) => l.retries > 0).length,
      0,
    ),
    held: results.length - broken.length,
    broken: broken.length,
    invariantHits,
    wallMs,
    maxIterationWallMs: Math.max(0, ...results.map((r) => r.wallMs)),
    table: results.map(({ lanesDetail, ...rest }) => rest),
    lanesDetail: Object.fromEntries(results.map((r) => [r.seed, r.lanesDetail])),
  };
  writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(resolve(OUT_DIR, "failures.json"), JSON.stringify(broken, null, 2));
  if (REPLAY_SEED !== null)
    console.log(
      JSON.stringify(
        results.map(({ lanesDetail, ...r }) => r),
        null,
        2,
      ),
    );
  console.log(
    `db-pg-cron-sweeps/concurrency: ${results.length} iterations, ${laneTotals} lanes, ` +
      `${report.concurrentPairs} overlapping pairs, held=${report.held} broken=${report.broken} ` +
      `wall=${wallMs}ms max/iter=${report.maxIterationWallMs}ms ` +
      `sweepRetries=${report.sweepSerializationRetries} sweepIndex=${sweepPlan.usesReservedIndex} ` +
      `pg_cron=${env.pgCronInstalled ? "installed" : "absent (SQL driven directly)"} → ${OUT_DIR}`,
  );
  process.exit(broken.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
