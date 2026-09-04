// Seeded randomized state-machine campaign over the real edge function.
//
// One seed = one "batch" of >= 2000 requests in three phases:
//   A  sequential, single isolate, no Redis, EXACT oracle (model.ts) — every
//      response's status and 429 headers must equal the model's prediction;
//   B  concurrent, single isolate — requests are launched without waiting and
//      upstream Auth calls park in a gate whose release order is random;
//   C  concurrent across THREE isolates sharing one fake Redis (L2), the
//      production topology.
// Every phase also checks the specification-level invariants below, which do
// not depend on any implementation detail and hold across interleavings.
//
// Randomness: request kind, bearer kind, IP, clock advance (forward jumps
// through rate-limit windows and cache TTLs; backward skew in phase A),
// token lifetimes, gate release order, response-latency side, fault injection.

import type { EdgeIsolate } from "./edgeIsolates.ts";
import { FakeSupabase, type GateEntry, type Provider, type UpstreamKind } from "./fakeSupabase.ts";
import {
  EdgeModel,
  LIMITS,
  type Expected,
  type ModelRequest,
  type RouteKind,
  bearerTruth,
} from "./model.ts";
import { Prng } from "./prng.ts";
import { decodeJwtPayload, fakeIdToken, forgeSignature, withExp } from "./tokens.ts";
import type { VirtualClock } from "./virtualClock.ts";

export type Phase = "A" | "B" | "C";

export type BearerKind =
  | "access_pool"
  | "access_revoked_pool"
  | "access_expired_session"
  | "access_forged"
  | "access_tampered_exp"
  | "id_google"
  | "id_apple"
  | "id_unknown_sub"
  | "id_expired"
  | "id_skewed"
  | "id_other_iss"
  | "garbage"
  | "missing";

export type InvariantId =
  | "MODEL_EXACT"
  | "EXPIRED_BEARER_REFUSED"
  | "REVOKED_SESSION_REFUSED"
  | "UNKNOWN_BEARER_REFUSED"
  | "RATE_LIMIT_RESPONSE_SHAPE"
  | "IP_BUDGET"
  | "AUTHFAIL_LOCK"
  | "AUTHFAIL_BOUND"
  | "USER_BUDGET"
  | "REFRESH_BUDGET"
  | "REFRESH_ROTATION"
  | "UPSTREAM_5XX_NOT_AUTH_FAILURE";

/** Soft invariants are recorded and reported but do not fail a seed: they
 * describe behaviour the contract leaves open (a design question), not a
 * violation of a documented guarantee. */
export const SOFT_INVARIANTS: ReadonlySet<InvariantId> = new Set<InvariantId>([]);

export interface Spec {
  idx: number;
  phase: Phase;
  isolate: string;
  route: RouteKind;
  method: string;
  path: string;
  ip: string;
  bearerKind: BearerKind | "n/a";
  token: string | null;
  tokenRef: string | null;
  sessionRef: string | null;
  userRef: string | null;
  refreshToken: string | null;
  refreshRef: string | null;
  fault: { kind: UpstreamKind; status: number } | null;
  mintTtlSeconds: number;
  draws: number;
}

export interface Outcome {
  status: number;
  retryAfter: number | null;
  rateLimit: number | null;
  rateRemaining: number | null;
  cacheControl: string | null;
  requestId: string | null;
  bodyCode: string | null;
  bodyMessage: string | null;
}

export interface RequestRecord {
  spec: Spec;
  launchEvent: number;
  completeEvent: number;
  launchedAtMs: number;
  completedAtMs: number;
  truthAtLaunch: ReturnType<typeof bearerTruth>;
  revokedConfirmedAtLaunch: boolean;
  outcome: Outcome;
  expected: Expected | null;
  violations: InvariantId[];
}

export interface Failure {
  seed: number;
  phase: Phase;
  invariant: InvariantId;
  soft: boolean;
  idx: number;
  detail: string;
  spec: Omit<Spec, "token" | "refreshToken"> & { tokenSha8: string | null };
  truthAtLaunch: ReturnType<typeof bearerTruth>;
  launchedAtMs: number;
  completedAtMs: number;
  launchEvent: number;
  completeEvent: number;
  outcome: Outcome;
  expected: Expected | null;
  recentAccessLog: string[];
  replay: string;
}

export interface SeedResult {
  seed: number;
  epochMs: number;
  requests: number;
  perPhase: Record<Phase, number>;
  statusCounts: Record<string, number>;
  truthStatusMatrix: Record<string, Record<string, number>>;
  bearerKindStatusMatrix: Record<string, Record<string, number>>;
  reasonStatusMatrix: Record<string, Record<string, number>>;
  upstreamFaultMatrix: Record<string, Record<string, number>>;
  invariantViolations: Record<string, number>;
  hardFailures: number;
  softFailures: number;
  failures: Failure[];
  upstreamCalls: Record<string, number>;
  cacheHitsPredicted: number;
  clock: { forwardMs: number; backwardJumps: number; finalMs: number };
  heap: { rss: number; heapTotal: number; heapUsed: number; external: number };
  redisKeys: number;
  wallMs: number;
  maxInflight: number;
}

export interface CampaignOptions {
  /** Minimum requests per seed (phase split is derived). */
  minRequests: number;
  /** Probability that phase A includes an IP-budget flood (>1200/min). */
  floodChanceA: number;
  /** Probability that phase C includes a cross-isolate IP flood. */
  floodChanceC: number;
  maxInflight: number;
  /** Keep the full access log for this seed (others keep a ring buffer). */
  accessLogSink?: (line: string) => void;
}

export const DEFAULT_OPTIONS: CampaignOptions = {
  minRequests: 2000,
  floodChanceA: 0.35,
  floodChanceC: 0.25,
  maxInflight: 16,
};

interface PoolAccess {
  token: string;
  ref: string;
  expSeconds: number;
  usedCount: number;
}

interface PoolSession {
  id: string;
  ref: string;
  userId: string;
  userRef: string;
  provider: Provider;
  refreshToken: string;
  refreshRef: string;
  access: PoolAccess[];
  /** Event index at which a logout 204 for this session was OBSERVED. */
  revokedConfirmedEvent: number | null;
  revokedBy: { idx: number; isolate: string; tokenRef: string | null } | null;
  /** Request idx values that used this session's bearers and completed after
   * the logout's cacheDel (its launch) — i.e. verifications that could have
   * re-written the auth cache behind the logout (the getUser/logout write race). */
  inflightAtRevoke: number[];
  /** Event index at which a refresh 200 for `refreshToken` was observed. */
  rotatedEvents: Map<string, number>;
}

interface PoolIdToken {
  token: string;
  ref: string;
  provider: Provider;
  sub: string;
  expSeconds: number;
  known: boolean;
}

interface Users {
  id: string;
  ref: string;
  provider: Provider;
  subject: string;
}

const EPOCH_BASE_MS = Date.UTC(2026, 8, 4, 0, 0, 0);

