// Fuzz / boundary stress campaign for `POST /v1/training-plans` against the
// REAL edge handler in-process (routesHarness: Supabase Auth + PostgREST +
// RevenueCat answered by the stubbed fetch, Upstash absent → per-isolate
// in-memory rate limits). Every iteration is derived from ONE integer seed, so
// any recorded outcome replays exactly.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json stress_training_plans_fuzz.test.ts
//
// Environment knobs (all optional):
//   STRESS_ITER=3000      campaign size (default 200 — fast enough for the suite)
//   STRESS_SEED=20260904  first seed of the campaign (iteration i uses STRESS_SEED + i)
//   STRESS_SEEDS=1,2,3    replay exactly these seeds instead of a range
//   STRESS_REPEAT=10      run each seed this many times (flake rate)
//   STRESS_OUT=/path.json write the seed → outcome table (+ summary) as JSON
//
// Oracle (what every generated request must satisfy):
//   - status ∈ {400, 401, 403, 404, 405, 413, 415, 429} for bad input, 409
//     `training.plan_unavailable` for an authenticated well-formed request,
//     503 ONLY when the campaign itself injected a Supabase Auth outage;
//     NEVER 500, never 2xx (the route has no success path yet);
//   - `x-request-id` on every response: a well-formed client id is echoed,
//     anything else is replaced by a fresh UUID (never reflected);
//   - every error body is `{error:{message[,code]}}` JSON with the security
//     headers, no stack frame / file path / exception name / upstream detail,
//     and the bearer never appears in the body or in console output;
//   - NO PostgREST / RevenueCat / Auth-admin call for any request (the route
//     writes nothing, and a rejected request must reach nothing at all);
//   - exactly one access-log line per request carrying the same request id.

import { assert, assertEquals } from "@std/assert";
import { loadHarness, SUPABASE_URL, TEST_USER_ID, type Harness } from "./routesHarness.ts";
import { captureAccessLog } from "../http.ts";

// ── Deterministic PRNG (mulberry32) ─────────────────────────────────────────

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
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  string(length: number, alphabet: string): string {
    let out = "";
    for (let i = 0; i < length; i += 1) out += alphabet[this.int(alphabet.length)];
    return out;
  }
}

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const REQUEST_ID_ALPHABET = `${ALNUM}._-`;
/** Header-value bytes Deno accepts (printable ASCII + tab + Latin-1 high half). */
const HEADER_VALUE_ALPHABET = ` \t!"#$%&'()*+,-./${ALNUM}:;<=>?@[\\]^_\`{|}~\u00a0\u00e9\u00ff`;
const PATH_JUNK_ALPHABET = `${ALNUM}-._~!$&'()*+,;=:@%[]{}|^\`<>"\\ `;

/** RFC 4122 v4-shaped UUID from the seeded stream (never crypto.randomUUID —
 * a case must be a pure function of its seed). */
