/**
 * Workflow verification — Analyze → Result (AnalyzeScreen side).
 *
 * Drives the mounted AnalyzeScreen through the branches no other suite
 * presses button-by-button:
 *   - final free rating → free-limit dialog → "Upgrade to Pro" (Result under
 *     Paywall{source:'rating'}) / "See my score" (Result), no OS review ask
 *   - quality-blocked capture → honest error surface with guidance + retry
 *   - classifier abstention (result-null record) → analyzed surface with
 *     "Capture another" / "Close" and NO Result button
 *   - import failure → error surface; "Close" leaves, "Try again" recovers
 *   - working-surface Close cancels the native operation before leaving
 *   - accessibility contract of every state (alert / live region / modal)
 */
jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
  setCaptureTargetSeed: jest.fn(async () => {}),
}));
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../../src/review/appStoreReview', () => ({
  reportScoredAnalysisForReview: jest.fn(async () => {}),
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
import type { EnvelopeVerdict } from '@pickle/shared-types';
import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import {
  assertCapturedClip,
  captureStrokeVideo,
  cancelCameraOperation,
  importStrokeVideo,
  type CapturedClip,
} from '../../src/camera/capture';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import { reportScoredAnalysisForReview } from '../../src/review/appStoreReview';

const guidedClip: CapturedClip = {
  uri: 'file:///captures/guided.mov',
  durationMs: 2700,
  fps: 60,
  width: 1080,
  height: 1080,
  capturedAtIso: '2026-09-01T18:00:00.000Z',
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
  targetSeed: { x: 0.5, y: 0.6, source: 'live_camera_tap' },
  captureEvidence: {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'apple_vision_body_pose',
    poseModelVersion: 'apple-vision-bodypose-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    analysisInputFrameCount: 42,
    poseFrameCount: 42,
    poseMissingFrameCount: 0,
    trackedDurationMs: 2700,
    meanCanonicalJointVisibility: 0.9,
    meanJointCoverage: 0.9,
    minimumJointCoverage: 0.8,
    fullBodyVisibleFrameCount: 42,
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
    frameCount: 42,
    sha256: 'a'.repeat(64),
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
  },
};

const importedClip = assertCapturedClip({
  uri: 'file:///private/var/mobile/import.mov',
  durationMs: 4200,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-09-01T18:00:00.000Z',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
});

const unsupportedEnvelope: EnvelopeVerdict = {
  overall: 'UNSUPPORTED',
  dimensions: [
    {
      dimension: 'player_visibility',
      status: 'UNSUPPORTED',
      measured: 0.4,
      threshold: 0.75,
    },
  ],
} as unknown as EnvelopeVerdict;

function textOf(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

/** Host (native) nodes only — composite wrappers echo the same props. */
function hosts(
  renderer: ReactTestRenderer,
  predicate: (node: TestRenderer.ReactTestInstance) => boolean,
) {
  return renderer.root.findAll(n => typeof n.type === 'string' && predicate(n));
}

function findButton(renderer: ReactTestRenderer, label: string) {
  const candidates = renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      n.props.accessibilityRole === 'button' &&
      n.findAll(t => t.type === Text && String(t.props.children) === label)
        .length > 0,
  );
  return candidates[candidates.length - 1] ?? null;
}

async function press(renderer: ReactTestRenderer, label: string) {
  const node = findButton(renderer, label);
  if (!node) throw new Error(`No button labeled ${label}`);
  expect(node.props.accessibilityState?.disabled).not.toBe(true);
  await act(async () => {
    node.props.onPress();
  });
}

async function pressByA11yLabel(renderer: ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labeled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
}

async function settle() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

async function render(params: Record<string, unknown>) {
  mockRouteParams = params;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  return renderer;
}

/** Declares Forehand Drive, opens the camera and lets the guided clip land
 * in the zero-touch scoring path (runCaptureAnalysis is mocked per test). */
