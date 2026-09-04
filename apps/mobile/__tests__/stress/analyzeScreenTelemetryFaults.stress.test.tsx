/**
 * STRESS mod-telemetry / failure-injection — the usability-funnel and
 * camera/analysis stability emitters in the REAL AnalyzeScreen, with every
 * dependency the screen reaches faulted at its seam:
 *   - camera (captureStrokeVideo / importStrokeVideo): sync throw, reject
 *     (native error with a filesystem path), permission-denied reject, user
 *     cancel, malformed clip, partial clip, slow (45s), never
 *   - SQLite (savePendingCapture via LocalDb.execute): throw, slow, never
 *   - analysis pipeline (runCaptureAnalysis: fetch/API + Vision provider
 *     collapsed at the screen boundary): reject, sync throw, unavailable,
 *     paywall, quality_blocked, malformed outcome, partial outcome, slow, never
 *   - navigation (`replace` / `goBack`): throw
 *
 * Every seed replays from `STRESS_SEED=<n>`. After the fault lands, fake
 * time advances 60s and the screen must be in a recoverable state:
 *   - a visible retry ("Try again") or back ("Close") control;
 *   - no working surface for a settled fault (a never-settling dependency
 *     may still be working ONLY while a "Close" control that cancels the
 *     native operation is on screen — recorded as `stillWorkingAfter60s`);
 *   - no fake success: no `Result` navigation, no `result_opened`, no
 *     `analysis_completed`, no `camera_startup_succeeded` for a failed start;
 *   - no silent failure: an `error_shown` funnel step for every surfaced
 *     error, `camera_startup_failed` for every non-cancel camera fault;
 *   - the funnel/stability recorders never throw and stay well-formed.
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
import {
  pick,
  recordStress,
  sensitiveHits,
  stabilityEventViolations,
  stressSeeds,
  seededRandom,
  tally,
  usabilityEventViolations,
} from '../../testing/stress/faultInjection';

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
jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: () => mockCaptureImpl(),
    importStrokeVideo: () => mockImportImpl(),
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
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import { usabilityFunnel } from '../../src/analysis/usabilityTelemetry';
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

const SUITE = 'mod-telemetry';
const owner = '55555555-5555-4555-8555-555555555555';

// ─── Fault modes ────────────────────────────────────────────────────────────

const CAMERA_FAULTS = [
  'ok',
  'throw_sync',
  'reject_native_path',
  'reject_permission',
  'cancel',
  'malformed_clip',
  'partial_clip',
  'slow_45s',
  'never',
] as const;
type CameraFault = (typeof CAMERA_FAULTS)[number];

const DB_FAULTS = ['ok', 'throw', 'slow_2s', 'never'] as const;
type DbFault = (typeof DB_FAULTS)[number];

const ANALYSIS_FAULTS = [
  'scored',
  'reject',
  'throw_sync',
  'unavailable',
  'paywall',
  'quality_blocked',
  'malformed_outcome',
  'partial_scored',
  'slow_45s',
  'never',
] as const;
type AnalysisFault = (typeof ANALYSIS_FAULTS)[number];

const NAV_FAULTS = ['ok', 'replace_throws', 'goBack_throws'] as const;
type NavFault = (typeof NAV_FAULTS)[number];

interface Plan {
  source: 'camera' | 'library';
  camera: CameraFault;
  db: DbFault;
  analysis: AnalysisFault;
  nav: NavFault;
}

function planFor(seed: number): Plan {
  const random = seededRandom(seed);
  const source = random() < 0.75 ? 'camera' : 'library';
  const camera = random() < 0.35 ? 'ok' : pick(random, CAMERA_FAULTS);
  const db = random() < 0.6 ? 'ok' : pick(random, DB_FAULTS);
  const analysis = random() < 0.2 ? 'scored' : pick(random, ANALYSIS_FAULTS);
  const nav = random() < 0.7 ? 'ok' : pick(random, NAV_FAULTS);
  return { source, camera, db, analysis, nav };
}

const NATIVE_PATH_MESSAGE =
  'AVCaptureSession failed: could not write /var/mobile/Containers/Data/Application/1234/Documents/captures/clip.mov';
const PERMISSION_MESSAGE =
  'Camera access is not allowed. Enable it in Settings to record strokes.';

// ─── Fakes ──────────────────────────────────────────────────────────────────

let dbMode: DbFault = 'ok';
let dbCalls = 0;
const fakeDb: LocalDb = {
  async execute() {
    dbCalls += 1;
    switch (dbMode) {
      case 'ok':
        return { rows: [] };
      case 'throw':
        throw new Error(
          'SQLITE_FULL: database or disk is full (/var/mobile/Containers/Data/Application/1234/Library/pickle.db)',
        );
      case 'slow_2s':
        await new Promise(resolve => setTimeout(resolve, 2_000));
        return { rows: [] };
      case 'never':
        return new Promise(() => {});
    }
  },
  close() {},
};
function mockCurrentDb(): LocalDb {
  return fakeDb;
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
        throw new Error('plans are not part of this campaign');
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

function guidedClip(): CapturedClip {
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
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///captures/run.pose.json',
      frameCount: 40,
      sha256: 'a'.repeat(64),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
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

function importedClip(): CapturedClip {
  const clip = guidedClip();
  const rest: Partial<CapturedClip> = { ...clip };
  delete rest.poseSequence;
  return {
    ...(rest as Omit<CapturedClip, 'poseSequence'>),
    uri: 'file:///captures/import.mov',
    captureMode: 'imported_video',
    trigger: undefined,
    targetSeed: undefined,
  } as unknown as CapturedClip;
}

function captureFor(fault: CameraFault, source: Plan['source']) {
  const good = source === 'library' ? importedClip() : guidedClip();
  switch (fault) {
    case 'ok':
      return () => Promise.resolve(good);
    case 'throw_sync':
      return (): Promise<CapturedClip> => {
        throw new Error('NativeModules.GuidedCapture is null');
      };
    case 'reject_native_path':
      return () => Promise.reject(new Error(NATIVE_PATH_MESSAGE));
    case 'reject_permission':
      return () => Promise.reject(new Error(PERMISSION_MESSAGE));
    case 'cancel':
      return () =>
        Promise.reject(
          Object.assign(new Error('cancelled'), { code: 'camera.cancelled' }),
        );
    case 'malformed_clip':
      return () => Promise.resolve({} as unknown as CapturedClip);
    case 'partial_clip':
      return () =>
        Promise.resolve({
          uri: good.uri,
          durationMs: good.durationMs,
          captureMode: 'automatic_pose_trigger',
        } as unknown as CapturedClip);
    case 'slow_45s':
      return () =>
        new Promise<CapturedClip>(resolve =>
          setTimeout(() => resolve(good), 45_000),
        );
    case 'never':
      return () => new Promise<CapturedClip>(() => {});
  }
}

function scoredOutcome(): CaptureAnalysisOutcome {
  return {
    kind: 'scored',
    analysisId: 'analysis-1',
    record: {} as CaptureAnalysisOutcome extends { record: infer R }
      ? R
      : never,
    freeLimitReached: false,
  };
}

function outcomeFor(
  fault: AnalysisFault,
): () => Promise<CaptureAnalysisOutcome> {
  switch (fault) {
    case 'scored':
      return () => Promise.resolve(scoredOutcome());
    case 'reject':
      return () =>
        Promise.reject(
          new Error(
            'SQLITE_CANTOPEN: /var/mobile/Containers/Data/Application/1234/Library/pickle.db',
          ),
        );
    case 'throw_sync':
      return (): Promise<CaptureAnalysisOutcome> => {
        throw new TypeError(
          "Cannot read properties of undefined (reading 'frames')",
        );
      };
    case 'unavailable':
      return () =>
        Promise.resolve({
          kind: 'unavailable',
          reason: 'The rating service could not be reached.',
        });
    case 'paywall':
      return () =>
        Promise.resolve({
          kind: 'unavailable',
          reason: 'Upgrade to keep rating strokes.',
          cause: 'paywall_required',
        });
    case 'quality_blocked':
      return () =>
        Promise.resolve({
          kind: 'quality_blocked',
          reason:
            'This capture cannot be analyzed honestly. Nothing was rated.',
          envelope: null,
        });
    case 'malformed_outcome':
      return () =>
        Promise.resolve({ kind: 'bogus' } as unknown as CaptureAnalysisOutcome);
    case 'partial_scored':
      return () =>
        Promise.resolve({
          kind: 'scored',
        } as unknown as CaptureAnalysisOutcome);
    case 'slow_45s':
      return () =>
        new Promise(resolve =>
          setTimeout(() => resolve(scoredOutcome()), 45_000),
        );
    case 'never':
      return () => new Promise(() => {});
  }
}

// ─── Renderer helpers ───────────────────────────────────────────────────────

async function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  return renderer;
}

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
    });
  }
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
  await settle(1);
}

function pressables(
  renderer: TestRenderer.ReactTestRenderer,
  predicate: (node: TestRenderer.ReactTestInstance) => boolean,
) {
  return renderer.root.findAll(
    n => typeof n.props.onPress === 'function' && predicate(n),
  );
}

function byLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return pressables(renderer, n => n.props.accessibilityLabel === label)[0];
}

function byText(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const nodes = pressables(
    renderer,
    n =>
      n.findAll(t => t.type === Text && String(t.props.children) === label)
        .length > 0,
  );
  return nodes[nodes.length - 1];
}

function hasText(renderer: TestRenderer.ReactTestRenderer, text: string) {
  return JSON.stringify(renderer.toJSON()).includes(text);
}

function isWorking(renderer: TestRenderer.ReactTestRenderer) {
  return (
    renderer.root.findAll(
      n =>
        n.props.testID === 'stroke-result-analyzing' ||
        n.props.testID === 'analysis-mascot-working',
    ).length > 0
  );
}

/** A retry or back control the user can actually press. */
function recoveryControls(renderer: TestRenderer.ReactTestRenderer) {
  return {
    tryAgain: Boolean(byText(renderer, 'Try again')),
    close: Boolean(byLabel(renderer, 'Close') ?? byText(renderer, 'Close')),
    upgrade: Boolean(byText(renderer, 'Upgrade to Pro')),
  };
}

