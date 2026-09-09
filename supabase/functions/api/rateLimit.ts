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
// A venue's Wi-Fi, a carrier NAT or a corporate proxy presents ONE client IP
// for many handsets, so a budget keyed by IP alone lets one co-tenant's bad
// credentials lock everyone else out. Refusals are therefore recorded per
// CREDENTIAL (a shard keyed by the SHA-256 of the presented token) and the
// per-egress counter is only a stuffing SIGNAL:
//
//   * a credential Supabase Auth has refused `limit` times in the window is
//     held (429) wherever and by whomever it is presented;
//   * once the egress has produced `limit` credential refusals, every
//     credential it has ALREADY had refused as a credential is fast-failed
//     without another Auth lookup, while credentials never refused (a
//     co-tenant's valid session, a fresh sign-in) are still judged by Auth
//     exactly as before;
//   * a 401 that only says "this session is dead" (logged out, expired,
//     banned, refresh token gone or already rotated) is a LIVENESS verdict
//     the app acts on by signing out — it fills the credential's own shard so
//     a stuck client cannot hammer Auth, but it is never a stuffing signal and
//     never turns a dead session's 401 into a 429 under someone else's flood;
//   * refusals decided at this edge (no bearer, expired `exp`) and Auth
//     outages charge nothing.
//
// Shards live in the same aligned windows as every other budget (Redis when
// configured, else per-isolate memory in their own bounded map) and fail
// OPEN like them: a credential whose record cannot be read is admitted.

export type AuthRefusalKind = "liveness" | "credential";

export interface AuthFailureBudget {
  limit: number;
  windowSeconds: number;
}

/** Per-egress stuffing signal: credential refusals by client IP. */
const AUTH_FAILURE_EGRESS_SCOPE = "authfail";
/** Per-credential shards: refusals of one presented token, by its digest —
 * one window per refusal kind, so a saturated egress can fast-fail what it
 * had refused as a credential without touching what was merely dead. */
const AUTH_FAILURE_SHARD_SCOPES: Readonly<Record<AuthRefusalKind, string>> = {
  credential: "authfail_cred",
  liveness: "authfail_live",
};

/** GoTrue `error_code`s that judge the SESSION or USER behind a well-formed
 * credential, not the credential's authenticity. A refresh token GoTrue no
 * longer holds is a session that was signed out, rotated or revoked — refresh
 * tokens are unguessable random secrets, so their refusal is never stuffing. */
const LIVENESS_ERROR_CODES: ReadonlySet<string> = new Set([
  "session_not_found",
  "session_expired",
  "refresh_token_not_found",
  "refresh_token_already_used",
  "user_not_found",
  "user_banned",
]);
/** The same verdicts on older GoTrue bodies that carry only a message. */
const LIVENESS_MESSAGE_PATTERNS: readonly RegExp[] = [
  /session (?:not found|does not exist|has expired|expired)/i,
  /refresh token not found/i,
  /already used/i,
  /token is expired/i,
  /user (?:not found|does not exist|is banned)/i,
];

function stringFields(source: Record<string, unknown>, names: readonly string[]): string[] {
  const values: string[] = [];
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value) values.push(value);
  }
  return values;
}

/**
 * Classify a definitive Supabase Auth refusal. Accepts the raw GoTrue error
 * body (`{code, error_code, msg}` / `{error, error_code, error_description}`)
 * or a supabase-js `AuthApiError` (`{code, message, status}`). Anything
 * unrecognised is a credential failure — the conservative reading.
 */
export function authRefusalKind(refusal: unknown): AuthRefusalKind {
  if (typeof refusal !== "object" || refusal === null) return "credential";
  const record = refusal as Record<string, unknown>;
  if (stringFields(record, ["error_code", "code"]).some((code) => LIVENESS_ERROR_CODES.has(code))) {
    return "liveness";
  }
  const messages = stringFields(record, ["msg", "message", "error_description"]);
  if (
    messages.some((message) => LIVENESS_MESSAGE_PATTERNS.some((pattern) => pattern.test(message)))
  ) {
    return "liveness";
  }
  return "credential";
}

/** Shard key material for a presented credential: its SHA-256, so the raw
 * token is never a Redis key and every shape of token (JWT, opaque refresh
 * token, even one that already looks like a digest) hashes the same way. */
export function authFailureIdentity(credential: string): Promise<string> {
  return sha256Hex(credential.trim());
}

const shards = new Map<string, MemoryWindow>();
let nextShardExpiryAtMs = Infinity;

