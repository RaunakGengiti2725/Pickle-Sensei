// stress-route-post-v1-me-delete-request — FUZZ/BOUNDARY harness.
//
// Drives the REAL edge handler (../index.ts, Deno.serve captured by
// routesHarness.ts; Supabase Auth + PostgREST + RevenueCat stubbed at the
// fetch layer, Upstash absent → in-memory limits) with SEEDED generated
// requests aimed at POST /v1/me/delete-request: method / path / query /
// header / body / content-length / bearer variations plus injected upstream
// faults. Every generated case is a pure function of its seed, so any row of
// the results table replays with STRESS_REPLAY=<seed>.
//
// The oracle below mirrors the handler's contract statement-for-statement
// (413 pre-check → auth → per-user route budget → body → upsert → optional
// survey) and is asserted STRICTLY: a divergence is either a wrong model or a
// real defect, and the results table records which.
//
// Nothing here contacts a hosted project.

import { captureAccessLog } from "../http.ts";
import { type Harness, loadHarness, SUPABASE_URL } from "./routesHarness.ts";
import { Prng } from "./xc_concurrency_harness.ts";

export const ROUTE_PATH = "/v1/me/delete-request";
export const ROUTE_LIMIT = 3; // ROUTE_LIMITS delete_request: 3 / 3600s
export const MAX_JSON_BODY_BYTES = 5_000_000;
export const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
export const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The only statuses a rejected request may carry (task lens). */
export const ALLOWED_REJECTION_STATUSES = new Set([
  400,
  401,
  403,
  404,
  405,
  413,
  415,
  429,
]);
export const GENERIC_503_DELETION =
  "Account deletion is temporarily unavailable. Please try again.";
export const GENERIC_503_SESSION =
  "Session verification is temporarily unavailable. Please try again.";
export const GENERIC_500 = "Something went wrong. Please try again.";

const SURVEY_REASONS = [
  "not_using",
  "not_helpful",
  "scores_inaccurate",
  "technical_issues",
  "too_expensive",
  "privacy",
  "other",
];
const SURVEY_WANTED = [
  "accuracy",
  "price",
  "content",
  "stability",
  "switched",
  "nothing",
];
const SURVEY_PLATFORMS = ["ios", "android"];

const encoder = new TextEncoder();

export function b64urlUtf8(value: string): string {
  const bytes = encoder.encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
/** Per-iteration seed: a pure function of (campaign seed, index). */
export function iterationSeed(base: number, index: number): number {
  let x = (base ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** Results directory. A replay run writes under `replay/` so it never
 * overwrites the campaign table it is investigating. */
export function outDir(sub: "latest" | "replay" | "pg" = "latest"): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    `../../../../artifacts/stress-delete-request/${sub}/`,
    import.meta.url,
  ).pathname;
}

export async function writeJson(
  name: string,
  value: unknown,
  sub: "latest" | "replay" | "pg" = "latest",
): Promise<string> {
  const dir = outDir(sub);
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

export function histogram(
  values: Array<string | number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

// ── Tokens ──────────────────────────────────────────────────────────────────

export type AuthKind =
  | "google"
  | "apple"
  | "session"
  | "missing"
  | "empty_bearer"
  | "scheme_basic"
  | "lowercase_bearer"
  | "two_segments"
  | "four_segments"
  | "bad_b64"
  | "payload_not_json"
  | "payload_array"
  | "unknown_iss"
  | "iss_not_string"
  | "expired_google"
  | "expired_session"
  | "session_no_provider"
  | "session_refused"
  | "idtoken_refused"
  | "garbage_bytes"
  | "huge_bearer";

const VALID_AUTH: AuthKind[] = ["google", "apple", "session"];
const INVALID_AUTH: AuthKind[] = [
  "missing",
  "empty_bearer",
  "scheme_basic",
  "lowercase_bearer",
  "two_segments",
  "four_segments",
  "bad_b64",
  "payload_not_json",
  "payload_array",
  "unknown_iss",
  "iss_not_string",
  "expired_google",
  "expired_session",
  "session_no_provider",
  "session_refused",
  "idtoken_refused",
  "garbage_bytes",
  "huge_bearer",
];

function jwt(
  payload: unknown,
  header: unknown = { alg: "RS256", typ: "JWT" },
): string {
  return `${b64urlUtf8(JSON.stringify(header))}.${
    b64urlUtf8(JSON.stringify(payload))
  }.sig`;
}

const SESSION_PREFIX = "stress-session:";

/** Session tokens the fake GoTrue recognises: sub + an opaque marker so the
 * stub can answer GET /auth/v1/user without any shared state. */
function sessionToken(
  sub: string,
  prng: Prng,
  opts: { expired?: boolean; marker?: string } = {},
) {
  return jwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub,
    aud: "authenticated",
    role: "authenticated",
    session_id: prng.uuid(),
    exp: Math.floor(Date.now() / 1000) + (opts.expired ? -60 : 3600),
    jti: prng.uuid(),
    marker: `${SESSION_PREFIX}${opts.marker ?? "ok"}`,
  });
}

function latin1Garbage(prng: Prng, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    // printable Latin-1 minus DEL; header values must be ByteStrings without
    // CR/LF/NUL, which the Request constructor rejects.
    const code = prng.int(0x21, 0xff);
    out += code === 0x7f ? "!" : String.fromCharCode(code);
  }
  return out;
}

