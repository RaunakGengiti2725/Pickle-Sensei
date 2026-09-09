// W11-01 — auth-failure budgets behind a shared NAT egress.
//
// A venue (office, club, carrier NAT) is ONE client IP to the edge. The
// auth-failure budget (AUTH_FAILURE_LIMIT = 30 / 300 s) exists to bound
// credential stuffing, and on BASE it was a flat per-IP counter charged by
// EVERY 401: thirty junk bearers, thirty expired-token retries, thirty
// signed-out co-tenants or one handset's thirty guesses all locked every
// valid peer behind the egress out of reads, refresh and sign-in for five
// minutes. Contract pinned here:
//
//   * LOCAL refusals (no bearer, junk, expired, wrong issuer, capability on a
//     session route) never consulted Supabase Auth — nothing was guessed —
//     and charge nothing.
//   * A refusal Auth judged charges the SHARD of the refused credential
//     (ip + sha256(credential)); the 31st presentation of that same refused
//     credential in a window is 429 before Auth. A clean credential — a valid
//     peer — is never gated by someone else's shard.
//   * LIVENESS refusals (`session_not_found`, `refresh_token_already_used`,
//     …: a real credential that is merely dead) charge their shard only.
//   * CREDENTIAL refusals (`bad_jwt`, `bad_id_token`, `refresh_token_not_found`,
//     …: a guess) also raise the egress's stuffing signal once per distinct
//     credential. Once that signal reaches the budget the egress is under
//     stuffing: every previously refused credential is 429 on its next
//     presentation (replay tolerance 0), and a further guess Auth refuses is
//     answered 429 (throttled) rather than 401 — still never a clean one.
//   * A credential nothing has refused ALWAYS reaches Auth, however hard the
//     egress is being stuffed: the session bootstrap just minted, the token
//     refresh just rotated, a valid session whose auth-cache entry expired.
//     Auth judging a valid session costs the attacker nothing and is the only
//     way a venue stays online ("one NAT egress cannot lock out a venue").
//   * Nothing about the classification is visible to the client.
//
// The handler-level tests drive the real Edge entry point (routesHarness
// loads index.ts); the primitive tests drive rateLimit.ts in fresh isolates
// with the memory fallback and with a fake Upstash.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json rateLimit_nat_budget.test.ts

import { assert, assertEquals } from "@std/assert";
import { peekRateLimit } from "../rateLimit.ts";
import { configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";
import type { Harness, RecordedCall } from "./routesHarness.ts";
import {
  fakeGoogleIdToken,
  fakeSupabaseAccessToken,
  loadHarness,
  OTHER_USER_ID,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

/** Mirrors AUTH_FAILURE_LIMIT / IP_LIMIT in index.ts. */
const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
const IP_LIMIT = { limit: 1_200, windowSeconds: 60 };
const LIMIT = AUTH_FAILURE_LIMIT.limit;
/** Mirrors MEMORY_WINDOW_MAX in rateLimit.ts. */
const MEMORY_WINDOW_MAX = 20_000;

type Handler = (request: Request) => Promise<Response>;

const profile = (id = TEST_USER_ID) => ({
  id,
  email: "user@example.com",
  provider: "google",
  onboarding_state: "complete",
});

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const jwtOf = (payload: unknown): string =>
  `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.sig`;

/** A Supabase-shaped access token Auth will judge; `salt` keeps bearers distinct. */
const supabaseBearer = (salt: string, exp = Math.floor(Date.now() / 1000) + 3600): string =>
  jwtOf({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: TEST_USER_ID,
    aud: "authenticated",
    role: "authenticated",
    session_id: crypto.randomUUID(),
    exp,
    salt,
  });

/** A Google ID token an app build predating the session contract bears on
 * every call (the transitional branch of authenticate()). */
const googleIdToken = (sub: string, exp = Math.floor(Date.now() / 1000) + 3600): string =>
  jwtOf({ iss: "https://accounts.google.com", sub, exp, salt: crypto.randomUUID() });

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const credentialRefused = () =>
  jsonResponse(403, {
    code: 403,
    error_code: "bad_jwt",
    msg: "invalid JWT: unable to parse or verify signature, token signature is invalid",
  });

const sessionGone = () =>
  jsonResponse(403, {
    code: 403,
    error_code: "session_not_found",
    msg: "Session from session_id claim in JWT does not exist",
  });

/** The same liveness refusal in the older GoTrue error shape (`{code, msg}`
 * without `error_code`). */
const sessionGoneLegacyShape = () =>
  jsonResponse(401, { code: 401, msg: "Session from session_id claim in JWT does not exist" });

const refreshRefused = () =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Invalid Refresh Token: Refresh Token Not Found",
    error_code: "refresh_token_not_found",
  });

const refreshAlreadyUsed = () =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Invalid Refresh Token: Already Used",
    error_code: "refresh_token_already_used",
  });

const idTokenRefused = () =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Bad ID token",
    error_code: "bad_id_token",
  });

const bearerOfCall = (call: RecordedCall): string =>
  (call.headers.authorization ?? "").replace(/^Bearer /, "");
const isUserCall = (call: RecordedCall) => call.url.startsWith(`${SUPABASE_URL}/auth/v1/user`);
const isRefreshCall = (call: RecordedCall) =>
  call.url.startsWith(`${SUPABASE_URL}/auth/v1/token`) &&
  call.url.includes("grant_type=refresh_token");
const isIdTokenCall = (call: RecordedCall) =>
  call.url.startsWith(`${SUPABASE_URL}/auth/v1/token`) && call.url.includes("grant_type=id_token");
const bodyField = (call: RecordedCall, field: string): string => {
  const body = call.body;
  if (typeof body !== "object" || body === null) return "";
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
};

