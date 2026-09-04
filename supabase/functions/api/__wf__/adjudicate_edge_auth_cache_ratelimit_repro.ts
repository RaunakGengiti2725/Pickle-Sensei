// Adjudicated reproductions for the edge-auth-cache-ratelimit cluster.
//
//   D — EACR-4: cacheDel() is isolate-local. The isolate that VERIFIED a
//       bearer keeps serving it from its own L1 after another isolate handled
//       the logout / account deletion. Fixed by capping every L1 entry at
//       L1_MAX_TTL_SECONDS (60 s): L2 stays authoritative for the full auth
//       TTL, so a DEL on ANY isolate is honoured everywhere within one L1
//       window. The assertion below pins that bound.
//   E — EACR-5: the memory rate limiter at MEMORY_WINDOW_MAX with no expired
//       windows used to `windows.clear()`, resetting every exhausted budget.
//       Fixed by evicting the least-used live window instead.
//
// Run one case:
//   cd supabase/functions/api/__wf__ && \
//     deno test -A --no-check --config deno.json adjudicate_edge_auth_cache_ratelimit_repro.ts --filter 'D'
//   … --filter 'E'
// (Test names are chosen so that 'D' / 'E' each match exactly one case.)

import { assert, assertEquals, configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";

/** cache.ts and the fake Upstash both read Date.now(); pin it so the L1
 * bound can be crossed deterministically instead of sleeping. */
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

// index.ts writeAuthCache(): AUTH_CACHE_MAX_TTL_SECONDS 600 − 30 s safety.
const AUTH_ENTRY_TTL_SECONDS = 570;
// cache.ts L1_MAX_TTL_SECONDS — the documented cross-isolate revocation bound.
const L1_BOUND_SECONDS = 60;

Deno.test(
  "D: a bearer revoked on isolate b is refused by isolate a within the l1 bound",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    const clock = withClock(1_800_000_000_000);
    try {
      const a = await loadIsolate();
      const b = await loadIsolate();
      const key = "auth:" + (await a.cache.sha256Hex("stolen-access-token"));
      const entry = JSON.stringify({
        userId: "u1",
        provider: "apple",
        accessToken: "stolen-access-token",
        expiresAtMs: Date.now() + 600_000,
      });

      // Isolate a ran getUser() and cached the verified bearer.
      await a.cache.cacheSet(key, entry, AUTH_ENTRY_TTL_SECONDS);
      assertEquals(await a.cache.cacheGet(key), entry);

      // POST /v1/auth/logout lands on isolate b: GoTrue session gone, cacheDel.
      await b.cache.cacheDel(key);
      assertEquals(redis.store.has(key), false, "L2 copy is gone");
      assertEquals(await b.cache.cacheGet(key), null, "b refuses the bearer at once");

      // Isolate a may serve its L1 copy for at most one L1 window …
      clock.advance(L1_BOUND_SECONDS * 1_000);
      assertEquals(
        await a.cache.cacheGet(key),
        null,
        `isolate a still serves the revoked bearer from its own L1 ${L1_BOUND_SECONDS} s after the logout`,
      );
      // … and the bound is what cache.ts exports, not a test-local number.
      assertEquals(a.cache.L1_MAX_TTL_SECONDS, L1_BOUND_SECONDS);
    } finally {
      clock.restore();
      redis.restore();
    }
  },
);

Deno.test(
  "E: at the memory-window cap a flood of new ids cannot reset an exhausted budget",
  async () => {
    configureRedis(false); // memory path = the only limiter without UPSTASH_*
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const limit = 30; // AUTH_FAILURE_LIMIT
      for (let i = 0; i < limit; i += 1) {
        assertEquals(
          (await iso.rateLimit.enforceRateLimit("authfail", "victim", limit, 300)).allowed,
          true,
        );
      }
      const exhausted = await iso.rateLimit.enforceRateLimit("authfail", "victim", limit, 300);
      assertEquals(exhausted.allowed, false);
      assertEquals(exhausted.remaining, 0);

      // 20 000 distinct live ip windows on this isolate (MEMORY_WINDOW_MAX).
      for (let i = 0; i < 20_000; i += 1) {
        await iso.rateLimit.enforceRateLimit("ip", `flood-${i}`, 300, 60);
      }

      const after = await iso.rateLimit.enforceRateLimit("authfail", "victim", limit, 300);
      assertEquals(
        after.allowed,
        false,
        `after 20 000 unrelated live windows the victim's count went 0/${limit} remaining → ${after.remaining}/${limit} remaining`,
      );
      assertEquals(after.remaining, 0);
      assert(redis.calls === 0, "no Redis traffic when unconfigured");
    } finally {
      redis.restore();
    }
  },
);
