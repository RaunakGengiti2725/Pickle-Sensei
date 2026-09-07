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

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { deletionChallengeHash } from "../accountDeletionOperations.ts";
import { AccountDeletionStub } from "./routesHarness.ts";

// ─── Fake Supabase ──────────────────────────────────────────────────────────

interface FakeState {
  /** Status for POST /auth/v1/token?grant_type=id_token (200 = succeed). */
  tokenStatus: number;
  tokenCalls: number;
  authRequests: Request[];
  authResponse: ((request: Request) => Response | Promise<Response>) | null;
  refreshCalls: number;
  lastRefreshToken: string | null;
  logoutStatus: number;
  logoutCalls: Array<{ scope: string | null; authorization: string | null }>;
  sessionActive: unknown;
  sessionActiveStatus: number;
  sessionChecks: number;
  accessStateCalls: number;
  databaseRequests: Request[];
  /** Rows PostgREST returns for account_deletion_requests selects. */
  deletionRows: Array<{ challenge: string; created_at: string; expires_at: string }>;
  /** Last service-only deletion admission RPC payload. */
  lastUpsert: Record<string, unknown> | null;
  /** Queue of statuses for DELETE /auth/v1/admin/users/:id. */
  adminDeleteStatuses: number[];
  adminDeleteCalls: number;
  adminDeleteGate: Promise<void> | null;
  onAdminDelete: (() => void) | null;
  revenueCatDeleteCalls: number;
  profileRows: Array<Record<string, unknown>>;
}

const state: FakeState = {
  tokenStatus: 200,
  tokenCalls: 0,
  authRequests: [],
  authResponse: null,
  refreshCalls: 0,
  lastRefreshToken: null,
  logoutStatus: 204,
  logoutCalls: [],
  sessionActive: true,
  sessionActiveStatus: 200,
  sessionChecks: 0,
  accessStateCalls: 0,
  databaseRequests: [],
  deletionRows: [],
  lastUpsert: null,
  adminDeleteStatuses: [],
  adminDeleteCalls: 0,
  adminDeleteGate: null,
  onAdminDelete: null,
  revenueCatDeleteCalls: 0,
  profileRows: [],
};

const externalCredentials: unknown[] = [];
const deletions = new AccountDeletionStub(() => ({
  account_deletion_requests: state.deletionRows,
  account_external_credentials: externalCredentials,
  profiles: state.profileRows,
}));

