// POST /v1/auth/logout against the real edge handler (routesHarness): the
// success path, the missing-bearer path, and both ways Supabase Auth can fail
// (5xx status, thrown network error) — each must be the retryable 503, never
// the generic 500.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json auth_logout_test.ts

import { assert, assertEquals } from "@std/assert";
import { loadHarness, SUPABASE_URL, TEST_USER_ID, userRequest } from "./routesHarness.ts";

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A syntactically valid Supabase-issued ACCESS token (iss ends in /auth/v1). */
function fakeSupabaseAccessToken(salt: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: TEST_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      session_id: `session-${salt}`,
      exp: now + 3600,
      iat: now,
      salt,
    }),
  );
  return `${header}.${payload}.sig`;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const healthyUser = () => ({
  id: TEST_USER_ID,
  aud: "authenticated",
  role: "authenticated",
  email: "user@example.com",
  app_metadata: { provider: "apple", providers: ["apple"] },
  user_metadata: {},
  created_at: new Date().toISOString(),
});

type Fault = (request: Request) => Promise<Response> | Response | null;

/** Install a fault in front of the harness' stubbed fetch for the duration of `run`. */
async function withFault<T>(fault: Fault, run: () => Promise<T>): Promise<T> {
  const base = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const injected = await fault(request.clone());
    if (injected) return injected;
    return base(request);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = base;
  }
}

/** Requests the fault answered itself (the harness only records what reaches
 * its own fetch). */
const intercepted: Request[] = [];
const interceptedTo = (fragment: string) => intercepted.filter((r) => r.url.includes(fragment));

/** getUser answers healthy; the logout upstream answers per `logout`. */
const authFault =
  (logout: () => Promise<Response> | Response): Fault => (request) => {
    if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      intercepted.push(request);
      return jsonResponse(200, healthyUser());
    }
    if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/logout`)) {
      intercepted.push(request);
      return logout();
    }
    return null;
  };

let ipCounter = 0;
const freshIp = (): string => `192.0.2.${(ipCounter += 1)}`;

Deno.test("logout: 204 on upstream success and the bearer stops working", async () => {
  const h = await loadHarness();
  const ip = freshIp();
  const token = fakeSupabaseAccessToken("ok");
  intercepted.length = 0;
  await withFault(
    authFault(() => new Response(null, { status: 204 })),
    async () => {
      const response = await h.handler(userRequest("POST", "/v1/auth/logout", { token, ip }));
      assertEquals(response.status, 204);
      const upstream = interceptedTo("/auth/v1/logout");
      assertEquals(upstream.length, 1, "exactly one upstream logout");
      assertEquals(upstream[0].method, "POST");
      assert(upstream[0].url.includes("scope=local"), "revokes only this device's session");
      assertEquals(upstream[0].headers.get("authorization"), `Bearer ${token}`);

      // Even though this fake Auth would still vouch for the bearer, the edge
      // refuses it: the session is tombstoned at logout.
      const after = await h.handler(userRequest("GET", "/v1/me/saved-drills", { token, ip }));
      assertEquals(after.status, 401, "the logged-out bearer is refused");
    },
  );
});

Deno.test("logout: 401 without a bearer", async () => {
  const h = await loadHarness();
  const request = new Request("http://edge.test/functions/v1/api/v1/auth/logout", {
    method: "POST",
    headers: { "x-forwarded-for": freshIp() },
  });
  intercepted.length = 0;
  const response = await withFault(
    authFault(() => new Response(null, { status: 204 })),
    () => h.handler(request),
  );
  assertEquals(response.status, 401);
  assertEquals(interceptedTo("/auth/v1/logout").length, 0, "no upstream logout without a bearer");
});

Deno.test("logout: 503 (generic body) when Supabase Auth answers 5xx, and the bearer is NOT evicted", async () => {
  const h = await loadHarness();
  const ip = freshIp();
  const token = fakeSupabaseAccessToken("upstream-5xx");
  intercepted.length = 0;
  await withFault(
    authFault(() => new Response("bad gateway", { status: 502 })),
    async () => {
      const response = await h.handler(userRequest("POST", "/v1/auth/logout", { token, ip }));
      assertEquals(response.status, 503);
      const body = (await response.json()) as { error: { message: string } };
      assertEquals(body.error.message, "Sign-out is temporarily unavailable. Please try again.");

      // Upstream still holds the session, so the cached verification stays
      // valid: the next request is served without a second getUser.
      const getUserCalls = () => interceptedTo("/auth/v1/user").length;
      const before = getUserCalls();
      assertEquals(before, 1, "the logout itself verified the bearer once");
      const after = await h.handler(userRequest("GET", "/v1/me/saved-drills", { token, ip }));
      assertEquals(after.status, 200);
      assertEquals(getUserCalls(), before, "served from the (un-evicted) auth cache");
    },
  );
});

Deno.test("LOGOUT-1 /v1/auth/logout answers 503 (not 500) when Auth is unreachable", async () => {
  const h = await loadHarness();
  const ip = freshIp();
  const token = fakeSupabaseAccessToken("network");
  const response = await withFault(
    authFault(() => Promise.reject(new TypeError("connection reset"))),
    () => h.handler(userRequest("POST", "/v1/auth/logout", { token, ip })),
  );
  const body = await response.text();
  console.log(`  [LOGOUT-1] observed ${response.status} ${body}`);
  assertEquals(
    response.status,
    503,
    `logout on an Auth network error must be the retryable 503, observed ${response.status}`,
  );
  assertEquals(
    JSON.parse(body),
    { error: { message: "Sign-out is temporarily unavailable. Please try again." } },
    "5xx bodies stay generic",
  );
});
