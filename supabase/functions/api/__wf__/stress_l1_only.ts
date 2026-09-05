// Spawned by stress_edge_cache_failure_load.test.ts (l1-heap): measures the
// production L1 Map in cache.ts ALONE — no Upstash env, so cacheSet never
// leaves the isolate — after a forced GC. Prints one JSON line.
//
//   deno run -A --v8-flags=--expose-gc stress_l1_only.ts <users> <seed>

import { Prng } from "./stress_support.ts";

Deno.env.delete("UPSTASH_REDIS_REST_URL");
Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
const { cacheGet, cacheSet } = await import("../cache.ts");

const users = Number(Deno.args[0] ?? "20000");
const prng = new Prng(Number(Deno.args[1] ?? "1"));
const gc = (globalThis as { gc?: () => void }).gc;

// Keys are re-derived from the seed for the residency pass instead of being
// kept in an array, so the heap delta is the Map and nothing else.
const keyOf = (rng: Prng) => `auth:${rng.hex(64)}`;
const rowOf = (rng: Prng, i: number) =>
  JSON.stringify({
    userId: rng.uuid(),
    email: `${i}@heap.test`,
    provider: "apple",
    sessionId: rng.uuid(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });

gc?.();
const heapStart = Deno.memoryUsage().heapUsed;
const started = performance.now();
for (let i = 0; i < users; i++) await cacheSet(keyOf(prng), rowOf(prng, i), 600);
const setMs = performance.now() - started;
gc?.();
const heapAfter = Deno.memoryUsage().heapUsed;

const replay = new Prng(Number(Deno.args[1] ?? "1"));
let resident = 0;
let oldestResident = -1;
let newestEvicted = -1;
for (let i = 0; i < users; i++) {
  const key = keyOf(replay);
  rowOf(replay, i);
  if ((await cacheGet(key)) !== null) {
    resident += 1;
    if (oldestResident < 0) oldestResident = i;
  } else {
    newestEvicted = i;
  }
}

const report = JSON.stringify({
  users,
  gcForced: typeof gc === "function",
  setMs: Math.round(setMs),
  resident,
  oldestResident,
  newestEvicted,
  heapDeltaMB: Math.round(((heapAfter - heapStart) / 1_048_576) * 100) / 100,
  bytesPerResidentEntry: resident > 0 ? Math.round((heapAfter - heapStart) / resident) : null,
});
await Deno.stdout.write(new TextEncoder().encode(`${report}\n`));
