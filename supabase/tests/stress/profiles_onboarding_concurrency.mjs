#!/usr/bin/env node
// Seeded concurrency stress harness for the `db-profiles-onboarding` unit:
//
//   public.profiles + complete_onboarding() + handle_new_user()
//   + handle_user_email_updated() + set_updated_at()
//   (supabase/migrations/20260829000000_google_auth_bootstrap.sql,
//    20260829130000_onboarding_profile_fields.sql,
//    20260830120000_production_launch.sql §3,
//    20260831160000_defense_in_depth.sql §1/§4/§5)
//
// Drives a REAL Postgres (shim_auth.sql + every migration applied — see
// run_profiles_onboarding_stress.sh) with bursts of parallel sessions whose
// interleaving is shaped by a seeded PRNG: per-actor pre/mid-transaction
// pg_sleep()s, commit/rollback choices, isolation level, statement_timeout,
// pg_cancel_backend. Every iteration is replayable from `<scenario>:<seed>`.
//
// Client-side statements run as `set local role authenticated` with
// `request.jwt.claim.sub` / `request.jwt.claims` set, so RLS + column grants
// apply exactly as they do behind PostgREST. Owner statements model GoTrue
// (auth.users insert/update/delete) and service-role writes.
//
// Env:
//   STRESS_PG_URL   postgres://postgres:x@127.0.0.1:5499/postgres (default)
//   STRESS_ITER     iterations (default 40 — small enough for the suite;
//                   the campaign in the report used 600)
//   STRESS_SEED     base seed (default 1); iteration i uses seed base*1e6+i
//   STRESS_ONLY     comma list of scenario names to restrict the mix
//   STRESS_REPLAY   comma list of `<scenario>:<seed>` to replay exactly
//   STRESS_ISOLATION mix (default) | read_committed | serializable
//   STRESS_OUT      results JSON path (default artifacts/stress/
//                   profiles-onboarding/<utc>/results.json)
//   STRESS_STRICT   1 → P3 violations also fail the run (default: exit 1
//                   only on P0–P2 violations; P3 are reported, never hidden)
//   STRESS_POOL     max concurrent sessions (default 24; ≥ 10 required)
//
// Output: one JSON table `results[]` (seed → outcome) + `summary`. Exit 0 =
// every iteration HELD (or only P3 observations without STRESS_STRICT).

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `pg` is a dependency of @pickle/database; resolve it from there so this
// harness needs no workspace of its own.
const require = createRequire(new URL("../../../packages/database/package.json", import.meta.url));
const pg = require("pg");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

const env = process.env;
const PG_URL = env.STRESS_PG_URL ?? "postgres://postgres:x@127.0.0.1:5499/postgres";
const ITER = Number.parseInt(env.STRESS_ITER ?? "40", 10);
const BASE_SEED = Number.parseInt(env.STRESS_SEED ?? "1", 10);
const ONLY = env.STRESS_ONLY ? env.STRESS_ONLY.split(",").map((s) => s.trim()) : null;
const REPLAY = env.STRESS_REPLAY
  ? env.STRESS_REPLAY.split(",").map((pair) => {
      const [scenario, seed] = pair.trim().split(":");
      return { scenario, seed: Number.parseInt(seed, 10) };
    })
  : null;
const ISOLATION_MODE = env.STRESS_ISOLATION ?? "mix";
const STRICT = env.STRESS_STRICT === "1";
const POOL = Math.max(10, Number.parseInt(env.STRESS_POOL ?? "24", 10));
const WALL_BOUND_MS = 8000;
const OUT = resolve(
  REPO_ROOT,
  env.STRESS_OUT ??
    `artifacts/stress/profiles-onboarding/${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}/results.json`,
);

// ─── deterministic PRNG (mulberry32) ────────────────────────────────────────
class Prng {
  constructor(seed) {
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
  pick(arr) {
    return arr[this.int(0, arr.length - 1)];
  }
  chance(p) {
    return this.next() < p;
  }
  uuid() {
    const hex = () => this.int(0, 15).toString(16);
    let s = "";
    for (let i = 0; i < 32; i += 1) s += hex();
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20)}`;
  }
}

// ─── vocabulary the edge fn writes (PUT /v1/me/onboarding) ─────────────────
const SKILLS = ["beginner", "intermediate", "advanced", "competitive"];
const GOALS = ["consistency", "power", "placement", "footwork", "third_shot"];
const FOCUS = ["contact_position", "paddle_prep", "weight_transfer", "follow_through"];
const HANDS = ["right", "left"];
const GENDERS = ["female", "male", "nonbinary", "prefer_not_to_say"];
const PROVIDERS = ["apple", "google"];

function payloadFor(prng, tag) {
  const p = {
    skill_level: prng.pick(SKILLS),
    handedness: prng.pick(HANDS),
    primary_goal: prng.pick(GOALS),
    biggest_problem: `problem-${tag}-${prng.int(0, 9999)}`,
    focus_checkpoint: prng.pick(FOCUS),
  };
  if (prng.chance(0.5)) p.first_name = `Name${tag}${prng.int(0, 999)}`;
  if (prng.chance(0.5)) p.gender = prng.pick(GENDERS);
  return p;
}

const TUPLE_COLS = [
  "skill_level",
  "handedness",
  "primary_goal",
  "biggest_problem",
  "focus_checkpoint",
];
const tupleOf = (row) => TUPLE_COLS.map((c) => row[c] ?? null).join("|");
const NULL_TUPLE = TUPLE_COLS.map(() => null).join("|");

// ─── session helpers ────────────────────────────────────────────────────────
// Keep timestamptz as the server's text form: JS Date truncates to
// milliseconds, which would make two now() stamps taken microseconds apart
// compare equal and hide (or fake) updated_at regressions.
const TIMESTAMPTZ_OID = 1184;
pg.types.setTypeParser(TIMESTAMPTZ_OID, (v) => v);
const TS_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(?::?(\d{2}))?$/;
function tsMicros(text) {
  const m = TS_RE.exec(String(text));
  if (!m) throw new Error(`unparseable timestamptz: ${text}`);
  const [, y, mo, d, h, mi, s, frac = "", sign, offH, offM = "0"] = m;
  const base = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const micros = Number.parseInt(frac.padEnd(6, "0"), 10);
  const offsetMin = (sign === "-" ? -1 : 1) * (+offH * 60 + +offM);
  return BigInt(base - offsetMin * 60_000) * 1000n + BigInt(micros);
}

const pool = new pg.Pool({ connectionString: PG_URL, max: POOL });

function isolationFor(prng) {
  if (ISOLATION_MODE === "read_committed") return "read committed";
  if (ISOLATION_MODE === "serializable") return "serializable";
  return prng.chance(0.2) ? "serializable" : "read committed";
}

const claimsSql = (uid) =>
  `select set_config('request.jwt.claim.sub', $1, true),
          set_config('request.jwt.claims', $2, true)`;

async function asAuthenticated(client, uid) {
  await client.query("set local role authenticated");
  await client.query(claimsSql(uid), [uid, JSON.stringify({ sub: uid, role: "authenticated" })]);
}

async function asAnon(client) {
  await client.query("set local role anon");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one transaction as an actor. `steps` is an array of async fns
 * receiving the client; they return whatever they like (rowCount etc).
 * Returns { ok, code, message, results, retries, committed }.
 * On 40001 (serialization failure) the whole transaction is retried up to
 * 5 times — that is the documented contract for SERIALIZABLE callers.
 */
async function runTxn(spec) {
  const { isolation, preMs = 0, midMs = 0, commit = true, steps, role, uid, timeoutMs } = spec;
  const client = await pool.connect();
  let retries = 0;
  try {
    for (;;) {
      const out = { ok: true, code: null, message: null, results: [], retries, committed: false };
      try {
        await client.query(`begin isolation level ${isolation}`);
        await client.query("set local lock_timeout = '6s'");
        if (timeoutMs) await client.query(`set local statement_timeout = ${timeoutMs}`);
        if (preMs > 0) await client.query("select pg_sleep($1)", [preMs / 1000]);
        if (role === "authenticated") await asAuthenticated(client, uid);
        else if (role === "anon") await asAnon(client);
        for (const step of steps) out.results.push(await step(client));
        if (midMs > 0) await client.query("select pg_sleep($1)", [midMs / 1000]);
        if (commit) {
          await client.query("commit");
          out.committed = true;
        } else {
          await client.query("rollback");
        }
        return out;
      } catch (err) {
        await client.query("rollback").catch(() => {});
        if (err.code === "40001" && retries < 5) {
          retries += 1;
          await sleep(2 + retries * 3);
          continue;
        }
        return {
          ok: false,
          code: err.code ?? "JS",
          message: err.message,
          results: out.results,
          retries,
          committed: false,
        };
      }
    }
  } finally {
    client.release();
  }
}

async function owner(sql, params = []) {
  return pool.query(sql, params);
}

async function insertUser(client, u) {
  return client.query(
    `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
     values ($1, $2, $3::jsonb, $4::jsonb)`,
    [u.id, u.email, JSON.stringify(u.meta), JSON.stringify({ provider: u.provider })],
  );
}

async function seedUser(prng, tag) {
  const u = {
    id: prng.uuid(),
    email: `${tag}-${prng.int(0, 1e9)}@example.com`,
    provider: prng.pick(PROVIDERS),
    meta: { full_name: `${tag} User`, avatar_url: `https://img.example/${tag}.png` },
  };
  await owner(
    `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
     values ($1, $2, $3::jsonb, $4::jsonb)`,
    [u.id, u.email, JSON.stringify(u.meta), JSON.stringify({ provider: u.provider })],
  );
  return u;
}

