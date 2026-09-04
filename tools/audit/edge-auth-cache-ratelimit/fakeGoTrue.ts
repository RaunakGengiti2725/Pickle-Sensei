// Execution harness for the edge function's authentication subsystem.
//
// Boots ../../../supabase/functions/api/index.ts IN-PROCESS with Deno.serve
// captured, pointed at a REAL local HTTP server that plays Supabase Auth
// (GoTrue) + PostgREST. Every GoTrue endpoint the function touches is
// controllable per test (status overrides, revoked tokens, call counters) so
// success / failure / outage / stale / missing states can all be driven
// through the real handler (rate limits → auth → routing).
//
// No production code is imported with modifications; nothing here talks to a
// real Supabase project.

import { captureAccessLog } from "../../../supabase/functions/api/http.ts";

export interface GoTrueState {
  /** Status override for POST /auth/v1/token?grant_type=id_token (200 = mint). */
  idTokenStatus: number;
  /** Status override for POST /auth/v1/token?grant_type=refresh_token. */
  refreshStatus: number;
  /** Status override for GET /auth/v1/user. */
  getUserStatus: number;
  /** Status override for POST /auth/v1/logout. */
  logoutStatus: number;
  /** Access tokens GoTrue treats as revoked (getUser → 401). */
  revoked: Set<string>;
  /** Refresh tokens GoTrue treats as already rotated / revoked (→ 400). */
  deadRefreshTokens: Set<string>;
  /** app_metadata.provider reported by getUser (default "google"). */
  userProvider: string;
  idTokenCalls: number;
  refreshCalls: number;
  getUserCalls: number;
  logoutCalls: number;
  lastLogoutUrl: string | null;
  lastLogoutBearer: string | null;
  lastRefreshBody: Record<string, unknown> | null;
  /** PostgREST profiles rows by id. */
  profiles: Map<string, Record<string, unknown>>;
  /** Unhandled PostgREST/GoTrue paths seen (should stay empty in a clean run). */
  unhandled: string[];
}

export function freshState(): GoTrueState {
  return {
    idTokenStatus: 200,
    refreshStatus: 200,
    getUserStatus: 200,
    logoutStatus: 204,
    revoked: new Set(),
    deadRefreshTokens: new Set(),
    userProvider: "google",
    idTokenCalls: 0,
    refreshCalls: 0,
    getUserCalls: 0,
    logoutCalls: 0,
    lastLogoutUrl: null,
    lastLogoutBearer: null,
    lastRefreshBody: null,
    profiles: new Map(),
    unhandled: [],
  };
}

export const state: GoTrueState = freshState();

export function resetState(): void {
  Object.assign(state, freshState());
  accessLog.length = 0;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const b64url = (input: string): string =>
  btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodePayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(raw + "=".repeat((4 - (raw.length % 4)) % 4)));
  } catch {
    return null;
  }
}

