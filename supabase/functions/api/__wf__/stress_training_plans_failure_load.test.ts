// Stress campaign for `POST /v1/training-plans` (supabase/functions/api/index.ts)
// — lens: FAILURE INJECTION + LOAD.
//
// The REAL handler runs in process (stress_training_plans_harness.ts boots
// ../index.ts with Upstash configured and every upstream faked). Three
// campaigns, each writing a JSON table (seed → outcome) under
// artifacts/stress/route-post-v1-training-plans/ (override: STRESS_OUT):
//
//   1. faults  — every upstream the request path touches (Supabase Auth via
//                GET /user and the id_token grant, Upstash, PostgREST,
//                RevenueCat) fails / hangs / answers slowly / answers with a
//                malformed body, in turn and combined; plus client-shape and
//                budget faults. Each case asserts the user-visible error class
//                (what apps/mobile/src/training/api.ts would do with it), the
//                generic-5xx / request-id / JSON-body invariants, upstream
//                round trips, and recoverability once the fault heals.
//   2. load    — STRESS_ITER requests (default 1000) over a seeded pool of
//                users/ips: p50/p95/p99 latency, Supabase and Redis round
//                trips per request (a hot path doing >3 Supabase trips fails),
//                plus a concurrent burst and a cold-cache stampede probe.
//   3. memory  — STRESS_USERS distinct users (default 2000; the full campaign
//                is STRESS_USERS=20000): heap growth of the per-isolate L1
//                caches, L1 residency after the cap, and — at ≥ 20000 — the
//                in-memory rate-limit window reset with Redis down.
//
// Replay: STRESS_SEED=<n> deno test -A --no-check --config deno.json \
//         stress_training_plans_failure_load.test.ts [--filter faults]
//         STRESS_CASE=<case id> narrows the fault campaign to one case.

import { assert, assertEquals } from "@std/assert";
import {
  type AccessLine,
  callEdge,
  type EdgeAnswer,
  edgeRequest,
  fakeJwt,
  type Fault,
  loadStressHarness,
  percentile,
  providerIdToken,
  type Rng,
  rng,
  seededIp,
  seedFor,
  type StressHarness,
  SUPABASE_URL,
  type Upstream,
} from "./stress_training_plans_harness.ts";

const ROUTE = "/v1/training-plans";
const EXPECTED_CODE = "training.plan_unavailable";
const BASE_SEED = Number(Deno.env.get("STRESS_SEED") ?? "20260904");
const STRESS_ITER = Number(Deno.env.get("STRESS_ITER") ?? "1000");
const STRESS_USERS = Number(Deno.env.get("STRESS_USERS") ?? "2000");
const OUT_DIR = Deno.env.get("STRESS_OUT") ??
  new URL(
    "../../../../artifacts/stress/route-post-v1-training-plans/",
    import.meta.url,
  ).pathname;
