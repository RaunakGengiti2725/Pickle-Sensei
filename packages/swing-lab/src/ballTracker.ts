import type { BallObservation, BallTrack, PoseSequence } from "@pickle/swing-domain";
import { toLegacyPoseFrames } from "@pickle/swing-domain";
import type { TrackedPaddleObservation } from "./paddleTracker.js";

/**
 * Temporal ball tracking over motion candidates.
 *
 * The ball is treated as a TEMPORAL object, never a per-frame classification:
 *   candidates (3-frame differencing) → greedy association with constant-
 *   velocity prediction → physics gates (speed, smoothness, size) → context
 *   gates (chronic background motion, pose-derived play band) → primary
 *   selection (window overlap + paddle affinity).
 *
 * Honesty rules:
 * - No interpolation: every emitted observation is a measured candidate that
 *   won association. Gaps stay gaps.
 * - No single heuristic equals "ball": a track must survive association,
 *   physics, and context independently, and the per-observation confidence
 *   is labeled heuristic-uncalibrated.
 * - Ablation counters (raw → associated → gated) ship with every run so the
 *   temporal advantage is measurable, not asserted.
 */

export const BALL_TRACKER_VERSION = "ball-track-2";
export const BALL_CONFIDENCE_MODEL = "heuristic-v1-ball (uncalibrated)";

/**
 * Body-occlusion state machine (ball-track-2).
 *
 * A ball that flies INTO the target player's body region and disappears is
 * not a background artifact — it is the moment the paddle is about to meet
 * it (measured failure: afn-sasebo-rally2, gold contact 2620ms, incoming
 * lob dies at the body edge and the whole stage went UNTRACKED, starving
 * contact). The machine is explicit:
 *
 *   TRACKED → ENTERING_OCCLUSION (approaching the pose-derived body region
 *   with real terminal velocity) → OCCLUDED (bounded constant-velocity
 *   prediction, hard max duration) → REACQUIRED (compatible post-occlusion
 *   segment) or LOST.
 *
 * Honesty rules unchanged: predictions are flagged `predicted: true`,
 * NEVER join the canonical observations, and are only materialized for a
 * confirmed bridge. Staying LOST beats guessing — a decoy blob must not be
 * grabbed (ambiguity margin + region/velocity/time compatibility gates).
 */
export const BALL_OCCLUSION = {
  /** Entry zone: distance from the (bodyRadius-padded) joint bounding box. */
  enterDistance: 0.12,
  /** Robust terminal velocity must point into the body region (cos ≥). */
  headingMinCos: 0.5,
  /** Minimum robust terminal speed (u/s): drift that fades near the body is
   * not an occlusion entry. */
  minEntrySpeedNormPerSec: 0.25,
  /** OCCLUDED is bounded: prediction validity and the reacquisition search
   * expire here; afterwards the ball is LOST, not extrapolated. */
  maxOcclusionMs: 500,
  /** Outgoing segment must START within this distance of the body region. */
  reacquireStartRadius: 0.15,
  /** Body-emergence corridor: relaxed vs the strict corridor (the flight
   * passed behind a torso, so the strict line is too tight) but with a hard
   * absolute cap — a candidate outside it is a different object. Measured
   * counterexample: rally2 body blob at gap 334ms, miss 0.304, dwell 0.67
   * briefly rode a 2× relaxation and poisoned contact by 1.4s. */
  bodyEmergenceRadiusGrowthPerSec: 0.9,
  bodyEmergenceRadiusCap: 0.3,
  /** Body-occlusion PRIMARY fallback (only when NO paddle-aligned primary
   * exists): extra gates so background drift can never ride this path. */
  minPrimaryObservations: 8,
  minPrimaryStraightness: 0.4,
  /** A death this close to the window end is indistinguishable from the
   * clip ending — no occlusion claim. */
  windowEndMarginMs: 150,
  /** Two comparable body-occlusion primaries → stay untracked (honest). */
  primaryScoreMargin: 1.3,
} as const;

export interface BallCandidate {
  x: number;
  y: number;
  areaPx: number;
  wNorm: number;
  hNorm: number;
  elong: number;
  score: number;
}

export interface BallCandidateFile {
  schemaVersion: 1;
  generator: { version: string; method: string; scale: number; note: string };
  video: { path: string; width: number; height: number; fps: number; durationMs: number };
  window: { startMs: number; endMs: number };
  backgroundActivity: { grid: number; cells: number[] };
  timing: { framesProcessed: number; wallSecTotal: number; msPerFrame: number };
  frames: Array<{ tMs: number; candidates: BallCandidate[]; rawComponentCount: number }>;
}

export interface BallTrackObservation {
  timestampMs: number;
  x: number;
  y: number;
  areaPx: number;
  elong: number;
  /** heuristic-v1-ball (uncalibrated). */
  confidence: number;
  chronicActivity: number;
}

/** Terminal/initial relationship of a track to the TARGET's body region
 * (pose-derived joint bounding box, bodyRadius-padded). Computed from
 * measured joints at build time so the occlusion state machine needs no
 * extra inputs at link time. */
export interface BallBodyOcclusionInfo {
  /** Distance from the last observation to the body region (0 = inside);
   * null when no pose joints exist near that timestamp. */
  endDistanceToBody: number | null;
  /** Same for the first observation (reacquisition candidates must emerge
   * from the region the ball vanished into). */
  startDistanceToBody: number | null;
  /** cos(angle) between the robust terminal velocity and the direction into
   * the body region; 1 when the last observation is already inside. */
  headingIntoBodyCos: number | null;
  /** Robust terminal speed (median of the last steps), u/s. */
  endSpeedNormPerSec: number;
  /** The track terminates by entering the body region with real velocity —
   * the precondition for ENTERING_OCCLUSION/OCCLUDED states. */
  endsIntoBody: boolean;
  /** Timestamp where the terminal in-zone approach began (consecutive
   * observations within enterDistance of the region); null if not entering. */
  enteringFromMs: number | null;
}

export interface BallTrackCandidate {
  trackId: number;
  observations: BallTrackObservation[];
  medianSpeed: number;
  maxSpeed: number;
  jerkyFraction: number;
  chronicFraction: number;
  inBandFraction: number;
  medianArea: number;
  windowOverlapMs: number;
  minPaddleDistance: number | null;
  /** Fraction of observations essentially ON the paddle (< 0.05). A ball
   * touches the paddle momentarily; paddle/arm artifacts live there. */
  nearPaddleFraction: number;
  /** Net displacement / path length — balls travel, limbs oscillate. */
  straightness: number;
  /** Fraction of steps moving in lockstep with many concurrent tracks —
   * camera pans / global scene motion produce coherent velocity fields;
   * a ball is a motion outlier. */
  coherentMotionFraction: number;
  /** Fraction of observations within bodyRadius of a pose joint. Shirt and
   * limb motion blobs live on the body; a ball only grazes it. */
  bodyDwellFraction: number;
  /** Robust (median-of-steps) velocity over the last ≤5 steps — a single
   * mis-associated tail blob must not bend the occlusion corridor. */
  terminalVelocity: { x: number; y: number } | null;
  /** Robust velocity over the first ≤5 steps (reacquisition compatibility). */
  initialVelocity: { x: number; y: number } | null;
  /** Body-occlusion descriptors (see BallBodyOcclusionInfo). */
  bodyOcclusion: BallBodyOcclusionInfo;
}

