import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sendFailure } from "../lib/replies.js";

/**
 * Per-process request throttling. Abuse budgets are keyed by credential
 * (bearer token fingerprint) when one is present and by client address
 * otherwise, so one caller cannot exhaust storage, mail, or database capacity
 * for everyone else. Expensive routes (presigned uploads, exports, deletion,
 * social lookups) get a much smaller budget than ordinary reads.
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

interface Window {
  count: number;
  resetAt: number;
}

/** Bounded counter store: eviction keeps a flood of keys from exhausting memory. */
class WindowStore {
  private windows = new Map<string, Window>();
  constructor(private maxKeys = 50_000) {}

  hit(key: string, windowMs: number, now: number): Window {
    const existing = this.windows.get(key);
    if (existing && existing.resetAt > now) {
      existing.count += 1;
      return existing;
    }
    if (this.windows.size >= this.maxKeys) this.evict(now);
    const fresh = { count: 1, resetAt: now + windowMs };
    this.windows.set(key, fresh);
    return fresh;
  }

  private evict(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }
}

function callerKey(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    // Fingerprint only — the raw token never reaches the store or the logs.
    return `t:${createHash("sha256").update(header.slice("Bearer ".length)).digest("hex").slice(0, 32)}`;
  }
  return `ip:${request.ip}`;
}

export function registerRateLimit(app: FastifyInstance, config: RateLimitConfig): void {
  if (!config.enabled) return;
  const store = new WindowStore();
  app.addHook("onRequest", async (request, reply) => {
    const routeUrl = request.routeOptions?.url;
    if (routeUrl === undefined || routeUrl === "/v1/health") return;
    const route = `${request.method} ${routeUrl}`;
    const limit = EXPENSIVE_ROUTES.has(route) ? config.expensiveLimit : config.defaultLimit;
    const now = Date.now();
    const window = store.hit(
      `${callerKey(request)}|${limit === config.expensiveLimit ? route : "*"}`,
      config.windowMs,
      now,
    );
    if (window.count > limit) {
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
  });
}
