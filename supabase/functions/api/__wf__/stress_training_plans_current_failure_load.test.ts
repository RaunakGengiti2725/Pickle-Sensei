// STRESS — `GET /v1/training-plans/current` (failure injection + load).
//
// Runs the REAL edge handler in-process (see stress_training_plans_current_harness.ts)
// and, upstream by upstream, makes Supabase Auth / PostgREST / Upstash /
// RevenueCat fail, time out, or answer garbage, asserting the user-visible
// class of every outcome and that the route recovers the moment the upstream
// does. Then a seeded load campaign measures p50/p95 latency, Supabase
// round trips per request and Upstash pipelines per request, and a 20k
// distinct-user sweep watches the L1 caches stay bounded.
//
// Every iteration is replayable from its seed:
//   STRESS_SEED=<n>   master seed (default 20260905)
//   STRESS_ITER=<n>   repetitions per fault case (default 1)
//   STRESS_LOAD=<n>   load-campaign requests (default 300; the campaign run
//                     that produced the evidence used 1200)
//   STRESS_CONC=<n>   concurrent in-flight requests during load (default 16)
//   STRESS_USERS=<n>  distinct users for the L1 memory sweep (default 2000;
//                     evidence run used 20000)
//   STRESS_FULL=1     also run the slow cases (6 s default auth deadline,
//                     hanging Upstash + hanging Auth together)
//   STRESS_CASE=a,b   replay only these fault-case ids (same derived seeds)
//   STRESS_OUT_DIR    where the JSON tables go (default
//                     artifacts/stress-route-get-v1-training-plans-current/latest/)
//
// This file never talks to a network and never modifies production code.

import { assert, assertEquals } from "@std/assert";
import {
  envInt,
  fakeJwt,
  type Faults,
  histogram,
  latencyStats,
  loadStressHarness,
  Prng,
  type Prng as PrngType,
  type RedisReply,
  ROUTE_PATH,
  type RunResult,
  seedFor,
  type StressHarness,
  writeArtifact,
} from "./stress_training_plans_current_harness.ts";

const MASTER_SEED = envInt("STRESS_SEED", 20260905);
const ITER = Math.max(1, envInt("STRESS_ITER", 1));
const LOAD_N = Math.max(50, envInt("STRESS_LOAD", 300));
const LOAD_CONC = Math.max(1, envInt("STRESS_CONC", 16));
const MEMORY_USERS = Math.max(200, envInt("STRESS_USERS", 2000));
const FULL = Deno.env.get("STRESS_FULL") === "1";
/** Comma-separated case ids: replay only these (seeds are per case, so the
 * derived seeds are identical whether or not the other cases run). */
const ONLY_CASES = new Set(
  (Deno.env.get("STRESS_CASE") ?? "").split(",").map((s) => s.trim())
    .filter(Boolean),
);
/** Auth deadline used by most fault cases (the default 6 s is exercised once
 * under STRESS_FULL). The function reads the env on every call. */
const FAST_AUTH_DEADLINE_MS = 1_500;

const USER_LIMIT = 240;
const IP_LIMIT = 1_200;
const AUTH_FAILURE_LIMIT = 30;
const L1_MAX_ENTRIES = 5_000;
const REDIS_TIMEOUT_MS = 1_200;

// ── Case model ───────────────────────────────────────────────────────────────

type Bearer =
  | "session"
  | "provider-google"
  | "provider-apple"
  | "forged"
  | "none"
  | "garbage"
  | "expired"
  | "wrong-issuer";

interface Expect {
  status: number | number[];
  /** 200 bodies must be exactly `{ plan: null }`. */
  planNull?: boolean;
  errorIncludes?: string;
  /** Retry-After header: exact seconds, or "absent". */
  retryAfter?: number | "absent";
  supabase?: { exact?: number; min?: number; max?: number };
  rest?: number;
  rc?: number;
  minMs?: number;
  maxMs?: number;
  /** A 5xx must log operator detail while the body stays generic. */
  operatorDetail?: boolean;
  /** Whether the request must (true) / must not (false) spend the per-IP auth-failure budget. */
  authFailureCharged?: boolean;
  headers?: Record<string, string>;
}

interface Setup {
  faults?: Faults;
  bearer?: Bearer;
  /** l2-only: verified once, then the L1 row is evicted by filling the
   * isolate cache with L1_MAX_ENTRIES fresh sessions — the "other isolate"
   * shape where L2 holds the row and L1 does not. */
  cache?: "cold" | "warm" | "l2-only";
  /** Env override for AUTH_UPSTREAM_TIMEOUT_MS; null = the function default. */
  authDeadlineMs?: number | null;
  request?: {
    method?: string;
    path?: string;
    mount?: "/functions/v1/api" | "/api" | "";
    headers?: Record<string, string>;
  };
  /** Pre-seed the fake Upstash store (rate-limit counters) before the request. */
  redisPreset?: (
    ctx: { ip: string; userId: string },
  ) => Array<[string, string]>;
  /** How the user's GoTrue record looks (default google). */
  user?: { provider: string; providers?: string[] };
}

interface FaultCase {
  id: string;
  upstream:
    | "auth"
    | "auth-provider"
    | "redis"
    | "rest"
    | "rc"
    | "combined"
    | "request"
    | "ratelimit";
  title: string;
  setup: (prng: PrngType) => Setup;
  expect: Expect;
  /** Clear faults (and presets) and replay the same bearer; expect this. */
  recover?: Expect;
  slow?: boolean;
  /** Severity a BROKEN outcome carries. P0–P2 fail the step; a P3 is recorded
   * in the JSON table (outcome BROKEN) without failing the suite. */
  severityIfBroken?: "P0" | "P1" | "P2" | "P3";
}

interface Row {
  seed: number;
  case: string;
  upstream: string;
  iteration: number;
  bearer: Bearer;
  cache: "cold" | "warm" | "l2-only";
  status: number;
  retryAfter: string | null;
  durationMs: number;
  calls: RunResult["calls"];
  recoverStatus: number | null;
  recoverCalls: RunResult["calls"] | null;
  outcome: "HELD" | "BROKEN";
  violations: string[];
  body: unknown;
  requestId: string;
}

const html = "<html><body><h1>502 Bad Gateway</h1></body></html>";

const gotrueBody = (overrides: Record<string, unknown>) => ({
  id: "00000000-0000-4000-8000-000000000000",
  aud: "authenticated",
  role: "authenticated",
  app_metadata: { provider: "google", providers: ["google"] },
  ...overrides,
});

const unavailable503: Expect = {
  status: 503,
  errorIncludes: "temporarily unavailable",
  retryAfter: 2,
  supabase: { exact: 1 },
  rest: 0,
  rc: 0,
  operatorDetail: true,
  authFailureCharged: false,
};
const refused401: Expect = {
  status: 401,
  errorIncludes: "no longer valid",
  retryAfter: "absent",
  supabase: { exact: 1 },
  rest: 0,
  rc: 0,
  authFailureCharged: true,
};
const ok200: Expect = {
  status: 200,
  planNull: true,
  rest: 0,
  rc: 0,
  authFailureCharged: false,
};
const ok200cold: Expect = { ...ok200, supabase: { exact: 1 } };
const ok200warm: Expect = { ...ok200, supabase: { exact: 0 } };
const preAuth401 = (fragment: string): Expect => ({
  status: 401,
  errorIncludes: fragment,
  supabase: { exact: 0 },
  rest: 0,
  rc: 0,
  authFailureCharged: true,
});

const pipelineStartsWith = (op: string) => (body: unknown) =>
  Array.isArray(body) && Array.isArray(body[0]) && String(body[0][0]) === op;

