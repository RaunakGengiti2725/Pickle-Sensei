import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cacheGet, sha256Hex } from "../cache.ts";
import { peekRateLimit } from "../rateLimit.ts";
import {
  fakeAppleIdToken,
  fakeGoogleIdToken,
  fakeSupabaseAccessToken,
  loadHarness,
  SUPABASE_URL,
  userRequest,
  type Harness,
  type RecordedCall,
} from "./routesHarness.ts";

type AuthRoute = "refresh" | "access" | "bootstrap" | "legacy";

const ROUTES: AuthRoute[] = ["refresh", "access", "bootstrap", "legacy"];
const PRIVATE_DETAIL = "private-auth-detail-must-not-be-logged";
const REFRESH_TOKEN = "private-refresh-token-for-auth-route-test";
const RATE_LIMIT_MESSAGE = "Too many requests. Please slow down and try again shortly.";
let nextIp = 1;

interface AuthTestContext {
  h: Harness;
  ip: string;
  userId: string;
  token: string;
  user: Record<string, unknown>;
  session: Record<string, unknown>;
  logs: string[];
  advance(ms: number): void;
  request(): Request;
  success(call: RecordedCall): Response;
}

function authJson(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Supabase-Api-Version": "2024-01-01",
      ...headers,
    },
  });
}

function authTest(
  route: AuthRoute,
  name: string,
  run: (context: AuthTestContext) => Promise<void>,
): void {
  Deno.test(`auth ${route}: ${name}`, async () => {
    const h = await loadHarness();
    const realNow = Date.now;
    let now = 1_800_000_010_000;
    Date.now = () => now;
    const originalConsole = {
      error: console.error,
      warn: console.warn,
      log: console.log,
      info: console.info,
      debug: console.debug,
    };
    const logs: string[] = [];
    const capture = (...values: unknown[]) => {
      logs.push(values.map((value) => Deno.inspect(value, { depth: 10 })).join(" "));
    };
    Object.assign(console, {
      error: capture,
      warn: capture,
      log: capture,
      info: capture,
      debug: capture,
    });
    try {
      const userId = crypto.randomUUID();
      const ip = `198.51.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`;
      const token =
        route === "access" ? fakeSupabaseAccessToken(userId) : fakeGoogleIdToken(userId);
      const user = {
        id: userId,
        email: "user@example.com",
        aud: "authenticated",
        role: "authenticated",
        app_metadata: { provider: "google", providers: ["google"] },
        user_metadata: {},
        created_at: new Date(now).toISOString(),
      };
      const session = {
        access_token: fakeSupabaseAccessToken(userId),
        refresh_token: `rotated-refresh-${userId}`,
        token_type: "bearer",
        expires_in: 3_600,
        expires_at: Math.floor(now / 1_000) + 3_600,
        user,
      };
      h.rpcs["access_state"] = [{ premium: false, scored_count: 0, reserved_count: 0 }];
      h.tables["profiles"] = [
        { id: userId, email: user.email, provider: "google", onboarding_state: "complete" },
      ];
      const context: AuthTestContext = {
        h,
        ip,
        userId,
        token,
        user,
        session,
        logs,
        advance(ms) {
          now += ms;
        },
        request: () =>
          userRequest(
            route === "refresh" || route === "bootstrap" ? "POST" : "GET",
            route === "refresh"
              ? "/v1/auth/refresh"
              : route === "bootstrap"
                ? "/v1/account/bootstrap"
                : "/v1/me/access",
            {
              token,
              ip,
              ...(route === "refresh" ? { body: { refreshToken: `  ${REFRESH_TOKEN}  ` } } : {}),
            },
          ),
        success: (call) => authJson(200, call.url.endsWith("/user") ? user : session),
      };
      h.authResponse = context.success;
      await run(context);
    } finally {
      Date.now = realNow;
      Object.assign(console, originalConsole);
    }
  });
}

async function assertFailureBudget(context: AuthTestContext, remaining = 30): Promise<void> {
  const budget = await peekRateLimit("authfail", context.ip, 30, 300);
  assertEquals(budget.remaining, remaining);
}

function assertNoAuthSecrets(context: AuthTestContext, body: string): void {
  const output = `${body}\n${context.logs.join("\n")}`;
  for (const secret of [
    PRIVATE_DETAIL,
    REFRESH_TOKEN,
    context.token,
    context.session.access_token,
    context.session.refresh_token,
    "anon-test-key",
    "service-role-test-key",
  ]) {
    assert(
      !output.includes(String(secret)),
      "Auth errors must not expose credentials or upstream details in responses or logs",
    );
  }
}

interface FailureCase {
  name: string;
  status?: number;
  code?: string;
  expected?: number;
  retryAfter?: string;
  reply?: (context: AuthTestContext) => Response;
}

