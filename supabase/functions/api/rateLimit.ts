// Fixed-window rate limiting backed by the layered cache (Upstash Redis when
// configured — a TRUE cross-instance limit — otherwise a per-isolate
// in-memory window, which still stops any single runaway client).
//
// Windows are aligned buckets (floor(now / window)), so a limit of 60/min
// means at most 60 requests inside each clock minute per key. Limits fail
// OPEN on backend errors: a Redis outage must never lock users out.

import {
  cacheGet,
  cacheSet,
  redisConfigured,
  redisWindowGet,
  redisWindowIncr,
  sha256Hex,
} from "./cache.ts";

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

/** A bounded table of live fixed windows. `incr`/`get` answer null when the
 * key is absent and the table is full of unexpired windows — the caller
 * decides what "unknown" means for its budget. */
class MemoryWindows {
  private readonly windows = new Map<string, MemoryWindow>();
  private nextExpiryAtMs = Infinity;

  constructor(private readonly max: number) {}

  private hasCapacity(now: number): boolean {
    if (this.windows.size < this.max) return true;
    if (now >= this.nextExpiryAtMs) {
      this.nextExpiryAtMs = Infinity;
      for (const [key, window] of this.windows) {
        if (window.resetAtMs <= now) {
          this.windows.delete(key);
        } else {
          this.nextExpiryAtMs = Math.min(this.nextExpiryAtMs, window.resetAtMs);
        }
      }
    }
    return this.windows.size < this.max;
  }

  incr(key: string, resetAtMs: number): number | null {
    const now = Date.now();
    const existing = this.windows.get(key);
    if (existing && existing.resetAtMs > now) {
      existing.count += 1;
      return existing.count;
    }
    if (!this.hasCapacity(now)) return null;
    this.windows.set(key, { count: 1, resetAtMs });
    this.nextExpiryAtMs = Math.min(this.nextExpiryAtMs, resetAtMs);
    return 1;
  }

  get(key: string): number | null {
    const now = Date.now();
    const existing = this.windows.get(key);
    if (existing && existing.resetAtMs > now) return existing.count;
    return this.hasCapacity(now) ? 0 : null;
  }
}

const windows = new MemoryWindows(MEMORY_WINDOW_MAX);

function memoryIncr(key: string, resetAtMs: number): number {
  return windows.incr(key, resetAtMs) ?? Infinity;
}

