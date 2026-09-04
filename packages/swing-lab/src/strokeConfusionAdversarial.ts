import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { PoseSequence } from "@pickle/swing-domain";
import { classifyStroke as classifyLite } from "@pickle/vision-geometry";
import { REPO_ROOT } from "./engine/corpus.js";
import { dominantWristSpeeds } from "./engine/minerCore.js";
import { targetPoseSequence, type PlayerTrack } from "./playerTracker.js";
import {
  bump,
  goldSideClass,
  heapSample,
  predictedBenchL1,
  predictedSide,
  primaryAbstainReason,
  type ConfusionMatrix,
  type HeapSample,
} from "./strokeConfusionHarness.js";
import {
  classifyStroke,
  STROKE_HEURISTIC_VERSION,
  type StrokePrediction,
} from "./strokeHeuristic.js";
import {
  goldL1Class,
  loadCaseHandedness,
  loadCasePose,
  loadStrokeGold,
  pickOtherTrack,
  pickTargetTrack,
  scoreL1,
  scoreL2,
  STROKE_BENCH_POSE_CASES,
  type BenchPose,
  type L1Verdict,
  type L2Verdict,
} from "./strokeHeuristicBench.js";
import type { StrokeGoldLabel } from "./strokeTaxonomyBench.js";

/**
 * ADVERSARIAL CONFUSION SWEEP (xc-cv-classification-confusion)
 *
 *   pnpm --filter @pickle/swing-lab exec tsx src/strokeConfusionAdversarial.ts [--out-dir DIR]
 *   pnpm --filter @pickle/swing-lab exec tsx src/strokeConfusionAdversarial.ts --replay <rowId> <variantId>
 *
 * Substrate: the 18 committed-pose stroke-gold rows (identical loading and
 * track attribution to strokeHeuristicBench / g14-h6). Each row is
 * re-classified under deterministic perturbation variants and every
 * evaluation is scored AGAINST GOLD (L1 overhead/swing, L2 side) as well as
 * against the row's own unperturbed baseline prediction, so the output is a
 * per-variant confusion matrix plus a transition taxonomy.
 *
 * Families (all pure, all seeded from FNV(rowId|variantId) → LCG; reruns
 * are byte-identical and `--replay` re-derives any single evaluation):
 *   handedness_flip  declared handedness wrong, geometry untouched (user error)
 *   chirality_swap   left_/right_ joint names swapped, x untouched (pose
 *                    estimator chirality confusion), handedness untouched
 *   reflect          mirror x→1−x + swap names + flip handedness: stroke
 *                    identity UNCHANGED by construction (invariance probe)
 *   contact_shift    gold contact / event-peak reference moved ±33..±200 ms
 *   window_jitter    event bounds shrunk/expanded/shifted by 10–25 %
 *   reference_drop   gold contactMs withheld → wrist-speed-peak reference
 *   owner_swap       the OTHER player's track scored against this label
 *   noise            i.i.d. Gaussian landmark jitter σ 0.002–0.02 u, 8 seeds
 *   dropout          random landmark deletion p 0.1–0.35, 5 seeds
 *   framerate        keep-1-of-2/3/4 decimation, all phases
 *   visibility       landmark visibility scaled ×0.6 / ×0.4
 *   noise_fps        σ 0.005 noise + keep-1-of-2, 3 seeds
 *
 * Transition taxonomy (baseline → perturbed):
 *   stable_label · stable_abstain · abstain_reason_changed ·
 *   label_to_abstain · abstain_to_label · confident_label_flip
 * Gold-scored counters per evaluation: perturbed L1/L2 verdict, and
 * `newlyConfidentlyWrong` = committed AND wrong vs gold where the baseline
 * was not.
 *
 * Internal evidence only; Linux replay proxy; tiny corpus — counts, never
 * rates, are the deliverable.
 */

export const STROKE_CONFUSION_ADVERSARIAL_VERSION = "stroke-confusion-adversarial-v1";

const PB = join(REPO_ROOT, "datasets/paddle-bench");

// ── deterministic RNG (same construction as g14-h6) ─────────────────────────

export function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── pose perturbations (pure) ───────────────────────────────────────────────

type Frames = PoseSequence["frames"];
type Landmark = Frames[number]["landmarks"][number];

function withFrames(sequence: PoseSequence, frames: Frames): PoseSequence {
  return { ...sequence, frames };
}

function mapLandmarks(
  sequence: PoseSequence,
  fn: (mark: Landmark) => Landmark | null,
): PoseSequence {
  return withFrames(
    sequence,
    sequence.frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map(fn).filter((mark): mark is Landmark => mark !== null),
    })),
  );
}

