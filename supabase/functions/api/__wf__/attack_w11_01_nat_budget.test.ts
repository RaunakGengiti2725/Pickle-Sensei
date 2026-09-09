// W11-01 ADVERSARY — attacks on the sharded auth-failure budget behind a NAT
// egress (candidate b133e4cbeebaecfff0de13babf66a7d1669efd00).
//
// Every test below asserts the behaviour a valid peer behind a shared egress
// is entitled to; a FAILING test is a confirmed break of the candidate and is
// reported with observed/expected in the adversary report. Tests that pass
// are attacks the candidate survived (they are still listed in attacks_tried).
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json attack_w11_01_nat_budget.test.ts

import { assert, assertEquals } from "@std/assert";
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

/** Mirrors AUTH_FAILURE_LIMIT / AUTH_REFRESH_LIMIT / AUTH_BOOTSTRAP_LIMIT in index.ts. */
const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
const AUTH_ROUTE_LIMIT = { limit: 30, windowSeconds: 60 };
/** Mirrors AUTH_CACHE_MAX_TTL_SECONDS in index.ts. */
const AUTH_CACHE_MAX_TTL_SECONDS = 600;
const LIMIT = AUTH_FAILURE_LIMIT.limit;
const WINDOW_MS = AUTH_FAILURE_LIMIT.windowSeconds * 1_000;

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

/** GoTrue's refusal of a REAL, correctly signed access token whose `exp` has
 * passed by the time Auth checks it (edge/Auth clock skew, or a token that
 * expired in flight). */
const tokenExpiredAtAuth = (seconds: number) =>
  jsonResponse(403, {
    code: 403,
    error_code: "bad_jwt",
    msg: `invalid JWT: unable to parse or verify signature, token is expired by ${seconds}s`,
  });

const userBanned = () =>
  jsonResponse(403, { code: 403, error_code: "user_banned", msg: "User is banned" });

const userGone = () =>
  jsonResponse(403, {
    code: 403,
    error_code: "user_not_found",
    msg: "User from sub claim in JWT does not exist",
  });

/** A freshly minted Supabase session, shaped like GoTrue's `/token` answer,
 * whose access token is a real Supabase-issued JWT the edge will accept. */
