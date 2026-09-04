// Reproduction tests for the `edge-routes-account` audit.
//
// Black-box tests of the Edge Function's account routes against a local fake
// Supabase (GoTrue + PostgREST) so no real project is touched. The tests
// CHARACTERIZE current behavior — each `REPRO:` case pins a confirmed defect
// (the assertion is what the function does today, not what it should do).
//
// Run from the repo root (`--no-check` because index.ts has the pre-existing
// untyped-supabase-client errors documented in AGENTS.md; the sibling
// deno.json keeps Deno from touching the root package.json / deno.lock):
//   deno test -A --no-check --config supabase/functions/api/__wf__/deno.json \
//     supabase/functions/api/__wf__/

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

// ─── Fake Supabase ──────────────────────────────────────────────────────────

interface FakeState {
  /** Status for POST /auth/v1/token?grant_type=id_token (200 = succeed). */
  tokenStatus: number;
  tokenCalls: number;
  /** Status for POST /auth/v1/token?grant_type=refresh_token (200 = rotate,
   * 400 = GoTrue refuses the refresh token with invalid_grant). */
  refreshStatus: number;
  /** When true the GoTrue refresh call never gets a response: fetch rejects
   * (connection reset), which supabase-js surfaces as status 0. */
  refreshTransportFailure: boolean;
  refreshCalls: number;
  /** Rows PostgREST returns for account_deletion_requests selects. */
  deletionRows: Array<{ challenge: string; created_at: string; expires_at: string }>;
  /** Last upsert payload PostgREST received for account_deletion_requests. */
  lastUpsert: Record<string, unknown> | null;
  /** Queue of statuses for DELETE /auth/v1/admin/users/:id. */
  adminDeleteStatuses: number[];
  adminDeleteCalls: number;
  revenueCatDeleteCalls: number;
  profileRows: Array<Record<string, unknown>>;
}

const state: FakeState = {
  tokenStatus: 200,
  tokenCalls: 0,
  refreshStatus: 200,
  refreshTransportFailure: false,
  refreshCalls: 0,
  deletionRows: [],
  lastUpsert: null,
  adminDeleteStatuses: [],
  adminDeleteCalls: 0,
  revenueCatDeleteCalls: 0,
  profileRows: [],
};

function resetState(): void {
  state.tokenStatus = 200;
  state.tokenCalls = 0;
  state.refreshStatus = 200;
  state.refreshTransportFailure = false;
  state.refreshCalls = 0;
  state.deletionRows = [];
  state.lastUpsert = null;
  state.adminDeleteStatuses = [];
  state.adminDeleteCalls = 0;
  state.revenueCatDeleteCalls = 0;
  state.profileRows = [];
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const b64url = (input: string): string =>
  btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Unsigned JWT-shaped token; the function only decodes the payload for
 * routing and delegates verification to (our fake) Supabase Auth. */
function providerToken(sub: string): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub,
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    }),
  );
  return `${header}.${payload}.sig`;
}

async function fakeSupabase(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (
    request.method === "POST" &&
    path === "/auth/v1/token" &&
    url.searchParams.get("grant_type") === "refresh_token"
  ) {
    state.refreshCalls += 1;
    if (state.refreshStatus !== 200) {
      return jsonResponse(state.refreshStatus, {
        error: "invalid_grant",
        error_code: "refresh_token_not_found",
        msg: "Invalid Refresh Token: Refresh Token Not Found",
      });
    }
    const body = (await request.json()) as { refresh_token: string };
    const userId = body.refresh_token.replace(/^sb-refresh-/, "");
    return jsonResponse(200, {
      access_token: `sb-access-${userId}-rotated`,
      token_type: "bearer",
      expires_in: 3_600,
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      refresh_token: `sb-refresh-${userId}-rotated`,
      user: { id: userId, aud: "authenticated", role: "authenticated", email: "u@example.com" },
    });
  }

  if (request.method === "POST" && path === "/auth/v1/token") {
    state.tokenCalls += 1;
    if (state.tokenStatus !== 200) {
      return jsonResponse(state.tokenStatus, { code: state.tokenStatus, msg: "upstream down" });
    }
    const body = (await request.json()) as { id_token: string };
    const payloadSegment = body.id_token.split(".")[1];
    const claims = JSON.parse(atob(payloadSegment.replace(/-/g, "+").replace(/_/g, "/"))) as {
      sub: string;
    };
    const userId = claims.sub;
    return jsonResponse(200, {
      access_token: `sb-access-${userId}`,
      token_type: "bearer",
      expires_in: 3_600,
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      refresh_token: `sb-refresh-${userId}`,
      user: { id: userId, aud: "authenticated", role: "authenticated", email: "u@example.com" },
    });
  }

  if (request.method === "DELETE" && path.startsWith("/auth/v1/admin/users/")) {
    state.adminDeleteCalls += 1;
    const status = state.adminDeleteStatuses.shift() ?? 200;
    if (status === 200) return jsonResponse(200, {});
    return jsonResponse(status, {
      code: status,
      error_code: "user_not_found",
      msg: "User not found",
    });
  }

  if (path === "/rest/v1/account_deletion_requests") {
    if (request.method === "POST") {
      state.lastUpsert = (await request.json()) as Record<string, unknown>;
      return new Response(null, { status: 201 });
    }
    if (request.method === "GET") return jsonResponse(200, state.deletionRows);
  }

  if (path === "/rest/v1/account_external_credentials") {
    if (request.method === "GET") return jsonResponse(200, []);
    if (request.method === "POST" || request.method === "PATCH") {
      return new Response(null, { status: 201 });
    }
  }

  if (path === "/rest/v1/profiles" && request.method === "GET") {
    return jsonResponse(200, state.profileRows);
  }

  if (path === "/rest/v1/rpc/access_state" && request.method === "POST") {
    return jsonResponse(200, [{ premium: false, scored_count: 0, reserved_count: 0 }]);
  }

  return jsonResponse(404, { message: `fake supabase: unhandled ${request.method} ${path}` });
}