export function perturbNoise(sequence: PoseSequence, sigma: number, seed: number): PoseSequence {
  const rng = makeRng(seed);
  return mapLandmarks(sequence, (mark) => ({
    ...mark,
    x: mark.x + sigma * gaussian(rng),
    y: mark.y + sigma * gaussian(rng),
  }));
}

export function perturbDropout(
  sequence: PoseSequence,
  probability: number,
  seed: number,
): PoseSequence {
  const rng = makeRng(seed);
  return mapLandmarks(sequence, (mark) => (rng() < probability ? null : mark));
}

export function perturbFramerate(
  sequence: PoseSequence,
  step: number,
  phase: number,
): PoseSequence {
  return withFrames(
    sequence,
    sequence.frames.filter((_, index) => index % step === phase),
  );
}

export function perturbVisibility(sequence: PoseSequence, factor: number): PoseSequence {
  return mapLandmarks(sequence, (mark) =>
    mark.visibility === undefined ? mark : { ...mark, visibility: mark.visibility * factor },
  );
}

function swapName(name: string): string {
  if (name.startsWith("left_")) return `right_${name.slice(5)}`;
  if (name.startsWith("right_")) return `left_${name.slice(6)}`;
  return name;
}

export function perturbChiralitySwap(sequence: PoseSequence): PoseSequence {
  return mapLandmarks(sequence, (mark) => ({ ...mark, name: swapName(mark.name) }));
}

export function perturbReflect(sequence: PoseSequence): PoseSequence {
  return mapLandmarks(sequence, (mark) => ({ ...mark, name: swapName(mark.name), x: 1 - mark.x }));
}

// ── rows ────────────────────────────────────────────────────────────────────

export interface SweepRow {
  rowId: string;
  caseId: string;
  group: string;
  owner: "target" | "other";
  gold: StrokeGoldLabel;
  handedness: "right" | "left";
  sequence: PoseSequence;
  /** The other player's sequence when attributable (owner_swap family). */
  swappedSequence: PoseSequence | null;
  window: { startMs: number; endMs: number };
  goldContactMs: number | null;
}

export function buildSweepRows(root: string = PB): SweepRow[] {
  const gold = loadStrokeGold(root);
  const rows: SweepRow[] = [];
  const poseCache = new Map<string, BenchPose | null>();
  for (const label of gold.labels) {
    const info = STROKE_BENCH_POSE_CASES[label.caseId];
    if (!info) continue;
    if (!poseCache.has(label.caseId)) poseCache.set(label.caseId, loadCasePose(label.caseId, root));
    const pose = poseCache.get(label.caseId);
    if (!pose) continue;
    const window = { startMs: label.eventStartMs, endMs: label.eventEndMs };
    const target = pickTargetTrack(pose.tracks);
    const other = target ? pickOtherTrack(pose.tracks, target, window) : null;
    const track: PlayerTrack | null = label.owner === "target" ? target : other;
    const swapped: PlayerTrack | null = label.owner === "target" ? other : target;
    if (!track) continue;
    const inWindow = track.frames.filter(
      (frame) => frame.timestampMs >= window.startMs && frame.timestampMs <= window.endMs,
    ).length;
    if (inWindow === 0) continue;
    rows.push({
      rowId: `${label.caseId}@${label.eventStartMs}/${label.owner}`,
      caseId: label.caseId,
      group: info.group,
      owner: label.owner,
      gold: label,
      handedness: loadCaseHandedness(label.caseId, root) ?? "right",
      sequence: targetPoseSequence(pose.file, track),
      swappedSequence: swapped ? targetPoseSequence(pose.file, swapped) : null,
      window,
      goldContactMs: label.contactMs,
    });
  }
  return rows;
}

// ── evaluation input + prediction ───────────────────────────────────────────

export interface EvalInput {
  sequence: PoseSequence;
  window: { startMs: number; endMs: number };
  contactMs: number | null;
  handedness: "right" | "left";
  /** Added to the derived wrist-speed-peak reference when contact is null. */
  referenceShiftMs: number;
}

export interface Predicted {
  lab: StrokePrediction;
  lite: StrokePrediction;
  reference: "gold_contact" | "wrist_speed_peak" | "none";
  referenceMs: number | null;
}

export function predict(input: EvalInput): Predicted {
  const wristSpeeds = dominantWristSpeeds(input.sequence.frames);
  let eventPeakMs: number | null = null;
  let reference: Predicted["reference"] = "gold_contact";
  if (input.contactMs === null) {
    const inWindow = wristSpeeds.filter(
      (sample) =>
        sample.timestampMs >= input.window.startMs && sample.timestampMs <= input.window.endMs,
    );
    const peak = inWindow.reduce(
      (best: { timestampMs: number; value: number } | null, sample) =>
        best === null || sample.value > best.value ? sample : best,
      null,
    );
    eventPeakMs = peak ? peak.timestampMs + input.referenceShiftMs : null;
    reference = eventPeakMs !== null ? "wrist_speed_peak" : "none";
  }
  const classifierInput = {
    sequence: input.sequence,
    window: input.window,
    contactMs: input.contactMs,
    eventPeakMs,
    handedness: input.handedness,
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds,
  };
  return {
    lab: classifyStroke(classifierInput),
    lite: classifyLite(classifierInput as Parameters<typeof classifyLite>[0]),
    reference,
    referenceMs: input.contactMs ?? eventPeakMs,
  };
}

