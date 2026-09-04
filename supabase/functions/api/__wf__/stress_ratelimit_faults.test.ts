// stress-edge-ratelimit / lens failure-load — FAILURE INJECTION campaign.
//
// Breaks each upstream (Supabase Auth, PostgREST, RevenueCat, Upstash) in
// turn — HTTP 4xx/5xx, hang until the caller's deadline, socket error,
// malformed 2xx bodies, per-command Redis errors, short pipeline replies —
// against the REAL edge handler and asserts, per case:
//
//   • the user-visible error CLASS (status + `error.code` + Retry-After),
//   • whether the auth-failure budget of the caller's IP was charged
//     (an outage must never be booked as a bad credential),
//   • RECOVERABILITY: the identical request succeeds once the fault clears.
//
// Every case is a fixed payload (no randomness in the fault itself); the
// per-case IP / user id / session are drawn from Prng(STRESS_SEED).fork(id)
// so each case has its own budget and the whole table replays from one seed.
//
//   cd supabase/functions/api/__wf__ && deno task test --filter stress-faults
//   STRESS_SLOW=1 …   also runs the two RevenueCat 10 s hang cases
//
// Results: artifacts/stress-edge-ratelimit/faults/<scenario>.json

import { assert, assertEquals } from "./harness.ts";
import {
  DEFAULT_USER,
  edgeRequest,
  type Fault,
  type FaultSource,
  loadStressHarness,
  registerStressEnvRestore,
  Prng,
  providerIdToken,
  redisCount,
  replayCommand,
  type ResponseView,
  sessionToken,
  STRESS_SEED,
  type StressHarness,
  type Upstream,
  view,
  webhookRequest,
  writeReport,
} from "./stress_ratelimit_harness.ts";

const SLOW = Deno.env.get("STRESS_SLOW") === "1";
const FILE = "stress_ratelimit_faults.test.ts";

type RouteKind =
  | "access" // GET /v1/me/access with a Supabase session bearer
  | "access_provider" // GET /v1/me/access with a transitional Google ID token bearer
  | "refresh" // POST /v1/auth/refresh
  | "bootstrap" // POST /v1/account/bootstrap with a Google ID token
  | "billing" // POST /v1/billing/sync
  | "webhook" // POST /webhooks/revenuecat
  | "healthz"; // GET /healthz (public budget only)

interface Expect {
  status: number | number[];
  code?: string | null;
  /** "present" = a positive integer Retry-After; "absent" = none. */
  retryAfter?: "present" | "absent";
  /** Expected change of the caller IP's `authfail` counter (Redis-visible). */
  authfailDelta?: number;
  /** Status once the fault is cleared and the same request is replayed. */
  recover: number | number[];
  /** Upper bound for the faulty request's wall time (ms). */
  maxMs?: number;
}

interface FaultCase {
  id: string;
  upstream: Upstream;
  route: RouteKind;
  fault: FaultSource;
  expect: Expect;
  /** Case needs `releaseHangs()` (upstream call without an abort signal). */
  hangsWithoutDeadline?: boolean;
  slow?: boolean;
  note?: string;
}

const http = (status: number, body?: string, headers?: Record<string, string>): Fault => ({
  kind: "http",
  status,
  body,
  headers,
});
const malformed = (body: string, contentType?: string): Fault => ({
  kind: "malformed",
  body,
  contentType,
});
const HANG: Fault = { kind: "hang" };
const NET: Fault = { kind: "net_error" };
const OK: Fault = { kind: "ok" };

const unavailable503: Expect = {
  status: 503,
  retryAfter: "present",
  authfailDelta: 0,
  recover: 200,
};
const refused401: Expect = { status: 401, authfailDelta: 1, recover: 200 };