function resetState(): void {
  state.tokenStatus = 200;
  state.tokenCalls = 0;
  state.authRequests = [];
  state.authResponse = null;
  state.refreshCalls = 0;
  state.lastRefreshToken = null;
  state.logoutStatus = 204;
  state.logoutCalls = [];
  state.sessionActive = true;
  state.sessionActiveStatus = 200;
  state.sessionChecks = 0;
  state.accessStateCalls = 0;
  state.databaseRequests = [];
  state.deletionRows = [];
  state.lastUpsert = null;
  state.adminDeleteStatuses = [];
  state.adminDeleteCalls = 0;
  state.adminDeleteGate = null;
  state.onAdminDelete = null;
  state.revenueCatDeleteCalls = 0;
  state.profileRows = [];
  deletions.reset();
  externalCredentials.length = 0;
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

function sessionToken(sub: string): string {
  return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({
      iss: `${fakeUrl}/auth/v1`,
      sub,
      aud: "authenticated",
      role: "authenticated",
      session_id: crypto.randomUUID(),
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    }),
  )}.sig`;
}

function profileRow(id: string): Record<string, unknown> {
  return { id, email: "u@example.com", onboarding_state: "complete", provider: "google" };
}

function rotatedSession(): Record<string, unknown> {
  return {
    access_token: "sb-access-rotated",
    token_type: "bearer",
    expires_in: 3_600,
    expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    refresh_token: "sb-refresh-rotated",
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      aud: "authenticated",
      role: "authenticated",
    },
  };
}

async function fakeSupabase(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "POST" && path === "/auth/v1/token") {
    if (url.searchParams.get("grant_type") === "refresh_token") {
      state.refreshCalls += 1;
      state.lastRefreshToken = ((await request.json()) as { refresh_token: string }).refresh_token;
      return state.tokenStatus === 200
        ? jsonResponse(200, rotatedSession())
        : jsonResponse(state.tokenStatus, {
            error_code: "refresh_token_not_found",
            msg: "upstream down",
          });
    }
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

  if (path === "/auth/v1/user") {
    const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (deletions.missingOwners.has(payload.sub))
      return jsonResponse(404, { code: "user_not_found" });
    return jsonResponse(200, {
      id: payload.sub,
      email: "u@example.com",
      aud: "authenticated",
      role: "authenticated",
      app_metadata: { provider: "google", providers: ["google"] },
    });
  }

  if (request.method === "POST" && path === "/auth/v1/logout") {
    state.logoutCalls.push({
      scope: url.searchParams.get("scope"),
      authorization: request.headers.get("authorization"),
    });
    return state.logoutStatus === 204
      ? new Response(null, { status: 204 })
      : jsonResponse(state.logoutStatus, { error_code: "session_not_found", msg: "upstream down" });
  }

  if (request.method === "DELETE" && path.startsWith("/auth/v1/admin/users/")) {
    state.adminDeleteCalls += 1;
    state.onAdminDelete?.();
    if (state.adminDeleteGate) await state.adminDeleteGate;
    const status = state.adminDeleteStatuses.shift() ?? 200;
    if (status === 200) {
      deletions.observeAuthDeletion(decodeURIComponent(path.slice("/auth/v1/admin/users/".length)));
      state.sessionActive = false;
      return jsonResponse(200, {});
    }
    return jsonResponse(status, { code: status === 404 ? "user_not_found" : "unexpected_failure" });
  }

  if (path === "/rest/v1/rpc/get_api_request_key") {
    return request.headers.get("authorization") === "Bearer service-role-key"
      ? jsonResponse(200, "a1".repeat(32))
      : jsonResponse(403, { message: "server credentials required" });
  }

  if (path === "/rest/v1/rpc/is_api_session_active") {
    state.sessionChecks += 1;
    return state.sessionActiveStatus === 200
      ? jsonResponse(200, state.sessionActive)
      : jsonResponse(state.sessionActiveStatus, {
          code: "XX000",
          message: "injected session check failure",
        });
  }

  if (
    path.startsWith("/rest/v1/rpc/") &&
    (path.includes("account_deletion") || path.endsWith("store_account_apple_credential"))
  ) {
    if (request.headers.get("authorization") !== "Bearer service-role-key")
      return jsonResponse(403, { code: "42501" });
    const name = path.slice("/rest/v1/rpc/".length);
    const args = await request.json();
    if (name === "begin_account_deletion_operation") state.lastUpsert = args;
    return jsonResponse(200, await deletions.rpc(name, args));
  }

  if (path === "/rest/v1/account_deletion_requests" && request.method === "GET") {
    return jsonResponse(200, state.deletionRows);
  }
  if (path === "/rest/v1/account_external_credentials") {
    return request.method === "GET"
      ? jsonResponse(200, externalCredentials)
      : jsonResponse(403, { code: "42501", message: "fenced credential helpers required" });
  }

  if (path === "/rest/v1/profiles" && request.method === "GET") {
    return jsonResponse(200, state.profileRows);
  }

  if (path === "/rest/v1/rpc/access_state" && request.method === "POST") {
    state.accessStateCalls += 1;
    return jsonResponse(200, [{ premium: false, scored_count: 0, reserved_count: 0 }]);
  }

  return jsonResponse(404, { message: `fake supabase: unhandled ${request.method} ${path}` });
}

// ─── Boot the Edge Function in-process ───────────────────────────────────────

const fake = Deno.serve(
  { port: 0, hostname: "127.0.0.1", onListen: () => undefined },
  fakeSupabase,
);
const fakeUrl = `http://127.0.0.1:${fake.addr.port}`;

