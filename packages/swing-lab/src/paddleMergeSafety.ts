import {
  MERGE_LINK_GATES,
  TRACKER_GATES,
  trackletLinkGate,
  trackletTail,
  wristSeries,
  type PaddleTrackCandidate,
  type TrackedPaddleObservation,
} from "./paddleTracker.js";

/**
 * MERGE-CANDIDATE SAFETY CLASSIFIER (merge-safety-v1).
 *
 * Fragment merge is DISABLED in production (D-042, re-verified): on dev it
 * degraded rally2 contact 30→145ms (merged fragments alter the paddle-speed
 * series feeding contact fusion) and on rally1 it produced a target-gated
 * "confirmed" 695ms contact matching no gold label. This module does NOT
 * re-enable merge. It builds the safety case the promotion gate requires:
 * for every candidate fragment pair (the exact geometric link gate
 * reconciliation uses), it judges — with per-check provenance — whether the
 * pair could ever be merged without risking identity or evidence corruption.
 *
 * Checks (each PASS / FAIL / UNKNOWN, never guessed):
 *  - segment-level ownership agreement: A's tail segment and B's head
 *    segment must BOTH be decisively target-owned (segment-level, not
 *    track-level — a mixed track's mean hides the handover).
 *  - target compatibility: both fragments' judged wrist evidence must be
 *    within the tracker's own selection gates (hand affinity + mean wrist
 *    distance) so a merge cannot smuggle a never-selectable fragment into a
 *    selectable one.
 *  - event locality: a bridged gap that overlaps the event-peak
 *    neighborhood would fabricate paddle-speed samples exactly where
 *    contact fusion reads them (the rally2 145ms mechanism) — FAIL.
 *  - motion continuity: forward AND backward constant-velocity corridors
 *    must agree across the gap (the reconciliation gate is forward-only).
 *  - non-target contradiction: any sustained other-owned run inside either
 *    fragment is disqualifying (the rally1 695ms mechanism: a merged
 *    other-player fragment feeding target-gated contact evidence).
 *
 * Verdict: any FAIL → MERGE_UNSAFE; all five PASS → MERGE_SAFE; otherwise
 * UNKNOWN. UNKNOWN blocks merge exactly like MERGE_UNSAFE — safety must be
 * PROVEN, and missing evidence (e.g. no pose on this platform) can only
 * yield UNKNOWN, never MERGE_SAFE.
 *
 * PROMOTION REMAINS BLOCKED: this classifier is a necessary precondition,
 * not a sufficient one. Flipping --merge-tracklets additionally requires
 * downstream cascade non-regression measured via `pnpm lab:cascade` against
 * canonical runs, which exist only on macOS (Apple Vision pose).
 */

export const MERGE_SAFETY_VERSION = "merge-safety-v1";

export type MergeSafetyVerdict = "MERGE_SAFE" | "MERGE_UNSAFE" | "UNKNOWN";
export type MergeCheckStatus = "PASS" | "FAIL" | "UNKNOWN";

/** Provenance of one frame-time on the bridged A→gap→B span. */
export type BridgedFrameProvenance = "OBSERVED" | "TRACKED" | "PREDICTED";

export interface MergeSafetyCheck {
  status: MergeCheckStatus;
  detail: string;
}

export interface BridgedFrame {
  timestampMs: number;
  provenance: BridgedFrameProvenance;
}

export interface MergeCandidateSafetyReport {
  version: typeof MERGE_SAFETY_VERSION;
  fromTrackId: number;
  toTrackId: number;
  gapMs: number;
  checks: {
    ownershipAgreement: MergeSafetyCheck;
    targetCompatibility: MergeSafetyCheck;
    eventLocality: MergeSafetyCheck;
    motionContinuity: MergeSafetyCheck;
    nonTargetContradiction: MergeSafetyCheck;
  };
  /** Every frame-time the merged track would span, with provenance. Gap
   *  frames are PREDICTED (constant-velocity, never observed) unless a
   *  target wrist is measured near the predicted position (TRACKED). */
  bridgedFrames: BridgedFrame[];
  verdict: MergeSafetyVerdict;
}