const AUTH_TIMEOUT_MS = (() => {
  const configured = Number(Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS"));
  return Number.isInteger(configured) && configured > 0 ? configured : 600;
})();
/** cache.ts REDIS_TIMEOUT_MS (not configurable). */
const REDIS_TIMEOUT_MS = 1_200;
/** Scheduler slack allowed on top of a deadline before a bound counts as missed. */
const TIMING_SLACK_MS = 400;

// ─── Shared helpers ──────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

interface Actor {
  userId: string;
  ip: string;
  /** Supabase access token (the shipping contract). */
  sessionToken: string;
  sessionId: string;
  /** Google/Apple ID token (transitional bearer for pre-session app builds). */
  providerToken: string;
  provider: "google" | "apple";
}

function mintActor(
  h: StressHarness,
  r: Rng,
  provider: "google" | "apple" = "google",
): Actor {
  const userId = r.uuid();
  h.registerUser({
    id: userId,
    email: `${userId.slice(0, 8)}@example.com`,
    provider,
  });
  const session = h.mintSession(userId);
  return {
    userId,
    ip: seededIp(r),
    sessionToken: session.accessToken,
    sessionId: session.sessionId,
    providerToken: providerIdToken(provider, userId, r),
    provider,
  };
}

const planRequest = (
  actor: Actor,
  bearer: "session" | "provider",
  extra: Record<string, unknown> = {},
) =>
  edgeRequest("POST", ROUTE, {
    token: bearer === "session" ? actor.sessionToken : actor.providerToken,
    ip: actor.ip,
    body: { sourceShotId: "11111111-1111-4111-8111-111111111111" },
    ...extra,
  });

/** Internal detail that must never reach a client body. */
const LEAK_RE =
  /stress|upstash|fake|HTTP \d{3}|stack|TypeError|connection reset|supabase\.stress|Error:|at file/i;

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

function invariantChecks(answer: EdgeAnswer, log: AccessLine[]): Check[] {
  const checks: Check[] = [];
  checks.push({
    name: "json_body",
    pass: answer.status === 204 || isRecord(answer.body),
    detail: answer.rawBody.slice(0, 120),
  });
  checks.push({
    name: "request_id_present",
    pass: typeof answer.requestId === "string" && answer.requestId.length >= 8,
  });
  const line = log.find((entry) => entry.requestId === answer.requestId);
  checks.push({
    name: "access_log_correlates",
    pass: Boolean(line) && line?.status === answer.status,
    detail: line
      ? `route=${line.route} status=${line.status}`
      : "no access line",
  });
  if (answer.status >= 400) {
    checks.push({
      name: "error_message_string",
      pass: typeof answer.errorMessage === "string" &&
        answer.errorMessage.length > 0,
    });
  }
  if (answer.status >= 500) {
    checks.push({
      name: "generic_5xx_body",
      pass: !LEAK_RE.test(answer.rawBody) &&
        /temporarily unavailable|Something went wrong/.test(
          answer.errorMessage ?? "",
        ),
      detail: answer.rawBody.slice(0, 160),
    });
    checks.push({
      name: "no_status_5xx_other_than_503",
      pass: answer.status === 503,
      detail: `status ${answer.status}`,
    });
  }
  checks.push({
    name: "security_headers",
    pass: answer.status === 204 ||
      (answer.headers["cache-control"] === "no-store" &&
        answer.headers["x-content-type-options"] === "nosniff"),
    detail: JSON.stringify({
      cc: answer.headers["cache-control"],
      xcto: answer.headers["x-content-type-options"],
    }),
  });
  checks.push({
    name: "no_unexpected_upstream",
    pass: answer.calls.every((call) => call.upstream !== "unexpected"),
    detail: answer.calls
      .filter((call) => call.upstream === "unexpected")
      .map((call) => call.url)
      .join(","),
  });
  return checks;
}

/** What apps/mobile/src/training/api.ts does with the answer. */
function mobileVerdict(answer: EdgeAnswer): string {
  if (answer.status === 401) return "session_expired→sign_out";
  if (answer.status === 409 && answer.errorCode === EXPECTED_CODE) {
    return "plan_unavailable";
  }
  if (answer.status >= 500 || answer.status === 429) return "retryable";
  if (answer.status >= 400) return "request_failed";
  return "ok";
}

async function ensureOutDir(): Promise<void> {
  await Deno.mkdir(OUT_DIR, { recursive: true });
}

async function writeReport(name: string, report: unknown): Promise<string> {
  await ensureOutDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${OUT_DIR}${name}-${stamp}.json`;
  const text = JSON.stringify(report, null, 2);
  await Deno.writeTextFile(path, text);
  await Deno.writeTextFile(`${OUT_DIR}${name}-latest.json`, text);
  return path;
}

function reportMeta(campaign: string) {
  return {
    campaign,
    target:
      "POST /v1/training-plans (supabase/functions/api/index.ts, real handler in process)",
    commit: Deno.env.get("STRESS_COMMIT") ?? null,
    generatedAt: new Date().toISOString(),
    denoVersion: Deno.version.deno,
    baseSeed: BASE_SEED,
    authUpstreamTimeoutMs: AUTH_TIMEOUT_MS,
    redisTimeoutMs: REDIS_TIMEOUT_MS,
  };
}

// ─── Campaign 1: failure injection ───────────────────────────────────────────

type Bearer = "session" | "provider";

interface Expect {
  /** Acceptable statuses for the faulted request. */
  status: number[];
  /** error.code the body must carry (null = no code expected). */
  code?: string | null;
  retryAfter?: boolean;
  /** Upper bound on the faulted request's latency (ms). */
  maxLatencyMs?: number;
  /** Lower bound (a latency fault must actually be waited out). */
  minLatencyMs?: number;
  /** Exact Supabase Auth calls (GET /user or the id_token grant) during the request. */
  authCalls?: number | { min?: number; max?: number };
  /** Exact PostgREST / RevenueCat calls during the request (route must never need them). */
  restCalls?: number;
  revenueCatCalls?: number;
  /** Redis pipelines during the request. */
  redisCalls?: number | { min?: number; max?: number };
  /** Whether the pre-auth auth-failure budget must have been charged. */
  authFailureCharged?: boolean;
}

interface FaultCase {
  id: string;
  group:
    | "auth_user"
    | "auth_token"
    | "redis"
    | "rest"
    | "revenuecat"
    | "compound"
    | "client"
    | "budget";
  title: string;
  bearer: Bearer;
  /** Serve one healthy request first so the auth cache holds the bearer. */
  warm?: boolean;
  faults: Array<
    { upstream: Upstream; fault: Fault; times?: number; every?: number }
  >;
  /** Custom request shaping (defaults to the app's request). */
  request?: (actor: Actor, h: StressHarness, r: Rng) => Request;
  /** Extra preparation (e.g. exhaust a budget) — returns extra iterations run. */
  prepare?: (actor: Actor, h: StressHarness, r: Rng) => Promise<number>;
  expect: Expect;
  /** How the actor recovers once the fault heals: same bearer, or a fresh session. */
  recovery: "same_bearer" | "fresh_session" | "other_actor" | "none";
  /** Optional custom assertion on the faulted answer (returns a failure message or null). */
  also?: (
    answer: EdgeAnswer,
    h: StressHarness,
    before: number,
  ) => string | null;
  /** Optional follow-up while the faults are still installed. */
  after?: (
    actor: Actor,
    h: StressHarness,
  ) => Promise<{ iterations: number; problem: string | null }>;
}

const html502 = "<html><body><h1>502 Bad Gateway</h1></body></html>";

const redisCommandError = (
  match: (cmd: Array<string | number>) => boolean,
  error = "ERR max requests limit exceeded",
): Fault => ({
  kind: "custom",
  respond: (_request, body) => {
    const commands = Array.isArray(body)
      ? (body as Array<Array<string | number>>)
      : [];
    return new Response(
      JSON.stringify(
        commands.map((cmd) => (match(cmd) ? { error } : realRedis(cmd))),
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  },
});

/** Fallback real answers for the custom Redis faults: the harness' store is
 * private to it, so custom faults answer "absent" for reads and "OK" for
 * writes — enough for the code paths under test (which only need the faulted
 * slot to be shaped as specified). */
function realRedis(cmd: Array<string | number>): { result?: unknown } {
  const op = String(cmd[0]).toUpperCase();
  if (op === "GET") return { result: null };
  if (op === "TTL") return { result: -2 };
  if (op === "SET") return { result: "OK" };
  if (op === "INCR") return { result: 1 };
  if (op === "EXPIRE") return { result: 1 };
  if (op === "DEL") return { result: 1 };
  return { result: null };
}

const redisSlotOverride = (
  match: (cmd: Array<string | number>) => boolean,
  result: unknown,
): Fault => ({
  kind: "custom",
  respond: (_request, body) => {
    const commands = Array.isArray(body)
      ? (body as Array<Array<string | number>>)
      : [];
    return new Response(
      JSON.stringify(
        commands.map((cmd) => (match(cmd) ? { result } : realRedis(cmd))),
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  },
});

const UNAVAILABLE: Expect = {
  status: [503],
  code: null,
  retryAfter: true,
  restCalls: 0,
  revenueCatCalls: 0,
};
const REFUSED: Expect = {
  status: [401],
  code: null,
  authFailureCharged: true,
  restCalls: 0,
  revenueCatCalls: 0,
};
const ROUTE_ANSWER: Expect = {
  status: [409],
  code: EXPECTED_CODE,
  restCalls: 0,
  revenueCatCalls: 0,
};

function buildCases(): FaultCase[] {
  const cases: FaultCase[] = [];
  const authUser = (
    id: string,
    title: string,
    fault: Fault,
    expect: Expect,
    extra: Partial<FaultCase> = {},
  ) =>
    cases.push({
      id,
      group: "auth_user",
      title,
      bearer: "session",
      faults: [{ upstream: "auth_user", fault }],
      expect,
      recovery: "same_bearer",
      ...extra,
    });

  // ── Supabase Auth: GET /auth/v1/user (session bearer, cold cache) ────────
  authUser("S01_auth_user_500_json", "GoTrue 500 JSON", {
    kind: "http",
    status: 500,
    body: JSON.stringify({
      code: 500,
      msg: "internal",
      error_code: "unexpected_failure",
    }),
    headers: { "Content-Type": "application/json" },
  }, { ...UNAVAILABLE, authCalls: 1 });
  authUser("S02_auth_user_502_html", "GoTrue 502 HTML gateway page", {
    kind: "http",
    status: 502,
    body: html502,
    headers: { "Content-Type": "text/html" },
  }, { ...UNAVAILABLE, authCalls: 1 });
  authUser(
    "S03_auth_user_503_retry_after",
    "GoTrue 503 with Retry-After: 7",
    {
      kind: "http",
      status: 503,
      body: "unavailable",
      headers: { "Retry-After": "7" },
    },
    { ...UNAVAILABLE, authCalls: 1 },
    {
      also: (answer) =>
        answer.headers["retry-after"] === "7"
          ? null
          : `Retry-After ${answer.headers["retry-after"]} ≠ 7`,
    },
  );
  authUser(
    "S04_auth_user_429",
    "GoTrue 429 (rate-limiting the edge) with Retry-After: 3",
    {
      kind: "http",
      status: 429,
      body: JSON.stringify({ code: 429, msg: "over_request_rate_limit" }),
      headers: { "Content-Type": "application/json", "Retry-After": "3" },
    },
    { ...UNAVAILABLE, authCalls: 1 },
    {
      also: (answer) =>
        answer.headers["retry-after"] === "3"
          ? null
          : `Retry-After ${answer.headers["retry-after"]} ≠ 3`,
    },
  );
  authUser("S05_auth_user_504", "GoTrue 504", { kind: "http", status: 504 }, {
    ...UNAVAILABLE,
    authCalls: 1,
  });
  authUser("S06_auth_user_200_garbage", "GoTrue 200 non-JSON body", {
    kind: "http",
    status: 200,
    body: "<<not json>>",
    headers: { "Content-Type": "application/json" },
  }, { ...UNAVAILABLE, authCalls: 1 });
  authUser("S07_auth_user_200_empty_object", "GoTrue 200 {}", {
    kind: "http",
    status: 200,
    body: "{}",
    headers: { "Content-Type": "application/json" },
  }, { ...UNAVAILABLE, authCalls: 1 });
  authUser("S08_auth_user_200_array", "GoTrue 200 []", {
    kind: "http",
    status: 200,
    body: "[]",
    headers: { "Content-Type": "application/json" },
  }, { ...UNAVAILABLE, authCalls: 1 });
  authUser("S09_auth_user_200_numeric_id", "GoTrue 200 {id: 123}", {
    kind: "http",
    status: 200,
    body: JSON.stringify({ id: 123, app_metadata: { provider: "google" } }),
    headers: { "Content-Type": "application/json" },
  }, { ...UNAVAILABLE, authCalls: 1 });
  authUser("S10_auth_user_200_truncated", "GoTrue 200 truncated JSON", {
    kind: "http",
    status: 200,
    body: '{"id":"abc',
    headers: { "Content-Type": "application/json" },
  }, { ...UNAVAILABLE, authCalls: 1 });
  authUser("S11_auth_user_204_empty", "GoTrue 204 empty body", {
    kind: "http",
    status: 204,
    body: "",
  }, {
    ...UNAVAILABLE,
    authCalls: 1,
  });
  authUser(
    "S12_auth_user_body_stream_error",
    "GoTrue 200 whose body stream resets mid-read",
    {
      kind: "body_error",
    },
    {
      ...UNAVAILABLE,
      authCalls: { min: 2 },
      maxLatencyMs: AUTH_TIMEOUT_MS + TIMING_SLACK_MS,
    },
  );
  authUser(
    "S13_auth_user_email_provider",
    "GoTrue 200 for an email/password user (no Google/Apple identity)",
    {
      kind: "custom",
      respond: () =>
        new Response(
          JSON.stringify({
            id: "66666666-6666-4666-8666-666666666666",
            email: "e@example.com",
            app_metadata: { provider: "email", providers: ["email"] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    },
    { ...REFUSED, authCalls: 1 },
    { recovery: "fresh_session" },
  );
  authUser(
    "S14_auth_user_401",
    "GoTrue 401 (session logged out elsewhere)",
    {
      kind: "http",
      status: 401,
      body: JSON.stringify({
        code: 401,
        msg: "invalid JWT: session not found",
        error_code: "session_not_found",
      }),
      headers: { "Content-Type": "application/json" },
    },
    { ...REFUSED, authCalls: 1 },
    { recovery: "fresh_session" },
  );
  authUser(
    "S15_auth_user_403",
    "GoTrue 403 (user banned / deleted)",
    {
      kind: "http",
      status: 403,
      body: JSON.stringify({
        code: 403,
        msg: "User not found",
        error_code: "user_not_found",
      }),
      headers: { "Content-Type": "application/json" },
    },
    { ...REFUSED, authCalls: 1 },
    { recovery: "fresh_session" },
  );
  authUser(
    "S16_auth_user_400",
    "GoTrue 400",
    {
      kind: "http",
      status: 400,
      body: JSON.stringify({
        code: 400,
        msg: "bad request",
        error_code: "validation_failed",
      }),
      headers: { "Content-Type": "application/json" },
    },
    { ...REFUSED, authCalls: 1 },
    { recovery: "fresh_session" },
  );
  authUser(
    "S17_auth_user_404",
    "GoTrue 404 (route missing behind a misdeployed gateway)",
    {
      kind: "http",
      status: 404,
      body: "not found",
    },
    { ...UNAVAILABLE, authCalls: 1 },
  );
  authUser(
    "S18_auth_user_hang",
    "GoTrue never answers (hang until the edge deadline)",
    { kind: "hang" },
    {
      ...UNAVAILABLE,
      authCalls: 1,
      minLatencyMs: AUTH_TIMEOUT_MS - 50,
      maxLatencyMs: AUTH_TIMEOUT_MS + TIMING_SLACK_MS,
    },
  );
  authUser(
    "S19_auth_user_net_error_persistent",
    "GoTrue socket fails on every attempt",
    {
      kind: "net_error",
    },
    {
      ...UNAVAILABLE,
      authCalls: { min: 2 },
      maxLatencyMs: AUTH_TIMEOUT_MS + TIMING_SLACK_MS,
    },
  );
  cases.push({
    id: "S20_auth_user_net_error_once",
    group: "auth_user",
    title:
      "GoTrue socket fails once, then answers (edge retries inside its deadline)",
    bearer: "session",
    faults: [{ upstream: "auth_user", fault: { kind: "net_error" }, times: 1 }],
    expect: { ...ROUTE_ANSWER, authCalls: 2, minLatencyMs: 90 },
    recovery: "same_bearer",
  });
  authUser(
    "S21_auth_user_slow_within_deadline",
    "GoTrue answers after 200 ms (inside the deadline)",
    {
      kind: "latency",
      ms: 200,
    },
    { ...ROUTE_ANSWER, authCalls: 1, minLatencyMs: 195 },
  );
  authUser(
    "S22_auth_user_slow_past_deadline",
    "GoTrue answers after the deadline has passed",
    {
      kind: "latency",
      ms: AUTH_TIMEOUT_MS + 500,
    },
    {
      ...UNAVAILABLE,
      authCalls: 1,
      minLatencyMs: AUTH_TIMEOUT_MS - 50,
      maxLatencyMs: AUTH_TIMEOUT_MS + TIMING_SLACK_MS,
    },
  );
  cases.push({
    id: "S23_auth_user_500_warm_cache",
    group: "auth_user",
    title:
      "GoTrue 500 while the bearer is cached (cache must shield the request)",
    bearer: "session",
    warm: true,
    faults: [{ upstream: "auth_user", fault: { kind: "http", status: 500 } }],
    expect: { ...ROUTE_ANSWER, authCalls: 0 },
    recovery: "same_bearer",
  });
  cases.push({
    id: "S24_auth_user_500_transient",
    group: "auth_user",
    title:
      "GoTrue 500 once: the request is 503, the very next request recovers without any heal",
    bearer: "session",
    faults: [{
      upstream: "auth_user",
      fault: { kind: "http", status: 500 },
      times: 1,
    }],
    expect: { ...UNAVAILABLE, authCalls: 1 },
    recovery: "same_bearer",
    after: async (actor, h) => {
      const next = await callEdge(h, planRequest(actor, "session"));
      return {
        iterations: 1,
        problem: next.status === 409 && countAuth(next) === 1
          ? null
          : `next request (fault still installed but spent): ${next.status}, auth ${
            countAuth(next)
          }`,
      };
    },
  });

  // ── Supabase Auth: id_token grant (transitional provider bearer) ─────────
  const authToken = (
    id: string,
    title: string,
    fault: Fault,
    expect: Expect,
    extra: Partial<FaultCase> = {},
  ) =>
    cases.push({
      id,
      group: "auth_token",
      title,
      bearer: "provider",
      faults: [{ upstream: "auth_token", fault }],
      expect,
      recovery: "same_bearer",
      ...extra,
    });
  authToken(
    "P01_auth_token_500",
    "GoTrue 500 on the id_token grant (provider bearer)",
    {
      kind: "http",
      status: 500,
      body: JSON.stringify({
        code: 500,
        msg: "internal",
        error_code: "unexpected_failure",
      }),
      headers: { "Content-Type": "application/json" },
    },
    { ...UNAVAILABLE, authCalls: { min: 1 }, authFailureCharged: false },
  );
  authToken("P02_auth_token_503", "GoTrue 503 on the id_token grant", {
    kind: "http",
    status: 503,
    body: "unavailable",
  }, { ...UNAVAILABLE, authCalls: { min: 1 }, authFailureCharged: false });
  authToken(
    "P03_auth_token_200_garbage",
    "GoTrue 200 non-JSON on the id_token grant",
    {
      kind: "http",
      status: 200,
      body: "<<not json>>",
      headers: { "Content-Type": "application/json" },
    },
    { ...UNAVAILABLE, authCalls: { min: 1 }, authFailureCharged: false },
  );
  authToken(
    "P04_auth_token_200_empty_object",
    "GoTrue 200 {} on the id_token grant",
    {
      kind: "http",
      status: 200,
      body: "{}",
      headers: { "Content-Type": "application/json" },
    },
    { ...UNAVAILABLE, authCalls: { min: 1 }, authFailureCharged: false },
  );
  authToken(
    "P05_auth_token_net_error",
    "GoTrue socket fails on the id_token grant",
    {
      kind: "net_error",
    },
    {
      ...UNAVAILABLE,
      authCalls: { min: 1 },
      authFailureCharged: false,
      maxLatencyMs: AUTH_TIMEOUT_MS + TIMING_SLACK_MS,
    },
  );
  authToken(
    "P06_auth_token_hang",
    "GoTrue hangs on the id_token grant (edge must bound the wait)",
    {
      kind: "hang",
      fallbackMs: AUTH_TIMEOUT_MS + 1_500,
    },
    {
      ...UNAVAILABLE,
      authCalls: { min: 1 },
      authFailureCharged: false,
      maxLatencyMs: AUTH_TIMEOUT_MS + TIMING_SLACK_MS,
    },
  );
  authToken(
    "P07_auth_token_400_invalid_grant",
    "GoTrue refuses the ID token (400 invalid_grant)",
    {
      kind: "http",
      status: 400,
      body: JSON.stringify({
        error: "invalid_grant",
        error_description: "Bad ID token",
      }),
      headers: { "Content-Type": "application/json" },
    },
    { ...REFUSED, authCalls: 1 },
    { recovery: "fresh_session" },
  );
  cases.push({
    id: "P08_auth_token_500_warm_cache",
    group: "auth_token",
    title: "GoTrue 500 while the provider bearer is cached",
    bearer: "provider",
    warm: true,
    faults: [{ upstream: "auth_token", fault: { kind: "http", status: 500 } }],
    expect: { ...ROUTE_ANSWER, authCalls: 0 },
    recovery: "same_bearer",
  });
  authToken(
    "P09_auth_token_slow",
    "GoTrue answers the id_token grant after 300 ms",
    {
      kind: "latency",
      ms: 300,
    },
    { ...ROUTE_ANSWER, authCalls: 1, minLatencyMs: 295 },
  );

  // ── Upstash Redis (L2 cache + shared rate limits) ────────────────────────
  const redis = (
    id: string,
    title: string,
    fault: Fault,
    expect: Expect,
    extra: Partial<FaultCase> = {},
  ) =>
    cases.push({
      id,
      group: "redis",
      title,
      bearer: "session",
      faults: [{ upstream: "redis", fault }],
      expect,
      recovery: "same_bearer",
      ...extra,
    });
  redis(
    "R01_redis_500_cold",
    "Upstash HTTP 500 on every pipeline (cold bearer)",
    {
      kind: "http",
      status: 500,
    },
    { ...ROUTE_ANSWER, authCalls: 1, redisCalls: { min: 4 } },
  );
  redis(
    "R02_redis_500_warm",
    "Upstash HTTP 500 on every pipeline (bearer in L1)",
    {
      kind: "http",
      status: 500,
    },
    { ...ROUTE_ANSWER, authCalls: 0 },
    { warm: true },
  );
  redis(
    "R03_redis_hang_cold",
    "Upstash hangs until the 1.2 s cache timeout (cold bearer)",
    {
      kind: "hang",
    },
    {
      ...ROUTE_ANSWER,
      authCalls: 1,
      maxLatencyMs: 8 * REDIS_TIMEOUT_MS + AUTH_TIMEOUT_MS,
    },
  );
  redis(
    "R04_redis_hang_warm",
    "Upstash hangs until the 1.2 s cache timeout (bearer in L1)",
    {
      kind: "hang",
    },
    { ...ROUTE_ANSWER, authCalls: 0, maxLatencyMs: 8 * REDIS_TIMEOUT_MS },
    { warm: true },
  );
  redis("R05_redis_net_error", "Upstash socket fails", { kind: "net_error" }, {
    ...ROUTE_ANSWER,
    authCalls: 1,
  });
  redis("R06_redis_200_garbage", "Upstash 200 non-JSON", {
    kind: "http",
    status: 200,
    body: "<<garbage>>",
    headers: { "Content-Type": "application/json" },
  }, { ...ROUTE_ANSWER, authCalls: 1 });
  redis("R07_redis_200_object", "Upstash 200 {} (not a pipeline array)", {
    kind: "http",
    status: 200,
    body: "{}",
    headers: { "Content-Type": "application/json" },
  }, { ...ROUTE_ANSWER, authCalls: 1 });
  redis("R08_redis_401", "Upstash 401 (rotated token)", {
    kind: "http",
    status: 401,
    body: JSON.stringify({ error: "Unauthorized" }),
    headers: { "Content-Type": "application/json" },
  }, { ...ROUTE_ANSWER, authCalls: 1 });
  redis(
    "R09_redis_command_errors_cold",
    "Upstash answers every command with ERR max requests limit exceeded (cold)",
    redisCommandError(() => true),
    {
      ...ROUTE_ANSWER,
      authCalls: 1,
    },
  );
  redis(
    "R10_redis_command_errors_warm",
    "Upstash per-command errors while the bearer is in L1 (unknown ≠ hit: re-verify)",
    redisCommandError(() => true),
    {
      ...ROUTE_ANSWER,
      authCalls: 1,
    },
    { warm: true },
  );
  redis("R11_redis_short_reply", "Upstash returns an empty pipeline reply", {
    kind: "http",
    status: 200,
    body: "[]",
    headers: { "Content-Type": "application/json" },
  }, { ...ROUTE_ANSWER, authCalls: 1 });
  redis(
    "R12_redis_incr_huge",
    "Upstash INCR answers 10^9 (poisoned counter → 429 with Retry-After)",
    redisSlotOverride(
      (cmd) => String(cmd[0]).toUpperCase() === "INCR",
      1_000_000_000,
    ),
    {
      status: [429],
      code: "rate_limited",
      retryAfter: true,
      authCalls: 0,
      restCalls: 0,
      revenueCatCalls: 0,
    },
  );
  redis(
    "R13_redis_incr_string",
    "Upstash INCR answers a non-numeric string (memory fallback)",
    redisSlotOverride((cmd) => String(cmd[0]).toUpperCase() === "INCR", "abc"),
    {
      ...ROUTE_ANSWER,
      authCalls: 1,
    },
  );
  redis(
    "R14_redis_revocation_marker",
    "Upstash reports a revocation marker for the session (fenced → 401)",
    redisSlotOverride((cmd) =>
      String(cmd[0]).toUpperCase() === "GET" &&
      String(cmd[1]).startsWith("auth:revoked:"), "1"),
    {
      ...REFUSED,
      authCalls: 0,
    },
    { recovery: "fresh_session" },
  );
  redis(
    "R15_redis_corrupt_cache_row",
    "Upstash returns a corrupt auth cache row (fall through to verification)",
    redisSlotOverride((cmd) =>
      String(cmd[0]).toUpperCase() === "GET" &&
      /^auth:[0-9a-f]{64}$/.test(String(cmd[1])), "not-json"),
    {
      ...ROUTE_ANSWER,
      authCalls: 1,
    },
  );
  redis(
    "R16_redis_ttl_zero_row",
    "Upstash GET returns a row but TTL says 0 (never cached locally)",
    redisSlotOverride((cmd) => String(cmd[0]).toUpperCase() === "TTL", 0),
    {
      ...ROUTE_ANSWER,
      authCalls: 1,
    },
  );
  redis("R17_redis_slow_50ms", "Upstash answers after 50 ms per pipeline", {
    kind: "latency",
    ms: 50,
  }, {
    ...ROUTE_ANSWER,
    authCalls: 1,
    minLatencyMs: 4 * 50,
  });
  redis("R18_redis_500_every_2nd", "Upstash 500 on every 2nd pipeline", {
    kind: "http",
    status: 500,
  }, {
    ...ROUTE_ANSWER,
    authCalls: 1,
  }, {
    faults: [{
      upstream: "redis",
      fault: { kind: "http", status: 500 },
      every: 2,
    }],
  });
  redis(
    "R19_redis_500_first_only",
    "Upstash 500 on the first pipeline only (per-IP budget)",
    { kind: "http", status: 500 },
    {
      ...ROUTE_ANSWER,
      authCalls: 1,
    },
    {
      faults: [{
        upstream: "redis",
        fault: { kind: "http", status: 500 },
        times: 1,
      }],
    },
  );
  redis(
    "R20_redis_ttl_minus2_warm",
    "Upstash TTL -2 for a bearer in L1 (another isolate deleted it → re-verify)",
    redisSlotOverride((cmd) => String(cmd[0]).toUpperCase() === "TTL", -2),
    {
      ...ROUTE_ANSWER,
      authCalls: 1,
    },
    { warm: true },
  );
  redis(
    "R21_redis_set_refused_then_l1_only",
    "Upstash refuses SET: row lives in L1 only and is still served next time",
    redisCommandError(
      (cmd) => String(cmd[0]).toUpperCase() === "SET",
      "ERR OOM command not allowed when used memory > 'maxmemory'",
    ),
    {
      ...ROUTE_ANSWER,
      authCalls: 1,
    },
    {
      after: async (actor, h) => {
        const next = await callEdge(h, planRequest(actor, "session"));
        return {
          iterations: 1,
          problem: next.status === 409 && countAuth(next) === 0
            ? null
            : `second request with SET still refused: ${next.status}, auth ${
              countAuth(next)
            } (L1-only row not served)`,
        };
      },
    },
  );
  redis(
    "R22_redis_hang_first_only",
    "Upstash hangs on the first pipeline only",
    { kind: "hang" },
    {
      ...ROUTE_ANSWER,
      authCalls: 1,
      minLatencyMs: REDIS_TIMEOUT_MS - 50,
      maxLatencyMs: REDIS_TIMEOUT_MS + AUTH_TIMEOUT_MS,
    },
    { faults: [{ upstream: "redis", fault: { kind: "hang" }, times: 1 }] },
  );

  // ── PostgREST and RevenueCat: the route must never need them ─────────────
  const untouched = (
    group: "rest" | "revenuecat",
    id: string,
    title: string,
    fault: Fault,
  ) =>
    cases.push({
      id,
      group,
      title,
      bearer: "session",
      faults: [{ upstream: group, fault }],
      expect: { ...ROUTE_ANSWER, authCalls: 1, maxLatencyMs: 500 },
      recovery: "same_bearer",
    });
  untouched("rest", "D01_rest_500", "PostgREST 500", {
    kind: "http",
    status: 500,
  });
  untouched("rest", "D02_rest_hang", "PostgREST hangs", {
    kind: "hang",
    fallbackMs: 3_000,
  });
  untouched("rest", "D03_rest_garbage", "PostgREST 200 non-JSON", {
    kind: "http",
    status: 200,
    body: "<<garbage>>",
  });
  untouched("rest", "D04_rest_net_error", "PostgREST socket fails", {
    kind: "net_error",
  });
  untouched("revenuecat", "C01_revenuecat_500", "RevenueCat 500", {
    kind: "http",
    status: 500,
  });
  untouched("revenuecat", "C02_revenuecat_hang", "RevenueCat hangs", {
    kind: "hang",
    fallbackMs: 3_000,
  });
  untouched("revenuecat", "C03_revenuecat_garbage", "RevenueCat 200 non-JSON", {
    kind: "http",
    status: 200,
    body: "<<garbage>>",
  });

  // ── Compound outages ─────────────────────────────────────────────────────
  cases.push({
    id: "X01_auth_and_redis_down_cold",
    group: "compound",
    title: "GoTrue 500 + Upstash 500 (cold bearer)",
    bearer: "session",
    faults: [
      { upstream: "auth_user", fault: { kind: "http", status: 500 } },
      { upstream: "redis", fault: { kind: "http", status: 500 } },
    ],
    expect: { ...UNAVAILABLE, authCalls: 1 },
    recovery: "same_bearer",
  });
  cases.push({
    id: "X02_auth_and_redis_down_warm",
    group: "compound",
    title: "GoTrue 500 + Upstash 500 while the bearer is in L1",
    bearer: "session",
    warm: true,
    faults: [
      { upstream: "auth_user", fault: { kind: "http", status: 500 } },
      { upstream: "redis", fault: { kind: "http", status: 500 } },
    ],
    expect: { ...ROUTE_ANSWER, authCalls: 0 },
    recovery: "same_bearer",
  });
  cases.push({
    id: "X03_everything_hangs_cold",
    group: "compound",
    title:
      "GoTrue and Upstash both hang (cold bearer): total wait must stay bounded",
    bearer: "session",
    faults: [
      { upstream: "auth_user", fault: { kind: "hang" } },
      { upstream: "redis", fault: { kind: "hang" } },
    ],
    expect: {
      ...UNAVAILABLE,
      authCalls: 1,
      maxLatencyMs: 8 * REDIS_TIMEOUT_MS + AUTH_TIMEOUT_MS + TIMING_SLACK_MS,
    },
    recovery: "same_bearer",
  });
  cases.push({
    id: "X04_all_side_upstreams_down_warm",
    group: "compound",
    title: "Upstash + PostgREST + RevenueCat 500 while the bearer is in L1",
    bearer: "session",
    warm: true,
    faults: [
      { upstream: "redis", fault: { kind: "http", status: 500 } },
      { upstream: "rest", fault: { kind: "http", status: 500 } },
      { upstream: "revenuecat", fault: { kind: "http", status: 500 } },
    ],
    expect: { ...ROUTE_ANSWER, authCalls: 0 },
    recovery: "same_bearer",
  });
  cases.push({
    id: "X05_provider_bearer_auth_and_redis_down",
    group: "compound",
    title: "GoTrue 500 + Upstash 500 with a cold provider bearer",
    bearer: "provider",
    faults: [
      { upstream: "auth_token", fault: { kind: "http", status: 500 } },
      { upstream: "redis", fault: { kind: "http", status: 500 } },
    ],
    expect: {
      ...UNAVAILABLE,
      authCalls: { min: 1 },
      authFailureCharged: false,
    },
    recovery: "same_bearer",
  });

  // ── Client-shape faults (no upstream fault) ──────────────────────────────
  const client = (
    id: string,
    title: string,
    request: FaultCase["request"],
    expect: Expect,
    recovery: FaultCase["recovery"] = "same_bearer",
    also?: FaultCase["also"],
  ) =>
    cases.push({
      id,
      group: "client",
      title,
      bearer: "session",
      faults: [],
      request,
      expect,
      recovery,
      also,
    });
  client(
    "Q01_no_bearer",
    "No Authorization header",
    (actor) =>
      edgeRequest("POST", ROUTE, { token: null, ip: actor.ip, body: {} }),
    {
      ...REFUSED,
      authCalls: 0,
    },
  );
  client(
    "Q02_garbage_bearer",
    "Bearer is not a JWT",
    (actor) =>
      edgeRequest("POST", ROUTE, {
        token: "not-a-jwt",
        ip: actor.ip,
        body: {},
      }),
    {
      ...REFUSED,
      authCalls: 0,
    },
  );
  client(
    "Q03_expired_session_token",
    "Expired Supabase access token (refused without an Auth round trip)",
    (actor, h) => {
      const dead = h.mintSession(actor.userId, -120);
      return edgeRequest("POST", ROUTE, {
        token: dead.accessToken,
        ip: actor.ip,
        body: {},
      });
    },
    { ...REFUSED, authCalls: 0 },
  );
  client(
    "Q04_expired_provider_token",
    "Expired provider ID token (refused without an Auth round trip)",
    (actor, _h, r) =>
      edgeRequest("POST", ROUTE, {
        token: providerIdToken(actor.provider, actor.userId, r, -120),
        ip: actor.ip,
        body: {},
      }),
    { ...REFUSED, authCalls: 0 },
  );
  client(
    "Q05_forged_session_token",
    "Supabase-shaped token GoTrue never issued",
    (actor, _h, r) =>
      edgeRequest("POST", ROUTE, {
        token: fakeJwt(
          {
            iss: `${SUPABASE_URL}/auth/v1`,
            sub: actor.userId,
            aud: "authenticated",
            role: "authenticated",
            session_id: r.uuid(),
            exp: Math.floor(Date.now() / 1000) + 3600,
          },
          r.hex(16),
        ),
        ip: actor.ip,
        body: {},
      }),
    { ...REFUSED, authCalls: 1 },
  );
  client(
    "Q06_content_length_over_cap",
    "Content-Length above the 5 MB body cap",
    (actor) =>
      edgeRequest("POST", ROUTE, {
        token: actor.sessionToken,
        ip: actor.ip,
        rawBody: "{}",
        headers: { "content-length": "5000001" },
      }),
    {
      status: [413],
      code: null,
      authCalls: 0,
      restCalls: 0,
      revenueCatCalls: 0,
    },
  );
  client(
    "Q07_body_invalid_json",
    "Body is not JSON (route never reads it)",
    (actor) =>
      edgeRequest("POST", ROUTE, {
        token: actor.sessionToken,
        ip: actor.ip,
        rawBody: "{not json",
      }),
    {
      ...ROUTE_ANSWER,
      authCalls: 1,
    },
  );
  client(
    "Q08_body_100kb",
    "100 KB JSON body",
    (actor) =>
      edgeRequest("POST", ROUTE, {
        token: actor.sessionToken,
        ip: actor.ip,
        body: { sourceShotId: "x".repeat(100_000) },
      }),
    { ...ROUTE_ANSWER, authCalls: 1 },
  );
  client(
    "Q09_wrong_method",
    "GET on the POST-only route",
    (actor) =>
      edgeRequest("GET", ROUTE, { token: actor.sessionToken, ip: actor.ip }),
    {
      status: [404],
      code: null,
      authCalls: 1,
      restCalls: 0,
      revenueCatCalls: 0,
    },
  );
  client(
    "Q10_gateway_prefix_variant",
    "Gateway strips the mount prefix (/api/v1/…)",
    (actor) =>
      new Request("http://edge.stress.test/api/v1/training-plans", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${actor.sessionToken}`,
          "x-forwarded-for": actor.ip,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    { ...ROUTE_ANSWER, authCalls: 1 },
  );
  client(
    "Q11_trailing_slash",
    "Trailing slash is a different (unknown) route",
    (actor) =>
      edgeRequest("POST", `${ROUTE}/`, {
        token: actor.sessionToken,
        ip: actor.ip,
        body: {},
      }),
    {
      status: [404],
      code: null,
      authCalls: 1,
      restCalls: 0,
      revenueCatCalls: 0,
    },
  );
  client(
    "Q12_logged_out_session",
    "Access token of a session GoTrue has revoked",
    (actor, h) => {
      const session = h.sessions.get(actor.sessionToken);
      if (session) session.revoked = true;
      return edgeRequest("POST", ROUTE, {
        token: actor.sessionToken,
        ip: actor.ip,
        body: {},
      });
    },
    { ...REFUSED, authCalls: 1 },
    "fresh_session",
  );
  client(
    "Q13_spoofed_forwarded_for",
    "Client-controlled leftmost X-Forwarded-For hop is ignored",
    (actor) =>
      edgeRequest("POST", ROUTE, {
        token: actor.sessionToken,
        ip: `1.1.1.1, ${actor.ip}`,
        body: {},
      }),
    { ...ROUTE_ANSWER, authCalls: 1 },
    "same_bearer",
    (_answer, h, before) => {
      // The per-IP budget must be keyed by the proxy-appended hop, never by
      // the hop the client wrote itself.
      const ipKeys = h
        .callsSince(before)
        .filter((call) => call.upstream === "redis" && Array.isArray(call.body))
        .flatMap((call) => call.body as unknown[])
        .filter((cmd): cmd is Array<string | number> =>
          Array.isArray(cmd) && cmd[0] === "INCR" &&
          String(cmd[1]).startsWith("rl:ip:")
        )
        .map((cmd) => String(cmd[1]));
      if (ipKeys.length !== 1) {
        return `expected one rl:ip INCR, saw ${ipKeys.length}`;
      }
      if (ipKeys[0].includes("1.1.1.1")) {
        return `rate limit keyed by spoofed hop: ${ipKeys[0]}`;
      }
      return null;
    },
  );
  client(
    "Q14_no_content_type",
    "No Content-Type on the POST",
    (actor) =>
      edgeRequest("POST", ROUTE, {
        token: actor.sessionToken,
        ip: actor.ip,
        rawBody: "{}",
        headers: { "Content-Type": "text/plain" },
      }),
    { ...ROUTE_ANSWER, authCalls: 1 },
  );

  // ── Budgets ──────────────────────────────────────────────────────────────
  cases.push({
    id: "L01_user_budget_exhausted",
    group: "budget",
    title: "241st request in the minute for one user → 429 with Retry-After",
    bearer: "session",
    faults: [],
    prepare: async (actor, h) => {
      for (let i = 0; i < 240; i += 1) {
        const answer = await callEdge(h, planRequest(actor, "session"));
        if (answer.status !== 409) {
          throw new Error(`warm-up ${i}: status ${answer.status}`);
        }
      }
      return 240;
    },
    expect: {
      status: [429],
      code: "rate_limited",
      retryAfter: true,
      authCalls: 0,
      restCalls: 0,
      revenueCatCalls: 0,
    },
    recovery: "other_actor",
    also: (answer) =>
      answer.headers["ratelimit-limit"] === "240" &&
        answer.headers["ratelimit-remaining"] === "0"
        ? null
        : `RateLimit headers ${JSON.stringify(answer.headers)}`,
  });
  cases.push({
    id: "L02_auth_failure_budget",
    group: "budget",
    title:
      "30 bad bearers from one IP → the 31st request is 429 before Auth is consulted",
    bearer: "session",
    faults: [],
    prepare: async (actor, h) => {
      for (let i = 0; i < 30; i += 1) {
        const answer = await callEdge(
          h,
          edgeRequest("POST", ROUTE, {
            token: `garbage-${i}`,
            ip: actor.ip,
            body: {},
          }),
        );
        if (answer.status !== 401) {
          throw new Error(`bad bearer ${i}: status ${answer.status}`);
        }
      }
      return 30;
    },
    expect: {
      status: [429],
      code: "rate_limited",
      retryAfter: true,
      authCalls: 0,
      restCalls: 0,
      revenueCatCalls: 0,
    },
    recovery: "other_actor",
  });
  cases.push({
    id: "L03_ip_budget_exhausted",
    group: "budget",
    title: "1201st request in the minute from one IP → 429",
    bearer: "session",
    faults: [],
    prepare: async (actor, h, r) => {
      // 1200 requests from the IP across 6 users so no user budget trips first.
      const actors = Array.from(
        { length: 6 },
        () => ({ ...mintActor(h, r), ip: actor.ip }),
      );
      for (let i = 0; i < 1200; i += 1) {
        const answer = await callEdge(h, planRequest(actors[i % 6], "session"));
        if (answer.status !== 409) {
          throw new Error(`ip warm-up ${i}: status ${answer.status}`);
        }
      }
      return 1200;
    },
    expect: {
      status: [429],
      code: "rate_limited",
      retryAfter: true,
      authCalls: 0,
      restCalls: 0,
      revenueCatCalls: 0,
    },
    recovery: "other_actor",
  });

  return cases;
}