const mintedSession = (sub: string) => {
  const accessToken = fakeSupabaseAccessToken(sub);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  return jsonResponse(200, {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
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
const bodyField = (call: RecordedCall, field: string): string => {
  const body = call.body;
  if (typeof body !== "object" || body === null) return "";
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
};

let ipCounter = 0;
/** Unique egress per test (own /16 so no other suite's windows collide). */
const freshIp = () => `10.62.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

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

const sessionAccessToken = (body: Record<string, unknown>): string => {
  const session = body.session;
  if (typeof session !== "object" || session === null) return "";
  const token = (session as Record<string, unknown>).accessToken;
  return typeof token === "string" ? token : "";
};

const repeat = async (times: number, run: () => Promise<Response>): Promise<number[]> => {
  const statuses: number[] = [];
  for (let i = 0; i < times; i += 1) statuses.push((await run()).status);
  return statuses;
};

const allEqual = (statuses: number[], expected: number) =>
  statuses.every((status) => status === expected);

/** Put the egress under stuffing exactly the way the candidate defines it: one
 * handset presents `LIMIT` DISTINCT forged session bearers, each judged and
 * refused by Auth. Returns the forged set so responders can keep refusing them. */
async function stuffEgress(h: Awaited<ReturnType<typeof loadHarness>>, ip: string) {
  const forged = new Set(Array.from({ length: LIMIT }, (_, i) => supabaseBearer(`forged-${i}`)));
  const previous = h.respond;
  h.respond = async (call) => {
    if (isUserCall(call) && forged.has(bearerOfCall(call))) return credentialRefused();
    return await previous(call);
  };
  const statuses: number[] = [];
  for (const bearer of forged) statuses.push((await readMe(h.handler, ip, bearer)).status);
  assert(allEqual(statuses, 401), `every guess is refused by Auth: ${statuses.join(",")}`);
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
// ATTACK 1 — sign-in lockout. One handset's 30 guesses; a peer then signs in
// (bootstrap 200) and immediately reads with the session the edge just minted.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 1: after one co-tenant's 30 distinct guesses, a peer's brand-new sign-in session (bootstrap 200) must be able to read",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(OTHER_USER_ID)];
    const ip = freshIp();
    h.respond = (call) => (isIdTokenCall(call) ? mintedSession(OTHER_USER_ID) : null);
    await stuffEgress(h, ip);

    const signIn = await sendJson(
      h.handler,
      userRequest("POST", "/v1/account/bootstrap", {
        token: fakeGoogleIdToken(OTHER_USER_ID),
        ip,
        body: {},
      }),
    );
    assertEquals(signIn.status, 200, "the sign-in itself is served (the candidate pins this)");
    const minted = sessionAccessToken(signIn.body);
    assert(minted.length > 0, "bootstrap returned a session access token");

    const upstreamBefore = h.calls.filter(isUserCall).length;
    const firstRead = await readMe(h.handler, ip, minted);
    assertEquals(
      firstRead.status,
      200,
      `the session the edge minted seconds ago is VALID — its first read must not be 429 ` +
        `(Retry-After=${firstRead.headers.get("Retry-After")}, reached Auth: ${
          h.calls.filter(isUserCall).length - upstreamBefore
        })`,
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 2 — rotation lockout. A verified, cached peer rotates its session
// (refresh 200, as sessionKeeper does hourly) and reads with the new token.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 2: a verified peer that rotates its session (refresh 200) under a co-tenant's stuffing must be able to read with the new access token",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const before = fakeSupabaseAccessToken(TEST_USER_ID);
    assertEquals((await readMe(h.handler, ip, before)).status, 200, "peer verified and cached");
    h.respond = (call) => (isRefreshCall(call) ? mintedSession(TEST_USER_ID) : null);
    await stuffEgress(h, ip);

    assertEquals((await readMe(h.handler, ip, before)).status, 200, "cached read still served");
    const rotated = await sendJson(h.handler, refreshRequest(ip, { refreshToken: `rt-${ip}` }));
    assertEquals(rotated.status, 200, "the live refresh token rotates (the candidate pins this)");
    const after = sessionAccessToken(rotated.body);
    assert(after.length > 0 && after !== before, "a NEW access token was issued");

    const read = await readMe(h.handler, ip, after);
    assertEquals(
      read.status,
      200,
      `the rotated access token of a verified peer must be served, not 429 for ` +
        `Retry-After=${read.headers.get("Retry-After")}s`,
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 3 — sustained low-rate stuffing. 30 guesses per 5-minute window
// (6 req/min, far under IP_LIMIT) from ONE handset; once the auth cache TTL
// (10 min) elapses every peer must re-verify, and re-verification is what the
// stuffing gate refuses. The whole venue goes dark.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 3: one handset sustaining 30 guesses per window must not take an already-verified peer offline once its cache entry expires",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    await withClock(async (tick) => {
      const peer = fakeSupabaseAccessToken(TEST_USER_ID);
      assertEquals((await readMe(h.handler, ip, peer)).status, 200, "peer verified at t0");
      let attackerRequests = 0;
      for (let window = 0; window < 3; window += 1) {
        const forged = new Set(
          Array.from({ length: LIMIT }, (_, i) => supabaseBearer(`w${window}-${i}`)),
        );
        h.respond = (call) =>
          isUserCall(call) && forged.has(bearerOfCall(call)) ? credentialRefused() : null;
        for (const bearer of forged) {
          assertEquals((await readMe(h.handler, ip, bearer)).status, 401);
          attackerRequests += 1;
        }
        assertEquals(await egressCharged(ip), LIMIT, `window ${window} is under stuffing`);
        if (window < 2) tick(WINDOW_MS);
      }
      // t0 + 10 min + 1 s: the peer's cache entry (≤ AUTH_CACHE_MAX_TTL_SECONDS) is gone.
      tick(1_000);
      h.respond = () => null;
      assert(attackerRequests === 3 * LIMIT, `attacker spent ${attackerRequests} requests`);
      const upstreamBefore = h.calls.filter(isUserCall).length;
      const read = await readMe(h.handler, ip, peer);
      assertEquals(
        read.status,
        200,
        `a peer verified ${AUTH_CACHE_MAX_TTL_SECONDS}s ago holding a VALID session must be ` +
          `re-verified and served, not 429 (Retry-After=${read.headers.get("Retry-After")}, ` +
          `reached Auth: ${h.calls.filter(isUserCall).length - upstreamBefore}) — ` +
          `${attackerRequests} requests from one handset took the venue offline`,
      );
    });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 4 — liveness classification gaps. Real credentials Auth refuses as
// dead must charge their own shard only, never the venue's stuffing signal.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 4a: 30 peers whose REAL access tokens expired in flight (Auth: bad_jwt 'token is expired') must not put the venue under stuffing",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    // Each peer's own token: correctly signed, `exp` still 2 s in the future
    // by the edge clock, judged expired by Auth (skew / in-flight expiry).
    const expiring = new Set(
      Array.from({ length: LIMIT }, (_, i) =>
        supabaseBearer(`expiring-${i}`, Math.floor(Date.now() / 1000) + 2),
      ),
    );
    h.respond = (call) =>
      isUserCall(call) && expiring.has(bearerOfCall(call)) ? tokenExpiredAtAuth(3) : null;
    const statuses: number[] = [];
    for (const bearer of expiring) statuses.push((await readMe(h.handler, ip, bearer)).status);
    assert(allEqual(statuses, 401), `each expired token is refused: ${statuses.join(",")}`);
    assertEquals(
      await egressCharged(ip),
      0,
      "an expired REAL token is liveness, not a guess — the stuffing signal must stay 0",
    );
  },
);

Deno.test(
  "ATTACK 4b: bootstrap and the transitional ID-token path must honour liveness codes (user_banned / user_not_found are not guesses)",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const bannedSignIns = new Set(
      Array.from({ length: 15 }, () => googleIdToken(OTHER_USER_ID)),
    );
    const goneOldBuilds = new Set(
      Array.from({ length: 15 }, () => googleIdToken(OTHER_USER_ID)),
    );
    h.respond = (call) => {
      if (!isIdTokenCall(call)) return null;
      const token = bodyField(call, "id_token");
      if (bannedSignIns.has(token)) return userBanned();
      if (goneOldBuilds.has(token)) return userGone();
      return null;
    };
    const signIns: number[] = [];
    for (const token of bannedSignIns) signIns.push((await postBootstrap(h.handler, ip, token)).status);
    assert(allEqual(signIns, 401), `a banned account's sign-in is 401: ${signIns.join(",")}`);
    const reads: number[] = [];
    for (const token of goneOldBuilds) reads.push((await readMe(h.handler, ip, token)).status);
    assert(allEqual(reads, 401), `a deleted account's old build is 401: ${reads.join(",")}`);
    assertEquals(h.calls.filter(isIdTokenCall).length, 30, "all 30 were judged by Auth");
    assertEquals(
      await egressCharged(ip),
      0,
      "user_banned / user_not_found are liveness refusals of REAL credentials — no stuffing signal",
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 5 — the flat per-IP route budgets that survive: 30 refresh or
// bootstrap requests from one handset, however malformed, fence the venue's
// refresh / sign-in for a minute.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 5a: 30 malformed refresh bodies (400, nothing judged) from one handset must not fence a peer's LIVE refresh from the same egress",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const malformed = await repeat(AUTH_ROUTE_LIMIT.limit, () =>
      send(h.handler, refreshRequest(ip, {})),
    );
    assert(allEqual(malformed, 400), `an empty body is a validation error: ${malformed.join(",")}`);
    assertEquals(h.calls.filter(isRefreshCall).length, 0, "nothing reached Auth");
    assertEquals(await egressCharged(ip), 0, "nothing was charged as an auth failure");
    const peer = await postRefresh(h.handler, ip, `rt-live-${crypto.randomUUID()}`);
    assertEquals(
      peer.status,
      200,
      `a peer's live refresh must rotate; got ${peer.status} Retry-After=${peer.headers.get("Retry-After")}`,
    );
  },
);

Deno.test(
  "ATTACK 5b: 30 junk bootstraps (401 local, nothing judged) from one handset must not fence a peer's real sign-in from the same egress",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const junk = await repeat(AUTH_ROUTE_LIMIT.limit, () =>
      postBootstrap(h.handler, ip, `junk-${crypto.randomUUID()}`),
    );
    assert(allEqual(junk, 401), `junk is refused locally: ${junk.join(",")}`);
    assertEquals(h.calls.filter(isIdTokenCall).length, 0, "nothing reached Auth");
    assertEquals(await egressCharged(ip), 0, "nothing was charged as an auth failure");
    const peer = await postBootstrap(h.handler, ip, fakeGoogleIdToken(TEST_USER_ID));
    assertEquals(
      peer.status,
      200,
      `a peer's real sign-in must be served; got ${peer.status} Retry-After=${peer.headers.get("Retry-After")}`,
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 6 — stuffing gate bypass. Under stuffing, novel guesses on the
// session route are 429 before Auth; the same handset moves its guessing to
// refresh and bootstrap, which are not gated by the signal.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 6: an egress under stuffing must not still deliver novel refresh-token and ID-token guesses to Auth",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    await withClock(async (tick) => {
      await stuffEgress(h, ip);
      const novelSession = await readMe(h.handler, ip, supabaseBearer("novel"));
      assertEquals(novelSession.status, 429, "session-route guesses are gated (candidate pins this)");
      tick(60_000); // fresh minute: the 30/min route budgets are not what is under test
      const refreshRefused = () =>
        jsonResponse(400, {
          error: "invalid_grant",
          error_description: "Invalid Refresh Token: Refresh Token Not Found",
          error_code: "refresh_token_not_found",
        });
      const idTokenRefused = () =>
        jsonResponse(400, {
          error: "invalid_grant",
          error_description: "Bad ID token",
          error_code: "bad_id_token",
        });
      h.respond = (call) => {
        if (isRefreshCall(call)) return refreshRefused();
        if (isIdTokenCall(call)) return idTokenRefused();
        if (isUserCall(call)) return credentialRefused();
        return null;
      };
      const refreshBefore = h.calls.filter(isRefreshCall).length;
      const idTokenBefore = h.calls.filter(isIdTokenCall).length;
      const refreshGuesses = await repeat(20, () =>
        postRefresh(h.handler, ip, `rt-guess-${crypto.randomUUID()}`),
      );
      const idTokenGuesses = await repeat(20, () =>
        postBootstrap(h.handler, ip, googleIdToken(OTHER_USER_ID)),
      );
      const reachedAuth =
        h.calls.filter(isRefreshCall).length -
        refreshBefore +
        (h.calls.filter(isIdTokenCall).length - idTokenBefore);
      assertEquals(
        reachedAuth,
        0,
        `under stuffing, 40 novel guesses via refresh/bootstrap reached Auth ${reachedAuth} times ` +
          `(refresh: ${refreshGuesses.join(",")}; bootstrap: ${idTokenGuesses.join(",")}) — ` +
          `on BASE the tripped egress budget stopped every one of them before Auth`,
      );
    });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 7 — concurrency: 60 DISTINCT guesses racing 5 valid peers and one
// verified session. Nothing may leak on the wire.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 7: 60 concurrent DISTINCT guesses racing verified and unverified peers — peers 200, signal == guesses Auth judged, no digest on the wire",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const cached = fakeSupabaseAccessToken(TEST_USER_ID);
    assertEquals((await readMe(h.handler, ip, cached)).status, 200, "peer verified and cached");
    const forged = Array.from({ length: 60 }, (_, i) => supabaseBearer(`race-${i}`));
    const forgedSet = new Set(forged);
    h.respond = (call) =>
      isUserCall(call) && forgedSet.has(bearerOfCall(call)) ? credentialRefused() : null;
    const results = await Promise.all([
      ...forged.map((bearer) => h.handler(userRequest("GET", "/v1/me", { token: bearer, ip }))),
      ...Array.from({ length: 5 }, () => readMe(h.handler, ip, cached)),
    ]);
    const attacker = results.slice(0, 60);
    const peers = results.slice(60).map((r) => r.status);
    assertEquals(peers, [200, 200, 200, 200, 200], "the verified peer is served throughout");
    const attackerStatuses = attacker.map((r) => r.status);
    assert(
      attackerStatuses.every((s) => s === 401 || s === 429),
      `guesses are refused or throttled, never served: ${attackerStatuses.join(",")}`,
    );
    const judged = h.calls.filter((call) => isUserCall(call) && forgedSet.has(bearerOfCall(call)));
    const distinctJudged = new Set(judged.map(bearerOfCall)).size;
    assertEquals(
      await egressCharged(ip),
      distinctJudged,
      "the signal counts exactly the distinct guesses Auth judged — no under/over-count in the race",
    );
    const digests = await Promise.all(
      forged.map(async (bearer) => {
        const bytes = new TextEncoder().encode(bearer);
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
      }),
    );
    for (const response of attacker) {
      const text = await response.text();
      const wire = `${[...response.headers.entries()].map(([k, v]) => `${k}:${v}`).join("\n")}\n${text}`;
      assert(!/authfail|shard|liveness|credential/i.test(wire), `internal vocabulary leaked: ${wire}`);
      assert(!digests.some((d) => wire.includes(d)), "a credential digest leaked on the wire");
    }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 8 — clock boundaries: rollback within a window, rollback across a
// window, far-future clock. Never a crash, never a negative / NaN Retry-After.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 8: clock rollback and far-future clocks never crash the budget or emit an unbounded Retry-After",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const budget = AUTH_FAILURE_LIMIT;
    const realNow = Date.now;
    const boundary = (Math.floor(realNow() / WINDOW_MS) + 3) * WINDOW_MS;
    let clock = boundary + 10_000;
    Date.now = () => clock;
    try {
      const ip = "203.0.113.200";
      const id = await rateLimit.authFailureIdentity("rollback");
      for (let i = 0; i < budget.limit; i += 1) {
        await rateLimit.chargeAuthFailure(ip, id, { kind: "credential" }, budget);
      }
      const closed = await rateLimit.peekAuthFailureBudget(ip, id, budget);
      assertEquals(closed.allowed, false);
      // Rollback inside the window: still closed, Retry-After bounded.
      clock = boundary + 1;
      const rolledBack = await rateLimit.peekAuthFailureBudget(ip, id, budget);
      assertEquals(rolledBack.allowed, false, "a rollback inside the window does not reopen");
      assert(
        Number.isInteger(rolledBack.retryAfterSeconds) &&
          rolledBack.retryAfterSeconds >= 1 &&
          rolledBack.retryAfterSeconds <= budget.windowSeconds,
        `bounded Retry-After after rollback: ${rolledBack.retryAfterSeconds}`,
      );
      // Rollback across the boundary (previous window): whatever it answers,
      // it must be finite and bounded, and the stuffing peek must not throw.
      clock = boundary - 1;
      const previous = await rateLimit.peekAuthFailureBudget(ip, id, budget);
      assert(
        Number.isInteger(previous.retryAfterSeconds) &&
          previous.retryAfterSeconds >= 1 &&
          previous.retryAfterSeconds <= budget.windowSeconds,
        `bounded Retry-After in the previous window: ${previous.retryAfterSeconds}`,
      );
      const stuffing = await rateLimit.peekAuthStuffing(ip, budget);
      assert(Number.isFinite(stuffing.remaining) && stuffing.remaining >= 0);
      // Far future (year 2200): charging and peeking still behave.
      clock = Date.UTC(2200, 0, 1);
      await rateLimit.chargeAuthFailure(ip, id, { kind: "credential" }, budget);
      const future = await rateLimit.peekAuthFailureBudget(ip, id, budget);
      assertEquals(future.allowed, true);
      assertEquals(future.remaining, budget.limit - 1);
      assert(
        future.retryAfterSeconds >= 1 && future.retryAfterSeconds <= budget.windowSeconds,
        `bounded Retry-After in the far future: ${future.retryAfterSeconds}`,
      );
      // Negative / NaN clocks: the budget must not throw.
      clock = -1;
      await rateLimit.chargeAuthFailure(ip, id, { kind: "credential" }, budget);
      assert((await rateLimit.peekAuthFailureBudget(ip, id, budget)).limit === budget.limit);
      clock = Number.NaN;
      await rateLimit.chargeAuthFailure(ip, id, { kind: "credential" }, budget);
      const nan = await rateLimit.peekAuthFailureBudget(ip, id, budget);
      assertEquals(nan.limit, budget.limit);
    } finally {
      Date.now = realNow;
    }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 9 — Redis partial failure: the shard INCR lands in Redis, the
// egress INCR is refused. The stuffing signal must still be seen by the
// isolate that charged it, and a restarted isolate must see the Redis shard.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 9: Redis refusing only the egress INCR still trips the stuffing gate locally; an isolate restart keeps the Redis shard and signal",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const budget = AUTH_FAILURE_LIMIT;
      const ip = "203.0.113.210";
      redis.commandError = (cmd) =>
        cmd[0] === "INCR" && /:authfail:/.test(String(cmd[1])) ? "ERR egress slot down" : null;
      const first = await loadIsolate();
      for (let i = 0; i < budget.limit; i += 1) {
        const id = await first.rateLimit.authFailureIdentity(`partial-${i}`);
        await first.rateLimit.chargeAuthFailure(ip, id, { kind: "credential" }, budget);
      }
      const shardKeys = [...redis.store.keys()].filter((key) => key.includes(":authfail_id:"));
      assertEquals(shardKeys.length, budget.limit, "every shard landed in Redis");
      const local = await first.rateLimit.peekAuthStuffing(ip, budget);
      assertEquals(local.allowed, false, "the isolate that charged the signal sees the stuffing");
      const replay = await first.rateLimit.authFailureIdentity("partial-0");
      assertEquals(
        spent(await first.rateLimit.peekAuthFailureBudget(ip, replay, budget)),
        1,
        "the shard is read from Redis",
      );

      // Redis heals; a replacement isolate (process death + restart) must see
      // the Redis shards and keep counting the signal without double charging.
      redis.commandError = null;
      const restarted = await loadIsolate();
      assertEquals(
        spent(await restarted.rateLimit.peekAuthFailureBudget(ip, replay, budget)),
        1,
        "a restarted isolate sees the shard Redis kept",
      );
      await restarted.rateLimit.chargeAuthFailure(ip, replay, { kind: "credential" }, budget);
      assertEquals(
        spent(await restarted.rateLimit.peekAuthFailureBudget(ip, replay, budget)),
        2,
        "the replay is the shard's second hit",
      );
      assertEquals(
        spent(
          await restarted.rateLimit.peekRateLimit(
            "authfail",
            ip,
            budget.limit,
            budget.windowSeconds,
          ),
        ),
        0,
        "a replayed credential never raises the shared signal (shard count was 2, not 1)",
      );
      const fresh = await restarted.rateLimit.authFailureIdentity("after-restart");
      await restarted.rateLimit.chargeAuthFailure(ip, fresh, { kind: "credential" }, budget);
      assertEquals(
        spent(
          await restarted.rateLimit.peekRateLimit(
            "authfail",
            ip,
            budget.limit,
            budget.windowSeconds,
          ),
        ),
        1,
        "a new distinct guess after restart is the first shared signal Redis accepted",
      );
    } finally {
      redis.restore();
      configureRedis(false);
    }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 10 — refresh body boundaries: padding, non-strings, oversize, wrong
