// stress: POST /v1/me/consent/grant — seeded request generator, behavioural
// model (oracle) and invariant checker shared by
//
//   stress_consent_grant_fuzz.test.ts      in-process handler, fetch-level stubs
//   stress_consent_grant_pg.test.ts        in-process handler, REAL Postgres
//   stress_consent_grant_findings.repro.ts failing-by-design reproductions
//
// Every iteration is a pure function of (campaign seed, iteration index):
// `iterationSeed()` feeds a Prng that draws method, path, query, headers,
// bearer, body bytes and the injected upstream fault. Replay one iteration
// with STRESS_REPLAY=<campaignSeed>:<iteration> (see the fuzz test header).
//
// The model deliberately mirrors the handler's OWN pipeline (content-length
// gate → auth → route → body validation → insert → reload) so that the
// checker can state, per request, which statuses are acceptable, whether a
// write may happen, and which columns the inserted row must carry. Rate-limit
// overlays (per-user, per-IP, auth-failure budget) are campaign-level state
// and live in `RateModel`.

import { clientIp, sanitizeUserText } from "../http.ts";
import { envInt, Prng } from "./xc_concurrency_harness.ts";
import { SUPABASE_URL, TEST_USER_ID } from "./routesHarness.ts";

// ── Constants mirrored from index.ts (the contract under test) ───────────────

export const CONSENT_SCOPES = ["video_analysis", "model_training", "evaluation_telemetry"] as const;
export const MAX_JSON_BODY_BYTES = 5_000_000;
export const CONSENT_LIMIT = { limit: 30, windowSeconds: 60 };
export const GENERAL_USER_LIMIT = { limit: 240, windowSeconds: 60 };
export const IP_LIMIT = { limit: 1_200, windowSeconds: 60 };
export const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
/** DB CHECK `consent_records_bounds` (20260831160000_defense_in_depth.sql). */
export const DB_CAPS = { consent_version: 50, source: 100, capture_mode: 50, device_bytes: 4096 };
/** Edge sanitizer caps (index.ts grantConsent). */
export const EDGE_CAPS = { consent_version: 64, source: 64, device: 512, capture_mode: 64 };

export const ALLOWED_REJECTION_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 429]);
export const GENERIC_5XX_MESSAGES = new Set([
  "Consent update is temporarily unavailable. Please try again.",
  "Consent status is temporarily unavailable. Please try again.",
  "Session verification is temporarily unavailable. Please try again.",
  "Something went wrong. Please try again.",
]);
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
export const STRESS_ITER = envInt("STRESS_ITER", 300);

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function iterationSeed(campaignSeed: number, iteration: number): number {
  return fnv1a(`${campaignSeed}:${iteration}`);
}

export function replayKey(campaignSeed: number, iteration: number): string {
  return `${campaignSeed}:${iteration}`;
}

/** STRESS_REPLAY="seed:i[,seed:j…]" → the iterations to run instead of a range. */
export function replaySelection(): Array<{ campaignSeed: number; iteration: number }> | null {
  const raw = Deno.env.get("STRESS_REPLAY")?.trim();
  if (!raw) return null;
  return raw.split(",").map((entry) => {
    const [seed, iteration] = entry.split(":").map((n) => Number(n.trim()));
    if (!Number.isInteger(seed) || !Number.isInteger(iteration)) {
      throw new Error(`STRESS_REPLAY entry "${entry}" is not <campaignSeed>:<iteration>`);
    }
    return { campaignSeed: seed, iteration };
  });
}

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ── Scenario shape ───────────────────────────────────────────────────────────

export type AuthSpec =
  | { kind: "google" | "apple"; sub: string | number | null; userId: string; token: string }
  | {
      kind: "session";
      sub: string;
      verdict: "live" | "refused" | "no-provider" | "outage";
      token: string;
    }
  | { kind: "none" }
  | { kind: "scheme"; header: string }
  | { kind: "malformed"; token: string }
  | { kind: "wrong-issuer"; token: string }
  | { kind: "expired"; provider: "google" | "apple" | "session"; token: string };

export type Fault =
  | { kind: "insert-4xx"; status: number; canary: string }
  | { kind: "insert-5xx-html"; canary: string }
  | { kind: "insert-throw"; canary: string }
  | { kind: "insert-401"; canary: string }
  | { kind: "select-5xx"; canary: string }
  | { kind: "select-nonarray"; canary: string };

export interface Scenario {
  campaignSeed: number;
  iteration: number;
  seed: number;
  replay: string;
  kind: string;
  tags: string[];
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  /** The body as the generator intended it (for the report; never used by the model). */
  bodyPreview: string;
  auth: AuthSpec;
  fault: Fault | null;
  /** Well-formed request id the client expects echoed, or the malformed one it sent. */
  requestId: { sent: string | null; wellFormed: boolean };
}

export interface InsertRow {
  user_id: string;
  scope: string;
  consent_version: string;
  action: "grant";
  source: string | null;
  device: string | null;
  capture_mode: string | null;
}

export interface Prediction {
  statuses: number[];
  code?: string;
  writes: number;
  insertRow: InsertRow | null;
  authFailure: boolean;
  userId: string | null;
  routeScope: "consent" | "user" | null;
  generic5xx: boolean;
  anomalies: string[];
  stage: string;
}

// ── Text generators ──────────────────────────────────────────────────────────

const ASCII = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-";
const JS_WHITESPACE = [
  " ",
  "\t",
  "\n",
  "\r",
  "\v",
  "\f",
  "\u00a0",
  "\u1680",
  "\u2003",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
];
/** Stripped by sanitizeUserText but NOT by String#trim — so a value made only of
 * these passes the "non-empty" check and is stored as "". */
const STRIPPED_NOT_TRIMMED = [
  "\u0000",
  "\u0007",
  "\u001b",
  "\u007f",
  "\u0085",
  "\u009f",
  "\u200b",
  "\u200c",
  "\u200d",
  "\u200f",
  "\u202a",
  "\u202e",
  "\u2066",
  "\u2069",
];
const UNICODE_SAMPLES = [
  "é",
  "ß",
  "ñ",
  "日本",
  "한국",
  "עברית",
  "العربية",
  "Ωμέγα",
  "🙂",
  "🏓",
  "👨‍👩‍👧",
  "🇺🇸",
  "ā",
  "ﬁ",
  "Ⅻ",
  "𝔘𝔫𝔦",
  "🅰",
];
const INJECTIONS = [
  "'; drop table consent_records; --",
  '" OR 1=1 --',
  "{{7*7}}",
  "<script>alert(1)</script>",
  "${jndi:ldap://x}",
  "%00%0d%0a",
  "../../etc/passwd",
  "\\u0000",
  "__proto__",
  "constructor",
  "null",
  "undefined",
  "NaN",
  "true",
  "0",
  "-1",
  "1e309",
];

function pick<T>(prng: Prng, items: readonly T[]): T {
  return items[prng.int(0, items.length - 1)];
}

function asciiText(prng: Prng, min: number, max: number): string {
  const n = prng.int(min, max);
  let out = "";
  for (let i = 0; i < n; i++) out += ASCII[prng.int(0, ASCII.length - 1)];
  return out;
}

function codePoints(prng: Prng, n: number, astral: boolean): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(
      astral && prng.next() < 0.3 ? pick(prng, ["🙂", "🏓", "𝔘", "😀"]) : ASCII[prng.int(0, 61)],
    );
  }
  return parts.join("");
}

