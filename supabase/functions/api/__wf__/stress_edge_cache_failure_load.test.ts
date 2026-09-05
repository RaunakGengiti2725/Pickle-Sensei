// STRESS — edge-cache × failure-load. Runs the REAL edge handler (index.ts)
// in-process through sessionHarness (fake GoTrue / PostgREST / Upstash) with
// a fault layer that fails, hangs or malforms ONE upstream at a time, then
// measures a seeded load campaign and a distinct-user L1 flood.
//
//   deno test -A --no-check --config deno.json stress_edge_cache_failure_load.test.ts
//
// Knobs (all optional; defaults keep the file suite-friendly):
//   STRESS_SEED=<n>      seed for every randomized choice (default 20260905)
//   STRESS_ITER=<n>      random fault-fuzz iterations (default 40)
//   STRESS_LOAD=<n>      sequential load requests (default 1000)
//   STRESS_USERS=<n>     distinct users for the L1 flood (default 2000; 20000 for the report)
//   STRESS_SLOW=1        include the slow cases (RevenueCat 10s hang, PostgREST retry ladders)
//   STRESS_ONLY=R17,D06  run only these matrix case ids (minimisation / 10× flake re-runs)
//   STRESS_OUT_DIR=<dir> where the JSON tables land
//                        (default artifacts/stress-edge-cache/latest/)
//
// Every fault case has a fixed id (R.., A.., T.., L.., D.., C.., E.., K..) and
// derives its user/session from STRESS_SEED, so `--filter` + the same seed
// replays it. Every fuzz iteration records `replay` with its exact command.
//
// Nothing here opens a socket: the harness fake fetch is the only network.

import {
  apiRequest,
  freshIp,
  loadSessionHarness,
  REDIS_URL,
  type SessionHarness,
  SUPABASE_URL,
  withClockOffset,
} from "./sessionHarness.ts";
import { captureAccessLog } from "../http.ts";
import {
  captureConsole,
  envInt,
  FAULT_MODES,
  type FaultLayer,
  installFaultLayer,
  latencySummary,
  leaks,
  Prng,
  readError,
  STRESS_SEED,
  type Upstream,
  writeArtifact,
} from "./stress_support.ts";

const STRESS_ITER = envInt("STRESS_ITER", 40);
const STRESS_LOAD = envInt("STRESS_LOAD", 1000);
const STRESS_USERS = envInt("STRESS_USERS", 2000);
const STRESS_SLOW = Deno.env.get("STRESS_SLOW") === "1";
const STRESS_ONLY = new Set((Deno.env.get("STRESS_ONLY") ?? "").split(",").map((id) => id.trim()).filter(Boolean));
const AUTH_TIMEOUT_MS = 400;
/** A request that has not answered by this point while an upstream without
 * an AbortSignal is hanging has no deadline of its own. */
const UNBOUNDED_PROBE_MS = 2_500;
/** The precedent set by authRequest's default deadline (6s). */
const BOUNDED_MS = 7_000;

type RouteName = "access" | "me" | "progress" | "rank" | "refresh" | "logout" | "billing";
type Recover =
  | "same_token_200"
  | "same_token_401"
  | "refresh_200"
  | "billing_200"
  | "progress_200"
  | "none";

interface Expect {
  status: number[];
  code?: string | null;
  retryAfter?: boolean;
  authCalls?: number;
  restCalls?: number;
  /** Desired: the request answers within BOUNDED_MS even if the upstream hangs. */
  bounded?: boolean;
  /** Override of BOUNDED_MS where the handler documents its own deadline. */
  maxMs?: number;
}

interface CaseSpec {
  id: string;
  upstream: Upstream;
  mode: string;
  route: RouteName;
  warm: boolean;
  /** Pre-warm the progress cache too (a prior GET /v1/progress). */
  warmProgress?: boolean;
  expect: Expect;
  recover: Recover;
  slow?: boolean;
  note?: string;
}

interface Observation {
  status: number;
  code: string | null;
  message: string | null;
  retryAfter: string | null;
  requestId: string | null;
  ms: number;
  authCalls: number;
  tokenCalls: number;
  logoutCalls: number;
  restCalls: number;
  redisCalls: number;
  rcCalls: number;
  unbounded: boolean;
  leaked: string[];
  console: string[];
  /** First 400 chars of the body (what the client actually received). */
  body: string;
}

interface CaseRow {
  id: string;
  seed: number;
  upstream: Upstream;
  mode: string;
  route: RouteName;
  warm: boolean;
  userId: string;
  observed: Observation;
  recovery: { kind: Recover; status: number; code: string | null } | null;
  expected: Expect & { recover: Recover };
  violations: string[];
  verdict: "HELD" | "BROKEN";
  note?: string;
  replay: string;
}

const c = (
  id: string,
  upstream: Upstream,
  mode: string,
  route: RouteName,
  warm: boolean,
  expect: Expect,
  recover: Recover,
  extra: Partial<CaseSpec> = {},
): CaseSpec => ({ id, upstream, mode, route, warm, expect, recover, ...extra });

