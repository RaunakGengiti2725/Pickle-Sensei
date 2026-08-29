import type { PaddleObservation, PaddleTrack, PoseSequence } from "@pickle/swing-domain";
import { toLegacyPoseFrames } from "@pickle/swing-domain";

/**
 * Paddle tracking over raw detector candidates.
 *
 * Association is ByteTrack-style two-stage greedy matching with a constant-
 * velocity position prediction: high-score detections may START tracks;
 * low-score detections may only EXTEND existing tracks. Misses are never
 * interpolated — a frame with no matched detection has no observation.
 *
 * Selection is pose-GATED, not pose-generated: among candidate tracks the
 * one that is temporally consistent and lives near either wrist wins. The
 * wrist coordinate itself never becomes a paddle observation; if no track
 * survives the gates, the result is honestly null with a reason.
 *
 * Mixed-identity tracks are FLIP-SEGMENTED (wave-B W1): sustained flips of
 * wrist affinity to another player split the track, each segment is judged
 * fresh, only decisively TARGET-owned segments of a mixed track survive,
 * and all score terms are recomputed from the observations actually kept.
 *
 * Every observation carries a HEURISTIC confidence (detector score ×
 * continuity × wrist proximity). It is labeled heuristic because it has not
 * been calibrated against ground truth yet.
 */

export const PADDLE_TRACKER_VERSION = "paddle-track-2";

/** ownership-guard-v1 (wave-D3 red team, OFF by default): tightens the
 *  ownership verdict in three measured wrong-owner families —
 *  (A) NEAR-OWNERSHIP DEAD ZONE: the other player's wrist is strictly
 *      closer to the winning track than the target's, but not decisively
 *      (otherOwnershipFactor..1.0). The un-guarded selector confidently
 *      claims the track for the target; the guard abstains as ambiguous.
 *  (B) EVIDENCE-GAP HANDOFF: a paddle handoff into a stretch where the
 *      receiving player's wrists are unmeasured (occlusion/pose dropout)
 *      cannot flip-segment — flips need other-wrist data. The guard drops
 *      sustained no-other-evidence runs whose observations are not in the
 *      target's hand (> handAffinityRadius) instead of claiming them.
 *  (C) UNVERIFIED OWNERSHIP: a multi-player scene where the winning track
 *      has (almost) no other-wrist measurements at all — ownership was
 *      never actually tested. The verdict stands but carries a risk flag.
 */
export interface PaddleSelectionOptions {
  ownershipGuard?: boolean;
}
export const OWNERSHIP_GUARD_VERSION = "ownership-guard-v1";
export const OWNERSHIP_GUARD_GATES = {
  /** (B) minimum run length of no-other-evidence observations to drop
   *  (mirrors TRACKER_GATES.sustainedFlipRunLength). */
  minEvidenceGapRun: 3,
  /** (C) other-evidence coverage below this is "unverified". */
  minOtherEvidenceCoverage: 0.35,
} as const;

/** Provenance of a paddle detection/observation. Crop-sourced detections
 *  (wrist-conditioned re-detect, crop-recovery-v1) may only EXTEND existing
 *  tracks — never start them — so they never enter selection as raw
 *  candidates. TRACKED_ESTIMATE marks bridge interpolations that must never
 *  be presented as detections. Absent means full_frame. */
export type PaddleDetectionSource = "full_frame" | "crop" | "tracked_estimate";
export const PADDLE_CONFIDENCE_MODEL = "heuristic-v1 (uncalibrated)";

export interface RawPaddleDetectionFile {
  schemaVersion: 1;
  detector: {
    modelId: string;
    version: string;
    license: string;
    device: string;
    proxyLabels: string[];
    proxyNote: string;
    scoreFloor: number;
  };
  video: { path: string; width: number; height: number; fps: number; durationMs: number };
  window: { startMs: number; endMs: number };
  timing: {
    modelLoadSec: number;
    framesProcessed: number;
    inferenceSecTotal: number;
    inferenceMsPerFrame: number;
    wallSecTotal: number;
  };
  frames: Array<{
    tMs: number;
    detections: Array<{
      box: [number, number, number, number];
      score: number;
      label: string;
      source?: PaddleDetectionSource;
    }>;
    extras: Array<{ box: [number, number, number, number]; score: number; label: string }>;
  }>;
}

export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrackedPaddleObservation {
  timestampMs: number;
  box: NormalizedBox;
  center: { x: number; y: number };
  detectorScore: number;
  trackId: number;
  /** heuristic-v1 (uncalibrated) — see PADDLE_CONFIDENCE_MODEL. */
  confidence: number;
  nearWrist: boolean;
  /** Detection provenance; absent means full_frame. */
  source?: PaddleDetectionSource;
}

export interface PaddleTrackCandidate {
  trackId: number;
  observations: TrackedPaddleObservation[];
  meanScore: number;
  windowCoverage: number;
  meanWristDistance: number | null;
}

