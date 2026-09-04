// Adjudication of area `edge-auth-cache-ratelimit` at 4d812e1a — INDEPENDENT
// reproductions of the auditor findings this adjudicator CONFIRMED. Every case
// asserts the contract the fix must satisfy and therefore FAILS on 4d812e1a;
// each failure message states the observed behaviour. Named *_repro.ts so the
// canonical `deno task test` glob does not collect it.
//
//   cd supabase/functions/api/__wf__ && \
//     deno test -A --no-check --config deno.json adjudicate_edge_auth_cache_ratelimit_repro.ts
//
// Findings reproduced here:
//   A  GoTrue transient failures (429 / 5xx / fetch throw) are answered 401 by
//      /v1/auth/refresh, authenticate() and bootstrap, and every one of them is
//      charged to the per-IP auth-failure budget (30 / 300 s).
//   B  /v1/auth/refresh during a GoTrue 5xx/network outage is held ~25 s by
//      auth-js's internal retry (8 upstream attempts) before the edge answers —
//      longer than the app's 15 s refresh timeout.
//   C  /v1/auth/logout: a thrown GoTrue fetch escapes logoutRoute → generic 500.
//   D  cacheDel() only evicts the caller's own L1; an isolate that VERIFIED the
//      bearer keeps serving it for the full auth-cache TTL (≤ 570 s).
//   E  Memory limiter: at 20 000 live windows the next new key wipes EVERY live
//      window, resetting an exhausted auth-failure budget to zero.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  fakeGoogleIdToken,
  loadHarness,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";
import { configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";

const h = await loadHarness();

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function supabaseAccessToken(jti: string, expSec = Math.floor(Date.now() / 1000) + 3600): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: TEST_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      exp: expSec,
      jti,
    }),
  );
  return `${header}.${payload}.sig`;
}

type Override = (request: Request, url: URL) => Response | Promise<Response> | null;

/** Intercept GoTrue calls in front of the harness's own fake Supabase. */
function withGoTrue<T>(override: Override, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/")) {
      const handled = await override(request.clone(), url);
      if (handled) return handled;
    }
    return previous(input, init);
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = previous;
  });
}

const goTrueJson = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const refreshRequest = (ip: string, refreshToken = "rt-device") =>
  new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ refreshToken }),
  });

const bootstrapRequest = (ip: string) =>
  userRequest("POST", "/v1/account/bootstrap", {
    ip,
    token: fakeGoogleIdToken(),
    body: {},
  });

/** True once the IP's auth-failure budget is spent: bootstrap is refused 429
 * BEFORE any GoTrue call (the harness's fake GoTrue would otherwise accept). */
async function ipLockedOut(ip: string): Promise<boolean> {
  const before = h.callsTo("/auth/v1/token").length;
  const response = await h.handler(bootstrapRequest(ip));
  await response.body?.cancel();
  return response.status === 429 && h.callsTo("/auth/v1/token").length === before;
}

// ── A ────────────────────────────────────────────────────────────────────────

Deno.test(
  "A1 refresh: GoTrue 429 (over_request_rate_limit) must not be a 401 sign-out signal, nor charge authfail",
  async () => {
    h.reset();
    const ip = "198.51.100.11";
    let status = 0;
    await withGoTrue(
      (_request, url) =>
        url.pathname === "/auth/v1/token"
          ? goTrueJson(429, {
              code: 429,
              error_code: "over_request_rate_limit",
              msg: "Rate limit exceeded",
            })
          : null,
      async () => {
        for (let i = 0; i < 30; i += 1) {
          const response = await h.handler(refreshRequest(ip));
          status = response.status;
          await response.body?.cancel();
        }
      },
    );
    const lockedOut = await ipLockedOut(ip);
    assertNotEquals(
      status,
      401,
      `OBSERVED: refresh answered ${status} for a GoTrue 429; apps/mobile sessionLifecycle.ts treats 401 as "session revoked" and signs the device out`,
    );
    assertEquals(
      lockedOut,
      false,
      "OBSERVED: 30 upstream 429s spent the IP's auth-failure budget (bootstrap now 429)",
    );
  },
);

