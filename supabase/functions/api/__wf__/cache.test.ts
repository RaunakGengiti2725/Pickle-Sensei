// Audit tests for cache.ts (L1 per-isolate + L2 Upstash).
//
// Tests tagged [defect] pin the CURRENT behaviour that the audit flagged, so
// they document the gap with a runnable reproduction; invert their assertions
// when the corresponding fix lands. Untagged tests pin behaviour that is
// correct today and must not regress.
//
// Run: cd supabase/functions/api && deno test --allow-env --allow-read --allow-net __wf__/

import { assert, assertEquals, configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";
import { captureConsole } from "./routesHarness.ts";

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

async function withPipelineResponses(
  run: (
    cache: Awaited<ReturnType<typeof loadIsolate>>["cache"],
    reply: (payload: unknown) => void,
  ) => Promise<void>,
): Promise<void> {
  configureRedis(true);
  const originalFetch = globalThis.fetch;
  let payload: unknown;
  globalThis.fetch = async () => Response.json(payload);
  try {
    const { cache } = await loadIsolate();
    await run(cache, (value) => {
      payload = value;
    });
  } finally {
    globalThis.fetch = originalFetch;
    configureRedis(false);
  }
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

Deno.test(
  "failure logs: Redis failures keep cache and rate-limit fallback without printing keys or credentials",
  async () => {
    const secret =
      "FAKE-redis-token FAKE-person@example.test https://FAKE-upstash.test/private?token=FAKE-token";
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    configureRedis(true);
    Date.now = () => 60_000;
    try {
      for (const response of [
        () => new Response(secret, { status: 503 }),
        () => Response.json([{ error: secret }]),
        () => new Response(`{${secret}`),
        () => {
          throw new TypeError(secret);
        },
      ]) {
        globalThis.fetch = async () => response();
        const { cache, rateLimit } = await loadIsolate();
        const { logs } = await captureConsole(async () => {
          assertEquals(await cache.cacheGet(secret), null);
          await cache.cacheSet(secret, secret, 60);
          assertEquals(await cache.cacheGet(secret), secret);
          await cache.cacheDel(secret);
          assertEquals(await cache.cacheGet(secret), null);
          assertEquals((await rateLimit.enforceRateLimit("user", secret, 2, 60)).remaining, 1);
          assertEquals((await rateLimit.enforceRateLimit("user", secret, 2, 60)).allowed, true);
          assertEquals((await rateLimit.peekRateLimit("user", secret, 2, 60)).allowed, false);
          const denied = await rateLimit.enforceRateLimit("user", secret, 2, 60);
          assertEquals(denied.allowed, false);
          const result = rateLimit.rateLimitResponse(denied);
          assertEquals(result.status, 429);
          assertEquals(result.headers.get("Retry-After"), "60");
          assertEquals((await result.json()).error.code, "rate_limited");
        });
        assertEquals(logs, []);
      }
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      configureRedis(false);
    }
  },
);

const invalidRedisCounts: unknown[] = [
  "",
  " ",
  false,
  true,
  [],
  [1],
  {},
  -1,
  "-1",
  1.5,
  "1.5",
  "1e3",
  "0x10",
  "NaN",
  "Infinity",
  Number.MAX_SAFE_INTEGER + 1,
  String(Number.MAX_SAFE_INTEGER + 1),
];

Deno.test(
  "Redis window helpers accept integer wire values, missing keys and EXPIRE NX zero",
  async () => {
    await withPipelineResponses(async (cache, reply) => {
      for (const count of [1, "2", Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
        for (const expiry of [0, 1, "0", "1"]) {
          reply([{ result: count }, { result: expiry }]);
          assertEquals(await cache.redisWindowIncr("rl:valid", 60), Number(count));
        }
      }
      for (const count of [null, 0, "0", 2, "2", Number.MAX_SAFE_INTEGER]) {
        reply([{ result: count }]);
        assertEquals(await cache.redisWindowGet("rl:valid"), count === null ? 0 : Number(count));
      }
    });
  },
);

Deno.test(
  "redisWindowIncr rejects null, zero and invalid counter values instead of coercing them",
  async () => {
    await withPipelineResponses(async (cache, reply) => {
      for (const count of [null, 0, "0", ...invalidRedisCounts]) {
        reply([{ result: count }, { result: 1 }]);
        assertEquals(await cache.redisWindowIncr("rl:invalid", 60), null, JSON.stringify(count));
      }
    });
  },
);

Deno.test(
  "redisWindowGet rejects invalid counter values instead of coercing them to a budget",
  async () => {
    await withPipelineResponses(async (cache, reply) => {
      for (const count of invalidRedisCounts) {
        reply([{ result: count }]);
        assertEquals(await cache.redisWindowGet("rl:invalid"), null, JSON.stringify(count));
      }
    });
  },
);

Deno.test(
  "redisWindowGet distinguishes a missing key from missing, malformed or error results",
  async () => {
    await withPipelineResponses(async (cache, reply) => {
      const invalidResponses = [
        null,
        {},
        "not a pipeline",
        [],
        [null],
        [0],
        [[]],
        [{}],
        [{ error: "ERR counter" }],
        [{ result: 1, error: "ERR counter" }],
        [{ result: null, error: "" }],
        [{ result: "1" }, { result: "extra" }],
      ];
      for (const response of invalidResponses) {
        reply(response);
        assertEquals(await cache.redisWindowGet("rl:invalid"), null, JSON.stringify(response));
      }
      reply([{ result: null }]);
      assertEquals(await cache.redisWindowGet("rl:missing"), 0);
    });
  },
);

Deno.test(
  "redisWindowIncr requires complete successful INCR and EXPIRE pipeline results",
  async () => {
    await withPipelineResponses(async (cache, reply) => {
      const invalidResponses = [
        [{ result: 1 }, { error: "ERR expiry" }],
        [{ result: 1 }],
        [],
        [null, { result: 1 }],
        [0, { result: 1 }],
        [{ result: 1 }, null],
        [{ result: 1 }, []],
        [{ result: 1 }, {}],
        [{ result: 1 }, { result: 1 }, { result: 1 }],
        [{ result: 1, error: "ERR counter" }, { result: 1 }],
        [{ result: 1, error: "" }, { result: 1 }],
        [{ error: "ERR counter" }, { result: 1 }],
        [{}, { result: 1 }],
      ];
      for (const response of invalidResponses) {
        reply(response);
        assertEquals(await cache.redisWindowIncr("rl:invalid", 60), null, JSON.stringify(response));
      }
      for (const expiry of [null, 2, ...invalidRedisCounts]) {
        reply([{ result: 1 }, { result: expiry }]);
        assertEquals(await cache.redisWindowIncr("rl:invalid", 60), null, JSON.stringify(expiry));
      }
    });
  },
);

Deno.test("redisWindowGet reads shared counters without warming or trusting L1", async () => {
  configureRedis(true);
  const redis = fakeUpstash();
  try {
    const { cache } = await loadIsolate();
    await cache.cacheSet("rl:shared", "1", 60);
    redis.store.set("rl:shared", { value: "2", expiresAtMs: Date.now() + 60_000 });
    assertEquals(await cache.redisWindowGet("rl:shared"), 2);
    assertEquals(await cache.cacheGet("rl:shared"), "1");
    redis.store.delete("rl:shared");
    assertEquals(await cache.redisWindowGet("rl:shared"), 0);
  } finally {
    redis.restore();
    configureRedis(false);
  }
});
