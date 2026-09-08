/**
 * ADV INT-analysis-scoring — scoring engine gates under hostile measurements.
 *
 * The shipping path is analyzeCapture → GeometryBiomechanicsExtractor →
 * Sm1TechniqueScorer → scoreShot. The extractor drops non-finite values, so
 * these probes sit BEHIND that filter; they establish whether the engine
 * itself can ever emit a numeric score that is not a finite 0..10 value, or
 * report a confidence that is not a finite 0..1 value.
 *
 *   E1 empty            — no measurements → abstain, null score, nulls only.
 *   E2 NaN value        — a NaN metric value never yields a NaN "scored" run.
 *   E3 ±Infinity value  — never yields a NaN/Infinity score.
 *   E4 NaN confidence   — analysisConfidence stays finite, no "normal" run
 *                         on NaN confidence.
 *   E5 negative / >1 c  — confidence outside [0,1] is not amplified.
 *   E6 short input      — a single observed metric cannot clear abstention
 *                         on its own (paddle never seen ⇒ abstain).
 *   E7 mapping          — Sm1TechniqueScorer forwards null score on abstain.
 *   E8 no rescale       — the same measurements score identically regardless
 *                         of SCORING_MODEL_VERSION string (pure function).
 */
import {
  getAllShotScoringConfigs,
  getShotScoringConfig,
  scoreShot,
  Sm1TechniqueScorer,
  SCORING_MODEL_VERSION,
} from '@pickle/scoring';
import type { Measurement } from '@pickle/shared-types';

const DINK = getShotScoringConfig('dink');

function everyMetricKey(config = DINK): string[] {
  const keys = new Set<string>();
  for (const checkpoint of config.checkpoints) {
    for (const metric of checkpoint.metrics) keys.add(metric.metricKey);
  }
  return [...keys];
}

function inRangeMeasurements(config = DINK, confidence = 0.95): Measurement[] {
  const out: Measurement[] = [];
  const seen = new Set<string>();
  for (const checkpoint of config.checkpoints) {
    for (const metric of checkpoint.metrics) {
      if (seen.has(metric.metricKey)) continue;
      seen.add(metric.metricKey);
      out.push({
        metricKey: metric.metricKey,
        value: (metric.lower + metric.upper) / 2,
        unit: 'ratio',
        confidence,
        source: 'real',
      });
    }
  }
  return out;
}

function assertHonestOutcome(
  outcome: ReturnType<typeof scoreShot>,
  label: string,
): void {
  expect(Number.isFinite(outcome.analysisConfidence)).toBe(true);
  expect(outcome.analysisConfidence).toBeGreaterThanOrEqual(0);
  expect(outcome.analysisConfidence).toBeLessThanOrEqual(1);
  if (outcome.presentation === 'abstain') {
    expect(outcome.overallScore).toBeNull();
    for (const checkpoint of outcome.checkpoints) {
      expect(checkpoint.score).toBeNull();
    }
  } else {
    if (
      outcome.overallScore === null ||
      !Number.isFinite(outcome.overallScore) ||
      outcome.overallScore < 0 ||
      outcome.overallScore > 10
    ) {
      throw new Error(
        `${label}: presentation=${outcome.presentation} with overallScore=${String(outcome.overallScore)}`,
      );
    }
    for (const checkpoint of outcome.checkpoints) {
      if (checkpoint.score !== null) {
        expect(Number.isFinite(checkpoint.score)).toBe(true);
      }
    }
  }
}

describe('ADV engine gates', () => {
  test('E0 precondition: an all-in-range, fully observed dink scores normally', () => {
    const outcome = scoreShot(DINK, inRangeMeasurements());
    expect(outcome.presentation).toBe('normal');
    expect(outcome.overallScore).toBe(10);
  });

  test('E1: no measurements → abstain with null score and null checkpoints', () => {
    const outcome = scoreShot(DINK, []);
    expect(outcome.presentation).toBe('abstain');
    expect(outcome.overallScore).toBeNull();
    expect(outcome.analysisConfidence).toBe(0);
    expect(outcome.checkpoints.every(c => c.score === null)).toBe(true);
    expect(outcome.guidance).not.toBeNull();
  });

  test('E2: a NaN metric value never produces a NaN scored run', () => {
    const measurements = inRangeMeasurements();
    measurements[0] = { ...measurements[0]!, value: Number.NaN };
    const outcome = scoreShot(DINK, measurements);
    assertHonestOutcome(outcome, 'NaN value');
  });

  test('E2b: every metric NaN never produces a NaN scored run', () => {
    const measurements = inRangeMeasurements().map(m => ({
      ...m,
      value: Number.NaN,
    }));
    const outcome = scoreShot(DINK, measurements);
    assertHonestOutcome(outcome, 'all NaN values');
  });

  test('E3: ±Infinity metric values stay inside 0..10 or abstain', () => {
    const plus = inRangeMeasurements().map(m => ({
      ...m,
      value: Number.POSITIVE_INFINITY,
    }));
    const minus = inRangeMeasurements().map(m => ({
      ...m,
      value: Number.NEGATIVE_INFINITY,
    }));
    assertHonestOutcome(scoreShot(DINK, plus), '+Infinity');
    assertHonestOutcome(scoreShot(DINK, minus), '-Infinity');
  });

  test('E4: a NaN confidence never yields a "normal" run with NaN confidence', () => {
    const measurements = inRangeMeasurements().map(m => ({
      ...m,
      confidence: Number.NaN,
    }));
    const outcome = scoreShot(DINK, measurements);
    assertHonestOutcome(outcome, 'NaN confidence');
  });

  test('E5: confidence outside [0,1] (negative, 5) is not amplified into a normal run', () => {
    const negative = inRangeMeasurements(DINK, -1);
    const outcomeNeg = scoreShot(DINK, negative);
    assertHonestOutcome(outcomeNeg, 'negative confidence');
    expect(outcomeNeg.presentation).toBe('abstain');

    const inflated = inRangeMeasurements(DINK, 5);
    const outcomeInflated = scoreShot(DINK, inflated);
    assertHonestOutcome(outcomeInflated, 'confidence 5');
  });

  test('E6: a single observed metric cannot clear abstention on its own', () => {
    const [first] = inRangeMeasurements();
    const outcome = scoreShot(DINK, [first!]);
    expect(outcome.presentation).toBe('abstain');
    expect(outcome.overallScore).toBeNull();
  });

  test('E7: Sm1TechniqueScorer forwards a null score on abstention for every configured stroke', async () => {
    const scorer = new Sm1TechniqueScorer();
    for (const config of getAllShotScoringConfigs()) {
      const result = await scorer.score({
        shotType: config.shotType,
        measurements: [],
        embedding: null,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.presentation).toBe('abstain');
      expect(result.value.overallScore).toBeNull();
    }
  });

  test('E8: same measurements → same score; the version string is not an input (no rescale path)', () => {
    expect(SCORING_MODEL_VERSION).toBe('sm-v1');
    const a = scoreShot(DINK, inRangeMeasurements(DINK, 0.9));
    const b = scoreShot(DINK, inRangeMeasurements(DINK, 0.9));
    expect(a).toEqual(b);
    expect(everyMetricKey().length).toBeGreaterThan(0);
  });
});
