/**
 * Adversarial harness for the edge-domain-routes attack pass (#2, pass 3/3).
 *
 * Boots supabase/functions/api/index.ts IN-PROCESS: `Deno.serve` is replaced
 * to capture the request handler and `globalThis.fetch` is replaced by a
 * programmable fake for Supabase Auth, PostgREST, Apple and RevenueCat. Unlike
 * routesHarness.ts this fake is:
 *
 *   - stateful for `account_external_credentials` (PATCH/upsert writes are
 *     merged into the row the next GET returns — needed to prove the Apple
 *     checkpoint is honoured by a retry);
 *   - programmable per call (`state.rest` / `state.auth` hooks, latency,
 *     counters) so tests can inject slow reads, 0-row UPDATEs, 5xx from
 *     RevenueCat, and already-revoked Supabase sessions;
 *   - counting: `tokenCalls` (POST /auth/v1/token), `userCalls`
 *     (GET /auth/v1/user), `logoutCalls`, `restReads(table)`.
 *
 * No production code is touched; nothing here reaches the network.
 */

export const SUPABASE_URL = "http://supabase.attack.test";
export const ANON_KEY = "anon-attack-key";
export const SERVICE_ROLE_KEY = "service-role-attack-key";
export const RC_SECRET = "sk_attack_revenuecat";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  text: string;
  at: number;
}

export interface RestContext {
  call: RecordedCall;
  url: URL;
  table: string;
  method: string;
}

/** Return a Response to override the default fake behaviour, or null/undefined
 * to fall through to it. */
export type RestHook = (ctx: RestContext) => Response | Promise<Response> | null | undefined;

export interface HarnessState {
  handler: (request: Request) => Promise<Response>;
  calls: RecordedCall[];
  tables: Record<string, Record<string, unknown>[]>;
  rpcs: Record<string, unknown>;
  rest: RestHook | null;
  /** Supabase Auth: `/auth/v1/logout` status. */
  logoutStatus: number;
  /** Supabase session access tokens the fake treats as revoked (getUser → 401). */
  revokedSessions: Set<string>;
  /** provider reported by getUser for a session token (default google). */
  sessionProviders: Map<string, "google" | "apple">;
  appleRevokeStatus: number;
  appleRevokeBody: unknown;
  revenueCatDeleteStatus: number;
  adminDeleteStatus: number;
  tokenCalls: number;
  userCalls: number;
  logoutCalls: number;
  appleTokenEncryptionKey: string;
  reset(): void;
  callsTo(fragment: string): RecordedCall[];
  restReads(table: string): RecordedCall[];
  restWrites(table: string): RecordedCall[];
}

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function testApplePrivateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const encoded =
    bytesToBase64(pkcs8)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
}

function jwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.sig`;
}

/** Deterministic user ids: uid(7) → aaaaaaaa-0000-4000-8000-000000000007. */
export function uid(n: number): string {
  return `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function googleIdToken(sub: string, extra: Record<string, unknown> = {}): string {
  return jwt({
    iss: "https://accounts.google.com",
    sub,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...extra,
  });
}

export function appleIdToken(sub: string, extra: Record<string, unknown> = {}): string {
  return jwt({
    iss: "https://appleid.apple.com",
    sub,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...extra,
  });
}

/** A Supabase-issued access token (iss ends with /auth/v1) for `sub`. */
export function sessionToken(sub: string, nonce = "", extra: Record<string, unknown> = {}): string {
  return jwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub,
    aud: "authenticated",
    role: "authenticated",
    nonce,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...extra,
  });
}

