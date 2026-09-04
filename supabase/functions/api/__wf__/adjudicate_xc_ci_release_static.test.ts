// XC-RS-01 / XC-RS-02 — Supabase Auth OUTAGE is not a sign-out.
//
// The edge fn must answer 503 (retryable) when Supabase Auth itself is
// unavailable — 5xx, 429, network failure, malformed body — on both
// authenticate() (auth.getUser) and POST /v1/auth/refresh, and 401 ONLY for a
// definitive credential refusal (Auth 400/401/403). The mobile client treats a
// refresh 401 as revocation and permanently clears the Keychain session, and
// the dispatcher charges every 401 to the per-IP auth-failure budget — so an
// upstream outage used to sign every player out AND lock their venue's NAT
// out for 5 minutes after Auth recovered.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json \
//     --filter 'AUTH-OUTAGE' adjudicate_xc_ci_release_static.test.ts

import { assert, assertEquals, assertNotEquals, assertStrictEquals } from "@std/assert";
import { loadHarness, SUPABASE_URL, TEST_USER_ID, userRequest } from "./routesHarness.ts";

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A Supabase-issued access token as the app bears it after bootstrap: routed
 * to auth.getUser by its issuer; a unique `jti` keeps every bearer out of the
 * auth cache written by an earlier successful verification. */
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

const gotrueUser = (sub = TEST_USER_ID) => ({
  id: sub,
  aud: "authenticated",
  role: "authenticated",
  email: "user@example.com",
  app_metadata: { provider: "google", providers: ["google"] },
  user_metadata: {},
  created_at: new Date().toISOString(),
});

const gotrueSession = (sub = TEST_USER_ID) => ({
  access_token: `rotated-session-for-${sub}`,
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: "rotated-refresh",
  user: gotrueUser(sub),
});

type AuthFault = (request: Request, init?: RequestInit) => Promise<Response> | Response;

/** Route Supabase Auth calls (/auth/v1/user, /auth/v1/token) through `fault`
 * for the duration of `run`; everything else keeps hitting the harness stubs. */