export type TextProfile =
  | "ascii"
  | "spaces"
  | "unicode"
  | "control"
  | "lone-surrogate"
  | "long"
  | "boundary"
  | "only-stripped"
  | "trim-empty"
  | "injection"
  | "empty";

export const TEXT_PROFILES: readonly TextProfile[] = [
  "ascii",
  "spaces",
  "unicode",
  "control",
  "lone-surrogate",
  "long",
  "boundary",
  "only-stripped",
  "injection",
];

export function genText(prng: Prng, profile: TextProfile): string {
  switch (profile) {
    case "ascii":
      return asciiText(prng, 1, 40);
    case "spaces": {
      const core = asciiText(prng, 1, 20);
      const pad = () =>
        Array.from({ length: prng.int(0, 3) }, () => pick(prng, JS_WHITESPACE)).join("");
      return `${pad()}${core}${pad()}${asciiText(prng, 0, 8)}${pad()}`;
    }
    case "unicode":
      return Array.from({ length: prng.int(1, 12) }, () => pick(prng, UNICODE_SAMPLES)).join(
        prng.next() < 0.5 ? "" : " ",
      );
    case "control": {
      const chars: string[] = [];
      const n = prng.int(1, 30);
      for (let i = 0; i < n; i++) {
        chars.push(prng.next() < 0.35 ? pick(prng, STRIPPED_NOT_TRIMMED) : ASCII[prng.int(0, 61)]);
      }
      return chars.join("");
    }
    case "lone-surrogate":
      return `${asciiText(prng, 0, 5)}${pick(prng, ["\ud800", "\udfff", "\udbff"])}${asciiText(prng, 0, 5)}`;
    case "long":
      return codePoints(prng, prng.int(65, 400), prng.next() < 0.5);
    case "boundary":
      return codePoints(prng, pick(prng, [49, 50, 51, 63, 64, 65, 100, 101]), prng.next() < 0.5);
    case "only-stripped":
      return Array.from({ length: prng.int(1, 5) }, () => pick(prng, STRIPPED_NOT_TRIMMED)).join(
        "",
      );
    case "trim-empty":
      return Array.from({ length: prng.int(1, 6) }, () => pick(prng, JS_WHITESPACE)).join("");
    case "injection":
      return pick(prng, INJECTIONS);
    case "empty":
      return "";
  }
}

/** Non-string JSON values a client could put where a string belongs. */
function junkValue(prng: Prng): unknown {
  return pick<unknown>(prng, [
    0,
    -1,
    1.5,
    1e308,
    true,
    false,
    null,
    [],
    ["video_analysis"],
    {},
    { scope: "video_analysis" },
    { toString: "video_analysis" },
    Number.MAX_SAFE_INTEGER,
  ]);
}

// ── Users, IPs, tokens ───────────────────────────────────────────────────────

/** Deterministic user pool per campaign seed; sized so the per-user consent
 * budget (30/min) is never approached by the campaign itself. */
export function userPool(campaignSeed: number, iterations: number): string[] {
  const size = Math.max(64, Math.ceil(iterations / 8));
  const prng = new Prng(fnv1a(`${campaignSeed}:users`));
  return Array.from({ length: size }, () => prng.uuid());
}

export function ipPool(campaignSeed: number, iterations: number): string[] {
  const size = Math.max(64, Math.ceil(iterations / 6));
  const prng = new Prng(fnv1a(`${campaignSeed}:ips`));
  return Array.from({ length: size }, () => {
    if (prng.next() < 0.25) {
      return `2001:db8:${prng.int(0, 0xffff).toString(16)}:${prng.int(0, 0xffff).toString(16)}::${prng.int(1, 0xfffe).toString(16)}`;
    }
    return `198.51.${prng.int(0, 255)}.${prng.int(1, 254)}`;
  });
}

