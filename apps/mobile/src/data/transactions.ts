import type { DB, Transaction } from '@op-engineering/op-sqlite';
import type { LocalDb } from './db';
import { assertDataOwnerContext, type DataOwnerContext } from './accountScope';

export function forDataOwner(db: LocalDb, context: DataOwnerContext): LocalDb {
  assertDataOwnerContext(context);
  return {
    ownerContext: context,
    async execute(sql, params) {
      assertDataOwnerContext(context);
      const result = await db.execute(sql, params);
      assertDataOwnerContext(context);
      return result;
    },
    transaction: operation =>
      withTransaction(db, async transaction => {
        const result = await operation(forDataOwner(transaction, context));
        assertDataOwnerContext(context);
        return result;
      }),
    close() {
      throw new Error(
        'An account-scoped connection cannot close its database.',
      );
    },
  };
}

const pendingTransactions = new WeakMap<LocalDb, Promise<void>>();

function scopedDatabase(execute: LocalDb['execute']): {
  db: LocalDb;
  finish(): void;
} {
  let active = true;
  const requireActive = () => {
    if (!active) throw new Error('The database transaction has finished.');
  };
  const db: LocalDb = {
    async execute(sql, params) {
      requireActive();
      return execute(sql, params);
    },
    async transaction(operation) {
      requireActive();
      return operation(db);
    },
    close() {
      throw new Error('A transaction cannot close its database.');
    },
  };
  return {
    db,
    finish() {
      active = false;
    },
  };
}

export function withTransaction<T>(
  db: LocalDb,
  operation: (transaction: LocalDb) => Promise<T>,
): Promise<T> {
  if (db.transaction) return db.transaction(operation);
  const previous = pendingTransactions.get(db) ?? Promise.resolve();
  const result = previous.then(async () => {
    await db.execute('BEGIN IMMEDIATE');
    const scoped = scopedDatabase((sql, params) => db.execute(sql, params));
    try {
      const value = await operation(scoped.db);
      await db.execute('COMMIT');
      return value;
    } catch (error) {
      await db.execute('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      scoped.finish();
    }
  });
  const settled = result.then(
    () => {},
    () => {},
  );
  pendingTransactions.set(db, settled);
  void settled.then(() => {
    if (pendingTransactions.get(db) === settled) pendingTransactions.delete(db);
  });
  return result;
}

export function createTransactionalDb(
  native: Pick<DB, 'transaction' | 'close'>,
): LocalDb {
  let closed = false;
  let pending = 0;
  const transaction = async <T>(
    operation: (connection: LocalDb) => Promise<T>,
  ): Promise<T> => {
    if (closed) throw new Error('The database is closed.');
    pending += 1;
    let value: T | undefined;
    try {
      await native.transaction(async (connection: Transaction) => {
        const scoped = scopedDatabase(async (sql, params = []) => {
          const result = await connection.execute(sql, params as never[]);
          return {
            rows: (result.rows ?? []) as Record<string, unknown>[],
            rowsAffected: result.rowsAffected,
          };
        });
        try {
          value = await operation(scoped.db);
          await connection.commit();
        } finally {
          scoped.finish();
        }
      });
      return value as T;
    } finally {
      pending -= 1;
    }
  };
  return {
    execute: (sql, params) => transaction(db => db.execute(sql, params)),
    transaction,
    close() {
      if (closed) return;
      if (pending > 0)
        throw new Error('Database operations are still running.');
      native.close();
      closed = true;
    },
  };
}
