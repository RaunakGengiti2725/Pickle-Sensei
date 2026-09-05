// stress-edge-http / boundary-malformed — the REAL edge handler (../index.ts,
// captured via routesHarness) under seeded malformed / boundary requests.
//
// Supabase Auth + PostgREST + RevenueCat are stubbed at the fetch layer and
// every upstream call is recorded, so each iteration asserts, on the real
// Deno.serve handler:
//   • the handler never throws (a Response is always produced);
//   • every response carries a valid x-request-id (a valid client id is echoed);
//   • every response is a well-formed JSON `{ error: { message } }` (4xx/5xx)
//     or a 2xx, with the JSON security headers; no 5xx body carries upstream /
//     stack / table detail; no raw control bytes in any body;
//   • a request the route's contract rejects (oracle) gets a 4xx — never a
//     5xx, never a 2xx — and produces NO write to PostgREST (the only
//     tolerated write on a 4xx is POST /v1/sessions' idempotent upsert that
//     precedes its 409 ownership check, by design);
//   • a request the contract accepts is never answered with a validation 400;
//   • exactly one access-log line per request, categorical (no query, no ip,
//     no body), status/requestId matching the response.
//
// Replay one row: STRESS_SEED=<seedBase> STRESS_ITER=1 STRESS_START=<i>
//   deno test -A --no-check --config deno.json stress_edge_http_handler_boundary.test.ts
// (the row's `seed` is fnv1a("<campaign>:<seedBase>:<i>") — see the harness).

import { assert, assertEquals } from "@std/assert";
import { captureAccessLog, sanitizeUserText } from "../http.ts";
import {
  fakeAppleIdToken,
  fakeGoogleIdToken,
  type Harness,
  loadHarness,
  type RecordedCall,
  SUPABASE_URL,
  WEBHOOK_SECRET,
} from "./routesHarness.ts";
import {
  brokenSummary,
  genHeaderValue,
  genPathSegment,
  genRawBody,
  genString,
  genWrongType,
  type IterationRow,
  NON_WS_C0_CLASS,
  PATH_KINDS,
  preview,
  Prng,
  RAW_BODY_KINDS,
  runCampaign,
  STRESS_ITER,
  writeCampaign,
} from "./stress_boundary_harness.ts";

const FILE = "stress_edge_http_handler_boundary.test.ts";
const BASE = "http://edge.test/functions/v1/api";
const MAX_JSON_BODY_BYTES = 5_000_000;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const DRILL_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i;
const CONSENT_SCOPES = ["video_analysis", "model_training", "evaluation_telemetry"];
const GENDERS = ["female", "male", "nonbinary", "prefer_not_to_say"];
const RELEASABLE = [
  "low_confidence",
  "cancelled",
  "failed",
  "unsupported",
  "incorrect_recognition",
];
const FEEDBACK_CATEGORIES = [
  "wrong_stroke",
  "wrong_player",
  "contact_looks_wrong",
  "feedback_mismatch",
  "other",
];
const SURVEY_REASONS = [
  "not_using",
  "not_helpful",
  "scores_inaccurate",
  "technical_issues",
  "too_expensive",
  "privacy",
  "other",
];
const VERSION_VECTOR_KEYS = [
  "appVersion",
  "modelBundleVersion",
  "poseModelVersion",
  "paddleModelVersion",
  "strokeDetectorVersion",
  "phaseModelVersion",
  "scoringModelVersion",
  "shotConfigVersion",
];
/** Substrings a client-visible 5xx body must never carry (upstream detail,
 * stack frames, table names, harness markers). */
const DETAIL_MARKERS = [
  "not stubbed",
  "unexpected fetch",
  "PGRST",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "    at ",
  "rest/v1",
  "supabase.test",
  "stack",
  "public.",
  "constraint",
  "23505",
  "42501",
];
const CANARY = "CANARY9f3a7c1e2b8d";

// ── oracles (independent restatement of each route's documented contract) ──

const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const isIso = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  const m = ISO_RE.exec(v);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return false;
  const p = new Date(ms);
  if (p.getUTCFullYear() !== y || p.getUTCMonth() !== mo - 1 || p.getUTCDate() !== d) return false;
  return ms >= Date.UTC(2000, 0, 1) && ms < Date.UTC(2100, 0, 1);
};
const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const nonBlank = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;

// ── request construction ─────────────────────────────────────────────────────

interface Built {
  request: Request;
  /** The oracle's verdict on the request body/path against the route contract. */
  valid: boolean;
  /** Route family for the table + write accounting. */
  route: string;
  /** `POST /v1/sessions` upserts before its 409 ownership check — by design. */
  writesAllowedOn4xx?: boolean;
  /** Expected exact status when the oracle can name one (else range checks). */
  expectStatus?: number;
  /** Client-provided (well-formed) x-request-id that must be echoed. */
  requestId?: string;
  /** Extra per-row metrics. */
  metrics?: Record<string, unknown>;
  /** Per-route post-condition on the recorded upstream calls + body. */
  post?: (res: Response, bodyText: string, calls: RecordedCall[]) => string | null;
}

interface Ctx {
  p: Prng;
  h: Harness;
  token: string;
  ip: string;
}

/** Only header-legal values reach a handler (Fetch ByteString, no NUL/CR/LF);
 * the runtime rejects the rest before any handler code runs. */
