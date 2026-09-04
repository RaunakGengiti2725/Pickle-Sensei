// Stress harness for `POST /v1/me/delete-confirm` (lens: failure-load).
//
// Boots the REAL edge handler (../index.ts) in-process by capturing
// Deno.serve, and routes every outbound fetch the handler makes — Supabase
// Auth (GET /auth/v1/user, DELETE /auth/v1/admin/users/:id), PostgREST
// (/rest/v1/*), Upstash REST (/pipeline), RevenueCat and Apple — into one
// in-memory fake with per-upstream FAULT INJECTION (HTTP status, rejected
// socket, hang honouring/ignoring the caller's AbortSignal, malformed body).
// No real server, no hosted project, no network.
//
// Every upstream call is recorded (upstream, method, path, latency, whether
// the caller passed an AbortSignal) so round trips per request and
// boundedness can be asserted. Everything is seeded (Prng) so a scenario is
// replayable from `STRESS_SEED` + its case id (`STRESS_ONLY`).
//
// Env read at module load in cache.ts/index.ts means ONE configuration per
// test FILE (deno test runs each module in its own isolate):
//   stress_delete_confirm_failure_load.test.ts → Redis (fake Upstash) ON
//   stress_delete_confirm_memory.test.ts       → Redis OFF (per-isolate L1 only)

import { encryptAppleRefreshToken } from "../externalAccounts.ts";

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "https://upstash.stress.test";
export const REDIS_TOKEN = "stress-upstash-token";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
export const ANON_KEY = "stress-anon-key";
export const SERVICE_ROLE_KEY = "stress-service-role-key";
export const RC_SECRET = "sk_stress_revenuecat";
/** Auth round-trip deadline used by the harness (production default 6 000 ms)
 * so hang/reject cases finish in about a second. Read by index.ts. */
export const AUTH_TIMEOUT_MS = 1_000;

export type Upstream = "auth" | "auth_admin" | "postgrest" | "upstash" | "revenuecat" | "apple";

export interface CallRecord {
  seq: number;
  upstream: Upstream;
  method: string;
  path: string;
  /** PostgREST table / RPC name, Upstash command names, or "" */
  detail: string;
  startedMs: number;
  endedMs: number;
  status: number | null;
  error: string | null;
  hadSignal: boolean;
  faulted: string | null;
}

export interface CallInfo {
  upstream: Upstream;
  method: string;
  url: URL;
  request: Request;
  /** 1-based occurrence of a call matching this fault's selector. */
  occurrence: number;
}

export interface FaultSpec {
  id: string;
  upstream: Upstream;
  /** Narrow the selector (table name, path fragment, command…). */
  match?: (info: CallInfo) => boolean;
  /** Affect only this occurrence (1-based) of matching calls; default every. */
  nth?: number;
  /** Return a Response, or throw to emulate a socket failure. Receives the
   * original request so a fault can delegate to the fake (`pass`). */
  respond: (info: CallInfo, pass: () => Promise<Response>) => Promise<Response>;
  /** Internal: how many matching calls have been seen. */
  seen?: number;
}

export interface DeletionRow {
  user_id: string;
  challenge: string;
  created_at: string;
  expires_at: string;
}

export interface ExternalRow {
  user_id: string;
  apple_refresh_token_encrypted: string | null;
  apple_token_captured_at: string | null;
  apple_revoked_at: string | null;
  revenuecat_deleted_at: string | null;
  updated_at: string;
}

export interface FakeUser {
  id: string;
  email: string;
  provider: "apple" | "google";
}

export interface RedisEntry {
  value: string;
  expiresAtMs: number | null;
}