const CASES: FaultCase[] = [
  // ── Supabase Auth, session bearer on GET /v1/me/access ────────────────────
  { id: "auth-500", upstream: "auth", route: "access", fault: http(500), expect: unavailable503 },
  {
    id: "auth-502-html",
    upstream: "auth",
    route: "access",
    fault: http(502, "<html>bad gateway</html>", { "Content-Type": "text/html" }),
    expect: unavailable503,
  },
  { id: "auth-503", upstream: "auth", route: "access", fault: http(503), expect: unavailable503 },
  {
    id: "auth-504-empty",
    upstream: "auth",
    route: "access",
    fault: http(504, ""),
    expect: unavailable503,
  },
  {
    id: "auth-429-retry-after-30",
    upstream: "auth",
    route: "access",
    fault: http(429, "{}", { "Retry-After": "30", "Content-Type": "application/json" }),
    expect: unavailable503,
    note: "upstream Retry-After must be forwarded (asserted separately)",
  },
  {
    id: "auth-429-no-retry-after",
    upstream: "auth",
    route: "access",
    fault: http(429),
    expect: unavailable503,
  },
  {
    id: "auth-418-odd-status",
    upstream: "auth",
    route: "access",
    fault: http(418),
    expect: unavailable503,
  },
  {
    id: "auth-hang",
    upstream: "auth",
    route: "access",
    fault: HANG,
    expect: { ...unavailable503, maxMs: 2_000 },
  },
  {
    id: "auth-net-error-persistent",
    upstream: "auth",
    route: "access",
    fault: NET,
    expect: { ...unavailable503, maxMs: 2_000 },
  },
  {
    id: "auth-net-error-once-then-ok",
    upstream: "auth",
    route: "access",
    fault: [NET, OK],
    expect: { status: 200, authfailDelta: 0, recover: 200 },
    note: "one socket error is retried inside the deadline",
  },
  {
    id: "auth-200-non-json",
    upstream: "auth",
    route: "access",
    fault: malformed("<!doctype html>"),
    expect: unavailable503,
  },
  {
    id: "auth-200-empty-object",
    upstream: "auth",
    route: "access",
    fault: malformed("{}"),
    expect: unavailable503,
  },
  {
    id: "auth-200-null",
    upstream: "auth",
    route: "access",
    fault: malformed("null"),
    expect: unavailable503,
  },
  {
    id: "auth-200-user-without-id",
    upstream: "auth",
    route: "access",
    fault: malformed(
      JSON.stringify({ email: "x@example.com", app_metadata: { provider: "google" } }),
    ),
    expect: unavailable503,
  },
  {
    id: "auth-200-user-unknown-provider",
    upstream: "auth",
    route: "access",
    fault: malformed(JSON.stringify({ id: DEFAULT_USER, app_metadata: { provider: "email" } })),
    expect: refused401,
    note: "a verified user of a non-Apple/Google provider is a credential verdict",
  },
  {
    id: "auth-401",
    upstream: "auth",
    route: "access",
    fault: http(401, '{"msg":"invalid JWT"}'),
    expect: refused401,
  },
  { id: "auth-403", upstream: "auth", route: "access", fault: http(403), expect: refused401 },
  { id: "auth-400", upstream: "auth", route: "access", fault: http(400), expect: refused401 },

  // ── Supabase Auth on POST /v1/auth/refresh ────────────────────────────────
  {
    id: "refresh-auth-500",
    upstream: "auth",
    route: "refresh",
    fault: http(500),
    expect: unavailable503,
  },
  {
    id: "refresh-auth-hang",
    upstream: "auth",
    route: "refresh",
    fault: HANG,
    expect: { ...unavailable503, maxMs: 2_000 },
  },
  {
    id: "refresh-auth-net-error",
    upstream: "auth",
    route: "refresh",
    fault: NET,
    expect: { ...unavailable503, maxMs: 2_000 },
  },
  {
    id: "refresh-auth-429",
    upstream: "auth",
    route: "refresh",
    fault: http(429, "", { "Retry-After": "7" }),
    expect: unavailable503,
  },
  {
    id: "refresh-auth-400-token-not-found",
    upstream: "auth",
    route: "refresh",
    fault: http(400, '{"error_code":"refresh_token_not_found","msg":"Invalid Refresh Token"}', {
      "Content-Type": "application/json",
    }),
    expect: refused401,
  },
  {
    id: "refresh-200-missing-refresh-token",
    upstream: "auth",
    route: "refresh",
    fault: malformed(JSON.stringify({ access_token: "a.b.c", user: { id: DEFAULT_USER } })),
    expect: unavailable503,
  },
  {
    id: "refresh-200-expires-in-zero",
    upstream: "auth",
    route: "refresh",
    fault: malformed(
      JSON.stringify({
        access_token: "a.b.c",
        refresh_token: "r",
        expires_in: 0,
        user: { id: DEFAULT_USER, app_metadata: { provider: "google" } },
      }),
    ),
    expect: unavailable503,
  },
  {
    id: "refresh-200-non-json",
    upstream: "auth",
    route: "refresh",
    fault: malformed("oops"),
    expect: unavailable503,
  },

  // ── Supabase Auth on the provider-token paths (supabase-js signInWithIdToken)
  {
    id: "bootstrap-auth-500",
    upstream: "auth",
    route: "bootstrap",
    fault: http(500),
    expect: { status: [401, 503], recover: 200 },
    note: "observed class recorded; a 401 here books an outage as a bad credential",
  },
  {
    id: "bootstrap-auth-net-error",
    upstream: "auth",
    route: "bootstrap",
    fault: NET,
    expect: { status: [401, 503], recover: 200 },
  },
  {
    id: "bootstrap-auth-200-non-json",
    upstream: "auth",
    route: "bootstrap",
    fault: malformed("<html>"),
    expect: { status: [401, 503], recover: 200 },
  },
  {
    id: "bootstrap-auth-hang",
    upstream: "auth",
    route: "bootstrap",
    fault: HANG,
    expect: { status: [401, 503, 0], recover: 200 },
    hangsWithoutDeadline: true,
    note: "status 0 = still pending after the probe window (no edge-side deadline)",
  },
  {
    id: "provider-bearer-auth-500",
    upstream: "auth",
    route: "access_provider",
    fault: http(500),
    expect: { status: [401, 503], recover: 200 },
  },

  // ── PostgREST on GET /v1/me/access (access_state RPC) ─────────────────────
  {
    id: "rest-rpc-500",
    upstream: "rest",
    route: "access",
    fault: http(500),
    expect: { status: 503, authfailDelta: 0, recover: 200 },
  },
  {
    id: "rest-rpc-404-pgrst202",
    upstream: "rest",
    route: "access",
    fault: http(404, '{"code":"PGRST202","message":"function not found"}', {
      "Content-Type": "application/json",
    }),
    expect: { status: 503, authfailDelta: 0, recover: 200 },
  },
  {
    id: "rest-rpc-429",
    upstream: "rest",
    route: "access",
    fault: http(429),
    expect: { status: 503, authfailDelta: 0, recover: 200 },
  },
  {
    id: "rest-rpc-401",
    upstream: "rest",
    route: "access",
    fault: http(401),
    expect: { status: 503, authfailDelta: 0, recover: 200 },
  },
  {
    id: "rest-rpc-net-error",
    upstream: "rest",
    route: "access",
    fault: NET,
    expect: { status: 503, authfailDelta: 0, recover: 200 },
  },
  {
    id: "rest-rpc-200-empty-array",
    upstream: "rest",
    route: "access",
    fault: malformed("[]"),
    expect: { status: 503, authfailDelta: 0, recover: 200 },
  },
  {
    id: "rest-rpc-200-object",
    upstream: "rest",
    route: "access",
    fault: malformed("{}"),
    expect: { status: [200, 503], authfailDelta: 0, recover: 200 },
  },
  {
    id: "rest-rpc-200-non-json",
    upstream: "rest",
    route: "access",
    fault: malformed("not json"),
    expect: { status: 503, authfailDelta: 0, recover: 200 },
  },
  {
    id: "rest-rpc-hang",
    upstream: "rest",
    route: "access",
    fault: HANG,
    expect: { status: [503, 0], authfailDelta: 0, recover: 200 },
    hangsWithoutDeadline: true,
    note: "supabase-js passes no abort signal to PostgREST",
  },

  // ── PostgREST on POST /v1/billing/sync (persist verdict) ──────────────────
  {
    id: "billing-rest-500",
    upstream: "rest",
    route: "billing",
    fault: http(500),
    expect: { status: 503, authfailDelta: 0, recover: 200 },
  },
  {
    id: "billing-rest-net-error",
    upstream: "rest",
    route: "billing",
    fault: NET,
    expect: { status: 503, authfailDelta: 0, recover: 200 },
  },

  // ── PostgREST on the RevenueCat webhook ───────────────────────────────────
  {
    id: "webhook-rest-500-dedupe-lookup",
    upstream: "rest",
    route: "webhook",
    fault: [http(500), OK],
    expect: { status: [200, 503], recover: 200 },
    note: "dedupe lookup failure must not lose the event silently: class recorded",
  },
  {
    id: "webhook-rest-500-all",
    upstream: "rest",
    route: "webhook",
    fault: http(500),
    expect: { status: [200, 503], recover: 200 },
  },
  {
    id: "webhook-rest-net-error",
    upstream: "rest",
    route: "webhook",
    fault: NET,
    expect: { status: [200, 503], recover: 200 },
  },

  // ── RevenueCat on POST /v1/billing/sync ───────────────────────────────────
  {
    id: "rc-500",
    upstream: "rc",
    route: "billing",
    fault: http(500),
    expect: { status: 502, code: "billing_unavailable", authfailDelta: 0, recover: 200 },
  },
  {
    id: "rc-429",
    upstream: "rc",
    route: "billing",
    fault: http(429),
    expect: { status: 502, code: "billing_unavailable", authfailDelta: 0, recover: 200 },
  },
  {
    id: "rc-401",
    upstream: "rc",
    route: "billing",
    fault: http(401),
    expect: { status: 502, code: "billing_unavailable", authfailDelta: 0, recover: 200 },
  },
  {
    id: "rc-net-error",
    upstream: "rc",
    route: "billing",
    fault: NET,
    expect: { status: 502, code: "billing_unavailable", authfailDelta: 0, recover: 200 },
  },
  {
    id: "rc-200-non-json",
    upstream: "rc",
    route: "billing",
    fault: malformed("<html>"),
    expect: { status: 502, code: "billing_unavailable", authfailDelta: 0, recover: 200 },
  },
  {
    id: "rc-200-no-subscriber",
    upstream: "rc",
    route: "billing",
    fault: malformed("{}"),
    expect: { status: 502, code: "billing_unavailable", authfailDelta: 0, recover: 200 },
  },
  {
    id: "rc-200-entitlements-array",
    upstream: "rc",
    route: "billing",
    fault: malformed(JSON.stringify({ subscriber: { entitlements: [1, 2, 3] } })),
    expect: { status: [200, 502], authfailDelta: 0, recover: 200 },
    note: "malformed entitlements must never yield premium=true (asserted separately)",
  },
  {
    id: "rc-200-entitlement-garbage-expiry",
    upstream: "rc",
    route: "billing",
    fault: malformed(
      JSON.stringify({
        subscriber: {
          entitlements: {
            pickle_sensei_pro: { expires_date: "not-a-date", product_identifier: 42 },
          },
        },
      }),
    ),
    expect: { status: [200, 502], authfailDelta: 0, recover: 200 },
  },
  {
    id: "rc-hang-10s",
    upstream: "rc",
    route: "billing",
    fault: HANG,
    expect: {
      status: 502,
      code: "billing_unavailable",
      authfailDelta: 0,
      recover: 200,
      maxMs: 12_000,
    },
    slow: true,
  },

  // ── RevenueCat on the webhook (re-verification) ───────────────────────────
  {
    id: "webhook-rc-500",
    upstream: "rc",
    route: "webhook",
    fault: http(500),
    expect: { status: 503, recover: 200 },
  },
  {
    id: "webhook-rc-200-non-json",
    upstream: "rc",
    route: "webhook",
    fault: malformed("nope"),
    expect: { status: 503, recover: 200 },
  },
  {
    id: "webhook-rc-net-error",
    upstream: "rc",
    route: "webhook",
    fault: NET,
    expect: { status: 503, recover: 200 },
  },
  {
    id: "webhook-rc-hang-10s",
    upstream: "rc",
    route: "webhook",
    fault: HANG,
    expect: { status: 503, recover: 200, maxMs: 12_000 },
    slow: true,
  },

  // ── Upstash on GET /v1/me/access (the rate limiter's own dependency) ──────
  {
    id: "redis-500",
    upstream: "redis",
    route: "access",
    fault: http(500),
    expect: { status: 200, recover: 200 },
  },
  {
    id: "redis-429-quota",
    upstream: "redis",
    route: "access",
    fault: http(429),
    expect: { status: 200, recover: 200 },
  },
  {
    id: "redis-401",
    upstream: "redis",
    route: "access",
    fault: http(401),
    expect: { status: 200, recover: 200 },
  },
  {
    id: "redis-net-error",
    upstream: "redis",
    route: "access",
    fault: NET,
    expect: { status: 200, recover: 200 },
  },
  {
    id: "redis-hang",
    upstream: "redis",
    route: "access",
    fault: HANG,
    expect: { status: 200, recover: 200, maxMs: 15_000 },
    note: "each Redis round trip waits the full 1 200 ms REDIS_TIMEOUT_MS",
  },
  {
    id: "redis-incr-command-error",
    upstream: "redis",
    route: "access",
    fault: {
      kind: "redis_command_error",
      command: "INCR",
      error: "ERR max requests limit exceeded",
    },
    expect: { status: 200, recover: 200 },
  },
  {
    id: "redis-expire-command-error",
    upstream: "redis",
    route: "access",
    fault: { kind: "redis_command_error", command: "EXPIRE", error: "ERR unknown" },
    expect: { status: 200, recover: 200 },
    note: "window keys without TTL are checked separately",
  },
  {
    id: "redis-truncated-reply",
    upstream: "redis",
    route: "access",
    fault: { kind: "redis_truncate", keep: 1 },
    expect: { status: 200, recover: 200 },
  },
  {
    id: "redis-200-empty-array",
    upstream: "redis",
    route: "access",
    fault: malformed("[]"),
    expect: { status: 200, recover: 200 },
  },
  {
    id: "redis-200-object",
    upstream: "redis",
    route: "access",
    fault: malformed("{}"),
    expect: { status: 200, recover: 200 },
  },
  {
    id: "redis-200-non-json",
    upstream: "redis",
    route: "access",
    fault: malformed("OK"),
    expect: { status: 200, recover: 200 },
  },
  {
    id: "redis-incr-result-string",
    upstream: "redis",
    route: "access",
    fault: { kind: "redis_result", command: "INCR", result: "abc" },
    expect: { status: 200, recover: 200 },
  },
  {
    id: "redis-incr-result-negative",
    upstream: "redis",
    route: "access",
    fault: { kind: "redis_result", command: "INCR", result: -5 },
    expect: { status: 200, recover: 200 },
  },
  {
    id: "redis-incr-result-huge",
    upstream: "redis",
    route: "access",
    fault: { kind: "redis_result", command: "INCR", result: 1e12 },
    expect: { status: 429, code: "rate_limited", retryAfter: "present", recover: 200 },
    note: "Redis is authoritative: an absurd counter denies, but only until the window rolls",
  },
  {
    id: "redis-get-result-string",
    upstream: "redis",
    route: "access",
    fault: { kind: "redis_result", command: "GET", result: "abc" },
    expect: { status: 401, recover: 401 },
    note: "a non-nil reply for the revocation marker fences the session; L1 keeps the marker for L1_READTHROUGH_TTL_SECONDS (60 s), so the replay stays 401 on this isolate",
  },
  {
    id: "redis-get-result-31",
    upstream: "redis",
    route: "access",
    fault: { kind: "redis_result", command: "GET", result: "31" },
    expect: { status: [200, 429], recover: 200 },
    note: "authfail peek reads 31 → 429 if the peek happens on a GET",
  },
  {
    id: "healthz-redis-500",
    upstream: "redis",
    route: "healthz",
    fault: http(500),
    expect: { status: 200, recover: 200 },
  },
  {
    id: "webhook-redis-hang",
    upstream: "redis",
    route: "webhook",
    fault: HANG,
    expect: { status: 200, recover: 200, maxMs: 6_000 },
  },
  {
    id: "refresh-redis-net-error",
    upstream: "redis",
    route: "refresh",
    fault: NET,
    expect: { status: 200, recover: 200 },
  },
];