async function runGuidedAttempt(renderer: ReactTestRenderer) {
  await pressByA11yLabel(renderer, 'Forehand Drive');
  (captureStrokeVideo as jest.Mock).mockResolvedValue(guidedClip);
  await press(renderer, 'Open automatic camera');
  await settle();
  await settle();
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('camera landing', () => {
  it('renders the declaration radiogroup and a primary camera button that is pressable once a technique is chosen', async () => {
    const renderer = await render({ source: 'camera' });
    const group = hosts(
      renderer,
      n => n.props.accessibilityRole === 'radiogroup',
    );
    expect(group).toHaveLength(1);
    const radios = hosts(renderer, n => n.props.accessibilityRole === 'radio');
    expect(radios.length).toBeGreaterThan(1);
    for (const radio of radios) {
      expect(typeof radio.props.accessibilityLabel).toBe('string');
      expect(radio.props.accessibilityState).toHaveProperty('selected');
    }
    const open = findButton(renderer, 'Open automatic camera');
    expect(open).not.toBeNull();
    expect(open!.props.accessibilityLabel).toBe('Open automatic camera');
    await act(async () => renderer.unmount());
  });
});

describe('free limit → Result + Paywall', () => {
  const scoredFreeLimit = {
    kind: 'scored',
    analysisId: 'analysis-free-limit',
    record: {
      id: 'analysis-free-limit',
      strokeIntent: {
        declaredStroke: 'forehand_drive',
        predictedStroke: null,
        resolutionBasis: 'declared',
        disagreement: null,
      },
      result: { overallScore: 7.1 },
    },
    freeLimitReached: true,
  };

  it('"Upgrade to Pro" stacks Paywall{source:rating} over the saved Result and never asks for an OS review', async () => {
    (runCaptureAnalysis as jest.Mock).mockResolvedValue(scoredFreeLimit);
    const renderer = await render({ source: 'camera' });
    await runGuidedAttempt(renderer);

    const rendered = textOf(renderer);
    expect(rendered).toContain('That was your last free analysis.');
    expect(rendered).toContain('both free analyses');
    const dialog = hosts(
      renderer,
      n => n.props.accessibilityViewIsModal === true,
    );
    expect(dialog).toHaveLength(1);
    expect(dialog[0]!.props.accessibilityLabel).toContain('free analyses');
    // Nothing navigated yet: the prompt sits on top of the saved score.
    expect(mockNavigation.replace).not.toHaveBeenCalled();

    await press(renderer, 'Upgrade to Pro');
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'analysis-free-limit',
    });
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Paywall', {
      source: 'rating',
    });
    // AGENTS.md: the free-limit path deliberately does not prompt for review.
    expect(reportScoredAnalysisForReview).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it('"See my score" opens the saved Result directly', async () => {
    (runCaptureAnalysis as jest.Mock).mockResolvedValue(scoredFreeLimit);
    const renderer = await render({ source: 'camera' });
    await runGuidedAttempt(renderer);
    await press(renderer, 'See my score');
    expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'analysis-free-limit',
    });
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
    expect(reportScoredAnalysisForReview).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it('a scored run below the limit goes straight to Result and reports for review', async () => {
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      ...scoredFreeLimit,
      analysisId: 'analysis-scored',
      freeLimitReached: false,
    });
    const renderer = await render({ source: 'camera' });
    await runGuidedAttempt(renderer);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'analysis-scored',
    });
    expect(reportScoredAnalysisForReview).toHaveBeenCalledTimes(1);
    expect(textOf(renderer)).not.toContain('last free analysis');
    await act(async () => renderer.unmount());
  });
});

describe('quality-blocked capture', () => {
  it('shows the honest reason plus per-dimension guidance as an alert with a live retry', async () => {
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'quality_blocked',
      reason:
        'This capture cannot be analyzed honestly — the measured capture quality is outside the supported envelope (player_visibility). Nothing was rated.',
      envelope: unsupportedEnvelope,
    });
    const renderer = await render({ source: 'camera' });
    await runGuidedAttempt(renderer);

    const rendered = textOf(renderer);
    expect(rendered).toContain('Nothing was rated.');
    expect(rendered).toContain('outside the supported envelope');
    expect(
      hosts(renderer, n => n.props.accessibilityRole === 'alert'),
    ).toHaveLength(1);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    // No spinner survives the outcome.
    expect(
      hosts(renderer, n => n.props.testID === 'stroke-result-analyzing'),
    ).toHaveLength(0);

    // Retry re-opens the camera (a fresh attempt), Close leaves.
    (captureStrokeVideo as jest.Mock).mockImplementation(
      () => new Promise(() => {}),
    );
    await press(renderer, 'Try again');
    expect(captureStrokeVideo).toHaveBeenCalledTimes(2);
    expect(textOf(renderer)).toContain('Opening camera');
    await act(async () => renderer.unmount());
    expect(cancelCameraOperation).toHaveBeenCalled();
  });
});