function rngUuid(rng: Rng): string {
  const hex = rng.string(32, "0123456789abcdef").split("");
  hex[12] = "4";
  hex[16] = "89ab"[rng.int(4)];
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Token expiry: one hour past the current hour, so a seed's bearer is
 * byte-identical for every replay inside the same clock hour. */
const tokenExp = (): number => Math.floor(Date.now() / 3_600_000) * 3_600 + 7_200;

const b64url = (value: string): string =>
  btoa(unescape(encodeURIComponent(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const jwt = (payload: unknown, header: unknown = { alg: "RS256", typ: "JWT" }): string =>
  `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.sig`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Mirrors http.ts REQUEST_ID_RE (the documented request-id contract). */
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const MAX_JSON_BODY_BYTES = 5_000_000;
const TARGET_CODE = "training.plan_unavailable";
const TARGET_MESSAGE =
  "Training plans require coach-validated drill content, which has not been published yet.";

const FORBIDDEN_BODY_FRAGMENTS = [
  "    at ",
  "\n at ",
  "file://",
  "index.ts",
  "http.ts",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "stack",
  "unexpected fetch",
  SUPABASE_URL,
  "PGRST",
  "postgres",
  "supabase-js",
];

// ── Fuzz-case model ─────────────────────────────────────────────────────────

type AuthPlan =
  | { kind: "ok"; label: string; sharedUser: boolean }
  | { kind: "refused"; label: string }
  | { kind: "unavailable"; label: string };

/** How the injected Supabase Auth (`GET /auth/v1/user`) answers a session
 * bearer: encoded in the JWT so the fault needs no shared state. */
type UpstreamMode = "ok" | "refused" | "no-provider" | "http-5xx" | "garbage-2xx" | "throw";

interface FuzzCase {
  seed: number;
  method: string;
  url: string;
  headers: [string, string][];
  body: string | Uint8Array<ArrayBuffer> | null;
  dims: Record<string, string>;
  auth: AuthPlan;
  bearer: string | null;
  sentRequestId: string | null;
  /** The IP bucket is shared with other seeds (empty/missing hops → "unknown"). */
  sharedIp: boolean;
  /** Declared Content-Length as the handler will parse it. */
  declaredLength: number;
  target: boolean;
  /** Normalizes to the read-only sibling `GET /v1/training-plans/current`. */
  sibling: boolean;
}

const uniqueIp = (seed: number): string =>
  `10.${(seed >>> 16) & 255}.${(seed >>> 8) & 255}.${seed & 255}`;

const uniqueSub = (seed: number): string => `fuzz-${seed.toString(36)}`;

function sessionToken(seed: number, mode: UpstreamMode, overrides: Record<string, unknown> = {}) {
  return jwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: uniqueSub(seed),
    aud: "authenticated",
    role: "authenticated",
    session_id: `sess-${seed}`,
    exp: tokenExp(),
    fuzz: mode,
    ...overrides,
  });
}

function providerToken(seed: number, issuer: string, overrides: Record<string, unknown> = {}) {
  return jwt({
    iss: issuer,
    sub: uniqueSub(seed),
    exp: tokenExp(),
    ...overrides,
  });
}

function pickAuth(rng: Rng, seed: number): { auth: AuthPlan; authorization: string | null } {
  const roll = rng.next();
  const past = Math.floor(Date.now() / 1000) - 60;
  // ~45 % valid bearers so the route itself is exercised at scale.
  if (roll < 0.18) {
    return {
      auth: { kind: "ok", label: "google-id-token", sharedUser: false },
      authorization: `Bearer ${providerToken(seed, "https://accounts.google.com")}`,
    };
  }
  if (roll < 0.26) {
    return {
      auth: { kind: "ok", label: "apple-id-token", sharedUser: false },
      authorization: `Bearer ${providerToken(seed, "https://appleid.apple.com")}`,
    };
  }
  if (roll < 0.29) {
    return {
      auth: { kind: "ok", label: "google-bare-issuer", sharedUser: false },
      authorization: `Bearer ${providerToken(seed, "accounts.google.com")}`,
    };
  }
  if (roll < 0.4) {
    return {
      auth: { kind: "ok", label: "session-token", sharedUser: false },
      authorization: `Bearer ${sessionToken(seed, "ok")}`,
    };
  }
  if (roll < 0.42) {
    return {
      auth: { kind: "ok", label: "google-no-sub (stub user)", sharedUser: true },
      authorization: `Bearer ${providerToken(seed, "https://accounts.google.com", { sub: undefined })}`,
    };
  }
  if (roll < 0.44) {
    return {
      auth: { kind: "ok", label: "google-huge-token", sharedUser: false },
      authorization: `Bearer ${providerToken(seed, "https://accounts.google.com", {
        pad: rng.string(rng.range(20_000, 120_000), ALNUM),
      })}`,
    };
  }
  if (roll < 0.46) {
    return {
      auth: { kind: "ok", label: "google-exp-not-a-number", sharedUser: false },
      authorization: `Bearer ${providerToken(seed, "https://accounts.google.com", { exp: "soon" })}`,
    };
  }
  if (roll < 0.48) {
    return {
      auth: { kind: "ok", label: "session-token-padded-authorization", sharedUser: false },
      authorization: `Bearer ${sessionToken(seed, "ok")}   `,
    };
  }
  // Injected upstream faults (the only legitimate 5xx source).
  if (roll < 0.5) {
    return {
      auth: { kind: "unavailable", label: "session-upstream-http-5xx" },
      authorization: `Bearer ${sessionToken(seed, "http-5xx")}`,
    };
  }
  if (roll < 0.515) {
    return {
      auth: { kind: "unavailable", label: "session-upstream-garbage-2xx" },
      authorization: `Bearer ${sessionToken(seed, "garbage-2xx")}`,
    };
  }
  if (roll < 0.53) {
    return {
      auth: { kind: "unavailable", label: "session-upstream-network-throw" },
      authorization: `Bearer ${sessionToken(seed, "throw")}`,
    };
  }
  if (roll < 0.54) {
    // `Bearer Bearer <jwt>`: the edge strips one scheme and routes on the
    // payload segment, so the verdict belongs to Supabase Auth (which refuses
    // the mangled first segment). The stubbed Auth vouches for it — in this
    // harness it is therefore an accepted bearer, never a 5xx.
    return {
      auth: { kind: "ok", label: "double-bearer (stub vouches)", sharedUser: false },
      authorization: `Bearer Bearer ${providerToken(seed, "https://accounts.google.com")}`,
    };
  }
  // Refusals.
  const refusals: Array<[string, string | null]> = [
    ["missing-authorization", null],
    ["empty-bearer", "Bearer "],
    ["bearer-no-space", "Bearer"],
    ["lowercase-scheme", `bearer ${providerToken(seed, "https://accounts.google.com")}`],
    ["basic-scheme", `Basic ${btoa("user:pass")}`],
    ["not-a-jwt", `Bearer ${rng.string(rng.range(1, 80), ALNUM)}`],
    ["two-segments", `Bearer a.${b64url("{}")}`],
    [
      "four-segments",
      `Bearer a.${b64url(JSON.stringify({ iss: "https://accounts.google.com" }))}.c.d`,
    ],
    ["payload-not-base64", "Bearer a.!!!not-base64!!!.c"],
    ["payload-not-json", `Bearer a.${b64url("{not json")}.c`],
    ["payload-json-number", `Bearer a.${b64url("123")}.c`],
    ["payload-json-string", `Bearer a.${b64url('"accounts.google.com"')}.c`],
    ["payload-json-null", `Bearer a.${b64url("null")}.c`],
    ["payload-json-array", `Bearer a.${b64url('["https://accounts.google.com"]')}.c`],
    [
      "iss-object",
      `Bearer ${providerToken(seed, "x", { iss: { toString: "accounts.google.com" } })}`,
    ],
    ["iss-unknown", `Bearer ${providerToken(seed, "https://accounts.example.com")}`],
    ["iss-google-http", `Bearer ${providerToken(seed, "http://accounts.google.com")}`],
    [
      "iss-google-suffix",
      `Bearer ${providerToken(seed, "https://accounts.google.com.evil.example")}`,
    ],
    [
      "iss-google-prefix",
      `Bearer ${providerToken(seed, "https://evil.example/accounts.google.com")}`,
    ],
    ["iss-google-case", `Bearer ${providerToken(seed, "https://Accounts.Google.com")}`],
    ["iss-google-trailing-slash", `Bearer ${providerToken(seed, "https://accounts.google.com/")}`],
    [
      "google-expired",
      `Bearer ${providerToken(seed, "https://accounts.google.com", { exp: past })}`,
    ],
    [
      "google-exp-zero-ish",
      `Bearer ${providerToken(seed, "https://accounts.google.com", { exp: 1 })}`,
    ],
    ["session-expired", `Bearer ${sessionToken(seed, "ok", { exp: past })}`],
    ["session-upstream-refused", `Bearer ${sessionToken(seed, "refused")}`],
    ["session-no-provider", `Bearer ${sessionToken(seed, "no-provider")}`],
    [
      "foreign-issuer-auth-v1-suffix",
      `Bearer ${sessionToken(seed, "refused", { iss: "https://evil.example/auth/v1" })}`,
    ],
    ["empty-iss", `Bearer ${providerToken(seed, "")}`],
    ["control-chars-token", `Bearer ${rng.string(12, ALNUM)}\t${rng.string(12, ALNUM)}`],
    ["latin1-token", `Bearer ${rng.string(8, ALNUM)}\u00e9\u00ff${rng.string(8, ALNUM)}`],
  ];
  const [label, authorization] = rng.pick(refusals);
  return { auth: { kind: "refused", label }, authorization };
}

/** Path variants; `target` is the generator's intent — the oracle decides
 * from the PARSED pathname (last "/v1/" onward), the documented contract. */
function pickPath(rng: Rng, seed: number): { path: string; label: string; target: boolean } {
  const prefixes = ["/functions/v1/api", "/api", "", "/functions/v1/api/", "//functions/v1/api"];
  const prefix = rng.pick(prefixes);
  const id = rngUuid(rng);
  const roll = rng.next();
  if (roll < 0.35) return { path: `${prefix}/v1/training-plans`, label: "canonical", target: true };
  if (roll < 0.4) {
    return {
      path: `${prefix}/v1/training-plans/../training-plans`,
      label: "dot-dot",
      target: true,
    };
  }
  if (roll < 0.43) {
    return {
      path: `${prefix}/v1/training-plans/v1/training-plans`,
      label: "double-v1",
      target: true,
    };
  }
  if (roll < 0.46) {
    return { path: `${prefix}/v1/me/v1/training-plans`, label: "interior-v1", target: true };
  }
  if (roll < 0.49) {
    return { path: `${prefix}/v1/training-\tplans`, label: "tab-stripped-by-url", target: true };
  }
  if (roll < 0.51) {
    return { path: `${prefix}\\v1\\training-plans`, label: "backslashes", target: true };
  }
  const others: Array<[string, string]> = [
    [`${prefix}/v1/training-plans/`, "trailing-slash"],
    [`${prefix}/v1//training-plans`, "double-slash"],
    [`${prefix}/v1/training-plans/${id}`, "extra-uuid-segment"],
    [`${prefix}/v1/training-plans/current`, "current-suffix"],
    [`${prefix}/v1/training-plans/${id}/reassess`, "nested-unknown"],
    [`${prefix}/V1/training-plans`, "uppercase-v1"],
    [`${prefix}/v1/Training-Plans`, "uppercase-resource"],
    [`${prefix}/v1/training-plan`, "singular"],
    [`${prefix}/v1/training%2Dplans`, "encoded-hyphen"],
    [`${prefix}/v1/training-plans%2F`, "encoded-trailing-slash"],
    [`${prefix}/v1/training-plans%00`, "encoded-nul"],
    [`${prefix}/v1/training-plans/%zz`, "malformed-escape"],
    [`${prefix}/v1/training-plans/%E4%B8%AD%E6%96%87`, "encoded-unicode-segment"],
    [`${prefix}/v1/training-plans/\u4e2d\u6587`, "raw-unicode-segment"],
    [`${prefix}/v1/training plans`, "space"],
    [`${prefix}/v1/training-plans/..`, "dot-dot-out"],
    [`${prefix}/v1/training-plans;jsessionid=${id}`, "path-param-semicolon"],
    [`${prefix}/v2/training-plans`, "v2"],
    [
      `${prefix}/v1/training-plans/${rng.string(rng.range(1, 40), PATH_JUNK_ALPHABET)}`,
      "junk-segment",
    ],
    [`${prefix}/v1/${rng.string(rng.range(1, 60), PATH_JUNK_ALPHABET)}`, "junk-resource"],
    [`${prefix}/v1/training-plans/${"a".repeat(rng.range(2_000, 60_000))}`, "very-long-segment"],
    [`${prefix}/v1/training-plans/${"../".repeat(rng.range(1, 30))}x`, "traversal-burst"],
    [`${prefix}/v1/training-plans/${"%2e%2e/".repeat(rng.range(1, 10))}x`, "encoded-traversal"],
    [`${prefix}/v1/training-plans/${seed.toString().padStart(8, "0")}`, "digit-run-segment"],
  ];
  const [path, label] = rng.pick(others);
  return { path, label, target: false };
}

function pickQuery(rng: Rng): string {
  const roll = rng.next();
  if (roll < 0.5) return "";
  const options = [
    "?",
    "?sourceShotId=abc",
    `?${rng.string(rng.range(1, 30), ALNUM)}=${rng.string(rng.range(0, 40), PATH_JUNK_ALPHABET)}`,
    "?a=1&a=2&a=3",
    `?${"x=1&".repeat(rng.range(10, 400))}`,
    "?%zz=%zz",
    "?__proto__=1&constructor=2",
    "?q=%00%0d%0a",
    `?q=${"a".repeat(rng.range(1_000, 20_000))}`,
    "?select=*&order=id",
    "?sourceShotId[]=1&sourceShotId[]=2",
    "?jsonp=callback",
  ];
  return rng.pick(options);
}

function pickMethod(rng: Rng): { method: string; label: string } {
  const roll = rng.next();
  if (roll < 0.72) return { method: "POST", label: "POST" };
  if (roll < 0.76) return { method: "post", label: "post (lowercase → POST)" };
  // (CONNECT/TRACE/TRACK are forbidden by the Fetch Request constructor itself.)
  const others = ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS", "PURGE", "BREW", "PROPFIND"];
  const method = rng.pick(others);
  return { method, label: method };
}

function pickBody(
  rng: Rng,
  seed: number,
): { body: string | Uint8Array<ArrayBuffer> | null; label: string } {
  const roll = rng.next();
  const uuid = rngUuid(rng);
  if (roll < 0.2) return { body: JSON.stringify({ sourceShotId: uuid }), label: "valid-shape" };
  if (roll < 0.25) return { body: null, label: "none" };
  if (roll < 0.3) return { body: "", label: "empty-string" };
  const options: Array<[string | Uint8Array<ArrayBuffer>, string]> = [
    ["{}", "empty-object"],
    ["null", "null"],
    ["[]", "array"],
    ['"string"', "json-string"],
    ["42", "json-number"],
    ["true", "json-bool"],
    ["{", "truncated-json"],
    ['{"sourceShotId":', "truncated-value"],
    ["{'sourceShotId': 1}", "single-quotes"],
    ["\ufeff{}", "bom-prefix"],
    [JSON.stringify({ sourceShotId: null }), "null-field"],
    [JSON.stringify({ sourceShotId: 1e308 }), "huge-number"],
    [JSON.stringify({ sourceShotId: uuid, extra: rng.string(50, ALNUM) }), "extra-field"],
    [JSON.stringify({ __proto__: { polluted: true }, sourceShotId: uuid }), "proto-key"],
    [JSON.stringify({ constructor: { prototype: { polluted: true } } }), "constructor-key"],
    [
      `{"a":${"[".repeat(rng.range(100, 5_000))}${"]".repeat(rng.range(100, 5_000))}}`,
      "deep-nesting",
    ],
    [JSON.stringify({ sourceShotId: "\u0000\u0001\u001f\u007f" }), "control-chars"],
    [JSON.stringify({ sourceShotId: "\ud800" }), "lone-surrogate"],
    [JSON.stringify({ sourceShotId: "𝔘𝔫𝔦𝔠𝔬𝔡𝔢 ✓ 中文 🥒" }), "unicode"],
    [`{"sourceShotId":"${"x".repeat(rng.range(100_000, 1_000_000))}"}`, "large-string"],
    ["x".repeat(MAX_JSON_BODY_BYTES + 1), "over-cap-undeclared"],
    [new Uint8Array([0xff, 0xfe, 0x00, 0x7b, 0x7d, 0x80, 0x81]), "binary"],
    [new Uint8Array(rng.range(1, 4096)).map(() => rng.int(256)), "random-bytes"],
    [
      '--boundary\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--boundary--',
      "multipart",
    ],
    ["sourceShotId=abc&x=1", "urlencoded"],
    ["<xml><sourceShotId>1</sourceShotId></xml>", "xml"],
    [`{"seed":${seed}}`, "seed-echo"],
  ];
  const [body, label] = rng.pick(options);
  return { body, label };
}

function pickContentType(rng: Rng): { value: string | null; label: string } {
  const roll = rng.next();
  if (roll < 0.45) return { value: "application/json", label: "json" };
  if (roll < 0.55) return { value: null, label: "absent" };
  const options = [
    "application/json; charset=utf-8",
    "application/json; charset=utf-16",
    "application/JSON",
    "text/plain",
    "text/html",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=boundary",
    "application/octet-stream",
    "application/xml",
    "application/json, text/plain",
    "application/json;;;",
    `application/${rng.string(rng.range(1, 30), ALNUM)}`,
    rng.string(rng.range(1, 60), HEADER_VALUE_ALPHABET.replace(/\t/g, "")),
    "",
  ];
  const value = rng.pick(options);
  return { value, label: value === "" ? "empty" : value };
}

function pickContentLength(rng: Rng): { value: string | null; label: string } {
  const roll = rng.next();
  if (roll < 0.55) return { value: null, label: "implicit" };
  const options = [
    "0",
    "2",
    "-1",
    "abc",
    "",
    "1e3",
    "1e7",
    "1e400",
    "Infinity",
    "NaN",
    "0x5F5E100",
    " 6000000 ",
    "4999999",
    "5000000",
    "5000001",
    "6000000",
    "99999999999999999999",
    "5000000.5",
    "5,000,001",
    "1, 2",
  ];
  const value = rng.pick(options);
  return { value, label: value === "" ? "empty" : value };
}

function pickIp(
  rng: Rng,
  seed: number,
): { headers: [string, string][]; label: string; shared: boolean } {
  const ip = uniqueIp(seed);
  const roll = rng.next();
  if (roll < 0.5) return { headers: [["x-forwarded-for", ip]], label: "single-hop", shared: false };
  if (roll < 0.6) {
    return {
      headers: [["x-forwarded-for", `${rng.string(8, "0123456789.")}, 203.0.113.9, ${ip}`]],
      label: "many-hops-last-wins",
      shared: false,
    };
  }
  if (roll < 0.68) {
    return {
      headers: [
        ["cf-connecting-ip", ip],
        ["x-forwarded-for", "1.1.1.1, 2.2.2.2"],
      ],
      label: "cf-connecting-ip",
      shared: false,
    };
  }
  if (roll < 0.74) return { headers: [], label: "no-ip-headers", shared: true };
  if (roll < 0.78) return { headers: [["x-forwarded-for", ""]], label: "empty-xff", shared: true };
  if (roll < 0.82)
    return { headers: [["x-forwarded-for", " , , "]], label: "commas-only", shared: true };
  if (roll < 0.88) {
    return {
      headers: [["x-forwarded-for", `2001:db8::${(seed & 0xffff).toString(16)}:${seed & 0xff}`]],
      label: "ipv6",
      shared: false,
    };
  }
  if (roll < 0.94) {
    return {
      headers: [
        ["x-forwarded-for", `${rng.string(rng.range(1, 200), HEADER_VALUE_ALPHABET)}-${seed}`],
      ],
      label: "garbage-with-seed",
      shared: false,
    };
  }
  return {
    headers: [["x-forwarded-for", `${"1.2.3.4, ".repeat(rng.range(50, 500))}${ip}`]],
    label: "hop-flood",
    shared: false,
  };
}

function pickRequestId(rng: Rng): {
  headers: [string, string][];
  sent: string | null;
  label: string;
} {
  const roll = rng.next();
  if (roll < 0.2) return { headers: [], sent: null, label: "absent" };
  if (roll < 0.4) {
    const id = rngUuid(rng);
    return { headers: [["x-request-id", id]], sent: id, label: "uuid" };
  }
  const options: Array<[string, string]> = [
    [rng.string(8, REQUEST_ID_ALPHABET), "min-length-8"],
    [rng.string(64, REQUEST_ID_ALPHABET), "max-length-64"],
    [rng.string(rng.range(9, 63), REQUEST_ID_ALPHABET), "well-formed"],
    [rng.string(7, REQUEST_ID_ALPHABET), "too-short-7"],
    [rng.string(65, REQUEST_ID_ALPHABET), "too-long-65"],
    [rng.string(rng.range(100, 8_000), REQUEST_ID_ALPHABET), "too-long-huge"],
    ["", "empty"],
    ["        ", "spaces-only"],
    [`  ${rng.string(12, REQUEST_ID_ALPHABET)}  `, "padded-well-formed"],
    [`${rng.string(6, ALNUM)} ${rng.string(6, ALNUM)}`, "interior-space"],
    [`${rng.string(6, ALNUM)}\t${rng.string(6, ALNUM)}`, "interior-tab"],
    [`${rng.string(6, ALNUM)}/${rng.string(6, ALNUM)}`, "slash"],
    ["<script>alert(1)</script>", "html"],
    ['{"$ne":null}', "json"],
    ["abcdefgh\u00e9\u00ff", "latin1"],
    ["../../etc/passwd", "traversal"],
    [`${rng.string(12, ALNUM)}%0d%0aInjected: 1`, "encoded-crlf"],
    ["00000000-0000-0000-0000-000000000000", "nil-uuid"],
    [rng.string(rng.range(1, 64), HEADER_VALUE_ALPHABET), "random-header-bytes"],
  ];
  const [sent, label] = rng.pick(options);
  return { headers: [["x-request-id", sent]], sent, label };
}

function pickExtraHeaders(rng: Rng): [string, string][] {
  const out: [string, string][] = [];
  const count = rng.chance(0.6) ? 0 : rng.range(1, 6);
  const names = [
    "accept",
    "accept-encoding",
    "user-agent",
    "origin",
    "referer",
    "x-forwarded-proto",
    "x-forwarded-host",
    "host",
    "cookie",
    "idempotency-key",
    "x-client-info",
    "apikey",
    "authorization-x",
    "content-encoding",
    "transfer-encoding",
    "expect",
    "if-match",
    "range",
    `x-fuzz-${rng.string(rng.range(1, 12), ALNUM.toLowerCase())}`,
  ];
  for (let i = 0; i < count; i += 1) {
    out.push([rng.pick(names), rng.string(rng.range(0, 120), HEADER_VALUE_ALPHABET)]);
  }
  if (rng.chance(0.05)) out.push(["X-Request-ID", rng.string(12, REQUEST_ID_ALPHABET)]);
  return out;
}

export function generateCase(seed: number): FuzzCase {
  const rng = new Rng(seed);
  const method = pickMethod(rng);
  const path = pickPath(rng, seed);
  const query = pickQuery(rng);
  const authPick = pickAuth(rng, seed);
  const ip = pickIp(rng, seed);
  const requestId = pickRequestId(rng);
  const contentType = pickContentType(rng);
  const contentLength = pickContentLength(rng);
  const bodyPick = pickBody(rng, seed);
  const extra = pickExtraHeaders(rng);

  const headers: [string, string][] = [];
  if (authPick.authorization !== null) headers.push(["Authorization", authPick.authorization]);
  headers.push(...ip.headers, ...requestId.headers, ...extra);
  if (contentType.value !== null) headers.push(["Content-Type", contentType.value]);
  if (contentLength.value !== null) headers.push(["Content-Length", contentLength.value]);

  const upperMethod = method.method.toUpperCase();
  const bodyAllowed = upperMethod !== "GET" && upperMethod !== "HEAD";
  const body = bodyAllowed ? bodyPick.body : null;

  // A duplicate x-request-id (Headers joins repeated names) is never well-formed.
  const requestIdValues = headers
    .filter(([name]) => name.toLowerCase() === "x-request-id")
    .map(([, value]) => value);
  const sentRequestId =
    requestIdValues.length === 0
      ? null
      : requestIdValues.length === 1
        ? requestIdValues[0]
        : requestIdValues.join(", ");

  const url = `http://edge.test${path.path}${query}`;
  const pathname = new URL(url).pathname;
  const v1 = pathname.lastIndexOf("/v1/");
  const normalized = v1 >= 0 ? pathname.slice(v1) : pathname;
  const target = normalized === "/v1/training-plans";
  const sibling = normalized === "/v1/training-plans/current";

  return {
    seed,
    method: method.method,
    url,
    headers,
    body,
    dims: {
      method: method.label,
      path: `${path.label}${path.target === target ? "" : " (normalizes differently)"}`,
      query:
        query === ""
          ? "none"
          : query.length > 40
            ? `${query.slice(0, 40)}…(${query.length})`
            : query,
      auth: authPick.auth.label,
      ip: ip.label,
      requestId: requestId.label,
      contentType: contentType.label,
      contentLength: contentLength.label,
      body: bodyAllowed ? bodyPick.label : `${bodyPick.label} (dropped: ${upperMethod})`,
      extraHeaders: String(extra.length),
    },
    auth: authPick.auth,
    bearer:
      authPick.authorization && authPick.authorization.startsWith("Bearer ")
        ? authPick.authorization.slice("Bearer ".length).trim()
        : null,
    sentRequestId,
    sharedIp: ip.shared,
    declaredLength: Number(contentLength.value ?? "0"),
    target,
    sibling,
  };
}

/** Everything about a case except the bearer bytes (whose `exp` moves once an
 * hour) — what two generations of the same seed must agree on. */
function fingerprint(c: FuzzCase): unknown {
  return {
    ...c,
    headers: c.headers.map(([name, value]) =>
      name === "Authorization" ? [name, `len:${value.length}`] : [name, value],
    ),
    bearer: c.bearer === null ? null : c.bearer.length,
    body: c.body === null ? null : c.body.length,
  };
}

/** Build the Request; a construction TypeError is a generator bug (the
 * campaign must never silently skip a seed), so it surfaces as a failure. */
export function buildRequest(c: FuzzCase): Request {
  const headers = new Headers();
  for (const [name, value] of c.headers) headers.append(name, value);
  return new Request(c.url, {
    method: c.method,
    headers,
    body: c.body === null ? undefined : c.body,
  });
}

// ── Oracle ──────────────────────────────────────────────────────────────────

const BAD_INPUT_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 429]);