export interface Harness {
  handler: (request: Request) => Promise<Response>;
  users: Map<string, FakeUser>;
  deletionRows: Map<string, DeletionRow>;
  externalRows: Map<string, ExternalRow>;
  revenueCatSubscribers: Set<string>;
  redis: Map<string, RedisEntry>;
  calls: CallRecord[];
  faults: FaultSpec[];
  appleTokenEncryptionKey: string;
  /** Milliseconds a `hang` fault waits before answering (if not aborted). */
  hangMs: number;
  /** Simulated network latency per upstream call (seeded uniform range,
   * real timer). Without it every fake answers inside the same microtask
   * turn and concurrent requests never interleave the way they do against
   * real sockets. `null` disables. */
  upstreamLatencyMs: { min: number; max: number } | null;
  /** Keep per-call records in `calls` (disable for memory campaigns so the
   * harness's own bookkeeping does not show up in the heap). */
  recordCalls: boolean;
  /** Register a user (Auth answers for its bearer). */
  addUser(user: FakeUser): void;
  /** A pending deletion challenge for the user, created `ageMs` ago. */
  addDeletionRow(userId: string, challenge: string, ageMs: number, ttlMs?: number): DeletionRow;
  addExternalRow(row: Partial<ExternalRow> & { user_id: string }): ExternalRow;
  /** Encrypt a fake Apple refresh token for `userId` under the live key (or `key`). */
  appleCiphertext(userId: string, key?: string): Promise<string>;
  /** Supabase session bearer for the user (unsigned; the handler only decodes it). */
  bearer(userId: string, sessionId: string, expSeconds?: number): string;
  request(
    path: string,
    init: { bearer: string; ip: string; body?: unknown; method?: string },
  ): Request;
  callsSince(seq: number): CallRecord[];
  countBy(records: CallRecord[]): Record<Upstream, number>;
  resetFaults(): void;
  resetState(): void;
  /** Hand `globalThis.fetch` and the env back to whatever was installed before
   * this harness (every `__wf__` module shares one isolate under
   * `deno task test`). `loadStressHarness()` re-attaches. */
  detach(): void;
}

// ─── Seeded RNG (xorshift32, same construction as xc_concurrency_harness) ───

export class Prng {
  private state: number;
  constructor(public readonly seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x / 0x1_0000_0000;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  hex(n: number): string {
    let out = "";
    for (let i = 0; i < n; i++) out += this.int(0, 15).toString(16);
    return out;
  }
  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${
      (8 + this.int(0, 3)).toString(16)
    }${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
  ip(): string {
    return `${this.int(1, 223)}.${this.int(0, 255)}.${this.int(0, 255)}.${this.int(1, 254)}`;
  }
}

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-delete-confirm/latest/", import.meta.url).pathname;
}

export async function writeJson(name: string, value: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function latencySummary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    n: sorted.length,
    min: r(sorted[0] ?? NaN),
    p50: r(percentile(sorted, 50)),
    p90: r(percentile(sorted, 90)),
    p95: r(percentile(sorted, 95)),
    p99: r(percentile(sorted, 99)),
    max: r(sorted[sorted.length - 1] ?? NaN),
    mean: r(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)),
  };
}

// ─── JWT-shaped tokens (unsigned: the handler decodes, Supabase verifies) ────

const b64url = (input: string): string =>
  btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodePayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

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
  const encoded = bytesToBase64(pkcs8).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
}

// ─── Fault helpers ───────────────────────────────────────────────────────────

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

export const fault = {
  http(
    id: string,
    upstream: Upstream,
    status: number,
    body: unknown = { message: "injected" },
    opts: { headers?: Record<string, string>; match?: FaultSpec["match"]; nth?: number } = {},
  ): FaultSpec {
    return {
      id,
      upstream,
      match: opts.match,
      nth: opts.nth,
      respond: () => Promise.resolve(jsonResponse(status, body, opts.headers)),
    };
  },
  /** Raw (possibly non-JSON) body with an explicit status. */
  raw(
    id: string,
    upstream: Upstream,
    status: number,
    text: string,
    opts: { contentType?: string; match?: FaultSpec["match"]; nth?: number } = {},
  ): FaultSpec {
    return {
      id,
      upstream,
      match: opts.match,
      nth: opts.nth,
      respond: () =>
        Promise.resolve(
          new Response(text, {
            status,
            headers: { "Content-Type": opts.contentType ?? "application/json" },
          }),
        ),
    };
  },
  /** Socket-level failure: fetch rejects with a TypeError like Deno does. */
  reject(
    id: string,
    upstream: Upstream,
    opts: { match?: FaultSpec["match"]; nth?: number; message?: string } = {},
  ): FaultSpec {
    return {
      id,
      upstream,
      match: opts.match,
      nth: opts.nth,
      respond: () =>
        Promise.reject(new TypeError(opts.message ?? "error sending request: connection reset")),
    };
  },
  /** Stall. `honorAbort` rejects when the caller's signal fires; otherwise the
   * stub answers (via `pass`) after `hangMs`, whatever the caller did. */
  hang(
    id: string,
    upstream: Upstream,
    hangMs: number,
    opts: { honorAbort?: boolean; match?: FaultSpec["match"]; nth?: number } = {},
  ): FaultSpec {
    const honorAbort = opts.honorAbort ?? true;
    return {
      id,
      upstream,
      match: opts.match,
      nth: opts.nth,
      respond: (info, pass) =>
        new Promise<Response>((resolve, reject) => {
          const signal = info.request.signal;
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            pass().then(resolve, reject);
          }, hangMs);
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          };
          if (honorAbort) {
            if (signal.aborted) return onAbort();
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }),
    };
  },
};

