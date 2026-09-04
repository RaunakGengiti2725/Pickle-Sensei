import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { STROKE_FAMILIES } from "@pickle/shared-types";
import { REPO_ROOT } from "./engine/corpus.js";
import {
  classifyStroke,
  STROKE_HEURISTIC_VERSION,
  STROKE_TAXONOMY_V3,
  type StrokePrediction,
} from "./strokeHeuristic.js";
import {
  evaluateGoldLabel,
  goldL1Class,
  loadCaseHandedness,
  loadCasePose,
  loadStrokeGold,
  runStrokeHeuristicBench,
  STROKE_BENCH_POSE_CASES,
  STROKE_HEURISTIC_BENCH_VERSION,
  type BenchPose,
  type BenchRow,
  type StrokeClassifier,
} from "./strokeHeuristicBench.js";
import {
  benchStrokeGold,
  evaluatePrediction,
  V3_LEAF_FAMILY,
  type LevelVerdicts,
  type StrokeGoldLabel,
} from "./strokeTaxonomyBench.js";

/**
 * STROKE CLASSIFICATION CONFUSION HARNESS (xc-cv-classification-confusion)
 *
 *   pnpm --filter @pickle/swing-lab exec tsx src/strokeConfusionHarness.ts [--out-dir DIR]
 *
 * Internal evidence only. Confusion matrices, per-class precision/recall
 * (as COUNTS with explicit denominators), abstention-reason histograms and
 * an ambiguity register for the canonical production stroke classifier
 * (packages/vision-geometry strokeHeuristicLite, re-exported by
 * strokeHeuristic.ts) over the committed gold corpus
 * (datasets/paddle-bench/stroke-gold.json), replayed on Linux over the
 * committed wave-a Apple-Vision pose slices with paddle=null.
 *
 * The rows are built by the canonical bench loader (`evaluateGoldLabel`
 * from strokeHeuristicBench.ts) — this harness injects a capturing
 * classifier so the FULL prediction (leaf, depth, evidence, limiting
 * factors) is retained, then derives every matrix from the same rows the
 * regression contract scores. It never re-implements track attribution,
 * reference selection, or the classifier itself.
 *
 * Three views of the same predictions, because the classifier's label set
 * (OVERHEAD / FOREHAND / BACKHAND / UNKNOWN at depth 1–2) does not align
 * 1:1 with the gold taxonomy (pickleball-taxonomy-v2 families × sides):
 *  - benchL1   : gold {OVERHEAD, SWING, gold_unknown} × predicted
 *                {OVERHEAD, SWING, ABSTAINED, pose_unavailable} — the
 *                regression contract's L1 (strokeHeuristicBench scoreL1).
 *  - family    : gold v2 family × predicted v2 family via V3_LEAF_FAMILY, or
 *                ABSTAINED (depth-2 FOREHAND/BACKHAND cannot name a family) —
 *                the taxonomy bench's L1 (strokeTaxonomyBench).
 *  - side      : gold side × predicted {FOREHAND, BACKHAND, OVERHEAD,
 *                ABSTAINED, pose_unavailable} — L2.
 *  - raw       : gold "family/side" × raw predicted label.
 *
 * Non-negotiables inherited from docs/EVALUATION.md: abstentions are
 * outcomes, not errors; gold "unknown" is never scored as wrong; rows
 * without committed pose are listed as unevaluable, never as zeros; every
 * ratio is emitted next to its numerator and denominator.
 */

export const STROKE_CONFUSION_HARNESS_VERSION = "stroke-confusion-harness-v1";

const PB = join(REPO_ROOT, "datasets/paddle-bench");
const BASELINE_PATH = join(REPO_ROOT, "datasets/reports/regression/baseline.json");

export type PredictedSide = "FOREHAND" | "BACKHAND" | "OVERHEAD" | "ABSTAINED" | "pose_unavailable";
export type PredictedBenchL1 = "OVERHEAD" | "SWING" | "ABSTAINED" | "pose_unavailable";

/** Abstention reasons the classifier can push via its `unknown(reason)` path
 * (mirrors the g14-h6 sweep's list; stays a superset so a new reason shows
 * up as itself, never as "unreasoned"). */
export const ABSTAIN_REASONS: ReadonlySet<string> = new Set([
  "no_contact_and_no_event_peak_reference",
  "no_pose_frame_near_contact",
  "torso_not_measured_at_contact",
  "torso_extent_degenerate_normalization_unreliable",
  "torso_extent_collapsed_vs_sequence_median",
  "dominant_wrist_attribution_unverifiable_rival_unmeasured",
  "symmetric_bimanual_motion_rim_propulsion_signature",
  "no_swing_energy_in_window",
  "no_swing_motion_near_reference",
  "contact_point_unreliable_paddle_unverified_wrist_invisible",
  "no_contact_point_measurable",
  "dominant_wrist_near_tie_across_midline_side_attribution_unstable",
  "overhead_decision_flips_under_median_torso_normalization",
  "contact_point_contradicted_by_skeletal_window",
  "overhead_point_degraded_and_uncorroborated_no_claim",
  "shoulder_separation_degenerate_side_decision_unreliable",
  "declared_handedness_contradicted_by_dominant_motion_wrist",
  "declared_wrist_too_sparsely_measured_under_handedness_contradiction",
  "facing_unmeasurable_no_consensus_and_degenerate_shoulder_separation",
  "ambidextrous_declared_side_unresolvable",
  "contact_too_close_to_midline_for_confident_side",
  "side_margin_within_degraded_abstention_band",
  "side_margin_within_no_contact_evidence_abstention_band",
]);