/** Authorization header value (or null for none) for an auth kind. */
export function authorizationFor(
  kind: AuthKind,
  sub: string,
  prng: Prng,
): string | null {
  switch (kind) {
    case "google":
      return `Bearer ${
        jwt({ iss: "https://accounts.google.com", sub, exp: nowSec() + 3600 })
      }`;
    case "apple":
      return `Bearer ${
        jwt({ iss: "https://appleid.apple.com", sub, exp: nowSec() + 3600 })
      }`;
    case "session":
      return `Bearer ${sessionToken(sub, prng)}`;
    case "missing":
      return null;
    case "empty_bearer":
      return "Bearer ";
    case "scheme_basic":
      return `Basic ${b64urlUtf8(`${sub}:pw`)}`;
    case "lowercase_bearer":
      return `bearer ${
        jwt({ iss: "https://accounts.google.com", sub, exp: nowSec() + 3600 })
      }`;
    case "two_segments":
      return `Bearer ${b64urlUtf8("{}")}.${
        b64urlUtf8(JSON.stringify({ iss: "https://accounts.google.com", sub }))
      }`;
    case "four_segments":
      return `Bearer ${
        jwt({ iss: "https://accounts.google.com", sub, exp: nowSec() + 3600 })
      }.extra`;
    case "bad_b64":
      return `Bearer ${b64urlUtf8("{}")}.!!!not-base64!!!.sig`;
    case "payload_not_json":
      return `Bearer ${b64urlUtf8("{}")}.${b64urlUtf8("this is not json")}.sig`;
    case "payload_array":
      return `Bearer ${b64urlUtf8("{}")}.${
        b64urlUtf8(JSON.stringify(["https://accounts.google.com", sub]))
      }.sig`;
    case "unknown_iss":
      return `Bearer ${
        jwt({ iss: "https://login.example.com", sub, exp: nowSec() + 3600 })
      }`;
    case "iss_not_string":
      return `Bearer ${jwt({ iss: 42, sub, exp: nowSec() + 3600 })}`;
    case "expired_google":
      return `Bearer ${
        jwt({ iss: "https://accounts.google.com", sub, exp: nowSec() - 5 })
      }`;
    case "expired_session":
      return `Bearer ${sessionToken(sub, prng, { expired: true })}`;
    case "session_no_provider":
      return `Bearer ${sessionToken(sub, prng, { marker: "no-provider" })}`;
    case "session_refused":
      return `Bearer ${sessionToken(sub, prng, { marker: "refused" })}`;
    case "idtoken_refused":
      return `Bearer ${
        jwt({
          iss: "https://accounts.google.com",
          sub,
          exp: nowSec() + 3600,
          stress_refuse: true,
        })
      }`;
    case "garbage_bytes":
      return `Bearer ${latin1Garbage(prng, prng.int(1, 200))}`;
    case "huge_bearer":
      return `Bearer ${"A".repeat(prng.int(8_000, 16_000))}`;
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ── Bodies ──────────────────────────────────────────────────────────────────

export type BodyKind =
  | "absent"
  | "empty_string"
  | "empty_object"
  | "valid_survey"
  | "valid_survey_minimal"
  | "survey_unknown_reason"
  | "survey_reason_wrong_type"
  | "survey_not_object"
  | "survey_wanted_invalid"
  | "survey_details_wrong_type"
  | "survey_details_huge"
  | "survey_platform_invalid"
  | "survey_app_version_huge"
  | "survey_extra_keys"
  | "json_non_object"
  | "malformed_json"
  | "bom_prefixed_json"
  | "deep_nesting"
  | "proto_pollution"
  | "big_valid"
  | "binary_garbage"
  | "form_encoded"
  | "xml"
  | "duplicate_keys"
  | "over_limit_stream";

const BODY_KINDS: BodyKind[] = [
  "absent",
  "empty_string",
  "empty_object",
  "valid_survey",
  "valid_survey",
  "valid_survey",
  "valid_survey_minimal",
  "survey_unknown_reason",
  "survey_reason_wrong_type",
  "survey_not_object",
  "survey_wanted_invalid",
  "survey_details_wrong_type",
  "survey_details_huge",
  "survey_platform_invalid",
  "survey_app_version_huge",
  "survey_extra_keys",
  "json_non_object",
  "malformed_json",
  "bom_prefixed_json",
  "deep_nesting",
  "proto_pollution",
  "big_valid",
  "binary_garbage",
  "form_encoded",
  "xml",
  "duplicate_keys",
];

/** Text the sanitizer must cope with: controls, zero-width, bidi, emoji,
 * CJK, lone surrogates, long whitespace runs, quotes and SQL-ish fragments. */
const NASTY_FRAGMENTS = [
  "\u0000",
  "\u0007",
  "\u001b[31m",
  "\u007f",
  "\u200b",
  "\u200e",
  "\u202e",
  "\u2066",
  "\ufeff",
  "\ud83d\ude00", // 😀
  "\ud83e\uddd1\u200d\ud83d\udcbb", // 🧑‍💻 (ZWJ sequence)
  "日本語のテキスト",
  "العربية",
  "'; drop table shots; --",
  '" onmouseover="alert(1)"',
  "<script>alert(1)</script>",
  "\t\t\n\n\r\n   ",
  "\\u0000",
  "${jndi:ldap://x}",
  "%00%0d%0a",
  "a".repeat(600),
];

/** encodeURIComponent that survives lone surrogates (they become U+FFFD). */
function safeEncode(value: string): string {
  return encodeURIComponent(value.replace(LONE_SURROGATES_G, "\ufffd"));
}
const LONE_SURROGATES_G =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function nastyText(prng: Prng, maxParts: number): string {
  const parts = prng.int(0, maxParts);
  let out = "";
  for (let i = 0; i < parts; i++) {
    const roll = prng.next();
    if (roll < 0.6) {
      out += NASTY_FRAGMENTS[prng.int(0, NASTY_FRAGMENTS.length - 1)];
    } else if (roll < 0.9) out += latin1Garbage(prng, prng.int(1, 12));
    else out += String.fromCharCode(prng.int(0xd800, 0xdfff)); // lone surrogate
    if (prng.next() < 0.5) out += " ";
  }
  return out;
}

export interface SurveyIntent {
  reason: string;
  wanted: unknown;
  details: unknown;
  platform: unknown;
  appVersion: unknown;
}

export interface GeneratedBody {
  kind: BodyKind;
  /** Wire text (undefined → no body). Streams are built separately. */
  text?: string;
  bytes?: Uint8Array;
  streamBytes?: number;
  /** What the handler should see after readBody(): a valid survey or none. */
  survey: SurveyIntent | null;
  /** Diagnostic description for the results table (never the raw text). */
  describe: string;
}

function validSurvey(prng: Prng, full: boolean): Record<string, unknown> {
  const survey: Record<string, unknown> = {
    reason: SURVEY_REASONS[prng.int(0, SURVEY_REASONS.length - 1)],
  };
  if (full) {
    if (prng.next() < 0.8) {
      survey.wanted = SURVEY_WANTED[prng.int(0, SURVEY_WANTED.length - 1)];
    }
    if (prng.next() < 0.8) survey.details = nastyText(prng, 8);
    if (prng.next() < 0.7) survey.platform = SURVEY_PLATFORMS[prng.int(0, 1)];
    if (prng.next() < 0.7) {
      survey.appVersion = `1.${prng.int(0, 99)}.${prng.int(0, 999)}`;
    }
  }
  return survey;
}

function intentOf(survey: Record<string, unknown>): SurveyIntent {
  return {
    reason: String(survey.reason),
    wanted: survey.wanted,
    details: survey.details,
    platform: survey.platform,
    appVersion: survey.appVersion,
  };
}

export function generateBody(kind: BodyKind, prng: Prng): GeneratedBody {
  const wrap = (survey: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ ...extra, survey });
  switch (kind) {
    case "absent":
      return { kind, survey: null, describe: "no body" };
    case "empty_string":
      return { kind, text: "", survey: null, describe: '""' };
    case "empty_object":
      return { kind, text: "{}", survey: null, describe: "{}" };
    case "valid_survey": {
      const s = validSurvey(prng, true);
      return {
        kind,
        text: wrap(s),
        survey: intentOf(s),
        describe: "valid survey (full)",
      };
    }
    case "valid_survey_minimal": {
      const s = validSurvey(prng, false);
      return {
        kind,
        text: wrap(s),
        survey: intentOf(s),
        describe: "valid survey (reason only)",
      };
    }
    case "survey_unknown_reason": {
      const s = validSurvey(prng, true);
      const bad = [
        "Other",
        "OTHER",
        "other ",
        "",
        "not_using\u0000",
        nastyText(prng, 3),
        "privacy2",
      ];
      s.reason = bad[prng.int(0, bad.length - 1)];
      return {
        kind,
        text: wrap(s),
        survey: null,
        describe: "survey.reason outside vocabulary",
      };
    }
    case "survey_reason_wrong_type": {
      const s = validSurvey(prng, true);
      const bad: unknown[] = [null, 1, true, ["other"], { reason: "other" }];
      s.reason = bad[prng.int(0, bad.length - 1)];
      return {
        kind,
        text: wrap(s),
        survey: null,
        describe: "survey.reason non-string",
      };
    }
    case "survey_not_object": {
      const bad: unknown[] = ["other", 7, null, true, ["other"], [{
        reason: "other",
      }]];
      return {
        kind,
        text: wrap(bad[prng.int(0, bad.length - 1)]),
        survey: null,
        describe: "survey non-object",
      };
    }
    case "survey_wanted_invalid": {
      const s = validSurvey(prng, true);
      const bad: unknown[] = [
        "Price",
        "",
        3,
        null,
        ["price"],
        nastyText(prng, 2),
      ];
      s.wanted = bad[prng.int(0, bad.length - 1)];
      return {
        kind,
        text: wrap(s),
        survey: intentOf(s),
        describe: "survey.wanted invalid",
      };
    }
    case "survey_details_wrong_type": {
      const s = validSurvey(prng, true);
      const bad: unknown[] = [7, null, true, ["x"], { text: "x" }];
      s.details = bad[prng.int(0, bad.length - 1)];
      return {
        kind,
        text: wrap(s),
        survey: intentOf(s),
        describe: "survey.details non-string",
      };
    }
    case "survey_details_huge": {
      const s = validSurvey(prng, true);
      s.details = nastyText(prng, 40) + "x".repeat(prng.int(500, 20_000)) +
        nastyText(prng, 40);
      return {
        kind,
        text: wrap(s),
        survey: intentOf(s),
        describe: "survey.details 500..20k chars",
      };
    }
    case "survey_platform_invalid": {
      const s = validSurvey(prng, true);
      const bad: unknown[] = ["iOS", "web", "", 1, null, ["ios"]];
      s.platform = bad[prng.int(0, bad.length - 1)];
      return {
        kind,
        text: wrap(s),
        survey: intentOf(s),
        describe: "survey.platform invalid",
      };
    }
    case "survey_app_version_huge": {
      const s = validSurvey(prng, true);
      s.appVersion = nastyText(prng, 5) + "9".repeat(prng.int(64, 3_000));
      return {
        kind,
        text: wrap(s),
        survey: intentOf(s),
        describe: "survey.appVersion 64..3k chars",
      };
    }
    case "survey_extra_keys": {
      const s = validSurvey(prng, true);
      const extra: Record<string, unknown> = {
        user_id: prng.uuid(),
        challenge: prng.uuid(),
        expiresAt: "2099-01-01T00:00:00.000Z",
        userId: prng.uuid(),
        role: "service_role",
      };
      s.user_id = prng.uuid();
      s.was_premium = true;
      s.scored_count = -5;
      s.account_age_days = 99_999;
      return {
        kind,
        text: wrap(s, extra),
        survey: intentOf(s),
        describe: "survey + smuggled server-stamped keys",
      };
    }
    case "json_non_object": {
      const bad = [
        "[]",
        '["survey"]',
        '"survey"',
        "42",
        "null",
        "true",
        "-0",
        "1e400",
      ];
      return {
        kind,
        text: bad[prng.int(0, bad.length - 1)],
        survey: null,
        describe: "JSON non-object",
      };
    }
    case "malformed_json": {
      const bad = [
        "{not json",
        '{"survey":{"reason":"other"}',
        '{"survey":{"reason":"other"},}',
        "{'survey':{'reason':'other'}}",
        '{"survey":NaN}',
        "\u0000",
        "{",
        "}",
        '{"survey":{"reason":"other"}}garbage',
        latin1Garbage(prng, prng.int(1, 64)),
      ];
      return {
        kind,
        text: bad[prng.int(0, bad.length - 1)],
        survey: null,
        describe: "malformed JSON",
      };
    }
    case "bom_prefixed_json": {
      // TextDecoder strips a leading UTF-8 BOM, so this is a VALID survey on
      // the wire even though JSON.parse would reject the raw text.
      const s = validSurvey(prng, false);
      return {
        kind,
        text: `\ufeff${wrap(s)}`,
        survey: intentOf(s),
        describe: "BOM + valid survey",
      };
    }
    case "deep_nesting": {
      const depth = prng.int(1_000, 20_000);
      const open = prng.next() < 0.5 ? "[" : '{"a":';
      const close = open === "[" ? "]" : "}";
      return {
        kind,
        text: `{"survey":${open.repeat(depth)}${close.repeat(depth)}}`,
        survey: null,
        describe: `JSON nested ${depth} deep`,
      };
    }
    case "proto_pollution": {
      const s = validSurvey(prng, true);
      const text =
        `{"__proto__":{"reason":"other","polluted":true},"constructor":{"prototype":{"x":1}},` +
        `"survey":{"__proto__":{"reason":"other"},"constructor":"x",${
          JSON.stringify(s).slice(1)
        }}`;
      return {
        kind,
        text,
        survey: intentOf(s),
        describe: "__proto__/constructor keys",
      };
    }
    case "big_valid": {
      const s = validSurvey(prng, true);
      const pad = "p".repeat(prng.int(200_000, 2_000_000));
      return {
        kind,
        text: JSON.stringify({ pad, survey: s }),
        survey: intentOf(s),
        describe: `valid survey + ${pad.length}B padding (< limit)`,
      };
    }
    case "binary_garbage": {
      const n = prng.int(1, 4_096);
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = prng.int(0, 255);
      return { kind, bytes, survey: null, describe: `${n} random bytes` };
    }
    case "form_encoded":
      return {
        kind,
        text: "survey%5Breason%5D=other&survey%5Bdetails%5D=hi",
        survey: null,
        describe: "x-www-form-urlencoded",
      };
    case "xml":
      return {
        kind,
        text: '<?xml version="1.0"?><survey><reason>other</reason></survey>',
        survey: null,
        describe: "XML",
      };
    case "duplicate_keys": {
      // JSON.parse keeps the LAST duplicate: the bogus survey wins → dropped.
      const s = validSurvey(prng, true);
      const text = `{"survey":${
        JSON.stringify(s)
      },"survey":{"reason":"bogus"}}`;
      return {
        kind,
        text,
        survey: null,
        describe: "duplicate survey key (last = invalid)",
      };
    }
    case "over_limit_stream": {
      const streamBytes = MAX_JSON_BODY_BYTES + prng.int(1, 100_000);
      return {
        kind,
        streamBytes,
        survey: null,
        describe: `${streamBytes}B streamed (> limit)`,
      };
    }
  }
}

// ── Paths / methods / headers ───────────────────────────────────────────────

const PREFIXES = [
  "/functions/v1/api",
  "/api",
  "",
  "/functions/v1/api",
  "/functions/v1/api",
];

export type PathKind =
  | "exact"
  | "query"
  | "fragment"
  | "trailing_slash"
  | "case"
  | "double_slash"
  | "encoded_dash"
  | "encoded_space"
  | "dot_segments"
  | "double_v1"
  | "suffix_v1"
  | "unicode_suffix"
  | "typo"
  | "matrix_params";

const PATH_KINDS: PathKind[] = [
  ...Array.from({ length: 30 }, (): PathKind => "exact"),
  ...Array.from({ length: 5 }, (): PathKind => "query"),
  "fragment",
  "trailing_slash",
  "case",
  "double_slash",
  "encoded_dash",
  "encoded_space",
  "dot_segments",
  "double_v1",
  "suffix_v1",
  "unicode_suffix",
  "typo",
  "matrix_params",
];

function queryString(prng: Prng): string {
  const parts: string[] = [];
  const n = prng.int(1, 6);
  for (let i = 0; i < n; i++) {
    const keys = [
      "survey",
      "reason",
      "user_id",
      "userId",
      "challenge",
      "select",
      "on_conflict",
      "apikey",
      "x",
      "__proto__",
    ];
    const key = keys[prng.int(0, keys.length - 1)];
    const val = safeEncode(
      prng.next() < 0.5 ? nastyText(prng, 2) : prng.uuid(),
    );
    parts.push(`${key}=${val}`);
  }
  return `?${parts.join("&")}`;
}

export function generatePath(kind: PathKind, prng: Prng): string {
  const prefix = PREFIXES[prng.int(0, PREFIXES.length - 1)];
  switch (kind) {
    case "exact":
      return `${prefix}${ROUTE_PATH}`;
    case "query":
      return `${prefix}${ROUTE_PATH}${queryString(prng)}`;
    case "fragment":
      return `${prefix}${ROUTE_PATH}#${safeEncode(nastyText(prng, 2))}`;
    case "trailing_slash":
      return `${prefix}${ROUTE_PATH}/`;
    case "case":
      return `${prefix}/v1/me/Delete-Request`;
    case "double_slash":
      return `${prefix}/v1/me//delete-request`;
    case "encoded_dash":
      return `${prefix}/v1/me/delete%2Drequest`;
    case "encoded_space":
      return `${prefix}/v1/me/delete-request%20`;
    case "dot_segments":
      return `${prefix}/v1/me/../me/./delete-request`;
    case "double_v1":
      return `${prefix}/v1/v1/me/delete-request`;
    case "suffix_v1":
      return `${prefix}${ROUTE_PATH}/v1/`;
    case "unicode_suffix":
      return `${prefix}${ROUTE_PATH}/${encodeURIComponent("ü")}`;
    case "typo":
      return `${prefix}/v1/me/delete-requests`;
    case "matrix_params":
      return `${prefix}/v1/me/delete-request;v=1`;
  }
}

const METHODS = [
  ...Array.from({ length: 40 }, () => "POST"),
  "GET",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "post",
  "PROPFIND",
];

export type RequestIdKind =
  | "absent"
  | "valid"
  | "too_short"
  | "too_long"
  | "bad_chars"
  | "padded";
const REQUEST_ID_KINDS: RequestIdKind[] = [
  "absent",
  "absent",
  "valid",
  "valid",
  "too_short",
  "too_long",
  "bad_chars",
  "padded",
];

const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-";
function idChars(prng: Prng, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += ID_ALPHABET[prng.int(0, ID_ALPHABET.length - 1)];
  }
  return out;
}

