/**
 * XC journey-offline-first harness: a REAL SQLite `LocalDb` for jest.
 *
 * The production store (`src/data/db.ts`) opens op-sqlite, which needs a
 * native module and cannot load under jest. Every existing sync test drives a
 * hand-written fake that pattern-matches SQL strings; that cannot prove
 * transaction semantics (BEGIN IMMEDIATE / ROLLBACK), `json_extract`
 * lookups, AUTOINCREMENT ordering or the `LIMIT 50` drain window. This
 * adapter runs the SAME schema statements the app applies (`LOCAL_MIGRATIONS`
 * is read verbatim out of `src/data/db.ts`) against Node's built-in
 * `node:sqlite` (Node >= 22.13) so the repository + sync engine execute real
 * SQL end to end.
 */
import type { LocalDb } from '../../src/data/db';
import { nodeFs, nodePath } from './nodeRuntime';

/** The subset of `node:sqlite` the harness uses (the RN tsconfig ships no
 * Node type definitions, mirroring `__tests__/wf/*` which `require('fs')`). */
export interface SqliteStatement {
  all(...params: Array<null | number | string | bigint>): unknown[];
  run(...params: Array<null | number | string | bigint>): unknown;
}
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (location: string) => SqliteDatabase;
}

declare const __dirname: string;

export interface SqliteLocalDb extends LocalDb {
  readonly raw: SqliteDatabase;
  /** Every statement executed, in order (for replay artifacts). */
  readonly statementLog: Array<{ sql: string; params: unknown[] }>;
  /** Number of statements executed so far. */
  statementCount(): number;
}

let cachedMigrations: string[] | null = null;

/**
 * The app's `LOCAL_MIGRATIONS` array, extracted from the production source so
 * the harness can never drift from the shipped schema without failing loudly.
 */
export function productionLocalMigrations(): string[] {
  if (cachedMigrations) return cachedMigrations;
  const source = nodeFs.readFileSync(
    nodePath.join(__dirname, '..', '..', 'src', 'data', 'db.ts'),
    'utf8',
  );
  const start = source.indexOf('const LOCAL_MIGRATIONS: string[] = [');
  const end = source.indexOf('\n];', start);
  if (start < 0 || end < 0) {
    throw new Error('LOCAL_MIGRATIONS block not found in src/data/db.ts');
  }
  const block = source.slice(start, end);
  const statements: string[] = [];
  const template = /`([^`]*)`/g;
  let match: RegExpExecArray | null;
  while ((match = template.exec(block)) !== null) {
    statements.push(match[1] ?? '');
  }
  if (statements.length < 8) {
    throw new Error(
      `expected >= 8 LOCAL_MIGRATIONS statements, extracted ${statements.length}`,
    );
  }
  cachedMigrations = statements;
  return statements;
}

export function nodeSqliteAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

function bind(params: unknown[]): Array<null | number | string | bigint> {
  return params.map(value => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (
      typeof value === 'number' ||
      typeof value === 'string' ||
      typeof value === 'bigint'
    ) {
      return value;
    }
    return JSON.stringify(value);
  });
}

const RETURNS_ROWS = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i;
const TRANSACTION_CONTROL =
  /^\s*(BEGIN|COMMIT|ROLLBACK|END|SAVEPOINT|RELEASE)\b/i;

/** Opens an in-memory SQLite database with the production local schema. */
export function openSqliteLocalDb(): SqliteLocalDb {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqlite = require('node:sqlite') as NodeSqliteModule;
  const raw = new sqlite.DatabaseSync(':memory:');
  for (const statement of productionLocalMigrations()) {
    raw.exec(statement);
  }
  const statementLog: Array<{ sql: string; params: unknown[] }> = [];
  return {
    raw,
    statementLog,
    statementCount: () => statementLog.length,
    async execute(sql: string, params: unknown[] = []) {
      statementLog.push({ sql, params });
      if (TRANSACTION_CONTROL.test(sql)) {
        raw.exec(sql);
        return { rows: [] };
      }
      const statement = raw.prepare(sql);
      if (RETURNS_ROWS.test(sql)) {
        const rows = statement.all(...bind(params)) as Record<
          string,
          unknown
        >[];
        return { rows };
      }
      statement.run(...bind(params));
      return { rows: [] };
    },
    close() {
      raw.close();
    },
  };
}

/** Full durable snapshot of the tables the journey touches. */
export function snapshotLocalState(db: SqliteLocalDb): {
  localShots: Record<string, unknown>[];
  localSessions: Record<string, unknown>[];
  outbox: Record<string, unknown>[];
  receipts: Record<string, unknown>[];
} {
  const all = (sql: string) =>
    db.raw.prepare(sql).all() as Record<string, unknown>[];
  return {
    localShots: all(
      'SELECT owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite, payload FROM local_shot ORDER BY owner_key, id',
    ),
    localSessions: all(
      'SELECT owner_key, id, mode, shot_type, focus_checkpoint, started_at, ended_at, completed, summary FROM local_session ORDER BY owner_key, id',
    ),
    outbox: all(
      'SELECT id, owner_key, kind, payload, attempts, last_error FROM outbox ORDER BY id',
    ),
    receipts: all(
      'SELECT owner_key, kind, entity_id FROM sync_receipt ORDER BY owner_key, kind, entity_id',
    ),
  };
}