export function primaryAbstainReason(
  prediction: Pick<StrokePrediction, "label" | "limitingFactors">,
): string | null {
  if (prediction.label !== "UNKNOWN") return null;
  for (let i = prediction.limitingFactors.length - 1; i >= 0; i -= 1) {
    const factor = prediction.limitingFactors[i]!;
    if (ABSTAIN_REASONS.has(factor)) return factor;
  }
  return "unreasoned_abstain";
}

export function predictedSide(prediction: StrokePrediction | null): PredictedSide {
  if (!prediction) return "pose_unavailable";
  if (prediction.label === "OVERHEAD") return "OVERHEAD";
  if (prediction.taxonomyDepth >= 2 && prediction.label.startsWith("FOREHAND")) return "FOREHAND";
  if (prediction.taxonomyDepth >= 2 && prediction.label.startsWith("BACKHAND")) return "BACKHAND";
  return "ABSTAINED";
}

export function predictedBenchL1(prediction: StrokePrediction | null): PredictedBenchL1 {
  if (!prediction) return "pose_unavailable";
  if (prediction.label === "UNKNOWN") return "ABSTAINED";
  return prediction.label === "OVERHEAD" ? "OVERHEAD" : "SWING";
}

export function predictedFamily(prediction: StrokePrediction | null): string {
  if (!prediction) return "pose_unavailable";
  const leaf = prediction.leaf ?? prediction.label;
  return V3_LEAF_FAMILY[leaf] ?? "ABSTAINED";
}

/** Gold side reduced to what a v3 prediction can express. */
export function goldSideClass(
  l2: StrokeGoldLabel["l2"],
): "forehand" | "backhand" | "overhead" | "unknown" {
  if (l2 === "forehand" || l2 === "backhand" || l2 === "overhead") return l2;
  if (l2 === "two_hand_backhand") return "backhand";
  return "unknown";
}

/** Side margin (shoulder-widths) parsed from the classifier's own evidence
 * line; null when the side stage was never reached. */
export function parseSideMargin(evidence: readonly string[]): number | null {
  for (const line of evidence) {
    const match = /^contact (\d+(?:\.\d+)?) shoulder-widths (right|left) of midline/.exec(line);
    if (match) return Number(match[1]);
  }
  return null;
}

/** Dominant/rival wrist travel ratio parsed from the classifier evidence;
 * null when not emitted. */
export function parseWristTravelRatio(evidence: readonly string[]): number | null {
  for (const line of evidence) {
    const match = /travel (\d+(?:\.\d+)?)u over \d+ frames vs rival (\d+(?:\.\d+)?)u/.exec(line);
    if (match) {
      const rival = Number(match[2]);
      if (rival <= 0) return null;
      return Number(match[1]) / rival;
    }
  }
  return null;
}

export interface ConfusionRow {
  rowId: string;
  caseId: string;
  group: string;
  owner: "target" | "other";
  eventStartMs: number;
  eventEndMs: number;
  contactMs: number | null;
  handedness: "right" | "left";
  handednessSource: "annotation_vote" | "default_right";
  referenceUsed: BenchRow["referenceUsed"];
  gold: { l1: string; l2: string; l3: string; reasoning: string };
  goldBenchL1: "OVERHEAD" | "SWING" | "gold_unknown";
  goldSide: "forehand" | "backhand" | "overhead" | "unknown";
  prediction: StrokePrediction | null;
  predictedLabel: string;
  predictedBenchL1: PredictedBenchL1;
  predictedFamily: string;
  predictedSide: PredictedSide;
  confidence: number | null;
  primaryAbstainReason: string | null;
  benchL1: BenchRow["l1"];
  benchL2: BenchRow["l2"];
  taxonomy: LevelVerdicts | null;
  sideMargin: number | null;
  wristTravelRatio: number | null;
  attributionRisk: string | null;
  limitingFactors: string[];
}

export interface UnevaluableLabel {
  rowId: string;
  caseId: string;
  owner: "target" | "other";
  eventStartMs: number;
  gold: { l1: string; l2: string; l3: string };
  reason:
    | "case_not_in_committed_pose_set"
    | "committed_pose_missing"
    | "no_pose_track_inside_event_window";
}

export type ConfusionMatrix = Record<string, Record<string, number>>;

export function bump(matrix: ConfusionMatrix, gold: string, predicted: string): void {
  const row = (matrix[gold] ??= {});
  row[predicted] = (row[predicted] ?? 0) + 1;
}

export function matrixTotal(matrix: ConfusionMatrix): number {
  let total = 0;
  for (const row of Object.values(matrix)) for (const count of Object.values(row)) total += count;
  return total;
}

/** Ratio emitted as counts first; `value` is null when the denominator is 0
 * (never 0 — "not measurable" is not zero). */
export interface Ratio {
  numerator: number;
  denominator: number;
  value: number | null;
}

export function ratio(numerator: number, denominator: number): Ratio {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
  };
}

export interface PerClassScore {
  class: string;
  /** predicted == class AND gold == class */
  tp: number;
  /** predicted == class AND gold known AND gold != class */
  fpVsKnownGold: number;
  /** predicted == class AND gold unknown at this level — unverifiable, NOT an error */
  predictedGoldUnknown: number;
  /** gold == class AND predicted a different committed class */
  fnWrongClass: number;
  /** gold == class AND abstained */
  fnAbstained: number;
  /** gold == class AND pose unavailable */
  fnPoseUnavailable: number;
  goldSupport: number;
  predictedSupport: number;
  /** tp / (tp + fpVsKnownGold) — over committed predictions with known gold */
  precisionKnownGold: Ratio;
  /** tp / goldSupport — abstentions count as misses (coverage-inclusive) */
  recallAll: Ratio;
  /** tp / (tp + fnWrongClass) — over committed predictions only */
  recallCommitted: Ratio;
}