interface CaseResult {
  id: string;
  group: string;
  title: string;
  seed: number;
  replay: string;
  bearer: Bearer;
  warm: boolean;
  faults: Array<
    { upstream: string; fault: string; times?: number; every?: number }
  >;
  iterations: number;
  status: number;
  errorCode: string | null;
  errorMessage: string | null;
  retryAfter: string | null;
  latencyMs: number;
  authCalls: number;
  redisCalls: number;
  restCalls: number;
  revenueCatCalls: number;
  supabaseRoundTrips: number;
  mobileVerdict: string;
  expected: Expect;
  checks: Check[];
  recovery: {
    mode: string;
    status: number | null;
    code: string | null;
    pass: boolean;
  };
  verdict: "HELD" | "BROKEN";
}

function countAuth(answer: EdgeAnswer): number {
  return answer.calls.filter((c) =>
    c.upstream === "auth_user" || c.upstream === "auth_token"
  ).length;
}

function authFailureCharged(
  h: StressHarness,
  before: number,
): boolean {
  // The auth-failure budget is charged with INCR rl:authfail:<bucket>:<ip>.
  return h
    .callsSince(before)
    .some(
      (call) =>
        call.upstream === "redis" &&
        Array.isArray(call.body) &&
        (call.body as unknown[]).some(
          (cmd) =>
            Array.isArray(cmd) && String(cmd[0]).toUpperCase() === "INCR" &&
            String(cmd[1]).startsWith("rl:authfail:"),
        ),
    );
}