async function readProfile(id) {
  const r = await owner("select * from public.profiles where id = $1", [id]);
  return r.rows[0] ?? null;
}
async function readUser(id) {
  const r = await owner("select id, email from auth.users where id = $1", [id]);
  return r.rows[0] ?? null;
}
async function cleanup(ids) {
  await owner("delete from auth.users where id = any($1::uuid[])", [ids]);
}

// Client-side statements (what PostgREST executes for the edge fn).
const putOnboarding = (uid, payload) => async (client) => {
  const cols = Object.keys(payload);
  const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
  const r = await client.query(
    `update public.profiles set ${sets}, onboarding_state = 'complete'
      where id = $1 returning updated_at`,
    [uid, ...cols.map((c) => payload[c])],
  );
  return { rowCount: r.rowCount, updated_at: r.rows[0]?.updated_at ?? null };
};
const completeOnboarding = () => async (client) => {
  await client.query("select public.complete_onboarding()");
  const r = await client.query("select onboarding_state from public.profiles");
  return { rowCount: r.rowCount, state: r.rows[0]?.onboarding_state ?? null };
};
const stampProvider = (uid, provider) => async (client) => {
  const r = await client.query("update public.profiles set provider = $2 where id = $1", [
    uid,
    provider,
  ]);
  return { rowCount: r.rowCount };
};
const selectOwn = () => async (client) => {
  const r = await client.query("select * from public.profiles order by id");
  return {
    rowCount: r.rowCount,
    rows: r.rows.map((row) => ({ id: row.id, tuple: tupleOf(row), state: row.onboarding_state })),
  };
};
const emailUpdate = (uid, email) => async (client) => {
  const r = await client.query("update auth.users set email = $2 where id = $1", [uid, email]);
  return { rowCount: r.rowCount };
};

// ─── violation bookkeeping ──────────────────────────────────────────────────
class Report {
  constructor() {
    this.violations = [];
    this.notes = {};
  }
  check(cond, severity, invariant, detail) {
    if (!cond) this.violations.push({ severity, invariant, detail });
  }
  note(k, v) {
    this.notes[k] = v;
  }
}

const ALLOWED_ERROR = (codes) => (r) => r.ok || codes.includes(r.code);

function checkCommonRow(rep, row, user, ctx) {
  rep.check(row !== null, "P0", "profile_exists", `profile row for ${user.id} missing`);
  if (!row) return;
  // set_updated_at() stamps now() = transaction START, so a writer that
  // began before the signup committed and then waited on it stamps a time
  // older than created_at. Nothing reads profiles.updated_at, hence P3;
  // see repro_stale_updated_at.mjs for the deterministic two-session repro.
  rep.check(
    tsMicros(row.updated_at) >= tsMicros(row.created_at),
    "P3",
    "updated_at_ge_created_at",
    `${row.updated_at} < ${row.created_at}`,
  );
  rep.check(
    ["pending", "complete"].includes(row.onboarding_state),
    "P0",
    "state_domain",
    row.onboarding_state,
  );
  if (ctx?.userRow) {
    rep.check(
      row.email === ctx.userRow.email,
      "P1",
      "email_in_sync_with_auth_users",
      `profiles.email=${row.email} auth.users.email=${ctx.userRow.email}`,
    );
  }
}

// ─── scenarios ──────────────────────────────────────────────────────────────
const scenarios = {};

/** k sessions insert the SAME auth.users id concurrently (double signup /
 * retried signup). Exactly one profile, provisioned from the committed row. */
