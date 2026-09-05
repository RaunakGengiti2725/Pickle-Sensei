/**
 * stress — failure-injection + load harness for `POST /v1/shots:sync`.
 *
 * Boots the REAL edge handler (../index.ts, Deno.serve captured) over the
 * stateful FakeSupabase model from xc_concurrency_harness.ts, and puts a
 * FAULT LAYER between the handler and every upstream it talks to:
 *
 *   gotrue.user   GET  /auth/v1/user            (session verification)
 *   rest.select   GET  /rest/v1/shots?…         (idempotent replay lookup)
 *   rest.rpc      POST /rest/v1/rpc/apply_synced_shot
 *   redis         POST <UPSTASH>/pipeline       (L2 cache + shared rate limits)
 *   revenuecat    GET  api.revenuecat.com/…     (never on this route — proven)
 *
 * A FaultPlan decides, per upstream call, whether the call is answered by the
 * healthy model or by a fault: an HTTP status with any body (5xx, 4xx, 429,
 * malformed 2xx), a connection-level throw, a hang that honours the caller's
 * AbortSignal (so the edge's own deadlines are what end it), or
 * "after-commit" — the healthy model performs the write and its answer is
 * then replaced by a fault (the response-lost / commit-then-crash case that
 * makes duplicate delivery real).
 *
 * Everything is deterministic from a seed (Prng): user/shot/permit ids, batch
 * shapes, which shot of a batch the fault lands on. Every upstream call is
 * recorded with the request tag it belongs to, so round trips per request
 * are exact evidence, not an estimate.
 *
 * Nothing here opens a socket. The Upstash tier is opt-in per isolate
 * (cache.ts reads UPSTASH_* at import), so the Redis-enabled suite lives in
 * its own test module.
 */
import {
  b64url,
  envInt,
  FakeSupabase,
  isRecord,
  jwtPayload,
  Prng,
  RC_URL,
  sleep,
  SUPABASE_URL,
  syncShotPayload,
} from "./xc_concurrency_harness.ts";

export { Prng, syncShotPayload };

export const STRESS_REDIS_URL = "http://upstash.stress.test";
export const STRESS_REDIS_TOKEN = "upstash-stress-token";
/** Deadline the edge gives one Supabase Auth round trip in these suites
 * (AUTH_UPSTREAM_TIMEOUT_MS; production default 6 000 ms). Short so hang
 * cases finish quickly, long enough for two connect retries (100 + 200 ms). */
export const STRESS_AUTH_TIMEOUT_MS = 600;

export type Upstream =
  | "gotrue.user"
  | "gotrue.other"
  | "rest.select"
  | "rest.rpc"
  | "rest.other"
  | "redis"
  | "revenuecat"
  | "unknown";

export interface UpstreamCall {
  seq: number;
  /** ms since harness load */
  t: number;
  upstream: Upstream;
  method: string;
  url: string;
  /** Request tag active when the call was made (sequential drivers). */
  tag: string | null;
  /** Fault kind applied, or null when the healthy model answered. */
  fault: string | null;
  durationMs: number;
}

export type FaultAction =
  | {
    kind: "http";
    status: number;
    body: string;
    headers?: Record<string, string>;
  }
  | { kind: "throw"; message?: string }
  /** Never answers before `ms`; rejects with AbortError as soon as the
   * caller's signal aborts (a real socket would). */
  | { kind: "hang"; ms: number }
  /** Answers healthily, but only after `ms` (rejects with AbortError if the
   * caller's signal fires first) — a slow upstream against the caller's
   * deadline, or the lack of one. */
  | { kind: "slow"; ms: number }
  /** Let the healthy model perform the call (state mutates), discard its
   * answer, then act as `then`. */
  | { kind: "after-commit"; then: FaultAction };

export interface FaultContext {
  upstream: Upstream;
  /** Zero-based index of this call among calls to the same upstream since
   * the plan was installed. */
  nth: number;
  method: string;
  url: string;
  body: unknown;
}

export type FaultPlan = (call: FaultContext) => FaultAction | null;

export interface FakeRedisEntry {
  value: string;
  /** Unix ms; Infinity = no expiry. */
  expiresAtMs: number;
}

export class FakeRedis {
  store = new Map<string, FakeRedisEntry>();
  commands: Array<Array<string | number>> = [];

  reset(): void {
    this.store.clear();
    this.commands = [];
  }