interface Expectation {
  statuses: Set<number>;
  requiredCode: string | null | undefined; // undefined = don't care
  note: string;
}

export function expectationFor(c: FuzzCase): Expectation {
  const statuses = new Set<number>();
  let note: string;
  let requiredCode: string | null | undefined;
  const upper = c.method.toUpperCase();
  const declaredOverCap =
    Number.isFinite(c.declaredLength) && c.declaredLength > MAX_JSON_BODY_BYTES;
  if (declaredOverCap) {
    statuses.add(413);
    note = "declared Content-Length over the 5 MB cap → 413 before auth";
    requiredCode = null;
  } else if (c.auth.kind === "refused") {
    statuses.add(401);
    note = "bearer refused → 401 (generic body)";
    requiredCode = null;
  } else if (c.auth.kind === "unavailable") {
    statuses.add(503);
    note = "injected Supabase Auth outage → retryable 503 (generic body)";
    requiredCode = null;
  } else if (c.target && upper === "POST") {
    statuses.add(409);
    note = "authenticated POST /v1/training-plans → 409 training.plan_unavailable";
    requiredCode = TARGET_CODE;
  } else if (c.sibling && upper === "GET") {
    statuses.add(200);
    note = "authenticated GET /v1/training-plans/current → 200 {plan:null} (read-only sibling)";
    requiredCode = undefined;
  } else {
    statuses.add(404);
    note = "authenticated request to a route the switch does not know → 404";
    requiredCode = null;
  }
  // A non-finite declared length is advisory noise: refusing it as 413 is as
  // acceptable as ignoring it.
  if (c.declaredLength !== 0 && !Number.isFinite(c.declaredLength)) statuses.add(413);
  // Shared buckets may legitimately trip a budget mid-campaign.
  if (c.sharedIp) statuses.add(429);
  if (c.auth.kind === "ok" && c.auth.sharedUser) statuses.add(429);
  return { statuses, requiredCode, note };
}

