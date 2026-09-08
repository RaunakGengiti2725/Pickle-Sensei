/**
 * W10-02 adversarial probes against the bounded offline diagnostic retention
 * candidate. Every test encodes the behaviour the objective requires at a
 * failure boundary (ingest rate limits / outages, app updates between store
 * and drain, process death or a hung request mid-drain, corrupt on-disk
 * metadata, flush semantics, replay headers). A failing test is a confirmed
 * break; a passing test is an attack the candidate survived.
 */
import * as path from 'node:path';
import type { ErrorEvent } from '@sentry/react-native';
import type { makeFetchTransport as MakeFetchTransport } from '@sentry/browser';
import type {
  DiagnosticEnvelope,
  DiagnosticsIdentity,
  DiagnosticTransport,
} from '../privacy';
import {
  createBoundedDiagnosticStore,
  createRetainedTransport,
  createSqliteRetentionStorage,
  DIAGNOSTIC_RETENTION_LIMITS,
  DIAGNOSTIC_RETENTION_TABLE,
  type DiagnosticRetentionDatabase,
  type DiagnosticRetentionStorage,
  type RetainedDiagnosticRecord,
} from '../retention';
import { scrubDiagnosticEnvelope } from '../scrub';

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
  ...identity,
  marketingVersion: '1.1',
  nativeBuildNumber: '2',
  sourceRevision: 'b'.repeat(40),
  modelVersion: 'scoring-v2',
  policyVersion: 'policy-v2',
};
const marker = 'SENSITIVE_FIXTURE_DO_NOT_TRANSMIT';
const T0 = 1_757_000_000_000;
const INGEST = 'https://o1.ingest.sentry.io/api/1/envelope/';

function dirtyEvent(index: number): ErrorEvent {
  return {
    type: undefined,
    platform: 'javascript',
    level: 'error',
    event_id: index.toString(16).padStart(32, '0'),
    timestamp: 1_757_000_000 + index,
    message: marker,
    tags: { diagnostic_origin: 'handled_js' },
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
    [[{ type: 'event' }, dirtyEvent(index)]],
  ] as unknown as DiagnosticEnvelope;
}

function clean(
  index: number,
  scrubIdentity: DiagnosticsIdentity = identity,
): DiagnosticEnvelope {
  const scrubbed = scrubDiagnosticEnvelope(envelope(index), scrubIdentity);
  if (!scrubbed) throw new Error('fixture must scrub to an envelope');
  return scrubbed;
}

function eventOf(sent: DiagnosticEnvelope): ErrorEvent {
  const item = (sent as unknown as [unknown, [unknown, ErrorEvent][]])[1][0];
  if (!item) throw new Error('envelope must carry one event item');
  return item[1];
}

// ─── fakes ───────────────────────────────────────────────────────────────────

