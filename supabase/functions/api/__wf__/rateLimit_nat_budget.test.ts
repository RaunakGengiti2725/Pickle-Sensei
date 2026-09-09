// W11-01 — auth-failure budgets behind a shared NAT egress, through the REAL
// handler (routesHarness) plus the rateLimit.ts primitives (harness.ts).
//
// A venue (club Wi-Fi, carrier NAT) presents ONE client IP for many handsets.
// The auth-failure budget exists to starve credential stuffing; it must not
// let one co-tenant — or thirty signed-out handsets — lock the rest out:
//
//   * a refusal Supabase Auth issues for a credential it RECOGNISES but that
//     is dead (session logged out, refresh token rotated away, user
//     banned/deleted) is LIVENESS: it charges only that credential's own
//     shard, never the egress-wide stuffing signal, and keeps answering 401
//     (the app's sign-out signal; a 429 is retryable and hides it). Auth
//     answers `refresh_token_not_found` for a guess too, so for the refresh
//     grant the edge settles it by whether IT minted the token;
//   * a refusal for a credential Auth cannot recognise is a CREDENTIAL
//     failure: it charges the egress's stuffing signal (the flat budget's
//     `authfail` window, shared by bearer / bootstrap / refresh). Once thirty
//     guesses are charged, further never-seen or refused credentials from
//     that egress are held before Auth. Guesses in flight before the first
//     refusal lands are bounded by the per-IP route limits, as under the
//     flat budget — the bound here is per charged refusal, not per burst;
//   * refusals decided at the edge (no bearer, malformed, expired, a session
//     this edge already fenced at logout) never reached Auth and charge
//     nothing; an Auth outage (5xx / timeout) is not a verdict and charges
//     nothing either;
//   * an egress saturated by a co-tenant holds only never-seen and refused
//     credentials: cached bearers, the sessions this edge minted (however
//     long the handset was idle), the tokens those sessions rotate into and
//     dead sessions' 401s keep working for peers behind the same IP; a
//     brand-new sign-in waits for the window, as under the flat budget;
//   * nothing pre-Auth counts against a credential Auth never refused: a
//     valid bearer presented in a parallel burst is verified, never held;
//   * shard storage is bounded and rollback-safe, and attacker-chosen
//     cardinality can neither switch the budget off nor evict the rest of
//     the limiter.
//
// Known limit (documented, not pinned): without Redis (UPSTASH_* unset or
// erroring) the minted registry, shards and liveness marks are per isolate,
// so a sibling or restarted isolate treats sessions minted elsewhere as
// never-seen — the flat budget's behaviour for that degraded path.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json rateLimit_nat_budget.test.ts

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { peekRateLimit } from "../rateLimit.ts";
import { loadIsolate, type RateLimitModule } from "./harness.ts";
import {
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
const DAY_MS = 86_400_000;

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
const refreshNotFound = () =>
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

const refreshRequest = (ip: string, refreshToken: string) =>
  new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
    method: "POST",
    headers: { "x-forwarded-for": ip, "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });

const postRefresh = (handler: Handler, ip: string, refreshToken: string) =>
  send(handler, refreshRequest(ip, refreshToken));

const postBootstrap = (handler: Handler, ip: string, idToken: string) =>
  send(
    handler,
    userRequest("POST", "/v1/account/bootstrap", {
      token: idToken,
      ip,
      body: {},
    }),
  );

const postLogout = (handler: Handler, ip: string, bearer: string) =>
  send(handler, userRequest("POST", "/v1/auth/logout", { token: bearer, ip, body: {} }));

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
const sessionRefreshToken = (body: Record<string, unknown>) => sessionField(body, "refreshToken");

/** Sign a handset in through the edge (a refresh grant Auth honours) and
 * return the session the edge minted for it. */
async function mintHandset(
  handler: Handler,
  ip: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const minted = await sendJson(handler, refreshRequest(ip, `rt-live-${crypto.randomUUID()}`));
  assertEquals(minted.status, 200, "handset signed in");
  const session = {
    accessToken: sessionAccessToken(minted.body),
    refreshToken: sessionRefreshToken(minted.body),
  };
  assert(session.accessToken && session.refreshToken, "the edge handed the handset a session");
  return session;
}

/** Sign a NEW handset in the way the app does: spend a provider ID token on
 * bootstrap and keep the session the edge minted. */
async function bootstrapHandset(
  handler: Handler,
  ip: string,
  sub: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const signedIn = await sendJson(
    handler,
    userRequest("POST", "/v1/account/bootstrap", { token: googleIdToken(sub), ip, body: {} }),
  );
  assertEquals(signedIn.status, 200, "handset bootstrapped");
  const session = {
    accessToken: sessionAccessToken(signedIn.body),
    refreshToken: sessionRefreshToken(signedIn.body),
  };
  assert(session.accessToken && session.refreshToken, "bootstrap handed the handset a session");
  return session;
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
    usedRefresh?: Set<string>;
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
      const token = bodyField(call, "refresh_token");
      if (sets.deadRefresh?.has(token)) return refreshNotFound();
      if (sets.usedRefresh?.has(token)) return refreshAlreadyUsed();
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

/** Thirty distinct forged bearers from `ip`: the co-tenant flood that
 * saturates the egress's stuffing signal. */
async function floodForgedBearers(
  h: { handler: Handler; calls: RecordedCall[] },
  ip: string,
  forgedBearers: Set<string>,
): Promise<void> {
  const before = h.calls.filter(isUserCall).length;
  const judged = await repeat(AUTH_FAILURE_LIMIT.limit, (i) => {
    const bearer = supabaseBearer(`forged-${i}-${crypto.randomUUID()}`);
    forgedBearers.add(bearer);
    return readMe(h.handler, ip, bearer);
  });
  assertEquals(count(judged, 401), AUTH_FAILURE_LIMIT.limit, `flood statuses ${judged.join(",")}`);
  assertEquals(h.calls.filter(isUserCall).length, before + AUTH_FAILURE_LIMIT.limit);
  assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit, "the egress is saturated");
  const heldNovel = await readMe(h.handler, ip, supabaseBearer("novel-after-flood"));
  assertEquals(heldNovel.status, 429, "a never-seen bearer is held before Auth");
  assertRetryAfterBounded(heldNovel);
  assertEquals(h.calls.filter(isUserCall).length, before + AUTH_FAILURE_LIMIT.limit);
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
        handsets.push((await mintHandset(h.handler, ip)).refreshToken);
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
      const thirtyFirst = (await mintHandset(h.handler, ip)).refreshToken;
      deadRefresh.add(thirtyFirst);
      const late = await postRefresh(h.handler, ip, thirtyFirst);
      assertEquals(late.status, 401, "the app's ONE sign-out signal must not become 429");
      const peer = (await mintHandset(h.handler, ip)).refreshToken;
      const spare = (await mintHandset(h.handler, ip)).refreshToken;

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

Deno.test(
  "liveness: a refresh token Auth reports already used is a dead session even where this edge never minted it — 401, charged to its own shard only",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const usedRefresh = new Set<string>();
      installAuth(h, { usedRefresh });

      // Sessions rotated by another deployment / before a restart: nothing
      // here minted them, yet only a real token can be "already used".
      const stale = await repeat(PER_MINUTE_ROUTE_LIMIT, () => {
        const token = `rt-rotated-elsewhere-${crypto.randomUUID()}`;
        usedRefresh.add(token);
        return postRefresh(h.handler, ip, token);
      });
      assertEquals(count(stale, 401), PER_MINUTE_ROUTE_LIMIT, `statuses ${stale.join(",")}`);
      assertEquals(await egressCharged(ip), 0, "a rotated-away token is no guess");
      assertEquals(
        (await readMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID))).status,
        200,
      );
    });
  },
);

