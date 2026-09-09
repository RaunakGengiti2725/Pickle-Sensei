// W11-01 — auth-failure budgets behind a shared NAT egress.
//
// A venue (club Wi-Fi, office, carrier NAT) is ONE client IP. On the base the
// auth-failure budget was a flat per-IP counter charged by every 401, peeked
// before routing: one co-tenant's 30 failed authentications — junk bearers,
// an expired token retried, thirty guesses — made every valid peer behind that
// IP 429 on reads, sign-in and refresh for the rest of a 5-minute window.
//
// Contract pinned here (rateLimit.ts, wired through index.ts):
//
//   * LOCAL refusals (no bearer, junk, expired, wrong issuer, a capability on
//     a session route, a malformed refresh body) never consulted Supabase
//     Auth — nothing was guessed — and charge nothing.
//
//   * A refusal Auth judged charges the SHARD of the refused credential
//     (ip + sha256(credential)); the 31st presentation of that same refused
//     credential in a window is 429 before Auth. Nothing else is gated by it.
//
//   * LIVENESS refusals (`session_not_found`, `refresh_token_already_used`,
//     `user_banned`, …: a real credential that is merely dead) charge their
//     shard only — a signed-out handset retrying is not an attack.
//
//   * CREDENTIAL refusals (`bad_jwt`, `bad_id_token`, `refresh_token_not_found`,
//     …: a guess) also raise the egress's stuffing signal once per distinct
//     credential. Once the signal reaches the budget, a credential that Auth
//     already refused is 429 before Auth on its FIRST replay — but a
//     credential Auth has never refused is always judged: a valid peer's
//     cached read, uncached re-verification, sign-in, first read with the
//     session bootstrap just minted, refresh and first read with the rotated
//     token are 200 no matter what a co-tenant does.
//
//   * Shard cardinality is attacker-controlled, so the shard store fails OPEN
//     when full; Redis outages fail open; classification never reaches the
//     wire (no header, no body field).
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json rateLimit_nat_budget.test.ts

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { peekRateLimit } from "../rateLimit.ts";
import { configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";
import type { RecordedCall } from "./routesHarness.ts";
import {
  fakeGoogleIdToken,
  fakeSupabaseAccessToken,
  loadHarness,
  OTHER_USER_ID,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

/** Mirrors AUTH_FAILURE_LIMIT in index.ts. */
const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
/** Mirrors AUTH_REFRESH_LIMIT / AUTH_BOOTSTRAP_LIMIT (30 per IP per minute). */
const AUTH_ROUTE_WINDOW_MS = 60_000;
/** Mirrors AUTH_CACHE_MAX_TTL_SECONDS in index.ts. */
const AUTH_CACHE_MAX_TTL_SECONDS = 600;
const LIMIT = AUTH_FAILURE_LIMIT.limit;
const WINDOW_MS = AUTH_FAILURE_LIMIT.windowSeconds * 1_000;

type Handler = (request: Request) => Promise<Response>;
type Harness = Awaited<ReturnType<typeof loadHarness>>;

const profile = (id: string) => ({
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

const googleIdToken = (sub: string, exp = Math.floor(Date.now() / 1000) + 3600): string =>
  jwtOf({ iss: "https://accounts.google.com", sub, exp, salt: crypto.randomUUID() });

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// GoTrue refusal bodies, verbatim shapes.
const badJwt = () =>
  jsonResponse(403, {
    code: 403,
    error_code: "bad_jwt",
    msg: "invalid JWT: unable to parse or verify signature, token signature is invalid",
  });
const sessionNotFound = () =>
  jsonResponse(403, {
    code: 403,
    error_code: "session_not_found",
    msg: "Session from session_id claim in JWT does not exist",
  });
const userBanned = () =>
  jsonResponse(403, { code: 403, error_code: "user_banned", msg: "User is banned" });
const badIdToken = () =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Bad ID token",
    error_code: "bad_id_token",
  });
const refreshTokenNotFound = () =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Invalid Refresh Token: Refresh Token Not Found",
    error_code: "refresh_token_not_found",
  });
const refreshTokenAlreadyUsed = () =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Invalid Refresh Token: Already Used",
    error_code: "refresh_token_already_used",
  });

/** A freshly minted Supabase session shaped like GoTrue's `/token` answer,
 * whose access token is a Supabase-shaped JWT the edge accepts as a bearer. */
