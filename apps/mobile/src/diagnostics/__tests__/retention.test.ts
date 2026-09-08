/**
 * W10-02 — bounded offline diagnostic retention.
 *
 * The on-disk diagnostic buffer must have hard size and age caps with
 * deterministic oldest-first eviction, tolerate corrupt rows/schemas, never
 * block the caller, and never hold anything the scrub layer would not send.
 * A retained envelope must replay under the release identity that produced
 * it, and the ingest's own answers (429 + Retry-After, 5xx) are not
 * deliveries: the envelope stays durable and the drain waits out the window.
 * The store is exercised against an in-memory storage fake (policy) and a
 * REAL SQLite database (node:sqlite, Node 22.13+) driven through the same
 * `execute()` seam op-sqlite exposes on device; the transport is exercised
 * against the REAL Sentry fetch transport over a scripted ingest.
 */
import * as path from 'node:path';
import type { ErrorEvent } from '@sentry/react-native';
import type { makeFetchTransport as MakeFetchTransport } from '@sentry/browser';
import type {
  DiagnosticEnvelope,
  DiagnosticsIdentity,
  DiagnosticTransport,
  DiagnosticTransportFactory,
} from '../privacy';
import {
  classifyDiagnosticDelivery,
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
  retainedDiagnosticIdentity,
  type DiagnosticRetentionDatabase,
  type DiagnosticRetentionLimits,
  type DiagnosticRetentionStorage,
  type RetainedDiagnosticRecord,
} from '../retention';
import { scrubDiagnosticEnvelope } from '../scrub';
import { optionsForDiagnostics } from '../sentry';

/**
 * The jest preset resolves `@sentry/*` through the `react-native` export
 * condition, which points at ESM builds jest does not transform. The real
 * fetch transport (the one sentry.ts hands to `optionsForDiagnostics`) is
 * therefore loaded from the packages' CommonJS builds by absolute path.
 */
function mockSentryCjs<T extends object>(relative: string): T {
  return jest.requireActual<T>(
    path.resolve(__dirname, '../../../node_modules/@sentry', relative),
  );
}
jest.mock('@sentry/core', () => mockSentryCjs('core/build/cjs/index.js'));
jest.mock('@sentry/core/browser', () =>
  mockSentryCjs('core/build/cjs/browser.js'),
);
jest.mock('@sentry/browser-utils', () =>
  mockSentryCjs('browser-utils/build/cjs/index.js'),
);
const { makeFetchTransport } = mockSentryCjs<{
  makeFetchTransport: typeof MakeFetchTransport;
}>('browser/build/npm/cjs/prod/transports/fetch.js');

const identity: DiagnosticsIdentity = {
  bundleIdentifier: 'com.picklesensei',
  marketingVersion: '1.0',
  nativeBuildNumber: '1',
  sourceRevision: 'a'.repeat(40),
  environment: 'test',
  modelVersion: 'scoring-v1',
  policyVersion: 'policy-v1',
};
const updatedIdentity: DiagnosticsIdentity = {
  bundleIdentifier: 'com.picklesensei',
  marketingVersion: '1.1',
  nativeBuildNumber: '2',
  sourceRevision: 'b'.repeat(40),
  environment: 'test',
  modelVersion: 'scoring-v2',
  policyVersion: 'policy-v2',
};
const marker = 'SENSITIVE_FIXTURE_DO_NOT_TRANSMIT';
const INGEST = 'https://o1.ingest.sentry.io/api/1/envelope/';
const T0 = 1_757_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const { drainMs, initialMs, maxMs, rateLimitMs } = DIAGNOSTIC_RETRY_DELAYS;

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

function clean(
  index: number,
  under: DiagnosticsIdentity = identity,
): DiagnosticEnvelope {
  const scrubbed = scrubDiagnosticEnvelope(envelope(index), under);
  if (!scrubbed) throw new Error('fixture must scrub to an envelope');
  return scrubbed;
}

/** A replayed envelope: the scrubbed items under a fresh `sent_at` header. */
function replayed(index: number): DiagnosticEnvelope {
  const [header, items] = clean(index);
  return [
    { ...header, sent_at: expect.any(String) },
    items,
  ] as unknown as DiagnosticEnvelope;
}

function eventOf(sent: DiagnosticEnvelope): ErrorEvent {
  const items = sent[1] as unknown as [unknown, ErrorEvent][];
  return items[0]![1];
}

