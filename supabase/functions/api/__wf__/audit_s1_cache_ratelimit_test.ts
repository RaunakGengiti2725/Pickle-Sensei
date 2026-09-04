// STRUCTURAL AUDIT #1 (edge-auth-cache-ratelimit) — module-level probes for
// cache.ts (L1/L2 lifecycle) and rateLimit.ts (window state) using the
// multi-isolate harness (each loadIsolate() = a separate edge isolate sharing
// one fake Upstash).
//
// Tests named `[defect]` assert the INVARIANT the code comments / AGENTS.md
// promise and FAIL on 4d812e1a; untagged tests pass and pin verified
// behaviour.
//
// Run: (cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json audit_s1_cache_ratelimit_test.ts)

import {
  assert,
  assertEquals,
  configureRedis,
  fakeUpstash,
  loadIsolate,
} from "./harness.ts";

// ─── Auth-session cache: logout / deletion invalidation across isolates ──────

Deno.test(
  "[defect] logout on isolate A leaves isolate B serving the revoked bearer from B's own L1 for the full auth TTL (≤570 s)",
  async () => {
    // index.ts writeAuthCache(): the isolate that VERIFIED the bearer stores
    // it in its own L1 with the full ttl (up to 600-30 s). logoutRoute()
    // → cacheDel() reaches the caller's L1 + Redis only.
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const a = await loadIsolate();
      const b = await loadIsolate();
      const key = "auth:sha256-of-bearer";
      // B verified the bearer 1 s ago (authenticate() on isolate B).
      await b.cache.cacheSet(key, '{"userId":"u1","provider":"google"}', 570);
      // The device signs out; the request lands on isolate A.
      await a.cache.cacheDel(key);
      assertEquals(redis.store.has(key), false, "Redis copy is gone");
      assertEquals(await a.cache.cacheGet(key), null, "A's L1 copy is gone");

      const stillServed = await b.cache.cacheGet(key);
      assertEquals(
        stillServed,
        null,
        "B must not keep authenticating a bearer whose session was revoked",
      );
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "Redis-warmed L1 copies are capped at 60 s, so a cold isolate's stale window after cacheDel is bounded",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const a = await loadIsolate();
      const b = await loadIsolate();
      await a.cache.cacheSet("auth:x", "v", 570);
      assertEquals(await b.cache.cacheGet("auth:x"), "v");
      await a.cache.cacheDel("auth:x");
      assertEquals(
        await b.cache.cacheGet("auth:x"),
        "v",
        "b keeps its warm copy for now",
      );
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 61_000;
        assertEquals(
          await b.cache.cacheGet("auth:x"),
          null,
          "warm copy expired within 60 s",
        );
      } finally {
        Date.now = realNow;
      }
    } finally {
      redis.restore();
    }
  },
);

// ─── Redis pipeline: per-command error entries ───────────────────────────────