scenarios.signup_dup = async (prng, rep) => {
  const id = prng.uuid();
  const k = prng.int(2, 4);
  const actors = [];
  for (let i = 0; i < k; i += 1) {
    const u = {
      id,
      email: `dup-${i}-${prng.int(0, 1e6)}@example.com`,
      provider: prng.pick(PROVIDERS),
      meta: prng.chance(0.5)
        ? { full_name: `Full ${i}` }
        : { name: `Short ${i}`, avatar_url: `https://a/${i}` },
    };
    actors.push({
      u,
      run: runTxn({
        isolation: isolationFor(prng),
        preMs: prng.int(0, 15),
        midMs: prng.int(0, 25),
        commit: prng.chance(0.8),
        steps: [(c) => insertUser(c, u)],
      }),
    });
  }
  const results = await Promise.all(actors.map((a) => a.run));
  rep.note(
    "results",
    results.map((r) => ({ ok: r.ok, code: r.code, committed: r.committed })),
  );
  const committed = results.map((r, i) => (r.committed ? actors[i].u : null)).filter(Boolean);
  rep.check(
    committed.length <= 1,
    "P0",
    "single_signup_commit",
    `${committed.length} inserts committed for one id`,
  );
  rep.check(
    results.every(ALLOWED_ERROR(["23505"])),
    "P1",
    "only_unique_violation_errors",
    JSON.stringify(results.filter((r) => !r.ok).map((r) => r.code)),
  );
  const users = await owner("select count(*)::int as n from auth.users where id = $1", [id]);
  const profiles = await owner("select count(*)::int as n from public.profiles where id = $1", [
    id,
  ]);
  rep.check(
    users.rows[0].n === committed.length,
    "P0",
    "auth_users_count",
    `${users.rows[0].n} vs ${committed.length}`,
  );
  rep.check(
    profiles.rows[0].n === committed.length,
    "P0",
    "profiles_count_matches_users",
    `${profiles.rows[0].n} vs ${committed.length}`,
  );
  if (committed.length === 1) {
    const row = await readProfile(id);
    const u = committed[0];
    checkCommonRow(rep, row, u, { userRow: await readUser(id) });
    if (row) {
      rep.check(row.email === u.email, "P1", "provisioned_email", `${row.email} vs ${u.email}`);
      rep.check(
        row.provider === u.provider,
        "P1",
        "provisioned_provider",
        `${row.provider} vs ${u.provider}`,
      );
      const expectName = u.meta.full_name ?? u.meta.name ?? null;
      rep.check(
        row.display_name === expectName,
        "P1",
        "provisioned_display_name",
        `${row.display_name} vs ${expectName}`,
      );
      rep.check(
        row.avatar_url === (u.meta.avatar_url ?? null),
        "P2",
        "provisioned_avatar",
        `${row.avatar_url}`,
      );
      rep.check(
        row.onboarding_state === "pending",
        "P0",
        "fresh_profile_pending",
        row.onboarding_state,
      );
    }
  }
  await cleanup([id]);
};

/** One signup held open mid-transaction while pollers look for a window in
 * which auth.users and profiles disagree, and the owner races
 * complete_onboarding() against the not-yet-committed signup. */
scenarios.signup_visibility = async (prng, rep) => {
  const u = {
    id: prng.uuid(),
    email: `vis-${prng.int(0, 1e6)}@example.com`,
    provider: prng.pick(PROVIDERS),
    meta: { full_name: "Vis" },
  };
  const holdMs = prng.int(20, 80);
  let done = false;
  const observations = [];
  const poller = (async () => {
    const c = await pool.connect();
    try {
      while (!done) {
        const r = await c.query(
          `select exists(select 1 from auth.users where id = $1) as u,
                  exists(select 1 from public.profiles where id = $1) as p`,
          [u.id],
        );
        observations.push(`${r.rows[0].u ? "t" : "f"}${r.rows[0].p ? "t" : "f"}`);
      }
    } finally {
      c.release();
    }
  })();
  const authPoller = (async () => {
    const c = await pool.connect();
    const seen = [];
    try {
      while (!done) {
        await c.query("begin");
        await asAuthenticated(c, u.id);
        const r = await c.query("select id from public.profiles");
        await c.query("commit");
        seen.push(r.rowCount);
        rep.check(
          r.rows.every((row) => row.id === u.id),
          "P0",
          "rls_select_own_only",
          JSON.stringify(r.rows),
        );
      }
    } finally {
      c.release();
    }
    return seen;
  })();
  const signup = runTxn({
    isolation: isolationFor(prng),
    midMs: holdMs,
    steps: [(c) => insertUser(c, u)],
  });
  const early = runTxn({
    isolation: isolationFor(prng),
    role: "authenticated",
    uid: u.id,
    preMs: prng.int(0, holdMs + 10),
    steps: [completeOnboarding()],
  });
  const [s, e] = await Promise.all([signup, early]);
  done = true;
  const seen = await authPoller;
  await poller;
  rep.check(s.ok && s.committed, "P0", "signup_commits", `${s.code} ${s.message}`);
  rep.check(
    observations.every((o) => o === "tt" || o === "ff"),
    "P0",
    "users_and_profiles_atomically_visible",
    JSON.stringify([...new Set(observations)]),
  );
  rep.check(
    seen.every((n) => n === 0 || n === 1),
    "P0",
    "authenticated_sees_at_most_own_row",
    JSON.stringify([...new Set(seen)]),
  );
  rep.note("poll_observations", observations.length);
  rep.note("early_complete", {
    ok: e.ok,
    rowCount: e.results[0]?.rowCount ?? null,
    state: e.results[0]?.state ?? null,
  });
  const row = await readProfile(u.id);
  checkCommonRow(rep, row, u, { userRow: await readUser(u.id) });
  if (row) {
    // The follow-up SELECT inside the same transaction saw 'complete' iff the
    // UPDATE found the (committed) row; 'pending' or 0 rows means the signup
    // was still uncommitted and the write correctly hit nothing.
    const expected = e.ok && e.results[0]?.state === "complete" ? "complete" : "pending";
    rep.check(
      row.onboarding_state === expected,
      "P1",
      "complete_effect_iff_row_visible",
      `${row.onboarding_state} vs ${expected}`,
    );
  }
  await cleanup([u.id]);
};

/** The core burst: two devices of ONE user (plus GoTrue email updates) hit
 * the same profile row at once. No lost update across columns written by a
 * single statement, state ends 'complete' iff someone completed, email stays
 * in sync, bystander untouched, no deadlock. */