const TRANSIENT_CASES: FailureCase[] = [
  {
    name: "upstream 429 stays retryable and preserves Retry-After",
    status: 429,
    code: "over_request_rate_limit",
    expected: 429,
    retryAfter: "37",
  },
  { name: "uncoded upstream 429 is not an invalid credential", status: 429, expected: 429 },
  {
    name: "rate-limit code on a 400 stays retryable",
    status: 400,
    code: "over_request_rate_limit",
    expected: 429,
  },
  {
    name: "429 takes precedence over a denial code",
    status: 429,
    code: "refresh_token_not_found",
    expected: 429,
  },
  {
    name: "transport failure (SDK status 0) is transient",
    reply: (c) => {
      throw new TypeError(`${PRIVATE_DETAIL}: ${c.token} ${REFRESH_TOKEN}`);
    },
  },
  {
    name: "timeout is transient",
    reply: () => {
      throw new DOMException(PRIVATE_DETAIL, "TimeoutError");
    },
  },
  {
    name: "aborted transport is transient",
    reply: () => {
      throw new DOMException(PRIVATE_DETAIL, "AbortError");
    },
  },
  {
    name: "an opaque network error response is transient",
    reply: () => Response.error(),
  },
  {
    name: "non-JSON upstream throttling still returns 429",
    expected: 429,
    reply: () => new Response(PRIVATE_DETAIL, { status: 429 }),
  },
  { name: "upstream 500 overrides a throttle code", status: 500, code: "over_request_rate_limit" },
  { name: "uncoded upstream 401 is not proof of invalid credentials", status: 401 },
  { name: "timeout status overrides a denial code", status: 408, code: "bad_jwt" },
  { name: "conflict status overrides a denial code", status: 409, code: "bad_jwt" },
  { name: "upstream 503 is transient", status: 503, code: "unexpected_failure" },
  { name: "upstream 504 is transient", status: 504, code: "request_timeout" },
  {
    name: "upstream 599 never logs the auth error message",
    status: 599,
    code: "unexpected_failure",
  },
  { name: "5xx takes precedence over a denial code", status: 599, code: "refresh_token_not_found" },
  {
    name: "unknown 400 is transient, not guessed from the message",
    status: 400,
    code: "unknown_reply",
  },
  { name: "unknown 401 is not proof of invalid credentials", status: 401, code: "bad_api_key" },
  { name: "provider configuration failure is transient", status: 403, code: "provider_disabled" },
  { name: "upstream 408 is transient", status: 408, code: "request_timeout" },
  { name: "upstream conflict is transient", status: 409, code: "conflict" },
  { name: "unsupported 422 reply is transient", status: 422, code: PRIVATE_DETAIL },
  {
    name: "non-JSON success fails closed transiently",
    reply: () => new Response(`${PRIVATE_DETAIL} invalid JSON`, { status: 200 }),
  },
  {
    name: "non-JSON 401 fails closed transiently",
    reply: () => new Response(PRIVATE_DETAIL, { status: 401 }),
  },
  { name: "empty-object success fails closed transiently", reply: () => authJson(200, {}) },
  { name: "null success fails closed transiently", reply: () => authJson(200, null) },
  {
    name: "unsupported success status fails closed transiently",
    reply: (c) => authJson(201, c.session),
  },
];

