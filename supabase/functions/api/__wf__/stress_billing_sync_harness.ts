/**
 * stress_billing_sync_harness — failure-injection + load harness for the edge
 * route `POST /v1/billing/sync` (supabase/functions/api/index.ts).
 *
 * The REAL handler is booted in-process (Deno.serve captured, `../index.ts`
 * imported) with every upstream stubbed at the fetch layer:
 *
 *   - Supabase Auth (GoTrue `GET /auth/v1/user`) — minted session bearers
 *   - Supabase PostgREST — service-role `billing_entitlements` upsert and the
 *     user-scoped `access_state()` RPC, kept as STATE (a row per user), or
 *     forwarded to a real Postgres by stress_billing_sync_pg.test.ts
 *   - RevenueCat `GET /v1/subscribers/:id`
 *   - Upstash Redis REST `/pipeline` — a tiny real Redis (GET/SET EX/DEL/INCR/
 *     EXPIRE [NX]/TTL) so cache + rate-limit windows behave as with L2 on
 *
 * Each upstream can be put into a fault mode (HTTP status, network error,
 * hang-until-abort, emulated timeout, malformed body, arbitrary JSON, delay,
 * flaky-then-ok). Every upstream call is recorded with a timestamp so a
 * request's round trips can be attributed when requests run sequentially.
 *
 * `Deno.test` files sit next to this module: each Deno test FILE runs in its
 * own isolate, so the env below (Upstash configured, a short Auth deadline)
 * is private to the stress files and never leaks into the other suites.
 */

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "https://redis.stress.test";
export const ANON_KEY = "anon-stress-key";
export const SERVICE_ROLE_KEY = "service-role-stress-key";
export const RC_KEY = "sk_test_stress";
/** `AUTH_UPSTREAM_TIMEOUT_MS` is a documented env override (index.ts
 * authUpstreamTimeoutMs). 6 s in production; short here so the GoTrue
 * hang/timeout cases finish in the suite. RevenueCat's 10 s and Redis' 1.2 s
 * deadlines are hardcoded and exercised for real behind STRESS_SLOW=1. */
export const AUTH_TIMEOUT_MS = 400;

// ── Seeded PRNG (mulberry32) ────────────────────────────────────────────────