Deno.env.set("SUPABASE_URL", `${fakeUrl}/`);
Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_revenuecat");
Deno.env.delete("UPSTASH_REDIS_REST_URL");
Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
Deno.env.delete("SB_SECRET_KEY");

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  if (request.url.startsWith(`${fakeUrl}/auth/v1/`)) {
    state.authRequests.push(request);
    if (state.authResponse) return Promise.resolve(state.authResponse(request));
  }
  if (request.url.startsWith(`${fakeUrl}/rest/v1/`)) state.databaseRequests.push(request);
  if (request.url.startsWith("https://api.revenuecat.com/v1/subscribers/")) {
    state.revenueCatDeleteCalls += 1;
    assertEquals(request.method, "DELETE");
    assertEquals(request.headers.get("authorization"), "Bearer sk_test_revenuecat");
    return Promise.resolve(new Response(null, { status: 200 }));
  }
  return realFetch(request);
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

const rawCall = (path: string, init: RequestInit, ip = "203.0.113.100"): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("x-forwarded-for", ip);
  return Promise.resolve(
    api(new Request(`http://edge.local/functions/v1/api${path}`, { ...init, headers })),
  );
};

const refresh = (body: unknown = { refreshToken: "old-refresh-token" }, ip = "203.0.113.110") =>
  rawCall("/v1/auth/refresh", { method: "POST", body: JSON.stringify(body) }, ip);

const pastIso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const futureIso = (msAhead: number): string => new Date(Date.now() + msAhead).toISOString();

// ─── Baseline behavior (sanity: the harness exercises the real handlers) ─────

Deno.test("delete-request mints a UUID challenge with a 15-minute expiry", async () => {
  resetState();
  const ownerId = crypto.randomUUID();
  const token = providerToken(ownerId);
  const res = await call("POST", "/v1/me/delete-request", token);
  assertEquals(res.status, 200);
  const body = (await res.json()) as {
    challenge: string;
    expiresAt: string;
    operationId: string;
    statusCapability: string;
  };
  assertEquals(
    state.lastUpsert?.p_challenge_hash,
    await deletionChallengeHash(ownerId, body.challenge),
  );
  assertEquals(body.operationId, state.lastUpsert?.p_operation_id);
  assertEquals(body.statusCapability.length, 43);
  const ttlMs = Date.parse(body.expiresAt) - Date.now();
  assertEquals(ttlMs > 14 * 60_000 && ttlMs <= 15 * 60_000, true);
});

Deno.test(
  "without SB_SECRET_KEY, Auth calls use the publishable key and forward no IP",
  async () => {
    resetState();
    const userId = crypto.randomUUID();
    state.profileRows = [profileRow(userId)];
    const token = providerToken(userId);
    const res = await call("POST", "/v1/account/bootstrap", token, {}, "203.0.113.42");
    assertEquals(res.status, 200);
    await res.text();
    const exchange = state.authRequests.find((r) => new URL(r.url).pathname === "/auth/v1/token");
    assert(exchange);
    assertEquals(exchange.headers.get("apikey"), "anon-key");
    assertEquals(exchange.headers.get("sb-forwarded-for"), null);
  },
);

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
  "GoTrue 503 during signInWithIdToken is retryable and its response body is not leaked",
  async () => {
    resetState();
    state.tokenStatus = 503;
    const token = providerToken(crypto.randomUUID());
    const res = await call("POST", "/v1/account/bootstrap", token);
    // Expected for a retryable upstream failure: 5xx (the mobile bootstrap maps
    // 401/403 to the non-retryable `account.rejected`). Actual today: 401.
    assertEquals(res.status, 503);
    const message = ((await res.json()) as { error: { message: string } }).error.message;
    assertStringIncludes(message, "temporarily unavailable");
    assertEquals(message.includes("upstream down"), false);
    assertEquals(state.tokenCalls, 1);
  },
);

