/**
 * AnalyzeScreen progress surface — mounted-flow certification that the REAL
 * native `import_pose_extraction` events drive the displayed percentage/ETA
 * for the active pass, and that both entry points (guided camera capture and
 * imported video) show the honest staged bar while `runCaptureAnalysis` is
 * in flight. Native execution is BLOCKED_EXTERNAL; the camera seam is driven
 * through its typed event contract exactly like the existing flow harnesses
 * (gate11AnalyzeScreenFailure / analyzeScreenFullFlowE2E patterns).
 */
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
  setCaptureTargetSeed: jest.fn(async () => {}),
}));
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../src/account/apiSession', () => ({ getApiSession: () => null }));

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
  captureStrokeVideo,
  extractImportedPoseSequence,
  importStrokeVideo,
  type CameraEvent,
  type CapturedClip,
} from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';

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

const extractedPoseSequence = {
  schemaVersion: 1,
  format: 'pickle.pose-sequence.v1',
  uri: 'file:///private/var/mobile/import.pose.json',
  frameCount: 126,
  sha256: 'ab'.repeat(32),
  coordinateSystem: 'normalized_image_top_left',
  poseModelVersion: 'apple-vision-bodypose-1',
};

function guidedClip(): CapturedClip {
  return {
    uri: 'file:///captures/guided.mov',
    durationMs: 4200,
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
      trackedDurationMs: 4200,
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

// ─── Driving helpers ─────────────────────────────────────────────────────────

/** Rendered TEXT content only — style objects (e.g. width '100%') excluded. */
function renderedText(renderer: ReactTestRenderer): string {
  const collect = (node: unknown): string => {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(collect).join('');
    const json = node as { children?: unknown[] };
    return (json.children ?? []).map(collect).join('\n');
  };
  return collect(renderer.toJSON());
}

function emit(event: CameraEvent) {
  act(() => {
    for (const listener of mockCameraListeners) listener(event);
  });
}

function extractionEvent(
  state: 'extracting' | 'completed' | 'failed',
  options: { progress?: number; captureId?: string; atIso: string },
): CameraEvent {
  return {
    type: 'import_pose_extraction',
    state,
    ...(options.progress !== undefined ? { progress: options.progress } : {}),
    ...(options.captureId !== undefined
      ? { captureId: options.captureId }
      : {}),
    emittedAtIso: options.atIso,
  };
}

function progressBarNode(renderer: ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n => n.props.accessibilityRole === 'progressbar',
  );
  if (!node) throw new Error('No progressbar rendered');
  return node;
}

function progressBarCount(renderer: ReactTestRenderer): number {
  // De-duplicated by host elements: composite + host both carry the role.
  return renderer.root.findAll(
    n =>
      n.props.accessibilityRole === 'progressbar' &&
      typeof n.type === 'string',
  ).length;
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
    // Library imports auto-launch after a short arming delay.
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

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockCameraListeners.clear();
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── Import flow: real native events drive percentage + ETA ─────────────────

describe('imported-video extraction progress', () => {
  it('native import_pose_extraction events update the displayed percentage and ETA for the active pass', async () => {
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
    const extraction = deferred<unknown>(
      extractImportedPoseSequence as jest.Mock,
    );
    const analysis = deferred<unknown>(runCaptureAnalysis as jest.Mock);

    const renderer = await renderScreen('library');
    pressByLabel(renderer, 'Forehand drive');
    const selector = renderer.root.findByType(TargetSelector);
    await act(async () => {
      selector.props.onSkip();
    });

    // Extraction armed, no native event yet: honest indeterminate state —
    // the caption and stage label, but NO percentage and NO ETA.
    expect(renderedText(renderer)).toContain('Reading player movement…');
    expect(renderedText(renderer)).toContain('Reading player movement');
    expect(renderedText(renderer)).not.toContain('%');
    expect(
      progressBarNode(renderer).props.accessibilityValue.now,
    ).toBeUndefined();

    // First REAL native event: percentage appears; still no ETA (a rate
    // needs two observations before "~Ns left" may be shown).
    emit(
      extractionEvent('extracting', {
        progress: 0.1,
        captureId: 'native-pass-1',
        atIso: '2026-08-29T18:00:00.000Z',
      }),
    );
    expect(renderedText(renderer)).toContain('10%');
    expect(renderedText(renderer)).not.toContain('s left');
    expect(progressBarNode(renderer).props.accessibilityValue.now).toBe(10);

    // Second event: measured rate 10%/s → remaining 0.8 → "~8s left".
    emit(
      extractionEvent('extracting', {
        progress: 0.2,
        captureId: 'native-pass-1',
        atIso: '2026-08-29T18:00:01.000Z',
      }),
    );
    expect(renderedText(renderer)).toContain('20% · ~8s left');

    // Third event is faster; the EMA recomputes rather than freezing.
    emit(
      extractionEvent('extracting', {
        progress: 0.4,
        captureId: 'native-pass-1',
        atIso: '2026-08-29T18:00:02.000Z',
      }),
    );
    expect(renderedText(renderer)).toContain('40% · ~5s left');
    expect(progressBarNode(renderer).props.accessibilityValue.now).toBe(40);

    // A racing event from a DIFFERENT pass never drives this run's bar.
    emit(
      extractionEvent('extracting', {
        progress: 0.9,
        captureId: 'someone-elses-pass',
        atIso: '2026-08-29T18:00:03.000Z',
      }),
    );
    expect(renderedText(renderer)).not.toContain('90%');
    expect(progressBarNode(renderer).props.accessibilityValue.now).toBe(40);

    // Extraction succeeds → the staged analysis surface: honest stage label
    // with the static overall hint, indeterminate (no invented percentage).
    await extraction.resolve({
      poseSequence: { ...extractedPoseSequence },
      framesWithPose: 126,
      framesTotal: 126,
    });
    expect(renderedText(renderer)).toContain('Measuring your swing…');
    expect(renderedText(renderer)).toContain('Measuring your swing');
    expect(renderedText(renderer)).toContain('usually under ~10 seconds');
    expect(
      progressBarNode(renderer).props.accessibilityValue.now,
    ).toBeUndefined();

    // Existing error path stays byte-compatible and clears the bar.
    await analysis.resolve({
      kind: 'unavailable',
      reason: 'Imported videos cannot be scored on this build.',
    });
    const rendered = renderedText(renderer);
    expect(rendered).toContain('Nothing was rated.');
    expect(rendered).toContain('Imported videos cannot be scored');
    expect(progressBarCount(renderer)).toBe(0);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('extraction failure keeps the frozen error copy — no progress residue', async () => {
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
    emit(
      extractionEvent('extracting', {
        progress: 0.3,
        captureId: 'native-pass-2',
        atIso: '2026-08-29T18:00:00.000Z',
      }),
    );
    expect(renderedText(renderer)).toContain('30%');

    await extraction.reject(
      Object.assign(new Error('native: nobody found'), {
        code: 'camera.import_no_person',
      }),
    );
    const rendered = renderedText(renderer);
    expect(rendered).toContain('Nothing was rated.');
    expect(rendered).toContain('No person could be tracked in this video');
    expect(progressBarCount(renderer)).toBe(0);
    expect(runCaptureAnalysis).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });
});

// ─── Guided camera flow: staged bar while analysis is in flight ─────────────

describe('guided-capture analysis progress', () => {
  it('the zero-touch camera path shows the staged bar while runCaptureAnalysis is pending', async () => {
    (captureStrokeVideo as jest.Mock).mockResolvedValue(guidedClip());
    const analysis = deferred<unknown>(runCaptureAnalysis as jest.Mock);

    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');
    pressButton(renderer, 'Open automatic camera');
    await act(async () => {});

    // The analyzing surface keeps its exact caption, now with the honest
    // indeterminate stage bar: label + static hint, no percentage.
    expect(renderedText(renderer)).toContain('Measuring your swing…');
    expect(renderedText(renderer)).toContain('usually under ~10 seconds');
    const bar = progressBarNode(renderer);
    expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 100 });
    expect(renderedText(renderer)).not.toContain('%');

    await analysis.resolve({
      kind: 'unavailable',
      reason: 'A validated model bundle is not installed in this build.',
    });
    const rendered = renderedText(renderer);
    expect(rendered).toContain('Nothing was rated.');
    expect(rendered).toContain('validated model bundle');
    expect(progressBarCount(renderer)).toBe(0);

    await act(async () => {
      renderer.unmount();
    });
  });
});