// ─── Refusals decided at this edge ───────────────────────────────────────────

Deno.test(
  "local: thirty bearers of sessions logged out AT THIS EDGE are refused by the revocation fence, reach Auth 0 times and charge nothing; a peer's novel bearer then verifies",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      installAuth(h, {});

      const handsets: string[] = [];
      for (let i = 0; i < PER_MINUTE_ROUTE_LIMIT; i += 1) {
        handsets.push((await mintHandset(h.handler, ip)).accessToken);
      }
      for (const bearer of handsets) {
        assertEquals((await postLogout(h.handler, ip, bearer)).status, 204, "logged out");
      }
      const userCallsAfterLogout = h.calls.filter(isUserCall).length;

      // The handsets (or their stale tabs) keep presenting the fenced bearer.
      clock.advance(60_000);
      const fenced = await repeat(PER_MINUTE_ROUTE_LIMIT, (i) =>
        readMe(h.handler, ip, handsets[i]),
      );
      assertEquals(count(fenced, 401), PER_MINUTE_ROUTE_LIMIT, `statuses ${fenced.join(",")}`);
      assertEquals(h.calls.filter(isUserCall).length, userCallsAfterLogout, "fenced locally");
      assertEquals(await egressCharged(ip), 0, "a fence this edge applied is not a guess");

      const peer = await readMe(h.handler, ip, fakeSupabaseAccessToken(OTHER_USER_ID));
      assertEquals(peer.status, 200, "a peer's first request is still eligible for Auth");
      assertEquals(h.calls.filter(isUserCall).length, userCallsAfterLogout + 1);
    });
  },
);

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

