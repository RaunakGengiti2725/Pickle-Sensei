// Structural audit #2 (pass 1) — module-level probes for cache.ts and
// rateLimit.ts using the existing harness (fake Upstash + per-isolate module
// instances). `PROBE:` asserts the property the subsystem needs to hold; a
// failing PROBE is an audit finding. `PIN:` asserts verified-good behaviour.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json audit_s2_cache_ratelimit_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";

// ─── cross-isolate invalidation (logout / revocation) ────────────────────────

Deno.test("PROBE: cacheDel must invalidate a key in EVERY isolate, not just the caller's L1", async () => {
  // index.ts:573-575 — logout drops the bearer via cacheDel. cache.ts:111-121
  // deletes the caller isolate's L1 entry and the shared Redis key; an isolate
  // that already warmed the same key keeps serving it for the rest of its L1
  // TTL (auth entries live up to 570 s), so the revoked bearer still
  // authenticates there.
  configureRedis(true);
  const redis = fakeUpstash();
  try {
    const a = await loadIsolate();
    const b = await loadIsolate();
    const key = "auth:probe-revoked-bearer";

    await a.cache.cacheSet(key, JSON.stringify({ userId: "u1" }), 570);
    // Isolate B serves one request with that bearer → warms its own L1 from Redis.
    assertEquals(await b.cache.cacheGet(key), JSON.stringify({ userId: "u1" }));

    // Sign-out lands on isolate A.
    await a.cache.cacheDel(key);
    assertEquals(await a.cache.cacheGet(key), null, "caller isolate must forget the bearer");
    assertEquals(redis.store.has(key), false, "Redis copy must be gone");

    assertEquals(
      await b.cache.cacheGet(key),
      null,
      "another isolate still returns the revoked session from its L1",
    );
  } finally {
    redis.restore();
    configureRedis(false);
  }
});

Deno.test("PIN: a Redis-warmed L1 copy is capped at 60 s (bounds the cross-isolate staleness for READ-warmed keys)", async () => {
  configureRedis(true);
  const redis = fakeUpstash();
  try {
    const a = await loadIsolate();
    const b = await loadIsolate();
    const key = "cache:probe-warm-ttl";
    await a.cache.cacheSet(key, "v", 570);
    assertEquals(await b.cache.cacheGet(key), "v");
    const ttlCommands = redis.commands.filter((c) => String(c[0]).toUpperCase() === "TTL");
    assert(ttlCommands.length >= 1, "read path must ask Redis for the remaining TTL");
  } finally {
    redis.restore();
    configureRedis(false);
  }
});

// ─── in-memory limiter capacity behaviour (Redis unavailable) ────────────────

Deno.test("PROBE: the memory limiter must not wipe LIVE windows when it hits its 20 000-key cap", async () => {
  // rateLimit.ts:33-38 — when no window has expired, `windows.clear()` drops
  // every live counter. An attacker who fills the map (one key per source IP,
  // or per user id) resets everyone's budget, including the auth-failure
  // budget that gates credential stuffing.
  configureRedis(false);
  const { rateLimit } = await loadIsolate();
  const victim = "203.0.113.99";

  // The victim burns its whole auth-failure budget.
  let last = await rateLimit.enforceRateLimit("authfail", victim, 30, 300);
  for (let i = 1; i < 30; i += 1) {
    last = await rateLimit.enforceRateLimit("authfail", victim, 30, 300);
  }
  assertEquals(last.remaining, 0);
  const blocked = await rateLimit.peekRateLimit("authfail", victim, 30, 300);
  assertEquals(blocked.allowed, false, "budget must be spent before the flood");

  // Flood distinct keys in the same window until the cap trips.
  for (let i = 0; i < 20_001; i += 1) {
    await rateLimit.enforceRateLimit("authfail", `flood-${i}`, 30, 300);
  }

  const after = await rateLimit.peekRateLimit("authfail", victim, 30, 300);
  assertEquals(
    after.allowed,
    false,
    "the victim's spent auth-failure budget was reset by the capacity flood",
  );
});

// ─── Redis outage cost (no circuit breaker) ──────────────────────────────────

Deno.test("PROBE: a hanging Redis must not cost the full timeout on every subsequent call (no circuit breaker)", async () => {
  // cache.ts:18,26-50 — REDIS_TIMEOUT_MS is 1 200 ms and nothing remembers a
  // failure, so each cache/limiter call pays it again. An authenticated
  // request performs several (rate-limit INCR + auth cacheGet + response
  // caches), which multiplies straight into request latency during an
  // Upstash outage.
  configureRedis(true);
  const redis = fakeUpstash();
  redis.hang = true;
  try {
    const { cache } = await loadIsolate();
    const first = performance.now();
    await cache.cacheGet("probe:breaker:1");
    const firstMs = performance.now() - first;
    assert(firstMs >= 1_000, `first call should hit the 1 200 ms timeout, took ${Math.round(firstMs)} ms`);

    const second = performance.now();
    await cache.cacheGet("probe:breaker:2");
    await cache.cacheGet("probe:breaker:3");
    const laterMs = performance.now() - second;
    console.log(
      `redis hang: first=${Math.round(firstMs)}ms next-two=${Math.round(laterMs)}ms (${redis.calls} calls made)`,
    );
    assert(
      laterMs < 500,
      `after a timeout the next calls still paid the full timeout (${Math.round(laterMs)} ms for two calls)`,
    );
  } finally {
    redis.hang = false;
    redis.restore();
    configureRedis(false);
  }
});

// ─── Redis pipeline per-command errors ───────────────────────────────────────

Deno.test("PROBE: a per-command Redis error must not be read as a successful zero count", async () => {
  // cache.ts:26-50 never inspects the `error` field of a pipeline entry.
  // redisWindowGet (cache.ts:141-148) maps a missing `result` to 0, so an
  // errored GET is indistinguishable from "no hits yet" and peekRateLimit
  // reports a full budget while the real counter is unknown.
  configureRedis(true);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://fake-upstash.test")) return original(input, init);
    const commands = JSON.parse(String(init?.body ?? "[]")) as unknown[];
    return new Response(
      JSON.stringify(commands.map(() => ({ error: "ERR max requests limit exceeded" }))),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const { cache } = await loadIsolate();
    const count = await cache.redisWindowGet("rl:probe:err");
    assertEquals(
      count,
      null,
      "an errored pipeline entry was reported as a real count of 0 (budget looks untouched)",
    );
  } finally {
    globalThis.fetch = original;
    configureRedis(false);
  }
});

Deno.test("PIN: Redis HTTP failure and timeout degrade to per-isolate memory instead of throwing", async () => {
  configureRedis(true);
  const redis = fakeUpstash();
  redis.failStatus = 500;
  try {
    const { cache, rateLimit } = await loadIsolate();
    assertEquals(await cache.cacheGet("probe:degrade"), null);
    await cache.cacheSet("probe:degrade", "v", 60);
    assertEquals(await cache.cacheGet("probe:degrade"), "v", "L1 still serves the write");
    const first = await rateLimit.enforceRateLimit("probe", "id", 2, 60);
    const second = await rateLimit.enforceRateLimit("probe", "id", 2, 60);
    const third = await rateLimit.enforceRateLimit("probe", "id", 2, 60);
    assertEquals([first.allowed, second.allowed, third.allowed], [true, true, false]);
  } finally {
    redis.restore();
    configureRedis(false);
  }
});
