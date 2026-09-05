// Fault-injectable upstream world for stress-testing the REAL edge handler
// (../index.ts) in process. Companion to routesHarness.ts / sessionHarness.ts;
// this one boots index.ts with Upstash CONFIGURED (fake REST endpoint) so the
// L2 cache and shared rate-limit paths run, and lets every upstream — Supabase
// Auth (id_token grant + GET /user), PostgREST, RevenueCat, Upstash — be made
// to fail, hang, answer slowly, or answer with a malformed body, in turn.
//
// Deterministic: users, ips and tokens are minted from a seeded RNG so every
// iteration of a campaign is replayable from its seed. Nothing here touches a
// network: the only fetch that exists is the fake installed over globalThis.

import { captureAccessLog } from "../http.ts";

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const REDIS_TOKEN = "stress-upstash-token";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";

export type Upstream =
  | "auth_token"
  | "auth_user"
  | "auth_other"
  | "rest"
  | "revenuecat"
  | "redis";

/** One injected fault. `times` bounds how many calls it applies to (default:
 * every call while installed); `every` applies it to every n-th call only. */
export type Fault =
  | {
    kind: "http";
    status: number;
    body?: string;
    headers?: Record<string, string>;
  }
  /** Hang until the caller's AbortSignal fires (rejecting with its reason);
   * a caller without a signal gets `fallbackMs` of delay and then a 503 so a
   * test can never hang forever. */
  | { kind: "hang"; fallbackMs?: number }
  | { kind: "net_error"; message?: string }
  /** Delay, then answer for real. */
  | { kind: "latency"; ms: number }
  /** HTTP 200 whose body stream errors mid-read. */
  | { kind: "body_error" }
  | {
    kind: "custom";
    respond: (request: Request, body: unknown) => Response | Promise<Response>;
  };

export interface InstalledFault {
  fault: Fault;
  times?: number;
  every?: number;
  /** Calls seen by this installation (for `every` / `times`). */
  seen: number;
  applied: number;
}

export interface RecordedCall {
  seq: number;
  upstream: Upstream | "unexpected";
  url: string;
  method: string;
  /** Redis: the pipeline commands; others: parsed JSON body or raw text. */
  body: unknown;
  status: number | null;
  outcome: "answered" | "faulted" | "hung" | "net_error";
  durationMs: number;
}

export interface FakeUser {
  id: string;
  email: string;
  provider: "google" | "apple" | "email";
}

export interface FakeSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  expiresAt: number;
  revoked: boolean;
}

export interface AccessLine {
  evt: string;
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  code?: string;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  realFetch: typeof fetch;
  realServe: typeof Deno.serve;
  calls: RecordedCall[];
  accessLog: AccessLine[];
  users: Map<string, FakeUser>;
  sessions: Map<string, FakeSession>;
  redis: Map<string, { value: string; expiresAtMs: number | null }>;
  redisCommands: Array<Array<string | number>>;
  tables: Record<string, unknown[]>;
  rpcs: Record<string, unknown>;
  subscriber: Record<string, unknown> | null;
  faults: Map<Upstream, InstalledFault[]>;
  /** Install a fault on an upstream (stacked: first installed answers first). */
  inject(
    upstream: Upstream,
    fault: Fault,
    options?: { times?: number; every?: number },
  ): void;
  /** Remove every fault (everything heals). */
  heal(upstream?: Upstream): void;
  /** Forget recorded calls/log lines/redis commands (state such as users,
   * sessions and the Redis store is kept unless `hard`). */
  reset(hard?: boolean): void;
  callsTo(upstream: Upstream | "unexpected"): RecordedCall[];
  /** Calls recorded after `seq` (exclusive). */
  callsSince(seq: number): RecordedCall[];
  lastSeq(): number;
  registerUser(user: FakeUser): FakeUser;
  /** Mint a Supabase session for a user (as bootstrap would). */
  mintSession(
    userId: string,
    ttlSeconds?: number,
    options?: { sessionId?: string },
  ): FakeSession;
  /** (Re)point fetch/Deno.serve/the access log/the env at this harness. */
  install(): void;
  /** Put back the real fetch/Deno.serve, the access-log printer and the env. */
  restore(): void;
}

