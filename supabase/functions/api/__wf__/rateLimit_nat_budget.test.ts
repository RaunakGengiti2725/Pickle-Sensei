// Auth-failure budgets behind a shared NAT egress (W11-01).
//
// A club Wi-Fi, a carrier NAT or a corporate proxy presents ONE client IP for
// a whole venue. The auth-failure budget (AUTH_FAILURE_LIMIT = 30 / 300 s)
// exists to starve token stuffing, so it must be sharded by the CREDENTIAL
// being refused, not by the egress address, and a 401 that only says "this
// session is dead" (logged out, expired, banned, refresh token gone or already
// rotated — a liveness verdict the app acts on by signing out) must not count
// as an attack signal at all. Pinned here through the REAL handler
// (routesHarness) plus module-level checks of rateLimit.ts (harness.ts
// isolates + fake Upstash):
//
//   * thirty distinct forged bearers refused by Supabase Auth from one egress
//     leave a co-tenant's valid bearer, refresh token and fresh sign-in at 200;
//   * thirty signed-out handsets (liveness refusals) charge no stuffing signal;
//   * one forged credential replayed is held (429 + Retry-After) after 30
//     refusals — sequentially or in one parallel burst — wherever it is
//     presented, while other credentials from the same address are still
//     judged once by Auth ("probation"), so a saturated egress fast-fails
//     REPLAYS without holding anyone new; a valid bearer fanned out in
//     parallel is never throttled by the failure budget;
//   * the venue keeps working through a flood after a 25 h idle (no
//     "seen recently" registry to age out) and on a freshly started isolate
//     without Redis (memory fallback holds only what IT refused);
//   * an Auth outage charges nothing; shards are shared across isolates
//     through Redis, fail open when Redis fails, survive a clock step back
//     and stay bounded in memory without ever holding a credential that was
//     never refused.
//
// What is NOT claimed: a burst of many DISTINCT forged credentials from one
// address is bounded only by the per-IP route budget (IP_LIMIT) and by Auth's
// own limits — the per-egress stuffing counter no longer holds credentials it
// has never seen, because that hold is exactly the venue lockout.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json rateLimit_nat_budget.test.ts

