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
//     (the app's sign-out signal; a 429 is retryable and hides it);
//   * a refusal for a credential Auth cannot recognise is a CREDENTIAL
//     failure: it charges the egress's stuffing signal for that credential
//     class (bearer / bootstrap / refresh), so forged novelty is bounded
//     before it reaches Auth exactly as the flat budget bounded it;
//   * refusals decided at the edge (no bearer, malformed, expired, wrong
//     scheme) never reached Auth and charge nothing;
//   * a credential class saturated by a co-tenant holds novel and refused
//     credentials of THAT class only: cached bearers, refreshes, sign-ins
//     and the tokens they mint keep working for peers behind the same IP;
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
  jwtOf({ iss: "https://accounts.google.com", sub, exp, salt: crypto.randomUUID() });

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
/** The bearer class's egress-wide stuffing signal (the historical `authfail` window). */
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
    new Request("http://edge.test/functions/v1/api/v1/me", { method: "GET", headers }),
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
  send(handler, userRequest("POST", "/v1/account/bootstrap", { token: idToken, ip, body: {} }));

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

const sessionAccessToken = (body: Record<string, unknown>): string => {
  const session = body.session;
  if (typeof session !== "object" || session === null) return "";
  const token = (session as Record<string, unknown>).accessToken;
  return typeof token === "string" ? token : "";
};

const repeat = async (times: number, run: (i: number) => Promise<Response>): Promise<number[]> => {
  const statuses: number[] = [];
  for (let i = 0; i < times; i += 1) statuses.push((await run(i)).status);
  return statuses;
};

const count = (statuses: number[], status: number) => statuses.filter((s) => s === status).length;

const assertRetryAfterBounded = (response: Response) => {
  const retryAfter = Number(response.headers.get("Retry-After"));
  assert(
    Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= AUTH_FAILURE_LIMIT.windowSeconds,
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
  h: { respond: (call: RecordedCall) => Response | null | Promise<Response | null> },
  sets: { deadBearers?: Set<string>; forgedBearers?: Set<string>; deadRefresh?: Set<string> },
) {
  h.respond = (call) => {
    if (isUserCall(call)) {
      const bearer = bearerOfCall(call);
      if (sets.deadBearers?.has(bearer)) return sessionGone();
      if (sets.forgedBearers?.has(bearer)) return credentialRefused();
      return null;
    }
    if (isRefreshCall(call)) {
      if (sets.deadRefresh?.has(bodyField(call, "refresh_token"))) return refreshRefused();
      return mintedSession(TEST_USER_ID);
    }
    if (isIdTokenCall(call)) {
      const idToken = bodyField(call, "id_token");
      if (sets.forgedBearers?.has(idToken)) return idTokenRefused();
      return null;
    }
    return null;
  };
}

// ─── Liveness ────────────────────────────────────────────────────────────────

Deno.test(
  "liveness: thirty signed-out handsets refreshing behind one NAT leave the stuffing signal at 0 and the 31st dead session is still told 401",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      const ip = freshIp();
      const deadRefresh = new Set<string>();
      installAuth(h, { deadRefresh });
      const deadHandset = () => {
        const token = `rt-logged-out-${crypto.randomUUID()}`;
        deadRefresh.add(token);
        return token;
      };

      const handsets = await repeat(PER_MINUTE_ROUTE_LIMIT, () =>
        postRefresh(h.handler, ip, deadHandset()),
      );
      assertEquals(count(handsets, 401), PER_MINUTE_ROUTE_LIMIT, `statuses ${handsets.join(",")}`);
      assertEquals(h.calls.filter(isRefreshCall).length, PER_MINUTE_ROUTE_LIMIT);
      assertEquals(await egressCharged(ip), 0, "dead sessions are not a stuffing signal");

      clock.advance(60_000);
      const thirtyFirst = await postRefresh(h.handler, ip, deadHandset());
      assertEquals(thirtyFirst.status, 401, "the app's ONE sign-out signal must not become 429");
      assertEquals(h.calls.filter(isRefreshCall).length, PER_MINUTE_ROUTE_LIMIT + 1);

      // A live peer behind the same NAT still rotates.
      const live = await postRefresh(h.handler, ip, `rt-live-${crypto.randomUUID()}`);
      assertEquals(live.status, 200);
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
      assertEquals(count(statuses, 401), AUTH_FAILURE_LIMIT.limit, `statuses ${statuses.join(",")}`);
      assertEquals(h.calls.filter(isUserCall).length, AUTH_FAILURE_LIMIT.limit);
      assertEquals(await egressCharged(ip), 0);

      const peerBearer = fakeSupabaseAccessToken(TEST_USER_ID);
      assertEquals((await readMe(h.handler, ip, peerBearer)).status, 200, "novel valid bearer");
      assertEquals(h.calls.filter(isUserCall).length, AUTH_FAILURE_LIMIT.limit + 1, "verified");
      assertEquals((await postRefresh(h.handler, ip, `rt-live-${crypto.randomUUID()}`)).status, 200);
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
  "stuffing: after thirty forged bearers, novel and replayed forged bearers are 429 before Auth while the venue's cached bearer, refresh, sign-in and minted tokens keep working",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const deadBearers = new Set<string>();
      const forgedBearers = new Set<string>();
      installAuth(h, { deadBearers, forgedBearers });

      // Before the flood: a peer's established session (verified once, cached)
      // and a handset whose session was logged out from another device.
      const established = fakeSupabaseAccessToken(TEST_USER_ID);
      assertEquals((await readMe(h.handler, ip, established)).status, 200);
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
          headers: { "x-forwarded-for": ip, "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: `rt-live-${crypto.randomUUID()}` }),
        }),
      );
      const rotated = sessionAccessToken(refresh.body);
      const bootstrap = await sendJson(
        h.handler,
        userRequest("POST", "/v1/account/bootstrap", {
          token: googleIdToken(OTHER_USER_ID),
          ip,
          body: {},
        }),
      );
      const minted = sessionAccessToken(bootstrap.body);
      const venue = {
        cachedRead: (await readMe(h.handler, ip, established)).status,
        refresh: refresh.status,
        rotatedRead: rotated ? (await readMe(h.handler, ip, rotated)).status : -1,
        bootstrap: bootstrap.status,
        mintedRead: minted ? (await readMe(h.handler, ip, minted)).status : -1,
        deadHandset: (await readMe(h.handler, ip, deadHandset)).status,
      };
      assertEquals(venue, {
        cachedRead: 200,
        refresh: 200,
        rotatedRead: 200,
        bootstrap: 200,
        mintedRead: 200,
        deadHandset: 401,
      });
    });
  },
);