// ─── Deterministic helpers ──────────────────────────────────────────────────

/** splitmix32-style seeded RNG; `next()` ∈ [0, 1). */
export interface Rng {
  readonly seed: number;
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  uuid(): string;
  hex(bytes: number): string;
}

export function rng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 4294967296;
  };
  const hex = (bytes: number): string => {
    let out = "";
    for (let i = 0; i < bytes; i += 1) {
      out += Math.floor(next() * 256)
        .toString(16)
        .padStart(2, "0");
    }
    return out;
  };
  return {
    seed,
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    pick: (items) => items[Math.floor(next() * items.length)],
    hex,
    uuid: () => {
      const h = hex(16);
      // RFC 4122 v4 shape (index.ts UUID_RE requires version 1–8, variant 8–b).
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${
        ["8", "9", "a", "b"][Math.floor(next() * 4)]
      }${h.slice(17, 20)}-${h.slice(20, 32)}`;
    },
  };
}

/** FNV-1a 32-bit — stable seed derivation from a case id + campaign seed. */
export function seedFor(label: string, baseSeed: number): number {
  let h = 0x811c9dc5 ^ (baseSeed >>> 0);
  for (let i = 0; i < label.length; i += 1) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

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

/** Unsigned JWT (issuer routing / expiry only — the fake GoTrue never verifies). */
export function fakeJwt(
  payload: Record<string, unknown>,
  signature = "sig",
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.${b64url(signature)}`;
}

export function providerIdToken(
  provider: "google" | "apple",
  sub: string,
  r: Rng,
  ttlSeconds = 3600,
): string {
  return fakeJwt(
    {
      iss: provider === "google"
        ? "https://accounts.google.com"
        : "https://appleid.apple.com",
      sub,
      aud: "com.picklesensei",
      jti: r.uuid(),
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    },
    r.hex(8),
  );
}

export function seededIp(r: Rng): string {
  // 100.64.0.0/10 — disjoint from the 198.51.100.0/24 pool the other edge
  // suites use, so a shared rate-limit window can never be blamed on them.
  return `100.${64 + r.int(64)}.${r.int(256)}.${1 + r.int(250)}`;
}

// ─── Harness ────────────────────────────────────────────────────────────────

let harness: StressHarness | null = null;

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

function redisLive(
  store: StressHarness["redis"],
  key: string,
): { value: string; expiresAtMs: number | null } | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry;
}

function runRedisCommand(
  store: StressHarness["redis"],
  cmd: Array<string | number>,
): { result?: unknown; error?: string } {
  const [name, ...args] = cmd.map(String);
  switch (name.toUpperCase()) {
    case "GET":
      return { result: redisLive(store, args[0])?.value ?? null };
    case "TTL": {
      const entry = redisLive(store, args[0]);
      if (!entry) return { result: -2 };
      if (entry.expiresAtMs === null) return { result: -1 };
      return {
        result: Math.max(
          1,
          Math.ceil((entry.expiresAtMs - Date.now()) / 1_000),
        ),
      };
    }
    case "SET": {
      const [key, value, ex, seconds] = args;
      if (ex && ex.toUpperCase() !== "EX") return { error: "ERR syntax error" };
      const ttl = ex ? Number(seconds) : NaN;
      store.set(key, {
        value,
        expiresAtMs: Number.isFinite(ttl) ? Date.now() + ttl * 1_000 : null,
      });
      return { result: "OK" };
    }
    case "DEL": {
      let n = 0;
      for (const key of args) if (store.delete(key)) n += 1;
      return { result: n };
    }
    case "INCR": {
      const entry = redisLive(store, args[0]);
      const next = (entry ? Number(entry.value) : 0) + 1;
      store.set(args[0], {
        value: String(next),
        expiresAtMs: entry?.expiresAtMs ?? null,
      });
      return { result: next };
    }
    case "EXPIRE": {
      const [key, seconds, flag] = args;
      const entry = redisLive(store, key);
      if (!entry) return { result: 0 };
      if (flag && flag.toUpperCase() === "NX" && entry.expiresAtMs !== null) {
        return { result: 0 };
      }
      entry.expiresAtMs = Date.now() + Number(seconds) * 1_000;
      return { result: 1 };
    }
    default:
      return { error: `ERR unknown command '${name}'` };
  }
}

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const authError = (status: number, msg: string): Response =>
  jsonResponse(status, { code: status, msg, error_code: "bad_jwt" });

