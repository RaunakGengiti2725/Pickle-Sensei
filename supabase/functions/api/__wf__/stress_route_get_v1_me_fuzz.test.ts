// Seeded FUZZ/BOUNDARY campaign against the REAL edge handler for
// `GET /v1/me` (supabase/functions/api/index.ts), in process, with Supabase
// Auth/PostgREST and RevenueCat stubbed by sessionHarness.ts.
//
// Every iteration is derived from one 32-bit seed, so any outcome replays on
// its own:
//
//   STRESS_ITER=3000 deno test -A --no-check --config deno.json \
//     stress_route_get_v1_me_fuzz.test.ts                  # full campaign
//   STRESS_SEEDS=1234567,89 deno test -A --no-check --config deno.json \
//     stress_route_get_v1_me_fuzz.test.ts                  # replay seeds
//   STRESS_OUT=/tmp/table.json …                           # seed → outcome table
//
// The default iteration count is small so the campaign can live in the suite;
// the scale run is behind STRESS_ITER.
//
// Invariants asserted for EVERY iteration:
//   1. status ∈ {200,400,401,403,404,405,413,415,429} — no 5xx, no surprise code
//   2. a credential that is not a live session/provider token NEVER gets 200
//   3. no 5xx (should any appear) carries a stack trace or internal detail,
//      and no body of any status echoes the bearer
//   4. no PostgREST write (POST/PATCH/PUT/DELETE, or any RPC) on any request
//      to this route — rejected or served
//   5. every response carries x-request-id: the client's when well-formed,
//      a fresh UUID otherwise
//   6. exactly one categorical access-log line per request, status-matched,
//      carrying no bearer and no query string
//   7. the profiles read is scoped to the caller (own bearer, id=eq.<own id>)
//   8. JSON responses carry the security headers

import { assert, assertEquals } from "@std/assert";
import { captureAccessLog, JSON_SECURITY_HEADERS } from "../http.ts";
import {
  apiRequest,
  appleIdToken,
  fakeJwt,
  forgedSessionToken,
  freshIp,
  googleIdToken,
  loadSessionHarness,
  type SessionHarness,
  SUPABASE_URL,
} from "./sessionHarness.ts";

const ALLOWED_STATUSES = new Set([200, 400, 401, 403, 404, 405, 413, 415, 429]);
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JSON_BODY_BYTES = 5_000_000;
const ACCESS_LOG_FIELDS: ReadonlySet<string> = new Set([
  "evt",
  "requestId",
  "method",
  "route",
  "status",
  "durationMs",
  "code",
]);

/** Substrings that must never reach a client body: stack frames, module
 * paths, upstream identifiers, SQL/PostgREST internals. */
const LEAK_MARKERS = [
  "    at ",
  ".ts:",
  "index.ts",
  "Deno.",
  "stack",
  "PGRST",
  "postgrest",
  "rest/v1",
  "auth/v1",
  "service_role",
  "anon-test-key",
  "service-role-test-key",
  SUPABASE_URL,
];

// ─── seeded RNG (mulberry32: one 32-bit seed → one deterministic stream) ─────

function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  bool(probability?: number): boolean;
  /** A string of `length` code units drawn from a hostile alphabet. */
  hostile(length: number): string;
}

const HOSTILE_ALPHABET = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ..."-_.~!*'();:@&=+$,/?#[]%<>\"\\|{}^`",
  " ",
  "\t",
  "\u0000",
  "\u0007",
  "\u001b",
  "\u007f",
  "\u009f",
  "\u200b",
  "\u202e",
  "\u2066",
  "\ufeff",
  "é",
  "日",
  "🏓",
  "\ud800", // lone high surrogate
  "\udfff", // lone low surrogate
  "'; drop table profiles;--",
  "<script>alert(1)</script>",
  "${jndi:ldap://x/y}",
  "../../etc/passwd",
  "%00",
  "%2e%2e%2f",
  "%zz",
  "\r\n",
];

/** A v4-shaped UUID drawn from the seeded stream (never crypto.randomUUID:
 * every byte of a scenario must replay from its seed). */
function seededUuid(rng: Rng): string {
  const hex = () => rng.int(16).toString(16);
  const run = (n: number) => Array.from({ length: n }, hex).join("");
  return `${run(8)}-${run(4)}-4${run(3)}-${rng.pick(["8", "9", "a", "b"])}${run(3)}-${run(12)}`;
}

function makeRng(seed: number): Rng {
  const next = rngOf(seed);
  const rng: Rng = {
    next,
    int: (maxExclusive: number) => Math.floor(next() * maxExclusive),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    bool: (probability = 0.5) => next() < probability,
    hostile: (length: number) => {
      let out = "";
      for (let i = 0; i < length; i += 1) out += rng.pick(HOSTILE_ALPHABET);
      return out;
    },
  };
  return rng;
}

// ─── scenario generation ────────────────────────────────────────────────────

type TokenKind =
  | "session" // a live Supabase access token (the 2026-09-01 contract)
  | "session_fresh" // a never-seen token: always reaches GET /auth/v1/user
  | "session_reused" // the same token twice: the auth-cache path
  | "google_id_token" // transitional provider bearer
  | "apple_id_token"
  | "expired_session"
  | "forged_session"
  | "unknown_user_session"
  | "missing"
  | "empty"
  | "wrong_scheme"
  | "garbage"
  | "huge"
  | "jwt_fuzz"
  | "structural_jwt";