// Desired behaviour per the handler's own contract (index.ts comments):
//  • Upstash trouble degrades (L1 or re-verify) — never a 5xx, never a 401.
//  • Supabase Auth unavailable → 503 + Retry-After, NEVER 401 (an outage says
//    nothing about the credential); refusal (400/401/403) → 401.
//  • Sign-out Supabase Auth could not perform → 503 with nothing evicted.
//  • PostgREST trouble → generic 503; cached rank/progress keep serving.
//  • RevenueCat trouble → 502 billing_unavailable; unusable 2xx → premium:false.
//  • Every upstream wait is bounded (authRequest's 6s deadline is the precedent).
const CASES: CaseSpec[] = [
  // ── Upstash (L2) ─────────────────────────────────────────────────────────
  c("R01", "redis", "http_500", "access", true, { status: [200], authCalls: 0 }, "same_token_200"),
  c("R02", "redis", "http_500", "access", false, { status: [200], authCalls: 1 }, "same_token_200"),
  c("R03", "redis", "hang", "access", true, { status: [200], authCalls: 0 }, "same_token_200", {
    note: "each pipeline waits the 1.2s REDIS_TIMEOUT_MS; no circuit breaker (known)",
  }),
  c("R04", "redis", "throw", "access", true, { status: [200], authCalls: 0 }, "same_token_200"),
  c("R05", "redis", "body_text", "access", true, { status: [200], authCalls: 0 }, "same_token_200"),
  c("R06", "redis", "body_empty_object", "access", true, { status: [200], authCalls: 0 }, "same_token_200"),
  c("R07", "redis", "body_null", "access", true, { status: [200], authCalls: 0 }, "same_token_200"),
  c("R08", "redis", "body_truncated_json", "access", true, { status: [200], authCalls: 0 }, "same_token_200"),
  c("R09", "redis", "redis_cmd_error", "access", true, { status: [200], authCalls: 1 }, "same_token_200", {
    note: "reachable-but-erroring Redis = unknown → L1 ignored, GoTrue re-verifies EVERY request",
  }),
  c("R10", "redis", "redis_short_reply", "access", true, { status: [200], authCalls: 1 }, "same_token_200"),
  c("R11", "redis", "redis_null_slots", "access", true, { status: [200], authCalls: 0 }, "same_token_200"),
  c("R12", "redis", "redis_number_slots", "access", true, { status: [429], code: "rate_limited", retryAfter: true }, "same_token_200", {
    note: "numeric garbage in every slot: the auth-failure window peek reads 42 ≥ 30 and fails CLOSED (429 + Retry-After); clears with the fault",
  }),
  c("R13", "redis", "redis_string_slots", "access", true, { status: [401], authCalls: 0 }, "same_token_401", {
    note: "a non-null string in the revocation slot is honoured as a marker AND cached in L1 for 60s",
  }),
  c("R14", "redis", "redis_http_401", "access", true, { status: [200], authCalls: 0 }, "same_token_200"),
  c("R15", "redis", "http_429", "access", true, { status: [200], authCalls: 0 }, "same_token_200"),
  c("R16", "redis", "http_500", "logout", true, { status: [204] }, "same_token_401", {
    note: "fence lands in L1 only; console.warn 'fence not shared' expected",
  }),
  c("R17", "redis", "hang", "logout", true, { status: [204] }, "same_token_401"),
  c("R18", "redis", "redis_cmd_error", "logout", true, { status: [204] }, "same_token_401"),
  c("R19", "redis", "http_500", "progress", true, { status: [200], authCalls: 0, restCalls: 2 }, "same_token_200"),
  c("R20", "redis", "http_500", "refresh", false, { status: [200] }, "none", {
    note: "per-IP refresh budget falls back to isolate memory; the rotation itself is unaffected",
  }),
  c("R21", "redis", "body_empty_array", "access", false, { status: [200], authCalls: 1 }, "same_token_200"),
  c("R22", "redis", "http_503_retry_after", "rank", true, { status: [200], authCalls: 0 }, "same_token_200"),
  // ── Supabase Auth: GET /auth/v1/user ─────────────────────────────────────
  c("A01", "auth_user", "http_500", "access", false, { status: [503], code: null, retryAfter: true, authCalls: 1 }, "same_token_200"),
  c("A02", "auth_user", "http_502", "access", false, { status: [503], retryAfter: true }, "same_token_200"),
  c("A03", "auth_user", "http_503_retry_after", "access", false, { status: [503], retryAfter: true }, "same_token_200"),
  c("A04", "auth_user", "http_429", "access", false, { status: [503], retryAfter: true }, "same_token_200"),
  c("A05", "auth_user", "http_404", "access", false, { status: [503], retryAfter: true }, "same_token_200"),
  c("A06", "auth_user", "hang", "access", false, { status: [503], retryAfter: true }, "same_token_200"),
  c("A07", "auth_user", "throw", "access", false, { status: [503], retryAfter: true }, "same_token_200"),
  c("A08", "auth_user", "body_text", "access", false, { status: [503], retryAfter: true }, "same_token_200"),
  c("A09", "auth_user", "body_empty_object", "access", false, { status: [503], retryAfter: true }, "same_token_200"),
  c("A10", "auth_user", "body_null", "access", false, { status: [503], retryAfter: true }, "same_token_200"),
  c("A11", "auth_user", "body_truncated_json", "access", false, { status: [503], retryAfter: true }, "same_token_200"),
  c("A12", "auth_user", "auth_user_no_id", "access", false, { status: [503], retryAfter: true }, "same_token_200"),
  c("A13", "auth_user", "auth_user_no_provider", "access", false, { status: [401] }, "same_token_200", {
    note: "GoTrue answered with an account outside Apple/Google — a refusal, not an outage",
  }),
  c("A14", "auth_user", "http_401", "access", false, { status: [401] }, "same_token_200"),
  c("A15", "auth_user", "http_403", "access", false, { status: [401] }, "same_token_200"),
  c("A16", "auth_user", "http_500", "access", true, { status: [200], authCalls: 0 }, "same_token_200"),
  c("A17", "auth_user", "hang", "access", true, { status: [200], authCalls: 0 }, "same_token_200"),
  c("A18", "auth_user", "http_401", "access", true, { status: [200], authCalls: 0 }, "same_token_200", {
    note: "a cached session is trusted for its window; refusal only bites on the next verification",
  }),
  c("A19", "auth_user", "http_500", "me", false, { status: [503], retryAfter: true }, "same_token_200"),
  c("A20", "auth_user", "body_empty_array", "access", false, { status: [503], retryAfter: true }, "same_token_200"),
  c("A21", "auth_user", "http_400", "access", false, { status: [401] }, "same_token_200"),
  // ── Supabase Auth: POST /auth/v1/token?grant_type=refresh_token ──────────
  c("T01", "auth_token", "http_500", "refresh", false, { status: [503], retryAfter: true }, "refresh_200"),
  c("T02", "auth_token", "http_503_retry_after", "refresh", false, { status: [503], retryAfter: true }, "refresh_200"),
  c("T03", "auth_token", "http_429", "refresh", false, { status: [503], retryAfter: true }, "refresh_200"),
  c("T04", "auth_token", "hang", "refresh", false, { status: [503], retryAfter: true }, "refresh_200"),
  c("T05", "auth_token", "throw", "refresh", false, { status: [503], retryAfter: true }, "refresh_200"),
  c("T06", "auth_token", "body_text", "refresh", false, { status: [503], retryAfter: true }, "refresh_200"),
  c("T07", "auth_token", "body_empty_object", "refresh", false, { status: [503], retryAfter: true }, "refresh_200"),
  c("T08", "auth_token", "auth_token_expires_in_zero", "refresh", false, { status: [503], retryAfter: true }, "refresh_200"),
  c("T09", "auth_token", "auth_token_expired_at", "refresh", false, { status: [503], retryAfter: true }, "refresh_200"),
  c("T10", "auth_token", "auth_token_no_refresh", "refresh", false, { status: [503], retryAfter: true }, "refresh_200"),
  c("T11", "auth_token", "http_400", "refresh", false, { status: [401] }, "refresh_200", {
    note: "GoTrue refused; the fake token was never spent so a real retry still rotates",
  }),
  c("T12", "auth_token", "http_401", "refresh", false, { status: [401] }, "refresh_200"),
  c("T13", "auth_token", "body_null", "refresh", false, { status: [503], retryAfter: true }, "refresh_200"),
  c("T14", "auth_token", "http_502", "refresh", false, { status: [503], retryAfter: true }, "refresh_200"),
  // ── Supabase Auth: POST /auth/v1/logout ──────────────────────────────────
  c("L01", "auth_logout", "http_500", "logout", true, { status: [503] }, "same_token_200"),
  c("L02", "auth_logout", "http_502", "logout", true, { status: [503] }, "same_token_200"),
  c("L03", "auth_logout", "throw", "logout", true, { status: [503] }, "same_token_200"),
  c("L04", "auth_logout", "hang", "logout", true, { status: [503], bounded: true }, "same_token_200", {
    note: "logoutRoute fetch carries no AbortSignal/deadline",
  }),
  c("L05", "auth_logout", "http_401", "logout", true, { status: [204] }, "same_token_401"),
  c("L06", "auth_logout", "http_404", "logout", true, { status: [204] }, "same_token_401"),
  c("L07", "auth_logout", "http_403", "logout", true, { status: [204] }, "same_token_401"),
  c("L08", "auth_logout", "body_text", "logout", true, { status: [204] }, "same_token_401"),
  c("L09", "auth_logout", "http_429", "logout", true, { status: [503] }, "same_token_200", {
    note: "GoTrue rate-limited the sign-out: it did NOT happen upstream",
  }),
  c("L10", "auth_logout", "http_503_retry_after", "logout", true, { status: [503] }, "same_token_200"),
  // ── PostgREST ────────────────────────────────────────────────────────────
  c("D01", "rest", "http_500", "access", true, { status: [503], authCalls: 0 }, "same_token_200"),
  c("D02", "rest", "http_503_retry_after", "access", true, { status: [503] }, "same_token_200"),
  c("D03", "rest", "http_429", "access", true, { status: [503] }, "same_token_200"),
  c("D04", "rest", "http_401", "access", true, { status: [503] }, "same_token_200", {
    note: "PostgREST rejected the JWT the cache still trusts → generic 503 (retry), not a sign-out",
  }),
  c("D05", "rest", "http_404", "access", true, { status: [503] }, "same_token_200"),
  c("D06", "rest", "hang", "access", true, { status: [503], bounded: true }, "same_token_200", {
    note: "supabase-js PostgREST calls carry no AbortSignal/deadline",
  }),
  c("D07", "rest", "throw", "access", true, { status: [503] }, "same_token_200"),
  c("D08", "rest", "body_text", "access", true, { status: [503] }, "same_token_200"),
  c("D09", "rest", "body_empty_object", "access", true, { status: [503] }, "same_token_200"),
  c("D10", "rest", "body_empty_array", "access", true, { status: [503] }, "same_token_200"),
  c("D11", "rest", "body_null", "access", true, { status: [503] }, "same_token_200"),
  c("D12", "rest", "body_truncated_json", "access", true, { status: [503] }, "same_token_200"),
  c("D13", "rest", "http_500", "progress", true, { status: [503] }, "progress_200"),
  c("D14", "rest", "http_500", "rank", true, { status: [503] }, "same_token_200"),
  c("D15", "rest", "http_500", "progress", true, { status: [200], restCalls: 0 }, "same_token_200", {
    warmProgress: true,
    note: "60s progress cache hides the PostgREST outage",
  }),
  c("D16", "rest", "http_500", "me", true, { status: [503] }, "same_token_200"),
  c("D17", "rest", "body_empty_array", "me", true, { status: [503] }, "same_token_200", {
    note: "profile read sees no row → one retry after the 400ms trigger grace, then 503",
  }),
  c("D18", "rest", "throw", "rank", true, { status: [503], bounded: true }, "same_token_200", {
    note: "postgrest-js 2.112.4 retries GET network errors 3× (1s/2s/4s) per read with no signal → ~7s stall",
  }),
  c("D19", "rest", "http_503_retry_after", "rank", true, { status: [503], bounded: true }, "same_token_200", {
    slow: true,
    note: "postgrest-js honours PostgREST's Retry-After (7s) ×3 retries per GET read → ~21s stall; STRESS_SLOW=1 only",
  }),
  c("D20", "rest", "throw", "me", true, { status: [503], bounded: true }, "same_token_200", {
    slow: true,
    note: "profile read is a GET → same 3× retry ladder (~7s); STRESS_SLOW=1 only, D18 is the fast representative",
  }),
  c("D21", "rest", "throw", "progress", true, { status: [503], bounded: true }, "progress_200", {
    slow: true,
    note: "~7s retry ladder; STRESS_SLOW=1 only",
  }),
  c("D22", "rest", "http_503_retry_after", "access", true, { status: [503] }, "same_token_200", {
    note: "access_state is an RPC (POST) → not retried by postgrest-js, answers at once",
  }),
  c("D23", "rest", "body_empty_object", "rank", true, { status: [503] }, "same_token_200", {
    note: "PostgREST 200 with a non-array body on a list read",
  }),
  c("D24", "rest", "body_empty_object", "progress", true, { status: [503] }, "progress_200"),
  c("D25", "rest", "body_empty_object", "me", true, { status: [503] }, "same_token_200", {
    note: "a profile row without id/onboarding_state/provider must not be served as the account",
  }),
  c("D26", "rest", "body_null", "rank", true, { status: [200, 503] }, "same_token_200", {
    note: "null list body is read as 'no rows' (`?? []`) — an empty rank, not a crash",
  }),
  c("D27", "rest", "body_text", "progress", true, { status: [503] }, "progress_200"),
  c("D28", "rest", "body_empty_object", "billing", true, { status: [503, 200] }, "billing_200", {
    note: "billing persistence reads/writes: any non-array shape must stay a generic 503 or an honest 200",
  }),
  // ── RevenueCat (POST /v1/billing/sync) ───────────────────────────────────
  c("C01", "rc", "http_500", "billing", true, { status: [502], code: "billing_unavailable" }, "billing_200"),
  c("C02", "rc", "http_429", "billing", true, { status: [502], code: "billing_unavailable" }, "billing_200"),
  c("C03", "rc", "throw", "billing", true, { status: [502], code: "billing_unavailable" }, "billing_200"),
  c("C04", "rc", "body_text", "billing", true, { status: [502], code: "billing_unavailable" }, "billing_200"),
  c("C05", "rc", "body_empty_object", "billing", true, { status: [502], code: "billing_unavailable" }, "billing_200"),
  c("C06", "rc", "body_null", "billing", true, { status: [502], code: "billing_unavailable" }, "billing_200"),
  c("C07", "rc", "rc_subscriber_null", "billing", true, { status: [502], code: "billing_unavailable" }, "billing_200"),
  c("C08", "rc", "rc_entitlements_garbage", "billing", true, { status: [200] }, "billing_200", {
    note: "unusable entitlement map → honest premium:false, never a grant",
  }),
  c("C09", "rc", "rc_expires_garbage", "billing", true, { status: [200] }, "billing_200"),
  c("C10", "rc", "hang", "billing", true, { status: [502], code: "billing_unavailable", maxMs: 11_000 }, "billing_200", {
    slow: true,
    note: "AbortSignal.timeout(10_000) bounds the wait; slow, STRESS_SLOW=1 only",
  }),
  c("C11", "rc", "body_truncated_json", "billing", true, { status: [502], code: "billing_unavailable" }, "billing_200"),
  c("C12", "rc", "http_401", "billing", true, { status: [502], code: "billing_unavailable" }, "billing_200", {
    note: "a bad RevenueCat key is an operator fault; the user sees a retryable class",
  }),
];

