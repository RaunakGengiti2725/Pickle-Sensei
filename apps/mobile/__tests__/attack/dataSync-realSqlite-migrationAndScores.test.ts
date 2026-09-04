/**
 * ADVERSARIAL TESTER #2 (pass 3) — mobile-data-sync against a REAL SQLite.
 *
 * `@op-engineering/op-sqlite`'s `open()` is replaced by a synchronous bridge
 * to a real `python3 sqlite3` process (scripts/attack/realSqliteBridge.ts), so
 * `getDb()` in src/data/db.ts runs its actual LOCAL_MIGRATIONS +
 * ensureAccountScopedSchema against a real database file — no SQL is faked.
 *
 * Scenarios:
 *  S3  a `shot.sync` outbox row whose payload is '{not json' vs the
 *      json_extract DELETE migration (db.ts:95) → does getDb() fail on every
 *      launch?
 *  S4  local_shot rows with result_kind='scored' and overall_score NaN /
 *      'abc' / +Inf → do recentScores / listShots / listActivityShots omit
 *      them or coerce them into numbers?
 *
 * Every assertion below states what the code at 4d812e1a DOES; the ones that
 * pin a defect are labelled ATTACK RESULT so the coordinator can flip them
 * when the fix lands.
 */
import {
  attackArtifactExists,
  RealSqlite,
  writeAttackArtifact,
} from '../../scripts/attack/realSqliteBridge';

let mockOpenImpl: () => unknown = () => {
  throw new Error('bridge not ready');
};
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => mockOpenImpl(),
}));

// Imported AFTER the mock so db.ts binds to the bridge.
import { getDb } from '../../src/data/db';
import {
  listActivityShots,
  listShots,
  recentScores,
} from '../../src/data/repository';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const OUTBOX_DDL = `CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT
)`;