// ── Injected Supabase Auth for session bearers ──────────────────────────────

function decodePayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const raw = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(raw + "=".repeat((4 - (raw.length % 4)) % 4)));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Wrap the harness fetch so `GET /auth/v1/user` answers per the bearer's
 * `fuzz` claim. Anything else falls through to the harness stub. */
function installAuthFault(): () => void {
  const base = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const payload = decodePayload(bearer);
      const mode = (payload?.fuzz as UpstreamMode | undefined) ?? "refused";
      const sub = typeof payload?.sub === "string" ? payload.sub : TEST_USER_ID;
      switch (mode) {
        case "ok":
          return jsonResponse(200, {
            id: sub,
            aud: "authenticated",
            role: "authenticated",
            email: "user@example.com",
            app_metadata: { provider: "google", providers: ["google"] },
          });
        case "no-provider":
          return jsonResponse(200, { id: sub, app_metadata: {} });
        case "http-5xx":
          return jsonResponse(502, { message: "bad gateway", stack: "at fake (upstream.ts:1:1)" });
        case "garbage-2xx":
          return new Response("<html>gateway page</html>", { status: 200 });
        case "throw":
          throw new TypeError("error sending request: connection reset");
        case "refused":
        default:
          return jsonResponse(401, { code: 401, msg: "invalid JWT" });
      }
    }
    return base(request);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = base;
  };
}

