#!/usr/bin/env node
// Boundary / malformed-input campaign against the Supabase database layer that
// the pg_cron sweeps operate on: analysis_permits (reserve_analysis_permit,
// apply_synced_shot, direct owner writes), account_deletion_requests (the
// PostgREST upsert the edge fn performs), webhook_events (service-role audit
// rows) plus the neighbouring owner tables (sessions, user_saved_drills,
// profiles) and cross-user / anonymous RLS probes.
//
// Every iteration is derived from one 32-bit seed (see lib.mjs iterationSeed)
// and runs in its own transaction that is ROLLED BACK, so the campaign leaves
// the database exactly as it found it and iterations are independent.
//
// Assertion per iteration ("graceful rejection"):
//   * a rejected input produces a TYPED status string, or a Postgres error whose
//     SQLSTATE PostgREST maps to 4xx — never one it maps to 5xx;
//   * a rejected input never writes (row counts of every touched table are
//     unchanged after the call);
//   * an accepted input never stores NaN / out-of-contract values;
//   * a JS oracle predicts accept/reject from the payload; disagreement is
//     reported (verdict BROKEN when a must-reject payload was accepted or a
//     must-accept payload was refused).
//
// Verdicts: HELD (as expected), WEAK (graceful but noteworthy: an exception
// escaped a plpgsql function, or a legal-but-odd value was stored), BROKEN.
//
// Env: STRESS_ITER (default 150), STRESS_SEED (default 20260904),
//      STRESS_REPLAY=<iteration seed> (run one iteration verbosely),
//      STRESS_OUT (default artifacts/stress), STRESS_PG_URL.

import path from "node:path";
import {
  REPO_ROOT,
  Rng,
  USERS,
  asAnon,
  asServiceRole,
  asUser,
  connect,
  describeError,
  envInt,
  iterationSeed,
  postgrestStatus,
  seedUsers,
  writeJson,
} from "./lib.mjs";

const ITER = envInt("STRESS_ITER", 150);
const CAMPAIGN_SEED = envInt("STRESS_SEED", 20260904);
const REPLAY = process.env.STRESS_REPLAY ? Number(process.env.STRESS_REPLAY) : null;
const OUT_DIR = process.env.STRESS_OUT ?? path.join(REPO_ROOT, "artifacts", "stress");

const TYPED_STATUSES = new Set([
  "accepted",
  "auth.required",
  "access.permit_not_found",
  "access.permit_not_reserved",
  "access.permit_expired",
  "access.paywall_required",
  "shot.session_not_found",
  "shot.id_conflict",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Input material
// ─────────────────────────────────────────────────────────────────────────────

const NULL_BYTE_STRINGS = ["a\u0000b", "\u0000", "drive\u0000", "\\u0000"];
const TRAVERSAL_STRINGS = [
  "../../etc/passwd",
  "..\\..\\windows\\system32",
  "%2e%2e%2f%2e%2e%2f",
  "/../../../",
  "'; drop table public.shots; --",
  "00000000-0000-4000-8000-0000000000aa/../x",
  "${jndi:ldap://x}",
  "{{7*7}}",
];
const NUMERIC_STRINGS = [
  "NaN",
  "nan",
  "Infinity",
  "-Infinity",
  "inf",
  "1e400",
  "-0",
  "0x10",
  "1_000",
  "1e3",
  "2147483648",
  "-2147483649",
  "9223372036854775808",
  "1.0",
  "100.0",
  "0.1e1",
  " 5",
  "5 ",
  "٥", // Arabic-Indic five
  "1,5",
];
const UNICODE_PAIRS = [
  ["caf\u00e9", "cafe\u0301"], // NFC / NFD
  ["\u212b", "\u00c5"], // Angstrom sign / A-ring
  ["ﬁ", "fi"], // ligature vs letters
  ["Ａ", "A"], // fullwidth
  ["drive\u200b", "drive"], // zero-width space
  ["\u202edrive", "drive"], // RTL override
];
const EMOJI = "\u{1F3D3}"; // ping pong paddle, 4 bytes, 1 codepoint
const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"; // 1 grapheme, 5 codepoints
const HUGE_64K = "x".repeat(65536);
const HUGE_1M = "y".repeat(1 << 20);

const WRONG_TYPES = [
  123,
  -1,
  1.5,
  0,
  true,
  false,
  null,
  "",
  "abc",
  [],
  {},
  [1, 2],
  { a: 1 },
  { __proto__: { polluted: true } },
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

function basePayload(ctx, rng) {
  const scored = rng.chance(0.75);
  return {
    id: rng.uuid(),
    analysisPermitId: ctx.permitId,
    sessionId: rng.chance(0.5) ? ctx.sessionId : null,
    shotType: rng.pick(["drive", "dink", "serve", "third_shot_drop", "volley"]),
    cameraView: rng.pick(["side", "rear_oblique"]),
    capturedAt: `2026-0${rng.int(1, 9)}-1${rng.int(0, 9)}T1${rng.int(0, 9)}:00:00.000Z`,
    startMs: 0,
    contactMs: rng.chance(0.8) ? 500 : null,
    endMs: 1000,
    overallScore: scored ? Number((rng.next() * 10).toFixed(2)) : null,
    confidence: Number((0.5 + rng.next() * 0.5).toFixed(4)),
    resultKind: scored ? "scored" : "low_confidence",
    phases: [
      { key: "backswing", startMs: 0, representativeMs: 200, endMs: 400, confidence: 0.9 },
      { key: "contact", startMs: 400, representativeMs: 500, endMs: 600, confidence: 0.95 },
    ],
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
    versionVector: Object.fromEntries(VERSION_KEYS.map((k) => [k, `${k}-1`])),
  };
}

// Raw-text edits: the serialized JSON is post-processed so we can emit JSON
// that JSON.stringify cannot (NaN literals, 1e400, duplicate keys, truncation).
const RAW_MUTATIONS = [
  ["json.truncated", (text, rng) => text.slice(0, rng.int(1, text.length - 1))],
  [
    "json.trailing_garbage",
    (text, rng) => text + rng.pick(["}", ",", "]", "\u0000", " garbage", "{}"]),
  ],
  ["json.single_quotes", (text) => text.replaceAll('"', "'")],
  ["json.unquoted_keys", (text) => text.replace(/"([a-zA-Z]+)":/g, "$1:")],
  ["json.nan_literal", (text) => text.replace(/"confidence":[^,}]+/, '"confidence":NaN')],
  [
    "json.infinity_literal",
    (text) => text.replace(/"overallScore":[^,}]+/, '"overallScore":Infinity'),
  ],
  ["json.leading_zero", (text) => text.replace(/"startMs":0/, '"startMs":007')],
  ["json.hex_number", (text) => text.replace(/"endMs":1000/, '"endMs":0x3e8')],
  ["json.comment", (text) => text.replace(/^\{/, "{/* c */")],
  ["json.bom_prefix", (text) => "\uFEFF" + text],
  ["json.empty_text", () => ""],
  ["json.whitespace_only", () => "   \n\t"],
  [
    "json.null_byte_escape",
    (text) => text.replace(/"shotType":"[^"]*"/, '"shotType":"dr\\u0000ive"'),
  ],
  ["json.overflow_number", (text) => text.replace(/"startMs":0/, '"startMs":1e400')],
  ["json.huge_exponent", (text) => text.replace(/"startMs":0/, '"startMs":1e999999999')],
  ["json.negative_zero", (text) => text.replace(/"startMs":0/, '"startMs":-0')],
  ["json.float_ms", (text) => text.replace(/"startMs":0/, '"startMs":0.0')],
  [
    "json.dup_key_traversal",
    (text, rng) =>
      text.replace(/^\{/, `{"id":"${rng.pick(TRAVERSAL_STRINGS).replaceAll('"', "")}",`),
  ],
  [
    "json.dup_key_permit_swap",
    (text, rng) => text.replace(/\}$/, `,"analysisPermitId":"${rng.uuid()}"}`),
  ],
  [
    "json.deep_nesting",
    (text) => text.replace(/"phases":\[/, '"phases":[' + "[".repeat(3000) + "]".repeat(3000) + ","),
  ],
  ["json.scalar_string", () => '"drive"'],
  ["json.scalar_number", () => "42"],
  ["json.scalar_true", () => "true"],
  ["json.scalar_null", () => "null"],
  ["json.empty_array", () => "[]"],
  ["json.empty_object", () => "{}"],
  ["json.array_of_payload", (text) => `[${text}]`],
];

// Structured edits produce a JS value; the oracle judges the final value.
const FIELD_PATHS = [
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
  "phases",
  "checkpoints",
  "versionVector",
  "versionVector.appVersion",
  "versionVector.shotConfigVersion",
  "phases.0.key",
  "phases.0.startMs",
  "phases.0.confidence",
  "checkpoints.0.key",
  "checkpoints.0.score",
  "checkpoints.0.confidence",
  "checkpoints.0.band",
  "checkpoints.0.direction",
  "checkpoints.0.severity",
  "checkpoints.0.applicable",
];

function setPath(obj, dotted, value) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (cur == null || typeof cur !== "object") return;
    cur = cur[parts[i]];
  }
  if (cur != null && typeof cur === "object") cur[parts.at(-1)] = value;
}
function deletePath(obj, dotted) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (cur == null || typeof cur !== "object") return;
    cur = cur[parts[i]];
  }
  if (cur != null && typeof cur === "object") delete cur[parts.at(-1)];
}