function within(
  actual: number,
  expected: number | { min?: number; max?: number } | undefined,
): boolean {
  if (expected === undefined) return true;
  if (typeof expected === "number") return actual === expected;
  if (expected.min !== undefined && actual < expected.min) return false;
  if (expected.max !== undefined && actual > expected.max) return false;
  return true;
}

async function runCase(h: StressHarness, fc: FaultCase): Promise<CaseResult> {
  const seed = seedFor(fc.id, BASE_SEED);
  const r = rng(seed);
  h.heal();
  h.reset(true);
  const actor = mintActor(h, r, r.pick(["google", "apple"] as const));
  let iterations = 0;
  const checks: Check[] = [];

  if (fc.warm) {
    const warm = await callEdge(h, planRequest(actor, fc.bearer));
    iterations += 1;
    checks.push({
      name: "warm_up_409",
      pass: warm.status === 409 && warm.errorCode === EXPECTED_CODE,
      detail: `status ${warm.status}`,
    });
  }
  if (fc.prepare) iterations += await fc.prepare(actor, h, r);

  for (const f of fc.faults) {
    h.inject(f.upstream, f.fault, { times: f.times, every: f.every });
  }
  const before = h.lastSeq();
  const request = fc.request
    ? fc.request(actor, h, r)
    : planRequest(actor, fc.bearer);
  const answer = await callEdge(h, request);
  iterations += 1;

  checks.push(...invariantChecks(answer, h.accessLog));
  checks.push({
    name: "status_class",
    pass: fc.expect.status.includes(answer.status),
    detail: `status ${answer.status} ∉ ${JSON.stringify(fc.expect.status)}`,
  });
  if (fc.expect.code !== undefined) {
    checks.push({
      name: "error_code",
      pass: answer.errorCode === fc.expect.code,
      detail: `code ${answer.errorCode} ≠ ${fc.expect.code}`,
    });
  }
  if (fc.expect.retryAfter) {
    const ra = Number(answer.headers["retry-after"]);
    checks.push({
      name: "retry_after_header",
      pass: Number.isInteger(ra) && ra > 0,
      detail: `Retry-After ${answer.headers["retry-after"]}`,
    });
  }
  if (fc.expect.maxLatencyMs !== undefined) {
    checks.push({
      name: "latency_bounded",
      pass: answer.latencyMs <= fc.expect.maxLatencyMs,
      detail: `${answer.latencyMs} ms > ${fc.expect.maxLatencyMs} ms`,
    });
  }
  if (fc.expect.minLatencyMs !== undefined) {
    checks.push({
      name: "latency_waited",
      pass: answer.latencyMs >= fc.expect.minLatencyMs,
      detail: `${answer.latencyMs} ms < ${fc.expect.minLatencyMs} ms`,
    });
  }
  const authCalls = countAuth(answer);
  const redisCalls = answer.redisRoundTrips;
  const restCalls = answer.calls.filter((c) => c.upstream === "rest").length;
  const rcCalls =
    answer.calls.filter((c) => c.upstream === "revenuecat").length;
  checks.push({
    name: "auth_round_trips",
    pass: within(authCalls, fc.expect.authCalls),
    detail: `${authCalls} vs ${JSON.stringify(fc.expect.authCalls)}`,
  });
  checks.push({
    name: "redis_round_trips",
    pass: within(redisCalls, fc.expect.redisCalls),
    detail: `${redisCalls} vs ${JSON.stringify(fc.expect.redisCalls)}`,
  });
  checks.push({
    name: "postgrest_untouched",
    pass: within(restCalls, fc.expect.restCalls),
    detail: `${restCalls}`,
  });
  checks.push({
    name: "revenuecat_untouched",
    pass: within(rcCalls, fc.expect.revenueCatCalls),
    detail: `${rcCalls}`,
  });
  if (fc.expect.authFailureCharged !== undefined) {
    const charged = authFailureCharged(h, before);
    checks.push({
      name: "auth_failure_budget",
      pass: charged === fc.expect.authFailureCharged,
      detail: `charged=${charged} expected=${fc.expect.authFailureCharged}`,
    });
  }
  if (fc.also) {
    const problem = fc.also(answer, h, before);
    checks.push({
      name: "case_specific",
      pass: problem === null,
      detail: problem ?? undefined,
    });
  }
  if (fc.after) {
    const followUp = await fc.after(actor, h);
    iterations += followUp.iterations;
    checks.push({
      name: "follow_up_under_fault",
      pass: followUp.problem === null,
      detail: followUp.problem ?? undefined,
    });
  }

  // Recoverability: heal every fault and prove the actor gets the route's
  // answer again (with the same bearer, a fresh session, or as someone else).
  h.heal();
  let recovery: CaseResult["recovery"] = {
    mode: fc.recovery,
    status: null,
    code: null,
    pass: true,
  };
  if (fc.recovery !== "none") {
    let recoverRequest: Request;
    if (fc.recovery === "same_bearer") {
      recoverRequest = planRequest(actor, fc.bearer);
    } else if (fc.recovery === "fresh_session") {
      const fresh = h.mintSession(actor.userId);
      recoverRequest = edgeRequest("POST", ROUTE, {
        token: fresh.accessToken,
        ip: actor.ip,
        body: {},
      });
    } else {
      const other = mintActor(h, r);
      recoverRequest = planRequest(other, "session");
    }
    const recovered = await callEdge(h, recoverRequest);
    iterations += 1;
    recovery = {
      mode: fc.recovery,
      status: recovered.status,
      code: recovered.errorCode,
      pass: recovered.status === 409 && recovered.errorCode === EXPECTED_CODE,
    };
    checks.push({
      name: "recovers_after_heal",
      pass: recovery.pass,
      detail: `status ${recovered.status} code ${recovered.errorCode}`,
    });
  }

  return {
    id: fc.id,
    group: fc.group,
    title: fc.title,
    seed,
    replay:
      `STRESS_SEED=${BASE_SEED} STRESS_CASE=${fc.id} deno test -A --no-check --config deno.json stress_training_plans_failure_load.test.ts --filter faults`,
    bearer: fc.bearer,
    warm: Boolean(fc.warm),
    faults: fc.faults.map((f) => ({
      upstream: f.upstream,
      fault: f.fault.kind === "http"
        ? `http ${f.fault.status}`
        : f.fault.kind === "latency"
        ? `latency ${f.fault.ms}ms`
        : f.fault.kind,
      times: f.times,
      every: f.every,
    })),
    iterations,
    status: answer.status,
    errorCode: answer.errorCode,
    errorMessage: answer.errorMessage,
    retryAfter: answer.headers["retry-after"] ?? null,
    latencyMs: answer.latencyMs,
    authCalls,
    redisCalls,
    restCalls,
    revenueCatCalls: rcCalls,
    supabaseRoundTrips: answer.supabaseRoundTrips,
    mobileVerdict: mobileVerdict(answer),
    expected: fc.expect,
    checks,
    recovery,
    verdict: checks.every((c) => c.pass) ? "HELD" : "BROKEN",
  };
}