interface Subject {
  ip: string;
  userId: string;
  sessionId: string;
}

function requestFor(route: RouteKind, subject: Subject, h: StressHarness): Request {
  switch (route) {
    case "access":
      return edgeRequest("GET", "/v1/me/access", {
        ip: subject.ip,
        token: sessionToken({ userId: subject.userId, sessionId: subject.sessionId }),
      });
    case "access_provider":
      return edgeRequest("GET", "/v1/me/access", {
        ip: subject.ip,
        token: providerIdToken(`google-${subject.userId}`),
      });
    case "refresh":
      return edgeRequest("POST", "/v1/auth/refresh", {
        ip: subject.ip,
        token: null,
        body: { refreshToken: `refresh-case-${subject.userId}` },
      });
    case "bootstrap":
      h.tables.profiles = [
        {
          id: subject.userId,
          email: `${subject.userId.slice(0, 8)}@example.com`,
          onboarding_state: "pending",
          provider: "google",
        },
      ];
      return edgeRequest("POST", "/v1/account/bootstrap", {
        ip: subject.ip,
        token: providerIdToken(`google-${subject.userId}`),
        body: {},
      });
    case "billing":
      return edgeRequest("POST", "/v1/billing/sync", {
        ip: subject.ip,
        token: sessionToken({ userId: subject.userId, sessionId: subject.sessionId }),
        body: {},
      });
    case "webhook":
      return webhookRequest(
        {
          id: `evt-${subject.sessionId}`,
          type: "INITIAL_PURCHASE",
          app_user_id: subject.userId,
          event_timestamp_ms: Date.now(),
        },
        { ip: subject.ip },
      );
    case "healthz":
      return edgeRequest("GET", "/healthz", { ip: subject.ip, token: null });
  }
}

