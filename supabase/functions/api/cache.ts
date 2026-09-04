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
  /** False once this isolate KNOWS its L2 write of the row was refused: the
   * row then lives in L1 only, and L2 reporting it absent says nothing about
   * another isolate having deleted it. */
  inL2: boolean;
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

/** A per-command slot of a pipeline reply that actually answered (present and
 * without a Redis-side error). Anything else is an unknown, never an absence. */
function answered(results: RedisPipelineResult, index: number): { result?: unknown } | null {
  const slot = results[index];
  if (!slot || typeof slot !== "object" || slot.error !== undefined) {
    return null;
  }
  return slot;
}

function memorySet(key: string, value: string, ttlSeconds: number, inL2 = true): void {
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
  memory.set(key, {
    value,
    expiresAtMs: Date.now() + ttlSeconds * 1_000,
    inL2,
  });
}

/** How long an L2 row read through into L1 may be served locally before L2
 * is consulted again — the longest a per-isolate copy can outlive its L2 row. */
export const L1_READTHROUGH_TTL_SECONDS = 60;

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
    memorySet(key, value, Math.min(ttl, L1_READTHROUGH_TTL_SECONDS));
  }
  return value;
}

export interface GuardedCacheHit {
  /** The cached value, or null when absent or revoked. */
  value: string | null;
  /** True when the revocation marker exists (the value, if any, was dropped). */
  revoked: boolean;
}

/** Read `key` unless the revocation marker `revokedKey` exists.
 *
 * With Redis configured, L2 is the authority for whether a row is still
 * alive and L1 only a copy of its payload: every hit — L1 included — costs
 * one L2 round trip that fetches the marker and, for an L1 hit, confirms the
 * row still exists in L2 (a local copy of a row another isolate deleted is a
 * miss, not a hit). So a revocation published anywhere is honoured here on
 * the next request, not when the local copy ages out. A marker found in L2
 * is copied into L1 so the refusal stays cheap while the row it fences would
 * still be alive, and the fenced row is dropped from L1.
 *
 * Two degraded modes are told apart. Redis UNREACHABLE (HTTP failure,
 * timeout) degrades to the L1 answer, like every other read here — an
 * outage must not sign users out. Redis REACHED but not answering the
 * question (a per-command error, a short reply) is "unknown": the row is
 * not served and not dropped, so the caller re-verifies with the source of
 * truth and the copy is there again once L2 answers. A row this isolate
 * wrote but L2 refused to store is served from L1 for its lifetime: L2 has
 * no row for another isolate to have deleted. */
export async function cacheGetUnlessRevoked(
  key: string,
  revokedKey: string,
): Promise<GuardedCacheHit> {
  if (memoryGet(revokedKey) !== null) {
    memory.delete(key);
    return { value: null, revoked: true };
  }
  const local = memoryGet(key);
  if (!redisConfigured()) return { value: local, revoked: false };

  // TTL doubles as the liveness probe: -2 means the row is gone from L2.
  const commands: Array<Array<string | number>> = [["GET", revokedKey]];
  if (local === null) commands.push(["GET", key]);
  commands.push(["TTL", key]);
  const results = await redisPipeline(commands);
  if (!results) return { value: local, revoked: false };

  const markerSlot = answered(results, 0);
  if (!markerSlot) return { value: null, revoked: false };
  if (typeof markerSlot.result === "string") {
    memorySet(revokedKey, markerSlot.result, L1_READTHROUGH_TTL_SECONDS);
    memory.delete(key);
    return { value: null, revoked: true };
  }
  const ttlSlot = answered(results, commands.length - 1);
  if (!ttlSlot) return { value: null, revoked: false };
  const ttl = Number(ttlSlot.result);

  if (local !== null) {
    if (ttl !== -2) return { value: local, revoked: false };
    if (memory.get(key)?.inL2 === false) {
      return { value: local, revoked: false };
    }
    memory.delete(key);
    return { value: null, revoked: false };
  }

  const valueSlot = answered(results, 1);
  if (!valueSlot || typeof valueSlot.result !== "string") {
    return { value: null, revoked: false };
  }
  if (Number.isFinite(ttl) && ttl > 0) {
    memorySet(key, valueSlot.result, Math.min(ttl, L1_READTHROUGH_TTL_SECONDS));
  }
  return { value: valueSlot.result, revoked: false };
}

/** Whether the revocation marker `revokedKey` exists, L1 first, then L2
 * (copied into L1 when found). Null when it is absent locally and L2 did
 * not answer (unreachable, per-command error, short reply) — the caller
 * decides what "unknown" means for it. */
export async function cacheIsRevoked(revokedKey: string): Promise<boolean | null> {
  if (memoryGet(revokedKey) !== null) return true;
  if (!redisConfigured()) return false;
  const results = await redisPipeline([["GET", revokedKey]]);
  if (!results) return null;
  const slot = answered(results, 0);
  if (!slot) return null;
  if (typeof slot.result !== "string") return false;
  memorySet(revokedKey, slot.result, L1_READTHROUGH_TTL_SECONDS);
  return true;
}

/** Write L1 and L2. Resolves to whether the L2 write is KNOWN to have landed
 * (false when Redis is unconfigured, unreachable, or refused the command). */
export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  if (ttlSeconds <= 0) return false;
  memorySet(key, value, ttlSeconds);
  if (!redisConfigured()) return false;
  const results = await redisPipeline([["SET", key, value, "EX", Math.ceil(ttlSeconds)]]);
  const landed = results !== null && answered(results, 0)?.result === "OK";
  if (!landed) {
    const entry = memory.get(key);
    // Only annotate the row this call wrote; a concurrent overwrite is its own write's business.
    if (entry && entry.value === value) entry.inL2 = false;
  }
  return landed;
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  for (const key of keys) memory.delete(key);
  await redisPipeline([["DEL", ...keys]]);
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
