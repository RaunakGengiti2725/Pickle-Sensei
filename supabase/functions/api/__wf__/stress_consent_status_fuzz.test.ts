// Fuzz/boundary campaign against the REAL edge handler for
// `GET /v1/me/consent/status` (supabase/functions/api/index.ts →
// loadConsentRows + foldConsentStatus), driven in-process through
// sessionHarness.ts (stateful fake GoTrue + PostgREST, no network).
//
// Every iteration is generated from one integer seed (mulberry32), so any
// outcome is replayable in isolation:
//
//   # default (fast, lives in the suite via `deno task test`)
//   cd supabase/functions/api/__wf__ && \
//     deno test -A --no-check --config deno.json stress_consent_status_fuzz.test.ts
//   # full campaign + JSON seed→outcome table
//   STRESS_ITER=3000 STRESS_OUT=/tmp/consent_status_fuzz.json \
//     deno test -A --no-check --config deno.json stress_consent_status_fuzz.test.ts
//   # replay specific seeds (minimization / flake rate)
//   STRESS_SEEDS=418,419 STRESS_REPEAT=10 \
//     deno test -A --no-check --config deno.json stress_consent_status_fuzz.test.ts
//
// Invariants asserted on every generated request:
//   1. bad input answers only 400/401/403/404/405/413/415/429 — never 2xx,
//      never 5xx; a well-formed request answers 200 (or 429 under budget);
//      an injected upstream outage answers 503 with the generic body;
//   2. the ordering contract holds: an oversized Content-Length is refused
//      before authentication, a bad bearer before routing;
//   3. every response carries `x-request-id`; a well-formed client id is
//      echoed, a malformed one is replaced by a fresh UUID;
//   4. no response body leaks a stack trace, a source path, the Supabase
//      URL, a bearer or a PostgREST/GoTrue detail;
//   5. a rejected request performs no write (no POST/PATCH/DELETE/PUT to
//      PostgREST) and no read; a served request reads `consent_records`
//      exactly once, scoped to the caller, as the caller (never service role);
//   6. a 200 body is exactly the three canonical scopes, in canonical order,
//      folded to the values an independent model computes from the stubbed
//      ledger — attacker-controlled scopes are never reflected — and a
//      repeated request answers identically (auth-cache path);
//   7. one access-log line per request, correlated by request id and status.

import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import {
  SUPABASE_URL,
  type SessionHarness,
  fakeJwt,
  forgedSessionToken,
  googleIdToken,
  jwtPayload,
  loadSessionHarness,
} from "./sessionHarness.ts";

const ROUTE_PATH = "/v1/me/consent/status";
const GATEWAY_PREFIX = "http://edge.test/functions/v1/api";
/** The one client IP a slice of iterations share so the 429 path is reached. */
const SHARED_IP = "198.18.255.255";
const MAX_JSON_BODY_BYTES = 5_000_000;
const CANONICAL_SCOPES = ["video_analysis", "model_training", "evaluation_telemetry"] as const;
const ALLOWED_REJECTION_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 429]);
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_5XX_RE =
  /^(?:[A-Za-z ]+ is temporarily unavailable\. Please try again\.|Something went wrong\. Please try again\.)$/;

const ITERATIONS = (() => {
  const configured = Number(Deno.env.get("STRESS_ITER"));
  return Number.isInteger(configured) && configured > 0 ? configured : 120;
})();
const BASE_SEED = (() => {
  const configured = Number(Deno.env.get("STRESS_SEED"));
  return Number.isInteger(configured) ? configured : 1;
})();
/** Comma-separated seeds to replay instead of a sweep (minimization). */
const REPLAY_SEEDS = (Deno.env.get("STRESS_SEEDS") ?? "")
  .split(",")
  .map((part) => part.trim())
  .filter((part) => part.length > 0)
  .map(Number)
  .filter((value) => Number.isInteger(value));
/** How many times each seed is executed (flake rate of a failing seed). */
const REPEAT = (() => {
  const configured = Number(Deno.env.get("STRESS_REPEAT"));
  return Number.isInteger(configured) && configured > 0 ? configured : 1;
})();
const OUT_PATH = Deno.env.get("STRESS_OUT") ?? "";

// ── Seeded RNG ───────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  #next: () => number;
  constructor(seed: number) {
    this.#next = mulberry32(seed);
  }
  int(maxExclusive: number): number {
    return Math.floor(this.#next() * maxExclusive);
  }
  pick<T>(values: readonly T[]): T {
    return values[this.int(values.length)];
  }
  chance(probability: number): boolean {
    return this.#next() < probability;
  }
  hex(length: number): string {
    let out = "";
    for (let i = 0; i < length; i += 1) out += this.int(16).toString(16);
    return out;
  }
  uuid(): string {
    return `${this.hex(8)}-${this.hex(4)}-4${this.hex(3)}-8${this.hex(3)}-${this.hex(12)}`;
  }
}

