/**
 * XC journey harness self-test: the worker-hosted `node:sqlite` engine behind
 * the op-sqlite seam must (a) load under the canonical `npx jest --ci --silent`
 * with no extra Node flags, (b) run the app's real migrations through
 * `getDb()`, and (c) honour statement-level fault injection so the journey
 * suites can prove storage-failure recovery.
 */
jest.mock(
  '@op-engineering/op-sqlite',
  () =>
    jest.requireActual<typeof import('../../../xc/journey/nodeSqliteOpSqlite')>(
      '../../../xc/journey/nodeSqliteOpSqlite',
    ).opSqliteMockModule,
);

import { getDb } from '../../../src/data/db';
import {
  clearSqliteFaults,
  createNodeBackedDb,
  injectSqliteFault,
  resetSqliteJournal,
  shutdownSqliteBridge,
  sqliteExecArgv,
  sqliteJournal,
  sqliteOpenCount,
} from '../../../xc/journey/nodeSqliteOpSqlite';

afterEach(() => {
  clearSqliteFaults();
  resetSqliteJournal();
});

afterAll(async () => {
  await shutdownSqliteBridge();
});

describe('xc sqlite bridge', () => {
  it('picks the experimental flag only for Node versions that gate node:sqlite', () => {
    expect(sqliteExecArgv('22.12.0')).toEqual(['--experimental-sqlite']);
    expect(sqliteExecArgv('22.5.1')).toEqual(['--experimental-sqlite']);
    expect(sqliteExecArgv('22.13.0')).toEqual([]);
    expect(sqliteExecArgv('23.4.0')).toEqual([]);
    expect(sqliteExecArgv('24.1.0')).toEqual([]);
  });

  it('executes statements synchronously and asynchronously against a real engine', async () => {
    const db = createNodeBackedDb();
    db.executeSync(
      'CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, b INTEGER)',
    );
    const insert = db.executeSync('INSERT INTO t VALUES (?, ?, ?)', [
      'a',
      1,
      true,
    ]);
    expect(insert.rowsAffected).toBe(1);
    const rows = await db.execute('SELECT id, n, b FROM t WHERE id = ?', ['a']);
    expect(rows.rows).toEqual([{ id: 'a', n: 1, b: 1 }]);
    await expect(db.execute('SELECT * FROM missing_table')).rejects.toThrow(
      /no such table/,
    );
    db.close();
    expect(() => db.executeSync('SELECT 1')).toThrow(/closed/);
  });

  it('runs the real src/data/db.ts migrations and repository round-trips', async () => {
    const before = sqliteOpenCount();
    const db = getDb();
    const tables = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = tables.rows.map(row => String(row.name));
    expect(names).toEqual(
      expect.arrayContaining([
        'local_shot',
        'local_session',
        'local_capture',
        'local_analysis_record',
        'outbox',
        'sync_receipt',
        'kv',
      ]),
    );
    expect(sqliteOpenCount()).toBe(before + 1);
    db.close();
  });

  it('throws exactly the injected fault for matching statements, then clears', async () => {
    const db = createNodeBackedDb();
    db.executeSync('CREATE TABLE f (id TEXT)');
    injectSqliteFault({
      match: 'INSERT INTO f',
      remaining: 1,
      error: () => new Error('SQLITE_FULL: database or disk is full'),
    });
    await expect(db.execute('INSERT INTO f VALUES (?)', ['x'])).rejects.toThrow(
      'SQLITE_FULL',
    );
    await expect(
      db.execute('INSERT INTO f VALUES (?)', ['y']),
    ).resolves.toEqual({ rows: [], rowsAffected: 1 });
    const journal = sqliteJournal();
    expect(journal.filter(entry => !entry.ok)).toHaveLength(1);
    expect(
      journal.filter(entry => entry.sql.startsWith('INSERT')),
    ).toHaveLength(2);
    db.close();
  });
});
