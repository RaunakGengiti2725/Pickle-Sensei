/**
 * Regression pin for xc-ux-a11y-i18n::XC-UAI-06 (Analyze screen).
 *
 *  E1 — the camera `readiness` subscription in AnalyzeScreen used to do an
 *       unconditional `setPhase({ kind: 'working', … })`. A readiness event
 *       that arrived AFTER the screen had entered its `error` phase (a late /
 *       racing native event) replaced the "Nothing was rated." error surface
 *       (and its Try again / Back actions) with a live-coaching caption such
 *       as "Step fully into frame", even though no capture was running.
 *
 * Live capture-window events may caption the `working` surface only while a
 * capture operation is active; they never replace a settled phase.
 *
 * Run: cd apps/mobile && npx jest --ci __tests__/adjudicateXcUxA11yI18nAnalyzeReadiness.test.tsx
 */
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
}));
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../src/account/apiSession', () => ({ getApiSession: () => null }));

type Listener = (event: unknown) => void;
const cameraListeners: Listener[] = [];
jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: jest.fn(),
    importStrokeVideo: jest.fn(),
    cancelCameraOperation: jest.fn(),
    subscribeToCameraEvents: jest.fn((listener: Listener) => {
      cameraListeners.push(listener);
      return () => {
        const index = cameraListeners.indexOf(listener);
        if (index >= 0) cameraListeners.splice(index, 1);
      };
    }),
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
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AnalyzeScreen, READINESS_COPY } from '../src/screens/AnalyzeScreen';
import {
  assertCapturedClip,
  captureStrokeVideo,
  importStrokeVideo,
} from '../src/camera/capture';

const importedClip = assertCapturedClip({
  uri: 'file:///private/var/mobile/import.mov',
  durationMs: 4200,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
});

function textContents(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

async function renderLibraryScreen(): Promise<ReactTestRenderer> {
  mockRouteParams = { source: 'library' };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
  await act(async () => {});
  return renderer;
}

async function renderFailedImport(): Promise<ReactTestRenderer> {
  (importStrokeVideo as jest.Mock).mockRejectedValue(
    new Error('Photos permission denied. Enable access in Settings.'),
  );
  return renderLibraryScreen();
}

function emitReadiness(state: 'no_person' | 'ready'): void {
  const event = {
    type: 'readiness',
    state,
    poseConfidence: state === 'ready' ? 0.9 : 0,
    jointCoverage: state === 'ready' ? 0.93 : 0,
    stableForMs: state === 'ready' ? 300 : 0,
    missingJoints: state === 'ready' ? [] : ['nose'],
    source: 'apple_vision_body_pose',
    emittedAtIso: '2026-09-04T07:00:00.000Z',
  };
  act(() => {
    cameraListeners.forEach(listener => listener(event));
  });
}

describe('E1 — late readiness events never replace a settled Analyze phase', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    cameraListeners.length = 0;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a readiness event while no capture is running leaves the error surface intact', async () => {
    const renderer = await renderFailedImport();
    const before = textContents(renderer);
    expect(before).toContain('Nothing was rated.');
    expect(before).toContain('Photos permission denied');
    expect(before).toContain('Try again');
    expect(cameraListeners.length).toBeGreaterThan(0);

    emitReadiness('no_person');

    const after = textContents(renderer);
    expect(after).toContain('Nothing was rated.');
    expect(after).toContain('Photos permission denied');
    expect(after).toContain('Try again');
    expect(after).not.toContain(READINESS_COPY.no_person);
    await act(async () => {
      renderer.unmount();
    });
  });

  test('a readiness event after the clip is saved leaves the saved surface intact', async () => {
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
    const renderer = await renderLibraryScreen();
    expect(textContents(renderer)).toContain('Capture complete');

    emitReadiness('no_person');

    const after = textContents(renderer);
    expect(after).toContain('Capture complete');
    expect(after).not.toContain(READINESS_COPY.no_person);
    await act(async () => {
      renderer.unmount();
    });
  });

  test('control: readiness events still caption the working surface during an active capture', async () => {
    let resolveCapture!: (value: unknown) => void;
    (captureStrokeVideo as jest.Mock).mockImplementation(
      () =>
        new Promise(resolve => {
          resolveCapture = resolve;
        }),
    );
    mockRouteParams = { source: 'camera' };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<AnalyzeScreen />);
    });
    const [openCamera] = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Open automatic camera' &&
        typeof node.props.onPress === 'function',
    );
    expect(openCamera).toBeDefined();
    await act(async () => {
      openCamera!.props.onPress();
    });
    expect(textContents(renderer)).toContain('Opening camera…');

    emitReadiness('no_person');
    expect(textContents(renderer)).toContain(READINESS_COPY.no_person);

    emitReadiness('ready');
    expect(textContents(renderer)).toContain(READINESS_COPY.ready);

    await act(async () => {
      resolveCapture(importedClip);
    });
    await act(async () => {
      renderer.unmount();
    });
  });
});
