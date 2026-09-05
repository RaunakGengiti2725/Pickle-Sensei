// stress — `PUT /v1/me/saved-drills/:slug` failure-injection + load harness.
//
// Drives the REAL edge handler (../index.ts, Deno.serve captured) in-process
// over a STATEFUL fake of every upstream it can reach on this route:
//
//   Supabase Auth (GoTrue)   GET  /auth/v1/user               session bearers
//                            POST /auth/v1/token?grant_type=id_token
//                                                          transitional
//                                                          provider ID tokens
//   PostgREST                POST /rest/v1/user_saved_drills   the upsert
//                            GET  /rest/v1/user_saved_drills   the read-back
//   Upstash Redis (REST)     POST <REDIS_URL>/pipeline         cache + limits
//   RevenueCat               GET  https://api.revenuecat.com/…  (never on this
//                                                          route — asserted)
//
// Faults are ARMED per upstream (status, network throw, hang honouring the
// caller's AbortSignal, malformed / truncated / wrong-shape bodies, slow
// answers) and released after N matching calls, so every scenario can assert
// both the user-visible error class and recoverability once the upstream is
// healthy again. Every upstream call is recorded (kind, status, latency) so a
// request's round-trip count is measurable, and every scenario is driven by a
// seeded PRNG (mulberry32) — a failing seed replays with the printed command.
//
// Nothing here talks to the network: `globalThis.fetch` is replaced before
// ../index.ts is imported and every URL outside the fake origins answers 599.

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://redis.stress.test";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
const ANON_KEY = "stress-anon-key";
const SERVICE_ROLE_KEY = "stress-service-role-key";
const REDIS_TOKEN = "stress-redis-token";

// ── PRNG ─────────────────────────────────────────────────────────────────────

