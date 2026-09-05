// stress · fuzz-boundary — POST /v1/auth/refresh (supabase/functions/api/index.ts)
//
// Seeded fuzz/boundary campaign against the REAL handler in-process (routesHarness
// captures Deno.serve; Supabase Auth / PostgREST / RevenueCat are stubbed, Upstash
// is disabled so the in-memory rate limiter runs). Every iteration derives ONE
// 32-bit seed from the campaign seed and is fully replayable from it: the seed
// decides method, path shape, query string, headers (content-type, content-length,
// x-request-id, x-forwarded-for / cf-connecting-ip, authorization), the body
// (valid / invalid / missing / non-object / malformed / oversize / streamed) and
// the GoTrue answer for `POST /auth/v1/token?grant_type=refresh_token`.
//
// Invariants asserted per request (an oracle computed from the SPEC, never from
// the response):
//   · bad input answers only 400/401/403/404/405/413/415/429; a 5xx is allowed
//     ONLY when the seeded GoTrue plan is an outage, and then it must be 503;
//   · every 4xx/5xx body is `{error:{message[,code]}}`, every 5xx message is one
//     of the two generic strings, no body ever carries a stack frame, an
//     upstream detail, a file path, or the client's refresh token;
//   · `x-request-id` is present on every answer (echoed when well-formed, a
//     UUID otherwise) and matches the single access-log line, which carries no
//     body/token/IP/query;
//   · no write anywhere on rejection: zero PostgREST/RPC/RevenueCat calls for the
//     route at all, zero GoTrue calls for 400/413/429/route-miss; when GoTrue IS
//     consulted it receives exactly the trimmed token, once per attempt;
//   · handler console output never contains the client's refresh token.
//
// Knobs (all optional):
//   STRESS_ITER=<n>        iterations (default 150; the campaign that produced
//                          the report ran 3000)
//   STRESS_SEED=<n>        campaign seed (default 20260905)
//   STRESS_REPLAY=<a,b,c>  run exactly these per-iteration seeds instead
//   STRESS_REPEAT=<n>      run each replayed seed n times (flake rate)
//   STRESS_OUT=<file.json> write the seed → outcome table there
//
// Replay a failing seed:
//   STRESS_REPLAY=123456789 deno test -A --no-check --config deno.json \
//     stress_auth_refresh_fuzz.test.ts

import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import { loadHarness, SUPABASE_URL, TEST_USER_ID, type Harness } from "./routesHarness.ts";

// ── knobs ───────────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const STRESS_ITER = envInt("STRESS_ITER", 150);
const STRESS_SEED = envInt("STRESS_SEED", 20260905);
const STRESS_REPEAT = envInt("STRESS_REPEAT", 1);
const STRESS_REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s) >>> 0);
const STRESS_OUT = Deno.env.get("STRESS_OUT");

/** Route-side constants mirrored from index.ts — the oracle must not import them
 * from the handler under test. */
const MAX_JSON_BODY_BYTES = 5_000_000;
const AUTH_RETRY_AFTER_SECONDS = 2;
/** Small, positive GoTrue deadline: keeps the persistent-fault / hang plans at
 * ~300 ms each instead of the production 6 s. Read per call by the handler. */
const UPSTREAM_TIMEOUT_MS = 300;

