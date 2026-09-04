#!/usr/bin/env node
/**
 * Boundary / malformed-input stress harness for the profiles + onboarding
 * unit: public.profiles, handle_new_user(), handle_user_email_updated(),
 * set_updated_at(), complete_onboarding() and the profiles RLS/column grants.
 *
 *   ./pg_up.sh                                  # prints STRESS_PG_URL
 *   STRESS_PG_URL=postgres://postgres:x@127.0.0.1:5499/postgres \
 *   STRESS_ITER=3000 STRESS_SEED=20260904 STRESS_OUT=/tmp/stress \
 *     node boundary_malformed.mjs
 *
 * Every iteration derives its own PRNG from (STRESS_SEED, iteration), so a
 * single iteration replays with STRESS_ONLY_ITER=<n>. Results are written as
 * a JSON table (<STRESS_OUT>/results.json: one row per iteration) plus a
 * summary (<STRESS_OUT>/summary.json). Exit code 1 when any iteration is
 * BROKEN, 2 on a harness/setup error.
 *
 * Oracle: every generated input must end in exactly one of
 *   accepted  — the write happened AND the row reflects it AND every
 *               invariant below still holds;
 *   rejected  — a TYPED SQLSTATE from the allowed set, nothing written.
 * Anything else (untyped error, internal error, deadlock, a write that the
 * constraints say must not exist, cross-row contamination) is BROKEN.
 *
 * Invariants checked after every iteration:
 *   I1 exactly one public.profiles row per auth.users row (and none orphaned)
 *   I2 profiles.email == auth.users.email for every user
 *   I3 the other user's row is byte-for-byte unchanged
 *   I4 profiles.updated_at >= created_at and never moves backwards
 *   I5 every stored text obeys the declared caps / enums
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const here = dirname(fileURLToPath(import.meta.url));
// pg is a dependency of @pickle/database; resolve it from there so this file
// needs no package.json of its own.
const require = createRequire(resolve(here, "../../../packages/database/package.json"));
const { Client } = require("pg");

const PG_URL = process.env.STRESS_PG_URL ?? "";
const ITER = Number(process.env.STRESS_ITER ?? "200");
const SEED = Number(process.env.STRESS_SEED ?? "20260904");
const ONLY = process.env.STRESS_ONLY_ITER ? Number(process.env.STRESS_ONLY_ITER) : null;
const OUT = process.env.STRESS_OUT ?? join(here, "out");
const PAR_LANES = Number(process.env.STRESS_PAR_LANES ?? "8");
const PAR_ROUNDS = Number(process.env.STRESS_PAR_ROUNDS ?? (ITER >= 1000 ? "20" : "3"));

if (!PG_URL) {
  console.error("STRESS_PG_URL is required (run ./pg_up.sh)");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — one stream per iteration.
// ---------------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash32(a, b) {
  let h = 2166136261 ^ a;
  h = Math.imul(h ^ b, 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}
class Rng {
  constructor(seed) {
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
  uuid() {
    const h = () => this.int(0, 0xffff).toString(16).padStart(4, "0");
    return `${h()}${h()}-${h()}-4${h().slice(1)}-${(0x8000 | this.int(0, 0x3fff)).toString(
      16,
    )}-${h()}${h()}${h()}`;
  }
}

// ---------------------------------------------------------------------------
// Schema oracle (declared caps in 20260831160000 / 20260831000000 /
// 20260830120000 / 20260829120000). length() counts code points.
// ---------------------------------------------------------------------------
const CAPS = {
  email: 320,
  display_name: 200,
  avatar_url: 2048,
  provider: 50,
  skill_level: 100,
  focus_checkpoint: 100,
  primary_goal: 200,
  biggest_problem: 500,
  first_name: 80,
};
const ENUMS = {
  gender: ["female", "male", "nonbinary", "prefer_not_to_say"],
  handedness: ["right", "left"],
  onboarding_state: ["pending", "complete"],
};
const GRANTED = [
  "provider",
  "onboarding_state",
  "skill_level",
  "focus_checkpoint",
  "handedness",
  "primary_goal",
  "biggest_problem",
  "first_name",
  "gender",
];
const FORBIDDEN = ["id", "email", "display_name", "avatar_url", "created_at", "updated_at"];
const NOT_NULL = new Set(["provider", "onboarding_state"]);

const cp = (s) => (s === null ? 0 : [...s].length);
const hasNul = (s) => s !== null && s.includes("\u0000");
// node-pg encodes lone surrogates as U+FFFD (valid UTF-8), so they reach the
// server as ordinary characters; the oracle sees the same thing.
const norm = (s) =>
  s === null
    ? null
    : s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/g, (m) =>
        m.replace(/[\ud800-\udfff]/g, "\ufffd"),
      );

/** What the database must do with `value` written to `col`. */
function expectFor(col, value) {
  if (value === null) return NOT_NULL.has(col) ? "23502" : "accept";
  if (hasNul(value)) return "22021";
  if (col in ENUMS) return ENUMS[col].includes(value) ? "accept" : "23514";
  if (col in CAPS) return cp(value) <= CAPS[col] ? "accept" : "23514";
  return "accept";
}