export interface PaddleAssociationDecision {
  /** Mean distance of chosen track to TARGET wrists vs OTHER players'. */
  meanTargetWristDistance: number | null;
  meanOtherWristDistance: number | null;
  /** Tracks rejected because they belong to another player's hand. */
  rejectedOtherPlayerTracks: number;
  /** Selection-score margin of winner over runner-up (heuristic). */
  selectionMargin: number | null;
  /** Sustained identity flips: segments removed because another player's
   *  wrist owned them (one event per dropped segment, at its start). */
  switchEvents: Array<{ atMs: number; kind: "PADDLE_ASSOCIATION_SWITCH" }>;
  risks: string[];
}

export type PaddleTrackingOutcome =
  | {
      status: "tracked";
      track: PaddleTrack;
      lab: PaddleTrackCandidate;
      allTracks: PaddleTrackCandidate[];
      association: PaddleAssociationDecision;
    }
  | {
      status: "untracked";
      reason: string;
      allTracks: PaddleTrackCandidate[];
      association: PaddleAssociationDecision | null;
    };

export const TRACKER_GATES = {
  /** Detections at/above this may start a new track. */
  startScore: 0.35,
  /** Detections at/above this may extend an existing track. */
  extendScore: 0.15,
  /** A track dies after this long without a matched detection. */
  maxGapMs: 250,
  /** Minimum matched detections for a track to be considered at all. */
  minObservations: 5,
  /** Association gate: predicted-center distance (normalized units). */
  matchRadius: 0.07,
  /** A paddle observation this close to a target wrist counts as "in hand". */
  handAffinityRadius: 0.13,
  /** Fraction of judged observations that must be in-hand to be the target's. */
  minHandAffinity: 0.4,
  /** Primary-track requirements. */
  minWindowCoverage: 0.25,
  maxMeanWristDistance: 0.22,
  /** Wrist proximity radius for the nearWrist flag. */
  nearWristRadius: 0.12,
  /** Plausible paddle box area (normalized) — rejects buildings/people. */
  minBoxArea: 0.00005,
  maxBoxArea: 0.03,
  /** An observation is other-owned when another player's wrist is closer
   *  than this fraction of the target-wrist distance. */
  otherFlipFactor: 0.7,
  /** Consecutive other-owned observations that make a flip SUSTAINED
   *  (segment boundary; shorter runs are treated as transient proximity). */
  sustainedFlipRunLength: 3,
  /** Decisive other-player ownership: mean other-wrist distance below this
   *  fraction of the mean target-wrist distance (track AND segment level). */
  otherOwnershipFactor: 0.85,
} as const;

interface ActiveTrack {
  trackId: number;
  observations: TrackedPaddleObservation[];
  lastMs: number;
  velocity: { x: number; y: number };
}

export function buildPaddleTracks(
  file: RawPaddleDetectionFile,
  window: { startMs: number; endMs: number },
): PaddleTrackCandidate[] {
  const { width, height } = file.video;
  const tracks: ActiveTrack[] = [];
  const finished: ActiveTrack[] = [];
  let nextId = 1;

  for (const frame of file.frames) {
    // Retire stale tracks first.
    for (let index = tracks.length - 1; index >= 0; index -= 1) {
      if (frame.tMs - tracks[index]!.lastMs > TRACKER_GATES.maxGapMs) {
        finished.push(tracks.splice(index, 1)[0]!);
      }
    }
    const candidates = frame.detections
      .map((detection) => ({
        score: detection.score,
        box: normalizeBox(detection.box, width, height),
        source: detection.source,
      }))
      .filter(
        (candidate) =>
          candidate.box.width * candidate.box.height >= TRACKER_GATES.minBoxArea &&
          candidate.box.width * candidate.box.height <= TRACKER_GATES.maxBoxArea,
      )
      .sort((a, b) => b.score - a.score);

    const usedTracks = new Set<number>();
    const unmatched: typeof candidates = [];

    // Stage 1 + 2 in score order: each detection matches the nearest
    // predicted track center within the gate; high-score leftovers seed new
    // tracks, low-score leftovers are dropped.
    for (const candidate of candidates) {
      const center = boxCenter(candidate.box);
      let best: ActiveTrack | null = null;
      let bestDistance = Infinity;
      for (const track of tracks) {
        if (usedTracks.has(track.trackId)) continue;
        const predicted = predictCenter(track, frame.tMs);
        const distance = Math.hypot(predicted.x - center.x, predicted.y - center.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = track;
        }
      }
      if (best && bestDistance <= TRACKER_GATES.matchRadius) {
        appendObservation(best, frame.tMs, candidate.box, candidate.score, candidate.source);
        usedTracks.add(best.trackId);
      } else {
        unmatched.push(candidate);
      }
    }
    for (const candidate of unmatched) {
      // Crop-sourced detections may only EXTEND tracks (matched above):
      // an unmatched crop box never seeds a track, so it can never reach
      // selection as a raw candidate no matter its score.
      if (candidate.source === "crop") continue;
      if (candidate.score < TRACKER_GATES.startScore) continue;
      const track: ActiveTrack = {
        trackId: nextId++,
        observations: [],
        lastMs: frame.tMs,
        velocity: { x: 0, y: 0 },
      };
      appendObservation(track, frame.tMs, candidate.box, candidate.score, candidate.source);
      tracks.push(track);
    }
  }
  finished.push(...tracks);

  const windowLength = Math.max(1, window.endMs - window.startMs);
  return finished
    .filter((track) => track.observations.length >= TRACKER_GATES.minObservations)
    .map((track) => {
      const inWindow = track.observations.filter(
        (observation) =>
          observation.timestampMs >= window.startMs && observation.timestampMs <= window.endMs,
      );
      const coverage =
        inWindow.length >= 2
          ? (inWindow[inWindow.length - 1]!.timestampMs - inWindow[0]!.timestampMs) / windowLength
          : 0;
      return {
        trackId: track.observations[0]!.trackId,
        observations: track.observations,
        meanScore: mean(track.observations.map((observation) => observation.detectorScore)),
        windowCoverage: Math.min(1, coverage),
        meanWristDistance: null,
      };
    })
    .sort((a, b) => b.windowCoverage * b.meanScore - a.windowCoverage * a.meanScore);
}

