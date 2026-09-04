/**
 * Structural audit (mobile-data-sync, pass 1) — concurrency between the
 * outbox drain's receipt transaction (sync.ts:224-243) and repository
 * `inTransaction` writers (repository.ts:76-90) on ONE SQLite connection.
 *
 * Run: `cd apps/mobile && NODE_OPTIONS=--experimental-sqlite npx jest
 *       __tests__/audit/structural2/transactionInterleavingRealSql.test.ts`
 *
 * Both sides issue bare `BEGIN IMMEDIATE … COMMIT` statement sequences over
 * the shared async handle; nothing serialises them (op-sqlite's
 * `db.transaction()` lock is not used). The harness yields once per statement
 * like the native bridge does, so a writer that starts while the drain's
 * transaction is open observes SQLite's nested-transaction error.
 */
/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { setActiveDataOwner } from '../../../src/data/accountScope';
import type { LocalDb } from '../../../src/data/db';
import {
  hasShotSyncReceipt,
  saveAnalysis,
  saveSession,
} from '../../../src/data/repository';
import { drainOutbox } from '../../../src/data/sync';
import {
  AUDIT_OWNER_A,
  AUDIT_PERMIT_ID,
  auditUuid,
  recordingTransport,
  scoredAnalysis,
} from '../../../test-support/audit/fixtures';
import {
  openRealSqliteLocalDb,
  opSqliteHandleFor,
  type RealSqliteLocalDb,
} from '../../../test-support/audit/realSqliteLocalDb';

let mockRaw: DatabaseSync | null = null;
const mockOpen = jest.fn(() => {
  if (!mockRaw) throw new Error('test did not provide a database');
  return opSqliteHandleFor(mockRaw);
});
jest.mock('@op-engineering/op-sqlite', () => ({ open: mockOpen }));

function migratedDb(): RealSqliteLocalDb {
  mockRaw = new DatabaseSync(':memory:');
  const loaded: { getDb?: () => LocalDb } = {};
  jest.isolateModules(() => {
    loaded.getDb = jest.requireActual<typeof import('../../../src/data/db')>(
      '../../../src/data/db',
    ).getDb;
  });
  if (!loaded.getDb) throw new Error('db module did not load');
  loaded.getDb();
  return openRealSqliteLocalDb(mockRaw);
}

/** Wraps the handle so a concurrent writer starts the moment the drain opens
 * its receipt transaction — the same interleaving a `saveAnalysis` /
 * `commitPracticeSet` landing during an in-flight drain produces on device. */
function interleavingDb(
  inner: RealSqliteLocalDb,
  onDrainBegin: (db: LocalDb) => Promise<void>,
): { db: LocalDb; concurrent: () => Promise<void> | null } {
  let concurrent: Promise<void> | null = null;
  const db: LocalDb = {
    async execute(sql, params) {
      const result = await inner.execute(sql, params);
      if (sql === 'BEGIN IMMEDIATE' && concurrent === null) {
        // Fired from inside the drain's BEGIN: the writer's own statements
        // are now queued behind the drain's next statement.
        concurrent = onDrainBegin(db);
        concurrent.catch(() => undefined);
      }
      return result;
    },
    close: () => inner.close(),
  };
  return { db, concurrent: () => concurrent };
}

let inner: RealSqliteLocalDb;

beforeEach(() => {
  setActiveDataOwner(AUDIT_OWNER_A);
  inner = migratedDb();
});

afterEach(() => {
  inner.close();
  mockRaw = null;
  setActiveDataOwner('signed-out');
});

describe('receipt transaction vs repository writers on one connection', () => {
  it('saveAnalysis started while the drain commits a receipt must still persist the scored rating', async () => {
    await saveAnalysis(
      inner,
      scoredAnalysis({ id: auditUuid(1) }),
      AUDIT_PERMIT_ID,
    );
    const newShot = scoredAnalysis({ id: auditUuid(2) });
    let saveError: unknown = null;
    const { db, concurrent } = interleavingDb(inner, async handle => {
      try {
        await saveAnalysis(handle, newShot, AUDIT_PERMIT_ID);
      } catch (error) {
        saveError = error;
        throw error;
      }
    });
    const { transport } = recordingTransport({
      syncShots: async shots => ({
        acceptedIds: shots.map(shot => String(shot['id'])),
        rejected: [],
      }),
    });

    const drain = await drainOutbox(db, transport);
    await concurrent()?.catch(() => undefined);

    expect({
      drain,
      receiptForFirstShot: await hasShotSyncReceipt(inner, auditUuid(1)),
      saveError: saveError === null ? null : String(saveError),
      newShotRows: inner.query(`SELECT id FROM local_shot WHERE id = ?`, [
        newShot.id,
      ]),
      newShotQueued: inner.query(
        `SELECT count(*) AS n FROM outbox WHERE json_extract(payload, '$.id') = ?`,
        [newShot.id],
      ),
    }).toEqual({
      drain: { synced: 1, failed: 0, remaining: 1 },
      receiptForFirstShot: true,
      saveError: null,
      newShotRows: [{ id: newShot.id }],
      newShotQueued: [{ n: 1 }],
    });
  });

  it('saveSession (commitPracticeSet) started while the drain commits a receipt must still queue session.create', async () => {
    await saveAnalysis(
      inner,
      scoredAnalysis({ id: auditUuid(1) }),
      AUDIT_PERMIT_ID,
    );
    const sessionId = 'dddddddd-bbbb-4ccc-8ddd-000000000002';
    let saveError: unknown = null;
    const { db, concurrent } = interleavingDb(inner, async handle => {
      try {
        await saveSession(handle, {
          id: sessionId,
          mode: 'practice_set',
          shotType: 'forehand_drive',
          focusCheckpoint: null,
          startedAt: '2026-08-26T18:00:00.000Z',
        });
      } catch (error) {
        saveError = error;
        throw error;
      }
    });
    const { transport } = recordingTransport({
      syncShots: async shots => ({
        acceptedIds: shots.map(shot => String(shot['id'])),
        rejected: [],
      }),
    });

    await drainOutbox(db, transport);
    await concurrent()?.catch(() => undefined);

    expect({
      saveError: saveError === null ? null : String(saveError),
      sessionRows: inner.query(`SELECT id FROM local_session WHERE id = ?`, [
        sessionId,
      ]),
      sessionCreateQueued: inner.query(
        `SELECT count(*) AS n FROM outbox WHERE kind = 'session.create'`,
      ),
    }).toEqual({
      saveError: null,
      sessionRows: [{ id: sessionId }],
      sessionCreateQueued: [{ n: 1 }],
    });
  });

  it('sequential writers on the same connection never collide (control)', async () => {
    await saveAnalysis(
      inner,
      scoredAnalysis({ id: auditUuid(1) }),
      AUDIT_PERMIT_ID,
    );
    const { transport } = recordingTransport({
      syncShots: async shots => ({
        acceptedIds: shots.map(shot => String(shot['id'])),
        rejected: [],
      }),
    });
    await drainOutbox(inner, transport);
    await saveAnalysis(
      inner,
      scoredAnalysis({ id: auditUuid(2) }),
      AUDIT_PERMIT_ID,
    );
    expect(inner.query(`SELECT count(*) AS n FROM local_shot`)).toEqual([
      { n: 2 },
    ]);
    expect(inner.query(`SELECT count(*) AS n FROM outbox`)).toEqual([{ n: 1 }]);
  });
});