export function baselineInput(row: SweepRow): EvalInput {
  return {
    sequence: row.sequence,
    window: row.window,
    contactMs: row.goldContactMs,
    handedness: row.handedness,
    referenceShiftMs: 0,
  };
}

// ── variants ────────────────────────────────────────────────────────────────

export interface Variant {
  family: string;
  variantId: string;
  /** Human-readable parameters (recorded on every evaluation for replay). */
  params: Record<string, number | string | boolean>;
  /** Returns null when the variant is not applicable to the row. */
  apply: (row: SweepRow, seed: number) => EvalInput | null;
  /** The physically expected relation of the perturbed label to baseline. */
  expectation: "same_label" | "mirrored_side_or_abstain" | "abstain_or_same" | "unspecified";
}

function flip(handedness: "right" | "left"): "right" | "left" {
  return handedness === "right" ? "left" : "right";
}

export function buildVariants(): Variant[] {
  const variants: Variant[] = [];
  variants.push({
    family: "handedness_flip",
    variantId: "handedness_flip",
    params: {},
    apply: (row) => ({ ...baselineInput(row), handedness: flip(row.handedness) }),
    expectation: "mirrored_side_or_abstain",
  });
  variants.push({
    family: "chirality_swap",
    variantId: "chirality_swap",
    params: {},
    apply: (row) => ({ ...baselineInput(row), sequence: perturbChiralitySwap(row.sequence) }),
    expectation: "mirrored_side_or_abstain",
  });
  variants.push({
    family: "reflect",
    variantId: "reflect_lr",
    params: {},
    apply: (row) => ({
      ...baselineInput(row),
      sequence: perturbReflect(row.sequence),
      handedness: flip(row.handedness),
    }),
    expectation: "same_label",
  });
  for (const shiftMs of [-200, -100, -67, -33, 33, 67, 100, 200]) {
    variants.push({
      family: "contact_shift",
      variantId: `contact_shift_${shiftMs > 0 ? "+" : ""}${shiftMs}ms`,
      params: { shiftMs },
      apply: (row) => {
        const base = baselineInput(row);
        return base.contactMs === null
          ? { ...base, referenceShiftMs: shiftMs }
          : { ...base, contactMs: base.contactMs + shiftMs };
      },
      expectation: "unspecified",
    });
  }
  for (const [tag, startFrac, endFrac] of [
    ["shrink10", 0.1, -0.1],
    ["shrink25", 0.25, -0.25],
    ["expand10", -0.1, 0.1],
    ["expand25", -0.25, 0.25],
    ["shift_late25", 0.25, 0.25],
    ["shift_early25", -0.25, -0.25],
  ] as const) {
    variants.push({
      family: "window_jitter",
      variantId: `window_${tag}`,
      params: { startFrac, endFrac },
      apply: (row) => {
        const duration = row.window.endMs - row.window.startMs;
        return {
          ...baselineInput(row),
          window: {
            startMs: Math.round(row.window.startMs + duration * startFrac),
            endMs: Math.round(row.window.endMs + duration * endFrac),
          },
        };
      },
      expectation: "unspecified",
    });
  }
  variants.push({
    family: "reference_drop",
    variantId: "reference_drop_to_wrist_peak",
    params: {},
    apply: (row) =>
      row.goldContactMs === null ? null : { ...baselineInput(row), contactMs: null },
    expectation: "abstain_or_same",
  });
  variants.push({
    family: "owner_swap",
    variantId: "owner_swap",
    params: {},
    apply: (row) =>
      row.swappedSequence ? { ...baselineInput(row), sequence: row.swappedSequence } : null,
    expectation: "unspecified",
  });
  for (const sigma of [0.002, 0.005, 0.01, 0.02]) {
    for (let seedIndex = 0; seedIndex < 8; seedIndex += 1) {
      variants.push({
        family: "noise",
        variantId: `noise_s${sigma}_seed${seedIndex}`,
        params: { sigma, seedIndex },
        apply: (row, seed) => ({
          ...baselineInput(row),
          sequence: perturbNoise(row.sequence, sigma, seed),
        }),
        expectation: "abstain_or_same",
      });
    }
  }
  for (const probability of [0.1, 0.2, 0.35]) {
    for (let seedIndex = 0; seedIndex < 5; seedIndex += 1) {
      variants.push({
        family: "dropout",
        variantId: `dropout_p${probability}_seed${seedIndex}`,
        params: { probability, seedIndex },
        apply: (row, seed) => ({
          ...baselineInput(row),
          sequence: perturbDropout(row.sequence, probability, seed),
        }),
        expectation: "abstain_or_same",
      });
    }
  }
  for (const step of [2, 3, 4]) {
    for (let phase = 0; phase < step; phase += 1) {
      variants.push({
        family: "framerate",
        variantId: `fps_keep1of${step}_phase${phase}`,
        params: { step, phase },
        apply: (row) => ({
          ...baselineInput(row),
          sequence: perturbFramerate(row.sequence, step, phase),
        }),
        expectation: "abstain_or_same",
      });
    }
  }
  for (const factor of [0.6, 0.4]) {
    variants.push({
      family: "visibility",
      variantId: `visibility_x${factor}`,
      params: { factor },
      apply: (row) => ({
        ...baselineInput(row),
        sequence: perturbVisibility(row.sequence, factor),
      }),
      expectation: "abstain_or_same",
    });
  }
  for (let seedIndex = 0; seedIndex < 3; seedIndex += 1) {
    variants.push({
      family: "noise_fps",
      variantId: `noise_s0.005_fps_keep1of2_seed${seedIndex}`,
      params: { sigma: 0.005, step: 2, phase: seedIndex % 2, seedIndex },
      apply: (row, seed) => ({
        ...baselineInput(row),
        sequence: perturbFramerate(perturbNoise(row.sequence, 0.005, seed), 2, seedIndex % 2),
      }),
      expectation: "abstain_or_same",
    });
  }
  return variants;
}

