/**
 * Adversarial neighbourhood tests for XC-UAI-08 (candidate 7d0e8859).
 *
 * The fix gates camera `readiness` telemetry behind "a capture is in flight
 * AND the phase is already `working`". These tests attack every OTHER
 * settled phase the screen can be in when a trailing readiness read arrives
 * (zero-touch scoring, saved, analyzed, free_limit, quality-blocked error,
 * paywall error, user-cancel idle), the same-tick orderings a native camera
 * can produce around the capture promise settling, and the re-arm path
 * (Try again must let readiness drive the phase again).
 *
 * Expected on the candidate: every test passes. Expected on the base commit
 * 4d812e1a: the settled-phase tests fail (readiness rewrote the phase).
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type {
  CameraEvent,
  CameraReadinessState,
  CapturedClip,
} from '../src/camera/capture';
import type { CaptureAnalysisOutcome } from '../src/analysis/runCaptureAnalysis';

const mockNavigation = {
  replace: jest.fn(),
  goBack: jest.fn(),
  navigate: jest.fn(),
  popToTop: jest.fn(),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { source: 'camera' } }),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});
jest.mock('../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

type CameraListener = (event: CameraEvent) => void;
const mockCameraListeners = new Set<CameraListener>();
const mockCancelSpy = jest.fn();
let mockCaptureImpl: () => Promise<CapturedClip> = () =>
  Promise.reject(new Error('capture mock not configured'));
jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: () => mockCaptureImpl(),
    importStrokeVideo: () => Promise.reject(new Error('out of scope')),
    cancelCameraOperation: () => mockCancelSpy(),
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
  };
});

let mockOutcome: () => Promise<CaptureAnalysisOutcome> = () =>
  Promise.reject(new Error('outcome not configured'));
const mockRunCaptureAnalysis = jest.fn((): Promise<CaptureAnalysisOutcome> =>
  mockOutcome(),
);
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: () => mockRunCaptureAnalysis(),
}));

// savePendingCapture is deferrable so a readiness read can be injected in
// the window between the capture promise settling and the row being saved.
let mockSavePendingCapture: () => Promise<void> = async () => undefined;
jest.mock('../src/data/repository', () => {
  const actual = jest.requireActual('../src/data/repository');
  return {
    ...actual,
    savePendingCapture: () => mockSavePendingCapture(),
    setCaptureTargetSeed: async () => undefined,
    setDeclaredStroke: async () => undefined,
  };
});

import { AnalyzeScreen, READINESS_COPY } from '../src/screens/AnalyzeScreen';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';

const owner = '22222222-2222-4222-8222-222222222222';

const recordingDb: LocalDb = {
  async execute() {
    return { rows: [] };
  },
  close() {},
};
function mockCurrentDb(): LocalDb {
  return recordingDb;
}

function guidedClip(): CapturedClip {
  return {
    uri: 'file:///captures/run.mov',
    durationMs: 2700,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-04T18:00:00.000Z',
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
      analysisInputFrameCount: 40,
      poseFrameCount: 40,
      poseMissingFrameCount: 0,
      trackedDurationMs: 2700,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: 40,
      jointMotion: [],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 2000,
    postRollMs: 1500,
  };
}

type Record_ = CaptureAnalysisOutcome extends { record: infer R } ? R : never;

function scoredOutcome(freeLimitReached: boolean): CaptureAnalysisOutcome {
  return {
    kind: 'scored',
    analysisId: 'analysis-1',
    record: {} as Record_,
    freeLimitReached,
  };
}

function abstainedOutcome(): CaptureAnalysisOutcome {
  return {
    kind: 'low_confidence',
    analysisId: 'analysis-2',
    record: {
      strokeIntent: { resolutionBasis: 'abstained' },
      result: null,
    } as unknown as Record_,
    guidance: null,
  };
}

async function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  return renderer;
}

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(() => resolve(undefined), 0));
  });
}

async function waitFor(condition: () => boolean, what: string) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await act(async () => {
      await new Promise(resolve => setTimeout(() => resolve(undefined), 10));
    });
  }
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function pressByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
  act(() => node.props.onPress());
}

function pressButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
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

function readinessEvent(
  state: CameraReadinessState,
  jointCoverage = 0.9,
): CameraEvent {
  return {
    emittedAtIso: '2026-09-04T18:00:00.000Z',
    type: 'readiness',
    state,
    poseConfidence: 0.9,
    jointCoverage,
    stableForMs: 300,
    missingJoints: [],
    source: 'apple_vision_body_pose',
    modelVersion: 'apple-vision-bodypose-1',
  };
}

function emitSync(event: CameraEvent) {
  for (const listener of mockCameraListeners) listener(event);
}

function emit(event: CameraEvent) {
  act(() => emitSync(event));
}

/** Every readiness state the contract knows, in one burst. */
function readinessBurst() {
  for (const state of Object.keys(READINESS_COPY) as CameraReadinessState[]) {
    emit(readinessEvent(state));
  }
}