scenarios.onboarding_burst = async (prng, rep) => {
  const x = await seedUser(prng, "x");
  const y = await seedUser(prng, "y");
  const k = prng.int(2, 6);
  const ops = [];
  for (let i = 0; i < k; i += 1) {
    const kind = prng.pick(["put", "put", "complete", "provider", "email", "read", "read_y"]);
    const base = {
      isolation: isolationFor(prng),
      preMs: prng.int(0, 20),
      midMs: prng.int(0, 20),
      commit: prng.chance(0.9),
    };
    if (kind === "put") {
      const payload = payloadFor(prng, `b${i}`);
      ops.push({
        kind,
        payload,
        run: runTxn({
          ...base,
          role: "authenticated",
          uid: x.id,
          steps: [putOnboarding(x.id, payload)],
        }),
      });
    } else if (kind === "complete") {
      ops.push({
        kind,
        run: runTxn({ ...base, role: "authenticated", uid: x.id, steps: [completeOnboarding()] }),
      });
    } else if (kind === "provider") {
      const provider = prng.pick(PROVIDERS);
      ops.push({
        kind,
        provider,
        run: runTxn({
          ...base,
          role: "authenticated",
          uid: x.id,
          steps: [stampProvider(x.id, provider)],
        }),
      });
    } else if (kind === "email") {
      const email = prng.chance(0.15) ? null : `x-${i}-${prng.int(0, 1e6)}@example.com`;
      ops.push({ kind, email, run: runTxn({ ...base, steps: [emailUpdate(x.id, email)] }) });
    } else if (kind === "read") {
      ops.push({
        kind,
        run: runTxn({ ...base, role: "authenticated", uid: x.id, steps: [selectOwn()] }),
      });
    } else {
      ops.push({
        kind,
        run: runTxn({ ...base, role: "authenticated", uid: y.id, steps: [selectOwn()] }),
      });
    }
  }
  const results = await Promise.all(ops.map((o) => o.run));
  rep.note(
    "ops",
    ops.map((o, i) => ({
      kind: o.kind,
      ok: results[i].ok,
      code: results[i].code,
      committed: results[i].committed,
      retries: results[i].retries,
    })),
  );
  rep.check(
    results.every((r) => r.ok),
    "P1",
    "no_statement_errors",
    JSON.stringify(results.filter((r) => !r.ok).map((r) => `${r.code}:${r.message}`)),
  );
  rep.check(
    results.every((r) => r.code !== "40P01"),
    "P1",
    "no_deadlock",
    "40P01 seen",
  );
  rep.note(
    "serialization_retries",
    results.reduce((a, r) => a + r.retries, 0),
  );

  const committedPuts = ops
    .filter((o, i) => o.kind === "put" && results[i].committed)
    .map((o) => o.payload);
  const committedCompletes = ops.filter((o, i) => o.kind === "complete" && results[i].committed);
  const committedProviders = ops
    .filter((o, i) => o.kind === "provider" && results[i].committed)
    .map((o) => o.provider);
  const row = await readProfile(x.id);
  const userRow = await readUser(x.id);
  checkCommonRow(rep, row, x, { userRow });
  if (row) {
    const tuple = tupleOf(row);
    const allowedTuples = new Set([NULL_TUPLE, ...committedPuts.map((p) => tupleOf(p))]);
    rep.check(allowedTuples.has(tuple), "P0", "no_torn_write_across_put_columns", `final=${tuple}`);
    if (committedPuts.length > 0)
      rep.check(
        tuple !== NULL_TUPLE,
        "P0",
        "committed_put_not_lost",
        "row still has initial nulls",
      );
    const expectState =
      committedPuts.length + committedCompletes.length > 0 ? "complete" : "pending";
    rep.check(
      row.onboarding_state === expectState,
      "P0",
      "state_matches_committed_ops",
      `${row.onboarding_state} vs ${expectState}`,
    );
    const names = new Set([null, ...committedPuts.map((p) => p.first_name ?? null)]);
    rep.check(names.has(row.first_name), "P1", "first_name_from_committed_put", row.first_name);
    const providers = new Set([x.provider, ...committedProviders]);
    rep.check(providers.has(row.provider), "P1", "provider_from_committed_stamp", row.provider);
    const anyWrite =
      committedPuts.length + committedCompletes.length + committedProviders.length > 0 ||
      ops.some((o, i) => o.kind === "email" && results[i].committed && o.email !== x.email);
    if (anyWrite)
      rep.check(
        tsMicros(row.updated_at) > tsMicros(row.created_at),
        "P2",
        "updated_at_advances_on_write",
        `${row.updated_at} <= ${row.created_at}`,
      );
    else
      rep.check(
        tsMicros(row.updated_at) === tsMicros(row.created_at),
        "P3",
        "updated_at_untouched_without_write",
        `${row.updated_at} vs ${row.created_at}`,
      );
  }
  // Reads in flight must never see a torn tuple or someone else's row.
  ops.forEach((o, i) => {
    if (o.kind !== "read" && o.kind !== "read_y") return;
    const res = results[i].results[0];
    if (!res) return;
    const self = o.kind === "read" ? x.id : y.id;
    rep.check(
      res.rows.every((r) => r.id === self),
      "P0",
      "rls_read_own_only",
      JSON.stringify(res.rows),
    );
    if (o.kind === "read") {
      const allowed = new Set([
        NULL_TUPLE,
        ...ops.filter((p) => p.kind === "put").map((p) => tupleOf(p.payload)),
      ]);
      rep.check(
        res.rows.every((r) => allowed.has(r.tuple)),
        "P0",
        "in_flight_read_not_torn",
        JSON.stringify(res.rows),
      );
    }
  });
  const yRow = await readProfile(y.id);
  rep.check(
    yRow &&
      yRow.onboarding_state === "pending" &&
      tupleOf(yRow) === NULL_TUPLE &&
      yRow.email === y.email,
    "P0",
    "bystander_untouched",
    JSON.stringify(yRow),
  );
  await cleanup([x.id, y.id]);
};

/** Two users; Y attacks X's row through every client-reachable path while X
 * onboards. RLS + column grants must hold under concurrency. */