// ── Hostile corpora (never contain a leak sentinel, so a reflected value can
// never be mistaken for a leak) ──────────────────────────────────────────────

const HOSTILE_STRINGS: readonly string[] = [
  "",
  " ",
  "\t\t",
  "0",
  "-1",
  "1e309",
  "NaN",
  "null",
  "undefined",
  "true",
  "%",
  "%zz",
  "%%%%",
  "%00",
  "..",
  "../..",
  "./.",
  "*",
  "select=*",
  "eq.00000000-0000-4000-8000-000000000000",
  "'; drop table consent_records; --",
  '" or 1=1 --',
  "{}",
  "[]",
  '{"scope":"video_analysis"}',
  "<script>x</script>",
  "\u0000",
  "\u200b\u202e",
  "\ud83d\ude00",
  "\uffff",
  "ünïcödé",
  "a".repeat(64),
  "a".repeat(1024),
  "a".repeat(8192),
  "-".repeat(200),
  "0".repeat(400),
  "video_analysis",
  "model_training",
  "evaluation_telemetry",
  "consent_records",
  "grant",
  "withdraw",
];

const QUERY_KEYS: readonly string[] = [
  "select",
  "scope",
  "user_id",
  "order",
  "limit",
  "offset",
  "and",
  "or",
  "id",
  "consent_version",
  "apikey",
  "x",
  "",
  "a".repeat(300),
  "\u0000",
];

const HEADER_KEYS: readonly string[] = [
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "prefer",
  "range",
  "if-none-match",
  "x-client-info",
  "x-forwarded-host",
  "x-original-url",
  "x-http-method-override",
  "x-supabase-api-version",
  "cookie",
  "origin",
  "referer",
  "x-custom-fuzz",
];

const METHODS: readonly string[] = [
  ...Array<string>(20).fill("GET"),
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "BREW",
  "get",
  "SEARCH",
];

type PathShape =
  | "exact"
  | "double_slash"
  | "trailing_slash"
  | "uppercase"
  | "extra_segment"
  | "encoded_slash"
  | "encoded_pct"
  | "dot_segments"
  | "long_segment"
  | "unicode_segment"
  | "nested_v1"
  | "no_v1"
  | "sibling_route"
  | "empty_segment";

const PATH_SHAPES: readonly PathShape[] = [
  ...Array<PathShape>(20).fill("exact"),
  "double_slash",
  "trailing_slash",
  "uppercase",
  "extra_segment",
  "encoded_slash",
  "encoded_pct",
  "dot_segments",
  "long_segment",
  "unicode_segment",
  "nested_v1",
  "no_v1",
  "sibling_route",
  "empty_segment",
];

type BearerShape =
  | "session"
  | "provider_google"
  | "provider_apple"
  | "missing"
  | "empty"
  | "no_scheme"
  | "basic"
  | "lowercase_scheme"
  | "garbage"
  | "two_segments"
  | "unparsable_payload"
  | "expired_session"
  | "expired_provider"
  | "forged_session"
  | "unknown_issuer"
  | "email_provider"
  | "revoked_session"
  | "huge"
  | "whitespace";

const BEARER_SHAPES: readonly BearerShape[] = [
  ...Array<BearerShape>(12).fill("session"),
  ...Array<BearerShape>(3).fill("provider_google"),
  ...Array<BearerShape>(3).fill("provider_apple"),
  "missing",
  "empty",
  "no_scheme",
  "basic",
  "lowercase_scheme",
  "garbage",
  "two_segments",
  "unparsable_payload",
  "expired_session",
  "expired_provider",
  "forged_session",
  "unknown_issuer",
  "email_provider",
  "revoked_session",
  "huge",
  "whitespace",
];

const AUTHED_BEARERS: ReadonlySet<BearerShape> = new Set<BearerShape>([
  "session",
  "provider_google",
  "provider_apple",
]);

/** Upstream behaviour injected for the one read the route performs. */
type UpstreamShape =
  | "rows" // PostgREST answers the stubbed ledger
  | "null_body" // 200 `null` (no rows)
  | "pgrst_error" // PostgREST error JSON (4xx/5xx)
  | "html_200" // gateway page instead of JSON
  | "network_throw" // socket failure
  | "non_array_200"; // 200 with a JSON object — outside PostgREST's contract

const UPSTREAM_SHAPES: readonly UpstreamShape[] = [
  "rows",
  "rows",
  "rows",
  "rows",
  "rows",
  "rows",
  "rows",
  "null_body",
  "pgrst_error",
  "html_200",
  "network_throw",
  "non_array_200",
];

/** GoTrue answer forced for GET /auth/v1/user (session bearers only). */
const GOTRUE_FAULTS: readonly number[] = [500, 502, 503, 504, 429, 400, 403];

// ── Generated case ───────────────────────────────────────────────────────────

interface LedgerRow {
  scope: string;
  action: string;
  consent_version: string | null;
  created_at: string;
}