const FAULT_CASES: FaultCase[] = [
  // ── Supabase Auth (GoTrue GET /auth/v1/user), cold cache ─────────────────
  {
    id: "auth-http-500-text",
    upstream: "auth",
    title:
      "GoTrue 500 with a text body → generic 503 + Retry-After 2, recovers",
    setup: () => ({
      faults: {
        auth: { mode: "http", status: 500, body: "Internal Server Error" },
      },
    }),
    expect: unavailable503,
    recover: ok200cold,
  },
  {
    id: "auth-http-502-html",
    upstream: "auth",
    title: "GoTrue 502 HTML gateway page → 503",
    setup: () => ({
      faults: { auth: { mode: "http", status: 502, body: html } },
    }),
    expect: unavailable503,
    recover: ok200cold,
  },
  {
    id: "auth-http-503-retry-after-7",
    upstream: "auth",
    title: "GoTrue 503 carrying Retry-After: 7 → 503 forwarding Retry-After 7",
    setup: () => ({
      faults: {
        auth: {
          mode: "http",
          status: 503,
          body: { msg: "down" },
          headers: { "Retry-After": "7" },
        },
      },
    }),
    expect: { ...unavailable503, retryAfter: 7 },
    recover: ok200cold,
  },
  {
    id: "auth-http-504",
    upstream: "auth",
    title: "GoTrue 504 → 503",
    setup: () => ({
      faults: { auth: { mode: "http", status: 504, body: "" } },
    }),
    expect: unavailable503,
    recover: ok200cold,
  },
  {
    id: "auth-http-429-retry-after-30",
    upstream: "auth",
    title:
      "GoTrue rate-limits the function (429, Retry-After 30) → 503 Retry-After 30, NOT a refusal",
    setup: () => ({
      faults: {
        auth: {
          mode: "http",
          status: 429,
          body: { msg: "too many" },
          headers: { "Retry-After": "30" },
        },
      },
    }),
    expect: { ...unavailable503, retryAfter: 30 },
    recover: ok200cold,
  },
  {
    id: "auth-http-401",
    upstream: "auth",
    title:
      "GoTrue 401 (bad_jwt) → 401 refusal charged to the auth-failure budget; same bearer works once Auth does",
    setup: () => ({
      faults: {
        auth: {
          mode: "http",
          status: 401,
          body: { code: 401, error_code: "bad_jwt", msg: "invalid JWT" },
        },
      },
    }),
    expect: refused401,
    recover: ok200cold,
  },
  {
    id: "auth-http-403-session-not-found",
    upstream: "auth",
    title: "GoTrue 403 session_not_found → 401 refusal",
    setup: () => ({
      faults: {
        auth: {
          mode: "http",
          status: 403,
          body: {
            code: 403,
            error_code: "session_not_found",
            msg: "Session does not exist",
          },
        },
      },
    }),
    expect: refused401,
    recover: ok200cold,
  },
  {
    id: "auth-http-400",
    upstream: "auth",
    title: "GoTrue 400 → 401 refusal",
    setup: () => ({
      faults: {
        auth: { mode: "http", status: 400, body: { msg: "bad request" } },
      },
    }),
    expect: refused401,
    recover: ok200cold,
  },
  {
    id: "auth-http-404",
    upstream: "auth",
    title: "GoTrue 404 (misrouted) → 503, not a sign-out",
    setup: () => ({
      faults: { auth: { mode: "http", status: 404, body: "not found" } },
    }),
    expect: unavailable503,
    recover: ok200cold,
  },
  {
    id: "auth-200-html-body",
    upstream: "auth",
    title:
      "GoTrue 200 with an HTML body → 503 (malformed success is unavailability)",
    setup: () => ({
      faults: {
        auth: {
          mode: "http",
          status: 200,
          body: html,
          headers: { "Content-Type": "text/html" },
        },
      },
    }),
    expect: unavailable503,
    recover: ok200cold,
  },
  {
    id: "auth-200-empty-body",
    upstream: "auth",
    title: "GoTrue 200 with an empty body → 503",
    setup: () => ({
      faults: { auth: { mode: "http", status: 200, body: "" } },
    }),
    expect: unavailable503,
    recover: ok200cold,
  },
  {
    id: "auth-200-json-no-id",
    upstream: "auth",
    title: "GoTrue 200 JSON without id → 503",
    setup: () => ({
      faults: {
        auth: { mode: "http", status: 200, body: { aud: "authenticated" } },
      },
    }),
    expect: unavailable503,
    recover: ok200cold,
  },
  {
    id: "auth-200-json-array",
    upstream: "auth",
    title: "GoTrue 200 `[]` → 503",
    setup: () => ({
      faults: { auth: { mode: "http", status: 200, body: [] } },
    }),
    expect: unavailable503,
    recover: ok200cold,
  },
  {
    id: "auth-200-id-empty-string",
    upstream: "auth",
    title: "GoTrue 200 with id:'' → 503",
    setup: () => ({
      faults: {
        auth: { mode: "http", status: 200, body: gotrueBody({ id: "" }) },
      },
    }),
    expect: unavailable503,
    recover: ok200cold,
  },
  {
    id: "auth-200-id-number",
    upstream: "auth",
    title: "GoTrue 200 with a numeric id → 503",
    setup: () => ({
      faults: {
        auth: { mode: "http", status: 200, body: gotrueBody({ id: 42 }) },
      },
    }),
    expect: unavailable503,
    recover: ok200cold,
  },
  {
    id: "auth-200-provider-email",
    upstream: "auth",
    title:
      "GoTrue says the user is email-only → 401 (not a Google/Apple account), charged",
    setup: (prng) => ({
      faults: {
        auth: {
          mode: "http",
          status: 200,
          body: gotrueBody({
            id: prng.uuid(),
            app_metadata: { provider: "email", providers: ["email"] },
          }),
        },
      },
    }),
    expect: { ...refused401, errorIncludes: "Google or Apple" },
    recover: ok200cold,
  },
  {
    id: "auth-200-provider-email-linked-google",
    upstream: "auth",
    title: "email primary with a linked google identity → 200",
    setup: () => ({
      user: { provider: "email", providers: ["email", "google"] },
    }),
    expect: ok200cold,
  },
  {
    id: "auth-200-no-app-metadata",
    upstream: "auth",
    title:
      "GoTrue 200 with id but no app_metadata → 401 (no provider evidence)",
    setup: (prng) => ({
      faults: {
        auth: { mode: "http", status: 200, body: { id: prng.uuid() } },
      },
    }),
    expect: { ...refused401, errorIncludes: "Google or Apple" },
    recover: ok200cold,
  },
  {
    id: "auth-throw-persistent",
    upstream: "auth",
    title:
      "GoTrue socket errors on every attempt → bounded retries then 503; recovers",
    setup: () => ({ faults: { auth: { mode: "throw" } } }),
    expect: {
      ...unavailable503,
      supabase: { min: 2, max: 6 },
      maxMs: FAST_AUTH_DEADLINE_MS + 600,
    },
    recover: ok200cold,
  },
  {
    id: "auth-throw-once-then-ok",
    upstream: "auth",
    title:
      "one socket error then healthy → 200 after one backoff (2 Supabase round trips)",
    setup: () => ({
      faults: { auth: { mode: "throw", attempts: (a) => a === 0 } },
    }),
    expect: { ...ok200, supabase: { exact: 2 }, minMs: 90 },
  },
  {
    id: "auth-throw-twice-then-ok",
    upstream: "auth",
    title:
      "two socket errors then healthy → 200 (3 round trips, still within the >3 budget)",
    setup: () => ({
      faults: { auth: { mode: "throw", attempts: (a) => a < 2 } },
    }),
    expect: { ...ok200, supabase: { exact: 3 }, minMs: 280 },
  },
  {
    id: "auth-hang-deadline-1500",
    upstream: "auth",
    title:
      "GoTrue never answers → 503 at the auth deadline (1.5 s override), single round trip",
    setup: () => ({ faults: { auth: { mode: "hang" } } }),
    expect: {
      ...unavailable503,
      supabase: { exact: 1 },
      minMs: FAST_AUTH_DEADLINE_MS - 50,
      maxMs: FAST_AUTH_DEADLINE_MS + 700,
    },
    recover: ok200cold,
  },
  {
    id: "auth-hang-deadline-default-6000",
    upstream: "auth",
    title: "GoTrue never answers, default deadline → 503 at ~6 s",
    setup: () => ({
      faults: { auth: { mode: "hang", delayMs: 20_000 } },
      authDeadlineMs: null,
    }),
    expect: { ...unavailable503, minMs: 5_900, maxMs: 7_500 },
    recover: ok200cold,
    slow: true,
  },
  {
    id: "auth-slow-300",
    upstream: "auth",
    title: "GoTrue slow but inside the deadline → 200, latency ≥ 300 ms",
    setup: () => ({ faults: { auth: { mode: "slow", delayMs: 300 } } }),
    expect: { ...ok200cold, minMs: 290 },
  },
  {
    id: "auth-slow-past-deadline",
    upstream: "auth",
    title:
      "GoTrue answers after the deadline → 503 at the deadline, answer discarded",
    setup: () => ({ faults: { auth: { mode: "slow", delayMs: 4_000 } } }),
    expect: {
      ...unavailable503,
      minMs: FAST_AUTH_DEADLINE_MS - 50,
      maxMs: FAST_AUTH_DEADLINE_MS + 700,
    },
    recover: ok200cold,
  },
  {
    id: "auth-500-retry-after-garbage",
    upstream: "auth",
    title: "Retry-After: abc → default Retry-After 2",
    setup: () => ({
      faults: {
        auth: {
          mode: "http",
          status: 500,
          body: "x",
          headers: { "Retry-After": "abc" },
        },
      },
    }),
    expect: unavailable503,
  },
  {
    id: "auth-500-retry-after-zero",
    upstream: "auth",
    title: "Retry-After: 0 → default 2",
    setup: () => ({
      faults: {
        auth: {
          mode: "http",
          status: 500,
          body: "x",
          headers: { "Retry-After": "0" },
        },
      },
    }),
    expect: unavailable503,
  },
  {
    id: "auth-500-retry-after-negative",
    upstream: "auth",
    title: "Retry-After: -5 → default 2",
    setup: () => ({
      faults: {
        auth: {
          mode: "http",
          status: 500,
          body: "x",
          headers: { "Retry-After": "-5" },
        },
      },
    }),
    expect: unavailable503,
  },
  {
    id: "auth-500-retry-after-float",
    upstream: "auth",
    title: "Retry-After: 1.5 → default 2",
    setup: () => ({
      faults: {
        auth: {
          mode: "http",
          status: 500,
          body: "x",
          headers: { "Retry-After": "1.5" },
        },
      },
    }),
    expect: unavailable503,
  },
  {
    id: "auth-500-retry-after-http-date",
    upstream: "auth",
    title: "Retry-After as an HTTP date → default 2 (never forwarded verbatim)",
    setup: () => ({
      faults: {
        auth: {
          mode: "http",
          status: 500,
          body: "x",
          headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
        },
      },
    }),
    expect: unavailable503,
  },
  {
    id: "auth-500-retry-after-huge",
    upstream: "auth",
    title:
      "Retry-After: 999999 → should be clamped (≤ 300 like the 429 path), not forwarded verbatim",
    setup: () => ({
      faults: {
        auth: {
          mode: "http",
          status: 500,
          body: "x",
          headers: { "Retry-After": "999999" },
        },
      },
    }),
    expect: { ...unavailable503, retryAfter: 300 },
    severityIfBroken: "P3",
  },
  {
    id: "auth-down-warm-cache",
    upstream: "auth",
    title:
      "GoTrue down but the session was verified earlier → 200 from cache, zero Supabase round trips",
    setup: () => ({
      cache: "warm",
      faults: { auth: { mode: "http", status: 500, body: "x" } },
    }),
    expect: ok200warm,
  },
  {
    id: "auth-hang-warm-cache",
    upstream: "auth",
    title: "GoTrue hanging but the session is cached → 200 fast",
    setup: () => ({ cache: "warm", faults: { auth: { mode: "hang" } } }),
    expect: { ...ok200warm, maxMs: 500 },
  },
  {
    id: "auth-healthy-forged-token",
    upstream: "auth",
    title:
      "Supabase-shaped bearer nobody minted → 401 refusal (baseline refusal path)",
    setup: () => ({ bearer: "forged" }),
    expect: refused401,
  },
  {
    id: "auth-healthy-revoked-session",
    upstream: "auth",
    title: "session revoked at GoTrue (403 session_not_found) → 401",
    setup: () => ({
      faults: {
        auth: {
          mode: "http",
          status: 403,
          body: { code: 403, error_code: "session_not_found", msg: "gone" },
        },
      },
    }),
    expect: refused401,
  },

  // ── Transitional provider-ID-token bearer (signInWithIdToken via supabase-js) ──
  {
    id: "provider-token-healthy",
    upstream: "auth-provider",
    title:
      "Google ID token bearer (transitional) → 200, one Supabase round trip, then cached",
    setup: () => ({ bearer: "provider-google" }),
    expect: ok200cold,
    recover: ok200warm,
  },
  {
    id: "provider-token-apple-healthy",
    upstream: "auth-provider",
    title: "Apple ID token bearer (transitional) → 200",
    setup: () => ({ bearer: "provider-apple", user: { provider: "apple" } }),
    expect: ok200cold,
  },
  {
    id: "provider-token-auth-500",
    upstream: "auth-provider",
    title:
      "provider bearer while GoTrue answers 500 → 401 (transitional branch folds an outage into a refusal)",
    setup: () => ({
      bearer: "provider-google",
      faults: { auth: { mode: "http", status: 500, body: "x" } },
    }),
    // Observed + documented (AGENTS.md: transitional branch pending removal);
    // reported as a P3 in the campaign report, pinned here as-is.
    expect: {
      status: 401,
      errorIncludes: "could not be verified",
      supabase: { min: 1 },
      rest: 0,
      rc: 0,
      authFailureCharged: true,
    },
    recover: ok200cold,
  },
  {
    id: "provider-token-auth-400",
    upstream: "auth-provider",
    title: "provider bearer refused by GoTrue (400 bad_id_token) → 401",
    setup: () => ({
      bearer: "provider-google",
      faults: {
        auth: {
          mode: "http",
          status: 400,
          body: { error: "invalid_grant", error_code: "bad_id_token" },
        },
      },
    }),
    expect: {
      status: 401,
      errorIncludes: "could not be verified",
      supabase: { min: 1 },
      rest: 0,
      rc: 0,
    },
  },
  {
    id: "provider-token-auth-200-malformed",
    upstream: "auth-provider",
    title: "provider bearer, GoTrue 200 without a session → 401",
    setup: () => ({
      bearer: "provider-google",
      faults: { auth: { mode: "http", status: 200, body: { hello: 1 } } },
    }),
    expect: {
      status: 401,
      errorIncludes: "could not be verified",
      supabase: { min: 1 },
      rest: 0,
      rc: 0,
    },
  },
  {
    id: "provider-token-auth-throw",
    upstream: "auth-provider",
    title:
      "provider bearer, GoTrue socket error → 401 (supabase-js path, no retry/backoff of ours)",
    setup: () => ({
      bearer: "provider-google",
      faults: { auth: { mode: "throw" } },
    }),
    expect: {
      status: 401,
      errorIncludes: "could not be verified",
      supabase: { min: 1 },
      rest: 0,
      rc: 0,
      maxMs: 4_000,
    },
  },
  {
    id: "provider-token-auth-hang-2500",
    upstream: "auth-provider",
    title:
      "provider bearer, GoTrue hangs 2.5 s → the request waits it out (no deadline on this branch)",
    setup: () => ({
      bearer: "provider-google",
      faults: { auth: { mode: "hang", delayMs: 2_500 } },
    }),
    expect: { status: 401, supabase: { min: 1 }, rest: 0, rc: 0, minMs: 2_400 },
  },

  // ── Upstash (auth-cache L2 + shared rate limits) ─────────────────────────
  {
    id: "redis-http-500-cold",
    upstream: "redis",
    title:
      "Upstash 500 on every pipeline, cold → 200 (memory fallback), one Supabase round trip",
    setup: () => ({
      faults: {
        redis: { mode: "http", status: 500, body: { error: "internal" } },
      },
    }),
    expect: ok200cold,
  },
  {
    id: "redis-http-500-warm",
    upstream: "redis",
    title: "Upstash 500, session in L1 → 200 with zero Supabase round trips",
    setup: () => ({
      cache: "warm",
      faults: {
        redis: { mode: "http", status: 500, body: { error: "internal" } },
      },
    }),
    expect: ok200warm,
  },
  {
    id: "redis-http-401",
    upstream: "redis",
    title: "Upstash token rejected (401) → 200",
    setup: () => ({
      faults: {
        redis: { mode: "http", status: 401, body: { error: "Unauthorized" } },
      },
    }),
    expect: ok200cold,
  },
  {
    id: "redis-http-429",
    upstream: "redis",
    title: "Upstash quota exceeded (429) → 200",
    setup: () => ({
      faults: {
        redis: { mode: "http", status: 429, body: { error: "quota" } },
      },
    }),
    expect: ok200cold,
  },
  {
    id: "redis-throw",
    upstream: "redis",
    title: "Upstash socket error → 200",
    setup: (prng) => ({
      cache: prng.chance(0.5) ? "warm" : "cold",
      faults: { redis: { mode: "throw" } },
    }),
    expect: ok200,
  },
  {
    id: "redis-hang-warm",
    upstream: "redis",
    title:
      "Upstash hangs, session cached → still 200 but every pipeline waits its 1.2 s timeout",
    setup: () => ({ cache: "warm", faults: { redis: { mode: "hang" } } }),
    expect: {
      ...ok200warm,
      minMs: 3 * REDIS_TIMEOUT_MS,
      maxMs: 5 * REDIS_TIMEOUT_MS + 500,
    },
  },
  {
    id: "redis-hang-cold",
    upstream: "redis",
    title:
      "Upstash hangs, cold → 200 after (pipelines × 1.2 s) + one Supabase round trip",
    setup: () => ({ faults: { redis: { mode: "hang" } } }),
    expect: {
      ...ok200cold,
      minMs: 4 * REDIS_TIMEOUT_MS,
      maxMs: 8 * REDIS_TIMEOUT_MS + 500,
    },
    slow: true,
  },
  {
    id: "redis-slow-150",
    upstream: "redis",
    title: "Upstash 150 ms per pipeline → 200, latency ≈ pipelines × 150 ms",
    setup: () => ({
      cache: "warm",
      faults: { redis: { mode: "slow", delayMs: 150 } },
    }),
    expect: { ...ok200warm, minMs: 4 * 150 - 20 },
  },
  {
    id: "redis-200-html",
    upstream: "redis",
    title: "Upstash 200 with an HTML body → 200",
    setup: () => ({
      faults: { redis: { mode: "http", status: 200, body: html } },
    }),
    expect: ok200cold,
  },
  {
    id: "redis-200-object",
    upstream: "redis",
    title: "Upstash 200 `{}` instead of an array → 200",
    setup: () => ({
      faults: { redis: { mode: "http", status: 200, body: {} } },
    }),
    expect: ok200cold,
  },
  {
    id: "redis-200-null",
    upstream: "redis",
    title: "Upstash 200 `null` → 200",
    setup: () => ({
      faults: {
        redis: {
          mode: "http",
          status: 200,
          body: "null",
          headers: { "Content-Type": "application/json" },
        },
      },
    }),
    expect: ok200cold,
  },
  {
    id: "redis-reply-all-errors-cold",
    upstream: "redis",
    title: "every pipeline slot is a command error, cold → 200",
    setup: () => ({
      faults: {
        redis: {
          mode: "reply",
          reply: () => ({ error: "ERR max requests limit exceeded" }),
        },
      },
    }),
    expect: ok200cold,
  },
  {
    id: "redis-reply-all-errors-warm",
    upstream: "redis",
    title:
      "command errors with a warm L1 → 200, but the unknown revocation state re-verifies (1 round trip)",
    setup: () => ({
      cache: "warm",
      faults: {
        redis: {
          mode: "reply",
          reply: () => ({ error: "ERR max requests limit exceeded" }),
        },
      },
    }),
    expect: { ...ok200, supabase: { max: 1 } },
  },
  {
    id: "redis-reply-truncated",
    upstream: "redis",
    title: "pipeline reply missing its last slot → 200",
    setup: () => ({
      cache: "warm",
      faults: {
        redis: {
          mode: "reply",
          transform: (replies: RedisReply[]) => replies.slice(0, -1),
        },
      },
    }),
    expect: { ...ok200, supabase: { max: 1 } },
  },
  {
    id: "redis-reply-empty-array",
    upstream: "redis",
    title: "pipeline reply `[]` for every request → 200",
    setup: (prng) => ({
      cache: prng.chance(0.5) ? "warm" : "cold",
      faults: { redis: { mode: "reply", transform: () => [] } },
    }),
    expect: { ...ok200, supabase: { max: 1 } },
  },
  {
    id: "redis-reply-extra-slots",
    upstream: "redis",
    title: "pipeline reply with extra trailing slots → 200",
    setup: () => ({
      cache: "warm",
      faults: {
        redis: {
          mode: "reply",
          transform: (
            replies: RedisReply[],
          ) => [...replies, { result: "junk" }, { result: 1 }],
        },
      },
    }),
    expect: ok200warm,
  },
  {
    id: "redis-reply-incr-string",
    upstream: "redis",
    title: "INCR answers a non-numeric string → memory fallback, 200",
    setup: () => ({
      faults: {
        redis: {
          mode: "reply",
          reply: (
            command: Array<string | number>,
          ) => (String(command[0]) === "INCR" ? { result: "abc" } : undefined),
        },
      },
    }),
    expect: ok200cold,
  },
  {
    id: "redis-reply-incr-huge",
    upstream: "redis",
    title:
      "shared INCR counter says the IP is far over budget → 429 pre-auth with RateLimit headers; recovers",
    setup: () => ({
      faults: {
        redis: {
          mode: "reply",
          reply: (
            command: Array<string | number>,
          ) => (String(command[0]) === "INCR"
            ? { result: 10_000_000 }
            : undefined),
        },
      },
    }),
    expect: {
      status: 429,
      supabase: { exact: 0 },
      rest: 0,
      rc: 0,
      headers: {
        "ratelimit-limit": String(IP_LIMIT),
        "ratelimit-remaining": "0",
      },
      authFailureCharged: false,
    },
    recover: ok200cold,
  },
  {
    id: "redis-reply-get-returns-ok-string",
    upstream: "redis",
    title:
      "every GET answers the string 'OK' (wrong-typed slot) → must not be read as a revocation (401)",
    setup: () => ({
      cache: "warm",
      faults: {
        redis: {
          mode: "reply",
          reply: (
            command: Array<string | number>,
          ) => (String(command[0]) === "GET" ? { result: "OK" } : undefined),
        },
      },
    }),
    // Desired: a wrong-typed L2 reply is "unknown" → re-verify with GoTrue → 200;
    // and once Upstash answers properly again the same bearer is served.
    expect: { ...ok200, supabase: { max: 1 } },
    recover: { ...ok200, supabase: { max: 1 } },
  },
  {
    id: "redis-reply-shifted-left",
    upstream: "redis",
    title:
      "pipeline reply misaligned by one slot (first slot dropped), L2 warm / L1 cold → the cached row lands in the marker slot; must not be read as a revocation",
    slow: true,
    setup: () => ({
      cache: "l2-only",
      faults: {
        redis: {
          mode: "reply",
          when: pipelineStartsWith("GET"),
          transform: (
            replies: RedisReply[],
          ) => [...replies.slice(1), { result: null }],
        },
      },
    }),
    expect: { ...ok200, supabase: { max: 1 } },
    recover: { ...ok200, supabase: { max: 1 } },
  },
  {
    id: "redis-reply-ttl-minus-2",
    upstream: "redis",
    title:
      "L2 says the cached session expired (TTL -2) while L1 holds it → L1 dropped, one re-verify, 200",
    setup: () => ({
      cache: "warm",
      faults: {
        redis: {
          mode: "reply",
          reply: (command: Array<string | number>) =>
            String(command[0]) === "TTL"
              ? { result: -2 }
              : String(command[0]) === "GET"
              ? { result: null }
              : undefined,
        },
      },
    }),
    expect: { ...ok200, supabase: { exact: 1 } },
  },
  {
    id: "redis-intermittent-500",
    upstream: "redis",
    title: "Upstash 500 on every other pipeline → 200",
    setup: (prng) => ({
      cache: prng.chance(0.5) ? "warm" : "cold",
      faults: {
        redis: {
          mode: "http",
          status: 500,
          body: "x",
          attempts: (a) => a % 2 === 1,
        },
      },
    }),
    expect: { ...ok200, supabase: { max: 1 } },
  },
  {
    id: "redis-fail-rate-limit-pipelines-only",
    upstream: "redis",
    title:
      "only INCR pipelines fail (rate limits) → memory windows, 200, cache still served",
    setup: () => ({
      cache: "warm",
      faults: {
        redis: {
          mode: "http",
          status: 500,
          body: "x",
          when: pipelineStartsWith("INCR"),
        },
      },
    }),
    expect: ok200warm,
  },
  {
    id: "redis-fail-cache-pipelines-only",
    upstream: "redis",
    title:
      "only GET pipelines fail (cache/authfail reads) → L1 answers, zero Supabase round trips",
    setup: () => ({
      cache: "warm",
      faults: {
        redis: {
          mode: "http",
          status: 500,
          body: "x",
          when: pipelineStartsWith("GET"),
        },
      },
    }),
    expect: ok200warm,
  },
  {
    id: "redis-hang-cache-pipelines-only",
    upstream: "redis",
    title: "GET pipelines hang → 200 from L1 after the read timeouts",
    setup: () => ({
      cache: "warm",
      faults: { redis: { mode: "hang", when: pipelineStartsWith("GET") } },
    }),
    expect: { ...ok200warm, minMs: REDIS_TIMEOUT_MS - 50 },
  },

  // ── PostgREST — the route never touches it; prove it ─────────────────────
  {
    id: "rest-http-500",
    upstream: "rest",
    title: "PostgREST 500 → 200, zero PostgREST calls",
    setup: (prng) => ({
      cache: prng.chance(0.5) ? "warm" : "cold",
      faults: { rest: { mode: "http", status: 500, body: "x" } },
    }),
    expect: ok200,
  },
  {
    id: "rest-hang",
    upstream: "rest",
    title: "PostgREST hanging → 200 fast (never awaited)",
    setup: () => ({ faults: { rest: { mode: "hang" } } }),
    expect: { ...ok200cold, maxMs: 500 },
  },
  {
    id: "rest-throw",
    upstream: "rest",
    title: "PostgREST socket error → 200",
    setup: () => ({ faults: { rest: { mode: "throw" } } }),
    expect: ok200cold,
  },
  {
    id: "rest-malformed",
    upstream: "rest",
    title: "PostgREST HTML → 200",
    setup: () => ({
      faults: { rest: { mode: "http", status: 200, body: html } },
    }),
    expect: ok200cold,
  },
  {
    id: "rest-401",
    upstream: "rest",
    title: "PostgREST 401 (JWT rejected downstream) → 200, never consulted",
    setup: () => ({
      cache: "warm",
      faults: {
        rest: { mode: "http", status: 401, body: { message: "JWSError" } },
      },
    }),
    expect: ok200warm,
  },

  // ── RevenueCat — the route never touches it; prove it ────────────────────
  {
    id: "rc-http-500",
    upstream: "rc",
    title: "RevenueCat 500 → 200, zero RC calls",
    setup: () => ({ faults: { rc: { mode: "http", status: 500, body: "x" } } }),
    expect: ok200cold,
  },
  {
    id: "rc-hang",
    upstream: "rc",
    title: "RevenueCat hanging → 200 fast",
    setup: () => ({ cache: "warm", faults: { rc: { mode: "hang" } } }),
    expect: { ...ok200warm, maxMs: 500 },
  },
  {
    id: "rc-throw",
    upstream: "rc",
    title: "RevenueCat socket error → 200",
    setup: () => ({ faults: { rc: { mode: "throw" } } }),
    expect: ok200cold,
  },
  {
    id: "rc-malformed",
    upstream: "rc",
    title: "RevenueCat malformed JSON → 200",
    setup: () => ({
      faults: {
        rc: {
          mode: "http",
          status: 200,
          body: "{not json",
          headers: { "Content-Type": "application/json" },
        },
      },
    }),
    expect: ok200cold,
  },

  // ── Combined outages ─────────────────────────────────────────────────────
  {
    id: "all-down-cold",
    upstream: "combined",
    title:
      "Auth+Upstash+PostgREST+RC all 500, cold → 503; everything back → 200",
    setup: () => ({
      faults: {
        auth: { mode: "http", status: 500, body: "x" },
        redis: { mode: "http", status: 500, body: "x" },
        rest: { mode: "http", status: 500, body: "x" },
        rc: { mode: "http", status: 500, body: "x" },
      },
    }),
    expect: unavailable503,
    recover: ok200cold,
  },
  {
    id: "all-down-warm",
    upstream: "combined",
    title:
      "everything down but the session sits in L1 → 200 with zero upstream success needed",
    setup: () => ({
      cache: "warm",
      faults: {
        auth: { mode: "http", status: 500, body: "x" },
        redis: { mode: "http", status: 500, body: "x" },
        rest: { mode: "http", status: 500, body: "x" },
        rc: { mode: "http", status: 500, body: "x" },
      },
    }),
    expect: ok200warm,
  },
  {
    id: "all-throw-warm",
    upstream: "combined",
    title: "every upstream socket-errors, warm L1 → 200",
    setup: () => ({
      cache: "warm",
      faults: {
        auth: { mode: "throw" },
        redis: { mode: "throw" },
        rest: { mode: "throw" },
        rc: { mode: "throw" },
      },
    }),
    expect: ok200warm,
  },
  {
    id: "auth-hang-redis-hang-cold",
    upstream: "combined",
    title: "Auth and Upstash both hang, cold → 503 after both deadlines add up",
    setup: () => ({
      faults: { auth: { mode: "hang" }, redis: { mode: "hang" } },
    }),
    expect: {
      ...unavailable503,
      minMs: FAST_AUTH_DEADLINE_MS + 3 * REDIS_TIMEOUT_MS - 100,
    },
    recover: ok200cold,
    slow: true,
  },
  {
    id: "auth-500-redis-errors-warm",
    upstream: "combined",
    title:
      "Upstash command errors + Auth 500, warm L1 → unknown revocation → re-verify fails → 503 (never 401)",
    setup: () => ({
      cache: "warm",
      faults: {
        auth: { mode: "http", status: 500, body: "x" },
        redis: { mode: "reply", reply: () => ({ error: "ERR" }) },
      },
    }),
    expect: { status: [200, 503], authFailureCharged: false, rest: 0, rc: 0 },
    recover: ok200,
  },

  // ── Request shape (pre-auth guards) ──────────────────────────────────────
  {
    id: "request-no-bearer",
    upstream: "request",
    title: "no Authorization → 401, zero upstream, charged",
    setup: () => ({ bearer: "none" }),
    expect: preAuth401("Missing bearer"),
  },
  {
    id: "request-garbage-bearer",
    upstream: "request",
    title: "bearer 'not-a-jwt' → 401 without a Supabase round trip",
    setup: () => ({ bearer: "garbage" }),
    expect: preAuth401("not a session token"),
  },
  {
    id: "request-expired-session-token",
    upstream: "request",
    title: "expired Supabase access token → 401 locally, zero round trips",
    setup: () => ({ bearer: "expired" }),
    expect: preAuth401("expired"),
  },
  {
    id: "request-wrong-issuer",
    upstream: "request",
    title:
      "JWT from an unknown issuer → treated as a session token: one GoTrue round trip, 401, charged",
    setup: () => ({ bearer: "wrong-issuer" }),
    expect: refused401,
  },
  {
    id: "request-oversized-content-length",
    upstream: "request",
    title: "GET declaring a 6 MB body → 413 before auth",
    setup: () => ({
      request: { headers: { "content-length": String(6_000_000) } },
    }),
    expect: {
      status: 413,
      supabase: { exact: 0 },
      rest: 0,
      rc: 0,
      authFailureCharged: false,
    },
  },
  {
    id: "request-client-request-id-honoured",
    upstream: "request",
    title: "well-formed client x-request-id is echoed",
    setup: (prng) => ({
      request: { headers: { "x-request-id": `stress-${prng.hex(24)}` } },
    }),
    expect: ok200cold,
  },
  {
    id: "request-client-request-id-rejected",
    upstream: "request",
    title: "malformed client x-request-id is replaced by a minted one",
    setup: () => ({
      request: { headers: { "x-request-id": "<script>alert(1)</script>" } },
    }),
    expect: ok200cold,
  },
  {
    id: "request-mount-api",
    upstream: "request",
    title: "gateway presents /api prefix → 200",
    setup: () => ({ request: { mount: "/api" } }),
    expect: ok200cold,
  },
  {
    id: "request-mount-bare",
    upstream: "request",
    title: "bare /v1 path → 200",
    setup: () => ({ request: { mount: "" } }),
    expect: ok200cold,
  },
  {
    id: "request-query-string",
    upstream: "request",
    title: "query string ignored → 200",
    setup: (prng) => ({
      request: { path: `${ROUTE_PATH}?cache=${prng.hex(6)}&x=1` },
    }),
    expect: ok200cold,
  },
  {
    id: "request-trailing-slash",
    upstream: "request",
    title: "trailing slash → 404 (exact-route switch)",
    setup: () => ({ request: { path: `${ROUTE_PATH}/` } }),
    expect: {
      status: 404,
      supabase: { exact: 1 },
      rest: 0,
      rc: 0,
      authFailureCharged: false,
    },
  },
  {
    id: "request-post-method",
    upstream: "request",
    title: "POST on the read route → 404",
    setup: () => ({ request: { method: "POST" } }),
    expect: {
      status: 404,
      supabase: { exact: 1 },
      rest: 0,
      rc: 0,
      authFailureCharged: false,
    },
  },
  {
    id: "request-head-method",
    upstream: "request",
    title: "HEAD on the read route → 404",
    setup: () => ({ request: { method: "HEAD" } }),
    expect: {
      status: 404,
      supabase: { exact: 1 },
      rest: 0,
      rc: 0,
      authFailureCharged: false,
    },
  },
  {
    id: "request-path-case",
    upstream: "request",
    title: "case variant of the path → 404",
    setup: () => ({ request: { path: "/v1/Training-Plans/current" } }),
    expect: {
      status: 404,
      supabase: { exact: 1 },
      rest: 0,
      rc: 0,
      authFailureCharged: false,
    },
  },
  {
    id: "request-double-slash",
    upstream: "request",
    title: "double slash in the path → 404",
    setup: () => ({ request: { path: "/v1//training-plans/current" } }),
    expect: {
      status: 404,
      supabase: { exact: 1 },
      rest: 0,
      rc: 0,
      authFailureCharged: false,
    },
  },

  // ── Rate limits (shared counters pre-seeded in the fake Upstash) ─────────
  {
    id: "ratelimit-user-budget-exhausted",
    upstream: "ratelimit",
    title:
      "per-user budget spent → 429 + Retry-After ≤ 60 + RateLimit headers; not charged as auth failure",
    setup: () => ({
      redisPreset: (
        { userId },
      ) => [[`rl:user:${bucket(60)}:${userId}`, String(USER_LIMIT)]],
    }),
    expect: {
      status: 429,
      supabase: { exact: 1 },
      rest: 0,
      rc: 0,
      headers: {
        "ratelimit-limit": String(USER_LIMIT),
        "ratelimit-remaining": "0",
      },
      authFailureCharged: false,
    },
    recover: ok200warm,
  },
  {
    id: "ratelimit-user-budget-last-slot",
    upstream: "ratelimit",
    title: "one request left in the per-user budget → 200",
    setup: () => ({
      redisPreset: (
        { userId },
      ) => [[`rl:user:${bucket(60)}:${userId}`, String(USER_LIMIT - 1)]],
    }),
    expect: ok200cold,
  },
  {
    id: "ratelimit-ip-budget-exhausted",
    upstream: "ratelimit",
    title: "per-IP budget spent → 429 before any Supabase round trip",
    setup: () => ({
      redisPreset: (
        { ip },
      ) => [[`rl:ip:${bucket(60)}:${ip}`, String(IP_LIMIT)]],
    }),
    expect: {
      status: 429,
      supabase: { exact: 0 },
      rest: 0,
      rc: 0,
      headers: {
        "ratelimit-limit": String(IP_LIMIT),
        "ratelimit-remaining": "0",
      },
      authFailureCharged: false,
    },
    recover: ok200cold,
  },
  {
    id: "ratelimit-authfail-budget-tripped",
    upstream: "ratelimit",
    title:
      "IP burned its auth-failure budget → 429 pre-auth even with a valid bearer",
    setup: () => ({
      redisPreset: (
        { ip },
      ) => [[`rl:authfail:${bucket(300)}:${ip}`, String(AUTH_FAILURE_LIMIT)]],
    }),
    expect: {
      status: 429,
      supabase: { exact: 0 },
      rest: 0,
      rc: 0,
      headers: {
        "ratelimit-limit": String(AUTH_FAILURE_LIMIT),
        "ratelimit-remaining": "0",
      },
      authFailureCharged: false,
    },
    recover: ok200cold,
  },
];

