// Fixed-window rate limiting backed by the layered cache (Upstash Redis when
// configured — a TRUE cross-instance limit — otherwise a per-isolate
// in-memory window, which still stops any single runaway client).
//
// Windows are aligned buckets (floor(now / window)), so a limit of 60/min
// means at most 60 requests inside each clock minute per key. Limits fail
// OPEN on backend errors: a Redis outage must never lock users out.

import { cacheSet, redisConfigured, redisWindowGet, redisWindowIncr, sha256Hex } from "./cache.ts";

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

// ─── Auth-failure budgets behind a shared egress ─────────────────────────────
//
// Many handsets share one client IP (club Wi-Fi, carrier NAT), so a budget
// that counts every 401 against the IP lets one co-tenant — or thirty
// signed-out handsets — lock the rest out. The budget below keeps the flat
// per-egress window (`authfail`, the credential-stuffing signal) but charges
// it only for CREDENTIAL failures: refusals of a credential Supabase Auth
// cannot recognise. A refusal of a credential Auth recognises but that is
// dead — session logged out, refresh token rotated away, user banned or
// deleted — is LIVENESS: it charges only that credential's own shard, so a
// dead session keeps receiving its 401 (the app's sign-out signal) while a
// replay of it is bounded per credential rather than per venue.
//
// A saturated egress therefore holds only never-seen and refused credentials.
// Sessions this edge minted are remembered (the minted registry) and are
// admitted to Auth regardless of the egress, as are credentials Auth already
// judged dead here (liveness marks). Nothing is charged before Auth has
// refused something, so a valid credential is never throttled by an
// auth-FAILURE budget, however many requests present it concurrently.
//
// Storage: shards and liveness marks live in Redis when configured (one
// counter per credential per window) and otherwise in per-bucket count-min
// sketches — fixed memory whatever cardinality an attacker chooses, kept for
// the current and previous buckets so a backward clock step forgets nothing.
// The minted registry is a Redis key per token (TTL = the token's life) with
// a bounded, recency-ordered per-isolate mirror.

/** How Supabase Auth's refusal of a credential is charged:
 *  - `credential`: Auth does not recognise it — a guess, charged to the
 *    egress's stuffing signal and to the credential's own shard;
 *  - `liveness`: Auth recognises it but it is dead — charged to its own
 *    shard only;
 *  - `unknown-token`: Auth answers "refresh token not found", which it says
 *    for a rotated-away token and for a guess alike; settled by whether this
 *    edge minted the token (liveness) or not (credential). */
export type AuthRefusalKind = "credential" | "liveness" | "unknown-token";

declare const CREDENTIAL_IDENTITY: unique symbol;
/** Opaque, namespaced digest of a credential: what shards, marks and the
 * minted registry are keyed by. Never the credential itself. */
export type AuthCredentialIdentity = string & { readonly [CREDENTIAL_IDENTITY]: true };

export interface AuthFailureBudget {
  readonly limit: number;
  readonly windowSeconds: number;
}

/** The tokens of a session this edge minted, as `sessionView` shapes them. */
export interface MintedSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Access-token expiry, unix seconds. */
  readonly expiresAt: number;
}

const AUTH_FAILURE_EGRESS_SCOPE = "authfail";
const AUTH_FAILURE_SHARD_SCOPE = "authshard";
const AUTH_LIVENESS_MARK_PREFIX = "authlive:v1:";
const AUTH_MINTED_PREFIX = "authminted:v1:";
const CREDENTIAL_IDENTITY_NAMESPACE = "authcred:v1:";

/** A refresh token is vouched for while a handset may still hold it: GoTrue
 * refresh tokens have no idle expiry, so a bag-idle handset returns after
 * weeks. A year bounds the registry; a token rotated away keeps only the
 * reuse interval's grace. The access token is vouched for until its exp. */
const MINTED_REFRESH_TTL_SECONDS = 365 * 86_400;
const MINTED_ROTATED_GRACE_SECONDS = 3_600;
const MINTED_MEMORY_MAX = 50_000;
/** Liveness marks outlive the window they were made in by one window. */
const LIVENESS_MARK_WINDOWS = 2;

