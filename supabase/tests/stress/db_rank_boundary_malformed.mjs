#!/usr/bin/env node
/**
 * db-rank — BOUNDARY / MALFORMED-INPUT stress harness.
 *
 * Unit under test: public.player_rank_state + public.recompute_player_rank +
 * public.player_rank_tier + public.handle_shot_rank_refresh, driven through
 * every path a client (or the edge function on its behalf) can reach them:
 *
 *   - public.apply_synced_shot(jsonb)   (SECURITY INVOKER RPC → shots trigger)
 *   - direct INSERT into public.shots   (authenticated holds INSERT)
 *   - owner-side UPDATE / DELETE        (handle_shot_rank_refresh UPDATE/DELETE)
 *   - public.player_rank_tier(numeric)  (callable by authenticated)
 *   - RLS on player_rank_state / player_technique_rating from `authenticated`
 *
 * Every iteration is derived from a seed (STRESS_SEED + iteration index) with
 * an sfc32 PRNG, so a payload can be regenerated exactly with
 * STRESS_REPLAY=<i>[,<j>...]. Results land in <out>/results.json (one record
 * per iteration: seed → payload digest/preview → outcome → verdict),
 * <out>/failures.json and <out>/summary.json.
 *
 * Verdicts:
 *   HELD   — accepted write whose post-conditions hold (row owned by the
 *            caller, constraints satisfied, player_rank_state == TS oracle
 *            computePlayerRank over the stored rows), OR a graceful rejection
 *            (stable RPC code / typed SQLSTATE, zero rows written).
 *   BROKEN — an error RAISED out of apply_synced_shot (a throw out of the
 *            handler), an unknown/leaky return code, an accepted write whose
 *            post-conditions fail, a rejected input that still wrote rows, or
 *            a rank/tier disagreement with the TS oracle.
 *
 * Oracle: the real packages/shared-types/src/playerRank.ts (imported via
 * node --experimental-strip-types), never a port.
 *
 * Env:
 *   STRESS_PG_URL        postgres URL (default postgres://postgres:x@127.0.0.1:5499/postgres)
 *   STRESS_ITER          iterations (default 200; the campaign used 3200)
 *   STRESS_SEED          campaign seed string (default "db-rank-boundary-malformed-v1")
 *   STRESS_REPLAY        comma-separated iteration indices to run alone
 *   STRESS_CONC_ROUNDS   concurrency rounds after the campaign (default 2)
 *   STRESS_LANES         parallel connections per round (default 8)
 *   STRESS_INTERLEAVE    repeats of the deterministic 2-connection interleavings (default 1)
 *   STRESS_OUT           output dir (default artifacts/stress/db-rank-boundary-malformed/<run>)
 *
 * Run: supabase/tests/stress/run_db_rank_boundary_malformed.sh
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const require = createRequire(path.join(ROOT, "packages/database/package.json"));
const { Client } = require("pg");

let oracle;
try {
  oracle = await import(path.join(ROOT, "packages/shared-types/src/playerRank.ts"));
} catch (error) {
  console.error(
    "cannot import the TS rank oracle; run with `node --experimental-strip-types` (Node >= 22.6):",
    error.message,
  );
  process.exit(2);
}
const { computePlayerRank, playerRankTierForRating } = oracle;

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const PG_URL = process.env.STRESS_PG_URL ?? "postgres://postgres:x@127.0.0.1:5499/postgres";
const ITER = envInt("STRESS_ITER", 200);
const SEED = process.env.STRESS_SEED ?? "db-rank-boundary-malformed-v1";
const REPLAY = (process.env.STRESS_REPLAY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);
const CONC_ROUNDS = envInt("STRESS_CONC_ROUNDS", 2);
const LANES = envInt("STRESS_LANES", 8);
const INTERLEAVE_REPEATS = envInt("STRESS_INTERLEAVE", 1);
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUT =
  process.env.STRESS_OUT ?? path.join(ROOT, "artifacts/stress/db-rank-boundary-malformed", RUN_ID);

function envInt(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";
const USERS = [
  {
    name: "alice",
    id: ALICE,
    sessionId: "00000000-0000-4000-8000-0000000000a1",
    provider: "google",
  },
  { name: "bob", id: BOB, sessionId: "00000000-0000-4000-8000-0000000000b1", provider: "apple" },
];
const other = (u) => (u.id === ALICE ? USERS[1] : USERS[0]);

// ─────────────────────────────────────────────────────────────────────────────
// Seeded PRNG (sfc32 keyed by sha256(seed))
// ─────────────────────────────────────────────────────────────────────────────
function sfc32(a, b, c, d) {
  return function next() {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}
function rngFor(seedText) {
  const h = crypto.createHash("sha256").update(seedText).digest();
  const r = sfc32(h.readUInt32LE(0), h.readUInt32LE(4), h.readUInt32LE(8), h.readUInt32LE(12));
  for (let i = 0; i < 16; i++) r();
  return r;
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const chance = (rng, p) => rng() < p;
function uuidFrom(rng) {
  const b = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) b[i] = int(rng, 0, 255);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function weighted(rng, table) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let x = rng() * total;
  for (const [k, w] of table) {
    x -= w;
    if (x < 0) return k;
  }
  return table[table.length - 1][0];
}
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
function preview(text) {
  if (text.length <= 400) return text;
  return `${text.slice(0, 200)} …[len=${text.length} sha256/16=${sha(text)}]… ${text.slice(-80)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Value pools
// ─────────────────────────────────────────────────────────────────────────────
const TECHNIQUES = [
  "dink",
  "drive",
  "serve",
  "third_shot_drop",
  "volley",
  "overhead",
  "lob",
  "reset",
];
const VERSION_KEYS = [
  "appVersion",
  "modelBundleVersion",
  "poseModelVersion",
  "paddleModelVersion",
  "strokeDetectorVersion",
  "phaseModelVersion",
  "scoringModelVersion",
  "shotConfigVersion",
];
const WRONG_TYPES = [
  null,
  true,
  false,
  0,
  -1,
  1.5,
  "",
  "abc",
  [],
  {},
  [1],
  { a: 1 },
  "true",
  "null",
  " ",
  "0",
  "1e3",
  { __proto__: 1 },
  ["__proto__"],
  "[object Object]",
];
// JSON-number tokens injected verbatim (some are not representable as JS numbers)
const NUM_TOKENS = [
  "0",
  "-0",
  "1e308",
  "-1e308",
  "1e-308",
  "2147483647",
  "2147483648",
  "-2147483648",
  "-2147483649",
  "9007199254740993",
  "1e400",
  "1e-400",
  "1e-5000",
  "1e99999",
  "10",
  "10.001",
  "10.004",
  "10.005",
  "10.01",
  "-0.001",
  "-0.004",
  "-0.005",
  "0.005",
  "9.995",
  "9.994",
  "99.99",
  "100",
  "1e24",
  "0.00001",
  "12345678901234567890123456789",
  "1",
  "0.5",
  "5.55555",
  "7.125",
  "7.135",
  "1" + "0".repeat(1000),
  "0." + "0".repeat(20000) + "1",
  "1e131071",
  "1e131072",
];
const NUM_STRINGS = [
  "NaN",
  "nan",
  "Infinity",
  "-Infinity",
  "inf",
  "-0",
  "1e3",
  "0x10",
  "1_000",
  " 5 ",
  "5.",
  ".5",
  "5e0",
  "",
  "１２",
  "5,5",
  "1e99999",
  "9".repeat(20000),
  "10.005",
  "-0.001",
  "null",
  "true",
  "\\u0031",
  "5;",
  "0b101",
];
const TRAVERSAL = [
  "../../etc/passwd",
  "..\\..\\windows\\system32",
  "%2e%2e%2f%2e%2e%2f",
  "/dev/null",
  "....//....//",
  "..%c0%af..%c0%af",
  "file:///etc/passwd",
  "\\\\server\\share",
  "~/.ssh/id_rsa",
  "C:\\Windows",
];
const INJECTION = [
  "'; drop table public.shots; --",
  '"; drop table public.shots; --',
  "$$ ; select 1; $$",
  "\\",
  "\\\\",
  "${jndi:ldap://x}",
  "{{7*7}}",
  "<script>alert(1)</script>",
  "%s%s%s%n",
  "' or 1=1 --",
  "\u0027 OR \u00271\u0027=\u00271",
];
const PROTO_KEYS = [
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__defineGetter__",
];
const WEIRD_UNICODE = [
  "\u202edink",
  "dink\u200b",
  "d\u0131nk",
  "dіnk" /* cyrillic і */,
  "ＤＩＮＫ",
  "𝕕𝕚𝕟𝕜",
  "\ufeffdink",
  "dink\u0000".replace("\u0000", ""),
  "\ud83d\ude00".repeat(16) /* 16 emoji = 64 bytes */,
  "👨‍👩‍👧‍👦".repeat(9) /* 9 graphemes, 63 codepoints */,
  "👨‍👩‍👧‍👦".repeat(10) /* 10 graphemes, 70 codepoints */,
  "e\u0301".repeat(32) /* 64 codepoints, 32 graphemes */,
  "e\u0301".repeat(33) /* 66 codepoints */,
  "é".repeat(64),
  "é".repeat(65),
  "\u0300".repeat(64),
  "\u0300".repeat(65),
  "\u00c5ngstr\u00f6m",
  "\u212bngstr\u00f6m" /* U+212B ANGSTROM SIGN */,
  "ﬁle",
  "file",
  "한",
  "ᄒ".concat("ᅡ", "ᆫ"),
  "\ud800" /* lone surrogate — JSON.stringify emits \ud800 */,
  "\udfff",
  "\u2028\u2029",
  "\t\n\r",
  "   ",
  "",
];
const TIME_STRINGS = [
  "2000-01-01T00:00:00Z",
  "1999-12-31T23:59:59.999Z",
  "1999-12-31T23:59:59.999999Z",
  "2099-12-31T23:59:59.999Z",
  "2099-12-31T23:59:59.999999Z",
  "2099-12-31T23:59:59.9999999Z",
  "2100-01-01T00:00:00Z",
  "2100-01-01T00:00:00.000Z",
  "infinity",
  "-infinity",
  "epoch",
  "now",
  "today",
  "tomorrow",
  "yesterday",
  "allballs",
  "294276-12-31T00:00:00Z",
  "0001-01-01T00:00:00Z",
  "2026-02-30T00:00:00Z",
  "2026-01-01T24:00:00Z",
  "2026-01-01 00:00:00",
  "2026-01-01",
  "2026-01-01T00:00:00+14:00",
  "2026-01-01T00:00:00-12:00",
  "2026-01-01T00:00:00.0000005Z",
  "2026-01-01T00:00:00.000001Z",
  "2026-01-01T00:00:00.000002Z",
  "2026-01-01T00:00:00.0000015Z",
  "2026-13-01T00:00:00Z",
  "2026-00-10T00:00:00Z",
  "2026-01-01T00:00:60Z",
  "2026-01-01T00:00:00.Z",
  "1700000000",
  "1700000000000",
  "Jan 1 2026",
  "",
  " ",
  "null",
  "2026-01-01T00:00:00Z\u0000",
  "2026-01-01T00:00:00 BC",
  "2026-01-01T00:00:00 UTC",
  "2038-01-19T03:14:08Z",
];