interface FuzzCase {
  seed: number;
  method: string;
  pathShape: PathShape;
  url: string;
  ip: string;
  bearerShape: BearerShape;
  headerNames: string[];
  requestIdSent: string | null;
  contentLengthSent: string | null;
  rows: LedgerRow[];
  upstream: UpstreamShape;
  upstreamStatus: number | null;
  gotrueFault: number | null;
  repeat: boolean;
  request: Request;
  /** The user the bearer authenticates as, when it authenticates at all. */
  userId: string | null;
}

function pathFor(rng: Rng, shape: PathShape): string {
  switch (shape) {
    case "exact":
      return ROUTE_PATH;
    case "double_slash":
      return `/${ROUTE_PATH}`;
    case "trailing_slash":
      return `${ROUTE_PATH}/`;
    case "uppercase":
      return "/v1/me/consent/STATUS";
    case "extra_segment":
      return `${ROUTE_PATH}/${encodeURIComponent(rng.pick(HOSTILE_STRINGS)) || "x"}`;
    case "encoded_slash":
      return "/v1%2Fme%2Fconsent%2Fstatus";
    case "encoded_pct":
      return "/v1/me/consent/status%ZZ";
    case "dot_segments":
      return "/v1/me/consent/./status";
    case "long_segment":
      return `/v1/me/consent/status${"a".repeat(4096)}`;
    case "unicode_segment":
      return "/v1/me/consent/stätus";
    case "nested_v1":
      return `/v1/me${ROUTE_PATH}`;
    case "no_v1":
      return "/me/consent/status";
    case "sibling_route":
      // Near misses that are NOT routes of their own (a real sibling route
      // would legitimately answer for itself).
      return rng.pick([
        "/v1/me/consent",
        "/v1/me/consents/status",
        "/v1/",
        "/v1/me/consent/status2",
      ]);
    case "empty_segment":
      return "/v1/me//consent/status";
  }
}

function queryFor(rng: Rng): string {
  if (rng.chance(0.45)) return "";
  const parts: string[] = [];
  const count = 1 + rng.int(4);
  for (let i = 0; i < count; i += 1) {
    const key = rng.pick(QUERY_KEYS);
    const value = rng.pick(HOSTILE_STRINGS);
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return `?${parts.join("&")}`;
}

/** One synthetic Google/Apple user per iteration so per-user budgets never
 * bleed between cases (the fake GoTrue mints for any registered user). */
function registerUser(h: SessionHarness, rng: Rng, provider: "google" | "apple"): string {
  const id = rng.uuid();
  h.registerUser({ id, email: `${id}@example.com`, provider });
  return id;
}

function bearerFor(
  h: SessionHarness,
  rng: Rng,
  shape: BearerShape,
): {
  header: string | null;
  userId: string | null;
} {
  switch (shape) {
    case "session": {
      const userId = registerUser(h, rng, rng.chance(0.5) ? "google" : "apple");
      return { header: `Bearer ${h.mintSession(userId).accessToken}`, userId };
    }
    case "provider_google": {
      const userId = registerUser(h, rng, "google");
      return { header: `Bearer ${googleIdToken(userId)}`, userId };
    }
    case "provider_apple": {
      const userId = registerUser(h, rng, "apple");
      return {
        header: `Bearer ${fakeJwt({
          iss: "https://appleid.apple.com",
          sub: userId,
          exp: Math.floor(Date.now() / 1000) + 3600,
        })}`,
        userId,
      };
    }
    case "missing":
      return { header: null, userId: null };
    case "empty":
      return { header: "Bearer ", userId: null };
    case "no_scheme":
      return { header: googleIdToken(registerUser(h, rng, "google")), userId: null };
    case "basic":
      return { header: "Basic dXNlcjpwYXNz", userId: null };
    case "lowercase_scheme":
      return { header: `bearer ${googleIdToken(registerUser(h, rng, "google"))}`, userId: null };
    case "garbage":
      return { header: `Bearer ${rng.pick(HOSTILE_STRINGS) || "."}`, userId: null };
    case "two_segments":
      return { header: "Bearer aaa.bbb", userId: null };
    case "unparsable_payload":
      return { header: "Bearer aaa.!!!!.ccc", userId: null };
    case "expired_session": {
      const expired = h.mintSession(registerUser(h, rng, "google"), -3600).accessToken;
      return { header: `Bearer ${expired}`, userId: null };
    }
    case "expired_provider":
      return {
        header: `Bearer ${googleIdToken(registerUser(h, rng, "google"), -60)}`,
        userId: null,
      };
    case "forged_session":
      return { header: `Bearer ${forgedSessionToken(rng.uuid())}`, userId: null };
    case "unknown_issuer":
      return {
        header: `Bearer ${fakeJwt({
          iss: "https://accounts.example.com",
          sub: rng.uuid(),
          exp: Math.floor(Date.now() / 1000) + 3600,
        })}`,
        userId: null,
      };
    case "email_provider": {
      const id = rng.uuid();
      h.registerUser({ id, email: `${id}@example.com`, provider: "email" });
      return { header: `Bearer ${h.mintSession(id).accessToken}`, userId: null };
    }
    case "revoked_session": {
      const session = h.mintSession(registerUser(h, rng, "google"));
      session.revoked = true;
      return { header: `Bearer ${session.accessToken}`, userId: null };
    }
    case "huge":
      return { header: `Bearer ${"A".repeat(20_000)}`, userId: null };
    case "whitespace":
      return { header: "Bearer    \t  ", userId: null };
  }
}

function rowsFor(rng: Rng): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const count = rng.int(7);
  for (let i = 0; i < count; i += 1) {
    rows.push({
      scope: rng.chance(0.7) ? rng.pick(CANONICAL_SCOPES) : rng.pick(HOSTILE_STRINGS),
      action: rng.chance(0.75) ? rng.pick(["grant", "withdraw"]) : rng.pick(HOSTILE_STRINGS),
      consent_version: rng.chance(0.2) ? null : rng.pick(["1.0", "2026-09-01", "v9"]),
      created_at: rng.chance(0.85)
        ? new Date(1_760_000_000_000 + i * 1_000).toISOString()
        : rng.pick(["", "not-a-date", "0000-00-00"]),
    });
  }
  return rows;
}

