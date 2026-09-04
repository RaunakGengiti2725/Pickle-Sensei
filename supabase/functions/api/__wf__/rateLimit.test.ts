// Audit tests for rateLimit.ts (fixed-window counter, L2 Upstash + per-isolate
// memory fallback). See cache.test.ts header for the [defect] tag convention.
//
// Run: cd supabase/functions/api && deno test --allow-env --allow-read --allow-net __wf__/

import { assert, assertEquals, configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";

Deno.test(
  "with Upstash: the budget is shared across isolates (INCR + EXPIRE NX per hit)",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const a = await loadIsolate();
      const b = await loadIsolate();
      for (let i = 0; i < 3; i += 1)
        assertEquals((await a.rateLimit.enforceRateLimit("ip", "1.2.3.4", 5, 60)).allowed, true);
      assertEquals((await b.rateLimit.enforceRateLimit("ip", "1.2.3.4", 5, 60)).allowed, true);
      assertEquals((await b.rateLimit.enforceRateLimit("ip", "1.2.3.4", 5, 60)).allowed, true);
      const sixth = await b.rateLimit.enforceRateLimit("ip", "1.2.3.4", 5, 60);
      assertEquals(sixth.allowed, false);
      assertEquals(sixth.remaining, 0);
      assertEquals(sixth.limit, 5);

      const [key] = Object.keys(Object.fromEntries(redis.store));
      assert(key.startsWith("rl:ip:") && key.endsWith(":1.2.3.4"), key);
      const entry = redis.store.get(key)!;
      assert(entry.expiresAtMs !== null, "window key carries a TTL (no leak)");
      const expire = redis.commands.filter((c) => c[0] === "EXPIRE");
      assertEquals(expire.length, 6);
      assertEquals(expire[0].slice(2), [60, "NX"]);
      assertEquals(redis.commands.filter((c) => c[0] === "INCR").length, 6);
    } finally {
      redis.restore();
    }
  },
);

Deno.test("Retry-After is the remaining time in the current fixed window (never 0)", async () => {
  configureRedis(false);
  const redis = fakeUpstash();
  try {
    const iso = await loadIsolate();
    const windowSeconds = 60;
    const nowSec = Date.now() / 1_000;
    const expected = Math.ceil((Math.floor(nowSec / windowSeconds) + 1) * windowSeconds - nowSec);
    const r = await iso.rateLimit.enforceRateLimit("user", "u1", 1, windowSeconds);
    assert(r.retryAfterSeconds >= 1 && r.retryAfterSeconds <= windowSeconds);
    assert(Math.abs(r.retryAfterSeconds - expected) <= 1, `${r.retryAfterSeconds} vs ${expected}`);
    const denied = await iso.rateLimit.enforceRateLimit("user", "u1", 1, windowSeconds);
    assertEquals(denied.allowed, false);
    const res = iso.rateLimit.rateLimitResponse(denied);
    assertEquals(res.status, 429);
    assertEquals(res.headers.get("Retry-After"), String(denied.retryAfterSeconds));
    assertEquals(res.headers.get("RateLimit-Limit"), "1");
    assertEquals(res.headers.get("RateLimit-Remaining"), "0");
    const body = await res.json();
    assertEquals(body.error.code, "rate_limited");
  } finally {
    redis.restore();
  }
});

Deno.test(
  "Upstash HTTP failure → fail-open to the per-isolate memory counter (still enforced locally)",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    redis.failStatus = 503;
    try {
      const iso = await loadIsolate();
      for (let i = 0; i < 2; i += 1)
        assertEquals((await iso.rateLimit.enforceRateLimit("ip", "9.9.9.9", 2, 60)).allowed, true);
      assertEquals((await iso.rateLimit.enforceRateLimit("ip", "9.9.9.9", 2, 60)).allowed, false);
      assertEquals(redis.calls, 3, "Redis attempted on every call");
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "without Upstash: budgets are per isolate (documented degradation — N isolates = N× the budget)",
  async () => {
    configureRedis(false);
    const redis = fakeUpstash();
    try {
      const a = await loadIsolate();
      const b = await loadIsolate();
      for (let i = 0; i < 3; i += 1)
        assertEquals((await a.rateLimit.enforceRateLimit("ip", "1.1.1.1", 3, 60)).allowed, true);
      assertEquals((await a.rateLimit.enforceRateLimit("ip", "1.1.1.1", 3, 60)).allowed, false);
      for (let i = 0; i < 3; i += 1)
        assertEquals((await b.rateLimit.enforceRateLimit("ip", "1.1.1.1", 3, 60)).allowed, true);
      assertEquals(redis.calls, 0);
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "memory fallback: 20 000 distinct ids never release a limited client (locked windows are not evicted)",
  async () => {
    // rateLimit.ts memoryIncr(): when the map is full it evicts expired, then
    // least-recently-used UNLOCKED windows. A client presenting >= 20 000
    // distinct ids must not be able to reset in-flight lockouts on that isolate.
    configureRedis(false);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      for (let i = 0; i < 3; i += 1)
        await iso.rateLimit.enforceRateLimit("ip", "victim-limited-me", 3, 60);
      assertEquals(
        (await iso.rateLimit.enforceRateLimit("ip", "victim-limited-me", 3, 60)).allowed,
        false,
      );

      for (let i = 0; i < 20_000; i += 1) {
        await iso.rateLimit.enforceRateLimit("ip", `flood-${i}`, 300, 60);
      }
      const after = await iso.rateLimit.enforceRateLimit("ip", "victim-limited-me", 3, 60);
      assertEquals(after.allowed, false, "the limited client stayed limited");
      assertEquals(after.remaining, 0, "its counter was not reset");
    } finally {
      redis.restore();
    }
  },
);

Deno.test("memory fallback: a new fixed window replaces the expired one in place", async () => {
  configureRedis(false);
  const redis = fakeUpstash();
  try {
    const iso = await loadIsolate();
    // 1-second window: exhaust it, then wait for the next bucket.
    const first = await iso.rateLimit.enforceRateLimit("user", "u2", 1, 1);
    assertEquals(first.allowed, true);
    await new Promise((r) => setTimeout(r, first.retryAfterSeconds * 1_000 + 20));
    const next = await iso.rateLimit.enforceRateLimit("user", "u2", 1, 1);
    assertEquals(next.allowed, true, "fresh bucket, fresh count");
  } finally {
    redis.restore();
  }
});