function classify(url: string, method: string): Upstream | "unexpected" {
  if (url === `${REDIS_URL}/pipeline`) return "redis";
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) return "auth_token";
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`) && method === "GET") {
    return "auth_user";
  }
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/`)) return "auth_other";
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) return "rest";
  if (url.startsWith(RC_URL)) return "revenuecat";
  return "unexpected";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve a fault's response. Returns null when the fault decided to let the
 * real fake answer (latency faults), throws for network-level faults. */
async function applyFault(
  fault: Fault,
  request: Request,
  body: unknown,
  signal: AbortSignal | null | undefined,
): Promise<Response | null> {
  switch (fault.kind) {
    case "http": {
      const bodyless = fault.status === 204 || fault.status === 205 ||
        fault.status === 304;
      return new Response(
        bodyless ? null : fault.body ?? `upstream ${fault.status}`,
        {
          status: fault.status,
          headers: fault.headers ?? { "Content-Type": "text/plain" },
        },
      );
    }
    case "hang": {
      if (signal) {
        await new Promise<void>((_, reject) => {
          if (signal.aborted) {
            reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          }
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason ?? new DOMException("aborted", "AbortError"),
              ),
            { once: true },
          );
        });
      }
      await sleep(fault.fallbackMs ?? 2_000);
      return new Response(
        "gateway timeout (fake fallback: caller passed no AbortSignal)",
        {
          status: 503,
        },
      );
    }
    case "net_error":
      throw new TypeError(
        fault.message ?? "error sending request: connection reset by peer",
      );
    case "latency":
      await sleep(fault.ms);
      return null;
    case "body_error": {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":"'));
          controller.error(new TypeError("body stream reset"));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    case "custom":
      return await fault.respond(request, body);
  }
}

/** Environment the edge function reads. `deno test` gives every test file its
 * own module graph but ONE process environment, so whatever this harness sets
 * would leak into the files that run after it (a 600 ms Auth deadline changes
 * the verdict of the network matrices) unless `restore()` puts it back. */
const ENV_OVERRIDES: Record<string, string | null> = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY: "anon-stress-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-stress-key",
  REVENUECAT_WEBHOOK_AUTH: "stress-webhook-secret",
  REVENUECAT_SECRET_API_KEY: "sk_test_stress",
  UPSTASH_REDIS_REST_URL: REDIS_URL,
  UPSTASH_REDIS_REST_TOKEN: REDIS_TOKEN,
  APPLE_SIGN_IN_CLIENT_ID: null,
  APPLE_SIGN_IN_TEAM_ID: null,
  APPLE_SIGN_IN_KEY_ID: null,
  APPLE_SIGN_IN_PRIVATE_KEY: null,
  APPLE_TOKEN_ENCRYPTION_KEY: null,
};

function applyEnv(values: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === null) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

function snapshotEnv(keys: string[]): Record<string, string | null> {
  return Object.fromEntries(
    keys.map((key) => [key, Deno.env.get(key) ?? null]),
  );
}