/**
 * Wrist positions per timestamp from the pose sequence (both wrists — the
 * gate is handedness-agnostic; selection never fabricates a paddle from
 * these points).
 */
export function wristSeries(
  sequence: PoseSequence,
): Array<{ timestampMs: number; wrists: Array<{ x: number; y: number }> }> {
  return toLegacyPoseFrames(sequence).map((frame) => ({
    timestampMs: frame.timestampMs,
    wrists: frame.landmarks
      .filter((mark) => mark.name.endsWith("wrist") && mark.visibility >= 0.2)
      .map((mark) => ({ x: mark.x, y: mark.y })),
  }));
}

/**
 * TRACKLET RECONCILIATION — merge short paddle tracklets that are physically
 * the SAME paddle before ownership/selection ever runs.
 *
 * Why (measured, paddle waterfall 2026-08-28): the detector finds the paddle
 * in 27/27 labeled frames, but its detections are split across many short
 * tracklets (afn-vic-rally1: 27 tracklets, seven of which each touch the true
 * paddle, none covering it all). Oracle study: perfect SELECTION alone tops
 * out at R 0.59, while perfect MERGING reaches R 0.96. So the recoverable
 * quality lives in merging, not in rescoring.
 *
 * A link A→B requires ALL of:
 *  - strict temporal ordering with a gap inside `maxMergeGapMs`
 *  - B's start inside a constant-velocity corridor extrapolated from A's tail
 *    (radius grows with the gap — an unobserved paddle may travel)
 *  - compatible box scale (a paddle does not double in size across a gap)
 * Merging concatenates MEASURED observations only; the gap stays a gap. No
 * position is invented, so provenance ("detected") is preserved.
 */
export function mergePaddleTracklets(
  candidates: readonly PaddleTrackCandidate[],
  window: { startMs: number; endMs: number },
): { merged: PaddleTrackCandidate[]; links: number } {
  const GATES = { maxMergeGapMs: 500, baseRadius: 0.05, radiusPerSec: 0.45, maxScaleRatio: 2.2 };
  const sorted = [...candidates].sort(
    (a, b) => a.observations[0]!.timestampMs - b.observations[0]!.timestampMs,
  );
  const tail = (candidate: PaddleTrackCandidate) => {
    const observations = candidate.observations;
    const last = observations[observations.length - 1]!;
    const previous = observations[Math.max(0, observations.length - 3)]!;
    const dtSec = Math.max(0.001, (last.timestampMs - previous.timestampMs) / 1000);
    return {
      last,
      velocity: {
        x: (last.center.x - previous.center.x) / dtSec,
        y: (last.center.y - previous.center.y) / dtSec,
      },
    };
  };

  // Best-first greedy chaining: every tracklet joins at most one successor.
  const links: Array<{ from: number; to: number; cost: number }> = [];
  for (const [indexA, a] of sorted.entries()) {
    const { last, velocity } = tail(a);
    for (const [indexB, b] of sorted.entries()) {
      if (indexA === indexB) continue;
      const first = b.observations[0]!;
      const gapMs = first.timestampMs - last.timestampMs;
      if (gapMs <= 0 || gapMs > GATES.maxMergeGapMs) continue;
      const gapSec = gapMs / 1000;
      const predicted = {
        x: last.center.x + velocity.x * gapSec,
        y: last.center.y + velocity.y * gapSec,
      };
      const miss = Math.hypot(first.center.x - predicted.x, first.center.y - predicted.y);
      const radius = GATES.baseRadius + GATES.radiusPerSec * gapSec;
      if (miss > radius) continue;
      const scaleRatio =
        Math.max(last.box.width, first.box.width) /
        Math.max(1e-6, Math.min(last.box.width, first.box.width));
      if (scaleRatio > GATES.maxScaleRatio) continue;
      links.push({ from: indexA, to: indexB, cost: miss / radius + gapSec * 0.3 });
    }
  }
  links.sort((a, b) => a.cost - b.cost);
  const successor = new Map<number, number>();
  const usedAsSuccessor = new Set<number>();
  for (const link of links) {
    if (successor.has(link.from) || usedAsSuccessor.has(link.to)) continue;
    // Prevent cycles.
    let cursor: number | undefined = link.to;
    let cyclic = false;
    while (cursor !== undefined) {
      if (cursor === link.from) {
        cyclic = true;
        break;
      }
      cursor = successor.get(cursor);
    }
    if (cyclic) continue;
    successor.set(link.from, link.to);
    usedAsSuccessor.add(link.to);
  }

  const windowLength = Math.max(1, window.endMs - window.startMs);
  const merged: PaddleTrackCandidate[] = [];
  const consumed = new Set<number>();
  let linkCount = 0;
  for (const [index, candidate] of sorted.entries()) {
    if (usedAsSuccessor.has(index) || consumed.has(index)) continue;
    const chain: PaddleTrackCandidate[] = [candidate];
    let cursor = successor.get(index);
    while (cursor !== undefined && !consumed.has(cursor)) {
      chain.push(sorted[cursor]!);
      consumed.add(cursor);
      linkCount += 1;
      cursor = successor.get(cursor);
    }
    if (chain.length === 1) {
      merged.push(candidate);
      continue;
    }
    const observations = chain
      .flatMap((entry) => entry.observations)
      .sort((a, b) => a.timestampMs - b.timestampMs);
    const inWindow = observations.filter(
      (observation) =>
        observation.timestampMs >= window.startMs && observation.timestampMs <= window.endMs,
    );
    const span =
      inWindow.length >= 2
        ? inWindow[inWindow.length - 1]!.timestampMs - inWindow[0]!.timestampMs
        : 0;
    merged.push({
      trackId: chain[0]!.trackId,
      observations,
      meanScore: mean(observations.map((observation) => observation.detectorScore)),
      windowCoverage: Math.min(1, span / windowLength),
      meanWristDistance: null,
    });
  }
  return { merged, links: linkCount };
}

