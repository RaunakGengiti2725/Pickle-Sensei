import { generateSwingSequence, DEFAULT_TRUTH } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';

/**
 * Deterministic clip payloads as the native bridge would hand them back.
 * Guided clips carry a REAL generated pose sequence (the synthetic swing
 * generator's exact-truth skeletons), serialized with the production sidecar
 * format and hashed with the production sha256 — so `runCaptureAnalysis`
 * runs its integrity, parse, quality-gate and inference stages for real.
 *
 * The swing presets deliberately span the quality gate: some are textbook
 * swings that score, some are cramped / low-visibility swings the engine
 * abstains on, so a seeded campaign exercises the scored, low-confidence and
 * quality-blocked routings without any of them being scripted.
 */
export type GuidedClipVariant =
  | 'guided_scoring'
  | 'guided_no_target_seed'
  | 'guided_poseless'
  | 'guided_tampered_sidecar'
  | 'guided_missing_artifact'
  | 'guided_cramped'
  | 'guided_left_handed';

export type ImportedClipVariant = 'imported_plain' | 'imported_with_poster';

export type NativeClipVariant =
  GuidedClipVariant | ImportedClipVariant | 'invalid_payload';

export const GUIDED_CLIP_VARIANTS: readonly GuidedClipVariant[] = [
  'guided_scoring',
  'guided_no_target_seed',
  'guided_poseless',
  'guided_tampered_sidecar',
  'guided_missing_artifact',
  'guided_cramped',
  'guided_left_handed',
];

export const IMPORTED_CLIP_VARIANTS: readonly ImportedClipVariant[] = [
  'imported_plain',
  'imported_with_poster',
];

interface SwingFixture {
  sidecarJson: string;
  sha256: string;
  frameCount: number;
  window: { startMs: number; endMs: number; peakMs: number };
}

type SwingPreset = 'textbook' | 'cramped' | 'left';

const swingCache = new Map<SwingPreset, SwingFixture>();

function swing(preset: SwingPreset): SwingFixture {
  const cached = swingCache.get(preset);
  if (cached) return cached;
  const overrides =
    preset === 'textbook'
      ? {}
      : preset === 'left'
        ? { handed: 'left' as const }
        : {
            // Tiny, barely-moving body far from the lens: designed to fall
            // below the measurable-motion / visibility gates.
            torsoLength: 0.06,
            backswingLengthNorm: 0.05,
            contactForwardNorm: 0.05,
            shoulderTurnDeg: 4,
            kneeFlexionDeg: 2,
            fps: DEFAULT_TRUTH.fps,
          };
  const { sequence, window } = generateSwingSequence(overrides);
  const sidecarJson = serializePoseSequence(sequence);
  const fixture: SwingFixture = {
    sidecarJson,
    sha256: sha256Hex(sidecarJson),
    frameCount: sequence.frames.length,
    window,
  };
  swingCache.set(preset, fixture);
  return fixture;
}

export interface NativeClipPayload {
  /** What `native.capture()` / `native.importVideo()` resolves with. */
  payload: unknown;
  /** Sidecar text the bridge must serve for the clip's pose sequence URI. */
  artifacts: Array<{ uri: string; text: string }>;
}

const CAPTURED_AT = '2026-09-04T18:00:00.000Z';

function guidedPayload(
  id: string,
  preset: SwingPreset,
  options: {
    targetSeed: boolean;
    pose: 'valid' | 'none' | 'tampered' | 'missing';
  },
): NativeClipPayload {
  const fixture = swing(preset);
  const poseUri = `file:///captures/${id}.pose.json`;
  const base: Record<string, unknown> = {
    uri: `file:///captures/${id}.mov`,
    durationMs: fixture.window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: CAPTURED_AT,
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: fixture.window.startMs,
      endMs: fixture.window.endMs,
      peakMotionMs: fixture.window.peakMs,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: fixture.frameCount,
      poseFrameCount: fixture.frameCount,
      poseMissingFrameCount: 0,
      trackedDurationMs: fixture.window.endMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: fixture.frameCount,
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
    preRollMs: 200,
    postRollMs: 150,
  };
  if (options.targetSeed) {
    base.targetSeed = { x: 0.5, y: 0.6, source: 'live_camera_tap' };
  }
  const artifacts: Array<{ uri: string; text: string }> = [];
  if (options.pose !== 'none') {
    base.poseSequence = {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: poseUri,
      frameCount: fixture.frameCount,
      sha256:
        options.pose === 'tampered'
          ? fixture.sha256.replace(/^./, c => (c === '0' ? '1' : '0'))
          : fixture.sha256,
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    };
    if (options.pose !== 'missing') {
      artifacts.push({ uri: poseUri, text: fixture.sidecarJson });
    }
  }
  return { payload: base, artifacts };
}