const sha8 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest).slice(0, 4)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const bump = (matrix: Record<string, Record<string, number>>, row: string, col: string): void => {
  const r = (matrix[row] ??= {});
  r[col] = (r[col] ?? 0) + 1;
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export class SeedRun {
  readonly prng: Prng;
  readonly fake = new FakeSupabase();
  readonly model: EdgeModel;
  readonly users: Users[] = [];
  readonly ips: string[];
  readonly hotIp: string;
  readonly sessions = new Map<string, PoolSession>();
  readonly idTokens: PoolIdToken[] = [];
  readonly records: RequestRecord[] = [];
  readonly failures: Failure[] = [];
  readonly accessLogRing: string[] = [];
  readonly epochMs: number;
  events = 0;
  idx = 0;
  backwardJumps = 0;
  cacheHitsPredicted = 0;
  private refreshSuccesses = new Map<string, number>();
  private refreshTokenRefs = new Map<string, string>();
  private tokenRefs = new Map<string, string>();
  private refCounter = 0;
  private parked: GateEntry[] = [];
  private inflight = new Set<Promise<void>>();

  constructor(
    readonly seed: number,
    readonly clock: VirtualClock,
    readonly isolates: { solo: EdgeIsolate; cluster: EdgeIsolate[] },
    readonly options: CampaignOptions,
  ) {
    this.prng = new Prng(seed);
    this.model = new EdgeModel(this.fake);
    const day = seed - 3000;
    this.epochMs = EPOCH_BASE_MS + day * 86_400_000 + this.prng.int(60_000);
    const a = (seed >> 8) & 255;
    const b = seed & 255;
    this.ips = [0, 1, 2, 3].map((k) => `10.${a}.${b}.${k + 1}`);
    this.hotIp = this.ips[0];
    for (let n = 0; n < 8; n += 1) {
      const provider: Provider = n % 3 === 2 ? "apple" : "google";
      const user: Users = {
        id: `${seed.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
        ref: `U${n}`,
        provider,
        subject: `sub-${seed}-${n}`,
      };
      this.users.push(user);
      this.fake.addUser({
        id: user.id,
        provider,
        subject: user.subject,
        email: `${user.ref}@example.test`,
      });
    }
  }

  private ref(prefix: string): string {
    this.refCounter += 1;
    return `${prefix}${this.refCounter}`;
  }

  recordAccessLog(line: string): void {
    this.accessLogRing.push(line);
    if (this.accessLogRing.length > 40) this.accessLogRing.shift();
    this.options.accessLogSink?.(line);
  }

  // ── Pools ──────────────────────────────────────────────────────────────────

  private activeSessions(): PoolSession[] {
    return [...this.sessions.values()].filter((s) => s.revokedConfirmedEvent === null);
  }

  private revokedSessions(): PoolSession[] {
    return [...this.sessions.values()].filter((s) => s.revokedConfirmedEvent !== null);
  }

  private adoptSession(body: unknown, userId: string): PoolSession | null {
    if (!body || typeof body !== "object") return null;
    const session = (body as { session?: Record<string, unknown> }).session;
    if (
      !session ||
      typeof session.accessToken !== "string" ||
      typeof session.refreshToken !== "string"
    ) {
      return null;
    }
    const payload = decodeJwtPayload(session.accessToken);
    const sessionId = typeof payload?.session_id === "string" ? payload.session_id : null;
    const expSeconds = typeof payload?.exp === "number" ? payload.exp : 0;
    if (!sessionId) return null;
    const user = this.users.find((u) => u.id === userId);
    let pooled = this.sessions.get(sessionId);
    const tokenRef = this.ref("T");
    this.tokenRefs.set(session.accessToken, tokenRef);
    const refreshRef = this.ref("R");
    this.refreshTokenRefs.set(session.refreshToken, refreshRef);
    if (!pooled) {
      pooled = {
        id: sessionId,
        ref: this.ref("S"),
        userId,
        userRef: user?.ref ?? "?",
        provider: user?.provider ?? "google",
        refreshToken: session.refreshToken,
        refreshRef,
        access: [],
        revokedConfirmedEvent: null,
        revokedBy: null,
        inflightAtRevoke: [],
        rotatedEvents: new Map(),
      };
      this.sessions.set(sessionId, pooled);
    } else {
      pooled.refreshToken = session.refreshToken;
      pooled.refreshRef = refreshRef;
    }
    pooled.access.push({ token: session.accessToken, ref: tokenRef, expSeconds, usedCount: 0 });
    return pooled;
  }

  private pickAccess(session: PoolSession): PoolAccess {
    // Prefer the newest token most of the time; older siblings sometimes.
    const idx = this.prng.chance(0.7)
      ? session.access.length - 1
      : this.prng.int(session.access.length);
    return session.access[idx];
  }

  private mintIdToken(provider: Provider, known: boolean, expOffsetSeconds: number): PoolIdToken {
    const nowSeconds = Math.floor(this.clock.now() / 1000);
    const user = this.prng.pick(this.users.filter((u) => u.provider === provider));
    const sub = known ? user.subject : `ghost-${this.seed}-${this.prng.int(1_000_000)}`;
    const ref = this.ref("I");
    const token = fakeIdToken(provider, sub, nowSeconds + expOffsetSeconds, `${this.seed}-${ref}`);
    this.tokenRefs.set(token, ref);
    const pooled: PoolIdToken = {
      token,
      ref,
      provider,
      sub,
      expSeconds: nowSeconds + expOffsetSeconds,
      known,
    };
    if (known) {
      this.idTokens.push(pooled);
      if (this.idTokens.length > 12) this.idTokens.shift();
    }
    return pooled;
  }

  private mintTtl(): number {
    return Number(this.prng.weighted({ "3600": 55, "900": 15, "180": 12, "95": 10, "50": 8 }));
  }

  // ── Request generation ────────────────────────────────────────────────────

  private pickIp(): string {
    return this.prng.chance(0.55) ? this.hotIp : this.prng.pick(this.ips);
  }

  private baseSpec(
    phase: Phase,
    isolate: EdgeIsolate,
    route: RouteKind,
    method: string,
    path: string,
  ): Spec {
    this.idx += 1;
    return {
      idx: this.idx,
      phase,
      isolate: isolate.id,
      route,
      method,
      path,
      ip: this.pickIp(),
      bearerKind: "n/a",
      token: null,
      tokenRef: null,
      sessionRef: null,
      userRef: null,
      refreshToken: null,
      refreshRef: null,
      fault: null,
      mintTtlSeconds: 3600,
      draws: this.prng.draws,
    };
  }

  private authedPath(route: RouteKind): { method: string; path: string } {
    switch (route) {
      case "me":
        return { method: "GET", path: "/v1/me" };
      case "unknown":
        return { method: "GET", path: `/v1/xc/unknown-${this.prng.int(4)}` };
      case "logout":
        return { method: "POST", path: "/v1/auth/logout" };
      default:
        throw new Error(`not an authed route: ${route}`);
    }
  }

  /** Attach a bearer of the requested kind to `spec`. Returns false when the
   * kind is not currently possible (e.g. no revoked session yet). */
  private attachBearer(spec: Spec, kind: BearerKind): boolean {
    const active = this.activeSessions();
    const nowSeconds = Math.floor(this.clock.now() / 1000);
    const setAccess = (session: PoolSession, access: PoolAccess): void => {
      access.usedCount += 1;
      spec.token = access.token;
      spec.tokenRef = access.ref;
      spec.sessionRef = session.ref;
      spec.userRef = session.userRef;
    };
    spec.bearerKind = kind;
    switch (kind) {
      case "access_pool": {
        if (active.length === 0) return false;
        const session = this.prng.pick(active);
        setAccess(session, this.pickAccess(session));
        return true;
      }
      case "access_revoked_pool": {
        const revoked = this.revokedSessions();
        if (revoked.length === 0) return false;
        const session = this.prng.pick(revoked);
        setAccess(session, this.pickAccess(session));
        return true;
      }
      case "access_expired_session": {
        const expired = [...this.sessions.values()].filter((s) =>
          s.access.some((a) => a.expSeconds <= nowSeconds),
        );
        if (expired.length === 0) return false;
        const session = this.prng.pick(expired);
        setAccess(
          session,
          this.prng.pick(session.access.filter((a) => a.expSeconds <= nowSeconds)),
        );
        return true;
      }
      case "access_forged": {
        if (active.length === 0) return false;
        const session = this.prng.pick(active);
        const access = this.pickAccess(session);
        spec.token = forgeSignature(access.token, `${this.seed}-${spec.idx}`);
        spec.tokenRef = `${access.ref}~forged`;
        spec.sessionRef = session.ref;
        spec.userRef = session.userRef;
        return true;
      }
      case "access_tampered_exp": {
        if (active.length === 0) return false;
        const session = this.prng.pick(active);
        const access = this.pickAccess(session);
        const exp = nowSeconds + this.prng.range(-120, 7200);
        spec.token = withExp(access.token, exp, `${this.seed}-${spec.idx}`);
        spec.tokenRef = `${access.ref}~exp${exp - nowSeconds}`;
        spec.sessionRef = session.ref;
        spec.userRef = session.userRef;
        return true;
      }
      case "id_google":
      case "id_apple": {
        const provider: Provider = kind === "id_google" ? "google" : "apple";
        const pooled = this.idTokens.filter(
          (t) => t.provider === provider && t.expSeconds > nowSeconds,
        );
        const reuse = pooled.length > 0 && this.prng.chance(0.65);
        const idToken = reuse
          ? this.prng.pick(pooled)
          : this.mintIdToken(provider, true, this.prng.range(120, 7200));
        spec.token = idToken.token;
        spec.tokenRef = idToken.ref;
        spec.userRef = this.users.find((u) => u.subject === idToken.sub)?.ref ?? null;
        return true;
      }
      case "id_unknown_sub": {
        const idToken = this.mintIdToken(this.prng.pick(["google", "apple"]), false, 3600);
        spec.token = idToken.token;
        spec.tokenRef = idToken.ref;
        return true;
      }
      case "id_expired": {
        const idToken = this.mintIdToken(
          this.prng.pick(["google", "apple"]),
          true,
          -this.prng.range(1, 7200),
        );
        spec.token = idToken.token;
        spec.tokenRef = idToken.ref;
        return true;
      }
      case "id_skewed": {
        // Client clock skew: exp within ±3s of the server's now.
        const idToken = this.mintIdToken(
          this.prng.pick(["google", "apple"]),
          true,
          this.prng.range(-3, 3),
        );
        spec.token = idToken.token;
        spec.tokenRef = idToken.ref;
        return true;
      }
      case "id_other_iss": {
        spec.token = fakeIdToken("other", "someone", nowSeconds + 3600, `${this.seed}-${spec.idx}`);
        spec.tokenRef = "other-iss";
        return true;
      }
      case "garbage": {
        spec.token = this.prng.pick([
          "",
          "not.a.jwt",
          "a.b",
          "eyJ.eyJ.sig",
          "Bearer nested",
          "null",
        ]);
        if (spec.token === "") spec.token = `${this.prng.int(1e9)}`;
        spec.tokenRef = "garbage";
        return true;
      }
      case "missing":
        spec.token = null;
        spec.tokenRef = null;
        return true;
    }
  }

  private nextAuthedSpec(phase: Phase, isolate: EdgeIsolate, routeOverride?: RouteKind): Spec {
    const route: RouteKind =
      routeOverride ?? this.prng.weighted({ me: 70, unknown: 12, logout: 18 });
    const { method, path } = this.authedPath(route);
    const spec = this.baseSpec(phase, isolate, route, method, path);
    const kind = this.prng.weighted<BearerKind>({
      access_pool: 52,
      access_revoked_pool: 8,
      access_expired_session: 4,
      access_forged: 3,
      access_tampered_exp: 3,
      id_google: 9,
      id_apple: 4,
      id_unknown_sub: 2,
      id_expired: 2,
      id_skewed: 3,
      id_other_iss: 1,
      garbage: 2,
      missing: 1,
    });
    if (!this.attachBearer(spec, kind)) {
      // Fall back to a fresh provider token — always possible.
      this.attachBearer(spec, "id_google");
    }
    spec.mintTtlSeconds = this.mintTtl();
    if (spec.token && spec.bearerKind.startsWith("id_")) {
      this.fake.mintTtlByCredential.set(spec.token, spec.mintTtlSeconds);
    }
    // Rare upstream fault: Supabase Auth answers 5xx to getUser / sign-in.
    if (spec.token && this.prng.chance(0.012)) {
      const kindUp: UpstreamKind = spec.bearerKind.startsWith("id_") ? "signin" : "getuser";
      spec.fault = { kind: kindUp, status: this.prng.pick([500, 503]) };
      this.fake.faults.set(spec.token, spec.fault);
    } else if (route === "logout" && spec.token && this.prng.chance(0.03)) {
      spec.fault = { kind: "logout", status: 500 };
      this.fake.faults.set(spec.token, spec.fault);
    }
    return spec;
  }

  private nextBootstrapSpec(phase: Phase, isolate: EdgeIsolate): Spec {
    const spec = this.baseSpec(phase, isolate, "bootstrap", "POST", "/v1/account/bootstrap");
    const kind = this.prng.weighted<BearerKind>({
      id_google: 70,
      id_apple: 12,
      id_unknown_sub: 6,
      id_expired: 5,
      id_skewed: 4,
      access_pool: 2,
      garbage: 1,
    });
    if (!this.attachBearer(spec, kind)) this.attachBearer(spec, "id_google");
    spec.mintTtlSeconds = this.mintTtl();
    if (spec.token) this.fake.mintTtlByCredential.set(spec.token, spec.mintTtlSeconds);
    if (spec.token && spec.bearerKind.startsWith("id_") && this.prng.chance(0.01)) {
      spec.fault = { kind: "signin", status: 500 };
      this.fake.faults.set(spec.token, spec.fault);
    }
    return spec;
  }

  private nextRefreshSpec(phase: Phase, isolate: EdgeIsolate): Spec {
    const spec = this.baseSpec(phase, isolate, "refresh", "POST", "/v1/auth/refresh");
    const active = this.activeSessions();
    const choice = this.prng.weighted({
      current: 68,
      rotated: 12,
      revoked: 10,
      garbage: 6,
      empty: 4,
    });
    if (choice === "current" && active.length > 0) {
      const session = this.prng.pick(active);
      spec.refreshToken = session.refreshToken;
      spec.refreshRef = session.refreshRef;
      spec.sessionRef = session.ref;
      spec.userRef = session.userRef;
    } else if (choice === "rotated") {
      const rotated = [...this.sessions.values()].filter((s) => s.rotatedEvents.size > 0);
      if (rotated.length > 0) {
        const session = this.prng.pick(rotated);
        spec.refreshToken = this.prng.pick([...session.rotatedEvents.keys()]);
        spec.refreshRef = this.refreshTokenRefs.get(spec.refreshToken) ?? "R?";
        spec.sessionRef = session.ref;
        spec.userRef = session.userRef;
      } else {
        spec.refreshToken = `rt-nonexistent-${this.prng.int(1e6)}`;
        spec.refreshRef = "R-ghost";
      }
    } else if (choice === "revoked") {
      const revoked = this.revokedSessions();
      if (revoked.length > 0) {
        const session = this.prng.pick(revoked);
        spec.refreshToken = session.refreshToken;
        spec.refreshRef = session.refreshRef;
        spec.sessionRef = session.ref;
        spec.userRef = session.userRef;
      } else {
        spec.refreshToken = `rt-nonexistent-${this.prng.int(1e6)}`;
        spec.refreshRef = "R-ghost";
      }
    } else if (choice === "garbage") {
      spec.refreshToken = `rt-nonexistent-${this.prng.int(1e6)}`;
      spec.refreshRef = "R-ghost";
    } else {
      spec.refreshToken = this.prng.pick(["", "   "]);
      spec.refreshRef = "R-empty";
    }
    if (choice === "current" && active.length === 0) {
      spec.refreshToken = `rt-nonexistent-${this.prng.int(1e6)}`;
      spec.refreshRef = "R-ghost";
    }
    spec.mintTtlSeconds = this.mintTtl();
    if (spec.refreshToken)
      this.fake.mintTtlByCredential.set(spec.refreshToken, spec.mintTtlSeconds);
    return spec;
  }

  private nextPublicSpec(phase: Phase, isolate: EdgeIsolate): Spec {
    const route = this.prng.weighted<RouteKind>({ healthz: 5, privacy: 2, support: 1, terms: 1 });
    return this.baseSpec(
      phase,
      isolate,
      route,
      this.prng.chance(0.15) ? "HEAD" : "GET",
      `/${route}`,
    );
  }

  nextSpec(phase: Phase, isolate: EdgeIsolate): Spec {
    const family = this.prng.weighted({ authed: 74, bootstrap: 9, refresh: 11, public: 6 });
    switch (family) {
      case "authed":
        return this.nextAuthedSpec(phase, isolate);
      case "bootstrap":
        return this.nextBootstrapSpec(phase, isolate);
      case "refresh":
        return this.nextRefreshSpec(phase, isolate);
      default:
        return this.nextPublicSpec(phase, isolate);
    }
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  private buildRequest(spec: Spec): Request {
    const headers = new Headers({ "x-forwarded-for": `198.51.100.7, ${spec.ip}` });
    if (spec.token !== null) headers.set("Authorization", `Bearer ${spec.token}`);
    let body: string | undefined;
    if (spec.route === "refresh") {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify({ refreshToken: spec.refreshToken });
    } else if (spec.route === "bootstrap") {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify({});
    }
    const mount = this.prng.chance(0.2) ? "/api" : "/functions/v1/api";
    return new Request(`http://edge.test${mount}${spec.path}`, {
      method: spec.method,
      headers,
      body,
    });
  }

  private async readOutcome(response: Response): Promise<Outcome & { body: unknown }> {
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    const error =
      body && typeof body === "object" ? (body as { error?: Record<string, unknown> }).error : null;
    const retry = response.headers.get("Retry-After");
    const limit = response.headers.get("RateLimit-Limit");
    const remaining = response.headers.get("RateLimit-Remaining");
    return {
      status: response.status,
      retryAfter: retry === null ? null : Number(retry),
      rateLimit: limit === null ? null : Number(limit),
      rateRemaining: remaining === null ? null : Number(remaining),
      cacheControl: response.headers.get("Cache-Control"),
      requestId: response.headers.get("x-request-id"),
      bodyCode: error && typeof error.code === "string" ? error.code : null,
      bodyMessage: error && typeof error.message === "string" ? error.message : null,
      body,
    };
  }

  private modelRequest(spec: Spec): ModelRequest {
    return {
      route: spec.route,
      ip: spec.ip,
      bearer: spec.token,
      refreshToken: spec.refreshToken,
      mintTtlSeconds: spec.mintTtlSeconds,
    };
  }

  private isolateById(id: string): EdgeIsolate {
    if (this.isolates.solo.id === id) return this.isolates.solo;
    const found = this.isolates.cluster.find((iso) => iso.id === id);
    if (!found) throw new Error(`unknown isolate ${id}`);
    return found;
  }

  private launch(spec: Spec, expected: Expected | null): Promise<RequestRecord> {
    const isolate = this.isolateById(spec.isolate);
    const now = this.clock.now();
    const truth = bearerTruth(this.fake, spec.token, now);
    const session = spec.sessionRef
      ? ([...this.sessions.values()].find((s) => s.ref === spec.sessionRef) ?? null)
      : null;
    this.events += 1;
    const record: RequestRecord = {
      spec,
      launchEvent: this.events,
      completeEvent: -1,
      launchedAtMs: now,
      completedAtMs: -1,
      truthAtLaunch: truth,
      revokedConfirmedAtLaunch: Boolean(session && session.revokedConfirmedEvent !== null),
      outcome: {
        status: -1,
        retryAfter: null,
        rateLimit: null,
        rateRemaining: null,
        cacheControl: null,
        requestId: null,
        bodyCode: null,
        bodyMessage: null,
      },
      expected,
      violations: [],
    };
    this.records.push(record);
    const request = this.buildRequest(spec);
    const done = isolate.handler(request).then(async (response) => {
      const outcome = await this.readOutcome(response);
      this.events += 1;
      record.completeEvent = this.events;
      record.completedAtMs = this.clock.now();
      const { body, ...rest } = outcome;
      record.outcome = rest;
      this.onComplete(record, body);
      return record;
    });
    const tracked = done.then(() => undefined);
    this.inflight.add(tracked);
    tracked.finally(() => this.inflight.delete(tracked));
    return done;
  }

  private onComplete(record: RequestRecord, body: unknown): void {
    const { spec, outcome } = record;
    if ((spec.route === "bootstrap" || spec.route === "refresh") && outcome.status === 200) {
      const userId =
        body && typeof body === "object" && (body as { user?: { id?: string } }).user?.id
          ? String((body as { user: { id: string } }).user.id)
          : (record.expected?.userId ?? this.sessionUserFromRefresh(spec.refreshToken) ?? "");
      const adopted = this.adoptSession(body, userId);
      if (spec.route === "refresh" && spec.refreshToken) {
        this.refreshSuccesses.set(
          spec.refreshToken,
          (this.refreshSuccesses.get(spec.refreshToken) ?? 0) + 1,
        );
        if (adopted) adopted.rotatedEvents.set(spec.refreshToken, record.completeEvent);
      }
    }
    if (spec.route === "logout" && outcome.status === 204 && spec.sessionRef) {
      const session = [...this.sessions.values()].find((s) => s.ref === spec.sessionRef);
      if (session && session.revokedConfirmedEvent === null) {
        session.revokedConfirmedEvent = record.completeEvent;
        session.revokedBy = { idx: spec.idx, isolate: spec.isolate, tokenRef: spec.tokenRef };
        session.inflightAtRevoke = this.records
          .filter(
            (r) =>
              r.spec.sessionRef === spec.sessionRef &&
              r.spec.idx !== spec.idx &&
              r.launchEvent < record.completeEvent &&
              (r.completedAtMs < 0 || r.completeEvent > record.launchEvent),
          )
          .map((r) => r.spec.idx);
      }
    }
    this.checkInvariants(record);
  }

  private sessionUserFromRefresh(refreshToken: string | null): string | null {
    if (!refreshToken) return null;
    for (const session of this.sessions.values()) {
      if (session.refreshToken === refreshToken || session.rotatedEvents.has(refreshToken))
        return session.userId;
    }
    return null;
  }

  // ── Invariants ────────────────────────────────────────────────────────────

  private fail(record: RequestRecord, invariant: InvariantId, detail: string): void {
    record.violations.push(invariant);
    const { token: _token, refreshToken: _refreshToken, ...specRest } = record.spec;
    this.failures.push({
      seed: this.seed,
      phase: record.spec.phase,
      invariant,
      soft: SOFT_INVARIANTS.has(invariant),
      idx: record.spec.idx,
      detail,
      spec: { ...specRest, tokenSha8: null },
      truthAtLaunch: record.truthAtLaunch,
      launchedAtMs: record.launchedAtMs,
      completedAtMs: record.completedAtMs,
      launchEvent: record.launchEvent,
      completeEvent: record.completeEvent,
      outcome: record.outcome,
      expected: record.expected,
      recentAccessLog: [...this.accessLogRing],
      replay: `deno run -A --no-check --config deno.json xc_rsm_c/scripts/run_campaign.ts --seeds ${this.seed} --focus ${record.spec.idx}`,
    });
  }

  private isAuthedRoute(route: RouteKind): boolean {
    return route === "me" || route === "unknown" || route === "logout";
  }

  private checkInvariants(record: RequestRecord): void {
    const { spec, outcome, truthAtLaunch: truth, expected } = record;
    // "Refused" = the bearer did NOT authorize the request: invalid (401),
    // budget-locked (429), or unverifiable because Supabase Auth was down (503).
    const refused = outcome.status === 401 || outcome.status === 429 || outcome.status === 503;
    const authedRoute = this.isAuthedRoute(spec.route);

    if (expected) {
      const mismatch: string[] = [];
      if (outcome.status !== expected.status)
        mismatch.push(`status ${outcome.status} != ${expected.status}`);
      if (expected.status === 429 && expected.rate) {
        if (outcome.retryAfter !== expected.rate.retryAfterSeconds) {
          mismatch.push(`Retry-After ${outcome.retryAfter} != ${expected.rate.retryAfterSeconds}`);
        }
        if (outcome.rateLimit !== expected.rate.limit) {
          mismatch.push(`RateLimit-Limit ${outcome.rateLimit} != ${expected.rate.limit}`);
        }
        if (outcome.rateRemaining !== expected.rate.remaining) {
          mismatch.push(
            `RateLimit-Remaining ${outcome.rateRemaining} != ${expected.rate.remaining}`,
          );
        }
      }
      if (mismatch.length > 0) {
        this.fail(
          record,
          "MODEL_EXACT",
          `${mismatch.join("; ")} (model reason: ${expected.reason})`,
        );
      }
      if (expected.fromCache) this.cacheHitsPredicted += 1;
    }

    if (authedRoute || spec.route === "bootstrap") {
      if (truth.kind === "expired" && record.completedAtMs >= record.launchedAtMs && !refused) {
        this.fail(
          record,
          "EXPIRED_BEARER_REFUSED",
          `expired bearer (exp=${truth.expSeconds}) got ${outcome.status}`,
        );
      }
      if (truth.kind === "none" || truth.kind === "not_jwt") {
        if (!refused)
          this.fail(record, "UNKNOWN_BEARER_REFUSED", `${truth.kind} bearer got ${outcome.status}`);
      }
      if (truth.kind === "id_token" && !truth.knownSubject && !refused) {
        this.fail(
          record,
          "UNKNOWN_BEARER_REFUSED",
          `unknown provider subject got ${outcome.status}`,
        );
      }
      if (truth.kind === "access" && !truth.known && !refused) {
        this.fail(
          record,
          "UNKNOWN_BEARER_REFUSED",
          `forged/tampered access token got ${outcome.status}`,
        );
      }
      if (truth.kind === "access" && truth.known && record.revokedConfirmedAtLaunch && !refused) {
        const session = [...this.sessions.values()].find((s) => s.ref === spec.sessionRef);
        const by = session?.revokedBy;
        let mechanism: string;
        if (by && by.tokenRef !== spec.tokenRef) {
          mechanism = `sibling bearer: logout presented ${by.tokenRef}, cacheDel only covers that hash; ${spec.tokenRef} of the same session stayed cached`;
        } else if (by && by.isolate !== spec.isolate) {
          mechanism =
            "cross-isolate: logout only dropped its own L1 + Redis; this isolate's L1 still holds the bearer";
        } else {
          mechanism = `same-isolate: a verify for this bearer completed after the logout's cacheDel (idx ${session?.inflightAtRevoke.join(",") || "none"}) and re-wrote the cache`;
        }
        this.fail(
          record,
          "REVOKED_SESSION_REFUSED",
          `bearer of session ${spec.sessionRef} got ${outcome.status} on isolate ${spec.isolate} after logout 204 (idx ${by?.idx} on ${by?.isolate}, event ${session?.revokedConfirmedEvent}, launched at event ${record.launchEvent}); ${mechanism}`,
        );
      }
      // An armed fault only counts once Supabase Auth was actually consulted
      // (the one-shot fault got consumed); bearers refused locally — expired,
      // garbage, foreign issuer — never reach the upstream and are 401s.
      const faultConsumed =
        spec.fault !== null &&
        spec.token !== null &&
        this.fake.faults.get(spec.token)?.kind !== spec.fault.kind;
      if (spec.fault && spec.fault.status >= 500 && outcome.status === 401 && faultConsumed) {
        if (spec.fault.kind === "getuser" || spec.fault.kind === "signin") {
          this.fail(
            record,
            "UPSTREAM_5XX_NOT_AUTH_FAILURE",
            `Supabase Auth ${spec.fault.kind} answered ${spec.fault.status}; edge returned 401 (charged as an auth failure)`,
          );
        }
      }
    }

    if (outcome.status === 429) {
      const problems: string[] = [];
      const limit = outcome.rateLimit;
      const window = limit === LIMITS.authfail.limit ? LIMITS.authfail.windowSeconds : 60;
      if (
        outcome.retryAfter === null ||
        !Number.isInteger(outcome.retryAfter) ||
        outcome.retryAfter < 1
      ) {
        problems.push(`Retry-After=${outcome.retryAfter}`);
      } else if (outcome.retryAfter > window) {
        problems.push(`Retry-After ${outcome.retryAfter} > window ${window}`);
      }
      const knownLimits: number[] = [
        LIMITS.ip.limit,
        LIMITS.authfail.limit,
        LIMITS.user.limit,
        LIMITS.publicPage.limit,
      ];
      if (limit === null || !knownLimits.includes(limit)) problems.push(`RateLimit-Limit=${limit}`);
      if (outcome.rateRemaining !== 0)
        problems.push(`RateLimit-Remaining=${outcome.rateRemaining}`);
      if (outcome.cacheControl !== "no-store")
        problems.push(`Cache-Control=${outcome.cacheControl}`);
      if (outcome.bodyCode !== "rate_limited") problems.push(`body.error.code=${outcome.bodyCode}`);
      if (problems.length > 0) this.fail(record, "RATE_LIMIT_RESPONSE_SHAPE", problems.join("; "));
    }
    if (!outcome.requestId)
      this.fail(record, "RATE_LIMIT_RESPONSE_SHAPE", "missing x-request-id header");

    this.checkBudgets(record);
  }

  /** Window bookkeeping for the budget invariants (all phases). */
  private ipPassed = new Map<string, number>();
  private ipLaunched = new Map<string, number>();
  private authFailed = new Map<string, number>();
  private userAuthenticated = new Map<string, number>();
  private refreshPassed = new Map<string, number>();

  /** Rate-limit windows live in the solo isolate's memory (phases A/B) or in
   * the shared fake Redis (phase C cluster) — two independent counter domains. */
  private bucketKey(
    spec: Spec,
    scope: string,
    id: string,
    windowSeconds: number,
    atMs: number,
  ): string {
    const domain = spec.isolate === "solo" ? "solo" : "redis";
    return `${domain}:${scope}:${Math.floor(atMs / (windowSeconds * 1000))}:${id}`;
  }

  /** Called at launch time for the AUTHFAIL_LOCK / IP_BUDGET ordering checks. */
  private noteLaunch(record: RequestRecord): { failuresBefore: number; ipLaunchedBefore: number } {
    const { spec } = record;
    if (!this.isAuthedRoute(spec.route) && spec.route !== "bootstrap" && spec.route !== "refresh") {
      return { failuresBefore: 0, ipLaunchedBefore: 0 };
    }
    const afKey = this.bucketKey(
      spec,
      "authfail",
      spec.ip,
      LIMITS.authfail.windowSeconds,
      record.launchedAtMs,
    );
    const ipKey = this.bucketKey(spec, "ip", spec.ip, LIMITS.ip.windowSeconds, record.launchedAtMs);
    const launched = this.ipLaunched.get(ipKey) ?? 0;
    this.ipLaunched.set(ipKey, launched + 1);
    return { failuresBefore: this.authFailed.get(afKey) ?? 0, ipLaunchedBefore: launched };
  }

  private launchNotes = new Map<number, { failuresBefore: number; ipLaunchedBefore: number }>();

  private checkBudgets(record: RequestRecord): void {
    const { spec, outcome } = record;
    const notes = this.launchNotes.get(spec.idx) ?? { failuresBefore: 0, ipLaunchedBefore: 0 };
    this.launchNotes.delete(spec.idx);
    const gated =
      this.isAuthedRoute(spec.route) || spec.route === "bootstrap" || spec.route === "refresh";
    if (!gated) return;

    const ipKey = this.bucketKey(spec, "ip", spec.ip, LIMITS.ip.windowSeconds, record.launchedAtMs);
    const ipRejected = outcome.status === 429 && outcome.rateLimit === LIMITS.ip.limit;
    if (!ipRejected) {
      const passed = (this.ipPassed.get(ipKey) ?? 0) + 1;
      this.ipPassed.set(ipKey, passed);
      if (passed > LIMITS.ip.limit) {
        this.fail(
          record,
          "IP_BUDGET",
          `${passed} requests passed the per-IP gate in one window (limit ${LIMITS.ip.limit})`,
        );
      }
    } else if (notes.ipLaunchedBefore < LIMITS.ip.limit) {
      this.fail(
        record,
        "IP_BUDGET",
        `429 (limit ${LIMITS.ip.limit}) after only ${notes.ipLaunchedBefore} launches in this IP window`,
      );
    }

    // The edge charges the failure right before answering, so the charge lands
    // in the completion-time window (the clock may have moved while parked).
    const afKey = this.bucketKey(
      spec,
      "authfail",
      spec.ip,
      LIMITS.authfail.windowSeconds,
      record.completedAtMs,
    );
    if (outcome.status === 401) {
      const failed = (this.authFailed.get(afKey) ?? 0) + 1;
      this.authFailed.set(afKey, failed);
      if (failed > LIMITS.authfail.limit + this.options.maxInflight) {
        this.fail(
          record,
          "AUTHFAIL_BOUND",
          `${failed} auth failures accepted in one window (limit ${LIMITS.authfail.limit} + ${this.options.maxInflight} in flight)`,
        );
      }
    }
    if (notes.failuresBefore >= LIMITS.authfail.limit && outcome.status !== 429) {
      this.fail(
        record,
        "AUTHFAIL_LOCK",
        `${notes.failuresBefore} auth failures already recorded for ${spec.ip} in this window, yet got ${outcome.status}`,
      );
    }

    if (spec.route === "refresh") {
      const rKey = this.bucketKey(
        spec,
        "auth_refresh",
        spec.ip,
        LIMITS.auth_refresh.windowSeconds,
        record.launchedAtMs,
      );
      if (outcome.status !== 429) {
        const passed = (this.refreshPassed.get(rKey) ?? 0) + 1;
        this.refreshPassed.set(rKey, passed);
        if (passed > LIMITS.auth_refresh.limit) {
          this.fail(
            record,
            "REFRESH_BUDGET",
            `${passed} refreshes passed in one IP window (limit ${LIMITS.auth_refresh.limit})`,
          );
        }
      }
      if (outcome.status === 200 && spec.refreshToken) {
        const successes = this.refreshSuccesses.get(spec.refreshToken) ?? 0;
        if (successes > 1) {
          this.fail(
            record,
            "REFRESH_ROTATION",
            `refresh token ${spec.refreshRef} rotated successfully ${successes} times`,
          );
        }
      }
    }

    if (
      outcome.status !== 401 &&
      outcome.status !== 429 &&
      outcome.status !== 503 &&
      (this.isAuthedRoute(spec.route) || spec.route === "bootstrap")
    ) {
      const userId = this.userIdOf(record);
      if (userId) {
        const uKey = this.bucketKey(
          spec,
          "user",
          userId,
          LIMITS.user.windowSeconds,
          record.completedAtMs,
        );
        const n = (this.userAuthenticated.get(uKey) ?? 0) + 1;
        this.userAuthenticated.set(uKey, n);
        if (n > LIMITS.user.limit) {
          this.fail(
            record,
            "USER_BUDGET",
            `${n} authenticated responses for one user in one window (limit ${LIMITS.user.limit})`,
          );
        }
      }
    }
  }

  private userIdOf(record: RequestRecord): string | null {
    const { spec, truthAtLaunch: truth } = record;
    if (truth.kind === "access" && spec.token)
      return this.fake.accessTokens.get(spec.token)?.userId ?? null;
    if (truth.kind === "id_token" && spec.token) {
      const payload = decodeJwtPayload(spec.token);
      return this.fake.users.get(`${truth.provider}:${String(payload?.sub)}`)?.id ?? null;
    }
    return null;
  }

  // ── Clock ────────────────────────────────────────────────────────────────

  private advanceClock(allowBackward: boolean): void {
    const move = this.prng.weighted({
      none: 50,
      tiny: 32,
      small: 12,
      medium: 5,
      large: 0.5,
      back: allowBackward ? 0.5 : 0,
    });
    switch (move) {
      case "none":
        return;
      case "tiny":
        this.clock.advance(this.prng.range(1, 900));
        return;
      case "small":
        this.clock.advance(this.prng.range(1_000, 8_000));
        return;
      case "medium":
        this.clock.advance(this.prng.range(10_000, 60_000));
        return;
      case "large":
        this.clock.advance(this.prng.range(120_000, 480_000));
        return;
      case "back":
        this.backwardJumps += 1;
        this.clock.advance(-this.prng.range(1_000, 90_000));
        return;
    }
  }

  // ── Phases ───────────────────────────────────────────────────────────────

  private async runSequential(spec: Spec): Promise<RequestRecord> {
    const expected = this.model.predict(this.modelRequest(spec), this.clock.now());
    const pending = this.launch(spec, expected);
    const record = this.records[this.records.length - 1];
    this.launchNotes.set(spec.idx, this.noteLaunch(record));
    return await pending;
  }

  async phaseA(count: number): Promise<number> {
    const solo = this.isolates.solo;
    let n = 0;
    for (let i = 0; i < count; i += 1) {
      await this.runSequential(this.nextSpec("A", solo));
      n += 1;
      this.advanceClock(true);
    }
    if (this.prng.chance(this.options.floodChanceA)) n += await this.floodA();
    return n;
  }

  /** One bootstrap per user from a quiet IP so the flood has fresh, unexpired
   * sessions for every user (the per-user budget must not be what trips). */
  private floodBootstrapSpec(phase: Phase, isolate: EdgeIsolate, user: Users): Spec {
    const spec = this.baseSpec(phase, isolate, "bootstrap", "POST", "/v1/account/bootstrap");
    spec.ip = this.ips[3];
    const ref = this.ref("I");
    spec.token = fakeIdToken(
      user.provider,
      user.subject,
      Math.floor(this.clock.now() / 1000) + 7200,
      `${this.seed}-${ref}-flood`,
    );
    this.tokenRefs.set(spec.token, ref);
    spec.tokenRef = `${ref}~flood`;
    spec.bearerKind = user.provider === "apple" ? "id_apple" : "id_google";
    spec.userRef = user.ref;
    spec.mintTtlSeconds = 3600;
    return spec;
  }

  private freshSessions(): PoolSession[] {
    const nowSeconds = Math.floor(this.clock.now() / 1000);
    return this.activeSessions().filter(
      (s) => s.access[s.access.length - 1].expSeconds > nowSeconds + 300,
    );
  }

  /** Warm one valid session per user, then push the hot IP past 1200/min. */
  private async floodA(): Promise<number> {
    const solo = this.isolates.solo;
    let n = 0;
    // Align to a fresh minute so the flood is not split across two buckets.
    const now = this.clock.now();
    this.clock.set(Math.floor(now / 60_000 + 1) * 60_000 + this.prng.int(2_000));
    for (const user of this.users) {
      await this.runSequential(this.floodBootstrapSpec("A", solo, user));
      n += 1;
    }
    const already = this.model.rate.count(
      "ip",
      this.hotIp,
      LIMITS.ip.windowSeconds,
      this.clock.now(),
    );
    const target = LIMITS.ip.limit - already + 60;
    const sessions = this.freshSessions();
    if (sessions.length === 0) return n;
    for (let i = 0; i < target; i += 1) {
      const session = sessions[i % sessions.length];
      const route: RouteKind = i % 7 === 3 ? "unknown" : "me";
      const { method, path } = this.authedPath(route);
      const spec = this.baseSpec("A", solo, route, method, path);
      spec.ip = this.hotIp;
      spec.bearerKind = "access_pool";
      const access = session.access[session.access.length - 1];
      spec.token = access.token;
      spec.tokenRef = access.ref;
      spec.sessionRef = session.ref;
      spec.userRef = session.userRef;
      await this.runSequential(spec);
      n += 1;
    }
    return n;
  }

  private gateInstall(): void {
    this.fake.gate = {
      shouldPark: (kind) => this.prng.chance(kind === "getuser" || kind === "logout" ? 0.75 : 0.5),
      computeAt: () => (this.prng.chance(0.5) ? "arrival" : "release"),
      park: (entry) => {
        this.parked.push(entry);
      },
    };
  }

  private releaseParked(index: number): void {
    const [entry] = this.parked.splice(index, 1);
    entry.release();
  }

  maxInflightSeen = 0;

  private async runConcurrent(
    phase: Phase,
    count: number,
    pickIsolate: () => EdgeIsolate,
  ): Promise<number> {
    this.gateInstall();
    let launched = 0;
    const settle = async (): Promise<void> => {
      await flush();
      await flush();
    };
    const launchOne = (): void => {
      const isolate = pickIsolate();
      // Occasionally stage a logout race: a fresh (uncached) token used and
      // logged out back-to-back, so the release order decides who wins.
      if (this.prng.chance(0.12)) {
        const fresh = this.activeSessions().filter(
          (s) => s.access[s.access.length - 1].usedCount === 0,
        );
        if (fresh.length > 0) {
          const session = this.prng.pick(fresh);
          const access = session.access[session.access.length - 1];
          const firstRoute: RouteKind = this.prng.chance(0.5) ? "me" : "logout";
          const routes: RouteKind[] = [firstRoute, firstRoute === "logout" ? "me" : "logout"];
          if (this.prng.chance(0.4)) routes.push("me");
          for (const route of routes) {
            const { method, path } = this.authedPath(route);
            const spec = this.baseSpec(phase, pickIsolate(), route, method, path);
            spec.bearerKind = "access_pool";
            spec.token = access.token;
            spec.tokenRef = access.ref;
            spec.sessionRef = session.ref;
            spec.userRef = session.userRef;
            access.usedCount += 1;
            this.launchTracked(spec);
            launched += 1;
          }
          return;
        }
      }
      this.launchTracked(this.nextSpec(phase, isolate));
      launched += 1;
    };
    while (launched < count || this.inflight.size > 0 || this.parked.length > 0) {
      const canLaunch = launched < count && this.inflight.size < this.options.maxInflight;
      const action = this.prng.weighted({
        launch: canLaunch ? 5 : 0,
        release: this.parked.length > 0 ? 4 : 0,
        clock: 1,
      });
      if (action === "launch") launchOne();
      else if (action === "release") this.releaseParked(this.prng.int(this.parked.length));
      else this.advanceClock(false);
      this.maxInflightSeen = Math.max(this.maxInflightSeen, this.inflight.size);
      await settle();
      if (launched >= count && this.parked.length === 0 && this.inflight.size > 0) {
        // Nothing left to release — wait for straggling in-flight requests.
        await Promise.all([...this.inflight]);
      }
    }
    this.fake.gate = null;
    return launched;
  }

  private launchTracked(spec: Spec): void {
    void this.launch(spec, null);
    const record = this.records[this.records.length - 1];
    this.launchNotes.set(spec.idx, this.noteLaunch(record));
  }

  async phaseB(count: number): Promise<number> {
    return await this.runConcurrent("B", count, () => this.isolates.solo);
  }

  async phaseC(count: number): Promise<number> {
    let n = await this.runConcurrent("C", count, () => this.prng.pick(this.isolates.cluster));
    if (this.prng.chance(this.options.floodChanceC)) n += await this.floodC();
    return n;
  }

  /** Cross-isolate IP flood: the 1200/min budget must hold over the CLUSTER
   * because the counter lives in Redis, not in any one isolate. */
  private async floodC(): Promise<number> {
    const now = this.clock.now();
    this.clock.set(Math.floor(now / 60_000 + 1) * 60_000 + this.prng.int(2_000));
    let launched = 0;
    for (const user of this.users) {
      this.launchTracked(this.floodBootstrapSpec("C", this.prng.pick(this.isolates.cluster), user));
      launched += 1;
    }
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
    const sessions = this.freshSessions();
    if (sessions.length === 0) return launched;
    const target = LIMITS.ip.limit + 80;
    for (let i = 0; i < target; i += 1) {
      const session = sessions[i % sessions.length];
      const isolate = this.isolates.cluster[i % this.isolates.cluster.length];
      const { method, path } = this.authedPath("me");
      const spec = this.baseSpec("C", isolate, "me", method, path);
      spec.ip = this.hotIp;
      spec.bearerKind = "access_pool";
      const access = session.access[session.access.length - 1];
      spec.token = access.token;
      spec.tokenRef = access.ref;
      spec.sessionRef = session.ref;
      spec.userRef = session.userRef;
      this.launchTracked(spec);
      launched += 1;
      if (this.inflight.size >= this.options.maxInflight) {
        await flush();
      }
    }
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
    return launched;
  }

  // ── Whole seed ───────────────────────────────────────────────────────────

  async run(): Promise<SeedResult> {
    const startedWall = performance.now();
    this.clock.set(this.epochMs);
    this.fake.install();
    const total = Math.max(this.options.minRequests, 2000);
    const countA = Math.round(total * 0.48);
    const countB = Math.round(total * 0.33);
    const countC = total - countA - countB;
    const perPhase: Record<Phase, number> = { A: 0, B: 0, C: 0 };
    try {
      perPhase.A = await this.phaseA(countA);
      this.clock.advance(this.prng.range(1_000, 30_000));
      perPhase.B = await this.phaseB(countB);
      this.clock.advance(this.prng.range(1_000, 30_000));
      perPhase.C = await this.phaseC(countC);
    } finally {
      this.fake.gate = null;
      this.fake.restore();
    }
    return this.summarize(perPhase, performance.now() - startedWall);
  }

  private async summarize(perPhase: Record<Phase, number>, wallMs: number): Promise<SeedResult> {
    const statusCounts: Record<string, number> = {};
    const truthStatusMatrix: Record<string, Record<string, number>> = {};
    const bearerKindStatusMatrix: Record<string, Record<string, number>> = {};
    const reasonStatusMatrix: Record<string, Record<string, number>> = {};
    const upstreamFaultMatrix: Record<string, Record<string, number>> = {};
    const invariantViolations: Record<string, number> = {};
    for (const record of this.records) {
      const status = String(record.outcome.status);
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      const truth = record.truthAtLaunch;
      const truthLabel =
        truth.kind === "access"
          ? `access:${!truth.known ? "unknown" : truth.revoked ? "revoked" : "valid"}`
          : truth.kind === "id_token"
            ? `id_token:${truth.knownSubject ? "known" : "unknown"}`
            : truth.kind;
      bump(truthStatusMatrix, `${record.spec.phase}/${record.spec.route}/${truthLabel}`, status);
      bump(
        bearerKindStatusMatrix,
        `${record.spec.phase}/${record.spec.route}/${record.spec.bearerKind}`,
        status,
      );
      if (record.expected) bump(reasonStatusMatrix, record.expected.reason, status);
      if (record.spec.fault)
        bump(upstreamFaultMatrix, `${record.spec.fault.kind}:${record.spec.fault.status}`, status);
      for (const v of record.violations) invariantViolations[v] = (invariantViolations[v] ?? 0) + 1;
    }
    for (const failure of this.failures) {
      const record = this.records.find((r) => r.spec.idx === failure.idx);
      if (record?.spec.token) failure.spec.tokenSha8 = await sha8(record.spec.token);
    }
    const upstreamCalls: Record<string, number> = {};
    for (const call of this.fake.calls) {
      const key = `${call.kind}:${call.status}`;
      upstreamCalls[key] = (upstreamCalls[key] ?? 0) + 1;
    }
    const mem = Deno.memoryUsage();
    return {
      seed: this.seed,
      epochMs: this.epochMs,
      requests: this.records.length,
      perPhase,
      statusCounts,
      truthStatusMatrix,
      bearerKindStatusMatrix,
      reasonStatusMatrix,
      upstreamFaultMatrix,
      invariantViolations,
      hardFailures: this.failures.filter((f) => !f.soft).length,
      softFailures: this.failures.filter((f) => f.soft).length,
      failures: this.failures,
      upstreamCalls,
      cacheHitsPredicted: this.cacheHitsPredicted,
      clock: {
        forwardMs: this.clock.now() - this.epochMs,
        backwardJumps: this.backwardJumps,
        finalMs: this.clock.now(),
      },
      heap: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
      },
      redisKeys: this.fake.redis.store.size,
      wallMs: Math.round(wallMs),
      maxInflight: this.maxInflightSeen,
    };
  }
}