export function mintToken(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", typ: "JWT" },
): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.${b64url("sig")}`;
}

const SESSION_ISSUER = `${SUPABASE_URL}/auth/v1`;
const FUTURE_EXP = () => Math.floor(Date.now() / 1000) + 3600;

export function providerToken(
  provider: "google" | "apple",
  sub: string | number | null,
  nonce: string,
): string {
  const payload: Record<string, unknown> = {
    iss: provider === "google" ? "https://accounts.google.com" : "https://appleid.apple.com",
    aud: "com.picklesensei",
    exp: FUTURE_EXP(),
    iat: Math.floor(Date.now() / 1000),
    nonce,
  };
  if (sub !== null) payload.sub = sub;
  return mintToken(payload);
}

export function sessionToken(sub: string, nonce: string): string {
  return mintToken({
    iss: SESSION_ISSUER,
    sub,
    aud: "authenticated",
    role: "authenticated",
    session_id: `sess-${nonce}`,
    exp: FUTURE_EXP(),
  });
}

/** What the stubbed Supabase Auth resolves a provider token to (routesHarness
 * /auth/v1/token: `String(payload.sub ?? TEST_USER_ID)`). */
export function stubUserIdFor(sub: string | number | null): string {
  return String(sub ?? TEST_USER_ID);
}

function genAuth(prng: Prng, users: string[], kindRoll: number): AuthSpec {
  const nonce = prng.uuid();
  if (kindRoll < 0.62) {
    const provider: "google" | "apple" = prng.next() < 0.75 ? "google" : "apple";
    const sub = users[prng.int(0, users.length - 1)];
    return {
      kind: provider,
      sub,
      userId: stubUserIdFor(sub),
      token: providerToken(provider, sub, nonce),
    };
  }
  if (kindRoll < 0.7) {
    // provider tokens with odd subjects — the stub still resolves them
    const sub = pick<string | number | null>(prng, [
      null,
      1234567890,
      0,
      "not-a-uuid",
      "a".repeat(200),
    ]);
    return {
      kind: "google",
      sub,
      userId: stubUserIdFor(sub),
      token: providerToken("google", sub, nonce),
    };
  }
  if (kindRoll < 0.84) {
    const sub = users[prng.int(0, users.length - 1)];
    const verdict = pick<"live" | "refused" | "no-provider" | "outage">(prng, [
      "live",
      "live",
      "live",
      "live",
      "refused",
      "no-provider",
      "outage",
    ]);
    return { kind: "session", sub, verdict, token: sessionToken(sub, nonce) };
  }
  const roll = prng.next();
  if (roll < 0.15) return { kind: "none" };
  if (roll < 0.35) {
    return {
      kind: "scheme",
      header: pick(prng, [
        "Bearer",
        "Bearer ",
        "Bearer  ",
        "bearer " + providerToken("google", users[0], nonce),
        "Basic dXNlcjpwYXNz",
        "Token abc",
        providerToken("google", users[0], nonce),
        "Bearer\t" + providerToken("google", users[0], nonce),
      ]),
    };
  }
  if (roll < 0.6) {
    return {
      kind: "malformed",
      token: pick(prng, [
        "abc",
        "a.b",
        "a.b.c.d",
        "eyJ.eyJ.sig",
        `${b64url("{}")}.${b64url("not json")}.sig`,
        `${b64url("{}")}.${b64url("[1,2]")}.sig`,
        `${b64url("{}")}.${b64url("null")}.sig`,
        `${b64url("{}")}.!!!.sig`,
        "x".repeat(prng.int(1, 5000)),
        mintToken({ sub: users[0], exp: FUTURE_EXP() }),
        mintToken({ iss: 42, sub: users[0], exp: FUTURE_EXP() }),
        mintToken({ iss: null, sub: users[0] }),
      ]),
    };
  }
  if (roll < 0.8) {
    return {
      kind: "wrong-issuer",
      token: mintToken({
        iss: pick(prng, [
          "https://evil.example.com",
          "https://accounts.google.com.evil.example",
          "accounts.google.com/",
          "http://accounts.google.com",
          "https://appleid.apple.com/auth",
          "https://other.supabase.co/auth/v2",
          "auth/v1",
          "",
        ]),
        sub: users[0],
        exp: FUTURE_EXP(),
      }),
    };
  }
  const provider = pick<"google" | "apple" | "session">(prng, ["google", "apple", "session"]);
  const past = Math.floor(Date.now() / 1000) - prng.int(1, 100_000);
  const token =
    provider === "session"
      ? mintToken({ iss: SESSION_ISSUER, sub: users[0], session_id: nonce, exp: past })
      : mintToken({
          iss: provider === "google" ? "https://accounts.google.com" : "https://appleid.apple.com",
          sub: users[0],
          exp: past,
        });
  return { kind: "expired", provider, token };
}

export function authorizationHeader(auth: AuthSpec): string | null {
  switch (auth.kind) {
    case "none":
      return null;
    case "scheme":
      return auth.header;
    default:
      return `Bearer ${auth.token}`;
  }
}

// ── Body generators ──────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function genBodyObject(prng: Prng, valid: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (valid) {
    body.scope = pick(prng, CONSENT_SCOPES);
    const profile = pick<TextProfile>(prng, [
      "ascii",
      "ascii",
      "ascii",
      "spaces",
      "unicode",
      "control",
      "lone-surrogate",
      "long",
      "boundary",
      "boundary",
      "only-stripped",
      "injection",
    ]);
    body.consentVersion = genText(prng, profile);
  } else {
    const which = prng.next();
    if (which < 0.45) {
      // bad scope
      const roll = prng.next();
      if (roll < 0.2) {
        // missing
      } else if (roll < 0.5) {
        body.scope = junkValue(prng);
      } else {
        body.scope = pick(prng, [
          "",
          " video_analysis",
          "video_analysis ",
          "Video_Analysis",
          "VIDEO_ANALYSIS",
          "video-analysis",
          "video_analysis\u0000",
          "video_analysis\u200b",
          "vіdeo_analysis", // Cyrillic і
          "model_training2",
          "all",
          "*",
          genText(prng, "injection"),
          genText(prng, "long"),
        ]);
      }
      body.consentVersion = prng.next() < 0.8 ? genText(prng, "ascii") : junkValue(prng);
    } else {
      body.scope = pick(prng, CONSENT_SCOPES);
      const roll = prng.next();
      if (roll < 0.2) {
        // missing consentVersion
      } else if (roll < 0.55) {
        body.consentVersion = junkValue(prng);
      } else if (roll < 0.75) {
        body.consentVersion = "";
      } else {
        body.consentVersion = genText(prng, "trim-empty");
      }
    }
  }
  // optional fields
  for (const key of ["source", "device", "captureMode"] as const) {
    const roll = prng.next();
    if (roll < 0.45) continue;
    if (roll < 0.8) body[key] = genText(prng, pick(prng, TEXT_PROFILES));
    else body[key] = junkValue(prng);
  }
  // extra keys the route must ignore
  if (prng.next() < 0.5) {
    const extras: Array<[string, unknown]> = [
      ["user_id", prng.uuid()],
      ["userId", prng.uuid()],
      ["action", "withdraw"],
      ["id", prng.uuid()],
      ["created_at", "1970-01-01T00:00:00Z"],
      ["__proto__", { polluted: true }],
      ["constructor", { prototype: { polluted: true } }],
      ["consent_version", "shadow"],
      ["scopes", CONSENT_SCOPES],
      [asciiText(prng, 1, 30), junkValue(prng)],
      ["nested", { deep: { deeper: [1, 2, { x: genText(prng, "unicode") }] } }],
    ];
    const n = prng.int(1, 3);
    for (let i = 0; i < n; i++) {
      const [k, v] = pick(prng, extras);
      body[k] = v;
    }
  }
  return body;
}

interface GeneratedBody {
  bytes: Uint8Array | null;
  preview: string;
  tags: string[];
}

function encodeBody(prng: Prng, bodyRoll: number): GeneratedBody {
  const tags: string[] = [];
  if (bodyRoll < 0.58) {
    const obj = genBodyObject(prng, true);
    tags.push("body:valid-object");
    return serialize(prng, obj, tags);
  }
  if (bodyRoll < 0.82) {
    const obj = genBodyObject(prng, false);
    tags.push("body:invalid-object");
    return serialize(prng, obj, tags);
  }
  if (bodyRoll < 0.86) {
    tags.push("body:absent");
    return { bytes: null, preview: "<no body>", tags };
  }
  // non-object / non-JSON / hostile encodings
  const variants: Array<[string, string | Uint8Array]> = [
    ["body:empty", ""],
    ["body:non-json", "not json at all"],
    ["body:json-array", JSON.stringify([{ scope: "video_analysis", consentVersion: "v1" }])],
    ["body:json-null", "null"],
    ["body:json-number", "42"],
    ["body:json-string", JSON.stringify("video_analysis")],
    ["body:json-true", "true"],
    ["body:truncated", '{"scope":"video_analysis","consentVersion":"v1"'],
    ["body:trailing-garbage", '{"scope":"video_analysis","consentVersion":"v1"} trailing'],
    [
      "body:bom-prefixed",
      "\ufeff" + JSON.stringify({ scope: "video_analysis", consentVersion: "v1" }),
    ],
    ["body:form-encoded", "scope=video_analysis&consentVersion=v1"],
    ["body:single-quotes", "{'scope':'video_analysis','consentVersion':'v1'}"],
    ["body:nan-literal", '{"scope":"video_analysis","consentVersion":NaN}'],
    ["body:comment", '{"scope":"video_analysis",/*c*/"consentVersion":"v1"}'],
    [
      "body:duplicate-keys",
      '{"scope":"bogus","scope":"video_analysis","consentVersion":"","consentVersion":"dup-wins"}',
    ],
    [
      "body:deep-nesting-5k",
      `{"scope":"video_analysis","consentVersion":"deep","x":${"[".repeat(5000)}${"]".repeat(5000)}}`,
    ],
    [
      "body:deep-nesting-200k",
      `{"scope":"video_analysis","consentVersion":"deep","x":${"[".repeat(200_000)}${"]".repeat(200_000)}}`,
    ],
    [
      "body:invalid-utf8",
      concatBytes(
        encoder.encode('{"scope":"video_analysis","consentVersion":"'),
        new Uint8Array([0xff, 0xfe, 0xc0, 0x80]),
        encoder.encode('"}'),
      ),
    ],
    [
      "body:nul-bytes",
      concatBytes(
        encoder.encode('{"scope":"video_analysis","consentVersion":"a'),
        new Uint8Array([0x00]),
        encoder.encode('b"}'),
      ),
    ],
    [
      "body:utf16",
      new Uint8Array(
        Array.from('{"scope":"video_analysis","consentVersion":"v1"}').flatMap((c) => [
          c.charCodeAt(0),
          0,
        ]),
      ),
    ],
    [
      "body:huge-key",
      `{"scope":"video_analysis","consentVersion":"v1","${"k".repeat(100_000)}":1}`,
    ],
    [
      "body:many-keys",
      `{${Array.from({ length: 20_000 }, (_, i) => `"k${i}":${i}`).join(",")},"scope":"video_analysis","consentVersion":"many"}`,
    ],
    [
      "body:long-string-1mb",
      JSON.stringify({
        scope: "video_analysis",
        consentVersion: "v1",
        device: "d".repeat(1_000_000),
      }),
    ],
    ["body:whitespace-only", " \n\t "],
    ["body:number-overflow", '{"scope":"video_analysis","consentVersion":"v1","n":1e999999}'],
    ["body:unicode-escapes", '{"scope":"\\u0076ideo_analysis","consentVersion":"\\u200b"}'],
    ["body:escaped-scope-bad", '{"scope":"video_analysis\\u0000","consentVersion":"v1"}'],
  ];
  const [tag, payload] = pick(prng, variants);
  tags.push(tag);
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  return { bytes, preview: previewOf(bytes), tags };
}

function serialize(prng: Prng, obj: Record<string, unknown>, tags: string[]): GeneratedBody {
  const roll = prng.next();
  let text = JSON.stringify(obj);
  if (roll < 0.1) {
    text = JSON.stringify(obj, null, 2);
    tags.push("body:pretty");
  } else if (roll < 0.15) {
    text = `\n\n  ${text}  \n`;
    tags.push("body:padded");
  }
  const bytes = encoder.encode(text);
  return { bytes, preview: previewOf(bytes), tags };
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

export function previewOf(bytes: Uint8Array | null): string {
  if (bytes === null) return "<no body>";
  const text = new TextDecoder().decode(bytes.subarray(0, 300));
  return bytes.byteLength > 300 ? `${text}…(+${bytes.byteLength - 300} bytes)` : text;
}

// ── Path / headers ───────────────────────────────────────────────────────────

const ROUTE_PREFIXES = ["/functions/v1/api", "/functions/v1/api", "/functions/v1/api", "/api", ""];

function genPath(prng: Prng, wrong: boolean): { path: string; tag: string } {
  const prefix = pick(prng, ROUTE_PREFIXES);
  if (!wrong) {
    const variants: Array<[string, string]> = [
      ["path:canonical", "/v1/me/consent/grant"],
      ["path:canonical", "/v1/me/consent/grant"],
      ["path:canonical", "/v1/me/consent/grant"],
      ["path:dot-segments", "/v1/me/consent/../consent/grant"],
      ["path:dot-segment-single", "/v1/me/./consent/grant"],
      ["path:double-leading-slash", "//v1/me/consent/grant"],
      ["path:interior-v1", "/v1/x/v1/me/consent/grant"],
    ];
    const [tag, core] = pick(prng, variants);
    // "//v1" only survives when there is no prefix; otherwise it is a normal segment boundary
    const path = tag === "path:double-leading-slash" ? core : `${prefix}${core}`;
    return { path, tag };
  }
  const variants: Array<[string, string]> = [
    ["path:trailing-slash", "/v1/me/consent/grant/"],
    ["path:upper", "/v1/me/consent/GRANT"],
    ["path:mixed", "/v1/me/Consent/grant"],
    ["path:pct-encoded-letter", "/v1/me/consent/gr%61nt"],
    ["path:pct-space", "/v1/me/consent/grant%20"],
    ["path:pct-nul", "/v1/me/consent/grant%00"],
    ["path:pct-slash", "/v1/me%2Fconsent/grant"],
    ["path:parent", "/v1/me/consent"],
    ["path:child", "/v1/me/consent/grant/extra"],
    ["path:status-sibling", "/v1/me/consent/status"],
    ["path:double-slash-mid", "/v1/me//consent/grant"],
    ["path:v2", "/v2/me/consent/grant"],
    ["path:no-v1", "/me/consent/grant"],
    ["path:zwsp", "/v1/me/consent/grant\u200b"],
    ["path:unicode", "/v1/me/consent/grànt"],
    ["path:semicolon", "/v1/me/consent/grant;x=1"],
    ["path:backslash", "/v1/me/consent\\grant"],
    ["path:long", `/v1/me/consent/grant/${"a".repeat(prng.int(1000, 20_000))}`],
    ["path:traversal-escape", "/v1/me/consent/grant/..%2F..%2Fadmin"],
  ];
  const [tag, core] = pick(prng, variants);
  return { path: `${prefix}${core}`, tag };
}

function genQuery(prng: Prng): string {
  const roll = prng.next();
  if (roll < 0.6) return "";
  return pick(prng, [
    "?scope=video_analysis&consentVersion=v1",
    "?x=1",
    "?" + "q=".padEnd(prng.int(10, 5000), "z"),
    "?scope[]=video_analysis",
    "?%00",
    "?select=*",
    "?user_id=eq.00000000-0000-4000-8000-000000000000",
    "?apikey=service_role",
    "?__proto__=1",
    "?a=1&a=2&a=3",
  ]);
}

function genMethod(prng: Prng): { method: string; tag: string } {
  const roll = prng.next();
  if (roll < 0.9) return { method: "POST", tag: "method:POST" };
  if (roll < 0.92) return { method: "post", tag: "method:post-lowercase" };
  const m = pick(prng, ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "GRANT", "PROPFIND"]);
  return { method: m, tag: `method:${m}` };
}

/** Header values travel as ByteStrings: a client's UTF-8 bytes arrive as
 * latin1 on the server, and CR/LF/NUL cannot appear at all. Model that so the
 * generated header is exactly what could reach the function. */
export function toHeaderValue(value: string): string {
  const bytes = encoder.encode(value);
  let out = "";
  for (const byte of bytes) {
    if (byte === 0x0d || byte === 0x0a || byte === 0x00) continue;
    out += String.fromCharCode(byte);
  }
  return out;
}

function genRequestId(prng: Prng): { value: string | null; tag: string } {
  const roll = prng.next();
  if (roll < 0.3) return { value: null, tag: "rid:none" };
  if (roll < 0.65) {
    const n = pick(prng, [8, 12, 36, 64]);
    return { value: asciiText(prng, n, n), tag: "rid:well-formed" };
  }
  const bad = pick(prng, [
    asciiText(prng, 7, 7),
    asciiText(prng, 65, 65),
    asciiText(prng, 200, 2000),
    "has space inside",
    "tab\there",
    "semi;colon",
    "slash/es",
    "ünïcödé-request-id",
    "🙂🙂🙂🙂🙂🙂🙂🙂",
    "",
    "   ",
    "  padded-ok-id-1234  ",
    'quote"in',
    "<script>",
    "a,b,c,d,e,f,g,h",
  ]);
  return { value: bad, tag: "rid:malformed" };
}

function genContentType(prng: Prng): string | null {
  const roll = prng.next();
  if (roll < 0.6) return "application/json";
  if (roll < 0.7) return null;
  return pick(prng, [
    "application/json; charset=utf-8",
    "application/json; charset=utf-16",
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=xyz",
    "application/octet-stream",
    "APPLICATION/JSON",
    "application/vnd.api+json",
    "text/html",
    "",
    "garbage/;;;",
  ]);
}

function genContentLength(prng: Prng, actual: number): { value: string | null; tag: string } {
  const roll = prng.next();
  if (roll < 0.75) return { value: null, tag: "cl:none" };
  if (roll < 0.85) return { value: String(actual), tag: "cl:exact" };
  const [tag, value] = pick<[string, string]>(prng, [
    ["cl:over-cap", "5000001"],
    ["cl:at-cap", "5000000"],
    ["cl:sci", "1e7"],
    ["cl:hex", "0x4C4B41"],
    ["cl:padded", " 5000001 "],
    ["cl:negative", "-5"],
    ["cl:nan", "abc"],
    ["cl:infinity", "Infinity"],
    ["cl:neg-infinity", "-Infinity"],
    ["cl:zero", "0"],
    ["cl:huge", "99999999999999999999"],
    ["cl:list", "10, 20"],
    ["cl:float", "4999999.9"],
    ["cl:empty", ""],
  ]);
  return { value, tag };
}

function genForwardedFor(
  prng: Prng,
  ips: string[],
): { headers: Record<string, string>; tag: string } {
  const ip = ips[prng.int(0, ips.length - 1)];
  const roll = prng.next();
  if (roll < 0.7) return { headers: { "x-forwarded-for": ip }, tag: "ip:single" };
  if (roll < 0.8) {
    return { headers: { "x-forwarded-for": `10.0.0.1, 172.16.0.1, ${ip}` }, tag: "ip:multi-hop" };
  }
  if (roll < 0.87)
    return { headers: { "cf-connecting-ip": ip, "x-forwarded-for": "1.1.1.1" }, tag: "ip:cf" };
  if (roll < 0.92) return { headers: {}, tag: "ip:none" };
  const [tag, value] = pick<[string, string]>(prng, [
    ["ip:garbage", "not-an-ip"],
    ["ip:empty", ""],
    ["ip:commas", ",,,"],
    ["ip:long", "9".repeat(5000)],
    ["ip:unicode", "١٢٧.٠.٠.١"],
    ["ip:trailing-comma", `${ip},`],
  ]);
  return { headers: { "x-forwarded-for": value }, tag };
}

function genNoiseHeaders(prng: Prng): Record<string, string> {
  const out: Record<string, string> = {};
  if (prng.next() < 0.5) return out;
  const candidates: Array<[string, string]> = [
    ["x-user-id", prng.uuid()],
    ["x-supabase-role", "service_role"],
    ["apikey", "service-role-test-key"],
    ["x-client-info", "pickle-sensei-ios/1.0"],
    [
      "accept",
      pick(prng, ["*/*", "application/json", "text/html", "application/vnd.pgrst.object+json"]),
    ],
    ["accept-encoding", "gzip, br"],
    ["origin", "https://evil.example"],
    ["prefer", "return=representation"],
    ["x-http-method-override", "DELETE"],
    ["cookie", "sb-access-token=abc"],
    ["range", "0-9"],
    ["x-forwarded-host", "evil.example"],
    ["transfer-encoding", "chunked"],
    ["expect", "100-continue"],
    ["x-" + asciiText(prng, 1, 20), asciiText(prng, 0, 200)],
  ];
  const n = prng.int(1, 4);
  for (let i = 0; i < n; i++) {
    const [k, v] = pick(prng, candidates);
    out[k] = v;
  }
  return out;
}

function genFault(prng: Prng, seed: number): Fault | null {
  const canary = `CANARY-${seed.toString(16)}-consent_records-PGRST-detail`;
  const roll = prng.next();
  if (roll < 0.3) return { kind: "insert-4xx", status: pick(prng, [400, 409, 403, 422]), canary };
  if (roll < 0.5) return { kind: "insert-5xx-html", canary };
  if (roll < 0.65) return { kind: "insert-throw", canary };
  if (roll < 0.75) return { kind: "insert-401", canary };
  if (roll < 0.9) return { kind: "select-5xx", canary };
  return { kind: "select-nonarray", canary };
}

// ── Scenario assembly ────────────────────────────────────────────────────────

export interface GeneratorOptions {
  /** Disable upstream fault injection (the PG variant talks to a real DB). */
  faults?: boolean;
  /** Disable multi-megabyte bodies (PG variant keeps iterations cheap). */
  largeBodies?: boolean;
}

export function generateScenario(
  campaignSeed: number,
  iteration: number,
  pools: { users: string[]; ips: string[] },
  options: GeneratorOptions = {},
): Scenario {
  const seed = iterationSeed(campaignSeed, iteration);
  const prng = new Prng(seed);
  const tags: string[] = [];

  const classRoll = prng.next();
  let kind: string;
  if (classRoll < 0.06 && options.faults !== false) kind = "db-fault";
  else if (classRoll < 0.13) kind = "wrong-route";
  else if (classRoll < 0.15 && options.largeBodies !== false) kind = "oversize";
  else kind = "mixed";
  tags.push(`kind:${kind}`);

  // auth: db-fault/oversize iterations need a live user to reach the body/insert
  const auth = genAuth(
    prng,
    pools.users,
    kind === "db-fault" || kind === "oversize" ? prng.next() * 0.6 : prng.next(),
  );
  tags.push(`auth:${auth.kind}${auth.kind === "session" ? `/${auth.verdict}` : ""}`);

  const { method, tag: methodTag } =
    kind === "mixed" ? genMethod(prng) : { method: "POST", tag: "method:POST" };
  tags.push(methodTag);
  const { path, tag: pathTag } = genPath(prng, kind === "wrong-route");
  tags.push(pathTag);
  const query = genQuery(prng);
  if (query) tags.push("query:present");

  let body: GeneratedBody;
  if (method === "GET" || method === "HEAD") {
    body = { bytes: null, preview: "<no body>", tags: ["body:absent(GET/HEAD)"] };
  } else if (kind === "oversize") {
    const over = prng.next() < 0.6;
    const pad = over ? MAX_JSON_BODY_BYTES + prng.int(1, 1000) : MAX_JSON_BODY_BYTES;
    const head = '{"scope":"video_analysis","consentVersion":"cap","pad":"';
    const tail = '"}';
    const padLength = pad - head.length - tail.length;
    const text = `${head}${"x".repeat(padLength)}${tail}`;
    const bytes = encoder.encode(text);
    body = {
      bytes,
      preview: previewOf(bytes),
      tags: [over ? "body:over-cap-streamed" : "body:exactly-at-cap"],
    };
  } else if (kind === "db-fault") {
    body = serialize(prng, genBodyObject(prng, true), ["body:valid-object"]);
  } else {
    body = encodeBody(prng, prng.next());
  }
  tags.push(...body.tags);

  const headers: Record<string, string> = {};
  const authorization = authorizationHeader(auth);
  if (authorization !== null) headers["authorization"] = authorization;
  const fwd = genForwardedFor(prng, pools.ips);
  Object.assign(headers, fwd.headers);
  tags.push(fwd.tag);
  const contentType = genContentType(prng);
  if (contentType !== null) headers["content-type"] = contentType;
  const rid = genRequestId(prng);
  if (rid.value !== null) headers["x-request-id"] = rid.value;
  tags.push(rid.tag);
  if (kind !== "oversize") {
    const cl = genContentLength(prng, body.bytes?.byteLength ?? 0);
    if (cl.value !== null) headers["content-length"] = cl.value;
    tags.push(cl.tag);
  }
  Object.assign(headers, genNoiseHeaders(prng));
  for (const [key, value] of Object.entries(headers)) headers[key] = toHeaderValue(value);
  // resolveRequestId trims, so "  padded-ok-id-1234  " is well formed.
  const sentRequestId = headers["x-request-id"] ?? null;

  const fault = kind === "db-fault" ? genFault(prng, seed) : null;
  if (fault) tags.push(`fault:${fault.kind}`);

  return {
    campaignSeed,
    iteration,
    seed,
    replay: replayKey(campaignSeed, iteration),
    kind,
    tags,
    method,
    url: `http://edge.test${path}${query}`,
    headers,
    body: body.bytes,
    bodyPreview: body.preview,
    auth,
    fault,
    requestId: {
      sent: sentRequestId,
      wellFormed: sentRequestId !== null && REQUEST_ID_RE.test(sentRequestId.trim()),
    },
  };
}

