import { open, type DB } from '@op-engineering/op-sqlite';
import type { ShotAnalysis } from '@pickle/shared-types';
import { getDb, type LocalDb } from '../src/data/db';
import {
  finishSession,
  purgeOwnerData,
  saveAnalysis,
  saveSession,
} from '../src/data/repository';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';

jest.mock('@op-engineering/op-sqlite', () => ({ open: jest.fn() }));

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const mockExecute = jest.fn<
  Promise<{ rows?: Record<string, unknown>[] }>,
  [string, unknown[]?]
>();
const mockClose = jest.fn();

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

const legacyAnalysis: ShotAnalysis = {
  id: 'legacy-analysis',
  sessionId: null,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-09-05T12:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.8,
  analysisConfidence: 0.9,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: 'software-test',
    modelBundleVersion: 'software-test',
    poseModelVersion: 'software-test',
    paddleModelVersion: 'software-test',
    strokeDetectorVersion: 'software-test',
    phaseModelVersion: 'software-test',
    scoringModelVersion: 'software-test',
    shotConfigVersion: 'software-test',
  },
  source: 'real',
};

describe('shared native database queue and scoped executors', () => {
  let db: LocalDb;

  beforeEach(() => {
    setActiveDataOwner(owner);
    mockExecute.mockReset();
    mockExecute.mockResolvedValue({ rows: [] });
    mockClose.mockReset();
    jest.mocked(open).mockClear();
    jest.mocked(open).mockReturnValue({
      executeSync: () => ({ rows: [] }),
      execute: mockExecute,
      close: mockClose,
    } as unknown as DB);
    db = getDb();
  });

  afterEach(() => {
    db.close();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  it('shares one queue across facades and keeps outside SQL out of an exclusive transaction', async () => {
    const other = getDb();
    expect(other).not.toBe(db);
    expect(open).toHaveBeenCalledTimes(1);
    const entered = deferred();
    const release = deferred();
    const before = other.execute('before');
    const transaction = db.withExclusive!(async executor => {
      expect(executor).not.toBe(db);
      await executor.execute('BEGIN IMMEDIATE');
      entered.resolve();
      await release.promise;
      await executor.execute('inside');
      await executor.execute('COMMIT');
      return 42;
    });
    await entered.promise;
    const after = other.execute('after');
    const nextTransaction = other.withExclusive!(executor =>
      executor.execute('next transaction'),
    );
    await Promise.resolve();
    expect(mockExecute.mock.calls.map(([sql]) => sql)).toEqual([
      'before',
      'BEGIN IMMEDIATE',
    ]);
    release.resolve();
    await before;
    await expect(transaction).resolves.toBe(42);
    await after;
    await nextTransaction;
    expect(mockExecute.mock.calls.map(([sql]) => sql)).toEqual([
      'before',
      'BEGIN IMMEDIATE',
      'inside',
      'COMMIT',
      'after',
      'next transaction',
    ]);
  });

  it('does not start an exclusive callback before an earlier native statement completes', async () => {
    const entered = deferred();
    const release = deferred();
    mockExecute.mockImplementation(async sql => {
      if (sql === 'slow statement') {
        entered.resolve();
        await release.promise;
      }
      return { rows: [] };
    });
    const first = db.execute('slow statement');
    await entered.promise;
    const callback = jest.fn(async (executor: LocalDb) =>
      executor.execute('exclusive statement'),
    );
    const transaction = getDb().withExclusive!(callback);
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([first, transaction]);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls.map(([sql]) => sql)).toEqual([
      'slow statement',
      'exclusive statement',
    ]);
  });

  it.each([false, true])(
    'expires a leaked callback executor after completion (failure: %s)',
    async fails => {
      let leaked: LocalDb | undefined;
      const failure = new Error('software callback failure');
      const transaction = db.withExclusive!(async executor => {
        leaked = executor;
        await executor.execute('inside');
        if (fails) throw failure;
        return 'completed';
      });
      if (fails) await expect(transaction).rejects.toBe(failure);
      else await expect(transaction).resolves.toBe('completed');
      await expect(leaked!.execute('escaped SQL')).rejects.toThrow(
        'executor has expired',
      );
      expect(() => leaked!.close()).toThrow('executor has expired');
      await getDb().execute('next valid SQL');
      expect(mockExecute.mock.calls.map(([sql]) => sql)).toEqual([
        'inside',
        'next valid SQL',
      ]);
      expect(mockClose).not.toHaveBeenCalled();
    },
  );

  it('does not release the queue while an unawaited native statement is still running', async () => {
    const started = deferred();
    const release = deferred();
    mockExecute.mockImplementation(async sql => {
      if (sql === 'unawaited native work') {
        started.resolve();
        await release.promise;
      }
      return { rows: [] };
    });
    const transaction = db.withExclusive!(async executor => {
      void executor.execute('unawaited native work');
    });
    await started.promise;
    const outside = getDb().execute('outside');
    await Promise.resolve();
    expect(mockExecute.mock.calls.map(([sql]) => sql)).toEqual([
      'unawaited native work',
    ]);
    release.resolve();
    await Promise.all([transaction, outside]);
    expect(mockExecute.mock.calls.map(([sql]) => sql)).toEqual([
      'unawaited native work',
      'outside',
    ]);
  });

  it('recovers the shared queue after a rejected ordinary statement', async () => {
    const failure = new Error('software SQL failure');
    mockExecute.mockRejectedValueOnce(failure);
    const broken = db.execute('broken');
    const good = getDb().execute('good');
    await expect(broken).rejects.toBe(failure);
    await expect(good).resolves.toEqual({ rows: [] });
    expect(mockExecute.mock.calls.map(([sql]) => sql)).toEqual([
      'broken',
      'good',
    ]);
  });

  it('protects an active connection from close and invalidates old facades after a real close', async () => {
    const other = getDb();
    const entered = deferred();
    const release = deferred();
    const transaction = db.withExclusive!(async executor => {
      expect(() => executor.close()).toThrow('cannot close the local database');
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    expect(() => other.close()).toThrow('while work is pending');
    expect(mockClose).not.toHaveBeenCalled();
    release.resolve();
    await transaction;
    db.close();
    await expect(other.execute('closed facade')).rejects.toThrow(
      'database is closed',
    );
    const previous = db;
    db = getDb();
    previous.close();
    getDb();
    expect(open).toHaveBeenCalledTimes(2);
    await expect(db.execute('new connection')).resolves.toEqual({ rows: [] });
  });

  it('snapshots parameters before waiting in the queue and normalizes absent native rows', async () => {
    const entered = deferred();
    const release = deferred();
    const blocker = db.withExclusive!(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    mockExecute.mockResolvedValue({});
    const values = ['original-owner'];
    const query = getDb().execute('queued query', values);
    values[0] = 'different-owner';
    release.resolve();
    await blocker;
    await expect(query).resolves.toEqual({ rows: [] });
    expect(mockExecute).toHaveBeenCalledWith('queued query', [
      'original-owner',
    ]);
  });

  it('runs every existing repository transaction through the callback executor without deadlock', async () => {
    const other = getDb();
    await Promise.all([
      saveAnalysis(db, legacyAnalysis, 'software-permit'),
      saveSession(other, {
        id: 'software-session',
        mode: 'practice_set',
        shotType: null,
        focusCheckpoint: null,
        startedAt: '2026-09-05T12:00:00.000Z',
      }),
      finishSession(db, 'software-session', { software: true }),
      purgeOwnerData(other, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    ]);
    let depth = 0;
    let commits = 0;
    for (const [sql] of mockExecute.mock.calls) {
      if (sql === 'BEGIN IMMEDIATE') {
        expect(depth).toBe(0);
        depth += 1;
      } else if (sql === 'COMMIT') {
        expect(depth).toBe(1);
        depth -= 1;
        commits += 1;
      } else {
        expect(depth).toBe(1);
      }
    }
    expect(depth).toBe(0);
    expect(commits).toBe(4);
    expect(mockExecute.mock.calls.map(([sql]) => sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('INSERT OR REPLACE INTO local_shot'),
        expect.stringContaining('INSERT OR REPLACE INTO local_session'),
        expect.stringContaining('UPDATE local_session'),
        expect.stringContaining('DELETE FROM local_motion_analysis'),
      ]),
    );
  });

  it('finishes a legacy transaction rollback before allowing the next facade to run', async () => {
    const failure = new Error('software outbox failure');
    mockExecute.mockImplementation(async sql => {
      if (sql.includes('INSERT INTO outbox')) throw failure;
      return { rows: [] };
    });
    const save = saveAnalysis(db, legacyAnalysis, 'software-permit');
    const outside = getDb().execute('outside');
    await expect(save).rejects.toBe(failure);
    await outside;
    expect(mockExecute.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN IMMEDIATE',
      expect.stringContaining('INSERT OR REPLACE INTO local_shot'),
      expect.stringContaining('INSERT INTO outbox'),
      'ROLLBACK',
      'outside',
    ]);
  });
});
