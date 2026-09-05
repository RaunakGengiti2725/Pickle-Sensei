// stress_* — FAILURE-INJECTION + LOAD harness for POST /v1/shots:sync.
//
// Boots the REAL ../index.ts (Deno.serve captured) behind a fetch that models
// every upstream the route can touch — Supabase Auth (GET /auth/v1/user),
// PostgREST (the batched replay SELECT on `shots`, the per-shot
// `apply_synced_shot` RPC), Upstash Redis (REST /pipeline; L2 cache + shared
// rate-limit windows) and RevenueCat (never on this route: its counter is
// asserted to stay 0) — and lets a test make any ONE of them fail, time out,
// or answer nonsense, per call, deterministically.
//
// State (sessions, permits, shots, the identity ledger) is the stateful
// FakeSupabase model from xc_concurrency_harness.ts (statement-for-statement
// mirror of the RPC migrations), so "was the row written?" is answerable after
// every fault — the difference between a transient failure and a lost write.
//
// Nothing here talks to a network. Every campaign is driven by a seeded PRNG
// (mulberry32) and every case records its seed, its payload, the fault, the
// response, the upstream counters and the client-side verdict the mobile
// outbox would reach (mirrors apps/mobile/src/data/sync.ts).

import {
  FakeSupabase,
  isRecord,
  Prng,
  SUPABASE_URL,
  syncShotPayload,
} from "./xc_concurrency_harness.ts";

export {
  envInt,
  histogram,
  isRecord,
  Prng,
  SUPABASE_URL,
  syncShotPayload,
} from "./xc_concurrency_harness.ts";

export const REDIS_URL = "http://upstash.stress.test";
export const REDIS_TOKEN = "stress-upstash-token";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
const ANON_KEY = "xc-anon-key";
const SERVICE_ROLE_KEY = "xc-service-role-key";

// ── Fault model ──────────────────────────────────────────────────────────────

export type FaultTarget = "auth" | "rest.select" | "rest.rpc" | "redis" | "revenuecat";

export type FaultMode =
  | "http_400"
  | "http_401"
  | "http_403"
  | "http_404"
  | "http_406"
  | "http_409"
  | "http_429"
  | "http_500"
  | "http_502"
  | "http_503"
  | "http_504"
  | "timeout"
  | "network_error"
  | "malformed_json"
  | "empty_body"
  | "html_body"
  | "wrong_shape_object"
  | "wrong_shape_array"
  | "wrong_shape_null"
  | "wrong_shape_number"
  | "wrong_shape_string"
  | "user_without_provider"
  | "unknown_status"
  | "unknown_status_control_chars"
  | "sqlstate_status"
  | "per_command_error"
  | "short_reply"
  | "huge_counter"
  | "nan_counter"
  | "string_marker"
  | "slow_ok";

export interface Fault {
  target: FaultTarget;
  mode: FaultMode;
  /** Which calls to the target the fault applies to: every call (default), or
   * only the call with this 0-based ordinal within the case. */
  only?: number;
  /** Latency (ms) for slow_ok; for timeout on targets without a caller
   * deadline (PostgREST) the fault answers after this long. */
  delayMs?: number;
  /** Let the upstream perform the real work (the RPC commits) and THEN lose
   * the answer — the "wrote but the reply never arrived" shape that turns a
   * transient failure into a duplicate write if replay is not idempotent. */
  afterWrite?: boolean;
  /** Retry-After seconds the 429/503 answers carry (default 1 — the real
   * PostgREST schema-cache 503 sends one, and postgrest-js honours it). */
  retryAfterSeconds?: number;
}

