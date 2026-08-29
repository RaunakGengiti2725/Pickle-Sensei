// The screen module pulls in the SQLite-backed db and the native camera
// module, neither of which exists under jest. Everything except the screen's
// own state machine and the real envelope evaluator is replaced.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../src/data/repository', () => ({
  savePendingCapture: jest.fn(() => Promise.resolve()),
  setCaptureTargetSeed: jest.fn(() => Promise.resolve()),
  setDeclaredStroke: jest.fn(() => Promise.resolve()),
  getKv: jest.fn(() => Promise.resolve(null)),
  setKv: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/account/apiSession', () => ({
  getApiSession: jest.fn(() => null),
}));
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

const mockNavigation = {
  replace: jest.fn(),
  navigate: jest.fn(),
  goBack: jest.fn(),
  popToTop: jest.fn(),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { source: 'camera' } }),
}));

// The camera module is replaced with a controllable fake: the test owns the
// event stream and the capture promise, exactly like the native layer does.
type Listener = (event: unknown) => void;
const cameraFake: {
  listener: Listener | null;
  resolvers: Array<(clip: unknown) => void>;
} = { listener: null, resolvers: [] };
jest.mock('../src/camera/capture', () => ({
  subscribeToCameraEvents: (listener: Listener) => {
    cameraFake.listener = listener;
    return () => {
      cameraFake.listener = null;
    };
  },
  captureStrokeVideo: jest.fn(
    () =>
      new Promise(resolve => {
        cameraFake.resolvers.push(resolve);
      }),
  ),
  importStrokeVideo: jest.fn(),
  cancelCameraOperation: jest.fn(),
}));

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { EnvelopeDimension, EnvelopeVerdict } from '@pickle/shared-types';
import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import {
  armTryAgain,
  consumeTryAgainHandoff,
} from '../src/screens/tryAgainHandoff';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';

/**
 * g22 — repeated capture attempts on one mounted AnalyzeScreen must not let
 * the PREVIOUS clip's live-window signals (readiness visibility, native
 * quality proxies) stamp the NEXT clip's stored capture envelope. Each
 * attempt's envelope reports only what was measured during ITS OWN live
 * window; a silent second window is honestly NOT_MEASURED.
 */

const runMock = runCaptureAnalysis as jest.Mock;

function guidedClip(id: string) {
  return {
    uri: `file:///private/clip-${id}.mov`,
    durationMs: 4200,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    targetSeed: { x: 0.5, y: 0.6 },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///private/clip-${id}.pose.json`,
      frameCount: 6,
      sha256: 'a'.repeat(64),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

// Abstained outcome keeps the screen on its own 'analyzed' phase (with the
// "Capture another" CTA) instead of navigating away, so one mounted screen
// really runs attempt after attempt — the Try Again loop's worst case.
function abstainedOutcome(analysisId: string) {
  return {
    kind: 'low_confidence',
    analysisId,
    guidance: null,
    record: {
      id: analysisId,
      strokeIntent: {
        declaredStroke: null,
        predictedStroke: null,
        resolutionBasis: 'abstained',
        resolvedProfileId: null,
        resolvedProfileVersion: null,
        disagreement: null,
      },
      result: null,
    },
  };
}

function status(
  envelope: EnvelopeVerdict,
  dimension: EnvelopeDimension,
): string {
  const found = envelope.dimensions.find(d => d.dimension === dimension);
  expect(found).toBeDefined();
  return found!.status;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('g22 — live-window signals never leak into the next attempt', () => {
  afterEach(() => {
    consumeTryAgainHandoff();
    cameraFake.listener = null;
    cameraFake.resolvers = [];
    jest.clearAllMocks();
  });

  it('a silent second capture window is NOT_MEASURED, not stamped with the previous clip\u2019s signals', async () => {
    jest.useFakeTimers();
    try {
      runMock.mockImplementation((request: { captureId: string }) =>
        Promise.resolve(abstainedOutcome(`analysis-${request.captureId}`)),
      );
      // AUTO run: Try Again re-armed AUTO, so the zero-touch gate scores
      // declared-null guided captures straight from run().
      armTryAgain({
        source: 'camera',
        declaredStroke: null,
        declaredCanonical: null,
        auto: true,
      });

      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<AnalyzeScreen />);
      });
      // The rearm effect launches run() after its 160ms beat.
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      expect(cameraFake.resolvers).toHaveLength(1);

      // Attempt 1's live window really measures: a readiness read and one
      // native quality emission arrive before the clip completes.
      await act(async () => {
        cameraFake.listener!({
          type: 'readiness',
          state: 'ready',
          poseConfidence: 0.9,
          jointCoverage: 0.91,
          stableForMs: 900,
          missingJoints: [],
          source: 'apple_vision_body_pose',
          modelVersion: 'apple-vision-bodypose-1',
          emittedAtIso: '2026-08-30T10:00:01.000Z',
        });
        cameraFake.listener!({
          type: 'capture_quality',
          signals: {
            schemaVersion: 1,
            frameWidthPx: 720,
            frameHeightPx: 1280,
            avgFrameRateFps: 59.94,
            brightnessMeanLuma: 128,
            laplacianVarianceMedian: 900,
            meanAbsFrameDiff: 2,
            sampledFrameCount: 30,
          },
          emittedAtIso: '2026-08-30T10:00:01.500Z',
        });
      });
      await act(async () => {
        cameraFake.resolvers[0]!(guidedClip('one'));
      });
      await flush();

      expect(runMock).toHaveBeenCalledTimes(1);
      const first = runMock.mock.calls[0]![0]
        .captureEnvelope as EnvelopeVerdict;
      expect(status(first, 'player_visibility')).not.toBe('NOT_MEASURED');
      expect(status(first, 'brightness')).not.toBe('NOT_MEASURED');

      // Attempt 2 on the SAME mounted screen: the second live window emits
      // NOTHING before its clip completes.
      const [captureAnother] = renderer.root.findAll(
        node =>
          node.props.accessibilityLabel === 'Capture another' &&
          typeof node.props.onPress === 'function',
      );
      expect(captureAnother).toBeDefined();
      await act(async () => {
        captureAnother!.props.onPress();
      });
      expect(cameraFake.resolvers).toHaveLength(2);
      await act(async () => {
        cameraFake.resolvers[1]!(guidedClip('two'));
      });
      await flush();

      expect(runMock).toHaveBeenCalledTimes(2);
      const second = runMock.mock.calls[1]![0]
        .captureEnvelope as EnvelopeVerdict;
      // The new clip's own capture configuration is still real and measured…
      expect(status(second, 'resolution')).not.toBe('NOT_MEASURED');
      expect(status(second, 'frame_rate')).not.toBe('NOT_MEASURED');
      expect(status(second, 'clip_duration')).not.toBe('NOT_MEASURED');
      // …but nothing from attempt 1's live window is attributed to it.
      expect(status(second, 'player_visibility')).toBe('NOT_MEASURED');
      expect(status(second, 'brightness')).toBe('NOT_MEASURED');
      expect(status(second, 'motion_blur')).toBe('NOT_MEASURED');
      expect(status(second, 'camera_motion')).toBe('NOT_MEASURED');

      await act(async () => {
        renderer.unmount();
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
