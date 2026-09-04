// STRUCTURAL AUDIT #1 (edge-domain-routes) — Supabase Auth outage taxonomy.
//
// The durable-session contract (AGENTS.md "Auth sessions") says the ONE
// implicit sign-out in the app is the server refusing the refresh token with
// 401/403 (apps/mobile/src/account/sessionLifecycle.ts:89 → SessionRefreshError
// retryable=false → authStore dropRevokedSession). Anything transient MUST
// therefore surface as 5xx/429 from POST /v1/auth/refresh, never as 401.
//
// These tests drive the REAL handler (routesHarness) and replace the fake
// Supabase Auth with failure shapes GoTrue can actually produce: an HTTP 5xx,
// a non-JSON 5xx (gateway page), and a transport failure (fetch rejects).
//
// RESULT ON 4d812e1a: the HTTP 5xx cases are mapped to 503 (correct); the
// transport-failure case is mapped to 401 (defect: supabase-js reports a
// transport failure as AuthRetryableFetchError with status 0, and
// refreshSessionRoute only treats status >= 500 as transient). supabase-js
// retries the refresh internally for ~25 s before giving up, and the mobile
// client aborts at 15 s (sessionLifecycle.ts REQUEST_TIMEOUT_MS) — so today
// the 401 is usually masked by a client timeout; nothing pins that coupling.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  fakeGoogleIdToken,
  loadHarness,
  userRequest,
} from "./routesHarness.ts";

type FetchFn = typeof fetch;

/** Wrap the harness fetch for one test: `intercept` may return a Response
 * (or throw) for URLs it wants to own; anything else falls through. */
async function withAuthFailure<T>(
  intercept: (url: string, method: string) => Promise<Response | null>,
  run: () => Promise<T>,
): Promise<T> {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const owned = await intercept(request.url, request.method);
    if (owned) return owned;
    return inner(input, init);
  }) as FetchFn;
  try {
    return await run();
  } finally {
    globalThis.fetch = inner;
  }
}

const isRefreshCall = (url: string) =>
  url.includes("/auth/v1/token") && url.includes("grant_type=refresh_token");

Deno.test("refresh: GoTrue JSON 503 → 503 (transient; device stays signed in)", async () => {
  const h = await loadHarness();
  const res = await withAuthFailure(
    async (url) =>
      isRefreshCall(url)
        ? new Response(JSON.stringify({ message: "service unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
        : null,
    () =>
      h.handler(
        userRequest("POST", "/v1/auth/refresh", {
          ip: "203.0.113.150",
          body: { refreshToken: "rt-503" },
        }),
      ),
  );
  assertEquals(res.status, 503);
  await res.body?.cancel();
});

Deno.test("refresh: GoTrue non-JSON 500 (gateway page) → 5xx, never 401", async () => {
  const h = await loadHarness();
  const res = await withAuthFailure(
    async (url) =>
      isRefreshCall(url)
        ? new Response("<html>500 Internal Server Error</html>", {
          status: 500,
          headers: { "Content-Type": "text/html" },
        })
        : null,
    () =>
      h.handler(
        userRequest("POST", "/v1/auth/refresh", {
          ip: "203.0.113.151",
          body: { refreshToken: "rt-500-html" },
        }),
      ),
  );
  const body = (await res.json()) as { error: { message: string } };
  assertEquals(
    res.status >= 500,
    true,
    `expected a retryable 5xx, got ${res.status} ${JSON.stringify(body)}`,
  );
});

Deno.test(
  "REPRO: refresh: transport failure reaching GoTrue (fetch rejects) → 401 'Sign in again' — the app signs the device out",
  async () => {
    const h = await loadHarness();
    const res = await withAuthFailure(
      async (url) => {
        if (isRefreshCall(url)) {
          throw new TypeError("error sending request: connection reset");
        }
        return null;
      },
      () =>
        h.handler(
          userRequest("POST", "/v1/auth/refresh", {
            ip: "203.0.113.152",
            body: { refreshToken: "rt-network" },
          }),
        ),
    );
    const body = (await res.json()) as { error: { message: string } };
    // Contract: a transient failure must be 5xx so sessionKeeper retries with
    // backoff (sessionLifecycle.ts:89 treats 401/403 as revoked → sign-out).
    assertEquals(
      res.status,
      503,
      `expected 503 for a transport failure, got ${res.status} ${
        JSON.stringify(body)
      }`,
    );
  },
);

Deno.test(
  "authenticate(): GoTrue 503 on getUser for a session bearer → 401 (client then hits /v1/auth/refresh; documented)",
  async () => {
    const h = await loadHarness();
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(
      /=+$/,
      "",
    );
    const payload = btoa(
      JSON.stringify({
        iss: "http://supabase.test/auth/v1",
        sub: crypto.randomUUID(),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).replace(/=+$/, "");
    const sessionToken = `${header}.${payload}.sig`;
    const res = await withAuthFailure(
      async (url) =>
        url.includes("/auth/v1/user")
          ? new Response(JSON.stringify({ message: "unavailable" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          })
          : null,
      () =>
        h.handler(
          userRequest("GET", "/v1/me", {
            token: sessionToken,
            ip: "203.0.113.153",
          }),
        ),
    );
    const body = (await res.json()) as { error: { message: string } };
    assertEquals(res.status, 401);
    assertStringIncludes(body.error.message, "no longer valid");
  },
);

Deno.test(
  "bootstrap: GoTrue transport failure during signInWithIdToken → 401 (mobile: account.rejected, non-retryable)",
  async () => {
    const h = await loadHarness();
    const res = await withAuthFailure(
      async (url) => {
        if (
          url.includes("/auth/v1/token") && url.includes("grant_type=id_token")
        ) {
          throw new TypeError("error sending request: dns failure");
        }
        return null;
      },
      () =>
        h.handler(
          userRequest("POST", "/v1/account/bootstrap", {
            token: fakeGoogleIdToken(crypto.randomUUID()),
            ip: "203.0.113.154",
            body: {},
          }),
        ),
    );
    const body = (await res.json()) as { error: { message: string } };
    assertEquals(res.status, 401, JSON.stringify(body));
    assertStringIncludes(body.error.message, "could not be verified");
  },
);
