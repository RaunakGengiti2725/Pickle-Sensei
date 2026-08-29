import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toLegacyPoseFrames } from "@pickle/swing-domain";
import { REPO_ROOT } from "./engine/corpus.js";
import { dominantWristSpeeds } from "./engine/minerCore.js";
import { targetPoseSequence, type PlayerTrack } from "./playerTracker.js";
import { classifyStroke as classifyStrokeV6, type StrokePrediction } from "./strokeHeuristic.js";
import { classifyStroke as classifyStrokeV5 } from "./strokeHeuristicV5Frozen.js";
import {
  loadCaseHandedness,
  loadCasePose,
  loadStrokeGold,
  pickOtherTrack,
  pickTargetTrack,
  STROKE_BENCH_POSE_CASES,
  type BenchPose,
} from "./strokeHeuristicBench.js";

/**
 * WAVE-G g13-h6-mining — v5-vs-v6 disagreement + gate-proximity mining over
 * every replayable committed pose sequence (the 8 wave-a people.json runs;
 * the held-out cases wm-dink-01 and afn-vic-rally1 have NO committed pose in
 * this repo and are excluded by construction — verified: zero people.json
 * paths match either id).
 *
 *   pnpm --filter @pickle/swing-lab exec tsx src/g13H6Mining.ts
 *
 * Evaluation units:
 *  1. GOLD EVENTS — every stroke-gold label whose case has committed pose
 *     (same loading/attribution rules as strokeHeuristicBench, paddle=null).
 *  2. MINED WINDOWS — for EVERY player track (not just the target) in every
 *     case: local maxima of the measured dominant-wrist speed series with
 *     ≥600ms separation, each classified with contactMs=null and
 *     eventPeakMs=the measured peak (never a window midpoint). These are
 *     Tier-C machine-proposed windows: NOT truth, an annotation queue only.
 *
 * Both classifiers see byte-identical inputs. Probe metrics below REPLICATE
 * (not import) the classifier's internal geometry so proximity to the two
 * v6 gates can be measured even on rows where neither gate fired:
 *  - sparse-declared-wrist gate: declared-wrist measured-frame count vs the
 *    MIN_TRAVEL_SAMPLE_FRAMES=5 floor under a handedness contradiction;
 *  - median-normalization cross-check: contact height in torso units under
 *    reference-extent vs sequence-median-extent normalization vs the 0.25
 *    overhead line.
 */

export const G13_MINING_VERSION = "g13-h6-mining-v1";

const HELD_OUT = ["wm-dink-01", "afn-vic-rally1"];

// Thresholds replicated from strokeHeuristic.ts (documented anchors there).
const OVERHEAD_LINE = 0.25;
const MIN_TRAVEL_SAMPLE_FRAMES = 5;
const CONTRADICTION_RATIO = 1.5;
const TORSO_COLLAPSE_RATIO = 0.6;

type LegacyFrames = ReturnType<typeof toLegacyPoseFrames>;

interface ProbeMetrics {
  refTorsoExtent: number | null;
  medianTorsoExtent: number | null;
  torsoMedianRatio: number | null;
  dominantWristSide: "left" | "right" | null;
  dominantTravel: number | null;
  dominantMeasuredFrames: number;
  rivalTravel: number | null;
  rivalMeasuredFrames: number;
  declaredHandedness: "right" | "left";
  handednessContradicted: boolean;
  contradictionDecisive: boolean;
  declaredWristMeasuredFrames: number;
  aboveShoulderRef: number | null;
  aboveShoulderMedian: number | null;
  overheadFlipsUnderMedian: boolean;
  wristRaisedFrames: number;
  wristMeasuredFramesRaiseWindow: number;
  elbowRaisedFrames: number;
  maxWristRaise: number | null;
  shoulderSeparationRef: number | null;
  torsoMissingFrameFraction: number;
  windowSpeedPeak: number | null;
  /** |distance to the sparse-declared-wrist firing region| in frames (0 = fired). */
  sparseGateProximityFrames: number | null;
  /** min |height − 0.25 line| across both normalizations (0-ish = near flip). */
  medianGateProximity: number | null;
}