// ── outcomes ────────────────────────────────────────────────────────────────

export type Transition =
  | "stable_label"
  | "stable_abstain"
  | "abstain_reason_changed"
  | "label_to_abstain"
  | "abstain_to_label"
  | "confident_label_flip";

export function classifyTransition(
  base: StrokePrediction,
  perturbed: StrokePrediction,
): Transition {
  const baseAbstained = base.label === "UNKNOWN";
  const perturbedAbstained = perturbed.label === "UNKNOWN";
  if (baseAbstained && perturbedAbstained) {
    return primaryAbstainReason(base) === primaryAbstainReason(perturbed)
      ? "stable_abstain"
      : "abstain_reason_changed";
  }
  if (baseAbstained) return "abstain_to_label";
  if (perturbedAbstained) return "label_to_abstain";
  return base.label === perturbed.label ? "stable_label" : "confident_label_flip";
}

function committedWrong(gold: StrokeGoldLabel, prediction: StrokePrediction): boolean {
  if (prediction.label === "UNKNOWN") return false;
  return scoreL1(gold, prediction) === "wrong" || scoreL2(gold, prediction) === "wrong";
}

export function expectationViolated(
  variant: Variant,
  base: StrokePrediction,
  perturbed: StrokePrediction,
): boolean {
  const baseSide = predictedSide(base);
  const perturbedSide = predictedSide(perturbed);
  switch (variant.expectation) {
    case "same_label":
      return base.label !== perturbed.label;
    case "mirrored_side_or_abstain": {
      if (perturbed.label === "UNKNOWN") return false;
      if (baseSide === "FOREHAND") return perturbedSide !== "BACKHAND";
      if (baseSide === "BACKHAND") return perturbedSide !== "FOREHAND";
      // OVERHEAD does not depend on handedness; a baseline abstention that
      // becomes a commit under a wrong declaration is a manufactured claim.
      if (baseSide === "OVERHEAD") return perturbed.label !== "OVERHEAD";
      return true;
    }
    case "abstain_or_same":
      return perturbed.label !== "UNKNOWN" && perturbed.label !== base.label;
    case "unspecified":
      return false;
  }
}

export interface Evaluation {
  rowId: string;
  caseId: string;
  group: string;
  owner: "target" | "other";
  family: string;
  variantId: string;
  params: Record<string, number | string | boolean>;
  seed: number;
  goldL1: string;
  goldL2: string;
  goldBenchL1: string;
  goldSide: string;
  reference: Predicted["reference"];
  referenceMs: number | null;
  baselineLabel: string;
  baselineConfidence: number;
  baselineReason: string | null;
  perturbedLabel: string;
  perturbedConfidence: number;
  perturbedReason: string | null;
  perturbedBenchL1: string;
  perturbedSide: string;
  perturbedL1: L1Verdict;
  perturbedL2: L2Verdict;
  transition: Transition;
  baselineConfidentlyWrong: boolean;
  perturbedConfidentlyWrong: boolean;
  newlyConfidentlyWrong: boolean;
  expectation: Variant["expectation"];
  expectationViolated: boolean;
  parityViolation: boolean;
  limitingFactors: string[];
  evidence: string[];
}

