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

// ─────────────────────────────────────────────────────────────────────────────
// Auth-failure budgets behind a shared egress
//
// Many handsets share one client IP (club Wi-Fi, carrier NAT), so a flat
// per-IP failure budget lets one co-tenant — or thirty signed-out handsets —
// lock a whole venue out. The budget is therefore accounted on two axes:
//
//   shard  — per CREDENTIAL (opaque SHA-256 of the presented token): the 31st
//            presentation of one refused credential in a window is held
//            before Auth, whoever presents it and from wherever;
//   egress — per client IP, across every credential class (bearer /
//            bootstrap / refresh): the stuffing signal, the same `authfail`
//            window the flat budget kept. Only CREDENTIAL refusals — Auth
//            could not recognise the token at all — charge it. A LIVENESS
//            refusal (the token is genuine but its session is gone: logged
//            out, rotated, deleted, banned) charges its own shard only: a
//            handset learning it is signed out is not an attack, and the
//            401 it receives is the app's one sign-out signal.
//
// While an egress is under stuffing, credentials never seen or refused as
// credential failures are held (bounding what a forged flood can spend
// upstream exactly as the flat budget did), while credentials Auth already
// judged dead keep their 401 and credentials this edge itself minted (the
// access and refresh tokens bootstrap / refresh answered 200 with) are
// admitted to their verification. Cached bearers are untouched, so the venue
// keeps using, refreshing and being told about the sessions it holds through
// a co-tenant's flood; only a brand-new sign-in waits for the window, as it
// did under the flat budget.
//
// The refresh grant is the one place Auth cannot tell a logged-out handset
// from a guess: both are `refresh_token_not_found`. The edge can — it minted
// the handset's token — so that answer is liveness for a token this edge
// remembers minting and a credential failure otherwise. Concurrent
// presentations of one credential count while Auth is still judging them,
// so a parallel burst cannot outrun the shard.
//
// Shards are keyed by attacker-chosen text, so they never live in the
// bounded `windows` map (filling it would fail every limiter closed):
// without Redis they are counted in fixed-size count-min sketches whose
// memory is constant and that can only over-count on a collision.
// ─────────────────────────────────────────────────────────────────────────────

export type AuthRefusalKind = "liveness" | "credential";
export type AuthCredentialClass = "bearer" | "bootstrap" | "refresh";

export interface AuthFailureBudget {
  limit: number;
  windowSeconds: number;
}

/** GoTrue error codes for a credential it recognised but whose session is
 * dead. Every one of them requires a token GoTrue itself issued (a forged
 * token fails signature verification first, as `bad_jwt`), except the
 * refresh grant, where an unknown token is indistinguishable from a
 * logged-out one — `chargeAuthFailure` settles that by whether this edge
 * minted the token. */
const LIVENESS_ERROR_CODES: ReadonlySet<string> = new Set([
  "session_not_found",
  "session_expired",
  "user_not_found",
  "user_banned",
  "refresh_token_not_found",
  "refresh_token_already_used",
]);

/** The same verdicts as GoTrue phrases them in `msg` / `error_description`
 * (older deployments omit `error_code`). */
const LIVENESS_MESSAGE_PATTERNS: readonly RegExp[] = [
  /refresh token not found/i,
  /refresh token.*already used/i,
  /session.*does not exist/i,
  /session.*(has )?expired/i,
  /user.*does not exist/i,
  /user.*(is )?banned/i,
  /token is expired/i,
];

const SHARD_SCOPE = "authfail_id";
const LIVENESS_SCOPE = "authfail_live";
const MINTED_SCOPE = "authfail_minted";
const MINTED_MAX = 50_000;
const MINTED_TTL_MAX_SECONDS = 86_400;
const MINTED_REFRESH_TTL_SECONDS = 86_400;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/**
 * Classify a definitive Auth refusal (a GoTrue error body, or the AuthError
 * supabase-js builds from one). Anything unrecognised is a credential
 * failure — the charged, fail-closed side.
 */
export function authRefusalKind(refusal: unknown): AuthRefusalKind {
  if (!isRecord(refusal)) return "credential";
  const code = stringField(refusal, "error_code", "code");
  if (code && LIVENESS_ERROR_CODES.has(code)) return "liveness";
  const message = stringField(refusal, "msg", "message", "error_description") ?? "";
  return LIVENESS_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
    ? "liveness"
    : "credential";
}

/** The opaque identity of a presented credential: surrounding whitespace
 * does not make a new credential, and nothing of the token is retained. */
export function authFailureIdentity(credential: string): Promise<string> {
  return sha256Hex(credential.trim());
}

async function opaqueIdentity(identity: string): Promise<string> {
  return DIGEST_PATTERN.test(identity) ? identity : await authFailureIdentity(identity);
}

