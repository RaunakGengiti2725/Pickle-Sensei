#!/usr/bin/env node
// Seeded boundary/malformed-input stress harness for the service-only billing
// tables (`public.billing_entitlements`, `public.webhook_events`).
//
// Every iteration derives its own seed from STRESS_SEED + index, so any single
// outcome is replayable with `--replay <iterationSeed>`. Results are written as
// a JSON table (seed → outcome) to STRESS_OUT (default
// supabase/tests/stress/out/boundary_malformed.json).
//
//   PGURL=postgres://postgres:x@localhost:5499/postgres \
//   STRESS_ITER=3000 STRESS_SEED=20260904 node supabase/tests/stress/boundary_malformed.mjs
//
// Invariants (each iteration is classified HELD or BROKEN against them):
//   I1 no backend crash / connection loss / internal error for ANY input
//      (SQLSTATE classes 08, 53, 57, XX are forbidden; the connection must
//      answer `select 1` after every error).
//   I2 a rejected write leaves both tables byte-for-byte unchanged.
//   I3 an accepted webhook_events insert round-trips id + payload exactly and
//      adds exactly one row; the same id inserted again is 23505 on a plain
//      insert and a no-op under `on conflict (id) do nothing`.
//   I4 an accepted billing_entitlements upsert leaves exactly one row per
//      user with the submitted values; a rejected one leaves the prior row.
//   I5 from `authenticated` (set local role + request.jwt.claim.sub) a user
//      sees only their own billing row, never another user's; every write to
//      billing_entitlements and every statement against webhook_events is
//      42501 regardless of payload; `anon` is 42501 everywhere.
//   I6 concurrent sessions (READ COMMITTED and SERIALIZABLE) racing the same
//      webhook id end with exactly one row; racing billing upserts end with
//      one row per user holding one of the accepted inputs (no torn row).
//   I7 the pg_cron sweep body from 20260831000000 deletes exactly the rows
//      with received_at < now() - 90 days (boundary values included).
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
// `pg` is a workspace dependency of @pickle/database; resolve it from there so
// this harness needs no install step of its own.
const require = createRequire(resolve(repoRoot, "packages/database/package.json"));
const { Client } = require("pg");

const PGURL = process.env.PGURL ?? "postgres://postgres:x@localhost:5499/postgres";
const ITER = Number.parseInt(process.env.STRESS_ITER ?? "200", 10);
const MASTER_SEED = Number.parseInt(process.env.STRESS_SEED ?? "20260904", 10);
const OUT = process.env.STRESS_OUT ?? resolve(here, "out/boundary_malformed.json");
const CONCURRENCY = Number.parseInt(process.env.STRESS_PARALLEL ?? "8", 10);

const argv = process.argv.slice(2);
const replayIdx = argv.indexOf("--replay");
const REPLAY_SEEDS =
  replayIdx >= 0 ? argv[replayIdx + 1].split(",").map((s) => Number.parseInt(s, 10)) : null;