export interface TransitionCounts {
  n: number;
  stable_label: number;
  stable_abstain: number;
  abstain_reason_changed: number;
  label_to_abstain: number;
  abstain_to_label: number;
  confident_label_flip: number;
  perturbed_confidently_wrong: number;
  newly_confidently_wrong: number;
  expectation_violations: number;
  parity_violations: number;
  perturbed_l1: Record<string, number>;
  perturbed_l2: Record<string, number>;
}

export function emptyTransitionCounts(): TransitionCounts {
  return {
    n: 0,
    stable_label: 0,
    stable_abstain: 0,
    abstain_reason_changed: 0,
    label_to_abstain: 0,
    abstain_to_label: 0,
    confident_label_flip: 0,
    perturbed_confidently_wrong: 0,
    newly_confidently_wrong: 0,
    expectation_violations: 0,
    parity_violations: 0,
    perturbed_l1: {},
    perturbed_l2: {},
  };
}

export function accumulate(counts: TransitionCounts, evaluation: Evaluation): void {
  counts.n += 1;
  counts[evaluation.transition] += 1;
  if (evaluation.perturbedConfidentlyWrong) counts.perturbed_confidently_wrong += 1;
  if (evaluation.newlyConfidentlyWrong) counts.newly_confidently_wrong += 1;
  if (evaluation.expectationViolated) counts.expectation_violations += 1;
  if (evaluation.parityViolation) counts.parity_violations += 1;
  counts.perturbed_l1[evaluation.perturbedL1] =
    (counts.perturbed_l1[evaluation.perturbedL1] ?? 0) + 1;
  counts.perturbed_l2[evaluation.perturbedL2] =
    (counts.perturbed_l2[evaluation.perturbedL2] ?? 0) + 1;
}

export function seedFor(rowId: string, variantId: string): number {
  return hashSeed(`${rowId}|${variantId}`);
}

export function evaluateVariant(
  row: SweepRow,
  variant: Variant,
  base: Predicted,
): Evaluation | null {
  const seed = seedFor(row.rowId, variant.variantId);
  const input = variant.apply(row, seed);
  if (!input) return null;
  const perturbed = predict(input);
  const baseWrong = committedWrong(row.gold, base.lab);
  const perturbedWrong = committedWrong(row.gold, perturbed.lab);
  return {
    rowId: row.rowId,
    caseId: row.caseId,
    group: row.group,
    owner: row.owner,
    family: variant.family,
    variantId: variant.variantId,
    params: variant.params,
    seed,
    goldL1: row.gold.l1,
    goldL2: row.gold.l2,
    goldBenchL1: goldL1Class(row.gold.l1) ?? "gold_unknown",
    goldSide: goldSideClass(row.gold.l2),
    reference: perturbed.reference,
    referenceMs: perturbed.referenceMs,
    baselineLabel: base.lab.label,
    baselineConfidence: base.lab.confidence,
    baselineReason: primaryAbstainReason(base.lab),
    perturbedLabel: perturbed.lab.label,
    perturbedConfidence: perturbed.lab.confidence,
    perturbedReason: primaryAbstainReason(perturbed.lab),
    perturbedBenchL1: predictedBenchL1(perturbed.lab),
    perturbedSide: predictedSide(perturbed.lab),
    perturbedL1: scoreL1(row.gold, perturbed.lab),
    perturbedL2: scoreL2(row.gold, perturbed.lab),
    transition: classifyTransition(base.lab, perturbed.lab),
    baselineConfidentlyWrong: baseWrong,
    perturbedConfidentlyWrong: perturbedWrong,
    newlyConfidentlyWrong: perturbedWrong && !baseWrong,
    expectation: variant.expectation,
    expectationViolated: expectationViolated(variant, base.lab, perturbed.lab),
    parityViolation: JSON.stringify(perturbed.lab) !== JSON.stringify(perturbed.lite),
    limitingFactors: perturbed.lab.limitingFactors,
    evidence: perturbed.lab.evidence,
  };
}

export interface BaselineRow {
  rowId: string;
  goldL1: string;
  goldL2: string;
  label: string;
  confidence: number;
  reason: string | null;
  reference: Predicted["reference"];
  l1: L1Verdict;
  l2: L2Verdict;
  confidentlyWrong: boolean;
}

