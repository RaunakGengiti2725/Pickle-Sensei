/**
 * Clip fixtures for the mod-run-capture-analysis stress harness: a real
 * generated swing (synthetic skeleton, real sidecar serialization, real hash)
 * mutated into every legal / near-legal shape `runCaptureAnalysis` accepts at
 * its public boundary. Everything is derived from the seeded rng so a clip is
 * reproducible from its seed.
 */
import type { EnvelopeVerdict } from '@pickle/shared-types';
import { generateSwingSequence, type SwingTruth } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { CapturedClip } from '../../src/camera/capture';
import { chance, int, pick, type Rng } from './rng';

export type ClipKind =
  | 'good'
  | 'good_left'
  | 'good_wide_stance'
  | 'frozen_wrists'
  | 'sparse_pose'
  | 'invisible_pose'
  | 'imported_with_sidecar'
  | 'imported_no_sidecar'
  | 'no_sidecar'
  | 'unreadable_sidecar'
  | 'hash_mismatch'
  | 'invalid_sidecar'
  | 'empty_frames';

export const CLIP_KINDS: readonly ClipKind[] = [
  'good',
  'good_left',
  'good_wide_stance',
  'frozen_wrists',
  'sparse_pose',
  'invisible_pose',
  'imported_with_sidecar',
  'imported_no_sidecar',
  'no_sidecar',
  'unreadable_sidecar',
  'hash_mismatch',
  'invalid_sidecar',
  'empty_frames',
];

/** Kinds `runCaptureAnalysis` must reject BEFORE reserving a permit. */
export const PRE_RESERVE_GATE_KINDS: ReadonlySet<ClipKind> = new Set<ClipKind>([
  'imported_no_sidecar',
  'no_sidecar',
  'unreadable_sidecar',
  'hash_mismatch',
  'invalid_sidecar',
]);

export interface ClipFixture {
  kind: ClipKind;
  clip: CapturedClip;
  /** What the sidecar reader returns; null → reader rejects. */
  sidecarJson: string | null;
}

interface WireFrame {
  i: number;
  t: number;
  c: number;
  l: Array<{ n: string; x: number; y: number; v: number }>;
}
interface WireSequence {
  format: string;
  frames: WireFrame[];
  [key: string]: unknown;
}