export function buildRequest(scenario: Scenario): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(scenario.headers)) headers.set(k, v);
  return new Request(scenario.url, {
    method: scenario.method,
    headers,
    body: scenario.body === null ? undefined : (scenario.body as BodyInit),
  });
}

// ── Oracle ───────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Mirror of index.ts readBody: bytes → text → JSON → record-or-{}. */
export function modelBody(bytes: Uint8Array | null): Record<string, unknown> {
  const text = bytes === null ? "" : new TextDecoder().decode(bytes);
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function codePointLength(text: string): number {
  return Array.from(text).length;
}

export function predictedInsertRow(userId: string, body: Record<string, unknown>): InsertRow {
  return {
    user_id: userId,
    scope: body.scope as string,
    consent_version: sanitizeUserText(body.consentVersion as string, EDGE_CAPS.consent_version),
    action: "grant",
    source:
      typeof body.source === "string" ? sanitizeUserText(body.source, EDGE_CAPS.source) : null,
    device:
      typeof body.device === "string" ? sanitizeUserText(body.device, EDGE_CAPS.device) : null,
    capture_mode:
      typeof body.captureMode === "string"
        ? sanitizeUserText(body.captureMode, EDGE_CAPS.capture_mode)
        : null,
  };
}

export function rowAnomalies(row: InsertRow): string[] {
  const out: string[] = [];
  if (row.consent_version === "") out.push("empty_consent_version_stored");
  if (codePointLength(row.consent_version) > DB_CAPS.consent_version) {
    out.push("consent_version_exceeds_db_cap_50");
  }
  if (row.capture_mode !== null && codePointLength(row.capture_mode) > DB_CAPS.capture_mode) {
    out.push("capture_mode_exceeds_db_cap_50");
  }
  return out;
}

export function predict(scenario: Scenario, request: Request): Prediction {
  const base: Prediction = {
    statuses: [],
    writes: 0,
    insertRow: null,
    authFailure: false,
    userId: null,
    routeScope: null,
    generic5xx: false,
    anomalies: [],
    stage: "",
  };
  const url = new URL(request.url);
  const method = request.method;

  // 1. declared content-length gate (before auth)
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
    return { ...base, statuses: [413], stage: "content-length" };
  }

  // 2. route
  const v1 = url.pathname.lastIndexOf("/v1/");
  const path = v1 >= 0 ? url.pathname.slice(v1) : url.pathname;
  const route = `${method} ${path}`;

  // 3. authenticate
  let userId: string;
  switch (scenario.auth.kind) {
    case "none":
    case "scheme":
    case "malformed":
    case "wrong-issuer":
    case "expired":
      return { ...base, statuses: [401], authFailure: true, stage: "auth" };
    case "session":
      if (scenario.auth.verdict === "outage") {
        return { ...base, statuses: [503], generic5xx: true, stage: "auth-outage" };
      }
      if (scenario.auth.verdict !== "live") {
        return { ...base, statuses: [401], authFailure: true, stage: "auth" };
      }
      userId = scenario.auth.sub;
      break;
    default:
      userId = scenario.auth.userId;
  }
  const routeScope: "consent" | "user" =
    method === "POST" && path.startsWith("/v1/me/consent/") ? "consent" : "user";
  const authed = { ...base, userId, routeScope };

  // 4. dispatch
  if (route !== "POST /v1/me/consent/grant") {
    return { ...authed, statuses: [404], stage: "route" };
  }

  // 5. body
  if (scenario.body !== null && scenario.body.byteLength > MAX_JSON_BODY_BYTES) {
    return { ...authed, statuses: [413], stage: "body-stream" };
  }
  const body = modelBody(scenario.body);
  const scope = body.scope;
  if (typeof scope !== "string" || !(CONSENT_SCOPES as readonly string[]).includes(scope)) {
    return {
      ...authed,
      statuses: [400],
      code: "validation.consent_grant",
      stage: "validate-scope",
    };
  }
  const consentVersion = body.consentVersion;
  if (typeof consentVersion !== "string" || !consentVersion.trim()) {
    return {
      ...authed,
      statuses: [400],
      code: "validation.consent_grant",
      stage: "validate-version",
    };
  }
  const insertRow = predictedInsertRow(userId, body);
  const anomalies = rowAnomalies(insertRow);

  // 6. injected upstream faults
  if (scenario.fault) {
    switch (scenario.fault.kind) {
      case "insert-4xx":
      case "insert-5xx-html":
      case "insert-throw":
      case "insert-401":
        return {
          ...authed,
          statuses: [503],
          generic5xx: true,
          insertRow,
          anomalies,
          stage: "insert-fault",
        };
      case "select-5xx":
        return {
          ...authed,
          statuses: [503],
          generic5xx: true,
          writes: 1,
          insertRow,
          anomalies,
          stage: "select-fault",
        };
      case "select-nonarray":
        return {
          ...authed,
          statuses: [500],
          generic5xx: true,
          writes: 1,
          insertRow,
          anomalies,
          stage: "select-fault",
        };
    }
  }
  return { ...authed, statuses: [200], writes: 1, insertRow, anomalies, stage: "ok" };
}

