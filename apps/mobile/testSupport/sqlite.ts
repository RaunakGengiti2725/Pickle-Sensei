import type { Scalar, Transaction } from '@op-engineering/op-sqlite';
import type { LocalDb } from '../src/data/db';
import type { CapturedClip } from '../src/camera/capture';

interface TestSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    columns(): unknown[];
    all(...params: unknown[]): Record<string, Scalar>[];
    get(...params: unknown[]): Record<string, Scalar> | undefined;
    run(...params: unknown[]): { changes: number | bigint };
  };
  close(): void;
}

export interface SqliteCall {
  sql: string;
  params: unknown[];
  transaction: number;
}

const databases = new Set<LocalDb>();
const nativeDatabases = new WeakMap<LocalDb, TestSqliteDatabase>();

export function createSqliteTestDb(databasePath = ':memory:') {
  const { DatabaseSync } = jest.requireActual<{
    DatabaseSync: new (path: string) => TestSqliteDatabase;
  }>('node:sqlite');
  const native = new DatabaseSync(databasePath);
  const calls: SqliteCall[] = [];
  let queue = Promise.resolve();
  let transactionId = 0;
  let statementFailure: { includes: string; error: Error } | null = null;
  let commitFailure: { when: 'before' | 'after'; includes: string } | null =
    null;
  let observer: ((call: SqliteCall) => void) | null = null;
  const executeSync = (sql: string, params: unknown[] = []) => {
    const call = { sql, params, transaction: transactionId };
    calls.push(call);
    if (statementFailure && sql.includes(statementFailure.includes)) {
      const error = statementFailure.error;
      statementFailure = null;
      throw error;
    }
    const statement = native.prepare(sql);
    const result =
      statement.columns().length > 0
        ? { rows: statement.all(...params), rowsAffected: 0 }
        : { rows: [], rowsAffected: Number(statement.run(...params).changes) };
    observer?.(call);
    return result;
  };
  const driver = {
    executeSync,
    transaction(operation: (connection: Transaction) => Promise<void>) {
      const task = queue.then(async () => {
        transactionId += 1;
        const current = transactionId;
        executeSync('BEGIN IMMEDIATE');
        let open = true;
        const connection: Transaction = {
          execute: async (sql, params) => executeSync(sql, params),
          async commit() {
            const fault =
              commitFailure &&
              calls.some(
                call =>
                  call.transaction === current &&
                  call.sql.includes(commitFailure!.includes),
              )
                ? commitFailure
                : null;
            if (fault) commitFailure = null;
            if (fault?.when === 'before')
              throw new Error('SQLite commit failed before commit');
            executeSync('COMMIT');
            open = false;
            if (fault?.when === 'after')
              throw new Error('SQLite commit acknowledgement lost');
            return { rows: [], rowsAffected: 0 };
          },
          rollback() {
            if (open) executeSync('ROLLBACK');
            open = false;
            return { rows: [], rowsAffected: 0 };
          },
        };
        try {
          await operation(connection);
        } finally {
          if (open) executeSync('ROLLBACK');
        }
      });
      queue = task.catch(() => {});
      return task;
    },
    close: () => native.close(),
  };
  let db!: LocalDb;
  jest.isolateModules(() => {
    jest.doMock('@op-engineering/op-sqlite', () => ({ open: () => driver }));
    const module = jest.requireActual<{ getDb(): LocalDb }>('../src/data/db');
    db = module.getDb();
  });
  jest.dontMock('@op-engineering/op-sqlite');
  calls.length = 0;
  databases.add(db);
  nativeDatabases.set(db, native);
  return {
    db,
    native,
    calls,
    close() {
      if (databases.delete(db)) db.close();
    },
    failStatementOnce(
      includes: string,
      error = new Error('SQLite write failed'),
    ) {
      statementFailure = { includes, error };
    },
    failCommitOnce(
      when: 'before' | 'after',
      includes = "SET state = 'committed'",
    ) {
      commitFailure = { when, includes };
    },
    observeStatements(callback: ((call: SqliteCall) => void) | null) {
      observer = callback;
    },
    count(table: string, ownerKey: string): number {
      return Number(
        native
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE owner_key = ?`)
          .get(ownerKey)?.n,
      );
    },
  };
}

export function seedSqliteCapture(
  db: LocalDb,
  ownerKey: string,
  captureId: string,
  clip: CapturedClip,
): void {
  const native = nativeDatabases.get(db);
  if (!native) throw new Error('A real SQLite test connection is required.');
  native
    .prepare(
      `INSERT OR IGNORE INTO local_capture
    (owner_key, id, uri, shot_type, captured_at, duration_ms, fps, width, height, status, payload)
    VALUES (?, ?, ?, 'forehand_drive', ?, ?, ?, ?, ?, 'awaiting_model', ?)`,
    )
    .run(
      ownerKey,
      captureId,
      clip.uri,
      clip.capturedAtIso,
      clip.durationMs,
      clip.fps,
      clip.width,
      clip.height,
      JSON.stringify(clip),
    );
}

export function closeSqliteTestDatabases(): void {
  for (const db of databases) db.close();
  databases.clear();
}