function expectNoReadinessCopy(rendered: string) {
  for (const copy of Object.values(READINESS_COPY)) {
    expect(rendered).not.toContain(copy);
  }
  expect(rendered).not.toContain('Reading your position…');
}

function deferredCapture() {
  let resolveFn!: (clip: CapturedClip) => void;
  let rejectFn!: (error: Error) => void;
  mockCaptureImpl = () =>
    new Promise<CapturedClip>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
  return {
    resolve: (clip: CapturedClip) => act(() => resolveFn(clip)),
    reject: (error: Error) => act(() => rejectFn(error)),
    resolveSync: (clip: CapturedClip) => resolveFn(clip),
    rejectSync: (error: Error) => rejectFn(error),
  };
}

function deferredOutcome() {
  let resolveFn!: (outcome: CaptureAnalysisOutcome) => void;
  mockOutcome = () =>
    new Promise<CaptureAnalysisOutcome>(resolve => {
      resolveFn = resolve;
    });
  return {
    resolve: (outcome: CaptureAnalysisOutcome) =>
      act(async () => {
        resolveFn(outcome);
      }),
  };
}

beforeEach(() => {
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  mockCameraListeners.clear();
  mockCancelSpy.mockClear();
  mockRunCaptureAnalysis.mockClear();
  mockNavigation.replace.mockClear();
  mockNavigation.goBack.mockClear();
  mockNavigation.navigate.mockClear();
  mockNavigation.popToTop.mockClear();
  mockSavePendingCapture = async () => undefined;
  mockOutcome = () => Promise.reject(new Error('outcome not configured'));
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('XC-UAI-08 attack — settled phases survive a readiness burst', () => {
  it('zero-touch scoring: readiness while runCaptureAnalysis is pending keeps the ANALYZING surface', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    const capture = deferredCapture();
    const outcome = deferredOutcome();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    emit(readinessEvent('ready', 0.93));
    expect(textOf(renderer)).toContain(READINESS_COPY.ready);

    capture.resolve(guidedClip());
    await waitFor(
      () => mockRunCaptureAnalysis.mock.calls.length === 1,
      'analysis start',
    );
    expect(textOf(renderer)).toContain('Measuring your swing…');

    readinessBurst();
    const rendered = textOf(renderer);
    expect(rendered).toContain('Measuring your swing…');
    expectNoReadinessCopy(rendered);

    await outcome.resolve(scoredOutcome(false));
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'analysis-1',
    });
    expect(mockRunCaptureAnalysis).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });

  it('saved phase (no declaration): a trailing readiness read never leaves "Capture complete"', async () => {
    const renderer = await renderScreen();
    const capture = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    emit(readinessEvent('hold_still'));
    capture.resolve(guidedClip());
    await waitFor(
      () => textOf(renderer).includes('Capture complete'),
      'saved surface',
    );

    readinessBurst();
    const rendered = textOf(renderer);
    expect(rendered).toContain('Capture complete');
    expect(rendered).toContain('CAPTURE IN HAND');
    expectNoReadinessCopy(rendered);
    expect(mockRunCaptureAnalysis).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it('free_limit phase: readiness never dismisses "That was your last free analysis."', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    mockCaptureImpl = async () => guidedClip();
    mockOutcome = async () => scoredOutcome(true);
    pressButton(renderer, 'Open automatic camera');
    await waitFor(
      () => textOf(renderer).includes('That was your last free analysis.'),
      'free-limit prompt',
    );

    readinessBurst();
    const rendered = textOf(renderer);
    expect(rendered).toContain('That was your last free analysis.');
    expect(rendered).toContain('See my score');
    expectNoReadinessCopy(rendered);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it('analyzed phase (honest abstention): readiness never hides the withheld-result surface', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    mockCaptureImpl = async () => guidedClip();
    mockOutcome = async () => abstainedOutcome();
    pressButton(renderer, 'Open automatic camera');
    await waitFor(
      () => textOf(renderer).includes('result withheld'),
      'abstention surface',
    );

    readinessBurst();
    const rendered = textOf(renderer);
    expect(rendered).toContain('result withheld');
    expect(rendered).toContain('Capture another');
    expectNoReadinessCopy(rendered);
    await act(async () => renderer.unmount());
  });

  it('quality-blocked error: readiness leaves "Nothing was rated." + "Try again"', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    mockCaptureImpl = async () => guidedClip();
    mockOutcome = async () => ({
      kind: 'quality_blocked',
      reason: 'Too dark to read the swing.',
      envelope: {
        overall: 'UNSUPPORTED',
        dimensions: [],
      } as unknown as Extract<
        CaptureAnalysisOutcome,
        { kind: 'quality_blocked' }
      >['envelope'],
    });
    pressButton(renderer, 'Open automatic camera');
    await waitFor(
      () => textOf(renderer).includes('Nothing was rated.'),
      'quality-blocked error',
    );
    expect(textOf(renderer)).toContain('Try again');

    readinessBurst();
    const rendered = textOf(renderer);
    expect(rendered).toContain('Nothing was rated.');
    expect(rendered).toContain('Try again');
    expectNoReadinessCopy(rendered);
    await act(async () => renderer.unmount());
  });

  it('paywall error: readiness leaves "Upgrade to Pro" on screen', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    mockCaptureImpl = async () => guidedClip();
    mockOutcome = async () => ({
      kind: 'unavailable',
      reason: 'Your free analyses are used up.',
      cause: 'paywall_required',
    });
    pressButton(renderer, 'Open automatic camera');
    await waitFor(
      () => textOf(renderer).includes('Upgrade to Pro'),
      'paywall error',
    );

    readinessBurst();
    const rendered = textOf(renderer);
    expect(rendered).toContain('Nothing was rated.');
    expect(rendered).toContain('Upgrade to Pro');
    expectNoReadinessCopy(rendered);
    await act(async () => renderer.unmount());
  });

  it('user cancel returns to the idle landing and a late readiness read keeps it idle', async () => {
    const renderer = await renderScreen();
    const capture = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    emit(readinessEvent('move_closer'));
    expect(textOf(renderer)).toContain(READINESS_COPY.move_closer);
    capture.reject(new Error('Guided capture was canceled.'));
    await flush();
    expect(textOf(renderer)).toContain('Open automatic camera');

    readinessBurst();
    const rendered = textOf(renderer);
    expect(rendered).toContain('Open automatic camera');
    expectNoReadinessCopy(rendered);
    await act(async () => renderer.unmount());
  });
});

