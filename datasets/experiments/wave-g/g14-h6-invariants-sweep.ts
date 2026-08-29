// G14-H6 INVARIANT / COUNTERFACTUAL ROBUSTNESS SWEEP of stroke-heuristic-6.
//
//   cd packages/swing-lab && npx tsx ../../datasets/experiments/wave-g/g14-h6-invariants-sweep.ts
//
// Substrate: the committed-data stroke bench rows (wave-E e03) — every
// stroke-gold label whose case has a committed wave-a pose slice
// (datasets/paddle-bench/runs-wave-a). Held-out cases (wm-dink-01,
// afn-vic-rally1) have no committed pose here and are excluded by
// construction; this script never references them.
//
// For each evaluable row the BASELINE classifyStroke input is rebuilt exactly
// as strokeHeuristicBench builds it (same track attribution, same gold
// contact / wrist-speed-peak reference, paddle=null, recomputed wrist
// speeds), then perturbed along six deterministic families:
//
//   torso    — hip line moved toward/away from the shoulder line (per-frame
//              hip Y offsets scaled ×0.85..×1.15): minor torso-extent error.
//   crop     — global affine similarity (scale about frame center ×0.8..×1.2,
//              translation up to ±0.06u): crop / zoom variation.
//   framerate— temporal decimation keep-every-2nd (both phases) and
//              keep-every-3rd (all phases): 30→15/10fps resampling.
//   noise    — deterministic pseudo-Gaussian jitter on every landmark
//              (σ ∈ {0.002, 0.005, 0.01}, 3 seeds each).
//   dropout  — per-landmark deletion (p ∈ {0.1, 0.2}, 3 seeds each):
//              missing-joint dropout.
//   reflect  — physically meaningful mirror: x→1−x, left_/right_ joint names
//              swapped, declared handedness flipped. A mirrored player's
//              stroke identity is UNCHANGED (a right-hander's forehand is the
//              mirror left-hander's forehand), so any label change is an
//              invariant violation by construction.
//
// Wrist speeds are recomputed from the PERTURBED sequence (the production
// path), and rows whose gold contactMs is null re-derive the wrist-speed-peak
// reference from the perturbed series, exactly as the bench does.
//
// Outcome taxonomy per (row, variant), baseline → perturbed:
//   stable_label            same committed (non-UNKNOWN) label
//   stable_abstain          UNKNOWN → UNKNOWN, same primary abstention reason
//   abstain_reason_changed  UNKNOWN → UNKNOWN, different primary reason
//   label_to_abstain        committed → UNKNOWN (honest degradation)
//   abstain_to_label        UNKNOWN → committed (perturbation UNLOCKED a claim)
//   confident_label_flip    committed → DIFFERENT committed label (DANGEROUS)
//
// The primary abstention reason is the last limiting factor pushed by the
// unknown() path (the `reason` argument), or "unreasoned_abstain" when the
// abstention carried no reason code.
//
// The Lite copy (packages/vision-geometry strokeHeuristicLite) is run on every
// perturbed input as well; any Lab↔Lite output divergence is counted as a
// parity violation (D-036 lock).
//
// Everything is deterministic: a hash-based LCG seeded from (caseId, event,
// family, variant) — reruns produce byte-identical artifacts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoseSequence } from "@pickle/swing-domain";
import { classifyStroke as classifyLite } from "../../../packages/vision-geometry/src/index.js";
import { dominantWristSpeeds } from "../../../packages/swing-lab/src/engine/minerCore.js";
import { targetPoseSequence } from "../../../packages/swing-lab/src/playerTracker.js";
import {
  classifyStroke,
  STROKE_HEURISTIC_VERSION,
  type StrokePrediction,
} from "../../../packages/swing-lab/src/strokeHeuristic.js";
import {
  loadCaseHandedness,
  loadCasePose,
  loadStrokeGold,
  pickOtherTrack,
  pickTargetTrack,
  STROKE_BENCH_POSE_CASES,
} from "../../../packages/swing-lab/src/strokeHeuristicBench.js";

const ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");
const OUT_DIR = join(ROOT, "datasets/experiments/wave-g");

// ── deterministic RNG ──────────────────────────────────────────────────────

function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Box-Muller from two LCG draws — deterministic pseudo-Gaussian. */
function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── perturbations (pure PoseSequence → PoseSequence) ──────────────────────

type Frames = PoseSequence["frames"];

function withFrames(sequence: PoseSequence, frames: Frames): PoseSequence {
  return { ...sequence, frames };
}

function mapLandmarks(
  sequence: PoseSequence,
  fn: (
    mark: Frames[number]["landmarks"][number],
    frame: Frames[number],
  ) => Frames[number]["landmarks"][number] | null,
): PoseSequence {
  return withFrames(
    sequence,
    sequence.frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks
        .map((mark) => fn(mark, frame))
        .filter((mark): mark is Frames[number]["landmarks"][number] => mark !== null),
    })),
  );
}

