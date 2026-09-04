// Audit tests for cache.ts (L1 per-isolate + L2 Upstash).
//
// Tests tagged [defect] pin the CURRENT behaviour that the audit flagged, so
// they document the gap with a runnable reproduction; invert their assertions
// when the corresponding fix lands. Untagged tests pin behaviour that is
// correct today and must not regress.
//
// Run: cd supabase/functions/api && deno test --allow-env --allow-read --allow-net __wf__/

import { assert, assertEquals, configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";

/** cache.ts and the fake Upstash both read Date.now(); pin it so TTL bounds
 * can be crossed deterministically instead of sleeping. */
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

/** The documented cross-isolate revocation bound (cache.ts L1_MAX_TTL_SECONDS). */
const L1_BOUND_SECONDS = 60;

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
  "cross-isolate cacheDel: the OTHER isolate's L1 copy outlives the DEL by at most one L1 window",
  async () => {
    // index.ts busts rank:/progress: keys on every accepted shot sync and on
    // account deletion (cacheDel), but cacheDel only reaches the caller's own L1
    // map + Redis. Any other isolate that served the user keeps returning the
    // pre-write payload from its L1 until that entry ages out — which is
    // bounded by L1_MAX_TTL_SECONDS, never by the entry's own TTL.
    configureRedis(true);
    const redis = fakeUpstash();
    const clock = withClock(1_800_000_000_000);
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
        "b still serves the pre-write payload inside the L1 window",
      );
      clock.advance(L1_BOUND_SECONDS * 1_000);
      assertEquals(await b.cache.cacheGet("rank:u1"), null, "b's L1 copy aged out; L2 is gone");
    } finally {
      clock.restore();
      redis.restore();
    }
  },
);

Deno.test(
  "auth entry revoked on another isolate: set in A, del in B, get in A → null within L1_MAX_TTL_SECONDS (L2 keeps the full TTL)",
  async () => {
    // writeAuthCache() stores the verified bearer for 570 s (600 − 30 s). The
    // isolate that verified it must not honour that TTL locally once ANY
    // isolate has revoked the entry: L1 is a ≤ 60 s shadow of L2.
    configureRedis(true);
    const redis = fakeUpstash();
    const clock = withClock(1_800_000_000_000);
    try {
      const a = await loadIsolate();
      const b = await loadIsolate();
      const key = `auth:${await a.cache.sha256Hex("access-token")}`;
      await a.cache.cacheSet(key, "verified", 570);
      assertEquals(a.cache.L1_MAX_TTL_SECONDS, L1_BOUND_SECONDS);

      const l2 = redis.store.get(key);
      assert(l2 && l2.expiresAtMs !== null, "L2 entry carries a TTL");
      assertEquals(
        Math.round((l2.expiresAtMs - Date.now()) / 1_000),
        570,
        "L2 keeps the FULL auth TTL — the cap is L1-only",
      );

      // Still valid on every isolate while nobody revoked it.
      clock.advance(L1_BOUND_SECONDS * 1_000);
      assertEquals(await a.cache.cacheGet(key), "verified", "re-read from L2 after the L1 window");
      assertEquals(await b.cache.cacheGet(key), "verified");

      await b.cache.cacheDel(key); // logout / account deletion handled by isolate b
      assertEquals(redis.store.has(key), false);
      assertEquals(await b.cache.cacheGet(key), null, "b refuses at once");

      // Inside the window a may still hold its L1 shadow; that is the bound.
      clock.advance(L1_BOUND_SECONDS * 1_000);
      assertEquals(await a.cache.cacheGet(key), null, "a refuses within one L1 window");
      clock.advance(300_000);
      assertEquals(await a.cache.cacheGet(key), null, "…and never resurrects it");
    } finally {
      clock.restore();
      redis.restore();
    }
  },
);

Deno.test(
  "without Redis L1 IS the store: entries keep the caller's full TTL (the cap only applies when L2 exists)",
  async () => {
    configureRedis(false);
    const redis = fakeUpstash();
    const clock = withClock(1_800_000_000_000);
    try {
      const iso = await loadIsolate();
      await iso.cache.cacheSet("authfail:203.0.113.7", "30", 300);
      await iso.cache.cacheSet(`auth:${await iso.cache.sha256Hex("t")}`, "verified", 570);
      clock.advance((L1_BOUND_SECONDS + 1) * 1_000);
      assertEquals(
        await iso.cache.cacheGet("authfail:203.0.113.7"),
        "30",
        "authfail window intact",
      );
      clock.advance(238_000); // t = 299 s
      assertEquals(await iso.cache.cacheGet("authfail:203.0.113.7"), "30");
      assertEquals(await iso.cache.cacheGet(`auth:${await iso.cache.sha256Hex("t")}`), "verified");
      clock.advance(1_000); // t = 300 s
      assertEquals(
        await iso.cache.cacheGet("authfail:203.0.113.7"),
        null,
        "expires at its own TTL",
      );
      assertEquals(redis.calls, 0, "no Redis traffic when unconfigured");
    } finally {
      clock.restore();
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