function safeHeaders(p: Ctx, extra: Record<string, string> = {}): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${p.token}`);
  headers.set("x-forwarded-for", p.ip);
  for (const [k, v] of Object.entries(extra)) {
    try {
      headers.set(k, v);
    } catch {
      // unreachable over the wire — skip the header rather than the iteration
    }
  }
  return headers;
}

/** Request body text (or a preview of a byte body) for the evidence table. */
const BODY_TEXT = new WeakMap<Request, string>();

function jsonRequest(
  c: Ctx,
  method: string,
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
): Request {
  const headers = safeHeaders(c, { "Content-Type": "application/json", ...extra });
  const text = body === undefined ? undefined : JSON.stringify(body);
  const request = new Request(`${BASE}${path}`, { method, headers, body: text });
  if (text !== undefined) BODY_TEXT.set(request, text);
  return request;
}

/** A field value that is a fuzz string (may or may not be valid for the field). */
function fuzzField(p: Prng, cap: number): unknown {
  return p.weighted<() => unknown>([
    [55, () => genString(p, { cap })],
    [20, () => genWrongType(p)],
    [10, () => undefined],
    [5, () => null],
    [10, () => genString(p, { lengthClass: "cap_edge", cap })],
  ])();
}

function maybeProto(p: Prng, body: Record<string, unknown>): Record<string, unknown> {
  if (!p.chance(0.15)) return body;
  const key = p.pick(["__proto__", "constructor", "prototype"]);
  // Build via JSON so `__proto__` is an OWN key exactly as JSON.parse yields it.
  const rest = JSON.stringify(body).slice(1);
  const text = `{${JSON.stringify(key)}:{"polluted":true}${rest === "}" ? "" : ","}${rest}`;
  return JSON.parse(text) as Record<string, unknown>;
}

function withSchemaVersion(p: Prng, body: Record<string, unknown>): Record<string, unknown> {
  if (p.chance(0.15)) body.schemaVersion = p.pick([2, 99, "3.0.0", null, 1e308, -0]);
  if (p.chance(0.1)) body.extra = p.pick([[], {}, [{}], { nested: [] }]);
  return body;
}

// ── route generators ─────────────────────────────────────────────────────────

function genOnboarding(c: Ctx): Built {
  const { p } = c;
  const body: Record<string, unknown> = withSchemaVersion(p, {});
  const wantValid = p.chance(0.3);
  body.skillLevel = wantValid ? p.pick(["beginner", "3.5", "advanced"]) : fuzzField(p, 64);
  body.handedness = wantValid || p.chance(0.6) ? p.pick(["right", "left"]) : fuzzField(p, 8);
  body.goal = wantValid ? p.pick(["consistency", "power"]) : fuzzField(p, 64);
  body.biggestProblem = wantValid ? "dinks pop up" : fuzzField(p, 256);
  if (p.chance(0.5)) body.firstName = wantValid ? "Ana" : fuzzField(p, 40);
  if (p.chance(0.4)) body.gender = wantValid || p.chance(0.5) ? p.pick(GENDERS) : fuzzField(p, 20);
  const b = maybeProto(p, body);
  const sk = typeof b.skillLevel === "string" ? sanitizeUserText(b.skillLevel, 200) : "";
  const goal = typeof b.goal === "string" ? sanitizeUserText(b.goal, 200) : "";
  const bp = typeof b.biggestProblem === "string" ? sanitizeUserText(b.biggestProblem, 1000) : "";
  let valid =
    sk.length > 0 &&
    sk.length <= 64 &&
    (b.handedness === "right" || b.handedness === "left") &&
    goal.length > 0 &&
    goal.length <= 64 &&
    bp.length > 0 &&
    bp.length <= 256;
  if (b.firstName !== undefined && b.firstName !== null) {
    if (typeof b.firstName !== "string") valid = false;
    else {
      const fn = sanitizeUserText(b.firstName, 200);
      if (fn.length < 1 || fn.length > 40) valid = false;
    }
  }
  if (b.gender !== undefined && b.gender !== null) {
    if (typeof b.gender !== "string" || !GENDERS.includes(b.gender)) valid = false;
  }
  return {
    request: jsonRequest(c, "PUT", "/v1/me/onboarding", b),
    valid,
    route: "PUT /v1/me/onboarding",
  };
}

function genConsentGrant(c: Ctx): Built {
  const { p } = c;
  const body = withSchemaVersion(p, {
    scope: p.chance(0.6) ? p.pick(CONSENT_SCOPES) : fuzzField(p, 50),
    consentVersion: p.chance(0.5) ? p.pick(["2026-08", "v1"]) : fuzzField(p, 64),
    source: p.chance(0.5) ? fuzzField(p, 64) : "settings",
    device: p.chance(0.5) ? fuzzField(p, 512) : "iPhone",
    captureMode: p.chance(0.5) ? fuzzField(p, 64) : "all_captures",
  });
  const b = maybeProto(p, body);
  const valid =
    typeof b.scope === "string" &&
    CONSENT_SCOPES.includes(b.scope) &&
    typeof b.consentVersion === "string" &&
    b.consentVersion.trim().length > 0;
  // Cap agreement with consent_records_bounds (defense_in_depth migration):
  // consent_version / capture_mode ≤ 50 in the DB, sanitized to 64 at the edge.
  const cv = typeof b.consentVersion === "string" ? sanitizeUserText(b.consentVersion, 64) : "";
  const cm = typeof b.captureMode === "string" ? sanitizeUserText(b.captureMode, 64) : "";
  const dbCapExceeded = valid && (Array.from(cv).length > 50 || Array.from(cm).length > 50);
  return {
    request: jsonRequest(c, "POST", "/v1/me/consent/grant", b),
    valid,
    route: "POST /v1/me/consent/grant",
    metrics: dbCapExceeded
      ? {
          dbCapExceeded: true,
          consentVersionCp: Array.from(cv).length,
          captureModeCp: Array.from(cm).length,
        }
      : undefined,
  };
}

function genConsentWithdraw(c: Ctx): Built {
  const { p } = c;
  const b = maybeProto(
    p,
    withSchemaVersion(p, {
      scope: p.chance(0.5) ? p.pick(CONSENT_SCOPES) : fuzzField(p, 50),
      source: fuzzField(p, 64),
      device: fuzzField(p, 512),
    }),
  );
  const valid = typeof b.scope === "string" && CONSENT_SCOPES.includes(b.scope);
  return {
    request: jsonRequest(c, "POST", "/v1/me/consent/withdraw", b),
    valid,
    route: "POST /v1/me/consent/withdraw",
  };
}

function genPermitReserve(c: Ctx): Built {
  const { p, h } = c;
  h.rpcs.reserve_analysis_permit = [
    {
      result: "accepted",
      permit_id: p.uuid(),
      permit_status: "reserved",
      permit_outcome: null,
      permit_created_at: new Date().toISOString(),
    },
  ];
  const b = maybeProto(
    p,
    withSchemaVersion(p, { idempotencyKey: p.chance(0.4) ? p.uuid() : fuzzField(p, 128) }),
  );
  const key = b.idempotencyKey;
  const valid = nonBlank(key, 128);
  const hasNul = typeof key === "string" && key.includes("\u0000");
  return {
    request: jsonRequest(c, "POST", "/v1/analysis-permits", b),
    valid,
    route: "POST /v1/analysis-permits",
    metrics: valid && hasNul ? { nulPassedToRpc: true } : undefined,
    post: (res, _text, calls) => {
      const rpc = calls.filter((x) => x.url.includes("/rpc/reserve_analysis_permit"));
      if (!valid && rpc.length > 0) return "reserve RPC called for a rejected idempotencyKey";
      if (valid && res.status === 400) return "valid idempotencyKey rejected with 400";
      if (valid && rpc.length !== 1) return `expected exactly one reserve RPC, saw ${rpc.length}`;
      if (valid && rpc.length === 1) {
        const arg = isRecord(rpc[0].body) ? rpc[0].body.p_idempotency_key : undefined;
        if (arg !== key) return "idempotencyKey forwarded to the RPC differs from the request";
      }
      return null;
    },
  };
}

function genPermitFinalize(c: Ctx): Built {
  const { p } = c;
  const seg = genPathSegment(p, p.pick(PATH_KINDS));
  const b = maybeProto(
    p,
    withSchemaVersion(p, {
      outcome: p.chance(0.5) ? p.pick(RELEASABLE) : fuzzField(p, 32),
      ratingId: p.chance(0.6) ? null : p.chance(0.5) ? undefined : fuzzField(p, 36),
    }),
  );
  let decoded: string | null;
  try {
    decoded = decodeURIComponent(
      new URL(`${BASE}/v1/analysis-permits/${seg}/finalize`).pathname.split("/").at(-2) ?? "",
    );
  } catch {
    decoded = null;
  }
  const routed = /^\/v1\/analysis-permits\/([^/]+)\/finalize$/.test(
    pathOf(`/v1/analysis-permits/${seg}/finalize`),
  );
  const valid =
    routed &&
    decoded !== null &&
    isUuid(decoded) &&
    typeof b.outcome === "string" &&
    RELEASABLE.includes(b.outcome) &&
    (b.ratingId === null || b.ratingId === undefined);
  return {
    request: jsonRequest(c, "POST", `/v1/analysis-permits/${seg}/finalize`, b),
    valid,
    route: "POST /v1/analysis-permits/:id/finalize",
    // valid → the permit is not in the (empty) fake table → 404, no write
    expectStatus: valid ? 404 : undefined,
  };
}

/** encodeURIComponent that survives lone surrogates (which it would throw on
 * — a client cannot put a lone surrogate on the wire either). */
function safeEncode(s: string): string {
  try {
    return encodeURIComponent(s);
  } catch {
    return encodeURIComponent(s.toWellFormed());
  }
}

/** Decode the routed path segment exactly as the handler does (null = 400). */
function decodedSegment(path: string, re: RegExp): string | null {
  const m = re.exec(pathOf(path));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** The pathname the handler routes on, after URL normalization. */
function pathOf(path: string): string {
  const pathname = new URL(`${BASE}${path}`).pathname;
  const v1 = pathname.lastIndexOf("/v1/");
  return v1 >= 0 ? pathname.slice(v1) : pathname;
}

function validShot(p: Prng): Record<string, unknown> {
  const vv: Record<string, string> = {};
  for (const k of VERSION_VECTOR_KEYS) vv[k] = "1.0.0";
  return {
    id: p.uuid(),
    source: "real",
    analysisPermitId: p.uuid(),
    sessionId: p.chance(0.5) ? null : p.uuid(),
    shotType: p.pick(["dink", "drive", "third_shot_drop"]),
    cameraView: p.pick(["side", "rear_oblique"]),
    capturedAt: "2026-08-31T10:00:00.000Z",
    timestamps: { startMs: 0, contactMs: p.chance(0.5) ? null : 500, endMs: 1000 },
    resultKind: "scored",
    overallScore: p.int(0, 10),
    confidence: 0.9,
    phases: [{ key: "prep", startMs: 0, representativeMs: 10, endMs: 20, confidence: 0.5 }],
    checkpoints: [
      {
        key: "contact",
        score: 50,
        confidence: 0.5,
        band: "green",
        direction: "ok",
        severity: 0.1,
        applicable: true,
      },
    ],
    versionVector: vv,
  };
}

/** Mutations whose invalidity the contract makes unambiguous. */
function breakShot(p: Prng, shot: Record<string, unknown>): { shot: unknown; how: string } {
  const how = p.pick([
    "not_object",
    "id_not_uuid",
    "source_not_real",
    "permit_not_uuid",
    "sessionId_bad",
    "shotType_blank",
    "shotType_65",
    "shotType_wrong_type",
    "cameraView_bad",
    "capturedAt_bad",
    "timestamps_bad",
    "resultKind_bad",
    "overallScore_out_of_range",
    "overallScore_wrong_type",
    "confidence_bad",
    "phases_not_array",
    "phases_too_many",
    "phase_duplicate_key",
    "checkpoint_bad_band",
    "checkpoints_too_many",
    "versionVector_missing",
    "versionVector_key_65",
  ]);
  const s = { ...shot };
  switch (how) {
    case "not_object":
      return { shot: p.pick([null, 1, "shot", [], true]), how };
    case "id_not_uuid":
      s.id = p.pick([
        genString(p, { lengthClass: p.pick(["short", "large"]) }),
        123,
        null,
        "00000000-0000-0000-0000-000000000000",
      ]);
      break;
    case "source_not_real":
      s.source = p.pick(["synthetic", "REAL", "", null, 1, ["real"]]);
      break;
    case "permit_not_uuid":
      s.analysisPermitId = p.pick(["", "not-a-uuid", 0, {}]);
      break;
    case "sessionId_bad":
      s.sessionId = p.pick(["", "x", 0, undefined, false]);
      break;
    case "shotType_blank":
      s.shotType = p.pick(["", "   ", "\t\n"]);
      break;
    case "shotType_65":
      s.shotType = "x".repeat(65);
      break;
    case "shotType_wrong_type":
      s.shotType = genWrongType(p);
      break;
    case "cameraView_bad":
      s.cameraView = p.pick(["front", "SIDE", "", null, 1]);
      break;
    case "capturedAt_bad":
      s.capturedAt = p.pick([
        "2026-02-30T10:00:00.000Z",
        "Jan 1 2026",
        "2026-08-31T10:00:00",
        "1999-12-31T23:59:59Z",
        1e12,
        null,
      ]);
      break;
    case "timestamps_bad":
      s.timestamps = p.pick([
        null,
        {},
        { startMs: -1, endMs: 1, contactMs: null },
        { startMs: 0.5, endMs: 1, contactMs: null },
        { startMs: 0, endMs: 2_147_483_648, contactMs: null },
        [],
      ]);
      break;
    case "resultKind_bad":
      s.resultKind = p.pick(["SCORED", "unknown", null, 1]);
      break;
    case "overallScore_out_of_range":
      s.overallScore = p.pick([-0.001, 10.001, 11, -1, 1e308]);
      break;
    case "overallScore_wrong_type":
      s.overallScore = p.pick(["7", null, true, [7]]);
      break;
    case "confidence_bad":
      s.confidence = p.pick([-0.1, 1.1, "0.5", null]);
      break;
    case "phases_not_array":
      s.phases = p.pick([null, {}, "prep", 1]);
      break;
    case "phases_too_many":
      s.phases = Array.from({ length: 33 }, (_, i) => ({
        key: `k${i}`,
        startMs: 0,
        representativeMs: 0,
        endMs: 0,
        confidence: 0,
      }));
      break;
    case "phase_duplicate_key":
      s.phases = [
        { key: "dup", startMs: 0, representativeMs: 0, endMs: 0, confidence: 0 },
        { key: "dup", startMs: 0, representativeMs: 0, endMs: 0, confidence: 0 },
      ];
      break;
    case "checkpoint_bad_band":
      s.checkpoints = [
        {
          key: "c",
          score: null,
          confidence: 0,
          band: p.pick(["blue", "", "GREEN"]),
          direction: "",
          severity: 0,
          applicable: true,
        },
      ];
      break;
    case "checkpoints_too_many":
      s.checkpoints = Array.from({ length: 65 }, (_, i) => ({
        key: `c${i}`,
        score: null,
        confidence: 0,
        band: "green",
        direction: "",
        severity: 0,
        applicable: true,
      }));
      break;
    case "versionVector_missing":
      s.versionVector = p.pick([null, [], "1.0.0"]);
      break;
    case "versionVector_key_65":
      s.versionVector = {
        ...(s.versionVector as Record<string, string>),
        appVersion: "v".repeat(65),
      };
      break;
  }
  return { shot: s, how };
}

function genShotsSync(c: Ctx): Built {
  const { p, h } = c;
  h.rpcs.apply_synced_shot = "accepted";
  const topKind = p.weighted<string>([
    [70, "array"],
    [10, "empty"],
    [8, "too_many"],
    [12, "wrong_type"],
  ]);
  let shots: unknown;
  const validIds: string[] = [];
  const invalidIds: string[] = [];
  const hows: string[] = [];
  let fuzzKeptValid = 0;
  if (topKind === "array") {
    const n = p.weighted<number>([
      [40, p.int(1, 5)],
      [10, p.int(6, 60)],
      [3, 200],
    ]);
    const list: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const base = validShot(p);
      const roll = p.next();
      if (roll < 0.45) {
        validIds.push(base.id as string);
        list.push(base);
      } else if (roll < 0.55) {
        // valid-by-contract fuzz: shotType is any non-blank ≤64-unit string
        const st = genString(p, { lengthClass: p.pick(["short", "medium", "cap_edge"]), cap: 64 });
        if (st.trim().length > 0 && st.length <= 64) {
          base.shotType = st;
          validIds.push(base.id as string);
          fuzzKeptValid++;
          list.push(base);
        } else {
          validIds.push(base.id as string);
          list.push(base);
        }
      } else {
        const broken = breakShot(p, base);
        hows.push(broken.how);
        const raw = broken.shot;
        const rawId = isRecord(raw) && typeof raw.id === "string" ? raw.id : "unknown";
        invalidIds.push(rawId);
        list.push(raw);
      }
    }
    shots = list;
  } else if (topKind === "empty") shots = [];
  else if (topKind === "too_many") shots = Array.from({ length: 201 }, () => validShot(p));
  else {
    shots = genWrongType(p);
    // a wrong-typed value that happens to be a non-empty array routes as a
    // batch of malformed entries
    if (Array.isArray(shots)) {
      for (const raw of shots)
        invalidIds.push(isRecord(raw) && typeof raw.id === "string" ? raw.id : "unknown");
    }
  }
  const b = maybeProto(p, withSchemaVersion(p, { shots }));
  const topValid = Array.isArray(shots) && shots.length >= 1 && shots.length <= 200;
  return {
    request: jsonRequest(c, "POST", "/v1/shots:sync", b),
    valid: topValid,
    route: "POST /v1/shots:sync",
    expectStatus: topValid ? 200 : 400,
    metrics: {
      shots: Array.isArray(shots) ? shots.length : 0,
      invalidShots: invalidIds.length,
      fuzzKeptValid,
      hows,
    },
    post: (res, text, calls) => {
      const rpc = calls.filter((x) => x.url.includes("/rpc/apply_synced_shot"));
      if (!topValid)
        return rpc.length === 0 ? null : "apply_synced_shot called for a rejected batch";
      if (res.status !== 200) return `expected 200 for a routed batch, got ${res.status}`;
      const body = JSON.parse(text) as {
        acceptedIds: string[];
        rejected: Array<{ id: string; code: string }>;
      };
      if (rpc.length !== validIds.length)
        return `apply_synced_shot called ${rpc.length}×, ${validIds.length} valid shots`;
      const rpcIds = rpc.map((x) =>
        isRecord(x.body) && isRecord(x.body.shot) ? x.body.shot.id : undefined,
      );
      for (const id of invalidIds)
        if (rpcIds.includes(id)) return `malformed shot ${preview(id, 40)} reached the RPC`;
      if (body.acceptedIds.length !== validIds.length)
        return `acceptedIds=${body.acceptedIds.length}, valid=${validIds.length}`;
      if (body.rejected.length !== invalidIds.length)
        return `rejected=${body.rejected.length}, invalid=${invalidIds.length}`;
      for (const r of body.rejected) {
        if (r.code !== "shot.invalid_payload" && r.code !== "shot.non_real_source")
          return `unexpected rejection code ${r.code}`;
      }
      return null;
    },
  };
}

function genSession(c: Ctx): Built {
  const { p } = c;
  const b = maybeProto(
    p,
    withSchemaVersion(p, {
      id: p.chance(0.5) ? p.uuid() : fuzzField(p, 36),
      startedAt: p.chance(0.5)
        ? p.pick([
            "2026-08-31T10:00:00.000Z",
            "2026-02-30T10:00:00.000Z",
            "2026-08-31T10:00:00Z",
            "1999-12-31T23:59:59.000Z",
            "2100-01-01T00:00:00.000Z",
            "2026-08-31T24:00:00.000Z",
            "2026-08-31T10:00:00.1234567890Z",
            "2026-08-31 10:00:00Z",
          ])
        : fuzzField(p, 30),
      mode: fuzzField(p, 16),
    }),
  );
  const valid = isUuid(b.id) && isIso(b.startedAt);
  return {
    request: jsonRequest(c, "POST", "/v1/sessions", b),
    valid,
    route: "POST /v1/sessions",
    // valid → upsert (fake: 201) then ownership read finds no row → 409
    expectStatus: valid ? 409 : 400,
    writesAllowedOn4xx: valid,
  };
}

function genSessionFinalize(c: Ctx): Built {
  const { p } = c;
  const seg = genPathSegment(p, p.pick(PATH_KINDS));
  const path = `/v1/sessions/${seg}/finalize`;
  let decoded: string | null;
  try {
    decoded = decodeURIComponent(new URL(`${BASE}${path}`).pathname.split("/").at(-2) ?? "");
  } catch {
    decoded = null;
  }
  const routed = /^\/v1\/sessions\/([^/]+)\/finalize$/.test(pathOf(path));
  const valid = routed && decoded !== null && isUuid(decoded);
  const body = p.chance(0.5) ? undefined : genWrongType(p);
  return {
    request: jsonRequest(c, "POST", path, body),
    valid,
    route: "POST /v1/sessions/:id/finalize",
    expectStatus: valid ? 404 : undefined,
  };
}

function genFeedback(c: Ctx): Built {
  const { p } = c;
  const seg = genPathSegment(p, p.pick(PATH_KINDS));
  const path = `/v1/analyses/${seg}/feedback`;
  let decoded: string | null;
  try {
    decoded = decodeURIComponent(new URL(`${BASE}${path}`).pathname.split("/").at(-2) ?? "");
  } catch {
    decoded = null;
  }
  const routed = /^\/v1\/analyses\/([^/]+)\/feedback$/.test(pathOf(path));
  const rating = p.chance(0.6) ? p.pick(["accurate", "not_quite"]) : fuzzField(p, 16);
  const category = p.chance(0.5)
    ? p.pick(FEEDBACK_CATEGORIES)
    : p.chance(0.5)
      ? undefined
      : fuzzField(p, 32);
  const b = maybeProto(p, withSchemaVersion(p, { rating, category }));
  const cat = b.category ?? null;
  const valid =
    routed &&
    decoded !== null &&
    isUuid(decoded) &&
    typeof b.rating === "string" &&
    ["accurate", "not_quite"].includes(b.rating) &&
    (b.rating === "not_quite") === (typeof cat === "string" && FEEDBACK_CATEGORIES.includes(cat));
  return {
    request: jsonRequest(c, "POST", path, b),
    valid,
    route: "POST /v1/analyses/:id/feedback",
    expectStatus: valid ? 404 : undefined,
  };
}

function genTrials(c: Ctx): Built {
  const { p, h } = c;
  const consent = p.chance(0.6);
  if (consent) {
    h.tables.consent_records = [
      {
        scope: "evaluation_telemetry",
        action: "grant",
        consent_version: "1",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
  }
  const kind = p.weighted<string>([
    [70, "array"],
    [10, "empty"],
    [8, "too_many"],
    [12, "wrong_type"],
  ]);
  let trials: unknown;
  const validIds: string[] = [];
  let invalid = 0;
  let oversized = 0;
  if (kind === "array") {
    const n = p.int(1, 6);
    const list: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const roll = p.next();
      if (roll < 0.5) {
        const id = p.uuid();
        validIds.push(id);
        list.push({
          trialId: id,
          schemaVersion: p.pick([1, 2, 99]),
          payload: genString(p, { lengthClass: p.pick(["short", "medium"]) }),
        });
      } else if (roll < 0.6) {
        oversized++;
        list.push({ trialId: p.uuid(), blob: "x".repeat(250_001) });
      } else {
        invalid++;
        list.push(
          p.pick([
            null,
            1,
            "t",
            [],
            { trialId: genString(p, { lengthClass: "short" }) },
            { trialId: 5 },
            {},
          ]),
        );
      }
    }
    trials = list;
  } else if (kind === "empty") trials = [];
  else if (kind === "too_many") trials = Array.from({ length: 201 }, () => ({ trialId: p.uuid() }));
  else {
    trials = genWrongType(p);
    if (Array.isArray(trials)) invalid = trials.length;
  }
  const b = maybeProto(p, withSchemaVersion(p, { trials }));
  const topValid = Array.isArray(trials) && trials.length >= 1 && trials.length <= 200;
  return {
    request: jsonRequest(c, "POST", "/v1/me/evaluation/trials", b),
    valid: topValid,
    route: "POST /v1/me/evaluation/trials",
    expectStatus: !topValid ? 400 : consent ? 200 : 403,
    metrics: { consent, invalid, oversizedTrials: oversized },
    post: (res, text, calls) => {
      const writes = calls.filter(
        (x) => x.url.includes("/rest/v1/evaluation_trials") && x.method !== "GET",
      );
      if (!topValid || !consent)
        return writes.length === 0 ? null : "evaluation_trials written for a rejected batch";
      if (res.status !== 200) return `expected 200, got ${res.status}`;
      if (writes.length !== validIds.length)
        return `evaluation_trials upserts=${writes.length}, valid=${validIds.length}`;
      const body = JSON.parse(text) as {
        acceptedTrialIds: string[];
        rejected: Array<{ code: string }>;
      };
      // fake upsert → ownership read finds no row → id_conflict for every valid trial
      if (body.acceptedTrialIds.length !== 0) return "fake store accepted a trial it never stored";
      const byCode: Record<string, number> = {};
      for (const r of body.rejected) byCode[r.code] = (byCode[r.code] ?? 0) + 1;
      if ((byCode["evaluation.trial_invalid"] ?? 0) !== invalid + oversized)
        return `trial_invalid=${byCode["evaluation.trial_invalid"] ?? 0}, expected ${invalid + oversized}`;
      if ((byCode["evaluation.trial_id_conflict"] ?? 0) !== validIds.length)
        return `trial_id_conflict=${byCode["evaluation.trial_id_conflict"] ?? 0}, expected ${validIds.length}`;
      return null;
    },
  };
}

function genDeleteRequest(c: Ctx): Built {
  const { p, h } = c;
  h.rpcs.access_state = [{ premium: false, scored_count: 1 }];
  const survey = p.weighted<unknown>([
    [30, undefined],
    [20, () => genWrongType(p)],
    [
      50,
      () => ({
        reason: p.chance(0.5) ? p.pick(SURVEY_REASONS) : fuzzField(p, 50),
        wanted: fuzzField(p, 20),
        details: fuzzField(p, 500),
        platform: p.pick(["ios", "android", "web", 1, null, undefined]),
        appVersion: fuzzField(p, 64),
      }),
    ],
  ]);
  const s = typeof survey === "function" ? (survey as () => unknown)() : survey;
  const b = maybeProto(p, withSchemaVersion(p, s === undefined ? {} : { survey: s }));
  const surveyValid =
    isRecord(b.survey) &&
    typeof b.survey.reason === "string" &&
    SURVEY_REASONS.includes(b.survey.reason);
  return {
    request: jsonRequest(c, "POST", "/v1/me/delete-request", b),
    valid: true,
    route: "POST /v1/me/delete-request",
    expectStatus: 200,
    post: (_res, _text, calls) => {
      const feedback = calls.filter((x) => x.url.includes("/rest/v1/account_deletion_feedback"));
      if (surveyValid && feedback.length !== 1)
        return `valid survey → ${feedback.length} feedback writes`;
      if (!surveyValid && feedback.length !== 0) return "malformed survey was written";
      return null;
    },
  };
}

function genDeleteConfirm(c: Ctx): Built {
  const { p } = c;
  const b = maybeProto(
    p,
    withSchemaVersion(p, { challenge: p.chance(0.5) ? p.uuid() : fuzzField(p, 36) }),
  );
  const valid = isUuid(b.challenge);
  return {
    request: jsonRequest(c, "POST", "/v1/me/delete-confirm", b),
    valid,
    route: "POST /v1/me/delete-confirm",
    expectStatus: valid ? 403 : 400,
  };
}

function genRefresh(c: Ctx): Built {
  const { p } = c;
  const b = maybeProto(
    p,
    withSchemaVersion(p, { refreshToken: p.chance(0.4) ? "refresh-token" : fuzzField(p, 64) }),
  );
  const valid = typeof b.refreshToken === "string" && b.refreshToken.trim().length > 0;
  const headers = safeHeaders(c, { "Content-Type": "application/json" });
  headers.delete("Authorization");
  return {
    request: new Request(`${BASE}/v1/auth/refresh`, {
      method: "POST",
      headers,
      body: JSON.stringify(b),
    }),
    valid,
    route: "POST /v1/auth/refresh",
    expectStatus: valid ? 200 : 400,
  };
}

function genSavedDrill(c: Ctx): Built {
  const { p } = c;
  const method = p.pick(["PUT", "DELETE"]);
  const seg = genPathSegment(p, p.pick(PATH_KINDS));
  const path = `/v1/me/saved-drills/${seg}`;
  const decoded = decodedSegment(path, /^\/v1\/me\/saved-drills\/([^/]+)$/);
  // PUT validates the slug; DELETE has no slug validation (a scoped delete of
  // nothing) — for both, an undecodable segment is a 400.
  const valid = decoded !== null && (method === "DELETE" || DRILL_SLUG_RE.test(decoded));
  return {
    request: jsonRequest(c, method, path, p.chance(0.5) ? undefined : { slug: seg, saved: true }),
    valid,
    route: `${method} /v1/me/saved-drills/:slug`,
  };
}

function genCatalog(c: Ctx): Built {
  const { p } = c;
  if (p.chance(0.5)) {
    const seg = genPathSegment(p, p.pick(PATH_KINDS));
    const path = `/v1/catalog/drills/${seg}`;
    return {
      request: jsonRequest(c, "GET", path, undefined),
      valid: decodedSegment(path, /^\/v1\/catalog\/drills\/([^/]+)$/) !== null,
      route: "GET /v1/catalog/drills/:slug",
    };
  }
  const q = safeEncode(
    genString(p, { lengthClass: p.pick(["empty", "short", "medium", "large"]) }),
  );
  const family = safeEncode(genString(p, { lengthClass: p.pick(["empty", "short"]) }));
  return {
    request: jsonRequest(
      c,
      "GET",
      `/v1/catalog/drills?q=${q}&family=${family}&${CANARY}=1`,
      undefined,
    ),
    valid: true,
    route: "GET /v1/catalog/drills",
    expectStatus: 200,
  };
}

function genUnknownRoute(c: Ctx): Built {
  const { p } = c;
  const seg = genPathSegment(p, p.pick(PATH_KINDS));
  const path = p.pick([
    `/v1/${seg}`,
    `/v1/me/${seg}`,
    `/v1/me/onboarding/${seg}`,
    `/${seg}/v1/me`,
    `/v2/me`,
    `/v1/shots:sync/${seg}`,
    `/v1/${seg}/v1/me`,
    `/v1/me?${CANARY}=${seg}`,
  ]);
  // (TRACE/CONNECT/TRACK are forbidden by the Fetch spec and never reach a handler)
  const method = p.pick([
    "GET",
    "POST",
    "PUT",
    "DELETE",
    "PATCH",
    "OPTIONS",
    "HEAD",
    "PURGE",
    "PROPFIND",
  ]);
  const body = method === "GET" || method === "HEAD" ? undefined : genWrongType(p);
  return {
    request: jsonRequest(c, method, path, body),
    valid: false,
    route: "unknown",
  };
}

function genBearer(c: Ctx): Built {
  const { p } = c;
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const now = Math.floor(Date.now() / 1000);
  const jwt = (payload: unknown) => `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
  const kind = p.pick([
    "empty",
    "garbage",
    "no_bearer_prefix",
    "two_segments",
    "four_segments",
    "bad_base64",
    "payload_array",
    "iss_number",
    "iss_unknown",
    "expired",
    "exp_string",
    "exp_huge",
    "apple_valid",
    "google_valid",
    "supabase_issued",
    "huge",
    "latin1",
    "controls",
    "lowercase_bearer",
    "double_space",
  ]);
  let value: string | null;
  let expect: number | null = 401;
  switch (kind) {
    case "empty":
      value = "";
      break;
    case "garbage":
      value = `Bearer ${genHeaderValue(p, 64)}`;
      break;
    case "no_bearer_prefix":
      value = fakeGoogleIdToken(p.uuid());
      break;
    case "two_segments":
      value = `Bearer a.${b64({ iss: "https://accounts.google.com", exp: now + 60 })}`;
      break;
    case "four_segments":
      value = `Bearer ${fakeGoogleIdToken(p.uuid())}.extra`;
      break;
    case "bad_base64":
      value = "Bearer a.!!!!.b";
      break;
    case "payload_array":
      value = `Bearer ${jwt([1, 2])}`;
      break;
    case "iss_number":
      value = `Bearer ${jwt({ iss: 1, exp: now + 60 })}`;
      break;
    case "iss_unknown":
      value = `Bearer ${jwt({ iss: "https://evil.example", sub: p.uuid(), exp: now + 60 })}`;
      break;
    case "expired":
      value = `Bearer ${jwt({ iss: "https://accounts.google.com", sub: p.uuid(), exp: now - 5 })}`;
      break;
    case "exp_string":
      value = `Bearer ${jwt({ iss: "https://accounts.google.com", sub: p.uuid(), exp: "later" })}`;
      expect = null;
      break;
    case "exp_huge":
      value = `Bearer ${jwt({ iss: "https://accounts.google.com", sub: p.uuid(), exp: 1e300 })}`;
      expect = null;
      break;
    case "apple_valid":
      value = `Bearer ${fakeAppleIdToken(p.uuid())}`;
      expect = null;
      break;
    case "google_valid":
      value = `Bearer ${fakeGoogleIdToken(p.uuid())}`;
      expect = null;
      break;
    case "supabase_issued":
      // verified via /auth/v1/user, which the fake does not serve → 5xx generic
      value = `Bearer ${jwt({ iss: `${SUPABASE_URL}/auth/v1`, sub: p.uuid(), session_id: p.uuid(), exp: now + 60 })}`;
      expect = null;
      break;
    case "huge":
      value = `Bearer ${"A".repeat(p.pick([8_192, 65_536, 262_144]))}`;
      break;
    case "latin1":
      value = `Bearer ${"\u00e9\u00ff\u0080".repeat(p.int(1, 20))}`;
      break;
    case "controls":
      value = `Bearer \u0001\u001f\u007f.\u000b.\t`;
      break;
    case "lowercase_bearer":
      value = `bearer ${fakeGoogleIdToken(p.uuid())}`;
      expect = null;
      break;
    case "double_space":
      value = `Bearer  ${fakeGoogleIdToken(p.uuid())}`;
      expect = null;
      break;
    default:
      value = null;
  }
  const headers = new Headers({ "x-forwarded-for": c.ip });
  if (value !== null) {
    try {
      headers.set("Authorization", value);
    } catch {
      value = null;
    }
  }
  return {
    request: new Request(`${BASE}/v1/me`, { method: "GET", headers }),
    valid: false,
    route: "GET /v1/me (bearer fuzz)",
    expectStatus: expect ?? undefined,
    metrics: { bearer: kind },
    post: (res, _text, calls) => {
      const writes = mutatingCalls(calls);
      if (writes.length) return "bearer fuzz produced a write";
      if (kind !== "google_valid" && kind !== "apple_valid" && res.status < 400)
        return `bearer ${kind} was accepted (${res.status})`;
      return null;
    },
  };
}

