// Adversarial follow-up to the logout fence (fix candidate 15a7b9e5, cluster
// xc-matrix::XC-ADJ-AUTH-3) with Upstash configured — the deployment shape
// the fix's own S3b matrix does not exercise (xc_concurrency_harness.ts
// deletes the UPSTASH_* secrets, so S3b runs single-isolate, memory only).
//
// cache.ts documents the fence as revoking "on both tiers" and index.ts
// relies on it so that a bearer revoked by /v1/auth/logout "stops working at
// this edge immediately". `cacheGetFenced`, however, consults the Redis fence
// only after an L1 miss (cache.ts:157-158): an isolate that verified the
// bearer itself holds an L1 copy for the entry's FULL TTL (`cacheSetFenced`
// → `memorySet(key, value, ttlSeconds)`, up to 570 s) and keeps serving it
// after another isolate fenced the key. Supabase fans one client over many
// isolates (see cache.test.ts: 148 distinct execution ids in 200 calls), so
// the device that logs out is routinely served by an isolate other than the
// one that verified its bearer a moment earlier.
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json cache_fence_cross_isolate.test.ts

import { assert, assertEquals, configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";

const KEY = "auth:0123456789abcdef";
const SESSION = '{"id":"u1","expiresAtMs":1}';
/** index.ts caches a verified bearer for its remaining life − 30 s (≤ 570 s). */
const ENTRY_TTL_S = 570;
/** index.ts fences a revoked bearer for AUTH_CACHE_MAX_TTL_SECONDS. */
const FENCE_TTL_S = 600;

Deno.test(
  "a bearer fenced (logged out) on isolate B is a miss on every isolate — including isolate A, which verified and L1-cached it",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const a = await loadIsolate();
      const b = await loadIsolate();
      const c = await loadIsolate();

      // Isolate A served the first request: GoTrue verified the bearer and
      // the session was cached (L1 for the full TTL + Redis).
      assertEquals(await a.cache.cacheSetFenced(KEY, SESSION, ENTRY_TTL_S), true);
      assertEquals(redis.store.get(KEY)?.value, SESSION);

      // /v1/auth/logout with that bearer lands on isolate B.
      await b.cache.cacheFence(KEY, FENCE_TTL_S);
      assertEquals(redis.store.has(KEY), false, "Redis copy evicted");
      assertEquals(redis.store.get(`${KEY}#fence`)?.value, "1", "Redis fence raised");

      const onB = await b.cache.cacheGetFenced(KEY);
      const onC = await c.cache.cacheGetFenced(KEY);
      const onA = await a.cache.cacheGetFenced(KEY);
      console.log(
        `[adjudicate] post-logout cacheGetFenced: B(fenced)=${JSON.stringify(onB)} C(cold)=${JSON.stringify(
          onC,
        )} A(verifier)=${JSON.stringify(onA)}`,
      );
      assertEquals(onB, null, "the isolate that handled logout misses");
      assertEquals(onC, null, "a cold isolate sees the Redis fence and misses");
      assertEquals(
        onA,
        null,
        "the isolate that verified the bearer must miss too: the revoked session keeps authenticating there for the L1 TTL otherwise",
      );
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "a late cacheSetFenced on isolate A after isolate B fenced the key stores nothing on either tier",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const a = await loadIsolate();
      const b = await loadIsolate();
      await b.cache.cacheFence(KEY, FENCE_TTL_S);
      assertEquals(await a.cache.cacheSetFenced(KEY, SESSION, ENTRY_TTL_S), false);
      assert(!redis.store.has(KEY), "Redis copy not resurrected");
      assertEquals(await a.cache.cacheGetFenced(KEY), null, "no L1 copy left behind on A");
    } finally {
      redis.restore();
    }
  },
);