  private live(key: string): FakeRedisEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  run(command: Array<string | number>): { result?: unknown; error?: string } {
    this.commands.push(command);
    const [op, ...args] = command.map((part) => String(part));
    switch (op) {
      case "GET":
        return { result: this.live(args[0])?.value ?? null };
      case "TTL": {
        const entry = this.live(args[0]);
        if (!entry) return { result: -2 };
        if (!Number.isFinite(entry.expiresAtMs)) return { result: -1 };
        return {
          result: Math.max(
            1,
            Math.ceil((entry.expiresAtMs - Date.now()) / 1000),
          ),
        };
      }
      case "SET": {
        const ttl = args[2] === "EX" ? Number(args[3]) : NaN;
        this.store.set(args[0], {
          value: args[1],
          expiresAtMs: Number.isFinite(ttl)
            ? Date.now() + ttl * 1000
            : Infinity,
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
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  fake: FakeSupabase;
  redis: FakeRedis;
  redisEnabled: boolean;
  calls: UpstreamCall[];
  /** Install (or clear) the fault plan; resets per-upstream call indexes. */
  setFault(plan: FaultPlan | null): void;
  /** Tag subsequent upstream calls (sequential drivers only). */
  tag(tag: string | null): void;
  /** Calls recorded under `tag`. */
  callsFor(tag: string): UpstreamCall[];
  /** Fresh model state (tables, sessions, redis store) for a scenario. */
  reset(seed: number): void;
  /** Optional real backend for PostgREST calls (`rest.select` / `rest.rpc`):
   * return a Response to answer the call, or null to let the fake model
   * answer. Faults still apply on top (they wrap the healthy path). */
  restBackend:
    | ((
      request: Request,
      rawBody: string,
      body: unknown,
    ) => Promise<Response | null>)
    | null;
}

let loaded: StressHarness | null = null;

function classifyUrl(request: Request): Upstream {
  const url = request.url;
  if (url.startsWith(RC_URL)) return "revenuecat";
  if (url.startsWith(`${STRESS_REDIS_URL}/`)) return "redis";
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) return "gotrue.user";
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/`)) return "gotrue.other";
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`)) return "rest.rpc";
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
    return request.method === "GET" ? "rest.select" : "rest.other";
  }
  return "unknown";
}

class HarnessAbortError extends DOMException {
  constructor() {
    super("The signal has been aborted", "AbortError");
  }
}

function hangUntil(
  ms: number,
  signal: AbortSignal | null | undefined,
): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(new HarnessAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("stress: hang elapsed without the caller aborting"));
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new HarnessAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Like hangUntil but resolves (to `fallthrough`) once `ms` elapsed and the
 * caller never aborted — models a slow upstream with no deadline on the
 * caller's side. */
function delayOrAbort(
  ms: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HarnessAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new HarnessAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** index.ts reads AUTH_UPSTREAM_TIMEOUT_MS on EVERY Auth call, and `deno task
 * test` runs every module in one process, so the short stress deadline is
 * set only while stress requests are in flight (ref-counted for concurrent
 * lanes) and the previous value is restored when the last one settles —
 * a later module's network-auth matrix must see the production default. */
function withStressAuthDeadline(
  inner: StressHarness["handler"],
): StressHarness["handler"] {
  let inFlight = 0;
  let previous: string | undefined;
  return async (request: Request) => {
    if (inFlight === 0) {
      previous = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
      Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(STRESS_AUTH_TIMEOUT_MS));
    }
    inFlight += 1;
    try {
      return await inner(request);
    } finally {
      inFlight -= 1;
      if (inFlight === 0) {
        if (previous === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
        else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previous);
      }
    }
  };
}

/** Boot the real edge function once per isolate. `redis: true` wires the fake
 * Upstash endpoint (fixed at first load: cache.ts reads its env at import). */
export async function loadStressHarness(
  options: { redis?: boolean } = {},
): Promise<StressHarness> {
  if (loaded) return loaded;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "xc-anon-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "xc-service-role-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "xc-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  Deno.env.delete("APPLE_SIGN_IN_CLIENT_ID");
  Deno.env.delete("APPLE_SIGN_IN_TEAM_ID");
  Deno.env.delete("APPLE_SIGN_IN_KEY_ID");
  Deno.env.delete("APPLE_SIGN_IN_PRIVATE_KEY");
  Deno.env.delete("APPLE_TOKEN_ENCRYPTION_KEY");
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", STRESS_REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", STRESS_REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const fake = new FakeSupabase(1, 0);
  const redis = new FakeRedis();
  const calls: UpstreamCall[] = [];
  let plan: FaultPlan | null = null;
  let planCounts = new Map<Upstream, number>();
  let currentTag: string | null = null;
  let seq = 0;
  const t0 = performance.now();

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const healthy = async (
    upstream: Upstream,
    request: Request,
    rawBody: string,
    body: unknown,
  ): Promise<Response> => {
    if (upstream === "redis") {
      if (
        request.headers.get("authorization") !== `Bearer ${STRESS_REDIS_TOKEN}`
      ) {
        return jsonResponse(401, { error: "Unauthorized" });
      }
      const commands = Array.isArray(body)
        ? (body as Array<Array<string | number>>)
        : [];
      return jsonResponse(
        200,
        commands.map((command) => redis.run(command)),
      );
    }
    if (
      (upstream === "rest.select" || upstream === "rest.rpc") &&
      loaded?.restBackend
    ) {
      const answered = await loaded.restBackend(request, rawBody, body);
      if (answered) return answered;
    }
    return fake.handleFetch(request, rawBody);
  };

  const act = async (
    action: FaultAction,
    upstream: Upstream,
    request: Request,
    rawBody: string,
    body: unknown,
    signal: AbortSignal | null | undefined,
  ): Promise<Response> => {
    switch (action.kind) {
      case "http":
        return new Response(action.body, {
          status: action.status,
          headers: {
            "Content-Type": "application/json",
            ...(action.headers ?? {}),
          },
        });
      case "throw":
        throw new TypeError(
          action.message ?? "stress: simulated connection failure",
        );
      case "hang":
        return await hangUntil(action.ms, signal);
      case "slow":
        await delayOrAbort(action.ms, signal);
        return await healthy(upstream, request, rawBody, body);
      case "after-commit": {
        const real = await healthy(upstream, request, rawBody, body);
        await real.body?.cancel().catch(() => undefined);
        return await act(action.then, upstream, request, rawBody, body, signal);
      }
    }
  };

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const signal = init?.signal ??
      (input instanceof Request ? input.signal : undefined);
    const rawBody = await request.text().catch(() => "");
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const upstream = classifyUrl(request);
    const entry: UpstreamCall = {
      seq: seq++,
      t: Math.round((performance.now() - t0) * 100) / 100,
      upstream,
      method: request.method,
      url: request.url,
      tag: currentTag,
      fault: null,
      durationMs: 0,
    };
    calls.push(entry);
    const started = performance.now();
    try {
      let action: FaultAction | null = null;
      if (plan) {
        const nth = planCounts.get(upstream) ?? 0;
        planCounts.set(upstream, nth + 1);
        action = plan({
          upstream,
          nth,
          method: request.method,
          url: request.url,
          body,
        });
      }
      if (!action) return await healthy(upstream, request, rawBody, body);
      entry.fault = action.kind === "after-commit"
        ? `after-commit:${action.then.kind}`
        : action.kind;
      return await act(action, upstream, request, rawBody, body, signal);
    } finally {
      entry.durationMs = Math.round((performance.now() - started) * 100) /
        100;
    }
  }) as typeof fetch;

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

  loaded = {
    handler: withStressAuthDeadline(handler),
    fake,
    redis,
    redisEnabled: Boolean(options.redis),
    calls,
    setFault(next) {
      plan = next;
      planCounts = new Map();
    },
    tag(tag) {
      currentTag = tag;
    },
    callsFor(tag) {
      return calls.filter((call) => call.tag === tag);
    },
    reset(seed) {
      fake.reset(seed, 0);
      redis.reset();
      plan = null;
      planCounts = new Map();
      currentTag = null;
    },
    restBackend: null,
  };
  return loaded;
}

