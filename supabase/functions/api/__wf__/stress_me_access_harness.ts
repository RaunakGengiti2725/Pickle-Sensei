// stress — GET /v1/me/access fuzz/boundary harness (shared by
// stress_route_me_access_fuzz.test.ts and stress_route_me_access_pg.test.ts).
//
// Runs the REAL handler (../index.ts, Deno.serve captured — no port) over a
// fetch-layer stub that models exactly the upstreams this route can reach:
// GoTrue (id_token exchange, GET /user) and PostgREST rpc/access_state. Every
// other upstream call is recorded as UNEXPECTED, and every non-GET PostgREST
// call / non-access_state RPC / auth admin / RevenueCat call is recorded as a
// WRITE, so "no write on rejection" is checked per request rather than
// assumed. The rpc/access_state answer can be replaced by a fault (status,
// malformed body, network failure) or delegated to a real Postgres
// (stress_route_me_access_pg.test.ts).
//
// Request generation is SEEDED: iteration i of a campaign with base seed S
// uses Prng(iterSeed(S, i)); STRESS_REPLAY=<iterSeed>[,<iterSeed>] replays
// exactly those requests. Every iteration is written to the JSON table under
// STRESS_OUT_DIR with seed, wire shape, upstream calls, status and verdict.

import { captureAccessLog } from "../http.ts";
import { b64url, envInt, jwtPayload, Prng } from "./xc_concurrency_harness.ts";

export const SUPABASE_URL = "http://supabase.stress.test";
const ANON_KEY = "stress-anon-key";
const SERVICE_ROLE_KEY = "stress-service-role-key";
export const EDGE_ORIGIN = "http://edge.stress.test";
export const CANONICAL_PATH = "/functions/v1/api/v1/me/access";

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
export const STRESS_ITER = envInt("STRESS_ITER", 300);
export const STRESS_PG_ITER = envInt("STRESS_PG_ITER", 24);