export function selectPrimaryPaddleTrack(
  candidates: PaddleTrackCandidate[],
  wrists: ReturnType<typeof wristSeries>,
  window: { startMs: number; endMs: number },
  /** Wrists of NON-target players; a paddle nearer to them is not ours. */
  otherWrists: ReturnType<typeof wristSeries> = [],
  options: PaddleSelectionOptions = {},
): PaddleTrackingOutcome {
  const guard = options.ownershipGuard === true;
  const sceneHasOtherPlayers = otherWrists.some((entry) => entry.wrists.length > 0);
  if (candidates.length === 0) {
    return { status: "untracked", reason: "no_tracks_formed", allTracks: [], association: null };
  }
  const risks: string[] = [];
  const switchEvents: Array<{ atMs: number; kind: "PADDLE_ASSOCIATION_SWITCH" }> = [];
  let rejectedOtherPlayerTracks = 0;

  const windowLength = Math.max(1, window.endMs - window.startMs);
  const scored = candidates.map((candidate) => {
    // Identity persistence via FLIP-SEGMENTATION (wave-B W1): a sustained
    // wrist-affinity flip to another player SPLITS the track instead of
    // truncating it. Every segment gets a FRESH ownership verdict and only
    // the decisively TARGET-owned segments of a mixed track survive —
    // measured root cause (B-selection-forensics): truncation-by-deletion
    // cut the rally1 winner at its first flip (94→12 obs) and deleted a
    // decisively target-owned tail holding all 13 gold labels.
    let keptSegments = [candidate.observations];
    if (otherWrists.length > 0) {
      const segments = segmentTrackByWristOwnership(
        candidate.observations,
        wrists,
        otherWrists,
        window,
      );
      const mixedIdentity = segments.some((segment) => segment.sustainedFlipRun);
      const targetOwned = segments.filter((segment) => segment.ownedByTarget);
      if (mixedIdentity && targetOwned.length > 0) {
        // A PROVEN flip means the track carried more than one identity, so
        // only segments POSITIVELY owned by the target survive. Neutral
        // segments border flip runs by construction (segments alternate) —
        // they are handover ramps, not target evidence, and keeping them
        // was measured to smuggle other-player tracks past the ownership
        // gate on span coverage alone (wm-dink-01 T7: 161→67 neutral obs,
        // coverage 0.961, forced an ambiguity abstain).
        for (const dropped of segments.filter((segment) => segment.sustainedFlipRun)) {
          switchEvents.push({ atMs: dropped.startMs, kind: "PADDLE_ASSOCIATION_SWITCH" });
        }
        keptSegments = targetOwned.map((segment) => segment.observations);
      }
      // No flip run → single identity: judged whole, exactly as before.
      // Mixed but NOTHING decisively target-owned → keep the full list and
      // let the track-level ownership test below decide (a wholly-other
      // track is rejected with the same accounting as before).
    }
    let evidenceGapDropped = 0;
    if (guard && sceneHasOtherPlayers) {
      // (B) EVIDENCE-GAP HANDOFF: flip-segmentation is blind wherever the
      // other player's wrists are unmeasured. Sustained runs with no
      // other-wrist evidence whose observations are NOT in the target's
      // hand are unverifiable — drop them rather than claim them.
      const guarded: TrackedPaddleObservation[][] = [];
      for (const segment of keptSegments) {
        const { kept, dropped } = dropUnverifiableRuns(segment, wrists, otherWrists);
        evidenceGapDropped += dropped.length;
        for (const run of dropped) {
          switchEvents.push({ atMs: run[0]!.timestampMs, kind: "PADDLE_ASSOCIATION_SWITCH" });
        }
        guarded.push(...kept);
      }
      keptSegments = guarded.filter((segment) => segment.length > 0);
      if (keptSegments.length === 0) keptSegments = [[]];
    }
    const observations = keptSegments.flat();
    // Wrist proximity is judged over the stroke window (falling back to the
    // whole track when the window holds no observations).
    const inWindow = observations.filter(
      (observation) =>
        observation.timestampMs >= window.startMs && observation.timestampMs <= window.endMs,
    );
    // STALENESS FIX (wave-B W1): score terms are recomputed from the
    // observations actually kept. The old code scored the PRE-truncation
    // windowCoverage/meanScore (measured: rally2's winner was cut 79→10 obs
    // yet still ranked with coverage 0.986, beating the gold-covering track
    // on a term its kept observations no longer earned). Coverage sums the
    // in-window span of each SURVIVING segment, so the holes left by dropped
    // segments are not claimed as covered (measured: wm-dink-01 T7 kept
    // 3 + 33 observations at opposite ends of the clip and would otherwise
    // still claim 96% coverage across the dropped middle).
    const windowCoverage = Math.min(
      1,
      keptSegments.reduce((total, segment) => {
        const segmentInWindow = segment.filter(
          (observation) =>
            observation.timestampMs >= window.startMs && observation.timestampMs <= window.endMs,
        );
        return segmentInWindow.length >= 2
          ? total +
              (segmentInWindow[segmentInWindow.length - 1]!.timestampMs -
                segmentInWindow[0]!.timestampMs) /
                windowLength
          : total;
      }, 0),
    );
    const meanScore = mean(observations.map((observation) => observation.detectorScore));
    const judged = inWindow.length > 0 ? inWindow : observations;
    const targetDistances: number[] = [];
    const otherDistances: number[] = [];
    for (const observation of judged) {
      const nearest = nearestWrists(wrists, observation.timestampMs);
      if (nearest) {
        targetDistances.push(
          Math.min(
            ...nearest.map((wrist) =>
              Math.hypot(wrist.x - observation.center.x, wrist.y - observation.center.y),
            ),
          ),
        );
      }
      const nearestOther = nearestWrists(otherWrists, observation.timestampMs);
      if (nearestOther) {
        otherDistances.push(
          Math.min(
            ...nearestOther.map((wrist) =>
              Math.hypot(wrist.x - observation.center.x, wrist.y - observation.center.y),
            ),
          ),
        );
      }
    }
    const meanWristDistance = targetDistances.length > 0 ? mean(targetDistances) : null;
    const meanOtherDistance = otherDistances.length > 0 ? mean(otherDistances) : null;
    // A paddle decisively closer to another player's hand is THEIR paddle.
    const otherPlayers =
      meanWristDistance !== null &&
      meanOtherDistance !== null &&
      meanOtherDistance < meanWristDistance * TRACKER_GATES.otherOwnershipFactor;
    if (otherPlayers) rejectedOtherPlayerTracks += 1;
    // HAND AFFINITY (paddle-waterfall finding, 2026-08-28): scoring by
    // windowCoverage × detectorScore selects long-lived BACKGROUND
    // racket-like tracks over the real, often fragmented, paddle track
    // (measured on afn-vic-rally1: the winner had 97% coverage and 0 label
    // hits while seven short tracks each covered the true paddle). What
    // identifies "the target's paddle" is that it travels WITH the target's
    // hand — so affinity dominates, and length/score only break ties.
    const handHits = targetDistances.filter(
      (distance) => distance <= TRACKER_GATES.handAffinityRadius,
    ).length;
    const handAffinity = targetDistances.length > 0 ? handHits / targetDistances.length : 0;
    const proximityFactor =
      meanWristDistance === null ? 0.2 : Math.max(0.1, Math.min(1, 1.25 - meanWristDistance * 4));
    return {
      candidate: { ...candidate, observations, windowCoverage, meanScore, meanWristDistance },
      meanOtherDistance,
      otherPlayers,
      handAffinity,
      otherEvidenceCoverage: judged.length > 0 ? otherDistances.length / judged.length : 0,
      evidenceGapDropped,
      // FROZEN selection OBJECTIVE (an affinity-dominant rescoring was tried
      // and measured WORSE: S4 recall 0.22 -> 0.04; see
      // datasets/experiments/EXP-2026-08-28-paddle-waterfall.json). Only the
      // TERMS are fresh now: they come from the kept observations above.
      score: windowCoverage * meanScore * proximityFactor,
    };
  });
  scored.sort((a, b) => b.score - a.score);

  const eligible = scored.filter(
    (entry) =>
      !entry.otherPlayers && entry.candidate.observations.length >= TRACKER_GATES.minObservations,
  );
  const association: PaddleAssociationDecision = {
    meanTargetWristDistance: null,
    meanOtherWristDistance: null,
    rejectedOtherPlayerTracks,
    selectionMargin: null,
    switchEvents,
    risks,
  };
  if (eligible.length === 0) {
    if (rejectedOtherPlayerTracks > 0) {
      risks.push("PADDLE_BELONGS_TO_OTHER_PLAYER: all plausible paddles are other players'");
    }
    return {
      status: "untracked",
      reason:
        rejectedOtherPlayerTracks > 0
          ? "only_other_players_paddles_found (abstaining rather than corrupting identity)"
          : "no_tracks_formed_near_target",
      allTracks: scored.map((entry) => entry.candidate),
      association,
    };
  }
  const best = eligible[0]!;
  const runnerUp = eligible[1];
  association.meanTargetWristDistance = best.candidate.meanWristDistance;
  association.meanOtherWristDistance = best.meanOtherDistance;
  association.selectionMargin = runnerUp && runnerUp.score > 0 ? best.score / runnerUp.score : null;

  // (A) NEAR-OWNERSHIP DEAD ZONE (ownership-guard-v1): the other player's
  // wrist is strictly closer than the target's, yet the decisive test above
  // did not reject (margin inside otherOwnershipFactor..1.0). Confidently
  // claiming this track picks the wrong owner in exactly the measured
  // partner-paddle-closer-than-own family — abstain as ambiguous instead.
  if (
    guard &&
    best.meanOtherDistance !== null &&
    best.candidate.meanWristDistance !== null &&
    best.meanOtherDistance < best.candidate.meanWristDistance
  ) {
    risks.push(
      "PADDLE_OWNERSHIP_AMBIGUOUS: other player's wrist closer than target's (non-decisive margin)",
    );
    return {
      status: "untracked",
      reason: "paddle_ownership_ambiguous_other_wrist_closer (abstaining rather than guessing)",
      allTracks: scored.map((entry) => entry.candidate),
      association,
    };
  }

  // Ambiguity: two comparable candidates near DIFFERENT hands → abstain.
  if (
    runnerUp &&
    association.selectionMargin !== null &&
    association.selectionMargin < 1.25 &&
    runnerUp.candidate.meanWristDistance !== null &&
    best.candidate.meanWristDistance !== null &&
    Math.abs(runnerUp.candidate.meanWristDistance - best.candidate.meanWristDistance) > 0.05
  ) {
    risks.push("PADDLE_ASSOCIATION_AMBIGUOUS: two comparable paddle tracks near different hands");
    return {
      status: "untracked",
      reason: "paddle_association_ambiguous (abstaining rather than guessing)",
      allTracks: scored.map((entry) => entry.candidate),
      association,
    };
  }

  if (best.candidate.windowCoverage < TRACKER_GATES.minWindowCoverage) {
    return {
      status: "untracked",
      reason: `best_track_low_window_coverage (${(best.candidate.windowCoverage * 100).toFixed(0)}%)`,
      allTracks: scored.map((entry) => entry.candidate),
      association,
    };
  }
  if (
    best.candidate.meanWristDistance === null ||
    best.candidate.meanWristDistance > TRACKER_GATES.maxMeanWristDistance
  ) {
    return {
      status: "untracked",
      reason:
        best.candidate.meanWristDistance === null
          ? "no_wrist_measurements_to_gate_against"
          : `best_track_far_from_wrists (${best.candidate.meanWristDistance.toFixed(3)} > ${TRACKER_GATES.maxMeanWristDistance})`,
      allTracks: scored.map((entry) => entry.candidate),
      association,
    };
  }

  // (C) UNVERIFIED OWNERSHIP (ownership-guard-v1): a multi-player scene in
  // which the winning track has (almost) no other-wrist measurements —
  // the ownership test never actually ran. The verdict stands (a paddle in
  // the target's hand is plausibly theirs) but carries an explicit risk so
  // downstream consumers never read it as a verified-ownership claim.
  if (
    guard &&
    sceneHasOtherPlayers &&
    best.otherEvidenceCoverage < OWNERSHIP_GUARD_GATES.minOtherEvidenceCoverage
  ) {
    risks.push(
      "PADDLE_OWNERSHIP_UNVERIFIED: other players present but (almost) no other-wrist evidence over the selected track",
    );
  }
  if (guard && best.evidenceGapDropped > 0) {
    risks.push(
      "PADDLE_OWNERSHIP_EVIDENCE_GAP: dropped sustained out-of-hand runs with no other-wrist evidence",
    );
  }

  // Final per-observation heuristic confidence + nearWrist flags.
  const observations = best.candidate.observations.map((observation, index, all) => {
    const nearest = nearestWrists(wrists, observation.timestampMs);
    const wristDistance = nearest
      ? Math.min(
          ...nearest.map((wrist) =>
            Math.hypot(wrist.x - observation.center.x, wrist.y - observation.center.y),
          ),
        )
      : Infinity;
    const nearWrist = wristDistance <= TRACKER_GATES.nearWristRadius;
    const previous = all[index - 1];
    const next = all[index + 1];
    const localContinuity =
      (previous && observation.timestampMs - previous.timestampMs <= 100 ? 0.5 : 0) +
      (next && next.timestampMs - observation.timestampMs <= 100 ? 0.5 : 0);
    const confidence = Math.max(
      0.02,
      Math.min(
        1,
        observation.detectorScore * (0.6 + 0.4 * localContinuity) * (nearWrist ? 1 : 0.75),
      ),
    );
    return { ...observation, confidence, nearWrist };
  });
  const lab: PaddleTrackCandidate = { ...best.candidate, observations };

  const track: PaddleTrack = {
    schemaVersion: 1,
    coordinateSystem: "normalized_image_top_left",
    producedBy: {
      providerId: "paddle.dfine-coco-proxy",
      modelVersion: `dfine-medium-coco+${PADDLE_TRACKER_VERSION}`,
      runtime: "pytorch",
      executionTarget: "server",
      artifactHash: null,
    },
    observations: observations.map((observation, index): PaddleObservation => ({
      frameIndex: index,
      timestampMs: Math.round(observation.timestampMs),
      bbox: observation.box,
      keypoints: {
        handleEnd: null,
        throat: null,
        center: observation.center,
        tip: null,
      },
      confidence: observation.confidence,
    })),
    continuity: lab.windowCoverage,
  };
  return {
    status: "tracked",
    track,
    lab,
    allTracks: scored.map((entry) => entry.candidate),
    association,
  };
}

