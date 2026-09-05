// Upstream-failure contract for the three routes that talk to Supabase Auth
// (GoTrue) on behalf of a credential:
//
//   POST /v1/auth/refresh        (rotateRefreshToken)
//   GET  /v1/me                  (authenticate → getUser)
//   POST /v1/account/bootstrap   (authenticateProviderToken → signInWithIdToken)
//
// For each route × GoTrue {429, 503, fetch throws}: the edge answers 429 or
// 503 with the generic body (no upstream detail), and NOTHING is charged to
// the per-IP auth-failure budget — a bootstrap from the same IP afterwards
// still reaches GoTrue instead of being refused 429. Only a genuine GoTrue
// refusal (400 invalid_grant / 401 session_not_found) is a 401 that charges.
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import {
  fakeGoogleIdToken,
  loadHarness,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

const h = await loadHarness();

const AUTH_FAILURE_LIMIT = 30;

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function supabaseAccessToken(jti: string, expSec = Math.floor(Date.now() / 1000) + 3600): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: TEST_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      exp: expSec,
      session_id: crypto.randomUUID(),
      jti,
    }),
  );
  return `${header}.${payload}.sig`;
}

type GoTrueFault = (request: Request, url: URL) => Response | Promise<Response> | null;

/** Intercept GoTrue calls in front of the harness's own fake Supabase. */
async function withGoTrue<T>(fault: GoTrueFault, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/")) {
      const handled = await fault(request.clone(), url);
      if (handled) return handled;
    }
    return previous(input, init);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

const goTrueJson = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const UPSTREAM_DETAIL = "upstream-detail-must-not-leak";

const faults: Array<{ label: string; respond: () => Response }> = [
  {
    label: "GoTrue 429",
    respond: () =>
      goTrueJson(
        429,
        { code: 429, error_code: "over_request_rate_limit", msg: UPSTREAM_DETAIL },
        { "Retry-After": "7" },
      ),
  },
  {
    label: "GoTrue 503",
    respond: () => goTrueJson(503, { code: 503, msg: UPSTREAM_DETAIL }),
  },
  {
    label: "GoTrue fetch throws",
    respond: () => {
      throw new TypeError(UPSTREAM_DETAIL);
    },
  },
];

const routes: Array<{
  label: string;
  goTruePath: string;
  request: (ip: string, index: number) => Request;
}> = [
  {
    label: "POST /v1/auth/refresh",
    goTruePath: "/auth/v1/token",
    request: (ip) =>
      new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ refreshToken: "rt-device" }),
      }),
  },
  {
    label: "GET /v1/me (Supabase access token)",
    goTruePath: "/auth/v1/user",
    request: (ip, index) =>
      userRequest("GET", "/v1/me", { ip, token: supabaseAccessToken(`upstream-${index}`) }),
  },
  {
    label: "POST /v1/account/bootstrap",
    goTruePath: "/auth/v1/token",
    request: (ip) =>
      userRequest("POST", "/v1/account/bootstrap", { ip, token: fakeGoogleIdToken(), body: {} }),
  },
];

/** Keep the connection-fault retry loop short so the thrown-fetch cases finish
 * in milliseconds instead of exhausting the full backoff schedule per call. */
async function withShortUpstreamDeadline<T>(run: () => Promise<T>): Promise<T> {
  const previous = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "150");
  try {
    return await run();
  } finally {
    if (previous === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
    else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previous);
  }
}

let ipCounter = 0;
const freshIp = () => `198.51.100.${(ipCounter += 1)}`;

for (const route of routes) {
  for (const fault of faults) {
    Deno.test(`${route.label} × ${fault.label} → 429/503 generic, nothing charged`, async () => {
      h.reset();
      const ip = freshIp();
      const observed: Array<{ status: number; body: string }> = [];
      const faultingGoTrue = (_request: Request, url: URL) =>
        url.pathname === route.goTruePath ? fault.respond() : null;
      const storm = async () => {
        for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
          const response = await h.handler(route.request(ip, i));
          observed.push({ status: response.status, body: await response.text() });
        }
      };
      await withShortUpstreamDeadline(() => withGoTrue(faultingGoTrue, storm));
      for (const { status, body } of observed) {
        assert(
          status === 429 || status === 503,
          `${route.label} answered ${status} ${body} for ${fault.label}; ` +
            "a transient upstream failure must be 429/503 (retryable), never a credential verdict",
        );
        const parsed = JSON.parse(body) as { error?: { message?: unknown; code?: unknown } };
        assertEquals(typeof parsed.error?.message, "string", `generic error body: ${body}`);
        assertEquals(body.includes(UPSTREAM_DETAIL), false, `upstream detail leaked: ${body}`);
        if (status === 503) {
          assertStringIncludes(
            String(parsed.error?.message),
            "is temporarily unavailable. Please try again.",
          );
        }
      }
      // GoTrue is healthy again: the same IP must still be able to sign in —
      // the budget was not spent by the outage.
      const tokenCallsBefore = h.callsTo("/auth/v1/token").length;
      const bootstrap = await h.handler(
        userRequest("POST", "/v1/account/bootstrap", { ip, token: fakeGoogleIdToken(), body: {} }),
      );
      const bootstrapBody = await bootstrap.text();
      assertNotEquals(
        bootstrap.status,
        429,
        `${AUTH_FAILURE_LIMIT} × ${fault.label} on ${route.label} spent the IP's auth-failure budget: ${bootstrapBody}`,
      );
      assert(
        h.callsTo("/auth/v1/token").length > tokenCallsBefore,
        "the post-outage bootstrap must reach GoTrue (not be refused pre-auth)",
      );
    });
  }
}

