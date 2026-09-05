import type { ShotAnalysis } from '@pickle/shared-types';
import type { CapturedClip } from '../src/camera/capture';
import { ApiError } from '../src/data/api';
import { drainOutbox, type SyncTransport } from '../src/data/sync';
import type { LocalDb } from '../src/data/db';
import {
  captureDataOwnerScope,
  DataOwnerChangedError,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  finishSession,
  getKv,
  getPendingCapture,
  purgeOwnerData,
  savePendingCapture,
  saveSession,
  setKv,
  withOwnerTransaction,
} from '../src/data/repository';

const mockOpen = jest.fn();
jest.mock('@op-engineering/op-sqlite', () => ({ open: mockOpen }));

const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '22222222-2222-4222-8222-222222222222';
const clip: CapturedClip = {
  uri: 'file:///captures/independent.mov',
  durationMs: 2000,
  fps: 60,
  width: 1080,
  height: 1080,
  capturedAtIso: '2026-09-04T10:00:00.000Z',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
};
const session = {
  id: 'nested-session',
  mode: 'practice_set',
  shotType: 'forehand_drive',
  focusCheckpoint: null,
  startedAt: clip.capturedAtIso,
};

const syncedShot: ShotAnalysis & { analysisPermitId: string } = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  sessionId: null,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: clip.capturedAtIso,
  timestamps: { startMs: 0, contactMs: 1000, endMs: 2000 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.4,
  analysisConfidence: 0.9,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: 'test',
    modelBundleVersion: 'test',
    poseModelVersion: 'test',
    paddleModelVersion: 'test',
    strokeDetectorVersion: 'test',
    phaseModelVersion: 'test',
    scoringModelVersion: 'test',
    shotConfigVersion: 'test',
  },
  source: 'real',
  analysisPermitId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
};

const acceptAll: SyncTransport = {
  syncShots: async shots => ({
    acceptedIds: shots.map(shot => (shot as { id: string }).id),
    rejected: [],
  }),
  createSession: async () => {},
  finalizeSession: async () => {},
  uploadEvaluationTrials: async trials => ({
    acceptedTrialIds: trials.map(
      trial => (trial as { trialId: string }).trialId,
    ),
    rejected: [],
  }),
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

class ControlledNativeDb {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  private snapshot: {
    kv: Map<string, string>;
    records: Map<string, Record<string, unknown>>;
  } | null = null;
  private nextOutboxId = 1;
  closed = false;
  failNext: string | null = null;
  readonly failure = new Error('injected native failure');
  beforeExecute: (sql: string, params: unknown[]) => Promise<void> =
    async () => {};

  constructor(
    readonly kv: Map<string, string>,
    readonly records: Map<string, Record<string, unknown>>,
  ) {}

  executeSync = jest.fn((sql: string) => ({
    rows: sql.startsWith('PRAGMA table_info')
      ? [
          { name: 'owner_key', pk: 1 },
          { name: 'id', pk: 2 },
          { name: 'payload', pk: 0 },
          { name: 'declared_stroke', pk: 0 },
          { name: 'target_seed', pk: 0 },
          { name: 'training_consent', pk: 0 },
        ]
      : [],
  }));

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, params: [...params] });
    if (this.closed) throw new Error('native database is closed');
    await this.beforeExecute(sql, params);
    if (this.closed) throw new Error('native database is closed');
    if (this.failNext && sql.startsWith(this.failNext)) {
      this.failNext = null;
      throw this.failure;
    }
    if (sql === 'BEGIN IMMEDIATE') {
      if (this.snapshot) throw new Error('cannot start a nested transaction');
      this.snapshot = {
        kv: new Map(this.kv),
        records: new Map(this.records),
      };
    } else if (sql === 'COMMIT') {
      if (!this.snapshot) throw new Error('commit without a transaction');
      this.snapshot = null;
    } else if (sql === 'ROLLBACK') {
      if (!this.snapshot) throw new Error('rollback without a transaction');
      this.restore();
    } else if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
      this.kv.set(String(params[0]), String(params[1]));
    } else if (sql.startsWith('SELECT value FROM kv')) {
      const value = this.kv.get(String(params[0]));
      return { rows: value === undefined ? [] : [{ value }] };
    } else if (sql.startsWith('INSERT INTO local_capture')) {
      this.records.set(`local_capture:${params[0]}:${params[1]}`, {
        owner_key: params[0],
        id: params[1],
        uri: params[2],
        shot_type: params[3],
        declared_stroke: params[4],
        captured_at: params[5],
        duration_ms: params[6],
        fps: params[7],
        width: params[8],
        height: params[9],
        status: 'awaiting_model',
        payload: params[10],
      });
    } else if (sql.startsWith('SELECT') && sql.includes('FROM local_capture')) {
      const row = this.records.get(`local_capture:${params[0]}:${params[1]}`);
      return { rows: row ? [{ ...row }] : [] };
    } else if (sql.startsWith('INSERT OR REPLACE INTO local_session')) {
      this.records.set(`local_session:${params[0]}:${params[1]}`, {
        owner_key: params[0],
        id: params[1],
        completed: 0,
      });
    } else if (sql.startsWith('UPDATE local_session')) {
      const key = `local_session:${params[1]}:${params[2]}`;
      const row = this.records.get(key);
      if (row) this.records.set(key, { ...row, completed: 1 });
    } else if (sql.startsWith('INSERT INTO outbox')) {
      this.insertOutbox(
        /'([a-z.]+)'/.exec(sql)?.[1] ?? String(params[1]),
        String(params[params.length - 1]),
        String(params[0]),
      );
    } else if (sql.startsWith('SELECT id, kind, payload')) {
      return {
        rows: this.outbox
          .filter(
            row =>
              row['owner_key'] === params[0] &&
              Number(row['attempts']) < Number(params[1]),
          )
          .sort((a, b) => Number(a['id']) - Number(b['id']))
          .slice(0, 50),
      };
    } else if (sql.startsWith('SELECT count(*) AS n FROM outbox')) {
      return {
        rows: [
          {
            n: this.outbox.filter(row => row['owner_key'] === params[0]).length,
          },
        ],
      };
    } else if (sql.startsWith('INSERT OR REPLACE INTO sync_receipt')) {
      this.records.set(`sync_receipt:${params[0]}:${params[1]}`, {
        owner_key: params[0],
        kind: 'shot.sync',
        entity_id: params[1],
      });
    } else if (sql.startsWith('UPDATE outbox')) {
      const key = `outbox:${params[1]}:${params[2]}`;
      const row = this.records.get(key);
      if (row) {
        this.records.set(key, {
          ...row,
          attempts:
            Number(row['attempts']) +
            (sql.includes('attempts = attempts + 1') ? 1 : 0),
          last_error: String(params[0]),
        });
      }
    } else if (
      sql.startsWith('DELETE FROM outbox') &&
      sql.includes('AND id = ?')
    ) {
      this.records.delete(`outbox:${params[0]}:${params[1]}`);
    } else if (sql.startsWith('DELETE FROM kv')) {
      this.kv.delete(String(params[0]));
    } else if (sql.startsWith('DELETE FROM')) {
      const table = sql.split(' ')[2];
      for (const [key, row] of this.records) {
        if (key.startsWith(`${table}:`) && row['owner_key'] === params[0]) {
          this.records.delete(key);
        }
      }
    } else {
      throw new Error(`Unhandled native SQL: ${sql}`);
    }
    return { rows: [] };
  }

  get outbox(): Record<string, unknown>[] {
    return [...this.records]
      .filter(([key]) => key.startsWith('outbox:'))
      .map(([, row]) => ({ ...row }));
  }

  get receipts(): Record<string, unknown>[] {
    return [...this.records]
      .filter(([key]) => key.startsWith('sync_receipt:'))
      .map(([, row]) => ({ ...row }));
  }

  pushOutbox(kind: string, payload: unknown, owner = ownerA): number {
    return this.insertOutbox(kind, JSON.stringify(payload), owner);
  }

  private insertOutbox(kind: string, payload: string, owner: string): number {
    const id = this.nextOutboxId++;
    this.records.set(`outbox:${owner}:${id}`, {
      id,
      owner_key: owner,
      kind,
      payload,
      attempts: 0,
      last_error: null,
    });
    return id;
  }

  private restore() {
    if (!this.snapshot) return;
    this.kv.clear();
    for (const [key, value] of this.snapshot.kv) this.kv.set(key, value);
    this.records.clear();
    for (const [key, row] of this.snapshot.records) this.records.set(key, row);
    this.snapshot = null;
  }

  close = jest.fn(() => {
    this.restore();
    this.closed = true;
  });
}