Deno.test(
  "A2 refresh: GoTrue fetch throws (network) must be a retryable 5xx, not 401 (~25 s)",
  async () => {
    h.reset();
    const ip = "198.51.100.12";
    const startedAt = performance.now();
    const response = await withGoTrue(
      (_request, url) => {
        if (url.pathname !== "/auth/v1/token") return null;
        throw new TypeError("connection reset");
      },
      () => h.handler(refreshRequest(ip)),
    );
    const elapsedMs = Math.round(performance.now() - startedAt);
    await response.body?.cancel();
    assert(
      response.status >= 500 && response.status !== 401,
      `OBSERVED: refresh answered ${response.status} after ${elapsedMs} ms for a network failure to GoTrue (auth-js AuthRetryableFetchError has status 0, which refreshSessionRoute maps to 401)`,
    );
  },
);

Deno.test(
  "A3 authenticate: getUser 503 (GoTrue outage) must be 5xx, not 401 'session no longer valid', and must not charge authfail",
  async () => {
    h.reset();
    const ip = "198.51.100.13";
    let status = 0;
    let message = "";
    await withGoTrue(
      (_request, url) =>
        url.pathname === "/auth/v1/user"
          ? goTrueJson(503, { code: 503, msg: "service unavailable" })
          : null,
      async () => {
        for (let i = 0; i < 30; i += 1) {
          const response = await h.handler(
            userRequest("GET", "/v1/me", {
              ip,
              token: supabaseAccessToken(`outage-${i}`),
            }),
          );
          status = response.status;
          message = await response.text();
        }
      },
    );
    const lockedOut = await ipLockedOut(ip);
    assertNotEquals(
      status,
      401,
      `OBSERVED: authenticate() answered 401 ${message} while GoTrue was 503`,
    );
    assertEquals(
      lockedOut,
      false,
      "OBSERVED: 30 outage-time requests from one IP spent its auth-failure budget; bootstrap from that IP is 429 for up to 300 s",
    );
  },
);

Deno.test(
  "A4 bootstrap: signInWithIdToken 503 must be 5xx, not 401, and must not charge authfail",
  async () => {
    h.reset();
    const ip = "198.51.100.14";
    let status = 0;
    await withGoTrue(
      (_request, url) =>
        url.pathname === "/auth/v1/token"
          ? goTrueJson(503, { code: 503, msg: "service unavailable" })
          : null,
      async () => {
        for (let i = 0; i < 30; i += 1) {
          const response = await h.handler(bootstrapRequest(ip));
          status = response.status;
          await response.body?.cancel();
        }
      },
    );
    const lockedOut = await ipLockedOut(ip);
    assertNotEquals(
      status,
      401,
      "OBSERVED: bootstrap answered 401 'could not be verified' for a GoTrue 503",
    );
    assertEquals(
      lockedOut,
      false,
      "OBSERVED: 30 outage-time bootstraps locked the IP out of bootstrap after recovery",
    );
  },
);

// ── B ────────────────────────────────────────────────────────────────────────

Deno.test(
  "B refresh: GoTrue 503 → the edge must answer within the app's 15 s refresh timeout with ≤ 1 upstream attempt",
  async () => {
    h.reset();
    const attemptsAtMs: number[] = [];
    const startedAt = performance.now();
    const response = await withGoTrue(
      (_request, url) => {
        if (url.pathname !== "/auth/v1/token") return null;
        attemptsAtMs.push(Math.round(performance.now() - startedAt));
        return goTrueJson(503, { code: 503, msg: "service unavailable" });
      },
      () => h.handler(refreshRequest("198.51.100.15")),
    );
    const elapsedMs = Math.round(performance.now() - startedAt);
    await response.body?.cancel();
    assert(
      elapsedMs < 15_000 && attemptsAtMs.length <= 1,
      `OBSERVED: edge answered ${response.status} after ${elapsedMs} ms with ${attemptsAtMs.length} GoTrue attempts at +${attemptsAtMs.join(
        ", +",
      )} ms (auth-js retryable() backoff inside AUTO_REFRESH_TICK_DURATION_MS = 30 s); apps/mobile REQUEST_TIMEOUT_MS = 15 000`,
    );
  },
);

