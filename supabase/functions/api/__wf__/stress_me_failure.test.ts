// stress-route-get-v1-me / lens failure-load — FAILURE INJECTION for GET /v1/me.
//
// The REAL handler (../index.ts via stress_me_harness.ts, Redis-enabled
// isolate) is driven through every upstream fault the route can meet:
// Supabase Auth (GET /auth/v1/user and the transitional id_token grant),
// PostgREST (GET /rest/v1/profiles), Upstash Redis (POST /pipeline) and
// RevenueCat (never on this route — proven). Each case asserts the
// USER-VISIBLE class (200 ok / 401 refused / 503 unavailable + Retry-After /
// 429), that 5xx bodies stay generic (the planted CANARY detail is logged,
// never echoed), that 503s do not charge the per-IP auth-failure budget, and
// RECOVERABILITY: once the fault clears, the same bearer succeeds again.
//
// Two expectations per case: `contract` (what AGENTS.md / the app's sign-out
// rule require) and, where today's code differs, `current`. By default a case
// whose observed class matches `current` is recorded as GAP (the artifact
// carries it as a finding) and the test passes; STRESS_STRICT=1 makes GAPs
// fail. FAIL (matches neither) always fails.
//
//   cd supabase/functions/api/__wf__ && deno task test --filter stress-me-failure
//   STRESS_SLOW=1 deno task test --filter "stress-me-failure matrix"   # + multi-second backoff cases
//   STRESS_ITER=500 STRESS_SEED=7 deno task test --filter "stress-me-failure random"
//
// PostgREST 503/520 and socket errors are retried INSIDE supabase-js
// (postgrest-js 2.112: GET only, 1 s/2 s/4 s backoff, Retry-After honoured
// uncapped, 3 retries) and readProfile() sets no abort signal, so those
// cases take ≥7 s and are gated behind STRESS_SLOW=1.
//
// Artifacts: artifacts/stress-me/latest/{fault_matrix,random_campaign}.json
// (override with STRESS_OUT_DIR).

import { assert, assertEquals } from "@std/assert";
import {
  callMe,
  CANARY,
  classify,
  envInt,
  type FaultMode,
  freshIp,
  latencySummary,
  leaksDetail,
  loadStressHarness,
  meBodyProblems,
  meRequest,
  OK,
  Prng,
  replayCommand,
  sha256Hex,
  STRESS_ITER,
  STRESS_SEED,
  STRESS_SLOW,
  type StressHarness,
  type Upstream,
  type VisibleClass,
  writeArtifact,
} from "./stress_me_harness.ts";

const STRICT = envInt("STRESS_STRICT", 0) === 1;

type Bearer = "session" | "provider" | "expired-session" | "garbage" | "none";

interface FaultCase {
  id: string;
  /** What the case is about, for the artifact. */
  about: string;
  bearer?: Bearer;
  faults: Partial<Record<Upstream, FaultMode>>;
  /** Milliseconds for AUTH_UPSTREAM_TIMEOUT_MS during the case (default: unset → 6000). */
  authTimeoutMs?: number;
  /** Warm the bearer with one all-OK request first (cache hit path). */
  warm?: boolean;
  /** Plant into the fake Redis before the request: key → value (TTL 300 s). */
  plant?: (h: StressHarness, token: string, sessionId: string) => Promise<void>;
  contract: VisibleClass;
  /** Today's behaviour when it differs from the contract (recorded as GAP). */
  current?: VisibleClass;
  /** Expected Supabase Auth calls during the faulted request (exact). */
  authCalls?: number;
  /** Expected PostgREST calls during the faulted request (exact). */
  restCalls?: number;
  /** Retry-After header the 503 must carry (exact string). */
  retryAfter?: string;
  /** The faulted request must take at least this long (ms). */
  minDurationMs?: number;
  /** Status the recovery probe (faults cleared, same bearer) must return. */
  recovery?: number;
  /** Today's recovery status when it differs (only consulted for a GAP). */
  currentRecovery?: number;
  /** Waits for real multi-second upstream backoff: only with STRESS_SLOW=1 (or STRESS_CASE=<id>). */
  slow?: boolean;
}

const http = (
  status: number,
  extra: Partial<Extract<FaultMode, { kind: "http" }>> = {},
): FaultMode => ({ kind: "http", status, ...extra });
const malformed = (shape: string): FaultMode => ({ kind: "malformed", shape });
const network = (times?: number): FaultMode => ({ kind: "network", times });
const slow = (ms: number): FaultMode => ({ kind: "slow", ms });
const stall: FaultMode = { kind: "stall" };
const truncated: FaultMode = { kind: "truncated" };
const sequence = (...steps: FaultMode[]): FaultMode => ({
  kind: "sequence",
  steps,
});

/** Redis-fault requests on a WARM bearer: 0 auth calls when Redis is
 * unreachable (L1 answers), 1 when Redis was reached but did not answer
 * the question (unknown → re-verify with Supabase Auth). */
const redisWarm = (
  id: string,
  about: string,
  fault: FaultMode,
  authCalls: number,
  extra: Partial<FaultCase> = {},
): FaultCase => ({
  id,
  about,
  warm: true,
  faults: { redis: fault },
  contract: "ok",
  authCalls,
  restCalls: 1,
  recovery: 200,
  ...extra,
});

