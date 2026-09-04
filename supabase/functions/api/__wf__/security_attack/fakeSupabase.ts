// Stateful fake of the Supabase surface the edge function talks to, installed
// at the fetch layer (no sockets). Unlike the routing-only stubs elsewhere in
// __wf__, this one behaves like GoTrue + PostgREST for the purpose of an
// authentication attack:
//
//   Auth  POST /auth/v1/token?grant_type=id_token       — RS256-verifies the
//         provider ID token against the fake provider's key (alg pinned,
//         exp, iss, aud), then mints a session (HS256 access token +
//         opaque rotating refresh token).
//         POST /auth/v1/token?grant_type=refresh_token  — rotation with
//         reuse detection: a refresh token that was already rotated away
//         is refused and (like GoTrue) revokes the whole session family.
//         GET  /auth/v1/user                            — verifies the HS256
//         access token (alg pinned, signature, exp) AND that the session in
//         its `session_id` claim still exists (GoTrue: session_not_found).
//         POST /auth/v1/logout?scope=local              — revokes the bearer's
//         session.
//         DELETE /auth/v1/admin/users/:id               — deletes a user.
//   REST  /rest/v1/*  — verifies the bearer the way PostgREST does (signature
//         + exp ONLY — PostgREST does not know about sessions), records the
//         call, and serves the caller's own profile row.
//   Redis POST <UPSTASH>/pipeline — optional in-memory Upstash lookalike so
//         the L1/L2 cache split can be exercised.
//
// Every upstream call is recorded (method, path, which token kind it
// carried, status) so a test can prove "the edge never reached the database
// with this bearer" rather than infer it.

import {
  decodeSegment,
  generateRsaSigner,
  type JwtClaims,
  type RsaSigner,
  signHs256,
  signRs256,
  splitJwt,
  verifyHs256,
  verifyRs256,
} from "./jwt.ts";

export const FAKE_SUPABASE_URL = "http://supabase.attack.test";
export const FAKE_ANON_KEY = "anon-attack-harness-key";
export const FAKE_REDIS_URL = "http://upstash.attack.test";
export const FAKE_REDIS_TOKEN = "upstash-attack-harness-token";
export const GOOGLE_CLIENT_ID = "attack-harness-google-client";
export const APPLE_CLIENT_ID = "com.picklesensei";

export type Provider = "google" | "apple";

export interface FakeUser {
  id: string;
  email: string | null;
  /** app_metadata.provider as GoTrue reports it. */
  provider: Provider | "email" | "anonymous";
  providerSub: string;
  deleted: boolean;
}

export interface FakeSession {
  id: string;
  userId: string;
  /** Refresh token currently valid for this session. */
  currentRefreshToken: string;
  /** Refresh tokens already rotated away (reuse ⇒ refusal + family revoke). */
  retiredRefreshTokens: Set<string>;
  revoked: boolean;
  createdAtMs: number;
}

export interface UpstreamCall {
  index: number;
  method: string;
  path: string;
  /** Classification of the bearer the upstream call carried. */
  bearer: "none" | "anon-key" | "access-token" | "provider-token" | "other";
  bearerSha256Prefix: string | null;
  status: number;
  note?: string;
}