export const match = {
  table: (name: string) => (info: CallInfo) => info.url.pathname === `/rest/v1/${name}`,
  method: (m: string) => (info: CallInfo) => info.method === m,
  tableMethod: (name: string, m: string) => (info: CallInfo) =>
    info.url.pathname === `/rest/v1/${name}` && info.method === m,
  /** Upstash pipeline whose command list includes `command` (e.g. "SET"). */
  redisCommand: (command: string, keyFragment?: string) => (info: CallInfo) => {
    const cmds = (info as CallInfo & { commands?: Array<Array<string | number>> }).commands ?? [];
    return cmds.some(
      (c) =>
        String(c[0]).toUpperCase() === command &&
        (keyFragment === undefined || String(c[1] ?? "").includes(keyFragment)),
    );
  },
};

// ─── Fake Redis (Upstash REST /pipeline) ────────────────────────────────────

function redisLive(store: Map<string, RedisEntry>, key: string): RedisEntry | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry;
}

export function runRedisCommand(
  store: Map<string, RedisEntry>,
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
      return { result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1_000)) };
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
      store.set(args[0], { value: String(next), expiresAtMs: entry?.expiresAtMs ?? null });
      return { result: next };
    }
    case "EXPIRE": {
      const [key, seconds, flag] = args;
      const entry = redisLive(store, key);
      if (!entry) return { result: 0 };
      if (flag && flag.toUpperCase() === "NX" && entry.expiresAtMs !== null) return { result: 0 };
      entry.expiresAtMs = Date.now() + Number(seconds) * 1_000;
      return { result: 1 };
    }
    default:
      return { error: `ERR unknown command '${name}'` };
  }
}

// ─── The fake upstreams ─────────────────────────────────────────────────────

let loaded: Harness | null = null;
let attach: (() => void) | null = null;

const ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SB_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "REVENUECAT_WEBHOOK_AUTH",
  "REVENUECAT_SECRET_API_KEY",
  "APPLE_SIGN_IN_CLIENT_ID",
  "APPLE_SIGN_IN_TEAM_ID",
  "APPLE_SIGN_IN_KEY_ID",
  "APPLE_SIGN_IN_PRIVATE_KEY",
  "APPLE_TOKEN_ENCRYPTION_KEY",
  "AUTH_UPSTREAM_TIMEOUT_MS",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

function snapshotEnv(): Map<string, string | undefined> {
  return new Map(ENV_KEYS.map((k) => [k, Deno.env.get(k)] as const));
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [k, v] of snapshot) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
}

function upstreamOf(url: URL): Upstream | null {
  if (url.origin === SUPABASE_URL) {
    if (url.pathname.startsWith("/auth/v1/admin/")) return "auth_admin";
    if (url.pathname.startsWith("/auth/v1/")) return "auth";
    if (url.pathname.startsWith("/rest/v1/")) return "postgrest";
    return null;
  }
  if (url.origin === REDIS_URL) return "upstash";
  if (`${url.origin}${url.pathname}`.startsWith(RC_URL)) return "revenuecat";
  if (`${url.origin}${url.pathname}` === APPLE_REVOKE_URL) return "apple";
  return null;
}

function eqFilter(url: URL, column: string): string | null {
  const raw = url.searchParams.get(column);
  return raw && raw.startsWith("eq.") ? raw.slice(3) : null;
}

/** Boots (once per isolate) and returns the harness. `redis` is fixed by the
 * FIRST call: cache.ts reads UPSTASH_* at module load, and `deno test` runs
 * every test module in one isolate — later callers get the first mode and
 * must fault Upstash to exercise the local fallback. */
