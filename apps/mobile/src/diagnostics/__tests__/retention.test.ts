/**
 * W10-02 — bounded offline diagnostic retention.
 *
 * The on-disk diagnostic buffer must have hard size and age caps with
 * deterministic oldest-first eviction, tolerate corrupt rows/schemas, never
 * block the caller, and never hold anything the scrub layer would not send.
 * The store is exercised against an in-memory storage fake (policy) and a
 * REAL SQLite database (node:sqlite, Node 22.13+) driven through the same
 * `execute()` seam op-sqlite exposes on device.
 */
import type { ErrorEvent } from '@sentry/react-native';
import type {
  DiagnosticEnvelope,
  DiagnosticsIdentity,
  DiagnosticTransport,
  DiagnosticTransportFactory,
} from '../privacy';
import {
  createBoundedDiagnosticStore,
  createDiagnosticRetention,
  createRetainedTransport,
  createSqliteRetentionStorage,
  DIAGNOSTIC_RETENTION_DATABASE,
  DIAGNOSTIC_RETENTION_LIMITS,
  DIAGNOSTIC_RETENTION_TABLE,
  DIAGNOSTIC_RETRY_DELAYS,
  openDiagnosticRetentionDatabase,
  planDiagnosticRetention,
  type DiagnosticRetentionDatabase,
  type DiagnosticRetentionLimits,
  type DiagnosticRetentionStorage,
  type RetainedDiagnosticRecord,
} from '../retention';
import { scrubDiagnosticEnvelope } from '../scrub';
import { optionsForDiagnostics } from '../sentry';

const identity: DiagnosticsIdentity = {
  bundleIdentifier: 'com.picklesensei',
  marketingVersion: '1.0',
  nativeBuildNumber: '1',
  sourceRevision: 'a'.repeat(40),
  environment: 'test',
  modelVersion: 'scoring-v1',
  policyVersion: 'policy-v1',
};
const marker = 'SENSITIVE_FIXTURE_DO_NOT_TRANSMIT';
const T0 = 1_757_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function dirtyEvent(index: number): ErrorEvent {
  return {
    type: undefined,
    platform: 'javascript',
    level: 'error',
    event_id: index.toString(16).padStart(32, '0'),
    timestamp: 1_757_000_000 + index,
    message: marker,
    user: { id: marker, email: `${marker}@example.com` },
    tags: { diagnostic_origin: 'handled_js', owner: marker },
    exception: {
      values: [
        {
          type: 'TypeError',
          value: marker,
          stacktrace: {
            frames: [
              {
                filename: `file:///private/${marker}/main.jsbundle`,
                function: marker,
                lineno: 1 + index,
                colno: 400,
              },
            ],
          },
        },
      ],
    },
  };
}

function envelope(index: number): DiagnosticEnvelope {
  return [
    { event_id: dirtyEvent(index).event_id, sent_at: marker },
    [
      [{ type: 'attachment', filename: marker, length: marker.length }, marker],
      [{ type: 'event' }, dirtyEvent(index)],
    ],
  ] as unknown as DiagnosticEnvelope;
}

function clean(index: number): DiagnosticEnvelope {
  const scrubbed = scrubDiagnosticEnvelope(envelope(index), identity);
  if (!scrubbed) throw new Error('fixture must scrub to an envelope');
  return scrubbed;
}

function expectNoMarker(value: unknown): void {
  expect(JSON.stringify(value) ?? '').not.toContain(marker);
}

// ─── storage fakes ───────────────────────────────────────────────────────────

type StorageMethod = keyof DiagnosticRetentionStorage;

function memoryStorage() {
  const rows = new Map<number, RetainedDiagnosticRecord>();
  const calls: StorageMethod[] = [];
  const failures = new Map<StorageMethod, number>();
  let resets = 0;
  const maybeFail = (method: StorageMethod) => {
    calls.push(method);
    const remaining = failures.get(method) ?? 0;
    if (remaining > 0) {
      failures.set(method, remaining - 1);
      throw new Error(`${method} failed`);
    }
  };
  const storage: DiagnosticRetentionStorage = {
    async list() {
      maybeFail('list');
      return [...rows.values()]
        .sort((a, b) => a.sequence - b.sequence)
        .map(({ sequence, storedAt, bytes }) => ({
          sequence,
          storedAt,
          bytes,
        }));
    },
    async read(sequence) {
      maybeFail('read');
      return rows.get(sequence)?.payload;
    },
    async insert(record) {
      maybeFail('insert');
      if (rows.has(record.sequence)) throw new Error('duplicate sequence');
      rows.set(record.sequence, { ...record });
    },
    async remove(sequences) {
      maybeFail('remove');
      for (const sequence of sequences) rows.delete(sequence);
    },
    async reset() {
      maybeFail('reset');
      resets += 1;
      rows.clear();
    },
  };
  return {
    storage,
    rows,
    calls,
    get resets() {
      return resets;
    },
    failNext(method: StorageMethod, times = 1) {
      failures.set(method, times);
    },
    sequences: () => [...rows.keys()].sort((a, b) => a - b),
    payloads: () =>
      [...rows.values()]
        .sort((a, b) => a.sequence - b.sequence)
        .map(row => row.payload),
  };
}

