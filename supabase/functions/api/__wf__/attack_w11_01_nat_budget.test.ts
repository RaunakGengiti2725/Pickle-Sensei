// ADVERSARIAL tests for W11-01 (auth-failure budgets behind a shared egress),
// attacking candidate 0f4a541a1b587bd199543a19f746e99d089a0f26 through the
// REAL handler. Each test asserts the behaviour the objective promises —
// "one NAT egress cannot lock out a venue" while token stuffing is still
// throttled — so a failing test IS a reproduced break, not a flaky attack.
//
// Attacks that hold on the candidate stay here as regression pins.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json attack_w11_01_nat_budget.test.ts

import { assert, assertEquals } from "@std/assert";
import { sha256Hex } from "../cache.ts";
import { peekRateLimit } from "../rateLimit.ts";
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
 * bearer that is already expired (the shape a device wakes up with). */
function supabaseBearer(salt: string, expOffsetSeconds = 3600): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: TEST_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      session_id: crypto.randomUUID(),
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

/** GoTrue's REAL verdict on a forged / unverifiable signature:
 * `apierrors.NewForbiddenError(ErrorCodeBadJWT, "invalid JWT: unable to parse
 * or verify signature, …")` → HTTP 403, error_code "bad_jwt"
 * (supabase/auth internal/api/auth.go, parseJWTClaims). */
const forbiddenBadJwt = () =>
  jsonResponse(403, {
    code: 403,
    error_code: "bad_jwt",
    msg: "invalid JWT: unable to parse or verify signature, token signature is invalid: signature is invalid",
  });

/** The 401 shape the candidate's own tests model for a bad JWT. */
const unauthorizedBadJwt = () =>
  jsonResponse(401, { code: 401, msg: "invalid JWT: unable to parse or verify signature" });

const refreshTokenRefused = () =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Invalid Refresh Token: Refresh Token Not Found",
  });

const idTokenRefused = () =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Bad ID token",
  });

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

/** Every `/auth/v1/user` consultation answers `respond()` (any bearer). */
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

async function getMe(
  handler: (request: Request) => Promise<Response>,
  ip: string,
  bearer: string,
): Promise<Response> {
  const response = await handler(userRequest("GET", "/v1/me", { token: bearer, ip }));
  await response.body?.cancel();
  return response;
}