export async function loadStressHarness(options: { redis: boolean }): Promise<Harness> {
  if (loaded && attach) {
    attach();
    loaded.resetFaults();
    loaded.resetState();
    loaded.upstreamLatencyMs = { min: 1, max: 3 };
    loaded.recordCalls = true;
    return loaded;
  }

  const outerEnv = snapshotEnv();
  const appleTokenEncryptionKey = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.delete("SB_PUBLISHABLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", RC_SECRET);
  Deno.env.set("APPLE_SIGN_IN_CLIENT_ID", "com.picklesensei");
  Deno.env.set("APPLE_SIGN_IN_TEAM_ID", "TEAMID1234");
  Deno.env.set("APPLE_SIGN_IN_KEY_ID", "KEYID12345");
  Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", await testApplePrivateKeyPem());
  Deno.env.set("APPLE_TOKEN_ENCRYPTION_KEY", appleTokenEncryptionKey);
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(AUTH_TIMEOUT_MS));
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }
  const harnessEnv = snapshotEnv();

  const state = {
    users: new Map<string, FakeUser>(),
    deletionRows: new Map<string, DeletionRow>(),
    externalRows: new Map<string, ExternalRow>(),
    revenueCatSubscribers: new Set<string>(),
    redis: new Map<string, RedisEntry>(),
    calls: [] as CallRecord[],
    faults: [] as FaultSpec[],
  };
  let seq = 0;
  const latencyPrng = new Prng(fnv1a(`${STRESS_SEED}:upstream-latency`));

  const fakeAuth = (request: Request, url: URL): Response => {
    if (request.method === "GET" && url.pathname === "/auth/v1/user") {
      const authorization = request.headers.get("Authorization") ?? "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      const payload = decodePayload(token);
      const sub = typeof payload?.sub === "string" ? payload.sub : "";
      const user = state.users.get(sub);
      if (!user) {
        return jsonResponse(403, {
          code: 403,
          error_code: "user_not_found",
          msg: "User from sub claim in JWT does not exist",
        });
      }
      return jsonResponse(200, {
        id: user.id,
        aud: "authenticated",
        role: "authenticated",
        email: user.email,
        app_metadata: { provider: user.provider, providers: [user.provider] },
      });
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/auth/v1/admin/users/")) {
      if (request.headers.get("Authorization") !== `Bearer ${SERVICE_ROLE_KEY}`) {
        return jsonResponse(403, { code: 403, error_code: "bad_jwt", msg: "not admin" });
      }
      const id = url.pathname.slice("/auth/v1/admin/users/".length);
      if (!state.users.has(id)) {
        return jsonResponse(404, { code: 404, error_code: "user_not_found", msg: "User not found" });
      }
      // auth.users cascade → profiles → deletion request / external credentials.
      state.users.delete(id);
      state.deletionRows.delete(id);
      state.externalRows.delete(id);
      return jsonResponse(200, {});
    }
    return jsonResponse(404, { msg: `stress fake auth: unhandled ${request.method} ${url.pathname}` });
  };

  const wantsObject = (request: Request) =>
    (request.headers.get("Accept") ?? "").includes("application/vnd.pgrst.object+json");

  const rows = (request: Request, list: unknown[]): Response => {
    if (wantsObject(request)) {
      if (list.length === 1) return jsonResponse(200, list[0]);
      return jsonResponse(406, {
        code: "PGRST116",
        details: `Results contain ${list.length} rows`,
        message: "JSON object requested, multiple (or no) rows returned",
      });
    }
    return jsonResponse(200, list);
  };

  const fakePostgrest = async (request: Request, url: URL): Promise<Response> => {
    const table = url.pathname.slice("/rest/v1/".length);
    const userId = eqFilter(url, "user_id");
    if (table === "account_deletion_requests") {
      if (request.method === "GET") {
        const row = userId ? state.deletionRows.get(userId) : undefined;
        return rows(request, row ? [{ challenge: row.challenge, created_at: row.created_at, expires_at: row.expires_at }] : []);
      }
      if (request.method === "POST") {
        const body = (await request.json()) as DeletionRow;
        if (!state.users.has(body.user_id)) return fkViolation("account_deletion_requests");
        state.deletionRows.set(body.user_id, body);
        return new Response(null, { status: 201 });
      }
    }
    if (table === "account_external_credentials") {
      if (request.headers.get("Authorization") !== `Bearer ${SERVICE_ROLE_KEY}`) {
        return jsonResponse(401, { code: "42501", message: "permission denied" });
      }
      if (request.method === "GET") {
        const row = userId ? state.externalRows.get(userId) : undefined;
        return rows(
          request,
          row
            ? [
                {
                  apple_refresh_token_encrypted: row.apple_refresh_token_encrypted,
                  apple_revoked_at: row.apple_revoked_at,
                  revenuecat_deleted_at: row.revenuecat_deleted_at,
                },
              ]
            : [],
        );
      }
      if (request.method === "PATCH") {
        const patch = (await request.json()) as Partial<ExternalRow>;
        const row = userId ? state.externalRows.get(userId) : undefined;
        if (row) Object.assign(row, patch);
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST") {
        const body = (await request.json()) as Partial<ExternalRow> & { user_id: string };
        const existing = state.externalRows.get(body.user_id);
        if (existing) Object.assign(existing, body);
        else {
          if (!state.users.has(body.user_id)) return fkViolation("account_external_credentials");
          state.externalRows.set(body.user_id, {
            apple_refresh_token_encrypted: null,
            apple_token_captured_at: null,
            apple_revoked_at: null,
            revenuecat_deleted_at: null,
            updated_at: new Date().toISOString(),
            ...body,
          });
        }
        return new Response(null, { status: 201 });
      }
    }
    return jsonResponse(404, { message: `stress fake postgrest: unhandled ${request.method} ${table}` });
  };

  /** Both tables reference profiles(id) (cascaded from auth.users): an insert
   * for a deleted user is PostgREST 409 / SQLSTATE 23503 (verified on
   * postgres:16 by stress_delete_confirm_pg.test.ts PGD2). */
  const fkViolation = (table: string) =>
    jsonResponse(409, {
      code: "23503",
      details: `Key is not present in table "profiles".`,
      hint: null,
      message: `insert or update on table "${table}" violates foreign key constraint "${table}_user_id_fkey"`,
    });

  const fakeRedis = async (request: Request): Promise<Response> => {
    const commands = JSON.parse(await request.text()) as Array<Array<string | number>>;
    return jsonResponse(
      200,
      commands.map((cmd) => runRedisCommand(state.redis, cmd)),
    );
  };

  const fakeRevenueCat = (request: Request, url: URL): Response => {
    if (request.method !== "DELETE") return jsonResponse(405, {});
    if (request.headers.get("Authorization") !== `Bearer ${RC_SECRET}`) {
      return jsonResponse(401, { code: 7225, message: "Invalid API key" });
    }
    const id = decodeURIComponent(url.pathname.slice("/v1/subscribers/".length));
    if (!state.revenueCatSubscribers.delete(id)) {
      return jsonResponse(404, { code: 7259, message: "Couldn't find subscriber" });
    }
    return jsonResponse(200, { app_user_id: id, deleted: true });
  };

  const fakeApple = (request: Request): Response => {
    if (request.method !== "POST") return jsonResponse(405, {});
    return new Response(null, { status: 200 });
  };

  const dispatch = (request: Request, url: URL, upstream: Upstream): Promise<Response> => {
    switch (upstream) {
      case "auth":
      case "auth_admin":
        return Promise.resolve(fakeAuth(request, url));
      case "postgrest":
        return fakePostgrest(request, url);
      case "upstash":
        return fakeRedis(request);
      case "revenuecat":
        return Promise.resolve(fakeRevenueCat(request, url));
      case "apple":
        return Promise.resolve(fakeApple(request));
    }
  };

  const outerFetch = globalThis.fetch;
  const harnessFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const upstream = upstreamOf(url);
    if (!upstream) {
      throw new TypeError(`stress harness: unexpected outbound fetch ${request.method} ${url.href}`);
    }
    const record: CallRecord = {
      seq: ++seq,
      upstream,
      method: request.method,
      path: url.pathname,
      detail: upstream === "postgrest" ? url.pathname.slice("/rest/v1/".length) : "",
      startedMs: performance.now(),
      endedMs: 0,
      status: null,
      error: null,
      hadSignal: Boolean(init?.signal) || (input instanceof Request && Boolean(input.signal)),
      faulted: null,
    };
    if (harness.recordCalls) state.calls.push(record);
    // The body is consumed by whichever branch answers; clone for the fake.
    const forFake = request.clone();
    const info: CallInfo & { commands?: Array<Array<string | number>> } = {
      upstream,
      method: request.method,
      url,
      request,
      occurrence: 0,
    };
    if (upstream === "upstash") {
      try {
        info.commands = JSON.parse(await request.clone().text());
        record.detail = (info.commands ?? []).map((c) => String(c[0])).join(",");
      } catch {
        record.detail = "?";
      }
    }
    const pass = () => dispatch(forFake, url, upstream);
    try {
      const latency = harness.upstreamLatencyMs;
      if (latency) {
        await new Promise((resolve) => setTimeout(resolve, latencyPrng.int(latency.min, latency.max)));
      }
      let response: Response | null = null;
      for (const spec of state.faults) {
        if (spec.upstream !== upstream) continue;
        if (spec.match && !spec.match(info)) continue;
        spec.seen = (spec.seen ?? 0) + 1;
        if (spec.nth !== undefined && spec.seen !== spec.nth) continue;
        info.occurrence = spec.seen;
        record.faulted = spec.id;
        response = await spec.respond(info, pass);
        break;
      }
      if (!response) response = await pass();
      record.status = response.status;
      record.endedMs = performance.now();
      return response;
    } catch (error) {
      record.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      record.endedMs = performance.now();
      throw error;
    }
  }) as typeof fetch;
  globalThis.fetch = harnessFetch;

  type Handler = (request: Request) => Promise<Response> | Response;
  let handler: Handler | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    handler = (typeof args[0] === "function" ? args[0] : args[1]) as Handler;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) throw new Error("index.ts did not register a Deno.serve handler");
  const captured: Handler = handler;

  const harness: Harness = {
    handler: (request) => Promise.resolve(captured(request)),
    ...state,
    appleTokenEncryptionKey,
    hangMs: 1_500,
    upstreamLatencyMs: { min: 1, max: 3 },
    recordCalls: true,
    addUser(user) {
      state.users.set(user.id, user);
      state.revenueCatSubscribers.add(user.id);
    },
    addDeletionRow(userId, challenge, ageMs, ttlMs = 15 * 60_000) {
      const row: DeletionRow = {
        user_id: userId,
        challenge,
        created_at: new Date(Date.now() - ageMs).toISOString(),
        expires_at: new Date(Date.now() - ageMs + ttlMs).toISOString(),
      };
      state.deletionRows.set(userId, row);
      return row;
    },
    addExternalRow(partial) {
      const row: ExternalRow = {
        apple_refresh_token_encrypted: null,
        apple_token_captured_at: null,
        apple_revoked_at: null,
        revenuecat_deleted_at: null,
        updated_at: new Date().toISOString(),
        ...partial,
      };
      state.externalRows.set(row.user_id, row);
      return row;
    },
    appleCiphertext(userId, key) {
      return encryptAppleRefreshToken(`apple-refresh-${userId}`, userId, key ?? appleTokenEncryptionKey);
    },
    bearer(userId, sessionId, expSeconds = Math.floor(Date.now() / 1000) + 3_600) {
      const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const payload = b64url(
        JSON.stringify({
          iss: `${SUPABASE_URL}/auth/v1`,
          sub: userId,
          aud: "authenticated",
          role: "authenticated",
          session_id: sessionId,
          exp: expSeconds,
        }),
      );
      return `${header}.${payload}.stress-sig`;
    },
    request(path, init) {
      return new Request(`http://edge.local/functions/v1/api${path}`, {
        method: init.method ?? "POST",
        headers: {
          Authorization: `Bearer ${init.bearer}`,
          "Content-Type": "application/json",
          "x-forwarded-for": init.ip,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    },
    callsSince(fromSeq) {
      return state.calls.filter((c) => c.seq > fromSeq);
    },
    countBy(records) {
      const out: Record<Upstream, number> = {
        auth: 0,
        auth_admin: 0,
        postgrest: 0,
        upstash: 0,
        revenuecat: 0,
        apple: 0,
      };
      for (const r of records) out[r.upstream] += 1;
      return out;
    },
    resetFaults() {
      state.faults.length = 0;
    },
    resetState() {
      state.users.clear();
      state.deletionRows.clear();
      state.externalRows.clear();
      state.revenueCatSubscribers.clear();
      state.redis.clear();
      state.calls.length = 0;
    },
    detach() {
      globalThis.fetch = outerFetch;
      restoreEnv(outerEnv);
    },
  };
  attach = () => {
    globalThis.fetch = harnessFetch;
    restoreEnv(harnessEnv);
  };
  loaded = harness;
  return harness;
}