for (const route of ROUTES) {
  for (const failure of TRANSIENT_CASES) {
    authTest(route, failure.name, async (c) => {
      c.h.authResponse = () => {
        c.advance(31_000);
        return failure.reply
          ? failure.reply(c)
          : authJson(
              failure.status!,
              {
                code: failure.code,
                msg: `${PRIVATE_DETAIL}: invalid refresh token, sign in again ${REFRESH_TOKEN}`,
              },
              failure.retryAfter ? { "Retry-After": failure.retryAfter } : {},
            );
      };
      const response = await c.h.handler(c.request());
      assertEquals(response.status, failure.expected ?? 503);
      assertEquals(response.headers.get("cache-control"), "no-store");
      assertEquals(response.headers.get("x-content-type-options"), "nosniff");
      if (failure.retryAfter) assertEquals(response.headers.get("retry-after"), failure.retryAfter);
      const text = await response.text();
      if (failure.expected === 429) {
        assertEquals(JSON.parse(text), {
          error: { code: "rate_limited", message: RATE_LIMIT_MESSAGE },
        });
      } else {
        const context = route === "refresh" ? "Session refresh" : "Authentication";
        assertEquals(JSON.parse(text), {
          error: { message: `${context} is temporarily unavailable. Please try again.` },
        });
      }
      assertNoAuthSecrets(c, text);
      assertEquals(c.h.callsTo("/rest/v1/").length, 0);
      assertEquals(c.h.callsTo("/auth/v1/").length, 1);
      await assertFailureBudget(c);
    });
  }

  authTest(
    route,
    "valid success retains session/account contracts and user-scoped database access",
    async (c) => {
      const response = await c.h.handler(c.request());
      assertEquals(response.status, 200);
      const body = await response.json();
      if (route === "refresh" || route === "bootstrap") {
        assertEquals(body.session, {
          accessToken: c.session.access_token,
          refreshToken: c.session.refresh_token,
          expiresAt: c.session.expires_at,
          expiresIn: c.session.expires_in,
        });
        if (route === "bootstrap") {
          assertEquals(body.user, { id: c.userId, email: c.user.email });
          assertEquals(body.onboardingState, "complete");
        } else {
          assertEquals(c.h.callsTo("grant_type=refresh_token")[0].body, {
            refresh_token: REFRESH_TOKEN,
          });
          assertEquals(c.h.callsTo("/rest/v1/").length, 0);
        }
      } else {
        assertEquals(body.freeRatings.remaining, 2);
        assertEquals(body.premium, false);
      }
      const authCalls = c.h.callsTo("/auth/v1/");
      assertEquals(authCalls.length, 1);
      assertEquals(authCalls[0].headers.apikey, "anon-test-key");
      assertEquals(authCalls[0].headers["x-supabase-api-version"], "2024-01-01");
      assertEquals(authCalls[0].method, route === "access" ? "GET" : "POST");
      if (route === "access") {
        assertEquals(authCalls[0].url, `${SUPABASE_URL}/auth/v1/user`);
        assertEquals(authCalls[0].headers.authorization, `Bearer ${c.token}`);
      } else {
        assertEquals(authCalls[0].headers.authorization, "Bearer anon-test-key");
        const grant = route === "refresh" ? "refresh_token" : "id_token";
        assertEquals(authCalls[0].url, `${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`);
        if (route !== "refresh") {
          assertEquals(authCalls[0].body, { provider: "google", id_token: c.token });
        }
      }
      for (const call of c.h.callsTo("/rest/v1/")) {
        assertEquals(
          call.headers.authorization,
          `Bearer ${route === "access" ? c.token : c.session.access_token}`,
        );
        assertEquals(call.headers.apikey, "anon-test-key");
      }
      await assertFailureBudget(c);
    },
  );

  const denialCodes =
    route === "refresh"
      ? [
          "refresh_token_not_found",
          "refresh_token_already_used",
          "session_not_found",
          "session_expired",
          "user_not_found",
          "user_banned",
        ]
      : [
          "bad_jwt",
          "invalid_credentials",
          "session_not_found",
          "session_expired",
          "user_not_found",
          "user_banned",
        ];
  for (const code of denialCodes) {
    authTest(
      route,
      `definitive 400 ${code} stays rejected and charges the auth-failure budget`,
      async (c) => {
        c.h.authResponse = () => authJson(400, { code, msg: PRIVATE_DETAIL });
        const response = await c.h.handler(c.request());
        assertEquals(response.status, 401);
        assertNoAuthSecrets(c, await response.text());
        assertEquals(c.h.callsTo("/rest/v1/").length, 0);
        await assertFailureBudget(c, 29);
      },
    );
  }

  for (const status of [401, 403]) {
    authTest(route, `definitive HTTP ${status} stays rejected`, async (c) => {
      c.h.authResponse = () =>
        authJson(status, {
          code: route === "refresh" ? "refresh_token_not_found" : "bad_jwt",
          msg: PRIVATE_DETAIL,
        });
      const response = await c.h.handler(c.request());
      assertEquals(response.status, 401);
      assertNoAuthSecrets(c, await response.text());
      assertEquals(c.h.callsTo("/rest/v1/").length, 0);
      await assertFailureBudget(c, 29);
    });
  }

  authTest(route, "legacy error_code denial remains rejected", async (c) => {
    c.h.authResponse = () =>
      new Response(
        JSON.stringify({
          error_code: route === "refresh" ? "refresh_token_not_found" : "bad_jwt",
          msg: PRIVATE_DETAIL,
        }),
        { status: 400 },
      );
    const response = await c.h.handler(c.request());
    assertEquals(response.status, 401);
    assertNoAuthSecrets(c, await response.text());
    await assertFailureBudget(c, 29);
  });

  authTest(
    route,
    "a burst of upstream throttling never exhausts the auth-failure budget",
    async (c) => {
      c.h.authResponse = () =>
        authJson(
          429,
          { code: "over_request_rate_limit", msg: PRIVATE_DETAIL },
          { "Retry-After": "9" },
        );
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await c.h.handler(c.request());
        assertEquals(response.status, 429);
        assertEquals(response.headers.get("retry-after"), "9");
        await response.body?.cancel();
      }
      await assertFailureBudget(c);
      assertEquals(c.h.callsTo("/auth/v1/").length, 30);
      c.h.authResponse = c.success;
      const recovered = await c.h.handler(
        userRequest("GET", "/v1/me/access", { ip: c.ip, token: fakeSupabaseAccessToken(c.userId) }),
      );
      assertEquals(recovered.status, 200);
      await recovered.body?.cancel();
    },
  );
}

for (const route of ["refresh", "bootstrap", "legacy"] as const) {
  for (const patch of [
    { access_token: 17 },
    { access_token: "" },
    { access_token: "token\nwith-line-break" },
    { refresh_token: 17 },
    { refresh_token: " " },
    { expires_at: "not-an-expiry" },
    { expires_at: null },
    { expires_in: "3600" },
    { expires_in: null },
    { expires_in: 0 },
    { expires_at: undefined, expires_in: undefined },
    { expires_at: 1 },
    { user: null },
    { user: { app_metadata: { provider: "google" } } },
  ]) {
    authTest(
      route,
      `malformed session ${JSON.stringify(patch)} is not returned or cached`,
      async (c) => {
        c.h.authResponse = () => authJson(200, { ...c.session, ...patch });
        const response = await c.h.handler(c.request());
        assertEquals(response.status, 503);
        assertNoAuthSecrets(c, await response.text());
        assertEquals(c.h.callsTo("/rest/v1/").length, 0);
        await assertFailureBudget(c);
        c.h.authResponse = () =>
          authJson(400, { code: "invalid_credentials", msg: PRIVATE_DETAIL });
        const retry = await c.h.handler(c.request());
        assertEquals(retry.status, 401);
        await retry.body?.cancel();
        assertEquals(c.h.callsTo("/auth/v1/").length, 2);
      },
    );
  }
}

for (const route of ["access", "bootstrap", "legacy"] as const) {
  authTest(
    route,
    "expired bearer is rejected before Supabase and charged as an auth failure",
    async (c) => {
      c.advance(3_600_001);
      const response = await c.h.handler(c.request());
      assertEquals(response.status, 401);
      assertStringIncludes((await response.json()).error.message, "expired");
      assertEquals(c.h.calls.length, 0);
      await assertFailureBudget(c, 29);
    },
  );
}

