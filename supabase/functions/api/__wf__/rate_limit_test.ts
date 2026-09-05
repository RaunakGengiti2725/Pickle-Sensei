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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { peekRateLimit } from "../rateLimit.ts";
import {
  fakeGoogleIdToken,
  loadHarness,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

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

const onIdTokenEndpoint =
  (respond: () => Promise<Response> | Response): Upstream =>
  (request) =>
    request.url.startsWith(`${SUPABASE_URL}/auth/v1/token`) &&
    request.url.includes("grant_type=id_token")
      ? respond()
      : null;

/** Keep the connection-fault retry loop short so a thrown fetch is answered
 * in milliseconds instead of riding out the full backoff schedule. */
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

async function postBootstrap(
  handler: (request: Request) => Promise<Response>,
  ip: string,
): Promise<{ status: number; retryAfter: string | null; body: string }> {
  const response = await handler(
    userRequest("POST", "/v1/account/bootstrap", {
      ip,
      token: fakeGoogleIdToken(crypto.randomUUID()),
      body: {},
    }),
  );
  return {
    status: response.status,
    retryAfter: response.headers.get("Retry-After"),
    body: await response.text(),
  };
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

Deno.test(
  "authfail: bootstrap under a GoTrue 429 / 5xx / network fault / malformed answer is 429-or-503 and charges nothing; a refused ID token (400/401/403) is 401 and charges one each",
  async () => {
    const h = await loadHarness();
    const ip = "10.7.0.34";
    const upstreamDetail = "gotrue-detail-must-not-leak";

    const limited = await withAuthUpstream(
      onIdTokenEndpoint(
        () =>
          new Response(
            JSON.stringify({
              code: 429,
              error_code: "over_request_rate_limit",
              msg: upstreamDetail,
            }),
            { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "7" } },
          ),
      ),
      () => postBootstrap(h.handler, ip),
    );
    assertEquals(limited.status, 429, "an upstream 429 is relayed as a retryable 429");
    assertEquals(limited.retryAfter, "7", "the upstream Retry-After is relayed");
    const limitedBody = JSON.parse(limited.body) as { error: { code?: string; message?: string } };
    assertEquals(limitedBody.error.code, "rate_limited");
    assertEquals(typeof limitedBody.error.message, "string");
    assertEquals(limited.body.includes(upstreamDetail), false, `leaked: ${limited.body}`);

    const outages: Array<() => Promise<Response> | Response> = [
      () => jsonResponse(503, { code: 503, msg: upstreamDetail }),
      () => new Response("<html>bad gateway</html>", { status: 502 }),
      () => Promise.reject(new TypeError(upstreamDetail)),
      () => jsonResponse(200, { ok: true }),
    ];
    for (const [index, respond] of outages.entries()) {
      const outage = await withShortUpstreamDeadline(() =>
        withAuthUpstream(onIdTokenEndpoint(respond), () => postBootstrap(h.handler, ip)),
      );
      assertEquals(outage.status, 503, `outage ${index} must be retryable: ${outage.body}`);
      assertStringIncludes(outage.body, "is temporarily unavailable. Please try again.");
      assertEquals(outage.body.includes(upstreamDetail), false, `leaked: ${outage.body}`);
    }
    assertEquals(await chargedFailures(ip), 0, "transient bootstrap failures must not be charged");

    const refusals: Array<() => Response> = [
      () => jsonResponse(400, { code: 400, error_code: "bad_id_token", msg: "Bad ID token" }),
      () => jsonResponse(401, { code: 401, msg: "invalid JWT" }),
      () => jsonResponse(403, { code: 403, error_code: "user_banned", msg: "User is banned" }),
    ];
    for (const [index, respond] of refusals.entries()) {
      const refused = await withAuthUpstream(onIdTokenEndpoint(respond), () =>
        postBootstrap(h.handler, ip),
      );
      assertEquals(
        refused.status,
        401,
        `refusal ${index} is a credential verdict: ${refused.body}`,
      );
      assertEquals(
        await chargedFailures(ip),
        index + 1,
        "a refused ID token is a real auth failure",
      );
    }
  },
);

/** GoTrue's id_token grant also refuses the ACCOUNT behind a valid token
 * (422 signup_disabled / email_exists / identity_already_exists, …). Nothing
 * a retry changes, and nothing wrong with the token either: a final 403 the
 * app shows (bootstrap.ts: 401/403 → account.rejected, not retried) that
 * charges no auth failure. */
const accountVerdicts: Array<[string, () => Response]> = [
  [
    "422 signup_disabled",
    () =>
      jsonResponse(422, {
        code: 422,
        error_code: "signup_disabled",
        msg: "Signups not allowed for this instance",
      }),
  ],
  [
    "422 email_exists",
    () =>
      jsonResponse(422, {
        code: 422,
        error_code: "email_exists",
        msg: "Email address already registered by another user",
      }),
  ],
  ["404", () => jsonResponse(404, { code: 404, msg: "gotrue-account-detail-must-not-leak" })],
  ["410", () => new Response("", { status: 410 })],
];

Deno.test(
  "authfail: bootstrap under a GoTrue account verdict (422 / 404 / 410) is a final 403 — never 401 (charged) and never 503 (retried)",
  async () => {
    const h = await loadHarness();
    const ip = "10.7.0.35";
    for (const [label, respond] of accountVerdicts) {
      const verdict = await withAuthUpstream(onIdTokenEndpoint(respond), () =>
        postBootstrap(h.handler, ip),
      );
      assertEquals(verdict.status, 403, `GoTrue ${label}: ${verdict.body}`);
      const body = JSON.parse(verdict.body) as { error: { message?: unknown } };
      assertEquals(typeof body.error.message, "string", `generic body: ${verdict.body}`);
      assertEquals(verdict.body.includes("must-not-leak"), false, `leaked: ${verdict.body}`);
      assertEquals(verdict.body.includes("temporarily unavailable"), false, verdict.body);
    }
    assertEquals(await chargedFailures(ip), 0, "an account verdict is not a bad credential");
  },
);

Deno.test(
  "authfail: a refresh answered 409 by GoTrue (concurrent rotation of the same token) is 503 and charges nothing — only 400/401/403 refuse a refresh token",
  async () => {
    const h = await loadHarness();
    const ip = "10.7.0.36";
    const conflicted = await withAuthUpstream(
      onRefreshEndpoint(() =>
        jsonResponse(409, {
          code: 409,
          error_code: "conflict",
          msg: "Too many concurrent token refresh requests on the same session or refresh token",
        }),
      ),
      () => postRefresh(h.handler, ip),
    );
    assertEquals(conflicted.status, 503, "a 409 clears on retry; it is not a refusal");
    assertEquals(await chargedFailures(ip), 0);
  },
);

/** GET /v1/me bearing a Google ID token (transitional, pre-session app builds):
 * authenticate()'s provider branch runs the same id_token exchange as
 * bootstrap and must follow the same verdicts. Every bearer is distinct so
 * the auth cache never answers. */
async function getMeWithProviderToken(
  handler: (request: Request) => Promise<Response>,
  ip: string,
): Promise<{ status: number; retryAfter: string | null; body: string }> {
  const response = await handler(
    userRequest("GET", "/v1/me", { ip, token: fakeGoogleIdToken(crypto.randomUUID()) }),
  );
  return {
    status: response.status,
    retryAfter: response.headers.get("Retry-After"),
    body: await response.text(),
  };
}

Deno.test(
  "authfail: the transitional provider-token bearer on GET /v1/me follows the bootstrap verdicts — 429 → 429 + Retry-After, outage → 503, 422 → 403, all uncharged; 400/401/403 → 401 charged",
  async () => {
    const h = await loadHarness();
    const ip = "10.7.0.37";
    const upstreamDetail = "gotrue-detail-must-not-leak";

    const limited = await withAuthUpstream(
      onIdTokenEndpoint(
        () =>
          new Response(JSON.stringify({ code: 429, msg: upstreamDetail }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "5" },
          }),
      ),
      () => getMeWithProviderToken(h.handler, ip),
    );
    assertEquals(limited.status, 429, limited.body);
    assertEquals(limited.retryAfter, "5");
    assertEquals(limited.body.includes(upstreamDetail), false, `leaked: ${limited.body}`);

    const outages: Array<() => Promise<Response> | Response> = [
      () => jsonResponse(503, { code: 503, msg: upstreamDetail }),
      () => Promise.reject(new TypeError(upstreamDetail)),
      () => jsonResponse(200, { ok: true }),
    ];
    for (const [index, respond] of outages.entries()) {
      const outage = await withShortUpstreamDeadline(() =>
        withAuthUpstream(onIdTokenEndpoint(respond), () => getMeWithProviderToken(h.handler, ip)),
      );
      assertEquals(outage.status, 503, `outage ${index} must be retryable: ${outage.body}`);
      assertStringIncludes(outage.body, "is temporarily unavailable. Please try again.");
      assertEquals(outage.body.includes(upstreamDetail), false, `leaked: ${outage.body}`);
    }

    const verdict = await withAuthUpstream(onIdTokenEndpoint(accountVerdicts[0][1]), () =>
      getMeWithProviderToken(h.handler, ip),
    );
    assertEquals(verdict.status, 403, verdict.body);
    assertEquals(await chargedFailures(ip), 0, "nothing above was a bad credential");

    const refused = await withAuthUpstream(
      onIdTokenEndpoint(() => jsonResponse(400, { code: 400, error_code: "bad_id_token" })),
      () => getMeWithProviderToken(h.handler, ip),
    );
    assertEquals(refused.status, 401, refused.body);
    assertEquals(await chargedFailures(ip), 1, "a refused ID token is a real auth failure");
  },
);
