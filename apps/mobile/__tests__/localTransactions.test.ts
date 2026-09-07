import type { Transaction } from '@op-engineering/op-sqlite';
import type { LocalDb } from '../src/data/db';
import {
  captureDataOwnerContext,
  DataOwnerChangedError,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  createTransactionalDb,
  forDataOwner,
  withTransaction,
} from '../src/data/transactions';

const owner = '11111111-1111-4111-8111-111111111111';

function recordingDb() {
  const execute = jest.fn(async (_sql: string, _params?: unknown[]) => ({
    rows: [] as Record<string, unknown>[],
  }));
  const db: LocalDb = { execute, close: jest.fn() };
  return { db, execute };
}

function nativeDriver() {
  const connection: Transaction = {
    execute: jest.fn(async () => ({ rows: [{ value: 1 }], rowsAffected: 1 })),
    commit: jest.fn(async () => ({ rows: [], rowsAffected: 0 })),
    rollback: jest.fn(() => ({ rows: [], rowsAffected: 0 })),
  };
  const driver = {
    transaction: jest.fn(
      async (operation: (tx: Transaction) => Promise<void>) => {
        await operation(connection);
      },
    ),
    close: jest.fn(),
  };
  return { driver, connection };
}

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

it('shares one transaction with nested repository operations', async () => {
  const { db, execute } = recordingDb();

  const value = await withTransaction(db, async outer => {
    await outer.execute('first');
    return withTransaction(outer, async inner => {
      await inner.execute('second');
      return 42;
    });
  });

  expect(value).toBe(42);
  expect(execute.mock.calls.map(([sql]) => sql)).toEqual([
    'BEGIN IMMEDIATE',
    'first',
    'second',
    'COMMIT',
  ]);
});

it('serializes independent transactions on a port without a native transaction method', async () => {
  const { db, execute } = recordingDb();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const first = withTransaction(db, async tx => {
    await tx.execute('first');
    await gate;
  });
  const second = withTransaction(db, tx => tx.execute('second'));
  await Promise.resolve();
  await Promise.resolve();
  expect(execute.mock.calls.some(([sql]) => sql === 'second')).toBe(false);
  release();
  await Promise.all([first, second]);

  expect(execute.mock.calls.map(([sql]) => sql)).toEqual([
    'BEGIN IMMEDIATE',
    'first',
    'COMMIT',
    'BEGIN IMMEDIATE',
    'second',
    'COMMIT',
  ]);
});

it('preserves the original failure even when rollback fails', async () => {
  const { db, execute } = recordingDb();
  execute.mockImplementation(async sql => {
    if (sql === 'ROLLBACK') throw new Error('rollback failed');
    return { rows: [] };
  });

  await expect(
    withTransaction(db, async () => {
      throw new Error('original failure');
    }),
  ).rejects.toThrow('original failure');
  expect(execute).toHaveBeenCalledWith('ROLLBACK');
});

it('does not permit a transaction handle to escape its lifetime', async () => {
  const { db } = recordingDb();
  let escaped!: LocalDb;
  await withTransaction(db, async tx => {
    escaped = tx;
  });

  await expect(escaped.execute('late write')).rejects.toThrow(
    'transaction has finished',
  );
});

it('uses the native transaction queue for standalone statements and awaits commit', async () => {
  const { driver, connection } = nativeDriver();
  const db = createTransactionalDb(driver);

  await expect(db.execute('SELECT 1')).resolves.toEqual({
    rows: [{ value: 1 }],
    rowsAffected: 1,
  });
  expect(driver.transaction).toHaveBeenCalledTimes(1);
  expect(connection.execute).toHaveBeenCalledWith('SELECT 1', []);
  expect(connection.commit).toHaveBeenCalledTimes(1);
});

it('does not start a second native transaction for a nested operation', async () => {
  const { driver, connection } = nativeDriver();
  const db = createTransactionalDb(driver);

  const result = await withTransaction(db, async outer =>
    withTransaction(outer, async inner => {
      await inner.execute('write');
      return 'saved';
    }),
  );

  expect(result).toBe('saved');
  expect(driver.transaction).toHaveBeenCalledTimes(1);
  expect(connection.commit).toHaveBeenCalledTimes(1);
});

it('cannot close the connection while queued work is unfinished', async () => {
  const { driver } = nativeDriver();
  const db = createTransactionalDb(driver);
  let release!: () => void;
  const pending = withTransaction(
    db,
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      }),
  );

  expect(() => db.close()).toThrow('operations are still running');
  release();
  await pending;
  db.close();
  expect(driver.close).toHaveBeenCalledTimes(1);
  await expect(db.execute('SELECT 1')).rejects.toThrow('database is closed');
});

it('rolls back an owned transaction when its account generation changes', async () => {
  setActiveDataOwner(owner);
  const context = captureDataOwnerContext();
  const { db, execute } = recordingDb();
  const owned = forDataOwner(db, context);

  await expect(
    withTransaction(owned, async tx => {
      await tx.execute('owned write');
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      setActiveDataOwner(owner);
    }),
  ).rejects.toBeInstanceOf(DataOwnerChangedError);
  expect(execute.mock.calls.map(([sql]) => sql)).toEqual([
    'BEGIN IMMEDIATE',
    'owned write',
    'ROLLBACK',
  ]);
});