let ipCounter = 0;
/** Unique egress per test (own /16 so no other suite's windows collide). */
const freshIp = () => `10.61.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const spent = (window: { limit: number; remaining: number }) => window.limit - window.remaining;

/** Distinct refused credentials charged to the egress — the stuffing signal. */
const egressCharged = async (ip: string): Promise<number> =>
  spent(
    await peekRateLimit("authfail", ip, AUTH_FAILURE_LIMIT.limit, AUTH_FAILURE_LIMIT.windowSeconds),
  );

async function send(handler: Handler, request: Request): Promise<Response> {
  const response = await handler(request);
  await response.body?.cancel();
  return response;
}

const readMe = (handler: Handler, ip: string, bearer: string) =>
  send(handler, userRequest("GET", "/v1/me", { token: bearer, ip }));

const readMeWithAuthorization = (handler: Handler, ip: string, authorization?: string) =>
  send(
    handler,
    new Request("http://edge.test/functions/v1/api/v1/me", {
      method: "GET",
      headers: authorization
        ? { "x-forwarded-for": ip, Authorization: authorization }
        : { "x-forwarded-for": ip },
    }),
  );

const postRefresh = (handler: Handler, ip: string, refreshToken: string, bearer?: string) =>
  send(
    handler,
    new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
      method: "POST",
      headers: {
        "x-forwarded-for": ip,
        "content-type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ refreshToken }),
    }),
  );

const postBootstrap = (handler: Handler, ip: string, idToken: string) =>
  send(handler, userRequest("POST", "/v1/account/bootstrap", { token: idToken, ip, body: {} }));

/** A response and its parsed JSON body (what the app reads). */
async function sendJson(
  handler: Handler,
  request: Request,
): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const response = await handler(request);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return {
    status: response.status,
    headers: response.headers,
    body: typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {},
  };
}

/** `session.accessToken` of a bootstrap / refresh answer ("" when absent). */
const sessionAccessToken = (body: Record<string, unknown>): string => {
  const session = body.session;
  if (typeof session !== "object" || session === null) return "";
  const token = (session as Record<string, unknown>).accessToken;
  return typeof token === "string" ? token : "";
};

/** A freshly minted Supabase session shaped like GoTrue's `/token` answer,
 * whose access token is a Supabase-issued JWT the edge accepts as bearer
 * (the harness default mints an opaque `session-for-<sub>` string). */
const mintedSession = (sub: string) =>
  jsonResponse(200, {
    access_token: fakeSupabaseAccessToken(sub),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: `rt-${crypto.randomUUID()}`,
    user: {
      id: sub,
      aud: "authenticated",
      role: "authenticated",
      email: "user@example.com",
      app_metadata: { provider: "google", providers: ["google"] },
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  });

/** The established session of a peer behind `ip`: one bearer per egress, so
 * once verified it is served from the auth cache like a real handset's is. */
const peerSessions = new Map<string, string>();
const establishedSession = (ip: string) => {
  const bearer = peerSessions.get(ip) ?? fakeSupabaseAccessToken(TEST_USER_ID);
  peerSessions.set(ip, bearer);
  return bearer;
};

/** What healthy peers behind the egress see: an established session bearer
 * reading /v1/me, a live refresh token rotating and the ROTATED session
 * reading, and a NEW handset signing in and reading with the session the
 * edge just minted. The two minted sessions are real Supabase-shaped JWTs
 * (Auth answers `mintedSession`); everything else keeps the test's responder. */
async function peerStatuses(h: Harness, ip: string) {
  const read = await readMe(h.handler, ip, establishedSession(ip));
  const liveRefreshToken = `rt-healthy-peer-${crypto.randomUUID()}`;
  const newHandset = fakeGoogleIdToken(OTHER_USER_ID);
  const prior = h.respond;
  h.respond = (call) => {
    if (isRefreshCall(call) && bodyField(call, "refresh_token") === liveRefreshToken) {
      return mintedSession(TEST_USER_ID);
    }
    if (isIdTokenCall(call) && bodyField(call, "id_token") === newHandset) {
      return mintedSession(OTHER_USER_ID);
    }
    return prior(call);
  };
  try {
    const refresh = await sendJson(
      h.handler,
      new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
        method: "POST",
        headers: { "x-forwarded-for": ip, "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: liveRefreshToken }),
      }),
    );
    const rotated = sessionAccessToken(refresh.body);
    const rotatedRead = rotated ? (await readMe(h.handler, ip, rotated)).status : 0;
    const bootstrap = await sendJson(
      h.handler,
      userRequest("POST", "/v1/account/bootstrap", { token: newHandset, ip, body: {} }),
    );
    const minted = sessionAccessToken(bootstrap.body);
    const mintedRead = minted ? (await readMe(h.handler, ip, minted)).status : 0;
    return {
      read: read.status,
      refresh: refresh.status,
      rotatedRead,
      bootstrap: bootstrap.status,
      mintedRead,
    };
  } finally {
    h.respond = prior;
  }
}

const SERVED = { read: 200, refresh: 200, rotatedRead: 200, bootstrap: 200, mintedRead: 200 };

const assertPeersServed = async (h: Harness, ip: string, why: string) => {
  const peers = await peerStatuses(h, ip);
  assertEquals(peers, SERVED, `${why} (egress charged = ${await egressCharged(ip)})`);
};

const repeat = async (times: number, run: () => Promise<Response>): Promise<number[]> => {
  const statuses: number[] = [];
  for (let i = 0; i < times; i += 1) statuses.push((await run()).status);
  return statuses;
};

const allEqual = (statuses: number[], expected: number) =>
  statuses.every((status) => status === expected);

/** Pin the clock to the first minute of a FRESH auth-failure window so a test
 * may step across minute boundaries (the refresh route has its own 30/min
 * per-IP budget, which is not under test) without leaving the window. */
async function inFreshAuthWindow(run: (nextMinute: () => void) => Promise<void>) {
  const realNow = Date.now;
  const windowMs = AUTH_FAILURE_LIMIT.windowSeconds * 1_000;
  let clock = (Math.floor(realNow() / windowMs) + 1) * windowMs + 500;
  Date.now = () => clock;
  try {
    await run(() => {
      clock += 60_000;
    });
  } finally {
    Date.now = realNow;
  }
}

const assertBoundedRetryAfter = (response: Response) => {
  const retryAfter = Number(response.headers.get("Retry-After"));
  assert(
    Number.isInteger(retryAfter) &&
      retryAfter >= 1 &&
      retryAfter <= AUTH_FAILURE_LIMIT.windowSeconds,
    `429 must carry a bucket-bounded Retry-After, got ${retryAfter}`,
  );
};

const assertNoInternalHeaders = (response: Response) => {
  const leaked = [...response.headers.keys()].filter((name) => /^x-auth/i.test(name));
  assertEquals(leaked, [], `internal auth-refusal tags leaked: ${leaked.join(",")}`);
};

// ═════════════════════════════════════════════════════════════════════════════
// Local refusals — nothing reached Auth, nothing was guessed, nothing charged.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "NAT: 30 non-JWT junk bearers from a co-tenant charge nothing — a VALID transitional (Google ID token) handset, cached or new, is still served",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const oldBuild = googleIdToken(TEST_USER_ID);
    assertEquals(
      (await readMe(h.handler, ip, oldBuild)).status,
      200,
      "the old build is served before the noise (transitional branch is live)",
    );

    const junk = await repeat(LIMIT, () => readMe(h.handler, ip, `junk-${crypto.randomUUID()}`));
    assert(allEqual(junk, 401), `junk is refused locally: ${junk.join(",")}`);
    assertEquals(await egressCharged(ip), 0, "junk never touched the venue budget…");
    assertEquals(h.calls.filter(isUserCall).length, 0, "…and never reached Auth");

    assertEquals(
      (await readMe(h.handler, ip, oldBuild)).status,
      200,
      "…yet the SAME valid, already-verified transitional bearer must still be served",
    );
    assertEquals(
      (await readMe(h.handler, ip, googleIdToken(OTHER_USER_ID))).status,
      200,
      "a second old-build handset at the venue is served",
    );
    await assertPeersServed(h, ip, "session peers are served");
  },
);

Deno.test(
  "NAT: one old-build handset retrying its own EXPIRED ID token 30× charges nothing — another old-build handset with a VALID ID token is served",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const expired = googleIdToken(TEST_USER_ID, Math.floor(Date.now() / 1000) - 60);
    const retries = await repeat(LIMIT, () => readMe(h.handler, ip, expired));
    assert(allEqual(retries, 401), `expired ID token is refused locally: ${retries.join(",")}`);
    assertEquals(await egressCharged(ip), 0, "no venue budget was charged");
    assertEquals(h.calls.filter(isUserCall).length, 0, "nothing reached Auth");

    assertEquals(
      (await readMe(h.handler, ip, googleIdToken(OTHER_USER_ID))).status,
      200,
      "another old-build handset with a VALID ID token must be served (nothing was guessed)",
    );
    await assertPeersServed(h, ip, "session peers are served");
  },
);

Deno.test(
  "NAT: 30 requests without any bearer charge nothing — a new sign-in from the same address is served",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const missing = await repeat(LIMIT, () => readMeWithAuthorization(h.handler, ip));
    assert(allEqual(missing, 401), `a missing bearer is 401: ${missing.join(",")}`);
    assertEquals(await egressCharged(ip), 0);
    assertEquals(
      (await readMe(h.handler, ip, googleIdToken(OTHER_USER_ID))).status,
      200,
      "an uncached, valid transitional bearer is served",
    );
    await assertPeersServed(h, ip, "session peers are served");
  },
);

Deno.test(
  "NAT: malformed / boundary bearers are 401 not 5xx, charge nothing the venue can feel, and peers stay served",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const capability = `${"A".repeat(42)}Q`;
    const sessionIss = `${SUPABASE_URL}/auth/v1`;
    const oddBearers = [
      jwtOf({ iss: sessionIss, sub: TEST_USER_ID, exp: "NaN" }),
      jwtOf({ iss: sessionIss, sub: TEST_USER_ID, exp: -1 }),
      jwtOf({ iss: sessionIss, sub: TEST_USER_ID, exp: 1e300 }),
      jwtOf({ iss: sessionIss, sub: TEST_USER_ID, exp: Number.MAX_SAFE_INTEGER }),
      jwtOf({ iss: sessionIss, sub: TEST_USER_ID, exp: 0 }),
      jwtOf(["not", "an", "object"]),
      jwtOf(null),
      jwtOf({ iss: 12345, exp: Math.floor(Date.now() / 1000) + 60 }),
      capability,
      "",
      "   ",
      "a.b",
      "a.b.c.d",
      `${"x".repeat(8_192)}.${"y".repeat(8_192)}.${"z".repeat(8_192)}`,
    ];
    h.respond = (call) => (isUserCall(call) ? credentialRefused() : null);
    const responses: Response[] = [];
    for (const bearer of oddBearers) {
      responses.push(await readMeWithAuthorization(h.handler, ip, `Bearer ${bearer}`));
    }
    responses.push(await readMeWithAuthorization(h.handler, ip, "Bearer"));
    responses.push(await readMeWithAuthorization(h.handler, ip, "Basic dXNlcjpwdw=="));
    const statuses = responses.map((r) => r.status);
    assert(allEqual(statuses, 401), `every odd bearer is a plain 401: ${statuses.join(",")}`);
    for (const response of responses) assertNoInternalHeaders(response);
    const judged = h.calls.filter(isUserCall).length;
    assertEquals(
      await egressCharged(ip),
      judged,
      "only what Auth actually judged (and refused) is stuffing signal",
    );
    assert(judged < LIMIT, "the boundary set itself stays under the venue budget");
    h.respond = () => null;
    await assertPeersServed(h, ip, "peers are served after the boundary set");
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// Credential refusals — Auth judged a guess. The guessed credential's shard
// is charged; peers are never fenced.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "NAT: one handset presenting 30 DISTINCT forged session bearers never locks VALID peers (read, refresh, bootstrap) out of the egress",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const forged = Array.from({ length: LIMIT + 1 }, (_, i) => supabaseBearer(`forged-${i}`));
    const forgedSet = new Set(forged);
    h.respond = (call) =>
      isUserCall(call) && forgedSet.has(bearerOfCall(call)) ? credentialRefused() : null;

    await assertPeersServed(h, ip, "peers are served before the stuffing");
    const statuses: number[] = [];
    for (const bearer of forged.slice(0, LIMIT)) {
      statuses.push((await readMe(h.handler, ip, bearer)).status);
    }
    assert(allEqual(statuses, 401), `every guess is refused: ${statuses.join(",")}`);
    assertEquals(await egressCharged(ip), LIMIT, "each distinct guess raised the stuffing signal");

    await assertPeersServed(
      h,
      ip,
      "one handset's 30 guesses must not take the venue offline (one NAT egress cannot lock out a venue)",
    );

    // Under stuffing a refused credential replayed is 429 before Auth. A
    // never-seen bearer is indistinguishable from a valid peer's first
    // request, so it still reaches Auth — and once Auth refuses it as a guess
    // it is throttled (429), which keeps the flat lockout of rate_limit_test.ts
    // for guesses while a valid peer is served.
    const upstreamBefore = h.calls.filter(isUserCall).length;
    const replay = await readMe(h.handler, ip, forged[0]);
    assertEquals(replay.status, 429, "a refused credential replayed under stuffing is throttled");
    assertBoundedRetryAfter(replay);
    assertEquals(
      h.calls.filter(isUserCall).length,
      upstreamBefore,
      "the replay never reached Auth",
    );
    const novel = await readMe(h.handler, ip, forged[LIMIT]);
    assertEquals(novel.status, 429, "a further guess Auth refused under stuffing is throttled");
    assertBoundedRetryAfter(novel);
    assertNoInternalHeaders(novel);
    assertEquals(h.calls.filter(isUserCall).length, upstreamBefore + 1, "Auth judged it first");
    assertEquals(await egressCharged(ip), LIMIT, "the signal is saturated (clamped at the budget)");
    await assertPeersServed(h, ip, "peers are still served under stuffing");
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// Valid sessions nothing has vouched for yet — minted, rotated, or with an
// expired auth-cache entry — under an egress that stays under stuffing.
// ═════════════════════════════════════════════════════════════════════════════

/** Mirrors AUTH_CACHE_MAX_TTL_SECONDS in index.ts. */
const AUTH_CACHE_MAX_TTL_SECONDS = 600;

/** One co-tenant handset presents `LIMIT` distinct forged session bearers,
 * each judged and refused by Auth: the egress is now under stuffing. */
async function stuffEgress(h: Harness, ip: string, salt = crypto.randomUUID()) {
  const forged = new Set(Array.from({ length: LIMIT }, (_, i) => supabaseBearer(`${salt}-${i}`)));
  const prior = h.respond;
  h.respond = (call) =>
    isUserCall(call) && forged.has(bearerOfCall(call)) ? credentialRefused() : prior(call);
  const statuses: number[] = [];
  for (const bearer of forged) statuses.push((await readMe(h.handler, ip, bearer)).status);
  assert(allEqual(statuses, 401), `each guess is refused by Auth: ${statuses.join(",")}`);
  assertEquals(await egressCharged(ip), LIMIT, "the egress is under stuffing");
}

Deno.test(
  "NAT: under stuffing a peer signs in (bootstrap 200) and its FIRST read with the session the edge just minted is 200 — Auth judged it, nothing was cached beforehand",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(OTHER_USER_ID)];
    const ip = freshIp();
    const newHandset = fakeGoogleIdToken(OTHER_USER_ID);
    h.respond = (call) =>
      isIdTokenCall(call) && bodyField(call, "id_token") === newHandset
        ? mintedSession(OTHER_USER_ID)
        : null;
    await stuffEgress(h, ip);

    const signIn = await sendJson(
      h.handler,
      userRequest("POST", "/v1/account/bootstrap", { token: newHandset, ip, body: {} }),
    );
    assertEquals(signIn.status, 200, "the sign-in itself is served");
    const minted = sessionAccessToken(signIn.body);
    assert(minted.length > 0, "bootstrap returned a session access token");

    const upstreamBefore = h.calls.filter(isUserCall).length;
    const firstRead = await readMe(h.handler, ip, minted);
    assertEquals(
      firstRead.status,
      200,
      `the session the edge minted seconds ago is valid: its first read is served (Retry-After=${firstRead.headers.get(
        "Retry-After",
      )})`,
    );
    assert(
      h.calls.filter(isUserCall).length - upstreamBefore <= 1,
      "Auth judged the minted session at most once",
    );
    assertEquals((await readMe(h.handler, ip, minted)).status, 200, "and it keeps reading");
    assertEquals(await egressCharged(ip), LIMIT, "a valid session costs the signal nothing");
  },
);

Deno.test(
  "NAT: under stuffing a verified peer rotates (refresh 200) and its FIRST read with the rotated access token is 200",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const before = fakeSupabaseAccessToken(TEST_USER_ID);
    assertEquals((await readMe(h.handler, ip, before)).status, 200, "peer verified and cached");
    const liveRefreshToken = `rt-live-${crypto.randomUUID()}`;
    h.respond = (call) =>
      isRefreshCall(call) && bodyField(call, "refresh_token") === liveRefreshToken
        ? mintedSession(TEST_USER_ID)
        : null;
    await stuffEgress(h, ip);

    assertEquals((await readMe(h.handler, ip, before)).status, 200, "cached read still served");
    const refresh = await sendJson(
      h.handler,
      new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
        method: "POST",
        headers: { "x-forwarded-for": ip, "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: liveRefreshToken }),
      }),
    );
    assertEquals(refresh.status, 200, "the rotation is served");
    const rotated = sessionAccessToken(refresh.body);
    assert(rotated.length > 0 && rotated !== before, "refresh returned a new access token");

    const upstreamBefore = h.calls.filter(isUserCall).length;
    const firstRead = await readMe(h.handler, ip, rotated);
    assertEquals(
      firstRead.status,
      200,
      `the rotated access token of a verified peer is served (Retry-After=${firstRead.headers.get(
        "Retry-After",
      )})`,
    );
    assert(h.calls.filter(isUserCall).length - upstreamBefore <= 1, "Auth judged it at most once");
    assertEquals((await readMe(h.handler, ip, rotated)).status, 200, "and it keeps reading");
  },
);

Deno.test(
  "NAT: one handset guessing 30 distinct bearers per window for three windows never takes a verified peer offline once its auth-cache entry (600 s) expired — the valid session is re-verified and served",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const realNow = Date.now;
    const windowMs = AUTH_FAILURE_LIMIT.windowSeconds * 1_000;
    let clock = (Math.floor(realNow() / windowMs) + 1) * windowMs + 1_000;
    Date.now = () => clock;
    try {
      const t0 = clock;
      const peer = fakeSupabaseAccessToken(TEST_USER_ID);
      const peerVerifications = () =>
        h.calls.filter((call) => isUserCall(call) && bearerOfCall(call) === peer).length;
      assertEquals((await readMe(h.handler, ip, peer)).status, 200, "peer verified at t0");
      assertEquals(peerVerifications(), 1);

      // Windows 0 and 1 (t0, t0+5 min): stuffed while the peer is cached.
      for (let window = 0; window < 2; window += 1) {
        await stuffEgress(h, ip, `window-${window}`);
        assertEquals(
          (await readMe(h.handler, ip, peer)).status,
          200,
          `the cached peer is served while window ${window} is stuffed`,
        );
        clock += windowMs;
      }
      assertEquals(peerVerifications(), 1, "served from the cache");
      // t0 + 10 min + 1 s: the peer's cache entry is gone, and the third
      // window is stuffed before the peer's next request.
      clock += 1_000;
      assert(clock - t0 > AUTH_CACHE_MAX_TTL_SECONDS * 1_000, "the cache entry has expired");
      await stuffEgress(h, ip, "window-2");
      const reverified = await readMe(h.handler, ip, peer);
      assertEquals(
        reverified.status,
        200,
        `a peer holding a VALID session is re-verified and served, not 429 (Retry-After=${reverified.headers.get(
          "Retry-After",
        )})`,
      );
      assertEquals(
        peerVerifications(),
        2,
        "Auth re-verified the peer (the cache entry had expired)",
      );
      assertEquals((await readMe(h.handler, ip, peer)).status, 200, "cached again");
      assertEquals(peerVerifications(), 2);
      await assertPeersServed(h, ip, "new, rotated and established peers are served too");
    } finally {
      Date.now = realNow;
    }
  },
);

Deno.test(
  "NAT: under stuffing the 31st DISTINCT guess is 429 after Auth refused it, a dead session is still a plain 401, and a rate-limited Auth is still 503",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const dead = supabaseBearer("dead-under-stuffing");
    const outage = supabaseBearer("outage-under-stuffing");
    const guess = supabaseBearer("guess-under-stuffing");
    h.respond = (call) => {
      if (!isUserCall(call)) return null;
      const bearer = bearerOfCall(call);
      if (bearer === dead) return sessionGone();
      if (bearer === outage) return jsonResponse(429, { message: "rate limited" });
      if (bearer === guess) return credentialRefused();
      return null;
    };
    await stuffEgress(h, ip);

    const refusedGuess = await readMe(h.handler, ip, guess);
    assertEquals(refusedGuess.status, 429, "a guess Auth refused under stuffing is throttled");
    assertBoundedRetryAfter(refusedGuess);
    assertNoInternalHeaders(refusedGuess);
    assertEquals((await readMe(h.handler, ip, guess)).status, 429, "and its replay is too");
    assertEquals(
      h.calls.filter((call) => isUserCall(call) && bearerOfCall(call) === guess).length,
      1,
      "the replay never reached Auth",
    );

    const signedOut = await readMe(h.handler, ip, dead);
    assertEquals(signedOut.status, 401, "a real but dead session is refused, not throttled");
    assertNoInternalHeaders(signedOut);
    assertEquals((await readMe(h.handler, ip, dead)).status, 429, "its replay is throttled");

    assertEquals((await readMe(h.handler, ip, outage)).status, 503, "an outage stays retryable");
    assertEquals((await readMe(h.handler, ip, outage)).status, 503, "and charges no shard");
    await assertPeersServed(h, ip, "peers are served");
  },
);

Deno.test(
  "NAT: a banned account signing in (bootstrap) or bearing its ID token (transitional) is liveness, not a guess",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const banned = new Set(Array.from({ length: 10 }, () => googleIdToken(OTHER_USER_ID)));
    h.respond = (call) =>
      isIdTokenCall(call) && banned.has(bodyField(call, "id_token"))
        ? jsonResponse(403, { code: 403, error_code: "user_banned", msg: "User is banned" })
        : null;
    const statuses: number[] = [];
    for (const idToken of banned) {
      statuses.push((await postBootstrap(h.handler, ip, idToken)).status);
      statuses.push((await readMe(h.handler, ip, idToken)).status);
    }
    assert(allEqual(statuses, 401), `a banned account is refused: ${statuses.join(",")}`);
    assertEquals(h.calls.filter(isIdTokenCall).length, 20, "Auth judged every presentation");
    assertEquals(await egressCharged(ip), 0, "a banned real account is not stuffing signal");
    await assertPeersServed(h, ip, "peers are served");
  },
);

Deno.test(
  "NAT: ONE forged bearer replayed 31× — 30 × 401 then 429 before Auth for that bearer; the stuffing signal reads 1; peers are served",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const forged = supabaseBearer("forged-replayed");
    h.respond = (call) =>
      isUserCall(call) && bearerOfCall(call) === forged ? credentialRefused() : null;

    const responses: Response[] = [];
    for (let i = 0; i < LIMIT + 1; i += 1) responses.push(await readMe(h.handler, ip, forged));
    const statuses = responses.map((r) => r.status);
    assertEquals(statuses.slice(0, LIMIT), new Array(LIMIT).fill(401));
    assertEquals(statuses[LIMIT], 429, "the 31st replay of a refused bearer is throttled");
    assertBoundedRetryAfter(responses[LIMIT]);
    for (const response of responses) assertNoInternalHeaders(response);
    assertEquals(
      h.calls.filter((call) => isUserCall(call) && bearerOfCall(call) === forged).length,
      LIMIT,
      "the throttled replay never reached Auth",
    );
    assertEquals(
      await egressCharged(ip),
      1,
      "one credential, however often replayed, is one guess",
    );
    await assertPeersServed(h, ip, "a replayed guess never fences peers");
  },
);

Deno.test(
  "NAT: 60 concurrent replays of one refused bearer racing valid peers — peers 200, replays 401 or 429 only, signal 1, then the bearer is throttled",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const forged = supabaseBearer("forged-concurrent");
    h.respond = (call) =>
      isUserCall(call) && bearerOfCall(call) === forged ? credentialRefused() : null;
    const peers = Array.from({ length: 5 }, () => fakeSupabaseAccessToken(TEST_USER_ID));
    const results = await Promise.all([
      ...Array.from({ length: 60 }, () => readMe(h.handler, ip, forged)),
      ...peers.map((peer) => readMe(h.handler, ip, peer)),
    ]);
    const attacker = results.slice(0, 60).map((r) => r.status);
    assertEquals(
      results.slice(60).map((r) => r.status),
      [200, 200, 200, 200, 200],
      "peers racing the replay are served",
    );
    assert(
      attacker.every((s) => s === 401 || s === 429),
      `replays are refused or throttled, never served: ${attacker.join(",")}`,
    );
    assert(attacker.includes(401), "the first replays did reach Auth and were refused");
    assertEquals(await egressCharged(ip), 1, "one credential is one guess, concurrently too");
    assertEquals(
      (await readMe(h.handler, ip, forged)).status,
      429,
      "after the burst the shard is closed for that bearer",
    );
    await assertPeersServed(h, ip, "peers still served after the race");
  },
);

Deno.test(
  "NAT: an Auth outage (5xx / 429 / network / malformed 2xx) on 31 distinct bearers charges nothing and peers are served once Auth recovers",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const outages: Array<() => Promise<Response> | Response> = [
      () => jsonResponse(503, { message: "upstream unavailable" }),
      () => new Response("<html>bad gateway</html>", { status: 502 }),
      () => jsonResponse(429, { message: "rate limited" }),
      () => Promise.reject(new TypeError("connection reset")),
      () => new Response("<html>gateway</html>", { status: 200 }),
      () => jsonResponse(200, { ok: true }),
    ];
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 1; i += 1) {
      const respond = outages[i % outages.length];
      h.respond = (call) => (isUserCall(call) ? respond() : null);
      statuses.push((await readMe(h.handler, ip, supabaseBearer(`outage-${i}`))).status);
    }
    assert(
      allEqual(statuses, 503),
      `an outage is retryable, never a verdict: ${statuses.join(",")}`,
    );
    assertEquals(await egressCharged(ip), 0);
    h.respond = () => null;
    await assertPeersServed(h, ip, "peers are served after the outage");
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// Liveness refusals — a real credential that is dead (signed out elsewhere,
// session expired server-side, account gone). Shard only, never stuffing.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "NAT: 30 signed-out co-tenants (session_not_found, both GoTrue error shapes) raise no stuffing signal; one replayed dead bearer is throttled alone",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const modern = new Set(Array.from({ length: 15 }, (_, i) => supabaseBearer(`signed-out-${i}`)));
    const legacy = new Set(
      Array.from({ length: 15 }, (_, i) => supabaseBearer(`signed-out-legacy-${i}`)),
    );
    const replayed = supabaseBearer("signed-out-replayed");
    h.respond = (call) => {
      if (!isUserCall(call)) return null;
      const bearer = bearerOfCall(call);
      if (modern.has(bearer) || bearer === replayed) return sessionGone();
      if (legacy.has(bearer)) return sessionGoneLegacyShape();
      return null;
    };
    const statuses: number[] = [];
    for (const bearer of [...modern, ...legacy]) {
      statuses.push((await readMe(h.handler, ip, bearer)).status);
    }
    assert(allEqual(statuses, 401), `each signed-out peer is refused: ${statuses.join(",")}`);
    assertEquals(await egressCharged(ip), 0, "liveness is not stuffing, whatever the body shape");
    await assertPeersServed(h, ip, "signed-out co-tenants never fence live peers");

    const replays = await repeat(LIMIT, () => readMe(h.handler, ip, replayed));
    assert(allEqual(replays, 401), `dead bearer refused ${LIMIT}×: ${replays.join(",")}`);
    const throttled = await readMe(h.handler, ip, replayed);
    assertEquals(throttled.status, 429, "the 31st replay of one dead bearer is throttled");
    assertBoundedRetryAfter(throttled);
    assertEquals(
      h.calls.filter((call) => isUserCall(call) && bearerOfCall(call) === replayed).length,
      LIMIT,
    );
    assertEquals(await egressCharged(ip), 0, "a replayed dead bearer is still not stuffing");
    await assertPeersServed(h, ip, "peers are served throughout");
  },
);

Deno.test(
  "NAT: a session revoked at this edge (logout fence) is a liveness refusal — 30 replays charge no stuffing signal and peers are served",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const bearer = fakeSupabaseAccessToken(TEST_USER_ID);
    assertEquals((await readMe(h.handler, ip, bearer)).status, 200, "live before logout");
    const logout = await send(
      h.handler,
      userRequest("POST", "/v1/auth/logout", { token: bearer, ip, body: {} }),
    );
    assertEquals(logout.status, 204);
    const replays = await repeat(LIMIT, () => readMe(h.handler, ip, bearer));
    assert(allEqual(replays, 401), `fenced bearer is refused: ${replays.join(",")}`);
    assertEquals(await egressCharged(ip), 0);
    assertEquals((await readMe(h.handler, ip, bearer)).status, 429, "31st replay throttled");
    await assertPeersServed(h, ip, "peers are served");
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// Refresh — the refresh token in the body is the credential; a bearer header
// on the request is not judged and does not gate it.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "NAT: 30 DISTINCT refused refresh tokens raise the stuffing signal but never fence a valid bearer, a live refresh or a sign-in from the same address",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const bogus = new Set(Array.from({ length: LIMIT }, (_, i) => `rt-bogus-${i}-${ip}`));
    h.respond = (call) =>
      isRefreshCall(call) && bogus.has(bodyField(call, "refresh_token")) ? refreshRefused() : null;
    await inFreshAuthWindow(async (nextMinute) => {
      await assertPeersServed(h, ip, "peers are served before the stuffing");
      nextMinute();
      const statuses: number[] = [];
      for (const token of bogus) statuses.push((await postRefresh(h.handler, ip, token)).status);
      assert(allEqual(statuses, 401), `each bogus refresh is refused: ${statuses.join(",")}`);
      assertEquals(await egressCharged(ip), LIMIT);
      nextMinute();
      await assertPeersServed(h, ip, "peers are served after 30 refresh guesses");
    });
  },
);

Deno.test(
  "NAT: ONE refused refresh token replayed 31× is throttled on the 31st before Auth (shard on the refresh token); a spent one is liveness",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const bogus = `rt-bogus-replayed-${ip}`;
    const spentToken = `rt-spent-${ip}`;
    h.respond = (call) => {
      if (!isRefreshCall(call)) return null;
      const token = bodyField(call, "refresh_token");
      if (token === bogus) return refreshRefused();
      if (token === spentToken) return refreshAlreadyUsed();
      return null;
    };
    await inFreshAuthWindow(async (nextMinute) => {
      const replays = await repeat(LIMIT, () => postRefresh(h.handler, ip, bogus));
      assert(allEqual(replays, 401), `bogus refresh refused ${LIMIT}×: ${replays.join(",")}`);
      nextMinute();
      const throttled = await postRefresh(h.handler, ip, bogus);
      assertEquals(throttled.status, 429, "the 31st replay is throttled");
      assertBoundedRetryAfter(throttled);
      assertEquals(
        h.calls.filter((call) => isRefreshCall(call) && bodyField(call, "refresh_token") === bogus)
          .length,
        LIMIT,
        "the throttled replay never reached Auth",
      );
      assertEquals(await egressCharged(ip), 1, "one refused refresh token is one guess");

      const spentStatuses = await repeat(5, () => postRefresh(h.handler, ip, spentToken));
      assert(
        allEqual(spentStatuses, 401),
        `already-used token is refused: ${spentStatuses.join(",")}`,
      );
      assertEquals(await egressCharged(ip), 1, "an already-rotated token is liveness, not a guess");
      await assertPeersServed(h, ip, "peers are served");
    });
  },
);

Deno.test(
  "NAT: a DEAD bearer header on a refresh request does not gate the LIVE refresh token in its body, and its refusals do not charge the bearer",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const dead = supabaseBearer("dead-on-refresh");
    h.respond = (call) =>
      isUserCall(call) && bearerOfCall(call) === dead ? credentialRefused() : null;
    const refusals = await repeat(LIMIT, () => readMe(h.handler, ip, dead));
    assert(allEqual(refusals, 401));
    assertEquals((await readMe(h.handler, ip, dead)).status, 429, "the dead bearer is closed");
    const refreshed = await postRefresh(h.handler, ip, `rt-live-${crypto.randomUUID()}`, dead);
    assertEquals(refreshed.status, 200, "the live refresh token rotates regardless of the header");
    assertEquals(await egressCharged(ip), 1);
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// Bootstrap — the provider ID token is the credential.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "NAT: bootstrap junk (local) charges nothing; a refused ID token is one guess and its 31st replay is throttled; a real sign-in is served",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const bad = googleIdToken(OTHER_USER_ID);
    h.respond = (call) =>
      isIdTokenCall(call) && bodyField(call, "id_token") === bad ? idTokenRefused() : null;

    const junk = await repeat(5, () => postBootstrap(h.handler, ip, `junk-${crypto.randomUUID()}`));
    assert(allEqual(junk, 401), `junk bootstrap → 401: ${junk.join(",")}`);
    const expired = googleIdToken(OTHER_USER_ID, Math.floor(Date.now() / 1000) - 60);
    const stale = await repeat(3, () => postBootstrap(h.handler, ip, expired));
    assert(allEqual(stale, 401), `expired ID token → 401: ${stale.join(",")}`);
    assertEquals(await egressCharged(ip), 0, "nothing reached Auth, nothing charged");
    assertEquals(h.calls.filter(isIdTokenCall).length, 0);

    // The bootstrap route budget (AUTH_BOOTSTRAP_LIMIT) is 30/min per IP;
    // everything below stays inside it so only the auth-failure accounting
    // is under test.
    const refused = await repeat(14, () => postBootstrap(h.handler, ip, bad));
    assert(allEqual(refused, 401), `a refused ID token → 401: ${refused.join(",")}`);
    assertEquals(await egressCharged(ip), 1, "one refused ID token is one guess");
    assertEquals(
      (await postBootstrap(h.handler, ip, fakeGoogleIdToken(TEST_USER_ID))).status,
      200,
      "a real sign-in from the address is served",
    );
    await assertPeersServed(h, ip, "peers are served");
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// Primitives — rateLimit.ts in fresh isolates (memory fallback and Upstash).
// ═════════════════════════════════════════════════════════════════════════════

const BUDGET = AUTH_FAILURE_LIMIT;

Deno.test("primitives: classification of GoTrue refusals", async () => {
  configureRedis(false);
  const { rateLimit } = await loadIsolate();
  const kind = rateLimit.authRefusalKind;
  for (const code of [
    "session_not_found",
    "session_expired",
    "user_not_found",
    "user_banned",
    "refresh_token_already_used",
  ]) {
    assertEquals(kind({ code: 403, error_code: code, msg: "x" }), "liveness", code);
  }
  for (const code of ["bad_jwt", "bad_id_token", "refresh_token_not_found", "no_authorization"]) {
    assertEquals(kind({ code: 403, error_code: code, msg: "x" }), "credential", code);
  }
  // Older GoTrue error bodies name the condition in `msg`/`error_description`.
  assertEquals(
    kind({ code: 401, msg: "Session from session_id claim in JWT does not exist" }),
    "liveness",
  );
  assertEquals(kind({ code: 401, msg: "User from sub claim in JWT does not exist" }), "liveness");
  assertEquals(
    kind({ error: "invalid_grant", error_description: "Invalid Refresh Token: Already Used" }),
    "liveness",
  );
  assertEquals(
    kind({ code: 401, msg: "invalid JWT: unable to parse or verify signature" }),
    "credential",
  );
  assertEquals(
    kind({
      error: "invalid_grant",
      error_description: "Invalid Refresh Token: Refresh Token Not Found",
    }),
    "credential",
  );
  assertEquals(kind("<html>nope</html>"), "credential");
  assertEquals(kind(null), "credential");
  assertEquals(kind({ error_code: 42 }), "credential");
  assertEquals(await rateLimit.authFailureIdentity(""), null);
  assertEquals(await rateLimit.authFailureIdentity("   "), null);
  const a = await rateLimit.authFailureIdentity("token-a");
  assert(a !== null && a.length >= 32 && !a.includes("token-a"), "identity is an opaque digest");
  assertEquals(await rateLimit.authFailureIdentity("token-a"), a, "identity is stable");
  assert((await rateLimit.authFailureIdentity("token-b")) !== a);
});

Deno.test("primitives: charge and peek semantics in the memory fallback", async () => {
  configureRedis(false);
  const { rateLimit } = await loadIsolate();
  const ip = "203.0.113.10";
  const egress = () => rateLimit.peekRateLimit("authfail", ip, BUDGET.limit, BUDGET.windowSeconds);
  const alice = await rateLimit.authFailureIdentity("alice");
  const dead = await rateLimit.authFailureIdentity("dead");
  const guess = await rateLimit.authFailureIdentity("guess");

  // Local: nothing.
  await rateLimit.chargeAuthFailure(ip, alice, { kind: "local" }, BUDGET);
  await rateLimit.chargeAuthFailure(ip, null, { kind: "credential" }, BUDGET);
  assertEquals(spent(await egress()), 0);
  assertEquals((await rateLimit.peekAuthFailureBudget(ip, alice, BUDGET)).allowed, true);
  assertEquals((await rateLimit.peekAuthFailureBudget(ip, null, BUDGET)).allowed, true);

  // Liveness: shard only.
  for (let i = 0; i < BUDGET.limit; i += 1) {
    assertEquals((await rateLimit.peekAuthFailureBudget(ip, dead, BUDGET)).allowed, true);
    await rateLimit.chargeAuthFailure(ip, dead, { kind: "liveness" }, BUDGET);
  }
  const closed = await rateLimit.peekAuthFailureBudget(ip, dead, BUDGET);
  assertEquals(closed.allowed, false);
  assertEquals(closed.remaining, 0);
  assertEquals(closed.limit, BUDGET.limit);
  assert(closed.retryAfterSeconds >= 1 && closed.retryAfterSeconds <= BUDGET.windowSeconds);
  assertEquals(spent(await egress()), 0, "liveness never raises the stuffing signal");
  assertEquals((await rateLimit.peekAuthFailureBudget(ip, alice, BUDGET)).allowed, true);

  // Credential: shard + signal once per distinct credential.
  await rateLimit.chargeAuthFailure(ip, guess, { kind: "credential" }, BUDGET);
  await rateLimit.chargeAuthFailure(ip, guess, { kind: "credential" }, BUDGET);
  assertEquals(spent(await egress()), 1, "one credential, replayed, is one guess");
  const peeked = await rateLimit.peekAuthFailureBudget(ip, guess, BUDGET);
  assertEquals(peeked.allowed, true);
  assertEquals(peeked.remaining, BUDGET.limit - 2);

  // The refusal may name the credential it judged (refresh: the body token,
  // not the presented bearer).
  const body = await rateLimit.authFailureIdentity("refresh-token");
  await rateLimit.chargeAuthFailure(ip, alice, { kind: "credential", identity: body }, BUDGET);
  assertEquals((await rateLimit.peekAuthFailureBudget(ip, alice, BUDGET)).remaining, BUDGET.limit);
  assertEquals(
    (await rateLimit.peekAuthFailureBudget(ip, body, BUDGET)).remaining,
    BUDGET.limit - 1,
  );
  await rateLimit.chargeAuthFailure(ip, alice, { kind: "credential", identity: null }, BUDGET);
  assertEquals((await rateLimit.peekAuthFailureBudget(ip, alice, BUDGET)).remaining, BUDGET.limit);

  // Stuffing: once `limit` DISTINCT guesses were refused the egress is under
  // stuffing — every credential refused this window is closed on replay, a
  // further distinct guess is reported so its 401 becomes a 429 — while a
  // credential nothing refused is never closed by it.
  assertEquals((await rateLimit.peekAuthStuffing(ip, BUDGET)).allowed, true);
  for (let i = spent(await egress()); i < BUDGET.limit; i += 1) {
    const id = await rateLimit.authFailureIdentity(`stuffed-${i}`);
    assertEquals(
      await rateLimit.chargeAuthFailure(ip, id, { kind: "credential" }, BUDGET),
      null,
      "a guess within the budget stands as judged",
    );
  }
  assertEquals(spent(await egress()), BUDGET.limit);
  const stuffing = await rateLimit.peekAuthStuffing(ip, BUDGET);
  assertEquals(stuffing.allowed, false);
  assertEquals(stuffing.remaining, 0);
  assert(stuffing.retryAfterSeconds >= 1 && stuffing.retryAfterSeconds <= BUDGET.windowSeconds);
  const replayed = await rateLimit.peekAuthFailureBudget(ip, guess, BUDGET);
  assertEquals(replayed.allowed, false, "a refused guess replayed under stuffing is closed");
  assertEquals(replayed.remaining, 0);
  assertEquals((await rateLimit.peekAuthFailureBudget(ip, dead, BUDGET)).allowed, false);
  assertEquals((await rateLimit.peekAuthFailureBudget(ip, alice, BUDGET)).allowed, true);
  assertEquals((await rateLimit.peekAuthFailureBudget(ip, null, BUDGET)).allowed, true);
  const novel = await rateLimit.authFailureIdentity("novel-under-stuffing");
  assertEquals(
    (await rateLimit.peekAuthFailureBudget(ip, novel, BUDGET)).allowed,
    true,
    "a credential nothing refused reaches Auth under stuffing",
  );
  const throttled = await rateLimit.chargeAuthFailure(ip, novel, { kind: "credential" }, BUDGET);
  assert(throttled !== null, "a guess past the stuffing budget is reported");
  assertEquals(throttled.allowed, false);
  assertEquals(throttled.remaining, 0);
  assert(throttled.retryAfterSeconds >= 1 && throttled.retryAfterSeconds <= BUDGET.windowSeconds);
  assertEquals(
    await rateLimit.chargeAuthFailure(ip, novel, { kind: "credential" }, BUDGET),
    null,
    "its replay is charged to the shard only (the peek closes it)",
  );
  const bob = await rateLimit.authFailureIdentity("bob-under-stuffing");
  assertEquals(
    await rateLimit.chargeAuthFailure(ip, bob, { kind: "liveness" }, BUDGET),
    null,
    "a dead real credential is never throttled by stuffing",
  );
  assertEquals(
    await rateLimit.chargeAuthFailure(ip, null, { kind: "local" }, BUDGET),
    null,
    "nor is a local refusal",
  );
  assertEquals(spent(await egress()), BUDGET.limit, "the signal is clamped at the budget");
  const other = await rateLimit.authFailureIdentity("elsewhere");
  assertEquals(
    await rateLimit.chargeAuthFailure("203.0.113.11", other, { kind: "credential" }, BUDGET),
    null,
  );
  assertEquals(
    (await rateLimit.peekAuthStuffing("203.0.113.11", BUDGET)).allowed,
    true,
    "another egress is not under stuffing",
  );
  assertEquals(
    (await rateLimit.peekAuthFailureBudget("203.0.113.11", guess, BUDGET)).allowed,
    true,
    "shards are per egress",
  );
});

Deno.test(
  "primitives: the window is fixed and aligned — a stale shard reopens with the bucket",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const realNow = Date.now;
    const windowMs = BUDGET.windowSeconds * 1_000;
    let clock = (Math.floor(realNow() / windowMs) + 2) * windowMs + 1_000;
    Date.now = () => clock;
    try {
      const ip = "203.0.113.12";
      const id = await rateLimit.authFailureIdentity("stale");
      for (let i = 0; i < BUDGET.limit; i += 1) {
        await rateLimit.chargeAuthFailure(ip, id, { kind: "credential" }, BUDGET);
      }
      assertEquals((await rateLimit.peekAuthFailureBudget(ip, id, BUDGET)).allowed, false);
      clock += windowMs;
      assertEquals((await rateLimit.peekAuthFailureBudget(ip, id, BUDGET)).allowed, true);
      assertEquals(
        spent(await rateLimit.peekRateLimit("authfail", ip, BUDGET.limit, BUDGET.windowSeconds)),
        0,
      );
    } finally {
      Date.now = realNow;
    }
  },
);

Deno.test(
  "primitives: a charge straddling the window boundary keys both counters to ONE instant",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const realNow = Date.now;
    const windowMs = BUDGET.windowSeconds * 1_000;
    const bucket = Math.floor(realNow() / windowMs) + 2;
    const boundary = bucket * windowMs;
    let clock = boundary - 1;
    let reads = 0;
    Date.now = () => {
      reads += 1;
      if (reads > 1) clock = boundary + 1;
      return clock;
    };
    try {
      const ip = "203.0.113.13";
      const id = await rateLimit.authFailureIdentity("straddling");
      await rateLimit.chargeAuthFailure(ip, id, { kind: "credential" }, BUDGET);
      clock = boundary + 1_000;
      await rateLimit.chargeAuthFailure(ip, id, { kind: "credential" }, BUDGET);
      const before = await rateLimit.peekRateLimit(
        "authfail",
        ip,
        BUDGET.limit,
        BUDGET.windowSeconds,
      );
      assert(
        spent(before) <= 1,
        `one credential charges one window's signal at most once (${spent(before)})`,
      );
      clock = boundary + 2_000;
      const after = await rateLimit.peekRateLimit(
        "authfail",
        ip,
        BUDGET.limit,
        BUDGET.windowSeconds,
      );
      assert(spent(after) <= 1, `…in the next window too (${spent(after)})`);
    } finally {
      Date.now = realNow;
    }
  },
);

