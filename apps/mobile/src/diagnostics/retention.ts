import {
  diagnosticsIdentity,
  record,
  type DiagnosticEnvelope,
  type DiagnosticsIdentity,
  type DiagnosticTransport,
} from './privacy';
import { scrubDiagnosticEnvelope } from './scrub';

export const DIAGNOSTIC_RETENTION_DATABASE = 'pickle-sensei-diagnostics.db';
export const DIAGNOSTIC_RETENTION_TABLE = 'diagnostic_envelope';

export interface DiagnosticRetentionLimits {
  readonly maxEnvelopes: number;
  readonly maxTotalBytes: number;
  readonly maxEnvelopeBytes: number;
  readonly maxAgeMs: number;
}

export const DIAGNOSTIC_RETENTION_LIMITS: DiagnosticRetentionLimits =
  Object.freeze({
    maxEnvelopes: 32,
    maxTotalBytes: 262_144,
    maxEnvelopeBytes: 32_768,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  });

export interface DiagnosticRetryDelays {
  readonly drainMs: number;
  readonly initialMs: number;
  readonly maxMs: number;
  readonly rateLimitMs: number;
}

export const DIAGNOSTIC_RETRY_DELAYS: DiagnosticRetryDelays = Object.freeze({
  drainMs: 100,
  initialMs: 5_000,
  maxMs: 3_600_000,
  rateLimitMs: 60_000,
});

export interface RetainedDiagnosticRow {
  readonly sequence: number;
  readonly storedAt: number;
  readonly bytes: number;
}

export interface RetainedDiagnosticRecord extends RetainedDiagnosticRow {
  readonly payload: string;
}

export interface DiagnosticRetentionStorage {
  list(): Promise<readonly unknown[]>;
  read(sequence: number): Promise<unknown>;
  insert(record: RetainedDiagnosticRecord): Promise<void>;
  remove(sequences: readonly number[]): Promise<void>;
  reset(): Promise<void>;
}

export interface DiagnosticRetentionPlan {
  readonly kept: readonly RetainedDiagnosticRow[];
  readonly evicted: readonly number[];
  readonly nextSequence: number;
  readonly reset: boolean;
}

const RESET_PLAN: DiagnosticRetentionPlan = Object.freeze({
  kept: Object.freeze([]),
  evicted: Object.freeze([]),
  nextSequence: 1,
  reset: true,
});

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function epochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function planDiagnosticRetention(
  rows: readonly unknown[],
  now: number,
  limits: DiagnosticRetentionLimits = DIAGNOSTIC_RETENTION_LIMITS,
): DiagnosticRetentionPlan {
  try {
    if (!Array.isArray(rows) || !Number.isFinite(now)) return RESET_PLAN;
    const seen = new Set<number>();
    const candidates: {
      sequence: number;
      row: RetainedDiagnosticRow | null;
    }[] = [];
    let highest = 0;
    for (const item of rows) {
      const value = record(item);
      const sequence = value?.sequence;
      if (!value || !safeInteger(sequence) || seen.has(sequence))
        return RESET_PLAN;
      seen.add(sequence);
      highest = Math.max(highest, sequence);
      const { storedAt, bytes } = value;
      candidates.push({
        sequence,
        row:
          epochMs(storedAt) &&
          safeInteger(bytes) &&
          bytes >= 0 &&
          bytes <= limits.maxEnvelopeBytes &&
          Math.abs(now - storedAt) <= limits.maxAgeMs
            ? { sequence, storedAt, bytes }
            : null,
      });
    }
    candidates.sort((a, b) => a.sequence - b.sequence);
    const kept: RetainedDiagnosticRow[] = [];
    const evicted: number[] = [];
    let totalBytes = 0;
    for (const candidate of candidates) {
      if (candidate.row) {
        kept.push(candidate.row);
        totalBytes += candidate.row.bytes;
      } else {
        evicted.push(candidate.sequence);
      }
    }
    let start = 0;
    while (
      kept.length - start > limits.maxEnvelopes ||
      totalBytes > limits.maxTotalBytes
    ) {
      const oldest = kept[start];
      if (!oldest) break;
      totalBytes -= oldest.bytes;
      evicted.push(oldest.sequence);
      start += 1;
    }
    evicted.sort((a, b) => a - b);
    return {
      kept: kept.slice(start),
      evicted,
      nextSequence: highest + 1,
      reset: false,
    };
  } catch {
    return RESET_PLAN;
  }
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function encodeEnvelope(
  envelope: unknown,
  identity: DiagnosticsIdentity,
  limits: DiagnosticRetentionLimits,
): { payload: string; bytes: number } | null {
  try {
    const clean = scrubDiagnosticEnvelope(envelope, identity);
    if (!clean) return null;
    const payload: unknown = JSON.stringify(clean);
    if (typeof payload !== 'string' || payload.length > limits.maxEnvelopeBytes)
      return null;
    const bytes = utf8ByteLength(payload);
    return bytes <= limits.maxEnvelopeBytes ? { payload, bytes } : null;
  } catch {
    return null;
  }
}

/**
 * The release identity a retained envelope was produced under, read back from
 * the stamped fields of its own event. A replayed envelope must report the
 * build that produced it, never the build that happens to be replaying it.
 */
export function retainedDiagnosticIdentity(
  envelope: unknown,
): DiagnosticsIdentity | null {
  try {
    if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) return null;
    for (const item of envelope[1]) {
      if (!Array.isArray(item) || record(item[0])?.type !== 'event') continue;
      const event = record(item[1]);
      const tags = record(event?.tags);
      const release = event?.release;
      if (typeof release !== 'string') return null;
      const at = release.indexOf('@');
      const plus = release.lastIndexOf('+');
      if (at < 0 || plus < at) return null;
      const identity = diagnosticsIdentity({
        bundleIdentifier: release.slice(0, at),
        marketingVersion: release.slice(at + 1, plus),
        nativeBuildNumber: release.slice(plus + 1),
        sourceRevision: tags?.source_revision,
        environment: event?.environment,
        modelVersion: tags?.model_version,
        policyVersion: tags?.policy_version,
      });
      return identity && event?.dist === identity.nativeBuildNumber
        ? identity
        : null;
    }
    return null;
  } catch {
    return null;
  }
}

