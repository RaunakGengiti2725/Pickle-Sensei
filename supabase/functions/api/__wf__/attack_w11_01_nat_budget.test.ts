// W11-01 ADVERSARIAL TESTS — auth-failure budgets behind a shared NAT egress.
//
// Candidate: devin/pp/w11-01/impl-r3 @ e831139821601e19c79be2080728ff5ab4325344.
// Each test is one attack at a failure boundary of rateLimit.ts +
// handleRequest(). A FAILING test here is a confirmed break of the package
// objective ("one NAT egress cannot lock out a venue") or of the contract the
// candidate's own rateLimit_nat_budget.test.ts pins; a PASSING test is an
// attack that did not break anything. Nothing in the candidate's production
// code or tests is touched.
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
 * every call (the TRANSITIONAL branch of authenticate()). */
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

/** The same liveness refusal in the OLDER GoTrue error shape (`{code, msg}`
 * without `error_code`). */
const sessionGoneLegacyShape = () =>
  jsonResponse(401, { code: 401, msg: "Session from session_id claim in JWT does not exist" });

const refreshRefused = () =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Invalid Refresh Token",
    error_code: "refresh_token_not_found",
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
/** Unique egress per test (own /16 so the candidate's tests never collide). */
const freshIp = () => `10.62.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

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

/** What healthy peers behind the egress see: a valid session bearer reading
 * /v1/me, a live refresh token rotating, and a NEW handset signing in. */
async function peerStatuses(handler: Handler, ip: string) {
  const read = await readMe(handler, ip, fakeSupabaseAccessToken(TEST_USER_ID));
  const refresh = await postRefresh(handler, ip, `rt-healthy-peer-${crypto.randomUUID()}`);
  const bootstrap = await postBootstrap(handler, ip, fakeGoogleIdToken(OTHER_USER_ID));
  return { read: read.status, refresh: refresh.status, bootstrap: bootstrap.status };
}

const assertPeersServed = async (handler: Handler, ip: string, why: string) => {
  const peers = await peerStatuses(handler, ip);
  assertEquals(
    peers,
    { read: 200, refresh: 200, bootstrap: 200 },
    `${why} (egress charged = ${await egressCharged(ip)})`,
  );
};

const repeat = async (times: number, run: () => Promise<Response>): Promise<number[]> => {
  const statuses: number[] = [];
  for (let i = 0; i < times; i += 1) statuses.push((await run()).status);
  return statuses;
};

const allEqual = (statuses: number[], expected: number) =>
  statuses.every((status) => status === expected);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 1 — transitional (provider ID token) handsets share ONE anonymous
// shard with junk. `presented.anonymous` is true for every non-session bearer
// on a session route, so a valid old-build handset is gated by the shard that
// junk from the same egress fills.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test(
  "ATTACK 1a: 30 non-JWT junk bearers from a co-tenant lock a VALID transitional (Google ID token) handset out of the same egress",
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

    const afterNoise = await readMe(h.handler, ip, oldBuild);
    assertEquals(
      afterNoise.status,
      200,
      "…yet the SAME valid, already-verified transitional bearer must still be served",
    );
    const newcomer = await readMe(h.handler, ip, googleIdToken(OTHER_USER_ID));
    assertEquals(newcomer.status, 200, "a second old-build handset at the venue is served");
  },
);

Deno.test(
  "ATTACK 1b: ONE old-build handset retrying its own EXPIRED ID token 30× (benign, local refusals) locks every other old-build handset out of the venue",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const expired = googleIdToken(TEST_USER_ID, Math.floor(Date.now() / 1000) - 60);
    const retries = await repeat(LIMIT, () => readMe(h.handler, ip, expired));
    assert(allEqual(retries, 401), `expired ID token is refused locally: ${retries.join(",")}`);
    assertEquals(await egressCharged(ip), 0, "no venue budget was charged");

    const peer = await readMe(h.handler, ip, googleIdToken(OTHER_USER_ID));
    assertEquals(
      peer.status,
      200,
      "another old-build handset with a VALID ID token must be served (nothing was guessed)",
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 2 — residual venue lockout: the egress budget is still per IP. One
// handset presenting 30 DISTINCT forged session bearers closes it for every
// valid peer's read, refresh AND sign-in.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test(
  "ATTACK 2: one handset with 30 DISTINCT forged session bearers still locks VALID peers (read, refresh, bootstrap) out of the egress for 5 min",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const forged = new Set(Array.from({ length: LIMIT }, (_, i) => supabaseBearer(`forged-${i}`)));
    h.respond = (call) =>
      isUserCall(call) && forged.has(bearerOfCall(call)) ? credentialRefused() : null;

    await assertPeersServed(h.handler, ip, "peers are served before the stuffing");
    const statuses: number[] = [];
    for (const bearer of forged) statuses.push((await readMe(h.handler, ip, bearer)).status);
    assert(allEqual(statuses, 401), `every guess is refused: ${statuses.join(",")}`);
    assertEquals(await egressCharged(ip), LIMIT, "each distinct guess charged the venue budget");

    await assertPeersServed(
      h.handler,
      ip,
      "one handset's 30 guesses must not take the venue offline (objective: one NAT egress cannot lock out a venue)",
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 3 — memory-window cardinality. Every credential shard is its own
// window key. In the per-isolate memory fallback (no Upstash), MEMORY_WINDOW_MAX
// keys make every NEW key read as Infinity → 429 (fail closed). On BASE one
// egress opened 1 authfail key per window; on HEAD it opens up to 31.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test(
  "ATTACK 3: ~650 egresses × 30 refused guesses fill the memory windows — a fresh venue then fails CLOSED on its ip budget and on a valid peer's shard (BASE accounting for the same traffic stays open)",
  async () => {
    configureRedis(false);
    const BUDGET = AUTH_FAILURE_LIMIT;
    const egresses = Math.ceil(MEMORY_WINDOW_MAX / (BUDGET.limit + 1));

    // HEAD accounting: what handleRequest charges for 30 distinct refused
    // credentials per egress before the egress budget closes.
    const head = (await loadIsolate()).rateLimit;
    for (let e = 0; e < egresses; e += 1) {
      const ip = `198.51.${Math.floor(e / 250)}.${e % 250}`;
      for (let i = 0; i < BUDGET.limit; i += 1) {
        await head.chargeAuthFailure(
          ip,
          { identity: `guess-${e}-${i}`, anonymous: false },
          { kind: "credential" },
          BUDGET,
        );
      }
    }
    const venue = "203.0.113.77";
    const peer = await head.authFailureIdentity(fakeSupabaseAccessToken(TEST_USER_ID));
    const headIp = await head.enforceRateLimit("ip", venue, IP_LIMIT.limit, IP_LIMIT.windowSeconds);
    const headPeer = await head.peekAuthFailureBudget(
      venue,
      { identity: peer, anonymous: false },
      BUDGET,
    );

    // BASE accounting: the same refusals charged the flat per-IP counter.
    const base = (await loadIsolate()).rateLimit;
    for (let e = 0; e < egresses; e += 1) {
      const ip = `198.51.${Math.floor(e / 250)}.${e % 250}`;
      for (let i = 0; i < BUDGET.limit; i += 1) {
        await base.enforceRateLimit("authfail", ip, BUDGET.limit, BUDGET.windowSeconds);
      }
    }
    const baseIp = await base.enforceRateLimit("ip", venue, IP_LIMIT.limit, IP_LIMIT.windowSeconds);
    assertEquals(baseIp.allowed, true, "BASE: the venue's first request is allowed");

    assertEquals(
      { ip: headIp.allowed, peer: headPeer.allowed },
      { ip: true, peer: true },
      `HEAD: a venue that never failed must not be fenced (ip remaining=${headIp.remaining}, peer remaining=${headPeer.remaining})`,
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 4 — partial Redis failure. The "charge the egress only on the FIRST
// refusal" rule reads the shard's count from wherever the INCR landed. If the
// shard INCR fails over to isolate memory while the egress INCR reaches Redis,
// every isolate sees "first refusal" and the replayed credential charges the
// shared egress once PER ISOLATE.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test(
  "ATTACK 4: Redis rejecting only the shard INCRs makes ONE replayed credential charge the shared egress once per isolate — 30 replays across 30 isolates close the venue",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      redis.commandError = (cmd) =>
        cmd[0] === "INCR" && String(cmd[1]).includes(":authfail_id:")
          ? "ERR shard slot down"
          : null;
      const BUDGET = AUTH_FAILURE_LIMIT;
      const ip = "203.0.113.90";
      const first = await loadIsolate();
      const dead = await first.rateLimit.authFailureIdentity(supabaseBearer("dead-replayed"));
      const isolates = [first];
      for (let i = 1; i < BUDGET.limit; i += 1) isolates.push(await loadIsolate());
      for (const { rateLimit } of isolates) {
        await rateLimit.chargeAuthFailure(
          ip,
          { identity: dead, anonymous: false },
          { kind: "credential" },
          BUDGET,
        );
      }
      const egress = await first.rateLimit.peekRateLimit(
        "authfail",
        ip,
        BUDGET.limit,
        BUDGET.windowSeconds,
      );
      assertEquals(
        spent(egress),
        1,
        "one refused credential, however often replayed and wherever routed, charges the egress once",
      );
      assertEquals(egress.allowed, true, "the venue stays open");
    } finally {
      redis.restore();
      configureRedis(false);
    }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 5 — liveness amplification. Liveness refusals never charge the
// egress, so upstream Auth verifications from one egress are no longer
// bounded by the auth-failure budget: 39 dead session bearers replayed 30×
// each = 1170 GoTrue round trips in one window (BASE: 30, then 429).
// ═════════════════════════════════════════════════════════════════════════════
Deno.test(
  "ATTACK 5: 39 dead session bearers × 30 replays from one egress reach Supabase Auth 1170 times in one window while the venue budget stays at 0 (BASE stopped at 30)",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const dead = new Set(Array.from({ length: 39 }, (_, i) => supabaseBearer(`dead-${i}`)));
    h.respond = (call) => (isUserCall(call) && dead.has(bearerOfCall(call)) ? sessionGone() : null);

    let refused = 0;
    let throttled = 0;
    for (const bearer of dead) {
      for (const status of await repeat(LIMIT, () => readMe(h.handler, ip, bearer))) {
        if (status === 401) refused += 1;
        if (status === 429) throttled += 1;
      }
    }
    const upstream = h.calls.filter((call) => isUserCall(call) && dead.has(bearerOfCall(call)));
    assertEquals(await egressCharged(ip), 0, "liveness never charges the venue budget");
    await assertPeersServed(h.handler, ip, "peers are served throughout");
    assertEquals({ refused, throttled }, { refused: 39 * LIMIT, throttled: 0 });
    assert(
      upstream.length <= LIMIT,
      `one egress reached Supabase Auth ${upstream.length}× with dead credentials in one window; BASE bounded this to ${LIMIT} (IP_LIMIT ${IP_LIMIT.limit}/min is the only remaining cap)`,
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 6 — classification depends on GoTrue's `error_code`. A liveness
// refusal delivered in the older `{code, msg}` shape is counted as stuffing.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test(
  "ATTACK 6: 30 signed-out co-tenants whose GoTrue refusal carries no error_code (legacy {code,msg} shape) lock the venue out",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const signedOut = new Set(
      Array.from({ length: LIMIT }, (_, i) => supabaseBearer(`signed-out-legacy-${i}`)),
    );
    h.respond = (call) =>
      isUserCall(call) && signedOut.has(bearerOfCall(call)) ? sessionGoneLegacyShape() : null;
    const statuses: number[] = [];
    for (const bearer of signedOut) statuses.push((await readMe(h.handler, ip, bearer)).status);
    assert(allEqual(statuses, 401), `each signed-out peer is refused: ${statuses.join(",")}`);
    await assertPeersServed(
      h.handler,
      ip,
      "signed-out peers are liveness, not stuffing, whatever error body shape Auth used",
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 7 — window-boundary race. chargeAuthFailure() computes the window
// bucket separately for the shard INCR and the egress INCR; when the aligned
// window rolls between them the egress charge lands in the NEXT window, where
// the first replay opens a fresh shard and charges the egress again.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test(
  "ATTACK 7: a refusal straddling the window boundary charges the egress twice in the new window for ONE credential",
  async () => {
    configureRedis(false);
    const BUDGET = AUTH_FAILURE_LIMIT;
    const { rateLimit } = await loadIsolate();
    const realNow = Date.now;
    const windowMs = BUDGET.windowSeconds * 1_000;
    const bucket = Math.floor(realNow() / windowMs) + 2;
    const boundary = bucket * windowMs;
    let clock = boundary - 1;
    let reads = 0;
    Date.now = () => {
      reads += 1;
      // windowKey() + memoryIncr() read the clock for the shard INCR; the
      // egress INCR that follows sees the window rolled over.
      if (reads > 2) clock = boundary + 1;
      return clock;
    };
    try {
      const ip = "203.0.113.91";
      const dead = await rateLimit.authFailureIdentity(supabaseBearer("straddling"));
      await rateLimit.chargeAuthFailure(
        ip,
        { identity: dead, anonymous: false },
        { kind: "credential" },
        BUDGET,
      );
      clock = boundary + 1_000;
      await rateLimit.chargeAuthFailure(
        ip,
        { identity: dead, anonymous: false },
        { kind: "credential" },
        BUDGET,
      );
      const egress = await rateLimit.peekRateLimit(
        "authfail",
        ip,
        BUDGET.limit,
        BUDGET.windowSeconds,
      );
      assertEquals(spent(egress), 1, "one credential charges one window's egress at most once");
    } finally {
      Date.now = realNow;
    }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 8 — internal tagging headers must never reach the client.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test(
  "ATTACK 8: no 401 of any kind (local, liveness, credential; read/refresh/bootstrap) leaks the X-Auth-Refusal-* tags",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const forged = supabaseBearer("forged-header-leak");
    const dead = supabaseBearer("dead-header-leak");
    const deadRefresh = `rt-dead-${crypto.randomUUID()}`;
    const badIdToken = googleIdToken(OTHER_USER_ID);
    h.respond = (call) => {
      if (isUserCall(call) && bearerOfCall(call) === forged) return credentialRefused();
      if (isUserCall(call) && bearerOfCall(call) === dead) return sessionGone();
      if (isRefreshCall(call) && bodyField(call, "refresh_token") === deadRefresh) {
        return refreshRefused();
      }
      if (isIdTokenCall(call) && bodyField(call, "id_token") === badIdToken)
        return idTokenRefused();
      return null;
    };
    const responses = await Promise.all([
      h.handler(userRequest("GET", "/v1/me", { token: forged, ip })),
      h.handler(userRequest("GET", "/v1/me", { token: dead, ip })),
      h.handler(userRequest("GET", "/v1/me", { token: `junk-${crypto.randomUUID()}`, ip })),
      h.handler(userRequest("GET", "/v1/me", { token: supabaseBearer("expired", 1), ip })),
      h.handler(
        new Request("http://edge.test/functions/v1/api/v1/me", {
          headers: { "x-forwarded-for": ip },
        }),
      ),
      h.handler(
        new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
          method: "POST",
          headers: { "x-forwarded-for": ip, "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: deadRefresh }),
        }),
      ),
      h.handler(userRequest("POST", "/v1/account/bootstrap", { token: badIdToken, ip, body: {} })),
    ]);
    for (const response of responses) {
      assertEquals(response.status, 401);
      const leaked = [...response.headers.keys()].filter((name) =>
        name.toLowerCase().startsWith("x-auth-refusal"),
      );
      assertEquals(leaked, [], `internal tags leaked: ${leaked.join(",")}`);
      await response.body?.cancel();
    }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 9 — boundary values presented as bearers: nothing may 5xx, none may
// charge the venue, and peers stay served. Includes bootstrap junk (which the
// candidate charges nothing for) and a deletion-status capability on a
// session route.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test(
  "ATTACK 9: malformed / boundary bearers (exp NaN-string, negative, 1e300, array payload, blank, whitespace, capability, bootstrap junk) are 401 not 5xx, charge no venue budget, and peers stay served",
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
    // Upstream refuses anything it is actually asked about here.
    h.respond = (call) => (isUserCall(call) ? credentialRefused() : null);
    const statuses: number[] = [];
    for (const bearer of oddBearers) {
      statuses.push((await readMeWithAuthorization(h.handler, ip, `Bearer ${bearer}`)).status);
    }
    statuses.push((await readMeWithAuthorization(h.handler, ip, "Bearer")).status);
    statuses.push((await readMeWithAuthorization(h.handler, ip, "Basic dXNlcjpwdw==")).status);
    assert(
      statuses.every((status) => status === 401),
      `every odd bearer is a plain 401: ${statuses.join(",")}`,
    );
    const guessesReachingAuth = h.calls.filter(isUserCall).length;
    assertEquals(
      await egressCharged(ip),
      guessesReachingAuth,
      "only what Auth actually judged (and refused) is stuffing signal",
    );
    assert(guessesReachingAuth < LIMIT, "the boundary set itself stays under the venue budget");

    // Bootstrap with junk: 30 refusals, nothing charged, and the route budget
    // (AUTH_BOOTSTRAP_LIMIT 30/min) is what bounds it.
    const bootstrapJunk = await repeat(29, () =>
      postBootstrap(h.handler, ip, `junk-${crypto.randomUUID()}`),
    );
    assert(allEqual(bootstrapJunk, 401), `junk bootstrap → 401: ${bootstrapJunk.join(",")}`);
    assertEquals(await egressCharged(ip), guessesReachingAuth, "bootstrap junk charged nothing");
    h.respond = () => null;
    const legit = await postBootstrap(h.handler, ip, fakeGoogleIdToken(OTHER_USER_ID));
    assertEquals(
      legit.status,
      200,
      "the 30th bootstrap of the minute — a real sign-in — is served",
    );
    const read = await readMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID));
    const refresh = await postRefresh(h.handler, ip, `rt-healthy-${crypto.randomUUID()}`);
    assertEquals({ read: read.status, refresh: refresh.status }, { read: 200, refresh: 200 });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 10 — concurrency at the shard cap: 60 concurrent replays of ONE dead
// bearer racing 5 concurrent valid peers; the first 30 refusals land, the
// rest are throttled, peers are never fenced, and the egress reads exactly 1.
// ═════════════════════════════════════════════════════════════════════════════
Deno.test(
  "ATTACK 10: 60 concurrent replays of one refused bearer interleaved with valid peers — exactly 30 reach Auth, peers all 200, egress charged once",
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
    const peerStatuses = results.slice(60).map((r) => r.status);
    assertEquals(peerStatuses, [200, 200, 200, 200, 200], "peers racing the replay are served");
    assertEquals(await egressCharged(ip), 1, "egress charged once");
    await assertPeersServed(h.handler, ip, "peers still served after the race");
    assert(
      attacker.every((s) => s === 401 || s === 429),
      `replays are refused or throttled, never served: ${attacker.join(",")}`,
    );
    const upstream = h.calls.filter(
      (call) => isUserCall(call) && bearerOfCall(call) === forged,
    ).length;
    assertEquals(
      { refused: attacker.filter((s) => s === 401).length, upstream },
      { refused: LIMIT, upstream: LIMIT },
      `the shard cap (31st → 429) must hold for a concurrent burst too, not only sequentially: ${attacker.join(",")}`,
    );
  },
);