const SKETCH_ROWS = 4;
const SKETCH_WIDTH = 65_536;

/** Fixed-window count-min sketch over 64-hex digests: constant memory
 * regardless of how many distinct credentials are presented, exact for the
 * cardinalities a window sees in practice, and never an under-count. */
class DigestSketch {
  private bucket = Number.NaN;
  private rows: Uint32Array[] | null = null;

  private cells(bucket: number): Uint32Array[] {
    if (this.rows === null) {
      this.rows = Array.from({ length: SKETCH_ROWS }, () => new Uint32Array(SKETCH_WIDTH));
    }
    if (bucket !== this.bucket) {
      for (const row of this.rows) row.fill(0);
      this.bucket = bucket;
    }
    return this.rows;
  }

  private static index(digest: string, row: number): number {
    const parsed = Number.parseInt(digest.slice(row * 4, row * 4 + 4), 16);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  incr(digest: string, bucket: number): number {
    const rows = this.cells(bucket);
    let count = Infinity;
    rows.forEach((row, i) => {
      const index = DigestSketch.index(digest, i);
      row[index] += 1;
      count = Math.min(count, row[index]);
    });
    return count;
  }

  get(digest: string, bucket: number): number {
    const rows = this.cells(bucket);
    let count = Infinity;
    rows.forEach((row, i) => {
      count = Math.min(count, row[DigestSketch.index(digest, i)]);
    });
    return count;
  }
}

const shardSketch = new DigestSketch();
const livenessSketch = new DigestSketch();

/** Digests of access tokens this edge minted → expiry (ms). Bounded: only a
 * successful Auth exchange adds an entry, and eviction merely returns that
 * bearer to the ordinary gate. */
const mintedDigests = new Map<string, number>();

function mintedKey(digest: string): string {
  return `rl:${MINTED_SCOPE}:${digest}`;
}

function memoryNoteMinted(digest: string, expiresAtMs: number): void {
  mintedDigests.delete(digest);
  if (mintedDigests.size >= MINTED_MAX) {
    const now = Date.now();
    for (const [key, expiry] of mintedDigests) {
      if (expiry <= now) mintedDigests.delete(key);
    }
    while (mintedDigests.size >= MINTED_MAX) {
      const oldest = mintedDigests.keys().next();
      if (oldest.done) break;
      mintedDigests.delete(oldest.value);
    }
  }
  mintedDigests.set(digest, expiresAtMs);
}

function memoryIsMinted(digest: string): boolean {
  const expiry = mintedDigests.get(digest);
  if (expiry === undefined) return false;
  if (expiry > Date.now()) return true;
  mintedDigests.delete(digest);
  return false;
}

/**
 * Remember a credential this edge minted (bootstrap / refresh answered 200)
 * for `ttlSeconds` (capped at a day): it is admitted to Auth even while its
 * egress is under stuffing, and a dead-session answer for it is liveness.
 */
export async function noteMintedCredential(credential: string, ttlSeconds: number): Promise<void> {
  const ttl = Math.min(
    MINTED_TTL_MAX_SECONDS,
    Math.max(1, Math.floor(Number.isFinite(ttlSeconds) ? ttlSeconds : MINTED_TTL_MAX_SECONDS)),
  );
  const digest = await opaqueIdentity(credential);
  if (redisConfigured()) {
    const count = await redisWindowIncr(mintedKey(digest), ttl);
    if (count !== null) return;
  }
  memoryNoteMinted(digest, Date.now() + ttl * 1_000);
}

async function isMinted(digest: string): Promise<boolean> {
  if (redisConfigured()) {
    const count = await redisWindowGet(mintedKey(digest));
    if (count !== null) return count > 0;
  }
  return memoryIsMinted(digest);
}

export interface MintedSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** Remember both tokens of a session this edge just minted: the access token
 * for its remaining life, the refresh token for a day (an active handset
 * rotates it hourly, so it is re-noted long before that lapses). */
export async function noteMintedSession(session: MintedSession): Promise<void> {
  await noteMintedCredential(
    session.accessToken,
    session.expiresAt - Math.floor(Date.now() / 1_000),
  );
  await noteMintedCredential(session.refreshToken, MINTED_REFRESH_TTL_SECONDS);
}

/** Credentials Auth is judging right now (per isolate), counted against
 * their shard so a parallel burst of one credential cannot outrun it. */
const inflightJudgments = new Map<string, number>();

function reserveJudgment(digest: string): () => void {
  inflightJudgments.set(digest, (inflightJudgments.get(digest) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (inflightJudgments.get(digest) ?? 1) - 1;
    if (remaining > 0) inflightJudgments.set(digest, remaining);
    else inflightJudgments.delete(digest);
  };
}

/** The egress-wide stuffing signal: one window per IP across every
 * credential class, so an egress spends at most `limit` refused guesses on
 * Supabase Auth per window whatever mix of routes it presents them on. */
const STUFFING_SCOPE = "authfail";

async function digestIncr(
  sketch: DigestSketch,
  scope: string,
  digest: string,
  windowSeconds: number,
): Promise<number> {
  const { bucket, key } = windowKey(scope, digest, windowSeconds);
  if (redisConfigured()) {
    const count = await redisWindowIncr(key, windowSeconds);
    if (count !== null) return count;
  }
  return sketch.incr(digest, bucket);
}

async function digestGet(
  sketch: DigestSketch,
  scope: string,
  digest: string,
  windowSeconds: number,
): Promise<number> {
  const { bucket, key } = windowKey(scope, digest, windowSeconds);
  if (redisConfigured()) {
    const count = await redisWindowGet(key);
    if (count !== null) return count;
  }
  return sketch.get(digest, bucket);
}

export interface AuthJudgmentAdmission {
  budget: RateLimitResult;
  /** Present only when admitted: call once the verdict has been charged (or
   * the request ended without one) so the credential stops counting as in
   * flight. */
  release: (() => void) | null;
}

async function judgeAuthFailureBudget(
  ip: string,
  identity: string,
  budget: AuthFailureBudget,
  reserve: boolean,
): Promise<AuthJudgmentAdmission> {
  const { limit, windowSeconds } = budget;
  const bucket = Math.floor(Date.now() / (windowSeconds * 1_000));
  const digest = await opaqueIdentity(identity);
  const redis = redisConfigured();
  const charged = redis ? await digestGet(shardSketch, SHARD_SCOPE, digest, windowSeconds) : null;
  const stuffing = await peekRateLimit(STUFFING_SCOPE, ip, limit, windowSeconds);
  const liveness = stuffing.allowed
    ? 0
    : await digestGet(livenessSketch, LIVENESS_SCOPE, digest, windowSeconds);
  const minted = stuffing.allowed || liveness >= 1 ? false : await isMinted(digest);

  // No await from here on: the shard is read and reserved in one step, so
  // parallel presentations of one credential cannot all see the same count.
  const shard = (charged ?? shardSketch.get(digest, bucket)) + (inflightJudgments.get(digest) ?? 0);
  const decide = (allowed: boolean, spent: number): AuthJudgmentAdmission => ({
    budget: toResult(spent, limit, bucket, windowSeconds, allowed),
    release: allowed && reserve ? reserveJudgment(digest) : null,
  });
  if (shard >= limit) return decide(false, shard);
  if (stuffing.allowed) {
    return decide(true, Math.max(shard, limit - stuffing.remaining));
  }
  if ((shard >= 1 && liveness >= 1) || minted) return decide(true, shard);
  return decide(false, limit);
}

/**
 * Gate a credential BEFORE it is sent to Supabase Auth. Nothing is counted
 * here; the verdict is charged afterwards with `chargeAuthFailure`.
 *
 *   ip       — the client egress
 *   identity — `authFailureIdentity(credential)` (raw text is digested here)
 */
export async function peekAuthFailureBudget(
  ip: string,
  identity: string,
  budget: AuthFailureBudget,
): Promise<RateLimitResult> {
  return (await judgeAuthFailureBudget(ip, identity, budget, false)).budget;
}

/**
 * `peekAuthFailureBudget` that, when it admits, also counts the credential
 * as in flight against its shard until `release` is called.
 */
export function admitAuthJudgment(
  ip: string,
  identity: string,
  budget: AuthFailureBudget,
): Promise<AuthJudgmentAdmission> {
  return judgeAuthFailureBudget(ip, identity, budget, true);
}

/**
 * Charge a definitive Auth refusal: the credential's shard always, and the
 * egress's stuffing signal for `cls` only when the refusal is a credential
 * failure. Liveness refusals mark the shard so the dead credential keeps its
 * 401 while the egress is under stuffing. A refresh token Auth reports dead
 * is liveness only if this edge minted it; an unknown one is a guess.
 */
export async function chargeAuthFailure(
  cls: AuthCredentialClass,
  ip: string,
  identity: string,
  kind: AuthRefusalKind,
  budget: AuthFailureBudget,
): Promise<void> {
  const { limit, windowSeconds } = budget;
  const digest = await opaqueIdentity(identity);
  await digestIncr(shardSketch, SHARD_SCOPE, digest, windowSeconds);
  if (kind === "liveness" && (cls !== "refresh" || (await isMinted(digest)))) {
    await digestIncr(livenessSketch, LIVENESS_SCOPE, digest, windowSeconds);
    return;
  }
  await enforceRateLimit(STUFFING_SCOPE, ip, limit, windowSeconds);
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