export function generateRequestId(
  kind: RequestIdKind,
  prng: Prng,
): string | null {
  switch (kind) {
    case "absent":
      return null;
    case "valid":
      return idChars(prng, prng.int(8, 64));
    case "too_short":
      return idChars(prng, prng.int(1, 7));
    case "too_long":
      return idChars(prng, prng.int(65, 400));
    case "bad_chars": {
      const bad = [" ", "\t", ":", "/", "\u00e9", "<", "%", "\\", '"'];
      const base = idChars(prng, 12);
      const at = prng.int(0, base.length - 1);
      return base.slice(0, at) + bad[prng.int(0, bad.length - 1)] +
        base.slice(at);
    }
    case "padded":
      return `${" ".repeat(prng.int(1, 3))}${idChars(prng, prng.int(8, 64))}${
        "\t".repeat(prng.int(0, 2))
      }`;
  }
}

/** Mirror of http.ts resolveRequestId for the oracle. */
export function expectedRequestIdEcho(sent: string | null): string | null {
  const incoming = sent?.trim() ?? "";
  return REQUEST_ID_RE.test(incoming) ? incoming : null;
}

export type ContentLengthKind =
  | "absent"
  | "exact"
  | "over_limit"
  | "over_limit_exp"
  | "over_limit_huge"
  | "at_limit"
  | "non_numeric"
  | "infinity"
  | "negative"
  | "small_mismatch"
  | "hex"
  | "fractional_over";