function buildCase(h: SessionHarness, seed: number): FuzzCase {
  const rng = new Rng(seed);
  const method = rng.pick(METHODS);
  const pathShape = rng.pick(PATH_SHAPES);
  const url = `${GATEWAY_PREFIX}${pathFor(rng, pathShape)}${queryFor(rng)}`;
  const bearerShape = rng.pick(BEARER_SHAPES);
  const bearer = bearerFor(h, rng, bearerShape);

  const headers = new Headers();
  if (bearer.header !== null) {
    headers.set("Authorization", headerSafe(bearer.header));
  }
  // A fresh IP per iteration keeps the per-IP and auth-failure budgets from
  // bleeding between unrelated cases; a slice of iterations shares one on
  // purpose so the 429 path is exercised too.
  const ip = rng.chance(0.9) ? `198.18.${(seed >> 8) & 0xff}.${seed & 0xff}` : SHARED_IP;
  headers.set("x-forwarded-for", ip);

  let requestIdSent: string | null = null;
  if (rng.chance(0.5)) {
    requestIdSent = rng.chance(0.5)
      ? `fuzz-${seed}-${"0".repeat(4)}`
      : rng.pick(["short", "", " ", "bad id!", "a".repeat(65), "%00", "../../etc/passwd"]);
    headers.set("x-request-id", headerSafe(requestIdSent));
    requestIdSent = headers.get("x-request-id");
  }

  let contentLengthSent: string | null = null;
  if (rng.chance(0.2)) {
    contentLengthSent = rng.pick([
      String(MAX_JSON_BODY_BYTES + 1),
      String(MAX_JSON_BODY_BYTES),
      "999999999999999999999",
      "-1",
      "abc",
      "0",
      "1e10",
    ]);
    headers.set("content-length", contentLengthSent);
  }

  const headerNames: string[] = [];
  const extra = rng.int(4);
  for (let i = 0; i < extra; i += 1) {
    const key = rng.pick(HEADER_KEYS);
    const value = headerSafe(rng.pick(HOSTILE_STRINGS));
    try {
      headers.set(key, value);
      headerNames.push(key);
    } catch {
      // A value the platform itself refuses is not a server behaviour.
    }
  }

  const bodyAllowed = method !== "GET" && method !== "HEAD" && method !== "get";
  const body = bodyAllowed && rng.chance(0.5) ? rng.pick(HOSTILE_STRINGS) : undefined;

  // postgrest-js (2.112.4) retries a GET that fails at the socket with a
  // fixed 1 s / 2 s / 4 s backoff before surfacing the error, so every
  // `network_throw` costs the campaign ~7 s of wall clock; keep it rare.
  const picked = rng.pick(UPSTREAM_SHAPES);
  const upstream: UpstreamShape = picked === "network_throw" && !rng.chance(0.15) ? "rows" : picked;
  const upstreamStatus =
    upstream === "pgrst_error" ? rng.pick([400, 401, 403, 404, 406, 500, 502, 503]) : null;
  const gotrueFault =
    bearerShape === "session" && rng.chance(0.12) ? rng.pick(GOTRUE_FAULTS) : null;
  const repeat = rng.chance(0.3);

  const request = new Request(url, { method, headers, body });
  return {
    seed,
    method,
    pathShape,
    url,
    ip,
    bearerShape,
    headerNames,
    requestIdSent,
    contentLengthSent,
    rows: rowsFor(rng),
    upstream,
    upstreamStatus,
    gotrueFault,
    repeat,
    request,
    userId: bearer.userId,
  };
}

// ── Independent model of the contract ────────────────────────────────────────

