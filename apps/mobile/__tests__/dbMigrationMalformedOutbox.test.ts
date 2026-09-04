/**
 * XC-ADJ-LP-1 (local-data half): a single non-JSON outbox payload must not
 * abort every subsequent database open.
 *
 * Runs the production getDb() (LOCAL_MIGRATIONS + ensureAccountScopedSchema)
 * against a REAL SQLite database (node:sqlite, Node 22) seeded with rows an
 * older build could have left behind. json_extract() raises "malformed JSON"
 * on invalid input, so the fixture-purge statement has to guard with
 * json_valid() or the app can never open its local store again.
 */
import type { LocalDb } from '../src/data/db';

// apps/mobile types only `jest` (no @types/node) so app code cannot lean on
// Node APIs; this test declares the exact node:sqlite surface it drives.
declare const require: (id: string) => unknown;

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
  run(...params: (string | number | null)[]): unknown;
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};

const mockState: { real: DatabaseSync | null } = { real: null };
const mockClose = jest.fn();

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const db = mockState.real;
    if (!db) throw new Error('test did not seed a database');
    return {
      executeSync: (sql: string) => ({ rows: db.prepare(sql).all() }),
      execute: async (sql: string, params: unknown[] = []) => ({
        rows: db.prepare(sql).all(...(params as (string | number | null)[])),
      }),
      close: mockClose,
    };
  },
}));

function loadGetDb(): () => LocalDb {
  let getDb: (() => LocalDb) | null = null;
  jest.isolateModules(() => {
    getDb =
      jest.requireActual<typeof import('../src/data/db')>(
        '../src/data/db',
      ).getDb;
  });
  if (!getDb) throw new Error('db module did not load');
  return getDb;
}

function seedCurrentSchemaWithOutbox(
  rows: { kind: string; payload: string }[],
) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     owner_key TEXT NOT NULL,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_error TEXT
   )`);
  const insert = db.prepare(
    `INSERT INTO outbox (owner_key, kind, payload) VALUES ('owner-a', ?, ?)`,
  );
  for (const row of rows) insert.run(row.kind, row.payload);
  return db;
}

beforeEach(() => {
  mockClose.mockClear();
  mockState.real = null;
});

afterEach(() => {
  mockState.real?.close();
  mockState.real = null;
});

describe('LOCAL_MIGRATIONS fixture purge with a malformed outbox payload', () => {
  it('opens, drops only fixture shot.sync rows and keeps real + non-JSON rows', async () => {
    mockState.real = seedCurrentSchemaWithOutbox([
      { kind: 'shot.sync', payload: '{"source":"real","id":"keep-real"}' },
      { kind: 'shot.sync', payload: '{"source":"fixture","id":"drop-me"}' },
      { kind: 'shot.sync', payload: '{"source":"real","id":"trunc' },
      { kind: 'shot.sync', payload: 'not json at all' },
      { kind: 'capture.sync', payload: '<binary garbage>' },
    ]);
    const getDb = loadGetDb();

    let db: LocalDb | null = null;
    expect(() => {
      db = getDb();
    }).not.toThrow();
    expect(mockClose).not.toHaveBeenCalled();

    const { rows } = await db!.execute(
      'SELECT kind, payload FROM outbox ORDER BY id',
    );
    expect(rows).toEqual([
      { kind: 'shot.sync', payload: '{"source":"real","id":"keep-real"}' },
      { kind: 'shot.sync', payload: '{"source":"real","id":"trunc' },
      { kind: 'shot.sync', payload: 'not json at all' },
      { kind: 'capture.sync', payload: '<binary garbage>' },
    ]);
    expect((await db!.execute('PRAGMA integrity_check')).rows).toEqual([
      { integrity_check: 'ok' },
    ]);
  });

  it('a malformed payload on a legacy outbox WITHOUT owner_key still migrates', async () => {
    const real = new DatabaseSync(':memory:');
    mockState.real = real;
    real.exec(`CREATE TABLE outbox (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       kind TEXT NOT NULL,
       payload TEXT NOT NULL,
       attempts INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       last_error TEXT
     )`);
    real.exec(
      `INSERT INTO outbox (kind, payload) VALUES ('shot.sync', '{oops')`,
    );
    real.exec(
      `INSERT INTO outbox (kind, payload) VALUES ('shot.sync', '{"source":"fixture"}')`,
    );
    const getDb = loadGetDb();

    const db = getDb();
    const { rows } = await db.execute(
      'SELECT owner_key, payload FROM outbox ORDER BY id',
    );
    expect(rows).toEqual([{ owner_key: 'device-guest', payload: '{oops' }]);
  });
});