const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b2";
const USERS = [USER_A, USER_B];

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) + seed derivation.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function iterationSeed(master, i) {
  // splitmix-style hash of (master, i) → 31-bit positive int
  let h = (master ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (i + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) & 0x7fffffff;
}
class Rng {
  constructor(seed) {
    this.next = mulberry32(seed);
  }
  int(min, maxInclusive) {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  pick(arr) {
    return arr[this.int(0, arr.length - 1)];
  }
  chance(p) {
    return this.next() < p;
  }
}

// ---------------------------------------------------------------------------
// Input generators. Each returns { tag, value } so the JSON table records WHAT
// was generated, not just the seed.
// ---------------------------------------------------------------------------
const NORMALIZATION_PAIRS = [
  ["\u00e9", "e\u0301"], // é NFC vs NFD
  ["\u00c5", "A\u030a"], // Å
  ["\ufb01", "fi"], // ﬁ ligature (NFKC)
  ["\uac00", "\u1100\u1161"], // 가 Hangul syllable vs jamo
  ["\u2126", "\u03a9"], // OHM SIGN vs GREEK CAPITAL OMEGA
  ["\u212b", "\u00c5"], // ANGSTROM SIGN vs Å
];
const GRAPHEMES = [
  "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}", // family ZWJ (1 grapheme, 7 cp, 25 bytes)
  "\u{1F1FA}\u{1F1F8}", // flag US (2 cp)
  "\u{1F44D}\u{1F3FD}", // thumbs up + skin tone
  "a" + "\u0301".repeat(64), // one base + 64 combining marks
];
const TRAVERSAL = [
  "../../etc/passwd",
  "..\\..\\windows\\system32",
  "..%2F..%2Fetc%2Fpasswd",
  "%2e%2e/%2e%2e/",
  "/webhooks/revenuecat/../../v1/me",
  "id/../../../",
  "..;/admin",
  "\u2025\u2215etc",
];
const PROTO_KEYS = [
  "__proto__",
  "constructor",
  "prototype",
  "__defineGetter__",
  "toString",
  "hasOwnProperty",
];
const NUMERIC_TOKENS = [
  "NaN",
  "Infinity",
  "-Infinity",
  "-0",
  "0.0",
  "-0.0",
  "1e400",
  "-1e400",
  "1e-400",
  "9007199254740993",
  "18446744073709551616",
  "1e100000",
  "1e131072",
  "1e200000",
  "0x1F",
  "1_000",
  "01",
  "+1",
  ".5",
  "1.",
  "1e",
  "-",
];

function longAscii(rng, n) {
  // incompressible-ish: hex from rng so btree/TOAST cannot pglz it away
  let s = "";
  while (s.length < n) s += rng.int(0, 0xffffffff).toString(16).padStart(8, "0");
  return s.slice(0, n);
}

function genText(rng, { allowBuffer = false } = {}) {
  const k = rng.int(0, 21);
  switch (k) {
    case 0:
      return { tag: "empty", value: "" };
    case 1:
      return { tag: "plain", value: `evt_${rng.int(0, 1e9)}` };
    case 2:
      return { tag: "uuid", value: fakeUuid(rng) };
    case 3:
      return { tag: "ws_only", value: rng.pick([" ", "\t\n", "\u00a0", "\u200b", "\ufeff"]) };
    case 4:
      return { tag: "nul_in_text", value: `a${"\u0000"}b` };
    case 5:
      return { tag: "traversal", value: rng.pick(TRAVERSAL) };
    case 6: {
      const [a, b] = rng.pick(NORMALIZATION_PAIRS);
      return {
        tag: "nfc_nfd",
        value: rng.chance(0.5) ? `id-${a}` : `id-${b}`,
        pair: [`id-${a}`, `id-${b}`],
      };
    }
    case 7:
      return { tag: "grapheme", value: rng.pick(GRAPHEMES).repeat(rng.int(1, 40)) };
    case 8:
      return { tag: "str_64k", value: longAscii(rng, 65536) };
    case 9:
      return { tag: "str_64k_plus1", value: longAscii(rng, 65537) };
    case 10:
      return { tag: "str_256k", value: longAscii(rng, 262144) };
    case 11:
      return { tag: "str_2700_compressible", value: "a".repeat(2700) };
    case 12:
      return { tag: "str_2700_random", value: longAscii(rng, 2700) };
    case 13:
      return { tag: "str_2704_random", value: longAscii(rng, 2704) };
    case 14:
      return { tag: "proto_key", value: rng.pick(PROTO_KEYS) };
    case 15:
      return {
        tag: "sqlish",
        value: rng.pick([
          "'; drop table public.webhook_events; --",
          "$1",
          "%s%n",
          "{{id}}",
          "' or 1=1 --",
          "\\",
          '"',
          "`",
        ]),
      };
    case 16:
      return { tag: "lone_surrogate", value: "x\ud800y" };
    case 17:
      return { tag: "rtl_override", value: "\u202eabc\u202c" };
    case 18:
      return { tag: "control_chars", value: "\u0001\u0002\u001f\u007f" };
    case 19:
      return { tag: "numeric_token", value: rng.pick(NUMERIC_TOKENS) };
    case 20:
      if (allowBuffer)
        return { tag: "invalid_utf8_bytes", value: Buffer.from([0x61, 0xff, 0xfe, 0x62]) };
      return { tag: "plain", value: `evt_${rng.int(0, 1e9)}` };
    default:
      return { tag: "combining_heavy", value: "e" + "\u0301".repeat(rng.int(1000, 20000)) };
  }
}

function fakeUuid(rng) {
  const hex = () => rng.int(0, 15).toString(16);
  const seg = (n) => Array.from({ length: n }, hex).join("");
  return `${seg(8)}-${seg(4)}-4${seg(3)}-8${seg(3)}-${seg(12)}`;
}

function genJsonText(rng) {
  const k = rng.int(0, 24);
  const obj = () =>
    JSON.stringify({
      api_version: rng.pick(["1.0", "2.0", "99.0", 99, null, "", []]),
      event: {
        id: `evt_${rng.int(0, 1e9)}`,
        type: rng.pick(["INITIAL_PURCHASE", "RENEWAL", "TRANSFER", "unknown_future_type"]),
        app_user_id: rng.pick([USER_A, USER_B, "anon", 42]),
      },
    });
  switch (k) {
    case 0:
      return { tag: "json_object", value: obj() };
    case 1: {
      const full = obj();
      return { tag: "json_truncated", value: full.slice(0, rng.int(0, full.length - 1)) };
    }
    case 2:
      return { tag: "json_empty_string", value: "" };
    case 3:
      return { tag: "json_top_array", value: rng.pick(["[]", "[1,2,3]", "[{}]", "[[]]"]) };
    case 4:
      return {
        tag: "json_top_scalar",
        value: rng.pick(["null", "true", "false", "1", '"str"', "-0", "1e400"]),
      };
    case 5:
      return { tag: "json_empty_object", value: "{}" };
    case 6:
      return { tag: "json_numeric_token", value: `{"n":${rng.pick(NUMERIC_TOKENS)}}` };
    case 7:
      return { tag: "json_nul_escape", value: '{"event":{"id":"a\\u0000b"}}' };
    case 8:
      return { tag: "json_raw_nul", value: '{"event":{"id":"a\u0000b"}}' };
    case 9:
      return {
        tag: "json_proto_keys",
        value: `{"${rng.pick(PROTO_KEYS)}":{"polluted":true},"event":{"id":"x"}}`,
      };
    case 10:
      return { tag: "json_dup_keys", value: '{"event":{"id":"first"},"event":{"id":"second"}}' };
    case 11:
      return { tag: "json_deep_nesting", value: "[".repeat(rng.pick([100, 1000, 10000, 100000])) };
    case 12: {
      const d = rng.pick([100, 1000, 10000]);
      return { tag: "json_deep_nesting_balanced", value: "[".repeat(d) + "]".repeat(d) };
    }
    case 13:
      return { tag: "json_64k_string", value: `{"s":"${longAscii(rng, 65536)}"}` };
    case 14:
      return { tag: "json_1mb_string", value: `{"s":"${longAscii(rng, 1048576)}"}` };
    case 15:
      return { tag: "json_lone_surrogate_escape", value: '{"s":"\\ud800"}' };
    case 16:
      return { tag: "json_bom_prefix", value: "\ufeff{}" };
    case 17:
      return { tag: "json_trailing_garbage", value: "{} garbage" };
    case 18:
      return { tag: "json_single_quotes", value: "{'a':1}" };
    case 19:
      return { tag: "json_comment", value: '{/*c*/"a":1}' };
    case 20:
      return {
        tag: "json_future_schema",
        value:
          '{"api_version":"99.7","schema":{"$id":"future"},"event":{"id":"f","type":"UNKNOWN_V99","new_required_field":[{}]}}',
      };
    case 21: {
      const [a, b] = rng.pick(NORMALIZATION_PAIRS);
      return { tag: "json_nfc_nfd_keys", value: JSON.stringify({ [a]: 1, [b]: 2 }) };
    }
    case 22:
      return {
        tag: "json_many_keys",
        value: "{" + Array.from({ length: 20000 }, (_, i) => `"k${i}":${i}`).join(",") + "}",
      };
    case 23:
      return { tag: "json_ws_only", value: " \n\t " };
    default:
      return {
        tag: "json_huge_numeric",
        value: `{"n":${rng.pick(["1e100000", "1e131072", "1e200000", "-1e131071"])}}`,
      };
  }
}

function genTimestampText(rng) {
  return rng.pick([
    { tag: "ts_iso", value: "2030-01-01T00:00:00Z" },
    { tag: "ts_year_only", value: "2030" },
    { tag: "ts_epoch_digits", value: "1735689600" },
    { tag: "ts_infinity", value: "infinity" },
    { tag: "ts_neg_infinity", value: "-infinity" },
    { tag: "ts_max_plus", value: "294277-01-01T00:00:00Z" },
    { tag: "ts_min_minus", value: "4714-11-23 BC" },
    { tag: "ts_nanos", value: "2030-01-01T00:00:00.123456789Z" },
    { tag: "ts_bad_offset", value: "2030-01-01T00:00:00+99:00" },
    { tag: "ts_nul", value: "2030-01-01\u0000" },
    { tag: "ts_empty", value: "" },
    { tag: "ts_nan", value: "NaN" },
    { tag: "ts_garbage", value: "../../now" },
    { tag: "ts_null", value: null },
    { tag: "ts_64k", value: longAscii(rng, 65536) },
    { tag: "ts_feb30", value: "2030-02-30T00:00:00Z" },
    { tag: "ts_now_literal", value: "now" },
    { tag: "ts_leap_second", value: "2030-06-30T23:59:60Z" },
  ]);
}

function genBoolText(rng) {
  return rng.pick([
    { tag: "bool_true", value: true },
    { tag: "bool_false", value: false },
    { tag: "bool_str_yes", value: "yes" },
    { tag: "bool_str_maybe", value: "maybe" },
    { tag: "bool_str_1", value: "1" },
    { tag: "bool_str_2", value: "2" },
    { tag: "bool_str_empty", value: "" },
    { tag: "bool_str_nul", value: "t\u0000" },
    { tag: "bool_null", value: null },
    { tag: "bool_str_TRUE_ws", value: "  TRUE  " },
    { tag: "bool_str_64k", value: longAscii(rng, 65536) },
    { tag: "bool_str_nan", value: "NaN" },
  ]);
}

function genUserIdText(rng) {
  return rng.pick([
    { tag: "uid_a", value: USER_A },
    { tag: "uid_b", value: USER_B },
    { tag: "uid_a_upper", value: USER_A.toUpperCase() },
    { tag: "uid_a_braces", value: `{${USER_A}}` },
    { tag: "uid_a_nodash", value: USER_A.replace(/-/g, "") },
    { tag: "uid_unknown_profile", value: fakeUuid(rng) },
    { tag: "uid_nil", value: "00000000-0000-0000-0000-000000000000" },
    { tag: "uid_traversal", value: rng.pick(TRAVERSAL) },
    { tag: "uid_nul", value: `${USER_A}\u0000` },
    { tag: "uid_empty", value: "" },
    { tag: "uid_null", value: null },
    { tag: "uid_64k", value: longAscii(rng, 65536) },
    { tag: "uid_a_trailing_ws", value: `${USER_A} ` },
    { tag: "uid_proto", value: "__proto__" },
    { tag: "uid_a_plus_char", value: `${USER_A}0` },
  ]);
}

// ---------------------------------------------------------------------------
// Classification helpers.
// ---------------------------------------------------------------------------
const FORBIDDEN_SQLSTATE_CLASSES = new Set(["08", "53", "57", "XX", "58", "F0"]);
const GRACEFUL_SQLSTATE_CLASSES = new Set(["22", "23", "54", "42", "40", "P0"]);
function classifyError(err) {
  const code = err && typeof err.code === "string" ? err.code : null;
  if (!code) return { kind: "client_error", sqlstate: null, message: String(err && err.message) };
  const cls = code.slice(0, 2);
  if (FORBIDDEN_SQLSTATE_CLASSES.has(cls))
    return { kind: "forbidden_error", sqlstate: code, message: err.message };
  if (GRACEFUL_SQLSTATE_CLASSES.has(cls))
    return { kind: "rejected", sqlstate: code, message: err.message };
  return { kind: "unexpected_error", sqlstate: code, message: err.message };
}

async function snapshot(client) {
  const r = await client.query(
    `select
       (select count(*)::int from public.webhook_events) as we,
       (select coalesce(md5(string_agg(md5(id) || md5(payload::text) || coalesce(event_type,'') || coalesce(app_user_id,'') || received_at::text, ',' order by id)), '') from public.webhook_events) as we_hash,
       (select count(*)::int from public.billing_entitlements) as be,
       (select coalesce(md5(string_agg(user_id::text || premium::text || coalesce(product_key,'') || coalesce(expires_at::text,'') || verified_at::text, ',' order by user_id)), '') from public.billing_entitlements) as be_hash`,
  );
  return r.rows[0];
}

async function withRollback(client, fn) {
  await client.query("begin");
  try {
    const out = await fn();
    await client.query("rollback");
    return out;
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}

async function alive(client) {
  const r = await client.query("select 1 as ok");
  return r.rows[0].ok === 1;
}

function describe(v) {
  if (Buffer.isBuffer(v)) return { kind: "buffer", hex: v.toString("hex") };
  if (v === null) return null;
  if (typeof v !== "string") return v;
  return v.length > 200 ? { kind: "string", length: v.length, head: v.slice(0, 64) } : v;
}

// ---------------------------------------------------------------------------
// Scenarios. Each returns { outcome, ...details, held: boolean, violations: [] }.
// ---------------------------------------------------------------------------
async function scenarioWebhookInsert(rng, client) {
  const id = genText(rng, { allowBuffer: true });
  const payload = genJsonText(rng);
  const eventType = rng.chance(0.3) ? genText(rng) : { tag: "plain", value: "RENEWAL" };
  const appUserId = rng.chance(0.3) ? genText(rng) : { tag: "uid_a", value: USER_A };
  const useOnConflict = rng.chance(0.5);
  const before = await snapshot(client);
  const violations = [];
  let outcome;
  let sqlstate = null;
  let message = null;
  await client.query("begin");
  try {
    await client.query("set local role service_role");
    const sql = useOnConflict
      ? "insert into public.webhook_events (id, provider, event_type, app_user_id, payload) values ($1, 'revenuecat', $2, $3, $4::jsonb) on conflict (id) do nothing"
      : "insert into public.webhook_events (id, provider, event_type, app_user_id, payload) values ($1, 'revenuecat', $2, $3, $4::jsonb)";
    const r = await client.query(sql, [id.value, eventType.value, appUserId.value, payload.value]);
    // round-trip check inside the same tx
    const back = await client.query(
      "select octet_length(id) as len, id = $1 as same_id, payload::text = $2::jsonb::text as same_payload from public.webhook_events where id = $1",
      [id.value, payload.value],
    );
    if (
      r.rowCount !== 1 ||
      back.rows.length !== 1 ||
      !back.rows[0].same_id ||
      !back.rows[0].same_payload
    ) {
      violations.push(
        `I3 round-trip mismatch rowCount=${r.rowCount} back=${JSON.stringify(back.rows)}`,
      );
    }
    // idempotency: second insert of the same id
    await client.query("savepoint dup");
    try {
      await client.query(
        "insert into public.webhook_events (id, payload) values ($1, '{}'::jsonb)",
        [id.value],
      );
      violations.push("I3 duplicate id accepted by plain insert");
    } catch (dupErr) {
      if (dupErr.code !== "23505")
        violations.push(`I3 duplicate insert error ${dupErr.code} not 23505`);
      await client.query("rollback to savepoint dup");
    }
    const noop = await client.query(
      "insert into public.webhook_events (id, payload) values ($1, '{}'::jsonb) on conflict (id) do nothing",
      [id.value],
    );
    if (noop.rowCount !== 0)
      violations.push(`I3 on-conflict-do-nothing wrote ${noop.rowCount} rows`);
    const cnt = await client.query(
      "select count(*)::int as n from public.webhook_events where id = $1",
      [id.value],
    );
    if (cnt.rows[0].n !== 1)
      violations.push(`I3 expected exactly one row for id, got ${cnt.rows[0].n}`);
    await client.query("rollback"); // never keep stress rows
    outcome = "accepted";
  } catch (err) {
    await client.query("rollback");
    const c = classifyError(err);
    outcome = c.kind;
    sqlstate = c.sqlstate;
    message = c.message;
    if (c.kind !== "rejected") violations.push(`I1 ${c.kind} ${c.sqlstate}: ${c.message}`);
  }
  if (!(await alive(client))) violations.push("I1 connection dead after input");
  const after = await snapshot(client);
  if (JSON.stringify(before) !== JSON.stringify(after))
    violations.push("I2 tables changed by a rolled-back/rejected input");
  return {
    scenario: "webhook_insert",
    inputs: {
      id: { tag: id.tag, value: describe(id.value) },
      payload: { tag: payload.tag, value: describe(payload.value) },
      event_type: { tag: eventType.tag, value: describe(eventType.value) },
      app_user_id: { tag: appUserId.tag, value: describe(appUserId.value) },
      on_conflict: useOnConflict,
    },
    outcome,
    sqlstate,
    message,
    held: violations.length === 0,
    violations,
  };
}

async function scenarioBillingUpsert(rng, client) {
  const userId = genUserIdText(rng);
  const premium = genBoolText(rng);
  const productKey = rng.chance(0.5)
    ? genText(rng)
    : { tag: "plain", value: "pickle_sensei_pro_monthly" };
  const expiresAt = genTimestampText(rng);
  const violations = [];
  const before = await snapshot(client);
  let outcome;
  let sqlstate = null;
  let message = null;
  await client.query("begin");
  try {
    await client.query("set local role service_role");
    const r = await client.query(
      `insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
       values ($1, $2, $3, $4, now())
       on conflict (user_id) do update set premium = excluded.premium, product_key = excluded.product_key, expires_at = excluded.expires_at, verified_at = excluded.verified_at
       returning user_id::text, premium, product_key, expires_at::text`,
      [userId.value, premium.value, productKey.value, expiresAt.value],
    );
    const rows = await client.query(
      "select count(*)::int as n from public.billing_entitlements where user_id = $1",
      [userId.value],
    );
    if (r.rowCount !== 1 || rows.rows[0].n !== 1)
      violations.push(`I4 expected exactly one row, got ${rows.rows[0].n}`);
    if (!USERS.some((u) => u.toLowerCase() === r.rows[0].user_id.toLowerCase()))
      violations.push(`I4 row written for unknown user ${r.rows[0].user_id}`);
    // The wire encoding is UTF-8: a lone surrogate leaves node as U+FFFD, so
    // the value Postgres can be expected to return is the well-formed one.
    const expectedKey =
      typeof productKey.value === "string"
        ? productKey.value.toWellFormed()
        : (productKey.value ?? null);
    if (r.rows[0].product_key !== expectedKey) violations.push("I4 product_key did not round-trip");
    await client.query("rollback");
    outcome = "accepted";
  } catch (err) {
    await client.query("rollback");
    const c = classifyError(err);
    outcome = c.kind;
    sqlstate = c.sqlstate;
    message = c.message;
    if (c.kind !== "rejected") violations.push(`I1 ${c.kind} ${c.sqlstate}: ${c.message}`);
  }
  if (!(await alive(client))) violations.push("I1 connection dead after input");
  const after = await snapshot(client);
  if (JSON.stringify(before) !== JSON.stringify(after))
    violations.push("I2 tables changed by a rolled-back/rejected input");
  return {
    scenario: "billing_upsert",
    inputs: {
      user_id: { tag: userId.tag, value: describe(userId.value) },
      premium: { tag: premium.tag, value: describe(premium.value) },
      product_key: { tag: productKey.tag, value: describe(productKey.value) },
      expires_at: { tag: expiresAt.tag, value: describe(expiresAt.value) },
    },
    outcome,
    sqlstate,
    message,
    held: violations.length === 0,
    violations,
  };
}

async function scenarioRlsProbe(rng, client) {
  const role = rng.chance(0.8) ? "authenticated" : "anon";
  const subject = rng.pick([
    { tag: "sub_a", value: USER_A },
    { tag: "sub_b", value: USER_B },
    { tag: "sub_a_upper", value: USER_A.toUpperCase() },
    { tag: "sub_empty", value: "" },
    { tag: "sub_garbage", value: rng.pick(TRAVERSAL) },
    { tag: "sub_nul", value: `${USER_A}\u0000` },
    { tag: "sub_nil", value: "00000000-0000-0000-0000-000000000000" },
    { tag: "sub_64k", value: longAscii(rng, 65536) },
    { tag: "sub_sqlish", value: `${USER_A}' or '1'='1` },
    { tag: "sub_b_braces", value: `{${USER_B}}` },
  ]);
  const payloadId = genText(rng);
  const violations = [];
  const attempts = [];
  const before = await snapshot(client);
  const runStmt = async (label, sql, params, expectations) => {
    await client.query("savepoint s");
    try {
      const r = await client.query(sql, params);
      await client.query("release savepoint s");
      attempts.push({ label, result: "ok", rows: r.rows.length });
      expectations.onOk?.(r);
    } catch (err) {
      await client.query("rollback to savepoint s");
      const c = classifyError(err);
      attempts.push({ label, result: c.kind, sqlstate: c.sqlstate });
      if (c.kind !== "rejected")
        violations.push(`I1 ${label}: ${c.kind} ${c.sqlstate} ${c.message}`);
      else expectations.onErr?.(c);
    }
  };
  await client.query("begin");
  try {
    await client.query(`set local role ${role}`);
    let claimsSet = true;
    await runStmt(
      "set_claims",
      "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [subject.value, JSON.stringify({ sub: subject.value, role })],
      {
        onErr: (c) => {
          claimsSet = false;
          if (c.sqlstate !== "22021")
            violations.push(`I5 set_config rejected with ${c.sqlstate} (expected 22021 for NUL)`);
        },
      },
    );
    // What auth.uid() will resolve to: the subject cast through uuid (Postgres
    // accepts braces/upper-case/no-dash spellings; anything else is 22P02).
    let resolvedUid = null;
    if (claimsSet) {
      await client.query("savepoint uidcast");
      try {
        resolvedUid = (await client.query("select $1::uuid::text as u", [subject.value])).rows[0].u;
        await client.query("release savepoint uidcast");
      } catch {
        await client.query("rollback to savepoint uidcast");
      }
    }
    const expectRead =
      role === "authenticated" && resolvedUid !== null && USERS.includes(resolvedUid);
    await runStmt("select_billing", "select user_id::text from public.billing_entitlements", [], {
      onOk: (r) => {
        if (role === "anon") violations.push("I5 anon could select billing_entitlements");
        for (const row of r.rows)
          if (row.user_id !== resolvedUid)
            violations.push(`I5 authenticated sub=${subject.tag} saw row of ${row.user_id}`);
        if (expectRead && r.rows.length !== 1)
          violations.push(`I5 own row not visible (rows=${r.rows.length})`);
        if (!expectRead && r.rows.length !== 0)
          violations.push(
            `I5 sub=${subject.tag} resolved to ${resolvedUid} yet saw ${r.rows.length} rows`,
          );
      },
      onErr: (c) => {
        if (role === "anon" && c.sqlstate !== "42501")
          violations.push(`I5 anon select got ${c.sqlstate} not 42501`);
        if (role === "authenticated" && !["22P02", "22021"].includes(c.sqlstate))
          violations.push(
            `I5 authenticated select got ${c.sqlstate} (expected rows or uuid-cast 22P02)`,
          );
      },
    });
    const writes = [
      [
        "insert_billing",
        "insert into public.billing_entitlements (user_id, premium) values ($1, true)",
        [resolvedUid && USERS.includes(resolvedUid) ? resolvedUid : USER_A],
      ],
      [
        "update_billing",
        "update public.billing_entitlements set premium = true, expires_at = 'infinity'",
        [],
      ],
      ["delete_billing", "delete from public.billing_entitlements", []],
      ["select_webhook", "select id from public.webhook_events", []],
      [
        "insert_webhook",
        "insert into public.webhook_events (id, payload) values ($1, '{}'::jsonb)",
        [typeof payloadId.value === "string" ? payloadId.value : "x"],
      ],
      ["update_webhook", "update public.webhook_events set payload = '{}'::jsonb", []],
      ["delete_webhook", "delete from public.webhook_events", []],
      ["truncate_webhook", "truncate public.webhook_events", []],
    ];
    for (const [label, sql, params] of writes) {
      await runStmt(label, sql, params, {
        onOk: () => violations.push(`I5 ${role} ${label} succeeded`),
        onErr: (c) => {
          // A NUL byte in a bind parameter is rejected at bind time (22021),
          // before the privilege check runs — still no write, still typed.
          const nulParam = params.some((p) => typeof p === "string" && p.includes("\u0000"));
          if (c.sqlstate !== "42501" && !(nulParam && c.sqlstate === "22021"))
            violations.push(`I5 ${role} ${label} got ${c.sqlstate} not 42501`);
        },
      });
    }
    await client.query("rollback");
  } catch (err) {
    await client.query("rollback");
    const c = classifyError(err);
    violations.push(`I1 probe setup ${c.kind} ${c.sqlstate}: ${c.message}`);
  }
  if (!(await alive(client))) violations.push("I1 connection dead after probe");
  const after = await snapshot(client);
  if (JSON.stringify(before) !== JSON.stringify(after))
    violations.push("I2 tables changed by client-role probe");
  return {
    scenario: "rls_probe",
    inputs: {
      role,
      subject: { tag: subject.tag, value: describe(subject.value) },
      webhook_id: { tag: payloadId.tag, value: describe(payloadId.value) },
    },
    outcome: violations.length === 0 ? "denied_as_expected" : "violation",
    attempts,
    held: violations.length === 0,
    violations,
  };
}

async function scenarioConcurrency(rng, client, pool) {
  const isolation = rng.chance(0.5) ? "read committed" : "serializable";
  const mode = rng.chance(0.5) ? "webhook_same_id" : "billing_two_users";
  const violations = [];
  const id = `race-${rng.int(0, 1e9)}-${rng.pick(["a", "\u00e9", "e\u0301", "\u{1F468}\u200D\u{1F469}"])}`;
  const results = [];
  await client.query("delete from public.webhook_events where id like 'race-%'");
  if (mode === "billing_two_users")
    await client.query("delete from public.billing_entitlements where user_id = any($1::uuid[])", [
      USERS,
    ]);
  const workers = pool.map(async (c, i) => {
    const wr = new Rng(rng.int(0, 0x7fffffff) + i);
    const useOnConflict = wr.chance(0.5);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        await c.query(`begin isolation level ${isolation}`);
        await c.query("set local role service_role");
        if (mode === "webhook_same_id") {
          const payload = genJsonText(wr);
          const sql = useOnConflict
            ? "insert into public.webhook_events (id, payload) values ($1, $2::jsonb) on conflict (id) do nothing"
            : "insert into public.webhook_events (id, payload) values ($1, $2::jsonb)";
          const r = await c.query(sql, [id, payload.value]);
          await c.query("commit");
          results.push({
            worker: i,
            result: r.rowCount === 1 ? "inserted" : "noop",
            payload_tag: payload.tag,
            attempts: attempt,
          });
        } else {
          const user = USERS[i % 2];
          const premium = genBoolText(wr);
          const exp = genTimestampText(wr);
          await c.query(
            `insert into public.billing_entitlements (user_id, premium, product_key, expires_at) values ($1, $2, $3, $4)
             on conflict (user_id) do update set premium = excluded.premium, product_key = excluded.product_key, expires_at = excluded.expires_at, verified_at = now()`,
            [user, premium.value, `w${i}`, exp.value],
          );
          await c.query("commit");
          results.push({
            worker: i,
            result: "upserted",
            user,
            product_key: `w${i}`,
            premium_tag: premium.tag,
            expires_tag: exp.tag,
            attempts: attempt,
          });
        }
        return;
      } catch (err) {
        await c.query("rollback");
        const cl = classifyError(err);
        if (
          cl.kind === "rejected" &&
          (cl.sqlstate === "40001" || cl.sqlstate === "40P01") &&
          attempt < 10
        )
          continue;
        results.push({ worker: i, result: cl.kind, sqlstate: cl.sqlstate, attempts: attempt });
        if (cl.kind !== "rejected")
          violations.push(`I1 worker ${i}: ${cl.kind} ${cl.sqlstate} ${cl.message}`);
        return;
      }
    }
  });
  await Promise.all(workers);
  if (mode === "webhook_same_id") {
    const n = (
      await client.query("select count(*)::int as n from public.webhook_events where id = $1", [id])
    ).rows[0].n;
    const inserted = results.filter((r) => r.result === "inserted").length;
    const noop = results.filter((r) => r.result === "noop").length;
    const dup = results.filter((r) => r.sqlstate === "23505").length;
    const wellFormed = inserted + noop + dup; // workers whose payload parsed
    if (inserted > 1)
      violations.push(`I6 ${inserted} sessions each believe they inserted the raced id`);
    if (wellFormed > 0 && inserted !== 1)
      violations.push(`I6 ${wellFormed} well-formed sessions but ${inserted} inserts`);
    if (n !== Math.min(1, inserted))
      violations.push(`I6 expected ${Math.min(1, inserted)} row(s) for raced id, got ${n}`);
    // A malformed payload is a class-22 data exception or a class-54 limit;
    // the only other acceptable outcome for a raced id is 23505.
    for (const r of results)
      if (r.result === "rejected" && r.sqlstate !== "23505" && !/^(22|54)/.test(r.sqlstate))
        violations.push(`I6 unexpected sqlstate ${r.sqlstate}`);
    await client.query("delete from public.webhook_events where id = $1", [id]);
    return {
      scenario: "concurrency",
      inputs: { isolation, mode, id: describe(id), sessions: pool.length },
      outcome: violations.length === 0 ? "one_row" : "violation",
      results: { inserted, duplicate_23505: dup, final_rows: n, per_worker: results },
      held: violations.length === 0,
      violations,
    };
  }
  const rows = (
    await client.query(
      "select user_id::text, product_key from public.billing_entitlements where user_id = any($1::uuid[]) order by user_id",
      [USERS],
    )
  ).rows;
  const accepted = results.filter((r) => r.result === "upserted");
  for (const u of USERS) {
    const rowsForUser = rows.filter((r) => r.user_id === u);
    const acceptedForUser = accepted.filter((r) => r.user === u);
    if (rowsForUser.length > 1) violations.push(`I6 user ${u} has ${rowsForUser.length} rows`);
    if (acceptedForUser.length > 0 && rowsForUser.length !== 1)
      violations.push(
        `I6 user ${u} had ${acceptedForUser.length} accepted upserts but ${rowsForUser.length} rows`,
      );
    if (acceptedForUser.length === 0 && rowsForUser.length !== 0)
      violations.push(`I6 user ${u} has a row but every upsert was rejected`);
    if (
      rowsForUser.length === 1 &&
      !acceptedForUser.some((r) => r.product_key === rowsForUser[0].product_key)
    )
      violations.push(
        `I6 user ${u} final row ${rowsForUser[0].product_key} not among accepted inputs`,
      );
  }
  await seedBaselineRows(client);
  return {
    scenario: "concurrency",
    inputs: { isolation, mode, sessions: pool.length },
    outcome: violations.length === 0 ? "consistent" : "violation",
    results: { accepted: accepted.length, final_rows: rows, per_worker: results },
    held: violations.length === 0,
    violations,
  };
}

const SWEEP_SQL = (() => {
  const mig = readFileSync(
    resolve(repoRoot, "supabase/migrations/20260831000000_scale_and_security.sql"),
    "utf8",
  );
  const m = mig.match(/'purge-old-webhook-events',\s*'[^']*',\s*'((?:[^']|'')*)'/);
  if (!m) throw new Error("purge-old-webhook-events job not found in migration");
  return m[1].replace(/''/g, "'");
})();

async function scenarioSweep(rng, client) {
  const violations = [];
  const offsets = [
    { tag: "89d23h59m", sql: "now() - interval '89 days 23 hours 59 minutes'", swept: false },
    { tag: "90d_minus_1s", sql: "now() - interval '90 days' + interval '1 second'", swept: false },
    { tag: "90d_plus_1s", sql: "now() - interval '90 days' - interval '1 second'", swept: true },
    { tag: "91d", sql: "now() - interval '91 days'", swept: true },
    { tag: "epoch", sql: "'epoch'::timestamptz", swept: true },
    { tag: "neg_infinity", sql: "'-infinity'::timestamptz", swept: true },
    { tag: "infinity", sql: "'infinity'::timestamptz", swept: false },
    { tag: "future_1y", sql: "now() + interval '1 year'", swept: false },
    { tag: "max_ts", sql: "'294276-12-31 23:59:59+00'::timestamptz", swept: false },
    { tag: "now", sql: "now()", swept: false },
  ];
  const chosen = offsets.filter(() => rng.chance(0.7));
  if (chosen.length === 0) chosen.push(offsets[2]);
  const prefix = `sweep-${rng.int(0, 1e9)}-`;
  await client.query("begin");
  try {
    await client.query("set local role service_role");
    for (const o of chosen) {
      await client.query(
        `insert into public.webhook_events (id, payload, received_at) values ($1, '{}'::jsonb, ${o.sql})`,
        [prefix + o.tag],
      );
    }
    const del = await client.query(SWEEP_SQL);
    const expectSwept = chosen.filter((o) => o.swept).length;
    if (del.rowCount !== expectSwept)
      violations.push(`I7 sweep deleted ${del.rowCount}, expected ${expectSwept}`);
    const remaining = (
      await client.query("select id from public.webhook_events where id like $1", [prefix + "%"])
    ).rows.map((r) => r.id.slice(prefix.length));
    for (const o of chosen) {
      if (o.swept && remaining.includes(o.tag))
        violations.push(`I7 ${o.tag} should have been swept`);
      if (!o.swept && !remaining.includes(o.tag))
        violations.push(`I7 ${o.tag} should have survived`);
    }
    await client.query("rollback");
  } catch (err) {
    await client.query("rollback");
    const c = classifyError(err);
    violations.push(`I7 sweep scenario error ${c.kind} ${c.sqlstate}: ${c.message}`);
  }
  return {
    scenario: "sweep",
    inputs: { rows: chosen.map((o) => o.tag), sweep_sql: SWEEP_SQL },
    outcome: violations.length === 0 ? "exact" : "violation",
    held: violations.length === 0,
    violations,
  };
}

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------
async function seedUsers(client) {
  await client.query(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ($1, 'stress-a@example.com', '{"provider":"apple"}'::jsonb), ($2, 'stress-b@example.com', '{"provider":"google"}'::jsonb)
     on conflict (id) do nothing`,
    [USER_A, USER_B],
  );
  const profiles = (
    await client.query(
      "select count(*)::int as n from public.profiles where id = any($1::uuid[])",
      [USERS],
    )
  ).rows[0].n;
  if (profiles !== 2) throw new Error(`expected 2 profiles for stress users, found ${profiles}`);
  await seedBaselineRows(client);
}

// One billing row per stress user so RLS reads have something to leak.
async function seedBaselineRows(client) {
  await client.query("delete from public.billing_entitlements where user_id = any($1::uuid[])", [
    USERS,
  ]);
  await client.query(
    "insert into public.billing_entitlements (user_id, premium, product_key) values ($1, true, 'pickle_sensei_pro_monthly'), ($2, false, null)",
    [USER_A, USER_B],
  );
}

async function runIteration(seed, client, pool) {
  const rng = new Rng(seed);
  const roll = rng.next();
  let res;
  if (roll < 0.36) res = await scenarioWebhookInsert(rng, client);
  else if (roll < 0.62) res = await scenarioBillingUpsert(rng, client);
  else if (roll < 0.86) res = await scenarioRlsProbe(rng, client);
  else if (roll < 0.95) res = await scenarioConcurrency(rng, client, pool);
  else res = await scenarioSweep(rng, client);
  return { seed, ...res };
}

async function main() {
  const client = new Client({ connectionString: PGURL });
  await client.connect();
  const pool = [];
  for (let i = 0; i < CONCURRENCY; i += 1) {
    const c = new Client({ connectionString: PGURL });
    await c.connect();
    pool.push(c);
  }
  await seedUsers(client);

  const seeds =
    REPLAY_SEEDS ?? Array.from({ length: ITER }, (_, i) => iterationSeed(MASTER_SEED, i));
  const rows = [];
  const started = Date.now();
  for (let i = 0; i < seeds.length; i += 1) {
    let row;
    try {
      row = await runIteration(seeds[i], client, pool);
    } catch (err) {
      const c = classifyError(err);
      row = {
        seed: seeds[i],
        scenario: "harness",
        outcome: "harness_throw",
        sqlstate: c.sqlstate,
        message: c.message,
        held: false,
        violations: [`I1 uncaught: ${c.kind} ${c.sqlstate} ${c.message}`],
      };
      // make sure the driver connection is usable again
      try {
        await client.query("rollback");
      } catch {
        /* not in a transaction */
      }
    }
    rows.push(row);
    if ((i + 1) % 250 === 0 || i + 1 === seeds.length) {
      const broken = rows.filter((r) => !r.held).length;
      process.stderr.write(
        `[stress] ${i + 1}/${seeds.length} broken=${broken} ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
      );
    }
  }

  await client.query("delete from public.billing_entitlements where user_id = any($1::uuid[])", [
    USERS,
  ]);
  await client.query(
    "delete from public.webhook_events where id like 'race-%' or id like 'sweep-%'",
  );
  await client.query("delete from auth.users where id = any($1::uuid[])", [USERS]);
  await client.end();
  await Promise.all(pool.map((c) => c.end()));

  const byScenario = {};
  const byOutcome = {};
  const bySqlstate = {};
  const byTag = {};
  for (const r of rows) {
    byScenario[r.scenario] = (byScenario[r.scenario] ?? 0) + 1;
    byOutcome[`${r.scenario}:${r.outcome}`] = (byOutcome[`${r.scenario}:${r.outcome}`] ?? 0) + 1;
    if (r.sqlstate) bySqlstate[r.sqlstate] = (bySqlstate[r.sqlstate] ?? 0) + 1;
    for (const v of Object.values(r.inputs ?? {}))
      if (v && typeof v === "object" && v.tag) byTag[v.tag] = (byTag[v.tag] ?? 0) + 1;
  }
  const broken = rows.filter((r) => !r.held);
  const summary = {
    pgurl_host: new URL(PGURL).host,
    master_seed: MASTER_SEED,
    iterations_requested: seeds.length,
    iterations_executed: rows.length,
    parallel_sessions: CONCURRENCY,
    duration_ms: Date.now() - started,
    held: rows.length - broken.length,
    broken: broken.length,
    broken_seeds: broken.map((r) => r.seed),
    by_scenario: byScenario,
    by_outcome: byOutcome,
    by_sqlstate: bySqlstate,
    by_input_tag: byTag,
    replay:
      "STRESS_SEED is the master seed; replay one iteration with: node supabase/tests/stress/boundary_malformed.mjs --replay <seed>",
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ summary, iterations: rows }, null, 1));
  process.stderr.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(`[stress] wrote ${OUT}\n`);
  if (broken.length > 0) {
    for (const r of broken)
      process.stderr.write(
        `[stress] BROKEN seed=${r.seed} ${r.scenario}: ${r.violations.join(" | ")}\n`,
      );
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`[stress] fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
});
