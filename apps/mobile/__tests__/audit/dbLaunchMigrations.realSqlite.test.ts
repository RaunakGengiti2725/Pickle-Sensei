/// <reference types="node" />
/**
 * Structural audit (mobile-data-sync, pass 1) — `src/data/db.ts` launch path
 * executed against a REAL SQLite connection (node:sqlite) instead of a fake.
 *
 * Covers what no other suite executes: the DDL in LOCAL_MIGRATIONS, the
 * fixture DELETEs (incl. `json_extract`), the legacy (pre-account) table
 * rebuild in ensureAccountScopedSchema, and the handle-caching contract.
 *
 * Suspected defect under test (db.ts:95): the fixture sweep evaluates
 * `json_extract(payload, '$.source')` over EVERY shot.sync outbox row on
 * EVERY launch. SQLite raises "malformed JSON" for a non-JSON payload, so one
 * bad row makes getDb() throw on every launch — the drain's "a corrupt row
 * fails alone" contract (sync.ts:188-211) is never reached.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalDb } from '../../src/data/db';
import { GUEST_DATA_OWNER } from '../../src/data/accountScope';
import {
  openRealSqlite,
  type RealSqliteHandle,
} from '../../audit-support/realSqlite';

const mockState: { handle: RealSqliteHandle | null; opens: number } = {
  handle: null,
  opens: 0,
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    mockState.opens += 1;
    if (!mockState.handle) throw new Error('audit harness: no handle');
    return mockState.handle;
  },
}));

function loadGetDb(): () => LocalDb {
  let getDb: (() => LocalDb) | null = null;
  jest.isolateModules(() => {
    getDb =
      jest.requireActual<typeof import('../../src/data/db')>(
        '../../src/data/db',
      ).getDb;
  });
  if (!getDb) throw new Error('db module did not load');
  return getDb;
}

/** File-backed database so data survives the close() a failed launch performs. */
function fileBackedPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'pickle-audit-')), 'pickle-sensei.db');
}