export interface MergeSafetyContext {
  /** Target player's wrists per timestamp (may be empty → UNKNOWN checks). */
  wrists: ReturnType<typeof wristSeries>;
  /** Other players' wrists per timestamp (may be empty → UNKNOWN checks). */
  otherWrists: ReturnType<typeof wristSeries>;
  window: { startMs: number; endMs: number };
  /** Event motion peak; null when no event evidence exists → UNKNOWN. */
  eventPeakMs: number | null;
  /** Nominal frame interval for bridged-frame enumeration. */
  frameIntervalMs: number;
}

export const MERGE_SAFETY_GATES = {
  /** Head/tail segment judged over this many observations at the joint. */
  jointSegmentObservations: 5,
  /** A bridged gap overlapping eventPeak ± this fabricates contact-window
   *  paddle speed (rally2 mechanism). */
  eventPeakExclusionMs: 300,
  /** Forward and backward corridor predictions must both land within this
   *  fraction of the reconciliation radius. */
  continuityRadiusFraction: 0.6,
  /** Velocity agreement: cosine of tail/head velocity angles. */
  minVelocityCosine: 0.0,
  /** Speeds below this (normalized units/s) are direction-noise; the cosine
   *  test is skipped for near-stationary joints. */
  directionSpeedFloor: 0.2,
  /** A bridged frame is TRACKED when a measured target wrist lies within
   *  the hand-affinity radius of the predicted position. */
  trackedWristRadius: TRACKER_GATES.handAffinityRadius,
} as const;

interface WristDistances {
  targetDistance: number | null;
  otherDistance: number | null;
}

function observationWristDistances(
  observation: TrackedPaddleObservation,
  wrists: ReturnType<typeof wristSeries>,
  otherWrists: ReturnType<typeof wristSeries>,
): WristDistances {
  const nearest = nearestWristSample(wrists, observation.timestampMs);
  const nearestOther = nearestWristSample(otherWrists, observation.timestampMs);
  return {
    targetDistance: nearest
      ? Math.min(
          ...nearest.map((wrist) =>
            Math.hypot(wrist.x - observation.center.x, wrist.y - observation.center.y),
          ),
        )
      : null,
    otherDistance: nearestOther
      ? Math.min(
          ...nearestOther.map((wrist) =>
            Math.hypot(wrist.x - observation.center.x, wrist.y - observation.center.y),
          ),
        )
      : null,
  };
}

function nearestWristSample(
  wrists: ReturnType<typeof wristSeries>,
  timestampMs: number,
): Array<{ x: number; y: number }> | null {
  let best: (typeof wrists)[number] | null = null;
  let bestDelta = Infinity;
  for (const entry of wrists) {
    const delta = Math.abs(entry.timestampMs - timestampMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = entry;
    }
  }
  return best && bestDelta <= 60 && best.wrists.length > 0 ? best.wrists : null;
}

/** Segment-level ownership verdict over a slice of observations, mirroring
 *  the tracker's decisive-ownership test (otherOwnershipFactor both ways). */
