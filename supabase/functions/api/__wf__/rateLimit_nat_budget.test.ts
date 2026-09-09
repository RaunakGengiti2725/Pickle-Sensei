// W11-01 — auth-failure budgets behind a shared NAT egress, through the REAL
// handler (routesHarness) plus the rateLimit.ts primitives (harness.ts).
//
// A venue (club Wi-Fi, carrier NAT) presents ONE client IP for many handsets.
// The auth-failure budget exists to starve credential stuffing; it must not
// let one co-tenant — or thirty signed-out handsets — lock the rest out:
//
//   * a refusal Supabase Auth issues for a credential it RECOGNISES but that
//     is dead (session logged out, refresh token rotated/deleted, user
//     banned/deleted) is LIVENESS: it charges only that credential's own
//     shard, never the egress-wide stuffing signal, and keeps answering 401
//     (the app's sign-out signal; a 429 is retryable and hides it). Auth
//     answers `refresh_token_not_found` for a guess too, so for the refresh
//     grant the edge settles it by whether IT minted the token;
//   * a refusal for a credential Auth cannot recognise is a CREDENTIAL
//     failure: it charges the egress's stuffing signal (the flat budget's
//     `authfail` window, shared by bearer / bootstrap / refresh), so forged
//     novelty is bounded before it reaches Auth exactly as the flat budget
//     bounded it — at most 30 guesses per egress per window reach Auth,
//     whatever mix of routes carries them, even in one parallel burst;
//   * refusals decided at the edge (no bearer, malformed, expired, wrong
//     scheme) never reached Auth and charge nothing;
//   * an egress saturated by a co-tenant holds only never-seen and refused
//     credentials: cached bearers, the handsets' refreshes, the tokens they
//     mint and dead sessions' 401s keep working for peers behind the same
//     IP; a brand-new sign-in waits for the window, as under the flat budget;
//   * shard storage is bounded and attacker-chosen cardinality can neither
//     switch the budget off nor evict the rest of the limiter.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json rateLimit_nat_budget.test.ts

