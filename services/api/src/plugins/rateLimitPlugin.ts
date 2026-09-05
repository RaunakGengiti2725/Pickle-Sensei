import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendFailure } from "../lib/replies.js";

/**
 * Per-process request throttling. Every request is first budgeted by client
 * address in `onRequest`, before any credential has been examined — an
 * unauthenticated caller therefore exhausts ONE budget per address no matter
 * how many bearer strings it invents. Once `verifyToken` has ACCEPTED a bearer
 * the auth plugin calls `app.applyCredentialRateLimit`, which hands the
 * request's address charge back and budgets it by credential fingerprint
 * instead, so one caller cannot exhaust storage, mail, or database capacity
 * for everyone else behind the same address. Expensive routes (presigned
 * uploads, exports, deletion, social lookups) get a much smaller budget than
 * ordinary reads.
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
}

/**
 * Bounded counter store: eviction keeps a flood of keys from exhausting memory.
 * Windows are kept in creation order, so when the store is full of live keys
 * the ones created earliest (the soonest to reset) are dropped first — never
 * every window at once, so a burst of fresh keys cannot reset another caller's
 * exhausted counter.
 */
export class WindowStore {
  private windows = new Map<string, Window>();
  constructor(private maxKeys = 50_000) {}

  get size(): number {
    return this.windows.size;
  }

  peek(key: string): Window | undefined {
    return this.windows.get(key);
  }

  hit(key: string, windowMs: number, now: number): Window {
    const existing = this.windows.get(key);
    if (existing && existing.resetAt > now) {
      existing.count += 1;
      return existing;
    }
    // Re-insert an expired key so its position reflects the new window's age.
    if (existing) this.windows.delete(key);
    if (this.windows.size >= this.maxKeys) this.evict(now);
    const fresh = { count: 1, resetAt: now + windowMs };
    this.windows.set(key, fresh);
    return fresh;
  }

  private evict(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    let excess = this.windows.size - this.maxKeys + 1;
    if (excess <= 0) return;
    for (const key of this.windows.keys()) {
      if (excess <= 0) break;
      this.windows.delete(key);
      excess -= 1;
    }
  }
}

function credentialFingerprint(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  // Fingerprint only — the raw token never reaches the store or the logs.
  return createHash("sha256").update(header.slice("Bearer ".length)).digest("hex").slice(0, 32);
}

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Called by the auth plugin once a bearer has been VERIFIED: moves this
     * request from its address budget to the credential's budget and replies
     * 429 when that budget is exhausted.
     */
    applyCredentialRateLimit: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  }
}

export function registerRateLimit(app: FastifyInstance, config: RateLimitConfig): void {
  const store = new WindowStore();
  /** Address windows charged in onRequest, refunded once the credential verifies. */
  const pendingAddressCharges = new WeakMap<FastifyRequest, Window>();

  function budgetFor(request: FastifyRequest): { scope: string; limit: number } | null {
    const routeUrl = request.routeOptions?.url;
    if (routeUrl === undefined || routeUrl === "/v1/health") return null;
    const route = `${request.method} ${routeUrl}`;
    return EXPENSIVE_ROUTES.has(route)
      ? { scope: route, limit: config.expensiveLimit }
      : { scope: "*", limit: config.defaultLimit };
  }

  function rejectExhausted(
    request: FastifyRequest,
    reply: FastifyReply,
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

  app.decorate("applyCredentialRateLimit", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.enabled) return;
    const budget = budgetFor(request);
    const fingerprint = credentialFingerprint(request);
    if (!budget || fingerprint === null) return;
    const addressWindow = pendingAddressCharges.get(request);
    if (addressWindow) {
      pendingAddressCharges.delete(request);
      addressWindow.count = Math.max(0, addressWindow.count - 1);
    }
    const now = Date.now();
    const window = store.hit(`t:${fingerprint}|${budget.scope}`, config.windowMs, now);
    if (window.count > budget.limit) return rejectExhausted(request, reply, window, now);
  });

  if (!config.enabled) return;
  app.addHook("onRequest", async (request, reply) => {
    const budget = budgetFor(request);
    if (!budget) return;
    const now = Date.now();
    const window = store.hit(`ip:${request.ip}|${budget.scope}`, config.windowMs, now);
    if (window.count > budget.limit) return rejectExhausted(request, reply, window, now);
    pendingAddressCharges.set(request, window);
  });
}