export const ALLOWED_REJECTIONS = new Set([
  400,
  401,
  403,
  404,
  405,
  413,
  415,
  429,
]);
export const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Iteration seed: replayable on its own, independent of position. */
export function iterSeed(base: number, i: number): number {
  return fnv1a(`${base}:${i}`) >>> 0;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// ── Stubbed upstreams ────────────────────────────────────────────────────────

export interface StubUser {
  userId: string;
  provider: "google" | "apple";
  sub: string;
  premium: boolean;
  scored: number;
  reserved: number;
}

export type UpstreamFault =
  | {
    kind: "status";
    status: number;
    body: string;
    contentType?: string;
    retryAfter?: string;
  }
  | { kind: "json"; value: unknown }
  | { kind: "text"; text: string; contentType: string }
  | { kind: "throw" };

export interface UpstreamCall {
  method: string;
  url: string;
  kind:
    | "auth.token"
    | "auth.user"
    | "rpc.access_state"
    | "write"
    | "unexpected";
  status: number | "threw";
}

export class FakeUpstream {
  users = new Map<string, StubUser>();
  private bySubject = new Map<string, string>();
  /** access token → userId (tokens minted by the id_token exchange or mintSession) */
  sessions = new Map<string, string>();
  calls: UpstreamCall[] = [];
  /** Consumed by the next rpc/access_state call. */
  rpcFault: UpstreamFault | null = null;
  /** Consumed by the next GET /auth/v1/user call. */
  authUserFault: UpstreamFault | null = null;
  /** Consumed by the next id_token exchange. */
  tokenFault: UpstreamFault | null = null;
  /** When set, answers rpc/access_state instead of the in-memory model. */
  accessStateProvider: ((userId: string) => Promise<unknown>) | null = null;
  /** A string that must never appear in any response body. */
  leakMarker = "LEAK-MARKER-" + crypto.randomUUID();
  private mint = 0;

  private consume(
    slot: "rpcFault" | "authUserFault" | "tokenFault",
  ): UpstreamFault | null {
    const fault = this[slot];
    this[slot] = null;
    return fault;
  }

  /** True when an injected fault was never reached (e.g. the auth cache
   * answered before GoTrue); the caller then judges the request as unfaulted. */
  pendingFault(): boolean {
    return this.rpcFault !== null || this.authUserFault !== null ||
      this.tokenFault !== null;
  }

  reset(): void {
    this.calls = [];
    this.rpcFault = null;
    this.authUserFault = null;
    this.tokenFault = null;
  }

  userIdFor(provider: "google" | "apple", sub: string): string {
    const key = `${provider}:${sub}`;
    const known = this.bySubject.get(key);
    if (known) return known;
    const p = new Prng(fnv1a(key));
    const userId = p.uuid();
    this.bySubject.set(key, userId);
    if (!this.users.has(userId)) {
      this.users.set(userId, {
        userId,
        provider,
        sub,
        premium: false,
        scored: 0,
        reserved: 0,
      });
    }
    return userId;
  }

  /** Register a user with a known state (also what the model answers for it). */
  setUser(user: StubUser): void {
    this.users.set(user.userId, user);
    this.bySubject.set(`${user.provider}:${user.sub}`, user.userId);
  }

  /** A Supabase-issued access token for userId, registered as a live session. */
  mintSession(
    userId: string,
    opts: { expSeconds?: number; sessionId?: string; jti?: string } = {},
  ): string {
    this.mint += 1;
    const exp = opts.expSeconds ?? Math.floor(Date.now() / 1000) + 3600;
    const token = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${
      b64url(
        JSON.stringify({
          iss: `${SUPABASE_URL}/auth/v1`,
          sub: userId,
          aud: "authenticated",
          role: "authenticated",
          session_id: opts.sessionId ??
            `sess-${this.mint}-${crypto.randomUUID()}`,
          exp,
          jti: opts.jti ?? `${this.mint}-${crypto.randomUUID()}`,
        }),
      )
    }.sig`;
    this.sessions.set(token, userId);
    return token;
  }

  private userJson(user: StubUser) {
    return {
      id: user.userId,
      aud: "authenticated",
      role: "authenticated",
      email: `${user.userId.slice(0, 8)}@example.com`,
      app_metadata: { provider: user.provider, providers: [user.provider] },
      user_metadata: {},
      created_at: new Date(0).toISOString(),
    };
  }

  private faultResponse(fault: UpstreamFault): Response {
    switch (fault.kind) {
      case "status": {
        const headers: Record<string, string> = {
          "Content-Type": fault.contentType ?? "application/json",
        };
        if (fault.retryAfter !== undefined) {
          headers["Retry-After"] = fault.retryAfter;
        }
        return new Response(fault.body, { status: fault.status, headers });
      }
      case "json":
        return new Response(JSON.stringify(fault.value), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      case "text":
        return new Response(fault.text, {
          status: 200,
          headers: { "Content-Type": fault.contentType },
        });
      case "throw":
        throw new TypeError(
          `stress: simulated network failure ${this.leakMarker}`,
        );
    }
  }

  async handle(request: Request, rawBody: string): Promise<Response> {
    const url = new URL(request.url);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const record = (
      kind: UpstreamCall["kind"],
      response: Response | "threw",
    ): Response => {
      this.calls.push({
        method: request.method,
        url: request.url,
        kind,
        status: response === "threw" ? "threw" : response.status,
      });
      if (response === "threw") {
        throw new TypeError(
          `stress: simulated network failure ${this.leakMarker}`,
        );
      }
      return response;
    };
    const withFault = (
      kind: UpstreamCall["kind"],
      fault: UpstreamFault | null,
      fallback: () => Response,
    ) => {
      if (!fault) return record(kind, fallback());
      if (fault.kind === "throw") return record(kind, "threw");
      return record(kind, this.faultResponse(fault));
    };

    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/")) {
      const path = url.pathname.slice("/auth/v1/".length);
      if (path === "token" && request.method === "POST") {
        const fault = this.consume("tokenFault");
        return withFault("auth.token", fault, () => {
          if (url.searchParams.get("grant_type") !== "id_token") {
            return json(400, { error: "unsupported_grant_type" });
          }
          let body: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(rawBody);
            body = isRecord(parsed) ? parsed : {};
          } catch {
            body = {};
          }
          const idToken = typeof body.id_token === "string"
            ? body.id_token
            : "";
          // GoTrue parses the compact serialization strictly: exactly three
          // base64url segments (no spaces, no scheme prefix) and a JSON header.
          const segments = idToken.split(".");
          const compactOk = segments.length === 3 &&
            segments.every((s) => /^[A-Za-z0-9_-]+$/.test(s));
          const header = compactOk ? jwtPayload(`x.${segments[0]}.x`) : null;
          const payload = compactOk && header ? jwtPayload(idToken) : null;
          const sub = typeof payload?.sub === "string" ? payload.sub : "";
          const provider = body.provider === "apple" ? "apple" : "google";
          // GoTrue verifies signature (unmodellable here), issuer, expiry and
          // subject; model the three it can decide from the payload alone.
          const iss = typeof payload?.iss === "string"
            ? payload.iss.replace(/^https:\/\//, "")
            : "";
          const issOk = provider === "google"
            ? iss === "accounts.google.com"
            : iss === "appleid.apple.com";
          const exp = payload?.exp;
          const expOk = typeof exp === "number" && Number.isFinite(exp) &&
            exp > Date.now() / 1000;
          if (!sub || !issOk || !expOk) {
            return json(400, {
              error: "invalid_grant",
              error_description: "bad id token",
            });
          }
          const userId = this.userIdFor(provider, sub);
          const user = this.users.get(userId)!;
          const token = this.mintSession(userId);
          return json(200, {
            access_token: token,
            token_type: "bearer",
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            refresh_token: `rt-${this.mint}`,
            user: this.userJson(user),
          });
        });
      }
      if (path === "user" && request.method === "GET") {
        const fault = this.consume("authUserFault");
        return withFault("auth.user", fault, () => {
          const auth = request.headers.get("authorization") ?? "";
          const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
          const userId = this.sessions.get(bearer);
          const user = userId ? this.users.get(userId) : undefined;
          if (!user) {
            return json(403, {
              code: 403,
              error_code: "session_not_found",
              msg: "Session from session_id claim in JWT does not exist",
            });
          }
          return json(200, this.userJson(user));
        });
      }
      return record(
        request.method === "GET" ? "unexpected" : "write",
        json(599, { stress: "unmodelled auth path" }),
      );
    }

    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
      const target = url.pathname.slice("/rest/v1/".length);
      if (target === "rpc/access_state") {
        const fault = this.consume("rpcFault");
        if (fault) {
          if (fault.kind === "throw") {
            return record("rpc.access_state", "threw");
          }
          return record("rpc.access_state", this.faultResponse(fault));
        }
        const auth = request.headers.get("authorization") ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const userId = this.sessions.get(bearer);
        if (!userId) {
          return record(
            "rpc.access_state",
            json(401, { message: "JWT expired or invalid" }),
          );
        }
        if (this.accessStateProvider) {
          const rows = await this.accessStateProvider(userId);
          return record("rpc.access_state", json(200, rows));
        }
        const user = this.users.get(userId)!;
        return record(
          "rpc.access_state",
          json(200, [
            {
              premium: user.premium,
              scored_count: user.scored,
              reserved_count: user.reserved,
            },
          ]),
        );
      }
      return record(
        request.method === "GET" && !target.startsWith("rpc/")
          ? "unexpected"
          : "write",
        json(599, { stress: "unmodelled rest path" }),
      );
    }

    // RevenueCat, Apple, anything else: none of it belongs to this route.
    return record(
      request.method === "GET" ? "unexpected" : "write",
      new Response(
        `stress: unexpected fetch ${request.method} ${request.url}`,
        { status: 599 },
      ),
    );
  }
}

// ── Loading the real handler ─────────────────────────────────────────────────

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  upstream: FakeUpstream;
  /** Access-log lines captured while a request is in flight. */
  accessLog: string[];
}

let loaded: StressHarness | null = null;

export async function loadStressHarness(): Promise<StressHarness> {
  if (loaded) {
    loaded.upstream.reset();
    loaded.accessLog.length = 0;
    return loaded;
  }
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const upstream = new FakeUpstream();
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = await request.text().catch(() => "");
    return upstream.handle(request, rawBody);
  }) as typeof fetch;

  const accessLog: string[] = [];
  captureAccessLog((line) => accessLog.push(line));

  let handler: StressHarness["handler"] | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      | StressHarness["handler"]
      | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) {
    throw new Error("index.ts did not register a Deno.serve handler");
  }
  loaded = { handler, upstream, accessLog };
  return loaded;
}

// ── Tokens ───────────────────────────────────────────────────────────────────

export function providerIdToken(
  provider: "google" | "apple",
  sub: string,
  overrides: Record<string, unknown> = {},
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: provider === "google"
        ? "https://accounts.google.com"
        : "https://appleid.apple.com",
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    }),
  );
  return `${header}.${payload}.sig`;
}

export function jwtFromPayload(payload: unknown): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.sig`;
}

// ── Request specs ────────────────────────────────────────────────────────────

/** provider-lenient: a provider-shaped token the edge legitimately forwards
 * to GoTrue for verification (the stub accepts it) — 200 and 401 both hold. */
export type TokenKind =
  | "session-valid"
  | "provider-valid"
  | "provider-lenient"
  | "invalid"
  | "none";

export interface RequestSpec {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body?: BodyInit | null;
  bodyKind: string;
  bodyBytes: number;
}

export interface Generated {
  category: string;
  spec: RequestSpec;
  tokenKind: TokenKind;
  /** userId the token resolves to (valid kinds only). */
  userId: string | null;
  clientRequestId: string | null;
  fault:
    | { target: "rpc" | "auth.user" | "auth.token"; fault: UpstreamFault }
    | null;
  /** True when the request is well-formed for GET /v1/me/access AND the IP is
   * private to this iteration — the one case the oracle demands a 200. */
  expectOk: boolean;
  notes: string[];
}

export function tokenIsValid(kind: TokenKind): boolean {
  return kind === "session-valid" || kind === "provider-valid";
}

/** The Request constructor upper-cases the standard methods (Fetch spec);
 * anything else is sent verbatim. */
export function wireMethod(method: string): string {
  const upper = method.toUpperCase();
  return ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"].includes(upper)
    ? upper
    : method;
}

/** Mirror of handleRequest's routing contract (last "/v1/" segment). */
export function routesToAccess(method: string, url: string): boolean {
  const pathname = new URL(url).pathname;
  const v1 = pathname.lastIndexOf("/v1/");
  const path = v1 >= 0 ? pathname.slice(v1) : pathname;
  return wireMethod(method) === "GET" && path === "/v1/me/access";
}

export function isPublicRoute(rawMethod: string, url: string): boolean {
  const method = wireMethod(rawMethod);
  const pathname = new URL(url).pathname;
  if (method === "GET" || method === "HEAD") {
    return ["/healthz", "/support", "/privacy", "/terms"].some((s) =>
      pathname.endsWith(s)
    );
  }
  return method === "POST" && pathname.endsWith("/webhooks/revenuecat");
}

const SAFE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PRINTABLE = SAFE + "-._~:/?#[]@!$&'()*+,;=%<>\"{}|\\^` ";
const LATIN1 = "\u00a0\u00e9\u00ff\u00c4\u00f1\u00a9\u00ae\u00b5";
const WIDE = "\u0100\u4e2d\u6587\ud83c\udfd3\u200b\ufeff\u202e";
const CONTROL = "\r\n\t\0\x7f\x1b";

export function randomString(p: Prng, alphabet: string, len: number): string {
  const glyphs = Array.from(alphabet);
  let out = "";
  for (let i = 0; i < len; i++) out += glyphs[p.int(0, glyphs.length - 1)];
  return out;
}

function pick<T>(p: Prng, items: T[]): T {
  return items[p.int(0, items.length - 1)];
}

function privateIp(p: Prng): string {
  return `10.${p.int(0, 255)}.${p.int(0, 255)}.${p.int(1, 254)}`;
}

/** A pool of users whose states cover every branch of accessPayload. */
export function poolUsers(upstream: FakeUpstream, count: number): StubUser[] {
  const users: StubUser[] = [];
  for (let i = 0; i < count; i++) {
    const p = new Prng(fnv1a(`pool:${i}`));
    const provider = p.next() < 0.7 ? "google" : "apple";
    const sub = `${provider}-sub-${i}-${randomString(p, SAFE, 12)}`;
    const userId = upstream.userIdFor(provider, sub);
    const user: StubUser = {
      userId,
      provider,
      sub,
      premium: p.next() < 0.3,
      scored: pick(p, [0, 0, 1, 2, 2, 3, 7, 40]),
      reserved: pick(p, [0, 0, 0, 1, 1, 2, 3]),
    };
    upstream.setUser(user);
    users.push(user);
  }
  return users;
}

const METHODS_OTHER = [
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
  "PROPFIND",
  "PURGE",
  "get",
  "Get",
  "GETT",
  "G-ET",
];

export interface GeneratorContext {
  upstream: FakeUpstream;
  pool: StubUser[];
  /** Pre-minted session tokens per pool user (exercise the warm auth cache). */
  sessionTokens: Map<string, string>;
}

function validToken(
  p: Prng,
  ctx: GeneratorContext,
): { token: string; kind: TokenKind; userId: string; notes: string[] } {
  const user = pick(p, ctx.pool);
  const roll = p.next();
  if (roll < 0.45) {
    return {
      token: ctx.sessionTokens.get(user.userId)!,
      kind: "session-valid",
      userId: user.userId,
      notes: ["session:warm"],
    };
  }
  if (roll < 0.7) {
    const token = ctx.upstream.mintSession(user.userId, {
      sessionId: p.uuid(),
      jti: p.uuid(),
    });
    return {
      token,
      kind: "session-valid",
      userId: user.userId,
      notes: ["session:fresh"],
    };
  }
  return {
    token: providerIdToken(user.provider, user.sub),
    kind: "provider-valid",
    userId: user.userId,
    notes: [`provider:${user.provider}`],
  };
}

type AuthVariant = { value: string | null; note: string; lenient?: boolean };

function malformedAuthorization(p: Prng, ctx: GeneratorContext): AuthVariant {
  const user = pick(p, ctx.pool);
  const good = providerIdToken(user.provider, user.sub);
  const [h, body] = good.split(".");
  const now = Math.floor(Date.now() / 1000);
  const variants: Array<() => AuthVariant> = [
    () => ({ value: null, note: "auth:missing" }),
    () => ({ value: "", note: "auth:empty" }),
    () => ({ value: "Bearer", note: "auth:bare-Bearer" }),
    () => ({ value: "Bearer ", note: "auth:Bearer-space" }),
    () => ({ value: `bearer ${good}`, note: "auth:lowercase-scheme" }),
    () => ({ value: `Basic ${btoa("user:pass")}`, note: "auth:basic" }),
    () => ({ value: `Bearer ${h}.${body}`, note: "auth:2-segments" }),
    () => ({ value: `Bearer ${good}.extra`, note: "auth:4-segments" }),
    () => ({
      value: `Bearer ${h}.!!!not-base64!!!.sig`,
      note: "auth:payload-not-b64",
    }),
    () => ({
      value: `Bearer ${h}.${b64url("not json at all")}.sig`,
      note: "auth:payload-not-json",
    }),
    () => ({
      value: `Bearer ${h}.${b64url("[1,2,3]")}.sig`,
      note: "auth:payload-array",
    }),
    () => ({
      value: `Bearer ${h}.${b64url("null")}.sig`,
      note: "auth:payload-null",
    }),
    () => ({
      value: `Bearer ${h}.${b64url('"str"')}.sig`,
      note: "auth:payload-string",
    }),
    () => ({
      value: `Bearer ${
        jwtFromPayload({ iss: 42, sub: user.sub, exp: now + 60 })
      }`,
      note: "auth:iss-number",
    }),
    () => ({
      value: `Bearer ${jwtFromPayload({ sub: user.sub, exp: now + 60 })}`,
      note: "auth:iss-missing",
    }),
    () => ({
      value: `Bearer ${
        jwtFromPayload({
          iss: "https://accounts.google.com/",
          sub: user.sub,
          exp: now + 60,
        })
      }`,
      note: "auth:iss-trailing-slash",
    }),
    () => ({
      value: `Bearer ${
        jwtFromPayload({
          iss: "accounts.google.com",
          sub: user.sub,
          exp: now + 60,
        })
      }`,
      note: "auth:iss-no-scheme",
      lenient: true,
    }),
    () => ({
      value: `Bearer ${
        jwtFromPayload({
          iss: "https://evil.example/auth/v1",
          sub: user.userId,
          exp: now + 60,
          session_id: "x",
        })
      }`,
      note: "auth:foreign-supabase-issuer",
    }),
    () => ({
      value: `Bearer ${
        jwtFromPayload({
          iss: `${SUPABASE_URL}/auth/v1`,
          sub: user.userId,
          exp: now + 60,
          session_id: p.uuid(),
        })
      }`,
      note: "auth:forged-session",
    }),
    () => ({
      value: `Bearer ${
        jwtFromPayload({
          iss: `${SUPABASE_URL}/auth/v1`,
          sub: user.userId,
          exp: now + 60,
          session_id: 12345,
        })
      }`,
      note: "auth:session-id-number",
    }),
    () => ({
      value: `Bearer ${
        jwtFromPayload({
          iss: `${SUPABASE_URL}/auth/v1`,
          sub: user.userId,
          exp: now - 1,
        })
      }`,
      note: "auth:session-expired",
    }),
    () => ({
      value: `Bearer ${
        providerIdToken(user.provider, user.sub, { exp: now - 1 })
      }`,
      note: "auth:exp-past",
    }),
    () => ({
      value: `Bearer ${providerIdToken(user.provider, user.sub, { exp: 0 })}`,
      note: "auth:exp-zero",
    }),
    () => ({
      value: `Bearer ${
        providerIdToken(user.provider, user.sub, { exp: -1e12 })
      }`,
      note: "auth:exp-negative",
    }),
    () => ({
      value: `Bearer ${
        providerIdToken(user.provider, user.sub, { exp: "tomorrow" })
      }`,
      note: "auth:exp-string",
    }),
    () => ({
      value: `Bearer ${
        providerIdToken(user.provider, user.sub, { exp: 1e300 })
      }`,
      note: "auth:exp-huge",
      lenient: true,
    }),
    () => ({
      value: `Bearer ${
        providerIdToken(user.provider, user.sub, { exp: now + 0.5 })
      }`,
      note: "auth:exp-float",
      lenient: true,
    }),
    () => ({
      value: `Bearer ${providerIdToken(user.provider, "", {})}`,
      note: "auth:sub-empty",
    }),
    () => ({
      value: `Bearer ${
        jwtFromPayload({ iss: "https://accounts.google.com", exp: now + 60 })
      }`,
      note: "auth:sub-missing",
    }),
    () => ({
      value: `Bearer ${
        jwtFromPayload({
          iss: "https://accounts.google.com",
          sub: 123456,
          exp: now + 60,
        })
      }`,
      note: "auth:sub-number",
    }),
    () => ({
      value: `Bearer ${
        providerIdToken(user.provider, randomString(p, SAFE, 10_000))
      }`,
      note: "auth:sub-10k",
      lenient: true,
    }),
    () => ({
      value: `Bearer ${providerIdToken(user.provider, `${user.sub}\u0000`)}`,
      note: "auth:sub-nul",
      lenient: true,
    }),
    () => ({
      value: `Bearer  ${good}`,
      note: "auth:double-space",
      lenient: true,
    }),
    () => ({
      value: `Bearer\t${good}`,
      note: "auth:tab-separator",
      lenient: true,
    }),
    () => ({
      value: `Bearer ${good} `,
      note: "auth:trailing-space",
      lenient: true,
    }),
    () => ({ value: `Bearer Bearer ${good}`, note: "auth:double-scheme" }),
    () => ({
      value: `Bearer ${randomString(p, SAFE, 100_000)}`,
      note: "auth:100k-opaque",
    }),
    () => ({
      value: `Bearer ${randomString(p, PRINTABLE, p.int(1, 300))}`,
      note: "auth:random-printable",
    }),
    () => ({
      value: `Bearer ${randomString(p, LATIN1, p.int(1, 40))}`,
      note: "auth:latin1",
    }),
    () => ({
      value: `Bearer ${h}.${
        b64url(randomString(p, PRINTABLE, p.int(1, 2000)))
      }.sig`,
      note: "auth:b64-random-payload",
    }),
    () => ({
      value: `Bearer ${h}.${
        b64url(
          JSON.stringify({
            iss: "https://accounts.google.com",
            sub: user.sub,
            exp: now + 60,
            [randomString(p, SAFE, 5)]: randomString(p, PRINTABLE, 5000),
          }),
        )
      }.sig`,
      note: "auth:payload-5k-extra-claim",
      lenient: true,
    }),
    () => ({
      value: `Bearer ${h}.${b64url("{".repeat(5000))}.sig`,
      note: "auth:payload-unbalanced-json",
    }),
    () => ({ value: `Bearer ..`, note: "auth:empty-segments" }),
    () => ({ value: `Bearer ${h}..sig`, note: "auth:empty-payload" }),
  ];
  return pick(p, variants)();
}

function requestIdVariant(
  p: Prng,
): { value: string | null; wellFormed: string | null; note: string } {
  const good = randomString(p, SAFE + "._-", p.int(8, 64));
  const variants: Array<
    () => { value: string | null; wellFormed: string | null; note: string }
  > = [
    () => ({ value: null, wellFormed: null, note: "rid:none" }),
    () => ({ value: good, wellFormed: good, note: "rid:good" }),
    () => ({ value: `  ${good}  `, wellFormed: good, note: "rid:good-padded" }),
    () => ({
      value: randomString(p, SAFE, 7),
      wellFormed: null,
      note: "rid:7-chars",
    }),
    () => ({
      value: randomString(p, SAFE, 65),
      wellFormed: null,
      note: "rid:65-chars",
    }),
    () => ({
      value: randomString(p, SAFE, 4096),
      wellFormed: null,
      note: "rid:4k",
    }),
    () => ({ value: "", wellFormed: null, note: "rid:empty" }),
    () => ({
      value: `${good} ${good}`,
      wellFormed: null,
      note: "rid:inner-space",
    }),
    () => ({ value: `${good}:${good}`, wellFormed: null, note: "rid:colon" }),
    () => ({ value: `${good}<script>`, wellFormed: null, note: "rid:html" }),
    () => ({
      value: randomString(p, LATIN1, 12),
      wellFormed: null,
      note: "rid:latin1",
    }),
    () => ({
      value: `${good}%0d%0a`,
      wellFormed: null,
      note: "rid:crlf-encoded",
    }),
    () => ({ value: p.uuid(), wellFormed: null, note: "rid:uuid" }),
  ];
  const v = pick(p, variants)();
  if (v.note === "rid:uuid") v.wellFormed = v.value;
  return v;
}

function pathVariant(p: Prng): { url: string; note: string } {
  const prefixes = [
    "/functions/v1/api",
    "/api",
    "",
    "/x/y/z",
    "/functions/v1/api/",
    "/functions/v1//api",
  ];
  const base = pick(p, prefixes);
  const variants: Array<() => { url: string; note: string }> = [
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access`,
      note: `path:prefix(${base || "none"})`,
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access/`,
      note: "path:trailing-slash",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me//access`,
      note: "path:double-slash",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/V1/ME/ACCESS`,
      note: "path:uppercase",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/Access`,
      note: "path:mixed-case",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/%61ccess`,
      note: "path:pct-encoded-letter",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access%00`,
      note: "path:pct-nul",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access%zz`,
      note: "path:pct-malformed",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access%`,
      note: "path:pct-dangling",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access/${
        randomString(p, SAFE, p.int(1, 40))
      }`,
      note: "path:extra-segment",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access/../access`,
      note: "path:dot-dot-same",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/x/../access`,
      note: "path:dot-dot-through",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/./access`,
      note: "path:dot-segment",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access;x=1`,
      note: "path:param",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access#frag`,
      note: "path:fragment",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/${randomString(p, SAFE, 6)}/v1/me/access`,
      note: "path:inner-v1",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access/v1/me/access`,
      note: "path:doubled-route",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access/v1/`,
      note: "path:trailing-v1",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access/healthz`,
      note: "path:public-suffix-healthz",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access/../../privacy`,
      note: "path:public-via-dotdot",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access/webhooks/revenuecat`,
      note: "path:webhook-suffix",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/${
        randomString(p, PRINTABLE.replace(/[#?/\\]/g, ""), p.int(1, 60))
      }`,
      note: "path:random-sibling",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/${randomString(p, SAFE, p.int(1, 20))}/${
        randomString(p, SAFE, p.int(1, 20))
      }`,
      note: "path:random-route",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access${"/".repeat(p.int(1, 50))}`,
      note: "path:many-slashes",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access/${randomString(p, SAFE, 8_192)}`,
      note: "path:8k",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/${"a/".repeat(2_000)}v1/me/access`,
      note: "path:2000-segments",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access${
        encodeURIComponent(randomString(p, WIDE, p.int(1, 10)))
      }`,
      note: "path:unicode-suffix",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/${encodeURIComponent("ａｃｃｅｓｓ")}`,
      note: "path:fullwidth",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access\\..\\admin`,
      note: "path:backslash",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access?`,
      note: "path:empty-query",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access?${randomString(p, SAFE, 5)}=${
        randomString(p, SAFE, 5)
      }`,
      note: "path:query",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/analysis-permits/%zz/finalize`,
      note: "path:other-route-malformed-pct",
    }),
    () => ({
      url: `${EDGE_ORIGIN}${base}/v1/me/access/v1/analysis-permits/x/finalize`,
      note: "path:route-after-access",
    }),
    () => ({ url: `${EDGE_ORIGIN}/v1/me/access`, note: "path:no-prefix" }),
    () => ({
      url: `${EDGE_ORIGIN}/v1/me/access/`,
      note: "path:no-prefix-trailing",
    }),
    () => ({
      url: `${EDGE_ORIGIN}//v1/me/access`,
      note: "path:leading-double-slash",
    }),
    () => ({
      url: `${EDGE_ORIGIN}/v1/me/access/./`,
      note: "path:dot-trailing",
    }),
  ];
  return pick(p, variants)();
}

function queryVariant(p: Prng): { query: string; note: string } {
  const variants: Array<() => { query: string; note: string }> = [
    () => ({
      query: `?${randomString(p, SAFE, 3)}=${
        randomString(p, PRINTABLE.replace(/[#]/g, ""), p.int(0, 200))
      }`,
      note: "query:random",
    }),
    () => ({
      query: `?${
        Array.from({ length: p.int(50, 500) }, (_, i) => `k${i}=v${i}`).join(
          "&",
        )
      }`,
      note: "query:many-params",
    }),
    () => ({ query: `?x=${"a".repeat(65_536)}`, note: "query:64k-value" }),
    () => ({ query: `?${"&".repeat(1000)}`, note: "query:only-ampersands" }),
    () => ({
      query: `?x=1&x=2&x=3&x=${randomString(p, SAFE, 4)}`,
      note: "query:repeated-key",
    }),
    () => ({ query: `?%zz=%zz`, note: "query:malformed-pct" }),
    () => ({ query: `?x=%00%01%02`, note: "query:encoded-control" }),
    () => ({
      query: `?x=${randomString(p, CONTROL, 6)}`,
      note: "query:raw-control",
    }),
    () => ({ query: `?x=' OR 1=1 --`, note: "query:sqlish" }),
    () => ({ query: `?x={"a":[1,2,{"b":null}]}`, note: "query:json" }),
    () => ({
      query: `?x=${encodeURIComponent(randomString(p, WIDE, 20))}`,
      note: "query:unicode",
    }),
    () => ({ query: `??x=1`, note: "query:double-qmark" }),
    () => ({
      query: `?select=*&user_id=eq.${p.uuid()}`,
      note: "query:postgrest-shaped",
    }),
    () => ({
      query: `?apikey=${randomString(p, SAFE, 32)}&access_token=${
        randomString(p, SAFE, 32)
      }`,
      note: "query:credential-shaped",
    }),
    () => ({
      query: `?${randomString(p, SAFE, 4)}=<script>alert(1)</script>`,
      note: "query:html",
    }),
  ];
  return pick(p, variants)();
}

function miscHeaderVariant(
  p: Prng,
): {
  headers: Array<[string, string]>;
  ipShared: boolean;
  oversizedCl: boolean;
  note: string;
} {
  const variants: Array<
    () => {
      headers: Array<[string, string]>;
      ipShared: boolean;
      oversizedCl: boolean;
      note: string;
    }
  > = [
    () => ({
      headers: [["x-forwarded-for", ""]],
      ipShared: true,
      oversizedCl: false,
      note: "hdr:xff-empty",
    }),
    () => ({
      headers: [["x-forwarded-for", ",,,"]],
      ipShared: true,
      oversizedCl: false,
      note: "hdr:xff-commas",
    }),
    () => ({
      headers: [[
        "x-forwarded-for",
        Array.from({ length: 1000 }, () => privateIp(p)).join(", "),
      ]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:xff-1000-hops",
    }),
    () => ({
      headers: [[
        "x-forwarded-for",
        `${privateIp(p)}, 2001:db8::${p.int(1, 9999).toString(16)}`,
      ]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:xff-ipv6-last",
    }),
    () => ({
      headers: [["x-forwarded-for", randomString(p, PRINTABLE, p.int(1, 200))]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:xff-garbage",
    }),
    () => ({
      headers: [["x-forwarded-for", randomString(p, LATIN1, 20)]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:xff-latin1",
    }),
    () => ({
      headers: [[
        "cf-connecting-ip",
        randomString(p, PRINTABLE, p.int(1, 100)),
      ]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:cf-ip-garbage",
    }),
    () => ({
      headers: [["cf-connecting-ip", "   "]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:cf-ip-blank",
    }),
    () => ({
      headers: [["content-length", "0"]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:cl-zero",
    }),
    () => ({
      headers: [["content-length", "-1"]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:cl-negative",
    }),
    () => ({
      headers: [["content-length", "abc"]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:cl-nan",
    }),
    () => ({
      headers: [["content-length", "5000001"]],
      ipShared: false,
      oversizedCl: true,
      note: "hdr:cl-over-cap",
    }),
    () => ({
      headers: [["content-length", "5000000"]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:cl-at-cap",
    }),
    () => ({
      headers: [["content-length", "1e12"]],
      ipShared: false,
      oversizedCl: true,
      note: "hdr:cl-exponent",
    }),
    () => ({
      headers: [["content-length", "9".repeat(400)]],
      ipShared: false,
      oversizedCl: true,
      note: "hdr:cl-400-digits",
    }),
    () => ({
      headers: [["content-length", "Infinity"]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:cl-infinity",
    }),
    () => ({
      headers: [["content-length", "0x10"]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:cl-hex",
    }),
    () => ({
      headers: [["content-type", randomString(p, PRINTABLE, p.int(1, 100))]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:ct-garbage",
    }),
    () => ({
      headers: [["content-type", "multipart/form-data; boundary=----x"]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:ct-multipart",
    }),
    () => ({
      headers: [["accept", "text/html"]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:accept-html",
    }),
    () => ({
      headers: [["accept", "application/vnd.pgrst.object+json"]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:accept-pgrst",
    }),
    () => ({
      headers: [[
        "accept-encoding",
        "gzip, br, " + randomString(p, PRINTABLE, 50),
      ]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:accept-encoding",
    }),
    () => ({
      headers: [["transfer-encoding", "chunked"]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:te-chunked",
    }),
    () => ({
      headers: [["expect", "100-continue"]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:expect",
    }),
    () => ({
      headers: [["range", "bytes=0-1"]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:range",
    }),
    () => ({
      headers: [["if-none-match", `"${randomString(p, SAFE, 20)}"`]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:inm",
    }),
    () => ({
      headers: [["origin", "https://evil.example"], [
        "referer",
        "https://evil.example/x",
      ]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:origin-referer",
    }),
    () => ({
      headers: [["host", randomString(p, SAFE, 30)]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:host-override",
    }),
    () => ({
      headers: [["prefer", "return=representation"]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:prefer",
    }),
    () => ({
      headers: [["x-supabase-auth", randomString(p, SAFE, 30)]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:x-supabase-auth",
    }),
    () => ({
      headers: [["apikey", randomString(p, SAFE, 40)]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:apikey",
    }),
    () => ({
      headers: [["cookie", `sb-access-token=${randomString(p, SAFE, 40)}`]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:cookie",
    }),
    () => ({
      headers: [[
        `x-${randomString(p, SAFE, 10)}`,
        randomString(p, PRINTABLE, 32_768),
      ]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:32k-value",
    }),
    () => ({
      headers: Array.from(
        { length: 200 },
        (_, i) => [`x-fuzz-${i}`, randomString(p, SAFE, 8)] as [string, string],
      ),
      ipShared: false,
      oversizedCl: false,
      note: "hdr:200-headers",
    }),
    () => ({
      headers: [["x-forwarded-proto", "gopher"], [
        "x-forwarded-host",
        "evil.example",
      ]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:xf-proto-host",
    }),
    () => ({
      headers: [["x-apple-revocation-protocol", "1"]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:apple-revocation",
    }),
    () => ({
      headers: [["retry-after", "0"]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:retry-after",
    }),
    () => ({
      headers: [["upgrade", "websocket"], ["connection", "Upgrade"]],
      ipShared: false,
      oversizedCl: false,
      note: "hdr:upgrade",
    }),
  ];
  return pick(p, variants)();
}

function bodyVariant(
  p: Prng,
): {
  body: BodyInit | null;
  kind: string;
  bytes: number;
  contentType: string | null;
} {
  const variants: Array<
    () => {
      body: BodyInit | null;
      kind: string;
      bytes: number;
      contentType: string | null;
    }
  > = [
    () => ({
      body: "{not json",
      kind: "body:invalid-json",
      bytes: 9,
      contentType: "application/json",
    }),
    () => ({
      body: "",
      kind: "body:empty",
      bytes: 0,
      contentType: "application/json",
    }),
    () => ({
      body: "null",
      kind: "body:null",
      bytes: 4,
      contentType: "application/json",
    }),
    () => ({
      body: "[1,2,3]",
      kind: "body:array",
      bytes: 7,
      contentType: "application/json",
    }),
    () => ({
      body: JSON.stringify({ premium: true, freeRatings: { used: -5 } }),
      kind: "body:shaped-like-response",
      bytes: 40,
      contentType: "application/json",
    }),
    () => {
      const s = "[".repeat(100_000);
      return {
        body: s,
        kind: "body:100k-nesting",
        bytes: s.length,
        contentType: "application/json",
      };
    },
    () => {
      const s = "x".repeat(1_000_000);
      return {
        body: s,
        kind: "body:1MB-text",
        bytes: s.length,
        contentType: "text/plain",
      };
    },
    () => {
      const s = `{"a":"${"x".repeat(5_000_100)}"}`;
      return {
        body: s,
        kind: "body:5MB-over-cap-json",
        bytes: s.length,
        contentType: "application/json",
      };
    },
    () => {
      const bytes = crypto.getRandomValues(new Uint8Array(p.int(1, 4096)));
      return {
        body: bytes,
        kind: "body:binary",
        bytes: bytes.byteLength,
        contentType: "application/octet-stream",
      };
    },
    () => ({
      body: "a=1&b=2",
      kind: "body:form",
      bytes: 7,
      contentType: "application/x-www-form-urlencoded",
    }),
    () => {
      const chunks = p.int(1, 20);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < chunks; i++) {
            controller.enqueue(new TextEncoder().encode(`{"chunk":${i}}`));
          }
          controller.close();
        },
      });
      return {
        body: stream,
        kind: `body:stream-${chunks}-chunks`,
        bytes: -1,
        contentType: "application/json",
      };
    },
    () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("stress: client aborted body"));
        },
      });
      return {
        body: stream,
        kind: "body:stream-errored",
        bytes: -1,
        contentType: "application/json",
      };
    },
    () => ({
      body: randomString(p, WIDE, p.int(1, 500)),
      kind: "body:unicode",
      bytes: -1,
      contentType: "application/json",
    }),
  ];
  return pick(p, variants)();
}

function rpcFaultVariant(
  p: Prng,
  marker: string,
): { fault: UpstreamFault; note: string; mayBe200: boolean } {
  const pgErr = (status: number, code: string) => ({
    kind: "status" as const,
    status,
    body: JSON.stringify({
      code,
      message: `${marker} relation "public.secret" does not exist`,
      details: `${marker} at pg_catalog`,
      hint: null,
    }),
  });
  const variants: Array<
    () => { fault: UpstreamFault; note: string; mayBe200: boolean }
  > = [
    () => ({
      fault: pgErr(400, "42883"),
      note: "rpc:400-pg-error",
      mayBe200: false,
    }),
    () => ({ fault: pgErr(401, "PGRST301"), note: "rpc:401", mayBe200: false }),
    () => ({
      fault: pgErr(403, "42501"),
      note: "rpc:403-rls",
      mayBe200: false,
    }),
    () => ({
      fault: pgErr(404, "PGRST202"),
      note: "rpc:404-missing-fn",
      mayBe200: false,
    }),
    () => ({ fault: pgErr(409, "23505"), note: "rpc:409", mayBe200: false }),
    () => ({
      fault: {
        kind: "status",
        status: 429,
        body: `{"message":"${marker}"}`,
        retryAfter: "7",
      },
      note: "rpc:429",
      mayBe200: false,
    }),
    () => ({ fault: pgErr(500, "XX000"), note: "rpc:500", mayBe200: false }),
    () => ({
      fault: {
        kind: "status",
        status: 502,
        body: `<html>${marker} bad gateway</html>`,
        contentType: "text/html",
      },
      note: "rpc:502-html",
      mayBe200: false,
    }),
    () => ({
      fault: { kind: "status", status: 503, body: "", retryAfter: "30" },
      note: "rpc:503-empty",
      mayBe200: false,
    }),
    () => ({
      fault: {
        kind: "status",
        status: 504,
        body: marker,
        contentType: "text/plain",
      },
      note: "rpc:504-text",
      mayBe200: false,
    }),
    () => ({
      fault: { kind: "throw" },
      note: "rpc:network-throw",
      mayBe200: false,
    }),
    () => ({
      fault: { kind: "json", value: null },
      note: "rpc:200-null",
      mayBe200: false,
    }),
    () => ({
      fault: { kind: "json", value: [] },
      note: "rpc:200-empty-array",
      mayBe200: false,
    }),
    () => ({
      fault: { kind: "json", value: {} },
      note: "rpc:200-object",
      mayBe200: false,
    }),
    () => ({
      fault: { kind: "json", value: [null] },
      note: "rpc:200-array-null",
      mayBe200: false,
    }),
    () => ({
      fault: { kind: "json", value: [{}] },
      note: "rpc:200-empty-row",
      mayBe200: true,
    }),
    () => ({
      fault: {
        kind: "json",
        value: [{ premium: null, scored_count: null, reserved_count: null }],
      },
      note: "rpc:200-null-columns",
      mayBe200: true,
    }),
    () => ({
      fault: {
        kind: "json",
        value: [{ premium: "yes", scored_count: "2", reserved_count: "1" }],
      },
      note: "rpc:200-string-columns",
      mayBe200: true,
    }),
    () => ({
      fault: {
        kind: "json",
        value: [{ premium: false, scored_count: -3, reserved_count: 0 }],
      },
      note: "rpc:200-negative-scored",
      mayBe200: true,
    }),
    () => ({
      fault: {
        kind: "json",
        value: [{ premium: false, scored_count: 0, reserved_count: -1 }],
      },
      note: "rpc:200-negative-reserved",
      mayBe200: true,
    }),
    () => ({
      fault: {
        kind: "json",
        value: [{ premium: false, scored_count: 1.5, reserved_count: 0.5 }],
      },
      note: "rpc:200-fractional",
      mayBe200: true,
    }),
    () => ({
      fault: {
        kind: "json",
        value: [{
          premium: false,
          scored_count: 2147483648,
          reserved_count: 9007199254740993,
        }],
      },
      note: "rpc:200-huge-ints",
      mayBe200: true,
    }),
    () => ({
      fault: {
        kind: "json",
        value: [{ premium: true, scored_count: 0, reserved_count: 0 }, {
          premium: false,
          scored_count: 2,
          reserved_count: 2,
        }],
      },
      note: "rpc:200-two-rows",
      mayBe200: true,
    }),
    () => ({
      fault: {
        kind: "json",
        value: [{
          premium: false,
          scored_count: 0,
          reserved_count: 0,
          [marker]: marker,
        }],
      },
      note: "rpc:200-extra-column",
      mayBe200: true,
    }),
    () => ({
      fault: { kind: "json", value: "garbage" },
      note: "rpc:200-string",
      mayBe200: false,
    }),
    () => ({
      fault: { kind: "json", value: 42 },
      note: "rpc:200-number",
      mayBe200: false,
    }),
    () => ({
      fault: {
        kind: "json",
        value: Array.from(
          { length: 10_000 },
          () => ({ premium: false, scored_count: 0, reserved_count: 0 }),
        ),
      },
      note: "rpc:200-10k-rows",
      mayBe200: true,
    }),
    () => ({
      fault: {
        kind: "text",
        text: `not json ${marker}`,
        contentType: "application/json",
      },
      note: "rpc:200-not-json",
      mayBe200: false,
    }),
    () => ({
      fault: { kind: "text", text: "", contentType: "application/json" },
      note: "rpc:200-empty-body",
      mayBe200: false,
    }),
    () => ({
      fault: {
        kind: "text",
        text: `<html>${marker}</html>`,
        contentType: "text/html",
      },
      note: "rpc:200-html",
      mayBe200: false,
    }),
  ];
  return pick(p, variants)();
}

function authUserFaultVariant(
  p: Prng,
  marker: string,
): { fault: UpstreamFault; note: string } {
  const variants: Array<() => { fault: UpstreamFault; note: string }> = [
    () => ({
      fault: { kind: "status", status: 500, body: `{"msg":"${marker}"}` },
      note: "auth.user:500",
    }),
    () => ({
      fault: {
        kind: "status",
        status: 502,
        body: `<html>${marker}</html>`,
        contentType: "text/html",
      },
      note: "auth.user:502-html",
    }),
    () => ({
      fault: {
        kind: "status",
        status: 429,
        body: `{"msg":"${marker}"}`,
        retryAfter: "12",
      },
      note: "auth.user:429",
    }),
    () => ({ fault: { kind: "throw" }, note: "auth.user:network-throw" }),
    () => ({
      fault: {
        kind: "text",
        text: `not json ${marker}`,
        contentType: "application/json",
      },
      note: "auth.user:200-not-json",
    }),
    () => ({
      fault: { kind: "json", value: null },
      note: "auth.user:200-null",
    }),
    () => ({
      fault: { kind: "json", value: { id: 42 } },
      note: "auth.user:200-id-number",
    }),
    () => ({
      fault: {
        kind: "json",
        value: { id: p.uuid(), app_metadata: { provider: "facebook" } },
      },
      note: "auth.user:200-foreign-provider",
    }),
    () => ({
      fault: { kind: "json", value: { id: p.uuid(), app_metadata: {} } },
      note: "auth.user:200-no-provider",
    }),
    () => ({
      fault: {
        kind: "status",
        status: 401,
        body: `{"msg":"${marker}","error_code":"bad_jwt"}`,
      },
      note: "auth.user:401",
    }),
    () => ({
      fault: {
        kind: "status",
        status: 403,
        body: `{"msg":"${marker}","error_code":"session_not_found"}`,
      },
      note: "auth.user:403",
    }),
  ];
  return pick(p, variants)();
}

function tokenFaultVariant(
  p: Prng,
  marker: string,
): { fault: UpstreamFault; note: string } {
  const variants: Array<() => { fault: UpstreamFault; note: string }> = [
    () => ({
      fault: { kind: "status", status: 500, body: `{"msg":"${marker}"}` },
      note: "auth.token:500",
    }),
    () => ({
      fault: {
        kind: "status",
        status: 400,
        body: `{"error":"invalid_grant","error_description":"${marker}"}`,
      },
      note: "auth.token:400-invalid-grant",
    }),
    () => ({ fault: { kind: "throw" }, note: "auth.token:network-throw" }),
    () => ({
      fault: {
        kind: "text",
        text: `not json ${marker}`,
        contentType: "application/json",
      },
      note: "auth.token:200-not-json",
    }),
    () => ({
      fault: { kind: "json", value: { access_token: "", user: null } },
      note: "auth.token:200-empty-session",
    }),
    () => ({
      fault: {
        kind: "json",
        value: { access_token: marker, user: { id: marker } },
      },
      note: "auth.token:200-marker-session",
    }),
  ];
  return pick(p, variants)();
}

export const CATEGORIES = [
  "valid",
  "method",
  "path",
  "query",
  "auth-header",
  "misc-header",
  "body",
  "rpc-fault",
  "auth-fault",
  "combo",
] as const;
export type Category = (typeof CATEGORIES)[number];

const WEIGHTS: Array<[Category, number]> = [
  ["valid", 14],
  ["method", 7],
  ["path", 14],
  ["query", 8],
  ["auth-header", 18],
  ["misc-header", 12],
  ["body", 6],
  ["rpc-fault", 10],
  ["auth-fault", 5],
  ["combo", 6],
];

function pickCategory(p: Prng): Category {
  const total = WEIGHTS.reduce((n, [, w]) => n + w, 0);
  let r = p.next() * total;
  for (const [c, w] of WEIGHTS) {
    if (r < w) return c;
    r -= w;
  }
  return "valid";
}

/** Build one seeded request for GET /v1/me/access. Deterministic in `seed`. */
export function generate(
  seed: number,
  ctx: GeneratorContext,
  forced?: Category,
): Generated {
  const p = new Prng(seed);
  const category = forced ?? pickCategory(p);
  const notes: string[] = [];
  let method = "GET";
  let url = `${EDGE_ORIGIN}${CANONICAL_PATH}`;
  const headers: Array<[string, string]> = [];
  let body: BodyInit | null | undefined = undefined;
  let bodyKind = "none";
  let bodyBytes = 0;
  let tokenKind: TokenKind = "none";
  let userId: string | null = null;
  let authorization: string | null = null;
  let ipShared = false;
  let oversizedCl = false;
  let fault: Generated["fault"] = null;
  let clientRequestId: string | null = null;
  let wellFormedRid: string | null = null;

  const useValidToken = () => {
    const t = validToken(p, ctx);
    authorization = `Bearer ${t.token}`;
    tokenKind = t.kind;
    userId = t.userId;
    notes.push(...t.notes);
  };
  const useBadToken = () => {
    const bad = malformedAuthorization(p, ctx);
    authorization = bad.value;
    tokenKind = bad.lenient ? "provider-lenient" : "invalid";
    notes.push(bad.note);
  };
  const applyPath = () => {
    const v = pathVariant(p);
    url = v.url;
    notes.push(v.note);
  };
  const applyQuery = () => {
    const q = queryVariant(p);
    url = `${url}${q.query}`;
    notes.push(q.note);
  };
  const applyMisc = () => {
    const m = miscHeaderVariant(p);
    headers.push(...m.headers);
    ipShared ||= m.ipShared;
    oversizedCl ||= m.oversizedCl;
    notes.push(m.note);
  };
  let ridApplied = false;
  const applyRid = () => {
    if (ridApplied) return;
    ridApplied = true;
    const r = requestIdVariant(p);
    if (r.value !== null) headers.push(["x-request-id", r.value]);
    clientRequestId = r.value;
    wellFormedRid = r.wellFormed;
    notes.push(r.note);
  };
  const applyMethod = () => {
    method = pick(p, METHODS_OTHER);
    notes.push(`method:${method}`);
  };
  const applyBody = () => {
    if (method === "GET" || method === "HEAD") {
      method = pick(p, ["POST", "PUT", "PATCH", "DELETE"]);
      notes.push(`method:${method}`);
    }
    const b = bodyVariant(p);
    body = b.body;
    bodyKind = b.kind;
    bodyBytes = b.bytes;
    if (b.contentType) headers.push(["content-type", b.contentType]);
    notes.push(b.kind);
  };
  const applyRpcFault = () => {
    const f = rpcFaultVariant(p, ctx.upstream.leakMarker);
    fault = { target: "rpc", fault: f.fault };
    notes.push(f.note);
  };
  const applyAuthFault = () => {
    if (tokenKind === "session-valid") {
      // Only a COLD session token reaches GoTrue; mint one so the fault is hit.
      const user = ctx.pool.find((u) => u.userId === userId)!;
      authorization = `Bearer ${
        ctx.upstream.mintSession(user.userId, {
          sessionId: p.uuid(),
          jti: p.uuid(),
        })
      }`;
      const f = authUserFaultVariant(p, ctx.upstream.leakMarker);
      fault = { target: "auth.user", fault: f.fault };
      notes.push(f.note);
    } else {
      const f = tokenFaultVariant(p, ctx.upstream.leakMarker);
      fault = { target: "auth.token", fault: f.fault };
      notes.push(f.note);
    }
  };

  switch (category) {
    case "valid":
      useValidToken();
      if (p.next() < 0.5) applyRid();
      break;
    case "method":
      if (p.next() < 0.8) useValidToken();
      else useBadToken();
      applyMethod();
      if (
        p.next() < 0.3 && method !== "GET" && method !== "HEAD" &&
        method.toUpperCase() !== "GET"
      ) applyBody();
      break;
    case "path":
      if (p.next() < 0.8) useValidToken();
      else useBadToken();
      applyPath();
      break;
    case "query":
      useValidToken();
      applyQuery();
      break;
    case "auth-header":
      useBadToken();
      if (p.next() < 0.3) applyRid();
      break;
    case "misc-header":
      if (p.next() < 0.85) useValidToken();
      else useBadToken();
      applyMisc();
      if (p.next() < 0.5) applyRid();
      break;
    case "body":
      if (p.next() < 0.7) useValidToken();
      else useBadToken();
      applyBody();
      break;
    case "rpc-fault":
      useValidToken();
      applyRpcFault();
      break;
    case "auth-fault":
      useValidToken();
      applyAuthFault();
      break;
    case "combo": {
      if (p.next() < 0.6) useValidToken();
      else useBadToken();
      const n = p.int(2, 4);
      for (let i = 0; i < n; i++) {
        const step = p.int(0, 5);
        if (step === 0) applyPath();
        else if (step === 1) applyQuery();
        else if (step === 2) applyMisc();
        else if (step === 3) applyRid();
        else if (step === 4) applyMethod();
        else applyRpcFault();
      }
      break;
    }
  }

  if (authorization !== null) headers.push(["Authorization", authorization]);
  if (
    !headers.some(([k]) =>
      k.toLowerCase() === "x-forwarded-for" ||
      k.toLowerCase() === "cf-connecting-ip"
    )
  ) {
    headers.push(["x-forwarded-for", privateIp(p)]);
  }
  let duplicated: string | null = null;
  if (p.next() < 0.1) {
    // Duplicate a header (Headers joins duplicates with ", ").
    const dup = pick(p, headers);
    headers.push([dup[0], dup[1]]);
    duplicated = dup[0].toLowerCase();
    notes.push(`dup:${duplicated}`);
    if (duplicated === "authorization") tokenKind = "invalid";
    if (duplicated === "x-request-id") wellFormedRid = null;
  }

  const routes = safeRoutesToAccess(method, url);
  // Closures above reassign tokenKind; TS narrows past them, so decide via a call.
  const expectOk = routes && tokenIsValid(tokenKind) &&
    !ipShared && !oversizedCl && fault === null &&
    !headers.some(([k]) => k.toLowerCase() === "content-length");

  return {
    category,
    spec: { method, url, headers, body, bodyKind, bodyBytes },
    tokenKind,
    userId,
    clientRequestId,
    fault,
    expectOk,
    notes: [
      ...notes,
      wellFormedRid ? `rid-expect:${wellFormedRid}` : "rid-expect:minted",
    ],
  };
}

function safeRoutesToAccess(method: string, url: string): boolean {
  try {
    return routesToAccess(method, url);
  } catch {
    return false;
  }
}

export function wellFormedClientRequestId(g: Generated): string | null {
  const note = g.notes.find((n) => n.startsWith("rid-expect:"));
  if (!note || note === "rid-expect:minted") return null;
  return note.slice("rid-expect:".length);
}

export function buildRequest(spec: RequestSpec): Request {
  const headers = new Headers();
  for (const [k, v] of spec.headers) headers.append(k, v);
  const init: RequestInit & { duplex?: string } = {
    method: spec.method,
    headers,
  };
  if (spec.body !== undefined && spec.body !== null) {
    init.body = spec.body;
    if (spec.body instanceof ReadableStream) init.duplex = "half";
  }
  return new Request(spec.url, init);
}

// ── Response checks ──────────────────────────────────────────────────────────

export interface ResponseFacts {
  status: number;
  requestId: string | null;
  contentType: string | null;
  retryAfter: string | null;
  nosniff: boolean;
  cacheControl: string | null;
  bodyText: string;
  bodyJson: unknown;
  bodyBytes: number;
}

export async function facts(response: Response): Promise<ResponseFacts> {
  const bodyText = await response.text();
  let bodyJson: unknown = undefined;
  try {
    bodyJson = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    bodyJson = undefined;
  }
  return {
    status: response.status,
    requestId: response.headers.get("x-request-id"),
    contentType: response.headers.get("content-type"),
    retryAfter: response.headers.get("retry-after"),
    nosniff: response.headers.get("x-content-type-options") === "nosniff",
    cacheControl: response.headers.get("cache-control"),
    bodyText,
    bodyJson,
    bodyBytes: new TextEncoder().encode(bodyText).byteLength,
  };
}

export const LEAK_PATTERNS: Array<[string, RegExp]> = [
  ["stack-frame", /\n\s+at\s+\S+/],
  ["stack-frame-inline", /\bat\s+(?:async\s+)?[\w$.<>]+\s+\(/],
  ["source-file", /index\.ts|http\.ts|rateLimit\.ts|cache\.ts|\.ts:\d+/],
  [
    "supabase-host",
    new RegExp(SUPABASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  ],
  ["postgrest-code", /PGRST\d+/],
  [
    "pg-error",
    /relation .* does not exist|pg_catalog|SQLSTATE|syntax error at/i,
  ],
  [
    "js-error-name",
    /\b(?:TypeError|RangeError|SyntaxError|ReferenceError|URIError)\b/,
  ],
  ["secret-key", /stress-service-role-key|stress-anon-key|sk_test_stress/],
];

export interface AccessLogFacts {
  lines: number;
  requestId: string | null;
  status: number | null;
  route: string | null;
}

export function accessLogFacts(lines: string[]): AccessLogFacts {
  if (lines.length !== 1) {
    return { lines: lines.length, requestId: null, status: null, route: null };
  }
  try {
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    return {
      lines: 1,
      requestId: typeof entry.requestId === "string" ? entry.requestId : null,
      status: typeof entry.status === "number" ? entry.status : null,
      route: typeof entry.route === "string" ? entry.route : null,
    };
  } catch {
    return { lines: 1, requestId: null, status: null, route: null };
  }
}

/** parseAccess (apps/mobile/src/billing/accessApi.ts) mirrored exactly. */
export function accessPayloadViolations(
  value: unknown,
  expected?: StubUser,
): string[] {
  const out: string[] = [];
  if (!isRecord(value) || !isRecord(value.freeRatings)) {
    return ["payload:not-record"];
  }
  const fr = value.freeRatings;
  const isInt = (n: unknown): n is number =>
    typeof n === "number" && Number.isInteger(n);
  if (typeof value.premium !== "boolean") {
    out.push("payload:premium-not-boolean");
  }
  if (
    !Array.isArray(value.entitlements) ||
    !value.entitlements.every((e) => typeof e === "string")
  ) out.push("payload:entitlements-not-string-array");
  if (typeof value.canStartRating !== "boolean") {
    out.push("payload:canStartRating-not-boolean");
  }
  if (typeof value.paywallRequired !== "boolean") {
    out.push("payload:paywallRequired-not-boolean");
  }
  if (fr.limit !== 2) out.push("payload:limit!=2");
  if (
    !isInt(fr.used) || !isInt(fr.reserved) || !isInt(fr.remaining) ||
    !isInt(fr.availableToReserve)
  ) {
    out.push("payload:counter-not-integer");
    return out;
  }
  const used = fr.used,
    reserved = fr.reserved,
    remaining = fr.remaining,
    avail = fr.availableToReserve;
  const premiumEnt = Array.isArray(value.entitlements) &&
    value.entitlements.includes("premium");
  const expectedCanStart = value.premium === true || avail > 0;
  if (used < 0 || used > 2) out.push("payload:used-out-of-range");
  if (reserved < 0) out.push("payload:reserved-negative");
  if (remaining !== 2 - used) out.push("payload:remaining!=2-used");
  if (reserved > remaining) out.push("payload:reserved>remaining");
  if (avail !== remaining - reserved) {
    out.push("payload:availableToReserve!=remaining-reserved");
  }
  if (value.premium !== premiumEnt) {
    out.push("payload:premium!=entitlements.includes(premium)");
  }
  if (value.canStartRating !== expectedCanStart) {
    out.push("payload:canStartRating-mismatch");
  }
  if (value.paywallRequired !== !expectedCanStart) {
    out.push("payload:paywallRequired-mismatch");
  }
  if (expected) {
    const eUsed = Math.min(2, expected.scored);
    const eReserved = Math.min(expected.reserved, 2 - eUsed);
    if (used !== eUsed) out.push(`payload:used=${used}!=${eUsed}`);
    if (reserved !== eReserved) {
      out.push(`payload:reserved=${reserved}!=${eReserved}`);
    }
    if (value.premium !== expected.premium) {
      out.push(
        `payload:premium=${String(value.premium)}!=${String(expected.premium)}`,
      );
    }
  }
  return out;
}

export interface Verdict {
  violations: string[];
  /** Behaviour worth recording that the lens does not classify as broken
   * (e.g. payload arithmetic on an RPC row a real integer column cannot produce). */
  observations: string[];
  reachedRoute: boolean;
  writes: number;
  unexpectedUpstream: number;
}

export function judge(
  g: Generated,
  f: ResponseFacts,
  log: AccessLogFacts,
  calls: UpstreamCall[],
  leakMarker: string,
  expectedUser?: StubUser,
): Verdict {
  const v: string[] = [];
  const observations: string[] = [];
  const writes = calls.filter((c) => c.kind === "write").length;
  const unexpected = calls.filter((c) => c.kind === "unexpected").length;
  const reachedRoute = calls.some((c) => c.kind === "rpc.access_state");
  const publicRoute = (() => {
    try {
      return isPublicRoute(g.spec.method, g.spec.url);
    } catch {
      return false;
    }
  })();

  // request-id contract
  if (!f.requestId) v.push("rid:missing");
  else if (!REQUEST_ID_RE.test(f.requestId)) {
    v.push("rid:malformed-on-response");
  }
  const wellFormed = wellFormedClientRequestId(g);
  if (wellFormed && f.requestId !== wellFormed) {
    v.push("rid:well-formed-client-id-not-echoed");
  }
  if (
    !wellFormed && g.clientRequestId !== null &&
    f.requestId === g.clientRequestId
  ) v.push("rid:malformed-client-id-echoed");
  if (!wellFormed && f.requestId && !UUID_RE.test(f.requestId)) {
    v.push("rid:minted-id-not-uuid");
  }

  // exactly one access-log line, correlated
  if (log.lines !== 1) v.push(`log:lines=${log.lines}`);
  else {
    if (log.requestId !== f.requestId) v.push("log:request-id-mismatch");
    if (log.status !== f.status) v.push("log:status-mismatch");
    if (log.route && /[?#]/.test(log.route)) v.push("log:route-carries-query");
  }

  // writes
  if (writes > 0) v.push(`write:${writes}-upstream-writes`);
  if (unexpected > 0) v.push(`upstream:${unexpected}-unexpected-calls`);

  // body hygiene (every response)
  for (const [name, re] of LEAK_PATTERNS) {
    if (re.test(f.bodyText)) v.push(`leak:${name}`);
  }
  if (f.bodyText.includes(leakMarker)) v.push("leak:upstream-detail-marker");
  for (const [k, val] of g.spec.headers) {
    if (
      k.toLowerCase() === "authorization" && val.length > 20 &&
      f.bodyText.includes(val.slice(-24))
    ) v.push("leak:bearer-echoed");
  }

  // status classes
  if (f.status >= 200 && f.status < 300) {
    if (publicRoute) {
      // public pages: text or {ok:true}; never authenticated
      if (
        calls.some((c) =>
          c.kind === "auth.token" || c.kind === "auth.user" ||
          c.kind === "rpc.access_state"
        )
      ) v.push("public:consulted-auth-or-db");
    } else {
      if (f.status !== 200) v.push(`status:2xx-not-200(${f.status})`);
      if (!safeRoutes(g)) v.push("status:200-for-non-access-route");
      if (g.tokenKind === "invalid" || g.tokenKind === "none") {
        v.push("status:200-without-valid-token");
      }
      if (g.tokenKind === "provider-lenient") {
        observations.push(
          `lenient-token-accepted:${
            g.notes.find((n) => n.startsWith("auth:")) ?? "?"
          }`,
        );
      }
      if (!(f.contentType ?? "").includes("application/json")) {
        v.push("hdr:200-not-json");
      }
      if (!f.nosniff) v.push("hdr:200-no-nosniff");
      if (f.cacheControl !== "no-store") v.push("hdr:200-not-no-store");
      if (g.fault?.target === "rpc") {
        // The row came from the fault, not the model: the mobile invariants
        // are recorded as observations (a Postgres integer/boolean column
        // cannot produce these shapes), the response shape itself must hold.
        const issues = accessPayloadViolations(f.bodyJson);
        if (issues.includes("payload:not-record")) {
          v.push("fault-200:payload:not-record");
        }
        observations.push(...issues.map((x) => `fault-200:${x}`));
      } else {
        v.push(...accessPayloadViolations(f.bodyJson, expectedUser));
      }
      if (g.fault?.target === "auth.token" || g.fault?.target === "auth.user") {
        // Connect faults are retried by the auth gateway; a 200 is fine only
        // when a later auth call actually succeeded.
        const idx = calls.findIndex((c) => c.kind === g.fault!.target);
        const recovered = calls.slice(idx + 1).some((c) =>
          c.kind === g.fault!.target && c.status === 200
        );
        if (!recovered) v.push("status:200-despite-auth-fault");
        else observations.push("auth-fault:recovered-by-retry");
      }
    }
  } else if (f.status >= 400 && f.status < 500) {
    if (!ALLOWED_REJECTIONS.has(f.status)) {
      v.push(`status:4xx-not-allowed(${f.status})`);
    }
    if (g.expectOk) v.push(`status:false-reject(${f.status})`);
    if (!(f.contentType ?? "").includes("application/json")) {
      v.push("hdr:4xx-not-json");
    } else {
      const b = f.bodyJson;
      if (
        !isRecord(b) || !isRecord(b.error) ||
        typeof b.error.message !== "string"
      ) v.push("body:4xx-not-error-shape");
      else {
        const keys = Object.keys(b.error).filter((k) =>
          k !== "message" && k !== "code"
        );
        if (keys.length) v.push(`body:4xx-extra-keys(${keys.join(",")})`);
        if (Object.keys(b).some((k) => k !== "error")) {
          v.push("body:4xx-extra-top-level");
        }
      }
    }
    if (f.status === 429 && !f.retryAfter) v.push("hdr:429-no-retry-after");
    if (!f.nosniff) v.push("hdr:4xx-no-nosniff");
  } else if (f.status >= 500) {
    if (!g.fault) v.push(`status:5xx-without-injected-fault(${f.status})`);
    if (f.status === 500) v.push("status:500-unhandled");
    else if (f.status !== 503) v.push(`status:5xx-not-503(${f.status})`);
    const b = f.bodyJson;
    if (
      !isRecord(b) || !isRecord(b.error) || typeof b.error.message !== "string"
    ) v.push("body:5xx-not-error-shape");
    else {
      const msg = b.error.message;
      const generic =
        /^[A-Za-z ]+ is temporarily unavailable\. Please try again\.$/.test(
          msg,
        ) || msg === "Something went wrong. Please try again.";
      if (!generic) v.push(`body:5xx-not-generic(${msg.slice(0, 60)})`);
      if (Object.keys(b.error).some((k) => k !== "message" && k !== "code")) {
        v.push("body:5xx-extra-keys");
      }
    }
    if (!(f.contentType ?? "").includes("application/json")) {
      v.push("hdr:5xx-not-json");
    }
    if (f.bodyBytes > 512) v.push(`body:5xx-large(${f.bodyBytes})`);
  } else {
    v.push(`status:unexpected-class(${f.status})`);
  }
  return {
    violations: v,
    observations,
    reachedRoute,
    writes,
    unexpectedUpstream: unexpected,
  };
}

function safeRoutes(g: Generated): boolean {
  return safeRoutesToAccess(g.spec.method, g.spec.url);
}

// ── Table / artifacts ────────────────────────────────────────────────────────

export interface IterationRow {
  i: number;
  seed: number;
  category: string;
  notes: string[];
  method: string;
  url: string;
  headers: Array<[string, string]>;
  bodyKind: string;
  bodyBytes: number;
  tokenKind: TokenKind;
  fault: string | null;
  expectOk: boolean;
  status: number | null;
  requestId: string | null;
  clientRequestId: string | null;
  bodyBytesOut: number;
  bodySample: string;
  upstream: string[];
  reachedRoute: boolean;
  writes: number;
  durationMs: number;
  verdict: "HELD" | "BROKEN" | "UNCONSTRUCTIBLE" | "HANDLER_THREW";
  violations: string[];
  observations: string[];
}

const HEADER_SAMPLE = 200;
export function sampleHeaders(
  headers: Array<[string, string]>,
): Array<[string, string]> {
  return headers.slice(0, 40).map((
    [k, v],
  ) => [
    k,
    v.length > HEADER_SAMPLE ? `${v.slice(0, HEADER_SAMPLE)}…(${v.length})` : v,
  ]);
}

export function sampleUrl(url: string): string {
  return url.length > 300 ? `${url.slice(0, 300)}…(${url.length})` : url;
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-route-me-access/latest/",
    import.meta.url,
  ).pathname;
}

export async function writeJson(name: string, value: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

export function replaySeeds(): number[] | null {
  const raw = Deno.env.get("STRESS_REPLAY");
  if (!raw) return null;
  const seeds = raw.split(",").map((s) => Number(s.trim())).filter((n) =>
    Number.isFinite(n)
  );
  return seeds.length ? seeds : null;
}