// ── Campaign-level rate-limit overlay ────────────────────────────────────────

export class RateModel {
  private minuteBucket = -1;
  private fiveMinuteBucket = -1;
  private ipHits = new Map<string, number>();
  private authFails = new Map<string, number>();
  private userHits = new Map<string, number>();

  private roll(nowMs: number): void {
    const minute = Math.floor(nowMs / 60_000);
    const five = Math.floor(nowMs / 300_000);
    if (minute !== this.minuteBucket) {
      this.minuteBucket = minute;
      this.ipHits.clear();
      this.userHits.clear();
    }
    if (five !== this.fiveMinuteBucket) {
      this.fiveMinuteBucket = five;
      this.authFails.clear();
    }
  }

  /** Apply the overlay in handler order and return the final acceptable statuses
   * plus whether the write may still happen. Mutates the counters exactly as
   * the in-memory limiter would. */
  apply(request: Request, prediction: Prediction, nowMs: number): Prediction {
    this.roll(nowMs);
    if (prediction.stage === "content-length") return prediction;
    const ip = clientIp(request);
    const ipCount = (this.ipHits.get(ip) ?? 0) + 1;
    this.ipHits.set(ip, ipCount);
    if (ipCount > IP_LIMIT.limit) {
      return { ...prediction, statuses: [429], writes: 0, authFailure: false, stage: "rate-ip" };
    }
    if ((this.authFails.get(ip) ?? 0) >= AUTH_FAILURE_LIMIT.limit) {
      return {
        ...prediction,
        statuses: [429],
        writes: 0,
        authFailure: false,
        stage: "rate-authfail",
      };
    }
    if (prediction.authFailure) {
      this.authFails.set(ip, (this.authFails.get(ip) ?? 0) + 1);
      return prediction;
    }
    if (prediction.userId !== null && prediction.routeScope !== null) {
      const key = `${prediction.routeScope}:${prediction.userId}`;
      const count = (this.userHits.get(key) ?? 0) + 1;
      this.userHits.set(key, count);
      const limit =
        prediction.routeScope === "consent" ? CONSENT_LIMIT.limit : GENERAL_USER_LIMIT.limit;
      if (count > limit) {
        return { ...prediction, statuses: [429], writes: 0, stage: "rate-user" };
      }
    }
    return prediction;
  }
}

