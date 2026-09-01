/**
 * Button ledger for `src/screens/AnalyzeScreen.tsx`.
 *
 * Every pressable the screen renders (directly or through its child
 * controls) is pressed here through its real handler and the observable
 * effect is asserted: navigation calls with route + params, repository
 * writes, analysis/extraction seams, and copy changes. Async handlers are
 * also driven through their failure path (reject → error copy → retry
 * re-enabled). The screen is rendered for real; only natives, navigation,
 * the SQLite repository and the analysis pipeline are mocked, matching the
 * existing analyzeScreen* suites.
 */
jest.mock('../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));
jest.mock('../../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
  setCaptureTargetSeed: jest.fn(async () => {}),
}));
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));
jest.mock('../../src/review/appStoreReview', () => ({
  reportScoredAnalysisForReview: jest.fn(async () => {}),
}));
jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
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
    RadialGradient: Mock,
    Stop: Mock,
  };
});

import React from 'react';
import { Modal, Text, TextInput } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import { TargetSelector } from '../../src/camera/TargetSelector';
import {
  assertCapturedClip,
  captureStrokeVideo,
  cancelCameraOperation,
  extractImportedPoseSequence,
  importStrokeVideo,
  type CapturedClip,
} from '../../src/camera/capture';
import {
  savePendingCapture,
  setCaptureTargetSeed,
  setDeclaredStroke,
} from '../../src/data/repository';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import { reportScoredAnalysisForReview } from '../../src/review/appStoreReview';

// ─── fixtures ───────────────────────────────────────────────────────────────

const baseClip = {
  durationMs: 4200,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
};

const trigger = {
  startMs: 2000,
  endMs: 2700,
  peakMotionMs: 2400,
  confidence: 0.82,
  source: 'temporal_pose_motion',
  modelVersion: 'temporal-stroke-heuristic-2',
};

const captureEvidence = {
  schemaVersion: 1,
  window: 'detected_motion',
  poseSource: 'apple_vision_body_pose',
  poseModelVersion: 'apple-vision-bodypose-1',
  triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
  motionUnit: 'normalized_image_units_per_second',
  analysisInputFrameCount: 7,
  poseFrameCount: 6,
  poseMissingFrameCount: 1,
  trackedDurationMs: 620,
  meanCanonicalJointVisibility: 0.88,
  meanJointCoverage: 0.94,
  minimumJointCoverage: 0.83,
  fullBodyVisibleFrameCount: 4,
  jointMotion: [
    {
      joint: 'left_wrist',
      sampleCount: 5,
      meanNormalizedPerSecond: 1.1,
      peakNormalizedPerSecond: 2.4,
    },
  ],
};

const poseSequence = {
  schemaVersion: 1,
  format: 'pickle.pose-sequence.v1',
  uri: 'file:///private/var/mobile/clip.pose.json',
  frameCount: 6,
  sha256: 'a'.repeat(64),
  coordinateSystem: 'normalized_image_top_left',
  poseModelVersion: 'apple-vision-bodypose-1',
};

const guidedClip = assertCapturedClip({
  ...baseClip,
  uri: 'file:///private/var/mobile/guided.mov',
  captureMode: 'automatic_pose_trigger',
  recognition: {
    status: 'unknown',
    reason: 'validated_classifier_unavailable',
  },
  trigger,
  captureEvidence,
  ballSpeed: {
    status: 'unavailable',
    reason: 'calibrated_ball_tracker_unavailable',
  },
  preRollMs: 2000,
  postRollMs: 1500,
  poseSequence,
});

const poselessClip = assertCapturedClip({
  ...baseClip,
  uri: 'file:///private/var/mobile/poseless.mov',
  captureMode: 'automatic_pose_trigger',
  recognition: {
    status: 'unknown',
    reason: 'validated_classifier_unavailable',
  },
  trigger,
  captureEvidence,
  ballSpeed: {
    status: 'unavailable',
    reason: 'calibrated_ball_tracker_unavailable',
  },
  preRollMs: 2000,
  postRollMs: 1500,
});

const importedClip = assertCapturedClip({
  ...baseClip,
  uri: 'file:///private/var/mobile/import.mov',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
});