// ─────────────────────────────────────────────────────────────────────────────
// Payload generation
// ─────────────────────────────────────────────────────────────────────────────
function isoMs(rng) {
  const lo = Date.UTC(2000, 0, 1);
  const hi = Date.UTC(2099, 11, 31, 23, 59, 59, 999);
  return new Date(lo + Math.floor(rng() * (hi - lo))).toISOString();
}
function round2(x) {
  return Math.round(x * 100) / 100;
}
function round4(x) {
  return Math.round(x * 10000) / 10000;
}

function validShot(rng, user, canary) {
  const scored = chance(rng, 0.8);
  const phases = [];
  const nPh = int(rng, 0, 4);
  const keys = ["ready", "prepare", "accelerate", "contact", "follow_through", "recover"];
  for (let i = 0; i < nPh; i++) {
    phases.push({
      key: keys[i],
      startMs: i * 100,
      representativeMs: i * 100 + 50,
      endMs: i * 100 + 99,
      confidence: round4(rng()),
    });
  }
  const checkpoints = [];
  const nCk = int(rng, 0, 4);
  for (let i = 0; i < nCk; i++) {
    checkpoints.push({
      key: `cp_${i}`,
      score: chance(rng, 0.8) ? round2(rng() * 100) : null,
      confidence: round4(rng()),
      band: pick(rng, ["green", "yellow", "red", "unscored"]),
      direction: pick(rng, ["raise", "lower", "hold"]),
      severity: round4(rng()),
      applicable: chance(rng, 0.9),
    });
  }
  const versionVector = {};
  for (const k of VERSION_KEYS)
    versionVector[k] = k === "appVersion" ? canary : `${k.slice(0, 6)}-${int(rng, 1, 9)}`;
  return {
    id: uuidFrom(rng),
    analysisPermitId: uuidFrom(rng),
    sessionId: chance(rng, 0.7) ? user.sessionId : null,
    shotType: pick(rng, TECHNIQUES),
    cameraView: pick(rng, ["side", "rear_oblique"]),
    capturedAt: isoMs(rng),
    startMs: int(rng, 0, 5000),
    contactMs: chance(rng, 0.8) ? int(rng, 0, 5000) : null,
    endMs: int(rng, 0, 5000),
    overallScore: scored ? round2(rng() * 10) : null,
    confidence: round4(rng()),
    resultKind: scored ? "scored" : "low_confidence",
    phases,
    checkpoints,
    versionVector,
  };
}

const SCALAR_FIELDS = [
  "id",
  "analysisPermitId",
  "sessionId",
  "shotType",
  "cameraView",
  "capturedAt",
  "startMs",
  "contactMs",
  "endMs",
  "overallScore",
  "confidence",
  "resultKind",
];
const NUMERIC_FIELDS = ["overallScore", "confidence", "startMs", "contactMs", "endMs"];
const STRING_FIELDS = [
  "shotType",
  "cameraView",
  "id",
  "analysisPermitId",
  "sessionId",
  "capturedAt",
  "resultKind",
];

function setPath(obj, fieldPath, value) {
  const parts = fieldPath.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const idx = Number(p);
    cur = Number.isInteger(idx) ? cur[idx] : cur[p];
    if (cur === undefined || cur === null) return false;
  }
  const last = parts[parts.length - 1];
  const idx = Number(last);
  if (Number.isInteger(idx)) cur[idx] = value;
  else cur[last] = value;
  return true;
}

const RAW = "\u0000RAWTOKEN\u0000"; // placeholder swapped for a verbatim JSON token
function stringify(obj, rawTokens) {
  let text = JSON.stringify(obj);
  for (const [marker, token] of rawTokens) text = text.replace(JSON.stringify(marker), token);
  return text;
}

function stringPool(rng) {
  const kind = weighted(rng, [
    ["len63", 3],
    ["len64", 4],
    ["len65", 4],
    ["kb64", 3],
    ["kb200", 1],
    ["mb1", 1],
    ["traversal", 3],
    ["injection", 3],
    ["proto", 2],
    ["unicode", 6],
    ["nullbyte", 2],
    ["uuidish", 3],
    ["time", 4],
    ["case", 2],
  ]);
  switch (kind) {
    case "len63":
      return [kind, "x".repeat(63)];
    case "len64":
      return [kind, pick(rng, ["x".repeat(64), "\ud83d\ude00".repeat(64), "é".repeat(64)])];
    case "len65":
      return [kind, pick(rng, ["x".repeat(65), "\ud83d\ude00".repeat(65), "e\u0301".repeat(33)])];
    case "kb64":
      return [kind, pick(rng, ["a", "é", "\ud83d\ude00"]).repeat(64 * 1024)];
    case "kb200":
      return [kind, "z".repeat(200 * 1024)];
    case "mb1":
      return [kind, "m".repeat(1024 * 1024)];
    case "traversal":
      return [kind, pick(rng, TRAVERSAL)];
    case "injection":
      return [kind, pick(rng, INJECTION)];
    case "proto":
      return [kind, pick(rng, PROTO_KEYS)];
    case "unicode":
      return [kind, pick(rng, WEIRD_UNICODE)];
    case "nullbyte":
      return [kind, pick(rng, ["\u0000", "a\u0000b", "dink\u0000", "\u0000".repeat(64)])];
    case "uuidish":
      return [
        kind,
        pick(rng, [
          "00000000-0000-0000-0000-000000000000",
          "ffffffff-ffff-ffff-ffff-ffffffffffff",
          "00000000-0000-4000-8000-00000000000A",
          "{00000000-0000-4000-8000-00000000000a}",
          "urn:uuid:00000000-0000-4000-8000-00000000000a",
          "000000000000400080000000000000aa",
          "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
          "00000000-0000-4000-8000-00000000000",
          "not-a-uuid",
          " 00000000-0000-4000-8000-00000000000a",
          "00000000-0000-4000-8000-00000000000a ",
          uuidFrom(rng).toUpperCase(),
        ]),
      ];
    case "time":
      return [kind, pick(rng, TIME_STRINGS)];
    case "case":
      return [
        kind,
        pick(rng, ["Side", "SIDE", "Rear_Oblique", "Scored", "LOW_CONFIDENCE", "Dink", "REAL"]),
      ];
    default:
      return [kind, "x"];
  }
}