function importedPayload(id: string, poster: boolean): NativeClipPayload {
  return {
    payload: {
      uri: `file:///imports/${id}.mp4`,
      durationMs: 4200,
      fps: 30,
      width: 1920,
      height: 1080,
      byteSize: 8_400_000,
      capturedAtIso: CAPTURED_AT,
      captureMode: 'imported_video',
      recognition: {
        status: 'unknown',
        reason: 'validated_classifier_unavailable',
      },
      ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
      ...(poster ? { posterUri: `file:///imports/${id}.poster.jpg` } : {}),
    },
    artifacts: [],
  };
}

/** `id` must be unique per clip within a sequence: `local_capture` has a
 * UNIQUE (owner, uri) constraint, exactly like real capture files do. */
export function nativeClipPayload(
  variant: NativeClipVariant,
  id: string,
): NativeClipPayload {
  switch (variant) {
    case 'guided_scoring':
      return guidedPayload(id, 'textbook', { targetSeed: true, pose: 'valid' });
    case 'guided_no_target_seed':
      return guidedPayload(id, 'textbook', {
        targetSeed: false,
        pose: 'valid',
      });
    case 'guided_poseless':
      return guidedPayload(id, 'textbook', { targetSeed: true, pose: 'none' });
    case 'guided_tampered_sidecar':
      return guidedPayload(id, 'textbook', {
        targetSeed: true,
        pose: 'tampered',
      });
    case 'guided_missing_artifact':
      return guidedPayload(id, 'textbook', {
        targetSeed: true,
        pose: 'missing',
      });
    case 'guided_cramped':
      return guidedPayload(id, 'cramped', { targetSeed: true, pose: 'valid' });
    case 'guided_left_handed':
      return guidedPayload(id, 'left', { targetSeed: true, pose: 'valid' });
    case 'imported_plain':
      return importedPayload(id, false);
    case 'imported_with_poster':
      return importedPayload(id, true);
    case 'invalid_payload':
      return {
        payload: {
          captureMode: 'automatic_pose_trigger',
          uri: 'not-a-file-uri',
        },
        artifacts: [],
      };
  }
}

/** Receipt the native imported-video extraction pass resolves with. */
export function importedPoseExtractionReceipt(
  id: string,
  preset: 'textbook' | 'cramped' = 'textbook',
): NativeClipPayload {
  const fixture = swing(preset);
  const poseUri = `file:///imports/${id}.pose.json`;
  return {
    payload: {
      poseSequence: {
        schemaVersion: 1,
        format: 'pickle.pose-sequence.v1',
        uri: poseUri,
        frameCount: fixture.frameCount,
        sha256: fixture.sha256,
        coordinateSystem: 'normalized_image_top_left',
        poseModelVersion: 'apple-vision-bodypose-1',
      },
      posterUri: `file:///imports/${id}.extracted-poster.jpg`,
      framesWithPose: fixture.frameCount,
      framesTotal: fixture.frameCount,
    },
    artifacts: [{ uri: poseUri, text: fixture.sidecarJson }],
  };
}

export type ExtractionFailure =
  'import_no_person' | 'import_too_long' | 'generic' | 'invalid_receipt';

export function importedPoseExtractionError(kind: ExtractionFailure): Error {
  switch (kind) {
    case 'import_no_person':
      return Object.assign(new Error('No person was found in the video.'), {
        code: 'camera.import_no_person',
      });
    case 'import_too_long':
      return Object.assign(
        new Error('The video is longer than the import limit.'),
        {
          code: 'camera.import_too_long',
        },
      );
    case 'generic':
      return new Error('The pose pass crashed while decoding the file.');
    case 'invalid_receipt':
      // Not thrown by native — the driver resolves with this and lets the
      // production validator reject it.
      return new Error('invalid_receipt');
  }
}

/** Does the production pipeline get a pose sequence it can read? */
export function clipVariantHasPose(variant: NativeClipVariant): boolean {
  return (
    variant === 'guided_scoring' ||
    variant === 'guided_no_target_seed' ||
    variant === 'guided_cramped' ||
    variant === 'guided_left_handed' ||
    variant === 'guided_tampered_sidecar' ||
    variant === 'guided_missing_artifact'
  );
}