import { assert, assertEquals } from "@std/assert";
import { peekRateLimit } from "../rateLimit.ts";
import { configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";
import {
  fakeGoogleIdToken,
  fakeSupabaseAccessToken,
  type Harness,
  loadHarness,
  type RecordedCall,
  SUPABASE_URL,
  userRequest,
} from "./routesHarness.ts";

/** Mirrors AUTH_FAILURE_LIMIT in index.ts. */
const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
const VENUE_USER = "33333333-3333-4333-8333-333333333333";
const PROBE_ROUTE = "/v1/me/saved-drills"; // authenticated, PostgREST list → 200 []

let ipCounter = 0;
const freshIp = (): string => {
  ipCounter += 1;
  return `10.11.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const bearerOfCall = (call: RecordedCall): string =>
  (call.headers.authorization ?? "").replace(/^Bearer /, "");

const isUserCall = (call: RecordedCall): boolean =>
  call.url.startsWith(`${SUPABASE_URL}/auth/v1/user`);
const isRefreshCall = (call: RecordedCall): boolean =>
  call.url.startsWith(`${SUPABASE_URL}/auth/v1/token`) &&
  call.url.includes("grant_type=refresh_token");
const isIdTokenCall = (call: RecordedCall): boolean =>
  call.url.startsWith(`${SUPABASE_URL}/auth/v1/token`) && call.url.includes("grant_type=id_token");

const bodyField = (call: RecordedCall, field: string): string => {
  const body = call.body;
  if (!body || typeof body !== "object") return "";
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
};

/** Supabase Auth verdicts the fake upstream hands out per credential. */
interface AuthVerdicts {
  /** bearer → refused as a CREDENTIAL failure (401 bad_jwt). */
  forgedBearers: Set<string>;
  /** bearer → refused as a LIVENESS failure (403 session_not_found). */
  deadBearers: Set<string>;
  /** refresh token → 400 invalid_grant refresh_token_not_found (liveness: the
   * session was signed out or revoked; refresh tokens cannot be guessed). */
  unknownRefreshTokens: Set<string>;
  /** refresh token → 400 invalid_grant refresh_token_already_used (liveness). */
  rotatedRefreshTokens: Set<string>;
  /** ID token → 400 bad_id_token (credential). */
  forgedIdTokens: Set<string>;
  /** bearer → Auth answers 503 (outage, no verdict). */
  outageBearers: Set<string>;
}

function installAuth(h: Harness): AuthVerdicts {
  const verdicts: AuthVerdicts = {
    forgedBearers: new Set(),
    deadBearers: new Set(),
    unknownRefreshTokens: new Set(),
    rotatedRefreshTokens: new Set(),
    forgedIdTokens: new Set(),
    outageBearers: new Set(),
  };
  h.respond = (call) => {
    if (isUserCall(call)) {
      const bearer = bearerOfCall(call);
      if (verdicts.outageBearers.has(bearer)) {
        return jsonResponse(503, { message: "upstream unavailable" });
      }
      if (verdicts.forgedBearers.has(bearer)) {
        return jsonResponse(401, {
          code: 401,
          error_code: "bad_jwt",
          msg: "invalid JWT: unable to parse or verify signature",
        });
      }
      if (verdicts.deadBearers.has(bearer)) {
        return jsonResponse(403, {
          code: 403,
          error_code: "session_not_found",
          msg: "Session from session_id claim in JWT does not exist",
        });
      }
      return null;
    }
    if (isRefreshCall(call)) {
      const presented = bodyField(call, "refresh_token");
      if (verdicts.unknownRefreshTokens.has(presented)) {
        return jsonResponse(400, {
          error: "invalid_grant",
          error_description: "Invalid Refresh Token: Refresh Token Not Found",
          error_code: "refresh_token_not_found",
        });
      }
      if (verdicts.rotatedRefreshTokens.has(presented)) {
        return jsonResponse(400, {
          error: "invalid_grant",
          error_description: "Invalid Refresh Token: Already Used",
          error_code: "refresh_token_already_used",
        });
      }
      return null;
    }
    if (isIdTokenCall(call) && verdicts.forgedIdTokens.has(bodyField(call, "id_token"))) {
      return jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Bad ID token",
        error_code: "bad_id_token",
      });
    }
    return null;
  };
  return verdicts;
}

async function probe(h: Harness, ip: string, bearer: string): Promise<Response> {
  const response = await h.handler(userRequest("GET", PROBE_ROUTE, { token: bearer, ip }));
  await response.body?.cancel();
  return response;
}

async function refresh(h: Harness, ip: string, refreshToken: string): Promise<Response> {
  const request = new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
    method: "POST",
    headers: { "x-forwarded-for": ip, "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  const response = await h.handler(request);
  await response.body?.cancel();
  return response;
}

async function bootstrap(h: Harness, ip: string, idToken: string): Promise<Response> {
  h.tables.profiles = [
    {
      id: VENUE_USER,
      email: "venue@example.com",
      provider: "google",
      onboarding_state: "complete",
    },
  ];
  const response = await h.handler(
    userRequest("POST", "/v1/account/bootstrap", { token: idToken, ip, body: {} }),
  );
  await response.body?.cancel();
  return response;
}

const forgedBearer = (tag: string): string =>
  fakeSupabaseAccessToken("44444444-4444-4444-8444-444444444444", `forged-${tag}`);

/** Credential refusals the per-egress stuffing counter has recorded. */
async function egressCharged(ip: string): Promise<number> {
  const window = await peekRateLimit(
    "authfail",
    ip,
    AUTH_FAILURE_LIMIT.limit,
    AUTH_FAILURE_LIMIT.windowSeconds,
  );
  return window.limit - window.remaining;
}

function assertRetryAfter(response: Response): void {
  const retryAfter = Number(response.headers.get("Retry-After"));
  assert(
    Number.isInteger(retryAfter) &&
      retryAfter >= 1 &&
      retryAfter <= AUTH_FAILURE_LIMIT.windowSeconds,
    `429 must carry a bucket-bounded Retry-After, got ${retryAfter}`,
  );
}

const userCallsFor = (h: Harness, bearer: string): number =>
  h.calls.filter((call) => isUserCall(call) && bearerOfCall(call) === bearer).length;

// ─── through the real handler ────────────────────────────────────────────────

Deno.test(
  "NAT egress: 30 distinct forged bearers refused by Auth do not lock out a co-tenant's valid bearer, refresh or sign-in",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const tag = crypto.randomUUID();

    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
      const junk = forgedBearer(`${tag}-${i}`);
      auth.forgedBearers.add(junk);
      assertEquals((await probe(h, ip, junk)).status, 401, `forged bearer ${i} → 401`);
    }
    assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit, "stuffing was recorded");

    const venueBearer = fakeSupabaseAccessToken(VENUE_USER, `venue-${tag}`);
    const venueProbe = await probe(h, ip, venueBearer);
    assertEquals(venueProbe.status, 200, "the venue's own (uncached) bearer is judged by Auth");
    assertEquals(userCallsFor(h, venueBearer), 1, "…exactly once");

    assertEquals(
      (await refresh(h, ip, `venue-refresh-${tag}`)).status,
      200,
      "the venue's refresh token rotates through the flood",
    );
    assertEquals(
      (await bootstrap(h, ip, fakeGoogleIdToken(VENUE_USER))).status,
      200,
      "a fresh sign-in from the venue reaches Auth",
    );

    // A co-tenant whose session died must still hear 401 (sign in again), not
    // a 429 born of someone else's stuffing — twice, so the second look is a
    // judgment by Auth and not a fast-fail.
    const dead = fakeSupabaseAccessToken(VENUE_USER, `dead-${tag}`);
    auth.deadBearers.add(dead);
    assertEquals((await probe(h, ip, dead)).status, 401);
    assertEquals((await probe(h, ip, dead)).status, 401, "a dead session is never fast-failed");
    assertEquals(userCallsFor(h, dead), 2);
    assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit, "…and charged no stuffing");
  },
);

Deno.test(
  "liveness 401 is not an attack signal: 30 signed-out handsets behind one egress charge no stuffing budget",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const tag = crypto.randomUUID();

    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
      const dead = fakeSupabaseAccessToken(VENUE_USER, `dead-${tag}-${i}`);
      auth.deadBearers.add(dead);
      assertEquals((await probe(h, ip, dead)).status, 401, `dead session ${i} → 401`);
    }
    const rotated = `rotated-${tag}`;
    auth.rotatedRefreshTokens.add(rotated);
    assertEquals((await refresh(h, ip, rotated)).status, 401, "an already-rotated refresh → 401");
    // 29 signed-out handsets + the rotated token above = 30 liveness refresh
    // refusals, the whole per-IP refresh budget (AUTH_REFRESH_LIMIT 30/min).
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit - 1; i += 1) {
      const signedOut = `signed-out-${tag}-${i}`;
      auth.unknownRefreshTokens.add(signedOut);
      assertEquals((await refresh(h, ip, signedOut)).status, 401, `signed-out handset ${i}`);
    }
    assertEquals(await egressCharged(ip), 0, "liveness refusals are not stuffing");

    // The egress is not saturated, so a first AND a second look at one forged
    // credential are both judged by Auth (no fast-fail without a stuffing signal).
    const junk = forgedBearer(`${tag}-after-liveness`);
    auth.forgedBearers.add(junk);
    assertEquals((await probe(h, ip, junk)).status, 401);
    assertEquals((await probe(h, ip, junk)).status, 401);
    assertEquals(userCallsFor(h, junk), 2);
    assertEquals(await egressCharged(ip), 2, "credential refusals are");
  },
);

Deno.test(
  "per-credential shard: one forged bearer replayed is held after 30 refusals; other credentials from the same egress are still judged once, replays are fast-failed",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const tag = crypto.randomUUID();
    const replayed = forgedBearer(`${tag}-replayed`);
    auth.forgedBearers.add(replayed);

    const statuses: number[] = [];
    for (let i = 0; i <= AUTH_FAILURE_LIMIT.limit; i += 1) {
      const response = await probe(h, ip, replayed);
      statuses.push(response.status);
      if (i === AUTH_FAILURE_LIMIT.limit) assertRetryAfter(response);
    }
    assertEquals(statuses.slice(0, AUTH_FAILURE_LIMIT.limit), new Array(30).fill(401));
    assertEquals(statuses[AUTH_FAILURE_LIMIT.limit], 429, "the 31st replay is held");
    assertEquals(userCallsFor(h, replayed), AUTH_FAILURE_LIMIT.limit, "Auth judged it 30 times");

    // A second forged credential is judged once (probation under a saturated
    // egress) and then fast-failed — without a lookup of Auth.
    const other = forgedBearer(`${tag}-other`);
    auth.forgedBearers.add(other);
    assertEquals((await probe(h, ip, other)).status, 401, "a new credential is still judged");
    const replay = await probe(h, ip, other);
    assertEquals(replay.status, 429, "…its replay under a saturated egress is not");
    assertRetryAfter(replay);
    assertEquals(userCallsFor(h, other), 1);

    // Someone else's valid credentials from the same address are untouched.
    const venueBearer = fakeSupabaseAccessToken(VENUE_USER, `venue-${tag}`);
    assertEquals((await probe(h, ip, venueBearer)).status, 200);
    assertEquals((await refresh(h, ip, `venue-refresh-${tag}`)).status, 200);
  },
);

Deno.test(
  "one forged credential is one shard wherever it is presented: bearer + bootstrap refusals of the same ID token add up",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const idToken = fakeGoogleIdToken(`5555${crypto.randomUUID().slice(4)}`);
    auth.forgedIdTokens.add(idToken);

    for (let i = 0; i < 15; i += 1) {
      assertEquals((await probe(h, ip, idToken)).status, 401, `bearer refusal ${i}`);
      assertEquals((await bootstrap(h, ip, idToken)).status, 401, `bootstrap refusal ${i}`);
    }
    const heldOnBootstrap = await bootstrap(h, ip, idToken);
    assertEquals(heldOnBootstrap.status, 429, "the 31st presentation is held on bootstrap");
    assertRetryAfter(heldOnBootstrap);
    assertEquals((await probe(h, ip, idToken)).status, 429, "…and as a bearer");
    assertEquals(
      h.calls.filter((call) => isIdTokenCall(call) && bodyField(call, "id_token") === idToken)
        .length,
      30,
    );
  },
);

Deno.test(
  "an Auth outage charges neither the credential's shard nor the egress stuffing signal",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const tag = crypto.randomUUID();
    const bearer = fakeSupabaseAccessToken(VENUE_USER, `outage-${tag}`);
    auth.outageBearers.add(bearer);
    for (let i = 0; i < 5; i += 1) {
      assertEquals((await probe(h, ip, bearer)).status, 503, `outage ${i} is retryable`);
    }
    assertEquals(await egressCharged(ip), 0);

    // Once Auth answers, the credential is judged on its own record only.
    auth.outageBearers.delete(bearer);
    auth.forgedBearers.add(bearer);
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
      assertEquals((await probe(h, ip, bearer)).status, 401, `refusal ${i}`);
    }
    assertEquals((await probe(h, ip, bearer)).status, 429);
    assertEquals(userCallsFor(h, bearer), 5 + AUTH_FAILURE_LIMIT.limit);
  },
);

Deno.test("a refusal decided at the edge (no bearer, expired bearer) is not charged", async () => {
  const h = await loadHarness();
  installAuth(h);
  const ip = freshIp();
  for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
    const missing = await h.handler(
      new Request(`http://edge.test/functions/v1/api${PROBE_ROUTE}`, {
        headers: { "x-forwarded-for": ip },
      }),
    );
    await missing.body?.cancel();
    assertEquals(missing.status, 401);
  }
  assertEquals(await egressCharged(ip), 0);
  assertEquals(h.calls.filter(isUserCall).length, 0, "nothing reached Auth");
  const venueBearer = fakeSupabaseAccessToken(VENUE_USER, `venue-${crypto.randomUUID()}`);
  assertEquals((await probe(h, ip, venueBearer)).status, 200);
});