function segmentOwnership(
  observations: readonly TrackedPaddleObservation[],
  context: MergeSafetyContext,
): { verdict: "TARGET" | "OTHER" | "NEUTRAL" | "UNKNOWN"; detail: string } {
  const targetDistances: number[] = [];
  const otherDistances: number[] = [];
  for (const observation of observations) {
    const { targetDistance, otherDistance } = observationWristDistances(
      observation,
      context.wrists,
      context.otherWrists,
    );
    if (targetDistance !== null) targetDistances.push(targetDistance);
    if (otherDistance !== null) otherDistances.push(otherDistance);
  }
  if (targetDistances.length === 0 || otherDistances.length === 0) {
    return {
      verdict: "UNKNOWN",
      detail: `no wrist evidence (target samples ${targetDistances.length}, other samples ${otherDistances.length})`,
    };
  }
  const meanTarget = mean(targetDistances);
  const meanOther = mean(otherDistances);
  if (meanOther < meanTarget * TRACKER_GATES.otherOwnershipFactor) {
    return {
      verdict: "OTHER",
      detail: `other wrist decisively closer (${meanOther.toFixed(3)} vs target ${meanTarget.toFixed(3)})`,
    };
  }
  if (meanTarget < meanOther * TRACKER_GATES.otherOwnershipFactor) {
    return {
      verdict: "TARGET",
      detail: `target wrist decisively closer (${meanTarget.toFixed(3)} vs other ${meanOther.toFixed(3)})`,
    };
  }
  return {
    verdict: "NEUTRAL",
    detail: `no decisive owner (target ${meanTarget.toFixed(3)}, other ${meanOther.toFixed(3)})`,
  };
}

/** Fragment-level wrist evidence against the tracker's own selection gates. */
function fragmentTargetCompatibility(
  candidate: PaddleTrackCandidate,
  context: MergeSafetyContext,
): { status: MergeCheckStatus; detail: string } {
  const inWindow = candidate.observations.filter(
    (observation) =>
      observation.timestampMs >= context.window.startMs &&
      observation.timestampMs <= context.window.endMs,
  );
  const judged = inWindow.length > 0 ? inWindow : candidate.observations;
  const targetDistances: number[] = [];
  for (const observation of judged) {
    const { targetDistance } = observationWristDistances(
      observation,
      context.wrists,
      context.otherWrists,
    );
    if (targetDistance !== null) targetDistances.push(targetDistance);
  }
  if (targetDistances.length === 0) {
    return { status: "UNKNOWN", detail: `track ${candidate.trackId}: no target-wrist samples` };
  }
  const meanDistance = mean(targetDistances);
  const handHits = targetDistances.filter(
    (distance) => distance <= TRACKER_GATES.handAffinityRadius,
  ).length;
  const affinity = handHits / targetDistances.length;
  if (
    meanDistance <= TRACKER_GATES.maxMeanWristDistance &&
    affinity >= TRACKER_GATES.minHandAffinity
  ) {
    return {
      status: "PASS",
      detail: `track ${candidate.trackId}: meanWristDistance ${meanDistance.toFixed(3)}, handAffinity ${affinity.toFixed(2)}`,
    };
  }
  return {
    status: "FAIL",
    detail: `track ${candidate.trackId}: meanWristDistance ${meanDistance.toFixed(3)} (max ${TRACKER_GATES.maxMeanWristDistance}), handAffinity ${affinity.toFixed(2)} (min ${TRACKER_GATES.minHandAffinity})`,
  };
}

/** Sustained other-owned run detection inside one fragment (the tracker's
 *  flip-run rule: >= sustainedFlipRunLength consecutive other-owned). */
function sustainedOtherRun(
  observations: readonly TrackedPaddleObservation[],
  context: MergeSafetyContext,
): { found: boolean; anyWristData: boolean; atMs: number | null } {
  let run = 0;
  let anyWristData = false;
  for (const observation of observations) {
    const { targetDistance, otherDistance } = observationWristDistances(
      observation,
      context.wrists,
      context.otherWrists,
    );
    if (targetDistance !== null && otherDistance !== null) anyWristData = true;
    const otherOwned =
      targetDistance !== null &&
      otherDistance !== null &&
      otherDistance < targetDistance * TRACKER_GATES.otherFlipFactor;
    run = otherOwned ? run + 1 : 0;
    if (run >= TRACKER_GATES.sustainedFlipRunLength) {
      return { found: true, anyWristData, atMs: observation.timestampMs };
    }
  }
  return { found: false, anyWristData, atMs: null };
}