authTest("bootstrap", "expired Apple token remains rejected before Supabase", async (c) => {
  const token = fakeAppleIdToken(c.userId);
  c.advance(3_600_001);
  const response = await c.h.handler(
    userRequest("POST", "/v1/account/bootstrap", { token, ip: c.ip }),
  );
  assertEquals(response.status, 401);
  await response.body?.cancel();
  assertEquals(c.h.calls.length, 0);
  await assertFailureBudget(c, 29);
});

for (const user of [
  { app_metadata: { provider: "google" } },
  { id: 17, app_metadata: { provider: "google" } },
  { id: "11111111-1111-4111-8111-111111111111", app_metadata: {} },
  {
    id: "11111111-1111-4111-8111-111111111111",
    app_metadata: { provider: 17, providers: ["google"] },
  },
  {
    id: "11111111-1111-4111-8111-111111111111",
    app_metadata: { provider: "google", providers: "google" },
  },
  {
    id: "11111111-1111-4111-8111-111111111111",
    app_metadata: { provider: "google", providers: [17] },
  },
  {
    id: "11111111-1111-4111-8111-111111111111",
    app_metadata: { provider: "google" },
    user: null,
  },
]) {
  authTest(
    "access",
    `malformed user ${JSON.stringify(user)} fails closed without a cached verification`,
    async (c) => {
      c.h.authResponse = () => authJson(200, user);
      const response = await c.h.handler(c.request());
      assertEquals(response.status, 503);
      assertNoAuthSecrets(c, await response.text());
      assertEquals(c.h.callsTo("/rest/v1/").length, 0);
      await assertFailureBudget(c);
      c.h.authResponse = () => authJson(401, { code: "bad_jwt" });
      const retry = await c.h.handler(c.request());
      assertEquals(retry.status, 401);
      await retry.body?.cancel();
      assertEquals(c.h.callsTo("/auth/v1/").length, 2);
    },
  );
}

authTest(
  "access",
  "a verified but unsupported provider remains denied, never authenticated",
  async (c) => {
    c.h.authResponse = () =>
      authJson(200, { ...c.user, app_metadata: { provider: "email", providers: ["email"] } });
    const response = await c.h.handler(c.request());
    assertEquals(response.status, 401);
    await response.body?.cancel();
    assertEquals(c.h.callsTo("/rest/v1/").length, 0);
    await assertFailureBudget(c, 29);
  },
);

authTest("refresh", "HTTP-date Retry-After is preserved as a retry delay", async (c) => {
  c.h.authResponse = () =>
    authJson(
      429,
      { code: "over_request_rate_limit" },
      { "Retry-After": new Date(Date.now() + 45_000).toUTCString() },
    );
  const response = await c.h.handler(c.request());
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("retry-after"), "45");
  await response.body?.cancel();
  await assertFailureBudget(c);
});

authTest("refresh", "invalid Retry-After is not reflected into headers", async (c) => {
  c.h.authResponse = () =>
    authJson(429, { code: "over_request_rate_limit" }, { "Retry-After": PRIVATE_DETAIL });
  const response = await c.h.handler(c.request());
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("retry-after"), null);
  assertNoAuthSecrets(c, await response.text());
});

authTest(
  "refresh",
  "empty refresh token retains the validation contract without an auth call",
  async (c) => {
    const response = await c.h.handler(
      userRequest("POST", "/v1/auth/refresh", { ip: c.ip, body: { refreshToken: "  " } }),
    );
    assertEquals(response.status, 400);
    assertEquals((await response.json()).error.code, "validation.refresh");
    assertEquals(c.h.calls.length, 0);
    await assertFailureBudget(c);
  },
);

authTest(
  "access",
  "repeated definitive denials still trip the pre-auth security budget",
  async (c) => {
    c.h.authResponse = () => authJson(401, { code: "bad_jwt" });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await c.h.handler(c.request());
      assertEquals(response.status, 401);
      await response.body?.cancel();
    }
    c.h.authResponse = c.success;
    const blocked = await c.h.handler(c.request());
    assertEquals(blocked.status, 429);
    await blocked.body?.cancel();
    assertEquals(c.h.callsTo("/auth/v1/").length, 30);
  },
);

for (const route of ["refresh", "bootstrap"] as const) {
  authTest(
    route,
    "relative lifetime remains available when upstream only supplies verified absolute expiry",
    async (c) => {
      c.h.authResponse = () => authJson(200, { ...c.session, expires_in: undefined });
      const response = await c.h.handler(c.request());
      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.session.expiresAt, c.session.expires_at);
      assertEquals(body.session.expiresIn, 3600);
    },
  );

  authTest(
    route,
    "relative lifetime is bounded by the verified expiry and time already elapsed",
    async (c) => {
      c.h.authResponse = () => {
        const response = authJson(200, {
          ...c.session,
          expires_at: Math.floor(Date.now() / 1000) + 30,
        });
        c.advance(1234);
        return response;
      };
      const response = await c.h.handler(c.request());
      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.session.expiresIn, 28.766);
    },
  );

  authTest(route, "relative lifetime never exceeds a shorter verified expires_in", async (c) => {
    c.h.authResponse = () => authJson(200, { ...c.session, expires_in: 10 });
    const response = await c.h.handler(c.request());
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.session.expiresAt, c.session.expires_at);
    assertEquals(body.session.expiresIn, 10);
  });
}

