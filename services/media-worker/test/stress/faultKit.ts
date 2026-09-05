import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type pg from "pg";
import type { IJobQueue, JobEnvelope } from "@pickle/queue";
import type { IAnalyticsSink, AnalyticsEvent } from "@pickle/analytics";
import type { ObjectDeleter, WorkerDeps } from "../../src/worker.js";

/**
 * Failure-injection kit for the media worker stress campaign.
 *
 * Every dependency the worker touches (Postgres pool, object store, transcoder,
 * job queue, analytics sink, SLO monitor, log, clock) is wrapped so that ONE
 * seeded fault can be armed against the n-th call of a chosen operation. The
 * campaign derives the fault plan from a seeded RNG, so any iteration is
 * replayable from `seed` alone (`STRESS_SEED=<seed> STRESS_ITER=1`).
 */

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — deterministic across Node versions.
// ---------------------------------------------------------------------------
export class SeededRng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    let t = (this.state += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error("pick from empty list");
    return item;
  }
}

// ---------------------------------------------------------------------------
// Fault vocabulary
// ---------------------------------------------------------------------------
export const FAULT_MODES = [
  "throw", // synchronous throw from the call site
  "reject", // rejected promise with a dependency-style error
  "timeout", // rejects after a short delay with a timeout-style error
  "slow", // succeeds after a delay (25–75 ms)
  "never", // promise that never settles (hang)
  "malformed", // resolves with a shape the worker does not expect
  "partial", // real side effect happens, then the call reports failure
  "empty", // resolves with an empty / no-op result without doing the work
] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

export const FAULT_TARGETS = [
  "pool.query",
  "store.deleteObject",
  "store.listObjects",
  "transcoder",
  "queue.receive",
  "queue.ack",
  "queue.size",
  "queue.oldestJobAgeMs",
  "queue.enqueue",
  "analytics.track",
  "analytics.flush",
  "slo.observe",
  "log",
  "clock",
] as const;
export type FaultTarget = (typeof FAULT_TARGETS)[number];

/** Which modes make sense per target (sync-only targets cannot reject etc.). */
export const TARGET_MODES: Record<FaultTarget, readonly FaultMode[]> = {
  // No `empty` for pool/deleteObject: a single-primary Postgres does not
  // return zero rows for committed data and S3 does not 204 while keeping the
  // object — those would be fabricated faults, not injected ones.
  "pool.query": ["throw", "reject", "timeout", "slow", "never", "malformed", "partial"],
  "store.deleteObject": ["throw", "reject", "timeout", "slow", "never", "partial"],
  "store.listObjects": [
    "throw",
    "reject",
    "timeout",
    "slow",
    "never",
    "malformed",
    "partial",
    "empty",
  ],
  transcoder: ["throw", "reject", "timeout", "slow", "never", "malformed", "partial"],
  "queue.receive": ["throw", "reject", "timeout", "slow", "never", "malformed", "empty"],
  "queue.ack": ["throw", "reject", "timeout", "slow", "never"],
  "queue.size": ["throw", "reject", "slow", "never", "malformed"],
  "queue.oldestJobAgeMs": ["throw", "reject", "slow", "never", "malformed"],
  "queue.enqueue": ["throw", "reject", "timeout", "slow", "never", "partial"],
  "analytics.track": ["throw"],
  "analytics.flush": ["throw", "reject", "slow", "never"],
  "slo.observe": ["throw", "malformed"],
  log: ["throw"],
  clock: ["malformed"], // variant selects: jump backwards / jump forwards
};

export interface FaultPlan {
  target: FaultTarget;
  mode: FaultMode;
  /** Zero-based index of the call to `target` that faults. */
  nth: number;
  /** Selects the concrete malformed/error variant for the mode. */
  variant: number;
}

export interface ArmedFault extends FaultPlan {
  fired: boolean;
}

export class FaultInjector {
  readonly calls: Record<FaultTarget, number> = Object.fromEntries(
    FAULT_TARGETS.map((t) => [t, 0]),
  ) as Record<FaultTarget, number>;
  readonly armed: ArmedFault | null;
  /** Set when a `never` fault fires so the harness knows a hang is expected. */
  hangArmed = false;

  constructor(plan: FaultPlan | null) {
    this.armed = plan ? { ...plan, fired: false } : null;
  }