let clients: BillingAccessDependencies;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  mockSource = 'camera';
  dbMode = 'ok';
  dbCalls = 0;
  mockAnalysisCalls = 0;
  mockCancelSpy.mockClear();
  mockTriggerSync.mockClear();
  mockNavigation.replace.mockReset();
  mockNavigation.goBack.mockReset();
  mockNavigation.navigate.mockReset();
  mockNavigation.popToTop.mockReset();
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
  stabilitySlo.reset();
  stabilitySlo.setContext({ userKey: 'stress-user', sessionKey: 'stress-s' });
  usabilityFunnel.reset();
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  stabilitySlo.reset();
  usabilityFunnel.reset();
  jest.useRealTimers();
});

function applyNavFault(nav: NavFault) {
  if (nav === 'replace_throws') {
    mockNavigation.replace.mockImplementation(() => {
      throw new Error('The action REPLACE was not handled by any navigator');
    });
  }
  if (nav === 'goBack_throws') {
    mockNavigation.goBack.mockImplementation(() => {
      throw new Error('The action GO_BACK was not handled by any navigator');
    });
  }
}

const CANCEL_FAULTS: ReadonlySet<CameraFault> = new Set(['cancel']);
const HANGING_CAMERA: ReadonlySet<CameraFault> = new Set(['never']);
const HANGING_ANALYSIS: ReadonlySet<AnalysisFault> = new Set(['never']);

