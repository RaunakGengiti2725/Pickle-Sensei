/**
 * Adversarial pass 3 / scenario 1 — SQLite `open()` throws on the FIRST
 * `getDb()` and succeeds on the second.
 *
 * Attack surface: db.ts keeps a module singleton (`instance`). If a failed
 * open left a poisoned/null singleton behind, the second call would either
 * (a) call `close()` on a handle that never existed, (b) return a facade
 * bound to `null`, or (c) never retry `open()` at all. Every branch below is
 * exercised through the real `getDb()` with only the native module mocked.
 */
import { open } from '@op-engineering/op-sqlite';
import { GUEST_DATA_OWNER } from '../../src/data/accountScope';

jest.mock('@op-engineering/op-sqlite', () => ({ open: jest.fn() }));

const openMock = open as unknown as jest.Mock;

interface FakeNativeDb {
  executeSync: jest.Mock;
  execute: jest.Mock;
  close: jest.Mock;
  sql: string[];
  closed: boolean;
}

/** A native handle that records every statement and answers PRAGMA
 * table_info with an already account-scoped shape so the schema upgrade is a
 * no-op (the rebuild path is exercised separately below). */
function nativeDb(opts: { failOn?: RegExp } = {}): FakeNativeDb {
  const sql: string[] = [];
  const handle: FakeNativeDb = {
    sql,
    closed: false,
    executeSync: jest.fn((statement: string) => {
      sql.push(statement);
      if (opts.failOn && opts.failOn.test(statement)) {
        throw new Error(`native failure at: ${statement.slice(0, 40)}`);
      }
      if (statement.startsWith('PRAGMA table_info(')) {
        return {
          rows: [
            { name: 'owner_key', pk: 1 },
            { name: 'id', pk: 2 },
            { name: 'payload', pk: 0 },
            { name: 'declared_stroke', pk: 0 },
            { name: 'target_seed', pk: 0 },
            { name: 'training_consent', pk: 0 },
          ],
        };
      }
      return { rows: [] };
    }),
    execute: jest.fn(async (statement: string, params: unknown[] = []) => {
      if (handle.closed) throw new Error('database is closed');
      sql.push(statement);
      return { rows: [{ echoed: statement, params }] };
    }),
    close: jest.fn(() => {
      handle.closed = true;
    }),
  };
  return handle;
}

function loadFreshDbModule(): typeof import('../../src/data/db') {
  jest.resetModules();
  // Re-apply the native mock after the registry reset so the fresh module
  // instance sees the same `open` mock.
  jest.doMock('@op-engineering/op-sqlite', () => ({ open: openMock }));
  return jest.requireActual<typeof import('../../src/data/db')>(
    '../../src/data/db',
  );
}