Deno.test(
  "parallel burst: 120 concurrent replays of one refused bearer reach Auth at most 29 more times; 40 concurrent requests with one VALID bearer are all served",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const tag = crypto.randomUUID();
    const replayed = forgedBearer(`${tag}-burst`);
    auth.forgedBearers.add(replayed);
    assertEquals((await probe(h, ip, replayed)).status, 401, "refused once");

    const burst = await Promise.all(
      Array.from({ length: 120 }, () => probe(h, ip, replayed).then((r) => r.status)),
    );
    const judged = userCallsFor(h, replayed);
    assertEquals(judged, AUTH_FAILURE_LIMIT.limit, "Auth judged the replayed bearer exactly 30×");
    assertEquals(burst.filter((s) => s === 401).length, judged - 1);
    assertEquals(burst.filter((s) => s === 429).length, 120 - (judged - 1));
    assertEquals((await probe(h, ip, replayed)).status, 429, "…and it stays held");

    const venueBearer = fakeSupabaseAccessToken(VENUE_USER, `venue-${tag}`);
    const fanOut = await Promise.all(
      Array.from({ length: 40 }, () => probe(h, ip, venueBearer).then((r) => r.status)),
    );
    assertEquals(
      fanOut,
      new Array(40).fill(200),
      "a failure budget never throttles a valid bearer",
    );
  },
);