Deno.test(
  "primitives: shard cardinality never fails a clean venue CLOSED in the memory fallback",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const egresses = Math.ceil(MEMORY_WINDOW_MAX / BUDGET.limit) + 1;
    for (let e = 0; e < egresses; e += 1) {
      const ip = `198.51.${Math.floor(e / 250)}.${e % 250}`;
      for (let i = 0; i < BUDGET.limit; i += 1) {
        await rateLimit.chargeAuthFailure(ip, `guess-${e}-${i}`, { kind: "credential" }, BUDGET);
      }
    }
    const venue = "203.0.113.77";
    const peer = await rateLimit.authFailureIdentity(fakeSupabaseAccessToken(TEST_USER_ID));
    const ipWindow = await rateLimit.enforceRateLimit(
      "ip",
      venue,
      IP_LIMIT.limit,
      IP_LIMIT.windowSeconds,
    );
    const shard = await rateLimit.peekAuthFailureBudget(venue, peer, BUDGET);
    assertEquals(
      { ip: ipWindow.allowed, peer: shard.allowed },
      { ip: true, peer: true },
      `a venue that never failed must not be fenced (ip remaining=${ipWindow.remaining}, peer remaining=${shard.remaining})`,
    );
    // The shard store is full: a new guess elsewhere is tolerated (fail open)
    // rather than fencing new keys.
    const late = await rateLimit.authFailureIdentity("late-guess");
    await rateLimit.chargeAuthFailure(venue, late, { kind: "credential" }, BUDGET);
    assertEquals((await rateLimit.peekAuthFailureBudget(venue, late, BUDGET)).allowed, true);
  },
);