const LIVENESS_CODES = new Set([
  "session_not_found",
  "session_expired",
  "user_not_found",
  "user_banned",
  "refresh_token_already_used",
]);
const UNKNOWN_TOKEN_CODES = new Set(["refresh_token_not_found"]);
/** GoTrue's message shapes for the codes above, for answers without a code
 * (older GoTrue, `error_description`-only grant answers). */
const LIVENESS_MESSAGE =
  /\bsession\b.*\b(?:does not exist|expired|not found|revoked)|\buser\b.*\b(?:does not exist|banned|not found)|already used|token (?:is|has) expired/i;
const UNKNOWN_TOKEN_MESSAGE = /refresh token not found/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refusalStrings(refusal: unknown): { code: string | null; text: string } {
  if (typeof refusal === "string") return { code: null, text: refusal };
  if (!isRecord(refusal)) return { code: null, text: "" };
  const code =
    [refusal.error_code, refusal.code].find((v): v is string => typeof v === "string") ?? null;
  const text = [refusal.msg, refusal.message, refusal.error_description, refusal.error]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  return { code, text };
}

/** Classify a refusal body / AuthApiError from Supabase Auth. Anything
 * unrecognised is a credential failure — unknown never becomes admission. */
export function authRefusalKind(refusal: unknown): AuthRefusalKind {
  const { code, text } = refusalStrings(refusal);
  if (code !== null && LIVENESS_CODES.has(code)) return "liveness";
  if (code !== null && UNKNOWN_TOKEN_CODES.has(code)) return "unknown-token";
  if (LIVENESS_MESSAGE.test(text)) return "liveness";
  if (UNKNOWN_TOKEN_MESSAGE.test(text)) return "unknown-token";
  return "credential";
}

/** The identity a credential is budgeted under. Whitespace-trimmed and
 * namespaced, so a credential that itself looks like a digest is hashed like
 * any other and can never collide with an identity. */
export async function authCredentialIdentity(credential: string): Promise<AuthCredentialIdentity> {
  const digest = await sha256Hex(`${CREDENTIAL_IDENTITY_NAMESPACE}${credential.trim()}`);
  return digest as AuthCredentialIdentity;
}

// ── Per-bucket count-min sketches (memory fallback for shards and marks) ─────

const SKETCH_WIDTH = 1 << 17;
const SKETCH_DEPTH = 4;
const SKETCH_MAX = 0xffff;
/** The buckets most recently written to (current, previous and one more):
 * a backward clock step re-enters the previous bucket without discarding
 * the current one. */
const SKETCH_BUCKETS_KEPT = 3;

class CountMinSketch {
  private readonly rows = Array.from({ length: SKETCH_DEPTH }, () => new Uint16Array(SKETCH_WIDTH));

  private slot(identity: string, row: number): number {
    const parsed = Number.parseInt(identity.slice(row * 8, row * 8 + 8), 16);
    return (Number.isFinite(parsed) ? parsed : 0) % SKETCH_WIDTH;
  }

  count(identity: string): number {
    let min = SKETCH_MAX;
    for (let row = 0; row < SKETCH_DEPTH; row += 1) {
      min = Math.min(min, this.rows[row][this.slot(identity, row)]);
    }
    return min;
  }

  increment(identity: string): number {
    let min = SKETCH_MAX;
    for (let row = 0; row < SKETCH_DEPTH; row += 1) {
      const slot = this.slot(identity, row);
      const next = Math.min(SKETCH_MAX, this.rows[row][slot] + 1);
      this.rows[row][slot] = next;
      min = Math.min(min, next);
    }
    return min;
  }
}

class BucketedSketches {
  private readonly buckets = new Map<number, CountMinSketch>();

  peek(bucket: number): CountMinSketch | null {
    return this.buckets.get(bucket) ?? null;
  }

