// xc-matrix-concurrency-edge — STATEFUL black-box harness for the edge function.
//
// Unlike routesHarness.ts (static canned rows), this harness keeps a real
// in-memory model of Supabase Auth (sessions, refresh-token rotation, logout),
// PostgREST (per-table rows with eq/in filters, upserts, RLS by bearer) and the
// three hot RPCs (access_state / reserve_analysis_permit / apply_synced_shot,
// modelled statement-for-statement on migration 20260906000000 (the body of
// apply_synced_shot is 20260902150000's + 20260904000000's SQLSTATE-only handler + the post-lock replay check) plus
// reserve_analysis_permit / access_state from 20260902150000, including the
// pre-lock reads and the per-user lock), plus RevenueCat. Every upstream call
// is delayed by a SEEDED pseudo-random latency so Promise.all bursts against
// the REAL handler (../index.ts, Deno.serve captured) genuinely interleave.
//
// The model is deliberately NOT smarter than Postgres: statements that run
// before the advisory lock in SQL run before the lock here too, so results
// can be cross-checked against xc_pg_rpc_concurrency.test.ts (real Postgres).
//
// Every scenario records: seed, inputs, per-request status table, upstream
// call counters, an interleaving timeline and Deno.memoryUsage() — written as
// JSON under XC_OUT_DIR (default artifacts/xc-matrix-concurrency-edge/latest/).

export const SUPABASE_URL = "http://supabase.xc.test";
export const WEBHOOK_SECRET = "xc-webhook-secret";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
const ANON_KEY = "xc-anon-key";
const SERVICE_ROLE_KEY = "xc-service-role-key";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function b64urlDecode(segment: string): string {
  const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
  return atob(raw + "=".repeat((4 - (raw.length % 4)) % 4));
}