export interface SweepReport {
  harnessVersion: typeof STROKE_CONFUSION_ADVERSARIAL_VERSION;
  classifierVersion: string;
  evidenceClass: "linux_replay_proxy";
  seedScheme: string;
  rowCount: number;
  variantCount: number;
  totalEvaluations: number;
  skippedNotApplicable: number;
  baselines: BaselineRow[];
  baselineParityViolations: string[];
  overall: TransitionCounts;
  byFamily: Record<string, TransitionCounts>;
  byVariant: Record<string, TransitionCounts>;
  byRow: Record<string, TransitionCounts>;
  /** gold side × perturbed side, per family (all evaluations in the family). */
  sideConfusionByFamily: Record<string, ConfusionMatrix>;
  /** gold bench-L1 × perturbed bench-L1, per family. */
  benchL1ConfusionByFamily: Record<string, ConfusionMatrix>;
  /** Every evaluation that is not stable (label/abstain), for replay. */
  transitions: Evaluation[];
  confidentLabelFlips: Evaluation[];
  newlyConfidentlyWrong: Evaluation[];
  abstainToLabel: Evaluation[];
  expectationViolations: Evaluation[];
  parityViolations: Array<{ rowId: string; variantId: string; seed: number }>;
  timing: { totalMs: number; heap: HeapSample[] };
  disclosures: string[];
  /** Full evaluation table (compact fields only). */
  evaluations: Array<
    Pick<
      Evaluation,
      | "rowId"
      | "variantId"
      | "seed"
      | "baselineLabel"
      | "perturbedLabel"
      | "perturbedConfidence"
      | "perturbedReason"
      | "perturbedL1"
      | "perturbedL2"
      | "transition"
      | "newlyConfidentlyWrong"
      | "expectationViolated"
    >
  >;
}

export function runSweep(root: string = PB): SweepReport {
  const startedAt = performance.now();
  const heap: HeapSample[] = [heapSample("start", startedAt)];
  const rows = buildSweepRows(root);
  const variants = buildVariants();
  heap.push(heapSample("rows_built", startedAt));
  const baselines: BaselineRow[] = [];
  const baselineParityViolations: string[] = [];
  const evaluations: Evaluation[] = [];
  let skipped = 0;
  for (const row of rows) {
    const base = predict(baselineInput(row));
    if (JSON.stringify(base.lab) !== JSON.stringify(base.lite))
      baselineParityViolations.push(row.rowId);
    baselines.push({
      rowId: row.rowId,
      goldL1: row.gold.l1,
      goldL2: row.gold.l2,
      label: base.lab.label,
      confidence: base.lab.confidence,
      reason: primaryAbstainReason(base.lab),
      reference: base.reference,
      l1: scoreL1(row.gold, base.lab),
      l2: scoreL2(row.gold, base.lab),
      confidentlyWrong: committedWrong(row.gold, base.lab),
    });
    for (const variant of variants) {
      const evaluation = evaluateVariant(row, variant, base);
      if (!evaluation) {
        skipped += 1;
        continue;
      }
      evaluations.push(evaluation);
    }
  }
  heap.push(heapSample("sweep_done", startedAt));

  const overall = emptyTransitionCounts();
  const byFamily: Record<string, TransitionCounts> = {};
  const byVariant: Record<string, TransitionCounts> = {};
  const byRow: Record<string, TransitionCounts> = {};
  const sideConfusionByFamily: Record<string, ConfusionMatrix> = {};
  const benchL1ConfusionByFamily: Record<string, ConfusionMatrix> = {};
  for (const evaluation of evaluations) {
    accumulate(overall, evaluation);
    accumulate((byFamily[evaluation.family] ??= emptyTransitionCounts()), evaluation);
    accumulate((byVariant[evaluation.variantId] ??= emptyTransitionCounts()), evaluation);
    accumulate((byRow[evaluation.rowId] ??= emptyTransitionCounts()), evaluation);
    bump(
      (sideConfusionByFamily[evaluation.family] ??= {}),
      evaluation.goldSide,
      evaluation.perturbedSide,
    );
    bump(
      (benchL1ConfusionByFamily[evaluation.family] ??= {}),
      evaluation.goldBenchL1,
      evaluation.perturbedBenchL1,
    );
  }
  const transitions = evaluations.filter(
    (evaluation) =>
      evaluation.transition !== "stable_label" && evaluation.transition !== "stable_abstain",
  );
  heap.push(heapSample("report_done", startedAt));
  return {
    harnessVersion: STROKE_CONFUSION_ADVERSARIAL_VERSION,
    classifierVersion: STROKE_HEURISTIC_VERSION,
    evidenceClass: "linux_replay_proxy",
    seedScheme:
      "seed = FNV-1a32(`${rowId}|${variantId}`) → LCG(1664525, 1013904223); Box-Muller for Gaussian draws",
    rowCount: rows.length,
    variantCount: variants.length,
    totalEvaluations: evaluations.length,
    skippedNotApplicable: skipped,
    baselines,
    baselineParityViolations,
    overall,
    byFamily,
    byVariant,
    byRow,
    sideConfusionByFamily,
    benchL1ConfusionByFamily,
    transitions,
    confidentLabelFlips: evaluations.filter(
      (evaluation) => evaluation.transition === "confident_label_flip",
    ),
    newlyConfidentlyWrong: evaluations.filter((evaluation) => evaluation.newlyConfidentlyWrong),
    abstainToLabel: evaluations.filter(
      (evaluation) => evaluation.transition === "abstain_to_label",
    ),
    expectationViolations: evaluations.filter((evaluation) => evaluation.expectationViolated),
    parityViolations: evaluations
      .filter((evaluation) => evaluation.parityViolation)
      .map((evaluation) => ({
        rowId: evaluation.rowId,
        variantId: evaluation.variantId,
        seed: evaluation.seed,
      })),
    timing: { totalMs: Math.round(performance.now() - startedAt), heap },
    disclosures: [
      "Linux replay over COMMITTED Apple-Vision pose with paddle=null; perturbations are synthetic and deterministic — they probe the classifier's decision surface, not device behaviour.",
      "handedness_flip / chirality_swap are EXPECTED to mirror a committed side: the classifier reads side relative to the declared hand and the pose estimator's chirality. Those rows quantify how much of the committed-side claim rests on an unverifiable premise; they are not classifier bugs unless the row also violates a stated invariant (reflect).",
      "owner_swap scores the OTHER player's track against this label: any commit there is a wrong-player claim the classifier cannot detect by itself (attribution is upstream).",
      "Counts, not rates: the substrate is 18 rows. `newly_confidently_wrong` is the headline safety counter (committed AND wrong vs gold where the unperturbed baseline was not).",
      "Held-out cases wm-dink-01 and afn-vic-rally1 have no committed pose and are excluded by construction.",
    ],
    evaluations: evaluations.map((evaluation) => ({
      rowId: evaluation.rowId,
      variantId: evaluation.variantId,
      seed: evaluation.seed,
      baselineLabel: evaluation.baselineLabel,
      perturbedLabel: evaluation.perturbedLabel,
      perturbedConfidence: evaluation.perturbedConfidence,
      perturbedReason: evaluation.perturbedReason,
      perturbedL1: evaluation.perturbedL1,
      perturbedL2: evaluation.perturbedL2,
      transition: evaluation.transition,
      newlyConfidentlyWrong: evaluation.newlyConfidentlyWrong,
      expectationViolated: evaluation.expectationViolated,
    })),
  };
}

