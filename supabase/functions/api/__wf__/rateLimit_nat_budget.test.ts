// Auth-failure budgets behind a shared egress (W11-01), through the REAL handler.
//
// Many handsets share one public IP (club Wi-Fi, carrier-grade NAT). The
// auth-failure budget (AUTH_FAILURE_LIMIT = 30 / 300 s) must therefore be
// sharded by the credential a request presents, not charged to the egress
// alone: one client replaying a dead bearer is throttled on its own shard,
// while the egress-wide budget counts DISTINCT failing credentials — the
// signature of token stuffing — so rotating bad bearers still trips it.
// A liveness 401 (a session fenced at this edge after logout, or reported
// gone by Supabase Auth with 403) is the holder learning the truth, never
// an attack: it is bounded on its own shard and never charged to the egress.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json rateLimit_nat_budget.test.ts

import { assert, assertEquals } from "@std/assert";
import { peekRateLimit } from "../rateLimit.ts";
import {
  fakeSupabaseAccessToken,
  loadHarness,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

/** Mirrors AUTH_FAILURE_LIMIT in index.ts. */
const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };

const profile = () => ({
  id: TEST_USER_ID,
  email: "user@example.com",
  provider: "google",
  onboarding_state: "complete",
});

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A Supabase-shaped access token (iss ends in /auth/v1) that Auth will
 * judge; `salt` keeps bearers distinct so the auth cache never answers. */
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

const badJwt = () =>
  jsonResponse(401, { code: 401, msg: "invalid JWT: unable to parse or verify signature" });

const sessionGone = () =>
  jsonResponse(403, {
    code: 403,
    error_code: "session_not_found",
    msg: "Session from session_id claim in JWT does not exist",
  });

const refreshTokenRefused = () =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Invalid Refresh Token: Refresh Token Not Found",
  });

type Upstream = (request: Request) => Promise<Response> | Response | null;

/** Injects Auth verdicts for chosen bearers; everything else reaches the
 * harness's fake Supabase (which verifies any well-formed session bearer). */
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

const bearerOf = (request: Request): string =>
  (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");

/** Auth's verdict on `/auth/v1/user` per bearer, counting each consultation. */
function userVerdicts(verdicts: Record<string, () => Response>) {
  const consulted = new Map<string, number>();
  const upstream: Upstream = (request) => {
    if (!request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) return null;
    const bearer = bearerOf(request);
    const verdict = verdicts[bearer];
    if (!verdict) return null;
    consulted.set(bearer, (consulted.get(bearer) ?? 0) + 1);
    return verdict();
  };
  return { upstream, consulted: (bearer: string) => consulted.get(bearer) ?? 0 };
}

const onRefreshEndpoint =
  (respond: () => Response): Upstream =>
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
  const response = await handler(userRequest("GET", "/v1/me", { token: bearer, ip }));
  await response.body?.cancel();
  return response;
}

async function postLogout(
  handler: (request: Request) => Promise<Response>,
  ip: string,
  bearer: string,
): Promise<Response> {
  const response = await handler(userRequest("POST", "/v1/auth/logout", { token: bearer, ip }));
  await response.body?.cancel();
  return response;
}

async function postRefresh(
  handler: (request: Request) => Promise<Response>,
  ip: string,
  refreshToken: string,
): Promise<Response> {
  const response = await handler(
    new Request("http://edge.test/v1/auth/refresh", {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    }),
  );
  await response.body?.cancel();
  return response;
}

/** Failures charged to the egress-wide budget (what locks a whole venue). */
const egressCharged = async (ip: string): Promise<number> => {
  const window = await peekRateLimit(
    "authfail",
    ip,
    AUTH_FAILURE_LIMIT.limit,
    AUTH_FAILURE_LIMIT.windowSeconds,
  );
  return window.limit - window.remaining;
};

function assertBoundedRetryAfter(response: Response): void {
  const retryAfter = Number(response.headers.get("Retry-After"));
  assert(
    Number.isInteger(retryAfter) &&
      retryAfter >= 1 &&
      retryAfter <= AUTH_FAILURE_LIMIT.windowSeconds,
    `429 must carry a bucket-bounded Retry-After, got ${retryAfter}`,
  );
}

Deno.test(
  "nat: one handset replaying a refused bearer is throttled on its own shard; peers behind the same egress stay signed in",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = "10.7.1.41";
    const stale = supabaseBearer("nat-stale-handset");
    const peer = fakeSupabaseAccessToken(TEST_USER_ID);
    const auth = userVerdicts({ [stale]: badJwt });

    await withAuthUpstream(auth.upstream, async () => {
      const statuses: number[] = [];
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit + 1; i += 1) {
        const response = await getMe(h.handler, ip, stale);
        statuses.push(response.status);
        if (response.status === 429) assertBoundedRetryAfter(response);
      }
      assertEquals(
        statuses.slice(0, AUTH_FAILURE_LIMIT.limit),
        new Array(AUTH_FAILURE_LIMIT.limit).fill(401),
        "every replay up to the limit is a definitive 401",
      );
      assertEquals(
        statuses[AUTH_FAILURE_LIMIT.limit],
        429,
        "the replaying handset alone is locked out once its shard is spent",
      );
      assertEquals(
        auth.consulted(stale),
        AUTH_FAILURE_LIMIT.limit,
        "Auth is never consulted for a bearer whose shard is spent",
      );

      const peerResponse = await getMe(h.handler, ip, peer);
      assertEquals(
        peerResponse.status,
        200,
        "a signed-in peer behind the same egress must not be locked out",
      );
    });

    assertEquals(
      await egressCharged(ip),
      1,
      "one failing credential charges the egress-wide budget exactly once",
    );
  },
);

