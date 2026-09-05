import { createHash } from "node:crypto";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
  preHandlerHookHandler,
} from "fastify";
import { sendFailure } from "../lib/replies.js";

/**
 * Per-process request throttling with a two-phase ledger.
 *
 * Phase 1 (`onRequest`, before any route code): every request is charged to
 * its CLIENT ADDRESS. A bearer header never CREATES or CHARGES a budget here —
 * an unauthenticated caller must not be able to choose its own budget key by
 * rotating garbage tokens. The only pre-auth use of the header is a read: if
 * the bearer already owns a credential window (which only phase 2 can open,
 * i.e. it verified earlier in this window) and that window is spent, the
 * request is refused right away instead of paying for verification again.
 *
 * Phase 2 (a preHandler appended to every route's own chain by an `onRoute`
 * hook, so it runs AFTER the route's `verifyToken` / `authenticate` /
 * `requireAdmin` accepted the credential): once `request.identity` is set the
 * provisional address charge is refunded and the request is settled against
 * the VERIFIED credential's budget instead, so callers behind one NAT share
 * nothing and one credential cannot spend more than its own budget from many
 * addresses. Requests whose credential was rejected keep their address charge.
 *
 * Expensive routes (presigned uploads, exports, deletion, social lookups) get
 * a much smaller budget than ordinary reads.
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
  /** Budget this window is measured against; `count >= limit` means spent. */
  limit: number;
}

/**
 * Bounded window map. When full it frees a batch of windows, preferring
 * expired ones, then the oldest windows whose budget is NOT yet spent — a
 * caller that has used up its budget keeps its counter for the rest of the
 * window, so a flood of fresh keys can never buy anybody a reset. Only if
 * every window is spent does the oldest of those go; the map is never cleared.
 */
class WindowStore {
  private windows = new Map<string, Window>();
  constructor(private maxKeys = 50_000) {}

  hit(key: string, limit: number, windowMs: number, now: number): Window {
    const existing = this.windows.get(key);
    if (existing && existing.resetAt > now) {
      existing.count += 1;
      return existing;
    }
    if (existing) this.windows.delete(key);
    if (this.windows.size >= this.maxKeys) this.evict(now);
    const fresh = { count: 1, resetAt: now + windowMs, limit };
    this.windows.set(key, fresh);
    return fresh;
  }

  /** The live window for `key`, if any; never creates or charges one. */
  peek(key: string, now: number): Window | undefined {
    const existing = this.windows.get(key);
    return existing && existing.resetAt > now ? existing : undefined;
  }

  /** Undo one `hit` inside the same window; a rolled-over window owes nothing. */
  refund(key: string, now: number): void {
    const existing = this.windows.get(key);
    if (!existing || existing.resetAt <= now) return;
    if (existing.count <= 1) this.windows.delete(key);
    else existing.count -= 1;
  }

  private evict(now: number): void {
    const target = this.maxKeys - Math.max(1, Math.floor(this.maxKeys / 10));
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    if (this.windows.size <= target) return;
    for (const [key, window] of this.windows) {
      if (window.count < window.limit) this.windows.delete(key);
      if (this.windows.size <= target) return;
    }
    for (const key of this.windows.keys()) {
      this.windows.delete(key);
      if (this.windows.size <= target) return;
    }
  }
}

interface Charge {
  key: string;
  route: string;
  limit: number;
}

function addressKey(request: FastifyRequest): string {
  return `ip:${request.ip}`;
}

function credentialKey(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return `t:${createHash("sha256").update(header.slice("Bearer ".length)).digest("hex").slice(0, 32)}`;
}

function throttle(reply: FastifyReply, request: FastifyRequest, window: Window, now: number) {
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
  /** Provisional address charges awaiting settlement, per in-flight request. */
  const charges = new WeakMap<FastifyRequest, Charge>();

  const scope = (route: string, limit: number) => (limit === config.expensiveLimit ? route : "*");

  app.addHook("onRequest", async (request, reply) => {
    const routeUrl = request.routeOptions?.url;
    if (routeUrl === undefined || routeUrl === "/v1/health") return;
    const route = `${request.method} ${routeUrl}`;
    const limit = EXPENSIVE_ROUTES.has(route) ? config.expensiveLimit : config.defaultLimit;
    const now = Date.now();
    const credential = credentialKey(request);
    if (credential !== null) {
      const credentialWindowKey = `${credential}|${scope(route, limit)}`;
      const spent = store.peek(credentialWindowKey, now);
      if (spent && spent.count >= limit) {
        return throttle(
          reply,
          request,
          store.hit(credentialWindowKey, limit, config.windowMs, now),
          now,
        );
      }
    }
    const key = `${addressKey(request)}|${scope(route, limit)}`;
    const window = store.hit(key, limit, config.windowMs, now);
    if (window.count > limit) return throttle(reply, request, window, now);
    charges.set(request, { key, route, limit });
  });

  const settleVerifiedCredential: preHandlerHookHandler = async function (request, reply) {
    const charge = charges.get(request);
    if (!charge || !request.identity) return;
    const credential = credentialKey(request);
    if (credential === null) return;
    charges.delete(request);
    const now = Date.now();
    store.refund(charge.key, now);
    const window = store.hit(
      `${credential}|${scope(charge.route, charge.limit)}`,
      charge.limit,
      config.windowMs,
      now,
    );
    if (window.count > charge.limit) return throttle(reply, request, window, now);
  };

  app.addHook("onRoute", (routeOptions: RouteOptions) => {
    const existing = routeOptions.preHandler;
    routeOptions.preHandler =
      existing === undefined
        ? [settleVerifiedCredential]
        : Array.isArray(existing)
          ? [...existing, settleVerifiedCredential]
          : [existing, settleVerifiedCredential];
  });
}
