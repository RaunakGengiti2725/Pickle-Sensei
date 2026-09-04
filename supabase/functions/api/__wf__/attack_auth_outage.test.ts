// Adversarial tests for the XC-RS-01 / XC-RS-02 / XC-P1-AUTH-REFRESH-TRANSIENT-401
// fix (candidate 94f5221). Each test asserts the contract the fix claims
// (AGENTS.md "Auth sessions": the ONE implicit sign-out is the server refusing
// the credential; a transient Auth failure is 503 + Retry-After and is never
// charged to the per-IP auth-failure budget).
//
// ATTACK-GAP-*  fail on 94f5221: the id_token grant paths (POST
//               /v1/account/bootstrap, and the transitional provider-token
//               bearer branch of authenticate()) still turn an Auth outage
//               into 401 and charge the auth-failure budget.
// ATTACK-PIN-*  pass on 94f5221 and pin the variants that were probed
//               (body stall, late upstream answer, concurrency, odd statuses,
//               Retry-After parsing, timeout override parsing, cache/logout).
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json attack_auth_outage.test.ts

import { assert, assertEquals } from "@std/assert";
import { peekRateLimit } from "../rateLimit.ts";
import { fakeGoogleIdToken, loadHarness, SUPABASE_URL, TEST_USER_ID } from "./routesHarness.ts";

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

const onAuthPath =
  (
    matches: (url: string) => boolean,
    respond: (request: Request) => Promise<Response> | Response,
  ): Fault =>
  (request) =>
    matches(request.url) ? respond(request) : null;

const authUserFault = (respond: (request: Request) => Promise<Response> | Response) =>
  onAuthPath((url) => url.startsWith(`${SUPABASE_URL}/auth/v1/user`), respond);
const refreshFault = (respond: (request: Request) => Promise<Response> | Response) =>
  onAuthPath(
    (url) => url.includes("/auth/v1/token") && url.includes("grant_type=refresh_token"),
    respond,
  );
const idTokenGrantFault = (respond: (request: Request) => Promise<Response> | Response) =>
  onAuthPath(
    (url) => url.includes("/auth/v1/token") && url.includes("grant_type=id_token"),
    respond,
  );

async function call(
  handler: (request: Request) => Promise<Response>,
  init: { method: string; path: string; ip: string; bearer?: string; body?: unknown },
): Promise<{ status: number; body: string; headers: Headers }> {
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
  return { status: response.status, body: await response.text(), headers: response.headers };
}

/** Auth failures charged to the per-IP `authfail` budget (30 / 300 s). */
async function chargedFailures(ip: string): Promise<number> {
  const window = await peekRateLimit("authfail", ip, 30, 300);
  return window.limit - window.remaining;
}

const profileRow = () => ({
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
});

const transientAuthAnswers: Array<[string, () => Promise<Response> | Response]> = [
  ["HTTP 503", () => jsonResponse(503, { message: "upstream unavailable" })],
  ["HTTP 429", () => jsonResponse(429, { message: "rate limited" }, { "Retry-After": "5" })],
  ["network error (fetch rejects)", () => Promise.reject(new TypeError("connection reset"))],
  ["HTTP 200 non-JSON body", () => new Response("<html>gateway</html>", { status: 200 })],
];

// ── ATTACK-GAP-1: POST /v1/account/bootstrap spends the provider ID token via
// the id_token grant. During an Auth outage that grant fails for reasons that
// say nothing about the credential, yet the route answers 401 ("could not be
// verified" — the app maps it to the non-retryable `account.rejected`) and
// charges the auth-failure budget, so a shared-NAT venue locks itself out of
// signing in for 5 minutes after Auth recovers (the XC-RS-02 blast radius).
for (const [label, respond] of transientAuthAnswers) {
  Deno.test(
    `ATTACK-GAP-1 bootstrap during Auth outage (${label}) is 503 and uncharged`,
    async () => {
      const h = await loadHarness();
      const ip = `10.21.1.${Math.floor(Math.random() * 250)}`;
      const observed = await withFault(idTokenGrantFault(respond), () =>
        call(h.handler, {
          method: "POST",
          path: "/v1/account/bootstrap",
          ip,
          bearer: fakeGoogleIdToken(),
          body: { device: { platform: "ios", appVersion: "1.0.0" } },
        }),
      );
      const charged = await chargedFailures(ip);
      console.log(
        `  [ATTACK-GAP-1] ${label}: observed ${observed.status} charged=${charged} ${observed.body}`,
      );
      assertEquals(
        observed.status,
        503,
        `bootstrap must stay retryable when Auth is unavailable; observed ${observed.status}: ${observed.body}`,
      );
      assertEquals(charged, 0, `an Auth outage must not be charged to the auth-failure budget`);
    },
  );
}

