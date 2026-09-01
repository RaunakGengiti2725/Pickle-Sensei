/**
 * Workflow audit — offline / network-error resilience (AnalyzeScreen).
 *
 * The rating permit is server-gated. When the rating service is unreachable
 * (airplane mode, timeout, 5xx) or the session has expired (401), the real
 * AnalyzeScreen must land in a typed error phase with visible copy, offer
 * Try again + Close, never navigate to a Result, and never leave a spinner.
 */
jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
}));
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));
jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: jest.fn(),
    importStrokeVideo: jest.fn(),
    cancelCameraOperation: jest.fn(),
    subscribeToCameraEvents: jest.fn(() => () => {}),
  };
});
jest.mock('../../src/camera/TargetSelector', () => ({
  TargetSelector: () => null,
}));
const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  popToTop: jest.fn(),
  navigate: jest.fn(),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { source: 'library' } }),
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
import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import { TargetSelector } from '../../src/camera/TargetSelector';
import {
  assertCapturedClip,
  importStrokeVideo,
} from '../../src/camera/capture';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import { Button } from '../../src/design/components';

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

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function buttonLabelled(renderer: ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

async function renderAndScore(): Promise<ReactTestRenderer> {
  (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  // Library imports auto-launch after a short arming delay.
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
  await act(async () => {});
  const radios = renderer.root.findAll(
    node => node.props?.accessibilityRole === 'radio',
  );
  await act(async () => {
    radios[0]!.props.onPress();
  });
  const selector = renderer.root.findByType(TargetSelector);
  await act(async () => {
    selector.props.onSkip();
  });
  return renderer;
}

describe('AnalyzeScreen — rating service unreachable', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => jest.useRealTimers());

  it('offline permit reservation → typed error phase with copy, Try again and Close, no Result navigation', async () => {
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'unavailable',
      reason:
        'The rating service could not be reached. Your capture is saved and can be scored later.',
    });
    const renderer = await renderAndScore();
    const copy = allText(renderer);
    expect(copy).toContain('Nothing was rated.');
    expect(copy).toContain('The rating service could not be reached.');
    expect(copy).not.toContain('Measuring');
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(
      renderer.root.findAll(n => n.props.accessibilityRole === 'alert').length,
    ).toBeGreaterThan(0);
    expect(buttonLabelled(renderer, 'Try again').props.onPress).toEqual(
      expect.any(Function),
    );
    await act(async () => {
      buttonLabelled(renderer, 'Close').props.onPress();
    });
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('timeout (408 network.timeout) thrown from the pipeline → visible copy, retry offered', async () => {
    (runCaptureAnalysis as jest.Mock).mockRejectedValue(
      new Error(
        'The server took too long to respond. Your work is saved on this device — try again when the connection recovers.',
      ),
    );
    const renderer = await renderAndScore();
    const copy = allText(renderer);
    expect(copy).toContain('Nothing was rated.');
    expect(copy).toContain('took too long to respond');
    expect(buttonLabelled(renderer, 'Try again')).toBeTruthy();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    await act(async () => {
      renderer.unmount();
    });
  });

  it('401 expired session during scoring → the server message is shown and nothing is rated', async () => {
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'unavailable',
      reason: 'The identity token could not be verified.',
    });
    const renderer = await renderAndScore();
    const copy = allText(renderer);
    expect(copy).toContain('Nothing was rated.');
    expect(copy).toContain('The identity token could not be verified.');
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    await act(async () => {
      renderer.unmount();
    });
  });
});