const ABSTAIN_COLUMNS = new Set(["ABSTAINED", "pose_unavailable"]);

/**
 * Per-class precision/recall from a confusion matrix whose gold axis uses
 * `goldUnknownKey` for indeterminate gold and whose predicted axis uses
 * "ABSTAINED" / "pose_unavailable" for non-commitments. `classes` pairs each
 * gold class with the predicted class it corresponds to.
 */
export function perClassScores(
  matrix: ConfusionMatrix,
  classes: ReadonlyArray<{ gold: string; predicted: string }>,
  goldUnknownKey: string,
): PerClassScore[] {
  return classes.map(({ gold, predicted }) => {
    const goldRow = matrix[gold] ?? {};
    const tp = goldRow[predicted] ?? 0;
    let fnWrongClass = 0;
    let fnAbstained = 0;
    let fnPoseUnavailable = 0;
    for (const [column, count] of Object.entries(goldRow)) {
      if (column === predicted) continue;
      if (column === "ABSTAINED") fnAbstained += count;
      else if (column === "pose_unavailable") fnPoseUnavailable += count;
      else fnWrongClass += count;
    }
    let fpVsKnownGold = 0;
    let predictedGoldUnknown = 0;
    for (const [goldKey, row] of Object.entries(matrix)) {
      if (goldKey === gold) continue;
      const count = row[predicted] ?? 0;
      if (goldKey === goldUnknownKey) predictedGoldUnknown += count;
      else fpVsKnownGold += count;
    }
    const goldSupport = Object.values(goldRow).reduce((sum, count) => sum + count, 0);
    const predictedSupport = tp + fpVsKnownGold + predictedGoldUnknown;
    return {
      class: predicted,
      tp,
      fpVsKnownGold,
      predictedGoldUnknown,
      fnWrongClass,
      fnAbstained,
      fnPoseUnavailable,
      goldSupport,
      predictedSupport,
      precisionKnownGold: ratio(tp, tp + fpVsKnownGold),
      recallAll: ratio(tp, goldSupport),
      recallCommitted: ratio(tp, tp + fnWrongClass),
    };
  });
}

export function abstentionColumns(matrix: ConfusionMatrix): number {
  let total = 0;
  for (const row of Object.values(matrix)) {
    for (const [column, count] of Object.entries(row))
      if (ABSTAIN_COLUMNS.has(column)) total += count;
  }
  return total;
}

export interface AmbiguityEntry {
  rowId: string;
  kind:
    | "gold_l1_unknown"
    | "gold_l2_unknown"
    | "gold_l3_unknown"
    | "gold_two_hand_backhand"
    | "committed_on_gold_unknown_side"
    | "committed_on_gold_unknown_family"
    | "committed_wrong_side"
    | "committed_wrong_bench_l1"
    | "side_margin_near_floor"
    | "side_margin_in_degraded_band"
    | "wrist_travel_near_tie"
    | "other_player_attribution_unverified"
    | "reference_is_wrist_speed_peak"
    | "handedness_defaulted";
  detail: string;
}

/** Documented anchors from strokeHeuristicLite (read-only; the harness never
 * changes them). */
export const CLASSIFIER_ANCHORS = {
  SIDE_MARGIN_FLOOR: 0.15,
  SIDE_MARGIN_DEGRADED_BAND: 0.5,
  DOMINANT_WRIST_NEAR_TIE_RATIO: 1.35,
  HANDEDNESS_CONTRADICTION_TRAVEL_RATIO: 1.5,
} as const;

