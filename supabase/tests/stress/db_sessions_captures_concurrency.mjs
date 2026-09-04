#!/usr/bin/env node
// Concurrency stress harness for the `db-sessions-captures` unit:
// public.sessions + public.captures + public.evaluation_trials +
// public.analysis_feedback (plus the apply_synced_shot / permit path where a
// session row is the contended resource).
//
// Drives a REAL Postgres (postgres:16 + supabase/tests/shim_auth.sql + every
// supabase/migrations/*.sql — see ./stress_pg_up.sh) with Promise.all bursts of
// independent connections. Every PostgREST request the edge function makes is
// modelled as ONE transaction with `set local role authenticated` +
// `request.jwt.claim.sub` / `request.jwt.claims` (exactly how PostgREST runs
// a request), so RLS, column grants and triggers are the production ones.
//
// Every iteration is driven by a seeded PRNG (mulberry32): lane→user
// assignment, per-lane delays (call-during-call windows), clock-skew offsets,
// ids and payloads are all derived from the iteration seed, which is printed
// with a replay command. Postgres' own scheduling is not seedable, so a replay
// reproduces the INPUTS and the delay schedule, not the exact commit order.
//
// Env:
//   STRESS_PG_URL     required, e.g. postgres://postgres:pg@127.0.0.1:5499/postgres
//   STRESS_SEED       campaign seed (default 1)
//   STRESS_ITER       iterations per scenario (default 3 — ~1s, fast enough for the suite;
//                     the recorded campaign was STRESS_ITER=40 STRESS_ISOLATION=both
//                     → 14 scenarios × 40 × 2 = 1120 interleavings in ~25s)
//   STRESS_LANES      concurrent lanes per burst (default 8)
//   STRESS_FILTER     regex on scenario name (default: all)
//   STRESS_ISOLATION  read_committed | serializable | both (default read_committed —
//                     PostgREST runs READ COMMITTED; nothing in supabase/ claims
//                     SERIALIZABLE, so 40001 is recorded, never asserted)
//   STRESS_OUT        artifact dir (default artifacts/stress/db-sessions-captures/latest)
//   STRESS_WALL_MS    per-iteration wall-time bound (default 15000) — exceeding it is BROKEN
//
// Exit code: 0 when every iteration HELD, 1 when any iteration is BROKEN, 2 on
// harness/setup error. Artifacts: report.json (everything), seeds.json
// (seed → outcome table), findings.json (BROKEN iterations, minimized).
// Standalone SQL repros for the anomalies this harness found live beside it:
// ./repro_finalize_lost_update.sh and ./repro_session_timestamp_bounds.sql.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
// `pg` is a dependency of @pickle/database; resolve it from there so this
// harness needs no package.json of its own.
const require = createRequire(path.join(ROOT, "packages/database/package.json"));
const pg = require("pg");

const PG_URL = process.env.STRESS_PG_URL ?? "";
const SEED = Number(process.env.STRESS_SEED ?? "1") >>> 0;
const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? "3") | 0);
const LANES = Math.max(2, Number(process.env.STRESS_LANES ?? "8") | 0);
const FILTER = new RegExp(process.env.STRESS_FILTER ?? ".");
const ISOLATION = process.env.STRESS_ISOLATION ?? "read_committed";
const OUT = path.resolve(
  process.env.STRESS_OUT ?? path.join(ROOT, "artifacts/stress/db-sessions-captures/latest"),
);
const WALL_MS = Math.max(1000, Number(process.env.STRESS_WALL_MS ?? "15000") | 0);

if (!PG_URL) {
  console.error("STRESS_PG_URL is required (run ./stress_pg_up.sh and export its output).");
  process.exit(2);
}
if (/supabase\.co|ucqnaiwqwjtgvlduiuib/.test(PG_URL)) {
  console.error("refusing to run against a hosted Supabase project");
  process.exit(2);
}
const ISOLATIONS =
  ISOLATION === "both"
    ? ["read_committed", "serializable"]
    : ISOLATION === "serializable"
      ? ["serializable"]
      : ["read_committed"];

// ── seeded PRNG ────────────────────────────────────────────────────────────
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
  pick(items) {
    return items[this.int(0, items.length - 1)];
  }
  shuffle(items) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  uuid() {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
}
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
/** Iteration 0 uses the campaign seed itself so that
 *  `STRESS_SEED=<iterSeed> STRESS_ITER=1 STRESS_FILTER=^name$` replays iteration i. */