interface NodeSqliteStatement {
  columns(): unknown[];
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number | bigint };
}
interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
  close(): void;
}

const openDatabases: NodeSqliteDatabase[] = [];

function nodeSqlite(): {
  native: NodeSqliteDatabase;
  database: DiagnosticRetentionDatabase;
  statements: string[];
  count(): number;
  payloads(): string[];
} {
  const { DatabaseSync } = jest.requireActual<{
    DatabaseSync: new (path: string) => NodeSqliteDatabase;
  }>('node:sqlite');
  const native = new DatabaseSync(':memory:');
  openDatabases.push(native);
  const statements: string[] = [];
  const database: DiagnosticRetentionDatabase = {
    async execute(sql, params = []) {
      statements.push(sql);
      const statement = native.prepare(sql);
      return statement.columns().length > 0
        ? { rows: statement.all(...params) }
        : (statement.run(...params), { rows: [] });
    },
  };
  return {
    native,
    database,
    statements,
    count: () =>
      Number(
        native
          .prepare(`SELECT count(*) AS n FROM ${DIAGNOSTIC_RETENTION_TABLE}`)
          .all()[0]?.n,
      ),
    payloads: () =>
      native
        .prepare(
          `SELECT payload FROM ${DIAGNOSTIC_RETENTION_TABLE} ORDER BY sequence ASC`,
        )
        .all()
        .map(row => String(row.payload)),
  };
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  jest.useRealTimers();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

// ─── policy ──────────────────────────────────────────────────────────────────

describe('retention limits', () => {
  it('pins finite hard caps for count, bytes, single envelope size and age', () => {
    expect(DIAGNOSTIC_RETENTION_LIMITS).toEqual({
      maxEnvelopes: 32,
      maxTotalBytes: 262_144,
      maxEnvelopeBytes: 32_768,
      maxAgeMs: 7 * DAY_MS,
    });
    expect(Object.isFrozen(DIAGNOSTIC_RETENTION_LIMITS)).toBe(true);
    expect(DIAGNOSTIC_RETRY_DELAYS).toEqual({
      drainMs: 100,
      initialMs: 5_000,
      maxMs: 3_600_000,
    });
    expect(DIAGNOSTIC_RETENTION_DATABASE).toBe('pickle-sensei-diagnostics.db');
    expect(DIAGNOSTIC_RETENTION_TABLE).toBe('diagnostic_envelope');
  });
});

describe('planDiagnosticRetention', () => {
  const limits: DiagnosticRetentionLimits = {
    maxEnvelopes: 3,
    maxTotalBytes: 1_000,
    maxEnvelopeBytes: 600,
    maxAgeMs: DAY_MS,
  };
  const row = (sequence: number, storedAt: number, bytes: number) => ({
    sequence,
    storedAt,
    bytes,
  });

  it('keeps valid rows oldest-first and evicts rows past the age cap in either direction', () => {
    const plan = planDiagnosticRetention(
      [
        row(5, T0, 10),
        row(2, T0 - DAY_MS - 1, 10),
        row(3, T0 - DAY_MS, 10),
        row(4, T0 + DAY_MS + 1, 10),
      ],
      T0,
      limits,
    );
    expect(plan).toEqual({
      kept: [row(3, T0 - DAY_MS, 10), row(5, T0, 10)],
      evicted: [2, 4],
      reset: false,
    });
  });

  it('evicts oldest-first until both the count and the byte caps hold', () => {
    const byCount = planDiagnosticRetention(
      [1, 2, 3, 4, 5].map(sequence => row(sequence, T0, 10)),
      T0,
      limits,
    );
    expect(byCount.kept.map(item => item.sequence)).toEqual([3, 4, 5]);
    expect(byCount.evicted).toEqual([1, 2]);
    const byBytes = planDiagnosticRetention(
      [row(1, T0, 400), row(2, T0, 400), row(3, T0, 400)],
      T0,
      limits,
    );
    expect(byBytes.kept.map(item => item.sequence)).toEqual([2, 3]);
    expect(byBytes.evicted).toEqual([1]);
    const oversized = planDiagnosticRetention(
      [row(1, T0, 601), row(2, T0, 600)],
      T0,
      limits,
    );
    expect(oversized.kept.map(item => item.sequence)).toEqual([2]);
    expect(oversized.evicted).toEqual([1]);
  });

  it('is deterministic and independent of the order rows are read back in', () => {
    const rows = [row(3, T0, 10), row(1, T0 - 5, 10), row(2, T0 - 3, 10)];
    const forward = planDiagnosticRetention(rows, T0, limits);
    const reversed = planDiagnosticRetention([...rows].reverse(), T0, limits);
    expect(reversed).toEqual(forward);
    expect(forward.kept.map(item => item.sequence)).toEqual([1, 2, 3]);
    expect(planDiagnosticRetention([], T0, limits)).toEqual({
      kept: [],
      evicted: [],
      reset: false,
    });
  });

  it('evicts malformed rows and resets when rows cannot be addressed', () => {
    const malformed = planDiagnosticRetention(
      [
        row(1, T0, 10),
        { sequence: 2, storedAt: 'yesterday', bytes: 10 },
        { sequence: 3, storedAt: Number.NaN, bytes: 10 },
        { sequence: 4, storedAt: T0, bytes: -1 },
        { sequence: 5, storedAt: T0, bytes: 1.5 },
        { sequence: 6, storedAt: T0, bytes: '10' },
        { sequence: 7, storedAt: -1, bytes: 10 },
        { sequence: 8, storedAt: T0 },
      ],
      T0,
      limits,
    );
    expect(malformed.kept.map(item => item.sequence)).toEqual([1]);
    expect(malformed.evicted).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(malformed.reset).toBe(false);
    for (const rows of [
      [null],
      [marker],
      [{}],
      [{ sequence: '1', storedAt: T0, bytes: 10 }],
      [{ sequence: 1.5, storedAt: T0, bytes: 10 }],
      [{ sequence: Number.POSITIVE_INFINITY, storedAt: T0, bytes: 10 }],
      [row(1, T0, 10), row(1, T0, 10)],
    ]) {
      expect(planDiagnosticRetention(rows, T0, limits)).toEqual({
        kept: [],
        evicted: [],
        reset: true,
      });
    }
    expect(planDiagnosticRetention(marker as never, T0, limits)).toEqual({
      kept: [],
      evicted: [],
      reset: true,
    });
    const hostile = Object.defineProperty({}, 'sequence', {
      get() {
        throw new Error(marker);
      },
    });
    expect(planDiagnosticRetention([hostile], T0, limits).reset).toBe(true);
  });
});

// ─── bounded store ───────────────────────────────────────────────────────────

describe('createBoundedDiagnosticStore', () => {
  it('round-trips envelopes oldest-first, storing only their scrubbed form', async () => {
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0,
    });
    await store.push(envelope(1));
    await store.push(envelope(2));
    expect(memory.sequences()).toEqual([1, 2]);
    expectNoMarker(memory.payloads());
    expect(memory.payloads().map(payload => JSON.parse(payload))).toEqual([
      clean(1),
      clean(2),
    ]);
    expect(memory.rows.get(1)).toMatchObject({
      storedAt: T0,
      bytes: memory.rows.get(1)!.payload.length,
    });
    await expect(store.shift()).resolves.toEqual(clean(1));
    await expect(store.shift()).resolves.toEqual(clean(2));
    await expect(store.shift()).resolves.toBeUndefined();
    expect(memory.sequences()).toEqual([]);
  });

  it('never stores envelopes the scrub layer rejects', async () => {
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0,
    });
    const rejected: unknown[] = [
      marker,
      [{}, []],
      [{}, [[{ type: 'attachment', filename: marker }, marker]]],
      [{}, [[{ type: 'event' }, { ...dirtyEvent(1), level: 'info' }]]],
      [{}, [[{ type: 'event' }, { ...dirtyEvent(1), platform: 'java' }]]],
      [{}, [[{ type: 'event' }, { ...dirtyEvent(1), event_id: marker }]]],
      null,
      undefined,
    ];
    for (const value of rejected) {
      await store.push(value as DiagnosticEnvelope);
      await store.unshift(value as DiagnosticEnvelope);
    }
    expect(memory.sequences()).toEqual([]);
    expect(memory.calls).not.toContain('insert');
  });

  it('drops an envelope that fails a retention gate without consulting storage', async () => {
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      limits: { ...DIAGNOSTIC_RETENTION_LIMITS, maxEnvelopeBytes: 16 },
      now: () => T0,
    });
    await store.push(envelope(1));
    expect(memory.calls).toEqual([]);
    expect(memory.sequences()).toEqual([]);
  });

  it('enforces the count cap by evicting the oldest envelopes', async () => {
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      limits: { ...DIAGNOSTIC_RETENTION_LIMITS, maxEnvelopes: 3 },
      now: () => T0,
    });
    for (let index = 1; index <= 5; index += 1)
      await store.push(envelope(index));
    expect(memory.sequences()).toEqual([3, 4, 5]);
    await expect(store.shift()).resolves.toEqual(clean(3));
  });

  it('enforces the byte cap by evicting the oldest envelopes', async () => {
    const probe = memoryStorage();
    await createBoundedDiagnosticStore({
      storage: probe.storage,
      identity,
      now: () => T0,
    }).push(envelope(1));
    const bytes = probe.rows.get(1)!.bytes;
    expect(bytes).toBeGreaterThan(0);
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      limits: {
        ...DIAGNOSTIC_RETENTION_LIMITS,
        maxTotalBytes: bytes * 2 + Math.floor(bytes / 2),
      },
      now: () => T0,
    });
    for (let index = 1; index <= 4; index += 1)
      await store.push(envelope(index));
    expect(memory.sequences()).toEqual([3, 4]);
    const total = [...memory.rows.values()].reduce(
      (sum, row) => sum + row.bytes,
      0,
    );
    expect(total).toBeLessThanOrEqual(bytes * 2 + Math.floor(bytes / 2));
  });

  it('expires envelopes past the age cap and keeps counting age across unshift', async () => {
    let now = T0;
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => now,
    });
    await store.push(envelope(1));
    now = T0 + DIAGNOSTIC_RETENTION_LIMITS.maxAgeMs;
    await store.push(envelope(2));
    expect(memory.sequences()).toEqual([1, 2]);
    now += 1;
    await expect(store.shift()).resolves.toEqual(clean(2));
    expect(memory.sequences()).toEqual([]);

    now = T0;
    await store.push(envelope(3));
    const taken = await store.shift();
    expect(taken).toEqual(clean(3));
    now = T0 + DIAGNOSTIC_RETENTION_LIMITS.maxAgeMs - 1;
    await store.unshift(taken!);
    expect(memory.rows.get(memory.sequences()[0]!)).toMatchObject({
      storedAt: T0,
    });
    now += 2;
    await expect(store.shift()).resolves.toBeUndefined();
    expect(memory.sequences()).toEqual([]);
  });

  it('puts an unshifted envelope back at the front deterministically', async () => {
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0,
    });
    await store.push(envelope(1));
    await store.push(envelope(2));
    const first = await store.shift();
    await store.push(envelope(3));
    await store.unshift(first!);
    expect(memory.payloads().map(payload => JSON.parse(payload))).toEqual([
      clean(1),
      clean(2),
      clean(3),
    ]);
    await expect(store.shift()).resolves.toEqual(clean(1));
    await store.unshift(clean(4));
    await expect(store.shift()).resolves.toEqual(clean(4));
  });

  it('serialises concurrent operations and never touches storage synchronously', async () => {
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0,
    });
    const pending = [1, 2, 3, 4, 5].map(index => store.push(envelope(index)));
    const shifted = store.shift();
    expect(memory.calls).toEqual([]);
    await Promise.all(pending);
    await expect(shifted).resolves.toEqual(clean(1));
    expect(memory.sequences()).toEqual([2, 3, 4, 5]);
    expect(memory.payloads().map(payload => JSON.parse(payload))).toEqual([
      clean(2),
      clean(3),
      clean(4),
      clean(5),
    ]);
  });

  it('isolates storage failures, recovers once by reset, and stays inert if reset fails', async () => {
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0,
    });
    await store.push(envelope(1));
    memory.failNext('insert');
    await expect(store.push(envelope(2))).resolves.toBeUndefined();
    expect(memory.resets).toBe(1);
    await store.push(envelope(3));
    await expect(store.shift()).resolves.toEqual(clean(3));
    memory.failNext('list');
    await expect(store.shift()).resolves.toBeUndefined();
    expect(memory.resets).toBe(1);
    const callsAfterBreak = memory.calls.length;
    await expect(store.push(envelope(4))).resolves.toBeUndefined();
    await expect(store.unshift(envelope(4))).resolves.toBeUndefined();
    await expect(store.shift()).resolves.toBeUndefined();
    await expect(store.prune()).resolves.toBeUndefined();
    expect(memory.calls.length).toBe(callsAfterBreak);
  });

  it('goes inert when the recovery reset itself fails', async () => {
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0,
    });
    memory.failNext('list');
    memory.failNext('reset');
    await expect(store.push(envelope(1))).resolves.toBeUndefined();
    expect(memory.resets).toBe(0);
    const callsAfterBreak = memory.calls.length;
    await expect(store.shift()).resolves.toBeUndefined();
    await expect(store.push(envelope(2))).resolves.toBeUndefined();
    expect(memory.calls.length).toBe(callsAfterBreak);
    expect(memory.sequences()).toEqual([]);
  });

  it('treats a storage factory that rejects or throws as an inert buffer', async () => {
    const rejecting = createBoundedDiagnosticStore({
      storage: async () => {
        throw new Error(marker);
      },
      identity,
      now: () => T0,
    });
    await expect(rejecting.push(envelope(1))).resolves.toBeUndefined();
    await expect(rejecting.shift()).resolves.toBeUndefined();
    const throwing = createBoundedDiagnosticStore({
      storage: () => {
        throw new Error(marker);
      },
      identity,
      now: () => T0,
    });
    await expect(throwing.unshift(envelope(1))).resolves.toBeUndefined();
    await expect(throwing.shift()).resolves.toBeUndefined();
    const hostileClock = createBoundedDiagnosticStore({
      storage: memoryStorage().storage,
      identity,
      now: () => {
        throw new Error(marker);
      },
    });
    await expect(hostileClock.push(envelope(1))).resolves.toBeUndefined();
    await expect(hostileClock.shift()).resolves.toBeUndefined();
  });

  it('opens storage lazily and only once', async () => {
    const memory = memoryStorage();
    const open = jest.fn(async () => memory.storage);
    const store = createBoundedDiagnosticStore({
      storage: open,
      identity,
      now: () => T0,
    });
    expect(open).not.toHaveBeenCalled();
    await Promise.all([store.push(envelope(1)), store.push(envelope(2))]);
    await store.prune();
    expect(open).toHaveBeenCalledTimes(1);
    expect(memory.sequences()).toEqual([1, 2]);
  });
});