for (const route of ["refresh", "bootstrap", "legacy"] as const) {
  authTest(route, "a valid expires_in supplies an omitted expires_at", async (c) => {
    c.h.authResponse = () => authJson(200, { ...c.session, expires_at: undefined });
    const response = await c.h.handler(c.request());
    assertEquals(response.status, 200);
    const body = await response.json();
    if (route !== "legacy") assertEquals(body.session.expiresAt, c.session.expires_at);
    await assertFailureBudget(c);
  });

  authTest(route, "OAuth invalid_grant remains a definitive rejection", async (c) => {
    c.h.authResponse = () =>
      authJson(400, { error: "invalid_grant", error_description: PRIVATE_DETAIL });
    const response = await c.h.handler(c.request());
    assertEquals(response.status, 401);
    assertNoAuthSecrets(c, await response.text());
    await assertFailureBudget(c, 29);
  });
}

for (const route of ["bootstrap", "legacy"] as const) {
  authTest(route, "valid Apple tokens still use the Apple ID-token exchange", async (c) => {
    const token = fakeAppleIdToken(c.userId);
    c.h.tables["profiles"] = [
      { id: c.userId, email: c.user.email, provider: "apple", onboarding_state: "complete" },
    ];
    c.h.authResponse = () =>
      authJson(200, {
        ...c.session,
        user: { ...c.user, app_metadata: { provider: "apple", providers: ["apple"] } },
      });
    const response = await c.h.handler(
      userRequest(
        route === "bootstrap" ? "POST" : "GET",
        route === "bootstrap" ? "/v1/account/bootstrap" : "/v1/me/access",
        { ip: c.ip, token },
      ),
    );
    assertEquals(response.status, 200);
    await response.body?.cancel();
    assertEquals(c.h.callsTo("grant_type=id_token")[0].body, {
      provider: "apple",
      id_token: token,
    });
    await assertFailureBudget(c);
  });
}

for (const [method, path] of [
  ["GET", "/v1/me"],
  ["POST", "/v1/billing/sync"],
  ["POST", "/v1/auth/logout"],
]) {
  authTest(
    "access",
    `${method} ${path} propagates auth outages before downstream work`,
    async (c) => {
      for (const status of [503, 429]) {
        c.h.authResponse = () => authJson(status, { msg: PRIVATE_DETAIL }, { "Retry-After": "17" });
        const response = await c.h.handler(userRequest(method, path, { ip: c.ip, token: c.token }));
        assertEquals(response.status, status);
        if (status === 429) assertEquals(response.headers.get("retry-after"), "17");
        assertNoAuthSecrets(c, await response.text());
        await assertFailureBudget(c);
      }
      assertEquals(c.h.callsTo("/auth/v1/user").length, 2);
      assertEquals(c.h.calls.length, 2);
    },
  );
}

for (const route of ["access", "legacy"] as const) {
  authTest(
    route,
    "only valid verification is reused until the existing cache TTL expires",
    async (c) => {
      const initial = await c.h.handler(c.request());
      assertEquals(initial.status, 200);
      await initial.body?.cancel();
      c.h.authResponse = () => authJson(503, { msg: PRIVATE_DETAIL });
      const cached = await c.h.handler(c.request());
      assertEquals(cached.status, 200);
      await cached.body?.cancel();
      assertEquals(c.h.callsTo("/auth/v1/").length, 1);
      c.advance(601_000);
      const expired = await c.h.handler(c.request());
      assertEquals(expired.status, 503);
      assertNoAuthSecrets(c, await expired.text());
      assertEquals(c.h.callsTo("/auth/v1/").length, 2);
      await assertFailureBudget(c);
    },
  );
}

for (const wrapped of [false, true]) {
  authTest(
    "access",
    `a ${wrapped ? "wrapped" : "direct"} user with a linked Apple identity is accepted`,
    async (c) => {
      const user = {
        ...c.user,
        app_metadata: { provider: "email", providers: ["email", "apple"] },
      };
      c.h.authResponse = () => authJson(200, wrapped ? { user } : user);
      const response = await c.h.handler(c.request());
      assertEquals(response.status, 200);
      await response.body?.cancel();
      await assertFailureBudget(c);
    },
  );
}

authTest(
  "access",
  "logout still revokes only this device and drops its cached bearer",
  async (c) => {
    const signedIn = await c.h.handler(c.request());
    assertEquals(signedIn.status, 200);
    await signedIn.body?.cancel();
    const signedOut = await c.h.handler(
      userRequest("POST", "/v1/auth/logout", { token: c.token, ip: c.ip }),
    );
    assertEquals(signedOut.status, 204);
    const logout = c.h.callsTo("/auth/v1/logout?scope=local");
    assertEquals(logout.length, 1);
    assertEquals(logout[0].headers.authorization, `Bearer ${c.token}`);
    c.h.authResponse = () => authJson(401, { code: "session_not_found" });
    const revoked = await c.h.handler(c.request());
    assertEquals(revoked.status, 401);
    await revoked.body?.cancel();
    assertEquals(c.h.callsTo("/auth/v1/user").length, 2);
    await assertFailureBudget(c, 29);
  },
);

authTest("refresh", "unsafe numeric Retry-After values are not reflected", async (c) => {
  for (const value of ["-1", "1.5", "1e3", "9007199254740992"]) {
    c.h.authResponse = () => authJson(429, { msg: PRIVATE_DETAIL }, { "Retry-After": value });
    const response = await c.h.handler(c.request());
    assertEquals(response.status, 429);
    assertEquals(response.headers.get("retry-after"), null);
    assertNoAuthSecrets(c, await response.text());
  }
  await assertFailureBudget(c);
});

const ID_TOKEN_OAUTH_ERRORS = [
  { error: "invalid request", error_description: "Bad ID token" },
  {
    error: "invalid request",
    error_description: `Unacceptable audience in id_token: [${PRIVATE_DETAIL}]`,
  },
  { error: "invalid nonce" },
];

