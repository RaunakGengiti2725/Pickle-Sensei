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
  /** GET /auth/v1/user verifications (one per uncached session bearer). */
  userCalls: number;
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
  userCalls: 0,
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
  state.userCalls = 0;
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
function jwt(claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(claims))}.sig`;
}

function claimsOf(token: string): Record<string, unknown> {
  const segment = token.split(".")[1] ?? "";
  return JSON.parse(atob(segment.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
}

/** A Google ID token — accepted by POST /v1/account/bootstrap only. */
function providerToken(sub: string): string {
  return jwt({
    iss: "https://accounts.google.com",
    sub,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
}

const fakeAuthUser = (userId: string) => ({
  id: userId,
  aud: "authenticated",
  role: "authenticated",
  email: "u@example.com",
  app_metadata: { provider: "google", providers: ["google"] },
});

async function fakeSupabase(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "POST" && path === "/auth/v1/token") {
    state.tokenCalls += 1;
    if (state.tokenStatus !== 200) {
      return jsonResponse(state.tokenStatus, { code: state.tokenStatus, msg: "upstream down" });
    }
    const body = (await request.json()) as { id_token: string };
    const userId = String(claimsOf(body.id_token).sub);
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    return jsonResponse(200, {
      access_token: jwt({
        iss: `${url.origin}/auth/v1`,
        sub: userId,
        aud: "authenticated",
        role: "authenticated",
        exp: expiresAt,
        jti: crypto.randomUUID(),
      }),
      token_type: "bearer",
      expires_in: 3_600,
      expires_at: expiresAt,
      refresh_token: `sb-refresh-${userId}`,
      user: fakeAuthUser(userId),
    });
  }

  if (request.method === "GET" && path === "/auth/v1/user") {
    state.userCalls += 1;
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const claims = claimsOf(bearer);
    if (claims.iss !== `${url.origin}/auth/v1` || typeof claims.sub !== "string") {
      return jsonResponse(401, { code: 401, msg: "invalid JWT" });
    }
    return jsonResponse(200, fakeAuthUser(claims.sub));
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

const call = (method: string, path: string, token: string, body?: unknown): Promise<Response> =>
  Promise.resolve(
    api(
      new Request(`http://edge.local/functions/v1/api${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-forwarded-for": "203.0.113.7",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  );

/** Sign `sub` in through the real bootstrap route and return the session
 * access token every other route expects as bearer. */
async function sessionToken(sub: string): Promise<string> {
  const stagedProfiles = state.profileRows;
  state.profileRows = [
    { id: sub, email: "u@example.com", provider: "google", onboarding_state: "complete" },
  ];
  const before = { tokenCalls: state.tokenCalls, userCalls: state.userCalls };
  try {
    const res = await call("POST", "/v1/account/bootstrap", providerToken(sub));
    assertEquals(res.status, 200, "harness bootstrap");
    const body = (await res.json()) as { session: { accessToken: string } };
    return body.session.accessToken;
  } finally {
    state.profileRows = stagedProfiles;
    state.tokenCalls = before.tokenCalls;
    state.userCalls = before.userCalls;
  }
}

const pastIso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const futureIso = (msAhead: number): string => new Date(Date.now() + msAhead).toISOString();

// ─── Baseline behavior (sanity: the harness exercises the real handlers) ─────

Deno.test("delete-request mints a UUID challenge with a 15-minute expiry", async () => {
  resetState();
  const token = await sessionToken(crypto.randomUUID());
  const res = await call("POST", "/v1/me/delete-request", token);
  assertEquals(res.status, 200);
  const body = (await res.json()) as { challenge: string; expiresAt: string };
  assertEquals(body.challenge, state.lastUpsert?.challenge);
  const ttlMs = Date.parse(body.expiresAt) - Date.now();
  assertEquals(ttlMs > 14 * 60_000 && ttlMs <= 15 * 60_000, true);
});

Deno.test("delete-confirm rejects a non-UUID challenge with 400 and no admin call", async () => {
  resetState();
  const token = await sessionToken(crypto.randomUUID());
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
  const token = await sessionToken(crypto.randomUUID());
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
  const token = await sessionToken(crypto.randomUUID());
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

// ─── REPRO: delete-confirm is not idempotent under duplicate requests ────────

Deno.test(
  "two concurrent delete-confirms are idempotent even when GoTrue reports one user already gone",
  async () => {
    resetState();
    const token = await sessionToken(crypto.randomUUID());
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
    const token = await sessionToken(crypto.randomUUID());
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
    const token = await sessionToken(userId);
    const challenge = crypto.randomUUID();
    state.deletionRows = [
      { challenge, created_at: pastIso(10_000), expires_at: futureIso(60_000) },
    ];
    state.adminDeleteStatuses = [200];

    const deleted = await call("POST", "/v1/me/delete-confirm", token, { challenge });
    assertEquals(deleted.status, 200);
    assertEquals(state.userCalls, 1);

    // Post-deletion: the profile and deletion rows are gone (cascade).
    state.deletionRows = [];
    state.profileRows = [];

    // The cached session for the deleted user id must not be reused: the next
    // request with the same bearer goes back to Supabase Auth.
    const access = await call("GET", "/v1/me/access", token);
    assertEquals(state.userCalls, 2);
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
