/**
 * In-memory `LocalDb` for fuzzing. It models exactly what the repository
 * layer observes from op-sqlite — rows of arbitrary JS values — without a SQL
 * engine: kv statements are honoured against a Map (values may be any type,
 * mirroring typed columns), every other SELECT returns the rows seeded for
 * that table, and writes are logged verbatim so a test can assert that a
 * corrupt row was quarantined (`UPDATE outbox …`) rather than retried forever.
 */
import type { LocalDb } from '../../src/data/db';

export interface ExecutedStatement {
  sql: string;
  params: unknown[];
}

export class FuzzDb implements LocalDb {
  readonly kv = new Map<string, unknown>();
  readonly tables = new Map<string, Record<string, unknown>[]>();
  readonly log: ExecutedStatement[] = [];
  /** Statements matching this pattern reject like a driver I/O error. */
  failOn: RegExp | null = null;
  closed = false;

  seed(table: string, rows: Record<string, unknown>[]): void {
    this.tables.set(table, rows);
  }

  reset(): void {
    this.kv.clear();
    this.tables.clear();
    this.log.length = 0;
    this.failOn = null;
    this.closed = false;
  }

  statements(pattern: RegExp): ExecutedStatement[] {
    return this.log.filter(entry => pattern.test(entry.sql));
  }

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const statement = sql.trim().replace(/\s+/g, ' ');
    this.log.push({ sql: statement, params });
    if (this.failOn && this.failOn.test(statement)) {
      throw new Error(
        `fuzz: injected driver failure for ${statement.slice(0, 40)}`,
      );
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(statement)) return { rows: [] };

    if (statement.startsWith('SELECT value FROM kv WHERE key = ?')) {
      const key = String(params[0]);
      if (!this.kv.has(key)) return { rows: [] };
      return { rows: [{ value: this.kv.get(key) }] };
    }
    if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
      this.kv.set(String(params[0]), params[1]);
      return { rows: [] };
    }
    if (/^DELETE FROM kv WHERE key = \?/.test(statement)) {
      this.kv.delete(String(params[0]));
      return { rows: [] };
    }
    if (/^DELETE FROM kv WHERE key LIKE \?/.test(statement)) {
      const prefix = String(params[0]).replace(/%$/, '');
      for (const key of Array.from(this.kv.keys())) {
        if (key.startsWith(prefix)) this.kv.delete(key);
      }
      return { rows: [] };
    }

    const select = /^SELECT .*? FROM ([a-z_]+)/i.exec(statement);
    if (select) {
      const table = select[1] as string;
      return { rows: this.tables.get(table) ?? [] };
    }
    return { rows: [] };
  }

  close(): void {
    this.closed = true;
  }
}