function shardHasCapacity(now: number): boolean {
  if (shards.size < MEMORY_WINDOW_MAX) return true;
  if (now >= nextShardExpiryAtMs) {
    nextShardExpiryAtMs = Infinity;
    for (const [key, window] of shards) {
      if (window.resetAtMs <= now) {
        shards.delete(key);
      } else {
        nextShardExpiryAtMs = Math.min(nextShardExpiryAtMs, window.resetAtMs);
      }
    }
  }
  return shards.size < MEMORY_WINDOW_MAX;
}

/** Like memoryIncr, but a full store drops the record (null) instead of
 * refusing: an unrecorded refusal fails open, it never holds anyone. */
function shardIncr(key: string, resetAtMs: number): number | null {
  const now = Date.now();
  const existing = shards.get(key);
  if (existing && existing.resetAtMs > now) {
    existing.count += 1;
    return existing.count;
  }
  if (!shardHasCapacity(now)) return null;
  shards.set(key, { count: 1, resetAtMs });
  nextShardExpiryAtMs = Math.min(nextShardExpiryAtMs, resetAtMs);
  return 1;
}

function shardGet(key: string): number {
  const existing = shards.get(key);
  return existing && existing.resetAtMs > Date.now() ? existing.count : 0;
}

/** Both shards of one credential. Without Redis this is synchronous on
 * purpose: the caller reads the counts and the in-flight reservations in one
 * uninterrupted segment, so a concurrent charge cannot be seen by one and
 * missed by the other. */
function shardCounts(keys: ShardKeys): [number, number] | Promise<[number, number]> {
  const memory = (): [number, number] => [shardGet(keys.credential), shardGet(keys.liveness)];
  if (!redisConfigured()) return memory();
  return Promise.all([redisWindowGet(keys.credential), redisWindowGet(keys.liveness)]).then(
    ([credential, liveness]) => {
      const [memCredential, memLiveness] = memory();
      return [credential ?? memCredential, liveness ?? memLiveness];
    },
  );
}

interface ShardKeys {
  bucket: number;
  credential: string;
  liveness: string;
}

async function shardKeys(credential: string, windowSeconds: number): Promise<ShardKeys> {
  const identity = await authFailureIdentity(credential);
  const byKind = windowKey(AUTH_FAILURE_SHARD_SCOPES.credential, identity, windowSeconds);
  return {
    bucket: byKind.bucket,
    credential: byKind.key,
    liveness: windowKey(AUTH_FAILURE_SHARD_SCOPES.liveness, identity, windowSeconds).key,
  };
}

/** Judgments of an ALREADY-REFUSED credential awaiting Auth's verdict on this
 * isolate (expiry timestamps): a parallel replay burst must not outrun the
 * shard by reading it before any of the burst is charged. A credential that
 * was never refused is never reserved, so a valid session's fan-out is never
 * throttled by a failure budget. Entries expire on their own in case a
 * judgment never reports back (Auth outage). Exact against the per-isolate
 * store; with Redis the counts are global and the reservations local, so the
 * bound is approximate there. */
const INFLIGHT_TTL_MS = 15_000;
const inflight = new Map<string, number[]>();

function inflightPending(key: string, now: number): number[] {
  const pending = inflight.get(key);
  if (!pending) return [];
  const live = pending.filter((expiresAtMs) => expiresAtMs > now);
  if (live.length === 0) inflight.delete(key);
  else if (live.length !== pending.length) inflight.set(key, live);
  return live;
}

function inflightReserve(key: string, now: number): void {
  const live = inflightPending(key, now);
  if (live.length === 0 && inflight.size >= MEMORY_WINDOW_MAX) {
    for (const staleKey of inflight.keys()) inflightPending(staleKey, now);
    if (inflight.size >= MEMORY_WINDOW_MAX) return;
  }
  inflight.set(key, [...live, now + INFLIGHT_TTL_MS]);
}

function inflightRelease(key: string): void {
  const live = inflightPending(key, Date.now());
  if (live.length <= 1) inflight.delete(key);
  else inflight.set(key, live.slice(1));
}

