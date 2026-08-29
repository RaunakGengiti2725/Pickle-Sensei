import {
  measured,
  unavailable,
  type BallObservation,
  type BallTrack,
  type ModalityRecord,
} from "@pickle/swing-domain";

/**
 * Apple Vision trajectory candidates → an honest ball modality.
 *
 * VNDetectTrajectoriesRequest assumes a mostly stationary camera and fires on
 * ANY parabolic mover, so real-world extractions contain hundreds of false
 * trajectories from hands, paddles, shadows, and camera motion. This module
 * decides whether the candidates support a genuine ball track for the stroke
 * window — and says "unavailable" with a measured reason when they do not.
 *
 * Gates (all computed, none guessed):
 * 1. Scene noise: too many trajectories per second means the stationary-
 *    camera assumption is broken; nothing can be trusted.
 * 2. Window support: the best candidate must overlap enough of the stroke
 *    window with enough points to be a track rather than a blip.
 */

export const BALL_CANDIDATE_GATE_VERSION = "ball-candidate-gate-1";

export interface TrajectoryFile {
  source: string;
  cameraAssumption: string;
  pointTiming: string;
  trajectories: Array<{
    id: string;
    startMs: number;
    endMs: number;
    confidence: number;
    points: Array<{ t: number; x: number; y: number }>;
  }>;
}

export interface BallCandidateDiagnostics {
  trajectoryCount: number;
  trajectoriesPerSecond: number;
  windowCandidates: number;
  chosenId: string | null;
  chosenCoverage: number;
  chosenPoints: number;
}

export const BALL_GATES = {
  /** Above this rate the scene/camera is moving; candidates are noise. */
  maxTrajectoriesPerSecond: 12,
  minWindowCoverage: 0.35,
  minPoints: 6,
  minConfidence: 0.5,
  windowPadMs: 250,
} as const;

export function resolveBallModality(input: {
  file: TrajectoryFile;
  window: { startMs: number; endMs: number };
  videoDurationMs: number;
}): { modality: ModalityRecord<BallTrack>; diagnostics: BallCandidateDiagnostics } {
  const { file, window } = input;
  const durationSeconds = Math.max(0.001, input.videoDurationMs / 1000);
  const perSecond = file.trajectories.length / durationSeconds;
  const baseDiagnostics = {
    trajectoryCount: file.trajectories.length,
    trajectoriesPerSecond: perSecond,
    windowCandidates: 0,
    chosenId: null as string | null,
    chosenCoverage: 0,
    chosenPoints: 0,
  };

  if (file.trajectories.length === 0) {
    return {
      modality: unavailable("no_trajectories_detected"),
      diagnostics: baseDiagnostics,
    };
  }
  if (perSecond > BALL_GATES.maxTrajectoriesPerSecond) {
    return {
      modality: unavailable(
        `trajectory_noise_scene_or_camera_motion (${perSecond.toFixed(1)}/s > ${BALL_GATES.maxTrajectoriesPerSecond}/s)`,
      ),
      diagnostics: baseDiagnostics,
    };
  }

  const lo = window.startMs - BALL_GATES.windowPadMs;
  const hi = window.endMs + BALL_GATES.windowPadMs;
  const windowLength = Math.max(1, window.endMs - window.startMs);
  const candidates = file.trajectories
    .filter((trajectory) => trajectory.confidence >= BALL_GATES.minConfidence)
    .map((trajectory) => {
      const points = trajectory.points.filter((point) => point.t >= lo && point.t <= hi);
      const overlap =
        Math.min(trajectory.endMs, hi) - Math.max(trajectory.startMs, lo);
      return { trajectory, points, coverage: Math.max(0, overlap) / windowLength };
    })
    .filter((candidate) => candidate.points.length > 0);

  baseDiagnostics.windowCandidates = candidates.length;
  if (candidates.length === 0) {
    return {
      modality: unavailable("no_trajectory_overlaps_stroke_window"),
      diagnostics: baseDiagnostics,
    };
  }

  const best = candidates.reduce((leader, candidate) =>
    candidate.coverage * candidate.trajectory.confidence >
    leader.coverage * leader.trajectory.confidence
      ? candidate
      : leader,
  );
  baseDiagnostics.chosenId = best.trajectory.id;
  baseDiagnostics.chosenCoverage = best.coverage;
  baseDiagnostics.chosenPoints = best.points.length;

  if (best.coverage < BALL_GATES.minWindowCoverage || best.points.length < BALL_GATES.minPoints) {
    return {
      modality: unavailable(
        `trajectory_support_insufficient (coverage ${(best.coverage * 100).toFixed(0)}%, points ${best.points.length})`,
      ),
      diagnostics: baseDiagnostics,
    };
  }

  const observations: BallObservation[] = best.points.map((point, index) => ({
    frameIndex: index,
    timestampMs: point.t,
    x: point.x,
    y: point.y,
    confidence: best.trajectory.confidence,
  }));
  const track: BallTrack = {
    schemaVersion: 1,
    coordinateSystem: "normalized_image_top_left",
    producedBy: {
      providerId: "ball.apple-vision-trajectories",
      modelVersion: file.source,
      runtime: "vision_framework",
      executionTarget: "on_device",
      artifactHash: null,
    },
    observations,
    contact: null,
    bounce: null,
    continuity: Math.min(1, best.coverage),
  };
  return { modality: measured(track), diagnostics: baseDiagnostics };
}

/** All in-window points from all confident trajectories, for evidence use. */
export function windowBallObservations(
  file: TrajectoryFile,
  window: { startMs: number; endMs: number },
): BallObservation[] {
  const lo = window.startMs - BALL_GATES.windowPadMs;
  const hi = window.endMs + BALL_GATES.windowPadMs;
  const observations: BallObservation[] = [];
  for (const trajectory of file.trajectories) {
    if (trajectory.confidence < BALL_GATES.minConfidence) continue;
    for (const point of trajectory.points) {
      if (point.t < lo || point.t > hi) continue;
      observations.push({
        frameIndex: observations.length,
        timestampMs: point.t,
        x: point.x,
        y: point.y,
        confidence: trajectory.confidence,
      });
    }
  }
  return observations.sort((a, b) => a.timestampMs - b.timestampMs);
}
