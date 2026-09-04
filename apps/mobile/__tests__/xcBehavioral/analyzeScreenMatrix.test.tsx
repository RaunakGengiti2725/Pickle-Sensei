/**
 * xc-matrix-behavioral — AnalyzeScreen under interaction storms.
 *
 * The REAL AnalyzeScreen is rendered (react-test-renderer + Jest modern fake
 * timers); the native camera, the analysis pipeline and the outbox trigger
 * are replaced by controllable seams so every interleaving below is exact
 * and replayable (`XC_SEED=<seed>`). Production code and existing tests are
 * untouched — this file only adds scenarios.
 *
 * Invariants asserted on every seed:
 *   - exactly one analysis run (== one permit reservation) per in-flight
 *     scoring action, however many taps land;
 *   - exactly one native capture per capture action;
 *   - no orphan loading state: once the in-flight work settles, the
 *     "working" surface is gone, `analysisProgress` is cleared, and nothing
 *     is dispatched to navigation after the screen was abandoned;
 *   - abandoning the screen mid-capture cancels the native operation once.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { CapturedClip } from '../../src/camera/capture';
import type { CaptureAnalysisOutcome } from '../../src/analysis/runCaptureAnalysis';
import { deferred } from '../../testing/xcBehavioral/deferred';
import {
  randomInt,
  recordScenario,
  scenarioSeeds,
  seededRandom,
} from '../../testing/xcBehavioral/evidence';

const mockNavigation = {
  replace: jest.fn(),
  goBack: jest.fn(),
  navigate: jest.fn(),
  popToTop: jest.fn(),
};
let mockSource: 'camera' | 'library' = 'camera';
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { source: mockSource } }),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

let mockCaptureImpl: () => Promise<CapturedClip> = () =>
  Promise.reject(new Error('capture mock not configured'));
let mockImportImpl: () => Promise<CapturedClip> = () =>
  Promise.reject(new Error('import mock not configured'));
const mockCancelSpy = jest.fn();
let mockCaptureCalls = 0;
jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: () => {
      mockCaptureCalls += 1;
      return mockCaptureImpl();
    },
    importStrokeVideo: () => {
      mockCaptureCalls += 1;
      return mockImportImpl();
    },
    cancelCameraOperation: () => mockCancelSpy(),
    subscribeToCameraEvents: () => () => undefined,
  };
});

let mockOutcome: () => Promise<CaptureAnalysisOutcome> = () =>
  Promise.reject(new Error('outcome not configured'));
let mockAnalysisCalls = 0;
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: () => {
    mockAnalysisCalls += 1;
    return mockOutcome();
  },
}));

const mockTriggerSync = jest.fn();
jest.mock('../../src/data/syncRuntime', () => ({
  triggerOutboxSync: () => mockTriggerSync(),
  configureSyncRuntime: () => undefined,
  clearSyncRuntime: () => undefined,
}));

import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../../src/billing/types';

const SUITE = 'analyzeScreenMatrix';
const owner = '22222222-2222-4222-8222-222222222222';

interface RecordedCall {
  sql: string;
  params: unknown[];
}
let dbCalls: RecordedCall[] = [];
const recordingDb: LocalDb = {
  async execute(sql, params = []) {
    dbCalls.push({ sql, params });
    return { rows: [] };
  },
  close() {},
};
function mockCurrentDb(): LocalDb {
  return recordingDb;
}

function freeAccess(used: number, reserved = 0): CanonicalAccessState {
  const remaining = 2 - used;
  const availableToReserve = remaining - reserved;
  return {
    premium: false,
    entitlements: [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating: availableToReserve > 0,
    paywallRequired: availableToReserve <= 0,
  };
}

function billing(): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => {
        throw new Error('plans are not part of this matrix');
      }),
      purchase: jest.fn(),
      restore: jest.fn(),
      readEntitlement: jest.fn(),
    },
    backend: {
      getAccess: jest.fn(async () => freeAccess(1, 1)),
      syncBilling: jest.fn(),
    },
  };
}

function guidedClip(withPose: boolean): CapturedClip {
  return {
    uri: 'file:///captures/run.mov',
    durationMs: 2700,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-02T18:00:00.000Z',
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
    ...(withPose
      ? {
          poseSequence: {
            schemaVersion: 1 as const,
            format: 'pickle.pose-sequence.v1' as const,
            uri: 'file:///captures/run.pose.json',
            frameCount: 40,
            sha256: 'a'.repeat(64),
            coordinateSystem: 'normalized_image_top_left' as const,
            poseModelVersion: 'apple-vision-bodypose-1',
          },
        }
      : {}),
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

function scoredOutcome(freeLimitReached = false): CaptureAnalysisOutcome {
  return {
    kind: 'scored',
    analysisId: 'analysis-1',
    record: {} as CaptureAnalysisOutcome extends { record: infer R }
      ? R
      : never,
    freeLimitReached,
  };
}

async function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  return renderer;
}

/** Drains microtasks + the macrotask queue (setImmediate stays real). */
async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
    });
  }
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await settle(1);
}