function memoryStorage() {
  const rows = new Map<number, RetainedDiagnosticRecord>();
  const storage: DiagnosticRetentionStorage = {
    async list() {
      return [...rows.values()]
        .sort((a, b) => a.sequence - b.sequence)
        .map(({ sequence, storedAt, bytes }) => ({
          sequence,
          storedAt,
          bytes,
        }));
    },
    async read(sequence) {
      return rows.get(sequence)?.payload;
    },
    async insert(record) {
      if (rows.has(record.sequence)) throw new Error('duplicate sequence');
      rows.set(record.sequence, { ...record });
    },
    async remove(sequences) {
      for (const sequence of sequences) rows.delete(sequence);
    },
    async reset() {
      rows.clear();
    },
  };
  return {
    storage,
    rows,
    sequences: () => [...rows.keys()].sort((a, b) => a - b),
    envelopes: () =>
      [...rows.values()]
        .sort((a, b) => a.sequence - b.sequence)
        .map(row => JSON.parse(row.payload) as DiagnosticEnvelope),
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

function nodeSqlite() {
  const { DatabaseSync } = jest.requireActual<{
    DatabaseSync: new (path: string) => NodeSqliteDatabase;
  }>('node:sqlite');
  const native = new DatabaseSync(':memory:');
  openDatabases.push(native);
  const database: DiagnosticRetentionDatabase = {
    async execute(sql, params = []) {
      const statement = native.prepare(sql);
      return statement.columns().length > 0
        ? { rows: statement.all(...params) }
        : (statement.run(...params), { rows: [] });
    },
  };
  return {
    native,
    database,
    rows: () =>
      native
        .prepare(
          `SELECT sequence, bytes, length(payload) AS actual FROM ${DIAGNOSTIC_RETENTION_TABLE} ORDER BY sequence ASC`,
        )
        .all()
        .map(row => ({
          sequence: Number(row.sequence),
          bytes: Number(row.bytes),
          actual: Number(row.actual),
        })),
  };
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

type Scheduled = { callback: () => void; delayMs: number };

function scheduler() {
  const queue: Scheduled[] = [];
  const delays: number[] = [];
  return {
    queue,
    delays,
    schedule: (callback: () => void, delayMs: number) => {
      const entry = { callback, delayMs };
      queue.push(entry);
      delays.push(delayMs);
      return () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
      };
    },
    async fire(): Promise<void> {
      const entry = queue.shift();
      if (!entry) throw new Error('nothing scheduled');
      entry.callback();
      await settle();
    },
    /** Fires every pending timer until the transport stops re-arming. */
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

/**
 * The real Sentry fetch transport (the one sentry.ts passes to
 * `optionsForDiagnostics`) over a scripted ingest. `makeRequest` only reads
 * `response.status` and `response.headers.get`, so a minimal shape suffices.
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

function fakeSink(send: (envelope: DiagnosticEnvelope) => Promise<unknown>) {
  const sent: DiagnosticEnvelope[] = [];
  const sendMock = jest.fn(async (envelope: DiagnosticEnvelope) => {
    sent.push(envelope);
    return send(envelope);
  });
  const flush = jest.fn(async () => true);
  const sink: DiagnosticTransport = {
    send: sendMock as unknown as DiagnosticTransport['send'],
    flush,
  };
  return { sink, sent, send: sendMock, flush };
}

async function seeded(count: number, storeIdentity = identity) {
  const memory = memoryStorage();
  const store = createBoundedDiagnosticStore({
    storage: memory.storage,
    identity: storeIdentity,
    now: () => T0,
  });
  for (let index = 1; index <= count; index += 1)
    await store.push(envelope(index));
  expect(memory.sequences()).toHaveLength(count);
  return { memory, store };
}

// ─── A1/A2: ingest answers that are not deliveries ───────────────────────────

describe('attack: ingest responses that are not deliveries', () => {
  it('A1 holds the retained buffer while the ingest answers 429 + Retry-After', async () => {
    const { memory, store } = await seeded(3);
    const { sink, bodies, dropped } = ingest(() => ({
      status: 429,
      retryAfter: '60',
    }));
    const timers = scheduler();
    createRetainedTransport(sink, { store, schedule: timers.schedule });
    expect(timers.delays).toEqual([5_000]);

    await timers.fireAll();

    // A 429 is an explicit "not accepted, come back after Retry-After". Nothing
    // may leave the buffer until the ingest has accepted it, and the drain
    // must not keep feeding a transport that is now dropping locally.
    expect({
      requests: bodies.length,
      dropped,
      retained: memory.envelopes().length,
    }).toEqual({ requests: 1, dropped: [], retained: 3 });
    expect(memory.envelopes()).toEqual([clean(1), clean(2), clean(3)]);
  });

  it('A2a keeps retained envelopes when the ingest answers 503 during the drain', async () => {
    const { memory, store } = await seeded(3);
    const { sink, bodies } = ingest(() => ({ status: 503 }));
    const timers = scheduler();
    createRetainedTransport(sink, { store, schedule: timers.schedule });

    await timers.fireAll();

    // An ingest outage must not empty the offline buffer: a 5xx response is a
    // failed delivery and the envelope has to stay durable for a later retry.
    expect({
      requests: bodies.length,
      retained: memory.envelopes().length,
    }).toEqual({ requests: 1, retained: 3 });
    expect(memory.envelopes()).toEqual([clean(1), clean(2), clean(3)]);
  });

  it('A2b stores an envelope the ingest refused with 503 on the online path', async () => {
    const { memory, store } = await seeded(0);
    const { sink, bodies } = ingest(() => ({ status: 503 }));
    const timers = scheduler();
    const transport = createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
      flushAtStartup: false,
    });

    await transport.send(clean(1));

    expect({
      requests: bodies.length,
      retained: memory.envelopes().length,
    }).toEqual({ requests: 1, retained: 1 });
    expect(memory.envelopes()).toEqual([clean(1)]);
  });
});

// ─── A3: app update between store and drain ──────────────────────────────────

describe('attack: replay after an app update', () => {
  it('A3 replays a retained envelope with the release that produced it', async () => {
    const { memory } = await seeded(1);
    const original = eventOf(clean(1));
    expect(original).toMatchObject({
      release: 'com.picklesensei@1.0+1',
      dist: '1',
      tags: expect.objectContaining({
        source_revision: 'a'.repeat(40),
        model_version: 'scoring-v1',
        policy_version: 'policy-v1',
      }),
    });

    // Process restarts on the updated build with the same on-disk buffer.
    const updated = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity: updatedIdentity,
      now: () => T0 + 60_000,
    });
    const replayed = await updated.shift();
    expect(replayed).toBeDefined();

    // The crash happened on 1.0 (build 1, revision a…); reporting it against
    // 1.1 / build 2 / revision b… misattributes the defect to a release that
    // never produced it.
    expect(eventOf(replayed!)).toMatchObject({
      release: 'com.picklesensei@1.0+1',
      dist: '1',
      tags: expect.objectContaining({
        source_revision: 'a'.repeat(40),
        model_version: 'scoring-v1',
        policy_version: 'policy-v1',
      }),
    });
  });
});

// ─── A4/A5: hung request / process death while an envelope is in flight ──────

describe('attack: request hangs or the process dies mid-drain', () => {
  function hangingSink() {
    let hung = false;
    return fakeSink(() => {
      if (!hung) {
        hung = true;
        return new Promise<never>(() => undefined);
      }
      return Promise.resolve({ statusCode: 200 });
    });
  }

  it('A4 keeps the in-flight envelope durable until the ingest acknowledges it', async () => {
    const { memory, store } = await seeded(2);
    const { sink, send } = hangingSink();
    const timers = scheduler();
    createRetainedTransport(sink, { store, schedule: timers.schedule });

    await timers.fire();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(clean(1));

    // The request has not been acknowledged; if the process dies now the
    // envelope must still be on disk.
    expect(memory.sequences()).toHaveLength(2);
    expect(memory.envelopes()).toEqual([clean(1), clean(2)]);

    // Simulated restart over the same storage: the replacement transport must
    // eventually deliver both envelopes.
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
    expect(sent).toEqual([clean(1), clean(2)]);
  });

  it('A5 keeps retrying later envelopes after one request hangs', async () => {
    const { store } = await seeded(2);
    const { sink, send } = hangingSink();
    const timers = scheduler();
    const transport = createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
    });

    await timers.fire();
    expect(send).toHaveBeenCalledTimes(1);

    // Later the sink recovers; a flush and several retry windows elapse.
    await transport.flush(1_000);
    await timers.fireAll();

    // Envelope 2 (and anything captured afterwards) must not be pinned behind
    // a single request that never settles.
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(send).toHaveBeenLastCalledWith(clean(2));
  });
});

// ─── A6: corrupt on-disk metadata ────────────────────────────────────────────

describe('attack: corrupt persisted metadata', () => {
  it('A6 evicts rows whose recorded byte count understates the payload on disk', async () => {
    const sqlite = nodeSqlite();
    const store = createBoundedDiagnosticStore({
      storage: createSqliteRetentionStorage(async () => sqlite.database),
      identity,
      now: () => T0,
    });
    await store.push(envelope(1));
    const oversized = 'x'.repeat(DIAGNOSTIC_RETENTION_LIMITS.maxTotalBytes + 1);
    sqlite.native
      .prepare(
        `INSERT INTO ${DIAGNOSTIC_RETENTION_TABLE} (sequence, stored_at, bytes, payload) VALUES (?, ?, ?, ?)`,
      )
      .run(2, T0, 1, oversized);
    await store.push(envelope(3));

    await store.prune();

    // The cap is a property of the bytes on disk, not of a self-reported
    // column; a row whose payload alone exceeds the whole-buffer cap cannot
    // survive a prune.
    const onDisk = sqlite.rows().reduce((sum, row) => sum + row.actual, 0);
    expect({
      sequences: sqlite.rows().map(row => row.sequence),
      withinCap: onDisk <= DIAGNOSTIC_RETENTION_LIMITS.maxTotalBytes,
    }).toEqual({ sequences: [1, 3], withinCap: true });
  });
});

// ─── A7: flush semantics ─────────────────────────────────────────────────────

describe('attack: flush', () => {
  it('A7 flush(timeout) delivers retained envelopes before it resolves', async () => {
    const { memory, store } = await seeded(1);
    const { sink, sent } = fakeSink(async () => ({ statusCode: 200 }));
    const timers = scheduler();
    const transport = createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
      flushAtStartup: false,
    });

    await expect(transport.flush(1_000)).resolves.toBe(true);

    // The SDK calls flush(timeout) when the app is about to background or
    // close; the retained buffer is exactly what should go out then.
    expect({
      delivered: sent.length,
      retained: memory.sequences().length,
      pendingTimers: timers.queue.length,
    }).toEqual({ delivered: 1, retained: 0, pendingTimers: 0 });
    expect(sent).toEqual([clean(1)]);
  });
});

// ─── A8: replay headers ──────────────────────────────────────────────────────

describe('attack: replay headers', () => {
  it('A8 stamps sent_at with the send time when replaying a retained envelope', async () => {
    const { store } = await seeded(1);
    const { sink, sent } = fakeSink(async () => ({ statusCode: 200 }));
    const timers = scheduler();
    createRetainedTransport(sink, { store, schedule: timers.schedule });
    const before = Date.now();
    await timers.fire();
    expect(sent).toHaveLength(1);

    const header = (sent[0] as unknown as [{ sent_at: string }])[0];
    const sentAt = Date.parse(header.sent_at);
    const eventTime = eventOf(sent[0]!).timestamp! * 1000;

    // sent_at is the header the ingest uses for clock-drift correction; a
    // replayed envelope stamped with its original event time is read as a
    // device clock that is days behind and gets its timestamp shifted.
    expect(sentAt).toBeGreaterThanOrEqual(before);
    expect(sentAt).not.toBe(eventTime);
  });
});

// ─── A9/A10: boundaries the candidate must survive ──────────────────────────

describe('attack: concurrency and clock boundaries', () => {
  it('A9 serialises a burst of online failures racing the retry drain', async () => {
    const { memory, store } = await seeded(0);
    const mode = { fail: true };
    const { sink, sent } = fakeSink(async () => {
      if (mode.fail) throw new Error(marker);
      return { statusCode: 200 };
    });
    const timers = scheduler();
    const transport = createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
      flushAtStartup: false,
    });

    const burst = Array.from({ length: 40 }, (_, index) =>
      transport.send(clean(index + 1)),
    );
    await Promise.all(burst);
    expect(memory.sequences()).toHaveLength(
      DIAGNOSTIC_RETENTION_LIMITS.maxEnvelopes,
    );
    expect(memory.envelopes()[0]).toEqual(clean(9));

    mode.fail = false;
    const fired = await timers.fireAll(128);
    expect(fired).toBeGreaterThan(0);
    const delivered = sent.slice(40);
    expect(delivered).toEqual(
      Array.from({ length: 32 }, (_, index) => clean(index + 9)),
    );
    expect(memory.sequences()).toEqual([]);
  });

  it('A10 ignores non-finite clocks and evicts deterministically on a clock rollback', async () => {
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
});