/** Cases whose faulted call is the transitional provider-bearer exchange
 * (`signInWithIdToken` in authenticate()). They are run as their own test so
 * the session-bearer contract and this legacy path are judged separately. */
const isProviderExchangeCase = (fc: FaultCase): boolean =>
  fc.bearer === "provider" &&
  fc.faults.some((f) => f.upstream === "auth_token");

/** Every campaign hands the process back exactly as it found it (fetch,
 * Deno.serve, access-log sink, env) — the suite runs the other edge files
 * after this one in the same process environment. */
function stressTest(
  name: string,
  body: (h: StressHarness) => Promise<void>,
): void {
  Deno.test(name, async () => {
    const h = await loadStressHarness();
    try {
      await body(h);
    } finally {
      h.heal();
      h.restore();
    }
  });
}

async function runFaultCampaign(
  h: StressHarness,
  name: string,
  select: (fc: FaultCase) => boolean,
  minimumCases: number,
): Promise<void> {
  const only = Deno.env.get("STRESS_CASE");
  const cases = buildCases().filter(select).filter((c) =>
    !only || c.id === only
  );
  if (only && cases.length === 0) return; // the case belongs to the other campaign
  assert(
    cases.length >= (only ? 1 : minimumCases),
    `only ${cases.length} fault cases`,
  );

  const wallStart = performance.now();
  const results: CaseResult[] = [];
  for (const fc of cases) results.push(await runCase(h, fc));
  const wallMs = Math.round(performance.now() - wallStart);
  h.heal();

  const broken = results.filter((r) => r.verdict === "BROKEN");
  const report = {
    ...reportMeta(name),
    totals: {
      cases: results.length,
      held: results.length - broken.length,
      broken: broken.length,
      iterations: results.reduce((sum, r) => sum + r.iterations, 0),
    },
    wallMs,
    broken: broken.map((r) => ({
      id: r.id,
      seed: r.seed,
      replay: r.replay,
      status: r.status,
      mobileVerdict: r.mobileVerdict,
      failedChecks: r.checks.filter((c) => !c.pass),
    })),
    cases: results,
  };
  const path = await writeReport(name, report);
  console.log(`[stress training-plans] ${name} → ${path}`);
  console.table(
    results.map((r) => ({
      id: r.id,
      status: r.status,
      code: r.errorCode ?? "",
      ms: r.latencyMs,
      auth: r.authCalls,
      redis: r.redisCalls,
      mobile: r.mobileVerdict,
      recover: r.recovery.status ?? "-",
      verdict: r.verdict,
    })),
  );

  assertEquals(
    broken.map(
      (r) =>
        `${r.id} (seed ${r.seed}): status ${r.status} → ${r.mobileVerdict}; failed ${
          r.checks.filter((c) => !c.pass).map((c) =>
            `${c.name}[${c.detail ?? ""}]`
          ).join(", ")
        }`,
    ),
    [],
    `${broken.length} fault case(s) BROKEN — see ${path}`,
  );
}

