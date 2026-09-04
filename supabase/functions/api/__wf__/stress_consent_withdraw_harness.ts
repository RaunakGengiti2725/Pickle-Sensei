// stress — POST /v1/me/consent/withdraw (lens: failure-load).
//
// Fault-injectable, SEEDED black-box harness around the REAL edge function
// (../index.ts booted with Deno.serve captured, exactly like routesHarness.ts
// / sessionHarness.ts). Every upstream the route can reach is a fake behind
// globalThis.fetch and every fake can be told, per call, to fail / hang /
// answer malformed:
//
//   auth        GET  {SUPABASE_URL}/auth/v1/user           (session verification)
//   postgrest   GET  {SUPABASE_URL}/rest/v1/consent_records (fold read ×2)
//               POST {SUPABASE_URL}/rest/v1/consent_records (withdraw row)
//   redis       POST {REDIS_URL}/pipeline                  (Upstash REST; only
//                                                            when booted with
//                                                            redis: true)
//   revenuecat  GET  https://api.revenuecat.com/v1/subscribers/…  (never on
//                                                            this route — the
//                                                            fake proves it)
//
// Unlike routesHarness.ts the PostgREST fake is STATEFUL for consent_records:
// inserts persist and reads filter by `user_id=eq.<uuid>` and honour the
// route's `order=created_at.asc,id.asc`, so the fold the client sees after a
// withdraw is computed from what the route actually wrote — recoverability
// (retry after a fault) and duplicate delivery (withdraw twice) are
// observable instead of canned.
//
// Everything is driven by a mulberry32 PRNG (`Prng`, same generator as
// xc_concurrency_harness.ts): user ids, device / source strings, garbage
// bodies, delays and which nth upstream call takes the fault all derive from
// the scenario seed, so a failing row in the JSON table replays from its seed.
//
// cache.ts reads UPSTASH_* at import, so the Redis-enabled function must boot
// in its own test module (Deno runs each test file in its own isolate).

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const REDIS_TOKEN = "stress-upstash-token";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
export const ANON_KEY = "stress-anon-key";

export const CONSENT_SCOPES = [
  "video_analysis",
  "model_training",
  "evaluation_telemetry",
] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

export type Upstream = "auth" | "postgrest" | "redis" | "revenuecat" | "other";

export interface RecordedCall {
  seq: number;
  upstream: Upstream;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  /** ms since harness boot, performance.now() based */
  startedMs: number;
  endedMs: number | null;
  /** HTTP status the fake answered, or the fault kind (throw|hang) */
  outcome: string;
  /** which fault (if any) the hook applied */
  fault: string | null;
}

/** What a fake should do for one upstream call. */
export type Fault =
  | {
    kind: "status";
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }
  | { kind: "raw"; status: number; text: string; contentType?: string }
  | { kind: "throw"; message?: string }
  | { kind: "hang" }
  | { kind: "delay"; ms: number; then?: Fault }
  /** run the real fake (its side effects land) but answer with `then` */
  | { kind: "afterReal"; then: Fault };

export interface FaultContext {
  upstream: Upstream;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  /** 1-based index of this call among calls to the same upstream since reset() */
  nth: number;
  /** 1-based index among calls to the same upstream+method since reset() */
  nthOfMethod: number;
}

export type FaultHook = (ctx: FaultContext) => Fault | null | undefined;

export interface FakeSession {
  userId: string;
  accessToken: string;
  sessionId: string;
  /** Unix seconds */
  expiresAt: number;
  revoked: boolean;
}

export interface ConsentRecordRow {
  id: string;
  user_id: string;
  scope: string;
  consent_version: string | null;
  action: "grant" | "withdraw";
  source: string | null;
  device: unknown;
  capture_mode: string | null;
  created_at: string;
}