// ─── W08: duplicate confirms share one leased operation ─────────────────────

Deno.test(
  "two concurrent legacy delete-confirms share a single Auth delete and a receipt",
  async () => {
    resetState();
    const token = providerToken(crypto.randomUUID());
    const challenge = crypto.randomUUID();
    state.deletionRows = [
      { challenge, created_at: pastIso(10_000), expires_at: futureIso(60_000) },
    ];
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      state.onAdminDelete = resolve;
    });
    state.adminDeleteGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = call("POST", "/v1/me/delete-confirm", token, { challenge });
    await Promise.race([
      entered,
      first.then(() => {
        throw new Error("confirm returned before Auth gate");
      }),
    ]);
    try {
      const duplicate = await call("POST", "/v1/me/delete-confirm", token, { challenge });
      assertEquals(duplicate.status, 202);
      assertEquals((await duplicate.json()).state, "in_progress");
      assertEquals(state.adminDeleteCalls, 1);
    } finally {
      release();
    }
    const response = await first;
    assertEquals(response.status, 200);
    const completed = await response.json();
    assertEquals(completed.deleted, true);
    assertEquals(typeof completed.completionReceipt.completedAt, "string");
    assertEquals(state.adminDeleteCalls, 1);
    assertEquals(state.revenueCatDeleteCalls, 1);
  },
);

Deno.test(
  "an intended Auth user_not_found without a durable trigger receipt remains unverified",
  async () => {
    resetState();
    const token = providerToken(crypto.randomUUID());
    const challenge = crypto.randomUUID();
    state.deletionRows = [
      { challenge, created_at: pastIso(10_000), expires_at: futureIso(60_000) },
    ];
    // Auth absence alone cannot certify that this operation performed cleanup
    // or observed a committed Auth cascade; the trigger receipt is mandatory.
    state.adminDeleteStatuses = [404];
    const res = await call("POST", "/v1/me/delete-confirm", token, { challenge });
    assertEquals(res.status, 503);
    assertEquals((await res.json()).deleted, undefined);
  },
);

// ─── Verified-session cache is evicted by account deletion ──────────────────

Deno.test(
  "after a successful delete-confirm the bearer is re-verified with Supabase Auth, not served from cache",
  async () => {
    resetState();
    const userId = crypto.randomUUID();
    const token = sessionToken(userId);
    const challenge = crypto.randomUUID();
    state.deletionRows = [
      { challenge, created_at: pastIso(10_000), expires_at: futureIso(60_000) },
    ];
    state.adminDeleteStatuses = [200];

    const deleted = await call("POST", "/v1/me/delete-confirm", token, { challenge });
    assertEquals(deleted.status, 200);
    assertEquals((await deleted.json()).deleted, true);
    assertEquals(
      state.authRequests.filter((request) => new URL(request.url).pathname === "/auth/v1/user")
        .length,
      1,
    );

    state.deletionRows = [];
    state.profileRows = [];
    const access = await call("GET", "/v1/me/access", token);
    assertEquals(
      state.authRequests.filter((request) => new URL(request.url).pathname === "/auth/v1/user")
        .length,
      2,
    );
    assertEquals(access.status, 401);
    await access.text();
    const again = await call("POST", "/v1/me/delete-confirm", token, { challenge });
    assertEquals(again.status, 401);
    await again.text();
    assertEquals(state.adminDeleteCalls, 1);
    assertEquals(state.tokenCalls, 0);
  },
);

const AUTH_SECRET = "credential-must-never-appear-in-auth-logs";
type AuthFailure = number | "network" | "no-status";

function authFailure(kind: AuthFailure): Response {
  if (kind === "network") throw new TypeError(`connection failed: ${AUTH_SECRET}`);
  if (kind === "no-status") return new Response(`not JSON: ${AUTH_SECRET}`, { status: 401 });
  if (kind === 0) return Response.error();
  return jsonResponse(kind, { error_code: "injected_auth_failure", msg: AUTH_SECRET });
}