stressTest(
  "stress training-plans faults: session bearer — GoTrue/Upstash/PostgREST/RevenueCat fail, hang or answer malformed in turn (≥40 cases)",
  (h) => runFaultCampaign(h, "faults", (fc) => !isProviderExchangeCase(fc), 40),
);

// The transitional provider-bearer branch of authenticate() (index.ts, the
// `if (provider)` block after the cache read) folds every signInWithIdToken
// failure — GoTrue 5xx, socket error, malformed body, hang — into
// 401 "The identity token could not be verified.", which the app treats as a
// refused credential (sign-out) and which charges the per-IP auth-failure
// budget. The gateway comment above verifyAccessToken() documents why that
// is wrong for session bearers; the same contract (503 + Retry-After for
// `unavailable`, 401 only for `refused`) is asserted here for the legacy
// bearer. This test is RED on the commit it was written against by design:
// it is the reproduction for that finding.
stressTest(
  "stress training-plans faults: transitional provider bearer — GoTrue outages must be 503, not 401 sign-outs",
  (h) => runFaultCampaign(h, "faults-provider", isProviderExchangeCase, 6),
);

// ─── Campaign 2: load ────────────────────────────────────────────────────────

stressTest(
  "stress training-plans load: ≥1000 requests — p50/p95 latency, Supabase round trips per request ≤ 3",
  async (h) => {
    const r = rng(seedFor("load", BASE_SEED));
    const iterations = Math.max(1, STRESS_ITER);
    // Pool sized so no per-user (240/min) or per-IP (1200/min) budget trips.
    const poolSize = Math.max(8, Math.ceil(iterations / 100));
    const pool: Actor[] = Array.from(
      { length: poolSize },
      () => mintActor(h, r, r.pick(["google", "apple"] as const)),
    );
    const ips = Array.from(
      { length: Math.max(4, Math.ceil(iterations / 400)) },
      () => seededIp(r),
    );

    interface Sample {
      i: number;
      seed: number;
      actor: number;
      bearer: Bearer;
      status: number;
      code: string | null;
      latencyMs: number;
      supabase: number;
      redis: number;
      cold: boolean;
    }
    const samples: Sample[] = [];
    const seen = new Set<string>();
    const seqStart = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      const iterSeed = seedFor(`load:${i}`, BASE_SEED);
      const ir = rng(iterSeed);
      const actorIndex = ir.int(pool.length);
      const actor = { ...pool[actorIndex], ip: ips[ir.int(ips.length)] };
      const bearer: Bearer = ir.next() < 0.7 ? "session" : "provider";
      const key = `${actorIndex}:${bearer}`;
      const cold = !seen.has(key);
      seen.add(key);
      const answer = await callEdge(h, planRequest(actor, bearer));
      samples.push({
        i,
        seed: iterSeed,
        actor: actorIndex,
        bearer,
        status: answer.status,
        code: answer.errorCode,
        latencyMs: answer.latencyMs,
        supabase: answer.supabaseRoundTrips,
        redis: answer.redisRoundTrips,
        cold,
      });
    }
    const seqWallMs = Math.round(performance.now() - seqStart);

    const sorted = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
    const warm = samples.filter((s) => !s.cold);
    const warmSorted = warm.map((s) => s.latencyMs).sort((a, b) => a - b);
    const histogram = (values: number[]) => {
      const out: Record<string, number> = {};
      for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
      return out;
    };
    const failures = samples.filter((s) =>
      s.status !== 409 || s.code !== EXPECTED_CODE
    );
    const overBudget = samples.filter((s) => s.supabase > 3);
    const warmWithAuth = warm.filter((s) => s.supabase > 0);

    // Concurrent burst: the same pool, `iterations` requests in waves of 100.
    h.reset();
    const burstStart = performance.now();
    const burstStatuses: number[] = [];
    const burstLatencies: number[] = [];
    for (let wave = 0; wave < Math.ceil(iterations / 100); wave += 1) {
      const size = Math.min(100, iterations - wave * 100);
      const answers = await Promise.all(
        Array.from({ length: size }, (_, k) => {
          const ir = rng(seedFor(`burst:${wave}:${k}`, BASE_SEED));
          const actor = {
            ...pool[ir.int(pool.length)],
            ip: ips[ir.int(ips.length)],
          };
          return callEdge(
            h,
            planRequest(actor, ir.next() < 0.7 ? "session" : "provider"),
          );
        }),
      );
      for (const a of answers) {
        burstStatuses.push(a.status);
        burstLatencies.push(a.latencyMs);
      }
    }
    const burstWallMs = Math.round(performance.now() - burstStart);
    const burstSupabase = h.calls.filter(
      (c) =>
        c.upstream === "auth_user" || c.upstream === "auth_token" ||
        c.upstream === "rest",
    ).length;
    const burstRedis = h.callsTo("redis").length;
    burstLatencies.sort((a, b) => a - b);

    // Cold-cache stampede: 20 concurrent first requests for ONE new session.
    h.reset();
    const stampedeActor = mintActor(h, r);
    const stampede = await Promise.all(
      Array.from(
        { length: 20 },
        () => callEdge(h, planRequest(stampedeActor, "session")),
      ),
    );
    const stampedeAuthCalls = h.callsTo("auth_user").length;

    const report = {
      ...reportMeta("load"),
      iterations,
      poolSize,
      ips: ips.length,
      sequential: {
        wallMs: seqWallMs,
        requestsPerSecond: Math.round((iterations / seqWallMs) * 1000),
        latencyMs: {
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          p99: percentile(sorted, 99),
          max: sorted[sorted.length - 1],
          warmP50: percentile(warmSorted, 50),
          warmP95: percentile(warmSorted, 95),
        },
        supabaseRoundTripsPerRequest: histogram(samples.map((s) => s.supabase)),
        redisRoundTripsPerRequest: histogram(samples.map((s) => s.redis)),
        supabaseRoundTripsWarmMax: Math.max(0, ...warm.map((s) => s.supabase)),
        supabaseRoundTripsColdMax: Math.max(
          0,
          ...samples.filter((s) => s.cold).map((s) => s.supabase),
        ),
        statuses: histogram(samples.map((s) => s.status)),
        coldRequests: samples.filter((s) => s.cold).length,
        warmRequestsThatStillHitAuth: warmWithAuth.length,
      },
      burst: {
        wallMs: burstWallMs,
        requestsPerSecond: Math.round((iterations / burstWallMs) * 1000),
        statuses: histogram(burstStatuses),
        latencyMs: {
          p50: percentile(burstLatencies, 50),
          p95: percentile(burstLatencies, 95),
          max: burstLatencies[burstLatencies.length - 1],
        },
        supabaseRoundTripsTotal: burstSupabase,
        redisRoundTripsTotal: burstRedis,
      },
      stampede: {
        concurrentColdRequests: stampede.length,
        statuses: histogram(stampede.map((a) => a.status)),
        authRoundTrips: stampedeAuthCalls,
        note:
          "GET /auth/v1/user calls for ONE brand-new session hit by 20 concurrent requests (1 = single-flight; 20 = every request verifies)",
      },
      failures: failures.map((s) => ({
        ...s,
        replay: `STRESS_SEED=${BASE_SEED} STRESS_ITER=${
          s.i + 1
        } deno test -A --no-check --config deno.json stress_training_plans_failure_load.test.ts --filter load`,
      })),
      overBudget: overBudget.map((s) => ({
        i: s.i,
        seed: s.seed,
        supabase: s.supabase,
      })),
      samples,
    };
    const path = await writeReport("load", report);
    console.log(`[stress training-plans] load → ${path}`);
    console.log(
      JSON.stringify(
        {
          sequential: report.sequential,
          burst: report.burst,
          stampede: report.stampede,
        },
        null,
        2,
      ),
    );

    assertEquals(
      failures.map((s) => `#${s.i} seed ${s.seed}: ${s.status} ${s.code}`),
      [],
      `${failures.length} request(s) did not get the route's answer — see ${path}`,
    );
    assertEquals(
      overBudget.map((s) => `#${s.i}: ${s.supabase} Supabase round trips`),
      [],
      `hot path made >3 Supabase round trips — see ${path}`,
    );
    assertEquals(
      warmWithAuth.map((s) => `#${s.i} actor ${s.actor} ${s.bearer}`),
      [],
      `warm requests still consulted Supabase Auth — see ${path}`,
    );
    assertEquals(
      burstStatuses.filter((s) => s !== 409).length,
      0,
      `burst: ${burstStatuses.filter((s) => s !== 409).length} non-409 answers`,
    );
    assertEquals(
      stampede.filter((a) => a.status !== 409).length,
      0,
      "stampede: every concurrent cold request must still get the route's answer",
    );
  },
);