/** (B) helper for ownership-guard-v1: split a segment into maximal runs by
 *  other-wrist-evidence presence; sustained no-evidence runs whose
 *  observations are not in the target's hand are unverifiable → dropped. */
function dropUnverifiableRuns(
  segment: TrackedPaddleObservation[],
  wrists: ReturnType<typeof wristSeries>,
  otherWrists: ReturnType<typeof wristSeries>,
): { kept: TrackedPaddleObservation[][]; dropped: TrackedPaddleObservation[][] } {
  const kept: TrackedPaddleObservation[][] = [];
  const dropped: TrackedPaddleObservation[][] = [];
  let run: TrackedPaddleObservation[] = [];
  let runHasEvidence: boolean | null = null;
  const flush = () => {
    if (run.length === 0) return;
    if (runHasEvidence === false && run.length >= OWNERSHIP_GUARD_GATES.minEvidenceGapRun) {
      const targetDistances = run.map((observation) => {
        const nearest = nearestWrists(wrists, observation.timestampMs);
        return nearest
          ? Math.min(
              ...nearest.map((wrist) =>
                Math.hypot(wrist.x - observation.center.x, wrist.y - observation.center.y),
              ),
            )
          : Infinity;
      });
      const meanTarget = mean(targetDistances.filter((distance) => Number.isFinite(distance)));
      const inHand =
        targetDistances.some((distance) => Number.isFinite(distance)) &&
        meanTarget <= TRACKER_GATES.handAffinityRadius;
      (inHand ? kept : dropped).push(run);
    } else {
      kept.push(run);
    }
    run = [];
  };
  for (const observation of segment) {
    const hasEvidence = nearestWrists(otherWrists, observation.timestampMs) !== null;
    if (runHasEvidence === null || hasEvidence === runHasEvidence) {
      run.push(observation);
    } else {
      flush();
      run = [observation];
    }
    runHasEvidence = hasEvidence;
  }
  flush();
  return { kept, dropped };
}