Deno.test(
  "primitives: with Upstash the shard and the signal are shared across isolates",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const ip = "203.0.113.90";
      const isolates = [await loadIsolate(), await loadIsolate(), await loadIsolate()];
      const dead = await isolates[0].rateLimit.authFailureIdentity("dead-shared");
      for (let i = 0; i < BUDGET.limit; i += 1) {
        const { rateLimit } = isolates[i % isolates.length];
        assertEquals((await rateLimit.peekAuthFailureBudget(ip, dead, BUDGET)).allowed, true);
        await rateLimit.chargeAuthFailure(ip, dead, { kind: "credential" }, BUDGET);
      }
      for (const { rateLimit } of isolates) {
        assertEquals((await rateLimit.peekAuthFailureBudget(ip, dead, BUDGET)).allowed, false);
        assertEquals(
          spent(await rateLimit.peekRateLimit("authfail", ip, BUDGET.limit, BUDGET.windowSeconds)),
          1,
          "one credential across isolates is one guess",
        );
      }
      const shardKeys = [...redis.store.keys()].filter((key) => key.includes(":authfail_id:"));
      assertEquals(shardKeys.length, 1, "one shard key");
      assert(
        shardKeys.every((key) => !key.includes("dead-shared")),
        "the credential itself never appears in a key",
      );
      const ttl = redis.store.get(shardKeys[0])?.expiresAtMs;
      assert(
        typeof ttl === "number" && ttl - Date.now() <= BUDGET.windowSeconds * 1_000,
        "the shard expires with its window",
      );
    } finally {
      redis.restore();
      configureRedis(false);
    }
  },
);