export function userRequest(
  method: string,
  path: string,
  options: {
    token?: string;
    ip?: string;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  headers.set("x-forwarded-for", options.ip ?? "198.51.100.7");
  for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
  const body =
    options.rawBody !== undefined
      ? options.rawBody
      : options.body === undefined
        ? undefined
        : JSON.stringify(options.body);
  return new Request(`http://edge.test/functions/v1/api${path}`, { method, headers, body });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeUser(sub: string, provider: "google" | "apple") {
  return {
    id: sub,
    aud: "authenticated",
    role: "authenticated",
    email: `${sub.slice(-4)}@example.com`,
    app_metadata: { provider, providers: [provider] },
    user_metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function decodeSub(token: string): string | null {
  const segment = token.split(".")[1] ?? "";
  try {
    const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

/** PostgREST `column=eq.value` filters from the query string. */
function eqFilters(url: URL): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams) {
    if (value.startsWith("eq.")) out.push([key, value.slice(3)]);
  }
  return out;
}

function matchesFilters(row: Record<string, unknown>, filters: Array<[string, string]>): boolean {
  return filters.every(([column, value]) => !(column in row) || String(row[column]) === value);
}

let harness: HarnessState | null = null;

export async function loadAttackHarness(): Promise<HarnessState> {
  if (harness) {
    harness.reset();
    return harness;
  }

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.delete("SB_PUBLISHABLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "attack-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", RC_SECRET);
  const appleTokenEncryptionKey = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  Deno.env.set("APPLE_SIGN_IN_CLIENT_ID", "com.picklesensei");
  Deno.env.set("APPLE_SIGN_IN_TEAM_ID", "TEAMID1234");
  Deno.env.set("APPLE_SIGN_IN_KEY_ID", "KEYID12345");
  Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", await testApplePrivateKeyPem());
  Deno.env.set("APPLE_TOKEN_ENCRYPTION_KEY", appleTokenEncryptionKey);
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const state: HarnessState = {
    handler: () => Promise.reject(new Error("handler not captured")),
    calls: [],
    tables: {},
    rpcs: {},
    rest: null,
    logoutStatus: 204,
    revokedSessions: new Set(),
    sessionProviders: new Map(),
    appleRevokeStatus: 200,
    appleRevokeBody: null,
    revenueCatDeleteStatus: 200,
    adminDeleteStatus: 200,
    tokenCalls: 0,
    userCalls: 0,
    logoutCalls: 0,
    appleTokenEncryptionKey,
    reset() {
      state.calls = [];
      state.tables = {};
      state.rpcs = {};
      state.rest = null;
      state.logoutStatus = 204;
      state.revokedSessions = new Set();
      state.sessionProviders = new Map();
      state.appleRevokeStatus = 200;
      state.appleRevokeBody = null;
      state.revenueCatDeleteStatus = 200;
      state.adminDeleteStatus = 200;
      state.tokenCalls = 0;
      state.userCalls = 0;
      state.logoutCalls = 0;
    },
    callsTo(fragment: string) {
      return state.calls.filter((call) => call.url.includes(fragment));
    },
    restReads(table: string) {
      return state.calls.filter(
        (call) => call.method === "GET" && call.url.startsWith(`${SUPABASE_URL}/rest/v1/${table}?`),
      );
    },
    restWrites(table: string) {
      return state.calls.filter(
        (call) => call.method !== "GET" && call.url.startsWith(`${SUPABASE_URL}/rest/v1/${table}?`),
      );
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    const text = await request.text().catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const call: RecordedCall = {
      url,
      method: request.method,
      headers,
      body,
      text,
      at: performance.now(),
    };
    state.calls.push(call);

    // ── RevenueCat
    if (url.startsWith(RC_URL)) {
      if (request.method === "DELETE") {
        if (state.revenueCatDeleteStatus >= 400) {
          return jsonResponse(state.revenueCatDeleteStatus, {
            code: 7000,
            message: "internal error",
          });
        }
        return jsonResponse(state.revenueCatDeleteStatus, { deleted: true });
      }
      return jsonResponse(200, { request_date_ms: Date.now(), subscriber: {} });
    }
    // ── Apple
    if (url === APPLE_TOKEN_URL) {
      return jsonResponse(200, {
        refresh_token: "apple-refresh-token-from-grant",
        id_token: appleIdToken(uid(0)),
      });
    }
    if (url === APPLE_REVOKE_URL) {
      if (state.appleRevokeBody !== null) {
        return jsonResponse(state.appleRevokeStatus, state.appleRevokeBody);
      }
      return new Response(null, { status: state.appleRevokeStatus });
    }
    // ── Supabase Auth
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
      state.tokenCalls += 1;
      const payload =
        body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const idToken = typeof payload.id_token === "string" ? payload.id_token : "";
      const provider = payload.provider === "apple" ? "apple" : "google";
      const sub = decodeSub(idToken) ?? uid(0);
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      return jsonResponse(200, {
        access_token: `session-for-${sub}`,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: expiresAt,
        refresh_token: `refresh-for-${sub}`,
        user: fakeUser(sub, provider),
      });
    }
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      state.userCalls += 1;
      const bearer = (headers.authorization ?? "").replace(/^Bearer /, "");
      const sub = decodeSub(bearer);
      if (!sub || state.revokedSessions.has(bearer)) {
        return jsonResponse(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
      }
      return jsonResponse(200, fakeUser(sub, state.sessionProviders.get(bearer) ?? "google"));
    }
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/logout`)) {
      state.logoutCalls += 1;
      if (state.logoutStatus === 204) return new Response(null, { status: 204 });
      return jsonResponse(state.logoutStatus, {
        code: state.logoutStatus,
        error_code: state.logoutStatus === 404 ? "session_not_found" : "unexpected_failure",
        msg: `logout → ${state.logoutStatus}`,
      });
    }
    if (request.method === "DELETE" && url.startsWith(`${SUPABASE_URL}/auth/v1/admin/users/`)) {
      if (state.adminDeleteStatus >= 400) {
        return jsonResponse(state.adminDeleteStatus, {
          code: state.adminDeleteStatus,
          error_code: "unexpected_failure",
          msg: "admin delete failed",
        });
      }
      return jsonResponse(200, {});
    }
    // ── PostgREST
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      const parsed = new URL(url);
      const table = parsed.pathname.slice("/rest/v1/".length);
      if (state.rest) {
        const override = await state.rest({ call, url: parsed, table, method: request.method });
        if (override) return override;
      }
      if (table.startsWith("rpc/")) {
        const fn = table.slice("rpc/".length);
        if (!(fn in state.rpcs)) {
          return jsonResponse(404, { code: "PGRST202", message: `rpc ${fn} not stubbed` });
        }
        const value = state.rpcs[fn];
        return jsonResponse(
          200,
          typeof value === "function" ? (value as (input: unknown) => unknown)(body) : value,
        );
      }
      const rows = state.tables[table] ?? [];
      const filters = eqFilters(parsed);
      if (request.method === "GET") {
        return jsonResponse(
          200,
          rows.filter((row) => matchesFilters(row, filters)),
        );
      }
      if (request.method === "PATCH") {
        const patch =
          body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
        const matched = rows.filter((row) => matchesFilters(row, filters));
        for (const row of matched) Object.assign(row, patch);
        return jsonResponse(200, matched);
      }
      if (request.method === "POST") {
        const payload =
          body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
        const prefer = headers.prefer ?? "";
        if (prefer.includes("resolution=merge-duplicates") && typeof payload.user_id === "string") {
          const existing = rows.find((row) => row.user_id === payload.user_id);
          if (existing) Object.assign(existing, payload);
          else rows.push({ ...payload });
          state.tables[table] = rows;
        } else {
          rows.push({ ...payload });
          state.tables[table] = rows;
        }
        return prefer.includes("return=representation")
          ? jsonResponse(201, [payload])
          : new Response(null, { status: 201 });
      }
      if (request.method === "DELETE") return new Response(null, { status: 204 });
    }
    return new Response(`unexpected fetch in attack test: ${request.method} ${url}`, {
      status: 599,
    });
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

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run `fn` with Date.now() pinned to `nowMs` (the code under test reads the
 * clock through Date.now for every age/expiry decision). */
export async function withClock<T>(nowMs: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => nowMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/** Resolves to the response, or throws if the handler is still pending after
 * `ms` — the "hung promise" detector. */
export async function settleWithin(promise: Promise<Response>, ms: number): Promise<Response> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`handler did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
