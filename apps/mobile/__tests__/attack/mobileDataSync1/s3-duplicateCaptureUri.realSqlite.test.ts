/**
 * ATTACK S3 — savePendingCapture twice with the same uri for one owner
 * against a REAL SQLite database (UNIQUE(owner_key, uri)).
 *
 * The production migrations in src/data/db.ts run unmodified against
 * node:sqlite through testing/attack/nodeSqliteOpAdapter.ts, so the
 * constraint under test is the real one, not a fake's approximation.
 *
 * Questions: is the second insert a deliberate upsert or a deliberate throw?
 * Does the first row survive? May another owner store the same uri?
 */
import type { LocalDb } from '../../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import {
  listPendingCaptures,
  savePendingCapture,
} from '../../../src/data/repository';
import {
  OWNER_A,
  OWNER_B,
  capturedClip,
} from '../../../testing/attack/mobileDataSyncFixtures';
import { createOpSqliteModuleMock } from '../../../testing/attack/nodeSqliteOpAdapter';

const mockOpSqlite = createOpSqliteModuleMock();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockOpSqlite.open(options),
}));

function loadRealGetDb(): () => LocalDb {
  let getDb: (() => LocalDb) | null = null;
  jest.isolateModules(() => {
    getDb = jest.requireActual<typeof import('../../../src/data/db')>(
      '../../../src/data/db',
    ).getDb;
  });
  if (!getDb) throw new Error('db module did not load');
  return getDb;
}

async function captureRows(db: LocalDb) {
  const { rows } = await db.execute(
    'SELECT owner_key, id, uri FROM local_capture ORDER BY owner_key, id',
  );
  return rows;
}

describe('ATTACK S3 — duplicate capture uri under UNIQUE(owner_key, uri) [real sqlite]', () => {
  let db: LocalDb;

  beforeEach(() => {
    db = loadRealGetDb()();
  });

  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    db.close();
  });

  it('runs the production migrations on a real SQLite engine and exposes the composite UNIQUE index', async () => {
    const { rows } = await db.execute(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_capture'",
    );
    expect(String(rows[0]?.['sql'])).toContain('UNIQUE (owner_key, uri)');
    const { rows: pk } = await db.execute('PRAGMA table_info(local_capture)');
    const pkCols = pk.filter(c => Number(c['pk']) > 0).map(c => c['name']);
    expect(pkCols).toEqual(['owner_key', 'id']);
  });

  it('a second savePendingCapture with the same uri for the same owner THROWS a raw SQLite UNIQUE error (no upsert), first row intact', async () => {
    setActiveDataOwner(OWNER_A);
    await savePendingCapture(db, 'capture-1', 'forehand_drive', capturedClip);

    let thrown: unknown = null;
    try {
      await savePendingCapture(db, 'capture-2', 'forehand_drive', capturedClip);
    } catch (error) {
      thrown = error;
    }
    // node:sqlite raises errors from the host realm, so instanceof Error is
    // not reliable inside the jest sandbox; inspect the shape instead.
    expect(thrown).not.toBeNull();
    const message = String((thrown as { message?: unknown }).message);
    // Deliberate-throw check: the failure is the bare engine constraint, not
    // a typed repository error. Recorded verbatim for the report.
    expect(message).toMatch(
      /UNIQUE constraint failed: local_capture\.owner_key, local_capture\.uri/,
    );
    expect(thrown).not.toHaveProperty(
      'code',
      expect.stringMatching(/^capture\./),
    );

    const rows = await captureRows(db);
    expect(rows).toEqual([
      { owner_key: OWNER_A, id: 'capture-1', uri: capturedClip.uri },
    ]);
    const pending = await listPendingCaptures(db);
    expect(pending.map(p => p.id)).toEqual(['capture-1']);
  });

  it('re-saving the SAME capture id with the same uri also throws (PRIMARY KEY (owner_key,id) — no INSERT OR REPLACE)', async () => {
    setActiveDataOwner(OWNER_A);
    await savePendingCapture(db, 'capture-1', 'forehand_drive', capturedClip);
    await expect(
      savePendingCapture(db, 'capture-1', 'backhand_drive', capturedClip),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    const rows = await captureRows(db);
    expect(rows).toHaveLength(1);
  });

  it('another owner may store the same uri (isolation: uniqueness is per owner)', async () => {
    setActiveDataOwner(OWNER_A);
    await savePendingCapture(db, 'capture-a', 'forehand_drive', capturedClip);
    setActiveDataOwner(OWNER_B);
    await expect(
      savePendingCapture(db, 'capture-b', 'forehand_drive', capturedClip),
    ).resolves.toBeUndefined();

    const rows = await captureRows(db);
    expect(rows).toEqual([
      { owner_key: OWNER_A, id: 'capture-a', uri: capturedClip.uri },
      { owner_key: OWNER_B, id: 'capture-b', uri: capturedClip.uri },
    ]);
    // Owner B's read sees only its own row.
    const pendingB = await listPendingCaptures(db);
    expect(pendingB.map(p => p.id)).toEqual(['capture-b']);
    setActiveDataOwner(OWNER_A);
    const pendingA = await listPendingCaptures(db);
    expect(pendingA.map(p => p.id)).toEqual(['capture-a']);
  });

  it('uri comparison is byte-exact: unicode / case / trailing-slash variants are distinct rows, not duplicates', async () => {
    setActiveDataOwner(OWNER_A);
    const variants = [
      'file:///private/captures/réal.mov',
      'file:///private/captures/REAL.mov',
      'file:///private/captures/real.mov/',
      'file:///private/captures/re\u0301al.mov',
    ];
    for (const [i, uri] of variants.entries()) {
      await savePendingCapture(db, `capture-${i}`, 'forehand_drive', {
        ...capturedClip,
        uri,
      });
    }
    const rows = await captureRows(db);
    expect(rows).toHaveLength(variants.length);
  });

  it('signed-out owner cannot write a capture at all (requireWritableDataOwner)', async () => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await expect(
      savePendingCapture(db, 'capture-x', 'forehand_drive', capturedClip),
    ).rejects.toThrow();
    expect(await captureRows(db)).toEqual([]);
  });
});
