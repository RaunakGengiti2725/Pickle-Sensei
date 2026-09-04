/**
 * ADVERSARIAL PASS 3 — AnalyzeScreen attempt lifecycle attacks (plane: cloud).
 *
 * Attacks the mounted screen through the SAME seams the native layer uses
 * (camera event stream + capture/import/extraction promises):
 *   C1 double-tap / N-tap Start → exactly one captureStrokeVideo()
 *   C2 late attempt-1 `capture_quality` / `readiness` after attempt 2's
 *      beginAttempt() → must not enter attempt 2's stored envelope
 *   C3 stale `import_pose_extraction{completed}` for a foreign captureId
 *      after the current run started → must not jump the bar to 100%
 *   C4 hostile progress payloads (NaN/huge/negative fraction, clock skew,
 *      unicode ids) must never render NaN/absurd text or crash
 *
 * Native execution is BLOCKED_EXTERNAL; every claim below is about the JS
 * state machine only. No production file is modified by this suite.
 */
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
  setCaptureTargetSeed: jest.fn(async () => {}),
  updateCaptureClipPayload: jest.fn(async () => {}),
  getKv: jest.fn(async () => null),
  setKv: jest.fn(async () => {}),
}));
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../src/account/apiSession', () => ({ getApiSession: () => null }));

type CameraListener = (event: CameraEvent) => void;
const mockCameraListeners = new Set<CameraListener>();

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: jest.fn(),
    importStrokeVideo: jest.fn(),
    cancelCameraOperation: jest.fn(),
    importedPoseExtractionAvailable: jest.fn(() => true),
    extractImportedPoseSequence: jest.fn(),
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
  };
});
jest.mock('../src/camera/TargetSelector', () => ({
  TargetSelector: () => null,
}));
const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  popToTop: jest.fn(),
  navigate: jest.fn(),
};
let mockRouteParams: Record<string, unknown> = {};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: mockRouteParams }),
}));
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: (props: { children?: React.ReactNode }) =>
      React.createElement(View, null, props.children),
  };
});
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Ellipse: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { EnvelopeDimension, EnvelopeVerdict } from '@pickle/shared-types';
import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import { TargetSelector } from '../src/camera/TargetSelector';
import {
  armTryAgain,
  consumeTryAgainHandoff,
} from '../src/screens/tryAgainHandoff';
import {
  assertCapturedClip,
  cancelCameraOperation,
  captureStrokeVideo,
  extractImportedPoseSequence,
  importStrokeVideo,
  type CameraEvent,
  type CapturedClip,
} from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ATTEMPT_1_ID = 'guided-attempt-1-\u{1F3BE}';
const ATTEMPT_2_ID = 'guided-attempt-2-\u{1F3D3}';

const importedClip = assertCapturedClip({
  uri: 'file:///private/var/mobile/import.mov',
  durationMs: 4200,
  fps: 30,
  width: 1920,
  height: 1080,
  capturedAtIso: '2026-08-29T18:00:00.000Z',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
});

