/// <reference types="node" />
/**
 * The app owns ONE SQLite connection (`getDb()`), and SQLite transactions are
 * connection-scoped: two callers that both issue `BEGIN IMMEDIATE` on it
 * collide ("cannot start a transaction within a transaction"), and the
 * loser's ROLLBACK then tears down the winner's open transaction. This suite
 * runs the production `db.ts` migrations, `repository.ts` writes and the
 * `sync.ts` drain against Node's real `node:sqlite` and pins that concurrent
 * transactions are serialized on the connection instead of colliding.
 *
 * Run: cd apps/mobile && npx jest __tests__/localDbTransactionSerialization.test.ts
 */
import {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
} from 'node:worker_threads';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  getAnalysis,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
  saveSession,
} from '../src/data/repository';
import { drainOutbox, type SyncTransport } from '../src/data/sync';

interface Statement {
  /** Which logical caller issued the statement. */
  actor: string;
  sql: string;
}

interface Connection {
  /** Every statement that reached SQLite, in execution order. */
  readonly timeline: Statement[];
  /** Every error SQLite raised, in order. */
  readonly errors: string[];
  executeSync(
    sql: string,
    params?: unknown[],
  ): { rows: Record<string, unknown>[] };
  /** Async like the native bridge: yields one microtask before running, so
   * two in-flight callers interleave at statement granularity. */
  execute(
    actor: string,
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  close(): void;
}

const mockState: { connection: Connection | null } = { connection: null };

/** `node:sqlite` driven synchronously from a worker thread, so the suite runs
 * under plain `npx jest` on every Node the app supports: 22.11–22.12 gate the
 * module behind `--experimental-sqlite`, which a worker can enable for itself
 * even when the test process was started without it. */
const SQLITE_WORKER = `
const { workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.path);
const signal = new Int32Array(workerData.signal);
workerData.port.on('message', request => {
  let reply;
  try {
    if (request.close) {
      db.close();
      reply = { rows: [] };
    } else {
      reply = {
        rows: db
          .prepare(request.sql)
          .all(...request.params)
          .map(row => ({ ...row })),
      };
    }
  } catch (error) {
    reply = { error: error instanceof Error ? error.message : String(error) };
  }
  workerData.port.postMessage(reply);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
`;

interface RawSqlite {
  run(sql: string, params?: unknown[]): Record<string, unknown>[];
  close(): void;
}

function openRawSqlite(path = ':memory:'): RawSqlite {
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(SQLITE_WORKER, {
    eval: true,
    execArgv: [
      ...process.execArgv,
      '--experimental-sqlite',
      '--disable-warning=ExperimentalWarning',
    ],
    workerData: { path, port: port2, signal: signal.buffer },
    transferList: [port2],
  });
  worker.unref();
  const request = (
    message: { sql: string; params: unknown[] } | { close: true },
  ): Record<string, unknown>[] => {
    Atomics.store(signal, 0, 0);
    port1.postMessage(message);
    Atomics.wait(signal, 0, 0, 10_000);
    const reply = receiveMessageOnPort(port1)?.message as
      { rows: Record<string, unknown>[] } | { error: string } | undefined;
    if (!reply) {
      throw new Error(
        `node:sqlite worker did not answer under ${process.version}`,
      );
    }
    if ('error' in reply) throw new Error(reply.error);
    return reply.rows;
  };
  let closed = false;
  return {
    run: (sql, params = []) => request({ sql, params }),
    close() {
      if (closed) throw new Error('database is not open');
      closed = true;
      request({ close: true });
      port1.close();
      void worker.terminate();
    },
  };
}

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const connection = mockState.connection;
    if (!connection) throw new Error('harness: no connection');
    return {
      executeSync: (sql: string, params?: unknown[]) =>
        connection.executeSync(sql, params),
      execute: (sql: string, params?: unknown[]) =>
        connection.execute('app', sql, params),
      close: () => connection.close(),
    };
  },
}));

function openConnection(): Connection {
  const raw = openRawSqlite();
  const timeline: Statement[] = [];
  const errors: string[] = [];
  const run = (actor: string, sql: string, params: unknown[] = []) => {
    timeline.push({ actor, sql });
    try {
      return { rows: raw.run(sql, params) };
    } catch (error) {
      errors.push(String(error));
      throw error;
    }
  };
  return {
    timeline,
    errors,
    executeSync: (sql, params) => run('launch', sql, params),
    async execute(actor, sql, params) {
      await Promise.resolve();
      return run(actor, sql, params);
    },
    close() {
      raw.close();
    },
  };
}

