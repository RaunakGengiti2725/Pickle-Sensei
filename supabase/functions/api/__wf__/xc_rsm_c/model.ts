// Reference model ("oracle") of the edge function's auth + rate-limit
// decision procedure for ONE isolate without Redis, evaluated one request at
// a time. It mirrors the documented contract (AGENTS.md "Auth sessions",
// "Scale & security") plus the concrete semantics of rateLimit.ts and the
// auth cache in index.ts, so that in the sequential phase the harness can
// demand an EXACT status / Retry-After / RateLimit-* match for every request.
//
// Deliberately NOT modelled: PostgREST failures (the fake never fails) and
// routes outside the campaign. Everything the model consults about sessions
// comes from the same FakeSupabase the edge talks to, read BEFORE the request
// is dispatched, so the model never learns anything the edge could not.

import type { FakeSupabase, Provider } from "./fakeSupabase.ts";
import { decodeJwtPayload } from "./tokens.ts";

export const LIMITS = {
  ip: { limit: 1200, windowSeconds: 60 },
  authfail: { limit: 30, windowSeconds: 300 },
  user: { limit: 240, windowSeconds: 60 },
  auth_refresh: { limit: 30, windowSeconds: 60 },
  publicPage: { limit: 60, windowSeconds: 60 },
} as const;

export const AUTH_CACHE_MAX_TTL_SECONDS = 600;
export const AUTH_CACHE_READ_GUARD_MS = 5_000;

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  scope: string;
}

interface MemoryWindow {
  count: number;
  resetAtMs: number;
}

/** rateLimit.ts memory semantics: key includes the aligned bucket; the entry
 * lives `window` seconds from its FIRST hit (so it always outlives the bucket). */
export class RateLimitModel {
  windows = new Map<string, MemoryWindow>();

  private key(scope: string, id: string, windowSeconds: number, now: number) {
    const bucket = Math.floor(now / (windowSeconds * 1_000));
    return { bucket, key: `rl:${scope}:${bucket}:${id}` };
  }

  private decision(
    scope: string,
    count: number,
    limit: number,
    bucket: number,
    windowSeconds: number,
    allowed: boolean,
    now: number,
  ): RateDecision {
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: Math.max(1, Math.ceil((bucket + 1) * windowSeconds - now / 1_000)),
      scope,
    };
  }

  incr(scope: string, id: string, limit: number, windowSeconds: number, now: number): RateDecision {
    const { bucket, key } = this.key(scope, id, windowSeconds, now);
    const existing = this.windows.get(key);
    let count: number;
    if (existing && existing.resetAtMs > now) {
      existing.count += 1;
      count = existing.count;
    } else {
      this.windows.set(key, { count: 1, resetAtMs: now + windowSeconds * 1_000 });
      count = 1;
    }
    return this.decision(scope, count, limit, bucket, windowSeconds, count <= limit, now);
  }

  peek(scope: string, id: string, limit: number, windowSeconds: number, now: number): RateDecision {
    const { bucket, key } = this.key(scope, id, windowSeconds, now);
    const existing = this.windows.get(key);
    const count = existing && existing.resetAtMs > now ? existing.count : 0;
    return this.decision(scope, count, limit, bucket, windowSeconds, count < limit, now);
  }

  /** Current count for a bucket (diagnostics). */
  count(scope: string, id: string, windowSeconds: number, now: number): number {
    const { key } = this.key(scope, id, windowSeconds, now);
    const existing = this.windows.get(key);
    return existing && existing.resetAtMs > now ? existing.count : 0;
  }
}

export interface CacheEntryModel {
  userId: string;
  provider: Provider;
  /** CachedAuthSession.expiresAtMs — the verification's validity horizon. */
  expiresAtMs: number;
  /** L1 memory TTL horizon (cacheSet ttlSeconds). */
  memoryExpiresAtMs: number;
  /** Session the verification belonged to (for revocation reasoning). */
  sessionId: string | null;
  writtenAtMs: number;
}

/** index.ts readAuthCache/writeAuthCache + cache.ts L1 memory, keyed by the
 * raw bearer (the edge keys by sha256(bearer); the mapping is 1:1). */
