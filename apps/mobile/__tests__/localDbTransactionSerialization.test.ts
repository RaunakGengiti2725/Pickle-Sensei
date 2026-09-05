/**
 * MDS-2: the app has ONE SQLite connection (`getDb()`), and SQLite has no
 * nested transactions on a connection. `saveAnalysis()` (repository.ts) and
 * the accepted-shot receipt block of `drainOutbox()` (sync.ts) both open
 * `BEGIN IMMEDIATE`; nothing may let the second BEGIN land while the first
 * transaction is still open, or the loser throws "cannot start a transaction
 * within a transaction" and its ROLLBACK tears down the winner.
 *
 * The production statements run against REAL SQLite (node:sqlite, Node 22).
 * Concurrency is driven exactly the way syncRuntime reaches it on device: a
 * drain finishing while a scoring run persists its rating, and vice versa.
 * Pinned in both orders:
 *   - both callers commit (the rating exists, the accepted shot has a receipt,
 *     the new rating is still queued or already receipted — never lost);
 *   - no statement raised "cannot start a transaction within a transaction";
 *   - no BEGIN … COMMIT/ROLLBACK span contains another caller's statement.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../src/data/db';

// apps/mobile types only `jest` (no @types/node) so app code cannot lean on
// Node APIs; this test declares the exact node:sqlite surface it drives.
declare const require: (id: string) => unknown;

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};

interface LoggedStatement {
  sql: string;
  error: string | null;
}

const mockState: {
  real: DatabaseSync | null;
  log: LoggedStatement[];
} = { real: null, log: [] };

function mockRunReal(sql: string, params: unknown[] = []) {
  const db = mockState.real;
  if (!db) throw new Error('test did not open a database');
  try {
    const rows = db.prepare(sql).all(...(params as (string | number | null)[]));
    mockState.log.push({ sql, error: null });
    return { rows };
  } catch (error) {
    mockState.log.push({ sql, error: String(error) });
    throw error;
  }
}

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => ({
    executeSync: (sql: string, params: unknown[] = []) =>
      mockRunReal(sql, params),
    // op-sqlite resolves every `execute` asynchronously; a second caller can
    // be scheduled between any two statements of the first (INFERRED for the
    // device — the microtask boundary is the smallest such gap).
    execute: async (sql: string, params: unknown[] = []) => {
      await Promise.resolve();
      return mockRunReal(sql, params);
    },
    close: () => {
      mockState.real?.close();
      mockState.real = null;
    },
  }),
}));

import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { getDb } from '../src/data/db';
import {
  getAnalysis,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
} from '../src/data/repository';
import { drainOutbox, type SyncTransport } from '../src/data/sync';

const CANONICAL_USER = '11111111-2222-4333-8444-555555555555';
const PERMIT_ID = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OWNER = canonicalDataOwner(CANONICAL_USER);
const NESTED_BEGIN = 'cannot start a transaction within a transaction';

function shotId(n: number): string {
  return `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function realAnalysis(id: string): ShotAnalysis {
  return {
    id,
    sessionId: null,
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
      appVersion: '0.1.0',
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

function acceptAllTransport(): SyncTransport {
  return {
    async syncShots(shots) {
      return {
        acceptedIds: shots.map(s => String((s as { id: unknown }).id)),
        rejected: [],
      };
    },
    async createSession() {},
    async finalizeSession() {},
  };
}

type Caller = 'save' | 'drain';
interface TaggedStatement {
  caller: Caller;
  sql: string;
}

/** Tags every statement a caller runs on the shared connection (in the order
 * the connection executed them) and lets a hook start the competing caller at
 * the moment a given statement is issued — the point at which the runtime
 * would schedule it on device. */
function tagged(
  db: LocalDb,
  caller: Caller,
  trace: TaggedStatement[],
  onStatement: (sql: string) => void = () => {},
): LocalDb {
  return {
    ...db,
    async execute(sql, params) {
      onStatement(sql);
      try {
        return await db.execute(sql, params);
      } finally {
        trace.push({ caller, sql });
      }
    },
  };
}

function isBegin(sql: string): boolean {
  return /^\s*BEGIN\b/i.test(sql);
}
function isEnd(sql: string): boolean {
  return /^\s*(COMMIT|ROLLBACK|END)\b/i.test(sql);
}
function isWrite(sql: string): boolean {
  return /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
}

/** While one caller's BEGIN … COMMIT/ROLLBACK span is open on the shared
 * connection, the other caller must not open a transaction of its own nor
 * land a write inside the span (an autocommit write issued there is silently
 * absorbed into — and rolled back with — the open transaction). Returns the
 * offending statements. */