Deno.test(
  "outage: Auth answering 5xx is not a verdict — forty novel bearers get 503, nothing is charged, and the first bearer after recovery verifies",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      h.userStatus = 503;
      const statuses = await repeat(40, () =>
        readMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID)),
      );
      assertEquals(count(statuses, 503), 40, `statuses ${statuses.join(",")}`);
      assertEquals(await egressCharged(ip), 0);
      h.userStatus = 200;
      assertEquals(
        (await readMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID))).status,
        200,
      );
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
      const refresh = await sendJson(h.handler, refreshRequest(ip, handset.refreshToken));
      const rotated = sessionAccessToken(refresh.body);
      const rotatedRefresh = sessionRefreshToken(refresh.body);
      const venue = {
        cachedRead: (await readMe(h.handler, ip, established)).status,
        mintedRead: (await readMe(h.handler, ip, handset.accessToken)).status,
        refresh: refresh.status,
        rotatedRead: rotated ? (await readMe(h.handler, ip, rotated)).status : -1,
        rotatedAgain: rotatedRefresh
          ? (await postRefresh(h.handler, ip, rotatedRefresh)).status
          : -1,
        deadHandset: (await readMe(h.handler, ip, deadHandset)).status,
      };
      assertEquals(venue, {
        cachedRead: 200,
        mintedRead: 200,
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
      const minted = await bootstrapHandset(h.handler, ip, OTHER_USER_ID);
      assertEquals((await readMe(h.handler, ip, minted.accessToken)).status, 200);
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
      const doomed = (await bootstrapHandset(h.handler, ip, OTHER_USER_ID)).accessToken;
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
      assertEquals((await postRefresh(h.handler, ip, handset.refreshToken)).status, 200);
      deadBearers.add(doomed);
      assertEquals((await readMe(h.handler, ip, doomed)).status, 401, "the ONE sign-out signal");
      assertEquals((await readMe(h.handler, ip, doomed)).status, 401, "and it stays 401");
      assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit, "a dead session is no guess");
    });
  },
);

