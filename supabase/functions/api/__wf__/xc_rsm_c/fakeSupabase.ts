// Stateful fake of everything the edge function talks to over fetch during
// authentication: Supabase Auth (id-token exchange, refresh rotation, getUser,
// scope=local logout), the two PostgREST calls the exercised routes make, and
// an Upstash-style Redis REST pipeline (so several edge isolates can share L2
// cache + rate-limit windows). Sessions are REAL state — logout revokes a
// session, refresh rotates its refresh token — so the harness can ask the
// edge for exactly the behaviour a live GoTrue would produce.
//
// Concurrency model: when a Gate is attached, every Auth call parks in it and
// only completes when the driver releases it. The driver (seeded PRNG) picks
// the release order, so request interleavings are random but replayable.
// A parked call either computes its response on ARRIVAL (latency on the
// response path) or on RELEASE (latency on the request path) — both happen
// on a real network and both are exercised.

import { b64url, decodeJwtPayload } from "./tokens.ts";

export const SUPABASE_URL = "http://supabase.test";
export const SUPABASE_ANON_KEY = "xc-rsm-anon-key";
export const REDIS_URL = "http://redis.test";
export const REDIS_TOKEN = "xc-rsm-redis-token";

export type Provider = "google" | "apple";
export type UpstreamKind = "signin" | "getuser" | "refresh" | "logout";

export interface FakeUser {
  id: string;
  provider: Provider;
  subject: string;
  email: string;
}

export interface FakeSession {
  id: string;
  userId: string;
  refreshToken: string;
  revoked: boolean;
  accessTokens: string[];
}

export interface AccessRecord {
  token: string;
  sessionId: string;
  userId: string;
  expSeconds: number;
}

export interface GateEntry {
  seq: number;
  kind: UpstreamKind;
  computeAt: "arrival" | "release";
  release: () => void;
}

export interface Gate {
  /** Called on every Auth call; return true to park it. */
  shouldPark(kind: UpstreamKind): boolean;
  computeAt(kind: UpstreamKind): "arrival" | "release";
  park(entry: GateEntry): void;
}

export interface UpstreamCallLog {
  seq: number;
  kind: UpstreamKind;
  atMs: number;
  status: number;
  fault: number | null;
}

/** Fixed fault injected on the NEXT upstream call that presents this token. */
export interface Fault {
  kind: UpstreamKind;
  status: number;
}

interface RedisEntry {
  value: string;
  expiresAtMs: number | null;
}

type Cmd = Array<string | number>;

export class FakeRedis {
  store = new Map<string, RedisEntry>();
  commands = 0;
  pipelines = 0;