// ─── real SQLite through the op-sqlite execute() seam ────────────────────────

describe('SQLite retention storage', () => {
  it('creates a bounded table and round-trips envelopes through real SQLite', async () => {
    const sqlite = nodeSqlite();
    const store = createBoundedDiagnosticStore({
      storage: createSqliteRetentionStorage(async () => sqlite.database),
      identity,
      now: () => T0,
    });
    await store.push(envelope(1));
    await store.push(envelope(2));
    expect(sqlite.count()).toBe(2);
    for (const payload of sqlite.payloads())
      expect(payload).not.toContain(marker);
    const columns = sqlite.native
      .prepare(`PRAGMA table_info(${DIAGNOSTIC_RETENTION_TABLE})`)
      .all()
      .map(column => `${String(column.name)}:${String(column.type)}`);
    expect(columns).toEqual([
      'sequence:INTEGER',
      'stored_at:INTEGER',
      'bytes:INTEGER',
      'payload:TEXT',
    ]);
    await expect(store.shift()).resolves.toEqual(clean(1));
    await expect(store.shift()).resolves.toEqual(clean(2));
    await expect(store.shift()).resolves.toBeUndefined();
    expect(sqlite.count()).toBe(0);
    expect(
      sqlite.statements.filter(sql => /CREATE TABLE/i.test(sql)),
    ).toHaveLength(1);
  });

  it('evicts corrupt, foreign and unparseable rows instead of sending or crashing on them', async () => {
    const sqlite = nodeSqlite();
    const store = createBoundedDiagnosticStore({
      storage: createSqliteRetentionStorage(async () => sqlite.database),
      identity,
      now: () => T0,
    });
    await store.push(envelope(1));
    const insert = sqlite.native.prepare(
      `INSERT INTO ${DIAGNOSTIC_RETENTION_TABLE} (sequence, stored_at, bytes, payload) VALUES (?, ?, ?, ?)`,
    );
    insert.run(-3, T0, 5, '{not json');
    insert.run(-2, T0, 5, JSON.stringify({ hello: marker }));
    insert.run(-1, T0, 5, JSON.stringify([{}, []]));
    insert.run(
      2,
      T0,
      5,
      JSON.stringify([
        {},
        [[{ type: 'event' }, { ...dirtyEvent(2), platform: 'java' }]],
      ]),
    );
    insert.run(3, T0, 5, JSON.stringify(envelope(3)));
    insert.run(4, 'yesterday', 5, JSON.stringify(clean(4)));
    insert.run(5, T0, 'many', JSON.stringify(clean(5)));
    insert.run(
      6,
      T0,
      5,
      'x'.repeat(DIAGNOSTIC_RETENTION_LIMITS.maxEnvelopeBytes + 1),
    );
    sqlite.native
      .prepare(
        `INSERT INTO ${DIAGNOSTIC_RETENTION_TABLE} (sequence, stored_at, bytes, payload) VALUES (?, ?, ?, X'00ff')`,
      )
      .run(7, T0, 5);
    expect(sqlite.count()).toBe(10);
    await expect(store.shift()).resolves.toEqual(clean(1));
    await expect(store.shift()).resolves.toEqual(clean(3));
    await expect(store.shift()).resolves.toBeUndefined();
    expect(sqlite.count()).toBe(0);
  });

  it('recovers from an incompatible schema by rebuilding the table once', async () => {
    const sqlite = nodeSqlite();
    sqlite.native.exec(
      `CREATE TABLE ${DIAGNOSTIC_RETENTION_TABLE} (id TEXT PRIMARY KEY, blob TEXT)`,
    );
    sqlite.native
      .prepare(`INSERT INTO ${DIAGNOSTIC_RETENTION_TABLE} VALUES (?, ?)`)
      .run('legacy', marker);
    const store = createBoundedDiagnosticStore({
      storage: createSqliteRetentionStorage(async () => sqlite.database),
      identity,
      now: () => T0,
    });
    await expect(store.push(envelope(1))).resolves.toBeUndefined();
    await store.push(envelope(2));
    await expect(store.shift()).resolves.toEqual(clean(2));
    expect(sqlite.count()).toBe(0);
    for (const payload of sqlite.payloads())
      expect(payload).not.toContain(marker);
    expect(
      sqlite.statements.filter(sql => /DROP TABLE/i.test(sql)),
    ).toHaveLength(1);
  });

  it('stays inert when the database cannot be opened', async () => {
    const store = createBoundedDiagnosticStore({
      storage: createSqliteRetentionStorage(async () => {
        throw new Error(marker);
      }),
      identity,
      now: () => T0,
    });
    await expect(store.push(envelope(1))).resolves.toBeUndefined();
    await expect(store.shift()).resolves.toBeUndefined();
  });
});