function guidedClip(id: string): CapturedClip {
  return {
    uri: `file:///captures/${id}.mov`,
    durationMs: 4200,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso: '2026-08-30T10:00:00.000Z',
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
    targetSeed: { x: 0.5, y: 0.6, source: 'start_region_occupancy' },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: 120,
      poseFrameCount: 120,
      poseMissingFrameCount: 0,
      trackedDurationMs: 4200,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: 120,
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
      frameCount: 120,
      sha256: 'cd'.repeat(32),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

// Abstained outcome keeps the screen on its own 'analyzed' phase (with the
// "Capture another" CTA) instead of navigating away, so one mounted screen
// really runs attempt after attempt.
function abstainedOutcome(analysisId: string) {
  return {
    kind: 'low_confidence',
    analysisId,
    guidance: null,
    record: {
      id: analysisId,
      strokeIntent: {
        declaredStroke: null,
        predictedStroke: null,
        resolutionBasis: 'abstained',
        resolvedProfileId: null,
        resolvedProfileVersion: null,
        disagreement: null,
      },
      result: null,
    },
  };
}

function readinessEvent(captureId: string, atIso: string): CameraEvent {
  return {
    type: 'readiness',
    state: 'ready',
    poseConfidence: 0.9,
    jointCoverage: 0.91,
    stableForMs: 900,
    missingJoints: [],
    source: 'apple_vision_body_pose',
    modelVersion: 'apple-vision-bodypose-1',
    captureId,
    emittedAtIso: atIso,
  };
}

function qualityEvent(captureId: string, atIso: string): CameraEvent {
  return {
    type: 'capture_quality',
    signals: {
      schemaVersion: 1,
      frameWidthPx: 720,
      frameHeightPx: 1280,
      avgFrameRateFps: 59.94,
      brightnessMeanLuma: 128,
      laplacianVarianceMedian: 900,
      meanAbsFrameDiff: 2,
      sampledFrameCount: 30,
    },
    captureId,
    emittedAtIso: atIso,
  };
}

function extractionEvent(
  state: 'extracting' | 'completed' | 'failed',
  options: { progress?: number; captureId?: string; atIso: string },
): CameraEvent {
  return {
    type: 'import_pose_extraction',
    state,
    ...(options.progress !== undefined ? { progress: options.progress } : {}),
    ...(options.captureId !== undefined
      ? { captureId: options.captureId }
      : {}),
    emittedAtIso: options.atIso,
  };
}

// ─── Driving helpers ─────────────────────────────────────────────────────────

function renderedText(renderer: ReactTestRenderer): string {
  const collect = (node: unknown): string => {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(collect).join('');
    const json = node as { children?: unknown[] };
    return (json.children ?? []).map(collect).join('\n');
  };
  return collect(renderer.toJSON());
}

function emit(event: CameraEvent) {
  act(() => {
    for (const listener of mockCameraListeners) listener(event);
  });
}

function progressBarNode(renderer: ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n => n.props.accessibilityRole === 'progressbar',
  );
  if (!node) throw new Error('No progressbar rendered');
  return node;
}

function findPressable(renderer: ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
  return node;
}

function pressByLabel(renderer: ReactTestRenderer, label: string) {
  const node = findPressable(renderer, label);
  act(() => node.props.onPress());
}

function pressButton(renderer: ReactTestRenderer, label: string) {
  const candidates = renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      n.findAll(t => t.type === Text && String(t.props.children) === label)
        .length > 0,
  );
  const node = candidates[candidates.length - 1];
  if (!node) throw new Error(`No button labeled ${label}`);
  return node.props.onPress as () => void;
}

function status(
  envelope: EnvelopeVerdict,
  dimension: EnvelopeDimension,
): string {
  const found = envelope.dimensions.find(d => d.dimension === dimension);
  expect(found).toBeDefined();
  return found!.status;
}

async function renderScreen(
  source: 'library' | 'camera',
): Promise<ReactTestRenderer> {
  mockRouteParams = { source };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  if (source === 'library') {
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    await act(async () => {});
  }
  return renderer;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Controllable capture promise queue — the test owns every resolution. */
const captureGate: {
  resolvers: Array<{
    resolve: (clip: CapturedClip) => void;
    reject: (error: Error) => void;
  }>;
} = { resolvers: [] };

function armCaptureGate() {
  captureGate.resolvers = [];
  (captureStrokeVideo as jest.Mock).mockImplementation(
    () =>
      new Promise<CapturedClip>((resolve, reject) => {
        captureGate.resolvers.push({ resolve, reject });
      }),
  );
}

function deferred<T>(mock: jest.Mock): {
  resolve: (value: T) => Promise<void>;
  reject: (error: Error) => Promise<void>;
  calls: () => number;
} {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: Error) => void;
  mock.mockImplementation(
    () =>
      new Promise<T>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      }),
  );
  return {
    resolve: async value => {
      await act(async () => {
        resolveFn(value);
      });
    },
    reject: async error => {
      await act(async () => {
        rejectFn(error);
      });
    },
    calls: () => mock.mock.calls.length,
  };
}