/** Token kinds that are a credential the server must honour. */
const VALID_TOKEN_KINDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  "session",
  "session_fresh",
  "session_reused",
  "google_id_token",
  "apple_id_token",
]);

const TOKEN_KINDS: readonly TokenKind[] = [
  "session",
  "session",
  "session",
  "session_fresh",
  "session_reused",
  "google_id_token",
  "apple_id_token",
  "expired_session",
  "forged_session",
  "unknown_user_session",
  "missing",
  "empty",
  "wrong_scheme",
  "garbage",
  "huge",
  "jwt_fuzz",
  "structural_jwt",
];

const METHODS: readonly string[] = [
  "GET",
  "GET",
  "GET",
  "GET",
  "GET",
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

/** Path shapes. `canonical` is the only one that must reach the route; the
 * gateway-prefix variants normalize to it by design (last "/v1/" wins). */
type PathShape =
  | "canonical"
  | "gateway_prefixed"
  | "double_v1"
  | "trailing_slash"
  | "double_slash"
  | "case_variant"
  | "encoded_dot"
  | "encoded_me"
  | "traversal"
  | "child_segment"
  | "long_segment"
  | "hostile_segment"
  | "bad_escape"
  | "nul_segment"
  | "no_v1";

const PATH_SHAPES: readonly PathShape[] = [
  "canonical",
  "canonical",
  "canonical",
  "canonical",
  "gateway_prefixed",
  "double_v1",
  "trailing_slash",
  "double_slash",
  "case_variant",
  "encoded_dot",
  "encoded_me",
  "traversal",
  "child_segment",
  "long_segment",
  "hostile_segment",
  "bad_escape",
  "nul_segment",
  "no_v1",
];

/** Shapes that still resolve to `/v1/me` after normalization. */
const ROUTED_SHAPES: ReadonlySet<PathShape> = new Set<PathShape>([
  "canonical",
  "gateway_prefixed",
  "double_v1",
]);

const FUZZ_HEADER_NAMES: readonly string[] = [
  "x-request-id",
  "content-type",
  "accept",
  "accept-encoding",
  "accept-language",
  "user-agent",
  "origin",
  "referer",
  "cookie",
  "range",
  "if-none-match",
  "x-client-info",
  "x-forwarded-host",
  "x-forwarded-proto",
  "apikey",
  "prefer",
  "expect",
];

/** Upstream faults. Bad input must never produce a 5xx; a broken upstream
 * may — but only a generic 503 with Retry-After, never its detail. The canary
 * is what the fake upstream says; it must not reach the client. */
type Fault =
  | { kind: "none" }
  | { kind: "gotrue_user_status"; status: number }
  | { kind: "gotrue_user_body"; body: string }
  | { kind: "profiles_status"; status: number; body: string }
  | { kind: "profiles_body"; body: string };

const FAULT_CANARY = "CANARY-upstream-detail-0x5eed";
/** GoTrue statuses that are a verdict on the credential (index.ts
 * AUTH_REFUSAL_STATUSES); every other non-2xx is the service being down. */
const GOTRUE_REFUSALS: ReadonlySet<number> = new Set([400, 401, 403]);
const GOTRUE_FAULT_STATUSES: readonly number[] = [400, 401, 403, 404, 418, 429, 500, 502, 503, 504];
const PROFILES_FAULT_STATUSES: readonly number[] = [
  400, 401, 403, 404, 406, 409, 429, 500, 502, 503, 504,
];

function buildFault(rng: Rng): Fault {
  const shape = rng.int(8);
  if (shape <= 1) return { kind: "gotrue_user_status", status: rng.pick(GOTRUE_FAULT_STATUSES) };
  if (shape === 2) {
    return {
      kind: "gotrue_user_body",
      body: rng.pick([
        "",
        "<html>502 Bad Gateway</html>",
        "null",
        "[]",
        `{"id":"","email":"${FAULT_CANARY}"}`,
        `{"id":42,"detail":"${FAULT_CANARY}"}`,
        `{"user":{"id":"1f000000-0000-4000-8000-0000000000aa"}}`,
        '{"id":',
      ]),
    };
  }
  if (shape <= 5) {
    const status = rng.pick(PROFILES_FAULT_STATUSES);
    return {
      kind: "profiles_status",
      status,
      body: rng.pick([
        `{"code":"42501","message":"permission denied for table profiles ${FAULT_CANARY}"}`,
        `{"code":"PGRST301","message":"JWT expired ${FAULT_CANARY}"}`,
        `{"code":"PGRST116","details":"${FAULT_CANARY}","message":"JSON object requested, multiple (or no) rows returned"}`,
        `<html>${FAULT_CANARY}</html>`,
        "",
      ]),
    };
  }
  return {
    kind: "profiles_body",
    body: rng.pick([
      "",
      "null",
      "[]",
      `<html>${FAULT_CANARY}</html>`,
      '{"id":',
      `{"id":123,"email":{"x":"${FAULT_CANARY}"},"onboarding_state":["complete"],"skill_level":1e999,"first_name":"${FAULT_CANARY}"}`,
      `{"id":"1f000000-0000-4000-8000-0000000000bb","email":null,"onboarding_state":"complete","__proto__":{"admin":true},"constructor":{"prototype":{}}}`,
      `[{"id":"a"},{"id":"b"}]`,
    ]),
  };
}

interface Scenario {
  seed: number;
  tokenKind: TokenKind;
  method: string;
  pathShape: PathShape;
  query: string;
  headers: Record<string, string>;
  fault: Fault;
  /** Declared content-length (boundary probe); undefined = leave to Request. */
  declaredLength?: number;
  bodyBytes?: number;
  bodyKind?: string;
  requestIdHeader?: string;
  requestIdWellFormed: boolean;
}

/** encodeURIComponent that survives the lone surrogates in the alphabet
 * (they are kept as a raw, un-encodable byte sequence instead). */
function enc(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    return encodeURIComponent(value.replace(/[\ud800-\udfff]/g, "\ufffd"));
  }
}