describe('XC-UAI-08 attack — same-tick orderings around the capture settling', () => {
  it('readiness emitted in the same tick BEFORE the rejection still ends on the error surface', async () => {
    const renderer = await renderScreen();
    const capture = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    await act(async () => {
      emitSync(readinessEvent('ready'));
      capture.rejectSync(new Error('The camera session was interrupted.'));
    });
    await flush();
    const rendered = textOf(renderer);
    expect(rendered).toContain('Nothing was rated.');
    expect(rendered).toContain('Try again');
    expectNoReadinessCopy(rendered);
    await act(async () => renderer.unmount());
  });

  it('readiness emitted in the same tick AFTER the rejection still ends on the error surface', async () => {
    const renderer = await renderScreen();
    const capture = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    await act(async () => {
      capture.rejectSync(new Error('The camera session was interrupted.'));
      emitSync(readinessEvent('ready'));
    });
    await flush();
    const rendered = textOf(renderer);
    expect(rendered).toContain('Nothing was rated.');
    expect(rendered).toContain('Try again');
    expectNoReadinessCopy(rendered);
    await act(async () => renderer.unmount());
  });

  it('readiness in the same tick as the clip resolving never outlives the saved surface', async () => {
    const renderer = await renderScreen();
    const capture = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    await act(async () => {
      capture.resolveSync(guidedClip());
      emitSync(readinessEvent('no_person', 0));
    });
    await waitFor(
      () => textOf(renderer).includes('Capture complete'),
      'saved surface',
    );
    emit(readinessEvent('no_person', 0));
    const rendered = textOf(renderer);
    expect(rendered).toContain('Capture complete');
    expectNoReadinessCopy(rendered);
    await act(async () => renderer.unmount());
  });

  it('readiness while the capture row is still being saved may update the working copy but is gone once saved', async () => {
    const renderer = await renderScreen();
    const capture = deferredCapture();
    let finishSave!: () => void;
    mockSavePendingCapture = () =>
      new Promise<void>(resolve => {
        finishSave = resolve;
      });
    pressButton(renderer, 'Open automatic camera');
    await flush();
    capture.resolve(guidedClip());
    await flush();
    // Still on the working surface: the row has not been saved yet.
    expect(textOf(renderer)).not.toContain('Capture complete');
    emit(readinessEvent('hold_still'));
    expect(textOf(renderer)).toContain(READINESS_COPY.hold_still);

    await act(async () => {
      finishSave();
    });
    await waitFor(
      () => textOf(renderer).includes('Capture complete'),
      'saved surface',
    );
    emit(readinessEvent('ready'));
    const rendered = textOf(renderer);
    expect(rendered).toContain('Capture complete');
    expectNoReadinessCopy(rendered);
    await act(async () => renderer.unmount());
  });
});