// ── C ────────────────────────────────────────────────────────────────────────

Deno.test(
  "C logout: a thrown GoTrue fetch must be the generic 503, not the unhandled 500",
  async () => {
    h.reset();
    const token = supabaseAccessToken("logout-net");
    const response = await withGoTrue(
      (_request, url) => {
        if (url.pathname === "/auth/v1/user") {
          return goTrueJson(200, {
            id: TEST_USER_ID,
            aud: "authenticated",
            role: "authenticated",
            email: "user@example.com",
            app_metadata: { provider: "google", providers: ["google"] },
            user_metadata: {},
          });
        }
        if (url.pathname !== "/auth/v1/logout") return null;
        throw new TypeError("connection reset");
      },
      () => h.handler(userRequest("POST", "/v1/auth/logout", { ip: "198.51.100.16", token })),
    );
    const body = await response.text();
    assertEquals(
      response.status,
      503,
      `OBSERVED: logout answered ${response.status} ${body} (logoutRoute's fetch has no try/catch; Deno.serve's outer catch answers 500)`,
    );
  },
);

// ── D ────────────────────────────────────────────────────────────────────────

Deno.test(
  "D cacheDel: an isolate that VERIFIED a bearer must stop serving it within ≤ 60 s of another isolate's logout eviction",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const a = await loadIsolate();
      const b = await loadIsolate();
      const key = "auth:adjudicate-d";
      // Isolate A verified the bearer: writeAuthCache → cacheSet(full TTL 570 s).
      await a.cache.cacheSet(key, JSON.stringify({ userId: TEST_USER_ID }), 570);
      // Isolate B handles the logout: cacheDel(key).
      await b.cache.cacheDel(key);
      assertEquals(await b.cache.cacheGet(key), null, "precondition: L2 + B's L1 are evicted");
      const stillServedByA = (await a.cache.cacheGet(key)) !== null;
      assertEquals(
        stillServedByA,
        false,
        "OBSERVED: isolate A still serves the revoked bearer from its own L1 (cacheDel only deletes the caller's memory map + Redis; cacheSet's L1 TTL is the full 570 s, only Redis-warmed L1 entries are capped at 60 s)",
      );
    } finally {
      redis.restore();
      configureRedis(false);
    }
  },
);

// ── E ────────────────────────────────────────────────────────────────────────

Deno.test(
  "E memory limiter: hitting the 20 000-window cap must not reset an exhausted auth-failure budget",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const victimIp = "203.0.113.99";
    for (let i = 0; i < 31; i += 1) {
      await rateLimit.enforceRateLimit("authfail", victimIp, 30, 300);
    }
    const before = await rateLimit.peekRateLimit("authfail", victimIp, 30, 300);
    assertEquals(before.allowed, false, "precondition: victim budget spent");
    for (let i = 0; i < 20_000; i += 1) {
      await rateLimit.enforceRateLimit(
        "ip",
        `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`,
        1_200,
        60,
      );
    }
    const after = await rateLimit.peekRateLimit("authfail", victimIp, 30, 300);
    assertEquals(
      after.allowed,
      false,
      `OBSERVED: after 20 000 unrelated live windows the victim's count went ${before.remaining}/${before.limit} remaining → ${after.remaining}/${after.limit} remaining (rateLimit.ts memoryIncr: windows.clear() when no window is expired)`,
    );
  },
);