const CL_KINDS: ContentLengthKind[] = [
  ...Array.from({ length: 50 }, (): ContentLengthKind => "absent"),
  ...Array.from({ length: 8 }, (): ContentLengthKind => "exact"),
  "over_limit",
  "over_limit_exp",
  "over_limit_huge",
  "at_limit",
  "non_numeric",
  "infinity",
  "negative",
  "small_mismatch",
  "hex",
  "fractional_over",
];

export function generateContentLength(
  kind: ContentLengthKind,
  actual: number,
  prng: Prng,
): string | null {
  switch (kind) {
    case "absent":
      return null;
    case "exact":
      return String(actual);
    case "over_limit":
      return String(MAX_JSON_BODY_BYTES + prng.int(1, 1_000_000));
    case "over_limit_exp":
      return prng.next() < 0.5 ? "1e9" : "6E6";
    case "over_limit_huge":
      return "9".repeat(prng.int(20, 400));
    case "at_limit":
      return String(MAX_JSON_BODY_BYTES);
    case "non_numeric":
      return [
        "abc",
        "12abc",
        "NaN",
        "0x",
        "1,000",
        "--1",
        " ",
        "1 2",
      ][prng.int(0, 7)];
    case "infinity":
      return prng.next() < 0.5 ? "Infinity" : "-Infinity";
    case "negative":
      return `-${prng.int(1, 10_000_000)}`;
    case "small_mismatch":
      return String(prng.int(0, 10));
    case "hex":
      return `0x${prng.int(1, 0xffffff).toString(16)}`;
    case "fractional_over":
      return `${MAX_JSON_BODY_BYTES}.5`;
  }
}

