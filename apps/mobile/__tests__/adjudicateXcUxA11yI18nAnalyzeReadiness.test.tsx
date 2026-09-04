/**
 * Adjudication reproduction for area xc-ux-a11y-i18n (Analyze screen).
 *
 *  E1 — the camera `readiness` subscription in AnalyzeScreen unconditionally
 *       does `setPhase({ kind: 'working', … })`. A readiness event that
 *       arrives AFTER the screen has entered its `error` phase (a late/racing
 *       native event) replaces the "Nothing was rated." error surface (and
 *       its Try again / Back actions) with a live-coaching caption such as
 *       "Step fully into frame", even though no capture is running.
 *
 * The `test.failing` block asserts the EXPECTED behaviour and must be flipped
 * to a plain `test` by the fix.
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
import { importStrokeVideo } from '../src/camera/capture';

function textContents(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

async function renderFailedImport(): Promise<ReactTestRenderer> {
  (importStrokeVideo as jest.Mock).mockRejectedValue(
    new Error('Photos permission denied. Enable access in Settings.'),
  );
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

function emitLateReadiness(): void {
  const event = {
    type: 'readiness',
    state: 'no_person',
    poseConfidence: 0,
    jointCoverage: 0,
    stableForMs: 0,
    missingJoints: ['nose'],
    source: 'apple_vision_body_pose',
    emittedAtIso: '2026-09-04T07:00:00.000Z',
  };
  act(() => {
    cameraListeners.forEach(listener => listener(event));
  });
}

describe('E1 — late readiness event overwrites the Analyze error surface', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    cameraListeners.length = 0;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('reproduction: error phase ("Nothing was rated." + Try again) is replaced by a live-coaching caption', async () => {
    const renderer = await renderFailedImport();
    const before = textContents(renderer);
    expect(before).toContain('Nothing was rated.');
    expect(before).toContain('Photos permission denied');
    expect(before).toContain('Try again');
    expect(cameraListeners.length).toBeGreaterThan(0);

    emitLateReadiness();

    const after = textContents(renderer);
    expect(after).toContain(READINESS_COPY.no_person);
    expect(after).not.toContain('Nothing was rated.');
    expect(after).not.toContain('Photos permission denied');
    expect(after).not.toContain('Try again');
    await act(async () => {
      renderer.unmount();
    });
  });

  test.failing(
    'expected: a readiness event while no capture is running leaves the error surface intact',
    async () => {
      const renderer = await renderFailedImport();
      emitLateReadiness();
      const after = textContents(renderer);
      expect(after).toContain('Nothing was rated.');
      expect(after).toContain('Try again');
      expect(after).not.toContain(READINESS_COPY.no_person);
      await act(async () => {
        renderer.unmount();
      });
    },
  );
});