Deno.test(
  "primitives: Redis refusing only the shard INCRs never multiplies one replayed credential into a shared stuffing signal",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      redis.commandError = (cmd) =>
        cmd[0] === "INCR" && String(cmd[1]).includes(":authfail_id:")
          ? "ERR shard slot down"
          : null;
      const ip = "203.0.113.91";
      const first = await loadIsolate();
      const dead = await first.rateLimit.authFailureIdentity("dead-replayed");
      const isolates = [first];
      for (let i = 1; i < BUDGET.limit; i += 1) isolates.push(await loadIsolate());
      for (const { rateLimit } of isolates) {
        await rateLimit.chargeAuthFailure(ip, dead, { kind: "credential" }, BUDGET);
      }
      const shared = [...redis.store.entries()].filter(([key]) => key.includes(":authfail:"));
      assertEquals(
        shared.map(([, entry]) => Number(entry.value)),
        [],
        "a charge whose shard fell back to memory keeps its signal in memory too",
      );
      for (const { rateLimit } of isolates) {
        assertEquals(
          spent(await rateLimit.peekAuthFailureBudget(ip, dead, BUDGET)),
          1,
          "each isolate still counts the guess it saw in its own memory shard",
        );
        assertEquals(
          spent(await rateLimit.peekRateLimit("authfail", ip, BUDGET.limit, BUDGET.windowSeconds)),
          0,
          "the shared stuffing signal never saw the credential",
        );
      }
    } finally {
      redis.restore();
      configureRedis(false);
    }
  },
);