// ── Bootstrap: the exact shape of each transient verdict ─────────────────────
//
// signInWithIdToken goes through supabase-js, whose error taxonomy folds a
// thrown fetch into status 0 and a 429 into a generic AuthApiError; the edge
// must classify on what GoTrue actually said on the wire.

const bootstrapRequest = (ip: string) =>
  userRequest("POST", "/v1/account/bootstrap", { ip, token: fakeGoogleIdToken(), body: {} });

const onToken =
  (respond: (request: Request) => Response | Promise<Response>): GoTrueFault =>
  (request, url) =>
    url.pathname === "/auth/v1/token" ? respond(request) : null;

Deno.test(
  "bootstrap × GoTrue 429 → 429 with the upstream Retry-After and the generic body",
  async () => {
    h.reset();
    const ip = freshIp();
    let attempts = 0;
    const response = await withGoTrue(
      onToken(() => {
        attempts += 1;
        return goTrueJson(
          429,
          { code: 429, error_code: "over_request_rate_limit", msg: UPSTREAM_DETAIL },
          { "Retry-After": "7" },
        );
      }),
      () => h.handler(bootstrapRequest(ip)),
    );
    const body = await response.text();
    assertEquals(response.status, 429, body);
    assertEquals(
      response.headers.get("Retry-After"),
      "7",
      "upstream Retry-After must be forwarded",
    );
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    assertEquals(typeof parsed.error?.message, "string", body);
    assertEquals(body.includes(UPSTREAM_DETAIL), false, `upstream detail leaked: ${body}`);
    assertEquals(attempts, 1, "an upstream 429 is not a connection fault: no retry");
  },
);

for (const [label, respond] of [
  ["500", () => goTrueJson(500, { code: 500, msg: UPSTREAM_DETAIL })],
  ["502", () => new Response("<html>bad gateway</html>", { status: 502 })],
  ["503", () => goTrueJson(503, { code: 503, msg: UPSTREAM_DETAIL })],
  ["504", () => new Response(UPSTREAM_DETAIL, { status: 504 })],
  ["520", () => new Response("", { status: 520 })],
  ["200 non-JSON", () => new Response("<html>ok</html>", { status: 200 })],
  ["200 {}", () => goTrueJson(200, {})],
  [
    "200 without refresh_token",
    () =>
      goTrueJson(200, {
        access_token: supabaseAccessToken("no-refresh"),
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: TEST_USER_ID, email: null },
      }),
  ],
] as const) {
  Deno.test(
    `bootstrap × GoTrue ${label} → 503 "Sign-in is temporarily unavailable", nothing charged`,
    async () => {
      h.reset();
      const ip = freshIp();
      const response = await withGoTrue(onToken(respond), () => h.handler(bootstrapRequest(ip)));
      const body = await response.text();
      assertEquals(response.status, 503, body);
      assert(response.headers.get("Retry-After"), "a 503 carries Retry-After");
      assertEquals(
        body,
        JSON.stringify({
          error: { message: "Sign-in is temporarily unavailable. Please try again." },
        }),
      );
      // Not charged: the next bootstrap from this IP reaches GoTrue.
      const before = h.callsTo("/auth/v1/token").length;
      const healthy = await h.handler(bootstrapRequest(ip));
      await healthy.body?.cancel();
      assertNotEquals(
        healthy.status,
        429,
        "the transient failure spent the IP's auth-failure budget",
      );
      assertEquals(
        h.callsTo("/auth/v1/token").length,
        before + 1,
        "post-outage bootstrap reaches GoTrue",
      );
    },
  );
}

