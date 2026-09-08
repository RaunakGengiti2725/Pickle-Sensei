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

/** What an authentication refusal says about the credential presented:
 *
 *   credential — the credential itself was refused (forged or garbage bearer,
 *                GoTrue 401 / 403 bad_jwt, refused refresh or ID token, no
 *                credential at all). The stuffing signal.
 *   liveness   — a credential that was live and no longer is (session fenced
 *                at this edge after logout, 403 session_not_found upstream).
 *                The holder learning that is not an attack on anyone.
 *   expired    — refused locally because the bearer's own `exp` has passed;
 *                nothing was probed. */
export type AuthFailureKind = "credential" | "liveness" | "expired";

export interface AuthFailureBudget {
  limit: number;
  windowSeconds: number;
}

export interface AuthRefusal {
  kind: AuthFailureKind;
  /** The credential the refusal is about when it is not the request bearer
   * (a refresh token); undefined leaves the presented bearer in charge. */
  identity?: string | null;
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

/** Atomic INCR on the aligned window (Redis, else this isolate's memory). */
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

/** Hits already recorded on the aligned window, without counting one. */
async function readHits(
  scope: string,
  id: string,
  windowSeconds: number,
): Promise<{ bucket: number; count: number }> {
  const { bucket, key } = windowKey(scope, id, windowSeconds);
  let count: number | null = null;
  if (redisConfigured()) {
    count = await redisWindowGet(key);
  }
  if (count === null) {
    count = memoryGet(key);
  }
  return { bucket, count };
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
  const { bucket, count } = await readHits(scope, id, windowSeconds);
  return toResult(count, limit, bucket, windowSeconds, count < limit);
}

// ── Auth-failure budgets behind a shared egress ──────────────────────────────
//
// One NAT egress (club Wi-Fi, carrier-grade NAT) fronts a whole venue, so a
// budget keyed by IP alone lets one handset replaying its dead bearer — or
// thirty devices waking with expired ones — lock every peer out. Failures are
// therefore filed twice:
//
//   authfail        per egress — the STUFFING budget: charged once per
//                   distinct refused credential, so only many different
//                   credentials from one egress can close it.
//   authfail_id     per egress × credential — the REPLAY budget: charged on
//                   every credential or liveness refusal of that credential,
//                   so a single dead handset is throttled alone.
//   authfail_cred   per egress × credential — ordinal of that credential's
//                   CREDENTIAL refusals; its first one is the egress charge
//                   (a shard opened by a liveness refusal still charges the
//                   egress when the credential is later judged forged).
//   authfail_shards per egress — how many shards this window has opened. An
//                   unauthenticated caller mints credentials at will, so open
//                   shards are capped at AUTH_FAILURE_SHARD_CAP × limit per
//                   egress: beyond it a credential refusal charges the egress
//                   directly (stuffing is throttled exactly as before
//                   sharding) and a liveness refusal charges nothing, so the
//                   per-isolate window table cannot be filled from outside.
//
// Expired bearers, refused locally, charge nothing. A request without a
// credential has no shard and charges the egress directly.
//
// Every count is an atomic INCR; the only read-before-write is the cap check,
// which a concurrent burst may overshoot by its own size (never under-count a
// refusal, never double-charge a replay).

const AUTH_FAILURE_EGRESS_SCOPE = "authfail";
const AUTH_FAILURE_SHARD_SCOPE = "authfail_id";
const AUTH_FAILURE_CREDENTIAL_SCOPE = "authfail_cred";
const AUTH_FAILURE_SHARD_TALLY_SCOPE = "authfail_shards";
const AUTH_FAILURE_SHARD_CAP = 2;

/** GoTrue error codes that judge the session or account behind a
 * signature-valid token rather than the token itself. Anything else —
 * `bad_jwt` above all, whatever HTTP status carried it — is the credential
 * being refused. */
const LIVENESS_ERROR_CODES: ReadonlySet<string> = new Set([
  "session_not_found",
  "session_expired",
  "user_not_found",
  "user_banned",
]);

const CREDENTIAL_REFUSAL: AuthRefusal = { kind: "credential" };
const refusals = new WeakMap<Response, AuthRefusal>();

/** How to file an upstream refusal by GoTrue's `error_code`. */
export function authRefusalKind(errorCode: string | null | undefined): AuthFailureKind {
  return errorCode !== null && errorCode !== undefined && LIVENESS_ERROR_CODES.has(errorCode)
    ? "liveness"
    : "credential";
}

/** Tag a 401 with what it meant; untagged refusals count as credential
 * failures (the safe default for any refusal path not classified). */
export function authRefusal(response: Response, refusal: AuthRefusal): Response {
  refusals.set(response, refusal);
  return response;
}

export function authRefusalOf(response: Response): AuthRefusal {
  return refusals.get(response) ?? CREDENTIAL_REFUSAL;
}

/** Opaque shard identity for a presented credential — never the credential
 * itself as a key. Null when nothing was presented. */
export async function authFailureIdentity(credential: string): Promise<string | null> {
  const presented = credential.trim();
  if (!presented) return null;
  return (await sha256Hex(presented)).slice(0, 32);
}

const shardId = (ip: string, identity: string) => `${ip}:${identity}`;

/** The replay budget of one credential behind `ip` (open when none). */
export async function peekAuthFailureShard(
  ip: string,
  identity: string | null,
  budget: AuthFailureBudget,
): Promise<RateLimitResult> {
  const { bucket, count } =
    identity === null
      ? { bucket: Math.floor(Date.now() / (budget.windowSeconds * 1_000)), count: 0 }
      : await readHits(AUTH_FAILURE_SHARD_SCOPE, shardId(ip, identity), budget.windowSeconds);
  return toResult(count, budget.limit, bucket, budget.windowSeconds, count < budget.limit);
}

/** Pre-auth gate: the egress stuffing budget, then the presented credential's
 * own replay budget. Never charges. */
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
  return peekAuthFailureShard(ip, identity, budget);
}

/** File one refusal of `identity` (null: no credential presented) from `ip`. */
export async function chargeAuthFailure(
  ip: string,
  identity: string | null,
  kind: AuthFailureKind,
  budget: AuthFailureBudget,
): Promise<void> {
  if (kind === "expired") return;
  const { windowSeconds } = budget;
  const chargeEgress = () => countHit(AUTH_FAILURE_EGRESS_SCOPE, ip, windowSeconds);
  if (identity === null) {
    if (kind === "credential") await chargeEgress();
    return;
  }
  const shard = shardId(ip, identity);
  const open = await readHits(AUTH_FAILURE_SHARD_SCOPE, shard, windowSeconds);
  if (open.count === 0) {
    const tally = await readHits(AUTH_FAILURE_SHARD_TALLY_SCOPE, ip, windowSeconds);
    if (tally.count >= AUTH_FAILURE_SHARD_CAP * budget.limit) {
      if (kind === "credential") await chargeEgress();
      return;
    }
  }
  const hit = await countHit(AUTH_FAILURE_SHARD_SCOPE, shard, windowSeconds);
  if (hit.count === 1) await countHit(AUTH_FAILURE_SHARD_TALLY_SCOPE, ip, windowSeconds);
  if (kind === "credential") {
    const ordinal = await countHit(AUTH_FAILURE_CREDENTIAL_SCOPE, shard, windowSeconds);
    if (ordinal.count === 1) await chargeEgress();
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
