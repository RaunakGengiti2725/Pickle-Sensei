#!/usr/bin/env node
// ============================================================================
// Stress harness — db-deletion-consent unit, CONCURRENCY lens.
//
// Drives account_deletion_requests, account_deletion_feedback,
// consent_records and account_external_credentials (plus the auth.users →
// profiles → * cascade) with seeded bursts of parallel sessions against the
// migrated schema (supabase/tests/stress/setup_stress_db.sh). Every iteration
// is replayable from its seed; results land in a JSON table (seed → outcome).
//
//   STRESS_DB_URL=postgres://postgres:x@127.0.0.1:5499/postgres \
//   STRESS_ITER=600 STRESS_SEED=1 STRESS_OUT=/tmp/stress.json \
//     node supabase/tests/stress/deletion_consent_concurrency.mjs
//
//   STRESS_REPLAY=123456789,987654321   replay exactly these iteration seeds
//   STRESS_ONLY=request_rearm_burst      run one scenario only
//   STRESS_ISOLATION=serializable        run every actor tx SERIALIZABLE
//                                        (40001 is retried and counted; the
//                                        production code does not claim
//                                        SERIALIZABLE — READ COMMITTED is the
//                                        default and the contract under test)
//
// Exit code: 0 when every executed iteration HELD, 1 when any iteration is
// BROKEN, 2 on harness/setup error. Never touches production.
// ============================================================================

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";

// `pg` is a dependency of @pickle/database; resolve through that workspace so
// the harness needs no package.json of its own.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const require = createRequire(path.join(repoRoot, "packages/database/package.json"));
const pg = require("pg");

const DB_URL = process.env.STRESS_DB_URL ?? "postgres://postgres:x@127.0.0.1:5499/postgres";
const ITER = Number.parseInt(process.env.STRESS_ITER ?? "24", 10);
const MASTER_SEED = Number.parseInt(process.env.STRESS_SEED ?? "1", 10);
const OUT = process.env.STRESS_OUT ?? "";
const ONLY = process.env.STRESS_ONLY ?? "";
// Exit-survey rows are append-only even for the owner plane and survive user
// deletion (anonymized), so a re-run against the same DB must not count rows a
// previous run left behind: every free-text tag carries a per-process nonce.
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const REPLAY = (process.env.STRESS_REPLAY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number.parseInt(s, 10));
const ISOLATION = (process.env.STRESS_ISOLATION ?? "read_committed").toLowerCase();
const SERIALIZABLE = ISOLATION === "serializable";
const POOL_SIZE = Number.parseInt(process.env.STRESS_POOL ?? "24", 10);
const ITERATION_WALL_MS = Number.parseInt(process.env.STRESS_ITER_WALL_MS ?? "30000", 10);