export interface FakeOverrides {
  /** Replace the response of GET /auth/v1/user (throwing simulates a network failure). */
  getUser?: (request: Request) => Promise<Response> | Response;
  /** Replace the response of the refresh_token grant. */
  refresh?: (request: Request) => Promise<Response> | Response;
  /** Replace the response of the logout call. */
  logout?: (request: Request) => Promise<Response> | Response;
  /** Awaited before GET /auth/v1/user answers (TOCTOU experiments). */
  getUserGate?: () => Promise<void>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const gotrueError = (status: number, code: string, msg: string): Response =>
  json(status, { code: status, error_code: code, msg });

const grantError = (description: string): Response =>
  json(400, { error: "invalid_grant", error_description: description });

async function sha256Prefix(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 16): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class FakeSupabase {
  /** Test-process HS256 secret for Supabase access tokens (not a real key). */
  readonly jwtSecret = `attack-harness-jwt-secret-${randomToken(8)}`;
  /** A second secret nobody legitimate signs with — "other project" forgeries. */
  readonly foreignJwtSecret = `foreign-project-secret-${randomToken(8)}`;
  readonly users = new Map<string, FakeUser>();
  readonly sessions = new Map<string, FakeSession>();
  readonly refreshIndex = new Map<string, string>();
  readonly calls: UpstreamCall[] = [];
  readonly redis = new Map<string, { value: string; expiresAtMs: number | null }>();
  overrides: FakeOverrides = {};
  accessTokenTtlSeconds = 3600;
  /** Minted sessions per provider exchange, to observe transitional-branch churn. */
  idTokenExchanges = 0;

  private constructor(
    readonly providerSigners: Record<Provider, RsaSigner>,
    /** A key pair that is NOT trusted for any provider — attacker-controlled. */
    readonly rogueSigner: RsaSigner,
    readonly realFetch: typeof fetch,
  ) {}

  static async create(): Promise<FakeSupabase> {
    const [google, apple, rogue] = await Promise.all([
      generateRsaSigner("google-kid-1"),
      generateRsaSigner("apple-kid-1"),
      generateRsaSigner("rogue-kid-1"),
    ]);
    return new FakeSupabase({ google, apple }, rogue, globalThis.fetch);
  }

  // ─── Fixtures ─────────────────────────────────────────────────────────────

  addUser(user: Omit<FakeUser, "deleted">): FakeUser {
    const full = { ...user, deleted: false };
    this.users.set(user.id, full);
    return full;
  }

  /** A provider ID token exactly as Google/Apple would issue it for this harness. */
  async providerIdToken(
    provider: Provider,
    sub: string,
    overrides: { claims?: JwtClaims; header?: JwtClaims; signer?: RsaSigner } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const iss = provider === "google" ? "https://accounts.google.com" : "https://appleid.apple.com";
    const aud = provider === "google" ? GOOGLE_CLIENT_ID : APPLE_CLIENT_ID;
    const signer = overrides.signer ?? this.providerSigners[provider];
    const header = { alg: "RS256", typ: "JWT", kid: signer.kid, ...overrides.header };
    const payload = {
      iss,
      sub,
      aud,
      iat: now,
      exp: now + 3600,
      email: `${sub}@example.test`,
      ...overrides.claims,
    };
    return await signRs256(header, payload, signer);
  }

  /** Mint a session for `userId` the way an id_token exchange would. */
  async mintSession(
    userId: string,
    options: { accessTokenClaims?: JwtClaims; header?: JwtClaims } = {},
  ): Promise<{ session: FakeSession; accessToken: string; expiresAt: number }> {
    const session: FakeSession = {
      id: crypto.randomUUID(),
      userId,
      currentRefreshToken: randomToken(),
      retiredRefreshTokens: new Set(),
      revoked: false,
      createdAtMs: Date.now(),
    };
    this.sessions.set(session.id, session);
    this.refreshIndex.set(session.currentRefreshToken, session.id);
    const { token, expiresAt } = await this.accessTokenFor(session, options);
    return { session, accessToken: token, expiresAt };
  }

  private lastIssuedAtBySession = new Map<string, number>();

  async accessTokenFor(
    session: FakeSession,
    options: { accessTokenClaims?: JwtClaims; header?: JwtClaims; secret?: string } = {},
  ): Promise<{ token: string; expiresAt: number }> {
    const user = this.users.get(session.userId);
    // Two tokens minted for one session within the same wall-clock second
    // would otherwise be byte-identical; model time passing between them.
    const previous = this.lastIssuedAtBySession.get(session.id) ?? 0;
    const now = Math.max(Math.floor(Date.now() / 1000), previous + 1);
    this.lastIssuedAtBySession.set(session.id, now);
    const expiresAt = now + this.accessTokenTtlSeconds;
    const payload: JwtClaims = {
      iss: `${FAKE_SUPABASE_URL}/auth/v1`,
      sub: session.userId,
      aud: "authenticated",
      role: "authenticated",
      exp: expiresAt,
      iat: now,
      email: user?.email ?? undefined,
      app_metadata: { provider: user?.provider ?? "email", providers: [user?.provider ?? "email"] },
      session_id: session.id,
      ...options.accessTokenClaims,
    };
    const header = { alg: "HS256", typ: "JWT", ...options.header };
    const token = await signHs256(header, payload, options.secret ?? this.jwtSecret);
    return { token, expiresAt: typeof payload.exp === "number" ? payload.exp : expiresAt };
  }

  private sessionJson(session: FakeSession, accessToken: string, expiresAt: number) {
    const user = this.users.get(session.userId)!;
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.accessTokenTtlSeconds,
      expires_at: expiresAt,
      refresh_token: session.currentRefreshToken,
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
      identities: [
        { id: user.providerSub, user_id: user.id, provider: user.provider },
      ],
      created_at: new Date(0).toISOString(),
    };
  }