for (const flow of ["bootstrap", "provider fallback", "getUser"] as const) {
  for (const failure of [
    400,
    401,
    403,
    429,
    500,
    503,
    520,
    530,
    599,
    0,
    "network",
    "no-status",
  ] as const) {
    Deno.test(
      `${flow}: Auth ${failure} is ${typeof failure === "number" && [400, 401, 403].includes(failure) ? "a rejection" : "retryable"} without credential logs`,
      async () => {
        resetState();
        state.authResponse = () => authFailure(failure);
        const token =
          flow === "getUser"
            ? sessionToken(crypto.randomUUID())
            : providerToken(crypto.randomUUID());
        const logs: string[] = [];
        const realError = console.error;
        console.error = (...args: unknown[]) => {
          logs.push(args.map(String).join(" "));
        };
        try {
          const response = await call(
            flow === "bootstrap" ? "POST" : "GET",
            flow === "bootstrap" ? "/v1/account/bootstrap" : "/v1/me/access",
            token,
            undefined,
            flow === "bootstrap" ? "203.0.113.101" : "203.0.113.102",
          );
          const expected =
            typeof failure === "number" && [400, 401, 403].includes(failure) ? 401 : 503;
          assertEquals(response.status, expected);
          assertEquals((await response.text()).includes(AUTH_SECRET), false);
          assertEquals(logs.join(" ").includes(AUTH_SECRET), false);
          assertEquals(logs.join(" ").includes(token), false);
          assertEquals(state.authRequests.length, 1);
          assertEquals(state.databaseRequests.length, 0);
        } finally {
          console.error = realError;
        }
      },
    );
  }
}

Deno.test("Auth fetch uses a 10-second signal and refuses redirects", async () => {
  resetState();
  state.authResponse = () => authFailure(401);
  const realTimeout = AbortSignal.timeout;
  const timeouts: number[] = [];
  AbortSignal.timeout = (ms: number) => {
    timeouts.push(ms);
    return realTimeout.call(AbortSignal, ms);
  };
  try {
    const response = await call(
      "POST",
      "/v1/account/bootstrap",
      providerToken(crypto.randomUUID()),
      undefined,
      "203.0.113.103",
    );
    assertEquals(response.status, 401);
    await response.text();
    assertEquals(state.authRequests[0].redirect, "error");
    assertEquals(timeouts, [10_000]);
  } finally {
    AbortSignal.timeout = realTimeout;
  }
});

Deno.test("Auth 5xx bodies are cancelled without waiting for an error payload", async () => {
  resetState();
  let cancelled = false;
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(AUTH_SECRET));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { status: 503 },
  );
  state.authResponse = () => upstream;
  try {
    const response = await call(
      "POST",
      "/v1/account/bootstrap",
      providerToken(crypto.randomUUID()),
      undefined,
      "203.0.113.104",
    );
    assertEquals(response.status, 503);
    await response.text();
    assertEquals(cancelled, true);
    assertEquals(upstream.bodyUsed, true);
  } finally {
    await upstream.body?.cancel().catch(() => undefined);
  }
});

Deno.test("trailing-slash Supabase configuration preserves direct refresh and logout", async () => {
  resetState();
  assertEquals(Deno.env.get("SUPABASE_URL"), `${fakeUrl}/`);
  const refreshed = await refresh({ refreshToken: "fixture-refresh-token" });
  assertEquals(refreshed.status, 200);
  await refreshed.text();
  const loggedOut = await call("POST", "/v1/auth/logout", sessionToken(crypto.randomUUID()));
  assertEquals(loggedOut.status, 204);
  await loggedOut.text();
  assertEquals(state.refreshCalls, 1);
  assertEquals(state.logoutCalls.length, 1);
  assert(
    state.authRequests.every((request) => new URL(request.url).pathname.startsWith("/auth/v1/")),
  );
});