export interface BallAblation {
  durationSec: number;
  stageA_rawCandidatesPerSec: number;
  stageB_tracks: number;
  stageB_trackedObsPerSec: number;
  stageC_tracks: number;
  stageC_trackedObsPerSec: number;
  stageC_coherenceRejected: number;
}

export type BallState = "TRACKED" | "ENTERING_OCCLUSION" | "OCCLUDED" | "REACQUIRED" | "LOST";

export interface BallTimeline {
  states: Array<{ state: BallState; fromMs: number; toMs: number }>;
  /** Corridor predictions materialized ONLY for a confirmed occlusion bridge.
   * These are NEVER observations and never enter the canonical track. */
  bridge: Array<{ t: number; x: number; y: number; predicted: true }>;
  reacquisition:
    | { attempted: false }
    | {
        attempted: true;
        result: "SUCCESS" | "FAILED_NO_CANDIDATE" | "FAILED_AMBIGUOUS";
        detail: string;
        contactAware: boolean;
        /** True when the primary demonstrably vanished into the target's
         * body region (body-occlusion state machine active). */
        bodyOcclusion?: boolean;
      };
}

export type BallTrackingOutcome =
  | {
      status: "tracked";
      track: BallTrack;
      lab: BallTrackCandidate;
      gatedTracks: BallTrackCandidate[];
      ablation: BallAblation;
      timeline: BallTimeline;
      /** How the primary earned eligibility: the strict paddle-aligned gate,
       * or the body-occlusion fallback (ball flew into the target's body
       * region; only consulted when NO paddle-aligned candidate exists). */
      selection: "paddle_aligned" | "body_occlusion";
    }
  | {
      status: "untracked";
      reason: string;
      gatedTracks: BallTrackCandidate[];
      ablation: BallAblation;
    };

export const BALL_GATES2 = {
  /** Association. Base gate must exceed a fast ball's per-frame step:
   * ~1.5 u/s at 25fps ≈ 0.06/frame — a 0.035 gate can never chain it. */
  baseGateRadius: 0.07,
  gateSpeedFactor: 2.2,
  maxGateRadius: 0.16,
  maxGapMs: 130,
  maxSeedAreaPx: 400,
  maxActiveTracks: 140,
  /** Physics */
  minObservations: 5,
  maxSpeedNormPerSec: 3.5,
  minMedianSpeedNormPerSec: 0.12,
  maxJerkyFraction: 0.34,
  jerkyTurnDeg: 70,
  /** Turns are only meaningful between steps of real length: the angle
   * between two near-zero displacements is centroid measurement noise
   * (~a few px), not ball physics. */
  jerkyMinStepNorm: 0.008,
  maxMedianAreaPx: 220,
  maxElongMedian: 3.5,
  /** Context */
  chronicCellThreshold: 0.55,
  maxChronicFraction: 0.6,
  coherenceMinSpeedNormPerSec: 0.5,
  coherenceAngleDeg: 25,
  coherenceSpeedRatioMax: 1.55,
  coherenceMinPeers: 4,
  maxCoherentMotionFraction: 0.5,
  bandPadTop: 0.2,
  bandPadBottom: 0.06,
  minInBandFraction: 0.8,
  /** Primary selection: a ball in play transits quickly (4 frames @25fps)
   * and MOVES; a primary claim also requires plausible paddle proximity. */
  minWindowOverlapMs: 160,
  minPrimaryMedianSpeed: 0.3,
  maxPrimaryPaddleDistance: 0.18,
  nearPaddleRadius: 0.05,
  bodyRadius: 0.09,
  maxBodyDwellFraction: 0.4,
} as const;

interface ActiveBallTrack {
  trackId: number;
  observations: BallTrackObservation[];
  lastMs: number;
  velocity: { x: number; y: number };
  lastStep: number;
}