function bucket(windowSeconds: number): number {
  return Math.floor(Date.now() / (windowSeconds * 1000));
}

/** Rate-limit buckets roll on wall-clock boundaries; never straddle one
 * between pre-seeding a counter and sending the request. */
async function awayFromBucketEdge(): Promise<void> {
  const msIntoMinute = Date.now() % 60_000;
  if (msIntoMinute > 59_500) {
    await new Promise((r) => setTimeout(r, 60_000 - msIntoMinute + 20));
  }
}

/** Fill the isolate's L1 with L1_MAX_ENTRIES never-seen sessions. cache.ts
 * drops the oldest third whenever the map is full, so every row inserted
 * before this call is gone afterwards while its L2 copy is untouched. */
async function evictL1(h: StressHarness, prng: PrngType): Promise<void> {
  const savedFaults = h.faults;
  const savedStateless = h.statelessAuth;
  h.faults = {};
  h.statelessAuth = true;
  for (let done = 0; done < L1_MAX_ENTRIES; done += 50) {
    const batch = Math.min(50, L1_MAX_ENTRIES - done);
    const results = await Promise.all(
      Array.from(
        { length: batch },
        () =>
          h.run(
            h.request({
              token: h.forgedToken(prng.uuid(), 3600),
              ip: prng.ip(),
            }),
          ),
      ),
    );
    for (const r of results) {
      if (r.status !== 200) {
        throw new Error(`evictL1 filler answered ${r.status}: ${r.text}`);
      }
    }
  }
  h.statelessAuth = savedStateless;
  h.faults = savedFaults;
}