const BAD_INPUT_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 405, 413, 415, 429]);
const GENERIC_5XX_MESSAGES: ReadonlySet<string> = new Set([
  "Session refresh is temporarily unavailable. Please try again.",
  "Something went wrong. Please try again.",
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
/** Anything that would betray an internal failure to the client. */
const LEAK_MARKERS: readonly RegExp[] = [
  /\bat\s+\S+\s+\(/, // stack frame "at fn (file:line)"
  /\.ts:\d+/,
  /file:\/\//,
  /supabase\.test/,
  /Supabase Auth/,
  /HTTP \d{3}/,
  /invalid_grant/,
  /RangeError|TypeError|SyntaxError|ReferenceError/,
  /Maximum call stack/,
  /\bdeno\b/i,
];

// ── seeded RNG ──────────────────────────────────────────────────────────────

/** mulberry32 — the same generator the xc harness uses; tiny and replayable. */
class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  range(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  weighted<T>(table: readonly (readonly [number, T])[]): T {
    const total = table.reduce((sum, [w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [w, value] of table) {
      roll -= w;
      if (roll < 0) return value;
    }
    return table[table.length - 1][1];
  }
  /** Like `weighted`, but only the chosen branch consumes randomness / builds
   * its (possibly large) value. */
  weightedLazy<T>(table: readonly (readonly [number, () => T])[]): T {
    return this.weighted(table)();
  }
  alnum(
    length: number,
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  ): string {
    let out = "";
    for (let i = 0; i < length; i += 1) out += alphabet[this.int(alphabet.length)];
    return out;
  }
}

/** splitmix-style derivation of the i-th iteration seed from the campaign seed. */
function iterationSeed(campaignSeed: number, index: number): number {
  let z = (Math.imul(campaignSeed, 0x9e3779b1) + Math.imul(index + 1, 0x85ebca77)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x7feb352d) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x846ca68b) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

// ── request spec (everything a seed decides) ────────────────────────────────

type IpClass = "fresh" | "hot";

type BodyKind =
  | "valid"
  | "valid_extra_keys"
  | "valid_duplicate_key"
  | "valid_bom_prefixed"
  | "invalid_token_type"
  | "blank_token"
  | "missing_key"
  | "proto_key"
  | "non_object"
  | "malformed"
  | "invalid_utf8"
  | "deep_nesting"
  | "form_encoded"
  | "empty"
  | "no_body"
  | "at_cap"
  | "over_cap_stream";

type UpstreamPlan =
  | { kind: "ok"; accessToken: string; refreshToken: string; expiresIn: number | null }
  | { kind: "refused"; status: 400 | 401 | 403; body: string }
  | { kind: "http_429"; retryAfter: string | null }
  | { kind: "http_5xx"; status: number; body: string }
  | { kind: "http_other"; status: number; body: string }
  | { kind: "malformed_2xx"; status: number; body: string }
  | { kind: "net_fail_once"; accessToken: string; refreshToken: string }
  | { kind: "net_fail_persistent" }
  | { kind: "hang" };

interface RequestSpec {
  seed: number;
  method: string;
  path: string;
  query: string;
  ipHeader: Record<string, string>;
  ipClass: IpClass;
  contentType: string | null;
  contentLength: string | null;
  requestId: string | null;
  authorization: string | null;
  bodyKind: BodyKind;
  /** Text body (null = no body; over_cap_stream has none and streams instead). */
  bodyText: string | null;
  /** Raw bytes for invalid_utf8 (bodyText is a lossy preview). */
  bodyBytes: Uint8Array<ArrayBuffer> | null;
  /** Bytes to stream for over_cap_stream. */
  streamBytes: number;
  /** The refreshToken the oracle expects GoTrue to receive (trimmed), or null
   * when the route must answer 400 before consulting GoTrue. */
  effectiveToken: string | null;
  /** The raw client token text (pre-trim) — must never leak into any body/log. */
  rawToken: string | null;
  upstream: UpstreamPlan;
}

const CANONICAL_PATHS = [
  "/functions/v1/api/v1/auth/refresh",
  "/api/v1/auth/refresh",
  "/v1/auth/refresh",
] as const;

/** Paths that must NOT reach the refresh route (and hit no other route either). */
const NEAR_MISS_PATHS = [
  "/v1/auth/refresh/",
  "/v1/auth//refresh",
  "/v1/auth/%72efresh",
  "/v1/auth/refresh%20",
  "/V1/AUTH/REFRESH",
  "/v1/Auth/refresh",
  "/v1/auth/refresh/extra",
  "/v1/auth/refres",
  "/v1/auth/refreshh",
  "/v2/auth/refresh",
  "/v1/auth/refresh%00",
  "/v1/auth/refresh;jsessionid=1",
  "/v1/auth/refresh%2F",
  "/v1/authrefresh",
  "/v1//auth/refresh",
] as const;

/** Paths whose LAST "/v1/" segment normalises to the route — must match. */
const ODD_BUT_MATCHING_PATHS = [
  "/functions/v1/api/v1/foo/v1/auth/refresh",
  "/v1/auth/refresh/../refresh",
  "/functions/v1/api/./v1/auth/refresh",
  "/anything/at/all/v1/auth/refresh",
] as const;

const HOT_IPS = ["203.0.113.250", "198.51.100.7"] as const;

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Same shape as routesHarness.fakeGoogleIdToken but with a seed-fixed `exp`
 * (far future) so a regenerated spec is byte-identical. Only the issuer is
 * routed on; verification is the harness stub. */
function googleIdToken(exp: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iss: "https://accounts.google.com", sub: TEST_USER_ID, exp }),
  );
  return `${header}.${payload}.sig`;
}
const GOOGLE_ID_TOKEN_PREFIX = googleIdToken(0).split(".")[0];

function ipFor(rng: Rng): string {
  return `10.${rng.int(256)}.${rng.int(256)}.${rng.range(1, 254)}`;
}

function tokenText(rng: Rng): string {
  return rng.weightedLazy<string>([
    [30, () => rng.alnum(rng.range(12, 64))],
    [10, () => rng.alnum(rng.range(200, 2_000))],
    [3, () => rng.alnum(rng.range(20_000, 200_000))],
    [6, () => `${rng.alnum(20)}.${rng.alnum(60)}.${rng.alnum(43)}`], // JWT-shaped
    [5, () => `  ${rng.alnum(24)}\t\n`], // surrounding whitespace → trimmed
    [3, () => `\u00a0${rng.alnum(24)}\ufeff`], // NBSP/BOM → trimmed by String#trim
    [4, () => `${rng.alnum(8)}\u200b${rng.alnum(8)}`], // zero-width inside (kept)
    [4, () => `${rng.alnum(8)} ${rng.alnum(8)}`], // interior space (kept)
    [4, () => `🥒${rng.alnum(10)}日本語${rng.alnum(4)}\u202e`], // emoji / CJK / RTL override
    [3, () => `${rng.alnum(8)}\u0000${rng.alnum(8)}`], // NUL inside
    [3, () => `"${rng.alnum(8)}\\"${rng.alnum(8)}`], // quotes / backslashes
    [3, () => `${rng.alnum(8)}\n${rng.alnum(8)}\r\n`],
    [3, () => `' OR 1=1; -- ${rng.alnum(8)}`],
    [3, () => `<script>alert(${rng.int(1000)})</script>`],
    [2, () => `../../etc/passwd${rng.alnum(4)}`],
    [2, () => `\ud83d${rng.alnum(8)}`], // lone surrogate
    [2, () => "x".repeat(rng.range(1, 7))], // short but valid
    [2, () => String(rng.int(1e9))], // digits-only
  ]);
}

function invalidTokenValue(rng: Rng): string {
  return rng.pick([
    "null",
    "123",
    "0",
    "true",
    "false",
    "[]",
    `["${rng.alnum(12)}"]`,
    "{}",
    `{"refreshToken":"${rng.alnum(12)}"}`,
    "1e400",
    "-0",
  ]);
}

function blankTokenValue(rng: Rng): string {
  return JSON.stringify(
    rng.pick([
      "",
      " ",
      "   ",
      "\t",
      "\n",
      "\r\n",
      "\u00a0",
      "\ufeff",
      " \u00a0\ufeff\t\n ",
      "\u2028\u2029",
    ]),
  );
}

function malformedJson(rng: Rng): string {
  const token = rng.alnum(12);
  return rng.pick([
    "{",
    "}",
    `{"refreshToken": }`,
    `{"refreshToken": "${token}"`,
    `{'refreshToken':'${token}'}`,
    `{refreshToken:"${token}"}`,
    `\ufeff\ufeff{"refreshToken":"${token}"}`, // TextDecoder strips ONE leading BOM; the second stays
    ` \ufeff{"refreshToken":"${token}"}`, // BOM after whitespace is not stripped
    `{"refreshToken":"${token}"}x`,
    `{"refreshToken":"${token}"},`,
    `{"refreshToken":"${token}"}{"refreshToken":"${token}"}`,
    `{"refreshToken": NaN}`,
    `{"refreshToken": undefined}`,
    `// c\n{"refreshToken":"${token}"}`,
    `{"refreshToken":"${token}",}`,
    `{"refreshToken":"${token}\n"}`, // raw newline inside a JSON string
    `{"refreshToken":"\\ud83d"}`.slice(0, -2), // truncated escape
    rng.alnum(rng.range(1, 300), '{}[]":,\\ abc\n'),
    "\u0000\u0001\u0002",
    `{"refreshToken":"${token}"}\u0000`,
  ]);
}

function nonObjectJson(rng: Rng): string {
  const token = rng.alnum(12);
  return rng.pick([
    "[]",
    `["${token}"]`,
    `[{"refreshToken":"${token}"}]`,
    `"${token}"`,
    "123",
    "null",
    "true",
    "false",
    `"refreshToken=${token}"`,
  ]);
}

function missingKeyJson(rng: Rng): string {
  const token = rng.alnum(12);
  return rng.pick([
    "{}",
    `{"refresh_token":"${token}"}`,
    `{"RefreshToken":"${token}"}`,
    `{"REFRESHTOKEN":"${token}"}`,
    `{"refreshtoken":"${token}"}`,
    `{"token":"${token}"}`,
    `{"session":{"refreshToken":"${token}"}}`,
    `{"refreshToken ":"${token}"}`,
    `{" refreshToken":"${token}"}`,
    `{"refreshToken\\u0000":"${token}"}`,
    `{"grant_type":"refresh_token","refresh_token":"${token}"}`,
  ]);
}

function protoKeyJson(rng: Rng): string {
  const token = rng.alnum(12);
  return rng.pick([
    `{"__proto__":{"refreshToken":"${token}"}}`,
    `{"constructor":{"prototype":{"refreshToken":"${token}"}}}`,
    `{"__proto__":{"refreshToken":"${token}"},"toString":"${token}"}`,
    `{"prototype":{"refreshToken":"${token}"}}`,
  ]);
}

function upstreamPlan(rng: Rng): UpstreamPlan {
  const access = `access-${rng.alnum(24)}`;
  const refresh = `rotated-${rng.alnum(24)}`;
  return rng.weighted<UpstreamPlan>([
    [
      40,
      {
        kind: "ok",
        accessToken: access,
        refreshToken: refresh,
        expiresIn: rng.chance(0.85) ? rng.range(60, 7200) : null,
      },
    ],
    [
      12,
      {
        kind: "refused",
        status: rng.pick([400, 401, 403] as const),
        body: rng.pick([
          `{"error":"invalid_grant","error_description":"Invalid Refresh Token: Refresh Token Not Found"}`,
          `{"code":400,"error_code":"refresh_token_not_found","msg":"Invalid Refresh Token: Refresh Token Not Found"}`,
          `{"code":403,"error_code":"user_banned","msg":"User is banned"}`,
          `{"msg":"invalid JWT"}`,
          `not json at all`,
          ``,
        ]),
      },
    ],
    [
      6,
      {
        kind: "http_429",
        retryAfter: rng.pick([null, "1", "7", "60", "0", "-3", "abc", "1.5", " 9 ", "999999"]),
      },
    ],
    [
      8,
      {
        kind: "http_5xx",
        status: rng.pick([500, 502, 503, 504, 599]),
        body: rng.pick([
          `<html><body>502 Bad Gateway</body></html>`,
          `{"code":500,"msg":"internal"}`,
          `Error: boom\n    at handler (file:///gotrue/index.ts:10:5)`,
          ``,
        ]),
      },
    ],
    [
      4,
      {
        kind: "http_other",
        status: rng.pick([301, 302, 304, 404, 405, 409, 418, 422, 451]),
        body: rng.pick([`{"msg":"weird"}`, `redirect`, ``]),
      },
    ],
    [
      8,
      {
        kind: "malformed_2xx",
        status: rng.pick([200, 201, 204]),
        body: rng.pick([
          ``,
          `{}`,
          `[]`,
          `null`,
          `<html>ok</html>`,
          `{"access_token":"${access}"}`,
          `{"access_token":"${access}","refresh_token":"${refresh}"}`,
          `{"access_token":"${access}","refresh_token":"${refresh}","user":{}}`,
          `{"access_token":"","refresh_token":"${refresh}","user":{"id":"u"}}`,
          `{"access_token":"${access}","refresh_token":"","user":{"id":"u"}}`,
          `{"access_token":"${access}","refresh_token":"${refresh}","expires_in":0,"user":{"id":"u"}}`,
          `{"access_token":"${access}","refresh_token":"${refresh}","expires_in":-5,"user":{"id":"u"}}`,
          `{"access_token":"${access}","refresh_token":"${refresh}","expires_in":"3600","user":{"id":"u"}}`,
          `{"access_token":"${access}","refresh_token":"${refresh}","expires_at":1,"user":{"id":"u"}}`,
          `{"access_token":"${access}","refresh_token":"${refresh}","expires_at":"soon","user":{"id":"u"}}`,
          `{"access_token":"${access}","refresh_token":"${refresh}","user":{"id":""}}`,
          `{"access_token":"${access}","refresh_token":"${refresh}","user":{"id":42}}`,
          `{"access_token":"${"x".repeat(2_000)}`, // truncated JSON
        ]),
      },
    ],
    [4, { kind: "net_fail_once", accessToken: access, refreshToken: refresh }],
    [1, { kind: "net_fail_persistent" }],
    [1, { kind: "hang" }],
  ]);
}

function generateSpec(seed: number): RequestSpec {
  const rng = new Rng(seed);

  const method = rng.weighted<string>([
    [88, "POST"],
    [3, "GET"],
    [2, "PUT"],
    [2, "PATCH"],
    [2, "DELETE"],
    [1, "OPTIONS"],
    [1, "HEAD"],
    [1, "post"], // Request normalises to POST
    [1, "BREW"],
  ]);

  const path = rng.weighted<string>([
    [78, rng.pick(CANONICAL_PATHS)],
    [16, rng.pick(NEAR_MISS_PATHS)],
    [6, rng.pick(ODD_BUT_MATCHING_PATHS)],
  ]);

  const query = rng.weightedLazy<string>([
    [60, () => ""],
    [8, () => "?grant_type=refresh_token"],
    [6, () => `?refreshToken=${rng.alnum(16)}`],
    [6, () => `?${rng.alnum(rng.range(1, 40))}=${rng.alnum(rng.range(0, 40))}`],
    [5, () => `?a=%ZZ&b=%00&c=${encodeURIComponent("日本 🥒")}`],
    [5, () => `?${"x=1&".repeat(rng.range(50, 400))}`],
    [5, () => `?${rng.alnum(rng.range(2_000, 8_000))}`],
    [3, () => "?"],
    [2, () => "?#frag"],
  ]);

  // Client address: unique-per-seed (fresh) vs. a deliberately shared hot IP.
  let ipClass: IpClass = "fresh";
  const ipHeader: Record<string, string> = {};
  const freshIp = ipFor(rng);
  const ipShape = rng.weighted<string>([
    [78, "xff"],
    [8, "hot"],
    [4, "xff_multi"],
    [3, "cf"],
    [3, "xff_garbage"],
    [2, "none"],
    [2, "xff_ipv6"],
  ]);
  switch (ipShape) {
    case "xff":
      ipHeader["x-forwarded-for"] = freshIp;
      break;
    case "hot":
      ipHeader["x-forwarded-for"] = rng.pick(HOT_IPS);
      ipClass = "hot";
      break;
    case "xff_multi":
      ipHeader["x-forwarded-for"] = `${rng.pick(HOT_IPS)}, 192.0.2.${rng.int(256)} ,${freshIp}`;
      break;
    case "cf":
      ipHeader["cf-connecting-ip"] = freshIp;
      ipHeader["x-forwarded-for"] = rng.pick(HOT_IPS);
      break;
    case "xff_garbage":
      ipHeader["x-forwarded-for"] = rng.pick([" , , ", "", "not-an-ip", "\t", ",,,"]);
      ipClass = "hot"; // collapses to "unknown" / one shared bucket
      break;
    case "none":
      ipClass = "hot"; // "unknown"
      break;
    case "xff_ipv6":
      ipHeader["x-forwarded-for"] = `2001:db8::${rng.alnum(4, "0123456789abcdef")}:${rng.alnum(
        4,
        "0123456789abcdef",
      )}`;
      break;
  }

  const contentType = rng.weighted<string | null>([
    [60, "application/json"],
    [10, null],
    [6, "application/json; charset=utf-8"],
    [5, "text/plain"],
    [5, "application/x-www-form-urlencoded"],
    [4, "multipart/form-data; boundary=----x"],
    [3, "application/json; charset=utf-16"],
    [3, "application/octet-stream"],
    [2, "APPLICATION/JSON"],
    [2, rng.alnum(rng.range(1, 60), "abc/;= -")],
  ]);

  const requestId = rng.weighted<string | null>([
    [40, null],
    [
      25,
      rng.alnum(
        rng.range(8, 64),
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-",
      ),
    ],
    [5, rng.alnum(rng.range(1, 7))],
    [5, rng.alnum(rng.range(65, 300))],
    [4, `  ${rng.alnum(16)}  `], // trimmed → honoured
    [4, `${rng.alnum(8)} ${rng.alnum(8)}`],
    [4, ""],
    [3, `../../${rng.alnum(8)}`],
    [3, `${rng.alnum(8)}\u00e9`], // latin-1 byte, allowed in a header, not in the id
    [3, `<${rng.alnum(10)}>`],
    [2, `${rng.alnum(8)}\u0000`.replace("\u0000", "%00")],
    [2, "x".repeat(64)],
    [2, "x".repeat(65)],
  ]);

  const authorization = rng.weightedLazy<string | null>([
    [84, () => null],
    [5, () => `Bearer ${rng.alnum(rng.range(1, 200))}`],
    [4, () => `Bearer ${googleIdToken(4_102_444_800 + rng.int(1_000_000))}`],
    [3, () => rng.alnum(rng.range(1, 40))],
    [2, () => "Bearer "],
    [2, () => `Basic ${rng.alnum(20)}`],
  ]);

  let bodyKind = rng.weighted<BodyKind>([
    [40, "valid"],
    [5, "valid_extra_keys"],
    [3, "valid_duplicate_key"],
    [2, "valid_bom_prefixed"],
    [6, "invalid_token_type"],
    [6, "blank_token"],
    [6, "missing_key"],
    [3, "proto_key"],
    [5, "non_object"],
    [8, "malformed"],
    [2, "invalid_utf8"],
    [2, "deep_nesting"],
    [3, "form_encoded"],
    [3, "empty"],
    [4, "no_body"],
    [1, "at_cap"],
    [1, "over_cap_stream"],
  ]);

  let bodyText: string | null = null;
  let bodyBytes: Uint8Array<ArrayBuffer> | null = null;
  let streamBytes = 0;
  let effectiveToken: string | null = null;
  let rawToken: string | null = null;
  const withToken = (json: (encodedToken: string) => string) => {
    rawToken = tokenText(rng);
    effectiveToken = rawToken.trim() || null;
    bodyText = json(JSON.stringify(rawToken));
  };
  switch (bodyKind) {
    case "valid":
      withToken((t) => `{"refreshToken":${t}}`);
      break;
    case "valid_extra_keys":
      withToken(
        (t) =>
          `{"grant_type":"refresh_token","refreshToken":${t},"extra":{"deep":[1,2,{"x":null}]},"n":${rng.int(
            1e6,
          )}}`,
      );
      break;
    case "valid_duplicate_key":
      // JSON.parse keeps the LAST duplicate — the oracle expects that one.
      withToken((t) => `{"refreshToken":"${rng.alnum(12)}","refreshToken":${t}}`);
      break;
    case "valid_bom_prefixed":
      // A single leading UTF-8 BOM is stripped by TextDecoder (ignoreBOM=false),
      // so the handler sees plain JSON and the token IS used.
      withToken((t) => `\ufeff{"refreshToken":${t}}`);
      break;
    case "invalid_token_type":
      bodyText = `{"refreshToken":${invalidTokenValue(rng)}}`;
      break;
    case "blank_token":
      bodyText = `{"refreshToken":${blankTokenValue(rng)}}`;
      break;
    case "missing_key":
      bodyText = missingKeyJson(rng);
      break;
    case "proto_key":
      bodyText = protoKeyJson(rng);
      break;
    case "non_object":
      bodyText = nonObjectJson(rng);
      break;
    case "malformed":
      bodyText = malformedJson(rng);
      break;
    case "invalid_utf8": {
      const prefix = new TextEncoder().encode(`{"refreshToken":"`);
      const junk = new Uint8Array(rng.range(1, 64));
      for (let i = 0; i < junk.length; i += 1)
        junk[i] = rng.pick([0xff, 0xfe, 0xc0, 0x80, 0xed, 0xa0]);
      const suffix = new TextEncoder().encode(`"}`);
      bodyBytes = new Uint8Array(prefix.length + junk.length + suffix.length);
      bodyBytes.set(prefix, 0);
      bodyBytes.set(junk, prefix.length);
      bodyBytes.set(suffix, prefix.length + junk.length);
      bodyText = new TextDecoder().decode(bodyBytes);
      // Replacement characters make a syntactically VALID string → GoTrue is
      // consulted with the decoded (U+FFFD) token, exactly as the handler sees it.
      rawToken = bodyText.slice(`{"refreshToken":"`.length, -2);
      effectiveToken = rawToken.trim() || null;
      break;
    }
    case "deep_nesting": {
      const depth = rng.pick([1_000, 10_000, 100_000]);
      const open = rng.pick(["[", '{"a":']);
      const close = open === "[" ? "]" : "}";
      bodyText = `{"refreshToken":${open.repeat(depth)}1${close.repeat(depth)}}`;
      break;
    }
    case "form_encoded":
      bodyText = `refreshToken=${rng.alnum(24)}&grant_type=refresh_token`;
      break;
    case "empty":
      bodyText = "";
      break;
    case "no_body":
      bodyText = null;
      break;
    case "at_cap": {
      // Exactly MAX_JSON_BODY_BYTES on the wire (must NOT be 413) or one byte over.
      rawToken = rng.alnum(32);
      const over = rng.chance(0.5);
      const skeleton = `{"refreshToken":"${rawToken}","pad":""}`;
      const padLength = MAX_JSON_BODY_BYTES - skeleton.length + (over ? 1 : 0);
      bodyText = `{"refreshToken":"${rawToken}","pad":"${"p".repeat(padLength)}"}`;
      if (over) {
        streamBytes = bodyText.length;
        bodyKind = "over_cap_stream";
        bodyText = null;
        rawToken = null;
      } else {
        effectiveToken = rawToken;
      }
      break;
    }
    case "over_cap_stream":
      streamBytes = MAX_JSON_BODY_BYTES + rng.pick([1, 2, 1_000, 65_536]);
      break;
  }

  const contentLength = rng.weighted<string | null>([
    [88, null],
    [3, String(MAX_JSON_BODY_BYTES + rng.range(1, 1_000_000))],
    [1, String(MAX_JSON_BODY_BYTES)],
    [1, "1e7"], // Number("1e7") = 10 000 000 → 413 (Number(), not parseInt)
    [1, "0x4C4B41"], // 5 000 001 in hex → 413
    [1, " 5000001"],
    [1, "-1"],
    [1, "NaN"],
    [1, "Infinity"],
    [1, "5"], // lies about a longer real body — advisory only
    [1, "9".repeat(400)],
  ]);

  return {
    seed,
    method,
    path,
    query,
    ipHeader,
    ipClass,
    contentType,
    contentLength,
    requestId,
    authorization,
    bodyKind,
    bodyText,
    bodyBytes,
    streamBytes,
    effectiveToken,
    rawToken,
    upstream: upstreamPlan(rng),
  };
}

// ── oracle ──────────────────────────────────────────────────────────────────

type ExpectedClass =
  | { kind: "413" }
  | { kind: "route_miss" } // 401 (no/garbage bearer) or 404 (valid bearer)
  | { kind: "400_validation" }
  | { kind: "200" }
  | { kind: "401_refused" }
  | { kind: "503"; retryAfter: number };

function declaredTooLarge(spec: RequestSpec): boolean {
  const declared = Number(spec.contentLength ?? "0");
  return Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES;
}

function routeMatches(spec: RequestSpec): boolean {
  const normalizedMethod = /^post$/i.test(spec.method); // Request upper-cases POST
  const pathname = new URL(`http://edge.test${spec.path}${spec.query}`).pathname;
  const v1 = pathname.lastIndexOf("/v1/");
  const routed = v1 >= 0 ? pathname.slice(v1) : pathname;
  return normalizedMethod && routed === "/v1/auth/refresh";
}

function expectedRetryAfter(plan: UpstreamPlan): number {
  if (plan.kind === "http_429") {
    const seconds = Number(plan.retryAfter);
    return Number.isInteger(seconds) && seconds > 0 ? seconds : AUTH_RETRY_AFTER_SECONDS;
  }
  return AUTH_RETRY_AFTER_SECONDS;
}

function expectedClass(spec: RequestSpec): ExpectedClass {
  if (declaredTooLarge(spec)) return { kind: "413" };
  if (!routeMatches(spec)) return { kind: "route_miss" };
  if (spec.bodyKind === "over_cap_stream") return { kind: "413" };
  if (spec.effectiveToken === null) return { kind: "400_validation" };
  switch (spec.upstream.kind) {
    case "ok":
    case "net_fail_once":
      return { kind: "200" };
    case "refused":
      return { kind: "401_refused" };
    default:
      return { kind: "503", retryAfter: expectedRetryAfter(spec.upstream) };
  }
}

/** GoTrue must be consulted at least once for these classes, never otherwise. */
function upstreamExpected(cls: ExpectedClass): boolean {
  return cls.kind === "200" || cls.kind === "401_refused" || cls.kind === "503";
}

// ── stubbed GoTrue for grant_type=refresh_token ─────────────────────────────

interface UpstreamCall {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

interface Upstream {
  calls: UpstreamCall[];
  plan: UpstreamPlan;
}

function abortError(): Error {
  const error = new Error("The signal has been aborted");
  error.name = "AbortError";
  return error;
}

function connectionError(): Error {
  return new TypeError(
    "error sending request for url (http://supabase.test/auth/v1/token): connection reset",
  );
}

function installUpstream(harness: Harness, upstream: Upstream): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const marker = `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`;
    if (!request.url.startsWith(marker)) return previous(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    const text = await request.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep the raw text
    }
    upstream.calls.push({ url: request.url, body, headers });
    harness.calls.push({ url: request.url, method: request.method, headers, body });
    const attempt = upstream.calls.length;
    const plan = upstream.plan;
    const signal = init?.signal ?? request.signal;
    const jsonResponse = (status: number, payload: string, extra: Record<string, string> = {}) =>
      new Response(status === 204 || status === 205 || status === 304 ? null : payload, {
        status,
        headers: { "Content-Type": "application/json", ...extra },
      });
    const session = (accessToken: string, refreshToken: string, expiresIn: number | null) =>
      JSON.stringify({
        access_token: accessToken,
        token_type: "bearer",
        ...(expiresIn === null
          ? {}
          : { expires_in: expiresIn, expires_at: Math.floor(Date.now() / 1000) + expiresIn }),
        refresh_token: refreshToken,
        user: { id: "11111111-1111-4111-8111-111111111111", email: "user@example.com" },
      });
    switch (plan.kind) {
      case "ok":
        return jsonResponse(200, session(plan.accessToken, plan.refreshToken, plan.expiresIn));
      case "refused":
        return jsonResponse(plan.status, plan.body);
      case "http_429":
        return jsonResponse(
          429,
          `{"code":429,"error_code":"over_request_rate_limit","msg":"Request rate limit reached"}`,
          plan.retryAfter === null ? {} : { "Retry-After": plan.retryAfter },
        );
      case "http_5xx":
      case "http_other":
      case "malformed_2xx":
        return jsonResponse(plan.status, plan.body);
      case "net_fail_once":
        if (attempt === 1) throw connectionError();
        return jsonResponse(200, session(plan.accessToken, plan.refreshToken, 3600));
      case "net_fail_persistent":
        throw connectionError();
      case "hang":
        return new Promise<Response>((_, reject) => {
          if (signal.aborted) {
            reject(abortError());
            return;
          }
          signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
    }
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

// ── one iteration ───────────────────────────────────────────────────────────

interface Observed {
  status: number;
  code: string | null;
  message: string | null;
  bodyText: string;
  requestId: string | null;
  retryAfter: string | null;
  contentType: string | null;
  rateLimitHeaders: boolean;
  upstreamCalls: number;
  restCalls: number;
  restWrites: number;
  rcCalls: number;
  accessLogLines: number;
  accessLog: Record<string, unknown> | null;
  consoleLines: number;
  durationMs: number;
}

interface IterationRow {
  index: number;
  seed: number;
  spec: {
    method: string;
    path: string;
    query: string;
    ipClass: IpClass;
    ipHeader: Record<string, string>;
    contentType: string | null;
    contentLength: string | null;
    requestId: string | null;
    authorization: string | null;
    bodyKind: BodyKind;
    bodyBytes: number;
    bodyPreview: string;
    upstream: string;
  };
  expected: ExpectedClass;
  observed: Observed;
  verdict: "HELD" | "BROKEN";
  violations: string[];
}

function buildRequest(spec: RequestSpec): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(spec.ipHeader)) headers.set(k, v);
  if (spec.contentType !== null) headers.set("Content-Type", spec.contentType);
  if (spec.contentLength !== null) headers.set("Content-Length", spec.contentLength);
  if (spec.requestId !== null) headers.set("x-request-id", spec.requestId);
  if (spec.authorization !== null) headers.set("Authorization", spec.authorization);

  const canCarryBody = !/^(GET|HEAD)$/i.test(spec.method);
  let body: BodyInit | null = null;
  if (canCarryBody) {
    if (spec.bodyKind === "over_cap_stream") {
      const total = spec.streamBytes;
      let sent = 0;
      const chunk = new Uint8Array(65_536).fill(0x70); // 'p'
      body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= total) {
            controller.close();
            return;
          }
          const n = Math.min(chunk.length, total - sent);
          controller.enqueue(n === chunk.length ? chunk : chunk.subarray(0, n));
          sent += n;
        },
      });
    } else if (spec.bodyBytes !== null) {
      body = spec.bodyBytes;
    } else if (spec.bodyText !== null) {
      body = spec.bodyText;
    }
  }
  return new Request(`http://edge.test${spec.path}${spec.query}`, {
    method: spec.method,
    headers,
    body,
  });
}