Deno.test(
  "nat: rotating refused bearers from one egress still trip the egress-wide budget (stuffing protection kept)",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = "10.7.1.42";
    const rotated = Array.from({ length: AUTH_FAILURE_LIMIT.limit + 1 }, (_, i) =>
      supabaseBearer(`stuffed-${i}`),
    );
    const auth = userVerdicts(Object.fromEntries(rotated.map((bearer) => [bearer, badJwt])));

    await withAuthUpstream(auth.upstream, async () => {
      const statuses: number[] = [];
      for (const bearer of rotated) {
        const response = await getMe(h.handler, ip, bearer);
        statuses.push(response.status);
      }
      assertEquals(
        statuses.slice(0, AUTH_FAILURE_LIMIT.limit),
        new Array(AUTH_FAILURE_LIMIT.limit).fill(401),
      );
      assertEquals(statuses[AUTH_FAILURE_LIMIT.limit], 429, "the 31st distinct bearer is refused");
      assertEquals(
        auth.consulted(rotated[AUTH_FAILURE_LIMIT.limit]),
        0,
        "a tripped egress never reaches Auth",
      );
      const peerResponse = await getMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID));
      assertEquals(
        peerResponse.status,
        429,
        "30 distinct failing credentials is a stuffing egress",
      );
    });

    assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit);
  },
);

Deno.test(
  "nat: liveness 401s (session fenced at this edge, or gone upstream) are bounded per shard and never charged to the egress",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = "10.7.1.43";
    const signedOut = fakeSupabaseAccessToken(TEST_USER_ID);
    const gone = supabaseBearer("session-gone-upstream");
    const forged = supabaseBearer("forged-credential");
    const peer = fakeSupabaseAccessToken(TEST_USER_ID);
    const auth = userVerdicts({ [gone]: sessionGone, [forged]: badJwt });

    await withAuthUpstream(auth.upstream, async () => {
      assertEquals((await getMe(h.handler, ip, signedOut)).status, 200);
      assertEquals((await postLogout(h.handler, ip, signedOut)).status, 204);
      const userCallsBefore = h.callsTo("/auth/v1/user").length;

      // A handset still holding the bearer it just signed out (a racing
      // request, a stale build polling) keeps being told the truth …
      const statuses: number[] = [];
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit + 1; i += 1) {
        const response = await getMe(h.handler, ip, signedOut);
        statuses.push(response.status);
        if (response.status === 429) assertBoundedRetryAfter(response);
      }
      assertEquals(
        statuses.slice(0, AUTH_FAILURE_LIMIT.limit),
        new Array(AUTH_FAILURE_LIMIT.limit).fill(401),
        "a fenced session is refused with 401 from the edge fence",
      );
      // … is bounded on its own shard like any other repeated refusal …
      assertEquals(statuses[AUTH_FAILURE_LIMIT.limit], 429);
      assertEquals(
        h.callsTo("/auth/v1/user").length,
        userCallsBefore,
        "the edge fence answers without consulting Auth",
      );
      // … and never counts against the venue.
      assertEquals(await egressCharged(ip), 0, "a fenced session is not an attack on the egress");

      // Supabase Auth reporting the session gone (403) is the same truth.
      for (let i = 0; i < 3; i += 1) {
        assertEquals((await getMe(h.handler, ip, gone)).status, 401);
      }
      assertEquals(auth.consulted(gone), 3);
      assertEquals(await egressCharged(ip), 0, "an upstream liveness refusal is not an attack");

      const peerResponse = await getMe(h.handler, ip, peer);
      assertEquals(peerResponse.status, 200, "peers behind the egress are untouched");

      // A credential Auth refuses outright IS charged — once per credential.
      assertEquals((await getMe(h.handler, ip, forged)).status, 401);
      assertEquals((await getMe(h.handler, ip, forged)).status, 401);
      assertEquals(await egressCharged(ip), 1, "a refused credential charges the egress once");
    });
  },
);

Deno.test(
  "nat: one device replaying a refused refresh token charges the egress once; peers keep refreshing and using the API",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = "10.7.1.44";
    const peer = fakeSupabaseAccessToken(TEST_USER_ID);

    await withAuthUpstream(onRefreshEndpoint(refreshTokenRefused), async () => {
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        const response = await postRefresh(h.handler, ip, "rt-revoked-on-one-device");
        assertEquals(response.status, 401, `replay ${i} is a definitive refusal`);
      }
    });
    assertEquals(
      await egressCharged(ip),
      1,
      "one refused refresh token charges the egress-wide budget exactly once",
    );

    const peerResponse = await getMe(h.handler, ip, peer);
    assertEquals(peerResponse.status, 200, "a signed-in peer behind the same egress is untouched");
  },
);