/** Mirror of the handler's declared-length pre-check. */
export function declaredLengthRejects(value: string | null): boolean {
  const n = Number(value ?? "0");
  return Number.isFinite(n) && n > MAX_JSON_BODY_BYTES;
}

const CONTENT_TYPES = [
  "application/json",
  "application/json",
  "application/json",
  "application/json; charset=utf-8",
  "text/plain",
  "application/x-www-form-urlencoded",
  "multipart/form-data; boundary=----stress",
  "application/xml",
  "application/octet-stream",
  "image/png",
  "application/json; charset=utf-16",
  "APPLICATION/JSON",
  "",
];

// ── Faults ──────────────────────────────────────────────────────────────────

export type Fault =
  | "none"
  | "upsert_500"
  | "upsert_42501"
  | "upsert_throw"
  | "upsert_nonjson"
  | "upsert_timeout_html"
  | "feedback_500"
  | "feedback_throw"
  | "access_state_500"
  | "profiles_throw"
  | "auth_user_503"
  | "auth_user_nonjson"
  | "auth_token_503";

const FAULTS: Fault[] = [
  "upsert_500",
  "upsert_42501",
  "upsert_throw",
  "upsert_nonjson",
  "upsert_timeout_html",
  "feedback_500",
  "feedback_throw",
  "access_state_500",
  "profiles_throw",
  "auth_user_503",
  "auth_user_nonjson",
  "auth_token_503",
];

const UPSERT_FAULTS = new Set<Fault>([
  "upsert_500",
  "upsert_42501",
  "upsert_throw",
  "upsert_nonjson",
  "upsert_timeout_html",
]);

/** Secret-looking markers that must never leak into a response body. */
export const LEAK_MARKERS = [
  "STRESS_INTERNAL_DETAIL",
  "42501",
  "PGRST",
  "row-level security",
  "account_deletion_requests",
  "account_deletion_feedback",
  "at handleRequest",
  "index.ts:",
  "TypeError",
  "<html>",
];

// ── Case ────────────────────────────────────────────────────────────────────

export type CaseKind = "single" | "burst";

export interface FuzzCase {
  seed: number;
  kind: CaseKind;
  method: string;
  path: string;
  pathKind: PathKind;
  auth: AuthKind;
  sub: string;
  ip: string;
  /** cf-connecting-ip (edge) vs. last x-forwarded-for hop (gateway). */
  ipHeader: "cf-connecting-ip" | "x-forwarded-for";
  requestIdKind: RequestIdKind;
  requestId: string | null;
  contentType: string | null;
  contentLengthKind: ContentLengthKind;
  contentLength: string | null;
  body: GeneratedBody;
  extraHeaders: Record<string, string>;
  fault: Fault;
  /** Requests in this case (burst: same user, same token). */
  repeat: number;
}