// ───────────────────────────── seeded RNG ────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function iterationSeed(master, i) {
  const h = createHash("sha256").update(`${master}:${i}`).digest();
  return h.readUInt32BE(0);
}
class Rng {
  constructor(seed) {
    this.seed = seed;
    this.next = mulberry32(seed);
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
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  uuid() {
    const b = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) b[i] = this.int(0, 255);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── connections ───────────────────────────────
class ClientPool {
  constructor(size) {
    this.size = size;
    this.idle = [];
    this.waiters = [];
    this.all = [];
  }
  async open() {
    for (let i = 0; i < this.size; i++) {
      const c = new pg.Client({ connectionString: DB_URL });
      await c.connect();
      this.all.push(c);
      this.idle.push(c);
    }
  }
  acquire() {
    if (this.idle.length) return Promise.resolve(this.idle.pop());
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  release(c) {
    const w = this.waiters.shift();
    if (w) w(c);
    else this.idle.push(c);
  }
  async close() {
    await Promise.all(this.all.map((c) => c.end()));
  }
}

const pool = new ClientPool(POOL_SIZE);
const stats = { serializationRetries: 0 };

/**
 * Run `body(client)` inside one transaction on a dedicated session, as the
 * given actor. actor = { role: 'authenticated', sub } | { role: 'service_role' }
 * | { role: 'owner' } (the migration owner / Auth admin plane — what
 * auth.admin.deleteUser() and the FK cascades run as).
 * Returns { ok, rows, error: { code, message } , startedAt, endedAt, retries }.
 */
async function tx(actor, body, { retrySerialization = SERIALIZABLE } = {}) {
  const client = await pool.acquire();
  let retries = 0;
  try {
    for (;;) {
      const startedAt = performance.now();
      try {
        await client.query(
          SERIALIZABLE
            ? "begin isolation level serializable"
            : "begin isolation level read committed",
        );
        await client.query("set local lock_timeout = '5s'");
        await client.query("set local statement_timeout = '15s'");
        if (actor.role === "authenticated") {
          await client.query("set local role authenticated");
          await client.query("select set_config('request.jwt.claim.sub', $1, true)", [actor.sub]);
        } else if (actor.role === "service_role") {
          await client.query("set local role service_role");
        } else if (actor.role !== "owner") {
          throw new Error(`unknown actor role ${actor.role}`);
        }
        const rows = await body(client);
        await client.query("commit");
        return { ok: true, rows, startedAt, endedAt: performance.now(), retries };
      } catch (error) {
        try {
          await client.query("rollback");
        } catch {
          // connection may be broken; surface the original error
        }
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (retrySerialization && code === "40001" && retries < 20) {
          retries++;
          stats.serializationRetries++;
          await sleep(1 + retries);
          continue;
        }
        return {
          ok: false,
          error: { code: code ?? null, message: String(error?.message ?? error) },
          startedAt,
          endedAt: performance.now(),
          retries,
        };
      }
    }
  } finally {
    pool.release(client);
  }
}

const q = (client, text, params) => client.query(text, params).then((r) => r.rows);

// ───────────────────────────── fixtures ──────────────────────────────────
async function createUser(rng, provider, tag) {
  const id = rng.uuid();
  const sub = `${provider}-sub-${id.slice(0, 8)}`;
  const r = await tx({ role: "owner" }, async (c) => {
    await c.query(
      `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
       values ($1, $2, $3::jsonb, $4::jsonb)`,
      [
        id,
        `${tag}-${id.slice(0, 8)}@example.com`,
        JSON.stringify({ full_name: tag }),
        JSON.stringify({ provider }),
      ],
    );
    await c.query(
      `insert into auth.identities (provider, provider_id, user_id, identity_data)
       values ($1, $2, $3, $4::jsonb)`,
      [provider, sub, id, JSON.stringify({ sub, email: `${tag}@example.com` })],
    );
    const p = await c.query("select 1 from public.profiles where id = $1", [id]);
    if (p.rowCount !== 1) throw new Error("handle_new_user did not provision a profile");
    return [];
  });
  if (!r.ok) throw new Error(`createUser failed: ${r.error.message}`);
  return { id, provider, sub };
}

async function destroyUsers(ids) {
  const r = await tx({ role: "owner" }, async (c) => {
    await c.query("delete from auth.users where id = any($1::uuid[])", [ids]);
    return [];
  });
  if (!r.ok) throw new Error(`cleanup failed: ${r.error.message}`);
}

// The PostgREST upsert shape requestAccountDeletion() issues
// (onConflict: user_id → DO UPDATE sets every payload column).
const REARM_SQL = `
  insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
  values ($1, $2, now(), now() + interval '15 minutes')
  on conflict (user_id) do update
    set user_id = excluded.user_id, challenge = excluded.challenge,
        created_at = excluded.created_at, expires_at = excluded.expires_at
  returning challenge, (extract(epoch from clock_timestamp()) * 1e6)::bigint::text as applied_at`;

const CONSENT_SCOPES = ["video_analysis", "model_training", "evaluation_telemetry"];
const SURVEY_REASONS = [
  "not_using",
  "not_helpful",
  "scores_inaccurate",
  "technical_issues",
  "too_expensive",
  "privacy",
  "other",
];
const SURVEY_WANTED = ["accuracy", "price", "content", "stability", "switched", "nothing", null];

const isAuthed = (u) => ({ role: "authenticated", sub: u.id });
const OWNER = { role: "owner" };
const SERVICE = { role: "service_role" };

// Sqlstates that are legitimate outcomes of losing a race against the
// account-deletion cascade (the edge fn turns them into a 503 the app retries,
// after which the bearer no longer authenticates).
const LOST_TO_CASCADE = new Set(["23503"]);
// RLS / grant denials — expected for every cross-user or rewrite attempt.
const DENIED = new Set(["42501"]);
const DEADLOCK = "40P01";
const LOCK_TIMEOUT = "55P03";
const STATEMENT_TIMEOUT = "57014";

// ───────────────────────────── scenarios ─────────────────────────────────
// Each scenario returns { checks: [{name, pass, detail}], observations: {…},
// sqlstates: {code: n} }. A scenario is HELD iff every check passes.

function tally(results) {
  const sqlstates = {};
  for (const r of results) {
    if (!r.ok) sqlstates[r.error.code ?? "JS"] = (sqlstates[r.error.code ?? "JS"] ?? 0) + 1;
  }
  return sqlstates;
}
function noPathologies(results, allowed) {
  const bad = results.filter((r) => !r.ok && !allowed.has(r.error.code));
  return {
    name: "no unexpected sqlstate / deadlock / lock timeout",
    pass: bad.length === 0,
    detail: bad.map((b) => `${b.error.code}: ${b.error.message}`).slice(0, 5),
  };
}
async function jitter(rng) {
  const ms = rng.int(0, 6);
  if (ms > 0) await sleep(ms);
}

async function verifyNoOrphans(userIds) {
  const r = await tx(OWNER, async (c) => {
    const rows = await q(
      c,
      `select
         (select count(*) from public.account_deletion_requests r
            where not exists (select 1 from public.profiles p where p.id = r.user_id)) as orphan_requests,
         (select count(*) from public.consent_records r
            where not exists (select 1 from public.profiles p where p.id = r.user_id)) as orphan_consent,
         (select count(*) from public.account_external_credentials r
            where not exists (select 1 from public.profiles p where p.id = r.user_id)) as orphan_external,
         (select count(*) from public.account_deletion_feedback r
            where r.user_id is not null
              and not exists (select 1 from public.profiles p where p.id = r.user_id)) as dangling_feedback,
         (select count(*) from public.profiles p
            where p.id = any($1::uuid[])
              and not exists (select 1 from auth.users u where u.id = p.id)) as orphan_profiles`,
      [userIds],
    );
    return rows;
  });
  if (!r.ok) return { name: "orphan sweep", pass: false, detail: r.error.message };
  const row = r.rows[0];
  const total = Object.values(row).reduce((a, v) => a + Number(v), 0);
  return { name: "no orphan / dangling rows after cascade", pass: total === 0, detail: row };
}

// S1 — N concurrent delete-request re-arms for ONE user. Exactly one row; the
// surviving challenge is the one applied last (row lock order); no deadlock.
async function request_rearm_burst(rng, users) {
  const a = users.a;
  const n = rng.int(2, 10);
  const challenges = Array.from({ length: n }, () => rng.uuid());
  const results = await Promise.all(
    challenges.map(async (ch) => {
      await jitter(rng);
      return tx(isAuthed(a), (c) => q(c, REARM_SQL, [a.id, ch]));
    }),
  );
  const okResults = results.filter((r) => r.ok);
  const applied = okResults
    .map((r) => ({ challenge: r.rows[0].challenge, at: Number(r.rows[0].applied_at) }))
    .sort((x, y) => x.at - y.at);
  const final = await tx(isAuthed(a), (c) =>
    q(c, "select challenge, expires_at > now() as live from public.account_deletion_requests"),
  );
  const rows = final.ok ? final.rows : [];
  const checks = [
    noPathologies(results, new Set()),
    {
      name: "all re-arms succeed",
      pass: okResults.length === n,
      detail: `${okResults.length}/${n}`,
    },
    { name: "exactly one request row for the user", pass: rows.length === 1, detail: rows.length },
    {
      name: "surviving challenge is one that was minted",
      pass: rows.length === 1 && challenges.includes(rows[0].challenge),
      detail: rows[0]?.challenge,
    },
    {
      name: "surviving challenge = last applied (no lost update)",
      pass:
        rows.length === 1 && applied.length > 0 && applied.at(-1).challenge === rows[0].challenge,
      detail: { final: rows[0]?.challenge, lastApplied: applied.at(-1)?.challenge },
    },
    {
      name: "challenge is live (expires_at in the future)",
      pass: rows[0]?.live === true,
      detail: rows[0]?.live,
    },
  ];
  return { checks, observations: { n }, sqlstates: tally(results) };
}

// S2 — two actors: A and B re-arm concurrently, B also tries to write / read /
// delete A's row. Each sees exactly one own row; every cross-user path denied.
async function request_two_actors(rng, users) {
  const { a, b } = users;
  const ops = [];
  const nA = rng.int(1, 4);
  const nB = rng.int(1, 4);
  for (let i = 0; i < nA; i++) ops.push({ who: "a", kind: "rearm" });
  for (let i = 0; i < nB; i++) ops.push({ who: "b", kind: "rearm" });
  const crossKinds = rng.shuffle([
    "insert_as_a",
    "update_a_row",
    "delete_a_row",
    "select_a_row",
    "steal_via_upsert",
  ]);
  for (const k of crossKinds.slice(0, rng.int(2, 5))) ops.push({ who: "b", kind: k });
  const shuffled = rng.shuffle(ops);
  const results = await Promise.all(
    shuffled.map(async (op) => {
      await jitter(rng);
      const actor = isAuthed(op.who === "a" ? a : b);
      const r = await tx(actor, async (c) => {
        switch (op.kind) {
          case "rearm":
            return q(c, REARM_SQL, [op.who === "a" ? a.id : b.id, rng.uuid()]);
          case "insert_as_a":
            return q(c, REARM_SQL, [a.id, rng.uuid()]);
          case "update_a_row":
            return c
              .query(
                "update public.account_deletion_requests set challenge = $2 where user_id = $1",
                [a.id, rng.uuid()],
              )
              .then((x) => [{ rowCount: x.rowCount }]);
          case "delete_a_row":
            return c
              .query("delete from public.account_deletion_requests where user_id = $1", [a.id])
              .then((x) => [{ rowCount: x.rowCount }]);
          case "select_a_row":
            return q(c, "select user_id from public.account_deletion_requests where user_id = $1", [
              a.id,
            ]);
          case "steal_via_upsert":
            // B's own row exists or not; try to move A's row onto B via the
            // upsert's DO UPDATE SET user_id path.
            return c
              .query(
                `update public.account_deletion_requests set user_id = $2 where user_id = $1`,
                [a.id, b.id],
              )
              .then((x) => [{ rowCount: x.rowCount }]);
          default:
            throw new Error(op.kind);
        }
      });
      return { op, r };
    }),
  );
  const own = results.filter((x) => x.op.kind === "rearm").map((x) => x.r);
  const cross = results.filter((x) => x.op.kind !== "rearm");
  const crossOk = cross.filter(
    (x) =>
      x.r.ok &&
      // reads/updates/deletes that silently affect 0 rows are fine (RLS filter);
      // an INSERT/UPDATE that reports success on A's row is a breach.
      ((x.op.kind === "insert_as_a" && true) ||
        (x.op.kind === "update_a_row" && x.r.rows[0].rowCount > 0) ||
        (x.op.kind === "delete_a_row" && x.r.rows[0].rowCount > 0) ||
        (x.op.kind === "select_a_row" && x.r.rows.length > 0) ||
        (x.op.kind === "steal_via_upsert" && x.r.rows[0].rowCount > 0)),
  );
  const crossDeniedProperly = cross.filter((x) => !x.r.ok && !DENIED.has(x.r.error.code));
  const state = await tx(OWNER, (c) =>
    q(
      c,
      "select user_id, count(*)::int as n from public.account_deletion_requests where user_id = any($1::uuid[]) group by 1",
      [[a.id, b.id]],
    ),
  );
  const nRows = Object.fromEntries((state.ok ? state.rows : []).map((r) => [r.user_id, r.n]));
  const checks = [
    noPathologies(own, new Set()),
    { name: "own re-arms all succeed", pass: own.every((r) => r.ok), detail: tally(own) },
    { name: "A has exactly one row", pass: nRows[a.id] === 1, detail: nRows[a.id] },
    { name: "B has exactly one row", pass: nRows[b.id] === 1, detail: nRows[b.id] },
    {
      name: "no cross-user write/read succeeded",
      pass: crossOk.length === 0,
      detail: crossOk.map((x) => x.op.kind),
    },
    {
      name: "cross-user denials are 42501 (never deadlock/timeout)",
      pass: crossDeniedProperly.length === 0,
      detail: crossDeniedProperly.map((x) => `${x.op.kind}:${x.r.error.code}`),
    },
  ];
  return {
    checks,
    observations: { nA, nB, cross: cross.length },
    sqlstates: tally(results.map((x) => x.r)),
  };
}

// S3 — consent ledger append burst: grant/withdraw interleavings for A (and
// some B noise) across scopes; row count == successful inserts; fold is total
// and deterministic; UPDATE/DELETE attempts denied; cross-user insert denied.
async function consent_burst(rng, users) {
  const { a, b } = users;
  const n = rng.int(3, 14);
  const ops = [];
  for (let i = 0; i < n; i++) {
    ops.push({
      who: rng.bool(0.8) ? "a" : "b",
      scope: rng.pick(CONSENT_SCOPES),
      action: rng.bool() ? "grant" : "withdraw",
      version: rng.pick(["v1", "v2", null]),
    });
  }
  const rewrite = rng
    .shuffle(["update", "delete", "cross_insert", "null_owner"])
    .slice(0, rng.int(1, 4));
  const results = await Promise.all([
    ...ops.map(async (op) => {
      await jitter(rng);
      const u = op.who === "a" ? a : b;
      return tx(isAuthed(u), (c) =>
        q(
          c,
          `insert into public.consent_records (user_id, scope, action, consent_version, source, device, capture_mode)
           values ($1, $2, $3, $4, 'mobile_settings', $5::jsonb, $6)
           returning id, created_at, (extract(epoch from clock_timestamp()) * 1e6)::bigint::text as applied_at`,
          [
            u.id,
            op.scope,
            op.action,
            op.version,
            JSON.stringify(`iPhone ${rng.int(11, 16)}`),
            op.action === "grant" ? "all_captures" : null,
          ],
        ).then((rows) => [{ ...rows[0], op }]),
      );
    }),
    ...rewrite.map(async (kind) => {
      await jitter(rng);
      return tx(isAuthed(a), async (c) => {
        switch (kind) {
          case "update":
            return c
              .query("update public.consent_records set action = 'grant' where user_id = $1", [
                a.id,
              ])
              .then((x) => [{ kind, rowCount: x.rowCount }]);
          case "delete":
            return c
              .query("delete from public.consent_records where user_id = $1", [a.id])
              .then((x) => [{ kind, rowCount: x.rowCount }]);
          case "cross_insert":
            return q(
              c,
              "insert into public.consent_records (user_id, scope, action) values ($1, 'model_training', 'grant') returning id",
              [b.id],
            ).then((rows) => [{ kind, rows }]);
          case "null_owner":
            return q(
              c,
              "insert into public.consent_records (user_id, scope, action) values (null, 'model_training', 'grant') returning id",
            ).then((rows) => [{ kind, rows }]);
          default:
            throw new Error(kind);
        }
      }).then((r) => ({ ...r, kind }));
    }),
  ]);
  const inserts = results.slice(0, ops.length);
  const rewrites = results.slice(ops.length);
  const okInserts = inserts.filter((r) => r.ok);
  const state = await tx(OWNER, (c) =>
    q(
      c,
      `select user_id, scope, action, consent_version, created_at, id
         from public.consent_records where user_id = any($1::uuid[])
        order by created_at, id`,
      [[a.id, b.id]],
    ),
  );
  const rows = state.ok ? state.rows : [];
  // Fold twice from independently ordered reads: must agree (total order).
  const fold = (rs, uid) =>
    Object.fromEntries(
      CONSENT_SCOPES.map((s) => {
        const last = rs.filter((r) => r.user_id === uid && r.scope === s).at(-1);
        return [s, last ? last.action : null];
      }),
    );
  const state2 = await tx(isAuthed(a), (c) =>
    q(
      c,
      "select user_id, scope, action, created_at, id from public.consent_records order by created_at, id",
    ),
  );
  const foldA1 = fold(rows, a.id);
  const foldA2 = fold(state2.ok ? state2.rows : [], a.id);
  // Does the created_at/id order agree with the order the inserts were applied?
  // (created_at = transaction start; a slower tx can carry an EARLIER stamp
  // than one that applied later — the fold then honours arrival order, not
  // commit order. Recorded as an observation, not a failure.)
  const appliedOrder = okInserts
    .map((r) => r.rows[0])
    .filter((r) => r.op.who === "a")
    .sort((x, y) => Number(x.applied_at) - Number(y.applied_at))
    .map((r) => r.id);
  const storedOrder = rows.filter((r) => r.user_id === a.id).map((r) => r.id);
  const orderMismatch = appliedOrder.join() !== storedOrder.join();
  const rewriteBreach = rewrites.filter(
    (r) => r.ok && (r.kind === "cross_insert" || r.kind === "null_owner" || r.rows[0].rowCount > 0),
  );
  const rewriteBadCode = rewrites.filter(
    (r) =>
      !r.ok && !DENIED.has(r.error.code) && !(r.kind === "null_owner" && r.error.code === "23502"),
  );
  const checks = [
    noPathologies(inserts, new Set()),
    {
      name: "every owner append succeeds",
      pass: okInserts.length === ops.length,
      detail: `${okInserts.length}/${ops.length}`,
    },
    {
      name: "ledger row count == successful appends",
      pass: rows.length === okInserts.length,
      detail: `${rows.length} vs ${okInserts.length}`,
    },
    { name: "no duplicate ledger ids", pass: new Set(rows.map((r) => r.id)).size === rows.length },
    {
      name: "fold deterministic across owner/service reads",
      pass: JSON.stringify(foldA1) === JSON.stringify(foldA2),
      detail: { foldA1, foldA2 },
    },
    {
      name: "owner sees only own rows",
      pass: state2.ok && state2.rows.every((r) => r.user_id === a.id),
      detail: state2.ok ? state2.rows.length : state2.error,
    },
    {
      name: "no rewrite / cross-user / null-owner append succeeded",
      pass: rewriteBreach.length === 0,
      detail: rewriteBreach.map((r) => r.kind),
    },
    {
      name: "rewrite denials are 42501 (null owner: 42501 or 23502)",
      pass: rewriteBadCode.length === 0,
      detail: rewriteBadCode.map((r) => `${r.kind}:${r.error.code}`),
    },
  ];
  return {
    checks,
    observations: { n, rewrites: rewrite, createdAtOrderDiffersFromApplyOrder: orderMismatch },
    sqlstates: tally(results),
  };
}

// S4 — confirm-during-request: while A re-arms / appends consent / files the
// exit survey from 1..3 "devices", the Auth admin plane deletes auth.users
// (what /v1/me/delete-confirm ends with). End state: A fully cascaded, survey
// rows anonymized (never removed), no orphan, no deadlock; losing writers get
// exactly 23503.
async function request_vs_delete(rng, users) {
  const { a } = users;
  const tag = `seed-${rng.seed}-${RUN_ID}`;
  // pre-existing pending request (the real flow always has one before confirm)
  await tx(isAuthed(a), (c) => q(c, REARM_SQL, [a.id, rng.uuid()]));
  if (rng.bool(0.5)) {
    await tx(SERVICE, (c) =>
      q(
        c,
        `insert into public.account_external_credentials (user_id, apple_refresh_token_encrypted, apple_token_captured_at)
         values ($1, $2, now())`,
        [a.id, `v1.${"a".repeat(24)}.${"b".repeat(40)}`],
      ),
    );
  }
  const writers = [];
  const nRearm = rng.int(0, 3);
  const nConsent = rng.int(0, 3);
  const nSurvey = rng.int(0, 2);
  for (let i = 0; i < nRearm; i++) writers.push("rearm");
  for (let i = 0; i < nConsent; i++) writers.push("consent");
  for (let i = 0; i < nSurvey; i++) writers.push("survey");
  writers.push("delete");
  if (rng.bool(0.3)) writers.push("delete"); // second confirm from another device
  const order = rng.shuffle(writers);
  const results = await Promise.all(
    order.map(async (kind, idx) => {
      await sleep(rng.int(0, 8));
      if (kind === "delete") {
        return tx(OWNER, (c) =>
          c
            .query("delete from auth.users where id = $1", [a.id])
            .then((x) => [{ kind, rowCount: x.rowCount }]),
        ).then((r) => ({ ...r, kind }));
      }
      return tx(isAuthed(a), async (c) => {
        if (kind === "rearm") return q(c, REARM_SQL, [a.id, rng.uuid()]);
        if (kind === "consent")
          return q(
            c,
            "insert into public.consent_records (user_id, scope, action) values ($1, $2, $3) returning id",
            [a.id, rng.pick(CONSENT_SCOPES), rng.bool() ? "grant" : "withdraw"],
          );
        // No RETURNING: the table is write-only for clients (no SELECT grant),
        // exactly like the edge fn's insert (Prefer: return=minimal).
        return c
          .query(
            `insert into public.account_deletion_feedback (user_id, reason, wanted, details, provider, platform, app_version, account_age_days, was_premium, scored_count)
             values ($1, $2, $3, $4, $5, 'ios', '1.0.0', $6, false, $7)`,
            [
              a.id,
              rng.pick(SURVEY_REASONS),
              rng.pick(SURVEY_WANTED),
              `${tag}#${idx}`,
              a.provider,
              rng.int(0, 400),
              rng.int(0, 2),
            ],
          )
          .then((x) => [{ rowCount: x.rowCount }]);
      }).then((r) => ({ ...r, kind }));
    }),
  );
  const deletes = results.filter((r) => r.kind === "delete");
  const deletedRows = deletes.filter((r) => r.ok).reduce((s, r) => s + r.rows[0].rowCount, 0);
  const writes = results.filter((r) => r.kind !== "delete");
  const surveysOk = writes.filter((r) => r.kind === "survey" && r.ok).length;
  const after = await tx(OWNER, (c) =>
    q(
      c,
      `select
         (select count(*) from auth.users where id = $1)::int as users,
         (select count(*) from public.profiles where id = $1)::int as profiles,
         (select count(*) from public.account_deletion_requests where user_id = $1)::int as requests,
         (select count(*) from public.consent_records where user_id = $1)::int as consent,
         (select count(*) from public.account_external_credentials where user_id = $1)::int as external,
         (select count(*) from public.account_deletion_feedback where user_id = $1)::int as feedback_named,
         (select count(*) from public.account_deletion_feedback where user_id is null and details like $2)::int as feedback_anon`,
      [a.id, `${tag}#%`],
    ),
  );
  const s = after.ok ? after.rows[0] : {};
  const checks = [
    noPathologies(results, LOST_TO_CASCADE),
    {
      name: "exactly one delete removed the auth user",
      pass: deletedRows === 1,
      detail: deletedRows,
    },
    { name: "auth.users + profiles gone", pass: s.users === 0 && s.profiles === 0, detail: s },
    { name: "deletion request cascaded", pass: s.requests === 0, detail: s.requests },
    { name: "consent ledger cascaded", pass: s.consent === 0, detail: s.consent },
    { name: "external credentials cascaded", pass: s.external === 0, detail: s.external },
    {
      name: "no survey row still names the user",
      pass: s.feedback_named === 0,
      detail: s.feedback_named,
    },
    {
      name: "every committed survey row survives anonymized",
      pass: s.feedback_anon === surveysOk,
      detail: { anonymized: s.feedback_anon, committed: surveysOk },
    },
    {
      name: "writes that lost to the cascade failed with 23503 only",
      pass: writes.filter((r) => !r.ok).every((r) => r.error.code === "23503"),
      detail: tally(writes),
    },
  ];
  return {
    checks,
    observations: {
      nRearm,
      nConsent,
      nSurvey,
      secondDelete: deletes.length === 2,
      lostToCascade: writes.filter((r) => !r.ok).length,
    },
    sqlstates: tally(results),
  };
}

// S5 — account_external_credentials: bootstrap capture (upsert with the Apple
// ciphertext), deletion checkpoints (mark revoked / clear unrevocable token /
// RevenueCat stamp) racing on one row from several service-role sessions,
// optionally with the cascade. Invariants: ≤1 row, constraints hold, no
// deadlock; lost-update patterns are recorded as observations.
async function external_credentials_race(rng, users) {
  const { a } = users;
  const token = `v1.${"c".repeat(24)}.${"d".repeat(48)}`;
  const kinds = [];
  const nBoot = rng.int(1, 3);
  for (let i = 0; i < nBoot; i++) kinds.push("bootstrap");
  if (rng.bool(0.7)) kinds.push("rc_checkpoint");
  if (rng.bool(0.6)) kinds.push("mark_revoked");
  if (rng.bool(0.4)) kinds.push("clear_token");
  if (rng.bool(0.5)) kinds.push("client_read");
  const withDelete = rng.bool(0.3);
  if (withDelete) kinds.push("delete");
  const order = rng.shuffle(kinds);
  const results = await Promise.all(
    order.map(async (kind) => {
      await jitter(rng);
      if (kind === "delete")
        return tx(OWNER, (c) =>
          c
            .query("delete from auth.users where id = $1", [a.id])
            .then((x) => [{ rowCount: x.rowCount }]),
        ).then((r) => ({ ...r, kind }));
      if (kind === "client_read")
        return tx(isAuthed(a), (c) =>
          q(c, "select user_id from public.account_external_credentials"),
        ).then((r) => ({ ...r, kind }));
      return tx(SERVICE, async (c) => {
        switch (kind) {
          case "bootstrap":
            return q(
              c,
              `insert into public.account_external_credentials
                 (user_id, apple_refresh_token_encrypted, apple_token_captured_at, apple_revoked_at, updated_at)
               values ($1, $2, now(), null, now())
               on conflict (user_id) do update
                 set apple_refresh_token_encrypted = excluded.apple_refresh_token_encrypted,
                     apple_token_captured_at = excluded.apple_token_captured_at,
                     apple_revoked_at = excluded.apple_revoked_at,
                     updated_at = excluded.updated_at
               returning (extract(epoch from clock_timestamp()) * 1e6)::bigint::text as applied_at`,
              [a.id, token],
            );
          case "rc_checkpoint":
            return q(
              c,
              `insert into public.account_external_credentials (user_id, revenuecat_deleted_at, updated_at)
               values ($1, now(), now())
               on conflict (user_id) do update
                 set revenuecat_deleted_at = excluded.revenuecat_deleted_at, updated_at = excluded.updated_at
               returning (extract(epoch from clock_timestamp()) * 1e6)::bigint::text as applied_at`,
              [a.id],
            );
          case "mark_revoked":
            return c
              .query(
                "update public.account_external_credentials set apple_revoked_at = now(), updated_at = now() where user_id = $1 returning (extract(epoch from clock_timestamp()) * 1e6)::bigint::text as applied_at",
                [a.id],
              )
              .then((x) => (x.rows.length ? x.rows : [{ applied_at: null, rowCount: 0 }]));
          case "clear_token":
            return c
              .query(
                "update public.account_external_credentials set apple_refresh_token_encrypted = null, apple_token_captured_at = null, updated_at = now() where user_id = $1 returning (extract(epoch from clock_timestamp()) * 1e6)::bigint::text as applied_at",
                [a.id],
              )
              .then((x) => (x.rows.length ? x.rows : [{ applied_at: null, rowCount: 0 }]));
          default:
            throw new Error(kind);
        }
      }).then((r) => ({ ...r, kind }));
    }),
  );
  const after = await tx(OWNER, (c) =>
    q(
      c,
      `select apple_refresh_token_encrypted is not null as has_token, apple_token_captured_at is not null as has_captured,
              apple_revoked_at is not null as revoked, revenuecat_deleted_at is not null as rc_deleted
         from public.account_external_credentials where user_id = $1`,
      [a.id],
    ),
  );
  const rows = after.ok ? after.rows : [];
  const svc = results.filter((r) => r.kind !== "delete" && r.kind !== "client_read");
  const clientReads = results.filter((r) => r.kind === "client_read");
  const nonClient = results.filter((r) => r.kind !== "client_read");
  const applied = svc
    .filter((r) => r.ok && r.rows[0]?.applied_at)
    .map((r) => ({ kind: r.kind, at: Number(r.rows[0].applied_at) }))
    .sort((x, y) => x.at - y.at);
  const lastRevoke = applied.map((x) => x.kind).lastIndexOf("mark_revoked");
  const lastBoot = applied.map((x) => x.kind).lastIndexOf("bootstrap");
  const revokeThenBootstrap = lastRevoke >= 0 && lastBoot > lastRevoke;
  const checks = [
    noPathologies(nonClient, withDelete ? LOST_TO_CASCADE : new Set()),
    { name: "at most one credentials row", pass: rows.length <= 1, detail: rows.length },
    {
      name: withDelete ? "row cascaded with the user" : "row present after writes",
      pass: withDelete ? rows.length === 0 : rows.length === 1,
      detail: rows,
    },
    {
      name: "capture pair constraint holds (token ⇔ captured_at)",
      pass: rows.every((r) => r.has_token === r.has_captured),
      detail: rows,
    },
    {
      name: "client role cannot read the table (42501)",
      pass: clientReads.every((r) => !r.ok && r.error.code === "42501"),
      detail: tally(clientReads),
    },
    {
      name: "revoked_at reflects the last applied write",
      pass:
        withDelete ||
        rows.length !== 1 ||
        rows[0].revoked === (lastRevoke >= 0 && !revokeThenBootstrap),
      detail: { revoked: rows[0]?.revoked, order: applied.map((x) => x.kind) },
    },
  ];
  return {
    checks,
    observations: {
      kinds: order,
      withDelete,
      bootstrapAfterRevokeResetsRevokedAt: revokeThenBootstrap,
    },
    sqlstates: tally(results),
  };
}

// S6 — double confirm (two devices race delete-confirm) plus a stale-bearer
// re-arm after deletion: exactly one delete lands, the loser sees 0 rows, the
// post-deletion request write fails closed with 23503.
async function double_confirm(rng, users) {
  const { a } = users;
  await tx(isAuthed(a), (c) => q(c, REARM_SQL, [a.id, rng.uuid()]));
  const reads = await Promise.all([
    tx(isAuthed(a), (c) =>
      q(c, "select challenge from public.account_deletion_requests where user_id = $1", [a.id]),
    ),
    tx(isAuthed(a), (c) =>
      q(c, "select challenge from public.account_deletion_requests where user_id = $1", [a.id]),
    ),
  ]);
  const deletes = await Promise.all(
    [0, 1].map(async () => {
      await jitter(rng);
      return tx(OWNER, (c) =>
        c
          .query("delete from auth.users where id = $1", [a.id])
          .then((x) => [{ rowCount: x.rowCount }]),
      );
    }),
  );
  const stale = await tx(isAuthed(a), (c) => q(c, REARM_SQL, [a.id, rng.uuid()]));
  const staleRead = await tx(isAuthed(a), (c) =>
    q(c, "select count(*)::int as n from public.account_deletion_requests"),
  );
  const counts = deletes.filter((r) => r.ok).map((r) => r.rows[0].rowCount);
  const checks = [
    noPathologies([...reads, ...deletes], new Set()),
    {
      name: "both devices read the same live challenge",
      pass:
        reads.every((r) => r.ok && r.rows.length === 1) &&
        reads[0].rows[0]?.challenge === reads[1].rows[0]?.challenge,
    },
    {
      name: "exactly one delete removed the row (1 + 0)",
      pass: counts.length === 2 && counts.reduce((s, n) => s + n, 0) === 1,
      detail: counts,
    },
    {
      name: "stale-bearer re-arm after deletion fails closed (23503)",
      pass: !stale.ok && stale.error.code === "23503",
      detail: stale.ok ? "accepted" : stale.error.code,
    },
    {
      name: "stale bearer sees no request rows",
      pass: staleRead.ok && staleRead.rows[0].n === 0,
      detail: staleRead.rows?.[0],
    },
  ];
  return { checks, observations: {}, sqlstates: tally([...reads, ...deletes, stale]) };
}

// S7 — clock-skew probe: the request row's timing columns are client-writable
// (INSERT + column UPDATE grant) and the database bounds none of them. The
// edge fn derives "expired" and the 3s minimum age from these columns.
async function clock_skew_probe(rng, users) {
  const { a } = users;
  const pastDays = rng.int(1, 3650);
  const futureYears = rng.int(1, 900);
  const r = await tx(isAuthed(a), (c) =>
    q(
      c,
      `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
       values ($1, $2, now() - make_interval(days => $3), now() + make_interval(years => $4))
       on conflict (user_id) do update
         set user_id = excluded.user_id, challenge = excluded.challenge,
             created_at = excluded.created_at, expires_at = excluded.expires_at
       returning created_at, expires_at, expires_at - created_at as ttl`,
      [a.id, rng.uuid(), pastDays, futureYears],
    ),
  );
  const inverted = await tx(isAuthed(a), (c) =>
    q(
      c,
      `update public.account_deletion_requests set expires_at = created_at - interval '1 hour'
        where user_id = $1 returning expires_at < created_at as inverted`,
      [a.id],
    ),
  );
  const checks = [
    noPathologies([r, inverted], new Set()),
    // Documented observation, not a pass/fail invariant of the schema: the
    // harness records what the database accepts so the finding is replayable.
    {
      name: "probe executed",
      pass: r.ok && inverted.ok,
      detail: { accepted: r.ok, ttl: r.rows?.[0]?.ttl, inverted: inverted.rows?.[0]?.inverted },
    },
  ];
  return {
    checks,
    observations: {
      unboundedExpiryAccepted: r.ok,
      backdatedCreatedAtAccepted: r.ok,
      expiresBeforeCreatedAccepted: inverted.ok && inverted.rows[0]?.inverted === true,
      pastDays,
      futureYears,
    },
    sqlstates: tally([r, inverted]),
  };
}

// S8 — survey duplicate burst: the same user files the exit survey N times in
// parallel (double-tap / retry). The schema has no per-user uniqueness, so
// every row lands; verify append-only + owner-pinned + write-only hold under
// the burst, and record the duplicate count as an observation.
async function survey_burst(rng, users) {
  const { a, b } = users;
  const n = rng.int(2, 6);
  const tag = `dup-${rng.seed}-${RUN_ID}`;
  const results = await Promise.all([
    ...Array.from({ length: n }, async (_, i) => {
      await jitter(rng);
      return tx(isAuthed(a), (c) =>
        c
          .query(
            "insert into public.account_deletion_feedback (user_id, reason, details) values ($1, 'other', $2)",
            [a.id, `${tag}#${i}`],
          )
          .then((x) => [{ rowCount: x.rowCount }]),
      );
    }),
    tx(isAuthed(a), (c) => q(c, "select id from public.account_deletion_feedback")).then((r) => ({
      ...r,
      kind: "owner_read",
    })),
    tx(isAuthed(b), (c) =>
      c.query(
        "insert into public.account_deletion_feedback (user_id, reason) values ($1, 'other')",
        [a.id],
      ),
    ).then((r) => ({ ...r, kind: "cross_insert" })),
    tx(isAuthed(a), (c) =>
      c.query(
        "insert into public.account_deletion_feedback (user_id, reason) values (null, 'other')",
      ),
    ).then((r) => ({ ...r, kind: "anon_insert" })),
    tx(isAuthed(a), (c) =>
      c
        .query(
          "update public.account_deletion_feedback set reason = 'privacy' where user_id = $1",
          [a.id],
        )
        .then((x) => [{ rowCount: x.rowCount }]),
    ).then((r) => ({ ...r, kind: "update" })),
    tx(OWNER, (c) =>
      c
        .query("delete from public.account_deletion_feedback where details like $1", [`${tag}#%`])
        .then((x) => [{ rowCount: x.rowCount }]),
    ).then((r) => ({ ...r, kind: "owner_delete" })),
  ]);
  const inserts = results.slice(0, n);
  const guarded = results.slice(n);
  // After the burst every row is committed, so this DELETE must reach the
  // append-only trigger (the concurrent one above may legitimately match 0 rows).
  const lateDelete = await tx(OWNER, (c) =>
    c
      .query("delete from public.account_deletion_feedback where details like $1", [`${tag}#%`])
      .then((x) => [{ rowCount: x.rowCount }]),
  );
  const count = await tx(OWNER, (c) =>
    q(c, "select count(*)::int as n from public.account_deletion_feedback where details like $1", [
      `${tag}#%`,
    ]),
  );
  const checks = [
    noPathologies(inserts, new Set()),
    {
      name: "every owner survey insert succeeds",
      pass: inserts.every((r) => r.ok),
      detail: tally(inserts),
    },
    {
      name: "stored rows == inserts (duplicates are not deduplicated by the schema)",
      pass: count.ok && count.rows[0].n === n,
      detail: count.rows?.[0],
    },
    {
      name: "owner cannot read back (42501)",
      pass: guarded
        .filter((g) => g.kind === "owner_read")
        .every((g) => !g.ok && g.error.code === "42501"),
    },
    {
      name: "cross-user / anonymous inserts denied (42501)",
      pass: guarded
        .filter((g) => g.kind === "cross_insert" || g.kind === "anon_insert")
        .every((g) => !g.ok && g.error.code === "42501"),
      detail: tally(guarded),
    },
    {
      name: "client UPDATE denied (42501)",
      pass: guarded
        .filter((g) => g.kind === "update")
        .every((g) => !g.ok && g.error.code === "42501"),
    },
    {
      name: "concurrent owner-plane DELETE either matched nothing or was trigger-blocked (42501)",
      pass: guarded
        .filter((g) => g.kind === "owner_delete")
        .every((g) => (g.ok && g.rows[0].rowCount === 0) || (!g.ok && g.error.code === "42501")),
      detail: guarded
        .filter((g) => g.kind === "owner_delete")
        .map((g) => (g.ok ? `ok:${g.rows[0].rowCount}` : g.error.code)),
    },
    {
      name: "post-burst owner-plane DELETE trigger-blocked (42501), rows survive",
      pass:
        !lateDelete.ok && lateDelete.error.code === "42501" && count.ok && count.rows[0].n === n,
      detail: lateDelete.ok ? `ok:${lateDelete.rows[0].rowCount}` : lateDelete.error.code,
    },
  ];
  return {
    checks,
    observations: { duplicateSurveyRows: count.rows?.[0]?.n },
    sqlstates: tally(results),
  };
}

const SCENARIOS = {
  request_rearm_burst,
  request_two_actors,
  consent_burst,
  request_vs_delete,
  external_credentials_race,
  double_confirm,
  clock_skew_probe,
  survey_burst,
};

// ───────────────────────────── driver ────────────────────────────────────
async function runIteration(seed, forcedScenario) {
  const rng = new Rng(seed);
  const names = Object.keys(SCENARIOS);
  // Always consume the pick so a forced scenario replays the same RNG stream.
  const picked = rng.pick(names);
  const scenario = forcedScenario ?? picked;
  const started = performance.now();
  const retriesBefore = stats.serializationRetries;
  const users = {
    a: await createUser(rng, rng.pick(["apple", "google"]), "alice"),
    b: await createUser(rng, rng.pick(["apple", "google"]), "bob"),
  };
  let result;
  let harnessError = null;
  const timer = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`iteration exceeded ${ITERATION_WALL_MS}ms (possible deadlock/hang)`)),
      ITERATION_WALL_MS,
    ).unref(),
  );
  try {
    result = await Promise.race([SCENARIOS[scenario](rng, users), timer]);
  } catch (error) {
    harnessError = String(error?.message ?? error);
    result = {
      checks: [{ name: "scenario completed", pass: false, detail: harnessError }],
      observations: {},
      sqlstates: {},
    };
  }
  result.checks.push(await verifyNoOrphans([users.a.id, users.b.id]));
  const durationMs = Math.round(performance.now() - started);
  // cleanup (users may already be gone)
  await destroyUsers([users.a.id, users.b.id]);
  const failed = result.checks.filter((c) => !c.pass);
  return {
    seed,
    scenario,
    isolation: ISOLATION,
    outcome: failed.length === 0 ? "HELD" : "BROKEN",
    durationMs,
    serializationRetries: stats.serializationRetries - retriesBefore,
    users: { a: users.a.id, b: users.b.id },
    failedChecks: failed,
    checks: result.checks.length,
    observations: result.observations,
    sqlstates: result.sqlstates,
    harnessError,
  };
}

