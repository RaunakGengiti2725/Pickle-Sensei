// Auth-failure budgets behind a shared egress (W11-01), through the REAL
// handler and, for the memory-fallback bound, the rateLimit module itself.
//
// One NAT egress (club Wi-Fi, carrier-grade NAT) fronts a whole venue. The
// per-IP auth-failure budget (AUTH_FAILURE_LIMIT = 30 / 300 s) must still
// starve token stuffing — many DISTINCT refused credentials — while a single
// handset replaying its own dead bearer, thirty devices waking with expired
// bearers, or a signed-out session learning it is gone must never lock the
// venue out. Every refusal is therefore filed by WHAT it meant:
//
//   credential — the credential itself was refused (forged / garbage bearer,
//                GoTrue 401 or 403 bad_jwt, refused refresh or ID token):
//                charged to the credential's own shard and, the first time
//                that credential fails in the window, to the egress.
//   liveness   — a credential that was live and is not any more (fenced at
//                this edge after logout, 403 session_not_found upstream):
//                charged only to its shard — the holder learning the truth
//                is not an attack on the venue.
//   expired    — a bearer refused locally because its own `exp` has passed:
//                nothing was probed, nothing is charged.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json rateLimit_nat_budget.test.ts
//
// Only symbols that exist on the pre-fix code path are imported statically,
// so the file LOADS on the base revision and fails on its assertions there
// (the reviewer's regression proof); the memory-bound tests reach the new
// rateLimit API through loadIsolate().

import { assert, assertEquals } from "@std/assert";
import { sha256Hex } from "../cache.ts";
import { peekRateLimit } from "../rateLimit.ts";
import { configureRedis, loadIsolate } from "./harness.ts";
import {
  fakeGoogleIdToken,
  fakeSupabaseAccessToken,
  loadHarness,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

/** Mirrors AUTH_FAILURE_LIMIT / AUTH_REFRESH_LIMIT in index.ts. */
const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
const AUTH_REFRESH_LIMIT = { limit: 30, windowSeconds: 60 };
/** Mirrors MEMORY_WINDOW_MAX in rateLimit.ts. */
const MEMORY_WINDOW_MAX = 20_000;

const profile = () => ({
  id: TEST_USER_ID,
  email: "user@example.com",
  provider: "google",
  onboarding_state: "complete",
});

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A Supabase-shaped access token Auth will judge; `salt` keeps bearers
 * distinct so the auth cache never answers. `expOffsetSeconds` < 0 mints a
 * bearer that is already expired (what a device wakes up holding). */
function supabaseBearer(
  salt: string,
  expOffsetSeconds = 3600,
  sessionId: string = crypto.randomUUID(),
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: TEST_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      session_id: sessionId,
      exp: Math.floor(Date.now() / 1000) + expOffsetSeconds,
      salt,
    }),
  );
  return `${header}.${payload}.sig`;
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** GoTrue's verdict on a forged / unverifiable signature: HTTP 403 with
 * error_code "bad_jwt" (supabase/auth internal/api/auth.go parseJWTClaims →
 * apierrors.NewForbiddenError(ErrorCodeBadJWT, …)). */
const forbiddenBadJwt = () =>
  jsonResponse(403, {
    code: 403,
    error_code: "bad_jwt",
    msg: "invalid JWT: unable to parse or verify signature, token signature is invalid",
  });

const unauthorizedBadJwt = () =>
  jsonResponse(401, { code: 401, msg: "invalid JWT: unable to parse or verify signature" });

/** GoTrue's verdict on a signature-valid token whose session is gone
 * (maybeLoadUserOrSession → ErrorCodeSessionNotFound). */
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

const idTokenRefused = () =>
  jsonResponse(400, { error: "invalid_grant", error_description: "Bad ID token" });

type Upstream = (request: Request) => Promise<Response> | Response | null;

async function withAuthUpstream<T>(upstream: Upstream, run: () => Promise<T>): Promise<T> {
  const base = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const injected = await upstream(request.clone());
    if (injected) return injected;
    return base(request);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = base;
  }
}

