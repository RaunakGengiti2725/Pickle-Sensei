// The screen module pulls in the SQLite-backed db, whose native binding does
// not exist under jest. The pure copy/derivation exports under test never
// touch it, so the db module is replaced wholesale.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import {
  ANALYZE_STEPS,
  READINESS_COPY,
  captureSavedDetail,
} from '../src/screens/AnalyzeScreen';
import {
  assertCapturedClip,
  TARGET_LOCK_PARAMS_V1,
  type CameraReadinessState,
} from '../src/camera/capture';

/**
 * Zero-handholding copy audit (docs/USABILITY_ZERO_HANDHOLDING.md, T1–T9).
 *
 * A fresh user gets no verbal help, so every state the camera can emit and
 * every walkthrough step must carry self-sufficient copy. These tests pin
 * the surfaces the protocol's tasks depend on.
 */

const ALL_READINESS_STATES: CameraReadinessState[] = [
  'no_person',
  'full_body_required',
  'move_closer',
  'move_farther',
  'hold_still',
  'ready',
];

describe('readiness copy (protocol T5: understand readiness)', () => {
  it('covers every camera readiness state with distinct, non-empty copy', () => {
    for (const state of ALL_READINESS_STATES) {
      expect(READINESS_COPY[state]).toBeTruthy();
    }
    const values = ALL_READINESS_STATES.map(s => READINESS_COPY[s]);
    expect(new Set(values).size).toBe(values.length);
  });

  it('non-ready states tell the user what to do, not just what is wrong', () => {
    // Each blocking state's copy is an imperative instruction the user can
    // act on alone — no jargon-only diagnoses like "pose invalid".
    expect(READINESS_COPY.no_person).toMatch(/step/i);
    expect(READINESS_COPY.full_body_required).toMatch(/body/i);
    expect(READINESS_COPY.move_closer).toMatch(/closer/i);
    expect(READINESS_COPY.move_farther).toMatch(/back/i);
    expect(READINESS_COPY.hold_still).toMatch(/still/i);
  });

  it('the ready state says swinging is now expected', () => {
    expect(READINESS_COPY.ready).toMatch(/ready/i);
    expect(READINESS_COPY.ready).toMatch(/swing/i);
  });
});

describe('walkthrough steps (protocol T3–T6: place, start spot, ready, swing)', () => {
  it('includes an explicit starting-location step', () => {
    const startStep = ANALYZE_STEPS.find(s => /start/i.test(s.title));
    expect(startStep).toBeDefined();
    expect(startStep!.detail).toMatch(/tap/i);
    expect(startStep!.detail).toMatch(/walk/i);
  });

  it('covers framing, starting spot, readiness, and the single stroke in order', () => {
    const titles = ANALYZE_STEPS.map(s => s.title.toLowerCase());
    expect(titles.some(t => t.includes('frame'))).toBe(true);
    expect(titles.some(t => t.includes('start'))).toBe(true);
    expect(titles.some(t => t.includes('ready'))).toBe(true);
    expect(titles.some(t => t.includes('stroke'))).toBe(true);
    expect(ANALYZE_STEPS.map(s => s.index)).toEqual(['01', '02', '03', '04']);
  });

  it('every step has non-empty actionable detail', () => {
    for (const step of ANALYZE_STEPS) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.detail.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('captureSavedDetail (protocol T4 funnel evidence)', () => {
  const baseClip = {
    uri: 'file:///private/var/mobile/clip.mov',
    durationMs: 4200,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso: '2026-08-27T18:00:00.000Z',
  };

  const trigger = {
    startMs: 2000,
    endMs: 2700,
    peakMotionMs: 2400,
    confidence: 0.82,
    source: 'temporal_pose_motion',
    modelVersion: 'temporal-stroke-heuristic-2',
  };

  const captureEvidence = {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'apple_vision_body_pose',
    poseModelVersion: 'apple-vision-bodypose-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    analysisInputFrameCount: 7,
    poseFrameCount: 6,
    poseMissingFrameCount: 1,
    trackedDurationMs: 620,
    meanCanonicalJointVisibility: 0.88,
    meanJointCoverage: 0.94,
    minimumJointCoverage: 0.83,
    fullBodyVisibleFrameCount: 4,
    jointMotion: [
      {
        joint: 'left_wrist',
        sampleCount: 5,
        meanNormalizedPerSecond: 1.1,
        peakNormalizedPerSecond: 2.4,
      },
    ],
  };

  const automaticClip = {
    ...baseClip,
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger,
    captureEvidence,
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 2000,
    postRollMs: 1500,
  };

  it('reports imported clips as such — no start-location claim is invented', () => {
    const clip = assertCapturedClip({
      ...baseClip,
      captureMode: 'imported_video',
      recognition: { status: 'unknown', reason: 'analysis_not_run' },
      ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    });
    expect(captureSavedDetail(clip)).toBe('imported');
  });

  it('reports honest no_start_tap when the user never chose a start spot', () => {
    const clip = assertCapturedClip(automaticClip);
    expect(captureSavedDetail(clip)).toBe('no_start_tap');
  });

  it('reports the recorded lock outcome when target-lock telemetry exists', () => {
    const tapPoint = { x: 0.5, y: 0.62 };
    const lockTorso = { x: 0.53, y: 0.6 };
    const clip = assertCapturedClip({
      ...automaticClip,
      targetSeed: {
        x: lockTorso.x,
        y: lockTorso.y,
        source: 'start_region_occupancy',
      },
      targetLock: {
        schemaVersion: 1,
        algorithmVersion: 'target-lock-live-v1',
        coordinateSystem: 'normalized_capture_space',
        tapPoint,
        lockOutcome: 'locked',
        lockSource: 'start_region_occupancy',
        lockTorso,
        tapToLockDistance: Math.hypot(
          lockTorso.x - tapPoint.x,
          lockTorso.y - tapPoint.y,
        ),
        timeToLockMs: 640,
        ambiguityEntered: false,
        params: TARGET_LOCK_PARAMS_V1,
      },
    });
    expect(captureSavedDetail(clip)).toBe('locked');
  });

  it('reports start_tapped when a seed exists without lock telemetry', () => {
    const clip = assertCapturedClip({
      ...automaticClip,
      targetSeed: { x: 0.5, y: 0.6, source: 'start_region_occupancy' },
    });
    expect(captureSavedDetail(clip)).toBe('start_tapped');
  });
});
