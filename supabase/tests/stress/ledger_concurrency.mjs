#!/usr/bin/env node
// ============================================================================
// Pickle Sensei — free_rating_ledger concurrency stress harness (real Postgres).
//
// Unit under test (supabase/migrations): public.free_rating_ledger,
// lifetime_scored_count() / identity_scored_count(), the definer triggers
// record_scored_shot_in_ledger (AFTER INSERT on shots) and
// inherit_free_rating_ledger (AFTER INSERT on auth.identities),
// reject_ledger_mutation (append-only ledgers), enforce_scored_shot_permit
// (direct-INSERT gate), and the two RPCs that spend free ratings —
// reserve_analysis_permit(text) and apply_synced_shot(jsonb).
//
// Every iteration is a seeded interleaving: a PRNG derived from
// (STRESS_SEED, scenario, index) picks lane counts, users, pre-spent counts,
// per-lane release jitter, isolation level, cancel lanes and clock offsets.
// N independent client transactions open, set `role authenticated` + the JWT
// `sub`, wait at a barrier and are released together (Promise.all burst),
// then the OWNER connection reads the committed end state and checks the
// invariants. Server-side clock_timestamp() stamps prove the lanes really
// overlapped. Every iteration is replayable from its seed alone:
//
//   STRESS_REPLAY=<scenario>:<seed> node ledger_concurrency.mjs
//
// Setup (never a hosted project):
//   ./pg_up.sh                       # postgres:16 on 127.0.0.1:5499 + shim + migrations
//   node ledger_concurrency.mjs      # quick pass: STRESS_ITER=24 (2 per scenario)
//   STRESS_ITER=600 STRESS_SEED=7 node ledger_concurrency.mjs   # campaign
//   ./pg_up.sh down
//
// Env: STRESS_PG_URL (default postgres://postgres:pg@127.0.0.1:5499/postgres),
//      STRESS_ITER (total iterations, spread round-robin over the scenarios),
//      STRESS_SEED (master seed, default 1), STRESS_SCENARIO (comma list),
//      STRESS_ISOLATION (rc|serializable|mixed, default mixed),
//      STRESS_OUT (directory for results.json / summary.json,
//      default /tmp/pickle-stress), STRESS_REPLAY (scenario:seed),
//      STRESS_REPEAT (re-run the replayed seed N times → flake rate),
//      STRESS_VERBOSE (print HELD rows too).
//
// Output: STRESS_OUT/results.json — one row per executed iteration
// {scenario, seed, outcome: HELD|BROKEN, violations, statuses, ...} — and
// summary.json. Exit 0 iff every executed iteration HELD.
//
// `pg` is resolved through packages/database (the workspace already depends
// on it) so this file adds no dependency; run `pnpm install` once at the root.
//
// Known BROKEN classes at 1fb0efd7 (both also reproduce on origin/main —
// deterministic two-session psql repros live next to this file):
//   link_during_apply   → repro_link_during_apply.sh   (identity linked while a
//                         scored shot is applied ends without a ledger row)
//   delete_during_apply → repro_delete_during_apply_deadlock.sh (account
//                         deletion vs in-flight apply_synced_shot: 40P01)
// ============================================================================