Deno.test(
  "a handset idle for 25 h refreshes through a co-tenant flood: liveness is Auth's call, not a recency registry's",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const tag = crypto.randomUUID();
    const realNow = Date.now;
    try {
      assertEquals((await bootstrap(h, ip, fakeGoogleIdToken(VENUE_USER))).status, 200);
      const base = realNow();
      Date.now = () => base + 25 * 3_600_000;
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        const junk = forgedBearer(`${tag}-${i}`);
        auth.forgedBearers.add(junk);
        assertEquals((await probe(h, ip, junk)).status, 401);
      }
      assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit);
      assertEquals(
        (await refresh(h, ip, `idle-weekend-${tag}`)).status,
        200,
        "the venue's refresh token, unseen for 25 h, is judged by Auth and rotated",
      );
      const venueBearer = fakeSupabaseAccessToken(VENUE_USER, `venue-${tag}`);
      assertEquals((await probe(h, ip, venueBearer)).status, 200);
    } finally {
      Date.now = realNow;
    }
  },
);

// ─── rateLimit.ts module contract ────────────────────────────────────────────

Deno.test(
  "memory fallback (no Redis): a freshly started isolate holds nothing it did not refuse itself — no venue lockout after a restart",
  async () => {
    configureRedis(false);
    const before = await loadIsolate();
    const after = await loadIsolate();
    const ip = freshIp();
    const tag = crypto.randomUUID();
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
      await before.rateLimit.chargeAuthFailure(
        ip,
        `forged-${tag}-${i}`,
        "credential",
        AUTH_FAILURE_LIMIT,
      );
      await after.rateLimit.chargeAuthFailure(
        ip,
        `forged-${tag}-${i}`,
        "credential",
        AUTH_FAILURE_LIMIT,
      );
      await after.rateLimit.chargeAuthFailure(
        ip,
        `signed-out-${tag}-${i}`,
        "liveness",
        AUTH_FAILURE_LIMIT,
      );
    }
    for (const isolate of [before, after]) {
      const bearer = await isolate.rateLimit.admitAuthCredential(
        ip,
        `venue-bearer-${tag}`,
        AUTH_FAILURE_LIMIT,
      );
      assertEquals(bearer.allowed, true, "a bearer minted before the restart is admitted");
      const refreshToken = await isolate.rateLimit.admitAuthCredential(
        ip,
        `venue-refresh-${tag}`,
        AUTH_FAILURE_LIMIT,
      );
      assertEquals(refreshToken.allowed, true, "…so is its refresh token");
      const signIn = await isolate.rateLimit.admitAuthCredential(
        ip,
        fakeGoogleIdToken(VENUE_USER),
        AUTH_FAILURE_LIMIT,
      );
      assertEquals(signIn.allowed, true, "…and a brand-new sign-in");
    }
    assertEquals(
      (await after.rateLimit.admitAuthCredential(ip, `forged-${tag}-0`, AUTH_FAILURE_LIMIT))
        .allowed,
      false,
      "what an isolate refused under saturation it fast-fails",
    );
  },
);