const jsonResponse = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolve when `signal` aborts (the caller's deadline), rejecting like fetch
 * does; without a signal fall back to `fallbackMs` so a test can never hang. */
function hangUntilAborted(
  signal: AbortSignal | null | undefined,
  fallbackMs: number,
): Promise<never> {
  return new Promise<never>((_, reject) => {
    const abort = () => reject(new DOMException("The signal has been aborted", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    setTimeout(abort, fallbackMs);
  });
}

export class FaultInjector {
  faults: Fault[] = [];
  private ordinals = new Map<FaultTarget, number>();
  /** Every fault actually applied, in order (evidence the case fired). */
  applied: Array<{ target: FaultTarget; mode: FaultMode; ordinal: number }> = [];

  arm(...faults: Fault[]): void {
    this.faults = faults;
    this.ordinals.clear();
    this.applied = [];
  }

  clear(): void {
    this.faults = [];
    this.ordinals.clear();
  }

  /** The fault (if any) that applies to this call of `target`. */
  pick(target: FaultTarget): Fault | null {
    const ordinal = this.ordinals.get(target) ?? 0;
    this.ordinals.set(target, ordinal + 1);
    const fault = this.faults.find(
      (f) => f.target === target && (f.only === undefined || f.only === ordinal),
    );
    if (fault) this.applied.push({ target, mode: fault.mode, ordinal });
    return fault ?? null;
  }
}

/** Render `fault` as an upstream answer. `real` produces the healthy answer
 * (used by slow_ok and by modes that wrap it). Throws for connection-level
 * faults exactly like fetch would. */
async function renderFault(
  fault: Fault,
  signal: AbortSignal | null | undefined,
  real: () => Promise<Response>,
  rawBody: string,
): Promise<Response> {
  const retryAfter = { "Retry-After": String(fault.retryAfterSeconds ?? 1) };
  /** Upstash pipeline answer with the results of `ops` replaced by `value`
   * (everything else answered by the model) — a Redis that is up but lies
   * about one command class. */
  const corruptPipeline = async (ops: string[], value: unknown): Promise<Response> => {
    let commands: Array<Array<string | number>> = [];
    try {
      const parsed = JSON.parse(rawBody);
      if (Array.isArray(parsed)) commands = parsed;
    } catch {
      // fall through with no commands
    }
    const healthy = (await (await real()).json().catch(() => [])) as Array<Record<string, unknown>>;
    const answer = commands.map((command, i) =>
      ops.includes(String(command[0]).toUpperCase())
        ? { result: value }
        : (healthy[i] ?? { result: null }),
    );
    return jsonResponse(200, answer);
  };
  switch (fault.mode) {
    case "http_400":
      return jsonResponse(400, {
        code: "PGRST202",
        message: "Could not find the function",
        hint: null,
        details: null,
      });
    case "http_401":
      return fault.target === "auth"
        ? jsonResponse(401, {
            code: 401,
            error_code: "bad_jwt",
            msg: "invalid JWT: unable to parse or verify signature",
          })
        : jsonResponse(401, {
            code: "PGRST301",
            message: "JWT expired",
            hint: null,
            details: null,
          });
    case "http_403":
      return fault.target === "auth"
        ? jsonResponse(403, {
            code: 403,
            error_code: "session_not_found",
            msg: "Session from session_id claim in JWT does not exist",
          })
        : jsonResponse(403, {
            code: "42501",
            message: "permission denied for table shots",
            hint: null,
            details: null,
          });
    case "http_404":
      return jsonResponse(404, {
        code: "PGRST205",
        message: "Could not find the table 'public.shots' in the schema cache",
        hint: null,
        details: null,
      });
    case "http_406":
      return jsonResponse(406, {
        code: "PGRST116",
        message: "JSON object requested, multiple (or no) rows returned",
        hint: null,
        details: null,
      });
    case "http_409":
      return jsonResponse(409, {
        code: "23505",
        message: 'duplicate key value violates unique constraint "shots_pkey"',
        hint: null,
        details: "Key (id)=(…) already exists.",
      });
    case "http_429":
      return jsonResponse(429, { message: "Too many requests" }, retryAfter);
    case "http_500":
      return jsonResponse(500, {
        message: "Internal Server Error",
        details: 'connection to server at "db.internal" failed: FATAL: too many connections',
      });
    case "http_502":
      return new Response("<html><body><h1>502 Bad Gateway</h1><p>cloudflare</p></body></html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      });
    case "http_503":
      return jsonResponse(503, { message: "Service Unavailable" }, retryAfter);
    case "http_504":
      return new Response("upstream request timeout", {
        status: 504,
        headers: { "Content-Type": "text/plain" },
      });
    case "timeout":
      return hangUntilAborted(signal, fault.delayMs ?? 1_500);
    case "network_error":
      throw new TypeError("error sending request for url: connection reset by peer");
    case "malformed_json":
      return new Response('{"id":"trunc', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    case "empty_body":
      return new Response("", { status: 200, headers: { "Content-Type": "application/json" } });
    case "html_body":
      return new Response("<!doctype html><html><body>Maintenance</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    case "wrong_shape_object":
      return jsonResponse(200, { unexpected: true });
    case "wrong_shape_array":
      return jsonResponse(200, [{ unexpected: true }]);
    case "wrong_shape_null":
      return jsonResponse(200, null);
    case "wrong_shape_number":
      return jsonResponse(200, 42);
    case "wrong_shape_string":
      return jsonResponse(200, "definitely-not-a-status");
    case "user_without_provider":
      return jsonResponse(200, {
        id: "99999999-9999-4999-8999-999999999999",
        aud: "authenticated",
        role: "authenticated",
        email: "x@example.com",
        app_metadata: {},
        user_metadata: {},
      });
    case "unknown_status":
      return jsonResponse(200, "shot.mystery_status");
    case "unknown_status_control_chars":
      return jsonResponse(
        200,
        "shot.write_failed:\u001b[31mXX000\n[api] forged log line\r\n" + "A".repeat(4_000),
      );
    case "sqlstate_status":
      return jsonResponse(200, "shot.write_failed:40P01");
    case "per_command_error":
      return jsonResponse(200, [
        { error: "ERR max requests limit exceeded" },
        { error: "ERR max requests limit exceeded" },
        { error: "ERR max requests limit exceeded" },
      ]);
    case "short_reply":
      return jsonResponse(200, []);
    case "huge_counter":
      return corruptPipeline(["INCR"], 1_000_000_000);
    case "nan_counter":
      return corruptPipeline(["INCR"], "not-a-number");
    case "string_marker":
      return corruptPipeline(["GET"], "1");
    case "slow_ok": {
      await sleep(fault.delayMs ?? 800);
      return real();
    }
  }
}

// ── Upstash model ────────────────────────────────────────────────────────────

export interface RedisEntry {
  value: string;
  expiresAtMs: number;
}

export class FakeRedis {
  store = new Map<string, RedisEntry>();
  commands = 0;
  pipelines = 0;

  reset(): void {
    this.store.clear();
    this.commands = 0;
    this.pipelines = 0;
  }

  private live(key: string): RedisEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  run(command: Array<string | number>): { result?: unknown; error?: string } {
    this.commands += 1;
    const [op, ...args] = command.map((part) => String(part));
    switch (op) {
      case "GET":
        return { result: this.live(args[0])?.value ?? null };
      case "TTL": {
        const entry = this.live(args[0]);
        if (!entry) return { result: -2 };
        if (!Number.isFinite(entry.expiresAtMs)) return { result: -1 };
        return { result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000)) };
      }
      case "SET": {
        const ttl = args[2] === "EX" ? Number(args[3]) : NaN;
        this.store.set(args[0], {
          value: args[1],
          expiresAtMs: Number.isFinite(ttl) ? Date.now() + ttl * 1000 : Infinity,
        });
        return { result: "OK" };
      }
      case "DEL": {
        let removed = 0;
        for (const key of args) if (this.store.delete(key)) removed += 1;
        return { result: removed };
      }
      case "INCR": {
        const entry = this.live(args[0]);
        const next = (entry ? Number(entry.value) : 0) + 1;
        this.store.set(args[0], {
          value: String(next),
          expiresAtMs: entry?.expiresAtMs ?? Infinity,
        });
        return { result: next };
      }
      case "EXPIRE": {
        const entry = this.live(args[0]);
        if (!entry) return { result: 0 };
        if (args[2] === "NX" && Number.isFinite(entry.expiresAtMs)) return { result: 0 };
        entry.expiresAtMs = Date.now() + Number(args[1]) * 1000;
        return { result: 1 };
      }
      default:
        return { error: `ERR unknown command '${op}'` };
    }
  }

  pipeline(commands: Array<Array<string | number>>) {
    this.pipelines += 1;
    return commands.map((command) => this.run(command));
  }
}

// ── Loading the real handler ─────────────────────────────────────────────────

export interface UpstreamCall {
  t: number;
  target: FaultTarget | "other";
  method: string;
  url: string;
  hadSignal: boolean;
  fault: FaultMode | null;
  ms: number;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  fake: FakeSupabase;
  redis: FakeRedis;
  injector: FaultInjector;
  /** Every upstream call, in order (round-trip evidence). */
  calls: UpstreamCall[];
  counters: Record<string, number>;
  /** Drop per-case evidence (not the model). */
  resetEvidence(): void;
}

function classify(url: URL, method: string): FaultTarget | "other" {
  if (url.href.startsWith(RC_URL)) return "revenuecat";
  if (url.origin === REDIS_URL) return "redis";
  if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/")) return "auth";
  if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/rpc/")) return "rest.rpc";
  if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/") && method === "GET") {
    return "rest.select";
  }
  return "other";
}

let loaded: StressHarness | null = null;

/** Boot the real edge function once per test module. `redis` fixes whether
 * cache.ts sees Upstash (it reads its env at import). `authTimeoutMs` is
 * read by the function per call (AUTH_UPSTREAM_TIMEOUT_MS), so auth timeout
 * cases run in well under a second; it is set only for the duration of each
 * handler call because `Deno.env` is shared with every other test module in
 * the run. */
export async function loadStressHarness(
  options: { redis?: boolean; authTimeoutMs?: number } = {},
): Promise<StressHarness> {
  if (loaded) {
    loaded.resetEvidence();
    return loaded;
  }
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  const authTimeoutMs = String(options.authTimeoutMs ?? 400);
  for (const key of [
    "APPLE_SIGN_IN_CLIENT_ID",
    "APPLE_SIGN_IN_TEAM_ID",
    "APPLE_SIGN_IN_KEY_ID",
    "APPLE_SIGN_IN_PRIVATE_KEY",
    "APPLE_TOKEN_ENCRYPTION_KEY",
  ]) {
    Deno.env.delete(key);
  }
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const fake = new FakeSupabase(1, 0);
  const redis = new FakeRedis();
  const injector = new FaultInjector();
  const calls: UpstreamCall[] = [];
  const counters: Record<string, number> = {};
  const t0 = performance.now();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const target = classify(url, request.method);
    const rawBody = await request.text().catch(() => "");
    const started = performance.now();
    const fault = target === "other" ? null : injector.pick(target);
    const record: UpstreamCall = {
      t: Math.round((started - t0) * 100) / 100,
      target,
      method: request.method,
      url: request.url,
      hadSignal: Boolean(init?.signal),
      fault: fault?.mode ?? null,
      ms: 0,
    };
    calls.push(record);
    counters[target] = (counters[target] ?? 0) + 1;

    const real = (): Promise<Response> => {
      if (target === "redis") {
        if (url.pathname !== "/pipeline") {
          return Promise.resolve(jsonResponse(404, { error: "not found" }));
        }
        if (request.headers.get("authorization") !== `Bearer ${REDIS_TOKEN}`) {
          return Promise.resolve(jsonResponse(401, { error: "Unauthorized" }));
        }
        let commands: Array<Array<string | number>> = [];
        try {
          const parsed = JSON.parse(rawBody);
          if (Array.isArray(parsed)) commands = parsed;
        } catch {
          return Promise.resolve(jsonResponse(400, { error: "ERR bad request" }));
        }
        return Promise.resolve(jsonResponse(200, redis.pipeline(commands)));
      }
      if (target === "revenuecat") {
        return Promise.resolve(
          jsonResponse(200, { request_date_ms: Date.now(), subscriber: { entitlements: {} } }),
        );
      }
      return fake.handleFetch(request, rawBody);
    };

    try {
      if (fault) {
        if (fault.afterWrite) await (await real()).text().catch(() => undefined);
        return await renderFault(fault, init?.signal ?? null, real, rawBody);
      }
      return await real();
    } finally {
      record.ms = Math.round((performance.now() - started) * 100) / 100;
    }
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
  const serve = handler;

  loaded = {
    async handler(request) {
      const previous = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
      Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", authTimeoutMs);
      try {
        return await serve(request);
      } finally {
        if (previous === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
        else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previous);
      }
    },
    fake,
    redis,
    injector,
    calls,
    counters,
    resetEvidence() {
      calls.length = 0;
      for (const key of Object.keys(counters)) delete counters[key];
      injector.applied = [];
    },
  };
  return loaded;
}

// ── Users, permits and requests ──────────────────────────────────────────────

export interface StressUser {
  id: string;
  accessToken: string;
  ip: string;
}

/** A signed-in user with a live Supabase session in the fake GoTrue. */
export function mintUser(h: StressHarness, prng: Prng, ip?: string): StressUser {
  const id = prng.uuid();
  h.fake.ensureUser(id, "google");
  const session = h.fake.mintSession(id, "google");
  return { id, accessToken: session.accessToken, ip: ip ?? randomIp(prng) };
}

export function randomIp(prng: Prng): string {
  return `203.0.${prng.int(0, 255)}.${prng.int(1, 254)}`;
}

/** Reserve a permit row directly in the model (as the RPC would). */
export function reservePermit(h: StressHarness, prng: Prng, userId: string): string {
  const id = prng.uuid();
  h.fake.tables.analysis_permits.push({
    id,
    user_id: userId,
    idempotency_key: prng.uuid(),
    status: "reserved",
    outcome: null,
    created_at: new Date().toISOString(),
  });
  return id;
}

export function grantPremium(h: StressHarness, userId: string): void {
  h.fake.tables.billing_entitlements.push({
    user_id: userId,
    premium: true,
    expires_at: null,
  });
}

/** `count` valid shots (each with its own reserved permit) for `user`. */
export function buildShots(
  h: StressHarness,
  prng: Prng,
  userId: string,
  count: number,
  overrides: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () =>
    syncShotPayload(prng.uuid(), reservePermit(h, prng, userId), {
      overallScore: prng.int(0, 100) / 10,
      confidence: prng.int(50, 100) / 100,
      shotType: ["dink", "drive", "third_shot_drop", "serve"][prng.int(0, 3)],
      ...overrides,
    }),
  );
}

export function syncRequest(
  user: StressUser,
  shots: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://edge.stress.test/functions/v1/api/v1/shots:sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${user.accessToken}`,
      "x-forwarded-for": user.ip,
      ...headers,
    },
    body: JSON.stringify({ shots }),
  });
}