export interface MiningRow {
  unitId: string;
  caseId: string;
  group: string;
  source: "gold_event" | "mined_wrist_peak";
  trackId: number | string;
  trackRole: "target" | "other";
  windowStartMs: number;
  windowEndMs: number;
  referenceMs: number;
  referenceKind: "gold_contact" | "wrist_speed_peak";
  goldL1: string | null;
  goldL2: string | null;
  v5Label: string;
  v5Confidence: number;
  v5LimitingFactors: string[];
  v6Label: string;
  v6Confidence: number;
  v6LimitingFactors: string[];
  disagreement:
    "none" | "label_mismatch" | "v6_new_abstain" | "v6_abstain_other" | "v5_abstain_v6_commit";
  v6GateFired: "sparse_declared_wrist" | "median_normalization" | null;
  categories: string[];
  probes: ProbeMetrics;
  infoScore: number;
}

const V6_GATE_REASONS = {
  sparse_declared_wrist: "declared_wrist_too_sparsely_measured_under_handedness_contradiction",
  median_normalization: "overhead_decision_flips_under_median_torso_normalization",
} as const;

function nearestFrame(frames: LegacyFrames, timestampMs: number) {
  let best: LegacyFrames[number] | null = null;
  let bestDelta = Infinity;
  for (const frame of frames) {
    const delta = Math.abs(frame.timestampMs - timestampMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = frame;
    }
  }
  return best && bestDelta <= 80 ? best : null;
}

function torsoJoints(frame: LegacyFrames[number]) {
  const find = (name: string) => frame.landmarks.find((mark) => mark.name === name);
  const leftShoulder = find("left_shoulder");
  const rightShoulder = find("right_shoulder");
  const leftHip = find("left_hip");
  const rightHip = find("right_hip");
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return null;
  return { leftShoulder, rightShoulder, leftHip, rightHip };
}

function medianTorsoExtent(frames: LegacyFrames): number | null {
  const extents: number[] = [];
  for (const frame of frames) {
    const torso = torsoJoints(frame);
    if (!torso) continue;
    extents.push(
      (torso.leftHip.y + torso.rightHip.y) / 2 - (torso.leftShoulder.y + torso.rightShoulder.y) / 2,
    );
  }
  if (extents.length < 5) return null;
  extents.sort((a, b) => a - b);
  return extents[Math.floor(extents.length / 2)] ?? null;
}

function wristTravelInfo(frames: LegacyFrames, referenceMs: number) {
  const nearby = frames.filter((frame) => Math.abs(frame.timestampMs - referenceMs) <= 200);
  const travel = { left: 0, right: 0 };
  const measured = { left: 0, right: 0 };
  const previous: { left?: { x: number; y: number }; right?: { x: number; y: number } } = {};
  for (const frame of nearby) {
    for (const sideName of ["left", "right"] as const) {
      const mark = frame.landmarks.find(
        (landmark) => landmark.name === `${sideName}_wrist` && landmark.visibility >= 0.25,
      );
      if (!mark) continue;
      measured[sideName] += 1;
      const prior = previous[sideName];
      if (prior) travel[sideName] += Math.hypot(mark.x - prior.x, mark.y - prior.y);
      previous[sideName] = { x: mark.x, y: mark.y };
    }
  }
  return { travel, measured };
}

function raiseWindowInfo(frames: LegacyFrames, referenceMs: number, side: "left" | "right") {
  let wristMeasured = 0;
  let wristRaised = 0;
  let elbowRaised = 0;
  let maxRaise: number | null = null;
  for (const frame of frames) {
    if (Math.abs(frame.timestampMs - referenceMs) > 150) continue;
    const torso = torsoJoints(frame);
    if (!torso) continue;
    const shoulderY = (torso.leftShoulder.y + torso.rightShoulder.y) / 2;
    const extent = (torso.leftHip.y + torso.rightHip.y) / 2 - shoulderY;
    if (extent < 0.04) continue;
    const wrist = frame.landmarks.find(
      (mark) => mark.name === `${side}_wrist` && mark.visibility >= 0.5,
    );
    if (wrist) {
      const raise = (shoulderY - wrist.y) / extent;
      wristMeasured += 1;
      if (raise >= OVERHEAD_LINE) wristRaised += 1;
      if (maxRaise === null || raise > maxRaise) maxRaise = raise;
    }
    const elbow = frame.landmarks.find(
      (mark) => mark.name === `${side}_elbow` && mark.visibility >= 0.5,
    );
    if (elbow && (shoulderY - elbow.y) / extent >= 0.1) elbowRaised += 1;
  }
  return { wristMeasured, wristRaised, elbowRaised, maxRaise };
}

