/**
 * Adversarial pass (mobile-home-progress-library #1, pass 3) against the
 * pure progress/library math Home, Progress and Library render from:
 * `buildTechniqueDashboard` (the Home "THIS WEEK" card + Progress dashboard)
 * and `computeLibraryFocus` / `recommendDrills` (Library focus card).
 * Corrupt timestamps, non-finite scores, huge inputs, unicode, clock skew,
 * seeded shuffles. Seed recorded in the test names.
 */
import type { RealAnalysisFact } from '../../src/data/repository';
import { buildTechniqueDashboard } from '../../src/progress/techniqueDashboard';
import {
  computeLibraryFocus,
  recommendDrills,
  focusEvidenceLine,
  type ScoredCheckpointFact,
} from '../../src/library/libraryFocus';

const AS_OF = '2026-09-04T12:00:00.000Z';
const HOUR = 3_600_000;

function fact(
  hoursAgo: number,
  overrides: Partial<RealAnalysisFact> = {},
): RealAnalysisFact {
  return {
    id: `fact-${hoursAgo}-${overrides.id ?? ''}`,
    shotType: 'dink',
    capturedAt: new Date(Date.parse(AS_OF) - hoursAgo * HOUR).toISOString(),
    overallScore: 5.5,
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'm1',
    shotConfigVersion: 'c1',
    sessionId: null,
    priorityCheckpoint: null,
    checkpointScores: {},
    ...overrides,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const dash = (facts: readonly RealAnalysisFact[], timeZone = 'UTC') =>
  buildTechniqueDashboard(facts, { asOfIso: AS_OF, timeZone, range: '7d' });

describe('buildTechniqueDashboard — corrupt timestamps & clock skew', () => {
  it('drops "2026-13-45T00:00:00Z", "", "NaN", 48h-in-future rows; counts only valid ones', () => {
    const facts = [
      fact(2, { id: 'ok-1' }),
      fact(30, { id: 'ok-2', overallScore: 7 }),
      fact(0, { id: 'bad-month', capturedAt: '2026-13-45T00:00:00Z' }),
      fact(0, { id: 'empty', capturedAt: '' }),
      fact(0, { id: 'nan', capturedAt: 'NaN' }),
      fact(-48, { id: 'future' }),
      fact(0, { id: 'garbage', capturedAt: '🥒 pickle time' }),
      fact(0, { id: 'null-ish', capturedAt: 'null' }),
    ];
    const result = dash(facts);
    expect(result.scoredReps.current).toBe(2);
    expect(result.reads.map(r => r.id).sort()).toEqual(['ok-1', 'ok-2']);
    expect(result.avgScore.current).toBe(6.25);
    expect(result.bestScore.current).toBe(7);
    // First measured window: no prior side is invented.
    expect(result.scoredReps.previous).toBeNull();
    expect(result.insight).toBe(
      'First scored window on this device — this baseline is yours to beat.',
    );
  });

  it('a read exactly at asOf counts; one millisecond later does not', () => {
    const atAsOf = fact(0, { id: 'edge', capturedAt: AS_OF });
    const justAfter = fact(0, {
      id: 'after',
      capturedAt: new Date(Date.parse(AS_OF) + 1).toISOString(),
    });
    expect(dash([atAsOf, justAfter]).scoredReps.current).toBe(1);
  });

  it('epoch 0 and year 1000 reads are bounded history, never a crash', () => {
    const result = dash([
      fact(1, { id: 'now' }),
      fact(0, { id: 'epoch', capturedAt: '1970-01-01T00:00:00.000Z' }),
      fact(0, { id: 'y1000', capturedAt: '1000-06-01T00:00:00.000Z' }),
    ]);
    expect(result.scoredReps.current).toBe(1);
    // History exists (two ancient reads), so a prior side is honest: 0.
    expect(result.scoredReps.previous).toBe(0);
    expect(result.insight).toBe(
      'No comparable reads landed in the prior 7 days.',
    );
  });

  it('year-0999 read (Intl emits an unpadded year) is dropped, not miscounted', () => {
    const result = dash([
      fact(1, { id: 'now' }),
      fact(0, { id: 'y999', capturedAt: '0999-06-01T00:00:00.000Z' }),
    ]);
    // The ordinal for "999-06-01" is NaN → every window filter is false,
    // so the row silently vanishes from current AND history.
    expect(result.scoredReps.current).toBe(1);
    expect(result.scoredReps.previous).toBeNull();
    expect(Number.isNaN(result.avgScore.current)).toBe(false);
  });

  it('the newest read decides comparability — a stale-model read from 1s ago hides all older reads', () => {
    const facts = [
      fact(1, { id: 'a' }),
      fact(2, { id: 'b' }),
      fact(0.0003, { id: 'newest-other-model', scoringModelVersion: 'm2' }),
    ];
    const result = dash(facts);
    expect(result.scoredReps.current).toBe(1);
    expect(result.reads[0]!.id).toBe('newest-other-model');
  });

  it('invalid asOf / timezone throw (Home passes resolvedOptions().timeZone so it cannot hit this)', () => {
    expect(() =>
      buildTechniqueDashboard([], {
        asOfIso: 'not-a-date',
        timeZone: 'UTC',
        range: '7d',
      }),
    ).toThrow('asOfIso must be a parseable ISO timestamp.');
    expect(() => dash([], 'Mars/Olympus_Mons')).toThrow(
      'timeZone must be a supported IANA timezone.',
    );
  });

  it('Pacific/Kiritimati (+14) and Pacific/Pago_Pago (-11) bucket the same instant on different days', () => {
    const instant = fact(0, { id: 'i', capturedAt: '2026-09-04T11:30:00Z' });
    const east = dash([instant], 'Pacific/Kiritimati');
    const west = dash([instant], 'Pacific/Pago_Pago');
    expect(east.reads[0]!.day).toBe('2026-09-05');
    expect(west.reads[0]!.day).toBe('2026-09-04');
    // Neither zone loses the read.
    expect(east.scoredReps.current).toBe(1);
    expect(west.scoredReps.current).toBe(1);
  });
});

describe('buildTechniqueDashboard — non-finite & out-of-range scores', () => {
  it('documents: NaN/Infinity overallScore is NOT filtered (only null is)', () => {
    const result = dash([
      fact(1, { id: 'ok', overallScore: 6 }),
      fact(2, { id: 'nan', overallScore: Number.NaN }),
      fact(3, { id: 'inf', overallScore: Number.POSITIVE_INFINITY }),
    ]);
    console.info(
      `[attack] non-finite scores → reps=${result.scoredReps.current} avg=${result.avgScore.current} best=${result.bestScore.current}`,
    );
    // Recorded behaviour (SQLite REAL cannot hold NaN, so the app never
    // persists one; Infinity is representable). Pinned so a change is loud.
    expect(result.scoredReps.current).toBe(3);
    expect(Number.isNaN(result.avgScore.current)).toBe(true);
    // Math.max(NaN, …) poisons the best as well.
    expect(Number.isNaN(result.bestScore.current)).toBe(true);
  });

  it('a 0.05 score rounds in tenths deterministically regardless of row order (seed 2024)', () => {
    const base = Array.from({ length: 200 }, (_, i) =>
      fact(i * 0.5, {
        id: `r${i}`,
        overallScore: Math.round(((i * 37) % 100) * 10) / 100,
      }),
    );
    const a = dash(base);
    const b = dash(shuffle(base, 2024));
    expect(b.avgScore).toEqual(a.avgScore);
    expect(b.bestScore).toEqual(a.bestScore);
    expect(b.buckets).toEqual(a.buckets);
    expect(b.reads).toEqual(a.reads);
    expect(b.personalBest).toEqual(a.personalBest);
  });

  it('50,000 facts across 3 years build in bounded time with 7 buckets', () => {
    const rand = mulberry32(42);
    const facts = Array.from({ length: 50_000 }, (_, i) =>
      fact(rand() * 24 * 365 * 3, {
        id: `big-${i}`,
        shotType: ['dink', 'serve', 'volley'][i % 3]!,
        overallScore: Math.round(rand() * 100) / 10,
      }),
    );
    const started = Date.now();
    const result = dash(facts);
    const elapsed = Date.now() - started;
    console.info(
      `[attack] 50k facts → ${elapsed}ms, reps=${result.scoredReps.current}`,
    );
    expect(elapsed).toBeLessThan(5_000);
    expect(result.buckets).toHaveLength(7);
    expect(result.scoredReps.current).toBeGreaterThan(0);
    expect(result.scoredReps.previous).not.toBeNull();
  });

  it('unicode / empty / 10k-char shotType keys never collide or crash', () => {
    const result = dash([
      fact(1, { id: 'u1', shotType: '🥒' }),
      fact(2, { id: 'u2', shotType: 'ダイク' }),
      fact(3, { id: 'u3', shotType: '' }),
      fact(4, { id: 'u4', shotType: 'x'.repeat(10_000) }),
      fact(5, { id: 'u5', shotType: 'dink\u0000' }),
    ]);
    expect(result.scoredReps.current).toBe(5);
    expect(new Set(result.reads.map(r => r.shotType)).size).toBe(5);
  });

  it('personal best never fires on a tie or without history', () => {
    const noHistory = dash([fact(1, { id: 'a', overallScore: 9 })]);
    expect(noHistory.personalBest).toBeNull();
    const tie = dash([
      fact(1, { id: 'a', overallScore: 8 }),
      fact(24 * 20, { id: 'old', overallScore: 8 }),
    ]);
    expect(tie.personalBest).toBeNull();
    const beat = dash([
      fact(1, { id: 'a', overallScore: 8.1 }),
      fact(24 * 20, { id: 'old', overallScore: 8 }),
    ]);
    expect(beat.personalBest).toMatchObject({
      shotType: 'dink',
      score: 8.1,
      previousBest: 8,
    });
  });
});

describe('computeLibraryFocus / recommendDrills — corrupt & hostile input', () => {
  const cp = (
    key: string,
    score: number | null,
    applicable = true,
  ): ScoredCheckpointFact['checkpoints'][number] => ({
    key,
    score,
    applicable,
  });
  const scored = (
    id: string,
    capturedAt: string,
    checkpoints: ScoredCheckpointFact['checkpoints'],
    shotType = 'dink',
  ): ScoredCheckpointFact => ({ id, shotType, capturedAt, checkpoints });

  it('NaN / Infinity / null / inapplicable checkpoint scores are unobserved', () => {
    const focus = computeLibraryFocus([
      scored('a', '2026-09-01T00:00:00Z', [
        cp('paddle_prep', Number.NaN),
        cp('contact_point', 40),
      ]),
      scored('b', '2026-09-02T00:00:00Z', [
        cp('paddle_prep', Number.POSITIVE_INFINITY),
        cp('contact_point', 60),
      ]),
      scored('c', '2026-09-03T00:00:00Z', [
        cp('paddle_prep', null),
        cp('paddle_prep', 1, false),
        cp('contact_point', 50),
      ]),
    ]);
    expect(focus).not.toBeNull();
    expect(focus!.checkpoint).toBe('contact_point');
    expect(focus!.sampleCount).toBe(3);
    expect(Number.isFinite(focus!.averageScore)).toBe(true);
  });

  it('one sample is a data point, not a diagnosis (MIN_FOCUS_SAMPLES)', () => {
    expect(
      computeLibraryFocus([
        scored('a', '2026-09-01T00:00:00Z', [cp('paddle_prep', 1)]),
      ]),
    ).toBeNull();
    expect(computeLibraryFocus([])).toBeNull();
  });

  it('is order independent under a seeded shuffle (seed 7331) with unicode ids and unparseable timestamps', () => {
    const facts: ScoredCheckpointFact[] = [];
    const rand = mulberry32(7331);
    for (let i = 0; i < 400; i += 1) {
      const shotType = ['dink', 'serve', 'overhead', '🥒'][i % 4]!;
      const capturedAt =
        i % 17 === 0
          ? ['', 'NaN', '2026-13-45T00:00:00Z', 'garbage'][i % 4]!
          : new Date(Date.parse(AS_OF) - rand() * 90 * 24 * HOUR).toISOString();
      facts.push(
        scored(
          `id-${i}-${'é'.repeat(i % 3)}`,
          capturedAt,
          [
            cp('paddle_prep', Math.round(rand() * 100)),
            cp('contact_point', Math.round(rand() * 100)),
            cp(
              'follow_through',
              rand() > 0.5 ? null : Math.round(rand() * 100),
            ),
          ],
          shotType,
        ),
      );
    }
    const a = computeLibraryFocus(facts);
    const b = computeLibraryFocus(shuffle(facts, 7331));
    const c = computeLibraryFocus([...facts].reverse());
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(focusEvidenceLine(a!)).toMatch(/from \d+ recent scored reads?$/);
  });

  it('unknown technique falls back to the global family; recommendDrills honours limit 0 / negative / huge', () => {
    const focus = computeLibraryFocus([
      scored('a', '2026-09-01T00:00:00Z', [cp('paddle_prep', 10)], 'moon_shot'),
      scored('b', '2026-09-02T00:00:00Z', [cp('paddle_prep', 20)], 'moon_shot'),
    ]);
    expect(focus).toMatchObject({ shotType: 'moon_shot', family: 'global' });
    const drills = [
      { slug: 'g1', families: ['global'] },
      { slug: 'd1', families: ['dink'] },
      { slug: 'g2', families: ['global', 'dink'] },
    ];
    expect(recommendDrills(drills, focus!, 0)).toEqual([]);
    expect(recommendDrills(drills, focus!, -5)).toEqual([]);
    expect(recommendDrills(drills, focus!, 1_000_000).map(d => d.slug)).toEqual(
      ['g1', 'g2'],
    );
    const dinkFocus = { ...focus!, shotType: 'dink', family: 'dink' };
    expect(recommendDrills(drills, dinkFocus).map(d => d.slug)).toEqual([
      'd1',
      'g2',
      'g1',
    ]);
  });

  it('an average of exactly x.5 rounds consistently (weighted 2-sample case)', () => {
    // newest weight 2 → 2*0 + 1*1 = 1 / 3 = 0.33 → 0; flip → 2*1 + 0 = 2/3 → 1
    const older = scored('o', '2026-09-01T00:00:00Z', [cp('paddle_prep', 1)]);
    const newer = scored('n', '2026-09-02T00:00:00Z', [cp('paddle_prep', 0)]);
    expect(computeLibraryFocus([older, newer])!.averageScore).toBe(0);
    expect(
      computeLibraryFocus([
        { ...older, checkpoints: [cp('paddle_prep', 0)] },
        { ...newer, checkpoints: [cp('paddle_prep', 1)] },
      ])!.averageScore,
    ).toBe(1);
  });
});