// ─── Harness plumbing ────────────────────────────────────────────────────────

interface Stress {
  h: SessionHarness;
  faults: FaultLayer;
  accessLines: string[];
  restore(): void;
}

const RC_HEALTHY_SUBSCRIBER = () => ({
  request_date_ms: Date.now(),
  subscriber: {
    entitlements: {},
    subscriptions: {},
    non_subscriptions: {},
  },
});

async function boot(): Promise<Stress> {
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(AUTH_TIMEOUT_MS));
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_stress_test_key");
  const h = await loadSessionHarness({ redis: true });
  // RevenueCat is not part of sessionHarness: answer healthy unless faulted.
  const base = globalThis.fetch;
  const rcCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.revenuecat.com/")) {
      rcCalls.push(url);
      h.calls.push({ url, method: init?.method ?? "GET", headers: {}, body: null });
      return new Response(JSON.stringify(RC_HEALTHY_SUBSCRIBER()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return base(input, init);
  }) as typeof fetch;
  const faults = installFaultLayer({ redis: REDIS_URL, supabase: SUPABASE_URL });
  const accessLines: string[] = [];
  const restoreLog = captureAccessLog((line) => {
    accessLines.push(line);
  });
  return {
    h,
    faults,
    accessLines,
    restore() {
      faults.restore();
      globalThis.fetch = base;
      restoreLog();
      Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
      Deno.env.delete("REVENUECAT_SECRET_API_KEY");
    },
  };
}

function stubDb(h: SessionHarness): void {
  h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
  h.tables.progress_daily = [];
  h.tables.practice_days = [];
  h.tables.player_technique_rating = [];
  h.tables.player_rank_state = [];
}

function freshCase(h: SessionHarness, prng: Prng): { userId: string } {
  h.reset();
  stubDb(h);
  const userId = prng.uuid();
  h.registerUser({ id: userId, email: `${userId.slice(0, 8)}@stress.test`, provider: "google" });
  return { userId };
}

interface Session {
  accessToken: string;
  refreshToken: string;
}

function routeRequest(route: RouteName, session: Session): Request {
  switch (route) {
    case "access":
      return apiRequest("GET", "/v1/me/access", { token: session.accessToken });
    case "me":
      return apiRequest("GET", "/v1/me", { token: session.accessToken });
    case "progress":
      return apiRequest("GET", "/v1/progress", { token: session.accessToken });
    case "rank":
      return apiRequest("GET", "/v1/rank", { token: session.accessToken });
    case "refresh":
      return apiRequest("POST", "/v1/auth/refresh", {
        body: { refreshToken: session.refreshToken },
      });
    case "logout":
      return apiRequest("POST", "/v1/auth/logout", { token: session.accessToken });
    case "billing":
      return apiRequest("POST", "/v1/billing/sync", { token: session.accessToken, body: {} });
  }
}

interface Counters {
  authCalls: number;
  tokenCalls: number;
  logoutCalls: number;
  restCalls: number;
  redisCalls: number;
  rcCalls: number;
}

function countUpstream(s: Stress, callsMark: number, hitsMark: number): Counters {
  const counters: Counters = {
    authCalls: 0,
    tokenCalls: 0,
    logoutCalls: 0,
    restCalls: 0,
    redisCalls: 0,
    rcCalls: 0,
  };
  const bump = (upstream: Upstream | null) => {
    switch (upstream) {
      case "auth_user":
        counters.authCalls += 1;
        break;
      case "auth_token":
        counters.tokenCalls += 1;
        break;
      case "auth_logout":
        counters.logoutCalls += 1;
        break;
      case "rest":
        counters.restCalls += 1;
        break;
      case "redis":
        counters.redisCalls += 1;
        break;
      case "rc":
        counters.rcCalls += 1;
        break;
    }
  };
  for (const call of s.h.calls.slice(callsMark)) bump(s.faults.classify(call.url, call.method));
  for (const hit of s.faults.hits.slice(hitsMark)) bump(hit.upstream);
  return counters;
}

/** Send one request through the real handler with `fault` active, recording
 * everything the client and the operator would see. */
async function observe(
  s: Stress,
  request: Request,
  fault: { upstream: Upstream; mode: string } | null,
): Promise<Observation> {
  const callsMark = s.h.calls.length;
  const hitsMark = s.faults.hits.length;
  if (fault) s.faults.set(fault);
  const started = performance.now();
  let unbounded = false;
  const { value: response, lines } = await captureConsole(async () => {
    const pending = s.h.handler(request);
    if (fault?.mode === "hang") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const probe = new Promise<"unbounded">((resolve) => {
        timer = setTimeout(() => resolve("unbounded"), UNBOUNDED_PROBE_MS);
      });
      const first = await Promise.race([pending, probe]);
      clearTimeout(timer);
      if (first === "unbounded") {
        const hits = s.faults.hits.slice(hitsMark);
        unbounded = hits.some((hit) => hit.mode === "hang" && !hit.boundedBySignal);
        if (unbounded) {
          // Nothing will ever answer: let the request finish so it does not
          // leak into the next case, and record that it needed our help.
          s.faults.clear();
          s.faults.releaseHangs();
        }
      }
    }
    return await pending;
  });
  const ms = performance.now() - started;
  s.faults.clear();
  s.faults.releaseHangs();
  const error = await readError(response);
  return {
    status: response.status,
    code: error.code,
    message: error.message,
    retryAfter: response.headers.get("Retry-After"),
    requestId: response.headers.get("x-request-id"),
    ms: Math.round(ms * 100) / 100,
    ...countUpstream(s, callsMark, hitsMark),
    unbounded,
    leaked: response.status >= 400 ? leaks(error.raw) : [],
    console: lines,
    body: error.raw.slice(0, 400),
  };
}

async function recover(
  s: Stress,
  kind: Recover,
  session: Session,
): Promise<{ kind: Recover; status: number; code: string | null } | null> {
  if (kind === "none") return null;
  const request = (() => {
    switch (kind) {
      case "same_token_200":
      case "same_token_401":
        return routeRequest("access", session);
      case "refresh_200":
        return routeRequest("refresh", session);
      case "billing_200":
        return routeRequest("billing", session);
      case "progress_200":
        return routeRequest("progress", session);
    }
  })();
  const { value: response } = await captureConsole(() => s.h.handler(request));
  const error = await readError(response);
  return { kind, status: response.status, code: error.code };
}

