import type { LocalDb } from '../data/db';
import { withTransaction } from '../data/transactions';
import {
  ORIGINAL_ANALYSIS_COMPLETION_KINDS,
  ORIGINAL_ANALYSIS_DDL,
  ORIGINAL_ANALYSIS_OPERATIONS_DDL,
  ORIGINAL_ANALYSIS_OPERATIONS_TABLE,
} from './runJournalSchema';

/**
 * Forward migration for installs whose `analysis_logical_operations` was
 * created by an earlier build. `CREATE TABLE IF NOT EXISTS` leaves an
 * existing table's CHECK constraints and triggers untouched, so the
 * completion kinds this build writes are verified against the live schema
 * and the table is rebuilt in one transaction when they differ: every row,
 * the child foreign keys (deferred across the rebuild, re-satisfied by the
 * re-inserted parent rows before commit) and the dependent triggers survive.
 */

const BACKUP_NAME = 'analysis_logical_operations_upgrade';
const BACKUP_TABLE = `temp.${BACKUP_NAME}`;
const COMPLETION_KIND_CHECK =
  /completion_kind TEXT CHECK \(completion_kind IN \(([^)]*)\)\)/;

const verified = new WeakMap<LocalDb, Promise<void>>();

export function liveCompletionKinds(tableSql: string): string[] | null {
  const kinds = COMPLETION_KIND_CHECK.exec(tableSql)?.[1];
  if (kinds === undefined) return null;
  return kinds
    .split(',')
    .map(kind => kind.trim())
    .filter(kind => /^'[a-z_]+'$/.test(kind))
    .map(kind => kind.slice(1, -1));
}

export function completionKindsMatchBuild(tableSql: string): boolean {
  const live = liveCompletionKinds(tableSql);
  return (
    live !== null &&
    live.length === ORIGINAL_ANALYSIS_COMPLETION_KINDS.length &&
    ORIGINAL_ANALYSIS_COMPLETION_KINDS.every(
      (kind, index) => live[index] === kind,
    )
  );
}

async function columnNames(
  db: LocalDb,
  schema: 'main' | 'temp',
  table: string,
): Promise<string[]> {
  const { rows } = await db.execute(`PRAGMA ${schema}.table_info(${table})`);
  return rows.map(row => String(row.name));
}

async function upgradeCompletionKinds(tx: LocalDb): Promise<void> {
  const { rows } = await tx.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    [ORIGINAL_ANALYSIS_OPERATIONS_TABLE],
  );
  const sql = rows[0]?.sql;
  if (typeof sql !== 'string') return;
  if (liveCompletionKinds(sql) === null || completionKindsMatchBuild(sql))
    return;
  await tx.execute('PRAGMA defer_foreign_keys = ON');
  await tx.execute(
    `CREATE TEMP TABLE ${BACKUP_TABLE} AS SELECT * FROM ${ORIGINAL_ANALYSIS_OPERATIONS_TABLE} ORDER BY rowid`,
  );
  await tx.execute(`DROP TABLE ${ORIGINAL_ANALYSIS_OPERATIONS_TABLE}`);
  await tx.execute(ORIGINAL_ANALYSIS_OPERATIONS_DDL);
  const columns = await columnNames(
    tx,
    'main',
    ORIGINAL_ANALYSIS_OPERATIONS_TABLE,
  );
  const saved = await columnNames(tx, 'temp', BACKUP_NAME);
  if (
    columns.length !== saved.length ||
    columns.some(column => !saved.includes(column))
  )
    throw new Error(
      'The stored original analysis operations do not match this build.',
    );
  const list = columns.map(column => `"${column}"`).join(', ');
  await tx.execute(
    `INSERT INTO ${ORIGINAL_ANALYSIS_OPERATIONS_TABLE} (${list}) SELECT ${list} FROM ${BACKUP_TABLE} ORDER BY rowid`,
  );
  await tx.execute(`DROP TABLE ${BACKUP_TABLE}`);
  for (const statement of ORIGINAL_ANALYSIS_DDL) await tx.execute(statement);
}

/** Runs at most one live-schema check per connection; a failed upgrade is
 * retried by the next caller instead of being remembered as done. */
export function ensureOriginalAnalysisSchema(db: LocalDb): Promise<void> {
  const pending = verified.get(db);
  if (pending) return pending;
  const upgrade = withTransaction(db, upgradeCompletionKinds);
  verified.set(db, upgrade);
  upgrade.catch(() => {
    if (verified.get(db) === upgrade) verified.delete(db);
  });
  return upgrade;
}
