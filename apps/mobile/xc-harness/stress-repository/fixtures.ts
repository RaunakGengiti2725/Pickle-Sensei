/**
 * Deterministic value builders for the repository stress campaign.
 *
 * Every builder is a pure function of its arguments (plus the sequence PRNG
 * that the caller threads through), so a trace can be replayed from its seed
 * alone. The shapes are the real product types — nothing here is cast.
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import {
  CHECKPOINTS,
  SHOT_TYPES,
  type CheckpointScore,
  type ShotAnalysis,
  type ShotTypeSlug,
} from '@pickle/shared-types';
import type { CapturedClip } from '../../src/camera/capture';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';

export const OWNER_A = '11111111-1111-4111-8111-111111111111';
export const OWNER_B = '22222222-2222-4222-8222-222222222222';
/** Mixed-case spelling of a third UUID: setActiveDataOwner must lowercase it. */
export const OWNER_C_MIXED_CASE = '33333333-3333-4333-8333-33333333AAAA';
export const OWNER_C = OWNER_C_MIXED_CASE.toLowerCase();

/** Values the generator may hand to setActiveDataOwner (legal + near-legal). */
export const OWNER_CHOICES = [
  OWNER_A,
  OWNER_B,
  OWNER_C_MIXED_CASE,
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
] as const;

export const INVALID_OWNERS = [
  '',
  ' ',
  'not-a-uuid',
  'device-guest ',
  'Device-Guest',
  '11111111-1111-4111-8111-11111111111', // one nibble short
  '11111111-1111-9111-8111-111111111111', // version nibble 9
  '11111111-1111-4111-c111-111111111111', // variant nibble c
  'signed-out\n',
] as const;

export const PERMIT_ID = '99999999-9999-4999-8999-999999999999';

const VERSION_VECTOR: ShotAnalysis['versionVector'] = {
  appVersion: '0.1.0',
  modelBundleVersion: 'validated-bundle-1',
  poseModelVersion: 'pose-1',
  paddleModelVersion: 'paddle-1',
  strokeDetectorVersion: 'stroke-1',
  phaseModelVersion: 'phase-1',
  scoringModelVersion: 'score-1',
  shotConfigVersion: 'config-1',
};

/** `n`-th distinct capture instant, strictly increasing so ordering
 * invariants are total (no ORDER BY ties to argue about). */
export function capturedAtIso(n: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + n * 1000).toISOString();
}

export function shotId(n: number): string {
  return `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

export function captureId(n: number): string {
  return `capture-${n}`;
}

export function sessionId(n: number): string {
  return `session-${n}`;
}

export function recordId(n: number): string {
  return `record-${n}`;
}

export interface ShotSpec {
  id: string;
  seq: number;
  shotType: ShotTypeSlug;
  scored: boolean;
  score: number | null;
  sessionId: string | null;
  checkpointVariant: 'none' | 'all_applicable' | 'mixed';
  priority: boolean;
  source: 'real' | 'fixture';
}

function checkpointsFor(spec: ShotSpec): CheckpointScore[] {
  if (spec.checkpointVariant === 'none') return [];
  return CHECKPOINTS.map((key, index) => {
    const applicable =
      spec.checkpointVariant === 'all_applicable' || index % 3 !== 1;
    const observed =
      spec.checkpointVariant === 'all_applicable' || index % 4 !== 3;
    const score =
      applicable && observed ? (spec.seq * 7 + index * 13) % 101 : null;
    return {
      key,
      score,
      confidence: 0.5 + (index % 5) / 10,
      band:
        score === null
          ? 'unscored'
          : score >= 70
            ? 'green'
            : score >= 40
              ? 'yellow'
              : 'red',
      direction: 'none',
      severity: score === null ? 0 : (100 - score) / 100,
      applicable,
    };
  });
}

export function buildAnalysis(spec: ShotSpec): ShotAnalysis {
  const checkpoints = checkpointsFor(spec);
  return {
    id: spec.id,
    sessionId: spec.sessionId,
    shotType: spec.shotType,
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: capturedAtIso(spec.seq),
    timestamps: {
      startMs: 0,
      contactMs: spec.scored ? 900 : null,
      endMs: 1800,
    },
    phases: [],
    measurements: [],
    checkpoints,
    overallScore: spec.scored ? spec.score : null,
    analysisConfidence: spec.scored ? 0.9 : 0.2,
    resultKind: spec.scored ? 'scored' : 'low_confidence',
    guidance: spec.scored
      ? null
      : 'Move the camera so your whole body is visible.',
    priorityFix:
      spec.priority && checkpoints.length > 0
        ? {
            checkpoint: CHECKPOINTS[
              spec.seq % CHECKPOINTS.length
            ] as CheckpointScore['key'],
            reasonKey: 'stress.priority',
            severity: 0.4,
            confidence: 0.8,
          }
        : null,
    versionVector: {
      ...VERSION_VECTOR,
      shotConfigVersion: `${spec.shotType}@1`,
    },
    source: spec.source,
  };
}

export function shotTypeFor(n: number): ShotTypeSlug {
  return SHOT_TYPES[n % SHOT_TYPES.length] as ShotTypeSlug;
}

export function buildClip(n: number, uriSuffix = ''): CapturedClip {
  return {
    uri: `file:///private/captures/stress-${n}${uriSuffix}.mov`,
    durationMs: 3000 + (n % 17) * 100,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso: capturedAtIso(100000 + n),
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
  };
}

/** The same clip with measured pose evidence appended (imported-video
 * extraction). Identity columns unchanged, so the row must stay `valid`. */
export function enrichClip(clip: CapturedClip): CapturedClip {
  return {
    ...clip,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: clip.uri.replace(/\.mov$/, '.pose.json'),
      frameCount: 120,
      sha256: 'a'.repeat(64),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-body-pose-1',
    },
  };
}

export function buildRecord(
  n: number,
  captureIdValue: string,
  createdSeq: number,
  result: ShotAnalysis | null,
): AnalysisRecord {
  return {
    schemaVersion: 1,
    id: recordId(n),
    captureId: captureIdValue,
    createdAtIso: capturedAtIso(200000 + createdSeq),
    engineVersion: 'fusion-stress-1',
    strokeTaxonomyVersion: 'v3',
    strokeResolution: result
      ? { kind: 'predicted', shotType: result.shotType, confidence: 0.8 }
      : { kind: 'unresolved', reason: 'insufficient_pose_coverage' },
    modalities: {
      pose: true,
      paddle: false,
      ball: false,
      court: false,
      camera: true,
    },
    modelRuns: [],
    provenance: {
      appVersion: '0.1.0',
      pipelineVersion: 'fusion-stress-1',
      providerVersions: [
        {
          providerId: 'pose.apple-vision',
          modelVersion: 'pose-1',
          runtime: 'vision_framework',
          executionTarget: 'on_device',
          artifactHash: null,
        },
      ],
      scoreVersion: 'score-1',
      taxonomyVersion: 'v3',
      drillMappingVersion: 'none',
      captureEnvelopeVersion: 'capture-envelope-not-measured',
      recordedAtIso: capturedAtIso(200000 + createdSeq),
    },
    result,
    faults: [],
    uncertainty: {
      analysisConfidence: result ? 0.85 : 0,
      presentation: result ? 'normal' : 'abstain',
      perCheckpoint: {},
      limitingFactors: ['paddle_unavailable'],
    },
    evidence: [],
    shadow: [],
  };
}
