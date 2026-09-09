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

/** One per-isolate window store. `whenFull` is what a key that cannot be
 * admitted counts as: `Infinity` fails CLOSED (a runaway client can never
 * evict its own limit by flooding keys), `0` fails OPEN (a store whose
 * cardinality an attacker controls must not fence bystanders). */
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

  incr(key: string, resetAtMs: number, now = Date.now()): number {
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

  get(key: string, now = Date.now()): number {
    return this.peek(key, now) ?? (this.hasCapacity(now) ? 0 : this.whenFull);
  }

  /** The live count of a key this isolate has written, else null. */
  peek(key: string, now = Date.now()): number | null {
    const existing = this.windows.get(key);
    return existing && existing.resetAtMs > now ? existing.count : null;
  }
}

const windows = new MemoryWindows(Infinity);

function memoryIncr(key: string, resetAtMs: number): number {
  return windows.incr(key, resetAtMs);
}

function memoryGet(key: string): number {
  return windows.get(key);
}

function windowKey(scope: string, id: string, windowSeconds: number, nowMs = Date.now()) {
  const bucket = Math.floor(nowMs / (windowSeconds * 1_000));
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

// ── Auth-failure budgets behind a shared egress ─────────────────────────────
//
// A venue (office, club, carrier NAT) is ONE client IP. A flat per-IP
// auth-failure counter charged by every 401 lets a single handset — junk
// bearers, an expired token retried, thirty guesses — lock every valid peer
// behind that IP out of reads, refresh and sign-in for a whole window. The
// budget is therefore kept per CREDENTIAL (ip + sha256(credential), the
// "shard") and refusals are classified:
//
//   local      — the request never reached Supabase Auth (no bearer, junk,
//                expired, wrong issuer, a capability on a session route).
//                Nothing was guessed. Charges nothing.
//   liveness   — Auth judged a REAL credential that is merely dead (signed
//                out elsewhere, session expired server-side, account gone,
//                refresh token already rotated). Charges its shard only.
//   credential — Auth judged a guess (bad signature, unknown refresh token,
//                bad ID token). Charges its shard and, the first time a
//                distinct credential is refused in the window, the egress's
//                stuffing signal (`authfail`, one hit per distinct guess).
//
// A credential whose shard reached the budget is 429 before Auth — that
// credential alone (`peekAuthFailureBudget`). Once the egress's stuffing
// signal reaches the budget the egress is "under stuffing"
// (`peekAuthStuffing`): a credential that was ALREADY refused this window
// is 429 on its next presentation (replay tolerance drops to zero), and a
// further distinct guess Auth refuses is answered 429 instead of 401
// (`chargeAuthFailure` reports it), so the guessing handset is throttled
// exactly as by the flat per-IP budget of old. A credential nothing has
// refused always reaches Auth: a novel guess cannot be told from a valid
// peer's first request — the session bootstrap just minted, the token
// refresh just rotated, a session whose auth-cache entry expired — and
// letting Auth judge a valid session costs the attacker nothing. That is
// what keeps a venue online behind one egress however hard it is stuffed;
// refresh and bootstrap carry their own tight per-IP route budgets.
//
// Shards are keyed by the presenting client, so their cardinality is
// attacker-controlled: they live in their own per-isolate store that fails
// OPEN when full (a flood of distinct guesses can never fence bystanders),
// separate from the store whose keys the server chooses.

export type AuthRefusalKind = "local" | "liveness" | "credential";

export interface AuthRefusal {
  kind: AuthRefusalKind;
  /** Shard the refusal belongs to when it is not the presented bearer's
   * (a refresh judges the token in the body); `null` = no shard. */
  identity?: string | null;
}

export interface AuthFailureBudget {
  limit: number;
  windowSeconds: number;
}

const AUTH_SHARD_SCOPE = "authfail_id";
const AUTH_EGRESS_SCOPE = "authfail";
const shardWindows = new MemoryWindows(0);

/** GoTrue `error_code`s meaning "this real credential is no longer live". */
const LIVENESS_ERROR_CODES = new Set([
  "session_not_found",
  "session_expired",
  "user_not_found",
  "user_banned",
  "refresh_token_already_used",
]);
/** The same conditions as older GoTrue bodies phrase them (`{code, msg}`
 * or `{error, error_description}` without `error_code`). */
const LIVENESS_MESSAGES = [
  /session from session_id claim in jwt does not exist/i,
  /user from sub claim in jwt does not exist/i,
  /refresh token:? already used/i,
  /user is banned/i,
  /session (?:has )?expired/i,
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Classify a refusal the Supabase client reported (`AuthError`: `code` is
 * GoTrue's `error_code`, `message` its `msg`). Anything unrecognised is a
 * guess. */
export function authErrorRefusalKind(error: unknown): AuthRefusalKind {
  if (!isRecord(error)) return "credential";
  return authRefusalKind({ error_code: error.code, msg: error.message });
}

/** Classify an Auth refusal body. Anything unrecognised is a guess. */
export function authRefusalKind(body: unknown): AuthRefusalKind {
  if (!isRecord(body)) return "credential";
  if (typeof body.error_code === "string") {
    return LIVENESS_ERROR_CODES.has(body.error_code) ? "liveness" : "credential";
  }
  for (const field of ["msg", "error_description", "message"]) {
    const text = body[field];
    if (typeof text === "string" && LIVENESS_MESSAGES.some((pattern) => pattern.test(text))) {
      return "liveness";
    }
  }
  return "credential";
}

/** Opaque shard id of a presented credential; `null` when there is none. */
export async function authFailureIdentity(
  credential: string | null | undefined,
): Promise<string | null> {
  if (typeof credential !== "string" || credential.trim() === "") return null;
  return await sha256Hex(credential);
}

const refusals = new WeakMap<Response, AuthRefusal>();

/** Tag a refusal response with how it should be charged. The tag rides
 * the Response object in-process only — nothing is added to the wire. */
export function authRefusal<R extends Response>(response: R, refusal: AuthRefusal): R {
  refusals.set(response, refusal);
  return response;
}

/** The tag of a refusal response; an untagged refusal is a guess. */
export function authRefusalOf(response: Response): AuthRefusal {
  return refusals.get(response) ?? { kind: "credential" };
}

type WindowStore = "redis" | "memory";

async function incrWindow(
  scope: string,
  id: string,
  windowSeconds: number,
  nowMs: number,
  memory: MemoryWindows,
  store: WindowStore,
): Promise<{ count: number; store: WindowStore }> {
  const { bucket, key } = windowKey(scope, id, windowSeconds, nowMs);
  if (store === "redis") {
    const count = await redisWindowIncr(key, windowSeconds);
    if (count !== null) return { count, store: "redis" };
  }
  return {
    count: memory.incr(key, (bucket + 1) * windowSeconds * 1_000, nowMs),
    store: "memory",
  };
}

async function getWindow(
  scope: string,
  id: string,
  windowSeconds: number,
  nowMs: number,
  memory: MemoryWindows,
): Promise<number> {
  const { key } = windowKey(scope, id, windowSeconds, nowMs);
  if (redisConfigured()) {
    const count = await redisWindowGet(key);
    // Charges that fell back to memory while Redis refused them still count
    // here: the higher of the two views is the one this isolate has seen.
    if (count !== null) return Math.max(count, memory.peek(key, nowMs) ?? 0);
  }
  return memory.get(key, nowMs);
}

/**
 * Gate a request up front: is the credential `identity` (from
 * `authFailureIdentity`) still tolerated from `ip`? Only that credential's
 * own refusals count — up to the budget, or none at all once the egress is
 * under stuffing (a credential never refused this window is always
 * tolerated). Charged later by `chargeAuthFailure` with the outcome. A
 * request without a credential has nothing to shard and is allowed (its
 * refusal will be local).
 */
export async function peekAuthFailureBudget(
  ip: string,
  identity: string | null,
  budget: AuthFailureBudget,
): Promise<RateLimitResult> {
  const nowMs = Date.now();
  const bucket = Math.floor(nowMs / (budget.windowSeconds * 1_000));
  if (identity === null) return toResult(0, budget.limit, bucket, budget.windowSeconds, true);
  const shard = await getWindow(
    AUTH_SHARD_SCOPE,
    `${ip}:${identity}`,
    budget.windowSeconds,
    nowMs,
    shardWindows,
  );
  if (shard === 0) return toResult(0, budget.limit, bucket, budget.windowSeconds, true);
  if (shard >= budget.limit) {
    return toResult(shard, budget.limit, bucket, budget.windowSeconds, false);
  }
  const stuffing = await getWindow(AUTH_EGRESS_SCOPE, ip, budget.windowSeconds, nowMs, windows);
  if (stuffing >= budget.limit) {
    return toResult(budget.limit, budget.limit, bucket, budget.windowSeconds, false);
  }
  return toResult(shard, budget.limit, bucket, budget.windowSeconds, true);
}

/**
 * Is `ip` under credential stuffing — have `budget.limit` DISTINCT
 * credentials been refused from it this window? While it is, a credential
 * already refused is 429 on replay (`peekAuthFailureBudget`) and a further
 * guess is 429 once Auth refused it (`chargeAuthFailure`); a credential
 * nothing has refused is never held to it.
 */
export async function peekAuthStuffing(
  ip: string,
  budget: AuthFailureBudget,
): Promise<RateLimitResult> {
  const nowMs = Date.now();
  const bucket = Math.floor(nowMs / (budget.windowSeconds * 1_000));
  const stuffing = await getWindow(AUTH_EGRESS_SCOPE, ip, budget.windowSeconds, nowMs, windows);
  return toResult(stuffing, budget.limit, bucket, budget.windowSeconds, stuffing < budget.limit);
}

/**
 * Charge a refusal. `identity` is the presented bearer's shard; the refusal
 * may name another (`refusal.identity`) or none. Both counters are keyed to
 * one instant so a charge can never straddle a window boundary, and the
 * stuffing signal is written to the store the shard landed in so a Redis
 * hiccup on the shard cannot turn one replayed credential into a shared
 * signal per isolate.
 *
 * Returns the exhausted budget when this guess took the egress PAST the
 * stuffing budget (the caller answers 429 instead of the 401 — the atomic
 * INCR is the only ordering concurrent guesses share), else `null`: the
 * refusal stands as judged.
 */
export async function chargeAuthFailure(
  ip: string,
  identity: string | null,
  refusal: AuthRefusal,
  budget: AuthFailureBudget,
): Promise<RateLimitResult | null> {
  if (refusal.kind === "local") return null;
  const target = refusal.identity === undefined ? identity : refusal.identity;
  if (target === null) return null;
  const nowMs = Date.now();
  const store: WindowStore = redisConfigured() ? "redis" : "memory";
  const shard = await incrWindow(
    AUTH_SHARD_SCOPE,
    `${ip}:${target}`,
    budget.windowSeconds,
    nowMs,
    shardWindows,
    store,
  );
  if (refusal.kind !== "credential" || shard.count !== 1) return null;
  const stuffing = await incrWindow(
    AUTH_EGRESS_SCOPE,
    ip,
    budget.windowSeconds,
    nowMs,
    windows,
    shard.store,
  );
  if (stuffing.count <= budget.limit) return null;
  const bucket = Math.floor(nowMs / (budget.windowSeconds * 1_000));
  return toResult(stuffing.count, budget.limit, bucket, budget.windowSeconds, false);
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