export function ambiguityEntries(row: ConfusionRow): AmbiguityEntry[] {
  const out: AmbiguityEntry[] = [];
  const push = (kind: AmbiguityEntry["kind"], detail: string) =>
    out.push({ rowId: row.rowId, kind, detail });
  if (row.gold.l1 === "unknown") push("gold_l1_unknown", row.gold.reasoning);
  if (row.gold.l2 === "unknown") push("gold_l2_unknown", row.gold.reasoning);
  if (row.gold.l3 === "unknown")
    push("gold_l3_unknown", `gold L1/L2 = ${row.gold.l1}/${row.gold.l2}`);
  if (row.gold.l2 === "two_hand_backhand")
    push("gold_two_hand_backhand", "scored as backhand at the side level");
  const committedSide =
    row.predictedSide === "FOREHAND" ||
    row.predictedSide === "BACKHAND" ||
    row.predictedSide === "OVERHEAD";
  if (committedSide && row.goldSide === "unknown") {
    push(
      "committed_on_gold_unknown_side",
      `predicted ${row.predictedLabel} (conf ${row.confidence ?? "—"}) where the annotator could not establish a side`,
    );
  }
  if (
    row.predictedFamily !== "ABSTAINED" &&
    row.predictedFamily !== "pose_unavailable" &&
    row.gold.l1 === "unknown"
  ) {
    push("committed_on_gold_unknown_family", `predicted family ${row.predictedFamily}`);
  }
  if (row.benchL2 === "wrong") {
    push(
      "committed_wrong_side",
      `predicted ${row.predictedLabel} (conf ${row.confidence ?? "—"}) vs gold ${row.gold.l2}; margin ${row.sideMargin ?? "—"} sw; travel ratio ${row.wristTravelRatio?.toFixed(2) ?? "—"}`,
    );
  }
  if (row.benchL1 === "wrong") {
    push("committed_wrong_bench_l1", `predicted ${row.predictedLabel} vs gold ${row.gold.l1}`);
  }
  if (row.sideMargin !== null) {
    if (row.sideMargin < CLASSIFIER_ANCHORS.SIDE_MARGIN_FLOOR * 2) {
      push(
        "side_margin_near_floor",
        `margin ${row.sideMargin} sw vs floor ${CLASSIFIER_ANCHORS.SIDE_MARGIN_FLOOR} (within 2× floor)`,
      );
    } else if (row.sideMargin < CLASSIFIER_ANCHORS.SIDE_MARGIN_DEGRADED_BAND) {
      push(
        "side_margin_in_degraded_band",
        `margin ${row.sideMargin} sw < degraded band ${CLASSIFIER_ANCHORS.SIDE_MARGIN_DEGRADED_BAND}: commits only with a strong contact point`,
      );
    }
  }
  if (
    row.wristTravelRatio !== null &&
    row.wristTravelRatio < CLASSIFIER_ANCHORS.HANDEDNESS_CONTRADICTION_TRAVEL_RATIO
  ) {
    push(
      "wrist_travel_near_tie",
      `dominant/rival travel ratio ${row.wristTravelRatio.toFixed(2)} (near-tie gate ${CLASSIFIER_ANCHORS.DOMINANT_WRIST_NEAR_TIE_RATIO}, contradiction gate ${CLASSIFIER_ANCHORS.HANDEDNESS_CONTRADICTION_TRAVEL_RATIO})`,
    );
  }
  if (row.owner === "other" && row.attributionRisk)
    push("other_player_attribution_unverified", row.attributionRisk);
  if (row.referenceUsed === "wrist_speed_peak") {
    push(
      "reference_is_wrist_speed_peak",
      "gold contactMs is null; reference derived from the wrist-speed peak",
    );
  }
  if (row.handednessSource === "default_right") {
    push(
      "handedness_defaulted",
      "no explicit annotation handedness vote; declared right by default",
    );
  }
  return out;
}

export interface BaselineStrokeMetrics {
  gold_labels_total: number;
  evaluable_labels: number;
  n: number;
  l1_correct: number;
  l1_wrong: number;
  l1_abstained: number;
  l1_gold_unknown: number;
  l2_correct: number;
  l2_wrong: number;
  l2_abstained: number;
  l2_gold_unknown: number;
  l2_not_applicable: number;
  confidently_wrong: number;
}

export const BASELINE_METRIC_KEYS: ReadonlyArray<keyof BaselineStrokeMetrics> = [
  "gold_labels_total",
  "evaluable_labels",
  "n",
  "l1_correct",
  "l1_wrong",
  "l1_abstained",
  "l1_gold_unknown",
  "l2_correct",
  "l2_wrong",
  "l2_abstained",
  "l2_gold_unknown",
  "l2_not_applicable",
  "confidently_wrong",
];

/** Recompute the regression contract's stroke_heuristic metrics from the
 * harness rows (same verdict fields, same counting rules). */
export function contractMetricsFromRows(
  rows: readonly ConfusionRow[],
  goldLabelsTotal: number,
): BaselineStrokeMetrics {
  const metrics: BaselineStrokeMetrics = {
    gold_labels_total: goldLabelsTotal,
    evaluable_labels: rows.length,
    n: rows.length,
    l1_correct: 0,
    l1_wrong: 0,
    l1_abstained: 0,
    l1_gold_unknown: 0,
    l2_correct: 0,
    l2_wrong: 0,
    l2_abstained: 0,
    l2_gold_unknown: 0,
    l2_not_applicable: 0,
    confidently_wrong: 0,
  };
  for (const row of rows) {
    if (row.benchL1 === "correct") metrics.l1_correct += 1;
    else if (row.benchL1 === "wrong") metrics.l1_wrong += 1;
    else if (row.benchL1 === "abstained") metrics.l1_abstained += 1;
    else if (row.benchL1 === "gold_unknown") metrics.l1_gold_unknown += 1;
    if (row.benchL2 === "correct") metrics.l2_correct += 1;
    else if (row.benchL2 === "wrong") metrics.l2_wrong += 1;
    else if (row.benchL2 === "abstained") metrics.l2_abstained += 1;
    else if (row.benchL2 === "gold_unknown") metrics.l2_gold_unknown += 1;
    else if (row.benchL2 === "not_applicable") metrics.l2_not_applicable += 1;
    if (
      row.predictedLabel !== "UNKNOWN" &&
      row.predictedLabel !== "—" &&
      (row.benchL1 === "wrong" || row.benchL2 === "wrong")
    ) {
      metrics.confidently_wrong += 1;
    }
  }
  return metrics;
}

export interface BaselineComparison {
  baselinePath: string;
  baselineGitSha: string | null;
  baselineClassifierVersion: string | null;
  baselineBenchVersion: string | null;
  candidateClassifierVersion: string;
  metrics: Array<{
    metric: keyof BaselineStrokeMetrics;
    baseline: number | null;
    candidate: number;
    delta: number | null;
    equal: boolean;
  }>;
  allEqual: boolean;
}