/** Runs the production launch migrations over `connection` (one "launch"). */
function launch(connection: Connection): LocalDb {
  mockState.connection = connection;
  let db: LocalDb | null = null;
  jest.isolateModules(() => {
    db = jest
      .requireActual<typeof import('../src/data/db')>('../src/data/db')
      .getDb();
  });
  if (!db) throw new Error('db module did not load');
  return db;
}

/** The app-facing LocalDb as seen by one logical caller; `onStatement` runs
 * BEFORE each statement is issued (used to start a competing writer at an
 * exact point inside a transaction). */
function actorDb(
  connection: Connection,
  actor: string,
  onStatement?: (sql: string) => void,
): LocalDb {
  return {
    async execute(sql, params = []) {
      onStatement?.(sql);
      return connection.execute(actor, sql, params);
    },
    close() {
      connection.close();
    },
  };
}

const OWNER = canonicalDataOwner('11111111-1111-4111-8111-111111111111');
const PERMIT = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function uuid(n: number): string {
  return `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function analysis(id: string, sessionId: string | null = null): ShotAnalysis {
  return {
    id,
    sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-26T18:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '1.0',
      modelBundleVersion: 'test-native-1',
      poseModelVersion: 'test-pose-1',
      paddleModelVersion: 'test-paddle-1',
      strokeDetectorVersion: 'test-stroke-1',
      phaseModelVersion: 'test-phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

const acceptingTransport: SyncTransport = {
  async syncShots(shots) {
    return {
      acceptedIds: shots.map(shot =>
        String((shot as Record<string, unknown>)['id']),
      ),
      rejected: [],
    };
  },
  async createSession() {},
  async finalizeSession() {},
};

function settle<T>(promise: Promise<T>): Promise<string> {
  return promise.then(
    () => 'fulfilled',
    (error: unknown) => `rejected: ${String(error)}`,
  );
}

const TX_COLLISION = 'cannot start a transaction within a transaction';
const TX_TORN_DOWN = 'no transaction is active';

/**
 * Every BEGIN..COMMIT/ROLLBACK span per actor, as [start, end] indexes into
 * the timeline. Spans of different actors must not overlap: that is the
 * "no BEGIN/COMMIT pair interleaves with another transaction's statements"
 * contract, and it implies no transactional statement of one caller ever
 * ran inside the other caller's transaction.
 */
function transactionSpans(
  timeline: Statement[],
): Array<{ actor: string; start: number; end: number }> {
  const open = new Map<string, number>();
  const spans: Array<{ actor: string; start: number; end: number }> = [];
  timeline.forEach((statement, index) => {
    if (statement.sql === 'BEGIN IMMEDIATE') {
      expect(open.has(statement.actor)).toBe(false);
      open.set(statement.actor, index);
    } else if (statement.sql === 'COMMIT' || statement.sql === 'ROLLBACK') {
      const start = open.get(statement.actor);
      expect(start).toBeDefined();
      open.delete(statement.actor);
      spans.push({ actor: statement.actor, start: start!, end: index });
    }
  });
  expect([...open.keys()]).toEqual([]);
  return spans;
}

function expectSerializedTransactions(connection: Connection): void {
  expect(connection.errors.filter(e => e.includes(TX_COLLISION))).toEqual([]);
  expect(connection.errors.filter(e => e.includes(TX_TORN_DOWN))).toEqual([]);
  const spans = transactionSpans(connection.timeline);
  for (const a of spans) {
    for (const b of spans) {
      if (a === b || a.actor === b.actor) continue;
      const overlap = a.start <= b.end && b.start <= a.end;
      expect(overlap).toBe(false);
    }
  }
  // Every transaction ended with COMMIT — nothing was rolled back.
  expect(
    connection.timeline.filter(s => s.sql === 'ROLLBACK').map(s => s.actor),
  ).toEqual([]);
}

describe('LocalDb transaction serialization (real SQLite, one shared connection)', () => {
  let connection: Connection;

  beforeEach(() => {
    connection = openConnection();
    setActiveDataOwner(OWNER);
  });

  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    connection.close();
    mockState.connection = null;
  });

  it('ordering A: the drain receipt transaction is open when saveAnalysis starts — both commit', async () => {
    const bootstrap = launch(connection);
    await saveAnalysis(bootstrap, analysis(uuid(1)), PERMIT);
    connection.timeline.length = 0;

    const saveDb = actorDb(connection, 'save');
    let save: Promise<string> | null = null;
    const drainDb = actorDb(connection, 'drain', sql => {
      // The receipt transaction has already opened (BEGIN reached SQLite);
      // a scoring run finishes now and persists its rating concurrently.
      if (sql.includes('INSERT OR REPLACE INTO sync_receipt') && !save) {
        save = settle(saveAnalysis(saveDb, analysis(uuid(2)), PERMIT));
      }
    });

    const drain = await settle(drainOutbox(drainDb, acceptingTransport));
    expect(save).not.toBeNull();
    expect(await save!).toBe('fulfilled');
    expect(drain).toBe('fulfilled');

    expect(await hasShotSyncReceipt(saveDb, uuid(1))).toBe(true);
    expect(await getAnalysis(saveDb, uuid(2))).not.toBeNull();
    expect(await getShotOutboxStatus(saveDb, uuid(2))).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
    expectSerializedTransactions(connection);
  });

  it('ordering B: saveAnalysis holds its transaction when the drain wants the receipt — both commit', async () => {
    const bootstrap = launch(connection);
    await saveAnalysis(bootstrap, analysis(uuid(1)), PERMIT);
    connection.timeline.length = 0;

    const drainDb = actorDb(connection, 'drain');
    let drain: Promise<string> | null = null;
    let drainResult: { synced: number; failed: number; remaining: number } = {
      synced: -1,
      failed: -1,
      remaining: -1,
    };
    const saveDb = actorDb(connection, 'save', sql => {
      // saveAnalysis is inside its transaction (the local_shot row is
      // written, the outbox row is about to be) when a timer drain lands.
      if (sql.includes('INSERT INTO outbox') && !drain) {
        drain = settle(
          drainOutbox(drainDb, acceptingTransport).then(result => {
            drainResult = result;
          }),
        );
      }
    });

    const save = await settle(saveAnalysis(saveDb, analysis(uuid(2)), PERMIT));
    expect(drain).not.toBeNull();
    expect(await drain!).toBe('fulfilled');
    expect(save).toBe('fulfilled');

    // The drain's window was read before shot 2's outbox row existed, so it
    // synced exactly the older shot; the new rating is durable and queued.
    expect(drainResult).toEqual({ synced: 1, failed: 0, remaining: 1 });
    expect(await hasShotSyncReceipt(saveDb, uuid(1))).toBe(true);
    expect(await getAnalysis(saveDb, uuid(2))).not.toBeNull();
    expect(await getShotOutboxStatus(saveDb, uuid(2))).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
    expectSerializedTransactions(connection);
  });

  it('two repository transactions started in the same tick both commit', async () => {
    launch(connection);
    connection.timeline.length = 0;
    const sessionId = 'bbbbbbbb-0000-4000-8000-000000000001';
    const shotDb = actorDb(connection, 'shot');
    const sessionDb = actorDb(connection, 'session');

    const [shot, session] = await Promise.all([
      settle(saveAnalysis(shotDb, analysis(uuid(3), sessionId), PERMIT)),
      settle(
        saveSession(sessionDb, {
          id: sessionId,
          mode: 'practice_set',
          shotType: 'forehand_drive',
          focusCheckpoint: null,
          startedAt: '2026-08-26T18:00:00.000Z',
        }),
      ),
    ]);
    expect(shot).toBe('fulfilled');
    expect(session).toBe('fulfilled');

    expect(await getAnalysis(shotDb, uuid(3))).not.toBeNull();
    const queued = connection.executeSync(
      `SELECT kind FROM outbox WHERE owner_key = ? ORDER BY id ASC`,
      [OWNER],
    ).rows;
    expect(queued.map(row => row['kind']).sort()).toEqual([
      'session.create',
      'shot.sync',
    ]);
    expectSerializedTransactions(connection);
  });
});
