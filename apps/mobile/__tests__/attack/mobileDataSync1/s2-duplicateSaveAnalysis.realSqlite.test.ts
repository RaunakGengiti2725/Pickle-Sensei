/**
 * ATTACK S2 — saveAnalysis twice with the SAME analysis id.
 *
 * Runs against the real production schema on node:sqlite (see
 * testing/attack/nodeSqliteOpAdapter.ts). saveAnalysis is
 * `INSERT OR REPLACE INTO local_shot` + plain `INSERT INTO outbox`, so two
 * calls must yield ONE local_shot row and TWO shot.sync outbox rows. The
 * drain then sends both to a replay-accepting server emulator
 * (parseSyncShot UUID gates + apply_synced_shot "already owned → accepted").
 *
 * Expected durable end state: exactly one sync_receipt, zero outbox rows.
 */
import type { LocalDb } from '../../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
} from '../../../src/data/repository';
import { drainOutbox } from '../../../src/data/sync';
import {
  OWNER_A,
  PERMIT_ID,
  SHOT_ID,
  createServerEmulator,
  realAnalysis,
} from '../../../testing/attack/mobileDataSyncFixtures';
import { createOpSqliteModuleMock } from '../../../testing/attack/nodeSqliteOpAdapter';

const mockOpSqlite = createOpSqliteModuleMock();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockOpSqlite.open(options),
}));

function loadRealGetDb(): () => LocalDb {
  let getDb: (() => LocalDb) | null = null;
  jest.isolateModules(() => {
    getDb = jest.requireActual<typeof import('../../../src/data/db')>(
      '../../../src/data/db',
    ).getDb;
  });
  if (!getDb) throw new Error('db module did not load');
  return getDb;
}

const SECOND_PERMIT_ID = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee';

async function outboxRows(db: LocalDb) {
  const { rows } = await db.execute(
    `SELECT id, owner_key, kind, attempts, last_error,
            json_extract(payload, '$.id') AS shot_id,
            json_extract(payload, '$.analysisPermitId') AS permit_id
       FROM outbox ORDER BY id ASC`,
  );
  return rows;
}

async function receiptRows(db: LocalDb) {
  const { rows } = await db.execute(
    'SELECT owner_key, kind, entity_id FROM sync_receipt ORDER BY entity_id',
  );
  return rows;
}

describe('ATTACK S2 — duplicate saveAnalysis for one analysis id [real sqlite]', () => {
  let db: LocalDb;

  beforeEach(() => {
    db = loadRealGetDb()();
    setActiveDataOwner(OWNER_A);
  });

  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    db.close();
  });

  it('two saves → ONE local_shot row and TWO shot.sync outbox rows for the same shot id', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    await saveAnalysis(db, realAnalysis, PERMIT_ID);

    const { rows: shots } = await db.execute(
      'SELECT owner_key, id FROM local_shot',
    );
    expect(shots).toEqual([{ owner_key: OWNER_A, id: SHOT_ID }]);

    const outbox = await outboxRows(db);
    expect(outbox).toHaveLength(2);
    expect(outbox.map(r => r['kind'])).toEqual(['shot.sync', 'shot.sync']);
    expect(outbox.map(r => r['shot_id'])).toEqual([SHOT_ID, SHOT_ID]);
    expect(outbox.map(r => r['attempts'])).toEqual([0, 0]);
    expect(await getShotOutboxStatus(db, SHOT_ID)).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
  });

  it('one drain against a replay-accepting server sends BOTH copies in one batch, writes ONE receipt and deletes BOTH rows', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    const server = createServerEmulator();

    const result = await drainOutbox(db, server);

    // The client does not de-duplicate within a batch: the server saw the
    // same UUID twice in a single request.
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.shots.map(s => s.id)).toEqual([
      SHOT_ID,
      SHOT_ID,
    ]);
    // Server-side: the batched replay lookup ran BEFORE either copy was
    // written, so both copies reach apply_synced_shot; the second returns
    // 'accepted' through its "already owns the row" rule without a write.
    expect(server.rpcCalls).toEqual([SHOT_ID, SHOT_ID]);
    expect(server.inserted).toEqual([SHOT_ID]);

    expect(await receiptRows(db)).toEqual([
      { owner_key: OWNER_A, kind: 'shot.sync', entity_id: SHOT_ID },
    ]);
    expect(await outboxRows(db)).toEqual([]);
    expect(result).toEqual({ synced: 2, failed: 0, remaining: 0 });
    expect(await hasShotSyncReceipt(db, SHOT_ID)).toBe(true);
    expect(await getShotOutboxStatus(db, SHOT_ID)).toEqual({ state: 'absent' });
  });

  it('a second save under a DIFFERENT permit id queues a second row that the server acknowledges as a replay (second permit never consumed)', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    await saveAnalysis(db, realAnalysis, SECOND_PERMIT_ID);
    const before = await outboxRows(db);
    expect(before.map(r => r['permit_id'])).toEqual([
      PERMIT_ID,
      SECOND_PERMIT_ID,
    ]);

    const server = createServerEmulator();
    await drainOutbox(db, server);

    expect(server.inserted).toEqual([SHOT_ID]);
    expect(server.requests[0]!.shots.map(s => s.analysisPermitId)).toEqual([
      PERMIT_ID,
      SECOND_PERMIT_ID,
    ]);
    expect(await outboxRows(db)).toEqual([]);
    expect(await receiptRows(db)).toHaveLength(1);
  });

  it('when the server already owns the shot (prior drain committed, receipt lost), a re-queued copy is accepted as replay and the receipt is rewritten', async () => {
    const server = createServerEmulator();
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    await drainOutbox(db, server);
    expect(await receiptRows(db)).toHaveLength(1);

    // Corrupt state: receipt lost (e.g. wiped), analysis re-saved.
    await db.execute('DELETE FROM sync_receipt');
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    expect(await getShotOutboxStatus(db, SHOT_ID)).toMatchObject({
      state: 'queued',
    });

    const result = await drainOutbox(db, server);
    expect(result).toEqual({ synced: 1, failed: 0, remaining: 0 });
    expect(server.inserted).toEqual([SHOT_ID]);
    expect(await receiptRows(db)).toEqual([
      { owner_key: OWNER_A, kind: 'shot.sync', entity_id: SHOT_ID },
    ]);
  });

  it('a partial acknowledgement (server accepts the id once, returns it once) still clears every duplicate row — Set semantics', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    const result = await drainOutbox(db, {
      syncShots: async () => ({ acceptedIds: [SHOT_ID], rejected: [] }),
      createSession: async () => {},
      finalizeSession: async () => {},
    });
    expect(result).toEqual({ synced: 3, failed: 0, remaining: 0 });
    expect(await outboxRows(db)).toEqual([]);
    expect(await receiptRows(db)).toHaveLength(1);
  });

  it('an unacknowledged duplicate (server neither accepts nor rejects) burns budget on the orphan copy only', async () => {
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    await saveAnalysis(db, realAnalysis, PERMIT_ID);
    // Hostile server: acknowledges nothing for this id.
    const result = await drainOutbox(db, {
      syncShots: async () => ({ acceptedIds: [], rejected: [] }),
      createSession: async () => {},
      finalizeSession: async () => {},
    });
    expect(result).toEqual({ synced: 0, failed: 2, remaining: 2 });
    const rows = await outboxRows(db);
    expect(rows.map(r => r['attempts'])).toEqual([1, 1]);
    expect(rows.map(r => r['last_error'])).toEqual([
      'shot.sync_unacknowledged',
      'shot.sync_unacknowledged',
    ]);
  });
});