// ─── retained transport ──────────────────────────────────────────────────────

type Scheduled = { callback: () => void; delayMs: number };

function scheduler() {
  const queue: Scheduled[] = [];
  const delays: number[] = [];
  return {
    queue,
    delays,
    schedule: jest.fn((callback: () => void, delayMs: number) => {
      const entry = { callback, delayMs };
      queue.push(entry);
      delays.push(delayMs);
      return () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
      };
    }),
    async fire(): Promise<void> {
      const entry = queue.shift();
      if (!entry) throw new Error('nothing scheduled');
      entry.callback();
      await settle();
    },
  };
}

function sinkWith(mode: { fail: boolean }) {
  const send = jest.fn(async () => {
    if (mode.fail) throw new Error(marker);
    return { statusCode: 200 };
  });
  const flush = jest.fn(async () => true);
  const sink: DiagnosticTransport = { send, flush };
  return { sink, send, flush };
}

describe('createRetainedTransport', () => {
  it('sends directly while online and stores nothing', async () => {
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0,
    });
    const timers = scheduler();
    const mode = { fail: false };
    const { sink, send } = sinkWith(mode);
    const transport = createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
      flushAtStartup: false,
    });
    await expect(transport.send(clean(1))).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(memory.calls).not.toContain('insert');
    expect(timers.delays).toEqual([DIAGNOSTIC_RETRY_DELAYS.drainMs]);
    await timers.fire();
    expect(send).toHaveBeenCalledTimes(1);
    expect(timers.queue).toEqual([]);
  });

  it('retains failed envelopes on disk, never rejects, and retries with capped backoff', async () => {
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0,
    });
    const timers = scheduler();
    const mode = { fail: true };
    const { sink, send } = sinkWith(mode);
    const transport = createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
      flushAtStartup: false,
    });
    await expect(transport.send(clean(1))).resolves.toEqual({});
    await expect(transport.send(clean(2))).resolves.toEqual({});
    expect(memory.sequences()).toEqual([1, 2]);
    expect(timers.delays).toEqual([DIAGNOSTIC_RETRY_DELAYS.initialMs]);
    expect(timers.queue).toHaveLength(1);

    const expected = [DIAGNOSTIC_RETRY_DELAYS.initialMs];
    let delay = DIAGNOSTIC_RETRY_DELAYS.initialMs;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await timers.fire();
      delay = Math.min(delay * 2, DIAGNOSTIC_RETRY_DELAYS.maxMs);
      expected.push(delay);
    }
    expect(timers.delays).toEqual(expected);
    expect(timers.delays[timers.delays.length - 1]).toBe(
      DIAGNOSTIC_RETRY_DELAYS.maxMs,
    );
    expect(memory.payloads().map(payload => JSON.parse(payload))).toEqual([
      clean(1),
      clean(2),
    ]);
    expect(send).toHaveBeenCalledTimes(2 + 12);

    mode.fail = false;
    await timers.fire();
    expect(send).toHaveBeenLastCalledWith(clean(1));
    expect(memory.sequences()).toHaveLength(1);
    expect(timers.delays[timers.delays.length - 1]).toBe(
      DIAGNOSTIC_RETRY_DELAYS.drainMs,
    );
    await timers.fire();
    expect(send).toHaveBeenLastCalledWith(clean(2));
    expect(memory.sequences()).toEqual([]);
    await timers.fire();
    expect(timers.queue).toEqual([]);
    expect(send).toHaveBeenCalledTimes(2 + 12 + 2);

    mode.fail = true;
    await expect(transport.send(clean(3))).resolves.toEqual({});
    expect(timers.delays[timers.delays.length - 1]).toBe(
      DIAGNOSTIC_RETRY_DELAYS.initialMs,
    );
  });

  it('drains envelopes left by a previous run shortly after startup', async () => {
    const memory = memoryStorage();
    const previous = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0,
    });
    await previous.push(envelope(1));
    const timers = scheduler();
    const { sink, send } = sinkWith({ fail: false });
    createRetainedTransport(sink, {
      store: createBoundedDiagnosticStore({
        storage: memory.storage,
        identity,
        now: () => T0 + 1,
      }),
      schedule: timers.schedule,
    });
    expect(timers.delays).toEqual([DIAGNOSTIC_RETRY_DELAYS.initialMs]);
    expect(send).not.toHaveBeenCalled();
    await timers.fire();
    expect(send).toHaveBeenCalledWith(clean(1));
    expect(memory.sequences()).toEqual([]);
  });

  it('flush drains the buffer and never propagates sink failures', async () => {
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0,
    });
    const timers = scheduler();
    const { sink, flush } = sinkWith({ fail: false });
    const transport = createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
      flushAtStartup: false,
    });
    await expect(transport.flush(250)).resolves.toBe(true);
    expect(flush).toHaveBeenCalledWith(250);
    expect(timers.delays).toEqual([DIAGNOSTIC_RETRY_DELAYS.drainMs]);
    const broken = createRetainedTransport(
      {
        send: async () => {
          throw new Error(marker);
        },
        flush: async () => {
          throw new Error(marker);
        },
      },
      {
        store,
        schedule: () => {
          throw new Error(marker);
        },
        flushAtStartup: true,
      },
    );
    await expect(broken.send(clean(1))).resolves.toEqual({});
    await expect(broken.flush()).resolves.toBe(false);
    expect(memory.payloads().map(payload => JSON.parse(payload))).toEqual([
      clean(1),
    ]);
  });
});