for (const route of ROUTES) {
  for (const body of ID_TOKEN_OAUTH_ERRORS) {
    authTest(
      route,
      `GoTrue OAuth ${JSON.stringify(body)} is scoped to ID-token grants`,
      async (c) => {
        c.h.authResponse = () => authJson(400, body);
        const response = await c.h.handler(c.request());
        const isIdToken = route === "bootstrap" || route === "legacy";
        assertEquals(response.status, isIdToken ? 401 : 503);
        const text = await response.text();
        assertNoAuthSecrets(c, text);
        if (body.error_description) {
          assert(!`${text}\n${c.logs.join("\n")}`.includes(body.error_description));
        }
        assertEquals(c.h.callsTo("/auth/v1/").length, 1);
        assertEquals(c.h.callsTo("/auth/v1/")[0].headers["x-supabase-api-version"], "2024-01-01");
        assertEquals(c.h.callsTo("/rest/v1/").length, 0);
        await assertFailureBudget(c, isIdToken ? 29 : 30);
      },
    );
  }

  for (const field of ["error_code", "error", "untyped_error_code"] as const) {
    authTest(route, `legacy numeric HTTP code falls through to string ${field}`, async (c) => {
      const code = route === "refresh" ? "refresh_token_not_found" : "bad_jwt";
      c.h.authResponse = () =>
        new Response(
          JSON.stringify({
            code: 400,
            ...(field === "error_code"
              ? { error_code: code }
              : { error: code, ...(field === "untyped_error_code" ? { error_code: 400 } : {}) }),
            msg: PRIVATE_DETAIL,
          }),
          { status: 400 },
        );
      const response = await c.h.handler(c.request());
      assertEquals(response.status, 401);
      assertNoAuthSecrets(c, await response.text());
      assertEquals(c.h.callsTo("/rest/v1/").length, 0);
      await assertFailureBudget(c, 29);
    });
  }

  authTest(route, "legacy numeric HTTP code does not hide a typed throttle", async (c) => {
    c.h.authResponse = () =>
      authJson(
        400,
        {
          code: 400,
          error_code: "over_request_rate_limit",
          msg: PRIVATE_DETAIL,
        },
        { "Retry-After": "17" },
      );
    const response = await c.h.handler(c.request());
    assertEquals(response.status, 429);
    assertEquals(response.headers.get("retry-after"), "17");
    assertNoAuthSecrets(c, await response.text());
    await assertFailureBudget(c);
  });

  authTest(route, "a string HTTP code keeps precedence over legacy denial fields", async (c) => {
    c.h.authResponse = () =>
      authJson(400, {
        code: "provider_disabled",
        error_code: "bad_jwt",
        error: "invalid_grant",
        error_description: PRIVATE_DETAIL,
      });
    const response = await c.h.handler(c.request());
    assertEquals(response.status, 503);
    assertNoAuthSecrets(c, await response.text());
    await assertFailureBudget(c);
  });
}

for (const route of ["bootstrap", "legacy"] as const) {
  authTest(route, "unknown OAuth errors and non-400 OAuth replies remain retryable", async (c) => {
    for (const [status, error] of [
      [400, "invalid_request"],
      [400, PRIVATE_DETAIL],
      [401, "invalid request"],
      [503, "invalid nonce"],
      [429, "invalid request"],
    ] as const) {
      c.h.authResponse = () => authJson(status, { error, error_description: PRIVATE_DETAIL });
      const response = await c.h.handler(c.request());
      assertEquals(response.status, status === 429 ? 429 : 503);
      assertNoAuthSecrets(c, await response.text());
      await assertFailureBudget(c);
    }
    assertEquals(c.h.callsTo("/rest/v1/").length, 0);
  });
}

interface LogoutTestContext extends AuthTestContext {
  cacheKey: string;
  logout(): Promise<Response>;
}

function logoutTest(name: string, run: (context: LogoutTestContext) => Promise<void>): void {
  authTest("access", `logout ${name}`, async (c) => {
    const signedIn = await c.h.handler(c.request());
    assertEquals(signedIn.status, 200);
    await signedIn.body?.cancel();
    const cacheKey = `auth:${await sha256Hex(c.token)}`;
    assert(await cacheGet(cacheKey));
    await run({
      ...c,
      cacheKey,
      logout: () =>
        c.h.handler(userRequest("POST", "/v1/auth/logout", { token: c.token, ip: c.ip })),
    });
  });
}

for (const [status, expected] of [
  [200, 204],
  [204, 204],
  [401, 204],
  [403, 204],
  [404, 204],
  [429, 429],
  [500, 503],
  [503, 503],
  [400, 503],
  [408, 503],
  [409, 503],
  [422, 503],
  [302, 503],
]) {
  logoutTest(
    `HTTP ${status} returns ${expected} and evicts before the upstream call`,
    async (c) => {
      let cachedAtLogout: string | null | undefined;
      c.h.authResponse = async () => {
        cachedAtLogout = await cacheGet(c.cacheKey);
        return status === 204
          ? new Response(null, { status })
          : authJson(
              status,
              {
                error: PRIVATE_DETAIL,
                error_description: `${PRIVATE_DETAIL} ${c.token} ${REFRESH_TOKEN}`,
              },
              { "Retry-After": "37" },
            );
      };
      const response = await c.logout();
      assertEquals(response.status, expected);
      assertEquals(cachedAtLogout, null, "eviction must precede even a failed revocation attempt");
      const text = await response.text();
      assertNoAuthSecrets(c, text);
      if (expected === 429) {
        assertEquals(response.headers.get("retry-after"), "37");
        assertEquals(JSON.parse(text), {
          error: { code: "rate_limited", message: RATE_LIMIT_MESSAGE },
        });
      } else if (expected === 503) {
        assertEquals(JSON.parse(text), {
          error: { message: "Sign-out is temporarily unavailable. Please try again." },
        });
      }
      const calls = c.h.callsTo("/auth/v1/logout");
      assertEquals(calls.length, 1);
      assertEquals(calls[0].url, `${SUPABASE_URL}/auth/v1/logout?scope=local`);
      assertEquals(calls[0].method, "POST");
      assertEquals(calls[0].headers.apikey, "anon-test-key");
      assertEquals(calls[0].headers.authorization, `Bearer ${c.token}`);
      await assertFailureBudget(c);
      c.h.authResponse = c.success;
      const retry = await c.h.handler(c.request());
      assertEquals(retry.status, 200);
      await retry.body?.cancel();
      assertEquals(c.h.callsTo("/auth/v1/user").length, 2, "the evicted bearer must be reverified");
    },
  );
}

