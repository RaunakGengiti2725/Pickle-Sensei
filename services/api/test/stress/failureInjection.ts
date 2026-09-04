import type pg from "pg";
import type { IJobQueue, JobEnvelope } from "@pickle/queue";
import type { IAnalyticsSink } from "@pickle/analytics";
import type { ISecurityEventSink, SecurityEvent } from "../../src/lib/securityEvents.js";
import type {
  IObjectStore,
  StoredObject,
  UploadConstraints,
} from "../../src/modules/media/objectStore.js";

/**
 * Seeded failure-injection support for the legacy Fastify API.
 *
 * Every dependency the API reaches through a seam (pg pool + transaction
 * clients, job queue, object store, global fetch, telemetry sinks) is wrapped
 * by a `Chaos` controller. A `Fault` names the dependency, the failure mode,
 * and which call (`hit`) of that dependency inside one request fails. The
 * fault for iteration N of a campaign is a pure function of that iteration's
 * seed, so any row of the results table replays with `STRESS_SEED=<seed>`.
 */

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) + per-iteration seed derivation
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;
  constructor(readonly seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[this.int(items.length)]!;
  }
}

/** Iteration seed = mix(campaignSeed, index); stable across campaign sizes. */
export function iterationSeed(campaignSeed: number, index: number): number {
  let h = (campaignSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (index + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// Fault model
// ---------------------------------------------------------------------------

export type Dep =
  | "pg.query"
  | "pg.tx"
  | "queue.enqueue"
  | "queue.size"
  | "queue.oldest"
  | "store.presignUpload"
  | "store.headObject"
  | "store.presignDownload"
  | "fetch.revenuecat"
  | "fetch.jwks"
  | "sink.analytics"
  | "sink.security"
  | "sink.slo";

export type Mode = "throw" | "reject" | "timeout" | "malformed" | "partial" | "slow" | "never";

export interface Fault {
  dep: Dep;
  mode: Mode;
  /** Zero-based index of the call to `dep` (inside one request) that fails. */
  hit: number;
  /** Mode-specific detail: pg error code, HTTP status, malformed variant, ms. */
  detail: string;
}

export function faultId(fault: Fault): string {
  return `${fault.dep}:${fault.mode}:${fault.detail}@${fault.hit}`;
}

/**
 * PostgreSQL / socket error codes the API classifies as a transient datastore
 * outage (app.ts isDatastoreUnavailable). Mirrors production so the harness
 * can tell a HELD retryable envelope from a misclassification.
 */
export const PG_OUTAGE_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "57P01",
  "57P03",
  "53300",
  "08006",
  "08003",
] as const;

/** Transient Postgres conditions a client is expected to retry (PG docs, Appendix A). */
export const PG_TRANSIENT_CODES = ["40001", "40P01", "57014"] as const;

/** Non-transient Postgres failures: retrying without a change cannot help. */
export const PG_PERMANENT_CODES = ["42501", "23505", "22P02", "42P01", "23502"] as const;

export const PG_MESSAGE_FAULTS = [
  "Connection terminated unexpectedly",
  "timeout exceeded when trying to connect",
] as const;

export const PG_MALFORMED_VARIANTS = ["rows_undefined", "rows_not_array"] as const;
export const PG_PARTIAL_VARIANTS = ["empty_rows"] as const;

export const FETCH_STATUS_FAULTS = ["500", "502", "429", "408", "401", "403", "404"] as const;
export const FETCH_MALFORMED_VARIANTS = ["html_body", "truncated_json", "text_body"] as const;
export const FETCH_PARTIAL_VARIANTS = [
  "empty_object",
  "subscriber_without_entitlements",
  "entitlement_missing_fields",
] as const;

export const STORE_MALFORMED_VARIANTS = ["head_not_object", "head_nan_size"] as const;
export const STORE_PARTIAL_VARIANTS = ["head_missing_fields", "presign_empty"] as const;

export const SLOW_MS = ["120", "250", "400"] as const;

export class ChaosError extends Error {
  code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ChaosError";
    this.code = code;
  }
}

export function isTransientFault(fault: Fault): boolean {
  if (fault.mode === "timeout" || fault.mode === "never") return true;
  if (fault.dep === "pg.query" || fault.dep === "pg.tx") {
    if (fault.mode !== "throw" && fault.mode !== "reject") return false;
    return (
      (PG_OUTAGE_CODES as readonly string[]).includes(fault.detail) ||
      (PG_TRANSIENT_CODES as readonly string[]).includes(fault.detail) ||
      (PG_MESSAGE_FAULTS as readonly string[]).includes(fault.detail)
    );
  }
  if (fault.dep === "fetch.revenuecat" || fault.dep === "fetch.jwks") {
    if (fault.mode === "reject") return true;
    if (fault.mode === "throw") return ["500", "502", "429", "408"].includes(fault.detail);
    return false;
  }
  if (fault.dep.startsWith("store.") || fault.dep.startsWith("queue.")) {
    if (fault.mode !== "throw" && fault.mode !== "reject") return false;
    return (AWS_TRANSIENT_CODES as readonly string[]).includes(fault.detail);
  }
  return false;
}

/** AWS SDK error names a client is expected to retry (throttle, 5xx, socket). */
export const AWS_TRANSIENT_CODES = [
  "NetworkingError",
  "InternalError",
  "SlowDown",
  "Throttling",
] as const;
/** Configuration / authorization errors: a retry cannot help. */
export const AWS_PERMANENT_CODES = [
  "AccessDenied",
  "AWS.SimpleQueueService.NonExistentQueue",
] as const;

// ---------------------------------------------------------------------------
// Chaos controller
// ---------------------------------------------------------------------------

export interface FiredRecord {
  dep: Dep;
  mode: Mode;
  detail: string;
  callIndex: number;
}

export class Chaos {
  active: Fault | null = null;
  fired: FiredRecord | null = null;
  calls = new Map<Dep, number>();
  /** pg clients checked out while a fault was armed (for forced rollback). */
  private checkedOut = new Set<pg.PoolClient>();

  arm(fault: Fault): void {
    this.active = fault;
    this.fired = null;
    this.calls.clear();
  }

  /** Count dependency calls without injecting anything (happy-path profiling). */
  startCounting(): void {
    this.active = null;
    this.fired = null;
    this.calls.clear();
  }

  disarm(): void {
    this.active = null;
  }

  /** Count of calls seen for a dep during the current arm/disarm window. */
  callsFor(dep: Dep): number {
    return this.calls.get(dep) ?? 0;
  }

  private shouldFire(dep: Dep): boolean {
    const idx = this.calls.get(dep) ?? 0;
    this.calls.set(dep, idx + 1);
    const f = this.active;
    if (!f || f.dep !== dep || this.fired) return false;
    if (idx !== f.hit) return false;
    this.fired = { dep, mode: f.mode, detail: f.detail, callIndex: idx };
    return true;
  }

  trackClient(client: pg.PoolClient): void {
    this.checkedOut.add(client);
  }
  untrackClient(client: pg.PoolClient): void {
    this.checkedOut.delete(client);
  }

  /**
   * Generic interception. `real` performs the dependency call; `shapes`
   * produce malformed/partial return values; `error` builds the thrown or
   * rejected error for the fault detail.
   */
  intercept<T>(
    dep: Dep,
    real: () => Promise<T>,
    shapes: {
      malformed: (detail: string) => T;
      partial: (detail: string) => T;
      error: (fault: Fault) => Error;
      timeoutError: () => Error;
      /**
       * When true the real call still executes and only its RESULT is
       * corrupted (a mangled driver response). Without it the call is
       * swallowed, which for a write would fabricate data loss the
       * dependency never caused.
       */
      corruptResultOnly?: boolean;
    },
  ): Promise<T> {
    if (!this.shouldFire(dep)) return real();
    const fault = this.active!;
    const shaped = (shape: (detail: string) => T): Promise<T> =>
      shapes.corruptResultOnly
        ? real().then(() => shape(fault.detail))
        : Promise.resolve(shape(fault.detail));
    switch (fault.mode) {
      case "throw":
        throw shapes.error(fault);
      case "reject":
        return Promise.reject(shapes.error(fault));
      case "timeout":
        return Promise.reject(shapes.timeoutError());
      case "malformed":
        return shaped(shapes.malformed);
      case "partial":
        return shaped(shapes.partial);
      case "slow":
        return new Promise<T>((resolve, reject) => {
          setTimeout(() => real().then(resolve, reject), Number(fault.detail));
        });
      case "never":
        return new Promise<T>(() => {
          /* intentionally never settles */
        });
    }
  }

  /** Sync variant for fire-and-forget sinks (analytics.track, security.record, slo). */
  interceptSync(dep: Dep, real: () => void, error: () => Error): void {
    if (!this.shouldFire(dep)) return real();
    const fault = this.active!;
    if (fault.mode === "throw" || fault.mode === "reject" || fault.mode === "timeout") {
      throw error();
    }
    // malformed/partial/slow/never make no sense for a void sync sink: pass through.
    real();
  }

  /** Force-rollback and release every client a hung transaction still owns. */
  async releaseHung(): Promise<string[]> {
    const notes: string[] = [];
    for (const client of [...this.checkedOut]) {
      try {
        await client.query("ROLLBACK");
        notes.push("rollback_forced");
      } catch (error) {
        notes.push(`rollback_failed:${(error as Error).message}`);
      }
      try {
        client.release();
      } catch {
        // already released by the app path
      }
      this.checkedOut.delete(client);
    }
    return notes;
  }
}

// ---------------------------------------------------------------------------
// Dependency wrappers
// ---------------------------------------------------------------------------

type QueryResultLike = { rows: unknown[]; rowCount: number | null };

function pgError(fault: Fault): Error {
  if ((PG_MESSAGE_FAULTS as readonly string[]).includes(fault.detail)) {
    return new ChaosError(fault.detail);
  }
  return new ChaosError(`injected pg failure ${fault.detail}`, fault.detail);
}

function pgMalformed(detail: string): QueryResultLike {
  if (detail === "rows_undefined")
    return { rows: undefined as unknown as unknown[], rowCount: null };
  return { rows: { not: "an array" } as unknown as unknown[], rowCount: 1 };
}

function pgPartial(): QueryResultLike {
  return { rows: [], rowCount: 0 };
}

/**
 * Wrap the live pg.Pool that buildApp created (context.pool) in place. The
 * pool object itself is unchanged; only `query` and `connect` are rerouted
 * through the chaos controller, so real SQL still hits the real test DB when
 * no fault is armed.
 */
export function wrapPool(pool: pg.Pool, chaos: Chaos): void {
  type QueryFn = (text: string, values?: unknown[]) => Promise<QueryResultLike>;
  type ConnectCb = (err: Error | undefined, client?: pg.PoolClient, done?: () => void) => void;
  type ConnectFn = (cb?: ConnectCb) => Promise<pg.PoolClient> | void;
  const realQuery = (pool.query as unknown as QueryFn).bind(pool);
  const realConnect = (pool.connect as unknown as ConnectFn).bind(pool);

  const chaosQuery: QueryFn = (text, values) =>
    chaos.intercept<QueryResultLike>("pg.query", () => realQuery(text, values), {
      malformed: pgMalformed,
      partial: pgPartial,
      error: pgError,
      timeoutError: () => new ChaosError("Query read timeout", "ETIMEDOUT"),
      corruptResultOnly: true,
    });

  const chaosConnect: ConnectFn = (cb?: ConnectCb) => {
    // pg-pool's own `query()` checks a client out through the callback form of
    // `connect`; that path is already covered by the `pg.query` seam.
    if (cb) return realConnect(cb);
    return connectWithChaos();
  };

  const connectWithChaos = async (): Promise<pg.PoolClient> => {
    const client = (await realConnect()) as pg.PoolClient;
    chaos.trackClient(client);
    type ClientQuery = (text: string, values?: unknown[]) => Promise<QueryResultLike>;
    const realClientQuery = (client.query as unknown as ClientQuery).bind(client);
    const realRelease = client.release.bind(client);
    const proxy = new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === "query") {
          const q: ClientQuery = (text, values) =>
            chaos.intercept<QueryResultLike>("pg.tx", () => realClientQuery(text, values), {
              malformed: pgMalformed,
              partial: pgPartial,
              error: pgError,
              timeoutError: () => new ChaosError("Query read timeout", "ETIMEDOUT"),
              corruptResultOnly: true,
            });
          return q;
        }
        if (prop === "release") {
          return (err?: Error | boolean) => {
            chaos.untrackClient(client);
            return realRelease(err);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    return proxy;
  };

  (pool as unknown as { query: QueryFn }).query = chaosQuery;
  (pool as unknown as { connect: ConnectFn }).connect = chaosConnect;
}

export class ChaosQueue implements IJobQueue {
  constructor(
    private readonly inner: IJobQueue,
    private readonly chaos: Chaos,
  ) {}
  enqueue(kind: string, payload: unknown): Promise<string> {
    return this.chaos.intercept<string>("queue.enqueue", () => this.inner.enqueue(kind, payload), {
      malformed: () => undefined as unknown as string,
      partial: () => "",
      error: (f) => new ChaosError(`injected queue failure ${f.detail}`, f.detail),
      timeoutError: () => new ChaosError("SQS request timed out", "TimeoutError"),
    });
  }
  receive(max: number): Promise<Array<{ job: JobEnvelope; ack: () => Promise<void> }>> {
    return this.inner.receive(max);
  }
  size(): Promise<number> {
    return this.chaos.intercept<number>("queue.size", () => this.inner.size(), {
      malformed: () => Number.NaN,
      partial: () => -1,
      error: (f) => new ChaosError(`injected queue failure ${f.detail}`, f.detail),
      timeoutError: () => new ChaosError("SQS request timed out", "TimeoutError"),
    });
  }
  oldestJobAgeMs(): Promise<number | null> {
    return this.chaos.intercept<number | null>("queue.oldest", () => this.inner.oldestJobAgeMs(), {
      malformed: () => "old" as unknown as number,
      partial: () => null,
      error: (f) => new ChaosError(`injected queue failure ${f.detail}`, f.detail),
      timeoutError: () => new ChaosError("SQS request timed out", "TimeoutError"),
    });
  }
}

export class ChaosObjectStore implements IObjectStore {
  readonly bucket: string;
  constructor(
    private readonly inner: IObjectStore,
    private readonly chaos: Chaos,
  ) {
    this.bucket = inner.bucket;
  }
  presignUpload(key: string, expiresSeconds: number, constraints: UploadConstraints) {
    return this.chaos.intercept<string>(
      "store.presignUpload",
      () => this.inner.presignUpload(key, expiresSeconds, constraints),
      {
        malformed: () => ({ url: "x" }) as unknown as string,
        partial: () => "",
        error: (f) => new ChaosError(`injected S3 failure ${f.detail}`, f.detail),
        timeoutError: () => new ChaosError("S3 request timed out", "TimeoutError"),
      },
    );
  }
  presignDownload(key: string, expiresSeconds: number) {
    return this.chaos.intercept<string>(
      "store.presignDownload",
      () => this.inner.presignDownload(key, expiresSeconds),
      {
        malformed: () => null as unknown as string,
        partial: () => "",
        error: (f) => new ChaosError(`injected S3 failure ${f.detail}`, f.detail),
        timeoutError: () => new ChaosError("S3 request timed out", "TimeoutError"),
      },
    );
  }
  deleteObject(key: string) {
    return this.inner.deleteObject(key);
  }
  headObject(key: string) {
    return this.chaos.intercept<StoredObject | null>(
      "store.headObject",
      () => this.inner.headObject(key),
      {
        malformed: (d) =>
          d === "head_nan_size"
            ? { sizeBytes: Number.NaN, contentType: null, checksumSha256: null }
            : ("not-an-object" as unknown as StoredObject),
        partial: () => ({}) as unknown as StoredObject,
        error: (f) => new ChaosError(`injected S3 failure ${f.detail}`, f.detail),
        timeoutError: () => new ChaosError("S3 request timed out", "TimeoutError"),
      },
    );
  }
}

export class ChaosAnalytics implements IAnalyticsSink {
  tracked = 0;
  flushed = 0;
  constructor(private readonly chaos: Chaos) {}
  track(): void {
    this.chaos.interceptSync(
      "sink.analytics",
      () => {
        this.tracked += 1;
      },
      () => new ChaosError("analytics transport exploded"),
    );
  }
  flush(): Promise<void> {
    return this.chaos.intercept<void>(
      "sink.analytics",
      async () => {
        this.flushed += 1;
      },
      {
        malformed: () => undefined,
        partial: () => undefined,
        error: () => new ChaosError("analytics flush rejected"),
        timeoutError: () => new ChaosError("analytics flush timed out", "ETIMEDOUT"),
      },
    );
  }
}

export class ChaosSecuritySink implements ISecurityEventSink {
  readonly events: SecurityEvent[] = [];
  constructor(private readonly chaos: Chaos) {}
  record(event: SecurityEvent): void {
    this.chaos.interceptSync(
      "sink.security",
      () => {
        this.events.push(event);
      },
      () => new ChaosError("security sink exploded"),
    );
  }
}

// ---------------------------------------------------------------------------
// Global fetch chaos (RevenueCat + JWKS)
// ---------------------------------------------------------------------------

export interface FetchRoute {
  dep: "fetch.revenuecat" | "fetch.jwks";
  match: (url: string) => boolean;
  /** Happy-path response body (JSON-serialisable). */
  happy: () => unknown;
  malformed: (detail: string) => Response;
  partial: (detail: string) => unknown;
}

function abortError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

function networkError(detail: string): Error {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = new ChaosError(`injected network failure ${detail}`, detail);
  return err;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }) as unknown as Response;
}

