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

/** Per-isolate fallback store for one family of keys. `whenFull` is the
 * count reported for a key the store cannot admit: `Infinity` fails CLOSED
 * (right for keys the server chooses — ip, user — whose cardinality is
 * bounded), `0` fails OPEN (required for keys a client chooses — one shard
 * per presented credential — or a flood of made-up credentials could fill
 * the store and fence everyone else out). */
class MemoryWindows {
  private readonly windows = new Map<string, MemoryWindow>();
  private nextExpiryAtMs = Infinity;

  constructor(private readonly whenFull: number) {}

  private hasCapacity(now: number): boolean {
    if (this.windows.size < MEMORY_WINDOW_MAX) return true;
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
    return this.windows.size < MEMORY_WINDOW_MAX;
  }

  incr(key: string, resetAtMs: number): number {
    const now = Date.now();
    const existing = this.windows.get(key);
    if (existing && existing.resetAtMs > now) {
      existing.count += 1;
      return existing.count;
    }
    if (!this.hasCapacity(now)) return this.whenFull;
    this.windows.set(key, { count: 1, resetAtMs });
    this.nextExpiryAtMs = Math.min(this.nextExpiryAtMs, resetAtMs);
    return 1;
  }

  get(key: string): number {
    const now = Date.now();
    const existing = this.windows.get(key);
    if (existing && existing.resetAtMs > now) return existing.count;
    return this.hasCapacity(now) ? 0 : this.whenFull;
  }
}

const windows = new MemoryWindows(Infinity);
const credentialWindows = new MemoryWindows(0);

async function countHit(
  key: string,
  windowSeconds: number,
  resetAtMs: number,
  memory: MemoryWindows,
): Promise<number> {
  const count = redisConfigured() ? await redisWindowIncr(key, windowSeconds) : null;
  return count ?? memory.incr(key, resetAtMs);
}

async function readCount(key: string, memory: MemoryWindows): Promise<number> {
  const count = redisConfigured() ? await redisWindowGet(key) : null;
  return count ?? memory.get(key);
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
  const count = await countHit(key, windowSeconds, (bucket + 1) * windowSeconds * 1_000, windows);
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
  const count = await readCount(key, windows);
  return toResult(count, limit, bucket, windowSeconds, count < limit);
}

// ── Auth-failure budgets ─────────────────────────────────────────────────────
//
// A venue (club Wi-Fi, office, carrier NAT) shares one client IP, so a flat
// per-IP budget charged by every 401 lets one handset lock every peer out of
// sign-in, refresh and reads. Refusals are therefore classified and budgeted
// by the CREDENTIAL that was refused:
//
//   local      — refused before Supabase Auth was consulted (no bearer, junk,
//                expired, wrong issuer). Nothing was guessed; charges nothing.
//   liveness   — Auth recognised a real credential that is merely dead
//                (session logged out, refresh token already rotated, user
//                banned or deleted). A signed-out handset retrying is not an
//                attack: charges only that credential's shard.
//   credential — Auth could not recognise the credential at all (bad
//                signature, unknown refresh token, bad ID token): a guess.
//                Charges the shard AND, once per distinct credential, the
//                egress's stuffing signal.
//
// A shard is `ip + sha256(credential)`: the 31st presentation of one refused
// credential in a window is 429 before Auth, whoever else shares the IP.
// Once the egress's stuffing signal reaches the budget, a credential Auth has
// refused even once is 429 on every replay — but a credential Auth has never
// refused is always judged. A valid session (cached or not, freshly minted
// or rotated) therefore costs a guesser nothing and is never gated by a
// co-tenant; a guesser gets exactly one Auth verdict per distinct credential
// and is otherwise bounded by the pre-auth IP budget and Auth's own limits.

export type AuthRefusalKind = "local" | "liveness" | "credential";

/** Why a 401 happened, attached to the Response in-process (never on the
 * wire). `identity` names the refused credential when it is not the bearer
 * the request presented (refresh judges the token in its body); `null`
 * means no credential was judged. */
export interface AuthRefusal {
  kind: AuthRefusalKind;
  identity?: string | null;
}

export interface AuthFailureBudget {
  limit: number;
  windowSeconds: number;
}

const AUTH_STUFFING_SCOPE = "authfail";
const AUTH_CREDENTIAL_SCOPE = "authfail_cred";

/** GoTrue `error_code`s (also supabase-js AuthError `code`s) that name a real
 * credential Auth recognised and rejected for what happened to it since. */
const LIVENESS_CODES: ReadonlySet<string> = new Set([
  "session_not_found",
  "session_expired",
  "user_not_found",
  "user_banned",
  "refresh_token_already_used",
]);