scenarios.cross_user_isolation = async (prng, rep) => {
  const x = await seedUser(prng, "x");
  const y = await seedUser(prng, "y");
  const xPayload = payloadFor(prng, "x");
  const attacks = [
    {
      name: "update_x_by_id",
      sql: "update public.profiles set onboarding_state = 'complete', first_name = 'Mallory' where id = $1",
      params: [x.id],
      expect: { ok: true, rowCount: 0 },
    },
    {
      name: "update_all_rows",
      sql: "update public.profiles set first_name = 'Mallory'",
      params: [],
      expect: { ok: true, rowCount: 1 },
    },
    {
      name: "select_all",
      sql: "select id from public.profiles",
      params: [],
      expect: { ok: true, rowCount: 1 },
    },
    {
      name: "update_email",
      sql: "update public.profiles set email = 'evil@example.com' where id = $1",
      params: [y.id],
      expect: { code: "42501" },
    },
    {
      name: "update_id_to_x",
      sql: "update public.profiles set id = $1 where id = $2",
      params: [x.id, y.id],
      expect: { code: "42501" },
    },
    {
      name: "update_display_name",
      sql: "update public.profiles set display_name = 'M' where id = $1",
      params: [y.id],
      expect: { code: "42501" },
    },
    {
      name: "update_created_at",
      sql: "update public.profiles set created_at = now() where id = $1",
      params: [y.id],
      expect: { code: "42501" },
    },
    {
      name: "insert_profile",
      sql: "insert into public.profiles (id) values ($1)",
      params: [prng.uuid()],
      expect: { code: "42501" },
    },
    {
      name: "delete_profile",
      sql: "delete from public.profiles where id = $1",
      params: [x.id],
      expect: { code: "42501" },
    },
    {
      name: "call_handle_new_user",
      sql: "select public.handle_new_user()",
      params: [],
      expect: { code: "42501" },
    },
    {
      name: "call_set_updated_at",
      sql: "select public.set_updated_at()",
      params: [],
      expect: { code: "42501" },
    },
    {
      name: "call_email_updated",
      sql: "select public.handle_user_email_updated()",
      params: [],
      expect: { code: "42501" },
    },
    {
      name: "update_auth_users",
      sql: "update auth.users set email = 'evil@example.com' where id = $1",
      params: [x.id],
      expect: { code: "42501" },
    },
    {
      name: "complete_own",
      sql: "select public.complete_onboarding()",
      params: [],
      expect: { ok: true },
    },
  ];
  const chosen = [];
  const n = prng.int(3, 7);
  for (let i = 0; i < n; i += 1) chosen.push(prng.pick(attacks));
  const runs = chosen.map((a) =>
    runTxn({
      isolation: isolationFor(prng),
      role: "authenticated",
      uid: y.id,
      preMs: prng.int(0, 20),
      midMs: prng.int(0, 10),
      steps: [async (c) => ({ rowCount: (await c.query(a.sql, a.params)).rowCount })],
    }),
  );
  const anonRun = runTxn({
    isolation: "read committed",
    role: "anon",
    preMs: prng.int(0, 20),
    steps: [
      async (c) => ({
        rowCount: (
          await c.query(
            prng.chance(0.5)
              ? "select id from public.profiles"
              : "select public.complete_onboarding()",
          )
        ).rowCount,
      }),
    ],
  });
  const xRun = runTxn({
    isolation: isolationFor(prng),
    role: "authenticated",
    uid: x.id,
    preMs: prng.int(0, 20),
    midMs: prng.int(0, 20),
    steps: [putOnboarding(x.id, xPayload)],
  });
  const [results, anon, xr] = await Promise.all([Promise.all(runs), anonRun, xRun]);
  rep.note(
    "attacks",
    chosen.map((a, i) => ({
      name: a.name,
      ok: results[i].ok,
      code: results[i].code,
      rowCount: results[i].results[0]?.rowCount ?? null,
    })),
  );
  chosen.forEach((a, i) => {
    const r = results[i];
    if (a.expect.code)
      rep.check(
        !r.ok && r.code === a.expect.code,
        "P0",
        `attack_denied:${a.name}`,
        `ok=${r.ok} code=${r.code} ${r.message ?? ""}`,
      );
    else {
      rep.check(r.ok, "P1", `benign_op_ok:${a.name}`, `${r.code} ${r.message}`);
      if (a.expect.rowCount !== undefined && r.ok)
        rep.check(
          r.results[0].rowCount === a.expect.rowCount,
          "P0",
          `rls_rowcount:${a.name}`,
          `${r.results[0].rowCount} vs ${a.expect.rowCount}`,
        );
    }
  });
  rep.check(!anon.ok && anon.code === "42501", "P0", "anon_denied", `${anon.code} ${anon.message}`);
  rep.check(xr.ok, "P1", "victim_put_ok", `${xr.code} ${xr.message}`);
  const xRow = await readProfile(x.id);
  const yRow = await readProfile(y.id);
  checkCommonRow(rep, xRow, x, { userRow: await readUser(x.id) });
  checkCommonRow(rep, yRow, y, { userRow: await readUser(y.id) });
  if (xRow) {
    rep.check(
      xRow.first_name !== "Mallory",
      "P0",
      "victim_first_name_not_overwritten",
      xRow.first_name,
    );
    if (xr.committed)
      rep.check(
        tupleOf(xRow) === tupleOf(xPayload) && xRow.onboarding_state === "complete",
        "P0",
        "victim_put_intact",
        tupleOf(xRow),
      );
    rep.check(
      xRow.email === x.email && xRow.display_name === "x User",
      "P0",
      "victim_identity_columns_intact",
      `${xRow.email} ${xRow.display_name}`,
    );
  }
  if (yRow) {
    const mallory = chosen.some((a, i) => a.name === "update_all_rows" && results[i].committed);
    rep.check(
      mallory ? yRow.first_name === "Mallory" : yRow.first_name === null,
      "P1",
      "attacker_own_row_effect",
      yRow.first_name,
    );
    rep.check(
      yRow.email === y.email && yRow.id === y.id,
      "P0",
      "attacker_identity_columns_intact",
      `${yRow.email}`,
    );
  }
  await cleanup([x.id, y.id]);
};

/** Account deletion racing the owner's onboarding writes: no orphan profile,
 * no error other than 0-row updates, bounded time. */
scenarios.delete_vs_onboarding = async (prng, rep) => {
  const x = await seedUser(prng, "x");
  const k = prng.int(1, 4);
  const clientOps = [];
  for (let i = 0; i < k; i += 1) {
    const kind = prng.pick(["put", "complete", "provider"]);
    const base = {
      isolation: isolationFor(prng),
      role: "authenticated",
      uid: x.id,
      preMs: prng.int(0, 30),
      midMs: prng.int(0, 30),
    };
    if (kind === "put")
      clientOps.push({
        kind,
        run: runTxn({ ...base, steps: [putOnboarding(x.id, payloadFor(prng, `d${i}`))] }),
      });
    else if (kind === "complete")
      clientOps.push({ kind, run: runTxn({ ...base, steps: [completeOnboarding()] }) });
    else
      clientOps.push({
        kind,
        run: runTxn({ ...base, steps: [stampProvider(x.id, prng.pick(PROVIDERS))] }),
      });
  }
  const del = runTxn({
    isolation: isolationFor(prng),
    preMs: prng.int(0, 30),
    midMs: prng.int(0, 20),
    steps: [
      async (c) => ({
        rowCount: (await c.query("delete from auth.users where id = $1", [x.id])).rowCount,
      }),
    ],
  });
  let done = false;
  const observations = [];
  const poller = (async () => {
    const c = await pool.connect();
    try {
      while (!done) {
        const r = await c.query(
          `select exists(select 1 from auth.users where id = $1) as u, exists(select 1 from public.profiles where id = $1) as p`,
          [x.id],
        );
        observations.push(`${r.rows[0].u ? "t" : "f"}${r.rows[0].p ? "t" : "f"}`);
      }
    } finally {
      c.release();
    }
  })();
  const [results, d] = await Promise.all([Promise.all(clientOps.map((o) => o.run)), del]);
  done = true;
  await poller;
  rep.note(
    "ops",
    clientOps.map((o, i) => ({
      kind: o.kind,
      ok: results[i].ok,
      code: results[i].code,
      rowCount: results[i].results[0]?.rowCount ?? null,
    })),
  );
  rep.note("delete", { ok: d.ok, code: d.code, rowCount: d.results[0]?.rowCount ?? null });
  rep.check(d.ok && d.results[0].rowCount === 1, "P0", "delete_succeeds", `${d.code} ${d.message}`);
  rep.check(
    results.every((r) => r.ok),
    "P1",
    "client_ops_no_errors_during_delete",
    JSON.stringify(results.filter((r) => !r.ok).map((r) => `${r.code}:${r.message}`)),
  );
  rep.check(
    results.every((r) => r.code !== "40P01"),
    "P1",
    "no_deadlock",
    "40P01",
  );
  rep.check(
    observations.every((o) => o === "tt" || o === "ff"),
    "P0",
    "no_orphan_window",
    JSON.stringify([...new Set(observations)]),
  );
  const row = await readProfile(x.id);
  const user = await readUser(x.id);
  rep.check(
    row === null && user === null,
    "P0",
    "cascade_removed_profile",
    JSON.stringify({ row, user }),
  );
};