export function jwtPayload(token: string): Record<string, unknown> | null {
  const seg = token.split(".")[1];
  if (!seg) return null;
  try {
    return JSON.parse(b64urlDecode(seg)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** mulberry32 — small, deterministic, good enough to replay an interleaving. */
export class Prng {
  private state: number;
  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
  shuffle<T>(items: T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function fakeGoogleIdToken(sub: string, nonce = ""): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...(nonce ? { nonce } : {}),
    }),
  );
  return `${header}.${payload}.sig`;
}

// ── Model ────────────────────────────────────────────────────────────────────

export interface FakeSession {
  sessionId: string;
  userId: string;
  provider: "google" | "apple";
  accessToken: string;
  refreshToken: string;
  /** refresh tokens this session already rotated away from */
  usedRefreshTokens: Set<string>;
  revoked: boolean;
}

export interface PermitRow {
  id: string;
  user_id: string;
  idempotency_key: string;
  status: "reserved" | "finalized" | "released";
  outcome: string | null;
  created_at: string;
}

export interface ShotRow {
  id: string;
  user_id: string;
  session_id: string | null;
  result_kind: string;
  analysis_permit_id: string;
  created_at: string;
}

export interface TimelineEntry {
  t: number;
  op: string;
  detail: string;
}

export type RefreshPolicy = "rotate-reject-reuse" | "rotate-reuse-window";

export interface FakeOverrides {
  /** Replace the GoTrue refresh endpoint entirely (429, network failure…). */
  refresh?: (body: Record<string, unknown>) => Response | "throw";
  /** Extra latency (ms) applied to GET /auth/v1/user for a given bearer. */
  getUserDelayMs?: (bearer: string) => number;
  /** Extra latency for GoTrue logout. */
  logoutDelayMs?: number;
  /** RevenueCat subscriber for a user; null → HTTP 500 from RevenueCat. */
  subscriber?: (userId: string) => Record<string, unknown> | null;
  /** Extra latency applied to a RevenueCat lookup. */
  rcDelayMs?: (userId: string) => number;
}

export class FakeSupabase {
  prng: Prng;
  latencyMaxMs: number;
  refreshPolicy: RefreshPolicy = "rotate-reject-reuse";
  overrides: FakeOverrides = {};

  sessions = new Map<string, FakeSession>();
  accessIndex = new Map<string, string>();
  refreshIndex = new Map<string, string>();
  users = new Map<string, { id: string; email: string; provider: "google" | "apple" }>();
  tables: Record<string, Array<Record<string, unknown>>> = {
    profiles: [],
    shots: [],
    analysis_permits: [],
    billing_entitlements: [],
    sessions: [],
    webhook_events: [],
    account_external_credentials: [],
  };
  /** identity ledger: sha-ish key `${provider}:${sub}` → lifetime scored count */
  identityLedger = new Map<string, number>();
  counters: Record<string, number> = {};
  timeline: TimelineEntry[] = [];
  private mint = 0;
  /** Bumped on every reset(). GoTrue never re-issues a session_id, and the
   * edge fn keeps per-isolate state that outlives reset() (the auth cache and
   * the session revocation fence, both keyed by session_id / token hash), so
   * a session minted in one scenario must never share an id with a session
   * minted from the same seed in another. */
  private epoch = 0;
  private t0 = performance.now();

  constructor(seed: number, latencyMaxMs: number) {
    this.prng = new Prng(seed);
    this.latencyMaxMs = latencyMaxMs;
  }

  reset(seed: number, latencyMaxMs = this.latencyMaxMs): void {
    this.prng = new Prng(seed);
    this.latencyMaxMs = latencyMaxMs;
    this.refreshPolicy = "rotate-reject-reuse";
    this.overrides = {};
    this.sessions.clear();
    this.accessIndex.clear();
    this.refreshIndex.clear();
    this.users.clear();
    for (const key of Object.keys(this.tables)) this.tables[key] = [];
    this.identityLedger.clear();
    this.counters = {};
    this.timeline = [];
    this.mint = 0;
    this.epoch += 1;
    this.t0 = performance.now();
  }

  count(key: string): void {
    this.counters[key] = (this.counters[key] ?? 0) + 1;
  }

  log(op: string, detail: string): void {
    this.timeline.push({
      t: Math.round((performance.now() - this.t0) * 100) / 100,
      op,
      detail,
    });
  }

  private async latency(): Promise<void> {
    if (this.latencyMaxMs > 0) await sleep(this.prng.int(0, this.latencyMaxMs));
  }

  // ── Auth model ──

  ensureUser(userId: string, provider: "google" | "apple"): void {
    if (!this.users.has(userId)) {
      this.users.set(userId, {
        id: userId,
        email: `${userId.slice(0, 8)}@example.com`,
        provider,
      });
      // handle_new_user trigger equivalent
      this.tables.profiles.push({
        id: userId,
        email: `${userId.slice(0, 8)}@example.com`,
        onboarding_state: "complete",
        provider,
        skill_level: null,
        handedness: null,
        primary_goal: null,
        biggest_problem: null,
        focus_checkpoint: null,
        first_name: null,
        gender: null,
      });
    }
  }

  mintSession(userId: string, provider: "google" | "apple", sessionId?: string): FakeSession {
    this.mint += 1;
    const sid = sessionId ?? `sess-${this.epoch}.${this.mint}-${this.prng.uuid()}`;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const accessToken = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
      JSON.stringify({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: userId,
        aud: "authenticated",
        role: "authenticated",
        session_id: sid,
        exp,
        jti: `${this.epoch}.${this.mint}-${this.prng.uuid()}`,
      }),
    )}.sig`;
    const refreshToken = `rt-${this.epoch}.${this.mint}-${this.prng.uuid()}`;
    const existing = this.sessions.get(sid);
    const session: FakeSession = existing ?? {
      sessionId: sid,
      userId,
      provider,
      accessToken,
      refreshToken,
      usedRefreshTokens: new Set(),
      revoked: false,
    };
    if (existing) {
      existing.usedRefreshTokens.add(existing.refreshToken);
      existing.accessToken = accessToken;
      existing.refreshToken = refreshToken;
    }
    this.sessions.set(sid, session);
    this.accessIndex.set(accessToken, sid);
    this.refreshIndex.set(refreshToken, sid);
    return session;
  }

  userJson(userId: string) {
    const user = this.users.get(userId)!;
    return {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      app_metadata: { provider: user.provider, providers: [user.provider] },
      user_metadata: {},
      created_at: new Date(0).toISOString(),
    };
  }

  sessionJson(session: FakeSession) {
    const payload = jwtPayload(session.accessToken)!;
    return {
      access_token: session.accessToken,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: payload.exp,
      refresh_token: session.refreshToken,
      user: this.userJson(session.userId),
    };
  }

  /** Resolve the acting principal of a PostgREST call from its bearer. */
  principal(headers: Headers): { role: "service" | "user" | "anon"; userId: string | null } {
    const auth = headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token === SERVICE_ROLE_KEY) return { role: "service", userId: null };
    if (!token || token === ANON_KEY) return { role: "anon", userId: null };
    const payload = jwtPayload(token);
    const sub = typeof payload?.sub === "string" ? payload.sub : null;
    // PostgREST verifies the JWT signature/exp only — a logged-out session's
    // access token is still a valid JWT until exp (that is why the edge fn
    // calls getUser()).
    return { role: "user", userId: sub };
  }

  // ── RPC model (mirrors 20260902150000_free_rating_identity_ledger.sql and
  //    20260904000000_apply_synced_shot_error_hygiene.sql, 20260906000000_apply_synced_shot_replay_after_lock.sql) ──

  private lifetimeScoredCount(userId: string): number {
    const own = this.tables.shots.filter(
      (s) => s.user_id === userId && s.result_kind === "scored",
    ).length;
    const user = this.users.get(userId);
    const ledger = user ? (this.identityLedger.get(`${user.provider}:${userId}`) ?? 0) : 0;
    return Math.max(own, ledger);
  }

  private premium(userId: string): boolean {
    const row = this.tables.billing_entitlements.find((b) => b.user_id === userId);
    if (!row) return false;
    const exp = row.expires_at as string | null;
    return Boolean(row.premium) && (exp === null || new Date(exp).getTime() > Date.now());
  }

  private reservedCount(userId: string): number {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    return this.tables.analysis_permits.filter(
      (p) =>
        p.user_id === userId &&
        p.status === "reserved" &&
        new Date(p.created_at as string).getTime() > cutoff,
    ).length;
  }

  // Per-user "advisory lock": a FIFO promise chain. Everything inside `fn`
  // runs synchronously (no awaits) = one transaction's statements under lock.
  private locks = new Map<string, Promise<void>>();
  async withUserLock<T>(userId: string, fn: () => T): Promise<T> {
    const prev = this.locks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    this.locks.set(
      userId,
      prev.then(() => mine),
    );
    await prev;
    try {
      return fn();
    } finally {
      release();
    }
  }

  accessState(userId: string) {
    return [
      {
        premium: this.premium(userId),
        scored_count: this.lifetimeScoredCount(userId),
        reserved_count: this.reservedCount(userId),
      },
    ];
  }

  async reserveAnalysisPermit(userId: string | null, key: string) {
    this.count("rpc.reserve_analysis_permit");
    if (!userId) return [{ result: "auth.required" }];
    const view = (p: Record<string, unknown>) => ({
      result: "accepted",
      permit_id: p.id,
      permit_status: p.status,
      permit_outcome: p.outcome,
      permit_created_at: p.created_at,
    });
    // fast path (before the lock)
    const fast = this.tables.analysis_permits.find(
      (p) => p.user_id === userId && p.idempotency_key === key,
    );
    if (fast) return [view(fast)];
    await this.latency(); // lock acquisition wait / scheduling gap
    return await this.withUserLock(userId, () => {
      const again = this.tables.analysis_permits.find(
        (p) => p.user_id === userId && p.idempotency_key === key,
      );
      if (again) return [view(again)];
      const premium = this.premium(userId);
      const scored = this.lifetimeScoredCount(userId);
      const reserved = this.reservedCount(userId);
      const remaining = 2 - Math.min(scored, 2);
      if (!premium && remaining <= reserved) {
        this.log("rpc.reserve", `user=${userId} key=${key} → paywall_required`);
        return [{ result: "access.paywall_required" }];
      }
      const row: PermitRow = {
        id: this.prng.uuid(),
        user_id: userId,
        idempotency_key: key,
        status: "reserved",
        outcome: null,
        created_at: new Date().toISOString(),
      };
      this.tables.analysis_permits.push(row as unknown as Record<string, unknown>);
      this.log("rpc.reserve", `user=${userId} key=${key} → accepted ${row.id}`);
      return [view(row as unknown as Record<string, unknown>)];
    });
  }

  async applySyncedShot(userId: string | null, shot: Record<string, unknown>): Promise<string> {
    this.count("rpc.apply_synced_shot");
    if (!userId) return "auth.required";
    const id = String(shot.id);
    const permitId = String(shot.analysisPermitId);
    const sessionId = shot.sessionId ? String(shot.sessionId) : null;
    const resultKind = String(shot.resultKind);
    // idempotent replay check BEFORE the lock (as in SQL)
    if (this.tables.shots.some((s) => s.id === id && s.user_id === userId)) {
      return "accepted";
    }
    await this.latency();
    return await this.withUserLock(userId, () => {
      // idempotent replay check AFTER the lock (20260906000000): a copy that
      // won the race committed while we queued on the lock
      if (this.tables.shots.some((s) => s.id === id && s.user_id === userId)) {
        this.log("rpc.apply", `user=${userId} shot=${id} → accepted (replay after lock)`);
        return "accepted";
      }
      const permit = this.tables.analysis_permits.find(
        (p) => p.id === permitId && p.user_id === userId,
      );
      if (!permit) return "access.permit_not_found";
      if (permit.status !== "reserved") {
        this.log("rpc.apply", `user=${userId} shot=${id} → permit_not_reserved (${permit.status})`);
        return "access.permit_not_reserved";
      }
      if (new Date(permit.created_at as string).getTime() <= Date.now() - 24 * 3600 * 1000) {
        permit.status = "released";
        permit.outcome = "expired";
        return "access.permit_expired";
      }
      if (resultKind === "scored") {
        if (!this.premium(userId) && this.lifetimeScoredCount(userId) >= 2) {
          permit.status = "released";
          permit.outcome = "free_limit_exceeded";
          this.log("rpc.apply", `user=${userId} shot=${id} → paywall_required`);
          return "access.paywall_required";
        }
      }
      if (
        sessionId !== null &&
        !this.tables.sessions.some((s) => s.id === sessionId && s.user_id === userId)
      ) {
        return "shot.session_not_found";
      }
      // atomic write block
      const conflict = this.tables.shots.find((s) => s.id === id);
      if (conflict) {
        return conflict.user_id === userId ? "accepted" : "shot.id_conflict";
      }
      const row: ShotRow = {
        id,
        user_id: userId,
        session_id: sessionId,
        result_kind: resultKind,
        analysis_permit_id: permitId,
        created_at: new Date().toISOString(),
      };
      this.tables.shots.push(row as unknown as Record<string, unknown>);
      if (resultKind === "scored") {
        // shots_record_free_rating_ledger trigger
        const user = this.users.get(userId);
        if (user) {
          const k = `${user.provider}:${userId}`;
          this.identityLedger.set(k, Math.max(this.identityLedger.get(k) ?? 0, 0) + 1);
        }
      }
      permit.status = resultKind === "scored" ? "finalized" : "released";
      permit.outcome = resultKind;
      this.log("rpc.apply", `user=${userId} shot=${id} → accepted`);
      return "accepted";
    });
  }

  // ── PostgREST model ──

  private filterRows(
    rows: Array<Record<string, unknown>>,
    params: URLSearchParams,
  ): Array<Record<string, unknown>> {
    let out = rows;
    for (const [col, raw] of params.entries()) {
      if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(col)) continue;
      if (raw.startsWith("eq.")) {
        const v = raw.slice(3);
        out = out.filter((r) => String(r[col]) === v);
      } else if (raw.startsWith("in.(")) {
        const list = new Set(
          raw
            .slice(4, -1)
            .split(",")
            .map((s) => s.replace(/^"|"$/g, "")),
        );
        out = out.filter((r) => list.has(String(r[col])));
      } else if (raw === "is.null") {
        out = out.filter((r) => r[col] === null || r[col] === undefined);
      } else {
        throw new Error(`xc harness: unsupported PostgREST filter ${col}=${raw}`);
      }
    }
    return out;
  }

  private rlsScope(
    table: string,
    rows: Array<Record<string, unknown>>,
    who: { role: "service" | "user" | "anon"; userId: string | null },
  ): Array<Record<string, unknown>> {
    if (who.role === "service") return rows;
    if (who.role === "anon" || !who.userId) return [];
    const ownerCol = table === "profiles" ? "id" : "user_id";
    return rows.filter((r) => r[ownerCol] === who.userId);
  }

  // ── fetch dispatcher ──

  async handleFetch(request: Request, rawBody: string): Promise<Response> {
    const url = new URL(request.url);
    const jsonResponse = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...extra },
      });
    let body: Record<string, unknown> = {};
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody);
        body = isRecord(parsed) ? parsed : { _array: parsed };
      } catch {
        body = {};
      }
    }

    // RevenueCat
    if (request.url.startsWith(RC_URL)) {
      const userId = decodeURIComponent(request.url.slice(RC_URL.length));
      this.count("rc.get_subscriber");
      this.log("rc.get", `user=${userId}`);
      await this.latency();
      const extra = this.overrides.rcDelayMs?.(userId) ?? 0;
      if (extra > 0) await sleep(extra);
      const subscriber = this.overrides.subscriber
        ? this.overrides.subscriber(userId)
        : { entitlements: {} };
      if (!subscriber) return new Response("upstream error", { status: 500 });
      return jsonResponse(200, { request_date_ms: Date.now(), subscriber });
    }

    // GoTrue
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/")) {
      const path = url.pathname.slice("/auth/v1/".length);
      if (path === "token" && request.method === "POST") {
        const grant = url.searchParams.get("grant_type");
        if (grant === "id_token") {
          this.count("gotrue.token.id_token");
          await this.latency();
          const idToken = typeof body.id_token === "string" ? body.id_token : "";
          const payload = jwtPayload(idToken);
          const sub = typeof payload?.sub === "string" ? payload.sub : "";
          const provider = body.provider === "apple" ? "apple" : "google";
          if (!sub) {
            return jsonResponse(400, {
              error: "invalid_grant",
              error_description: "bad id token",
            });
          }
          this.ensureUser(sub, provider);
          const session = this.mintSession(sub, provider);
          this.log("gotrue.id_token", `user=${sub} session=${session.sessionId}`);
          return jsonResponse(200, this.sessionJson(session));
        }
        if (grant === "refresh_token") {
          this.count("gotrue.token.refresh");
          await this.latency();
          if (this.overrides.refresh) {
            const forced = this.overrides.refresh(body);
            if (forced === "throw") {
              throw new TypeError("xc: simulated network failure");
            }
            return forced;
          }
          const rt = typeof body.refresh_token === "string" ? body.refresh_token : "";
          const sid = this.refreshIndex.get(rt);
          const session = sid ? this.sessions.get(sid) : undefined;
          if (!session || session.revoked) {
            this.log("gotrue.refresh", `rt=${rt.slice(0, 12)} → 400 not found`);
            return jsonResponse(400, {
              error: "invalid_grant",
              error_code: "refresh_token_not_found",
              error_description: "Invalid Refresh Token: Refresh Token Not Found",
            });
          }
          if (session.usedRefreshTokens.has(rt)) {
            if (this.refreshPolicy === "rotate-reuse-window") {
              this.log("gotrue.refresh", `rt=${rt.slice(0, 12)} → reuse-window (same session)`);
              return jsonResponse(200, this.sessionJson(session));
            }
            this.log("gotrue.refresh", `rt=${rt.slice(0, 12)} → 400 already used`);
            return jsonResponse(400, {
              error: "invalid_grant",
              error_code: "refresh_token_already_used",
              error_description: "Invalid Refresh Token: Already Used",
            });
          }
          // rotate: the SAME session gets a new access + refresh pair
          const rotated = this.mintSession(session.userId, session.provider, session.sessionId);
          this.log("gotrue.refresh", `rt=${rt.slice(0, 12)} → rotated`);
          return jsonResponse(200, this.sessionJson(rotated));
        }
        return jsonResponse(400, { error: "unsupported_grant_type" });
      }
      if (path === "user" && request.method === "GET") {
        this.count("gotrue.get_user");
        const auth = request.headers.get("authorization") ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        await this.latency();
        const sid = this.accessIndex.get(bearer);
        const session = sid ? this.sessions.get(sid) : undefined;
        // getUserDelayMs models RESPONSE-path latency: GoTrue has already
        // answered from its session table; the bytes are still in flight.
        const extra = this.overrides.getUserDelayMs?.(bearer) ?? 0;
        if (!session || session.revoked) {
          this.log("gotrue.get_user", `bearer=${bearer.slice(-10)} → 403 session_not_found`);
          if (extra > 0) await sleep(extra);
          return jsonResponse(403, {
            code: 403,
            error_code: "session_not_found",
            msg: "Session from session_id claim in JWT does not exist",
          });
        }
        this.log("gotrue.get_user", `bearer=${bearer.slice(-10)} → 200 user=${session.userId}`);
        if (extra > 0) await sleep(extra);
        return jsonResponse(200, this.userJson(session.userId));
      }
      if (path === "logout" && request.method === "POST") {
        this.count("gotrue.logout");
        await this.latency();
        if (this.overrides.logoutDelayMs) {
          await sleep(this.overrides.logoutDelayMs);
        }
        const auth = request.headers.get("authorization") ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const sid = this.accessIndex.get(bearer);
        const session = sid ? this.sessions.get(sid) : undefined;
        if (session) {
          session.revoked = true;
          this.log(
            "gotrue.logout",
            `session=${session.sessionId} revoked (scope=${url.searchParams.get("scope")})`,
          );
        } else {
          this.log("gotrue.logout", `bearer=${bearer.slice(-10)} unknown`);
        }
        return new Response(null, { status: 204 });
      }
      return jsonResponse(404, {
        msg: `xc harness: unmodelled auth path ${path}`,
      });
    }

    // PostgREST
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
      const target = url.pathname.slice("/rest/v1/".length);
      const who = this.principal(request.headers);
      await this.latency();
      if (target.startsWith("rpc/")) {
        const fn = target.slice(4);
        if (fn === "access_state") {
          this.count("rpc.access_state");
          if (!who.userId) {
            return jsonResponse(401, { message: "auth.required" });
          }
          return jsonResponse(200, this.accessState(who.userId));
        }
        if (fn === "reserve_analysis_permit") {
          const key = String(body.p_idempotency_key ?? "");
          return jsonResponse(200, await this.reserveAnalysisPermit(who.userId, key));
        }
        if (fn === "apply_synced_shot") {
          const shot = isRecord(body.shot) ? body.shot : {};
          return jsonResponse(200, await this.applySyncedShot(who.userId, shot));
        }
        return jsonResponse(404, {
          code: "PGRST202",
          message: `rpc ${fn} not modelled`,
        });
      }
      const table = target;
      if (!(table in this.tables)) {
        return jsonResponse(404, {
          code: "PGRST205",
          message: `table ${table} not modelled`,
        });
      }
      this.count(`rest.${request.method.toLowerCase()}.${table}`);
      if (request.method === "GET") {
        const rows = this.filterRows(
          this.rlsScope(table, this.tables[table], who),
          url.searchParams,
        );
        const accept = request.headers.get("accept") ?? "";
        if (accept.includes("application/vnd.pgrst.object+json")) {
          if (rows.length !== 1) {
            return jsonResponse(406, {
              code: "PGRST116",
              message: `${rows.length} rows`,
              details: null,
              hint: null,
            });
          }
          return jsonResponse(200, rows[0]);
        }
        return jsonResponse(200, rows);
      }
      if (request.method === "POST") {
        const prefer = request.headers.get("prefer") ?? "";
        const incoming: Array<Record<string, unknown>> = Array.isArray(body._array)
          ? (body._array as Array<Record<string, unknown>>)
          : [body];
        const conflictCol = url.searchParams.get("on_conflict");
        for (const row of incoming) {
          if (who.role === "user" && row.user_id !== undefined && row.user_id !== who.userId) {
            return jsonResponse(403, {
              code: "42501",
              message: "rls: new row violates policy",
            });
          }
          const existing = conflictCol
            ? this.tables[table].find((r) => r[conflictCol] === row[conflictCol])
            : this.tables[table].find((r) => r.id !== undefined && r.id === row.id);
          if (existing) {
            if (prefer.includes("resolution=ignore-duplicates")) {
              this.log(
                `rest.upsert.${table}`,
                `ignored duplicate ${String(row[conflictCol ?? "id"])}`,
              );
              continue;
            }
            if (prefer.includes("resolution=merge-duplicates")) {
              Object.assign(existing, row);
              this.log(`rest.upsert.${table}`, `merged ${String(row[conflictCol ?? "id"])}`);
              continue;
            }
            return jsonResponse(409, {
              code: "23505",
              message: "duplicate key value",
            });
          }
          this.tables[table].push({ ...row });
          this.log(`rest.insert.${table}`, `${String(row[conflictCol ?? "id"] ?? "")}`.trim());
        }
        return prefer.includes("return=representation")
          ? jsonResponse(201, incoming)
          : new Response(null, { status: 201 });
      }
      if (request.method === "PATCH") {
        const rows = this.filterRows(
          this.rlsScope(table, this.tables[table], who),
          url.searchParams,
        );
        for (const r of rows) Object.assign(r, body);
        return new Response(null, { status: 204 });
      }
      if (request.method === "DELETE") {
        const rows = new Set(
          this.filterRows(this.rlsScope(table, this.tables[table], who), url.searchParams),
        );
        this.tables[table] = this.tables[table].filter((r) => !rows.has(r));
        return new Response(null, { status: 204 });
      }
    }
    return new Response(`xc harness: unexpected fetch ${request.method} ${request.url}`, {
      status: 599,
    });
  }
}

// ── Loading the real handler ─────────────────────────────────────────────────

export interface XcHarness {
  handler: (request: Request) => Promise<Response>;
  fake: FakeSupabase;
  /** Every upstream call (url/method) in order — cheap evidence of fan-out. */
  upstreamCalls: Array<{ t: number; method: string; url: string }>;
}

let loaded: XcHarness | null = null;

export async function loadXcHarness(): Promise<XcHarness> {
  if (loaded) return loaded;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", WEBHOOK_SECRET);
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_xc");
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const fake = new FakeSupabase(1, 0);
  const upstreamCalls: XcHarness["upstreamCalls"] = [];
  const t0 = performance.now();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = await request.text().catch(() => "");
    upstreamCalls.push({
      t: Math.round((performance.now() - t0) * 100) / 100,
      method: request.method,
      url: request.url,
    });
    return fake.handleFetch(request, rawBody);
  }) as typeof fetch;

  let handler: XcHarness["handler"] | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as XcHarness["handler"] | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) {
    throw new Error("index.ts did not register a Deno.serve handler");
  }
  loaded = { handler, fake, upstreamCalls };
  return loaded;
}

// ── Request builders ─────────────────────────────────────────────────────────

export function edgeRequest(
  method: string,
  path: string,
  options: {
    token?: string | null;
    ip?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? "198.51.100.7",
    ...options.headers,
  });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(`http://edge.xc.test/functions/v1/api${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

export function webhookRequest(
  event: Record<string, unknown>,
  options: { ip?: string; authorization?: string } = {},
): Request {
  return new Request("http://edge.xc.test/functions/v1/api/webhooks/revenuecat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: options.authorization ?? WEBHOOK_SECRET,
      "x-forwarded-for": options.ip ?? "203.0.113.77",
    },
    body: JSON.stringify({ api_version: "1.0", event }),
  });
}

