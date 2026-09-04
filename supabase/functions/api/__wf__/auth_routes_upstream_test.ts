// Supabase Auth (GoTrue) is a DEPENDENCY of the auth routes, not their verdict.
// These tests pin how the edge answers when GoTrue itself misbehaves:
//
//   • a transient upstream condition — 429, 5xx, or the fetch throwing — must be
//     answered as a retryable 429/503 with the generic body, within the app's
//     15 s refresh timeout, in at most one or two upstream attempts, and must
//     NOT be charged to the caller's per-IP auth-failure budget (a following
//     bootstrap from the same IP still reaches GoTrue);
//   • a genuine rejection of the credential — GoTrue 400 invalid_grant on
//     refresh, 401 session_not_found on getUser, 400 bad id_token on bootstrap —
//     stays a 401 and DOES charge the budget (30 of them lock the IP out);
//   • logout with GoTrue unreachable is the generic 503 (never the unhandled
//     500) and the bearer's cache entry is gone regardless.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json auth_routes_upstream_test.ts

import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  fakeGoogleIdToken,
  loadHarness,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

const h = await loadHarness();

const AUTH_FAILURE_LIMIT = 30;
/** apps/mobile sessionLifecycle REQUEST_TIMEOUT_MS is 15 000; the edge must
 * answer with margin to spare. */
const MAX_EDGE_MS = 10_000;
const MAX_UPSTREAM_ATTEMPTS = 2;

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function supabaseAccessToken(jti: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: TEST_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti,
    }),
  );
  return `${header}.${payload}.sig`;
}

type Override = (request: Request, url: URL) => Response | Promise<Response> | null;

/** Intercept GoTrue calls in front of the harness's own fake Supabase; every
 * other fetch (PostgREST, RevenueCat) still goes to the harness. */
async function withGoTrue<T>(override: Override, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/")) {
      const handled = await override(request.clone(), url);
      if (handled) return handled;
    }
    return previous(input, init);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

const goTrueJson = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const goTrueUser = () => ({
  id: TEST_USER_ID,
  aud: "authenticated",
  role: "authenticated",
  email: "user@example.com",
  app_metadata: { provider: "google", providers: ["google"] },
  user_metadata: {},
});

const refreshRequest = (ip: string) =>
  new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ refreshToken: "rt-device" }),
  });

const bootstrapRequest = (ip: string) =>
  userRequest("POST", "/v1/account/bootstrap", { ip, token: fakeGoogleIdToken(), body: {} });

const meRequest = (ip: string, token: string) => userRequest("GET", "/v1/me", { ip, token });

/** Whether a bootstrap from `ip` is let through to GoTrue. Once the IP's
 * auth-failure budget is spent, the edge refuses it 429 before any upstream
 * call. */
async function bootstrapReachesGoTrue(ip: string): Promise<boolean> {
  const before = h.callsTo("/auth/v1/token").length;
  const response = await h.handler(bootstrapRequest(ip));
  await response.body?.cancel();
  return response.status !== 429 && h.callsTo("/auth/v1/token").length === before + 1;
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown };
}

const UPSTREAM_DETAIL = /Rate limit exceeded|service unavailable|connection reset|over_request_rate_limit/i;

/** The generic retryable contract: 429 (rate_limited + Retry-After) or 503
 * ("… is temporarily unavailable. Please try again."), never a word of what
 * GoTrue actually said. */
function assertRetryableUpstreamFailure(label: string, status: number, headers: Headers, text: string) {
  assert(
    status === 429 || status === 503,
    `${label}: expected a retryable 429/503, got ${status} ${text}`,
  );
  const body = JSON.parse(text) as ErrorBody;
  assertEquals(typeof body.error?.message, "string", `${label}: body is the generic error object`);
  assert(!UPSTREAM_DETAIL.test(text), `${label}: upstream detail leaked into the body: ${text}`);
  if (status === 429) {
    assertEquals(body.error?.code, "rate_limited", `${label}: 429 body code`);
    assertMatch(headers.get("Retry-After") ?? "", /^\d+$/, `${label}: 429 carries Retry-After`);
  } else {
    assertMatch(
      String(body.error?.message),
      /is temporarily unavailable\. Please try again\.$/,
      `${label}: 503 carries the generic service-unavailable message`,
    );
  }
  assertEquals(headers.get("Cache-Control"), "no-store", `${label}: uncacheable`);
}

// ── Transient GoTrue failure × auth route ────────────────────────────────────

interface AuthRoute {
  name: string;
  goTruePath: string;
  request: (ip: string, i: number) => Request;
}