function genRawBodyRoute(c: Ctx): Built {
  const { p } = c;
  const targets: Array<[string, string, Record<string, unknown>, boolean]> = [
    [
      "PUT",
      "/v1/me/onboarding",
      { skillLevel: "3.5", handedness: "right", goal: "power", biggestProblem: "x" },
      true,
    ],
    ["POST", "/v1/me/consent/grant", { scope: "video_analysis", consentVersion: "1" }, true],
    ["POST", "/v1/me/consent/withdraw", { scope: "video_analysis" }, true],
    ["POST", "/v1/analysis-permits", { idempotencyKey: p.uuid() }, true],
    ["POST", "/v1/shots:sync", { shots: [validShot(p)] }, true],
    ["POST", "/v1/sessions", { id: p.uuid(), startedAt: "2026-08-31T10:00:00.000Z" }, true],
    ["POST", "/v1/me/evaluation/trials", { trials: [{ trialId: p.uuid() }] }, true],
    ["POST", "/v1/me/delete-confirm", { challenge: p.uuid() }, true],
    ["POST", "/v1/auth/refresh", { refreshToken: "r" }, true],
    [
      "POST",
      `/v1/analysis-permits/${p.uuid()}/finalize`,
      { outcome: "cancelled", ratingId: null },
      true,
    ],
    ["POST", `/v1/analyses/${p.uuid()}/feedback`, { rating: "accurate" }, true],
    ["POST", "/v1/me/delete-request", {}, false],
  ];
  const [method, path, payload, requiresFields] = p.pick(targets);
  if (path === "/v1/analysis-permits")
    c.h.rpcs.reserve_analysis_permit = [
      {
        result: "accepted",
        permit_id: p.uuid(),
        permit_status: "reserved",
        permit_outcome: null,
        permit_created_at: new Date().toISOString(),
      },
    ];
  if (path === "/v1/shots:sync") c.h.rpcs.apply_synced_shot = "accepted";
  if (path === "/v1/me/delete-request")
    c.h.rpcs.access_state = [{ premium: false, scored_count: 0 }];
  const kind = p.pick(RAW_BODY_KINDS);
  const raw = genRawBody(p, payload, kind);
  const contentType = p.weighted<string | null>([
    [60, "application/json"],
    [10, "application/json; charset=utf-8"],
    [10, "text/plain"],
    [5, "application/x-www-form-urlencoded"],
    [5, "multipart/form-data; boundary=x"],
    [5, genHeaderValue(p, 40)],
    [5, null],
  ]);
  const extra: Record<string, string> = {};
  if (contentType !== null) extra["Content-Type"] = contentType;
  // Content-Length games: the handler treats the header as advisory only.
  const clKind = p.weighted<string>([
    [70, "none"],
    [10, "under"],
    [10, "over"],
    [5, "garbage"],
    [5, "negative"],
  ]);
  if (clKind === "under")
    extra["Content-Length"] = String(Math.max(0, raw.bytes.length - p.int(1, 10)));
  if (clKind === "over") extra["Content-Length"] = String(raw.bytes.length + p.int(1, 1000));
  if (clKind === "garbage")
    extra["Content-Length"] = p.pick(["abc", "1e3", "0x10", "", " 12 ", "12,13"]);
  if (clKind === "negative") extra["Content-Length"] = "-1";
  const headers = safeHeaders(c, extra);
  if (path === "/v1/auth/refresh") headers.delete("Authorization");
  const streamed = p.chance(0.25);
  const body = streamed ? chunkedStream(p, raw.bytes) : raw.bytes;
  const request = new Request(`${BASE}${path}`, { method, headers, body: body as BodyInit });
  // Oracle: a body that does not parse to a JSON object becomes {} at the
  // route → every field-requiring route must answer 400 without writing.
  // A body that DOES parse to the valid payload must not be answered 400.
  // Decoded exactly like the handler (TextDecoder strips a leading BOM and
  // maps invalid UTF-8 to U+FFFD) so the verdict is the handler's own parse.
  const bodyIsObject = parseRecordBytes(raw.bytes);
  const valid = bodyIsObject !== null || !requiresFields;
  return {
    request,
    valid,
    route: `${method} ${path.replace(UUID_RE_G, ":id")} (raw ${kind})`,
    writesAllowedOn4xx: path === "/v1/sessions",
    metrics: { rawKind: kind, bytes: raw.bytes.length, contentType, clKind, streamed },
    post: (res) => {
      if (bodyIsObject === null && requiresFields && res.status !== 400)
        return `non-object body → ${res.status}, expected 400`;
      if (bodyIsObject !== null && res.status === 400 && kind !== "duplicate_keys")
        return "valid payload text answered 400";
      return null;
    },
  };
}
const UUID_RE_G = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

