/**
 * STRESS — minimized reproduction from the boundary/i18n/a11y campaign
 * (seed 2218986416, hostile score `score-huge`): a stored `overall_score`
 * of 1e308 passes the engine's `Number.isFinite` guard, but the day average
 * `Math.round((sum / count) * 10) / 10` overflows to Infinity and the day
 * detail card renders "AVG Infinity" (`selectedLog.scoreAvg.toFixed(1)`).
 *
 * The engine documents scores as 0-10 yet accepts any finite number, and the
 * `local_shot.overall_score REAL` column has no CHECK — so a single
 * out-of-range row (a corrupt or hand-edited database, a future producer
 * bug) puts a non-finite number on screen. Engine-level, no renderer.
 */
import { buildConsistencySnapshot } from '../../src/consistency/engine';

const AS_OF = '2028-02-29T12:00:00.000Z';

function snapshotWithScores(scores: readonly number[]) {
  return buildConsistencySnapshot(
    scores.map((overallScore, i) => ({
      kind: 'stroke' as const,
      atIso: `2028-02-29T0${i}:00:00.000Z`,
      shotType: 'dink',
      overallScore,
      resultKind: 'scored',
    })),
    { asOfIso: AS_OF, timeZone: 'UTC' },
  );
}

describe('StreakCalendarScreen — scoreAvg for out-of-range finite scores', () => {
  it('a single 1e308 score yields a finite (or null) day average', () => {
    const snapshot = snapshotWithScores([1e308]);
    const day = snapshot.days['2028-02-29'];
    expect(day).toBeDefined();
    expect(day?.scoredCount).toBe(1);
    // Math.round(1e308 * 10) is Infinity.
    expect(day?.scoreAvg === null || Number.isFinite(day?.scoreAvg)).toBe(true);
  });

  it('two Number.MAX_VALUE scores do not overflow the running sum', () => {
    const snapshot = snapshotWithScores([Number.MAX_VALUE, Number.MAX_VALUE]);
    const day = snapshot.days['2028-02-29'];
    expect(day?.scoredCount).toBe(2);
    expect(day?.scoreAvg === null || Number.isFinite(day?.scoreAvg)).toBe(true);
  });

  it('in-range scores keep a one-decimal average (control)', () => {
    const snapshot = snapshotWithScores([7.25, 8.5, 0]);
    expect(snapshot.days['2028-02-29']?.scoreAvg).toBe(5.3);
  });
});