function computeProbes(
  frames: LegacyFrames,
  referenceMs: number,
  window: { startMs: number; endMs: number },
  handedness: "right" | "left",
  wristSpeeds: Array<{ timestampMs: number; value: number }>,
): ProbeMetrics {
  const median = medianTorsoExtent(frames);
  const refFrame = nearestFrame(frames, referenceMs);
  const torso = refFrame ? torsoJoints(refFrame) : null;
  const refExtent = torso
    ? (torso.leftHip.y + torso.rightHip.y) / 2 - (torso.leftShoulder.y + torso.rightShoulder.y) / 2
    : null;
  const shoulderSeparation = torso ? Math.abs(torso.rightShoulder.x - torso.leftShoulder.x) : null;
  const { travel, measured } = wristTravelInfo(frames, referenceMs);
  const dominantSide: "left" | "right" | null =
    measured.left + measured.right > 0 ? (travel.right >= travel.left ? "right" : "left") : null;
  const rivalSide = dominantSide === "right" ? "left" : "right";
  const declaredWristSide: "left" | "right" = handedness === "right" ? "right" : "left";
  const contradicted = dominantSide !== null && dominantSide !== declaredWristSide;
  const decisive =
    contradicted &&
    dominantSide !== null &&
    measured[dominantSide] >= MIN_TRAVEL_SAMPLE_FRAMES &&
    measured[rivalSide] >= MIN_TRAVEL_SAMPLE_FRAMES &&
    travel[dominantSide] >= CONTRADICTION_RATIO * travel[rivalSide];

  // Contact point in this bench is always the dominant wrist (paddle=null).
  let aboveShoulderRef: number | null = null;
  let aboveShoulderMedian: number | null = null;
  if (refFrame && torso && refExtent !== null && refExtent > 0 && dominantSide) {
    const wrist = refFrame.landmarks.find(
      (mark) => mark.name === `${dominantSide}_wrist` && mark.visibility >= 0.25,
    );
    if (wrist) {
      const shoulderY = (torso.leftShoulder.y + torso.rightShoulder.y) / 2;
      aboveShoulderRef = (shoulderY - wrist.y) / Math.max(0.02, refExtent);
      if (median !== null && median > 0) {
        aboveShoulderMedian = (shoulderY - wrist.y) / median;
      }
    }
  }
  const flips =
    aboveShoulderRef !== null &&
    aboveShoulderMedian !== null &&
    refExtent !== null &&
    median !== null &&
    refExtent < median &&
    aboveShoulderRef > OVERHEAD_LINE &&
    aboveShoulderMedian <= OVERHEAD_LINE;

  const raise = dominantSide
    ? raiseWindowInfo(frames, referenceMs, dominantSide)
    : { wristMeasured: 0, wristRaised: 0, elbowRaised: 0, maxRaise: null };

  const windowFrames = frames.filter(
    (frame) => frame.timestampMs >= window.startMs && frame.timestampMs <= window.endMs,
  );
  const missingTorso = windowFrames.filter((frame) => torsoJoints(frame) === null).length;
  const inWindowSpeeds = wristSpeeds.filter(
    (sample) => sample.timestampMs >= window.startMs && sample.timestampMs <= window.endMs,
  );
  const windowSpeedPeak =
    inWindowSpeeds.length > 0 ? Math.max(...inWindowSpeeds.map((sample) => sample.value)) : null;

  const sparseGateProximityFrames = contradicted
    ? Math.max(0, measured[rivalSide] - (MIN_TRAVEL_SAMPLE_FRAMES - 1))
    : null;
  const medianGateProximity =
    aboveShoulderRef !== null && aboveShoulderMedian !== null
      ? Math.min(
          Math.abs(aboveShoulderRef - OVERHEAD_LINE),
          Math.abs(aboveShoulderMedian - OVERHEAD_LINE),
        )
      : null;

  return {
    refTorsoExtent: refExtent,
    medianTorsoExtent: median,
    torsoMedianRatio:
      refExtent !== null && median !== null && median > 0 ? refExtent / median : null,
    dominantWristSide: dominantSide,
    dominantTravel: dominantSide ? travel[dominantSide] : null,
    dominantMeasuredFrames: dominantSide ? measured[dominantSide] : 0,
    rivalTravel: dominantSide ? travel[rivalSide] : null,
    rivalMeasuredFrames: dominantSide ? measured[rivalSide] : 0,
    declaredHandedness: handedness,
    handednessContradicted: contradicted,
    contradictionDecisive: decisive,
    declaredWristMeasuredFrames: measured[declaredWristSide],
    aboveShoulderRef,
    aboveShoulderMedian,
    overheadFlipsUnderMedian: flips,
    wristRaisedFrames: raise.wristRaised,
    wristMeasuredFramesRaiseWindow: raise.wristMeasured,
    elbowRaisedFrames: raise.elbowRaised,
    maxWristRaise: raise.maxRaise,
    shoulderSeparationRef: shoulderSeparation,
    torsoMissingFrameFraction: windowFrames.length > 0 ? missingTorso / windowFrames.length : 1,
    windowSpeedPeak,
    sparseGateProximityFrames,
    medianGateProximity,
  };
}

