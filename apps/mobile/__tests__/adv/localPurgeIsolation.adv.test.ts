// Key-builder modules value-import getDb; the real schema under test comes
// from createSqliteTestDb (requireActual of src/data/db on node:sqlite).
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { purgeOwnerData } from '../../src/data/repository';
import { profileKeyForOwner } from '../../src/data/accountScope';
import { rankCelebrationKeyForOwner } from '../../src/progress/rankCelebration';
import { notificationPrefsKeyForOwner } from '../../src/notifications/types';
import { consistencyKeyForOwner } from '../../src/consistency/store';
import { practiceSetKeyForOwner } from '../../src/analysis/practiceSet';
import { pendingFulfilmentKeyForOwner } from '../../src/billing/pendingFulfilment';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
} from '../../testSupport/sqlite';

/**
 * INT-deletion-managed-media adversary: the post-deletion local purge.
 *
 * Attacks, all against the REAL SQLite schema (`src/data/db.ts` migrations
 * through `getDb()` on node:sqlite):
 *   - owner isolation: deleting A must not touch B's rows or B's kv keys;
 *   - schema drift: every table carrying an `owner_key` column and every
 *     owner-qualified kv key builder in `src/` must be covered by the purge;
 *   - atomicity: a mid-purge SQLite failure must leave A's bucket intact
 *     (never half-deleted), and a retry must then succeed.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const OWNER_KEY_BUILDERS: ReadonlyArray<(owner: string) => string> = [
  profileKeyForOwner,
  rankCelebrationKeyForOwner,
  notificationPrefsKeyForOwner,
  consistencyKeyForOwner,
  practiceSetKeyForOwner,
  pendingFulfilmentKeyForOwner,
];

function seedOwner(
  f: ReturnType<typeof createSqliteTestDb>,
  owner: string,
): void {
  const n = f.native;
  n.prepare(
    `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite, payload)
     VALUES (?, ?, ?, 'forehand_drive', '2026-09-01T00:00:00.000Z', 61, 0.9, 'scored', 'real', 0, '{}')`,
  ).run(owner, `shot-${owner}`, `session-${owner}`);
  n.prepare(
    `INSERT INTO local_session (owner_key, id, mode, started_at, completed)
     VALUES (?, ?, 'guided', '2026-09-01T00:00:00.000Z', 1)`,
  ).run(owner, `session-${owner}`);
  n.prepare(
    `INSERT INTO local_capture (owner_key, id, uri, shot_type, captured_at, duration_ms, fps, width, height, status)
     VALUES (?, ?, ?, 'forehand_drive', '2026-09-01T00:00:00.000Z', 4000, 30, 1080, 1920, 'analyzed')`,
  ).run(owner, `capture-${owner}`, `file:///clips/${owner}.mov`);
  n.prepare(
    `INSERT INTO local_analysis_record (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
     VALUES (?, ?, ?, '2026-09-01T00:00:00.000Z', 'e1', 'm1', '{}')`,
  ).run(owner, `record-${owner}`, `capture-${owner}`);
  n.prepare(
    `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', '{"source":"real"}')`,
  ).run(owner);
  n.prepare(
    `INSERT INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot', ?)`,
  ).run(owner, `shot-${owner}`);
  for (const build of OWNER_KEY_BUILDERS) {
    n.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(
      build(owner),
      `${owner}-value`,
    );
  }
}

function ownerTables(f: ReturnType<typeof createSqliteTestDb>): string[] {
  const tables = f.native
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all()
    .map(row => String(row['name']));
  return tables
    .filter(table =>
      f.native
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some(column => column['name'] === 'owner_key'),
    )
    .sort();
}

function ownerFootprint(
  f: ReturnType<typeof createSqliteTestDb>,
  owner: string,
): Record<string, number> {
  const footprint: Record<string, number> = {};
  for (const table of ownerTables(f)) footprint[table] = f.count(table, owner);
  footprint.kv = Number(
    f.native
      .prepare(`SELECT count(*) AS n FROM kv WHERE key LIKE '%:' || ?`)
      .get(owner)?.n,
  );
  return footprint;
}

afterEach(() => closeSqliteTestDatabases());

describe('ADV local purge', () => {
  it('PASS deletes only the deleted owner: B keeps every row and kv key', async () => {
    const f = createSqliteTestDb();
    seedOwner(f, A);
    seedOwner(f, B);
    const before = ownerFootprint(f, B);
    expect(Object.values(before).some(n => n > 0)).toBe(true);

    await purgeOwnerData(f.db, A);

    expect(ownerFootprint(f, B)).toEqual(before);
    for (const [table, n] of Object.entries(ownerFootprint(f, A))) {
      expect({ table, n }).toEqual({ table, n: 0 });
    }
    for (const build of OWNER_KEY_BUILDERS) {
      expect(
        f.native.prepare('SELECT value FROM kv WHERE key = ?').get(build(A)),
      ).toBeUndefined();
      expect(
        f.native.prepare('SELECT value FROM kv WHERE key = ?').get(build(B)),
      ).toEqual({ value: `${B}-value` });
    }
  });

  it('PASS every owner_key table in the real schema and every owner-qualified kv key builder is covered by the purge', async () => {
    const f = createSqliteTestDb();
    await purgeOwnerData(f.db, A);
    const purgedTables = f.calls
      .map(call => /^DELETE FROM (\w+) WHERE owner_key = \?$/.exec(call.sql))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => m[1]!)
      .sort();
    expect(purgedTables).toEqual(ownerTables(f));

    const purgedKeys = f.calls
      .filter(call => call.sql === 'DELETE FROM kv WHERE key = ?')
      .map(call => String(call.params[0]))
      .sort();
    expect(purgedKeys).toEqual(
      OWNER_KEY_BUILDERS.map(build => build(A)).sort(),
    );
  });

  it('PASS a mid-purge SQLite failure rolls back atomically and a retry completes', async () => {
    const f = createSqliteTestDb();
    seedOwner(f, A);
    seedOwner(f, B);
    const aBefore = ownerFootprint(f, A);
    const bBefore = ownerFootprint(f, B);
    f.failStatementOnce('DELETE FROM outbox', new Error('disk I/O error'));

    await expect(purgeOwnerData(f.db, A)).rejects.toThrow('disk I/O error');

    // Nothing of A is half-gone: local_shot etc. were deleted inside the
    // transaction before the fault and must be back.
    expect(ownerFootprint(f, A)).toEqual(aBefore);
    expect(ownerFootprint(f, B)).toEqual(bBefore);
    expect(f.calls.map(c => c.sql)).toContain('ROLLBACK');

    await purgeOwnerData(f.db, A);
    expect(Object.values(ownerFootprint(f, A)).every(n => n === 0)).toBe(true);
    expect(ownerFootprint(f, B)).toEqual(bBefore);
  });

  it('PASS purging an owner with no rows is a no-op that leaves other owners untouched', async () => {
    const f = createSqliteTestDb();
    seedOwner(f, B);
    const bBefore = ownerFootprint(f, B);
    await purgeOwnerData(f.db, A);
    await purgeOwnerData(f.db, A);
    expect(ownerFootprint(f, B)).toEqual(bBefore);
  });

  it('PASS a hostile owner key cannot widen the purge (bound parameter, never interpolated)', async () => {
    const f = createSqliteTestDb();
    seedOwner(f, A);
    seedOwner(f, B);
    const bBefore = ownerFootprint(f, B);
    await purgeOwnerData(f.db, `${A}' OR '1'='1`);
    await purgeOwnerData(f.db, '%');
    expect(ownerFootprint(f, A)).not.toEqual(
      Object.fromEntries(Object.keys(bBefore).map(k => [k, 0])),
    );
    expect(ownerFootprint(f, B)).toEqual(bBefore);
    expect(
      f.calls
        .filter(call => call.sql.startsWith('DELETE FROM'))
        .every(call => call.sql.endsWith('= ?')),
    ).toBe(true);
  });
});