const RECOVERY_STATUS: Record<Recover, number> = {
  same_token_200: 200,
  same_token_401: 401,
  refresh_200: 200,
  billing_200: 200,
  progress_200: 200,
  none: -1,
};

function evaluate(spec: CaseSpec, observed: Observation, recovery: CaseRow["recovery"]): string[] {
  const violations: string[] = [];
  const e = spec.expect;
  if (!e.status.includes(observed.status)) {
    violations.push(`status ${observed.status} ∉ {${e.status.join(",")}}`);
  }
  if (e.code !== undefined && observed.code !== e.code) {
    violations.push(`error.code ${observed.code} ≠ ${e.code}`);
  }
  if (e.retryAfter && !observed.retryAfter) violations.push("503 without Retry-After");
  if (e.authCalls !== undefined && observed.authCalls !== e.authCalls) {
    violations.push(`GoTrue /user calls ${observed.authCalls} ≠ ${e.authCalls}`);
  }
  if (e.restCalls !== undefined && observed.restCalls !== e.restCalls) {
    violations.push(`PostgREST calls ${observed.restCalls} ≠ ${e.restCalls}`);
  }
  if (observed.status === 500) violations.push("unhandled 500");
  if (observed.leaked.length > 0) violations.push(`upstream detail leaked: ${observed.leaked}`);
  if (!observed.requestId) violations.push("missing x-request-id");
  const maxMs = e.maxMs ?? BOUNDED_MS;
  if (observed.unbounded || observed.ms > maxMs) {
    violations.push(
      observed.unbounded
        ? `no deadline: still waiting after ${UNBOUNDED_PROBE_MS}ms on a hung upstream`
        : `answered after ${observed.ms}ms (> ${maxMs}ms)`,
    );
  }
  if (recovery && recovery.status !== RECOVERY_STATUS[recovery.kind]) {
    violations.push(
      `recovery ${recovery.kind}: status ${recovery.status} ≠ ${RECOVERY_STATUS[recovery.kind]}`,
    );
  }
  return violations;
}

const REPLAY_BASE = "deno test -A --no-check --config deno.json stress_edge_cache_failure_load.test.ts";

async function runCase(s: Stress, spec: CaseSpec, seed: number): Promise<CaseRow> {
  const prng = new Prng(seed);
  const { userId } = freshCase(s.h, prng);
  const minted = s.h.mintSession(userId);
  const session: Session = {
    accessToken: minted.accessToken,
    refreshToken: minted.refreshToken,
  };
  if (spec.warm) {
    const warm = await captureConsole(() => s.h.handler(routeRequest("access", session)));
    if (warm.value.status !== 200) {
      throw new Error(`${spec.id}: warm-up GET /v1/me/access → ${warm.value.status}`);
    }
  }
  if (spec.warmProgress) {
    const warm = await captureConsole(() => s.h.handler(routeRequest("progress", session)));
    if (warm.value.status !== 200) {
      throw new Error(`${spec.id}: warm-up GET /v1/progress → ${warm.value.status}`);
    }
  }
  const observed = await observe(s, routeRequest(spec.route, session), {
    upstream: spec.upstream,
    mode: spec.mode,
  });
  const recovery = await recover(s, spec.recover, session);
  const violations = evaluate(spec, observed, recovery);
  return {
    id: spec.id,
    seed,
    upstream: spec.upstream,
    mode: spec.mode,
    route: spec.route,
    warm: spec.warm,
    userId,
    observed,
    recovery,
    expected: { ...spec.expect, recover: spec.recover },
    violations,
    verdict: violations.length === 0 ? "HELD" : "BROKEN",
    note: spec.note,
    replay: `STRESS_SEED=${STRESS_SEED} ${spec.slow ? "STRESS_SLOW=1 " : ""}${REPLAY_BASE} --filter "${spec.id} "`,
  };
}

// ─── 1. Fault matrix ─────────────────────────────────────────────────────────

Deno.test("stress/fault-matrix: every upstream fails/hangs/malforms in turn (real handler)", async (t) => {
  const s = await boot();
  const rows: CaseRow[] = [];
  try {
    for (const [index, spec] of CASES.entries()) {
      if (STRESS_ONLY.size > 0 ? !STRESS_ONLY.has(spec.id) : spec.slow && !STRESS_SLOW) continue;
      await t.step(`${spec.id} ${spec.upstream} ${spec.mode} → ${spec.route}${spec.warm ? " (warm)" : ""}`, async () => {
        const row = await runCase(s, spec, STRESS_SEED + index);
        rows.push(row);
      });
    }
  } finally {
    s.restore();
  }
  const broken = rows.filter((row) => row.verdict === "BROKEN");
  const summary = {
    scenario: "fault-matrix",
    seed: STRESS_SEED,
    commit: Deno.env.get("STRESS_COMMIT") ?? null,
    executed: rows.length,
    held: rows.length - broken.length,
    broken: broken.map((row) => ({ id: row.id, violations: row.violations, replay: row.replay })),
    byUpstream: Object.fromEntries(
      (["redis", "auth_user", "auth_token", "auth_logout", "rest", "rc"] as Upstream[]).map((u) => [
        u,
        rows.filter((row) => row.upstream === u).length,
      ]),
    ),
    rows,
  };
  const path = await writeArtifact("fault_matrix.json", summary);
  console.log(`[stress] fault-matrix: ${summary.executed} cases, ${broken.length} BROKEN → ${path}`);
  // The matrix is a measurement: the BROKEN rows are the report. Only a
  // regression against the documented-and-held contract fails the suite.
  const expectedBroken = new Set(KNOWN_BROKEN);
  const unexpected = broken.filter((row) => !expectedBroken.has(row.id));
  const missing = [...expectedBroken].filter(
    (id) => rows.some((row) => row.id === id) && !broken.some((row) => row.id === id),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `unexpected BROKEN cases: ${unexpected.map((row) => `${row.id}: ${row.violations.join("; ")}`).join(" | ")}`,
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `cases listed in KNOWN_BROKEN now HOLD — update the list: ${missing.join(", ")}`,
    );
  }
});

/** Cases whose desired behaviour the handler at 1fb0efd7 does NOT meet.
 * Each is a finding in the stress report; listing them here keeps the suite
 * green while pinning the exact set (a fix flips the case to HELD and this
 * list must shrink; a new BROKEN case fails the suite). */
const KNOWN_BROKEN: string[] = [
  "R17",
  "L04",
  "L09",
  "D06",
  "D18",
  "D19",
  "D20",
  "D21",
  "D23",
  "D24",
  "D25",
];

// ─── 2. Logout eviction + TTL skew ───────────────────────────────────────────

interface ProbeRow {
  id: string;
  seed: number;
  description: string;
  steps: Array<Record<string, unknown>>;
  violations: string[];
  verdict: "HELD" | "BROKEN";
  replay: string;
}