/** Header values must be ByteStrings without CR/LF/control characters or
 * the Request constructor refuses them; the fuzz targets the handler, so
 * out-of-range code units travel percent-encoded and controls become `_`. */
function headerValue(value: string): string {
  return Array.from(value)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) return "_";
      return code > 0xff ? enc(ch) : ch;
    })
    .join("");
}

function buildQuery(rng: Rng): string {
  const shape = rng.int(8);
  if (shape === 0) return "";
  if (shape === 1) return "?";
  if (shape === 2) return `?${"a".repeat(1 + rng.int(4000))}=1`;
  if (shape === 3) {
    // repeated keys
    const key = rng.pick(["select", "id", "limit", "offset", "order", "apikey"]);
    return `?${key}=1&${key}=2&${key}=${enc(rng.hostile(1 + rng.int(12)))}`;
  }
  if (shape === 4) return `?${enc(rng.hostile(1 + rng.int(20)))}`;
  if (shape === 5) return "?select=*&id=eq.00000000-0000-4000-8000-000000000000";
  if (shape === 6) {
    const pairs: string[] = [];
    for (let i = 0; i < 1 + rng.int(12); i += 1) {
      pairs.push(`${enc(rng.hostile(1 + rng.int(8)))}=${enc(rng.hostile(1 + rng.int(24)))}`);
    }
    return `?${pairs.join("&")}`;
  }
  return `?${rng.hostile(1 + rng.int(30))}`;
}

function buildPath(rng: Rng, shape: PathShape): string {
  switch (shape) {
    case "canonical":
      return "/v1/me";
    case "gateway_prefixed":
      return "/api/v1/me";
    case "double_v1":
      return "/v1/x/v1/me";
    case "trailing_slash":
      return "/v1/me/";
    case "double_slash":
      return "//v1//me";
    case "case_variant":
      return rng.pick(["/v1/ME", "/V1/me", "/v1/Me"]);
    case "encoded_dot":
      return "/v1/%2e/me";
    case "encoded_me":
      return "/v1/%6d%65";
    case "traversal":
      return rng.pick(["/v1/me/../me", "/v1/../v1/me", "/v1/me/%2e%2e/me"]);
    case "child_segment":
      return `/v1/me/${enc(rng.hostile(1 + rng.int(10)))}`;
    case "long_segment":
      return `/v1/me${"/x".repeat(200 + rng.int(800))}`;
    case "hostile_segment":
      return `/v1/${enc(rng.hostile(1 + rng.int(20)))}`;
    case "bad_escape":
      return rng.pick(["/v1/me/%zz", "/v1/%/me", "/v1/me%"]);
    case "nul_segment":
      return "/v1/me%00";
    case "no_v1":
      return rng.pick(["/me", "/", "/healthz/../v1/me".replace("..", "x")]);
  }
}