/** One RPC scenario: returns { kind, detail, text, canary, permitId, expectAccept } */
function genRpcCase(rng, user, ctx) {
  const canary = `canary-${sha(`${ctx.seed}`)}`;
  const shot = validShot(rng, user, canary);
  const rawTokens = [];
  let expectAccept = null; // null = unknown a priori; post-conditions decide
  const kind = weighted(rng, [
    ["valid", 14],
    ["truncate", 6],
    ["garbage_json", 4],
    ["top_level", 3],
    ["wrong_type", 10],
    ["numeric_special", 10],
    ["string_boundary", 11],
    ["structure", 8],
    ["identity", 5],
    ["unicode_pair", 3],
    ["dup_keys", 2],
  ]);
  let detail = {};
  let text;
  switch (kind) {
    case "valid": {
      expectAccept = true;
      text = JSON.stringify(shot);
      break;
    }
    case "truncate": {
      const full = JSON.stringify(shot);
      const cut = int(rng, 0, full.length - 1);
      text = full.slice(0, cut);
      detail = { cut, fullLength: full.length };
      break;
    }
    case "garbage_json": {
      const pool = [
        "{",
        "[",
        '{"a":}',
        "{,}",
        "nul",
        '{"id": 0x1}',
        "'single'",
        `${JSON.stringify(shot)}garbage`,
        "// c\n{}",
        '{"a":1,}',
        "NaN",
        "Infinity",
        '{"a":-}',
        "01",
        ".5",
        "+1",
        "[".repeat(5000) + "]".repeat(5000),
        "[".repeat(200000),
        '{"a":'.repeat(100000),
        "\ufeff{}",
        '{"a":"\\x41"}',
        '{"a":"\\u00"}',
        '{"a":"\\ud800"}',
        '{"a":"\\u0000"}',
        "\u0000",
        "",
        " ",
        "\n",
        '{"id":"' + "\ud83d\ude00".repeat(100) + '"',
        "{}{}",
        "[1,2,3]]",
        '{"a":1}\u0000',
        '{"a":1e}',
        '{"a":1.}',
        '{"a":-}',
        '{"a":tru}',
        '{"a":"\\"}',
      ];
      text = pick(rng, pool);
      detail = { poolIndex: pool.indexOf(text) };
      break;
    }
    case "top_level": {
      const pool = [
        "[]",
        "{}",
        "null",
        '"string"',
        "123",
        "true",
        `[${JSON.stringify(shot)}]`,
        `{"shot":${JSON.stringify(shot)}}`,
        "[[]]",
        "[{}]",
        '""',
        "0",
        "-0",
        "1e400",
        '{"__proto__":{}}',
      ];
      text = pick(rng, pool);
      detail = { poolIndex: pool.indexOf(text) };
      break;
    }
    case "wrong_type": {
      const field = pick(
        rng,
        SCALAR_FIELDS.concat([
          "phases",
          "checkpoints",
          "versionVector",
          "phases.0.key",
          "checkpoints.0.score",
          "versionVector.appVersion",
        ]),
      );
      const value = pick(rng, WRONG_TYPES);
      const ok = setPath(shot, field, value);
      detail = { field, value: JSON.stringify(value), applied: ok };
      text = JSON.stringify(shot);
      break;
    }
    case "numeric_special": {
      const field = pick(
        rng,
        NUMERIC_FIELDS.concat([
          "phases.0.startMs",
          "phases.0.confidence",
          "checkpoints.0.score",
          "checkpoints.0.severity",
          "checkpoints.0.confidence",
        ]),
      );
      if (chance(rng, 0.55)) {
        const token = pick(rng, NUM_TOKENS);
        const marker = `${RAW}${rawTokens.length}`;
        rawTokens.push([marker, token]);
        const ok = setPath(shot, field, marker);
        detail = { field, token, asJsonNumber: true, applied: ok };
      } else {
        const s = pick(rng, NUM_STRINGS);
        const ok = setPath(shot, field, s);
        detail = { field, value: preview(s), asJsonNumber: false, applied: ok };
      }
      text = stringify(shot, rawTokens);
      break;
    }
    case "string_boundary": {
      const field = pick(
        rng,
        STRING_FIELDS.concat([
          "versionVector.appVersion",
          "versionVector.shotConfigVersion",
          "phases.0.key",
          "checkpoints.0.key",
          "checkpoints.0.band",
          "checkpoints.0.direction",
        ]),
      );
      const [skind, value] = stringPool(rng);
      const ok = setPath(shot, field, value);
      detail = {
        field,
        stringKind: skind,
        value: preview(value),
        codepoints: [...value].length,
        utf8Bytes: Buffer.byteLength(value),
        applied: ok,
      };
      text = JSON.stringify(shot);
      break;
    }
    case "structure": {
      const op = pick(rng, [
        "phases_obj",
        "phases_str",
        "phases_null",
        "phases_empty",
        "phases_nulls",
        "phases_scalars",
        "phases_empty_objs",
        "phases_nested_arr",
        "phases_33",
        "phases_500",
        "phases_dup_keys",
        "checkpoints_obj",
        "checkpoints_1000",
        "vv_arr",
        "vv_str",
        "vv_empty",
        "vv_missing",
        "vv_extra_proto",
        "schema_version",
        "extra_keys",
        "delete_key",
        "deep_extra",
        "proto_top",
      ]);
      const mk = (n) =>
        Array.from({ length: n }, (_, i) => ({
          key: `p${i}`,
          startMs: i,
          representativeMs: i,
          endMs: i,
          confidence: 0.5,
        }));
      switch (op) {
        case "phases_obj":
          shot.phases = { key: "ready" };
          break;
        case "phases_str":
          shot.phases = "ready";
          break;
        case "phases_null":
          shot.phases = null;
          break;
        case "phases_empty":
          shot.phases = [];
          shot.checkpoints = [];
          expectAccept = true;
          break;
        case "phases_nulls":
          shot.phases = [null, null];
          break;
        case "phases_scalars":
          shot.phases = [1, "two", true];
          break;
        case "phases_empty_objs":
          shot.phases = [{}, {}];
          break;
        case "phases_nested_arr":
          shot.phases = [[{ key: "ready" }]];
          break;
        case "phases_33":
          shot.phases = mk(33);
          break;
        case "phases_500":
          shot.phases = mk(500);
          break;
        case "phases_dup_keys":
          shot.phases = [mk(1)[0], { ...mk(1)[0], confidence: 0.9 }];
          break;
        case "checkpoints_obj":
          shot.checkpoints = { key: "cp" };
          break;
        case "checkpoints_1000":
          shot.checkpoints = Array.from({ length: 1000 }, (_, i) => ({
            key: `c${i}`,
            score: 50,
            confidence: 0.5,
            band: "green",
            direction: "hold",
            severity: 0.1,
            applicable: true,
          }));
          break;
        case "vv_arr":
          shot.versionVector = [];
          break;
        case "vv_str":
          shot.versionVector = "1.0.0";
          break;
        case "vv_empty":
          shot.versionVector = {};
          break;
        case "vv_missing":
          delete shot.versionVector;
          break;
        case "vv_extra_proto":
          for (const k of PROTO_KEYS) shot.versionVector[k] = "polluted";
          expectAccept = true;
          break;
        case "schema_version":
          shot.schemaVersion = pick(rng, [2, 99, "v3", 1e9, null, {}, "2026-09-01"]);
          shot.$schema = "https://example.invalid/shot/v99";
          expectAccept = true;
          break;
        case "extra_keys":
          for (let i = 0; i < 50; i++) shot[`extra_${i}`] = i;
          expectAccept = true;
          break;
        case "delete_key": {
          const k = pick(rng, SCALAR_FIELDS.concat(["phases", "checkpoints", "versionVector"]));
          delete shot[k];
          detail.deleted = k;
          break;
        }
        case "deep_extra": {
          let d = {};
          const root = d;
          for (let i = 0; i < 300; i++) {
            d.n = {};
            d = d.n;
          }
          shot.extra = root;
          expectAccept = true;
          break;
        }
        case "proto_top":
          for (const k of PROTO_KEYS) shot[k] = { polluted: true };
          expectAccept = true;
          break;
        default:
          break;
      }
      detail.op = op;
      text = JSON.stringify(shot);
      break;
    }
    case "identity": {
      const op = pick(rng, [
        "own_existing_id",
        "other_existing_id",
        "other_permit",
        "other_session",
        "finalized_permit",
        "expired_permit",
        "nil_id",
        "max_id",
        "hexonly_id",
        "self_as_permit",
      ]);
      detail.op = op;
      switch (op) {
        case "own_existing_id": {
          const ex = ctx.pickExisting(user);
          if (ex) {
            shot.id = ex;
            expectAccept = true;
            detail.note = "replay: accepted without a new row";
          }
          break;
        }
        case "other_existing_id": {
          const ex = ctx.pickExisting(other(user));
          if (ex) {
            shot.id = ex;
            expectAccept = false;
          }
          break;
        }
        case "other_permit":
          detail.permitOwner = other(user).id;
          expectAccept = false;
          break;
        case "other_session":
          shot.sessionId = other(user).sessionId;
          expectAccept = false;
          break;
        case "finalized_permit":
          detail.permitStatus = "finalized";
          expectAccept = false;
          break;
        case "expired_permit":
          detail.permitAge = "25 hours";
          expectAccept = false;
          break;
        case "nil_id":
          shot.id = "00000000-0000-0000-0000-000000000000";
          break;
        case "max_id":
          shot.id = "ffffffff-ffff-ffff-ffff-ffffffffffff";
          break;
        case "hexonly_id":
          shot.id = shot.id.replace(/-/g, "");
          break;
        case "self_as_permit":
          shot.analysisPermitId = user.id;
          expectAccept = false;
          break;
        default:
          break;
      }
      text = JSON.stringify(shot);
      break;
    }
    case "unicode_pair": {
      const pairs = [
        ["é", "e\u0301"],
        ["\u00c5", "\u212b"],
        ["ﬁ", "fi"],
        ["한", "한"],
        ["Ω", "Ω" /* U+2126 OHM */],
        ["ｄｉｎｋ", "dink"],
        ["dink", "DINK"],
        ["dink", "dink "],
        ["dink", "\u200bdink"],
      ];
      const [a, b] = pick(rng, pairs);
      shot.shotType = chance(rng, 0.5) ? a : b;
      detail = {
        form: shot.shotType === a ? "A" : "B",
        a: [...a].map((c) => c.codePointAt(0).toString(16)),
        b: [...b].map((c) => c.codePointAt(0).toString(16)),
      };
      expectAccept = true;
      text = JSON.stringify(shot);
      break;
    }
    case "dup_keys": {
      // jsonb keeps the LAST duplicate key; the second value is the effective one.
      const field = pick(rng, ["overallScore", "shotType", "resultKind", "id", "capturedAt"]);
      const second = pick(rng, [
        "50",
        '""',
        '"scored"',
        "null",
        '"' + "k".repeat(65) + '"',
        '"2100-01-01T00:00:00Z"',
      ]);
      const base = JSON.stringify(shot);
      text = base.slice(0, -1) + `,${JSON.stringify(field)}:${second}}`;
      detail = { field, second };
      break;
    }
    default:
      text = JSON.stringify(shot);
  }
  return { kind, detail, text, canary, shot, expectAccept };
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────
async function connect() {
  const c = new Client({ connectionString: PG_URL });
  await c.connect();
  return c;
}
async function asUser(holder, user, fn) {
  const client = holder.c;
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
    const r = await fn();
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    if ((e.code && e.code.startsWith("08")) || /terminated|closed|ECONN/.test(e.message ?? "")) {
      await client.end().catch(() => {});
      holder.c = await connect();
    }
    throw e;
  }
}
function errInfo(e, canary) {
  const fields = [e.message, e.detail, e.hint, e.where, e.internalQuery]
    .filter(Boolean)
    .join(" | ");
  return {
    sqlstate: e.code ?? null,
    routine: e.routine ?? null,
    where: e.where ? preview(e.where) : null,
    message: preview(e.message ?? String(e)),
    raisedInsideRpc: /function public\.apply_synced_shot/.test(e.where ?? ""),
    echoesCanary: canary ? fields.includes(canary) : false,
  };
}
async function counts(su) {
  const r = await su.query(`select
    (select count(*) from public.shots) as shots,
    (select count(*) from public.shot_phases) as phases,
    (select count(*) from public.shot_checkpoints) as checkpoints,
    (select count(*) from public.player_rank_state) as rank_rows,
    (select count(*) from public.analysis_permits where status <> 'reserved') as consumed_permits,
    (select count(*) from public.sessions) as sessions,
    (select count(*) from public.profiles) as profiles,
    (select count(*) from public.free_rating_ledger) as ledger`);
  const row = r.rows[0];
  for (const k of Object.keys(row)) row[k] = Number(row[k]);
  return row;
}
function delta(a, b) {
  const d = {};
  for (const k of Object.keys(a)) if (a[k] !== b[k]) d[k] = b[k] - a[k];
  return d;
}
async function storedRows(su, userId) {
  const r = await su.query(
    `select id, shot_type, overall_score::text as overall_score, result_kind, source,
            to_char(captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as captured_at
       from public.shots where user_id = $1`,
    [userId],
  );
  return r.rows;
}
async function rankState(su, userId) {
  const r = await su.query(
    "select rating::text as rating, tier, technique_count, scored_shot_count from public.player_rank_state where user_id = $1",
    [userId],
  );
  return r.rows[0] ?? null;
}
/** player_rank_state must equal computePlayerRank over the stored evidence. */
async function rankCheck(su, userId) {
  const rows = await storedRows(su, userId);
  const inputs = rows.map((r) => ({
    id: r.id,
    shotType: r.shot_type,
    overallScore: r.overall_score === null ? null : Number(r.overall_score),
    resultKind: r.result_kind,
    capturedAt: r.captured_at,
    source: r.source,
  }));
  const expected = computePlayerRank(inputs);
  const state = await rankState(su, userId);
  const problems = [];
  // Rows the SQL recompute counts (source='real', scored, score not null) but the
  // TS oracle's isCountable() refuses — the two are documented as bit-for-bit
  // equivalent, so any such row is itself a finding (and would otherwise poison
  // every later comparison for this user; the caller removes them).
  const oracleRejected = rows
    .filter((r) => r.source === "real" && r.result_kind === "scored" && r.overall_score !== null)
    .filter(
      (r) =>
        !(r.shot_type.length > 0 && Number(r.overall_score) >= 0 && Number(r.overall_score) <= 10),
    )
    .map((r) => ({ id: r.id, shot_type: r.shot_type, overall_score: r.overall_score }));
  if (oracleRejected.length)
    problems.push(
      `SQL counts ${oracleRejected.length} scored row(s) the TS oracle rejects: ${JSON.stringify(oracleRejected)}`,
    );
  if (expected === null && state !== null)
    problems.push(`state row exists but oracle says unranked: ${JSON.stringify(state)}`);
  if (expected !== null && state === null)
    problems.push(`oracle rating ${expected.rating} but no state row`);
  if (expected && state) {
    if (Number(state.rating) !== expected.rating)
      problems.push(`rating sql=${state.rating} oracle=${expected.rating}`);
    if (state.tier !== expected.tier)
      problems.push(`tier sql=${state.tier} oracle=${expected.tier}`);
    if (state.technique_count !== expected.techniqueCount)
      problems.push(
        `technique_count sql=${state.technique_count} oracle=${expected.techniqueCount}`,
      );
    if (state.scored_shot_count !== expected.scoredAnalysisCount)
      problems.push(
        `scored_shot_count sql=${state.scored_shot_count} oracle=${expected.scoredAnalysisCount}`,
      );
    if (playerRankTierForRating(Number(state.rating)).key !== state.tier)
      problems.push(`tier(rating) mismatch ${state.rating} → ${state.tier}`);
  }
  return {
    ok: problems.length === 0,
    problems,
    rows: rows.length,
    state,
    oracleRejected,
    oracle: expected && {
      rating: expected.rating,
      tier: expected.tier,
      techniqueCount: expected.techniqueCount,
      scoredAnalysisCount: expected.scoredAnalysisCount,
    },
  };
}
/** After a BROKEN rank check: drop oracle-rejected rows (owner path) so the
 * next iterations compare like with like, then verify the state is repairable
 * by a plain recompute. Recorded on the record as `repair`. */
