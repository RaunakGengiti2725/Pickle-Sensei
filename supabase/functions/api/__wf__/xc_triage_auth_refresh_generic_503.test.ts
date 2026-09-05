// Triage pin for XC-ADJ-AUTH-1 (edge /v1/auth/refresh): every transient
// upstream outcome — GoTrue 429, a socket fault, a 2xx without a usable
// session — is a 503 whose body is the GENERIC "temporarily unavailable"
// message (REVIEW.md: 5xx bodies stay generic) carrying a Retry-After, and
// none of the upstream detail (error codes, messages, HTML) reaches the
// client. Only a GoTrue refusal (400 invalid_grant / 401 / 403) is 401, and
// that body is generic too.
import { assert, assertEquals } from "@std/assert";
import { loadHarness, SUPABASE_URL } from "./routesHarness.ts";

const GENERIC_REFRESH_503 = {
  error: { message: "Session refresh is temporarily unavailable. Please try again." },
};
const GENERIC_REFRESH_401 = {
  error: { message: "The session could not be refreshed. Sign in again." },
};

async function refreshWith(
  gotrue: () => Promise<Response>,
  ip: string,
): Promise<{ status: number; retryAfter: string | null; text: string }> {
  const harness = await loadHarness();
  const harnessFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
      return gotrue();
    }
    return harnessFetch(input, init);
  }) as typeof fetch;
  try {
    const response = await harness.handler(
      new Request("http://edge.test/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ refreshToken: "still-valid-refresh-token" }),
      }),
    );
    return {
      status: response.status,
      retryAfter: response.headers.get("Retry-After"),
      text: await response.text(),
    };
  } finally {
    globalThis.fetch = harnessFetch;
  }
}

const LEAK_MARKERS = [
  "over_request_rate_limit",
  "Request rate limit reached",
  "connection refused",
  "gateway returned html",
  "<html",
  "without a usable body",
  "Supabase Auth",
  "unavailable:",
];

const assertNoLeak = (text: string, label: string) => {
  for (const marker of LEAK_MARKERS) {
    assert(!text.includes(marker), `${label}: body leaks upstream detail "${marker}": ${text}`);
  }
};

Deno.test(
  "XC-ADJ-AUTH-1: transient upstream outcomes on /v1/auth/refresh are a generic 503 with Retry-After (no upstream detail)",
  async () => {
    const cases: Array<{ name: string; gotrue: () => Promise<Response>; retryAfter: string }> = [
      {
        name: "gotrue_429_with_retry_after",
        gotrue: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                code: 429,
                error_code: "over_request_rate_limit",
                msg: "Request rate limit reached",
              }),
              {
                status: 429,
                headers: { "Content-Type": "application/json", "Retry-After": "30" },
              },
            ),
          ),
        retryAfter: "30",
      },
      {
        name: "gotrue_429_without_retry_after",
        gotrue: () =>
          Promise.resolve(
            new Response(JSON.stringify({ code: 429, error_code: "over_request_rate_limit" }), {
              status: 429,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        retryAfter: "2",
      },
      {
        name: "gotrue_network_failure",
        gotrue: () => Promise.reject(new TypeError("error sending request: connection refused")),
        retryAfter: "2",
      },
      {
        name: "malformed_200_non_json",
        gotrue: () =>
          Promise.resolve(
            new Response("<html>gateway returned html</html>", {
              status: 200,
              headers: { "Content-Type": "text/html" },
            }),
          ),
        retryAfter: "2",
      },
      {
        name: "malformed_200_empty_object",
        gotrue: () =>
          Promise.resolve(
            new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
          ),
        retryAfter: "2",
      },
      {
        name: "malformed_200_missing_refresh_token",
        gotrue: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                access_token: "rotated-access",
                expires_in: 3600,
                user: { id: "00000000-0000-4000-8000-000000000097" },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          ),
        retryAfter: "2",
      },
    ];
    for (const [k, c] of cases.entries()) {
      const observed = await refreshWith(c.gotrue, `10.98.0.${k + 1}`);
      assertEquals(observed.status, 503, `${c.name}: expected 503, got ${observed.status}`);
      assertEquals(observed.retryAfter, c.retryAfter, `${c.name}: Retry-After`);
      assertEquals(JSON.parse(observed.text), GENERIC_REFRESH_503, `${c.name}: body`);
      assertNoLeak(observed.text, c.name);
    }
  },
);

Deno.test(
  "XC-ADJ-AUTH-1 control: a GoTrue refusal (400 invalid_grant / 401 / 403) is 401 with a generic body",
  async () => {
    const cases: Array<{ name: string; status: number; body: Record<string, unknown> }> = [
      {
        name: "400_invalid_grant",
        status: 400,
        body: { error: "invalid_grant", error_description: "Invalid Refresh Token" },
      },
      {
        name: "400_refresh_token_not_found",
        status: 400,
        body: {
          code: 400,
          error_code: "refresh_token_not_found",
          msg: "Invalid Refresh Token: Refresh Token Not Found",
        },
      },
      { name: "401_bad_jwt", status: 401, body: { code: 401, error_code: "bad_jwt" } },
      { name: "403_user_banned", status: 403, body: { code: 403, error_code: "user_banned" } },
    ];
    for (const [k, c] of cases.entries()) {
      const observed = await refreshWith(
        () =>
          Promise.resolve(
            new Response(JSON.stringify(c.body), {
              status: c.status,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        `10.98.1.${k + 1}`,
      );
      assertEquals(observed.status, 401, `${c.name}: expected 401, got ${observed.status}`);
      assertEquals(JSON.parse(observed.text), GENERIC_REFRESH_401, `${c.name}: body`);
      assert(
        !observed.text.includes("invalid_grant") && !observed.text.includes("bad_jwt"),
        `${c.name}: body leaks GoTrue detail: ${observed.text}`,
      );
    }
  },
);