Deno.test(
  "pipeline error entry on INCR (e.g. WRONGTYPE) degrades to the per-isolate memory window, never throws",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const original = globalThis.fetch;
      // Real Redis answers a poisoned key with a per-command error entry;
      // emulate that on the wire for every INCR.
      globalThis.fetch =
        (async (input: string | URL | Request, init?: RequestInit) => {
          const res = await original(input, init);
          const parsed = (await res.json()) as Array<
            { result?: unknown; error?: string }
          >;
          const cmds = JSON.parse(String(init?.body ?? "[]")) as Array<
            Array<string | number>
          >;
          cmds.forEach((cmd, i) => {
            if (String(cmd[0]).toUpperCase() === "INCR") {
              parsed[i] = {
                error:
                  "WRONGTYPE Operation against a key holding the wrong kind of value",
              };
            }
          });
          return new Response(JSON.stringify(parsed), { status: 200 });
        }) as typeof fetch;
      try {
        assertEquals(
          await iso.cache.redisWindowIncr("rl:ip:1:9.9.9.9", 60),
          null,
        );
        const rl = await iso.rateLimit.enforceRateLimit(
          "ip",
          "9.9.9.9",
          1200,
          60,
        );
        assertEquals(rl.allowed, true);
        assertEquals(rl.remaining, 1199, "memory window took over at count 1");
      } finally {
        globalThis.fetch = original;
      }
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "pipeline response that is not an array (Upstash error object) → null → memory fallback",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const original = globalThis.fetch;
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )) as typeof fetch;
      try {
        assertEquals(await iso.cache.cacheGet("k"), null);
        assertEquals(await iso.cache.redisWindowIncr("rl:x", 60), null);
        assertEquals(await iso.cache.redisWindowGet("rl:x"), null);
        const rl = await iso.rateLimit.peekRateLimit(
          "authfail",
          "1.1.1.1",
          30,
          300,
        );
        assertEquals(rl.allowed, true);
      } finally {
        globalThis.fetch = original;
      }
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "[defect] EXPIRE error entry is ignored: an INCR'd window key with no TTL is accepted as a valid count and never expires in Redis",
  async () => {
    // redisWindowIncr() reads results[0] only; results[1] (EXPIRE … NX) may
    // carry `{error}` (unsupported flag, ACL) or `{result:0}`. The count is
    // still trusted although the key now lives forever → unbounded key
    // growth (one key per scope×id×bucket) with no expiry to reclaim it.
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const original = globalThis.fetch;
      globalThis.fetch =
        (async (input: string | URL | Request, init?: RequestInit) => {
          const res = await original(input, init);
          const parsed = (await res.json()) as Array<
            { result?: unknown; error?: string }
          >;
          const cmds = JSON.parse(String(init?.body ?? "[]")) as Array<
            Array<string | number>
          >;
          cmds.forEach((cmd, i) => {
            if (String(cmd[0]).toUpperCase() === "EXPIRE") {
              parsed[i] = { error: "ERR syntax error" };
              // and the fake store reflects that EXPIRE did not apply:
              const entry = redis.store.get(String(cmd[1]));
              if (entry) entry.expiresAtMs = null;
            }
          });
          return new Response(JSON.stringify(parsed), { status: 200 });
        }) as typeof fetch;
      try {
        const count = await iso.cache.redisWindowIncr("rl:user:123:u1", 60);
        const entry = redis.store.get("rl:user:123:u1");
        assert(entry, "key exists in Redis");
        // A count whose window could not be armed must not be trusted as a
        // bounded window; the safe outcome is null (memory fallback) or a
        // key that still carries an expiry.
        assert(
          count === null || entry.expiresAtMs !== null,
          `count=${count} accepted while the Redis key has no expiry`,
        );
      } finally {
        globalThis.fetch = original;
      }
    } finally {
      redis.restore();
    }
  },
);

// ─── Memory limiter: window map lifecycle ────────────────────────────────────

Deno.test(
  "[defect] 20 000 live keys: the next new key wipes EVERY live window, resetting a client that had exhausted its budget",
  async () => {
    configureRedis(false);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      // A client exhausts a 5/hour budget (e.g. delete_confirm).
      for (let i = 0; i < 5; i += 1) {
        await iso.rateLimit.enforceRateLimit(
          "delete_confirm",
          "attacker",
          5,
          3_600,
        );
      }
      const denied = await iso.rateLimit.enforceRateLimit(
        "delete_confirm",
        "attacker",
        5,
        3_600,
      );
      assertEquals(denied.allowed, false, "budget exhausted");

      // 19 999 other LIVE keys (distinct ids, 1-hour windows) fill the map.
      for (let i = 0; i < 19_999; i += 1) {
        await iso.rateLimit.enforceRateLimit("ip", `filler-${i}`, 1_200, 3_600);
      }
      // One more new key at capacity with nothing expired.
      await iso.rateLimit.enforceRateLimit("ip", "one-more", 1_200, 3_600);

      const after = await iso.rateLimit.peekRateLimit(
        "delete_confirm",
        "attacker",
        5,
        3_600,
      );
      assertEquals(
        after.allowed,
        false,
        `exhausted budget was reset (remaining=${after.remaining}) by unrelated traffic`,
      );
      assertEquals(redis.calls, 0);
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "memory limiter: expired windows are reclaimed before any clearing (no wipe when garbage exists)",
  async () => {
    configureRedis(false);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      for (let i = 0; i < 5; i += 1) {
        await iso.rateLimit.enforceRateLimit(
          "delete_confirm",
          "victim",
          5,
          3_600,
        );
      }
      // Fill with keys whose windows expire almost immediately.
      for (let i = 0; i < 19_999; i += 1) {
        await iso.rateLimit.enforceRateLimit("ip", `short-${i}`, 1_200, 0.001);
      }
      await new Promise((r) => setTimeout(r, 5));
      await iso.rateLimit.enforceRateLimit("ip", "one-more", 1_200, 3_600);
      const after = await iso.rateLimit.peekRateLimit(
        "delete_confirm",
        "victim",
        5,
        3_600,
      );
      assertEquals(
        after.allowed,
        false,
        "live window survived because expired keys were reclaimed",
      );
    } finally {
      redis.restore();
    }
  },
);