/** What the handler would see for this header value on the wire: the UTF-8
 * bytes read back as a ByteString (one char per byte, the way `Headers`
 * exposes a raw header), minus the three bytes the platform's `Headers`
 * class itself refuses (CR, LF, NUL). */
function headerSafe(value: string): string {
  return Array.from(new TextEncoder().encode(value))
    .filter((byte) => byte !== 0x0d && byte !== 0x0a && byte !== 0x00)
    .map((byte) => String.fromCharCode(byte))
    .join("");
}

/** The router's own normalization, restated from the URL semantics (route on
 * everything from the LAST "/v1/" segment onward). */
function normalizedPath(request: Request): string {
  const pathname = new URL(request.url).pathname;
  const at = pathname.lastIndexOf("/v1/");
  return at >= 0 ? pathname.slice(at) : pathname;
}

interface Expectation {
  /** true when the request is a valid, authenticated GET of the route. */
  wellFormed: boolean;
  /** true when the request would be served but an injected upstream fault
   * makes a generic 5xx the correct answer. */
  outage: boolean;
  /** The statuses the contract allows (429 is always tolerated on top). */
  allowed: readonly number[];
}

function expectationFor(c: FuzzCase): Expectation {
  const contentLength = Number(c.request.headers.get("content-length") ?? "0");
  const oversized = Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES;
  if (oversized) return { wellFormed: false, outage: false, allowed: [413] };
  const authed = AUTHED_BEARERS.has(c.bearerShape);
  if (!authed) return { wellFormed: false, outage: false, allowed: [401] };
  if (c.gotrueFault !== null) {
    // 400/403 from GoTrue are verdicts on the credential; anything else is
    // the auth service being down, which the edge must report as 503.
    return c.gotrueFault === 400 || c.gotrueFault === 403
      ? { wellFormed: false, outage: false, allowed: [401] }
      : { wellFormed: false, outage: true, allowed: [503] };
  }
  const routed = c.request.method === "GET" && normalizedPath(c.request) === ROUTE_PATH;
  if (!routed) return { wellFormed: false, outage: false, allowed: [404] };
  if (c.upstream === "rows" || c.upstream === "null_body") {
    return { wellFormed: true, outage: false, allowed: [200] };
  }
  if (c.upstream === "non_array_200") {
    // Outside PostgREST's contract (a list select is always an array): the
    // route must still answer a GENERIC 5xx — the fold has no schema guard,
    // so the observed answer is the top-level 500, not the 503 of the other
    // upstream faults (recorded in the campaign report).
    return { wellFormed: false, outage: true, allowed: [500, 503] };
  }
  return { wellFormed: false, outage: true, allowed: [503] };
}

interface ScopeView {
  scope: string;
  active: boolean;
  consentVersion: string | null;
  lastAction: string | null;
  lastActionAt: string | null;
}

/** The fold the route must produce, computed from the stubbed ledger without
 * touching production code: latest row per canonical scope wins, a missing
 * scope is inactive, nothing outside the canonical list is reflected. */
function expectedFold(rows: LedgerRow[]): { subjectPseudonym: null; scopes: ScopeView[] } {
  return {
    subjectPseudonym: null,
    scopes: CANONICAL_SCOPES.map((scope) => {
      const matching = rows.filter((row) => row.scope === scope);
      const last = matching.length === 0 ? null : matching[matching.length - 1];
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

// ── Leak detection ───────────────────────────────────────────────────────────

const LEAK_SENTINELS: readonly string[] = [
  SUPABASE_URL,
  "index.ts",
  "sessionHarness",
  "\n    at ",
  "    at async",
  "Stack:",
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "PGRST",
  "JWSError",
  "forced ",
  "service-role-test-key",
  "anon-test-key",
  "rest/v1",
  "auth/v1",
  "gateway page",
];

function leaksIn(bodyText: string): string[] {
  return LEAK_SENTINELS.filter((sentinel) => bodyText.includes(sentinel));
}

// ── Upstream fault injection for the route's one PostgREST read ──────────────

let currentCase: FuzzCase | null = null;

/** The injected PostgREST answer for one faulted read (never called for
 * `rows`, which the session harness serves from the stubbed ledger). */
function faultedRead(c: FuzzCase): Promise<Response> {
  const json = { "Content-Type": "application/json" };
  switch (c.upstream) {
    case "null_body":
      return Promise.resolve(new Response("null", { status: 200, headers: json }));
    case "pgrst_error":
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: "PGRST301",
            message: "JWSError JWSInvalidSignature",
            details: `forced ${c.upstreamStatus}`,
            hint: null,
          }),
          {
            status: c.upstreamStatus ?? 500,
            headers: {
              ...json,
              // PostgREST's 503 (schema cache reload) carries Retry-After and
              // postgrest-js honours it for its retry loop; 0 keeps the loop
              // (and its extra reads) observable without the wait.
              ...(c.upstreamStatus === 503 ? { "Retry-After": "0" } : {}),
            },
          },
        ),
      );
    case "html_200":
      return Promise.resolve(
        new Response("<html><body>gateway page</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );
    case "network_throw":
      return Promise.reject(new TypeError("error sending request: connection reset by peer"));
    case "non_array_200":
      return Promise.resolve(
        new Response(JSON.stringify({ scope: "video_analysis", action: "grant" }), {
          status: 200,
          headers: json,
        }),
      );
    case "rows":
      throw new Error("unreachable: `rows` is served by the session harness");
  }
}

function installUpstreamFaults(h: SessionHarness): void {
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const c = currentCase;
    if (
      c !== null &&
      c.upstream !== "rows" &&
      request.method === "GET" &&
      request.url.startsWith(`${SUPABASE_URL}/rest/v1/consent_records`)
    ) {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
      h.calls.push({ url: request.url, method: request.method, headers, body: null });
      return faultedRead(c);
    }
    return inner(input, init);
  }) as typeof fetch;
}

