/**
 * Adversarial probe for the XC-UAI-06 fix (candidate 49486edf).
 *
 * The fix routes readiness / stroke_detected / processing / import events
 * through `setCapturePhase`, which only captions an ACTIVE `working` phase.
 * The `import_pose_extraction` branch of the SAME camera-event handler still
 * calls `setPhase({ kind: 'working', message: 'Reading player movement…' })`
 * unconditionally for every `extracting` event — including events whose
 * captureId belongs to another run, events that arrive when no extraction is
 * in flight, and events that land on a settled phase.
 *
 * Native (`PickleVideoCapture.extractImportedPoseSequence`) runs the pass on
 * a global queue that `cancel()` does not stop, emitting an `extracting`
 * event at every 10% of progress — so a user who closes Analyze mid-import
 * and re-opens it receives stale events on a screen that owns no run.
 *
 * Expected on a complete fix: a settled phase (error / free_limit / saved /
 * ready landing) is never replaced by a stale extraction event. The
 * `control:` cases pin behaviour the candidate already gets right.
 *
 * Run: cd apps/mobile && npx jest --ci __tests__/attackXcUai06StaleExtractionEvent.test.tsx
 */
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
}));
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../src/data/syncRuntime', () => ({
  triggerOutboxSync: jest.fn(),
}));
jest.mock('../src/review/appStoreReview', () => ({
  reportScoredAnalysisForReview: jest.fn(async () => {}),
}));
jest.mock('../src/state/accessStore', () => {
  const state = {
    status: 'ready',
    canonicalAccess: null,
    refreshAccess: jest.fn(async () => true),
  };
  const useAccessStore = (selector: (s: typeof state) => unknown) =>
    selector(state);
  useAccessStore.getState = () => state;
  return { useAccessStore };
});
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
import { TargetSelector } from '../src/camera/TargetSelector';
import { assertCapturedClip, importStrokeVideo } from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';

const STALE_EXTRACTION_CAPTION = 'Reading player movement…';

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

async function renderScreen(
  source: 'library' | 'camera',
): Promise<ReactTestRenderer> {
  mockRouteParams = { source };
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

async function declareAndScore(renderer: ReactTestRenderer): Promise<void> {
  const radios = renderer.root.findAll(
    node => node.props?.accessibilityRole === 'radio',
  );
  expect(radios.length).toBeGreaterThan(0);
  await act(async () => {
    radios[0]!.props.onPress();
  });
  const selector = renderer.root.findByType(TargetSelector);
  await act(async () => {
    void selector.props.onSkip();
  });
}

function emit(event: Record<string, unknown>): void {
  act(() => {
    cameraListeners.forEach(listener => listener(event));
  });
}

/** A stale native extraction progress event from a run this screen does
 * not own (different captureId, no extractionRun armed). */
function emitStaleExtracting(progress = 0.4): void {
  emit({
    type: 'import_pose_extraction',
    state: 'extracting',
    progress,
    captureId: 'stale-capture-from-a-previous-screen',
    emittedAtIso: '2026-09-04T07:00:00.000Z',
  });
}

function emitReadiness(state: 'no_person' | 'ready'): void {
  emit({
    type: 'readiness',
    state,
    poseConfidence: state === 'ready' ? 0.9 : 0,
    jointCoverage: state === 'ready' ? 0.93 : 0,
    stableForMs: state === 'ready' ? 300 : 0,
    missingJoints: state === 'ready' ? [] : ['nose'],
    source: 'apple_vision_body_pose',
    emittedAtIso: '2026-09-04T07:00:00.000Z',
  });
}

async function unmount(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.unmount();
  });
}

describe('XC-UAI-06 attack — stale import_pose_extraction events vs settled phases', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    cameraListeners.length = 0;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('control: a late readiness event during the free-limit prompt leaves the prompt intact (fix holds)', async () => {
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'scored',
      analysisId: 'analysis-2',
      record: {},
      freeLimitReached: true,
    });
    const renderer = await renderScreen('library');
    await declareAndScore(renderer);
    expect(textContents(renderer)).toContain(
      'That was your last free analysis.',
    );

    emitReadiness('no_person');

    const after = textContents(renderer);
    expect(after).toContain('That was your last free analysis.');
    expect(after).toContain('See my score');
    expect(after).not.toContain(READINESS_COPY.no_person);
    await unmount(renderer);
  });

  test('a stale extracting event during the error phase must not replace "Nothing was rated." and Try again', async () => {
    (importStrokeVideo as jest.Mock).mockRejectedValue(
      new Error('Photos permission denied. Enable access in Settings.'),
    );
    const renderer = await renderScreen('library');
    const before = textContents(renderer);
    expect(before).toContain('Nothing was rated.');
    expect(before).toContain('Try again');
    expect(cameraListeners.length).toBeGreaterThan(0);

    emitStaleExtracting();

    const after = textContents(renderer);
    expect(after).toContain('Nothing was rated.');
    expect(after).toContain('Photos permission denied');
    expect(after).toContain('Try again');
    expect(after).not.toContain(STALE_EXTRACTION_CAPTION);
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
    await unmount(renderer);
  });

  test('a stale extracting event during the free-limit prompt must not tear the upgrade prompt down', async () => {
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'scored',
      analysisId: 'analysis-3',
      record: {},
      freeLimitReached: true,
    });
    const renderer = await renderScreen('library');
    await declareAndScore(renderer);
    expect(textContents(renderer)).toContain(
      'That was your last free analysis.',
    );

    emitStaleExtracting();

    const after = textContents(renderer);
    expect(after).toContain('That was your last free analysis.');
    expect(after).toContain('See my score');
    expect(after).not.toContain(STALE_EXTRACTION_CAPTION);
    await unmount(renderer);
  });

  test('a stale extracting event after the clip is saved must not replace the saved surface', async () => {
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
    const renderer = await renderScreen('library');
    expect(textContents(renderer)).toContain('Capture complete');

    emitStaleExtracting();

    const after = textContents(renderer);
    expect(after).toContain('Capture complete');
    expect(after).not.toContain(STALE_EXTRACTION_CAPTION);
    await unmount(renderer);
  });

  test('a stale extracting event on the camera landing (no run owned) must not turn the landing into an analyzing screen', async () => {
    const renderer = await renderScreen('camera');
    const landingButtons = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Open automatic camera' &&
        typeof node.props.onPress === 'function',
    );
    expect(landingButtons.length).toBeGreaterThan(0);
    expect(cameraListeners.length).toBeGreaterThan(0);

    emitStaleExtracting(0.1);

    const after = textContents(renderer);
    expect(after).not.toContain(STALE_EXTRACTION_CAPTION);
    expect(
      renderer.root.findAll(
        node =>
          node.props.accessibilityLabel === 'Open automatic camera' &&
          typeof node.props.onPress === 'function',
      ).length,
    ).toBeGreaterThan(0);
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
    await unmount(renderer);
  });
});