function combineStatuses(a: MergeCheckStatus, b: MergeCheckStatus): MergeCheckStatus {
  if (a === "FAIL" || b === "FAIL") return "FAIL";
  if (a === "UNKNOWN" || b === "UNKNOWN") return "UNKNOWN";
  return "PASS";
}

/** Bridged-frame enumeration with provenance. Fragment frames are OBSERVED;
 *  gap frames are PREDICTED unless a measured target wrist lies within the
 *  hand radius of the constant-velocity position (TRACKED). Estimates are
 *  never observations. */
function enumerateBridgedFrames(
  a: PaddleTrackCandidate,
  b: PaddleTrackCandidate,
  context: MergeSafetyContext,
): BridgedFrame[] {
  const frames: BridgedFrame[] = [];
  for (const observation of a.observations) {
    frames.push({ timestampMs: observation.timestampMs, provenance: "OBSERVED" });
  }
  const { last, velocity } = trackletTail(a);
  const first = b.observations[0]!;
  const interval = Math.max(1, context.frameIntervalMs);
  for (
    let tMs = last.timestampMs + interval;
    tMs < first.timestampMs - interval / 2;
    tMs += interval
  ) {
    const dtSec = (tMs - last.timestampMs) / 1000;
    const predicted = {
      x: last.center.x + velocity.x * dtSec,
      y: last.center.y + velocity.y * dtSec,
    };
    const wrists = nearestWristSample(context.wrists, tMs);
    const wristSupported =
      wrists !== null &&
      wrists.some(
        (wrist) =>
          Math.hypot(wrist.x - predicted.x, wrist.y - predicted.y) <=
          MERGE_SAFETY_GATES.trackedWristRadius,
      );
    frames.push({ timestampMs: tMs, provenance: wristSupported ? "TRACKED" : "PREDICTED" });
  }
  for (const observation of b.observations) {
    frames.push({ timestampMs: observation.timestampMs, provenance: "OBSERVED" });
  }
  return frames;
}

/**
 * Classify one candidate fragment pair A→B (A strictly precedes B). The
 * caller is responsible for pairing only geometrically linkable fragments
 * (see enumerateMergeCandidatePairs); this function judges SAFETY, and its
 * UNKNOWN is a first-class outcome: absent evidence never upgrades a pair.
 */