export function generateCase(
  seed: number,
  options: { allowOverLimitStream: boolean },
): FuzzCase {
  const prng = new Prng(seed);
  const kind: CaseKind = prng.next() < 0.06 ? "burst" : "single";
  const sub = prng.uuid();
  const ip = `198.51.${prng.int(0, 255)}.${prng.int(1, 254)}`;

  // Bursts and fault cases only make sense on the real route with valid auth.
  const authRoll = prng.next();
  let auth: AuthKind;
  if (kind === "burst" || authRoll < 0.7) {
    auth = VALID_AUTH[prng.int(0, VALID_AUTH.length - 1)];
  } else auth = INVALID_AUTH[prng.int(0, INVALID_AUTH.length - 1)];

  const method = kind === "burst"
    ? "POST"
    : METHODS[prng.int(0, METHODS.length - 1)];
  const pathKind = kind === "burst"
    ? "exact"
    : PATH_KINDS[prng.int(0, PATH_KINDS.length - 1)];
  const path = generatePath(pathKind, prng);

  const hasBodyMethod = method.toUpperCase() !== "GET" &&
    method.toUpperCase() !== "HEAD";
  let bodyKind: BodyKind = hasBodyMethod
    ? BODY_KINDS[prng.int(0, BODY_KINDS.length - 1)]
    : "absent";
  if (hasBodyMethod && options.allowOverLimitStream && prng.next() < 0.01) {
    bodyKind = "over_limit_stream";
  }
  const body = generateBody(bodyKind, prng);

  const requestIdKind =
    REQUEST_ID_KINDS[prng.int(0, REQUEST_ID_KINDS.length - 1)];
  const requestId = generateRequestId(requestIdKind, prng);

  const ctRoll = CONTENT_TYPES[prng.int(0, CONTENT_TYPES.length - 1)];
  const contentType =
    body.text === undefined && !body.bytes && !body.streamBytes &&
      prng.next() < 0.5
      ? null
      : ctRoll || null;

  const actualBytes = body.bytes?.byteLength ??
    (body.text !== undefined ? encoder.encode(body.text).byteLength : 0);
  const contentLengthKind = body.streamBytes
    ? "absent"
    : CL_KINDS[prng.int(0, CL_KINDS.length - 1)];
  const contentLength = generateContentLength(
    contentLengthKind,
    actualBytes,
    prng,
  );

  const ipHeader = prng.next() < 0.7 ? "cf-connecting-ip" : "x-forwarded-for";
  const extraHeaders: Record<string, string> = {};
  if (prng.next() < 0.3) {
    extraHeaders["x-http-method-override"] =
      ["DELETE", "GET", "PUT"][prng.int(0, 2)];
  }
  if (ipHeader === "x-forwarded-for" || prng.next() < 0.3) {
    extraHeaders["x-forwarded-for"] = `${
      latin1Garbage(prng, prng.int(1, 30)).replace(/,/g, ";")
    }, 10.0.0.${prng.int(1, 254)}, ${ip}`;
  }
  if (prng.next() < 0.2) {
    extraHeaders["accept"] = [
      "application/xml",
      "text/html",
      "*/*",
      "application/vnd.pgrst.object+json",
    ][prng.int(0, 3)];
  }
  if (prng.next() < 0.2) {
    extraHeaders["origin"] = `https://${
      latin1Garbage(prng, 8).replace(/[^A-Za-z]/g, "x")
    }.example`;
  }
  if (prng.next() < 0.2) extraHeaders["prefer"] = "return=representation";
  if (prng.next() < 0.2) extraHeaders["apikey"] = latin1Garbage(prng, 24);
  if (prng.next() < 0.2) {
    extraHeaders["cookie"] = `sb-access-token=${latin1Garbage(prng, 20)}`;
  }
  if (prng.next() < 0.15) extraHeaders["x-supabase-user-id"] = prng.uuid();
  if (prng.next() < 0.1) extraHeaders["transfer-encoding"] = "chunked";

  const fault: Fault = VALID_AUTH.includes(auth) && prng.next() < 0.15
    ? FAULTS[prng.int(0, FAULTS.length - 1)]
    : "none";
  const repeat = kind === "burst"
    ? prng.int(ROUTE_LIMIT + 1, ROUTE_LIMIT + 3)
    : 1;

  return {
    seed,
    kind,
    method,
    path,
    pathKind,
    auth,
    sub,
    ip,
    ipHeader,
    requestIdKind,
    requestId,
    contentType,
    contentLengthKind,
    contentLength,
    body,
    extraHeaders,
    fault,
    repeat,
  };
}

export function buildRequest(
  c: FuzzCase,
  authorization: string | null,
): Request {
  const headers = new Headers();
  if (authorization !== null) headers.set("Authorization", authorization);
  if (c.ipHeader === "cf-connecting-ip") headers.set("cf-connecting-ip", c.ip);
  if (c.requestId !== null) headers.set("x-request-id", c.requestId);
  if (c.contentType !== null) headers.set("Content-Type", c.contentType);
  if (c.contentLength !== null) headers.set("Content-Length", c.contentLength);
  for (const [k, v] of Object.entries(c.extraHeaders)) headers.set(k, v);

  let body: BodyInit | undefined;
  if (c.body.streamBytes) {
    const total = c.body.streamBytes;
    const chunk = new Uint8Array(65_536).fill(0x20);
    let sent = 0;
    body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        const n = Math.min(chunk.byteLength, total - sent);
        controller.enqueue(
          n === chunk.byteLength ? chunk : chunk.subarray(0, n),
        );
        sent += n;
      },
    });
  } else if (c.body.bytes) body = c.body.bytes;
  else if (c.body.text !== undefined) body = c.body.text;

  return new Request(`http://edge.test${c.path}`, {
    method: c.method,
    headers,
    body,
  });
}

// ── Oracle ──────────────────────────────────────────────────────────────────

export interface Expectation {
  /** Status the handler's contract dictates for request #n of the case. */
  status: number;
  /** REST writes (POST/PATCH/DELETE on /rest/v1/<table>) the contract allows. */
  restWrites: number;
  /** Whether the survey insert is expected. */
  surveyInsert: boolean;
  /** Whether the request must produce ZERO upstream calls at all. */
  noUpstream: boolean;
  /** Human-readable reason. */
  why: string;
}

