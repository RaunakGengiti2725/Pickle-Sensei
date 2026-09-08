/**
 * `@op-engineering/op-sqlite` replacement for the child process: a real
 * file-backed `node:sqlite` database (durable across SIGKILL, unlike the
 * in-memory Jest doubles) exposing the `open()` surface `src/data/db.ts`
 * consumes — `executeSync`, `transaction` (serialized, real
 * BEGIN IMMEDIATE / COMMIT / ROLLBACK) and `close`.
 *
 * A configured `sql` kill trigger SIGKILLs the process `before` or `after`
 * the matching statement so the on-disk state is exactly "that statement
 * applied (or not)": mid-transaction kills leave an uncommitted transaction
 * that SQLite rolls back on the next open, matching an iOS app dying with
 * an open write transaction.
 */
import { DatabaseSync } from 'node:sqlite';
import type { Scalar, Transaction } from '@op-engineering/op-sqlite';
import { dieAtKillPoint, killTriggerFromEnvironment } from './killSwitch';

type Bound = string | number | bigint | null | Uint8Array;

export function open(_options: { name: string }) {
  const filePath = process.env['PD_DB_PATH'];
  if (!filePath) throw new Error('PD_DB_PATH must name the durable database.');
  const native = new DatabaseSync(filePath);
  const trigger = killTriggerFromEnvironment();
  let seen = 0;

  const matches = (sql: string): boolean =>
    trigger !== null &&
    trigger.kind === 'sql' &&
    trigger.includes.every(fragment => sql.includes(fragment));

  const executeSync = (sql: string, params: unknown[] = []) => {
    const armed = matches(sql) && ++seen === (trigger?.ordinal ?? -1);
    if (armed && trigger?.phase === 'before') dieAtKillPoint(sql);
    const statement = native.prepare(sql);
    const bound = params as Bound[];
    const result =
      statement.columns().length > 0
        ? {
            rows: statement.all(...bound) as Record<string, Scalar>[],
            rowsAffected: 0,
          }
        : { rows: [], rowsAffected: Number(statement.run(...bound).changes) };
    if (armed && trigger?.phase === 'after') dieAtKillPoint(sql);
    return result;
  };

  let queue: Promise<void> = Promise.resolve();
  return {
    executeSync,
    transaction(operation: (connection: Transaction) => Promise<void>) {
      const task = queue.then(async () => {
        executeSync('BEGIN IMMEDIATE');
        let openTransaction = true;
        const connection: Transaction = {
          execute: async (sql, params) => executeSync(sql, params),
          async commit() {
            executeSync('COMMIT');
            openTransaction = false;
            return { rows: [], rowsAffected: 0 };
          },
          rollback() {
            if (openTransaction) executeSync('ROLLBACK');
            openTransaction = false;
            return { rows: [], rowsAffected: 0 };
          },
        };
        try {
          await operation(connection);
        } finally {
          if (openTransaction) executeSync('ROLLBACK');
        }
      });
      queue = task.catch(() => undefined);
      return task;
    },
    close: () => native.close(),
  };
}