/** A contiguous run of track observations with one wrist-ownership verdict. */
export interface PaddleTrackSegment {
  observations: TrackedPaddleObservation[];
  startMs: number;
  endMs: number;
  /** True when this segment IS a sustained other-player flip run. */
  sustainedFlipRun: boolean;
  /** Fresh per-segment evidence (never inherited from the whole track). */
  meanTargetWristDistance: number | null;
  meanOtherWristDistance: number | null;
  /** Decisive segment-level ownership test (same factor as track level). */
  ownedByOtherPlayer: boolean;
  /** Mirror test: the TARGET's wrist is decisively closer. Segments that are
   *  neither (neutral) are ambiguous evidence around identity handovers. */
  ownedByTarget: boolean;
}

/**
 * FLIP-SEGMENTATION (wave-B W1). The predecessor of this function returned
 * the FIRST sustained flip index and the selector deleted everything after
 * it (`observations.slice`). Measured failure (B-selection-forensics):
 * afn-sasebo-rally1's winning track flipped for 3 observations at 734ms and
 * the deleted 734–3837ms tail — decisively TARGET-owned (mean wrist distance
 * 0.086 vs other 0.239) — contained every gold label. Instead of deleting,
 * SPLIT the track at sustained-flip boundaries (3+ consecutive observations
 * with another player's wrist closer than otherFlipFactor × target) and give
 * every segment a FRESH ownership verdict so decisively target-owned
 * segments survive no matter where the flip happened.
 *
 * Ownership is judged on the segment's in-window observations (falling back
 * to the whole segment), mirroring the track-level judgment exactly: a
 * single-segment track gets the same verdict the old code gave it.
 */