/**
 * Installs a chaos `fetch` on globalThis. Unmatched URLs are refused loudly:
 * the harness must never let a test reach the public network.
 */
export function installChaosFetch(chaos: Chaos, routes: FetchRoute[]): () => void {
  const original = globalThis.fetch;
  const chaosFetch = (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const route = routes.find((r) => r.match(url));
    if (!route) {
      return Promise.reject(
        new TypeError(`fetch failed (chaos harness refuses unmatched URL ${url})`),
      );
    }
    // A "throw"/"reject" whose detail is an HTTP status models a non-2xx
    // provider reply (the fetch itself succeeds); anything else is a socket
    // level failure surfaced the way undici does (TypeError "fetch failed").
    let pending: Promise<Response>;
    try {
      pending = chaos.intercept<Response>(route.dep, async () => jsonResponse(route.happy()), {
        malformed: (d) => route.malformed(d),
        partial: (d) => jsonResponse(route.partial(d)),
        error: (f) =>
          /^\d{3}$/.test(f.detail)
            ? new HttpStatusSignal(Number(f.detail))
            : networkError(f.detail),
        timeoutError: abortError,
      });
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.catch((error: unknown) => {
      if (error instanceof HttpStatusSignal) {
        return jsonResponse({ error: "upstream", status: error.status }, error.status);
      }
      throw error;
    });
  };

  // "never" must still honour the caller's AbortSignal: the API's own deadline
  // (AbortSignal.timeout) is what ends the wait, exactly as with real undici.
  const withSignal = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const pending = chaosFetch(input);
    if (!signal) return pending;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? abortError());
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  };

  globalThis.fetch = withSignal as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