/** Re-derive one (row, variant) evaluation from scratch — the replay path.
 * `context` lets a caller reuse already-loaded rows/variants; the evaluation
 * itself is always recomputed. */
export function replayEvaluation(
  rowId: string,
  variantId: string,
  root: string = PB,
  context?: { rows?: SweepRow[]; variants?: Variant[] },
): Evaluation | null {
  const row = (context?.rows ?? buildSweepRows(root)).find(
    (candidate) => candidate.rowId === rowId,
  );
  const variant = (context?.variants ?? buildVariants()).find(
    (candidate) => candidate.variantId === variantId,
  );
  if (!row || !variant) return null;
  return evaluateVariant(row, variant, predict(baselineInput(row)));
}

function formatCounts(counts: TransitionCounts): string {
  return (
    `n=${counts.n} stable_label=${counts.stable_label} stable_abstain=${counts.stable_abstain} ` +
    `reason_changed=${counts.abstain_reason_changed} label→abstain=${counts.label_to_abstain} ` +
    `abstain→label=${counts.abstain_to_label} FLIP=${counts.confident_label_flip} ` +
    `perturbed_wrong=${counts.perturbed_confidently_wrong} NEWLY_WRONG=${counts.newly_confidently_wrong} ` +
    `expect_viol=${counts.expectation_violations} parity_viol=${counts.parity_violations}`
  );
}

function formatMatrix(title: string, matrix: ConfusionMatrix): string[] {
  const columns = [...new Set(Object.values(matrix).flatMap((row) => Object.keys(row)))].sort();
  const width = 16;
  const lines = [`  ${title}`];
  lines.push(
    `    ${"gold \\ pred".padEnd(width)} ${columns.map((column) => column.padEnd(width)).join(" ")}`,
  );
  for (const gold of Object.keys(matrix).sort()) {
    lines.push(
      `    ${gold.padEnd(width)} ${columns.map((column) => String(matrix[gold]?.[column] ?? 0).padEnd(width)).join(" ")}`,
    );
  }
  return lines;
}