interface BaselineFileShape {
  provenance?: { gitSha?: string };
  benches?: Array<{
    id: string;
    metrics?: Record<string, number>;
    labels?: { classifierVersion?: string; benchVersion?: string };
  }>;
}

export function loadBaselineStrokeMetrics(path: string = BASELINE_PATH): {
  metrics: Partial<BaselineStrokeMetrics>;
  gitSha: string | null;
  classifierVersion: string | null;
  benchVersion: string | null;
} | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as BaselineFileShape;
  const bench = raw.benches?.find((entry) => entry.id === "stroke_heuristic");
  if (!bench) return null;
  return {
    metrics: (bench.metrics ?? {}) as Partial<BaselineStrokeMetrics>,
    gitSha: raw.provenance?.gitSha ?? null,
    classifierVersion: bench.labels?.classifierVersion ?? null,
    benchVersion: bench.labels?.benchVersion ?? null,
  };
}

export function compareToBaseline(
  candidate: BaselineStrokeMetrics,
  baselinePath: string = BASELINE_PATH,
): BaselineComparison | null {
  const baseline = loadBaselineStrokeMetrics(baselinePath);
  if (!baseline) return null;
  const metrics = BASELINE_METRIC_KEYS.map((metric) => {
    const base = baseline.metrics[metric];
    const baselineValue = typeof base === "number" ? base : null;
    const candidateValue = candidate[metric];
    return {
      metric,
      baseline: baselineValue,
      candidate: candidateValue,
      delta: baselineValue === null ? null : candidateValue - baselineValue,
      equal: baselineValue === candidateValue,
    };
  });
  return {
    baselinePath,
    baselineGitSha: baseline.gitSha,
    baselineClassifierVersion: baseline.classifierVersion,
    baselineBenchVersion: baseline.benchVersion,
    candidateClassifierVersion: STROKE_HEURISTIC_VERSION,
    metrics,
    allEqual: metrics.every((entry) => entry.equal),
  };
}

export interface HeapSample {
  phase: string;
  atMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
}

export function heapSample(phase: string, startedAt: number): HeapSample {
  const usage = process.memoryUsage();
  return {
    phase,
    atMs: Math.round(performance.now() - startedAt),
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
  };
}

export interface ConfusionReport {
  harnessVersion: typeof STROKE_CONFUSION_HARNESS_VERSION;
  benchVersion: string;
  classifierVersion: string;
  taxonomyVersion: string;
  goldTaxonomyVersion: string;
  evidenceClass: "linux_replay_proxy";
  goldLabelsTotal: number;
  evaluableLabels: number;
  unevaluable: UnevaluableLabel[];
  rows: ConfusionRow[];
  matrices: {
    benchL1: ConfusionMatrix;
    family: ConfusionMatrix;
    side: ConfusionMatrix;
    raw: ConfusionMatrix;
    /** From strokeTaxonomyBench.benchStrokeGold over the same rows (pose-unavailable rows → prediction null). */
    taxonomyBench: { l1: ConfusionMatrix; l2: ConfusionMatrix; l3: ConfusionMatrix };
  };
  perClass: {
    benchL1: PerClassScore[];
    family: PerClassScore[];
    side: PerClassScore[];
  };
  abstention: {
    total: number;
    byPrimaryReason: Record<string, number>;
    byGoldFamilyAndReason: Record<string, Record<string, number>>;
    byGoldSideAndReason: Record<string, Record<string, number>>;
  };
  ambiguity: {
    entries: AmbiguityEntry[];
    byKind: Record<string, number>;
  };
  contractMetrics: BaselineStrokeMetrics;
  liveBenchMetrics: BaselineStrokeMetrics;
  harnessMatchesLiveBench: boolean;
  baselineComparison: BaselineComparison | null;
  timing: { totalMs: number; heap: HeapSample[] };
  disclosures: string[];
}

export interface BuildRowsResult {
  rows: ConfusionRow[];
  unevaluable: UnevaluableLabel[];
  goldLabelsTotal: number;
}

function rowIdOf(label: Pick<StrokeGoldLabel, "caseId" | "eventStartMs" | "owner">): string {
  return `${label.caseId}@${label.eventStartMs}/${label.owner}`;
}

/**
 * Evaluate every gold label through the canonical bench row builder with a
 * capturing classifier. `classifier` defaults to the production classifier;
 * an alternative may be injected (shadow / frozen versions) — the harness is
 * classifier-agnostic.
 */