export function segmentTrackByWristOwnership(
  observations: readonly TrackedPaddleObservation[],
  wrists: ReturnType<typeof wristSeries>,
  otherWrists: ReturnType<typeof wristSeries>,
  window: { startMs: number; endMs: number },
): PaddleTrackSegment[] {
  if (observations.length === 0) return [];
  // Per-observation wrist distances; an observation is "other-owned" when
  // the other player's wrist is decisively closer (otherFlipFactor).
  const perObservation = observations.map((observation) => {
    const target = nearestWrists(wrists, observation.timestampMs);
    const other = nearestWrists(otherWrists, observation.timestampMs);
    const targetDistance = target
      ? Math.min(
          ...target.map((wrist) =>
            Math.hypot(wrist.x - observation.center.x, wrist.y - observation.center.y),
          ),
        )
      : null;
    const otherDistance = other
      ? Math.min(
          ...other.map((wrist) =>
            Math.hypot(wrist.x - observation.center.x, wrist.y - observation.center.y),
          ),
        )
      : null;
    const otherOwned =
      targetDistance !== null &&
      otherDistance !== null &&
      otherDistance < targetDistance * TRACKER_GATES.otherFlipFactor;
    return { observation, targetDistance, otherDistance, otherOwned };
  });

  // Sustained flip runs: >= sustainedFlipRunLength consecutive other-owned
  // observations (missing wrist data breaks a run, as before).
  const inFlipRun = new Array<boolean>(observations.length).fill(false);
  let runStart = 0;
  for (let index = 0; index <= observations.length; index += 1) {
    const owned = index < observations.length && perObservation[index]!.otherOwned;
    if (owned) continue;
    if (index - runStart >= TRACKER_GATES.sustainedFlipRunLength) {
      for (let cursor = runStart; cursor < index; cursor += 1) inFlipRun[cursor] = true;
    }
    runStart = index + 1;
  }

  // Cut into contiguous segments at flip-run boundaries.
  const segments: PaddleTrackSegment[] = [];
  let segmentStart = 0;
  for (let index = 1; index <= observations.length; index += 1) {
    if (index < observations.length && inFlipRun[index] === inFlipRun[segmentStart]) continue;
    const slice = perObservation.slice(segmentStart, index);
    // Fresh segment verdict, judged like the track level: in-window
    // observations when any exist, otherwise the whole segment.
    const inWindow = slice.filter(
      (entry) =>
        entry.observation.timestampMs >= window.startMs &&
        entry.observation.timestampMs <= window.endMs,
    );
    const judged = inWindow.length > 0 ? inWindow : slice;
    const targetDistances = judged
      .map((entry) => entry.targetDistance)
      .filter((distance): distance is number => distance !== null);
    const otherDistances = judged
      .map((entry) => entry.otherDistance)
      .filter((distance): distance is number => distance !== null);
    const meanTarget = targetDistances.length > 0 ? mean(targetDistances) : null;
    const meanOther = otherDistances.length > 0 ? mean(otherDistances) : null;
    segments.push({
      observations: slice.map((entry) => entry.observation),
      startMs: slice[0]!.observation.timestampMs,
      endMs: slice[slice.length - 1]!.observation.timestampMs,
      sustainedFlipRun: inFlipRun[segmentStart]!,
      meanTargetWristDistance: meanTarget,
      meanOtherWristDistance: meanOther,
      ownedByOtherPlayer:
        meanTarget !== null &&
        meanOther !== null &&
        meanOther < meanTarget * TRACKER_GATES.otherOwnershipFactor,
      ownedByTarget:
        meanTarget !== null &&
        meanOther !== null &&
        meanTarget < meanOther * TRACKER_GATES.otherOwnershipFactor,
    });
    segmentStart = index;
  }
  return segments;
}