Deno.test("stress/eviction-skew: logout eviction and clock skew against the session cache", async (t) => {
  const s = await boot();
  const rows: ProbeRow[] = [];
  const probe = async (
    id: string,
    description: string,
    body: (ctx: {
      steps: ProbeRow["steps"];
      expect: (cond: unknown, msg: string) => void;
      prng: Prng;
    }) => Promise<void>,
  ) => {
    const seed = STRESS_SEED + id.charCodeAt(0) * 100 + Number(id.slice(1));
    await t.step(`${id} ${description}`, async () => {
      const prng = new Prng(seed);
      const steps: ProbeRow["steps"] = [];
      const violations: string[] = [];
      await body({
        steps,
        prng,
        expect: (cond, msg) => {
          if (!cond) violations.push(msg);
        },
      });
      rows.push({
        id,
        seed,
        description,
        steps,
        violations,
        verdict: violations.length === 0 ? "HELD" : "BROKEN",
        replay: `STRESS_SEED=${STRESS_SEED} ${REPLAY_BASE} --filter "${id} "`,
      });
      if (violations.length > 0) throw new Error(`${id}: ${violations.join("; ")}`);
    });
  };

  const send = async (
    steps: ProbeRow["steps"],
    label: string,
    request: Request,
    fault: { upstream: Upstream; mode: string } | null = null,
  ) => {
    const observed = await observe(s, request, fault);
    steps.push({
      label,
      status: observed.status,
      code: observed.code,
      authCalls: observed.authCalls,
      restCalls: observed.restCalls,
      redisCalls: observed.redisCalls,
      ms: observed.ms,
      warn: observed.console.filter((line) => line.startsWith("warn:")),
    });
    return observed;
  };

  try {
    await probe("E01", "logout refuses the same bearer from the cache (no GoTrue round trip)", async ({ steps, expect, prng }) => {
      const { userId } = freshCase(s.h, prng);
      const session = s.h.mintSession(userId);
      const warm = await send(steps, "warm access", routeRequest("access", session));
      expect(warm.status === 200 && warm.authCalls === 1, "warm-up verified once");
      const out = await send(steps, "logout", routeRequest("logout", session));
      expect(out.status === 204, `logout → ${out.status}`);
      const after = await send(steps, "same bearer", routeRequest("access", session));
      expect(after.status === 401, `revoked bearer → ${after.status}`);
      expect(after.authCalls === 0, "revoked bearer answered from the fence, not GoTrue");
    });

    await probe("E02", "logout fences the SESSION: a sibling access token of the same session is refused", async ({ steps, expect, prng }) => {
      const { userId } = freshCase(s.h, prng);
      const first = s.h.mintSession(userId);
      const sibling = s.h.mintSession(userId, undefined, { sessionId: s.h.sessionIdOf(first.accessToken) });
      expect((await send(steps, "warm first", routeRequest("access", first))).status === 200, "first warm");
      expect((await send(steps, "warm sibling", routeRequest("access", sibling))).status === 200, "sibling warm");
      expect((await send(steps, "logout first", routeRequest("logout", first))).status === 204, "logout");
      const sib = await send(steps, "sibling bearer", routeRequest("access", sibling));
      expect(sib.status === 401, `sibling (cached, same session_id) → ${sib.status}`);
      expect(sib.authCalls === 0, "sibling refused from the revocation marker without GoTrue");
    });

    await probe("E03", "logout burns the session's refresh token", async ({ steps, expect, prng }) => {
      const { userId } = freshCase(s.h, prng);
      const session = s.h.mintSession(userId);
      expect((await send(steps, "warm", routeRequest("access", session))).status === 200, "warm");
      expect((await send(steps, "logout", routeRequest("logout", session))).status === 204, "logout");
      const refreshed = await send(steps, "refresh", routeRequest("refresh", session));
      expect(refreshed.status === 401, `refresh after logout → ${refreshed.status}`);
    });

    await probe("E04", "logout is scope=local: another cached session of the same user keeps working", async ({ steps, expect, prng }) => {
      const { userId } = freshCase(s.h, prng);
      const phone = s.h.mintSession(userId);
      const tablet = s.h.mintSession(userId);
      expect((await send(steps, "warm phone", routeRequest("access", phone))).status === 200, "phone warm");
      expect((await send(steps, "warm tablet", routeRequest("access", tablet))).status === 200, "tablet warm");
      expect((await send(steps, "logout phone", routeRequest("logout", phone))).status === 204, "logout phone");
      const other = await send(steps, "tablet bearer", routeRequest("access", tablet));
      expect(other.status === 200, `other session → ${other.status}`);
      expect(other.authCalls === 0, "other session still served from cache");
      const gone = await send(steps, "phone bearer", routeRequest("access", phone));
      expect(gone.status === 401, `logged-out session → ${gone.status}`);
    });

    await probe("E05", "logout while Upstash is down still evicts locally and says so", async ({ steps, expect, prng }) => {
      const { userId } = freshCase(s.h, prng);
      const session = s.h.mintSession(userId);
      expect((await send(steps, "warm", routeRequest("access", session))).status === 200, "warm");
      const out = await send(steps, "logout (redis 500)", routeRequest("logout", session), {
        upstream: "redis",
        mode: "http_500",
      });
      expect(out.status === 204, `logout → ${out.status}`);
      expect(
        out.console.some((line) => /fence/i.test(line) && /not shared|redis/i.test(line)),
        "operator warned that the fence did not reach Redis",
      );
      const after = await send(steps, "same bearer (redis back)", routeRequest("access", session));
      expect(after.status === 401, `revoked bearer on this isolate → ${after.status}`);
      expect(after.authCalls === 0, "refused from the local fence");
    });

    await probe("E06", "Upstash flushed after logout: the local marker holds its full 660s, then GoTrue is the truth", async ({ steps, expect, prng }) => {
      const { userId } = freshCase(s.h, prng);
      const session = s.h.mintSession(userId);
      expect((await send(steps, "warm", routeRequest("access", session))).status === 200, "warm");
      expect((await send(steps, "logout", routeRequest("logout", session))).status === 204, "logout");
      s.h.redis.clear();
      steps.push({ label: "redis flushed", keys: s.h.redis.size });
      const local = await send(steps, "same bearer (t+0)", routeRequest("access", session));
      expect(local.status === 401 && local.authCalls === 0, `L1 marker refuses without GoTrue → ${local.status}/${local.authCalls}`);
      const mid = await withClockOffset(10 * 60_000, () => send(steps, "same bearer (t+10m)", routeRequest("access", session)));
      expect(mid.status === 401 && mid.authCalls === 0, `writer isolate keeps the marker for 660s → ${mid.status}/${mid.authCalls}`);
      const later = await withClockOffset(11 * 60_000 + 1_000, () => send(steps, "same bearer (t+11m1s)", routeRequest("access", session)));
      expect(later.status === 401, `after every marker expired → ${later.status}`);
      expect(later.authCalls === 1, `GoTrue consulted once (${later.authCalls}) once both cache layers forgot`);
    });

    await probe("E07", "a fresh bearer minted for a logged-out session id is refused from the marker", async ({ steps, expect, prng }) => {
      const { userId } = freshCase(s.h, prng);
      const session = s.h.mintSession(userId);
      expect((await send(steps, "warm", routeRequest("access", session))).status === 200, "warm");
      expect((await send(steps, "logout", routeRequest("logout", session))).status === 204, "logout");
      // A token the edge has never seen but carrying the revoked session id
      // (e.g. minted by a stale refresh raced against the logout).
      const late = s.h.mintSession(userId, undefined, { sessionId: s.h.sessionIdOf(session.accessToken) });
      const seen = await send(steps, "late bearer", routeRequest("access", late));
      expect(seen.status === 401, `late-minted bearer for the revoked session → ${seen.status}`);
    });

    await probe("K01", "clock +9m: the cached row (600s cap) still serves without GoTrue", async ({ steps, expect, prng }) => {
      const { userId } = freshCase(s.h, prng);
      const session = s.h.mintSession(userId);
      expect((await send(steps, "warm", routeRequest("access", session))).status === 200, "warm");
      const later = await withClockOffset(9 * 60_000, () => send(steps, "t+9m", routeRequest("access", session)));
      expect(later.status === 200 && later.authCalls === 0, `t+9m → ${later.status}, GoTrue ${later.authCalls}`);
    });

    await probe("K02", "clock +10m1s: cached row expired → re-verified once, still signed in", async ({ steps, expect, prng }) => {
      const { userId } = freshCase(s.h, prng);
      const session = s.h.mintSession(userId);
      expect((await send(steps, "warm", routeRequest("access", session))).status === 200, "warm");
      const later = await withClockOffset(10 * 60_000 + 1_000, () => send(steps, "t+10m1s", routeRequest("access", session)));
      expect(later.status === 200, `t+10m1s → ${later.status}`);
      expect(later.authCalls === 1, `re-verified once (${later.authCalls})`);
      const again = await withClockOffset(10 * 60_000 + 2_000, () => send(steps, "t+10m2s", routeRequest("access", session)));
      expect(again.status === 200 && again.authCalls === 0, `re-cached after re-verification → ${again.status}/${again.authCalls}`);
    });

    await probe("K03", "clock -5m (edge behind): cached row and bearer still honoured", async ({ steps, expect, prng }) => {
      const { userId } = freshCase(s.h, prng);
      const session = s.h.mintSession(userId);
      expect((await send(steps, "warm", routeRequest("access", session))).status === 200, "warm");
      const behind = await withClockOffset(-5 * 60_000, () => send(steps, "t-5m", routeRequest("access", session)));
      expect(behind.status === 200 && behind.authCalls === 0, `t-5m → ${behind.status}/${behind.authCalls}`);
    });

    await probe("K04", "clock +61m: bearer exp passed → 401 with zero upstream calls, no cache trust", async ({ steps, expect, prng }) => {
      const { userId } = freshCase(s.h, prng);
      const session = s.h.mintSession(userId);
      expect((await send(steps, "warm", routeRequest("access", session))).status === 200, "warm");
      const expired = await withClockOffset(61 * 60_000, () => send(steps, "t+61m", routeRequest("access", session)));
      expect(expired.status === 401, `expired bearer → ${expired.status}`);
      expect(expired.authCalls === 0 && expired.restCalls === 0, "no upstream spent on an expired bearer");
    });

    await probe("K05", "short-lived bearer (70s): below the 60s cache floor → verified on every request", async ({ steps, expect, prng }) => {
      const { userId } = freshCase(s.h, prng);
      const session = s.h.mintSession(userId, 70);
      const first = await send(steps, "first", routeRequest("access", session));
      const second = await send(steps, "second", routeRequest("access", session));
      expect(first.status === 200 && second.status === 200, "both served");
      expect(first.authCalls === 1 && second.authCalls === 1, `GoTrue per request: ${first.authCalls}, ${second.authCalls}`);
    });

    await probe("K06", "100s bearer: cached, served until 5s before exp, refused after exp", async ({ steps, expect, prng }) => {
      const { userId } = freshCase(s.h, prng);
      const session = s.h.mintSession(userId, 100);
      expect((await send(steps, "warm", routeRequest("access", session))).status === 200, "warm");
      const mid = await withClockOffset(65_000, () => send(steps, "t+65s", routeRequest("access", session)));
      expect(mid.status === 200 && mid.authCalls === 0, `t+65s cached → ${mid.status}/${mid.authCalls}`);
      const edge = await withClockOffset(96_000, () => send(steps, "t+96s", routeRequest("access", session)));
      expect(edge.status === 200 && edge.authCalls === 1, `t+96s (<5s left) re-verified → ${edge.status}/${edge.authCalls}`);
      const past = await withClockOffset(101_000, () => send(steps, "t+101s", routeRequest("access", session)));
      expect(past.status === 401 && past.authCalls === 0, `t+101s expired → ${past.status}/${past.authCalls}`);
    });

    await probe("K07", "refresh rotation: old bearer keeps its cached window, new bearer verifies once", async ({ steps, expect, prng }) => {
      const { userId } = freshCase(s.h, prng);
      const session = s.h.mintSession(userId);
      expect((await send(steps, "warm", routeRequest("access", session))).status === 200, "warm");
      const rotated = await send(steps, "refresh", routeRequest("refresh", session));
      expect(rotated.status === 200, `refresh → ${rotated.status}`);
      const replayed = await send(steps, "replay spent refresh token", routeRequest("refresh", session));
      expect(replayed.status === 401, `spent refresh token → ${replayed.status}`);
      const newToken = [...s.h.sessions.values()].find((x) => x.userId === userId && !x.revoked && x.accessToken !== session.accessToken);
      expect(Boolean(newToken), "a rotated session exists");
      if (newToken) {
        const fresh = await send(steps, "new bearer", routeRequest("access", newToken));
        expect(fresh.status === 200 && fresh.authCalls === 1, `new bearer verified once → ${fresh.status}/${fresh.authCalls}`);
      }
      const stale = await send(steps, "old bearer (revoked upstream, still cached)", routeRequest("access", session));
      steps.push({ label: "note", text: "GoTrue revoked the old bearer on rotation; the edge trusts its cached row for the rest of the window" });
      expect(stale.status === 200 || stale.status === 401, `old bearer → ${stale.status}`);
    });
  } finally {
    s.restore();
  }
  const path = await writeArtifact("eviction_skew.json", {
    scenario: "eviction-skew",
    seed: STRESS_SEED,
    executed: rows.length,
    broken: rows.filter((row) => row.verdict === "BROKEN").map((row) => row.id),
    rows,
  });
  console.log(`[stress] eviction-skew: ${rows.length} probes → ${path}`);
});

