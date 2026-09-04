/**
 * XC journey-history-library-delete — typed fixtures. These are STATE
 * DOUBLES for the persistence layer (shape-complete, never product results):
 * the harness exercises how rows are written, read, synced and purged, not
 * how a stroke is scored.
 */
import type { ShotAnalysis, ShotTypeSlug } from '@pickle/shared-types';
import { MVP_SHOT_TYPES } from '@pickle/shared-types';
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { CapturedClip } from '../../src/camera/capture';
import { pick, seededUuid } from './realSqlite';

export const OWNER_A = '11111111-1111-4111-8111-111111111111';
export const OWNER_B = '22222222-2222-4222-8222-222222222222';

export function shotAnalysis(
  overrides: Partial<ShotAnalysis> & { id: string },
): ShotAnalysis {
  return {
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-26T18:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'xc-native-1',
      poseModelVersion: 'xc-pose-1',
      paddleModelVersion: 'xc-paddle-1',
      strokeDetectorVersion: 'xc-stroke-1',
      phaseModelVersion: 'xc-phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
    ...overrides,
  };
}

/** A randomized scored/abstained analysis whose every field is a function of
 * the seeded generator, so a failing scenario replays byte-for-byte. */
export function randomShotAnalysis(
  rand: () => number,
  index: number,
): ShotAnalysis {
  const shotType: ShotTypeSlug = pick(rand, MVP_SHOT_TYPES);
  const scored = rand() < 0.75;
  const minute = String(index % 60).padStart(2, '0');
  const day = String(1 + (index % 27)).padStart(2, '0');
  return shotAnalysis({
    id: seededUuid(rand),
    shotType,
    capturedAtIso: `2026-08-${day}T1${index % 10}:${minute}:00.000Z`,
    overallScore: scored ? Math.round(rand() * 100) / 10 : null,
    analysisConfidence: Math.round(rand() * 100) / 100,
    resultKind: scored ? 'scored' : 'low_confidence',
    guidance: scored ? null : 'Move the camera so your whole body is in frame.',
  });
}

/** Only the base clip fields may be overridden: the fixture is always an
 * automatic pose-trigger capture (the discriminant stays fixed). */
type CapturedClipOverrides = Partial<
  Pick<
    CapturedClip,
    | 'uri'
    | 'durationMs'
    | 'fps'
    | 'width'
    | 'height'
    | 'capturedAtIso'
    | 'posterUri'
    | 'byteSize'
  >
>;

export function capturedClip(
  overrides: CapturedClipOverrides = {},
): CapturedClip {
  return {
    uri: 'file:///private/captures/xc.mov',
    durationMs: 3900,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 1800,
      endMs: 2450,
      peakMotionMs: 2220,
      confidence: 0.84,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'mediapipe_pose_landmarker',
      poseModelVersion: 'mediapipe-pose-landmarker-full-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: 8,
      poseFrameCount: 7,
      poseMissingFrameCount: 1,
      trackedDurationMs: 600,
      meanCanonicalJointVisibility: 0.86,
      meanJointCoverage: 0.93,
      minimumJointCoverage: 0.83,
      fullBodyVisibleFrameCount: 5,
      jointMotion: [
        {
          joint: 'left_wrist',
          sampleCount: 6,
          meanNormalizedPerSecond: 1.2,
          peakNormalizedPerSecond: 2.1,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 1800,
    postRollMs: 1450,
    ...overrides,
  };
}

export function analysisRecord(
  id: string,
  captureId: string,
  result: ShotAnalysis | null,
): AnalysisRecord {
  const shotType: ShotTypeSlug = result?.shotType ?? 'forehand_drive';
  return {
    schemaVersion: 1,
    id,
    captureId,
    createdAtIso: result?.capturedAtIso ?? '2026-08-27T18:00:05.000Z',
    engineVersion: 'xc-state-double',
    strokeTaxonomyVersion: 'xc-state-double',
    strokeResolution: { kind: 'declared', shotType },
    modalities: {
      pose: true,
      paddle: false,
      ball: false,
      court: false,
      camera: false,
    },
    modelRuns: [],
    provenance: {
      appVersion: 'xc-state-double',
      pipelineVersion: 'xc-state-double',
      providerVersions: [
        {
          providerId: 'xc-state-double',
          modelVersion: 'xc-state-double',
          runtime: 'deterministic',
          executionTarget: 'on_device',
          artifactHash: null,
        },
      ],
      scoreVersion: 'xc-state-double',
      taxonomyVersion: 'xc-state-double',
      drillMappingVersion: 'none',
      captureEnvelopeVersion: 'capture-envelope-not-measured',
      recordedAtIso: '2026-08-27T18:00:05.000Z',
    },
    result,
    faults: [],
    uncertainty: {
      analysisConfidence: result?.analysisConfidence ?? 0,
      presentation: result ? 'normal' : 'abstain',
      perCheckpoint: {},
      limitingFactors: result ? [] : ['XC_STATE_DOUBLE'],
    },
    evidence: [],
    shadow: [],
  };
}
