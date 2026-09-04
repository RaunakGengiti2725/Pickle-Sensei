/**
 * Cancel-on-unmount for the native work AnalyzeScreen starts. The imported-
 * video pose extraction runs AFTER the picker has returned, so it is native
 * work in flight with no picker open; leaving the screen (back gesture, tab
 * switch, backgrounding that unmounts) while it runs must cancel it exactly
 * once — and the paths that already cancelled (working-surface X, unmount
 * with the picker open) keep cancelling exactly once. Nothing in flight →
 * nothing to cancel.
 */
jest.mock('../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));
jest.mock('../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
  setCaptureTargetSeed: jest.fn(async () => {}),
  updateCaptureClipPayload: jest.fn(async () => {}),
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
    extractImportedPoseSequence: jest.fn(),
    importedPoseExtractionAvailable: jest.fn(() => true),
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
  captureStrokeVideo,
  cancelCameraOperation,
  extractImportedPoseSequence,
  importStrokeVideo,
} from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';

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

const poseSequence = {
  schemaVersion: 1,
  format: 'pickle.pose-sequence.v1',
  uri: 'file:///private/var/mobile/import.pose.json',
  frameCount: 6,
  sha256: 'a'.repeat(64),
  coordinateSystem: 'normalized_image_top_left',
  poseModelVersion: 'apple-vision-bodypose-1',
};

const capture = captureStrokeVideo as jest.Mock;
const importVideo = importStrokeVideo as jest.Mock;
const extract = extractImportedPoseSequence as jest.Mock;
const analyze = runCaptureAnalysis as jest.Mock;
const cancel = cancelCameraOperation as jest.Mock;

function rendered(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
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

async function pressByLabel(renderer: ReactTestRenderer, label: string) {
  const nodes = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  const node = nodes[nodes.length - 1];
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
  await act(async () => {
    node.props.onPress();
  });
  await act(async () => {});
}

/** Presses a design-system Button whose visible Text equals `label`. */
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

async function unmount(renderer: ReactTestRenderer) {
  await act(async () => {
    renderer.unmount();
  });
  await act(async () => {});
}

/** Deferred native extraction the test settles (or never does). */
function pendingExtraction() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  extract.mockImplementationOnce(
    () =>
      new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      }),
  );
  return {
    resolve: (value: unknown) => resolve(value),
    reject: (reason: unknown) => reject(reason),
  };
}

/**
 * Library source: imports a clip, declares a stroke, skips the tap → the
 * native pose extraction is now in flight (the picker has long returned).
 */
async function renderMidExtraction(): Promise<{
  renderer: ReactTestRenderer;
  extraction: ReturnType<typeof pendingExtraction>;
}> {
  importVideo.mockResolvedValue(importedClip);
  const extraction = pendingExtraction();
  const renderer = await renderScreen('library');
  expect(rendered(renderer)).toContain('Capture complete');
  await pressByLabel(renderer, 'Serve');
  const selector = renderer.root.findByType(TargetSelector);
  await act(async () => {
    selector.props.onSkip();
  });
  await act(async () => {});
  expect(extract).toHaveBeenCalledTimes(1);
  expect(analyze).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  return { renderer, extraction };
}

describe('AnalyzeScreen cancels in-flight native work exactly once', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockRouteParams = {};
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('unmounting while the imported pose extraction is in flight cancels the native pass once', async () => {
    const { renderer, extraction } = await renderMidExtraction();

    await unmount(renderer);
    expect(cancel).toHaveBeenCalledTimes(1);

    // The native pass rejects with the cancel code after the screen is gone:
    // nothing else is issued and the late result is dropped.
    await act(async () => {
      extraction.reject(
        Object.assign(new Error('Camera capture was canceled.'), {
          code: 'camera.cancelled',
        }),
      );
    });
    await act(async () => {});
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(analyze).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
  });

  it('X during extraction cancels once; the unmount that follows adds nothing', async () => {
    const { renderer, extraction } = await renderMidExtraction();

    await pressByLabel(renderer, 'Close');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);

    await unmount(renderer);
    expect(cancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      extraction.resolve({ poseSequence, framesWithPose: 6, framesTotal: 6 });
    });
    await act(async () => {});
    expect(analyze).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('unmounting while the library picker is open cancels once', async () => {
    importVideo.mockImplementation(() => new Promise(() => {}));
    const renderer = await renderScreen('library');
    expect(importVideo).toHaveBeenCalledTimes(1);

    await unmount(renderer);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('unmounting while guided capture is open cancels once', async () => {
    capture.mockImplementation(() => new Promise(() => {}));
    const renderer = await renderScreen('camera');
    await pressButton(renderer, 'Open automatic camera');
    expect(capture).toHaveBeenCalledTimes(1);

    await unmount(renderer);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('issues no cancel when nothing native is in flight', async () => {
    // Ready surface, nothing launched.
    const ready = await renderScreen('camera');
    await unmount(ready);
    expect(cancel).not.toHaveBeenCalled();

    // Picker returned, clip saved, extraction not started.
    importVideo.mockResolvedValue(importedClip);
    const saved = await renderScreen('library');
    expect(rendered(saved)).toContain('Capture complete');
    await unmount(saved);
    expect(cancel).not.toHaveBeenCalled();

    // Extraction finished; only the (non-native) scoring call is pending.
    extract.mockResolvedValue({
      poseSequence,
      framesWithPose: 6,
      framesTotal: 6,
    });
    analyze.mockImplementation(() => new Promise(() => {}));
    const scoring = await renderScreen('library');
    await pressByLabel(scoring, 'Serve');
    const selector = scoring.root.findByType(TargetSelector);
    await act(async () => {
      selector.props.onSkip();
    });
    await act(async () => {});
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(rendered(scoring)).toContain('Measuring your swing…');
    await unmount(scoring);
    expect(cancel).not.toHaveBeenCalled();
  });
});