export class Prng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  hex(n: number): string {
    let out = "";
    for (let i = 0; i < n; i++) out += this.int(16).toString(16);
    return out;
  }
  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${
      h.slice(17, 20)
    }-${h.slice(20)}`;
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
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
/** Load-campaign request count (sequential phase). Small by default so the
 * file stays cheap in `deno task test`; the campaign runs STRESS_ITER=1500. */
export const STRESS_ITER = envInt("STRESS_ITER", 120);
/** Distinct users for the L1 memory campaign (20 000 in the campaign). */
export const STRESS_USERS = envInt("STRESS_USERS", 600);
export const STRESS_SLOW = Deno.env.get("STRESS_SLOW") === "1";

// ── Helpers ─────────────────────────────────────────────────────────────────

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function jwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Wait for `signal` to abort, then reject the way fetch does. When the
 * caller passed no signal (supabase-js PostgREST calls carry none), resolve
 * `fallback` after `releaseAfterMs` so the harness itself never deadlocks. */
function hangUntilAbort(
  signal: AbortSignal | null | undefined,
  releaseAfterMs: number,
  fallback: () => Response,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => resolve(fallback()), releaseAfterMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

// ── Fault model ─────────────────────────────────────────────────────────────

export type Fault =
  | {
    kind: "http";
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }
  | { kind: "raw"; status: number; text: string; contentType?: string }
  | { kind: "network"; message?: string }
  | { kind: "hang"; releaseAfterMs?: number }
  | { kind: "timeout-emulated"; afterMs?: number }
  | { kind: "delay"; ms: number }
  | { kind: "flaky"; failures: number; message?: string }
  | { kind: "json"; value: unknown; status?: number };

export type Upstream = "gotrue" | "rest.upsert" | "rest.rpc" | "rc" | "redis";

export interface UpstreamCall {
  t: number;
  upstream: Upstream;
  method: string;
  url: string;
  /** user id when the call is attributable (bearer sub / RC path / row) */
  user: string | null;
  fault: string | null;
  ms: number;
}

export interface UserState {
  id: string;
  provider: "google" | "apple";
  scoredCount: number;
  reservedCount: number;
  /** what RevenueCat says about this user */
  rc: RcState;
}

export type RcState =
  | { kind: "none" }
  | { kind: "active"; expiresAt: string; product: string; entitlement?: string }
  | { kind: "lapsed"; expiresAt: string; product: string }
  | { kind: "lifetime"; product: string }
  | { kind: "custom"; subscriber: unknown };

export interface BillingRow {
  user_id: string;
  premium: boolean;
  product_key: string | null;
  expires_at: string | null;
  verified_at: string;
}

/** A backend failure surfaced the way PostgREST reports a SQL error. */
export class BackendError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Result of a PostgREST call once translated by the state model (or by a
 * real Postgres in the pg test). */
export interface RestBackend {
  upsertBilling(row: BillingRow): Promise<void>;
  accessState(userId: string): Promise<{
    premium: boolean;
    scored_count: number;
    reserved_count: number;
  }>;
}

export class FakeWorld {
  readonly users = new Map<string, UserState>();
  readonly sessions = new Map<
    string,
    { userId: string; sessionId: string; exp: number }
  >();
  readonly billing = new Map<string, BillingRow>();
  readonly redis = new Map<string, { value: string; expiresAtMs: number }>();
  readonly calls: UpstreamCall[] = [];
  readonly counters: Record<string, number> = {};
  readonly faults: Partial<Record<Upstream, Fault>> = {};
  /** RC answers per call when set (takes precedence over user.rc). */
  rcOverride: ((userId: string, callIndex: number) => unknown) | null = null;
  /** Attempts seen per upstream (for flaky faults). */
  private attempts: Record<string, number> = {};
  private t0 = performance.now();
  backend: RestBackend;
  /** Total bytes of Redis values held (a proxy for the L2 footprint). */
  redisBytes = 0;

  constructor(backend?: RestBackend) {
    this.backend = backend ?? this.memoryBackend();
  }

  private memoryBackend(): RestBackend {
    return {
      upsertBilling: (row) => {
        this.billing.set(row.user_id, { ...row });
        return Promise.resolve();
      },
      accessState: (userId) => {
        const user = this.users.get(userId);
        const row = this.billing.get(userId);
        const premium = Boolean(
          row && row.premium &&
            (row.expires_at === null ||
              Date.parse(row.expires_at) > Date.now()),
        );
        return Promise.resolve({
          premium,
          scored_count: user?.scoredCount ?? 0,
          reserved_count: user?.reservedCount ?? 0,
        });
      },
    };
  }

  now(): number {
    return Math.round((performance.now() - this.t0) * 100) / 100;
  }

  count(name: string): void {
    this.counters[name] = (this.counters[name] ?? 0) + 1;
  }

  setFault(upstream: Upstream, fault: Fault | null): void {
    if (fault) this.faults[upstream] = fault;
    else delete this.faults[upstream];
    delete this.attempts[upstream];
  }

  clearFaults(): void {
    for (const key of Object.keys(this.faults) as Upstream[]) {
      delete this.faults[key];
    }
    this.attempts = {};
    this.rcOverride = null;
  }

  ensureUser(id: string, state: Partial<UserState> = {}): UserState {
    let user = this.users.get(id);
    if (!user) {
      user = {
        id,
        provider: "google",
        scoredCount: 0,
        reservedCount: 0,
        rc: { kind: "none" },
      };
      this.users.set(id, user);
    }
    Object.assign(user, state);
    return user;
  }

  /** A Supabase-issued access token (session bearer) for `userId`. */
  mintSession(userId: string, prng: Prng, expSeconds = 3600): string {
    const sessionId = `sess-${prng.uuid()}`;
    const exp = Math.floor(Date.now() / 1000) + expSeconds;
    const token = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${
      b64url(
        JSON.stringify({
          iss: `${SUPABASE_URL}/auth/v1`,
          sub: userId,
          aud: "authenticated",
          role: "authenticated",
          session_id: sessionId,
          exp,
          jti: prng.uuid(),
        }),
      )
    }.sig`;
    this.sessions.set(token, { userId, sessionId, exp });
    return token;
  }

  subscriberJson(user: UserState): unknown {
    const rc = user.rc;
    switch (rc.kind) {
      case "none":
        return { entitlements: {}, subscriptions: {} };
      case "active":
        return {
          entitlements: {
            [rc.entitlement ?? "pickle_sensei_pro"]: {
              expires_date: rc.expiresAt,
              product_identifier: rc.product,
              purchase_date: "2026-08-01T00:00:00Z",
            },
          },
        };
      case "lapsed":
        return {
          entitlements: {
            pickle_sensei_pro: {
              expires_date: rc.expiresAt,
              product_identifier: rc.product,
            },
          },
        };
      case "lifetime":
        return {
          entitlements: {
            pickle_sensei_pro: {
              expires_date: null,
              product_identifier: rc.product,
            },
          },
        };
      case "custom":
        return rc.subscriber;
    }
  }

  /** The premium verdict index.ts SHOULD reach for this user (the oracle). */
  expectedPremium(user: UserState): boolean {
    const sub = this.subscriberJson(user);
    if (!isRecord(sub) || !isRecord(sub.entitlements)) return false;
    for (const name of ["pickle_sensei_pro", "premium"]) {
      const e = sub.entitlements[name];
      if (!isRecord(e)) continue;
      const exp = e.expires_date;
      if (
        exp === null ||
        (typeof exp === "string" && Number.isFinite(Date.parse(exp)) &&
          Date.parse(exp) > Date.now())
      ) {
        return true;
      }
    }
    return false;
  }

  // ── fault application ─────────────────────────────────────────────────

  private async applyFault(
    upstream: Upstream,
    request: Request,
    ok: () => Promise<Response>,
  ): Promise<Response> {
    const fault = this.faults[upstream];
    if (!fault) return ok();
    switch (fault.kind) {
      case "http":
        return fault.body === undefined
          ? new Response(`stress fault ${fault.status}`, {
            status: fault.status,
            headers: fault.headers ?? {},
          })
          : jsonResponse(fault.status, fault.body, fault.headers ?? {});
      case "raw":
        return new Response(fault.text, {
          status: fault.status,
          headers: { "Content-Type": fault.contentType ?? "application/json" },
        });
      case "json":
        return jsonResponse(fault.status ?? 200, fault.value);
      case "network":
        throw new TypeError(
          fault.message ?? "stress: connection reset by peer",
        );
      case "hang":
        return hangUntilAbort(
          request.signal,
          fault.releaseAfterMs ?? 3_000,
          () => {
            // released without an abort: the caller has NO deadline on this path
            this.count(`${upstream}.hang_released_without_abort`);
            return new Response("stress: hang released", { status: 599 });
          },
        );
      case "timeout-emulated":
        await sleep(fault.afterMs ?? 15);
        throw new DOMException(
          "The operation timed out (stress emulated)",
          "TimeoutError",
        );
      case "delay":
        await sleep(fault.ms);
        return ok();
      case "flaky": {
        const n =
          (this.attempts[upstream] = (this.attempts[upstream] ?? 0) + 1);
        if (n <= fault.failures) {
          throw new TypeError(fault.message ?? `stress: flaky attempt ${n}`);
        }
        return ok();
      }
    }
  }

  // ── Redis (Upstash REST pipeline) ─────────────────────────────────────

  private redisGet(key: string): string | null {
    const entry = this.redis.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs !== Infinity && entry.expiresAtMs <= Date.now()) {
      this.redisBytes -= entry.value.length + key.length;
      this.redis.delete(key);
      return null;
    }
    return entry.value;
  }

  private redisSet(key: string, value: string, expiresAtMs: number): void {
    const prev = this.redis.get(key);
    if (prev) this.redisBytes -= prev.value.length + key.length;
    this.redis.set(key, { value, expiresAtMs });
    this.redisBytes += value.length + key.length;
  }

  redisExec(cmd: Array<string | number>): { result?: unknown; error?: string } {
    const op = String(cmd[0]).toUpperCase();
    const key = String(cmd[1] ?? "");
    switch (op) {
      case "GET":
        return { result: this.redisGet(key) };
      case "SET": {
        const value = String(cmd[2]);
        let expiresAtMs = Infinity;
        if (String(cmd[3] ?? "").toUpperCase() === "EX") {
          expiresAtMs = Date.now() + Number(cmd[4]) * 1000;
        }
        this.redisSet(key, value, expiresAtMs);
        return { result: "OK" };
      }
      case "DEL": {
        let n = 0;
        for (const k of cmd.slice(1)) {
          if (this.redis.delete(String(k))) n += 1;
        }
        return { result: n };
      }
      case "INCR": {
        const current = Number(this.redisGet(key) ?? "0");
        const next = current + 1;
        const prev = this.redis.get(key);
        this.redisSet(key, String(next), prev?.expiresAtMs ?? Infinity);
        return { result: next };
      }
      case "EXPIRE": {
        const entry = this.redis.get(key);
        if (!entry) return { result: 0 };
        const nx = String(cmd[3] ?? "").toUpperCase() === "NX";
        if (nx && entry.expiresAtMs !== Infinity) return { result: 0 };
        entry.expiresAtMs = Date.now() + Number(cmd[2]) * 1000;
        return { result: 1 };
      }
      case "TTL": {
        const value = this.redisGet(key);
        if (value === null) return { result: -2 };
        const entry = this.redis.get(key)!;
        if (entry.expiresAtMs === Infinity) return { result: -1 };
        return {
          result: Math.max(
            1,
            Math.ceil((entry.expiresAtMs - Date.now()) / 1000),
          ),
        };
      }
      default:
        return { error: `ERR unknown command '${op}'` };
    }
  }

  // ── the fetch double ──────────────────────────────────────────────────

  async handleFetch(request: Request, rawBody: string): Promise<Response> {
    const url = new URL(request.url);
    const started = performance.now();
    let upstream: Upstream;
    let user: string | null = null;
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }

    let run: () => Promise<Response>;
    if (url.origin === REDIS_URL) {
      upstream = "redis";
      run = () => {
        const commands = Array.isArray(body)
          ? (body as Array<Array<string | number>>)
          : [];
        return Promise.resolve(
          jsonResponse(200, commands.map((c) => this.redisExec(c))),
        );
      };
    } else if (url.hostname === "api.revenuecat.com") {
      upstream = "rc";
      const appUserId = decodeURIComponent(
        url.pathname.slice("/v1/subscribers/".length),
      );
      user = appUserId;
      run = () => {
        const u = this.users.get(appUserId);
        const idx = this.counters["rc"] ?? 0;
        const subscriber = this.rcOverride
          ? this.rcOverride(appUserId, idx)
          : this.subscriberJson(u ?? this.ensureUser(appUserId));
        return Promise.resolve(
          jsonResponse(200, { request_date_ms: Date.now(), subscriber }),
        );
      };
    } else if (
      url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user"
    ) {
      upstream = "gotrue";
      const auth = request.headers.get("authorization") ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const session = this.sessions.get(bearer);
      user = session?.userId ?? null;
      run = () => {
        if (!session) {
          return Promise.resolve(
            jsonResponse(403, {
              code: 403,
              error_code: "session_not_found",
              msg: "Session from session_id claim in JWT does not exist",
            }),
          );
        }
        const u = this.ensureUser(session.userId);
        return Promise.resolve(
          jsonResponse(200, {
            id: u.id,
            aud: "authenticated",
            role: "authenticated",
            email: `${u.id.slice(0, 8)}@example.com`,
            app_metadata: { provider: u.provider, providers: [u.provider] },
            user_metadata: {},
            created_at: new Date(0).toISOString(),
          }),
        );
      };
    } else if (
      url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")
    ) {
      const target = url.pathname.slice("/rest/v1/".length);
      const auth = request.headers.get("authorization") ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const isService = bearer === SERVICE_ROLE_KEY;
      const sub = isService
        ? null
        : (jwtPayload(bearer)?.sub as string | undefined) ?? null;
      if (target === "rpc/access_state") {
        upstream = "rest.rpc";
        user = sub;
        run = async () => {
          if (!sub) return jsonResponse(401, { message: "auth.required" });
          try {
            const row = await this.backend.accessState(sub);
            return jsonResponse(200, [row]);
          } catch (error) {
            if (error instanceof BackendError) {
              return jsonResponse(error.status, {
                code: error.code,
                message: error.message,
              });
            }
            throw error;
          }
        };
      } else if (
        target === "billing_entitlements" && request.method === "POST"
      ) {
        upstream = "rest.upsert";
        const rows = Array.isArray(body) ? body : [body];
        const first = isRecord(rows[0]) ? rows[0] : {};
        user = typeof first.user_id === "string" ? first.user_id : null;
        run = async () => {
          if (!isService) {
            return jsonResponse(401, {
              code: "42501",
              message: "permission denied (not service)",
            });
          }
          if (url.searchParams.get("on_conflict") !== "user_id") {
            return jsonResponse(409, {
              code: "23505",
              message: "duplicate key value",
            });
          }
          try {
            for (const raw of rows) {
              if (!isRecord(raw)) continue;
              await this.backend.upsertBilling({
                user_id: String(raw.user_id),
                premium: Boolean(raw.premium),
                product_key: typeof raw.product_key === "string"
                  ? raw.product_key
                  : null,
                expires_at: typeof raw.expires_at === "string"
                  ? raw.expires_at
                  : null,
                verified_at: String(raw.verified_at),
              });
            }
          } catch (error) {
            if (error instanceof BackendError) {
              return jsonResponse(error.status, {
                code: error.code,
                message: error.message,
              });
            }
            throw error;
          }
          return new Response(null, { status: 201 });
        };
      } else {
        this.count("rest.unmodelled");
        return jsonResponse(404, {
          code: "PGRST205",
          message: `stress: ${target} not modelled`,
        });
      }
    } else {
      this.count("fetch.unexpected");
      return new Response(
        `stress harness: unexpected fetch ${request.method} ${request.url}`,
        {
          status: 599,
        },
      );
    }

    this.count(upstream);
    const fault = this.faults[upstream];
    const record: UpstreamCall = {
      t: this.now(),
      upstream,
      method: request.method,
      url: request.url,
      user,
      fault: fault
        ? fault.kind + ("status" in fault ? `:${fault.status}` : "")
        : null,
      ms: 0,
    };
    this.calls.push(record);
    try {
      return await this.applyFault(upstream, request, run);
    } finally {
      record.ms = Math.round((performance.now() - started) * 100) / 100;
    }
  }
}