Deno.test(
  "refresh rotates through GoTrue once and returns the durable session contract",
  async () => {
    resetState();
    const response = await refresh({ refreshToken: "  old-refresh-token  " });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(Object.keys(body), ["session"]);
    assertEquals(Object.keys(body.session).sort(), ["accessToken", "expiresAt", "refreshToken"]);
    assertEquals(body.session.accessToken, "sb-access-rotated");
    assertEquals(body.session.refreshToken, "sb-refresh-rotated");
    assertEquals(body.session.expiresAt > Date.now() / 1000, true);
    assertEquals(state.refreshCalls, 1);
    assertEquals(state.lastRefreshToken, "old-refresh-token");
    assertEquals(state.authRequests[0].headers.get("apikey"), "anon-key");
    assertEquals(state.sessionChecks, 0);
  },
);

Deno.test(
  "refresh accepts a 4096-character token and derives expiry from expires_in when needed",
  async () => {
    resetState();
    const session = rotatedSession();
    delete session.expires_at;
    state.authResponse = () => jsonResponse(200, session);
    const before = Math.floor(Date.now() / 1000);
    const response = await refresh({ refreshToken: "r".repeat(4096) });
    assertEquals(response.status, 200);
    const expires = (await response.json()).session.expiresAt;
    assertEquals(expires >= before + 3600 && expires <= Math.floor(Date.now() / 1000) + 3600, true);
    assertEquals(state.authRequests.length, 1);
  },
);

Deno.test(
  "refresh rejects missing, empty, non-string and overlong tokens before Auth",
  async () => {
    resetState();
    for (const body of [
      {},
      { refreshToken: null },
      { refreshToken: 7 },
      { refreshToken: "" },
      { refreshToken: "  " },
      { refreshToken: "r".repeat(4097) },
    ]) {
      const response = await refresh(body);
      assertEquals(response.status, 400);
      assertEquals((await response.json()).error.code, "validation.refresh");
    }
    assertEquals(state.authRequests.length, 0);
  },
);

for (const failure of [
  400,
  401,
  403,
  429,
  500,
  503,
  520,
  530,
  599,
  0,
  "network",
  "no-status",
] as const) {
  Deno.test(
    `refresh: Auth ${failure} makes one attempt and returns ${typeof failure === "number" && [400, 401, 403].includes(failure) ? 401 : 503}`,
    async () => {
      resetState();
      state.authResponse = () => {
        if (state.authRequests.length > 1) return authFailure(401);
        if (failure === "no-status") throw { name: "AuthUnknownError", message: AUTH_SECRET };
        return authFailure(failure);
      };
      const logs: string[] = [];
      const realError = console.error;
      console.error = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };
      try {
        const response = await refresh({ refreshToken: "old-refresh-token" }, "203.0.113.111");
        assertEquals(
          response.status,
          typeof failure === "number" && [400, 401, 403].includes(failure) ? 401 : 503,
        );
        assertEquals((await response.text()).includes(AUTH_SECRET), false);
        assertEquals(logs.join(" ").includes(AUTH_SECRET), false);
        assertEquals(state.authRequests.length, 1);
        assertEquals(state.sessionChecks, 0);
      } finally {
        console.error = realError;
      }
    },
  );
}

Deno.test(
  "refresh refuses malformed successful sessions instead of fabricating usable expiry",
  async () => {
    resetState();
    const valid = rotatedSession();
    for (const session of [
      { ...valid, expires_at: Number.MAX_SAFE_INTEGER },
      { ...valid, expires_at: "later" },
      { ...valid, expires_at: 0 },
      { ...valid, expires_at: Math.floor(Date.now() / 1000) - 1 },
      { ...valid, expires_in: -1 },
      { ...valid, expires_at: undefined, expires_in: undefined },
      { ...valid, expires_at: undefined, expires_in: 1e308 },
      { ...valid, access_token: "   " },
      { ...valid, refresh_token: "" },
      { ...valid, refresh_token: "r".repeat(4097) },
      null,
      [],
    ]) {
      state.authResponse = () => jsonResponse(200, session);
      const malformed = await refresh({ refreshToken: "r" }, "203.0.113.112");
      assertEquals(malformed.status, 503);
      assertEquals((await malformed.text()).includes("sb-refresh-rotated"), false);
    }
  },
);