Deno.test(
  "authRefusalKind: GoTrue verdicts on a dead session are liveness, everything else is a credential failure",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const liveness: unknown[] = [
      { code: 403, error_code: "session_not_found", msg: "Session does not exist" },
      { code: 403, error_code: "session_expired", msg: "Session has expired" },
      { code: 403, error_code: "user_not_found", msg: "User does not exist" },
      { code: 403, error_code: "user_banned", msg: "User is banned" },
      { error: "invalid_grant", error_code: "refresh_token_already_used" },
      { error: "invalid_grant", error_description: "Invalid Refresh Token: Already Used" },
      { error: "invalid_grant", error_code: "refresh_token_not_found" },
      {
        error: "invalid_grant",
        error_description: "Invalid Refresh Token: Refresh Token Not Found",
      },
      { code: 401, msg: "invalid JWT: token is expired by 5m" },
      // supabase-js AuthApiError shape (message + code)
      { name: "AuthApiError", status: 403, code: "session_not_found", message: "Session missing" },
    ];
    const credential: unknown[] = [
      { code: 401, error_code: "bad_jwt", msg: "invalid JWT: unable to parse or verify signature" },
      { error: "invalid_grant", error_code: "bad_id_token", error_description: "Bad ID token" },
      { name: "AuthApiError", status: 400, code: "bad_id_token", message: "Bad ID token" },
      { code: 403, error_code: "not_admin" },
      {},
      null,
      "invalid",
      undefined,
    ];
    for (const verdict of liveness) {
      assertEquals(rateLimit.authRefusalKind(verdict), "liveness", JSON.stringify(verdict));
    }
    for (const verdict of credential) {
      assertEquals(rateLimit.authRefusalKind(verdict), "credential", JSON.stringify(verdict));
    }
  },
);