function interleavedStatements(trace: TaggedStatement[]): TaggedStatement[] {
  const offenders: TaggedStatement[] = [];
  let open: Caller | null = null;
  for (const entry of trace) {
    if (open === null) {
      if (isBegin(entry.sql)) open = entry.caller;
      continue;
    }
    if (entry.caller !== open) {
      if (isBegin(entry.sql) || isWrite(entry.sql)) offenders.push(entry);
      continue;
    }
    if (isEnd(entry.sql)) open = null;
  }
  return offenders;
}

async function settle<T>(p: Promise<T>): Promise<PromiseSettledResult<T>> {
  const [result] = await Promise.allSettled([p]);
  return result;
}

function describeSettled(result: PromiseSettledResult<unknown>): string {
  return result.status === 'fulfilled'
    ? 'fulfilled'
    : `rejected: ${String(result.reason)}`;
}

describe('local SQLite transactions are serialised on the one shared connection', () => {
  let db: LocalDb;
  let trace: TaggedStatement[];

  beforeEach(() => {
    mockState.real = new DatabaseSync(':memory:');
    mockState.log = [];
    trace = [];
    setActiveDataOwner(OWNER);
    db = getDb();
  });

  afterEach(() => {
    db.close();
  });

  function expectNoNestedBegin(): void {
    const nested = mockState.log.filter(
      entry => entry.error !== null && entry.error.includes(NESTED_BEGIN),
    );
    expect(nested).toEqual([]);
  }

  it('drain receipt transaction first: a rating saved meanwhile is committed and the receipt is recorded', async () => {
    await saveAnalysis(db, realAnalysis(shotId(1)), PERMIT_ID);
    const saveDb = tagged(db, 'save', trace);
    const competing: { saved: Promise<PromiseSettledResult<void>> | null } = {
      saved: null,
    };
    const drainDb = tagged(db, 'drain', trace, sql => {
      if (
        sql.includes('INSERT OR REPLACE INTO sync_receipt') &&
        !competing.saved
      ) {
        competing.saved = settle(
          saveAnalysis(saveDb, realAnalysis(shotId(2)), PERMIT_ID),
        );
      }
    });

    const drainResult = await settle(
      drainOutbox(drainDb, acceptAllTransport()),
    );
    if (!competing.saved) throw new Error('interleaving hook never fired');
    const saveResult = await competing.saved;

    expect(describeSettled(saveResult)).toBe('fulfilled');
    expect(describeSettled(drainResult)).toBe('fulfilled');
    expectNoNestedBegin();
    expect(interleavedStatements(trace)).toEqual([]);

    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(true);
    expect(await getAnalysis(db, shotId(2))).not.toBeNull();
    const queued = await getShotOutboxStatus(db, shotId(2));
    expect(
      queued.state === 'queued' || (await hasShotSyncReceipt(db, shotId(2))),
    ).toBe(true);
    expect((await db.execute('PRAGMA integrity_check')).rows).toEqual([
      { integrity_check: 'ok' },
    ]);
  });

  it('save transaction first: an accepted shot drained meanwhile gets its receipt and the rating is committed', async () => {
    await saveAnalysis(db, realAnalysis(shotId(1)), PERMIT_ID);
    const transport = acceptAllTransport();
    const drainDb = tagged(db, 'drain', trace);
    const competing: {
      drain: Promise<
        PromiseSettledResult<{
          synced: number;
          failed: number;
          remaining: number;
        }>
      > | null;
    } = { drain: null };
    const saveDb = tagged(db, 'save', trace, sql => {
      if (sql.includes('INSERT INTO outbox') && !competing.drain) {
        competing.drain = settle(drainOutbox(drainDb, transport));
      }
    });

    const saveResult = await settle(
      saveAnalysis(saveDb, realAnalysis(shotId(2)), PERMIT_ID),
    );
    if (!competing.drain) throw new Error('interleaving hook never fired');
    const drainResult = await competing.drain;

    expect(describeSettled(saveResult)).toBe('fulfilled');
    expect(describeSettled(drainResult)).toBe('fulfilled');
    if (drainResult.status === 'fulfilled') {
      expect(drainResult.value.failed).toBe(0);
      expect(drainResult.value.synced).toBeGreaterThanOrEqual(1);
    }
    expectNoNestedBegin();
    expect(interleavedStatements(trace)).toEqual([]);

    expect(await hasShotSyncReceipt(db, shotId(1))).toBe(true);
    expect(await getAnalysis(db, shotId(2))).not.toBeNull();
    const queued = await getShotOutboxStatus(db, shotId(2));
    expect(
      queued.state === 'queued' || (await hasShotSyncReceipt(db, shotId(2))),
    ).toBe(true);
    expect((await db.execute('PRAGMA integrity_check')).rows).toEqual([
      { integrity_check: 'ok' },
    ]);
  });
});