function parseRecordBytes(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function chunkedStream(p: Prng, bytes: Uint8Array): ReadableStream<Uint8Array> {
  const chunk = p.pick([1, 7, 64, 1024, 65_536]);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
}

function genOversized(c: Ctx): Built {
  const { p } = c;
  const kind = p.pick([
    "declared_over",
    "declared_over_no_body",
    "streamed_over",
    "streamed_exact",
    "streamed_over_by_one",
    "stream_error",
  ]);
  const path = p.pick([
    "/v1/me/onboarding",
    "/v1/shots:sync",
    "/v1/me/consent/grant",
    "/v1/auth/refresh",
  ]);
  const method = path === "/v1/me/onboarding" ? "PUT" : "POST";
  const headers = safeHeaders(c, { "Content-Type": "application/json" });
  if (path === "/v1/auth/refresh") headers.delete("Authorization");
  let body: BodyInit | undefined;
  let expectStatus: number;
  switch (kind) {
    case "declared_over":
      headers.set("Content-Length", String(MAX_JSON_BODY_BYTES + p.int(1, 1_000_000)));
      body = "{}";
      expectStatus = 413;
      break;
    case "declared_over_no_body": {
      const declared = p.pick(["5000001", "99999999999", "1e400", String(Number.MAX_SAFE_INTEGER)]);
      headers.set("Content-Length", declared);
      body = undefined;
      // A non-finite declaration (`1e400` → Infinity) is not a "declared
      // size" at all: the advisory check passes and the streamed byte count
      // (here 0 bytes → {} → route validation 400) is the enforcement.
      expectStatus = Number.isFinite(Number(declared)) ? 413 : 400;
      break;
    }
    case "streamed_over": {
      const total = MAX_JSON_BODY_BYTES + p.int(1, 200_000);
      body = fillStream(total, 65_536);
      expectStatus = 413;
      break;
    }
    case "streamed_over_by_one":
      body = fillStream(MAX_JSON_BODY_BYTES + 1, p.pick([1, 65_536, MAX_JSON_BODY_BYTES + 1]));
      expectStatus = 413;
      break;
    case "streamed_exact":
      // exactly the cap: read fully → whitespace-padded `{}` parses → route 400
      body = fillStream(MAX_JSON_BODY_BYTES, 65_536, true);
      expectStatus = 400;
      break;
    default: {
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"scope":"video_analysis"'));
          controller.error(new Error("client aborted"));
        },
      });
      // a failed read yields "" → {} → the route's validation 400
      expectStatus = 400;
    }
  }
  return {
    request: new Request(`${BASE}${path}`, { method, headers, body }),
    valid: false,
    route: `${method} ${path} (${kind})`,
    expectStatus,
    metrics: { oversized: kind },
    post: (_res, _text, calls) => {
      // A declared oversize is refused before auth (no upstream call at all).
      // A streamed oversize is only knowable while reading the body, which
      // happens after auth: the auth lookup is fine, a write is not.
      if (kind.startsWith("declared") && expectStatus === 413 && calls.length > 0)
        return `${calls.length} upstream call(s) made for a declared-oversize 413`;
      if (mutatingCalls(calls).length > 0) return "oversized/aborted body produced a write";
      return null;
    },
  };
}