// ─── 3. Seeded random fault fuzz ─────────────────────────────────────────────

const FUZZ_MODES: Record<Upstream, readonly string[]> = {
  redis: [...FAULT_MODES.generic.filter((m) => m !== "hang"), ...FAULT_MODES.redis],
  auth_user: [...FAULT_MODES.generic, ...FAULT_MODES.refusal, ...FAULT_MODES.auth_user],
  auth_token: [...FAULT_MODES.generic, ...FAULT_MODES.refusal, ...FAULT_MODES.auth_token],
  auth_logout: [...FAULT_MODES.generic, ...FAULT_MODES.refusal],
  // 503+Retry-After on a GET read costs ~21s per iteration (D19 covers it).
  rest: [...FAULT_MODES.generic.filter((m) => m !== "http_503_retry_after"), ...FAULT_MODES.refusal],
  rc: [...FAULT_MODES.generic.filter((m) => m !== "hang"), ...FAULT_MODES.refusal, ...FAULT_MODES.rc],
};
const FUZZ_ROUTES: Record<Upstream, readonly RouteName[]> = {
  redis: ["access", "me", "progress", "rank", "refresh", "logout"],
  auth_user: ["access", "me", "progress", "rank", "logout", "billing"],
  auth_token: ["refresh"],
  auth_logout: ["logout"],
  rest: ["access", "me", "progress", "rank", "billing"],
  rc: ["billing"],
};

Deno.test("stress/fault-fuzz: seeded random upstream × mode × route (invariants only)", async () => {
  const s = await boot();
  const rows: Array<Record<string, unknown>> = [];
  const violationsAll: string[] = [];
  try {
    for (let i = 0; i < STRESS_ITER; i++) {
      const seed = STRESS_SEED * 1_000 + i;
      const prng = new Prng(seed);
      const upstream = prng.pick(["redis", "auth_user", "auth_token", "auth_logout", "rest", "rc"] as const);
      const mode = prng.pick(FUZZ_MODES[upstream]);
      const route = prng.pick(FUZZ_ROUTES[upstream]);
      const warm = prng.next() < 0.6;
      const { userId } = freshCase(s.h, prng);
      const minted = s.h.mintSession(userId);
      const session: Session = { accessToken: minted.accessToken, refreshToken: minted.refreshToken };
      if (warm) {
        const w = await captureConsole(() => s.h.handler(routeRequest("access", session)));
        if (w.value.status !== 200) throw new Error(`fuzz ${i}: warm-up → ${w.value.status}`);
      }
      const observed = await observe(s, routeRequest(route, session), { upstream, mode });
      const violations: string[] = [];
      if (observed.status === 500) violations.push("unhandled 500");
      if (observed.leaked.length > 0) violations.push(`leak ${observed.leaked}`);
      if (!observed.requestId) violations.push("missing x-request-id");
      if (observed.unbounded) violations.push("no deadline on hung upstream");
      else if (observed.ms > BOUNDED_MS) violations.push(`answered after ${observed.ms}ms (> ${BOUNDED_MS}ms)`);
      const refusal = /^http_40[013]$/.test(mode) || mode === "auth_user_no_provider";
      if ((upstream === "auth_user" || upstream === "auth_token") && !refusal && !warm && observed.status === 401) {
        violations.push("infra failure surfaced as 401 (sign-out)");
      }
      if (upstream === "redis" && mode !== "redis_string_slots" && observed.status >= 500) {
        violations.push(`Upstash fault surfaced as ${observed.status}`);
      }
      if (upstream === "redis" && mode !== "redis_string_slots" && observed.status === 401) {
        violations.push("Upstash fault surfaced as 401");
      }
      // Recoverability: once the fault clears the same session works again,
      // unless the route legitimately ended it (logout answered 204).
      // A cold bearer whose refresh token was rotated is refused by GoTrue by
      // design (the fake revokes the previous access token on rotation).
      const ended = (route === "logout" && observed.status === 204) ||
        (route === "refresh" && observed.status === 200 && !warm);
      const rec = await recover(s, ended ? "same_token_401" : "same_token_200", session);
      const recOk = rec !== null &&
        (rec.status === (ended ? 401 : 200) || (mode === "redis_string_slots" && rec.status === 401));
      if (!recOk) violations.push(`recovery → ${rec?.status ?? "none"}`);
      const known = KNOWN_FUZZ_VIOLATION(upstream, mode, route, violations);
      rows.push({
        i,
        seed,
        upstream,
        mode,
        route,
        warm,
        status: observed.status,
        code: observed.code,
        ms: observed.ms,
        unbounded: observed.unbounded,
        authCalls: observed.authCalls,
        restCalls: observed.restCalls,
        redisCalls: observed.redisCalls,
        recovery: rec?.status ?? null,
        violations,
        known,
        verdict: violations.length === 0 ? "HELD" : known ? "BROKEN(known)" : "BROKEN",
        replay: `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${i + 1} ${REPLAY_BASE} --filter "fault-fuzz"`,
      });
      if (violations.length > 0 && !known) {
        violationsAll.push(`#${i} (seed ${seed}) ${upstream}/${mode}/${route}: ${violations.join("; ")}`);
      }
    }
  } finally {
    s.restore();
  }
  const path = await writeArtifact("fault_fuzz.json", {
    scenario: "fault-fuzz",
    seed: STRESS_SEED,
    iterations: rows.length,
    broken: rows.filter((row) => row.verdict === "BROKEN").length,
    brokenKnown: rows.filter((row) => row.verdict === "BROKEN(known)").length,
    rows,
  });
  console.log(`[stress] fault-fuzz: ${rows.length} iterations, ${violationsAll.length} unexpected → ${path}`);
  if (violationsAll.length > 0) throw new Error(violationsAll.join("\n"));
});

/** The fuzz re-derives the matrix's known-broken behaviours; keep them from
 * failing the suite twice while still recording them. */