/** Cancel-during-call: a writer holds the row while a second device's PUT
 * is cancelled (statement_timeout or pg_cancel_backend). The cancelled write
 * must leave no partial state; the retry must land intact. */
scenarios.cancel_during_call = async (prng, rep) => {
  const x = await seedUser(prng, "x");
  const a = payloadFor(prng, "hold");
  const b = payloadFor(prng, "victim");
  const holdMs = prng.int(40, 120);
  const useCancelBackend = prng.chance(0.4);
  const holder = runTxn({
    isolation: isolationFor(prng),
    role: prng.chance(0.5) ? "authenticated" : undefined,
    uid: x.id,
    midMs: holdMs,
    steps: [putOnboarding(x.id, a)],
  });
  let victimPid = null;
  const victim = runTxn({
    isolation: "read committed",
    role: "authenticated",
    uid: x.id,
    preMs: prng.int(5, 20),
    timeoutMs: useCancelBackend ? undefined : prng.int(5, 30),
    steps: [
      async (c) => {
        victimPid = (await c.query("select pg_backend_pid() as pid")).rows[0].pid;
        return { pid: victimPid };
      },
      putOnboarding(x.id, b),
    ],
  });
  const canceller = useCancelBackend
    ? (async () => {
        await sleep(prng.int(15, 35));
        if (victimPid !== null) await owner("select pg_cancel_backend($1)", [victimPid]);
        return victimPid;
      })()
    : Promise.resolve(null);
  const [h, v] = await Promise.all([holder, victim, canceller]);
  rep.note("holder", { ok: h.ok, code: h.code });
  rep.note("victim", {
    ok: v.ok,
    code: v.code,
    mode: useCancelBackend ? "pg_cancel_backend" : "statement_timeout",
  });
  rep.check(h.ok && h.committed, "P1", "holder_commits", `${h.code} ${h.message}`);
  rep.check(v.ok || v.code === "57014", "P1", "victim_only_cancel_error", `${v.code} ${v.message}`);
  const after = await readProfile(x.id);
  checkCommonRow(rep, after, x, { userRow: await readUser(x.id) });
  if (after) {
    const expected = v.committed ? tupleOf(b) : tupleOf(a);
    rep.check(
      tupleOf(after) === expected,
      "P0",
      "no_partial_write_after_cancel",
      `final=${tupleOf(after)} expected=${expected}`,
    );
    rep.check(
      after.onboarding_state === "complete",
      "P0",
      "state_complete_after_writes",
      after.onboarding_state,
    );
  }
  const retry = await runTxn({
    isolation: "read committed",
    role: "authenticated",
    uid: x.id,
    steps: [putOnboarding(x.id, b)],
  });
  rep.check(
    retry.ok && retry.committed,
    "P1",
    "retry_after_cancel_succeeds",
    `${retry.code} ${retry.message}`,
  );
  const final = await readProfile(x.id);
  if (final) rep.check(tupleOf(final) === tupleOf(b), "P0", "retry_lands_intact", tupleOf(final));
  rep.check(
    final && after && tsMicros(final.updated_at) >= tsMicros(after.updated_at),
    "P3",
    "updated_at_monotonic_after_retry",
    `${final?.updated_at} < ${after?.updated_at}`,
  );
  await cleanup([x.id]);
};

/** Clock skew between transactions: set_updated_at() stamps now() =
 * transaction START. A transaction that began earlier but writes later
 * carries the older stamp, so updated_at can move backwards. */
scenarios.clock_skew_updated_at = async (prng, rep) => {
  const x = await seedUser(prng, "x");
  const a = payloadFor(prng, "early");
  const b = payloadFor(prng, "late");
  const gapMs = prng.int(15, 60);
  const t1 = runTxn({
    isolation: isolationFor(prng),
    role: "authenticated",
    uid: x.id,
    preMs: gapMs,
    steps: [putOnboarding(x.id, a)],
  });
  const t2 = runTxn({
    isolation: "read committed",
    role: "authenticated",
    uid: x.id,
    preMs: 2,
    steps: [putOnboarding(x.id, b)],
  });
  const [r1, r2] = await Promise.all([t1, t2]);
  rep.check(r1.ok && r2.ok, "P1", "both_writes_ok", `${r1.code} ${r2.code}`);
  const final = await readProfile(x.id);
  checkCommonRow(rep, final, x, { userRow: await readUser(x.id) });
  if (final && r1.ok && r2.ok) {
    const u1 = tsMicros(r1.results[0].updated_at);
    const u2 = tsMicros(r2.results[0].updated_at);
    const t2First = u2 < u1 || (u2 === u1 && tupleOf(final) === tupleOf(a));
    rep.note("stamps", {
      t1_updated_at: r1.results[0].updated_at,
      t2_updated_at: r2.results[0].updated_at,
      final: final.updated_at,
      final_tuple: tupleOf(final) === tupleOf(a) ? "t1" : "t2",
    });
    // Whoever committed LAST owns the row content; the stamp must not be
    // older than the stamp the previous committer returned.
    const lastIsT1 = tupleOf(final) === tupleOf(a);
    const finalStamp = tsMicros(final.updated_at);
    const prevStamp = lastIsT1 ? u2 : u1;
    rep.check(
      finalStamp >= prevStamp,
      "P3",
      "updated_at_monotonic_across_commits",
      `final ${final.updated_at} < previous committer ${lastIsT1 ? r2.results[0].updated_at : r1.results[0].updated_at} (last writer ${lastIsT1 ? "t1" : "t2"}, t2First=${t2First})`,
    );
    rep.check(
      [tupleOf(a), tupleOf(b)].includes(tupleOf(final)),
      "P0",
      "final_row_is_one_payload",
      tupleOf(final),
    );
  }
  await cleanup([x.id]);
};

/** GoTrue email changes (incl. → null and back) racing client writes:
 * profiles.email must end equal to auth.users.email and the
 * WHEN (old is distinct from new) guard must not skip a real change. */