const routes: AuthRoute[] = [
  { name: "POST /v1/auth/refresh", goTruePath: "/auth/v1/token", request: (ip) => refreshRequest(ip) },
  {
    name: "GET /v1/me (Supabase access token)",
    goTruePath: "/auth/v1/user",
    request: (ip, i) => meRequest(ip, supabaseAccessToken(`upstream-${ip}-${i}`)),
  },
  { name: "POST /v1/account/bootstrap", goTruePath: "/auth/v1/token", request: (ip) => bootstrapRequest(ip) },
];

interface UpstreamFailure {
  name: string;
  respond: () => Response;
}

const failures: UpstreamFailure[] = [
  {
    name: "GoTrue 429",
    respond: () =>
      goTrueJson(429, { code: 429, error_code: "over_request_rate_limit", msg: "Rate limit exceeded" }),
  },
  { name: "GoTrue 503", respond: () => goTrueJson(503, { code: 503, msg: "service unavailable" }) },
  {
    name: "fetch throws",
    respond: () => {
      throw new TypeError("connection reset");
    },
  },
];

let ipOctet = 20;

for (const route of routes) {
  for (const failure of failures) {
    Deno.test(`${route.name} × ${failure.name}: retryable 429/503, generic body, ≤ ${MAX_UPSTREAM_ATTEMPTS} upstream attempts, authfail not charged`, async () => {
      h.reset();
      const ip = `198.51.100.${ipOctet++}`;
      let attempts = 0;
      await withGoTrue(
        (_request, url) => {
          if (url.pathname !== route.goTruePath) return null;
          attempts += 1;
          return failure.respond();
        },
        async () => {
          for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
            const attemptsBefore = attempts;
            const startedAt = performance.now();
            const response = await h.handler(route.request(ip, i));
            const elapsedMs = Math.round(performance.now() - startedAt);
            const text = await response.text();
            const label = `${route.name} × ${failure.name} #${i + 1}`;
            assertRetryableUpstreamFailure(label, response.status, response.headers, text);
            assert(elapsedMs < MAX_EDGE_MS, `${label}: edge answered after ${elapsedMs} ms`);
            assert(
              attempts - attemptsBefore <= MAX_UPSTREAM_ATTEMPTS,
              `${label}: ${attempts - attemptsBefore} GoTrue attempts for one edge request`,
            );
          }
        },
      );
      assert(attempts >= AUTH_FAILURE_LIMIT, `every edge request must have reached GoTrue (${attempts})`);
      assertEquals(
        await bootstrapReachesGoTrue(ip),
        true,
        `${AUTH_FAILURE_LIMIT} transient upstream failures spent the IP's auth-failure budget`,
      );
    });
  }
}

Deno.test("refresh × GoTrue /token 503: edge answers 503 within 10 s after ≤ 2 GoTrue requests", async () => {
  h.reset();
  const attemptsAtMs: number[] = [];
  const startedAt = performance.now();
  const response = await withGoTrue(
    (_request, url) => {
      if (url.pathname !== "/auth/v1/token") return null;
      attemptsAtMs.push(Math.round(performance.now() - startedAt));
      return goTrueJson(503, { code: 503, msg: "service unavailable" });
    },
    () => h.handler(refreshRequest("198.51.100.60")),
  );
  const elapsedMs = Math.round(performance.now() - startedAt);
  const text = await response.text();
  assertEquals(response.status, 503, `refresh answered ${response.status} ${text}`);
  assertRetryableUpstreamFailure("refresh × 503", response.status, response.headers, text);
  assert(elapsedMs < MAX_EDGE_MS, `edge answered after ${elapsedMs} ms (attempts at +${attemptsAtMs.join(", +")} ms)`);
  assert(
    attemptsAtMs.length <= MAX_UPSTREAM_ATTEMPTS,
    `${attemptsAtMs.length} GoTrue attempts at +${attemptsAtMs.join(", +")} ms`,
  );
});

Deno.test("refresh × GoTrue 429 with Retry-After: the edge's 429 relays it", async () => {
  h.reset();
  const response = await withGoTrue(
    (_request, url) =>
      url.pathname === "/auth/v1/token"
        ? goTrueJson(
          429,
          { code: 429, error_code: "over_request_rate_limit", msg: "Rate limit exceeded" },
          { "Retry-After": "17" },
        )
        : null,
    () => h.handler(refreshRequest("198.51.100.61")),
  );
  const text = await response.text();
  assertEquals(response.status, 429, `refresh answered ${response.status} ${text}`);
  assertEquals(response.headers.get("Retry-After"), "17");
});