export function buildBallTracks(
  file: BallCandidateFile,
  pose: PoseSequence,
  window: { startMs: number; endMs: number },
  paddle: readonly TrackedPaddleObservation[] | null,
  /** Precomputed toLegacyPoseFrames(pose); derived here when absent. */
  legacyFrames?: ReturnType<typeof toLegacyPoseFrames> | null,
): {
  gated: BallTrackCandidate[];
  all: BallTrackCandidate[];
  /** 3–4 observation chains: too short to stand alone, usable ONLY as
   * reacquisition candidates after an occlusion. */
  fragments: BallTrackCandidate[];
  ablation: BallAblation;
} {
  const chronic = file.backgroundActivity;
  const chronicAt = (x: number, y: number): number => {
    const grid = chronic.grid;
    const cx = Math.min(grid - 1, Math.max(0, Math.floor(x * grid)));
    const cy = Math.min(grid - 1, Math.max(0, Math.floor(y * grid)));
    return chronic.cells[cy * grid + cx] ?? 0;
  };
  const frames = legacyFrames ?? toLegacyPoseFrames(pose);
  const band = playBand(frames);
  const joints = jointSeries(frames);

  // ── Association (stage B) ────────────────────────────────────────────────
  const active: ActiveBallTrack[] = [];
  const finished: ActiveBallTrack[] = [];
  let nextId = 1;
  let rawCandidates = 0;

  for (const frame of file.frames) {
    rawCandidates += frame.candidates.length;
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (frame.tMs - active[index]!.lastMs > BALL_GATES2.maxGapMs) {
        finished.push(active.splice(index, 1)[0]!);
      }
    }
    // Global lowest-cost assignment: every in-gate (track, candidate) pair
    // competes by cost. Greedy-by-track ordering let long limb tracks steal
    // ball candidates from younger, better-fitting tracks.
    const taken = new Set<number>();
    const matchedTracks = new Set<number>();
    const pairs: Array<{ trackIndex: number; candidateIndex: number; cost: number }> = [];
    for (const [trackIndex, track] of active.entries()) {
      const last = track.observations[track.observations.length - 1]!;
      const dtSec = (frame.tMs - last.timestampMs) / 1000;
      const predicted = {
        x: last.x + track.velocity.x * dtSec,
        y: last.y + track.velocity.y * dtSec,
      };
      const gate = Math.min(
        BALL_GATES2.maxGateRadius,
        Math.max(BALL_GATES2.baseGateRadius, track.lastStep * BALL_GATES2.gateSpeedFactor),
      );
      for (const [candidateIndex, candidate] of frame.candidates.entries()) {
        const distance = Math.hypot(candidate.x - predicted.x, candidate.y - predicted.y);
        if (distance > gate) continue;
        // Size-change penalty keeps a ball track from jumping onto a limb.
        const sizeRatio =
          Math.max(candidate.areaPx, last.areaPx) /
          Math.max(1, Math.min(candidate.areaPx, last.areaPx));
        pairs.push({
          trackIndex,
          candidateIndex,
          cost: distance + Math.min(0.05, (sizeRatio - 1) * 0.01),
        });
      }
    }
    pairs.sort((a, b) => a.cost - b.cost);
    for (const pair of pairs) {
      if (taken.has(pair.candidateIndex) || matchedTracks.has(pair.trackIndex)) continue;
      taken.add(pair.candidateIndex);
      matchedTracks.add(pair.trackIndex);
      appendBallObservation(
        active[pair.trackIndex]!,
        frame.tMs,
        frame.candidates[pair.candidateIndex]!,
        chronicAt,
      );
    }
    for (const [candidateIndex, candidate] of frame.candidates.entries()) {
      if (taken.has(candidateIndex)) continue;
      if (candidate.areaPx > BALL_GATES2.maxSeedAreaPx) continue;
      const track: ActiveBallTrack = {
        trackId: nextId++,
        observations: [],
        lastMs: frame.tMs,
        velocity: { x: 0, y: 0 },
        lastStep: 0,
      };
      appendBallObservation(track, frame.tMs, candidate, chronicAt);
      active.push(track);
    }
    if (active.length > BALL_GATES2.maxActiveTracks) {
      // Prune the stalest single-observation seeds first.
      active.sort((a, b) => b.observations.length - a.observations.length || b.lastMs - a.lastMs);
      finished.push(...active.splice(BALL_GATES2.maxActiveTracks));
    }
  }
  finished.push(...active);

  const associated = finished.filter(
    (track) => track.observations.length >= BALL_GATES2.minObservations,
  );
  const coherence = computeCoherentMotionFractions(
    finished.filter((track) => track.observations.length >= 3),
  );
  // Short chains kept ONLY for occlusion reacquisition, with light sanity
  // gates (size + speed ceiling).
  const fragments = finished
    .filter(
      (track) =>
        track.observations.length >= 3 && track.observations.length < BALL_GATES2.minObservations,
    )
    .map((track) =>
      describeTrack(
        track,
        window,
        paddle,
        band,
        chronicAt,
        joints,
        coherence.get(track.trackId) ?? 0,
      ),
    )
    .filter(
      (candidate) =>
        candidate.maxSpeed <= BALL_GATES2.maxSpeedNormPerSec &&
        candidate.medianArea <= BALL_GATES2.maxMedianAreaPx,
    );

  // ── Physics + context gates (stage C) ───────────────────────────────────
  const allCandidates = associated.map((track) =>
    describeTrack(
      track,
      window,
      paddle,
      band,
      chronicAt,
      joints,
      coherence.get(track.trackId) ?? 0,
    ),
  );
  const passesStableGates = (candidate: BallTrackCandidate): boolean =>
    candidate.maxSpeed <= BALL_GATES2.maxSpeedNormPerSec &&
    candidate.medianSpeed >= BALL_GATES2.minMedianSpeedNormPerSec &&
    candidate.jerkyFraction <= BALL_GATES2.maxJerkyFraction &&
    candidate.chronicFraction <= BALL_GATES2.maxChronicFraction &&
    candidate.inBandFraction >= BALL_GATES2.minInBandFraction &&
    candidate.medianArea <= BALL_GATES2.maxMedianAreaPx;
  const gated = allCandidates.filter(
    (candidate) =>
      passesStableGates(candidate) &&
      candidate.coherentMotionFraction <= BALL_GATES2.maxCoherentMotionFraction,
  );
  const coherenceRejected = allCandidates.filter(
    (candidate) =>
      passesStableGates(candidate) &&
      candidate.coherentMotionFraction > BALL_GATES2.maxCoherentMotionFraction,
  ).length;

  const durationSec = Math.max(
    0.001,
    (file.frames[file.frames.length - 1]!.tMs - file.frames[0]!.tMs) / 1000,
  );
  const ablation: BallAblation = {
    durationSec,
    stageA_rawCandidatesPerSec: rawCandidates / durationSec,
    stageB_tracks: associated.length,
    stageB_trackedObsPerSec:
      associated.reduce((total, track) => total + track.observations.length, 0) / durationSec,
    stageC_tracks: gated.length,
    stageC_trackedObsPerSec:
      gated.reduce((total, track) => total + track.observations.length, 0) / durationSec,
    stageC_coherenceRejected: coherenceRejected,
  };
  return { gated, all: allCandidates, fragments, ablation };
}

/**
 * Occlusion bridging + reacquisition (state machine TRACKED →
 * [ENTERING_OCCLUSION] → OCCLUDED → REACQUIRED | LOST).
 *
 * Search constraints (documented, heuristic, uncalibrated):
 * - Non-contact case: outgoing segment must start inside the constant-
 *   velocity corridor of the incoming track (radius grows 0.06/100ms),
 *   within 400ms, with compatible direction (±55°) and speed ratio 0.4–2.5.
 * - Body-occlusion case (the primary demonstrably flew INTO the target's
 *   body region — `primary.bodyOcclusion.endsIntoBody`): the search window
 *   extends to the hard occlusion cap; in addition to the strict corridor,
 *   a segment qualifies when it EMERGES from the body region
 *   (start ≤ reacquireStartRadius from the region, region-EXIT motion, low
 *   body dwell) inside a relaxed-but-capped corridor predicted from the
 *   ROBUST pre-occlusion velocity, with compatible direction (±55°) and
 *   speed ratio 0.4–2.5. Direction reversals belong to the contact-aware
 *   pass, never this one.
 * - Contact case (a contact estimate falls in the gap): direction is
 *   legitimately discontinuous; instead the segment must START near the
 *   contact location (≤0.14), begin within 400ms after contact, move AWAY
 *   from it, at a plausible speed. No fixed reflection model is assumed.
 * - Two candidates within 1.4× score of each other → FAILED_AMBIGUOUS
 *   (staying LOST beats guessing; a decoy is worse than honesty).
 *
 * Bridge points are corridor predictions materialized only after a
 * SUCCESSFUL link; they are flagged predicted and excluded from the
 * canonical observations. On LOST nothing is fabricated: the OCCLUDED span
 * (bounded by maxOcclusionMs) merely names the period the machine searched.
 */