/** Unsigned JWT-shaped token with the given claims. */
export function jwt(claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(claims))}.sig`;
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1_000);

export function googleIdToken(sub: string, expInSeconds = 3_600): string {
  return jwt({
    iss: "https://accounts.google.com",
    sub,
    exp: nowSeconds() + expInSeconds,
  });
}

export function appleIdToken(sub: string, expInSeconds = 3_600): string {
  return jwt({
    iss: "https://appleid.apple.com",
    sub,
    exp: nowSeconds() + expInSeconds,
  });
}

let fakeUrl = "";

/** A Supabase-issued access token (iss ends with /auth/v1) for `sub`. */
export function sessionToken(
  sub: string,
  expInSeconds = 3_600,
  nonce = crypto.randomUUID(),
): string {
  return jwt({
    iss: `${fakeUrl}/auth/v1`,
    sub,
    aud: "authenticated",
    role: "authenticated",
    exp: nowSeconds() + expInSeconds,
    session_id: nonce,
  });
}

function userJson(sub: string): Record<string, unknown> {
  return {
    id: sub,
    aud: "authenticated",
    role: "authenticated",
    email: `${sub.slice(0, 8)}@example.com`,
    app_metadata: {
      provider: state.userProvider,
      providers: [state.userProvider],
    },
    user_metadata: {},
    created_at: new Date().toISOString(),
  };
}

function mintSession(sub: string): Record<string, unknown> {
  const expiresAt = nowSeconds() + 3_600;
  return {
    access_token: sessionToken(sub, 3_600),
    token_type: "bearer",
    expires_in: 3_600,
    expires_at: expiresAt,
    refresh_token: `rt-${crypto.randomUUID()}`,
    user: userJson(sub),
  };
}

const gotrueError = (status: number, msg: string): Response =>
  jsonResponse(status, { code: status, error_code: "probe", msg });

async function fakeSupabase(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "POST" && path === "/auth/v1/token") {
    const grant = url.searchParams.get("grant_type");
    if (grant === "id_token") {
      state.idTokenCalls += 1;
      if (state.idTokenStatus !== 200) {
        return gotrueError(state.idTokenStatus, "upstream down");
      }
      const body = (await request.json()) as { id_token?: string };
      const sub = String(decodePayload(body.id_token ?? "")?.sub ?? "");
      if (!sub) return gotrueError(400, "invalid id token");
      return jsonResponse(200, mintSession(sub));
    }
    if (grant === "refresh_token") {
      state.refreshCalls += 1;
      const body = (await request.json()) as Record<string, unknown>;
      state.lastRefreshBody = body;
      if (state.refreshStatus !== 200) {
        return gotrueError(state.refreshStatus, "upstream down");
      }
      const rt = String(body.refresh_token ?? "");
      if (!rt || state.deadRefreshTokens.has(rt)) {
        return gotrueError(400, "Invalid Refresh Token: Already Used");
      }
      return jsonResponse(
        200,
        mintSession(
          rt.startsWith("rt-for-") ? rt.slice(7) : crypto.randomUUID(),
        ),
      );
    }
    state.unhandled.push(`POST /auth/v1/token?grant_type=${grant}`);
    return gotrueError(400, "unsupported grant");
  }

  if (request.method === "GET" && path === "/auth/v1/user") {
    state.getUserCalls += 1;
    if (state.getUserStatus !== 200) {
      return gotrueError(state.getUserStatus, "upstream down");
    }
    const bearer = (request.headers.get("authorization") ?? "").replace(
      /^Bearer /,
      "",
    );
    if (state.revoked.has(bearer)) {
      return gotrueError(401, "invalid JWT: session not found");
    }
    const sub = String(decodePayload(bearer)?.sub ?? "");
    if (!sub) return gotrueError(401, "invalid JWT");
    return jsonResponse(200, userJson(sub));
  }

  if (request.method === "POST" && path === "/auth/v1/logout") {
    state.logoutCalls += 1;
    state.lastLogoutUrl = request.url;
    state.lastLogoutBearer = (request.headers.get("authorization") ?? "")
      .replace(/^Bearer /, "");
    if (state.logoutStatus >= 400) {
      return gotrueError(state.logoutStatus, "logout failed");
    }
    return new Response(null, { status: state.logoutStatus });
  }

  if (path === "/rest/v1/profiles" && request.method === "GET") {
    const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
    const row = state.profiles.get(id);
    const single = (request.headers.get("accept") ?? "").includes(
      "vnd.pgrst.object",
    );
    if (single) {
      if (!row) {
        return jsonResponse(406, {
          code: "PGRST116",
          message: "0 rows",
          details: null,
          hint: null,
        });
      }
      return jsonResponse(200, row);
    }
    return jsonResponse(200, row ? [row] : []);
  }
  if (path === "/rest/v1/profiles" && request.method === "PATCH") {
    return new Response(null, { status: 204 });
  }
  if (path === "/rest/v1/rpc/access_state" && request.method === "POST") {
    return jsonResponse(200, [{
      premium: false,
      scored_count: 0,
      reserved_count: 0,
    }]);
  }

  state.unhandled.push(`${request.method} ${path}`);
  return jsonResponse(404, {
    message: `fake supabase: unhandled ${request.method} ${path}`,
  });
}

export function profileRow(
  id: string,
  provider = "google",
): Record<string, unknown> {
  return {
    id,
    email: `${id.slice(0, 8)}@example.com`,
    onboarding_state: "complete",
    provider,
    skill_level: null,
    handedness: null,
    primary_goal: null,
    biggest_problem: null,
    focus_checkpoint: null,
    first_name: null,
    gender: null,
  };
}

export type Handler = (request: Request) => Promise<Response> | Response;

export interface Booted {
  handler: Handler;
  fakeUrl: string;
  shutdown(): Promise<void>;
}

let booted: Booted | null = null;

/** Start the fake Supabase, point the edge function at it and capture its
 * Deno.serve handler. Idempotent within a test process. */
export async function boot(): Promise<Booted> {
  if (booted) return booted;
  const fake = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    onListen: () => undefined,
  }, fakeSupabase);
  fake.unref();
  fakeUrl = `http://127.0.0.1:${fake.addr.port}`;

  Deno.env.set("SUPABASE_URL", fakeUrl);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_revenuecat");
  if (!Deno.env.get("PROBE_KEEP_UPSTASH_ENV")) {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  let handler: Handler | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    handler = (typeof args[0] === "function" ? args[0] : args[1]) as Handler;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  try {
    await import("../../../supabase/functions/api/index.ts");
  } finally {
    (Deno as unknown as { serve: unknown }).serve = realServe;
  }
  if (!handler) {
    throw new Error("index.ts did not register a Deno.serve handler");
  }
  const captured: Handler = handler;
  booted = {
    handler: captured,
    fakeUrl,
    shutdown: () => fake.shutdown(),
  };
  return booted;
}

let ipCounter = 0;
/** A never-before-used client IP so per-IP budgets start from zero. */
export function freshIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${
    ipCounter & 255
  }`;
}

/** Categorical access-log lines emitted by the handler during `call()`. */
export const accessLog: string[] = [];

export interface CallOptions {
  token?: string | null;
  ip?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

export async function call(
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  const { handler } = await boot();
  const headers = new Headers(options.headers ?? {});
  if (options.token !== null && options.token !== undefined) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }
  headers.set("x-forwarded-for", options.ip ?? freshIp());
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers.set("Content-Type", "application/json");
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set("Content-Type", "application/json");
  }
  const restore = captureAccessLog((line) => accessLog.push(line));
  try {
    return await handler(
      new Request(`http://edge.local/functions/v1/api${path}`, {
        method,
        headers,
        body,
      }),
    );
  } finally {
    restore();
  }
}

export async function errorBody(
  res: Response,
): Promise<{ code?: string; message?: string }> {
  const parsed = (await res.json()) as {
    error?: { code?: string; message?: string };
  };
  return parsed.error ?? {};
}