// Deterministic PRNG for the seeded tap storms (seed recorded in the report).
const SEED = 20260904;
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockCameraListeners.clear();
  consumeTryAgainHandoff();
});

afterEach(() => {
  consumeTryAgainHandoff();
  jest.useRealTimers();
});

// ─── C1 — double tap Start ───────────────────────────────────────────────────

describe('C1 — double-tap / N-tap Start launches exactly one capture', () => {
  it('two synchronous taps on "Open automatic camera" → one captureStrokeVideo', async () => {
    armCaptureGate();
    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');
    const onPress = pressButton(renderer, 'Open automatic camera');

    // The RN touch system can deliver two taps before React re-renders the
    // working surface; both land on the SAME closure.
    act(() => {
      onPress();
      onPress();
    });
    await flush();

    expect(captureStrokeVideo).toHaveBeenCalledTimes(1);
    expect(captureGate.resolvers).toHaveLength(1);
    expect(renderedText(renderer)).toContain('Opening camera…');

    await act(async () => {
      renderer.unmount();
    });
    // Unmount with a live capture cancels the native operation exactly once.
    expect(cancelCameraOperation).toHaveBeenCalledTimes(1);
  });

  it(`seeded tap storm (seed ${SEED}): 32 taps interleaved with microtask yields → one capture`, async () => {
    armCaptureGate();
    const rand = mulberry32(SEED);
    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');
    const onPress = pressButton(renderer, 'Open automatic camera');

    for (let i = 0; i < 32; i += 1) {
      if (rand() < 0.5) {
        act(() => onPress());
      } else {
        await act(async () => {
          onPress();
          await Promise.resolve();
        });
      }
      if (rand() < 0.3) await flush();
    }
    expect(captureStrokeVideo).toHaveBeenCalledTimes(1);

    // Cancel mid-flight: the guard resets and the NEXT deliberate tap is a
    // brand-new attempt (count 2), so the guard never wedges the screen.
    await act(async () => {
      captureGate.resolvers[0]!.reject(
        new Error('camera.cancelled: user cancel'),
      );
    });
    await flush();
    expect(renderedText(renderer)).toContain('Open automatic camera');
    const again = pressButton(renderer, 'Open automatic camera');
    act(() => {
      again();
      again();
      again();
    });
    await flush();
    expect(captureStrokeVideo).toHaveBeenCalledTimes(2);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('taps arriving DURING savePendingCapture (after the clip resolved, before the guard resets) are still ignored', async () => {
    armCaptureGate();
    const repository = jest.requireMock('../src/data/repository') as {
      savePendingCapture: jest.Mock;
    };
    let releaseSave!: () => void;
    repository.savePendingCapture.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releaseSave = resolve;
        }),
    );
    (runCaptureAnalysis as jest.Mock).mockResolvedValue(
      abstainedOutcome('analysis-x'),
    );

    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');
    const onPress = pressButton(renderer, 'Open automatic camera');
    act(() => onPress());
    await flush();
    await act(async () => {
      captureGate.resolvers[0]!.resolve(guidedClip('one'));
    });
    await flush();
    // Capture resolved, save pending: operationActive is still true.
    act(() => {
      onPress();
      onPress();
    });
    await flush();
    expect(captureStrokeVideo).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseSave();
    });
    await flush();
    expect(captureStrokeVideo).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.unmount();
    });
  });
});

// ─── C2 — late attempt-1 signals after attempt 2 began ───────────────────────