// ── ATTACK-GAP-2: authenticate() still accepts a provider ID token as bearer
// (transitional branch, same function the fix changed). The same outage there
// is still 401 + charged; the app treats that as the bearer being refused.
for (const [label, respond] of transientAuthAnswers) {
  Deno.test(
    `ATTACK-GAP-2 transitional provider-token bearer during Auth outage (${label}) is 503 and uncharged`,
    async () => {
      const h = await loadHarness();
      const ip = `10.21.2.${Math.floor(Math.random() * 250)}`;
      const observed = await withFault(idTokenGrantFault(respond), () =>
        call(h.handler, { method: "GET", path: "/v1/me", ip, bearer: fakeGoogleIdToken() }),
      );
      const charged = await chargedFailures(ip);
      console.log(
        `  [ATTACK-GAP-2] ${label}: observed ${observed.status} charged=${charged} ${observed.body}`,
      );
      assertEquals(
        observed.status,
        503,
        `a transient Auth failure must not read as a refused bearer; observed ${observed.status}: ${observed.body}`,
      );
      assertEquals(charged, 0, `an Auth outage must not be charged to the auth-failure budget`);
    },
  );
}

// ── ATTACK-PIN-1: a 200 whose body never ends is bounded by the upstream deadline.
Deno.test("ATTACK-PIN-1 /user body stall is cut off by AUTH_UPSTREAM_TIMEOUT_MS", async () => {
  const h = await loadHarness();
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "300");
  try {
    const startedAt = performance.now();
    const observed = await withFault(
      authUserFault(
        () =>
          new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
      () =>
        call(h.handler, {
          method: "GET",
          path: "/v1/me",
          ip: "10.21.3.1",
          bearer: fakeSupabaseAccessToken(TEST_USER_ID, "stall"),
        }),
    );
    const elapsedMs = Math.round(performance.now() - startedAt);
    assertEquals(observed.status, 503, observed.body);
    assert(elapsedMs < 2000, `body stall took ${elapsedMs}ms`);
  } finally {
    Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
  }
});

// ── ATTACK-PIN-2: an upstream answer that lands AFTER the deadline is dropped —
// it neither charges the budget nor seeds the auth cache for the next request.
Deno.test(
  "ATTACK-PIN-2 late /user answer after the deadline does not poison the cache",
  async () => {
    const h = await loadHarness();
    Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "200");
    const bearer = fakeSupabaseAccessToken(TEST_USER_ID, "late");
    const ip = "10.21.4.1";
    let lateTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const late = await withFault(
        authUserFault(
          (request) =>
            new Promise<Response>((resolve, reject) => {
              request.signal.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
              lateTimer = setTimeout(() => resolve(jsonResponse(200, healthyUser())), 600);
            }),
        ),
        () => call(h.handler, { method: "GET", path: "/v1/me", ip, bearer }),
      );
      assertEquals(late.status, 503, late.body);
      assertEquals(await chargedFailures(ip), 0);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const refused = await withFault(
        authUserFault(() => jsonResponse(401, { code: 401, msg: "invalid JWT" })),
        () => call(h.handler, { method: "GET", path: "/v1/me", ip, bearer }),
      );
      assertEquals(refused.status, 401, `stale 200 must not be served from cache: ${refused.body}`);
    } finally {
      clearTimeout(lateTimer);
      Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
    }
  },
);

// ── ATTACK-PIN-3: 40 concurrent outage requests from one IP: all 503, nothing
// charged, and a valid bearer is served the moment Auth is back.
Deno.test("ATTACK-PIN-3 concurrent outage traffic charges nothing and recovers", async () => {
  const h = await loadHarness();
  const ip = "10.21.5.1";
  const results = await withFault(
    authUserFault(() => jsonResponse(503, { message: "down" })),
    () =>
      Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          call(h.handler, {
            method: "GET",
            path: "/v1/me",
            ip,
            bearer: fakeSupabaseAccessToken(TEST_USER_ID, `concurrent-${i}`),
          }),
        ),
      ),
  );
  assert(
    results.every((r) => r.status === 503),
    results.map((r) => r.status).join(","),
  );
  assertEquals(await chargedFailures(ip), 0);
  h.tables.profiles = [profileRow()];
  const recovered = await withFault(
    authUserFault(() => jsonResponse(200, healthyUser())),
    () =>
      call(h.handler, {
        method: "GET",
        path: "/v1/me",
        ip,
        bearer: fakeSupabaseAccessToken(TEST_USER_ID, "recovered"),
      }),
  );
  assertEquals(recovered.status, 200, recovered.body);
});

// ── ATTACK-PIN-4: every non-2xx status that is not a GoTrue verdict
// (3xx, 404/405/408/409/410/422, 5xx) is an outage: 503, never 401, uncharged.
for (const status of [301, 302, 304, 307, 404, 405, 408, 409, 410, 422, 451, 599]) {
  Deno.test(`ATTACK-PIN-4 /user HTTP ${status} is retryable and uncharged`, async () => {
    const h = await loadHarness();
    const ip = `10.21.6.${status % 250}`;
    const observed = await withFault(
      authUserFault(() => new Response(status === 304 ? null : "x", { status })),
      () =>
        call(h.handler, {
          method: "GET",
          path: "/v1/me",
          ip,
          bearer: fakeSupabaseAccessToken(TEST_USER_ID, `status-${status}`),
        }),
    );
    assertEquals(observed.status, 503, `${status}: ${observed.body}`);
    assertEquals(await chargedFailures(ip), 0);
  });
}