// ─── Boot the Edge Function in-process ───────────────────────────────────────

const fake = Deno.serve({ port: 0, onListen: () => undefined }, fakeSupabase);
const fakeUrl = `http://127.0.0.1:${fake.addr.port}`;

Deno.env.set("SUPABASE_URL", fakeUrl);
Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_revenuecat");

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  if (request.url.startsWith("https://api.revenuecat.com/v1/subscribers/")) {
    state.revenueCatDeleteCalls += 1;
    assertEquals(request.method, "DELETE");
    assertEquals(request.headers.get("authorization"), "Bearer sk_test_revenuecat");
    return Promise.resolve(new Response(null, { status: 200 }));
  }
  if (
    state.refreshTransportFailure &&
    request.url.startsWith(`${fakeUrl}/auth/v1/token`) &&
    new URL(request.url).searchParams.get("grant_type") === "refresh_token"
  ) {
    state.refreshCalls += 1;
    return Promise.reject(new TypeError("error sending request: connection reset"));
  }
  return realFetch(input, init);
}) as typeof fetch;

type Handler = (request: Request) => Promise<Response> | Response;
let handler: Handler | null = null;
const realServe = Deno.serve;
// index.ts calls Deno.serve(handler) at module load; capture the handler
// instead of opening a second port.
(Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
  handler = (typeof args[0] === "function" ? args[0] : args[1]) as Handler;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
};
await import("../index.ts");
(Deno as unknown as { serve: unknown }).serve = realServe;
if (!handler) throw new Error("index.ts did not register a Deno.serve handler");
const api: Handler = handler;