interface CaseOutcome {
  id: string;
  upstream: Upstream;
  route: RouteKind;
  seed: number;
  subject: Subject;
  faulty: ResponseView | { status: 0; pendingAfterMs: number };
  faultyMs: number;
  upstreamCalls: Record<string, number>;
  authfailBefore: number;
  authfailAfter: number;
  recovered: ResponseView;
  verdict: "HELD" | "BROKEN";
  failures: string[];
  note?: string;
}

const HANG_PROBE_MS = 1_500;

async function runCase(h: StressHarness, c: FaultCase, rng: Prng): Promise<CaseOutcome> {
  const r = rng.fork(c.id);
  const subject: Subject = {
    ip: r.ipv4() + `.${c.id.length}`,
    userId: r.uuid(),
    sessionId: r.uuid(),
  };
  // IPv4 + a suffix keeps every case in its own budget even when two cases
  // draw the same TEST-NET address; clientIp() treats it as an opaque string.
  h.clearFaults();
  h.fault(c.upstream, c.fault);
  const authfailBefore = redisCount(h.redis, "authfail", subject.ip);
  const tag = `case:${c.id}`;
  const started = performance.now();
  let faulty: CaseOutcome["faulty"];
  const pending = h.track(tag, () => h.handler(requestFor(c.route, subject, h)));
  if (c.hangsWithoutDeadline) {
    const probe = await Promise.race([
      pending.then((res) => ({ done: true as const, res })),
      new Promise<{ done: false }>((resolve) =>
        setTimeout(() => resolve({ done: false }), HANG_PROBE_MS),
      ),
    ]);
    if (probe.done) {
      faulty = await view(probe.res);
    } else {
      faulty = { status: 0, pendingAfterMs: HANG_PROBE_MS };
      h.releaseHangs();
      await view(await pending); // drain once released (answers 503 upstream)
    }
  } else {
    faulty = await view(await pending);
  }
  const faultyMs = performance.now() - started;
  const calls = h.callsFor(tag);
  const upstreamCalls: Record<string, number> = {};
  for (const call of calls) upstreamCalls[call.upstream] = (upstreamCalls[call.upstream] ?? 0) + 1;
  const authfailAfter = redisCount(h.redis, "authfail", subject.ip);

  h.clearFaults();
  const recovered = await view(await h.handler(requestFor(c.route, subject, h)));

  const failures: string[] = [];
  const wanted = Array.isArray(c.expect.status) ? c.expect.status : [c.expect.status];
  if (!wanted.includes(faulty.status))
    failures.push(`status ${faulty.status} not in ${wanted.join("/")}`);
  if ("code" in faulty) {
    if (c.expect.code !== undefined && faulty.code !== c.expect.code) {
      failures.push(`code ${faulty.code} != ${c.expect.code}`);
    }
    if (
      c.expect.retryAfter === "present" &&
      !(faulty.retryAfter !== null && faulty.retryAfter >= 1)
    ) {
      failures.push(`Retry-After missing (${faulty.retryAfter})`);
    }
    if (c.expect.retryAfter === "absent" && faulty.retryAfter !== null)
      failures.push("unexpected Retry-After");
    if (
      faulty.status >= 500 &&
      faulty.message &&
      /supabase|postgrest|upstash|redis|revenuecat/i.test(faulty.message)
    ) {
      failures.push(`5xx body leaks upstream detail: ${faulty.message}`);
    }
    if (!faulty.requestId) failures.push("missing X-Request-Id");
  }
  if (c.upstream !== "redis" && c.expect.authfailDelta !== undefined) {
    if (authfailAfter - authfailBefore !== c.expect.authfailDelta) {
      failures.push(
        `authfail delta ${authfailAfter - authfailBefore} != ${c.expect.authfailDelta}`,
      );
    }
  }
  const wantedRecover = Array.isArray(c.expect.recover) ? c.expect.recover : [c.expect.recover];
  if (!wantedRecover.includes(recovered.status)) {
    failures.push(
      `recovery status ${recovered.status} not in ${wantedRecover.join("/")} (${recovered.code ?? recovered.message})`,
    );
  }
  if (c.expect.maxMs !== undefined && faultyMs > c.expect.maxMs) {
    failures.push(`took ${Math.round(faultyMs)}ms > ${c.expect.maxMs}ms`);
  }
  return {
    id: c.id,
    upstream: c.upstream,
    route: c.route,
    seed: r.seed,
    subject,
    faulty,
    faultyMs: Number(faultyMs.toFixed(1)),
    upstreamCalls,
    authfailBefore,
    authfailAfter,
    recovered,
    verdict: failures.length === 0 ? "HELD" : "BROKEN",
    failures,
    note: c.note,
  };
}