function memoryGet(key: string): number {
  return windows.get(key) ?? Infinity;
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
// Venues, offices and carrier NATs put many handsets behind ONE client IP, so
// a flat per-IP count of every 401 lets one junk-token flood — or thirty
// signed-out handsets — lock the whole address out for the window. The budget
// is therefore split by what the refusal was:
//
//   local       refused here, before Supabase Auth (no bearer, malformed,
//               expired): nothing upstream was spent, nothing is charged.
//   liveness    Auth judged a REAL credential that is no longer live
//               (session_not_found, session_expired, user_not_found,
//               user_banned, refresh_token_already_used): a signed-out handset
//               retrying is not an attack. The credential is remembered as
//               dead for the window — later presentations are answered 401
//               here without another upstream call — and vouched as real.
//   credential  Auth refused something it never issued (bad_jwt, bad_id_token,
//               …): a guess. It charges its own shard (this address ×
//               this credential) and, the first time in the window, the
//               address's stuffing signal, which counts DISTINCT refused
//               guesses.
//   not_found   GoTrue's refresh_token_not_found: a signed-out session's
//               token (its rows cascade away on logout) and a forged one look
//               identical upstream, so provenance decides — a refresh token
//               this edge minted is liveness, one nothing here minted is a
//               guess.
//
// The pre-auth gate (`peekAuthFailureBudget`) refuses, before Auth is asked:
//   - a credential whose shard already holds `limit` refusals (replay);
//   - once the address's stuffing signal reaches `limit`, any credential
//     nothing here has VOUCHED for — vouched means minted by this edge
//     (bootstrap/refresh sessions), verified by Auth, or judged dead by Auth.
// So a co-tenant's flood spends at most `limit` upstream verdicts per window,
// while established peers keep refreshing and signing in and a dead handset
// keeps hearing 401 — the app's only sign-out signal. A NEVER-seen credential
// (a fresh sign-in) from a stuffed address is deferred with 429 + Retry-After
// (retryable) until the window turns; that deferral is the price of bounding
// forged novelty upstream.
//
// Shard keys are attacker-cardinality, so they live in their own bounded
// table and in Redis with the window's TTL; when a shard cannot be admitted
// the refusal is charged to the stuffing signal instead (fails CLOSED on the
// address, never open). Only SHA-256 identities of credentials are keyed or
// stored — never a token.

export type AuthRefusalKind = "local" | "liveness" | "not_found" | "credential";

export interface AuthRefusal {
  kind: AuthRefusalKind;
  /** The credential Auth judged when it is not the bearer (a refresh judges
   * the refresh token in the body). `null` means nothing to charge. */
  identity?: string | null;
}

export interface AuthFailureBudget {
  limit: number;
  windowSeconds: number;
}

const AUTH_SHARD_SCOPE = "authcred";
const AUTH_STUFFING_SCOPE = "authfail";
const AUTH_SHARD_MAX = 20_000;
const shards = new MemoryWindows(AUTH_SHARD_MAX);

/** How long a credential Auth verified or judged dead stays vouched. */
export const AUTH_VOUCH_JUDGED_TTL_SECONDS = 60 * 60;
/** How long a refresh token this edge minted stays vouched: a handset that
 * has not refreshed for longer re-enters as an unknown credential. */
export const AUTH_VOUCH_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
const AUTH_VOUCH_MIN_TTL_SECONDS = 60;
const AUTH_VOUCH_SLACK_SECONDS = 5 * 60;

const LIVENESS_ERROR_CODES = new Set([
  "session_not_found",
  "session_expired",
  "user_not_found",
  "user_banned",
  "refresh_token_already_used",
]);
const NOT_FOUND_ERROR_CODES = new Set(["refresh_token_not_found"]);
const LIVENESS_MESSAGES = [
  /session (?:from session_id claim in jwt )?does not exist/i,
  /session (?:has )?expired/i,
  /already used/i,
  /user (?:from sub claim in jwt )?does not exist/i,
  /is banned/i,
];
const NOT_FOUND_MESSAGES = [/refresh token not found/i];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function stringField(record: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** Classify a GoTrue refusal body (`/auth/v1/user`, `/auth/v1/token`). Codes
 * decide; older bodies that carry only a message are matched on it. Anything
 * unrecognised is a guess. */
export function authRefusalKind(body: unknown): AuthRefusalKind {
  if (!isRecord(body)) return "credential";
  const code = stringField(body, "error_code", "code");
  if (LIVENESS_ERROR_CODES.has(code)) return "liveness";
  if (NOT_FOUND_ERROR_CODES.has(code)) return "not_found";
  if (code) return "credential";
  const message = stringField(body, "msg", "message", "error_description");
  if (LIVENESS_MESSAGES.some((pattern) => pattern.test(message))) return "liveness";
  if (NOT_FOUND_MESSAGES.some((pattern) => pattern.test(message))) return "not_found";
  return "credential";
}

/** Classify a supabase-js AuthError (`code` is GoTrue's error_code). */
export function authErrorRefusalKind(error: unknown): AuthRefusalKind {
  if (!isRecord(error)) return "credential";
  return authRefusalKind({
    error_code: typeof error.code === "string" ? error.code : "",
    msg: typeof error.message === "string" ? error.message : "",
  });
}

/** The budget identity of a credential: its SHA-256, never the credential. */
export async function authFailureIdentity(
  credential: string | null | undefined,
): Promise<string | null> {
  if (typeof credential !== "string") return null;
  const trimmed = credential.trim();
  if (!trimmed) return null;
  return await sha256Hex(trimmed);
}

const refusals = new WeakMap<Response, AuthRefusal>();

/** Tag a refusal response with how it was judged, for the outer charge. */
export function authRefusal<R extends Response>(response: R, refusal: AuthRefusal): R {
  refusals.set(response, refusal);
  return response;
}

/** How a refusal response was judged; untagged refusals never reached Auth. */
export function authRefusalOf(response: Response): AuthRefusal {
  return refusals.get(response) ?? { kind: "local" };
}

const vouchKey = (identity: string) => `rl:authvouch:${identity}`;
const deadKey = (identity: string) => `rl:authdead:${identity}`;

async function markerSet(key: string, ttlSeconds: number): Promise<void> {
  await cacheSet(key, "1", ttlSeconds);
}

async function markerPresent(key: string): Promise<boolean> {
  return (await cacheGet(key)) !== null;
}

/** Vouch TTL for a credential that expires at `expiresAtUnix` (seconds). */
export function authVouchTtlSeconds(expiresAtUnix: unknown): number {
  if (typeof expiresAtUnix !== "number" || !Number.isFinite(expiresAtUnix)) {
    return AUTH_VOUCH_JUDGED_TTL_SECONDS;
  }
  const remaining = expiresAtUnix - Date.now() / 1_000 + AUTH_VOUCH_SLACK_SECONDS;
  return Math.max(
    AUTH_VOUCH_MIN_TTL_SECONDS,
    Math.min(AUTH_VOUCH_REFRESH_TTL_SECONDS, Math.ceil(remaining)),
  );
}

/** Remember that Auth verified `credential` (or minted it here). */
export async function vouchAuthCredential(credential: string, ttlSeconds: number): Promise<void> {
  const identity = await authFailureIdentity(credential);
  if (identity === null) return;
  await markerSet(vouchKey(identity), ttlSeconds);
}

/** Vouch both halves of a session this edge just minted (bootstrap or
 * refresh): the access token until it expires, the refresh token for as long
 * as a handset may stay closed before it reappears. */
export async function vouchAuthSession(session: {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
}): Promise<void> {
  const expiresAt =
    typeof session.expires_at === "number"
      ? session.expires_at
      : typeof session.expires_in === "number"
        ? Date.now() / 1_000 + session.expires_in
        : undefined;
  await Promise.all([
    vouchAuthCredential(session.access_token, authVouchTtlSeconds(expiresAt)),
    vouchAuthCredential(session.refresh_token, AUTH_VOUCH_REFRESH_TTL_SECONDS),
  ]);
}

/** True once Auth judged `credential` dead within the current window: the
 * caller answers 401 itself instead of asking Auth again. */
export async function authCredentialDead(credential: string | null | undefined): Promise<boolean> {
  const identity = await authFailureIdentity(credential);
  return identity !== null && (await markerPresent(deadKey(identity)));
}

async function shardIncr(key: string, resetAtMs: number, windowSeconds: number) {
  if (redisConfigured()) {
    const count = await redisWindowIncr(key, windowSeconds);
    if (count !== null) return count;
  }
  return shards.incr(key, resetAtMs);
}

async function shardGet(key: string): Promise<number | null> {
  if (redisConfigured()) {
    const count = await redisWindowGet(key);
    if (count !== null) return count;
  }
  return shards.get(key);
}

/** The address's stuffing signal without counting a hit. */
export function peekAuthStuffing(ip: string, budget: AuthFailureBudget): Promise<RateLimitResult> {
  return peekRateLimit(AUTH_STUFFING_SCOPE, ip, budget.limit, budget.windowSeconds);
}

/**
 * Pre-auth gate for `identity` (the SHA-256 of the credential about to be
 * judged; null when the request carries none — a local refusal follows and
 * costs nothing upstream) presented from `ip`. Refuses a replayed credential
 * whose shard is exhausted and, once the address is under stuffing, every
 * credential nothing here has vouched for. A credential Auth already judged
 * dead this window is always let through — it is answered 401 locally.
 */
export async function peekAuthFailureBudget(
  ip: string,
  identity: string | null,
  budget: AuthFailureBudget,
): Promise<RateLimitResult> {
  const { bucket } = windowKey(AUTH_STUFFING_SCOPE, ip, budget.windowSeconds);
  const allow = (count: number) =>
    toResult(count, budget.limit, bucket, budget.windowSeconds, true);
  if (identity === null) return allow(0);
  const { key: shardKey } = windowKey(AUTH_SHARD_SCOPE, `${ip}:${identity}`, budget.windowSeconds);
  const [shard, stuffing] = await Promise.all([shardGet(shardKey), peekAuthStuffing(ip, budget)]);
  const replays = shard ?? 0;
  if (replays < budget.limit && stuffing.allowed) return allow(replays);
  if (await markerPresent(deadKey(identity))) return allow(replays);
  if (replays >= budget.limit) {
    return toResult(replays, budget.limit, bucket, budget.windowSeconds, false);
  }
  if (await markerPresent(vouchKey(identity))) return allow(replays);
  return stuffing;
}

/**
 * Charge one refusal of `identity` (or of `refusal.identity` when the
 * refusal names the credential it judged) presented from `ip`. Atomic
 * increments only — never read-then-write — so concurrent refusals cannot
 * under-count.
 */
export async function chargeAuthFailure(
  ip: string,
  identity: string | null,
  refusal: AuthRefusal,
  budget: AuthFailureBudget,
): Promise<void> {
  const target = refusal.identity === undefined ? identity : refusal.identity;
  if (refusal.kind === "local" || target === null) return;
  let kind = refusal.kind;
  let vouched: boolean | null = null;
  if (kind === "not_found") {
    vouched = await markerPresent(vouchKey(target));
    kind = vouched ? "liveness" : "credential";
  }
  if (kind === "liveness") {
    vouched ??= await markerPresent(vouchKey(target));
    await Promise.all([
      markerSet(deadKey(target), budget.windowSeconds),
      vouched ? Promise.resolve() : markerSet(vouchKey(target), AUTH_VOUCH_JUDGED_TTL_SECONDS),
    ]);
    return;
  }
  const { bucket, key: shardKey } = windowKey(
    AUTH_SHARD_SCOPE,
    `${ip}:${target}`,
    budget.windowSeconds,
  );
  const shard = await shardIncr(
    shardKey,
    (bucket + 1) * budget.windowSeconds * 1_000,
    budget.windowSeconds,
  );
  if (shard === null || shard === 1) {
    await enforceRateLimit(AUTH_STUFFING_SCOPE, ip, budget.limit, budget.windowSeconds);
  }
}