export function classifyMergeCandidate(
  a: PaddleTrackCandidate,
  b: PaddleTrackCandidate,
  context: MergeSafetyContext,
): MergeCandidateSafetyReport {
  const { last } = trackletTail(a);
  const first = b.observations[0]!;
  const gapMs = first.timestampMs - last.timestampMs;

  // 1. Segment-level ownership agreement at the joint.
  const tailSlice = a.observations.slice(-MERGE_SAFETY_GATES.jointSegmentObservations);
  const headSlice = b.observations.slice(0, MERGE_SAFETY_GATES.jointSegmentObservations);
  const tailOwnership = segmentOwnership(tailSlice, context);
  const headOwnership = segmentOwnership(headSlice, context);
  let ownershipAgreement: MergeSafetyCheck;
  if (tailOwnership.verdict === "OTHER" || headOwnership.verdict === "OTHER") {
    ownershipAgreement = {
      status: "FAIL",
      detail: `joint segment other-owned — tail: ${tailOwnership.detail}; head: ${headOwnership.detail}`,
    };
  } else if (tailOwnership.verdict === "TARGET" && headOwnership.verdict === "TARGET") {
    ownershipAgreement = {
      status: "PASS",
      detail: `both joint segments decisively target-owned — tail: ${tailOwnership.detail}; head: ${headOwnership.detail}`,
    };
  } else {
    ownershipAgreement = {
      status: "UNKNOWN",
      detail: `ownership not decisively established — tail: ${tailOwnership.detail}; head: ${headOwnership.detail}`,
    };
  }

  // 2. Target compatibility of each whole fragment.
  const compatibilityA = fragmentTargetCompatibility(a, context);
  const compatibilityB = fragmentTargetCompatibility(b, context);
  const targetCompatibility: MergeSafetyCheck = {
    status: combineStatuses(compatibilityA.status, compatibilityB.status),
    detail: `${compatibilityA.detail}; ${compatibilityB.detail}`,
  };

  // 3. Event locality: the bridged gap must not overlap the event-peak
  //    neighborhood where contact fusion reads paddle speed.
  let eventLocality: MergeSafetyCheck;
  if (context.eventPeakMs === null) {
    eventLocality = {
      status: "UNKNOWN",
      detail: "no event peak available to test gap locality against",
    };
  } else {
    const exclusionStart = context.eventPeakMs - MERGE_SAFETY_GATES.eventPeakExclusionMs;
    const exclusionEnd = context.eventPeakMs + MERGE_SAFETY_GATES.eventPeakExclusionMs;
    const overlaps = last.timestampMs <= exclusionEnd && first.timestampMs >= exclusionStart;
    eventLocality = overlaps
      ? {
          status: "FAIL",
          detail: `gap ${Math.round(last.timestampMs)}–${Math.round(first.timestampMs)}ms overlaps event peak ${Math.round(context.eventPeakMs)}±${MERGE_SAFETY_GATES.eventPeakExclusionMs}ms — a merge here fabricates paddle speed inside the contact window`,
        }
      : {
          status: "PASS",
          detail: `gap ${Math.round(last.timestampMs)}–${Math.round(first.timestampMs)}ms clear of event peak ${Math.round(context.eventPeakMs)}±${MERGE_SAFETY_GATES.eventPeakExclusionMs}ms`,
        };
  }

  // 4. Motion continuity: forward AND backward corridors, tighter than the
  //    reconciliation gate, plus velocity-direction agreement.
  const motionContinuity = judgeMotionContinuity(a, b, gapMs);

  // 5. Non-target contradiction: sustained other-owned run anywhere inside
  //    either fragment.
  const runA = sustainedOtherRun(a.observations, context);
  const runB = sustainedOtherRun(b.observations, context);
  let nonTargetContradiction: MergeSafetyCheck;
  if (runA.found || runB.found) {
    nonTargetContradiction = {
      status: "FAIL",
      detail: `sustained other-owned run at ${Math.round((runA.atMs ?? runB.atMs)!)}ms — merging would carry another player's paddle into target evidence`,
    };
  } else if (!runA.anyWristData && !runB.anyWristData) {
    nonTargetContradiction = {
      status: "UNKNOWN",
      detail: "no paired wrist evidence in either fragment to test for contradiction",
    };
  } else {
    nonTargetContradiction = {
      status: "PASS",
      detail: "no sustained other-owned run in either fragment",
    };
  }

  const checks = {
    ownershipAgreement,
    targetCompatibility,
    eventLocality,
    motionContinuity,
    nonTargetContradiction,
  };
  const statuses = Object.values(checks).map((check) => check.status);
  const verdict: MergeSafetyVerdict = statuses.includes("FAIL")
    ? "MERGE_UNSAFE"
    : statuses.every((status) => status === "PASS")
      ? "MERGE_SAFE"
      : "UNKNOWN";

  return {
    version: MERGE_SAFETY_VERSION,
    fromTrackId: a.trackId,
    toTrackId: b.trackId,
    gapMs,
    checks,
    bridgedFrames: enumerateBridgedFrames(a, b, context),
    verdict,
  };
}