const call = (
  method: string,
  path: string,
  token: string,
  body?: unknown,
  ip = "203.0.113.7",
): Promise<Response> =>
  Promise.resolve(
    api(
      new Request(`http://edge.local/functions/v1/api${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-forwarded-for": ip,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  );

const pastIso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const futureIso = (msAhead: number): string => new Date(Date.now() + msAhead).toISOString();

// ─── Baseline behavior (sanity: the harness exercises the real handlers) ─────

Deno.test("delete-request mints a UUID challenge with a 15-minute expiry", async () => {
  resetState();
  const token = providerToken(crypto.randomUUID());
  const res = await call("POST", "/v1/me/delete-request", token);
  assertEquals(res.status, 200);
  const body = (await res.json()) as { challenge: string; expiresAt: string };
  assertEquals(body.challenge, state.lastUpsert?.challenge);
  const ttlMs = Date.parse(body.expiresAt) - Date.now();
  assertEquals(ttlMs > 14 * 60_000 && ttlMs <= 15 * 60_000, true);
});

Deno.test("delete-confirm rejects a non-UUID challenge with 400 and no admin call", async () => {
  resetState();
  const token = providerToken(crypto.randomUUID());
  const res = await call("POST", "/v1/me/delete-confirm", token, { challenge: "nope" });
  assertEquals(res.status, 400);
  assertEquals(
    ((await res.json()) as { error: { code: string } }).error.code,
    "validation.account_deletion",
  );
  assertEquals(state.adminDeleteCalls, 0);
});

Deno.test("delete-confirm enforces the 3-second minimum challenge age (429)", async () => {
  resetState();
  const token = providerToken(crypto.randomUUID());
  const challenge = crypto.randomUUID();
  state.deletionRows = [{ challenge, created_at: pastIso(500), expires_at: futureIso(60_000) }];
  const res = await call("POST", "/v1/me/delete-confirm", token, { challenge });
  assertEquals(res.status, 429);
  assertEquals(
    ((await res.json()) as { error: { code: string } }).error.code,
    "account.deletion_too_fast",
  );
  assertEquals(state.adminDeleteCalls, 0);
});

Deno.test("onboarding rejects malformed JSON with 400, not 5xx", async () => {
  resetState();
  const token = providerToken(crypto.randomUUID());
  const res = await api(
    new Request("http://edge.local/functions/v1/api/v1/me/onboarding", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{not json",
    }),
  );
  assertEquals(res.status, 400);
});

// ─── REPRO: Supabase Auth outage is reported as a credential rejection ───────

Deno.test(
  "REPRO: GoTrue 503 during signInWithIdToken is returned as 401 'token could not be verified'",
  async () => {
    resetState();
    state.tokenStatus = 503;
    const token = providerToken(crypto.randomUUID());
    const res = await call("POST", "/v1/account/bootstrap", token);
    // Expected for a retryable upstream failure: 5xx (the mobile bootstrap maps
    // 401/403 to the non-retryable `account.rejected`). Actual today: 401.
    assertEquals(res.status, 401);
    assertStringIncludes(
      ((await res.json()) as { error: { message: string } }).error.message,
      "could not be verified",
    );
    assertEquals(state.tokenCalls, 1);
  },
);

// ─── /v1/auth/refresh: only a GoTrue REFUSAL may sign the device out ────────
// AGENTS.md "Auth sessions": the ONE implicit sign-out is the server refusing
// the refresh token (401/403). A refresh that never reached GoTrue is a
// transient failure the sessionKeeper retries — and it must not spend the
// per-IP auth-failure budget, which is reserved for credential probing.

const AUTH_FAILURE_LIMIT = 30;

/** Burn `count` auth failures for `ip` with unverifiable provider tokens. */
async function burnAuthFailures(ip: string, count: number): Promise<void> {
  state.tokenStatus = 401;
  for (let index = 0; index < count; index += 1) {
    const res = await call(
      "GET",
      "/v1/me/access",
      providerToken(crypto.randomUUID()),
      undefined,
      ip,
    );
    assertEquals(res.status, 401, `auth failure ${index + 1} of ${count}`);
    await res.body?.cancel();
  }
  state.tokenStatus = 200;
}

Deno.test(
  "refresh: GoTrue unreachable (fetch rejects) is a retryable 5xx and does not spend the auth-failure budget",
  async () => {
    resetState();
    const ip = "203.0.113.71";
    // One failure short of the budget: a 401 here would be the 30th and trip it.
    await burnAuthFailures(ip, AUTH_FAILURE_LIMIT - 1);

    state.refreshTransportFailure = true;
    const res = await call(
      "POST",
      "/v1/auth/refresh",
      "unused-bearer",
      { refreshToken: "sb-refresh-transport-failure" },
      ip,
    );
    state.refreshTransportFailure = false;
    assertEquals(
      [502, 503].includes(res.status),
      true,
      `expected a retryable 5xx for a transport failure, got ${res.status}`,
    );
    const body = (await res.json()) as { error: { message: string } };
    assertStringIncludes(body.error.message, "temporarily unavailable");
    assertEquals(body.error.message.includes("Sign in again"), false);
    assertEquals(state.refreshCalls >= 1, true, "the refresh reached the (failing) GoTrue call");

    // The budget still has its last slot: a following request from the same
    // IP is judged on its own credentials (401), not refused up front (429).
    state.tokenStatus = 401;
    const following = await call(
      "GET",
      "/v1/me/access",
      providerToken(crypto.randomUUID()),
      undefined,
      ip,
    );
    assertEquals(following.status, 401);
    await following.body?.cancel();
    // …and that genuine failure was the 30th: the budget is now exhausted,
    // proving the counter is live and the 5xx above was the one uncounted call.
    const exhausted = await call(
      "GET",
      "/v1/me/access",
      providerToken(crypto.randomUUID()),
      undefined,
      ip,
    );
    assertEquals(exhausted.status, 429);
    await exhausted.body?.cancel();
    state.tokenStatus = 200;
  },
);

Deno.test(
  "refresh: GoTrue 400 invalid_grant is still a 401 'Sign in again' that counts as an auth failure",
  async () => {
    resetState();
    const ip = "203.0.113.72";
    state.refreshStatus = 400;
    const res = await call(
      "POST",
      "/v1/auth/refresh",
      "unused-bearer",
      { refreshToken: "sb-refresh-revoked" },
      ip,
    );
    assertEquals(res.status, 401);
    assertStringIncludes(
      ((await res.json()) as { error: { message: string } }).error.message,
      "Sign in again",
    );
    assertEquals(state.refreshCalls, 1);

    // The refusal spent one auth-failure slot: 29 more genuine failures
    // exhaust the budget and the next request is refused up front.
    await burnAuthFailures(ip, AUTH_FAILURE_LIMIT - 1);
    state.tokenStatus = 401;
    const exhausted = await call(
      "GET",
      "/v1/me/access",
      providerToken(crypto.randomUUID()),
      undefined,
      ip,
    );
    assertEquals(exhausted.status, 429);
    await exhausted.body?.cancel();
    state.tokenStatus = 200;
  },
);

Deno.test("refresh: a GoTrue rotation returns the new session", async () => {
  resetState();
  const res = await call(
    "POST",
    "/v1/auth/refresh",
    "unused-bearer",
    { refreshToken: "sb-refresh-user-1" },
    "203.0.113.73",
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as { session: { accessToken: string; refreshToken: string } };
  assertEquals(body.session.accessToken, "sb-access-user-1-rotated");
  assertEquals(body.session.refreshToken, "sb-refresh-user-1-rotated");
});

// ─── REPRO: delete-confirm is not idempotent under duplicate requests ────────

Deno.test(
  "two concurrent delete-confirms are idempotent even when GoTrue reports one user already gone",
  async () => {
    resetState();
    const token = providerToken(crypto.randomUUID());
    const challenge = crypto.randomUUID();
    state.deletionRows = [
      { challenge, created_at: pastIso(10_000), expires_at: futureIso(60_000) },
    ];
    // The first admin deleteUser succeeds; the duplicate finds the user gone.
    state.adminDeleteStatuses = [200, 404];

    const [a, b] = await Promise.all([
      call("POST", "/v1/me/delete-confirm", token, { challenge }),
      call("POST", "/v1/me/delete-confirm", token, { challenge }),
    ]);
    const statuses = [a.status, b.status].sort();
    assertEquals(statuses, [200, 200]);
    assertEquals(((await a.json()) as { deleted: boolean }).deleted, true);
    assertEquals(((await b.json()) as { deleted: boolean }).deleted, true);
    assertEquals(state.adminDeleteCalls, 2);
  },
);

Deno.test(
  "replaying delete-confirm after deleteUser succeeded remains a successful deletion",
  async () => {
    resetState();
    const token = providerToken(crypto.randomUUID());
    const challenge = crypto.randomUUID();
    state.deletionRows = [
      { challenge, created_at: pastIso(10_000), expires_at: futureIso(60_000) },
    ];
    // Simulates the client retrying after a lost response while the pending row
    // is still visible (deleteUser committed but the cascade/replica is behind
    // or the two requests interleave). GoTrue answers 404 user_not_found.
    state.adminDeleteStatuses = [404];
    const res = await call("POST", "/v1/me/delete-confirm", token, { challenge });
    assertEquals(res.status, 200);
    assertEquals(((await res.json()) as { deleted: boolean }).deleted, true);
  },
);

// ─── Verified-session cache is evicted by account deletion ──────────────────

Deno.test(
  "after a successful delete-confirm the bearer is re-verified with Supabase Auth, not served from cache",
  async () => {
    resetState();
    const userId = crypto.randomUUID();
    const token = providerToken(userId);
    const challenge = crypto.randomUUID();
    state.deletionRows = [
      { challenge, created_at: pastIso(10_000), expires_at: futureIso(60_000) },
    ];
    state.adminDeleteStatuses = [200];

    const deleted = await call("POST", "/v1/me/delete-confirm", token, { challenge });
    assertEquals(deleted.status, 200);
    assertEquals(state.tokenCalls, 1);

    // Post-deletion: the profile and deletion rows are gone (cascade).
    state.deletionRows = [];
    state.profileRows = [];

    // The cached session for the deleted user id must not be reused: the next
    // request with the same bearer goes back to Supabase Auth.
    const access = await call("GET", "/v1/me/access", token);
    assertEquals(state.tokenCalls, 2);
    assertEquals(access.status, 200);

    // Every further request keeps being verified from a fresh cache entry, so
    // a stale identity can never outlive the account.
    const again = await call("POST", "/v1/me/delete-confirm", token, { challenge });
    assertEquals(again.status, 403);
    assertEquals(
      ((await again.json()) as { error: { code: string } }).error.code,
      "account.deletion_challenge_invalid",
    );
  },
);

Deno.test({
  name: "teardown fake supabase",
  fn: async () => {
    await fake.shutdown();
    globalThis.fetch = realFetch;
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
