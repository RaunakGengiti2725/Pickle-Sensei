// Structural audit #2 (pass 1) — probes for the edge fn's session routes:
// POST /v1/auth/refresh, POST /v1/auth/logout and the Supabase-access-token
// branch of authenticate(). Every request goes through the REAL handler via
// routesHarness.ts; only the GoTrue endpoints the probe is about are
// re-stubbed per test (429 / 5xx / network failure).
//
// Convention: `PROBE:` tests assert the CONTRACT the code comments and
// AGENTS.md describe (transient upstream trouble is 5xx to the app, only a
// refused credential is 401). A failing PROBE is an audit finding, not a
// broken test — do not flip the assertion to the observed value. `PIN:` tests
// assert behaviour that was verified to hold.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json audit_s2_auth_routes_test.ts

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { loadHarness, SUPABASE_URL, TEST_USER_ID, userRequest } from "./routesHarness.ts";

const harness = await loadHarness();

// ─── Per-test upstream overrides (layered over the harness's fetch stub) ─────

type Upstream = (request: Request) => Promise<Response> | Response;

interface Overrides {
  /** POST /auth/v1/token?grant_type=refresh_token */
  refresh: Upstream | null;
  /** GET /auth/v1/user */
  user: Upstream | null;
  /** POST /auth/v1/logout */
  logout: Upstream | null;
}

const overrides: Overrides = { refresh: null, user: null, logout: null };
const upstreamCalls: Array<{ kind: keyof Overrides; request: Request }> = [];

function resetOverrides(): void {
  overrides.refresh = null;
  overrides.user = null;
  overrides.logout = null;
  upstreamCalls.length = 0;
}

const callsOf = (kind: keyof Overrides) => upstreamCalls.filter((c) => c.kind === kind);

const harnessFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === new URL(SUPABASE_URL).origin) {
    if (
      url.pathname === "/auth/v1/token" &&
      url.searchParams.get("grant_type") === "refresh_token"
    ) {
      upstreamCalls.push({ kind: "refresh", request: request.clone() });
      if (overrides.refresh) return overrides.refresh(request);
    }
    if (url.pathname === "/auth/v1/user") {
      upstreamCalls.push({ kind: "user", request: request.clone() });
      if (overrides.user) return overrides.user(request);
    }
    if (url.pathname === "/auth/v1/logout") {
      upstreamCalls.push({ kind: "logout", request: request.clone() });
      if (overrides.logout) return overrides.logout(request);
    }
  }
  return harnessFetch(input, init);
}) as typeof fetch;

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A Supabase-issued access token (iss …/auth/v1) — signature is not checked
 * by the edge fn; verification is delegated to (the stubbed) GoTrue. */
function supabaseBearer(options: { sub?: string; expInSeconds?: number; nonce?: string } = {}) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: options.sub ?? TEST_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + (options.expInSeconds ?? 3600),
      nonce: options.nonce ?? crypto.randomUUID(),
    }),
  );
  return `${header}.${payload}.sig`;
}

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
  access_token: supabaseBearer({ sub }),
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: `rotated-${crypto.randomUUID()}`,
  user: gotrueUser(sub),
});

let ipCounter = 0;
/** A fresh client IP per test so the per-IP memory windows never bleed. */
const freshIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

function refreshRequest(ip: string, body: unknown = { refreshToken: "rt-1" }): Request {
  return new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

/** Keep a multi-request probe inside ONE aligned 300 s auth-failure bucket. */
async function avoidAuthFailBucketEdge(): Promise<void> {
  const windowMs = 300_000;
  const remaining = windowMs - (Date.now() % windowMs);
  if (remaining < 5_000) await new Promise((r) => setTimeout(r, remaining + 50));
}

const bodyOf = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json().catch(() => ({}))) as Record<string, unknown>;

// ─── /v1/auth/refresh ────────────────────────────────────────────────────────

Deno.test("PIN: refresh rotates a refresh token into a session view (200)", async () => {
  resetOverrides();
  overrides.refresh = () => jsonResponse(200, gotrueSession());
  const response = await harness.handler(refreshRequest(freshIp()));
  assertEquals(response.status, 200);
  const body = await bodyOf(response);
  const session = body.session as Record<string, unknown>;
  assertEquals(typeof session.accessToken, "string");
  assertEquals(typeof session.refreshToken, "string");
  assertEquals(typeof session.expiresAt, "number");
  assertEquals(callsOf("refresh").length, 1);
  const sent = (await callsOf("refresh")[0].request.json()) as { refresh_token: string };
  assertEquals(sent.refresh_token, "rt-1");
});