/** Scale each hip landmark's Y offset from the frame's own shoulder line. */
function perturbTorsoExtent(sequence: PoseSequence, factor: number): PoseSequence {
  return withFrames(
    sequence,
    sequence.frames.map((frame) => {
      const ls = frame.landmarks.find((m) => m.name === "left_shoulder");
      const rs = frame.landmarks.find((m) => m.name === "right_shoulder");
      if (!ls || !rs) return frame;
      const shoulderY = (ls.y + rs.y) / 2;
      return {
        ...frame,
        landmarks: frame.landmarks.map((mark) =>
          mark.name === "left_hip" || mark.name === "right_hip"
            ? { ...mark, y: shoulderY + (mark.y - shoulderY) * factor }
            : mark,
        ),
      };
    }),
  );
}

/** Similarity transform about the frame center (crop/zoom variation). */
function perturbCrop(sequence: PoseSequence, scale: number, dx: number, dy: number): PoseSequence {
  return mapLandmarks(sequence, (mark) => ({
    ...mark,
    x: 0.5 + (mark.x - 0.5) * scale + dx,
    y: 0.5 + (mark.y - 0.5) * scale + dy,
  }));
}

/** Temporal decimation: keep frames whose index ≡ phase (mod step). */
function perturbFramerate(sequence: PoseSequence, step: number, phase: number): PoseSequence {
  return withFrames(
    sequence,
    sequence.frames.filter((_, index) => index % step === phase),
  );
}

function perturbNoise(sequence: PoseSequence, sigma: number, seed: number): PoseSequence {
  const rng = makeRng(seed);
  return mapLandmarks(sequence, (mark) => ({
    ...mark,
    x: mark.x + sigma * gaussian(rng),
    y: mark.y + sigma * gaussian(rng),
  }));
}

function perturbDropout(sequence: PoseSequence, probability: number, seed: number): PoseSequence {
  const rng = makeRng(seed);
  return mapLandmarks(sequence, (mark) => (rng() < probability ? null : mark));
}

function reflectName(name: string): string {
  if (name.startsWith("left_")) return `right_${name.slice(5)}`;
  if (name.startsWith("right_")) return `left_${name.slice(6)}`;
  return name;
}

function perturbReflect(sequence: PoseSequence): PoseSequence {
  return mapLandmarks(sequence, (mark) => ({
    ...mark,
    name: reflectName(mark.name),
    x: 1 - mark.x,
  }));
}

// ── row construction (mirrors strokeHeuristicBench.evaluateGoldLabel) ─────

interface SweepRow {
  rowId: string;
  caseId: string;
  owner: "target" | "other";
  goldL1: string;
  goldL2: string;
  handedness: "right" | "left";
  sequence: PoseSequence;
  window: { startMs: number; endMs: number };
  goldContactMs: number | null;
}

function buildRows(): SweepRow[] {
  const gold = loadStrokeGold();
  const rows: SweepRow[] = [];
  const poseCache = new Map<string, ReturnType<typeof loadCasePose>>();
  for (const label of gold.labels) {
    if (!STROKE_BENCH_POSE_CASES[label.caseId]) continue;
    if (!poseCache.has(label.caseId)) poseCache.set(label.caseId, loadCasePose(label.caseId));
    const pose = poseCache.get(label.caseId);
    if (!pose) continue;
    const window = { startMs: label.eventStartMs, endMs: label.eventEndMs };
    const target = pickTargetTrack(pose.tracks);
    const track =
      label.owner === "target"
        ? target
        : target
          ? pickOtherTrack(pose.tracks, target, window)
          : null;
    if (!track) continue;
    const inWindow = track.frames.filter(
      (frame) => frame.timestampMs >= window.startMs && frame.timestampMs <= window.endMs,
    ).length;
    if (inWindow === 0) continue;
    rows.push({
      rowId: `${label.caseId}@${label.eventStartMs}/${label.owner}`,
      caseId: label.caseId,
      owner: label.owner,
      goldL1: label.l1,
      goldL2: label.l2,
      handedness: loadCaseHandedness(label.caseId) ?? "right",
      sequence: targetPoseSequence(pose.file, track),
      window,
      goldContactMs: label.contactMs,
    });
  }
  return rows;
}

