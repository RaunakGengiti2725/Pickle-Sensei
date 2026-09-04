/**
 * STRUCTURAL AUDIT #2 (mobile-analyze-capture) — AnalyzeScreen lifecycle,
 * cancellation classification and attempt-evidence correlation.
 *
 * Mounted-flow reproductions on the typed camera seam (native execution is
 * BLOCKED_EXTERNAL on Linux). runCaptureAnalysis is replaced so the envelope
 * the screen hands it can be inspected; everything above it runs for real.
 */
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
  setCaptureTargetSeed: jest.fn(async () => {}),
  updateCaptureClipPayload: jest.fn(async () => {}),
}));
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));

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
import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import { TargetSelector } from '../src/camera/TargetSelector';
import {
  assertCapturedClip,
  cancelCameraOperation,
  captureStrokeVideo,
  extractImportedPoseSequence,
  importStrokeVideo,
  type CameraEvent,
  type CameraReadinessState,
  type CapturedClip,
} from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../src/billing/types';
import type { EnvelopeVerdict } from '@pickle/shared-types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

function guidedClip(): CapturedClip {
  return {
    uri: 'file:///captures/guided.mov',
    durationMs: 2700,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-08-29T18:00:00.000Z',
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
      analysisInputFrameCount: 120,
      poseFrameCount: 120,
      poseMissingFrameCount: 0,
      trackedDurationMs: 2700,
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
      uri: 'file:///captures/guided.pose.json',
      frameCount: 120,
      sha256: 'cd'.repeat(32),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

const eventBase = () => ({ emittedAtIso: '2026-08-29T18:00:00.000Z' });

function readinessEvent(
  state: CameraReadinessState,
  jointCoverage: number,
): CameraEvent {
  return {
    ...eventBase(),
    type: 'readiness',
    state,
    poseConfidence: 0.9,
    jointCoverage,
    stableForMs: 300,
    missingJoints: [],
    source: 'apple_vision_body_pose',
    modelVersion: 'apple-vision-bodypose-1',
  };
}

function strokeDetectedEvent(): CameraEvent {
  return {
    ...eventBase(),
    type: 'stroke_detected',
    startTimestampMs: 2000,
    endTimestampMs: 2700,
    peakMotionTimestampMs: 2400,
    confidence: 0.86,
    detectionModelVersion: 'temporal-stroke-heuristic-2',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
  };
}

// ─── Driving helpers ─────────────────────────────────────────────────────────

function textOf(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function emit(event: CameraEvent) {
  act(() => {
    for (const listener of mockCameraListeners) listener(event);
  });
}

function pressByLabel(renderer: ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
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
  act(() => node.props.onPress());
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

function deferred<T>(mock: jest.Mock): {
  resolve: (value: T) => Promise<void>;
  reject: (error: Error) => Promise<void>;
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
  };
}

/** Error shaped like a React Native native-module rejection: `code` is the
 * machine-readable reason, `message` is human copy. */
function nativeRejection(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function freeAccess(used: number, reserved = 0): CanonicalAccessState {
  const remaining = 2 - used;
  const availableToReserve = remaining - reserved;
  return {
    premium: false,
    entitlements: [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating: availableToReserve > 0,
    paywallRequired: availableToReserve <= 0,
  };
}

function accessBackend(
  getAccess: () => Promise<CanonicalAccessState>,
): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => {
        throw new Error('plans are not part of this test');
      }),
      purchase: jest.fn(),
      restore: jest.fn(),
      readEntitlement: jest.fn(),
    },
    backend: { getAccess: jest.fn(getAccess), syncBilling: jest.fn() },
  };
}

const owner = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockCameraListeners.clear();
  clearAccessStoreConfiguration();
  clearApiSession();
});

afterEach(() => {
  jest.useRealTimers();
  clearAccessStoreConfiguration();
  clearApiSession();
});

// ─── Unmount during the imported pose pass ───────────────────────────────────

describe('unmount while the imported pose extraction is in flight', () => {
  it('cancels the active native work (REVIEW.md: async work a screen starts is cancelled on unmount)', async () => {
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
    const extraction = deferred<unknown>(
      extractImportedPoseSequence as jest.Mock,
    );
    const renderer = await renderScreen('library');
    pressByLabel(renderer, 'Forehand drive');
    const selector = renderer.root.findByType(TargetSelector);
    await act(async () => {
      selector.props.onSkip();
    });
    expect(extractImportedPoseSequence).toHaveBeenCalledTimes(1);
    expect(textOf(renderer)).toContain('Reading player movement');

    // Backgrounding / navigation tears the screen down mid-pass.
    await act(async () => renderer.unmount());

    // Contract under test: the native pass started by this screen is
    // cancelled when the screen goes away, exactly like the capture path.
    expect(cancelCameraOperation).toHaveBeenCalled();

    // Late settle must stay silent (no routing after unmount).
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
    });
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
  });

  it('VERIFY: after unmount a late extraction result never starts an analysis or navigates', async () => {
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
    const extraction = deferred<unknown>(
      extractImportedPoseSequence as jest.Mock,
    );
    const renderer = await renderScreen('library');
    pressByLabel(renderer, 'Forehand drive');
    const selector = renderer.root.findByType(TargetSelector);
    await act(async () => {
      selector.props.onSkip();
    });
    await act(async () => renderer.unmount());
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
    });
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
  });
});