function baseClip(
  id: string,
  sequenceFrames: number,
  window: { startMs: number; endMs: number; peakMs: number },
  sidecarJson: string,
): CapturedClip {
  return {
    uri: `file:///captures/${id}.mov`,
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-05T18:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
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
      analysisInputFrameCount: sequenceFrames,
      poseFrameCount: sequenceFrames,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: sequenceFrames,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 4,
          meanNormalizedPerSecond: 0.6,
          peakNormalizedPerSecond: 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 2000,
    postRollMs: 1500,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///captures/${id}.pose.json`,
      frameCount: sequenceFrames,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

function withSidecar(clip: CapturedClip, sidecarJson: string): CapturedClip {
  if (clip.captureMode !== 'automatic_pose_trigger' || !clip.poseSequence) {
    return clip;
  }
  return {
    ...clip,
    poseSequence: { ...clip.poseSequence, sha256: sha256Hex(sidecarJson) },
  };
}

function mutateWire(
  sidecarJson: string,
  mutate: (wire: WireSequence) => void,
): string {
  const wire = JSON.parse(sidecarJson) as WireSequence;
  mutate(wire);
  return JSON.stringify(wire);
}

export function makeClipFixture(
  rng: Rng,
  kind: ClipKind,
  id: string,
): ClipFixture {
  const handed: 'left' | 'right' = kind === 'good_left' ? 'left' : 'right';
  const overrides: Partial<SwingTruth> =
    kind === 'good_wide_stance'
      ? {
          handed,
          stanceWidthRatio: 1.2 + rng() * 0.6,
          kneeFlexionDeg: int(rng, 15, 45),
          shoulderTurnDeg: int(rng, 30, 70),
        }
      : { handed };
  const { sequence, window } = generateSwingSequence(overrides);
  const sidecarJson = serializePoseSequence(sequence);
  const clip = baseClip(id, sequence.frames.length, window, sidecarJson);

  switch (kind) {
    case 'good':
    case 'good_left':
    case 'good_wide_stance':
      return { kind, clip, sidecarJson };
    case 'frozen_wrists': {
      const frozen = mutateWire(sidecarJson, wire => {
        for (const frame of wire.frames) {
          for (const mark of frame.l) {
            if (mark.n.endsWith('wrist')) {
              mark.x = 0.5;
              mark.y = 0.5;
            }
          }
        }
      });
      return { kind, clip: withSidecar(clip, frozen), sidecarJson: frozen };
    }
    case 'sparse_pose': {
      const keepEvery = int(rng, 6, 12);
      const sparse = mutateWire(sidecarJson, wire => {
        wire.frames = wire.frames.filter((_, index) => index % keepEvery === 0);
      });
      return { kind, clip: withSidecar(clip, sparse), sidecarJson: sparse };
    }
    case 'invisible_pose': {
      const visibility = rng() * 0.15;
      const dim = mutateWire(sidecarJson, wire => {
        for (const frame of wire.frames) {
          frame.c = visibility;
          for (const mark of frame.l) mark.v = visibility;
        }
      });
      return { kind, clip: withSidecar(clip, dim), sidecarJson: dim };
    }
    case 'empty_frames': {
      const empty = mutateWire(sidecarJson, wire => {
        wire.frames = [];
      });
      return { kind, clip: withSidecar(clip, empty), sidecarJson: empty };
    }
    case 'imported_with_sidecar':
      return {
        kind,
        clip: {
          ...clip,
          captureMode: 'imported_video',
          trigger: null,
        } as unknown as CapturedClip,
        sidecarJson,
      };
    case 'imported_no_sidecar':
      return {
        kind,
        clip: {
          ...clip,
          captureMode: 'imported_video',
          trigger: null,
          poseSequence: null,
        } as unknown as CapturedClip,
        sidecarJson,
      };
    case 'no_sidecar':
      return {
        kind,
        clip: { ...clip, poseSequence: null } as unknown as CapturedClip,
        sidecarJson,
      };
    case 'unreadable_sidecar':
      return { kind, clip, sidecarJson: null };
    case 'hash_mismatch':
      return {
        kind,
        clip,
        sidecarJson: pick(rng, [
          sidecarJson.slice(0, -1) + ' }',
          `${sidecarJson} `,
          sidecarJson.replace('"x":', '"x": '),
        ]),
      };
    case 'invalid_sidecar': {
      const broken = pick(rng, [
        '{"schemaVersion":1,"format":"pickle.pose-sequence.v1"}',
        '[]',
        'null',
        '{"frames": "nope"}',
        mutateWire(sidecarJson, wire => {
          wire.format = 'unknown.format';
        }),
      ]);
      return { kind, clip: withSidecar(clip, broken), sidecarJson: broken };
    }
    default:
      return { kind, clip, sidecarJson };
  }
}

export function makeEnvelope(
  overall: 'SUPPORTED' | 'DEGRADED' | 'UNSUPPORTED',
): EnvelopeVerdict {
  return {
    thresholdsVersion: 'stress-1',
    provisional: true,
    dimensions: [
      {
        dimension: 'motion_blur',
        status: overall,
        measured: 0.9,
        unit: 'ratio',
        thresholdId: 'motion_blur.v1',
      },
    ],
    overall,
    overallWithCoverage: overall,
    notMeasured: [],
  };
}

export function randomEnvelope(rng: Rng): EnvelopeVerdict | null {
  if (chance(rng, 0.55)) return null;
  return makeEnvelope(pick(rng, ['SUPPORTED', 'DEGRADED', 'UNSUPPORTED']));
}