/** GoTrue messages that only a credential it could verify produces (older
 * GoTrue releases carry no `error_code`; newer ones tag every JWT refusal
 * `bad_jwt`, so the message outranks that code). */
const LIVENESS_MESSAGES: readonly RegExp[] = [
  /session not found/i,
  /session[_ ]id claim in jwt does not exist/i,
  /sub claim in jwt does not exist/i,
  /token is expired/i,
  /session (?:has )?expired/i,
  /already used/i,
  /user (?:is )?banned/i,
  /user not found/i,
];

function stringsOf(record: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string");
}

/** Classify an Auth refusal from its body — GoTrue's `{code, error_code, msg}`
 * / `{error, error_code, error_description}` or a supabase-js AuthError
 * `{code, message, status}`. Anything unrecognised is a guess: the safe
 * default is to count it, never to exempt it. */
export function authRefusalKind(verdict: unknown): AuthRefusalKind {
  if (typeof verdict !== "object" || verdict === null || Array.isArray(verdict)) {
    return "credential";
  }
  const record = verdict as Record<string, unknown>;
  if (stringsOf(record, ["error_code", "code"]).some((code) => LIVENESS_CODES.has(code))) {
    return "liveness";
  }
  const messages = stringsOf(record, ["msg", "message", "error_description"]);
  if (messages.some((message) => LIVENESS_MESSAGES.some((pattern) => pattern.test(message)))) {
    return "liveness";
  }
  return "credential";
}

/** The opaque identity a credential is budgeted under: a SHA-256 digest of
 * its trimmed text, so neither the store nor a log ever holds the credential.
 * `null` when the request presented none. */
export async function authFailureIdentity(
  credential: string | null | undefined,
): Promise<string | null> {
  const trimmed = credential?.trim() ?? "";
  return trimmed ? await sha256Hex(trimmed) : null;
}

const refusals = new WeakMap<Response, AuthRefusal>();

/** Tag a refusal Response with its classification. The tag lives in this
 * isolate only: headers and body are untouched. */
export function authRefusal<R extends Response>(response: R, refusal: AuthRefusal): R {
  refusals.set(response, refusal);
  return response;
}

/** The classification of a refusal Response; an untagged one is a guess. */
export function authRefusalOf(response: Response): AuthRefusal {
  return refusals.get(response) ?? { kind: "credential" };
}

function credentialKey(ip: string, identity: string, windowSeconds: number) {
  return windowKey(AUTH_CREDENTIAL_SCOPE, `${ip}:${identity}`, windowSeconds);
}

/**
 * Gate a request up front by the credential it presents, WITHOUT counting.
 * Not allowed when that credential's own shard is exhausted, or when the
 * egress is under stuffing and this credential has already been refused in
 * the window. A never-refused credential — every valid session — is allowed
 * regardless of what shares its IP.
 */
export async function peekAuthFailureBudget(
  ip: string,
  identity: string | null,
  budget: AuthFailureBudget,
): Promise<RateLimitResult> {
  const { windowSeconds, limit } = budget;
  const egress = windowKey(AUTH_STUFFING_SCOPE, ip, windowSeconds);
  if (identity === null) return toResult(0, limit, egress.bucket, windowSeconds, true);
  const shard = await readCount(credentialKey(ip, identity, windowSeconds).key, credentialWindows);
  if (shard >= limit) return toResult(shard, limit, egress.bucket, windowSeconds, false);
  if (shard >= 1) {
    const stuffing = await readCount(egress.key, windows);
    if (stuffing >= limit) return toResult(stuffing, limit, egress.bucket, windowSeconds, false);
  }
  return toResult(shard, limit, egress.bucket, windowSeconds, true);
}

/**
 * Charge a refusal. `identity` is the credential the request presented;
 * `refusal.identity`, when set, is the credential Auth actually judged (or
 * `null` for none). Atomic INCRs, never read-then-write, so concurrent
 * guesses cannot under-count; a shard's first hit is what raises the
 * egress's stuffing signal, so replays of one credential count once.
 */
export async function chargeAuthFailure(
  ip: string,
  identity: string | null,
  refusal: AuthRefusal,
  budget: AuthFailureBudget,
): Promise<void> {
  if (refusal.kind === "local") return;
  const judged = refusal.identity === undefined ? identity : refusal.identity;
  if (!judged) return;
  const { windowSeconds } = budget;
  const shardKey = credentialKey(ip, judged, windowSeconds);
  const resetAtMs = (shardKey.bucket + 1) * windowSeconds * 1_000;
  const shard = await countHit(shardKey.key, windowSeconds, resetAtMs, credentialWindows);
  if (refusal.kind === "credential" && shard === 1) {
    const egress = windowKey(AUTH_STUFFING_SCOPE, ip, windowSeconds);
    await countHit(egress.key, windowSeconds, resetAtMs, windows);
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