Deno.test(
  "authFailureIdentity: one credential, one shard — hex-shaped credentials are hashed like any other",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const hexShaped = "a".repeat(64);
    const identity = await rateLimit.authFailureIdentity(hexShaped);
    assert(identity !== hexShaped, "a digest-shaped credential is still hashed");
    assertEquals(identity, await rateLimit.authFailureIdentity(`  ${hexShaped} `), "trimmed");
    assert(identity !== (await rateLimit.authFailureIdentity("b".repeat(64))));
    assert(/^[0-9a-f]{64}$/.test(identity));

    const ip = freshIp();
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
      await rateLimit.chargeAuthFailure(ip, hexShaped, "credential", AUTH_FAILURE_LIMIT);
    }
    assertEquals(
      (await rateLimit.peekAuthFailureBudget(ip, hexShaped, AUTH_FAILURE_LIMIT)).allowed,
      false,
    );
    assertEquals(
      (await rateLimit.peekAuthFailureBudget(ip, ` ${hexShaped}`, AUTH_FAILURE_LIMIT)).allowed,
      false,
    );
    assertEquals(
      (await rateLimit.peekAuthFailureBudget(ip, identity, AUTH_FAILURE_LIMIT)).allowed,
      true,
      "the digest itself is a different credential",
    );
  },
);

Deno.test(
  "Redis: shards and the egress signal are shared across isolates; a Redis failure falls back to per-isolate memory and fails OPEN",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const one = await loadIsolate();
      const two = await loadIsolate();
      const ip = freshIp();
      const replayed = `replayed-${crypto.randomUUID()}`;
      const fresh = `fresh-${crypto.randomUUID()}`;

      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        const charged = await one.rateLimit.chargeAuthFailure(
          ip,
          replayed,
          "credential",
          AUTH_FAILURE_LIMIT,
        );
        assertEquals(charged.remaining, AUTH_FAILURE_LIMIT.limit - (i + 1));
      }
      const heldElsewhere = await two.rateLimit.peekAuthFailureBudget(
        ip,
        replayed,
        AUTH_FAILURE_LIMIT,
      );
      assertEquals(heldElsewhere.allowed, false, "a sibling isolate holds the replayed credential");
      assertEquals(heldElsewhere.remaining, 0);
      assert(heldElsewhere.retryAfterSeconds >= 1 && heldElsewhere.retryAfterSeconds <= 300);
      assertEquals(
        (await two.rateLimit.peekAuthFailureBudget(ip, fresh, AUTH_FAILURE_LIMIT)).allowed,
        true,
        "a credential never refused is admitted from a saturated egress",
      );
      assertEquals(
        (await two.rateLimit.peekRateLimit("authfail", ip, 30, 300)).allowed,
        false,
        "the egress stuffing signal is shared too",
      );
      // Under a saturated egress a credential refused ONCE is fast-failed.
      await two.rateLimit.chargeAuthFailure(ip, fresh, "credential", AUTH_FAILURE_LIMIT);
      assertEquals(
        (await one.rateLimit.peekAuthFailureBudget(ip, fresh, AUTH_FAILURE_LIMIT)).allowed,
        false,
      );
      // …but a liveness refusal never saturates the egress.
      const quietIp = freshIp();
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        await one.rateLimit.chargeAuthFailure(quietIp, `dead-${i}`, "liveness", AUTH_FAILURE_LIMIT);
      }
      assertEquals((await two.rateLimit.peekRateLimit("authfail", quietIp, 30, 300)).remaining, 30);
      await two.rateLimit.chargeAuthFailure(quietIp, "once", "credential", AUTH_FAILURE_LIMIT);
      assertEquals(
        (await one.rateLimit.peekAuthFailureBudget(quietIp, "once", AUTH_FAILURE_LIMIT)).allowed,
        true,
      );

      // Redis down: the shared record is unreadable, nothing is held (fail
      // open, like every other budget here), and memory takes over.
      redis.failStatus = 500;
      assertEquals(
        (await two.rateLimit.peekAuthFailureBudget(ip, replayed, AUTH_FAILURE_LIMIT)).allowed,
        true,
        "no Redis → no lockout",
      );
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        await two.rateLimit.chargeAuthFailure(ip, replayed, "credential", AUTH_FAILURE_LIMIT);
      }
      assertEquals(
        (await two.rateLimit.peekAuthFailureBudget(ip, replayed, AUTH_FAILURE_LIMIT)).allowed,
        false,
        "the per-isolate window still holds a replayed credential",
      );
      assertEquals(
        (await one.rateLimit.peekAuthFailureBudget(ip, replayed, AUTH_FAILURE_LIMIT)).allowed,
        true,
        "…in that isolate only",
      );
    } finally {
      redis.restore();
      configureRedis(false);
    }
  },
);