Deno.test(
  "idle handset: a session bootstrapped forty days ago (never rotated since) refreshes through a co-tenant flood — Auth judges it, the rotated bearer verifies and the next rotation is admitted too",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const forgedBearers = new Set<string>();
      installAuth(h, { forgedBearers });

      // Friday: the handset signs in. Then it sits in a bag for weeks.
      const handset = await bootstrapHandset(h.handler, ip, OTHER_USER_ID);
      clock.advance(40 * DAY_MS);

      // Its first morning back, a co-tenant floods the venue's egress.
      await floodForgedBearers(h, ip, forgedBearers);
      const refreshCallsBefore = h.calls.filter(isRefreshCall).length;

      // The handset's own (Auth-valid) refresh token must reach Auth.
      const refreshed = await sendJson(h.handler, refreshRequest(ip, handset.refreshToken));
      assertEquals(refreshed.status, 200, "the venue's own session refreshes through the flood");
      assertEquals(h.calls.filter(isRefreshCall).length, refreshCallsBefore + 1, "judged by Auth");

      const rotated = {
        accessToken: sessionAccessToken(refreshed.body),
        refreshToken: sessionRefreshToken(refreshed.body),
      };
      assert(rotated.accessToken && rotated.refreshToken);
      assertEquals(
        (await readMe(h.handler, ip, rotated.accessToken)).status,
        200,
        "rotated bearer",
      );

      // Fifty minutes on the flood is still running (a fresh window, thirty
      // fresh guesses): the rotated-into token is vouched for as well.
      clock.advance(50 * 60_000);
      await floodForgedBearers(h, ip, forgedBearers);
      const refreshCallsLater = h.calls.filter(isRefreshCall).length;
      assertEquals(
        (await postRefresh(h.handler, ip, rotated.refreshToken)).status,
        200,
        "the next rotation an hour later is admitted as well",
      );
      assertEquals(h.calls.filter(isRefreshCall).length, refreshCallsLater + 1);
    });
  },
);

Deno.test(
  "idle handset: a session bootstrapped 25 hours ago (an overnight-idle handset) refreshes through a co-tenant flood",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const forgedBearers = new Set<string>();
      installAuth(h, { forgedBearers });

      const handset = await bootstrapHandset(h.handler, ip, OTHER_USER_ID);
      clock.advance(25 * 3_600_000);
      await floodForgedBearers(h, ip, forgedBearers);
      const refreshCallsBefore = h.calls.filter(isRefreshCall).length;
      assertEquals((await postRefresh(h.handler, ip, handset.refreshToken)).status, 200);
      assertEquals(h.calls.filter(isRefreshCall).length, refreshCallsBefore + 1);
    });
  },
);

Deno.test(
  "rotation: the refresh token a handset just rotated away stays admitted for a retry within the hour (Auth honours its reuse interval), and is a guess again once the grace has passed",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const forgedBearers = new Set<string>();
      installAuth(h, { forgedBearers });

      const handset = await mintHandset(h.handler, ip);
      const rotated = await sendJson(h.handler, refreshRequest(ip, handset.refreshToken));
      assertEquals(rotated.status, 200);
      const next = sessionRefreshToken(rotated.body);
      assert(next);

      await floodForgedBearers(h, ip, forgedBearers);
      const refreshCallsBefore = h.calls.filter(isRefreshCall).length;

      // The handset never received the rotation answer and retries with the
      // token it still holds: Auth, not the budget, decides that.
      clock.advance(5_000);
      assertEquals((await postRefresh(h.handler, ip, handset.refreshToken)).status, 200);
      assertEquals(h.calls.filter(isRefreshCall).length, refreshCallsBefore + 1);
      // The current token is admitted regardless.
      assertEquals((await postRefresh(h.handler, ip, next)).status, 200);
      assertEquals(h.calls.filter(isRefreshCall).length, refreshCallsBefore + 2);

      // Two hours on, the flood persists (fresh window, fresh thirty guesses):
      // the long-rotated-away token is no longer vouched for.
      clock.advance(2 * 3_600_000);
      await floodForgedBearers(h, ip, forgedBearers);
      const refreshCallsLater = h.calls.filter(isRefreshCall).length;
      assertEquals((await postRefresh(h.handler, ip, handset.refreshToken)).status, 429);
      assertEquals(h.calls.filter(isRefreshCall).length, refreshCallsLater);
    });
  },
);