export interface Outcome {
  status: number;
  body: Record<string, unknown>;
  bodyText: string;
  headers: Record<string, string>;
  ms: number;
  acceptedIds: string[];
  rejected: Array<{ id: string; code: string; message: string }>;
}

export async function send(h: StressHarness, request: Request): Promise<Outcome> {
  const t0 = performance.now();
  const response = await h.handler(request);
  const bodyText = await response.text();
  const ms = Math.round((performance.now() - t0) * 100) / 100;
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(bodyText);
    body = isRecord(parsed) ? parsed : { _value: parsed };
  } catch {
    body = { _raw: bodyText };
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
  const acceptedIds = Array.isArray(body.acceptedIds) ? (body.acceptedIds as string[]) : [];
  const rejected = Array.isArray(body.rejected)
    ? (body.rejected as Array<{ id: string; code: string; message: string }>)
    : [];
  return { status: response.status, body, bodyText, headers, ms, acceptedIds, rejected };
}

// ── Client verdict (mirrors apps/mobile/src/data/sync.ts) ────────────────────

/** Per-item rejection codes the outbox keeps retrying without spending the
 * row's attempt budget (TRANSIENT_SYNC_REJECTION_CODES). */
export const TRANSIENT_REJECTION_CODES = new Set([
  "shot.write_failed",
  "evaluation.trial_write_failed",
  "auth.required",
  "shot.session_not_found",
]);