// ── Runner ──────────────────────────────────────────────────────────────────

interface Outcome {
  seed: number;
  dims: Record<string, string>;
  method: string;
  url: string;
  urlLength: number;
  status: number;
  code: string | null;
  message: string | null;
  requestId: string | null;
  sentRequestId: string | null;
  expected: number[];
  note: string;
  upstreamCalls: Record<string, number>;
  durationMs: number;
  pass: boolean;
  violations: string[];
}

interface Sink {
  accessLines: string[];
  consoleLines: string[];
}

function upstreamSummary(h: Harness): Record<string, number> {
  const out: Record<string, number> = {};
  for (const call of h.calls) {
    const path = new URL(call.url).pathname;
    const key = `${call.method} ${path.split("/").slice(0, 4).join("/")}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export async function runCase(h: Harness, c: FuzzCase, sink: Sink): Promise<Outcome> {
  const expectation = expectationFor(c);
  const violations: string[] = [];
  h.calls.length = 0;
  sink.accessLines.length = 0;
  sink.consoleLines.length = 0;

  let request: Request;
  try {
    request = buildRequest(c);
  } catch (error) {
    return {
      seed: c.seed,
      dims: c.dims,
      method: c.method,
      url: c.url.slice(0, 200),
      urlLength: c.url.length,
      status: -1,
      code: null,
      message: null,
      requestId: null,
      sentRequestId: c.sentRequestId,
      expected: [...expectation.statuses],
      note: expectation.note,
      upstreamCalls: {},
      durationMs: 0,
      pass: false,
      violations: [`request construction threw: ${String(error)}`],
    };
  }

  // What the handler actually sees (Headers folds repeats with ", " and the
  // Request constructor drops empty values) is the request-id under test.
  const wireRequestId = request.headers.get("x-request-id");

  const startedAt = performance.now();
  const response = await h.handler(request);
  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
  const text = await response.text();
  const status = response.status;

  // 1. Status class.
  if (status >= 500 && !expectation.statuses.has(status)) {
    violations.push(`unexpected 5xx ${status} (expected ${[...expectation.statuses].join("/")})`);
  } else if (!expectation.statuses.has(status)) {
    violations.push(`status ${status} not in expected ${[...expectation.statuses].join("/")}`);
  }
  const siblingRead = status === 200 && expectation.statuses.has(200);
  if (status < 400 && !siblingRead) {
    violations.push(`2xx/3xx ${status} on a route with no success path`);
  }
  if (status >= 400 && status < 500 && status !== 409 && !BAD_INPUT_STATUSES.has(status)) {
    violations.push(`4xx ${status} outside the allowed bad-input set`);
  }

  // 2. Body shape + genericity.
  let code: string | null = null;
  let message: string | null = null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    violations.push(`body is not JSON (${text.length} bytes)`);
  }
  if (siblingRead) {
    if (text !== JSON.stringify({ plan: null })) violations.push("sibling read body drifted");
  } else if (parsed !== null) {
    const error =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).error
        : undefined;
    if (!error || typeof error !== "object") {
      violations.push("body is not {error:{...}}");
    } else {
      const err = error as Record<string, unknown>;
      message = typeof err.message === "string" ? err.message : null;
      code = typeof err.code === "string" ? err.code : null;
      if (message === null) violations.push("error.message missing");
      const extraKeys = Object.keys(err).filter((k) => k !== "message" && k !== "code");
      if (extraKeys.length > 0) violations.push(`error carries extra keys ${extraKeys.join(",")}`);
    }
  }
  if (
    expectation.requiredCode !== undefined &&
    expectation.statuses.has(status) &&
    status !== 429
  ) {
    if (expectation.requiredCode === null && code !== null) {
      violations.push(`generic ${status} unexpectedly carries error.code=${code}`);
    }
    if (expectation.requiredCode !== null && code !== expectation.requiredCode) {
      violations.push(`expected error.code=${expectation.requiredCode}, got ${code}`);
    }
  }
  if (status === 409 && message !== TARGET_MESSAGE) violations.push("409 copy drifted");
  if (status === 429 && code !== "rate_limited") violations.push("429 without rate_limited code");
  for (const fragment of FORBIDDEN_BODY_FRAGMENTS) {
    if (text.includes(fragment)) violations.push(`body leaks "${fragment}"`);
  }
  if (c.bearer && c.bearer.length >= 8 && text.includes(c.bearer)) {
    violations.push("body reflects the bearer");
  }
  if (status >= 500 && text.length > 400) violations.push(`5xx body is ${text.length} bytes`);
  if (status >= 500 && !response.headers.get("retry-after")) {
    violations.push("503 without Retry-After");
  }

  // 3. Headers.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/json")) {
    violations.push(`content-type ${contentType || "(none)"}`);
  }
  if (response.headers.get("x-content-type-options") !== "nosniff") {
    violations.push("missing X-Content-Type-Options: nosniff");
  }
  if (response.headers.get("cache-control") !== "no-store") {
    violations.push("missing Cache-Control: no-store");
  }
  if (status === 429) {
    for (const name of ["retry-after", "ratelimit-limit", "ratelimit-remaining"]) {
      if (!response.headers.get(name)) violations.push(`429 without ${name}`);
    }
  }

  // 4. Request-id contract.
  const requestId = response.headers.get("x-request-id");
  if (!requestId) {
    violations.push("x-request-id missing");
  } else {
    const trimmed = wireRequestId?.trim() ?? "";
    if (REQUEST_ID_RE.test(trimmed)) {
      if (requestId !== trimmed)
        violations.push(`well-formed request id not echoed (${requestId})`);
    } else {
      if (!UUID_RE.test(requestId))
        violations.push(`minted request id is not a UUID: ${requestId}`);
      if (wireRequestId !== null && requestId === wireRequestId) {
        violations.push("malformed request id was reflected");
      }
    }
  }

  // 5. No writes / no upstream reach on rejection.
  const upstreamCalls = upstreamSummary(h);
  for (const call of h.calls) {
    if (call.url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      violations.push(`PostgREST reached: ${call.method} ${new URL(call.url).pathname}`);
    } else if (call.url.startsWith("https://api.revenuecat.com/")) {
      violations.push(`RevenueCat reached: ${call.method}`);
    } else if (call.url.startsWith(`${SUPABASE_URL}/auth/v1/admin`)) {
      violations.push(`Auth admin reached: ${call.method}`);
    } else if (call.method !== "GET" && call.method !== "POST") {
      violations.push(`unexpected upstream ${call.method} ${call.url}`);
    }
  }
  if (status === 413 && h.calls.length > 0) violations.push("413 still reached an upstream");
  if (c.auth.kind === "refused" && status === 401 && h.calls.length > 0) {
    violations.push(`401 reached an upstream: ${Object.keys(upstreamCalls).join(", ")}`);
  }

  // 6. Exactly one access-log line, same id/status/method, no bearer/query.
  if (sink.accessLines.length !== 1) {
    violations.push(`${sink.accessLines.length} access-log lines (expected 1)`);
  } else {
    const line = sink.accessLines[0];
    let entry: Record<string, unknown> | null = null;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      violations.push("access-log line is not JSON");
    }
    if (entry) {
      if (entry.requestId !== requestId) violations.push("access-log requestId differs");
      if (entry.status !== status) violations.push("access-log status differs");
      if (entry.method !== request.method) violations.push("access-log method differs");
      if (typeof entry.route !== "string" || entry.route.includes("?")) {
        violations.push("access-log route carries a query string");
      }
    }
    if (c.bearer && c.bearer.length >= 8 && line.includes(c.bearer)) {
      violations.push("access log carries the bearer");
    }
  }
  // 7. Operator logs never carry the bearer.
  if (c.bearer && c.bearer.length >= 8) {
    for (const line of sink.consoleLines) {
      if (line.includes(c.bearer)) {
        violations.push("console output carries the bearer");
        break;
      }
    }
  }

  return {
    seed: c.seed,
    dims: c.dims,
    method: request.method,
    url: request.url.length > 200 ? `${request.url.slice(0, 200)}…` : request.url,
    urlLength: request.url.length,
    status,
    code,
    message: message && message.length > 160 ? `${message.slice(0, 160)}…` : message,
    requestId,
    sentRequestId:
      c.sentRequestId && c.sentRequestId.length > 80
        ? `${c.sentRequestId.slice(0, 80)}…(${c.sentRequestId.length})`
        : c.sentRequestId,
    expected: [...expectation.statuses].sort(),
    note: expectation.note,
    upstreamCalls,
    durationMs,
    pass: violations.length === 0,
    violations,
  };
}

function campaignSeeds(): { seeds: number[]; repeat: number; label: string } {
  const explicit = Deno.env.get("STRESS_SEEDS");
  const repeat = Math.max(1, Number(Deno.env.get("STRESS_REPEAT") ?? "1") || 1);
  if (explicit) {
    const seeds = explicit
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n));
    return { seeds, repeat, label: `replay ${seeds.length} seed(s) × ${repeat}` };
  }
  const base = Number(Deno.env.get("STRESS_SEED") ?? "20260904");
  const iter = Math.max(1, Number(Deno.env.get("STRESS_ITER") ?? "200") || 200);
  const seeds: number[] = [];
  for (let i = 0; i < iter; i += 1) seeds.push(base + i);
  return { seeds, repeat, label: `seeds ${base}..${base + iter - 1} × ${repeat}` };
}

async function withCampaignEnvironment<T>(run: (sink: Sink) => Promise<T>): Promise<T> {
  const sink: Sink = { accessLines: [], consoleLines: [] };
  const restoreAccessLog = captureAccessLog((line) => sink.accessLines.push(line));
  const restoreFault = installAuthFault();
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args: unknown[]) => sink.consoleLines.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => sink.consoleLines.push(args.map(String).join(" "));
  // A thrown Auth socket is retried on a 100 ms backoff inside one deadline;
  // a short deadline keeps injected outages from stalling the campaign.
  const previousTimeout = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "250");
  try {
    return await run(sink);
  } finally {
    if (previousTimeout === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
    else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previousTimeout);
    console.error = realError;
    console.warn = realWarn;
    restoreFault();
    restoreAccessLog();
  }
}

Deno.test(
  "stress fuzz-boundary: POST /v1/training-plans survives the seeded campaign",
  async () => {
    const h = await loadHarness();
    const { seeds, repeat, label } = campaignSeeds();
    const outcomes: Outcome[] = [];
    const startedAt = performance.now();
    await withCampaignEnvironment(async (sink) => {
      for (const seed of seeds) {
        for (let r = 0; r < repeat; r += 1) {
          outcomes.push(await runCase(h, generateCase(seed), sink));
        }
      }
    });
    const wallMs = Math.round(performance.now() - startedAt);

    const statusHistogram: Record<string, number> = {};
    const dimHistogram: Record<string, Record<string, number>> = {};
    const failures = outcomes.filter((o) => !o.pass);
    const fiveXx = outcomes.filter((o) => o.status >= 500);
    const unexpectedFiveXx = fiveXx.filter((o) => !o.expected.includes(o.status));
    for (const o of outcomes) {
      statusHistogram[o.status] = (statusHistogram[o.status] ?? 0) + 1;
      for (const [dim, value] of Object.entries(o.dims)) {
        const bucket = (dimHistogram[dim] ??= {});
        bucket[value] = (bucket[value] ?? 0) + 1;
      }
    }
    const flakeRate: Record<string, { runs: number; failed: number }> = {};
    if (repeat > 1) {
      for (const o of outcomes) {
        const entry = (flakeRate[o.seed] ??= { runs: 0, failed: 0 });
        entry.runs += 1;
        if (!o.pass) entry.failed += 1;
      }
    }
    const report = {
      unit: "route-post-v1-training-plans",
      lens: "fuzz-boundary",
      campaign: label,
      executed: outcomes.length,
      wallMs,
      statusHistogram,
      failures: failures.length,
      failingSeeds: [...new Set(failures.map((o) => o.seed))],
      fiveXxSeeds: fiveXx.map((o) => ({ seed: o.seed, status: o.status, expected: o.expected })),
      unexpectedFiveXxSeeds: unexpectedFiveXx.map((o) => o.seed),
      flakeRate: repeat > 1 ? flakeRate : undefined,
      dimHistogram,
      outcomes,
    };
    const out = Deno.env.get("STRESS_OUT");
    if (out) await Deno.writeTextFile(out, JSON.stringify(report, null, 2));

    assertEquals(
      failures.map((o) => ({
        seed: o.seed,
        status: o.status,
        violations: o.violations,
        dims: o.dims,
      })),
      [],
      `${failures.length}/${outcomes.length} fuzz iterations violated the oracle`,
    );
    assertEquals(unexpectedFiveXx, [], "a 5xx nobody injected");
  },
);

// ── Deterministic boundary scenarios (always run, seedless) ─────────────────

/** Sleep past an aligned fixed-window boundary when a burst would straddle it. */
async function avoidWindowBoundary(windowSeconds: number, marginMs: number): Promise<void> {
  const windowMs = windowSeconds * 1_000;
  const into = Date.now() % windowMs;
  if (windowMs - into < marginMs) {
    await new Promise((resolve) => setTimeout(resolve, windowMs - into + 50));
  }
}

const canonical = (seedish: string, init: { token: string; ip: string; body?: string }): Request =>
  new Request("http://edge.test/functions/v1/api/v1/training-plans", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${init.token}`,
      "x-forwarded-for": init.ip,
      "Content-Type": "application/json",
      "x-request-id": `det-${seedish}`,
    },
    body: init.body ?? JSON.stringify({ sourceShotId: "44444444-4444-4444-8444-444444444444" }),
  });