export interface FakeRedisEntry {
  value: string;
  expiresAtMs: number;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  redisEnabled: boolean;
  calls: RecordedCall[];
  callsTo(upstream: Upstream, method?: string): RecordedCall[];
  /** Install (or clear with null) the per-call fault hook. */
  fault: FaultHook | null;
  sessions: Map<string, FakeSession>;
  users: Map<
    string,
    { id: string; email: string; provider: "google" | "apple" }
  >;
  consentRecords: ConsentRecordRow[];
  redis: Map<string, FakeRedisEntry>;
  redisCommands: Array<Array<string | number>>;
  /** RevenueCat subscriber JSON (null → HTTP 500) — never reached by this route. */
  subscriber: Record<string, unknown> | null;
  /** Wall-clock base for created_at stamps; bumps monotonically per insert. */
  clockMs: number;
  reset(): void;
  mintSession(
    userId: string,
    ttlSeconds?: number,
    provider?: "google" | "apple",
  ): FakeSession;
  /** Rows the fake holds for a user, in fold order. */
  rowsFor(userId: string): ConsentRecordRow[];
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
    const parsed = JSON.parse(b64urlDecode(seg)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function fakeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.${b64url("sig")}`;
}

/** mulberry32 — deterministic; identical to xc_concurrency_harness.ts so
 * seeds mean the same thing across the stress suites. */
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
  /** Printable ASCII garbage (never valid JSON by construction: starts with '<'). */
  garbage(length: number): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 {}[]":,\\';
    return "<" +
      Array.from({ length }, () => alphabet[this.int(0, alphabet.length - 1)])
        .join("");
  }
  text(length: number): string {
    const alphabet =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.";
    return Array.from(
      { length },
      () => alphabet[this.int(0, alphabet.length - 1)],
    ).join("");
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Base seed for every stress campaign; each case derives its own from it. */
export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
/** Load iterations (default small enough for the suite; the campaign run
 * used STRESS_ITER=1000+). */
export const STRESS_ITER = envInt("STRESS_ITER", 120);
/** Distinct users for the L1 memory campaign (campaign run: 20000). */
export const STRESS_USERS = envInt("STRESS_USERS", 600);

export function caseSeed(base: number, index: number): number {
  // splitmix-ish hop so neighbouring cases do not share PRNG prefixes
  let x = (base + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function classify(url: string): Upstream {
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/`)) return "auth";
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) return "postgrest";
  if (url.startsWith(REDIS_URL)) return "redis";
  if (url.startsWith(RC_URL)) return "revenuecat";
  return "other";
}

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const authError = (status: number, msg: string) =>
  jsonResponse(status, { code: status, msg, error_code: "bad_jwt" });

