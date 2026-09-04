// Session-contract harness for the edge function (companion to
// routesHarness.ts): boots the REAL ../index.ts with Deno.serve captured and
// a stateful fake GoTrue behind fetch — sessions are minted by the id_token
// grant, rotated by the refresh_token grant, verified by GET /auth/v1/user
// and revoked by POST /auth/v1/logout — so bootstrap / refresh / logout /
// authenticate() can be exercised as one lifecycle instead of as isolated
// stubs. PostgREST answers with a minimal profile row.
//
// Nothing here talks to a network: the only fetch that exists is the fake.

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
  /** Unix seconds. */
  expiresAt: number;
  revoked: boolean;
}

export interface FakeUser {
  id: string;
  email: string;
  /** app_metadata.provider as GoTrue reports it (google | apple | email…). */
  provider: string;
}

export interface FakeRedisEntry {
  value: string;
  /** Unix ms; Infinity = no expiry. */
  expiresAtMs: number;
}

export interface SessionHarness {
  handler: (request: Request) => Promise<Response>;
  /** The fake Upstash store (only populated when loaded with `redis: true`). */
  redis: Map<string, FakeRedisEntry>;
  /** Every Redis pipeline the function issued, in order. */
  redisCommands: Array<Array<string | number>>;
  calls: RecordedCall[];
  callsTo(fragment: string): RecordedCall[];
  users: Map<string, FakeUser>;
  sessions: Map<string, FakeSession>;
  refreshTokens: Map<string, { userId: string; sessionAccessToken: string; spent: boolean }>;
  /** Lifetime of minted access tokens (seconds). */
  accessTokenTtlSeconds: number;
  /** Force this HTTP status from the refresh_token grant (null = real fake). */
  refreshGrantStatus: number | null;
  /** Force this HTTP status from GET /auth/v1/user (null = real fake). */
  getUserStatus: number | null;
  /** Force this HTTP status from POST /auth/v1/logout (null = 204). */
  logoutStatus: number | null;
  /** Rows returned for PostgREST GET by table name. */
  tables: Record<string, unknown[]>;
  /** Rows returned for PostgREST RPC POST by function name. */
  rpcs: Record<string, unknown>;
  reset(): void;
  /** Mint a session directly (as if bootstrap had run) and return its tokens.
   * `sessionId` reuses an existing GoTrue session id (a refresh rotation, or
   * a sibling access token of the same session) instead of opening a new one. */
  mintSession(userId: string, ttlSeconds?: number, options?: { sessionId?: string }): FakeSession;
  /** The GoTrue `session_id` claim carried by a minted access token. */
  sessionIdOf(accessToken: string): string;
  registerUser(user: FakeUser): void;
}

export const SUPABASE_URL = "http://supabase.session.test";
export const REDIS_URL = "http://upstash.session.test";
export const GOOGLE_USER_ID = "33333333-3333-4333-8333-333333333333";
export const APPLE_USER_ID = "44444444-4444-4444-8444-444444444444";
export const EMAIL_USER_ID = "55555555-5555-4555-8555-555555555555";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function jwtPayload(token: string): Record<string, unknown> | null {
  return decodeSegment(token.split(".")[1] ?? "");
}