const mintedSession = (sub: string) => {
  const accessToken = fakeSupabaseAccessToken(sub);
  return jsonResponse(200, {
    access_token: accessToken,
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
};

const bearerOfCall = (call: RecordedCall): string =>
  (call.headers.authorization ?? "").replace(/^Bearer /, "");
const isUserCall = (call: RecordedCall) => call.url.startsWith(`${SUPABASE_URL}/auth/v1/user`);
const isRefreshCall = (call: RecordedCall) =>
  call.url.startsWith(`${SUPABASE_URL}/auth/v1/token`) &&
  call.url.includes("grant_type=refresh_token");
const isIdTokenCall = (call: RecordedCall) =>
  call.url.startsWith(`${SUPABASE_URL}/auth/v1/token`) && call.url.includes("grant_type=id_token");
const isAuthCall = (call: RecordedCall) => call.url.startsWith(`${SUPABASE_URL}/auth/v1/`);
const bodyField = (call: RecordedCall, field: string): string => {
  const body = call.body;
  if (typeof body !== "object" || body === null) return "";
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
};

let ipCounter = 0;
/** Unique egress per test (own /16 so no other suite's windows collide). */
const freshIp = () => `10.71.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const spent = (window: { limit: number; remaining: number }) => window.limit - window.remaining;

/** Distinct refused credentials charged to the egress — the stuffing signal.
 * Peeked with a huge limit so the count is exact (remaining clamps at 0). */
const EXACT = 1_000_000;
const egressCharged = async (ip: string): Promise<number> =>
  spent(await peekRateLimit("authfail", ip, EXACT, AUTH_FAILURE_LIMIT.windowSeconds));

async function send(handler: Handler, request: Request): Promise<Response> {
  const response = await handler(request);
  await response.body?.cancel();
  return response;
}

async function sendJson(
  handler: Handler,
  request: Request,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await handler(request);
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, headers: response.headers };
}

const readMe = (handler: Handler, ip: string, bearer: string) =>
  send(handler, userRequest("GET", "/v1/me", { token: bearer, ip }));

const refreshRequest = (ip: string, body: unknown, bearer?: string) =>
  new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
    method: "POST",
    headers: {
      "x-forwarded-for": ip,
      "content-type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const postRefresh = (handler: Handler, ip: string, refreshToken: string, bearer?: string) =>
  send(handler, refreshRequest(ip, { refreshToken }, bearer));

const postBootstrap = (handler: Handler, ip: string, idToken: string) =>
  send(handler, userRequest("POST", "/v1/account/bootstrap", { token: idToken, ip, body: {} }));

const bootstrapJson = (handler: Handler, ip: string, idToken: string) =>
  sendJson(handler, userRequest("POST", "/v1/account/bootstrap", { token: idToken, ip, body: {} }));

const refreshJson = (handler: Handler, ip: string, refreshToken: string) =>
  sendJson(handler, refreshRequest(ip, { refreshToken }));

const sessionOf = (
  body: Record<string, unknown>,
): { accessToken: string; refreshToken: string } => {
  const session = body.session;
  if (typeof session !== "object" || session === null) return { accessToken: "", refreshToken: "" };
  const record = session as Record<string, unknown>;
  return {
    accessToken: typeof record.accessToken === "string" ? record.accessToken : "",
    refreshToken: typeof record.refreshToken === "string" ? record.refreshToken : "",
  };
};

const repeat = async (times: number, run: () => Promise<Response>): Promise<number[]> => {
  const statuses: number[] = [];
  for (let i = 0; i < times; i += 1) statuses.push((await run()).status);
  return statuses;
};

const allEqual = (statuses: number[], expected: number) =>
  statuses.every((status) => status === expected);

/** Auth calls recorded since `mark`. */
const authCallsSince = (h: Harness, mark: number) => h.calls.slice(mark).filter(isAuthCall);

/** Assert a 429 came from the auth-failure budget: Retry-After bounded by the
 * 5-minute window and above the 1-minute route windows, standard headers only. */
function assertBudget429(response: Response, label: string) {
  assertEquals(response.status, 429, label);
  const retryAfter = Number(response.headers.get("Retry-After"));
  assert(
    retryAfter >= 1 && retryAfter <= AUTH_FAILURE_LIMIT.windowSeconds,
    `${label}: Retry-After`,
  );
  assertEquals(response.headers.get("RateLimit-Limit"), String(LIMIT), `${label}: RateLimit-Limit`);
  assertEquals(response.headers.get("RateLimit-Remaining"), "0", `${label}: RateLimit-Remaining`);
  assertEquals(response.headers.get("Cache-Control"), "no-store");
  return retryAfter;
}

/** Layer a responder over the harness's current one. */
function respondWith(h: Harness, layer: (call: RecordedCall) => Response | null) {
  const previous = h.respond;
  h.respond = async (call) => layer(call) ?? (await previous(call));
}

/** Put the egress under stuffing: one handset presents `LIMIT` DISTINCT forged
 * session bearers, each judged and refused by Auth. Returns the forged set. */
async function stuffEgress(h: Harness, ip: string): Promise<Set<string>> {
  const forged = new Set(Array.from({ length: LIMIT }, (_, i) => supabaseBearer(`forged-${i}`)));
  respondWith(h, (call) => (isUserCall(call) && forged.has(bearerOfCall(call)) ? badJwt() : null));
  const mark = h.calls.length;
  const statuses: number[] = [];
  for (const bearer of forged) statuses.push((await readMe(h.handler, ip, bearer)).status);
  assert(
    allEqual(statuses, 401),
    `every guess is judged and refused by Auth: ${statuses.join(",")}`,
  );
  assertEquals(authCallsSince(h, mark).length, LIMIT, "each distinct guess reached Auth once");
  assertEquals(await egressCharged(ip), LIMIT, "the egress is under stuffing");
  return forged;
}

/** Run with Date.now pinned to `startMs` (a fresh auth-failure window, 1 s in)
 * and a `tick(ms)` that advances it. Tokens minted inside use the pinned clock. */
async function withClock(run: (tick: (ms: number) => void, now: () => number) => Promise<void>) {
  const realNow = Date.now;
  let clock = (Math.floor(realNow() / WINDOW_MS) + 2) * WINDOW_MS + 1_000;
  Date.now = () => clock;
  try {
    await run(
      (ms) => {
        clock += ms;
      },
      () => clock,
    );
  } finally {
    Date.now = realNow;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The venue keeps working while one co-tenant guesses.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "NAT: one co-tenant's 30 distinct guesses never gate a peer — cached read, uncached re-verification, sign-in and its first read, refresh and its first read are all 200; the guesser's replays are 429 before Auth",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(TEST_USER_ID)];
    const ip = freshIp();
    respondWith(h, (call) =>
      isIdTokenCall(call) || isRefreshCall(call) ? mintedSession(OTHER_USER_ID) : null,
    );

    // A peer verified BEFORE the guessing starts (cached in this isolate).
    const cachedPeer = fakeSupabaseAccessToken(TEST_USER_ID);
    assertEquals((await readMe(h.handler, ip, cachedPeer)).status, 200, "peer verified");

    const forged = await stuffEgress(h, ip);

    // Cached peer: served without Auth.
    let mark = h.calls.length;
    assertEquals((await readMe(h.handler, ip, cachedPeer)).status, 200, "cached peer still reads");
    assertEquals(authCallsSince(h, mark).length, 0, "served from the auth cache");

    // Uncached peer (another isolate verified it, or its cache entry expired):
    // Auth judges it and it is served.
    const uncachedPeer = fakeSupabaseAccessToken(TEST_USER_ID);
    mark = h.calls.length;
    assertEquals((await readMe(h.handler, ip, uncachedPeer)).status, 200, "uncached peer reads");
    assertEquals(authCallsSince(h, mark).filter(isUserCall).length, 1, "verified with Auth");

    // Sign-in: bootstrap 200 AND the first read with the session it minted.
    const signIn = await bootstrapJson(h.handler, ip, fakeGoogleIdToken(OTHER_USER_ID));
    assertEquals(signIn.status, 200, "peer signs in");
    const minted = sessionOf(signIn.body);
    assert(minted.accessToken && minted.refreshToken, "bootstrap returned a session");
    assertEquals(
      (await readMe(h.handler, ip, minted.accessToken)).status,
      200,
      "first read with the just-minted access token",
    );

    // Rotation: refresh 200 AND the first read with the rotated access token.
    const rotated = await refreshJson(h.handler, ip, minted.refreshToken);
    assertEquals(rotated.status, 200, "peer rotates its session");
    const rotatedSession = sessionOf(rotated.body);
    assertNotEquals(rotatedSession.accessToken, minted.accessToken, "a new access token");
    assertEquals(
      (await readMe(h.handler, ip, rotatedSession.accessToken)).status,
      200,
      "first read with the rotated access token",
    );

    // The guesser: every replay of a refused credential is 429 before Auth …
    mark = h.calls.length;
    for (const bearer of forged) {
      assertBudget429(await readMe(h.handler, ip, bearer), "replay of a refused guess");
    }
    assertEquals(authCallsSince(h, mark).length, 0, "replays never reach Auth");
    // … while a never-seen credential is still judged (a valid peer's first
    // request is indistinguishable from it until Auth answers).
    const novel = supabaseBearer("forged-novel");
    respondWith(h, (call) => (isUserCall(call) && bearerOfCall(call) === novel ? badJwt() : null));
    mark = h.calls.length;
    assertEquals(
      (await readMe(h.handler, ip, novel)).status,
      401,
      "a 31st distinct guess is judged",
    );
    assertEquals(authCallsSince(h, mark).length, 1);
    assertEquals(await egressCharged(ip), LIMIT + 1, "and counted once");
    assertBudget429(await readMe(h.handler, ip, novel), "its first replay is 429");

    // None of the peers' credentials were charged.
    assertEquals(await egressCharged(ip), LIMIT + 1, "peers charged nothing");
  },
);

Deno.test(
  "NAT: sustained 30 distinct guesses per window from one handset — once a peer's auth-cache entry expires (10 min) its valid token re-verifies with Auth and reads",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(TEST_USER_ID)];
    const ip = freshIp();
    await withClock(async (tick) => {
      const peer = fakeSupabaseAccessToken(TEST_USER_ID);
      assertEquals((await readMe(h.handler, ip, peer)).status, 200, "peer verified at t0");

      // Three consecutive windows of stuffing (6 req/min — far under IP_LIMIT).
      for (let window = 0; window < 3; window += 1) {
        await stuffEgress(h, ip);
        tick((AUTH_CACHE_MAX_TTL_SECONDS + 1) * 1_000);
      }
      // 30 minutes later, well past the cache TTL: re-verification is judged
      // by Auth (a 200 costs the attacker nothing) and served.
      await stuffEgress(h, ip);
      const mark = h.calls.length;
      const response = await readMe(h.handler, ip, peer);
      assertEquals(response.status, 200, "expired cache entry re-verifies under stuffing");
      assertEquals(authCallsSince(h, mark).filter(isUserCall).length, 1, "verified with Auth");
      assertEquals((await readMe(h.handler, ip, peer)).status, 200, "and is cached again");
    });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// 2. Classification: local refusals charge nothing.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "local refusals never reach Auth and charge nothing: no bearer, junk, wrong issuer, expired session token, malformed refresh body, junk bootstrap — 30+ of each, then the peer signs in, refreshes and reads",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(TEST_USER_ID)];
    const ip = freshIp();
    respondWith(h, (call) =>
      isIdTokenCall(call) || isRefreshCall(call) ? mintedSession(OTHER_USER_ID) : null,
    );
    const mark = h.calls.length;

    const noBearer = () =>
      send(
        h.handler,
        new Request("http://edge.test/functions/v1/api/v1/me", {
          headers: { "x-forwarded-for": ip },
        }),
      );
    const expired = supabaseBearer("expired", Math.floor(Date.now() / 1000) - 60);
    const wrongIssuer = jwtOf({
      iss: "https://evil.example",
      sub: TEST_USER_ID,
      exp: 4_102_444_800,
    });
    const local: Array<[string, () => Promise<Response>]> = [
      ["no bearer", noBearer],
      ["junk bearer", () => readMe(h.handler, ip, "not-a-token")],
      ["wrong issuer", () => readMe(h.handler, ip, wrongIssuer)],
      ["expired session token", () => readMe(h.handler, ip, expired)],
      [
        "expired provider token on bootstrap",
        () =>
          postBootstrap(
            h.handler,
            ip,
            googleIdToken(OTHER_USER_ID, Math.floor(Date.now() / 1000) - 60),
          ),
      ],
      [
        "session token on bootstrap",
        () => postBootstrap(h.handler, ip, fakeSupabaseAccessToken(OTHER_USER_ID)),
      ],
    ];
    for (const [label, run] of local) {
      const statuses = await repeat(8, run);
      assert(allEqual(statuses, 401), `${label}: ${statuses.join(",")}`);
    }
    // Refresh bodies that never name a credential are 400 and charge nothing.
    for (const body of [{}, { refreshToken: "" }, { refreshToken: 7 }, "not json"]) {
      const statuses = await repeat(4, () => send(h.handler, refreshRequest(ip, body)));
      assert(allEqual(statuses, 400), `malformed refresh body: ${statuses.join(",")}`);
    }
    assertEquals(authCallsSince(h, mark).length, 0, "nothing reached Auth");
    assertEquals(await egressCharged(ip), 0, "nothing was charged");

    // The peer behind the same egress is untouched: sign in, read, rotate, read.
    const signIn = await bootstrapJson(h.handler, ip, fakeGoogleIdToken(OTHER_USER_ID));
    assertEquals(signIn.status, 200, "peer signs in");
    const minted = sessionOf(signIn.body);
    assertEquals((await readMe(h.handler, ip, minted.accessToken)).status, 200, "peer reads");
    const rotated = await refreshJson(h.handler, ip, minted.refreshToken);
    assertEquals(rotated.status, 200, "peer rotates");
    assertEquals(
      (await readMe(h.handler, ip, sessionOf(rotated.body).accessToken)).status,
      200,
      "peer reads with the rotated token",
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// 3. Classification: liveness refusals charge their own shard only.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "liveness refusals (dead session, banned account, already-rotated refresh token) charge only the dead credential's shard: 30 × 401, the 31st replay 429 before Auth, the egress signal stays 0 and peers are served",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(TEST_USER_ID)];
    const ip = freshIp();
    const dead = fakeSupabaseAccessToken(TEST_USER_ID);
    const deadRefresh = `rt-${crypto.randomUUID()}`;
    const bannedId = googleIdToken(OTHER_USER_ID);
    respondWith(h, (call) => {
      if (isUserCall(call) && bearerOfCall(call) === dead) return sessionNotFound();
      if (isRefreshCall(call) && bodyField(call, "refresh_token") === deadRefresh) {
        return refreshTokenAlreadyUsed();
      }
      if (isIdTokenCall(call) && bodyField(call, "id_token") === bannedId) return userBanned();
      if (isIdTokenCall(call) || isRefreshCall(call)) return mintedSession(OTHER_USER_ID);
      return null;
    });

    await withClock(async (tick) => {
      // A signed-out handset retrying its dead session token.
      let mark = h.calls.length;
      assert(allEqual(await repeat(LIMIT, () => readMe(h.handler, ip, dead)), 401));
      assertEquals(authCallsSince(h, mark).length, LIMIT, "each retry was judged by Auth");
      mark = h.calls.length;
      assertBudget429(await readMe(h.handler, ip, dead), "31st replay of the dead session");
      assertEquals(authCallsSince(h, mark).length, 0, "refused before Auth");

      // Its already-rotated refresh token (30/min route budget: spread over
      // two route windows inside one auth-failure window).
      assert(allEqual(await repeat(LIMIT, () => postRefresh(h.handler, ip, deadRefresh)), 401));
      tick(AUTH_ROUTE_WINDOW_MS);
      mark = h.calls.length;
      const retryAfter = assertBudget429(
        await postRefresh(h.handler, ip, deadRefresh),
        "31st replay of the dead refresh token",
      );
      assert(retryAfter > AUTH_ROUTE_WINDOW_MS / 1_000, "the auth-failure budget, not the route's");
      assertEquals(authCallsSince(h, mark).length, 0, "refused before Auth");

      // A banned account signing in.
      assert(allEqual(await repeat(LIMIT, () => postBootstrap(h.handler, ip, bannedId)), 401));
      tick(AUTH_ROUTE_WINDOW_MS);
      assertBudget429(await postBootstrap(h.handler, ip, bannedId), "31st banned sign-in");

      assertEquals(await egressCharged(ip), 0, "liveness refusals are not stuffing");

      // Peers: uncached read, sign-in + read, refresh + read — all judged, all 200.
      assertEquals(
        (await readMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID))).status,
        200,
      );
      const signIn = await bootstrapJson(h.handler, ip, fakeGoogleIdToken(OTHER_USER_ID));
      assertEquals(signIn.status, 200);
      const minted = sessionOf(signIn.body);
      assertEquals((await readMe(h.handler, ip, minted.accessToken)).status, 200);
      const rotated = await refreshJson(h.handler, ip, minted.refreshToken);
      assertEquals(rotated.status, 200);
      assertEquals((await readMe(h.handler, ip, sessionOf(rotated.body).accessToken)).status, 200);
    });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// 4. Classification: credential refusals — per-credential shards + egress signal.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "credential refusals: one forged bearer replayed is its own shard (30 × 401 then 429), a second forged bearer is judged, the egress signal counts DISTINCT guesses, and the 429 leaks neither classification nor digest",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(TEST_USER_ID)];
    const ip = freshIp();
    const forgedA = supabaseBearer("A");
    const forgedB = supabaseBearer("B");
    respondWith(h, (call) =>
      isUserCall(call) && [forgedA, forgedB].includes(bearerOfCall(call)) ? badJwt() : null,
    );

    let mark = h.calls.length;
    assert(allEqual(await repeat(LIMIT, () => readMe(h.handler, ip, forgedA)), 401));
    assertEquals(authCallsSince(h, mark).length, LIMIT, "each presentation judged (not stuffing)");
    assertEquals(await egressCharged(ip), 1, "one distinct credential");

    mark = h.calls.length;
    const limited = await h.handler(userRequest("GET", "/v1/me", { token: forgedA, ip }));
    assertBudget429(limited, "31st presentation of forged A");
    assertEquals(authCallsSince(h, mark).length, 0, "refused before Auth");
    const text = await limited.text();
    assertEquals(JSON.parse(text), {
      error: {
        code: "rate_limited",
        message: "Too many requests. Please slow down and try again shortly.",
      },
    });
    assertEquals(
      [...limited.headers.keys()].sort(),
      [
        "cache-control",
        "content-type",
        "ratelimit-limit",
        "ratelimit-remaining",
        "retry-after",
        "x-content-type-options",
      ],
      "no classification or digest header",
    );
    assert(!/[0-9a-f]{32,}/i.test([...limited.headers.values()].join(" ") + text), "no digest");

    mark = h.calls.length;
    assertEquals((await readMe(h.handler, ip, forgedB)).status, 401, "forged B is judged");
    assertEquals(authCallsSince(h, mark).length, 1);
    assertEquals(await egressCharged(ip), 2, "two distinct credentials");

    // A valid peer between the guesses: judged, served, not charged.
    const peer = fakeSupabaseAccessToken(TEST_USER_ID);
    assertEquals((await readMe(h.handler, ip, peer)).status, 200);
    assertEquals(await egressCharged(ip), 2);

    // Under stuffing, forged B's FIRST replay is 429 (its shard was refused
    // once and the egress signal is saturated); the peer keeps reading.
    await stuffEgress(h, ip);
    mark = h.calls.length;
    assertBudget429(await readMe(h.handler, ip, forgedB), "replay under stuffing");
    assertEquals(authCallsSince(h, mark).length, 0);
    assertEquals((await readMe(h.handler, ip, peer)).status, 200);
  },
);

Deno.test(
  "windows roll over: after the 5-minute window a refused credential is judged again and the egress signal starts from zero; a bad-ID-token sign-in is a credential refusal",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(TEST_USER_ID)];
    const ip = freshIp();
    await withClock(async (tick) => {
      const guessId = googleIdToken("nobody");
      respondWith(h, (call) => {
        if (isIdTokenCall(call) && bodyField(call, "id_token") === guessId) return badIdToken();
        if (isIdTokenCall(call)) return mintedSession(OTHER_USER_ID);
        return null;
      });
      const forged = await stuffEgress(h, ip);
      assertEquals(
        (await postBootstrap(h.handler, ip, guessId)).status,
        401,
        "judged: bad_id_token",
      );
      assertEquals(await egressCharged(ip), LIMIT + 1, "a credential refusal");
      tick(AUTH_ROUTE_WINDOW_MS);
      assertBudget429(await postBootstrap(h.handler, ip, guessId), "its replay under stuffing");
      const [first] = forged;
      assertBudget429(await readMe(h.handler, ip, first), "a forged bearer's replay");

      tick(WINDOW_MS);
      assertEquals(await egressCharged(ip), 0, "fresh window");
      let mark = h.calls.length;
      assertEquals((await readMe(h.handler, ip, first)).status, 401, "judged again");
      assertEquals(authCallsSince(h, mark).length, 1);
      mark = h.calls.length;
      assertEquals((await postBootstrap(h.handler, ip, guessId)).status, 401, "judged again");
      assertEquals(authCallsSince(h, mark).length, 1);
      assertEquals(await egressCharged(ip), 2);
      // And the peer signs in as ever.
      assertEquals(
        (await postBootstrap(h.handler, ip, fakeGoogleIdToken(OTHER_USER_ID))).status,
        200,
      );
    });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// 5. Refresh: the token in the body is the judged credential.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "refresh: the refresh token in the body is the judged credential — 30 refused rotations of one unknown token 429 its 31st before Auth, whitespace padding is the same credential, the bearer header is never charged, and a peer's live refresh rotates",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(TEST_USER_ID)];
    const ip = freshIp();
    const unknown = `rt-${crypto.randomUUID()}`;
    respondWith(h, (call) => {
      if (isRefreshCall(call) && bodyField(call, "refresh_token") === unknown) {
        return refreshTokenNotFound();
      }
      if (isRefreshCall(call)) return mintedSession(OTHER_USER_ID);
      return null;
    });
    await withClock(async (tick) => {
      // The peer's own valid bearer rides along in the Authorization header of
      // the guesser's refreshes (as the app sends it) — it must not be charged.
      const peer = fakeSupabaseAccessToken(TEST_USER_ID);
      assertEquals((await readMe(h.handler, ip, peer)).status, 200);

      let mark = h.calls.length;
      const statuses: number[] = [];
      for (let i = 0; i < LIMIT; i += 1) {
        const padded = i % 2 === 0 ? unknown : `  ${unknown}\n`;
        statuses.push((await postRefresh(h.handler, ip, padded, peer)).status);
      }
      assert(allEqual(statuses, 401), `refused rotations: ${statuses.join(",")}`);
      assertEquals(authCallsSince(h, mark).length, LIMIT, "each judged by Auth");
      assertEquals(await egressCharged(ip), 1, "one distinct credential, padding and all");

      tick(AUTH_ROUTE_WINDOW_MS);
      mark = h.calls.length;
      const retryAfter = assertBudget429(
        await postRefresh(h.handler, ip, unknown, peer),
        "31st rotation of the unknown token",
      );
      assert(retryAfter > AUTH_ROUTE_WINDOW_MS / 1_000, "the auth-failure budget, not the route's");
      assertEquals(authCallsSince(h, mark).length, 0, "refused before Auth");

      // The bearer that rode along still reads (cached and, once evicted, judged).
      assertEquals((await readMe(h.handler, ip, peer)).status, 200);
      tick((AUTH_CACHE_MAX_TTL_SECONDS + 1) * 1_000);
      mark = h.calls.length;
      assertEquals((await readMe(h.handler, ip, peer)).status, 200, "re-verified");
      assertEquals(authCallsSince(h, mark).filter(isUserCall).length, 1);

      // A peer's live refresh token from the same egress rotates, and the
      // rotated access token reads.
      const rotated = await refreshJson(h.handler, ip, `rt-${crypto.randomUUID()}`);
      assertEquals(rotated.status, 200, "peer rotates");
      assertEquals((await readMe(h.handler, ip, sessionOf(rotated.body).accessToken)).status, 200);
    });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// 6. Concurrency: racing guesses never under-count, racing peers never wait.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "concurrency: 60 distinct guesses racing 6 peers (cached, uncached, signing in, rotating) — every peer 200, every guess 401, the egress signal is exactly 60",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(TEST_USER_ID)];
    const ip = freshIp();
    const forged = new Set(Array.from({ length: 60 }, (_, i) => supabaseBearer(`race-${i}`)));
    respondWith(h, (call) => {
      if (isUserCall(call) && forged.has(bearerOfCall(call))) return badJwt();
      if (isIdTokenCall(call) || isRefreshCall(call)) return mintedSession(OTHER_USER_ID);
      return null;
    });
    const cached = fakeSupabaseAccessToken(TEST_USER_ID);
    assertEquals((await readMe(h.handler, ip, cached)).status, 200);

    const guesses = [...forged].map((bearer) => readMe(h.handler, ip, bearer));
    const peers = [
      readMe(h.handler, ip, cached),
      readMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID)),
      readMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID)),
      bootstrapJson(h.handler, ip, fakeGoogleIdToken(OTHER_USER_ID)).then((r) => r.status),
      refreshJson(h.handler, ip, `rt-${crypto.randomUUID()}`).then((r) => r.status),
      readMe(h.handler, ip, cached),
    ];
    const [guessResponses, peerStatuses] = await Promise.all([
      Promise.all(guesses),
      Promise.all(peers),
    ]);
    assert(
      allEqual(
        guessResponses.map((r) => r.status),
        401,
      ),
      `guesses: ${guessResponses.map((r) => r.status).join(",")}`,
    );
    const statuses = peerStatuses.map((p) => (typeof p === "number" ? p : p.status));
    assert(allEqual(statuses, 200), `peers: ${statuses.join(",")}`);
    assertEquals(await egressCharged(ip), 60, "one hit per distinct guess, none lost");
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// 7. rateLimit.ts primitives (fresh module instance per test).
// ═════════════════════════════════════════════════════════════════════════════

const BUDGET = { limit: 30, windowSeconds: 300 };

Deno.test(
  "authRefusalKind: GoTrue bodies and supabase-js AuthError shapes classify liveness vs credential",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const { authRefusalKind } = rateLimit;
    // Liveness: a real credential that is dead.
    for (const code of [
      "session_not_found",
      "session_expired",
      "user_not_found",
      "user_banned",
      "refresh_token_already_used",
    ]) {
      assertEquals(authRefusalKind({ code: 403, error_code: code, msg: "x" }), "liveness", code);
      assertEquals(
        authRefusalKind({ code, message: "x", status: 403 }),
        "liveness",
        `AuthError ${code}`,
      );
    }
    for (const msg of [
      "invalid JWT: session not found",
      "Session from session_id claim in JWT does not exist",
      "User from sub claim in JWT does not exist",
      "invalid JWT: unable to parse or verify signature, token is expired by 12s",
      "Invalid Refresh Token: Already Used",
    ]) {
      assertEquals(authRefusalKind({ code: 403, msg }), "liveness", msg);
      assertEquals(
        authRefusalKind({ error: "invalid_grant", error_description: msg }),
        "liveness",
        msg,
      );
      // A message that only a correctly signed token can produce outranks the
      // generic bad_jwt code GoTrue attaches to every JWT refusal.
      assertEquals(authRefusalKind({ code: 403, error_code: "bad_jwt", msg }), "liveness", msg);
    }
    // Credential: a guess — including anything unrecognised.
    for (const body of [
      { code: 403, error_code: "bad_jwt", msg: "invalid JWT: token signature is invalid" },
      { error: "invalid_grant", error_description: "Bad ID token", error_code: "bad_id_token" },
      { error: "invalid_grant", error_code: "refresh_token_not_found" },
      { code: "bad_jwt", message: "invalid JWT", status: 403 },
      { error_code: "validation_failed" },
      {},
      null,
      "not json",
      42,
      [],
    ]) {
      assertEquals(authRefusalKind(body), "credential", JSON.stringify(body));
    }
  },
);

Deno.test(
  "authFailureIdentity: a SHA-256 digest of the trimmed credential, null for none",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const { authFailureIdentity } = rateLimit;
    assertEquals(await authFailureIdentity(null), null);
    assertEquals(await authFailureIdentity(undefined), null);
    assertEquals(await authFailureIdentity(""), null);
    assertEquals(await authFailureIdentity("   "), null);
    const a = await authFailureIdentity("credential-a");
    assert(a && /^[0-9a-f]{64}$/.test(a), "hex digest");
    assertEquals(
      await authFailureIdentity("  credential-a\n"),
      a,
      "padding is the same credential",
    );
    assertNotEquals(await authFailureIdentity("credential-b"), a);
    assert(!a.includes("credential"), "opaque");
  },
);

Deno.test(
  "primitives: shards are per ip+credential, liveness never raises the egress signal, credential raises it once per distinct credential",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const { peekAuthFailureBudget, chargeAuthFailure, peekRateLimit } = rateLimit;
    const ip = "198.51.100.7";
    const signal = async () =>
      spent(await peekRateLimit("authfail", ip, EXACT, BUDGET.windowSeconds));

    // No credential: nothing to shard, always allowed, nothing charged.
    assertEquals((await peekAuthFailureBudget(ip, null, BUDGET)).allowed, true);
    await chargeAuthFailure(ip, null, { kind: "credential" }, BUDGET);
    await chargeAuthFailure(ip, "x", { kind: "local" }, BUDGET);
    assertEquals(await signal(), 0);
    assertEquals((await peekAuthFailureBudget(ip, "x", BUDGET)).allowed, true);

    // Liveness: shard only.
    for (let i = 0; i < BUDGET.limit; i += 1) {
      assertEquals((await peekAuthFailureBudget(ip, "dead", BUDGET)).allowed, true, `dead #${i}`);
      await chargeAuthFailure(ip, "dead", { kind: "liveness" }, BUDGET);
    }
    const exhausted = await peekAuthFailureBudget(ip, "dead", BUDGET);
    assertEquals(exhausted.allowed, false);
    assertEquals(exhausted.remaining, 0);
    assert(exhausted.retryAfterSeconds >= 1 && exhausted.retryAfterSeconds <= BUDGET.windowSeconds);
    assertEquals(await signal(), 0, "liveness is not stuffing");
    assertEquals((await peekAuthFailureBudget(ip, "other", BUDGET)).allowed, true);
    assertEquals(
      (await peekAuthFailureBudget("198.51.100.8", "dead", BUDGET)).allowed,
      true,
      "per ip",
    );

    // Credential: shard + signal once per distinct credential.
    for (let i = 0; i < 5; i += 1)
      await chargeAuthFailure(ip, "guess-1", { kind: "credential" }, BUDGET);
    assertEquals(await signal(), 1);
    for (let i = 2; i <= BUDGET.limit; i += 1) {
      await chargeAuthFailure(ip, `guess-${i}`, { kind: "credential" }, BUDGET);
    }
    assertEquals(await signal(), BUDGET.limit, "under stuffing");
    // Refused credentials are gated on their first replay; unseen ones are not.
    assertEquals((await peekAuthFailureBudget(ip, "guess-2", BUDGET)).allowed, false);
    assertEquals((await peekAuthFailureBudget(ip, "guess-1", BUDGET)).allowed, false);
    assertEquals((await peekAuthFailureBudget(ip, "never-refused", BUDGET)).allowed, true);
    assertEquals((await peekAuthFailureBudget(ip, "dead", BUDGET)).allowed, false);
    // The refusal may name another credential than the presented bearer
    // (refresh judges the token in its body), or none.
    await chargeAuthFailure(ip, "bearer", { kind: "credential", identity: "body-token" }, BUDGET);
    assertEquals(
      (await peekAuthFailureBudget(ip, "bearer", BUDGET)).allowed,
      true,
      "bearer untouched",
    );
    assertEquals((await peekAuthFailureBudget(ip, "body-token", BUDGET)).allowed, false);
    await chargeAuthFailure(ip, "bearer-2", { kind: "credential", identity: null }, BUDGET);
    assertEquals((await peekAuthFailureBudget(ip, "bearer-2", BUDGET)).allowed, true);
    assertEquals(await signal(), BUDGET.limit + 1);
  },
);