Deno.test("refresh rejects 100 KB JSON bodies before any Auth call", async () => {
  resetState();
  const response = await refresh({ refreshToken: "r", pad: "x".repeat(100_000) }, "203.0.113.113");
  assertEquals(response.status, 413);
  await response.text();
  assertEquals(state.authRequests.length, 0);
});

Deno.test(
  "logout revokes only the current device, bypasses liveness and evicts its warm bearer",
  async () => {
    resetState();
    const token = sessionToken(crypto.randomUUID());
    const warm = await call("GET", "/v1/me/access", token);
    assertEquals(warm.status, 200);
    await warm.text();
    const before = state.sessionChecks;
    state.sessionActive = false;
    const response = await call("POST", "/v1/auth/logout", token);
    assertEquals(response.status, 204);
    assertEquals(await response.text(), "");
    assertEquals(state.logoutCalls, [{ scope: "local", authorization: `Bearer ${token}` }]);
    assertEquals(state.sessionChecks, before);
    state.sessionActive = true;
    const after = await call("GET", "/v1/me/access", token);
    assertEquals(after.status, 200);
    await after.text();
    assertEquals(
      state.authRequests.filter((r) => new URL(r.url).pathname === "/auth/v1/user").length,
      2,
    );
  },
);

for (const status of [200, 204, 401, 403, 404, 429, 500, 503, 520, 530, 0, "network"] as const) {
  Deno.test(
    `logout: Auth ${status} is consumed and returns ${typeof status === "number" && [200, 204, 401, 403, 404].includes(status) ? 204 : 503}`,
    async () => {
      resetState();
      const token = sessionToken(crypto.randomUUID());
      let upstream: Response | undefined;
      state.authResponse = (request) => {
        if (new URL(request.url).pathname !== "/auth/v1/logout") return realFetch(request);
        upstream = status === 204 ? new Response(null, { status: 204 }) : authFailure(status);
        return upstream;
      };
      const logs: string[] = [];
      const realError = console.error;
      console.error = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };
      try {
        const response = await call("POST", "/v1/auth/logout", token, undefined, "203.0.113.114");
        assertEquals(
          response.status,
          typeof status === "number" && [200, 204, 401, 403, 404].includes(status) ? 204 : 503,
        );
        assertEquals((await response.text()).includes(AUTH_SECRET), false);
        assertEquals(logs.join(" ").includes(AUTH_SECRET), false);
        assertEquals(state.sessionChecks, 0);
        if (upstream?.body) assertEquals(upstream.bodyUsed, true);
        const logout = state.authRequests.find(
          (r) => new URL(r.url).pathname === "/auth/v1/logout",
        )!;
        assertEquals(new URL(logout.url).searchParams.get("scope"), "local");
        assertEquals(logout.headers.get("authorization"), `Bearer ${token}`);
        assertEquals(logout.headers.get("apikey"), "anon-key");
      } finally {
        console.error = realError;
        await upstream?.body?.cancel().catch(() => undefined);
      }
    },
  );
}

Deno.test(
  "delete-request rejects malformed and non-object JSON without minting a challenge",
  async () => {
    for (const raw of ["{not json", "[]", "null", '"survey"']) {
      resetState();
      const response = await rawCall("/v1/me/delete-request", {
        method: "POST",
        headers: { Authorization: `Bearer ${providerToken(crypto.randomUUID())}` },
        body: raw,
      });
      assertEquals(response.status, 400, raw);
      await response.text();
      assertEquals(state.lastUpsert, null);
      assertEquals(
        state.databaseRequests.some((r) => r.url.includes("account_deletion_requests")),
        false,
      );
    }
  },
);

