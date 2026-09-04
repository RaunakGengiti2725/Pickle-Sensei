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

// ─── Revocation markers ──────────────────────────────────────────────────────
//
// Cached auth entries are keyed by token hash, so a logout cannot enumerate
// the entries it must kill (the same bearer in other isolates' L1, the
// session's earlier bearers, a verification that raced it). Instead the
// revocation is recorded under a marker for the session/user, and every read
// of an auth entry asks `cacheRevoked` before trusting it.

/** Records `marker` as revoked. Markers are only ever set, never lifted: they
 * age out after `ttlSeconds`, which the caller sizes to outlive every cache
 * entry the marker covers. */
export async function cacheRevoke(marker: string, ttlSeconds: number): Promise<void> {
  memorySet(marker, "1", ttlSeconds);
  await redisPipeline([["SET", marker, "1", "EX", Math.ceil(ttlSeconds)]]);
}

/** Whether any of `markers` has been revoked. A marker held in L1 is
 * authoritative (they never lift); otherwise L2 is consulted on EVERY call —
 * an L1 miss alone cannot see a revocation recorded by another isolate.
 * Returns null when Redis is configured but unreachable: the caller cannot
 * know and must fall back to a real verification. */
export async function cacheRevoked(markers: string[]): Promise<boolean | null> {
  if (markers.length === 0) return false;
  if (markers.some((marker) => memoryGet(marker) !== null)) return true;
  if (!redisConfigured()) return false;
  const results = await redisPipeline(markers.map((marker) => ["GET", marker]));
  if (!results) return null;
  let revoked = false;
  markers.forEach((marker, index) => {
    const value = results[index]?.result;
    if (typeof value === "string") {
      memorySet(marker, value, 60);
      revoked = true;
    }
  });
  return revoked;
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