function findPressables(
  renderer: TestRenderer.ReactTestRenderer,
  predicate: (node: TestRenderer.ReactTestInstance) => boolean,
) {
  return renderer.root.findAll(
    n => typeof n.props.onPress === 'function' && predicate(n),
  );
}

function byLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const nodes = findPressables(
    renderer,
    n => n.props.accessibilityLabel === label,
  );
  const node = nodes[0];
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
  return node;
}

function byText(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const nodes = findPressables(
    renderer,
    n =>
      n.findAll(t => t.type === Text && String(t.props.children) === label)
        .length > 0,
  );
  const node = nodes[nodes.length - 1];
  if (!node) throw new Error(`No button labeled ${label}`);
  return node;
}

function hasText(renderer: TestRenderer.ReactTestRenderer, text: string) {
  return JSON.stringify(renderer.toJSON()).includes(text);
}

/** The working phase renders exactly one of these two surfaces. */
function isWorking(renderer: TestRenderer.ReactTestRenderer) {
  return (
    renderer.root.findAll(
      n =>
        n.props.testID === 'stroke-result-analyzing' ||
        n.props.testID === 'analysis-mascot-working',
    ).length > 0
  );
}

/** Fires `taps` presses of `node` with seeded interleaving: some presses
 * are synchronous in the same tick, some after a microtask, some after a
 * timer tick. Every arrangement must collapse to ONE action. */
async function stormPress(
  node: TestRenderer.ReactTestInstance,
  taps: number,
  random: () => number,
): Promise<string[]> {
  // The handler is captured once: queued touches land on the pressable the
  // user saw, even after the first press has already re-rendered it away.
  const press = node.props.onPress as () => void;
  const gaps: string[] = [];
  for (let i = 0; i < taps; i += 1) {
    const roll = random();
    if (roll < 0.5) {
      gaps.push('sync');
      act(() => press());
    } else if (roll < 0.8) {
      gaps.push('microtask');
      await act(async () => {
        press();
        await Promise.resolve();
      });
    } else {
      gaps.push('timer');
      act(() => press());
      await advance(1 + Math.floor(random() * 50));
    }
  }
  return gaps;
}

/** Gets the real screen to the SAVED surface with a scoreable clip and a
 * declared stroke, so 'Get my Technique Score' is enabled and idle. */
async function reachSavedSurface(renderer: TestRenderer.ReactTestRenderer) {
  mockCaptureImpl = async () => guidedClip(true);
  act(() => byText(renderer, 'Open automatic camera').props.onPress());
  await settle();
  expect(hasText(renderer, 'Which stroke was this?')).toBe(true);
  act(() => byLabel(renderer, 'Forehand drive').props.onPress());
  await settle(1);
}

let clients: BillingAccessDependencies;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  mockSource = 'camera';
  dbCalls = [];
  mockCaptureCalls = 0;
  mockAnalysisCalls = 0;
  mockCancelSpy.mockClear();
  mockTriggerSync.mockClear();
  mockNavigation.replace.mockClear();
  mockNavigation.goBack.mockClear();
  mockNavigation.navigate.mockClear();
  mockNavigation.popToTop.mockClear();
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  clearAccessStoreConfiguration();
  clients = billing();
  configureAccessStore(clients);
  useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess(0) });
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.useRealTimers();
});

