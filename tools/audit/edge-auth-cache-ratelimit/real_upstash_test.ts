// cache.ts + rateLimit.ts against a REAL Upstash-compatible REST endpoint
// (hiett/serverless-redis-http in front of redis:7) — no fetch stubbing.
//
//   docker compose up -d redis
//   docker run -d --name srh --network host -e SRH_MODE=env -e SRH_PORT=8079 \
//     -e SRH_TOKEN=local-srh-token -e SRH_CONNECTION_STRING=redis://127.0.0.1:6379 \
//     hiett/serverless-redis-http:latest
//   cd tools/audit/edge-auth-cache-ratelimit && \
//     UPSTASH_REDIS_REST_URL=http://127.0.0.1:8079 UPSTASH_REDIS_REST_TOKEN=local-srh-token \
//     deno task probe:upstash
//
// Skips (loudly, as a failure — a skipped stage is not a pass) when the env is
// not configured.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";

const url = Deno.env.get("UPSTASH_REDIS_REST_URL");
const token = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");
if (!url || !token) {
  throw new Error(
    "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — real-Redis probe cannot run",
  );
}

// Two independent module instances = two edge isolates sharing one Redis.
const isolateA = await import(
  `../../../supabase/functions/api/cache.ts?iso=${crypto.randomUUID()}`
);
const isolateB = await import(
  `../../../supabase/functions/api/cache.ts?iso=${crypto.randomUUID()}`
);
const rlA = await import(
  `../../../supabase/functions/api/rateLimit.ts?iso=${crypto.randomUUID()}`
);
const rlB = await import(
  `../../../supabase/functions/api/rateLimit.ts?iso=${crypto.randomUUID()}`
);

const key = (s: string) => `probe:${crypto.randomUUID()}:${s}`;

async function raw(cmd: unknown[]): Promise<unknown> {
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([cmd]),
  });
  const out = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  return out[0]?.result;
}

Deno.test("redis reachable and configured for both isolates", async () => {
  assertStrictEquals(isolateA.redisConfigured(), true);
  assertStrictEquals(isolateB.redisConfigured(), true);
  assertEquals(await raw(["PING"]), "PONG");
});

Deno.test("cacheSet in isolate A → cacheGet in isolate B (cold L1) reads L2; TTL honoured", async () => {
  const k = key("auth");
  await isolateA.cacheSet(k, '{"userId":"u1"}', 30);
  assertEquals(await isolateB.cacheGet(k), '{"userId":"u1"}');
  const ttl = Number(await raw(["TTL", k]));
  assert(ttl > 0 && ttl <= 30, `ttl=${ttl}`);
  await raw(["DEL", k]);
});

Deno.test("cacheDel in isolate B evicts L2; isolate A's L1 copy is per-isolate (documented) and expires with its own TTL", async () => {
  const k = key("auth");
  await isolateA.cacheSet(k, "v", 2);
  assertEquals(await isolateB.cacheGet(k), "v");
  await isolateB.cacheDel(k);
  assertEquals(await raw(["GET", k]), null);
  assertEquals(await isolateB.cacheGet(k), null, "B: L1 cleared + L2 gone");
  assertEquals(
    await isolateA.cacheGet(k),
    "v",
    "A still serves its own L1 copy (not invalidated cross-isolate)",
  );
  await new Promise((r) => setTimeout(r, 2_100));
  assertEquals(
    await isolateA.cacheGet(k),
    null,
    "A's L1 copy expired with its TTL",
  );
});

Deno.test("cacheGet on a key that expired in Redis → null (stale/missing state)", async () => {
  const k = key("short");
  await isolateA.cacheSet(k, "v", 1);
  await new Promise((r) => setTimeout(r, 1_100));
  assertEquals(await isolateB.cacheGet(k), null);
  assertEquals(await isolateA.cacheGet(k), null, "L1 expired too");
});

Deno.test("cacheSet with ttl <= 0 is a no-op (nothing written to Redis)", async () => {
  const k = key("zero");
  await isolateA.cacheSet(k, "v", 0);
  await isolateA.cacheSet(k, "v", -5);
  assertEquals(await raw(["EXISTS", k]), 0);
});

Deno.test("redisWindowIncr: shared counter across isolates, EXPIRE NX keeps the first window", async () => {
  const k = key("win");
  assertEquals(await isolateA.redisWindowIncr(k, 60), 1);
  assertEquals(await isolateB.redisWindowIncr(k, 60), 2);
  assertEquals(await isolateA.redisWindowIncr(k, 5), 3);
  const ttl = Number(await raw(["TTL", k]));
  assert(
    ttl > 55 && ttl <= 60,
    `EXPIRE NX must not shrink the window: ttl=${ttl}`,
  );
  assertEquals(await isolateB.redisWindowGet(k), 3);
  await raw(["DEL", k]);
});

Deno.test("enforceRateLimit across two isolates shares the budget; peekRateLimit does not charge", async () => {
  const id = crypto.randomUUID();
  let last: { allowed: boolean; remaining: number } | null = null;
  for (let i = 0; i < 5; i += 1) {
    last = await (i % 2 === 0 ? rlA : rlB).enforceRateLimit(
      "probe_scope",
      id,
      5,
      60,
    );
    assertEquals(last!.allowed, true, `hit ${i + 1}`);
  }
  assertEquals(last!.remaining, 0);
  const peek = await rlB.peekRateLimit("probe_scope", id, 5, 60);
  assertEquals(peek.remaining, 0);
  const sixth = await rlA.enforceRateLimit("probe_scope", id, 5, 60);
  assertEquals(sixth.allowed, false);
  const res = rlA.rateLimitResponse(sixth);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("RateLimit-Limit"), "5");
  assert(Number(res.headers.get("Retry-After")) >= 1);
  await res.body?.cancel();
});

Deno.test("Redis outage mid-flight: cacheGet null, cacheSet keeps L1, limiter falls back to memory (fail-open, no throw)", async () => {
  const savedUrl = Deno.env.get("UPSTASH_REDIS_REST_URL")!;
  // Point a *fresh* isolate at a closed port; the module reads env at load.
  Deno.env.set("UPSTASH_REDIS_REST_URL", "http://127.0.0.1:1");
  const deadIso = await import(
    `../../../supabase/functions/api/cache.ts?iso=${crypto.randomUUID()}`
  );
  const deadRl = await import(
    `../../../supabase/functions/api/rateLimit.ts?iso=${crypto.randomUUID()}`
  );
  Deno.env.set("UPSTASH_REDIS_REST_URL", savedUrl);

  assertStrictEquals(deadIso.redisConfigured(), true);
  const k = key("dead");
  await deadIso.cacheSet(k, "v", 30);
  assertEquals(
    await deadIso.cacheGet(k),
    "v",
    "served from L1 despite Redis being down",
  );
  assertEquals(await raw(["EXISTS", k]), 0, "never reached the real Redis");
  assertEquals(await deadIso.redisWindowIncr(key("x"), 60), null);
  const first = await deadRl.enforceRateLimit("dead_scope", "id", 2, 60);
  const second = await deadRl.enforceRateLimit("dead_scope", "id", 2, 60);
  const third = await deadRl.enforceRateLimit("dead_scope", "id", 2, 60);
  assertEquals([first.allowed, second.allowed, third.allowed], [
    true,
    true,
    false,
  ]);
});