function tableNames(handle: RealSqliteHandle): string[] {
  return handle
    .executeSync(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .rows.map(row => String(row['name']));
}

function primaryKey(handle: RealSqliteHandle, table: string): string[] {
  return handle
    .executeSync(`PRAGMA table_info(${table})`)
    .rows.filter(row => Number(row['pk']) > 0)
    .sort((a, b) => Number(a['pk']) - Number(b['pk']))
    .map(row => String(row['name']));
}

describe('db.ts launch migrations on a real SQLite connection', () => {
  beforeEach(() => {
    mockState.handle = openRealSqlite();
    mockState.opens = 0;
  });

  afterEach(() => {
    try {
      mockState.handle?.close();
    } catch {
      // already closed by the code under test
    }
    mockState.handle = null;
  });

  it('VERIFIED: a fresh database gets every owner-scoped table, index and PK', () => {
    const getDb = loadGetDb();
    expect(() => getDb()).not.toThrow();
    const handle = mockState.handle!;
    expect(tableNames(handle)).toEqual([
      'kv',
      'local_analysis_record',
      'local_capture',
      'local_session',
      'local_shot',
      'outbox',
      'sync_receipt',
    ]);
    for (const table of [
      'local_shot',
      'local_session',
      'local_capture',
      'local_analysis_record',
    ]) {
      expect(primaryKey(handle, table)).toEqual(['owner_key', 'id']);
    }
    expect(primaryKey(handle, 'sync_receipt')).toEqual([
      'owner_key',
      'kind',
      'entity_id',
    ]);
    const indexes = handle
      .executeSync(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`,
      )
      .rows.map(row => String(row['name']));
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_local_analysis_capture',
        'idx_local_capture_owner_time',
        'idx_local_shot_owner_time',
        'idx_outbox_owner_created',
      ]),
    );
    // No transaction left open by the schema step.
    expect(() => handle.executeSync('BEGIN IMMEDIATE')).not.toThrow();
    handle.executeSync('ROLLBACK');
  });

  it('VERIFIED: the migrated handle is cached and a second launch is idempotent', () => {
    const getDb = loadGetDb();
    getDb();
    getDb();
    expect(mockState.opens).toBe(1);
    // A second process launch over the same file must also succeed.
    const again = loadGetDb();
    expect(() => again()).not.toThrow();
    expect(mockState.opens).toBe(2);
  });

  it('VERIFIED: a pre-account (legacy) database is rebuilt onto (owner_key,id) PKs and rows land in the guest bucket', () => {
    const handle = mockState.handle!;
    // Schema as shipped by the first data layer (commit c297902).
    handle.executeSync(
      `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    handle.executeSync(`CREATE TABLE local_shot (
      id TEXT PRIMARY KEY, session_id TEXT, shot_type TEXT NOT NULL,
      captured_at TEXT NOT NULL, overall_score REAL, confidence REAL NOT NULL,
      result_kind TEXT NOT NULL, source TEXT NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL)`);
    handle.executeSync(
      `CREATE INDEX idx_local_shot_time ON local_shot (captured_at DESC)`,
    );
    handle.executeSync(`CREATE TABLE local_session (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, shot_type TEXT,
      focus_checkpoint TEXT, started_at TEXT NOT NULL, ended_at TEXT,
      completed INTEGER NOT NULL DEFAULT 0, summary TEXT)`);
    handle.executeSync(`CREATE TABLE local_capture (
      id TEXT PRIMARY KEY, uri TEXT NOT NULL UNIQUE, shot_type TEXT NOT NULL,
      captured_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, fps REAL NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('awaiting_model','analyzed')))`);
    handle.executeSync(`CREATE TABLE outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
      payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT)`);
    handle.executeSync(
      `INSERT INTO local_shot (id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
       VALUES ('shot-real', 'sess-1', 'forehand_drive', '2026-08-01T00:00:00.000Z', 7.1, 0.9, 'scored', 'real', '{"id":"shot-real","source":"real"}'),
              ('shot-fixture', NULL, 'forehand_drive', '2026-08-01T00:00:00.000Z', 6.0, 0.9, 'scored', 'fixture', '{"id":"shot-fixture","source":"fixture"}')`,
    );
    handle.executeSync(
      `INSERT INTO local_session (id, mode, started_at, completed, summary)
       VALUES ('sess-1', 'practice_set', '2026-08-01T00:00:00.000Z', 0, NULL),
              ('sess-orphan', 'practice_set', '2026-08-01T00:00:00.000Z', 0, NULL),
              ('sess-done', 'practice_set', '2026-08-01T00:00:00.000Z', 1, '{"ok":true}')`,
    );
    handle.executeSync(
      `INSERT INTO local_capture (id, uri, shot_type, captured_at, duration_ms, fps, width, height, status)
       VALUES ('cap-1', 'file:///a.mov', 'forehand_drive', '2026-08-01T00:00:00.000Z', 2000, 30, 1080, 1920, 'analyzed')`,
    );
    handle.executeSync(
      `INSERT INTO outbox (kind, payload) VALUES
        ('shot.sync', '{"id":"shot-real","source":"real","analysisPermitId":"p"}'),
        ('shot.sync', '{"id":"shot-fixture","source":"fixture"}'),
        ('session.create', '{"id":"sess-1"}')`,
    );

    const getDb = loadGetDb();
    expect(() => getDb()).not.toThrow();

    for (const table of ['local_shot', 'local_session', 'local_capture']) {
      expect(primaryKey(handle, table)).toEqual(['owner_key', 'id']);
    }
    expect(
      handle.executeSync(`SELECT owner_key, id FROM local_shot ORDER BY id`)
        .rows,
    ).toEqual([{ owner_key: GUEST_DATA_OWNER, id: 'shot-real' }]);
    expect(
      handle.executeSync(`SELECT owner_key, id FROM local_session ORDER BY id`)
        .rows,
    ).toEqual([
      { owner_key: GUEST_DATA_OWNER, id: 'sess-1' },
      { owner_key: GUEST_DATA_OWNER, id: 'sess-done' },
    ]);
    expect(
      handle.executeSync(
        `SELECT owner_key, id, payload, declared_stroke, target_seed, training_consent FROM local_capture`,
      ).rows,
    ).toEqual([
      {
        owner_key: GUEST_DATA_OWNER,
        id: 'cap-1',
        payload: null,
        declared_stroke: null,
        target_seed: null,
        training_consent: 'not_asked',
      },
    ]);
    expect(
      handle.executeSync(`SELECT owner_key, kind FROM outbox ORDER BY id`).rows,
    ).toEqual([
      { owner_key: GUEST_DATA_OWNER, kind: 'shot.sync' },
      { owner_key: GUEST_DATA_OWNER, kind: 'session.create' },
    ]);
    expect(tableNames(handle)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('_account_v2')]),
    );
    // Second launch over the migrated file is a no-op.
    expect(() => loadGetDb()()).not.toThrow();
  });

  it('VERIFIED: the legacy rebuild is atomic — a failure mid-rebuild leaves the legacy tables intact', () => {
    const file = fileBackedPath();
    mockState.handle = openRealSqlite(file);
    let handle = mockState.handle;
    handle.executeSync(`CREATE TABLE local_shot (
      id TEXT PRIMARY KEY, session_id TEXT, shot_type TEXT NOT NULL,
      captured_at TEXT NOT NULL, overall_score REAL, confidence REAL NOT NULL,
      result_kind TEXT NOT NULL, source TEXT NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL)`);
    handle.executeSync(
      `INSERT INTO local_shot (id, shot_type, captured_at, confidence, result_kind, source, payload)
       VALUES ('shot-real', 'forehand_drive', '2026-08-01T00:00:00.000Z', 0.9, 'scored', 'real', '{}')`,
    );
    // local_capture is legacy AND lacks a column the rebuild copies (`status`),
    // so the third rebuild step throws after local_shot was already rebuilt.
    handle.executeSync(`CREATE TABLE local_capture (
      id TEXT PRIMARY KEY, uri TEXT NOT NULL UNIQUE, shot_type TEXT NOT NULL,
      captured_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, fps REAL NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL)`);
    const getDb = loadGetDb();
    expect(() => getDb()).toThrow(/no such column: status/);
    // The failed handle was closed (fix-27 contract); inspect the file anew.
    handle = openRealSqlite(file);
    mockState.handle = handle;
    // Rolled back: legacy local_shot still has its single-column PK and row.
    expect(primaryKey(handle, 'local_shot')).toEqual(['id']);
    expect(
      handle.executeSync(`SELECT count(*) AS n FROM local_shot`).rows,
    ).toEqual([{ n: 1 }]);
    expect(
      handle.executeSync(
        `SELECT name FROM sqlite_master WHERE name LIKE '%_account_v2'`,
      ).rows,
    ).toEqual([]);
  });

  it('VERIFIED: the fixture sweep removes non-real shots/outbox rows and orphaned incomplete sessions only', () => {
    const getDb = loadGetDb();
    getDb();
    const handle = mockState.handle!;
    handle.executeSync(
      `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at, confidence, result_kind, source, payload) VALUES
        ('o', 'real-1', 'kept-session', 'forehand_drive', '2026-08-01T00:00:00.000Z', 0.9, 'scored', 'real', '{}'),
        ('o', 'fixture-1', 'fixture-session', 'forehand_drive', '2026-08-01T00:00:00.000Z', 0.9, 'scored', 'fixture', '{}')`,
    );
    handle.executeSync(
      `INSERT INTO local_session (owner_key, id, mode, started_at, completed, summary) VALUES
        ('o', 'kept-session', 'practice_set', '2026-08-01T00:00:00.000Z', 0, NULL),
        ('o', 'fixture-session', 'practice_set', '2026-08-01T00:00:00.000Z', 0, NULL),
        ('o', 'finished-no-shots', 'practice_set', '2026-08-01T00:00:00.000Z', 1, '{"shots":0}')`,
    );
    handle.executeSync(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES
        ('o', 'shot.sync', '{"id":"real-1","source":"real"}'),
        ('o', 'shot.sync', '{"id":"fixture-1","source":"fixture"}'),
        ('o', 'shot.sync', '{"id":"no-source"}'),
        ('o', 'session.create', '{"id":"kept-session"}')`,
    );
    // Simulate the next launch (the cached handle is process-local).
    loadGetDb()();
    expect(
      handle.executeSync(`SELECT id FROM local_shot ORDER BY id`).rows,
    ).toEqual([{ id: 'real-1' }]);
    expect(
      handle.executeSync(`SELECT id FROM local_session ORDER BY id`).rows,
    ).toEqual([{ id: 'finished-no-shots' }, { id: 'kept-session' }]);
    // A shot.sync payload without `$.source` is NOT swept (NULL <> 'real' is NULL).
    expect(
      handle.executeSync(`SELECT kind, payload FROM outbox ORDER BY id`).rows,
    ).toEqual([
      { kind: 'shot.sync', payload: '{"id":"real-1","source":"real"}' },
      { kind: 'shot.sync', payload: '{"id":"no-source"}' },
      { kind: 'session.create', payload: '{"id":"kept-session"}' },
    ]);
  });

  it('FINDING db.ts:95 — one non-JSON shot.sync payload must not make every launch fail (corrupt rows fail alone)', () => {
    const file = fileBackedPath();
    mockState.handle = openRealSqlite(file);
    const getDb = loadGetDb();
    const db = getDb();
    const handle = mockState.handle;
    // A durable row whose payload is not JSON (torn write, partial disk
    // corruption, or any writer that is not JSON.stringify).
    handle.executeSync(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES ('o', 'shot.sync', 'not json')`,
    );
    handle.executeSync(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES ('o', 'shot.sync', '{"id":"healthy","source":"real","analysisPermitId":"p"}')`,
    );
    db.close();

    // Next launch: LOCAL_MIGRATIONS runs the fixture sweep with json_extract.
    mockState.handle = openRealSqlite(file);
    const relaunch = loadGetDb();
    let launchError: unknown = null;
    try {
      relaunch();
    } catch (error) {
      launchError = error;
    }
    // Evidence for the report: SQLite's exact error text.
    if (launchError) {
      expect(String((launchError as Error).message)).toMatch(/malformed JSON/i);
    }
    // Expected contract: the launch succeeds and the healthy row is still
    // drainable; only the corrupt row may be quarantined.
    expect(launchError).toBeNull();
    expect(
      mockState.handle!.executeSync(
        `SELECT count(*) AS n FROM outbox WHERE payload LIKE '{"id":"healthy"%'`,
      ).rows,
    ).toEqual([{ n: 1 }]);
  });
});
