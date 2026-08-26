import type { CheckpointScore, Measurement, ScoreBand } from "@pickle/shared-types";
import type {
  CheckpointConfig,
  CheckpointResultDetail,
  ConfidencePresentation,
  MetricScoreDetail,
  MetricTarget,
  ShotScoringConfig,
} from "./types.js";

/**
 * Scoring engine (spec pp. 33–34). Pure and deterministic:
 *   measurements → metric scores → checkpoint scores → overall 0–10 score
 *   + analysis confidence with abstention gating.
 * Vision inference happens elsewhere; this engine only applies configured math.
 */

export interface ShotScoringOutcome {
  /** 0–10, one decimal; null when the engine abstains. */
  overallScore: number | null;
  /** A = ΣW_j·c_j / ΣW_j over configured checkpoints. */
  analysisConfidence: number;
  presentation: ConfidencePresentation;
  checkpointResults: CheckpointResultDetail[];
  /** Convenience projection into the shared CheckpointScore shape. */
  checkpoints: CheckpointScore[];
  guidance: string | null;
}

export function scoreMetric(
  target: MetricTarget,
  value: number,
): Omit<MetricScoreDetail, "confidence"> {
  const belowBy = target.lower - value;
  const aboveBy = value - target.upper;
  const d = Math.max(belowBy, 0, aboveBy);
  const q = 100 * Math.exp(-0.5 * (d / target.sigma) ** 2);
  const direction = d === 0 ? "none" : belowBy > 0 ? target.directionBelow : target.directionAbove;
  return { metricKey: target.metricKey, value, q, direction };
}

export function bandFor(score: number | null): ScoreBand {
  if (score === null) return "unscored";
  if (score >= 80) return "green";
  if (score >= 65) return "yellow";
  return "red";
}

function scoreCheckpoint(
  config: CheckpointConfig,
  byMetric: Map<string, Measurement>,
): CheckpointResultDetail {
  const details: MetricScoreDetail[] = [];
  let weighted = 0; // Σ a_m·c_m·q_m
  let weightSum = 0; // Σ a_m·c_m
  let confWeighted = 0; // Σ a_m·c_m
  let confDenominator = 0; // Σ a_m

  for (const target of config.metrics) {
    const measurement = byMetric.get(target.metricKey);
    if (!measurement) continue;
    const scored = scoreMetric(target, measurement.value);
    const c = measurement.confidence;
    details.push({ ...scored, confidence: c });
    weighted += target.importance * c * scored.q;
    weightSum += target.importance * c;
    confWeighted += target.importance * c;
    confDenominator += target.importance;
  }

  const observed = details.length > 0 && weightSum > 0;
  if (!observed) {
    return {
      key: config.key,
      score: null,
      confidence: 0,
      severity: 0,
      direction: "none",
      applicable: config.metrics.length > 0,
      observed: false,
      metricDetails: details,
    };
  }

  const score = weighted / weightSum;
  const confidence = confDenominator > 0 ? confWeighted / confDenominator : 0;
  // Direction comes from the worst-scoring observed metric.
  const worst = details.reduce((a, b) => (b.q < a.q ? b : a));
  return {
    key: config.key,
    score,
    confidence,
    severity: Math.min(Math.max((100 - score) / 100, 0), 1),
    direction: worst.direction,
    applicable: true,
    observed: true,
    metricDetails: details,
  };
}

const ABSTAIN_GUIDANCE = "Couldn't read this stroke clearly. Reposition the phone.";

export function scoreShot(
  config: ShotScoringConfig,
  measurements: Measurement[],
): ShotScoringOutcome {
  const byMetric = new Map<string, Measurement>();
  for (const m of measurements) byMetric.set(m.metricKey, m);

  const applicableConfigs = config.checkpoints.filter((c) => c.metrics.length > 0);
  const checkpointResults = applicableConfigs.map((c) => scoreCheckpoint(c, byMetric));

  // Analysis confidence over ALL applicable checkpoints — unobserved ones
  // contribute zero confidence, which is exactly what forces abstention when
  // e.g. the paddle was never visible (spec p. 34).
  let confNumerator = 0;
  let confDenominator = 0;
  for (let i = 0; i < applicableConfigs.length; i++) {
    const cfg = applicableConfigs[i];
    const result = checkpointResults[i];
    if (!cfg || !result) continue;
    confNumerator += cfg.weight * result.confidence;
    confDenominator += cfg.weight;
  }
  const analysisConfidence = confDenominator > 0 ? confNumerator / confDenominator : 0;

  const presentation: ConfidencePresentation =
    analysisConfidence < config.minAnalysisConfidence
      ? "abstain"
      : analysisConfidence < config.lowerConfidenceThreshold
        ? "lower_confidence"
        : "normal";

  let overallScore: number | null = null;
  if (presentation !== "abstain") {
    // S = 10·ΣW_j·C_j / (100·ΣW_j) over observable checkpoints only.
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < applicableConfigs.length; i++) {
      const cfg = applicableConfigs[i];
      const result = checkpointResults[i];
      if (!cfg || !result || result.score === null) continue;
      numerator += cfg.weight * result.score;
      denominator += cfg.weight;
    }
    overallScore =
      denominator > 0 ? Math.round(((10 * numerator) / (100 * denominator)) * 10) / 10 : null;
  }

  const checkpoints: CheckpointScore[] = checkpointResults.map((r) => ({
    key: r.key,
    score: presentation === "abstain" ? null : r.score,
    confidence: r.confidence,
    band: presentation === "abstain" ? "unscored" : bandFor(r.score),
    direction: r.direction,
    severity: r.severity,
    applicable: r.applicable,
  }));

  return {
    overallScore,
    analysisConfidence,
    presentation,
    checkpointResults,
    checkpoints,
    guidance: presentation === "abstain" ? ABSTAIN_GUIDANCE : null,
  };
}