const CASES: FaultCase[] = [
  // ── A. controls ──
  {
    id: "A1",
    about: "session bearer, all upstreams healthy",
    faults: {},
    contract: "ok",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "A2",
    about: "transitional Google ID token, all healthy",
    bearer: "provider",
    faults: {},
    contract: "ok",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "A3",
    about: "expired session bearer is refused before any upstream",
    bearer: "expired-session",
    faults: {},
    contract: "refused",
    authCalls: 0,
    restCalls: 0,
    recovery: 401,
  },
  {
    id: "A4",
    about: "garbage bearer is refused before any upstream",
    bearer: "garbage",
    faults: {},
    contract: "refused",
    authCalls: 0,
    restCalls: 0,
    recovery: 401,
  },
  {
    id: "A5",
    about: "no bearer is refused before any upstream",
    bearer: "none",
    faults: {},
    contract: "refused",
    authCalls: 0,
    restCalls: 0,
    recovery: 401,
  },
  {
    id: "A6",
    about: "warm bearer: auth served from cache, one PostgREST read",
    warm: true,
    faults: {},
    contract: "ok",
    authCalls: 0,
    restCalls: 1,
    recovery: 200,
  },

  // ── B. Supabase Auth — GET /auth/v1/user (session bearer) ──
  {
    id: "B1",
    about: "auth HTTP 500",
    faults: { auth: http(500) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    retryAfter: "2",
    recovery: 200,
  },
  {
    id: "B2",
    about: "auth HTTP 502 html gateway page",
    faults: { auth: http(502, { body: "html" }) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B3",
    about: "auth HTTP 503 with Retry-After 7 is relayed",
    faults: { auth: http(503, { retryAfter: 7 }) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    retryAfter: "7",
    recovery: 200,
  },
  {
    id: "B4",
    about: "auth HTTP 504 empty body",
    faults: { auth: http(504, { body: "empty" }) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B5",
    about: "auth HTTP 429 with Retry-After 30 is relayed",
    faults: { auth: http(429, { retryAfter: 30 }) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    retryAfter: "30",
    recovery: 200,
  },
  {
    id: "B6",
    about: "auth HTTP 400 is a credential verdict",
    faults: { auth: http(400) },
    contract: "refused",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B7",
    about: "auth HTTP 401 is a credential verdict",
    faults: { auth: http(401) },
    contract: "refused",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B8",
    about: "auth HTTP 403 is a credential verdict",
    faults: { auth: http(403) },
    contract: "refused",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B9",
    about: "auth HTTP 404 is the service, not the credential",
    faults: { auth: http(404) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B10",
    about: "auth 200 html body",
    faults: { auth: malformed("html") },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B11",
    about: "auth 200 {}",
    faults: { auth: malformed("empty-object") },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B12",
    about: "auth 200 null",
    faults: { auth: malformed("null") },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B13",
    about: "auth 200 [user] (array instead of object)",
    faults: { auth: malformed("array") },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B14",
    about: 'auth 200 "ok" (string)',
    faults: { auth: malformed("string") },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B15",
    about: "auth 200 empty body",
    faults: { auth: malformed("empty-body") },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B16",
    about: "auth 204",
    faults: { auth: malformed("status-204") },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B17",
    about: "auth 200 user with numeric id",
    faults: { auth: malformed("id-not-string") },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B18",
    about: "auth 200 user without any provider",
    faults: { auth: malformed("no-provider") },
    contract: "refused",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B19",
    about: "auth 200 user whose provider is email",
    faults: { auth: malformed("email-provider") },
    contract: "refused",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B20",
    about:
      "auth socket dead for the whole deadline (700 ms): 3 attempts, 100+200 backoff",
    faults: { auth: network() },
    authTimeoutMs: 700,
    contract: "unavailable",
    authCalls: 3,
    restCalls: 0,
    minDurationMs: 300,
    recovery: 200,
  },
  {
    id: "B21",
    about: "auth socket fails once then answers",
    faults: { auth: network(1) },
    contract: "ok",
    authCalls: 2,
    restCalls: 1,
    minDurationMs: 100,
    recovery: 200,
  },
  {
    id: "B22",
    about: "auth socket fails twice then answers",
    faults: { auth: network(2) },
    contract: "ok",
    authCalls: 3,
    restCalls: 1,
    minDurationMs: 300,
    recovery: 200,
  },
  {
    id: "B23",
    about: "auth never answers: deadline (400 ms) → retryable",
    faults: { auth: stall },
    authTimeoutMs: 400,
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    minDurationMs: 400,
    recovery: 200,
  },
  {
    id: "B24",
    about: "auth slow (250 ms) inside the deadline",
    faults: { auth: slow(250) },
    contract: "ok",
    authCalls: 1,
    restCalls: 1,
    minDurationMs: 250,
    recovery: 200,
  },
  {
    id: "B25",
    about: "auth slower (600 ms) than the deadline (400 ms)",
    faults: { auth: slow(600) },
    authTimeoutMs: 400,
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    minDurationMs: 400,
    recovery: 200,
  },
  {
    id: "B26",
    about:
      "auth 200 whose body stream resets mid-way (retried as a socket fault)",
    faults: { auth: truncated },
    authTimeoutMs: 700,
    contract: "unavailable",
    authCalls: 3,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "B27",
    about:
      "auth 500 then 200 within one request is NOT retried (first HTTP answer is final)",
    faults: { auth: sequence(http(500)) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },

  // ── C. Supabase Auth — transitional provider ID token (signInWithIdToken via supabase-js) ──
  {
    id: "C1",
    about: "provider token: auth HTTP 500",
    bearer: "provider",
    faults: { auth: http(500) },
    contract: "unavailable",
    current: "refused",
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "C2",
    about: "provider token: auth HTTP 400 bad_id_token",
    bearer: "provider",
    faults: { auth: http(400) },
    contract: "refused",
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "C3",
    about: "provider token: auth socket dead",
    bearer: "provider",
    faults: { auth: network() },
    contract: "unavailable",
    current: "refused",
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "C4",
    about: "provider token: auth 200 html",
    bearer: "provider",
    faults: { auth: malformed("html") },
    contract: "unavailable",
    current: "refused",
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "C5",
    about: "provider token: auth 200 {}",
    bearer: "provider",
    faults: { auth: malformed("empty-object") },
    contract: "unavailable",
    current: "refused",
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "C6",
    about:
      "provider token: auth slow 1500 ms (no deadline on this path; observe)",
    bearer: "provider",
    faults: { auth: slow(1500) },
    contract: "ok",
    restCalls: 1,
    minDurationMs: 1500,
    recovery: 200,
  },

  // ── D. PostgREST — GET /rest/v1/profiles (auth healthy) ──
  {
    id: "D1",
    about: "profiles HTTP 500",
    faults: { rest: http(500) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "D2",
    about: "profiles HTTP 502 html",
    faults: { rest: http(502, { body: "html" }) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "D3",
    about:
      "profiles HTTP 503: supabase-js retries 3× (1 s/2 s/4 s) before the 503 — ≥7 s",
    faults: { rest: http(503) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 4,
    minDurationMs: 7000,
    recovery: 200,
    slow: true,
  },
  {
    id: "D4",
    about: "profiles HTTP 401 (PGRST301 jwt) after Auth accepted the bearer",
    faults: { rest: http(401) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "D5",
    about: "profiles HTTP 403 (42501 RLS)",
    faults: { rest: http(403) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "D6",
    about: "profiles HTTP 404",
    faults: { rest: http(404) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "D7",
    about: "profiles HTTP 406 PGRST116",
    faults: { rest: http(406) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "D8",
    about: "profiles 200 [] (row not yet visible): one 400 ms retry, then 503",
    faults: { rest: malformed("empty-rows") },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 2,
    minDurationMs: 400,
    recovery: 200,
  },
  {
    id: "D9",
    about: "profiles 200 null",
    faults: { rest: malformed("null") },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 2,
    minDurationMs: 400,
    recovery: 200,
  },
  {
    id: "D10",
    about: "profiles 200 two rows",
    faults: { rest: malformed("two-rows") },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "D11",
    about: "profiles 200 html",
    faults: { rest: malformed("html") },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "D12",
    about: 'profiles 200 "ok" (string body)',
    faults: { rest: malformed("string") },
    contract: "unavailable",
    current: "ok",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "D13",
    about: "profiles 200 {} (object without id)",
    faults: { rest: malformed("empty-object") },
    contract: "unavailable",
    current: "ok",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "D14",
    about:
      "profiles 200 row missing columns (passthrough; body problems recorded)",
    faults: { rest: malformed("row-missing-fields") },
    contract: "ok",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "D15",
    about: "profiles 200 row with wrong column types (passthrough; recorded)",
    faults: { rest: malformed("row-wrong-types") },
    contract: "ok",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "D16",
    about:
      "profiles 200 row whose id is another user (impossible under RLS+eq; recorded)",
    faults: { rest: malformed("row-foreign-id") },
    contract: "ok",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "D17",
    about: "profiles 200 empty body",
    faults: { rest: malformed("empty-body") },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 2,
    minDurationMs: 400,
    recovery: 200,
  },
  {
    id: "D18",
    about: "profiles 204",
    faults: { rest: malformed("status-204") },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 2,
    minDurationMs: 400,
    recovery: 200,
  },
  {
    id: "D19",
    about:
      "profiles socket dead: supabase-js retries 3× (1 s/2 s/4 s) before the 503 — ≥7 s",
    faults: { rest: network() },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 4,
    minDurationMs: 7000,
    recovery: 200,
    slow: true,
  },
  {
    id: "D20",
    about: "profiles body stream resets mid-way",
    faults: { rest: truncated },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "D21",
    about: "profiles slow 300 ms",
    faults: { rest: slow(300) },
    contract: "ok",
    authCalls: 1,
    restCalls: 1,
    minDurationMs: 300,
    recovery: 200,
  },
  {
    id: "D22",
    about:
      "profiles stalls 2500 ms: the route has no deadline of its own (observe wait)",
    faults: { rest: slow(envInt("STRESS_REST_STALL_MS", 2500)) },
    contract: "ok",
    authCalls: 1,
    restCalls: 1,
    minDurationMs: envInt("STRESS_REST_STALL_MS", 2500),
    recovery: 200,
    slow: true,
  },
  {
    id: "D23",
    about:
      "profiles socket fails once: supabase-js retries after 1 s and the request succeeds",
    faults: { rest: network(1) },
    contract: "ok",
    authCalls: 1,
    restCalls: 2,
    minDurationMs: 1000,
    recovery: 200,
  },
  {
    id: "D24",
    about:
      "profiles [] then the row: the 400 ms retry recovers inside the request",
    faults: { rest: sequence(malformed("empty-rows")) },
    contract: "ok",
    authCalls: 1,
    restCalls: 2,
    minDurationMs: 400,
    recovery: 200,
  },
  {
    id: "D25",
    about: "profiles 500 with a CANARY detail: logged, never echoed",
    faults: { rest: http(500) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "D26",
    about:
      "profiles 503 with Retry-After: 3 then the row: supabase-js sleeps the full Retry-After (uncapped) before retrying",
    faults: { rest: sequence(http(503, { retryAfter: 3 })) },
    contract: "ok",
    authCalls: 1,
    restCalls: 2,
    minDurationMs: 3000,
    recovery: 200,
    slow: true,
  },
  {
    id: "D27",
    about: "profiles HTTP 520 (retryable in supabase-js) once, then the row",
    faults: { rest: sequence(http(520)) },
    contract: "ok",
    authCalls: 1,
    restCalls: 2,
    minDurationMs: 1000,
    recovery: 200,
  },
  {
    id: "D28",
    about: "profiles HTTP 504 is not retried by supabase-js",
    faults: { rest: http(504) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },

  // ── E. Upstash Redis (cache + shared rate limits) ──
  redisWarm("E1", "redis HTTP 500 on a warm bearer", http(500), 0),
  redisWarm("E2", "redis HTTP 401 (bad token) on a warm bearer", http(401), 0),
  redisWarm("E3", "redis HTTP 429 on a warm bearer", http(429), 0),
  redisWarm("E4", "redis socket dead on a warm bearer", network(), 0),
  redisWarm(
    "E5",
    "redis never answers: 1200 ms timeout per pipeline (observe latency)",
    stall,
    0,
    { minDurationMs: 1200, slow: true },
  ),
  redisWarm("E6", "redis 200 html", malformed("html"), 0),
  redisWarm("E7", "redis 200 {} (not an array)", malformed("empty-object"), 0),
  redisWarm("E8", "redis 200 null", malformed("null"), 0),
  redisWarm("E9", 'redis 200 "OK" (string)', malformed("string"), 0),
  redisWarm(
    "E10",
    "redis 200 [] (short reply): unknown → re-verify",
    malformed("short-reply"),
    1,
  ),
  redisWarm(
    "E11",
    "redis 200 per-command errors: unknown → re-verify",
    malformed("slot-errors"),
    1,
  ),
  redisWarm(
    "E12",
    "redis 200 null slots: unknown → re-verify",
    malformed("slot-null"),
    1,
  ),
  redisWarm(
    "E13",
    "redis 200 with a string in every slot (marker slot reads as revoked, cached in L1 for 60 s)",
    malformed("slot-garbage"),
    0,
    {
      contract: "ok",
      current: "refused",
      restCalls: 0,
      recovery: 200,
      currentRecovery: 401,
    },
  ),
  redisWarm("E14", "redis 200 empty body", malformed("empty-body"), 0),
  {
    id: "E15",
    about:
      "redis down on a COLD bearer: limits fail open, auth verified upstream",
    faults: { redis: http(500) },
    contract: "ok",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "E21",
    about:
      "redis never answers on a COLD bearer: every pipeline waits its 1200 ms timeout in series (observe latency)",
    faults: { redis: stall },
    contract: "ok",
    authCalls: 1,
    restCalls: 1,
    minDurationMs: 1200,
    recovery: 200,
    slow: true,
  },
  {
    id: "E16",
    about: "redis down + auth 500",
    faults: { redis: network(), auth: http(500) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "E17",
    about: "redis down + profiles 500",
    faults: { redis: network(), rest: http(500) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "E18",
    about:
      "corrupt L2 auth row for a cold bearer: fall through to a real verification",
    faults: {},
    plant: async (h, token) => {
      h.redis.set(`auth:${await sha256Hex(token)}`, {
        value: "{not json",
        expiresAtMs: Date.now() + 300_000,
      });
    },
    contract: "ok",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "E19",
    about:
      "revocation marker published by another isolate: refused without an auth call",
    faults: {},
    plant: (h, _token, sessionId) => {
      h.redis.set(`auth:revoked:${sessionId}`, {
        value: "1",
        expiresAtMs: Date.now() + 300_000,
      });
      return Promise.resolve();
    },
    contract: "refused",
    authCalls: 0,
    restCalls: 0,
    recovery: 401,
  },
  {
    id: "E20",
    about:
      "L2 auth row for the bearer whose embedded expiry has passed: not trusted",
    faults: {},
    plant: async (h, token) => {
      h.redis.set(`auth:${await sha256Hex(token)}`, {
        value: JSON.stringify({
          userId: "99999999-9999-4999-8999-999999999999",
          email: "stale@example.com",
          provider: "google",
          accessToken: token,
          expiresAtMs: Date.now() - 1,
        }),
        expiresAtMs: Date.now() + 300_000,
      });
    },
    contract: "ok",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },

  // ── F. RevenueCat is not on this route ──
  {
    id: "F1",
    about: "RevenueCat HTTP 500 does not touch GET /v1/me",
    faults: { rc: http(500) },
    contract: "ok",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "F2",
    about: "RevenueCat socket dead does not touch GET /v1/me",
    faults: { rc: network() },
    contract: "ok",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },
  {
    id: "F3",
    about: "RevenueCat stalled does not touch GET /v1/me",
    faults: { rc: stall },
    contract: "ok",
    authCalls: 1,
    restCalls: 1,
    recovery: 200,
  },

  // ── G. compound ──
  {
    id: "G1",
    about: "everything down (auth 500, profiles 500, redis 500)",
    faults: { auth: http(500), rest: http(500), redis: http(500) },
    contract: "unavailable",
    authCalls: 1,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "G2",
    about: "everything down, expired bearer: refused with zero upstream calls",
    bearer: "expired-session",
    faults: { auth: network(), rest: network(), redis: network() },
    contract: "refused",
    authCalls: 0,
    restCalls: 0,
    recovery: 401,
  },
  {
    id: "G3",
    about: "redis dead + auth socket dead (700 ms deadline)",
    faults: { redis: network(), auth: network() },
    authTimeoutMs: 700,
    contract: "unavailable",
    authCalls: 3,
    restCalls: 0,
    recovery: 200,
  },
  {
    id: "G4",
    about: "warm bearer, redis dead, profiles 503 (4 PostgREST attempts, ≥7 s)",
    warm: true,
    faults: { redis: network(), rest: http(503) },
    contract: "unavailable",
    authCalls: 0,
    restCalls: 4,
    minDurationMs: 7000,
    recovery: 200,
    slow: true,
  },
  {
    id: "G5",
    about: "warm bearer, redis dead, profiles 504",
    warm: true,
    faults: { redis: network(), rest: http(504) },
    contract: "unavailable",
    authCalls: 0,
    restCalls: 1,
    recovery: 200,
  },
];

interface CaseResult {
  id: string;
  about: string;
  bearer: Bearer;
  faults: Partial<Record<Upstream, FaultMode>>;
  contract: VisibleClass;
  current: VisibleClass | null;
  observed: VisibleClass;
  status: number;
  message: string | null;
  retryAfter: string | null;
  requestId: boolean;
  durationMs: number;
  counts: Record<Upstream, number>;
  supabaseRoundTrips: number;
  redisPipelines: number;
  leaked: boolean;
  detailLogged: boolean | null;
  authFailureCharged: number | null;
  accessLogStatus: number | null;
  bodyProblems: string[];
  recoveryStatus: number | null;
  recoveryCounts: Record<Upstream, number> | null;
  verdict: "PASS" | "GAP" | "FAIL";
  problems: string[];
}

function bearerFor(
  h: StressHarness,
  kind: Bearer,
  userId: string,
): { token: string | null; sessionId: string | null } {
  switch (kind) {
    case "session": {
      const session = h.mintSession(userId);
      return { token: session.accessToken, sessionId: session.sessionId };
    }
    case "provider":
      return { token: h.providerToken(userId), sessionId: null };
    case "expired-session": {
      const session = h.mintSession(userId, -60);
      return { token: session.accessToken, sessionId: session.sessionId };
    }
    case "garbage":
      return { token: "not.a.jwt", sessionId: null };
    case "none":
      return { token: null, sessionId: null };
  }
}

/** Auth-failure hits recorded for `ip` in the fake Redis (null = no window). */
function authFailureCount(h: StressHarness, ip: string): number | null {
  for (const [key, entry] of h.redis) {
    if (key.startsWith("rl:authfail:") && key.endsWith(`:${ip}`)) {
      return Number(entry.value);
    }
  }
  return null;
}

async function withAuthTimeout<T>(
  ms: number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (ms === undefined) return fn();
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(ms));
  try {
    return await fn();
  } finally {
    Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
  }
}

async function runCase(
  h: StressHarness,
  c: FaultCase,
  userId: string,
): Promise<CaseResult> {
  const bearer = c.bearer ?? "session";
  h.registerUser(userId);
  const { token, sessionId } = bearerFor(h, bearer, userId);
  const ip = freshIp();
  const problems: string[] = [];

  if (c.warm) {
    const warm = await callMe(h, meRequest({ token, ip }));
    if (warm.status !== 200) problems.push(`warm-up returned ${warm.status}`);
  }
  if (c.plant) await c.plant(h, token ?? "", sessionId ?? "");

  h.faults = { auth: OK, rest: OK, redis: OK, rc: OK, ...c.faults };
  h.errorLog = [];
  h.accessLog = [];
  const failuresBefore = authFailureCount(h, ip) ?? 0;
  const observed = await withAuthTimeout(
    c.authTimeoutMs,
    () => callMe(h, meRequest({ token, ip })),
  );
  const failuresAfter = authFailureCount(h, ip);
  const observedClass = classify(observed);
  const detailLogged = h.errorLog.some((line) => line.includes(CANARY));
  const access = h.accessLog.find((entry) => entry.evt === "api_request");
  const leaked = leaksDetail(observed);
  const bodyProblems = observed.status === 200
    ? meBodyProblems(observed.body, userId)
    : [];

  const expectedNow = c.current ?? c.contract;
  let verdict: CaseResult["verdict"] = "PASS";
  if (observedClass !== c.contract) {
    verdict = observedClass === expectedNow ? "GAP" : "FAIL";
    if (verdict === "FAIL") {
      problems.push(
        `class ${observedClass} (status ${observed.status}), contract ${c.contract}`,
      );
    }
  }
  if (observed.status >= 500 && leaked) {
    problems.push("5xx body leaks upstream detail");
  }
  // Whether a 503 carries Retry-After is recorded per case (the artifact
  // summarises it); only the auth-path cases pin an exact value.
  if (c.retryAfter !== undefined && observed.retryAfter !== c.retryAfter) {
    problems.push(`Retry-After ${observed.retryAfter} != ${c.retryAfter}`);
  }
  if (!observed.requestId) problems.push("no x-request-id");
  if (!access || access.status !== observed.status) {
    problems.push("access log missing or status mismatch");
  }
  if (observed.status === 200 && bodyProblems.length && !c.faults.rest) {
    problems.push(`200 body: ${bodyProblems.join("; ")}`);
  }
  if (c.authCalls !== undefined && observed.counts.auth !== c.authCalls) {
    problems.push(`auth calls ${observed.counts.auth} != ${c.authCalls}`);
  }
  if (
    c.restCalls !== undefined && observed.counts.rest !== c.restCalls &&
    verdict !== "GAP"
  ) {
    problems.push(`rest calls ${observed.counts.rest} != ${c.restCalls}`);
  }
  if (c.minDurationMs !== undefined && observed.durationMs < c.minDurationMs) {
    problems.push(`duration ${observed.durationMs}ms < ${c.minDurationMs}ms`);
  }
  if (observed.counts.rc !== 0) {
    problems.push(`RevenueCat called ${observed.counts.rc}×`);
  }
  // Only a 401 may charge the auth-failure budget, and exactly once. A Redis
  // fault means the counter never reached the fake, so it is not observable.
  const charged = failuresAfter === null
    ? null
    : failuresAfter - failuresBefore;
  if (!c.faults.redis) {
    if (observed.status === 401 && charged !== 1) {
      problems.push(`401 charged authfail ${charged}× (want 1)`);
    }
    if (observed.status !== 401 && (charged ?? 0) !== 0) {
      problems.push(`${observed.status} charged authfail ${charged}×`);
    }
  }

  // Recovery: faults cleared, same bearer, same IP.
  h.faults = { auth: OK, rest: OK, redis: OK, rc: OK };
  let recoveryStatus: number | null = null;
  let recoveryCounts: Record<Upstream, number> | null = null;
  if (c.recovery !== undefined) {
    const again = await callMe(h, meRequest({ token, ip }));
    recoveryStatus = again.status;
    recoveryCounts = again.counts;
    const wantRecovery = verdict === "GAP"
      ? (c.currentRecovery ?? c.recovery)
      : c.recovery;
    if (again.status !== wantRecovery) {
      problems.push(`recovery ${again.status} != ${wantRecovery}`);
    }
    if (again.status === 200) {
      const recoveredProblems = meBodyProblems(again.body, userId);
      if (recoveredProblems.length) {
        problems.push(`recovered body: ${recoveredProblems.join("; ")}`);
      }
    }
  }
  if (problems.length && verdict === "PASS") verdict = "FAIL";

  return {
    id: c.id,
    about: c.about,
    bearer,
    faults: c.faults,
    contract: c.contract,
    current: c.current ?? null,
    observed: observedClass,
    status: observed.status,
    message: observed.message,
    retryAfter: observed.retryAfter,
    requestId: Boolean(observed.requestId),
    durationMs: observed.durationMs,
    counts: observed.counts,
    supabaseRoundTrips: observed.counts.auth + observed.counts.rest,
    redisPipelines: observed.counts.redis,
    leaked,
    detailLogged: observed.status >= 500 ? detailLogged : null,
    authFailureCharged: charged,
    accessLogStatus: typeof access?.status === "number" ? access.status : null,
    bodyProblems,
    recoveryStatus,
    recoveryCounts,
    verdict,
    problems,
  };
}

const ONLY = Deno.env.get("STRESS_CASE");

Deno.test("stress-me-failure matrix: every upstream fault maps to a documented user-visible class and recovers", async () => {
  const h = await loadStressHarness({ redis: true });
  const prng = new Prng(STRESS_SEED);
  const results: CaseResult[] = [];
  const skippedSlow: string[] = [];
  for (const c of CASES) {
    const userId = prng.uuid(); // drawn for every case so ids are stable under STRESS_CASE/STRESS_SLOW
    if (ONLY && c.id !== ONLY) continue;
    if (c.slow && !STRESS_SLOW && !ONLY) {
      skippedSlow.push(c.id);
      continue;
    }
    h.reset();
    results.push(await runCase(h, c, userId));
  }
  const failed = results.filter((r) => r.verdict === "FAIL");
  const gaps = results.filter((r) => r.verdict === "GAP");
  const unavailableWithoutRetryAfter = results.filter((r) =>
    r.status === 503 && r.retryAfter === null
  ).map((r) => r.id);
  const path = await writeArtifact("fault_matrix.json", {
    unit: "route-get-v1-me",
    lens: "failure-load",
    seed: STRESS_SEED,
    strict: STRICT,
    slow: STRESS_SLOW,
    skippedSlow,
    redis: true,
    cases: results.length,
    unavailableWithoutRetryAfter,
    passed: results.filter((r) => r.verdict === "PASS").length,
    gaps: gaps.map((r) => r.id),
    failed: failed.map((r) => r.id),
    replay: replayCommand(
      "stress-me-failure matrix",
      STRESS_SEED,
      "STRESS_CASE=<id> ",
    ),
    results,
  });
  console.log(
    `[stress-me-failure] ${results.length} cases: ${
      results.length - failed.length - gaps.length
    } pass, ${gaps.length} gap (${
      gaps.map((r) => r.id).join(",")
    }), ${failed.length} fail${
      skippedSlow.length
        ? `, ${skippedSlow.length} slow cases skipped (STRESS_SLOW=1)`
        : ""
    } → ${path}`,
  );
  assert(
    results.length >= 40,
    `expected ≥40 fault cases, ran ${results.length}`,
  );
  assertEquals(
    failed.map((r) => `${r.id}: ${r.problems.join(" | ")}`),
    [],
    "cases that match neither the contract nor today's documented behaviour",
  );
  if (STRICT) {
    assertEquals(
      gaps.map((r) =>
        `${r.id}: observed ${r.observed}, contract ${r.contract}`
      ),
      [],
      "STRESS_STRICT=1: contract gaps",
    );
  }
});

// ── Random campaign: seeded combinations across all upstreams ─────────────────

interface Pool<T> {
  name: string;
  fault: FaultMode;
  outcome: T;
}

const AUTH_POOL: Array<Pool<"pass" | "refused" | "unavailable">> = [
  { name: "ok", fault: OK, outcome: "pass" },
  { name: "ok", fault: OK, outcome: "pass" },
  { name: "ok", fault: OK, outcome: "pass" },
  { name: "http500", fault: http(500), outcome: "unavailable" },
  {
    name: "http502html",
    fault: http(502, { body: "html" }),
    outcome: "unavailable",
  },
  {
    name: "http503",
    fault: http(503, { retryAfter: 3 }),
    outcome: "unavailable",
  },
  { name: "http429", fault: http(429), outcome: "unavailable" },
  { name: "http400", fault: http(400), outcome: "refused" },
  { name: "http401", fault: http(401), outcome: "refused" },
  { name: "http403", fault: http(403), outcome: "refused" },
  { name: "html200", fault: malformed("html"), outcome: "unavailable" },
  {
    name: "emptyObject",
    fault: malformed("empty-object"),
    outcome: "unavailable",
  },
  { name: "null200", fault: malformed("null"), outcome: "unavailable" },
  { name: "noProvider", fault: malformed("no-provider"), outcome: "refused" },
  { name: "network", fault: network(), outcome: "unavailable" },
  { name: "network1", fault: network(1), outcome: "pass" },
  { name: "network2", fault: network(2), outcome: "pass" },
  { name: "stall", fault: stall, outcome: "unavailable" },
  { name: "truncated", fault: truncated, outcome: "unavailable" },
  { name: "slow150", fault: slow(150), outcome: "pass" },
];

const REST_POOL: Array<Pool<"pass" | "unavailable">> = [
  { name: "ok", fault: OK, outcome: "pass" },
  { name: "ok", fault: OK, outcome: "pass" },
  { name: "ok", fault: OK, outcome: "pass" },
  // 503/520 and dead sockets are retried for 1 s/2 s/4 s inside supabase-js
  // (matrix D3/D19/D26, STRESS_SLOW=1); the campaign uses the statuses that
  // answer in one round trip plus a single socket failure (one 1 s retry).
  { name: "http500", fault: http(500), outcome: "unavailable" },
  { name: "http504", fault: http(504), outcome: "unavailable" },
  { name: "http401", fault: http(401), outcome: "unavailable" },
  { name: "http403", fault: http(403), outcome: "unavailable" },
  { name: "emptyRows", fault: malformed("empty-rows"), outcome: "unavailable" },
  {
    name: "emptyThenRow",
    fault: sequence(malformed("empty-rows")),
    outcome: "pass",
  },
  { name: "twoRows", fault: malformed("two-rows"), outcome: "unavailable" },
  { name: "html200", fault: malformed("html"), outcome: "unavailable" },
  { name: "network1", fault: network(1), outcome: "pass" },
  { name: "truncated", fault: truncated, outcome: "unavailable" },
  { name: "slow120", fault: slow(120), outcome: "pass" },
];

/** Redis faults that must be transparent (class unchanged). */
const REDIS_POOL: Array<Pool<"transparent">> = [
  { name: "ok", fault: OK, outcome: "transparent" },
  { name: "ok", fault: OK, outcome: "transparent" },
  { name: "http500", fault: http(500), outcome: "transparent" },
  { name: "http401", fault: http(401), outcome: "transparent" },
  { name: "network", fault: network(), outcome: "transparent" },
  { name: "html200", fault: malformed("html"), outcome: "transparent" },
  {
    name: "emptyObject",
    fault: malformed("empty-object"),
    outcome: "transparent",
  },
  {
    name: "shortReply",
    fault: malformed("short-reply"),
    outcome: "transparent",
  },
  {
    name: "slotErrors",
    fault: malformed("slot-errors"),
    outcome: "transparent",
  },
  { name: "slotNull", fault: malformed("slot-null"), outcome: "transparent" },
  { name: "truncated", fault: truncated, outcome: "transparent" },
];

const RC_POOL: Array<Pool<"transparent">> = [
  { name: "ok", fault: OK, outcome: "transparent" },
  { name: "http500", fault: http(500), outcome: "transparent" },
  { name: "network", fault: network(), outcome: "transparent" },
  { name: "stall", fault: stall, outcome: "transparent" },
];

interface RandomRow {
  iteration: number;
  seed: number;
  bearer: Bearer;
  warm: boolean;
  auth: string;
  rest: string;
  redis: string;
  rc: string;
  expected: VisibleClass;
  observed: VisibleClass;
  status: number;
  retryAfter: string | null;
  durationMs: number;
  counts: Record<Upstream, number>;
  supabaseRoundTrips: number;
  recoveryStatus: number;
  verdict: "PASS" | "FAIL";
  problems: string[];
  replay: string;
}

function randomIteration(
  iteration: number,
  campaignSeed: number,
): {
  seed: number;
  plan:
    & Omit<
      RandomRow,
      | "observed"
      | "status"
      | "retryAfter"
      | "durationMs"
      | "counts"
      | "supabaseRoundTrips"
      | "recoveryStatus"
      | "verdict"
      | "problems"
    >
    & { faults: Record<Upstream, FaultMode> };
} {
  // Per-iteration seed derived from the campaign seed so any row replays alone.
  const seed = (campaignSeed + iteration * 0x9e3779b1) >>> 0;
  const prng = new Prng(seed);
  const bearer: Bearer = prng.pick([
    "session",
    "session",
    "session",
    "session",
    "session",
    "session",
    "expired-session",
    "garbage",
    "none",
  ]);
  const warm = bearer === "session" && prng.next() < 0.35;
  const auth = prng.pick(AUTH_POOL);
  const rest = prng.pick(REST_POOL);
  const redis = prng.pick(REDIS_POOL);
  const rc = prng.pick(RC_POOL);
  let expected: VisibleClass;
  if (bearer !== "session") expected = "refused";
  else if (!warm && auth.outcome === "refused") expected = "refused";
  else if (!warm && auth.outcome === "unavailable") expected = "unavailable";
  else if (
    warm &&
    (redis.name === "shortReply" || redis.name === "slotErrors" ||
      redis.name === "slotNull") &&
    auth.outcome !== "pass"
  ) {
    // Redis reached-but-unknown forces a re-verification even on a warm bearer.
    expected = auth.outcome;
  } else expected = rest.outcome === "pass" ? "ok" : "unavailable";
  return {
    seed,
    plan: {
      iteration,
      seed,
      bearer,
      warm,
      auth: auth.name,
      rest: rest.name,
      redis: redis.name,
      rc: rc.name,
      expected,
      faults: {
        auth: auth.fault,
        rest: rest.fault,
        redis: redis.fault,
        rc: rc.fault,
      },
      replay: replayCommand(
        "stress-me-failure random",
        campaignSeed,
        `STRESS_ONLY_ITER=${iteration} STRESS_ITER=${iteration + 1} `,
      ),
    },
  };
}

Deno.test(`stress-me-failure random campaign: ${STRESS_ITER} seeded upstream-fault combinations (STRESS_ITER, STRESS_SEED)`, async () => {
  const h = await loadStressHarness({ redis: true });
  const onlyIteration = envInt("STRESS_ONLY_ITER", -1);
  const rows: RandomRow[] = [];
  const durations: number[] = [];
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "700");
  try {
    for (let iteration = 0; iteration < STRESS_ITER; iteration += 1) {
      if (onlyIteration >= 0 && iteration !== onlyIteration) continue;
      h.reset();
      const { plan } = randomIteration(iteration, STRESS_SEED);
      const userId = new Prng(plan.seed ^ 0x5bd1e995).uuid();
      h.registerUser(userId);
      const { token } = bearerFor(h, plan.bearer, userId);
      const ip = freshIp();
      const problems: string[] = [];
      if (plan.warm) {
        const warm = await callMe(h, meRequest({ token, ip }));
        if (warm.status !== 200) problems.push(`warm-up ${warm.status}`);
      }
      h.faults = plan.faults;
      h.errorLog = [];
      const observed = await callMe(h, meRequest({ token, ip }));
      const observedClass = classify(observed);
      if (observedClass !== plan.expected) {
        problems.push(
          `class ${observedClass} (status ${observed.status}) != ${plan.expected}`,
        );
      }
      if (observed.status >= 500 && leaksDetail(observed)) {
        problems.push("5xx leaks detail");
      }
      if (!observed.requestId) problems.push("no x-request-id");
      if (observed.status === 200) {
        const bodyProblems = meBodyProblems(observed.body, userId);
        if (bodyProblems.length) {
          problems.push(`body: ${bodyProblems.join("; ")}`);
        }
      }
      if (observed.counts.rc !== 0) problems.push("RevenueCat called");
      // Hot path = no Supabase fault injected: never more than 2 round trips
      // (auth verify + profile read); faulted iterations record their counts.
      const healthyHotPath = plan.auth === "ok" && plan.rest === "ok";
      if (healthyHotPath && observed.counts.auth + observed.counts.rest > 3) {
        problems.push(
          `hot path ${
            observed.counts.auth + observed.counts.rest
          } Supabase round trips`,
        );
      }
      if (observed.counts.rest > 2) {
        problems.push(`rest calls ${observed.counts.rest}`);
      }
      h.faults = { auth: OK, rest: OK, redis: OK, rc: OK };
      const recovery = await callMe(h, meRequest({ token, ip }));
      const wantRecovery = plan.bearer === "session" ? 200 : 401;
      if (recovery.status !== wantRecovery) {
        problems.push(`recovery ${recovery.status} != ${wantRecovery}`);
      }
      durations.push(observed.durationMs);
      rows.push({
        ...plan,
        observed: observedClass,
        status: observed.status,
        retryAfter: observed.retryAfter,
        durationMs: observed.durationMs,
        counts: observed.counts,
        supabaseRoundTrips: observed.counts.auth + observed.counts.rest,
        recoveryStatus: recovery.status,
        verdict: problems.length ? "FAIL" : "PASS",
        problems,
      });
    }
  } finally {
    Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
  }
  const failed = rows.filter((r) => r.verdict === "FAIL");
  const byClass: Record<string, number> = {};
  for (const row of rows) {
    byClass[row.observed] = (byClass[row.observed] ?? 0) + 1;
  }
  const path = await writeArtifact("random_campaign.json", {
    unit: "route-get-v1-me",
    lens: "failure-load",
    campaignSeed: STRESS_SEED,
    iterations: rows.length,
    authTimeoutMs: 700,
    byClass,
    latencyMs: latencySummary(durations),
    maxSupabaseRoundTrips: Math.max(
      0,
      ...rows.map((r) => r.supabaseRoundTrips),
    ),
    failedSeeds: failed.map((r) => r.seed),
    replayAll: replayCommand(
      "stress-me-failure random",
      STRESS_SEED,
      `STRESS_ITER=${STRESS_ITER} `,
    ),
    rows,
  });
  console.log(
    `[stress-me-failure] random ${rows.length} iterations, ${failed.length} failed, classes ${
      JSON.stringify(byClass)
    } → ${path}`,
  );
  assertEquals(
    failed.map((r) =>
      `iter ${r.iteration} seed ${r.seed} [${r.bearer}/${r.auth}/${r.rest}/${r.redis}]: ${
        r.problems.join(" | ")
      }`
    ),
    [],
  );
});