Deno.test("stress-faults: every upstream broken in turn — class + recoverability", async () => {
  const h = await loadStressHarness({ redis: true, authTimeoutMs: 400 });
  const rng = new Prng(STRESS_SEED);
  const selected = CASES.filter((c) => SLOW || !c.slow);
  const outcomes: CaseOutcome[] = [];
  for (const c of selected) outcomes.push(await runCase(h, c, rng));
  h.releaseHangs();

  const path = await writeReport("faults", "fault_campaign", {
    seed: STRESS_SEED,
    replay: replayCommand(FILE, "stress-faults"),
    slowCasesIncluded: SLOW,
    cases: outcomes.length,
    held: outcomes.filter((o) => o.verdict === "HELD").length,
    broken: outcomes
      .filter((o) => o.verdict === "BROKEN")
      .map((o) => ({ id: o.id, failures: o.failures })),
    outcomes,
  });
  console.log(`[stress-faults] ${outcomes.length} cases → ${path}`);

  assert(outcomes.length >= 40, `need ≥40 fault cases, ran ${outcomes.length}`);
  const broken = outcomes.filter((o) => o.verdict === "BROKEN");
  assertEquals(
    broken.map((o) => `${o.id}: ${o.failures.join("; ")}`),
    [],
    "every fault case must match its expected class and recover",
  );
});