function decodeEnvelope(
  payload: unknown,
  limits: DiagnosticRetentionLimits,
): DiagnosticEnvelope | null {
  try {
    if (typeof payload !== 'string' || payload.length > limits.maxEnvelopeBytes)
      return null;
    const parsed: unknown = JSON.parse(payload);
    const identity = retainedDiagnosticIdentity(parsed);
    return identity ? scrubDiagnosticEnvelope(parsed, identity) : null;
  } catch {
    return null;
  }
}

export interface RetainedDiagnostic {
  readonly sequence: number;
  readonly envelope: DiagnosticEnvelope;
}

export interface BoundedDiagnosticStore {
  push(envelope: DiagnosticEnvelope): Promise<void>;
  peek(skip?: ReadonlySet<number>): Promise<RetainedDiagnostic | undefined>;
  remove(sequence: number): Promise<void>;
  shift(): Promise<DiagnosticEnvelope | undefined>;
  prune(): Promise<void>;
}

export type DiagnosticRetentionStorageSource =
  | DiagnosticRetentionStorage
  | (() => DiagnosticRetentionStorage | Promise<DiagnosticRetentionStorage>);

export interface BoundedDiagnosticStoreOptions {
  readonly storage: DiagnosticRetentionStorageSource;
  readonly identity: DiagnosticsIdentity;
  readonly limits?: DiagnosticRetentionLimits;
  readonly now?: () => number;
}