// ── Campaign ─────────────────────────────────────────────────────────────────

interface Outcome {
  seed: number;
  method: string;
  path: string;
  pathShape: PathShape;
  ip: string;
  bearer: BearerShape;
  upstream: UpstreamShape;
  upstreamStatus: number | null;
  gotrueFault: number | null;
  requestIdSent: string | null;
  contentLength: string | null;
  headerNames: readonly string[];
  rows: number;
  upstreamReads: number;
  requests: number;
  status: number;
  repeatStatus: number | null;
  requestId: string | null;
  retryAfter: string | null;
  expectedStatuses: readonly number[];
  durationMs: number;
  errorMessageLength: number | null;
  failures: string[];
}

function checkBody(
  status: number,
  bodyText: string,
  bearer: string,
  fail: (message: string) => void,
): { parsed: unknown; errorMessageLength: number | null } {
  const leaks = leaksIn(bodyText);
  if (leaks.length > 0) fail(`body leaks ${JSON.stringify(leaks)}`);
  if (bearer.length >= 16 && bodyText.includes(bearer)) fail("body echoes the bearer");
  if (bodyText.length === 0) {
    if (status !== 204) fail(`empty body on ${status}`);
    return { parsed: null, errorMessageLength: null };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    fail(`${status} body is not JSON`);
    return { parsed: null, errorMessageLength: null };
  }
  let errorMessageLength: number | null = null;
  if (status >= 400) {
    const message = (parsed as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message !== "string") {
      fail("error body has no error.message");
    } else {
      errorMessageLength = message.length;
      // The 404 message reflects the unmatched `METHOD /path` verbatim, so its
      // length follows the request path; that reflection is measured
      // (`errorMessageLength` in the report) rather than asserted here. Every
      // other error message is a fixed string.
      if (status !== 404 && message.length > 200) {
        fail(`error message is ${message.length} chars long`);
      }
      if (status >= 500 && !GENERIC_5XX_RE.test(message)) {
        fail(`5xx message is not the generic one: ${message.slice(0, 120)}`);
      }
    }
  }
  return { parsed, errorMessageLength };
}