// ── Evaluation ───────────────────────────────────────────────────────────────

/** Sum of the per-IP auth-failure counters currently in the fake Upstash. */
function authFailureCount(h: StressHarness, ip: string): number {
  let total = 0;
  for (const [key, entry] of h.redis) {
    if (key.startsWith("rl:authfail:") && key.endsWith(`:${ip}`)) {
      total += Number(entry.value) || 0;
    }
  }
  return total;
}

function evaluate(
  label: string,
  expect: Expect,
  result: RunResult,
  authFailuresBefore: number,
  h: StressHarness,
  ip: string,
): string[] {
  const v: string[] = [];
  const statuses = Array.isArray(expect.status)
    ? expect.status
    : [expect.status];
  if (!statuses.includes(result.status)) {
    v.push(`${label}: status ${result.status} ∉ ${statuses.join("|")}`);
  }
  if (
    expect.planNull && result.status === 200 &&
    JSON.stringify(result.body) !== '{"plan":null}'
  ) {
    v.push(`${label}: 200 body ${result.text} ≠ {"plan":null}`);
  }
  const message = typeof result.body === "object" && result.body !== null &&
      "error" in result.body
    ? String(
      (result.body as { error: { message?: unknown } }).error?.message ?? "",
    )
    : "";
  if (
    expect.errorIncludes && result.status !== 200 &&
    !message.includes(expect.errorIncludes)
  ) {
    v.push(
      `${label}: error message "${message}" lacks "${expect.errorIncludes}"`,
    );
  }
  if (result.status >= 500) {
    // Generic body: operator detail must not leak.
    for (
      const leak of [
        "HTTP 5",
        "supabase",
        "Auth answered",
        "stress:",
        "TypeError",
      ]
    ) {
      if (result.text.includes(leak)) {
        v.push(`${label}: 5xx body leaks "${leak}"`);
      }
    }
  }
  if (expect.retryAfter !== undefined) {
    const header = result.headers["retry-after"];
    if (expect.retryAfter === "absent") {
      if (header !== undefined) {
        v.push(`${label}: unexpected Retry-After ${header}`);
      }
    } else if (header !== String(expect.retryAfter)) {
      v.push(
        `${label}: Retry-After ${header ?? "(none)"} ≠ ${expect.retryAfter}`,
      );
    }
  }
  if (result.status === 429) {
    const ra = Number(result.headers["retry-after"]);
    if (!Number.isInteger(ra) || ra < 1 || ra > 300) {
      v.push(
        `${label}: 429 Retry-After ${
          result.headers["retry-after"]
        } not in 1..300`,
      );
    }
  }
  if (expect.headers) {
    for (const [name, value] of Object.entries(expect.headers)) {
      if (result.headers[name] !== value) {
        v.push(
          `${label}: header ${name}=${
            result.headers[name] ?? "(none)"
          } ≠ ${value}`,
        );
      }
    }
  }
  if (expect.supabase) {
    const { exact, min, max } = expect.supabase;
    const n = result.calls.supabase;
    if (exact !== undefined && n !== exact) {
      v.push(`${label}: supabase round trips ${n} ≠ ${exact}`);
    }
    if (min !== undefined && n < min) {
      v.push(`${label}: supabase round trips ${n} < ${min}`);
    }
    if (max !== undefined && n > max) {
      v.push(`${label}: supabase round trips ${n} > ${max}`);
    }
  }
  // The >3 budget is for the served path; a dead socket legitimately costs
  // bounded connect retries inside one deadline before the 503.
  if (result.status === 200 && result.calls.supabase > 3) {
    v.push(
      `${label}: hot path made ${result.calls.supabase} Supabase round trips (>3)`,
    );
  }
  if (expect.rest !== undefined && result.calls.rest !== expect.rest) {
    v.push(`${label}: PostgREST calls ${result.calls.rest} ≠ ${expect.rest}`);
  }
  if (expect.rc !== undefined && result.calls.rc !== expect.rc) {
    v.push(`${label}: RevenueCat calls ${result.calls.rc} ≠ ${expect.rc}`);
  }
  if (expect.minMs !== undefined && result.durationMs < expect.minMs) {
    v.push(`${label}: took ${result.durationMs} ms < ${expect.minMs}`);
  }
  if (expect.maxMs !== undefined && result.durationMs > expect.maxMs) {
    v.push(`${label}: took ${result.durationMs} ms > ${expect.maxMs}`);
  }
  if (expect.operatorDetail && result.operatorLog.length === 0) {
    v.push(`${label}: 5xx without an operator log line`);
  }
  if (!result.requestId) v.push(`${label}: no x-request-id`);
  if (!result.accessLog) {
    v.push(`${label}: no access-log line for ${result.requestId}`);
  } else if (result.accessLog.status !== result.status) {
    v.push(
      `${label}: access log status ${result.accessLog.status} ≠ ${result.status}`,
    );
  }
  if (expect.authFailureCharged !== undefined) {
    const charged = authFailureCount(h, ip) > authFailuresBefore;
    if (charged !== expect.authFailureCharged) {
      v.push(
        `${label}: auth-failure budget ${
          charged ? "charged" : "not charged"
        }, expected ${expect.authFailureCharged ? "charged" : "not charged"}`,
      );
    }
  }
  return v;
}

