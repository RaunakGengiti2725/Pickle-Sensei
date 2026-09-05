/**
 * Structural audit #1 (mobile-analyze-capture) — how AnalyzeScreen's `run()`
 * classifies a failure raised by the guided-capture path.
 *
 * Two contracts are exercised:
 *  1. User cancellation is detected by `message.includes('cancel')`
 *     (AnalyzeScreen.tsx:1036), not by the native error code
 *     (`camera.cancelled`). A genuine native FAILURE whose message happens to
 *     contain the word "cancel" (e.g. an AVFoundation export that reports
 *     "The operation was cancelled" while the app is suspended) must still be
 *     surfaced as an error with retry — never silently reset to Ready.
 *  2. `stabilitySlo` camera-startup attribution: once the native capture has
 *     RESOLVED (`camera_startup_succeeded` recorded), a later failure in the
 *     same try block (`savePendingCapture` writing SQLite) is not a camera
 *     startup failure and must not be recorded as `camera_startup_failed`.
 */
jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/data/repository', () => ({
  savePendingCapture: jest.fn(() => Promise.resolve()),
  setCaptureTargetSeed: jest.fn(() => Promise.resolve()),
  setDeclaredStroke: jest.fn(() => Promise.resolve()),
  getKv: jest.fn(() => Promise.resolve(null)),
  setKv: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: jest.fn(() => null),
}));
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

const mockNavigation = {
  replace: jest.fn(),
  navigate: jest.fn(),
  goBack: jest.fn(),
  popToTop: jest.fn(),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { source: 'camera' } }),
}));

jest.mock('../../src/camera/capture', () => ({
  subscribeToCameraEvents: () => () => {},
  captureStrokeVideo: jest.fn(),
  importStrokeVideo: jest.fn(),
  cancelCameraOperation: jest.fn(),
}));

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import {
  armTryAgain,
  consumeTryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';
import { captureStrokeVideo } from '../../src/camera/capture';
import { savePendingCapture } from '../../src/data/repository';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import { usabilityFunnel } from '../../src/analysis/usabilityTelemetry';

const captureMock = captureStrokeVideo as jest.Mock;
const saveMock = savePendingCapture as jest.Mock;

/** A native rejection as RN delivers it: `.code` beside the message. */
function nativeError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function guidedClip() {
  return {
    uri: 'file:///private/clip-1.mov',
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
    targetSeed: { x: 0.5, y: 0.6 },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///private/clip-1.pose.json',
      frameCount: 6,
      sha256: 'a'.repeat(64),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

function rendered(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

async function mountReArmedCameraScreen(): Promise<TestRenderer.ReactTestRenderer> {
  armTryAgain({
    source: 'camera',
    declaredStroke: 'forehand_drive',
    declaredCanonical: null,
    auto: false,
    sessionId: null,
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe('structural audit #1 — AnalyzeScreen run() failure classification', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    stabilitySlo.reset();
    usabilityFunnel.reset();
  });

  afterEach(() => {
    consumeTryAgainHandoff();
    jest.useRealTimers();
  });

  it('a genuine native failure whose message contains "cancel" is surfaced as an error, not treated as a user cancel', async () => {
    captureMock.mockRejectedValueOnce(
      nativeError(
        'camera.processing_failed',
        'The captured stroke could not be prepared: the export operation was cancelled by the system.',
      ),
    );
    const renderer = await mountReArmedCameraScreen();

    const text = rendered(renderer);
    const steps = usabilityFunnel.events().map(e => e.step);
    const stability = stabilitySlo.events().map(e => e.kind);

    expect(steps).toContain('error_shown');
    expect(steps).not.toContain('attempt_abandoned');
    expect(stability).toContain('camera_startup_failed');
    expect(text).toContain('Nothing was rated.');
    expect(text).toContain('Try again');
    expect(runCaptureAnalysis).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });

  it('the real user cancel (code camera.cancelled) still recovers to Ready without an error surface', async () => {
    captureMock.mockRejectedValueOnce(
      nativeError('camera.cancelled', 'Guided capture was canceled.'),
    );
    const renderer = await mountReArmedCameraScreen();

    const steps = usabilityFunnel.events().map(e => e.step);
    expect(steps).toContain('attempt_abandoned');
    expect(steps).not.toContain('error_shown');
    expect(stabilitySlo.events().map(e => e.kind)).not.toContain(
      'camera_startup_failed',
    );
    expect(rendered(renderer)).not.toContain('Nothing was rated.');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('a savePendingCapture failure after a successful capture is not counted as a camera startup failure', async () => {
    captureMock.mockResolvedValueOnce(guidedClip());
    saveMock.mockRejectedValueOnce(
      new Error('SQLITE_FULL: database or disk is full'),
    );
    const renderer = await mountReArmedCameraScreen();

    const stability = stabilitySlo.events().map(e => e.kind);
    expect(stability).toContain('camera_startup_succeeded');
    expect(stability).not.toContain('camera_startup_failed');
    // The failure itself IS surfaced honestly — nothing was rated.
    expect(rendered(renderer)).toContain('Nothing was rated.');
    expect(runCaptureAnalysis).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });
});
