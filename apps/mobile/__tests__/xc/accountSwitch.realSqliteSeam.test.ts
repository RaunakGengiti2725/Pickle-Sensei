/**
 * xc-journey-account-switch — engine seam self-check.
 *
 * Proves the harness runs `src/data/db.ts`'s REAL migrations on a REAL
 * SQLite engine (no recorded-SQL fake): every owner-scoped table exists with
 * its composite primary key, and legacy unscoped rows are re-homed to the
 * guest bucket — never to whichever account signs in next.
 */
import type { LocalDb } from '../../src/data/db';
import { GUEST_DATA_OWNER } from '../../src/data/accountScope';
import {
  openRealSqlite,
  type RealSqliteHandle,
} from '../../testing/xc-account-switch/realSqlite';

let mockHandle: RealSqliteHandle | null = null;
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    if (!mockHandle) throw new Error('mockHandle not opened');
    return mockHandle;
  },
}));

function loadGetDb(): () => LocalDb {
  let getDb: (() => LocalDb) | null = null;
  jest.isolateModules(() => {
    getDb =
      jest.requireActual<typeof import('../../src/data/db')>(
        '../../src/data/db',
      ).getDb;
  });
  if (!getDb) throw new Error('db module did not load');
  return getDb;
}

afterEach(() => {
  mockHandle?.close();
  mockHandle = null;
});

describe('real SQLite behind the op-sqlite seam', () => {
  it('runs every local migration and account-scope upgrade on a real engine', async () => {
    mockHandle = openRealSqlite();
    const db = loadGetDb()();
    const tables = mockHandle
      .dumpTable('sqlite_master')
      .filter(row => row['type'] === 'table')
      .map(row => String(row['name']))
      .sort();
    expect(tables).toEqual(
      expect.arrayContaining([
        'kv',
        'local_shot',
        'local_session',
        'local_capture',
        'outbox',
        'sync_receipt',
        'local_analysis_record',
      ]),
    );
    for (const table of ['local_shot', 'local_session', 'local_capture']) {
      const pk = mockHandle
        .executeSync(`PRAGMA table_info(${table})`)
        .rows.filter(row => Number(row['pk']) > 0)
        .sort((a, b) => Number(a['pk']) - Number(b['pk']))
        .map(row => row['name']);
      expect(pk).toEqual(['owner_key', 'id']);
    }
    const receiptPk = mockHandle
      .executeSync('PRAGMA table_info(sync_receipt)')
      .rows.filter(row => Number(row['pk']) > 0)
      .sort((a, b) => Number(a['pk']) - Number(b['pk']))
      .map(row => row['name']);
    expect(receiptPk).toEqual(['owner_key', 'kind', 'entity_id']);
    const { rows } = await db.execute('SELECT sqlite_version() AS v');
    expect(String(rows[0]?.['v'])).toMatch(/^3\./);
    expect(['in-process', 'worker-bridge']).toContain(mockHandle.engine);
  });

  it('re-homes legacy unscoped rows to the guest bucket, never to a signed-in account', () => {
    mockHandle = openRealSqlite();
    // Pre-account schema: no owner_key column at all.
    mockHandle.executeSync(`CREATE TABLE local_shot (
      id TEXT PRIMARY KEY, session_id TEXT, shot_type TEXT NOT NULL,
      captured_at TEXT NOT NULL, overall_score REAL, confidence REAL NOT NULL,
      result_kind TEXT NOT NULL, source TEXT NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL)`);
    mockHandle.executeSync(
      `INSERT INTO local_shot (id, shot_type, captured_at, confidence, result_kind, source, payload)
       VALUES ('legacy-1', 'forehand_drive', '2026-01-01T00:00:00Z', 0.9, 'scored', 'real', '{}')`,
    );
    mockHandle.executeSync(
      `CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
       payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT)`,
    );
    mockHandle.executeSync(
      `INSERT INTO outbox (kind, payload) VALUES ('shot.sync', '{}')`,
    );
    loadGetDb()();
    expect(mockHandle.dumpTable('local_shot')).toEqual([
      expect.objectContaining({ id: 'legacy-1', owner_key: GUEST_DATA_OWNER }),
    ]);
    expect(mockHandle.dumpTable('outbox')).toEqual([
      expect.objectContaining({
        kind: 'shot.sync',
        owner_key: GUEST_DATA_OWNER,
      }),
    ]);
  });
});