function gotrueUser(user: { id: string; email: string; provider: string }) {
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

function describeFault(fault: Fault): string {
  switch (fault.kind) {
    case "status":
      return `status:${fault.status}`;
    case "raw":
      return `raw:${fault.status}`;
    case "throw":
      return `throw:${fault.message ?? "network"}`;
    case "hang":
      return "hang";
    case "delay":
      return `delay:${fault.ms}${
        fault.then ? `+${describeFault(fault.then)}` : ""
      }`;
    case "afterReal":
      return `afterReal+${describeFault(fault.then)}`;
  }
}

let harness: StressHarness | null = null;
const bootedAt = performance.now();
const nowMs = () => Math.round((performance.now() - bootedAt) * 1000) / 1000;

export async function loadStressHarness(
  options: { redis?: boolean } = {},
): Promise<StressHarness> {
  if (harness) {
    if (Boolean(options.redis) !== harness.redisEnabled) {
      throw new Error(
        "stress harness already booted with a different redis setting — use another test module",
      );
    }
    harness.reset();
    return harness;
  }

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "stress-service-role-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.delete("APPLE_SIGN_IN_CLIENT_ID");
  Deno.env.delete("APPLE_SIGN_IN_TEAM_ID");
  Deno.env.delete("APPLE_SIGN_IN_KEY_ID");
  Deno.env.delete("APPLE_SIGN_IN_PRIVATE_KEY");
  Deno.env.delete("APPLE_TOKEN_ENCRYPTION_KEY");
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  let seq = 0;
  let rowSeq = 0;
  const perUpstream = new Map<string, number>();

  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    redisEnabled: Boolean(options.redis),
    calls: [],
    callsTo(upstream, method) {
      return state.calls.filter(
        (c) =>
          c.upstream === upstream &&
          (method === undefined || c.method === method),
      );
    },
    fault: null,
    sessions: new Map(),
    users: new Map(),
    consentRecords: [],
    redis: new Map(),
    redisCommands: [],
    subscriber: null,
    clockMs: Date.parse("2026-09-04T12:00:00.000Z"),
    reset() {
      state.calls = [];
      state.fault = null;
      state.sessions = new Map();
      state.users = new Map();
      state.consentRecords = [];
      state.redis = new Map();
      state.redisCommands = [];
      state.subscriber = null;
      state.clockMs = Date.parse("2026-09-04T12:00:00.000Z");
      perUpstream.clear();
    },
    mintSession(userId, ttlSeconds = 3600, provider = "google") {
      if (!state.users.has(userId)) {
        state.users.set(userId, {
          id: userId,
          email: `${userId.slice(0, 8)}@example.com`,
          provider,
        });
      }
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      const sessionId = crypto.randomUUID();
      const accessToken = fakeJwt({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: userId,
        aud: "authenticated",
        role: "authenticated",
        session_id: sessionId,
        exp: expiresAt,
        jti: crypto.randomUUID(),
      });
      const session: FakeSession = {
        userId,
        accessToken,
        sessionId,
        expiresAt,
        revoked: false,
      };
      state.sessions.set(accessToken, session);
      return session;
    },
    rowsFor(userId) {
      return state.consentRecords
        .filter((r) => r.user_id === userId)
        .sort((a, b) =>
          a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
        );
    },
  };

  const bearerOf = (headers: Record<string, string>) =>
    (headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");

  const realFake = (
    request: Request,
    url: URL,
    headers: Record<string, string>,
    body: unknown,
  ): Response => {
    const href = url.href;

    if (href === `${REDIS_URL}/pipeline`) {
      if (headers["authorization"] !== `Bearer ${REDIS_TOKEN}`) {
        return jsonResponse(401, { error: "Unauthorized" });
      }
      const commands = Array.isArray(body)
        ? (body as Array<Array<string | number>>)
        : [];
      return jsonResponse(
        200,
        commands.map((command) => runRedisCommand(state, command)),
      );
    }

    if (
      href.startsWith(`${SUPABASE_URL}/auth/v1/user`) &&
      request.method === "GET"
    ) {
      const session = state.sessions.get(bearerOf(headers));
      if (!session || session.revoked) {
        return authError(401, "invalid JWT: session not found");
      }
      if (session.expiresAt * 1000 <= Date.now()) {
        return authError(401, "invalid JWT: token is expired");
      }
      return jsonResponse(200, gotrueUser(state.users.get(session.userId)!));
    }

    if (href.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      const table = url.pathname.slice("/rest/v1/".length);
      if (table === "consent_records") {
        // RLS: a PostgREST call is scoped by the bearer's sub.
        const sub = jwtPayload(bearerOf(headers))?.sub;
        if (typeof sub !== "string") {
          return jsonResponse(401, {
            code: "PGRST301",
            message: "JWT expired",
            details: null,
            hint: null,
          });
        }
        if (request.method === "GET") {
          const eq = url.searchParams.get("user_id");
          const filterUser = eq?.startsWith("eq.") ? eq.slice(3) : null;
          const rows = state
            .rowsFor(sub)
            .filter((r) => filterUser === null || r.user_id === filterUser)
            .map((r) => ({
              scope: r.scope,
              action: r.action,
              consent_version: r.consent_version,
              created_at: r.created_at,
            }));
          return jsonResponse(200, rows, {
            "Content-Range": `0-${rows.length}/*`,
          });
        }
        if (request.method === "POST") {
          const items = Array.isArray(body) ? body : [body];
          const inserted: ConsentRecordRow[] = [];
          for (const item of items) {
            if (!isRecord(item)) {
              return jsonResponse(400, {
                code: "PGRST102",
                message: "Empty or invalid json",
              });
            }
            if (item.user_id !== sub) {
              return jsonResponse(403, {
                code: "42501",
                message:
                  'new row violates row-level security policy for table "consent_records"',
                details: null,
                hint: null,
              });
            }
            rowSeq += 1;
            state.clockMs += 1;
            const row: ConsentRecordRow = {
              id: `${
                String(rowSeq).padStart(8, "0")
              }-0000-4000-8000-000000000000`,
              user_id: sub,
              scope: String(item.scope),
              consent_version: typeof item.consent_version === "string"
                ? item.consent_version
                : null,
              action: item.action === "grant" ? "grant" : "withdraw",
              source: typeof item.source === "string" ? item.source : null,
              device: item.device ?? null,
              capture_mode: typeof item.capture_mode === "string"
                ? item.capture_mode
                : null,
              created_at: new Date(state.clockMs).toISOString(),
            };
            state.consentRecords.push(row);
            inserted.push(row);
          }
          const prefer = headers["prefer"] ?? "";
          if (prefer.includes("return=representation")) {
            return jsonResponse(201, inserted);
          }
          return new Response(null, { status: 201 });
        }
        return jsonResponse(405, {
          code: "PGRST",
          message: "method not allowed by fake",
        });
      }
      if (table.startsWith("rpc/")) {
        return jsonResponse(404, {
          code: "PGRST202",
          message: `Could not find the function public.${
            table.slice(4)
          } in the schema cache`,
        });
      }
      if (request.method === "GET") return jsonResponse(200, []);
      return new Response(null, { status: 201 });
    }

    if (href.startsWith(RC_URL)) {
      if (!state.subscriber) {
        return jsonResponse(500, { message: "RevenueCat unavailable" });
      }
      return jsonResponse(200, { subscriber: state.subscriber });
    }

    return new Response(
      `unexpected fetch in stress harness: ${request.method} ${href}`,
      {
        status: 599,
      },
    );
  };

  const applyFault = async (
    fault: Fault,
    request: Request,
    url: URL,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<Response> => {
    switch (fault.kind) {
      case "status":
        return jsonResponse(fault.status, fault.body, fault.headers ?? {});
      case "raw": {
        // 204/205/304 may not carry a body at all (Response would throw).
        const bodiless = fault.status === 204 || fault.status === 205 ||
          fault.status === 304;
        return new Response(bodiless ? null : fault.text, {
          status: fault.status,
          headers: { "Content-Type": fault.contentType ?? "application/json" },
        });
      }
      case "throw":
        throw new TypeError(
          fault.message ?? "error sending request: connection reset",
        );
      case "hang":
        // A real fetch never answers, but it DOES reject when the caller's
        // AbortSignal fires (cache.ts bounds Redis with
        // AbortSignal.timeout(REDIS_TIMEOUT_MS); index.ts bounds Auth with its
        // own deadline controller). Callers that pass no signal — PostgREST
        // through supabase-js — hang for real, which is the point.
        return new Promise<Response>((_resolve, reject) => {
          const signal = request.signal;
          if (signal.aborted) {
            reject(
              signal.reason ??
                new DOMException("The signal has been aborted", "AbortError"),
            );
            return;
          }
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason ??
                  new DOMException("The signal has been aborted", "AbortError"),
              ),
            { once: true },
          );
        });
      case "delay":
        await sleep(fault.ms);
        return fault.then
          ? applyFault(fault.then, request, url, headers, body)
          : realFake(request, url, headers, body);
      case "afterReal": {
        const real = await realFake(request, url, headers, body);
        await real.body?.cancel();
        return applyFault(fault.then, request, url, headers, body);
      }
    }
  };

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
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
    const upstream = classify(url.href);
    seq += 1;
    const nth = (perUpstream.get(upstream) ?? 0) + 1;
    perUpstream.set(upstream, nth);
    const methodKey = `${upstream}:${request.method}`;
    const nthOfMethod = (perUpstream.get(methodKey) ?? 0) + 1;
    perUpstream.set(methodKey, nthOfMethod);
    const record: RecordedCall = {
      seq,
      upstream,
      url: url.href,
      method: request.method,
      headers,
      body,
      startedMs: nowMs(),
      endedMs: null,
      outcome: "pending",
      fault: null,
    };
    state.calls.push(record);
    const fault = state.fault?.({
      upstream,
      url: url.href,
      method: request.method,
      headers,
      body,
      nth,
      nthOfMethod,
    });
    try {
      let response: Response;
      if (fault) {
        record.fault = describeFault(fault);
        response = await applyFault(fault, request, url, headers, body);
      } else {
        response = await realFake(request, url, headers, body);
      }
      record.outcome = String(response.status);
      record.endedMs = nowMs();
      // Honour the caller's abort (AbortSignal.timeout in cache.ts, the auth
      // deadline controller) the way a real socket would: the fetch rejects.
      if (init?.signal?.aborted) {
        throw new DOMException("The signal has been aborted", "AbortError");
      }
      return response;
    } catch (error) {
      record.outcome = error instanceof Error ? `${error.name}` : "thrown";
      record.endedMs = nowMs();
      throw error;
    }
  }) as typeof fetch;

  // A hung fake never settles, so an aborting caller must be released by the
  // signal itself: wrap fetch once more to race the signal.
  const faultyFetch = globalThis.fetch;
  globalThis.fetch =
    ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal ??
        (input instanceof Request ? input.signal : undefined);
      const attempt = faultyFetch(input, init);
      if (!signal) return attempt;
      return new Promise<Response>((resolve, reject) => {
        const onAbort = () => {
          const reason: unknown = signal.reason;
          reject(
            reason instanceof Error
              ? reason
              : new DOMException("The signal has been aborted", "AbortError"),
          );
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        attempt.then(
          (response) => {
            signal.removeEventListener("abort", onAbort);
            resolve(response);
          },
          (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
    }) as typeof fetch;

  Deno.serve = ((...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      | ((request: Request) => Promise<Response>)
      | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    state.handler = fn;
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

function redisLive(state: StressHarness, key: string): FakeRedisEntry | null {
  const entry = state.redis.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    state.redis.delete(key);
    return null;
  }
  return entry;
}

/** Minimal Upstash-compatible executor for the commands cache.ts issues. */
export function runRedisCommand(
  state: StressHarness,
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
      return {
        result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000)),
      };
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
      if (args[2] === "NX" && Number.isFinite(entry.expiresAtMs)) {
        return { result: 0 };
      }
      entry.expiresAtMs = Date.now() + Number(args[1]) * 1000;
      return { result: 1 };
    }
    default:
      return { error: `ERR unknown command '${op}'` };
  }
}

