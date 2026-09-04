// Audit tests for cache.ts (L1 per-isolate + L2 Upstash).
//
// Tests tagged [defect] pin the CURRENT behaviour that the audit flagged, so
// they document the gap with a runnable reproduction; invert their assertions
// when the corresponding fix lands. Untagged tests pin behaviour that is
// correct today and must not regress.
//
// Run: cd supabase/functions/api && deno test --allow-env --allow-read --allow-net __wf__/

import { assert, assertEquals, configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";

/** The auth-failure counter exactly as index.ts (router, lines ~2152-2175)
 * maintains it: non-atomic GET → +1 → SET through the layered cache. */
async function recordAuthFailure(
  cache: Awaited<ReturnType<typeof loadIsolate>>["cache"],
  ip: string,
): Promise<number> {
  const failKey = `authfail:${ip}`;
  const failedRecently = Number((await cache.cacheGet(failKey)) ?? "0");
  await cache.cacheSet(failKey, String(failedRecently + 1), 300);
  return failedRecently;
}

Deno.test(
  "cacheSet writes L1 and L2; cacheGet on a cold isolate reads L2 and warms L1",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const a = await loadIsolate();
      const b = await loadIsolate();
      await a.cache.cacheSet("rank:u1", '{"rank":null}', 60);
      assertEquals(redis.store.get("rank:u1")?.value, '{"rank":null}');

      const before = redis.calls;
      assertEquals(await b.cache.cacheGet("rank:u1"), '{"rank":null}');
      assertEquals(redis.calls, before + 1, "cold isolate pays one pipeline round trip");
      assertEquals(await b.cache.cacheGet("rank:u1"), '{"rank":null}');
      assertEquals(redis.calls, before + 1, "second read is served from L1");
    } finally {
      redis.restore();
    }
  },
);

Deno.test("cacheGet does NOT warm L1 from a Redis value without a TTL", async () => {
  configureRedis(true);
  const redis = fakeUpstash();
  try {
    redis.store.set("noexp", { value: "v", expiresAtMs: null });
    const a = await loadIsolate();
    assertEquals(await a.cache.cacheGet("noexp"), "v");
    redis.store.delete("noexp");
    assertEquals(await a.cache.cacheGet("noexp"), null, "no L1 copy was created");
  } finally {
    redis.restore();
  }
});