// ─── Nothing pre-Auth counts against a credential Auth never refused ─────────

Deno.test(
  "valid bearer: forty parallel first requests with one never-seen, Auth-accepted bearer are all 200 — an auth-FAILURE budget never throttles a credential Auth accepts",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      installAuth(h, {});
      const bearer = fakeSupabaseAccessToken(TEST_USER_ID);

      const statuses = (
        await Promise.all(Array.from({ length: 40 }, () => readMe(h.handler, ip, bearer)))
      ).map((response) => response.status);
      assertEquals(count(statuses, 200), 40, `statuses ${statuses.join(",")}`);
      assertEquals(await egressCharged(ip), 0);
      assert(h.calls.filter(isUserCall).length >= 1, "Auth judged the bearer");
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
  "shard: sixty simultaneous replays of one dead session are accounted atomically — every judged replay is a 401 on the shard, none on the egress, and the next replay is held",
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

// ─── Primitives (rateLimit.ts in isolation) ──────────────────────────────────

async function loadPrimitives(): Promise<RateLimitModule> {
  const isolate = await loadIsolate();
  const exported = isolate.rateLimit as unknown as Record<string, unknown>;
  for (const name of [
    "authRefusalKind",
    "authCredentialIdentity",
    "peekAuthFailureBudget",
    "chargeAuthFailure",
    "noteMintedSession",
  ]) {
    assert(typeof exported[name] === "function", `rateLimit.ts exports ${name}`);
  }
  return isolate.rateLimit;
}

Deno.test(
  "authRefusalKind: GoTrue's dead-credential answers are liveness, refresh_token_not_found is settled by the registry, unrecognised credentials are credential failures",
  async () => {
    const { authRefusalKind } = await loadPrimitives();
    const liveness: unknown[] = [
      {
        error: "invalid_grant",
        error_description: "Invalid Refresh Token: Already Used",
        error_code: "refresh_token_already_used",
      },
      { error: "invalid_grant", error_description: "Invalid Refresh Token: Already Used" },
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
        code: "user_banned",
        message: "User is banned",
      },
    ];
    for (const answer of liveness) {
      assertEquals(authRefusalKind(answer), "liveness", JSON.stringify(answer));
    }
    const unknownToken: unknown[] = [
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
        name: "AuthApiError",
        status: 400,
        code: "refresh_token_not_found",
        message: "Invalid Refresh Token: Refresh Token Not Found",
      },
    ];
    for (const answer of unknownToken) {
      assertEquals(authRefusalKind(answer), "unknown-token", JSON.stringify(answer));
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
      { error_code: 42, msg: 17 },
    ];
    for (const answer of credential) {
      assertEquals(authRefusalKind(answer), "credential", JSON.stringify(answer));
    }
  },
);

Deno.test(
  "authCredentialIdentity: trimmed text is one opaque identity, nothing of the credential survives, and a credential that already looks like a digest is hashed like any other",
  async () => {
    const { authCredentialIdentity } = await loadPrimitives();
    const a = await authCredentialIdentity("eyJ.secret.sig");
    assertEquals(await authCredentialIdentity("  eyJ.secret.sig\t"), a);
    assert(/^[0-9a-f]{64}$/.test(a), `opaque digest, got ${a}`);
    assert(!a.includes("secret"));
    assertNotEquals(await authCredentialIdentity("eyJ.other.sig"), a);

    const hexShaped = "a".repeat(64);
    const viaIdentity = await authCredentialIdentity(hexShaped);
    assertNotEquals(viaIdentity, hexShaped, "a raw credential is never its own identity");
    assertEquals(await authCredentialIdentity(` ${hexShaped} `), viaIdentity);
  },
);