export function routeReached(c: FuzzCase): boolean {
  const url = new URL(`http://edge.test${c.path}`);
  const v1 = url.pathname.lastIndexOf("/v1/");
  const path = v1 >= 0 ? url.pathname.slice(v1) : url.pathname;
  return c.method.toUpperCase() === "POST" && path === ROUTE_PATH;
}

export function expectFor(c: FuzzCase, n: number): Expectation {
  if (declaredLengthRejects(c.contentLength)) {
    return {
      status: 413,
      restWrites: 0,
      surveyInsert: false,
      noUpstream: true,
      why: "declared Content-Length > 5MB → 413 before auth",
    };
  }
  if (!VALID_AUTH.includes(c.auth)) {
    return {
      status: 401,
      restWrites: 0,
      surveyInsert: false,
      noUpstream: false,
      why: `bearer ${c.auth} → 401`,
    };
  }
  if (c.fault === "auth_user_503" || c.fault === "auth_user_nonjson") {
    if (c.auth === "session") {
      return {
        status: 503,
        restWrites: 0,
        surveyInsert: false,
        noUpstream: false,
        why: "Supabase Auth outage on session bearer → 503 generic",
      };
    }
  }
  if (c.fault === "auth_token_503" && c.auth !== "session") {
    // Transitional provider-token branch: signInWithIdToken failure of ANY
    // kind is reported as 401 (index.ts authenticate()).
    return {
      status: 401,
      restWrites: 0,
      surveyInsert: false,
      noUpstream: false,
      why: "Auth outage on provider ID token → 401 (transitional branch)",
    };
  }
  if (!routeReached(c)) {
    return {
      status: 404,
      restWrites: 0,
      surveyInsert: false,
      noUpstream: false,
      why: "method/path does not normalize to POST /v1/me/delete-request → 404",
    };
  }
  if (n > ROUTE_LIMIT) {
    return {
      status: 429,
      restWrites: 0,
      surveyInsert: false,
      noUpstream: false,
      why: `request #${n} > delete_request budget ${ROUTE_LIMIT}/h → 429`,
    };
  }
  if (c.body.streamBytes) {
    return {
      status: 413,
      restWrites: 0,
      surveyInsert: false,
      noUpstream: false,
      why: "streamed body > 5MB → 413 from readBody, before the upsert",
    };
  }
  if (UPSERT_FAULTS.has(c.fault)) {
    return {
      status: 503,
      restWrites: 1,
      surveyInsert: false,
      noUpstream: false,
      why: `upsert fault ${c.fault} → 503 generic, survey NOT recorded`,
    };
  }
  const survey = c.body.survey !== null;
  return {
    status: 200,
    restWrites: survey ? 2 : 1,
    surveyInsert: survey,
    noUpstream: false,
    why: survey
      ? "valid survey → upsert + feedback insert"
      : "no usable survey → upsert only",
  };
}

// ── Sanitizer mirror (http.ts sanitizeUserText) for payload assertions ─────

// deno-lint-ignore no-control-regex
const CONTROL_AND_SPOOFING =
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const LONE_SURROGATES =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
export function sanitizeMirror(value: string, maxLength: number): string {
  const cleaned = value.replace(CONTROL_AND_SPOOFING, "").replace(
    LONE_SURROGATES,
    "",
  ).replace(/\s+/g, " ").trim();
  return Array.from(cleaned).slice(0, maxLength).join("").trimEnd();
}

export function expectedFeedbackRow(
  c: FuzzCase,
  provider: string,
): Record<string, unknown> | null {
  const s = c.body.survey;
  if (!s) return null;
  const details = typeof s.details === "string"
    ? sanitizeMirror(s.details, 500)
    : "";
  const appVersion = typeof s.appVersion === "string"
    ? sanitizeMirror(s.appVersion, 64)
    : "";
  return {
    user_id: c.sub,
    reason: s.reason,
    wanted: typeof s.wanted === "string" && SURVEY_WANTED.includes(s.wanted)
      ? s.wanted
      : null,
    details: details.length > 0 ? details : null,
    provider,
    platform:
      typeof s.platform === "string" && SURVEY_PLATFORMS.includes(s.platform)
        ? s.platform
        : null,
    app_version: appVersion.length > 0 ? appVersion : null,
  };
}

// ── Runtime: fetch wrapper with fault injection + recording ────────────────

export interface Upstream {
  url: string;
  method: string;
  table: string | null;
  rpc: string | null;
  prefer: string | null;
  body: unknown;
  kind: "auth" | "rest_write" | "rest_read" | "rpc" | "other";
}

export interface StressRuntime {
  harness: Harness;
  upstream: Upstream[];
  accessLog: string[];
  consoleLines: string[];
  fault: Fault;
  /** Fault injection + GoTrue user stub apply only while a case runs, so
   * other test files sharing this isolate see the plain routesHarness stub. */
  active: boolean;
  reset(fault: Fault): void;
  /** Run the real handler with access-log and console capture scoped to it. */
  run(request: Request): Promise<Response>;
}

let runtime: StressRuntime | null = null;

function marker(token: string): string | null {
  const seg = token.split(".")[1];
  if (!seg) return null;
  try {
    const raw = seg.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(
      atob(raw + "=".repeat((4 - (raw.length % 4)) % 4)),
    );
    return typeof payload.marker === "string" ? payload.marker : null;
  } catch {
    return null;
  }
}

