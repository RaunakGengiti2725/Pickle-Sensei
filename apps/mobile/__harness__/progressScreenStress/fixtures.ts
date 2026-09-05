import type { CapturedClip } from '../../src/camera/capture';
import type { ShotAnalysis, ShotTypeSlug } from '@pickle/shared-types';

/**
 * Realistic on-device records for the ProgressScreen stress campaign. Every
 * fixture is written through the REAL repository writers into a REAL SQLite
 * database, so the screen sees exactly what a device would: the strict
 * payload parsers (`assertCapturedClip`, the real-analysis payload contract)
 * decide what counts, never the harness.
 */

export const FIXTURE_SHOT_TYPES: readonly ShotTypeSlug[] = [
  'forehand_drive',
  'dink',
  'third_shot_drop',
  'serve',
];

export const CURRENT_VERSIONS = {
  scoringModelVersion: 'scoring-1',
  shotConfigVersion: 'config-1',
} as const;

/** An older model vector: reads carrying it are NOT comparable to the newest
 * read of the same stroke and must be excluded from every technique stat. */
export const LEGACY_VERSIONS = {
  scoringModelVersion: 'scoring-0',
  shotConfigVersion: 'config-0',
} as const;

export interface ScoredFactSpec {
  id: string;
  shotType: ShotTypeSlug;
  capturedAtIso: string;
  /** 0–10 with one decimal; null → abstention (unscored, local only). */
  overallScore: number | null;
  sessionId: string | null;
  versions: typeof CURRENT_VERSIONS | typeof LEGACY_VERSIONS;
}

export function analysisFor(spec: ScoredFactSpec): ShotAnalysis {
  const scored = spec.overallScore !== null;
  return {
    id: spec.id,
    sessionId: spec.sessionId,
    shotType: spec.shotType,
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: spec.capturedAtIso,
    timestamps: { startMs: 2000, contactMs: scored ? 2400 : null, endMs: 2700 },
    phases: [],
    measurements: [],
    checkpoints: scored
      ? [
          {
            key: 'contact_position',
            score: 62,
            confidence: 0.8,
            band: 'yellow',
            direction: 'late',
            severity: 0.52,
            applicable: true,
          },
          {
            key: 'balance',
            score: 74,
            confidence: 0.8,
            band: 'green',
            direction: 'none',
            severity: 0,
            applicable: true,
          },
        ]
      : [],
    overallScore: spec.overallScore,
    analysisConfidence: scored ? 0.82 : 0.31,
    resultKind: scored ? 'scored' : 'low_confidence',
    guidance: null,
    priorityFix: scored
      ? {
          checkpoint: 'contact_position',
          reasonKey: 'lowest_score',
          severity: 0.52,
          confidence: 0.8,
        }
      : null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-heuristic-1',
      scoringModelVersion: spec.versions.scoringModelVersion,
      shotConfigVersion: spec.versions.shotConfigVersion,
    },
    source: 'real',
  } as ShotAnalysis;
}

export type CaptureKind =
  | 'guided'
  | 'imported_measured'
  | 'imported_unmeasured'
  | 'corrupt_payload'
  | 'metadata_mismatch'
  | 'legacy_no_payload';

export interface CaptureSpec {
  id: string;
  kind: CaptureKind;
  capturedAtIso: string;
  shotType: ShotTypeSlug;
}

export function guidedClip(spec: CaptureSpec): CapturedClip {
  return {
    uri: `file:///captures/${spec.id}.mov`,
    durationMs: 2700,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: spec.capturedAtIso,
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 2000,
      endMs: 2700,
      peakMotionMs: 2400,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    targetSeed: { x: 0.5, y: 0.6, source: 'live_camera_tap' },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: 40,
      poseFrameCount: 40,
      poseMissingFrameCount: 0,
      trackedDurationMs: 700,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: 40,
      jointMotion: [
        {
          joint: 'right_shoulder',
          sampleCount: 39,
          meanNormalizedPerSecond: 0.42,
          peakNormalizedPerSecond: 1.31,
        },
        {
          joint: 'right_wrist',
          sampleCount: 39,
          meanNormalizedPerSecond: 1.08,
          peakNormalizedPerSecond: 3.72,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 2000,
    postRollMs: 1500,
  } as CapturedClip;
}

export function importedClip(
  spec: CaptureSpec,
  measured: boolean,
): CapturedClip {
  const base = {
    uri: `file:///captures/${spec.id}.mov`,
    capturedAtIso: spec.capturedAtIso,
    durationMs: 3900,
    fps: 30,
    width: 1080,
    height: 1920,
  };
  return {
    ...base,
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    ...(measured
      ? {
          poseSequence: {
            schemaVersion: 1,
            format: 'pickle.pose-sequence.v1',
            uri: `file:///captures/${spec.id}.pose.json`,
            frameCount: 117,
            sha256: 'c'.repeat(64),
            coordinateSystem: 'normalized_image_top_left',
            poseModelVersion: 'apple-vision-bodypose-1',
          },
        }
      : {}),
  } as CapturedClip;
}