/** A stream of `total` bytes: spaces, optionally ending in `{}` so the whole
 * thing is valid JSON of exactly `total` bytes. */
function fillStream(total: number, chunk: number, json = false): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(chunk, total - sent);
      const buf = new Uint8Array(n).fill(0x20);
      if (json && sent + n === total && n >= 2) {
        buf[n - 2] = 0x7b;
        buf[n - 1] = 0x7d;
      }
      sent += n;
      controller.enqueue(buf);
    },
  });
}

function genHeaderFuzz(c: Ctx): Built {
  const { p } = c;
  const extra: Record<string, string> = {};
  let requestId: string | undefined;
  const ridKind = p.pick([
    "none",
    "valid",
    "too_short",
    "too_long",
    "bad_chars",
    "injection",
    "spaces",
    "unicode_latin1",
    "controls",
  ]);
  switch (ridKind) {
    case "valid":
      requestId = `req-${p.uuid()}`.slice(0, p.int(8, 64));
      extra["x-request-id"] = requestId;
      break;
    case "too_short":
      extra["x-request-id"] = "a".repeat(p.int(1, 7));
      break;
    case "too_long":
      extra["x-request-id"] = "a".repeat(p.pick([65, 200, 8192]));
      break;
    case "bad_chars":
      extra["x-request-id"] =
        `abc${p.pick(["/", "\\", ":", "%", '"', "'", "<", ">", "=", "+", ","])}defghijk`;
      break;
    case "injection":
      extra["x-request-id"] = `abcdefgh${p.pick([" X-Injected: 1", "\tX: y", "%0d%0aX:1"])}`;
      break;
    case "spaces":
      extra["x-request-id"] = `   ${"b".repeat(10)}   `;
      break;
    case "unicode_latin1":
      extra["x-request-id"] = "abcdefgh\u00e9\u00ff";
      break;
    case "controls":
      extra["x-request-id"] = `abcdefgh\u0001\u007f`;
      break;
  }
  const ipKind = p.pick([
    "xff_list",
    "xff_garbage",
    "cf",
    "cf_and_xff",
    "cf_blank",
    "xff_empty_hops",
    "xff_huge",
    "none",
  ]);
  const headers = safeHeaders(c, extra);
  headers.delete("x-forwarded-for");
  switch (ipKind) {
    case "xff_list":
      headers.set("x-forwarded-for", `${p.ip()}, ${p.ip()},${c.ip}`);
      break;
    case "xff_garbage":
      headers.set("x-forwarded-for", genHeaderValue(p, 200));
      break;
    case "cf":
      headers.set("cf-connecting-ip", c.ip);
      break;
    case "cf_and_xff":
      headers.set("cf-connecting-ip", c.ip);
      headers.set("x-forwarded-for", genHeaderValue(p, 100));
      break;
    case "cf_blank":
      headers.set("cf-connecting-ip", "   ");
      headers.set("x-forwarded-for", c.ip);
      break;
    case "xff_empty_hops":
      headers.set("x-forwarded-for", `,,, ${c.ip} ,,`);
      break;
    case "xff_huge":
      headers.set("x-forwarded-for", `${"1.1.1.1,".repeat(2000)}${c.ip}`);
      break;
    default:
      // no ip header at all → "unknown" bucket (shared; may 429 — recorded)
      break;
  }
  // more header noise
  for (let i = 0; i < p.int(0, 4); i++) {
    const name = p.pick([
      "Accept",
      "Accept-Encoding",
      "Origin",
      "Referer",
      "User-Agent",
      "Cookie",
      "X-Real-IP",
      "Host",
      "Transfer-Encoding",
      "Expect",
      "Range",
      "If-None-Match",
      "Content-Encoding",
      `X-${p.int(0, 9)}`,
    ]);
    try {
      headers.set(name, genHeaderValue(p, 400));
    } catch {
      // unreachable over the wire
    }
  }
  const target = p.pick<[string, string, unknown]>([
    ["GET", "/v1/me", undefined],
    ["GET", "/v1/me/access", undefined],
    ["GET", "/v1/me/consent/status", undefined],
    ["GET", "/v1/me/saved-drills", undefined],
    ["GET", "/v1/training-plans/current", undefined],
    ["POST", "/v1/training-plans", {}],
    ["POST", "/v1/me/consent/withdraw", { scope: "video_analysis" }],
    ["GET", "/healthz", undefined],
  ]);
  const [method, path, body] = target;
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return {
    request: new Request(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    valid: true,
    route: `${method} ${path} (headers)`,
    requestId,
    metrics: { ridKind, ipKind },
    post: (res) => {
      const rid = res.headers.get("x-request-id") ?? "";
      if (requestId !== undefined && rid !== requestId)
        return `valid x-request-id not echoed (${preview(rid)})`;
      if (requestId === undefined && ridKind !== "none" && rid === extra["x-request-id"])
        return "invalid x-request-id echoed";
      if (path === "/healthz" && ipKind !== "none" && res.status !== 200)
        return `healthz → ${res.status}`;
      return null;
    },
  };
}

function genPublic(c: Ctx): Built {
  const { p } = c;
  const method = p.pick(["GET", "HEAD", "GET", "GET"]);
  const page = p.pick(["healthz", "support", "privacy", "terms"]);
  const seg = genPathSegment(p, p.pick(PATH_KINDS));
  const path = p.pick([
    `/${page}`,
    `/v1/${page}`,
    `/${seg}/${page}`,
    `/${page}?${CANARY}=${safeEncode(seg)}`,
    `/${page}#frag`,
    `/${page}/`,
    `/${page.toUpperCase()}`,
    `/v1/me/../${page}`,
  ]);
  const headers = new Headers({ "x-forwarded-for": c.ip });
  const routed = new URL(`${BASE}${path}`).pathname.endsWith(`/${page}`);
  return {
    request: new Request(`${BASE}${path}`, { method, headers }),
    valid: true,
    route: `${method} /${page} (public)`,
    expectStatus: routed ? 200 : 401,
    post: (res, text, calls) => {
      if (calls.length) return "public page made an upstream call";
      if (routed && page !== "healthz") {
        if (!(res.headers.get("content-type") ?? "").startsWith("text/plain"))
          return "legal page not text/plain";
        if (method === "GET" && text.length === 0) return "legal page body empty";
      }
      if (text.includes(CANARY)) return "query string reflected in a public page";
      return null;
    },
  };
}

function genWebhook(c: Ctx): Built {
  const { p, h } = c;
  h.subscriber = { entitlements: {} };
  const authKind = p.weighted<string>([
    [45, "right"],
    [15, "wrong"],
    [10, "missing"],
    [10, "prefix"],
    [10, "case"],
    [5, "longer"],
    [5, "latin1"],
  ]);
  const headers = new Headers({ "Content-Type": "application/json", "x-forwarded-for": c.ip });
  switch (authKind) {
    case "right":
      headers.set("Authorization", WEBHOOK_SECRET);
      break;
    case "wrong":
      headers.set("Authorization", genHeaderValue(p, 64));
      break;
    case "prefix":
      headers.set("Authorization", `Bearer ${WEBHOOK_SECRET}`);
      break;
    case "case":
      headers.set("Authorization", WEBHOOK_SECRET.toUpperCase());
      break;
    case "longer":
      headers.set("Authorization", `${WEBHOOK_SECRET}\u0080`);
      break;
    case "latin1":
      headers.set("Authorization", WEBHOOK_SECRET.replace(/e/g, "\u00e9"));
      break;
    default:
      break;
  }
  const authed = authKind === "right";
  const eventKind = p.pick([
    "valid_uuid_user",
    "no_user",
    "aliases_only",
    "event_not_object",
    "event_missing",
    "raw",
    "id_wrong_type",
    "id_huge",
    "transfer",
    "prototype",
  ]);
  let bodyText: string;
  let eventObject = true;
  switch (eventKind) {
    case "valid_uuid_user":
      bodyText = JSON.stringify({
        event: { id: p.uuid(), type: "INITIAL_PURCHASE", app_user_id: p.uuid() },
      });
      break;
    case "no_user":
      bodyText = JSON.stringify({
        event: { id: p.uuid(), type: "TEST", app_user_id: genString(p, { lengthClass: "short" }) },
      });
      break;
    case "aliases_only":
      bodyText = JSON.stringify({
        event: {
          id: p.uuid(),
          type: "TEST",
          aliases: [genString(p, { lengthClass: "short" }), p.uuid(), 5],
        },
      });
      break;
    case "event_not_object": {
      const event = genWrongType(p);
      bodyText = JSON.stringify({ event });
      eventObject = isRecord(event);
      break;
    }
    case "event_missing":
      bodyText = JSON.stringify({ api_version: "1.0" });
      eventObject = false;
      break;
    case "raw": {
      const raw = genRawBody(p, { event: { id: p.uuid(), type: "TEST" } }, p.pick(RAW_BODY_KINDS));
      bodyText = new TextDecoder().decode(raw.bytes);
      const parsed = parseRecordBytes(raw.bytes);
      eventObject = parsed !== null && isRecord(parsed.event);
      break;
    }
    case "id_wrong_type":
      bodyText = JSON.stringify({
        event: { id: genWrongType(p), type: genWrongType(p), app_user_id: p.uuid() },
      });
      break;
    case "id_huge":
      bodyText = JSON.stringify({
        event: {
          id: genString(p, { lengthClass: "large" }),
          type: "x".repeat(10_000),
          app_user_id: p.uuid(),
        },
      });
      break;
    case "transfer":
      bodyText = JSON.stringify({
        event: {
          id: p.uuid(),
          type: "TRANSFER",
          transferred_from: [p.uuid(), "x"],
          transferred_to: genWrongType(p),
        },
      });
      break;
    default:
      bodyText = `{"__proto__":{"polluted":true},"event":{"id":"${p.uuid()}","type":"TEST","constructor":{"prototype":{"x":1}}}}`;
  }
  const expectStatus = !authed ? 401 : !eventObject ? 400 : undefined;
  return {
    request: new Request(`${BASE}/webhooks/revenuecat`, {
      method: "POST",
      headers,
      body: bodyText,
    }),
    valid: authed && eventObject,
    route: "POST /webhooks/revenuecat",
    expectStatus,
    metrics: { authKind, eventKind },
    post: (res, _text, calls) => {
      if (!authed && calls.length) return "unauthenticated webhook made an upstream call";
      if (authed && !eventObject && mutatingCalls(calls).length)
        return "malformed webhook event was logged/written";
      if (authed && eventObject && res.status >= 500)
        return `authenticated webhook → ${res.status}`;
      return null;
    },
  };
}

// ── invariants applied to every response ─────────────────────────────────────

function mutatingCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => {
    if (!call.url.startsWith(`${SUPABASE_URL}/rest/v1/`)) return false;
    if (call.url.includes("/rest/v1/rpc/access_state")) return false;
    return call.method !== "GET" && call.method !== "HEAD";
  });
}