function bearerFor(
  h: StressHarness,
  kind: Bearer,
  userId: string,
  prng: PrngType,
  ttl: number,
): string | null {
  switch (kind) {
    case "session":
      return h.mintSession(userId, ttl).accessToken;
    case "provider-google":
      return h.providerToken("google", userId, ttl);
    case "provider-apple":
      return h.providerToken("apple", userId, ttl);
    case "forged":
      return h.forgedToken(userId, ttl);
    case "none":
      return null;
    case "garbage":
      return `not-a-jwt-${prng.hex(12)}`;
    case "expired":
      return h.forgedToken(userId, -prng.int(1, 3600));
    case "wrong-issuer":
      return fakeJwt({
        iss: "https://evil.example/auth/v1",
        sub: userId,
        aud: "authenticated",
        exp: Math.floor(Date.now() / 1000) + ttl,
      });
  }
}

async function runCase(
  h: StressHarness,
  fc: FaultCase,
  iteration: number,
): Promise<Row> {
  const seed = seedFor(MASTER_SEED, fc.id, iteration);
  const prng = new Prng(seed);
  const setup = fc.setup(prng);
  h.reset();
  const userId = prng.uuid();
  const ip = prng.ip();
  const ttl = prng.int(120, 3600);
  h.registerUser({
    id: userId,
    email: `${userId.slice(0, 8)}@example.com`,
    provider: setup.user?.provider ?? "google",
    providers: setup.user?.providers,
  });
  const bearerKind = setup.bearer ?? "session";
  const token = bearerFor(h, bearerKind, userId, prng, ttl);
  const cache = setup.cache ?? "cold";
  const make = () =>
    h.request({
      token,
      ip,
      method: setup.request?.method,
      path: setup.request?.path,
      mount: setup.request?.mount,
      headers: setup.request?.headers,
    });

  if (cache !== "cold") {
    const prime = await h.run(h.request({ token, ip: prng.ip() }));
    if (prime.status !== 200) {
      throw new Error(
        `${fc.id}#${iteration}: priming request answered ${prime.status}: ${prime.text}`,
      );
    }
    if (cache === "l2-only") await evictL1(h, prng);
  }
  if (setup.authDeadlineMs === null) {
    Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
  } else {Deno.env.set(
      "AUTH_UPSTREAM_TIMEOUT_MS",
      String(setup.authDeadlineMs ?? FAST_AUTH_DEADLINE_MS),
    );}
  await awayFromBucketEdge();
  if (setup.redisPreset) {
    for (const [key, value] of setup.redisPreset({ ip, userId })) {
      h.redis.set(key, { value, expiresAtMs: Date.now() + 600_000 });
    }
  }
  h.faults = setup.faults ?? {};
  let before = authFailureCount(h, ip);
  const result = await h.run(make());
  const violations = evaluate("fault", fc.expect, result, before, h, ip);

  let recover: RunResult | null = null;
  if (fc.recover) {
    h.faults = {};
    if (setup.redisPreset) {
      for (const [key] of setup.redisPreset({ ip, userId })) {
        h.redis.delete(key);
      }
    }
    before = authFailureCount(h, ip);
    recover = await h.run(make());
    violations.push(...evaluate("recover", fc.recover, recover, before, h, ip));
  }
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(FAST_AUTH_DEADLINE_MS));

  return {
    seed,
    case: fc.id,
    upstream: fc.upstream,
    iteration,
    bearer: bearerKind,
    cache,
    status: result.status,
    retryAfter: result.headers["retry-after"] ?? null,
    durationMs: result.durationMs,
    calls: result.calls,
    recoverStatus: recover?.status ?? null,
    recoverCalls: recover?.calls ?? null,
    outcome: violations.length === 0 ? "HELD" : "BROKEN",
    violations,
    body: result.body,
    requestId: result.requestId,
  };
}

