/**
 * AnalyzeScreen classifies a rejected capture/import by the STRUCTURED code
 * the native bridge rejects with (`camera.cancelled` for every user-cancel
 * path: guided capture, the session sheet, the library picker), never by
 * the wording of the message. A genuine failure whose message happens to
 * contain "cancel" (e.g. `camera.session_failed` — "the capture session was
 * cancelled by the system") is a failure: it reaches the error surface with
 * retry and counts against the camera-startup SLO.
 */
jest.mock('../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));
jest.mock('../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
  setCaptureTargetSeed: jest.fn(async () => {}),
}));
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../src/account/apiSession', () => ({ getApiSession: () => null }));
jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: jest.fn(),
    importStrokeVideo: jest.fn(),
    cancelCameraOperation: jest.fn(),
    subscribeToCameraEvents: jest.fn(() => () => {}),
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
import { Alert, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import {
  captureStrokeVideo,
  importStrokeVideo,
  isCameraCancellation,
} from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';
import { stabilitySlo } from '../src/analysis/stabilityTelemetry';

const capture = captureStrokeVideo as jest.Mock;
const importVideo = importStrokeVideo as jest.Mock;

/** A rejection shaped like React Native's promise `reject(code, message)`. */
function nativeRejection(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function rendered(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function hasButton(renderer: ReactTestRenderer, label: string): boolean {
  return (
    renderer.root.findAll(
      n =>
        typeof n.props.onPress === 'function' &&
        n.findAll(t => t.type === Text && String(t.props.children) === label)
          .length > 0,
    ).length > 0
  );
}

async function pressButton(renderer: ReactTestRenderer, label: string) {
  const candidates = renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      n.findAll(t => t.type === Text && String(t.props.children) === label)
        .length > 0,
  );
  const node = candidates[candidates.length - 1];
  if (!node) throw new Error(`No button labeled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
  await act(async () => {});
}

async function renderScreen(
  source: 'camera' | 'library',
): Promise<ReactTestRenderer> {
  mockRouteParams = { source };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  if (source === 'library') {
    // Library imports auto-launch after a short arming delay (160ms).
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    await act(async () => {});
  }
  return renderer;
}

async function unmount(renderer: ReactTestRenderer) {
  await act(async () => {
    renderer.unmount();
  });
}

function startupFailures() {
  return stabilitySlo
    .events()
    .filter(event => event.kind === 'camera_startup_failed');
}

describe('AnalyzeScreen capture failure classification', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    stabilitySlo.reset();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockRouteParams = {};
  });

  afterEach(() => {
    alertSpy.mockRestore();
    jest.useRealTimers();
  });

  it('camera.session_failed whose message mentions "cancel" is an error with retry and a camera_startup_failed SLO event', async () => {
    capture.mockRejectedValue(
      nativeRejection(
        'camera.session_failed',
        'The capture session was cancelled by the system.',
      ),
    );
    const renderer = await renderScreen('camera');
    await pressButton(renderer, 'Open automatic camera');

    const copy = rendered(renderer);
    expect(copy).toContain('Nothing was rated.');
    expect(copy).toContain('Capture interrupted');
    expect(copy).toContain('The capture session was cancelled by the system.');
    expect(hasButton(renderer, 'Try again')).toBe(true);
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
    expect(startupFailures()).toHaveLength(1);
    expect(startupFailures()[0]).toMatchObject({
      kind: 'camera_startup_failed',
      reason: 'guided_capture_error',
    });

    // Retry relaunches the camera from the error surface.
    capture.mockRejectedValue(
      nativeRejection('camera.cancelled', 'Guided capture was canceled.'),
    );
    await pressButton(renderer, 'Try again');
    expect(capture).toHaveBeenCalledTimes(2);
    expect(rendered(renderer)).not.toContain('Nothing was rated.');
    await unmount(renderer);
  });

  it('a codeless failure is never mistaken for a cancel because of its wording', async () => {
    capture.mockRejectedValue(
      new Error('Recording cancelled: the device ran out of storage.'),
    );
    const renderer = await renderScreen('camera');
    await pressButton(renderer, 'Open automatic camera');

    const copy = rendered(renderer);
    expect(copy).toContain('Nothing was rated.');
    expect(copy).toContain('ran out of storage');
    expect(hasButton(renderer, 'Try again')).toBe(true);
    expect(startupFailures()).toHaveLength(1);
    await unmount(renderer);
  });

  it('camera.cancelled from guided capture returns to ready: no error, no alert, no SLO failure', async () => {
    capture.mockRejectedValue(
      nativeRejection('camera.cancelled', 'Guided capture was canceled.'),
    );
    const renderer = await renderScreen('camera');
    await pressButton(renderer, 'Open automatic camera');

    expect(rendered(renderer)).not.toContain('Nothing was rated.');
    expect(hasButton(renderer, 'Open automatic camera')).toBe(true);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
    expect(startupFailures()).toHaveLength(0);
    await unmount(renderer);
  });

  it('camera.cancelled from the library picker goes back: no error, no alert, no SLO failure', async () => {
    importVideo.mockRejectedValue(
      nativeRejection('camera.cancelled', 'Video import was canceled.'),
    );
    const renderer = await renderScreen('library');

    expect(importVideo).toHaveBeenCalledTimes(1);
    expect(rendered(renderer)).not.toContain('Nothing was rated.');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(startupFailures()).toHaveLength(0);
    await unmount(renderer);
  });

  it('a library import that fails with a "cancel" message but a failure code surfaces the error', async () => {
    importVideo.mockRejectedValue(
      nativeRejection(
        'camera.import_failed',
        'The export was cancelled before the file could be copied.',
      ),
    );
    const renderer = await renderScreen('library');

    const copy = rendered(renderer);
    expect(copy).toContain('Nothing was rated.');
    expect(copy).toContain('before the file could be copied');
    expect(hasButton(renderer, 'Try again')).toBe(true);
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
    // Library failures are not camera-startup failures.
    expect(startupFailures()).toHaveLength(0);
    await unmount(renderer);
  });
});

describe('isCameraCancellation', () => {
  it('is decided by the native code alone', () => {
    expect(
      isCameraCancellation(nativeRejection('camera.cancelled', 'Cancelled.')),
    ).toBe(true);
    expect(
      isCameraCancellation(
        nativeRejection('camera.cancelled', 'Video import ended.'),
      ),
    ).toBe(true);
    expect(
      isCameraCancellation(
        nativeRejection('camera.session_failed', 'Session cancelled.'),
      ),
    ).toBe(false);
    expect(isCameraCancellation(new Error('User cancelled the camera.'))).toBe(
      false,
    );
    expect(isCameraCancellation('cancelled')).toBe(false);
    expect(isCameraCancellation(null)).toBe(false);
    expect(isCameraCancellation({ code: 42 })).toBe(false);
  });
});