Deno.test(
  "minted: a session this edge minted is vouched for under stuffing — the access token until its expiry, the refresh token through weeks of idleness and for an hour after it was rotated away; refresh_token_not_found charges the egress only for tokens never minted here",
  async () => {
    await withPinnedClock(async (clock) => {
      const {
        authCredentialIdentity,
        peekAuthFailureBudget,
        chargeAuthFailure,
        noteMintedSession,
        peekRateLimit: peekIsolateLimit,
      } = await loadPrimitives();
      const budget = AUTH_FAILURE_LIMIT;
      const nowSeconds = () => Math.floor(Date.now() / 1000);
      const saturate = async (egress: string) => {
        for (let i = 0; i < budget.limit; i += 1) {
          await chargeAuthFailure(
            egress,
            await authCredentialIdentity(`forged-${egress}-${i}-${crypto.randomUUID()}`),
            "credential",
            budget,
          );
        }
        const novel = await authCredentialIdentity(`never-seen-${crypto.randomUUID()}`);
        assertEquals((await peekAuthFailureBudget(egress, novel, budget)).allowed, false);
      };
      const egressSpent = async (egress: string) =>
        spent(await peekIsolateLimit("authfail", egress, budget.limit, budget.windowSeconds));

      // A session minted now, presented through a saturated egress.
      const ip = "203.0.113.90";
      await saturate(ip);
      const session = {
        accessToken: `minted.${crypto.randomUUID()}.sig`,
        refreshToken: `rt-${crypto.randomUUID()}`,
        expiresAt: nowSeconds() + 3_600,
      };
      await noteMintedSession(session);
      const bearer = await authCredentialIdentity(session.accessToken);
      const refresh = await authCredentialIdentity(session.refreshToken);
      assert((await peekAuthFailureBudget(ip, bearer, budget)).allowed, "minted bearer");
      assert(
        (
          await peekAuthFailureBudget(
            ip,
            await authCredentialIdentity(` ${session.accessToken} `),
            budget,
          )
        ).allowed,
        "whitespace around the bearer",
      );
      assert((await peekAuthFailureBudget(ip, refresh, budget)).allowed, "minted refresh");

      // The access token is vouched for exactly until its exp; the refresh
      // token outlives it by weeks of idleness (the handset in a bag). Every
      // step is a fresh window, so the egress is saturated again each time.
      clock.advance(3_601_000);
      await saturate(ip);
      assertEquals(
        (await peekAuthFailureBudget(ip, bearer, budget)).allowed,
        false,
        "expired bearer",
      );
      assert((await peekAuthFailureBudget(ip, refresh, budget)).allowed, "an hour idle");
      clock.advance(40 * DAY_MS);
      await saturate(ip);
      assert((await peekAuthFailureBudget(ip, refresh, budget)).allowed, "forty days idle");

      // Rotation: the token rotated away keeps an hour's grace (Auth's reuse
      // interval lets a handset that missed the answer retry), then lapses.
      const rotated = {
        accessToken: `minted.${crypto.randomUUID()}.sig`,
        refreshToken: `rt-${crypto.randomUUID()}`,
        expiresAt: nowSeconds() + 3_600,
      };
      await noteMintedSession(rotated, session.refreshToken);
      const rotatedRefresh = await authCredentialIdentity(rotated.refreshToken);
      assert((await peekAuthFailureBudget(ip, refresh, budget)).allowed, "just rotated away");
      clock.advance(59 * 60_000);
      await saturate(ip);
      assert((await peekAuthFailureBudget(ip, refresh, budget)).allowed, "59 minutes later");
      clock.advance(2 * 60_000);
      await saturate(ip);
      assertEquals((await peekAuthFailureBudget(ip, refresh, budget)).allowed, false, "grace over");
      assert(
        (await peekAuthFailureBudget(ip, rotatedRefresh, budget)).allowed,
        "the current token",
      );

      // A refresh token idle for over a year is no longer vouched for (the
      // registry's hygiene bound); Auth still judges it once the window turns.
      clock.advance(366 * DAY_MS);
      await saturate(ip);
      assertEquals((await peekAuthFailureBudget(ip, rotatedRefresh, budget)).allowed, false);

      // refresh_token_not_found: liveness for a token this edge minted (a
      // sign-out), a guess for anything else.
      const venue = "203.0.113.91";
      assertEquals(
        await chargeAuthFailure(
          venue,
          await authCredentialIdentity("rt-unknown"),
          "unknown-token",
          budget,
        ),
        "credential",
      );
      assertEquals(await egressSpent(venue), 1, "an unknown dead refresh token is a guess");
      const mintedRefresh = {
        accessToken: `minted.${crypto.randomUUID()}.sig`,
        refreshToken: `rt-${crypto.randomUUID()}`,
        expiresAt: nowSeconds() + 3_600,
      };
      await noteMintedSession(mintedRefresh);
      const mintedIdentity = await authCredentialIdentity(mintedRefresh.refreshToken);
      assertEquals(
        await chargeAuthFailure(venue, mintedIdentity, "unknown-token", budget),
        "liveness",
      );
      assertEquals(await egressSpent(venue), 1, "a minted dead refresh token is a sign-out");
      assertEquals(
        await chargeAuthFailure(venue, await authCredentialIdentity("rt-x"), "liveness", budget),
        "liveness",
      );
      assertEquals(
        await egressSpent(venue),
        1,
        "already_used is a sign-out wherever it was minted",
      );

      // Refused as forged after all: its own shard and the egress hold it.
      for (let i = 0; i < budget.limit; i += 1) {
        await chargeAuthFailure(ip, bearer, "credential", budget);
      }
      assertEquals((await peekAuthFailureBudget(ip, bearer, budget)).allowed, false);
    });
  },
);