// ── Response checker ─────────────────────────────────────────────────────────

export interface RecordedRestCall {
  method: string;
  url: string;
  authorization: string | null;
  apikey: string | null;
  body: unknown;
}

export interface Observed {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  restCalls: RecordedRestCall[];
  /** rows appended to the consent ledger during this request */
  writes: InsertRow[];
  unexpectedUpstream: string[];
  ledgerAfter: LedgerRow[];
}

export interface LedgerRow extends InsertRow {
  id: string;
  created_at: string;
}

export function foldConsentStatus(rows: LedgerRow[]) {
  return {
    subjectPseudonym: null,
    scopes: CONSENT_SCOPES.map((scope) => {
      const last = rows.filter((r) => r.scope === scope).at(-1) ?? null;
      return {
        scope,
        active: last?.action === "grant",
        consentVersion: last?.consent_version ?? null,
        lastAction: last === null ? null : last.action === "grant" ? "granted" : "withdrawn",
        lastActionAt: last?.created_at ?? null,
      };
    }),
  };
}

const LEAK_MARKERS = [
  "PGRST",
  "23514",
  "42501",
  'relation "',
  "consent_records",
  "Failing row",
  "index.ts",
  "http.ts",
  "    at ",
  "\n at ",
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "RangeError",
  "supabase.test",
  "Supabase Auth",
  "unexpected fetch",
  "stub",
  "postgres",
  "Bad Gateway",
];