// ── Booting the real handler ────────────────────────────────────────────────

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  world: FakeWorld;
  accessLog: Array<Record<string, unknown>>;
  handlerLogs: string[];
}

let booted: StressHarness | null = null;

export async function bootStressHarness(
  backend?: RestBackend,
): Promise<StressHarness> {
  if (booted) return booted;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.delete("SB_PUBLISHABLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_SECRET_API_KEY", RC_KEY);
  Deno.env.delete("REVENUECAT_PUBLIC_SDK_KEY");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
  Deno.env.set("UPSTASH_REDIS_REST_TOKEN", "redis-stress-token");
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(AUTH_TIMEOUT_MS));
  for (
    const key of [
      "APPLE_SIGN_IN_CLIENT_ID",
      "APPLE_SIGN_IN_TEAM_ID",
      "APPLE_SIGN_IN_KEY_ID",
      "APPLE_SIGN_IN_PRIVATE_KEY",
      "APPLE_TOKEN_ENCRYPTION_KEY",
    ]
  ) {
    Deno.env.delete(key);
  }

  const world = new FakeWorld(backend);
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = await request.text().catch(() => "");
    return world.handleFetch(request, rawBody);
  }) as typeof fetch;

  const { captureAccessLog } = await import("../http.ts");
  const accessLog: Array<Record<string, unknown>> = [];
  captureAccessLog((line) => {
    try {
      accessLog.push(JSON.parse(line));
    } catch {
      accessLog.push({ raw: line });
    }
  });
  const handlerLogs: string[] = [];
  console.error = (...args: unknown[]) => {
    handlerLogs.push(`error: ${args.map(String).join(" ")}`);
  };
  console.warn = (...args: unknown[]) => {
    handlerLogs.push(`warn: ${args.map(String).join(" ")}`);
  };

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
  booted = { handler, world, accessLog, handlerLogs };
  return booted;
}

