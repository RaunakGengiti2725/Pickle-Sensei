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
      assertEquals((await b.rateLimit.peekRateLimit("ip", "1.2.3.4", 5, 60)).remaining, 2);
      assertEquals((await b.rateLimit.enforceRateLimit("ip", "1.2.3.4", 5, 60)).allowed, true);
      assertEquals((await b.rateLimit.enforceRateLimit("ip", "1.2.3.4", 5, 60)).allowed, true);
      assertEquals((await a.rateLimit.peekRateLimit("ip", "1.2.3.4", 5, 60)).allowed, false);
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
  "memory fallback: 20 000 live windows deny new identities without resetting existing budgets",
  async () => {
    // rateLimit.ts memoryIncr(): when the map is full and nothing has expired it
    // calls windows.clear(). Any client that can present >= 20 000 distinct
    // ids (spoofed X-Forwarded-For — clientIp() trusts the first hop) resets
    // all in-flight budgets on that isolate, including its own.
    configureRedis(false);
    const redis = fakeUpstash();
    const originalNow = Date.now;
    Date.now = () => 60_250;
    try {
      const iso = await loadIsolate();
      for (let i = 0; i < 3; i += 1)
        await iso.rateLimit.enforceRateLimit("ip", "victim-limited-me", 3, 60);
      assertEquals(
        (await iso.rateLimit.enforceRateLimit("ip", "victim-limited-me", 3, 60)).allowed,
        false,
      );
      assertEquals(
        (await iso.rateLimit.enforceRateLimit("ip", "active-budget", 3, 60)).remaining,
        2,
      );

      for (let i = 0; i < 19_998; i += 1) {
        assertEquals(
          (await iso.rateLimit.enforceRateLimit("ip", `flood-${i}`, 300, 60)).allowed,
          true,
        );
      }
      for (let i = 0; i < 20_000; i += 1) {
        const denied = await iso.rateLimit.enforceRateLimit("ip", `overflow-${i}`, 300, 60);
        assertEquals(denied, {
          allowed: false,
          limit: 300,
          remaining: 0,
          retryAfterSeconds: 60,
        });
      }
      const after = await iso.rateLimit.enforceRateLimit("ip", "victim-limited-me", 3, 60);
      assertEquals(after.allowed, false, "a flood cannot reopen a live exhausted window");
      assertEquals(after.remaining, 0);
      assertEquals(await iso.rateLimit.peekRateLimit("ip", "victim-limited-me", 3, 60), after);
      const untracked = await iso.rateLimit.peekRateLimit("ip", "untracked", 300, 60);
      assertEquals(untracked.allowed, false);
      assertEquals(untracked.remaining, 0);
      assertEquals((await iso.rateLimit.peekRateLimit("ip", "active-budget", 3, 60)).remaining, 2);
      for (let remaining = 1; remaining >= 0; remaining -= 1) {
        const active = await iso.rateLimit.enforceRateLimit("ip", "active-budget", 3, 60);
        assertEquals(active.allowed, true);
        assertEquals(active.remaining, remaining);
      }
      assertEquals(
        (await iso.rateLimit.peekRateLimit("ip", "active-budget", 3, 60)).allowed,
        false,
      );
      assertEquals(
        (await iso.rateLimit.enforceRateLimit("ip", "active-budget", 3, 60)).allowed,
        false,
      );
      assertEquals(redis.calls, 0);
    } finally {
      Date.now = originalNow;
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

Deno.test(
  "memory fallback: capacity recovers at aligned expiry and retains longer live windows",
  async () => {
    configureRedis(false);
    const redis = fakeUpstash();
    const originalNow = Date.now;
    let now = 60_250;
    Date.now = () => now;
    try {
      const iso = await loadIsolate();
      await iso.rateLimit.enforceRateLimit("authfail", "long-lived", 1, 300);
      for (let i = 0; i < 19_999; i += 1) {
        assertEquals(
          (await iso.rateLimit.enforceRateLimit("ip", `short-${i}`, 1, 60)).allowed,
          true,
        );
      }

      now = 119_999;
      const full = await iso.rateLimit.peekRateLimit("ip", "newcomer", 1, 60);
      assertEquals(full, { allowed: false, limit: 1, remaining: 0, retryAfterSeconds: 1 });
      assertEquals(await iso.rateLimit.enforceRateLimit("ip", "newcomer", 1, 60), full);
      assertEquals(await iso.rateLimit.peekRateLimit("ip", "short-0", 1, 60), full);

      now = 120_000;
      for (let i = 0; i < 50; i += 1) {
        assertEquals(await iso.rateLimit.peekRateLimit("ip", "newcomer", 1, 60), {
          allowed: true,
          limit: 1,
          remaining: 1,
          retryAfterSeconds: 60,
        });
      }
      assertEquals(
        (await iso.rateLimit.peekRateLimit("authfail", "long-lived", 1, 300)).allowed,
        false,
      );
      assertEquals(
        (await iso.rateLimit.enforceRateLimit("authfail", "long-lived", 1, 300)).allowed,
        false,
      );
      for (let i = 0; i < 19_999; i += 1) {
        const fresh = await iso.rateLimit.enforceRateLimit("ip", `short-${i}`, 1, 60);
        assertEquals(fresh.allowed, true);
        assertEquals(fresh.remaining, 0);
      }
      assertEquals((await iso.rateLimit.peekRateLimit("ip", "newcomer", 1, 60)).allowed, false);
      assertEquals((await iso.rateLimit.enforceRateLimit("ip", "newcomer", 1, 60)).allowed, false);

      now = 300_000;
      const recovered = await iso.rateLimit.peekRateLimit("authfail", "long-lived", 1, 300);
      assertEquals(recovered, { allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 300 });
      assertEquals(
        (await iso.rateLimit.enforceRateLimit("authfail", "long-lived", 1, 300)).allowed,
        true,
      );
    } finally {
      Date.now = originalNow;
      redis.restore();
    }
  },
);

Deno.test(
  "memory fallback: repeated capacity denials do not rescan every live window",
  async () => {
    configureRedis(false);
    const redis = fakeUpstash();
    const originalNow = Date.now;
    const originalIterator = Map.prototype[Symbol.iterator];
    let now = 60_250;
    let visitedEntries = 0;
    Date.now = () => now;
    try {
      const iso = await loadIsolate();
      for (let i = 0; i < 20_000; i += 1) {
        await iso.rateLimit.enforceRateLimit("ip", `live-${i}`, 1, 60);
      }
      Map.prototype[Symbol.iterator] = function* () {
        for (const entry of originalIterator.call(this)) {
          visitedEntries += 1;
          yield entry;
        }
        return undefined;
      };
      for (let i = 0; i < 1_000; i += 1) {
        now += 1;
        assertEquals(
          (await iso.rateLimit.enforceRateLimit("ip", `denied-${i}`, 1, 60)).allowed,
          false,
        );
        assertEquals((await iso.rateLimit.peekRateLimit("ip", `peek-${i}`, 1, 60)).allowed, false);
      }
      assert(
        visitedEntries <= 20_000,
        `capacity checks revisited ${visitedEntries} entries without any window expiring`,
      );
    } finally {
      Map.prototype[Symbol.iterator] = originalIterator;
      Date.now = originalNow;
      redis.restore();
    }
  },
);

Deno.test(
  "invalid Redis pipelines reuse the existing local budget for increments and peeks",
  async () => {
    configureRedis(true);
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let now = 60_250;
    let httpFailure = true;
    let payload: unknown;
    Date.now = () => now;
    globalThis.fetch = async () =>
      httpFailure ? new Response("unavailable", { status: 503 }) : Response.json(payload);
    try {
      const iso = await loadIsolate();
      const invalidResponses = [
        { increment: [{ result: null }, { result: 1 }], get: [] },
        { increment: [{ result: "" }, { result: 1 }], get: [{}] },
        { increment: [{ result: false }, { result: 1 }], get: [{ error: "ERR counter" }] },
        {
          increment: [{ result: 1 }, { error: "ERR expiry" }],
          get: [{ result: null, error: "ERR counter" }],
        },
        { increment: [{ result: 1 }], get: [null] },
        { increment: [{ result: 0 }, { result: 1 }], get: [{ result: " " }] },
        { increment: [{ result: 1 }, { result: null }], get: [{ result: false }] },
      ];
      for (const [index, invalid] of invalidResponses.entries()) {
        const id = `fallback-${index}`;
        httpFailure = true;
        assertEquals((await iso.rateLimit.enforceRateLimit("ip", id, 2, 60)).remaining, 1);
        httpFailure = false;
        payload = invalid.get;
        assertEquals((await iso.rateLimit.peekRateLimit("ip", id, 2, 60)).remaining, 1);
        payload = invalid.increment;
        const lastAllowed = await iso.rateLimit.enforceRateLimit("ip", id, 2, 60);
        assertEquals(lastAllowed.allowed, true);
        assertEquals(lastAllowed.remaining, 0);
        payload = invalid.get;
        const closed = await iso.rateLimit.peekRateLimit("ip", id, 2, 60);
        assertEquals(closed.allowed, false);
        assertEquals(closed.remaining, 0);
        payload = invalid.increment;
        assertEquals((await iso.rateLimit.enforceRateLimit("ip", id, 2, 60)).allowed, false);
        httpFailure = true;
        assertEquals((await iso.rateLimit.peekRateLimit("ip", id, 2, 60)).allowed, false);
      }
      now = 120_000;
      assertEquals((await iso.rateLimit.peekRateLimit("ip", "fallback-0", 2, 60)).remaining, 2);
      assertEquals((await iso.rateLimit.enforceRateLimit("ip", "fallback-0", 2, 60)).remaining, 1);
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      configureRedis(false);
    }
  },
);
