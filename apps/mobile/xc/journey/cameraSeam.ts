/**
 * XC journey harness — controllable native camera seam.
 *
 * iOS camera + Apple Vision execution is BLOCKED_EXTERNAL on Linux, so the
 * typed `src/camera/capture` contract is driven from the test instead: the
 * harness emits the literal event sequence the native module produces and
 * resolves/rejects `captureStrokeVideo` on demand. Everything above the seam
 * (AnalyzeScreen → runCaptureAnalysis → SQLite → Result…) runs for real.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type {
  CameraEvent,
  CameraReadinessState,
  CapturedClip,
} from '../../src/camera/capture';

type CameraListener = (event: CameraEvent) => void;

interface SeamState {
  listeners: Set<CameraListener>;
  cancelCalls: number;
  captureImpl: () => Promise<CapturedClip>;
  readArtifact: (uri: string) => Promise<string>;
  artifacts: Map<string, string>;
}

const state: SeamState = {
  listeners: new Set(),
  cancelCalls: 0,
  captureImpl: () => Promise.reject(new Error('capture seam not armed')),
  readArtifact: uri => {
    const json = state.artifacts.get(uri);
    return json === undefined
      ? Promise.reject(new Error(`no recorded artifact at ${uri}`))
      : Promise.resolve(json);
  },
  artifacts: new Map(),
};

export function resetCameraSeam(): void {
  state.listeners.clear();
  state.cancelCalls = 0;
  state.captureImpl = () => Promise.reject(new Error('capture seam not armed'));
  state.artifacts.clear();
  state.readArtifact = uri => {
    const json = state.artifacts.get(uri);
    return json === undefined
      ? Promise.reject(new Error(`no recorded artifact at ${uri}`))
      : Promise.resolve(json);
  };
}

export function cameraCancelCalls(): number {
  return state.cancelCalls;
}

export function cameraListenerCount(): number {
  return state.listeners.size;
}

/** Module shape for `jest.mock('../../src/camera/capture', …)`. */
export function cameraSeamModule(actual: Record<string, unknown>) {
  return {
    ...actual,
    captureStrokeVideo: () => state.captureImpl(),
    importStrokeVideo: () =>
      Promise.reject(new Error('library import is outside this journey')),
    cancelCameraOperation: () => {
      state.cancelCalls += 1;
    },
    subscribeToCameraEvents: (listener: CameraListener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    readCaptureArtifact: (uri: string) => state.readArtifact(uri),
  };
}

export function emitCameraEvent(event: CameraEvent): void {
  for (const listener of [...state.listeners]) listener(event);
}

/** Makes the next sidecar read fail (models a deleted/unreadable file). */
export function failArtifactReads(message: string): void {
  state.readArtifact = () => Promise.reject(new Error(message));
}

export interface DeferredCapture {
  resolve(clip: CapturedClip): void;
  reject(error: Error): void;
}

export function armDeferredCapture(): DeferredCapture {
  let resolveFn!: (clip: CapturedClip) => void;
  let rejectFn!: (error: Error) => void;
  state.captureImpl = () =>
    new Promise<CapturedClip>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
  return {
    resolve: clip => resolveFn(clip),
    reject: error => rejectFn(error),
  };
}

// ─── Deterministic clip fixtures ─────────────────────────────────────────────

/** mulberry32 — the one PRNG the harness uses; a seed replays a clip exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ClipTruth {
  kneeFlexionDeg: number;
  shoulderTurnDeg: number;
  contactForwardNorm: number;
  backswingLengthNorm: number;
  handed: 'right' | 'left';
}

/** Swing-truth overrides derived from a seed (ranges stay inside the
 * generator's plausible envelope so the clip is analyzable). */
export function clipTruthForSeed(seed: number): ClipTruth {
  const rand = mulberry32(seed);
  const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
  return {
    kneeFlexionDeg: Math.round(between(10, 35) * 10) / 10,
    shoulderTurnDeg: Math.round(between(25, 55) * 10) / 10,
    contactForwardNorm: Math.round(between(0.25, 0.6) * 100) / 100,
    backswingLengthNorm: Math.round(between(0.6, 1.1) * 100) / 100,
    handed: 'right',
  };
}

export interface ClipFixture {
  clip: CapturedClip;
  sidecarJson: string;
  seed: number;
  truth: ClipTruth;
  frameCount: number;
}

export function seededClip(id: string, seed: number): ClipFixture {
  const truth = clipTruthForSeed(seed);
  const { sequence, window } = generateSwingSequence(truth);
  const sidecarJson = serializePoseSequence(sequence);
  const uri = `file:///captures/${id}.mov`;
  const sidecarUri = `file:///captures/${id}.pose.json`;
  state.artifacts.set(sidecarUri, sidecarJson);
  const clip: CapturedClip = {
    uri,
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-04T05:00:00.000Z',
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
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: sequence.frames.length,
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
      uri: sidecarUri,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson, seed, truth, frameCount: sequence.frames.length };
}

// ─── Native event sequence ───────────────────────────────────────────────────

const eventBase = () => ({ emittedAtIso: '2026-09-04T05:00:00.000Z' });

export function readinessEvent(
  readiness: CameraReadinessState,
  jointCoverage: number,
): CameraEvent {
  return {
    ...eventBase(),
    type: 'readiness',
    state: readiness,
    poseConfidence: 0.9,
    jointCoverage,
    stableForMs: 300,
    missingJoints: [],
    source: 'apple_vision_body_pose',
    modelVersion: 'apple-vision-bodypose-1',
  };
}

export function permissionEvent(
  permission: 'requesting' | 'granted' | 'denied',
): CameraEvent {
  return { ...eventBase(), type: 'permission', state: permission };
}

export function sessionEvent(
  session: 'configured' | 'observing' | 'armed' | 'interrupted',
): CameraEvent {
  return { ...eventBase(), type: 'session', state: session };
}

export function strokeDetectedEvent(confidence: number): CameraEvent {
  return {
    ...eventBase(),
    type: 'stroke_detected',
    startTimestampMs: 2000,
    endTimestampMs: 2700,
    peakMotionTimestampMs: 2400,
    confidence,
    detectionModelVersion: 'temporal-stroke-heuristic-2',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
  };
}

export function processingEvent(): CameraEvent {
  return { ...eventBase(), type: 'processing', state: 'preparing_clip' };
}

/** The literal on-device sequence before a clip exists. */
export function nativeCaptureSequence(): CameraEvent[] {
  return [
    permissionEvent('requesting'),
    permissionEvent('granted'),
    sessionEvent('configured'),
    sessionEvent('observing'),
    readinessEvent('no_person', 0),
    readinessEvent('move_closer', 0.55),
    readinessEvent('full_body_required', 0.7),
    readinessEvent('hold_still', 0.88),
    sessionEvent('armed'),
    readinessEvent('ready', 0.93),
    strokeDetectedEvent(0.86),
    processingEvent(),
  ];
}
