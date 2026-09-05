// stress — programmable upstream fake for the REAL edge handler (../index.ts,
// Deno.serve captured), built for the failure-injection + load lens on
// DELETE /v1/me/saved-drills/:slug.
//
// Every outbound fetch the handler makes is classified into one of the
// upstream TARGETS below and answered by an in-memory model:
//
//   auth_user    GET  {SUPABASE_URL}/auth/v1/user               (session bearer verification)
//   auth_token   POST {SUPABASE_URL}/auth/v1/token?grant_type=…  (transitional provider ID token)
//   rest_delete  DELETE {SUPABASE_URL}/rest/v1/user_saved_drills (the route's one DB write)
//   rest_other   any other PostgREST call
//   redis        POST {UPSTASH_REDIS_REST_URL}/pipeline          (cache.ts L2 / rate limits)
//   rc           https://api.revenuecat.com/…                    (never expected on this route)
//
// A FAULT can be armed against exactly one target. Faults are data
// (`FaultMode`), so a scenario is fully described by (seed, fault) and every
// row of a campaign JSON table replays with the printed command.
//
// Env is read once per module graph (cache.ts), so Redis on/off is a
// per-test-FILE decision: call `loadStressHarness({ redis: true })` in a file
// that wants L2 and `{ redis: false }` in one that does not.

export const SUPABASE_URL = "http://supabase.stress.test";
export const ANON_KEY = "stress-anon-key";
export const SERVICE_ROLE_KEY = "stress-service-role-key";
export const REDIS_URL = "https://fake-upstash.stress.test";
export const REDIS_TOKEN = "stress-redis-token";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";

export type Target = "auth_user" | "auth_token" | "rest_delete" | "rest_other" | "redis" | "rc";

export type FaultMode =
  /** Answer with this HTTP status/body (optionally after a delay). */
  | {
      kind: "http";
      status: number;
      body: string;
      headers?: Record<string, string>;
      delayMs?: number;
    }
  /** fetch() rejects (connection refused / reset / DNS). */
  | { kind: "throw"; message?: string }
  /** Never answer; reject only when the caller's AbortSignal fires. */
  | { kind: "hang" }
  /** Status line + headers arrive, then the body stream errors mid-flight. */
  | { kind: "stream_error"; status: number }
  /** Answer correctly but slowly. */
  | { kind: "slow"; delayMs: number };

export interface Fault {
  target: Target;
  mode: FaultMode;
  /** Apply only to the first N matching calls (default: every call). */
  firstN?: number;
}

export interface UpstreamCall {
  n: number;
  t: number;
  target: Target;
  method: string;
  url: string;
  faulted: boolean;
  status: number | "throw" | "hang" | "stream_error";
  durationMs: number;
}

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

