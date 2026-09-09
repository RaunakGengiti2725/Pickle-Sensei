/**
 * INT-sync-outbox-persistence adversary — commit boundaries of the outbox.
 *
 * Every attack runs against a real SQLite database (node:sqlite) and the
 * production drainOutbox, injecting faults exactly at the durable steps a
 * process death or an account switch can interrupt.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import { drainOutbox, type SyncTransport } from '../../src/data/sync';
import { getShotOutboxStatus } from '../../src/data/repository';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  createSqliteTestDb,
  closeSqliteTestDatabases,
} from '../../testSupport/sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const session = {
  id: id(1),
  mode: 'practice_set',
  shotType: 'forehand_drive',
  focusCheckpoint: 'contact_position',
  startedAt: '2026-09-07T12:00:00.000Z',
};
const temporaryDirectories: string[] = [];

function analysis(
  n: number,
  sessionId: string | null = null,
): ShotAnalysis & { analysisPermitId: string } {
  return {
    id: id(n),
    analysisPermitId: id(n + 10000),
    sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-07T12:00:01.000Z',
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    source: 'real',
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
  };
}

function ids(shots: unknown[]): string[] {
  return shots.map(shot => {
    if (
      !shot ||
      typeof shot !== 'object' ||
      !('id' in shot) ||
      typeof shot.id !== 'string'
    )
      throw new Error('Production sync emitted an invalid shot identifier');
    return shot.id;
  });
}

function fixture(path?: string) {
  const store = createSqliteTestDb(path);
  const push = (kind: string, payload: unknown, owner = OWNER) => {
    store.native
      .prepare('INSERT INTO outbox (owner_key, kind, payload) VALUES (?, ?, ?)')
      .run(owner, kind, JSON.stringify(payload));
  };
  const rows = (owner = OWNER) =>
    store.native
      .prepare('SELECT * FROM outbox WHERE owner_key = ? ORDER BY id')
      .all(owner);
  const receipts = (owner = OWNER) =>
    store.native
      .prepare(
        'SELECT entity_id FROM sync_receipt WHERE owner_key = ? ORDER BY entity_id',
      )
      .all(owner)
      .map(row => row.entity_id);
  const transport: SyncTransport = {
    syncShots: jest.fn(async shots => ({
      acceptedIds: ids(shots),
      rejected: [],
    })),
    createSession: jest.fn(async () => {}),
    finalizeSession: jest.fn(async () => {}),
  };
  const sentBatches = () =>
    jest
      .mocked(transport.syncShots)
      .mock.calls.map(call => ids(call[0] as unknown[]));
  return { store, push, rows, receipts, transport, sentBatches };
}

beforeEach(() => setActiveDataOwner(OWNER));
afterEach(() => {
  closeSqliteTestDatabases();
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('ADV-1 receipt commit fails in the MIDDLE of an accepted batch', () => {
  it('keeps every not-yet-receipted accepted shot durable and replays exactly those', async () => {
    const { store, push, rows, receipts, transport, sentBatches } = fixture();
    push('shot.sync', analysis(100));
    push('shot.sync', analysis(101));
    push('shot.sync', analysis(102));
    // The first receipt commits; the second receipt transaction dies before
    // COMMIT (process death between the server ack and local durability).
    let receiptWrites = 0;
    store.observeStatements(call => {
      if (call.sql.includes('INTO sync_receipt')) {
        receiptWrites += 1;
        if (receiptWrites === 2) {
          store.observeStatements(null);
          store.failCommitOnce('before', 'INTO sync_receipt');
        }
      }
    });
    const first = await drainOutbox(store.db, transport);
    expect(sentBatches()).toEqual([[id(100), id(101), id(102)]]);
    expect(receipts()).toEqual([id(100)]);
    expect(rows().map(row => row.kind)).toEqual(['shot.sync', 'shot.sync']);
    expect(rows().map(row => row.attempts)).toEqual([0, 0]);
    expect(first.remaining).toBe(2);
    // Relaunch: only the two shots without a durable receipt go out again.
    await drainOutbox(store.db, transport);
    expect(sentBatches()[1]).toEqual([id(101), id(102)]);
    expect(receipts()).toEqual([id(100), id(101), id(102)]);
    expect(rows()).toEqual([]);
    expect(store.count('sync_receipt', OWNER)).toBe(3);
  });

  it('a lost commit acknowledgement mid-batch never double-counts or drops a receipt', async () => {
    const { store, push, rows, receipts, transport, sentBatches } = fixture();
    push('shot.sync', analysis(100));
    push('shot.sync', analysis(101));
    push('shot.sync', analysis(102));
    let receiptWrites = 0;
    store.observeStatements(call => {
      if (call.sql.includes('INTO sync_receipt')) {
        receiptWrites += 1;
        if (receiptWrites === 2) {
          store.observeStatements(null);
          store.failCommitOnce('after', 'INTO sync_receipt');
        }
      }
    });
    await drainOutbox(store.db, transport);
    // SQLite did commit shot 101; the driver merely lost the acknowledgement.
    expect(receipts()).toEqual([id(100), id(101)]);
    expect(
      rows().map(row => String(JSON.parse(String(row.payload)).id)),
    ).toEqual([id(102)]);
    await drainOutbox(store.db, transport);
    expect(sentBatches()[1]).toEqual([id(102)]);
    expect(receipts()).toEqual([id(100), id(101), id(102)]);
    expect(rows()).toEqual([]);
  });
});

describe('ADV-2 process death between parent session acceptance and its local delete', () => {
  it('holds the children without burning attempts and replays the parent first on relaunch', async () => {
    const { store, push, rows, receipts, transport, sentBatches } = fixture();
    push('session.create', session);
    push('shot.sync', analysis(100, session.id));
    push('shot.sync', analysis(101, session.id));
    push('session.finalize', { id: session.id });
    // Server accepted session.create; the local DELETE never lands.
    store.failStatementOnce('DELETE FROM outbox');
    const first = await drainOutbox(store.db, transport);
    expect(transport.createSession).toHaveBeenCalledTimes(1);
    expect(transport.syncShots).not.toHaveBeenCalled();
    expect(transport.finalizeSession).not.toHaveBeenCalled();
    expect(first.synced).toBe(0);
    expect(rows()).toHaveLength(4);
    expect(rows().every(row => row.attempts === 0)).toBe(true);
    expect(rows().every(row => row.repair_reason === null)).toBe(true);
    // Relaunch: idempotent parent replay, then children, then finalize.
    await drainOutbox(store.db, transport);
    expect(transport.createSession).toHaveBeenCalledTimes(2);
    expect(sentBatches()).toEqual([[id(100), id(101)]]);
    expect(transport.finalizeSession).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([]);
    expect(receipts()).toEqual([id(100), id(101)]);
  });
});

describe('ADV-3 replay after restart from the on-disk database', () => {
  it('re-sends the byte-identical saved payload once and ends with exactly one receipt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pickle-adv-replay-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'product.sqlite');
    const before = fixture(path);
    before.push('shot.sync', analysis(100));
    const savedPayload = before.rows()[0]?.payload;
    before.store.failCommitOnce('before', 'INTO sync_receipt');
    await drainOutbox(before.store.db, before.transport);
    expect(before.receipts()).toEqual([]);
    expect(before.rows()).toHaveLength(1);
    before.store.close();

    const after = fixture(path);
    expect(after.rows()[0]?.payload).toBe(savedPayload);
    expect(await getShotOutboxStatus(after.store.db, id(100))).toMatchObject({
      state: 'queued',
      attempts: 0,
    });
    await drainOutbox(after.store.db, after.transport);
    const firstSent = jest.mocked(before.transport.syncShots).mock
      .calls[0]?.[0];
    const replaySent = jest.mocked(after.transport.syncShots).mock
      .calls[0]?.[0];
    expect(JSON.stringify(replaySent)).toBe(JSON.stringify(firstSent));
    expect(after.receipts()).toEqual([id(100)]);
    expect(after.rows()).toEqual([]);
    expect(after.store.count('sync_receipt', OWNER)).toBe(1);
  });
});

describe('ADV-4 account switch between the receipt INSERT and the outbox DELETE', () => {
  it('rolls the half-written receipt back and touches nothing of the new owner', async () => {
    const { store, push, rows, receipts, transport } = fixture();
    push('shot.sync', analysis(100));
    push('shot.sync', analysis(200), OTHER_OWNER);
    store.observeStatements(call => {
      if (call.sql.includes('INTO sync_receipt')) {
        store.observeStatements(null);
        setActiveDataOwner(OTHER_OWNER);
      }
    });
    await expect(drainOutbox(store.db, transport)).rejects.toThrow(
      'account changed',
    );
    expect(receipts(OWNER)).toEqual([]);
    expect(receipts(OTHER_OWNER)).toEqual([]);
    expect(rows(OWNER)).toHaveLength(1);
    expect(rows(OWNER)[0]?.attempts).toBe(0);
    expect(rows(OTHER_OWNER)).toHaveLength(1);
    expect(rows(OTHER_OWNER)[0]?.attempts).toBe(0);
    // No transaction may still be open after the fenced rollback.
    expect(() => store.native.exec('BEGIN IMMEDIATE; ROLLBACK;')).not.toThrow();
  });

  it('an A→B switch during the request leaves the ack unapplied and B drains only B', async () => {
    const { store, push, rows, receipts, transport } = fixture();
    push('shot.sync', analysis(100));
    push('shot.sync', analysis(200), OTHER_OWNER);
    let finish!: (value: { acceptedIds: string[]; rejected: [] }) => void;
    const started = new Promise<void>(resolve => {
      transport.syncShots = jest.fn(
        () =>
          new Promise(done => {
            finish = done;
            resolve();
          }),
      );
    });
    const drainA = drainOutbox(store.db, transport);
    await started;
    setActiveDataOwner(OTHER_OWNER);
    finish({ acceptedIds: [id(100)], rejected: [] });
    await expect(drainA).rejects.toThrow('account changed');
    expect(receipts(OWNER)).toEqual([]);
    expect(rows(OWNER)).toHaveLength(1);
    transport.syncShots = jest.fn(async shots => ({
      acceptedIds: ids(shots),
      rejected: [],
    }));
    await drainOutbox(store.db, transport);
    expect(
      jest
        .mocked(transport.syncShots)
        .mock.calls.map(c => ids(c[0] as unknown[])),
    ).toEqual([[id(200)]]);
    expect(receipts(OTHER_OWNER)).toEqual([id(200)]);
    expect(receipts(OWNER)).toEqual([]);
    expect(rows(OWNER)).toHaveLength(1);
  });
});