// ── Scenario building blocks ────────────────────────────────────────────────

export interface StressUser {
  id: string;
  accessToken: string;
  ip: string;
}

let ipCounter = 0;
/** A fresh client IP so per-IP budgets never bleed across cases. */
export function freshIp(): string {
  ipCounter += 1;
  return `203.0.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

/** A signed-in user in the model (as if bootstrap had run) — no edge call.
 * Premium by default so batches of any size are legal scored writes; pass
 * `premium: false` for the two-lifetime-free-ratings account. */
export function mintUser(
  h: StressHarness,
  prng: Prng,
  options: { premium?: boolean } = {},
): StressUser {
  const id = prng.uuid();
  h.fake.ensureUser(id, "google");
  const session = h.fake.mintSession(id, "google");
  if (options.premium ?? true) {
    h.fake.tables.billing_entitlements.push({
      user_id: id,
      premium: true,
      expires_at: null,
      updated_at: new Date().toISOString(),
    });
  }
  return { id, accessToken: session.accessToken, ip: freshIp() };
}

/** A reserved permit for `userId`, inserted as the table owner would. */
export function reservePermit(
  h: StressHarness,
  prng: Prng,
  userId: string,
): string {
  const id = prng.uuid();
  h.fake.tables.analysis_permits.push({
    id,
    user_id: userId,
    idempotency_key: `stress-${id}`,
    status: "reserved",
    outcome: null,
    created_at: new Date().toISOString(),
  });
  return id;
}

export interface BatchShot {
  id: string;
  permitId: string;
  payload: Record<string, unknown>;
}

/** `n` valid scored shots, each with its own reserved permit. */
export function makeBatch(
  h: StressHarness,
  prng: Prng,
  userId: string,
  n: number,
  overrides: (index: number) => Record<string, unknown> = () => ({}),
): BatchShot[] {
  return Array.from({ length: n }, (_, index) => {
    const id = prng.uuid();
    const permitId = reservePermit(h, prng, userId);
    return {
      id,
      permitId,
      payload: syncShotPayload(id, permitId, overrides(index)),
    };
  });
}

export function syncRequest(
  user: StressUser,
  shots: BatchShot[] | unknown,
): Request {
  const body = Array.isArray(shots) && shots.length > 0 && isRecord(shots[0]) &&
      "payload" in shots[0]
    ? { shots: (shots as BatchShot[]).map((shot) => shot.payload) }
    : shots;
  return new Request("http://edge.stress.test/functions/v1/api/v1/shots:sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${user.accessToken}`,
      "x-forwarded-for": user.ip,
    },
    body: JSON.stringify(body),
  });
}