// ── Fault campaign ───────────────────────────────────────────────────────────

Deno.test("STRESS GET /v1/training-plans/current — failure injection (≥40 fault cases × STRESS_ITER)", async (t) => {
  const h = await loadStressHarness({ redis: true });
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(FAST_AUTH_DEADLINE_MS));
  const cases = ONLY_CASES.size > 0
    ? FAULT_CASES.filter((fc) => ONLY_CASES.has(fc.id))
    : FAULT_CASES.filter((fc) => FULL || !fc.slow);
  if (ONLY_CASES.size > 0) {
    assertEquals(cases.length, ONLY_CASES.size, "unknown STRESS_CASE id");
  } else {
    assert(cases.length >= 40, `only ${cases.length} fault cases`);
  }
  const ids = new Set(cases.map((fc) => fc.id));
  assertEquals(ids.size, cases.length, "duplicate case id");

  const rows: Row[] = [];
  for (const fc of cases) {
    await t.step(`${fc.id}: ${fc.title}`, async () => {
      const mine: Row[] = [];
      for (let iteration = 0; iteration < ITER; iteration += 1) {
        mine.push(await runCase(h, fc, iteration));
      }
      rows.push(...mine);
      const broken = mine.filter((row) => row.outcome === "BROKEN");
      if (broken.length > 0) {
        const detail =
          `${broken.length}/${mine.length} iterations BROKEN — seeds ${
            broken.map((r) => r.seed).join(",")
          }: ${broken[0].violations.join("; ")}`;
        if ((fc.severityIfBroken ?? "P2") === "P3") {
          console.log(
            `[stress] P3 (recorded, not failing the suite) ${fc.id}: ${detail}`,
          );
        } else {
          throw new Error(detail);
        }
      }
    });
  }

  const summary = {
    unit: "route-get-v1-training-plans-current",
    lens: "failure-load",
    masterSeed: MASTER_SEED,
    iterationsPerCase: ITER,
    cases: cases.length,
    iterations: rows.length,
    held: rows.filter((r) => r.outcome === "HELD").length,
    broken: rows.filter((r) => r.outcome === "BROKEN").length,
    byUpstream: histogram(rows.map((r) => r.upstream)),
    byStatus: histogram(rows.map((r) => r.status)),
    brokenSeeds: rows
      .filter((r) => r.outcome === "BROKEN")
      .map((r) => ({
        seed: r.seed,
        case: r.case,
        severity: cases.find((fc) => fc.id === r.case)?.severityIfBroken ??
          "P2",
        violations: r.violations,
      })),
    replay:
      "STRESS_SEED=<masterSeed> STRESS_ITER=<n> [STRESS_CASE=<id>[,<id>]] deno test -A --no-check --config deno.json stress_training_plans_current_failure_load.test.ts --filter 'failure injection'",
  };
  const path = await writeArtifact("fault_campaign.json", { summary, rows });
  console.log(
    `[stress] fault campaign: ${summary.held} HELD / ${summary.broken} BROKEN over ${rows.length} iterations → ${path}`,
  );
});