  /** The sketch for `bucket`, made most recently written; the least recently
   * written bucket is dropped once more than SKETCH_BUCKETS_KEPT are held. */
  at(bucket: number): CountMinSketch {
    const sketch = this.buckets.get(bucket) ?? new CountMinSketch();
    this.buckets.delete(bucket);
    this.buckets.set(bucket, sketch);
    while (this.buckets.size > SKETCH_BUCKETS_KEPT) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
    return sketch;
  }
}

const shardSketches = new BucketedSketches();
const livenessSketches = new BucketedSketches();

// ── Shards ───────────────────────────────────────────────────────────────────

async function shardCount(
  identity: AuthCredentialIdentity,
  budget: AuthFailureBudget,
): Promise<{ count: number; bucket: number }> {
  const { bucket, key } = windowKey(AUTH_FAILURE_SHARD_SCOPE, identity, budget.windowSeconds);
  let count: number | null = null;
  if (redisConfigured()) count = await redisWindowGet(key);
  if (count === null) count = shardSketches.peek(bucket)?.count(identity) ?? 0;
  return { count, bucket };
}

async function shardIncr(
  identity: AuthCredentialIdentity,
  budget: AuthFailureBudget,
): Promise<void> {
  const { bucket, key } = windowKey(AUTH_FAILURE_SHARD_SCOPE, identity, budget.windowSeconds);
  let count: number | null = null;
  if (redisConfigured()) count = await redisWindowIncr(key, budget.windowSeconds);
  if (count === null) shardSketches.at(bucket).increment(identity);
}

// ── Liveness marks ───────────────────────────────────────────────────────────

async function livenessMarked(
  identity: AuthCredentialIdentity,
  budget: AuthFailureBudget,
): Promise<boolean> {
  if (redisConfigured()) {
    const count = await redisWindowGet(`${AUTH_LIVENESS_MARK_PREFIX}${identity}`);
    if (count !== null) return count > 0;
  }
  const { bucket } = windowKey(AUTH_FAILURE_SHARD_SCOPE, identity, budget.windowSeconds);
  for (let back = 0; back < LIVENESS_MARK_WINDOWS; back += 1) {
    if ((livenessSketches.peek(bucket - back)?.count(identity) ?? 0) > 0) return true;
  }
  return false;
}

async function livenessMark(
  identity: AuthCredentialIdentity,
  budget: AuthFailureBudget,
): Promise<void> {
  let count: number | null = null;
  if (redisConfigured()) {
    count = await redisWindowIncr(
      `${AUTH_LIVENESS_MARK_PREFIX}${identity}`,
      budget.windowSeconds * LIVENESS_MARK_WINDOWS,
    );
  }
  if (count === null) {
    const { bucket } = windowKey(AUTH_FAILURE_SHARD_SCOPE, identity, budget.windowSeconds);
    livenessSketches.at(bucket).increment(identity);
  }
}

// ── Minted registry ──────────────────────────────────────────────────────────

/** identity → vouched-until (ms). Recency-ordered: a lookup re-inserts, so
 * sessions in use survive the bound and only idle ones are forgotten. */
const mintedMemory = new Map<string, number>();

function mintedMemoryHas(identity: AuthCredentialIdentity): boolean {
  const until = mintedMemory.get(identity);
  if (until === undefined) return false;
  mintedMemory.delete(identity);
  if (until <= Date.now()) return false;
  mintedMemory.set(identity, until);
  return true;
}

function mintedMemorySet(identity: AuthCredentialIdentity, untilMs: number): void {
  mintedMemory.delete(identity);
  if (untilMs <= Date.now()) return;
  while (mintedMemory.size >= MINTED_MEMORY_MAX) {
    const oldest = mintedMemory.keys().next();
    if (oldest.done) break;
    mintedMemory.delete(oldest.value);
  }
  mintedMemory.set(identity, untilMs);
}

async function mintedHas(identity: AuthCredentialIdentity): Promise<boolean> {
  if (mintedMemoryHas(identity)) return true;
  if (!redisConfigured()) return false;
  const count = await redisWindowGet(`${AUTH_MINTED_PREFIX}${identity}`);
  return count !== null && count > 0;
}

