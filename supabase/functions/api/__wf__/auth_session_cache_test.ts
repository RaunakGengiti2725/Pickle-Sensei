// auth-session-lifecycle reproduction against the real cache.ts primitives.
//
// index.ts cannot be imported under `deno test` (top-level Deno.serve + env
// reads), so the two dispatcher snippets under test are mirrored here
// verbatim with their source lines cited:
//
//   * authfail budget — index.ts:2090, 2152-2161, 2171-2177
//   * account-deletion cache cleanup — index.ts confirmAccountDeletion:
//       `await cacheDel(rankCacheKey(authed.id), progressCacheKey(authed.id));`
//     (the `auth:<sha256(token)>` entry written at index.ts:279-293 is left
//     alone on purpose per the comment above that call).
//
// Run: deno test --allow-env supabase/functions/api/__wf__/
import { cacheDel, cacheGet, cacheSet, sha256Hex } from "../cache.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message ?? "values differ"}: expected ${JSON.stringify(
        expected,
      )}, got ${JSON.stringify(actual)}`,
    );
  }
}

const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 }; // index.ts:2090

/** Mirror of the pre-auth check + post-401 bookkeeping in Deno.serve. */
async function dispatch(ip: string, authenticate: () => 401 | 200): Promise<200 | 401 | 429> {
  const failKey = `authfail:${ip}`; // index.ts:2152
  const failedRecently = Number((await cacheGet(failKey)) ?? "0"); // :2153
  if (failedRecently >= AUTH_FAILURE_LIMIT.limit) return 429; // :2154-2161
  const status = authenticate(); // :2171
  if (status === 401) {
    // index.ts:2173-2175 — plain SET, so the window slides from the LAST
    // failure rather than the first.
    await cacheSet(failKey, String(failedRecently + 1), AUTH_FAILURE_LIMIT.windowSeconds);
  }
  return status;
}

function withClock(startMs: number) {
  const realNow = Date.now;
  let now = startMs;
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

Deno.test(
  "one stale-bearer client on a shared IP locks out fresh sign-ins from that IP",
  async () => {
    const clock = withClock(1_800_000_000_000);
    try {
      const ip = "203.0.113.7"; // carrier NAT egress shared by many handsets
      let staleClientRequests = 0;
      // A signed-in handset whose provider identity token passed `exp`: the
      // mobile outbox retries every 30 s (syncRuntime.ts:8,56) and never
      // rotates the bearer, so every request is a 401.
      for (let tick = 0; tick < AUTH_FAILURE_LIMIT.limit; tick++) {
        const status = await dispatch(ip, () => 401);
        staleClientRequests++;
        assertEquals(status, 401);
        clock.advance(30_000);
      }
      assertEquals(staleClientRequests, 30);
      // 15 minutes of one idle-but-open app is enough to trip the IP budget.
      assertEquals(await cacheGet(`authfail:${ip}`), "30");

      // A DIFFERENT user behind the same IP now tries to sign in
      // (POST /v1/account/bootstrap goes through the same pre-auth gate,
      // index.ts:2147-2161, before authenticate() ever runs).
      let freshAuthCalls = 0;
      const freshSignIn = await dispatch(ip, () => {
        freshAuthCalls++;
        return 200;
      });
      assertEquals(freshSignIn, 429);
      assertEquals(freshAuthCalls, 0, "valid credentials were never examined");

      // The lockout lasts the full window measured from the LAST failure
      // (30 s already elapsed since it inside the loop above).
      clock.advance(269_000);
      assertEquals(await dispatch(ip, () => 200), 429);
      clock.advance(2_000);
      assertEquals(await dispatch(ip, () => 200), 200);
    } finally {
      clock.restore();
      await cacheDel("authfail:203.0.113.7");
    }
  },
);

Deno.test(
  "verified-session entry outlives account deletion: cacheDel(rank, progress) leaves auth:<hash> readable until expiresAtMs",
  async () => {
    const clock = withClock(1_800_000_000_000);
    try {
      const userId = "7fc2c743-028f-4ec6-942c-a84508f3be38";
      const token = "eyJhbGciOiJSUzI1NiJ9.stale-apple-identity-token.sig";
      const authKey = `auth:${await sha256Hex(token)}`; // index.ts:241
      const expiresAtMs = Date.now() + 600_000; // AUTH_CACHE_MAX_TTL_SECONDS
      const ttlSeconds = Math.floor((expiresAtMs - Date.now()) / 1_000) - 30; // :283
      await cacheSet(
        authKey,
        JSON.stringify({
          userId,
          email: null,
          provider: "apple",
          accessToken: "supabase-access-jwt",
          expiresAtMs,
        }),
        ttlSeconds,
      );
      await cacheSet(`rank:${userId}`, "{}", 60);
      await cacheSet(`progress:${userId}`, "{}", 60);

      // confirmAccountDeletion: auth.admin.deleteUser(...) succeeded, then only
      // the derived keys are dropped.
      await cacheDel(`rank:${userId}`, `progress:${userId}`);

      assertEquals(await cacheGet(`rank:${userId}`), null);
      assertEquals(await cacheGet(`progress:${userId}`), null);
      const cached = await cacheGet(authKey);
      assert(cached !== null, "deleted user's verified session is still cached");
      const parsed = JSON.parse(cached) as {
        userId: string;
        expiresAtMs: number;
      };
      assertEquals(parsed.userId, userId);

      // The authenticate() acceptance test (index.ts:246) keeps passing for the
      // deleted account for ~9.5 more minutes of wall clock.
      clock.advance(9 * 60_000);
      const later = await cacheGet(authKey);
      assert(later !== null);
      assert(
        (JSON.parse(later) as { expiresAtMs: number }).expiresAtMs > Date.now() + 5_000,
        "still accepted by the cached-session branch",
      );
      clock.advance(60_000);
      assertEquals(await cacheGet(authKey), null, "only time evicts it");
    } finally {
      clock.restore();
    }
  },
);
