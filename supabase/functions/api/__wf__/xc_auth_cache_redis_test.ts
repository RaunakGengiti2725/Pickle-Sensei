// The auth cache's shared (L2, Upstash Redis) tier, driven through the real
// handler with a fake Upstash REST endpoint (xc_sessionHarness.ts, redis: true).
// Own module on purpose: cache.ts reads UPSTASH_* at import time, so the
// Redis-enabled function has to boot in its own isolate.
//
// Written for mutation survivor ED-02 (readAuthCache serving entries past
// their own expiresAtMs): with only the per-isolate L1 that guard is
// unobservable because L1 evicts 30s earlier; it only bites when the SHARED
// store still holds a record whose embedded expiry has passed (clock skew
// between instances, or a Redis TTL that outlived the bearer).
//
//   cd supabase/functions/api/__wf__ && deno task test xc_auth_cache_redis_test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  GOOGLE_USER_ID,
  apiRequest,
  errorMessage,
  loadSessionHarness,
  withClockOffset,
  withFrozenClock,
} from "./xc_sessionHarness.ts";

function authCacheKeys(redis: Map<string, { value: string }>): string[] {
  return [...redis.entries()]
    .filter(([, entry]) => entry.value.includes('"userId"'))
    .map(([key]) => key);
}

Deno.test(
  "a verified session is written to the shared cache with a TTL bounded by the 10-minute cap",
  async () => {
    const h = await loadSessionHarness({ redis: true });
    const minted = h.mintSession(GOOGLE_USER_ID, 3600);
    await withFrozenClock(async () => {
      const response = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
      assertEquals(response.status, 200);
      await response.body?.cancel();
      const keys = authCacheKeys(h.redis);
      assertEquals(keys.length, 1, "exactly one auth entry in Redis");
      const ttlSeconds = (h.redis.get(keys[0])!.expiresAtMs - Date.now()) / 1000;
      assert(
        ttlSeconds <= 600 && ttlSeconds >= 500,
        `redis TTL ${ttlSeconds}s is within the 10-minute cap`,
      );
      const stored = JSON.parse(h.redis.get(keys[0])!.value) as {
        expiresAtMs: number;
        accessToken?: string;
      };
      assert(stored.expiresAtMs <= Date.now() + 600_000, "embedded expiry respects the cap");
    });
  },
);

Deno.test(
  "a shared-cache record whose embedded expiry has passed is NOT trusted even though Redis still returns it",
  async () => {
    const h = await loadSessionHarness({ redis: true });
    const minted = h.mintSession(GOOGLE_USER_ID, 3600);
    await withFrozenClock(async () => {
      const first = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
      assertEquals(first.status, 200);
      await first.body?.cancel();
    });
    assertEquals(h.callsTo("/auth/v1/user").length, 1);

    // Simulate a lagging instance / Redis clock: the key never expires server-side.
    for (const key of authCacheKeys(h.redis)) h.redis.get(key)!.expiresAtMs = Infinity;

    await withClockOffset(11 * 60_000, async () => {
      const later = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
      assertEquals(later.status, 200);
      await later.body?.cancel();
    });
    const gets = h.redisCommands.filter((command) => command[0] === "GET");
    assert(gets.length >= 1, "L1 had expired, so the function consulted Redis");
    assertEquals(
      h.callsTo("/auth/v1/user").length,
      2,
      "the stale shared record was refused and the session re-verified with GoTrue",
    );
  },
);

Deno.test(
  "a revoked session is not resurrected from the shared cache: logout DELs the key in Redis",
  async () => {
    const h = await loadSessionHarness({ redis: true });
    const minted = h.mintSession(GOOGLE_USER_ID, 3600);
    const warm = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
    assertEquals(warm.status, 200);
    await warm.body?.cancel();
    assertEquals(authCacheKeys(h.redis).length, 1);

    const logout = await h.handler(
      apiRequest("POST", "/v1/auth/logout", { token: minted.accessToken }),
    );
    assertEquals(logout.status, 204);
    assertEquals(
      authCacheKeys(h.redis).length,
      0,
      "the bearer's entry is gone from the shared cache",
    );
    assert(
      h.redisCommands.some((command) => command[0] === "DEL"),
      "a DEL reached Redis",
    );

    const after = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
    assertEquals(after.status, 401);
    assertStringIncludes(await errorMessage(after), "no longer valid");
  },
);

Deno.test(
  "refresh budgets are counted in the shared store so every instance sees the same window",
  async () => {
    const h = await loadSessionHarness({ redis: true });
    const ip = "203.0.113.77";
    let refreshToken = h.mintSession(GOOGLE_USER_ID).refreshToken;
    await withFrozenClock(async () => {
      for (let i = 0; i < 30; i += 1) {
        const response = await h.handler(
          apiRequest("POST", "/v1/auth/refresh", { token: null, ip, body: { refreshToken } }),
        );
        assertEquals(response.status, 200, `rotation ${i + 1}`);
        refreshToken = ((await response.json()) as { session: { refreshToken: string } }).session
          .refreshToken;
      }
      const throttled = await h.handler(
        apiRequest("POST", "/v1/auth/refresh", { token: null, ip, body: { refreshToken } }),
      );
      assertEquals(throttled.status, 429);
      await throttled.body?.cancel();
    });
    const counters = [...h.redis.values()].filter((entry) => Number(entry.value) === 31);
    assert(counters.length >= 1, "the per-IP refresh window lives in Redis and reached 31");
  },
);