function iterSeed(name, isolation, i) {
  if (i === 0) return SEED;
  return fnv1a(`${SEED}:${name}:${isolation}:${i}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── PostgREST-shaped transactions ──────────────────────────────────────────
const ISO_SQL = { read_committed: "read committed", serializable: "serializable" };

/** One PostgREST request = one transaction under the caller's JWT. `uid === null`
 *  runs as the connection owner (superuser here: the "service/owner" plane —
 *  Auth admin deleteUser / service-role writes), which is always plain READ
 *  COMMITTED in production, so `isolation` only applies to client lanes. */
async function tx(client, uid, isolation, fn) {
  const t0 = performance.now();
  const iso = uid ? isolation : "read_committed";
  try {
    await client.query(`begin isolation level ${ISO_SQL[iso]}`);
    await client.query(`set local statement_timeout = '10s'`);
    if (uid) {
      await client.query(`set local role authenticated`);
      await client.query(
        `select set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true)`,
        [uid, JSON.stringify({ sub: uid, role: "authenticated" })],
      );
    }
    const out = await fn(client);
    await client.query("commit");
    return { ok: true, ms: round(performance.now() - t0), ...(out ?? {}) };
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      /* connection may be gone; surfaced by the outer error */
    }
    return {
      ok: false,
      code: e.code ?? "JS",
      message: String(e.message).slice(0, 200),
      ms: round(performance.now() - t0),
    };
  }
}
const round = (n) => Math.round(n * 100) / 100;

// ── fixtures ───────────────────────────────────────────────────────────────
// The free-rating ledger is keyed by the sign-in identity and deliberately
// survives account deletion (20260902150000), so identities carry a per-run
// nonce: a replayed seed must not inherit ratings spent by an earlier run.
const RUN_NONCE = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
let identitySeq = 0;
async function createUsers(su, prng, n) {
  const ids = Array.from({ length: n }, () => prng.uuid());
  await dropUsers(su, ids); // idempotent: a previous aborted iteration may have left the row
  for (const id of ids) {
    identitySeq += 1;
    await su.query(
      `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
       values ($1, $2, '{"full_name":"Stress"}', '{"provider":"google"}')`,
      [id, `${id}@stress.test`],
    );
    const sub = `google-${id}-${RUN_NONCE}-${identitySeq}`;
    await su.query(
      `insert into auth.identities (provider, provider_id, user_id, identity_data)
       values ('google', $1, $2, $3)`,
      [sub, id, JSON.stringify({ sub, email: `${id}@stress.test` })],
    );
  }
  return ids;
}
async function dropUsers(su, ids) {
  await su.query(`delete from auth.users where id = any($1::uuid[])`, [ids]);
}
async function ownerCount(su, table, uid, extraWhere = "", params = []) {
  const r = await su.query(
    `select count(*)::int as n from public.${table} where user_id = $1 ${extraWhere}`,
    [uid, ...params],
  );
  return r.rows[0].n;
}

function shotPayload(prng, { id, permitId, sessionId, capturedAt = "2026-08-31T10:00:00Z" }) {
  return {
    id,
    analysisPermitId: permitId,
    sessionId,
    resultKind: "scored",
    shotType: "drive",
    cameraView: "side",
    capturedAt,
    startMs: 0,
    contactMs: 500,
    endMs: 1000,
    overallScore: round(5 + prng.next() * 4),
    confidence: 0.9,
    versionVector: {
      appVersion: "1.0.0",
      modelBundleVersion: "bundle-1",
      poseModelVersion: "pose-1",
      paddleModelVersion: "paddle-1",
      strokeDetectorVersion: "stroke-1",
      phaseModelVersion: "phase-1",
      scoringModelVersion: "scoring-1",
      shotConfigVersion: "config-1",
    },
    phases: [{ key: "contact", startMs: 400, representativeMs: 500, endMs: 600, confidence: 0.9 }],
    checkpoints: [
      {
        key: "contact_position",
        score: 71,
        confidence: 0.9,
        band: "green",
        direction: "ok",
        severity: 0.1,
        applicable: true,
      },
    ],
  };
}

// ── burst runner ───────────────────────────────────────────────────────────
/** Runs `fn(lane)` on every lane after a barrier so all connections are live
 *  before any statement is issued; each lane first sleeps its seeded delay
 *  (the call-during-call window). Returns per-lane rows with timing. */
async function burst(clients, lanes, delays, fn) {
  let open;
  const gate = new Promise((r) => (open = r));
  const rows = new Array(lanes);
  const all = Promise.all(
    Array.from({ length: lanes }, async (_, lane) => {
      await gate;
      const base = performance.now();
      await sleep(delays[lane]);
      const start = round(performance.now() - base);
      const out = await fn(clients[lane], lane);
      const end = round(performance.now() - base);
      rows[lane] = { lane, delayMs: delays[lane], startMs: start, endMs: end, ...out };
    }),
  );
  open();
  await all;
  return rows;
}
function overlaps(rows) {
  let pairs = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[i].startMs < rows[j].endMs && rows[j].startMs < rows[i].endMs) pairs++;
    }
  }
  return pairs;
}
const codes = (rows) => {
  const h = {};
  for (const r of rows) {
    const k = r.ok ? "ok" : r.code;
    h[k] = (h[k] ?? 0) + 1;
  }
  return h;
};
const codesFlat = (rows) => codes(rows.flatMap((r) => (Array.isArray(r) ? r : [r])));

// ── scenario helpers (the exact SQL PostgREST issues for each edge route) ──
const SQL = {
  // POST /v1/sessions → upsert(onConflict id, ignoreDuplicates) then ownership read
  sessionInsert: `insert into public.sessions (id, user_id, started_at) values ($1, $2, $3)
                  on conflict (id) do nothing`,
  sessionOwned: `select id, started_at from public.sessions where id = $1 and user_id = $2`,
  // POST /v1/sessions/:id/finalize → read ended_at, then update if null
  sessionRead: `select id, ended_at from public.sessions where id = $1 and user_id = $2`,
  sessionFinalize: `update public.sessions set ended_at = $3 where id = $1 and user_id = $2`,
  sessionFinalizeGuarded: `update public.sessions set ended_at = $3 where id = $1 and user_id = $2 and ended_at is null`,
  sessionDelete: `delete from public.sessions where id = $1 and user_id = $2`,
  // POST /v1/evaluation/trials → per trial: upsert(onConflict id, ignoreDuplicates) + ownership read
  trialUpsert: `insert into public.evaluation_trials (id, user_id, payload) values ($1, $2, $3)
                on conflict (id) do nothing`,
  trialOwned: `select id from public.evaluation_trials where id = $1 and user_id = $2`,
  // POST /v1/analysis/:id/feedback → single insert (23505 → 409 analysis.feedback_exists)
  feedbackInsert: `insert into public.analysis_feedback (user_id, analysis_id, rating, category)
                   values ($1, $2, $3, $4) returning id, created_at`,
  // captures has no client write path (20260904000000 revoked insert/update/delete);
  // the owner plane is the only writer.
  captureInsert: `insert into public.captures (id, user_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
                  values ($1, $2, now(), 1200, 30, 'automatic_pose_trigger', 'valid')`,
  reservePermit: `select * from public.reserve_analysis_permit($1)`,
  applyShot: `select public.apply_synced_shot($1::jsonb) as result`,
};

const check = (name, ok, detail) => ({ name, ok: Boolean(ok), detail });

// ── scenarios ──────────────────────────────────────────────────────────────
// Each scenario: async ({ su, clients, prng, lanes, iso }) → { checks, lanes, extra }
const SCENARIOS = [];
const scenario = (name, doc, run) => SCENARIOS.push({ name, doc, run });

scenario(
  "session_create_dup_same_user",
  "N duplicate POST /v1/sessions for one id from one user (outbox replay + clock skew on started_at): exactly one row, every caller acknowledged, first-writer started_at.",
  async ({ su, clients, prng, lanes, iso }) => {
    const [a] = await createUsers(su, prng, 1);
    const sid = prng.uuid();
    const base = Date.UTC(2026, 7, 31, 10, 0, 0);
    const startedAt = Array.from({ length: lanes }, () => {
      // clock skew: ±3 days on a seeded subset of lanes
      const skew = prng.next() < 0.4 ? prng.int(-3 * 86400_000, 3 * 86400_000) : 0;
      return new Date(base + skew).toISOString();
    });
    const delays = Array.from({ length: lanes }, () => prng.int(0, 8));
    const rows = await burst(clients, lanes, delays, async (c, lane) => {
      const ins = await tx(c, a, iso, (q) => q.query(SQL.sessionInsert, [sid, a, startedAt[lane]]));
      if (!ins.ok) return { ok: false, code: ins.code, step: "insert" };
      const owned = await tx(c, a, iso, async (q) => {
        const r = await q.query(SQL.sessionOwned, [sid, a]);
        return { owned: r.rowCount === 1, startedAt: r.rows[0]?.started_at?.toISOString() };
      });
      return owned.ok ? owned : { ok: false, code: owned.code, step: "owned" };
    });
    const n = await ownerCount(su, "sessions", a);
    const finalRow = await su.query(`select started_at from public.sessions where id = $1`, [sid]);
    const finalStarted = finalRow.rows[0]?.started_at?.toISOString();
    const allowed = iso === "serializable" ? ["40001"] : [];
    const checks = [
      check("exactly_one_row", n === 1, { rows: n }),
      check(
        "all_callers_acknowledged_or_serialization_retry",
        rows.every((r) => (r.ok && r.owned) || allowed.includes(r.code)),
        codes(rows),
      ),
      check("started_at_is_one_callers_value", startedAt.includes(finalStarted), { finalStarted }),
      check(
        "no_deadlock",
        rows.every((r) => r.code !== "40P01"),
        codes(rows),
      ),
    ];
    await dropUsers(su, [a]);
    return { checks, lanes: rows, extra: { sid, startedAt } };
  },
);

scenario(
  "session_create_two_actors_same_id",
  "Users A and B race POST /v1/sessions on the SAME session id: one row, one owner, the other user takes the 409 session.id_conflict path and can neither read nor finalize it.",
  async ({ su, clients, prng, lanes, iso }) => {
    const [a, b] = await createUsers(su, prng, 2);
    const sid = prng.uuid();
    const who = Array.from({ length: lanes }, (_, i) => (i < 2 ? [a, b][i] : prng.pick([a, b])));
    const delays = Array.from({ length: lanes }, () => prng.int(0, 8));
    const rows = await burst(clients, lanes, delays, async (c, lane) => {
      const u = who[lane];
      const ins = await tx(c, u, iso, (q) =>
        q.query(SQL.sessionInsert, [sid, u, "2026-08-31T10:00:00Z"]),
      );
      if (!ins.ok) return { ok: false, code: ins.code, user: u === a ? "A" : "B" };
      const owned = await tx(c, u, iso, async (q) => {
        const r = await q.query(SQL.sessionOwned, [sid, u]);
        return { owned: r.rowCount === 1 };
      });
      return { ...owned, user: u === a ? "A" : "B" };
    });
    const ownerRow = await su.query(`select user_id from public.sessions where id = $1`, [sid]);
    const owner = ownerRow.rows[0]?.user_id;
    const loser = owner === a ? b : a;
    const loserFinalize = await tx(clients[0], loser, iso, async (q) => {
      const r = await q.query(SQL.sessionFinalize, [sid, loser, new Date().toISOString()]);
      return { rowCount: r.rowCount };
    });
    const loserRead = await tx(clients[1], loser, iso, async (q) => {
      const r = await q.query(`select count(*)::int as n from public.sessions`);
      return { n: r.rows[0].n };
    });
    const allowed = iso === "serializable" ? ["40001"] : [];
    const checks = [
      check("exactly_one_row", ownerRow.rowCount === 1, { rows: ownerRow.rowCount }),
      check("owner_is_a_participant", owner === a || owner === b, { owner }),
      check(
        "owner_lanes_acknowledged",
        rows
          .filter((r) => who[r.lane] === owner)
          .every((r) => (r.ok && r.owned) || allowed.includes(r.code)),
        codes(rows),
      ),
      check(
        "loser_lanes_take_409_path",
        rows
          .filter((r) => who[r.lane] !== owner)
          .every((r) => (r.ok && !r.owned) || allowed.includes(r.code)),
        codes(rows),
      ),
      check(
        "loser_cannot_finalize",
        loserFinalize.ok && loserFinalize.rowCount === 0,
        loserFinalize,
      ),
      check("loser_cannot_read", loserRead.ok && loserRead.n === 0, loserRead),
      check(
        "no_deadlock",
        rows.every((r) => r.code !== "40P01"),
        codes(rows),
      ),
    ];
    await dropUsers(su, [a, b]);
    return { checks, lanes: rows, extra: { sid, owner: owner === a ? "A" : "B" } };
  },
);

/** The finalize route as the edge fn issues it: read ended_at (tx 1), then —
 *  if null — update it (tx 2). `guard` adds `and ended_at is null` to the UPDATE
 *  (the candidate fix shape; NOT what production issues). */
async function finalizeBurst({ su, clients, prng, lanes, iso }, guard) {
  const [a] = await createUsers(su, prng, 1);
  const sid = prng.uuid();
  await su.query(SQL.sessionInsert, [sid, a, "2026-08-31T10:00:00Z"]);
  const base = Date.UTC(2026, 7, 31, 10, 30, 0);
  // Each lane stamps its own client clock (edge fn: new Date().toISOString());
  // distinct per lane so a moved stamp is attributable.
  const stamps = Array.from({ length: lanes }, (_, i) =>
    new Date(base + i * 1000 + prng.int(0, 999)).toISOString(),
  );
  const delays = Array.from({ length: lanes }, () => prng.int(0, 6));
  const gaps = Array.from({ length: lanes }, () => prng.int(0, 12)); // call-during-call window
  const rows = await burst(clients, lanes, delays, async (c, lane) => {
    const read = await tx(c, a, iso, async (q) => {
      const r = await q.query(SQL.sessionRead, [sid, a]);
      return { endedAt: r.rows[0]?.ended_at ?? null };
    });
    if (!read.ok) return { ok: false, code: read.code, step: "read" };
    if (read.endedAt !== null) return { ok: true, applied: 0, sawStamp: true };
    await sleep(gaps[lane]);
    const upd = await tx(c, a, iso, async (q) => {
      const r = await q.query(guard ? SQL.sessionFinalizeGuarded : SQL.sessionFinalize, [
        sid,
        a,
        stamps[lane],
      ]);
      return { applied: r.rowCount };
    });
    return upd.ok ? { ...upd, sawStamp: false } : { ok: false, code: upd.code, step: "update" };
  });
  const fin = await su.query(`select ended_at, updated_at from public.sessions where id = $1`, [
    sid,
  ]);
  const endedAt = fin.rows[0]?.ended_at?.toISOString() ?? null;
  const applied = rows.reduce((s, r) => s + (r.applied ?? 0), 0);
  const appliedLanes = rows.filter((r) => r.applied === 1).map((r) => r.lane);
  const firstLane = appliedLanes.length ? appliedLanes[0] : null;
  const allowed = iso === "serializable" ? ["40001"] : [];
  const checks = [
    check("ended_at_stamped", endedAt !== null, { endedAt }),
    check("stamped_exactly_once_never_moved", applied === 1, {
      updatesApplied: applied,
      appliedLanes,
      stampsApplied: appliedLanes.map((l) => stamps[l]),
      finalEndedAt: endedAt,
      driftMsBetweenAppliedStamps:
        appliedLanes.length > 1
          ? Math.max(...appliedLanes.map((l) => Date.parse(stamps[l]))) -
            Math.min(...appliedLanes.map((l) => Date.parse(stamps[l])))
          : 0,
    }),
    check(
      "final_value_is_an_applied_stamp",
      appliedLanes.some((l) => stamps[l] === endedAt),
      { endedAt },
    ),
    check(
      "no_unexpected_errors",
      rows.every((r) => r.ok || allowed.includes(r.code)),
      codes(rows),
    ),
    check(
      "no_deadlock",
      rows.every((r) => r.code !== "40P01"),
      codes(rows),
    ),
  ];
  await dropUsers(su, [a]);
  return { checks, lanes: rows, extra: { sid, stamps, firstLane, guard } };
}
scenario(
  "session_finalize_burst_edge_shape",
  "N concurrent POST /v1/sessions/:id/finalize (edge shape: SELECT ended_at → UPDATE if null, two autocommit statements). Contract (index.ts finalizeSession doc): ended_at is stamped once and a replay never moves it.",
  (ctx) => finalizeBurst(ctx, false),
);
scenario(
  "session_finalize_guarded_candidate",
  "Same burst with `and ended_at is null` on the UPDATE (candidate fix shape, not production): exactly one stamp applies.",
  (ctx) => finalizeBurst(ctx, true),
);

scenario(
  "session_finalize_min2_deterministic",
  "Minimized 2-lane deterministic interleaving of the finalize race: both SELECT (null), lane 0 UPDATEs+commits, then lane 1 UPDATEs+commits. Contract says the second must not move the stamp.",
  async ({ su, clients, prng, iso }) => {
    const [a] = await createUsers(su, prng, 1);
    const sid = prng.uuid();
    await su.query(SQL.sessionInsert, [sid, a, "2026-08-31T10:00:00Z"]);
    const s0 = "2026-08-31T10:30:00.000Z";
    const s1 = "2026-08-31T10:30:00.250Z";
    const r0 = await tx(clients[0], a, iso, async (q) => ({
      endedAt: (await q.query(SQL.sessionRead, [sid, a])).rows[0].ended_at,
    }));
    const r1 = await tx(clients[1], a, iso, async (q) => ({
      endedAt: (await q.query(SQL.sessionRead, [sid, a])).rows[0].ended_at,
    }));
    const u0 =
      r0.endedAt === null
        ? await tx(clients[0], a, iso, async (q) => ({
            applied: (await q.query(SQL.sessionFinalize, [sid, a, s0])).rowCount,
          }))
        : { ok: true, applied: 0 };
    const u1 =
      r1.endedAt === null
        ? await tx(clients[1], a, iso, async (q) => ({
            applied: (await q.query(SQL.sessionFinalize, [sid, a, s1])).rowCount,
          }))
        : { ok: true, applied: 0 };
    const fin = await su.query(`select ended_at from public.sessions where id = $1`, [sid]);
    const endedAt = fin.rows[0].ended_at.toISOString();
    const rows = [
      { lane: 0, ...r0, update: u0 },
      { lane: 1, ...r1, update: u1 },
    ];
    const checks = [
      check("both_reads_saw_null", r0.endedAt === null && r1.endedAt === null, {}),
      check(
        "stamped_exactly_once_never_moved",
        (u0.applied ?? 0) + (u1.applied ?? 0) === 1 && endedAt === s0,
        {
          updatesApplied: (u0.applied ?? 0) + (u1.applied ?? 0),
          firstStamp: s0,
          finalEndedAt: endedAt,
        },
      ),
    ];
    await dropUsers(su, [a]);
    return { checks, lanes: rows, extra: { sid, s0, s1 } };
  },
);

scenario(
  "session_delete_vs_shot_sync",
  "Owner deletes a session (authenticated holds DELETE on sessions) while N lanes replay apply_synced_shot for the same shot id referencing it: at most one shot, permit finalized iff the shot exists (no double spend), FK consistent (session_id null once the session is gone), no deadlock.",
  async ({ su, clients, prng, lanes, iso }) => {
    const [a] = await createUsers(su, prng, 1);
    const sid = prng.uuid();
    const shotId = prng.uuid();
    await su.query(SQL.sessionInsert, [sid, a, "2026-08-31T10:00:00Z"]);
    const reserve = await tx(clients[0], a, iso, async (q) => {
      const r = await q.query(SQL.reservePermit, [`k-${shotId}`]);
      return { result: r.rows[0].result, permitId: r.rows[0].permit_id };
    });
    if (!reserve.ok || reserve.result !== "accepted") {
      await dropUsers(su, [a]);
      return { checks: [check("setup_permit_reserved", false, reserve)], lanes: [], extra: {} };
    }
    const deleteLanes = new Set([prng.int(0, lanes - 1)]);
    if (lanes > 4 && prng.next() < 0.3) deleteLanes.add(prng.int(0, lanes - 1));
    const payload = shotPayload(prng, { id: shotId, permitId: reserve.permitId, sessionId: sid });
    const delays = Array.from({ length: lanes }, () => prng.int(0, 10));
    const rows = await burst(clients, lanes, delays, async (c, lane) => {
      if (deleteLanes.has(lane)) {
        const d = await tx(c, a, iso, async (q) => ({
          deleted: (await q.query(SQL.sessionDelete, [sid, a])).rowCount,
        }));
        return { ...d, op: "delete_session" };
      }
      const r = await tx(c, a, iso, async (q) => ({
        result: (await q.query(SQL.applyShot, [JSON.stringify(payload)])).rows[0].result,
      }));
      return { ...r, op: "apply_synced_shot" };
    });
    const shots = await su.query(`select id, session_id from public.shots where user_id = $1`, [a]);
    const sessionLeft = (await su.query(`select 1 from public.sessions where id = $1`, [sid]))
      .rowCount;
    const permit = (
      await su.query(`select status, outcome from public.analysis_permits where id = $1`, [
        reserve.permitId,
      ])
    ).rows[0];
    const phases = await ownerCount(su, "shot_phases", a);
    const ledger = (
      await su.query(
        `select coalesce(max(scored_count), 0)::int as n from public.free_rating_ledger l
      join auth.identities i on public.free_rating_identity_hash(i.provider, i.provider_id) = l.identity_hash
      where i.user_id = $1`,
        [a],
      )
    ).rows[0].n;
    const results = rows
      .filter((r) => r.op === "apply_synced_shot")
      .map((r) => (r.ok ? r.result : r.code));
    const okResults = new Set(["accepted", "shot.session_not_found", "shot.write_failed:23503"]);
    // apply_synced_shot maps SQLSTATE inside its handler → 'shot.write_failed:<code>'
    const allowed = iso === "serializable" ? ["40001", "shot.write_failed:40001"] : [];
    const checks = [
      check("at_most_one_shot", shots.rowCount <= 1, { shots: shots.rowCount }),
      check(
        "permit_finalized_iff_shot_exists",
        shots.rowCount === 1 ? permit.status === "finalized" : permit.status === "reserved",
        { permit, shots: shots.rowCount },
      ),
      check("phases_match_shots", phases === shots.rowCount, { phases }),
      check(
        "fk_consistent",
        shots.rows.every((s) => (sessionLeft ? s.session_id === sid : s.session_id === null)),
        { sessionLeft, shots: shots.rows },
      ),
      check("ledger_matches_shots", ledger === shots.rowCount, { ledger, shots: shots.rowCount }),
      check(
        "only_documented_results",
        results.every((r) => okResults.has(r) || allowed.includes(r)),
        { results },
      ),
      check(
        "no_deadlock",
        rows.every((r) => r.code !== "40P01"),
        codes(rows),
      ),
    ];
    await dropUsers(su, [a]);
    return {
      checks,
      lanes: rows,
      extra: { sid, shotId, deleteLanes: [...deleteLanes], sessionLeft },
    };
  },
);

scenario(
  "trial_upload_dup_same_user",
  "N duplicate POST /v1/evaluation/trials for the same 1–3 trial ids from one user (per-trial upsert+ownership read, as the edge loop does): one row per id, every caller acknowledged, payload is one caller's, no deadlock.",
  async ({ su, clients, prng, lanes, iso }) => {
    const [a] = await createUsers(su, prng, 1);
    const k = prng.int(1, 3);
    const ids = Array.from({ length: k }, () => prng.uuid());
    const delays = Array.from({ length: lanes }, () => prng.int(0, 8));
    const rows = await burst(clients, lanes, delays, async (c, lane) => {
      const per = [];
      for (const id of ids) {
        const up = await tx(c, a, iso, (q) =>
          q.query(SQL.trialUpsert, [id, a, JSON.stringify({ kind: "trial", lane, id })]),
        );
        if (!up.ok) {
          per.push({ id, ok: false, code: up.code });
          continue;
        }
        const own = await tx(c, a, iso, async (q) => ({
          owned: (await q.query(SQL.trialOwned, [id, a])).rowCount === 1,
        }));
        per.push(own.ok ? { id, ok: true, owned: own.owned } : { id, ok: false, code: own.code });
      }
      return { ok: per.every((p) => p.ok), code: per.find((p) => !p.ok)?.code, per };
    });
    const stored = await su.query(
      `select id, payload from public.evaluation_trials where user_id = $1`,
      [a],
    );
    const allowed = iso === "serializable" ? ["40001"] : [];
    const perAll = rows.flatMap((r) => r.per);
    const checks = [
      check(
        "one_row_per_trial_id",
        stored.rowCount === k && new Set(stored.rows.map((r) => r.id)).size === k,
        { stored: stored.rowCount, k },
      ),
      check(
        "every_caller_acknowledged",
        perAll.every((p) => (p.ok && p.owned) || allowed.includes(p.code)),
        codes(perAll),
      ),
      check(
        "payload_is_one_callers",
        stored.rows.every(
          (r) => r.payload.id === r.id && r.payload.lane >= 0 && r.payload.lane < lanes,
        ),
        stored.rows.map((r) => r.payload.lane),
      ),
      check(
        "no_deadlock",
        perAll.every((p) => p.code !== "40P01"),
        codes(perAll),
      ),
    ];
    await dropUsers(su, [a]);
    return { checks, lanes: rows, extra: { ids } };
  },
);

scenario(
  "trial_two_actors_same_id",
  "Users A and B race the same trial id: one row, owner acknowledged, the other user takes the 409 evaluation.trial_id_conflict path and cannot read the row.",
  async ({ su, clients, prng, lanes, iso }) => {
    const [a, b] = await createUsers(su, prng, 2);
    const id = prng.uuid();
    const who = Array.from({ length: lanes }, (_, i) => (i < 2 ? [a, b][i] : prng.pick([a, b])));
    const delays = Array.from({ length: lanes }, () => prng.int(0, 8));
    const rows = await burst(clients, lanes, delays, async (c, lane) => {
      const u = who[lane];
      const up = await tx(c, u, iso, (q) =>
        q.query(SQL.trialUpsert, [id, u, JSON.stringify({ kind: "trial", lane })]),
      );
      if (!up.ok) return { ok: false, code: up.code };
      const own = await tx(c, u, iso, async (q) => ({
        owned: (await q.query(SQL.trialOwned, [id, u])).rowCount === 1,
      }));
      return own;
    });
    const row = await su.query(`select user_id from public.evaluation_trials where id = $1`, [id]);
    const owner = row.rows[0]?.user_id;
    const loser = owner === a ? b : a;
    const loserRead = await tx(clients[0], loser, iso, async (q) => ({
      n: (await q.query(`select count(*)::int as n from public.evaluation_trials`)).rows[0].n,
    }));
    const allowed = iso === "serializable" ? ["40001"] : [];
    const checks = [
      check("exactly_one_row", row.rowCount === 1, {}),
      check(
        "owner_lanes_acknowledged",
        rows
          .filter((r) => who[r.lane] === owner)
          .every((r) => (r.ok && r.owned) || allowed.includes(r.code)),
        codes(rows),
      ),
      check(
        "loser_lanes_take_409_path",
        rows
          .filter((r) => who[r.lane] !== owner)
          .every((r) => (r.ok && !r.owned) || allowed.includes(r.code)),
        codes(rows),
      ),
      check("loser_cannot_read", loserRead.ok && loserRead.n === 0, loserRead),
      check(
        "no_deadlock",
        rows.every((r) => r.code !== "40P01"),
        codes(rows),
      ),
    ];
    await dropUsers(su, [a, b]);
    return { checks, lanes: rows, extra: { id, owner: owner === a ? "A" : "B" } };
  },
);

scenario(
  "feedback_dup_same_user",
  "N duplicate POST /v1/analysis/:id/feedback from one user (double-tap / retry): exactly one insert succeeds, every other lane gets 23505 (→ 409 analysis.feedback_exists), one row whose rating is the winner's.",
  async ({ su, clients, prng, lanes, iso }) => {
    const [a] = await createUsers(su, prng, 1);
    const analysisId = prng.uuid();
    const ratings = Array.from({ length: lanes }, () =>
      prng.next() < 0.5
        ? ["accurate", null]
        : ["not_quite", prng.pick(["timing", "form", "score"])],
    );
    const delays = Array.from({ length: lanes }, () => prng.int(0, 8));
    const rows = await burst(clients, lanes, delays, async (c, lane) => {
      const [rating, category] = ratings[lane];
      return tx(c, a, iso, async (q) => ({
        id: (await q.query(SQL.feedbackInsert, [a, analysisId, rating, category])).rows[0].id,
        rating,
      }));
    });
    const stored = await su.query(
      `select rating, category from public.analysis_feedback where analysis_id = $1`,
      [analysisId],
    );
    const winners = rows.filter((r) => r.ok);
    const allowed = new Set(iso === "serializable" ? ["23505", "40001"] : ["23505"]);
    const checks = [
      check("exactly_one_row", stored.rowCount === 1, { rows: stored.rowCount }),
      check("exactly_one_winner", winners.length === 1, codes(rows)),
      check(
        "losers_get_23505",
        rows.filter((r) => !r.ok).every((r) => allowed.has(r.code)),
        codes(rows),
      ),
      check(
        "row_is_winners_rating",
        winners.length === 1 && stored.rows[0]?.rating === winners[0].rating,
        { stored: stored.rows, winner: winners[0]?.rating },
      ),
      check(
        "no_deadlock",
        rows.every((r) => r.code !== "40P01"),
        codes(rows),
      ),
    ];
    await dropUsers(su, [a]);
    return { checks, lanes: rows, extra: { analysisId, ratings } };
  },
);

scenario(
  "feedback_two_actors_same_analysis",
  "Users A and B both submit feedback for the same analysis id concurrently (the DB key is (analysis_id, user_id)): one row per user, each sees only their own row.",
  async ({ su, clients, prng, lanes, iso }) => {
    const [a, b] = await createUsers(su, prng, 2);
    const analysisId = prng.uuid();
    const who = Array.from({ length: lanes }, (_, i) => (i < 2 ? [a, b][i] : prng.pick([a, b])));
    const delays = Array.from({ length: lanes }, () => prng.int(0, 8));
    const rows = await burst(clients, lanes, delays, async (c, lane) => {
      const u = who[lane];
      const r = await tx(c, u, iso, async (q) => ({
        id: (await q.query(SQL.feedbackInsert, [u, analysisId, "accurate", null])).rows[0].id,
      }));
      return { ...r, user: u === a ? "A" : "B" };
    });
    const seenByA = await tx(clients[0], a, iso, async (q) => ({
      n: (await q.query(`select count(*)::int as n from public.analysis_feedback`)).rows[0].n,
    }));
    const seenByB = await tx(clients[1], b, iso, async (q) => ({
      n: (await q.query(`select count(*)::int as n from public.analysis_feedback`)).rows[0].n,
    }));
    const total = (
      await su.query(
        `select count(*)::int as n from public.analysis_feedback where analysis_id = $1`,
        [analysisId],
      )
    ).rows[0].n;
    const allowed = new Set(iso === "serializable" ? ["23505", "40001"] : ["23505"]);
    const checks = [
      check("one_row_per_user", total === 2, { total }),
      check(
        "one_winner_per_user",
        rows.filter((r) => r.ok && r.user === "A").length === 1 &&
          rows.filter((r) => r.ok && r.user === "B").length === 1,
        codes(rows),
      ),
      check(
        "losers_get_23505",
        rows.filter((r) => !r.ok).every((r) => allowed.has(r.code)),
        codes(rows),
      ),
      check("rls_each_sees_only_own", seenByA.n === 1 && seenByB.n === 1, { seenByA, seenByB }),
      check(
        "no_deadlock",
        rows.every((r) => r.code !== "40P01"),
        codes(rows),
      ),
    ];
    await dropUsers(su, [a, b]);
    return { checks, lanes: rows, extra: { analysisId } };
  },
);

scenario(
  "account_delete_during_writes",
  "Logout/deletion during in-flight requests: user C's lanes write sessions / trials / feedback / finalize while the owner plane deletes auth.users(C) at a seeded moment. Afterwards no row for C may survive in any table; lanes either succeed (and are cascaded) or fail with 23503; no deadlock.",
  async ({ su, clients, prng, lanes, iso }) => {
    const [c] = await createUsers(su, prng, 1);
    const preSession = prng.uuid();
    await su.query(SQL.sessionInsert, [preSession, c, "2026-08-31T10:00:00Z"]);
    const killLane = prng.int(0, lanes - 1);
    const ops = Array.from({ length: lanes }, () =>
      prng.pick(["session", "trial", "feedback", "finalize"]),
    );
    const delays = Array.from({ length: lanes }, (_, i) =>
      i === killLane ? prng.int(0, 15) : prng.int(0, 10),
    );
    const ids = Array.from({ length: lanes }, () => prng.uuid());
    const rows = await burst(clients, lanes, delays, async (cl, lane) => {
      if (lane === killLane) {
        const d = await tx(cl, null, iso, async (q) => ({
          deleted: (await q.query(`delete from auth.users where id = $1`, [c])).rowCount,
        }));
        return { ...d, op: "delete_user" };
      }
      const op = ops[lane];
      if (op === "session")
        return {
          ...(await tx(cl, c, iso, (q) =>
            q.query(SQL.sessionInsert, [ids[lane], c, "2026-08-31T10:00:00Z"]),
          )),
          op,
        };
      if (op === "trial")
        return {
          ...(await tx(cl, c, iso, (q) =>
            q.query(SQL.trialUpsert, [ids[lane], c, JSON.stringify({ kind: "trial", lane })]),
          )),
          op,
        };
      if (op === "feedback")
        return {
          ...(await tx(cl, c, iso, (q) =>
            q.query(SQL.feedbackInsert, [c, ids[lane], "accurate", null]),
          )),
          op,
        };
      return {
        ...(await tx(cl, c, iso, async (q) => ({
          applied: (await q.query(SQL.sessionFinalize, [preSession, c, "2026-08-31T10:30:00Z"]))
            .rowCount,
        }))),
        op,
      };
    });
    const survivors = {};
    for (const t of [
      "profiles",
      "sessions",
      "evaluation_trials",
      "analysis_feedback",
      "analysis_permits",
      "shots",
      "captures",
    ]) {
      const col = t === "profiles" ? "id" : "user_id";
      survivors[t] = (
        await su.query(`select count(*)::int as n from public.${t} where ${col} = $1`, [c])
      ).rows[0].n;
    }
    const authLeft = (
      await su.query(`select count(*)::int as n from auth.users where id = $1`, [c])
    ).rows[0].n;
    const allowed = new Set(iso === "serializable" ? ["23503", "40001"] : ["23503"]);
    const checks = [
      check(
        "user_deleted",
        authLeft === 0 && rows[killLane].ok && rows[killLane].deleted === 1,
        rows[killLane],
      ),
      check(
        "no_orphan_rows_survive",
        Object.values(survivors).every((n) => n === 0),
        survivors,
      ),
      check(
        "writes_succeed_or_23503",
        rows.filter((r) => r.op !== "delete_user").every((r) => r.ok || allowed.has(r.code)),
        codes(rows),
      ),
      check(
        "no_deadlock",
        rows.every((r) => r.code !== "40P01"),
        codes(rows),
      ),
    ];
    return { checks, lanes: rows, extra: { killLane, ops } };
  },
);

scenario(
  "captures_client_readonly_race",
  "Owner plane inserts captures for A while A reads them and A/B hammer INSERT/UPDATE/DELETE on captures as authenticated: every client write is 42501, A's final count equals what the owner wrote, B sees nothing.",
  async ({ su, clients, prng, lanes, iso }) => {
    const [a, b] = await createUsers(su, prng, 2);
    const n = prng.int(1, 4);
    const capIds = Array.from({ length: n }, () => prng.uuid());
    const roles = Array.from({ length: lanes }, (_, i) =>
      i === 0 ? "owner_insert" : prng.pick(["a_read", "a_write", "b_write", "b_read"]),
    );
    const delays = Array.from({ length: lanes }, () => prng.int(0, 8));
    const rows = await burst(clients, lanes, delays, async (c, lane) => {
      const role = roles[lane];
      if (role === "owner_insert") {
        const r = await tx(c, null, iso, async (q) => {
          for (const id of capIds) {
            await q.query(SQL.captureInsert, [id, a]);
          }
          return { inserted: capIds.length };
        });
        return { ...r, role };
      }
      if (role === "a_read" || role === "b_read") {
        const u = role === "a_read" ? a : b;
        return {
          ...(await tx(c, u, iso, async (q) => ({
            n: (await q.query(`select count(*)::int as n from public.captures`)).rows[0].n,
          }))),
          role,
        };
      }
      const u = role === "a_write" ? a : b;
      const stmt = prng.pick([
        [SQL.captureInsert, [prng.uuid(), u]],
        [`update public.captures set duration_ms = 1 where id = $1`, [capIds[0]]],
        [`delete from public.captures where id = $1`, [capIds[0]]],
      ]);
      return {
        ...(await tx(c, u, iso, (q) => q.query(stmt[0], stmt[1]))),
        role,
        stmt: stmt[0].split(" ")[0],
      };
    });
    const finalA = await ownerCount(su, "captures", a);
    const bSees = await tx(clients[0], b, iso, async (q) => ({
      n: (await q.query(`select count(*)::int as n from public.captures`)).rows[0].n,
    }));
    const writes = rows.filter((r) => r.role === "a_write" || r.role === "b_write");
    const checks = [
      check("owner_insert_ok", rows[0].ok, rows[0]),
      check(
        "client_writes_all_42501",
        writes.every((r) => !r.ok && r.code === "42501"),
        codes(writes),
      ),
      check("a_final_count_matches_owner_writes", finalA === n, { finalA, n }),
      check("b_sees_nothing", bSees.ok && bSees.n === 0, bSees),
      check(
        "reads_never_error",
        rows.filter((r) => r.role.endsWith("_read")).every((r) => r.ok),
        codes(rows),
      ),
    ];
    await dropUsers(su, [a, b]);
    return { checks, lanes: rows, extra: { capIds, roles } };
  },
);

scenario(
  "mixed_workload_deadlock_probe",
  "Two users, every op of the unit interleaved at random (dup session create, finalize, session delete, trial upsert, feedback insert, apply_synced_shot replays, access_state) with seeded delays: bounded wall time, no 40P01/57014, only documented error codes, per-user RLS totals equal the owner-plane totals, permits finalized == scored shots.",
  async ({ su, clients, prng, lanes, iso }) => {
    const [a, b] = await createUsers(su, prng, 2);
    const users = [a, b];
    const sess = { [a]: [prng.uuid(), prng.uuid()], [b]: [prng.uuid(), prng.uuid()] };
    for (const u of users)
      await su.query(SQL.sessionInsert, [sess[u][0], u, "2026-08-31T10:00:00Z"]);
    const permits = {};
    for (const u of users) {
      const r = await tx(clients[0], u, iso, async (q) => {
        const row = (await q.query(SQL.reservePermit, [`k-${prng.uuid()}`])).rows[0];
        return { result: row.result, permitId: row.permit_id };
      });
      if (!r.ok || r.result !== "accepted") {
        await dropUsers(su, users);
        return { checks: [check("setup_permit_reserved", false, r)], lanes: [], extra: {} };
      }
      permits[u] = r.permitId;
    }
    const shotIds = { [a]: prng.uuid(), [b]: prng.uuid() };
    const trialIds = { [a]: prng.uuid(), [b]: prng.uuid() };
    const analysisIds = { [a]: prng.uuid(), [b]: prng.uuid() };
    const OPS = [
      "session_dup",
      "session_new",
      "finalize",
      "session_delete",
      "trial",
      "feedback",
      "shot",
      "access_state",
    ];
    const plan = Array.from({ length: lanes }, () => ({
      u: prng.pick(users),
      ops: Array.from({ length: prng.int(1, 3) }, () => prng.pick(OPS)),
    }));
    const delays = Array.from({ length: lanes }, () => prng.int(0, 10));
    const rows = await burst(clients, lanes, delays, async (c, lane) => {
      const { u, ops } = plan[lane];
      const outs = [];
      for (const op of ops) {
        let r;
        switch (op) {
          case "session_dup":
            r = await tx(c, u, iso, (q) =>
              q.query(SQL.sessionInsert, [sess[u][0], u, "2026-08-31T10:00:00Z"]),
            );
            break;
          case "session_new":
            r = await tx(c, u, iso, (q) =>
              q.query(SQL.sessionInsert, [sess[u][1], u, "2026-08-31T10:00:00Z"]),
            );
            break;
          case "finalize":
            r = await tx(c, u, iso, (q) =>
              q.query(SQL.sessionFinalize, [prng.pick(sess[u]), u, new Date().toISOString()]),
            );
            break;
          case "session_delete":
            r = await tx(c, u, iso, (q) => q.query(SQL.sessionDelete, [sess[u][1], u]));
            break;
          case "trial":
            r = await tx(c, u, iso, (q) =>
              q.query(SQL.trialUpsert, [trialIds[u], u, JSON.stringify({ kind: "trial", lane })]),
            );
            break;
          case "feedback":
            r = await tx(c, u, iso, (q) =>
              q.query(SQL.feedbackInsert, [u, analysisIds[u], "accurate", null]),
            );
            break;
          case "shot":
            r = await tx(c, u, iso, async (q) => ({
              result: (
                await q.query(SQL.applyShot, [
                  JSON.stringify(
                    shotPayload(prng, {
                      id: shotIds[u],
                      permitId: permits[u],
                      sessionId: sess[u][0],
                    }),
                  ),
                ])
              ).rows[0].result,
            }));
            break;
          default:
            r = await tx(c, u, iso, async (q) => ({
              state: (await q.query(`select * from public.access_state()`)).rows[0],
            }));
        }
        outs.push({ op, ok: r.ok, code: r.code, result: r.result, ms: r.ms });
        await sleep(prng.int(0, 3));
      }
      return {
        ok: outs.every((o) => o.ok || o.code === "23505"),
        code: outs.find((o) => !o.ok && o.code !== "23505")?.code,
        user: u === a ? "A" : "B",
        outs,
      };
    });
    const flat = rows.flatMap((r) => r.outs);
    const allowedCodes = new Set(iso === "serializable" ? ["23505", "40001"] : ["23505"]);
    const okShot = new Set([
      "accepted",
      "shot.session_not_found",
      "shot.write_failed:23503",
      ...(iso === "serializable" ? ["shot.write_failed:40001"] : []),
    ]);
    const totals = {};
    for (const u of users) {
      const tag = u === a ? "A" : "B";
      const owner = {};
      const rls = {};
      for (const t of [
        "sessions",
        "shots",
        "evaluation_trials",
        "analysis_feedback",
        "analysis_permits",
      ]) {
        owner[t] = await ownerCount(su, t, u);
        rls[t] = (
          await tx(clients[0], u, iso, async (q) => ({
            n: (await q.query(`select count(*)::int as n from public.${t}`)).rows[0].n,
          }))
        ).n;
      }
      const fin = (
        await su.query(
          `select count(*)::int as n from public.analysis_permits where user_id = $1 and status = 'finalized'`,
          [u],
        )
      ).rows[0].n;
      totals[tag] = { owner, rls, finalizedPermits: fin };
    }
    const checks = [
      check(
        "no_deadlock_or_timeout",
        flat.every((o) => o.code !== "40P01" && o.code !== "57014"),
        codesFlat(flat),
      ),
      check(
        "only_documented_errors",
        flat.every((o) => o.ok || allowedCodes.has(o.code)),
        codesFlat(flat),
      ),
      check(
        "shot_results_documented",
        flat.filter((o) => o.op === "shot" && o.ok).every((o) => okShot.has(o.result)),
        flat.filter((o) => o.op === "shot").map((o) => o.result ?? o.code),
      ),
      check(
        "rls_totals_equal_owner_totals",
        Object.values(totals).every((t) => JSON.stringify(t.owner) === JSON.stringify(t.rls)),
        totals,
      ),
      check(
        "no_duplicate_rows",
        Object.values(totals).every(
          (t) =>
            t.owner.sessions <= 2 &&
            t.owner.shots <= 1 &&
            t.owner.evaluation_trials <= 1 &&
            t.owner.analysis_feedback <= 1,
        ),
        totals,
      ),
      check(
        "permits_finalized_eq_scored_shots",
        Object.values(totals).every((t) => t.finalizedPermits === t.owner.shots),
        totals,
      ),
    ];
    await dropUsers(su, [a, b]);
    return {
      checks,
      lanes: rows,
      extra: { plan: plan.map((p) => ({ u: p.u === a ? "A" : "B", ops: p.ops })) },
    };
  },
);

scenario(
  "clock_skew_session_bounds",
  "Client-controlled sessions.started_at under clock skew, issued straight at the table (the edge fn's isIsoDate already rejects out-of-range startedAt over HTTP, but `authenticated` holds INSERT on sessions so PostgREST with the user's own access token bypasses it): the DB bound 20260904000000 gives shots/captures.captured_at ([2000-01-01, 2100-01-01)) is expected for sessions.started_at, and a server-clock finalize (edge: new Date()) must not produce ended_at < started_at — the in-range 2099 lane is reachable through the edge fn as-is.",
  async ({ su, clients, prng, lanes, iso }) => {
    const [a] = await createUsers(su, prng, 1);
    const candidates = [
      ["1900-01-01T00:00:00Z", false],
      ["1999-12-31T23:59:59Z", false],
      ["2000-01-01T00:00:00Z", true],
      ["2026-08-31T10:00:00Z", true],
      ["2099-12-31T23:59:59Z", true],
      ["2100-01-01T00:00:00Z", false],
      ["2200-06-01T00:00:00Z", false],
      ["9999-12-31T23:59:59Z", false],
    ];
    const picks = Array.from({ length: lanes }, () => prng.pick(candidates));
    const ids = Array.from({ length: lanes }, () => prng.uuid());
    const delays = Array.from({ length: lanes }, () => prng.int(0, 5));
    const rows = await burst(clients, lanes, delays, async (c, lane) => {
      const [startedAt, shouldAccept] = picks[lane];
      const ins = await tx(c, a, iso, (q) => q.query(SQL.sessionInsert, [ids[lane], a, startedAt]));
      if (!ins.ok) return { ok: true, startedAt, shouldAccept, accepted: false, code: ins.code };
      // finalize with the SERVER clock (edge fn uses Date.now(); here now() — same effect)
      const fin = await tx(c, a, iso, async (q) => {
        const r = await q.query(
          `update public.sessions set ended_at = now() where id = $1 and user_id = $2 returning started_at, ended_at`,
          [ids[lane], a],
        );
        return { endedBeforeStarted: r.rows[0].ended_at < r.rows[0].started_at };
      });
      return {
        ok: fin.ok,
        startedAt,
        shouldAccept,
        accepted: true,
        endedBeforeStarted: fin.endedBeforeStarted,
      };
    });
    const outOfRangeAccepted = rows
      .filter((r) => r.accepted && !r.shouldAccept)
      .map((r) => r.startedAt);
    const inRangeRejected = rows
      .filter((r) => !r.accepted && r.shouldAccept)
      .map((r) => ({ startedAt: r.startedAt, code: r.code }));
    const negativeDurations = rows.filter((r) => r.endedBeforeStarted).map((r) => r.startedAt);
    const checks = [
      check("in_range_started_at_accepted", inRangeRejected.length === 0, { inRangeRejected }),
      check("out_of_range_started_at_rejected_like_captured_at", outOfRangeAccepted.length === 0, {
        outOfRangeAccepted,
      }),
      check("finalize_never_yields_ended_before_started", negativeDurations.length === 0, {
        negativeDurations,
      }),
    ];
    await dropUsers(su, [a]);
    return { checks, lanes: rows, extra: { picks: picks.map((p) => p[0]) } };
  },
);

// ── campaign ───────────────────────────────────────────────────────────────
function replayCmd(name, seed, iso) {
  return `STRESS_PG_URL=<from ./stress_pg_up.sh> STRESS_SEED=${seed} STRESS_ITER=1 STRESS_LANES=${LANES} STRESS_ISOLATION=${iso} STRESS_FILTER='^${name}$' node supabase/tests/stress/db_sessions_captures_concurrency.mjs`;
}

async function main() {
  const selected = SCENARIOS.filter((s) => FILTER.test(s.name));
  if (selected.length === 0) {
    console.error(`no scenario matches STRESS_FILTER=${FILTER}`);
    process.exit(2);
  }
  const su = new pg.Client({ connectionString: PG_URL });
  await su.connect();
  const clients = [];
  for (let i = 0; i < LANES; i++) {
    const c = new pg.Client({ connectionString: PG_URL });
    await c.connect();
    clients.push(c);
  }
  const version = (await su.query("select version()")).rows[0].version;
  const migrations = (
    await su.query(
      `select count(*)::int as n from pg_proc where proname in ('apply_synced_shot','reserve_analysis_permit','access_state')`,
    )
  ).rows[0].n;
  if (migrations < 3) {
    console.error("database is missing the migration RPCs — was ./stress_pg_up.sh used?");
    process.exit(2);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const iterations = [];
  const seedsTable = [];
  let executed = 0;
  let broken = 0;

  for (const iso of ISOLATIONS) {
    for (const s of selected) {
      for (let i = 0; i < ITER; i++) {
        const seed = iterSeed(s.name, iso, i);
        const prng = new Prng(seed);
        const it0 = performance.now();
        let result;
        let timedOut = false;
        try {
          result = await Promise.race([
            s.run({ su, clients, prng, lanes: LANES, iso }),
            sleep(WALL_MS).then(() => {
              timedOut = true;
              return null;
            }),
          ]);
        } catch (e) {
          result = {
            checks: [
              check("harness_exception", false, { message: String(e.message), code: e.code }),
            ],
            lanes: [],
            extra: {},
          };
        }
        const wallMs = round(performance.now() - it0);
        if (timedOut || result === null) {
          result = {
            checks: [check("wall_time_bound", false, { wallMs, boundMs: WALL_MS })],
            lanes: [],
            extra: {},
          };
        }
        const failed = result.checks.filter((c) => !c.ok);
        const outcome = failed.length ? "BROKEN" : "HELD";
        if (outcome === "BROKEN") broken++;
        executed++;
        const laneRows = result.lanes ?? [];
        const rec = {
          scenario: s.name,
          isolation: iso,
          iter: i,
          seed,
          outcome,
          wallMs,
          lanes: laneRows.length,
          overlappingLanePairs:
            laneRows.length && laneRows[0]?.startMs !== undefined ? overlaps(laneRows) : null,
          codes: codesFlat(laneRows.flatMap((r) => r.per ?? r.outs ?? [r])),
          failedChecks: failed.map((c) => c.name),
          replay: replayCmd(s.name, seed, iso),
        };
        seedsTable.push(rec);
        iterations.push({ ...rec, checks: result.checks, laneRows, extra: result.extra });
        const mark = outcome === "HELD" ? "HELD  " : "BROKEN";
        console.log(
          `${mark} ${iso.padEnd(15)} ${s.name.padEnd(36)} iter=${String(i).padStart(3)} seed=${String(seed).padStart(10)} ${String(wallMs).padStart(8)}ms${failed.length ? "  ✗ " + failed.map((c) => c.name).join(",") : ""}`,
        );
        if (timedOut) break;
      }
    }
  }

  const durationMs = round(performance.now() - t0);
  const byScenario = {};
  for (const r of seedsTable) {
    const k = `${r.scenario}@${r.isolation}`;
    byScenario[k] ??= {
      executed: 0,
      held: 0,
      broken: 0,
      failedChecks: {},
      brokenSeeds: [],
      maxWallMs: 0,
    };
    byScenario[k].executed++;
    byScenario[k][r.outcome === "HELD" ? "held" : "broken"]++;
    byScenario[k].maxWallMs = Math.max(byScenario[k].maxWallMs, r.wallMs);
    for (const f of r.failedChecks)
      byScenario[k].failedChecks[f] = (byScenario[k].failedChecks[f] ?? 0) + 1;
    if (r.outcome === "BROKEN") byScenario[k].brokenSeeds.push(r.seed);
  }
  const findings = iterations
    .filter((r) => r.outcome === "BROKEN")
    .map((r) => ({
      scenario: r.scenario,
      isolation: r.isolation,
      seed: r.seed,
      replay: r.replay,
      failedChecks: r.checks.filter((c) => !c.ok),
      extra: r.extra,
    }));
  const report = {
    unit: "db-sessions-captures",
    lens: "concurrency",
    startedAt,
    durationMs,
    postgres: version,
    inputs: {
      STRESS_SEED: SEED,
      STRESS_ITER: ITER,
      STRESS_LANES: LANES,
      STRESS_ISOLATION: ISOLATION,
      STRESS_FILTER: FILTER.source,
      STRESS_WALL_MS: WALL_MS,
    },
    scenarios: selected.map((s) => ({ name: s.name, doc: s.doc })),
    executed,
    held: executed - broken,
    broken,
    byScenario,
    memory: process.memoryUsage(),
    iterations,
  };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, "seeds.json"), JSON.stringify(seedsTable, null, 2));
  fs.writeFileSync(path.join(OUT, "findings.json"), JSON.stringify(findings, null, 2));
  console.log(
    `\nexecuted=${executed} held=${executed - broken} broken=${broken} durationMs=${durationMs}`,
  );
  console.log(`artifacts: ${OUT}/{report,seeds,findings}.json`);
  for (const c of clients) await c.end();
  await su.end();
  process.exit(broken ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