Deno.test(
  "bootstrap × GoTrue fetch throws → 503 after the bounded connect retry, nothing charged",
  async () => {
    h.reset();
    const ip = freshIp();
    let attempts = 0;
    const started = performance.now();
    const response = await withShortUpstreamDeadline(() =>
      withGoTrue(
        onToken(() => {
          attempts += 1;
          throw new TypeError(UPSTREAM_DETAIL);
        }),
        () => h.handler(bootstrapRequest(ip)),
      ),
    );
    const elapsedMs = performance.now() - started;
    const body = await response.text();
    assertEquals(response.status, 503, body);
    assertEquals(
      body,
      JSON.stringify({
        error: { message: "Sign-in is temporarily unavailable. Please try again." },
      }),
    );
    assert(
      attempts >= 2,
      `connection faults are retried inside the deadline (attempts=${attempts})`,
    );
    assert(
      elapsedMs < 2_000,
      `bounded by AUTH_UPSTREAM_TIMEOUT_MS=150 (took ${elapsedMs.toFixed(0)}ms)`,
    );
    const before = h.callsTo("/auth/v1/token").length;
    const healthy = await h.handler(bootstrapRequest(ip));
    await healthy.body?.cancel();
    assertNotEquals(
      healthy.status,
      429,
      "the transient failure spent the IP's auth-failure budget",
    );
    assertEquals(
      h.callsTo("/auth/v1/token").length,
      before + 1,
      "post-outage bootstrap reaches GoTrue",
    );
  },
);

// ── Controls: genuine refusals stay 401 and charge the budget ────────────────

for (const [status, body] of [
  [400, { error: "invalid_grant", error_description: "Bad ID token" }],
  [401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" }],
  [403, { code: 403, error_code: "provider_disabled", msg: "Provider is not enabled" }],
] as const) {
  Deno.test(
    `control: bootstrap with GoTrue ${status} refusal of the ID token → 401 and charges authfail`,
    async () => {
      h.reset();
      const ip = freshIp();
      const statuses = new Set<number>();
      await withGoTrue(
        onToken(() => goTrueJson(status, body)),
        async () => {
          for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
            const response = await h.handler(bootstrapRequest(ip));
            statuses.add(response.status);
            await response.body?.cancel();
          }
        },
      );
      assertEquals([...statuses], [401], "a genuine refusal of the ID token is 401");
      const tokenCallsBefore = h.callsTo("/auth/v1/token").length;
      const locked = await h.handler(bootstrapRequest(ip));
      await locked.body?.cancel();
      assertEquals(locked.status, 429, "refused ID tokens must spend the auth-failure budget");
      assertEquals(
        h.callsTo("/auth/v1/token").length,
        tokenCallsBefore,
        "refused pre-auth: no GoTrue call",
      );
    },
  );
}

Deno.test("control: refresh with GoTrue 400 invalid_grant → 401 and charges authfail", async () => {
  h.reset();
  const ip = freshIp();
  let status = 0;
  await withGoTrue(
    (_request, url) =>
      url.pathname === "/auth/v1/token"
        ? goTrueJson(400, { error: "invalid_grant", error_description: "Invalid Refresh Token" })
        : null,
    async () => {
      for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
        const response = await h.handler(routes[0].request(ip, i));
        status = response.status;
        await response.body?.cancel();
      }
    },
  );
  assertEquals(status, 401);
  const tokenCallsBefore = h.callsTo("/auth/v1/token").length;
  const bootstrap = await h.handler(
    userRequest("POST", "/v1/account/bootstrap", { ip, token: fakeGoogleIdToken(), body: {} }),
  );
  await bootstrap.body?.cancel();
  assertEquals(bootstrap.status, 429, "refused refreshes must spend the auth-failure budget");
  assertEquals(h.callsTo("/auth/v1/token").length, tokenCallsBefore);
});

Deno.test("control: getUser 401 session_not_found → 401 and charges authfail", async () => {
  h.reset();
  const ip = freshIp();
  let status = 0;
  await withGoTrue(
    (_request, url) =>
      url.pathname === "/auth/v1/user"
        ? goTrueJson(401, { code: 401, error_code: "session_not_found", msg: "Session not found" })
        : null,
    async () => {
      for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
        const response = await h.handler(routes[1].request(ip, i));
        status = response.status;
        await response.body?.cancel();
      }
    },
  );
  assertEquals(status, 401);
  const tokenCallsBefore = h.callsTo("/auth/v1/token").length;
  const bootstrap = await h.handler(
    userRequest("POST", "/v1/account/bootstrap", { ip, token: fakeGoogleIdToken(), body: {} }),
  );
  await bootstrap.body?.cancel();
  assertEquals(bootstrap.status, 429, "refused bearers must spend the auth-failure budget");
  assertEquals(h.callsTo("/auth/v1/token").length, tokenCallsBefore);
});