class HttpStatusSignal extends Error {
  constructor(readonly status: number) {
    super(`http ${status}`);
  }
}

// ---------------------------------------------------------------------------
// Invariant checks on a response
// ---------------------------------------------------------------------------

export interface EnvelopeCheck {
  ok: boolean;
  kind?: string | undefined;
  code?: string | undefined;
  retryable?: boolean | undefined;
  requestId?: string | undefined;
  problems: string[];
}

export function checkEnvelope(
  status: number,
  headers: Record<string, unknown>,
  body: string,
): EnvelopeCheck {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = body.length ? JSON.parse(body) : undefined;
  } catch {
    problems.push("body_not_json");
  }
  const headerId = headers["x-request-id"];
  if (typeof headerId !== "string" || headerId.length === 0) problems.push("missing_x_request_id");
  if (status < 400) return { ok: problems.length === 0, problems };
  const error = (parsed as { error?: Record<string, unknown> } | undefined)?.error;
  if (!error) {
    problems.push("missing_error_envelope");
    return { ok: false, problems };
  }
  const kind = error["kind"];
  const code = error["code"];
  const retryable = error["retryable"];
  const requestId = error["requestId"];
  if (typeof kind !== "string") problems.push("envelope_kind_not_string");
  if (typeof code !== "string") problems.push("envelope_code_not_string");
  if (typeof retryable !== "boolean") problems.push("envelope_retryable_not_boolean");
  if (typeof requestId !== "string") problems.push("envelope_requestId_not_string");
  if (typeof error["message"] !== "string") problems.push("envelope_message_not_string");
  if (typeof requestId === "string" && requestId !== headerId) problems.push("requestId_mismatch");
  return {
    ok: problems.length === 0,
    kind: typeof kind === "string" ? kind : undefined,
    code: typeof code === "string" ? code : undefined,
    retryable: typeof retryable === "boolean" ? retryable : undefined,
    requestId: typeof requestId === "string" ? requestId : undefined,
    problems,
  };
}

/** Strings that must never appear in any response body. */
export function findLeaks(body: string, secrets: readonly string[]): string[] {
  const leaks: string[] = [];
  for (const secret of secrets) if (secret && body.includes(secret)) leaks.push("secret");
  if (/\n\s+at\s+\S+\s+\(/.test(body)) leaks.push("stack_trace");
  if (/postgres(ql)?:\/\//i.test(body)) leaks.push("connection_string");
  if (/node_modules\//.test(body)) leaks.push("module_path");
  return leaks;
}