export class AuthCacheModel {
  entries = new Map<string, CacheEntryModel>();

  read(token: string, provider: Provider | null, now: number): CacheEntryModel | null {
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (entry.memoryExpiresAtMs <= now) {
      this.entries.delete(token);
      return null;
    }
    if (
      (provider === null || entry.provider === provider) &&
      entry.expiresAtMs > now + AUTH_CACHE_READ_GUARD_MS
    ) {
      return entry;
    }
    return null;
  }

  write(
    token: string,
    entry: Omit<CacheEntryModel, "expiresAtMs" | "memoryExpiresAtMs" | "writtenAtMs">,
    bearerExpSeconds: unknown,
    sessionExpSeconds: unknown,
    now: number,
  ): CacheEntryModel | null {
    const bearerExpMs = typeof bearerExpSeconds === "number" ? bearerExpSeconds * 1_000 : 0;
    const sessionExpMs = typeof sessionExpSeconds === "number" ? sessionExpSeconds * 1_000 : 0;
    const expiresAtMs = Math.min(
      bearerExpMs > 0 ? bearerExpMs : Number.MAX_SAFE_INTEGER,
      sessionExpMs > 0 ? sessionExpMs : Number.MAX_SAFE_INTEGER,
      now + AUTH_CACHE_MAX_TTL_SECONDS * 1_000,
    );
    const ttlSeconds = Math.floor((expiresAtMs - now) / 1_000) - 30;
    if (ttlSeconds < 60) return null;
    const written: CacheEntryModel = {
      ...entry,
      expiresAtMs,
      memoryExpiresAtMs: now + ttlSeconds * 1_000,
      writtenAtMs: now,
    };
    this.entries.set(token, written);
    return written;
  }

  del(token: string): void {
    this.entries.delete(token);
  }
}

export type RouteKind =
  | "me"
  | "unknown"
  | "logout"
  | "bootstrap"
  | "refresh"
  | "healthz"
  | "privacy"
  | "support"
  | "terms";

export interface ModelRequest {
  route: RouteKind;
  ip: string;
  bearer: string | null;
  refreshToken?: string | null;
  /** Access-token lifetime the fake will mint for a successful sign-in. */
  mintTtlSeconds: number;
}

export type ExpectedReason =
  | "public_ok"
  | "public_limited"
  | "ip_limited"
  | "authfail_locked"
  | "user_limited"
  | "refresh_limited"
  | "bearer_missing"
  | "bearer_not_jwt"
  | "bearer_expired"
  | "bearer_no_subject"
  | "provider_verify_failed"
  | "auth_upstream_5xx"
  | "session_invalid"
  | "session_provider_unknown"
  | "cache_hit"
  | "verified"
  | "refresh_body_invalid"
  | "refresh_upstream_5xx"
  | "refresh_rejected"
  | "refresh_ok"
  | "logout_upstream_5xx"
  | "route_ok";

export interface Expected {
  status: number;
  reason: ExpectedReason;
  /** Only for 429s. */
  rate?: RateDecision;
  authFailureCharged: boolean;
  /** User the edge should act as (2xx/404 outcomes). */
  userId: string | null;
  /** Was the decision served from the auth cache? */
  fromCache: boolean;
  /** Cache entry the edge should have written (null if none). */
  cacheWritten: CacheEntryModel | null;
  /** Truth from the fake at decision time — used by the spec invariants. */
  truth: BearerTruth;
}

export type BearerTruth =
  | { kind: "none" }
  | { kind: "not_jwt" }
  | { kind: "expired"; expSeconds: number }
  | { kind: "id_token"; provider: Provider; knownSubject: boolean; expSeconds: number | null }
  | {
      kind: "access";
      known: boolean;
      sessionId: string | null;
      revoked: boolean;
      expSeconds: number | null;
    };