Deno.test(
  "primitives: a flood of distinct credentials cannot fill the store against bystanders — shards fail OPEN when full while server-keyed windows still fail closed",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const { peekAuthFailureBudget, chargeAuthFailure, enforceRateLimit, peekRateLimit } = rateLimit;
    const ip = "198.51.100.9";
    // Way past MEMORY_WINDOW_MAX (20_000) distinct shards.
    for (let i = 0; i < 20_050; i += 1) {
      await chargeAuthFailure(ip, `flood-${i}`, { kind: "credential" }, BUDGET);
    }
    // A bystander's never-seen credential is admitted; so is a fresh guess.
    assertEquals((await peekAuthFailureBudget(ip, "bystander", BUDGET)).allowed, true);
    assertEquals((await peekAuthFailureBudget("198.51.100.10", "peer", BUDGET)).allowed, true);
    // Shards that were admitted still enforce.
    assertEquals(
      (await peekAuthFailureBudget(ip, "flood-0", BUDGET)).allowed,
      false,
      "under stuffing",
    );
    // The shard flood did not consume the server-keyed store: the ip window and
    // egress signal still count, and a plain rate limit still enforces.
    assert((await peekRateLimit("authfail", ip, EXACT, BUDGET.windowSeconds)).remaining < EXACT);
    for (let i = 0; i < 3; i += 1) await enforceRateLimit("probe", ip, 2, 60);
    assertEquals(
      (await enforceRateLimit("probe", ip, 2, 60)).allowed,
      false,
      "server keys fail closed",
    );
  },
);