Deno.test(
  "stress: 64 identical concurrent POSTs are all 409 and write nothing (idempotent by construction)",
  async () => {
    const h = await loadHarness();
    const token = providerToken(7_000_001, "https://accounts.google.com");
    const ip = "10.250.0.1";
    const body = JSON.stringify({ sourceShotId: "33333333-3333-4333-8333-333333333333" });
    await withCampaignEnvironment(async (sink) => {
      h.calls.length = 0;
      const responses = await Promise.all(
        Array.from({ length: 64 }, (_, i) =>
          h.handler(canonical(`burst-${i}`, { token, ip, body })),
        ),
      );
      const bodies = await Promise.all(responses.map((r) => r.json()));
      for (const [i, r] of responses.entries()) {
        assertEquals(r.status, 409, `response ${i}`);
        assertEquals(bodies[i].error.code, TARGET_CODE);
        assertEquals(r.headers.get("x-request-id"), `det-burst-${i}`);
      }
      assertEquals(h.callsTo("/rest/v1/").length, 0, "no PostgREST call at all");
      assertEquals(h.callsTo("api.revenuecat.com").length, 0);
      assertEquals(sink.accessLines.length, 64, "one access line per request");
      const ids = new Set(
        sink.accessLines.map((l) => (JSON.parse(l) as { requestId: string }).requestId),
      );
      assertEquals(ids.size, 64, "every request logged under its own id");
    });
  },
);