function judgeMotionContinuity(
  a: PaddleTrackCandidate,
  b: PaddleTrackCandidate,
  gapMs: number,
): MergeSafetyCheck {
  const { last, velocity: tailVelocity } = trackletTail(a);
  const first = b.observations[0]!;
  const headAnchor = b.observations[Math.min(b.observations.length - 1, 2)]!;
  const headDtSec = Math.max(0.001, (headAnchor.timestampMs - first.timestampMs) / 1000);
  const headVelocity = {
    x: (headAnchor.center.x - first.center.x) / headDtSec,
    y: (headAnchor.center.y - first.center.y) / headDtSec,
  };
  const gapSec = gapMs / 1000;
  const radius =
    (MERGE_LINK_GATES.baseRadius + MERGE_LINK_GATES.radiusPerSec * gapSec) *
    MERGE_SAFETY_GATES.continuityRadiusFraction;
  const forwardMiss = Math.hypot(
    first.center.x - (last.center.x + tailVelocity.x * gapSec),
    first.center.y - (last.center.y + tailVelocity.y * gapSec),
  );
  const backwardMiss = Math.hypot(
    last.center.x - (first.center.x - headVelocity.x * gapSec),
    last.center.y - (first.center.y - headVelocity.y * gapSec),
  );
  const tailSpeed = Math.hypot(tailVelocity.x, tailVelocity.y);
  const headSpeed = Math.hypot(headVelocity.x, headVelocity.y);
  const bothMoving =
    tailSpeed >= MERGE_SAFETY_GATES.directionSpeedFloor &&
    headSpeed >= MERGE_SAFETY_GATES.directionSpeedFloor;
  const cosine = bothMoving
    ? (tailVelocity.x * headVelocity.x + tailVelocity.y * headVelocity.y) / (tailSpeed * headSpeed)
    : null;
  const corridorOk = forwardMiss <= radius && backwardMiss <= radius;
  const directionOk = cosine === null || cosine >= MERGE_SAFETY_GATES.minVelocityCosine;
  if (corridorOk && directionOk) {
    return {
      status: "PASS",
      detail: `forward miss ${forwardMiss.toFixed(3)}, backward miss ${backwardMiss.toFixed(3)} within ${radius.toFixed(3)}${cosine !== null ? `, velocity cosine ${cosine.toFixed(2)}` : ", joint near-stationary"}`,
    };
  }
  return {
    status: "FAIL",
    detail: `forward miss ${forwardMiss.toFixed(3)}, backward miss ${backwardMiss.toFixed(3)} vs radius ${radius.toFixed(3)}${cosine !== null ? `, velocity cosine ${cosine.toFixed(2)}` : ""}`,
  };
}

export interface MergeCandidatePair {
  a: PaddleTrackCandidate;
  b: PaddleTrackCandidate;
  gapMs: number;
}

/** Candidate pairs = exactly the pairs the reconciliation link gate would
 *  consider linkable (temporal order, corridor, scale). */
export function enumerateMergeCandidatePairs(
  candidates: readonly PaddleTrackCandidate[],
): MergeCandidatePair[] {
  const sorted = [...candidates].sort(
    (a, b) => a.observations[0]!.timestampMs - b.observations[0]!.timestampMs,
  );
  const pairs: MergeCandidatePair[] = [];
  for (const a of sorted) {
    for (const b of sorted) {
      if (a === b) continue;
      const gate = trackletLinkGate(a, b);
      if (gate.linkable) pairs.push({ a, b, gapMs: gate.gapMs });
    }
  }
  return pairs;
}

export interface MergeSafetySweepResult {
  version: typeof MERGE_SAFETY_VERSION;
  candidatePairs: number;
  counts: Record<MergeSafetyVerdict, number>;
  reports: MergeCandidateSafetyReport[];
}

/** Classify every candidate pair among the given tracklets. */
export function sweepMergeCandidates(
  candidates: readonly PaddleTrackCandidate[],
  context: MergeSafetyContext,
): MergeSafetySweepResult {
  const pairs = enumerateMergeCandidatePairs(candidates);
  const reports = pairs.map((pair) => classifyMergeCandidate(pair.a, pair.b, context));
  const counts: Record<MergeSafetyVerdict, number> = {
    MERGE_SAFE: 0,
    MERGE_UNSAFE: 0,
    UNKNOWN: 0,
  };
  for (const report of reports) counts[report.verdict] += 1;
  return { version: MERGE_SAFETY_VERSION, candidatePairs: pairs.length, counts, reports };
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}