function buildScenario(seed: number): Scenario {
  const rng = makeRng(seed);
  let tokenKind = rng.pick(TOKEN_KINDS);
  let method = rng.pick(METHODS);
  let pathShape = rng.pick(PATH_SHAPES);
  const headers: Record<string, string> = {};

  // Upstream fault iterations (~12%) are aimed at the route so the fault is
  // actually exercised: a live bearer on the canonical GET. Query and header
  // fuzz still apply.
  const fault: Fault = rng.bool(0.12) ? buildFault(rng) : { kind: "none" };
  if (fault.kind !== "none") {
    tokenKind = fault.kind.startsWith("gotrue") ? "session_fresh" : "session";
    method = "GET";
    pathShape = "canonical";
  }

  // Header fuzz (never the IP headers: rate-limit keys stay per-iteration
  // fresh so a budget trip is a deliberate scenario, not generator noise).
  const headerCount = rng.int(4);
  for (let i = 0; i < headerCount; i += 1) {
    const name = rng.pick(FUZZ_HEADER_NAMES);
    // Header values may not contain control characters — the fuzz targets the
    // handler, not the Request constructor.
    headers[name] = headerValue(rng.hostile(1 + rng.int(rng.bool(0.1) ? 3000 : 40)));
  }

  if (rng.bool(0.35)) {
    headers["x-request-id"] = rng.bool(0.5)
      ? `stress-${seed.toString(36)}-${"a".repeat(rng.int(6))}`
      : headerValue(rng.hostile(1 + rng.int(70)));
  }
  // The header fuzz above may have set one too: the oracle reads what is sent.
  const requestIdHeader: string | undefined = headers["x-request-id"];

  const scenario: Scenario = {
    seed,
    tokenKind,
    method,
    pathShape,
    query: buildQuery(rng),
    headers,
    fault,
    requestIdHeader,
    requestIdWellFormed:
      requestIdHeader !== undefined && REQUEST_ID_RE.test(requestIdHeader.trim()),
  };

  // Body / boundary probes. GET and HEAD may carry no body, so their size
  // boundary is probed with a declared content-length only.
  const bodyMethod = method !== "GET" && method !== "HEAD";
  const sizeProbe = fault.kind === "none" ? rng.int(16) : 99;
  if (sizeProbe === 0) scenario.declaredLength = MAX_JSON_BODY_BYTES + 1 + rng.int(1_000_000);
  else if (sizeProbe === 1) scenario.declaredLength = MAX_JSON_BODY_BYTES;
  else if (sizeProbe === 2) scenario.declaredLength = MAX_JSON_BODY_BYTES - 1;
  else if (sizeProbe === 3) scenario.declaredLength = Number.MAX_SAFE_INTEGER;
  if (bodyMethod && rng.bool(0.6)) {
    const kind = rng.int(6);
    if (kind === 0) {
      scenario.bodyKind = "empty";
      scenario.bodyBytes = 0;
    } else if (kind === 1) {
      scenario.bodyKind = "not-json";
      scenario.bodyBytes = 1 + rng.int(200);
    } else if (kind === 2) {
      scenario.bodyKind = "json-scalar";
      scenario.bodyBytes = 4;
    } else if (kind === 3) {
      scenario.bodyKind = "json-object";
      scenario.bodyBytes = 32;
    } else if (kind === 4) {
      scenario.bodyKind = "deep-json";
      scenario.bodyBytes = 200;
    } else {
      scenario.bodyKind = "large";
      scenario.bodyBytes = 200_000 + rng.int(200_000);
    }
  }
  return scenario;
}

function buildBody(scenario: Scenario, rng: Rng): BodyInit | undefined {
  switch (scenario.bodyKind) {
    case undefined:
      return undefined;
    case "empty":
      return "";
    case "not-json":
      return rng.hostile(scenario.bodyBytes ?? 16);
    case "json-scalar":
      return rng.pick(["null", "true", "1e999", '"x"', "[]"]);
    case "json-object":
      return JSON.stringify({ [rng.hostile(4)]: rng.hostile(8), __proto__: { admin: true } });
    case "deep-json": {
      let payload = "1";
      for (let i = 0; i < 300; i += 1) payload = `[${payload}]`;
      return payload;
    }
    case "large":
      return JSON.stringify({ blob: "A".repeat(scenario.bodyBytes ?? 1000) });
    default:
      return undefined;
  }
}

// ─── user pool (keeps per-user budgets out of the generator's way) ──────────

const POOL_SIZE = 64;

function poolUserId(index: number): string {
  const suffix = index.toString(16).padStart(4, "0");
  return `7f000000-0000-4000-8000-00000000${suffix}`;
}

/** Even pool indexes are Google accounts, odd ones Apple (registerUser in
 * runCampaign); a provider ID token must name a user of that provider. */
function poolIndexFor(seed: number, kind: TokenKind): number {
  const index = seed % POOL_SIZE;
  if (kind === "google_id_token") return index - (index % 2);
  if (kind === "apple_id_token") return index | 1;
  return index;
}

interface Outcome {
  seed: number;
  tokenKind: TokenKind;
  method: string;
  pathShape: PathShape;
  fault?: Fault;
  path: string;
  query: string;
  declaredLength?: number;
  bodyKind?: string;
  status: number;
  errorCode?: string;
  requestId: string;
  requestIdEchoed: boolean;
  restCalls: number;
  writeCalls: number;
  accessLogLines: number;
  verdict: "held" | "broken";
  violations: string[];
}

interface RunResult {
  executed: number;
  unbuildable: number;
  outcomes: Outcome[];
  broken: Outcome[];
  /** Requests the runtime itself refused to construct, by reason. */
  unbuildableReasons: Record<string, number>;
  statusCounts: Record<string, number>;
  tokenKindStatuses: Record<string, Record<string, number>>;
  /** "<fault kind>[ <forced status>]" → response status → count. */
  faultStatuses: Record<string, Record<string, number>>;
}