export const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

/** A shot in the wire shape POST /v1/shots:sync validates (parseSyncShot). */
export function syncShotPayload(
  id: string,
  analysisPermitId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    source: "real",
    analysisPermitId,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 100, endMs: 200 },
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : { _value: parsed };
  } catch {
    return { _raw: text };
  }
}

/** Bootstrap through the real route; returns the minted session. */
export async function bootstrap(
  h: XcHarness,
  sub: string,
  ip: string,
): Promise<{
  status: number;
  accessToken: string;
  refreshToken: string;
  body: Record<string, unknown>;
}> {
  const response = await h.handler(
    edgeRequest("POST", "/v1/account/bootstrap", {
      token: fakeGoogleIdToken(sub),
      ip,
      body: {},
    }),
  );
  const body = await readJson(response);
  const session = isRecord(body.session) ? body.session : {};
  return {
    status: response.status,
    accessToken: String(session.accessToken ?? ""),
    refreshToken: String(session.refreshToken ?? ""),
    body,
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

export interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}

export interface ScenarioReport {
  scenario: string;
  label: string;
  seed: number;
  scale: Record<string, number>;
  inputs: Record<string, unknown>;
  statusHistogram: Record<string, number>;
  counters: Record<string, number>;
  invariants: Invariant[];
  observations: Record<string, unknown>;
  timeline: TimelineEntry[];
  requests: Array<Record<string, unknown>>;
  durationMs: number;
  heap: { before: Deno.MemoryUsage; after: Deno.MemoryUsage };
  replay: string;
}

export function outDir(): string {
  const env = Deno.env.get("XC_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/xc-matrix-concurrency-edge/latest/", import.meta.url)
    .pathname;
}

export async function writeReport(report: ScenarioReport): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${report.scenario}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

export function histogram(values: Array<string | number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const XC_SEED = envInt("XC_SEED", 20260904);
export const XC_BURST = envInt("XC_BURST", 24);
export const XC_ROUNDS = envInt("XC_ROUNDS", 6);
export const XC_LATENCY_MS = envInt("XC_LATENCY_MS", 12);

export function replayCommand(scenarioFilter: string, seed: number): string {
  return `XC_SEED=${seed} XC_BURST=${XC_BURST} XC_ROUNDS=${XC_ROUNDS} XC_LATENCY_MS=${XC_LATENCY_MS} deno test -A --no-check --config deno.json xc_edge_concurrency_matrix.test.ts --filter "${scenarioFilter}"`;
}