/** mulberry32 — deterministic, replayable. */
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
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  slug(): string {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const len = this.int(4, 24);
    let out = alphabet[this.int(0, 25)];
    for (let i = 1; i < len; i++) out += this.pick([...alphabet, "-", "_"]);
    return out;
  }
  ip(): string {
    return `10.${this.int(0, 255)}.${this.int(0, 255)}.${this.int(1, 254)}`;
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

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// ── Upstream model ───────────────────────────────────────────────────────────

export interface FakeUser {
  id: string;
  provider: "google" | "apple";
  email: string;
}

export class FakeUpstream {
  /** Supabase session access token → user. */
  sessions = new Map<string, FakeUser>();
  /** Provider ID token subject → user (transitional signInWithIdToken path). */
  providerUsers = new Map<string, FakeUser>();
  /** user_saved_drills rows as `${user_id}|${slug}`. */
  savedDrills = new Set<string>();
  /** Every PostgREST DELETE filter the handler sent, decoded. */
  deleteFilters: Array<{ user_id: string | null; slug: string | null; bearerSub: string | null }> =
    [];
  redis = new Map<string, { value: string; expiresAtMs: number | null }>();
  redisCommands: Array<Array<string | number>> = [];
  calls: UpstreamCall[] = [];
  fault: Fault | null = null;
  private faultHits = 0;
  private t0 = performance.now();
  private mint = 0;

  reset(): void {
    this.fault = null;
    this.faultHits = 0;
    this.calls = [];
    this.deleteFilters = [];
    this.redisCommands = [];
  }

  arm(fault: Fault | null): void {
    this.fault = fault;
    this.faultHits = 0;
  }

  callsTo(target: Target): UpstreamCall[] {
    return this.calls.filter((c) => c.target === target);
  }

  supabaseCalls(): UpstreamCall[] {
    return this.calls.filter((c) => c.target !== "redis" && c.target !== "rc");
  }

  newUser(prng: Prng, provider: "google" | "apple" = "google"): FakeUser {
    const id = prng.uuid();
    return { id, provider, email: `${id.slice(0, 8)}@example.com` };
  }

  /** A Supabase-issued access token for `user` (unique per call). */
  sessionToken(user: FakeUser, prng: Prng, expSeconds = 3600): string {
    this.mint += 1;
    const token = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
      JSON.stringify({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: user.id,
        aud: "authenticated",
        role: "authenticated",
        session_id: `sess-${this.mint}-${prng.uuid()}`,
        exp: Math.floor(Date.now() / 1000) + expSeconds,
        jti: `${this.mint}-${prng.uuid()}`,
      }),
    )}.sig`;
    this.sessions.set(token, user);
    return token;
  }

  /** A Google ID token whose subject maps to `user` (transitional bearer). */
  providerToken(user: FakeUser, prng: Prng, expSeconds = 3600): string {
    const sub = `g-${prng.uuid()}`;
    this.providerUsers.set(sub, user);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(
      JSON.stringify({
        iss: "https://accounts.google.com",
        sub,
        exp: Math.floor(Date.now() / 1000) + expSeconds,
      }),
    );
    return `${header}.${payload}.sig`;
  }

  seedSavedDrill(userId: string, slug: string): void {
    this.savedDrills.add(`${userId}|${slug}`);
  }

  hasSavedDrill(userId: string, slug: string): boolean {
    return this.savedDrills.has(`${userId}|${slug}`);
  }

  private userJson(user: FakeUser) {
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

  classify(request: Request): Target {
    const url = new URL(request.url);
    if (request.url.startsWith(RC_URL)) return "rc";
    if (request.url.startsWith(REDIS_URL)) return "redis";
    if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user") return "auth_user";
    if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/token") return "auth_token";
    if (
      url.origin === SUPABASE_URL &&
      url.pathname === "/rest/v1/user_saved_drills" &&
      request.method === "DELETE"
    ) {
      return "rest_delete";
    }
    return "rest_other";
  }

  private json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...extra },
    });
  }

  /** The faulty answer for `target`, or null when no fault applies. */
  private async faulty(
    target: Target,
    signal: AbortSignal | null | undefined,
  ): Promise<{ response: Response | null; status: UpstreamCall["status"] } | null> {
    const fault = this.fault;
    if (!fault || fault.target !== target) return null;
    if (fault.firstN !== undefined && this.faultHits >= fault.firstN) return null;
    this.faultHits += 1;
    const mode = fault.mode;
    switch (mode.kind) {
      case "http": {
        if (mode.delayMs) await sleep(mode.delayMs);
        return {
          response: new Response(mode.body, {
            status: mode.status,
            headers: { "Content-Type": "application/json", ...(mode.headers ?? {}) },
          }),
          status: mode.status,
        };
      }
      case "throw":
        throw new TypeError(mode.message ?? "error sending request: connection reset by peer");
      case "hang": {
        // Rejects only when the caller's deadline aborts; a caller without a
        // deadline (request.signal never fires) waits forever.
        await new Promise<void>((_, reject) => {
          if (!signal) return;
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return { response: null, status: "hang" };
      }
      case "stream_error": {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id":"'));
            controller.error(new TypeError("error decoding response body: connection reset"));
          },
        });
        return {
          response: new Response(body, {
            status: mode.status,
            headers: { "Content-Type": "application/json" },
          }),
          status: "stream_error",
        };
      }
      case "slow":
        await sleep(mode.delayMs);
        return null;
    }
  }

  async handle(request: Request, rawBody: string, signal: AbortSignal | null | undefined) {
    const target = this.classify(request);
    const url = new URL(request.url);
    const call: UpstreamCall = {
      n: this.calls.length + 1,
      t: Math.round((performance.now() - this.t0) * 100) / 100,
      target,
      method: request.method,
      url: request.url,
      faulted: false,
      status: 0,
      durationMs: 0,
    };
    this.calls.push(call);
    const started = performance.now();
    const finish = (response: Response, status: UpstreamCall["status"] = response.status) => {
      call.status = status;
      call.durationMs = Math.round((performance.now() - started) * 100) / 100;
      return response;
    };
    const armed =
      this.fault !== null &&
      this.fault.target === target &&
      (this.fault.firstN === undefined || this.faultHits < this.fault.firstN);
    call.faulted = armed;
    try {
      const injected = await this.faulty(target, signal);
      if (injected?.response) return finish(injected.response, injected.status);
    } catch (error) {
      call.faulted = true;
      call.status = this.fault?.mode.kind === "hang" ? "hang" : "throw";
      call.durationMs = Math.round((performance.now() - started) * 100) / 100;
      throw error;
    }

    switch (target) {
      case "rc":
        return finish(
          this.json(200, { request_date_ms: Date.now(), subscriber: { entitlements: {} } }),
        );
      case "redis":
        return finish(this.redisPipeline(rawBody));
      case "auth_user": {
        const auth = request.headers.get("authorization") ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const user = this.sessions.get(bearer);
        if (!user) {
          return finish(
            this.json(403, {
              code: 403,
              error_code: "session_not_found",
              msg: "Session from session_id claim in JWT does not exist",
            }),
          );
        }
        return finish(this.json(200, this.userJson(user)));
      }
      case "auth_token": {
        const grant = url.searchParams.get("grant_type");
        if (grant !== "id_token") {
          return finish(this.json(400, { error: "unsupported_grant_type" }));
        }
        let body: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(rawBody);
          body = isRecord(parsed) ? parsed : {};
        } catch {
          body = {};
        }
        const idToken = typeof body.id_token === "string" ? body.id_token : "";
        const sub = jwtPayload(idToken)?.sub;
        const user = typeof sub === "string" ? this.providerUsers.get(sub) : undefined;
        if (!user) {
          return finish(
            this.json(400, { error: "invalid_grant", error_description: "bad id token" }),
          );
        }
        const prng = new Prng(fnv1a(idToken));
        const access = this.sessionToken(user, prng);
        return finish(
          this.json(200, {
            access_token: access,
            token_type: "bearer",
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            refresh_token: `rt-${prng.uuid()}`,
            user: this.userJson(user),
          }),
        );
      }
      case "rest_delete": {
        const auth = request.headers.get("authorization") ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const bearerSub = jwtPayload(bearer)?.sub;
        const userFilter = url.searchParams.get("user_id");
        const slugFilter = url.searchParams.get("slug");
        const userId = userFilter?.startsWith("eq.") ? userFilter.slice(3) : null;
        const slug = slugFilter?.startsWith("eq.") ? slugFilter.slice(3) : null;
        this.deleteFilters.push({
          user_id: userId,
          slug,
          bearerSub: typeof bearerSub === "string" ? bearerSub : null,
        });
        // RLS: only rows owned by the bearer's subject are visible to DELETE.
        if (
          userId !== null &&
          slug !== null &&
          typeof bearerSub === "string" &&
          userId === bearerSub
        ) {
          this.savedDrills.delete(`${userId}|${slug}`);
        }
        return finish(new Response(null, { status: 204 }));
      }
      case "rest_other":
        return finish(
          this.json(404, {
            code: "PGRST205",
            message: `stress harness: unmodelled ${request.method} ${url.pathname}`,
          }),
        );
    }
  }

  private redisPipeline(rawBody: string): Response {
    let commands: Array<Array<string | number>> = [];
    try {
      const parsed = JSON.parse(rawBody);
      commands = Array.isArray(parsed) ? parsed : [];
    } catch {
      commands = [];
    }
    const results: Array<{ result?: unknown; error?: string }> = [];
    const live = (key: string) => {
      const entry = this.redis.get(key);
      if (!entry) return null;
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
        this.redis.delete(key);
        return null;
      }
      return entry;
    };
    for (const cmd of commands) {
      this.redisCommands.push(cmd);
      const [name, ...args] = cmd.map(String);
      switch (name.toUpperCase()) {
        case "GET":
          results.push({ result: live(args[0])?.value ?? null });
          break;
        case "TTL": {
          const entry = live(args[0]);
          results.push({
            result: !entry
              ? -2
              : entry.expiresAtMs === null
                ? -1
                : Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1_000)),
          });
          break;
        }
        case "SET": {
          const [key, value, ex, seconds] = args;
          const ttl = ex ? Number(seconds) : NaN;
          this.redis.set(key, {
            value,
            expiresAtMs: Number.isFinite(ttl) ? Date.now() + ttl * 1_000 : null,
          });
          results.push({ result: "OK" });
          break;
        }
        case "DEL": {
          let n = 0;
          for (const key of args) if (this.redis.delete(key)) n += 1;
          results.push({ result: n });
          break;
        }
        case "INCR": {
          const entry = live(args[0]);
          const next = (entry ? Number(entry.value) : 0) + 1;
          this.redis.set(args[0], { value: String(next), expiresAtMs: entry?.expiresAtMs ?? null });
          results.push({ result: next });
          break;
        }
        case "EXPIRE": {
          const [key, seconds, flag] = args;
          const entry = live(key);
          if (!entry) results.push({ result: 0 });
          else if (flag && flag.toUpperCase() === "NX" && entry.expiresAtMs !== null) {
            results.push({ result: 0 });
          } else {
            entry.expiresAtMs = Date.now() + Number(seconds) * 1_000;
            results.push({ result: 1 });
          }
          break;
        }
        default:
          results.push({ error: `ERR unknown command '${name}'` });
      }
    }
    return this.json(200, results);
  }
}

// ── Loading the real handler ─────────────────────────────────────────────────

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  fake: FakeUpstream;
  redis: boolean;
}

let loaded: StressHarness | null = null;

export async function loadStressHarness(options: { redis: boolean }): Promise<StressHarness> {
  if (loaded) {
    if (loaded.redis !== options.redis) {
      throw new Error(
        "stress harness: Redis on/off is fixed per test file (cache.ts reads env at load)",
      );
    }
    return loaded;
  }
  // `deno test .` shares Deno.env across every test file in the process; put
  // back whatever was there once this file's isolate unloads.
  const envKeys = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "REVENUECAT_WEBHOOK_AUTH",
    "REVENUECAT_SECRET_API_KEY",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
  ];
  const envBefore = new Map(envKeys.map((k) => [k, Deno.env.get(k)] as const));
  globalThis.addEventListener("unload", () => {
    for (const [k, v] of envBefore) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  });
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const fake = new FakeUpstream();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = await request.text().catch(() => "");
    return fake.handle(request, rawBody, request.signal);
  }) as typeof fetch;

  let handler: StressHarness["handler"] | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      StressHarness["handler"] | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) throw new Error("index.ts did not register a Deno.serve handler");
  loaded = { handler, fake, redis: options.redis };
  return loaded;
}

// ── Request builders ─────────────────────────────────────────────────────────

export function deleteSavedDrillRequest(options: {
  token?: string | null;
  ip?: string;
  rawSlug: string;
  body?: BodyInit | null;
  headers?: Record<string, string>;
}): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? "198.51.100.7",
    ...options.headers,
  });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  return new Request(
    `http://edge.stress.test/functions/v1/api/v1/me/saved-drills/${options.rawSlug}`,
    {
      method: "DELETE",
      headers,
      body: options.body ?? undefined,
    },
  );
}

export async function readBody(
  response: Response,
): Promise<{ text: string; json: Record<string, unknown> | null }> {
  const text = await response.text();
  if (!text) return { text, json: null };
  try {
    const parsed = JSON.parse(text);
    return { text, json: isRecord(parsed) ? parsed : { _value: parsed } };
  } catch {
    return { text, json: null };
  }
}

/** Race a handler call against a wall-clock cap; `null` means it did not settle. */
export async function withCap<T>(promise: Promise<T>, capMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), capMs);
  });
  try {
    return await Promise.race([promise, cap]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Reporting ────────────────────────────────────────────────────────────────

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-route-delete-saved-drill/latest/", import.meta.url)
    .pathname;
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
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function histogram(values: Array<string | number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
/** Iterations per fault case (each with its own derived seed). */
export const STRESS_ITER = envInt("STRESS_ITER", 1);
/** Sequential requests in the latency campaign. */
export const STRESS_LOAD_N = envInt("STRESS_LOAD_N", 1000);
/** Distinct users in the L1 memory campaign. */
export const STRESS_USERS = envInt("STRESS_USERS", 2000);
