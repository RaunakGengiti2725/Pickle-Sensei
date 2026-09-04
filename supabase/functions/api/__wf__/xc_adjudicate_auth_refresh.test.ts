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
