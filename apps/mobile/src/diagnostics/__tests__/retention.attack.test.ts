/**
 * W10-02 adversarial suite against candidate 08eb551b (bounded offline
 * diagnostic retention). Every test asserts the behaviour the objective
 * requires at a failure boundary; a failing test is a confirmed break of the
 * candidate, a passing test is an attack the candidate withstood. The
 * candidate's own suite (retention.test.ts) is left untouched; fixtures are
 * duplicated here so this file runs independently of it.
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
  classifyDiagnosticDelivery,
  createBoundedDiagnosticStore,
  createRetainedTransport,
  createSqliteRetentionStorage,
  DIAGNOSTIC_RETENTION_LIMITS,
  DIAGNOSTIC_RETENTION_TABLE,
  DIAGNOSTIC_RETRY_DELAYS,
  planDiagnosticRetention,
  type DiagnosticRetentionDatabase,
  type DiagnosticRetentionStorage,
  type RetainedDiagnosticRecord,
} from '../retention';
import { scrubDiagnosticEnvelope } from '../scrub';

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
    [[{ type: 'event' }, dirtyEvent(index)]],
  ] as unknown as DiagnosticEnvelope;
}

function clean(index: number): DiagnosticEnvelope {
  const scrubbed = scrubDiagnosticEnvelope(envelope(index), identity);
  if (!scrubbed) throw new Error('fixture must scrub to an envelope');
  return scrubbed;
}

function eventIdOf(body: string): string {
  const header: unknown = JSON.parse(body.split('\n')[0] ?? '{}');
  return typeof header === 'object' &&
    header !== null &&
    'event_id' in header &&
    typeof header.event_id === 'string'
    ? header.event_id
    : '';
}

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
    sequences: () =>
      native
        .prepare(
          `SELECT CAST(sequence AS TEXT) AS s FROM ${DIAGNOSTIC_RETENTION_TABLE} ORDER BY sequence ASC`,
        )
        .all()
        .map(row => String(row.s)),
  };
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  jest.useRealTimers();
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
    async fireAll(limit: number): Promise<number> {
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

/**
 * The real Sentry fetch transport (what sentry.ts hands to the retention
 * layer) over a scripted ingest. `bufferSize: 8` mirrors
 * `transportOptions.bufferSize` in optionsForDiagnostics.
 */
function ingest(
  script: (call: number) => { status: number; retryAfter?: string },
  options: { hang?: () => boolean } = {},
) {
  const bodies: string[] = [];
  const dropped: [string, string][] = [];
  const hung: ((value: { status: number; headers: Headers }) => void)[] = [];
  type Headers = { get(name: string): string | null };
  const fetchImpl = (
    _url: string,
    init: { body: string },
  ): Promise<{ status: number; headers: Headers }> => {
    bodies.push(init.body);
    const { status, retryAfter } = script(bodies.length);
    const response = {
      status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'retry-after' && retryAfter !== undefined
            ? retryAfter
            : null,
      },
    };
    if (options.hang?.()) {
      return new Promise(resolve => {
        hung.push(resolve);
      });
    }
    return Promise.resolve(response);
  };
  const sink = makeFetchTransport(
    {
      url: INGEST,
      bufferSize: 8,
      recordDroppedEvent: (reason, category) =>
        dropped.push([reason, category]),
    },
    fetchImpl as unknown as typeof fetch,
  );
  return {
    sink,
    bodies,
    dropped,
    releaseHung(status: number) {
      for (const resolve of hung.splice(0))
        resolve({ status, headers: { get: () => null } });
    },
  };
}

async function seeded(count: number, now: () => number = () => T0) {
  const memory = memoryStorage();
  const store = createBoundedDiagnosticStore({
    storage: memory.storage,
    identity,
    now,
  });
  for (let index = 1; index <= count; index += 1)
    await store.push(envelope(index));
  expect(memory.sequences()).toHaveLength(count);
  return { memory, store };
}

// ─── A1: network failure — Retry-After that resolves to a zero window ───────