  // ─── Verification (GoTrue / PostgREST semantics) ──────────────────────────

  /** GoTrue-style access-token check: alg pinned to HS256, signature with the
   * project secret, exp in the future, and — for /user — a live session. */
  async verifyAccessToken(
    token: string,
    options: { requireLiveSession: boolean },
  ): Promise<{ ok: true; userId: string; sessionId: string | null } | { ok: false; status: number; code: string }> {
    const parts = splitJwt(token);
    if (!parts) return { ok: false, status: 401, code: "bad_jwt" };
    const header = decodeSegment(parts.header);
    const payload = decodeSegment(parts.payload);
    if (!header || !payload) return { ok: false, status: 401, code: "bad_jwt" };
    if (header.alg !== "HS256") return { ok: false, status: 401, code: "bad_jwt" };
    if (!(await verifyHs256(token, this.jwtSecret))) return { ok: false, status: 401, code: "bad_jwt" };
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
      return { ok: false, status: 401, code: "bad_jwt" };
    }
    if (typeof payload.sub !== "string") return { ok: false, status: 401, code: "bad_jwt" };
    const user = this.users.get(payload.sub);
    if (!user || user.deleted) return { ok: false, status: 403, code: "user_not_found" };
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
    if (options.requireLiveSession) {
      const session = sessionId ? this.sessions.get(sessionId) : undefined;
      if (!session || session.revoked) return { ok: false, status: 403, code: "session_not_found" };
    }
    return { ok: true, userId: payload.sub, sessionId };
  }

  async verifyProviderToken(
    provider: Provider,
    token: string,
  ): Promise<{ ok: true; sub: string; email: string | null } | { ok: false; reason: string }> {
    const parts = splitJwt(token);
    if (!parts) return { ok: false, reason: "malformed" };
    const header = decodeSegment(parts.header);
    const payload = decodeSegment(parts.payload);
    if (!header || !payload) return { ok: false, reason: "undecodable" };
    if (header.alg !== "RS256") return { ok: false, reason: `alg ${String(header.alg)} not allowed` };
    const signer = this.providerSigners[provider];
    if (header.kid !== undefined && header.kid !== signer.kid) {
      return { ok: false, reason: "unknown kid" };
    }
    if (!(await verifyRs256(token, signer))) return { ok: false, reason: "bad signature" };
    const expectedIss =
      provider === "google"
        ? ["https://accounts.google.com", "accounts.google.com"]
        : ["https://appleid.apple.com"];
    if (typeof payload.iss !== "string" || !expectedIss.includes(payload.iss)) {
      return { ok: false, reason: "issuer mismatch" };
    }
    const expectedAud = provider === "google" ? GOOGLE_CLIENT_ID : APPLE_CLIENT_ID;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(expectedAud)) return { ok: false, reason: "audience mismatch" };
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
      return { ok: false, reason: "expired" };
    }
    if (typeof payload.sub !== "string" || !payload.sub) return { ok: false, reason: "no subject" };
    return { ok: true, sub: payload.sub, email: typeof payload.email === "string" ? payload.email : null };
  }

  // ─── Fetch handler ────────────────────────────────────────────────────────

  private async classifyBearer(request: Request): Promise<Pick<UpstreamCall, "bearer" | "bearerSha256Prefix">> {
    const authorization = request.headers.get("Authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return { bearer: "none", bearerSha256Prefix: null };
    const token = authorization.slice("Bearer ".length).trim();
    const prefix = await sha256Prefix(token);
    if (token === FAKE_ANON_KEY) return { bearer: "anon-key", bearerSha256Prefix: prefix };
    const payload = splitJwt(token) ? decodeSegment(splitJwt(token)!.payload) : null;
    if (typeof payload?.iss === "string") {
      if (payload.iss.endsWith("/auth/v1")) return { bearer: "access-token", bearerSha256Prefix: prefix };
      if (/google|apple/.test(payload.iss)) return { bearer: "provider-token", bearerSha256Prefix: prefix };
    }
    return { bearer: "other", bearerSha256Prefix: prefix };
  }

  install(): () => void {
    const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const classified = await this.classifyBearer(request);
      const record: UpstreamCall = {
        index: this.calls.length,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        ...classified,
        status: 0,
      };
      this.calls.push(record);
      let response: Response;
      try {
        response = await this.route(request, url);
      } catch (error) {
        record.status = -1;
        record.note = `threw: ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      }
      record.status = response.status;
      return response;
    };
    globalThis.fetch = handler as typeof fetch;
    return () => {
      globalThis.fetch = this.realFetch;
    };
  }

  private async route(request: Request, url: URL): Promise<Response> {
    if (url.origin === FAKE_REDIS_URL) return this.redisPipeline(request);
    if (url.origin !== FAKE_SUPABASE_URL) {
      return new Response(`unexpected fetch in attack harness: ${request.method} ${url}`, {
        status: 599,
      });
    }
    const path = url.pathname;
    if (path === "/auth/v1/token") {
      const grant = url.searchParams.get("grant_type");
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (grant === "id_token") return this.idTokenGrant(body);
      if (grant === "refresh_token") {
        if (this.overrides.refresh) return await this.overrides.refresh(request);
        return this.refreshGrant(body);
      }
      return grantError(`unsupported grant_type ${grant}`);
    }
    if (path === "/auth/v1/user" && request.method === "GET") {
      if (this.overrides.getUserGate) await this.overrides.getUserGate();
      if (this.overrides.getUser) return await this.overrides.getUser(request);
      return this.getUser(request);
    }
    if (path === "/auth/v1/logout" && request.method === "POST") {
      if (this.overrides.logout) return await this.overrides.logout(request);
      return this.logout(request);
    }
    if (path.startsWith("/auth/v1/admin/users/") && request.method === "DELETE") {
      const id = path.slice("/auth/v1/admin/users/".length);
      const user = this.users.get(id);
      if (!user) return gotrueError(404, "user_not_found", "User not found");
      user.deleted = true;
      for (const session of this.sessions.values()) {
        if (session.userId === id) session.revoked = true;
      }
      return json(200, {});
    }
    if (path.startsWith("/rest/v1/")) return this.rest(request, url);
    return new Response(`unexpected fetch in attack harness: ${request.method} ${url}`, {
      status: 599,
    });
  }

  private async idTokenGrant(body: Record<string, unknown>): Promise<Response> {
    const provider = body.provider;
    const token = typeof body.id_token === "string" ? body.id_token : "";
    if (provider !== "google" && provider !== "apple") {
      return grantError("Provider must be google or apple");
    }
    const verified = await this.verifyProviderToken(provider, token);
    if (!verified.ok) return grantError(`ID token verification failed: ${verified.reason}`);
    let user = [...this.users.values()].find(
      (candidate) => candidate.provider === provider && candidate.providerSub === verified.sub && !candidate.deleted,
    );
    if (!user) {
      user = this.addUser({
        id: crypto.randomUUID(),
        email: verified.email,
        provider,
        providerSub: verified.sub,
      });
    }
    this.idTokenExchanges += 1;
    const minted = await this.mintSession(user.id);
    return json(200, this.sessionJson(minted.session, minted.accessToken, minted.expiresAt));
  }

  private async refreshGrant(body: Record<string, unknown>): Promise<Response> {
    const presented = typeof body.refresh_token === "string" ? body.refresh_token : "";
    const sessionId = this.refreshIndex.get(presented);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) return grantError("Invalid Refresh Token: Refresh Token Not Found");
    if (session.revoked) return grantError("Invalid Refresh Token: Session Expired");
    if (session.retiredRefreshTokens.has(presented)) {
      // GoTrue: reuse of a rotated-away token outside the reuse interval
      // revokes the whole family.
      session.revoked = true;
      return grantError("Invalid Refresh Token: Already Used");
    }
    if (session.currentRefreshToken !== presented) {
      return grantError("Invalid Refresh Token: Refresh Token Not Found");
    }
    const user = this.users.get(session.userId);
    if (!user || user.deleted) return grantError("Invalid Refresh Token: User Not Found");
    session.retiredRefreshTokens.add(presented);
    session.currentRefreshToken = randomToken();
    this.refreshIndex.set(session.currentRefreshToken, session.id);
    const { token, expiresAt } = await this.accessTokenFor(session);
    return json(200, this.sessionJson(session, token, expiresAt));
  }

  private async getUser(request: Request): Promise<Response> {
    const authorization = request.headers.get("Authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const verified = await this.verifyAccessToken(token, { requireLiveSession: true });
    if (!verified.ok) {
      return gotrueError(verified.status, verified.code, `rejected: ${verified.code}`);
    }
    return json(200, this.userJson(this.users.get(verified.userId)!));
  }

  private async logout(request: Request): Promise<Response> {
    const authorization = request.headers.get("Authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const verified = await this.verifyAccessToken(token, { requireLiveSession: true });
    if (!verified.ok) {
      return gotrueError(verified.status, verified.code, `rejected: ${verified.code}`);
    }
    if (verified.sessionId) {
      const session = this.sessions.get(verified.sessionId);
      if (session) session.revoked = true;
    }
    return new Response(null, { status: 204 });
  }

  /** PostgREST: signature + exp only. Sessions are invisible to it, which is
   * exactly why a stale edge auth-cache entry is a real data-plane hole. */
  private async rest(request: Request, url: URL): Promise<Response> {
    const authorization = request.headers.get("Authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const verified = await this.verifyAccessToken(token, { requireLiveSession: false });
    if (!verified.ok) {
      return json(401, { code: "PGRST301", message: "JWT rejected by PostgREST fake" });
    }
    const resource = url.pathname.slice("/rest/v1/".length);
    const accept = request.headers.get("Accept") ?? "";
    if (resource === "profiles" && request.method === "GET") {
      const user = this.users.get(verified.userId);
      const rows = user && !user.deleted
        ? [
            {
              id: user.id,
              email: user.email,
              onboarding_state: "complete",
              provider: user.provider,
              skill_level: "intermediate",
              handedness: "right",
              primary_goal: null,
              biggest_problem: null,
              focus_checkpoint: null,
              first_name: null,
              gender: null,
            },
          ]
        : [];
      if (accept.includes("application/vnd.pgrst.object+json")) {
        if (rows.length === 0) return json(406, { code: "PGRST116", message: "0 rows" });
        return json(200, rows[0]);
      }
      return json(200, rows);
    }
    if (resource.startsWith("rpc/")) return json(200, null);
    if (request.method === "GET") return json(200, []);
    if (request.method === "PATCH" || request.method === "POST") return new Response(null, { status: 201 });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    return json(405, { message: "method not supported by fake" });
  }

  // ─── Upstash lookalike ────────────────────────────────────────────────────

  private redisGet(key: string): string | null {
    const entry = this.redis.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      this.redis.delete(key);
      return null;
    }
    return entry.value;
  }

  private async redisPipeline(request: Request): Promise<Response> {
    if (request.headers.get("Authorization") !== `Bearer ${FAKE_REDIS_TOKEN}`) {
      return json(401, { error: "Unauthorized" });
    }
    const commands = (await request.json()) as Array<Array<string | number>>;
    const results = commands.map((command) => {
      const [op, ...args] = command.map(String);
      switch (op) {
        case "GET":
          return { result: this.redisGet(args[0]) };
        case "TTL": {
          const entry = this.redis.get(args[0]);
          if (!entry || this.redisGet(args[0]) === null) return { result: -2 };
          if (entry.expiresAtMs === null) return { result: -1 };
          return { result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000)) };
        }
        case "SET": {
          const exIndex = args.indexOf("EX");
          const ttl = exIndex >= 0 ? Number(args[exIndex + 1]) : null;
          this.redis.set(args[0], {
            value: args[1],
            expiresAtMs: ttl !== null ? Date.now() + ttl * 1000 : null,
          });
          return { result: "OK" };
        }
        case "DEL": {
          let removed = 0;
          for (const key of args) if (this.redis.delete(key)) removed += 1;
          return { result: removed };
        }
        case "INCR": {
          const current = Number(this.redisGet(args[0]) ?? 0) + 1;
          const existing = this.redis.get(args[0]);
          this.redis.set(args[0], { value: String(current), expiresAtMs: existing?.expiresAtMs ?? null });
          return { result: current };
        }
        case "EXPIRE": {
          const entry = this.redis.get(args[0]);
          if (!entry) return { result: 0 };
          if (args[2] === "NX" && entry.expiresAtMs !== null) return { result: 0 };
          entry.expiresAtMs = Date.now() + Number(args[1]) * 1000;
          return { result: 1 };
        }
        default:
          return { error: `unsupported command ${op}` };
      }
    });
    return json(200, results);
  }

  // ─── Introspection ────────────────────────────────────────────────────────

  callsSince(index: number): UpstreamCall[] {
    return this.calls.slice(index);
  }

  restCallsWith(bearerSha256Prefix: string | null, since = 0): UpstreamCall[] {
    return this.calls
      .slice(since)
      .filter((call) => call.path.startsWith("/rest/v1/") && call.bearerSha256Prefix === bearerSha256Prefix);
  }
}

export { sha256Prefix };