async function postRefresh(
  handler: (request: Request) => Promise<Response>,
  ip: string,
  refreshToken: string,
): Promise<Response> {
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

async function postBootstrap(
  handler: (request: Request) => Promise<Response>,
  ip: string,
  idToken: string,
): Promise<Response> {
  const response = await handler(
    userRequest("POST", "/v1/account/bootstrap", { token: idToken, ip, body: {} }),
  );
  await response.body?.cancel();
  return response;
}

/** Failures charged to the egress-wide budget (what locks a whole venue). */
const egressCharged = async (ip: string): Promise<number> => {
  const window = await peekRateLimit(
    "authfail",
    ip,
    AUTH_FAILURE_LIMIT.limit,
    AUTH_FAILURE_LIMIT.windowSeconds,
  );
  return window.limit - window.remaining;
};

/** One credential's shard behind `ip`: refusals charged (saturates at the
 * limit — a fixed window reports no remaining below zero) and whether the
 * shard still admits the credential. */
const shardWindow = async (
  ip: string,
  credential: string,
): Promise<{ charged: number; allowed: boolean }> => {
  // Mirrors rateLimit.authFailureIdentity (imported symbols would not load on
  // BASE_SHA, and the reviewer runs this file there to establish the regression).
  assert(credential !== "", "a non-empty credential always has an identity");
  const identity = (await sha256Hex(credential)).slice(0, 32);
  const window = await peekRateLimit(
    "authfail_id",
    `${ip}:${identity}`,
    AUTH_FAILURE_LIMIT.limit,
    AUTH_FAILURE_LIMIT.windowSeconds,
  );
  return { charged: window.limit - window.remaining, allowed: window.allowed };
};
const shardCharged = async (ip: string, credential: string): Promise<number> =>
  (await shardWindow(ip, credential)).charged;

/** Pins Date.now() so fixed windows can be walked deterministically; the
 * clock starts 1 s into a fresh 300 s auth-failure bucket. */
function pinnedClock() {
  const realNow = Date.now;
  const bucketMs = AUTH_FAILURE_LIMIT.windowSeconds * 1_000;
  const start = Math.floor(realNow() / bucketMs) * bucketMs + 1_000;
  let now = start;
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
const freshIp = () => `10.66.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 1 — classification by HTTP status alone: GoTrue refuses a FORGED
// signature with 403 bad_jwt (not 401), which the candidate files as
// "liveness". Rotating forged bearers must still trip the egress budget.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "attack: rotating FORGED bearers refused by GoTrue as 403 bad_jwt still trip the egress-wide budget",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const stuffed = Array.from({ length: AUTH_FAILURE_LIMIT.limit + 10 }, (_, i) =>
      supabaseBearer(`forged-403-${i}`),
    );
    const auth = userVerdicts(
      Object.fromEntries(stuffed.map((bearer) => [bearer, forbiddenBadJwt])),
    );

    await withAuthUpstream(auth.upstream, async () => {
      const statuses: number[] = [];
      for (const bearer of stuffed) statuses.push((await getMe(h.handler, ip, bearer)).status);
      const charged = await egressCharged(ip);
      assertEquals(
        statuses.slice(0, AUTH_FAILURE_LIMIT.limit),
        new Array(AUTH_FAILURE_LIMIT.limit).fill(401),
        "each forged bearer up to the limit is a definitive 401",
      );
      assertEquals(
        charged,
        AUTH_FAILURE_LIMIT.limit,
        `30 distinct refused credentials must spend the egress budget; observed egress charged = ${charged}, statuses after the limit = ${statuses.slice(AUTH_FAILURE_LIMIT.limit).join(",")}, Auth consulted ${auth.total()} times`,
      );
      assertEquals(
        statuses[AUTH_FAILURE_LIMIT.limit],
        429,
        "the 31st distinct forged bearer is refused before Auth",
      );
      assertEquals(
        auth.consulted(stuffed[AUTH_FAILURE_LIMIT.limit]),
        0,
        "a tripped egress never reaches Auth",
      );
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 2 — the same evasion, sized to show Auth load: 200 forged bearers
// from ONE egress, all answered 403 bad_jwt. Base charged the IP for every
// 401 and stopped consulting Auth after 30.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "attack: an egress rotating 200 forged bearers (403 bad_jwt) reaches Auth at most limit times",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const auth = everyUserVerdict(forbiddenBadJwt);
    await withAuthUpstream(auth.upstream, async () => {
      let refused = 0;
      for (let i = 0; i < 200; i += 1) {
        const status = (await getMe(h.handler, ip, supabaseBearer(`flood-${i}`))).status;
        if (status === 429) refused += 1;
      }
      assert(
        auth.total() <= AUTH_FAILURE_LIMIT.limit,
        `Auth consulted ${auth.total()} times for 200 forged bearers from one egress (429s served: ${refused}); a stuffing egress must be cut off at ${AUTH_FAILURE_LIMIT.limit}`,
      );
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 3 — refresh-token replay: the shard is charged on every refusal but
// a refresh request presents no bearer, so nothing ever reads that shard.
// Walk five 60 s auth_refresh windows inside one 300 s auth-failure window.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "attack: one handset replaying a refused refresh token is bounded on its own shard (never more than limit Auth round trips per window)",
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
        for (let minute = 0; minute < 5; minute += 1) {
          if (minute > 0) clock.advance((AUTH_REFRESH_LIMIT.windowSeconds + 1) * 1_000);
          for (let i = 0; i < AUTH_REFRESH_LIMIT.limit; i += 1) {
            statuses.push((await postRefresh(h.handler, ip, dead)).status);
          }
        }
        const shard = await shardWindow(ip, dead);
        const egress = await egressCharged(ip);
        const definitive = statuses.filter((s) => s === 401).length;
        assert(
          rotations <= AUTH_FAILURE_LIMIT.limit,
          `Auth rotated the same dead refresh token ${rotations} times in one auth-failure window (401s served: ${definitive}, shard spent: ${!shard.allowed}, egress charged: ${egress}); the shard must gate the replaying handset after ${AUTH_FAILURE_LIMIT.limit}`,
        );
      });
    } finally {
      clock.restore();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 4 — venue lockout by EXPIRED session bearers. The app's long-lived
// clients resolve the bearer via bearerTokenFor() with no expiry check, so a
// device waking from suspension sends its expired access token before the
// keeper rotates it. The edge refuses that locally (never reaches Auth), yet
// files it as a credential attack. 30 devices waking behind one egress must
// not lock the venue out of /v1/auth/refresh.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "attack: 30 devices waking with expired session bearers behind one egress do not lock peers out of refresh",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const userCallsBefore = h.callsTo("/auth/v1/user").length;
    for (let device = 0; device < AUTH_FAILURE_LIMIT.limit; device += 1) {
      const expired = supabaseBearer(`woke-${device}`, -60);
      assertEquals((await getMe(h.handler, ip, expired)).status, 401);
    }
    assertEquals(
      h.callsTo("/auth/v1/user").length,
      userCallsBefore,
      "an expired bearer is refused locally — Auth is never consulted, so nothing was probed",
    );
    const egress = await egressCharged(ip);
    const peerRefresh = await postRefresh(h.handler, ip, "rt-healthy-peer");
    const peerRead = await getMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID));
    assert(
      peerRefresh.status !== 429 && peerRead.status !== 429,
      `30 expired-but-genuine bearers locked the venue: peer refresh → ${peerRefresh.status}, peer read → ${peerRead.status}, egress charged = ${egress}; a locally refused expiry probes nothing and must not spend the venue's stuffing budget`,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 5 — concurrency: 40 simultaneous replays of ONE refused bearer race
// the peek → charge sequence. The egress must be charged exactly once and the
// shard exactly 40 times (no under-count, no double charge).
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "attack: 40 concurrent replays of one refused bearer charge the egress once and the shard 40 times",
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
      assertEquals(auth.consulted(stale), 40, "the burst that passed the peek reached Auth");
      assertEquals(
        (await shardWindow(ip, stale)).allowed,
        false,
        "every replay landed on the shard",
      );
      assertEquals((await getMe(h.handler, ip, stale)).status, 429, "the shard is now spent");
      assertEquals(auth.consulted(stale), 40, "the spent shard stops consulting Auth");
      const peer = await getMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID));
      assertEquals(peer.status, 200, "peers behind the egress are untouched");
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 6 — concurrency across identities: 40 DISTINCT refused bearers in one
// burst. Bounded overshoot (the peek raced) is acceptable; the next request
// from the egress must be refused and the egress count must equal the burst.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "attack: a concurrent burst of 40 distinct refused bearers is fully counted and closes the egress",
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
      const next = await getMe(h.handler, ip, supabaseBearer("after-burst"));
      assertEquals(next.status, 429, "the egress is closed after the burst");
      assertEquals(auth.consulted(supabaseBearer("after-burst")), 0);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 7 — bootstrap stuffing and bootstrap replay: refused provider ID