export function linkBallTimeline(input: {
  primary: BallTrackCandidate;
  candidates: readonly BallTrackCandidate[]; // gated + fragments, any order
  contact: { tMs: number; x: number; y: number } | null;
  windowEndMs: number;
}): { timeline: BallTimeline; outgoing: BallTrackCandidate | null } {
  const observations = input.primary.observations;
  const last = observations[observations.length - 1]!;
  const previous = observations[Math.max(0, observations.length - 2)]!;
  const dtSec = Math.max(0.001, (last.timestampMs - previous.timestampMs) / 1000);
  const velocity = {
    x: (last.x - previous.x) / dtSec,
    y: (last.y - previous.y) / dtSec,
  };
  const speed = Math.hypot(velocity.x, velocity.y);

  // Body-occlusion mode: descriptors were computed from measured pose at
  // build time and travel WITH the candidate, so both linking passes (with
  // and without a contact anchor) see the same machine state.
  const bodyInfo = input.primary.bodyOcclusion as BallBodyOcclusionInfo | undefined;
  const bodyMode = bodyInfo?.endsIntoBody === true;
  // Robust pre-occlusion velocity for body-occlusion prediction: a single
  // mis-associated tail blob must not bend the search corridor.
  const preOcclusionVelocity = bodyMode ? (input.primary.terminalVelocity ?? velocity) : velocity;
  const preOcclusionSpeed = Math.hypot(preOcclusionVelocity.x, preOcclusionVelocity.y);

  const states: BallTimeline["states"] = [];
  const enteringFromMs = bodyMode ? bodyInfo!.enteringFromMs : null;
  if (enteringFromMs !== null && enteringFromMs > observations[0]!.timestampMs) {
    states.push({ state: "TRACKED", fromMs: observations[0]!.timestampMs, toMs: enteringFromMs });
    states.push({ state: "ENTERING_OCCLUSION", fromMs: enteringFromMs, toMs: last.timestampMs });
  } else if (enteringFromMs !== null) {
    states.push({
      state: "ENTERING_OCCLUSION",
      fromMs: observations[0]!.timestampMs,
      toMs: last.timestampMs,
    });
  } else {
    states.push({ state: "TRACKED", fromMs: observations[0]!.timestampMs, toMs: last.timestampMs });
  }

  // Nothing to bridge if the track already reaches (near) the window end.
  if (last.timestampMs >= input.windowEndMs - 120) {
    return {
      timeline: { states, bridge: [], reacquisition: { attempted: false } },
      outgoing: null,
    };
  }

  const contactInGap =
    input.contact !== null &&
    input.contact.tMs >= last.timestampMs - 60 &&
    input.contact.tMs <= last.timestampMs + 320;
  const searchStart = last.timestampMs;
  // Hard occlusion bound: body-occlusion predictions expire at
  // maxOcclusionMs; the legacy paths keep their exact 400ms windows.
  const searchEnd = contactInGap
    ? input.contact!.tMs + 400
    : bodyMode
      ? last.timestampMs + BALL_OCCLUSION.maxOcclusionMs
      : last.timestampMs + 400;

  const scoredCandidates: Array<{ candidate: BallTrackCandidate; score: number; detail: string }> =
    [];
  for (const candidate of input.candidates) {
    if (candidate.trackId === input.primary.trackId) continue;
    const first = candidate.observations[0]!;
    if (first.timestampMs <= searchStart || first.timestampMs > searchEnd) continue;
    const candidateVelocity = segmentVelocity(candidate);
    if (!candidateVelocity) continue;
    const candidateSpeed = Math.hypot(candidateVelocity.x, candidateVelocity.y);
    if (candidateSpeed < 0.25 || candidateSpeed > BALL_GATES2.maxSpeedNormPerSec) continue;

    if (contactInGap) {
      const contact = input.contact!;
      const startDistance = Math.hypot(first.x - contact.x, first.y - contact.y);
      if (startDistance > 0.14) continue;
      // Must move AWAY from the contact region.
      const away =
        (first.x - contact.x) * candidateVelocity.x + (first.y - contact.y) * candidateVelocity.y;
      const secondPoint = candidate.observations[1]!;
      const laterDistance = Math.hypot(secondPoint.x - contact.x, secondPoint.y - contact.y);
      if (away < 0 && laterDistance < startDistance) continue;
      scoredCandidates.push({
        candidate,
        score: 1 / (0.02 + startDistance),
        detail: `contact-aware: starts ${startDistance.toFixed(3)} from contact, speed ${candidateSpeed.toFixed(2)}`,
      });
    } else {
      const gapSec = (first.timestampMs - last.timestampMs) / 1000;
      const predicted = {
        x: last.x + velocity.x * gapSec,
        y: last.y + velocity.y * gapSec,
      };
      const corridorRadius = 0.05 + 0.6 * gapSec;
      const miss = Math.hypot(first.x - predicted.x, first.y - predicted.y);
      const directionCos =
        speed > 1e-6 && candidateSpeed > 1e-6
          ? (velocity.x * candidateVelocity.x + velocity.y * candidateVelocity.y) /
            (speed * candidateSpeed)
          : 0;
      const speedRatio = candidateSpeed / Math.max(0.05, speed);
      const corridorAccepts =
        miss <= corridorRadius &&
        directionCos >= Math.cos((55 * Math.PI) / 180) &&
        speedRatio >= 0.4 &&
        speedRatio <= 2.5;
      if (corridorAccepts) {
        scoredCandidates.push({
          candidate,
          score: 1 / (0.02 + miss),
          detail: `corridor: miss ${miss.toFixed(3)} of radius ${corridorRadius.toFixed(3)}, dirCos ${directionCos.toFixed(2)}`,
        });
        continue;
      }
      if (!bodyMode) continue;
      // Body-emergence path (only for a confirmed body-occlusion entry):
      // the segment must start where the ball vanished (near the body
      // region), inside a relaxed-but-capped corridor predicted from the
      // ROBUST pre-occlusion velocity, keeping direction and speed
      // compatible — and it must actually LEAVE the region. Body blobs
      // dwell there; a reacquired ball exits (measured decoy: rally2
      // #2838ms, dwell 0.67, exit 0 — grabbing it moved contact by 1.4s).
      // Time-bounded by searchEnd = maxOcclusionMs above.
      const startNearBody =
        candidate.bodyOcclusion?.startDistanceToBody != null &&
        candidate.bodyOcclusion.startDistanceToBody <= BALL_OCCLUSION.reacquireStartRadius;
      if (!startNearBody) continue;
      if (candidate.bodyDwellFraction > BALL_GATES2.maxBodyDwellFraction) continue;
      const exitsRegion =
        candidate.bodyOcclusion!.endDistanceToBody != null &&
        candidate.bodyOcclusion!.endDistanceToBody >=
          candidate.bodyOcclusion!.startDistanceToBody! + 0.02;
      if (!exitsRegion) continue;
      const predictedBody = {
        x: last.x + preOcclusionVelocity.x * gapSec,
        y: last.y + preOcclusionVelocity.y * gapSec,
      };
      const bodyRadius = Math.min(
        BALL_OCCLUSION.bodyEmergenceRadiusCap,
        0.05 + BALL_OCCLUSION.bodyEmergenceRadiusGrowthPerSec * gapSec,
      );
      const bodyMiss = Math.hypot(first.x - predictedBody.x, first.y - predictedBody.y);
      if (bodyMiss > bodyRadius) continue;
      const bodyDirectionCos =
        preOcclusionSpeed > 1e-6 && candidateSpeed > 1e-6
          ? (preOcclusionVelocity.x * candidateVelocity.x +
              preOcclusionVelocity.y * candidateVelocity.y) /
            (preOcclusionSpeed * candidateSpeed)
          : 0;
      if (bodyDirectionCos < Math.cos((55 * Math.PI) / 180)) continue;
      const bodySpeedRatio = candidateSpeed / Math.max(0.05, preOcclusionSpeed);
      if (bodySpeedRatio < 0.4 || bodySpeedRatio > 2.5) continue;
      scoredCandidates.push({
        candidate,
        score: 1 / (0.02 + bodyMiss),
        detail:
          `body-emergence: starts ${candidate.bodyOcclusion!.startDistanceToBody!.toFixed(3)} from body region, ` +
          `miss ${bodyMiss.toFixed(3)} of relaxed radius ${bodyRadius.toFixed(3)}, dirCos ${bodyDirectionCos.toFixed(2)}`,
      });
    }
  }

  // Failure states: for a body occlusion the machine names the bounded
  // OCCLUDED span it searched (predictions expired, nothing fabricated)
  // before going LOST; legacy (non-body) failures keep their exact shape.
  const pushFailureStates = (): void => {
    if (bodyMode) {
      const occludedEnd = Math.min(searchEnd, last.timestampMs + BALL_OCCLUSION.maxOcclusionMs);
      states.push({ state: "OCCLUDED", fromMs: last.timestampMs, toMs: occludedEnd });
      states.push({
        state: "LOST",
        fromMs: occludedEnd,
        toMs: Math.max(occludedEnd, input.windowEndMs),
      });
    } else {
      states.push({ state: "LOST", fromMs: last.timestampMs, toMs: searchEnd });
    }
  };

  if (scoredCandidates.length === 0) {
    pushFailureStates();
    return {
      timeline: {
        states,
        bridge: [],
        reacquisition: {
          attempted: true,
          result: "FAILED_NO_CANDIDATE",
          detail: contactInGap
            ? "no plausible outgoing segment near the contact region"
            : bodyMode
              ? `body occlusion: no compatible segment emerged within ${BALL_OCCLUSION.maxOcclusionMs}ms (staying LOST beats grabbing a decoy)`
              : "no segment inside the trajectory corridor",
          contactAware: contactInGap,
          bodyOcclusion: bodyMode,
        },
      },
      outgoing: null,
    };
  }
  scoredCandidates.sort((a, b) => b.score - a.score);
  if (
    scoredCandidates.length > 1 &&
    scoredCandidates[0]!.score / scoredCandidates[1]!.score < 1.4
  ) {
    pushFailureStates();
    return {
      timeline: {
        states,
        bridge: [],
        reacquisition: {
          attempted: true,
          result: "FAILED_AMBIGUOUS",
          detail: `${scoredCandidates.length} comparable outgoing candidates; staying LOST beats guessing`,
          contactAware: contactInGap,
          bodyOcclusion: bodyMode,
        },
      },
      outgoing: null,
    };
  }

  const winner = scoredCandidates[0]!;
  const outgoingFirst = winner.candidate.observations[0]!;
  // Materialize the bridge: linear corridor between last observed and the
  // reacquired start (contact-aware bridges bend at the contact point).
  const bridge: BallTimeline["bridge"] = [];
  const step = 33;
  const anchor = contactInGap
    ? { t: input.contact!.tMs, x: input.contact!.x, y: input.contact!.y }
    : null;
  for (let t = last.timestampMs + step; t < outgoingFirst.timestampMs; t += step) {
    let x: number;
    let y: number;
    if (anchor && t <= anchor.t) {
      const alpha = (t - last.timestampMs) / Math.max(1, anchor.t - last.timestampMs);
      x = last.x + (anchor.x - last.x) * alpha;
      y = last.y + (anchor.y - last.y) * alpha;
    } else if (anchor) {
      const alpha = (t - anchor.t) / Math.max(1, outgoingFirst.timestampMs - anchor.t);
      x = anchor.x + (outgoingFirst.x - anchor.x) * alpha;
      y = anchor.y + (outgoingFirst.y - anchor.y) * alpha;
    } else {
      const alpha =
        (t - last.timestampMs) / Math.max(1, outgoingFirst.timestampMs - last.timestampMs);
      x = last.x + (outgoingFirst.x - last.x) * alpha;
      y = last.y + (outgoingFirst.y - last.y) * alpha;
    }
    bridge.push({ t, x, y, predicted: true });
  }
  states.push({
    state: "OCCLUDED",
    fromMs: last.timestampMs,
    toMs: outgoingFirst.timestampMs,
  });
  const outgoingLast = winner.candidate.observations[winner.candidate.observations.length - 1]!;
  states.push({
    state: "REACQUIRED",
    fromMs: outgoingFirst.timestampMs,
    toMs: outgoingLast.timestampMs,
  });
  return {
    timeline: {
      states,
      bridge,
      reacquisition: {
        attempted: true,
        result: "SUCCESS",
        detail: winner.detail,
        contactAware: contactInGap,
        bodyOcclusion: bodyMode,
      },
    },
    outgoing: winner.candidate,
  };
}