function KNOWN_FUZZ_VIOLATION(
  upstream: Upstream,
  mode: string,
  route: RouteName,
  violations: string[],
): boolean {
  if (violations.length === 0) return false;
  // L04 / D06: no deadline on logout or PostgREST fetches.
  if (mode === "hang" && (upstream === "auth_logout" || upstream === "rest")) {
    return violations.every((v) => v.startsWith("no deadline"));
  }
  // R17: logout under a hung Upstash serialises 6 × 1.2s pipelines.
  if (mode === "hang" && upstream === "redis" && route === "logout") {
    return violations.every((v) => v.startsWith("answered after"));
  }
  // D18–D21: postgrest-js retry ladder on GET reads (network error / 503).
  if (upstream === "rest" && (mode === "throw" || mode === "http_503_retry_after")) {
    return violations.every((v) => v.startsWith("answered after"));
  }
  // D23/D24: a 200 with a non-array body on a list read is not handled.
  if (upstream === "rest" && mode === "body_empty_object" && (route === "rank" || route === "progress")) {
    return violations.every((v) => v === "unhandled 500");
  }
  // L09: GoTrue 4xx other than the refusal set on logout → 204 + local eviction
  // (the fuzz's recovery check expects 401 after a 204, so L09 does not
  // trip here; listed for completeness).
  return false;
}

// ─── 4. Load campaign: ≥1000 requests, p50/p95, Supabase round trips ────────

interface LoadUser {
  id: string;
  session: Session;
}

Deno.test("stress/load: seeded route mix, latency percentiles and upstream round trips per request", async () => {
  const s = await boot();
  const prng = new Prng(STRESS_SEED + 777);
  const perRoute = new Map<string, Array<Record<string, number>>>();
  const statuses: Record<string, number> = {};
  const problems: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const USERS = 64;
  let heapBefore: Deno.MemoryUsage | null = null;
  let heapAfter: Deno.MemoryUsage | null = null;
  let wallMs = 0;
  let burst: Record<string, unknown> = {};
  try {
    s.h.reset();
    stubDb(s.h);
    const users: LoadUser[] = [];
    for (let i = 0; i < USERS; i++) {
      const id = prng.uuid();
      s.h.registerUser({ id, email: `${id.slice(0, 8)}@load.test`, provider: "google" });
      const minted = s.h.mintSession(id);
      users.push({ id, session: { accessToken: minted.accessToken, refreshToken: minted.refreshToken } });
    }
    const MIX: ReadonlyArray<readonly [RouteName, number]> = [
      ["access", 40],
      ["me", 15],
      ["progress", 15],
      ["rank", 15],
      ["refresh", 6],
      ["billing", 5],
      ["logout", 4],
    ];
    heapBefore = Deno.memoryUsage();
    const startedAll = performance.now();
    for (let i = 0; i < STRESS_LOAD; i++) {
      const user = prng.pick(users);
      const route = prng.weighted(MIX);
      const callsMark = s.h.calls.length;
      const started = performance.now();
      const { value: response, lines } = await captureConsole(() =>
        s.h.handler(routeRequest(route, user.session)),
      );
      const ms = performance.now() - started;
      const counters = countUpstream(s, callsMark, s.faults.hits.length);
      const supabase = counters.authCalls + counters.tokenCalls + counters.logoutCalls + counters.restCalls;
      statuses[`${route}:${response.status}`] = (statuses[`${route}:${response.status}`] ?? 0) + 1;
      if (response.status >= 500) {
        const err = await readError(response);
        problems.push(`#${i} ${route} → ${response.status} ${err.raw} ${lines.join(" | ")}`);
      }
      if (route === "refresh") {
        if (response.status === 200) {
          const body = (await response.json()) as {
            session?: { accessToken?: string; refreshToken?: string };
            accessToken?: string;
            refreshToken?: string;
          };
          const accessToken = body.session?.accessToken ?? body.accessToken;
          const refreshToken = body.session?.refreshToken ?? body.refreshToken;
          if (accessToken && refreshToken) user.session = { accessToken, refreshToken };
          else problems.push(`#${i} refresh 200 without tokens: ${JSON.stringify(body).slice(0, 200)}`);
        } else {
          problems.push(`#${i} refresh → ${response.status}`);
        }
      } else if (route === "logout") {
        if (response.status !== 204) problems.push(`#${i} logout → ${response.status}`);
        const minted = s.h.mintSession(user.id);
        user.session = { accessToken: minted.accessToken, refreshToken: minted.refreshToken };
      } else if (response.status !== 200) {
        problems.push(`#${i} ${route} → ${response.status}`);
      }
      const sample = { ms, supabase, redis: counters.redisCalls, rc: counters.rcCalls, auth: counters.authCalls, rest: counters.restCalls };
      if (!perRoute.has(route)) perRoute.set(route, []);
      perRoute.get(route)!.push(sample);
      rows.push({ i, route, user: user.id.slice(0, 8), status: response.status, ...sample, ms: Math.round(ms * 1000) / 1000 });
      // Keep the harness' recorded-call log from dominating memory.
      if (s.h.calls.length > 5_000) s.h.calls.length = 0;
      if (s.h.redisCommands.length > 20_000) s.h.redisCommands.length = 0;
    }
    wallMs = performance.now() - startedAll;
    heapAfter = Deno.memoryUsage();

    // Concurrent burst: 200 simultaneous cold GET /v1/progress for ONE user must
    // coalesce into a single PostgREST build (2 reads) and all answer 200.
    const burstUser = users[0];
    s.h.calls.length = 0;
    const warm = await captureConsole(() => s.h.handler(routeRequest("access", burstUser.session)));
    if (warm.value.status !== 200) problems.push(`burst warm-up → ${warm.value.status}`);
    // Bust any cached progress from the sequential phase by using a fresh user.
    const burstId = prng.uuid();
    s.h.registerUser({ id: burstId, email: "burst@load.test", provider: "google" });
    const burstMinted = s.h.mintSession(burstId);
    const burstSession: Session = { accessToken: burstMinted.accessToken, refreshToken: burstMinted.refreshToken };
    const warm2 = await captureConsole(() => s.h.handler(routeRequest("access", burstSession)));
    if (warm2.value.status !== 200) problems.push(`burst warm-up 2 → ${warm2.value.status}`);
    s.h.calls.length = 0;
    const burstStarted = performance.now();
    const burstResponses = await captureConsole(() =>
      Promise.all(Array.from({ length: 200 }, () => s.h.handler(routeRequest("progress", burstSession)))),
    );
    const burstMs = performance.now() - burstStarted;
    const burstStatuses: Record<string, number> = {};
    for (const r of burstResponses.value) burstStatuses[r.status] = (burstStatuses[r.status] ?? 0) + 1;
    const burstCounters = countUpstream(s, 0, s.faults.hits.length);
    burst = {
      concurrency: 200,
      route: "GET /v1/progress (cold, one user)",
      statuses: burstStatuses,
      wallMs: Math.round(burstMs),
      postgrestCalls: burstCounters.restCalls,
      redisCalls: burstCounters.redisCalls,
      authCalls: burstCounters.authCalls,
    };
    if (burstStatuses["200"] !== 200) problems.push(`burst statuses ${JSON.stringify(burstStatuses)}`);
    if (burstCounters.restCalls > 2) problems.push(`burst did not coalesce: ${burstCounters.restCalls} PostgREST calls for one cold key`);
  } finally {
    s.restore();
  }

  const routes: Record<string, unknown> = {};
  const hotPathFindings: string[] = [];
  for (const [route, samples] of perRoute) {
    const supabase = samples.map((x) => x.supabase).sort((a, b) => a - b);
    const redis = samples.map((x) => x.redis).sort((a, b) => a - b);
    const cold = samples.filter((x) => x.auth > 0).length;
    routes[route] = {
      requests: samples.length,
      latency: latencySummary(samples.map((x) => x.ms)),
      supabaseRoundTrips: {
        min: supabase[0],
        p50: supabase[Math.floor(supabase.length / 2)],
        max: supabase[supabase.length - 1],
        mean: Math.round((supabase.reduce((a, b) => a + b, 0) / supabase.length) * 100) / 100,
      },
      redisRoundTrips: {
        min: redis[0],
        p50: redis[Math.floor(redis.length / 2)],
        max: redis[redis.length - 1],
      },
      coldAuth: cold,
      rcCalls: samples.reduce((a, x) => a + x.rc, 0),
    };
    if (supabase[supabase.length - 1] > 3) {
      hotPathFindings.push(`${route}: max ${supabase[supabase.length - 1]} Supabase round trips in one request`);
    }
  }
  const all = rows.map((row) => row.ms as number);
  const report = {
    scenario: "load",
    seed: STRESS_SEED,
    requests: rows.length,
    users: USERS,
    wallMs: Math.round(wallMs),
    latency: latencySummary(all),
    statuses,
    routes,
    hotPathFindings,
    burst,
    heap: { before: heapBefore, after: heapAfter },
    problems,
    note: "in-process; upstreams are in-memory fakes, so latency is handler+cache CPU only (no network)",
    rows,
  };
  const path = await writeArtifact("load.json", report);
  console.log(
    `[stress] load: ${rows.length} requests in ${Math.round(wallMs)}ms, p50 ${report.latency.p50Ms}ms p95 ${report.latency.p95Ms}ms, ${problems.length} problems → ${path}`,
  );
  if (problems.length > 0) throw new Error(problems.slice(0, 10).join("\n"));
  if (hotPathFindings.length > 0) throw new Error(hotPathFindings.join("\n"));
});