export async function loadStressHarness(): Promise<StressHarness> {
  if (harness) {
    harness.heal();
    harness.reset(true);
    harness.install();
    return harness;
  }

  const envKeys = [...Object.keys(ENV_OVERRIDES), "AUTH_UPSTREAM_TIMEOUT_MS"];
  const envBefore = snapshotEnv(envKeys);
  applyEnv(ENV_OVERRIDES);
  // Keep Auth timeouts short so hang/timeout cases finish quickly (the
  // production default is 6 000 ms; the ratio to Redis' fixed 1 200 ms is
  // what the timing cases reason about, and they read this value back).
  if (!Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS")) {
    Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "600");
  }
  const envInstalled = snapshotEnv(envKeys);

  const realFetch = globalThis.fetch;
  const realServe = Deno.serve;
  let seq = 0;
  let restoreLog: () => void = () => {};

  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    realFetch,
    realServe,
    calls: [],
    accessLog: [],
    users: new Map(),
    sessions: new Map(),
    redis: new Map(),
    redisCommands: [],
    tables: {},
    rpcs: {},
    subscriber: {},
    faults: new Map(),
    inject(upstream, fault, options = {}) {
      const list = state.faults.get(upstream) ?? [];
      list.push({
        fault,
        times: options.times,
        every: options.every,
        seen: 0,
        applied: 0,
      });
      state.faults.set(upstream, list);
    },
    heal(upstream) {
      if (upstream) state.faults.delete(upstream);
      else state.faults.clear();
    },
    reset(hard = false) {
      state.calls = [];
      state.accessLog = [];
      state.redisCommands = [];
      if (hard) {
        state.users = new Map();
        state.sessions = new Map();
        state.redis = new Map();
        state.tables = {};
        state.rpcs = {};
        state.subscriber = {};
      }
    },
    callsTo(upstream) {
      return state.calls.filter((call) => call.upstream === upstream);
    },
    callsSince(after) {
      return state.calls.filter((call) => call.seq > after);
    },
    lastSeq: () => seq,
    registerUser(user) {
      state.users.set(user.id, user);
      return user;
    },
    mintSession(userId, ttlSeconds = 3600, options = {}) {
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      const sessionId = options.sessionId ?? crypto.randomUUID();
      const accessToken = fakeJwt({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: userId,
        aud: "authenticated",
        role: "authenticated",
        session_id: sessionId,
        exp: expiresAt,
      });
      const session: FakeSession = {
        userId,
        accessToken,
        refreshToken: `rt-${crypto.randomUUID()}`,
        sessionId,
        expiresAt,
        revoked: false,
      };
      state.sessions.set(accessToken, session);
      return session;
    },
    install() {
      applyEnv(envInstalled);
      globalThis.fetch = fakeFetch;
      Deno.serve = fakeServe;
      restoreLog();
      restoreLog = captureAccessLog(pushAccessLine);
    },
    restore() {
      globalThis.fetch = realFetch;
      Deno.serve = realServe;
      restoreLog();
      restoreLog = () => {};
      applyEnv(envBefore);
    },
  };

  const pushAccessLine = (line: string) => {
    try {
      state.accessLog.push(JSON.parse(line) as AccessLine);
    } catch {
      // never a parse failure by contract; keep the raw line visible
      state.accessLog.push({
        evt: "unparseable",
        requestId: line,
        method: "",
        route: "",
        status: 0,
        durationMs: 0,
      });
    }
  };

  const sessionJson = (session: FakeSession, user: FakeUser) => ({
    access_token: session.accessToken,
    token_type: "bearer",
    expires_in: Math.max(1, session.expiresAt - Math.floor(Date.now() / 1000)),
    expires_at: session.expiresAt,
    refresh_token: session.refreshToken,
    user: gotrueUser(user),
  });

  const realAnswer = (
    upstream: Upstream | "unexpected",
    request: Request,
    headers: Record<string, string>,
    body: unknown,
  ): Response => {
    const url = request.url;
    const parsed = new URL(url);
    switch (upstream) {
      case "redis": {
        if (headers["authorization"] !== `Bearer ${REDIS_TOKEN}`) {
          return jsonResponse(401, { error: "Unauthorized" });
        }
        const commands = Array.isArray(body)
          ? (body as Array<Array<string | number>>)
          : [];
        for (const command of commands) state.redisCommands.push(command);
        return jsonResponse(
          200,
          commands.map((command) => runRedisCommand(state.redis, command)),
        );
      }
      case "auth_token": {
        const grant = parsed.searchParams.get("grant_type");
        const payload = isRecord(body) ? body : {};
        if (grant === "id_token") {
          const idToken = typeof payload.id_token === "string"
            ? payload.id_token
            : "";
          const claims = jwtPayload(idToken);
          const sub = typeof claims?.sub === "string" ? claims.sub : "";
          const provider =
            typeof claims?.iss === "string" && claims.iss.includes("apple")
              ? "apple"
              : "google";
          if (
            typeof claims?.exp === "number" && claims.exp * 1000 <= Date.now()
          ) {
            return jsonResponse(400, {
              error: "invalid_grant",
              error_description: "Token expired",
              error_code: "bad_id_token",
            });
          }
          if (!sub || payload.provider !== provider) {
            return jsonResponse(400, {
              error: "invalid_grant",
              error_description: "Bad ID token",
              error_code: "bad_id_token",
            });
          }
          // GoTrue creates the auth.users row on first sign-in.
          const user = state.users.get(sub) ??
            state.registerUser({
              id: sub,
              email: `${sub.slice(0, 8)}@example.com`,
              provider,
            });
          const session = state.mintSession(user.id);
          return jsonResponse(200, sessionJson(session, user));
        }
        return jsonResponse(400, { error: "unsupported_grant_type" });
      }
      case "auth_user": {
        const bearer = (headers["authorization"] ?? "").replace(
          /^Bearer\s+/i,
          "",
        );
        const session = state.sessions.get(bearer);
        if (!session || session.revoked) {
          return authError(401, "invalid JWT: session not found");
        }
        if (session.expiresAt * 1000 <= Date.now()) {
          return authError(401, "invalid JWT: token is expired");
        }
        const user = state.users.get(session.userId);
        if (!user) return authError(403, "user not found");
        return jsonResponse(200, gotrueUser(user));
      }
      case "auth_other":
        return new Response(null, { status: 204 });
      case "rest": {
        const table = parsed.pathname.slice("/rest/v1/".length);
        if (table.startsWith("rpc/")) {
          const fn = table.slice("rpc/".length);
          if (!(fn in state.rpcs)) {
            return jsonResponse(404, {
              code: "PGRST202",
              message: `rpc ${fn} not stubbed`,
            });
          }
          return jsonResponse(200, state.rpcs[fn]);
        }
        if (request.method === "GET") {
          const rows = state.tables[table] ?? [];
          if (
            (headers["accept"] ?? "").includes(
              "application/vnd.pgrst.object+json",
            )
          ) {
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
        return new Response(null, { status: 204 });
      }
      case "revenuecat":
        if (!state.subscriber) {
          return new Response("upstream error", { status: 500 });
        }
        return jsonResponse(200, {
          request_date_ms: Date.now(),
          subscriber: state.subscriber,
        });
      case "unexpected":
        return new Response(
          `unexpected fetch in stress test: ${request.method} ${url}`,
          {
            status: 599,
          },
        );
    }
  };

  const fakeFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const headers: Record<string, string> = {};
    request.headers.forEach((
      value,
      key,
    ) => (headers[key.toLowerCase()] = value));
    let body: unknown = null;
    const text = await request.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const upstream = classify(url, request.method);
    seq += 1;
    const record: RecordedCall = {
      seq,
      upstream,
      url,
      method: request.method,
      body,
      status: null,
      outcome: "answered",
      durationMs: 0,
    };
    state.calls.push(record);
    const startedAt = performance.now();
    const finish = (response: Response): Response => {
      record.status = response.status;
      record.durationMs = Math.round((performance.now() - startedAt) * 100) /
        100;
      return response;
    };

    const signal = init?.signal ??
      (input instanceof Request ? input.signal : undefined);
    try {
      if (upstream !== "unexpected") {
        for (const installed of state.faults.get(upstream) ?? []) {
          installed.seen += 1;
          if (
            installed.times !== undefined &&
            installed.applied >= installed.times
          ) continue;
          if (
            installed.every !== undefined &&
            installed.seen % installed.every !== 0
          ) continue;
          installed.applied += 1;
          record.outcome = installed.fault.kind === "latency"
            ? "answered"
            : "faulted";
          const response = await applyFault(
            installed.fault,
            request,
            body,
            signal,
          );
          if (response) return finish(response);
          break; // latency: fall through to the real answer (one delay per call)
        }
      }
      return finish(realAnswer(upstream, request, headers, body));
    } catch (error) {
      record.durationMs = Math.round((performance.now() - startedAt) * 100) /
        100;
      record.outcome = error instanceof DOMException || signal?.aborted
        ? "hung"
        : "net_error";
      throw error;
    }
  }) as typeof fetch;

  const fakeServe = ((...args: unknown[]) => {
    const captured = args.find((arg) => typeof arg === "function") as
      | ((request: Request) => Promise<Response>)
      | undefined;
    if (!captured) throw new Error("Deno.serve called without a handler");
    state.handler = captured;
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as ReturnType<typeof Deno.serve>;
  }) as typeof Deno.serve;

  state.install();
  await import("../index.ts");
  harness = state;
  return state;
}