function previewOf(spec: RequestSpec): string {
  const text =
    spec.bodyKind === "over_cap_stream" ? `<stream ${spec.streamBytes} bytes>` : spec.bodyText;
  if (text === null) return "<no body>";
  return text.length > 120 ? `${text.slice(0, 117)}…(${text.length} chars)` : text;
}

function bodyByteLength(spec: RequestSpec): number {
  if (spec.bodyKind === "over_cap_stream") return spec.streamBytes;
  if (spec.bodyBytes) return spec.bodyBytes.byteLength;
  if (spec.bodyText === null) return 0;
  return new TextEncoder().encode(spec.bodyText).byteLength;
}

async function runSpec(harness: Harness, index: number, spec: RequestSpec): Promise<IterationRow> {
  const seed = spec.seed;
  const expected = expectedClass(spec);
  harness.reset();
  const upstream: Upstream = { calls: [], plan: spec.upstream };
  const restoreFetch = installUpstream(harness, upstream);
  const accessLines: string[] = [];
  const restoreAccessLog = captureAccessLog((line) => accessLines.push(line));
  const consoleLines: string[] = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args: unknown[]) => consoleLines.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => consoleLines.push(args.map(String).join(" "));

  let response: Response;
  const startedAt = performance.now();
  try {
    response = await harness.handler(buildRequest(spec));
  } finally {
    console.error = realError;
    console.warn = realWarn;
    restoreAccessLog();
    restoreFetch();
  }
  const durationMs = performance.now() - startedAt;

  const bodyText = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // non-JSON body — asserted below
  }
  const errorObj =
    parsed && typeof parsed === "object" && "error" in parsed
      ? (parsed as { error: unknown }).error
      : null;
  const errorRecord =
    errorObj && typeof errorObj === "object" ? (errorObj as Record<string, unknown>) : null;

  const restCalls = harness.callsTo(`${SUPABASE_URL}/rest/v1/`);
  const observed: Observed = {
    status: response.status,
    code: typeof errorRecord?.code === "string" ? errorRecord.code : null,
    message: typeof errorRecord?.message === "string" ? errorRecord.message : null,
    bodyText,
    requestId: response.headers.get("x-request-id"),
    retryAfter: response.headers.get("Retry-After"),
    contentType: response.headers.get("content-type"),
    rateLimitHeaders:
      response.headers.has("RateLimit-Limit") && response.headers.has("RateLimit-Remaining"),
    upstreamCalls: upstream.calls.length,
    restCalls: restCalls.length,
    restWrites: restCalls.filter((c) => c.method !== "GET").length,
    rcCalls: harness.callsTo("api.revenuecat.com").length,
    accessLogLines: accessLines.length,
    accessLog:
      accessLines.length === 1 ? (JSON.parse(accessLines[0]) as Record<string, unknown>) : null,
    consoleLines: consoleLines.length,
    durationMs: Math.round(durationMs * 100) / 100,
  };

  const violations: string[] = [];
  const fail = (what: string) => violations.push(what);

  // ── status oracle
  const status = response.status;
  const rateLimited = status === 429;
  // The declared-length 413 precedes every limiter; everything else (including
  // the streamed 413) sits behind the per-IP budgets, so a shared IP may 429.
  const rateLimitAllowed = spec.ipClass === "hot" && !declaredTooLarge(spec);
  if (rateLimited && !rateLimitAllowed) fail(`429 on a fresh IP (expected ${expected.kind})`);
  if (!(rateLimited && rateLimitAllowed)) {
    switch (expected.kind) {
      case "413":
        if (status !== 413) fail(`expected 413, got ${status}`);
        break;
      case "route_miss":
        if (status !== 401 && status !== 404) fail(`route miss: expected 401/404, got ${status}`);
        break;
      case "400_validation":
        if (status !== 400) fail(`expected 400 validation, got ${status}`);
        else if (observed.code !== "validation.refresh")
          fail(`400 without code validation.refresh (${observed.code})`);
        break;
      case "200":
        if (status !== 200) fail(`expected 200, got ${status}`);
        break;
      case "401_refused":
        if (status !== 401) fail(`expected 401 (GoTrue refused), got ${status}`);
        break;
      case "503":
        if (status !== 503) fail(`expected 503 (GoTrue ${spec.upstream.kind}), got ${status}`);
        else if (observed.retryAfter !== String(expected.retryAfter)) {
          fail(`503 Retry-After ${observed.retryAfter} ≠ ${expected.retryAfter}`);
        }
        break;
    }
  }
  if (status >= 500 && expected.kind !== "503")
    fail(`5xx (${status}) without an upstream outage plan`);
  if (status !== 200 && status !== 503 && !BAD_INPUT_STATUSES.has(status)) {
    fail(`status ${status} outside the allowed bad-input set`);
  }

  // ── body shape / leak checks (every non-200)
  if (status !== 200) {
    if (!(observed.contentType ?? "").includes("application/json"))
      fail(`error content-type ${observed.contentType}`);
    if (!errorRecord || typeof errorRecord.message !== "string")
      fail(`error body is not {error:{message}}: ${bodyText.slice(0, 80)}`);
    if (status >= 500 && !GENERIC_5XX_MESSAGES.has(observed.message ?? ""))
      fail(`non-generic 5xx message: ${observed.message}`);
    if (status === 429) {
      if (observed.code !== "rate_limited") fail(`429 without code rate_limited`);
      if (!observed.retryAfter || !observed.rateLimitHeaders)
        fail(`429 without Retry-After/RateLimit-* headers`);
    }
  }
  for (const marker of LEAK_MARKERS) {
    if (marker.test(bodyText)) fail(`body matches leak marker ${marker}`);
  }
  if (spec.rawToken !== null && spec.rawToken.trim().length >= 8) {
    const needle = spec.rawToken.trim();
    if (bodyText.includes(needle)) fail(`response body echoes the client refresh token`);
    if (consoleLines.some((line) => line.includes(needle)))
      fail(`handler log echoes the client refresh token`);
    if (accessLines.some((line) => line.includes(needle)))
      fail(`access log echoes the client refresh token`);
  }

  // ── 200 shape
  if (status === 200) {
    const session =
      parsed && typeof parsed === "object" && "session" in parsed
        ? ((parsed as { session: unknown }).session as Record<string, unknown> | null)
        : null;
    const plan = spec.upstream;
    if (!session || typeof session !== "object") fail(`200 without session`);
    else if (plan.kind === "ok" || plan.kind === "net_fail_once") {
      if (session.accessToken !== plan.accessToken) fail(`200 accessToken ≠ stub`);
      if (session.refreshToken !== plan.refreshToken) fail(`200 refreshToken ≠ stub`);
      const expiresAt = session.expiresAt;
      if (typeof expiresAt !== "number" || !(expiresAt * 1000 > Date.now()))
        fail(`200 expiresAt not in the future`);
      if (Object.keys(session).sort().join(",") !== "accessToken,expiresAt,refreshToken") {
        fail(`200 session has unexpected keys: ${Object.keys(session).join(",")}`);
      }
    }
  }

  // ── request id + access log
  if (!observed.requestId) fail(`missing x-request-id`);
  else {
    const incoming = (spec.requestId ?? "").trim();
    if (REQUEST_ID_RE.test(incoming)) {
      if (observed.requestId !== incoming) fail(`well-formed client request id not echoed`);
    } else if (!UUID_RE.test(observed.requestId)) {
      fail(`minted request id is not a UUID v4: ${observed.requestId}`);
    }
  }
  if (accessLines.length !== 1) fail(`expected 1 access-log line, got ${accessLines.length}`);
  else {
    const entry = observed.accessLog!;
    if (entry.evt !== "api_request") fail(`access log evt ${entry.evt}`);
    if (entry.requestId !== observed.requestId) fail(`access log requestId ≠ header`);
    if (entry.status !== status) fail(`access log status ${entry.status} ≠ ${status}`);
    if (typeof entry.route !== "string" || (entry.route as string).includes("?"))
      fail(`access log route carries a query`);
    for (const ip of Object.values(spec.ipHeader)) {
      if (ip.length >= 7 && accessLines[0].includes(ip)) fail(`access log carries the client IP`);
    }
    if (observed.code && entry.code !== observed.code)
      fail(`access log code ${entry.code} ≠ ${observed.code}`);
  }

  // ── no writes / no upstream on rejection
  if (observed.restCalls !== 0) fail(`route touched PostgREST ${observed.restCalls}×`);
  if (observed.rcCalls !== 0) fail(`route touched RevenueCat ${observed.rcCalls}×`);
  const shouldCallUpstream = upstreamExpected(expected) && !(rateLimited && rateLimitAllowed);
  if (!shouldCallUpstream && observed.upstreamCalls !== 0) {
    fail(
      `GoTrue consulted ${observed.upstreamCalls}× on a rejected request (${expected.kind}/${status})`,
    );
  }
  if (shouldCallUpstream) {
    if (observed.upstreamCalls === 0) fail(`GoTrue never consulted (${expected.kind})`);
    for (const call of upstream.calls) {
      const body = call.body as Record<string, unknown> | null;
      if (!body || body.refresh_token !== spec.effectiveToken)
        fail(`GoTrue received refresh_token ≠ trimmed client token`);
      if (call.headers.apikey !== "anon-test-key") fail(`GoTrue call without anon apikey`);
      if (call.headers.authorization) fail(`GoTrue refresh call carries an Authorization header`);
    }
    const plan = spec.upstream;
    const maxCalls =
      plan.kind === "net_fail_once" ? 2 : plan.kind === "net_fail_persistent" ? 6 : 1;
    const minCalls = plan.kind === "net_fail_once" ? 2 : 1;
    if (observed.upstreamCalls > maxCalls || observed.upstreamCalls < minCalls) {
      fail(
        `GoTrue called ${observed.upstreamCalls}× for plan ${plan.kind} (expected ${minCalls}..${maxCalls})`,
      );
    }
  }
  // Any 401 that is NOT a GoTrue refusal on the matched route must be a route
  // miss (missing/garbage bearer), never the refresh route inventing a refusal.
  if (status === 401 && expected.kind !== "401_refused" && expected.kind !== "route_miss") {
    fail(`401 without a GoTrue refusal`);
  }

  return {
    index,
    seed,
    spec: {
      method: spec.method,
      path: spec.path,
      query:
        spec.query.length > 80 ? `${spec.query.slice(0, 77)}…(${spec.query.length})` : spec.query,
      ipClass: spec.ipClass,
      ipHeader: spec.ipHeader,
      contentType: spec.contentType,
      contentLength: spec.contentLength,
      requestId:
        spec.requestId !== null && spec.requestId.length > 80
          ? `${spec.requestId.slice(0, 77)}…(${spec.requestId.length})`
          : spec.requestId,
      authorization:
        spec.authorization === null
          ? null
          : spec.authorization.startsWith(`Bearer ${GOOGLE_ID_TOKEN_PREFIX}.`)
            ? "Bearer <fake google id token>"
            : `${spec.authorization.slice(0, 24)}…`,
      bodyKind: spec.bodyKind,
      bodyBytes: bodyByteLength(spec),
      bodyPreview: previewOf(spec),
      upstream:
        spec.upstream.kind === "refused"
          ? `refused_${spec.upstream.status}`
          : spec.upstream.kind === "http_5xx" ||
              spec.upstream.kind === "http_other" ||
              spec.upstream.kind === "malformed_2xx"
            ? `${spec.upstream.kind}_${spec.upstream.status}`
            : spec.upstream.kind,
    },
    expected,
    observed: {
      ...observed,
      bodyText: bodyText.length > 300 ? `${bodyText.slice(0, 297)}…` : bodyText,
    },
    verdict: violations.length === 0 ? "HELD" : "BROKEN",
    violations,
  };
}

