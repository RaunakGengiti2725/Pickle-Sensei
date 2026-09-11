import {
  isReleasedTechniqueBenchmark,
  type AnalysisReleaseEligibility,
} from '@pickle/shared-types';

export const TECHNIQUE_BENCHMARK_UNAVAILABLE =
  'Technique benchmark unavailable — separate validation is required.';
export const TECHNIQUE_BENCHMARK_NOTE =
  'The technique benchmark describes one swing’s form, not a match rating.';

/** A mechanics score or an aggregate rank can never become a benchmark.
 * The caller supplies the independently verified release authority for the
 * saved output; a missing, expired or withdrawn authority displays no number. */
export function formatTechniqueBenchmark(
  benchmark: unknown,
  release: AnalysisReleaseEligibility | null | undefined,
): string | null {
  if (!isReleasedTechniqueBenchmark(benchmark, release)) return null;
  return `${benchmark.interval.lower}–${benchmark.interval.upper}`;
}