import { assert, assertEquals } from "@std/assert";
import { enforceRateLimit, peekRateLimit } from "../rateLimit.ts";
import { loadIsolate } from "./harness.ts";
import {
  fakeGoogleIdToken,
  fakeSupabaseAccessToken,
  loadHarness,
  OTHER_USER_ID,
  type RecordedCall,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

/** Mirrors AUTH_FAILURE_LIMIT / AUTH_REFRESH_LIMIT / AUTH_BOOTSTRAP_LIMIT in index.ts. */
const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
const PER_MINUTE_ROUTE_LIMIT = 30;

type Handler = (request: Request) => Promise<Response>;

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const jwtOf = (payload: Record<string, unknown>): string =>
  `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.sig`;

/** A Supabase-shaped session bearer Auth will judge; `salt` keeps each distinct. */
const supabaseBearer = (salt: string): string =>
  jwtOf({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: TEST_USER_ID,
    aud: "authenticated",
    role: "authenticated",
    session_id: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 3600,
    salt,
  });

const googleIdToken = (sub: string, exp = Math.floor(Date.now() / 1000) + 3600): string =>
  jwtOf({
    iss: "https://accounts.google.com",
    sub,
    exp,
    salt: crypto.randomUUID(),
  });

const jwtSubjectOf = (token: string): string | null => {
  const segment = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
  try {
    const payload: unknown = JSON.parse(atob(segment + "=".repeat((4 - (segment.length % 4)) % 4)));
    if (typeof payload !== "object" || payload === null) return null;
    const sub = (payload as Record<string, unknown>).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// GoTrue answers, verbatim in shape.
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

const bearerOfCall = (call: RecordedCall): string =>
  (call.headers.authorization ?? "").replace(/^Bearer /, "").trim();
const isUserCall = (call: RecordedCall) => call.url.startsWith(`${SUPABASE_URL}/auth/v1/user`);
const isTokenCall = (call: RecordedCall) => call.url.startsWith(`${SUPABASE_URL}/auth/v1/token`);
const isRefreshCall = (call: RecordedCall) =>
  isTokenCall(call) && call.url.includes("grant_type=refresh_token");
const isIdTokenCall = (call: RecordedCall) =>
  isTokenCall(call) && call.url.includes("grant_type=id_token");
const bodyField = (call: RecordedCall, field: string): string => {
  const body = call.body;
  if (typeof body !== "object" || body === null) return "";
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
};

let ipCounter = 0;
/** A unique egress per test (own /16). */
const freshIp = () => `10.63.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const spent = (window: { limit: number; remaining: number }) => window.limit - window.remaining;
/** The egress-wide stuffing signal (the historical `authfail` window), shared
 * by every credential class an egress presents. */
const egressCharged = async (ip: string): Promise<number> =>
  spent(
    await peekRateLimit("authfail", ip, AUTH_FAILURE_LIMIT.limit, AUTH_FAILURE_LIMIT.windowSeconds),
  );

const profile = () => ({
  id: TEST_USER_ID,
  email: "user@example.com",
  onboarding_state: "complete",
  provider: "google",
  skill_level: null,
  handedness: null,
  primary_goal: null,
  biggest_problem: null,
  focus_checkpoint: null,
  first_name: null,
  gender: null,
});

async function send(handler: Handler, request: Request): Promise<Response> {
  const response = await handler(request);
  await response.body?.cancel();
  return response;
}

const readMe = (handler: Handler, ip: string, bearer: string) =>
  send(handler, userRequest("GET", "/v1/me", { token: bearer, ip }));

const readMeWithAuthorization = (handler: Handler, ip: string, authorization: string | null) => {
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (authorization !== null) headers.Authorization = authorization;
  return send(
    handler,
    new Request("http://edge.test/functions/v1/api/v1/me", {
      method: "GET",
      headers,
    }),
  );
};

const postRefresh = (handler: Handler, ip: string, refreshToken: string) =>
  send(
    handler,
    new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    }),
  );

const postBootstrap = (handler: Handler, ip: string, idToken: string) =>
  send(
    handler,
    userRequest("POST", "/v1/account/bootstrap", {
      token: idToken,
      ip,
      body: {},
    }),
  );

async function sendJson(
  handler: Handler,
  request: Request,
): Promise<{ status: number; body: Record<string, unknown> }> {
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
    body: typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {},
  };
}

const sessionField = (body: Record<string, unknown>, field: string): string => {
  const session = body.session;
  if (typeof session !== "object" || session === null) return "";
  const token = (session as Record<string, unknown>)[field];
  return typeof token === "string" ? token : "";
};
const sessionAccessToken = (body: Record<string, unknown>) => sessionField(body, "accessToken");

/** Sign a handset in through the edge (a refresh grant Auth honours) and
 * return the refresh token the edge minted for it. */
async function mintHandset(handler: Handler, ip: string): Promise<string> {
  const minted = await sendJson(
    handler,
    new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: `rt-live-${crypto.randomUUID()}` }),
    }),
  );
  assertEquals(minted.status, 200, "handset signed in");
  const refreshToken = sessionField(minted.body, "refreshToken");
  assert(refreshToken, "the edge handed the handset a refresh token");
  return refreshToken;
}

const repeat = async (times: number, run: (i: number) => Promise<Response>): Promise<number[]> => {
  const statuses: number[] = [];
  for (let i = 0; i < times; i += 1) statuses.push((await run(i)).status);
  return statuses;
};

const count = (statuses: number[], status: number) => statuses.filter((s) => s === status).length;

const assertRetryAfterBounded = (response: Response) => {
  const retryAfter = Number(response.headers.get("Retry-After"));
  assert(
    Number.isInteger(retryAfter) &&
      retryAfter >= 1 &&
      retryAfter <= AUTH_FAILURE_LIMIT.windowSeconds,
    `429 must carry a window-bounded Retry-After, got ${retryAfter}`,
  );
};

/** Pin `Date.now` to the first second of the NEXT auth-failure window (also a
 * fresh minute for the per-minute route budgets) and let the test move it. */
async function withPinnedClock(run: (clock: { advance(ms: number): void }) => Promise<void>) {
  const realNow = Date.now;
  const windowMs = AUTH_FAILURE_LIMIT.windowSeconds * 1_000;
  let now = (Math.floor(realNow() / windowMs) + 1) * windowMs + 1_000;
  Date.now = () => now;
  try {
    await run({
      advance(ms: number) {
        now += ms;
      },
    });
  } finally {
    Date.now = realNow;
  }
}

/** Fake Supabase Auth keyed by credential: dead sessions answer liveness
 * refusals, forged credentials answer credential refusals, everything else is
 * verified/minted by the routesHarness defaults. */
function installAuth(
  h: {
    respond: (call: RecordedCall) => Response | null | Promise<Response | null>;
  },
  sets: {
    deadBearers?: Set<string>;
    forgedBearers?: Set<string>;
    deadRefresh?: Set<string>;
  },
) {
  h.respond = (call) => {
    if (isUserCall(call)) {
      const bearer = bearerOfCall(call);
      if (sets.deadBearers?.has(bearer)) return sessionGone();
      if (sets.forgedBearers?.has(bearer)) return credentialRefused();
      return null;
    }
    if (isRefreshCall(call)) {
      if (sets.deadRefresh?.has(bodyField(call, "refresh_token"))) {
        return refreshRefused();
      }
      return mintedSession(TEST_USER_ID);
    }
    if (isIdTokenCall(call)) {
      const idToken = bodyField(call, "id_token");
      if (sets.forgedBearers?.has(idToken)) return idTokenRefused();
      return mintedSession(jwtSubjectOf(idToken) ?? TEST_USER_ID);
    }
    return null;
  };
}

// ─── Liveness ────────────────────────────────────────────────────────────────

Deno.test(
  "liveness: thirty signed-out handsets refreshing behind one NAT leave the stuffing signal at 0 and the 31st dead session is still told 401, while thirty forged refresh tokens are bounded before Auth",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      const ip = freshIp();
      const deadRefresh = new Set<string>();
      installAuth(h, { deadRefresh });

      // Minute 0: a venue's handsets sign in (the edge mints their sessions).
      const handsets: string[] = [];
      for (let i = 0; i < PER_MINUTE_ROUTE_LIMIT; i += 1) {
        handsets.push(await mintHandset(h.handler, ip));
      }
      const refreshCallsAfterMint = h.calls.filter(isRefreshCall).length;

      // Minute 1: every one of them was signed out from another device
      // (scope=local logout / deletion) and comes back to rotate its token.
      clock.advance(60_000);
      for (const token of handsets) deadRefresh.add(token);
      const signedOut = await repeat(PER_MINUTE_ROUTE_LIMIT, (i) =>
        postRefresh(h.handler, ip, handsets[i]),
      );
      assertEquals(
        count(signedOut, 401),
        PER_MINUTE_ROUTE_LIMIT,
        `statuses ${signedOut.join(",")}`,
      );
      assertEquals(
        h.calls.filter(isRefreshCall).length,
        refreshCallsAfterMint + PER_MINUTE_ROUTE_LIMIT,
      );
      assertEquals(await egressCharged(ip), 0, "dead sessions are not a stuffing signal");

      // Minute 2: the 31st signed-out handset is still told 401, a live peer
      // still rotates, and two more handsets sign in for later.
      clock.advance(60_000);
      const thirtyFirst = await mintHandset(h.handler, ip);
      deadRefresh.add(thirtyFirst);
      const late = await postRefresh(h.handler, ip, thirtyFirst);
      assertEquals(late.status, 401, "the app's ONE sign-out signal must not become 429");
      const peer = await mintHandset(h.handler, ip);
      const spare = await mintHandset(h.handler, ip);

      // Minute 3: a co-tenant guesses thirty refresh tokens. Auth answers
      // refresh_token_not_found for those too — but the edge never minted
      // them, so they are charged as guesses.
      clock.advance(60_000);
      const guess = () => {
        const token = `rt-forged-${crypto.randomUUID()}`;
        deadRefresh.add(token);
        return token;
      };
      const refreshCallsBeforeFlood = h.calls.filter(isRefreshCall).length;
      const forged = await repeat(PER_MINUTE_ROUTE_LIMIT, () =>
        postRefresh(h.handler, ip, guess()),
      );
      assertEquals(count(forged, 401), PER_MINUTE_ROUTE_LIMIT, `statuses ${forged.join(",")}`);
      assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit);

      // Minute 4: further guesses are held before Auth; the venue's own
      // handsets — signed out or live — are answered by Auth as before.
      clock.advance(60_000);
      const heldGuess = await postRefresh(h.handler, ip, guess());
      assertEquals(heldGuess.status, 429);
      assertRetryAfterBounded(heldGuess);
      assertEquals(
        h.calls.filter(isRefreshCall).length,
        refreshCallsBeforeFlood + PER_MINUTE_ROUTE_LIMIT,
      );
      deadRefresh.add(spare);
      assertEquals(
        (await postRefresh(h.handler, ip, spare)).status,
        401,
        "signed out during the flood",
      );
      assertEquals(
        (await postRefresh(h.handler, ip, peer)).status,
        200,
        "live peer rotates during the flood",
      );
      assertEquals(
        h.calls.filter(isRefreshCall).length,
        refreshCallsBeforeFlood + PER_MINUTE_ROUTE_LIMIT + 2,
      );
    });
  },
);

Deno.test(
  "liveness: thirty logged-out session bearers behind one NAT do not lock a valid peer's fresh bearer, refresh or sign-in",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const deadBearers = new Set<string>();
      installAuth(h, { deadBearers });

      const statuses = await repeat(AUTH_FAILURE_LIMIT.limit, (i) => {
        const bearer = supabaseBearer(`logged-out-${i}`);
        deadBearers.add(bearer);
        return readMe(h.handler, ip, bearer);
      });
      assertEquals(
        count(statuses, 401),
        AUTH_FAILURE_LIMIT.limit,
        `statuses ${statuses.join(",")}`,
      );
      assertEquals(h.calls.filter(isUserCall).length, AUTH_FAILURE_LIMIT.limit);
      assertEquals(await egressCharged(ip), 0);

      const peerBearer = fakeSupabaseAccessToken(TEST_USER_ID);
      assertEquals((await readMe(h.handler, ip, peerBearer)).status, 200, "novel valid bearer");
      assertEquals(h.calls.filter(isUserCall).length, AUTH_FAILURE_LIMIT.limit + 1, "verified");
      assertEquals(
        (await postRefresh(h.handler, ip, `rt-live-${crypto.randomUUID()}`)).status,
        200,
      );
      assertEquals((await postBootstrap(h.handler, ip, googleIdToken(OTHER_USER_ID))).status, 200);

      // Another logged-out handset behind the same NAT is still told 401.
      const late = supabaseBearer("logged-out-late");
      deadBearers.add(late);
      assertEquals((await readMe(h.handler, ip, late)).status, 401);
    });
  },
);

// ─── Credential stuffing stays bounded; the venue survives it ────────────────

Deno.test(
  "stuffing: after thirty forged bearers, novel and replayed forged bearers are 429 before Auth while the venue's cached bearer, its handsets' refreshes and the tokens they mint keep working; a brand-new sign-in waits for the window",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const deadBearers = new Set<string>();
      const forgedBearers = new Set<string>();
      installAuth(h, { deadBearers, forgedBearers });

      // Before the flood: a peer's established session (verified once, cached),
      // a handset signed in through the edge, and a handset whose session was
      // logged out from another device.
      const established = fakeSupabaseAccessToken(TEST_USER_ID);
      assertEquals((await readMe(h.handler, ip, established)).status, 200);
      const handset = await mintHandset(h.handler, ip);
      const deadHandset = supabaseBearer("dead-handset");
      deadBearers.add(deadHandset);
      assertEquals((await readMe(h.handler, ip, deadHandset)).status, 401);
      const userCallsBeforeFlood = h.calls.filter(isUserCall).length;

      // The co-tenant's flood: thirty distinct forged bearers are judged…
      const forged = (salt: string) => {
        const bearer = supabaseBearer(salt);
        forgedBearers.add(bearer);
        return bearer;
      };
      const judged = await repeat(AUTH_FAILURE_LIMIT.limit, (i) =>
        readMe(h.handler, ip, forged(`forged-${i}`)),
      );
      assertEquals(count(judged, 401), AUTH_FAILURE_LIMIT.limit, `statuses ${judged.join(",")}`);
      assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit);

      // …and from then on neither novelty nor replay reaches Supabase Auth.
      const novel = await repeat(100, (i) => {
        clock.advance(200);
        return readMe(h.handler, ip, forged(`novel-${i}`));
      });
      assertEquals(count(novel, 429), 100, `novel forged statuses ${novel.join(",")}`);
      const [firstForged] = forgedBearers;
      const replay = await readMe(h.handler, ip, firstForged);
      assertEquals(replay.status, 429);
      assertRetryAfterBounded(replay);
      assertEquals(
        h.calls.filter(isUserCall).length,
        userCallsBeforeFlood + AUTH_FAILURE_LIMIT.limit,
        "upstream verification is bounded by the budget",
      );

      // The venue behind the same IP, during the flood:
      const refresh = await sendJson(
        h.handler,
        new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
          method: "POST",
          headers: {
            "x-forwarded-for": ip,
            "content-type": "application/json",
          },
          body: JSON.stringify({ refreshToken: handset }),
        }),
      );
      const rotated = sessionAccessToken(refresh.body);
      const rotatedRefresh = sessionField(refresh.body, "refreshToken");
      const venue = {
        cachedRead: (await readMe(h.handler, ip, established)).status,
        refresh: refresh.status,
        rotatedRead: rotated ? (await readMe(h.handler, ip, rotated)).status : -1,
        rotatedAgain: rotatedRefresh
          ? (await postRefresh(h.handler, ip, rotatedRefresh)).status
          : -1,
        deadHandset: (await readMe(h.handler, ip, deadHandset)).status,
      };
      assertEquals(venue, {
        cachedRead: 200,
        refresh: 200,
        rotatedRead: 200,
        rotatedAgain: 200,
        deadHandset: 401,
      });

      // A never-seen ID token is indistinguishable from a forged one before
      // Auth sees it, so a brand-new sign-in is held (retryable, window-
      // bounded) exactly as under the flat budget — and admitted after it.
      const idTokenCallsDuringFlood = h.calls.filter(isIdTokenCall).length;
      const held = await postBootstrap(h.handler, ip, googleIdToken(OTHER_USER_ID));
      assertEquals(held.status, 429);
      assertRetryAfterBounded(held);
      assertEquals(h.calls.filter(isIdTokenCall).length, idTokenCallsDuringFlood);
      clock.advance(AUTH_FAILURE_LIMIT.windowSeconds * 1_000);
      const bootstrap = await sendJson(
        h.handler,
        userRequest("POST", "/v1/account/bootstrap", {
          token: googleIdToken(OTHER_USER_ID),
          ip,
          body: {},
        }),
      );
      assertEquals(bootstrap.status, 200);
      const minted = sessionAccessToken(bootstrap.body);
      assert(minted, "the new handset was handed a session");
      assertEquals((await readMe(h.handler, ip, minted)).status, 200);
    });
  },
);

Deno.test(
  "stuffing: forged ID tokens on bootstrap are bounded to the budget upstream and hold neither the venue's session bearers nor its handsets' refreshes; a handset signed out during the flood is still told 401",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const deadBearers = new Set<string>();
      const forgedBearers = new Set<string>();
      installAuth(h, { deadBearers, forgedBearers });
      const forgedIdToken = () => {
        const token = googleIdToken(crypto.randomUUID());
        forgedBearers.add(token);
        return token;
      };

      // Before the flood: an established (cached) session and two handsets
      // the edge signed in, one of which will be signed out mid-flood.
      const established = fakeSupabaseAccessToken(TEST_USER_ID);
      assertEquals((await readMe(h.handler, ip, established)).status, 200);
      const handset = await mintHandset(h.handler, ip);
      const signedIn = await sendJson(
        h.handler,
        userRequest("POST", "/v1/account/bootstrap", {
          token: googleIdToken(OTHER_USER_ID),
          ip,
          body: {},
        }),
      );
      assertEquals(signedIn.status, 200);
      const doomed = sessionAccessToken(signedIn.body);
      assert(doomed, "the handset was handed a session");
      clock.advance(60_000);

      const statuses: number[] = [];
      for (let minute = 0; minute < 2; minute += 1) {
        for (let i = 0; i < PER_MINUTE_ROUTE_LIMIT; i += 1) {
          statuses.push((await postBootstrap(h.handler, ip, forgedIdToken())).status);
        }
        if (minute === 0) clock.advance(60_000);
      }
      assertEquals(
        count(statuses, 401),
        AUTH_FAILURE_LIMIT.limit,
        `statuses ${statuses.join(",")}`,
      );
      assertEquals(count(statuses, 429), PER_MINUTE_ROUTE_LIMIT, `statuses ${statuses.join(",")}`);
      assertEquals(h.calls.filter(isIdTokenCall).length, AUTH_FAILURE_LIMIT.limit + 1);
      assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit);

      assertEquals((await readMe(h.handler, ip, established)).status, 200, "cached bearer");
      assertEquals((await postRefresh(h.handler, ip, handset)).status, 200, "minted refresh");
      deadBearers.add(doomed);
      assertEquals((await readMe(h.handler, ip, doomed)).status, 401, "the ONE sign-out signal");
      assertEquals((await readMe(h.handler, ip, doomed)).status, 401, "and it stays 401");
      assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit, "a dead session is no guess");
    });
  },
);

// ─── Local refusals ──────────────────────────────────────────────────────────

Deno.test(
  "local: forty pre-auth refusals (no bearer, malformed, expired, wrong scheme) charge nothing and never reach Auth; a valid novel bearer then verifies",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const expiredSession = jwtOf({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: TEST_USER_ID,
        aud: "authenticated",
        role: "authenticated",
        session_id: crypto.randomUUID(),
        exp: Math.floor(Date.now() / 1000) - 60,
      });
      const locals: Array<string | null> = [
        null,
        "Bearer not-a-jwt",
        `Bearer ${expiredSession}`,
        `Bearer ${googleIdToken(TEST_USER_ID, Math.floor(Date.now() / 1000) - 60)}`,
        `bearer ${fakeSupabaseAccessToken(TEST_USER_ID)}`,
        `Bearer\t${fakeSupabaseAccessToken(TEST_USER_ID)}`,
        `Basic ${fakeSupabaseAccessToken(TEST_USER_ID)}`,
        "Bearer ",
      ];
      const statuses = await repeat(40, (i) =>
        readMeWithAuthorization(h.handler, ip, locals[i % locals.length]),
      );
      assertEquals(count(statuses, 401), 40, `statuses ${statuses.join(",")}`);
      assertEquals(h.calls.filter(isUserCall).length, 0, "nothing was judged upstream");
      assertEquals(h.calls.filter(isTokenCall).length, 0);
      assertEquals(await egressCharged(ip), 0);

      const verified = await readMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID));
      assertEquals(verified.status, 200, "a peer's first request is still eligible for Auth");
      assertEquals(h.calls.filter(isUserCall).length, 1);
    });
  },
);

// ─── Credential identity, replay, rollover, concurrency ──────────────────────

Deno.test(
  "shard: whitespace variants of one dead session are one credential — thirty replays are judged, the 31st is 429 before Auth, the egress is charged 0, and the window rollover admits it again",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const dead = supabaseBearer("dead-replayed");
      installAuth(h, { deadBearers: new Set([dead]) });
      const variants = [`Bearer ${dead}`, `Bearer  ${dead}`, `Bearer ${dead} `];

      const replays = await repeat(AUTH_FAILURE_LIMIT.limit, (i) =>
        readMeWithAuthorization(h.handler, ip, variants[i % variants.length]),
      );
      assertEquals(count(replays, 401), AUTH_FAILURE_LIMIT.limit, `statuses ${replays.join(",")}`);
      assertEquals(h.calls.filter(isUserCall).length, AUTH_FAILURE_LIMIT.limit);

      const throttled = await readMeWithAuthorization(h.handler, ip, variants[1]);
      assertEquals(throttled.status, 429, "the 31st presentation of one credential is throttled");
      assertRetryAfterBounded(throttled);
      assertEquals(h.calls.filter(isUserCall).length, AUTH_FAILURE_LIMIT.limit, "not judged again");
      assertEquals(await egressCharged(ip), 0, "a dead session replaying is not stuffing");

      // Other handsets behind the NAT are untouched by that one handset.
      assertEquals(
        (await readMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID))).status,
        200,
      );
      assertEquals(h.calls.filter(isUserCall).length, AUTH_FAILURE_LIMIT.limit + 1);

      // Same credential from another egress: the shard follows the credential.
      const elsewhere = await readMe(h.handler, freshIp(), dead);
      assertEquals(elsewhere.status, 429);

      clock.advance(AUTH_FAILURE_LIMIT.windowSeconds * 1_000);
      const nextWindow = await readMe(h.handler, ip, dead);
      assertEquals(nextWindow.status, 401, "a new window judges the credential again");
      assertEquals(h.calls.filter(isUserCall).length, AUTH_FAILURE_LIMIT.limit + 2);
    });
  },
);

Deno.test(
  "shard: whitespace variants of one forged bearer are one credential and every judged refusal charges the egress once",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      const ip = freshIp();
      const forged = supabaseBearer("forged-replayed");
      installAuth(h, { forgedBearers: new Set([forged]) });
      const variants = [`Bearer ${forged}`, `Bearer  ${forged}`, `Bearer ${forged} `];

      const replays = await repeat(AUTH_FAILURE_LIMIT.limit, (i) =>
        readMeWithAuthorization(h.handler, ip, variants[i % variants.length]),
      );
      assertEquals(count(replays, 401), AUTH_FAILURE_LIMIT.limit, `statuses ${replays.join(",")}`);
      assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit);
      const throttled = await readMeWithAuthorization(h.handler, ip, variants[2]);
      assertEquals(throttled.status, 429);
      assertEquals(h.calls.filter(isUserCall).length, AUTH_FAILURE_LIMIT.limit);
    });
  },
);

Deno.test(
  "shard: sixty simultaneous replays of one dead session are accounted atomically — every judged refusal lands on the shard, none on the egress",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      const ip = freshIp();
      const dead = supabaseBearer("dead-concurrent");
      installAuth(h, { deadBearers: new Set([dead]) });

      const statuses = (
        await Promise.all(Array.from({ length: 60 }, () => readMe(h.handler, ip, dead)))
      ).map((response) => response.status);
      const judged = h.calls.filter(isUserCall).length;
      assertEquals(count(statuses, 401), judged, "each judged replay was a 401");
      assertEquals(count(statuses, 429), 60 - judged, "every other replay was throttled");
      assert(judged >= AUTH_FAILURE_LIMIT.limit, `at least the budget was judged (${judged})`);
      assertEquals(await egressCharged(ip), 0);

      const next = await readMe(h.handler, ip, dead);
      assertEquals(next.status, 429, "the shard holds every further replay in the window");
      assertEquals(h.calls.filter(isUserCall).length, judged, "no lost update let one through");
    });
  },
);

Deno.test(
  "shard: 120 parallel presentations of one forged bearer reach Auth at most thirty times — in-flight judgments count against the shard",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const forgedBearer = supabaseBearer("forged-parallel");
      installAuth(h, { forgedBearers: new Set([forgedBearer]) });
      const handset = await mintHandset(h.handler, ip);

      const statuses = (
        await Promise.all(Array.from({ length: 120 }, () => readMe(h.handler, ip, forgedBearer)))
      ).map((response) => response.status);
      const judged = h.calls.filter(isUserCall).length;
      assertEquals(judged, AUTH_FAILURE_LIMIT.limit, "exactly the budget reached Auth");
      assertEquals(count(statuses, 401), judged);
      assertEquals(count(statuses, 429), 120 - judged);
      assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit);

      // The burst saturated the egress (a never-seen bearer is held), yet a
      // peer's handset still rotates and its freshly minted bearer verifies.
      assertEquals(
        (await readMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID))).status,
        429,
      );
      const rotated = await sendJson(
        h.handler,
        new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
          method: "POST",
          headers: {
            "x-forwarded-for": ip,
            "content-type": "application/json",
          },
          body: JSON.stringify({ refreshToken: handset }),
        }),
      );
      assertEquals(rotated.status, 200);
      assertEquals((await readMe(h.handler, ip, sessionAccessToken(rotated.body))).status, 200);
      assertEquals(h.calls.filter(isUserCall).length, judged + 1, "the minted bearer was verified");
    });
  },
);

// ─── Primitives (rateLimit.ts in isolation) ──────────────────────────────────

type Primitives = {
  authRefusalKind: (error: unknown) => string;
  authFailureIdentity: (credential: string) => Promise<string>;
  peekAuthFailureBudget: (
    ip: string,
    identity: string,
    budget: { limit: number; windowSeconds: number },
  ) => Promise<{ allowed: boolean; remaining: number; limit: number }>;
  chargeAuthFailure: (
    cls: string,
    ip: string,
    identity: string,
    kind: string,
    budget: { limit: number; windowSeconds: number },
  ) => Promise<void>;
  noteMintedCredential: (credential: string, ttlSeconds: number) => Promise<void>;
  enforceRateLimit: typeof enforceRateLimit;
  peekRateLimit: typeof peekRateLimit;
};

async function loadPrimitives(): Promise<Primitives> {
  const isolate = await loadIsolate();
  const rl = isolate.rateLimit as unknown as Record<string, unknown>;
  for (const name of [
    "authRefusalKind",
    "authFailureIdentity",
    "peekAuthFailureBudget",
    "chargeAuthFailure",
    "noteMintedCredential",
  ]) {
    assert(typeof rl[name] === "function", `rateLimit.ts exports ${name}`);
  }
  return rl as unknown as Primitives;
}

Deno.test(
  "authRefusalKind: GoTrue's dead-credential answers are liveness, unrecognised credentials are credential failures",
  async () => {
    const { authRefusalKind } = await loadPrimitives();
    const liveness: unknown[] = [
      {
        error: "invalid_grant",
        error_description: "Invalid Refresh Token: Refresh Token Not Found",
        error_code: "refresh_token_not_found",
      },
      {
        error: "invalid_grant",
        error_description: "Invalid Refresh Token: Refresh Token Not Found",
      },
      {
        error: "invalid_grant",
        error_description: "Invalid Refresh Token: Already Used",
        error_code: "refresh_token_already_used",
      },
      {
        code: 403,
        error_code: "session_not_found",
        msg: "Session from session_id claim in JWT does not exist",
      },
      { code: 403, msg: "Session from session_id claim in JWT does not exist" },
      { code: 403, error_code: "session_expired", msg: "Session has expired" },
      {
        code: 403,
        error_code: "user_not_found",
        msg: "User from sub claim in JWT does not exist",
      },
      { code: 403, error_code: "user_banned", msg: "User is banned" },
      {
        code: 401,
        error_code: "bad_jwt",
        msg: "invalid JWT: unable to parse or verify signature, token is expired by 12s",
      },
      {
        name: "AuthApiError",
        status: 403,
        code: "session_not_found",
        message: "Session from session_id claim in JWT does not exist",
      },
    ];
    for (const answer of liveness) {
      assertEquals(authRefusalKind(answer), "liveness", JSON.stringify(answer));
    }
    const credential: unknown[] = [
      {
        code: 403,
        error_code: "bad_jwt",
        msg: "invalid JWT: unable to parse or verify signature, token signature is invalid",
      },
      { code: 401, msg: "invalid JWT: unable to parse or verify signature" },
      {
        error: "invalid_grant",
        error_description: "Bad ID token",
        error_code: "bad_id_token",
      },
      { error: "invalid_grant", error_description: "Something else entirely" },
      {
        name: "AuthApiError",
        status: 400,
        code: "bad_id_token",
        message: "Bad ID token",
      },
      {},
      null,
      "not json",
    ];
    for (const answer of credential) {
      assertEquals(authRefusalKind(answer), "credential", JSON.stringify(answer));
    }
  },
);

Deno.test(
  "authFailureIdentity: trimmed text is one opaque identity; nothing of the credential survives",
  async () => {
    const { authFailureIdentity } = await loadPrimitives();
    const a = await authFailureIdentity("eyJ.secret.sig");
    assertEquals(await authFailureIdentity("  eyJ.secret.sig\t"), a);
    assert(/^[0-9a-f]{64}$/.test(a), `opaque digest, got ${a}`);
    assert(!a.includes("secret"));
    assert((await authFailureIdentity("eyJ.other.sig")) !== a);
  },
);

Deno.test(
  "minted: a bearer this edge minted is admitted to its first verification under stuffing; once expired or refused as forged it is gated like any other",
  async () => {
    await withPinnedClock(async (clock) => {
      const {
        authFailureIdentity,
        peekAuthFailureBudget,
        chargeAuthFailure,
        noteMintedCredential,
        peekRateLimit: peekIsolateLimit,
      } = await loadPrimitives();
      const budget = AUTH_FAILURE_LIMIT;
      const ip = "203.0.113.90";
      for (let i = 0; i < budget.limit; i += 1) {
        await chargeAuthFailure(
          "bearer",
          ip,
          await authFailureIdentity(`forged-${i}`),
          "credential",
          budget,
        );
      }
      const novel = await authFailureIdentity("never-seen");
      assertEquals((await peekAuthFailureBudget(ip, novel, budget)).allowed, false);

      const minted = `minted.${crypto.randomUUID()}.sig`;
      await noteMintedCredential(minted, 3_600);
      const identity = await authFailureIdentity(minted);
      assert((await peekAuthFailureBudget(ip, identity, budget)).allowed, "minted bearer");
      assert((await peekAuthFailureBudget(ip, ` ${minted} `, budget)).allowed, "raw text");

      // Refresh: Auth's refresh_token_not_found is liveness only for a token
      // this edge minted; for an unknown token it is a guess and charges the
      // egress signal like any other credential failure.
      const venue = "203.0.113.91";
      const venueSpent = async () =>
        spent(await peekIsolateLimit("authfail", venue, budget.limit, budget.windowSeconds));
      await chargeAuthFailure(
        "refresh",
        venue,
        await authFailureIdentity("rt-unknown"),
        "liveness",
        budget,
      );
      assertEquals(await venueSpent(), 1, "an unknown dead refresh token is a guess");
      const mintedRefresh = `rt-${crypto.randomUUID()}`;
      await noteMintedCredential(mintedRefresh, 86_400);
      await chargeAuthFailure("refresh", venue, mintedRefresh, "liveness", budget);
      assertEquals(await venueSpent(), 1, "a minted dead refresh token is a sign-out, not a guess");
      for (let i = 0; i < budget.limit; i += 1) {
        await chargeAuthFailure(
          "refresh",
          venue,
          await authFailureIdentity(`rt-${i}`),
          "liveness",
          budget,
        );
      }
      assertEquals(await venueSpent(), budget.limit);
      assertEquals(
        (await peekAuthFailureBudget(venue, `rt-${crypto.randomUUID()}`, budget)).allowed,
        false,
      );
      assert((await peekAuthFailureBudget(venue, mintedRefresh, budget)).allowed, "minted refresh");
      assert(
        (await peekAuthFailureBudget(venue, mintedRefresh, budget)).allowed,
        "dead but minted",
      );

      // Refused as forged after all: its own shard and the egress hold it.
      for (let i = 0; i < budget.limit; i += 1) {
        await chargeAuthFailure("bearer", ip, identity, "credential", budget);
      }
      assertEquals((await peekAuthFailureBudget(ip, identity, budget)).allowed, false);

      // Expiry returns a minted bearer to the ordinary gate.
      const shortLived = `minted.${crypto.randomUUID()}.sig`;
      await noteMintedCredential(shortLived, 60);
      assert((await peekAuthFailureBudget(ip, shortLived, budget)).allowed);
      clock.advance(61_000);
      assertEquals((await peekAuthFailureBudget(ip, shortLived, budget)).allowed, false);
    });
  },
);

Deno.test(
  "shard store: 25,000 distinct credential refusals from other egresses neither switch the budget off for a venue nor consume the limiter's window store",
  async () => {
    await withPinnedClock(async () => {
      const { authFailureIdentity, peekAuthFailureBudget, chargeAuthFailure, enforceRateLimit } =
        await loadPrimitives();
      const budget = AUTH_FAILURE_LIMIT;

      // Fifty egresses each present 500 distinct forged credentials.
      for (let i = 0; i < 25_000; i += 1) {
        const egress = `198.51.100.${(i % 50) + 1}`;
        await chargeAuthFailure(
          "bearer",
          egress,
          await authFailureIdentity(`forged-${i}`),
          "credential",
          budget,
        );
      }
      // Every flooding egress is under stuffing: never-seen credentials there are held.
      const heldElsewhere = await peekAuthFailureBudget(
        "198.51.100.7",
        await authFailureIdentity("forged-novel"),
        budget,
      );
      assertEquals(heldElsewhere.allowed, false);

      // The venue: one dead session replays; its shard still counts exactly.
      const venue = "203.0.113.77";
      const dead = await authFailureIdentity("dead-venue-session");
      for (let i = 0; i < budget.limit; i += 1) {
        const gate = await peekAuthFailureBudget(venue, dead, budget);
        assert(gate.allowed, `replay ${i + 1} is judged (remaining ${gate.remaining})`);
        await chargeAuthFailure("bearer", venue, dead, "liveness", budget);
      }
      const held = await peekAuthFailureBudget(venue, dead, budget);
      assertEquals(held.allowed, false, "the 31st replay is held");
      assertEquals(held.remaining, 0);

      // A never-seen credential on the venue is still admitted (its egress is
      // not under stuffing), and a forged one is charged to the egress.
      const novel = await authFailureIdentity("venue-novel");
      assert((await peekAuthFailureBudget(venue, novel, budget)).allowed);
      await chargeAuthFailure("bearer", venue, novel, "credential", budget);
      assertEquals(
        spent(await peekAuthFailureBudget(venue, await authFailureIdentity("venue-other"), budget)),
        1,
        "the egress signal is exact after the flood elsewhere",
      );

      // The general limiter is untouched by shard cardinality: a fresh IP is
      // admitted (a saturated window store would refuse it).
      const fresh = await enforceRateLimit("ip", "203.0.113.78", 1_200, 60);
      assertEquals(fresh.allowed, true);
      assertEquals(fresh.remaining, 1_199);
    });
  },
);