const bearerOf = (request: Request): string =>
  (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");

/** Per-bearer verdicts for /auth/v1/user, counting consultations. */
function userVerdicts(verdicts: Record<string, () => Response>) {
  const consulted = new Map<string, number>();
  let total = 0;
  const upstream: Upstream = (request) => {
    if (!request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) return null;
    const bearer = bearerOf(request);
    const verdict = verdicts[bearer];
    if (!verdict) return null;
    consulted.set(bearer, (consulted.get(bearer) ?? 0) + 1);
    total += 1;
    return verdict();
  };
  return {
    upstream,
    consulted: (bearer: string) => consulted.get(bearer) ?? 0,
    total: () => total,
  };
}

/** Every /auth/v1/user consultation answers `respond()` (any bearer). */
function everyUserVerdict(respond: () => Response | Promise<Response>) {
  let total = 0;
  const upstream: Upstream = (request) => {
    if (!request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) return null;
    total += 1;
    return respond();
  };
  return { upstream, total: () => total };
}

const onGrant =
  (grant: string, respond: () => Response): Upstream =>
  (request) =>
    request.url.startsWith(`${SUPABASE_URL}/auth/v1/token`) &&
    request.url.includes(`grant_type=${grant}`)
      ? respond()
      : null;

type Handler = (request: Request) => Promise<Response>;

async function getMe(handler: Handler, ip: string, bearer: string): Promise<Response> {
  const response = await handler(userRequest("GET", "/v1/me", { token: bearer, ip }));
  await response.body?.cancel();
  return response;
}

async function postLogout(handler: Handler, ip: string, bearer: string): Promise<Response> {
  const response = await handler(
    userRequest("POST", "/v1/auth/logout", { token: bearer, ip, body: {} }),
  );
  await response.body?.cancel();
  return response;
}

async function postRefresh(handler: Handler, ip: string, refreshToken: string): Promise<Response> {
  const response = await handler(
    new Request("http://edge.test/v1/auth/refresh", {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    }),
  );
  await response.body?.cancel();
  return response;
}

async function postBootstrap(handler: Handler, ip: string, idToken: string): Promise<Response> {
  const response = await handler(
    userRequest("POST", "/v1/account/bootstrap", { token: idToken, ip, body: {} }),
  );
  await response.body?.cancel();
  return response;
}

const spent = (window: { limit: number; remaining: number }) => window.limit - window.remaining;

/** Failures charged to the egress-wide budget — what locks a whole venue. */
const egressCharged = async (ip: string): Promise<number> =>
  spent(
    await peekRateLimit("authfail", ip, AUTH_FAILURE_LIMIT.limit, AUTH_FAILURE_LIMIT.windowSeconds),
  );

/** One credential's shard behind `ip` (mirrors rateLimit.authFailureIdentity
 * and the `authfail_id` scope — imported symbols would not load on the base
 * revision, where the reviewer runs this file to establish the regression). */
const shardWindow = async (
  ip: string,
  credential: string,
): Promise<{ charged: number; allowed: boolean }> => {
  assert(credential !== "", "a non-empty credential always has an identity");
  const identity = (await sha256Hex(credential)).slice(0, 32);
  const window = await peekRateLimit(
    "authfail_id",
    `${ip}:${identity}`,
    AUTH_FAILURE_LIMIT.limit,
    AUTH_FAILURE_LIMIT.windowSeconds,
  );
  return { charged: spent(window), allowed: window.allowed };
};
const shardCharged = async (ip: string, credential: string): Promise<number> =>
  (await shardWindow(ip, credential)).charged;

/** Pins Date.now() so fixed windows can be walked deterministically; the
 * clock starts 1 s into a fresh 300 s auth-failure bucket. */
function pinnedClock() {
  const realNow = Date.now;
  const bucketMs = AUTH_FAILURE_LIMIT.windowSeconds * 1_000;
  let now = Math.floor(realNow() / bucketMs) * bucketMs + 1_000;
  Date.now = () => now;
  return {
    advance(ms: number) {
      now += ms;
    },
    restore() {
      Date.now = realNow;
    },
  };
}

let ipCounter = 0;
/** Unique egress per test: the rate-limit memory windows are module-global. */
const freshIp = () => `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

/** A healthy peer behind the same egress: a valid bearer must read, and a
 * refresh must reach Auth (the harness rotates any refresh token). */
async function assertPeersUntouched(handler: Handler, ip: string, context: string) {
  const read = await getMe(handler, ip, fakeSupabaseAccessToken(TEST_USER_ID));
  const refresh = await postRefresh(handler, ip, `rt-healthy-peer-${crypto.randomUUID()}`);
  assertEquals(
    { read: read.status, refresh: refresh.status },
    { read: 200, refresh: 200 },
    `${context}: peers behind the egress must be untouched (egress charged = ${await egressCharged(ip)})`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sharding: one replaying handset is throttled alone.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "one handset replaying a refused bearer is throttled on its own shard while the venue stays open",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const dead = supabaseBearer("dead-replayed");
    const auth = userVerdicts({ [dead]: unauthorizedBadJwt });
    await withAuthUpstream(auth.upstream, async () => {
      const statuses: number[] = [];
      for (let i = 0; i <= AUTH_FAILURE_LIMIT.limit; i += 1) {
        statuses.push((await getMe(h.handler, ip, dead)).status);
      }
      assertEquals(statuses.slice(0, AUTH_FAILURE_LIMIT.limit), new Array(30).fill(401));
      assertEquals(statuses[AUTH_FAILURE_LIMIT.limit], 429, "the replaying handset is throttled");
      assertEquals(auth.consulted(dead), AUTH_FAILURE_LIMIT.limit, "a spent shard stops at Auth");
      assertEquals(await shardCharged(ip, dead), AUTH_FAILURE_LIMIT.limit);
      assertEquals(await egressCharged(ip), 1, "one credential is one venue-wide failure");
      await assertPeersUntouched(h.handler, ip, "one dead handset");
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Stuffing protection: distinct refused credentials still close the egress,
// whatever HTTP status GoTrue used to refuse the signature.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "rotating refused bearers (401 and 403 bad_jwt alike) spend the egress budget and the 31st never reaches Auth",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const stuffed = Array.from({ length: AUTH_FAILURE_LIMIT.limit + 5 }, (_, i) =>
      supabaseBearer(`stuffed-${i}`),
    );
    const auth = userVerdicts(
      Object.fromEntries(
        stuffed.map((bearer, i) => [bearer, i % 2 === 0 ? forbiddenBadJwt : unauthorizedBadJwt]),
      ),
    );
    await withAuthUpstream(auth.upstream, async () => {
      const statuses: number[] = [];
      for (const bearer of stuffed) statuses.push((await getMe(h.handler, ip, bearer)).status);
      assertEquals(statuses.slice(0, AUTH_FAILURE_LIMIT.limit), new Array(30).fill(401));
      assertEquals(
        await egressCharged(ip),
        AUTH_FAILURE_LIMIT.limit,
        `30 distinct refused credentials spend the egress budget (Auth consulted ${auth.total()} times)`,
      );
      assertEquals(statuses.slice(AUTH_FAILURE_LIMIT.limit), new Array(5).fill(429));
      for (const bearer of stuffed.slice(AUTH_FAILURE_LIMIT.limit)) {
        assertEquals(auth.consulted(bearer), 0, "a tripped egress never reaches Auth");
      }
      assertEquals(auth.total(), AUTH_FAILURE_LIMIT.limit);
    });
  },
);

Deno.test(
  "an egress rotating 200 forged bearers answered 403 bad_jwt reaches Auth at most limit times",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const auth = everyUserVerdict(forbiddenBadJwt);
    await withAuthUpstream(auth.upstream, async () => {
      let refused = 0;
      for (let i = 0; i < 200; i += 1) {
        if ((await getMe(h.handler, ip, supabaseBearer(`flood-${i}`))).status === 429) refused += 1;
      }
      assertEquals(auth.total(), AUTH_FAILURE_LIMIT.limit, `429s served: ${refused}`);
      assertEquals(refused, 200 - AUTH_FAILURE_LIMIT.limit);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Liveness: a session that is gone is not an attack on the venue.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "liveness refusals (fenced after logout, 403 session_not_found) are bounded on the shard and never charge the egress",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();

    // A handset signs out, then keeps replaying a bearer of the fenced session
    // (the outbox retrying): refused at this edge without consulting Auth.
    const sessionId = crypto.randomUUID();
    const signedOut = supabaseBearer("signed-out", 3600, sessionId);
    assertEquals((await postLogout(h.handler, ip, signedOut)).status, 204);
    const userCallsAfterLogout = h.callsTo("/auth/v1/user").length;
    const fencedReplay = supabaseBearer("signed-out-replay", 3600, sessionId);
    const fenced: number[] = [];
    for (let i = 0; i <= AUTH_FAILURE_LIMIT.limit; i += 1) {
      fenced.push((await getMe(h.handler, ip, fencedReplay)).status);
    }
    assertEquals(fenced.slice(0, AUTH_FAILURE_LIMIT.limit), new Array(30).fill(401));
    assertEquals(fenced[AUTH_FAILURE_LIMIT.limit], 429, "the replaying handset is throttled");
    assertEquals(h.callsTo("/auth/v1/user").length, userCallsAfterLogout, "fence answers locally");
    assertEquals(await shardCharged(ip, fencedReplay), AUTH_FAILURE_LIMIT.limit);
    assertEquals(await egressCharged(ip), 0, "a fenced session never charges the egress");

    // A signature-valid bearer whose session Auth no longer knows.
    const gone = supabaseBearer("session-gone");
    const auth = userVerdicts({ [gone]: forbiddenSessionGone });
    await withAuthUpstream(auth.upstream, async () => {
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        assertEquals((await getMe(h.handler, ip, gone)).status, 401);
      }
      assertEquals((await getMe(h.handler, ip, gone)).status, 429);
      assertEquals(auth.consulted(gone), AUTH_FAILURE_LIMIT.limit, "the spent shard stops at Auth");
    });
    assertEquals(await shardCharged(ip, gone), AUTH_FAILURE_LIMIT.limit);
    assertEquals(await egressCharged(ip), 0, "session_not_found never charges the egress");
    await assertPeersUntouched(h.handler, ip, "two dead sessions");
  },
);

Deno.test(
  "a credential first refused as liveness is still charged to the egress when later refused as a credential",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const flip = supabaseBearer("kind-flip");
    let verdict: () => Response = forbiddenSessionGone;
    const auth = userVerdicts({ [flip]: () => verdict() });
    await withAuthUpstream(auth.upstream, async () => {
      assertEquals((await getMe(h.handler, ip, flip)).status, 401);
      assertEquals(await egressCharged(ip), 0, "liveness never charges the egress");
      verdict = forbiddenBadJwt;
      assertEquals((await getMe(h.handler, ip, flip)).status, 401);
      assertEquals((await getMe(h.handler, ip, flip)).status, 401);
      assertEquals(await egressCharged(ip), 1, "a credential refusal reaches the egress once");
      assertEquals(await shardCharged(ip, flip), 3);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Expired bearers: refused locally, nothing probed, nothing charged.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "40 devices waking with expired session bearers behind one egress charge nothing and lock nobody out",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const userCallsBefore = h.callsTo("/auth/v1/user").length;
    const expired = Array.from({ length: 40 }, (_, device) =>
      supabaseBearer(`woke-${device}`, -60),
    );
    for (const bearer of expired) {
      assertEquals((await getMe(h.handler, ip, bearer)).status, 401);
    }
    // The same handset retrying its expired bearer before the keeper rotates.
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
      assertEquals((await getMe(h.handler, ip, expired[0])).status, 401, "still a plain 401");
    }
    // An expired provider ID token at bootstrap is the same self-evident refusal.
    const staleIdToken = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
      JSON.stringify({
        iss: "https://accounts.google.com",
        sub: TEST_USER_ID,
        exp: Math.floor(Date.now() / 1000) - 60,
      }),
    )}.sig`;
    assertEquals((await postBootstrap(h.handler, ip, staleIdToken)).status, 401);
    assertEquals(h.callsTo("/auth/v1/user").length, userCallsBefore, "Auth was never consulted");
    assertEquals(h.callsTo("grant_type=id_token").length, 0, "the stale ID token was not spent");
    assertEquals(await egressCharged(ip), 0, "an expired bearer spends no venue budget");
    assertEquals(await shardCharged(ip, expired[0]), 0, "an expired bearer opens no shard");
    assertEquals(await shardCharged(ip, staleIdToken), 0);
    await assertPeersUntouched(h.handler, ip, "40 expired bearers");
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Refresh and bootstrap follow the same distinct-credential accounting.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "one handset replaying a refused refresh token charges the egress once and is bounded on its own shard",
  async () => {
    const clock = pinnedClock();
    try {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const dead = "rt-dead-replayed-forever";
      let rotations = 0;
      const upstream = onGrant("refresh_token", () => {
        rotations += 1;
        return refreshTokenRefused();
      });
      await withAuthUpstream(upstream, async () => {
        const statuses: number[] = [];
        // Five 60 s refresh windows inside one 300 s auth-failure window.
        for (let minute = 0; minute < 5; minute += 1) {
          if (minute > 0) clock.advance((AUTH_REFRESH_LIMIT.windowSeconds + 1) * 1_000);
          for (let i = 0; i < AUTH_REFRESH_LIMIT.limit; i += 1) {
            statuses.push((await postRefresh(h.handler, ip, dead)).status);
          }
        }
        assertEquals(statuses.filter((s) => s === 401).length, AUTH_FAILURE_LIMIT.limit);
        assertEquals(statuses.filter((s) => s === 429).length, 150 - AUTH_FAILURE_LIMIT.limit);
        assertEquals(rotations, AUTH_FAILURE_LIMIT.limit, "the spent shard stops rotating at Auth");
        assertEquals(await shardCharged(ip, dead), AUTH_FAILURE_LIMIT.limit);
        assertEquals(await egressCharged(ip), 1, "one refresh token is one venue-wide failure");
        await assertPeersUntouched(h.handler, ip, "one dead refresh token");
      });
    } finally {
      clock.restore();
    }
  },
);