/** Unsigned JWT with the given payload (issuer routing / expiry only). */
export function fakeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.${b64url(crypto.randomUUID())}`;
}

export function googleIdToken(sub = GOOGLE_USER_ID, ttlSeconds = 3600): string {
  return fakeJwt({
    iss: "https://accounts.google.com",
    sub,
    jti: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

export function appleIdToken(sub = APPLE_USER_ID, ttlSeconds = 3600): string {
  return fakeJwt({
    iss: "https://appleid.apple.com",
    sub,
    jti: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

/** A Supabase-shaped access token nobody minted: right issuer, no session. */
export function forgedSessionToken(sub = GOOGLE_USER_ID, ttlSeconds = 3600): string {
  return fakeJwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub,
    aud: "authenticated",
    role: "authenticated",
    jti: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

function profileRow(user: FakeUser): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    onboarding_state: "complete",
    provider: user.provider,
    skill_level: "intermediate",
    handedness: "right",
    primary_goal: "consistency",
    biggest_problem: "pop-ups",
    focus_checkpoint: "paddle_face",
    first_name: "Pat",
    gender: null,
  };
}

function gotrueUser(user: FakeUser): Record<string, unknown> {
  return {
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: user.email,
    app_metadata: { provider: user.provider, providers: [user.provider] },
    user_metadata: {},
    identities: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

let harness: SessionHarness | null = null;

/** Boot the real edge function once per test module. `redis: true` wires a
 * fake Upstash REST endpoint so the L2 cache / shared rate-limit paths run;
 * the choice is fixed at first load because cache.ts reads its env at import. */
export async function loadSessionHarness(
  options: { redis?: boolean } = {},
): Promise<SessionHarness> {
  if (harness) {
    harness.reset();
    return harness;
  }

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-test-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "wf-test-webhook-secret");
  Deno.env.delete("APPLE_SIGN_IN_CLIENT_ID");
  Deno.env.delete("APPLE_SIGN_IN_TEAM_ID");
  Deno.env.delete("APPLE_SIGN_IN_KEY_ID");
  Deno.env.delete("APPLE_SIGN_IN_PRIVATE_KEY");
  Deno.env.delete("APPLE_TOKEN_ENCRYPTION_KEY");
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", "upstash-test-token");
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const authError = (status: number, msg: string): Response =>
    jsonResponse(status, { code: status, msg, error_code: "bad_jwt" });

  const state: SessionHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    redis: new Map(),
    redisCommands: [],
    calls: [],
    callsTo(fragment: string) {
      return state.calls.filter((call) => call.url.includes(fragment));
    },
    users: new Map(),
    sessions: new Map(),
    refreshTokens: new Map(),
    accessTokenTtlSeconds: 3600,
    refreshGrantStatus: null,
    getUserStatus: null,
    logoutStatus: null,
    tables: {},
    rpcs: {},
    reset() {
      state.calls = [];
      state.redis = new Map();
      state.redisCommands = [];
      state.users = new Map();
      state.sessions = new Map();
      state.refreshTokens = new Map();
      state.accessTokenTtlSeconds = 3600;
      state.refreshGrantStatus = null;
      state.getUserStatus = null;
      state.logoutStatus = null;
      state.tables = {};
      state.rpcs = {};
      state.registerUser({ id: GOOGLE_USER_ID, email: "google@example.com", provider: "google" });
      state.registerUser({ id: APPLE_USER_ID, email: "apple@example.com", provider: "apple" });
      state.registerUser({ id: EMAIL_USER_ID, email: "email@example.com", provider: "email" });
    },
    registerUser(user: FakeUser) {
      state.users.set(user.id, user);
    },
    mintSession(
      userId: string,
      ttlSeconds = state.accessTokenTtlSeconds,
      options: { sessionId?: string } = {},
    ): FakeSession {
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      const accessToken = fakeJwt({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: userId,
        aud: "authenticated",
        role: "authenticated",
        session_id: options.sessionId ?? crypto.randomUUID(),
        exp: expiresAt,
      });
      const refreshToken = `rt-${crypto.randomUUID()}`;
      const session: FakeSession = { userId, accessToken, refreshToken, expiresAt, revoked: false };
      state.sessions.set(accessToken, session);
      state.refreshTokens.set(refreshToken, {
        userId,
        sessionAccessToken: accessToken,
        spent: false,
      });
      return session;
    },
    sessionIdOf(accessToken: string): string {
      const sessionId = jwtPayload(accessToken)?.session_id;
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("access token carries no session_id claim");
      }
      return sessionId;
    },
  };
  state.reset();

  const sessionJson = (session: FakeSession, user: FakeUser) => ({
    access_token: session.accessToken,
    token_type: "bearer",
    expires_in: Math.max(1, session.expiresAt - Math.floor(Date.now() / 1000)),
    expires_at: session.expiresAt,
    refresh_token: session.refreshToken,
    user: gotrueUser(user),
  });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    let body: unknown = null;
    const text = await request.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    state.calls.push({ url, method: request.method, headers, body });
    const parsed = new URL(url);

    if (url === `${REDIS_URL}/pipeline`) {
      if (headers["authorization"] !== "Bearer upstash-test-token") {
        return jsonResponse(401, { error: "Unauthorized" });
      }
      const commands = Array.isArray(body) ? (body as Array<Array<string | number>>) : [];
      return jsonResponse(
        200,
        commands.map((command) => runRedisCommand(state, command)),
      );
    }

    if (url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
      const grant = parsed.searchParams.get("grant_type");
      const payload = isRecord(body) ? body : {};
      if (grant === "id_token") {
        const idToken = typeof payload.id_token === "string" ? payload.id_token : "";
        const claims = jwtPayload(idToken);
        const sub = typeof claims?.sub === "string" ? claims.sub : "";
        const user = state.users.get(sub);
        if (!user || user.provider !== payload.provider) {
          return jsonResponse(400, {
            error: "invalid_grant",
            error_description: "Bad ID token",
            error_code: "bad_id_token",
          });
        }
        const session = state.mintSession(user.id);
        return jsonResponse(200, sessionJson(session, user));
      }
      if (grant === "refresh_token") {
        if (state.refreshGrantStatus !== null) {
          return jsonResponse(state.refreshGrantStatus, {
            error: "server_error",
            error_description: `forced ${state.refreshGrantStatus}`,
            error_code: "unexpected_failure",
          });
        }
        const presented = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
        const entry = state.refreshTokens.get(presented);
        const previous = entry ? state.sessions.get(entry.sessionAccessToken) : undefined;
        if (!entry || entry.spent || !previous || previous.revoked) {
          return jsonResponse(400, {
            error: "invalid_grant",
            error_description: "Invalid Refresh Token: Refresh Token Not Found",
            error_code: "refresh_token_not_found",
          });
        }
        entry.spent = true;
        previous.revoked = true;
        const user = state.users.get(entry.userId)!;
        // GoTrue rotates the tokens of ONE session: session_id is stable.
        const session = state.mintSession(user.id, state.accessTokenTtlSeconds, {
          sessionId: state.sessionIdOf(previous.accessToken),
        });
        return jsonResponse(200, sessionJson(session, user));
      }
      return jsonResponse(400, { error: "unsupported_grant_type" });
    }

    if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`) && request.method === "GET") {
      if (state.getUserStatus !== null) {
        return authError(state.getUserStatus, `forced ${state.getUserStatus}`);
      }
      const bearer = (headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
      const session = state.sessions.get(bearer);
      if (!session || session.revoked) return authError(401, "invalid JWT: session not found");
      if (session.expiresAt * 1000 <= Date.now())
        return authError(401, "invalid JWT: token is expired");
      const user = state.users.get(session.userId)!;
      return jsonResponse(200, gotrueUser(user));
    }

    if (url.startsWith(`${SUPABASE_URL}/auth/v1/logout`) && request.method === "POST") {
      if (state.logoutStatus !== null) {
        return authError(state.logoutStatus, `forced ${state.logoutStatus}`);
      }
      const bearer = (headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
      const session = state.sessions.get(bearer);
      if (!session) return authError(401, "invalid JWT: session not found");
      const scope = parsed.searchParams.get("scope") ?? "global";
      const targets =
        scope === "local"
          ? [session]
          : [...state.sessions.values()].filter((s) => s.userId === session.userId);
      for (const target of targets) {
        target.revoked = true;
        for (const entry of state.refreshTokens.values()) {
          if (entry.sessionAccessToken === target.accessToken) entry.spent = true;
        }
      }
      return new Response(null, { status: 204 });
    }

    if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      const table = parsed.pathname.slice("/rest/v1/".length);
      if (table.startsWith("rpc/")) {
        const fn = table.slice("rpc/".length);
        return jsonResponse(200, state.rpcs[fn] ?? {});
      }
      if (request.method === "GET") {
        let rows = state.tables[table];
        if (!rows && table === "profiles") {
          const bearer = (headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
          const sub = jwtPayload(bearer)?.sub;
          const user = typeof sub === "string" ? state.users.get(sub) : undefined;
          rows = user ? [profileRow(user)] : [];
        }
        rows ??= [];
        const accept = headers["accept"] ?? "";
        if (accept.includes("application/vnd.pgrst.object+json")) {
          if (rows.length === 0) {
            return jsonResponse(406, {
              code: "PGRST116",
              message: "0 rows",
              details: null,
              hint: null,
            });
          }
          return jsonResponse(200, rows[0]);
        }
        return jsonResponse(200, rows);
      }
      if (request.method === "POST" || request.method === "PATCH") {
        return new Response(null, { status: 201 });
      }
      if (request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
    }
    return new Response(`unexpected fetch in test: ${request.method} ${url}`, { status: 599 });
  }) as typeof fetch;

  Deno.serve = ((...args: unknown[]) => {
    const handler = args.find((arg) => typeof arg === "function") as
      ((request: Request) => Promise<Response>) | undefined;
    if (!handler) throw new Error("Deno.serve called without a handler");
    state.handler = handler;
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as ReturnType<typeof Deno.serve>;
  }) as typeof Deno.serve;

  await import("../index.ts");
  harness = state;
  return state;
}