let ipCounter = 0;
/** A fresh client IP per request so per-IP budgets never bleed across cases. */
export function freshIp(): string {
  ipCounter += 1;
  return `203.0.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

export function apiRequest(
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
    "x-forwarded-for": options.ip ?? freshIp(),
    ...options.headers,
  });
  if (options.token !== null && options.token !== undefined) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }
  const hasBody = options.body !== undefined || options.rawBody !== undefined;
  if (hasBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(`http://edge.test/functions/v1/api${path}`, {
    method,
    headers,
    body: options.rawBody ??
      (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
}

export function withdrawRequest(
  token: string | null,
  body: unknown,
  options: { ip?: string; headers?: Record<string, string>; rawBody?: string } =
    {},
): Request {
  return apiRequest("POST", "/v1/me/consent/withdraw", {
    token,
    body: options.rawBody === undefined ? body : undefined,
    rawBody: options.rawBody,
    ip: options.ip,
    headers: options.headers,
  });
}

// ── Observed response ────────────────────────────────────────────────────────

export interface Observed {
  status: number;
  /** error.code when the body is a coded error */
  code: string | null;
  /** error.message when present */
  message: string | null;
  /** parsed JSON body (null when not JSON) */
  body: unknown;
  requestId: string | null;
  retryAfter: string | null;
  rateLimitRemaining: string | null;
  durationMs: number;
}

export async function observe(
  handler: (request: Request) => Promise<Response>,
  request: Request,
): Promise<Observed> {
  const started = performance.now();
  const response = await handler(request);
  const text = await response.text();
  const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text === "" ? null : { nonJson: text.slice(0, 200) };
  }
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  return {
    status: response.status,
    code: typeof error?.code === "string" ? error.code : null,
    message: typeof error?.message === "string" ? error.message : null,
    body,
    requestId: response.headers.get("x-request-id"),
    retryAfter: response.headers.get("Retry-After"),
    rateLimitRemaining: response.headers.get("RateLimit-Remaining"),
    durationMs,
  };
}

/** Race the handler against a wall-clock budget; "hung" when it never answers. */
export async function observeWithin(
  handler: (request: Request) => Promise<Response>,
  request: Request,
  budgetMs: number,
): Promise<Observed | "hung"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => resolve("hung"), budgetMs);
  });
  try {
    return await Promise.race([observe(handler, request), budget]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ScopeStatus {
  scope: string;
  active: boolean;
  consentVersion: string | null;
  lastAction: "granted" | "withdrawn" | null;
  lastActionAt: string | null;
}

export function scopesOf(body: unknown): ScopeStatus[] | null {
  if (!isRecord(body) || !Array.isArray(body.scopes)) return null;
  return body.scopes as ScopeStatus[];
}

/** Bodies that leak upstream detail would violate the "generic 5xx" rule. */
export function leaksInternalDetail(text: string): boolean {
  return /PGRST|postgres|supabase\.stress\.test|upstash|stack|TypeError|SyntaxError|Error:/i
    .test(
      text,
    );
}

// ── Reports ──────────────────────────────────────────────────────────────────

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress/route-post-v1-me-consent-withdraw/latest/",
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

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

export function histogram(
  values: Array<string | number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}