export type Verdict =
  | "accepted"
  | "rejected_transient"
  | "rejected_contract"
  | "request_transient"
  | "request_auth_retry"
  | "request_rate_limited"
  | "request_permanent";

/** What the mobile outbox concludes for ONE shot id from the response: the
 * whole-request status decides first (isPermanentSyncFailure), then the
 * per-item code (isTransientSyncRejection). */
export function verdictFor(outcome: Outcome, shotId: string): Verdict {
  const { status } = outcome;
  if (status === 200) {
    if (outcome.acceptedIds.includes(shotId)) return "accepted";
    const rejection = outcome.rejected.find((r) => r.id === shotId);
    if (!rejection) return "request_permanent";
    return TRANSIENT_REJECTION_CODES.has(rejection.code)
      ? "rejected_transient"
      : "rejected_contract";
  }
  if (status === 401) return "request_auth_retry";
  if (status === 429) return "request_rate_limited";
  if (status === 408 || status >= 500) return "request_transient";
  return "request_permanent";
}

/** Error class as the client sees it: HTTP status + error.code (or message). */
export function errorClass(outcome: Outcome): string {
  const error = isRecord(outcome.body.error) ? outcome.body.error : null;
  if (outcome.status === 200) {
    const codes = [...new Set(outcome.rejected.map((r) => r.code))].sort();
    return codes.length ? `200 rejected:${codes.join("|")}` : "200 accepted";
  }
  if (error) {
    const code = typeof error.code === "string" ? error.code : null;
    const message = typeof error.message === "string" ? error.message : "";
    return `${outcome.status} ${code ?? message}`;
  }
  return `${outcome.status} ${outcome.bodyText.slice(0, 60)}`;
}