async function authFailureShard(
  ip: string,
  credential: string,
  budget: AuthFailureBudget,
  reserve: boolean,
): Promise<RateLimitResult> {
  const presented = credential.trim().length > 0;
  if (!presented) {
    const { bucket } = windowKey(AUTH_FAILURE_SHARD_SCOPES.credential, "", budget.windowSeconds);
    return toResult(0, budget.limit, bucket, budget.windowSeconds, true);
  }
  const keys = await shardKeys(credential, budget.windowSeconds);
  const counts = shardCounts(keys);
  const [credentialRefusals, livenessRefusals] = Array.isArray(counts) ? counts : await counts;
  const refusals = credentialRefusals + livenessRefusals;
  let held = refusals >= budget.limit;
  if (!held && refusals > 0) {
    const now = Date.now();
    if (reserve) {
      held = refusals + inflightPending(keys.credential, now).length >= budget.limit;
      if (!held) inflightReserve(keys.credential, now);
    }
    if (!held && credentialRefusals > 0) {
      const egress = await peekRateLimit(
        AUTH_FAILURE_EGRESS_SCOPE,
        ip,
        budget.limit,
        budget.windowSeconds,
      );
      held = !egress.allowed;
      if (held && reserve) inflightRelease(keys.credential);
    }
  }
  return toResult(refusals, budget.limit, keys.bucket, budget.windowSeconds, !held);
}

/**
 * Inspect the budget of `credential` presented from `ip` WITHOUT reserving a
 * judgment. Held (`allowed: false`) when the credential itself has used up
 * the budget (refusals of either kind), or when the egress is saturated with
 * credential refusals and this credential has already been refused AS A
 * CREDENTIAL at least once in the window. An empty credential is refused
 * locally by the caller and is never held here.
 */
export function peekAuthFailureBudget(
  ip: string,
  credential: string,
  budget: AuthFailureBudget,
): Promise<RateLimitResult> {
  return authFailureShard(ip, credential, budget, false);
}

/**
 * Gate a request presenting `credential` from `ip` BEFORE Supabase Auth is
 * consulted: `peekAuthFailureBudget` plus, for a credential already refused
 * in this window, a reservation of the judgment about to be made so that a
 * burst of parallel replays is bounded like a sequence of them. The
 * reservation is released by `chargeAuthFailure` (or expires by itself).
 */
export function admitAuthCredential(
  ip: string,
  credential: string,
  budget: AuthFailureBudget,
): Promise<RateLimitResult> {
  return authFailureShard(ip, credential, budget, true);
}

/**
 * Record a definitive Supabase Auth refusal of `credential` presented from
 * `ip`: one atomic INCR on the credential's shard, plus one on the egress
 * stuffing signal when the refusal judged the credential itself. Returns the
 * shard's window. Call ONLY for refusals Auth actually issued — never for
 * outages, and never for refusals decided at this edge.
 */
export async function chargeAuthFailure(
  ip: string,
  credential: string,
  kind: AuthRefusalKind,
  budget: AuthFailureBudget,
): Promise<RateLimitResult> {
  const keys = await shardKeys(credential, budget.windowSeconds);
  const resetAtMs = (keys.bucket + 1) * budget.windowSeconds * 1_000;
  const [charged] = await Promise.all([
    (async (): Promise<number> => {
      let count: number | null = null;
      if (redisConfigured()) {
        count = await redisWindowIncr(keys[kind], budget.windowSeconds);
      }
      const recorded = count ?? shardIncr(keys[kind], resetAtMs) ?? 0;
      inflightRelease(keys.credential);
      return recorded;
    })(),
    kind === "credential"
      ? enforceRateLimit(AUTH_FAILURE_EGRESS_SCOPE, ip, budget.limit, budget.windowSeconds)
      : Promise.resolve(null),
  ]);
  const counts = shardCounts(keys);
  const [credentialRefusals, livenessRefusals] = Array.isArray(counts) ? counts : await counts;
  const refusals =
    kind === "credential" ? charged + livenessRefusals : credentialRefusals + charged;
  return toResult(
    refusals,
    budget.limit,
    keys.bucket,
    budget.windowSeconds,
    refusals <= budget.limit,
  );
}

const markedRefusals = new WeakMap<Response, { credential: string; kind: AuthRefusalKind }>();

/**
 * Tag a 401 as Supabase Auth's definitive verdict on `credential` (`refusal`
 * is the GoTrue body or supabase-js error that carried it) so the dispatcher
 * can charge the right budget once the response leaves the auth layer.
 * Refusals decided locally are never marked, hence never charged.
 */
export function markAuthRefusal(
  response: Response,
  credential: string,
  refusal: unknown,
): Response {
  markedRefusals.set(response, { credential, kind: authRefusalKind(refusal) });
  return response;
}

/** Charge the budget for a response marked by `markAuthRefusal`; unmarked
 * responses charge nothing and yield null. */
export async function chargeMarkedAuthRefusal(
  ip: string,
  response: Response,
  budget: AuthFailureBudget,
): Promise<RateLimitResult | null> {
  const mark = markedRefusals.get(response);
  if (!mark) return null;
  return await chargeAuthFailure(ip, mark.credential, mark.kind, budget);
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