Deno.test("PIN: refresh without refreshToken → 400 validation.refresh, GoTrue untouched", async () => {
  resetOverrides();
  const response = await harness.handler(refreshRequest(freshIp(), {}));
  assertEquals(response.status, 400);
  const body = await bodyOf(response);
  assertEquals((body.error as { code: string }).code, "validation.refresh");
  assertEquals(callsOf("refresh").length, 0);
});

Deno.test("PIN: refresh refused by GoTrue (400 invalid_grant) → 401", async () => {
  resetOverrides();
  overrides.refresh = () =>
    jsonResponse(400, {
      code: 400,
      error_code: "refresh_token_not_found",
      msg: "Invalid Refresh Token: Refresh Token Not Found",
    });
  const response = await harness.handler(refreshRequest(freshIp()));
  assertEquals(response.status, 401);
});

Deno.test("PIN: refresh body stream failure → 400 validation.refresh (swallowed to empty body), not 5xx", async () => {
  resetOverrides();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"refreshToken":"rt-'));
      controller.error(new Error("client went away"));
    },
  });
  const request = new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
    body,
  });
  const response = await harness.handler(request);
  assertEquals(response.status, 400);
  assertEquals(((await bodyOf(response)).error as { code: string }).code, "validation.refresh");
  assertEquals(callsOf("refresh").length, 0);
});

Deno.test("PROBE: refresh — GoTrue 429 (rate limited) is transient, must not be 401 (mobile signs out on 401)", async () => {
  // apps/mobile/src/account/sessionLifecycle.ts:89-91 treats ONLY 401/403 as
  // "refresh token dead → sign out"; every other status is retryable. A GoTrue
  // 429 says nothing about the token, so the edge must answer 429/503, never 401.
  resetOverrides();
  overrides.refresh = () =>
    new Response(JSON.stringify({ code: 429, error_code: "over_request_rate_limit", msg: "Rate limit exceeded" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "5" },
    });
  const response = await harness.handler(refreshRequest(freshIp()));
  await response.body?.cancel();
  assertNotEquals(
    response.status,
    401,
    "upstream 429 was mapped to 401 — the app treats that as a revoked refresh token and signs the user out",
  );
});

Deno.test("PROBE: refresh — GoTrue 429 must not be charged as an auth FAILURE against the caller's IP", async () => {
  // index.ts:2949 charges authfail for every 401 from refreshSessionRoute;
  // with the 429→401 mapping, 30 upstream rate-limit answers within 300 s lock
  // the IP out of bootstrap/refresh/every route (index.ts:2894-2900).
  await avoidAuthFailBucketEdge();
  resetOverrides();
  const ip = freshIp();
  overrides.refresh = () => jsonResponse(429, { code: 429, msg: "Rate limit exceeded" });
  for (let i = 0; i < 30; i += 1) {
    const r = await harness.handler(refreshRequest(ip));
    await r.body?.cancel();
  }
  // Refresh budget is 30/60 s (AUTH_REFRESH_LIMIT) — use a different route to
  // observe the auth-failure gate alone: bootstrap with a valid provider token.
  const bootstrap = await harness.handler(userRequest("POST", "/v1/account/bootstrap", { ip }));
  await bootstrap.body?.cancel();
  assertNotEquals(
    bootstrap.status,
    429,
    "IP locked out (authfail budget spent) purely by upstream 429s — no credential was ever refused",
  );
});

Deno.test("PROBE: refresh — GoTrue network failure (fetch throws) is transient: not 401, answered within the app's 15 s timeout", async () => {
  // auth-js turns a thrown fetch into AuthRetryableFetchError{status:0} and
  // retries with backoff for ~25 s (AUTO_REFRESH_TICK_DURATION_MS); status 0
  // is < 500 so index.ts:562-565 answers 401. The app aborts at 15 s
  // (sessionLifecycle.ts REQUEST_TIMEOUT_MS) so the 401 is mostly unseen, but
  // the edge invocation burns ~25 s per attempt and any 401 that does land
  // signs the user out.
  resetOverrides();
  overrides.refresh = () => {
    throw new TypeError("error sending request: connection refused");
  };
  const started = performance.now();
  const response = await harness.handler(refreshRequest(freshIp()));
  const elapsedMs = performance.now() - started;
  await response.body?.cancel();
  console.log(`refresh(network failure): status=${response.status} elapsed=${Math.round(elapsedMs)}ms`);
  assertNotEquals(response.status, 401, "upstream network failure was mapped to 401");
  assert(elapsedMs < 15_000, `edge answered after ${Math.round(elapsedMs)} ms > mobile 15 s timeout`);
});