Deno.test(
  "bootstrap: one refused ID token replayed charges the egress once; 30 distinct refused ID tokens close it",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const upstream = onGrant("id_token", idTokenRefused);

    const replayIp = freshIp();
    const badIdToken = fakeGoogleIdToken();
    await withAuthUpstream(upstream, async () => {
      for (let i = 0; i < 25; i += 1) {
        assertEquals((await postBootstrap(h.handler, replayIp, badIdToken)).status, 401);
      }
    });
    assertEquals(await egressCharged(replayIp), 1, "replaying one refused ID token is one failure");
    assertEquals(await shardCharged(replayIp, badIdToken), 25);
    await assertPeersUntouched(h.handler, replayIp, "one refused ID token");

    const stuffIp = freshIp();
    await withAuthUpstream(upstream, async () => {
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        const token = fakeGoogleIdToken(`22222222-2222-4222-8222-${String(i).padStart(12, "0")}`);
        assertEquals((await postBootstrap(h.handler, stuffIp, token)).status, 401);
      }
    });
    assertEquals(await egressCharged(stuffIp), AUTH_FAILURE_LIMIT.limit);
    const stuffedPeer = await getMe(h.handler, stuffIp, fakeSupabaseAccessToken(TEST_USER_ID));
    assertEquals(stuffedPeer.status, 429, "30 distinct refused ID tokens is a stuffing egress");
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency: atomic INCRs, no under-count and no double charge.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "40 concurrent replays of one refused bearer charge the egress once and the shard 40 times",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const stale = supabaseBearer("concurrent-replay");
    const auth = userVerdicts({ [stale]: unauthorizedBadJwt });
    await withAuthUpstream(auth.upstream, async () => {
      const responses = await Promise.all(
        Array.from({ length: 40 }, () => getMe(h.handler, ip, stale)),
      );
      assertEquals(
        responses.map((r) => r.status),
        new Array(40).fill(401),
        "a burst that passed the peek is answered definitively",
      );
      assertEquals(await egressCharged(ip), 1, "one credential, one egress charge");
      assertEquals(auth.consulted(stale), 40);
      assertEquals((await shardWindow(ip, stale)).allowed, false, "every replay hit the shard");
      assertEquals((await getMe(h.handler, ip, stale)).status, 429, "the shard is now spent");
      assertEquals(auth.consulted(stale), 40, "the spent shard stops consulting Auth");
      await assertPeersUntouched(h.handler, ip, "a concurrent replay burst");
    });
  },
);