// ─── Campaign 3: L1 cache memory under distinct users ────────────────────────

stressTest(
  "stress training-plans memory: L1 caches under STRESS_USERS distinct users (20k for the full campaign)",
  async (h) => {
    const r = rng(seedFor("memory", BASE_SEED));
    const users = Math.max(100, STRESS_USERS);
    const gc = (globalThis as { gc?: () => void }).gc;
    const heap = () => {
      gc?.();
      return Deno.memoryUsage();
    };

    // Every upstream call arms an AbortSignal.timeout (Auth deadline, Redis
    // 1 200 ms); until those timers fire they pin their request closures, so a
    // tight retention figure needs them drained first.
    const drainDeadlines = () =>
      new Promise<void>((resolve) =>
        setTimeout(resolve, REDIS_TIMEOUT_MS + AUTH_TIMEOUT_MS + 200)
      );

    const heapBefore = heap();
    const tokens: string[] = [];
    const ips = Array.from(
      { length: Math.ceil(users / 1000) + 1 },
      () => seededIp(r),
    );
    let iterations = 0;
    const statuses: Record<string, number> = {};
    let authCalls = 0;
    const distinctStart = performance.now();
    for (let i = 0; i < users; i += 1) {
      const ur = rng(seedFor(`memory:user:${i}`, BASE_SEED));
      const userId = ur.uuid();
      h.registerUser({
        id: userId,
        email: `${userId.slice(0, 8)}@example.com`,
        provider: "google",
      });
      const session = h.mintSession(userId);
      tokens.push(session.accessToken);
      const answer = await callEdge(
        h,
        edgeRequest("POST", ROUTE, {
          token: session.accessToken,
          ip: ips[i % ips.length],
          body: {},
        }),
      );
      iterations += 1;
      statuses[String(answer.status)] = (statuses[String(answer.status)] ?? 0) +
        1;
      authCalls += countAuth(answer);
      if (i % 5000 === 4999) h.reset(); // keep the recorded-call log bounded
    }
    const distinctWallMs = Math.round(performance.now() - distinctStart);
    h.reset();
    // Upper bound: the edge's caches PLUS the harness's own L2 emulation
    // (20k fake users, sessions and Redis rows) and the token list.
    const heapAfter = heap();

    // L1 residency: an L1 hit issues a 2-command pipeline (GET marker, TTL); an
    // L1 miss a 3-command one (GET marker, GET row, TTL). cache.ts caps L1 at
    // 5 000 rows and drops the oldest third when full, so the earliest users
    // must be gone and the latest present.
    const probe = async (
      index: number,
    ): Promise<"l1_hit" | "l1_miss" | "other"> => {
      const before = h.lastSeq();
      const answer = await callEdge(
        h,
        edgeRequest("POST", ROUTE, {
          token: tokens[index],
          ip: ips[index % ips.length],
          body: {},
        }),
      );
      iterations += 1;
      if (answer.status !== 409) return "other";
      const cachePipeline = h
        .callsSince(before)
        .find(
          (call) =>
            call.upstream === "redis" &&
            Array.isArray(call.body) &&
            (call.body as unknown[]).some(
              (cmd) =>
                Array.isArray(cmd) &&
                String(cmd[1]).startsWith("auth:revoked:"),
            ),
        );
      const commands = Array.isArray(cachePipeline?.body)
        ? (cachePipeline.body as unknown[]).length
        : 0;
      return commands === 2 ? "l1_hit" : commands === 3 ? "l1_miss" : "other";
    };
    const sampleCount = Math.min(100, Math.floor(users / 10));
    const earliest: Record<string, number> = {};
    const latest: Record<string, number> = {};
    for (let k = 0; k < sampleCount; k += 1) {
      const e = await probe(k);
      earliest[e] = (earliest[e] ?? 0) + 1;
      const l = await probe(users - 1 - k);
      latest[l] = (latest[l] ?? 0) + 1;
    }
    const redisAuthRows =
      [...h.redis.keys()].filter((k) => /^auth:[0-9a-f]{64}$/.test(k)).length;

    // Edge-attributable retention: drop everything the harness and this test
    // hold for those users (fake users/sessions/L2 rows, the token list) so
    // what remains above the baseline is the module state of index.ts —
    // cache.ts L1 (capped at 5 000 rows) and rateLimit.ts windows.
    h.reset(true);
    tokens.length = 0;
    await drainDeadlines();
    const heapEdgeOnly = heap();
    const edgeRetainedBytes = heapEdgeOnly.heapUsed - heapBefore.heapUsed;

    // Memory-fallback rate-limit windows (Redis down): rateLimit.ts caps its
    // in-memory window map at 20 000 keys and CLEARS it when full, so at 20k
    // distinct users a per-IP counter that had reached its limit is forgotten.
    let windowReset: Record<string, unknown> = {
      ran: false,
      reason: `STRESS_USERS=${users} < 20000`,
    };
    let edgeRetainedAfterWindowsBytes: number | null = null;
    if (users >= 20_000) {
      h.heal();
      h.reset();
      h.inject("redis", { kind: "http", status: 500 });
      const wr = rng(seedFor("memory:window-reset", BASE_SEED));
      const attackerIp = seededIp(wr);
      const attackers = Array.from(
        { length: 6 },
        () => ({ ...mintActor(h, wr), ip: attackerIp }),
      );
      let first429At: number | null = null;
      for (let i = 0; i < 1201; i += 1) {
        const answer = await callEdge(
          h,
          planRequest(attackers[i % 6], "session"),
        );
        iterations += 1;
        if (answer.status === 429) {
          first429At = i + 1;
          break;
        }
      }
      // 20 000 distinct users from other IPs each add one rl:user window key.
      const others = Array.from({ length: 20 }, () => seededIp(wr));
      let distinctNon409 = 0;
      for (let i = 0; i < 20_000; i += 1) {
        const ur = rng(seedFor(`memory:window-reset:user:${i}`, BASE_SEED));
        const userId = ur.uuid();
        h.registerUser({
          id: userId,
          email: `${userId.slice(0, 8)}@example.com`,
          provider: "google",
        });
        const session = h.mintSession(userId);
        const answer = await callEdge(
          h,
          edgeRequest("POST", ROUTE, {
            token: session.accessToken,
            ip: others[i % others.length],
            body: {},
          }),
        );
        iterations += 1;
        if (answer.status !== 409) distinctNon409 += 1;
        if (i % 5000 === 4999) h.reset();
      }
      const afterReset = await callEdge(
        h,
        planRequest(attackers[0], "session"),
      );
      iterations += 1;
      h.heal();
      h.reset(true);
      await drainDeadlines();
      edgeRetainedAfterWindowsBytes = heap().heapUsed - heapBefore.heapUsed;
      windowReset = {
        ran: true,
        redisMode: "HTTP 500 on every pipeline (memory fallback)",
        attackerIp,
        first429AtRequest: first429At,
        distinctUsersServed: 20_000,
        distinctUsersNon409: distinctNon409,
        attackerAfter20kDistinctUsers: {
          status: afterReset.status,
          code: afterReset.errorCode,
          interpretation: afterReset.status === 429
            ? "per-IP window survived"
            : "per-IP window was forgotten (rateLimit.ts windows.clear() at MEMORY_WINDOW_MAX)",
        },
      };
    }

    const report = {
      ...reportMeta("memory"),
      distinctUsers: users,
      iterations,
      distinctPhase: {
        wallMs: distinctWallMs,
        statuses,
        authRoundTrips: authCalls,
        heapBefore,
        heapAfter,
        heapUsedDeltaBytes: heapAfter.heapUsed - heapBefore.heapUsed,
        heapUsedDeltaPerUserBytes: Math.round(
          (heapAfter.heapUsed - heapBefore.heapUsed) / users,
        ),
        rssDeltaBytes: heapAfter.rss - heapBefore.rss,
        gcExposed: typeof gc === "function",
        note: typeof gc === "function"
          ? "heapUsed deltas measured after globalThis.gc() (run with --v8-flags=--expose-gc)"
          : "gc not exposed: heapUsed deltas include garbage not yet collected — run with --v8-flags=--expose-gc for a tight figure",
      },
      edgeRetained: {
        afterDistinctUsersBytes: edgeRetainedBytes,
        afterMemoryWindowsBytes: edgeRetainedAfterWindowsBytes,
        note:
          "heapUsed above the pre-campaign baseline once the harness's fake users/sessions/L2 rows and the test's token list were dropped and the upstream deadline timers drained: what index.ts itself retains (cache.ts L1 ≤ 5 000 rows, rateLimit.ts memory windows ≤ 20 000 keys)",
      },
      l1Residency: {
        sampleCount,
        earliestUsers: earliest,
        latestUsers: latest,
        l2AuthRows: redisAuthRows,
        note:
          "L1 cap is 5 000 rows (cache.ts MEMORY_MAX_ENTRIES); above it the earliest users must be L1 misses served from L2 with no Auth round trip",
      },
      windowReset,
    };
    const path = await writeReport("memory", report);
    console.log(`[stress training-plans] memory → ${path}`);
    console.log(
      JSON.stringify(
        {
          distinctPhase: report.distinctPhase,
          l1Residency: report.l1Residency,
          windowReset,
        },
        null,
        2,
      ),
    );

    assertEquals(
      statuses,
      { "409": users },
      `every distinct user must get the route's answer — see ${path}`,
    );
    assertEquals(authCalls, users, "exactly one Auth round trip per new user");
    assertEquals(latest["other"] ?? 0, 0, "latest users must still be served");
    assertEquals(
      earliest["other"] ?? 0,
      0,
      "earliest users must still be served (from L2)",
    );
    if (users > 5_000 + 100) {
      assertEquals(
        earliest["l1_hit"] ?? 0,
        0,
        "L1 must have evicted the earliest users (cap 5 000)",
      );
    }
    assertEquals(
      latest["l1_hit"] ?? 0,
      sampleCount,
      "latest users must be L1-resident",
    );
    // What the edge retains must be bounded by its caps, not by the user
    // count: 5 000 L1 rows (a few hundred bytes each) and, with Redis down,
    // 20 000 rate-limit windows. Without --expose-gc the figure also contains
    // uncollected garbage, so only assert it when the measurement is tight.
    if (typeof gc === "function") {
      assert(
        edgeRetainedBytes < 16 * 1024 * 1024,
        `index.ts retained ${edgeRetainedBytes} bytes after ${users} distinct users (L1 cap 5 000)`,
      );
      if (edgeRetainedAfterWindowsBytes !== null) {
        assert(
          edgeRetainedAfterWindowsBytes < 32 * 1024 * 1024,
          `index.ts retained ${edgeRetainedAfterWindowsBytes} bytes with 20 000 memory rate-limit windows`,
        );
      }
    }
  },
);