Deno.test(
  "minted registry: a venue session presented while 55,000 later sessions are minted on the isolate stays vouched for (recently used entries survive eviction); a never-presented one from before them is forgotten",
  async () => {
    await withPinnedClock(async () => {
      const {
        authCredentialIdentity,
        peekAuthFailureBudget,
        chargeAuthFailure,
        noteMintedSession,
      } = await loadPrimitives();
      const budget = AUTH_FAILURE_LIMIT;
      const ip = "203.0.113.92";
      const expiresAt = Math.floor(Date.now() / 1000) + 3_600;
      for (let i = 0; i < budget.limit; i += 1) {
        await chargeAuthFailure(
          ip,
          await authCredentialIdentity(`forged-${i}`),
          "credential",
          budget,
        );
      }

      const venue = {
        accessToken: `venue.${crypto.randomUUID()}`,
        refreshToken: "rt-venue",
        expiresAt,
      };
      const idle = {
        accessToken: `idle.${crypto.randomUUID()}`,
        refreshToken: "rt-idle",
        expiresAt,
      };
      await noteMintedSession(venue);
      await noteMintedSession(idle);
      const venueBearer = await authCredentialIdentity(venue.accessToken);
      const idleBearer = await authCredentialIdentity(idle.accessToken);

      for (let i = 0; i < 55_000; i += 1) {
        await noteMintedSession({ accessToken: `a-${i}`, refreshToken: `r-${i}`, expiresAt });
        if (i % 5_000 === 0) {
          assert((await peekAuthFailureBudget(ip, venueBearer, budget)).allowed, `at mint ${i}`);
        }
      }
      assert((await peekAuthFailureBudget(ip, venueBearer, budget)).allowed, "still vouched for");
      assertEquals((await peekAuthFailureBudget(ip, idleBearer, budget)).allowed, false, "evicted");
    });
  },
);