function predict(
  row: SweepRow,
  sequence: PoseSequence,
  handedness: "right" | "left",
): { lab: StrokePrediction; lite: StrokePrediction; reference: string } {
  const wristSpeeds = dominantWristSpeeds(sequence.frames);
  const contactMs: number | null = row.goldContactMs;
  let eventPeakMs: number | null = null;
  let reference = "gold_contact";
  if (contactMs === null) {
    const inWindow = wristSpeeds.filter(
      (sample) =>
        sample.timestampMs >= row.window.startMs && sample.timestampMs <= row.window.endMs,
    );
    const peak = inWindow.reduce(
      (best: { timestampMs: number; value: number } | null, sample) =>
        best === null || sample.value > best.value ? sample : best,
      null,
    );
    eventPeakMs = peak?.timestampMs ?? null;
    reference = eventPeakMs !== null ? "wrist_speed_peak" : "none";
  }
  const input = {
    sequence,
    window: row.window,
    contactMs,
    eventPeakMs,
    handedness,
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds,
  };
  return {
    lab: classifyStroke(input),
    lite: classifyLite(input as Parameters<typeof classifyLite>[0]),
    reference,
  };
}

// ── outcome taxonomy ───────────────────────────────────────────────────────

const ABSTAIN_REASONS = new Set([
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

function primaryAbstainReason(prediction: StrokePrediction): string {
  for (let i = prediction.limitingFactors.length - 1; i >= 0; i -= 1) {
    const factor = prediction.limitingFactors[i]!;
    if (ABSTAIN_REASONS.has(factor)) return factor;
  }
  return "unreasoned_abstain";
}

type Outcome =
  | "stable_label"
  | "stable_abstain"
  | "abstain_reason_changed"
  | "label_to_abstain"
  | "abstain_to_label"
  | "confident_label_flip";

function classifyOutcome(base: StrokePrediction, perturbed: StrokePrediction): Outcome {
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

// ── variant matrix ─────────────────────────────────────────────────────────

interface Variant {
  family: string;
  variantId: string;
  apply: (sequence: PoseSequence, seed: number) => PoseSequence;
  /** Reflection flips the declared handedness with the geometry. */
  flipsHandedness?: boolean;
}

function buildVariants(): Variant[] {
  const variants: Variant[] = [];
  for (const factor of [0.85, 0.9, 0.95, 1.05, 1.1, 1.15]) {
    variants.push({
      family: "torso",
      variantId: `torso_x${factor}`,
      apply: (sequence) => perturbTorsoExtent(sequence, factor),
    });
  }
  for (const [scale, dx, dy] of [
    [0.8, 0, 0],
    [0.9, 0.04, -0.03],
    [1.1, -0.04, 0.03],
    [1.2, 0, 0],
    [1.0, 0.06, 0.06],
    [1.0, -0.06, -0.06],
  ] as const) {
    variants.push({
      family: "crop",
      variantId: `crop_s${scale}_d${dx}_${dy}`,
      apply: (sequence) => perturbCrop(sequence, scale, dx, dy),
    });
  }
  for (const [step, phase] of [
    [2, 0],
    [2, 1],
    [3, 0],
    [3, 1],
    [3, 2],
  ] as const) {
    variants.push({
      family: "framerate",
      variantId: `fps_keep1of${step}_phase${phase}`,
      apply: (sequence) => perturbFramerate(sequence, step, phase),
    });
  }
  for (const sigma of [0.002, 0.005, 0.01]) {
    for (let seedIndex = 0; seedIndex < 3; seedIndex += 1) {
      variants.push({
        family: "noise",
        variantId: `noise_s${sigma}_seed${seedIndex}`,
        apply: (sequence, seed) => perturbNoise(sequence, sigma, seed),
      });
    }
  }
  for (const probability of [0.1, 0.2]) {
    for (let seedIndex = 0; seedIndex < 3; seedIndex += 1) {
      variants.push({
        family: "dropout",
        variantId: `dropout_p${probability}_seed${seedIndex}`,
        apply: (sequence, seed) => perturbDropout(sequence, probability, seed),
      });
    }
  }
  variants.push({
    family: "reflect",
    variantId: "reflect_lr",
    apply: (sequence) => perturbReflect(sequence),
    flipsHandedness: true,
  });
  return variants;
}

// ── sweep ──────────────────────────────────────────────────────────────────

interface VariantResult {
  rowId: string;
  family: string;
  variantId: string;
  baselineLabel: string;
  baselineReason: string | null;
  perturbedLabel: string;
  perturbedReason: string | null;
  baselineConfidence: number;
  perturbedConfidence: number;
  outcome: Outcome;
  parityViolation: boolean;
}

function main(): void {
  const rows = buildRows();
  const variants = buildVariants();
  const results: VariantResult[] = [];
  const baselines: Array<{
    rowId: string;
    goldL1: string;
    goldL2: string;
    label: string;
    reason: string | null;
    confidence: number;
    reference: string;
  }> = [];

  for (const row of rows) {
    const base = predict(row, row.sequence, row.handedness);
    const baseParityBroken = JSON.stringify(base.lab) !== JSON.stringify(base.lite);
    baselines.push({
      rowId: row.rowId,
      goldL1: row.goldL1,
      goldL2: row.goldL2,
      label: base.lab.label,
      reason: base.lab.label === "UNKNOWN" ? primaryAbstainReason(base.lab) : null,
      confidence: base.lab.confidence,
      reference: base.reference,
    });
    if (baseParityBroken) {
      throw new Error(`baseline Lab↔Lite parity violation on ${row.rowId}`);
    }
    for (const variant of variants) {
      const seed = hashSeed(`${row.rowId}|${variant.variantId}`);
      const perturbedSequence = variant.apply(row.sequence, seed);
      const handedness = variant.flipsHandedness
        ? row.handedness === "right"
          ? "left"
          : "right"
        : row.handedness;
      const perturbed = predict(row, perturbedSequence, handedness);
      results.push({
        rowId: row.rowId,
        family: variant.family,
        variantId: variant.variantId,
        baselineLabel: base.lab.label,
        baselineReason: base.lab.label === "UNKNOWN" ? primaryAbstainReason(base.lab) : null,
        perturbedLabel: perturbed.lab.label,
        perturbedReason:
          perturbed.lab.label === "UNKNOWN" ? primaryAbstainReason(perturbed.lab) : null,
        baselineConfidence: base.lab.confidence,
        perturbedConfidence: perturbed.lab.confidence,
        outcome: classifyOutcome(base.lab, perturbed.lab),
        parityViolation: JSON.stringify(perturbed.lab) !== JSON.stringify(perturbed.lite),
      });
    }
  }

  const outcomeCounts = (subset: VariantResult[]): Record<Outcome, number> => {
    const counts: Record<Outcome, number> = {
      stable_label: 0,
      stable_abstain: 0,
      abstain_reason_changed: 0,
      label_to_abstain: 0,
      abstain_to_label: 0,
      confident_label_flip: 0,
    };
    for (const result of subset) counts[result.outcome] += 1;
    return counts;
  };

  const byFamily: Record<string, Record<Outcome, number> & { n: number }> = {};
  for (const family of [...new Set(results.map((result) => result.family))]) {
    const subset = results.filter((result) => result.family === family);
    byFamily[family] = { ...outcomeCounts(subset), n: subset.length };
  }
  const dangerous = results.filter((result) => result.outcome === "confident_label_flip");
  const unlocked = results.filter((result) => result.outcome === "abstain_to_label");
  const parityViolations = results.filter((result) => result.parityViolation);

  const report = {
    experiment: "g14-h6-invariants",
    classifierVersion: STROKE_HEURISTIC_VERSION,
    generatedFrom:
      "committed wave-a pose slices (datasets/paddle-bench/runs-wave-a) × stroke-gold.json, same row construction as strokeHeuristicBench (wave-E e03)",
    holdoutStatement:
      "Held-out cases wm-dink-01 and afn-vic-rally1 were never read, referenced, or perturbed; they have no committed pose in this substrate and are excluded by construction.",
    rows: baselines,
    rowCount: rows.length,
    variantCount: buildVariants().length,
    totalEvaluations: results.length,
    overall: { ...outcomeCounts(results), n: results.length },
    byFamily,
    dangerousFlips: dangerous,
    abstainToLabel: unlocked,
    parityViolationCount: parityViolations.length,
    parityViolations: parityViolations.map((result) => ({
      rowId: result.rowId,
      variantId: result.variantId,
    })),
    results,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, "g14-h6-invariants-sweep.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`rows=${rows.length} variants=${buildVariants().length} evals=${results.length}`);
  console.log(`overall: ${JSON.stringify(report.overall)}`);
  for (const [family, counts] of Object.entries(byFamily)) {
    console.log(`  ${family.padEnd(10)} ${JSON.stringify(counts)}`);
  }
  console.log(`dangerous confident_label_flip: ${dangerous.length}`);
  for (const flip of dangerous) {
    console.log(
      `  DANGEROUS ${flip.rowId} ${flip.variantId}: ${flip.baselineLabel}(${flip.baselineConfidence.toFixed(2)}) → ${flip.perturbedLabel}(${flip.perturbedConfidence.toFixed(2)})`,
    );
  }
  console.log(`abstain_to_label: ${unlocked.length}`);
  for (const unlock of unlocked) {
    console.log(
      `  UNLOCK ${unlock.rowId} ${unlock.variantId}: UNKNOWN[${unlock.baselineReason}] → ${unlock.perturbedLabel}(${unlock.perturbedConfidence.toFixed(2)})`,
    );
  }
  console.log(`parity violations: ${parityViolations.length}`);
  console.log(`written: ${outPath}`);
}

main();