// ---------------------------------------------------------------------------
// Hostile value generators
// ---------------------------------------------------------------------------
const BIG = 64 * 1024;
const UNICODE_PAIRS = [
  ["\u00c5", "A\u030a"], // Å precomposed vs decomposed
  ["\u212b", "\u00c5"], // Angstrom sign vs Å
  ["\ufb01", "fi"], // ligature
  ["\uff21", "A"], // fullwidth
  ["e\u0301", "\u00e9"],
  ["\u1e9b\u0323", "\u1e69"],
];
const PATHY = [
  "../../etc/passwd",
  "..\\..\\windows\\system32",
  "%2e%2e%2f%2e%2e%2f",
  "/../../../../",
  "file:///etc/passwd",
  "\\\\?\\C:\\",
];
const NUMERICY = [
  "NaN",
  "Infinity",
  "-Infinity",
  "-0",
  "1e400",
  "9223372036854775808",
  "0x1F",
  "1_000",
  "١٢٣",
  "0.1e-400",
];
const JSONY = [
  '{"__proto__":{"admin":true}}',
  '{"constructor":{"prototype":{}}}',
  "[]",
  "{}",
  "null",
  "undefined",
  "true",
];
const CONTROL = [
  "\u0001",
  "\u001f",
  "\u007f",
  "\u200b",
  "\u200e",
  "\u202e",
  "\ufeff",
  "\u2028",
  "\r\n",
  "\t",
];
const SQLY = [
  "'; drop table public.profiles; --",
  '" or 1=1 --',
  "$$; select 1; $$",
  "\\x00",
  "E'\\\\0'",
];

function hostileString(rng, cap) {
  const kind = rng.int(0, 21);
  switch (kind) {
    case 0:
      return "";
    case 1:
      return " ".repeat(rng.int(1, 8));
    case 2:
      return "a".repeat(cap);
    case 3:
      return "a".repeat(cap + 1);
    case 4:
      return "a".repeat(Math.max(0, cap - 1));
    case 5:
      return "a".repeat(BIG + rng.int(0, 1024));
    case 6:
      return "\u20ac".repeat(cap); // 3-byte chars exactly at the cap
    case 7:
      return "\u{1f600}".repeat(cap); // astral (2 UTF-16 units each)
    case 8:
      return "\u{1f600}".repeat(cap + 1);
    case 9:
      return "e\u0301".repeat(Math.ceil(cap / 2) + rng.int(0, 1)); // NFD pairs straddling the cap
    case 10:
      return "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}".repeat(
        rng.int(1, Math.ceil(cap / 7) + 1),
      ); // ZWJ family
    case 11:
      return "\u{1f1fa}\u{1f1f8}".repeat(rng.int(1, Math.ceil(cap / 2) + 1)); // flag pairs
    case 12: {
      const base = "abc".repeat(rng.int(0, 5));
      const at = rng.int(0, base.length);
      return base.slice(0, at) + "\u0000" + base.slice(at);
    }
    case 13:
      return rng.pick(CONTROL) + "x" + rng.pick(CONTROL);
    case 14:
      return rng.pick(PATHY);
    case 15:
      return rng.pick(NUMERICY);
    case 16:
      return rng.pick(JSONY);
    case 17:
      return rng.pick(SQLY);
    case 18:
      return rng.pick(rng.pick(UNICODE_PAIRS));
    case 19:
      return "\ud83d"; // lone high surrogate
    case 20:
      return "\u{10ffff}".repeat(rng.int(1, 3));
    default: {
      const n = rng.int(1, 12);
      let s = "";
      for (let i = 0; i < n; i++) s += String.fromCodePoint(rng.int(0x20, 0x2fa1d));
      return s.replace(/[\ud800-\udfff]/g, "x");
    }
  }
}

function enumHostile(rng, col) {
  const valid = ENUMS[col];
  const v = rng.pick(valid);
  return rng.pick([
    v,
    v.toUpperCase(),
    v[0].toUpperCase() + v.slice(1),
    ` ${v}`,
    `${v} `,
    `${v}\u0000`,
    `${v}\u200b`,
    "",
    "unknown",
    "other",
    rng.pick(NUMERICY),
    rng.pick(JSONY),
    hostileString(rng, 20),
  ]);
}

function hostileEmail(rng) {
  const k = rng.int(0, 12);
  switch (k) {
    case 0:
      return `${"a".repeat(310)}@x.io`; // 315 chars: under cap
    case 1:
      return `${"a".repeat(315)}@x.io`; // 320: at cap
    case 2:
      return `${"a".repeat(316)}@x.io`; // 321: over cap
    case 3:
      return `${"a".repeat(BIG)}@x.io`;
    case 4:
      return "";
    case 5:
      return null;
    case 6:
      return `nul\u0000@x.io`;
    case 7:
      return "Ünïcødé@bücher.example";
    case 8:
      return `${rng.pick(rng.pick(UNICODE_PAIRS))}@x.io`;
    case 9:
      return rng.pick(PATHY);
    case 10:
      return `${rng.pick(SQLY)}@x.io`;
    case 11:
      return `${rng.pick(CONTROL)}@x.io`;
    default:
      return `u${rng.int(0, 1e9)}@example.com`;
  }
}

/** raw_user_meta_data / raw_app_meta_data variants. Returns {text, kind}
 * where text is what gets cast to jsonb, kind says whether the cast itself
 * must fail. */