function segmentVelocity(candidate: BallTrackCandidate): { x: number; y: number } | null {
  const observations = candidate.observations;
  if (observations.length < 2) return null;
  const first = observations[0]!;
  const second = observations[Math.min(observations.length - 1, 2)]!;
  const dtSec = (second.timestampMs - first.timestampMs) / 1000;
  if (dtSec <= 0) return null;
  return { x: (second.x - first.x) / dtSec, y: (second.y - first.y) / dtSec };
}

export function selectPrimaryBallTrack(
  gated: BallTrackCandidate[],
  ablation: BallAblation,
  window: { startMs: number; endMs: number },
  options: {
    paddleTrackExists: boolean;
    fragments?: readonly BallTrackCandidate[];
    contact?: { tMs: number; x: number; y: number } | null;
  } = { paddleTrackExists: false },
): BallTrackingOutcome {
  const eligible = gated.filter(
    (candidate) =>
      candidate.windowOverlapMs >= BALL_GATES2.minWindowOverlapMs &&
      candidate.medianSpeed >= BALL_GATES2.minPrimaryMedianSpeed &&
      candidate.bodyDwellFraction <= BALL_GATES2.maxBodyDwellFraction &&
      // When a paddle track exists, a primary ball claim must have actually
      // approached it. null = never time-aligned with the paddle — with a
      // paddle present that is disqualifying, not a free pass (learned from
      // failure BALL_FALSE_POSITIVE_BACKGROUND-wm-dink-01).
      (candidate.minPaddleDistance !== null
        ? candidate.minPaddleDistance <= BALL_GATES2.maxPrimaryPaddleDistance
        : !options.paddleTrackExists),
  );
  // ── Body-occlusion PRIMARY fallback ──────────────────────────────────────
  // Only consulted when NO paddle-aligned candidate exists (so it can never
  // change a selection that works today). The paddle-proximity gate exists
  // to reject background balls that never interact with the player — but a
  // track that terminates by flying INTO the target's body region IS the
  // player interaction (the paddle lives there; measured failure:
  // afn-sasebo-rally2 overhead, incoming lob dies at the body edge and the
  // stage went UNTRACKED). The paddle TIME-alignment requirement stays: a
  // track never co-observed with an existing paddle track remains out (the
  // wm-dink-01 lesson), and extra gates keep drift/limb artifacts out.
  let selection: "paddle_aligned" | "body_occlusion" = "paddle_aligned";
  let pool = eligible;
  if (eligible.length === 0) {
    const occlusionEligible = gated.filter(
      (candidate) =>
        candidate.windowOverlapMs >= BALL_GATES2.minWindowOverlapMs &&
        candidate.medianSpeed >= BALL_GATES2.minPrimaryMedianSpeed &&
        candidate.bodyDwellFraction <= BALL_GATES2.maxBodyDwellFraction &&
        candidate.observations.length >= BALL_OCCLUSION.minPrimaryObservations &&
        candidate.straightness >= BALL_OCCLUSION.minPrimaryStraightness &&
        candidate.bodyOcclusion?.endsIntoBody === true &&
        // A death at the window edge is not evidence of occlusion.
        candidate.observations[candidate.observations.length - 1]!.timestampMs <=
          window.endMs - BALL_OCCLUSION.windowEndMarginMs &&
        (candidate.minPaddleDistance !== null || !options.paddleTrackExists),
    );
    if (occlusionEligible.length > 0) {
      selection = "body_occlusion";
      pool = occlusionEligible;
    }
  }
  if (pool.length === 0) {
    return {
      status: "untracked",
      reason:
        gated.length === 0
          ? "no_track_survived_physics_and_context_gates"
          : "no_gated_track_is_a_plausible_in-play_ball (window overlap, speed, paddle proximity)",
      gatedTracks: gated,
      ablation,
    };
  }
  const scored = pool
    .map((candidate) => {
      const paddleAffinity =
        candidate.minPaddleDistance === null
          ? 0.6
          : Math.max(0.2, Math.min(1, 1.2 - 3 * candidate.minPaddleDistance));
      const lengthFactor = Math.min(1, candidate.observations.length / 12);
      const speedFactor = Math.min(1, candidate.medianSpeed / 0.8);
      // Balls TRAVEL and only touch the paddle momentarily; limb/paddle
      // artifacts oscillate in place and live on the paddle.
      const travelFactor = Math.max(0.15, candidate.straightness);
      const paddleDwellPenalty = 1 - 0.8 * candidate.nearPaddleFraction;
      return {
        candidate,
        score:
          Math.min(1.5, candidate.windowOverlapMs / 1000) *
          lengthFactor *
          paddleAffinity *
          speedFactor *
          travelFactor *
          paddleDwellPenalty,
      };
    })
    .sort((a, b) => b.score - a.score);
  // A body-occlusion primary is a fallback claim: two comparable candidates
  // mean the claim is not defensible — staying untracked beats guessing.
  if (
    selection === "body_occlusion" &&
    scored.length > 1 &&
    scored[0]!.score / Math.max(1e-9, scored[1]!.score) < BALL_OCCLUSION.primaryScoreMargin
  ) {
    return {
      status: "untracked",
      reason:
        "body_occlusion_primary_ambiguous (multiple comparable tracks end into the target body region)",
      gatedTracks: gated,
      ablation,
    };
  }
  const best = scored[0]!.candidate;

  // ── Occlusion bridging + reacquisition ──────────────────────────────────
  const { timeline, outgoing } = linkBallTimeline({
    primary: best,
    candidates: [...gated, ...(options.fragments ?? [])],
    contact: options.contact ?? null,
    windowEndMs: window.endMs,
  });
  const observedAll = outgoing
    ? [...best.observations, ...outgoing.observations]
    : best.observations;
  const labCombined: BallTrackCandidate = outgoing ? { ...best, observations: observedAll } : best;

  const windowLength = Math.max(1, window.endMs - window.startMs);
  const track: BallTrack = {
    schemaVersion: 1,
    coordinateSystem: "normalized_image_top_left",
    producedBy: {
      providerId: "ball.motion-diff-tracker",
      modelVersion: `ball-diff-candidates-1+${BALL_TRACKER_VERSION}`,
      runtime: "deterministic",
      executionTarget: "server",
      artifactHash: null,
    },
    // Observed points only, both segments; the occlusion gap stays a gap.
    observations: observedAll.map((observation, index): BallObservation => ({
      frameIndex: index,
      timestampMs: Math.round(observation.timestampMs),
      x: observation.x,
      y: observation.y,
      confidence: observation.confidence,
    })),
    contact: null,
    bounce: null,
    continuity: Math.min(1, best.windowOverlapMs / windowLength),
  };
  return {
    status: "tracked",
    track,
    lab: labCombined,
    gatedTracks: gated,
    ablation,
    timeline,
    selection,
  };
}