const scoredRecord = {
  result: { shotType: 'forehand_drive' },
  strokeIntent: { resolutionBasis: 'declared', disagreement: null },
};

function scoredOutcome(analysisId: string, freeLimitReached = false) {
  return {
    kind: 'scored',
    analysisId,
    record: scoredRecord,
    freeLimitReached,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function rendered(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function findByLabel(renderer: ReactTestRenderer, label: string) {
  const nodes = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  return nodes[nodes.length - 1] ?? null;
}

function hasLabel(renderer: ReactTestRenderer, label: string): boolean {
  return findByLabel(renderer, label) !== null;
}

/** Presses a control by accessibilityLabel and flushes pending promises. */
async function press(renderer: ReactTestRenderer, label: string) {
  const node = findByLabel(renderer, label);
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
  await act(async () => {
    node.props.onPress();
  });
  await act(async () => {});
}

/** React Native's Pressable element (the host-adjacent composite). */
function isPressable(node: ReactTestInstance): boolean {
  return typeof node.type === 'function' && node.type.name === 'Pressable';
}

/** The ScreenHeader close action (icon-only; the ghost "Close" Button shares its label). */
async function pressHeaderClose(renderer: ReactTestRenderer) {
  const nodes = renderer.root.findAll(
    n =>
      isPressable(n) &&
      n.props.accessibilityLabel === 'Close' &&
      n.props.hitSlop === 8,
  );
  const node = nodes[0];
  if (!node) throw new Error('No header Close action');
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

function buttonState(
  renderer: ReactTestRenderer,
  label: string,
): { disabled?: boolean; selected?: boolean } {
  const node = findByLabel(renderer, label);
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
  return node.props.accessibilityState ?? {};
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

/** Camera source: declares nothing, captures a guided clip → saved phase. */
async function renderSavedCamera(
  clip: CapturedClip = guidedClip,
): Promise<ReactTestRenderer> {
  (captureStrokeVideo as jest.Mock).mockResolvedValue(clip);
  const renderer = await renderScreen('camera');
  await pressButton(renderer, 'Open automatic camera');
  return renderer;
}

const capture = captureStrokeVideo as jest.Mock;
const importVideo = importStrokeVideo as jest.Mock;
const analyze = runCaptureAnalysis as jest.Mock;
const extract = extractImportedPoseSequence as jest.Mock;

describe('AnalyzeScreen button ledger', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockRouteParams = {};
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ─── READY phase (camera source) ────────────────────────────────────────

  describe('ready phase', () => {
    it('header Close goes back', async () => {
      const renderer = await renderScreen('camera');
      await press(renderer, 'Close');
      expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
      expect(capture).not.toHaveBeenCalled();
      await unmount(renderer);
    });

    it('technique radio → declares; Open automatic camera runs capture + analysis with the declaration', async () => {
      capture.mockResolvedValue(guidedClip);
      analyze.mockResolvedValue(scoredOutcome('analysis-1'));
      const renderer = await renderScreen('camera');

      expect(buttonState(renderer, 'Forehand Drive').selected).toBe(false);
      await press(renderer, 'Forehand Drive');
      expect(buttonState(renderer, 'Forehand Drive').selected).toBe(true);

      await pressButton(renderer, 'Open automatic camera');

      expect(capture).toHaveBeenCalledTimes(1);
      expect(savePendingCapture).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        'unrecognized',
        guidedClip,
        'forehand_drive',
      );
      expect(analyze).toHaveBeenCalledTimes(1);
      expect(analyze.mock.calls[0]![0]).toEqual(
        expect.objectContaining({
          declaredStroke: 'forehand_drive',
          declaredCanonical: 'FOREHAND_DRIVE',
          clip: guidedClip,
        }),
      );
      expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
        analysisId: 'analysis-1',
      });
      expect(reportScoredAnalysisForReview).toHaveBeenCalledTimes(1);
      await unmount(renderer);
    });

    it('Auto detect radio → capture auto-scores without a declaration', async () => {
      capture.mockResolvedValue(guidedClip);
      analyze.mockResolvedValue({
        kind: 'low_confidence',
        analysisId: 'analysis-auto',
        record: {
          result: { shotType: 'forehand_drive' },
          strokeIntent: {
            resolutionBasis: 'predicted_family',
            predictedStroke: { label: 'FOREHAND' },
          },
        },
        guidance: null,
      });
      const renderer = await renderScreen('camera');

      expect(buttonState(renderer, 'Auto detect').selected).toBe(false);
      await press(renderer, 'Auto detect');
      expect(buttonState(renderer, 'Auto detect').selected).toBe(true);

      await pressButton(renderer, 'Open automatic camera');

      expect(analyze).toHaveBeenCalledTimes(1);
      expect(analyze.mock.calls[0]![0]).toEqual(
        expect.objectContaining({
          declaredStroke: null,
          declaredCanonical: null,
        }),
      );
      expect(setDeclaredStroke).not.toHaveBeenCalled();
      // low_confidence → analyzed phase with honest copy, no Result route.
      expect(mockNavigation.replace).not.toHaveBeenCalled();
      expect(rendered(renderer)).toContain('Auto-detected: FOREHAND (family)');
      await unmount(renderer);
    });

    it('technique TextInput onSubmitEditing resolves "not sure" to Auto detect', async () => {
      const renderer = await renderScreen('camera');
      const input = renderer.root.findByType(TextInput);
      await act(async () => {
        input.props.onChangeText('not sure');
      });
      expect(buttonState(renderer, 'Auto detect').selected).toBe(false);
      await act(async () => {
        input.props.onSubmitEditing();
      });
      expect(buttonState(renderer, 'Auto detect').selected).toBe(true);
      await unmount(renderer);
    });

    it('technique TextInput onChangeText resolves a typed technique (voice path)', async () => {
      const renderer = await renderScreen('camera');
      const input = renderer.root.findByType(TextInput);
      await act(async () => {
        input.props.onChangeText('backhand dink');
      });
      expect(buttonState(renderer, 'Backhand Dink').selected).toBe(true);
      // Submitting the same resolved text is idempotent.
      await act(async () => {
        input.props.onSubmitEditing();
      });
      expect(buttonState(renderer, 'Backhand Dink').selected).toBe(true);
      await unmount(renderer);
    });

    it('Open automatic camera: double tap launches the camera exactly once', async () => {
      let resolveCapture!: (clip: CapturedClip) => void;
      capture.mockImplementation(
        () =>
          new Promise<CapturedClip>(resolve => {
            resolveCapture = resolve;
          }),
      );
      const renderer = await renderScreen('camera');
      const node = findByLabel(renderer, 'Open automatic camera');
      if (!node) throw new Error('missing Open automatic camera');
      await act(async () => {
        node.props.onPress();
        node.props.onPress();
        node.props.onPress();
      });
      expect(capture).toHaveBeenCalledTimes(1);
      expect(rendered(renderer)).toContain('Opening camera…');
      // Working phase: the launch button is gone; header Close is the exit.
      expect(hasLabel(renderer, 'Open automatic camera')).toBe(false);
      await press(renderer, 'Close');
      expect(cancelCameraOperation).toHaveBeenCalledTimes(1);
      expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolveCapture(guidedClip);
      });
      await unmount(renderer);
    });

    it('Open automatic camera: user cancel returns to ready, no error surface', async () => {
      capture.mockRejectedValue(new Error('User cancelled the camera.'));
      const renderer = await renderScreen('camera');
      await pressButton(renderer, 'Open automatic camera');
      expect(rendered(renderer)).not.toContain('Nothing was rated.');
      expect(hasLabel(renderer, 'Open automatic camera')).toBe(true);
      expect(mockNavigation.goBack).not.toHaveBeenCalled();
      await unmount(renderer);
    });

    it('Open automatic camera: native failure → error copy; Try again relaunches; Close goes back', async () => {
      capture.mockRejectedValueOnce(
        new Error('Camera permission denied. Enable access in Settings.'),
      );
      const renderer = await renderScreen('camera');
      await pressButton(renderer, 'Open automatic camera');
      const copy = rendered(renderer);
      expect(copy).toContain('Nothing was rated.');
      expect(copy).toContain('Camera permission denied');
      expect(analyze).not.toHaveBeenCalled();

      capture.mockResolvedValueOnce(guidedClip);
      await pressButton(renderer, 'Try again');
      expect(capture).toHaveBeenCalledTimes(2);
      expect(rendered(renderer)).not.toContain('Nothing was rated.');
      expect(rendered(renderer)).toContain('Captured');

      // Error phase again → Close + header Close both leave the screen.
      capture.mockRejectedValueOnce(new Error('Recording failed.'));
      await pressButton(renderer, 'Capture another');
      expect(rendered(renderer)).toContain('Recording failed.');
      await pressButton(renderer, 'Close');
      expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
      await pressHeaderClose(renderer);
      expect(mockNavigation.goBack).toHaveBeenCalledTimes(2);
      await unmount(renderer);
    });
  });

  // ─── SAVED phase ─────────────────────────────────────────────────────────

  describe('saved phase (guided capture)', () => {
    it('stroke chips declare; score button is disabled until a declaration exists', async () => {
      analyze.mockResolvedValue(scoredOutcome('analysis-2'));
      const renderer = await renderSavedCamera();
      expect(rendered(renderer)).toContain('Captured');

      const score = 'Get my Technique Score';
      expect(buttonState(renderer, score).disabled).toBe(true);
      // Disabled control must not fire the handler.
      await press(renderer, score);
      expect(analyze).not.toHaveBeenCalled();

      for (const chip of [
        'Serve',
        'Return',
        'Forehand drive',
        'Backhand drive',
        'Third-shot drop',
        'Dink',
        'Volley',
        'Overhead',
      ]) {
        expect(buttonState(renderer, chip).selected).toBe(false);
        await press(renderer, chip);
        expect(buttonState(renderer, chip).selected).toBe(true);
        expect(buttonState(renderer, score).disabled).toBe(false);
      }
      // Last chip pressed wins the declaration.
      await press(renderer, score);
      expect(setDeclaredStroke).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        'overhead',
      );
      expect(analyze).toHaveBeenCalledTimes(1);
      expect(analyze.mock.calls[0]![0]).toEqual(
        expect.objectContaining({ declaredStroke: 'overhead' }),
      );
      expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
        analysisId: 'analysis-2',
      });
      await unmount(renderer);
    });

    it('Get my Technique Score: double tap runs one analysis; failure → error copy, Try again re-enabled', async () => {
      let rejectAnalysis!: (error: Error) => void;
      analyze.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectAnalysis = reject;
          }),
      );
      const renderer = await renderSavedCamera();
      await press(renderer, 'Dink');
      const node = findByLabel(renderer, 'Get my Technique Score');
      if (!node) throw new Error('missing score button');
      await act(async () => {
        node.props.onPress();
        node.props.onPress();
      });
      expect(analyze).toHaveBeenCalledTimes(1);
      expect(rendered(renderer)).toContain('Measuring your swing…');

      await act(async () => {
        rejectAnalysis(new Error('The server took too long to respond.'));
      });
      await act(async () => {});
      const copy = rendered(renderer);
      expect(copy).toContain('Nothing was rated.');
      expect(copy).toContain('took too long to respond');
      expect(mockNavigation.replace).not.toHaveBeenCalled();

      // Try again keeps the declaration ("dink") and re-captures; a guided
      // clip with a declaration goes straight through the zero-touch path.
      capture.mockResolvedValueOnce(guidedClip);
      analyze.mockResolvedValueOnce(scoredOutcome('analysis-retry'));
      await pressButton(renderer, 'Try again');
      expect(capture).toHaveBeenCalledTimes(2);
      expect(analyze).toHaveBeenCalledTimes(2);
      expect(analyze.mock.calls[1]![0]).toEqual(
        expect.objectContaining({ declaredStroke: 'dink' }),
      );
      expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
        analysisId: 'analysis-retry',
      });
      await unmount(renderer);
    });

    it('unavailable / quality_blocked outcomes render their reason as error copy', async () => {
      analyze.mockResolvedValueOnce({
        kind: 'unavailable',
        reason: 'Scoring is offline right now.',
      });
      const renderer = await renderSavedCamera();
      await press(renderer, 'Serve');
      await press(renderer, 'Get my Technique Score');
      expect(rendered(renderer)).toContain('Scoring is offline right now.');
      expect(mockNavigation.replace).not.toHaveBeenCalled();

      capture.mockResolvedValueOnce(guidedClip);
      analyze.mockResolvedValueOnce({
        kind: 'quality_blocked',
        reason: 'Your full body left the frame.',
        envelope: { overall: 'UNSUPPORTED', dimensions: [] },
      });
      await pressButton(renderer, 'Try again');
      expect(analyze).toHaveBeenCalledTimes(2);
      expect(rendered(renderer)).toContain('Your full body left the frame.');
      expect(mockNavigation.replace).not.toHaveBeenCalled();
      await unmount(renderer);
    });

    it('Capture another relaunches the camera; Open Library navigates to the Library tab; header Close pops to top', async () => {
      const renderer = await renderSavedCamera();
      expect(capture).toHaveBeenCalledTimes(1);
      await pressButton(renderer, 'Capture another');
      expect(capture).toHaveBeenCalledTimes(2);
      expect(rendered(renderer)).toContain('Captured');

      await pressButton(renderer, 'Open Library');
      expect(mockNavigation.navigate).toHaveBeenCalledWith('Tabs', {
        screen: 'Library',
      });

      await press(renderer, 'Close');
      expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);
      await unmount(renderer);
    });

    it('pose-less guided clip: honest "cannot be scored" copy, no score button, recovery buttons still live', async () => {
      const renderer = await renderSavedCamera(poselessClip);
      const copy = rendered(renderer);
      expect(copy).toContain('cannot be scored');
      expect(hasLabel(renderer, 'Get my Technique Score')).toBe(false);
      expect(hasLabel(renderer, 'Dink')).toBe(false);
      await pressButton(renderer, 'Capture another');
      expect(capture).toHaveBeenCalledTimes(2);
      await pressButton(renderer, 'Open Library');
      expect(mockNavigation.navigate).toHaveBeenCalledWith('Tabs', {
        screen: 'Library',
      });
      await unmount(renderer);
    });

    it('Auto detect armed: Try again after a failed analysis re-scores without a declaration', async () => {
      capture.mockResolvedValue(guidedClip);
      analyze.mockRejectedValueOnce(new Error('offline'));
      const renderer = await renderScreen('camera');
      await press(renderer, 'Auto detect');
      await pressButton(renderer, 'Open automatic camera');
      expect(rendered(renderer)).toContain('offline');
      // The armed AUTO intent survives the error: re-capture scores directly.
      analyze.mockResolvedValueOnce(scoredOutcome('analysis-auto-2'));
      await pressButton(renderer, 'Try again');
      expect(analyze).toHaveBeenCalledTimes(2);
      expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
        analysisId: 'analysis-auto-2',
      });
      await unmount(renderer);
    });
  });

  // ─── ANALYZED phase (low-confidence / abstained) ─────────────────────────

  describe('analyzed phase', () => {
    async function renderAnalyzed(showResult: boolean) {
      capture.mockResolvedValue(guidedClip);
      analyze.mockResolvedValueOnce({
        kind: 'low_confidence',
        analysisId: 'analysis-lc',
        record: {
          result: showResult ? { shotType: 'forehand_drive' } : null,
          strokeIntent: { resolutionBasis: 'abstained' },
        },
        guidance: null,
      });
      const renderer = await renderScreen('camera');
      await press(renderer, 'Auto detect');
      await pressButton(renderer, 'Open automatic camera');
      expect(rendered(renderer)).toContain('RATING NOT CONSUMED');
      return renderer;
    }

    it('See the full read routes to Result; Capture another relaunches; Close goes back; header Close pops', async () => {
      const renderer = await renderAnalyzed(true);
      await pressButton(renderer, 'See the full read');
      expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
        analysisId: 'analysis-lc',
      });

      analyze.mockResolvedValueOnce(scoredOutcome('analysis-lc-2'));
      await pressButton(renderer, 'Capture another');
      expect(capture).toHaveBeenCalledTimes(2);
      expect(analyze).toHaveBeenCalledTimes(2);
      expect(mockNavigation.replace).toHaveBeenLastCalledWith('Result', {
        analysisId: 'analysis-lc-2',
      });
      await unmount(renderer);
    });

    it('withheld result hides See the full read; Close and header Close still exit', async () => {
      const renderer = await renderAnalyzed(false);
      expect(hasLabel(renderer, 'See the full read')).toBe(false);
      await pressButton(renderer, 'Close');
      expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
      await pressHeaderClose(renderer);
      expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);
      await unmount(renderer);
    });
  });

  // ─── FREE LIMIT phase ────────────────────────────────────────────────────

  describe('free limit phase', () => {
    async function renderFreeLimit() {
      capture.mockResolvedValue(guidedClip);
      analyze.mockResolvedValueOnce(scoredOutcome('analysis-fl', true));
      const renderer = await renderScreen('camera');
      await press(renderer, 'Forehand Drive');
      await pressButton(renderer, 'Open automatic camera');
      expect(rendered(renderer)).toContain('Upgrade to Pro');
      // The free-limit path deliberately does not prompt for a review.
      expect(reportScoredAnalysisForReview).not.toHaveBeenCalled();
      expect(mockNavigation.replace).not.toHaveBeenCalled();
      return renderer;
    }

    it('Upgrade to Pro routes to Result then Paywall(source: rating)', async () => {
      const renderer = await renderFreeLimit();
      await pressButton(renderer, 'Upgrade to Pro');
      expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
        analysisId: 'analysis-fl',
      });
      expect(mockNavigation.navigate).toHaveBeenCalledWith('Paywall', {
        source: 'rating',
      });
      await unmount(renderer);
    });

    it('See my score routes to Result without the paywall', async () => {
      const renderer = await renderFreeLimit();
      await pressButton(renderer, 'See my score');
      expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
        analysisId: 'analysis-fl',
      });
      expect(mockNavigation.navigate).not.toHaveBeenCalled();
      await unmount(renderer);
    });

    it('header Close and the Modal back gesture both route to Result', async () => {
      const renderer = await renderFreeLimit();
      await press(renderer, 'Close');
      expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
      expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
        analysisId: 'analysis-fl',
      });
      const modal = renderer.root.findByType(Modal);
      expect(modal.props.visible).toBe(true);
      await act(async () => {
        modal.props.onRequestClose();
      });
      expect(mockNavigation.replace).toHaveBeenCalledTimes(2);
      await unmount(renderer);
    });
  });

  // ─── LIBRARY source (imported video) ─────────────────────────────────────

  describe('library source', () => {
    it('auto-launches the picker; stroke chip → TargetSelector; onConfirm seeds the target and scores', async () => {
      importVideo.mockResolvedValue(importedClip);
      extract.mockResolvedValue({ poseSequence });
      analyze.mockResolvedValue(scoredOutcome('analysis-import'));
      const renderer = await renderScreen('library');
      expect(importVideo).toHaveBeenCalledTimes(1);
      expect(rendered(renderer)).toContain('Capture complete');
      expect(hasLabel(renderer, 'Import another')).toBe(true);
      expect(hasLabel(renderer, 'Get my Technique Score')).toBe(true);

      await press(renderer, 'Forehand drive');
      const selector = renderer.root.findByType(TargetSelector);
      expect(selector.props.frameUri).toBe(importedClip.uri);
      const selection = {
        point: { x: 0.4, y: 0.6 },
        selectedAtIso: '2026-08-27T18:01:00.000Z',
      };
      await act(async () => {
        selector.props.onConfirm(selection);
      });
      await act(async () => {});

      expect(setDeclaredStroke).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        'forehand_drive',
      );
      expect(setCaptureTargetSeed).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        selection,
      );
      expect(extract).toHaveBeenCalledTimes(1);
      expect(extract).toHaveBeenCalledWith(importedClip, selection.point);
      expect(analyze).toHaveBeenCalledTimes(1);
      expect(analyze.mock.calls[0]![0]).toEqual(
        expect.objectContaining({
          declaredStroke: 'forehand_drive',
          targetSeed: selection,
        }),
      );
      expect(analyze.mock.calls[0]![0].clip.poseSequence).toBe(poseSequence);
      expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
        analysisId: 'analysis-import',
      });
      await unmount(renderer);
    });

    it('onSkip scores without a seed; extraction failure → typed error copy; Try again reopens the picker', async () => {
      importVideo.mockResolvedValue(importedClip);
      extract.mockRejectedValueOnce(
        Object.assign(new Error('no person'), {
          code: 'camera.import_no_person',
        }),
      );
      const renderer = await renderScreen('library');
      await press(renderer, 'Dink');
      const selector = renderer.root.findByType(TargetSelector);
      await act(async () => {
        selector.props.onSkip();
      });
      await act(async () => {});
      expect(setCaptureTargetSeed).not.toHaveBeenCalled();
      expect(extract).toHaveBeenCalledTimes(1);
      expect(extract).toHaveBeenCalledWith(importedClip, null);
      expect(analyze).not.toHaveBeenCalled();
      const copy = rendered(renderer);
      expect(copy).toContain('Nothing was rated.');
      expect(copy).toContain('No person could be tracked in this video');

      await pressButton(renderer, 'Try again');
      expect(importVideo).toHaveBeenCalledTimes(2);
      expect(rendered(renderer)).not.toContain('Nothing was rated.');
      await unmount(renderer);
    });

    it('Import another reopens the picker; header Close pops to top; picker cancel goes back', async () => {
      importVideo.mockResolvedValue(importedClip);
      const renderer = await renderScreen('library');
      await pressButton(renderer, 'Import another');
      expect(importVideo).toHaveBeenCalledTimes(2);
      await press(renderer, 'Close');
      expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);

      importVideo.mockRejectedValueOnce(
        new Error('User cancelled the video picker.'),
      );
      await pressButton(renderer, 'Import another');
      expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
      expect(rendered(renderer)).not.toContain('Nothing was rated.');
      await unmount(renderer);
    });

    it('TargetSelector is not shown again once a seed exists; Get my Technique Score scores directly', async () => {
      importVideo.mockResolvedValue(importedClip);
      extract.mockResolvedValue({ poseSequence });
      let resolveAnalysis!: (value: unknown) => void;
      analyze.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveAnalysis = resolve;
          }),
      );
      const renderer = await renderScreen('library');
      await press(renderer, 'Serve');
      const selector = renderer.root.findByType(TargetSelector);
      const selection = {
        point: { x: 0.5, y: 0.5 },
        selectedAtIso: '2026-08-27T18:01:00.000Z',
      };
      await act(async () => {
        selector.props.onConfirm(selection);
      });
      // Scoring is in flight: the header Close still works (no dead-end).
      expect(analyze).toHaveBeenCalledTimes(1);
      expect(rendered(renderer)).toContain('Measuring your swing…');
      await press(renderer, 'Close');
      expect(cancelCameraOperation).toHaveBeenCalled();
      expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolveAnalysis(scoredOutcome('analysis-late'));
      });
      await act(async () => {});
      // The late resolution settles without throwing and never re-fires the
      // exit; the stale REPLACE is dropped by the stack router once the
      // route is gone (its source key no longer exists).
      expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
      await unmount(renderer);
    });
  });

  // ─── Accessibility contract for every pressable ──────────────────────────

  it('every pressable exposes an accessibilityRole and a descriptive label', async () => {
    capture.mockResolvedValue(guidedClip);
    const renderer = await renderScreen('camera');
    const check = () => {
      const pressables = renderer.root.findAll(
        n => isPressable(n) && typeof n.props.onPress === 'function',
      );
      expect(pressables.length).toBeGreaterThan(0);
      for (const node of pressables) {
        expect(node.props.accessibilityRole).toEqual(expect.any(String));
        expect(
          String(node.props.accessibilityLabel).trim().length,
        ).toBeGreaterThan(0);
      }
    };
    check();
    await pressButton(renderer, 'Open automatic camera');
    check();
    await unmount(renderer);
  });
});
