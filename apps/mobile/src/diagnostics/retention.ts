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
}

export const DIAGNOSTIC_RETRY_DELAYS: DiagnosticRetryDelays = Object.freeze({
  drainMs: 100,
  initialMs: 5_000,
  maxMs: 3_600_000,
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
  readonly reset: boolean;
}

const RESET_PLAN: DiagnosticRetentionPlan = Object.freeze({
  kept: Object.freeze([]),
  evicted: Object.freeze([]),
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
    for (const item of rows) {
      const value = record(item);
      const sequence = value?.sequence;
      if (!value || !safeInteger(sequence) || seen.has(sequence))
        return RESET_PLAN;
      seen.add(sequence);
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
    return { kept: kept.slice(start), evicted, reset: false };
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

function decodeEnvelope(
  payload: unknown,
  identity: DiagnosticsIdentity,
  limits: DiagnosticRetentionLimits,
): DiagnosticEnvelope | null {
  try {
    if (typeof payload !== 'string' || payload.length > limits.maxEnvelopeBytes)
      return null;
    return scrubDiagnosticEnvelope(JSON.parse(payload), identity);
  } catch {
    return null;
  }
}

export interface BoundedDiagnosticStore {
  push(envelope: DiagnosticEnvelope): Promise<void>;
  unshift(envelope: DiagnosticEnvelope): Promise<void>;
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
  const storedAtOf = new WeakMap<object, number>();
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
  ): Promise<readonly RetainedDiagnosticRow[]> {
    const plan = planDiagnosticRetention(await store.list(), now, limits);
    if (plan.reset) {
      await store.reset();
      return [];
    }
    if (plan.evicted.length > 0) await store.remove(plan.evicted);
    return plan.kept;
  }

  function currentTime(): number | null {
    const now = clock();
    return Number.isFinite(now) ? now : null;
  }

  function insert(envelope: unknown, front: boolean): Promise<void> {
    return serialize(async () => {
      if (broken || !releaseIdentity) return;
      const encoded = encodeEnvelope(envelope, releaseIdentity, limits);
      if (!encoded) return;
      const now = currentTime();
      if (now === null) return;
      const remembered =
        typeof envelope === 'object' && envelope !== null
          ? storedAtOf.get(envelope)
          : undefined;
      await guarded(async store => {
        const kept = await reconcile(store, now);
        const first = kept[0];
        const last = kept[kept.length - 1];
        const sequence = front
          ? (first?.sequence ?? 1) - 1
          : (last?.sequence ?? 0) + 1;
        await store.insert({
          sequence,
          storedAt: remembered ?? now,
          bytes: encoded.bytes,
          payload: encoded.payload,
        });
        await reconcile(store, now);
      }, undefined);
    }, undefined);
  }

  return {
    push: envelope => insert(envelope, false),
    unshift: envelope => insert(envelope, true),
    shift() {
      return serialize<DiagnosticEnvelope | undefined>(async () => {
        if (broken || !releaseIdentity) return undefined;
        const now = currentTime();
        if (now === null) return undefined;
        return guarded<DiagnosticEnvelope | undefined>(async store => {
          for (const row of await reconcile(store, now)) {
            const payload = await store.read(row.sequence);
            await store.remove([row.sequence]);
            const envelope = decodeEnvelope(payload, releaseIdentity, limits);
            if (envelope) {
              storedAtOf.set(envelope, row.storedAt);
              return envelope;
            }
          }
          return undefined;
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
        `SELECT sequence, stored_at AS storedAt, bytes FROM ${table} ORDER BY sequence ASC`,
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

export type DiagnosticRetrySchedule = (
  callback: () => void,
  delayMs: number,
) => (() => void) | void;

export interface RetainedTransportOptions {
  readonly store: BoundedDiagnosticStore;
  readonly schedule?: DiagnosticRetrySchedule;
  readonly delays?: DiagnosticRetryDelays;
  readonly flushAtStartup?: boolean;
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

export function createRetainedTransport(
  sink: DiagnosticTransport,
  options: RetainedTransportOptions,
): DiagnosticTransport {
  const { store } = options;
  const delays = options.delays ?? DIAGNOSTIC_RETRY_DELAYS;
  const schedule = options.schedule ?? defaultSchedule;
  let retryDelay = delays.initialMs;
  let cancel: (() => void) | null = null;
  let draining = false;

  function arm(delayMs: number, replace: boolean): void {
    if (cancel) {
      if (!replace) return;
      settled(cancel);
      cancel = null;
    }
    try {
      const handle = schedule(() => {
        cancel = null;
        void drain().catch(noop);
      }, delayMs);
      cancel = typeof handle === 'function' ? handle : noop;
    } catch {
      cancel = null;
    }
  }

  function drainSoon(): void {
    arm(delays.drainMs, true);
  }

  function backoff(): void {
    if (cancel) return;
    const delayMs = retryDelay;
    retryDelay = Math.min(retryDelay * 2, delays.maxMs);
    arm(delayMs, false);
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      const envelope = await store.shift();
      if (!envelope) return;
      if (await attempted(() => sink.send(envelope))) {
        retryDelay = delays.initialMs;
        drainSoon();
      } else {
        await store.unshift(envelope);
        backoff();
      }
    } finally {
      draining = false;
    }
  }

  if (options.flushAtStartup !== false) backoff();

  return {
    async send(envelope) {
      try {
        const result = await sink.send(envelope);
        retryDelay = delays.initialMs;
        drainSoon();
        return result;
      } catch {
        if (await attempted(() => store.push(envelope))) backoff();
        return {};
      }
    },
    async flush(timeout) {
      drainSoon();
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
      }),
  };
}
