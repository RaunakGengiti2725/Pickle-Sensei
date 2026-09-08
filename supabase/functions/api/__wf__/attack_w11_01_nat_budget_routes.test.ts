// W11-01 adversary — auth-failure budgets behind a shared NAT egress, attacked
// through the REAL edge handler (routesHarness.ts). Candidate 7cbb268a.
//
// Objective under test: "shards auth-failure budgets so one NAT egress cannot
// lock out a venue". Each Deno.test below is one attack at a failure
// boundary; the assertions state the behaviour the objective requires, so a
// failing test IS the reproduced break.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json attack_w11_01_nat_budget_routes.test.ts

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
/** Mirrors AUTH_FAILURE_SHARD_CAP × limit in rateLimit.ts. */
const SHARD_CAP = 2 * AUTH_FAILURE_LIMIT.limit;

const profile = () => ({
  id: TEST_USER_ID,
  email: "user@example.com",
  provider: "google",
  onboarding_state: "complete",
});

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A Supabase-shaped access token Auth will judge; `salt` keeps bearers distinct. */
function supabaseBearer(salt: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: TEST_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      session_id: crypto.randomUUID(),
      exp: Math.floor(Date.now() / 1000) + 3600,
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

const forbiddenBadJwt = () =>
  jsonResponse(403, {
    code: 403,
    error_code: "bad_jwt",
    msg: "invalid JWT: unable to parse or verify signature, token signature is invalid",
  });

const forbiddenSessionGone = () =>
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

type Handler = (request: Request) => Promise<Response>;

let ipCounter = 0;
/** Unique egress per test: the rate-limit memory windows are module-global. */
const freshIp = () => `10.99.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

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

/** GET /v1/me with NO Authorization header at all. */
const readMeWithoutCredential = (handler: Handler, ip: string) =>
  send(
    handler,
    new Request("http://edge.test/functions/v1/api/v1/me", {
      method: "GET",
      headers: { "x-forwarded-for": ip },
    }),
  );

/** GET /v1/me with a raw Authorization header value (scheme attacks). */
const readMeWithAuthorization = (handler: Handler, ip: string, authorization: string) =>
  send(
    handler,
    new Request("http://edge.test/functions/v1/api/v1/me", {
      method: "GET",
      headers: { "x-forwarded-for": ip, Authorization: authorization },
    }),
  );

const postRefresh = (handler: Handler, ip: string, refreshToken: string) =>
  send(
    handler,
    new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    }),
  );

/** What a healthy peer behind the egress sees: a valid session bearer reading
 * /v1/me, and a live refresh token rotating (the harness rotates any refresh
 * token Auth is asked about, unless a test injects a refusal). */
async function peerStatuses(handler: Handler, ip: string) {
  const read = await readMe(handler, ip, fakeSupabaseAccessToken(TEST_USER_ID));
  const refresh = await postRefresh(handler, ip, `rt-healthy-peer-${crypto.randomUUID()}`);
  return {
    read: read.status,
    refresh: refresh.status,
    retryAfter: read.headers.get("Retry-After"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 1 — boundary value: NO credential at all. Thirty bare requests from
// one device (a browser tab, a health probe, curl) must not deny the venue.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "ATTACK-1 thirty credential-less 401s from one device must not lock valid peers out of the egress",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
      statuses.push((await readMeWithoutCredential(h.handler, ip)).status);
    }
    assertEquals(statuses, new Array(AUTH_FAILURE_LIMIT.limit).fill(401));
    assertEquals(
      h.callsTo("/auth/v1/user").length,
      0,
      "a request without a credential never consulted Auth — nothing was probed",
    );
    const peers = await peerStatuses(h.handler, ip);
    assertEquals(
      { read: peers.read, refresh: peers.refresh },
      { read: 200, refresh: 200 },
      `30 requests WITHOUT any credential from one device locked the venue out ` +
        `(egress charged = ${await egressCharged(ip)}, Retry-After = ${peers.retryAfter}s)`,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 2 — zero-knowledge garbage bearers. Thirty distinct non-JWT strings
// are refused locally (never reach Auth) yet spend the venue's budget.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "ATTACK-2 thirty locally-refused garbage bearers (never sent to Auth) must not lock valid peers out",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
      statuses.push((await readMe(h.handler, ip, `not-a-jwt-${i}`)).status);
    }
    assertEquals(statuses, new Array(AUTH_FAILURE_LIMIT.limit).fill(401));
    assertEquals(
      h.callsTo("/auth/v1/user").length,
      0,
      "garbage bearers are refused before Auth — the attacker spent nothing upstream",
    );
    const peers = await peerStatuses(h.handler, ip);
    assertEquals(
      { read: peers.read, refresh: peers.refresh },
      { read: 200, refresh: 200 },
      `30 garbage bearers that never reached Auth locked the venue out ` +
        `(egress charged = ${await egressCharged(ip)}, Retry-After = ${peers.retryAfter}s)`,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 3 — malformed scheme. RFC 7235 auth-scheme is case-insensitive, so
// `authorization: bearer <valid token>` is a well-formed request carrying a
// VALID session; here it is read as "no credential" and charges the egress.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "ATTACK-3 a lowercase `bearer` scheme carrying a VALID session replayed 30× must not lock the venue out",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const valid = fakeSupabaseAccessToken(TEST_USER_ID);
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
      statuses.push((await readMeWithAuthorization(h.handler, ip, `bearer ${valid}`)).status);
    }
    // Refusing the lowercase scheme is pre-existing behaviour; the attack is
    // what the refusals are charged to.
    assert(
      statuses.every((s) => s === 401 || s === 200),
      `statuses ${statuses.join(",")}`,
    );
    const peers = await peerStatuses(h.handler, ip);
    assertEquals(
      { read: peers.read, refresh: peers.refresh },
      { read: 200, refresh: 200 },
      `one device replaying ONE credential under a lowercase scheme locked the venue out ` +
        `(egress charged = ${await egressCharged(ip)})`,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 4 — refresh route stuffing with random strings. No bearer, no JWT:
// thirty POST /v1/auth/refresh with distinct junk close the venue.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "ATTACK-4 thirty refused junk refresh tokens in one minute must not lock valid peers out",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    h.respond = (call) =>
      call.url.startsWith(`${SUPABASE_URL}/auth/v1/token`) &&
      call.url.includes("grant_type=refresh_token") &&
      typeof call.body === "object" &&
      call.body !== null &&
      String((call.body as Record<string, unknown>).refresh_token).startsWith("junk-")
        ? refreshTokenRefused()
        : null;
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
      statuses.push((await postRefresh(h.handler, ip, `junk-${i}`)).status);
    }
    assertEquals(statuses, new Array(AUTH_FAILURE_LIMIT.limit).fill(401));
    const read = await readMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID));
    assertEquals(
      read.status,
      200,
      `30 junk refresh tokens from one device locked a valid bearer out ` +
        `(egress charged = ${await egressCharged(ip)}, Retry-After = ${read.headers.get("Retry-After")}s)`,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 5 — replay beyond the shard cap. Once a venue has seen SHARD_CAP
// distinct liveness refusals (signed-out sessions learning they are gone —
// none of which charges the egress), the replay budget no longer exists for
// new credentials: ONE handset replaying ONE refused bearer charges the
// egress on every refusal and locks the venue out — the exact regression the
// package fixes, reachable from legitimate traffic.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "ATTACK-5 beyond the shard cap one handset replaying one refused bearer must still be throttled alone",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const signedOut = Array.from({ length: SHARD_CAP }, (_, i) =>
      supabaseBearer(`signed-out-${i}`),
    );
    const forged = supabaseBearer("forged-replayed");
    const consulted = new Map<string, number>();
    h.respond = (call) => {
      if (!call.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) return null;
      const bearer = (call.headers.authorization ?? "").replace(/^Bearer /, "");
      consulted.set(bearer, (consulted.get(bearer) ?? 0) + 1);
      if (bearer === forged) return forbiddenBadJwt();
      if (signedOut.includes(bearer)) return forbiddenSessionGone();
      return null;
    };
    for (const bearer of signedOut) assertEquals((await readMe(h.handler, ip, bearer)).status, 401);
    assertEquals(await egressCharged(ip), 0, "liveness refusals never charge the egress");

    const statuses: number[] = [];
    for (let i = 0; i <= AUTH_FAILURE_LIMIT.limit; i += 1) {
      statuses.push((await readMe(h.handler, ip, forged)).status);
    }
    const peers = await peerStatuses(h.handler, ip);
    assertEquals(
      {
        egressCharged: await egressCharged(ip),
        replayerConsultedAuth: consulted.get(forged) ?? 0,
        replayer31st: statuses[AUTH_FAILURE_LIMIT.limit],
        peerRead: peers.read,
        peerRefresh: peers.refresh,
      },
      {
        egressCharged: 1,
        replayerConsultedAuth: AUTH_FAILURE_LIMIT.limit,
        replayer31st: 429,
        peerRead: 200,
        peerRefresh: 200,
      },
      `after ${SHARD_CAP} signed-out peers, one replayed bearer locked the venue out ` +
        `(Retry-After = ${peers.retryAfter}s)`,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 6 — concurrency: a single burst of distinct forged bearers is peeked
// before any of them is charged. The budget must still close behind the burst
// and the very next forged bearer must not reach Auth.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "ATTACK-6 a concurrent burst of 100 distinct forged bearers closes the egress behind it (next one never reaches Auth)",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    let consulted = 0;
    h.respond = (call) => {
      if (!call.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) return null;
      consulted += 1;
      return forbiddenBadJwt();
    };
    const burst = await Promise.all(
      Array.from({ length: 100 }, (_, i) => readMe(h.handler, ip, supabaseBearer(`burst-${i}`))),
    );
    const inBurst = consulted;
    assert(
      burst.every((r) => r.status === 401),
      "peek-before-charge admits the whole burst (documented race; bounded by concurrency)",
    );
    const next = await readMe(h.handler, ip, supabaseBearer("after-burst"));
    assertEquals(
      { nextStatus: next.status, consultedAfterBurst: consulted - inBurst },
      { nextStatus: 429, consultedAfterBurst: 0 },
      `burst consulted Auth ${inBurst} times; egress charged = ${await egressCharged(ip)}`,
    );
    assert(inBurst <= 100, "never more consultations than requests");
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 7 — duplicate identity across routes: the same dead session bearer
// replayed on /v1/me and presented as the bearer of a refresh call must be one
// credential (one egress charge), and the refresh (a DIFFERENT credential in
// the body) must not be gated by the dead bearer's spent shard.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "ATTACK-7 a spent bearer shard must not block a refresh that carries a live refresh token in its body",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const dead = supabaseBearer("dead-on-device");
    h.respond = (call) =>
      call.url.startsWith(`${SUPABASE_URL}/auth/v1/user`) &&
      (call.headers.authorization ?? "") === `Bearer ${dead}`
        ? forbiddenBadJwt()
        : null;
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
      assertEquals((await readMe(h.handler, ip, dead)).status, 401);
    }
    assertEquals((await readMe(h.handler, ip, dead)).status, 429, "the shard is spent");
    assertEquals(await egressCharged(ip), 1);
    // The device's refresh call carries its (dead) access token as bearer, as
    // an SDK-style client would, and a live refresh token in the body.
    const refresh = await send(
      h.handler,
      new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
        method: "POST",
        headers: {
          "x-forwarded-for": ip,
          "content-type": "application/json",
          Authorization: `Bearer ${dead}`,
        },
        body: JSON.stringify({ refreshToken: `rt-live-${crypto.randomUUID()}` }),
      }),
    );
    assertEquals(
      refresh.status,
      200,
      "the refresh token is the credential of a refresh — a dead bearer's shard must not gate it",
    );
  },
);
