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

export interface ReliabilityBin {
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
    if (sample.confidence < 0 || sample.confidence > 1) {
      throw new Error(`confidence out of [0,1]: ${sample.confidence}`);
    }
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

/** Expected Calibration Error: count-weighted mean |accuracy − meanConfidence| over non-empty bins. */
export function expectedCalibrationError(samples: ConfidenceSample[], nBins = 10): number {
  if (samples.length === 0) return 0;
  const bins = reliabilityBins(samples, nBins);
  let total = 0;
  for (const bin of bins) {
    if (bin.count > 0 && bin.accuracy !== null && bin.meanConfidence !== null) {
      total += (bin.count / samples.length) * Math.abs(bin.accuracy - bin.meanConfidence);
    }
  }
  return total;
}

export interface CoverageRiskPoint {
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