async function withAuthFault<T>(fault: AuthFault, run: () => Promise<T>): Promise<T> {
  const harnessFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (
      request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`) ||
      request.url.startsWith(`${SUPABASE_URL}/auth/v1/token`)
    ) {
      return await fault(request, init);
    }
    return await harnessFetch(input, init);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = harnessFetch;
  }
}

const networkFailure: AuthFault = () =>
  Promise.reject(new TypeError("error sending request: connection refused"));

/** A fetch that never answers on its own — resolves only when the caller's
 * AbortSignal fires (what a real hung upstream looks like to fetch()). */
const hungUpstream: AuthFault = (_request, init) =>
  new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    if (!signal) return; // no timeout wired: hang forever, the test's wall-clock bound fails
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

function refreshRequest(ip: string, refreshToken = "refresh-token-under-test"): Request {
  return new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ refreshToken }),
  });
}

async function expectRetryable503(response: Response, label: string): Promise<void> {
  const body = await response.json();
  assertNotEquals(response.status, 401, `${label}: an Auth outage must never read as sign-in required`);
  assertEquals(response.status, 503, `${label}: expected 503, got ${response.status}`);
  assertEquals(typeof body?.error?.message, "string", `${label}: generic error body`);
  assert(
    Number(response.headers.get("Retry-After")) >= 1,
    `${label}: Retry-After header tells the client to retry`,
  );
}

Deno.test("AUTH-OUTAGE-1: authenticate() maps Auth 5xx/429/network to 503, never 401", async () => {
  const h = await loadHarness();
  h.tables.profiles = [{ id: TEST_USER_ID, email: "user@example.com", onboarding_state: "complete", provider: "google" }];
  const cases: Array<{ name: string; fault: AuthFault }> = [
    {
      name: "getUser → 503 JSON",
      fault: () => jsonResponse(503, { code: 503, msg: "service unavailable" }),
    },
    {
      name: "getUser → 502 HTML (gateway)",
      fault: () =>
        new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
    },
    {
      name: "getUser → 429 over_request_rate_limit",
      fault: () =>
        jsonResponse(
          429,
          { code: 429, error_code: "over_request_rate_limit", msg: "Request rate limit reached" },
          { "Retry-After": "30" },
        ),
    },
    { name: "getUser → network failure", fault: networkFailure },
  ];
  let octet = 10;
  for (const testCase of cases) {
    octet += 1;
    const response = await withAuthFault(testCase.fault, () =>
      h.handler(userRequest("GET", "/v1/me", { token: supabaseBearer(), ip: `10.1.0.${octet}` })),
    );
    await expectRetryable503(response, testCase.name);
  }

  // Control: a definitive Auth refusal of the bearer is still 401.
  const refused = await withAuthFault(
    () =>
      jsonResponse(401, {
        code: 401,
        error_code: "bad_jwt",
        msg: "invalid JWT: unable to parse or verify signature",
      }),
    () => h.handler(userRequest("GET", "/v1/me", { token: supabaseBearer(), ip: "10.1.0.99" })),
  );
  assertEquals(refused.status, 401);
  await refused.body?.cancel();
});

Deno.test("AUTH-OUTAGE-2: /v1/auth/refresh maps Auth 429/malformed/network to 503; a refused refresh token stays 401", async () => {
  const h = await loadHarness();
  const cases: Array<{ name: string; fault: AuthFault }> = [
    {
      name: "refresh → 429 over_request_rate_limit",
      fault: () =>
        jsonResponse(429, {
          code: 429,
          error_code: "over_request_rate_limit",
          msg: "Request rate limit reached",
        }),
    },
    {
      name: "refresh → 200 non-JSON body",
      fault: () => new Response("<html>ok</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    },
    {
      name: "refresh → 200 JSON without a session",
      fault: () => jsonResponse(200, { message: "ok" }),
    },
    { name: "refresh → network failure", fault: networkFailure },
  ];
  let octet = 10;
  for (const testCase of cases) {
    octet += 1;
    const response = await withAuthFault(testCase.fault, () =>
      h.handler(refreshRequest(`10.2.0.${octet}`)),
    );
    await expectRetryable503(response, testCase.name);
  }

  // Controls: GoTrue REFUSING the refresh token (400 invalid_grant, or a 401)
  // is the one implicit sign-out and must remain 401.
  const invalidGrant = await withAuthFault(
    () =>
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Invalid Refresh Token: Refresh Token Not Found",
      }),
    () => h.handler(refreshRequest("10.2.0.98")),
  );
  assertEquals(invalidGrant.status, 401);
  await invalidGrant.body?.cancel();

  const unauthorized = await withAuthFault(
    () => jsonResponse(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" }),
    () => h.handler(refreshRequest("10.2.0.97")),
  );
  assertEquals(unauthorized.status, 401);
  await unauthorized.body?.cancel();

  // And a healthy Auth still rotates the pair.
  const rotated = await withAuthFault(
    () => jsonResponse(200, gotrueSession()),
    () => h.handler(refreshRequest("10.2.0.96")),
  );
  assertEquals(rotated.status, 200);
  const rotatedBody = await rotated.json();
  assertEquals(rotatedBody.session.accessToken, `rotated-session-for-${TEST_USER_ID}`);
  assertEquals(rotatedBody.session.refreshToken, "rotated-refresh");
});

Deno.test("AUTH-OUTAGE-2b: refresh against a failing or hung Auth answers in < 10s (bounded upstream timeout)", async () => {
  const h = await loadHarness();

  const startedNetwork = performance.now();
  const network = await withAuthFault(networkFailure, () => h.handler(refreshRequest("10.2.1.11")));
  const networkMs = performance.now() - startedNetwork;
  await expectRetryable503(network, "refresh → network failure");
  assert(networkMs < 10_000, `network failure answered after ${Math.round(networkMs)}ms (limit 10000ms)`);

  const startedHung = performance.now();
  const hung = await withAuthFault(hungUpstream, () => h.handler(refreshRequest("10.2.1.12")));
  const hungMs = performance.now() - startedHung;
  await expectRetryable503(hung, "refresh → hung upstream");
  assert(hungMs < 10_000, `hung upstream answered after ${Math.round(hungMs)}ms (limit 10000ms)`);

  const startedUser = performance.now();
  const hungUser = await withAuthFault(hungUpstream, () =>
    h.handler(userRequest("GET", "/v1/me", { token: supabaseBearer(), ip: "10.2.1.13" })),
  );
  const userMs = performance.now() - startedUser;
  await expectRetryable503(hungUser, "getUser → hung upstream");
  assert(userMs < 10_000, `hung getUser answered after ${Math.round(userMs)}ms (limit 10000ms)`);
});

Deno.test("AUTH-OUTAGE-3: an Auth outage does not charge the per-IP auth-failure budget", async () => {
  const h = await loadHarness();
  h.tables.profiles = [{ id: TEST_USER_ID, email: "user@example.com", onboarding_state: "complete", provider: "google" }];
  const venueIp = "10.3.0.7";
  const controlIp = "10.3.0.8";

  const outageStatuses: number[] = [];
  await withAuthFault(
    () => jsonResponse(503, { code: 503, msg: "service unavailable" }),
    async () => {
      for (let i = 0; i < 31; i += 1) {
        const response = await h.handler(
          userRequest("GET", "/v1/me", { token: supabaseBearer(), ip: venueIp }),
        );
        outageStatuses.push(response.status);
        await response.body?.cancel();
      }
    },
  );
  assertEquals(
    outageStatuses.filter((status) => status === 503).length,
    31,
    `outage-time statuses: ${JSON.stringify(outageStatuses)}`,
  );

  // Auth recovers: the very next valid request from the same IP must be served.
  const healthy: AuthFault = () => jsonResponse(200, gotrueUser());
  const recovered = await withAuthFault(healthy, () =>
    h.handler(userRequest("GET", "/v1/me", { token: supabaseBearer(), ip: venueIp })),
  );
  assertStrictEquals(recovered.status, 200, `post-recovery status ${recovered.status} from ${venueIp}`);
  await recovered.body?.cancel();

  const control = await withAuthFault(healthy, () =>
    h.handler(userRequest("GET", "/v1/me", { token: supabaseBearer(), ip: controlIp })),
  );
  assertStrictEquals(control.status, 200);
  await control.body?.cancel();
});
