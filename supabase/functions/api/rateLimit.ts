// Fixed-window rate limiting backed by the layered cache (Upstash Redis when
// configured — a TRUE cross-instance limit — otherwise a per-isolate
// in-memory window, which still stops any single runaway client).
//
// Windows are aligned buckets (floor(now / window)), so a limit of 60/min
// means at most 60 requests inside each clock minute per key. Limits fail
// OPEN on backend errors: a Redis outage must never lock users out.
//
// The memory fallback is bounded in BOTH dimensions: identities longer than
// MEMORY_ID_MAX_CHARS are replaced by their SHA-256 before they become part
// of a key, and the map never holds more than MEMORY_WINDOW_MAX windows.
// Under pressure it evicts expired windows first, then the least recently
// used windows that have NOT reached their limit — a window whose budget is
// exhausted (an active lockout) is never evicted, so no volume of unrelated
// identities can release it.

import { redisConfigured, redisWindowGet, redisWindowIncr } from "./cache.ts";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

interface MemoryWindow {
  count: number;
  limit: number;
  resetAtMs: number;
}

export const MEMORY_WINDOW_MAX = 20_000;
const MEMORY_EVICT_BATCH = MEMORY_WINDOW_MAX / 20;
const MEMORY_ID_MAX_CHARS = 128;
// Insertion order doubles as LRU order: every counted hit re-inserts its
// window at the tail, so iteration starts at the least recently used one.
const windows = new Map<string, MemoryWindow>();

/** Number of live + not-yet-swept windows held by this isolate (tests). */
export function memoryWindowCount(): number {
  return windows.size;
}

function isLocked(window: MemoryWindow): boolean {
  return window.count >= window.limit;
}

function memoryEvict(now: number): void {
  for (const [k, v] of windows) {
    if (v.resetAtMs <= now) windows.delete(k);
  }
  if (windows.size < MEMORY_WINDOW_MAX) return;
  let evicted = 0;
  for (const [k, v] of windows) {
    if (isLocked(v)) continue;
    windows.delete(k);
    evicted += 1;
    if (evicted >= MEMORY_EVICT_BATCH) break;
  }
}

function memoryIncr(key: string, limit: number, windowSeconds: number): number {
  const now = Date.now();
  const existing = windows.get(key);
  if (existing && existing.resetAtMs > now) {
    existing.count += 1;
    existing.limit = limit;
    windows.delete(key);
    windows.set(key, existing);
    return existing.count;
  }
  if (existing) windows.delete(key);
  if (windows.size >= MEMORY_WINDOW_MAX) memoryEvict(now);
  if (windows.size < MEMORY_WINDOW_MAX) {
    windows.set(key, { count: 1, limit, resetAtMs: now + windowSeconds * 1_000 });
  }
  // Otherwise every retained window is an active lockout: this first hit is
  // reported but not retained (fail open, as on a backend outage) rather
  // than releasing someone else's lockout to make room.
  return 1;
}

function memoryGet(key: string): number {
  const existing = windows.get(key);
  return existing && existing.resetAtMs > Date.now() ? existing.count : 0;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Identity as it appears in a key: verbatim when short, otherwise a
 * fixed-size digest so a hostile identity cannot grow keys without bound
 * (in memory or in Redis). */
async function boundedId(id: string): Promise<string> {
  if (id.length <= MEMORY_ID_MAX_CHARS) return id;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return `sha256:${hex(digest)}`;
}

async function windowKey(scope: string, id: string, windowSeconds: number) {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1_000));
  return { bucket, key: `rl:${scope}:${bucket}:${await boundedId(id)}` };
}

function toResult(
  count: number,
  limit: number,
  bucket: number,
  windowSeconds: number,
  allowed: boolean,
): RateLimitResult {
  const remaining = Math.max(0, limit - count);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((bucket + 1) * windowSeconds - Date.now() / 1_000),
  );
  return { allowed, limit, remaining, retryAfterSeconds };
}

/**
 * Count one hit against `scope`+`id` and report whether it is allowed.
 *
 *   scope — the limited action (e.g. "user", "ip", "billing_sync")
 *   id    — who is being limited (user id, client IP, …)
 */
export async function enforceRateLimit(
  scope: string,
  id: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const { bucket, key } = await windowKey(scope, id, windowSeconds);
  let count: number | null = null;
  if (redisConfigured()) {
    count = await redisWindowIncr(key, windowSeconds);
  }
  if (count === null) {
    count = memoryIncr(key, limit, windowSeconds);
  }
  return toResult(count, limit, bucket, windowSeconds, count <= limit);
}

/**
 * Inspect a window WITHOUT counting a hit. `allowed` is false once `limit`
 * hits have already been recorded (the next hit would exceed it). Used for
 * budgets that are charged by a later outcome (e.g. only failed
 * authentications count) but must gate every request up front.
 */
export async function peekRateLimit(
  scope: string,
  id: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const { bucket, key } = await windowKey(scope, id, windowSeconds);
  let count: number | null = null;
  if (redisConfigured()) {
    count = await redisWindowGet(key);
  }
  if (count === null) {
    count = memoryGet(key);
  }
  return toResult(count, limit, bucket, windowSeconds, count < limit);
}

/** 429 body + headers shared by every limited route. */
export function rateLimitResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "rate_limited",
        message: "Too many requests. Please slow down and try again shortly.",
      },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(result.retryAfterSeconds),
        "RateLimit-Limit": String(result.limit),
        "RateLimit-Remaining": String(result.remaining),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    },
  );
}