async function repairRankDivergence(su, rec) {
  const checks = USERS.filter((u) => rec[`rank_${u.name}`]).map((u) => [
    u.name,
    rec[`rank_${u.name}`],
  ]);
  if (rec.rankCheck) checks.push([rec.user, rec.rankCheck]);
  for (const [who, rc] of checks) {
    if (!rc || rc.ok) continue;
    const userId = USERS.find((u) => u.name === who)?.id ?? who;
    const removed = [];
    for (const row of rc.oracleRejected ?? []) {
      await su.query("delete from public.shots where id = $1", [row.id]);
      removed.push(row.id);
    }
    await su.query("select public.recompute_player_rank($1)", [userId]);
    const after = await rankCheck(su, userId);
    rec.repair = {
      ...(rec.repair ?? {}),
      [who]: {
        removedOracleRejected: removed,
        recomputeRestoresParity: after.ok,
        problemsAfter: after.problems,
      },
    };
  }
}
/** Structural sanity of a stored shot row against the documented bounds. */
async function rowSanity(su, shotId, expectedOwner) {
  const r = await su.query(
    `select user_id, shot_type, camera_view, result_kind, source, overall_score::text as overall_score,
            analysis_confidence::text as conf, captured_at, start_ms, contact_ms, end_ms,
            length(shot_type) as st_len, octet_length(shot_type) as st_bytes
       from public.shots where id = $1`,
    [shotId],
  );
  if (r.rowCount !== 1)
    return { ok: false, problems: [`expected exactly 1 row for ${shotId}, got ${r.rowCount}`] };
  const s = r.rows[0];
  const problems = [];
  if (s.user_id !== expectedOwner) problems.push(`owner ${s.user_id} != caller ${expectedOwner}`);
  if (s.st_len > 64) problems.push(`shot_type length ${s.st_len} > 64`);
  if (s.shot_type.trim().length === 0)
    problems.push(
      `empty/whitespace shot_type stored as ${JSON.stringify(s.shot_type)} (edge parseSyncShot rejects it; SQL rank counts it as a technique)`,
    );
  if (!["side", "rear_oblique"].includes(s.camera_view) && s.camera_view !== null)
    problems.push(`camera_view ${s.camera_view}`);
  if (!["scored", "low_confidence"].includes(s.result_kind))
    problems.push(`result_kind ${s.result_kind}`);
  if (s.source !== "real") problems.push(`source ${s.source}`);
  if (s.result_kind === "scored" && s.overall_score === null) problems.push("scored without score");
  if (s.result_kind === "low_confidence" && s.overall_score !== null)
    problems.push("low_confidence with score");
  if (s.overall_score !== null) {
    const v = Number(s.overall_score);
    if (!Number.isFinite(v) || v < 0 || v > 10)
      problems.push(`overall_score ${s.overall_score} outside 0..10`);
  }
  const conf = Number(s.conf);
  if (!Number.isFinite(conf) || conf < 0 || conf > 1)
    problems.push(`analysis_confidence ${s.conf}`);
  const t = s.captured_at.getTime();
  if (!(t >= Date.UTC(2000, 0, 1) && t < Date.UTC(2100, 0, 1)))
    problems.push(`captured_at ${s.captured_at.toISOString()} out of bounds`);
  return {
    ok: problems.length === 0,
    problems,
    row: { ...s, captured_at: s.captured_at.toISOString() },
  };
}