export function buildConfusionRows(
  root: string = PB,
  classifier: StrokeClassifier = classifyStroke,
): BuildRowsResult {
  const gold = loadStrokeGold(root);
  const rows: ConfusionRow[] = [];
  const unevaluable: UnevaluableLabel[] = [];
  const poseCache = new Map<string, BenchPose | null>();
  for (const label of gold.labels) {
    const info = STROKE_BENCH_POSE_CASES[label.caseId];
    const goldTriple = { l1: label.l1, l2: label.l2, l3: label.l3 };
    if (!info) {
      unevaluable.push({
        rowId: rowIdOf(label),
        caseId: label.caseId,
        owner: label.owner,
        eventStartMs: label.eventStartMs,
        gold: goldTriple,
        reason: "case_not_in_committed_pose_set",
      });
      continue;
    }
    if (!poseCache.has(label.caseId)) poseCache.set(label.caseId, loadCasePose(label.caseId, root));
    const pose = poseCache.get(label.caseId)!;
    if (!pose) {
      unevaluable.push({
        rowId: rowIdOf(label),
        caseId: label.caseId,
        owner: label.owner,
        eventStartMs: label.eventStartMs,
        gold: goldTriple,
        reason: "committed_pose_missing",
      });
      continue;
    }
    const vote = loadCaseHandedness(label.caseId, root);
    const handedness = vote ?? "right";
    const captured: { prediction: StrokePrediction | null } = { prediction: null };
    const capturing: StrokeClassifier = (input) => {
      captured.prediction = classifier(input);
      return captured.prediction;
    };
    const bench = evaluateGoldLabel(label, pose, handedness, capturing);
    const prediction = captured.prediction;
    const goldBench = goldL1Class(label.l1);
    rows.push({
      rowId: rowIdOf(label),
      caseId: label.caseId,
      group: bench.group,
      owner: label.owner,
      eventStartMs: label.eventStartMs,
      eventEndMs: label.eventEndMs,
      contactMs: label.contactMs,
      handedness,
      handednessSource: vote ? "annotation_vote" : "default_right",
      referenceUsed: bench.referenceUsed,
      gold: { ...goldTriple, reasoning: label.reasoning },
      goldBenchL1: goldBench ?? "gold_unknown",
      goldSide: goldSideClass(label.l2),
      prediction,
      predictedLabel: bench.predictedLabel,
      predictedBenchL1: predictedBenchL1(prediction),
      predictedFamily: predictedFamily(prediction),
      predictedSide: predictedSide(prediction),
      confidence: bench.confidence,
      primaryAbstainReason: prediction ? primaryAbstainReason(prediction) : null,
      benchL1: bench.l1,
      benchL2: bench.l2,
      taxonomy: prediction ? evaluatePrediction(label, prediction) : null,
      sideMargin: prediction ? parseSideMargin(prediction.evidence) : null,
      wristTravelRatio: prediction ? parseWristTravelRatio(prediction.evidence) : null,
      attributionRisk: bench.attributionRisk,
      limitingFactors: bench.limitingFactors,
    });
  }
  return { rows, unevaluable, goldLabelsTotal: gold.labels.length };
}

export function buildMatrices(
  rows: readonly ConfusionRow[],
): Omit<ConfusionReport["matrices"], "taxonomyBench"> {
  const benchL1: ConfusionMatrix = {};
  const family: ConfusionMatrix = {};
  const side: ConfusionMatrix = {};
  const raw: ConfusionMatrix = {};
  for (const row of rows) {
    bump(benchL1, row.goldBenchL1, row.predictedBenchL1);
    bump(family, row.gold.l1, row.predictedFamily);
    bump(side, row.goldSide, row.predictedSide);
    bump(raw, `${row.gold.l1}/${row.gold.l2}`, row.predictedLabel);
  }
  return { benchL1, family, side, raw };
}

export const BENCH_L1_CLASSES = [
  { gold: "OVERHEAD", predicted: "OVERHEAD" },
  { gold: "SWING", predicted: "SWING" },
] as const;

export const FAMILY_CLASSES = STROKE_FAMILIES.map((familyName) => ({
  gold: familyName,
  predicted: familyName,
}));

export const SIDE_CLASSES = [
  { gold: "forehand", predicted: "FOREHAND" },
  { gold: "backhand", predicted: "BACKHAND" },
  { gold: "overhead", predicted: "OVERHEAD" },
] as const;

