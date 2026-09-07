// Adjudication reproductions for area xc-ci-release-static (commit 4d812e1a),
// cluster XC-RS-01 + XC-RS-02 (+ xc-journeys XC-P1-AUTH-REFRESH-TRANSIENT-401).
//
// Each test asserts the EXPECTED contract (AGENTS.md "Auth sessions": the ONE
// implicit sign-out is the server refusing the refresh token; anything
// transient must stay retryable for the app). A failing test here is a
// reproduced defect, not a harness problem — the observed status is printed
// beside the expectation so the log doubles as evidence.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json adjudicate_xc_ci_release_static.test.ts

import { assert, assertEquals } from "@std/assert";
import { loadHarness, SUPABASE_URL, TEST_USER_ID } from "./routesHarness.ts";

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A syntactically valid Supabase-issued ACCESS token (iss ends in /auth/v1). */
function fakeSupabaseAccessToken(sub = TEST_USER_ID, salt = ""): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      salt,
    }),
  );
  return `${header}.${payload}.sig`;
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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

const healthyUser = () => ({
  id: TEST_USER_ID,
  aud: "authenticated",
  role: "authenticated",
  email: "user@example.com",
  app_metadata: { provider: "apple", providers: ["apple"] },
  user_metadata: {},
  created_at: new Date().toISOString(),
});

const authUserFault =
  (respond: () => Promise<Response> | Response): Fault =>
  (request) => {
    if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      return respond();
    }
    return null;
  };

const refreshFault =
  (respond: () => Promise<Response> | Response): Fault =>
  (request) => {
    if (
      request.url.includes("/auth/v1/token") &&
      request.url.includes("grant_type=refresh_token")
    ) {
      return respond();
    }
    return null;
  };

async function statusOf(
  handler: (request: Request) => Promise<Response>,
  init: {
    method: string;
    path: string;
    ip: string;
    bearer?: string;
    body?: unknown;
  },
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    "x-forwarded-for": init.ip,
    "content-type": "application/json",
  };
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  const response = await handler(
    new Request(`http://edge.test${init.path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
  return { status: response.status, body: await response.text() };
}

const isTransientStatus = (status: number) => status === 503 || status === 502 || status === 429;

// ── AUTH-OUTAGE-1: authenticate() maps a transient Supabase Auth failure to 401.
for (const [label, respond] of [
  ["auth.getUser → HTTP 503", () => jsonResponse(503, { message: "upstream unavailable" })],
  ["auth.getUser → HTTP 502 html", () => new Response("<html>bad gateway</html>", { status: 502 })],
  [
    "auth.getUser → HTTP 429",
    () => jsonResponse(429, { message: "rate limited" }, { "Retry-After": "5" }),
  ],
  [
    "auth.getUser → network error (fetch rejects)",
    () => Promise.reject(new TypeError("connection reset")),
  ],
] as Array<[string, () => Promise<Response> | Response]>) {
  Deno.test(`AUTH-OUTAGE-1 authenticated route stays retryable when ${label}`, async () => {
    const h = await loadHarness();
    const ip = `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const bearer = fakeSupabaseAccessToken(TEST_USER_ID, crypto.randomUUID());
    const observed = await withFault(authUserFault(respond), () =>
      statusOf(h.handler, { method: "GET", path: "/v1/me", ip, bearer }),
    );
    console.log(`  [AUTH-OUTAGE-1] ${label}: observed ${observed.status} ${observed.body}`);
    assert(
      isTransientStatus(observed.status),
      `expected 503/429 (retryable) for a transient Auth failure, observed ${observed.status}: ${observed.body}`,
    );
  });
}