function redisLive(state: SessionHarness, key: string): FakeRedisEntry | null {
  const entry = state.redis.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    state.redis.delete(key);
    return null;
  }
  return entry;
}

/** Minimal Upstash-compatible executor for the commands cache.ts issues. */
function runRedisCommand(
  state: SessionHarness,
  command: Array<string | number>,
): { result?: unknown; error?: string } {
  state.redisCommands.push(command);
  const [op, ...args] = command.map((part) => String(part));
  switch (op) {
    case "GET":
      return { result: redisLive(state, args[0])?.value ?? null };
    case "TTL": {
      const entry = redisLive(state, args[0]);
      if (!entry) return { result: -2 };
      if (!Number.isFinite(entry.expiresAtMs)) return { result: -1 };
      return { result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000)) };
    }
    case "SET": {
      const ttl = args[2] === "EX" ? Number(args[3]) : NaN;
      state.redis.set(args[0], {
        value: args[1],
        expiresAtMs: Number.isFinite(ttl) ? Date.now() + ttl * 1000 : Infinity,
      });
      return { result: "OK" };
    }
    case "DEL": {
      let removed = 0;
      for (const key of args) if (state.redis.delete(key)) removed += 1;
      return { result: removed };
    }
    case "INCR": {
      const entry = redisLive(state, args[0]);
      const next = (entry ? Number(entry.value) : 0) + 1;
      state.redis.set(args[0], {
        value: String(next),
        expiresAtMs: entry?.expiresAtMs ?? Infinity,
      });
      return { result: next };
    }
    case "EXPIRE": {
      const entry = redisLive(state, args[0]);
      if (!entry) return { result: 0 };
      if (args[2] === "NX" && Number.isFinite(entry.expiresAtMs)) return { result: 0 };
      entry.expiresAtMs = Date.now() + Number(args[1]) * 1000;
      return { result: 1 };
    }
    default:
      return { error: `ERR unknown command '${op}'` };
  }
}

let ipCounter = 0;
/** A fresh client IP per test so per-IP budgets never bleed across cases. */
export function freshIp(): string {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

export function apiRequest(
  method: string,
  path: string,
  options: {
    token?: string | null;
    ip?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers({ "x-forwarded-for": options.ip ?? freshIp(), ...options.headers });
  if (options.token !== null && options.token !== undefined) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`http://edge.test/functions/v1/api${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/** Run `fn` with Date.now() shifted by `offsetMs` (the edge function, its
 * cache and its rate-limit windows all read Date.now()). */
export async function withClockOffset<T>(offsetMs: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base + offsetMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/** Freeze Date.now() for the duration of `fn` (keeps a burst inside one
 * rate-limit window). */
export function withFrozenClock<T>(fn: () => Promise<T>): Promise<T> {
  return withClockOffset(0, fn);
}

export async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { message?: string } };
  return body.error?.message ?? "";
}