describe('STRESS mod-telemetry / AnalyzeScreen emitters under faulted camera, SQLite, analysis, navigation', () => {
  for (const seed of stressSeeds('analyzeScreenTelemetryFaults', 20)) {
    const plan = planFor(seed);
    it(`seed ${seed} — source=${plan.source} camera=${plan.camera} db=${plan.db} analysis=${plan.analysis} nav=${plan.nav}`, async () => {
      await recordStress(
        SUITE,
        'analyzeScreenTelemetryFaults',
        seed,
        { ...plan },
        async note => {
          mockSource = plan.source;
          dbMode = plan.db;
          applyNavFault(plan.nav);
          const capture = captureFor(plan.camera, plan.source);
          mockCaptureImpl = capture;
          mockImportImpl = capture;
          mockOutcome = outcomeFor(plan.analysis);

          const renderer = await renderScreen();
          if (plan.source === 'camera') {
            const open = byText(renderer, 'Open automatic camera');
            expect(open).toBeDefined();
            act(() => open!.props.onPress());
          } else {
            // Library imports auto-launch after a 160ms timer.
            await advance(200);
          }
          await settle();
          // ── Stage 1: capture + local save ──
          await advance(60_000);
          const stage1 = {
            working: isWorking(renderer),
            controls: recoveryControls(renderer),
            captureInterrupted: hasText(renderer, 'Capture interrupted'),
            whichStroke: hasText(renderer, 'Which stroke was this?'),
            ready: hasText(renderer, 'Open automatic camera'),
          };
          const cameraFailed =
            plan.camera !== 'ok' &&
            plan.camera !== 'slow_45s' &&
            !CANCEL_FAULTS.has(plan.camera) &&
            !HANGING_CAMERA.has(plan.camera);
          const hangingStage1 =
            HANGING_CAMERA.has(plan.camera) ||
            (plan.db === 'never' &&
              !cameraFailed &&
              !CANCEL_FAULTS.has(plan.camera));

          let stage2: Record<string, unknown> | null = null;
          let reachedScore = false;
          if (stage1.whichStroke) {
            // ── Stage 2: declare + score ──
            const declare = byLabel(renderer, 'Forehand drive');
            expect(declare).toBeDefined();
            act(() => declare!.props.onPress());
            await settle(1);
            const score = byText(renderer, 'Get my Technique Score');
            if (score) {
              reachedScore = true;
              act(() => score.props.onPress());
              await settle();
              await advance(60_000);
              stage2 = {
                working: isWorking(renderer),
                controls: recoveryControls(renderer),
                analysisStopped: hasText(renderer, 'Analysis stopped'),
                nothingRated: hasText(renderer, 'Nothing was rated.'),
                analysisCalls: mockAnalysisCalls,
              };
            }
          }

          const stability = [...stabilitySlo.events()];
          const funnel = [...usabilityFunnel.events()];
          const stabilityTally = tally(stability);
          const funnelTally = tally(funnel);
          const errorDetails = funnel
            .filter(e => e.step === 'error_shown')
            .map(e => e.detail ?? null);
          const funnelHits = sensitiveHits(
            funnel as unknown as Array<Record<string, unknown>>,
          );
          const observed: Record<string, unknown> = {
            stage1,
            stage2,
            reachedScore,
            stability: stabilityTally,
            funnel: funnelTally,
            errorDetails,
            navReplace: mockNavigation.replace.mock.calls.length,
            navGoBack: mockNavigation.goBack.mock.calls.length,
            navNavigate: mockNavigation.navigate.mock.calls.length,
            cancelCalls: mockCancelSpy.mock.calls.length,
            dbCalls,
            stillWorkingAfter60s: (stage2 ?? stage1)['working'],
            funnelSensitiveHits: funnelHits.map(h => `${h.field}:${h.pattern}`),
          };
          note(observed);

          // Recorders stayed well-formed and never threw.
          expect(stabilityEventViolations(stability)).toEqual([]);
          expect(usabilityEventViolations(funnel)).toEqual([]);
          expect(
            sensitiveHits(
              stability as unknown as Array<Record<string, unknown>>,
            ),
          ).toEqual([]);
          expect(funnelTally['analyze_opened']).toBe(1);

          // ── Stage 1 invariants ──
          if (hangingStage1) {
            // A never-settling native capture / SQLite write keeps the working
            // surface up; the header Close must be present and must cancel.
            expect(stage1.working).toBe(true);
            expect(stage1.controls.close).toBe(true);
            expect(stabilityTally['camera_startup_succeeded'] ?? 0).toBe(
              plan.camera === 'never' ? 0 : plan.source === 'camera' ? 1 : 0,
            );
            expect(mockNavigation.replace).not.toHaveBeenCalled();
            const close = byLabel(renderer, 'Close')!;
            act(() => close.props.onPress());
            await settle(1);
            expect(mockCancelSpy).toHaveBeenCalled();
            if (plan.nav !== 'goBack_throws') {
              expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
            }
          } else if (CANCEL_FAULTS.has(plan.camera)) {
            expect(stage1.working).toBe(false);
            expect(funnelTally['attempt_abandoned']).toBe(1);
            expect(funnelTally['error_shown'] ?? 0).toBe(0);
            expect(stabilityTally['camera_startup_failed'] ?? 0).toBe(0);
            expect(stabilityTally['camera_startup_succeeded'] ?? 0).toBe(0);
            if (plan.source === 'camera') expect(stage1.ready).toBe(true);
          } else if (cameraFailed || plan.db === 'throw') {
            // Surfaced error with retry + back, no working surface, no
            // navigation, honest failure telemetry.
            expect(stage1.working).toBe(false);
            expect(stage1.captureInterrupted).toBe(true);
            expect(stage1.controls.tryAgain).toBe(true);
            expect(stage1.controls.close).toBe(true);
            expect(funnelTally['error_shown']).toBe(1);
            expect(funnelTally['capture_saved'] ?? 0).toBe(0);
            expect(mockNavigation.replace).not.toHaveBeenCalled();
            if (plan.source === 'camera') {
              if (cameraFailed) {
                expect(stabilityTally['camera_startup_failed']).toBe(1);
                expect(stabilityTally['camera_startup_succeeded'] ?? 0).toBe(0);
              } else {
                // SQLite failed AFTER a successful start: not a camera fault.
                expect(stabilityTally['camera_startup_succeeded']).toBe(1);
                expect(stabilityTally['camera_startup_failed'] ?? 0).toBe(0);
              }
            }
            // Retry is live: pressing it starts a fresh capture attempt.
            const retry = byText(renderer, 'Try again')!;
            mockCaptureImpl = captureFor('never', plan.source);
            mockImportImpl = mockCaptureImpl;
            act(() => retry.props.onPress());
            await settle();
            expect(isWorking(renderer)).toBe(true);
          } else {
            // Healthy (or slow) capture + save.
            expect(stage1.working).toBe(false);
            expect(funnelTally['capture_saved']).toBe(1);
            if (plan.source === 'camera') {
              expect(stabilityTally['camera_startup_succeeded']).toBe(1);
              expect(stage1.whichStroke).toBe(true);
            }
          }

          // ── Stage 2 invariants ──
          if (stage2 && reachedScore) {
            expect(stage2['analysisCalls']).toBe(1);
            const settledSuccess =
              plan.analysis === 'scored' || plan.analysis === 'slow_45s';
            if (HANGING_ANALYSIS.has(plan.analysis)) {
              expect(stage2['working']).toBe(true);
              expect((stage2['controls'] as { close: boolean }).close).toBe(
                true,
              );
              expect(mockNavigation.replace).not.toHaveBeenCalled();
              expect(funnelTally['result_opened'] ?? 0).toBe(0);
            } else if (settledSuccess) {
              if (plan.nav === 'replace_throws') {
                // Navigation failed after a real score: the error surface
                // must be shown, never a silent dead end.
                expect(stage2['working']).toBe(false);
                expect(stage2['analysisStopped']).toBe(true);
                expect(funnelTally['error_shown']).toBe(1);
              } else {
                // The real navigator replaces this screen on `replace`; the
                // mocked one leaves it mounted, so the working surface is
                // expected to persist here — routing happened exactly once.
                expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
                expect(mockNavigation.replace.mock.calls[0]?.[1]).toEqual({
                  analysisId: 'analysis-1',
                });
                expect(funnelTally['result_opened']).toBe(1);
                expect(funnelTally['error_shown'] ?? 0).toBe(0);
              }
            } else if (
              plan.analysis === 'malformed_outcome' ||
              plan.analysis === 'partial_scored'
            ) {
              // A dependency violating its typed contract: how the screen
              // surfaces it is recorded in the evidence table, not asserted,
              // except that it must not be silent — either an error surface
              // or a navigation dispatch must have happened.
              const surfaced =
                (funnelTally['error_shown'] ?? 0) > 0 ||
                mockNavigation.replace.mock.calls.length > 0;
              expect(surfaced).toBe(true);
            } else {
              // reject / throw / unavailable / paywall / quality_blocked.
              expect(stage2['working']).toBe(false);
              expect(stage2['nothingRated']).toBe(true);
              expect(mockNavigation.replace).not.toHaveBeenCalled();
              expect(funnelTally['result_opened'] ?? 0).toBe(0);
              expect(funnelTally['error_shown']).toBe(1);
              const controls = stage2['controls'] as {
                tryAgain: boolean;
                close: boolean;
                upgrade: boolean;
              };
              expect(controls.close).toBe(true);
              if (plan.analysis === 'paywall') {
                expect(controls.upgrade).toBe(true);
              } else {
                expect(controls.tryAgain).toBe(true);
              }
            }
          }

          // Recorders remain usable after the storm.
          expect(() => usabilityFunnel.log('ready')).not.toThrow();
          expect(() =>
            stabilitySlo.record({ kind: 'camera_startup_succeeded' }),
          ).not.toThrow();
          act(() => renderer.unmount());
          // The privacy invariant is pinned as a known-BROKEN reproduction
          // below; a seed that trips it is filed as broken in the table
          // without masking the recoverability checks above.
          return funnelHits.length > 0
            ? {
                verdict: 'broken',
                brokenInvariant:
                  'error_shown detail carries a raw dependency error message',
              }
            : {};
        },
      );
    });
  }
});