// ─── shipping wiring ─────────────────────────────────────────────────────────

describe('shipping wiring', () => {
  it('optionsForDiagnostics retains only scrubbed envelopes behind the scrub layer', async () => {
    const memory = memoryStorage();
    const timers = scheduler();
    const retention = createDiagnosticRetention(identity, {
      storage: memory.storage,
      schedule: timers.schedule,
      now: () => T0,
    });
    const mode = { fail: true };
    const { sink, send } = sinkWith(mode);
    const makeTransport: DiagnosticTransportFactory = jest.fn(() => sink);
    const options = optionsForDiagnostics(
      identity,
      null,
      makeTransport,
      { name: 'DebugMeta' },
      retention.retain,
    );
    expect(options).toMatchObject({ maxQueueSize: 8, maxCacheItems: 0 });
    const transport = options.transport!({
      url: '',
      recordDroppedEvent: () => {},
    });
    await expect(transport.send(envelope(1))).resolves.toEqual({});
    expect(send).toHaveBeenCalledTimes(1);
    expectNoMarker(send.mock.calls[0]);
    expect(memory.payloads()).toHaveLength(1);
    expectNoMarker(memory.payloads());
    expect(JSON.parse(memory.payloads()[0]!)).toEqual(clean(1));
    await expect(
      transport.send([
        {},
        [[{ type: 'attachment', filename: marker }, marker]],
      ] as unknown as DiagnosticEnvelope),
    ).resolves.toEqual({});
    expect(send).toHaveBeenCalledTimes(1);
    expect(memory.payloads()).toHaveLength(1);
    mode.fail = false;
    await timers.fire();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(clean(1));
    expect(memory.sequences()).toEqual([]);
    const unretained = optionsForDiagnostics(identity, null, makeTransport, {
      name: 'DebugMeta',
    }).transport!({ url: '', recordDroppedEvent: () => {} });
    mode.fail = true;
    await expect(unretained.send(envelope(2))).resolves.toEqual({});
    expect(memory.sequences()).toEqual([]);
  });

  it('opens the dedicated diagnostics database through op-sqlite openAsync', async () => {
    const sqlite = nodeSqlite();
    const openAsync = jest.fn(async (options: { name: string }) => {
      expect(options).toEqual({ name: DIAGNOSTIC_RETENTION_DATABASE });
      return sqlite.database;
    });
    await expect(
      openDiagnosticRetentionDatabase(async () => ({ openAsync })),
    ).resolves.toBe(sqlite.database);
    expect(openAsync).toHaveBeenCalledTimes(1);
  });

  it('runs the default SQLite-backed queue behind real timers with capped backoff', async () => {
    jest.useFakeTimers();
    const sqlite = nodeSqlite();
    const openAsync = jest.fn(async (options: { name: string }) => {
      expect(options).toEqual({ name: DIAGNOSTIC_RETENTION_DATABASE });
      return sqlite.database;
    });
    const retention = createDiagnosticRetention(identity, {
      loadSqlite: async () => ({ openAsync }),
    });
    const mode = { fail: true };
    const { sink, send } = sinkWith(mode);
    const transport = optionsForDiagnostics(
      identity,
      null,
      () => sink,
      { name: 'DebugMeta' },
      retention.retain,
    ).transport!({ url: '', recordDroppedEvent: () => {} });
    expect(openAsync).not.toHaveBeenCalled();
    await expect(transport.send(envelope(1))).resolves.toEqual({});
    expect(send).toHaveBeenCalledTimes(1);
    expect(openAsync).toHaveBeenCalledTimes(1);
    expect(sqlite.count()).toBe(1);
    expectNoMarker(sqlite.payloads());
    expect(JSON.parse(sqlite.payloads()[0]!)).toEqual(clean(1));

    await jest.advanceTimersByTimeAsync(DIAGNOSTIC_RETRY_DELAYS.initialMs - 1);
    expect(send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(sqlite.count()).toBe(1);
    await jest.advanceTimersByTimeAsync(DIAGNOSTIC_RETRY_DELAYS.initialMs * 2);
    await settle();
    expect(send).toHaveBeenCalledTimes(3);

    mode.fail = false;
    await jest.advanceTimersByTimeAsync(DIAGNOSTIC_RETRY_DELAYS.initialMs * 4);
    await settle();
    expect(send).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenLastCalledWith(clean(1));
    expect(sqlite.count()).toBe(0);
    await jest.advanceTimersByTimeAsync(DIAGNOSTIC_RETRY_DELAYS.maxMs);
    expect(send).toHaveBeenCalledTimes(4);
    expect(openAsync).toHaveBeenCalledTimes(1);
  });

  it('stays inert and never rejects when the SQLite module cannot be loaded', async () => {
    jest.useFakeTimers();
    const retention = createDiagnosticRetention(identity, {
      loadSqlite: async () => {
        throw new Error(marker);
      },
    });
    const mode = { fail: true };
    const { sink, send } = sinkWith(mode);
    const transport = retention.retain(sink);
    await expect(transport.send(clean(1))).resolves.toEqual({});
    await expect(transport.flush(10)).resolves.toBe(true);
    await jest.advanceTimersByTimeAsync(DIAGNOSTIC_RETRY_DELAYS.maxMs * 2);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    await expect(retention.store.shift()).resolves.toBeUndefined();
  });

  it('uses the op-sqlite module by default and degrades to inert when it is absent here', async () => {
    const retention = createDiagnosticRetention(identity, {
      schedule: () => undefined,
    });
    await expect(retention.store.push(clean(1))).resolves.toBeUndefined();
    await expect(retention.store.shift()).resolves.toBeUndefined();
  });
});
