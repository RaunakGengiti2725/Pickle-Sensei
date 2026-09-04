/**
 * C6 — a `ShotAnalysis` whose `overallScore` is not finite (the scoring
 * engine propagates a NaN/Infinity measurement straight into
 * `Math.round(...) / 10`) is written by `saveAnalysis()` and read back by
 * `recentScores()` / `listShots()` / `listActivityShots()` through
 * `Number(row.overall_score)`, which only filters SQL NULL.
 *
 * Real SQLite semantics (VERIFIED on the SQLite engine; op-sqlite's REAL
 * binding on device is INFERRED): a bound `Infinity` is stored as +Inf REAL
 * and comes back as Infinity; a bound `NaN` is stored as NULL by SQLite.
 *
 * No producer of a non-finite score was demonstrated on Linux (it needs a
 * non-finite Vision measurement), so this documents the store's behaviour
 * for the adjudication rather than asserting a fix.
 */
import { createRealOpSqliteModule } from '../../../adjudicate/mobile-data-sync/realSqliteOpMock';

const mockSqlite = createRealOpSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { getDb } from '../../../src/data/db';
import {
  listActivityShots,
  listShots,
  recentScores,
  saveAnalysis,
} from '../../../src/data/repository';
import {
  CANONICAL_USER,
  PERMIT_ID,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);

describe('C6: non-finite overall_score through the real store', () => {
  beforeAll(async () => {
    setActiveDataOwner(OWNER);
    const db = getDb();
    await saveAnalysis(
      db,
      realAnalysis({ id: shotId(0x61), overallScore: Infinity }),
      PERMIT_ID,
    );
    await saveAnalysis(
      db,
      realAnalysis({
        id: shotId(0x62),
        overallScore: Number.NaN,
        capturedAtIso: '2026-08-26T18:01:00.000Z',
      }),
      PERMIT_ID,
    );
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
  });

  it('documents what each reader returns for Infinity and NaN scores', async () => {
    const db = getDb();
    const raw = await db.execute(
      `SELECT id, overall_score, typeof(overall_score) AS t FROM local_shot ORDER BY id`,
    );
    const scores = await recentScores(db, null);
    const shots = await listShots(db);
    const activity = await listActivityShots(db);
    expect({
      raw: raw.rows,
      recentScores: scores,
      listShots: shots.map(s => s.overallScore),
      listActivityShots: activity.map(s => s.overallScore),
    }).toEqual({
      raw: [
        { id: shotId(0x61), overall_score: Infinity, t: 'real' },
        { id: shotId(0x62), overall_score: null, t: 'null' },
      ],
      recentScores: [Infinity],
      listShots: [null, Infinity],
      listActivityShots: [Infinity, null],
    });
    // Every finite-only consumer downstream would receive Infinity here.
    expect(scores.every(Number.isFinite)).toBe(false);
  });
});