export function createBoundedDiagnosticStore(
  options: BoundedDiagnosticStoreOptions,
): BoundedDiagnosticStore {
  const releaseIdentity = diagnosticsIdentity(options.identity);
  const limits = options.limits ?? DIAGNOSTIC_RETENTION_LIMITS;
  const clock = options.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  let storage: DiagnosticRetentionStorage | null = null;
  let broken = releaseIdentity === null;
  let recovered = false;

  function serialize<T>(task: () => Promise<T>, fallback: T): Promise<T> {
    const result = queue.then(async () => {
      try {
        return await task();
      } catch {
        return fallback;
      }
    });
    queue = result;
    return result;
  }

  async function open(): Promise<DiagnosticRetentionStorage | null> {
    if (broken) return null;
    if (storage) return storage;
    try {
      const source = options.storage;
      storage = typeof source === 'function' ? await source() : source;
      return storage;
    } catch {
      broken = true;
      return null;
    }
  }

  async function recover(store: DiagnosticRetentionStorage): Promise<void> {
    if (recovered) {
      broken = true;
      return;
    }
    recovered = true;
    try {
      await store.reset();
    } catch {
      broken = true;
    }
  }

  async function guarded<T>(
    task: (store: DiagnosticRetentionStorage) => Promise<T>,
    fallback: T,
  ): Promise<T> {
    const store = await open();
    if (!store) return fallback;
    try {
      return await task(store);
    } catch {
      await recover(store);
      return fallback;
    }
  }

  async function reconcile(
    store: DiagnosticRetentionStorage,
    now: number,
  ): Promise<DiagnosticRetentionPlan> {
    const plan = planDiagnosticRetention(await store.list(), now, limits);
    if (plan.reset) await store.reset();
    else if (plan.evicted.length > 0) await store.remove(plan.evicted);
    return plan;
  }

  function currentTime(): number | null {
    const now = clock();
    return Number.isFinite(now) ? now : null;
  }

  let allocated = 0;

  /** Sequences never move backwards within a process, even once the table
   * is empty: a claim still in flight must not alias a newer row. */
  function allocate(plan: DiagnosticRetentionPlan): number {
    allocated = Math.max(allocated + 1, plan.nextSequence);
    return allocated;
  }

  async function oldest(
    store: DiagnosticRetentionStorage,
    now: number,
    skip: ReadonlySet<number> | undefined,
  ): Promise<RetainedDiagnostic | undefined> {
    for (const row of (await reconcile(store, now)).kept) {
      if (skip?.has(row.sequence)) continue;
      const envelope = decodeEnvelope(await store.read(row.sequence), limits);
      if (envelope) return { sequence: row.sequence, envelope };
      await store.remove([row.sequence]);
    }
    return undefined;
  }

  return {
    push(envelope) {
      return serialize(async () => {
        if (broken || !releaseIdentity) return;
        const encoded = encodeEnvelope(envelope, releaseIdentity, limits);
        if (!encoded) return;
        const now = currentTime();
        if (now === null) return;
        await guarded(async store => {
          const plan = await reconcile(store, now);
          await store.insert({
            sequence: allocate(plan),
            storedAt: now,
            bytes: encoded.bytes,
            payload: encoded.payload,
          });
          await reconcile(store, now);
        }, undefined);
      }, undefined);
    },
    peek(skip) {
      return serialize<RetainedDiagnostic | undefined>(async () => {
        if (broken) return undefined;
        const now = currentTime();
        if (now === null) return undefined;
        return guarded(store => oldest(store, now, skip), undefined);
      }, undefined);
    },
    remove(sequence) {
      return serialize(async () => {
        if (broken || !safeInteger(sequence)) return;
        await guarded(store => store.remove([sequence]), undefined);
      }, undefined);
    },
    shift() {
      return serialize<DiagnosticEnvelope | undefined>(async () => {
        if (broken) return undefined;
        const now = currentTime();
        if (now === null) return undefined;
        return guarded<DiagnosticEnvelope | undefined>(async store => {
          const found = await oldest(store, now, undefined);
          if (!found) return undefined;
          await store.remove([found.sequence]);
          return found.envelope;
        }, undefined);
      }, undefined);
    },
    prune() {
      return serialize(async () => {
        if (broken) return;
        const now = currentTime();
        if (now === null) return;
        await guarded(async store => {
          await reconcile(store, now);
        }, undefined);
      }, undefined);
    },
  };
}