  private live(key: string): RedisEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  run(commands: Cmd[]): Array<{ result: unknown }> {
    this.pipelines += 1;
    return commands.map((cmd) => {
      this.commands += 1;
      const op = String(cmd[0]).toUpperCase();
      switch (op) {
        case "GET": {
          const entry = this.live(String(cmd[1]));
          return { result: entry ? entry.value : null };
        }
        case "TTL": {
          const entry = this.live(String(cmd[1]));
          if (!entry) return { result: -2 };
          if (entry.expiresAtMs === null) return { result: -1 };
          return { result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000)) };
        }
        case "SET": {
          const key = String(cmd[1]);
          const value = String(cmd[2]);
          let expiresAtMs: number | null = null;
          if (String(cmd[3] ?? "").toUpperCase() === "EX") {
            expiresAtMs = Date.now() + Number(cmd[4]) * 1000;
          }
          this.store.set(key, { value, expiresAtMs });
          return { result: "OK" };
        }
        case "DEL": {
          let n = 0;
          for (const key of cmd.slice(1)) {
            if (this.live(String(key))) n += 1;
            this.store.delete(String(key));
          }
          return { result: n };
        }
        case "INCR": {
          const key = String(cmd[1]);
          const entry = this.live(key);
          const next = (entry ? Number(entry.value) : 0) + 1;
          this.store.set(key, { value: String(next), expiresAtMs: entry?.expiresAtMs ?? null });
          return { result: next };
        }
        case "EXPIRE": {
          const key = String(cmd[1]);
          const entry = this.live(key);
          if (!entry) return { result: 0 };
          const nx = String(cmd[3] ?? "").toUpperCase() === "NX";
          if (nx && entry.expiresAtMs !== null) return { result: 0 };
          entry.expiresAtMs = Date.now() + Number(cmd[2]) * 1000;
          return { result: 1 };
        }
        default:
          return { result: null };
      }
    });
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= now) this.store.delete(key);
    }
  }
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export class FakeSupabase {
  users = new Map<string, FakeUser>(); // by provider subject
  usersById = new Map<string, FakeUser>();
  sessions = new Map<string, FakeSession>();
  accessTokens = new Map<string, AccessRecord>();
  /** CURRENT refresh token → session. Rotated-away tokens are removed. */
  refreshTokens = new Map<string, string>();
  redis = new FakeRedis();
  gate: Gate | null = null;
  faults = new Map<string, Fault>();
  calls: UpstreamCallLog[] = [];
  /** Access-token lifetime (seconds) to mint for a given credential (the ID
   * token being exchanged or the refresh token being rotated); default 3600. */
  mintTtlByCredential = new Map<string, number>();
  defaultAccessTtlSeconds = 3600;
  private counter = 0;
  private seq = 0;
  private readonly previousFetch: typeof fetch;
  private installed = false;

  constructor() {
    this.previousFetch = globalThis.fetch;
  }

  install(): void {
    if (this.installed) return;
    globalThis.fetch = this.fetch.bind(this) as typeof fetch;
    this.installed = true;
  }

  restore(): void {
    if (!this.installed) return;
    globalThis.fetch = this.previousFetch;
    this.installed = false;
  }

  /** Forget every session/token/fault (users stay). Redis is swept, not cleared,
   * because a live deployment never loses L2 between two requests either. */
  resetSessions(): void {
    this.sessions.clear();
    this.accessTokens.clear();
    this.refreshTokens.clear();
    this.faults.clear();
    this.mintTtlByCredential.clear();
    this.calls = [];
    this.redis.sweep();
  }

  addUser(user: FakeUser): FakeUser {
    this.users.set(`${user.provider}:${user.subject}`, user);
    this.usersById.set(user.id, user);
    return user;
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}${this.counter.toString(36)}`;
  }

  mintSession(user: FakeUser, credential: string): { session: FakeSession; access: AccessRecord } {
    const session: FakeSession = {
      id: this.nextId("sess-"),
      userId: user.id,
      refreshToken: this.nextId("rt-"),
      revoked: false,
      accessTokens: [],
    };
    this.sessions.set(session.id, session);
    this.refreshTokens.set(session.refreshToken, session.id);
    const access = this.mintAccessToken(session, user, credential);
    return { session, access };
  }

  mintAccessToken(session: FakeSession, user: FakeUser, credential: string): AccessRecord {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ttl = this.mintTtlByCredential.get(credential) ?? this.defaultAccessTtlSeconds;
    this.mintTtlByCredential.delete(credential);
    const expSeconds = nowSeconds + ttl;
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = b64url(
      JSON.stringify({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: user.id,
        aud: "authenticated",
        role: "authenticated",
        iat: nowSeconds,
        exp: expSeconds,
        session_id: session.id,
        app_metadata: { provider: user.provider, providers: [user.provider] },
      }),
    );
    const token = `${header}.${payload}.${this.nextId("sig")}`;
    const record: AccessRecord = { token, sessionId: session.id, userId: user.id, expSeconds };
    this.accessTokens.set(token, record);
    session.accessTokens.push(token);
    return record;
  }

  sessionOfToken(token: string): FakeSession | null {
    const record = this.accessTokens.get(token);
    return record ? (this.sessions.get(record.sessionId) ?? null) : null;
  }

  private sessionJson(session: FakeSession, access: AccessRecord, user: FakeUser) {
    return {
      access_token: access.token,
      token_type: "bearer",
      expires_in: Math.max(1, access.expSeconds - Math.floor(Date.now() / 1000)),
      expires_at: access.expSeconds,
      refresh_token: session.refreshToken,
      user: this.userJson(user),
    };
  }

  private userJson(user: FakeUser) {
    return {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      app_metadata: { provider: user.provider, providers: [user.provider] },
      user_metadata: {},
      created_at: "2026-01-01T00:00:00.000Z",
    };
  }

  private takeFault(kind: UpstreamKind, token: string): number | null {
    const fault = this.faults.get(token);
    if (!fault || fault.kind !== kind) return null;
    this.faults.delete(token);
    return fault.status;
  }

  // ── Auth semantics (what a live GoTrue would answer) ──────────────────────

  private signIn(body: Record<string, unknown>): Response {
    const idToken = typeof body.id_token === "string" ? body.id_token : "";
    const provider = body.provider;
    const fault = this.takeFault("signin", idToken);
    if (fault !== null) return jsonResponse(fault, { code: fault, msg: "injected fault" });
    const payload = decodeJwtPayload(idToken);
    const iss = typeof payload?.iss === "string" ? payload.iss.replace(/^https:\/\//, "") : "";
    const issProvider =
      iss === "accounts.google.com" ? "google" : iss === "appleid.apple.com" ? "apple" : null;
    if (!issProvider || issProvider !== provider) {
      return jsonResponse(400, { code: 400, error_code: "validation_failed", msg: "Bad ID token" });
    }
    if (typeof payload?.exp !== "number" || payload.exp * 1000 <= Date.now()) {
      return jsonResponse(400, { code: 400, error_code: "bad_jwt", msg: "ID token expired" });
    }
    const user = this.users.get(`${issProvider}:${String(payload.sub)}`);
    if (!user) {
      return jsonResponse(400, { code: 400, error_code: "bad_jwt", msg: "Unknown subject" });
    }
    const { session, access } = this.mintSession(user, idToken);
    return jsonResponse(200, this.sessionJson(session, access, user));
  }

  private refresh(body: Record<string, unknown>): Response {
    const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
    const fault = this.takeFault("refresh", refreshToken);
    if (fault !== null) return jsonResponse(fault, { code: fault, msg: "injected fault" });
    const sessionId = this.refreshTokens.get(refreshToken);
    const session = sessionId ? this.sessions.get(sessionId) : null;
    if (!session || session.revoked) {
      return jsonResponse(400, {
        code: 400,
        error_code: "refresh_token_not_found",
        msg: "Invalid Refresh Token: Refresh Token Not Found",
      });
    }
    const user = this.usersById.get(session.userId)!;
    this.refreshTokens.delete(refreshToken);
    session.refreshToken = this.nextId("rt-");
    this.refreshTokens.set(session.refreshToken, session.id);
    const access = this.mintAccessToken(session, user, refreshToken);
    return jsonResponse(200, this.sessionJson(session, access, user));
  }

  private getUser(token: string): Response {
    const fault = this.takeFault("getuser", token);
    if (fault !== null) return jsonResponse(fault, { code: fault, msg: "injected fault" });
    const record = this.accessTokens.get(token);
    if (!record) return jsonResponse(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
    if (record.expSeconds * 1000 <= Date.now()) {
      return jsonResponse(401, { code: 401, error_code: "bad_jwt", msg: "token is expired" });
    }
    const session = this.sessions.get(record.sessionId);
    if (!session || session.revoked) {
      return jsonResponse(403, {
        code: 403,
        error_code: "session_not_found",
        msg: "Session from session_id claim in JWT does not exist",
      });
    }
    return jsonResponse(200, this.userJson(this.usersById.get(record.userId)!));
  }

  private logout(token: string): Response {
    const fault = this.takeFault("logout", token);
    if (fault !== null) return jsonResponse(fault, { code: fault, msg: "injected fault" });
    const record = this.accessTokens.get(token);
    if (!record) return jsonResponse(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
    const session = this.sessions.get(record.sessionId);
    if (!session || session.revoked) {
      return jsonResponse(403, { code: 403, error_code: "session_not_found", msg: "gone" });
    }
    session.revoked = true;
    this.refreshTokens.delete(session.refreshToken);
    return new Response(null, { status: 204 });
  }

  /** PostgREST accepts any unexpired, correctly signed JWT — it knows nothing
   * about session revocation. Mirror that: a revoked session's token still
   * reads its own profile row here; only Auth refuses it. */
  private rest(request: Request, url: URL, bearer: string): Response {
    const record = this.accessTokens.get(bearer);
    if (!record || record.expSeconds * 1000 <= Date.now()) {
      return jsonResponse(401, { code: "PGRST301", message: "JWT expired or invalid" });
    }
    const table = url.pathname.slice("/rest/v1/".length);
    if (table === "profiles" && request.method === "GET") {
      const idFilter = url.searchParams.get("id") ?? "";
      const id = idFilter.startsWith("eq.") ? idFilter.slice(3) : record.userId;
      const user = this.usersById.get(id);
      const single = (request.headers.get("accept") ?? "").includes("pgrst.object");
      if (!user || user.id !== record.userId) {
        return single
          ? jsonResponse(406, { code: "PGRST116", message: "0 rows", details: null, hint: null })
          : jsonResponse(200, []);
      }
      const row = {
        id: user.id,
        email: user.email,
        onboarding_state: "complete",
        provider: user.provider,
        skill_level: "intermediate",
        handedness: "right",
        primary_goal: "dinks",
        biggest_problem: "consistency",
        focus_checkpoint: "contact_position",
        first_name: "Test",
        gender: null,
      };
      return single ? jsonResponse(200, row) : jsonResponse(200, [row]);
    }
    if (request.method === "PATCH" || request.method === "POST") {
      return new Response(null, { status: 204 });
    }
    return jsonResponse(404, { code: "PGRST205", message: `unstubbed ${table}` });
  }

  private async parked<T>(kind: UpstreamKind, compute: () => T): Promise<T> {
    const gate = this.gate;
    if (!gate || !gate.shouldPark(kind)) return compute();
    const computeAt = gate.computeAt(kind);
    this.seq += 1;
    const seq = this.seq;
    const early = computeAt === "arrival" ? compute() : null;
    await new Promise<void>((release) => gate.park({ seq, kind, computeAt, release }));
    return computeAt === "arrival" ? (early as T) : compute();
  }

  private log(kind: UpstreamKind, response: Response, fault: number | null): Response {
    this.seq += 1;
    this.calls.push({ seq: this.seq, kind, atMs: Date.now(), status: response.status, fault });
    return response;
  }

  private async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

    if (request.url.startsWith(REDIS_URL)) {
      const commands = (await request.json().catch(() => [])) as Cmd[];
      if (request.headers.get("authorization") !== `Bearer ${REDIS_TOKEN}`) {
        return jsonResponse(401, { error: "Unauthorized" });
      }
      return jsonResponse(200, this.redis.run(Array.isArray(commands) ? commands : []));
    }

    if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/`)) {
      const endpoint = url.pathname.slice("/auth/v1/".length);
      if (endpoint === "token" && request.method === "POST") {
        const raw = (await request.json().catch(() => ({}))) as unknown;
        const body = isRecord(raw) ? raw : {};
        const grant = url.searchParams.get("grant_type");
        if (grant === "id_token") {
          const idToken = typeof body.id_token === "string" ? body.id_token : "";
          const fault =
            this.faults.get(idToken)?.kind === "signin" ? this.faults.get(idToken)!.status : null;
          return this.log("signin", await this.parked("signin", () => this.signIn(body)), fault);
        }
        if (grant === "refresh_token") {
          const rt = typeof body.refresh_token === "string" ? body.refresh_token : "";
          const fault =
            this.faults.get(rt)?.kind === "refresh" ? this.faults.get(rt)!.status : null;
          return this.log("refresh", await this.parked("refresh", () => this.refresh(body)), fault);
        }
        return jsonResponse(400, { code: 400, msg: `unsupported grant ${grant}` });
      }
      if (endpoint === "user" && request.method === "GET") {
        const fault =
          this.faults.get(bearer)?.kind === "getuser" ? this.faults.get(bearer)!.status : null;
        return this.log("getuser", await this.parked("getuser", () => this.getUser(bearer)), fault);
      }
      if (endpoint === "logout" && request.method === "POST") {
        const fault =
          this.faults.get(bearer)?.kind === "logout" ? this.faults.get(bearer)!.status : null;
        return this.log("logout", await this.parked("logout", () => this.logout(bearer)), fault);
      }
      return jsonResponse(404, { code: 404, msg: `unstubbed auth endpoint ${endpoint}` });
    }

    if (request.url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      return this.rest(request, url, bearer);
    }

    return new Response(`unexpected fetch in xc harness: ${request.method} ${request.url}`, {
      status: 599,
    });
  }
}