describe('XC-UAI-08 attack — the gate re-arms for the next attempt', () => {
  it('Try again after a capture error lets readiness drive the working phase again, then settles cleanly', async () => {
    const renderer = await renderScreen();
    const first = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    first.reject(new Error('The camera session was interrupted.'));
    await flush();
    expect(textOf(renderer)).toContain('Nothing was rated.');
    emit(readinessEvent('ready'));
    expect(textOf(renderer)).toContain('Nothing was rated.');

    const second = deferredCapture();
    pressButton(renderer, 'Try again');
    await flush();
    expect(textOf(renderer)).toContain('Opening camera…');
    emit(readinessEvent('move_closer', 0.5));
    expect(textOf(renderer)).toContain(READINESS_COPY.move_closer);
    emit(readinessEvent('ready', 0.93));
    expect(textOf(renderer)).toContain(READINESS_COPY.ready);

    second.resolve(guidedClip());
    await waitFor(
      () => textOf(renderer).includes('Capture complete'),
      'saved surface',
    );
    emit(readinessEvent('no_person', 0));
    expect(textOf(renderer)).toContain('Capture complete');
    await act(async () => renderer.unmount());
  });

  it('"Capture another" from the abstention surface re-arms readiness too', async () => {
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    mockCaptureImpl = async () => guidedClip();
    mockOutcome = async () => abstainedOutcome();
    pressButton(renderer, 'Open automatic camera');
    await waitFor(
      () => textOf(renderer).includes('result withheld'),
      'abstention surface',
    );
    const next = deferredCapture();
    pressButton(renderer, 'Capture another');
    await flush();
    expect(textOf(renderer)).toContain('Opening camera…');
    emit(readinessEvent('full_body_required', 0.7));
    expect(textOf(renderer)).toContain(READINESS_COPY.full_body_required);
    next.reject(new Error('Guided capture was canceled.'));
    await flush();
    expect(textOf(renderer)).toContain('Open automatic camera');
    await act(async () => renderer.unmount());
  });

  it('a readiness state outside the copy table only ever shows its fallback while capturing', async () => {
    const renderer = await renderScreen();
    const capture = deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    emit(readinessEvent('future_state' as CameraReadinessState));
    expect(textOf(renderer)).toContain('Reading your position…');
    capture.reject(new Error('The camera session was interrupted.'));
    await flush();
    emit(readinessEvent('future_state' as CameraReadinessState));
    const rendered = textOf(renderer);
    expect(rendered).toContain('Nothing was rated.');
    expect(rendered).not.toContain('Reading your position…');
    await act(async () => renderer.unmount());
  });

  it('unmounting mid-capture cancels the camera and drops the listener so late reads go nowhere', async () => {
    const renderer = await renderScreen();
    deferredCapture();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    expect(mockCameraListeners.size).toBe(1);
    await act(async () => renderer.unmount());
    expect(mockCancelSpy).toHaveBeenCalledTimes(1);
    expect(mockCameraListeners.size).toBe(0);
  });
});