Deno.test(
  "a concurrent burst of 40 distinct refused bearers is fully counted and closes the egress",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const burst = Array.from({ length: 40 }, (_, i) => supabaseBearer(`burst-${i}`));
    const auth = userVerdicts(Object.fromEntries(burst.map((b) => [b, unauthorizedBadJwt])));
    await withAuthUpstream(auth.upstream, async () => {
      const statuses = (await Promise.all(burst.map((b) => getMe(h.handler, ip, b)))).map(
        (r) => r.status,
      );
      assertEquals(statuses, new Array(40).fill(401));
      assertEquals(auth.total(), 40, "the burst that passed the peek reached Auth");
      const egress = await peekRateLimit(
        "authfail",
        ip,
        AUTH_FAILURE_LIMIT.limit,
        AUTH_FAILURE_LIMIT.windowSeconds,
      );
      assertEquals(egress.allowed, false, "every distinct refusal is counted (atomic INCR)");
      assertEquals(egress.remaining, 0);
      for (const bearer of burst) assertEquals(await shardCharged(ip, bearer), 1);
      const next = supabaseBearer("after-burst");
      assertEquals((await getMe(h.handler, ip, next)).status, 429, "the egress is closed");
      assertEquals(auth.consulted(next), 0);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// What is NOT a credential failure: the service failing, and credential-less
// requests (pinned bare-request policy: one venue-wide failure each).
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "upstream 429/5xx/redirect/malformed-2xx/timeout charge neither the shard nor the egress",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const outcomes: Array<[string, () => Response | Promise<Response>]> = [
      ["429", () => jsonResponse(429, { code: 429, msg: "rate limited" }, { "Retry-After": "7" })],
      ["500", () => new Response("upstream error", { status: 500 })],
      ["502", () => new Response("bad gateway", { status: 502 })],
      [
        "302",
        () => new Response(null, { status: 302, headers: { Location: `${SUPABASE_URL}/x` } }),
      ],
      ["200-malformed", () => jsonResponse(200, { unexpected: true })],
      ["200-not-json", () => new Response("<html>", { status: 200 })],
      ["timeout", () => new Promise<Response>(() => {})],
    ];
    const previousTimeout = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
    Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "150");
    try {
      for (const [label, respond] of outcomes) {
        const bearers = [supabaseBearer(`${label}-a`), supabaseBearer(`${label}-b`)];
        const auth = everyUserVerdict(respond);
        await withAuthUpstream(auth.upstream, async () => {
          for (const bearer of bearers) {
            const response = await getMe(h.handler, ip, bearer);
            assertEquals(response.status, 503, `${label}: the service, not the credential, failed`);
            const retryAfter = Number(response.headers.get("Retry-After"));
            assert(retryAfter >= 1, `${label}: 503 carries Retry-After (got ${retryAfter})`);
            if (label === "429") assertEquals(retryAfter, 7, "upstream Retry-After is relayed");
            assertEquals(await shardCharged(ip, bearer), 0, `${label}: shard untouched`);
          }
        });
        assert(auth.total() >= 2, `${label}: Auth was actually consulted`);
      }
      assertEquals(await egressCharged(ip), 0, "no service failure counts against the venue");
      await assertPeersUntouched(h.handler, ip, "service failures");
    } finally {
      if (previousTimeout === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
      else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previousTimeout);
    }
  },
);