// ── minimisation: reset spec dimensions to a benign baseline one at a time ──

type Mutation = (spec: RequestSpec) => RequestSpec;

let minimizeIpCounter = 0;
/** A never-before-used address, so minimisation itself cannot trip a limiter. */
function nextMinimizeIp(): string {
  minimizeIpCounter += 1;
  return `172.16.${Math.floor(minimizeIpCounter / 256) % 256}.${minimizeIpCounter % 256}`;
}

const BENIGN: readonly (readonly [string, Mutation])[] = [
  [
    "ip=fresh",
    (s) => ({ ...s, ipHeader: { "x-forwarded-for": nextMinimizeIp() }, ipClass: "fresh" }),
  ],
  ["method=POST", (s) => ({ ...s, method: "POST" })],
  ["path=/v1/auth/refresh", (s) => ({ ...s, path: "/v1/auth/refresh" })],
  ["query=''", (s) => ({ ...s, query: "" })],
  ["content-type=json", (s) => ({ ...s, contentType: "application/json" })],
  ["content-length=auto", (s) => ({ ...s, contentLength: null })],
  ["request-id=none", (s) => ({ ...s, requestId: null })],
  ["authorization=none", (s) => ({ ...s, authorization: null })],
  [
    "upstream=ok",
    (s) => ({
      ...s,
      upstream: { kind: "ok", accessToken: "a", refreshToken: "r", expiresIn: 3600 },
    }),
  ],
  [
    "body=valid",
    (s) => ({
      ...s,
      bodyKind: "valid",
      bodyText: `{"refreshToken":"minimized-token-000"}`,
      bodyBytes: null,
      streamBytes: 0,
      rawToken: "minimized-token-000",
      effectiveToken: "minimized-token-000",
    }),
  ],
];