Deno.test(
  "primitives: a Redis outage fails open for a clean credential and falls back to memory",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      redis.failStatus = 500;
      const { rateLimit } = await loadIsolate();
      const ip = "203.0.113.92";
      const id = await rateLimit.authFailureIdentity("during-outage");
      assertEquals((await rateLimit.peekAuthFailureBudget(ip, id, BUDGET)).allowed, true);
      for (let i = 0; i < BUDGET.limit; i += 1) {
        await rateLimit.chargeAuthFailure(ip, id, { kind: "credential" }, BUDGET);
      }
      assertEquals(
        (await rateLimit.peekAuthFailureBudget(ip, id, BUDGET)).allowed,
        false,
        "the per-isolate window still stops a runaway replay",
      );
      const clean = await rateLimit.authFailureIdentity("clean-during-outage");
      assertEquals((await rateLimit.peekAuthFailureBudget(ip, clean, BUDGET)).allowed, true);
    } finally {
      redis.restore();
      configureRedis(false);
    }
  },
);

Deno.test(
  "primitives: refusal tags ride the Response privately and default to a guess",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const plain = new Response(null, { status: 401 });
    assertEquals(rateLimit.authRefusalOf(plain), { kind: "credential" });
    const tagged = rateLimit.authRefusal(new Response(null, { status: 401 }), {
      kind: "liveness",
      identity: "abc",
    });
    assertEquals(rateLimit.authRefusalOf(tagged), { kind: "liveness", identity: "abc" });
    assertEquals([...tagged.headers.keys()], [], "no header carries the tag");
    const local = rateLimit.authRefusal(new Response(null, { status: 401 }), { kind: "local" });
    assertEquals(rateLimit.authRefusalOf(local).kind, "local");
  },
);
