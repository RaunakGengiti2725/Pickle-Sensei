// Auth-failure budget accounting through the REAL handler (XC-RS-02).
//
// The per-IP `authfail` budget (AUTH_FAILURE_LIMIT = 30 / 300 s) exists to
// starve token stuffing. It must be charged for every DEFINITIVE credential
// refusal (Supabase Auth 400/401/403: bad, expired, revoked token) and for
// nothing else: an Auth outage (5xx / 429 / network / malformed answer) says
// nothing about the credential, so charging it locks every player behind a
// shared club Wi-Fi or carrier NAT out for five minutes after Auth recovers.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json rate_limit_test.ts

import { assert, assertEquals } from "@std/assert";
import { peekRateLimit } from "../rateLimit.ts";
import { loadHarness, SUPABASE_URL, TEST_USER_ID } from "./routesHarness.ts";

/** Mirrors AUTH_FAILURE_LIMIT in index.ts. */
const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A Supabase-shaped access token (iss ends in /auth/v1) that Auth will
 * judge; `salt` keeps every bearer distinct so the auth cache never answers. */
function supabaseBearer(salt: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: TEST_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      salt,
    }),
  );
  return `${header}.${payload}.sig`;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type Upstream = (request: Request) => Promise<Response> | Response | null;

async function withAuthUpstream<T>(upstream: Upstream, run: () => Promise<T>): Promise<T> {
  const base = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const injected = await upstream(request.clone());
    if (injected) return injected;
    return base(request);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = base;
  }
}

const onUserEndpoint =
  (respond: () => Promise<Response> | Response): Upstream =>
  (request) =>
    request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`) ? respond() : null;

const onRefreshEndpoint =
  (respond: () => Promise<Response> | Response): Upstream =>
  (request) =>
    request.url.startsWith(`${SUPABASE_URL}/auth/v1/token`) &&
    request.url.includes("grant_type=refresh_token")
      ? respond()
      : null;

async function getMe(
  handler: (request: Request) => Promise<Response>,
  ip: string,
  bearer: string,
): Promise<Response> {
  const response = await handler(
    new Request("http://edge.test/v1/me", {
      headers: { "x-forwarded-for": ip, Authorization: `Bearer ${bearer}` },
    }),
  );
  await response.body?.cancel();
  return response;
}

async function postRefresh(
  handler: (request: Request) => Promise<Response>,
  ip: string,
): Promise<Response> {
  const response = await handler(
    new Request("http://edge.test/v1/auth/refresh", {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "rt-under-test" }),
    }),
  );
  await response.body?.cancel();
  return response;
}

const chargedFailures = async (ip: string): Promise<number> => {
  const window = await peekRateLimit(
    "authfail",
    ip,
    AUTH_FAILURE_LIMIT.limit,
    AUTH_FAILURE_LIMIT.windowSeconds,
  );
  return window.limit - window.remaining;
};

Deno.test(
  "authfail: 31 genuinely invalid bearers from one IP → 30 × 401 then 429 on the 31st (lockout preserved)",
  async () => {
    const h = await loadHarness();
    const ip = "10.7.0.31";
    const statuses: number[] = [];
    await withAuthUpstream(
      onUserEndpoint(() =>
        jsonResponse(401, {
          code: 401,
          msg: "invalid JWT: unable to parse or verify signature",
        }),
      ),
      async () => {
        for (let i = 0; i < 31; i += 1) {
          const response = await getMe(h.handler, ip, supabaseBearer(`stuffed-${i}`));
          statuses.push(response.status);
          if (i === 30) {
            const retryAfter = Number(response.headers.get("Retry-After"));
            assert(
              Number.isInteger(retryAfter) &&
                retryAfter >= 1 &&
                retryAfter <= AUTH_FAILURE_LIMIT.windowSeconds,
              `429 must carry a bucket-bounded Retry-After, got ${retryAfter}`,
            );
          }
        }
      },
    );
    assertEquals(statuses.slice(0, 30), new Array(30).fill(401));
    assertEquals(statuses[30], 429, "the 31st invalid bearer must be locked out");
    assertEquals(await chargedFailures(ip), 30);
  },
);

Deno.test(
  "authfail: an Auth outage on an authenticated route (5xx / 429 / network / malformed) charges nothing",
  async () => {
    const h = await loadHarness();
    const ip = "10.7.0.32";
    const outages: Array<() => Promise<Response> | Response> = [
      () => jsonResponse(503, { message: "upstream unavailable" }),
      () => new Response("<html>bad gateway</html>", { status: 502 }),
      () => jsonResponse(429, { message: "rate limited" }),
      () => Promise.reject(new TypeError("connection reset")),
      () => new Response("<html>gateway</html>", { status: 200 }),
      () => jsonResponse(200, { ok: true }),
    ];
    for (const [index, respond] of outages.entries()) {
      const response = await withAuthUpstream(onUserEndpoint(respond), () =>
        getMe(h.handler, ip, supabaseBearer(`outage-${index}`)),
      );
      assertEquals(response.status, 503, `outage ${index} must be retryable`);
    }
    assertEquals(await chargedFailures(ip), 0);
  },
);

Deno.test(
  "authfail: a rate-limited or unreachable refresh charges nothing; a refused refresh token charges one",
  async () => {
    const h = await loadHarness();
    const ip = "10.7.0.33";

    const limited = await withAuthUpstream(
      onRefreshEndpoint(() => jsonResponse(429, { code: 429, msg: "over_request_rate_limit" })),
      () => postRefresh(h.handler, ip),
    );
    assertEquals(limited.status, 503);
    const down = await withAuthUpstream(
      onRefreshEndpoint(() => Promise.reject(new TypeError("connection refused"))),
      () => postRefresh(h.handler, ip),
    );
    assertEquals(down.status, 503);
    const malformed = await withAuthUpstream(
      onRefreshEndpoint(() => jsonResponse(200, { ok: true })),
      () => postRefresh(h.handler, ip),
    );
    assertEquals(malformed.status, 503);
    assertEquals(await chargedFailures(ip), 0, "transient refresh failures must not be charged");

    const refused = await withAuthUpstream(
      onRefreshEndpoint(() =>
        jsonResponse(400, {
          error: "invalid_grant",
          error_description: "Invalid Refresh Token: Refresh Token Not Found",
        }),
      ),
      () => postRefresh(h.handler, ip),
    );
    assertEquals(refused.status, 401);
    assertEquals(await chargedFailures(ip), 1, "a refused refresh token is a real auth failure");
  },
);