async function reproduces(harness: Harness, spec: RequestSpec): Promise<string[]> {
  return (await runSpec(harness, -1, spec)).violations;
}

/** Greedy one-pass delta debugging over the spec's dimensions: a dimension is
 * dropped (reset to a benign value) when the ORIGINAL violation still
 * reproduces without it; the dimensions that remain are load-bearing. */
async function minimize(
  harness: Harness,
  seed: number,
  original: string[],
): Promise<{ kept: string[]; violations: string[] }> {
  let spec = generateSpec(seed);
  const kept: string[] = [];
  const sameFailure = (violations: string[]) => violations.some((v) => original.includes(v));
  for (const [label, mutate] of BENIGN) {
    const candidate = mutate(spec);
    if (sameFailure(await reproduces(harness, candidate))) {
      spec = candidate; // still fails without this dimension → drop it
    } else {
      kept.push(label.split("=")[0]); // this dimension is load-bearing
    }
  }
  return { kept, violations: await reproduces(harness, spec) };
}

// ── campaign ────────────────────────────────────────────────────────────────

interface CampaignReport {
  unit: string;
  lens: string;
  campaignSeed: number;
  iterations: number;
  replaySeeds: number[];
  repeat: number;
  upstreamTimeoutMs: number;
  startedAt: string;
  durationMs: number;
  held: number;
  broken: number;
  byStatus: Record<string, number>;
  byExpected: Record<string, number>;
  byBodyKind: Record<string, number>;
  byUpstream: Record<string, number>;
  fiveXx: { seed: number; status: number; upstream: string; verdict: string }[];
  brokenSeeds: {
    seed: number;
    violations: string[];
    minimized: { kept: string[]; violations: string[] };
  }[];
  rows: IterationRow[];
}

