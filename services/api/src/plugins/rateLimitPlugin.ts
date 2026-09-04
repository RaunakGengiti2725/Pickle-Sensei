import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendFailure } from "../lib/replies.js";

/**
 * Per-process request throttling with two ledgers:
 *
 * - The ADDRESS ledger is charged for every request as it arrives, before any
 *   credential is looked at. Whatever a caller puts in `Authorization` cannot
 *   pick the budget it is measured against.
 * - The IDENTITY ledger is charged only once the route's own auth step has
 *   verified the bearer: the request's provisional address charge is then
 *   refunded and the hit moves to the verified subject, so many legitimate
 *   users behind one NAT never share a budget and one user's overrun never
 *   throttles their neighbours. A token that has verified in this process is
 *   remembered (fingerprint → subject, TTL-bounded) so its later requests are
 *   charged to the identity ledger up front and refused without touching
 *   the verifier or the database.
 *
 * Expensive routes (presigned uploads, exports, deletion, social lookups,
 * account bootstrap) get a much smaller budget than ordinary reads. The store
 * is bounded; at capacity it drops expired windows, then the oldest windows
 * that were never refused — a refused caller's window is the state worth
 * keeping and is the last thing to go.
 *
 * This is a single-instance guard: it bounds abuse per API process and is not a
 * substitute for an edge/WAF limit shared across instances.
 */

export interface RateLimitConfig {
  enabled: boolean;
  windowMs: number;
  /** Budget for ordinary authenticated reads/writes. */
  defaultLimit: number;
  /** Budget for expensive or abuse-prone routes. */
  expensiveLimit: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  enabled: true,
  windowMs: 60_000,
  defaultLimit: 600,
  expensiveLimit: 60,
};

/** Routes whose cost is storage, egress, or enumeration surface. */
const EXPENSIVE_ROUTES = new Set([
  "POST /v1/media/uploads",
  "POST /v1/media/:id/complete",
  "GET /v1/media/:id",
  "POST /v1/me/export",
  "GET /v1/me/consent/export",
  "POST /v1/friends/requests",
  "POST /v1/share-cards",
  "POST /v1/analyses",
  "POST /v1/analyses/:id/report",
  "POST /v1/account/bootstrap",
  "DELETE /v1/me",
  "POST /v1/billing/sync",
]);

export interface Window {
  count: number;
  resetAt: number;
  /** Set once this window has refused a request; such windows survive eviction. */
  refused: boolean;
}

/**
 * Bounded counter store. Map insertion order doubles as creation order, so the
 * first entries iterated are always the ones closest to their reset.
 */
export class WindowStore {
  private windows = new Map<string, Window>();
  constructor(private readonly maxKeys = 50_000) {}

  get size(): number {
    return this.windows.size;
  }

  hit(key: string, windowMs: number, now: number, limit: number): Window {
    const existing = this.windows.get(key);
    if (existing && existing.resetAt > now) {
      existing.count += 1;
      if (existing.count > limit) existing.refused = true;
      return existing;
    }
    if (existing) this.windows.delete(key);
    if (this.windows.size >= this.maxKeys) this.evict(now);
    const fresh: Window = { count: 1, resetAt: now + windowMs, refused: 1 > limit };
    this.windows.set(key, fresh);
    return fresh;
  }

  /** Returns one provisional hit to the window it was taken from. */
  refund(window: Window): void {
    if (window.count > 0) window.count -= 1;
  }

  private evict(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    if (this.windows.size < this.maxKeys) return;
    // Free a slice rather than one slot so a flood does not pay a full scan per
    // request. Windows that never refused anything are the cheap ones to lose:
    // their owners were under budget, and losing one never lifts a refusal.
    const target = Math.floor(this.maxKeys * 0.9);
    for (const [key, window] of this.windows) {
      if (this.windows.size <= target) break;
      if (!window.refused) this.windows.delete(key);
    }
    if (this.windows.size < this.maxKeys) return;
    // Every remaining window belongs to a refused caller. Release the ones
    // closest to their natural reset — a bounded early reset for a few callers,
    // never a wholesale amnesty.
    for (const key of this.windows.keys()) {
      if (this.windows.size <= target) break;
      this.windows.delete(key);
    }
  }
}