for (const kind of ["transport", "timeout", "abort"] as const) {
  logoutTest(`${kind} failures are sanitized 503s, not unhandled 500s`, async (c) => {
    c.h.authResponse = () => {
      const detail = `${PRIVATE_DETAIL} ${c.token} ${REFRESH_TOKEN}`;
      throw kind === "transport"
        ? new TypeError(detail)
        : new DOMException(detail, kind === "timeout" ? "TimeoutError" : "AbortError");
    };
    const response = await c.logout();
    assertEquals(response.status, 503);
    assertNoAuthSecrets(c, await response.text());
    assertEquals(await cacheGet(c.cacheKey), null);
    await assertFailureBudget(c);
  });
}

logoutTest("opaque network failures are retryable, not successful revocations", async (c) => {
  c.h.authResponse = () => Response.error();
  const response = await c.logout();
  assertEquals(response.status, 503);
  assertNoAuthSecrets(c, await response.text());
  await assertFailureBudget(c);
});

for (const status of [200, 401, 429, 503]) {
  logoutTest(`cancels the unused HTTP ${status} response body without buffering it`, async (c) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(PRIVATE_DETAIL));
      },
      cancel() {
        cancelled = true;
      },
    });
    c.h.authResponse = () => new Response(body, { status });
    try {
      const response = await c.logout();
      assertEquals(response.status, status === 429 ? 429 : status === 503 ? 503 : 204);
      assertNoAuthSecrets(c, await response.text());
      assert(cancelled, "the upstream body must be released on every status branch");
      await assertFailureBudget(c);
    } finally {
      await body.cancel();
    }
  });
}

logoutTest("body cancellation failures are sanitized 503s", async (c) => {
  c.h.authResponse = () =>
    new Response(
      new ReadableStream({
        cancel() {
          throw new TypeError(`${PRIVATE_DETAIL} ${c.token}`);
        },
      }),
      { status: 200 },
    );
  const response = await c.logout();
  assertEquals(response.status, 503);
  assertNoAuthSecrets(c, await response.text());
  await assertFailureBudget(c);
});

for (const [value, expected] of [
  ["37", "37"],
  ["0017", "17"],
  [PRIVATE_DETAIL, null],
  ["-1", null],
  ["1.5", null],
  ["1e3", null],
  ["9007199254740992", null],
] as const) {
  logoutTest(`429 accepts only a safe Retry-After (${value})`, async (c) => {
    c.h.authResponse = () =>
      authJson(429, { error_description: PRIVATE_DETAIL }, { "Retry-After": value });
    const response = await c.logout();
    assertEquals(response.status, 429);
    assertEquals(response.headers.get("retry-after"), expected);
    assertNoAuthSecrets(c, await response.text());
    await assertFailureBudget(c);
  });
}

logoutTest("429 converts an HTTP-date Retry-After to a safe delay", async (c) => {
  c.h.authResponse = () =>
    authJson(
      429,
      { error_description: PRIVATE_DETAIL },
      {
        "Retry-After": new Date(Date.now() + 45_000).toUTCString(),
      },
    );
  const response = await c.logout();
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("retry-after"), "45");
  assertNoAuthSecrets(c, await response.text());
  await assertFailureBudget(c);
});

async function settledAfterDeadline(pending: Promise<Response>): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<Response>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("logout did not settle after its deadline")),
          1_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

logoutTest("bounds a stalled fetch to 10 seconds and forbids credential redirects", async (c) => {
  const realTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  const durations: number[] = [];
  AbortSignal.timeout = (ms) => {
    durations.push(ms);
    return controller.signal;
  };
  const entered = Promise.withResolvers<RecordedCall>();
  const upstream = Promise.withResolvers<Response>();
  c.h.authResponse = (call) => {
    entered.resolve(call);
    call.signal.addEventListener("abort", () => upstream.reject(call.signal.reason), {
      once: true,
    });
    return upstream.promise;
  };
  const pending = c.logout();
  try {
    const call = await entered.promise;
    assertEquals(durations, [10_000]);
    assertEquals(call.redirect, "error");
    controller.abort(new DOMException(PRIVATE_DETAIL, "TimeoutError"));
    const response = await settledAfterDeadline(pending);
    assertEquals(response.status, 503);
    assert(call.signal.aborted);
    assertNoAuthSecrets(c, await response.text());
    assertEquals(await cacheGet(c.cacheKey), null);
    await assertFailureBudget(c);
  } finally {
    AbortSignal.timeout = realTimeout;
    controller.abort();
    upstream.resolve(new Response(null, { status: 204 }));
    const response = await pending;
    await response.body?.cancel().catch(() => undefined);
  }
});