Deno.test("stress-faults: Auth 429 Retry-After is forwarded on the 503", async () => {
  const h = await loadStressHarness();
  h.fault("auth", http(429, "{}", { "Retry-After": "30", "Content-Type": "application/json" }));
  const res = await view(
    await h.handler(
      edgeRequest("GET", "/v1/me/access", {
        ip: "198.51.100.77",
        token: sessionToken({ userId: "77777777-7777-4777-8777-777777777777" }),
      }),
    ),
  );
  assertEquals(res.status, 503);
  assertEquals(res.retryAfter, 30);
});

Deno.test(
  "[defect] stress-faults: an Auth outage during bootstrap is booked as a bad credential (401 + authfail charged)",
  async () => {
    // The provider-token path goes through supabase-js signInWithIdToken, whose
    // errors index.ts maps to 401 `could not be verified` regardless of cause
    // (index.ts authenticateProviderToken). The session-bearer path classifies
    // the same outages as 503 + Retry-After and charges nothing. This test
    // pins the CURRENT behaviour; invert it when bootstrap gets the same
    // refused/unavailable split.
    const h = await loadStressHarness();
    const ip = "198.51.100.66";
    h.tables.profiles = [
      { id: DEFAULT_USER, email: "x@example.com", onboarding_state: "pending", provider: "google" },
    ];
    const before = redisCount(h.redis, "authfail", ip);
    const results: Array<{ fault: string; view: ResponseView }> = [];
    for (const [label, fault] of [
      ["http-500", http(500)],
      ["http-503", http(503)],
      ["net-error", NET],
      ["non-json", malformed("<html>")],
    ] as Array<[string, Fault]>) {
      h.fault("auth", fault);
      const res = await h.handler(
        edgeRequest("POST", "/v1/account/bootstrap", {
          ip,
          token: providerIdToken(`google-boot-${label}`),
          body: {},
        }),
      );
      results.push({ fault: label, view: await view(res) });
    }
    h.clearFaults();
    const after = redisCount(h.redis, "authfail", ip);
    const path = await writeReport("faults", "bootstrap_auth_outage", {
      ip,
      authfailBefore: before,
      authfailAfter: after,
      results,
    });
    console.log(`[stress-faults] bootstrap outage classes → ${path}`);
    for (const r of results) assertEquals(r.view.status, 401, r.fault);
    assertEquals(
      after - before,
      results.length,
      "every outage charged the IP's auth-failure budget",
    );
  },
);