describe('A1 zero-window Retry-After must not become a retry storm', () => {
  /**
   * The ingest (or a proxy in front of it) answers with a Retry-After the
   * device resolves to 0 ms: `Retry-After: 0`, an HTTP-date that is already
   * in the past on the device clock (clock ahead of the server, or latency
   * longer than the window), a malformed negative value, or an
   * `X-Sentry-Rate-Limits` of 0 s. The sink (the real fetch transport) is
   * NOT rate-limited by any of these, so every retry is a real request.
   * Expected: the drain never re-probes without a positive wait — at least
   * the default rate-limit window for a 429, or the backoff floor.
   */
  const cases: [
    string,
    (call: number) => { status: number; retryAfter?: string },
  ][] = [
    ['429 + Retry-After: 0', () => ({ status: 429, retryAfter: '0' })],
    [
      '429 + Retry-After HTTP-date already past on the device clock',
      () => ({
        status: 429,
        retryAfter: new Date(T0 - 1_000).toUTCString(),
      }),
    ],
    [
      '429 + malformed Retry-After: -5',
      () => ({ status: 429, retryAfter: '-5' }),
    ],
    ['503 + Retry-After: 0', () => ({ status: 503, retryAfter: '0' })],
  ];

  it.each(cases)(
    'schedules a positive wait between probes for %s (scheduler seam)',
    async (_title, script) => {
      jest.useFakeTimers();
      jest.setSystemTime(T0);
      const { memory, store } = await seeded(1);
      const { sink, bodies } = ingest(script);
      const timers = scheduler();
      createRetainedTransport(sink, { store, schedule: timers.schedule });

      expect(timers.delays).toEqual([initialMs]);
      await timers.fireAll(40);

      // The clock never moved, so at most the single probe that learned the
      // window may have gone out; every rearm must wait a positive amount.
      expect(memory.sequences()).toEqual([1]);
      expect({
        requests: bodies.length,
        zeroDelayRearms: timers.delays.slice(1).filter(delay => delay <= 0)
          .length,
      }).toEqual({ requests: 1, zeroDelayRearms: 0 });
    },
  );

  it('does not hammer a 429 + Retry-After: 0 ingest under the default setTimeout scheduler', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const { memory, store } = await seeded(1);
    const { sink, bodies } = ingest(() => ({ status: 429, retryAfter: '0' }));
    createRetainedTransport(sink, { store });

    await jest.advanceTimersByTimeAsync(initialMs);
    expect(bodies).toHaveLength(1);
    // One second later the ingest must not have been probed again: a 429
    // with no usable window falls back to the 60 s default (rateLimitMs).
    await jest.advanceTimersByTimeAsync(1_000);
    expect({ requests: bodies.length, retained: memory.sequences() }).toEqual({
      requests: 1,
      retained: [1],
    });
    await jest.advanceTimersByTimeAsync(rateLimitMs);
    expect(bodies.length).toBeLessThanOrEqual(3);
  });

  it('classifies a zero or past Retry-After as a positive window, not 0 ms', () => {
    const zero = classifyDiagnosticDelivery(
      { statusCode: 429, headers: { 'retry-after': '0' } },
      T0,
    );
    const past = classifyDiagnosticDelivery(
      {
        statusCode: 429,
        headers: { 'retry-after': new Date(T0 - 5_000).toUTCString() },
      },
      T0,
    );
    const limits = classifyDiagnosticDelivery(
      { statusCode: 429, headers: { 'x-sentry-rate-limits': '0:error' } },
      T0,
    );
    for (const delivery of [zero, past, limits]) {
      expect(delivery.kind).toBe('retry');
      if (delivery.kind === 'retry')
        expect(delivery.retryAfterMs ?? rateLimitMs).toBeGreaterThan(0);
    }
  });
});

// ─── A2: boundary — clock rollback while a retry window is armed ────────────