interface VerifiedToken {
  identityKey: string;
  expiresAt: number;
}

/**
 * Token fingerprints this process has already verified, so a known caller is
 * charged to its identity before auth runs. Only successful verification adds
 * an entry; an attacker without a valid token cannot fill it.
 */
export class VerifiedTokenMemo {
  private entries = new Map<string, VerifiedToken>();
  constructor(
    private readonly maxEntries = 20_000,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  identityFor(fingerprint: string, now: number): string | undefined {
    const entry = this.entries.get(fingerprint);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(fingerprint);
      return undefined;
    }
    return entry.identityKey;
  }

  remember(fingerprint: string, identityKey: string, now: number): void {
    this.entries.delete(fingerprint);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(fingerprint, { identityKey, expiresAt: now + this.ttlMs });
  }
}

/** The hit a request holds; provisional until the bearer verifies. */
interface Charge {
  window: Window;
  limit: number;
  /** Route template for expensive routes, `*` for the shared default budget. */
  scope: string;
  /** Fingerprint of the bearer this request presented, if any. */
  fingerprint: string | undefined;
  provisional: boolean;
}

const fingerprintOf = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);

/** Fingerprint only — the raw token never reaches the store or the logs. */
function bearerFingerprint(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return fingerprintOf(header.slice("Bearer ".length));
}

const identityKeyFor = (authSubject: string): string => `u:${fingerprintOf(authSubject)}`;

function refuse(
  reply: FastifyReply,
  request: FastifyRequest,
  window: Window,
  now: number,
): FastifyReply {
  const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
  reply.header("retry-after", String(retryAfter));
  return sendFailure(
    reply,
    request,
    429,
    "retryable",
    "api.rate_limited",
    `Too many requests. Retry in ${retryAfter}s.`,
  );
}

export function registerRateLimit(app: FastifyInstance, config: RateLimitConfig): void {
  if (!config.enabled) return;
  const store = new WindowStore();
  const verifiedTokens = new VerifiedTokenMemo();
  const charges = new WeakMap<FastifyRequest, Charge>();

  app.addHook("onRequest", async (request, reply) => {
    const routeUrl = request.routeOptions?.url;
    if (routeUrl === undefined || routeUrl === "/v1/health") return;
    const route = `${request.method} ${routeUrl}`;
    const expensive = EXPENSIVE_ROUTES.has(route);
    const limit = expensive ? config.expensiveLimit : config.defaultLimit;
    const scope = expensive ? route : "*";
    const now = Date.now();
    const fingerprint = bearerFingerprint(request);
    const knownIdentity =
      fingerprint === undefined ? undefined : verifiedTokens.identityFor(fingerprint, now);
    const owner = knownIdentity ?? `ip:${request.ip}`;
    const window = store.hit(`${owner}|${scope}`, config.windowMs, now, limit);
    charges.set(request, {
      window,
      limit,
      scope,
      fingerprint,
      provisional: knownIdentity === undefined,
    });
    if (window.count > limit) return refuse(reply, request, window, now);
  });

  // Runs after each route's own preHandlers (where `verifyToken`/`authenticate`
  // live), so `request.identity` is trustworthy here. If auth already replied,
  // Fastify skips this hook and the address keeps the charge.
  const settleVerifiedIdentity = async (request: FastifyRequest, reply: FastifyReply) => {
    const charge = charges.get(request);
    const identity = request.identity;
    if (!charge || !charge.provisional || !identity) return;
    const now = Date.now();
    const identityKey = identityKeyFor(identity.authSubject);
    if (charge.fingerprint !== undefined) {
      verifiedTokens.remember(charge.fingerprint, identityKey, now);
    }
    store.refund(charge.window);
    const window = store.hit(`${identityKey}|${charge.scope}`, config.windowMs, now, charge.limit);
    charge.window = window;
    charge.provisional = false;
    if (window.count > charge.limit) return refuse(reply, request, window, now);
  };

  app.addHook("onRoute", (routeOptions) => {
    const existing = routeOptions.preHandler;
    routeOptions.preHandler =
      existing === undefined
        ? [settleVerifiedIdentity]
        : Array.isArray(existing)
          ? [...existing, settleVerifiedIdentity]
          : [existing, settleVerifiedIdentity];
  });
}