export interface DiagnosticRetentionDatabase {
  execute(
    sql: string,
    params?: (string | number)[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

export interface SqliteModule {
  openAsync(options: { name: string }): Promise<DiagnosticRetentionDatabase>;
}

export type SqliteModuleLoader = () => Promise<SqliteModule>;

const loadSqliteModule: SqliteModuleLoader = () =>
  import('@op-engineering/op-sqlite');

export async function openDiagnosticRetentionDatabase(
  loadSqlite: SqliteModuleLoader = loadSqliteModule,
): Promise<DiagnosticRetentionDatabase> {
  const sqlite = await loadSqlite();
  return sqlite.openAsync({ name: DIAGNOSTIC_RETENTION_DATABASE });
}

export function createSqliteRetentionStorage(
  openDatabase: () => Promise<DiagnosticRetentionDatabase>,
): DiagnosticRetentionStorage {
  const table = DIAGNOSTIC_RETENTION_TABLE;
  const createTable = `CREATE TABLE IF NOT EXISTS ${table} (sequence INTEGER PRIMARY KEY, stored_at INTEGER NOT NULL, bytes INTEGER NOT NULL, payload TEXT NOT NULL)`;
  let ready: Promise<DiagnosticRetentionDatabase> | null = null;

  function database(): Promise<DiagnosticRetentionDatabase> {
    if (!ready) {
      ready = (async () => {
        const db = await openDatabase();
        await db.execute(createTable);
        return db;
      })();
    }
    return ready;
  }

  return {
    async list() {
      const { rows } = await (
        await database()
      ).execute(
        `SELECT sequence, stored_at AS storedAt, max(bytes, length(CAST(payload AS BLOB))) AS bytes FROM ${table} ORDER BY sequence ASC`,
      );
      return rows;
    },
    async read(sequence) {
      const { rows } = await (
        await database()
      ).execute(`SELECT payload FROM ${table} WHERE sequence = ?`, [sequence]);
      return rows[0]?.payload;
    },
    async insert(item) {
      await (
        await database()
      ).execute(
        `INSERT INTO ${table} (sequence, stored_at, bytes, payload) VALUES (?, ?, ?, ?)`,
        [item.sequence, item.storedAt, item.bytes, item.payload],
      );
    },
    async remove(sequences) {
      const db = await database();
      for (let index = 0; index < sequences.length; index += 64) {
        const chunk = sequences.slice(index, index + 64);
        await db.execute(
          `DELETE FROM ${table} WHERE sequence IN (${chunk.map(() => '?').join(', ')})`,
          [...chunk],
        );
      }
    },
    async reset() {
      const db = await database();
      await db.execute(`DROP TABLE IF EXISTS ${table}`);
      await db.execute(createTable);
    },
  };
}

export type DiagnosticDelivery =
  | { readonly kind: 'accepted'; readonly retryAfterMs: number | null }
  | {
      readonly kind: 'retry';
      readonly retryAfterMs: number | null;
      readonly answered: boolean;
    }
  | { readonly kind: 'rejected' };

const UNANSWERED: DiagnosticDelivery = Object.freeze({
  kind: 'retry',
  retryAfterMs: null,
  answered: false,
});

const RETRY_AFTER_SECONDS = /^\d{1,9}$/;

function retryAfterMs(value: unknown, now: number): number | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (RETRY_AFTER_SECONDS.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function rateLimitMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  let longest: number | null = null;
  for (const entry of value.split(',')) {
    const [seconds = '', categories = ''] = entry.trim().split(':');
    if (!RETRY_AFTER_SECONDS.test(seconds)) continue;
    const limited =
      categories === '' || categories.split(';').includes('error');
    if (!limited) continue;
    const delayMs = Number(seconds) * 1000;
    if (longest === null || delayMs > longest) longest = delayMs;
  }
  return longest;
}

/**
 * Interpret a transport response the way the ingest meant it: only a 2xx is
 * an acceptance; 429/408/5xx and responses without a status (the transport
 * dropped the request locally, e.g. under its own rate limit) must be retried
 * later; any other status is a refusal that retrying cannot cure. An answered
 * refusal is authoritative, so its retry window is measured on the clock; a
 * rate-limit answer carries the delay the ingest asked for.
 */
export function classifyDiagnosticDelivery(
  result: unknown,
  now: number,
  delays: DiagnosticRetryDelays = DIAGNOSTIC_RETRY_DELAYS,
): DiagnosticDelivery {
  try {
    const response = record(result);
    const status = response?.statusCode;
    const headers = record(response?.headers);
    const limitMs =
      retryAfterMs(headers?.['retry-after'], now) ??
      rateLimitMs(headers?.['x-sentry-rate-limits']);
    if (typeof status !== 'number' || !Number.isFinite(status))
      return { kind: 'retry', retryAfterMs: limitMs, answered: false };
    if (status >= 200 && status < 300)
      return { kind: 'accepted', retryAfterMs: limitMs };
    if (status === 429) {
      return {
        kind: 'retry',
        retryAfterMs: limitMs ?? delays.rateLimitMs,
        answered: true,
      };
    }
    if (status === 408 || status >= 500)
      return { kind: 'retry', retryAfterMs: limitMs, answered: true };
    return { kind: 'rejected' };
  } catch {
    return UNANSWERED;
  }
}

export type DiagnosticRetrySchedule = (
  callback: () => void,
  delayMs: number,
) => (() => void) | void;

export interface RetainedTransportOptions {
  readonly store: BoundedDiagnosticStore;
  readonly schedule?: DiagnosticRetrySchedule;
  readonly delays?: DiagnosticRetryDelays;
  readonly flushAtStartup?: boolean;
  readonly now?: () => number;
}

const defaultSchedule: DiagnosticRetrySchedule = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

const noop = (): void => undefined;

function settled(action: () => unknown): boolean {
  try {
    action();
    return true;
  } catch {
    return false;
  }
}

async function attempted(action: () => PromiseLike<unknown>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch {
    return false;
  }
}

function restamped(
  envelope: DiagnosticEnvelope,
  now: number,
): DiagnosticEnvelope {
  if (!Number.isFinite(now)) return envelope;
  const [header, items] = envelope;
  return [
    { ...header, sent_at: new Date(now).toISOString() },
    items,
  ] as DiagnosticEnvelope;
}

type DiagnosticDeliveryResult = Awaited<
  ReturnType<DiagnosticTransport['send']>
>;

type DrainOutcome = 'delivered' | 'idle' | 'paused' | 'retry';

export function createRetainedTransport(
  sink: DiagnosticTransport,
  options: RetainedTransportOptions,
): DiagnosticTransport {
  const { store } = options;
  const delays = options.delays ?? DIAGNOSTIC_RETRY_DELAYS;
  const schedule = options.schedule ?? defaultSchedule;
  const clock = options.now ?? Date.now;
  const inFlight = new Set<number>();
  let claiming: Promise<unknown> = Promise.resolve();
  let retryDelay = delays.initialMs;
  let pausedUntil = Number.NEGATIVE_INFINITY;
  let cancel: (() => void) | null = null;

  function now(): number {
    try {
      const value = clock();
      return Number.isFinite(value) ? value : Number.NaN;
    } catch {
      return Number.NaN;
    }
  }

  function arm(delayMs: number, replace: boolean): void {
    if (cancel) {
      if (!replace) return;
      settled(cancel);
      cancel = null;
    }
    try {
      const handle = schedule(
        () => {
          cancel = null;
          void drain().catch(noop);
        },
        Number.isFinite(delayMs) ? Math.max(0, delayMs) : delays.maxMs,
      );
      cancel = typeof handle === 'function' ? handle : noop;
    } catch {
      cancel = null;
    }
  }

  function remaining(): number {
    const at = now();
    return Number.isFinite(at) && at < pausedUntil ? pausedUntil - at : 0;
  }

  function pause(delayMs: number, replace: boolean): void {
    const at = now();
    if (Number.isFinite(at)) {
      pausedUntil = Math.max(
        pausedUntil,
        at + Math.min(Math.max(0, delayMs), delays.maxMs),
      );
    }
    arm(Number.isFinite(at) ? remaining() : delays.maxMs, replace);
  }

  function backoff(onClock: boolean): void {
    if (cancel) return;
    const delayMs = retryDelay;
    retryDelay = Math.min(retryDelay * 2, delays.maxMs);
    if (onClock) pause(delayMs, false);
    else arm(delayMs, false);
  }

  function postpone(delivery: DiagnosticDelivery): void {
    if (delivery.kind !== 'retry') return;
    if (delivery.retryAfterMs !== null) pause(delivery.retryAfterMs, true);
    else if (remaining() > 0) arm(remaining(), false);
    else backoff(delivery.answered);
  }

  function resume(): void {
    pausedUntil = Number.NEGATIVE_INFINITY;
    retryDelay = delays.initialMs;
  }

  function drainSoon(): void {
    arm(delays.drainMs, true);
  }

  function claim(): Promise<RetainedDiagnostic | undefined> {
    const next = claiming
      .then(() => store.peek(inFlight))
      .then(found => {
        if (found) inFlight.add(found.sequence);
        return found;
      });
    claiming = next.catch(noop);
    return next;
  }

  async function deliver(envelope: DiagnosticEnvelope): Promise<{
    delivery: DiagnosticDelivery;
    result: DiagnosticDeliveryResult;
  }> {
    try {
      const result = await sink.send(envelope);
      return {
        delivery: classifyDiagnosticDelivery(result, now(), delays),
        result,
      };
    } catch {
      return { delivery: UNANSWERED, result: {} };
    }
  }

  async function drainOnce(): Promise<DrainOutcome> {
    if (remaining() > 0) return 'paused';
    const next = await claim();
    if (!next) {
      retryDelay = delays.initialMs;
      return 'idle';
    }
    try {
      const { delivery } = await deliver(restamped(next.envelope, now()));
      if (delivery.kind === 'retry') {
        postpone(delivery);
        return 'retry';
      }
      await attempted(() => store.remove(next.sequence));
      retryDelay = delays.initialMs;
      if (delivery.kind === 'accepted' && delivery.retryAfterMs !== null) {
        pause(delivery.retryAfterMs, true);
        return 'paused';
      }
      return 'delivered';
    } finally {
      inFlight.delete(next.sequence);
    }
  }

  function follow(outcome: DrainOutcome, continueSoon: boolean): void {
    if (outcome === 'delivered') {
      if (continueSoon) drainSoon();
    } else if (outcome === 'paused' || outcome === 'retry') {
      arm(remaining(), false);
    }
  }

  async function drain(): Promise<void> {
    follow(await drainOnce(), true);
  }

  function budget(timeout: number | undefined): {
    expired: Promise<undefined>;
    release: () => void;
  } {
    let release: () => void = noop;
    const expired = new Promise<undefined>(resolve => {
      if (typeof timeout !== 'number' || !Number.isFinite(timeout)) return;
      try {
        const handle = schedule(() => resolve(undefined), Math.max(0, timeout));
        release = typeof handle === 'function' ? handle : noop;
      } catch {
        resolve(undefined);
      }
    });
    return { expired, release: () => settled(release) };
  }

  if (options.flushAtStartup !== false) arm(delays.initialMs, false);

  return {
    async send(envelope) {
      const { delivery, result } = await deliver(envelope);
      if (delivery.kind === 'retry') {
        const retained = await attempted(() => store.push(envelope));
        if (retained || delivery.retryAfterMs !== null) postpone(delivery);
        return result;
      }
      resume();
      if (delivery.kind === 'accepted' && delivery.retryAfterMs !== null)
        pause(delivery.retryAfterMs, true);
      else drainSoon();
      return result;
    },
    async flush(timeout) {
      const { expired, release } = budget(timeout);
      try {
        for (;;) {
          const step = drainOnce().catch((): DrainOutcome => 'idle');
          const outcome = await Promise.race([step, expired]);
          if (outcome === undefined) {
            void step.then(late => follow(late, true));
            break;
          }
          follow(outcome, false);
          if (outcome !== 'delivered') break;
        }
      } finally {
        release();
      }
      try {
        return await sink.flush(timeout);
      } catch {
        return false;
      }
    },
  };
}

export interface DiagnosticRetentionOptions {
  readonly storage?: DiagnosticRetentionStorageSource;
  readonly loadSqlite?: SqliteModuleLoader;
  readonly limits?: DiagnosticRetentionLimits;
  readonly now?: () => number;
  readonly schedule?: DiagnosticRetrySchedule;
  readonly delays?: DiagnosticRetryDelays;
}

export interface DiagnosticRetention {
  readonly store: BoundedDiagnosticStore;
  readonly retain: (sink: DiagnosticTransport) => DiagnosticTransport;
}

export function createDiagnosticRetention(
  identity: DiagnosticsIdentity,
  options: DiagnosticRetentionOptions = {},
): DiagnosticRetention {
  const store = createBoundedDiagnosticStore({
    storage:
      options.storage ??
      (() =>
        createSqliteRetentionStorage(() =>
          openDiagnosticRetentionDatabase(options.loadSqlite),
        )),
    identity,
    limits: options.limits,
    now: options.now,
  });
  return {
    store,
    retain: sink =>
      createRetainedTransport(sink, {
        store,
        schedule: options.schedule,
        delays: options.delays,
        now: options.now,
      }),
  };
}
