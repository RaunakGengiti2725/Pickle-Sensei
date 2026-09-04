/**
 * Structural audit #1 (mobile-analyze-capture) — unmount while an imported
 * clip's native pose-extraction pass is in flight.
 *
 * AnalyzeScreen's unmount cleanup cancels native camera work only when
 * `operationActive` is set (AnalyzeScreen.tsx:1081-1087). That ref covers the
 * capture/import promise inside `run()`, but `scoreCapture()` is fired with
 * `void` and runs the imported pose extraction AFTER `run()`'s finally block
 * reset the ref — so leaving the screen mid-extraction issues no cancel. The
 * working-screen Close control, by contrast, cancels unconditionally.
 */
jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
  setCaptureTargetSeed: jest.fn(async () => {}),
  updateCaptureClipPayload: jest.fn(async () => {}),
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
    importedPoseExtractionAvailable: jest.fn(() => true),
    extractImportedPoseSequence: jest.fn(),
    subscribeToCameraEvents: () => () => {},
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
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import { TargetSelector } from '../../src/camera/TargetSelector';
import { ScreenHeader } from '../../src/design/components';
import {
  assertCapturedClip,
  cancelCameraOperation,
  extractImportedPoseSequence,
  importStrokeVideo,
} from '../../src/camera/capture';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';

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

function pressByLabel(renderer: ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
  act(() => node.props.onPress());
}

async function renderLibraryScreenInExtraction(): Promise<ReactTestRenderer> {
  (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
  (extractImportedPoseSequence as jest.Mock).mockImplementation(
    () => new Promise(() => {}),
  );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
  await act(async () => {});
  pressByLabel(renderer, 'Forehand drive');
  const selector = renderer.root.findByType(TargetSelector);
  await act(async () => {
    selector.props.onSkip();
  });
  expect(extractImportedPoseSequence).toHaveBeenCalledTimes(1);
  expect(runCaptureAnalysis).not.toHaveBeenCalled();
  return renderer;
}

describe('structural audit #1 — leaving AnalyzeScreen during imported pose extraction', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('unmounting while the native extraction pass is in flight cancels the native work', async () => {
    const renderer = await renderLibraryScreenInExtraction();
    await act(async () => {
      renderer.unmount();
    });
    expect(cancelCameraOperation).toHaveBeenCalled();
  });

  it('the working-screen Close control cancels unconditionally during extraction', async () => {
    const renderer = await renderLibraryScreenInExtraction();
    const header = renderer.root.findByType(ScreenHeader);
    await act(async () => {
      header.props.onClose();
    });
    expect(cancelCameraOperation).toHaveBeenCalledTimes(1);
    expect(mockNavigation.goBack).toHaveBeenCalled();
    await act(async () => {
      renderer.unmount();
    });
  });
});