import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const require = createRequire(path.join(ROOT, "packages/database/package.json"));
const { Pool } = require("pg");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PG_URL = process.env.STRESS_PG_URL ?? "postgres://postgres:pg@127.0.0.1:5499/postgres";
const MASTER_SEED = Number(process.env.STRESS_SEED ?? 1);
const TOTAL_ITER = Number(process.env.STRESS_ITER ?? 24);
const ISOLATION_MODE = process.env.STRESS_ISOLATION ?? "mixed";
const OUT_DIR = process.env.STRESS_OUT ?? "/tmp/pickle-stress";
const REPLAY = process.env.STRESS_REPLAY ?? "";
const ONLY = (process.env.STRESS_SCENARIO ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ITER_WALL_BOUND_MS = 15_000; // a whole interleaving must settle within this
const LANE_STATEMENT_TIMEOUT = "8s"; // a hung lane becomes SQLSTATE 57014, never a hang

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

// The unique-run tag keeps ids and provider subjects distinct across harness
// runs against the same database (ledger rows are never deleted — by design).
const RUN_TAG = randomUUID().slice(0, 8);

// ---------------------------------------------------------------------------
// Seeded RNG (splitmix32) — every iteration's choices derive from its seed only.
// ---------------------------------------------------------------------------
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function makeRng(seed, salt = RUN_TAG) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 4294967296;
  };
  return {
    float: next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    uuid: () => {
      // v4-shaped uuid: one draw from the stream (so the schedule stays
      // replayable) mixed with the per-run/per-iteration salt (so a replayed
      // seed does not collide with rows an earlier run left in the database).
      const b = createHash("sha1").update(`${salt}:${next()}`).digest().subarray(0, 16);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = b.toString("hex");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shotPayload(id, permitId, overrides = {}) {
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
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

function histogram(values) {
  const h = {};
  for (const v of values) h[v] = (h[v] ?? 0) + 1;
  return h;
}

function pickIsolation(rng) {
  if (ISOLATION_MODE === "rc") return "read committed";
  if (ISOLATION_MODE === "serializable") return "serializable";
  return rng.chance(0.3) ? "serializable" : "read committed";
}

class Fixtures {
  constructor(pool) {
    this.pool = pool;
  }
  async q(text, params = []) {
    return this.pool.query(text, params);
  }
  /** Create an auth user (fires handle_new_user → profiles) plus identities. */
  async user(rng, { identities = 1, premium = false, subjects = null } = {}) {
    const id = rng.uuid();
    const subs =
      subjects ??
      Array.from({ length: identities }, (_, i) => ({
        provider: i === 0 ? "google" : "apple",
        sub: `${RUN_TAG}-${id.slice(0, 8)}-${i}`,
      }));
    await this.q(
      `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
       values ($1, $2, '{"full_name":"Stress"}', '{"provider":"google"}')`,
      [id, `${id.slice(0, 8)}@stress.example.com`],
    );
    for (const s of subs) await this.link(id, s);
    if (premium) {
      await this.q(
        `insert into public.billing_entitlements (user_id, premium, expires_at)
         values ($1, true, null)
         on conflict (user_id) do update set premium = true, expires_at = null`,
        [id],
      );
    }
    return { id, subs };
  }
  async link(userId, s) {
    await this.q(
      `insert into auth.identities (provider, provider_id, user_id, identity_data)
       values ($1, $2, $3, jsonb_build_object('sub', $2::text))`,
      [s.provider, s.sub, userId],
    );
  }
  /** Owner-written scored shot (no JWT sub → gate bypassed, ledger trigger fires). */
  async ownerScoredShot(userId, shotId) {
    await this.q(
      `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms,
         contact_ms, end_ms, overall_score, analysis_confidence, result_kind, app_version,
         model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version,
         phase_model_version, scoring_model_version, shot_config_version, source)
       values ($1, $2, 'dink', 'side', '2026-09-01T09:00:00Z', 0, 100, 200, 7, 0.9, 'scored',
         '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1', 'real')`,
      [shotId, userId],
    );
  }
  async preSpend(rng, userId, n) {
    for (let i = 0; i < n; i++) await this.ownerScoredShot(userId, rng.uuid());
  }
  /** Over-issue a reserved permit exactly as pre-reservation builds could. */
  async ownerPermit(userId, key, createdAtSql = "now()") {
    const r = await this.q(
      `insert into public.analysis_permits (user_id, idempotency_key, created_at)
       values ($1, $2, ${createdAtSql}) returning id`,
      [userId, key],
    );
    return r.rows[0].id;
  }
  async ledgerFor(subs) {
    const out = {};
    for (const s of subs) {
      const r = await this.q(
        `select l.scored_count from public.free_rating_ledger l
         where l.identity_hash = public.free_rating_identity_hash($1, $2)`,
        [s.provider, s.sub],
      );
      out[`${s.provider}:${s.sub}`] = r.rows[0]?.scored_count ?? null;
    }
    return out;
  }
  async ledgerRowCount(subs) {
    let n = 0;
    for (const s of subs) {
      const r = await this.q(
        `select count(*)::int as c from public.free_rating_ledger l
         where l.identity_hash = public.free_rating_identity_hash($1, $2)`,
        [s.provider, s.sub],
      );
      n += r.rows[0].c;
    }
    return n;
  }
  async counts(userId) {
    const r = await this.q(
      `select
         (select count(*)::int from public.shots s where s.user_id = $1 and s.result_kind = 'scored') as scored,
         (select count(*)::int from public.shots s where s.user_id = $1) as shots,
         (select count(*)::int from public.analysis_permits p where p.user_id = $1 and p.status = 'reserved') as reserved,
         (select count(*)::int from public.analysis_permits p where p.user_id = $1 and p.status = 'finalized') as finalized,
         (select count(*)::int from public.analysis_permits p where p.user_id = $1 and p.status = 'released') as released,
         (select count(*)::int from public.analysis_permits p where p.user_id = $1 and p.status = 'released' and p.outcome = 'free_limit_exceeded') as released_limit,
         (select count(*)::int from public.analysis_permits p where p.user_id = $1 and p.status = 'released' and p.outcome = 'expired') as released_expired,
         (select count(*)::int from public.analysis_permits p where p.user_id = $1) as permits`,
      [userId],
    );
    return r.rows[0];
  }
  /** access_state() exactly as the edge function sees it (authenticated + sub). */
  async accessState(userId) {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
      const r = await c.query("select * from public.access_state()");
      const l = await c.query(
        "select public.lifetime_scored_count() as n, public.identity_scored_count() as i",
      );
      await c.query("rollback");
      return { ...r.rows[0], lifetime: l.rows[0].n, identity: l.rows[0].i };
    } finally {
      c.release();
    }
  }
  async deleteUser(userId) {
    await this.q("delete from auth.users where id = $1", [userId]);
  }
}

// ---------------------------------------------------------------------------
// Lane runner: independent transactions released together at a barrier.
// ---------------------------------------------------------------------------
/**
 * lane = { name, uid: string|null (null = owner), isolation, delayMs,
 *          finish: 'commit'|'rollback', run: async (client) => result }
 * result rows: { name, uid, status, sqlstate, startAt, endAt, clientMs, extra }
 */
async function runBurst(pool, lanes) {
  // Open the gate once every lane has its transaction open and its role set.
  let ready = 0;
  let open;
  const gate = new Promise((r) => (open = r));
  const all = Promise.all(
    lanes.map(async (lane) => {
      const c = await pool.connect();
      const row = {
        name: lane.name,
        uid: lane.uid,
        isolation: lane.isolation,
        delayMs: lane.delayMs,
        finish: lane.finish,
      };
      try {
        await c.query(`begin isolation level ${lane.isolation}`);
        await c.query(`set local statement_timeout = '${LANE_STATEMENT_TIMEOUT}'`);
        if (lane.uid) {
          await c.query("set local role authenticated");
          await c.query("select set_config('request.jwt.claim.sub', $1, true)", [lane.uid]);
        }
        ready += 1;
        await gate;
        if (lane.delayMs) await sleep(lane.delayMs);
        const t0 = performance.now();
        const s = await c.query("select clock_timestamp() as t");
        row.startAt = s.rows[0].t.toISOString();
        try {
          const out = await lane.run(c);
          row.status = out.status;
          row.extra = out.extra ?? null;
          const e = await c.query("select clock_timestamp() as t");
          row.endAt = e.rows[0].t.toISOString();
          await c.query(lane.finish === "rollback" ? "rollback" : "commit");
          row.committed = lane.finish !== "rollback";
        } catch (err) {
          row.status = `error:${err.code ?? "unknown"}`;
          row.sqlstate = err.code ?? null;
          row.message = String(err.message).slice(0, 200);
          row.endAt = new Date().toISOString();
          row.committed = false;
          try {
            await c.query("rollback");
          } catch {
            /* connection already aborted */
          }
        }
        row.clientMs = Math.round((performance.now() - t0) * 100) / 100;
      } finally {
        c.release();
      }
      return row;
    }),
  );
  while (ready < lanes.length) await sleep(1);
  open();
  return all;
}

/** Max number of lanes whose [startAt, endAt] server windows overlapped. */
function maxOverlap(rows) {
  const ev = [];
  for (const r of rows) {
    if (!r.startAt || !r.endAt) continue;
    ev.push([Date.parse(r.startAt), 1], [Date.parse(r.endAt), -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let best = 0;
  for (const [, d] of ev) {
    cur += d;
    best = Math.max(best, cur);
  }
  return best;
}

// RPC lane bodies -----------------------------------------------------------
const reserveLane = (key) => async (c) => {
  const r = await c.query("select * from public.reserve_analysis_permit($1)", [key]);
  return { status: r.rows[0].result, extra: { permitId: r.rows[0].permit_id } };
};
const applyLane = (payload) => async (c) => {
  const r = await c.query("select public.apply_synced_shot($1::jsonb) as r", [
    JSON.stringify(payload),
  ]);
  return { status: r.rows[0].r };
};
const accessLane = () => async (c) => {
  const r = await c.query("select * from public.access_state()");
  return { status: "read", extra: r.rows[0] };
};
const directScoredInsertLane = (shotId) => async (c) => {
  await c.query(
    `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms,
       contact_ms, end_ms, overall_score, analysis_confidence, result_kind, app_version,
       model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version,
       phase_model_version, scoring_model_version, shot_config_version, source)
     values ($1, auth.uid(), 'dink', 'side', '2026-09-01T10:00:00Z', 0, 100, 200, 7, 0.9, 'scored',
       '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1', 'real')`,
    [shotId],
  );
  return { status: "inserted" };
};

// Outcome classification ----------------------------------------------------
const RETRYABLE_SERIALIZABLE = new Set(["40001"]);
const FORBIDDEN_SQLSTATES = { "40P01": "deadlock_detected", 57014: "statement_timeout (hang)" };

function laneErrorViolations(rows) {
  const v = [];
  for (const r of rows) {
    if (!r.sqlstate) continue;
    if (FORBIDDEN_SQLSTATES[r.sqlstate])
      v.push(`${r.name}: ${FORBIDDEN_SQLSTATES[r.sqlstate]} (${r.sqlstate})`);
    else if (RETRYABLE_SERIALIZABLE.has(r.sqlstate) && r.isolation !== "serializable")
      v.push(`${r.name}: serialization_failure under READ COMMITTED`);
    else if (r.expectError && r.expectError !== r.sqlstate)
      v.push(`${r.name}: expected SQLSTATE ${r.expectError}, got ${r.sqlstate}: ${r.message}`);
  }
  for (const r of rows) {
    if (r.status === RETRY_STATUS && r.isolation !== "serializable")
      v.push(`${r.name}: ${RETRY_STATUS} under READ COMMITTED`);
  }
  return v;
}
// Under SERIALIZABLE a lane may lose a serialization race (SQLSTATE 40001 —
// raised to the client, or swallowed by apply_synced_shot's write block as
// 'shot.write_failed:40001'); the client retries, so it is a settled-later
// outcome, never a violation. Under READ COMMITTED (PostgREST's default and
// the level the migrations are written for) it must never happen.
const RETRY_STATUS = "shot.write_failed:40001";
const isRetry = (r) =>
  r.isolation === "serializable" &&
  (RETRYABLE_SERIALIZABLE.has(r.sqlstate ?? "") || r.status === RETRY_STATUS);
const committedWith = (rows, status) =>
  rows.filter((r) => r.status === status && r.committed).length;

function expect(v, cond, msg) {
  if (!cond) v.push(msg);
}

// ---------------------------------------------------------------------------
// Scenarios. Each returns { params, lanes, verify(rows) -> violations[] }.
// Parameters derive from `rng` (the iteration seed) only.
// ---------------------------------------------------------------------------
const scenarios = {
  /** Duplicate calls: N copies of the SAME idempotency key → one permit, all accepted. */
  async reserve_same_key(fx, rng) {
    const iso = pickIsolation(rng);
    const pre = rng.int(0, 2);
    const A = await fx.user(rng, { identities: rng.int(1, 2) });
    const B = await fx.user(rng);
    await fx.preSpend(rng, A.id, pre);
    const key = `same-${rng.uuid()}`;
    const nA = rng.int(2, 10);
    const nB = rng.int(1, 3);
    const lanes = [];
    for (let i = 0; i < nA; i++)
      lanes.push({
        name: `A.reserve#${i}`,
        uid: A.id,
        isolation: iso,
        delayMs: rng.int(0, 5),
        finish: "commit",
        run: reserveLane(key),
      });
    for (let i = 0; i < nB; i++)
      lanes.push({
        name: `B.reserve#${i}`,
        uid: B.id,
        isolation: iso,
        delayMs: rng.int(0, 5),
        finish: "commit",
        run: reserveLane(`b-${i}-${key}`),
      });
    return {
      params: { pre, nA, nB, isolation: iso, identities: A.subs.length },
      lanes,
      async verify(rows) {
        const v = laneErrorViolations(rows);
        const a = rows.filter((r) => r.name.startsWith("A."));
        const settled = a.filter((r) => !isRetry(r));
        const want = pre < 2 ? "accepted" : "access.paywall_required";
        for (const r of settled)
          expect(v, r.status === want, `${r.name}: ${r.status} (expected ${want}, pre=${pre})`);
        const ids = new Set(
          settled.filter((r) => r.status === "accepted").map((r) => r.extra?.permitId),
        );
        expect(v, ids.size <= 1, `same key returned ${ids.size} distinct permit ids`);
        const k = await fx.q(
          "select count(*)::int as c from public.analysis_permits where user_id = $1 and idempotency_key = $2",
          [A.id, key],
        );
        expect(v, k.rows[0].c === (pre < 2 ? 1 : 0), `permits for key: ${k.rows[0].c}`);
        const cb = await fx.counts(B.id);
        const bSettled = rows.filter((r) => r.name.startsWith("B.") && !isRetry(r)).length;
        expect(
          v,
          cb.reserved === Math.min(bSettled, 2),
          `B reserved=${cb.reserved} (settled B lanes=${bSettled}, nB=${nB})`,
        );
        const led = await fx.ledgerFor(A.subs);
        for (const [h, n] of Object.entries(led))
          expect(v, (n ?? 0) === pre, `ledger ${h}=${n} (expected ${pre})`);
        return v;
      },
    };
  },

  /** No double spend of permits: N DIFFERENT keys → exactly (2 - pre) reservations. */
  async reserve_diff_keys(fx, rng) {
    const iso = pickIsolation(rng);
    const preA = rng.int(0, 2);
    const preB = rng.int(0, 2);
    const A = await fx.user(rng, { identities: rng.int(1, 2) });
    const B = await fx.user(rng);
    await fx.preSpend(rng, A.id, preA);
    await fx.preSpend(rng, B.id, preB);
    const nA = rng.int(3, 12);
    const nB = rng.int(2, 5);
    const lanes = [];
    for (let i = 0; i < nA; i++)
      lanes.push({
        name: `A.reserve#${i}`,
        uid: A.id,
        isolation: iso,
        delayMs: rng.int(0, 5),
        finish: "commit",
        run: reserveLane(`a-${i}-${rng.uuid()}`),
      });
    for (let i = 0; i < nB; i++)
      lanes.push({
        name: `B.reserve#${i}`,
        uid: B.id,
        isolation: iso,
        delayMs: rng.int(0, 5),
        finish: "commit",
        run: reserveLane(`b-${i}-${rng.uuid()}`),
      });
    return {
      params: { preA, preB, nA, nB, isolation: iso },
      lanes,
      async verify(rows) {
        const v = laneErrorViolations(rows);
        for (const [tag, u, pre, n] of [
          ["A", A, preA, nA],
          ["B", B, preB, nB],
        ]) {
          const mine = rows.filter((r) => r.name.startsWith(tag + "."));
          const accepted = committedWith(mine, "accepted");
          const paywall = mine.filter((r) => r.status === "access.paywall_required").length;
          const retries = mine.filter(isRetry).length;
          const wantAccepted = Math.min(n - retries, 2 - pre);
          expect(
            v,
            accepted === wantAccepted,
            `${tag}: accepted=${accepted} expected ${wantAccepted} (pre=${pre}, n=${n}, retries=${retries})`,
          );
          expect(
            v,
            accepted + paywall + retries === n,
            `${tag}: status mix ${JSON.stringify(histogram(mine.map((r) => r.status)))}`,
          );
          const c = await fx.counts(u.id);
          expect(
            v,
            c.reserved === wantAccepted,
            `${tag}: reserved rows=${c.reserved} expected ${wantAccepted}`,
          );
          expect(v, c.reserved + pre <= 2, `${tag}: reserved+scored=${c.reserved + pre} > 2`);
          const acc = await fx.accessState(u.id);
          expect(
            v,
            acc.scored_count === pre && acc.reserved_count === c.reserved,
            `${tag}: access_state ${JSON.stringify(acc)}`,
          );
        }
        return v;
      },
    };
  },

  /** Two actors on the same shot id: N copies of ONE sync → 1 row, ledger +1, all accepted. */
  async apply_same_shot(fx, rng) {
    const iso = pickIsolation(rng);
    const pre = rng.int(0, 1);
    const A = await fx.user(rng, { identities: rng.int(1, 3) });
    const B = await fx.user(rng);
    await fx.preSpend(rng, A.id, pre);
    const permitId = await fx.ownerPermit(A.id, `p-${rng.uuid()}`);
    const permitB = await fx.ownerPermit(B.id, `p-${rng.uuid()}`);
    const shotId = rng.uuid();
    const shotB = rng.uuid();
    const n = rng.int(2, 12);
    const payload = shotPayload(shotId, permitId);
    const lanes = [];
    for (let i = 0; i < n; i++)
      lanes.push({
        name: `A.apply#${i}`,
        uid: A.id,
        isolation: iso,
        delayMs: rng.int(0, 8),
        finish: "commit",
        run: applyLane(payload),
      });
    lanes.push({
      name: "B.apply",
      uid: B.id,
      isolation: iso,
      delayMs: rng.int(0, 8),
      finish: "commit",
      run: applyLane(shotPayload(shotB, permitB)),
    });
    return {
      params: { pre, n, isolation: iso, identities: A.subs.length },
      lanes,
      async verify(rows) {
        const v = laneErrorViolations(rows);
        for (const r of rows.filter((r) => !isRetry(r)))
          expect(v, r.status === "accepted", `${r.name}: ${r.status}`);
        const c = await fx.counts(A.id);
        expect(
          v,
          c.shots === pre + 1 && c.scored === pre + 1,
          `A shots=${c.shots} scored=${c.scored} expected ${pre + 1}`,
        );
        expect(
          v,
          c.finalized === 1 && c.reserved === 0,
          `A permit finalized=${c.finalized} reserved=${c.reserved}`,
        );
        const led = await fx.ledgerFor(A.subs);
        for (const [h, x] of Object.entries(led))
          expect(v, x === pre + 1, `ledger ${h}=${x} expected ${pre + 1}`);
        expect(
          v,
          (await fx.ledgerRowCount(A.subs)) === A.subs.length,
          "duplicate/missing ledger rows",
        );
        const acc = await fx.accessState(A.id);
        expect(
          v,
          acc.scored_count === pre + 1 && acc.lifetime === pre + 1 && acc.identity === pre + 1,
          `access_state ${JSON.stringify(acc)}`,
        );
        const cb = await fx.counts(B.id);
        expect(
          v,
          cb.scored === 1 && (await fx.ledgerFor(B.subs))[`google:${B.subs[0].sub}`] === 1,
          `B scored=${cb.scored}`,
        );
        return v;
      },
    };
  },

  /** Over-issued permits: P live permits, P distinct scored syncs → exactly 2 lifetime. */
  async apply_over_issued(fx, rng) {
    const iso = pickIsolation(rng);
    const pre = rng.int(0, 1);
    const A = await fx.user(rng, { identities: rng.int(1, 2) });
    await fx.preSpend(rng, A.id, pre);
    const P = rng.int(3, 8);
    const permits = [];
    for (let i = 0; i < P; i++) permits.push(await fx.ownerPermit(A.id, `over-${i}-${rng.uuid()}`));
    const lanes = permits.map((pid, i) => ({
      name: `A.apply#${i}`,
      uid: A.id,
      isolation: iso,
      delayMs: rng.int(0, 8),
      finish: "commit",
      run: applyLane(shotPayload(rng.uuid(), pid)),
    }));
    return {
      params: { pre, P, isolation: iso, identities: A.subs.length },
      lanes,
      async verify(rows) {
        const v = laneErrorViolations(rows);
        const retries = rows.filter(isRetry).length;
        const accepted = committedWith(rows, "accepted");
        const paywall = rows.filter((r) => r.status === "access.paywall_required").length;
        const wantAccepted = Math.min(P - retries, 2 - pre);
        expect(
          v,
          accepted === wantAccepted,
          `accepted=${accepted} expected ${wantAccepted} (P=${P}, pre=${pre}, retries=${retries})`,
        );
        expect(
          v,
          accepted + paywall + retries === P,
          `status mix ${JSON.stringify(histogram(rows.map((r) => r.status)))}`,
        );
        const c = await fx.counts(A.id);
        expect(v, c.scored === pre + accepted && c.scored <= 2, `scored=${c.scored}`);
        expect(v, c.finalized === accepted, `finalized=${c.finalized}`);
        expect(
          v,
          c.released_limit === paywall,
          `released(free_limit_exceeded)=${c.released_limit} vs paywall verdicts ${paywall}`,
        );
        expect(v, c.reserved === retries, `reserved left=${c.reserved} (retries=${retries})`);
        const led = await fx.ledgerFor(A.subs);
        for (const [h, x] of Object.entries(led))
          expect(v, x === c.scored, `ledger ${h}=${x} expected ${c.scored}`);
        const acc = await fx.accessState(A.id);
        expect(v, acc.scored_count === c.scored, `access_state.scored_count=${acc.scored_count}`);
        return v;
      },
    };
  },

  /** Call-during-call: apply of permit #k racing fresh reserves → scored + reserved never > 2. */
  async reserve_vs_apply(fx, rng) {
    const iso = pickIsolation(rng);
    const pre = rng.int(0, 1);
    const A = await fx.user(rng, { identities: rng.int(1, 2) });
    await fx.preSpend(rng, A.id, pre);
    const permitId = await fx.ownerPermit(A.id, `p-${rng.uuid()}`);
    const shotId = rng.uuid();
    const nApply = rng.int(1, 3);
    const nReserve = rng.int(1, 5);
    const lanes = [];
    for (let i = 0; i < nApply; i++)
      lanes.push({
        name: `A.apply#${i}`,
        uid: A.id,
        isolation: iso,
        delayMs: rng.int(0, 8),
        finish: "commit",
        run: applyLane(shotPayload(shotId, permitId)),
      });
    for (let i = 0; i < nReserve; i++)
      lanes.push({
        name: `A.reserve#${i}`,
        uid: A.id,
        isolation: iso,
        delayMs: rng.int(0, 8),
        finish: "commit",
        run: reserveLane(`r-${i}-${rng.uuid()}`),
      });
    return {
      params: { pre, nApply, nReserve, isolation: iso },
      lanes,
      async verify(rows) {
        const v = laneErrorViolations(rows);
        const applies = rows.filter((r) => r.name.startsWith("A.apply"));
        const reserves = rows.filter((r) => r.name.startsWith("A.reserve"));
        for (const r of applies.filter((r) => !isRetry(r)))
          expect(v, r.status === "accepted", `${r.name}: ${r.status}`);
        const applied = applies.some((r) => r.status === "accepted") ? 1 : 0;
        const resAccepted = committedWith(reserves, "accepted");
        const resRetries = reserves.filter(isRetry).length;
        // Whether the reserve ran before or after the apply, the arithmetic
        // leaves exactly 1 - pre extra reservation (bounded by lanes that settled).
        const wantRes = Math.min(1 - pre, nReserve - resRetries);
        expect(
          v,
          resAccepted === wantRes,
          `reserve accepted=${resAccepted} expected ${wantRes} (pre=${pre}, retries=${resRetries})`,
        );
        const c = await fx.counts(A.id);
        expect(v, c.scored === pre + applied, `scored=${c.scored}`);
        expect(
          v,
          c.scored + c.reserved <= 2,
          `scored+reserved=${c.scored + c.reserved} > 2 (double spend)`,
        );
        const led = await fx.ledgerFor(A.subs);
        for (const [h, x] of Object.entries(led))
          expect(v, (x ?? 0) === c.scored, `ledger ${h}=${x} expected ${c.scored}`);
        return v;
      },
    };
  },

  /** Late link during scoring: identity linked WHILE scored syncs commit → all identities agree. */
  async link_during_apply(fx, rng) {
    const iso = pickIsolation(rng);
    const pre = rng.int(0, 1);
    const A = await fx.user(rng, { identities: 1 });
    await fx.preSpend(rng, A.id, pre);
    const P = rng.int(1, 3);
    const permits = [];
    for (let i = 0; i < P; i++) permits.push(await fx.ownerPermit(A.id, `link-${i}-${rng.uuid()}`));
    const linked = { provider: "apple", sub: `${RUN_TAG}-${A.id.slice(0, 8)}-late` };
    const lanes = permits.map((pid, i) => ({
      name: `A.apply#${i}`,
      uid: A.id,
      isolation: iso,
      delayMs: rng.int(0, 12),
      finish: "commit",
      run: applyLane(shotPayload(rng.uuid(), pid)),
    }));
    lanes.push({
      name: "owner.link",
      uid: null,
      isolation: "read committed",
      delayMs: rng.int(0, 12),
      finish: "commit",
      run: async (c) => {
        await c.query(
          `insert into auth.identities (provider, provider_id, user_id, identity_data)
           values ($1, $2, $3, jsonb_build_object('sub', $2::text))`,
          [linked.provider, linked.sub, A.id],
        );
        return { status: "linked" };
      },
    });
    return {
      params: { pre, P, isolation: iso, linkDelayMs: lanes[lanes.length - 1].delayMs },
      lanes,
      async verify(rows) {
        const v = laneErrorViolations(rows);
        const c = await fx.counts(A.id);
        expect(v, c.scored <= 2, `scored=${c.scored} > 2`);
        const subs = [...A.subs, linked];
        const led = await fx.ledgerFor(subs);
        const vals = Object.values(led).map((x) => x ?? 0);
        expect(
          v,
          vals.every((x) => x === c.scored),
          `identities disagree with scored=${c.scored}: ${JSON.stringify(led)}`,
        );
        expect(
          v,
          (await fx.ledgerRowCount(subs)) ===
            (c.scored > 0 ? subs.length : await fx.ledgerRowCount(A.subs)),
          "duplicate/missing ledger rows",
        );
        const acc = await fx.accessState(A.id);
        expect(
          v,
          acc.scored_count === c.scored,
          `access_state.scored_count=${acc.scored_count} vs scored=${c.scored}`,
        );
        return v;
      },
    };
  },

  /** Account deleted WHILE a sync is in flight; recreate with the same subject → history kept. */
  async delete_during_apply(fx, rng) {
    const iso = pickIsolation(rng);
    const pre = rng.int(0, 1);
    const A = await fx.user(rng, { identities: rng.int(1, 2) });
    await fx.preSpend(rng, A.id, pre);
    const P = rng.int(1, 3);
    const permits = [];
    for (let i = 0; i < P; i++) permits.push(await fx.ownerPermit(A.id, `del-${i}-${rng.uuid()}`));
    const lanes = permits.map((pid, i) => ({
      name: `A.apply#${i}`,
      uid: A.id,
      isolation: iso,
      delayMs: rng.int(0, 12),
      finish: "commit",
      run: applyLane(shotPayload(rng.uuid(), pid)),
    }));
    lanes.push({
      name: "owner.delete",
      uid: null,
      isolation: "read committed",
      delayMs: rng.int(0, 12),
      finish: "commit",
      run: async (c) => {
        await c.query("delete from auth.users where id = $1", [A.id]);
        return { status: "deleted" };
      },
    });
    return {
      params: { pre, P, isolation: iso, identities: A.subs.length },
      lanes,
      async verify(rows) {
        const v = laneErrorViolations(rows);
        const applies = rows.filter((r) => r.name.startsWith("A.apply"));
        const accepted = committedWith(applies, "accepted");
        const okStatuses = new Set([
          "accepted",
          "access.paywall_required",
          "access.permit_not_found",
          "auth.required",
        ]);
        for (const r of applies) {
          if (isRetry(r)) continue;
          expect(
            v,
            okStatuses.has(r.status) || /^shot\.write_failed:(23503|42501)$/.test(r.status),
            `${r.name}: unexpected ${r.status} ${r.message ?? ""}`,
          );
        }
        const del = rows.find((r) => r.name === "owner.delete");
        expect(v, del.status === "deleted", `delete lane: ${del.status} ${del.message ?? ""}`);
        const gone = await fx.q(
          "select (select count(*)::int from public.shots where user_id = $1) as shots, (select count(*)::int from auth.users where id = $1) as users",
          [A.id],
        );
        if (gone.rows[0].users !== 0) {
          v.push(`auth.users row survived the delete lane (status=${del.status})`);
          return v;
        }
        expect(v, gone.rows[0].shots === 0, `shots survived deletion: ${gone.rows[0].shots}`);
        const led = await fx.ledgerFor(A.subs);
        const want = pre + accepted;
        expect(v, want <= 2, `accepted=${accepted} pre=${pre} → ${want} > 2`);
        for (const [h, x] of Object.entries(led))
          expect(v, (x ?? 0) === want, `ledger ${h}=${x} expected ${want} (survives deletion)`);
        // Sign in again with the same subject: the ledger must be the floor.
        const A2 = await fx.user(rng, { subjects: A.subs });
        const acc = await fx.accessState(A2.id);
        expect(
          v,
          acc.scored_count === want && acc.identity === want,
          `recreated access_state ${JSON.stringify(acc)} expected ${want}`,
        );
        const again = await runBurst(
          fx.pool,
          [0, 1].map((i) => ({
            name: `A2.reserve#${i}`,
            uid: A2.id,
            isolation: "read committed",
            delayMs: 0,
            finish: "commit",
            run: reserveLane(`again-${i}-${rng.uuid()}`),
          })),
        );
        const got = committedWith(again, "accepted");
        expect(
          v,
          got === 2 - want,
          `recreated account reserved ${got} permits, expected ${2 - want}`,
        );
        return v;
      },
    };
  },

  /** Cancel-during-call: some syncs roll back after the RPC returned → ledger tracks committed rows only. */
  async cancel_during_apply(fx, rng) {
    const iso = pickIsolation(rng);
    const pre = rng.int(0, 1);
    const A = await fx.user(rng, { identities: rng.int(1, 2) });
    await fx.preSpend(rng, A.id, pre);
    const P = rng.int(2, 6);
    const permits = [];
    for (let i = 0; i < P; i++)
      permits.push(await fx.ownerPermit(A.id, `cancel-${i}-${rng.uuid()}`));
    const cancel = permits.map(() => rng.chance(0.5));
    if (!cancel.includes(true)) cancel[rng.int(0, P - 1)] = true;
    const lanes = permits.map((pid, i) => ({
      name: `A.apply#${i}`,
      uid: A.id,
      isolation: iso,
      delayMs: rng.int(0, 8),
      finish: cancel[i] ? "rollback" : "commit",
      run: applyLane(shotPayload(rng.uuid(), pid)),
    }));
    return {
      params: { pre, P, cancelled: cancel.filter(Boolean).length, isolation: iso },
      lanes,
      async verify(rows) {
        const v = laneErrorViolations(rows);
        const committedAccepted = committedWith(rows, "accepted");
        const c = await fx.counts(A.id);
        expect(
          v,
          c.scored === pre + committedAccepted && c.scored <= 2,
          `scored=${c.scored} expected ${pre + committedAccepted}`,
        );
        expect(
          v,
          c.finalized === committedAccepted,
          `finalized=${c.finalized} vs committed accepted ${committedAccepted}`,
        );
        const orphans = await fx.q(
          `select count(*)::int as c from public.analysis_permits p where p.user_id = $1 and p.status = 'finalized'
             and not exists (select 1 from public.shots s where s.user_id = $1 and s.result_kind = 'scored')`,
          [A.id],
        );
        expect(v, orphans.rows[0].c === 0, "finalized permit without a scored shot");
        for (let i = 0; i < P; i++) {
          if (!cancel[i]) continue;
          const st = await fx.q("select status from public.analysis_permits where id = $1", [
            permits[i],
          ]);
          expect(
            v,
            st.rows[0].status === "reserved",
            `cancelled lane's permit ${i} is ${st.rows[0].status}, expected reserved`,
          );
        }
        const led = await fx.ledgerFor(A.subs);
        for (const [h, x] of Object.entries(led))
          expect(v, (x ?? 0) === c.scored, `ledger ${h}=${x} expected ${c.scored}`);
        return v;
      },
    };
  },

  /** Two users interleaved on the same lock-free tables: isolation + no deadlock. */
  async two_users_interleaved(fx, rng) {
    const iso = pickIsolation(rng);
    const users = [];
    for (const tag of ["A", "B", ...(rng.chance(0.4) ? ["C"] : [])]) {
      const pre = rng.int(0, 1);
      const u = await fx.user(rng, { identities: rng.int(1, 2) });
      await fx.preSpend(rng, u.id, pre);
      const P = rng.int(2, 5);
      const permits = [];
      for (let i = 0; i < P; i++)
        permits.push(await fx.ownerPermit(u.id, `${tag}-${i}-${rng.uuid()}`));
      users.push({ tag, u, pre, P, permits });
    }
    const lanes = [];
    for (const x of users) {
      x.permits.forEach((pid, i) =>
        lanes.push({
          name: `${x.tag}.apply#${i}`,
          uid: x.u.id,
          isolation: iso,
          delayMs: rng.int(0, 8),
          finish: "commit",
          run: applyLane(shotPayload(rng.uuid(), pid)),
        }),
      );
      lanes.push({
        name: `${x.tag}.reserve`,
        uid: x.u.id,
        isolation: iso,
        delayMs: rng.int(0, 8),
        finish: "commit",
        run: reserveLane(`${x.tag}-r-${rng.uuid()}`),
      });
      lanes.push({
        name: `${x.tag}.access`,
        uid: x.u.id,
        isolation: iso,
        delayMs: rng.int(0, 8),
        finish: "commit",
        run: accessLane(),
      });
    }
    // seeded shuffle so lane order (connection acquisition) varies too
    for (let i = lanes.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
    }
    return {
      params: { users: users.map((x) => ({ tag: x.tag, pre: x.pre, P: x.P })), isolation: iso },
      lanes,
      async verify(rows) {
        const v = laneErrorViolations(rows);
        for (const x of users) {
          const mine = rows.filter((r) => r.name.startsWith(x.tag + ".apply"));
          const accepted = committedWith(mine, "accepted");
          const retried = mine.filter(isRetry).length;
          const res = rows.find((r) => r.name === `${x.tag}.reserve`);
          const resAccepted = res.status === "accepted" ? 1 : 0;
          const c = await fx.counts(x.u.id);
          expect(
            v,
            c.scored === x.pre + accepted && c.scored <= 2,
            `${x.tag}: scored=${c.scored} accepted=${accepted} pre=${x.pre}`,
          );
          // over-issued permits whose lane must retry stay reserved; everything
          // else is finalized (accepted) or released (paywall)
          expect(
            v,
            c.reserved === retried + resAccepted,
            `${x.tag}: reserved=${c.reserved} expected retried ${retried} + reserve-accepted ${resAccepted}`,
          );
          expect(
            v,
            c.scored + resAccepted <= 2,
            `${x.tag}: scored+fresh reservation=${c.scored + resAccepted} > 2 (double spend)`,
          );
          const led = await fx.ledgerFor(x.u.subs);
          for (const [h, n] of Object.entries(led))
            expect(v, (n ?? 0) === c.scored, `${x.tag}: ledger ${h}=${n} expected ${c.scored}`);
          const acc = rows.find((r) => r.name === `${x.tag}.access`);
          if (acc?.extra)
            expect(
              v,
              acc.extra.scored_count >= x.pre && acc.extra.scored_count <= c.scored,
              `${x.tag}: access read ${acc.extra.scored_count} outside [${x.pre}, ${c.scored}]`,
            );
        }
        return v;
      },
    };
  },

  /** Clock skew at the 24h permit boundary: apply vs the pg_cron expiry sweep. */
  async permit_expiry_skew(fx, rng) {
    const iso = pickIsolation(rng);
    const pre = rng.int(0, 1);
    const A = await fx.user(rng, { identities: rng.int(1, 2) });
    await fx.preSpend(rng, A.id, pre);
    const P = rng.int(2, 5);
    const permits = [];
    const offsets = [];
    for (let i = 0; i < P; i++) {
      const skewMs = rng.int(-1500, 1500); // created_at = now() - 24h + skew
      offsets.push(skewMs);
      permits.push(
        await fx.ownerPermit(
          A.id,
          `skew-${i}-${rng.uuid()}`,
          `now() - interval '24 hours' + (${skewMs} * interval '1 millisecond')`,
        ),
      );
    }
    const lanes = permits.map((pid, i) => ({
      name: `A.apply#${i}`,
      uid: A.id,
      isolation: iso,
      delayMs: rng.int(0, 30),
      finish: "commit",
      run: applyLane(shotPayload(rng.uuid(), pid)),
    }));
    const sweeps = rng.int(1, 2);
    for (let i = 0; i < sweeps; i++) {
      lanes.push({
        name: `owner.sweep#${i}`,
        uid: null,
        isolation: "read committed",
        delayMs: rng.int(0, 30),
        finish: "commit",
        run: async (c) => {
          const r = await c.query(
            `update public.analysis_permits set status = 'released', outcome = 'expired'
             where status = 'reserved' and created_at < now() - interval '24 hours'`,
          );
          return { status: "swept", extra: { rows: r.rowCount } };
        },
      });
    }
    return {
      params: { pre, P, offsetsMs: offsets, sweeps, isolation: iso },
      lanes,
      async verify(rows) {
        const v = laneErrorViolations(rows);
        const applies = rows.filter((r) => r.name.startsWith("A.apply"));
        const accepted = committedWith(applies, "accepted");
        const ok = new Set([
          "accepted",
          "access.paywall_required",
          "access.permit_expired",
          "access.permit_not_reserved",
        ]);
        for (const r of applies.filter((r) => !isRetry(r)))
          expect(v, ok.has(r.status), `${r.name}: ${r.status}`);
        const c = await fx.counts(A.id);
        expect(
          v,
          c.scored === pre + accepted && c.scored <= 2,
          `scored=${c.scored} accepted=${accepted}`,
        );
        expect(v, c.finalized === accepted, `finalized=${c.finalized} vs accepted ${accepted}`);
        const bad = await fx.q(
          `select count(*)::int as c from public.analysis_permits p
           where p.user_id = $1 and p.status = 'finalized' and p.created_at <= now() - interval '24 hours' - interval '5 seconds'`,
          [A.id],
        );
        expect(v, bad.rows[0].c === 0, "a permit clearly past expiry was finalized");
        const led = await fx.ledgerFor(A.subs);
        for (const [h, n] of Object.entries(led))
          expect(v, (n ?? 0) === c.scored, `ledger ${h}=${n} expected ${c.scored}`);
        return v;
      },
    };
  },

  /** Direct INSERT gate: authenticated writers bypassing the RPC, with/without a live permit. */
  async direct_insert_gate(fx, rng) {
    const iso = pickIsolation(rng);
    const pre = rng.int(0, 1);
    const A = await fx.user(rng, { identities: rng.int(1, 2) });
    const B = await fx.user(rng); // never holds a permit
    await fx.preSpend(rng, A.id, pre);
    const P = rng.int(0, 3);
    for (let i = 0; i < P; i++) await fx.ownerPermit(A.id, `direct-${i}-${rng.uuid()}`);
    const nA = rng.int(2, 8);
    const nB = rng.int(1, 3);
    const lanes = [];
    for (let i = 0; i < nA; i++)
      lanes.push({
        name: `A.insert#${i}`,
        uid: A.id,
        isolation: iso,
        delayMs: rng.int(0, 8),
        finish: "commit",
        run: directScoredInsertLane(rng.uuid()),
      });
    for (let i = 0; i < nB; i++)
      lanes.push({
        name: `B.insert#${i}`,
        uid: B.id,
        isolation: iso,
        delayMs: rng.int(0, 8),
        finish: "commit",
        run: directScoredInsertLane(rng.uuid()),
      });
    return {
      params: { pre, P, nA, nB, isolation: iso },
      lanes,
      async verify(rows) {
        const v = laneErrorViolations(rows);
        const a = rows.filter((r) => r.name.startsWith("A."));
        const b = rows.filter((r) => r.name.startsWith("B."));
        for (const r of b)
          expect(v, r.sqlstate === "42501", `${r.name}: no permit yet ${r.status}`);
        const aOk = a.filter((r) => r.status === "inserted").length;
        for (const r of a)
          expect(
            v,
            r.status === "inserted" || r.sqlstate === "42501" || isRetry(r),
            `${r.name}: ${r.status} ${r.message ?? ""}`,
          );
        if (P === 0) expect(v, aOk === 0, `no live permit but ${aOk} scored rows inserted`);
        const c = await fx.counts(A.id);
        expect(
          v,
          c.scored === pre + aOk && c.scored <= 2,
          `A scored=${c.scored} (pre=${pre}, inserted=${aOk})`,
        );
        if (P > 0) {
          const retries = a.filter(isRetry).length;
          expect(
            v,
            aOk === Math.min(nA - retries, 2 - pre),
            `A inserted=${aOk} expected ${Math.min(nA - retries, 2 - pre)}`,
          );
        }
        const cb = await fx.counts(B.id);
        expect(v, cb.scored === 0, `B scored=${cb.scored}`);
        const led = await fx.ledgerFor(A.subs);
        for (const [h, n] of Object.entries(led))
          expect(v, (n ?? 0) === c.scored, `ledger ${h}=${n} expected ${c.scored}`);
        expect(
          v,
          (await fx.ledgerRowCount(B.subs)) === 0,
          "B has a ledger row without a scored shot",
        );
        return v;
      },
    };
  },

  /** RLS + append-only under concurrency: client mutations denied while cascades run. */
  async ledger_rls_probe(fx, rng) {
    const iso = pickIsolation(rng);
    const preA = rng.int(1, 2);
    const preB = rng.int(0, 2);
    const A = await fx.user(rng, { identities: rng.int(1, 2) });
    const B = await fx.user(rng);
    const D = await fx.user(rng); // deleted mid-burst: cascade must pass reject_ledger_mutation
    await fx.preSpend(rng, A.id, preA);
    await fx.preSpend(rng, B.id, preB);
    for (const u of [A, B, D]) {
      await fx.q(
        `insert into public.consent_records (user_id, scope, action, source) values ($1, 'video_analysis', 'grant', 'stress')`,
        [u.id],
      );
      await fx.q(
        `insert into public.analysis_feedback (user_id, analysis_id, rating) values ($1, $2, 'accurate')`,
        [u.id, rng.uuid()],
      );
      await fx.q(
        `insert into public.evaluation_trials (id, user_id, payload) values ($1, $2, '{}'::jsonb)`,
        [rng.uuid(), u.id],
      );
    }
    const hashA = (
      await fx.q("select public.free_rating_identity_hash($1, $2) as h", [
        A.subs[0].provider,
        A.subs[0].sub,
      ])
    ).rows[0].h;
    const probes = [
      ["ledger.select", "select * from public.free_rating_ledger", "42501"],
      [
        "ledger.insert",
        `insert into public.free_rating_ledger (identity_hash, scored_count) values ('${hashA}', 0)`,
        "42501",
      ],
      [
        "ledger.update",
        `update public.free_rating_ledger set scored_count = 0 where identity_hash = '${hashA}'`,
        "42501",
      ],
      [
        "ledger.delete",
        `delete from public.free_rating_ledger where identity_hash = '${hashA}'`,
        "42501",
      ],
      ["ledger.hash_fn", `select public.free_rating_identity_hash('google', 'x')`, "42501"],
      [
        "consent.update",
        `update public.consent_records set action = 'withdraw' where user_id = auth.uid()`,
        "42501",
      ],
      ["consent.delete", `delete from public.consent_records where user_id = auth.uid()`, "42501"],
      [
        "feedback.update",
        `update public.analysis_feedback set rating = 'not_quite' where user_id = auth.uid()`,
        "42501",
      ],
      [
        "feedback.delete",
        `delete from public.analysis_feedback where user_id = auth.uid()`,
        "42501",
      ],
      ["trials.delete", `delete from public.evaluation_trials where user_id = auth.uid()`, "42501"],
      [
        "trials.update",
        `update public.evaluation_trials set payload = '{"x":1}'::jsonb where user_id = auth.uid()`,
        "42501",
      ],
    ];
    const lanes = [];
    const n = rng.int(4, probes.length);
    for (let i = 0; i < n; i++) {
      const [name, sql, code] = rng.pick(probes);
      const who = rng.chance(0.5) ? A : B;
      lanes.push({
        name: `${who === A ? "A" : "B"}.${name}#${i}`,
        uid: who.id,
        isolation: iso,
        delayMs: rng.int(0, 5),
        finish: "commit",
        expectError: code,
        run: async (c) => {
          await c.query(sql);
          return { status: "ALLOWED" };
        },
      });
    }
    lanes.push({
      name: "A.identity_count",
      uid: A.id,
      isolation: iso,
      delayMs: rng.int(0, 5),
      finish: "commit",
      run: async (c) => ({
        status: "read",
        extra: (await c.query("select public.identity_scored_count() as n")).rows[0],
      }),
    });
    lanes.push({
      name: "B.identity_count",
      uid: B.id,
      isolation: iso,
      delayMs: rng.int(0, 5),
      finish: "commit",
      run: async (c) => ({
        status: "read",
        extra: (await c.query("select public.identity_scored_count() as n")).rows[0],
      }),
    });
    lanes.push({
      name: "owner.cascade_delete",
      uid: null,
      isolation: "read committed",
      delayMs: rng.int(0, 5),
      finish: "commit",
      run: async (c) => {
        await c.query("delete from auth.users where id = $1", [D.id]);
        return { status: "deleted" };
      },
    });
    lanes.push({
      name: "owner.direct_consent_delete",
      uid: null,
      isolation: "read committed",
      delayMs: rng.int(0, 5),
      finish: "commit",
      expectError: "42501",
      run: async (c) => {
        await c.query("delete from public.consent_records where user_id = $1", [A.id]);
        return { status: "ALLOWED" };
      },
    });
    for (const l of lanes) l.expectError ??= null;
    return {
      params: { preA, preB, probes: n, isolation: iso },
      lanes,
      async verify(rows) {
        const v = [];
        for (const r of rows) {
          if (r.expectError === undefined || r.expectError === null) continue;
          expect(
            v,
            r.sqlstate === r.expectError,
            `${r.name}: expected ${r.expectError}, got ${r.status} ${r.message ?? ""}`,
          );
        }
        for (const r of rows)
          if (r.sqlstate && FORBIDDEN_SQLSTATES[r.sqlstate])
            v.push(`${r.name}: ${FORBIDDEN_SQLSTATES[r.sqlstate]}`);
        const a = rows.find((r) => r.name === "A.identity_count");
        const b = rows.find((r) => r.name === "B.identity_count");
        expect(v, a.extra?.n === preA, `A.identity_scored_count=${a.extra?.n} expected ${preA}`);
        expect(v, b.extra?.n === preB, `B.identity_scored_count=${b.extra?.n} expected ${preB}`);
        const ledA = await fx.ledgerFor(A.subs);
        for (const [h, x] of Object.entries(ledA))
          expect(v, x === preA, `ledger ${h}=${x} changed (expected ${preA})`);
        const d = await fx.q(
          "select (select count(*)::int from public.consent_records where user_id = $1) as c, (select count(*)::int from auth.users where id = $1) as u",
          [D.id],
        );
        expect(
          v,
          d.rows[0].c === 0 && d.rows[0].u === 0,
          `cascade delete left rows: ${JSON.stringify(d.rows[0])}`,
        );
        const cons = await fx.q(
          "select count(*)::int as c from public.consent_records where user_id = $1 and action = 'grant'",
          [A.id],
        );
        expect(v, cons.rows[0].c === 1, `A consent rows mutated: ${cons.rows[0].c}`);
        return v;
      },
    };
  },
};

// The lane errors in ledger_rls_probe carry expectError; make it visible to
// laneErrorViolations for the other scenarios too.
function attachExpect(rows, lanes) {
  rows.forEach((r, i) => (r.expectError = lanes[i].expectError ?? null));
  return rows;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
async function runIteration(fx, name, seed, index) {
  const rng = makeRng(seed, `${RUN_TAG}:${index}`);
  const t0 = performance.now();
  const sc = await scenarios[name](fx, rng);
  const setupMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const rows = attachExpect(await runBurst(fx.pool, sc.lanes), sc.lanes);
  const burstMs = Math.round(performance.now() - t1);
  const violations = await sc.verify(rows);
  const wallMs = Math.round(performance.now() - t0);
  if (wallMs > ITER_WALL_BOUND_MS)
    violations.push(`wall time ${wallMs}ms exceeded bound ${ITER_WALL_BOUND_MS}ms`);
  return {
    scenario: name,
    seed,
    outcome: violations.length ? "BROKEN" : "HELD",
    violations,
    params: sc.params,
    lanes: sc.lanes.length,
    isolationLanes: histogram(sc.lanes.map((l) => l.isolation)),
    statuses: histogram(rows.map((r) => r.status)),
    sqlstates: histogram(rows.filter((r) => r.sqlstate).map((r) => r.sqlstate)),
    maxServerOverlap: maxOverlap(rows),
    setupMs,
    burstMs,
    wallMs,
    replay: `STRESS_REPLAY=${name}:${seed} node supabase/tests/stress/ledger_concurrency.mjs`,
    laneRows: violations.length ? rows : undefined,
  };
}

async function main() {
  const pool = new Pool({ connectionString: PG_URL, max: 40, idleTimeoutMillis: 5_000 });
  const fx = new Fixtures(pool);
  await pool.query("select 1");
  const names = Object.keys(scenarios).filter((n) => !ONLY.length || ONLY.includes(n));
  if (!names.length)
    throw new Error(`STRESS_SCENARIO matched nothing; known: ${Object.keys(scenarios).join(", ")}`);

  const plan = [];
  if (REPLAY) {
    const [n, s] = REPLAY.split(":");
    if (!scenarios[n]) throw new Error(`unknown scenario ${n}`);
    for (let i = 0; i < Number(process.env.STRESS_REPEAT ?? 1); i++) plan.push([n, Number(s)]);
  } else {
    for (let i = 0; i < TOTAL_ITER; i++) {
      const n = names[i % names.length];
      plan.push([n, fnv1a(`${MASTER_SEED}:${n}:${Math.floor(i / names.length)}`)]);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const results = [];
  const started = Date.now();
  let broken = 0;
  for (const [i, [n, seed]] of plan.entries()) {
    const r = await runIteration(fx, n, seed, i);
    results.push(r);
    if (r.outcome === "BROKEN") {
      broken += 1;
      console.log(`BROKEN ${n} seed=${seed} :: ${r.violations.join(" | ")}`);
    } else if (process.env.STRESS_VERBOSE) {
      console.log(
        `HELD   ${n} seed=${seed} lanes=${r.lanes} overlap=${r.maxServerOverlap} ${JSON.stringify(r.statuses)}`,
      );
    }
  }
  const byScenario = {};
  for (const r of results) {
    const b = (byScenario[r.scenario] ??= {
      executed: 0,
      held: 0,
      broken: 0,
      maxOverlap: 0,
      maxWallMs: 0,
      serializableLanes: 0,
      sqlstates: {},
    });
    b.executed += 1;
    b[r.outcome === "HELD" ? "held" : "broken"] += 1;
    b.maxOverlap = Math.max(b.maxOverlap, r.maxServerOverlap);
    b.maxWallMs = Math.max(b.maxWallMs, r.wallMs);
    b.serializableLanes += r.isolationLanes.serializable ?? 0;
    for (const [k, c] of Object.entries(r.sqlstates)) b.sqlstates[k] = (b.sqlstates[k] ?? 0) + c;
  }
  const summary = {
    pgUrl: PG_URL.replace(/\/\/.*@/, "//***@"),
    masterSeed: MASTER_SEED,
    isolationMode: ISOLATION_MODE,
    executed: results.length,
    held: results.length - broken,
    broken,
    totalLanes: results.reduce((a, r) => a + r.lanes, 0),
    durationMs: Date.now() - started,
    byScenario,
    brokenSeeds: results
      .filter((r) => r.outcome === "BROKEN")
      .map((r) => ({
        scenario: r.scenario,
        seed: r.seed,
        replay: r.replay,
        violations: r.violations,
      })),
    heap: process.memoryUsage(),
  };
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify({
      executed: summary.executed,
      held: summary.held,
      broken,
      durationMs: summary.durationMs,
      out: OUT_DIR,
    }),
  );
  await pool.end();
  process.exit(broken ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