// ── AUTH-OUTAGE-2: /v1/auth/refresh maps a non-5xx transient failure to 401,
// which the app treats as "server refused the refresh token" → sign-out.
for (const [label, respond] of [
  [
    "refreshSession → HTTP 429",
    () => jsonResponse(429, { message: "rate limited" }, { "Retry-After": "5" }),
  ],
  [
    "refreshSession → HTTP 200 non-JSON body",
    () =>
      new Response("<html>gateway</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
  ],
  ["refreshSession → HTTP 200 JSON without session", () => jsonResponse(200, { ok: true })],
] as Array<[string, () => Promise<Response> | Response]>) {
  Deno.test(`AUTH-OUTAGE-2 /v1/auth/refresh does not answer 401 when ${label}`, async () => {
    const h = await loadHarness();
    const ip = `10.2.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const observed = await withFault(refreshFault(respond), () =>
      statusOf(h.handler, {
        method: "POST",
        path: "/v1/auth/refresh",
        ip,
        body: { refreshToken: "rt-live-device" },
      }),
    );
    console.log(`  [AUTH-OUTAGE-2] ${label}: observed ${observed.status} ${observed.body}`);
    assert(
      observed.status !== 401,
      `refresh must not tell the app to sign out on a transient failure; observed 401: ${observed.body}`,
    );
  });
}

Deno.test(
  "AUTH-OUTAGE-2b /v1/auth/refresh with Auth network error: status + wall time",
  async () => {
    const h = await loadHarness();
    const ip = "10.2.250.1";
    const startedAt = performance.now();
    const observed = await withFault(
      refreshFault(() => Promise.reject(new TypeError("connection reset"))),
      () =>
        statusOf(h.handler, {
          method: "POST",
          path: "/v1/auth/refresh",
          ip,
          body: { refreshToken: "rt-live-device" },
        }),
    );
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.log(
      `  [AUTH-OUTAGE-2b] network error: observed ${observed.status} after ${elapsedMs}ms ${observed.body}`,
    );
    assert(
      observed.status !== 401,
      `refresh must not tell the app to sign out on a network error; observed 401 after ${elapsedMs}ms`,
    );
  },
);

// ── AUTH-OUTAGE-3: outage-induced 401s are charged to the per-IP auth-failure
// budget (30 / 5 min), so a NAT'd office/carrier IP is locked out (429) once
// Auth recovers.
Deno.test("AUTH-OUTAGE-3 Auth outage must not trip the per-IP auth-failure lockout", async () => {
  const h = await loadHarness();
  const ip = "10.3.0.7";
  let outage401 = 0;
  await withFault(
    authUserFault(() => jsonResponse(503, { message: "down" })),
    async () => {
      for (let i = 0; i < 31; i++) {
        const r = await statusOf(h.handler, {
          method: "GET",
          path: "/v1/me",
          ip,
          bearer: fakeSupabaseAccessToken(TEST_USER_ID, `outage-${i}`),
        });
        if (r.status === 401) outage401 += 1;
      }
    },
  );
  // Auth recovered: a perfectly valid bearer from the same IP.
  h.tables.profiles = [
    {
      id: TEST_USER_ID,
      email: "user@example.com",
      onboarding_state: "complete",
      provider: "apple",
      skill_level: null,
      handedness: null,
      primary_goal: null,
      biggest_problem: null,
      focus_checkpoint: null,
      first_name: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];
  const recovered = await withFault(
    authUserFault(() => jsonResponse(200, healthyUser())),
    () =>
      statusOf(h.handler, {
        method: "GET",
        path: "/v1/me",
        ip,
        bearer: fakeSupabaseAccessToken(TEST_USER_ID, "recovered"),
      }),
  );
  // Control: the same valid bearer from an IP that saw no outage is served.
  const control = await withFault(
    authUserFault(() => jsonResponse(200, healthyUser())),
    () =>
      statusOf(h.handler, {
        method: "GET",
        path: "/v1/me",
        ip: "10.3.0.8",
        bearer: fakeSupabaseAccessToken(TEST_USER_ID, "control"),
      }),
  );
  console.log(
    `  [AUTH-OUTAGE-3] ${outage401}/31 outage responses were 401; after recovery observed ${recovered.status} ${recovered.body}; control IP observed ${control.status}`,
  );
  assertEquals(control.status, 200, `control request failed: ${control.body}`);
  assert(
    recovered.status !== 429,
    `valid bearer after Auth recovery must not be rate-limited; observed 429: ${recovered.body}`,
  );
});

// ── Controls and edges for the fix: a DEFINITIVE Auth verdict must still be
// 401 (that is the one signal the app may sign out on), a 200 whose body is
// not a user/session is an outage, and every retryable answer names a
// Retry-After so the app's backoff has something to honor.
for (const [label, respond] of [
  [
    "auth.getUser → HTTP 200 non-JSON body",
    () => new Response("<html>gateway</html>", { status: 200 }),
  ],
  ["auth.getUser → HTTP 200 JSON without a user id", () => jsonResponse(200, { ok: true })],
] as Array<[string, () => Promise<Response> | Response]>) {
  Deno.test(`AUTH-OUTAGE-1 authenticated route stays retryable when ${label}`, async () => {
    const h = await loadHarness();
    const ip = `10.1.251.${Math.floor(Math.random() * 250)}`;
    const bearer = fakeSupabaseAccessToken(TEST_USER_ID, crypto.randomUUID());
    const observed = await withFault(authUserFault(respond), () =>
      statusOf(h.handler, { method: "GET", path: "/v1/me", ip, bearer }),
    );
    console.log(`  [AUTH-OUTAGE-1] ${label}: observed ${observed.status} ${observed.body}`);
    assertEquals(
      observed.status,
      503,
      `expected 503 for a malformed Auth answer: ${observed.body}`,
    );
  });
}

for (const [label, respond] of [
  [
    "auth.getUser → HTTP 401 bad_jwt",
    () =>
      jsonResponse(401, {
        code: 401,
        msg: "invalid JWT: unable to parse or verify signature",
      }),
  ],
  [
    "auth.getUser → HTTP 403 session_not_found",
    () =>
      jsonResponse(403, {
        code: 403,
        error_code: "session_not_found",
        msg: "Session from session_id claim in JWT does not exist",
      }),
  ],
] as Array<[string, () => Promise<Response> | Response]>) {
  Deno.test(`AUTH-OUTAGE-1 control: ${label} is a definitive 401`, async () => {
    const h = await loadHarness();
    const ip = `10.1.252.${Math.floor(Math.random() * 250)}`;
    const bearer = fakeSupabaseAccessToken(TEST_USER_ID, crypto.randomUUID());
    const observed = await withFault(authUserFault(respond), () =>
      statusOf(h.handler, { method: "GET", path: "/v1/me", ip, bearer }),
    );
    assertEquals(observed.status, 401, `a refused bearer must stay 401: ${observed.body}`);
  });
}

for (const [label, respond] of [
  [
    "refreshSession → HTTP 400 invalid_grant",
    () =>
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Invalid Refresh Token: Refresh Token Not Found",
      }),
  ],
  ["refreshSession → HTTP 401", () => jsonResponse(401, { code: 401, msg: "Invalid token" })],
  [
    "refreshSession → HTTP 403 user_banned",
    () =>
      jsonResponse(403, {
        code: 403,
        error_code: "user_banned",
        msg: "User is banned",
      }),
  ],
] as Array<[string, () => Promise<Response> | Response]>) {
  Deno.test(`AUTH-OUTAGE-2 control: ${label} is a definitive 401`, async () => {
    const h = await loadHarness();
    const ip = `10.2.251.${Math.floor(Math.random() * 250)}`;
    const observed = await withFault(refreshFault(respond), () =>
      statusOf(h.handler, {
        method: "POST",
        path: "/v1/auth/refresh",
        ip,
        body: { refreshToken: "rt-revoked-device" },
      }),
    );
    assertEquals(observed.status, 401, `a refused refresh token must stay 401: ${observed.body}`);
  });
}

Deno.test(
  "AUTH-OUTAGE-2 transient refresh answers carry Retry-After (upstream 429 hint propagated)",
  async () => {
    const h = await loadHarness();
    const limited = await withFault(
      refreshFault(() => jsonResponse(429, { message: "rate limited" }, { "Retry-After": "7" })),
      async () => {
        const response = await h.handler(
          new Request("http://edge.test/v1/auth/refresh", {
            method: "POST",
            headers: {
              "x-forwarded-for": "10.2.252.1",
              "content-type": "application/json",
            },
            body: JSON.stringify({ refreshToken: "rt-live-device" }),
          }),
        );
        return {
          status: response.status,
          retryAfter: response.headers.get("Retry-After"),
          body: await response.text(),
        };
      },
    );
    assertEquals(limited.status, 503, limited.body);
    assertEquals(limited.retryAfter, "7");

    const down = await withFault(
      refreshFault(() => Promise.reject(new TypeError("connection reset"))),
      async () => {
        const response = await h.handler(
          new Request("http://edge.test/v1/auth/refresh", {
            method: "POST",
            headers: {
              "x-forwarded-for": "10.2.252.2",
              "content-type": "application/json",
            },
            body: JSON.stringify({ refreshToken: "rt-live-device" }),
          }),
        );
        return {
          status: response.status,
          retryAfter: response.headers.get("Retry-After"),
          body: await response.text(),
        };
      },
    );
    assertEquals(down.status, 503, down.body);
    assert(
      Number(down.retryAfter) >= 1,
      `network-failure 503 must name a Retry-After: ${down.retryAfter}`,
    );
  },
);

Deno.test("AUTH-OUTAGE-2 a healthy refresh still rotates the session (200)", async () => {
  const h = await loadHarness();
  const observed = await statusOf(h.handler, {
    method: "POST",
    path: "/v1/auth/refresh",
    ip: "10.2.253.1",
    body: { refreshToken: "rt-live-device" },
  });
  assertEquals(observed.status, 200, observed.body);
  const parsed = JSON.parse(observed.body) as {
    session?: Record<string, unknown>;
  };
  assertEquals(typeof parsed.session?.accessToken, "string");
  assertEquals(typeof parsed.session?.refreshToken, "string");
  assertEquals(typeof parsed.session?.expiresAt, "number");
});

Deno.test(
  "AUTH-OUTAGE-2b bounded upstream timeout: a hanging Auth call answers 503 within budget",
  async () => {
    const h = await loadHarness();
    const previous = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
    Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "400");
    try {
      const startedAt = performance.now();
      const observed = await withFault(
        refreshFault(() => new Promise<Response>(() => {})),
        () =>
          statusOf(h.handler, {
            method: "POST",
            path: "/v1/auth/refresh",
            ip: "10.2.250.2",
            body: { refreshToken: "rt-live-device" },
          }),
      );
      const elapsedMs = Math.round(performance.now() - startedAt);
      console.log(
        `  [AUTH-OUTAGE-2b] hang: observed ${observed.status} after ${elapsedMs}ms ${observed.body}`,
      );
      assertEquals(observed.status, 503, observed.body);
      assert(elapsedMs < 5_000, `expected the bounded timeout to fire, took ${elapsedMs}ms`);
    } finally {
      if (previous === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
      else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previous);
    }
  },
);

Deno.test(
  "AUTH-OUTAGE-2b bounded upstream timeout: a hanging getUser answers 503 within budget",
  async () => {
    const h = await loadHarness();
    const previous = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
    Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "400");
    try {
      const startedAt = performance.now();
      const observed = await withFault(
        authUserFault(() => new Promise<Response>(() => {})),
        () =>
          statusOf(h.handler, {
            method: "GET",
            path: "/v1/me",
            ip: "10.1.250.2",
            bearer: fakeSupabaseAccessToken(TEST_USER_ID, "hang"),
          }),
      );
      const elapsedMs = Math.round(performance.now() - startedAt);
      assertEquals(observed.status, 503, observed.body);
      assert(elapsedMs < 5_000, `expected the bounded timeout to fire, took ${elapsedMs}ms`);
    } finally {
      if (previous === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
      else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previous);
    }
  },
);

// ── LOGOUT-1: logoutRoute() maps a 5xx from Auth to 503 but a THROWN fetch
// error (DNS, reset, timeout) must not escape to the generic 500 either.
Deno.test("LOGOUT-1 /v1/auth/logout answers 503 (not 500) when Auth is unreachable", async () => {
  const h = await loadHarness();
  const ip = "10.4.0.1";
  const bearer = fakeSupabaseAccessToken(TEST_USER_ID, "logout");
  const observed = await withFault(
    (request) => {
      if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
        return jsonResponse(200, healthyUser());
      }
      if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/logout`)) {
        return Promise.reject(new TypeError("connection reset"));
      }
      return null;
    },
    () =>
      statusOf(h.handler, {
        method: "POST",
        path: "/v1/auth/logout",
        ip,
        bearer,
      }),
  );
  console.log(`  [LOGOUT-1] observed ${observed.status} ${observed.body}`);
  assertEquals(
    observed.status,
    503,
    `logout on Auth network error must be the generic 503 'temporarily unavailable', observed ${observed.status}`,
  );
});