// ── Genuine rejections stay 401 and charge the auth-failure budget ───────────

Deno.test("refresh × GoTrue 400 invalid_grant: 401 every time, and 30 of them lock the IP out of bootstrap", async () => {
  h.reset();
  const ip = "198.51.100.70";
  await withGoTrue(
    (_request, url) =>
      url.pathname === "/auth/v1/token"
        ? goTrueJson(400, {
          code: 400,
          error_code: "refresh_token_not_found",
          error: "invalid_grant",
          error_description: "Invalid Refresh Token: Refresh Token Not Found",
        })
        : null,
    async () => {
      for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
        const response = await h.handler(refreshRequest(ip));
        const text = await response.text();
        assertEquals(response.status, 401, `refresh #${i + 1} answered ${response.status} ${text}`);
        assertEquals(
          (JSON.parse(text) as ErrorBody).error?.message,
          "The session could not be refreshed. Sign in again.",
        );
      }
    },
  );
  assertEquals(await bootstrapReachesGoTrue(ip), false, "30 refused refresh tokens must spend the IP's auth-failure budget");
});

Deno.test("GET /v1/me × getUser 401 session_not_found: 401 every time, and 30 of them lock the IP out of bootstrap", async () => {
  h.reset();
  const ip = "198.51.100.71";
  await withGoTrue(
    (_request, url) =>
      url.pathname === "/auth/v1/user"
        ? goTrueJson(401, { code: 401, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" })
        : null,
    async () => {
      for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
        const response = await h.handler(meRequest(ip, supabaseAccessToken(`revoked-${i}`)));
        const text = await response.text();
        assertEquals(response.status, 401, `GET /v1/me #${i + 1} answered ${response.status} ${text}`);
        assertEquals(
          (JSON.parse(text) as ErrorBody).error?.message,
          "The session is no longer valid. Sign in again.",
        );
      }
    },
  );
  assertEquals(await bootstrapReachesGoTrue(ip), false, "30 dead sessions must spend the IP's auth-failure budget");
});

Deno.test("bootstrap × signInWithIdToken 400 bad id_token: 401 every time, and 30 of them lock the IP out of bootstrap", async () => {
  h.reset();
  const ip = "198.51.100.72";
  await withGoTrue(
    (_request, url) =>
      url.pathname === "/auth/v1/token"
        ? goTrueJson(400, {
          code: 400,
          error_code: "bad_jwt",
          error: "invalid_grant",
          error_description: "Invalid or expired ID token",
        })
        : null,
    async () => {
      for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
        const response = await h.handler(bootstrapRequest(ip));
        const text = await response.text();
        assertEquals(response.status, 401, `bootstrap #${i + 1} answered ${response.status} ${text}`);
        assertEquals(
          (JSON.parse(text) as ErrorBody).error?.message,
          "The identity token could not be verified.",
        );
      }
    },
  );
  assertEquals(await bootstrapReachesGoTrue(ip), false, "30 refused ID tokens must spend the IP's auth-failure budget");
});

// ── Logout with GoTrue unreachable ───────────────────────────────────────────

Deno.test("logout × GoTrue fetch throws: generic 503 (not the unhandled 500) and the bearer's cache entry is gone", async () => {
  h.reset();
  const ip = "198.51.100.80";
  const token = supabaseAccessToken("logout-net");
  let getUserCalls = 0;
  const goTrue: Override = (_request, url) => {
    if (url.pathname === "/auth/v1/user") {
      getUserCalls += 1;
      return goTrueJson(200, goTrueUser());
    }
    if (url.pathname === "/auth/v1/logout") throw new TypeError("connection reset");
    return null;
  };
  await withGoTrue(goTrue, async () => {
    // Verify once (cached), then confirm the cache serves the second call.
    for (let i = 0; i < 2; i += 1) {
      const me = await h.handler(meRequest(ip, token));
      await me.body?.cancel();
      assertNotEquals(me.status, 401, "precondition: the access token verifies");
    }
    assertEquals(getUserCalls, 1, "precondition: the verified bearer is served from the auth cache");

    const logout = await h.handler(userRequest("POST", "/v1/auth/logout", { ip, token }));
    const text = await logout.text();
    assertEquals(logout.status, 503, `logout answered ${logout.status} ${text}`);
    assertRetryableUpstreamFailure("logout × fetch throws", logout.status, logout.headers, text);

    const afterLogout = await h.handler(meRequest(ip, token));
    await afterLogout.body?.cancel();
    assertEquals(getUserCalls, 2, "the bearer must be re-verified with GoTrue after logout (cache entry evicted)");
  });
});
