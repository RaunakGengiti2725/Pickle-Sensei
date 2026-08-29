/**
 * Calibration + selective-risk utilities for the silent-failure north star.
 *
 * Inputs are (confidence, correct) samples from any per-case artifact. All
 * functions are deterministic and denominator-honest: empty bins are reported
 * as empty, never dropped into neighbors.
 */

export interface ConfidenceSample {
  confidence: number;
  correct: boolean;
}

function assertValidConfidence(confidence: number): void {
  if (!Number.isFinite(confidence)) {
    throw new Error(`confidence must be a finite number, got ${confidence}`);
  }
  if (confidence < 0 || confidence > 1) {
    throw new Error(`confidence out of [0,1]: ${confidence}`);
  }
}

interface ReliabilityBin {
  /** Inclusive lower edge; upper edge exclusive except the last bin. */
  lower: number;
  upper: number;
  count: number;
  meanConfidence: number | null;
  accuracy: number | null;
}

export function reliabilityBins(samples: ConfidenceSample[], nBins = 10): ReliabilityBin[] {
  if (!Number.isInteger(nBins) || nBins < 1)
    throw new Error(`nBins must be a positive integer, got ${nBins}`);
  const bins: ReliabilityBin[] = Array.from({ length: nBins }, (_, index) => ({
    lower: index / nBins,
    upper: (index + 1) / nBins,
    count: 0,
    meanConfidence: null,
    accuracy: null,
  }));
  const sums = bins.map(() => ({ conf: 0, correct: 0 }));
  for (const sample of samples) {
    assertValidConfidence(sample.confidence);
    const index = Math.min(nBins - 1, Math.floor(sample.confidence * nBins));
    const bin = bins[index];
    const sum = sums[index];
    if (!bin || !sum) continue;
    bin.count += 1;
    sum.conf += sample.confidence;
    sum.correct += sample.correct ? 1 : 0;
  }
  for (let index = 0; index < nBins; index += 1) {
    const bin = bins[index];
    const sum = sums[index];
    if (bin && sum && bin.count > 0) {
      bin.meanConfidence = sum.conf / bin.count;
      bin.accuracy = sum.correct / bin.count;
    }
  }
  return bins;
}

/**
 * Expected Calibration Error: count-weighted mean |accuracy − meanConfidence|
 * over non-empty bins. Raw primitive: throws on empty input rather than
 * printing a confident 0 — reporting layers must go through
 * `calibrationReport`, which refuses/flags below a sample floor.
 */
export function expectedCalibrationError(samples: ConfidenceSample[], nBins = 10): number {
  if (samples.length === 0)
    throw new Error("ECE undefined on empty input — use calibrationReport for guarded reporting");
  const bins = reliabilityBins(samples, nBins);
  let total = 0;
  for (const bin of bins) {
    if (bin.count > 0 && bin.accuracy !== null && bin.meanConfidence !== null) {
      total += (bin.count / samples.length) * Math.abs(bin.accuracy - bin.meanConfidence);
    }
  }
  return total;
}

/** Default sample floor below which `calibrationReport` refuses to print an ECE. */
export const ECE_MIN_SAMPLES = 10;

export interface CalibrationReport {
  n: number;
  nBins: number;
  minSamples: number;
  /** null when refused (n below floor or n = 0). */
  ece: number | null;
  /** true when the number should not be quoted as a stable estimate. */
  flagged: boolean;
  flags: string[];
}

/**
 * Guarded ECE for reporting: always reports n, refuses (ece = null) below the
 * sample floor, and flags degenerate confidence distributions (all values
 * identical / all 1.0) where a bin-based ECE is uninformative.
 */
export function calibrationReport(
  samples: ConfidenceSample[],
  options: { nBins?: number; minSamples?: number } = {},
): CalibrationReport {
  const nBins = options.nBins ?? 10;
  const minSamples = options.minSamples ?? ECE_MIN_SAMPLES;
  const flags: string[] = [];
  const n = samples.length;
  for (const sample of samples) assertValidConfidence(sample.confidence);
  if (n < minSamples) {
    flags.push(
      n === 0
        ? "no samples — ECE undefined"
        : `insufficient n: ${n} < floor ${minSamples} — refusing to print a confident ECE`,
    );
    return { n, nBins, minSamples, ece: null, flagged: true, flags };
  }
  const distinct = new Set(samples.map((sample) => sample.confidence));
  if (distinct.size === 1) {
    const only = samples[0]?.confidence ?? 0;
    flags.push(
      `degenerate confidence distribution: all ${n} samples share confidence ${only} — ECE is a single-bin |accuracy − confidence|, not a calibration curve`,
    );
  }
  return {
    n,
    nBins,
    minSamples,
    ece: expectedCalibrationError(samples, nBins),
    flagged: flags.length > 0,
    flags,
  };
}

interface CoverageRiskPoint {
  /** Answer iff confidence >= threshold. */
  threshold: number;
  /** Fraction of all samples answered at this threshold. */
  coverage: number;
  /** Error rate among answered samples (selective risk). */
  risk: number;
  nAnswered: number;
  nWrongAnswered: number;
}

/**
 * Coverage-vs-risk curve: one point per distinct confidence value (descending),
 * treating that value as the abstention threshold. The final point is the
 * answer-everything operating point.
 */
export function coverageRiskCurve(samples: ConfidenceSample[]): CoverageRiskPoint[] {
  if (samples.length === 0) return [];
  for (const sample of samples) assertValidConfidence(sample.confidence);
  const sorted = [...samples].sort((a, b) => b.confidence - a.confidence);
  const points: CoverageRiskPoint[] = [];
  let answered = 0;
  let wrong = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const sample = sorted[index];
    if (!sample) continue;
    answered += 1;
    if (!sample.correct) wrong += 1;
    const isLastOfValue =
      index === sorted.length - 1 || sorted[index + 1]?.confidence !== sample.confidence;
    if (isLastOfValue) {
      points.push({
        threshold: sample.confidence,
        coverage: answered / sorted.length,
        risk: wrong / answered,
        nAnswered: answered,
        nWrongAnswered: wrong,
      });
    }
  }
  return points;
}

/** Area under the coverage-risk curve (trapezoid over coverage; lower is better). */
export function areaUnderRiskCoverage(samples: ConfidenceSample[]): number {
  const points = coverageRiskCurve(samples);
  if (points.length === 0) return 0;
  let area = 0;
  let prevCoverage = 0;
  let prevRisk = points[0]?.risk ?? 0;
  for (const point of points) {
    area += ((point.risk + prevRisk) / 2) * (point.coverage - prevCoverage);
    prevCoverage = point.coverage;
    prevRisk = point.risk;
  }
  return area;
}
