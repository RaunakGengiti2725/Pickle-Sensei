/**
 * Adversarial round 3 (attack branch) — process kill between the two halves
 * of a sync receipt, on the real SQLite adapter.
 *
 * The receipt transaction is `BEGIN IMMEDIATE; INSERT sync_receipt; DELETE
 * outbox; COMMIT`. The process is "killed" while the DELETE is in flight: the
 * first connection is closed without COMMIT (what the OS does to an open
 * rollback-journal transaction) and the app relaunches on a fresh module
 * registry (`jest.isolateModules`, so the serialized transaction queue is
 * new) over the same database file. Expected: the receipt is not durable, the
 * outbox row is intact, and the relaunched drain replays the shot to a
 * receipt.
 */
import { createRealOpSqliteModule } from '../../../adjudicate/mobile-data-sync/realSqliteOpMock';

const mockSqlite = createRealOpSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import type { LocalDb } from '../../../src/data/db';
import type { SyncTransport } from '../../../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  acceptAllTransport,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

type Runtime = {
  accountScope: typeof import('../../../src/data/accountScope');
  db: typeof import('../../../src/data/db');
  repository: typeof import('../../../src/data/repository');
  sync: typeof import('../../../src/data/sync');
};

function bootRuntime(): Runtime {
  let runtime: Runtime | null = null;
  jest.isolateModules(() => {
    runtime = {
      accountScope: jest.requireActual<Runtime['accountScope']>(
        '../../../src/data/accountScope',
      ),
      db: jest.requireActual<Runtime['db']>('../../../src/data/db'),
      repository: jest.requireActual<Runtime['repository']>(
        '../../../src/data/repository',
      ),
      sync: jest.requireActual<Runtime['sync']>('../../../src/data/sync'),
    };
  });
  return runtime!;
}

describe('ATTACK fix3: process kill between receipt INSERT and outbox DELETE (real SQLite)', () => {
  afterAll(() => {
    mockSqlite.reset();
  });

  it('the receipt is not durable, the row survives, and the relaunched app replays the shot', async () => {
    const server: SyncTransport & { syncCalls: unknown[][] } =
      acceptAllTransport();

    // ---- first launch -----------------------------------------------------
    const first = bootRuntime();
    first.accountScope.setActiveDataOwner(
      first.accountScope.canonicalDataOwner(CANONICAL_USER),
    );
    const db1 = first.db.getDb();
    await db1.execute(`DELETE FROM outbox`);
    await db1.execute(`DELETE FROM sync_receipt`);
    await first.repository.saveAnalysis(
      db1,
      realAnalysis({ id: shotId(0x7a0) }),
      PERMIT_ID,
    );

    let deleteReached: () => void = () => {};
    const reached = new Promise<void>(resolve => {
      deleteReached = resolve;
    });
    const frozen: LocalDb = {
      execute(sql, params) {
        if (sql.startsWith('DELETE FROM outbox')) {
          deleteReached();
          return new Promise(() => {}); // the process never gets this far
        }
        return db1.execute(sql, params);
      },
      close: () => db1.close(),
    };
    void first.sync.drainOutbox(frozen, server);
    await reached;
    expect(server.syncCalls).toHaveLength(1);

    const live = mockSqlite.opened[mockSqlite.opened.length - 1]!;
    // The receipt INSERT ran inside the open transaction …
    expect(
      live.log.filter(sql =>
        sql.includes('INSERT OR REPLACE INTO sync_receipt'),
      ),
    ).toHaveLength(1);
    expect(live.log.filter(sql => sql === 'COMMIT').length).toBe(
      live.log.filter(sql => sql === 'BEGIN IMMEDIATE').length - 1,
    );
    // … and the process dies: the connection closes with the transaction
    // open, which SQLite rolls back.
    live.close();

    // ---- relaunch ---------------------------------------------------------
    const second = bootRuntime();
    second.accountScope.setActiveDataOwner(
      second.accountScope.canonicalDataOwner(CANONICAL_USER),
    );
    const db2 = second.db.getDb();
    expect(await second.repository.hasShotSyncReceipt(db2, shotId(0x7a0))).toBe(
      false,
    );
    const { rows } = await db2.execute(
      `SELECT kind, attempts, last_error FROM outbox`,
    );
    expect(rows).toEqual([
      { kind: 'shot.sync', attempts: 0, last_error: null },
    ]);

    const replay = await second.sync.drainOutbox(db2, server);
    expect(replay).toEqual({ synced: 1, failed: 0, remaining: 0 });
    expect(server.syncCalls).toHaveLength(2);
    expect(await second.repository.hasShotSyncReceipt(db2, shotId(0x7a0))).toBe(
      true,
    );
    db2.close();
  });
});