interface Captured {
  access: string[];
  errors: string[];
}

function checkCommon(
  built: Built,
  res: Response,
  text: string,
  calls: RecordedCall[],
  cap: Captured,
  ip: string,
): string[] {
  const problems: string[] = [];
  const status = res.status;
  if (!(status >= 200 && status <= 599) || status === 599) problems.push(`status ${status}`);
  const rid = res.headers.get("x-request-id") ?? "";
  if (!REQUEST_ID_RE.test(rid)) problems.push(`x-request-id invalid: ${preview(rid)}`);
  const ct = res.headers.get("content-type") ?? "";
  if (new RegExp(`[${NON_WS_C0_CLASS}]`).test(text)) problems.push("raw control bytes in body");
  if (ct.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      problems.push("JSON response does not parse");
    }
    if (res.headers.get("x-content-type-options") !== "nosniff") problems.push("nosniff missing");
    if (res.headers.get("cache-control") !== "no-store")
      problems.push("cache-control not no-store");
    if (status >= 400) {
      const err = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
      if (!err || typeof err.message !== "string")
        problems.push("error envelope missing error.message");
    }
  } else if (status >= 400 && built.request.method !== "HEAD") {
    problems.push(`non-JSON ${status}: ${ct}`);
  }
  if (status >= 500) {
    for (const marker of DETAIL_MARKERS) {
      if (text.includes(marker)) problems.push(`5xx body leaks detail (${marker})`);
    }
    if (status === 500) problems.push("500 from the handler (unhandled error path)");
  }
  if (status >= 400 && status < 500 && !built.writesAllowedOn4xx) {
    const writes = mutatingCalls(calls);
    if (writes.length)
      problems.push(
        `${writes.length} write(s) on a ${status}: ${writes.map((w) => `${w.method} ${w.url.slice(SUPABASE_URL.length)}`).join(", ")}`,
      );
  }
  if (!built.valid && status < 400) problems.push(`contract-invalid request accepted (${status})`);
  if (built.valid && status === 400) problems.push("contract-valid request answered 400");
  if (built.expectStatus !== undefined && status !== built.expectStatus) {
    problems.push(`expected ${built.expectStatus}, got ${status}`);
  }
  if (status !== 429 && built.route !== "unknown" && text.includes(CANARY))
    problems.push("canary reflected");
  // access log: exactly one line, categorical
  if (cap.access.length !== 1) problems.push(`${cap.access.length} access-log lines`);
  else {
    let entry: Record<string, unknown> | null = null;
    try {
      entry = JSON.parse(cap.access[0]) as Record<string, unknown>;
    } catch {
      problems.push("access-log line not JSON");
    }
    if (entry) {
      if (entry.status !== status) problems.push(`access log status ${entry.status} ≠ ${status}`);
      if (entry.requestId !== rid) problems.push("access log requestId ≠ response header");
      const line = cap.access[0];
      if (line.includes(CANARY)) problems.push("access log carries query/body content");
      if (line.includes("?")) problems.push("access log carries a query string");
      if (line.includes(`"ip"`) || line.includes(ip)) problems.push("access log carries an ip");
    }
  }
  for (const line of cap.errors)
    if (line.includes(CANARY)) problems.push("error log carries client canary");
  return problems;
}