Deno.test(
  "delete-request stream failures are 400, release the reader and never write",
  async () => {
    resetState();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"survey":'));
      },
      pull(controller) {
        controller.error(new Error("client stream failed"));
      },
    });
    const response = await rawCall("/v1/me/delete-request", {
      method: "POST",
      headers: { Authorization: `Bearer ${providerToken(crypto.randomUUID())}` },
      body: stream,
    });
    assertEquals(response.status, 400);
    await response.text();
    assertEquals(state.lastUpsert, null);
    assertEquals(stream.locked, false);
  },
);

Deno.test(
  "bootstrap validates optional JSON for Google too before any profile access",
  async () => {
    for (const [raw, status] of [
      ["{not json", 400],
      ["[]", 400],
      [JSON.stringify({ pad: "x".repeat(100_000) }), 413],
    ] as const) {
      resetState();
      const userId = crypto.randomUUID();
      state.profileRows = [profileRow(userId)];
      const response = await rawCall(
        "/v1/account/bootstrap",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${providerToken(userId)}` },
          body: raw,
        },
        "203.0.113.121",
      );
      assertEquals(response.status, status);
      await response.text();
      assertEquals(state.databaseRequests.length, 0);
    }
  },
);

Deno.test("bootstrap has a 30/min per-IP budget before any provider exchange", async () => {
  resetState();
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  try {
    const userId = crypto.randomUUID();
    const token = providerToken(userId);
    state.profileRows = [profileRow(userId)];
    for (let i = 0; i < 30; i += 1) {
      const response = await call(
        "POST",
        "/v1/account/bootstrap",
        token,
        undefined,
        "203.0.113.120",
      );
      assertEquals(response.status, 200, `bootstrap ${i + 1}`);
      await response.text();
    }
    const blocked = await call("POST", "/v1/account/bootstrap", token, undefined, "203.0.113.120");
    assertEquals(blocked.status, 429);
    assertEquals(Number(blocked.headers.get("Retry-After")) >= 1, true);
    await blocked.text();
    assertEquals(state.tokenCalls, 30);
    assertEquals(state.sessionChecks, 0);
  } finally {
    Date.now = realNow;
  }
});

Deno.test(
  "a warm auth cache cannot bypass revocation; false evicts it and RPC outages stay retryable",
  async () => {
    resetState();
    const token = sessionToken(crypto.randomUUID());
    const warm = await call("GET", "/v1/me/access", token);
    assertEquals(warm.status, 200);
    await warm.text();
    assertEquals(state.authRequests.length, 1);
    state.sessionActive = false;
    const denied = await call("GET", "/v1/me/access", token);
    assertEquals(denied.status, 401);
    await denied.text();
    assertEquals(state.authRequests.length, 1);
    assertEquals(state.accessStateCalls, 1);
    state.sessionActive = true;
    const restored = await call("GET", "/v1/me/access", token);
    assertEquals(restored.status, 200);
    await restored.text();
    assertEquals(state.authRequests.length, 2);
    for (const verdict of [null, "true", [], {}]) {
      state.sessionActive = verdict;
      const invalid = await call("GET", "/v1/me/access", token);
      assertEquals(invalid.status, 503);
      await invalid.text();
      assertEquals(state.accessStateCalls, 2);
    }
    state.sessionActive = true;
    state.sessionActiveStatus = 500;
    const outage = await call("GET", "/v1/me/access", token);
    assertEquals(outage.status, 503);
    assertEquals((await outage.text()).includes("injected session check failure"), false);
    state.sessionActiveStatus = 200;
    const recovered = await call("GET", "/v1/me/access", token);
    assertEquals(recovered.status, 200);
    await recovered.text();
    assertEquals(state.authRequests.length, 2);
    assertEquals(state.sessionChecks, 9);
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