Deno.test("PROBE: refresh — GoTrue 503 → 503 delivered within the app's 15 s timeout", async () => {
  // Status mapping is right (≥500 → 503) but auth-js retries 5xx for ~25 s
  // before the edge can answer; the app has already aborted at 15 s.
  resetOverrides();
  overrides.refresh = () => jsonResponse(503, { code: 503, msg: "service unavailable" });
  const started = performance.now();
  const response = await harness.handler(refreshRequest(freshIp()));
  const elapsedMs = performance.now() - started;
  await response.body?.cancel();
  console.log(`refresh(503): status=${response.status} elapsed=${Math.round(elapsedMs)}ms`);
  assertEquals(response.status, 503);
  assert(elapsedMs < 15_000, `edge answered after ${Math.round(elapsedMs)} ms > mobile 15 s timeout`);
});

// ─── authenticate(): Supabase access-token branch ────────────────────────────

Deno.test("PIN: access token verified via getUser once, then served from the auth cache", async () => {
  resetOverrides();
  overrides.user = () => jsonResponse(200, gotrueUser());
  const token = supabaseBearer();
  const ip = freshIp();
  const first = await harness.handler(userRequest("GET", "/v1/me/access", { token, ip }));
  await first.body?.cancel();
  assertNotEquals(first.status, 401);
  const second = await harness.handler(userRequest("GET", "/v1/me/access", { token, ip }));
  await second.body?.cancel();
  assertNotEquals(second.status, 401);
  assertEquals(callsOf("user").length, 1, "second request should hit the auth cache");
});

Deno.test("PIN: expired access token → 401 before any GoTrue call", async () => {
  resetOverrides();
  overrides.user = () => jsonResponse(200, gotrueUser());
  const token = supabaseBearer({ expInSeconds: -5 });
  const response = await harness.handler(userRequest("GET", "/v1/me/access", { token, ip: freshIp() }));
  assertEquals(response.status, 401);
  await response.body?.cancel();
  assertEquals(callsOf("user").length, 0);
});

Deno.test("PROBE: authenticate — getUser 503 (GoTrue outage) must be 503, not 401 'session no longer valid'", async () => {
  // index.ts:521-524 folds every getUser error into 401. The app reacts to a
  // 401 by forcing a refresh (authStore.handleApiUnauthorized → refreshSessionNow),
  // so a GoTrue outage becomes a refresh storm against the same outage.
  resetOverrides();
  overrides.user = () => jsonResponse(503, { code: 503, msg: "service unavailable" });
  const response = await harness.handler(
    userRequest("GET", "/v1/me/access", { token: supabaseBearer(), ip: freshIp() }),
  );
  await response.body?.cancel();
  assertEquals(callsOf("user").length, 1);
  assertEquals(response.status, 503);
});

Deno.test("PROBE: authenticate — getUser network failure must not be 401", async () => {
  resetOverrides();
  overrides.user = () => {
    throw new TypeError("error sending request: connection reset");
  };
  const response = await harness.handler(
    userRequest("GET", "/v1/me/access", { token: supabaseBearer(), ip: freshIp() }),
  );
  await response.body?.cancel();
  assertNotEquals(response.status, 401);
});

Deno.test("PROBE: authenticate — 30 getUser outages must not lock the IP out of bootstrap (authfail charged for upstream errors)", async () => {
  // Each 401 from authenticate() is charged to authfail (index.ts:2955). During
  // a GoTrue outage a single device retrying sync/access/progress reaches 30 in
  // well under 300 s and is then refused everywhere — including bootstrap and
  // refresh — for the rest of the window, even after GoTrue recovers.
  await avoidAuthFailBucketEdge();
  resetOverrides();
  const ip = freshIp();
  overrides.user = () => jsonResponse(503, { code: 503, msg: "service unavailable" });
  for (let i = 0; i < 30; i += 1) {
    const r = await harness.handler(
      userRequest("GET", "/v1/me/access", { token: supabaseBearer(), ip }),
    );
    await r.body?.cancel();
  }
  overrides.user = null;
  const bootstrap = await harness.handler(userRequest("POST", "/v1/account/bootstrap", { ip }));
  await bootstrap.body?.cancel();
  assertNotEquals(bootstrap.status, 429, "IP locked out by upstream outages, not by refused credentials");
});