async function runCase(h: SessionHarness, seed: number, log: string[]): Promise<Outcome> {
  const c = buildCase(h, seed);
  h.tables = { consent_records: c.rows as unknown[] };
  h.getUserStatus = c.gotrueFault;
  currentCase = c;
  const callsBefore = h.calls.length;
  log.length = 0;

  const expectation = expectationFor(c);
  const failures: string[] = [];
  const fail = (message: string) => failures.push(message);

  const second = c.repeat ? c.request.clone() : null;
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await h.handler(c.request);
  } catch (error) {
    fail(`handler threw: ${error instanceof Error ? error.message : String(error)}`);
    response = new Response(null, { status: 599 });
  }
  const bodyText = await response.text();
  const durationMs = Math.round(performance.now() - startedAt);
  const requestId = response.headers.get("x-request-id");
  const status = response.status;

  const bearer = c.request.headers.get("authorization")?.replace(/^Bearer\s*/, "") ?? "";

  // 1 — status contract.
  if (expectation.wellFormed) {
    if (status !== 200 && status !== 429) fail(`well-formed request answered ${status}`);
  } else if (expectation.outage) {
    if (status < 500 && status !== 429) fail(`upstream outage answered ${status} (not 5xx)`);
  } else {
    if (status >= 500) fail(`5xx on bad input: ${status}`);
    if (!ALLOWED_REJECTION_STATUSES.has(status)) {
      fail(`bad input answered ${status} (outside the allowed rejection set)`);
    }
  }
  // 2 — ordering contract (413 before auth, 401 before routing, 404 before
  // any upstream call, 503 for an outage).
  if (status !== 429 && !expectation.allowed.includes(status)) {
    fail(`expected ${expectation.allowed.join("|")}, got ${status}`);
  }
  // Every iteration authenticates as a fresh user from a fresh IP except the
  // slice that shares SHARED_IP on purpose — only that slice may ever see a
  // budget response (an unrelated caller being throttled is a scoping bug).
  if (status === 429 && c.ip !== SHARED_IP) {
    fail(`429 for a fresh ip/user (${c.ip})`);
  }
  // Every JSON response is uncacheable and nosniff.
  if (!(response.headers.get("cache-control") ?? "").includes("no-store")) {
    fail("missing Cache-Control: no-store");
  }
  if (response.headers.get("x-content-type-options") !== "nosniff") {
    fail("missing X-Content-Type-Options: nosniff");
  }

  // 3 — request id.
  if (!requestId) {
    fail("no x-request-id on the response");
  } else if (c.requestIdSent && REQUEST_ID_RE.test(c.requestIdSent)) {
    if (requestId !== c.requestIdSent) fail("a well-formed client request id was not echoed");
  } else if (!UUID_RE.test(requestId)) {
    fail(`minted request id is not a UUID: ${requestId}`);
  }

  // 4 — no leak in the client-facing body.
  const { parsed, errorMessageLength } = checkBody(status, bodyText, bearer, fail);

  // 5 — no write on rejection; reads stay scoped to the caller.
  const upstreamCalls = h.calls.slice(callsBefore);
  const writes = upstreamCalls.filter(
    (call) =>
      call.url.includes("/rest/v1/") && ["POST", "PATCH", "DELETE", "PUT"].includes(call.method),
  );
  if (writes.length > 0) fail(`request performed ${writes.length} PostgREST write(s)`);
  const reads = upstreamCalls.filter(
    (call) => call.method === "GET" && call.url.includes("/rest/v1/"),
  );
  const consentReads = reads.filter((call) => call.url.includes("/rest/v1/consent_records"));
  if (reads.length !== consentReads.length) {
    fail(`read a table other than consent_records: ${reads.map((r) => r.url).join(",")}`);
  }
  if (status === 200) {
    if (consentReads.length !== 1) {
      fail(`expected exactly 1 consent_records read, saw ${consentReads.length}`);
    }
  } else if (!(expectation.outage && c.gotrueFault === null)) {
    if (consentReads.length > 0) {
      fail(`rejected request still read consent_records (${consentReads.length}x)`);
    }
  }
  for (const read of consentReads) {
    const params = new URL(read.url).searchParams;
    if (params.get("user_id") !== `eq.${c.userId}`) {
      fail(`consent read not scoped to the caller: user_id=${params.get("user_id")}`);
    }
    if (params.get("select") !== "scope,action,consent_version,created_at") {
      fail(`unexpected select: ${params.get("select")}`);
    }
    const authorization = read.headers["authorization"] ?? "";
    const bearerSub = jwtPayload(authorization.replace(/^Bearer /, ""))?.sub;
    if (bearerSub !== c.userId) fail(`consent read not performed as the caller (sub=${bearerSub})`);
    if (read.headers["apikey"] !== "anon-test-key") {
      fail(`consent read used apikey=${read.headers["apikey"]}`);
    }
  }

  // 6 — 200 body is the canonical fold.
  if (status === 200 && parsed !== null) {
    const expected = expectedFold(c.upstream === "null_body" ? [] : c.rows);
    if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
      fail(
        `fold mismatch: got ${JSON.stringify(parsed)} expected ${JSON.stringify(expected)}`.slice(
          0,
          600,
        ),
      );
    }
  }

  // 7 — exactly one correlated access-log line.
  const lines = log.map((line) => JSON.parse(line) as { requestId: string; status: number });
  if (lines.length !== 1) {
    fail(`expected 1 access-log line, saw ${lines.length}`);
  } else {
    if (lines[0].requestId !== requestId) fail("access log request id does not match the response");
    if (lines[0].status !== status) fail("access log status does not match the response");
  }
  for (const line of log) {
    if (bearer.length >= 16 && line.includes(bearer)) fail("access log carries the bearer");
  }

  // Repeat: the same request (auth-cache path) answers identically.
  let repeatStatus: number | null = null;
  let requests = 1;
  if (second !== null) {
    log.length = 0;
    const again = await h.handler(second);
    requests += 1;
    const againText = await again.text();
    repeatStatus = again.status;
    if (!again.headers.get("x-request-id")) fail("repeat: no x-request-id");
    checkBody(again.status, againText, bearer, (message) => fail(`repeat: ${message}`));
    if (status === 200 && again.status === 200 && againText !== bodyText) {
      fail("repeat: identical request answered a different 200 body");
    }
    if (status === 200 && again.status !== 200 && again.status !== 429) {
      fail(`repeat: served request re-answered ${again.status}`);
    }
    if (status >= 400 && status !== 429 && again.status !== status && again.status !== 429) {
      fail(`repeat: rejection ${status} re-answered ${again.status}`);
    }
    if (log.length !== 1) fail(`repeat: expected 1 access-log line, saw ${log.length}`);
  }

  currentCase = null;
  h.getUserStatus = null;
  const url = new URL(c.request.url);
  return {
    seed,
    method: c.method,
    path: (url.pathname + url.search).slice(0, 200),
    pathShape: c.pathShape,
    ip: c.ip,
    bearer: c.bearerShape,
    upstream: c.upstream,
    upstreamStatus: c.upstreamStatus,
    gotrueFault: c.gotrueFault,
    requestIdSent: c.requestIdSent,
    contentLength: c.contentLengthSent,
    headerNames: c.headerNames,
    rows: c.rows.length,
    upstreamReads: consentReads.length,
    requests,
    status,
    repeatStatus,
    requestId,
    retryAfter: response.headers.get("retry-after"),
    expectedStatuses: expectation.allowed,
    durationMs,
    errorMessageLength,
    failures,
  };
}