/** Strings a 5xx body must never carry (server-side detail). */
const LEAK_MARKERS = [
  "PGRST",
  "postgres",
  "relation ",
  "FATAL",
  "db.internal",
  "cloudflare",
  "stack",
  "at async",
  SUPABASE_URL,
  "shots_pkey",
  "connection reset",
];

export function leaks(outcome: Outcome): string[] {
  if (outcome.status < 500) return [];
  return LEAK_MARKERS.filter((marker) => outcome.bodyText.includes(marker));
}

// ── Model inspection ─────────────────────────────────────────────────────────

export function ownedShotIds(h: StressHarness, userId: string): Set<string> {
  return new Set(h.fake.tables.shots.filter((s) => s.user_id === userId).map((s) => String(s.id)));
}

export function permitStatus(h: StressHarness, permitId: string): string {
  const row = h.fake.tables.analysis_permits.find((p) => p.id === permitId);
  return row ? `${row.status}/${row.outcome ?? ""}` : "missing";
}

export function ledgerCount(h: StressHarness, userId: string): number {
  return h.fake.identityLedger.get(`google:${userId}`) ?? 0;
}

// ── Stats + reporting ────────────────────────────────────────────────────────

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function summarize(values: number[]) {
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    n: values.length,
    min: values.length ? Math.min(...values) : 0,
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length ? Math.max(...values) : 0,
    mean: values.length ? Math.round((sum / values.length) * 100) / 100 : 0,
  };
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-shots-sync/latest/", import.meta.url).pathname;
}

export async function writeArtifact(name: string, payload: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(payload, null, 2));
  return path;
}

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
