import type { CapturedClip, CaptureEvidenceV1 } from '../src/camera/capture';
import type { PendingCapture, RealAnalysisFact } from '../src/data/repository';
import type { TrainingActivityInput } from '../src/consistency/engine';
import { FIXED_INSTANTS } from './matrix';

/**
 * Deterministic inputs for every probe run. The instants deliberately sit
 * near UTC midnight so that a local-day bucket differs between zones — that
 * is the whole point of replaying under many zones.
 */

/** Instants spanning a fortnight before `asOf`, clustered around 23:30Z /
 * 00:20Z so every zone east or west of UTC buckets some of them differently. */
export const CAPTURE_INSTANTS: readonly string[] = [
  '2026-08-22T23:30:00.000Z',
  '2026-08-23T00:20:00.000Z',
  '2026-08-25T10:00:00.000Z',
  '2026-08-26T23:45:00.000Z',
  '2026-08-27T00:10:00.000Z',
  '2026-08-29T18:00:00.000Z',
  '2026-08-30T23:59:00.000Z',
  '2026-08-31T00:01:00.000Z',
  '2026-09-01T12:00:00.000Z',
  '2026-09-02T23:30:00.000Z',
  '2026-09-03T00:20:00.000Z',
  '2026-09-03T21:00:00.000Z',
  FIXED_INSTANTS.lateEvening,
  FIXED_INSTANTS.justAfterUtcMidnight,
];

const SHOT_TYPES = ['dink', 'third_shot_drop', 'drive', 'serve'] as const;

export function analysisFacts(): RealAnalysisFact[] {
  return CAPTURE_INSTANTS.map((capturedAt, index) => ({
    id: `fact-${index + 1}`,
    shotType: SHOT_TYPES[index % SHOT_TYPES.length]!,
    capturedAt,
    // Scores walk 5.0 → 8.9 in tenths so every mean/delta has a fraction.
    overallScore: Math.round((5 + ((index * 0.3) % 4)) * 10) / 10,
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'model-2',
    shotConfigVersion: 'config-1',
    sessionId: index % 3 === 0 ? `session-${index}` : null,
    priorityCheckpoint: null,
    checkpointScores: {},
  }));
}

export function trainingActivities(): TrainingActivityInput[] {
  return CAPTURE_INSTANTS.map((atIso, index) => ({
    kind: index % 4 === 3 ? 'drill' : 'stroke',
    atIso,
    shotType:
      index % 4 === 3 ? undefined : SHOT_TYPES[index % SHOT_TYPES.length],
    overallScore: index % 4 === 3 ? null : 6 + (index % 4),
    resultKind: index % 4 === 3 ? undefined : 'scored',
    label: index % 4 === 3 ? 'Kitchen-line dink ladder' : undefined,
  }));
}

type AutomaticClip = Extract<
  CapturedClip,
  { captureMode: 'automatic_pose_trigger' }
>;

function pendingCapture(id: string, capturedAtIso: string): PendingCapture {
  const evidence: CaptureEvidenceV1 = {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'apple_vision_body_pose',
    poseModelVersion: 'apple-vision-bodypose-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    poseFrameCount: 4,
    poseMissingFrameCount: 1,
    trackedDurationMs: 300,
    meanCanonicalJointVisibility: 0.8,
    meanJointCoverage: 0.75,
    minimumJointCoverage: 0.6,
    fullBodyVisibleFrameCount: 2,
    jointMotion: [
      {
        joint: 'right_wrist',
        sampleCount: 2,
        meanNormalizedPerSecond: 0.8,
        peakNormalizedPerSecond: 1.2,
      },
    ],
    analysisInputFrameCount: 5,
  };
  const uri = `file:///captures/${id}.mov`;
  const clip: AutomaticClip = {
    uri,
    capturedAtIso,
    durationMs: 3_000,
    fps: 60,
    width: 1_080,
    height: 1_920,
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 1_000,
      endMs: 1_800,
      peakMotionMs: 1_500,
      confidence: 0.82,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: evidence,
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 1_000,
    postRollMs: 1_200,
  };
  return {
    id,
    shotType: 'unrecognized',
    declaredStroke: null,
    uri,
    capturedAtIso,
    durationMs: clip.durationMs,
    fps: clip.fps,
    width: clip.width,
    height: clip.height,
    clip,
    evidenceStatus: 'valid',
  };
}

export function pendingCaptures(): PendingCapture[] {
  return CAPTURE_INSTANTS.map((iso, index) =>
    pendingCapture(`capture-${index + 1}`, iso),
  );
}
