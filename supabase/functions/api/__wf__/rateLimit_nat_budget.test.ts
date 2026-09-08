// W11-01 — auth-failure budgets behind a shared NAT egress.
//
// The per-IP `authfail` budget (AUTH_FAILURE_LIMIT = 30 / 300 s) starves
// credential stuffing. Behind carrier NAT or club Wi-Fi one egress IP is a
// whole venue, so what is charged to that budget decides whether ONE handset
// can lock every peer out for five minutes. The contract pinned here:
//
//   * a credential Auth REFUSED charges the egress ONCE, however often it is
//     replayed — the replaying handset is throttled by its own per-credential
//     shard (31st → 429) while peers keep read = 200 / refresh = 200;
//   * a LIVENESS refusal (signed-out / expired-upstream / banned session —
//     GoTrue `session_not_found`, `session_expired`, `user_not_found`,
//     `user_banned`, `refresh_token_already_used`) is a stale-but-real
//     credential, not a guess: it never charges the egress, only its shard;
//   * a refusal decided locally without consulting Auth (no credential,
//     non-JWT bearer, lowercase scheme, expired token) never charges the
//     egress; anonymous noise throttles anonymous traffic from that egress
//     only, session credentials issued by this API are never fenced by it;
//   * DISTINCT refused credentials still close the egress (stuffing stays
//     starved) — that is the one venue-wide budget and it stays per IP.
//
// Route tests run through the REAL handler (routesHarness.ts); primitive
// tests load rateLimit.ts in fresh isolates (harness.ts) over memory and the
// fake Upstash so the shard/egress accounting is observable directly.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json rateLimit_nat_budget.test.ts

import { assert, assertEquals } from "@std/assert";
import { peekRateLimit } from "../rateLimit.ts";
import { configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";
import type { RecordedCall } from "./routesHarness.ts";
import {
  fakeGoogleIdToken,
  fakeSupabaseAccessToken,
  loadHarness,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

/** Mirrors AUTH_FAILURE_LIMIT in index.ts. */
const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
const LIMIT = AUTH_FAILURE_LIMIT.limit;

type Handler = (request: Request) => Promise<Response>;

const profile = () => ({
  id: TEST_USER_ID,
  email: "user@example.com",
  provider: "google",
  onboarding_state: "complete",
});

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A Supabase-shaped access token Auth will judge; `salt` keeps bearers distinct. */
function supabaseBearer(salt: string, exp = Math.floor(Date.now() / 1000) + 3600): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: TEST_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      session_id: crypto.randomUUID(),
      exp,
      salt,
    }),
  );
  return `${header}.${payload}.sig`;
}

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

const sessionGone = (error_code = "session_not_found") =>
  jsonResponse(403, {
    code: 403,
    error_code,
    msg: "Session from session_id claim in JWT does not exist",
  });