Deno.test(
  "stress: the 241st request in a minute from one user is 429 with budget headers",
  async () => {
    const h = await loadHarness();
    const token = providerToken(7_000_002, "https://accounts.google.com");
    const ip = "10.250.0.2";
    await avoidWindowBoundary(60, 4_000);
    await withCampaignEnvironment(async () => {
      for (let i = 0; i < 240; i += 1) {
        const r = await h.handler(canonical(`quota-${i}`, { token, ip }));
        await r.body?.cancel();
        assertEquals(r.status, 409, `request ${i + 1} inside the budget`);
      }
      const limited = await h.handler(canonical("quota-241", { token, ip }));
      const body = await limited.json();
      assertEquals(limited.status, 429);
      assertEquals(body.error.code, "rate_limited");
      assertEquals(limited.headers.get("ratelimit-limit"), "240");
      assertEquals(limited.headers.get("ratelimit-remaining"), "0");
      assert(Number(limited.headers.get("retry-after")) > 0, "Retry-After is a positive number");
      assertEquals(limited.headers.get("x-request-id"), "det-quota-241");
      assertEquals(h.callsTo("/rest/v1/").length, 0);
    });
  },
);

Deno.test(
  "stress: 30 refused bearers lock the IP out — the 31st AND a valid bearer get 429",
  async () => {
    const h = await loadHarness();
    const ip = "10.250.0.3";
    await avoidWindowBoundary(300, 4_000);
    await withCampaignEnvironment(async () => {
      for (let i = 0; i < 30; i += 1) {
        const r = await h.handler(canonical(`lock-${i}`, { token: `not-a-jwt-${i}`, ip }));
        await r.body?.cancel();
        assertEquals(r.status, 401, `refusal ${i + 1}`);
      }
      const locked = await h.handler(canonical("lock-31", { token: "not-a-jwt-31", ip }));
      await locked.body?.cancel();
      assertEquals(locked.status, 429, "31st refusal is throttled");
      h.calls.length = 0;
      const valid = await h.handler(
        canonical("lock-valid", {
          token: providerToken(7_000_003, "https://accounts.google.com"),
          ip,
        }),
      );
      await valid.body?.cancel();
      assertEquals(valid.status, 429, "a valid bearer from the locked IP is throttled too");
      assertEquals(h.calls.length, 0, "the locked IP never reaches Supabase Auth");
    });
  },
);