function tally(rows: IterationRow[], key: (row: IterationRow) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[key(row)] = (out[key(row)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

Deno.test("stress fuzz-boundary: POST /v1/auth/refresh — seeded request campaign", async () => {
  const harness = await loadHarness();
  const previousTimeout = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(UPSTREAM_TIMEOUT_MS));
  const startedAt = new Date();
  const started = performance.now();
  const rows: IterationRow[] = [];
  try {
    const seeds =
      STRESS_REPLAY.length > 0
        ? STRESS_REPLAY.flatMap((seed) =>
            Array.from({ length: Math.max(1, STRESS_REPEAT) }, () => seed),
          )
        : Array.from({ length: STRESS_ITER }, (_, i) => iterationSeed(STRESS_SEED, i));
    for (let i = 0; i < seeds.length; i += 1) {
      rows.push(await runSpec(harness, i, generateSpec(seeds[i])));
    }
    const broken = rows.filter((row) => row.verdict === "BROKEN");
    const brokenSeeds: CampaignReport["brokenSeeds"] = [];
    for (const seed of new Set(broken.map((row) => row.seed))) {
      const first = broken.find((row) => row.seed === seed)!;
      brokenSeeds.push({
        seed,
        violations: first.violations,
        minimized: await minimize(harness, seed, first.violations),
      });
    }
    const report: CampaignReport = {
      unit: "route-post-v1-auth-refresh",
      lens: "fuzz-boundary",
      campaignSeed: STRESS_SEED,
      iterations: rows.length,
      replaySeeds: STRESS_REPLAY,
      repeat: STRESS_REPEAT,
      upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
      startedAt: startedAt.toISOString(),
      durationMs: Math.round(performance.now() - started),
      held: rows.length - broken.length,
      broken: broken.length,
      byStatus: tally(rows, (r) => String(r.observed.status)),
      byExpected: tally(rows, (r) => r.expected.kind),
      byBodyKind: tally(rows, (r) => r.spec.bodyKind),
      byUpstream: tally(rows, (r) => r.spec.upstream),
      fiveXx: rows
        .filter((r) => r.observed.status >= 500)
        .map((r) => ({
          seed: r.seed,
          status: r.observed.status,
          upstream: r.spec.upstream,
          verdict: r.verdict,
        })),
      brokenSeeds,
      rows,
    };
    if (STRESS_OUT) {
      await Deno.writeTextFile(STRESS_OUT, JSON.stringify(report, null, 2));
    }
    console.error(
      `[stress auth/refresh] seed=${STRESS_SEED} iterations=${rows.length} held=${report.held} broken=${report.broken} ` +
        `statuses=${JSON.stringify(report.byStatus)} durationMs=${report.durationMs}` +
        (STRESS_OUT ? ` out=${STRESS_OUT}` : ""),
    );
    assertEquals(
      broken.length,
      0,
      `BROKEN seeds (replay with STRESS_REPLAY=<seed>): ${brokenSeeds
        .map(
          (b) =>
            `${b.seed} → ${b.violations.join("; ")} [load-bearing: ${b.minimized.kept.join(",")}]`,
        )
        .join(" | ")}`,
    );
    assert(rows.length > 0, "campaign ran zero iterations");
  } finally {
    if (previousTimeout === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
    else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previousTimeout);
  }
});

Deno.test(
  "stress fuzz-boundary: a seed regenerates the identical request spec (replayability)",
  () => {
    for (let i = 0; i < 200; i += 1) {
      const seed = iterationSeed(STRESS_SEED, i);
      const a = generateSpec(seed);
      const b = generateSpec(seed);
      const strip = (s: RequestSpec) => ({
        ...s,
        bodyBytes: s.bodyBytes ? Array.from(s.bodyBytes) : null,
      });
      assertEquals(
        JSON.stringify(strip(a)),
        JSON.stringify(strip(b)),
        `seed ${seed} is not replayable`,
      );
    }
  },
);

Deno.test(
  "stress fuzz-boundary: body-size boundary vectors (exactly at / one over the 5 000 000-byte cap)",
  async () => {
    const harness = await loadHarness();
    const base = generateSpec(1);
    const token = "boundary-token-0000000000000000";
    const skeleton = `{"refreshToken":"${token}","pad":""}`;
    const exact = `{"refreshToken":"${token}","pad":"${"p".repeat(MAX_JSON_BODY_BYTES - skeleton.length)}"}`;
    assertEquals(new TextEncoder().encode(exact).byteLength, MAX_JSON_BODY_BYTES);
    const vectors: { label: string; spec: RequestSpec; status: number; upstreamCalls: number }[] = [
      {
        label: "streamed body of exactly MAX bytes → accepted, GoTrue consulted once",
        spec: {
          ...base,
          method: "POST",
          path: "/v1/auth/refresh",
          query: "",
          ipHeader: { "x-forwarded-for": "10.200.0.1" },
          ipClass: "fresh",
          contentType: "application/json",
          contentLength: null,
          requestId: null,
          authorization: null,
          bodyKind: "at_cap",
          bodyText: exact,
          bodyBytes: null,
          streamBytes: 0,
          rawToken: token,
          effectiveToken: token,
          upstream: { kind: "ok", accessToken: "a", refreshToken: "r", expiresIn: 3600 },
        },
        status: 200,
        upstreamCalls: 1,
      },
      {
        label: "streamed body of MAX+1 bytes (no Content-Length) → 413, GoTrue never consulted",
        spec: {
          ...base,
          method: "POST",
          path: "/v1/auth/refresh",
          query: "",
          ipHeader: { "x-forwarded-for": "10.200.0.2" },
          ipClass: "fresh",
          contentType: "application/json",
          contentLength: null,
          requestId: null,
          authorization: null,
          bodyKind: "over_cap_stream",
          bodyText: null,
          bodyBytes: null,
          streamBytes: MAX_JSON_BODY_BYTES + 1,
          rawToken: null,
          effectiveToken: null,
          upstream: { kind: "ok", accessToken: "a", refreshToken: "r", expiresIn: 3600 },
        },
        status: 413,
        upstreamCalls: 0,
      },
      {
        label: "Content-Length: 5000000 with a tiny real body → accepted",
        spec: {
          ...base,
          method: "POST",
          path: "/v1/auth/refresh",
          query: "",
          ipHeader: { "x-forwarded-for": "10.200.0.3" },
          ipClass: "fresh",
          contentType: "application/json",
          contentLength: String(MAX_JSON_BODY_BYTES),
          requestId: null,
          authorization: null,
          bodyKind: "valid",
          bodyText: `{"refreshToken":"${token}"}`,
          bodyBytes: null,
          streamBytes: 0,
          rawToken: token,
          effectiveToken: token,
          upstream: { kind: "ok", accessToken: "a", refreshToken: "r", expiresIn: 3600 },
        },
        status: 200,
        upstreamCalls: 1,
      },
      {
        label: "Content-Length: 5000001 with a tiny real body → 413 before any work",
        spec: {
          ...base,
          method: "POST",
          path: "/v1/auth/refresh",
          query: "",
          ipHeader: { "x-forwarded-for": "10.200.0.4" },
          ipClass: "fresh",
          contentType: "application/json",
          contentLength: String(MAX_JSON_BODY_BYTES + 1),
          requestId: null,
          authorization: null,
          bodyKind: "valid",
          bodyText: `{"refreshToken":"${token}"}`,
          bodyBytes: null,
          streamBytes: 0,
          rawToken: token,
          effectiveToken: token,
          upstream: { kind: "ok", accessToken: "a", refreshToken: "r", expiresIn: 3600 },
        },
        status: 413,
        upstreamCalls: 0,
      },
    ];
    for (const vector of vectors) {
      const row = await runSpec(harness, -1, vector.spec);
      assertEquals(
        row.observed.status,
        vector.status,
        `${vector.label}: ${JSON.stringify(row.observed)}`,
      );
      assertEquals(row.observed.upstreamCalls, vector.upstreamCalls, vector.label);
      assertEquals(row.violations, [], `${vector.label}: ${row.violations.join("; ")}`);
    }
  },
);