// ── Load campaign ────────────────────────────────────────────────────────────

interface LoadRow {
  seed: number;
  i: number;
  user: number;
  cold: boolean;
  status: number;
  ms: number;
  supabase: number;
  redis: number;
  rest: number;
  rc: number;
}

async function loadWave(
  h: StressHarness,
  label: string,
  n: number,
  seedLabel: string,
  faults: Faults,
  startIndex: number,
): Promise<
  {
    rows: LoadRow[];
    stats: ReturnType<typeof latencyStats>;
    supabasePerRequest: Record<string, number>;
    redisPerRequest: Record<string, number>;
  }
> {
  const master = new Prng(seedFor(MASTER_SEED, seedLabel, 0));
  const userCount = Math.min(400, Math.max(8, Math.floor(n / 10)));
  const users = Array.from({ length: userCount }, () => {
    const id = master.uuid();
    h.registerUser({
      id,
      email: `${id.slice(0, 8)}@example.com`,
      provider: "google",
    });
    return {
      id,
      token: h.mintSession(id, 3600).accessToken,
      ip: master.ip(),
      served: 0,
    };
  });
  // Every pooled bearer is verified once up front so the wave measures the
  // steady state: only the requests flagged `cold` bring a never-seen bearer.
  h.faults = {};
  for (const user of users) {
    const primed = await h.run(h.request({ token: user.token, ip: user.ip }));
    if (primed.status !== 200) {
      throw new Error(`priming ${label}: ${primed.status} ${primed.text}`);
    }
  }
  h.faults = faults;
  const rows: LoadRow[] = [];
  let index = startIndex;
  while (rows.length < n) {
    const batch = Math.min(LOAD_CONC, n - rows.length);
    const jobs: Array<Promise<LoadRow>> = [];
    for (let k = 0; k < batch; k += 1) {
      const i = index;
      index += 1;
      const seed = seedFor(MASTER_SEED, seedLabel, i);
      const prng = new Prng(seed);
      const userIndex = Math.floor(userCount * prng.next() ** 2);
      const user = users[userIndex];
      // 15% of requests arrive with a bearer this isolate has never seen.
      const cold = prng.chance(0.15);
      const token = cold
        ? h.mintSession(user.id, 3600).accessToken
        : user.token;
      // Keep every user under its 240/min budget by spreading over distinct users.
      user.served += 1;
      jobs.push(
        h.run(h.request({ token, ip: user.ip })).then((r) => ({
          seed,
          i,
          user: userIndex,
          cold,
          status: r.status,
          ms: r.durationMs,
          supabase: r.calls.supabase,
          redis: r.calls.redis,
          rest: r.calls.rest,
          rc: r.calls.rc,
        })),
      );
    }
    rows.push(...(await Promise.all(jobs)));
  }
  const stats = latencyStats(rows.map((r) => r.ms));
  const supabasePerRequest = histogram(rows.map((r) => r.supabase));
  const redisPerRequest = histogram(rows.map((r) => r.redis));
  console.log(
    `[stress] load ${label}: n=${rows.length} p50=${stats.p50}ms p95=${stats.p95}ms p99=${stats.p99}ms supabase/req=${
      JSON.stringify(supabasePerRequest)
    } redis/req=${JSON.stringify(redisPerRequest)}`,
  );
  return { rows, stats, supabasePerRequest, redisPerRequest };
}