function sentAtOf(sent: DiagnosticEnvelope): number {
  return Date.parse((sent[0] as { sent_at: string }).sent_at);
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
    envelopes: (): unknown[] =>
      [...rows.values()]
        .sort((a, b) => a.sequence - b.sequence)
        .map(row => JSON.parse(row.payload)),
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
  sequences(): number[];
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
    sequences: () =>
      native
        .prepare(
          `SELECT sequence FROM ${DIAGNOSTIC_RETENTION_TABLE} ORDER BY sequence ASC`,
        )
        .all()
        .map(row => Number(row.sequence)),
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
      rateLimitMs: 60_000,
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
  const reset = { kept: [], evicted: [], nextSequence: 1, reset: true };

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
      nextSequence: 6,
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

  it('never reuses a sequence, even after the row that held it was evicted', () => {
    const plan = planDiagnosticRetention(
      [row(1, T0, 10), row(7, T0 - DAY_MS - 1, 10), row(3, T0, 10)],
      T0,
      limits,
    );
    expect(plan.kept.map(item => item.sequence)).toEqual([1, 3]);
    expect(plan.evicted).toEqual([7]);
    expect(plan.nextSequence).toBe(8);
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
      nextSequence: 1,
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
      expect(planDiagnosticRetention(rows, T0, limits)).toEqual(reset);
    }
    expect(planDiagnosticRetention(marker as never, T0, limits)).toEqual(reset);
    expect(
      planDiagnosticRetention([row(1, T0, 10)], Number.NaN, limits),
    ).toEqual(reset);
    const hostile = Object.defineProperty({}, 'sequence', {
      get() {
        throw new Error(marker);
      },
    });
    expect(planDiagnosticRetention([hostile], T0, limits).reset).toBe(true);
  });
});

// ─── producing identity ──────────────────────────────────────────────────────