export function buildReport(
  root: string = PB,
  baselinePath: string = BASELINE_PATH,
): ConfusionReport {
  const startedAt = performance.now();
  const heap: HeapSample[] = [heapSample("start", startedAt)];
  const built = buildConfusionRows(root);
  heap.push(heapSample("rows_built", startedAt));
  const { rows, unevaluable, goldLabelsTotal } = built;

  const matrices = buildMatrices(rows);
  const taxonomy = benchStrokeGold(
    rows.map((row) => ({
      gold: {
        caseId: row.caseId,
        eventStartMs: row.eventStartMs,
        contactMs: row.contactMs,
        eventEndMs: row.eventEndMs,
        owner: row.owner,
        l1: row.gold.l1 as StrokeGoldLabel["l1"],
        l2: row.gold.l2 as StrokeGoldLabel["l2"],
        l3: row.gold.l3 as StrokeGoldLabel["l3"],
        reasoning: row.gold.reasoning,
        annotatorId: "",
        createdAtIso: "",
      },
      prediction: row.prediction,
    })),
  );

  const byPrimaryReason: Record<string, number> = {};
  const byGoldFamilyAndReason: Record<string, Record<string, number>> = {};
  const byGoldSideAndReason: Record<string, Record<string, number>> = {};
  let abstentionTotal = 0;
  for (const row of rows) {
    const reason = row.prediction ? row.primaryAbstainReason : "pose_unavailable";
    if (!reason) continue;
    abstentionTotal += 1;
    byPrimaryReason[reason] = (byPrimaryReason[reason] ?? 0) + 1;
    bump(byGoldFamilyAndReason, row.gold.l1, reason);
    bump(byGoldSideAndReason, row.goldSide, reason);
  }

  const entries = rows.flatMap(ambiguityEntries);
  const byKind: Record<string, number> = {};
  for (const entry of entries) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;

  const contractMetrics = contractMetricsFromRows(rows, goldLabelsTotal);
  const live = runStrokeHeuristicBench(root);
  heap.push(heapSample("live_bench_done", startedAt));
  const liveBenchMetrics: BaselineStrokeMetrics = {
    gold_labels_total: live.goldLabelsTotal,
    evaluable_labels: live.evaluableLabels,
    n: live.overall.n,
    l1_correct: live.overall.l1Correct,
    l1_wrong: live.overall.l1Wrong,
    l1_abstained: live.overall.l1Abstained,
    l1_gold_unknown: live.overall.l1GoldUnknown,
    l2_correct: live.overall.l2Correct,
    l2_wrong: live.overall.l2Wrong,
    l2_abstained: live.overall.l2Abstained,
    l2_gold_unknown: live.overall.l2GoldUnknown,
    l2_not_applicable: live.overall.l2NotApplicable,
    confidently_wrong: live.overall.confidentlyWrong,
  };
  const harnessMatchesLiveBench = BASELINE_METRIC_KEYS.every(
    (key) => contractMetrics[key] === liveBenchMetrics[key],
  );
  const baselineComparison = compareToBaseline(contractMetrics, baselinePath);
  heap.push(heapSample("report_done", startedAt));

  return {
    harnessVersion: STROKE_CONFUSION_HARNESS_VERSION,
    benchVersion: STROKE_HEURISTIC_BENCH_VERSION,
    classifierVersion: STROKE_HEURISTIC_VERSION,
    taxonomyVersion: STROKE_TAXONOMY_V3.version,
    goldTaxonomyVersion: loadStrokeGold(root).taxonomyVersion,
    evidenceClass: "linux_replay_proxy",
    goldLabelsTotal,
    evaluableLabels: rows.length,
    unevaluable,
    rows,
    matrices: { ...matrices, taxonomyBench: taxonomy.confusion },
    perClass: {
      benchL1: perClassScores(matrices.benchL1, BENCH_L1_CLASSES, "gold_unknown"),
      family: perClassScores(matrices.family, FAMILY_CLASSES, "unknown"),
      side: perClassScores(matrices.side, SIDE_CLASSES, "unknown"),
    },
    abstention: {
      total: abstentionTotal,
      byPrimaryReason,
      byGoldFamilyAndReason,
      byGoldSideAndReason,
    },
    ambiguity: { entries, byKind },
    contractMetrics,
    liveBenchMetrics,
    harnessMatchesLiveBench,
    baselineComparison,
    timing: { totalMs: Math.round(performance.now() - startedAt), heap },
    disclosures: [
      "Linux replay over COMMITTED Apple-Vision pose with paddle=null — a proxy for the on-device pipeline, not Apple device truth (evidence class linux_replay_proxy).",
      `Gold corpus is tiny (${rows.length} evaluable of ${goldLabelsTotal} labels): every count is per-case evidence, not a population estimate. Ratios are emitted beside their numerators/denominators and must not be quoted as accuracy claims.`,
      "Abstentions (UNKNOWN) are outcomes, not errors; gold 'unknown' rows are unverifiable, never counted wrong; labels without committed pose are listed under `unevaluable`, never as zeros.",
      `Predicted classes are the classifier's own labels (${STROKE_TAXONOMY_V3.labels.join(", ")} at depth ≤ 2 in practice); gold classes are the existing pickleball-taxonomy-v2 families/sides. No labels were invented.`,
      "Depth-2 FOREHAND/BACKHAND predictions cannot name a v2 family: the `family` matrix scores them ABSTAINED at L1 (strokeTaxonomyBench semantics) while the `benchL1` matrix scores them SWING (regression-contract semantics). Both views are reported.",
      `Held-out cases wm-dink-01 and afn-vic-rally1 have no committed pose and no gold rows here by construction (excluded from stroke-gold.json).`,
    ],
  };
}

export function formatMatrix(title: string, matrix: ConfusionMatrix): string[] {
  const columns = [...new Set(Object.values(matrix).flatMap((row) => Object.keys(row)))].sort();
  const goldKeys = Object.keys(matrix).sort();
  const width = Math.max(
    12,
    ...goldKeys.map((key) => key.length),
    ...columns.map((key) => key.length),
  );
  const pad = (text: string) => text.padEnd(width);
  const lines = [`${title} (rows = gold, columns = predicted; n=${matrixTotal(matrix)})`];
  lines.push(`  ${pad("gold \\ pred")} ${columns.map(pad).join(" ")}`);
  for (const gold of goldKeys) {
    const cells = columns.map((column) => pad(String(matrix[gold]?.[column] ?? 0)));
    lines.push(`  ${pad(gold)} ${cells.join(" ")}`);
  }
  return lines;
}

function formatRatio(value: Ratio): string {
  return value.value === null
    ? `${value.numerator}/${value.denominator} (n/a)`
    : `${value.numerator}/${value.denominator}`;
}