/** Mission category predicates — MEASURED geometry only, never labels. */
function categorize(probes: ProbeMetrics, v6: StrokePrediction, goldL1: string | null): string[] {
  const categories: string[] = [];
  if (probes.handednessContradicted) categories.push("wrong_arm_geometry");
  if (probes.torsoMedianRatio !== null && probes.torsoMedianRatio < TORSO_COLLAPSE_RATIO) {
    categories.push("torso_collapse");
  } else if (probes.torsoMedianRatio !== null && probes.torsoMedianRatio < 0.85) {
    categories.push("partial_torso_compression");
  }
  if (probes.wristRaisedFrames >= 2 || probes.elbowRaisedFrames >= 2) {
    categories.push("overhead_like_arm_config");
  }
  if (probes.maxWristRaise !== null && probes.maxWristRaise >= 0.05 && v6.label !== "OVERHEAD") {
    categories.push("non_overhead_high_wrist");
  }
  if (
    (goldL1 === "serve" || goldL1 === "return") &&
    (probes.wristRaisedFrames >= 1 || (probes.maxWristRaise !== null && probes.maxWristRaise > 0))
  ) {
    categories.push("serve_return_raised_arm");
  }
  if (probes.torsoMissingFrameFraction >= 0.3) categories.push("occluded_or_cropped_torso");
  // Aspect ratio (image-plane shoulder separation / torso extent) is scale-
  // invariant; raw separation would confound camera distance with yaw. In
  // THIS footage the measured distribution across all 118 units is
  // min .001 / p25 .239 / median .365 / p75 .411 / max 1.484 (elevated
  // far-court cameras compress shoulders throughout), so the queue flags
  // only the bottom quartile as near-profile extremes — a queue-building
  // heuristic, not a truth claim.
  if (
    probes.shoulderSeparationRef !== null &&
    probes.refTorsoExtent !== null &&
    probes.refTorsoExtent > 0 &&
    probes.shoulderSeparationRef / probes.refTorsoExtent < 0.24
  ) {
    categories.push("perspective_distortion_near_profile");
  }
  return categories;
}

function classifyDisagreement(
  v5: StrokePrediction,
  v6: StrokePrediction,
): { disagreement: MiningRow["disagreement"]; v6GateFired: MiningRow["v6GateFired"] } {
  const sparse = v6.limitingFactors.includes(V6_GATE_REASONS.sparse_declared_wrist);
  const median = v6.limitingFactors.includes(V6_GATE_REASONS.median_normalization);
  const v6GateFired = sparse ? "sparse_declared_wrist" : median ? "median_normalization" : null;
  if (v5.label === v6.label) return { disagreement: "none", v6GateFired };
  if (v6.label === "UNKNOWN" && v5.label !== "UNKNOWN") {
    return { disagreement: v6GateFired ? "v6_new_abstain" : "v6_abstain_other", v6GateFired };
  }
  if (v5.label === "UNKNOWN" && v6.label !== "UNKNOWN") {
    return { disagreement: "v5_abstain_v6_commit", v6GateFired };
  }
  return { disagreement: "label_mismatch", v6GateFired };
}

