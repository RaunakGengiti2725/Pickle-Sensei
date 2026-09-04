// ADVERSARIAL PASS #4 / S1 — AnalyzeScreen mounted under React.StrictMode.
// React's dev-mode StrictMode invokes lazy useState initializers TWICE per
// mount. The TRY AGAIN handoff is a single-shot module value that the
// initializer consumes, so a naive implementation loses the declaration on
// the second invocation (the first call cleared it). Both invocations must
// observe the SAME handoff, the consumer must be charged exactly once, and
// the seeded intent must reach the technique picker.
//
// The test titled "FINDING:" is a reproduction that FAILS on 4d812e1a by
// design (the failure is the evidence); every other test pins behaviour that
// held.
jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/data/repository', () => ({
  savePendingCapture: jest.fn(() => Promise.resolve()),
  setCaptureTargetSeed: jest.fn(() => Promise.resolve()),
  setDeclaredStroke: jest.fn(() => Promise.resolve()),
  getKv: jest.fn(() => Promise.resolve(null)),
  setKv: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: jest.fn(() => null),
}));
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
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
const mockRoute = { params: { source: 'camera' } as { source: string } };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => mockRoute,
}));

type Listener = (event: unknown) => void;
const cameraFake: {
  listeners: Listener[];
  resolvers: Array<(clip: unknown) => void>;
} = { listeners: [], resolvers: [] };
jest.mock('../../src/camera/capture', () => ({
  subscribeToCameraEvents: (listener: Listener) => {
    cameraFake.listeners.push(listener);
    return () => {
      cameraFake.listeners = cameraFake.listeners.filter(l => l !== listener);
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
import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import {
  armTryAgain,
  consumeTryAgainHandoff,
  peekTryAgainHandoff,
  techniqueIntentFromHandoff,
  TRY_AGAIN_HANDOFF_TTL_MS,
  type TryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';
import { TechniqueIntentPicker } from '../../src/flow/TechniqueIntentPicker';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import { captureStrokeVideo } from '../../src/camera/capture';
import { setDeclaredStroke } from '../../src/data/repository';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';

const captureMock = captureStrokeVideo as jest.Mock;
const runMock = runCaptureAnalysis as jest.Mock;
const setDeclaredMock = setDeclaredStroke as jest.Mock;

const DECLARED: TryAgainHandoff = {
  source: 'camera',
  declaredStroke: 'forehand_drive',
  declaredCanonical: null,
  auto: false,
  sessionId: 'set-strict-1',
};

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

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function pickerValue(renderer: TestRenderer.ReactTestRenderer) {
  const pickers = renderer.root.findAllByType(TechniqueIntentPicker);
  expect(pickers).toHaveLength(1);
  return pickers[0]!.props.value;
}

describe('attack4/S1 — StrictMode double-invoked initializer keeps the single-shot handoff', () => {
  let recordSpy: jest.SpyInstance;
  beforeEach(() => {
    recordSpy = jest.spyOn(stabilitySlo, 'record');
    mockRoute.params = { source: 'camera' };
  });
  afterEach(() => {
    consumeTryAgainHandoff();
    cameraFake.listeners = [];
    cameraFake.resolvers = [];
    recordSpy.mockRestore();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('declared re-arm survives StrictMode: consumed once, seeded intent reaches the picker', async () => {
    jest.useFakeTimers();
    armTryAgain(DECLARED);
    expect(peekTryAgainHandoff()).toEqual(DECLARED);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <React.StrictMode>
          <AnalyzeScreen />
        </React.StrictMode>,
      );
    });

    // Single-shot: nothing is left for a later, unrelated capture …
    expect(peekTryAgainHandoff()).toBeNull();
    // … the telemetry counted ONE re-arm and NO expiry failure even though
    // the initializer ran twice.
    const kinds = recordSpy.mock.calls.map(
      call => (call[0] as { kind: string }).kind,
    );
    expect(kinds.filter(k => k === 'try_again_rearmed')).toHaveLength(1);
    expect(kinds).not.toContain('try_again_failed');

    // The seeded technique intent is the re-armed declaration, not null.
    expect(pickerValue(renderer)).toEqual(techniqueIntentFromHandoff(DECLARED));

    // The auto-launch never fires more than once whatever StrictMode does
    // to the effect (mount → cleanup → mount).
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    expect(captureMock.mock.calls.length).toBeLessThanOrEqual(1);

    await act(async () => {
      renderer.unmount();
    });
  });

  // FINDING (dev-only): two refs are flipped inside effect CLEANUPS —
  // `abandoned.current = true` (unmount cleanup) and `autoLaunchStarted`
  // (set on the first effect pass, never reset by its cleanup). StrictMode's
  // simulated unmount/remount therefore leaves a mounted AnalyzeScreen that
  // (a) never auto-launches the re-armed camera and (b) bails out of every
  // run() right after setDeclaredStroke, so runCaptureAnalysis is never
  // reached. App.tsx does not wrap the tree in StrictMode today, so this is a
  // latent (dev-mode) hazard; the test passes once the screen is
  // StrictMode-safe.
  it('FINDING: StrictMode-safe effects: the re-arm auto-launches once and the run reaches runCaptureAnalysis', async () => {
    jest.useFakeTimers();
    armTryAgain(DECLARED);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <React.StrictMode>
          <AnalyzeScreen />
        </React.StrictMode>,
      );
    });
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    const autoLaunched = captureMock.mock.calls.length;
    console.info(
      `[attack4/S1-strict-effects] captureStrokeVideo calls after the 160ms re-arm beat under StrictMode: ${autoLaunched}`,
    );
    if (autoLaunched === 0) {
      const [open] = renderer.root.findAll(
        node =>
          node.props.accessibilityLabel === 'Open automatic camera' &&
          typeof node.props.onPress === 'function',
      );
      expect(open).toBeDefined();
      await act(async () => {
        open!.props.onPress();
      });
    }
    expect(captureMock).toHaveBeenCalledTimes(1);
    runMock.mockImplementation((request: { captureId: string }) =>
      Promise.resolve(abstainedOutcome(`analysis-${request.captureId}`)),
    );
    await act(async () => {
      cameraFake.resolvers[0]!(guidedClip('strict'));
    });
    await flush();
    await flush();
    expect(setDeclaredMock).toHaveBeenCalledTimes(1);
    expect(setDeclaredMock.mock.calls[0]![2]).toBe('forehand_drive');
    console.info(
      `[attack4/S1-strict-effects] runCaptureAnalysis calls: ${runMock.mock.calls.length}; auto-launched: ${autoLaunched}`,
    );
    expect(autoLaunched).toBe(1);
    expect(runMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('WITHOUT StrictMode the same re-arm auto-launches once and records the seeded declaration (control)', async () => {
    jest.useFakeTimers();
    armTryAgain(DECLARED);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<AnalyzeScreen />);
    });
    expect(pickerValue(renderer)).toEqual(techniqueIntentFromHandoff(DECLARED));
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    expect(captureMock).toHaveBeenCalledTimes(1);
    runMock.mockImplementation((request: { captureId: string }) =>
      Promise.resolve(abstainedOutcome(`analysis-${request.captureId}`)),
    );
    await act(async () => {
      cameraFake.resolvers[0]!(guidedClip('control'));
    });
    await flush();
    await flush();
    expect(setDeclaredMock).toHaveBeenCalledTimes(1);
    expect(setDeclaredMock.mock.calls[0]![2]).toBe('forehand_drive');
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0]![0].declaredStroke).toBe('forehand_drive');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('AUTO re-arm survives StrictMode with the armed-AUTO intent', async () => {
    jest.useFakeTimers();
    armTryAgain({ ...DECLARED, declaredStroke: null, auto: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <React.StrictMode>
          <AnalyzeScreen />
        </React.StrictMode>,
      );
    });
    expect(peekTryAgainHandoff()).toBeNull();
    expect(pickerValue(renderer)).toEqual(
      expect.objectContaining({ source: 'auto', legacySlug: null }),
    );
    const kinds = recordSpy.mock.calls.map(
      call => (call[0] as { kind: string }).kind,
    );
    expect(kinds.filter(k => k === 'try_again_rearmed')).toHaveLength(1);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('rapid remount: a second StrictMode mount after the first gets NO handoff (single-shot holds)', async () => {
    jest.useFakeTimers();
    armTryAgain(DECLARED);
    let first!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      first = TestRenderer.create(
        <React.StrictMode>
          <AnalyzeScreen />
        </React.StrictMode>,
      );
    });
    await act(async () => {
      first.unmount();
    });
    let second!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      second = TestRenderer.create(
        <React.StrictMode>
          <AnalyzeScreen />
        </React.StrictMode>,
      );
    });
    expect(pickerValue(second)).toBeNull();
    const kinds = recordSpy.mock.calls.map(
      call => (call[0] as { kind: string }).kind,
    );
    expect(kinds.filter(k => k === 'try_again_rearmed')).toHaveLength(1);
    expect(kinds).not.toContain('try_again_failed');
    await act(async () => {
      second.unmount();
    });
  });

  it('clock skew: a forward wall-clock jump past the TTL between arm and mount drops the re-arm (documents the wall-clock TTL)', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-04T12:00:00.000Z') });
    armTryAgain(DECLARED);
    // NTP-style forward correction while the navigation is in flight.
    jest.setSystemTime(
      new Date('2026-09-04T12:00:00.000Z').getTime() +
        TRY_AGAIN_HANDOFF_TTL_MS +
        1,
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<AnalyzeScreen />);
    });
    const kinds = recordSpy.mock.calls.map(
      call => (call[0] as { kind: string }).kind,
    );
    console.info(
      `[attack4/S1-skew] picker value after +TTL wall-clock jump: ${JSON.stringify(pickerValue(renderer))}; telemetry: ${kinds.join(',')}`,
    );
    // Observed contract: the handoff is treated as expired and reported as
    // try_again_failed/handoff_expired. A BACKWARD jump must never revive an
    // old handoff (see next test).
    expect(pickerValue(renderer)).toBeNull();
    expect(kinds).toContain('try_again_failed');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('clock skew: a backward wall-clock jump does not revive a handoff already consumed', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-04T12:00:00.000Z') });
    armTryAgain(DECLARED);
    expect(consumeTryAgainHandoff()).toEqual(DECLARED);
    jest.setSystemTime(new Date('2026-09-04T11:00:00.000Z'));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<AnalyzeScreen />);
    });
    expect(pickerValue(renderer)).toBeNull();
    expect(peekTryAgainHandoff()).toBeNull();
    await act(async () => {
      renderer.unmount();
    });
  });

  it('library source under StrictMode clears an armed camera handoff instead of consuming it', async () => {
    jest.useFakeTimers();
    mockRoute.params = { source: 'library' };
    armTryAgain(DECLARED);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <React.StrictMode>
          <AnalyzeScreen />
        </React.StrictMode>,
      );
    });
    expect(peekTryAgainHandoff()).toBeNull();
    const kinds = recordSpy.mock.calls.map(
      call => (call[0] as { kind: string }).kind,
    );
    expect(kinds).not.toContain('try_again_rearmed');
    expect(kinds).not.toContain('try_again_failed');
    await act(async () => {
      renderer.unmount();
    });
  });
});