async function main() {
  if (ONLY && !SCENARIOS[ONLY]) {
    console.error(`unknown scenario ${ONLY}; known: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(2);
  }
  await pool.open();
  const seeds = REPLAY.length
    ? REPLAY
    : Array.from({ length: ITER }, (_, i) => iterationSeed(MASTER_SEED, i));
  const iterations = [];
  const t0 = performance.now();
  for (const seed of seeds) {
    const it = await runIteration(seed, ONLY || undefined);
    iterations.push(it);
    if (it.outcome === "BROKEN") {
      console.error(`BROKEN seed=${seed} scenario=${it.scenario}`, JSON.stringify(it.failedChecks));
    }
  }
  await pool.close();
  const byScenario = {};
  for (const it of iterations) {
    const s = (byScenario[it.scenario] ??= {
      held: 0,
      broken: 0,
      maxMs: 0,
      serializationRetries: 0,
      sqlstates: {},
      observations: {},
    });
    s[it.outcome === "HELD" ? "held" : "broken"]++;
    s.maxMs = Math.max(s.maxMs, it.durationMs);
    s.serializationRetries += it.serializationRetries;
    for (const [k, v] of Object.entries(it.sqlstates)) s.sqlstates[k] = (s.sqlstates[k] ?? 0) + v;
    for (const [k, v] of Object.entries(it.observations)) {
      if (typeof v === "boolean") {
        s.observations[k] ??= { true: 0, false: 0 };
        s.observations[k][v]++;
      }
    }
  }
  const summary = {
    config: {
      DB_URL: DB_URL.replace(/:[^:@/]+@/, ":***@"),
      ITER,
      MASTER_SEED,
      ISOLATION,
      POOL_SIZE,
      REPLAY,
      ONLY,
    },
    executed: iterations.length,
    held: iterations.filter((i) => i.outcome === "HELD").length,
    broken: iterations.filter((i) => i.outcome === "BROKEN").length,
    brokenSeeds: iterations
      .filter((i) => i.outcome === "BROKEN")
      .map((i) => ({ seed: i.seed, scenario: i.scenario })),
    wallMs: Math.round(performance.now() - t0),
    serializationRetries: stats.serializationRetries,
    byScenario,
    iterations,
  };
  const text = JSON.stringify(summary, null, 2);
  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, text);
  }
  const { iterations: _omit, ...head } = summary;
  console.log(JSON.stringify(head, null, 2));
  process.exit(summary.broken === 0 && summary.executed === seeds.length ? 0 : 1);
}

main().catch((error) => {
  console.error("harness error:", error);
  process.exit(2);
});