function infoScore(row: Omit<MiningRow, "infoScore">): number {
  let score = 0;
  if (row.disagreement === "v6_new_abstain") score += 5;
  else if (row.disagreement === "label_mismatch") score += 4;
  else if (row.disagreement === "v5_abstain_v6_commit") score += 3;
  else if (row.disagreement === "v6_abstain_other") score += 2;
  if (row.probes.sparseGateProximityFrames !== null) {
    score += 2 / (1 + row.probes.sparseGateProximityFrames);
  }
  if (row.probes.medianGateProximity !== null) {
    score += 1 / (1 + 10 * row.probes.medianGateProximity);
  }
  score += 0.5 * row.categories.length;
  if (row.source === "gold_event") score += 0.5;
  return Number(score.toFixed(3));
}

/** Local maxima of the wrist-speed series with ≥600ms separation (greedy by
 * value). Every peak counts — low-energy peaks exercise the non-swing gates. */
function speedPeaks(
  speeds: Array<{ timestampMs: number; value: number }>,
): Array<{ timestampMs: number; value: number }> {
  const sorted = [...speeds].sort((a, b) => b.value - a.value);
  const chosen: Array<{ timestampMs: number; value: number }> = [];
  for (const sample of sorted) {
    if (chosen.every((peak) => Math.abs(peak.timestampMs - sample.timestampMs) >= 600)) {
      chosen.push(sample);
    }
  }
  return chosen.sort((a, b) => a.timestampMs - b.timestampMs);
}

// Typed against the frozen v5 signature (required paddle confidence) — the
// stricter of the two, structurally assignable to v6's optional-confidence
// canonical signature.
function runBoth(input: Parameters<typeof classifyStrokeV5>[0]): {
  v5: StrokePrediction;
  v6: StrokePrediction;
} {
  return { v5: classifyStrokeV5(input), v6: classifyStrokeV6(input) };
}