Deno.test(
  "clock rollback: a two-second backward step across a bucket boundary forgets neither a credential's refusals nor its liveness admission",
  async () => {
    await withPinnedClock(async (clock) => {
      const {
        authCredentialIdentity,
        peekAuthFailureBudget,
        chargeAuthFailure,
        peekRateLimit: peekIsolateLimit,
      } = await loadPrimitives();
      const budget = AUTH_FAILURE_LIMIT;
      const ip = "203.0.113.93";
      const dead = await authCredentialIdentity("dead-rollback");
      for (let i = 0; i < budget.limit; i += 1) {
        await chargeAuthFailure(ip, dead, "liveness", budget);
      }
      assertEquals((await peekAuthFailureBudget(ip, dead, budget)).allowed, false, "held");
      assertEquals(
        spent(await peekIsolateLimit("authfail", ip, budget.limit, budget.windowSeconds)),
        0,
      );

      // The pinned clock sits one second into the window: -2 s crosses back
      // into the previous bucket, +2 s returns.
      clock.advance(-2_000);
      await peekAuthFailureBudget(ip, dead, budget);
      clock.advance(2_000);
      const after = await peekAuthFailureBudget(ip, dead, budget);
      assertEquals(after.allowed, false, "still held after the clock hiccup");
      assertEquals(after.remaining, 0);

      // Liveness admission survives too: saturate the egress, the dead
      // credential (liveness-marked) is admitted at the shard's next window
      // while never-seen ones are held.
      for (let i = 0; i < budget.limit; i += 1) {
        await chargeAuthFailure(
          ip,
          await authCredentialIdentity(`forged-${i}`),
          "credential",
          budget,
        );
      }
      const marked = await authCredentialIdentity("dead-marked");
      await chargeAuthFailure(ip, marked, "liveness", budget);
      clock.advance(-2_000);
      await peekAuthFailureBudget(ip, marked, budget);
      clock.advance(2_000);
      assert((await peekAuthFailureBudget(ip, marked, budget)).allowed, "liveness mark kept");
      assertEquals(
        (await peekAuthFailureBudget(ip, await authCredentialIdentity("never-seen"), budget))
          .allowed,
        false,
      );
    });
  },
);

Deno.test(
  "shard store: 20,000 distinct credential refusals from other egresses neither switch the budget off for a venue nor consume the limiter's window store",
  async () => {
    await withPinnedClock(async () => {
      const { authCredentialIdentity, peekAuthFailureBudget, chargeAuthFailure, enforceRateLimit } =
        await loadPrimitives();
      const budget = AUTH_FAILURE_LIMIT;

      // Fifty egresses each present 400 distinct forged credentials.
      for (let i = 0; i < 20_000; i += 1) {
        const egress = `198.51.100.${(i % 50) + 1}`;
        await chargeAuthFailure(
          egress,
          await authCredentialIdentity(`forged-${i}`),
          "credential",
          budget,
        );
      }
      // Every flooding egress is under stuffing: never-seen credentials there are held.
      const heldElsewhere = await peekAuthFailureBudget(
        "198.51.100.7",
        await authCredentialIdentity("forged-novel"),
        budget,
      );
      assertEquals(heldElsewhere.allowed, false);

      // The venue: one dead session replays; its shard still counts exactly.
      const venue = "203.0.113.77";
      const dead = await authCredentialIdentity("dead-venue-session");
      for (let i = 0; i < budget.limit; i += 1) {
        const gate = await peekAuthFailureBudget(venue, dead, budget);
        assert(gate.allowed, `replay ${i + 1} is judged (remaining ${gate.remaining})`);
        await chargeAuthFailure(venue, dead, "liveness", budget);
      }
      const held = await peekAuthFailureBudget(venue, dead, budget);
      assertEquals(held.allowed, false, "the 31st replay is held");
      assertEquals(held.remaining, 0);

      // A never-seen credential on the venue is still admitted (its egress is
      // not under stuffing), and a forged one is charged to the egress.
      const novel = await authCredentialIdentity("venue-novel");
      assert((await peekAuthFailureBudget(venue, novel, budget)).allowed);
      await chargeAuthFailure(venue, novel, "credential", budget);
      assertEquals(
        spent(
          await peekAuthFailureBudget(venue, await authCredentialIdentity("venue-other"), budget),
        ),
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
