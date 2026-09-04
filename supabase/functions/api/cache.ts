// Layered cache for the Pickle Sensei Edge Function.
//
//   L1 — per-isolate in-memory map (always on; capped; TTL-expired lazily).
//   L2 — Upstash Redis over its REST API, enabled when the secrets
//        UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set
//        (`supabase secrets set …`). Redis makes cache hits and rate-limit
//        windows SHARED across all function instances; without it the code
//        degrades gracefully to per-isolate behavior instead of failing.
//
// Every Redis call is bounded by a short timeout and failure-tolerant: a
// Redis outage can slow the cache down, never break a request. Values stored
// here are short-lived derived state (verified session material, computed
// rank/progress payloads, rate-limit counters) — the database remains the
// only source of truth.

const REDIS_URL = Deno.env.get("UPSTASH_REDIS_REST_URL") ?? null;
const REDIS_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN") ?? null;
const REDIS_TIMEOUT_MS = 1_200;

export function redisConfigured(): boolean {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

type RedisPipelineResult = Array<{ result?: unknown; error?: string }>;

/** Run a Redis pipeline via Upstash REST. Returns null on ANY failure —
 * callers treat null as "cache unavailable", never as an error. */
async function redisPipeline(
  commands: Array<Array<string | number>>,
): Promise<RedisPipelineResult | null> {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const response = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Body must be consumed or the connection leaks in the edge runtime.
      await response.text().catch(() => undefined);
      return null;
    }
    const parsed = (await response.json().catch(() => null)) as unknown;
    return Array.isArray(parsed) ? (parsed as RedisPipelineResult) : null;
  } catch {
    return null;
  }
}

// ─── L1: per-isolate memory ──────────────────────────────────────────────────

interface MemoryEntry {
  value: string;
  expiresAtMs: number;
}

const MEMORY_MAX_ENTRIES = 5_000;
const memory = new Map<string, MemoryEntry>();

function memoryGet(key: string): string | null {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

function memorySet(key: string, value: string, ttlSeconds: number): void {
  if (memory.size >= MEMORY_MAX_ENTRIES) {
    // Evict expired entries first; if none expired, drop the oldest third so
    // a hot isolate can never grow without bound.
    const now = Date.now();
    for (const [k, v] of memory) {
      if (v.expiresAtMs <= now) memory.delete(k);
    }
    if (memory.size >= MEMORY_MAX_ENTRIES) {
      let toDrop = Math.ceil(MEMORY_MAX_ENTRIES / 3);
      for (const k of memory.keys()) {
        if (toDrop-- <= 0) break;
        memory.delete(k);
      }
    }
  }
  memory.set(key, { value, expiresAtMs: Date.now() + ttlSeconds * 1_000 });
}

// ─── Public cache API ────────────────────────────────────────────────────────

export async function cacheGet(key: string): Promise<string | null> {
  const local = memoryGet(key);
  if (local !== null) return local;
  const results = await redisPipeline([
    ["GET", key],
    ["TTL", key],
  ]);
  const value = results?.[0]?.result;
  if (typeof value !== "string") return null;
  const ttl = Number(results?.[1]?.result);
  if (Number.isFinite(ttl) && ttl > 0) {
    memorySet(key, value, Math.min(ttl, 60));
  }
  return value;
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return;
  memorySet(key, value, ttlSeconds);
  await redisPipeline([["SET", key, value, "EX", Math.ceil(ttlSeconds)]]);
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  for (const key of keys) memory.delete(key);
  await redisPipeline([["DEL", ...keys]]);
}

// ─── Fenced keys (revocation tombstones) ─────────────────────────────────────
//
// A plain DEL cannot revoke a key whose next writer already holds the value it
// is about to store (an `authenticate()` that verified the bearer with GoTrue
// just before logout evicted it): the late SET simply resurrects the entry.
// `cacheFence` drops the key AND leaves a tombstone beside it for as long as
// any legitimate entry could still live; `cacheSetFenced` refuses to store
// (and undoes a store that raced the fence) while the tombstone stands, and
// `cacheGetFenced` treats a fenced key as a miss on both tiers.

const fenceKeyOf = (key: string) => `${key}#fence`;

function fenceExists(results: RedisPipelineResult | null, index: number): boolean {
  return Number(results?.[index]?.result) > 0;
}

/** Evict `key` and fence it for `ttlSeconds` on both tiers. */
export async function cacheFence(key: string, ttlSeconds: number): Promise<void> {
  const fence = fenceKeyOf(key);
  memorySet(fence, "1", ttlSeconds);
  memory.delete(key);
  await redisPipeline([
    ["SET", fence, "1", "EX", Math.ceil(ttlSeconds)],
    ["DEL", key],
  ]);
}

/** `cacheGet` that reports a miss while `key` is fenced. */
export async function cacheGetFenced(key: string): Promise<string | null> {
  const fence = fenceKeyOf(key);
  if (memoryGet(fence) !== null) {
    memory.delete(key);
    return null;
  }
  const local = memoryGet(key);
  if (local !== null) return local;
  const results = await redisPipeline([
    ["GET", key],
    ["TTL", key],
    ["EXISTS", fence],
  ]);
  if (fenceExists(results, 2)) return null;
  const value = results?.[0]?.result;
  if (typeof value !== "string") return null;
  const ttl = Number(results?.[1]?.result);
  if (Number.isFinite(ttl) && ttl > 0) {
    memorySet(key, value, Math.min(ttl, 60));
  }
  return value;
}

/** `cacheSet` that yields to a fence: returns false (and stores nothing) when
 * `key` is fenced before or during the write. The post-write EXISTS travels
 * in the same pipeline as the SET, so a fence raised between the two is seen
 * and the just-stored value is deleted again. */
export async function cacheSetFenced(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<boolean> {
  if (ttlSeconds <= 0) return false;
  const fence = fenceKeyOf(key);
  if (memoryGet(fence) !== null) return false;
  memorySet(key, value, ttlSeconds);
  const results = await redisPipeline([
    ["SET", key, value, "EX", Math.ceil(ttlSeconds)],
    ["EXISTS", fence],
  ]);
  if (memoryGet(fence) === null && !fenceExists(results, 1)) return true;
  memory.delete(key);
  await redisPipeline([["DEL", key]]);
  return false;
}

/** Increment a fixed-window counter, creating it with the window's TTL.
 * Returns the post-increment count, or null when Redis is unavailable (the
 * rate limiter then falls back to its in-memory window). */
export async function redisWindowIncr(key: string, windowSeconds: number): Promise<number | null> {
  const results = await redisPipeline([
    ["INCR", key],
    ["EXPIRE", key, windowSeconds, "NX"],
  ]);
  const count = Number(results?.[0]?.result);
  return Number.isFinite(count) ? count : null;
}

/** Read a fixed-window counter WITHOUT touching L1: rate-limit buckets are
 * shared across isolates, so a warmed local copy would hide increments made
 * elsewhere. Returns 0 for a missing key and null when Redis is unavailable. */
export async function redisWindowGet(key: string): Promise<number | null> {
  const results = await redisPipeline([["GET", key]]);
  if (!results) return null;
  const raw = results[0]?.result;
  if (raw === null || raw === undefined) return 0;
  const count = Number(raw);
  return Number.isFinite(count) ? count : null;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