logoutTest("the same 10-second deadline also bounds stalled body cancellation", async (c) => {
  const realTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  const durations: number[] = [];
  AbortSignal.timeout = (ms) => {
    durations.push(ms);
    return controller.signal;
  };
  const cancelStarted = Promise.withResolvers<void>();
  const cancelFinished = Promise.withResolvers<void>();
  let cancelled = false;
  const upstream = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
        cancelStarted.resolve();
        return cancelFinished.promise;
      },
    }),
    { status: 200 },
  );
  c.h.authResponse = () => upstream;
  const pending = c.logout();
  try {
    await Promise.race([cancelStarted.promise, pending]);
    assert(cancelled, "logout must release the upstream response body");
    assertEquals(durations, [10_000]);
    controller.abort(new DOMException(PRIVATE_DETAIL, "TimeoutError"));
    const response = await settledAfterDeadline(pending);
    assertEquals(response.status, 503);
    assertNoAuthSecrets(c, await response.text());
    await assertFailureBudget(c);
  } finally {
    AbortSignal.timeout = realTimeout;
    controller.abort();
    cancelFinished.resolve();
    await upstream.body?.cancel();
    const response = await pending;
    await response.body?.cancel().catch(() => undefined);
  }
});

for (const concurrent of [false, true]) {
  authTest(
    "bootstrap",
    `bounds ${concurrent ? "concurrent" : "sequential"} valid ID-token replay before minting sessions`,
    async (c) => {
      let minted = 0;
      c.h.authResponse = (call) => {
        if (call.url.endsWith("/user")) return c.success(call);
        minted += 1;
        return authJson(200, { ...c.session, refresh_token: `fresh-session-${minted}` });
      };
      const run = async () => {
        const response = await c.h.handler(c.request());
        return { status: response.status, headers: response.headers, body: await response.json() };
      };
      const replies = concurrent
        ? await Promise.all(Array.from({ length: 31 }, run))
        : await (async () => {
            const replies = [];
            for (let attempt = 0; attempt < 31; attempt += 1) replies.push(await run());
            return replies;
          })();
      assertEquals(replies.filter((reply) => reply.status === 200).length, 30);
      const blocked = replies.find((reply) => reply.status === 429);
      assert(blocked, "the 31st valid replay must be stopped before creating another session");
      assertEquals(blocked.body, { error: { code: "rate_limited", message: RATE_LIMIT_MESSAGE } });
      assertEquals(blocked.headers.get("retry-after"), "50");
      assertEquals(blocked.headers.get("ratelimit-limit"), "30");
      assertEquals(blocked.headers.get("ratelimit-remaining"), "0");
      assertEquals(minted, 30);
      assertEquals(c.h.callsTo("grant_type=id_token").length, 30);
      assertEquals(c.h.callsTo("/rest/v1/profiles").length, 30);
      assertEquals(
        new Set(
          replies
            .filter((reply) => reply.status === 200)
            .map((reply) => reply.body.session.refreshToken),
        ).size,
        30,
      );
      await assertFailureBudget(c);
      assertEquals((await peekRateLimit("auth_bootstrap", c.ip, 30, 60)).remaining, 0);

      const access = await c.h.handler(
        userRequest("GET", "/v1/me/access", {
          token: String(c.session.access_token),
          ip: c.ip,
        }),
      );
      assertEquals(access.status, 200);
      await access.body?.cancel();
      assertEquals(c.h.callsTo("/auth/v1/logout").length, 0);
      c.advance(50_000);
      const recovered = await run();
      assertEquals(recovered.status, 200);
      assertEquals(minted, 31);
    },
  );
}

for (const status of [503, 429]) {
  authTest(
    "bootstrap",
    `upstream ${status} spends only the bootstrap attempt budget, never signs out`,
    async (c) => {
      c.h.authResponse = () =>
        authJson(status, { error_description: PRIVATE_DETAIL }, { "Retry-After": "7" });
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await c.h.handler(c.request());
        assertEquals(response.status, status);
        assertNoAuthSecrets(c, await response.text());
      }
      const blocked = await c.h.handler(c.request());
      assertEquals(blocked.status, 429);
      assertEquals(blocked.headers.get("ratelimit-limit"), "30");
      assertEquals(blocked.headers.get("retry-after"), "50");
      assertNoAuthSecrets(c, await blocked.text());
      assertEquals(c.h.callsTo("grant_type=id_token").length, 30);
      assertEquals(c.h.callsTo("/rest/v1/").length, 0);
      assertEquals(c.h.callsTo("/auth/v1/logout").length, 0);
      await assertFailureBudget(c);

      c.h.authResponse = c.success;
      const sameIp = await c.h.handler(
        userRequest("POST", "/v1/account/bootstrap", {
          token: fakeAppleIdToken(c.userId),
          ip: c.ip,
        }),
      );
      assertEquals(sameIp.status, 429);
      await sameIp.body?.cancel();
      const otherIp = await c.h.handler(
        userRequest("POST", "/v1/account/bootstrap", {
          token: c.token,
          ip: `203.0.113.${status === 503 ? 81 : 82}`,
        }),
      );
      assertEquals(otherIp.status, 200);
      await otherIp.body?.cancel();
      c.advance(50_000);
      const recovered = await c.h.handler(c.request());
      assertEquals(recovered.status, 200);
      await recovered.body?.cancel();
      await assertFailureBudget(c);
    },
  );
}
