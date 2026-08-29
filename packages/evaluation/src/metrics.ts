/**
 * Evaluation metric implementations. Pure math, no I/O, no model coupling —
 * benchmark runners feed predictions and ground truth in, numbers come out.
 * Every future model release is judged by these same functions against
 * versioned benchmark datasets.
 */

export interface ClassificationCase<Label extends string = string> {
  truth: Label;
  predicted: Label;
}

export interface PerClassMetrics {
  label: string;
  support: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface ClassificationReport {
  caseCount: number;
  accuracy: number;
  /** Unweighted mean F1 over classes present in truth. */
  macroF1: number;
  perClass: PerClassMetrics[];
  /** confusion[truth][predicted] = count. */
  confusion: Record<string, Record<string, number>>;
}

export function classificationReport(cases: readonly ClassificationCase[]): ClassificationReport {
  if (cases.length === 0) {
    return { caseCount: 0, accuracy: 0, macroF1: 0, perClass: [], confusion: {} };
  }
  const labels = new Set<string>();
  const confusion: Record<string, Record<string, number>> = {};
  let correct = 0;
  for (const item of cases) {
    labels.add(item.truth);
    labels.add(item.predicted);
    confusion[item.truth] ??= {};
    confusion[item.truth]![item.predicted] = (confusion[item.truth]![item.predicted] ?? 0) + 1;
    if (item.truth === item.predicted) correct += 1;
  }
  const perClass: PerClassMetrics[] = [];
  for (const label of [...labels].sort()) {
    const truePositive = confusion[label]?.[label] ?? 0;
    const support = Object.values(confusion[label] ?? {}).reduce((sum, n) => sum + n, 0);
    let predictedCount = 0;
    for (const row of Object.values(confusion)) predictedCount += row[label] ?? 0;
    const precision = predictedCount > 0 ? truePositive / predictedCount : null;
    const recall = support > 0 ? truePositive / support : null;
    const f1 =
      precision !== null && recall !== null && precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : precision === null || recall === null
          ? null
          : 0;
    perClass.push({ label, support, precision, recall, f1 });
  }
  const truthClasses = perClass.filter((entry) => entry.support > 0);
  const macroF1 =
    truthClasses.length > 0
      ? truthClasses.reduce((sum, entry) => sum + (entry.f1 ?? 0), 0) / truthClasses.length
      : 0;
  return {
    caseCount: cases.length,
    accuracy: correct / cases.length,
    macroF1,
    perClass,
    confusion,
  };
}

export interface BoundaryTimingCase {
  truthMs: number;
  predictedMs: number;
}

export interface TimingReport {
  caseCount: number;
  meanAbsoluteErrorMs: number;
  medianAbsoluteErrorMs: number;
  /** Fraction of cases within the tolerance. */
  withinTolerance: (toleranceMs: number) => number;
}

export function timingReport(cases: readonly BoundaryTimingCase[]): TimingReport {
  const errors = cases.map((entry) => Math.abs(entry.predictedMs - entry.truthMs));
  const sorted = [...errors].sort((a, b) => a - b);
  const mean = errors.length > 0 ? errors.reduce((sum, e) => sum + e, 0) / errors.length : 0;
  const half = Math.floor(sorted.length / 2);
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? sorted[half]!
        : (sorted[half - 1]! + sorted[half]!) / 2;
  return {
    caseCount: cases.length,
    meanAbsoluteErrorMs: mean,
    medianAbsoluteErrorMs: median,
    withinTolerance: (toleranceMs) =>
      errors.length === 0
        ? 0
        : errors.filter((error) => error <= toleranceMs).length / errors.length,
  };
}

export interface PairedScores {
  truth: number;
  predicted: number;
}

export function meanAbsoluteError(pairs: readonly PairedScores[]): number {
  if (pairs.length === 0) return 0;
  return pairs.reduce((sum, pair) => sum + Math.abs(pair.predicted - pair.truth), 0) / pairs.length;
}

export function pearsonCorrelation(pairs: readonly PairedScores[]): number | null {
  if (pairs.length < 2) return null;
  const meanTruth = pairs.reduce((sum, pair) => sum + pair.truth, 0) / pairs.length;
  const meanPredicted = pairs.reduce((sum, pair) => sum + pair.predicted, 0) / pairs.length;
  let covariance = 0;
  let varianceTruth = 0;
  let variancePredicted = 0;
  for (const pair of pairs) {
    const dt = pair.truth - meanTruth;
    const dp = pair.predicted - meanPredicted;
    covariance += dt * dp;
    varianceTruth += dt * dt;
    variancePredicted += dp * dp;
  }
  if (varianceTruth === 0 || variancePredicted === 0) return null;
  return covariance / Math.sqrt(varianceTruth * variancePredicted);
}

export function spearmanCorrelation(pairs: readonly PairedScores[]): number | null {
  const rank = (values: readonly number[]): number[] => {
    const indexed = values.map((value, index) => ({ value, index }));
    indexed.sort((a, b) => a.value - b.value);
    const ranks = new Array<number>(values.length);
    let position = 0;
    while (position < indexed.length) {
      let end = position;
      while (end + 1 < indexed.length && indexed[end + 1]!.value === indexed[position]!.value) {
        end += 1;
      }
      const sharedRank = (position + end) / 2 + 1;
      for (let cursor = position; cursor <= end; cursor += 1) {
        ranks[indexed[cursor]!.index] = sharedRank;
      }
      position = end + 1;
    }
    return ranks;
  };
  if (pairs.length < 2) return null;
  const truthRanks = rank(pairs.map((pair) => pair.truth));
  const predictedRanks = rank(pairs.map((pair) => pair.predicted));
  return pearsonCorrelation(
    pairs.map((_, index) => ({ truth: truthRanks[index]!, predicted: predictedRanks[index]! })),
  );
}

export interface CalibrationCase {
  confidence: number;
  correct: boolean;
}

export interface CalibrationReport {
  expectedCalibrationError: number;
  /** Sample count backing the ECE — always disclose alongside the number. */
  n: number;
  /** Non-empty when the ECE should not be quoted bare (tiny n, degenerate distribution). */
  warnings: string[];
  bins: Array<{
    lower: number;
    upper: number;
    count: number;
    meanConfidence: number;
    empiricalAccuracy: number;
  }>;
}

/** Minimum sample count below which the ECE is flagged as unstable. */
export const CALIBRATION_MIN_SAMPLES = 10;

/** Standard equal-width-bin ECE with a reliability table. */
export function calibrationReport(
  cases: readonly CalibrationCase[],
  binCount = 10,
): CalibrationReport {
  for (const item of cases) {
    if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      throw new Error(`confidence must be finite in [0,1], got ${item.confidence}`);
    }
  }
  const bins = Array.from({ length: binCount }, (_, index) => ({
    lower: index / binCount,
    upper: (index + 1) / binCount,
    count: 0,
    confidenceSum: 0,
    correctCount: 0,
  }));
  for (const item of cases) {
    const index = Math.min(binCount - 1, Math.max(0, Math.floor(item.confidence * binCount)));
    const bin = bins[index]!;
    bin.count += 1;
    bin.confidenceSum += item.confidence;
    bin.correctCount += item.correct ? 1 : 0;
  }
  let ece = 0;
  const reported = bins.map((bin) => {
    const meanConfidence = bin.count > 0 ? bin.confidenceSum / bin.count : 0;
    const empiricalAccuracy = bin.count > 0 ? bin.correctCount / bin.count : 0;
    if (cases.length > 0) {
      ece += (bin.count / cases.length) * Math.abs(meanConfidence - empiricalAccuracy);
    }
    return {
      lower: bin.lower,
      upper: bin.upper,
      count: bin.count,
      meanConfidence,
      empiricalAccuracy,
    };
  });
  const warnings: string[] = [];
  if (cases.length === 0) {
    warnings.push("no samples — ECE is vacuously 0, not evidence of calibration");
  } else if (cases.length < CALIBRATION_MIN_SAMPLES) {
    warnings.push(
      `insufficient n: ${cases.length} < floor ${CALIBRATION_MIN_SAMPLES} — ECE is not a stable estimate`,
    );
  }
  if (cases.length > 0 && new Set(cases.map((item) => item.confidence)).size === 1) {
    warnings.push(
      "degenerate confidence distribution: all samples share one confidence — ECE is a single-bin |accuracy − confidence|",
    );
  }
  return { expectedCalibrationError: ece, n: cases.length, warnings, bins: reported };
}