/** Paddle center speed series (normalized units/s) for contact evidence. */
export function paddleSpeedSeries(
  observations: readonly TrackedPaddleObservation[],
): Array<{ timestampMs: number; value: number }> {
  const series: Array<{ timestampMs: number; value: number }> = [];
  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1]!;
    const current = observations[index]!;
    const dtSec = (current.timestampMs - previous.timestampMs) / 1000;
    if (dtSec <= 0 || dtSec > 0.15) continue; // no speed across gaps
    series.push({
      timestampMs: current.timestampMs,
      value:
        Math.hypot(current.center.x - previous.center.x, current.center.y - previous.center.y) /
        dtSec,
    });
  }
  return series;
}

function appendObservation(
  track: ActiveTrack,
  timestampMs: number,
  box: NormalizedBox,
  score: number,
  source?: PaddleDetectionSource,
): void {
  const center = boxCenter(box);
  const previous = track.observations[track.observations.length - 1];
  if (previous) {
    const dtSec = (timestampMs - previous.timestampMs) / 1000;
    if (dtSec > 0) {
      // Exponentially smoothed velocity for prediction only.
      const vx = (center.x - previous.center.x) / dtSec;
      const vy = (center.y - previous.center.y) / dtSec;
      track.velocity = {
        x: 0.6 * track.velocity.x + 0.4 * vx,
        y: 0.6 * track.velocity.y + 0.4 * vy,
      };
    }
  }
  track.observations.push({
    timestampMs,
    box,
    center,
    detectorScore: score,
    trackId: track.trackId,
    confidence: score, // provisional; finalized during selection
    nearWrist: false,
    ...(source ? { source } : {}),
  });
  track.lastMs = timestampMs;
}

function predictCenter(track: ActiveTrack, timestampMs: number): { x: number; y: number } {
  const last = track.observations[track.observations.length - 1]!;
  const dtSec = Math.min(0.2, Math.max(0, (timestampMs - last.timestampMs) / 1000));
  return {
    x: last.center.x + track.velocity.x * dtSec,
    y: last.center.y + track.velocity.y * dtSec,
  };
}

function nearestWrists(
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

function normalizeBox(
  box: [number, number, number, number],
  width: number,
  height: number,
): NormalizedBox {
  return {
    x: box[0] / width,
    y: box[1] / height,
    width: (box[2] - box[0]) / width,
    height: (box[3] - box[1]) / height,
  };
}

function boxCenter(box: NormalizedBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}