export function runG13Mining(): {
  rows: MiningRow[];
  gateFireCounts: Record<string, { v5: number; v6: number }>;
  categoryCounts: Record<string, number>;
} {
  for (const held of HELD_OUT) {
    if (STROKE_BENCH_POSE_CASES[held]) throw new Error(`held-out case ${held} in pose cases`);
  }
  const rows: MiningRow[] = [];
  const gold = loadStrokeGold();
  const poseCache = new Map<string, BenchPose | null>();
  const loadPose = (caseId: string): BenchPose | null => {
    if (!poseCache.has(caseId)) poseCache.set(caseId, loadCasePose(caseId));
    return poseCache.get(caseId)!;
  };

  // 1. Gold events (dev labels on committed pose).
  for (const label of gold.labels) {
    if (HELD_OUT.includes(label.caseId)) continue; // defense in depth; none exist
    const info = STROKE_BENCH_POSE_CASES[label.caseId];
    if (!info) continue;
    const pose = loadPose(label.caseId);
    if (!pose) continue;
    const handedness = loadCaseHandedness(label.caseId) ?? "right";
    const window = { startMs: label.eventStartMs, endMs: label.eventEndMs };
    const target = pickTargetTrack(pose.tracks);
    let track: PlayerTrack | null = null;
    let role: "target" | "other" = "target";
    if (label.owner === "target") {
      track = target;
    } else if (target) {
      track = pickOtherTrack(pose.tracks, target, window);
      role = "other";
    }
    if (!track) continue;
    const sequence = targetPoseSequence(pose.file, track);
    const frames = toLegacyPoseFrames(sequence);
    const wristSpeeds = dominantWristSpeeds(sequence.frames);
    let referenceMs = label.contactMs;
    let referenceKind: MiningRow["referenceKind"] = "gold_contact";
    let eventPeakMs: number | null = null;
    if (referenceMs === null) {
      const inWindow = wristSpeeds.filter(
        (sample) => sample.timestampMs >= window.startMs && sample.timestampMs <= window.endMs,
      );
      const peak = inWindow.reduce(
        (best: { timestampMs: number; value: number } | null, sample) =>
          best === null || sample.value > best.value ? sample : best,
        null,
      );
      if (!peak) continue;
      eventPeakMs = peak.timestampMs;
      referenceMs = peak.timestampMs;
      referenceKind = "wrist_speed_peak";
    }
    const { v5, v6 } = runBoth({
      sequence,
      window,
      contactMs: label.contactMs,
      eventPeakMs,
      handedness,
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds,
      legacyFrames: frames,
    });
    const probes = computeProbes(frames, referenceMs, window, handedness, wristSpeeds);
    const categories = categorize(probes, v6, label.l1);
    const { disagreement, v6GateFired } = classifyDisagreement(v5, v6);
    const partial: Omit<MiningRow, "infoScore"> = {
      unitId: `gold:${label.caseId}@${label.eventStartMs}`,
      caseId: label.caseId,
      group: info.group,
      source: "gold_event",
      trackId: track.trackId,
      trackRole: role,
      windowStartMs: window.startMs,
      windowEndMs: window.endMs,
      referenceMs,
      referenceKind,
      goldL1: label.l1,
      goldL2: label.l2,
      v5Label: v5.label,
      v5Confidence: v5.confidence,
      v5LimitingFactors: v5.limitingFactors,
      v6Label: v6.label,
      v6Confidence: v6.confidence,
      v6LimitingFactors: v6.limitingFactors,
      disagreement,
      v6GateFired,
      categories,
      probes,
    };
    rows.push({ ...partial, infoScore: infoScore(partial) });
  }

  // 2. Mined windows over EVERY track of every committed-pose case.
  for (const [caseId, info] of Object.entries(STROKE_BENCH_POSE_CASES)) {
    const pose = loadPose(caseId);
    if (!pose) continue;
    const handedness = loadCaseHandedness(caseId) ?? "right";
    for (const track of pose.tracks) {
      if (track.frames.length < 10) continue;
      const sequence = targetPoseSequence(pose.file, track);
      const frames = toLegacyPoseFrames(sequence);
      const wristSpeeds = dominantWristSpeeds(sequence.frames);
      if (wristSpeeds.length < 5) continue;
      const target = pickTargetTrack(pose.tracks);
      const role: "target" | "other" =
        target && target.trackId === track.trackId ? "target" : "other";
      for (const peak of speedPeaks(wristSpeeds)) {
        const window = { startMs: peak.timestampMs - 400, endMs: peak.timestampMs + 400 };
        const { v5, v6 } = runBoth({
          sequence,
          window,
          contactMs: null,
          eventPeakMs: peak.timestampMs,
          handedness,
          paddle: null,
          paddleSpeeds: null,
          wristSpeeds,
          legacyFrames: frames,
        });
        const probes = computeProbes(frames, peak.timestampMs, window, handedness, wristSpeeds);
        const categories = categorize(probes, v6, null);
        const { disagreement, v6GateFired } = classifyDisagreement(v5, v6);
        const partial: Omit<MiningRow, "infoScore"> = {
          unitId: `mined:${caseId}:t${track.trackId}@${peak.timestampMs}`,
          caseId,
          group: info.group,
          source: "mined_wrist_peak",
          trackId: track.trackId,
          trackRole: role,
          windowStartMs: window.startMs,
          windowEndMs: window.endMs,
          referenceMs: peak.timestampMs,
          referenceKind: "wrist_speed_peak",
          goldL1: null,
          goldL2: null,
          v5Label: v5.label,
          v5Confidence: v5.confidence,
          v5LimitingFactors: v5.limitingFactors,
          v6Label: v6.label,
          v6Confidence: v6.confidence,
          v6LimitingFactors: v6.limitingFactors,
          disagreement,
          v6GateFired,
          categories,
          probes,
        };
        rows.push({ ...partial, infoScore: infoScore(partial) });
      }
    }
  }

  // Gate/abstain-reason fire counts per version, across ALL units.
  const gateFireCounts: Record<string, { v5: number; v6: number }> = {};
  const bump = (reason: string, version: "v5" | "v6") => {
    gateFireCounts[reason] ??= { v5: 0, v6: 0 };
    gateFireCounts[reason][version] += 1;
  };
  for (const row of rows) {
    if (row.v5Label === "UNKNOWN") for (const factor of row.v5LimitingFactors) bump(factor, "v5");
    if (row.v6Label === "UNKNOWN") for (const factor of row.v6LimitingFactors) bump(factor, "v6");
  }
  const categoryCounts: Record<string, number> = {};
  for (const row of rows) {
    for (const category of row.categories) {
      categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    }
  }
  rows.sort((a, b) => b.infoScore - a.infoScore);
  return { rows, gateFireCounts, categoryCounts };
}

