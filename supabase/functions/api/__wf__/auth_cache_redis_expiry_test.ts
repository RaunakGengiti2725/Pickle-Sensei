// Shared-cache expiry boundary (AGENTS.md → "Scale & security"): a Redis
// record is trusted only while its embedded `expiresAtMs` is still ahead of
// the clock. auth_cache_redis_test.ts checks that at 11 minutes — a full
// minute past the 10-minute cap — which leaves any grace window shorter than
// that unpinned. This case sits right on the boundary: the record is still
// returned by Redis 10 seconds after its embedded expiry and must NOT be
// served.
//
// Killing test for the variant mutant
//   index.ts readAuthCache(): `cached.expiresAtMs > Date.now() + 5_000`
//                           → `cached.expiresAtMs > Date.now() - 60_000`
// which survives the adopted suites.
//
//   cd supabase/functions/api/__wf__ && deno task test

import { assert, assertEquals } from "@std/assert";
import {
  apiRequest,
  GOOGLE_USER_ID,
  loadSessionHarness,
  withClockOffset,
  withFrozenClock,
} from "./sessionHarness.ts";

function authCacheKeys(redis: Map<string, { value: string }>): string[] {
  return [...redis.entries()]
    .filter(([, entry]) => entry.value.includes('"userId"'))
    .map(([key]) => key);
}

Deno.test(
  "a shared-cache record is refused 10 seconds past its embedded expiry, not only a minute later",
  async () => {
    const h = await loadSessionHarness({ redis: true });
    const minted = h.mintSession(GOOGLE_USER_ID, 3600);
    let embeddedExpiresAtMs = 0;
    await withFrozenClock(async () => {
      const first = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
      assertEquals(first.status, 200);
      await first.body?.cancel();
      const keys = authCacheKeys(h.redis);
      assertEquals(keys.length, 1, "exactly one auth entry in Redis");
      const entry = h.redis.get(keys[0])!;
      embeddedExpiresAtMs = (JSON.parse(entry.value) as { expiresAtMs: number }).expiresAtMs;
      assert(embeddedExpiresAtMs > Date.now(), "the record carries a future embedded expiry");
      // Redis keeps returning the record past its embedded expiry (TTL drift,
      // clock skew between instances) — the reader must not trust it.
      entry.expiresAtMs = Infinity;
    });
    assertEquals(h.callsTo("/auth/v1/user").length, 1);

    const tenSecondsPast = embeddedExpiresAtMs + 10_000 - Date.now();
    await withClockOffset(tenSecondsPast, async () => {
      const later = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
      assertEquals(later.status, 200);
      await later.body?.cancel();
    });
    assertEquals(
      h.callsTo("/auth/v1/user").length,
      2,
      "the bearer was re-verified instead of being served from the expired record",
    );
  },
);