describe('A2 clock rollback while a retry window is armed', () => {
  /**
   * The store's age cap deliberately survives a clock rollback (rows are
   * evicted on |now - storedAt|). The transport's retry window is measured on
   * the same clock: after a 5 s backoff is armed the device clock is set back
   * two days (time-zone fix, NTP correction). Expected: the wait never exceeds
   * the declared cap (maxMs = 1 h) and flush() can still deliver once the
   * ingest is healthy.
   */
  it('caps the wait after the clock moves backwards and lets flush deliver', async () => {
    const clock = { now: T0 };
    const { memory, store } = await seeded(1, () => clock.now);
    const status = { code: 503 };
    const { sink, sent } = fakeSink(async () => ({ statusCode: status.code }));
    const timers = scheduler();
    const transport = createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
      now: () => clock.now,
    });

    await timers.fire(); // startup drain → 503 → 5 s backoff armed on the clock
    expect(sent).toHaveLength(1);
    expect(timers.delays).toEqual([initialMs, initialMs]);

    clock.now = T0 - 2 * DAY_MS;
    status.code = 200;
    await timers.fire();
    const rearm = timers.delays.at(-1);
    expect(rearm).toBeDefined();
    expect(rearm).toBeLessThanOrEqual(maxMs);

    const flushed = await transport.flush(1_000);
    expect({
      flushed,
      sent: sent.length,
      retained: memory.sequences(),
    }).toEqual({ flushed: true, sent: 2, retained: [] });
  });
});

// ─── A3: process death — durability of a crash-time envelope ────────────────

describe('A3 crash-time envelope must reach disk before the network answers', () => {
  /**
   * The global fatal handler captures the error and the process is torn down
   * right after (index.js hands the error back to the default handler). The
   * only chance the buffer has is to persist the envelope before/independent
   * of the network round trip. Here the request hangs (captive portal,
   * connected-but-no-internet); the process then dies.
   */
  it('has the envelope on disk while the request is still in flight', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0,
    });
    const { sink, bodies } = ingest(() => ({ status: 200 }), {
      hang: () => true,
    });
    const transport = createRetainedTransport(sink, {
      store,
      flushAtStartup: false,
    });

    const pending = transport.send(clean(1));
    await settle();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(bodies).toHaveLength(1);
    // Process death here: whatever is not on disk is lost.
    expect({
      storageInserts: memory.calls.filter(call => call === 'insert').length,
      retained: memory.envelopes(),
    }).toEqual({ storageInserts: 1, retained: [clean(1)] });
    void Promise.resolve(pending).catch(() => undefined);
  });

  it('flush(timeout) at shutdown persists an in-flight online envelope before giving up', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0,
    });
    const { sink, bodies } = ingest(() => ({ status: 200 }), {
      hang: () => true,
    });
    const transport = createRetainedTransport(sink, {
      store,
      flushAtStartup: false,
    });

    const pending = transport.send(clean(1));
    await settle();
    const flushing = transport.flush(2_000);
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(flushing).resolves.toBe(false);
    expect(bodies).toHaveLength(1);
    expect(memory.envelopes()).toEqual([clean(1)]);
    void Promise.resolve(pending).catch(() => undefined);
  });
});

// ─── A4: corrupt/partial persisted state — a single storage error ───────────