// ── ATTACK-PIN-5: Retry-After parsing — junk/zero/negative/fractional/HTTP-date
// upstream values fall back to the default; a positive integer is propagated.
for (const [header, expected] of [
  ["abc", "2"],
  ["-1", "2"],
  ["0", "2"],
  ["1.5", "2"],
  ["Wed, 21 Oct 2015 07:28:00 GMT", "2"],
  ["7", "7"],
  [null, "2"],
] as Array<[string | null, string]>) {
  Deno.test(
    `ATTACK-PIN-5 refresh 429 Retry-After ${JSON.stringify(header)} → ${expected}`,
    async () => {
      const h = await loadHarness();
      const observed = await withFault(
        refreshFault(() =>
          jsonResponse(
            429,
            { message: "rate limited" },
            header === null ? {} : { "Retry-After": header },
          ),
        ),
        () =>
          call(h.handler, {
            method: "POST",
            path: "/v1/auth/refresh",
            ip: "10.21.7.1",
            body: { refreshToken: "rt-live-device" },
          }),
      );
      assertEquals(observed.status, 503, observed.body);
      assertEquals(observed.headers.get("Retry-After"), expected);
    },
  );
}

// ── ATTACK-PIN-6: AUTH_UPSTREAM_TIMEOUT_MS junk values fall back to the default
// (the request still gets a bounded 503 on a network error, not a hang or a 401).
for (const value of ["0", "-5", "1.5", "NaN", "abc", "", "1e3"]) {
  Deno.test(
    `ATTACK-PIN-6 AUTH_UPSTREAM_TIMEOUT_MS=${JSON.stringify(value)} still answers 503`,
    async () => {
      const h = await loadHarness();
      Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", value);
      try {
        const observed = await withFault(
          authUserFault(() => Promise.reject(new TypeError("connection reset"))),
          () =>
            call(h.handler, {
              method: "GET",
              path: "/v1/me",
              ip: "10.21.8.1",
              bearer: fakeSupabaseAccessToken(TEST_USER_ID, `timeout-${value}`),
            }),
        );
        assertEquals(observed.status, 503, observed.body);
      } finally {
        Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
      }
    },
  );
}

// ── ATTACK-PIN-7: a bearer verified before the outage is served from cache
// during it; after logout drops it from the cache, the outage is 503 (not 401).
Deno.test("ATTACK-PIN-7 cached bearer survives the outage; logout + outage is 503", async () => {
  const h = await loadHarness();
  const ip = "10.21.9.1";
  const bearer = fakeSupabaseAccessToken(TEST_USER_ID, "cached");
  h.tables.profiles = [profileRow()];
  const first = await withFault(
    authUserFault(() => jsonResponse(200, healthyUser())),
    () => call(h.handler, { method: "GET", path: "/v1/me", ip, bearer }),
  );
  assertEquals(first.status, 200, first.body);
  const duringOutage = await withFault(
    authUserFault(() => Promise.reject(new TypeError("connection reset"))),
    () => call(h.handler, { method: "GET", path: "/v1/me", ip, bearer }),
  );
  assertEquals(duringOutage.status, 200, duringOutage.body);
  await withFault(
    onAuthPath(
      (url) => url.includes("/auth/v1/logout"),
      () => new Response(null, { status: 204 }),
    ),
    () => call(h.handler, { method: "POST", path: "/v1/auth/logout", ip, bearer }),
  );
  const afterLogout = await withFault(
    authUserFault(() => Promise.reject(new TypeError("connection reset"))),
    () => call(h.handler, { method: "GET", path: "/v1/me", ip, bearer }),
  );
  assertEquals(afterLogout.status, 503, afterLogout.body);
  assertEquals(await chargedFailures(ip), 0);
});

// ── ATTACK-PIN-8: refresh token bytes reach GoTrue unchanged (trimmed only);
// unicode and oversized tokens are not mangled or rejected locally.
for (const [label, token] of [
  ["unicode", "тест-🔥-token"],
  ["whitespace padded", "   rt-live   "],
  ["64 KiB", "a".repeat(64 * 1024)],
] as Array<[string, string]>) {
  Deno.test(`ATTACK-PIN-8 refresh token ${label} is forwarded verbatim`, async () => {
    const h = await loadHarness();
    let forwarded: unknown;
    const observed = await withFault(
      refreshFault(async (request) => {
        forwarded = ((await request.json()) as { refresh_token?: unknown }).refresh_token;
        return jsonResponse(200, {
          access_token: fakeSupabaseAccessToken(),
          refresh_token: "rt-next",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          expires_in: 3600,
          token_type: "bearer",
          user: healthyUser(),
        });
      }),
      () =>
        call(h.handler, {
          method: "POST",
          path: "/v1/auth/refresh",
          ip: "10.21.10.1",
          body: { refreshToken: token },
        }),
    );
    assertEquals(observed.status, 200, observed.body);
    assertEquals(forwarded, token.trim());
  });
}