  /** Returns the fault to apply to this call (once), or null. Always counts the call. */
  hit(target: FaultTarget): ArmedFault | null {
    const index = this.calls[target]++;
    if (!this.armed || this.armed.fired || this.armed.target !== target) return null;
    if (index !== this.armed.nth) return null;
    this.armed.fired = true;
    if (this.armed.mode === "never") this.hangArmed = true;
    return this.armed;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const never = <T>(): Promise<T> => new Promise<T>(() => {});

export class InjectedError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(`injected: ${message}`);
    this.name = "InjectedError";
    this.code = code;
  }
}

const PG_ERRORS: ReadonlyArray<[string, string]> = [
  ["terminating connection due to administrator command", "57P01"],
  ["could not serialize access due to concurrent update", "40001"],
  ["sorry, too many clients already", "53300"],
  ["connection terminated unexpectedly", "ECONNRESET"],
  ["Connection terminated due to connection timeout", "ETIMEDOUT"],
  ["deadlock detected", "40P01"],
];
const S3_ERRORS: ReadonlyArray<[string, string]> = [
  ["Please reduce your request rate.", "SlowDown"],
  ["Access Denied", "AccessDenied"],
  ["We encountered an internal error.", "InternalError"],
  ["socket hang up", "ECONNRESET"],
  ["The specified bucket does not exist", "NoSuchBucket"],
];

function pgError(variant: number): InjectedError {
  const [msg, code] = PG_ERRORS[variant % PG_ERRORS.length]!;
  return new InjectedError(msg, code);
}
function s3Error(variant: number): InjectedError {
  const [msg, code] = S3_ERRORS[variant % S3_ERRORS.length]!;
  return new InjectedError(msg, code);
}
const timeoutError = (what: string): InjectedError =>
  new InjectedError(`${what} timed out`, "ETIMEDOUT");

const slowDelay = (variant: number): number => 25 + (variant % 3) * 25;

// ---------------------------------------------------------------------------
// Wrapped dependencies
// ---------------------------------------------------------------------------
type QueryFn = (text: string, values?: unknown[]) => Promise<pg.QueryResult>;

/** Structurally malformed query results (proxy / half-applied migration / driver bug). */
export const MALFORMED_QUERY_RESULTS: readonly unknown[] = [
  { rows: undefined, rowCount: null },
  { rows: [{}], rowCount: 1 },
  { rows: [null], rowCount: 1 },
  {},
  { rows: "not-an-array", rowCount: 1 },
  { rows: [], rowCount: null },
];

export function wrapPool(real: pg.Pool, inj: FaultInjector): pg.Pool {
  const realQuery: QueryFn = (text, values) =>
    (values === undefined ? real.query(text) : real.query(text, values)) as Promise<pg.QueryResult>;
  const query: QueryFn = (text, values) => {
    const fault = inj.hit("pool.query");
    if (!fault) return realQuery(text, values);
    switch (fault.mode) {
      case "throw":
        throw pgError(fault.variant);
      case "reject":
        return Promise.reject(pgError(fault.variant));
      case "timeout":
        return sleep(30).then(() => Promise.reject(timeoutError("statement")));
      case "slow":
        return sleep(slowDelay(fault.variant)).then(() => realQuery(text, values));
      case "never":
        return never();
      case "malformed":
        return Promise.resolve(
          MALFORMED_QUERY_RESULTS[fault.variant % MALFORMED_QUERY_RESULTS.length] as pg.QueryResult,
        );
      case "partial":
        // The statement committed, but the connection died before the client
        // received the result (classic "commit then error").
        return realQuery(text, values).then(() => Promise.reject(pgError(3)));
      case "empty":
        return Promise.resolve({
          rows: [],
          rowCount: 0,
          command: "",
          oid: 0,
          fields: [],
        } as pg.QueryResult);
    }
  };
  // Only `query` is used by the worker; everything else proxies to the real pool.
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "query") return query;
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** In-memory object store with a full key inventory (orphan / collateral detection). */
export class InventoryStore implements ObjectDeleter {
  keys = new Set<string>();
  deletedKeys: string[] = [];
  async deleteObject(key: string): Promise<void> {
    this.keys.delete(key);
    this.deletedKeys.push(key);
  }
  async listObjects(prefix: string): Promise<string[]> {
    return [...this.keys].filter((k) => k.startsWith(prefix)).sort();
  }
}