/** Ball speed series (normalized/s) from the selected track, gap-aware. */
export function ballSpeedSeries(
  observations: readonly BallTrackObservation[],
): Array<{ timestampMs: number; value: number }> {
  const series: Array<{ timestampMs: number; value: number }> = [];
  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1]!;
    const current = observations[index]!;
    const dtSec = (current.timestampMs - previous.timestampMs) / 1000;
    if (dtSec <= 0 || dtSec > 0.15) continue;
    series.push({
      timestampMs: current.timestampMs,
      value: Math.hypot(current.x - previous.x, current.y - previous.y) / dtSec,
    });
  }
  return series;
}

function appendBallObservation(
  track: ActiveBallTrack,
  timestampMs: number,
  candidate: BallCandidate,
  chronicAt: (x: number, y: number) => number,
): void {
  const previous = track.observations[track.observations.length - 1];
  if (previous) {
    const dtSec = (timestampMs - previous.timestampMs) / 1000;
    if (dtSec > 0) {
      const vx = (candidate.x - previous.x) / dtSec;
      const vy = (candidate.y - previous.y) / dtSec;
      track.velocity = {
        x: 0.5 * track.velocity.x + 0.5 * vx,
        y: 0.5 * track.velocity.y + 0.5 * vy,
      };
      track.lastStep = Math.hypot(candidate.x - previous.x, candidate.y - previous.y);
    }
  }
  const chronicActivity = chronicAt(candidate.x, candidate.y);
  track.observations.push({
    timestampMs,
    x: candidate.x,
    y: candidate.y,
    areaPx: candidate.areaPx,
    elong: candidate.elong,
    chronicActivity,
    confidence: 0, // finalized in describeTrack once context is known
  });
  track.lastMs = timestampMs;
}

/** Per-track fraction of steps whose velocity matches ≥coherenceMinPeers
 * OTHER concurrent tracks (same frame timestamp, similar direction and
 * speed). Camera pans move the whole scene in lockstep; a real ball is a
 * velocity outlier against that field. */