// tokens must follow the same distinct-credential accounting as bearers.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "attack: bootstrap — one refused ID token replayed charges the egress once; 30 distinct refused ID tokens close it",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const upstream = onGrant("id_token", idTokenRefused);

    const replayIp = freshIp();
    const badIdToken = fakeGoogleIdToken("11111111-1111-4111-8111-111111111111");
    await withAuthUpstream(upstream, async () => {
      for (let i = 0; i < 25; i += 1) {
        assertEquals((await postBootstrap(h.handler, replayIp, badIdToken)).status, 401);
      }
    });
    assertEquals(
      await egressCharged(replayIp),
      1,
      "replaying one refused ID token is one egress charge",
    );
    assertEquals(await shardCharged(replayIp, badIdToken), 25);
    const peer = await getMe(h.handler, replayIp, fakeSupabaseAccessToken(TEST_USER_ID));
    assertEquals(peer.status, 200, "peers behind the egress keep working");

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
// ATTACK 8 — the service failing is not the credential failing: Auth 429 (+
// Retry-After), 5xx, redirect, malformed 2xx and a hung upstream must answer
// 503 and charge neither the shard nor the egress.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "attack: upstream 429/5xx/redirect/malformed-2xx/timeout never spend the auth-failure budget",
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
      [
        "timeout",
        () =>
          new Promise<Response>(() => {
            // never answers; the handler's deadline must fire
          }),
      ],
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
        assertEquals(auth.total() >= 2, true, `${label}: Auth was actually consulted`);
      }
      assertEquals(await egressCharged(ip), 0, "no service failure counts against the venue");
      const peer = await getMe(h.handler, ip, fakeSupabaseAccessToken(TEST_USER_ID));
      assertEquals(peer.status, 200);
    } finally {
      if (previousTimeout === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
      else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previousTimeout);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 9 — boundary values of the presented credential: an empty / blank /
// scheme-only Authorization header, a bare "Bearer" and huge bearers. Each is
// credential-less (no identity) or a distinct credential; none may crash, and
// a whitespace-only bearer must be accounted exactly like a missing one.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "attack: empty / whitespace / oversized bearers are refused 401 without a crash and are budgeted deterministically",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const headersOf = (authorization: string | null) => {
      const headers: Record<string, string> = { "x-forwarded-for": ip };
      if (authorization !== null) headers.Authorization = authorization;
      return headers;
    };
    const send = async (authorization: string | null) => {
      const response = await h.handler(
        new Request("http://edge.test/functions/v1/api/v1/me", {
          headers: headersOf(authorization),
        }),
      );
      await response.body?.cancel();
      return response.status;
    };
    // Credential-less shapes: each is one venue-wide failure by the pinned
    // bare-request policy (index_preauth_test) — deterministic, no throw.
    const credentialless = [null, "", "Bearer", "Bearer ", "Bearer    ", "bearer x.y.z"];
    for (const authorization of credentialless) {
      assertEquals(
        await send(authorization),
        401,
        `authorization=${JSON.stringify(authorization)}`,
      );
    }
    assertEquals(
      await egressCharged(ip),
      credentialless.length,
      "every credential-less refusal is one egress failure",
    );
    // Oversized garbage bearers are distinct credentials, each charged once
    // to the egress and to its own shard.
    const huge = `Bearer ${"A".repeat(64 * 1024)}`;
    assertEquals(await send(huge), 401);
    assertEquals(await send(huge), 401);
    assertEquals(await shardCharged(ip, "A".repeat(64 * 1024)), 2);
    assertEquals(await egressCharged(ip), credentialless.length + 1);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 10 — kind flip on one credential: a bearer first refused as liveness
// (403 session_not_found) and then as a credential (401) must be charged to
// the egress on the credential refusal — the liveness pass must not "use up"
// the shard's first-failure egress charge.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "attack: a credential whose first refusal was liveness is still charged to the egress when later refused as a credential",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile()];
    const ip = freshIp();
    const flip = supabaseBearer("kind-flip");
    let verdict: () => Response = () =>
      jsonResponse(403, {
        code: 403,
        error_code: "session_not_found",
        msg: "Session from session_id claim in JWT does not exist",
      });
    const auth = userVerdicts({ [flip]: () => verdict() });
    await withAuthUpstream(auth.upstream, async () => {
      assertEquals((await getMe(h.handler, ip, flip)).status, 401);
      assertEquals(await egressCharged(ip), 0, "liveness never charges the egress");
      verdict = unauthorizedBadJwt;
      assertEquals((await getMe(h.handler, ip, flip)).status, 401);
      const egress = await egressCharged(ip);
      assertEquals(
        egress,
        1,
        `a credential refusal must reach the egress even when the shard was opened by a liveness refusal; observed egress charged = ${egress}, shard charged = ${await shardCharged(ip, flip)}`,
      );
    });
  },
);