describe('unknown / abstained stroke (result-null record)', () => {
  it('surfaces RATING NOT CONSUMED with no Result button, and "Capture another" / "Close" are live', async () => {
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'low_confidence',
      analysisId: 'analysis-abstained',
      record: {
        id: 'analysis-abstained',
        strokeIntent: {
          declaredStroke: null,
          predictedStroke: null,
          resolutionBasis: 'abstained',
          disagreement: null,
        },
        result: null,
      },
    });
    const renderer = await render({ source: 'camera' });
    await pressByA11yLabel(renderer, 'Auto detect');
    (captureStrokeVideo as jest.Mock).mockResolvedValue(guidedClip);
    await press(renderer, 'Open automatic camera');
    await settle();
    await settle();

    const rendered = textOf(renderer);
    expect(rendered).toContain('RATING NOT CONSUMED');
    expect(rendered).toContain('result withheld');
    expect(findButton(renderer, 'See the full read')).toBeNull();
    expect(findButton(renderer, 'Capture another')).not.toBeNull();
    expect(
      hosts(renderer, n => n.props.accessibilityLiveRegion === 'polite').length,
    ).toBeGreaterThan(0);
    expect(mockNavigation.replace).not.toHaveBeenCalled();

    await press(renderer, 'Close');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });

  it('a family-level read with a saved result offers "See the full read" → Result', async () => {
    (runCaptureAnalysis as jest.Mock).mockResolvedValue({
      kind: 'low_confidence',
      analysisId: 'analysis-family',
      record: {
        id: 'analysis-family',
        strokeIntent: {
          declaredStroke: null,
          predictedStroke: { label: 'FOREHAND', leaf: null },
          resolutionBasis: 'predicted_family',
          disagreement: null,
        },
        result: { overallScore: null },
      },
    });
    const renderer = await render({ source: 'camera' });
    await pressByA11yLabel(renderer, 'Auto detect');
    (captureStrokeVideo as jest.Mock).mockResolvedValue(guidedClip);
    await press(renderer, 'Open automatic camera');
    await settle();
    await settle();
    expect(textOf(renderer)).toContain('Auto-detected: FOREHAND (family)');
    await press(renderer, 'See the full read');
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'analysis-family',
    });
    await act(async () => renderer.unmount());
  });
});

describe('library import', () => {
  async function renderLibrary() {
    const renderer = await render({ source: 'library' });
    // Library imports auto-launch after a short (160ms) arming delay.
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 220));
    });
    await settle();
    return renderer;
  }

  it('picker cancellation leaves the screen instead of showing an error', async () => {
    (importStrokeVideo as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Video import was canceled.'), {
        code: 'camera.cancelled',
      }),
    );
    const renderer = await renderLibrary();
    expect(textOf(renderer)).not.toContain('Nothing was rated.');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });

  it('import failure: alert surface, "Close" goes back, "Try again" re-opens the picker', async () => {
    (importStrokeVideo as jest.Mock).mockRejectedValue(
      Object.assign(new Error('The selected video could not be copied.'), {
        code: 'camera.import_failed',
      }),
    );
    const renderer = await renderLibrary();
    expect(textOf(renderer)).toContain('could not be copied');
    expect(
      hosts(renderer, n => n.props.accessibilityRole === 'alert'),
    ).toHaveLength(1);

    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
    await press(renderer, 'Try again');
    await settle();
    // Recovered to the saved-capture surface with a declaration picker.
    expect(textOf(renderer)).not.toContain('Nothing was rated.');
    expect(
      hosts(renderer, n => n.props.accessibilityRole === 'radiogroup'),
    ).toHaveLength(1);
    expect(importStrokeVideo).toHaveBeenCalledTimes(2);
    await act(async () => renderer.unmount());
  });

  it('"Close" on the error surface goes back', async () => {
    (importStrokeVideo as jest.Mock).mockRejectedValue(
      new Error('Photos permission denied. Enable access in Settings.'),
    );
    const renderer = await renderLibrary();
    await press(renderer, 'Close');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });

  it('the working surface Close cancels the native picker before leaving', async () => {
    (importStrokeVideo as jest.Mock).mockImplementation(
      () => new Promise(() => {}),
    );
    const renderer = await renderLibrary();
    expect(textOf(renderer)).toContain('Opening video library');
    await pressByA11yLabel(renderer, 'Close');
    expect(cancelCameraOperation).toHaveBeenCalledTimes(1);
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });
});