// ─── Cancellation classification ────────────────────────────────────────────

describe('capture failure vs user cancellation', () => {
  it('VERIFY control: a native camera.cancelled rejection returns to the ready surface silently', async () => {
    const capture = deferred<CapturedClip>(captureStrokeVideo as jest.Mock);
    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');
    pressButton(renderer, 'Open automatic camera');
    await capture.reject(
      nativeRejection('camera.cancelled', 'Camera capture was canceled.'),
    );
    expect(textOf(renderer)).toContain('AUTOMATIC CAPTURE');
    expect(textOf(renderer)).not.toContain('Try again');
  });

  it('a genuine failure whose message merely contains "cancel" must surface as an error, not be swallowed as a user cancel', async () => {
    const capture = deferred<CapturedClip>(captureStrokeVideo as jest.Mock);
    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');
    pressButton(renderer, 'Open automatic camera');
    // Not a user action: the native code is a hard failure. The message is
    // the kind of copy a system interruption produces.
    const message =
      'Recording stopped: the capture session was cancelled by the system during a phone call.';
    await capture.reject(nativeRejection('camera.session_interrupted', message));
    const text = textOf(renderer);
    // Expected: the error surface with this message and a retry affordance.
    expect(text).toContain('cancelled by the system');
    expect(text).toContain('Try again');
  });
});

// ─── Attempt evidence correlation ───────────────────────────────────────────

describe('attempt envelope evidence after the stroke was detected', () => {
  it('a readiness read arriving AFTER stroke_detected must not overwrite the swing-time visibility handed to the analysis', async () => {
    const capture = deferred<CapturedClip>(captureStrokeVideo as jest.Mock);
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'unavailable',
      reason: 'stubbed',
    });
    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');
    pressButton(renderer, 'Open automatic camera');
    emit(readinessEvent('ready', 0.92));
    emit(strokeDetectedEvent());
    // The player walks toward the phone while the clip finalizes.
    emit(readinessEvent('no_person', 0));
    await capture.resolve(guidedClip());
    await act(async () => {});

    expect(runCaptureAnalysis).toHaveBeenCalledTimes(1);
    const request = (runCaptureAnalysis as jest.Mock).mock.calls[0]![0] as {
      captureEnvelope: EnvelopeVerdict | null;
    };
    const visibility = request.captureEnvelope?.dimensions.find(
      d => d.dimension === 'player_visibility',
    );
    expect(visibility).toBeDefined();
    // The swing itself was recorded at 0.92 coverage (and the clip's own
    // captureEvidence says meanJointCoverage 0.9); the post-swing no_person
    // read is not evidence about the swing.
    expect(visibility?.status).not.toBe('UNSUPPORTED');
  });

  it('VERIFY control: readiness before the stroke feeds the attempt envelope (ready 0.92 → SUPPORTED visibility)', async () => {
    const capture = deferred<CapturedClip>(captureStrokeVideo as jest.Mock);
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'unavailable',
      reason: 'stubbed',
    });
    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');
    pressButton(renderer, 'Open automatic camera');
    emit(readinessEvent('ready', 0.92));
    emit(strokeDetectedEvent());
    await capture.resolve(guidedClip());
    await act(async () => {});
    const request = (runCaptureAnalysis as jest.Mock).mock.calls[0]![0] as {
      captureEnvelope: EnvelopeVerdict | null;
    };
    const visibility = request.captureEnvelope?.dimensions.find(
      d => d.dimension === 'player_visibility',
    );
    expect(visibility?.status).toBe('SUPPORTED');
  });
});

// ─── Unmount access re-read vs an in-flight run ─────────────────────────────

describe('unmount access re-read timing', () => {
  it('the ledger re-read on unmount must observe the settled run, not race the permit that is still being reserved/consumed', async () => {
    establishApiSession({
      apiBaseUrl: 'https://api.test',
      bearerToken: 'token-1',
      canonicalAppUserId: owner,
      provider: 'apple',
    });
    const clients = accessBackend(async () => freeAccess(1, 0));
    configureAccessStore(clients);
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: freeAccess(0),
    });

    const analysis = deferred<unknown>(runCaptureAnalysis as jest.Mock);
    (captureStrokeVideo as jest.Mock).mockResolvedValue(guidedClip());
    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');
    pressButton(renderer, 'Open automatic camera');
    await act(async () => {});
    await act(async () => {});
    expect(runCaptureAnalysis).toHaveBeenCalledTimes(1);

    // The screen is torn down with runCaptureAnalysis still in flight (the
    // permit reservation/consumption has NOT settled yet).
    await act(async () => renderer.unmount());
    const refreshesBeforeSettle = (clients.backend.getAccess as jest.Mock).mock
      .calls.length;

    await analysis.resolve({
      kind: 'scored',
      analysisId: 'analysis-1',
      record: {},
      freeLimitReached: false,
    });
    await act(async () => {});

    // Expected: GET /v1/me/access is issued only once the run has settled,
    // so the snapshot it returns reflects the consumed/released permit.
    expect(refreshesBeforeSettle).toBe(0);
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
  });
});