/** mulberry32 — deterministic; the seed alone replays a scenario. */
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
    return minInclusive +
      Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
  /** A slug the route accepts (DRILL_SLUG_RE: [a-z0-9][a-z0-9_-]{0,119}, /i). */
  slug(maxLen = 24): string {
    const first = "abcdefghijklmnopqrstuvwxyz0123456789";
    const rest = `${first}${first.toUpperCase()}_-`;
    const len = this.int(1, maxLen);
    let out = this.pick([...first]);
    for (let i = 1; i < len; i++) out += this.pick([...rest]);
    return out;
  }
  ip(): string {
    return `198.51.${this.int(0, 255)}.${this.int(1, 254)}`;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

export function fakeGoogleIdToken(sub: string): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.sig`;
}

// ── Faults ───────────────────────────────────────────────────────────────────

export type Upstream =
  | "gotrue_user"
  | "gotrue_token"
  | "rest_upsert"
  | "rest_select"
  | "redis"
  | "revenuecat";

export const UPSTREAMS: readonly Upstream[] = [
  "gotrue_user",
  "gotrue_token",
  "rest_upsert",
  "rest_select",
  "redis",
  "revenuecat",
];

export type FaultMode =
  | "http_400"
  | "http_401"
  | "http_403"
  | "http_404"
  | "http_409"
  | "http_429"
  | "http_500"
  | "http_502"
  | "http_503"
  | "http_504"
  | "network_error"
  | "timeout"
  | "malformed_json"
  | "html_body"
  | "empty_body"
  | "wrong_shape"
  | "truncated_stream"
  | "slow_ok"
  // Redis-only: the pipeline answered, but not the question.
  | "redis_command_error"
  | "redis_short_reply";

export const FAULT_MODES: readonly FaultMode[] = [
  "http_400",
  "http_401",
  "http_403",
  "http_404",
  "http_409",
  "http_429",
  "http_500",
  "http_502",
  "http_503",
  "http_504",
  "network_error",
  "timeout",
  "malformed_json",
  "html_body",
  "empty_body",
  "wrong_shape",
  "truncated_stream",
  "slow_ok",
];

export const REDIS_ONLY_MODES: readonly FaultMode[] = [
  "redis_command_error",
  "redis_short_reply",
];

export interface FaultSpec {
  target: Upstream;
  mode: FaultMode;
  /** Matching calls affected before the fault disarms itself (default 1;
   * Infinity = until `fake.clearFaults()`). */
  count?: number;
  /** slow_ok: extra latency before the healthy answer (default 300 ms). */
  slowMs?: number;
  /** Retry-After header value on http_429 / http_503 answers. */
  retryAfter?: string;
}

interface ArmedFault extends FaultSpec {
  remaining: number;
  hits: number;
}

export interface UpstreamCall {
  t: number;
  kind: Upstream | "other";
  method: string;
  url: string;
  /** HTTP status of the answer, "throw" / "hang" for injected faults, or
   * "pending" while the upstream has not answered yet. */
  outcome: number | "throw" | "hang" | "pending";
  ms: number;
  fault?: FaultMode;
  /** Redis: the pipeline's commands with key prefixes, e.g. "INCR rl:ip|EXPIRE rl:ip". */
  detail?: string;
}

/** "INCR rl:ip:…|EXPIRE rl:ip:…" → command + first two key segments per slot. */
function describePipeline(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return "?";
    return parsed
      .map((command) => {
        if (!Array.isArray(command) || command.length === 0) return "?";
        const [op, key] = command.map(String);
        const prefix = key === undefined
          ? ""
          : ` ${key.split(":").slice(0, 2).join(":")}`;
        return `${op}${prefix}`;
      })
      .join("|");
  } catch {
    return "?";
  }
}

const statusText = (status: number): string =>
  (
    {
      400: "Bad Request",
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not Found",
      406: "Not Acceptable",
      409: "Conflict",
      429: "Too Many Requests",
      500: "Internal Server Error",
      502: "Bad Gateway",
      503: "Service Unavailable",
      504: "Gateway Timeout",
    } as Record<number, string>
  )[status] ?? "";

function jsonResponse(
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: statusText(status),
    headers: { "Content-Type": "application/json", ...extra },
  });
}

/** A body whose stream errors half-way through a JSON document. */
function truncatedStreamResponse(status: number): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode('[{"slug":"dink-drill","saved_at":"2026-09-0'),
      );
      controller.error(
        new TypeError("stress: connection reset while reading body"),
      );
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Error-body shapes each upstream really emits, so the handler's parsers
 * see production-like refusals rather than empty bodies. */
function upstreamErrorBody(target: Upstream, status: number): unknown {
  if (target === "gotrue_user" || target === "gotrue_token") {
    if (status === 400) {
      return {
        error: "invalid_grant",
        error_description: "stress: bad id token",
      };
    }
    if (status === 401) {
      return { code: 401, error_code: "bad_jwt", msg: "invalid JWT" };
    }
    if (status === 403) {
      return {
        code: 403,
        error_code: "session_not_found",
        msg: "Session from session_id claim in JWT does not exist",
      };
    }
    if (status === 429) {
      return {
        code: 429,
        error_code: "over_request_rate_limit",
        msg: "Request rate limit reached",
      };
    }
    return {
      code: status,
      error_code: "unexpected_failure",
      msg: `stress: gotrue ${status}`,
    };
  }
  if (target === "rest_upsert" || target === "rest_select") {
    if (status === 400) {
      return {
        code: "PGRST102",
        message: "stress: malformed request",
        details: null,
        hint: null,
      };
    }
    if (status === 401) {
      return {
        code: "PGRST301",
        message: "JWT expired",
        details: null,
        hint: null,
      };
    }
    if (status === 403) {
      return {
        code: "42501",
        message:
          'new row violates row-level security policy for table "user_saved_drills"',
        details: null,
        hint: null,
      };
    }
    if (status === 404) {
      return {
        code: "PGRST205",
        message:
          "Could not find the table 'public.user_saved_drills' in the schema cache",
        details: null,
        hint: null,
      };
    }
    if (status === 409) {
      return {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "user_saved_drills_pkey"',
        details: "Key (user_id, slug)=(…) already exists.",
        hint: null,
      };
    }
    if (status === 503) {
      return {
        code: "PGRST002",
        message: "Could not query the database for the schema cache. Retrying.",
        details: null,
        hint: null,
      };
    }
    return {
      code: `PGRST${status}`,
      message: `stress: postgrest ${status}`,
      details: null,
      hint: null,
    };
  }
  if (target === "redis") return { error: `stress: upstash ${status}` };
  return { message: `stress: ${target} ${status}` };
}

// ── The fake ─────────────────────────────────────────────────────────────────

export interface FakeSession {
  userId: string;
  sessionId: string;
  accessToken: string;
}

export class FakeUpstreams {
  users = new Map<
    string,
    { id: string; email: string; provider: "google" | "apple" }
  >();
  sessions = new Map<string, FakeSession>();
  /** provider subject → Supabase user id (what signInWithIdToken resolves). */
  identities = new Map<string, string>();
  /** `${user_id}|${slug}` → saved_at (ISO). The table PostgREST serves. */
  savedDrills = new Map<string, string>();
  /** user_id → slug → saved_at: the index PostgREST's `user_id=eq.` filter
   * would use, so a 20k-user table does not make the fake O(n) per read. */
  private drillsByUser = new Map<string, Map<string, string>>();
  redis = new Map<string, { value: string; expiresAtMs: number | null }>();
  calls: UpstreamCall[] = [];
  counters: Record<string, number> = {};
  /** Hung fetches waiting for `releaseHangs()`. */
  private hung: Array<() => void> = [];
  private faults: ArmedFault[] = [];
  /** Seeded upstream latency (0 = answer synchronously). */
  latencyMaxMs = 0;
  prng = new Prng(1);
  private t0 = performance.now();
  private mint = 0;

  reset(seed: number, latencyMaxMs = 0): void {
    this.prng = new Prng(seed);
    this.latencyMaxMs = latencyMaxMs;
    this.users.clear();
    this.sessions.clear();
    this.identities.clear();
    this.savedDrills.clear();
    this.drillsByUser.clear();
    this.redis.clear();
    this.calls = [];
    this.counters = {};
    this.releaseHangs();
    this.faults = [];
    this.t0 = performance.now();
  }

  arm(spec: FaultSpec): void {
    this.faults.push({ ...spec, remaining: spec.count ?? 1, hits: 0 });
  }

  clearFaults(): void {
    this.faults = [];
  }

  /** Resolve every hung fetch with a 500 (never retried by any client library
   * on this route) so nothing dangles into the next scenario. */
  releaseHangs(): void {
    const pending = this.hung;
    this.hung = [];
    for (const release of pending) release();
  }

  faultHits(): Array<{ target: Upstream; mode: FaultMode; hits: number }> {
    return this.faults.map((f) => ({
      target: f.target,
      mode: f.mode,
      hits: f.hits,
    }));
  }

  count(key: string): void {
    this.counters[key] = (this.counters[key] ?? 0) + 1;
  }

  callsSince(index: number): UpstreamCall[] {
    return this.calls.slice(index);
  }

  /** Upstream round trips grouped for a slice of `calls`. */
  static tally(calls: UpstreamCall[]): Record<string, number> {
    const out: Record<string, number> = {
      supabase: 0,
      gotrue: 0,
      postgrest: 0,
      redis: 0,
      other: 0,
    };
    for (const c of calls) {
      if (c.kind === "gotrue_user" || c.kind === "gotrue_token") {
        out.gotrue += 1;
        out.supabase += 1;
      } else if (c.kind === "rest_upsert" || c.kind === "rest_select") {
        out.postgrest += 1;
        out.supabase += 1;
      } else if (c.kind === "redis") out.redis += 1;
      else out.other += 1;
    }
    return out;
  }

  // ── identities ──

  ensureUser(userId: string, provider: "google" | "apple" = "google"): void {
    if (!this.users.has(userId)) {
      this.users.set(userId, {
        id: userId,
        email: `${userId.slice(0, 8)}@example.com`,
        provider,
      });
    }
  }

  /** A Supabase-issued access token for `userId` (the production bearer). */
  mintSession(
    userId: string,
    provider: "google" | "apple" = "google",
    ttlSeconds = 3600,
  ): FakeSession {
    this.ensureUser(userId, provider);
    this.mint += 1;
    const sessionId = `sess-${this.mint}-${this.prng.uuid()}`;
    const accessToken = `${
      b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    }.${
      b64url(
        JSON.stringify({
          iss: `${SUPABASE_URL}/auth/v1`,
          sub: userId,
          aud: "authenticated",
          role: "authenticated",
          session_id: sessionId,
          exp: Math.floor(Date.now() / 1000) + ttlSeconds,
          jti: `${this.mint}-${this.prng.uuid()}`,
        }),
      )
    }.sig`;
    const session = { userId, sessionId, accessToken };
    this.sessions.set(accessToken, session);
    return session;
  }

  private userJson(userId: string) {
    const user = this.users.get(userId)!;
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

  private principal(
    headers: Headers,
  ): { role: "service" | "user" | "anon"; userId: string | null } {
    const auth = headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token === SERVICE_ROLE_KEY) return { role: "service", userId: null };
    if (!token || token === ANON_KEY) return { role: "anon", userId: null };
    const payload = jwtPayload(token);
    const sub = typeof payload?.sub === "string" ? payload.sub : null;
    return { role: "user", userId: sub };
  }

  // ── classification ──

  private classify(request: Request): Upstream | "other" {
    const url = new URL(request.url);
    if (request.url.startsWith(RC_URL)) return "revenuecat";
    if (url.origin === REDIS_URL) return "redis";
    if (url.origin === SUPABASE_URL) {
      if (url.pathname === "/auth/v1/user") return "gotrue_user";
      if (url.pathname === "/auth/v1/token") return "gotrue_token";
      if (url.pathname === "/rest/v1/user_saved_drills") {
        return request.method === "GET" ? "rest_select" : "rest_upsert";
      }
    }
    return "other";
  }

  // ── fault application ──

  private takeFault(kind: Upstream | "other"): ArmedFault | null {
    if (kind === "other") return null;
    const fault = this.faults.find((f) => f.target === kind && f.remaining > 0);
    if (!fault) return null;
    fault.remaining -= 1;
    fault.hits += 1;
    return fault;
  }

  private async injected(
    fault: ArmedFault,
    request: Request,
    healthy: () => Promise<Response>,
  ): Promise<Response> {
    const target = fault.target;
    const status = /^http_(\d+)$/.exec(fault.mode);
    if (status) {
      const code = Number(status[1]);
      const extra: Record<string, string> = {};
      if ((code === 429 || code === 503) && fault.retryAfter !== undefined) {
        extra["Retry-After"] = fault.retryAfter;
      }
      return jsonResponse(code, upstreamErrorBody(target, code), extra);
    }
    switch (fault.mode) {
      case "network_error":
        throw new TypeError(
          `error sending request for url (${request.url}): client error (Connect): tcp connect error: Connection refused (os error 111)`,
        );
      case "timeout": {
        // Honour the caller's AbortSignal exactly like a real socket would;
        // without one the call hangs until releaseHangs().
        return await new Promise<Response>((resolve, reject) => {
          const signal = request.signal;
          const release = () => {
            signal.removeEventListener("abort", onAbort);
            resolve(jsonResponse(500, { message: "stress: hang released" }));
          };
          const onAbort = () => {
            this.hung = this.hung.filter((r) => r !== release);
            const reason = signal.reason;
            reject(
              reason instanceof DOMException
                ? reason
                : new DOMException("The signal has been aborted", "AbortError"),
            );
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          this.hung.push(release);
        });
      }
      case "malformed_json":
        return new Response('{"id":"trunc', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      case "html_body":
        return new Response(
          "<html><body><h1>502 Bad Gateway</h1></body></html>",
          {
            status: 200,
            headers: { "Content-Type": "text/html" },
          },
        );
      case "empty_body":
        return new Response("", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      case "wrong_shape": {
        // The opposite of what each caller expects.
        if (target === "redis") return jsonResponse(200, { result: "OK" });
        if (target === "gotrue_user") {
          return jsonResponse(200, [{ id: "not-an-object" }]);
        }
        if (target === "gotrue_token") {
          return jsonResponse(200, { access_token: 42, user: null });
        }
        if (target === "rest_select") {
          // Two rows where the (user_id, slug) primary key promises at most one.
          return jsonResponse(200, [
            { slug: "dink-drill", saved_at: "2026-09-04T00:00:00.000Z" },
            { slug: "dink-drill", saved_at: "2026-09-04T00:00:01.000Z" },
          ]);
        }
        if (target === "rest_upsert") return jsonResponse(201, "ok");
        return jsonResponse(200, []);
      }
      case "truncated_stream":
        return truncatedStreamResponse(200);
      case "slow_ok":
        await sleep(fault.slowMs ?? 300);
        return await healthy();
      case "redis_command_error": {
        const commands = await this.commandsOf(request);
        return jsonResponse(
          200,
          commands.map(() => ({ error: "ERR stress: command failed" })),
        );
      }
      case "redis_short_reply":
        return jsonResponse(200, []);
    }
    return await healthy();
  }

  private async commandsOf(
    request: Request,
  ): Promise<Array<Array<string | number>>> {
    try {
      const parsed = JSON.parse(await request.clone().text());
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // ── healthy answers ──

  private async latency(): Promise<void> {
    if (this.latencyMaxMs > 0) await sleep(this.prng.int(0, this.latencyMaxMs));
  }

  private async healthy(
    kind: Upstream | "other",
    request: Request,
  ): Promise<Response> {
    await this.latency();
    const url = new URL(request.url);
    switch (kind) {
      case "revenuecat":
        return jsonResponse(200, {
          request_date_ms: Date.now(),
          subscriber: { entitlements: {} },
        });
      case "redis":
        return this.redisPipeline(await this.commandsOf(request));
      case "gotrue_user": {
        const auth = request.headers.get("authorization") ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const session = this.sessions.get(bearer);
        if (!session) {
          return jsonResponse(403, upstreamErrorBody("gotrue_user", 403));
        }
        return jsonResponse(200, this.userJson(session.userId));
      }
      case "gotrue_token": {
        if (url.searchParams.get("grant_type") !== "id_token") {
          return jsonResponse(400, { error: "unsupported_grant_type" });
        }
        const body = JSON.parse(
          await request.clone().text().catch(() => "{}"),
        ) as Record<
          string,
          unknown
        >;
        const idToken = typeof body.id_token === "string" ? body.id_token : "";
        const sub = typeof jwtPayload(idToken)?.sub === "string"
          ? String(jwtPayload(idToken)!.sub)
          : "";
        if (!sub) {
          return jsonResponse(400, upstreamErrorBody("gotrue_token", 400));
        }
        const provider = body.provider === "apple" ? "apple" : "google";
        let userId = this.identities.get(sub);
        if (!userId) {
          userId = this.prng.uuid();
          this.identities.set(sub, userId);
        }
        const session = this.mintSession(userId, provider);
        const payload = jwtPayload(session.accessToken)!;
        return jsonResponse(200, {
          access_token: session.accessToken,
          token_type: "bearer",
          expires_in: 3600,
          expires_at: payload.exp,
          refresh_token: `rt-${this.prng.uuid()}`,
          user: this.userJson(userId),
        });
      }
      case "rest_upsert":
        return this.restUpsert(request, url);
      case "rest_select":
        return this.restSelect(request, url);
      default:
        return new Response(
          `stress harness: unexpected fetch ${request.method} ${request.url}`,
          {
            status: 599,
          },
        );
    }
  }

  private redisPipeline(commands: Array<Array<string | number>>): Response {
    const now = Date.now();
    const live = (key: string) => {
      const row = this.redis.get(key);
      if (!row) return null;
      if (row.expiresAtMs !== null && row.expiresAtMs <= now) {
        this.redis.delete(key);
        return null;
      }
      return row;
    };
    const results = commands.map((command) => {
      const [op, ...args] = command.map(String);
      switch (op) {
        case "GET":
          return { result: live(args[0])?.value ?? null };
        case "SET": {
          const exIndex = args.indexOf("EX");
          const ttl = exIndex >= 0 ? Number(args[exIndex + 1]) : NaN;
          this.redis.set(args[0], {
            value: args[1],
            expiresAtMs: Number.isFinite(ttl) ? now + ttl * 1000 : null,
          });
          return { result: "OK" };
        }
        case "TTL": {
          const row = live(args[0]);
          if (!row) return { result: -2 };
          if (row.expiresAtMs === null) return { result: -1 };
          return {
            result: Math.max(1, Math.ceil((row.expiresAtMs - now) / 1000)),
          };
        }
        case "INCR": {
          const row = live(args[0]);
          const next = (row ? Number(row.value) : 0) + 1;
          this.redis.set(args[0], {
            value: String(next),
            expiresAtMs: row?.expiresAtMs ?? null,
          });
          return { result: next };
        }
        case "EXPIRE": {
          const row = live(args[0]);
          if (!row) return { result: 0 };
          if (args.includes("NX") && row.expiresAtMs !== null) {
            return { result: 0 };
          }
          row.expiresAtMs = now + Number(args[1]) * 1000;
          return { result: 1 };
        }
        case "DEL": {
          let n = 0;
          for (const key of args) if (this.redis.delete(key)) n += 1;
          return { result: n };
        }
        default:
          return { error: `ERR unknown command '${op}'` };
      }
    });
    return jsonResponse(200, results);
  }

  private async restUpsert(request: Request, url: URL): Promise<Response> {
    const who = this.principal(request.headers);
    if (who.role === "anon") {
      return jsonResponse(401, { code: "PGRST301", message: "JWT required" });
    }
    const prefer = request.headers.get("prefer") ?? "";
    const raw = await request.clone().text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return jsonResponse(400, {
        code: "PGRST102",
        message: "Empty or invalid json request body",
      });
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const inserted: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      if (
        !isRecord(row) || typeof row.user_id !== "string" ||
        typeof row.slug !== "string"
      ) {
        return jsonResponse(400, {
          code: "PGRST102",
          message: "stress: bad row",
        });
      }
      if (who.role === "user" && row.user_id !== who.userId) {
        return jsonResponse(403, upstreamErrorBody("rest_upsert", 403));
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(row.slug)) {
        return jsonResponse(400, {
          code: "23514",
          message:
            'new row for relation "user_saved_drills" violates check constraint "user_saved_drills_slug_bounds"',
        });
      }
      const key = `${row.user_id}|${row.slug}`;
      if (this.savedDrills.has(key)) {
        if (prefer.includes("resolution=ignore-duplicates")) continue;
        if (prefer.includes("resolution=merge-duplicates")) continue;
        return jsonResponse(409, upstreamErrorBody("rest_upsert", 409));
      }
      const savedAt = new Date().toISOString();
      this.savedDrills.set(key, savedAt);
      let mine = this.drillsByUser.get(row.user_id);
      if (!mine) this.drillsByUser.set(row.user_id, mine = new Map());
      mine.set(row.slug, savedAt);
      inserted.push({
        user_id: row.user_id,
        slug: row.slug,
        saved_at: savedAt,
      });
    }
    this.count(`rest.upsert.${url.searchParams.get("on_conflict") ?? "none"}`);
    if (prefer.includes("return=representation")) {
      return jsonResponse(201, inserted);
    }
    return new Response(null, { status: 201, statusText: "Created" });
  }

  private restSelect(request: Request, url: URL): Response {
    const who = this.principal(request.headers);
    if (who.role === "anon") {
      return jsonResponse(401, { code: "PGRST301", message: "JWT required" });
    }
    const userFilter = url.searchParams.get("user_id");
    const scope = who.role === "user"
      ? [who.userId]
      : userFilter?.startsWith("eq.")
      ? [userFilter.slice(3)]
      : [...this.drillsByUser.keys()];
    let rows: Array<Record<string, unknown>> = [];
    for (const userId of scope) {
      for (const [slug, savedAt] of this.drillsByUser.get(userId) ?? []) {
        rows.push({ user_id: userId, slug, saved_at: savedAt });
      }
    }
    for (const [col, raw] of url.searchParams.entries()) {
      if (["select", "order", "limit", "offset"].includes(col)) continue;
      if (raw.startsWith("eq.")) {
        const v = raw.slice(3);
        rows = rows.filter((r) => String(r[col]) === v);
      } else {
        return jsonResponse(400, {
          code: "PGRST100",
          message: `stress: unsupported filter ${col}=${raw}`,
        });
      }
    }
    const select = (url.searchParams.get("select") ?? "*").split(",").map((s) =>
      s.trim()
    );
    const projected = rows.map((r) =>
      select.includes("*")
        ? r
        : Object.fromEntries(select.map((c) => [c, r[c]]))
    );
    const accept = request.headers.get("accept") ?? "";
    if (accept.includes("application/vnd.pgrst.object+json")) {
      if (projected.length !== 1) {
        return jsonResponse(406, {
          code: "PGRST116",
          message: "JSON object requested, multiple (or no) rows returned",
          details: `Results contain ${projected.length} rows`,
          hint: null,
        });
      }
      return jsonResponse(200, projected[0]);
    }
    return jsonResponse(200, projected);
  }

  // ── dispatcher ──

  async handleFetch(request: Request): Promise<Response> {
    const kind = this.classify(request);
    const started = performance.now();
    const call: UpstreamCall = {
      t: Math.round((started - this.t0) * 100) / 100,
      kind,
      method: request.method,
      url: request.url,
      outcome: "pending",
      ms: 0,
    };
    this.calls.push(call);
    if (kind === "redis") {
      call.detail = describePipeline(
        await request.clone().text().catch(() => ""),
      );
    }
    const settle = (outcome: UpstreamCall["outcome"]) => {
      call.outcome = outcome;
      call.ms = Math.round((performance.now() - started) * 100) / 100;
    };
    this.count(kind);
    const fault = this.takeFault(kind);
    if (fault) {
      call.fault = fault.mode;
      try {
        const response = await this.injected(
          fault,
          request,
          () => this.healthy(kind, request),
        );
        settle(response.status);
        return response;
      } catch (error) {
        settle(fault.mode === "timeout" ? "hang" : "throw");
        throw error;
      }
    }
    const response = await this.healthy(kind, request);
    settle(response.status);
    return response;
  }
}

// ── Loading the real handler ─────────────────────────────────────────────────

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  fake: FakeUpstreams;
  redisConfigured: boolean;
  /** Milliseconds the harness configured for one Auth round trip. */
  authTimeoutMs: number;
}

let loaded: StressHarness | null = null;

export interface LoadOptions {
  /** Configure the fake Upstash (L2 cache + shared rate limits). Default:
   * STRESS_REDIS=1 in the environment. */
  redis?: boolean;
  /** AUTH_UPSTREAM_TIMEOUT_MS for the isolate (default 6000, production). */
  authTimeoutMs?: number;
}

export async function loadStressHarness(
  options: LoadOptions = {},
): Promise<StressHarness> {
  if (loaded) return loaded;
  const redis = options.redis ?? Deno.env.get("STRESS_REDIS") === "1";
  const authTimeoutMs = options.authTimeoutMs ?? 6_000;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(authTimeoutMs));
  if (redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const fake = new FakeUpstreams();
  globalThis.fetch =
    ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      fake.handleFetch(new Request(input, init))) as typeof fetch;

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
  loaded = { handler, fake, redisConfigured: redis, authTimeoutMs };
  return loaded;
}

// ── Requests ─────────────────────────────────────────────────────────────────

export function putSavedDrill(
  slug: string,
  options: {
    token?: string | null;
    ip?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? "198.51.100.7",
    Accept: "application/json",
    ...options.headers,
  });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  return new Request(
    `http://edge.stress.test/functions/v1/api/v1/me/saved-drills/${
      encodeURIComponent(slug)
    }`,
    { method: "PUT", headers },
  );
}

export async function readJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : { _value: parsed };
  } catch {
    return { _raw: text };
  }
}

export interface Answer {
  status: number | "pending";
  body: Record<string, unknown>;
  headers: Record<string, string>;
  ms: number;
  /** Upstream calls this request made (sequential driving only). */
  calls: UpstreamCall[];
}

/** Drive one request through the real handler; a handler that has not
 * answered within `deadlineMs` reports `status: "pending"` (the fake's hung
 * fetches are then released so nothing leaks into the next scenario). */
export async function drive(
  h: StressHarness,
  request: Request,
  deadlineMs = 5_000,
): Promise<Answer> {
  const from = h.fake.calls.length;
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), deadlineMs);
  });
  const outcome = await Promise.race([h.handler(request), deadline]);
  clearTimeout(timer);
  const ms = Math.round((performance.now() - started) * 100) / 100;
  if (outcome === "pending") {
    const calls = h.fake.callsSince(from).map((c) => ({ ...c }));
    h.fake.releaseHangs();
    return { status: "pending", body: {}, headers: {}, ms, calls };
  }
  const headers: Record<string, string> = {};
  outcome.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return {
    status: outcome.status,
    body: await readJson(outcome),
    headers,
    ms,
    calls: h.fake.callsSince(from),
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
export const STRESS_ITER = envInt("STRESS_ITER", 120);
export const STRESS_USERS = envInt("STRESS_USERS", 1_500);

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-saved-drill-put/latest/",
    import.meta.url,
  ).pathname;
}

export async function writeArtifact(
  name: string,
  payload: unknown,
): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(payload, null, 2));
  return path;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export function latencySummary(values: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? NaN,
    mean: sorted.length ? Math.round((sum / sorted.length) * 1000) / 1000 : NaN,
  };
}

export function histogram(
  values: Array<string | number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

/** Strings a 5xx body must never carry (upstream detail leaking to users). */
export const LEAK_MARKERS = [
  "PGRST",
  "postgres",
  "supabase",
  "user_saved_drills",
  "relation",
  "constraint",
  "stack",
  "    at ",
  "stress:",
  "redis",
  "upstash",
  "gotrue",
];

export function leaks(body: Record<string, unknown>): string[] {
  const text = JSON.stringify(body).toLowerCase();
  return LEAK_MARKERS.filter((marker) => text.includes(marker.toLowerCase()));
}