// ── Requests and the client-side oracle ─────────────────────────────────────

export function billingSyncRequest(token: string | null, ip: string): Request {
  const headers = new Headers({
    "x-forwarded-for": ip,
    Accept: "application/json",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return new Request(
    "http://edge.stress.test/functions/v1/api/v1/billing/sync",
    {
      method: "POST",
      headers,
    },
  );
}

export function accessRequest(token: string, ip: string): Request {
  return new Request("http://edge.stress.test/functions/v1/api/v1/me/access", {
    method: "GET",
    headers: { "x-forwarded-for": ip, Authorization: `Bearer ${token}` },
  });
}

export interface Outcome {
  status: number;
  code: string | null;
  message: string | null;
  retryAfter: string | null;
  requestId: string | null;
  body: unknown;
  /** how apps/mobile/src/billing/accessApi.ts classifies this answer */
  clientClass: ClientClass;
  /** parse errors the mobile client would raise on a 200 (empty = valid) */
  contractErrors: string[];
  latencyMs: number;
}

export type ClientClass =
  | "ok"
  | "invalid_response"
  | "signin_expired" // 401 → BillingError non-retryable, reportApiUnauthorized
  | "retryable_unavailable" // 5xx / 429
  | "terminal_unavailable"; // other 4xx

/** The exact arithmetic/type contract from apps/mobile/src/billing/accessApi.ts
 * (parseAccess + parseBilling + billing.premium === access.premium). */
export function clientContractErrors(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["body not an object"];
  const billing = value.billing;
  const access = value.access;
  const isInt = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v);
  const isIso = (v: unknown) =>
    typeof v === "string" && !Number.isNaN(Date.parse(v));
  if (!isRecord(billing)) errors.push("billing missing");
  else {
    if (typeof billing.premium !== "boolean") {
      errors.push("billing.premium not boolean");
    }
    if (
      !(billing.productKey === null || typeof billing.productKey === "string")
    ) {
      errors.push("billing.productKey");
    }
    if (!(billing.expiresAt === null || isIso(billing.expiresAt))) {
      errors.push("billing.expiresAt");
    }
    if (!isIso(billing.verifiedAt)) errors.push("billing.verifiedAt");
  }
  if (!isRecord(access) || !isRecord(access.freeRatings)) {
    errors.push("access/freeRatings missing");
    return errors;
  }
  const fr = access.freeRatings;
  if (typeof access.premium !== "boolean") {
    errors.push("access.premium not boolean");
  }
  if (
    !Array.isArray(access.entitlements) ||
    !access.entitlements.every((e) => typeof e === "string")
  ) {
    errors.push("entitlements not string[]");
  }
  if (typeof access.canStartRating !== "boolean") errors.push("canStartRating");
  if (typeof access.paywallRequired !== "boolean") {
    errors.push("paywallRequired");
  }
  if (fr.limit !== 2) errors.push("freeRatings.limit !== 2");
  for (const k of ["used", "reserved", "remaining", "availableToReserve"]) {
    if (!isInt(fr[k])) {
      errors.push(`freeRatings.${k} not integer (${JSON.stringify(fr[k])})`);
    }
  }
  if (errors.length) return errors;
  const used = fr.used as number;
  const reserved = fr.reserved as number;
  const remaining = fr.remaining as number;
  const available = fr.availableToReserve as number;
  const ent = access.entitlements as string[];
  const premiumEnt = ent.includes("premium");
  const expectedCanStart = (access.premium as boolean) || available > 0;
  if (used < 0 || used > 2) errors.push("used out of range");
  if (reserved < 0) errors.push("reserved < 0");
  if (remaining !== 2 - used) errors.push("remaining !== 2 - used");
  if (reserved > remaining) errors.push("reserved > remaining");
  if (available !== remaining - reserved) {
    errors.push("availableToReserve arithmetic");
  }
  if (access.premium !== premiumEnt) {
    errors.push("premium !== entitlements.includes('premium')");
  }
  if (access.canStartRating !== expectedCanStart) {
    errors.push("canStartRating inconsistent");
  }
  if (access.paywallRequired !== !expectedCanStart) {
    errors.push("paywallRequired inconsistent");
  }
  if (isRecord(billing) && billing.premium !== access.premium) {
    errors.push("billing.premium !== access.premium");
  }
  return errors;
}

export async function call(
  h: StressHarness,
  request: Request,
): Promise<Outcome> {
  const started = performance.now();
  const response = await h.handler(request);
  const latencyMs = Math.round((performance.now() - started) * 100) / 100;
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { _raw: text };
  }
  let code: string | null = null;
  let message: string | null = null;
  if (isRecord(body) && isRecord(body.error)) {
    code = typeof body.error.code === "string" ? body.error.code : null;
    message = typeof body.error.message === "string"
      ? body.error.message
      : null;
  }
  const contractErrors = response.status === 200
    ? clientContractErrors(body)
    : [];
  let clientClass: ClientClass;
  if (response.status === 200) {
    clientClass = contractErrors.length ? "invalid_response" : "ok";
  } else if (response.status === 401) clientClass = "signin_expired";
  else if (response.status >= 500 || response.status === 429) {
    clientClass = "retryable_unavailable";
  } else clientClass = "terminal_unavailable";
  return {
    status: response.status,
    code,
    message,
    retryAfter: response.headers.get("Retry-After"),
    requestId: response.headers.get("x-request-id"),
    body,
    clientClass,
    contractErrors,
    latencyMs,
  };
}

// ── Reporting ───────────────────────────────────────────────────────────────

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-billing-sync/latest/",
    import.meta.url,
  ).pathname;
}

export async function writeJson(name: string, value: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

export function latencySummary(values: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? NaN,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? NaN,
    mean: sorted.length
      ? Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 100) /
        100
      : NaN,
  };
}

export function histogram(
  values: Array<string | number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export function heapNow(): Deno.MemoryUsage {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
  return Deno.memoryUsage();
}

/** Deterministic, unique IPs (keeps per-IP budgets from coupling cases). */
export function ipFor(n: number): string {
  const a = 10 + Math.floor(n / 65536);
  const b = Math.floor(n / 256) % 256;
  const c = n % 256;
  return `${a}.${b}.${c}.1`;
}
