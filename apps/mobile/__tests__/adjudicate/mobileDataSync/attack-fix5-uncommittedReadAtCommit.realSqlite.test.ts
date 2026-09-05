/**
 * Adversary round 5 — MDS-C1/C2 candidate `devin/fix4-mds-sqlite-a`
 * (7f1405eb): "scored shot + local_session + session.create + shot.sync land
 * in ONE serialized SQLite transaction".
 *
 * `runInTransaction` serializes WRITERS that go through it, but every other
 * statement the app issues on the one shared connection (the drain's page
 * SELECTs, its bare UPDATE/DELETEs) runs INSIDE whichever transaction is open
 * at that moment — SQLite transactions are per connection. A drain that is
 * scheduled between the save's last INSERT and its COMMIT therefore reads the
 * uncommitted shot.sync row and offers it to the server. When the COMMIT then
 * fails (SQLITE_FULL / I/O error at the statement boundary the candidate
 * says is covered), the save rolls back — but the server has already
 * accepted the rating and consumed its permit, and the drain's receipt
 * transaction (queued right behind the failed save) writes a `sync_receipt`
 * for a shot that does not exist locally. Expected: a rating the save did
 * not commit is never offered, and no receipt is ever written for it.
 */
import type { LocalDb } from '../../../src/data/db';
import { createRealOpSqliteModule } from '../../../adjudicate/mobile-data-sync/realSqliteOpMock';

const mockSqlite = createRealOpSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { getDb } from '../../../src/data/db';
import {
  getAnalysis,
  hasShotSyncReceipt,
  saveAnalysis,
} from '../../../src/data/repository';
import { drainOutbox } from '../../../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  acceptAllTransport,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const SESSION = '12121212-0000-4000-8000-000000000002';

function statementLog(from: number): string[] {
  const live = mockSqlite.opened[mockSqlite.opened.length - 1];
  if (!live) throw new Error('no connection opened');
  return live.log.slice(from);
}

async function settle<T>(p: Promise<T>): Promise<PromiseSettledResult<T>> {
  const [result] = await Promise.allSettled([p]);
  return result;
}

describe('attack fix5 / C2: the drain reads rows of an open saveAnalysis transaction (real SQLite)', () => {
  let db: LocalDb;

  beforeEach(async () => {
    setActiveDataOwner(OWNER);
    db = getDb();
    await db.execute(`DELETE FROM outbox`);
    await db.execute(`DELETE FROM local_shot`);
    await db.execute(`DELETE FROM local_session`);
    await db.execute(`DELETE FROM sync_receipt`);
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('a rating whose COMMIT fails is never offered to the server and never receipted', async () => {
    const transport = acceptAllTransport();
    const logStart = statementLog(0).length;
    const hook: { drain: Promise<PromiseSettledResult<unknown>> | null } = {
      drain: null,
    };

    // The device's connection: the runtime's drain (timer / foreground /
    // triggerOutboxSync of the previous rating) is scheduled while the save
    // is between its last INSERT and its COMMIT, and the COMMIT itself hits
    // the disk-full boundary.
    const faulty: LocalDb = {
      async execute(sql, params) {
        if (sql.trim().toUpperCase() === 'COMMIT') {
          if (!hook.drain) hook.drain = settle(drainOutbox(db, transport));
          throw new Error('SQLITE_FULL: database or disk is full');
        }
        return db.execute(sql, params);
      },
      close: () => db.close(),
    };

    const saveResult = await settle(
      saveAnalysis(
        faulty,
        realAnalysis({ id: shotId(2), sessionId: SESSION }),
        PERMIT_ID,
        {
          session: {
            id: SESSION,
            mode: 'practice_set',
            shotType: 'forehand_drive',
            focusCheckpoint: null,
            startedAt: '2026-09-04T12:00:00.000Z',
          },
        },
      ),
    );
    if (!hook.drain) throw new Error('interleaving hook never fired');
    const drainResult = await hook.drain;

    // Preconditions of the scenario itself.
    expect(saveResult.status).toBe('rejected');
    expect(drainResult.status).toBe('fulfilled');
    const log = statementLog(logStart);
    const firstShotPage = log.findIndex(
      // The drain's page read (saveAnalysis's own idempotency SELECT on the
      // outbox is not a drain read).
      sql =>
        sql.startsWith('SELECT id, kind, payload') &&
        sql.includes(`kind = 'shot.sync'`),
    );
    const rollback = log.findIndex(
      sql => sql.trim().toUpperCase() === 'ROLLBACK',
    );
    expect(firstShotPage).toBeGreaterThan(-1);
    expect(rollback).toBeGreaterThan(-1);
    // Ported from fix4-mds-sqlite-a, where this precondition read
    // `rollback > firstShotPage`: the drain's page SELECT ran INSIDE the open
    // save transaction. On this base the interleaving is structurally
    // impossible — the drain was scheduled while the save was open (the hook
    // fired at COMMIT) and still its first read of the queue lands only
    // after the save's ROLLBACK; every drain read is serialized behind the
    // repository transaction on the shared connection.
    expect(firstShotPage).toBeGreaterThan(rollback);
    // The save did roll back: nothing of the rating survived locally.
    expect(await getAnalysis(db, shotId(2))).toBeNull();
    expect(await outboxRows(db, OWNER)).toHaveLength(0);

    // EXPECTED: the transaction is the unit — a rating that never committed
    // is invisible to the drain: not offered, not created, not receipted.
    // OBSERVED: the drain read the uncommitted shot.sync (and session.create)
    // rows through the shared connection, the server accepted the shot
    // (permit consumed, rating counted) and a sync_receipt for a shot that
    // does not exist on this device was written.
    const offered = transport.syncCalls
      .flat()
      .map(s => String((s as { id: unknown }).id));
    expect(await hasShotSyncReceipt(db, shotId(2))).toBe(false);
    expect(offered).not.toContain(shotId(2));
    expect(transport.sessions).not.toContain(SESSION);
  });
});