Deno.test(
  "[defect] stress-faults: a PostgREST/Auth call issued through supabase-js has no edge-side deadline",
  async () => {
    // authRequest() bounds Supabase Auth (AUTH_UPSTREAM_TIMEOUT_MS) and cache.ts
    // bounds Upstash (1 200 ms); the supabase-js clients (access_state RPC,
    // signInWithIdToken) pass no AbortSignal, so a stalled upstream pins the
    // request until the client (mobile: 20 s) or the runtime gives up.
    const h = await loadStressHarness();
    const probeMs = 1_500;
    const observe = async (label: string, request: Request) => {
      const pending = h.handler(request);
      const settled = await Promise.race([
        pending.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), probeMs)),
      ]);
      h.releaseHangs();
      const res = await pending;
      await res.body?.cancel();
      return { label, settledWithinProbe: settled, statusAfterRelease: res.status };
    };
    h.fault("rest", HANG);
    const rpc = await observe(
      "access_state rpc",
      edgeRequest("GET", "/v1/me/access", {
        ip: "198.51.100.44",
        token: sessionToken({ userId: "44444444-4444-4444-8444-444444444444" }),
      }),
    );
    h.clearFaults();
    h.fault("auth", HANG);
    h.tables.profiles = [
      { id: DEFAULT_USER, email: "x@example.com", onboarding_state: "pending", provider: "google" },
    ];
    const bootstrap = await observe(
      "signInWithIdToken",
      edgeRequest("POST", "/v1/account/bootstrap", {
        ip: "198.51.100.45",
        token: providerIdToken("google-hang"),
        body: {},
      }),
    );
    h.clearFaults();
    const path = await writeReport("faults", "no_deadline_supabase_js", {
      probeMs,
      rpc,
      bootstrap,
    });
    console.log(`[stress-faults] supabase-js deadline probe → ${path}`);
    assertEquals(rpc.settledWithinProbe, false, "access_state RPC still pending after the probe");
    assertEquals(
      bootstrap.settledWithinProbe,
      false,
      "signInWithIdToken still pending after the probe",
    );
  },
);

Deno.test(
  "[defect] stress-faults: webhook acknowledges 200 when the verdict persist fails for infrastructure reasons",
  async () => {
    // handleRevenueCatWebhook treats ANY persistBillingVerdict error as "user
    // has no profiles row" and answers 200 {verified:false}; a PostgREST 5xx or
    // socket error is therefore acknowledged too, and RevenueCat never
    // redelivers the event. The next client billing sync repairs the row.
    const h = await loadStressHarness();
    const outcomes: Array<{ fault: string; status: number; body: unknown; restCalls: number }> = [];
    for (const [label, fault] of [
      ["rest-500-on-persist", [OK, http(500), OK]],
      ["rest-net-error-on-persist", [OK, NET, OK]],
    ] as Array<[string, FaultSource]>) {
      h.fault("rest", fault);
      const tag = `webhook:${label}`;
      const res = await h.track(tag, () =>
        h.handler(
          webhookRequest(
            {
              id: `evt-${label}`,
              type: "RENEWAL",
              app_user_id: DEFAULT_USER,
              event_timestamp_ms: Date.now(),
            },
            { ip: "198.51.100.46" },
          ),
        ),
      );
      outcomes.push({
        fault: label,
        status: res.status,
        body: await res.json(),
        restCalls: h.callsFor(tag).filter((c) => c.upstream === "rest").length,
      });
    }
    h.clearFaults();
    const path = await writeReport("faults", "webhook_persist_infra_failure", { outcomes });
    console.log(`[stress-faults] webhook persist failure → ${path}`);
    for (const o of outcomes) {
      assertEquals(o.status, 200, o.fault);
      assertEquals((o.body as { verified: boolean }).verified, false, o.fault);
    }
  },
);