export function formatReport(report: ConfusionReport): string[] {
  const lines: string[] = [];
  lines.push(
    `${report.harnessVersion} · ${report.benchVersion} · ${report.classifierVersion} · gold ${report.goldTaxonomyVersion} · ${report.evidenceClass}`,
  );
  lines.push(
    `evaluable ${report.evaluableLabels}/${report.goldLabelsTotal} gold labels; unevaluable ${report.unevaluable.length}:`,
  );
  for (const item of report.unevaluable) {
    lines.push(
      `  ${item.rowId} gold=${item.gold.l1}/${item.gold.l2}/${item.gold.l3} — ${item.reason}`,
    );
  }
  lines.push("");
  lines.push(
    ...formatMatrix("MATRIX benchL1 (contract L1: OVERHEAD vs SWING)", report.matrices.benchL1),
  );
  lines.push(...formatMatrix("MATRIX family (taxonomy-v2 L1)", report.matrices.family));
  lines.push(...formatMatrix("MATRIX side (L2)", report.matrices.side));
  lines.push(
    ...formatMatrix("MATRIX raw (gold family/side × raw predicted label)", report.matrices.raw),
  );
  lines.push(
    ...formatMatrix(
      "MATRIX taxonomyBench.l3 (gold technique × predicted leaf)",
      report.matrices.taxonomyBench.l3,
    ),
  );
  lines.push("");
  const scoreBlock = (title: string, scores: PerClassScore[]) => {
    lines.push(
      `PER-CLASS ${title} (counts; precision over committed predictions with known gold; recallAll counts abstentions as misses)`,
    );
    for (const score of scores) {
      lines.push(
        `  ${score.class.padEnd(14)} tp=${score.tp} fp(known gold)=${score.fpVsKnownGold} pred-on-gold-unknown=${score.predictedGoldUnknown} ` +
          `fn-wrong=${score.fnWrongClass} fn-abstained=${score.fnAbstained} fn-pose-unavailable=${score.fnPoseUnavailable} ` +
          `gold-support=${score.goldSupport} pred-support=${score.predictedSupport} ` +
          `precision=${formatRatio(score.precisionKnownGold)} recallAll=${formatRatio(score.recallAll)} recallCommitted=${formatRatio(score.recallCommitted)}`,
      );
    }
  };
  scoreBlock("benchL1", report.perClass.benchL1);
  scoreBlock("family", report.perClass.family);
  scoreBlock("side", report.perClass.side);
  lines.push("");
  lines.push(`ABSTENTION primary reasons (${report.abstention.total} rows):`);
  for (const [reason, count] of Object.entries(report.abstention.byPrimaryReason).sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`  ${String(count).padStart(3)}  ${reason}`);
  }
  lines.push("");
  lines.push(`AMBIGUITY register (${report.ambiguity.entries.length} entries):`);
  for (const [kind, count] of Object.entries(report.ambiguity.byKind).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(count).padStart(3)}  ${kind}`);
  }
  for (const entry of report.ambiguity.entries) {
    lines.push(`    ${entry.rowId} [${entry.kind}] ${entry.detail}`);
  }
  lines.push("");
  lines.push(`CONTRACT METRICS (harness) ${JSON.stringify(report.contractMetrics)}`);
  lines.push(`LIVE BENCH METRICS          ${JSON.stringify(report.liveBenchMetrics)}`);
  lines.push(`harness == live bench: ${report.harnessMatchesLiveBench}`);
  if (report.baselineComparison) {
    lines.push(
      `BASELINE ${report.baselineComparison.baselinePath} (git ${report.baselineComparison.baselineGitSha ?? "?"}, ${report.baselineComparison.baselineClassifierVersion ?? "?"}) vs candidate ${report.baselineComparison.candidateClassifierVersion}: allEqual=${report.baselineComparison.allEqual}`,
    );
    for (const entry of report.baselineComparison.metrics) {
      lines.push(
        `  ${entry.metric.padEnd(20)} baseline=${entry.baseline ?? "—"} candidate=${entry.candidate} delta=${entry.delta ?? "—"}${entry.equal ? "" : "  <-- CHANGED"}`,
      );
    }
  } else {
    lines.push("BASELINE: not found — no comparison performed");
  }
  lines.push("");
  lines.push("ROWS");
  for (const row of report.rows) {
    lines.push(
      `  ${row.rowId.padEnd(40)} gold=${row.gold.l1}/${row.gold.l2}/${row.gold.l3} ref=${row.referenceUsed} hand=${row.handedness}(${row.handednessSource}) ` +
        `pred=${row.predictedLabel}(${row.confidence ?? "—"}) benchL1=${row.benchL1} L2=${row.benchL2} ` +
        `abstain=${row.primaryAbstainReason ?? "—"} margin=${row.sideMargin ?? "—"} travelRatio=${row.wristTravelRatio?.toFixed(2) ?? "—"}`,
    );
  }
  lines.push("");
  lines.push(`timing: ${report.timing.totalMs}ms; heap: ${JSON.stringify(report.timing.heap)}`);
  lines.push("DISCLOSURES");
  for (const disclosure of report.disclosures) lines.push(`  - ${disclosure}`);
  return lines;
}

/** Serializable copy (predictions are kept — they are the evidence). */
export function writeReport(
  report: ConfusionReport,
  outDir: string,
): { jsonPath: string; textPath: string } {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "stroke-confusion-report.json");
  const textPath = join(outDir, "stroke-confusion-report.txt");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(textPath, `${formatReport(report).join("\n")}\n`);
  return { jsonPath, textPath };
}

function parseArgs(argv: readonly string[]): { outDir: string } {
  let outDir = join(REPO_ROOT, "artifacts/xc-cv-classification-confusion");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out-dir" && argv[i + 1]) {
      outDir = argv[i + 1]!;
      i += 1;
    }
  }
  return { outDir };
}

const isMain = process.argv[1]?.endsWith("strokeConfusionHarness.ts");
if (isMain) {
  const { outDir } = parseArgs(process.argv.slice(2));
  const report = buildReport();
  const written = writeReport(report, outDir);
  process.stdout.write(`${formatReport(report).join("\n")}\n`);
  process.stdout.write(`written: ${written.jsonPath}\n`);
  process.stdout.write(`written: ${written.textPath}\n`);
  if (!report.harnessMatchesLiveBench) {
    process.stderr.write(
      "harness metrics DIVERGE from runStrokeHeuristicBench — investigate before trusting matrices\n",
    );
    process.exitCode = 2;
  }
}