Deno.test(
  "stuffing: forged ID tokens on bootstrap are bounded to the budget upstream and hold neither the venue's session bearers nor its refreshes",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const forgedBearers = new Set<string>();
      installAuth(h, { forgedBearers });
      const forgedIdToken = () => {
        const token = googleIdToken(crypto.randomUUID());
        forgedBearers.add(token);
        return token;
      };

      const statuses: number[] = [];
      for (let minute = 0; minute < 2; minute += 1) {
        for (let i = 0; i < PER_MINUTE_ROUTE_LIMIT; i += 1) {
          statuses.push((await postBootstrap(h.handler, ip, forgedIdToken())).status);
        }
        if (minute === 0) clock.advance(60_000);
      }
      assertEquals(count(statuses, 401), AUTH_FAILURE_LIMIT.limit, `statuses ${statuses.join(",")}`);
      assertEquals(count(statuses, 429), PER_MINUTE_ROUTE_LIMIT, `statuses ${statuses.join(",")}`);
      assertEquals(h.calls.filter(isIdTokenCall).length, AUTH_FAILURE_LIMIT.limit);

      assertEquals((await readMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID))).status, 200);
      assertEquals((await postRefresh(h.handler, ip, `rt-live-${crypto.randomUUID()}`)).status, 200);
      assertEquals(await egressCharged(ip), 0, "bootstrap stuffing is not the bearer class");
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
      assertEquals((await readMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID))).status, 200);

      // Same credential from another egress: the shard follows the credential.
      const elsewhere = await readMe(h.handler, freshIp(), dead);
      assertEquals(elsewhere.status, 429);

      clock.advance(AUTH_FAILURE_LIMIT.windowSeconds * 1_000);
      const nextWindow = await readMe(h.handler, ip, dead);
      assertEquals(nextWindow.status, 401, "a new window judges the credential again");
      assertEquals(h.calls.filter(isUserCall).length, AUTH_FAILURE_LIMIT.limit + 1);
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

// ─── Primitives (rateLimit.ts in isolation) ──────────────────────────────────

type Primitives = {
  authRefusalKind: (error: unknown) => string;
  authFailureIdentity: (credential: string) => Promise<string>;
  peekAuthFailureBudget: (
    cls: string,
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
  ]) {
    assert(typeof rl[name] === "function", `rateLimit.ts exports ${name}`);
  }
  return rl as unknown as Primitives;
}

