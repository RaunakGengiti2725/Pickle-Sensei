// POST /v1/auth/logout contract through the REAL handler (routesHarness:
// Supabase stubbed at the fetch layer, no Upstash → per-isolate cache):
//
//   204  upstream scope=local revocation succeeded (or the session was gone)
//   401  no / invalid bearer — logout is an authenticated route
//   503  Supabase Auth answered 5xx OR could not be reached at all; the app
//        retries, and the bearer stays cached because nothing was revoked.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json auth_logout_test.ts

import { assert, assertEquals } from "@std/assert";
import { loadHarness, SUPABASE_URL, TEST_USER_ID } from "./routesHarness.ts";

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A syntactically valid Supabase-issued ACCESS token (iss ends in /auth/v1). */
function supabaseAccessToken(salt: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: TEST_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      session_id: `session-${salt}`,
      exp: Math.floor(Date.now() / 1000) + 3600,
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

/** Every upstream request seen while a fault is installed (the harness only
 * records the calls that reach its own stub). */
const upstream: Request[] = [];
const upstreamTo = (fragment: string) => upstream.filter((r) => r.url.includes(fragment));

/** Install `fault` in front of the harness' stubbed fetch for the duration of `run`. */
async function withFault<T>(fault: Fault, run: () => Promise<T>): Promise<T> {
  const base = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    upstream.push(request.clone());
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

/** getUser → healthy; /auth/v1/logout → whatever `logout` yields. */
const authFault =
  (logout: () => Promise<Response> | Response): Fault =>
  (request) => {
    if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      return jsonResponse(200, healthyUser());
    }
    if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/logout`)) {
      return logout();
    }
    return null;
  };

let ipCounter = 0;
const freshIp = () => `192.0.2.${++ipCounter}`;

async function send(
  handler: (request: Request) => Promise<Response>,
  init: { method: string; path: string; ip: string; bearer?: string },
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { "x-forwarded-for": init.ip };
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  const response = await handler(
    new Request(`http://edge.test${init.path}`, {
      method: init.method,
      headers,
    }),
  );
  return { status: response.status, body: await response.text() };
}

Deno.test("logout: 204 when Supabase Auth revokes the session (scope=local)", async () => {
  const h = await loadHarness();
  upstream.length = 0;
  const ip = freshIp();
  const bearer = supabaseAccessToken("ok");
  const observed = await withFault(
    authFault(() => new Response(null, { status: 204 })),
    () => send(h.handler, { method: "POST", path: "/v1/auth/logout", ip, bearer }),
  );
  assertEquals(observed.status, 204, `expected 204, observed ${observed.status} ${observed.body}`);
  const logoutCalls = upstreamTo("/auth/v1/logout");
  assertEquals(logoutCalls.length, 1, "exactly one upstream revocation");
  assert(
    logoutCalls[0].url.includes("scope=local"),
    "revocation is scope=local (other devices stay signed in)",
  );
  assertEquals(
    logoutCalls[0].headers.get("authorization"),
    `Bearer ${bearer}`,
    "revocation bears the caller's token",
  );
});

Deno.test("logout: 401 without a bearer token", async () => {
  const h = await loadHarness();
  const observed = await send(h.handler, {
    method: "POST",
    path: "/v1/auth/logout",
    ip: freshIp(),
  });
  assertEquals(observed.status, 401, `expected 401, observed ${observed.status} ${observed.body}`);
  assertEquals(h.callsTo("/auth/v1/").length, 0, "nothing reaches Supabase Auth without a bearer");
});

Deno.test(
  "logout: 503 when Supabase Auth answers 5xx — and the bearer stays cached because nothing was revoked",
  async () => {
    const h = await loadHarness();
    upstream.length = 0;
    const ip = freshIp();
    const bearer = supabaseAccessToken("auth-5xx");
    const observed = await withFault(
      authFault(() => jsonResponse(502, { message: "bad gateway" })),
      () => send(h.handler, { method: "POST", path: "/v1/auth/logout", ip, bearer }),
    );
    assertEquals(
      observed.status,
      503,
      `expected 503, observed ${observed.status} ${observed.body}`,
    );
    assertEquals(
      upstreamTo("/auth/v1/user").length,
      1,
      "the bearer was verified once (cold cache)",
    );

    // The session is still live upstream, so the verified bearer keeps serving
    // from the cache: a failed revocation must not have evicted it.
    const again = await withFault(
      authFault(() => new Response(null, { status: 204 })),
      () =>
        send(h.handler, {
          method: "GET",
          path: "/v1/me/saved-drills",
          ip,
          bearer,
        }),
    );
    assertEquals(again.status, 200, "bearer still authenticates after a failed logout");
    assertEquals(upstreamTo("/auth/v1/user").length, 1, "…from the auth cache (no second getUser)");
  },
);

Deno.test(
  "LOGOUT-1 logout: 503 (not the generic 500) when Supabase Auth is unreachable (fetch rejects)",
  async () => {
    const h = await loadHarness();
    const ip = freshIp();
    const bearer = supabaseAccessToken("auth-network");
    const observed = await withFault(
      authFault(() => Promise.reject(new TypeError("connection reset"))),
      () => send(h.handler, { method: "POST", path: "/v1/auth/logout", ip, bearer }),
    );
    assertEquals(
      observed.status,
      503,
      `logout on an Auth network error must be the retryable 503, observed ${observed.status} ${observed.body}`,
    );
    const body = JSON.parse(observed.body) as { error?: { message?: string } };
    assert(
      /temporarily unavailable|try again/i.test(body.error?.message ?? ""),
      `body must be the generic transient message, observed ${observed.body}`,
    );
  },
);