// ─── Pinned boundary observations ───────────────────────────────────────────

describe('STRESS mod-telemetry / AnalyzeScreen pinned observations', () => {
  it.failing(
    'BROKEN P3 — error_shown detail must not carry a raw dependency error message (AnalyzeScreen.tsx:1047 logs error.message; a native camera failure naming a filesystem path lands in the funnel)',
    async () => {
      await recordStress(
        SUITE,
        'analyzeScreenTelemetryFaults.errorShownFreeText',
        1,
        { camera: 'reject_native_path' },
        async note => {
          mockCaptureImpl = captureFor('reject_native_path', 'camera');
          const renderer = await renderScreen();
          act(() => byText(renderer, 'Open automatic camera')!.props.onPress());
          await settle();
          const funnel = [...usabilityFunnel.events()];
          const errorShown = funnel.filter(e => e.step === 'error_shown');
          const hits = sensitiveHits(
            funnel as unknown as Array<Record<string, unknown>>,
          );
          note({
            errorShownDetails: errorShown.map(e => e.detail),
            hits: hits.map(h => `${h.field}:${h.pattern}`),
            surfaced: hasText(renderer, 'Capture interrupted'),
          });
          expect(errorShown).toHaveLength(1);
          expect(hits).toEqual([]);
          act(() => renderer.unmount());
          return {};
        },
        { knownBroken: true },
      );
    },
  );

  it.failing(
    'BROKEN P3 — a camera start that never settles is invisible to the camera_startup SLO (neither camera_startup_failed nor _succeeded after 60s, even after the user closes the hung surface)',
    async () => {
      await recordStress(
        SUITE,
        'analyzeScreenTelemetryFaults.hungCameraInvisible',
        2,
        { camera: 'never' },
        async note => {
          mockCaptureImpl = captureFor('never', 'camera');
          const renderer = await renderScreen();
          act(() => byText(renderer, 'Open automatic camera')!.props.onPress());
          await settle();
          await advance(60_000);
          const close = byLabel(renderer, 'Close')!;
          act(() => close.props.onPress());
          await settle(1);
          const stability = tally(stabilitySlo.events());
          const funnel = tally(usabilityFunnel.events());
          note({
            stability,
            funnel,
            cancelCalls: mockCancelSpy.mock.calls.length,
            goBack: mockNavigation.goBack.mock.calls.length,
          });
          expect(mockCancelSpy).toHaveBeenCalledTimes(1);
          expect(
            (stability['camera_startup_failed'] ?? 0) +
              (funnel['attempt_abandoned'] ?? 0),
          ).toBeGreaterThan(0);
          act(() => renderer.unmount());
          return {};
        },
        { knownBroken: true },
      );
    },
  );

  it('SQLite failure after a successful native start is recorded as error_shown, not camera_startup_failed; Try again + Close are visible', async () => {
    await recordStress(
      SUITE,
      'analyzeScreenTelemetryFaults.pinned',
      3,
      { db: 'throw' },
      async note => {
        dbMode = 'throw';
        mockCaptureImpl = captureFor('ok', 'camera');
        const renderer = await renderScreen();
        act(() => byText(renderer, 'Open automatic camera')!.props.onPress());
        await settle();
        await advance(60_000);
        const stability = tally(stabilitySlo.events());
        const funnel = tally(usabilityFunnel.events());
        const controls = recoveryControls(renderer);
        note({ stability, funnel, controls, working: isWorking(renderer) });
        expect(isWorking(renderer)).toBe(false);
        expect(controls).toEqual({
          tryAgain: true,
          close: true,
          upgrade: false,
        });
        expect(stability).toEqual({ camera_startup_succeeded: 1 });
        expect(funnel['error_shown']).toBe(1);
        expect(funnel['capture_saved'] ?? 0).toBe(0);
        act(() => renderer.unmount());
        return {};
      },
    );
  });

  it('analysis dependency hangs → working surface with Close after 60s; closing dispatches goBack once and records no result_opened / analysis success', async () => {
    await recordStress(
      SUITE,
      'analyzeScreenTelemetryFaults.pinned',
      4,
      { analysis: 'never' },
      async note => {
        mockCaptureImpl = captureFor('ok', 'camera');
        mockOutcome = outcomeFor('never');
        const renderer = await renderScreen();
        act(() => byText(renderer, 'Open automatic camera')!.props.onPress());
        await settle();
        act(() => byLabel(renderer, 'Forehand drive')!.props.onPress());
        await settle(1);
        act(() => byText(renderer, 'Get my Technique Score')!.props.onPress());
        await settle();
        await advance(60_000);
        const workingAfter60s = isWorking(renderer);
        const close = byLabel(renderer, 'Close');
        note({
          workingAfter60s,
          closeVisible: Boolean(close),
          funnel: tally(usabilityFunnel.events()),
        });
        expect(workingAfter60s).toBe(true);
        expect(close).toBeDefined();
        act(() => close!.props.onPress());
        await settle(1);
        expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
        expect(mockNavigation.replace).not.toHaveBeenCalled();
        expect(tally(usabilityFunnel.events())['result_opened'] ?? 0).toBe(0);
        act(() => renderer.unmount());
        return {};
      },
    );
  });
});