export interface CheckResult {
  failures: string[];
  bodyKind: string;
  code: string | null;
  message: string | null;
  requestIdEchoed: boolean | null;
}

function equalRows(a: InsertRow, b: InsertRow): boolean {
  return (
    a.user_id === b.user_id &&
    a.scope === b.scope &&
    a.consent_version === b.consent_version &&
    a.action === b.action &&
    a.source === b.source &&
    a.device === b.device &&
    a.capture_mode === b.capture_mode
  );
}

export function checkOutcome(
  scenario: Scenario,
  request: Request,
  prediction: Prediction,
  observed: Observed,
  options: { requireFold?: boolean } = {},
): CheckResult {
  const failures: string[] = [];
  const { status, headers, bodyText } = observed;

  // status allowlist
  if (!prediction.statuses.includes(status)) {
    failures.push(
      `status ${status} not in predicted ${JSON.stringify(prediction.statuses)} (stage ${prediction.stage})`,
    );
  }
  if (status >= 400 && status < 500 && !ALLOWED_REJECTION_STATUSES.has(status)) {
    failures.push(`4xx ${status} outside allowlist`);
  }
  if (status >= 500 && !prediction.generic5xx) {
    failures.push(`unexpected 5xx ${status} (no fault injected)`);
  }

  // body shape
  let bodyKind = "empty";
  let code: string | null = null;
  let message: string | null = null;
  let parsed: unknown = undefined;
  if (bodyText !== "") {
    try {
      parsed = JSON.parse(bodyText);
      bodyKind = Array.isArray(parsed)
        ? "json-array"
        : isRecord(parsed)
          ? "json-object"
          : "json-scalar";
    } catch {
      bodyKind = "non-json";
    }
  }
  if (request.method !== "HEAD" && bodyKind !== "json-object") {
    failures.push(`response body is ${bodyKind}, expected a JSON object`);
  }
  if (isRecord(parsed)) {
    if (status >= 400) {
      const error = parsed.error;
      if (!isRecord(error) || typeof error.message !== "string" || !error.message) {
        failures.push("error body lacks error.message");
      } else {
        message = error.message;
        code = typeof error.code === "string" ? error.code : null;
        if (status >= 500 && !GENERIC_5XX_MESSAGES.has(error.message)) {
          failures.push(`5xx message is not generic: ${JSON.stringify(error.message)}`);
        }
        if (status >= 500 && code !== null) {
          failures.push(`5xx body carries a code: ${code}`);
        }
        if (prediction.code && status === 400 && code !== prediction.code) {
          failures.push(`400 code ${code} !== ${prediction.code}`);
        }
        if (status === 404 && !error.message.startsWith("Unknown endpoint: ")) {
          failures.push(`404 message unexpected: ${error.message.slice(0, 80)}`);
        }
        // eslint-disable-next-line no-control-regex -- the leak being checked is raw control bytes
        if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(error.message)) {
          failures.push("error message contains raw control characters");
        }
      }
    } else if (status === 200) {
      const scopes = parsed.scopes;
      if (parsed.subjectPseudonym !== null || !Array.isArray(scopes) || scopes.length !== 3) {
        failures.push("200 body is not the folded consent status");
      } else if (options.requireFold !== false) {
        const expected = foldConsentStatus(observed.ledgerAfter);
        if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
          failures.push(
            `200 fold mismatch: got ${JSON.stringify(parsed).slice(0, 200)} expected ${JSON.stringify(expected).slice(0, 200)}`,
          );
        }
      }
    }
  }

  // Leak scan: the response must never carry upstream/internal detail or the
  // per-iteration canary. A marker the CALLER itself supplied (in the body it
  // sent or in the path a 404 echoes) is an echo, not a leak, so it is
  // subtracted from the haystack first.
  const haystack = `${bodyText}\n${Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}`;
  if (scenario.fault && haystack.includes(scenario.fault.canary)) {
    failures.push("injected upstream detail (canary) leaked into the response");
  }
  const suppliedUrl = new URL(request.url);
  const supplied = [
    scenario.body === null ? "" : new TextDecoder().decode(scenario.body),
    `${suppliedUrl.pathname}${suppliedUrl.search}`,
    ...Object.values(scenario.headers),
  ].join("\n");
  // A 200 body is compared byte-for-byte against the modelled fold below, so a
  // leak there cannot hide; the marker scan targets error bodies, where the
  // handler is the one choosing the text.
  for (const marker of status >= 400 ? LEAK_MARKERS : []) {
    if (haystack.includes(marker) && !supplied.includes(marker)) {
      failures.push(`leak marker in response: ${marker}`);
    }
  }

  // headers
  const rid = headers["x-request-id"] ?? null;
  let requestIdEchoed: boolean | null = null;
  if (rid === null || rid === "") {
    failures.push("x-request-id missing");
  } else if (scenario.requestId.sent !== null && scenario.requestId.wellFormed) {
    requestIdEchoed = rid === scenario.requestId.sent.trim();
    if (!requestIdEchoed) failures.push(`well-formed x-request-id not echoed (${rid})`);
  } else {
    requestIdEchoed = false;
    if (!UUID_RE.test(rid)) failures.push(`minted x-request-id is not a UUID: ${rid.slice(0, 80)}`);
    if (scenario.requestId.sent !== null && rid === scenario.requestId.sent) {
      failures.push("malformed client x-request-id was echoed verbatim");
    }
  }
  if (request.method !== "HEAD" || bodyText !== "") {
    const contentType = headers["content-type"] ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      failures.push(`content-type ${JSON.stringify(contentType)} is not application/json`);
    }
  }
  if ((headers["x-content-type-options"] ?? "").toLowerCase() !== "nosniff")
    failures.push("nosniff missing");
  if (!(headers["cache-control"] ?? "").toLowerCase().includes("no-store"))
    failures.push("cache-control no-store missing");
  if (status === 429) {
    if (!headers["retry-after"]) failures.push("429 without Retry-After");
    if (!headers["ratelimit-limit"]) failures.push("429 without RateLimit-Limit");
  }

  // writes
  if (observed.writes.length !== prediction.writes) {
    failures.push(
      `writes ${observed.writes.length} !== predicted ${prediction.writes} (status ${status}, stage ${prediction.stage})`,
    );
  }
  if (status !== 200 && observed.writes.length > 0 && prediction.writes === 0) {
    failures.push("write happened on a rejected request");
  }
  if (prediction.insertRow && observed.writes.length === 1) {
    const row = observed.writes[0];
    if (!equalRows(row, prediction.insertRow)) {
      failures.push(
        `inserted row differs from model: got ${JSON.stringify(row)} expected ${JSON.stringify(prediction.insertRow)}`,
      );
    }
  }
  for (const call of observed.restCalls) {
    if (call.method !== "GET" && call.method !== "POST") {
      failures.push(`non-insert write verb on consent_records: ${call.method}`);
    }
    if (call.method === "POST" && Array.isArray(call.body)) {
      failures.push("bulk insert body on consent_records");
    }
  }
  const posts = observed.restCalls.filter((c) => c.method === "POST");
  const gets = observed.restCalls.filter((c) => c.method === "GET");
  if (status === 200) {
    if (posts.length !== 1) failures.push(`expected exactly one insert, saw ${posts.length}`);
    if (gets.length !== 1) failures.push(`expected exactly one reload, saw ${gets.length}`);
    if (posts.length === 1 && gets.length === 1) {
      const postIndex = observed.restCalls.indexOf(posts[0]);
      const getIndex = observed.restCalls.indexOf(gets[0]);
      if (getIndex < postIndex) failures.push("reload happened before the insert");
      const getUrl = new URL(gets[0].url);
      if (getUrl.searchParams.get("user_id") !== `eq.${prediction.userId}`) {
        failures.push(`reload not scoped to the caller: ${getUrl.search}`);
      }
    }
  }
  if (prediction.userId !== null) {
    const expectedBearer =
      scenario.auth.kind === "session"
        ? `Bearer ${scenario.auth.token}`
        : `Bearer session-for-${prediction.userId}`;
    for (const call of observed.restCalls) {
      if (call.authorization !== expectedBearer) {
        failures.push(
          `PostgREST call bears ${JSON.stringify(call.authorization?.slice(0, 40))}, expected the caller's session`,
        );
      }
      if (call.apikey !== "anon-test-key")
        failures.push("PostgREST call does not use the anon apikey");
    }
  }
  if (observed.unexpectedUpstream.length > 0) {
    failures.push(`unexpected upstream fetch: ${observed.unexpectedUpstream.join(" | ")}`);
  }

  return { failures, bodyKind, code, message, requestIdEchoed };
}