describe('S3 — corrupt shot.sync payload vs LOCAL_MIGRATIONS json_extract DELETE (real sqlite)', () => {
  let bridge: RealSqlite;
  beforeAll(() => {
    bridge = new RealSqlite('s3');
    mockOpenImpl = () => bridge;
  });
  afterAll(() => bridge.dispose());

  test('a single malformed outbox row makes getDb() throw on every launch and the row survives', () => {
    // Device state from a previous launch: schema exists, one poisoned row
    // queued ahead of a perfectly valid one.
    bridge.executeSync(OUTBOX_DDL);
    bridge.executeSync(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
      [GUEST_DATA_OWNER, '{not json'],
    );
    bridge.executeSync(
      `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
      [GUEST_DATA_OWNER, JSON.stringify({ id: 'good', source: 'real' })],
    );

    // db.ts only caches `instance` on success, so each call is a launch.
    const launches: Array<{ launch: number; error: string | null }> = [];
    for (let launch = 1; launch <= 3; launch += 1) {
      let error: string | null = null;
      try {
        getDb();
      } catch (e) {
        error = (e as Error).message;
      }
      launches.push({ launch, error });
    }

    const survivors = bridge.executeSync(
      `SELECT id, payload, attempts FROM outbox ORDER BY id`,
    ).rows;
    const tables = bridge
      .executeSync(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .rows.map(r => r['name']);
    const indexes = bridge
      .executeSync(`SELECT name FROM sqlite_master WHERE type='index'`)
      .rows.map(r => r['name']);

    const artifact = writeAttackArtifact('s3-malformed-json-migration.json', {
      sqliteVersion: bridge.sqliteVersion,
      migrationSql: bridge.log.find(sql => sql.includes('json_extract')),
      launches,
      survivors,
      tablesAfter: tables,
      indexesAfter: indexes,
    });

    // ATTACK RESULT: every launch throws the same SQLite error; the poisoned
    // row is never removed (the migration list runs OUTSIDE a transaction and
    // the failing DELETE is atomic), so the app can never open its database
    // again — the corrupt row AND the valid one behind it are stranded.
    expect(launches.map(l => l.error)).toEqual([
      'malformed JSON',
      'malformed JSON',
      'malformed JSON',
    ]);
    expect(survivors).toHaveLength(2);
    expect(survivors[0]?.['payload']).toBe('{not json');
    // Statements before the DELETE ran; ensureAccountScopedSchema never did.
    expect(tables).toContain('local_analysis_record');
    expect(indexes).not.toContain('idx_outbox_owner_created');
    expect(attackArtifactExists(artifact)).toBe(true);
  });

  test('control: the same migration list opens fine once the poisoned row is gone', () => {
    bridge.executeSync(`DELETE FROM outbox WHERE payload = '{not json'`);
    let db: ReturnType<typeof getDb> | null = null;
    expect(() => {
      db = getDb();
    }).not.toThrow();
    const rows = bridge.executeSync(`SELECT payload FROM outbox`).rows;
    expect(rows).toEqual([
      { payload: JSON.stringify({ id: 'good', source: 'real' }) },
    ]);
    db!.close(); // releases the cached instance for the next describe
  });
});

describe('S4 — non-finite / non-numeric overall_score on scored rows (real sqlite)', () => {
  let bridge: RealSqlite;
  beforeAll(() => {
    bridge = new RealSqlite('s4');
    mockOpenImpl = () => bridge;
    setActiveDataOwner(GUEST_DATA_OWNER);
  });
  afterAll(() => bridge.dispose());

  const shotRow = (
    id: string,
    capturedAt: string,
    overallScore: unknown,
  ): unknown[] => [
    GUEST_DATA_OWNER,
    id,
    'sess-1',
    'dink',
    capturedAt,
    overallScore,
    0.9,
    'scored',
    'real',
    JSON.stringify({ id, source: 'real', overallScore }),
  ];

  test('NaN binds as NULL and is omitted; TEXT "abc" and +Inf are COERCED into the score stream', async () => {
    const db = getDb();
    const insert = `INSERT INTO local_shot
      (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await db.execute(insert, shotRow('ok-7', '2026-09-01T10:00:00.000Z', 7));
    await db.execute(insert, shotRow('nan', '2026-09-01T10:01:00.000Z', NaN));
    await db.execute(insert, shotRow('abc', '2026-09-01T10:02:00.000Z', 'abc'));
    await db.execute(
      insert,
      shotRow('inf', '2026-09-01T10:03:00.000Z', Infinity),
    );
    await db.execute(insert, shotRow('ok-5', '2026-09-01T10:04:00.000Z', 5));

    const stored = bridge.executeSync(
      `SELECT id, overall_score, typeof(overall_score) AS t FROM local_shot ORDER BY captured_at`,
    ).rows;

    const scores = await recentScores(db, null, 30);
    const shots = await listShots(db, 50);
    const activity = await listActivityShots(db);
    const naiveAverage =
      scores.reduce((sum, v) => sum + v, 0) / Math.max(scores.length, 1);

    const artifact = writeAttackArtifact('s4-nonfinite-overall-score.json', {
      sqliteVersion: bridge.sqliteVersion,
      stored,
      recentScores: scores,
      naiveAverage,
      listShots: shots.map(s => ({
        id: s.id,
        resultKind: s.resultKind,
        overallScore: s.overallScore,
      })),
      listActivityShots: activity.map(s => ({
        id: s.id,
        overallScore: s.overallScore,
      })),
    });
    expect(attackArtifactExists(artifact)).toBe(true);

    // What SQLite actually stored (REAL affinity): NaN → NULL, 'abc' → TEXT,
    // +Inf → REAL.
    expect(stored.map(r => r['t'])).toEqual([
      'real',
      'null',
      'text',
      'real',
      'real',
    ]);

    // HELD: NaN never reaches JS because SQLite stores it as NULL.
    expect(scores).toHaveLength(4);

    // ATTACK RESULT: 'abc' is returned as Number('abc') = NaN and +Inf as
    // Infinity — recentScores' only filter is `v !== null`, so any average or
    // trend over this array is NaN / Infinity rather than 6 (the mean of 7,5).
    expect(scores.some(v => Number.isNaN(v))).toBe(true);
    expect(scores.some(v => v === Infinity)).toBe(true);
    expect(Number.isFinite(naiveAverage)).toBe(false);

    // Same coercion at the two consumers Home / consistency read from: a
    // `resultKind === 'scored' && overallScore !== null` filter (HomeScreen)
    // keeps the 'abc' row and would render `NaN.toFixed(1)` = "NaN".
    const abcShot = shots.find(s => s.id === 'abc');
    expect(abcShot?.resultKind).toBe('scored');
    expect(abcShot?.overallScore).not.toBeNull();
    expect(Number.isNaN(abcShot?.overallScore)).toBe(true);
    expect((abcShot?.overallScore as number).toFixed(1)).toBe('NaN');
    expect(activity.find(s => s.id === 'inf')?.overallScore).toBe(Infinity);
  });
});