const providerForIssuer = (issuer: unknown): Provider | null => {
  if (typeof issuer !== "string") return null;
  const iss = issuer.replace(/^https:\/\//, "");
  if (iss === "accounts.google.com") return "google";
  if (iss === "appleid.apple.com") return "apple";
  return null;
};

export function bearerTruth(fake: FakeSupabase, token: string | null, now: number): BearerTruth {
  if (!token) return { kind: "none" };
  const payload = decodeJwtPayload(token);
  const provider = providerForIssuer(payload?.iss);
  const supabaseIssued = typeof payload?.iss === "string" && payload.iss.endsWith("/auth/v1");
  if (!provider && !supabaseIssued) return { kind: "not_jwt" };
  if (typeof payload?.exp === "number" && payload.exp * 1_000 <= now) {
    return { kind: "expired", expSeconds: payload.exp };
  }
  if (provider) {
    const sub = typeof payload?.sub === "string" ? payload.sub : "";
    return {
      kind: "id_token",
      provider,
      knownSubject: fake.users.has(`${provider}:${sub}`),
      expSeconds: typeof payload?.exp === "number" ? payload.exp : null,
    };
  }
  const record = fake.accessTokens.get(token);
  const session = record ? fake.sessions.get(record.sessionId) : undefined;
  return {
    kind: "access",
    known: Boolean(record),
    sessionId: record?.sessionId ?? null,
    revoked: Boolean(session?.revoked),
    expSeconds: record?.expSeconds ?? null,
  };
}

export class EdgeModel {
  readonly rate = new RateLimitModel();
  readonly cache = new AuthCacheModel();

  constructor(readonly fake: FakeSupabase) {}

  /** Predict the response to `req` at virtual time `now` and advance the model
   * (rate windows, cache) exactly as the edge should. Must be called right
   * before the real dispatch, with no other request in flight. */
  predict(req: ModelRequest, now: number): Expected {
    const truth = bearerTruth(this.fake, req.bearer, now);
    const base = {
      authFailureCharged: false,
      userId: null,
      fromCache: false,
      cacheWritten: null,
      truth,
    };
    const limited = (rate: RateDecision, reason: ExpectedReason): Expected => ({
      ...base,
      status: 429,
      reason,
      rate,
    });

    if (
      req.route === "healthz" ||
      req.route === "privacy" ||
      req.route === "support" ||
      req.route === "terms"
    ) {
      const scope = req.route === "healthz" ? "healthz" : "legal";
      const rl = this.rate.incr(
        scope,
        req.ip,
        LIMITS.publicPage.limit,
        LIMITS.publicPage.windowSeconds,
        now,
      );
      if (!rl.allowed) return limited(rl, "public_limited");
      return { ...base, status: 200, reason: "public_ok" };
    }

    const ipRl = this.rate.incr("ip", req.ip, LIMITS.ip.limit, LIMITS.ip.windowSeconds, now);
    if (!ipRl.allowed) return limited(ipRl, "ip_limited");
    const failures = this.rate.peek(
      "authfail",
      req.ip,
      LIMITS.authfail.limit,
      LIMITS.authfail.windowSeconds,
      now,
    );
    if (!failures.allowed) return limited(failures, "authfail_locked");

    const charge = (): void => {
      this.rate.incr("authfail", req.ip, LIMITS.authfail.limit, LIMITS.authfail.windowSeconds, now);
    };
    const unauthorized = (reason: ExpectedReason): Expected => {
      charge();
      return { ...base, status: 401, reason, authFailureCharged: true };
    };

    if (req.route === "bootstrap") {
      if (truth.kind === "none") return unauthorized("bearer_missing");
      const payload = decodeJwtPayload(req.bearer ?? "");
      if (!providerForIssuer(payload?.iss)) return unauthorized("bearer_not_jwt");
      if (truth.kind === "expired") return unauthorized("bearer_expired");
      if (typeof payload?.sub !== "string" || !payload.sub)
        return unauthorized("bearer_no_subject");
      if (truth.kind !== "id_token") return unauthorized("bearer_not_jwt");
      const fault = this.fake.faults.get(req.bearer ?? "");
      if (fault && fault.kind === "signin" && fault.status >= 500) {
        return { ...base, status: 503, reason: "auth_upstream_5xx" };
      }
      if (!truth.knownSubject) return unauthorized("provider_verify_failed");
      const user = this.fake.users.get(`${truth.provider}:${String(payload.sub)}`)!;
      const userRl = this.rate.incr(
        "user",
        user.id,
        LIMITS.user.limit,
        LIMITS.user.windowSeconds,
        now,
      );
      if (!userRl.allowed) return limited(userRl, "user_limited");
      return { ...base, status: 200, reason: "route_ok", userId: user.id };
    }

    if (req.route === "refresh") {
      const rl = this.rate.incr(
        "auth_refresh",
        req.ip,
        LIMITS.auth_refresh.limit,
        LIMITS.auth_refresh.windowSeconds,
        now,
      );
      if (!rl.allowed) return limited(rl, "refresh_limited");
      const rt = typeof req.refreshToken === "string" ? req.refreshToken.trim() : "";
      if (!rt) return { ...base, status: 400, reason: "refresh_body_invalid" };
      const fault = this.fake.faults.get(rt);
      if (fault && fault.kind === "refresh" && fault.status >= 500) {
        return { ...base, status: 503, reason: "refresh_upstream_5xx" };
      }
      const sessionId = this.fake.refreshTokens.get(rt);
      const session = sessionId ? this.fake.sessions.get(sessionId) : undefined;
      if (!session || session.revoked) return unauthorized("refresh_rejected");
      return { ...base, status: 200, reason: "refresh_ok", userId: session.userId };
    }

    // ── authenticate()
    if (truth.kind === "none") return unauthorized("bearer_missing");
    if (truth.kind === "not_jwt") return unauthorized("bearer_not_jwt");
    if (truth.kind === "expired") return unauthorized("bearer_expired");
    const token = req.bearer ?? "";
    const payload = decodeJwtPayload(token);
    const provider = truth.kind === "id_token" ? truth.provider : null;

    let userId: string;
    let fromCache = false;
    let cacheWritten: CacheEntryModel | null = null;
    const cached = this.cache.read(token, provider, now);
    if (cached) {
      userId = cached.userId;
      fromCache = true;
    } else if (truth.kind === "id_token") {
      const fault = this.fake.faults.get(token);
      if (fault && fault.kind === "signin" && fault.status >= 500) {
        return { ...base, status: 503, reason: "auth_upstream_5xx" };
      }
      if (!truth.knownSubject) return unauthorized("provider_verify_failed");
      const user = this.fake.users.get(`${truth.provider}:${String(payload?.sub)}`)!;
      userId = user.id;
      const sessionExp = Math.floor(now / 1000) + req.mintTtlSeconds;
      cacheWritten = this.cache.write(
        token,
        { userId, provider: truth.provider, sessionId: "minted-by-authenticate" },
        payload?.exp,
        sessionExp,
        now,
      );
    } else {
      const fault = this.fake.faults.get(token);
      if (fault && fault.kind === "getuser" && fault.status >= 500) {
        return { ...base, status: 503, reason: "auth_upstream_5xx" };
      }
      if (!truth.known || truth.revoked) return unauthorized("session_invalid");
      const record = this.fake.accessTokens.get(token)!;
      const user = this.fake.usersById.get(record.userId)!;
      userId = user.id;
      cacheWritten = this.cache.write(
        token,
        { userId, provider: user.provider, sessionId: record.sessionId },
        payload?.exp,
        payload?.exp,
        now,
      );
    }

    const userRl = this.rate.incr(
      "user",
      userId,
      LIMITS.user.limit,
      LIMITS.user.windowSeconds,
      now,
    );
    if (!userRl.allowed) {
      return {
        ...base,
        status: 429,
        reason: "user_limited",
        rate: userRl,
        userId,
        fromCache,
        cacheWritten,
      };
    }

    const authed = { ...base, userId, fromCache, cacheWritten };
    switch (req.route) {
      case "me":
        return { ...authed, status: 200, reason: "route_ok" };
      case "unknown":
        return { ...authed, status: 404, reason: "route_ok" };
      case "logout": {
        this.cache.del(token);
        const fault = this.fake.faults.get(token);
        if (fault && fault.kind === "logout" && fault.status >= 500) {
          return { ...authed, status: 503, reason: "logout_upstream_5xx" };
        }
        return { ...authed, status: 204, reason: "route_ok" };
      }
    }
  }
}