// ── Report ───────────────────────────────────────────────────────────────────

export interface OutcomeRow {
  iteration: number;
  seed: number;
  replay: string;
  kind: string;
  tags: string[];
  method: string;
  path: string;
  auth: string;
  fault: string | null;
  bodyPreview: string;
  status: number;
  predicted: number[];
  stage: string;
  code: string | null;
  message: string | null;
  requestId: { sent: string | null; got: string | null; echoed: boolean | null };
  writes: number;
  bodyKind: string;
  anomalies: string[];
  failures: string[];
  durationMs: number;
}

export function outcomeRow(
  scenario: Scenario,
  prediction: Prediction,
  observed: Observed,
  check: CheckResult,
  durationMs: number,
): OutcomeRow {
  return {
    iteration: scenario.iteration,
    seed: scenario.seed,
    replay: scenario.replay,
    kind: scenario.kind,
    tags: scenario.tags,
    method: scenario.method,
    path: scenario.url.slice("http://edge.test".length, "http://edge.test".length + 200),
    auth: scenario.tags.find((t) => t.startsWith("auth:")) ?? scenario.auth.kind,
    fault: scenario.fault?.kind ?? null,
    bodyPreview: scenario.bodyPreview.slice(0, 200),
    status: observed.status,
    predicted: prediction.statuses,
    stage: prediction.stage,
    code: check.code,
    message: check.message,
    requestId: {
      sent: scenario.requestId.sent === null ? null : scenario.requestId.sent.slice(0, 80),
      got: observed.headers["x-request-id"] ?? null,
      echoed: check.requestIdEchoed,
    },
    writes: observed.writes.length,
    bodyKind: check.bodyKind,
    anomalies: prediction.anomalies,
    failures: check.failures,
    durationMs: Math.round(durationMs * 100) / 100,
  };
}

export function stressOutDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-consent-grant/latest/", import.meta.url).pathname;
}

export async function writeStressReport(name: string, report: unknown): Promise<string> {
  const dir = stressOutDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

export function summarize(rows: OutcomeRow[]) {
  const statusHistogram: Record<string, number> = {};
  const stageHistogram: Record<string, number> = {};
  const kindHistogram: Record<string, number> = {};
  const tagHistogram: Record<string, number> = {};
  const anomalyHistogram: Record<string, number> = {};
  for (const row of rows) {
    statusHistogram[row.status] = (statusHistogram[row.status] ?? 0) + 1;
    stageHistogram[row.stage] = (stageHistogram[row.stage] ?? 0) + 1;
    kindHistogram[row.kind] = (kindHistogram[row.kind] ?? 0) + 1;
    for (const t of row.tags) tagHistogram[t] = (tagHistogram[t] ?? 0) + 1;
    for (const a of row.anomalies) anomalyHistogram[a] = (anomalyHistogram[a] ?? 0) + 1;
  }
  return {
    executed: rows.length,
    failed: rows.filter((r) => r.failures.length > 0).length,
    fiveXx: rows
      .filter((r) => r.status >= 500)
      .map((r) => ({
        replay: r.replay,
        seed: r.seed,
        status: r.status,
        fault: r.fault,
        stage: r.stage,
        message: r.message,
        /** false ⇒ a 5xx that no injected upstream fault explains (a finding). */
        injected: r.fault !== null || r.stage === "auth-outage",
      })),
    writesOnRejection: rows
      .filter((r) => r.status !== 200 && r.writes > 0 && r.stage !== "select-fault")
      .map((r) => r.replay),
    statusHistogram,
    stageHistogram,
    kindHistogram,
    tagHistogram,
    anomalyHistogram,
    anomalySeeds: Object.fromEntries(
      Object.keys(anomalyHistogram).map((a) => [
        a,
        rows
          .filter((r) => r.anomalies.includes(a))
          .slice(0, 25)
          .map((r) => r.replay),
      ]),
    ),
    slowest: [...rows]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5)
      .map((r) => ({ replay: r.replay, durationMs: r.durationMs, tags: r.tags })),
  };
}