Deno.test("Retry-After counts to the END of the aligned bucket, never 0", async () => {
  configureRedis(false);
  const redis = fakeUpstash();
  try {
    const iso = await loadIsolate();
    const rl = await iso.rateLimit.enforceRateLimit("x", "id", 1, 60);
    const secondsLeftInMinute = 60 - (Math.floor(Date.now() / 1_000) % 60);
    assert(rl.retryAfterSeconds >= 1 && rl.retryAfterSeconds <= 60);
    assert(Math.abs(rl.retryAfterSeconds - secondsLeftInMinute) <= 1);
  } finally {
    redis.restore();
  }
});

Deno.test(
  "fixed-window characteristic: a client can spend 2× the limit inside one window-length straddling a bucket edge (documented design, not a defect)",
  async () => {
    configureRedis(false);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const realNow = Date.now;
      const bucketMs = 60_000;
      const edge = Math.floor(realNow() / bucketMs) * bucketMs + bucketMs;
      try {
        Date.now = () => edge - 1; // last ms of bucket N
        let allowed = 0;
        for (let i = 0; i < 10; i += 1) {
          if (
            (await iso.rateLimit.enforceRateLimit("w", "c", 10, 60)).allowed
          ) allowed += 1;
        }
        Date.now = () => edge + 1; // first ms of bucket N+1
        for (let i = 0; i < 10; i += 1) {
          if (
            (await iso.rateLimit.enforceRateLimit("w", "c", 10, 60)).allowed
          ) allowed += 1;
        }
        assertEquals(allowed, 20, "20 hits in 2 ms against a 10/min limit");
      } finally {
        Date.now = realNow;
      }
    } finally {
      redis.restore();
    }
  },
);

Deno.test(
  "Redis path and memory path never mix for a single key inside one call (count source is exclusive)",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const a = await iso.rateLimit.enforceRateLimit("ip", "5.5.5.5", 3, 60);
      const b = await iso.rateLimit.enforceRateLimit("ip", "5.5.5.5", 3, 60);
      assertEquals([a.remaining, b.remaining], [2, 1]);
      redis.failStatus = 500;
      const c = await iso.rateLimit.enforceRateLimit("ip", "5.5.5.5", 3, 60);
      // Falls to memory which has never seen this key → count restarts at 1.
      assertEquals(
        c.remaining,
        2,
        "memory window starts fresh when Redis drops out mid-window",
      );
      redis.failStatus = null;
      const d = await iso.rateLimit.enforceRateLimit("ip", "5.5.5.5", 3, 60);
      assertEquals(d.remaining, 0, "Redis count resumes where it left off");
    } finally {
      redis.restore();
    }
  },
);

// ─── L1 cache lifecycle ──────────────────────────────────────────────────────

Deno.test("cacheSet with ttl ≤ 0 stores nothing in L1 or Redis", async () => {
  configureRedis(true);
  const redis = fakeUpstash();
  try {
    const iso = await loadIsolate();
    await iso.cache.cacheSet("z", "v", 0);
    await iso.cache.cacheSet("n", "v", -5);
    assertEquals(redis.commands.length, 0);
    assertEquals(await iso.cache.cacheGet("z"), null);
  } finally {
    redis.restore();
  }
});

Deno.test("cacheSet fractional ttl is rounded UP for Redis (never shorter than L1)", async () => {
  configureRedis(true);
  const redis = fakeUpstash();
  try {
    const iso = await loadIsolate();
    await iso.cache.cacheSet("f", "v", 1.2);
    const setCmd = redis.commands.find((c) => c[0] === "SET");
    assertEquals(setCmd?.[4], 2);
  } finally {
    redis.restore();
  }
});

Deno.test("cacheDel with no keys is a no-op (no Redis round trip)", async () => {
  configureRedis(true);
  const redis = fakeUpstash();
  try {
    const iso = await loadIsolate();
    await iso.cache.cacheDel();
    assertEquals(redis.calls, 0);
  } finally {
    redis.restore();
  }
});

Deno.test("redisWindowGet: missing key is 0 (peek allows), non-numeric value is null (memory fallback)", async () => {
  configureRedis(true);
  const redis = fakeUpstash();
  try {
    const iso = await loadIsolate();
    assertEquals(await iso.cache.redisWindowGet("rl:none"), 0);
    redis.store.set("rl:garbage", { value: "abc", expiresAtMs: null });
    assertEquals(await iso.cache.redisWindowGet("rl:garbage"), null);
  } finally {
    redis.restore();
  }
});