Deno.test(
  "stress: body-size boundary — declared 5 000 001 is 413 pre-auth, undeclared 5 MB+1 is ignored by this route",
  async () => {
    const h = await loadHarness();
    const token = providerToken(7_000_004, "https://accounts.google.com");
    await withCampaignEnvironment(async () => {
      h.calls.length = 0;
      const declared = await h.handler(
        new Request("http://edge.test/functions/v1/api/v1/training-plans", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "x-forwarded-for": "10.250.0.4",
            "Content-Type": "application/json",
            "Content-Length": String(MAX_JSON_BODY_BYTES + 1),
          },
          body: "{}",
        }),
      );
      const declaredBody = await declared.json();
      assertEquals(declared.status, 413);
      assertEquals(declaredBody.error.code, undefined, "413 is generic (no code)");
      assertEquals(h.calls.length, 0, "413 happens before any upstream call");
      assert(UUID_RE.test(declared.headers.get("x-request-id") ?? ""), "413 carries a minted id");

      const exactCap = await h.handler(
        new Request("http://edge.test/functions/v1/api/v1/training-plans", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "x-forwarded-for": "10.250.0.4",
            "Content-Type": "application/json",
            "Content-Length": String(MAX_JSON_BODY_BYTES),
          },
          body: "{}",
        }),
      );
      await exactCap.body?.cancel();
      assertEquals(exactCap.status, 409, "exactly the cap is still accepted");

      const undeclared = await h.handler(
        canonical("bigbody", {
          token,
          ip: "10.250.0.4",
          body: `{"pad":"${"x".repeat(MAX_JSON_BODY_BYTES + 1)}"}`,
        }),
      );
      await undeclared.body?.cancel();
      assertEquals(undeclared.status, 409, "the route never reads its body");
      assertEquals(h.callsTo("/rest/v1/").length, 0);
    });
  },
);

Deno.test("stress: generator is deterministic and every campaign seed builds a Request", () => {
  const { seeds } = campaignSeeds();
  for (const seed of seeds.slice(0, Math.min(seeds.length, 500))) {
    const a = generateCase(seed);
    const b = generateCase(seed);
    assertEquals(fingerprint(a), fingerprint(b), `seed ${seed} must be replayable`);
    buildRequest(a);
  }
});