describe('C2 — late attempt-1 live-window events after attempt 2 beginAttempt()', () => {
  async function mountAutoRearmed(): Promise<ReactTestRenderer> {
    (runCaptureAnalysis as jest.Mock).mockImplementation(
      (request: { captureId: string }) =>
        Promise.resolve(abstainedOutcome(`analysis-${request.captureId}`)),
    );
    armTryAgain({
      source: 'camera',
      declaredStroke: null,
      declaredCanonical: null,
      auto: true,
      sessionId: null,
    });
    const renderer = await renderScreen('camera');
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(captureGate.resolvers).toHaveLength(1);
    return renderer;
  }

  function envelopeOfCall(index: number): EnvelopeVerdict {
    const call = (runCaptureAnalysis as jest.Mock).mock.calls[index];
    expect(call).toBeDefined();
    return call![0].captureEnvelope as EnvelopeVerdict;
  }

  it('a late attempt-1 capture_quality (stamped with attempt 1 captureId) is NOT attributed to attempt 2', async () => {
    armCaptureGate();
    const renderer = await mountAutoRearmed();

    // Attempt 1's live window: readiness + quality, both stamped attempt 1.
    emit(readinessEvent(ATTEMPT_1_ID, '2026-08-30T10:00:01.000Z'));
    emit(qualityEvent(ATTEMPT_1_ID, '2026-08-30T10:00:01.500Z'));
    await act(async () => {
      captureGate.resolvers[0]!.resolve(guidedClip('one'));
    });
    await flush();
    expect(runCaptureAnalysis).toHaveBeenCalledTimes(1);
    expect(status(envelopeOfCall(0), 'brightness')).not.toBe('NOT_MEASURED');

    // Attempt 2 begins on the same mounted screen.
    pressByLabel(renderer, 'Capture another');
    await flush();
    expect(captureGate.resolvers).toHaveLength(2);

    // ATTACK: a straggler from attempt 1 (its captureId) lands after attempt
    // 2's beginAttempt() and before attempt 2 emits anything of its own.
    emit(qualityEvent(ATTEMPT_1_ID, '2026-08-30T10:00:02.000Z'));
    emit(readinessEvent(ATTEMPT_1_ID, '2026-08-30T10:00:02.100Z'));

    // Attempt 2's own live window stays silent; its clip completes.
    await act(async () => {
      captureGate.resolvers[1]!.resolve(guidedClip('two'));
    });
    await flush();
    expect(runCaptureAnalysis).toHaveBeenCalledTimes(2);
    const second = envelopeOfCall(1);
    // The clip's own configuration is measured from the clip itself…
    expect(status(second, 'resolution')).not.toBe('NOT_MEASURED');
    // …but attempt 1's stale live-window proxies must not be stamped on it.
    // One combined assertion so a failure prints the WHOLE observed picture.
    const liveWindowDimensions: EnvelopeDimension[] = [
      'brightness',
      'motion_blur',
      'camera_motion',
      'player_visibility',
    ];
    const observed = Object.fromEntries(
      liveWindowDimensions.map(d => [d, status(second, d)]),
    );
    expect(observed).toEqual({
      brightness: 'NOT_MEASURED',
      motion_blur: 'NOT_MEASURED',
      camera_motion: 'NOT_MEASURED',
      player_visibility: 'NOT_MEASURED',
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it('control: attempt 2 own-stamped quality IS measured (the filter must not over-reject)', async () => {
    armCaptureGate();
    const renderer = await mountAutoRearmed();
    emit(qualityEvent(ATTEMPT_1_ID, '2026-08-30T10:00:01.500Z'));
    await act(async () => {
      captureGate.resolvers[0]!.resolve(guidedClip('one'));
    });
    await flush();
    pressByLabel(renderer, 'Capture another');
    await flush();
    emit(qualityEvent(ATTEMPT_2_ID, '2026-08-30T10:00:03.000Z'));
    await act(async () => {
      captureGate.resolvers[1]!.resolve(guidedClip('two'));
    });
    await flush();
    expect(runCaptureAnalysis).toHaveBeenCalledTimes(2);
    expect(status(envelopeOfCall(1), 'brightness')).not.toBe('NOT_MEASURED');
    await act(async () => {
      renderer.unmount();
    });
  });
});

// ─── C3 — stale import_pose_extraction completion ────────────────────────────

describe('C3 — stale import_pose_extraction{completed} for a foreign captureId', () => {
  async function startImportRun() {
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
    const extraction = deferred<unknown>(
      extractImportedPoseSequence as jest.Mock,
    );
    const analysis = deferred<unknown>(runCaptureAnalysis as jest.Mock);
    const renderer = await renderScreen('library');
    pressByLabel(renderer, 'Forehand drive');
    const selector = renderer.root.findByType(TargetSelector);
    await act(async () => {
      selector.props.onSkip();
    });
    expect(extraction.calls()).toBe(1);
    expect(
      progressBarNode(renderer).props.accessibilityValue.now,
    ).toBeUndefined();
    return { renderer, extraction, analysis };
  }

  it('stale completed event arriving BEFORE the current pass reported anything must not jump to 100%', async () => {
    const { renderer } = await startImportRun();

    // ATTACK: a previous (abandoned, still-running) native pass finishes.
    // Native import extraction has no cancel path, so its terminal event
    // reaches whichever AnalyzeScreen is mounted now.
    emit(
      extractionEvent('completed', {
        progress: 1,
        captureId: 'stale-import-pass-\u00e9\u00e8',
        atIso: '2026-08-29T18:00:00.500Z',
      }),
    );
    const observed: Array<{ step: string; now: unknown; sublabel: string }> =
      [];
    const record = (step: string) => {
      const text = renderedText(renderer);
      const match = /(\d+%(?: · ~\d+s left)?)/.exec(text);
      observed.push({
        step,
        now: progressBarNode(renderer).props.accessibilityValue.now,
        sublabel: match ? match[1]! : '(indeterminate)',
      });
    };
    record('after stale completed(foreign id)');

    // The CURRENT pass's real events must still drive the bar afterwards.
    emit(
      extractionEvent('extracting', {
        progress: 0.1,
        captureId: 'current-import-pass',
        atIso: '2026-08-29T18:00:01.000Z',
      }),
    );
    record('after current extracting 0.1');
    emit(
      extractionEvent('extracting', {
        progress: 0.5,
        captureId: 'current-import-pass',
        atIso: '2026-08-29T18:00:02.000Z',
      }),
    );
    record('after current extracting 0.5');

    expect(observed).toEqual([
      {
        step: 'after stale completed(foreign id)',
        now: undefined,
        sublabel: '(indeterminate)',
      },
      { step: 'after current extracting 0.1', now: 10, sublabel: '10%' },
      {
        step: 'after current extracting 0.5',
        now: 50,
        sublabel: '50% · ~2s left',
      },
    ]);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('stale completed event arriving AFTER the current pass identified itself is ignored', async () => {
    const { renderer } = await startImportRun();
    emit(
      extractionEvent('extracting', {
        progress: 0.2,
        captureId: 'current-import-pass',
        atIso: '2026-08-29T18:00:01.000Z',
      }),
    );
    expect(progressBarNode(renderer).props.accessibilityValue.now).toBe(20);
    emit(
      extractionEvent('completed', {
        progress: 1,
        captureId: 'stale-import-pass',
        atIso: '2026-08-29T18:00:01.200Z',
      }),
    );
    expect(renderedText(renderer)).not.toContain('100%');
    expect(progressBarNode(renderer).props.accessibilityValue.now).toBe(20);
    // A stale `failed` for a foreign id must not alter the current run either.
    emit(
      extractionEvent('failed', {
        captureId: 'stale-import-pass',
        atIso: '2026-08-29T18:00:01.300Z',
      }),
    );
    expect(progressBarNode(renderer).props.accessibilityValue.now).toBe(20);
    expect(renderedText(renderer)).toContain('Reading player movement');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('a stale completed event has no effect once the current extraction settled (no run armed)', async () => {
    const { renderer, extraction } = await startImportRun();
    emit(
      extractionEvent('extracting', {
        progress: 0.5,
        captureId: 'current-import-pass',
        atIso: '2026-08-29T18:00:01.000Z',
      }),
    );
    await extraction.resolve({
      poseSequence: {
        schemaVersion: 1,
        format: 'pickle.pose-sequence.v1',
        uri: 'file:///private/var/mobile/import.pose.json',
        frameCount: 126,
        sha256: 'ab'.repeat(32),
        coordinateSystem: 'normalized_image_top_left',
        poseModelVersion: 'apple-vision-bodypose-1',
      },
      framesWithPose: 126,
      framesTotal: 126,
    });
    expect(renderedText(renderer)).toContain('Measuring your swing');
    emit(
      extractionEvent('completed', {
        progress: 1,
        captureId: 'current-import-pass',
        atIso: '2026-08-29T18:00:02.000Z',
      }),
    );
    emit(
      extractionEvent('extracting', {
        progress: 0.7,
        captureId: 'anything',
        atIso: '2026-08-29T18:00:02.100Z',
      }),
    );
    // The measuring stage is indeterminate and stays so; no stale % appears.
    expect(renderedText(renderer)).not.toContain('%');
    expect(
      progressBarNode(renderer).props.accessibilityValue.now,
    ).toBeUndefined();
    await act(async () => {
      renderer.unmount();
    });
  });
});

// ─── C4 — hostile progress payloads ──────────────────────────────────────────

describe('C4 — hostile import progress payloads never render NaN/absurd text', () => {
  it('NaN / negative / >1 / Infinity fractions and clock skew are clamped, never crash', async () => {
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
    deferred<unknown>(extractImportedPoseSequence as jest.Mock);
    deferred<unknown>(runCaptureAnalysis as jest.Mock);
    const renderer = await renderScreen('library');
    pressByLabel(renderer, 'Forehand drive');
    const selector = renderer.root.findByType(TargetSelector);
    await act(async () => {
      selector.props.onSkip();
    });
    const id = 'current-\u{1F3BE}-pass';
    const hostile: Array<{ progress: number; atIso: string }> = [
      { progress: 0.1, atIso: '2026-08-29T18:00:00.000Z' },
      // clock goes BACKWARDS 1 hour (device clock skew / NTP correction)
      { progress: 0.2, atIso: '2026-08-29T17:00:00.000Z' },
      { progress: Number.NaN, atIso: '2026-08-29T18:00:02.000Z' },
      { progress: -5, atIso: '2026-08-29T18:00:03.000Z' },
      { progress: 42, atIso: '2026-08-29T18:00:04.000Z' },
      { progress: Number.POSITIVE_INFINITY, atIso: 'not-a-date' },
      { progress: 0.3, atIso: '1970-01-01T00:00:00.000Z' },
      { progress: 0.35, atIso: '2999-12-31T23:59:59.000Z' },
    ];
    for (const sample of hostile) {
      emit(
        extractionEvent('extracting', {
          progress: sample.progress,
          captureId: id,
          atIso: sample.atIso,
        }),
      );
      const text = renderedText(renderer);
      expect(text).not.toMatch(/NaN|Infinity|undefined/);
      const now = progressBarNode(renderer).props.accessibilityValue.now;
      expect(Number.isFinite(now)).toBe(true);
      expect(now).toBeGreaterThanOrEqual(0);
      expect(now).toBeLessThanOrEqual(100);
      // An ETA, when shown, is a positive integer number of seconds.
      const eta = /~(\d+)s left/.exec(text);
      if (eta) expect(Number(eta[1])).toBeGreaterThanOrEqual(1);
    }
    await act(async () => {
      renderer.unmount();
    });
  });
});