/** A request to the edge function as the mobile app sends it (training/api.ts). */
export function edgeRequest(
  method: string,
  path: string,
  options: {
    token?: string | null;
    ip?: string;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers({
    Accept: "application/json",
    "x-forwarded-for": options.ip ?? "198.51.100.1",
    "X-Client-Version": "1.0.0",
    ...options.headers,
  });
  if (options.token !== null) {
    headers.set("Authorization", `Bearer ${options.token ?? ""}`);
  }
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(`http://edge.stress.test/functions/v1/api${path}`, {
    method,
    headers,
    body,
  });
}

export interface EdgeAnswer {
  status: number;
  body: unknown;
  rawBody: string;
  errorCode: string | null;
  errorMessage: string | null;
  headers: Record<string, string>;
  requestId: string | null;
  latencyMs: number;
  /** Upstream calls made while this request ran (sequential mode only). */
  calls: RecordedCall[];
  supabaseRoundTrips: number;
  redisRoundTrips: number;
}

/** Run one request through the real handler and read everything the app would. */
export async function callEdge(
  h: StressHarness,
  request: Request,
): Promise<EdgeAnswer> {
  const before = h.lastSeq();
  const startedAt = performance.now();
  const response = await h.handler(request);
  const rawBody = await response.text();
  const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
  let body: unknown = null;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    body = rawBody;
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((
    value,
    key,
  ) => (headers[key.toLowerCase()] = value));
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const calls = h.callsSince(before);
  return {
    status: response.status,
    body,
    rawBody,
    errorCode: error && typeof error.code === "string" ? error.code : null,
    errorMessage: error && typeof error.message === "string"
      ? error.message
      : null,
    headers,
    requestId: headers["x-request-id"] ?? null,
    latencyMs,
    calls,
    supabaseRoundTrips: calls.filter(
      (c) =>
        c.upstream === "auth_token" || c.upstream === "auth_user" ||
        c.upstream === "rest" ||
        c.upstream === "auth_other",
    ).length,
    redisRoundTrips: calls.filter((c) => c.upstream === "redis").length,
  };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}