// ── CLI ───────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith("g13H6Mining.ts");
if (isMain) {
  const { rows, gateFireCounts, categoryCounts } = runG13Mining();
  const outDir = join(REPO_ROOT, "datasets/experiments/wave-g");
  mkdirSync(outDir, { recursive: true });
  const queueDir = join(REPO_ROOT, "datasets/mining/wave-g");
  mkdirSync(queueDir, { recursive: true });

  const report = {
    version: G13_MINING_VERSION,
    generatedAtIso: new Date().toISOString(),
    heldOutExcluded: HELD_OUT,
    unitCounts: {
      total: rows.length,
      goldEvents: rows.filter((row) => row.source === "gold_event").length,
      minedWindows: rows.filter((row) => row.source === "mined_wrist_peak").length,
    },
    disagreementCounts: {
      none: rows.filter((row) => row.disagreement === "none").length,
      v6_new_abstain: rows.filter((row) => row.disagreement === "v6_new_abstain").length,
      v6_abstain_other: rows.filter((row) => row.disagreement === "v6_abstain_other").length,
      v5_abstain_v6_commit: rows.filter((row) => row.disagreement === "v5_abstain_v6_commit")
        .length,
      label_mismatch: rows.filter((row) => row.disagreement === "label_mismatch").length,
    },
    v6GateFires: {
      sparse_declared_wrist: rows.filter((row) => row.v6GateFired === "sparse_declared_wrist")
        .length,
      median_normalization: rows.filter((row) => row.v6GateFired === "median_normalization").length,
    },
    gateFireCounts,
    categoryCounts,
    rows,
  };
  writeFileSync(join(outDir, "g13-h6-mining-report.json"), `${JSON.stringify(report, null, 2)}\n`);

  // Tier-C annotation queue: FROZEN schema g13-annotation-queue-v1.
  const queue = {
    schemaVersion: "g13-annotation-queue-v1",
    tier: "C",
    note: "Machine-proposed annotation queue — NOT truth. Every entry needs a human label before any use as gold.",
    generatedBy: G13_MINING_VERSION,
    generatedAtIso: new Date().toISOString(),
    heldOutExcluded: HELD_OUT,
    categoryCounts,
    entries: rows
      .filter((row) => row.disagreement !== "none" || row.categories.length > 0)
      .map((row, index) => ({
        rank: index + 1,
        unitId: row.unitId,
        caseId: row.caseId,
        trackId: row.trackId,
        trackRole: row.trackRole,
        windowStartMs: row.windowStartMs,
        windowEndMs: row.windowEndMs,
        referenceMs: row.referenceMs,
        source: row.source,
        infoScore: row.infoScore,
        disagreement: row.disagreement,
        v6GateFired: row.v6GateFired,
        categories: row.categories,
        v5: { label: row.v5Label, confidence: row.v5Confidence },
        v6: { label: row.v6Label, confidence: row.v6Confidence },
        annotationAsk:
          "Human: identify the striking arm, whether a real stroke occurs in the window, its L1/L2, and whether the torso is fully visible at the reference frame.",
      })),
  };
  writeFileSync(
    join(queueDir, "g13-h6-annotation-queue.json"),
    `${JSON.stringify(queue, null, 2)}\n`,
  );

  console.log(`${G13_MINING_VERSION}: ${rows.length} units`);
  console.log(`disagreements: ${JSON.stringify(report.disagreementCounts)}`);
  console.log(`v6 gate fires: ${JSON.stringify(report.v6GateFires)}`);
  console.log(`categories: ${JSON.stringify(categoryCounts)}`);
  console.log(`top 15 by infoScore:`);
  for (const row of rows.slice(0, 15)) {
    console.log(
      `  ${row.infoScore.toFixed(2)} ${row.unitId} [${row.trackRole}] v5=${row.v5Label} v6=${row.v6Label} ` +
        `${row.disagreement}${row.v6GateFired ? ` gate=${row.v6GateFired}` : ""} cats=[${row.categories.join(",")}]`,
    );
  }
}