export const MALFORMED_LISTINGS: ReadonlyArray<(prefix: string, real: string[]) => unknown> = [
  () => undefined,
  () => null,
  () => "not-an-array",
  () => [undefined],
  () => [123, true],
  (prefix) => [`${prefix}../sibling/master.mp4`, `${prefix}x`],
  (_prefix, real) => [...real, ...real],
  () => [""],
];

export function wrapStore(real: InventoryStore, inj: FaultInjector): ObjectDeleter {
  return {
    deleteObject(key: string): Promise<void> {
      const fault = inj.hit("store.deleteObject");
      if (!fault) return real.deleteObject(key);
      switch (fault.mode) {
        case "throw":
          throw s3Error(fault.variant);
        case "reject":
          return Promise.reject(s3Error(fault.variant));
        case "timeout":
          return sleep(30).then(() => Promise.reject(timeoutError("DeleteObject")));
        case "slow":
          return sleep(slowDelay(fault.variant)).then(() => real.deleteObject(key));
        case "never":
          return never();
        case "partial":
          return real.deleteObject(key).then(() => Promise.reject(s3Error(3)));
        case "empty":
          return Promise.resolve(); // reports success, object still there
        case "malformed":
          return Promise.resolve();
      }
    },
    listObjects(prefix: string): Promise<string[]> {
      const fault = inj.hit("store.listObjects");
      if (!fault) return real.listObjects(prefix);
      switch (fault.mode) {
        case "throw":
          throw s3Error(fault.variant);
        case "reject":
          return Promise.reject(s3Error(fault.variant));
        case "timeout":
          return sleep(30).then(() => Promise.reject(timeoutError("ListObjectsV2")));
        case "slow":
          return sleep(slowDelay(fault.variant)).then(() => real.listObjects(prefix));
        case "never":
          return never();
        case "malformed":
          return real
            .listObjects(prefix)
            .then(
              (keys) =>
                MALFORMED_LISTINGS[fault.variant % MALFORMED_LISTINGS.length]!(
                  prefix,
                  keys,
                ) as string[],
            );
        case "partial":
          // Truncated pagination: only the first half of the derived keys.
          return real.listObjects(prefix).then((keys) => keys.slice(0, Math.ceil(keys.length / 2)));
        case "empty":
          return Promise.resolve([]);
      }
    },
  };
}

export type Transcoder = NonNullable<WorkerDeps["transcoder"]>;
export type TranscodeResult = Awaited<ReturnType<Transcoder>>;

/** A transcoder that materialises derived objects under the master prefix. */
export function inventoryTranscoder(store: InventoryStore): Transcoder {
  return async ({ objectKey }) => {
    const normalizedKey = `${objectKey}/normalized.mp4`;
    const thumbnailKey = `${objectKey}/thumb.jpg`;
    store.keys.add(normalizedKey);
    store.keys.add(thumbnailKey);
    return { normalizedKey, thumbnailKey };
  };
}

/**
 * Malformed transcoder results. `foreignKey` is a key owned by ANOTHER asset
 * that the transcoder could plausibly emit (stale temp-file bookkeeping,
 * wrong job id, passthrough of an input it was handed earlier).
 */
export const MALFORMED_TRANSCODES: ReadonlyArray<
  (objectKey: string, foreignKey: string) => unknown
> = [
  () => undefined,
  () => ({}),
  () => ({ normalizedKey: 1, thumbnailKey: 2 }),
  (k) => ({ normalizedKey: `${k}/normalized.mp4` }), // thumbnail missing
  (k) => ({ normalizedKey: k, thumbnailKey: k }), // passthrough: master returned as output
  (k, foreign) => ({ normalizedKey: foreign, thumbnailKey: `${k}/thumb.jpg` }),
  (_k, foreign) => ({
    normalizedKey: `${foreign}/normalized.mp4`,
    thumbnailKey: `${foreign}/thumb.jpg`,
  }),
  (k) => ({ normalizedKey: `${k}`, thumbnailKey: `${k}/thumb.jpg` }),
  () => null,
];