async function bodyTextOf(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** The fault the fetch wrapper installed by runCampaign is currently
 * answering with (body faults are answered there; status faults through
 * the harness's own getUserStatus switch). */
let activeFault: Fault = { kind: "none" };

function faultResponse(url: string, method: string): Response | null {
  const fault = activeFault;
  if (
    fault.kind === "gotrue_user_body" &&
    method === "GET" &&
    url.startsWith(`${SUPABASE_URL}/auth/v1/user`)
  ) {
    return new Response(fault.body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (
    (fault.kind === "profiles_status" || fault.kind === "profiles_body") &&
    url.startsWith(`${SUPABASE_URL}/rest/v1/profiles`)
  ) {
    return new Response(fault.body, {
      status: fault.kind === "profiles_status" ? fault.status : 200,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

function installFaultLayer(): () => void {
  const harnessFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    // The harness still sees (and records) the call; only the answer changes.
    const real = await harnessFetch(input, init);
    const forced = faultResponse(url, method);
    if (!forced) return real;
    await real.body?.cancel();
    return forced;
  };
  return () => {
    globalThis.fetch = harnessFetch;
  };
}

async function runScenario(
  h: SessionHarness,
  scenario: Scenario,
  tokens: {
    sessionFor: (index: number) => string;
    poolIndex: number;
  },
  logLines: string[],
): Promise<Outcome> {
  const rng = makeRng(scenario.seed ^ 0x5f37_1c9b);
  const violations: string[] = [];
  const path = buildPath(rng, scenario.pathShape);
  const url = `http://edge.test/functions/v1/api${path}${scenario.query}`;

  let token: string | null = null;
  switch (scenario.tokenKind) {
    case "session":
    case "session_reused":
      token = tokens.sessionFor(tokens.poolIndex);
      break;
    case "session_fresh":
      token = h.mintSession(poolUserId(tokens.poolIndex)).accessToken;
      break;
    case "google_id_token":
      token = googleIdToken(poolUserId(tokens.poolIndex));
      break;
    case "apple_id_token":
      token = appleIdToken(poolUserId(tokens.poolIndex));
      break;
    case "expired_session":
      token = h.mintSession(poolUserId(tokens.poolIndex), -60 - rng.int(3600)).accessToken;
      break;
    case "forged_session":
      token = forgedSessionToken(poolUserId(tokens.poolIndex));
      break;
    case "unknown_user_session":
      token = forgedSessionToken(seededUuid(rng));
      break;
    case "missing":
      token = null;
      break;
    case "empty":
      token = "";
      break;
    case "garbage":
      token = rng.hostile(1 + rng.int(60)).replace(/[^\x21-\x7e]/g, "z");
      break;
    case "huge":
      token = "e".repeat(4000 + rng.int(8000));
      break;
    case "jwt_fuzz":
      token = fakeJwt({
        iss: rng.pick([
          "https://accounts.google.com.evil.test",
          "https://appleid.apple.com.evil.test",
          `${SUPABASE_URL}/auth/v1/../..`,
          "http://supabase.session.test/auth/v1",
          123,
          null,
          ["https://accounts.google.com"],
          { toString: "x" },
        ]) as unknown as string,
        sub: rng.pick([poolUserId(tokens.poolIndex), "", null, 42, {}]) as unknown as string,
        exp: rng.pick([
          Math.floor(Date.now() / 1000) + 3600,
          Math.floor(Date.now() / 1000) - 1,
          "later",
          Number.NaN,
          null,
        ]) as unknown as number,
        session_id: rng.pick([crypto.randomUUID(), "", null, 7]) as unknown as string,
        role: rng.pick(["authenticated", "service_role", "anon", "postgres"]),
      });
      break;
    case "structural_jwt":
      token = rng.pick([
        "a.b",
        "a.b.c.d",
        "..",
        "eyJhbGciOiJub25lIn0..",
        `${btoa('{"iss":"https://accounts.google.com"}')}`,
        "Bearer Bearer x.y.z",
        `${"x".repeat(20)}.${"y".repeat(20)}.${"z".repeat(20)}`,
      ]);
      break;
  }

  const headers: Record<string, string> = { ...scenario.headers, "x-forwarded-for": freshIp() };
  if (scenario.declaredLength !== undefined) {
    headers["content-length"] = String(scenario.declaredLength);
  }
  if (token !== null) {
    headers["authorization"] =
      scenario.tokenKind === "wrong_scheme"
        ? rng.pick([
            "Basic dXNlcjpwYXNz",
            "bearer " + token,
            "Bearer",
            "Bearer  ",
            "Token " + token,
          ])
        : `Bearer ${token}`;
  } else if (scenario.tokenKind === "wrong_scheme") {
    headers["authorization"] = "Basic dXNlcjpwYXNz";
  }
  if (scenario.tokenKind === "wrong_scheme" && !headers["authorization"]) {
    headers["authorization"] = "Basic dXNlcjpwYXNz";
  }

  const body = buildBody(scenario, rng);
  const request = new Request(url, {
    method: scenario.method,
    headers,
    body: body === undefined ? undefined : body,
  });

  const restBefore = h.calls.length;
  logLines.length = 0;
  activeFault = scenario.fault;
  h.getUserStatus = scenario.fault.kind === "gotrue_user_status" ? scenario.fault.status : null;
  let response: Response;
  try {
    response = await h.handler(request);
  } finally {
    activeFault = { kind: "none" };
    h.getUserStatus = null;
  }
  const text = await bodyTextOf(response);
  const newCalls = h.calls.slice(restBefore);
  const restCalls = newCalls.filter((call) => call.url.includes("/rest/v1/")).length;
  const writeCalls = newCalls.filter(
    (call) =>
      call.url.includes("/rest/v1/") &&
      (call.method !== "GET" || call.url.includes("/rest/v1/rpc/")),
  ).length;

  let errorCode: string | undefined;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
    const code = (parsed as { error?: { code?: unknown } })?.error?.code;
    if (typeof code === "string") errorCode = code;
  } catch {
    // Non-JSON body (204/legal text) — nothing to read.
  }

  const requestId = response.headers.get("x-request-id") ?? "";
  const isValidCredential = VALID_TOKEN_KINDS.has(scenario.tokenKind);
  const routed = ROUTED_SHAPES.has(scenario.pathShape);
  const oversizeDeclared =
    scenario.declaredLength !== undefined && scenario.declaredLength > MAX_JSON_BODY_BYTES;
  const fault = scenario.fault;

  // Expected statuses under an upstream fault (the request itself is valid).
  let faultExpected: ReadonlySet<number> | null = null;
  let faultNeedsRetryAfter = false;
  if (fault.kind === "gotrue_user_status") {
    if (GOTRUE_REFUSALS.has(fault.status)) faultExpected = new Set([401]);
    else {
      faultExpected = new Set([503]);
      faultNeedsRetryAfter = true;
    }
  } else if (fault.kind === "gotrue_user_body") {
    faultExpected = new Set([503]);
    faultNeedsRetryAfter = true;
  } else if (fault.kind === "profiles_status") {
    faultExpected = new Set([503]);
  } else if (fault.kind === "profiles_body") {
    // A 200 with a JSON object is a row PostgREST returned, passed through
    // as-is; anything else is a read failure.
    faultExpected = new Set(
      fault.body.startsWith("{") && fault.body.endsWith("}") ? [200, 503] : [503],
    );
  }

  // 1. status allow-list (bad input) — a 503 is only ever an upstream fault
  if (!ALLOWED_STATUSES.has(response.status) && !(faultExpected && response.status === 503)) {
    violations.push(`status ${response.status} outside allow-list`);
  }

  // 2. no 200 without a live credential
  if (!isValidCredential && response.status === 200) {
    violations.push(`auth bypass: 200 for token kind ${scenario.tokenKind}`);
  }

  // 2b. a live credential on the canonical GET must be served
  if (
    isValidCredential &&
    routed &&
    scenario.method === "GET" &&
    !oversizeDeclared &&
    faultExpected === null &&
    response.status !== 200 &&
    response.status !== 429
  ) {
    violations.push(`live credential refused with ${response.status}`);
  }

  // 2c. an upstream fault maps to exactly the documented status
  if (faultExpected && response.status !== 429 && !faultExpected.has(response.status)) {
    violations.push(
      `upstream fault ${fault.kind} answered ${response.status}, expected ${[...faultExpected].join("|")}`,
    );
  }
  if (faultNeedsRetryAfter && response.status === 503 && !response.headers.get("Retry-After")) {
    violations.push("503 on an Auth outage carries no Retry-After");
  }

  // 3. no internal detail / stack traces / bearer echo in any body; a 5xx
  //    body is the generic sentence and nothing else
  const haystack = text.slice(0, 200_000);
  if (response.status >= 500) {
    if (faultExpected === null) violations.push(`5xx response: ${response.status}`);
    const error = (parsed as { error?: { message?: unknown } } | null)?.error;
    const message = typeof error?.message === "string" ? error.message : "";
    if (!/^[A-Z][A-Za-z ]+ is temporarily unavailable\. Please try again\.$/.test(message)) {
      violations.push(`5xx body is not the generic sentence: ${text.slice(0, 120)}`);
    }
    const extra =
      parsed && typeof parsed === "object" ? Object.keys(parsed).filter((k) => k !== "error") : [];
    const extraInner =
      error && typeof error === "object" ? Object.keys(error).filter((k) => k !== "message") : [];
    if (extra.length > 0 || extraInner.length > 0) {
      violations.push(`5xx body carries extra fields ${[...extra, ...extraInner].join(",")}`);
    }
  }
  if (haystack.includes(FAULT_CANARY)) {
    // Only a 200 passing a row through may carry the row's own text.
    if (!(response.status === 200 && fault.kind === "profiles_body")) {
      violations.push("body leaks the upstream fault detail");
    }
  }
  for (const marker of LEAK_MARKERS) {
    if (haystack.includes(marker)) violations.push(`body leaks internal marker ${marker}`);
  }
  if (token && token.length >= 12 && haystack.includes(token)) {
    violations.push("body echoes the bearer token");
  }

  // 4. no write on this read-only route, rejected or served
  if (writeCalls > 0) violations.push(`${writeCalls} PostgREST write/RPC call(s)`);

  // 4b. 429 and 503 answers carry the retry contract headers
  if (response.status === 429) {
    for (const name of ["Retry-After", "RateLimit-Limit", "RateLimit-Remaining"]) {
      if (!response.headers.get(name)) violations.push(`429 without ${name}`);
    }
  }

  // 5. request-id contract
  if (!requestId) violations.push("missing x-request-id");
  else if (scenario.requestIdWellFormed) {
    if (requestId !== scenario.requestIdHeader!.trim()) {
      violations.push("well-formed client request id not echoed");
    }
  } else if (!UUID_RE.test(requestId)) {
    violations.push(`minted request id is not a uuid: ${requestId}`);
  }

  // 6. exactly one categorical access-log line, status-matched, leak-free
  if (logLines.length !== 1) {
    violations.push(`${logLines.length} access-log lines`);
  } else {
    try {
      const entry = JSON.parse(logLines[0]) as Record<string, unknown>;
      if (entry.evt !== "api_request") violations.push("access log evt mismatch");
      if (entry.status !== response.status) violations.push("access log status mismatch");
      if (entry.requestId !== requestId) violations.push("access log request id mismatch");
      if (typeof entry.durationMs !== "number" || entry.durationMs < 0) {
        violations.push("access log durationMs invalid");
      }
      if (token && token.length >= 12 && logLines[0].includes(token)) {
        violations.push("access log carries the bearer");
      }
      // Categorical only: no query string, and no field beyond the documented
      // shape (a new one could smuggle a user id, body or header value).
      if (typeof entry.route !== "string" || entry.route.includes("?")) {
        violations.push("access log route carries a query string");
      }
      for (const field of Object.keys(entry)) {
        if (!ACCESS_LOG_FIELDS.has(field)) violations.push(`access log carries field ${field}`);
      }
    } catch {
      violations.push("access log line is not JSON");
    }
  }

  // 7. the profiles read is scoped to the caller
  for (const call of newCalls) {
    if (!call.url.includes("/rest/v1/profiles")) continue;
    const bearer = (call.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    if (!bearer) violations.push("profiles read carried no bearer");
    const expectedId = poolUserId(tokens.poolIndex);
    if (!call.url.includes(`id=eq.${expectedId}`)) {
      violations.push("profiles read not scoped to the caller id");
    }
  }

  // 8. security headers on JSON bodies
  if ((response.headers.get("content-type") ?? "").includes("application/json")) {
    for (const [name, value] of Object.entries(JSON_SECURITY_HEADERS)) {
      if (name === "Content-Type") continue;
      if (response.headers.get(name) !== value) {
        violations.push(`missing security header ${name}`);
      }
    }
  }

  return {
    seed: scenario.seed,
    tokenKind: scenario.tokenKind,
    method: scenario.method,
    pathShape: scenario.pathShape,
    fault: fault.kind === "none" ? undefined : fault,
    path,
    query: scenario.query.slice(0, 120),
    declaredLength: scenario.declaredLength,
    bodyKind: scenario.bodyKind,
    status: response.status,
    errorCode,
    requestId,
    requestIdEchoed: Boolean(
      scenario.requestIdWellFormed && requestId === scenario.requestIdHeader,
    ),
    restCalls,
    writeCalls,
    accessLogLines: logLines.length,
    verdict: violations.length === 0 ? "held" : "broken",
    violations,
  };
}

async function runCampaign(seeds: readonly number[]): Promise<RunResult> {
  const h = await loadSessionHarness();
  for (let i = 0; i < POOL_SIZE; i += 1) {
    h.registerUser({
      id: poolUserId(i),
      email: `pool-${i}@example.test`,
      provider: i % 2 === 0 ? "google" : "apple",
    });
  }
  const sessions = new Map<number, string>();
  const sessionFor = (index: number): string => {
    const existing = sessions.get(index);
    if (existing) return existing;
    const minted = h.mintSession(poolUserId(index)).accessToken;
    sessions.set(index, minted);
    return minted;
  };

  const logLines: string[] = [];
  const restore = captureAccessLog((line) => logLines.push(line));
  const removeFaultLayer = installFaultLayer();
  const outcomes: Outcome[] = [];
  const unbuildableReasons: Record<string, number> = {};
  let unbuildable = 0;
  try {
    for (let i = 0; i < seeds.length; i += 1) {
      const seed = seeds[i];
      const scenario = buildScenario(seed);
      const poolIndex = poolIndexFor(seed, scenario.tokenKind);
      try {
        outcomes.push(await runScenario(h, scenario, { sessionFor, poolIndex }, logLines));
      } catch (error) {
        // A Request the runtime refuses to construct is a generator limit, not
        // a handler outcome: it is reported, never counted as executed.
        const message = error instanceof Error ? error.message : String(error);
        if (/body|header|Invalid|not allowed|Failed to parse/i.test(message)) {
          unbuildable += 1;
          const reason = message.slice(0, 80);
          unbuildableReasons[reason] = (unbuildableReasons[reason] ?? 0) + 1;
          continue;
        }
        throw new Error(`seed ${seed} threw out of the handler: ${message}`, { cause: error });
      }
    }
  } finally {
    removeFaultLayer();
    restore();
  }

  const statusCounts: Record<string, number> = {};
  const tokenKindStatuses: Record<string, Record<string, number>> = {};
  const faultStatuses: Record<string, Record<string, number>> = {};
  for (const outcome of outcomes) {
    statusCounts[outcome.status] = (statusCounts[outcome.status] ?? 0) + 1;
    const perKind = (tokenKindStatuses[outcome.tokenKind] ??= {});
    perKind[outcome.status] = (perKind[outcome.status] ?? 0) + 1;
    if (outcome.fault) {
      const label =
        "status" in outcome.fault
          ? `${outcome.fault.kind} ${outcome.fault.status}`
          : outcome.fault.kind;
      const perFault = (faultStatuses[label] ??= {});
      perFault[outcome.status] = (perFault[outcome.status] ?? 0) + 1;
    }
  }
  return {
    executed: outcomes.length,
    unbuildable,
    unbuildableReasons,
    outcomes,
    broken: outcomes.filter((outcome) => outcome.verdict === "broken"),
    statusCounts,
    tokenKindStatuses,
    faultStatuses,
  };
}

function seedsFromEnv(): number[] {
  const explicit = (Deno.env.get("STRESS_SEEDS") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isFinite(value));
  if (explicit.length > 0) return explicit;
  const iterations = Number(Deno.env.get("STRESS_ITER") ?? "150");
  const base = Number(Deno.env.get("STRESS_BASE_SEED") ?? "20260904");
  const count = Number.isInteger(iterations) && iterations > 0 ? iterations : 150;
  const seeds: number[] = [];
  // Seeds are a deterministic sequence, so iteration N of any run is the same
  // request, and one seed replays alone via STRESS_SEEDS.
  for (let i = 0; i < count; i += 1) seeds.push((base + i * 2654435761) >>> 0);
  return seeds;
}

Deno.test("stress: GET /v1/me fuzz + boundary campaign (seeded, replayable)", async () => {
  const seeds = seedsFromEnv();
  const started = Date.now();
  const result = await runCampaign(seeds);
  const durationMs = Date.now() - started;

  const out = Deno.env.get("STRESS_OUT");
  if (out) {
    const table = {
      unit: "route-get-v1-me",
      lens: "fuzz-boundary",
      generatedAt: new Date().toISOString(),
      baseSeed: Number(Deno.env.get("STRESS_BASE_SEED") ?? "20260904"),
      requested: seeds.length,
      executed: result.executed,
      unbuildable: result.unbuildable,
      unbuildableReasons: result.unbuildableReasons,
      durationMs,
      statusCounts: result.statusCounts,
      tokenKindStatuses: result.tokenKindStatuses,
      faultStatuses: result.faultStatuses,
      brokenCount: result.broken.length,
      broken: result.broken,
      rows: result.outcomes,
    };
    await Deno.writeTextFile(out, JSON.stringify(table, null, 2));
  }

  const summary = {
    executed: result.executed,
    unbuildable: result.unbuildable,
    unbuildableReasons: result.unbuildableReasons,
    durationMs,
    statuses: result.statusCounts,
    faults: result.faultStatuses,
    broken: result.broken.length,
  };
  console.log(`[stress route-get-v1-me] ${JSON.stringify(summary)}`);

  assert(result.executed > 0, "no scenario executed");
  assertEquals(
    result.broken.map((outcome) => ({ seed: outcome.seed, violations: outcome.violations })),
    [],
    "every generated request must hold the route's contract",
  );
  // A campaign that never reaches the route (all requests rejected early)
  // would assert nothing about it.
  assert((result.statusCounts["200"] ?? 0) > 0, "no request reached the route");
  assert((result.statusCounts["401"] ?? 0) > 0, "no request was refused as unauthenticated");
});

Deno.test(
  "stress: declared oversize bodies are refused with 413 before authentication",
  async () => {
    const h = await loadSessionHarness();
    const restore = captureAccessLog(() => {});
    try {
      for (const declared of [
        MAX_JSON_BODY_BYTES + 1,
        MAX_JSON_BODY_BYTES * 3,
        9_007_199_254_740_991,
      ]) {
        const before = h.calls.length;
        const response = await h.handler(
          new Request("http://edge.test/functions/v1/api/v1/me", {
            method: "POST",
            headers: {
              "content-length": String(declared),
              "x-forwarded-for": freshIp(),
              authorization: "Bearer not-a-token",
            },
          }),
        );
        const body = await response.text();
        assertEquals(response.status, 413, `declared ${declared}`);
        assert(!body.includes("    at "), "413 body carries a stack trace");
        assertEquals(h.calls.slice(before).length, 0, "413 reached upstream");
        assert(response.headers.get("x-request-id"), "413 carries no request id");
      }
      // The boundary itself is not oversize.
      const atLimit = await h.handler(
        new Request("http://edge.test/functions/v1/api/v1/me", {
          method: "POST",
          headers: {
            "content-length": String(MAX_JSON_BODY_BYTES),
            "x-forwarded-for": freshIp(),
            authorization: "Bearer not-a-token",
          },
        }),
      );
      await atLimit.body?.cancel();
      assertEquals(atLimit.status, 401, "the size boundary must fall through to authentication");
    } finally {
      restore();
    }
  },
);

Deno.test("stress: the per-user budget on GET /v1/me answers 429, never 5xx", async () => {
  const h = await loadSessionHarness();
  const userId = poolUserId(POOL_SIZE + 1);
  h.registerUser({ id: userId, email: "budget@example.test", provider: "google" });
  const token = h.mintSession(userId).accessToken;
  const ip = freshIp();
  const restore = captureAccessLog(() => {});
  const statuses = new Set<number>();
  try {
    // GENERAL_USER_LIMIT is 240/60s; 260 requests inside one window must end
    // in 429s and nothing else.
    for (let i = 0; i < 260; i += 1) {
      const response = await h.handler(apiRequest("GET", "/v1/me", { token, ip }));
      await response.body?.cancel();
      statuses.add(response.status);
      assert(response.status < 500, `iteration ${i} answered ${response.status}`);
    }
  } finally {
    restore();
  }
  assert(statuses.has(200), "no request was served");
  assert(statuses.has(429), "the per-user budget never engaged");
  assertEquals(
    [...statuses].filter((status) => status !== 200 && status !== 429),
    [],
  );
});