describe('A4 one storage error must not destroy the whole buffer', () => {
  /**
   * SQLITE_BUSY / SQLITE_FULL / an I/O error on one INSERT is a transient,
   * single-row failure. Expected: at most the envelope being written is
   * lost; the envelopes already retained stay on disk and the buffer keeps
   * accepting later envelopes.
   */
  it('keeps previously retained envelopes when one insert fails', async () => {
    const { memory, store } = await seeded(5);
    memory.failNext('insert');
    await store.push(envelope(6));
    expect(memory.sequences()).toEqual([1, 2, 3, 4, 5]);
    expect(memory.resets).toBe(0);
  });

  it('keeps retaining after two transient failures in one process', async () => {
    const { memory, store } = await seeded(2);
    memory.failNext('insert');
    await store.push(envelope(3));
    memory.failNext('insert');
    await store.push(envelope(4));
    await store.push(envelope(5));
    expect(memory.sequences()).toContain(5);
    expect(await store.peek()).toBeDefined();
  });

  it('removes only the unaddressable row, not every valid neighbour (real SQLite)', async () => {
    const sqlite = nodeSqlite();
    const storage = createSqliteRetentionStorage(async () => sqlite.database);
    const store = createBoundedDiagnosticStore({
      storage,
      identity,
      now: () => T0,
    });
    await store.push(envelope(1));
    await store.push(envelope(2));
    sqlite.native
      .prepare(
        `INSERT INTO ${DIAGNOSTIC_RETENTION_TABLE} (sequence, stored_at, bytes, payload) VALUES (?, ?, ?, ?)`,
      )
      .run(9_007_199_254_740_993n, T0, 10, 'garbage');
    expect(sqlite.sequences()).toEqual(['1', '2', '9007199254740993']);

    const next = await store.peek();
    expect(next?.sequence).toBe(1);
    expect(sqlite.sequences()).toEqual(['1', '2']);
  });

  it('planDiagnosticRetention evicts an unaddressable row instead of resetting the table', () => {
    const plan = planDiagnosticRetention(
      [
        { sequence: 1, storedAt: T0, bytes: 10 },
        { sequence: 2 ** 53 + 2, storedAt: T0, bytes: 10 },
        { sequence: 2, storedAt: T0, bytes: 10 },
      ],
      T0,
    );
    expect(plan.reset).toBe(false);
    expect(plan.kept.map(row => row.sequence)).toEqual([1, 2]);
  });
});

// ─── A5: network failure — a 4xx refusal during an outage back-off ──────────

describe('A5 a terminal refusal must not collapse an ingest-announced wait', () => {
  /**
   * The ingest is in a 503 outage and the drain has backed off to a 20 s
   * window. One online envelope is refused with 400 (a malformed payload,
   * or a 413 on an oversized one). Expected: a refusal of THAT envelope says
   * nothing about the outage — the retained envelopes keep waiting out the
   * window instead of probing 100 ms later with the backoff reset to 5 s.
   */
  it('keeps the backoff window after an unrelated 4xx on the online path', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const { memory, store } = await seeded(2);
    const script = { status: 503 };
    const { sink, bodies } = ingest(() => ({ status: script.status }));
    const transport = createRetainedTransport(sink, { store });

    await jest.advanceTimersByTimeAsync(initialMs); // probe 1 → 503, wait 5 s
    await jest.advanceTimersByTimeAsync(initialMs); // probe 2 → 503, wait 10 s
    await jest.advanceTimersByTimeAsync(2 * initialMs); // probe 3 → 503, wait 20 s
    expect(bodies).toHaveLength(3);

    script.status = 400;
    await transport.send(clean(9));
    expect(bodies).toHaveLength(4);
    script.status = 503;

    await jest.advanceTimersByTimeAsync(4 * initialMs - 1);
    expect({ requests: bodies.length, retained: memory.sequences() }).toEqual({
      requests: 4,
      retained: [1, 2],
    });
  });
});

// ─── A6: concurrency — sink promise-buffer overflow ─────────────────────────

describe('A6 sink buffer overflow (bufferSize 8) under hung requests', () => {
  /**
   * Nine envelopes are sent while the network hangs. The real fetch
   * transport's promise buffer (8) overflows on the ninth and resolves it
   * with `{}` (queue_overflow). Expected: the overflowed envelope is retained
   * and replayed once the network recovers; nothing is lost or duplicated.
   */
  it('retains the overflowed envelope and replays it after recovery', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => Date.now(),
    });
    const hang = { on: true };
    const { sink, bodies, dropped, releaseHung } = ingest(
      () => ({ status: 200 }),
      { hang: () => hang.on },
    );
    const transport = createRetainedTransport(sink, {
      store,
      flushAtStartup: false,
    });

    const sends = Array.from({ length: 9 }, (_, index) =>
      transport.send(clean(index + 1)),
    );
    await settle();
    expect(bodies).toHaveLength(8);
    expect(dropped).toEqual([['queue_overflow', 'error']]);
    expect(memory.envelopes()).toEqual([clean(9)]);

    hang.on = false;
    releaseHung(200);
    await Promise.all(sends);
    await jest.advanceTimersByTimeAsync(initialMs + drainMs);
    expect(bodies).toHaveLength(9);
    expect(memory.sequences()).toEqual([]);
    const ids = bodies.map(eventIdOf).sort();
    expect(new Set(ids).size).toBe(9);
  });
});