Deno.test("STRESS GET /v1/training-plans/current — load: p50/p95 latency + Supabase round trips per request", async () => {
  const h = await loadStressHarness({ redis: true });
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(FAST_AUTH_DEADLINE_MS));
  h.reset();

  const healthy = await loadWave(h, "healthy", LOAD_N, "load-healthy", {}, 0);
  const redisDown = await loadWave(
    h,
    "upstash-500",
    Math.max(50, Math.floor(LOAD_N / 4)),
    "load-redis-500",
    {
      redis: { mode: "http", status: 500, body: "x" },
    },
    0,
  );
  const redisSlow = await loadWave(
    h,
    "upstash-slow-5ms",
    Math.max(50, Math.floor(LOAD_N / 4)),
    "load-redis-slow",
    {
      redis: { mode: "slow", delayMs: 5 },
    },
    0,
  );
  const authSlow = await loadWave(
    h,
    "auth-slow-20ms",
    Math.max(50, Math.floor(LOAD_N / 4)),
    "load-auth-slow",
    {
      auth: { mode: "slow", delayMs: 20 },
    },
    0,
  );

  // Cold stampede: the same never-seen bearer arrives LOAD_CONC times at once
  // while GoTrue takes 20 ms to answer, so every request is genuinely in
  // flight before the first verification lands (a zero-latency fake would let
  // the first request populate the cache before the second even asks).
  h.reset();
  h.faults = { auth: { mode: "slow", delayMs: 20 } };
  const stampedeUser = new Prng(seedFor(MASTER_SEED, "stampede", 0)).uuid();
  h.registerUser({
    id: stampedeUser,
    email: "stampede@example.com",
    provider: "google",
  });
  const stampedeToken = h.mintSession(stampedeUser, 3600).accessToken;
  const stampede = await Promise.all(
    Array.from(
      { length: Math.min(32, Math.max(8, LOAD_CONC)) },
      () => h.run(h.request({ token: stampedeToken, ip: "198.51.100.7" })),
    ),
  );
  const stampedeSupabase = stampede.reduce(
    (acc, r) => acc + r.calls.supabase,
    0,
  );

  const all = [
    ...healthy.rows,
    ...redisDown.rows,
    ...redisSlow.rows,
    ...authSlow.rows,
  ];
  const violations: string[] = [];
  for (const row of all) {
    if (row.status !== 200) {
      violations.push(`seed ${row.seed}: status ${row.status}`);
    }
    if (row.rest !== 0 || row.rc !== 0) {
      violations.push(
        `seed ${row.seed}: touched PostgREST/RC (${row.rest}/${row.rc})`,
      );
    }
    if (row.supabase > 3) {
      violations.push(
        `seed ${row.seed}: ${row.supabase} Supabase round trips (>3)`,
      );
    }
  }
  for (const row of healthy.rows) {
    if (row.cold && row.supabase !== 1) {
      violations.push(
        `seed ${row.seed}: cold request made ${row.supabase} Supabase round trips, expected 1`,
      );
    }
    if (!row.cold && row.supabase !== 0) {
      violations.push(
        `seed ${row.seed}: warm request made ${row.supabase} Supabase round trips, expected 0`,
      );
    }
  }
  for (const r of stampede) {
    if (r.status !== 200) violations.push(`stampede: status ${r.status}`);
  }

  const report = {
    masterSeed: MASTER_SEED,
    concurrency: LOAD_CONC,
    waves: {
      healthy: {
        n: healthy.rows.length,
        latencyMs: healthy.stats,
        supabasePerRequest: healthy.supabasePerRequest,
        upstashPipelinesPerRequest: healthy.redisPerRequest,
      },
      upstash500: {
        n: redisDown.rows.length,
        latencyMs: redisDown.stats,
        supabasePerRequest: redisDown.supabasePerRequest,
        upstashPipelinesPerRequest: redisDown.redisPerRequest,
      },
      upstashSlow5ms: {
        n: redisSlow.rows.length,
        latencyMs: redisSlow.stats,
        supabasePerRequest: redisSlow.supabasePerRequest,
        upstashPipelinesPerRequest: redisSlow.redisPerRequest,
      },
      authSlow20ms: {
        n: authSlow.rows.length,
        latencyMs: authSlow.stats,
        supabasePerRequest: authSlow.supabasePerRequest,
        upstashPipelinesPerRequest: authSlow.redisPerRequest,
      },
    },
    stampede: {
      concurrentRequestsSameFreshBearer: stampede.length,
      supabaseRoundTripsTotal: stampedeSupabase,
      statuses: histogram(stampede.map((r) => r.status)),
      gotrueDelayMs: 20,
      note: stampedeSupabase === 1
        ? "single-flight: one GoTrue verification served every concurrent first-sight request"
        : `no single-flight on a cold bearer: ${stampedeSupabase} GoTrue verifications for ${stampede.length} concurrent first-sight requests`,
    },
    totalRequests: all.length + stampede.length,
    maxSupabaseRoundTripsPerRequest: Math.max(
      ...all.map((r) => r.supabase),
      ...stampede.map((r) => r.calls.supabase),
    ),
    violations,
    replay:
      `STRESS_SEED=${MASTER_SEED} STRESS_LOAD=${LOAD_N} STRESS_CONC=${LOAD_CONC} deno test -A --no-check --config deno.json stress_training_plans_current_failure_load.test.ts --filter load`,
  };
  const path = await writeArtifact("load_campaign.json", { report, rows: all });
  console.log(`[stress] load campaign → ${path}`);
  assertEquals(violations, []);
  assert(all.length >= LOAD_N, "load campaign shorter than STRESS_LOAD");
});

// ── L1 memory under distinct users ───────────────────────────────────────────

Deno.test("STRESS GET /v1/training-plans/current — L1 caches under STRESS_USERS distinct users (Upstash configured)", async () => {
  const h = await loadStressHarness({ redis: true });
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(FAST_AUTH_DEADLINE_MS));
  h.reset();
  h.statelessAuth = true;
  const prng = new Prng(seedFor(MASTER_SEED, "memory-redis", 0));
  const samples: Array<
    { users: number; heapUsedMB: number; rssMB: number; fakeRedisKeys: number }
  > = [];
  const sample = (users: number) => {
    const m = Deno.memoryUsage();
    samples.push({
      users,
      heapUsedMB: Math.round((m.heapUsed / 1_048_576) * 100) / 100,
      rssMB: Math.round((m.rss / 1_048_576) * 100) / 100,
      fakeRedisKeys: h.redis.size,
    });
  };
  sample(0);
  const tokens: string[] = [];
  const statuses: Record<string, number> = {};
  const every = Math.max(1, Math.floor(MEMORY_USERS / 10));
  for (let start = 0; start < MEMORY_USERS; start += 64) {
    const batch = Math.min(64, MEMORY_USERS - start);
    const results = await Promise.all(
      Array.from({ length: batch }, (_, k) => {
        const token = h.forgedToken(prng.uuid(), 3600);
        if ((start + k) % 1000 === 0 || start + k === MEMORY_USERS - 1) {
          tokens.push(token);
        }
        return h.run(h.request({ token, ip: prng.ip() }));
      }),
    );
    for (const r of results) {
      statuses[String(r.status)] = (statuses[String(r.status)] ?? 0) + 1;
    }
    if ((start + batch) % every === 0 || start + batch === MEMORY_USERS) {
      sample(start + batch);
    }
  }
  // Eviction semantics: L1 keeps ≤ 5000 entries; L2 (fake Upstash) still holds
  // everything, so an evicted user costs one Upstash read and zero GoTrue calls.
  h.calls = [];
  const oldest = await h.run(h.request({ token: tokens[0], ip: prng.ip() }));
  const newest = await h.run(
    h.request({ token: tokens[tokens.length - 1], ip: prng.ip() }),
  );
  const report = {
    masterSeed: MASTER_SEED,
    distinctUsers: MEMORY_USERS,
    statuses,
    heapSamples: samples,
    heapGrowthMB: Math.round(
      (samples[samples.length - 1].heapUsedMB - samples[0].heapUsedMB) * 100,
    ) / 100,
    l1MaxEntries: L1_MAX_ENTRIES,
    revisit: {
      oldestUser: {
        status: oldest.status,
        supabase: oldest.calls.supabase,
        redis: oldest.calls.redis,
      },
      newestUser: {
        status: newest.status,
        supabase: newest.calls.supabase,
        redis: newest.calls.redis,
      },
    },
    note:
      "heap includes the fake Upstash store (one key per user); the memory-only probe isolates the function's own L1",
  };
  const path = await writeArtifact("memory_campaign_redis.json", report);
  console.log(`[stress] memory (Upstash configured) → ${path}`);
  assertEquals(statuses, { "200": MEMORY_USERS });
  assertEquals(oldest.status, 200);
  assertEquals(newest.status, 200);
  assertEquals(
    oldest.calls.supabase,
    0,
    "an evicted L1 entry is served by L2, not GoTrue",
  );
  assertEquals(newest.calls.supabase, 0);
});

Deno.test("STRESS GET /v1/training-plans/current — memory-only isolate probe (no Upstash, --expose-gc)", async () => {
  const script =
    new URL("./stress_training_plans_current_memory_probe.ts", import.meta.url)
      .pathname;
  const config = new URL("./deno.json", import.meta.url).pathname;
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--no-check",
      "--v8-flags=--expose-gc",
      "--config",
      config,
      script,
      "--users",
      String(MEMORY_USERS),
      "--seed",
      String(seedFor(MASTER_SEED, "memory-probe", 0)),
    ],
    stdout: "piped",
    stderr: "piped",
    env: { STRESS_OUT_DIR: Deno.env.get("STRESS_OUT_DIR") ?? "" },
  });
  const { code, stdout, stderr } = await command.output();
  const out = new TextDecoder().decode(stdout);
  const err = new TextDecoder().decode(stderr);
  if (code !== 0) {
    throw new Error(`memory probe exited ${code}\n${out}\n${err}`);
  }
  const lastLine = out.trim().split("\n").pop() ?? "{}";
  const report = JSON.parse(lastLine) as {
    distinctUsers: number;
    statuses: Record<string, number>;
    heapGrowthMBAfterGc: number;
    revisit: {
      oldestUser: { supabase: number };
      newestUser: { supabase: number };
    };
    l1EvictionObserved: boolean;
  };
  console.log(
    `[stress] memory probe: users=${report.distinctUsers} heapΔ(after gc)=${report.heapGrowthMBAfterGc} MB eviction=${report.l1EvictionObserved}`,
  );
  assertEquals(report.statuses, { "200": MEMORY_USERS });
  assert(
    report.heapGrowthMBAfterGc < 64,
    `L1 caches grew ${report.heapGrowthMBAfterGc} MB for ${MEMORY_USERS} users`,
  );
  assertEquals(
    report.revisit.newestUser.supabase,
    0,
    "the newest user must still be cached",
  );
  if (MEMORY_USERS > L1_MAX_ENTRIES) {
    assertEquals(
      report.l1EvictionObserved,
      true,
      "oldest user must have been evicted from the bounded L1",
    );
  }
});