Deno.test(
  "credential-less refusals charge the egress directly; an oversized garbage bearer is one distinct credential",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const send = async (authorization: string | null) => {
      const headers: Record<string, string> = { "x-forwarded-for": ip };
      if (authorization !== null) headers.Authorization = authorization;
      const response = await h.handler(
        new Request("http://edge.test/functions/v1/api/v1/me", { headers }),
      );
      await response.body?.cancel();
      return response.status;
    };
    const credentialless = [null, "", "Bearer", "Bearer ", "Bearer    ", "bearer x.y.z"];
    for (const authorization of credentialless) {
      assertEquals(
        await send(authorization),
        401,
        `authorization=${JSON.stringify(authorization)}`,
      );
    }
    assertEquals(await egressCharged(ip), credentialless.length);
    const huge = "A".repeat(64 * 1024);
    assertEquals(await send(`Bearer ${huge}`), 401);
    assertEquals(await send(`Bearer ${huge}`), 401);
    assertEquals(await shardCharged(ip, huge), 2);
    assertEquals(await egressCharged(ip), credentialless.length + 1);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Memory fallback (no Upstash): per-credential shards are a key space an
// unauthenticated caller populates, so their number per egress is capped.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "memory fallback: liveness refusals from 4 egresses cannot fill the window table and deny newcomers",
  async () => {
    configureRedis(false);
    const iso = await loadIsolate();
    const { chargeAuthFailure, peekAuthFailureBudget, enforceRateLimit, peekRateLimit } =
      iso.rateLimit;
    assertEquals((await enforceRateLimit("user", "player-inside", 240, 60)).allowed, true);

    const egresses = ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"];
    const perEgress = Math.ceil((MEMORY_WINDOW_MAX + 1) / egresses.length);
    let refusals = 0;
    for (const ip of egresses) {
      for (let i = 0; i < perEgress; i += 1) {
        const identity = `forged-${String(i).padStart(6, "0")}`;
        const gate = await peekAuthFailureBudget(ip, identity, AUTH_FAILURE_LIMIT);
        assertEquals(gate.allowed, true, `${ip} refusal ${refusals}: the gate stays open`);
        await chargeAuthFailure(ip, identity, "liveness", AUTH_FAILURE_LIMIT);
        refusals += 1;
      }
    }
    assertEquals(refusals, egresses.length * perEgress);

    const observed = {
      newcomerAuthGate: (await peekAuthFailureBudget("203.0.113.77", null, AUTH_FAILURE_LIMIT))
        .allowed,
      newcomerIpBudget: (await enforceRateLimit("ip", "203.0.113.77", 1_200, 60)).allowed,
      signedInUserBudget: (await enforceRateLimit("user", "player-next-minute", 240, 60)).allowed,
    };
    assertEquals(
      observed,
      { newcomerAuthGate: true, newcomerIpBudget: true, signedInUserBudget: true },
      `${refusals} liveness refusals over ${egresses.length} egresses must not deny unrelated clients`,
    );
    assertEquals((await peekRateLimit("user", "player-inside", 240, 60)).remaining, 239);
  },
);