scenarios.email_sync_burst = async (prng, rep) => {
  const x = await seedUser(prng, "x");
  const k = prng.int(2, 5);
  const ops = [];
  for (let i = 0; i < k; i += 1) {
    const base = {
      isolation: isolationFor(prng),
      preMs: prng.int(0, 20),
      midMs: prng.int(0, 20),
      commit: prng.chance(0.9),
    };
    if (prng.chance(0.6)) {
      const email = prng.chance(0.2)
        ? null
        : prng.chance(0.2)
          ? x.email
          : `e-${i}-${prng.int(0, 1e6)}@example.com`;
      ops.push({
        kind: "email",
        email,
        run: runTxn({ ...base, steps: [emailUpdate(x.id, email)] }),
      });
    } else {
      ops.push({
        kind: "put",
        run: runTxn({
          ...base,
          role: "authenticated",
          uid: x.id,
          steps: [putOnboarding(x.id, payloadFor(prng, `e${i}`))],
        }),
      });
    }
  }
  const results = await Promise.all(ops.map((o) => o.run));
  rep.note(
    "ops",
    ops.map((o, i) => ({
      kind: o.kind,
      email: o.email,
      ok: results[i].ok,
      code: results[i].code,
      committed: results[i].committed,
    })),
  );
  rep.check(
    results.every((r) => r.ok),
    "P1",
    "no_statement_errors",
    JSON.stringify(results.filter((r) => !r.ok).map((r) => `${r.code}:${r.message}`)),
  );
  const row = await readProfile(x.id);
  const user = await readUser(x.id);
  checkCommonRow(rep, row, x, { userRow: user });
  if (row) {
    const emails = new Set([
      x.email,
      ...ops.filter((o, i) => o.kind === "email" && results[i].committed).map((o) => o.email),
    ]);
    rep.check(emails.has(row.email), "P1", "email_from_committed_update", row.email);
  }
  // A follow-up change must still propagate (guard not stuck).
  const finalEmail = `final-${prng.int(0, 1e6)}@example.com`;
  await owner("update auth.users set email = $2 where id = $1", [x.id, finalEmail]);
  const row2 = await readProfile(x.id);
  rep.check(row2 && row2.email === finalEmail, "P1", "email_propagates_after_burst", row2?.email);
  await cleanup([x.id]);
};

/** Token rotation / logout inside one connection: claims change between
 * statements. Writes must follow the CURRENT claims, empty claims write
 * nothing, a malformed sub fails the statement without partial effects. */
scenarios.claims_rotation = async (prng, rep) => {
  const x = await seedUser(prng, "x");
  const y = await seedUser(prng, "y");
  const py = payloadFor(prng, "y");
  const px = payloadFor(prng, "x");
  const rotated = runTxn({
    isolation: isolationFor(prng),
    role: "authenticated",
    uid: x.id,
    preMs: prng.int(0, 10),
    steps: [
      completeOnboarding(),
      async (c) => {
        await c.query(claimsSql(y.id), [y.id, JSON.stringify({ sub: y.id })]);
        return { rotated: "y" };
      },
      putOnboarding(y.id, py),
      async (c) => {
        await c.query(claimsSql(""), ["", ""]);
        const r = await c.query("select public.complete_onboarding()");
        const seen = await c.query("select count(*)::int as n from public.profiles");
        return { loggedOutRows: r.rowCount, visible: seen.rows[0].n };
      },
    ],
  });
  const concurrentX = runTxn({
    isolation: isolationFor(prng),
    role: "authenticated",
    uid: x.id,
    preMs: prng.int(0, 15),
    steps: [putOnboarding(x.id, px)],
  });
  const malformed = runTxn({
    isolation: "read committed",
    role: "authenticated",
    uid: "not-a-uuid",
    preMs: prng.int(0, 15),
    steps: [putOnboarding(x.id, payloadFor(prng, "mal"))],
  });
  const [r, cx, m] = await Promise.all([rotated, concurrentX, malformed]);
  rep.note("rotated", { ok: r.ok, code: r.code, results: r.results });
  rep.note("malformed", { ok: m.ok, code: m.code });
  rep.check(r.ok, "P1", "rotation_txn_ok", `${r.code} ${r.message}`);
  rep.check(!m.ok && m.code === "22P02", "P1", "malformed_sub_rejected", `${m.code} ${m.message}`);
  if (r.ok) {
    rep.check(
      r.results[0].rowCount === 1 && r.results[0].state === "complete",
      "P0",
      "pre_rotation_write_as_x",
      JSON.stringify(r.results[0]),
    );
    rep.check(
      r.results[2].rowCount === 1,
      "P0",
      "post_rotation_write_as_y",
      JSON.stringify(r.results[2]),
    );
    rep.check(
      r.results[3].visible === 0,
      "P0",
      "logged_out_sees_nothing",
      JSON.stringify(r.results[3]),
    );
  }
  const xRow = await readProfile(x.id);
  const yRow = await readProfile(y.id);
  checkCommonRow(rep, xRow, x, { userRow: await readUser(x.id) });
  checkCommonRow(rep, yRow, y, { userRow: await readUser(y.id) });
  if (xRow) {
    rep.check(xRow.onboarding_state === "complete", "P0", "x_complete", xRow.onboarding_state);
    const allowed = new Set([NULL_TUPLE, tupleOf(px)]);
    rep.check(
      allowed.has(tupleOf(xRow)) && (!cx.committed || tupleOf(xRow) === tupleOf(px)),
      "P0",
      "x_tuple_only_from_x",
      tupleOf(xRow),
    );
  }
  if (yRow && r.committed)
    rep.check(
      tupleOf(yRow) === tupleOf(py) && yRow.onboarding_state === "complete",
      "P0",
      "y_tuple_from_rotated_claims",
      tupleOf(yRow),
    );
  await cleanup([x.id, y.id]);
};

/** Signup with provider metadata at/over the profiles_text_bounds cap: the
 * definer trigger runs inside GoTrue's INSERT, so a CHECK failure aborts the
 * signup itself. Recorded as an observation (P3) with the exact boundary. */
scenarios.signup_metadata_bounds = async (prng, rep) => {
  const nameLen = prng.pick([200, 201, 500]);
  const avatarLen = prng.pick([2048, 2049]);
  const u = {
    id: prng.uuid(),
    email: `bounds-${prng.int(0, 1e6)}@example.com`,
    provider: prng.pick(PROVIDERS),
    meta: {
      full_name: "n".repeat(nameLen),
      avatar_url: `https://a/${"x".repeat(Math.max(0, avatarLen - 10))}`,
    },
  };
  const r = await runTxn({ isolation: "read committed", steps: [(c) => insertUser(c, u)] });
  const overCap = nameLen > 200 || avatarLen > 2048;
  rep.note("insert", { nameLen, avatarLen, ok: r.ok, code: r.code, message: r.message });
  if (overCap) {
    rep.check(
      !r.ok && r.code === "23514",
      "P3",
      "signup_rejected_by_profiles_text_bounds",
      `signup with ${nameLen}-char name / ${avatarLen}-char avatar → ok=${r.ok} code=${r.code}`,
    );
    rep.check(
      (await readUser(u.id)) === null && (await readProfile(u.id)) === null,
      "P0",
      "failed_signup_leaves_nothing",
      "partial rows",
    );
  } else {
    rep.check(r.ok, "P1", "signup_at_cap_ok", `${r.code} ${r.message}`);
    const row = await readProfile(u.id);
    rep.check(
      row && row.display_name.length === nameLen,
      "P1",
      "at_cap_name_stored",
      row?.display_name?.length,
    );
  }
  await cleanup([u.id]);
};