function subOf(token: string): string | null {
  const seg = token.split(".")[1];
  if (!seg) return null;
  try {
    const raw = seg.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(
      atob(raw + "=".repeat((4 - (raw.length % 4)) % 4)),
    );
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function loadStressRuntime(): Promise<StressRuntime> {
  const harness = await loadHarness();
  if (runtime) {
    runtime.reset("none");
    return runtime;
  }
  const stubFetch = globalThis.fetch;
  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const state: StressRuntime = {
    harness,
    upstream: [],
    accessLog: [],
    consoleLines: [],
    fault: "none",
    active: false,
    reset(fault) {
      state.upstream = [];
      state.accessLog = [];
      state.consoleLines = [];
      state.fault = fault;
      harness.calls.length = 0;
      harness.tables.profiles = [{ created_at: "2026-01-01T00:00:00.000Z" }];
      harness.rpcs.access_state = [{
        premium: false,
        scored_count: 1,
        reserved_count: 0,
      }];
    },
    async run(request) {
      const restoreLog = captureAccessLog((line) => state.accessLog.push(line));
      const realError = console.error;
      const realWarn = console.warn;
      const realLog = console.log;
      const capture = (level: string) => (...args: unknown[]) => {
        state.consoleLines.push(
          `${level} ${
            args.map((a) => (a instanceof Error
              ? `${a.name}: ${a.message}\n${a.stack ?? ""}`
              : String(a))
            ).join(" ")
          }`,
        );
      };
      console.error = capture("error");
      console.warn = capture("warn");
      console.log = capture("log");
      state.active = true;
      try {
        return await harness.handler(request);
      } finally {
        state.active = false;
        restoreLog();
        console.error = realError;
        console.warn = realWarn;
        console.log = realLog;
      }
    },
  };

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (!state.active) return stubFetch(input, init);
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = await request.clone().text().catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const rest = url.pathname.startsWith("/rest/v1/")
      ? url.pathname.slice("/rest/v1/".length)
      : null;
    const rpc = rest?.startsWith("rpc/") ? rest.slice(4) : null;
    const table = rest && !rpc ? rest : null;
    const kind: Upstream["kind"] = url.pathname.startsWith("/auth/v1/")
      ? "auth"
      : rpc
      ? "rpc"
      : table
      ? request.method === "GET" || request.method === "HEAD"
        ? "rest_read"
        : "rest_write"
      : "other";
    state.upstream.push({
      url: request.url,
      method: request.method,
      table,
      rpc,
      prefer: request.headers.get("prefer"),
      body,
      kind,
    });

    const fault = state.fault;
    const bearer = (request.headers.get("authorization") ?? "").replace(
      /^Bearer /,
      "",
    );

    // Fake GoTrue GET /auth/v1/user for stress session tokens.
    if (url.pathname === "/auth/v1/user" && request.method === "GET") {
      if (fault === "auth_user_503") {
        return jsonResponse(503, {
          message: "STRESS_INTERNAL_DETAIL upstream unavailable",
        });
      }
      if (fault === "auth_user_nonjson") {
        return new Response(
          "<html>502 Bad Gateway STRESS_INTERNAL_DETAIL</html>",
          { status: 502 },
        );
      }
      const m = marker(bearer);
      const sub = subOf(bearer);
      if (!m || !m.startsWith(SESSION_PREFIX) || !sub) {
        return jsonResponse(401, {
          code: 401,
          msg: "invalid JWT: STRESS_INTERNAL_DETAIL",
        });
      }
      const which = m.slice(SESSION_PREFIX.length);
      if (which === "refused") {
        return jsonResponse(403, {
          code: 403,
          msg: "session not found STRESS_INTERNAL_DETAIL",
        });
      }
      return jsonResponse(200, {
        id: sub,
        aud: "authenticated",
        role: "authenticated",
        email: `${sub.slice(0, 8)}@example.com`,
        app_metadata: which === "no-provider"
          ? { provider: "email", providers: ["email"] }
          : { provider: "google", providers: ["google"] },
        user_metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
      });
    }
    if (url.pathname === "/auth/v1/token") {
      if (fault === "auth_token_503") {
        return jsonResponse(503, {
          message: "STRESS_INTERNAL_DETAIL auth down",
        });
      }
      const idToken =
        typeof (body as Record<string, unknown> | null)?.id_token === "string"
          ? String((body as Record<string, unknown>).id_token)
          : "";
      const seg = idToken.split(".")[1] ?? "";
      try {
        const raw = seg.replace(/-/g, "+").replace(/_/g, "/");
        const payload = JSON.parse(
          atob(raw + "=".repeat((4 - (raw.length % 4)) % 4)),
        );
        if (payload.stress_refuse === true) {
          return jsonResponse(400, {
            error: "invalid_grant",
            error_description: "STRESS_INTERNAL_DETAIL bad id token",
          });
        }
      } catch {
        // fall through to the routesHarness stub
      }
    }
    if (table === "account_deletion_requests" && request.method === "POST") {
      if (fault === "upsert_500") {
        return jsonResponse(500, {
          code: "XX000",
          message: "STRESS_INTERNAL_DETAIL internal error",
          details: "at handleRequest (index.ts:1)",
          hint: null,
        });
      }
      if (fault === "upsert_42501") {
        return jsonResponse(401, {
          code: "42501",
          message:
            'new row violates row-level security policy for table "account_deletion_requests" STRESS_INTERNAL_DETAIL',
          details: null,
          hint: null,
        });
      }
      if (fault === "upsert_throw") {
        throw new TypeError("STRESS_INTERNAL_DETAIL error sending request");
      }
      if (fault === "upsert_nonjson") {
        return new Response("STRESS_INTERNAL_DETAIL not json", {
          status: 502,
          headers: { "Content-Type": "text/plain" },
        });
      }
      if (fault === "upsert_timeout_html") {
        return new Response(
          "<html>504 Gateway Time-out STRESS_INTERNAL_DETAIL</html>",
          { status: 504, headers: { "Content-Type": "text/html" } },
        );
      }
    }
    if (table === "account_deletion_feedback" && request.method === "POST") {
      if (fault === "feedback_500") {
        return jsonResponse(500, {
          code: "23514",
          message: "STRESS_INTERNAL_DETAIL check constraint",
          details: null,
          hint: null,
        });
      }
      if (fault === "feedback_throw") {
        throw new TypeError("STRESS_INTERNAL_DETAIL error sending request");
      }
    }
    if (rpc === "access_state" && fault === "access_state_500") {
      return jsonResponse(500, {
        code: "XX000",
        message: "STRESS_INTERNAL_DETAIL rpc failed",
      });
    }
    if (table === "profiles" && fault === "profiles_throw") {
      throw new TypeError("STRESS_INTERNAL_DETAIL error sending request");
    }

    return stubFetch(input, init);
  }) as typeof fetch;

  runtime = state;
  state.reset("none");
  return state;
}