Deno.test(
  "primitives: with Redis, shards and the egress signal are shared across isolates; a Redis outage fails open for bystanders",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const a = (await loadIsolate()).rateLimit;
      const b = (await loadIsolate()).rateLimit;
      const ip = "198.51.100.11";
      for (let i = 0; i < BUDGET.limit; i += 1) {
        await a.chargeAuthFailure(ip, `guess-${i}`, { kind: "credential" }, BUDGET);
      }
      assertEquals(
        spent(await b.peekRateLimit("authfail", ip, EXACT, BUDGET.windowSeconds)),
        BUDGET.limit,
        "signal visible from the other isolate",
      );
      assertEquals(
        (await b.peekAuthFailureBudget(ip, "guess-3", BUDGET)).allowed,
        false,
        "shard shared",
      );
      assertEquals((await b.peekAuthFailureBudget(ip, "peer", BUDGET)).allowed, true);

      // Outage: charges fall back to memory, peeks fail open for what memory
      // has not seen, and a replayed credential is still tracked in memory.
      redis.failStatus = 503;
      assertEquals(
        (await b.peekAuthFailureBudget(ip, "guess-3", BUDGET)).allowed,
        true,
        "fail open",
      );
      for (let i = 0; i < BUDGET.limit; i += 1) {
        await b.chargeAuthFailure(ip, "outage-guess", { kind: "credential" }, BUDGET);
      }
      assertEquals((await b.peekAuthFailureBudget(ip, "outage-guess", BUDGET)).allowed, false);
      assertEquals((await b.peekAuthFailureBudget(ip, "peer", BUDGET)).allowed, true);
    } finally {
      redis.restore();
      configureRedis(false);
    }
  },
);

Deno.test(
  "primitives: refusal tags ride the Response in-process only — nothing on the wire, untagged refusals are guesses",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const { authRefusal, authRefusalOf } = rateLimit;
    const body = JSON.stringify({ error: { code: "unauthorized", message: "nope" } });
    const response = new Response(body, {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
    const tagged = authRefusal(response, { kind: "liveness", identity: "abc" });
    assert(tagged === response, "same object");
    assertEquals(authRefusalOf(response), { kind: "liveness", identity: "abc" });
    assertEquals([...response.headers.keys()], ["content-type"]);
    assertEquals(await response.text(), body);
    assertEquals(authRefusalOf(new Response(null, { status: 401 })), { kind: "credential" });
    const local = authRefusal(new Response(null, { status: 401 }), { kind: "local" });
    assertEquals(authRefusalOf(local), { kind: "local" });
  },
);