async function mintedAdd(identity: AuthCredentialIdentity, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return;
  mintedMemorySet(identity, Date.now() + ttlSeconds * 1_000);
  if (redisConfigured()) {
    await redisWindowIncr(`${AUTH_MINTED_PREFIX}${identity}`, Math.ceil(ttlSeconds));
  }
}

/** Shorten a vouched token's life to the grace window (never lengthen it). */
async function mintedExpireWithin(
  identity: AuthCredentialIdentity,
  ttlSeconds: number,
): Promise<void> {
  const untilMs = Date.now() + ttlSeconds * 1_000;
  const current = mintedMemory.get(identity);
  mintedMemorySet(identity, current === undefined ? untilMs : Math.min(current, untilMs));
  if (redisConfigured()) {
    await cacheSet(`${AUTH_MINTED_PREFIX}${identity}`, "1", Math.ceil(ttlSeconds));
  }
}

/** Remember a session this edge minted (bootstrap or refresh): its access
 * token until `expiresAt`, its refresh token for a year of idleness. Pass
 * `rotatedFrom` (the refresh token just spent) so that token stays vouched
 * for only the reuse-interval grace. */
export async function noteMintedSession(
  session: MintedSession,
  rotatedFrom?: string,
): Promise<void> {
  const [bearer, refresh] = await Promise.all([
    authCredentialIdentity(session.accessToken),
    authCredentialIdentity(session.refreshToken),
  ]);
  const bearerTtl = Math.floor(session.expiresAt - Date.now() / 1_000);
  await mintedAdd(bearer, Math.min(bearerTtl, MINTED_REFRESH_TTL_SECONDS));
  await mintedAdd(refresh, MINTED_REFRESH_TTL_SECONDS);
  if (rotatedFrom !== undefined && rotatedFrom.trim() !== "") {
    await mintedExpireWithin(
      await authCredentialIdentity(rotatedFrom),
      MINTED_ROTATED_GRACE_SECONDS,
    );
  }
}

// ── The budget ───────────────────────────────────────────────────────────────

/**
 * Gate a credential BEFORE Supabase Auth is asked about it, without counting
 * anything. Held (`allowed === false`) when the credential's own shard is
 * spent, or when its egress's stuffing signal is spent and the credential is
 * neither a session this edge minted nor one Auth already judged dead here.
 * `remaining` is the tightest consulted gate; `retryAfterSeconds` ends the
 * current window.
 */
export async function peekAuthFailureBudget(
  egress: string,
  identity: AuthCredentialIdentity,
  budget: AuthFailureBudget,
): Promise<RateLimitResult> {
  const shard = await shardCount(identity, budget);
  const own = toResult(
    shard.count,
    budget.limit,
    shard.bucket,
    budget.windowSeconds,
    shard.count < budget.limit,
  );
  if (!own.allowed) return own;
  const stuffing = await peekRateLimit(
    AUTH_FAILURE_EGRESS_SCOPE,
    egress,
    budget.limit,
    budget.windowSeconds,
  );
  if (stuffing.allowed) {
    return { ...own, remaining: Math.min(own.remaining, stuffing.remaining) };
  }
  if ((await mintedHas(identity)) || (await livenessMarked(identity, budget))) return own;
  return stuffing;
}

/**
 * Charge Supabase Auth's refusal of `identity` presented from `egress`.
 * Returns the kind actually charged: `unknown-token` settles to `liveness`
 * when this edge minted the token and to `credential` otherwise.
 */
export async function chargeAuthFailure(
  egress: string,
  identity: AuthCredentialIdentity,
  kind: AuthRefusalKind,
  budget: AuthFailureBudget,
): Promise<"credential" | "liveness"> {
  const settled: "credential" | "liveness" =
    kind === "unknown-token" ? ((await mintedHas(identity)) ? "liveness" : "credential") : kind;
  await shardIncr(identity, budget);
  if (settled === "liveness") {
    await livenessMark(identity, budget);
  } else {
    await enforceRateLimit(AUTH_FAILURE_EGRESS_SCOPE, egress, budget.limit, budget.windowSeconds);
  }
  return settled;
}