// content. The shard must follow the judged credential; nothing may 5xx.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 10: refresh boundary bodies never 5xx or charge; a padded replay of one refused token shares its shard",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    await withClock(async (tick) => {
      const odd: unknown[] = [
        { refreshToken: 42 },
        { refreshToken: null },
        { refreshToken: ["a"] },
        { refreshToken: { token: "x" } },
        { refreshToken: "" },
        { refreshToken: "   " },
        { refreshtoken: "rt-wrong-case" },
        "not json at all",
        "",
      ];
      const statuses: number[] = [];
      for (const body of odd) statuses.push((await send(h.handler, refreshRequest(ip, body))).status);
      assert(
        statuses.every((s) => s >= 400 && s < 500),
        `boundary bodies are client errors, never 5xx: ${statuses.join(",")}`,
      );
      assertEquals(h.calls.filter(isRefreshCall).length, 0, "nothing reached Auth");
      assertEquals(await egressCharged(ip), 0, "nothing was charged");

      tick(60_000);
      const bogus = `rt-bogus-${ip}`;
      h.respond = (call) =>
        isRefreshCall(call) && bodyField(call, "refresh_token") === bogus
          ? jsonResponse(400, {
              error: "invalid_grant",
              error_description: "Invalid Refresh Token: Refresh Token Not Found",
              error_code: "refresh_token_not_found",
            })
          : null;
      const padded = [bogus, ` ${bogus}`, `${bogus} `, `\t${bogus}\n`];
      const replays: number[] = [];
      for (let i = 0; i < LIMIT; i += 1) {
        replays.push((await postRefresh(h.handler, ip, padded[i % padded.length])).status);
        if (i % 10 === 9) tick(60_000);
      }
      assert(allEqual(replays, 401), `padded replays are refused: ${replays.join(",")}`);
      assertEquals(await egressCharged(ip), 1, "padding does not mint a new credential");
      const throttled = await postRefresh(h.handler, ip, `  ${bogus}`);
      assertEquals(throttled.status, 429, "the 31st padded replay is the same shard, throttled");
      const live = await postRefresh(h.handler, ip, `rt-live-${crypto.randomUUID()}`);
      assertEquals(live.status, 200, "a peer's live refresh is served");
    });
  },
);