function computeCoherentMotionFractions(tracks: readonly ActiveBallTrack[]): Map<number, number> {
  interface Step {
    trackId: number;
    key: number;
    vx: number;
    vy: number;
    speed: number;
  }
  const stepsByTime = new Map<number, Step[]>();
  const trackSteps = new Map<number, Step[]>();
  for (const track of tracks) {
    const own: Step[] = [];
    for (let index = 1; index < track.observations.length; index += 1) {
      const previous = track.observations[index - 1]!;
      const current = track.observations[index]!;
      const dtSec = (current.timestampMs - previous.timestampMs) / 1000;
      if (dtSec <= 0 || dtSec > 0.15) continue;
      const vx = (current.x - previous.x) / dtSec;
      const vy = (current.y - previous.y) / dtSec;
      const key = Math.round(current.timestampMs);
      const step: Step = { trackId: track.trackId, key, vx, vy, speed: Math.hypot(vx, vy) };
      own.push(step);
      const bucket = stepsByTime.get(key);
      if (bucket) bucket.push(step);
      else stepsByTime.set(key, [step]);
    }
    trackSteps.set(track.trackId, own);
  }
  const cosLimit = Math.cos((BALL_GATES2.coherenceAngleDeg * Math.PI) / 180);
  const fractions = new Map<number, number>();
  for (const track of tracks) {
    const own = trackSteps.get(track.trackId) ?? [];
    let coherent = 0;
    for (const step of own) {
      if (step.speed < BALL_GATES2.coherenceMinSpeedNormPerSec) continue;
      const peersInFrame = stepsByTime.get(step.key) ?? [];
      let peers = 0;
      for (const other of peersInFrame) {
        if (other.trackId === step.trackId) continue;
        if (other.speed < BALL_GATES2.coherenceMinSpeedNormPerSec) continue;
        const ratio =
          Math.max(other.speed, step.speed) / Math.max(1e-6, Math.min(other.speed, step.speed));
        if (ratio > BALL_GATES2.coherenceSpeedRatioMax) continue;
        const cos = (step.vx * other.vx + step.vy * other.vy) / (step.speed * other.speed);
        if (cos < cosLimit) continue;
        peers += 1;
        if (peers >= BALL_GATES2.coherenceMinPeers) break;
      }
      if (peers >= BALL_GATES2.coherenceMinPeers) coherent += 1;
    }
    fractions.set(track.trackId, own.length === 0 ? 0 : coherent / own.length);
  }
  return fractions;
}

function describeTrack(
  track: ActiveBallTrack,
  window: { startMs: number; endMs: number },
  paddle: readonly TrackedPaddleObservation[] | null,
  band: { top: number; bottom: number },
  chronicAt: (x: number, y: number) => number,
  joints: JointSeries,
  coherentMotionFraction = 0,
): BallTrackCandidate {
  const observations = track.observations;
  const speeds: number[] = [];
  let jerky = 0;
  let turns = 0;
  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1]!;
    const current = observations[index]!;
    const dtSec = (current.timestampMs - previous.timestampMs) / 1000;
    if (dtSec <= 0 || dtSec > 0.15) continue;
    speeds.push(Math.hypot(current.x - previous.x, current.y - previous.y) / dtSec);
    if (index >= 2) {
      const before = observations[index - 2]!;
      const v1 = { x: previous.x - before.x, y: previous.y - before.y };
      const v2 = { x: current.x - previous.x, y: current.y - previous.y };
      const m1 = Math.hypot(v1.x, v1.y);
      const m2 = Math.hypot(v2.x, v2.y);
      if (m1 > BALL_GATES2.jerkyMinStepNorm && m2 > BALL_GATES2.jerkyMinStepNorm) {
        turns += 1;
        const cos = Math.min(1, Math.max(-1, (v1.x * v2.x + v1.y * v2.y) / (m1 * m2)));
        if ((Math.acos(cos) * 180) / Math.PI > BALL_GATES2.jerkyTurnDeg) jerky += 1;
      }
    }
  }
  const sortedSpeeds = [...speeds].sort((a, b) => a - b);
  const areas = observations.map((observation) => observation.areaPx).sort((a, b) => a - b);
  const chronicFraction =
    observations.filter(
      (observation) => observation.chronicActivity > BALL_GATES2.chronicCellThreshold,
    ).length / observations.length;
  const inBandFraction =
    observations.filter((observation) => observation.y >= band.top && observation.y <= band.bottom)
      .length / observations.length;

  const overlapStart = Math.max(window.startMs, observations[0]!.timestampMs);
  const overlapEnd = Math.min(window.endMs, observations[observations.length - 1]!.timestampMs);
  let minPaddleDistance: number | null = null;
  let nearPaddleCount = 0;
  let paddleComparisons = 0;
  if (paddle && paddle.length > 0) {
    for (const observation of observations) {
      const nearest = paddle.reduce((best, entry) =>
        Math.abs(entry.timestampMs - observation.timestampMs) <
        Math.abs(best.timestampMs - observation.timestampMs)
          ? entry
          : best,
      );
      if (Math.abs(nearest.timestampMs - observation.timestampMs) > 60) continue;
      const distance = Math.hypot(
        nearest.center.x - observation.x,
        nearest.center.y - observation.y,
      );
      paddleComparisons += 1;
      if (distance < BALL_GATES2.nearPaddleRadius) nearPaddleCount += 1;
      if (minPaddleDistance === null || distance < minPaddleDistance) {
        minPaddleDistance = distance;
      }
    }
  }
  let pathLength = 0;
  for (let index = 1; index < observations.length; index += 1) {
    pathLength += Math.hypot(
      observations[index]!.x - observations[index - 1]!.x,
      observations[index]!.y - observations[index - 1]!.y,
    );
  }
  const netDisplacement = Math.hypot(
    observations[observations.length - 1]!.x - observations[0]!.x,
    observations[observations.length - 1]!.y - observations[0]!.y,
  );
  let bodyDwellCount = 0;
  for (const observation of observations) {
    const frameJoints = nearestJoints(joints, observation.timestampMs);
    if (!frameJoints) continue;
    const onBody = frameJoints.some(
      (joint) =>
        Math.hypot(joint.x - observation.x, joint.y - observation.y) <= BALL_GATES2.bodyRadius,
    );
    if (onBody) bodyDwellCount += 1;
  }

  // Heuristic per-observation confidence (uncalibrated, labeled).
  const smoothFactor = turns > 0 ? 1 - jerky / turns : 0.6;
  for (const observation of observations) {
    const sizeFit = observation.areaPx <= BALL_GATES2.maxMedianAreaPx ? 1 : 0.5;
    observation.confidence = Math.max(
      0.05,
      Math.min(
        0.9,
        0.35 +
          0.2 * (1 - chronicAt(observation.x, observation.y)) +
          0.2 * smoothFactor +
          0.15 * sizeFit,
      ),
    );
  }

  // Body-occlusion descriptors: terminal/initial relationship of this track
  // to the target's measured body region (see BallBodyOcclusionInfo).
  const terminalVelocity = medianStepVelocity(observations, 5, "tail");
  const initialVelocity = medianStepVelocity(observations, 5, "head");
  const firstObs = observations[0]!;
  const lastObs = observations[observations.length - 1]!;
  const endBox = bodyBoxAt(joints, lastObs.timestampMs, BALL_GATES2.bodyRadius);
  const startBox = bodyBoxAt(joints, firstObs.timestampMs, BALL_GATES2.bodyRadius);
  const endDistanceToBody = endBox ? distanceToBox(lastObs, endBox) : null;
  const startDistanceToBody = startBox ? distanceToBox(firstObs, startBox) : null;
  const endSpeedNormPerSec = terminalVelocity
    ? Math.hypot(terminalVelocity.x, terminalVelocity.y)
    : 0;
  let headingIntoBodyCos: number | null = null;
  if (endBox && terminalVelocity && endDistanceToBody !== null) {
    if (endDistanceToBody === 0) {
      headingIntoBodyCos = 1; // already inside the region
    } else if (endSpeedNormPerSec > 1e-6) {
      const nearest = nearestPointOnBox(lastObs, endBox);
      const direction = { x: nearest.x - lastObs.x, y: nearest.y - lastObs.y };
      const magnitude = Math.hypot(direction.x, direction.y);
      headingIntoBodyCos =
        magnitude > 1e-6
          ? (terminalVelocity.x * direction.x + terminalVelocity.y * direction.y) /
            (magnitude * endSpeedNormPerSec)
          : 1;
    }
  }
  const endsIntoBody =
    endDistanceToBody !== null &&
    endDistanceToBody <= BALL_OCCLUSION.enterDistance &&
    endSpeedNormPerSec >= BALL_OCCLUSION.minEntrySpeedNormPerSec &&
    (headingIntoBodyCos ?? 0) >= BALL_OCCLUSION.headingMinCos;
  let enteringFromMs: number | null = null;
  if (endsIntoBody) {
    // Walk back through the terminal approach: consecutive observations
    // inside the entry zone define the ENTERING_OCCLUSION span.
    enteringFromMs = lastObs.timestampMs;
    for (let index = observations.length - 1; index >= 0; index -= 1) {
      const observation = observations[index]!;
      const box = bodyBoxAt(joints, observation.timestampMs, BALL_GATES2.bodyRadius);
      if (!box || distanceToBox(observation, box) > BALL_OCCLUSION.enterDistance) break;
      enteringFromMs = observation.timestampMs;
    }
  }

  return {
    trackId: track.trackId,
    observations,
    medianSpeed: sortedSpeeds[Math.floor(sortedSpeeds.length / 2)] ?? 0,
    maxSpeed: sortedSpeeds[sortedSpeeds.length - 1] ?? 0,
    jerkyFraction: turns > 0 ? jerky / turns : 0,
    chronicFraction,
    inBandFraction,
    medianArea: areas[Math.floor(areas.length / 2)] ?? 0,
    windowOverlapMs: Math.max(0, overlapEnd - overlapStart),
    minPaddleDistance,
    nearPaddleFraction: paddleComparisons > 0 ? nearPaddleCount / paddleComparisons : 0,
    straightness: pathLength > 1e-6 ? netDisplacement / pathLength : 0,
    coherentMotionFraction,
    bodyDwellFraction: bodyDwellCount / observations.length,
    terminalVelocity,
    initialVelocity,
    bodyOcclusion: {
      endDistanceToBody,
      startDistanceToBody,
      headingIntoBodyCos,
      endSpeedNormPerSec,
      endsIntoBody,
      enteringFromMs,
    },
  };
}

