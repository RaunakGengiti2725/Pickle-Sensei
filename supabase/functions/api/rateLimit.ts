// Fixed-window rate limiting backed by the layered cache (Upstash Redis when
// configured — a TRUE cross-instance limit — otherwise a per-isolate
// in-memory window, which still stops any single runaway client).
//
// Windows are aligned buckets (floor(now / window)), so a limit of 60/min
// means at most 60 requests inside each clock minute per key. Limits fail
// OPEN on backend errors: a Redis outage must never lock users out.

import { redisConfigured, redisWindowGet, redisWindowIncr, sha256Hex } from "./cache.ts";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

interface MemoryWindow {
  count: number;
  resetAtMs: number;
}

const MEMORY_WINDOW_MAX = 20_000;
const windows = new Map<string, MemoryWindow>();
let nextMemoryExpiryAtMs = Infinity;

function memoryHasCapacity(now: number): boolean {
  if (windows.size < MEMORY_WINDOW_MAX) return true;
  if (now >= nextMemoryExpiryAtMs) {
    nextMemoryExpiryAtMs = Infinity;
    for (const [key, window] of windows) {
      if (window.resetAtMs <= now) {
        windows.delete(key);
      } else {
        nextMemoryExpiryAtMs = Math.min(nextMemoryExpiryAtMs, window.resetAtMs);
      }
    }
  }
  return windows.size < MEMORY_WINDOW_MAX;
}

function memoryIncr(key: string, resetAtMs: number): number {
  const now = Date.now();
  const existing = windows.get(key);
  if (existing && existing.resetAtMs > now) {
    existing.count += 1;
    return existing.count;
  }
  if (!memoryHasCapacity(now)) return Infinity;
  windows.set(key, { count: 1, resetAtMs });
  nextMemoryExpiryAtMs = Math.min(nextMemoryExpiryAtMs, resetAtMs);
  return 1;
}

function memoryGet(key: string): number {
  const now = Date.now();
  const existing = windows.get(key);
  if (existing && existing.resetAtMs > now) return existing.count;
  return memoryHasCapacity(now) ? 0 : Infinity;
}

function windowKey(scope: string, id: string, windowSeconds: number) {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1_000));
  return { bucket, key: `rl:${scope}:${bucket}:${id}` };
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
  const { bucket, count } = await countHit(scope, id, windowSeconds);
  return toResult(count, limit, bucket, windowSeconds, count <= limit);
}

/** Atomic INCR of the aligned window; `count` is the hit's ordinal in it. */
async function countHit(
  scope: string,
  id: string,
  windowSeconds: number,
): Promise<{ bucket: number; count: number }> {
  const { bucket, key } = windowKey(scope, id, windowSeconds);
  let count: number | null = null;
  if (redisConfigured()) {
    count = await redisWindowIncr(key, windowSeconds);
  }
  if (count === null) {
    count = memoryIncr(key, (bucket + 1) * windowSeconds * 1_000);
  }
  return { bucket, count };
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
  const { bucket, key } = windowKey(scope, id, windowSeconds);
  let count: number | null = null;
  if (redisConfigured()) {
    count = await redisWindowGet(key);
  }
  if (count === null) {
    count = memoryGet(key);
  }
  return toResult(count, limit, bucket, windowSeconds, count < limit);
}

/**
 * Auth-failure budget behind a shared egress (club Wi-Fi, carrier-grade NAT).
 *
 * Two aligned windows share one `budget`:
 *   authfail    — per egress IP; counts DISTINCT failing credentials, so it
 *                 trips on token stuffing (many bad bearers) but one handset
 *                 replaying a dead bearer spends exactly one of the venue's
 *                 failures per window.
 *   authfail_id — per (egress IP, credential shard); counts every refusal of
 *                 that credential, so the replaying handset alone is throttled.
 *
 * `kind` says what the 401 meant:
 *   credential — the credential itself was refused (bad/expired/forged token,
 *                refused refresh token). The attack signal: charges the shard
 *                and, on the shard's first failure, the egress.
 *   liveness   — a credential that verified but whose session is no longer
 *                live (fenced at this edge after logout, gone/banned upstream).
 *                The holder learning the truth is not an attack on the venue:
 *                charges only the shard, never the egress.
 */
export type AuthFailureKind = "credential" | "liveness";

export interface AuthFailureBudget {
  limit: number;
  windowSeconds: number;
}

/** What a 401 meant, attached to the response by whoever refused it. `identity`
 * is set when the refused credential was not the bearer (a refresh token). */
export interface AuthRefusal {
  kind: AuthFailureKind;
  identity?: string | null;
}

const AUTH_FAILURE_EGRESS_SCOPE = "authfail";
const AUTH_FAILURE_SHARD_SCOPE = "authfail_id";
const CREDENTIAL_REFUSAL: AuthRefusal = { kind: "credential" };

const refusals = new WeakMap<Response, AuthRefusal>();

/** Tags a 401 so the dispatcher charges it for what it meant. An untagged
 * 401 is a credential refusal of the presented bearer. */
export function authRefusal(response: Response, refusal: AuthRefusal): Response {
  refusals.set(response, refusal);
  return response;
}

export function authRefusalOf(response: Response): AuthRefusal {
  return refusals.get(response) ?? CREDENTIAL_REFUSAL;
}

/** Opaque shard id for the credential a request presented (a hash prefix —
 * the credential itself never becomes a cache key); null when none. */
export async function authFailureIdentity(credential: string): Promise<string | null> {
  if (!credential) return null;
  return (await sha256Hex(credential)).slice(0, 32);
}

const shardId = (ip: string, identity: string) => `${ip}:${identity}`;

/**
 * Gate a request up front WITHOUT charging: closed once the egress has spent
 * its budget (distinct refused credentials plus credential-less refusals), or
 * once the presented credential's own shard is spent. The closed window's
 * Retry-After is reported.
 */
export async function peekAuthFailureBudget(
  ip: string,
  identity: string | null,
  budget: AuthFailureBudget,
): Promise<RateLimitResult> {
  const egress = await peekRateLimit(
    AUTH_FAILURE_EGRESS_SCOPE,
    ip,
    budget.limit,
    budget.windowSeconds,
  );
  if (!egress.allowed || identity === null) return egress;
  const shard = await peekRateLimit(
    AUTH_FAILURE_SHARD_SCOPE,
    shardId(ip, identity),
    budget.limit,
    budget.windowSeconds,
  );
  return shard.allowed ? egress : shard;
}

/**
 * Charge one 401. Atomic INCRs only (never a read-then-write): the shard's
 * INCR ordinal decides whether this credential is new to the window, and only
 * a NEW credential failure charges the egress. A refusal with no credential
 * to shard on (no bearer at all) has nothing a peer could be sharing and
 * charges the egress directly, as every auth failure did before sharding.
 */
export async function chargeAuthFailure(
  ip: string,
  identity: string | null,
  kind: AuthFailureKind,
  budget: AuthFailureBudget,
): Promise<void> {
  if (identity === null) {
    if (kind === "credential") {
      await countHit(AUTH_FAILURE_EGRESS_SCOPE, ip, budget.windowSeconds);
    }
    return;
  }
  const shard = await countHit(
    AUTH_FAILURE_SHARD_SCOPE,
    shardId(ip, identity),
    budget.windowSeconds,
  );
  if (kind === "credential" && shard.count === 1) {
    await countHit(AUTH_FAILURE_EGRESS_SCOPE, ip, budget.windowSeconds);
  }
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
