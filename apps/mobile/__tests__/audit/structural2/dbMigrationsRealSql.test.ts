/**
 * Structural audit (mobile-data-sync, pass 1) — `src/data/db.ts` executed
 * against REAL SQLite.
 *
 * Run: `cd apps/mobile && NODE_OPTIONS=--experimental-sqlite npx jest
 *       __tests__/audit/structural2/dbMigrationsRealSql.test.ts`
 *
 * Every existing db test fakes `executeSync`, so the DDL, the fixture-cleanup
 * DELETEs with `json_extract`, and the legacy table rebuild had never run on
 * Linux. These cases open `getDb()` over an in-memory database.
 */
/// <reference types="node" />
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LocalDb } from '../../../src/data/db';
import {
  opSqliteHandleFor,
  runSql,
} from '../../../test-support/audit/realSqliteLocalDb';

// A file-backed database: `openMigrated()` closes its handle when a migration
// throws, so the test inspects state through its own connection instead.
let dbDir: string | null = null;
let dbPath: string | null = null;
const mockOpen = jest.fn(() => {
  if (!dbPath) throw new Error('test did not provide a database');
  return opSqliteHandleFor(new DatabaseSync(dbPath));
});

jest.mock('@op-engineering/op-sqlite', () => ({ open: mockOpen }));

function loadGetDb(): () => LocalDb {
  const loaded: { getDb?: () => LocalDb } = {};
  jest.isolateModules(() => {
    loaded.getDb = jest.requireActual<typeof import('../../../src/data/db')>(
      '../../../src/data/db',
    ).getDb;
  });
  if (!loaded.getDb) throw new Error('db module did not load');
  return loaded.getDb;
}

function tableNames(raw: DatabaseSync): string[] {
  return runSql(
    raw,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).map(row => String(row['name']));
}

function primaryKey(raw: DatabaseSync, table: string): string[] {
  return runSql(raw, `PRAGMA table_info(${table})`)
    .filter(row => Number(row['pk']) > 0)
    .sort((a, b) => Number(a['pk']) - Number(b['pk']))
    .map(row => String(row['name']));
}

const SHOT_PAYLOAD = JSON.stringify({
  id: '11111111-1111-4111-8111-111111111111',
  source: 'real',
});

let inspector: DatabaseSync | null = null;

beforeEach(() => {
  mockOpen.mockClear();
  dbDir = mkdtempSync(join(tmpdir(), 'pickle-audit-db-'));
  dbPath = join(dbDir, 'pickle-sensei.db');
  inspector = new DatabaseSync(dbPath);
});

afterEach(() => {
  inspector?.close();
  inspector = null;
  if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  dbDir = null;
  dbPath = null;
});

describe('LOCAL_MIGRATIONS + ensureAccountScopedSchema on a fresh database', () => {
  it('creates every owner-scoped table with (owner_key, id) primary keys and enforces CHECK/UNIQUE', () => {
    const raw = inspector!;
    const getDb = loadGetDb();
    expect(() => getDb()).not.toThrow();
    expect(tableNames(raw)).toEqual([
      'kv',
      'local_analysis_record',
      'local_capture',
      'local_session',
      'local_shot',
      'outbox',
      'sync_receipt',
    ]);
    for (const table of ['local_shot', 'local_session', 'local_capture']) {
      expect(primaryKey(raw, table)).toEqual(['owner_key', 'id']);
    }
    expect(primaryKey(raw, 'sync_receipt')).toEqual([
      'owner_key',
      'kind',
      'entity_id',
    ]);
    const insertCapture = (id: string, uri: string, status: string) =>
      runSql(
        raw,
        `INSERT INTO local_capture (owner_key,id,uri,shot_type,captured_at,duration_ms,fps,width,height,status)
         VALUES ('o', ?, ?, 'drive', '2026-01-01T00:00:00.000Z', 1000, 30, 1080, 1920, ?)`,
        [id, uri, status],
      );
    insertCapture('c1', 'file:///a.mov', 'awaiting_model');
    expect(() => insertCapture('c2', 'file:///b.mov', 'done')).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insertCapture('c3', 'file:///a.mov', 'analyzed')).toThrow(
      /UNIQUE constraint failed: local_capture.owner_key, local_capture.uri/,
    );
    // Re-opening an already-migrated database is a no-op.
    expect(() => loadGetDb()()).not.toThrow();
    expect(mockOpen).toHaveBeenCalledTimes(2);
  });
});