Deno.test("authRefusalKind: GoTrue's dead-credential answers are liveness, unrecognised credentials are credential failures", async () => {
  const { authRefusalKind } = await loadPrimitives();
  const liveness: unknown[] = [
    {
      error: "invalid_grant",
      error_description: "Invalid Refresh Token: Refresh Token Not Found",
      error_code: "refresh_token_not_found",
    },
    { error: "invalid_grant", error_description: "Invalid Refresh Token: Refresh Token Not Found" },
    {
      error: "invalid_grant",
      error_description: "Invalid Refresh Token: Already Used",
      error_code: "refresh_token_already_used",
    },
    { code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" },
    { code: 403, msg: "Session from session_id claim in JWT does not exist" },
    { code: 403, error_code: "session_expired", msg: "Session has expired" },
    { code: 403, error_code: "user_not_found", msg: "User from sub claim in JWT does not exist" },
    { code: 403, error_code: "user_banned", msg: "User is banned" },
    { code: 401, error_code: "bad_jwt", msg: "invalid JWT: unable to parse or verify signature, token is expired by 12s" },
    { name: "AuthApiError", status: 403, code: "session_not_found", message: "Session from session_id claim in JWT does not exist" },
  ];
  for (const answer of liveness) {
    assertEquals(authRefusalKind(answer), "liveness", JSON.stringify(answer));
  }
  const credential: unknown[] = [
    { code: 403, error_code: "bad_jwt", msg: "invalid JWT: unable to parse or verify signature, token signature is invalid" },
    { code: 401, msg: "invalid JWT: unable to parse or verify signature" },
    { error: "invalid_grant", error_description: "Bad ID token", error_code: "bad_id_token" },
    { error: "invalid_grant", error_description: "Something else entirely" },
    { name: "AuthApiError", status: 400, code: "bad_id_token", message: "Bad ID token" },
    {},
    null,
    "not json",
  ];
  for (const answer of credential) {
    assertEquals(authRefusalKind(answer), "credential", JSON.stringify(answer));
  }
});

Deno.test("authFailureIdentity: trimmed text is one opaque identity; nothing of the credential survives", async () => {
  const { authFailureIdentity } = await loadPrimitives();
  const a = await authFailureIdentity("eyJ.secret.sig");
  assertEquals(await authFailureIdentity("  eyJ.secret.sig\t"), a);
  assert(/^[0-9a-f]{64}$/.test(a), `opaque digest, got ${a}`);
  assert(!a.includes("secret"));
  assert((await authFailureIdentity("eyJ.other.sig")) !== a);
});

Deno.test(
  "shard store: 25,000 distinct credential refusals from other egresses neither switch the budget off for a venue nor consume the limiter's window store",
  async () => {
    await withPinnedClock(async () => {
      const { authFailureIdentity, peekAuthFailureBudget, chargeAuthFailure, enforceRateLimit } =
        await loadPrimitives();
      const budget = AUTH_FAILURE_LIMIT;

      for (let i = 0; i < 25_000; i += 1) {
        const egress = `198.51.${Math.floor(i / 250) % 250}.${(i % 250) + 1}`;
        await chargeAuthFailure("bearer", egress, await authFailureIdentity(`forged-${i}`), "credential", budget);
      }

      // The venue: one dead session replays; its shard still counts exactly.
      const venue = "203.0.113.77";
      const dead = await authFailureIdentity("dead-venue-session");
      for (let i = 0; i < budget.limit; i += 1) {
        const gate = await peekAuthFailureBudget("bearer", venue, dead, budget);
        assert(gate.allowed, `replay ${i + 1} is judged (remaining ${gate.remaining})`);
        await chargeAuthFailure("bearer", venue, dead, "liveness", budget);
      }
      const held = await peekAuthFailureBudget("bearer", venue, dead, budget);
      assertEquals(held.allowed, false, "the 31st replay is held");
      assertEquals(held.remaining, 0);

      // A never-seen credential on the venue is still admitted (its egress is
      // not under stuffing), and a forged one is charged to the egress.
      const novel = await authFailureIdentity("venue-novel");
      assert((await peekAuthFailureBudget("bearer", venue, novel, budget)).allowed);
      await chargeAuthFailure("bearer", venue, novel, "credential", budget);
      assertEquals(
        spent(await peekAuthFailureBudget("bearer", venue, await authFailureIdentity("venue-other"), budget)),
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