const KNOWN_CODES = new Set([
  "accepted",
  "auth.required",
  "access.permit_not_found",
  "access.permit_not_reserved",
  "access.permit_expired",
  "access.paywall_required",
  "shot.session_not_found",
  "shot.id_conflict",
]);
const RPC_CODE_RE = /^(shot\.write_failed:[0-9A-Z]{5}|[a-z]+\.[a-z_]+|accepted)$/;
// Typed, payload-independent rejections from Postgres itself (parameter cast /
// JSON parse / constraint / privilege). Anything else raised is suspicious.
const GRACEFUL_SQLSTATES = new Set([
  "22P02",
  "22P05",
  "22P03",
  "22003",
  "22007",
  "22008",
  "22001",
  "22023",
  "23514",
  "23502",
  "23503",
  "23505",
  "42501",
  "54001",
  "0A000",
  "22P06",
  "22021",
  "22P04",
  "22P01",
  "08P01",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Scenario runners
// ─────────────────────────────────────────────────────────────────────────────
async function preparePermit(su, user, shot, detail) {
  const permitOwner = detail.permitOwner ?? user.id;
  const permitId =
    typeof shot.analysisPermitId === "string" && /^[0-9a-f-]{36}$/i.test(shot.analysisPermitId)
      ? shot.analysisPermitId
      : null;
  if (!permitId || permitId === user.id) return null;
  const status = detail.permitStatus ?? "reserved";
  const created = detail.permitAge ? `now() - interval '${detail.permitAge}'` : "now()";
  await su.query(
    `insert into public.analysis_permits (id, user_id, idempotency_key, status, created_at)
       values ($1, $2, $3, $4, ${created}) on conflict (id) do nothing`,
    [permitId, permitOwner, `k-${permitId}`, status],
  );
  return permitId;
}

async function runRpcCase(i, seedText, rng, su, holder, ctx) {
  const user = pick(rng, USERS);
  const c = genRpcCase(rng, user, { seed: seedText, pickExisting: ctx.pickExisting });
  const permitId = await preparePermit(su, user, c.shot, c.detail);
  // A shot id this user already stored (any earlier iteration) makes a resend a
  // replay: `accepted`, no new row — the documented idempotent path.
  const preOwned =
    typeof c.shot.id === "string"
      ? (
          await su
            .query(
              "select 1 from public.shots where user_id = $1 and id::text = lower(regexp_replace($2, '[{}]|urn:uuid:|\\s', '', 'g'))",
              [user.id, c.shot.id],
            )
            .catch(() => ({ rowCount: 0 }))
        ).rowCount === 1
      : false;
  const before = await counts(su);
  let outcome;
  try {
    const r = await asUser(holder, user.id, () =>
      holder.c.query("select public.apply_synced_shot($1::jsonb) as r", [c.text]),
    );
    outcome = { type: "rpc_result", value: r.rows[0].r };
  } catch (e) {
    outcome = { type: "error", ...errInfo(e, c.canary) };
  }
  const after = await counts(su);
  const d = delta(before, after);
  const rec = {
    i,
    seed: seedText,
    category: "rpc",
    kind: c.kind,
    user: user.name,
    detail: c.detail,
    permitId,
    payload: preview(c.text),
    payloadSha16: sha(c.text),
    payloadBytes: Buffer.byteLength(c.text),
    expectAccept: c.expectAccept,
    outcome,
    delta: d,
    verdict: "HELD",
    reasons: [],
  };
  if (outcome.type === "rpc_result") {
    const v = outcome.value;
    if (typeof v !== "string" || !RPC_CODE_RE.test(v))
      rec.reasons.push(`non-stable return value: ${preview(String(v))}`);
    if (v === "accepted") {
      const shotId = typeof c.shot.id === "string" ? c.shot.id : null;
      const wroteNew = (d.shots ?? 0) === 1;
      const replay = c.detail.op === "own_existing_id" || preOwned;
      if (preOwned) rec.detail = { ...rec.detail, preOwned: true };
      if (!wroteNew && !replay) rec.reasons.push(`accepted but shots delta ${JSON.stringify(d)}`);
      if (wroteNew && replay) rec.reasons.push("replay wrote a new row");
      if (
        Object.keys(d).some(
          (k) =>
            !["shots", "phases", "checkpoints", "rank_rows", "consumed_permits", "ledger"].includes(
              k,
            ),
        )
      )
        rec.reasons.push(`unexpected table delta ${JSON.stringify(d)}`);
      if (shotId && wroteNew) {
        // hex-only / braces / uppercase ids are canonicalised by Postgres
        const idRow = await su
          .query(
            "select id from public.shots where id::text = lower(regexp_replace($1, '[{}]|urn:uuid:|\\s', '', 'g')) or id::text = $1",
            [shotId],
          )
          .catch(() => ({ rows: [] }));
        const storedId = idRow.rows[0]?.id ?? shotId;
        const sane = await rowSanity(su, storedId, user.id);
        rec.rowSanity = sane;
        if (!sane.ok) rec.reasons.push(...sane.problems.map((p) => `row: ${p}`));
        ctx.remember(user, storedId);
      }
      const rc = await rankCheck(su, user.id);
      rec.rankCheck = rc;
      if (!rc.ok) rec.reasons.push(...rc.problems.map((p) => `rank: ${p}`));
      if (c.expectAccept === false) rec.reasons.push("accepted but expected rejection");
    } else {
      if (!KNOWN_CODES.has(v) && !/^shot\.write_failed:[0-9A-Z]{5}$/.test(v))
        rec.reasons.push(`unknown code ${preview(String(v))}`);
      const allowed =
        v === "access.permit_expired" || v === "access.paywall_required"
          ? ["consumed_permits"]
          : [];
      if (Object.keys(d).some((k) => !allowed.includes(k)))
        rec.reasons.push(`rejected (${v}) but wrote: ${JSON.stringify(d)}`);
      if (c.expectAccept === true) rec.reasons.push(`expected accepted, got ${v}`);
    }
  } else {
    if (outcome.raisedInsideRpc)
      rec.reasons.push(
        `error raised out of apply_synced_shot: ${outcome.sqlstate} ${outcome.message}`,
      );
    if (!GRACEFUL_SQLSTATES.has(outcome.sqlstate))
      rec.reasons.push(`unexpected SQLSTATE ${outcome.sqlstate}: ${outcome.message}`);
    if (Object.keys(d).length) rec.reasons.push(`error but wrote: ${JSON.stringify(d)}`);
    if (c.expectAccept === true)
      rec.reasons.push(`expected accepted, got error ${outcome.sqlstate}`);
  }
  if (rec.reasons.length) rec.verdict = "BROKEN";
  return rec;
}

const SCORE_STRINGS = [
  "10.005",
  "10.004",
  "9.995",
  "-0.001",
  "-0.005",
  "0",
  "10",
  "NaN",
  "Infinity",
  "-Infinity",
  "-0",
  "1e-10",
  "9.999",
  "0.004",
  "0.005",
  "10.00",
  "0.00",
  "7.125",
  "7.135",
  "5",
  "1e1",
  "1e2",
  "99999",
  "-1",
  "10.01",
  "abc",
  "",
  "0x10",
  " 5 ",
  "5.5.5",
];
const CONF_STRINGS = [
  "0",
  "1",
  "1.00001",
  "0.99995",
  "0.99994",
  "-0.00001",
  "NaN",
  "Infinity",
  "1e-10",
  "0.5",
  "-0",
  "1.0000",
  "2",
];

async function runDirectInsert(i, seedText, rng, su, holder, ctx) {
  const user = pick(rng, USERS);
  const op = weighted(rng, [
    ["score_boundary", 8],
    ["time_boundary", 6],
    ["shot_type_boundary", 6],
    ["low_conf_with_score", 2],
    ["other_owner", 3],
    ["fixture_source", 2],
    ["conf_boundary", 3],
    ["ms_boundary", 3],
    ["camera_view", 2],
    ["scored_no_permit", 2],
    ["valid", 6],
  ]);
  const scored = [
    "score_boundary",
    "valid",
    "scored_no_permit",
    "conf_boundary",
    "ms_boundary",
    "time_boundary",
    "shot_type_boundary",
    "camera_view",
  ].includes(op)
    ? chance(rng, 0.7)
    : op !== "low_conf_with_score";
  const row = {
    id: uuidFrom(rng),
    user_id: user.id,
    session_id: chance(rng, 0.5) ? user.sessionId : null,
    shot_type: pick(rng, TECHNIQUES),
    camera_view: pick(rng, ["side", "rear_oblique"]),
    captured_at: isoMs(rng),
    start_ms: int(rng, 0, 5000),
    contact_ms: chance(rng, 0.8) ? int(rng, 0, 5000) : null,
    end_ms: int(rng, 0, 5000),
    overall_score: scored ? String(round2(rng() * 10)) : null,
    analysis_confidence: String(round4(rng())),
    result_kind: scored ? "scored" : "low_confidence",
    source: "real",
  };
  const detail = { op };
  switch (op) {
    case "score_boundary":
      row.result_kind = "scored";
      row.overall_score = pick(rng, SCORE_STRINGS);
      detail.value = row.overall_score;
      break;
    case "time_boundary":
      row.captured_at = pick(rng, TIME_STRINGS);
      detail.value = row.captured_at;
      break;
    case "shot_type_boundary": {
      const [k, v] = stringPool(rng);
      row.shot_type = v;
      detail.stringKind = k;
      detail.value = preview(v);
      detail.codepoints = [...v].length;
      break;
    }
    case "low_conf_with_score":
      row.result_kind = "low_confidence";
      row.overall_score = "5.00";
      break;
    case "other_owner":
      row.user_id = other(user).id;
      break;
    case "fixture_source":
      row.source = pick(rng, ["fixture", "synthetic", "REAL", "", "real "]);
      detail.value = row.source;
      break;
    case "conf_boundary":
      row.analysis_confidence = pick(rng, CONF_STRINGS);
      detail.value = row.analysis_confidence;
      break;
    case "ms_boundary": {
      const v = pick(rng, [
        "2147483647",
        "2147483648",
        "-2147483648",
        "-2147483649",
        "-1",
        "0",
        "NaN",
        "1e3",
        "1.5",
        "9007199254740993",
      ]);
      const f = pick(rng, ["start_ms", "contact_ms", "end_ms"]);
      row[f] = v;
      detail.field = f;
      detail.value = v;
      break;
    }
    case "camera_view":
      row.camera_view = pick(rng, ["Side", "top", "", null, "rear_oblique ", "x".repeat(65)]);
      detail.value = row.camera_view;
      break;
    case "scored_no_permit":
      row.result_kind = "scored";
      row.overall_score = "6.5";
      detail.note = "no reserved permit for this user at insert time";
      break;
    default:
      break;
  }
  // A scored client write needs a live reserved permit (table-layer gate).
  const needsPermit = row.result_kind === "scored" && op !== "scored_no_permit";
  let permitId = null;
  if (needsPermit) {
    permitId = uuidFrom(rng);
    await su.query(
      "insert into public.analysis_permits (id, user_id, idempotency_key) values ($1, $2, $3)",
      [permitId, user.id, `d-${permitId}`],
    );
  } else if (op === "scored_no_permit") {
    await su.query(
      "update public.analysis_permits set status = 'released', outcome = 'cancelled' where user_id = $1 and status = 'reserved'",
      [user.id],
    );
  }
  const before = await counts(su);
  const sql = `insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
      overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version, paddle_model_version,
      stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
    values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz, $7::int, $8::int, $9::int, $10::numeric, $11::numeric, $12,
      'app-1', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1', $13)`;
  const params = [
    row.id,
    row.user_id,
    row.session_id,
    row.shot_type,
    row.camera_view,
    row.captured_at,
    row.start_ms,
    row.contact_ms,
    row.end_ms,
    row.overall_score,
    row.analysis_confidence,
    row.result_kind,
    row.source,
  ];
  let outcome;
  try {
    await asUser(holder, user.id, () => holder.c.query(sql, params));
    outcome = { type: "inserted" };
  } catch (e) {
    outcome = { type: "error", ...errInfo(e, null) };
  }
  const after = await counts(su);
  const d = delta(before, after);
  const rec = {
    i,
    seed: seedText,
    category: "direct_insert",
    kind: op,
    user: user.name,
    detail,
    permitId,
    payload: preview(JSON.stringify(row)),
    outcome,
    delta: d,
    verdict: "HELD",
    reasons: [],
  };
  if (outcome.type === "inserted") {
    if ((d.shots ?? 0) !== 1) rec.reasons.push(`inserted but shots delta ${JSON.stringify(d)}`);
    const sane = await rowSanity(su, row.id, user.id);
    rec.rowSanity = sane;
    if (!sane.ok) rec.reasons.push(...sane.problems.map((p) => `row: ${p}`));
    if (op === "other_owner") rec.reasons.push("RLS: inserted a row owned by another user");
    if (op === "low_conf_with_score") rec.reasons.push("low_confidence row stored with a score");
    if (op === "fixture_source") rec.reasons.push(`source ${row.source} stored`);
    if (op === "scored_no_permit") rec.reasons.push("scored row stored without a live permit");
    ctx.remember(user, row.id);
    const rc = await rankCheck(su, user.id);
    rec.rankCheck = rc;
    if (!rc.ok) rec.reasons.push(...rc.problems.map((p) => `rank: ${p}`));
  } else {
    if (!GRACEFUL_SQLSTATES.has(outcome.sqlstate))
      rec.reasons.push(`unexpected SQLSTATE ${outcome.sqlstate}: ${outcome.message}`);
    if (Object.keys(d).length) rec.reasons.push(`error but wrote: ${JSON.stringify(d)}`);
    if (op === "valid")
      rec.reasons.push(`valid direct insert refused: ${outcome.sqlstate} ${outcome.message}`);
  }
  if (rec.reasons.length) rec.verdict = "BROKEN";
  return rec;
}

const TIER_INPUTS = [
  "3.49",
  "3.5",
  "3.499",
  "3.50",
  "4.99",
  "5",
  "5.0",
  "6.49",
  "6.5",
  "7.49",
  "7.5",
  "7.499",
  "0",
  "10",
  "-1",
  "11",
  "NaN",
  "Infinity",
  "-Infinity",
  null,
  "-0",
  "3.4999999999",
  "7.4999999999999999999",
  "1e1",
  "1e-9",
  "0.005",
  "9.995",
];
async function runTierFn(i, seedText, rng, su, holder) {
  const user = pick(rng, USERS);
  const input = chance(rng, 0.6) ? pick(rng, TIER_INPUTS) : String(round2(rng() * 10));
  let outcome;
  try {
    const r = await asUser(holder, user.id, () =>
      holder.c.query("select public.player_rank_tier($1::numeric) as t", [input]),
    );
    outcome = { type: "value", value: r.rows[0].t };
  } catch (e) {
    outcome = { type: "error", ...errInfo(e, null) };
  }
  const rec = {
    i,
    seed: seedText,
    category: "tier_fn",
    kind: "player_rank_tier",
    user: user.name,
    detail: { input },
    outcome,
    verdict: "HELD",
    reasons: [],
  };
  if (outcome.type === "value") {
    const n = input === null ? null : Number(input);
    const tsTier = input === null ? null : playerRankTierForRating(n).key;
    rec.detail.tsOracle = tsTier;
    if (input !== null && Number.isFinite(n) && tsTier !== outcome.value)
      rec.reasons.push(`tier sql=${outcome.value} ts=${tsTier} for ${input}`);
    if (input !== null && !Number.isFinite(n) && tsTier !== outcome.value)
      rec.reasons.push(`non-finite input ${input}: sql=${outcome.value} ts=${tsTier}`);
    // NULL never reaches the function from recompute_player_rank (it guards
    // v_rating is null); recorded, not judged.
    if (input === null)
      rec.detail.note = `NULL → ${JSON.stringify(outcome.value)} (unreachable from recompute_player_rank)`;
  } else if (!GRACEFUL_SQLSTATES.has(outcome.sqlstate))
    rec.reasons.push(`unexpected SQLSTATE ${outcome.sqlstate}`);
  if (rec.reasons.length) rec.verdict = "BROKEN";
  return rec;
}

async function runPrivilegeProbe(i, seedText, rng, su, holder, ctx) {
  const user = pick(rng, USERS);
  const op = pick(rng, [
    "recompute_self",
    "recompute_other",
    "recompute_nil",
    "trigger_fn_direct",
    "rank_insert",
    "rank_update",
    "rank_delete",
    "owner_recompute_idempotent",
    "owner_recompute_unknown",
  ]);
  const before = await counts(su);
  const stateBefore = await rankState(su, user.id);
  let outcome;
  try {
    switch (op) {
      case "recompute_self":
        await asUser(holder, user.id, () =>
          holder.c.query("select public.recompute_player_rank($1::uuid)", [user.id]),
        );
        break;
      case "recompute_other":
        await asUser(holder, user.id, () =>
          holder.c.query("select public.recompute_player_rank($1::uuid)", [other(user).id]),
        );
        break;
      case "recompute_nil":
        await asUser(holder, user.id, () =>
          holder.c.query("select public.recompute_player_rank(null)"),
        );
        break;
      case "trigger_fn_direct":
        await asUser(holder, user.id, () =>
          holder.c.query("select public.handle_shot_rank_refresh()"),
        );
        break;
      case "rank_insert":
        await asUser(holder, user.id, () =>
          holder.c.query(
            "insert into public.player_rank_state (user_id, rating, tier, technique_count, scored_shot_count) values ($1, 9.99, 'diamond', 1, 1)",
            [user.id],
          ),
        );
        break;
      case "rank_update":
        await asUser(holder, user.id, () =>
          holder.c.query(
            "update public.player_rank_state set rating = 10, tier = 'diamond' where user_id = $1",
            [user.id],
          ),
        );
        break;
      case "rank_delete":
        await asUser(holder, user.id, () =>
          holder.c.query("delete from public.player_rank_state where user_id = $1", [user.id]),
        );
        break;
      case "owner_recompute_idempotent":
        await su.query("select public.recompute_player_rank($1::uuid)", [user.id]);
        break;
      case "owner_recompute_unknown":
        await su.query("select public.recompute_player_rank($1::uuid)", [uuidFrom(rng)]);
        break;
      default:
        break;
    }
    outcome = { type: "ok" };
  } catch (e) {
    outcome = { type: "error", ...errInfo(e, null) };
  }
  const after = await counts(su);
  const stateAfter = await rankState(su, user.id);
  const d = delta(before, after);
  const rec = {
    i,
    seed: seedText,
    category: "privilege",
    kind: op,
    user: user.name,
    outcome,
    delta: d,
    verdict: "HELD",
    reasons: [],
  };
  const clientOps = [
    "recompute_self",
    "recompute_other",
    "recompute_nil",
    "trigger_fn_direct",
    "rank_insert",
    "rank_update",
    "rank_delete",
  ];
  if (clientOps.includes(op)) {
    if (outcome.type === "ok") {
      // UPDATE/DELETE with zero matching rows is a silent no-op; RLS/grant must still deny
      rec.reasons.push(`${op} as authenticated succeeded`);
    } else if (!["42501", "0A000", "22004"].includes(outcome.sqlstate))
      rec.reasons.push(`expected 42501/0A000, got ${outcome.sqlstate}: ${outcome.message}`);
    if (JSON.stringify(stateBefore) !== JSON.stringify(stateAfter))
      rec.reasons.push("client op changed rank state");
  } else {
    if (outcome.type !== "ok") rec.reasons.push(`owner recompute failed ${outcome.sqlstate}`);
    if (JSON.stringify(stateBefore) !== JSON.stringify(stateAfter))
      rec.reasons.push(
        `owner recompute changed state: ${JSON.stringify(stateBefore)} → ${JSON.stringify(stateAfter)}`,
      );
    const rc = await rankCheck(su, user.id);
    if (!rc.ok) rec.reasons.push(...rc.problems.map((p) => `rank: ${p}`));
  }
  if (Object.keys(d).length) rec.reasons.push(`wrote: ${JSON.stringify(d)}`);
  if (rec.reasons.length) rec.verdict = "BROKEN";
  return rec;
}

const SUB_VARIANTS = (u) => [
  ["valid", u.id],
  ["upper", u.id.toUpperCase()],
  ["braces", `{${u.id}}`],
  ["urn", `urn:uuid:${u.id}`],
  ["hexonly", u.id.replace(/-/g, "")],
  ["spaces", ` ${u.id} `],
  ["empty", ""],
  ["not_uuid", "not-a-uuid"],
  ["traversal", "../../etc/passwd"],
  ["kb64", "a".repeat(65536)],
  ["injection", `${u.id}' or 1=1 --`],
  ["nil", "00000000-0000-0000-0000-000000000000"],
  ["json", JSON.stringify({ sub: u.id })],
  ["null_literal", "null"],
  ["unicode", "\u202e" + u.id],
  ["truncated", u.id.slice(0, 35)],
];
async function runRlsProbe(i, seedText, rng, su, holder) {
  const user = pick(rng, USERS);
  const [variant, sub] = pick(rng, SUB_VARIANTS(user));
  const query = pick(rng, [
    "select user_id from public.player_rank_state",
    "select user_id from public.player_technique_rating",
    "select user_id from public.shots",
    "select user_id from public.player_rank_state where user_id = $other",
    "select user_id from public.player_technique_rating where user_id = $other",
  ]).replace("$other", `'${other(user).id}'`);
  let outcome;
  try {
    const r = await asUser(holder, sub, () => holder.c.query(query));
    outcome = {
      type: "rows",
      owners: [...new Set(r.rows.map((x) => x.user_id))],
      count: r.rowCount,
    };
  } catch (e) {
    outcome = { type: "error", ...errInfo(e, null) };
  }
  const rec = {
    i,
    seed: seedText,
    category: "rls",
    kind: variant,
    user: user.name,
    detail: { sub: preview(sub), query },
    outcome,
    verdict: "HELD",
    reasons: [],
  };
  const selfResolving = ["valid", "upper", "braces", "urn", "hexonly", "spaces"];
  if (outcome.type === "rows") {
    const foreign = outcome.owners.filter((o) => o !== user.id);
    if (foreign.length) rec.reasons.push(`rows of another user visible: ${foreign.join(",")}`);
    if (!selfResolving.includes(variant) && outcome.count > 0)
      rec.reasons.push(`malformed sub '${variant}' returned ${outcome.count} rows`);
  } else if (!["22P02", "22001"].includes(outcome.sqlstate))
    rec.reasons.push(`unexpected SQLSTATE ${outcome.sqlstate}: ${outcome.message}`);
  if (rec.reasons.length) rec.verdict = "BROKEN";
  return rec;
}

/** Owner-side (service/operator) mutations drive the UPDATE/DELETE branches of handle_shot_rank_refresh. */
async function runOwnerMutation(i, seedText, rng, su, ctx) {
  const user = pick(rng, USERS);
  const shotId = ctx.pickExisting(user);
  const op = pick(rng, [
    "update_score",
    "update_score_boundary",
    "move_user",
    "toggle_kind",
    "delete",
    "update_captured_at",
    "update_shot_type",
    "update_noop",
  ]);
  const rec = {
    i,
    seed: seedText,
    category: "owner_mutation",
    kind: op,
    user: user.name,
    detail: { shotId },
    verdict: "HELD",
    reasons: [],
  };
  if (!shotId) {
    rec.kind = "skipped_no_rows";
    rec.outcome = { type: "skipped" };
    return rec;
  }
  const before = await counts(su);
  let outcome;
  try {
    switch (op) {
      case "update_score":
        await su.query(
          "update public.shots set overall_score = $2, result_kind = 'scored' where id = $1",
          [shotId, String(round2(rng() * 10))],
        );
        break;
      case "update_score_boundary": {
        const v = pick(rng, SCORE_STRINGS);
        rec.detail.value = v;
        await su.query(
          "update public.shots set overall_score = $2::numeric, result_kind = 'scored' where id = $1",
          [shotId, v],
        );
        break;
      }
      case "move_user":
        rec.detail.to = other(user).name;
        await su.query("update public.shots set user_id = $2 where id = $1", [
          shotId,
          other(user).id,
        ]);
        ctx.forget(user, shotId);
        ctx.remember(other(user), shotId);
        break;
      case "toggle_kind":
        await su.query(
          "update public.shots set result_kind = 'low_confidence', overall_score = null where id = $1",
          [shotId],
        );
        break;
      case "delete":
        await su.query("delete from public.shots where id = $1", [shotId]);
        ctx.forget(user, shotId);
        break;
      case "update_captured_at": {
        const v = pick(rng, TIME_STRINGS);
        rec.detail.value = v;
        await su.query("update public.shots set captured_at = $2::timestamptz where id = $1", [
          shotId,
          v,
        ]);
        break;
      }
      case "update_shot_type": {
        const [k, v] = stringPool(rng);
        rec.detail.stringKind = k;
        rec.detail.value = preview(v);
        await su.query("update public.shots set shot_type = $2 where id = $1", [shotId, v]);
        break;
      }
      case "update_noop":
        await su
          .query("update public.shots set updated_at = updated_at where id = $1", [shotId])
          .catch(async () =>
            su.query("update public.shots set shot_type = shot_type where id = $1", [shotId]),
          );
        break;
      default:
        break;
    }
    outcome = { type: "ok" };
  } catch (e) {
    outcome = { type: "error", ...errInfo(e, null) };
  }
  const after = await counts(su);
  rec.outcome = outcome;
  rec.delta = delta(before, after);
  if (outcome.type === "error" && !GRACEFUL_SQLSTATES.has(outcome.sqlstate))
    rec.reasons.push(`unexpected SQLSTATE ${outcome.sqlstate}: ${outcome.message}`);
  if (
    outcome.type === "error" &&
    ["update_score", "move_user", "toggle_kind", "delete", "update_noop"].includes(op)
  )
    rec.reasons.push(`owner ${op} failed ${outcome.sqlstate}: ${outcome.message}`);
  for (const u of USERS) {
    const rc = await rankCheck(su, u.id);
    rec[`rank_${u.name}`] = rc;
    if (!rc.ok) rec.reasons.push(...rc.problems.map((p) => `rank(${u.name}): ${p}`));
  }
  if (rec.reasons.length) rec.verdict = "BROKEN";
  return rec;
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency: N independent connections, READ COMMITTED, barrier-released
// ─────────────────────────────────────────────────────────────────────────────
async function runConcurrencyRound(round, su, ctx, results) {
  const seedText = `${SEED}#conc${round}`;
  const rng = rngFor(seedText);
  const lanes = await Promise.all(Array.from({ length: LANES }, () => connect()));
  const plan = [];
  // 0: mixed users valid+malformed RPC; 1: same-shot duplicate race; 2: owner-path
  // direct inserts (no advisory lock); 3: one user's RPC scored syncs racing that
  // user's own direct low_confidence inserts (the client path that skips the lock)
  const mode = round % 4;
  const rec = {
    i: `conc${round}`,
    seed: seedText,
    category: "concurrency",
    kind: ["mixed_rpc", "duplicate_sync_race", "owner_parallel_insert", "client_lowconf_vs_rpc"][
      mode
    ],
    lanes: LANES,
    verdict: "HELD",
    reasons: [],
    lanesOut: [],
  };
  try {
    if (mode === 1) {
      const user = pick(rng, USERS);
      const shot = validShot(rng, user, `canary-${sha(seedText)}`);
      await preparePermit(su, user, shot, {});
      const text = JSON.stringify(shot);
      for (let l = 0; l < LANES; l++)
        plan.push({ user, text, expectAccept: true, shotId: shot.id, kind: "dup" });
    } else if (mode === 2) {
      const user = pick(rng, USERS);
      for (let l = 0; l < LANES; l++)
        plan.push({
          user,
          kind: "owner_insert",
          id: uuidFrom(rng),
          shotType: pick(rng, TECHNIQUES),
          score: String(round2(rng() * 10)),
          at: isoMs(rng),
        });
    } else if (mode === 3) {
      const user = pick(rng, USERS);
      for (let l = 0; l < LANES; l++) {
        if (l % 2 === 0) {
          const canary = `canary-${sha(`${seedText}:${l}`)}`;
          const shot = validShot(rng, user, canary);
          shot.resultKind = "scored";
          shot.overallScore = round2(rng() * 10);
          await preparePermit(su, user, shot, {});
          plan.push({
            user,
            text: JSON.stringify(shot),
            expectAccept: true,
            kind: "valid",
            shotId: shot.id,
            canary,
          });
        } else {
          plan.push({
            user,
            kind: "client_lowconf_insert",
            id: uuidFrom(rng),
            shotType: pick(rng, TECHNIQUES),
            at: isoMs(rng),
          });
        }
      }
    } else {
      for (let l = 0; l < LANES; l++) {
        const user = USERS[l % 2];
        const c = genRpcCase(rng, user, {
          seed: `${seedText}:${l}`,
          pickExisting: ctx.pickExisting,
        });
        await preparePermit(su, user, c.shot, c.detail);
        plan.push({
          user,
          text: c.text,
          expectAccept: c.expectAccept,
          kind: c.kind,
          shotId: typeof c.shot.id === "string" ? c.shot.id : null,
          canary: c.canary,
        });
      }
    }
    const before = await counts(su);
    // barrier: every lane has its transaction + role set, then all fire together
    await Promise.all(
      lanes.map(async (lane, l) => {
        await lane.query("begin isolation level read committed");
        if (plan[l].kind !== "owner_insert") {
          await lane.query("set local role authenticated");
          await lane.query("select set_config('request.jwt.claim.sub', $1, true)", [
            plan[l].user.id,
          ]);
        }
      }),
    );
    const outs = await Promise.all(
      lanes.map(async (lane, l) => {
        const p = plan[l];
        const t0 = Date.now();
        try {
          let value;
          if (p.kind === "owner_insert") {
            await lane.query(
              `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind,
            app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
            values ($1, $2, $3, 'side', $4::timestamptz, 0, 1, 2, $5::numeric, 0.9, 'scored', 'a','b','c','d','e','f','g','h','real')`,
              [p.id, p.user.id, p.shotType, p.at, p.score],
            );
            value = "inserted";
          } else if (p.kind === "client_lowconf_insert") {
            await lane.query(
              `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind,
            app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
            values ($1, $2, $3, 'side', $4::timestamptz, 0, 1, 2, null, 0.2, 'low_confidence', 'a','b','c','d','e','f','g','h','real')`,
              [p.id, p.user.id, p.shotType, p.at],
            );
            value = "inserted";
          } else {
            const r = await lane.query(
              "select public.apply_synced_shot($1::jsonb) as r, clock_timestamp() as t",
              [p.text],
            );
            value = r.rows[0].r;
          }
          await lane.query("commit");
          return { lane: l, user: p.user.name, kind: p.kind, value, ms: Date.now() - t0 };
        } catch (e) {
          await lane.query("rollback").catch(() => {});
          return {
            lane: l,
            user: p.user.name,
            kind: p.kind,
            error: errInfo(e, p.canary),
            ms: Date.now() - t0,
          };
        }
      }),
    );
    rec.lanesOut = outs;
    const after = await counts(su);
    rec.delta = delta(before, after);
    for (const [l, o] of outs.entries()) {
      const p = plan[l];
      if (o.error?.raisedInsideRpc)
        rec.reasons.push(`lane ${l}: raised out of RPC ${o.error.sqlstate}`);
      if (p.expectAccept === true && o.value !== "accepted")
        rec.reasons.push(`lane ${l}: expected accepted, got ${o.value ?? o.error?.sqlstate}`);
      if (
        (p.kind === "owner_insert" || p.kind === "client_lowconf_insert") &&
        o.value !== "inserted"
      )
        rec.reasons.push(`lane ${l}: ${p.kind} failed ${o.error?.sqlstate} ${o.error?.message}`);
      if (o.value === "accepted" && p.shotId) ctx.remember(p.user, p.shotId);
      if (o.value === "inserted" && p.id) ctx.remember(p.user, p.id);
    }
    if (mode === 1) {
      const n = await su.query("select count(*)::int as n from public.shots where id = $1", [
        plan[0].shotId,
      ]);
      if (n.rows[0].n !== 1) rec.reasons.push(`duplicate race stored ${n.rows[0].n} rows`);
      rec.detail = { shotId: plan[0].shotId, storedRows: n.rows[0].n };
    }
    for (const u of USERS) {
      const rc = await rankCheck(su, u.id);
      rec[`rank_${u.name}`] = rc;
      if (!rc.ok) rec.reasons.push(...rc.problems.map((p) => `rank(${u.name}): ${p}`));
    }
    const cross = await su.query(
      "select count(*)::int as n from public.shots s join public.player_rank_state r on r.user_id = s.user_id where s.user_id not in ($1, $2)",
      [ALICE, BOB],
    );
    if (cross.rows[0].n !== 0) rec.reasons.push("rows for unknown users");
    if ((mode === 2 || mode === 3) && rec.reasons.length) {
      // Is the drift repairable? A from-scratch recompute must restore agreement.
      await su.query("select public.recompute_player_rank($1)", [plan[0].user.id]);
      const rc = await rankCheck(su, plan[0].user.id);
      rec.afterRecompute = rc;
    }
  } finally {
    await Promise.all(lanes.map((l) => l.end().catch(() => {})));
  }
  if (rec.reasons.length) rec.verdict = "BROKEN";
  results.push(rec);
  return rec;
}

/**
 * Deterministic two-connection interleaving of the rank trigger (the racy
 * shape the barrier rounds only hit by chance):
 *   A: begin; <scored write>            -- trigger recomputed rank incl. A's shot; holds the rank row lock
 *   B: begin; <write w/o advisory lock>  -- trigger's SELECT cannot see A; its upsert blocks on A's row lock
 *   A: commit
 *   B: unblocks → ON CONFLICT DO UPDATE with the STALE numbers; commit
 * Post: player_rank_state must still equal computePlayerRank(all committed rows).
 * `path` = "client" (A = authenticated apply_synced_shot, B = authenticated direct
 * low_confidence INSERT — the granted client path that skips the advisory lock)
 * or "owner" (both lanes are owner/service-role scored INSERTs).
 */
async function runInterleave(su, ctx, results, path, isolation, tag) {
  const seedText = `${SEED}#interleave:${path}:${isolation}:${tag}`;
  const rng = rngFor(seedText);
  const user = pick(rng, USERS);
  const A = await connect();
  const B = await connect();
  const rec = {
    i: seedText,
    seed: seedText,
    category: "interleave",
    kind: `${path}_${isolation.replace(" ", "_")}`,
    user: user.name,
    verdict: "HELD",
    reasons: [],
    steps: [],
  };
  const step = (s) => rec.steps.push(s);
  try {
    const shotA = validShot(rng, user, `canary-${sha(seedText)}`);
    shotA.resultKind = "scored";
    shotA.overallScore = round2(rng() * 10);
    const idB = uuidFrom(rng);
    const scoreB = String(round2(rng() * 10));
    const insertSql = `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind,
        app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
      values ($1, $2, $3, 'side', $4::timestamptz, 0, 1, 2, $5::numeric, 0.9, $6, 'a','b','c','d','e','f','g','h','real')`;
    await preparePermit(su, user, shotA, {});
    const before = await counts(su);

    await A.query(`begin isolation level ${isolation}`);
    await B.query(`begin isolation level ${isolation}`);
    if (path === "client") {
      for (const c of [A, B]) {
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claim.sub', $1, true)", [user.id]);
      }
      const ra = await A.query("select public.apply_synced_shot($1::jsonb) as r", [
        JSON.stringify(shotA),
      ]);
      step({ lane: "A", op: "apply_synced_shot(scored)", result: ra.rows[0].r });
      if (ra.rows[0].r !== "accepted") rec.reasons.push(`A not accepted: ${ra.rows[0].r}`);
    } else {
      await A.query(insertSql, [
        shotA.id,
        user.id,
        shotA.shotType,
        shotA.capturedAt,
        String(shotA.overallScore),
        "scored",
      ]);
      step({ lane: "A", op: "owner insert scored", result: "inserted" });
    }
    const stateInA = await A.query(
      "select rating::text as rating, scored_shot_count from public.player_rank_state where user_id = $1",
      [user.id],
    ).catch(() => ({ rows: [] }));
    step({ lane: "A", op: "rank row as seen inside A", result: stateInA.rows[0] ?? null });

    // B: fire and do NOT await — it must block on A's uncommitted rank row.
    const bParams =
      path === "client"
        ? [idB, user.id, pick(rng, TECHNIQUES), isoMs(rng), null, "low_confidence"]
        : [idB, user.id, pick(rng, TECHNIQUES), isoMs(rng), scoreB, "scored"];
    const bPromise = B.query(insertSql, bParams)
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, error: errInfo(e, null) }));
    let blocked = false;
    for (let t = 0; t < 40; t++) {
      await new Promise((r) => setTimeout(r, 50));
      const w = await su.query(
        "select wait_event_type, state from pg_stat_activity where pid = $1",
        [B.processID],
      );
      if (w.rows[0]?.wait_event_type === "Lock") {
        blocked = true;
        break;
      }
    }
    step({
      lane: "B",
      op: path === "client" ? "authenticated direct INSERT low_confidence" : "owner insert scored",
      blockedOnLock: blocked,
    });
    if (!blocked)
      rec.reasons.push("B did not block on A's rank row (interleaving not established)");
    await A.query("commit");
    step({ lane: "A", op: "commit" });
    const bOut = await bPromise;
    step({ lane: "B", op: "insert returned", result: bOut });
    if (bOut.ok) {
      await B.query("commit");
      step({ lane: "B", op: "commit" });
      ctx.remember(user, idB);
    } else {
      await B.query("rollback").catch(() => {});
      step({ lane: "B", op: "rollback", sqlstate: bOut.error.sqlstate });
    }
    ctx.remember(user, shotA.id);

    const after = await counts(su);
    rec.delta = delta(before, after);
    const rc = await rankCheck(su, user.id);
    rec.rankCheck = rc;
    if (isolation === "read committed") {
      if (!rc.ok) rec.reasons.push(...rc.problems.map((p) => `rank: ${p}`));
    } else {
      // SERIALIZABLE: either B fails with 40001 (and state is right) or it succeeds and state is right.
      if (!rc.ok) rec.reasons.push(...rc.problems.map((p) => `rank (serializable): ${p}`));
      rec.detail = { bSqlstate: bOut.ok ? null : bOut.error.sqlstate };
    }
    if (!rc.ok) {
      await su.query("select public.recompute_player_rank($1)", [user.id]);
      rec.afterRecompute = await rankCheck(su, user.id);
    }
  } catch (e) {
    rec.reasons.push(`harness error: ${e.message}`);
    await A.query("rollback").catch(() => {});
    await B.query("rollback").catch(() => {});
  } finally {
    await A.end().catch(() => {});
    await B.end().catch(() => {});
  }
  if (rec.reasons.length) rec.verdict = "BROKEN";
  results.push(rec);
  return rec;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────────────────
async function setup(su) {
  await su.query("begin");
  await su.query(
    `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
      ($1, 'alice@example.com', '{"full_name":"Alice"}', '{"provider":"google"}'),
      ($2, 'bob@example.com', '{"full_name":"Bob"}', '{"provider":"apple"}')
    on conflict (id) do nothing`,
    [ALICE, BOB],
  );
  await su.query(
    `insert into auth.identities (provider, provider_id, user_id, identity_data) values
      ('google', 'google-sub-alice', $1, '{"sub":"google-sub-alice"}'),
      ('apple', 'apple-sub-bob', $2, '{"sub":"apple-sub-bob"}')
    on conflict do nothing`,
    [ALICE, BOB],
  );
  const p = await su.query("select count(*)::int as n from public.profiles where id in ($1, $2)", [
    ALICE,
    BOB,
  ]);
  if (p.rows[0].n !== 2) throw new Error("handle_new_user did not provision both profiles");
  // Premium so the free-limit backstop never masks the rank paths under test.
  await su.query(
    "insert into public.billing_entitlements (user_id, premium) values ($1, true), ($2, true) on conflict (user_id) do update set premium = true, expires_at = null",
    [ALICE, BOB],
  );
  for (const u of USERS) {
    await su.query(
      "insert into public.sessions (id, user_id, started_at) values ($1, $2, now()) on conflict (id) do nothing",
      [u.sessionId, u.id],
    );
  }
  await su.query("commit");
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const su = await connect();
  const holder = { c: await connect() };
  const results = [];
  const known = new Map(USERS.map((u) => [u.id, []]));
  const ctx = {
    pickExisting: (u) => {
      const arr = known.get(u.id);
      return arr.length ? arr[arr.length - 1] : null;
    },
    remember: (u, id) => known.get(u.id).push(id),
    forget: (u, id) => {
      const arr = known.get(u.id);
      const k = arr.indexOf(id);
      if (k >= 0) arr.splice(k, 1);
    },
  };
  const started = Date.now();
  let executed = 0;
  const write = (final) => {
    const broken = results.filter((r) => r.verdict === "BROKEN");
    const byKind = {};
    const byOutcome = {};
    for (const r of results) {
      const k = `${r.category}/${r.kind}`;
      byKind[k] = byKind[k] ?? { total: 0, broken: 0 };
      byKind[k].total++;
      if (r.verdict === "BROKEN") byKind[k].broken++;
      const o =
        r.outcome?.type === "rpc_result"
          ? `rpc:${r.outcome.value}`
          : r.outcome?.type === "error"
            ? `error:${r.outcome.sqlstate}${r.outcome.raisedInsideRpc ? ":INSIDE_RPC" : ""}`
            : `${r.outcome?.type ?? "n/a"}`;
      byOutcome[o] = (byOutcome[o] ?? 0) + 1;
    }
    const summary = {
      runId: RUN_ID,
      seed: SEED,
      iterations: ITER,
      executed,
      replay: REPLAY,
      lanes: LANES,
      concRounds: CONC_ROUNDS,
      pgUrl: PG_URL.replace(/:[^:@/]+@/, ":***@"),
      durationMs: Date.now() - started,
      final,
      records: results.length,
      broken: broken.length,
      seedsFailed: broken.map((r) => r.seed),
      byKind,
      byOutcome,
      echoObserved: results
        .filter((r) => r.outcome?.echoesCanary)
        .map((r) => ({
          seed: r.seed,
          kind: r.kind,
          sqlstate: r.outcome.sqlstate,
          insideRpc: r.outcome.raisedInsideRpc,
        })).length,
    };
    fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
    fs.writeFileSync(path.join(OUT, "failures.json"), JSON.stringify(broken, null, 2));
    fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
    return summary;
  };
  try {
    await setup(su);
    const indices = REPLAY.length ? REPLAY : Array.from({ length: ITER }, (_, i) => i);
    for (const i of indices) {
      const seedText = `${SEED}#${i}`;
      const rng = rngFor(seedText);
      const category = weighted(rng, [
        ["rpc", 62],
        ["direct_insert", 14],
        ["tier_fn", 5],
        ["privilege", 5],
        ["rls", 6],
        ["owner_mutation", 8],
      ]);
      let rec;
      switch (category) {
        case "rpc":
          rec = await runRpcCase(i, seedText, rng, su, holder, ctx);
          break;
        case "direct_insert":
          rec = await runDirectInsert(i, seedText, rng, su, holder, ctx);
          break;
        case "tier_fn":
          rec = await runTierFn(i, seedText, rng, su, holder);
          break;
        case "privilege":
          rec = await runPrivilegeProbe(i, seedText, rng, su, holder, ctx);
          break;
        case "rls":
          rec = await runRlsProbe(i, seedText, rng, su, holder);
          break;
        case "owner_mutation":
          rec = await runOwnerMutation(i, seedText, rng, su, ctx);
          break;
        default:
          throw new Error(category);
      }
      results.push(rec);
      executed++;
      if (rec.verdict === "BROKEN") {
        await repairRankDivergence(su, rec);
        console.log(`BROKEN ${seedText} ${rec.category}/${rec.kind}: ${rec.reasons.join(" ; ")}`);
      }
      if (executed % 500 === 0) {
        console.log(`… ${executed}/${indices.length} (${Date.now() - started}ms)`);
        write(false);
      }
    }
    if (!REPLAY.length) {
      for (let r = 0; r < CONC_ROUNDS; r++) {
        const rec = await runConcurrencyRound(r, su, ctx, results);
        executed++;
        if (rec.verdict === "BROKEN") await repairRankDivergence(su, rec);
        if (rec.verdict === "BROKEN")
          console.log(`BROKEN ${rec.seed} ${rec.kind}: ${rec.reasons.join(" ; ")}`);
      }
      for (let t = 0; t < INTERLEAVE_REPEATS; t++) {
        for (const path of ["client", "owner"]) {
          for (const isolation of ["read committed", "serializable"]) {
            const rec = await runInterleave(su, ctx, results, path, isolation, t);
            executed++;
            if (rec.verdict === "BROKEN") await repairRankDivergence(su, rec);
            if (rec.verdict === "BROKEN")
              console.log(`BROKEN ${rec.seed} ${rec.kind}: ${rec.reasons.join(" ; ")}`);
          }
        }
      }
      // Account deletion cascade: every shot row goes, the trigger fires per row,
      // the rank row must be gone and nothing may raise.
      const before = await counts(su);
      const rec = {
        i: "cascade",
        seed: `${SEED}#cascade`,
        category: "cascade_delete",
        kind: "delete_auth_user",
        user: "bob",
        verdict: "HELD",
        reasons: [],
      };
      try {
        await su.query("delete from auth.users where id = $1", [BOB]);
        rec.outcome = { type: "ok" };
      } catch (e) {
        rec.outcome = { type: "error", ...errInfo(e, null) };
        rec.reasons.push(`cascade delete raised ${rec.outcome.sqlstate}: ${rec.outcome.message}`);
      }
      const after = await counts(su);
      rec.delta = delta(before, after);
      const left = await su.query(
        "select (select count(*) from public.shots where user_id = $1)::int as shots, (select count(*) from public.player_rank_state where user_id = $1)::int as rank",
        [BOB],
      );
      rec.detail = left.rows[0];
      if (left.rows[0].shots !== 0 || left.rows[0].rank !== 0)
        rec.reasons.push(`rows survived deletion: ${JSON.stringify(left.rows[0])}`);
      const rcA = await rankCheck(su, ALICE);
      rec.rank_alice = rcA;
      if (!rcA.ok) rec.reasons.push(...rcA.problems.map((p) => `rank(alice): ${p}`));
      if (rec.reasons.length) rec.verdict = "BROKEN";
      results.push(rec);
      executed++;
    }
  } finally {
    const summary = write(true);
    await holder.c.end().catch(() => {});
    await su.end().catch(() => {});
    console.log(
      JSON.stringify(
        {
          out: OUT,
          executed: summary.executed,
          records: summary.records,
          broken: summary.broken,
          durationMs: summary.durationMs,
          byOutcome: summary.byOutcome,
        },
        null,
        2,
      ),
    );
    process.exitCode = summary.broken > 0 ? 1 : 0;
  }
}

main().catch((e) => {
  console.error("harness crashed:", e);
  process.exit(3);
});
