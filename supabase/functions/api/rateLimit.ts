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
  const { bucket, key } = windowKey(scope, id, windowSeconds);
  let count: number | null = null;
  if (redisConfigured()) {
    count = await redisWindowIncr(key, windowSeconds);
  }
  if (count === null) {
    count = memoryIncr(key, (bucket + 1) * windowSeconds * 1_000);
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

// ─── Auth-failure budgets behind a shared egress ─────────────────────────────
//
// Behind carrier NAT or club Wi-Fi one client IP is a whole venue, so the
// per-IP auth-failure budget ("authfail", the stuffing budget) is charged
// only by what is actually stuffing signal: a credential Supabase Auth
// REFUSED, once per credential. Everything else is accounted in shards of
// the same window keyed by IP + presented credential:
//
//   credential  Auth refused a credential it had never accepted (bad
//               signature, unknown refresh token, bad ID token). Charges
//               the credential's shard on every refusal and the stuffing
//               budget on the FIRST refusal only — replaying one forged
//               token throttles that token, distinct guesses close the egress.
//   liveness    Auth refused a real credential that is no longer live
//               (signed out, expired upstream, banned). Nothing was guessed:
//               charges the credential's shard only.
//   local       Refused here without consulting Auth (no bearer, non-JWT,
//               unknown issuer, a token past its own `exp`). No guess was
//               checked upstream, so it never touches the stuffing budget.
//               An ANONYMOUS presentation (nothing this route accepts as
//               its own credential) charges the egress's anonymous shard,
//               which gates only anonymous presentations from that egress —
//               junk throttles junk, never a signed-in peer's session bearer,
//               a handset whose own token merely expired, a sign-in or a
//               refresh. A local refusal of a route credential charges nothing.
//
// A spent shard answers 429 exactly like the stuffing budget. Shards per
// egress window stay bounded: at most `limit` credential shards can open
// before the stuffing budget closes the egress, plus one anonymous shard.

export type AuthFailureKind = "credential" | "liveness" | "local";

export interface AuthFailureBudget {
  limit: number;
  windowSeconds: number;
}

/** How an auth refusal is charged. `identity` overrides the credential the
 * request presented (a refresh charges its refresh token, not its bearer). */
export interface AuthRefusal {
  kind: AuthFailureKind;
  identity?: string | null;
}

/** What a request presented, decided before authentication: the hashed
 * credential (null when none) and whether it is ANONYMOUS for its route —
 * not a session token of this API on a session route. Bootstrap's ID token
 * and refresh's refresh token are their routes' own credentials. */
export interface AuthPresentation {
  identity: string | null;
  anonymous: boolean;
}

const AUTH_FAILURE_EGRESS_SCOPE = "authfail";
const AUTH_FAILURE_SHARD_SCOPE = "authfail_id";
const AUTH_FAILURE_ANONYMOUS_IDENTITY = "anon";
const AUTH_REFUSAL_KIND_HEADER = "X-Auth-Refusal-Kind";
const AUTH_REFUSAL_IDENTITY_HEADER = "X-Auth-Refusal-Identity";

/** GoTrue error codes that mean "this credential WAS real and is no longer
 * live" — a liveness 401, not a guess. Unknown codes stay `credential`. */
const LIVENESS_ERROR_CODES: ReadonlySet<string> = new Set([
  "session_not_found",
  "session_expired",
  "user_not_found",
  "user_banned",
  "refresh_token_already_used",
]);

const AUTH_FAILURE_KINDS: ReadonlySet<string> = new Set<AuthFailureKind>([
  "credential",
  "liveness",
  "local",
]);

export function authRefusalKind(errorCode: string | null | undefined): AuthFailureKind {
  return errorCode && LIVENESS_ERROR_CODES.has(errorCode) ? "liveness" : "credential";
}

/** Shard identity of a presented credential: a truncated SHA-256 so the raw
 * token never becomes a cache key. Null when nothing was presented. */
export async function authFailureIdentity(credential: string): Promise<string | null> {
  const trimmed = credential.trim();
  if (!trimmed) return null;
  return (await sha256Hex(trimmed)).slice(0, 32);
}

/** Tag a refusal response with how it must be charged. The headers are read
 * back by `authRefusalOf` in the router and never leave the function: the
 * caller strips them when it returns the response. */
export function authRefusal(response: Response, refusal: AuthRefusal): Response {
  response.headers.set(AUTH_REFUSAL_KIND_HEADER, refusal.kind);
  if (refusal.identity !== undefined) {
    response.headers.set(AUTH_REFUSAL_IDENTITY_HEADER, refusal.identity ?? "");
  }
  return response;
}

/** Read (and strip) a refusal tag. An untagged refusal is a credential
 * refusal charged to the credential the request presented — the
 * conservative default for any refusal path that was not classified. */
export function authRefusalOf(response: Response): AuthRefusal {
  const kind = response.headers.get(AUTH_REFUSAL_KIND_HEADER);
  const identity = response.headers.get(AUTH_REFUSAL_IDENTITY_HEADER);
  response.headers.delete(AUTH_REFUSAL_KIND_HEADER);
  response.headers.delete(AUTH_REFUSAL_IDENTITY_HEADER);
  const refusal: AuthRefusal = {
    kind: kind && AUTH_FAILURE_KINDS.has(kind) ? (kind as AuthFailureKind) : "credential",
  };
  if (identity !== null) refusal.identity = identity || null;
  return refusal;
}

const shardId = (ip: string, identity: string) => `${ip}:${identity}`;

/** Peek one credential's shard (never charges). Null identity → allowed. */
export async function peekAuthFailureShard(
  ip: string,
  identity: string | null,
  budget: AuthFailureBudget,
): Promise<RateLimitResult> {
  const { bucket } = windowKey(AUTH_FAILURE_SHARD_SCOPE, ip, budget.windowSeconds);
  if (identity === null) return toResult(0, budget.limit, bucket, budget.windowSeconds, true);
  return peekRateLimit(
    AUTH_FAILURE_SHARD_SCOPE,
    shardId(ip, identity),
    budget.limit,
    budget.windowSeconds,
  );
}

/** Pre-auth gate for what a request presented (never charges): an anonymous
 * presentation is gated by the egress's anonymous shard, every credential by
 * its own shard. The egress-wide stuffing budget is peeked separately. */
export async function peekAuthFailureBudget(
  ip: string,
  presented: AuthPresentation,
  budget: AuthFailureBudget,
): Promise<RateLimitResult> {
  if (presented.anonymous) {
    const anonymous = await peekAuthFailureShard(ip, AUTH_FAILURE_ANONYMOUS_IDENTITY, budget);
    if (!anonymous.allowed) return anonymous;
  }
  return peekAuthFailureShard(ip, presented.identity, budget);
}

/** One atomic hit on a window; the count after the hit. */
async function countHit(scope: string, id: string, windowSeconds: number): Promise<number> {
  const { bucket, key } = windowKey(scope, id, windowSeconds);
  let count: number | null = null;
  if (redisConfigured()) {
    count = await redisWindowIncr(key, windowSeconds);
  }
  if (count === null) {
    count = memoryIncr(key, (bucket + 1) * windowSeconds * 1_000);
  }
  return count;
}

/** Charge one auth refusal of `presented` (atomic INCRs, never a
 * read-then-write). `refusal.identity`, when set, is the credential the
 * route actually judged and replaces the presented one. */
export async function chargeAuthFailure(
  ip: string,
  presented: AuthPresentation,
  refusal: AuthRefusal,
  budget: AuthFailureBudget,
): Promise<void> {
  const identity = refusal.identity === undefined ? presented.identity : refusal.identity;
  const chargeShard = (id: string) =>
    countHit(AUTH_FAILURE_SHARD_SCOPE, shardId(ip, id), budget.windowSeconds);
  const chargeEgress = () => countHit(AUTH_FAILURE_EGRESS_SCOPE, ip, budget.windowSeconds);
  switch (refusal.kind) {
    case "local":
      if (presented.anonymous) await chargeShard(AUTH_FAILURE_ANONYMOUS_IDENTITY);
      return;
    case "liveness":
      if (identity !== null) await chargeShard(identity);
      return;
    case "credential": {
      if (identity === null) {
        await chargeEgress();
        return;
      }
      // The first refusal of a credential in this window is its one distinct
      // guess against the egress; replays only deepen the credential's shard.
      if ((await chargeShard(identity)) === 1) await chargeEgress();
      return;
    }
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