Deno.test(
  "memory fallback: beyond the per-egress shard cap a credential refusal still charges the egress and liveness charges nothing",
  async () => {
    configureRedis(false);
    const iso = await loadIsolate();
    const { chargeAuthFailure, peekAuthFailureBudget, peekRateLimit } = iso.rateLimit;
    const budget = { limit: 5, windowSeconds: 300 };
    const ip = "198.51.100.9";
    const egress = async () =>
      spent(await peekRateLimit("authfail", ip, budget.limit, budget.windowSeconds));
    const shard = async (identity: string) =>
      spent(
        await peekRateLimit("authfail_id", `${ip}:${identity}`, budget.limit, budget.windowSeconds),
      );

    // Liveness refusals open shards up to the cap (2 × limit) and no further.
    const cap = 2 * budget.limit;
    for (let i = 0; i < cap + 20; i += 1) {
      await chargeAuthFailure(ip, `live-${i}`, "liveness", budget);
    }
    for (let i = 0; i < cap; i += 1) assertEquals(await shard(`live-${i}`), 1, `shard live-${i}`);
    for (let i = cap; i < cap + 20; i += 1) assertEquals(await shard(`live-${i}`), 0);
    assertEquals(await egress(), 0, "liveness never charges the egress");
    // A capped-out liveness credential is still admitted (nothing to throttle on).
    assertEquals((await peekAuthFailureBudget(ip, `live-${cap}`, budget)).allowed, true);

    // Credential refusals beyond the cap charge the egress directly — stuffing
    // is throttled exactly as before sharding.
    for (let i = 0; i < budget.limit; i += 1) {
      assertEquals((await peekAuthFailureBudget(ip, `forged-${i}`, budget)).allowed, true);
      await chargeAuthFailure(ip, `forged-${i}`, "credential", budget);
      assertEquals(await shard(`forged-${i}`), 0, "no shard beyond the cap");
    }
    assertEquals(await egress(), budget.limit);
    assertEquals(
      (await peekAuthFailureBudget(ip, `forged-${budget.limit}`, budget)).allowed,
      false,
    );
    assertEquals((await peekAuthFailureBudget(ip, null, budget)).allowed, false);

    // Shards that were open before the egress closed still report their own count.
    await chargeAuthFailure(ip, "live-0", "liveness", budget);
    assertEquals(await shard("live-0"), 2);
  },
);