export function wrapTranscoder(
  real: Transcoder,
  inj: FaultInjector,
  foreignKey: () => string,
): Transcoder {
  return (input) => {
    const fault = inj.hit("transcoder");
    if (!fault) return real(input);
    switch (fault.mode) {
      case "throw":
        throw new InjectedError("ffmpeg exited with code 1", "EXIT1");
      case "reject":
        return Promise.reject(new InjectedError("unsupported codec", "EUNSUPPORTED"));
      case "timeout":
        return sleep(30).then(() => Promise.reject(timeoutError("ffmpeg")));
      case "slow":
        return sleep(slowDelay(fault.variant)).then(() => real(input));
      case "never":
        return never();
      case "malformed":
        return Promise.resolve(
          MALFORMED_TRANSCODES[fault.variant % MALFORMED_TRANSCODES.length]!(
            input.objectKey,
            foreignKey(),
          ) as TranscodeResult,
        );
      case "partial":
        // Derived objects were written, then the process crashed before reporting.
        return real(input).then(() =>
          Promise.reject(new InjectedError("ffmpeg killed (SIGKILL)", "SIGKILL")),
        );
      case "empty":
        return Promise.resolve({ normalizedKey: "", thumbnailKey: "" });
    }
  };
}

type Received = Array<{ job: JobEnvelope; ack: () => Promise<void> }>;

export const MALFORMED_JOBS: ReadonlyArray<(job: JobEnvelope) => unknown> = [
  (job) => ({ ...job, payload: null }),
  (job) => ({ ...job, payload: {} }),
  (job) => ({ ...job, payload: { mediaAssetId: 123 } }),
  (job) => ({ ...job, payload: { mediaAssetId: "not-a-uuid" } }),
  (job) => ({ ...job, payload: { mediaAssetId: "00000000-0000-0000-0000-000000000000" } }),
  (job) => ({ ...job, kind: "__malformed__", payload: { raw: "{not json" } }),
  (job) => ({ ...job, kind: "media.PROCESS" }),
  (job) => ({ ...job, payload: "string-payload" }),
];

export function wrapQueue(real: IJobQueue, inj: FaultInjector): IJobQueue {
  return {
    enqueue(kind, payload) {
      const fault = inj.hit("queue.enqueue");
      if (!fault) return real.enqueue(kind, payload);
      switch (fault.mode) {
        case "throw":
          throw new InjectedError("SendMessage failed", "ServiceUnavailable");
        case "reject":
          return Promise.reject(new InjectedError("SendMessage failed", "ServiceUnavailable"));
        case "timeout":
          return sleep(30).then(() => Promise.reject(timeoutError("SendMessage")));
        case "slow":
          return sleep(slowDelay(fault.variant)).then(() => real.enqueue(kind, payload));
        case "never":
          return never();
        case "partial":
          return real
            .enqueue(kind, payload)
            .then(() => Promise.reject(timeoutError("SendMessage ack")));
        default:
          return real.enqueue(kind, payload);
      }
    },
    receive(max) {
      const fault = inj.hit("queue.receive");
      if (!fault) return real.receive(max);
      switch (fault.mode) {
        case "throw":
          throw new InjectedError("ReceiveMessage failed", "ServiceUnavailable");
        case "reject":
          return Promise.reject(new InjectedError("ReceiveMessage failed", "ServiceUnavailable"));
        case "timeout":
          return sleep(30).then(() => Promise.reject(timeoutError("ReceiveMessage")));
        case "slow":
          return sleep(slowDelay(fault.variant)).then(() => real.receive(max));
        case "never":
          return never();
        case "malformed": {
          const mutate = MALFORMED_JOBS[fault.variant % MALFORMED_JOBS.length]!;
          return real.receive(max).then((batch) => {
            if (batch.length === 0) return batch;
            const [first, ...rest] = batch;
            return [
              { job: mutate(first!.job) as JobEnvelope, ack: first!.ack },
              ...rest,
            ] as Received;
          });
        }
        case "empty":
          return Promise.resolve([]); // queue says "nothing there" although jobs exist
        default:
          return real.receive(max);
      }
    },
    size() {
      const fault = inj.hit("queue.size");
      if (!fault) return real.size();
      switch (fault.mode) {
        case "throw":
          throw new InjectedError("GetQueueAttributes failed", "ServiceUnavailable");
        case "reject":
          return Promise.reject(
            new InjectedError("GetQueueAttributes failed", "ServiceUnavailable"),
          );
        case "slow":
          return sleep(slowDelay(fault.variant)).then(() => real.size());
        case "never":
          return never();
        case "malformed":
          return Promise.resolve(
            [Number.NaN, -1, Number.POSITIVE_INFINITY, "3", -0.5][fault.variant % 5] as number,
          );
        default:
          return real.size();
      }
    },
    oldestJobAgeMs() {
      const fault = inj.hit("queue.oldestJobAgeMs");
      if (!fault) return real.oldestJobAgeMs();
      switch (fault.mode) {
        case "throw":
          throw new InjectedError("CloudWatch failed", "ServiceUnavailable");
        case "reject":
          return Promise.reject(new InjectedError("CloudWatch failed", "ServiceUnavailable"));
        case "slow":
          return sleep(slowDelay(fault.variant)).then(() => real.oldestJobAgeMs());
        case "never":
          return never();
        case "malformed":
          return Promise.resolve(
            [Number.NaN, -5000, Number.POSITIVE_INFINITY, "900000", undefined][
              fault.variant % 5
            ] as number | null,
          );
        default:
          return real.oldestJobAgeMs();
      }
    },
  };
}