export interface SyncOutcome {
  status: number;
  retryAfter: string | null;
  requestId: string | null;
  acceptedIds: string[];
  rejected: Array<{ id: string; code: string; message: string }>;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number;
  roundTrips: Record<Upstream, number>;
  /** Total upstream calls that answered with a fault. */
  faulted: number;
}

export function emptyRoundTrips(): Record<Upstream, number> {
  return {
    "gotrue.user": 0,
    "gotrue.other": 0,
    "rest.select": 0,
    "rest.rpc": 0,
    "rest.other": 0,
    redis: 0,
    revenuecat: 0,
    unknown: 0,
  };
}

/** Drive one request through the real handler under `tag`, reading the body
 * and attributing every upstream call to it. Sequential use only. */
export async function drive(
  h: StressHarness,
  tag: string,
  request: Request,
): Promise<SyncOutcome> {
  h.tag(tag);
  const started = performance.now();
  const response = await h.handler(request);
  const text = await response.text();
  const latencyMs = Math.round((performance.now() - started) * 100) / 100;
  h.tag(null);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const body = isRecord(parsed) ? parsed : {};
  const error = isRecord(body.error) ? body.error : null;
  const roundTrips = emptyRoundTrips();
  let faulted = 0;
  for (const call of h.callsFor(tag)) {
    roundTrips[call.upstream] += 1;
    if (call.fault) faulted += 1;
  }
  return {
    status: response.status,
    retryAfter: response.headers.get("Retry-After"),
    requestId: response.headers.get("x-request-id"),
    acceptedIds: Array.isArray(body.acceptedIds)
      ? (body.acceptedIds as string[])
      : [],
    rejected: Array.isArray(body.rejected)
      ? (body.rejected as Array<{ id: string; code: string; message: string }>)
      : [],
    errorCode: error && typeof error.code === "string" ? error.code : null,
    errorMessage: error && typeof error.message === "string"
      ? error.message
      : null,
    latencyMs,
    roundTrips,
    faulted,
  };
}

// ── Client contract (apps/mobile/src/data/sync.ts) ──────────────────────────

/** Per-item rejection codes the outbox treats as transient (attempt budget
 * intact) — mirrors TRANSIENT_SYNC_REJECTION_CODES. */
export const TRANSIENT_REJECTION_CODES: ReadonlySet<string> = new Set([
  "shot.write_failed",
  "evaluation.trial_write_failed",
  "auth.required",
  "shot.session_not_found",
]);

/** What the shipping outbox does with a response — the user-visible class.
 *
 *   accepted              row acknowledged; local outbox row deleted
 *   retry.transient       whole request 5xx / 401 / 408 / 429 → stays queued,
 *                         attempt budget untouched (isPermanentSyncFailure)
 *   retry.transient-item  200 with a transient per-item code → stays queued
 *   reject.permanent-item 200 with a contract verdict → attempt burned
 *   reject.permanent      other 4xx → attempt burned for the WHOLE batch
 *   unacknowledged        200 but the shot is in neither list → attempt burned
 */
export type ClientClass =
  | "accepted"
  | "retry.transient"
  | "retry.transient-item"
  | "reject.permanent-item"
  | "reject.permanent"
  | "unacknowledged";