Deno.test("stress: a fuzz case is a pure function of its seed (replayable)", async () => {
  const h = await loadSessionHarness();
  for (const seed of [1, 42, 4096, 2_147_483_647]) {
    const a = buildCase(h, seed);
    const b = buildCase(h, seed);
    assertEquals(a.method, b.method);
    assertEquals(a.url, b.url);
    assertEquals(a.bearerShape, b.bearerShape);
    assertEquals(a.pathShape, b.pathShape);
    assertEquals(a.upstream, b.upstream);
    assertEquals(a.gotrueFault, b.gotrueFault);
    assertEquals(a.rows, b.rows);
    assertEquals([...a.request.headers.keys()], [...b.request.headers.keys()]);
  }
});

Deno.test({
  name: `stress: GET /v1/me/consent/status fuzz/boundary campaign (${
    REPLAY_SEEDS.length > 0 ? `seeds ${REPLAY_SEEDS.join(",")}` : `${ITERATIONS} iterations`
  }${REPEAT > 1 ? ` ×${REPEAT}` : ""})`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadSessionHarness();
    installUpstreamFaults(h);
    const log: string[] = [];
    const restoreLog = captureAccessLog((line) => log.push(line));
    const outcomes: Outcome[] = [];
    const statusHistogram: Record<string, number> = {};
    let requests = 0;
    const startedAt = performance.now();
    try {
      const seeds =
        REPLAY_SEEDS.length > 0
          ? REPLAY_SEEDS
          : Array.from({ length: ITERATIONS }, (_, i) => BASE_SEED + i);
      for (let round = 0; round < REPEAT; round += 1) {
        for (const seed of seeds) {
          const outcome = await runCase(h, seed, log);
          outcomes.push(outcome);
          requests += outcome.requests;
          statusHistogram[outcome.status] = (statusHistogram[outcome.status] ?? 0) + 1;
        }
      }
    } finally {
      restoreLog();
    }
    const durationMs = Math.round(performance.now() - startedAt);

    const failed = outcomes.filter((outcome) => outcome.failures.length > 0);
    const summary = {
      route: `GET ${ROUTE_PATH}`,
      lens: "fuzz-boundary",
      baseSeed: BASE_SEED,
      iterations: outcomes.length,
      requests,
      repeat: REPEAT,
      durationMs,
      statusHistogram,
      failedSeeds: [...new Set(failed.map((outcome) => outcome.seed))],
      failedIterations: failed.length,
      slowestMs: Math.max(0, ...outcomes.map((outcome) => outcome.durationMs)),
      maxUpstreamReadsPerRequest: Math.max(0, ...outcomes.map((outcome) => outcome.upstreamReads)),
      longestErrorMessage: Math.max(
        0,
        ...outcomes.map((outcome) => outcome.errorMessageLength ?? 0),
      ),
      reflected404Over200Chars: outcomes.filter(
        (outcome) => outcome.status === 404 && (outcome.errorMessageLength ?? 0) > 200,
      ).length,
    };
    if (OUT_PATH) {
      await Deno.writeTextFile(OUT_PATH, `${JSON.stringify({ ...summary, outcomes }, null, 2)}\n`);
    }
    console.log(`[stress] ${JSON.stringify(summary)}`);

    const expectedIterations =
      (REPLAY_SEEDS.length > 0 ? REPLAY_SEEDS.length : ITERATIONS) * REPEAT;
    assertEquals(outcomes.length, expectedIterations);
    assert(
      failed.length === 0,
      `${failed.length}/${outcomes.length} fuzz iterations violated the route contract:\n${failed
        .slice(0, 10)
        .map(
          (outcome) =>
            `  seed=${outcome.seed} ${outcome.method} ${outcome.path} bearer=${outcome.bearer} ` +
            `upstream=${outcome.upstream} status=${outcome.status} → ${outcome.failures.join("; ")}`,
        )
        .join("\n")}`,
    );
    // A sweep that never reached the route (all rejections) would assert
    // nothing about the fold; keep it honest. A hand-picked seed replay
    // (STRESS_SEEDS) is allowed to target rejections only.
    if (REPLAY_SEEDS.length === 0) {
      assert(
        (statusHistogram["200"] ?? 0) > 0,
        `no iteration reached the route: ${JSON.stringify(statusHistogram)}`,
      );
    }
  },
});
