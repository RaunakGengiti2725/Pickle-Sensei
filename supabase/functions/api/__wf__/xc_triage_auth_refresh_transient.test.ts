// Triage pin (xc-journeys::XC-AUTH-1): POST /v1/auth/refresh must answer a
// RETRYABLE status when GoTrue rate-limits us (429) or cannot be reached
// (fetch TypeError). The mobile client (apps/mobile/src/account/
// sessionLifecycle.ts) classifies by HTTP status alone: 401/403 ⇒ the refresh
// token is dead ⇒ implicit sign-out; anything else ⇒ SessionRefreshError
// retryable=true. `apps/mobile/__tests__/xc/triage/sessionRefreshTransient.test.ts`
// feeds this exact response shape through that classifier.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { loadHarness, SUPABASE_URL } from "./routesHarness.ts";

/** What the app reads off the edge answer: status, Retry-After, JSON body. */
export const EDGE_REFRESH_UNAVAILABLE_MESSAGE =
  "Session refresh is temporarily unavailable. Please try again.";

async function refreshWith(
  gotrue: (request: Request) => Promise<Response>,
  ip: string,
): Promise<Response> {
  const harness = await loadHarness();
  const harnessFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
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

async function assertRetryableUnavailable(response: Response, label: string) {
  const body = (await response.json()) as {
    error?: { message?: unknown; code?: unknown };
  };
  const status: number = response.status;
  const retryAfter = response.headers.get("Retry-After");
  console.log(
    `[triage XC-AUTH-1] ${label} -> edge ${status} Retry-After=${retryAfter} body=${
      JSON.stringify(body)
    }`,
  );
  assert(
    status !== 401 && status !== 403,
    `${label}: ${status} signs the app out`,
  );
  assert(
    status === 429 || status === 503,
    `${label}: expected 429 or 503, got ${status}`,
  );
  assert(retryAfter !== null, `${label}: Retry-After header missing`);
  assertMatch(
    retryAfter,
    /^[1-9]\d*$/,
    `${label}: Retry-After must be positive integer seconds`,
  );
  assertEquals(body.error?.message, EDGE_REFRESH_UNAVAILABLE_MESSAGE);
}

Deno.test(
  "XC-AUTH-1: GoTrue 429 on refresh is answered 503 + Retry-After (retryable), never 401/403",
  async () => {
    const response = await refreshWith(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ code: 429, msg: "over_request_rate_limit" }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      "10.98.0.1",
    );
    await assertRetryableUnavailable(response, "GoTrue 429");
    assertEquals(response.status, 503);
  },
);

Deno.test(
  "XC-AUTH-1: GoTrue 429 with Retry-After propagates the upstream hint",
  async () => {
    const response = await refreshWith(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ code: 429, msg: "over_request_rate_limit" }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "17" },
          }),
        ),
      "10.98.0.2",
    );
    await assertRetryableUnavailable(response, "GoTrue 429 + Retry-After 17");
    assertEquals(response.headers.get("Retry-After"), "17");
  },
);

Deno.test(
  "XC-AUTH-1: GoTrue unreachable (fetch rejects with TypeError) is answered 503 serviceUnavailable, not 401",
  async () => {
    Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "1500");
    try {
      let calls = 0;
      const response = await refreshWith(() => {
        calls += 1;
        return Promise.reject(new TypeError("fetch failed"));
      }, "10.98.0.3");
      await assertRetryableUnavailable(response, "GoTrue TypeError");
      assertEquals(response.status, 503);
      assert(calls >= 1);
    } finally {
      Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
    }
  },
);

Deno.test(
  "XC-AUTH-1 control: GoTrue 400 invalid_grant / 401 / 403 are the ONLY answers mapped to edge 401",
  async () => {
    const refusals: Array<[number, Record<string, unknown>]> = [
      [400, { error: "invalid_grant", error_description: "Invalid Refresh Token" }],
      [401, { code: 401, msg: "invalid JWT" }],
      [403, { code: 403, msg: "session not found" }],
    ];
    for (const [k, [status, body]] of refusals.entries()) {
      const response = await refreshWith(
        () =>
          Promise.resolve(
            new Response(JSON.stringify(body), {
              status,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        `10.98.1.${k}`,
      );
      await response.text();
      assertEquals(response.status, 401, `GoTrue ${status} must be edge 401`);
    }
  },
);