Deno.test("stress-faults: malformed RevenueCat entitlements never grant premium", async () => {
  const h = await loadStressHarness();
  const token = sessionToken({ userId: "55555555-5555-4555-8555-555555555555" });
  const bodies: Array<Record<string, unknown>> = [
    { subscriber: { entitlements: [1, 2, 3] } },
    {
      subscriber: {
        entitlements: { pickle_sensei_pro: { expires_date: "not-a-date", product_identifier: 42 } },
      },
    },
    {
      subscriber: { entitlements: { pickle_sensei_pro: { expires_date: "2000-01-01T00:00:00Z" } } },
    },
    { subscriber: { entitlements: { pickle_sensei_pro: "yes" } } },
    { subscriber: { entitlements: null } },
  ];
  const seen: Array<{ body: Record<string, unknown>; status: number; premium: unknown }> = [];
  for (const body of bodies) {
    h.fault("rc", malformed(JSON.stringify(body)));
    const res = await h.handler(
      edgeRequest("POST", "/v1/billing/sync", { ip: "198.51.100.47", token, body: {} }),
    );
    const parsed = await res.json();
    seen.push({
      body,
      status: res.status,
      premium: parsed?.billing?.premium ?? parsed?.error?.code,
    });
  }
  h.clearFaults();
  const path = await writeReport("faults", "rc_malformed_entitlements", { seen });
  console.log(`[stress-faults] RC malformed entitlements → ${path}`);
  for (const s of seen) assert(s.premium !== true, JSON.stringify(s));
});

Deno.test(
  "[defect] stress-faults: an Upstash EXPIRE error leaves the window key without a TTL",
  async () => {
    // cache.ts redisWindowIncr honours INCR's count and ignores the EXPIRE slot,
    // so when only EXPIRE fails the bucket key `rl:<scope>:<bucket>:<id>` stays
    // in Redis forever (one per id per window). Counting is unaffected because
    // the bucket number is part of the key.
    const h = await loadStressHarness();
    h.fault("redis", { kind: "redis_command_error", command: "EXPIRE", error: "ERR unknown" });
    const res = await h.handler(
      edgeRequest("GET", "/healthz", { ip: "198.51.100.55", token: null }),
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();
    h.clearFaults();
    const leaked = [...h.redis.store.entries()].filter(
      ([key, entry]) =>
        key.startsWith("rl:") && key.endsWith(":198.51.100.55") && entry.expiresAtMs === null,
    );
    const path = await writeReport("faults", "redis_expire_error_leak", {
      leakedKeys: leaked.map(([key, entry]) => ({ key, value: entry.value })),
    });
    console.log(`[stress-faults] EXPIRE-error leak → ${path}`);
    // Documented observation: INCR's count is honoured while the failed EXPIRE
    // is ignored, so the bucket key persists in Redis without a TTL.
    assert(leaked.length >= 1, "expected the no-TTL window key to be observable");
  },
);

Deno.test(
  "stress-faults: 30 auth refusals from one IP lock the IP for ≤300 s, even for valid bearers",
  async () => {
    const h = await loadStressHarness();
    const rng = new Prng(STRESS_SEED).fork("authfail-lockout");
    const ip = `${rng.ipv4()}.lock`;
    h.fault("auth", http(401));
    const statuses: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const res = await h.handler(
        edgeRequest("GET", "/v1/me/access", { ip, token: sessionToken({ userId: rng.uuid() }) }),
      );
      statuses.push(res.status);
      await res.body?.cancel();
    }
    h.clearFaults();
    const authCallsBeforeLock = h.calls.filter((c) => c.upstream === "auth").length;
    const locked = await view(
      await h.handler(
        edgeRequest("GET", "/v1/me/access", { ip, token: sessionToken({ userId: rng.uuid() }) }),
      ),
    );
    const authCallsAfterLock = h.calls.filter((c) => c.upstream === "auth").length;
    const otherIp = await view(
      await h.handler(
        edgeRequest("GET", "/v1/me/access", {
          ip: `${ip}.other`,
          token: sessionToken({ userId: rng.uuid() }),
        }),
      ),
    );
    const path = await writeReport("faults", "authfail_lockout", {
      ip,
      refusals: statuses,
      locked,
      otherIp,
    });
    console.log(`[stress-faults] authfail lockout → ${path}`);
    assertEquals(new Set(statuses), new Set([401]));
    assertEquals(locked.status, 429);
    assertEquals(locked.code, "rate_limited");
    assert(
      locked.retryAfter !== null && locked.retryAfter >= 1 && locked.retryAfter <= 300,
      String(locked.retryAfter),
    );
    assertEquals(authCallsAfterLock, authCallsBeforeLock, "locked IP reaches no upstream");
    assertEquals(otherIp.status, 200, "another IP is unaffected");
  },
);

registerStressEnvRestore(FILE);
