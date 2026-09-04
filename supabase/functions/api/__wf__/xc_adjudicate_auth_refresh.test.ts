// Adjudication reproduction (xc-journeys / journey-signin-restore):
// POST /v1/auth/refresh must only answer 401 when GoTrue REFUSED the refresh
// token. A GoTrue 429 (rate limit) or a network failure reaching GoTrue is
// transient — the mobile client signs the user out on 401/403
// (apps/mobile/src/account/sessionLifecycle.ts), so mapping transient
// failures to 401 turns a hiccup into an implicit sign-out.
import { assertEquals } from "@std/assert";
import { loadHarness, SUPABASE_URL } from "./routesHarness.ts";

async function refreshWith(
  gotrue: (request: Request) => Promise<Response>,
  ip: string,
): Promise<Response> {
  const harness = await loadHarness();
  const harnessFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
      return gotrue(request);
    }
    return harnessFetch(input, init);
  }) as typeof fetch;
  try {
    return await harness.handler(
      new Request("http://edge.test/v1/auth/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ refreshToken: "still-valid-refresh-token" }),
      }),
    );
  } finally {
    globalThis.fetch = harnessFetch;
  }
}

Deno.test(
  "refresh: GoTrue 429 (rate limited) must not be reported as 401 (session revoked)",
  async () => {
    const response = await refreshWith(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ code: 429, msg: "over_request_rate_limit" }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      "10.99.0.1",
    );
    await response.text();
    console.log(`[adjudicate] GoTrue 429 -> edge ${response.status}`);
    assertEquals(
      response.status === 401 || response.status === 403,
      false,
      `edge answered ${response.status}: the app treats 401/403 as 'refresh token revoked' and signs out`,
    );
  },
);

Deno.test("refresh: GoTrue unreachable (fetch TypeError) must not be reported as 401", async () => {
  const response = await refreshWith(
    () => Promise.reject(new TypeError("error sending request: connection refused")),
    "10.99.0.2",
  );
  await response.text();
  console.log(`[adjudicate] GoTrue network failure -> edge ${response.status}`);
  assertEquals(
    response.status === 401 || response.status === 403,
    false,
    `edge answered ${response.status}: the app treats 401/403 as 'refresh token revoked' and signs out`,
  );
});

Deno.test(
  "refresh: a socket that drops before GoTrue answers is retried inside the deadline — the eventual verdict wins",
  async () => {
    // Two connection resets, then a real refusal: the app must see 401 (the
    // credential is dead), not a 503 that would make it retry a dead token.
    let calls = 0;
    const refused = await refreshWith(() => {
      calls += 1;
      if (calls <= 2) return Promise.reject(new TypeError("connection reset by peer"));
      return Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_grant", msg: "Invalid Refresh Token" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }, "10.99.0.4");
    await refused.text();
    assertEquals(calls, 3);
    assertEquals(refused.status, 401);

    // ...and the same faults before a successful rotation yield the rotation.
    calls = 0;
    const rotated = await refreshWith(() => {
      calls += 1;
      if (calls <= 2) return Promise.reject(new TypeError("connection reset by peer"));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { id: "00000000-0000-4000-8000-000000000099", email: "r@example.com" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }, "10.99.0.5");
    const body = (await rotated.json()) as { session?: { refreshToken?: string } };
    assertEquals(calls, 3);
    assertEquals(rotated.status, 200);
    assertEquals(body.session?.refreshToken, "rotated-refresh");
  },
);

Deno.test(
  "refresh: an HTTP answer is never re-sent — GoTrue 502 is answered 503 after exactly one call",
  async () => {
    let calls = 0;
    const response = await refreshWith(() => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ code: 502, msg: "bad gateway" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }, "10.99.0.6");
    await response.text();
    assertEquals(calls, 1);
    assertEquals(response.status, 503);
  },
);

Deno.test(
  "refresh: a 200 whose session is dead on arrival (expires_in 0 / expires_at in the past) is 503, not a rotation",
  async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<Record<string, unknown>> = [
      { expires_in: 0, expires_at: now + 3600 },
      { expires_in: -5 },
      { expires_in: 3600, expires_at: now - 1 },
      { expires_in: "3600" },
    ];
    for (const [k, extra] of cases.entries()) {
      const response = await refreshWith(
        () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                access_token: "dead-access",
                refresh_token: "dead-refresh",
                user: { id: "00000000-0000-4000-8000-000000000098" },
                ...extra,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          ),
        `10.99.1.${k}`,
      );
      await response.text();
      assertEquals(response.status, 503, `case ${JSON.stringify(extra)} → ${response.status}`);
    }
  },
);

Deno.test(
  "refresh: GoTrue 400 invalid_grant (token revoked/rotated) IS 401 (control)",
  async () => {
    const response = await refreshWith(
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: "invalid_grant", error_description: "Invalid Refresh Token" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          ),
        ),
      "10.99.0.3",
    );
    await response.text();
    assertEquals(response.status, 401);
  },
);
