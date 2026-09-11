import type {
  AnalysisReleaseEligibility,
  NumericalOutputLineage,
  ValidatedTechniqueBenchmark,
} from '@pickle/shared-types';
import {
  formatTechniqueBenchmark,
  TECHNIQUE_BENCHMARK_NOTE,
  TECHNIQUE_BENCHMARK_UNAVAILABLE,
} from '../src/progress/techniqueBenchmarkDisplay';

/** W06 supersedes the old rescale product decision. Preserve this regression
 * location: scalar mechanics/rank scores must never yield public benchmarks. */
const artifact = { version: 'test-1', sha256: 'a'.repeat(64) };
const lineage: NumericalOutputLineage = {
  pipeline: artifact,
  definition: artifact,
  model: artifact,
  preprocessing: artifact,
  calibration: artifact,
  policy: artifact,
  dataset: artifact,
  validationReport: artifact,
  supportedDomain: artifact,
};
const benchmark: ValidatedTechniqueBenchmark = {
  schemaVersion: 'technique-benchmark-v1',
  interpretation: 'unofficial_single_swing_form_only',
  scale: 'dupr_2_8',
  status: 'validated_range',
  interval: { lower: 3.25, upper: 4.5 },
  lineage,
  uncertainty: {
    kind: 'calibrated_prediction_interval',
    nominalCoverage: 0.9,
    coverageScope: 'supported_slice',
    calibrationUnit: 'player_session',
  },
};
const release: AnalysisReleaseEligibility = {
  status: 'eligible',
  mechanics: { lineage },
  benchmark: {
    lineage,
    uncertainty: benchmark.uncertainty,
    maximumIntervalWidth: 1.5,
    boundaryStep: 0.25,
    supportedIntervals: [{ lower: 3, upper: 5 }],
  },
};

it.each([-2, 0, 3.33, 5, 7.5, 7.62, 10, 14, NaN, Infinity, null, undefined])(
  'a scalar mechanics or rank value %s never produces a benchmark',
  score => {
    expect(formatTechniqueBenchmark(score, release)).toBeNull();
  },
);
it('preserves the approved interval without rescaling or adding a point estimate', () => {
  expect(formatTechniqueBenchmark(benchmark, release)).toBe('3.25–4.5');
});
it.each([
  'unverified',
  'unreleased',
  'withdrawn',
  'expired',
  'unsupported',
  'lineage_mismatch',
] as const)(
  '%s release authority withholds numbers even for a structurally valid range',
  reasonCode => {
    expect(
      formatTechniqueBenchmark(benchmark, { status: 'ineligible', reasonCode }),
    ).toBeNull();
  },
);
it('missing authority never becomes approval from a result status', () => {
  expect(formatTechniqueBenchmark(benchmark, null)).toBeNull();
  expect(formatTechniqueBenchmark(benchmark, undefined)).toBeNull();
});
it.each(Object.keys(lineage) as Array<keyof NumericalOutputLineage>)(
  'requires the approved %s hash',
  key => {
    expect(
      formatTechniqueBenchmark(
        {
          ...benchmark,
          lineage: {
            ...lineage,
            [key]: { ...artifact, sha256: 'b'.repeat(64) },
          },
        },
        release,
      ),
    ).toBeNull();
  },
);
it.each([
  { lower: 3.2, upper: 4.5 },
  { lower: 2.5, upper: 4 },
  { lower: 3, upper: 5 },
  { lower: 4, upper: 4 },
  { lower: NaN, upper: 4 },
])('withholds an unsupported, over-wide or off-grid interval %j', interval => {
  expect(
    formatTechniqueBenchmark({ ...benchmark, interval }, release),
  ).toBeNull();
});
it('does not mistake a claim of tracking confidence for calibrated range uncertainty', () => {
  expect(
    formatTechniqueBenchmark(
      {
        ...benchmark,
        uncertainty: { ...benchmark.uncertainty, nominalCoverage: 0.99 },
      },
      release,
    ),
  ).toBeNull();
});
it('states the one-swing limitation and explains absence without inventing a number', () => {
  expect(TECHNIQUE_BENCHMARK_NOTE).toContain('one swing');
  expect(TECHNIQUE_BENCHMARK_UNAVAILABLE).toContain('separate validation');
  expect(TECHNIQUE_BENCHMARK_UNAVAILABLE).not.toMatch(/\d|DUPR/);
});