const STRUCT_MUTATIONS = [
  ["type.wrong", (p, rng) => setPath(p, rng.pick(FIELD_PATHS), rng.pick(WRONG_TYPES))],
  ["field.missing", (p, rng) => deletePath(p, rng.pick(FIELD_PATHS))],
  [
    "proto.pollution",
    (p, rng) => {
      const target = rng.pick([p, p.versionVector, p.phases?.[0], p.checkpoints?.[0]]);
      const key = rng.pick(["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]);
      if (target === null || typeof target !== "object") return;
      Object.defineProperty(target, key, {
        value: rng.pick([{ polluted: true }, "polluted", 1, null]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    },
  ],
  [
    "num.string_edge",
    (p, rng) =>
      setPath(
        p,
        rng.pick([
          "startMs",
          "contactMs",
          "endMs",
          "overallScore",
          "confidence",
          "phases.0.startMs",
          "phases.0.confidence",
          "checkpoints.0.score",
          "checkpoints.0.confidence",
          "checkpoints.0.severity",
        ]),
        rng.pick(NUMERIC_STRINGS),
      ),
  ],
  [
    "num.overflow",
    (p, rng) =>
      setPath(
        p,
        rng.pick(["startMs", "contactMs", "endMs", "phases.0.representativeMs", "phases.0.endMs"]),
        rng.pick([
          2147483648,
          -2147483649,
          2147483647,
          -2147483648,
          1e308,
          -1e308,
          Number.MAX_SAFE_INTEGER,
          0.5,
          -0,
        ]),
      ),
  ],
  [
    "num.out_of_range",
    (p, rng) =>
      setPath(
        p,
        rng.pick([
          "overallScore",
          "confidence",
          "checkpoints.0.score",
          "checkpoints.0.severity",
          "phases.0.confidence",
        ]),
        rng.pick([
          -0.0001, -1, 10.004, 10.005, 10.01, 11, 100.0004, 100.0005, 101, 1.00004, 1.00005, 1.5,
          1e-10, 99999,
        ]),
      ),
  ],
  [
    "str.null_byte",
    (p, rng) =>
      setPath(
        p,
        rng.pick([
          "shotType",
          "versionVector.appVersion",
          "phases.0.key",
          "checkpoints.0.direction",
          "id",
          "analysisPermitId",
        ]),
        rng.pick(NULL_BYTE_STRINGS),
      ),
  ],
  [
    "str.huge",
    (p, rng) =>
      setPath(
        p,
        rng.pick([
          "shotType",
          "versionVector.appVersion",
          "versionVector.shotConfigVersion",
          "phases.0.key",
          "checkpoints.0.key",
          "checkpoints.0.direction",
          "checkpoints.0.band",
          "cameraView",
          "resultKind",
        ]),
        rng.pick([
          HUGE_64K,
          HUGE_1M,
          "x".repeat(65),
          "x".repeat(64),
          EMOJI.repeat(64),
          EMOJI.repeat(65),
          FAMILY.repeat(13),
          FAMILY.repeat(12),
          "e\u0301".repeat(33),
          "e\u0301".repeat(32),
        ]),
      ),
  ],
  [
    "id.traversal",
    (p, rng) =>
      setPath(p, rng.pick(["id", "analysisPermitId", "sessionId"]), rng.pick(TRAVERSAL_STRINGS)),
  ],
  [
    "id.uuid_variant",
    (p, rng) => {
      const field = rng.pick(["id", "analysisPermitId", "sessionId"]);
      const source =
        field === "id"
          ? rng.uuid()
          : field === "analysisPermitId"
            ? p.analysisPermitId
            : (p.sessionId ?? rng.uuid());
      const variants = [
        source.toUpperCase(),
        `{${source}}`,
        source.replaceAll("-", ""),
        `${source} `,
        ` ${source}`,
        `urn:uuid:${source}`,
        source.slice(0, 35),
        source + "0",
        source.replace(/-/, "_"),
      ];
      setPath(p, field, rng.pick(variants));
    },
  ],
  [
    "schema.future",
    (p, rng) => {
      const variant = rng.int(0, 4);
      if (variant === 0) p.schemaVersion = rng.pick([2, 99, "3.0", "v2"]);
      else if (variant === 1)
        p.resultKind = rng.pick(["scored_v2", "SCORED", "Scored", "low-confidence", "abstained"]);
      else if (variant === 2) setPath(p, "versionVector.futureModelVersion", "future-1");
      else if (variant === 3)
        setPath(p, "checkpoints.0.band", rng.pick(["blue", "GREEN", "green ", "unscored_v2"]));
      else p.cameraView = rng.pick(["front", "SIDE", "side ", "rear-oblique"]);
    },
  ],
  [
    "empty.containers",
    (p, rng) => {
      const variant = rng.int(0, 5);
      if (variant === 0) p.phases = [];
      else if (variant === 1) p.checkpoints = [];
      else if (variant === 2) p.versionVector = {};
      else if (variant === 3) p.phases = [{}];
      else if (variant === 4) p.checkpoints = [{}];
      else p.phases = {};
    },
  ],
  [
    "unicode.normalization",
    (p, rng) => {
      const pair = rng.pick(UNICODE_PAIRS);
      const field = rng.pick([
        "shotType",
        "versionVector.appVersion",
        "phases.0.key",
        "checkpoints.0.key",
      ]);
      setPath(p, field, rng.pick(pair));
    },
  ],
  [
    "dup.phase_keys",
    (p) => {
      if (Array.isArray(p.phases) && p.phases.length > 0)
        p.phases.push({ ...p.phases[0], confidence: 0.1 });
      if (Array.isArray(p.checkpoints) && p.checkpoints.length > 0)
        p.checkpoints.push({ ...p.checkpoints[0], score: 5 });
    },
  ],
  [
    "cross.user",
    (p, rng, ctx) => {
      const variant = rng.int(0, 2);
      if (variant === 0) p.analysisPermitId = ctx.otherPermitId;
      else if (variant === 1) p.sessionId = ctx.otherSessionId;
      else p.id = ctx.otherShotId;
    },
  ],
  [
    "permit.state",
    (p, rng, ctx) => {
      p.analysisPermitId = rng.pick([
        ctx.finalizedPermitId,
        ctx.expiredPermitId,
        ctx.releasedPermitId,
        rng.uuid(),
      ]);
    },
  ],
  ["replay.same_id", (p, rng, ctx) => (p.id = ctx.ownShotId)],
];

// ─────────────────────────────────────────────────────────────────────────────
// Oracle: what the DATABASE contract says should happen to a final JS payload.
// Returns { expect: "accept" | "reject" | "either", why }.
// ─────────────────────────────────────────────────────────────────────────────

const UUID_RE =
  /^\{?[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}\}?$/;
export function pgUuid(value) {
  if (typeof value !== "string") return null;
  if (!UUID_RE.test(value)) return null; // uuid_in accepts braces / missing hyphens, never whitespace
  return value.replace(/[{}-]/g, "").toLowerCase();
}
const codepoints = (s) => [...s].length;
const hasNullByte = (s) => typeof s === "string" && s.includes("\u0000");
function containsNullChar(v) {
  if (typeof v === "string") return v.includes("\u0000");
  if (v === null || typeof v !== "object") return false;
  for (const [k, val] of Object.entries(v))
    if (k.includes("\u0000") || containsNullChar(val)) return true;
  return false;
}

// `->>` text of a jsonb value.
function jsonText(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number")
    return Number.isInteger(v) && Math.abs(v) < 1e21 ? String(v) : String(v);
  if (typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
// PG 16 int/numeric input accepts single underscores between digits and
// non-decimal integer literals (0x1f, 0o17, 0b101) — verified on postgres:16.
const INT_RE = /^[+-]?\d+(_\d+)*$/;
const NONDEC_RE = /^([+-]?)0([xob])([0-9a-fA-F]+(_[0-9a-fA-F]+)*)$/;
const NUMERIC_RE = /^[+-]?(\d+(_\d+)*\.?(\d+(_\d+)*)?|\.\d+(_\d+)*)([eE][+-]?\d+(_\d+)*)?$/;
function nonDecimalInt(t) {
  const m = NONDEC_RE.exec(t);
  if (!m) return null;
  const radix = { x: 16, o: 8, b: 2 }[m[2]];
  const digits = m[3].replaceAll("_", "");
  if (radix === 8 && !/^[0-7]+$/.test(digits)) return null;
  if (radix === 2 && !/^[01]+$/.test(digits)) return null;
  const n = Number.parseInt(digits, radix);
  return m[1] === "-" ? -n : n;
}
function pgInt(text) {
  if (text === null) return { ok: true, value: null };
  const t = text.trim();
  const nd = nonDecimalInt(t);
  if (nd === null && !INT_RE.test(t)) return { ok: false, code: "22P02" };
  const n = nd ?? Number(t.replaceAll("_", ""));
  if (n > 2147483647 || n < -2147483648) return { ok: false, code: "22003" };
  return { ok: true, value: n };
}
// Exact decimal rounding (half away from zero, like numeric typmod coercion).
function roundDecimalText(t, scale) {
  const m = /^([+-]?)(\d*)\.?(\d*)$/.exec(t);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const intPart = m[2] || "0";
  const frac = (m[3] || "").padEnd(scale + 1, "0");
  let digits = BigInt(intPart + frac.slice(0, scale));
  if (Number(frac[scale]) >= 5) digits += 1n;
  return (sign * Number(digits)) / 10 ** scale;
}
// numeric(p,s) coercion: returns { ok, value|nan } or { ok:false, code }.
function pgNumeric(text, precision, scale) {
  if (text === null) return { ok: true, value: null };
  const t = text.trim();
  if (/^nan$/i.test(t)) return { ok: true, nan: true };
  if (/^[+-]?inf(inity)?$/i.test(t)) return { ok: false, code: "22003" }; // typmod rejects infinity
  const nd = nonDecimalInt(t);
  if (nd !== null)
    return Math.abs(nd) >= 10 ** (precision - scale)
      ? { ok: false, code: "22003" }
      : { ok: true, value: nd };
  if (!NUMERIC_RE.test(t)) return { ok: false, code: "22P02" };
  if (/[eE]/.test(t)) return { ok: true, either: true };
  const rounded = roundDecimalText(t.replaceAll("_", ""), scale);
  if (Math.abs(rounded) >= 10 ** (precision - scale)) return { ok: false, code: "22003" };
  return { ok: true, value: rounded };
}
function pgBool(text) {
  if (text === null) return { ok: true, value: null };
  const t = text.trim().toLowerCase();
  if (["t", "true", "y", "yes", "on", "1"].includes(t)) return { ok: true, value: true };
  if (["f", "false", "n", "no", "off", "0"].includes(t)) return { ok: true, value: false };
  return { ok: false, code: "22P02" };
}

export function oracle(payload, ctx) {
  const reject = (why) => ({ expect: "reject", why });
  const either = (why) => ({ expect: "either", why });
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return reject("non-object payload");

  if (containsNullChar(payload)) return reject("null byte (jsonb 22P05)");

  // The three uuid casts run before the replay check (function lines 15-17).
  const id = pgUuid(payload.id);
  if (payload.id !== undefined && payload.id !== null && id === null)
    return reject("id not a uuid");
  const permit = pgUuid(payload.analysisPermitId);
  if (
    payload.analysisPermitId !== undefined &&
    payload.analysisPermitId !== null &&
    permit === null
  ) {
    return reject("permit id not a uuid");
  }
  let session = null;
  if (payload.sessionId !== undefined && payload.sessionId !== null && payload.sessionId !== "") {
    session = pgUuid(payload.sessionId);
    if (session === null) return reject("session id not a uuid");
  }

  if (id === ctx.ownShotIdHex) return { expect: "accept", why: "replay of own shot" };
  if (id === ctx.otherShotIdHex) return reject("shot id owned by another user");
  if (id === null) return reject("id null");
  if (permit !== ctx.permitIdHex) return reject("permit not live/owned");
  if (session !== null && session !== ctx.sessionIdHex) return reject("session not owned");

  const resultKind = jsonText(payload.resultKind);
  if (resultKind !== "scored" && resultKind !== "low_confidence") return reject("resultKind");

  const shotType = jsonText(payload.shotType);
  if (shotType === null || codepoints(shotType) > 64) return reject("shot_type null/too long");
  const cameraView = jsonText(payload.cameraView);
  if (cameraView !== null && cameraView !== "side" && cameraView !== "rear_oblique")
    return reject("camera_view");

  const capturedAt = jsonText(payload.capturedAt);
  if (capturedAt === null) return reject("captured_at null");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(capturedAt)) {
    const year = Number(capturedAt.slice(0, 4));
    if (year < 2000 || year >= 2100) return reject("captured_at out of bounds");
  } else if (["now", "today", "yesterday", "tomorrow"].includes(capturedAt.trim().toLowerCase())) {
    // legal for timestamptz and inside the bounds
  } else {
    return either("captured_at exotic text");
  }

  for (const f of ["startMs", "endMs"]) {
    const r = pgInt(jsonText(payload[f]));
    if (!r.ok || r.value === null) return reject(`${f} int`);
  }
  const contact = pgInt(jsonText(payload.contactMs));
  if (!contact.ok) return reject("contactMs int");

  const score = pgNumeric(jsonText(payload.overallScore), 4, 2);
  if (!score.ok) return reject("overall_score numeric");
  if (score.either) return either("overall_score exponent form");
  if (score.nan) return reject("overall_score NaN fails check");
  if (resultKind === "scored") {
    if (score.value === null) return reject("scored without score");
    if (score.value < 0 || score.value > 10) return reject("overall_score range");
  } else if (score.value !== null) return reject("low_confidence with score");

  const conf = pgNumeric(jsonText(payload.confidence), 5, 4);
  if (!conf.ok || conf.value === null || conf.nan) return reject("analysis_confidence");
  if (conf.either) return either("analysis_confidence exponent form");
  if (conf.value < 0 || conf.value > 1) return reject("analysis_confidence range");

  const vv = payload.versionVector;
  if (vv === null || typeof vv !== "object" || Array.isArray(vv))
    return reject("versionVector missing");
  for (const k of VERSION_KEYS) {
    const t = jsonText(vv[k]);
    if (t === null || codepoints(t) > 64) return reject(`versionVector.${k}`);
  }

  let nanStored = false;
  const phases = payload.phases;
  if (phases !== undefined && phases !== null) {
    if (!Array.isArray(phases)) return reject("phases not an array");
    for (const e of phases) {
      if (e === null || typeof e !== "object" || Array.isArray(e))
        return reject("phase entry not object");
      const key = jsonText(e.key);
      if (key === null || codepoints(key) > 64) return reject("phase key");
      for (const f of ["startMs", "representativeMs", "endMs"]) {
        const r = pgInt(jsonText(e[f]));
        if (!r.ok || r.value === null) return reject(`phase ${f}`);
      }
      const c = pgNumeric(jsonText(e.confidence), 5, 4);
      if (!c.ok || (c.value === null && !c.nan && !c.either)) return reject("phase confidence");
      if (c.either) return either("phase confidence exponent form");
      if (c.nan) nanStored = true;
    }
  }
  const checkpoints = payload.checkpoints;
  if (checkpoints !== undefined && checkpoints !== null) {
    if (!Array.isArray(checkpoints)) return reject("checkpoints not an array");
    for (const e of checkpoints) {
      if (e === null || typeof e !== "object" || Array.isArray(e))
        return reject("checkpoint entry not object");
      const key = jsonText(e.key);
      if (key === null || codepoints(key) > 64) return reject("checkpoint key");
      const s = pgNumeric(jsonText(e.score), 6, 3);
      if (!s.ok || s.nan) return reject("checkpoint score");
      if (s.either) return either("checkpoint score exponent form");
      if (s.value !== null && (s.value < 0 || s.value > 100))
        return reject("checkpoint score range");
      const c = pgNumeric(jsonText(e.confidence), 5, 4);
      if (!c.ok || (c.value === null && !c.nan && !c.either))
        return reject("checkpoint confidence");
      if (c.either) return either("checkpoint confidence exponent form");
      if (c.nan) nanStored = true;
      const band = jsonText(e.band);
      if (!["green", "yellow", "red", "unscored"].includes(band ?? ""))
        return reject("checkpoint band");
      const dir = jsonText(e.direction);
      if (dir === null || codepoints(dir) > 64) return reject("checkpoint direction");
      const sev = pgNumeric(jsonText(e.severity), 5, 4);
      if (!sev.ok || sev.value === null || sev.nan) return reject("checkpoint severity");
      if (sev.either) return either("checkpoint severity exponent form");
      if (sev.value < 0 || sev.value > 1) return reject("checkpoint severity range");
      const app = pgBool(jsonText(e.applicable));
      if (!app.ok || app.value === null) return reject("checkpoint applicable");
    }
  }
  return {
    expect: "accept",
    why: nanStored ? "accept (NaN reaches a numeric(5,4) column without a check)" : "valid",
    nanStored,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-iteration fixture (inside the rolled-back transaction, as postgres).
// ─────────────────────────────────────────────────────────────────────────────

const COUNT_SQL = `select
  (select count(*) from public.shots) as shots,
  (select count(*) from public.shot_phases) as phases,
  (select count(*) from public.shot_checkpoints) as checkpoints,
  (select count(*) from public.analysis_permits) as permits,
  (select count(*) from public.analysis_permits where status = 'reserved') as reserved,
  (select count(*) from public.analysis_permits where status = 'finalized') as finalized,
  (select count(*) from public.analysis_permits where status = 'released') as released,
  (select count(*) from public.account_deletion_requests) as deletion_requests,
  (select count(*) from public.webhook_events) as webhook_events,
  (select count(*) from public.user_saved_drills) as saved_drills,
  (select count(*) from public.sessions) as sessions,
  (select coalesce(sum(scored_count), 0) from public.free_rating_ledger) as ledger_sum,
  (select count(*) from public.profiles) as profiles`;

async function fixture(client, rng) {
  const ctx = {
    permitId: rng.uuid(),
    otherPermitId: rng.uuid(),
    finalizedPermitId: rng.uuid(),
    expiredPermitId: rng.uuid(),
    releasedPermitId: rng.uuid(),
    sessionId: rng.uuid(),
    otherSessionId: rng.uuid(),
    ownShotId: rng.uuid(),
    otherShotId: rng.uuid(),
  };
  for (const k of ["permitId", "sessionId", "ownShotId", "otherShotId"])
    ctx[`${k}Hex`] = pgUuid(ctx[k]);
  await client.query(
    `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at) values
       ($1, $6, 'live', 'reserved', null, now() - interval '1 hour'),
       ($2, $7, 'other-live', 'reserved', null, now() - interval '1 hour'),
       ($3, $6, 'finalized', 'finalized', 'scored', now() - interval '2 hours'),
       ($4, $6, 'expired', 'reserved', null, now() - interval '25 hours'),
       ($5, $6, 'released', 'released', 'low_confidence', now() - interval '3 hours')`,
    [
      ctx.permitId,
      ctx.otherPermitId,
      ctx.finalizedPermitId,
      ctx.expiredPermitId,
      ctx.releasedPermitId,
      USERS.a,
      USERS.b,
    ],
  );
  await client.query(
    `insert into public.sessions (id, user_id, kind, started_at) values ($1, $3, 'practice', now() - interval '1 hour'), ($2, $4, 'practice', now() - interval '1 hour')`,
    [ctx.sessionId, ctx.otherSessionId, USERS.a, USERS.b],
  );
  // Two pre-existing low-confidence shots (one per user) for replay / conflict cases.
  await client.query(
    `insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms, analysis_confidence, result_kind,
       app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version,
       phase_model_version, scoring_model_version, shot_config_version)
     values ($1, $3, 'drive', now() - interval '1 day', 0, 1000, 0.2, 'low_confidence', 'v','v','v','v','v','v','v','v'),
            ($2, $4, 'drive', now() - interval '1 day', 0, 1000, 0.2, 'low_confidence', 'v','v','v','v','v','v','v','v')`,
    [ctx.ownShotId, ctx.otherShotId, USERS.a, USERS.b],
  );
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Case builders. Each returns { target, actor, label, run(client) → raw outcome }.
// `run` executes exactly one client-shaped statement.
// ─────────────────────────────────────────────────────────────────────────────

function buildApplyCase(rng, ctx) {
  const payload = basePayload(ctx, rng);
  const mutations = [];
  const nMut = rng.chance(0.15) ? 0 : rng.int(1, 3);
  for (let i = 0; i < nMut; i += 1) {
    const [name, fn] = rng.pick(STRUCT_MUTATIONS);
    fn(payload, rng, ctx);
    mutations.push(name);
  }
  let text = JSON.stringify(payload);
  let raw = false;
  if (rng.chance(0.18)) {
    const [name, fn] = rng.pick(RAW_MUTATIONS);
    text = fn(text, rng);
    mutations.push(name);
    raw = true;
  }
  let expectation;
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    // JS JSON.parse and jsonb differ on a few inputs; when JS parses it we can
    // still run the oracle, otherwise it must be rejected before the function.
    expectation =
      parsed === undefined ? { expect: "reject", why: "unparseable JSON" } : oracle(parsed, ctx);
    const rawName = mutations.at(-1);
    // jsonb keeps the lexical form of numbers (0.0 → '0.0'::int fails) and
    // the nesting limit is a parser property; the oracle cannot see either.
    if (
      ["json.deep_nesting", "json.float_ms", "json.negative_zero", "json.overflow_number"].includes(
        rawName,
      )
    ) {
      expectation = { expect: "either", why: rawName };
    }
    // 1e999999999 overflows jsonb's numeric while JS parses it as Infinity:
    // the $1::jsonb cast must reject it before the function runs.
    if (rawName === "json.huge_exponent")
      expectation = { expect: "reject", why: "jsonb numeric overflow (22003)" };
  } else {
    expectation = oracle(payload, ctx);
  }
  const actor = rng.chance(0.06) ? rng.pick(["anon", "none", "b"]) : "a";
  if (actor === "b") {
    // User B owns otherShotId (replay) and nothing else in this payload.
    let parsedId = null;
    try {
      parsedId = pgUuid(JSON.parse(text).id);
    } catch {
      parsedId = null;
    }
    expectation =
      parsedId === ctx.otherShotIdHex && expectation.expect !== "reject"
        ? { expect: "accept", why: "actor b replays its own shot" }
        : parsedId === ctx.otherShotIdHex
          ? { expect: "either", why: "actor b replay with malformed remainder" }
          : { expect: "reject", why: "actor b holds no permit here" };
  } else if (actor !== "a") expectation = { expect: "reject", why: `actor ${actor}` };
  return {
    target: "apply_synced_shot",
    actor,
    label: mutations.join("+") || "valid",
    payloadText: text.length > 400 ? `${text.slice(0, 400)}…(${text.length} chars)` : text,
    expectation,
    async run(client) {
      const res = await client.query("select public.apply_synced_shot($1::jsonb) as status", [
        text,
      ]);
      return { status: res.rows[0].status };
    },
    async verify(client, status) {
      if (status !== "accepted") return null;
      const id = pgUuid(JSON.parse(text).id);
      const shot = await client.query(
        `select s.id, s.result_kind, s.overall_score::text as score, s.analysis_confidence::text as conf,
                (select status from public.analysis_permits where id = $2) as permit_status,
                (select outcome from public.analysis_permits where id = $2) as permit_outcome,
                (select count(*) from public.shot_phases p where p.shot_id = s.id and p.confidence = 'NaN') as nan_phases,
                (select count(*) from public.shot_checkpoints c where c.shot_id = s.id and (c.confidence = 'NaN' or c.severity = 'NaN' or c.score = 'NaN')) as nan_checkpoints
         from public.shots s where s.id = $1::uuid and s.user_id = $3`,
        [id, ctx.permitId, USERS.a],
      );
      if (actor === "b")
        return id === ctx.otherShotIdHex
          ? null
          : { anomaly: "user b accepted a shot it does not own" };
      if (shot.rowCount !== 1) return { anomaly: "accepted but no shot row visible for this user" };
      const row = shot.rows[0];
      const anomalies = [];
      if (id !== ctx.ownShotIdHex) {
        const expectedStatus = row.result_kind === "scored" ? "finalized" : "released";
        if (row.permit_status !== expectedStatus || row.permit_outcome !== row.result_kind) {
          anomalies.push(
            `permit ${row.permit_status}/${row.permit_outcome} after ${row.result_kind}`,
          );
        }
      }
      if (row.score === "NaN" || row.conf === "NaN") anomalies.push("NaN in shots numeric");
      if (Number(row.nan_phases) > 0)
        anomalies.push(`NaN stored in shot_phases.confidence x${row.nan_phases}`);
      if (Number(row.nan_checkpoints) > 0)
        anomalies.push(`NaN stored in shot_checkpoints x${row.nan_checkpoints}`);
      return anomalies.length ? { anomaly: anomalies.join("; ") } : null;
    },
  };
}

function buildReserveCase(rng, ctx) {
  const keys = [
    ["valid", rng.uuid(), "accept"],
    ["empty", "", "accept"],
    ["space", " ", "accept"],
    ["len128", "k".repeat(128), "accept"],
    ["len129", "k".repeat(129), "reject"],
    ["emoji128", EMOJI.repeat(128), "accept"],
    ["emoji129", EMOJI.repeat(129), "reject"],
    ["huge64k", HUGE_64K, "reject"],
    ["huge1m", HUGE_1M, "reject"],
    ["null_byte", "k\u0000k", "reject"],
    ["traversal", rng.pick(TRAVERSAL_STRINGS), "accept"],
    ["nfc", UNICODE_PAIRS[0][0], "accept"],
    ["nfd", UNICODE_PAIRS[0][1], "accept"],
    ["replay_live", "live", "accept"],
    ["sql_null", null, "reject"],
  ];
  const [label, key, expect] = rng.pick(keys);
  const actor = rng.chance(0.1) ? rng.pick(["anon", "none", "b"]) : "a";
  return {
    target: "reserve_analysis_permit",
    actor,
    label,
    payloadText:
      key === null ? "NULL" : key.length > 80 ? `${key.slice(0, 80)}…(${key.length})` : key,
    expectation:
      actor === "anon" || actor === "none"
        ? { expect: "reject", why: actor }
        : { expect, why: label },
    async run(client) {
      const res = await client.query("select * from public.reserve_analysis_permit($1::text)", [
        key,
      ]);
      const row = res.rows[0];
      return { status: row.result, row };
    },
    async verify(client, status, raw) {
      if (status !== "accepted") return null;
      if (label === "replay_live" && raw.row.permit_id !== ctx.permitId && actor === "a") {
        return { anomaly: "replay of an existing key returned a different permit" };
      }
      const row = await client.query(
        "select length(idempotency_key) as len from public.analysis_permits where id = $1",
        [raw.row.permit_id],
      );
      if (row.rowCount !== 1) return { anomaly: "accepted but permit row missing" };
      if (row.rows[0].len > 128) return { anomaly: `stored key length ${row.rows[0].len}` };
      return null;
    },
  };
}

const TS_STRINGS = [
  ["infinity", "infinity", "accept"],
  ["neg_infinity", "-infinity", "accept"],
  ["epoch", "epoch", "accept"],
  ["year_9999", "9999-12-31T00:00:00Z", "accept"],
  ["year_0001", "0001-01-01T00:00:00Z", "accept"],
  ["garbage", "not-a-timestamp", "reject"],
  ["null_byte", "2026-01-01\u0000", "reject"],
  ["numeric", "1735689600", "reject"],
  ["empty", "", "reject"],
  ["valid_future", "2026-12-31T00:00:00Z", "accept"],
  ["valid_past", "2024-01-01T00:00:00Z", "accept"],
  ["huge", "2".repeat(70000), "reject"],
];

function buildDirectCase(rng, ctx) {
  const kind = rng.pick([
    "permit.insert",
    "permit.update",
    "deletion.upsert",
    "deletion.cross_user",
    "webhook.client",
    "webhook.service",
    "drill.slug",
    "session.insert",
    "profile.update",
    "rls.read_other",
    "shots.direct_insert",
  ]);
  let actor = rng.chance(0.08) ? "anon" : "a";
  const reject = (why) => ({ expect: "reject", why });
  const accept = (why) => ({ expect: "accept", why });
  let sql;
  let params;
  let expectation;
  let label = kind;
  let payloadText = "";
  let verify = null;
  switch (kind) {
    case "permit.insert": {
      const status = rng.pick([
        "reserved",
        "finalized",
        "released",
        "expired",
        "RESERVED",
        "",
        "reserved\u0000",
        HUGE_64K.slice(0, 1000),
      ]);
      const [tsLabel, ts, tsExpect] = rng.pick(TS_STRINGS);
      const key = rng.pick([
        rng.uuid(),
        "k".repeat(128),
        "k".repeat(129),
        rng.pick(TRAVERSAL_STRINGS),
        HUGE_64K,
      ]);
      const userId = rng.chance(0.2) ? USERS.b : USERS.a;
      sql =
        "insert into public.analysis_permits (user_id, idempotency_key, status, created_at) values ($1, $2, $3, $4::timestamptz) returning id, created_at::text";
      params = [userId, key, status, ts];
      label = `permit.insert:${tsLabel}`;
      payloadText = JSON.stringify({
        userId: userId === USERS.a ? "a" : "b",
        keyLen: key.length,
        status: status.slice(0, 20),
        ts: ts.slice(0, 40),
      });
      const ok =
        ["reserved", "finalized", "released"].includes(status) &&
        [...key].length <= 128 &&
        !hasNullByte(key) &&
        tsExpect === "accept" &&
        userId === USERS.a;
      expectation = ok ? accept(tsLabel) : reject("status/key/rls/timestamp");
      if (ok && ["infinity", "neg_infinity", "epoch", "year_9999", "year_0001"].includes(tsLabel)) {
        expectation = {
          expect: "accept",
          why: `permit created_at=${tsLabel} accepted (no bounds; unsweepable/permanently-live when infinity)`,
          weak: true,
        };
      }
      break;
    }
    case "permit.update": {
      const col = rng.pick(["status", "outcome", "created_at", "user_id", "idempotency_key"]);
      const value =
        col === "status"
          ? rng.pick(["released", "finalized", "expired", "", "reserved"])
          : col === "outcome"
            ? rng.pick(["expired", "x".repeat(50), "x".repeat(51), HUGE_64K, null])
            : col === "created_at"
              ? "2000-01-01"
              : col === "user_id"
                ? USERS.b
                : "new-key";
      sql = `update public.analysis_permits set ${col} = $2 where id = $1 returning id`;
      params = [ctx.permitId, value];
      label = `permit.update:${col}`;
      payloadText = JSON.stringify({
        col,
        value: typeof value === "string" ? value.slice(0, 20) : value,
      });
      if (col === "created_at" || col === "user_id" || col === "idempotency_key")
        expectation = reject("column grant");
      else if (col === "status")
        expectation = ["released", "finalized", "reserved"].includes(value)
          ? accept("status")
          : reject("check");
      else
        expectation =
          value === null || [...value].length <= 50 ? accept("outcome") : reject("outcome length");
      break;
    }
    case "deletion.upsert": {
      const [tsLabel, ts, tsExpect] = rng.pick(TS_STRINGS);
      const [createdLabel, created] = rng.pick([
        ["now", "now()"],
        ["neg_infinity", "'-infinity'"],
        ["year_0001", "'0001-01-01'"],
      ]);
      const challenge = rng.pick([
        rng.uuid(),
        rng.uuid(),
        "not-a-uuid",
        rng.pick(TRAVERSAL_STRINGS),
        "",
      ]);
      sql = `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
             values ($1, $2, ${created}, $3::timestamptz)
             on conflict (user_id) do update set challenge = excluded.challenge, created_at = excluded.created_at, expires_at = excluded.expires_at
             returning expires_at::text, created_at::text`;
      params = [USERS.a, challenge, ts];
      label = `deletion.upsert:${tsLabel}:${createdLabel}`;
      payloadText = JSON.stringify({
        challenge: challenge.slice(0, 40),
        ts: ts.slice(0, 40),
        created,
      });
      const ok = pgUuid(challenge) !== null && tsExpect === "accept";
      expectation = ok ? accept(tsLabel) : reject("challenge/timestamp");
      if (
        ok &&
        (["infinity", "neg_infinity", "epoch", "year_9999", "year_0001"].includes(tsLabel) ||
          createdLabel !== "now")
      ) {
        expectation = {
          expect: "accept",
          why: `deletion request expires_at=${tsLabel} created_at=${createdLabel} accepted (no bounds; infinity is never swept)`,
          weak: true,
        };
      }
      break;
    }
    case "deletion.cross_user": {
      sql =
        "insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at) values ($1, $2, now(), now() + interval '15 minutes') on conflict (user_id) do update set challenge = excluded.challenge returning user_id";
      params = [USERS.b, rng.uuid()];
      expectation = reject("RLS: other user's deletion row");
      break;
    }
    case "webhook.client": {
      sql = rng.pick([
        "select id from public.webhook_events limit 1",
        "insert into public.webhook_events (id, payload) values ($1, '{}'::jsonb) returning id",
        "delete from public.webhook_events where id = $1 returning id",
      ]);
      params = sql.includes("$1") ? [rng.uuid()] : [];
      expectation = reject("service-only table");
      break;
    }
    case "webhook.service": {
      // Incompressible ids: btree index tuples are TOAST-compressed, so a
      // repeated character would not exercise the ~2704-byte index-row cap.
      const randomText = (n) =>
        Array.from({ length: n }, () => String.fromCharCode(33 + rng.int(0, 93))).join("");
      const [idLabel, id] = rng.pick([
        ["uuid", rng.uuid()],
        ["traversal", rng.pick(TRAVERSAL_STRINGS)],
        ["len2000", randomText(2000)],
        ["len2700", randomText(2700)],
        ["len3000", randomText(3000)],
        ["len64k", randomText(65536)],
        ["null_byte", "id\u0000"],
        ["empty", ""],
      ]);
      const [payloadLabel, payload] = rng.pick([
        ["object", JSON.stringify({ event: { id, type: "TEST" } })],
        ["null_byte", '{"event":{"id":"a\\u0000b"}}'],
        ["huge_string", JSON.stringify({ blob: HUGE_1M })],
        ["deep", "[".repeat(2000) + "]".repeat(2000)],
        ["scalar", "42"],
        ["nan", '{"x":NaN}'],
        ["truncated", '{"event":{"id":'],
        ["dup_keys", '{"a":1,"a":2}'],
        ["proto", '{"__proto__":{"polluted":true},"constructor":{"prototype":1}}'],
      ]);
      actor = "service";
      sql =
        "insert into public.webhook_events (id, provider, event_type, app_user_id, payload) values ($1, 'revenuecat', $2, $3, $4::jsonb) on conflict (id) do nothing returning id";
      params = [
        id,
        rng.pick(["TEST", "t".repeat(70000), null]),
        rng.pick([USERS.a, "not-a-uuid", null]),
        payload,
      ];
      label = `webhook.service:${idLabel}:${payloadLabel}`;
      payloadText = JSON.stringify({ idLen: id.length, payloadLabel });
      let parsedOk = true;
      try {
        JSON.parse(payload);
      } catch {
        parsedOk = false;
      }
      if (payload.includes("\\u0000") || !parsedOk || hasNullByte(id))
        expectation = reject("payload/id malformed");
      else if (id.length >= 2700)
        expectation = {
          expect: "reject",
          why: "btree index row size (54000 → PostgREST 500; webhook_events.id is uncapped)",
          weak5xx: true,
        };
      else if (payloadLabel === "deep") expectation = { expect: "either", why: "deep nesting" };
      else expectation = accept(idLabel);
      break;
    }
    case "drill.slug": {
      const [slugLabel, slug, ok] = rng.pick([
        ["valid", "third-shot-drop_1", true],
        ["traversal", rng.pick(TRAVERSAL_STRINGS), false],
        ["len120", "s".repeat(120), true],
        ["len121", "s".repeat(121), false],
        ["leading_dash", "-drill", false],
        ["unicode", "cafe\u0301", false],
        ["empty", "", false],
        ["null_byte", "a\u0000b", false],
        ["huge", HUGE_64K, false],
        ["newline", "a\nb", false],
      ]);
      sql = "insert into public.user_saved_drills (user_id, slug) values ($1, $2) returning slug";
      params = [USERS.a, slug];
      label = `drill.slug:${slugLabel}`;
      expectation = ok ? accept(slugLabel) : reject(slugLabel);
      break;
    }
    case "session.insert": {
      const [notesLabel, notes, notesOk] = rng.pick([
        ["none", null, true],
        ["len4000", "n".repeat(4000), true],
        ["len4001", "n".repeat(4001), false],
        ["emoji4000", EMOJI.repeat(4000), true],
        ["huge", HUGE_1M, false],
        ["null_byte", "n\u0000", false],
      ]);
      const kind = rng.pick(["practice", "game", "match", "PRACTICE", ""]);
      const [tsLabel, ts, tsExpect] = rng.pick(TS_STRINGS);
      sql =
        "insert into public.sessions (id, user_id, kind, started_at, notes) values ($1, $2, $3, $4::timestamptz, $5) returning id";
      params = [rng.uuid(), USERS.a, kind, ts, notes];
      label = `session.insert:${notesLabel}:${kind || "blank"}:${tsLabel}`;
      const ok = notesOk && ["practice", "game"].includes(kind) && tsExpect === "accept";
      expectation = ok ? accept(label) : reject(label);
      if (ok && ["infinity", "neg_infinity", "epoch", "year_9999", "year_0001"].includes(tsLabel)) {
        expectation = {
          expect: "accept",
          why: `sessions.started_at=${tsLabel} accepted (no bounds)`,
          weak: true,
        };
      }
      break;
    }
    case "profile.update": {
      // display_name / email / avatar_url are not client-writable (column grants).
      const [col, value, ok] = rng.pick([
        ["display_name", "d".repeat(200), false],
        ["display_name", "d".repeat(201), false],
        ["email", "e".repeat(321), false],
        ["gender", "other", false],
        ["gender", "female", true],
        ["handedness", "ambidextrous", false],
        ["handedness", "left", true],
        ["first_name", "f".repeat(80), true],
        ["first_name", EMOJI.repeat(80), true],
        ["first_name", "f".repeat(81), false],
        ["first_name", HUGE_64K, false],
        ["first_name", "f\u0000", false],
        ["biggest_problem", "b".repeat(500), true],
        ["biggest_problem", "b".repeat(501), false],
        ["primary_goal", "p".repeat(201), false],
        ["skill_level", "s".repeat(101), false],
        ["focus_checkpoint", rng.pick(TRAVERSAL_STRINGS), true],
        ["onboarding_state", "done", false],
        ["onboarding_state", "complete", true],
      ]);
      sql = `update public.profiles set ${col} = $2 where id = $1 returning id`;
      params = [USERS.a, value];
      label = `profile.update:${col}:${value.length}`;
      expectation = ok ? accept(label) : reject(label);
      break;
    }
    case "rls.read_other": {
      const table = rng.pick([
        "analysis_permits",
        "account_deletion_requests",
        "shots",
        "sessions",
        "profiles",
        "billing_entitlements",
      ]);
      sql = `select count(*)::int as n from public.${table} where ${table === "profiles" ? "id" : "user_id"} = $1`;
      params = [USERS.b];
      label = `rls.read_other:${table}`;
      expectation = { expect: "accept", why: "select runs but must see 0 rows" };
      verify = async (client, status, raw) =>
        raw.rows[0].n === 0 ? null : { anomaly: `saw ${raw.rows[0].n} rows of user b in ${table}` };
      break;
    }
    case "shots.direct_insert": {
      const kind = rng.pick(["scored", "scored", "low_confidence"]);
      const score = kind === "scored" ? rng.pick([7.1, "NaN", 10.005, -0]) : rng.pick([null, 5]);
      sql = `insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
               app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version,
               phase_model_version, scoring_model_version, shot_config_version)
             values ($1, $2, 'drive', now(), 0, 1000, $3::numeric, 0.9, $4, 'v','v','v','v','v','v','v','v') returning id`;
      params = [rng.uuid(), USERS.a, score === null ? null : String(score), kind];
      label = `shots.direct_insert:${kind}:${score}`;
      // A live reserved permit exists in the fixture, so a well-formed scored insert is allowed by the gate.
      const ok = kind === "scored" ? [7.1, -0].includes(score) : score === null;
      expectation = ok ? accept(label) : reject(label);
      break;
    }
    default:
      throw new Error(kind);
  }
  return {
    target: "direct",
    actor,
    label,
    payloadText,
    expectation: actor === "anon" ? reject("anon") : expectation,
    async run(client) {
      const res = await client.query(sql, params);
      return { status: res.rowCount > 0 ? "accepted" : "no_rows", rows: res.rows };
    },
    verify,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Driver
// ─────────────────────────────────────────────────────────────────────────────

async function runIteration(client, index, seed, verbose) {
  const rng = new Rng(seed);
  await client.query("begin");
  const record = { i: index, seed };
  try {
    const ctx = await fixture(client, rng);
    const roll = rng.next();
    const kase =
      roll < 0.6
        ? buildApplyCase(rng, ctx)
        : roll < 0.72
          ? buildReserveCase(rng, ctx)
          : buildDirectCase(rng, ctx);
    Object.assign(record, {
      target: kase.target,
      actor: kase.actor,
      case: kase.label,
      payload: kase.payloadText,
      expect: kase.expectation.expect,
      expect_why: kase.expectation.why,
    });
    const before = (await client.query(COUNT_SQL)).rows[0];
    await client.query("savepoint attempt");
    if (kase.actor === "a") await asUser(client, USERS.a);
    else if (kase.actor === "b") await asUser(client, USERS.b);
    else if (kase.actor === "anon") await asAnon(client);
    else if (kase.actor === "service") await asServiceRole(client);
    else await client.query("set local role authenticated"); // "none": authenticated role, no claims

    let outcome;
    let raw;
    try {
      raw = await kase.run(client);
      await client.query("reset role");
      outcome = { kind: "status", status: raw.status };
    } catch (err) {
      await client.query("rollback to savepoint attempt");
      const e = describeError(err);
      const inFunction = e.where !== null && /PL\/pgSQL function/.test(e.where);
      outcome = {
        kind: inFunction ? "throw_in_function" : "error_pre_function",
        ...e,
        http: postgrestStatus(e.code),
      };
    }
    const after = (await client.query(COUNT_SQL)).rows[0];
    const changed = Object.keys(before).filter((k) => String(before[k]) !== String(after[k]));
    record.outcome = outcome.kind;
    record.status = outcome.status ?? null;
    record.sqlstate = outcome.code ?? null;
    record.http = outcome.http ?? (outcome.kind === "status" ? 200 : null);
    record.error = outcome.message ?? null;
    record.where = outcome.where ?? null;
    record.writes = changed;

    // Verdict.
    const accepted = outcome.kind === "status" && outcome.status === "accepted";
    const typed =
      outcome.kind === "status" &&
      (kase.target !== "apply_synced_shot" && kase.target !== "reserve_analysis_permit"
        ? true
        : TYPED_STATUSES.has(outcome.status) ||
          /^shot\.write_failed:[0-9A-Z]{5}$/.test(outcome.status ?? ""));
    const problems = [];
    let weak = [];
    // apply_synced_shot deliberately releases the permit it refuses for
    // access.permit_expired / access.paywall_required (reserved → released);
    // any other write on a rejection is a violation.
    const permitReleaseOnly = changed.every((k) => k === "reserved" || k === "released");
    const designedRelease =
      outcome.kind === "status" &&
      ["access.permit_expired", "access.paywall_required"].includes(outcome.status) &&
      permitReleaseOnly;
    if (
      !accepted &&
      changed.length > 0 &&
      !designedRelease &&
      !(kase.target === "direct" && outcome.kind === "status")
    ) {
      problems.push(`writes on rejection: ${changed.join(",")}`);
    }
    if (outcome.kind === "status" && !typed) problems.push(`untyped status ${outcome.status}`);
    if (outcome.kind !== "status" && outcome.http >= 500) {
      if (kase.expectation.weak5xx)
        weak.push(`5xx-class SQLSTATE ${outcome.code} (${kase.expectation.why})`);
      else problems.push(`SQLSTATE ${outcome.code} maps to HTTP ${outcome.http}`);
    }
    if (outcome.kind === "throw_in_function")
      weak.push(`exception escaped ${kase.target}: ${outcome.code}`);
    if (
      outcome.kind === "throw_in_function" &&
      /invalid input syntax/.test(outcome.message ?? "")
    ) {
      weak.push("client input echoed in error message");
    }
    if (kase.expectation.expect === "accept" && !accepted)
      problems.push(
        `oracle expected accept, got ${outcome.kind}:${outcome.status ?? outcome.code}`,
      );
    if (kase.expectation.expect === "reject" && accepted)
      problems.push("oracle expected reject, but accepted");
    if (kase.expectation.weak && accepted) weak.push(kase.expectation.why);
    if (accepted && kase.verify) {
      const v = await kase.verify(client, outcome.status, raw);
      if (v?.anomaly) {
        if (/NaN stored/.test(v.anomaly)) weak.push(v.anomaly);
        else problems.push(v.anomaly);
      }
    }
    record.verdict = problems.length ? "BROKEN" : weak.length ? "WEAK" : "HELD";
    record.notes = [...problems, ...weak];
  } catch (err) {
    record.verdict = "HARNESS_ERROR";
    record.notes = [String(err.stack ?? err)];
  } finally {
    await client.query("rollback");
  }
  if (verbose) console.log(JSON.stringify(record, null, 2));
  return record;
}

async function main() {
  const client = await connect();
  await client.query("begin");
  await seedUsers(client);
  await client.query("commit");

  const started = Date.now();
  const rows = [];
  if (REPLAY !== null) {
    rows.push(await runIteration(client, -1, REPLAY >>> 0, true));
  } else {
    for (let i = 0; i < ITER; i += 1) {
      rows.push(await runIteration(client, i, iterationSeed(CAMPAIGN_SEED, i), false));
      if ((i + 1) % 500 === 0) console.log(`  … ${i + 1}/${ITER}`);
    }
  }
  await client.end();

  const tally = (key) =>
    rows.reduce((acc, r) => {
      acc[r[key]] = (acc[r[key]] ?? 0) + 1;
      return acc;
    }, {});
  const byCase = {};
  for (const r of rows) {
    const k = `${r.target}:${r.case}`;
    byCase[k] ??= { n: 0, HELD: 0, WEAK: 0, BROKEN: 0, HARNESS_ERROR: 0 };
    byCase[k].n += 1;
    byCase[k][r.verdict] += 1;
  }
  const weakNotes = {};
  for (const r of rows)
    for (const n of r.notes ?? [])
      if (r.verdict !== "HELD")
        weakNotes[n.replace(/x\d+$/, "")] = (weakNotes[n.replace(/x\d+$/, "")] ?? 0) + 1;
  const summary = {
    campaign: "boundary-malformed",
    campaign_seed: CAMPAIGN_SEED,
    iterations: rows.length,
    elapsed_ms: Date.now() - started,
    pg_url: process.env.STRESS_PG_URL ? "(env)" : "postgres://…@127.0.0.1:5499/postgres",
    verdicts: tally("verdict"),
    outcomes: tally("outcome"),
    targets: tally("target"),
    notes: weakNotes,
    broken_seeds: rows
      .filter((r) => r.verdict === "BROKEN" || r.verdict === "HARNESS_ERROR")
      .map((r) => ({ seed: r.seed, case: r.case, notes: r.notes })),
    weak_seeds: rows.filter((r) => r.verdict === "WEAK").map((r) => r.seed),
    by_case: byCase,
  };
  const dir = path.join(OUT_DIR, `boundary-${CAMPAIGN_SEED}-${rows.length}`);
  const table = writeJson(dir, "seed_outcomes.json", rows);
  const summaryFile = writeJson(dir, "summary.json", summary);
  console.log(
    JSON.stringify(
      { ...summary, by_case: undefined, weak_seeds: summary.weak_seeds.length },
      null,
      2,
    ),
  );
  console.log(`seed table: ${table}\nsummary: ${summaryFile}`);
  process.exitCode = summary.verdicts.BROKEN || summary.verdicts.HARNESS_ERROR ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