// Weighted mix — the concurrency lens leans on the burst/isolation scenarios.
const MIX = [
  ...Array(3).fill("onboarding_burst"),
  ...Array(2).fill("signup_dup"),
  ...Array(2).fill("cross_user_isolation"),
  ...Array(2).fill("delete_vs_onboarding"),
  ...Array(2).fill("email_sync_burst"),
  "signup_visibility",
  "cancel_during_call",
  "clock_skew_updated_at",
  "claims_rotation",
  "signup_metadata_bounds",
];

// ─── driver ─────────────────────────────────────────────────────────────────
async function preflight() {
  const r = await pool.query(
    `select
       to_regclass('public.profiles') is not null as profiles,
       to_regprocedure('public.complete_onboarding()') is not null as complete_onboarding,
       exists(select 1 from pg_trigger where tgname = 'on_auth_user_created') as t_created,
       exists(select 1 from pg_trigger where tgname = 'on_auth_user_email_updated') as t_email,
       exists(select 1 from pg_trigger where tgname = 'profiles_set_updated_at') as t_updated,
       exists(select 1 from pg_roles where rolname = 'authenticated') as role_auth,
       current_setting('server_version') as version`,
  );
  const row = r.rows[0];
  for (const k of [
    "profiles",
    "complete_onboarding",
    "t_created",
    "t_email",
    "t_updated",
    "role_auth",
  ]) {
    if (!row[k])
      throw new Error(
        `preflight: ${k} missing — apply supabase/tests/shim_auth.sql + supabase/migrations first`,
      );
  }
  return row.version;
}

async function runIteration(scenario, seed) {
  const prng = new Prng(seed);
  const rep = new Report();
  const started = Date.now();
  let error = null;
  try {
    await Promise.race([
      scenarios[scenario](prng, rep),
      sleep(WALL_BOUND_MS).then(() => {
        throw new Error(`wall bound ${WALL_BOUND_MS}ms exceeded`);
      }),
    ]);
  } catch (err) {
    error = `${err.code ?? "JS"}: ${err.message}`;
  }
  const durationMs = Date.now() - started;
  if (error)
    rep.violations.push({
      severity: "P1",
      invariant: "scenario_completes_within_bound",
      detail: error,
    });
  const worst = rep.violations.reduce((w, v) => (v.severity < w ? v.severity : w), "P9");
  const outcome = rep.violations.length === 0 ? "HELD" : "BROKEN";
  return {
    seed,
    scenario,
    replay: `${scenario}:${seed}`,
    outcome,
    worst: worst === "P9" ? null : worst,
    durationMs,
    violations: rep.violations,
    notes: rep.notes,
  };
}

async function main() {
  const version = await preflight();
  const plan = [];
  if (REPLAY) {
    for (const r of REPLAY) {
      if (!scenarios[r.scenario]) throw new Error(`unknown scenario ${r.scenario}`);
      plan.push(r);
    }
  } else {
    const mix = ONLY ? MIX.filter((s) => ONLY.includes(s)) : MIX;
    if (mix.length === 0) throw new Error(`STRESS_ONLY matched nothing: ${ONLY}`);
    for (let i = 0; i < ITER; i += 1) {
      const seed = (BASE_SEED * 1_000_000 + i) >>> 0;
      const pick = new Prng(seed ^ 0x9e3779b9).pick(mix);
      plan.push({ scenario: pick, seed });
    }
  }
  const results = [];
  const startedAt = new Date().toISOString();
  // Iterations run in small parallel waves so bursts overlap across users too.
  const WAVE = 3;
  for (let i = 0; i < plan.length; i += WAVE) {
    const wave = plan.slice(i, i + WAVE);
    const outs = await Promise.all(wave.map((p) => runIteration(p.scenario, p.seed)));
    results.push(...outs);
    for (const o of outs) {
      if (o.outcome !== "HELD")
        process.stderr.write(
          `BROKEN ${o.replay} worst=${o.worst} ${JSON.stringify(o.violations)}\n`,
        );
    }
  }
  const byScenario = {};
  for (const r of results) {
    const s = (byScenario[r.scenario] ??= {
      executed: 0,
      held: 0,
      broken: 0,
      worst: null,
      failingSeeds: [],
    });
    s.executed += 1;
    if (r.outcome === "HELD") s.held += 1;
    else {
      s.broken += 1;
      s.failingSeeds.push(r.replay);
      if (!s.worst || r.worst < s.worst) s.worst = r.worst;
    }
  }
  const violationsByInvariant = {};
  for (const r of results)
    for (const v of r.violations)
      violationsByInvariant[`${v.severity}:${v.invariant}`] =
        (violationsByInvariant[`${v.severity}:${v.invariant}`] ?? 0) + 1;
  const blocking = results.filter((r) => r.violations.some((v) => v.severity <= "P2"));
  const p3only = results.filter(
    (r) => r.outcome === "BROKEN" && r.violations.every((v) => v.severity === "P3"),
  );
  const summary = {
    unit: "db-profiles-onboarding",
    lens: "concurrency",
    startedAt,
    finishedAt: new Date().toISOString(),
    postgres: version,
    pgUrl: PG_URL.replace(/:[^:@/]+@/, ":***@"),
    baseSeed: BASE_SEED,
    isolationMode: ISOLATION_MODE,
    executed: results.length,
    held: results.filter((r) => r.outcome === "HELD").length,
    broken: results.length - results.filter((r) => r.outcome === "HELD").length,
    brokenBlocking: blocking.length,
    brokenP3Only: p3only.length,
    serializationRetries: results.reduce((a, r) => a + (r.notes.serialization_retries ?? 0), 0),
    totalWallMs: results.reduce((a, r) => a + r.durationMs, 0),
    maxIterationMs: Math.max(0, ...results.map((r) => r.durationMs)),
    byScenario,
    violationsByInvariant,
    failingSeeds: results
      .filter((r) => r.outcome !== "HELD")
      .map((r) => ({
        replay: r.replay,
        worst: r.worst,
        invariants: [...new Set(r.violations.map((v) => v.invariant))],
      })),
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ summary, results }, null, 2));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\nresults: ${OUT}\n`);
  await pool.end();
  const fail = STRICT ? summary.broken > 0 : summary.brokenBlocking > 0;
  process.exitCode = fail ? 1 : 0;
}

main().catch(async (err) => {
  process.stderr.write(`fatal: ${err.stack ?? err}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 2;
});