// ─── /v1/auth/logout ─────────────────────────────────────────────────────────

Deno.test("PIN: logout → 204, GoTrue /logout?scope=local called with the bearer, auth cache dropped", async () => {
  resetOverrides();
  overrides.user = () => jsonResponse(200, gotrueUser());
  overrides.logout = () => new Response(null, { status: 204 });
  const token = supabaseBearer();
  const ip = freshIp();
  const warm = await harness.handler(userRequest("GET", "/v1/me/access", { token, ip }));
  await warm.body?.cancel();
  assertEquals(callsOf("user").length, 1);

  const logout = await harness.handler(userRequest("POST", "/v1/auth/logout", { token, ip }));
  assertEquals(logout.status, 204);
  assertEquals(callsOf("logout").length, 1);
  const upstream = callsOf("logout")[0].request;
  assertEquals(new URL(upstream.url).searchParams.get("scope"), "local");
  assertEquals(upstream.headers.get("authorization"), `Bearer ${token}`);

  // The bearer is gone from this isolate's cache: the next use re-verifies.
  const after = await harness.handler(userRequest("GET", "/v1/me/access", { token, ip }));
  await after.body?.cancel();
  assertEquals(callsOf("user").length, 2, "post-logout request must re-verify with GoTrue");
});

Deno.test("PIN: logout — GoTrue 401 (session already gone) → 204; GoTrue 503 → 503", async () => {
  resetOverrides();
  overrides.user = () => jsonResponse(200, gotrueUser());
  overrides.logout = () => jsonResponse(401, { code: 401, msg: "invalid JWT" });
  const gone = await harness.handler(
    userRequest("POST", "/v1/auth/logout", { token: supabaseBearer(), ip: freshIp() }),
  );
  assertEquals(gone.status, 204);
  overrides.logout = () => jsonResponse(503, { code: 503, msg: "down" });
  const down = await harness.handler(
    userRequest("POST", "/v1/auth/logout", { token: supabaseBearer(), ip: freshIp() }),
  );
  await down.body?.cancel();
  assertEquals(down.status, 503);
});

Deno.test("PROBE: logout — GoTrue network failure (fetch throws) must be 503, not an unhandled 500", async () => {
  // index.ts:576-579 awaits a raw fetch with no try/catch; a rejected fetch
  // escapes logoutRoute and lands in the outer handler's generic 500
  // (index.ts:2814-2815) with an "unhandled error" log line.
  resetOverrides();
  overrides.user = () => jsonResponse(200, gotrueUser());
  overrides.logout = () => {
    throw new TypeError("error sending request: connection refused");
  };
  const response = await harness.handler(
    userRequest("POST", "/v1/auth/logout", { token: supabaseBearer(), ip: freshIp() }),
  );
  await response.body?.cancel();
  assertEquals(response.status, 503);
});

Deno.test("PROBE: logout with an expired access token still reaches GoTrue (the refresh token must die on sign-out)", async () => {
  // Sign-out is the app's ONLY chance to revoke the device's refresh token
  // (apps/mobile/src/auth/authStore.ts:721 → revokeApiSession with the current
  // bearer). authenticate() refuses an expired bearer before logoutRoute runs
  // (index.ts:486-491, 2953-2956), so the refresh token stays valid server-side
  // and the miss is charged as an auth FAILURE.
  resetOverrides();
  overrides.logout = () => new Response(null, { status: 204 });
  const response = await harness.handler(
    userRequest("POST", "/v1/auth/logout", { token: supabaseBearer({ expInSeconds: -60 }), ip: freshIp() }),
  );
  await response.body?.cancel();
  assertEquals(callsOf("logout").length, 1, "no revocation was attempted for an expired bearer");
  assertEquals(response.status, 204);
});

Deno.test({
  name: "teardown: restore fetch",
  fn: () => {
    globalThis.fetch = harnessFetch;
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