export function classifyForShot(
  outcome: SyncOutcome,
  shotId: string,
): ClientClass {
  if (outcome.status !== 200) {
    if (
      outcome.status >= 500 ||
      outcome.status === 401 ||
      outcome.status === 408 ||
      outcome.status === 429
    ) {
      return "retry.transient";
    }
    return "reject.permanent";
  }
  if (outcome.acceptedIds.includes(shotId)) return "accepted";
  const rejection = outcome.rejected.find((item) => item.id === shotId);
  if (!rejection) return "unacknowledged";
  return TRANSIENT_REJECTION_CODES.has(rejection.code)
    ? "retry.transient-item"
    : "reject.permanent-item";
}

/** True when the class keeps the row queued for a later, identical replay. */
export const recoverable = (cls: ClientClass): boolean =>
  cls === "accepted" || cls === "retry.transient" ||
  cls === "retry.transient-item";

// ── Model inspection ────────────────────────────────────────────────────────

export function shotRows(h: StressHarness, shotId: string): number {
  return h.fake.tables.shots.filter((row) => row.id === shotId).length;
}

export function permitStatus(h: StressHarness, permitId: string): string {
  const row = h.fake.tables.analysis_permits.find((p) => p.id === permitId);
  return row ? `${String(row.status)}/${String(row.outcome ?? "")}` : "missing";
}

export function scoredRows(h: StressHarness, userId: string): number {
  return h.fake.tables.shots.filter((row) =>
    row.user_id === userId && row.result_kind === "scored"
  )
    .length;
}

// ── Reporting ────────────────────────────────────────────────────────────────

export interface CaseRow {
  suite: string;
  case: string;
  seed: number;
  iteration: number;
  upstream: string;
  fault: string;
  status: number;
  retryAfter: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  perShot: Record<string, ClientClass>;
  classes: Record<string, number>;
  recoverable: boolean;
  roundTrips: Record<Upstream, number>;
  faultedCalls: number;
  latencyMs: number;
  retry: {
    status: number;
    classes: Record<string, number>;
    roundTrips: Record<Upstream, number>;
    latencyMs: number;
  } | null;
  invariants: Array<{ name: string; holds: boolean; detail: string }>;
  /** All invariants hold AND the case pins no documented deviation. */
  held: boolean;
  /** Documented deviation pinned by this case (a finding, not HELD). */
  finding: string | null;
  replay: string;
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-shots-sync/latest/",
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

/** rateLimit.ts keys its windows by the wall-clock minute
 * (rl:<scope>:<bucket>:<id>), so a counted sequence must land in ONE bucket.
 * If fewer than `budgetMs` remain in the current minute, wait for the next
 * one. Returns the bucket the caller starts in and how long it waited. */
export async function awaitMinuteBucket(
  budgetMs: number,
): Promise<{ bucket: number; waitedMs: number }> {
  const WINDOW_MS = 60_000;
  const untilRollover = WINDOW_MS - (Date.now() % WINDOW_MS);
  let waitedMs = 0;
  if (untilRollover < budgetMs) {
    waitedMs = untilRollover + 50;
    await new Promise((r) => setTimeout(r, waitedMs));
  }
  return { bucket: Math.floor(Date.now() / WINDOW_MS), waitedMs };
}

export function minuteBucket(): number {
  return Math.floor(Date.now() / 60_000);
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export function latencyStats(values: number[]): {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length ? Math.round((sum / sorted.length) * 1000) / 1000 : 0,
  };
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
/** Iterations per fault case (each iteration = a fresh seed-derived world). */
export const STRESS_ITER = envInt("STRESS_ITER", 1);
/** 1 → also run the cases that take seconds (supabase-js backoff, hangs). */
export const STRESS_SLOW = (Deno.env.get("STRESS_SLOW") ?? "0") === "1";

export function caseSeed(
  base: number,
  caseIndex: number,
  iteration: number,
): number {
  // Distinct, replayable, and far apart for neighbouring cases.
  return (base + caseIndex * 7919 + iteration * 104729) >>> 0;
}

export function jwtSub(token: string): string | null {
  const sub = jwtPayload(token)?.sub;
  return typeof sub === "string" ? sub : null;
}

export { b64url, isRecord, sleep };

/** Heap snapshot; forces a GC first when the isolate exposes one
 * (`--v8-flags=--expose-gc`). */
export function heapNow(): {
  heapUsed: number;
  rss: number;
  gcForced: boolean;
} {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
  const usage = Deno.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    rss: usage.rss,
    gcForced: typeof gc === "function",
  };
}