function hostileJson(rng, keys) {
  const k = rng.int(0, 16);
  const obj = {};
  const val = () => {
    const t = rng.int(0, 8);
    if (t === 0) return hostileString(rng, 200);
    if (t === 1) return rng.int(-1e9, 1e9);
    if (t === 2) return rng.bool();
    if (t === 3) return null;
    if (t === 4) return [];
    if (t === 5) return {};
    if (t === 6) return [hostileString(rng, 10)];
    if (t === 7) return { nested: hostileString(rng, 10) };
    return rng.int(0, 9);
  };
  switch (k) {
    case 0:
      return { text: "{}", castOk: true };
    case 1:
      return { text: "null", castOk: true };
    case 2:
      return { text: "[]", castOk: true };
    case 3:
      return { text: '"just a string"', castOk: true };
    case 4:
      return { text: "42", castOk: true };
    case 5:
      return { text: '{"full_name":"Al', castOk: false }; // truncated
    case 6:
      return { text: '{"full_name": NaN}', castOk: false };
    case 7:
      return { text: '{"full_name": Infinity}', castOk: false };
    case 8:
      return { text: '{"full_name":"a\\u0000b"}', castOk: false, castCode: "22P05" }; // \u0000 unsupported in jsonb
    case 9:
      return { text: '{"n": 1e400}', castOk: true }; // numeric is arbitrary precision
    case 10:
      return { text: '{"n": -0}', castOk: true };
    case 11:
      return { text: '{"full_name":"A","full_name":"B"}', castOk: true }; // duplicate key, last wins
    case 12:
      return {
        text: '{"__proto__":{"full_name":"evil"},"constructor":{"prototype":{}}}',
        castOk: true,
      };
    case 13:
      return { text: '{"schema_version": 99, "full_name": "Future"}', castOk: true };
    case 14: {
      for (const key of keys) if (rng.bool(0.7)) obj[key] = val();
      const text = JSON.stringify(obj);
      // JSON.stringify escapes NUL and lone surrogates; jsonb refuses both
      // (\u0000 → 22P05 untranslatable, lone surrogate → 22P02 bad json).
      if (text.includes("\\u0000")) return { text, castOk: false, castCode: "22P05" };
      if (/\\ud[89a-f][0-9a-f]{2}/i.test(text)) return { text, castOk: false, castCode: "22P02" };
      return { text, castOk: true };
    }
    case 15: {
      // Provider-shaped payload with over/under-cap strings.
      const nameLen = rng.pick([0, 1, 199, 200, 201, 500, BIG]);
      const urlLen = rng.pick([0, 10, 2047, 2048, 2049, BIG]);
      obj.full_name = nameLen ? "N".repeat(nameLen) : undefined;
      obj.name = rng.bool() ? "fallback" : undefined;
      obj.avatar_url = urlLen ? `https://x/${"p".repeat(Math.max(0, urlLen - 10))}` : undefined;
      return { text: JSON.stringify(obj), castOk: true };
    }
    default: {
      const provLen = rng.pick([0, 1, 5, 49, 50, 51, 500]);
      obj.provider = provLen ? "p".repeat(provLen) : rng.pick([null, 123, true, {}, []]);
      return { text: JSON.stringify(obj), castOk: true };
    }
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
const TYPED_REJECT = new Set([
  "22021", // character_not_in_repertoire (NUL byte / bad UTF-8)
  "22P02", // invalid_text_representation (bad uuid / bad json)
  "23502", // not_null_violation
  "23503", // foreign_key_violation
  "23505", // unique_violation
  "23514", // check_violation
  "42501", // insufficient_privilege
  "42703", // undefined_column
  "40001", // serialization_failure (only accepted under SERIALIZABLE)
  "22023", // invalid_parameter_value
  "54000", // program_limit_exceeded
  "22001", // string_data_right_truncation
  "22P05", // untranslatable_character (\u0000 inside a jsonb string)
  "0A000", // feature_not_supported (trigger function called directly)
]);
const matches = (expected, code) =>
  Array.isArray(expected) ? expected.includes(code) : expected === code;

async function connect() {
  const c = new Client({ connectionString: PG_URL });
  await c.connect();
  return c;
}

const USER_A = "00000000-0000-4000-8000-00000000000a";
const USER_B = "00000000-0000-4000-8000-00000000000b";

async function resetFixture(db) {
  // The stress database is disposable: drop every user a previous campaign
  // left behind so a replay with the same seed regenerates the same ids
  // without colliding on users_pkey.
  await db.query("delete from auth.users");
  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
       ($1, 'alice@example.com', '{"full_name":"Alice"}', '{"provider":"google"}'),
       ($2, 'bob@example.com',   '{"full_name":"Bob"}',   '{"provider":"apple"}')`,
    [USER_A, USER_B],
  );
  await db.query(
    `insert into auth.identities (provider, provider_id, user_id, identity_data) values
       ('google', 'google-sub-alice', $1, '{"sub":"google-sub-alice","email":"alice@example.com"}'),
       ('apple',  'apple-sub-bob',    $2, '{"sub":"apple-sub-bob","email":"bob@example.com"}')`,
    [USER_A, USER_B],
  );
}

async function snapshot(db, id) {
  const r = await db.query(
    "select row_to_json(p)::text as j from public.profiles p where id = $1",
    [id],
  );
  return r.rows[0]?.j ?? null;
}
/** Full row plus `_u`: updated_at in microseconds as a BigInt (JS Date would
 * truncate the µs that separate two back-to-back transactions). */
async function profile(db, id) {
  const r = await db.query(
    "select p.*, (extract(epoch from p.updated_at) * 1000000)::bigint::text as _u from public.profiles p where id = $1",
    [id],
  );
  if (!r.rows[0]) return null;
  r.rows[0]._u = BigInt(r.rows[0]._u);
  return r.rows[0];
}
const sameRow = (a, b) =>
  JSON.stringify({ ...a, _u: String(a._u) }) === JSON.stringify({ ...b, _u: String(b._u) });

/** Global invariants I1, I2, I5 — cheap enough to run every iteration. */
async function checkInvariants(db) {
  const bad = [];
  const orphan = await db.query(
    `select count(*)::int as n from auth.users u left join public.profiles p on p.id = u.id where p.id is null`,
  );
  if (orphan.rows[0].n !== 0) bad.push(`I1: ${orphan.rows[0].n} auth.users without a profile`);
  const stray = await db.query(
    `select count(*)::int as n from public.profiles p left join auth.users u on u.id = p.id where u.id is null`,
  );
  if (stray.rows[0].n !== 0) bad.push(`I1: ${stray.rows[0].n} profiles without an auth user`);
  const email = await db.query(
    `select count(*)::int as n from auth.users u join public.profiles p on p.id = u.id where p.email is distinct from u.email`,
  );
  if (email.rows[0].n !== 0)
    bad.push(`I2: ${email.rows[0].n} profiles whose email differs from auth.users`);
  const caps = await db.query(
    `select count(*)::int as n from public.profiles where not (
       coalesce(length(email),0) <= 320 and coalesce(length(display_name),0) <= 200
       and coalesce(length(avatar_url),0) <= 2048 and length(provider) <= 50
       and coalesce(length(skill_level),0) <= 100 and coalesce(length(focus_checkpoint),0) <= 100
       and coalesce(length(primary_goal),0) <= 200 and coalesce(length(biggest_problem),0) <= 500
       and (first_name is null or char_length(first_name) <= 80)
       and (gender is null or gender in ('female','male','nonbinary','prefer_not_to_say'))
       and (handedness is null or handedness in ('right','left'))
       and onboarding_state in ('pending','complete')
       and updated_at >= created_at)`,
  );
  if (caps.rows[0].n !== 0)
    bad.push(
      `I5: ${caps.rows[0].n} profiles rows violate declared caps/enums/updated_at>=created_at`,
    );
  return bad;
}

/** Run `fn` inside a transaction as role authenticated with the given JWT
 * subject (claimStyle: 'sub' → request.jwt.claim.sub, 'claims' →
 * request.jwt.claims JSON, 'both'). Returns {ok, rowCount, code, message}. */
async function asUser(db, role, sub, claimStyle, fn, rawClaims = null) {
  await db.query("begin");
  try {
    await db.query(`set local role ${role}`);
    if (rawClaims !== null) {
      await db.query("select set_config('request.jwt.claims', $1, true)", [rawClaims]);
    } else if (sub !== undefined) {
      if (claimStyle === "sub" || claimStyle === "both") {
        await db.query("select set_config('request.jwt.claim.sub', $1, true)", [sub]);
      }
      if (claimStyle === "claims" || claimStyle === "both") {
        await db.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub, role }),
        ]);
      }
    }
    const r = await fn(db);
    await db.query("commit");
    return { ok: true, rowCount: r?.rowCount ?? null };
  } catch (e) {
    await db.query("rollback").catch(() => {});
    return { ok: false, code: e.code ?? null, message: String(e.message).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Scenario categories
// ---------------------------------------------------------------------------
const CATEGORIES = [
  "signup_meta", // handle_new_user over hostile GoTrue metadata
  "email_update", // handle_user_email_updated
  "owner_patch", // authenticated UPDATE of a granted column (PUT /v1/me/onboarding path)
  "forbidden_column", // authenticated UPDATE of a non-granted column
  "cross_user", // authenticated UPDATE/SELECT of the other user's row
  "complete_onboarding", // the RPC under hostile JWT subjects
  "anon_probe", // anon role against every surface
  "set_updated_at", // bookkeeping trigger monotonicity
];
const WEIGHTS = [20, 12, 30, 8, 8, 12, 4, 6];

function pickCategory(rng) {
  const total = WEIGHTS.reduce((a, b) => a + b, 0);
  let x = rng.int(1, total);
  for (let i = 0; i < CATEGORIES.length; i++) {
    x -= WEIGHTS[i];
    if (x <= 0) return CATEGORIES[i];
  }
  return CATEGORIES[0];
}

const summarize = (v) => {
  if (v === null || v === undefined) return v;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const shown = s.length > 120 ? `${s.slice(0, 60)}…${s.slice(-40)}` : s;
  return { len_utf16: s.length, len_cp: cp(s), preview: JSON.stringify(shown) };
};

async function runIteration(db, iter) {
  const rng = new Rng(hash32(SEED, iter));
  const category = pickCategory(rng);
  const row = { iter, seed: hash32(SEED, iter), category, verdict: "HELD", notes: [] };
  const other = rng.bool() ? USER_A : USER_B;
  const me = other === USER_A ? USER_B : USER_A;
  const otherBefore = await snapshot(db, other);
  const meBefore = await snapshot(db, me);

  try {
    switch (category) {
      case "signup_meta": {
        const id = rng.uuid();
        const email = hostileEmail(rng);
        const meta = hostileJson(rng, ["full_name", "name", "avatar_url", "picture", "email"]);
        const app = hostileJson(rng, ["provider", "providers"]);
        row.payload = {
          id,
          email: summarize(email),
          raw_user_meta_data: summarize(meta.text),
          raw_app_meta_data: summarize(app.text),
        };
        // Oracle: compute what handle_new_user will derive. Parameters are
        // coerced in order ($2 email before $3/$4 jsonb), so a NUL byte in the
        // email is reported before a malformed metadata document.
        let expected;
        let derived = null;
        if (hasNul(email)) expected = "22021";
        else if (!meta.castOk) expected = meta.castCode ?? "22P02";
        else if (!app.castOk) expected = app.castCode ?? "22P02";
        else {
          const m = JSON.parse(meta.text);
          const a = JSON.parse(app.text);
          // jsonb ->> renders scalars exactly like JSON; objects/arrays get
          // Postgres' own spacing, so only scalars are compared for equality.
          const get = (o, k) => {
            if (o === null || typeof o !== "object" || Array.isArray(o))
              return { text: null, exact: true };
            if (!(k in o) || o[k] === null) return { text: null, exact: true };
            if (typeof o[k] === "string") return { text: o[k], exact: true };
            if (typeof o[k] === "number" || typeof o[k] === "boolean")
              return { text: String(o[k]), exact: true };
            return { text: JSON.stringify(o[k]), exact: false };
          };
          const fn = get(m, "full_name");
          const displayName = fn.text !== null ? fn : get(m, "name");
          const avatar = get(m, "avatar_url");
          const prov = get(a, "provider");
          const provider = prov.text === null ? { text: "unknown", exact: true } : prov;
          const over =
            cp(email) > CAPS.email ||
            cp(displayName.text) > CAPS.display_name ||
            cp(avatar.text) > CAPS.avatar_url ||
            cp(provider.text) > CAPS.provider;
          expected = over ? "23514" : "accept";
          derived = { displayName, avatar, provider };
          row.derived = {
            displayName: summarize(displayName.text),
            avatar: summarize(avatar.text),
            provider: summarize(provider.text),
          };
        }
        row.expected = expected;
        let res;
        try {
          const r = await db.query(
            "insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1,$2,$3::jsonb,$4::jsonb)",
            [id, email, meta.text, app.text],
          );
          res = { ok: true, rowCount: r.rowCount };
        } catch (e) {
          res = { ok: false, code: e.code ?? null, message: String(e.message).slice(0, 200) };
        }
        row.observed = res;
        const u = await db.query("select count(*)::int as n from auth.users where id = $1", [id]);
        const p = await profile(db, id);
        if (res.ok) {
          if (expected !== "accept")
            row.notes.push(`expected ${expected}, but the insert succeeded`);
          if (!p) row.notes.push("signup succeeded but no profile row was provisioned");
          else {
            if (p.email !== norm(email))
              row.notes.push("profile.email != auth.users.email at signup");
            if (derived) {
              if (derived.provider.exact && p.provider !== norm(derived.provider.text))
                row.notes.push(
                  `provider derived mismatch: ${JSON.stringify(p.provider).slice(0, 80)}`,
                );
              if (derived.displayName.exact && p.display_name !== norm(derived.displayName.text))
                row.notes.push(
                  `display_name derived mismatch: ${JSON.stringify(p.display_name).slice(0, 80)}`,
                );
              if (derived.avatar.exact && p.avatar_url !== norm(derived.avatar.text))
                row.notes.push(
                  `avatar_url derived mismatch: ${JSON.stringify(p.avatar_url).slice(0, 80)}`,
                );
            }
            if (p.onboarding_state !== "pending") row.notes.push("new profile not pending");
            if (p._u < BigInt(Math.floor((Date.now() - 600000) * 1000)))
              row.notes.push("new profile updated_at is stale");
          }
        } else {
          if (expected === "accept")
            row.notes.push(`expected accept, got ${res.code}: ${res.message}`);
          else if (!matches(expected, res.code))
            row.notes.push(`expected ${expected}, got ${res.code}: ${res.message}`);
          if (u.rows[0].n !== 0 || p)
            row.notes.push("failed signup left auth.users/profiles residue");
          if (res.code === "23514") {
            row.flag = "SIGNUP_BLOCKED_BY_PROFILE_CAP";
          }
        }
        // Cascade cleanup exercises the FK path too.
        if (res.ok && rng.bool(0.8)) {
          await db.query("delete from auth.users where id = $1", [id]);
          const left = await profile(db, id);
          if (left) row.notes.push("profile survived auth.users delete (cascade broken)");
        }
        break;
      }

      case "email_update": {
        const email = hostileEmail(rng);
        const before = await profile(db, me);
        row.payload = { user: me, email: summarize(email) };
        const expected = hasNul(email) ? "22021" : cp(email) > CAPS.email ? "23514" : "accept";
        row.expected = expected;
        let res;
        try {
          const r = await db.query("update auth.users set email = $2 where id = $1", [me, email]);
          res = { ok: true, rowCount: r.rowCount };
        } catch (e) {
          res = { ok: false, code: e.code ?? null, message: String(e.message).slice(0, 200) };
        }
        row.observed = res;
        const after = await profile(db, me);
        const authEmail = (await db.query("select email from auth.users where id = $1", [me]))
          .rows[0].email;
        if (res.ok) {
          if (expected !== "accept") row.notes.push(`expected ${expected}, but update succeeded`);
          if (after.email !== norm(email))
            row.notes.push(`profile.email not synced: ${JSON.stringify(after.email).slice(0, 60)}`);
          if (before.email !== norm(email) && !(after._u > before._u))
            row.notes.push("updated_at not bumped on email change");
          if (before.email === norm(email) && after._u !== before._u)
            row.notes.push(
              "updated_at bumped although email did not change (WHEN clause bypassed)",
            );
        } else {
          if (res.code !== expected)
            row.notes.push(`expected ${expected}, got ${res.code}: ${res.message}`);
          if (authEmail !== before.email)
            row.notes.push("auth.users.email changed although the statement failed");
          if (after.email !== before.email)
            row.notes.push("profiles.email changed although the statement failed");
          if (res.code === "23514") row.flag = "EMAIL_CHANGE_BLOCKED_BY_PROFILE_CAP";
        }
        break;
      }

      case "owner_patch": {
        const col = rng.pick(GRANTED);
        let value;
        if (col in ENUMS) value = enumHostile(rng, col);
        else if (rng.bool(0.08)) value = null;
        else value = hostileString(rng, CAPS[col]);
        const claimStyle = rng.pick(["sub", "claims", "both"]);
        const expected = expectFor(col, value);
        row.payload = { user: me, column: col, value: summarize(value), claimStyle };
        row.expected = expected;
        const before = await profile(db, me);
        const res = await asUser(db, "authenticated", me, claimStyle, (c) =>
          c.query(`update public.profiles set ${col} = $2 where id = $1`, [me, value]),
        );
        row.observed = res;
        const after = await profile(db, me);
        if (res.ok) {
          if (expected !== "accept") row.notes.push(`expected ${expected}, but update succeeded`);
          if (res.rowCount !== 1) row.notes.push(`owner update touched ${res.rowCount} rows`);
          if (after[col] !== norm(value)) row.notes.push(`stored value differs from written value`);
          if (!(after._u > before._u)) row.notes.push("set_updated_at did not advance updated_at");
          for (const k of Object.keys(before)) {
            if (
              k !== col &&
              k !== "updated_at" &&
              k !== "_u" &&
              String(before[k]) !== String(after[k])
            )
              row.notes.push(`column ${k} changed unexpectedly`);
          }
        } else {
          if (!matches(expected, res.code))
            row.notes.push(`expected ${expected}, got ${res.code}: ${res.message}`);
          if (!sameRow(before, after)) row.notes.push("row changed although the statement failed");
        }
        break;
      }

      case "forbidden_column": {
        const col = rng.pick(FORBIDDEN);
        const claimStyle = rng.pick(["sub", "claims", "both"]);
        let value;
        if (col === "id") value = rng.bool() ? other : rng.uuid();
        else if (col === "created_at" || col === "updated_at")
          value = rng.pick(["1970-01-01", "2999-12-31", "now", "-infinity", "infinity"]);
        else value = hostileString(rng, 50);
        row.payload = { user: me, column: col, value: summarize(value), claimStyle };
        // Parameter coercion (NUL byte → 22021) runs before the ACL check.
        row.expected = hasNul(value) ? "22021" : "42501";
        const res = await asUser(db, "authenticated", me, claimStyle, (c) =>
          c.query(`update public.profiles set ${col} = $2 where id = $1`, [me, value]),
        );
        row.observed = res;
        if (res.ok) row.notes.push(`non-granted column ${col} was writable by the owner`);
        else if (res.code !== row.expected)
          row.notes.push(`expected ${row.expected}, got ${res.code}: ${res.message}`);
        const after = await snapshot(db, me);
        if (after !== meBefore) row.notes.push("row changed");
        break;
      }

      case "cross_user": {
        const col = rng.pick(GRANTED);
        const value = col in ENUMS ? rng.pick(ENUMS[col]) : "x".repeat(rng.int(1, 5));
        const claimStyle = rng.pick(["sub", "claims", "both"]);
        const mode = rng.pick([
          "update_other",
          "update_all",
          "select_other",
          "delete_other",
          "insert_new",
        ]);
        row.payload = { me, other, column: col, mode, claimStyle };
        let res;
        if (mode === "update_other") {
          row.expected = "0 rows";
          res = await asUser(db, "authenticated", me, claimStyle, (c) =>
            c.query(`update public.profiles set ${col} = $2 where id = $1`, [other, value]),
          );
          if (!res.ok) row.notes.push(`unexpected error ${res.code}: ${res.message}`);
          else if (res.rowCount !== 0)
            row.notes.push(`cross-user update touched ${res.rowCount} rows`);
        } else if (mode === "update_all") {
          row.expected = "1 row (own)";
          res = await asUser(db, "authenticated", me, claimStyle, (c) =>
            c.query(`update public.profiles set ${col} = $1 where true`, [value]),
          );
          if (!res.ok) row.notes.push(`unexpected error ${res.code}: ${res.message}`);
          else if (res.rowCount !== 1)
            row.notes.push(`unfiltered update touched ${res.rowCount} rows`);
        } else if (mode === "select_other") {
          row.expected = "0 rows";
          let n = -1;
          res = await asUser(db, "authenticated", me, claimStyle, async (c) => {
            const r = await c.query(
              "select count(*)::int as n from public.profiles where id = $1 or true",
              [other],
            );
            n = r.rows[0].n;
            return r;
          });
          if (!res.ok) row.notes.push(`unexpected error ${res.code}: ${res.message}`);
          else if (n !== 1)
            row.notes.push(`authenticated saw ${n} profiles (expected exactly own row)`);
        } else if (mode === "delete_other") {
          row.expected = "42501";
          res = await asUser(db, "authenticated", me, claimStyle, (c) =>
            c.query("delete from public.profiles where id = $1 or true", [other]),
          );
          if (res.ok)
            row.notes.push(`authenticated could DELETE profiles (rowCount ${res.rowCount})`);
          else if (res.code !== "42501") row.notes.push(`expected 42501, got ${res.code}`);
        } else {
          row.expected = "42501";
          res = await asUser(db, "authenticated", me, claimStyle, (c) =>
            c.query("insert into public.profiles (id, provider) values ($1, 'x')", [rng.uuid()]),
          );
          if (res.ok) row.notes.push("authenticated could INSERT into profiles");
          else if (res.code !== "42501") row.notes.push(`expected 42501, got ${res.code}`);
        }
        row.observed = res;
        break;
      }

      case "complete_onboarding": {
        // Hostile subjects: valid own uuid, other user, unknown uuid, malformed.
        const kind = rng.int(0, 11);
        let sub,
          expected,
          rawClaims = null,
          claimStyle = rng.pick(["sub", "claims", "both"]);
        switch (kind) {
          case 0:
          case 1:
          case 2:
            sub = me;
            expected = "accept";
            break;
          case 3:
            sub = rng.uuid();
            expected = "noop";
            break;
          case 4:
            sub = "";
            expected = "noop";
            break; // nullif('') → null → 0 rows
          case 5:
            sub = `{${me}}`;
            expected = "accept";
            break; // Postgres accepts braces around a uuid
          case 6:
            sub = me.toUpperCase();
            expected = "accept";
            break;
          case 7:
            sub = rng.pick(PATHY);
            expected = "22P02";
            break;
          case 8:
            sub = rng.pick(NUMERICY);
            expected = "22P02";
            break;
          case 9:
            sub = `${me}\u0000`;
            expected = "22021";
            claimStyle = "sub";
            break;
          case 10:
            sub = "a".repeat(BIG);
            expected = "22P02";
            break;
          default:
            // Malformed claims documents: array-valued sub, truncated JSON,
            // and a document without sub at all.
            rawClaims = rng.pick([
              '{"sub": ["not","a","string"]}',
              '{"sub": "',
              '{"role":"authenticated"}',
              "[]",
              "not json",
            ]);
            sub = rawClaims;
            claimStyle = "claims";
            expected =
              rawClaims === '{"role":"authenticated"}' || rawClaims === "[]" ? "noop" : "22P02";
            break;
        }
        if (kind === 4 && claimStyle !== "sub") {
          // '' inside the claims JSON: auth.uid()'s nullif guards only the
          // claim.sub branch, so ''::uuid is attempted → 22P02.
          expected = "22P02";
        }
        // Reset own state so a successful call is observable.
        await db.query("update public.profiles set onboarding_state = 'pending' where id = $1", [
          me,
        ]);
        row.payload = { user: me, sub: summarize(sub), claimStyle };
        row.expected = expected;
        const res = await asUser(
          db,
          "authenticated",
          sub,
          claimStyle,
          (c) => c.query("select public.complete_onboarding()"),
          rawClaims,
        );
        row.observed = res;
        const after = await profile(db, me);
        const otherAfter = await profile(db, other);
        if (expected === "accept") {
          if (!res.ok) row.notes.push(`expected success, got ${res.code}: ${res.message}`);
          else if (after.onboarding_state !== "complete")
            row.notes.push("complete_onboarding did not flip own state");
          if (otherAfter.onboarding_state !== JSON.parse(otherBefore).onboarding_state)
            row.notes.push("complete_onboarding flipped the OTHER user");
        } else if (expected === "noop") {
          if (!res.ok) row.notes.push(`expected silent no-op, got ${res.code}: ${res.message}`);
          if (after.onboarding_state !== "pending")
            row.notes.push("no-op subject flipped a real user");
        } else {
          if (res.ok) row.notes.push(`expected ${expected}, but the call succeeded`);
          else if (!matches(expected, res.code))
            row.notes.push(`expected ${expected}, got ${res.code}: ${res.message}`);
          if (after.onboarding_state !== "pending")
            row.notes.push("malformed subject flipped a real user");
        }
        break;
      }

      case "anon_probe": {
        const mode = rng.pick(["select", "update", "insert", "delete", "rpc", "trigger_fn"]);
        row.payload = { mode };
        row.expected = "42501";
        const sql = {
          select: "select count(*) from public.profiles",
          update: "update public.profiles set provider = 'x'",
          insert: "insert into public.profiles (id, provider) values (gen_random_uuid(), 'x')",
          delete: "delete from public.profiles",
          rpc: "select public.complete_onboarding()",
          trigger_fn: rng.pick([
            "select public.handle_new_user()",
            "select public.handle_user_email_updated()",
            "select public.set_updated_at()",
          ]),
        }[mode];
        const res = await asUser(db, "anon", undefined, "sub", (c) => c.query(sql));
        row.observed = res;
        if (res.ok) row.notes.push(`anon could run: ${sql}`);
        else if (!matches(mode === "trigger_fn" ? ["42501", "0A000"] : "42501", res.code))
          row.notes.push(`expected 42501, got ${res.code}: ${res.message}`);
        break;
      }

      case "set_updated_at": {
        // Two updates in separate transactions: updated_at must be strictly
        // increasing; an explicit updated_at from the owner must be refused;
        // the trigger must survive a no-change UPDATE.
        const claimStyle = rng.pick(["sub", "claims", "both"]);
        row.payload = { user: me, claimStyle };
        row.expected = "monotonic";
        const t0 = (await profile(db, me))._u;
        const r1 = await asUser(db, "authenticated", me, claimStyle, (c) =>
          c.query("update public.profiles set skill_level = $2 where id = $1", [
            me,
            `lvl-${rng.int(0, 99)}`,
          ]),
        );
        const t1 = (await profile(db, me))._u;
        const r2 = await asUser(db, "authenticated", me, claimStyle, (c) =>
          c.query("update public.profiles set skill_level = skill_level where id = $1", [me]),
        );
        const t2 = (await profile(db, me))._u;
        const r3 = await asUser(db, "authenticated", me, claimStyle, (c) =>
          c.query("update public.profiles set updated_at = '1970-01-01' where id = $1", [me]),
        );
        const t3 = (await profile(db, me))._u;
        row.observed = {
          r1,
          r2,
          r3,
          t0: String(t0),
          t1: String(t1),
          t2: String(t2),
          t3: String(t3),
        };
        if (!r1.ok || !r2.ok) row.notes.push("owner update failed");
        if (!(t1 > t0)) row.notes.push("updated_at did not advance on a value change");
        if (!(t2 > t1)) row.notes.push("updated_at did not advance on a no-change UPDATE");
        if (r3.ok || r3.code !== "42501")
          row.notes.push(`owner could write updated_at directly (${r3.code})`);
        if (t3 !== t2) row.notes.push("updated_at moved after a refused write");
        break;
      }
    }
  } catch (e) {
    row.notes.push(`HARNESS: ${e.message}`);
    await db.query("rollback").catch(() => {});
  }

  // I3: the other user's row is untouched by anything above (except the
  // signup/email categories which never target it either).
  const otherAfter = await snapshot(db, other);
  if (otherAfter !== otherBefore) row.notes.push("I3: the other user's row changed");
  // I1/I2/I5.
  const inv = await checkInvariants(db);
  row.notes.push(...inv);

  if (row.notes.length) row.verdict = "BROKEN";
  return row;
}

// ---------------------------------------------------------------------------
// Parallel campaign — READ COMMITTED (and SERIALIZABLE) lanes on two users.
// ---------------------------------------------------------------------------
async function parallelRound(round, isolation) {
  const rng = new Rng(hash32(SEED ^ 0x5a5a, round));
  const lanes = [];
  for (let i = 0; i < PAR_LANES; i++) lanes.push(await connect());
  const ops = [];
  const results = [];
  try {
    await Promise.all(
      lanes.map(async (c, lane) => {
        const lr = new Rng(hash32(rng.int(0, 1e9), lane));
        const me = lr.bool() ? USER_A : USER_B;
        const op = lr.pick(["patch", "complete", "email", "signup_delete", "read"]);
        ops.push({ lane, me, op });
        const started = performance.now();
        let out;
        try {
          if (op === "patch") {
            const col = lr.pick(["skill_level", "primary_goal", "biggest_problem", "first_name"]);
            out = await asUserIso(c, isolation, me, (x) =>
              x.query(`update public.profiles set ${col} = $2 where id = $1`, [
                me,
                `r${round}-l${lane}`,
              ]),
            );
          } else if (op === "complete") {
            out = await asUserIso(c, isolation, me, (x) =>
              x.query("select public.complete_onboarding()"),
            );
          } else if (op === "email") {
            out = await superIso(c, isolation, (x) =>
              x.query("update auth.users set email = $2 where id = $1", [
                me,
                `p${round}-${lane}@example.com`,
              ]),
            );
          } else if (op === "signup_delete") {
            const id = lr.uuid();
            out = await superIso(c, isolation, async (x) => {
              await x.query(
                'insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1,$2,\'{"full_name":"T"}\',\'{"provider":"google"}\')',
                [id, `t${round}-${lane}@example.com`],
              );
              return x.query("delete from auth.users where id = $1", [id]);
            });
          } else {
            out = await asUserIso(c, isolation, me, (x) =>
              x.query("select count(*)::int as n from public.profiles"),
            );
          }
        } catch (e) {
          out = { ok: false, code: e.code ?? null, message: String(e.message).slice(0, 200) };
        }
        results.push({ lane, me, op, ms: Math.round(performance.now() - started), ...out });
      }),
    );
  } finally {
    await Promise.all(lanes.map((c) => c.end()));
  }
  const notes = [];
  for (const r of results) {
    if (!r.ok) {
      if (isolation === "serializable" && r.code === "40001") continue;
      if (r.code === "40P01") notes.push(`lane ${r.lane} ${r.op}: DEADLOCK`);
      else notes.push(`lane ${r.lane} ${r.op}: ${r.code} ${r.message}`);
    }
  }
  return { round, isolation, results, notes };
}
async function asUserIso(c, isolation, sub, fn) {
  await c.query(`begin isolation level ${isolation}`);
  try {
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub, role: "authenticated" }),
    ]);
    const r = await fn(c);
    await c.query("commit");
    return { ok: true, rowCount: r.rowCount ?? null };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    return { ok: false, code: e.code ?? null, message: String(e.message).slice(0, 200) };
  }
}
async function superIso(c, isolation, fn) {
  await c.query(`begin isolation level ${isolation}`);
  try {
    const r = await fn(c);
    await c.query("commit");
    return { ok: true, rowCount: r.rowCount ?? null };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    return { ok: false, code: e.code ?? null, message: String(e.message).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  mkdirSync(OUT, { recursive: true });
  const db = await connect();
  const started = new Date().toISOString();
  const t0 = performance.now();
  await resetFixture(db);
  const inv0 = await checkInvariants(db);
  if (inv0.length) {
    console.error("fixture invariants failed before stressing:", inv0);
    process.exit(2);
  }

  const rows = [];
  const iters = ONLY !== null ? [ONLY] : Array.from({ length: ITER }, (_, i) => i);
  for (const i of iters) {
    const r = await runIteration(db, i);
    rows.push(r);
    if (r.verdict === "BROKEN" && ONLY !== null) console.error(JSON.stringify(r, null, 2));
  }

  const parallel = [];
  let parallelOps = 0;
  if (ONLY === null) {
    await resetFixture(db);
    for (let round = 0; round < PAR_ROUNDS; round++) {
      const iso = round % 4 === 3 ? "serializable" : "read committed";
      const pr = await parallelRound(round, iso);
      parallelOps += pr.results.length;
      const inv = await checkInvariants(db);
      pr.notes.push(...inv);
      pr.verdict = pr.notes.length ? "BROKEN" : "HELD";
      parallel.push(pr);
    }
  }
  await db.end();

  const byCategory = {};
  const byFlag = {};
  const byExpected = {};
  for (const r of rows) {
    byCategory[r.category] ??= { total: 0, broken: 0 };
    byCategory[r.category].total++;
    if (r.verdict === "BROKEN") byCategory[r.category].broken++;
    if (r.flag) byFlag[r.flag] = (byFlag[r.flag] ?? 0) + 1;
    const k = `${r.category}:${r.expected}`;
    byExpected[k] = (byExpected[k] ?? 0) + 1;
  }
  const broken = rows.filter((r) => r.verdict === "BROKEN");
  const brokenParallel = parallel.filter((p) => p.verdict === "BROKEN");
  const summary = {
    started,
    finishedMs: Math.round(performance.now() - t0),
    seed: SEED,
    iterations: rows.length,
    parallel: {
      rounds: parallel.length,
      lanes: PAR_LANES,
      ops: parallelOps,
      broken: brokenParallel.length,
      serializationFailures: parallel.flatMap((p) => p.results).filter((r) => r.code === "40001")
        .length,
    },
    scenariosExecuted: rows.length + parallelOps,
    broken: broken.length,
    byCategory,
    byExpected,
    flags: byFlag,
    brokenSeeds: broken.map((r) => ({
      iter: r.iter,
      seed: r.seed,
      category: r.category,
      expected: r.expected,
      notes: r.notes,
      replay: `STRESS_SEED=${SEED} STRESS_ONLY_ITER=${r.iter} node supabase/tests/stress/boundary_malformed.mjs`,
    })),
    brokenParallelRounds: brokenParallel.map((p) => ({
      round: p.round,
      isolation: p.isolation,
      notes: p.notes,
    })),
  };
  writeFileSync(join(OUT, "results.json"), JSON.stringify(rows, null, 1));
  writeFileSync(join(OUT, "parallel.json"), JSON.stringify(parallel, null, 1));
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(broken.length || brokenParallel.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