Deno.test(
  "cacheDel bumps the key's invalidation generation; cacheSetIfCurrent with the pre-delete generation writes nothing (L1 or L2)",
  async () => {
    // A rank/progress build captures the generation BEFORE its DB read and
    // writes through cacheSetIfCurrent, so an accepted shot sync (cacheDel)
    // that lands mid-build wins over the build's pre-sync payload.
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const before = iso.cache.cacheGeneration("rank:u1");
      assertEquals(
        iso.cache.cacheGeneration("rank:u1"),
        before,
        "reading the generation does not change it",
      );

      await iso.cache.cacheDel("rank:u1"); // the sync lands while the build is reading
      assert(iso.cache.cacheGeneration("rank:u1") !== before, "cacheDel bumps the generation");

      assertEquals(await iso.cache.cacheSetIfCurrent("rank:u1", "stale", 60, before), false);
      assertEquals(await iso.cache.cacheGet("rank:u1"), null, "no L1 copy of the stale payload");
      assertEquals(redis.store.has("rank:u1"), false, "no L2 copy of the stale payload");

      const current = iso.cache.cacheGeneration("rank:u1");
      assertEquals(await iso.cache.cacheSetIfCurrent("rank:u1", "fresh", 60, current), true);
      assertEquals(await iso.cache.cacheGet("rank:u1"), "fresh");
      assertEquals(redis.store.get("rank:u1")?.value, "fresh");
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "cacheSetIfCurrent on a key that was never invalidated behaves exactly like cacheSet; each key has its own generation",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const rankGen = iso.cache.cacheGeneration("rank:u2");
      const progressGen = iso.cache.cacheGeneration("progress:u2");
      await iso.cache.cacheSet("rank:u2", "a", 60);
      assertEquals(await iso.cache.cacheGet("rank:u2"), "a");
      assertEquals(
        iso.cache.cacheGeneration("rank:u2"),
        rankGen,
        "cacheSet/cacheGet never move the generation",
      );

      await iso.cache.cacheDel("progress:u2"); // a different key
      assertEquals(iso.cache.cacheGeneration("rank:u2"), rankGen, "other keys are unaffected");
      assert(iso.cache.cacheGeneration("progress:u2") !== progressGen);

      assertEquals(await iso.cache.cacheSetIfCurrent("rank:u2", "b", 60, rankGen), true);
      assertEquals(await iso.cache.cacheGet("rank:u2"), "b");
      assertEquals(redis.store.get("rank:u2")?.value, "b");
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "[defect] cross-isolate cacheDel leaves the OTHER isolate's L1 copy alive for the full TTL",
  async () => {
    // index.ts busts rank:/progress: keys on every accepted shot sync and on
    // account deletion (cacheDel), but cacheDel only reaches the caller's own L1
    // map + Redis. Any other isolate that served the user in the last 60 s keeps
    // returning the pre-write payload from its L1 until that entry ages out.
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const a = await loadIsolate();
      const b = await loadIsolate();
      await a.cache.cacheSet("rank:u1", "stale", 60);
      assertEquals(await b.cache.cacheGet("rank:u1"), "stale"); // b now holds an L1 copy

      await a.cache.cacheDel("rank:u1"); // shot sync handled by isolate a
      assertEquals(redis.store.has("rank:u1"), false, "L2 copy is gone");
      assertEquals(await a.cache.cacheGet("rank:u1"), null, "a's L1 copy is gone");
      assertEquals(
        await b.cache.cacheGet("rank:u1"),
        "stale",
        "b still serves the pre-write payload",
      );
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "[defect] auth-failure counter: concurrent failures in one isolate collapse to a single increment",
  async () => {
    // Attackers do not fail serially. 40 concurrent bad-token requests all read
    // "0" before any of them writes, and the counter ends at 1 instead of 40.
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      await Promise.all(Array.from({ length: 40 }, () => recordAuthFailure(iso.cache, "10.0.0.1")));
      assertEquals(redis.store.get("authfail:10.0.0.1")?.value, "1");
      assertEquals(await iso.cache.cacheGet("authfail:10.0.0.1"), "1");
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "[defect] auth-failure counter: each isolate counts from its own L1 copy, so the shared budget is never reached",
  async () => {
    // AUTH_FAILURE_LIMIT is 30 per 5 minutes per IP. Two isolates each seeing 29
    // failures (58 total, serial, no concurrency at all) never trip the budget:
    // cacheGet answers from the isolate-local L1 copy that cacheSet wrote, so
    // the Redis value is only consulted once per isolate. Production fans a
    // single client's requests over 100+ isolates (observed: 200 sequential
    // healthz calls → 148 distinct x-deno-execution-id values).
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const a = await loadIsolate();
      const b = await loadIsolate();
      let maxSeen = 0;
      for (let i = 0; i < 29; i += 1) {
        maxSeen = Math.max(maxSeen, await recordAuthFailure(a.cache, "10.0.0.2"));
        maxSeen = Math.max(maxSeen, await recordAuthFailure(b.cache, "10.0.0.2"));
      }
      assert(
        maxSeen < 30,
        `no request saw the budget tripped (max read ${maxSeen}) after 58 failures`,
      );
      const redisValue = Number(redis.store.get("authfail:10.0.0.2")?.value);
      assert(redisValue < 58, `Redis undercounts: ${redisValue} of 58 failures`);
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "Redis HTTP failure: cacheGet is null, cacheSet still warms L1, nothing throws",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    redis.failStatus = 500;
    try {
      const iso = await loadIsolate();
      assertEquals(await iso.cache.cacheGet("k"), null);
      await iso.cache.cacheSet("k", "v", 30);
      assertEquals(await iso.cache.cacheGet("k"), "v", "served from L1 while Redis is down");
      await iso.cache.cacheDel("k");
      assertEquals(await iso.cache.cacheGet("k"), null);
      assertEquals(await iso.cache.redisWindowIncr("rl:x", 60), null, "limiter sees 'unavailable'");
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "[defect] no circuit breaker: every L2 call after a timeout still waits the full 1.2 s",
  async () => {
    // REDIS_TIMEOUT_MS = 1_200 and redisPipeline has no failure memory, so a
    // Redis outage costs every request ~1.2 s PER cache/limit call. One
    // authenticated request performs up to four sequential L2 calls before any
    // DB work (ip limit, authfail read, auth-cache read, user limit).
    configureRedis(true);
    const redis = fakeUpstash();
    redis.hang = true;
    try {
      const iso = await loadIsolate();
      const t0 = performance.now();
      assertEquals(await iso.cache.cacheGet("miss-1"), null);
      const t1 = performance.now();
      assertEquals(await iso.cache.cacheGet("miss-2"), null);
      const t2 = performance.now();
      assert(t1 - t0 >= 1_100, `first call waited ${(t1 - t0).toFixed(0)} ms`);
      assert(t2 - t1 >= 1_100, `second call STILL waited ${(t2 - t1).toFixed(0)} ms`);
      assertEquals(redis.calls, 2, "Redis was attempted again right after timing out");
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "L1 is capped at 5 000 entries; overflow drops the oldest third (no unbounded growth)",
  async () => {
    configureRedis(false);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      for (let i = 0; i < 5_000; i += 1) await iso.cache.cacheSet(`k${i}`, "v", 600);
      assertEquals(await iso.cache.cacheGet("k0"), "v");
      await iso.cache.cacheSet("overflow", "v", 600);
      assertEquals(await iso.cache.cacheGet("k0"), null, "oldest entries evicted");
      assertEquals(await iso.cache.cacheGet("k1666"), null, "…the oldest third");
      assertEquals(await iso.cache.cacheGet("k1667"), "v", "…but nothing newer");
      assertEquals(await iso.cache.cacheGet("overflow"), "v");
      assertEquals(redis.calls, 0, "no Redis traffic when unconfigured");
    } finally {
      redis.restore();
    }
  },
);

Deno.test("expired L1 entries are dropped lazily on read", async () => {
  configureRedis(false);
  const redis = fakeUpstash();
  try {
    const iso = await loadIsolate();
    await iso.cache.cacheSet("short", "v", 0.05);
    assertEquals(await iso.cache.cacheGet("short"), "v");
    await new Promise((r) => setTimeout(r, 80));
    assertEquals(await iso.cache.cacheGet("short"), null);
    await iso.cache.cacheSet("zero", "v", 0);
    assertEquals(await iso.cache.cacheGet("zero"), null, "ttl<=0 is never stored");
  } finally {
    redis.restore();
  }
});