/** Records every event; can be told to fault on track/flush. */
export class RecordingAnalytics implements IAnalyticsSink {
  events: AnalyticsEvent[] = [];
  flushes = 0;
  constructor(private inj: FaultInjector) {}
  track(event: AnalyticsEvent): void {
    const fault = this.inj.hit("analytics.track");
    if (fault) throw new InjectedError("analytics sink closed", "EPIPE");
    this.events.push(event);
  }
  flush(): Promise<void> {
    const fault = this.inj.hit("analytics.flush");
    this.flushes++;
    if (!fault) return Promise.resolve();
    switch (fault.mode) {
      case "throw":
        throw new InjectedError("analytics transport closed", "EPIPE");
      case "reject":
        return Promise.reject(new InjectedError("analytics transport 503", "503"));
      case "slow":
        return sleep(slowDelay(fault.variant));
      case "never":
        return never();
      default:
        return Promise.resolve();
    }
  }
}

export function wrapLog(sink: string[], inj: FaultInjector): (line: string) => void {
  return (line) => {
    const fault = inj.hit("log");
    if (fault) throw new InjectedError("stdout EPIPE", "EPIPE");
    sink.push(line);
  };
}

// ---------------------------------------------------------------------------
// Bounded execution
// ---------------------------------------------------------------------------
export type Settled<T> =
  | { kind: "resolved"; value: T; ms: number }
  | { kind: "rejected"; error: string; ms: number }
  | { kind: "hung"; ms: number };

/** Runs `fn` with a hard wall-clock bound so a never-settling dependency can never hang the suite. */
export async function bounded<T>(fn: () => Promise<T>, ms: number): Promise<Settled<T>> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "hung", ms: Date.now() - started }), ms);
  });
  const run: Promise<Settled<T>> = (async () => {
    try {
      const value = await fn();
      return { kind: "resolved", value, ms: Date.now() - started };
    } catch (error) {
      return { kind: "rejected", error: String(error), ms: Date.now() - started };
    }
  })();
  const result = await Promise.race([run, guard]);
  if (timer) clearTimeout(timer);
  // A hung promise is left dangling on purpose: the worker under test has no
  // cancellation, and the harness must not fabricate one.
  return result;
}

// ---------------------------------------------------------------------------
// Result table
// ---------------------------------------------------------------------------
export interface ScenarioResult {
  seed: number;
  scenario: string;
  fault: FaultPlan | null;
  faultFired: boolean;
  /** How the faulted cycle itself settled. */
  faulted: "resolved" | "rejected" | "hung";
  faultedMs: number;
  /** Recovery cycles run with the fault cleared before the oracle passed (or gave up). */
  recoveryCycles: number;
  outcome: "HELD" | "BROKEN";
  /** Stable identifier for a known defect class, so BROKEN rows can be grouped. */
  defect: string | null;
  violations: string[];
  log: string[];
}

export interface CampaignTable {
  unit: string;
  lens: string;
  commit: string;
  generatedAt: string;
  iterations: number;
  fired: number;
  held: number;
  broken: number;
  defects: Record<string, number[]>;
  results: ScenarioResult[];
}

export function writeTable(path: string, table: CampaignTable): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(table, null, 2));
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}
