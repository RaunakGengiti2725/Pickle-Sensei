// XC-P1-AUTH-REFRESH-TRANSIENT-401 — POST /v1/auth/refresh classification.
//
// The app's sessionLifecycle treats exactly 401/403 from this route as "the
// server refused the refresh token" and signs the user out (Keychain record
// deleted). So the edge fn may answer 401 ONLY when GoTrue definitively
// refuses the token (400/401/403 — invalid_grant class). GoTrue 429, 5xx and
// network / status-less failures are transient: 503 + Retry-After, so
// sessionKeeper retries with backoff and the user stays signed in — and a
// 429'd client must not be charged to the per-IP auth-failure budget either.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json \
//     xc_adjudicate_auth_refresh.test.ts

import { assert, assertEquals, assertNotEquals, assertStrictEquals } from "@std/assert";
import { loadHarness, SUPABASE_URL, TEST_USER_ID, userRequest } from "./routesHarness.ts";

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function supabaseBearer(sub = TEST_USER_ID): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: crypto.randomUUID(),
    }),
  );
  return `${header}.${payload}.sig`;
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

type AuthFault = (request: Request) => Promise<Response> | Response;

async function withAuthFault<T>(fault: AuthFault, run: () => Promise<T>): Promise<T> {
  const harnessFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (
      request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`) ||
      request.url.startsWith(`${SUPABASE_URL}/auth/v1/token`)
    ) {
      return await fault(request);
    }
    return await harnessFetch(input, init);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = harnessFetch;
  }
}

function refreshRequest(ip: string): Request {
  return new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ refreshToken: "refresh-token-under-test" }),
  });
}

const gotrue429: AuthFault = () =>
  jsonResponse(
    429,
    { code: 429, error_code: "over_request_rate_limit", msg: "Request rate limit reached" },
    { "Retry-After": "30" },
  );

const gotrueNetworkTypeError: AuthFault = () =>
  Promise.reject(new TypeError("error sending request for url: connection refused"));

const gotrueInvalidGrant: AuthFault = () =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Invalid Refresh Token: Refresh Token Not Found",
  });

Deno.test("xc-auth-refresh: GoTrue 429 on refresh → edge 503 (retryable), not 401", async () => {
  const h = await loadHarness();
  const response = await withAuthFault(gotrue429, () => h.handler(refreshRequest("10.4.0.11")));
  const body = await response.json();
  assertNotEquals(response.status, 401);
  assertEquals(response.status, 503);
  assertEquals(typeof body.error.message, "string");
  assert(Number(response.headers.get("Retry-After")) >= 1);
});

Deno.test("xc-auth-refresh: GoTrue network TypeError on refresh → edge 503, not 401", async () => {
  const h = await loadHarness();
  const response = await withAuthFault(gotrueNetworkTypeError, () =>
    h.handler(refreshRequest("10.4.0.12")),
  );
  const body = await response.json();
  assertNotEquals(response.status, 401);
  assertEquals(response.status, 503);
  assertEquals(typeof body.error.message, "string");
  assert(Number(response.headers.get("Retry-After")) >= 1);
});

Deno.test("xc-auth-refresh: GoTrue invalid_grant on refresh → edge 401 (the one implicit sign-out)", async () => {
  const h = await loadHarness();
  const response = await withAuthFault(gotrueInvalidGrant, () =>
    h.handler(refreshRequest("10.4.0.13")),
  );
  assertEquals(response.status, 401);
  await response.body?.cancel();
});

Deno.test("xc-auth-refresh: GoTrue 429 on refresh is NOT charged to the per-IP auth-failure budget", async () => {
  const h = await loadHarness();
  h.tables.profiles = [
    { id: TEST_USER_ID, email: "user@example.com", onboarding_state: "complete", provider: "google" },
  ];
  const ip = "10.4.0.20";
  // AUTH_FAILURE_LIMIT is 30/300s; the refresh route's own budget is 30/60s,
  // so 30 rate-limited refreshes fit inside it and would exhaust the
  // auth-failure budget exactly if each were (wrongly) charged as a failure.
  const statuses: number[] = [];
  await withAuthFault(gotrue429, async () => {
    for (let i = 0; i < 30; i += 1) {
      const response = await h.handler(refreshRequest(ip));
      statuses.push(response.status);
      await response.body?.cancel();
    }
  });
  assertEquals(statuses.filter((status) => status === 503).length, 30, JSON.stringify(statuses));

  const healthyUser: AuthFault = () =>
    jsonResponse(200, {
      id: TEST_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      email: "user@example.com",
      app_metadata: { provider: "google", providers: ["google"] },
      user_metadata: {},
    });
  const served = await withAuthFault(healthyUser, () =>
    h.handler(userRequest("GET", "/v1/me", { token: supabaseBearer(), ip })),
  );
  assertStrictEquals(served.status, 200, `same IP after 30 rate-limited refreshes: ${served.status}`);
  await served.body?.cancel();
});