describe('attack S1 — first open() throws, second succeeds', () => {
  beforeEach(() => {
    openMock.mockReset();
  });

  it('propagates the open error, closes nothing, and the second getDb() opens a working facade', async () => {
    const good = nativeDb();
    openMock
      .mockImplementationOnce(() => {
        throw new Error('SQLITE_CANTOPEN: unable to open database file');
      })
      .mockImplementationOnce(() => good);
    const { getDb } = loadFreshDbModule();

    expect(() => getDb()).toThrow('SQLITE_CANTOPEN');
    // No handle existed, so no close() could have happened on it.
    expect(good.close).not.toHaveBeenCalled();
    expect(openMock).toHaveBeenCalledTimes(1);

    const facade = getDb();
    expect(openMock).toHaveBeenCalledTimes(2);
    expect(good.close).not.toHaveBeenCalled();
    // The facade is bound to the handle returned by the SECOND open.
    const result = await facade.execute('SELECT 1', [7]);
    expect(result.rows).toEqual([{ echoed: 'SELECT 1', params: [7] }]);
    expect(good.execute).toHaveBeenCalledWith('SELECT 1', [7]);
    // Migrations + account-scoped schema ran exactly once, on the good handle.
    expect(good.sql.filter(s => s === 'BEGIN IMMEDIATE')).toHaveLength(1);
    expect(good.sql.filter(s => s === 'COMMIT')).toHaveLength(1);
    expect(good.sql.some(s => s.includes('sync_receipt'))).toBe(true);

    // A third getDb() reuses the singleton — no third open().
    getDb();
    expect(openMock).toHaveBeenCalledTimes(2);
  });

  it('open() throwing N times in a row never leaks a handle and retries every time', () => {
    const good = nativeDb();
    let failures = 0;
    openMock.mockImplementation(() => {
      if (failures < 5) {
        failures += 1;
        throw new Error(`transient open failure #${failures}`);
      }
      return good;
    });
    const { getDb } = loadFreshDbModule();
    for (let i = 1; i <= 5; i += 1) {
      expect(() => getDb()).toThrow(`transient open failure #${i}`);
    }
    expect(openMock).toHaveBeenCalledTimes(5);
    expect(good.close).not.toHaveBeenCalled();
    expect(getDb()).toBeDefined();
    expect(openMock).toHaveBeenCalledTimes(6);
  });

  it('open() succeeds but a migration throws: that handle is closed exactly once and the next getDb() reopens cleanly', async () => {
    const poisoned = nativeDb({ failOn: /CREATE TABLE IF NOT EXISTS outbox/ });
    const good = nativeDb();
    openMock
      .mockImplementationOnce(() => poisoned)
      .mockImplementationOnce(() => good);
    const { getDb } = loadFreshDbModule();

    expect(() => getDb()).toThrow('native failure at');
    expect(poisoned.close).toHaveBeenCalledTimes(1);
    expect(good.close).not.toHaveBeenCalled();

    const facade = getDb();
    expect(openMock).toHaveBeenCalledTimes(2);
    await expect(facade.execute('SELECT 1')).resolves.toEqual({
      rows: [{ echoed: 'SELECT 1', params: [] }],
    });
    // The poisoned handle is never touched again.
    expect(poisoned.execute).not.toHaveBeenCalled();
  });

  it('account-scope upgrade failure rolls back on the same handle, closes it once, and preserves the ORIGINAL error', () => {
    const poisoned = nativeDb({
      failOn: /CREATE INDEX IF NOT EXISTS idx_outbox_owner_created/,
    });
    // Make close() itself throw: db.ts must still surface the migration error.
    poisoned.close.mockImplementation(() => {
      poisoned.closed = true;
      throw new Error('close exploded');
    });
    openMock.mockImplementationOnce(() => poisoned);
    const { getDb } = loadFreshDbModule();
    expect(() => getDb()).toThrow(
      'native failure at: CREATE INDEX IF NOT EXISTS idx_outbox',
    );
    expect(poisoned.sql).toContain('ROLLBACK');
    expect(poisoned.close).toHaveBeenCalledTimes(1);
  });

  it('a legacy (pre-account-scope) database is rebuilt into the guest bucket inside one transaction', () => {
    const legacy = nativeDb();
    legacy.executeSync.mockImplementation((statement: string) => {
      legacy.sql.push(statement);
      if (statement.startsWith('PRAGMA table_info(')) {
        // Legacy shape: single-column PK on id, no owner_key.
        return {
          rows: [
            { name: 'id', pk: 1 },
            { name: 'payload', pk: 0 },
          ],
        };
      }
      return { rows: [] };
    });
    openMock.mockImplementationOnce(() => legacy);
    const { getDb } = loadFreshDbModule();
    getDb();
    const begin = legacy.sql.indexOf('BEGIN IMMEDIATE');
    const commit = legacy.sql.indexOf('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    const inTx = legacy.sql.slice(begin, commit);
    for (const table of ['local_shot', 'local_session', 'local_capture']) {
      expect(
        inTx.some(
          s =>
            s.includes(`INSERT OR IGNORE INTO ${table}_account_v2`) &&
            s.includes(`'${GUEST_DATA_OWNER}'`),
        ),
      ).toBe(true);
      expect(inTx).toContain(`DROP TABLE ${table}`);
    }
    expect(
      inTx.some(s =>
        s.includes(
          `ALTER TABLE outbox ADD COLUMN owner_key TEXT NOT NULL DEFAULT '${GUEST_DATA_OWNER}'`,
        ),
      ),
    ).toBe(true);
    expect(legacy.close).not.toHaveBeenCalled();
  });
});

describe('attack S1-adjacent — facade lifecycle after close()', () => {
  beforeEach(() => {
    openMock.mockReset();
  });

  it('close() through one facade invalidates every earlier facade of the same singleton', async () => {
    const first = nativeDb();
    const second = nativeDb();
    openMock
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);
    const { getDb } = loadFreshDbModule();
    const a = getDb();
    const b = getDb();
    expect(openMock).toHaveBeenCalledTimes(1);
    a.close();
    expect(first.close).toHaveBeenCalledTimes(1);
    // `b` still points at the closed native handle: any use must fail loudly
    // rather than silently succeed against a dead connection.
    await expect(b.execute('SELECT 1')).rejects.toThrow('database is closed');
    // A fresh getDb() reopens.
    const c = getDb();
    expect(openMock).toHaveBeenCalledTimes(2);
    await expect(c.execute('SELECT 2')).resolves.toEqual({
      rows: [{ echoed: 'SELECT 2', params: [] }],
    });
  });

  it('a stale facade closing AFTER a reopen closes its own dead handle and drops the LIVE singleton (documented aliasing hazard)', async () => {
    const first = nativeDb();
    const second = nativeDb();
    const third = nativeDb();
    openMock
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second)
      .mockImplementationOnce(() => third);
    const { getDb } = loadFreshDbModule();
    const stale = getDb();
    stale.close(); // instance = null
    const live = getDb(); // opens `second`
    expect(openMock).toHaveBeenCalledTimes(2);
    // The stale facade's close() runs `db.close()` on `first` (already
    // closed) and then unconditionally sets `instance = null`, orphaning the
    // live `second` handle without closing it.
    stale.close();
    expect(first.close).toHaveBeenCalledTimes(2);
    expect(second.close).not.toHaveBeenCalled();
    // `live` keeps working on the orphaned handle...
    await expect(live.execute('SELECT 1')).resolves.toBeDefined();
    // ...while the next getDb() opens a THIRD handle: two live native
    // connections to the same file now coexist.
    getDb();
    expect(openMock).toHaveBeenCalledTimes(3);
    expect(second.close).not.toHaveBeenCalled();
    expect(third.close).not.toHaveBeenCalled();
  });
});