// ── the campaign ─────────────────────────────────────────────────────────────

type Gen = (c: Ctx) => Built;
const GENERATORS: ReadonlyArray<readonly [number, string, Gen]> = [
  [10, "onboarding", genOnboarding],
  [7, "consent_grant", genConsentGrant],
  [4, "consent_withdraw", genConsentWithdraw],
  [7, "permit_reserve", genPermitReserve],
  [6, "permit_finalize", genPermitFinalize],
  [10, "shots_sync", genShotsSync],
  [5, "session", genSession],
  [4, "session_finalize", genSessionFinalize],
  [5, "feedback", genFeedback],
  [6, "trials", genTrials],
  [3, "delete_request", genDeleteRequest],
  [3, "delete_confirm", genDeleteConfirm],
  [3, "refresh", genRefresh],
  [4, "saved_drill", genSavedDrill],
  [3, "catalog", genCatalog],
  [4, "unknown_route", genUnknownRoute],
  [5, "bearer", genBearer],
  [12, "raw_body", genRawBodyRoute],
  [2, "oversized", genOversized],
  [5, "header_fuzz", genHeaderFuzz],
  [3, "public", genPublic],
  [5, "webhook", genWebhook],
];

Deno.test(
  "stress: real handler under seeded malformed/boundary requests (handler_boundary)",
  async () => {
    const h = await loadHarness();
    const statusCounts: Record<string, number> = {};
    const caseCounts: Record<string, number> = {};
    const dbCapExceededSeeds: number[] = [];
    const nulToRpcSeeds: number[] = [];
    const rateLimited: number[] = [];
    let maxMs = 0;
    let maxMsSeed = 0;

    const realConsole = { error: console.error, warn: console.warn, log: console.log };
    const report = await runCampaign(
      "handler_boundary",
      FILE,
      async (p, _i, seed): Promise<Omit<IterationRow, "i" | "seed">> => {
        h.reset();
        // distinct user + ip per iteration so per-user / per-ip budgets never
        // couple iterations (a 429 would hide the boundary behaviour)
        const c: Ctx = { p, h, token: fakeGoogleIdToken(p.uuid()), ip: p.ip() };
        const [, name, gen] = p.weighted(GENERATORS.map((g) => [g[0], g] as const));
        caseCounts[name] = (caseCounts[name] ?? 0) + 1;
        const built = gen(c);
        const cap: Captured = { access: [], errors: [] };
        const restoreAccess = captureAccessLog((line) => cap.access.push(line));
        console.error = (...args: unknown[]) =>
          cap.errors.push(args.map((a) => (typeof a === "string" ? a : preview(a, 400))).join(" "));
        console.warn = console.error;
        console.log = () => {};
        let res: Response;
        let text = "";
        const t0 = performance.now();
        try {
          res = await h.handler(built.request);
          text = await res.text();
        } finally {
          restoreAccess();
          console.error = realConsole.error;
          console.warn = realConsole.warn;
          console.log = realConsole.log;
        }
        const ms = performance.now() - t0;
        if (ms > maxMs) {
          maxMs = ms;
          maxMsSeed = seed;
        }
        const calls = [...h.calls];
        statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
        if (res.status === 429) rateLimited.push(seed);
        if (built.metrics?.dbCapExceeded) dbCapExceededSeeds.push(seed);
        if (built.metrics?.nulPassedToRpc) nulToRpcSeeds.push(seed);
        const problems = res.status === 429 ? [] : checkCommon(built, res, text, calls, cap, c.ip);
        const routeProblem = res.status === 429 ? null : built.post?.(res, text, calls);
        if (routeProblem) problems.push(routeProblem);
        const bodyText = BODY_TEXT.get(built.request);
        const bodyPreview = bodyText === undefined ? "" : ` body=${preview(bodyText, 300)}`;
        return {
          case: `${name}:${built.route}`,
          input: `${built.request.method} ${preview(new URL(built.request.url).pathname + new URL(built.request.url).search, 120)}${bodyPreview}`,
          outcome: problems.length ? "BROKEN" : "HELD",
          detail: problems.length ? problems.join("; ") : undefined,
          metrics: {
            status: res.status,
            valid: built.valid,
            upstreamCalls: calls.length,
            writes: mutatingCalls(calls).length,
            ms: Math.round(ms),
            body: preview(text, 100),
            ...built.metrics,
          },
        };
      },
      {
        metrics: () => ({
          statusCounts,
          caseCounts,
          rateLimited,
          dbCapExceededSeeds,
          nulToRpcSeeds,
          slowestMs: Math.round(maxMs),
          slowestSeed: maxMsSeed,
        }),
      },
    );
    const path = await writeCampaign(report);
    console.log(
      `[handler_boundary] executed=${report.executed} held=${report.held} broken=${report.broken} → ${path}`,
    );
    if (report.broken) console.log(brokenSummary(report));
    assertEquals(report.broken, 0, `broken iterations:\n${brokenSummary(report)}`);
    assert(report.executed >= Math.min(STRESS_ITER, 1), "campaign executed");
  },
);