const refreshRefused = (error_code = "refresh_token_not_found") =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Invalid Refresh Token",
    error_code,
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
/** Unique egress per test: the rate-limit memory windows are module-global. */
const freshIp = () => `10.61.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const spent = (window: { limit: number; remaining: number }) => window.limit - window.remaining;

/** Failures charged to the egress-wide budget — what locks a whole venue. */
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

/** What a healthy peer behind the egress sees: a valid session bearer reading
 * /v1/me and a live refresh token rotating (the harness rotates any refresh
 * token Auth is asked about unless a test injects a refusal for it). */
async function peerStatuses(handler: Handler, ip: string) {
  const read = await readMe(handler, ip, fakeSupabaseAccessToken(TEST_USER_ID));
  const refresh = await postRefresh(handler, ip, `rt-healthy-peer-${crypto.randomUUID()}`);
  return { read: read.status, refresh: refresh.status };
}

const assertPeersServed = async (handler: Handler, ip: string, why: string) => {
  const peers = await peerStatuses(handler, ip);
  assertEquals(
    peers,
    { read: 200, refresh: 200 },
    `${why} (egress charged = ${await egressCharged(ip)})`,
  );
};

const repeat = async (times: number, run: () => Promise<Response>): Promise<number[]> => {
  const statuses: number[] = [];
  for (let i = 0; i < times; i += 1) statuses.push((await run()).status);
  return statuses;
};

// ─────────────────────────────────────────────────────────────────────────────
// Replayed refused credential: one handset, one dead bearer, many retries.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "NAT: one handset replaying ONE refused bearer 31× is throttled alone — egress charged once, peers keep read/refresh",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const forged = supabaseBearer("forged-replayed");
    h.respond = (call) =>
      isUserCall(call) && bearerOfCall(call) === forged ? credentialRefused() : null;

    const statuses = await repeat(LIMIT + 1, () => readMe(h.handler, ip, forged));
    assertEquals(statuses.slice(0, LIMIT), new Array(LIMIT).fill(401));
    assertEquals(statuses[LIMIT], 429, "the replaying handset alone is throttled");
    assertEquals(
      h.calls.filter((call) => isUserCall(call) && bearerOfCall(call) === forged).length,
      LIMIT,
      "the throttled replay never reached Auth",
    );
    assertEquals(await egressCharged(ip), 1, "one refused credential = one egress charge");
    await assertPeersServed(h.handler, ip, "one replaying handset locked the venue out");
  },
);

Deno.test(
  "NAT: 31 CONCURRENT replays of one refused bearer charge the egress once, not once per request",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const forged = supabaseBearer("forged-concurrent");
    h.respond = (call) =>
      isUserCall(call) && bearerOfCall(call) === forged ? credentialRefused() : null;

    const responses = await Promise.all(
      Array.from({ length: LIMIT + 1 }, () => readMe(h.handler, ip, forged)),
    );
    assert(
      responses.every((r) => r.status === 401 || r.status === 429),
      responses.map((r) => r.status).join(","),
    );
    assertEquals(await egressCharged(ip), 1);
    await assertPeersServed(h.handler, ip, "concurrent replays of one credential locked the venue");
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Beyond any shard cap: a venue full of signed-out handsets plus one replayer.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "NAT: after 60 signed-out peers (session_not_found) one replayed forged bearer still charges the egress once",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const signedOut = Array.from({ length: 2 * LIMIT }, (_, i) =>
      supabaseBearer(`signed-out-${i}`),
    );
    const forged = supabaseBearer("forged-after-cap");
    h.respond = (call) => {
      if (!isUserCall(call)) return null;
      const bearer = bearerOfCall(call);
      if (signedOut.includes(bearer)) return sessionGone();
      if (bearer === forged) return credentialRefused();
      return null;
    };

    for (const bearer of signedOut) assertEquals((await readMe(h.handler, ip, bearer)).status, 401);
    assertEquals(await egressCharged(ip), 0, "signed-out sessions are liveness, not stuffing");

    const statuses = await repeat(LIMIT + 1, () => readMe(h.handler, ip, forged));
    assertEquals(statuses.slice(0, LIMIT), new Array(LIMIT).fill(401));
    assertEquals(statuses[LIMIT], 429, "the replayer alone is throttled");
    assertEquals(await egressCharged(ip), 1, "one credential → one egress charge, cap or no cap");
    await assertPeersServed(h.handler, ip, "a replayer beyond the shard cap locked the venue");
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Liveness 401 is not an attack.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "NAT: liveness refusals (session_not_found / session_expired / user_not_found / user_banned) never charge the egress",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const codes = ["session_not_found", "session_expired", "user_not_found", "user_banned"];
    const deadBearers = new Map<string, string>();
    for (const code of codes) {
      for (let i = 0; i < 10; i += 1) deadBearers.set(supabaseBearer(`live-${code}-${i}`), code);
    }
    h.respond = (call) => {
      if (!isUserCall(call)) return null;
      const code = deadBearers.get(bearerOfCall(call));
      return code ? sessionGone(code) : null;
    };
    for (const bearer of deadBearers.keys()) {
      assertEquals((await readMe(h.handler, ip, bearer)).status, 401);
    }
    assertEquals(h.callsTo("/auth/v1/user").length, 40, "every dead session was checked upstream");
    assertEquals(await egressCharged(ip), 0);
    await assertPeersServed(h.handler, ip, "40 signed-out handsets locked the venue out");
  },
);

Deno.test(
  "NAT: a replayed DEAD session (liveness) is throttled by its own shard — 31st → 429 — without touching the egress",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const dead = supabaseBearer("dead-replayed");
    h.respond = (call) => (isUserCall(call) && bearerOfCall(call) === dead ? sessionGone() : null);
    const statuses = await repeat(LIMIT + 1, () => readMe(h.handler, ip, dead));
    assertEquals(statuses.slice(0, LIMIT), new Array(LIMIT).fill(401));
    assertEquals(statuses[LIMIT], 429);
    assertEquals(await egressCharged(ip), 0);
    await assertPeersServed(h.handler, ip, "one dead session replayed locked the venue");
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Stuffing protection is retained: DISTINCT refused credentials close the egress.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "NAT: 30 DISTINCT refused bearers still close the egress — the 31st distinct guess is 429 before Auth",
  async () => {
    const h = await loadHarness();
    const ip = freshIp();
    const guesses = Array.from({ length: LIMIT + 1 }, (_, i) => supabaseBearer(`stuffed-${i}`));
    h.respond = (call) =>
      isUserCall(call) && guesses.includes(bearerOfCall(call)) ? credentialRefused() : null;
    let n = 0;
    const statuses = await repeat(LIMIT, () => readMe(h.handler, ip, guesses[n++]));
    assertEquals(statuses, new Array(LIMIT).fill(401));
    assertEquals(await egressCharged(ip), LIMIT);
    const before = h.callsTo("/auth/v1/user").length;
    const blocked = await readMe(h.handler, ip, guesses[LIMIT]);
    assertEquals(blocked.status, 429);
    const retryAfter = Number(blocked.headers.get("Retry-After"));
    assert(retryAfter >= 1 && retryAfter <= AUTH_FAILURE_LIMIT.windowSeconds, `${retryAfter}`);
    assertEquals(h.callsTo("/auth/v1/user").length, before, "a closed egress never reaches Auth");
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Refusals decided locally (Auth never consulted) are not stuffing signal.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "NAT: 30 credential-less requests from one device never charge the egress; signed-in peers keep read/refresh",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const statuses = await repeat(LIMIT, () => readMeWithAuthorization(h.handler, ip));
    assertEquals(statuses, new Array(LIMIT).fill(401));
    assertEquals(h.callsTo("/auth/v1/user").length, 0, "nothing was probed upstream");
    assertEquals(await egressCharged(ip), 0);
    await assertPeersServed(h.handler, ip, "30 credential-less requests locked the venue out");
  },
);

Deno.test(
  "NAT: 30 locally-refused garbage bearers never charge the egress; peers keep read/refresh",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    let n = 0;
    const statuses = await repeat(LIMIT, () => readMe(h.handler, ip, `not-a-jwt-${n++}`));
    assertEquals(statuses, new Array(LIMIT).fill(401));
    assertEquals(h.callsTo("/auth/v1/user").length, 0);
    assertEquals(await egressCharged(ip), 0);
    await assertPeersServed(h.handler, ip, "30 garbage bearers locked the venue out");
  },
);

Deno.test(
  "NAT: a VALID session replayed 30× under a lowercase `bearer` scheme never charges the egress",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const valid = fakeSupabaseAccessToken(TEST_USER_ID);
    const statuses = await repeat(LIMIT, () =>
      readMeWithAuthorization(h.handler, ip, `bearer ${valid}`),
    );
    assert(
      statuses.every((s) => s === 401 || s === 200),
      statuses.join(","),
    );
    assertEquals(await egressCharged(ip), 0);
    await assertPeersServed(h.handler, ip, "a lowercase scheme replay locked the venue out");
  },
);

Deno.test(
  "NAT: an EXPIRED session token replayed 30× (a handset waiting on refresh) charges nothing at all",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const expired = supabaseBearer("expired", Math.floor(Date.now() / 1000) - 60);
    const statuses = await repeat(LIMIT + 1, () => readMe(h.handler, ip, expired));
    assertEquals(statuses, new Array(LIMIT + 1).fill(401), "expired is 401, never 429");
    assertEquals(h.callsTo("/auth/v1/user").length, 0);
    assertEquals(await egressCharged(ip), 0);
    await assertPeersServed(h.handler, ip, "an expired handset locked the venue out");
  },
);

Deno.test(
  "NAT: anonymous noise throttles only anonymous traffic — after 30 credential-less refusals a provider ID token on a general route is 429, a session bearer is 200",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    await repeat(LIMIT, () => readMeWithAuthorization(h.handler, ip));
    const anonymous = await readMe(h.handler, ip, fakeGoogleIdToken());
    assertEquals(anonymous.status, 429, "the noisy egress may not mint sessions this window");
    assertEquals(
      h.callsTo("/auth/v1/token").length,
      0,
      "the throttled ID token never reached Auth",
    );
    await assertPeersServed(h.handler, ip, "anonymous noise fenced signed-in peers");
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Refresh: the refresh token is the credential; a bearer on the request is not.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "NAT: one refused refresh token replayed 31× charges the egress once and is throttled alone",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    h.respond = (call) =>
      isRefreshCall(call) && bodyField(call, "refresh_token") === "rt-revoked-replayed"
        ? refreshRefused()
        : null;
    const statuses = await repeat(LIMIT + 1, () =>
      postRefresh(h.handler, ip, "rt-revoked-replayed"),
    );
    assertEquals(statuses.slice(0, LIMIT), new Array(LIMIT).fill(401));
    assertEquals(statuses[LIMIT], 429);
    assertEquals(
      h.calls.filter(
        (c) => isRefreshCall(c) && bodyField(c, "refresh_token") === "rt-revoked-replayed",
      ).length,
      LIMIT,
    );
    assertEquals(await egressCharged(ip), 1);
    await assertPeersServed(h.handler, ip, "one replayed refresh token locked the venue out");
  },
);

Deno.test(
  "NAT: refresh_token_already_used (rotation race) is liveness — it never charges the egress",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    h.respond = (call) =>
      isRefreshCall(call) && bodyField(call, "refresh_token").startsWith("rt-raced-")
        ? refreshRefused("refresh_token_already_used")
        : null;
    let n = 0;
    const statuses = await repeat(LIMIT, () => postRefresh(h.handler, ip, `rt-raced-${n++}`));
    assertEquals(statuses, new Array(LIMIT).fill(401));
    assertEquals(await egressCharged(ip), 0);
    await assertPeersServed(h.handler, ip, "rotation races locked the venue out");
  },
);

Deno.test(
  "NAT: a spent DEAD bearer on the refresh request does not gate the LIVE refresh token in its body",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const dead = supabaseBearer("dead-on-refresh");
    h.respond = (call) => (isUserCall(call) && bearerOfCall(call) === dead ? sessionGone() : null);
    const statuses = await repeat(LIMIT + 1, () => readMe(h.handler, ip, dead));
    assertEquals(statuses[LIMIT], 429, "the dead bearer's shard is spent");
    const refreshed = await postRefresh(h.handler, ip, `rt-live-${crypto.randomUUID()}`, dead);
    assertEquals(refreshed.status, 200, "the refresh token is the credential of a refresh");
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap: a refused provider ID token is one credential too.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "NAT: a refused provider ID token replayed 31× at bootstrap charges the egress once; peers keep read/refresh",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const forgedIdToken = fakeGoogleIdToken("forged-subject");
    h.respond = (call) =>
      isIdTokenCall(call) && bodyField(call, "id_token") === forgedIdToken
        ? idTokenRefused()
        : null;
    const statuses = await repeat(LIMIT + 1, () => postBootstrap(h.handler, ip, forgedIdToken));
    assertEquals(statuses.slice(0, LIMIT), new Array(LIMIT).fill(401));
    assertEquals(statuses[LIMIT], 429);
    assertEquals(await egressCharged(ip), 1);
    await assertPeersServed(h.handler, ip, "one replayed forged ID token locked the venue out");
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Primitive accounting — rateLimit.ts in fresh isolates, memory and Redis.
// ─────────────────────────────────────────────────────────────────────────────
const BUDGET = { limit: 3, windowSeconds: 300 };

Deno.test(
  "rateLimit: credential replays charge the egress once and the shard every time",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const ip = "198.51.100.1";
    const identity = await rateLimit.authFailureIdentity("dead-bearer");
    assert(identity !== null);
    for (let i = 0; i < BUDGET.limit; i += 1) {
      assertEquals(
        (await rateLimit.peekAuthFailureBudget(ip, { identity, session: true }, BUDGET)).allowed,
        true,
        `replay ${i + 1} is still allowed`,
      );
      await rateLimit.chargeAuthFailure(ip, identity, "credential", BUDGET);
    }
    const shard = await rateLimit.peekAuthFailureBudget(ip, { identity, session: true }, BUDGET);
    assertEquals(shard.allowed, false, "the replayed credential is throttled");
    assert(shard.retryAfterSeconds >= 1 && shard.retryAfterSeconds <= BUDGET.windowSeconds);
    const egress = await rateLimit.peekRateLimit(
      "authfail",
      ip,
      BUDGET.limit,
      BUDGET.windowSeconds,
    );
    assertEquals(spent(egress), 1);
    const other = await rateLimit.authFailureIdentity("another-bearer");
    assertEquals(
      (await rateLimit.peekAuthFailureBudget(ip, { identity: other, session: true }, BUDGET))
        .allowed,
      true,
      "a different credential behind the egress is unaffected",
    );
  },
);

Deno.test(
  "rateLimit: liveness charges only the shard; local charges only the anonymous lane; expired charges nothing",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const ip = "198.51.100.2";
    const dead = await rateLimit.authFailureIdentity("signed-out-bearer");
    for (let i = 0; i < BUDGET.limit; i += 1) {
      await rateLimit.chargeAuthFailure(ip, dead, "liveness", BUDGET);
    }
    assertEquals(
      (await rateLimit.peekAuthFailureBudget(ip, { identity: dead, session: true }, BUDGET))
        .allowed,
      false,
    );
    for (let i = 0; i < BUDGET.limit; i += 1) {
      await rateLimit.chargeAuthFailure(ip, null, "local", BUDGET);
      await rateLimit.chargeAuthFailure(ip, dead, "expired", BUDGET);
    }
    const egress = await rateLimit.peekRateLimit(
      "authfail",
      ip,
      BUDGET.limit,
      BUDGET.windowSeconds,
    );
    assertEquals(spent(egress), 0, "neither liveness nor local nor expired is stuffing signal");
    assertEquals(
      (await rateLimit.peekAuthFailureBudget(ip, { identity: null, session: false }, BUDGET))
        .allowed,
      false,
      "anonymous traffic from the noisy egress is throttled",
    );
    const peer = await rateLimit.authFailureIdentity("peer-session");
    assertEquals(
      (await rateLimit.peekAuthFailureBudget(ip, { identity: peer, session: true }, BUDGET))
        .allowed,
      true,
      "a session credential is never fenced by anonymous noise",
    );
  },
);

Deno.test(
  "rateLimit: distinct refused credentials close the egress for everyone behind it",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const ip = "198.51.100.3";
    for (let i = 0; i < BUDGET.limit; i += 1) {
      const identity = await rateLimit.authFailureIdentity(`guess-${i}`);
      await rateLimit.chargeAuthFailure(ip, identity, "credential", BUDGET);
    }
    const egress = await rateLimit.peekRateLimit(
      "authfail",
      ip,
      BUDGET.limit,
      BUDGET.windowSeconds,
    );
    assertEquals(egress.allowed, false);
    assertEquals(spent(egress), BUDGET.limit);
  },
);

Deno.test(
  "rateLimit: authFailureIdentity is a stable hash, null for a blank credential, distinct per credential",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    assertEquals(await rateLimit.authFailureIdentity(""), null);
    assertEquals(await rateLimit.authFailureIdentity("   "), null);
    const a = await rateLimit.authFailureIdentity("token-a");
    const b = await rateLimit.authFailureIdentity("token-b");
    assert(a !== null && b !== null && a !== b);
    assertEquals(await rateLimit.authFailureIdentity("token-a"), a);
    assert(/^[0-9a-f]{32}$/.test(a), "the identity is a hash, never the raw credential");
  },
);

Deno.test(
  "rateLimit: authRefusalKind maps GoTrue liveness codes and defaults unknown codes to credential",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    for (const code of [
      "session_not_found",
      "session_expired",
      "user_not_found",
      "user_banned",
      "refresh_token_already_used",
    ]) {
      assertEquals(rateLimit.authRefusalKind(code), "liveness", code);
    }
    for (const code of [
      "bad_jwt",
      "refresh_token_not_found",
      "bad_id_token",
      "",
      null,
      undefined,
    ]) {
      assertEquals(rateLimit.authRefusalKind(code), "credential", String(code));
    }
  },
);

Deno.test(
  "rateLimit: authRefusal tags a response and authRefusalOf reads it back; an untagged 401 is a credential refusal",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const tagged = rateLimit.authRefusal(new Response(null, { status: 401 }), {
      kind: "liveness",
      identity: "abc",
    });
    assertEquals(rateLimit.authRefusalOf(tagged), { kind: "liveness", identity: "abc" });
    const local = rateLimit.authRefusal(new Response(null, { status: 401 }), { kind: "local" });
    assertEquals(rateLimit.authRefusalOf(local).kind, "local");
    assertEquals(rateLimit.authRefusalOf(new Response(null, { status: 401 })), {
      kind: "credential",
    });
    await tagged.body?.cancel();
  },
);

Deno.test("rateLimit: shard and egress accounting persists in Redis across isolates", async () => {
  configureRedis(true);
  const redis = fakeUpstash();
  try {
    const a = await loadIsolate();
    const b = await loadIsolate();
    const ip = "198.51.100.4";
    const identity = await a.rateLimit.authFailureIdentity("shared-dead-bearer");
    for (let i = 0; i < BUDGET.limit; i += 1) {
      await a.rateLimit.chargeAuthFailure(ip, identity, "credential", BUDGET);
    }
    assertEquals(
      (await b.rateLimit.peekAuthFailureBudget(ip, { identity, session: true }, BUDGET)).allowed,
      false,
      "another isolate sees the spent shard",
    );
    assertEquals(
      spent(await b.rateLimit.peekRateLimit("authfail", ip, BUDGET.limit, BUDGET.windowSeconds)),
      1,
      "another isolate sees exactly one egress charge",
    );
  } finally {
    redis.restore();
    configureRedis(false);
  }
});

Deno.test(
  "rateLimit: a Redis outage degrades to the isolate's memory windows without throwing",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    redis.failStatus = 500;
    try {
      const { rateLimit } = await loadIsolate();
      const ip = "198.51.100.5";
      const identity = await rateLimit.authFailureIdentity("dead-during-outage");
      for (let i = 0; i < BUDGET.limit; i += 1) {
        await rateLimit.chargeAuthFailure(ip, identity, "credential", BUDGET);
      }
      assertEquals(
        (await rateLimit.peekAuthFailureBudget(ip, { identity, session: true }, BUDGET)).allowed,
        false,
      );
    } finally {
      redis.restore();
      configureRedis(false);
    }
  },
);