Deno.test(
  "memory: a clock step back across the window boundary does not forget a held shard",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const realNow = Date.now;
    try {
      const windowMs = AUTH_FAILURE_LIMIT.windowSeconds * 1_000;
      const boundary = Math.floor(realNow() / windowMs) * windowMs + windowMs;
      let now = boundary - 1_000;
      Date.now = () => now;
      const ip = freshIp();
      const replayed = `replayed-${crypto.randomUUID()}`;
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        await rateLimit.chargeAuthFailure(ip, replayed, "credential", AUTH_FAILURE_LIMIT);
      }
      assertEquals(
        (await rateLimit.peekAuthFailureBudget(ip, replayed, AUTH_FAILURE_LIMIT)).allowed,
        false,
      );
      now = boundary - 3_000;
      await rateLimit.peekAuthFailureBudget(ip, replayed, AUTH_FAILURE_LIMIT);
      now = boundary - 1_000;
      const afterStep = await rateLimit.peekAuthFailureBudget(ip, replayed, AUTH_FAILURE_LIMIT);
      assertEquals(afterStep.allowed, false, "the aligned window is intact");
      assertEquals(afterStep.remaining, 0);
      now = boundary + 1_000;
      assertEquals(
        (await rateLimit.peekAuthFailureBudget(ip, replayed, AUTH_FAILURE_LIMIT)).allowed,
        true,
        "…and expires with its window",
      );
    } finally {
      Date.now = realNow;
    }
  },
);

Deno.test(
  "memory: a flood of distinct refused credentials stays bounded and never holds a credential that was not refused",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const ip = freshIp();
    const venue = `venue-${crypto.randomUUID()}`;
    await rateLimit.chargeAuthFailure(ip, venue, "credential", AUTH_FAILURE_LIMIT);
    for (let i = 0; i < 25_000; i += 1) {
      await rateLimit.chargeAuthFailure(ip, `forged-${i}`, "credential", AUTH_FAILURE_LIMIT);
    }
    const venueShard = await rateLimit.peekAuthFailureBudget(ip, venue, AUTH_FAILURE_LIMIT);
    assertEquals(venueShard.allowed, false, "a credential refused under saturation is held");
    assertEquals(
      (
        await rateLimit.peekAuthFailureBudget(
          ip,
          `never-${crypto.randomUUID()}`,
          AUTH_FAILURE_LIMIT,
        )
      ).allowed,
      true,
      "a credential never refused is admitted even when the shard store is full",
    );
    assertEquals(
      (await rateLimit.peekRateLimit("ip", ip, 1_200, 60)).allowed,
      true,
      "shards do not crowd out the generic per-IP windows",
    );
  },
);