// ─── 5. L1 flood: distinct users vs the bounded per-isolate cache ───────────

Deno.test("stress/l1-flood: distinct users through the real handler; L1 stays bounded and L2 backfills", async () => {
  const s = await boot();
  const prng = new Prng(STRESS_SEED + 20_000);
  const report: Record<string, unknown> = {};
  const problems: string[] = [];
  try {
    s.h.reset();
    stubDb(s.h);
    const tokens: string[] = [];
    const heapStart = Deno.memoryUsage();
    const started = performance.now();
    let non200 = 0;
    for (let i = 0; i < STRESS_USERS; i++) {
      const id = prng.uuid();
      s.h.registerUser({ id, email: `${i}@flood.test`, provider: "google" });
      const minted = s.h.mintSession(id);
      tokens.push(minted.accessToken);
      const response = await s.h.handler(apiRequest("GET", "/v1/me/access", { token: minted.accessToken }));
      if (response.status !== 200) non200 += 1;
      await response.body?.cancel();
      if (s.h.calls.length > 2_000) s.h.calls.length = 0;
      if (s.h.redisCommands.length > 20_000) s.h.redisCommands.length = 0;
    }
    const floodMs = performance.now() - started;
    const heapFlood = Deno.memoryUsage();
    const redisAuthRows = [...s.h.redis.keys()].filter((k) => k.startsWith("auth:") && !k.startsWith("auth:revoked:")).length;

    // Residency probe: a bearer whose row is still in L1 answers with a
    // pipeline that does NOT ask Redis for its value (only marker + TTL);
    // an evicted one issues GET auth:<hash> and is backfilled from L2.
    const probeIndices = new Set<number>();
    const SAMPLE = Math.min(600, STRESS_USERS);
    while (probeIndices.size < SAMPLE) probeIndices.add(prng.int(0, STRESS_USERS - 1));
    const order = [...probeIndices].sort((a, b) => a - b);
    let l1Hits = 0;
    let l2Backfills = 0;
    let probeNon200 = 0;
    let oldestHit = -1;
    let newestMiss = -1;
    for (const index of order) {
      s.h.redisCommands.length = 0;
      s.h.calls.length = 0;
      const response = await s.h.handler(apiRequest("GET", "/v1/me/access", { token: tokens[index] }));
      await response.body?.cancel();
      if (response.status !== 200) probeNon200 += 1;
      const askedRedisForValue = s.h.redisCommands.some(
        (cmd) => String(cmd[0]) === "GET" && String(cmd[1]).startsWith("auth:") && !String(cmd[1]).startsWith("auth:revoked:"),
      );
      const gotrue = s.h.calls.filter((call) => call.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)).length;
      if (gotrue > 0) problems.push(`probe ${index}: GoTrue consulted although L2 holds the row`);
      if (askedRedisForValue) {
        l2Backfills += 1;
        newestMiss = Math.max(newestMiss, index);
      } else {
        l1Hits += 1;
        if (oldestHit < 0) oldestHit = index;
      }
    }
    const heapProbe = Deno.memoryUsage();
    const estimatedResident = Math.round((l1Hits / SAMPLE) * STRESS_USERS);
    report.users = STRESS_USERS;
    report.floodMs = Math.round(floodMs);
    report.non200 = non200;
    report.redisAuthRows = redisAuthRows;
    report.probe = {
      sample: SAMPLE,
      l1Hits,
      l2Backfills,
      probeNon200,
      oldestIndexStillInL1: oldestHit,
      newestIndexEvicted: newestMiss,
      estimatedL1Resident: estimatedResident,
      l1Bound: 5_000,
    };
    report.heap = {
      start: heapStart,
      afterFlood: heapFlood,
      afterProbe: heapProbe,
      heapUsedDeltaMB: Math.round(((heapFlood.heapUsed - heapStart.heapUsed) / 1_048_576) * 100) / 100,
      rssDeltaMB: Math.round(((heapFlood.rss - heapStart.rss) / 1_048_576) * 100) / 100,
      note: "delta includes the fake Upstash Map (every auth row + rate-limit window) and Deno test bookkeeping — an upper bound on L1",
    };
    if (non200 > 0) problems.push(`${non200} flood requests were not 200`);
    if (probeNon200 > 0) problems.push(`${probeNon200} probes were not 200`);
    if (redisAuthRows !== STRESS_USERS) problems.push(`L2 holds ${redisAuthRows} auth rows for ${STRESS_USERS} users`);
    if (STRESS_USERS > 5_000 && estimatedResident > 5_000 * 1.15) {
      problems.push(`L1 residency estimate ${estimatedResident} exceeds the 5000 bound`);
    }
    if (STRESS_USERS > 5_000 && newestMiss >= 0 && oldestHit >= 0 && newestMiss > oldestHit) {
      // Eviction drops the OLDEST third; the surviving set is a suffix. A
      // miss newer than a hit would mean random/unbounded eviction.
      problems.push(`eviction not FIFO: index ${newestMiss} evicted while ${oldestHit} survived`);
    }
  } finally {
    s.restore();
  }
  report.problems = problems;
  const path = await writeArtifact("l1_flood.json", { scenario: "l1-flood", seed: STRESS_SEED, ...report });
  console.log(`[stress] l1-flood: ${STRESS_USERS} users, probe ${JSON.stringify(report.probe)} → ${path}`);
  if (problems.length > 0) throw new Error(problems.join("\n"));
});

// ─── 6. L1 heap: cache.ts alone, STRESS_USERS distinct auth rows ────────────
// The flood above measures the whole isolate (fake Upstash, recorded calls,
// harness maps included). This isolates the production Map: a child Deno
// process with NO Upstash env runs stress_l1_only.ts (cacheSet never leaves
// the isolate; keys re-derived from the seed, nothing else retained; forced
// GC before each reading) for STRESS_USERS and for 5000, so a delta that
// grows with the user count would expose an unbounded structure.

interface L1OnlyReport {
  users: number;
  gcForced: boolean;
  setMs: number;
  resident: number;
  oldestResident: number;
  newestEvicted: number;
  heapDeltaMB: number;
  bytesPerResidentEntry: number | null;
}

async function l1Only(users: number, seed: number): Promise<L1OnlyReport> {
  const script = new URL("./stress_l1_only.ts", import.meta.url).pathname;
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--no-check", "--v8-flags=--expose-gc", script, String(users), String(seed)],
    cwd: new URL(".", import.meta.url).pathname,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const out = new TextDecoder().decode(stdout).trim();
  if (code !== 0) throw new Error(`stress_l1_only.ts exit ${code}: ${new TextDecoder().decode(stderr).slice(0, 800)}`);
  return JSON.parse(out.split("\n").at(-1) ?? "{}") as L1OnlyReport;
}

Deno.test("stress/l1-heap: 20k distinct auth rows leave at most 5000 entries and a flat heap in cache.ts", async () => {
  const problems: string[] = [];
  const seed = STRESS_SEED + 30_000;
  const baseline = await l1Only(5_000, seed);
  const flood = await l1Only(STRESS_USERS, seed);
  const report = {
    scenario: "l1-heap",
    seed,
    l1Bound: 5_000,
    baseline,
    flood,
    growthMBPerExtra10kUsers: STRESS_USERS > 5_000
      ? Math.round(((flood.heapDeltaMB - baseline.heapDeltaMB) / ((STRESS_USERS - 5_000) / 10_000)) * 100) / 100
      : null,
    problems,
  };
  if (!flood.gcForced) problems.push("child process had no gc() — heap deltas not GC-stable");
  if (flood.resident > 5_000) problems.push(`L1 holds ${flood.resident} rows (> 5000 bound)`);
  if (STRESS_USERS > 5_000 && flood.resident < 5_000 * (2 / 3) - 1) {
    problems.push(`L1 holds only ${flood.resident} rows after the flood (expected ≥ 3333 survivors)`);
  }
  if (flood.newestEvicted > flood.oldestResident) {
    problems.push(`eviction not FIFO: index ${flood.newestEvicted} evicted while ${flood.oldestResident} survived`);
  }
  // Bounded Map ⇒ the heap after 20k (or more) users is within noise of the
  // heap after exactly 5000; allow 1 MB of GC/allocator slack.
  if (STRESS_USERS > 5_000 && flood.heapDeltaMB > baseline.heapDeltaMB + 1) {
    problems.push(
      `L1 heap grows with distinct users: ${baseline.heapDeltaMB}MB @5000 → ${flood.heapDeltaMB}MB @${STRESS_USERS}`,
    );
  }
  const path = await writeArtifact("l1_heap.json", report);
  console.log(
    `[stress] l1-heap: ${STRESS_USERS} users → resident ${flood.resident}, heap Δ ${flood.heapDeltaMB}MB (5000 users: ${baseline.heapDeltaMB}MB) → ${path}`,
  );
  if (problems.length > 0) throw new Error(problems.join("\n"));
});