describe('xc-matrix-behavioral: AnalyzeScreen interaction storms', () => {
  describe('rapid tapping "Get my Technique Score" reserves ONE permit', () => {
    for (const seed of scenarioSeeds('rapidScoreTap')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const taps = randomInt(random, 2, 12);
        const outcomeKind = random() < 0.5 ? 'scored' : 'unavailable';
        await recordScenario(
          SUITE,
          'rapidScoreTap',
          seed,
          { taps, outcomeKind },
          async () => {
            const renderer = await renderScreen();
            await reachSavedSurface(renderer);
            const gate = deferred<CaptureAnalysisOutcome>();
            mockOutcome = () => gate.promise;
            const score = byText(renderer, 'Get my Technique Score');
            const gaps = await stormPress(score, taps, random);
            // The run awaits its declaration/target-seed writes before the
            // analysis call; let those settle, then count.
            await settle();
            // Every extra tap while the run is in flight is ignored.
            expect(mockAnalysisCalls).toBe(1);
            expect(isWorking(renderer)).toBe(true);
            if (outcomeKind === 'scored') gate.resolve(scoredOutcome());
            else {
              gate.resolve({
                kind: 'unavailable',
                reason: 'The rating service could not be reached.',
              });
            }
            await settle();
            if (outcomeKind === 'scored') {
              // Routed exactly once; the navigator replaces this screen.
              expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
              expect(mockTriggerSync).toHaveBeenCalledTimes(1);
            } else {
              // No orphan loading state once the single run settles.
              expect(isWorking(renderer)).toBe(false);
              expect(hasText(renderer, 'Nothing was rated.')).toBe(true);
              expect(mockTriggerSync).not.toHaveBeenCalled();
              // The Try-again surface is live: a fresh tap starts ONE new
              // capture, not a second scoring of the old clip.
              const again = byText(renderer, 'Try again');
              const before = mockCaptureCalls;
              mockCaptureImpl = () => deferred<CapturedClip>().promise;
              await stormPress(again, randomInt(random, 2, 6), random);
              expect(mockCaptureCalls).toBe(before + 1);
              expect(mockAnalysisCalls).toBe(1);
            }
            await act(async () => renderer.unmount());
            await settle(1);
            expect(mockAnalysisCalls).toBe(1);
            return {
              gaps,
              analysisCalls: mockAnalysisCalls,
              replaceCalls: mockNavigation.replace.mock.calls.length,
              syncTriggers: mockTriggerSync.mock.calls.length,
            };
          },
        );
      });
    }
  });

  describe('double-submitting "Open automatic camera" opens ONE capture', () => {
    for (const seed of scenarioSeeds('doubleSubmitCamera')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const taps = randomInt(random, 2, 10);
        const declareFirst = random() < 0.5;
        await recordScenario(
          SUITE,
          'doubleSubmitCamera',
          seed,
          { taps, declareFirst },
          async () => {
            const renderer = await renderScreen();
            if (declareFirst) {
              act(() => byLabel(renderer, 'Forehand Drive').props.onPress());
              await settle(1);
            }
            const gate = deferred<CapturedClip>();
            mockCaptureImpl = () => gate.promise;
            const open = byText(renderer, 'Open automatic camera');
            const gaps = await stormPress(open, taps, random);
            expect(mockCaptureCalls).toBe(1);
            expect(isWorking(renderer)).toBe(true);
            // A second run() after the first capture settles is a NEW
            // attempt — but not while this one is pending.
            const analysis = deferred<CaptureAnalysisOutcome>();
            mockOutcome = () => analysis.promise;
            gate.resolve(guidedClip(true));
            await settle();
            expect(mockCaptureCalls).toBe(1);
            if (declareFirst) {
              // Zero-touch: declared before recording → auto-scores once.
              expect(mockAnalysisCalls).toBe(1);
              analysis.resolve(scoredOutcome());
              await settle();
              expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
            } else {
              expect(mockAnalysisCalls).toBe(0);
              expect(hasText(renderer, 'Which stroke was this?')).toBe(true);
              expect(isWorking(renderer)).toBe(false);
            }
            await act(async () => renderer.unmount());
            // Nothing was mid-flight at unmount: the native cancel is not
            // fired for an idle camera.
            expect(mockCancelSpy).not.toHaveBeenCalled();
            return {
              gaps,
              captureCalls: mockCaptureCalls,
              analysisCalls: mockAnalysisCalls,
            };
          },
        );
      });
    }
  });

  describe('closing the working surface during scoring: no navigation after abandon, run completes durably', () => {
    for (const seed of scenarioSeeds('closeDuringScoring')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const outcomeKind = (['scored', 'unavailable', 'throw'] as const)[
          randomInt(random, 0, 2)
        ]!;
        const unmountBeforeSettle = random() < 0.5;
        await recordScenario(
          SUITE,
          'closeDuringScoring',
          seed,
          { outcomeKind, unmountBeforeSettle },
          async () => {
            const renderer = await renderScreen();
            await reachSavedSurface(renderer);
            const gate = deferred<CaptureAnalysisOutcome>();
            mockOutcome = () => gate.promise;
            act(() =>
              byText(renderer, 'Get my Technique Score').props.onPress(),
            );
            await settle(1);
            expect(mockAnalysisCalls).toBe(1);
            expect(isWorking(renderer)).toBe(true);
            // Navigation during processing: header Close on the working
            // surface.
            const close = byLabel(renderer, 'Close');
            await stormPress(close, randomInt(random, 1, 4), random);
            const goBacksAtClose = mockNavigation.goBack.mock.calls.length;
            if (unmountBeforeSettle) await act(async () => renderer.unmount());
            if (outcomeKind === 'scored') gate.resolve(scoredOutcome());
            else if (outcomeKind === 'unavailable') {
              gate.resolve({ kind: 'unavailable', reason: 'offline' });
            } else gate.reject(new Error('pipeline exploded'));
            await settle();
            // The abandoned run never routes: no Result push, no error
            // surface re-appears on a screen the user left.
            expect(mockNavigation.replace).not.toHaveBeenCalled();
            expect(mockNavigation.goBack.mock.calls.length).toBe(
              goBacksAtClose,
            );
            if (outcomeKind === 'scored') {
              // The rating is durable and leaves for the server even
              // though the user navigated away.
              expect(mockTriggerSync).toHaveBeenCalledTimes(1);
            } else expect(mockTriggerSync).not.toHaveBeenCalled();
            if (!unmountBeforeSettle) {
              // Still mounted (navigator not yet torn down): the working
              // surface must not be left spinning forever.
              expect(hasText(renderer, 'Nothing was rated.')).toBe(false);
              await act(async () => renderer.unmount());
            }
            await settle(1);
            // Access ledger re-read happens exactly once, after unmount.
            expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
            expect(mockAnalysisCalls).toBe(1);
            return {
              goBacks: goBacksAtClose,
              analysisCalls: mockAnalysisCalls,
              syncTriggers: mockTriggerSync.mock.calls.length,
            };
          },
        );
      });
    }
  });

  describe('cancel / close during capture: native cancel fires once, no orphan working state', () => {
    for (const seed of scenarioSeeds('closeDuringCapture')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const source = random() < 0.5 ? 'camera' : 'library';
        const nativeSettles = (['cancel', 'clip', 'error', 'never'] as const)[
          randomInt(random, 0, 3)
        ]!;
        const closeTaps = randomInt(random, 1, 3);
        // Camera only: a stroke declared before recording arms zero-touch
        // scoring of whatever clip the native side still delivers.
        const declareFirst = source === 'camera' && random() < 0.5;
        await recordScenario(
          SUITE,
          'closeDuringCapture',
          seed,
          { source, nativeSettles, closeTaps, declareFirst },
          async () => {
            mockSource = source;
            const gate = deferred<CapturedClip>();
            mockCaptureImpl = () => gate.promise;
            mockImportImpl = () => gate.promise;
            const analysis = deferred<CaptureAnalysisOutcome>();
            mockOutcome = () => analysis.promise;
            const renderer = await renderScreen();
            if (source === 'camera') {
              if (declareFirst) {
                act(() => byLabel(renderer, 'Forehand Drive').props.onPress());
                await settle(1);
              }
              act(() =>
                byText(renderer, 'Open automatic camera').props.onPress(),
              );
            } else {
              // Library auto-launches after its 160ms arm timer.
              await advance(200);
            }
            await settle(1);
            expect(mockCaptureCalls).toBe(1);
            expect(isWorking(renderer)).toBe(true);
            const close = byLabel(renderer, 'Close');
            await stormPress(close, closeTaps, random);
            const cancelsAtClose = mockCancelSpy.mock.calls.length;
            const goBacksAtClose = mockNavigation.goBack.mock.calls.length;
            expect(cancelsAtClose).toBe(closeTaps);
            expect(goBacksAtClose).toBe(closeTaps);
            // The native side answers the cancel (Swift finishWithError
            // "camera.cancelled" → message contains "canceled").
            if (nativeSettles === 'cancel') {
              gate.reject(
                new Error(
                  source === 'library'
                    ? 'Video import was canceled.'
                    : 'Camera capture was canceled.',
                ),
              );
            } else if (nativeSettles === 'clip') gate.resolve(guidedClip(true));
            else if (nativeSettles === 'error') {
              gate.reject(new Error('Camera session interrupted.'));
            }
            await settle();
            const goBacksAfterNative = mockNavigation.goBack.mock.calls.length;
            // Observed, not asserted: whether an analysis (permit) starts
            // for a clip the user had already abandoned.
            const analysesAfterAbandon = mockAnalysisCalls;
            expect(mockAnalysisCalls).toBeLessThanOrEqual(1);
            const pendingCaptureRows = dbCalls.filter(c =>
              c.sql.includes('INSERT INTO local_capture'),
            ).length;
            if (mockAnalysisCalls === 1) {
              analysis.resolve(scoredOutcome());
              await settle();
            }
            // Never routes a screen the user left.
            expect(mockNavigation.replace).not.toHaveBeenCalled();
            await act(async () => renderer.unmount());
            await settle(1);
            // Unmount with the operation still pending cancels once more;
            // a settled operation is not re-cancelled.
            const expectedCancels =
              nativeSettles === 'never' ? cancelsAtClose + 1 : cancelsAtClose;
            expect(mockCancelSpy.mock.calls.length).toBe(expectedCancels);
            expect(clients.backend.getAccess).toHaveBeenCalledTimes(
              analysesAfterAbandon,
            );
            return {
              cancels: mockCancelSpy.mock.calls.length,
              goBacksAtClose,
              goBacksAfterNative,
              extraGoBacks: goBacksAfterNative - goBacksAtClose,
              analysesAfterAbandon,
              syncTriggersAfterAbandon: mockTriggerSync.mock.calls.length,
              pendingCaptureRows,
            };
          },
        );
      });
    }
  });

  describe('simultaneous scoring + re-capture in one tick: one analysis, one capture, camera cancelled on unmount', () => {
    for (const seed of scenarioSeeds('simultaneousScoreAndCapture')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const scoreFirst = random() < 0.5;
        const extraTaps = randomInt(random, 0, 4);
        await recordScenario(
          SUITE,
          'simultaneousScoreAndCapture',
          seed,
          { scoreFirst, extraTaps },
          async () => {
            const renderer = await renderScreen();
            await reachSavedSurface(renderer);
            const analysis = deferred<CaptureAnalysisOutcome>();
            mockOutcome = () => analysis.promise;
            const camera = deferred<CapturedClip>();
            mockCaptureImpl = () => camera.promise;
            const score = byText(renderer, 'Get my Technique Score').props
              .onPress as () => void;
            const again = byText(renderer, 'Capture another').props
              .onPress as () => void;
            const capturesBefore = mockCaptureCalls;
            // Both handlers fire inside ONE act — the saved surface has not
            // re-rendered between them.
            act(() => {
              if (scoreFirst) {
                score();
                again();
              } else {
                again();
                score();
              }
              for (let i = 0; i < extraTaps; i += 1) {
                score();
                again();
              }
            });
            await settle();
            expect(mockAnalysisCalls).toBe(1);
            expect(mockCaptureCalls).toBe(capturesBefore + 1);
            expect(isWorking(renderer)).toBe(true);
            // Scoring lands first: Result navigation replaces this screen
            // while the camera is still open natively...
            analysis.resolve(scoredOutcome());
            await settle();
            expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
            expect(mockTriggerSync).toHaveBeenCalledTimes(1);
            // ...so the navigator unmounts it: the pending capture MUST be
            // cancelled natively, exactly once.
            await act(async () => renderer.unmount());
            expect(mockCancelSpy).toHaveBeenCalledTimes(1);
            camera.reject(new Error('Camera capture was canceled.'));
            await settle();
            expect(mockAnalysisCalls).toBe(1);
            expect(mockNavigation.goBack).not.toHaveBeenCalled();
            return {
              analysisCalls: mockAnalysisCalls,
              captureCalls: mockCaptureCalls - capturesBefore,
              cancels: mockCancelSpy.mock.calls.length,
            };
          },
        );
      });
    }
  });

  describe('retry after a failed run: each retry is one capture; stale progress never leaks into it', () => {
    for (const seed of scenarioSeeds('retryLoop')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const rounds = randomInt(random, 1, 4);
        await recordScenario(SUITE, 'retryLoop', seed, { rounds }, async () => {
          const renderer = await renderScreen();
          act(() => byLabel(renderer, 'Forehand Drive').props.onPress());
          await settle(1);
          let captureCalls = 0;
          let analysisCalls = 0;
          for (let round = 0; round < rounds; round += 1) {
            const failAt = random() < 0.5 ? 'capture' : 'analysis';
            const camera = deferred<CapturedClip>();
            mockCaptureImpl = () => camera.promise;
            const analysis = deferred<CaptureAnalysisOutcome>();
            mockOutcome = () => analysis.promise;
            const button =
              round === 0
                ? byText(renderer, 'Open automatic camera')
                : byText(renderer, 'Try again');
            await stormPress(button, randomInt(random, 1, 5), random);
            captureCalls += 1;
            expect(mockCaptureCalls).toBe(captureCalls);
            if (failAt === 'capture') {
              camera.reject(new Error('Camera session interrupted.'));
              await settle();
              expect(hasText(renderer, 'Capture interrupted')).toBe(true);
            } else {
              camera.resolve(guidedClip(true));
              await settle();
              analysisCalls += 1;
              expect(mockAnalysisCalls).toBe(analysisCalls);
              expect(isWorking(renderer)).toBe(true);
              analysis.reject(new Error('pipeline exploded'));
              await settle();
              expect(hasText(renderer, 'Analysis stopped')).toBe(true);
            }
            expect(isWorking(renderer)).toBe(false);
            expect(hasText(renderer, 'Nothing was rated.')).toBe(true);
          }
          // Final successful round proves the retry surface is not stuck.
          const camera = deferred<CapturedClip>();
          mockCaptureImpl = () => camera.promise;
          mockOutcome = async () => scoredOutcome();
          act(() => byText(renderer, 'Try again').props.onPress());
          await settle(1);
          camera.resolve(guidedClip(true));
          await settle();
          expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
          expect(mockAnalysisCalls).toBe(analysisCalls + 1);
          expect(mockTriggerSync).toHaveBeenCalledTimes(1);
          await act(async () => renderer.unmount());
          return {
            captureCalls: mockCaptureCalls,
            analysisCalls: mockAnalysisCalls,
          };
        });
      });
    }
  });

  describe('free-limit prompt: rapid "See my score" routes ONCE per surface', () => {
    for (const seed of scenarioSeeds('freeLimitDoubleTap')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const taps = randomInt(random, 2, 8);
        await recordScenario(
          SUITE,
          'freeLimitDoubleTap',
          seed,
          { taps },
          async () => {
            const renderer = await renderScreen();
            await reachSavedSurface(renderer);
            mockOutcome = async () => scoredOutcome(true);
            act(() =>
              byText(renderer, 'Get my Technique Score').props.onPress(),
            );
            await settle();
            expect(hasText(renderer, 'That was your last free analysis.')).toBe(
              true,
            );
            const see = byText(renderer, 'See my score');
            await stormPress(see, taps, random);
            const replaces = mockNavigation.replace.mock.calls.length;
            expect(mockAnalysisCalls).toBe(1);
            expect(mockTriggerSync).toHaveBeenCalledTimes(1);
            await act(async () => renderer.unmount());
            return { taps, replaces };
          },
        );
      });
    }
  });
});