function formatEvaluation(evaluation: Evaluation): string {
  return (
    `${evaluation.rowId} ${evaluation.variantId} seed=${evaluation.seed} params=${JSON.stringify(evaluation.params)}: ` +
    `${evaluation.baselineLabel}(${evaluation.baselineConfidence.toFixed(2)})[${evaluation.baselineReason ?? "—"}] → ` +
    `${evaluation.perturbedLabel}(${evaluation.perturbedConfidence.toFixed(2)})[${evaluation.perturbedReason ?? "—"}] ` +
    `gold=${evaluation.goldL1}/${evaluation.goldL2} L1=${evaluation.perturbedL1} L2=${evaluation.perturbedL2}` +
    `${evaluation.newlyConfidentlyWrong ? " NEWLY_WRONG" : ""}${evaluation.expectationViolated ? " EXPECT_VIOL" : ""}`
  );
}

export function formatSweep(report: SweepReport): string[] {
  const lines: string[] = [];
  lines.push(
    `${report.harnessVersion} · ${report.classifierVersion} · ${report.evidenceClass} · rows=${report.rowCount} variants=${report.variantCount} evals=${report.totalEvaluations} skipped(n/a)=${report.skippedNotApplicable}`,
  );
  lines.push(`seeds: ${report.seedScheme}`);
  lines.push(`baseline Lab↔Lite parity violations: ${report.baselineParityViolations.length}`);
  lines.push(`OVERALL ${formatCounts(report.overall)}`);
  lines.push("BY FAMILY");
  for (const [family, counts] of Object.entries(report.byFamily)) {
    lines.push(`  ${family.padEnd(16)} ${formatCounts(counts)}`);
    lines.push(
      ...formatMatrix(`side confusion (${family})`, report.sideConfusionByFamily[family] ?? {}),
    );
    lines.push(
      ...formatMatrix(
        `benchL1 confusion (${family})`,
        report.benchL1ConfusionByFamily[family] ?? {},
      ),
    );
  }
  lines.push("BY ROW");
  for (const [rowId, counts] of Object.entries(report.byRow))
    lines.push(`  ${rowId.padEnd(40)} ${formatCounts(counts)}`);
  lines.push(`CONFIDENT LABEL FLIPS: ${report.confidentLabelFlips.length}`);
  for (const evaluation of report.confidentLabelFlips)
    lines.push(`  ${formatEvaluation(evaluation)}`);
  lines.push(`NEWLY CONFIDENTLY WRONG vs gold: ${report.newlyConfidentlyWrong.length}`);
  for (const evaluation of report.newlyConfidentlyWrong)
    lines.push(`  ${formatEvaluation(evaluation)}`);
  lines.push(`ABSTAIN → LABEL (manufactured commits): ${report.abstainToLabel.length}`);
  for (const evaluation of report.abstainToLabel) lines.push(`  ${formatEvaluation(evaluation)}`);
  lines.push(`EXPECTATION VIOLATIONS: ${report.expectationViolations.length}`);
  for (const evaluation of report.expectationViolations)
    lines.push(`  ${formatEvaluation(evaluation)}`);
  lines.push(`PARITY VIOLATIONS: ${report.parityViolations.length}`);
  lines.push(`timing: ${report.timing.totalMs}ms; heap: ${JSON.stringify(report.timing.heap)}`);
  lines.push("DISCLOSURES");
  for (const disclosure of report.disclosures) lines.push(`  - ${disclosure}`);
  return lines;
}

export function writeSweep(
  report: SweepReport,
  outDir: string,
): { jsonPath: string; textPath: string } {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "stroke-confusion-adversarial.json");
  const textPath = join(outDir, "stroke-confusion-adversarial.txt");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(textPath, `${formatSweep(report).join("\n")}\n`);
  return { jsonPath, textPath };
}

function parseArgs(argv: readonly string[]): {
  outDir: string;
  replay: { rowId: string; variantId: string } | null;
} {
  let outDir = join(REPO_ROOT, "artifacts/xc-cv-classification-confusion");
  let replay: { rowId: string; variantId: string } | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out-dir" && argv[i + 1]) {
      outDir = argv[i + 1]!;
      i += 1;
    } else if (argv[i] === "--replay" && argv[i + 1] && argv[i + 2]) {
      replay = { rowId: argv[i + 1]!, variantId: argv[i + 2]! };
      i += 2;
    }
  }
  return { outDir, replay };
}

const isMain = process.argv[1]?.endsWith("strokeConfusionAdversarial.ts");
if (isMain) {
  const { outDir, replay } = parseArgs(process.argv.slice(2));
  if (replay) {
    const evaluation = replayEvaluation(replay.rowId, replay.variantId);
    if (!evaluation) {
      process.stderr.write(
        `no such row/variant or variant not applicable: ${replay.rowId} ${replay.variantId}\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
    }
  } else {
    const report = runSweep();
    const written = writeSweep(report, outDir);
    process.stdout.write(`${formatSweep(report).join("\n")}\n`);
    process.stdout.write(`written: ${written.jsonPath}\n`);
    process.stdout.write(`written: ${written.textPath}\n`);
  }
}