function loadDatabase() {
  const kv = new Map<string, string>();
  const records = new Map<string, Record<string, unknown>>();
  const handles: ControlledNativeDb[] = [];
  mockOpen.mockImplementation(() => {
    const handle = new ControlledNativeDb(kv, records);
    handles.push(handle);
    return handle;
  });
  let getDb!: () => LocalDb;
  jest.isolateModules(() => {
    getDb =
      jest.requireActual<typeof import('../src/data/db')>(
        '../src/data/db',
      ).getDb;
  });
  return { getDb, handles, kv, records };
}

beforeEach(() => {
  mockOpen.mockReset();
  setActiveDataOwner(ownerA);
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('shared native connection transaction isolation', () => {
  it.each(['commit', 'failure', 'owner-change', 'generation-change'] as const)(
    'keeps a second facade write and read outside an awaited owner transaction: %s',
    async outcome => {
      const { getDb } = loadDatabase();
      const dbA = getDb();
      const dbB = getDb();
      expect(dbA).not.toBe(dbB);
      expect(mockOpen).toHaveBeenCalledTimes(1);
      await setKv(dbA, 'owner-value', 'committed-before');
      const entered = deferred();
      const resume = deferred();
      const failure = new Error('injected transaction failure');
      const transaction = withOwnerTransaction(
        dbA,
        captureDataOwnerScope(),
        async ownedDb => {
          await setKv(ownedDb, 'owner-value', 'transaction-value');
          entered.resolve();
          await resume.promise;
          if (outcome === 'failure') throw failure;
        },
      ).catch((error: unknown) => error);
      await entered.promise;
      if (outcome === 'owner-change' || outcome === 'generation-change') {
        setActiveDataOwner(ownerB);
        if (outcome === 'generation-change') setActiveDataOwner(ownerA);
      }
      let acknowledgedBeforeEnd = false;
      let readBeforeEnd = false;
      const write = setKv(dbB, 'independent-value', 'must-survive').then(() => {
        acknowledgedBeforeEnd = true;
      });
      const read = getKv(dbB, 'owner-value').then(value => {
        readBeforeEnd = true;
        return value;
      });
      await nextTurn();
      const whileBlocked = { acknowledgedBeforeEnd, readBeforeEnd };
      resume.resolve();
      const error = await transaction;
      await write;
      const observed = await read;
      if (outcome === 'commit') expect(error).toBeUndefined();
      else if (outcome === 'failure') expect(error).toBe(failure);
      else expect(error).toBeInstanceOf(DataOwnerChangedError);
      expect({
        whileBlocked,
        observed,
        independentValue: await getKv(dbB, 'independent-value'),
        ownerValue: await getKv(dbB, 'owner-value'),
      }).toEqual({
        whileBlocked: {
          acknowledgedBeforeEnd: false,
          readBeforeEnd: false,
        },
        observed:
          outcome === 'commit' ? 'transaction-value' : 'committed-before',
        independentValue: 'must-survive',
        ownerValue:
          outcome === 'commit' ? 'transaction-value' : 'committed-before',
      });
      dbA.close();
    },
  );

  it('persists B capture metadata after an in-flight A transaction rolls back', async () => {
    const { getDb, records } = loadDatabase();
    const dbA = getDb();
    const dbB = getDb();
    const entered = deferred();
    const resume = deferred();
    const transaction = withOwnerTransaction(
      dbA,
      captureDataOwnerScope(),
      async ownedDb => {
        await setKv(ownedDb, 'a-pending', 'discard');
        entered.resolve();
        await resume.promise;
      },
    ).catch((error: unknown) => error);
    await entered.promise;
    setActiveDataOwner(ownerB);
    const write = savePendingCapture(dbB, 'b-capture', 'forehand_drive', clip);
    const read = getPendingCapture(dbB, 'b-capture');
    await nextTurn();
    const recordsWhileBlocked = records.size;
    resume.resolve();
    expect(await transaction).toBeInstanceOf(DataOwnerChangedError);
    await write;
    expect(await read).toMatchObject({
      id: 'b-capture',
      clip,
      evidenceStatus: 'valid',
    });
    expect(recordsWhileBlocked).toBe(0);
    expect([...records.keys()]).toEqual([`local_capture:${ownerB}:b-capture`]);
    expect(await getKv(dbB, 'a-pending')).toBeNull();
    dbA.close();
  });

  it.each(['commit', 'failure'] as const)(
    'reuses one exclusive transaction for nested owner and repository writes: %s',
    async outcome => {
      const { getDb, handles, records } = loadDatabase();
      const dbA = getDb();
      const dbB = getDb();
      const scope = captureDataOwnerScope();
      const entered = deferred();
      const resume = deferred();
      const failure = new Error('nested operation failed');
      const transaction = withOwnerTransaction(dbA, scope, async ownedDb => {
        await saveSession(ownedDb, session);
        await withOwnerTransaction(ownedDb, scope, async nestedDb => {
          await setKv(nestedDb, 'nested-kv', 'inside');
          expect(await getKv(nestedDb, 'nested-kv')).toBe('inside');
          await savePendingCapture(
            nestedDb,
            'nested-capture',
            'forehand_drive',
            clip,
          );
          await finishSession(nestedDb, session.id, {});
        });
        entered.resolve();
        await resume.promise;
        if (outcome === 'failure') throw failure;
      }).catch((error: unknown) => error);
      await entered.promise;
      const independent = setKv(dbB, 'independent', 'outside');
      resume.resolve();
      expect(await transaction).toBe(
        outcome === 'failure' ? failure : undefined,
      );
      await independent;
      expect(await getKv(dbB, 'independent')).toBe('outside');
      expect(await getKv(dbA, 'nested-kv')).toBe(
        outcome === 'commit' ? 'inside' : null,
      );
      expect(
        handles[0]!.calls
          .filter(call => /^(BEGIN IMMEDIATE|COMMIT|ROLLBACK)$/.test(call.sql))
          .map(call => call.sql),
      ).toEqual([
        'BEGIN IMMEDIATE',
        outcome === 'commit' ? 'COMMIT' : 'ROLLBACK',
      ]);
      if (outcome === 'commit') {
        expect(records.size).toBe(4);
        expect(
          [...records.values()].every(row => row['owner_key'] === ownerA),
        ).toBe(true);
        expect(
          records.get(`local_session:${ownerA}:${session.id}`),
        ).toMatchObject({ completed: 1 });
      } else {
        expect(records.size).toBe(0);
      }
      dbA.close();
    },
  );

  it('routes unowned session and purge transaction bodies through their exclusive executor', async () => {
    const { getDb, records, handles } = loadDatabase();
    const dbA = getDb();
    const dbB = getDb();
    await setKv(dbA, `profile:${ownerA}`, 'remove');
    await setKv(dbB, 'device-preference', 'keep');
    await saveSession(dbA, session);
    await finishSession(dbB, session.id, {});
    await purgeOwnerData(dbA, ownerA);
    expect(records.size).toBe(0);
    expect(await getKv(dbA, `profile:${ownerA}`)).toBeNull();
    expect(await getKv(dbB, 'device-preference')).toBe('keep');
    expect(
      handles[0]!.calls.filter(call => call.sql === 'COMMIT'),
    ).toHaveLength(3);
    dbA.close();
  });

  it('waits for an earlier native execute before starting raw reads or an exclusive transaction', async () => {
    const { getDb, handles } = loadDatabase();
    const dbA = getDb();
    const dbB = getDb();
    const entered = deferred();
    const resume = deferred();
    handles[0]!.beforeExecute = async (sql, params) => {
      if (sql.startsWith('INSERT') && params[0] === 'first-raw') {
        entered.resolve();
        await resume.promise;
      }
    };
    const first = setKv(dbA, 'first-raw', 'before');
    await entered.promise;
    const read = getKv(dbB, 'first-raw');
    const transaction = withOwnerTransaction(
      dbB,
      captureDataOwnerScope(),
      ownedDb => setKv(ownedDb, 'later-transaction', 'after'),
    );
    await nextTurn();
    const callsWhileBlocked = handles[0]!.calls.length;
    resume.resolve();
    await first;
    expect(await read).toBe('before');
    await transaction;
    expect(callsWhileBlocked).toBe(1);
    expect(await getKv(dbA, 'later-transaction')).toBe('after');
    dbA.close();
  });

  it.each(['BEGIN IMMEDIATE', 'INSERT OR REPLACE INTO kv'])(
    'retains owner guards across a delayed native %s',
    async statement => {
      const { getDb, handles } = loadDatabase();
      const dbA = getDb();
      const dbB = getDb();
      const entered = deferred();
      const resume = deferred();
      let paused = false;
      handles[0]!.beforeExecute = async sql => {
        if (!paused && sql.startsWith(statement)) {
          paused = true;
          entered.resolve();
          await resume.promise;
        }
      };
      const transaction = withOwnerTransaction(
        dbA,
        captureDataOwnerScope(),
        ownedDb => setKv(ownedDb, 'stale', 'discard'),
      ).catch((error: unknown) => error);
      await entered.promise;
      setActiveDataOwner(ownerB);
      const independent = setKv(dbB, 'independent', 'keep');
      resume.resolve();
      expect(await transaction).toBeInstanceOf(DataOwnerChangedError);
      await independent;
      expect(await getKv(dbB, 'stale')).toBeNull();
      expect(await getKv(dbB, 'independent')).toBe('keep');
      expect(handles[0]!.calls.map(call => call.sql)).toContain('ROLLBACK');
      dbA.close();
    },
  );
});

describe('connection queue failure recovery and lifecycle', () => {
  it('recovers after a rejected standalone execute without dropping the next queued write', async () => {
    const { getDb, handles } = loadDatabase();
    const dbA = getDb();
    const dbB = getDb();
    handles[0]!.failNext = 'INSERT OR REPLACE INTO kv';
    const failed = setKv(dbA, 'failed', 'discard');
    const next = setKv(dbB, 'next', 'keep');
    await expect(failed).rejects.toBe(handles[0]!.failure);
    await next;
    await withOwnerTransaction(dbA, captureDataOwnerScope(), ownedDb =>
      setKv(ownedDb, 'recovered', 'keep'),
    );
    expect(await getKv(dbB, 'failed')).toBeNull();
    expect(await getKv(dbB, 'next')).toBe('keep');
    expect(await getKv(dbB, 'recovered')).toBe('keep');
    dbA.close();
  });

  it.each(['BEGIN IMMEDIATE', 'COMMIT'])(
    'recovers the queue after %s fails',
    async statement => {
      const { getDb, handles } = loadDatabase();
      const dbA = getDb();
      const dbB = getDb();
      handles[0]!.failNext = statement;
      const failed = withOwnerTransaction(
        dbA,
        captureDataOwnerScope(),
        ownedDb => setKv(ownedDb, 'failed', 'discard'),
      );
      const independent = setKv(dbB, 'independent', 'keep');
      const next = withOwnerTransaction(dbB, captureDataOwnerScope(), ownedDb =>
        setKv(ownedDb, 'next', 'keep'),
      );
      await expect(failed).rejects.toBe(handles[0]!.failure);
      await independent;
      await next;
      expect(await getKv(dbB, 'failed')).toBeNull();
      expect(await getKv(dbB, 'independent')).toBe('keep');
      expect(await getKv(dbB, 'next')).toBe('keep');
      expect(handles[0]!.close).not.toHaveBeenCalled();
      dbA.close();
    },
  );

  it('closes a failed rollback, rejects queued old work, and allows a clean reopen', async () => {
    const { getDb, handles } = loadDatabase();
    const dbA = getDb();
    const dbB = getDb();
    const entered = deferred();
    const resume = deferred();
    const failure = new Error('original operation failed');
    const transaction = withOwnerTransaction(
      dbA,
      captureDataOwnerScope(),
      async ownedDb => {
        await setKv(ownedDb, 'rolled-back-on-close', 'discard');
        handles[0]!.failNext = 'ROLLBACK';
        entered.resolve();
        await resume.promise;
        throw failure;
      },
    ).catch((error: unknown) => error);
    await entered.promise;
    const queued = setKv(dbB, 'old-queued', 'must-not-acknowledge').catch(
      (error: unknown) => error,
    );
    resume.resolve();
    expect(await transaction).toBe(failure);
    expect(await queued).toEqual(
      expect.objectContaining({ message: expect.stringContaining('closed') }),
    );
    expect(handles[0]!.close).toHaveBeenCalledTimes(1);
    expect(
      handles[0]!.calls.some(call => call.params[0] === 'old-queued'),
    ).toBe(false);
    const fresh = getDb();
    await setKv(fresh, 'fresh', 'keep');
    expect(await getKv(fresh, 'rolled-back-on-close')).toBeNull();
    expect(await getKv(fresh, 'old-queued')).toBeNull();
    dbA.close();
    dbB.close();
    expect(await getKv(getDb(), 'fresh')).toBe('keep');
    expect(mockOpen).toHaveBeenCalledTimes(2);
    fresh.close();
  });

  it('does not let a stale transaction rollback or facade close invalidate a reopened handle', async () => {
    const { getDb, handles } = loadDatabase();
    const oldA = getDb();
    const oldB = getDb();
    const entered = deferred();
    const resume = deferred();
    const failure = new Error('late old transaction failure');
    const transaction = withOwnerTransaction(
      oldA,
      captureDataOwnerScope(),
      async ownedDb => {
        await setKv(ownedDb, 'old-pending', 'discard');
        entered.resolve();
        await resume.promise;
        throw failure;
      },
    ).catch((error: unknown) => error);
    await entered.promise;
    oldA.close();
    const fresh = getDb();
    await withOwnerTransaction(fresh, captureDataOwnerScope(), ownedDb =>
      setKv(ownedDb, 'fresh', 'keep'),
    );
    resume.resolve();
    expect(await transaction).toBe(failure);
    oldB.close();
    expect(handles[0]!.close).toHaveBeenCalledTimes(1);
    expect(handles[1]!.close).not.toHaveBeenCalled();
    expect(await getKv(getDb(), 'fresh')).toBe('keep');
    expect(await getKv(fresh, 'old-pending')).toBeNull();
    await expect(setKv(oldB, 'stale-facade', 'discard')).rejects.toThrow(
      'closed',
    );
    expect(mockOpen).toHaveBeenCalledTimes(2);
    fresh.close();
  });

  it('invalidates the cached connection even if native close throws', async () => {
    const { getDb, handles } = loadDatabase();
    const old = getDb();
    handles[0]!.close.mockImplementationOnce(() => {
      handles[0]!.closed = true;
      throw new Error('native close failed');
    });
    expect(() => old.close()).toThrow('native close failed');
    const fresh = getDb();
    await setKv(fresh, 'fresh', 'keep');
    expect(() => old.close()).not.toThrow();
    expect(await getKv(getDb(), 'fresh')).toBe('keep');
    expect(mockOpen).toHaveBeenCalledTimes(2);
    expect(handles[0]!.close).toHaveBeenCalledTimes(1);
    fresh.close();
  });

  it('returns the exclusive callback result and expires its executor when the callback ends', async () => {
    const { getDb } = loadDatabase();
    const db = getDb();
    let escaped!: LocalDb;
    expect(db.withExclusive).toBeDefined();
    const result = await db.withExclusive!(async exclusiveDb => {
      escaped = exclusiveDb;
      await setKv(exclusiveDb, 'inside', 'keep');
      return 42;
    });
    expect(result).toBe(42);
    await expect(setKv(escaped, 'escaped', 'discard')).rejects.toThrow(
      'expired',
    );
    await setKv(db, 'after', 'keep');
    expect(await getKv(db, 'inside')).toBe('keep');
    expect(await getKv(db, 'escaped')).toBeNull();
    expect(await getKv(db, 'after')).toBe('keep');
    db.close();
  });
});

describe('sync receipt connection isolation', () => {
  it.each(['commit', 'sync-failure', 'owner-failure'] as const)(
    'isolates a drain receipt transaction from an owner transaction and an unrelated write: %s',
    async outcome => {
      const { getDb, handles } = loadDatabase();
      const syncDb = getDb();
      const ownerDb = getDb();
      const native = handles[0]!;
      native.pushOutbox('shot.sync', syncedShot);
      const otherRow = native.pushOutbox('shot.sync', syncedShot, ownerB);
      const entered = deferred();
      const resume = deferred();
      let paused = false;
      native.beforeExecute = async sql => {
        if (!paused && sql.startsWith('INSERT OR REPLACE INTO sync_receipt')) {
          paused = true;
          entered.resolve();
          await resume.promise;
        }
      };
      const drain = drainOutbox(syncDb, acceptAll);
      await entered.promise;
      if (outcome === 'sync-failure') native.failNext = 'DELETE FROM outbox';
      const ownerFailure = new Error('owner operation failed');
      const ownerTransaction = withOwnerTransaction(
        ownerDb,
        captureDataOwnerScope(),
        async ownedDb => {
          await setKv(ownedDb, 'owner-transaction', 'owner-commit');
          if (outcome === 'owner-failure') throw ownerFailure;
        },
      ).catch((error: unknown) => error);
      const independent = setKv(ownerDb, 'independent', 'must-survive');
      resume.resolve();
      const result = await drain;
      const ownerError = await ownerTransaction;
      await independent;
      expect({
        ownerError,
        result,
        independent: await getKv(ownerDb, 'independent'),
        ownerValue: await getKv(ownerDb, 'owner-transaction'),
        receipts: native.receipts,
        queuedIds: native.outbox.map(row => row['id']),
      }).toEqual({
        ownerError: outcome === 'owner-failure' ? ownerFailure : undefined,
        result:
          outcome === 'sync-failure'
            ? { synced: 0, failed: 1, remaining: 1 }
            : { synced: 1, failed: 0, remaining: 0 },
        independent: 'must-survive',
        ownerValue: outcome === 'owner-failure' ? null : 'owner-commit',
        receipts:
          outcome === 'sync-failure'
            ? []
            : [
                {
                  owner_key: ownerA,
                  kind: 'shot.sync',
                  entity_id: syncedShot.id,
                },
              ],
        queuedIds: outcome === 'sync-failure' ? [1, otherRow] : [otherRow],
      });
      if (outcome === 'sync-failure') {
        expect(native.outbox[0]).toMatchObject({ attempts: 0 });
        expect(await drainOutbox(syncDb, acceptAll)).toEqual({
          synced: 1,
          failed: 0,
          remaining: 0,
        });
        expect(native.receipts).toHaveLength(1);
      }
      syncDb.close();
    },
  );
});

describe('sync entry owner generation', () => {
  it('keeps a newly started signed-out drain a no-op without reading or sending an owner bucket', async () => {
    const { getDb, handles } = loadDatabase();
    const db = getDb();
    const native = handles[0]!;
    native.pushOutbox('shot.sync', syncedShot);
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const syncShots = jest.fn(acceptAll.syncShots);
    expect(await drainOutbox(db, { ...acceptAll, syncShots })).toEqual({
      synced: 0,
      failed: 0,
      remaining: 0,
    });
    expect(syncShots).not.toHaveBeenCalled();
    expect(native.calls).toEqual([]);
    expect(native.outbox).toHaveLength(1);
    db.close();
  });

  it.each(['switch', 'return-to-a', 'purge', 'sign-out'] as const)(
    'does not apply a late shot ACK after %s and allows an idempotent retry on return',
    async change => {
      const { getDb, handles } = loadDatabase();
      const syncDb = getDb();
      const otherDb = getDb();
      const native = handles[0]!;
      native.pushOutbox('shot.sync', syncedShot);
      native.pushOutbox('shot.sync', syncedShot, ownerB);
      const entered = deferred();
      const resume = deferred();
      const syncShots = jest.fn(async (shots: unknown[]) => {
        entered.resolve();
        await resume.promise;
        return acceptAll.syncShots(shots);
      });
      const drain = drainOutbox(syncDb, { ...acceptAll, syncShots }).catch(
        (error: unknown) => error,
      );
      await entered.promise;
      if (change === 'purge') {
        await purgeOwnerData(otherDb, ownerA);
      } else {
        setActiveDataOwner(
          change === 'sign-out' ? SIGNED_OUT_DATA_OWNER : ownerB,
        );
        if (change === 'return-to-a') setActiveDataOwner(ownerA);
      }
      const before = native.outbox;
      const callCount = native.calls.length;
      resume.resolve();
      const result = await drain;
      expect({
        cancelled: result instanceof DataOwnerChangedError,
        outbox: native.outbox,
        receipts: native.receipts,
        mutations: native.calls
          .slice(callCount)
          .filter(call => /^(INSERT|UPDATE|DELETE)/.test(call.sql)),
      }).toEqual({
        cancelled: true,
        outbox: before,
        receipts: [],
        mutations: [],
      });
      setActiveDataOwner(ownerA);
      const retry = await drainOutbox(otherDb, { ...acceptAll, syncShots });
      expect(retry).toEqual({
        synced: change === 'purge' ? 0 : 1,
        failed: 0,
        remaining: 0,
      });
      expect(native.receipts).toHaveLength(change === 'purge' ? 0 : 1);
      expect(syncShots).toHaveBeenCalledTimes(change === 'purge' ? 1 : 2);
      expect(native.outbox.map(row => row['owner_key'])).toEqual([ownerB]);
      syncDb.close();
    },
  );

  it('does not hold the connection during a same-owner network wait or drop newly queued rows', async () => {
    const { getDb, handles } = loadDatabase();
    const syncDb = getDb();
    const ownerDb = getDb();
    const native = handles[0]!;
    native.pushOutbox('shot.sync', syncedShot);
    const entered = deferred();
    const resume = deferred();
    const drain = drainOutbox(syncDb, {
      ...acceptAll,
      syncShots: async shots => {
        entered.resolve();
        await resume.promise;
        return acceptAll.syncShots(shots);
      },
    });
    await entered.promise;
    setActiveDataOwner(ownerA);
    await withOwnerTransaction(
      ownerDb,
      captureDataOwnerScope(),
      async ownedDb => {
        await saveSession(ownedDb, session);
        await withOwnerTransaction(ownedDb, captureDataOwnerScope(), nestedDb =>
          setKv(nestedDb, 'background-preference', 'keep'),
        );
      },
    );
    expect(await getKv(syncDb, 'background-preference')).toBe('keep');
    expect(native.receipts).toEqual([]);
    resume.resolve();
    expect(await drain).toEqual({ synced: 1, failed: 0, remaining: 1 });
    expect(native.outbox).toEqual([
      expect.objectContaining({
        kind: 'session.create',
        owner_key: ownerA,
        attempts: 0,
      }),
    ]);
    expect(await drainOutbox(ownerDb, acceptAll)).toEqual({
      synced: 1,
      failed: 0,
      remaining: 0,
    });
    expect(native.receipts).toHaveLength(1);
    syncDb.close();
  });

  it('cancels an ACK queued before purge but acquired after generation invalidation', async () => {
    const { getDb, handles } = loadDatabase();
    const syncDb = getDb();
    const ownerDb = getDb();
    const native = handles[0]!;
    native.pushOutbox('shot.sync', syncedShot);
    const networkEntered = deferred();
    const ack = deferred();
    const ownerEntered = deferred();
    const releaseOwner = deferred();
    const drain = drainOutbox(syncDb, {
      ...acceptAll,
      syncShots: async shots => {
        networkEntered.resolve();
        await ack.promise;
        return acceptAll.syncShots(shots);
      },
    }).catch((error: unknown) => error);
    await networkEntered.promise;
    const ownerTransaction = withOwnerTransaction(
      ownerDb,
      captureDataOwnerScope(),
      async ownedDb => {
        await setKv(ownedDb, 'old-operation', 'discard');
        ownerEntered.resolve();
        await releaseOwner.promise;
      },
    ).catch((error: unknown) => error);
    await ownerEntered.promise;
    ack.resolve();
    await nextTurn();
    const purge = purgeOwnerData(ownerDb, ownerA).catch(
      (error: unknown) => error,
    );
    releaseOwner.resolve();
    expect(await ownerTransaction).toBeInstanceOf(DataOwnerChangedError);
    expect(await drain).toBeInstanceOf(DataOwnerChangedError);
    expect(await purge).toBeUndefined();
    expect(native.outbox).toEqual([]);
    expect(native.receipts).toEqual([]);
    expect(
      native.calls.some(call =>
        call.sql.startsWith('INSERT OR REPLACE INTO sync_receipt'),
      ),
    ).toBe(false);
    syncDb.close();
  });

  it('checks the entry generation after an awaited outbox read before making any request', async () => {
    const { getDb, handles } = loadDatabase();
    const db = getDb();
    const native = handles[0]!;
    native.pushOutbox('shot.sync', syncedShot);
    const entered = deferred();
    const resume = deferred();
    native.beforeExecute = async sql => {
      if (sql.startsWith('SELECT id, kind, payload')) {
        entered.resolve();
        await resume.promise;
      }
    };
    const syncShots = jest.fn(acceptAll.syncShots);
    const drain = drainOutbox(db, { ...acceptAll, syncShots }).catch(
      (error: unknown) => error,
    );
    await entered.promise;
    setActiveDataOwner(ownerB);
    setActiveDataOwner(ownerA);
    resume.resolve();
    expect(await drain).toBeInstanceOf(DataOwnerChangedError);
    expect(syncShots).not.toHaveBeenCalled();
    expect(native.receipts).toEqual([]);
    expect(native.outbox).toHaveLength(1);
    db.close();
  });
});

describe.each([
  'shot.sync',
  'session.create',
  'session.finalize',
  'evaluation.trial',
])('late %s network outcomes', kind => {
  const outcomes = kind.startsWith('session.')
    ? ['accepted', 'request-rejected', 'offline']
    : ['accepted', 'request-rejected', 'offline', 'item-rejected'];

  it.each(outcomes)(
    'leaves rows and retry history unchanged after A-to-B-to-A: %s',
    async outcome => {
      const { getDb, handles } = loadDatabase();
      const db = getDb();
      const native = handles[0]!;
      const payload =
        kind === 'shot.sync'
          ? syncedShot
          : kind === 'evaluation.trial'
            ? { trialId: 'trial-a' }
            : session;
      native.pushOutbox(kind, payload);
      native.pushOutbox(kind, payload, ownerB);
      const entered = deferred();
      const resume = deferred();
      const waitForResponse = jest.fn(async () => {
        entered.resolve();
        await resume.promise;
        if (outcome === 'request-rejected') {
          throw new ApiError(422, 'test.invalid', 'Rejected request');
        }
        if (outcome === 'offline') {
          throw new TypeError('Network request failed');
        }
      });
      const drain = drainOutbox(db, {
        syncShots: async shots => {
          await waitForResponse();
          return outcome === 'item-rejected'
            ? {
                acceptedIds: [],
                rejected: [
                  {
                    id: syncedShot.id,
                    code: 'shot.invalid',
                    message: 'Rejected item',
                  },
                ],
              }
            : acceptAll.syncShots(shots);
        },
        createSession: async () => waitForResponse(),
        finalizeSession: async () => waitForResponse(),
        uploadEvaluationTrials: async trials => {
          await waitForResponse();
          return outcome === 'item-rejected'
            ? {
                acceptedTrialIds: [],
                rejected: [
                  {
                    trialId: 'trial-a',
                    code: 'evaluation.invalid',
                    message: 'Rejected item',
                  },
                ],
              }
            : acceptAll.uploadEvaluationTrials!(trials);
        },
      }).catch((error: unknown) => error);
      await entered.promise;
      native.pushOutbox('session.create', { ...session, id: 'newer-row' });
      setActiveDataOwner(ownerB);
      setActiveDataOwner(ownerA);
      const before = native.outbox;
      const callCount = native.calls.length;
      resume.resolve();
      expect(await drain).toBeInstanceOf(DataOwnerChangedError);
      expect(native.outbox).toEqual(before);
      expect(native.receipts).toEqual([]);
      expect(native.calls.slice(callCount)).toEqual([]);
      expect(waitForResponse).toHaveBeenCalledTimes(1);
      db.close();
    },
  );
});

describe('sync mutation owner guards inside native awaits', () => {
  it.each([
    { statement: 'BEGIN IMMEDIATE', kind: 'shot.sync', reject: false },
    {
      statement: 'INSERT OR REPLACE INTO sync_receipt',
      kind: 'shot.sync',
      reject: false,
    },
    { statement: 'DELETE FROM outbox', kind: 'shot.sync', reject: false },
    { statement: 'DELETE FROM outbox', kind: 'session.create', reject: false },
    {
      statement: 'DELETE FROM outbox',
      kind: 'session.finalize',
      reject: false,
    },
    {
      statement: 'DELETE FROM outbox',
      kind: 'evaluation.trial',
      reject: false,
    },
    {
      statement: 'UPDATE outbox SET attempts',
      kind: 'shot.sync',
      reject: true,
    },
    {
      statement: 'UPDATE outbox SET last_error',
      kind: 'shot.sync',
      reject: true,
    },
  ])(
    'rolls back $kind at $statement after generation invalidation without collateral rollback',
    async ({ statement, kind, reject }) => {
      const { getDb, handles } = loadDatabase();
      const syncDb = getDb();
      const otherDb = getDb();
      const native = handles[0]!;
      native.pushOutbox(
        kind,
        kind === 'shot.sync' ? syncedShot : { ...session, trialId: 'trial-a' },
      );
      const before = native.outbox;
      const entered = deferred();
      const resume = deferred();
      let paused = false;
      native.beforeExecute = async sql => {
        if (!paused && sql.startsWith(statement)) {
          paused = true;
          entered.resolve();
          await resume.promise;
        }
      };
      const drain = drainOutbox(syncDb, {
        ...acceptAll,
        syncShots: async shots => {
          if (reject) {
            throw new ApiError(
              statement.includes('attempts') ? 422 : 503,
              'test.failed',
              'Failed request',
            );
          }
          return acceptAll.syncShots(shots);
        },
      }).catch((error: unknown) => error);
      await entered.promise;
      setActiveDataOwner(ownerB);
      setActiveDataOwner(ownerA);
      const callCount = native.calls.length;
      const independent = setKv(otherDb, 'independent-after-switch', 'keep');
      resume.resolve();
      expect(await drain).toBeInstanceOf(DataOwnerChangedError);
      await independent;
      expect(native.outbox).toEqual(before);
      expect(native.receipts).toEqual([]);
      expect(await getKv(otherDb, 'independent-after-switch')).toBe('keep');
      expect(
        native.calls
          .slice(callCount)
          .filter(call => /outbox|sync_receipt/.test(call.sql)),
      ).toEqual([]);
      expect(native.calls.map(call => call.sql)).toContain('ROLLBACK');
      syncDb.close();
    },
  );

  it('retains rollback and retry semantics with a LocalDb double lacking withExclusive', async () => {
    const { getDb, handles } = loadDatabase();
    const facade = getDb();
    const native = handles[0]!;
    const legacyDb: LocalDb = {
      execute: (sql, params) => native.execute(sql, params),
      close: () => native.close(),
    };
    native.pushOutbox('shot.sync', syncedShot);
    const before = native.outbox;
    const entered = deferred();
    const resume = deferred();
    let paused = false;
    native.beforeExecute = async sql => {
      if (!paused && sql.startsWith('INSERT OR REPLACE INTO sync_receipt')) {
        paused = true;
        entered.resolve();
        await resume.promise;
      }
    };
    const drain = drainOutbox(legacyDb, acceptAll).catch(
      (error: unknown) => error,
    );
    await entered.promise;
    setActiveDataOwner(ownerB);
    setActiveDataOwner(ownerA);
    resume.resolve();
    expect(await drain).toBeInstanceOf(DataOwnerChangedError);
    expect(native.outbox).toEqual(before);
    expect(native.receipts).toEqual([]);
    expect(await drainOutbox(legacyDb, acceptAll)).toEqual({
      synced: 1,
      failed: 0,
      remaining: 0,
    });
    expect(native.receipts).toHaveLength(1);
    facade.close();
  });

  it('closes an unusable sync transaction after rollback failure and retries on a fresh handle', async () => {
    const { getDb, handles } = loadDatabase();
    const old = getDb();
    const native = handles[0]!;
    native.pushOutbox('shot.sync', syncedShot);
    const before = native.outbox;
    native.beforeExecute = async sql => {
      if (sql.startsWith('DELETE FROM outbox')) {
        native.failNext = 'ROLLBACK';
        throw native.failure;
      }
    };
    await expect(drainOutbox(old, acceptAll)).rejects.toThrow('closed');
    expect(native.close).toHaveBeenCalledTimes(1);
    expect(native.outbox).toEqual(before);
    expect(native.receipts).toEqual([]);
    const fresh = getDb();
    expect(await drainOutbox(fresh, acceptAll)).toEqual({
      synced: 1,
      failed: 0,
      remaining: 0,
    });
    old.close();
    expect(mockOpen).toHaveBeenCalledTimes(2);
    expect(handles[1]!.receipts).toHaveLength(1);
    expect(handles[1]!.outbox).toEqual([]);
    fresh.close();
  });
});