// ─── A7: concurrency — overlapping flushes and sends ────────────────────────

describe('A7 overlapping flush() calls and a concurrent send burst', () => {
  it('delivers every retained envelope exactly once with no lost rows', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const { memory, store } = await seeded(6);
    const { sink, bodies } = ingest(() => ({ status: 200 }));
    const transport = createRetainedTransport(sink, {
      store,
      flushAtStartup: false,
    });

    const flushes = [transport.flush(5_000), transport.flush(5_000)];
    const sends = [7, 8].map(index => transport.send(clean(index)));
    await jest.advanceTimersByTimeAsync(5_000);
    await Promise.all([...flushes, ...sends]);

    const ids = bodies.map(eventIdOf);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(memory.sequences()).toEqual([]);
  });
});

// ─── A8: process death and restart — at-least-once replay ───────────────────

describe('A8 restart after the ingest accepted but before the row was removed', () => {
  it('replays the acknowledged-but-unremoved row once and continues sequences', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const sqlite = nodeSqlite();
    const first = createBoundedDiagnosticStore({
      storage: createSqliteRetentionStorage(async () => sqlite.database),
      identity,
      now: () => Date.now(),
    });
    await first.push(envelope(1));
    await first.push(envelope(2));
    // Process 1 dies here: row 1 was accepted by the ingest but not removed.

    const second = createBoundedDiagnosticStore({
      storage: createSqliteRetentionStorage(async () => sqlite.database),
      identity,
      now: () => Date.now(),
    });
    const { sink, bodies } = ingest(() => ({ status: 200 }));
    createRetainedTransport(sink, { store: second });
    await second.push(envelope(3));
    await jest.advanceTimersByTimeAsync(initialMs + 3 * drainMs);
    expect(bodies.map(eventIdOf)).toEqual(
      [1, 2, 3].map(index => dirtyEvent(index).event_id),
    );
    expect(sqlite.sequences()).toEqual([]);
  });
});

// ─── A9: boundary — retry headers at their extremes ─────────────────────────

describe('A9 retry header extremes', () => {
  it('caps a 9-digit Retry-After and an HTTP-date far in the future at maxMs', async () => {
    const clock = { now: T0 };
    const { store } = await seeded(1, () => clock.now);
    const { sink } = fakeSink(async (_envelope, call) =>
      call === 1
        ? {
            statusCode: 429,
            headers: { 'retry-after': '999999999' },
          }
        : { statusCode: 200 },
    );
    const timers = scheduler();
    createRetainedTransport(sink, {
      store,
      schedule: timers.schedule,
      now: () => clock.now,
    });
    await timers.fire();
    expect(timers.delays.at(-1)).toBe(maxMs);
  });

  it('never stores or replays anything under a NaN or non-finite clock', async () => {
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => Number.NaN,
    });
    await store.push(envelope(1));
    expect(memory.sequences()).toEqual([]);
    expect(await store.peek()).toBeUndefined();
  });

  it('measures the byte cap in UTF-8 bytes, not UTF-16 code units', async () => {
    const limits = { ...DIAGNOSTIC_RETENTION_LIMITS, maxEnvelopeBytes: 1_000 };
    const memory = memoryStorage();
    const store = createBoundedDiagnosticStore({
      storage: memory.storage,
      identity,
      now: () => T0,
      limits,
    });
    const ascii = JSON.stringify(clean(1)).length;
    expect(ascii).toBeLessThanOrEqual(1_000);
    await store.push(envelope(1));
    expect(memory.sequences()).toEqual([1]);
    for (const row of memory.rows.values())
      expect(row.bytes).toBe(Buffer.byteLength(row.payload, 'utf8'));
  });
});