/** Component-wise MEDIAN of per-step velocities over the first/last `take`
 * steps — robust to a single mis-associated blob at either end. */
function medianStepVelocity(
  observations: readonly BallTrackObservation[],
  take: number,
  from: "head" | "tail",
): { x: number; y: number } | null {
  const steps: Array<{ x: number; y: number }> = [];
  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1]!;
    const current = observations[index]!;
    const dtSec = (current.timestampMs - previous.timestampMs) / 1000;
    if (dtSec <= 0 || dtSec > 0.15) continue;
    steps.push({ x: (current.x - previous.x) / dtSec, y: (current.y - previous.y) / dtSec });
  }
  if (steps.length === 0) return null;
  const window = from === "tail" ? steps.slice(-take) : steps.slice(0, take);
  const xs = window.map((step) => step.x).sort((a, b) => a - b);
  const ys = window.map((step) => step.y).sort((a, b) => a - b);
  return { x: xs[Math.floor(xs.length / 2)]!, y: ys[Math.floor(ys.length / 2)]! };
}

interface BodyBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Target body region at a timestamp: bounding box of visible joints padded
 * by bodyRadius (same measured joints the body-dwell gate uses). */
function bodyBoxAt(joints: JointSeries, timestampMs: number, pad: number): BodyBox | null {
  const points = nearestJoints(joints, timestampMs);
  if (!points || points.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
}

function nearestPointOnBox(
  point: { x: number; y: number },
  box: BodyBox,
): { x: number; y: number } {
  return {
    x: Math.min(box.maxX, Math.max(box.minX, point.x)),
    y: Math.min(box.maxY, Math.max(box.minY, point.y)),
  };
}

/** Distance from a point to the box (0 when inside). */
function distanceToBox(point: { x: number; y: number }, box: BodyBox): number {
  const nearest = nearestPointOnBox(point, box);
  return Math.hypot(point.x - nearest.x, point.y - nearest.y);
}

type JointSeries = Array<{ timestampMs: number; points: Array<{ x: number; y: number }> }>;

function jointSeries(frames: ReturnType<typeof toLegacyPoseFrames>): JointSeries {
  return frames.map((frame) => ({
    timestampMs: frame.timestampMs,
    points: frame.landmarks
      .filter((mark) => mark.visibility >= 0.25)
      .map((mark) => ({ x: mark.x, y: mark.y })),
  }));
}

function nearestJoints(
  joints: JointSeries,
  timestampMs: number,
): Array<{ x: number; y: number }> | null {
  let best: JointSeries[number] | null = null;
  let bestDelta = Infinity;
  for (const entry of joints) {
    const delta = Math.abs(entry.timestampMs - timestampMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = entry;
    }
  }
  return best && bestDelta <= 60 && best.points.length > 0 ? best.points : null;
}

/** Vertical play band from measured pose: above heads to below ankles. */
function playBand(frames: ReturnType<typeof toLegacyPoseFrames>): { top: number; bottom: number } {
  let minHead = 1;
  let maxAnkle = 0;
  for (const frame of frames) {
    for (const mark of frame.landmarks) {
      if (mark.visibility < 0.3) continue;
      if (mark.name === "head") minHead = Math.min(minHead, mark.y);
      if (mark.name.endsWith("ankle")) maxAnkle = Math.max(maxAnkle, mark.y);
    }
  }
  if (minHead >= maxAnkle) return { top: 0, bottom: 1 }; // no usable pose: no band gate
  return {
    top: Math.max(0, minHead - BALL_GATES2.bandPadTop),
    bottom: Math.min(1, maxAnkle + BALL_GATES2.bandPadBottom),
  };
}