describe('ensureAccountScopedSchema legacy rebuild', () => {
  it('moves rows of pre-account tables into the device-guest bucket and rebuilds the primary keys', () => {
    const raw = inspector!;
    // Schema as shipped before owner scoping: single-column primary keys, no
    // owner_key anywhere, local_capture without payload/declared_stroke/...
    runSql(
      raw,
      `CREATE TABLE local_shot (id TEXT PRIMARY KEY, session_id TEXT, shot_type TEXT NOT NULL,
         captured_at TEXT NOT NULL, overall_score REAL, confidence REAL NOT NULL,
         result_kind TEXT NOT NULL, source TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0,
         payload TEXT NOT NULL)`,
    );
    runSql(
      raw,
      `CREATE TABLE local_session (id TEXT PRIMARY KEY, mode TEXT NOT NULL, shot_type TEXT,
         focus_checkpoint TEXT, started_at TEXT NOT NULL, ended_at TEXT,
         completed INTEGER NOT NULL DEFAULT 0, summary TEXT)`,
    );
    runSql(
      raw,
      `CREATE TABLE local_capture (id TEXT PRIMARY KEY, uri TEXT NOT NULL UNIQUE, shot_type TEXT NOT NULL,
         captured_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, fps REAL NOT NULL,
         width INTEGER NOT NULL, height INTEGER NOT NULL,
         status TEXT NOT NULL CHECK (status IN ('awaiting_model','analyzed')))`,
    );
    runSql(
      raw,
      `CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
         payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT)`,
    );
    runSql(
      raw,
      `INSERT INTO local_shot (id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite, payload)
       VALUES ('s1', 'sess', 'drive', '2026-01-01T00:00:00.000Z', 7.5, 0.9, 'scored', 'real', 1, '{}')`,
    );
    runSql(
      raw,
      `INSERT INTO local_session (id, mode, started_at, completed) VALUES ('sess', 'live', '2026-01-01T00:00:00.000Z', 1)`,
    );
    runSql(
      raw,
      `INSERT INTO local_capture (id, uri, shot_type, captured_at, duration_ms, fps, width, height, status)
       VALUES ('c1', 'file:///a.mov', 'drive', '2026-01-01T00:00:00.000Z', 1000, 30, 1080, 1920, 'analyzed')`,
    );
    runSql(raw, `INSERT INTO outbox (kind, payload) VALUES ('shot.sync', ?)`, [
      SHOT_PAYLOAD,
    ]);

    expect(() => loadGetDb()()).not.toThrow();

    for (const table of ['local_shot', 'local_session', 'local_capture']) {
      expect(primaryKey(raw, table)).toEqual(['owner_key', 'id']);
    }
    expect(
      runSql(raw, `SELECT owner_key, id, favorite FROM local_shot`),
    ).toEqual([{ owner_key: 'device-guest', id: 's1', favorite: 1 }]);
    expect(runSql(raw, `SELECT owner_key, id FROM local_session`)).toEqual([
      { owner_key: 'device-guest', id: 'sess' },
    ]);
    expect(
      runSql(
        raw,
        `SELECT owner_key, id, payload, declared_stroke, target_seed, training_consent FROM local_capture`,
      ),
    ).toEqual([
      {
        owner_key: 'device-guest',
        id: 'c1',
        payload: null,
        declared_stroke: null,
        target_seed: null,
        training_consent: 'not_asked',
      },
    ]);
    expect(runSql(raw, `SELECT owner_key, kind FROM outbox`)).toEqual([
      { owner_key: 'device-guest', kind: 'shot.sync' },
    ]);
    // Temporary rebuild tables never survive.
    expect(tableNames(raw).filter(n => n.endsWith('_account_v2'))).toEqual([]);
  });
});

describe('fixture-cleanup DELETEs run on every launch (db.ts LOCAL_MIGRATIONS tail)', () => {
  it('one malformed shot.sync payload in the outbox must not make getDb() fail on every launch', () => {
    const raw = inspector!;
    loadGetDb()();
    runSql(
      raw,
      `INSERT INTO outbox (owner_key, kind, payload) VALUES ('owner-a', 'shot.sync', ?)`,
      [SHOT_PAYLOAD],
    );
    runSql(
      raw,
      `INSERT INTO outbox (owner_key, kind, payload) VALUES ('owner-a', 'shot.sync', ?)`,
      ['{"id":"truncated-by-a-crash"'],
    );
    // sync.ts promises "a corrupt outbox row fails alone without poisoning
    // the batch"; the open path must honour the same contract, otherwise the
    // whole local store (history, progress, captures, kv) is unreachable.
    let openError: unknown = null;
    let reopenError: unknown = null;
    try {
      loadGetDb()();
    } catch (error) {
      openError = error;
    }
    try {
      loadGetDb()();
    } catch (error) {
      reopenError = error;
    }
    expect({
      openError: openError === null ? null : String(openError),
      reopenError: reopenError === null ? null : String(reopenError),
      healthyRowSurvives: runSql(
        raw,
        `SELECT count(*) AS n FROM outbox WHERE payload = ?`,
        [SHOT_PAYLOAD],
      ),
    }).toEqual({
      openError: null,
      reopenError: null,
      healthyRowSurvives: [{ n: 1 }],
    });
  });

  it('an incomplete session that has no shot yet must survive a relaunch while its session.create row is still queued', () => {
    const raw = inspector!;
    loadGetDb()();
    // A live session was started (row + session.create queued) and the app
    // was killed before the first shot landed.
    runSql(
      raw,
      `INSERT INTO local_session (owner_key, id, mode, started_at, completed)
       VALUES ('owner-a', 'sess-1', 'live', '2026-01-01T00:00:00.000Z', 0)`,
    );
    runSql(
      raw,
      `INSERT INTO outbox (owner_key, kind, payload) VALUES ('owner-a', 'session.create', ?)`,
      [JSON.stringify({ id: 'sess-1', mode: 'live' })],
    );
    // Another account's completed session mentioning "fixture" in free text.
    runSql(
      raw,
      `INSERT INTO local_session (owner_key, id, mode, started_at, completed, summary)
       VALUES ('owner-b', 'sess-2', 'live', '2026-01-01T00:00:00.000Z', 1, '{"note":"court fixture lights were dim"}')`,
    );

    loadGetDb()();

    expect({
      sessions: runSql(
        raw,
        `SELECT owner_key, id FROM local_session ORDER BY owner_key`,
      ),
      queuedSessionCreates: runSql(
        raw,
        `SELECT count(*) AS n FROM outbox WHERE kind = 'session.create'`,
      ),
    }).toEqual({
      sessions: [
        { owner_key: 'owner-a', id: 'sess-1' },
        { owner_key: 'owner-b', id: 'sess-2' },
      ],
      queuedSessionCreates: [{ n: 1 }],
    });
  });
});
