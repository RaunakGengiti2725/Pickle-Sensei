/**
 * XC-UAI-08 — camera readiness telemetry must never overwrite a settled
 * Analyze phase. The native camera keeps emitting `readiness` events for a
 * moment after a capture ends (or when a second listener is still hot); the
 * screen used to answer every one of them with `setPhase({kind: 'working'})`,
 * which wiped the "Nothing was rated." error surface and its "Try again"
 * action, and could yank the idle landing into a phantom working state.
 *
 * Readiness copy is only meaningful while a live capture is actually in
 * flight, so that is the ONLY time it may drive the phase.
 */
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setCaptureTargetSeed: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
  getKv: jest.fn(async () => null),
  setKv: jest.fn(async () => {}),
}));
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../src/account/apiSession', () => ({ getApiSession: () => null }));

type Listener = (event: unknown) => void;
const cameraFake: {
  listener: Listener | null;
  captureResolvers: Array<{
    resolve: (clip: unknown) => void;
    reject: (error: Error) => void;
  }>;
} = { listener: null, captureResolvers: [] };
jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: jest.fn(
      () =>
        new Promise((resolve, reject) => {
          cameraFake.captureResolvers.push({ resolve, reject });
        }),
    ),
    importStrokeVideo: jest.fn(),
    cancelCameraOperation: jest.fn(),
    subscribeToCameraEvents: (listener: Listener) => {
      cameraFake.listener = listener;
      return () => {
        cameraFake.listener = null;
      };
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
import { AnalyzeScreen, READINESS_COPY } from '../src/screens/AnalyzeScreen';
import {
  importStrokeVideo,
  type CameraReadinessState,
} from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';

function textContents(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function readinessEvent(state: CameraReadinessState) {
  return {
    type: 'readiness',
    state,
    poseConfidence: 0.9,
    jointCoverage: 0.93,
    stableForMs: 300,
    missingJoints: [],
    source: 'apple_vision_body_pose',
    modelVersion: 'apple-vision-bodypose-1',
    emittedAtIso: '2026-09-04T18:00:00.000Z',
  };
}

async function emitReadiness(state: CameraReadinessState) {
  expect(cameraFake.listener).not.toBeNull();
  await act(async () => {
    cameraFake.listener!(readinessEvent(state));
  });
}

async function renderScreen(
  params: Record<string, unknown>,
): Promise<ReactTestRenderer> {
  mockRouteParams = params;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  // Library imports auto-launch after a short arming delay.
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
  await act(async () => {});
  return renderer;
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

describe('XC-UAI-08 — readiness telemetry never overwrites a settled phase', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    cameraFake.listener = null;
    cameraFake.captureResolvers = [];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('after an import failure a late readiness event leaves "Nothing was rated." and "Try again" on screen', async () => {
    (importStrokeVideo as jest.Mock).mockRejectedValue(
      new Error('Photos permission denied. Enable access in Settings.'),
    );
    const renderer = await renderScreen({ source: 'library' });
    let rendered = textContents(renderer);
    expect(rendered).toContain('Nothing was rated.');
    expect(rendered).toContain('Photos permission denied');
    expect(rendered).toContain('Try again');

    await emitReadiness('ready');

    rendered = textContents(renderer);
    expect(rendered).toContain('Nothing was rated.');
    expect(rendered).toContain('Photos permission denied');
    expect(rendered).toContain('Try again');
    expect(rendered).not.toContain(READINESS_COPY.ready);
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
    await act(async () => {
      renderer.unmount();
    });
  });

  it('a readiness event on the idle camera landing does not open a phantom working screen', async () => {
    const renderer = await renderScreen({ source: 'camera' });
    expect(textContents(renderer)).toContain('Open automatic camera');

    await emitReadiness('no_person');

    const rendered = textContents(renderer);
    expect(rendered).toContain('Open automatic camera');
    expect(rendered).not.toContain(READINESS_COPY.no_person);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('a readiness event during live capture still updates the working message', async () => {
    const renderer = await renderScreen({ source: 'camera' });
    pressButton(renderer, 'Open automatic camera');
    await act(async () => {});
    expect(cameraFake.captureResolvers).toHaveLength(1);
    expect(textContents(renderer)).toContain('Opening camera…');

    await emitReadiness('no_person');
    expect(textContents(renderer)).toContain(READINESS_COPY.no_person);

    await emitReadiness('ready');
    const rendered = textContents(renderer);
    expect(rendered).toContain(READINESS_COPY.ready);
    expect(rendered).not.toContain(READINESS_COPY.no_person);

    // Ending the capture with a failure settles the error surface; a
    // trailing readiness read from the winding-down camera must not undo it.
    await act(async () => {
      cameraFake.captureResolvers[0]!.reject(
        new Error('The camera session was interrupted.'),
      );
    });
    let settled = textContents(renderer);
    expect(settled).toContain('Nothing was rated.');
    expect(settled).toContain('Try again');

    await emitReadiness('hold_still');
    settled = textContents(renderer);
    expect(settled).toContain('Nothing was rated.');
    expect(settled).toContain('Try again');
    expect(settled).not.toContain(READINESS_COPY.hold_still);
    await act(async () => {
      renderer.unmount();
    });
  });
});