describe('retainedDiagnosticIdentity', () => {
  it('reads the release identity back from the stamped event', () => {
    expect(retainedDiagnosticIdentity(clean(1))).toEqual(identity);
    expect(retainedDiagnosticIdentity(clean(1, updatedIdentity))).toEqual(
      updatedIdentity,
    );
  });

  it('refuses envelopes whose stamps are missing, inconsistent or foreign', () => {
    const stamped = clean(1);
    const event = eventOf(stamped);
    const withEvent = (patch: Partial<ErrorEvent>): unknown => [
      stamped[0],
      [[{ type: 'event' }, { ...event, ...patch }]],
    ];
    for (const value of [
      null,
      marker,
      [{}, []],
      [{}, [[{ type: 'attachment' }, marker]]],
      envelope(1),
      withEvent({ release: undefined }),
      withEvent({ release: 'com.picklesensei@1.0' }),
      withEvent({ release: 'com.example@1.0+1' }),
      withEvent({ dist: '2' }),
      withEvent({ environment: 'staging' }),
      withEvent({ tags: { ...event.tags, source_revision: marker } }),
      withEvent({ tags: { ...event.tags, model_version: undefined } }),
      withEvent({ tags: undefined }),
    ]) {
      expect(retainedDiagnosticIdentity(value)).toBeNull();
    }
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
    expect(memory.envelopes()).toEqual([clean(1), clean(2)]);
    expect(memory.rows.get(1)).toMatchObject({
      storedAt: T0,
      bytes: memory.rows.get(1)!.payload.length,
    });
    await expect(store.shift()).resolves.toEqual(clean(1));
    await expect(store.shift()).resolves.toEqual(clean(2));
    await expect(store.shift()).resolves.toBeUndefined();
    expect(memory.sequences()).toEqual([]);
  });

  it('replays a retained envelope under the identity that produced it, not the current one', async () => {
    const memory = memoryStorage();
    await createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0,
    }).push(envelope(1));

    // App update between capture and replay: same storage, new identity.
    const updated = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity: updatedIdentity,
      now: () => T0 + 60_000,
    });
    await updated.push(envelope(2));
    const first = await updated.shift();
    const second = await updated.shift();
    expect(first).toEqual(clean(1));
    expect(eventOf(first!)).toMatchObject({
      release: 'com.picklesensei@1.0+1',
      dist: '1',
      tags: expect.objectContaining({
        source_revision: 'a'.repeat(40),
        model_version: 'scoring-v1',
        policy_version: 'policy-v1',
      }),
    });
    expect(second).toEqual(clean(2, updatedIdentity));
    expect(eventOf(second!)).toMatchObject({
      release: 'com.picklesensei@1.1+2',
      dist: '2',
    });
  });

  it('drops retained rows whose producing identity cannot be established', async () => {
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0,
    });
    await store.push(envelope(1));
    const stamped = eventOf(clean(2));
    for (const [sequence, payload] of [
      [2, JSON.stringify(envelope(2))],
      [
        3,
        JSON.stringify([
          clean(2)[0],
          [[{ type: 'event' }, { ...stamped, release: undefined }]],
        ]),
      ],
      [
        4,
        JSON.stringify([
          clean(2)[0],
          [[{ type: 'event' }, { ...stamped, dist: '9' }]],
        ]),
      ],
    ] as const) {
      memory.rows.set(sequence, {
        sequence,
        storedAt: T0,
        bytes: payload.length,
        payload,
      });
    }
    await expect(store.shift()).resolves.toEqual(clean(1));
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
    for (const value of rejected) await store.push(value as DiagnosticEnvelope);
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

  it('expires envelopes past the age cap in either clock direction', async () => {
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
    now = T0 - DIAGNOSTIC_RETENTION_LIMITS.maxAgeMs - 1;
    await expect(store.peek()).resolves.toBeUndefined();
    expect(memory.sequences()).toEqual([]);
  });

  it('peeks without removing, skips claimed sequences and removes by sequence', async () => {
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0,
    });
    await store.push(envelope(1));
    await store.push(envelope(2));
    await expect(store.peek()).resolves.toEqual({
      sequence: 1,
      envelope: clean(1),
    });
    expect(memory.sequences()).toEqual([1, 2]);
    await expect(store.peek(new Set([1]))).resolves.toEqual({
      sequence: 2,
      envelope: clean(2),
    });
    await expect(store.peek(new Set([1, 2]))).resolves.toBeUndefined();
    await store.remove(2);
    await store.remove(99);
    await store.remove(Number.NaN);
    expect(memory.sequences()).toEqual([1]);
    await expect(store.shift()).resolves.toEqual(clean(1));
    await store.push(envelope(3));
    expect(memory.sequences()).toEqual([3]);
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
    expect(memory.envelopes()).toEqual([
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
    await expect(store.peek()).resolves.toBeUndefined();
    await expect(store.remove(1)).resolves.toBeUndefined();
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
    await expect(throwing.push(envelope(1))).resolves.toBeUndefined();
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
    const unidentified = createBoundedDiagnosticStore({
      storage: memoryStorage().storage,
      identity: { ...identity, sourceRevision: marker },
      now: () => T0,
    });
    await expect(unidentified.push(envelope(1))).resolves.toBeUndefined();
    await expect(unidentified.shift()).resolves.toBeUndefined();
  });

  it('ignores non-finite clocks and evicts deterministically on a clock rollback', async () => {
    let now: number = T0;
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => now,
    });
    await store.push(envelope(1));
    now = Number.NaN;
    await expect(store.push(envelope(2))).resolves.toBeUndefined();
    await expect(store.shift()).resolves.toBeUndefined();
    expect(memory.envelopes()).toEqual([clean(1)]);
    now = Number.POSITIVE_INFINITY;
    await expect(store.shift()).resolves.toBeUndefined();
    expect(memory.envelopes()).toEqual([clean(1)]);
    now = -1;
    await expect(store.shift()).resolves.toBeUndefined();
    expect(memory.envelopes()).toEqual([]);
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
    insert.run(8, T0, 5, JSON.stringify(clean(8, updatedIdentity)));
    expect(sqlite.count()).toBe(11);
    await expect(store.shift()).resolves.toEqual(clean(1));
    await expect(store.shift()).resolves.toEqual(clean(8, updatedIdentity));
    await expect(store.shift()).resolves.toBeUndefined();
    expect(sqlite.count()).toBe(0);
  });

  it('measures the byte cap against the payload on disk and never reuses a sequence', async () => {
    const sqlite = nodeSqlite();
    const store = createBoundedDiagnosticStore({
      storage: createSqliteRetentionStorage(async () => sqlite.database),
      identity,
      now: () => T0,
    });
    await store.push(envelope(1));
    sqlite.native
      .prepare(
        `INSERT INTO ${DIAGNOSTIC_RETENTION_TABLE} (sequence, stored_at, bytes, payload) VALUES (?, ?, ?, ?)`,
      )
      .run(2, T0, 1, 'x'.repeat(DIAGNOSTIC_RETENTION_LIMITS.maxTotalBytes + 1));
    await store.push(envelope(3));
    await store.prune();
    expect(sqlite.sequences()).toEqual([1, 3]);
    const onDisk = Number(
      sqlite.native
        .prepare(
          `SELECT sum(length(CAST(payload AS BLOB))) AS n FROM ${DIAGNOSTIC_RETENTION_TABLE}`,
        )
        .all()[0]?.n,
    );
    expect(onDisk).toBeLessThanOrEqual(
      DIAGNOSTIC_RETENTION_LIMITS.maxTotalBytes,
    );
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

// ─── delivery classification ─────────────────────────────────────────────────

describe('classifyDiagnosticDelivery', () => {
  const headers = (patch: Record<string, string | null>) => ({
    'x-sentry-rate-limits': null,
    'retry-after': null,
    ...patch,
  });

  it('accepts only 2xx answers and carries any rate limit they announce', () => {
    expect(classifyDiagnosticDelivery({ statusCode: 200 }, T0)).toEqual({
      kind: 'accepted',
      retryAfterMs: null,
    });
    expect(
      classifyDiagnosticDelivery(
        {
          statusCode: 200,
          headers: headers({
            'x-sentry-rate-limits': '30:transaction:org, 45:error;default:org',
          }),
        },
        T0,
      ),
    ).toEqual({ kind: 'accepted', retryAfterMs: 45_000 });
    expect(
      classifyDiagnosticDelivery(
        {
          statusCode: 200,
          headers: headers({ 'x-sentry-rate-limits': '30:transaction:org' }),
        },
        T0,
      ),
    ).toEqual({ kind: 'accepted', retryAfterMs: null });
  });

  it('treats 429 as an answered retry with the requested or default window', () => {
    expect(
      classifyDiagnosticDelivery(
        { statusCode: 429, headers: headers({ 'retry-after': '60' }) },
        T0,
      ),
    ).toEqual({ kind: 'retry', retryAfterMs: 60_000, answered: true });
    expect(
      classifyDiagnosticDelivery(
        {
          statusCode: 429,
          headers: headers({
            'retry-after': new Date(T0 + 90_000).toUTCString(),
          }),
        },
        T0,
      ),
    ).toEqual({ kind: 'retry', retryAfterMs: 90_000, answered: true });
    expect(
      classifyDiagnosticDelivery(
        { statusCode: 429, headers: headers({ 'x-sentry-rate-limits': '7' }) },
        T0,
      ),
    ).toEqual({ kind: 'retry', retryAfterMs: 7_000, answered: true });
    expect(
      classifyDiagnosticDelivery(
        { statusCode: 429, headers: headers({ 'retry-after': marker }) },
        T0,
      ),
    ).toEqual({ kind: 'retry', retryAfterMs: rateLimitMs, answered: true });
    expect(classifyDiagnosticDelivery({ statusCode: 429 }, T0)).toEqual({
      kind: 'retry',
      retryAfterMs: rateLimitMs,
      answered: true,
    });
  });

  it('retries 408/5xx as answered, statusless results as unanswered, and refuses other 4xx', () => {
    for (const statusCode of [408, 500, 502, 503, 599]) {
      expect(classifyDiagnosticDelivery({ statusCode }, T0)).toEqual({
        kind: 'retry',
        retryAfterMs: null,
        answered: true,
      });
    }
    for (const statusCode of [400, 401, 403, 404, 413]) {
      expect(classifyDiagnosticDelivery({ statusCode }, T0)).toEqual({
        kind: 'rejected',
      });
    }
    for (const result of [{}, undefined, null, marker, { statusCode: 'ok' }]) {
      expect(classifyDiagnosticDelivery(result, T0)).toEqual({
        kind: 'retry',
        retryAfterMs: null,
        answered: false,
      });
    }
    const hostile = Object.defineProperty({}, 'statusCode', {
      get() {
        throw new Error(marker);
      },
    });
    expect(classifyDiagnosticDelivery(hostile, T0)).toEqual({
      kind: 'retry',
      retryAfterMs: null,
      answered: false,
    });
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
    async fireAll(limit = 64): Promise<number> {
      let fired = 0;
      while (queue.length > 0 && fired < limit) {
        await this.fire();
        fired += 1;
      }
      return fired;
    },
  };
}

function fakeSink(
  respond: (envelope: DiagnosticEnvelope, call: number) => Promise<unknown>,
) {
  const sent: DiagnosticEnvelope[] = [];
  const send = jest.fn(async (envelope: DiagnosticEnvelope) => {
    sent.push(envelope);
    return respond(envelope, sent.length);
  });
  const flush = jest.fn(async () => true);
  const sink: DiagnosticTransport = {
    send: send as unknown as DiagnosticTransport['send'],
    flush,
  };
  return { sink, sent, send, flush };
}

function sinkWith(mode: { fail: boolean }) {
  return fakeSink(async () => {
    if (mode.fail) throw new Error(marker);
    return { statusCode: 200 };
  });
}

/**
 * The real Sentry fetch transport over a scripted ingest. `makeRequest`
 * only reads `response.status` and `response.headers.get`.
 */
function ingest(
  script: (call: number) => { status: number; retryAfter?: string },
) {
  const bodies: string[] = [];
  const dropped: [string, string][] = [];
  const fetchImpl = async (
    _url: string,
    init: { body: string },
  ): Promise<{
    status: number;
    headers: { get(name: string): string | null };
  }> => {
    bodies.push(init.body);
    const { status, retryAfter } = script(bodies.length);
    return {
      status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'retry-after' && retryAfter !== undefined
            ? retryAfter
            : null,
      },
    };
  };
  const sink = makeFetchTransport(
    {
      url: INGEST,
      recordDroppedEvent: (reason, category) =>
        dropped.push([reason, category]),
    },
    fetchImpl as unknown as typeof fetch,
  );
  return { sink, bodies, dropped };
}

async function seeded(count: number) {
  const memory = memoryStorage();
  const store = createBoundedDiagnosticStore({
    storage: memory.storage,
    identity,
    now: () => T0,
  });
  for (let index = 1; index <= count; index += 1)
    await store.push(envelope(index));
  expect(memory.sequences()).toHaveLength(count);
  return { memory, store };
}

describe('createRetainedTransport', () => {
  it('sends directly while online and stores nothing', async () => {
    const { memory, store } = await seeded(0);
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
    expect(send).toHaveBeenLastCalledWith(clean(1));
    expect(memory.calls).not.toContain('insert');
    expect(timers.delays).toEqual([drainMs]);
    await timers.fire();
    expect(send).toHaveBeenCalledTimes(1);
    expect(timers.queue).toEqual([]);
  });

  it('retains network failures on disk, never rejects, and retries with capped backoff', async () => {
    const { memory, store } = await seeded(0);
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
    expect(timers.delays).toEqual([initialMs]);
    expect(timers.queue).toHaveLength(1);

    const expected = [initialMs];
    let delay = initialMs;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await timers.fire();
      delay = Math.min(delay * 2, maxMs);
      expected.push(delay);
    }
    expect(timers.delays).toEqual(expected);
    expect(timers.delays[timers.delays.length - 1]).toBe(maxMs);
    expect(memory.envelopes()).toEqual([clean(1), clean(2)]);
    expect(send).toHaveBeenCalledTimes(2 + 12);

    mode.fail = false;
    await timers.fire();
    expect(send).toHaveBeenLastCalledWith(replayed(1));
    expect(memory.sequences()).toEqual([2]);
    expect(timers.delays[timers.delays.length - 1]).toBe(drainMs);
    await timers.fire();
    expect(send).toHaveBeenLastCalledWith(replayed(2));
    expect(memory.sequences()).toEqual([]);
    await timers.fire();
    expect(timers.queue).toEqual([]);
    expect(send).toHaveBeenCalledTimes(2 + 12 + 2);

    mode.fail = true;
    await expect(transport.send(clean(3))).resolves.toEqual({});
    expect(timers.delays[timers.delays.length - 1]).toBe(initialMs);
  });

  it('holds the buffer while the real fetch transport is answered 429 + Retry-After', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const { memory, store } = await seeded(3);
    const { sink, bodies, dropped } = ingest(call =>
      call === 1 ? { status: 429, retryAfter: '60' } : { status: 200 },
    );
    createRetainedTransport(sink, { store });

    await jest.advanceTimersByTimeAsync(initialMs);
    expect({
      requests: bodies.length,
      dropped,
      retained: memory.envelopes(),
    }).toEqual({
      requests: 1,
      dropped: [],
      retained: [1, 2, 3].map(index => clean(index)),
    });

    // Nothing probes the ingest before Retry-After elapses...
    await jest.advanceTimersByTimeAsync(60_000 - 1);
    expect(bodies).toHaveLength(1);
    expect(memory.sequences()).toEqual([1, 2, 3]);

    // ...and the whole buffer goes out once it has.
    await jest.advanceTimersByTimeAsync(1 + 3 * drainMs);
    expect({
      requests: bodies.length,
      dropped,
      retained: memory.sequences(),
    }).toEqual({ requests: 4, dropped: [], retained: [] });
    for (const body of bodies) expect(body).not.toContain(marker);
  });

  it('keeps retained envelopes while the ingest answers 503 and probes once per backoff window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const { memory, store } = await seeded(3);
    const status = { code: 503 };
    const { sink, bodies } = ingest(() => ({ status: status.code }));
    createRetainedTransport(sink, { store });

    await jest.advanceTimersByTimeAsync(initialMs);
    expect(bodies).toHaveLength(1);
    expect(memory.envelopes()).toEqual([1, 2, 3].map(index => clean(index)));

    let window = initialMs;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await jest.advanceTimersByTimeAsync(window - 1);
      expect(bodies).toHaveLength(2 + attempt - 1);
      await jest.advanceTimersByTimeAsync(1);
      expect(bodies).toHaveLength(2 + attempt);
      expect(memory.sequences()).toEqual([1, 2, 3]);
      window *= 2;
    }

    status.code = 200;
    await jest.advanceTimersByTimeAsync(window + 3 * drainMs);
    expect(bodies).toHaveLength(5 + 3);
    expect(memory.sequences()).toEqual([]);
  });

  it('stores an online envelope the ingest refused with 503 and replays it later', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const { memory, store } = await seeded(0);
    const status = { code: 503 };
    const { sink, bodies } = ingest(() => ({ status: status.code }));
    const transport = createRetainedTransport(sink, {
      store,
      flushAtStartup: false,
    });

    await expect(transport.send(clean(1))).resolves.toMatchObject({
      statusCode: 503,
    });
    expect(bodies).toHaveLength(1);
    expect(memory.envelopes()).toEqual([clean(1)]);

    status.code = 200;
    await jest.advanceTimersByTimeAsync(initialMs - 1);
    expect(bodies).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(bodies).toHaveLength(2);
    expect(memory.sequences()).toEqual([]);
    expect(JSON.parse(bodies[1]!.split('\n')[2]!)).toEqual(eventOf(clean(1)));
  });

  it('does not retain envelopes the ingest refuses for good (other 4xx)', async () => {
    const { memory, store } = await seeded(0);
    const timers = scheduler();
    const { sink, send } = fakeSink(async () => ({ statusCode: 400 }));
    const transport = createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
      flushAtStartup: false,
    });
    await expect(transport.send(clean(1))).resolves.toEqual({
      statusCode: 400,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(memory.calls).not.toContain('insert');
    expect(timers.delays).toEqual([drainMs]);
  });

  it('drops a retained envelope the ingest refuses for good instead of retrying it forever', async () => {
    const { memory, store } = await seeded(2);
    const timers = scheduler();
    const { sink, send } = fakeSink(async (_envelope, call) => ({
      statusCode: call === 1 ? 413 : 200,
    }));
    createRetainedTransport(sink, { store, schedule: timers.schedule });
    await timers.fireAll();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, replayed(1));
    expect(send).toHaveBeenNthCalledWith(2, replayed(2));
    expect(memory.sequences()).toEqual([]);
  });

  it('pauses the drain for a rate limit announced on an accepted answer', async () => {
    let clock = T0;
    const { memory, store } = await seeded(2);
    const timers = scheduler();
    const { sink, send } = fakeSink(async (_envelope, call) => ({
      statusCode: 200,
      headers: {
        'x-sentry-rate-limits': call === 1 ? '30:error:organization' : null,
        'retry-after': null,
      },
    }));
    createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
      now: () => clock,
    });
    await timers.fire();
    expect(send).toHaveBeenCalledTimes(1);
    expect(memory.sequences()).toEqual([2]);
    expect(timers.delays).toEqual([initialMs, 30_000]);
    clock += 29_999;
    await timers.fire();
    expect(send).toHaveBeenCalledTimes(1);
    expect(timers.delays[timers.delays.length - 1]).toBe(1);
    clock += 1;
    await timers.fire();
    expect(send).toHaveBeenCalledTimes(2);
    expect(memory.sequences()).toEqual([]);
  });

  it('honours Retry-After on the online path and clears a backoff once the ingest accepts again', async () => {
    let clock = T0;
    const { memory, store } = await seeded(0);
    const timers = scheduler();
    const answers: unknown[] = [
      { statusCode: 429, headers: { 'retry-after': '10' } },
      { statusCode: 200 },
    ];
    const { sink, send } = fakeSink(
      async () => answers.shift() ?? { statusCode: 200 },
    );
    const transport = createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
      flushAtStartup: false,
      now: () => clock,
    });
    await expect(transport.send(clean(1))).resolves.toEqual({
      statusCode: 429,
      headers: { 'retry-after': '10' },
    });
    expect(memory.envelopes()).toEqual([clean(1)]);
    expect(timers.delays).toEqual([10_000]);
    // An accepted online send proves the ingest reachable again; the drain
    // runs shortly afterwards instead of waiting out a stale backoff.
    clock += 10_000;
    await expect(transport.send(clean(2))).resolves.toEqual({
      statusCode: 200,
    });
    expect(timers.queue).toHaveLength(1);
    expect(timers.delays[timers.delays.length - 1]).toBe(drainMs);
    await timers.fire();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith(replayed(1));
    expect(memory.sequences()).toEqual([]);
  });

  it('keeps the in-flight envelope on disk until the ingest acknowledges it', async () => {
    const { memory, store } = await seeded(2);
    let hung = false;
    const { sink, send } = fakeSink(() => {
      if (!hung) {
        hung = true;
        return new Promise<never>(() => undefined);
      }
      return Promise.resolve({ statusCode: 200 });
    });
    const timers = scheduler();
    createRetainedTransport(sink, { store, schedule: timers.schedule });
    await timers.fire();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(replayed(1));
    expect(memory.sequences()).toEqual([1, 2]);
    expect(memory.envelopes()).toEqual([clean(1), clean(2)]);

    // Simulated restart over the same storage: both envelopes still go out.
    const restarted = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0 + 1_000,
    });
    const { sink: onlineSink, sent } = fakeSink(async () => ({
      statusCode: 200,
    }));
    const restartTimers = scheduler();
    createRetainedTransport(onlineSink, {
      store: restarted,
      schedule: restartTimers.schedule,
    });
    await restartTimers.fireAll();
    expect(sent).toEqual([replayed(1), replayed(2)]);
    expect(memory.sequences()).toEqual([]);
  });

  it('keeps delivering later envelopes after one request hangs', async () => {
    const { memory, store } = await seeded(2);
    let hung = false;
    const { sink, send } = fakeSink(() => {
      if (!hung) {
        hung = true;
        return new Promise<never>(() => undefined);
      }
      return Promise.resolve({ statusCode: 200 });
    });
    const timers = scheduler();
    const transport = createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
    });
    await timers.fire();
    expect(send).toHaveBeenCalledTimes(1);

    await expect(transport.flush(1_000)).resolves.toBe(true);
    await timers.fireAll();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(replayed(2));
    expect(memory.sequences()).toEqual([1]);
  });

  it('serialises a burst of online failures racing the retry drain', async () => {
    const { memory, store } = await seeded(0);
    const mode = { fail: true };
    const { sink, sent } = sinkWith(mode);
    const timers = scheduler();
    const transport = createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
      flushAtStartup: false,
    });
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        transport.send(clean(index + 1)),
      ),
    );
    expect(memory.sequences()).toHaveLength(
      DIAGNOSTIC_RETENTION_LIMITS.maxEnvelopes,
    );
    expect(memory.envelopes()[0]).toEqual(clean(9));
    expect(timers.queue).toHaveLength(1);

    mode.fail = false;
    expect(await timers.fireAll(128)).toBeGreaterThan(0);
    expect(sent.slice(40)).toEqual(
      Array.from({ length: 32 }, (_, index) => replayed(index + 9)),
    );
    expect(memory.sequences()).toEqual([]);
  });

  it('stamps sent_at with the send time when replaying and preserves the event', async () => {
    const { store } = await seeded(1);
    const { sink, sent } = fakeSink(async () => ({ statusCode: 200 }));
    const timers = scheduler();
    createRetainedTransport(sink, { store, schedule: timers.schedule });
    const before = Date.now();
    await timers.fire();
    expect(sent).toHaveLength(1);
    const sentAt = sentAtOf(sent[0]!);
    expect(sentAt).toBeGreaterThanOrEqual(before);
    expect(sentAt).toBeLessThanOrEqual(Date.now());
    expect(sent[0]![1]).toEqual(clean(1)[1]);
    expect(eventOf(sent[0]!).timestamp).toBe(1_757_000_001);
  });

  it('drains envelopes left by a previous run shortly after startup', async () => {
    const { memory } = await seeded(1);
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
    expect(timers.delays).toEqual([initialMs]);
    expect(send).not.toHaveBeenCalled();
    await timers.fire();
    expect(send).toHaveBeenCalledWith(replayed(1));
    expect(memory.sequences()).toEqual([]);
  });

  it('flush(timeout) delivers retained envelopes before it resolves and releases its budget', async () => {
    const { memory, store } = await seeded(2);
    const { sink, sent, flush } = fakeSink(async () => ({ statusCode: 200 }));
    const timers = scheduler();
    const transport = createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
      flushAtStartup: false,
    });
    await expect(transport.flush(1_000)).resolves.toBe(true);
    expect(flush).toHaveBeenCalledWith(1_000);
    expect({
      delivered: sent,
      retained: memory.sequences(),
      pendingTimers: timers.queue.length,
    }).toEqual({
      delivered: [replayed(1), replayed(2)],
      retained: [],
      pendingTimers: 0,
    });
  });

  it('flush(timeout) resolves when its budget expires on a hung request and keeps the envelope', async () => {
    const { memory, store } = await seeded(1);
    const { sink, send } = fakeSink(() => new Promise<never>(() => undefined));
    const timers = scheduler();
    const transport = createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
      flushAtStartup: false,
    });
    const flushing = transport.flush(250);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(timers.delays).toEqual([250]);
    await timers.fire();
    await expect(flushing).resolves.toBe(true);
    expect(memory.sequences()).toEqual([1]);
  });

  it('flush never propagates sink or scheduler failures', async () => {
    const { memory, store } = await seeded(0);
    const timers = scheduler();
    const { sink, flush } = sinkWith({ fail: false });
    const transport = createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
      flushAtStartup: false,
    });
    await expect(transport.flush(250)).resolves.toBe(true);
    expect(flush).toHaveBeenCalledWith(250);
    expect(timers.queue).toEqual([]);
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
    expect(memory.envelopes()).toEqual([clean(1)]);
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
    expect(memory.envelopes()).toEqual([clean(1)]);
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
    expect(send).toHaveBeenLastCalledWith(replayed(1));
    expect(sentAtOf(send.mock.calls[1]![0])).toBe(T0);
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

    await jest.advanceTimersByTimeAsync(initialMs - 1);
    expect(send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(sqlite.count()).toBe(1);
    await jest.advanceTimersByTimeAsync(initialMs * 2);
    await settle();
    expect(send).toHaveBeenCalledTimes(3);

    mode.fail = false;
    await jest.advanceTimersByTimeAsync(initialMs * 4);
    await settle();
    expect(send).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenLastCalledWith(replayed(1));
    expect(sqlite.count()).toBe(0);
    await jest.advanceTimersByTimeAsync(maxMs);
    expect(send).toHaveBeenCalledTimes(4);
    expect(openAsync).toHaveBeenCalledTimes(1);
  });

  it('replays through the shipping wiring under the identity that produced the event', async () => {
    const sqlite = nodeSqlite();
    const loadSqlite = async () => ({
      openAsync: async () => sqlite.database,
    });
    const previous = createDiagnosticRetention(identity, {
      loadSqlite,
      schedule: () => undefined,
      now: () => T0,
    });
    const offline = optionsForDiagnostics(
      identity,
      null,
      () => sinkWith({ fail: true }).sink,
      { name: 'DebugMeta' },
      previous.retain,
    ).transport!({ url: '', recordDroppedEvent: () => {} });
    await offline.send(envelope(1));
    expect(sqlite.count()).toBe(1);

    const timers = scheduler();
    const updated = createDiagnosticRetention(updatedIdentity, {
      loadSqlite,
      schedule: timers.schedule,
      now: () => T0 + DAY_MS,
    });
    const { sink, sent } = sinkWith({ fail: false });
    optionsForDiagnostics(
      updatedIdentity,
      null,
      () => sink,
      { name: 'DebugMeta' },
      updated.retain,
    ).transport!({ url: '', recordDroppedEvent: () => {} });
    expect(timers.delays).toEqual([initialMs]);
    await timers.fire();
    expect(sent).toEqual([replayed(1)]);
    expect(eventOf(sent[0]!)).toMatchObject({
      release: 'com.picklesensei@1.0+1',
      dist: '1',
      tags: expect.objectContaining({
        source_revision: 'a'.repeat(40),
        model_version: 'scoring-v1',
        policy_version: 'policy-v1',
      }),
    });
    expect(sentAtOf(sent[0]!)).toBe(T0 + DAY_MS);
    expect(sqlite.count()).toBe(0);
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
    await jest.advanceTimersByTimeAsync(maxMs * 2);
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
