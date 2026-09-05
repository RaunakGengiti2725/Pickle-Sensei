/**
 * STRESS / failure-injection — `mod-capture` at the USER-VISIBLE boundary.
 *
 * The real AnalyzeScreen is mounted over the REAL `src/camera/capture` module
 * (validators, event subscription, cancellation) and the REAL envelope
 * evaluator; only the native `PickleVideoCapture` bridge object, the SQLite
 * repository, the analysis runner and navigation are replaced by controllable
 * fakes so faults can be injected at every dependency the capture flow
 * touches:
 *
 *   native camera / photo picker   reject (Error / typed cancel / non-Error),
 *                                  synchronous throw, malformed or partial
 *                                  receipt, method missing, slow, never resolves
 *   native event emitter           malformed readiness / quality payloads,
 *                                  non-object payloads, unknown event types
 *   SQLite (savePendingCapture,    reject, throw, slow, never resolves
 *           setCaptureTargetSeed)
 *   analysis runner                reject, throw, never resolves
 *
 * Asserted on every iteration: a recoverable, user-visible state (an alert
 * with "Try again" + "Close", or the ready landing, or a Close header while
 * work is honestly still pending after 60s of fake time), no fake success (a
 * failed capture never reaches persistence or analysis; a failed persistence
 * never reaches analysis), no silent failure (every fault surfaces), no
 * duplicate work, and the envelope handed to analysis never carries a
 * measurement nobody made. Every iteration is replayable with
 * `STRESS_SEED=<seed> STRESS_ITER=1`; `STRESS_OUT=<dir>` writes the JSON table.
 *
 * Known findings this harness reproduces (the oracles are deliberately NOT
 * relaxed; the campaigns below stay red until the boundary is fixed):
 *   - malformed-native-events: `subscribeToCameraEvents` casts the native
 *     payload without validation, so `readiness.jointCoverage` of
 *     undefined / true / "0.9" reaches `classifyDimension` and is reported
 *     SUPPORTED with a non-numeric `measured` in the analysis request
 *     (replay STRESS_SEED=285320668 or 2503616709 with STRESS_ITER=1).
 *   - malformed-native-events: a null / undefined event payload throws in the
 *     screen's listener (`event.type`) — replay STRESS_SEED=2210092711.
 *   - native-capture-fault: a non-Error rejection is rendered verbatim
 *     ("[object Object]" / "undefined") — replay STRESS_SEED=3819168654.
 */
jest.mock('react-native', () => {
  const rn = jest.requireActual<typeof import('react-native')>('react-native');
  // The bridge object the real capture module reads at import time. Methods
  // are jest.fn so each iteration can program throw / reject / hang / slow.
  (rn.NativeModules as Record<string, unknown>).PickleVideoCapture = {
    capture: jest.fn(),
    importVideo: jest.fn(),
    cancel: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
  return rn;
});
jest.mock('../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));
jest.mock('../../src/data/repository', () => ({
  savePendingCapture: jest.fn(() => Promise.resolve()),
  setCaptureTargetSeed: jest.fn(() => Promise.resolve()),
  setDeclaredStroke: jest.fn(() => Promise.resolve()),
  updateCaptureClipPayload: jest.fn(() => Promise.resolve()),
  getKv: jest.fn(() => Promise.resolve(null)),
  setKv: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: jest.fn(() => null),
}));
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../../src/camera/TargetSelector', () => ({
  TargetSelector: () => null,
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
const mockRoute: { params: Record<string, unknown> } = { params: {} };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => mockRoute,
}));

import * as fs from 'node:fs';
import * as path from 'node:path';
import React from 'react';
import { DeviceEventEmitter, NativeModules } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type { EnvelopeVerdict } from '@pickle/shared-types';
import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import {
  armTryAgain,
  consumeTryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import {
  savePendingCapture,
  setCaptureTargetSeed,
} from '../../src/data/repository';

const bridge = (
  NativeModules as {
    PickleVideoCapture: {
      capture: jest.Mock;
      importVideo: jest.Mock;
      cancel: jest.Mock;
    };
  }
).PickleVideoCapture;
const runMock = runCaptureAnalysis as jest.Mock;
const saveMock = savePendingCapture as jest.Mock;
const seedMock = setCaptureTargetSeed as jest.Mock;

// ---------------------------------------------------------------------------
// Seeded RNG + campaign bookkeeping (same scheme as captureBridgeFaults)
// ---------------------------------------------------------------------------

const STRESS_ITER = Math.max(1, Number(process.env.STRESS_ITER ?? '12') || 12);
const STRESS_SEED = Number(process.env.STRESS_SEED ?? '20260905') >>> 0;
const STRESS_OUT = process.env.STRESS_OUT;
const REPLAY_SINGLE_SEED =
  Boolean(process.env.STRESS_SEED) && process.env.STRESS_ITER === '1';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(readonly seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[this.int(items.length)] as T;
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
}

function iterationSeed(campaign: number, i: number): number {
  const rng = mulberry32((STRESS_SEED ^ (campaign * 0x9e3779b9)) >>> 0);
  let seed = 0;
  for (let k = 0; k <= i; k += 1) seed = Math.floor(rng() * 4294967296);
  return seed >>> 0;
}

interface Row {
  campaign: string;
  iteration: number;
  seed: number;
  scenario: string;
  outcome: 'HELD' | 'BROKEN';
  detail: string;
}

const results: Row[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

afterAll(() => {
  if (!STRESS_OUT) return;
  fs.mkdirSync(STRESS_OUT, { recursive: true });
  fs.writeFileSync(
    path.join(STRESS_OUT, 'analyzeScreenCaptureFaults.results.json'),
    JSON.stringify(
      {
        suite: 'analyzeScreenCaptureFaults.stress',
        baseSeed: STRESS_SEED,
        iterationsPerCampaign: STRESS_ITER,
        executed: results.length,
        broken: results.filter(r => r.outcome === 'BROKEN').length,
        rows: results,
      },
      null,
      2,
    ),
  );
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function guidedClip(id: string) {
  return {
    uri: `file:///private/var/mobile/clip-${id}.mov`,
    durationMs: 4200,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso: '2026-09-05T00:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    trigger: {
      startMs: 2000,
      endMs: 2700,
      peakMotionMs: 2400,
      confidence: 0.82,
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
    },
    preRollMs: 2000,
    postRollMs: 1500,
    targetSeed: { x: 0.5, y: 0.6 },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///private/var/mobile/clip-${id}.pose.json`,
      frameCount: 6,
      sha256: 'a'.repeat(64),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

function importedClip(id: string) {
  return {
    uri: `file:///private/var/mobile/import-${id}.mov`,
    durationMs: 4200,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso: '2026-09-05T00:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
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

const NATIVE_ERRORS = [
  'Camera permission denied. Enable access in Settings.',
  'Photos permission denied. Enable access in Settings.',
  'The camera is in use by another app.',
  'Recording stopped: the device is too hot.',
  'Not enough storage to record video.',
  'The camera session was interrupted.',
  '',
] as const;

const NON_ERROR_REJECTIONS: readonly unknown[] = [
  'camera failed',
  42,
  null,
  undefined,
  { code: 'E_UNKNOWN' },
  ['boom'],
];

const SQLITE_ERRORS = [
  'database is locked',
  'disk I/O error',
  'attempt to write a readonly database',
  'SQLITE_FULL: database or disk is full',
] as const;

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function textOf(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function findByLabel(
  renderer: ReactTestRenderer,
  label: string,
): ReactTestInstance | undefined {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  )[0];
}

function hasAlert(renderer: ReactTestRenderer): boolean {
  return (
    renderer.root.findAll(node => node.props.accessibilityRole === 'alert')
      .length > 0
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await flush();
}

type Source = 'camera' | 'library';

async function mountScreen(source: Source): Promise<ReactTestRenderer> {
  if (source === 'camera') {
    // AUTO re-arm: the zero-touch guided path (no declaration UI) launches
    // the camera by itself, then scores the clip without further taps.
    armTryAgain({
      source: 'camera',
      declaredStroke: null,
      declaredCanonical: null,
      auto: true,
      sessionId: null,
    });
    mockRoute.params = { source: 'camera' };
  } else {
    mockRoute.params = { source: 'library' };
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  await advance(200);
  return renderer;
}

async function unmount(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.unmount();
  });
}

/** The visible recovery contract for an error phase. */
function expectRecoverableError(
  renderer: ReactTestRenderer,
  scenario: string,
): void {
  const text = textOf(renderer);
  check(hasAlert(renderer), `${scenario}: no accessibilityRole="alert" region`);
  check(
    text.includes('Nothing was rated.'),
    `${scenario}: error state lacks the "Nothing was rated." statement`,
  );
  check(
    findByLabel(renderer, 'Try again') !== undefined,
    `${scenario}: no visible "Try again" control`,
  );
  check(
    findByLabel(renderer, 'Close') !== undefined,
    `${scenario}: no visible "Close" control`,
  );
  check(
    !mockNavigation.replace.mock.calls.some(call => call[0] === 'Result'),
    `${scenario}: navigated to Result — fake success`,
  );
}

/** The honest still-working contract after 60s of fake time. */
function expectStillWorkingWithExit(
  renderer: ReactTestRenderer,
  scenario: string,
): void {
  const text = textOf(renderer);
  check(
    !text.includes('Nothing was rated.'),
    `${scenario}: an error was shown for an operation that is still pending`,
  );
  check(
    !mockNavigation.replace.mock.calls.some(call => call[0] === 'Result'),
    `${scenario}: navigated to Result while the operation never settled`,
  );
  check(
    findByLabel(renderer, 'Close') !== undefined,
    `${scenario}: no visible Close/back control while the operation is pending`,
  );
}

async function pressClose(
  renderer: ReactTestRenderer,
  scenario: string,
): Promise<void> {
  const close = findByLabel(renderer, 'Close');
  check(close !== undefined, `${scenario}: Close control missing`);
  await act(async () => {
    close!.props.onPress();
  });
  await flush();
  check(
    mockNavigation.goBack.mock.calls.length > 0,
    `${scenario}: Close did not navigate back`,
  );
}

async function pressTryAgain(
  renderer: ReactTestRenderer,
  scenario: string,
): Promise<void> {
  const tryAgain = findByLabel(renderer, 'Try again');
  check(tryAgain !== undefined, `${scenario}: Try again control missing`);
  await act(async () => {
    tryAgain!.props.onPress();
  });
  await flush();
}

function resetFakes(): void {
  bridge.capture.mockReset();
  bridge.importVideo.mockReset();
  bridge.cancel.mockReset();
  runMock.mockReset();
  saveMock.mockReset();
  saveMock.mockImplementation(() => Promise.resolve());
  seedMock.mockReset();
  seedMock.mockImplementation(() => Promise.resolve());
  mockNavigation.replace.mockClear();
  mockNavigation.goBack.mockClear();
  mockNavigation.navigate.mockClear();
  mockNavigation.popToTop.mockClear();
  consumeTryAgainHandoff();
}

function nativeMethod(source: Source): jest.Mock {
  return source === 'camera' ? bridge.capture : bridge.importVideo;
}

function validClipFor(source: Source, id: string): unknown {
  return source === 'camera' ? guidedClip(id) : importedClip(id);
}

function delayed<T>(ms: number, value: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(value());
      } catch (error) {
        reject(error);
      }
    }, ms);
  });
}

async function runCampaign(
  name: string,
  campaignIndex: number,
  body: (rng: Rng, seed: number, label: (s: string) => void) => Promise<string>,
): Promise<Row[]> {
  const rows: Row[] = [];
  const count = REPLAY_SINGLE_SEED ? 1 : STRESS_ITER;
  for (let i = 0; i < count; i += 1) {
    const seed = REPLAY_SINGLE_SEED
      ? STRESS_SEED
      : iterationSeed(campaignIndex, i);
    let scenario = '';
    resetFakes();
    try {
      const detail = await body(new Rng(seed), seed, s => {
        scenario = s;
      });
      rows.push({
        campaign: name,
        iteration: i,
        seed,
        scenario,
        outcome: 'HELD',
        detail,
      });
    } catch (error) {
      rows.push({
        campaign: name,
        iteration: i,
        seed,
        scenario,
        outcome: 'BROKEN',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  results.push(...rows);
  return rows;
}

function broken(rows: Row[]): Row[] {
  return rows.filter(row => row.outcome === 'BROKEN');
}

/** After a recoverable error, a healthy retry must reach the next stage. */
async function verifyRetryRecovers(
  renderer: ReactTestRenderer,
  source: Source,
  scenario: string,
): Promise<string> {
  const method = nativeMethod(source);
  const callsBefore = method.mock.calls.length;
  method.mockImplementation(() =>
    Promise.resolve(validClipFor(source, 'retry')),
  );
  saveMock.mockImplementation(() => Promise.resolve());
  seedMock.mockImplementation(() => Promise.resolve());
  runMock.mockImplementation((request: { captureId: string }) =>
    Promise.resolve(abstainedOutcome(`analysis-${request.captureId}`)),
  );
  await pressTryAgain(renderer, scenario);
  await flush();
  check(
    method.mock.calls.length === callsBefore + 1,
    `${scenario}: Try again did not re-open the ${source} exactly once (${method.mock.calls.length - callsBefore} calls)`,
  );
  check(
    !hasAlert(renderer),
    `${scenario}: error alert persisted after a healthy retry`,
  );
  if (source === 'camera') {
    check(
      runMock.mock.calls.length === 1,
      `${scenario}: healthy retry ran analysis ${runMock.mock.calls.length} times (expected 1)`,
    );
    check(
      textOf(renderer).includes('Capture another'),
      `${scenario}: abstained outcome did not reach the analyzed state`,
    );
  } else {
    check(
      saveMock.mock.calls.length === 1,
      `${scenario}: healthy import retry saved ${saveMock.mock.calls.length} captures (expected 1)`,
    );
  }
  return 'retry recovered';
}

// ---------------------------------------------------------------------------
// Campaign 1 — native capture / import faults
// ---------------------------------------------------------------------------

type CaptureFault =
  | 'reject_error'
  | 'reject_user_cancel'
  | 'reject_non_error'
  | 'throw_sync'
  | 'malformed_receipt'
  | 'partial_receipt'
  | 'wrong_mode_receipt'
  | 'method_missing'
  | 'never_resolves'
  | 'slow_then_valid'
  | 'slow_then_malformed';

const CAPTURE_FAULTS: readonly CaptureFault[] = [
  'reject_error',
  'reject_user_cancel',
  'reject_non_error',
  'throw_sync',
  'malformed_receipt',
  'partial_receipt',
  'wrong_mode_receipt',
  'method_missing',
  'never_resolves',
  'slow_then_valid',
  'slow_then_malformed',
];

const MALFORMED_RECEIPTS: readonly unknown[] = [
  null,
  undefined,
  'file:///clip.mov',
  0,
  [],
  {},
  { captureMode: 'automatic_pose_trigger' },
];

function removeRandomField(clip: Record<string, unknown>, rng: Rng): string {
  const keys = Object.keys(clip).filter(
    key => !['posterUri', 'poseSequence', 'targetSeed'].includes(key),
  );
  const key = rng.pick(keys);
  delete clip[key];
  return key;
}

describe('stress/mod-capture — AnalyzeScreen over injected native camera faults', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    consumeTryAgainHandoff();
  });

  it('every native capture/import fault lands in a recoverable, honest state', async () => {
    const rows = await runCampaign(
      'native-capture-fault',
      11,
      async (rng, _seed, label) => {
        const source = rng.pick<Source>(['camera', 'library']);
        const fault = rng.pick(CAPTURE_FAULTS);
        const method = nativeMethod(source);
        const retry = rng.bool(0.5);
        let expectation: 'error' | 'cancel' | 'pending' | 'success' = 'error';
        let detail = '';
        let restoreMethod: (() => void) | null = null;
        let slowMs = 0;
        switch (fault) {
          case 'reject_error': {
            const message = rng.pick(NATIVE_ERRORS);
            detail = `Error(${JSON.stringify(message)})`;
            method.mockImplementation(() => Promise.reject(new Error(message)));
            break;
          }
          case 'reject_user_cancel': {
            detail = 'code=camera.cancelled';
            method.mockImplementation(() =>
              Promise.reject(
                Object.assign(new Error('Capture was canceled.'), {
                  code: 'camera.cancelled',
                }),
              ),
            );
            expectation = 'cancel';
            break;
          }
          case 'reject_non_error': {
            const value = rng.pick(NON_ERROR_REJECTIONS);
            detail = `reject(${JSON.stringify(value) ?? String(value)})`;
            method.mockImplementation(() => Promise.reject(value));
            break;
          }
          case 'throw_sync': {
            detail = 'synchronous throw';
            method.mockImplementation(() => {
              throw new Error('native bridge threw synchronously');
            });
            break;
          }
          case 'malformed_receipt': {
            const value = rng.pick(MALFORMED_RECEIPTS);
            detail = `receipt=${JSON.stringify(value) ?? String(value)}`;
            method.mockImplementation(() => Promise.resolve(value));
            break;
          }
          case 'partial_receipt': {
            const clip = validClipFor(source, 'partial') as Record<
              string,
              unknown
            >;
            const removed = removeRandomField(clip, rng);
            detail = `receipt missing ${removed}`;
            method.mockImplementation(() => Promise.resolve(clip));
            break;
          }
          case 'wrong_mode_receipt': {
            const other: Source = source === 'camera' ? 'library' : 'camera';
            detail = `receipt of mode ${other}`;
            method.mockImplementation(() =>
              Promise.resolve(validClipFor(other, 'wrong-mode')),
            );
            break;
          }
          case 'method_missing': {
            detail = 'bridge method deleted';
            const key = source === 'camera' ? 'capture' : 'importVideo';
            const saved = bridge[key];
            delete (bridge as Record<string, unknown>)[key];
            restoreMethod = () => {
              bridge[key] = saved;
            };
            break;
          }
          case 'never_resolves': {
            detail = 'never resolves (60s)';
            method.mockImplementation(() => new Promise(() => {}));
            expectation = 'pending';
            break;
          }
          case 'slow_then_valid': {
            slowMs = 1000 + rng.int(45_000);
            detail = `valid after ${slowMs}ms`;
            method.mockImplementation(() =>
              delayed(slowMs, () => validClipFor(source, 'slow')),
            );
            expectation = 'success';
            break;
          }
          case 'slow_then_malformed': {
            slowMs = 1000 + rng.int(45_000);
            const clip = validClipFor(source, 'slow-bad') as Record<
              string,
              unknown
            >;
            const removed = removeRandomField(clip, rng);
            detail = `receipt missing ${removed} after ${slowMs}ms`;
            method.mockImplementation(() => delayed(slowMs, () => clip));
            break;
          }
        }
        const scenario = `${source}/${fault}: ${detail}`;
        label(scenario);
        runMock.mockImplementation((request: { captureId: string }) =>
          Promise.resolve(abstainedOutcome(`analysis-${request.captureId}`)),
        );
        const renderer = await mountScreen(source);
        try {
          if (restoreMethod === null) {
            check(
              method.mock.calls.length === 1,
              `${scenario}: native method called ${method.mock.calls.length} times (expected 1)`,
            );
          }
          if (slowMs > 0) {
            // Nothing may be decided before the native layer answers (the
            // mount already spent ~40ms of fake time after run() started).
            await advance(slowMs - 50);
            check(
              !hasAlert(renderer) && saveMock.mock.calls.length === 0,
              `${scenario}: decided before the slow native result arrived`,
            );
            await advance(100);
          }
          switch (expectation) {
            case 'error': {
              expectRecoverableError(renderer, scenario);
              check(
                saveMock.mock.calls.length === 0,
                `${scenario}: a failed capture was persisted`,
              );
              check(
                runMock.mock.calls.length === 0,
                `${scenario}: analysis ran on a failed capture`,
              );
              if (fault === 'reject_non_error') {
                const text = textOf(renderer);
                check(
                  !/"(undefined|null|\[object Object\])"/.test(text),
                  `${scenario}: raw non-Error rejection rendered as user copy`,
                );
              }
              restoreMethod?.();
              restoreMethod = null;
              if (retry)
                return await verifyRetryRecovers(renderer, source, scenario);
              return 'error → Try again + Close visible, nothing persisted or analyzed';
            }
            case 'cancel': {
              check(
                !hasAlert(renderer),
                `${scenario}: user cancel surfaced as an error`,
              );
              check(
                saveMock.mock.calls.length === 0 &&
                  runMock.mock.calls.length === 0,
                `${scenario}: cancel persisted or analyzed something`,
              );
              if (source === 'library') {
                check(
                  mockNavigation.goBack.mock.calls.length === 1,
                  `${scenario}: cancelled import did not go back exactly once`,
                );
                return 'cancel → goBack, no error surface';
              }
              check(
                findByLabel(renderer, 'Open automatic camera') !== undefined,
                `${scenario}: cancelled capture did not return to the ready landing`,
              );
              return 'cancel → ready landing with "Open automatic camera"';
            }
            case 'pending': {
              await advance(60_000);
              expectStillWorkingWithExit(renderer, scenario);
              check(
                saveMock.mock.calls.length === 0 &&
                  runMock.mock.calls.length === 0,
                `${scenario}: work proceeded without a clip`,
              );
              await pressClose(renderer, scenario);
              check(
                bridge.cancel.mock.calls.length >= 1,
                `${scenario}: Close did not cancel the native operation`,
              );
              return '60s pending → Close visible, cancels native, goes back';
            }
            case 'success': {
              check(
                saveMock.mock.calls.length === 1,
                `${scenario}: valid slow clip saved ${saveMock.mock.calls.length} times`,
              );
              if (source === 'camera') {
                check(
                  runMock.mock.calls.length === 1,
                  `${scenario}: analysis ran ${runMock.mock.calls.length} times`,
                );
              }
              check(
                !hasAlert(renderer),
                `${scenario}: valid slow clip shown as error`,
              );
              return `slow valid clip after ${slowMs}ms → saved once`;
            }
          }
          throw new Error(`unreachable expectation ${String(expectation)}`);
        } finally {
          restoreMethod?.();
          await unmount(renderer);
        }
      },
    );
    expect(broken(rows)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Campaign 2 — SQLite faults after a successful capture
// ---------------------------------------------------------------------------

type PersistFault =
  | 'save_reject'
  | 'save_throw'
  | 'save_never'
  | 'save_slow'
  | 'seed_reject'
  | 'seed_throw';

const PERSIST_FAULTS: readonly PersistFault[] = [
  'save_reject',
  'save_throw',
  'save_never',
  'save_slow',
  'seed_reject',
  'seed_throw',
];

describe('stress/mod-capture — AnalyzeScreen over injected SQLite faults after capture', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    consumeTryAgainHandoff();
  });

  it('a persistence fault never becomes a rated analysis and always leaves a way out', async () => {
    const rows = await runCampaign(
      'sqlite-fault-after-capture',
      12,
      async (rng, _seed, label) => {
        const fault = rng.pick(PERSIST_FAULTS);
        const message = rng.pick(SQLITE_ERRORS);
        const retry = rng.bool(0.5);
        let slowMs = 0;
        switch (fault) {
          case 'save_reject':
            saveMock.mockImplementation(() =>
              Promise.reject(new Error(message)),
            );
            break;
          case 'save_throw':
            saveMock.mockImplementation(() => {
              throw new Error(message);
            });
            break;
          case 'save_never':
            saveMock.mockImplementation(() => new Promise(() => {}));
            break;
          case 'save_slow':
            slowMs = 500 + rng.int(20_000);
            saveMock.mockImplementation(() => delayed(slowMs, () => undefined));
            break;
          case 'seed_reject':
            seedMock.mockImplementation(() =>
              Promise.reject(new Error(message)),
            );
            break;
          case 'seed_throw':
            seedMock.mockImplementation(() => {
              throw new Error(message);
            });
            break;
        }
        const scenario = `camera/${fault}: ${message}${slowMs ? ` after ${slowMs}ms` : ''}`;
        label(scenario);
        bridge.capture.mockImplementation(() =>
          Promise.resolve(guidedClip('ok')),
        );
        runMock.mockImplementation((request: { captureId: string }) =>
          Promise.resolve(abstainedOutcome(`analysis-${request.captureId}`)),
        );
        const renderer = await mountScreen('camera');
        try {
          check(
            bridge.capture.mock.calls.length === 1,
            `${scenario}: camera opened ${bridge.capture.mock.calls.length} times`,
          );
          if (fault === 'save_never') {
            await advance(60_000);
            expectStillWorkingWithExit(renderer, scenario);
            check(
              runMock.mock.calls.length === 0,
              `${scenario}: analysis ran before the capture row existed`,
            );
            await pressClose(renderer, scenario);
            return '60s pending persistence → Close visible, no analysis';
          }
          if (fault === 'save_slow') {
            await advance(slowMs - 50);
            check(
              runMock.mock.calls.length === 0,
              `${scenario}: analysis ran before the slow save settled`,
            );
            await advance(100);
            check(
              runMock.mock.calls.length === 1,
              `${scenario}: analysis ran ${runMock.mock.calls.length} times after the slow save`,
            );
            check(
              !hasAlert(renderer),
              `${scenario}: slow save rendered as error`,
            );
            return `save settled after ${slowMs}ms → analysis ran once`;
          }
          expectRecoverableError(renderer, scenario);
          check(
            textOf(renderer).includes(message),
            `${scenario}: the persistence failure reason is not shown`,
          );
          check(
            runMock.mock.calls.length === 0,
            `${scenario}: analysis ran despite the persistence failure`,
          );
          if (retry)
            return await verifyRetryRecovers(renderer, 'camera', scenario);
          return 'error → Try again + Close visible, no analysis';
        } finally {
          await unmount(renderer);
        }
      },
    );
    expect(broken(rows)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Campaign 3 — analysis runner faults (reject / throw / never)
// ---------------------------------------------------------------------------

type AnalysisFault = 'reject' | 'throw' | 'never' | 'unavailable';
const ANALYSIS_FAULTS: readonly AnalysisFault[] = [
  'reject',
  'throw',
  'never',
  'unavailable',
];

describe('stress/mod-capture — AnalyzeScreen over injected analysis-runner faults', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    consumeTryAgainHandoff();
  });

  it('a failed or hung analysis never navigates to Result and always shows a way out', async () => {
    const rows = await runCampaign(
      'analysis-fault',
      13,
      async (rng, _seed, label) => {
        const fault = rng.pick(ANALYSIS_FAULTS);
        const message = rng.pick([
          'The server took too long to respond. Your work is saved on this device — try again when the connection recovers.',
          'Network request failed',
          'database is locked',
          'Analysis unavailable right now.',
        ]);
        const retry = rng.bool(0.5);
        switch (fault) {
          case 'reject':
            runMock.mockImplementation(() =>
              Promise.reject(new Error(message)),
            );
            break;
          case 'throw':
            runMock.mockImplementation(() => {
              throw new Error(message);
            });
            break;
          case 'never':
            runMock.mockImplementation(() => new Promise(() => {}));
            break;
          case 'unavailable':
            runMock.mockImplementation(() =>
              Promise.resolve({ kind: 'unavailable', reason: message }),
            );
            break;
        }
        const scenario = `camera/analysis_${fault}: ${message.slice(0, 40)}`;
        label(scenario);
        bridge.capture.mockImplementation(() =>
          Promise.resolve(guidedClip('ok')),
        );
        const renderer = await mountScreen('camera');
        try {
          check(
            runMock.mock.calls.length === 1,
            `${scenario}: analysis ran ${runMock.mock.calls.length} times`,
          );
          if (fault === 'never') {
            await advance(60_000);
            expectStillWorkingWithExit(renderer, scenario);
            await pressClose(renderer, scenario);
            return '60s pending analysis → Close visible, no Result';
          }
          expectRecoverableError(renderer, scenario);
          check(
            textOf(renderer).includes(message.slice(0, 40)),
            `${scenario}: failure reason not shown`,
          );
          if (retry) {
            // TRY AGAIN after analysis failure re-arms the camera (same intent).
            const before = bridge.capture.mock.calls.length;
            runMock.mockImplementation((request: { captureId: string }) =>
              Promise.resolve(
                abstainedOutcome(`analysis-${request.captureId}`),
              ),
            );
            await pressTryAgain(renderer, scenario);
            check(
              bridge.capture.mock.calls.length === before + 1,
              `${scenario}: Try again did not re-open the camera exactly once`,
            );
            check(
              runMock.mock.calls.length === 2,
              `${scenario}: retry ran analysis ${runMock.mock.calls.length - 1} times`,
            );
            check(
              !hasAlert(renderer),
              `${scenario}: alert persisted after healthy retry`,
            );
            return 'error → retry recovered';
          }
          return 'error → Try again + Close visible, no Result';
        } finally {
          await unmount(renderer);
        }
      },
    );
    expect(broken(rows)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Campaign 4 — malformed native events delivered through the REAL emitter
// ---------------------------------------------------------------------------

const EVENT_NAME = 'PickleCameraEvent';

const COVERAGE_POISONS: readonly unknown[] = [
  0.91,
  0.4,
  0,
  null,
  undefined,
  Number.NaN,
  '0.9',
  '30',
  true,
  false,
  {},
  [],
  Number.POSITIVE_INFINITY,
  -1,
  2,
];

const NUMERIC_POISONS: readonly unknown[] = [
  720,
  59.94,
  128,
  0,
  null,
  undefined,
  Number.NaN,
  '720',
  '59.94',
  '',
  true,
  {},
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -5,
];

function validReadiness(): Record<string, unknown> {
  return {
    type: 'readiness',
    state: 'ready',
    poseConfidence: 0.9,
    jointCoverage: 0.91,
    stableForMs: 900,
    missingJoints: [],
    source: 'apple_vision_body_pose',
    modelVersion: 'apple-vision-bodypose-1',
    emittedAtIso: '2026-09-05T00:00:01.000Z',
  };
}

function validQuality(): Record<string, unknown> {
  return {
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
    emittedAtIso: '2026-09-05T00:00:01.500Z',
  };
}

type EventFault =
  | 'valid_readiness'
  | 'valid_quality'
  | 'readiness_coverage_poison'
  | 'readiness_unknown_state'
  | 'readiness_missing_fields'
  | 'quality_signal_poison'
  | 'quality_signals_missing'
  | 'quality_signals_scalar'
  | 'unknown_type'
  | 'missing_type'
  | 'non_object_payload';

const EVENT_FAULTS: readonly EventFault[] = [
  'valid_readiness',
  'valid_quality',
  'readiness_coverage_poison',
  'readiness_unknown_state',
  'readiness_missing_fields',
  'quality_signal_poison',
  'quality_signals_missing',
  'quality_signals_scalar',
  'unknown_type',
  'missing_type',
  'non_object_payload',
];

interface EventPlan {
  fault: EventFault;
  payload: unknown;
  describe: string;
  /** What an honest envelope may report for the dimensions this event touches. */
  expectMeasured: Partial<Record<string, 'number' | 'null'>>;
}

function planEvent(rng: Rng): EventPlan {
  const fault = rng.pick(EVENT_FAULTS);
  switch (fault) {
    case 'valid_readiness':
      return {
        fault,
        payload: validReadiness(),
        describe: 'readiness ok',
        expectMeasured: { player_visibility: 'number' },
      };
    // The ATTEMPT envelope takes resolution / frame rate / duration from the
    // validated clip, so live quality events only decide the preview proxies
    // (brightness here) in the analysis request.
    case 'valid_quality':
      return {
        fault,
        payload: validQuality(),
        describe: 'quality ok',
        expectMeasured: { brightness: 'number' },
      };
    case 'readiness_coverage_poison': {
      const poison = rng.pick(COVERAGE_POISONS);
      const payload = validReadiness();
      payload.jointCoverage = poison;
      const finite = typeof poison === 'number' && Number.isFinite(poison);
      return {
        fault,
        payload,
        describe: `readiness.jointCoverage=${JSON.stringify(poison) ?? String(poison)}`,
        expectMeasured: { player_visibility: finite ? 'number' : 'null' },
      };
    }
    case 'readiness_unknown_state': {
      const payload = validReadiness();
      payload.state = rng.pick(['', 'garbage', 'READY', 42, null]);
      return {
        fault,
        payload,
        describe: `readiness.state=${JSON.stringify(payload.state)}`,
        expectMeasured: { player_visibility: 'number' },
      };
    }
    case 'readiness_missing_fields':
      return {
        fault,
        payload: { type: 'readiness' },
        describe: 'readiness with no fields',
        expectMeasured: { player_visibility: 'null' },
      };
    case 'quality_signal_poison': {
      const field = rng.pick([
        'frameWidthPx',
        'frameHeightPx',
        'avgFrameRateFps',
        'brightnessMeanLuma',
      ] as const);
      const poison = rng.pick(NUMERIC_POISONS);
      const payload = validQuality();
      (payload.signals as Record<string, unknown>)[field] = poison;
      const finite = typeof poison === 'number' && Number.isFinite(poison);
      return {
        fault,
        payload,
        describe: `quality.${field}=${JSON.stringify(poison) ?? String(poison)}`,
        expectMeasured:
          field === 'brightnessMeanLuma'
            ? { brightness: finite ? 'number' : 'null' }
            : {},
      };
    }
    case 'quality_signals_missing':
      return {
        fault,
        payload: { type: 'capture_quality', emittedAtIso: 'x' },
        describe: 'quality without signals',
        expectMeasured: { brightness: 'null' },
      };
    case 'quality_signals_scalar':
      return {
        fault,
        payload: {
          type: 'capture_quality',
          signals: rng.pick([42, 'bad', true]),
        },
        describe: 'quality.signals scalar',
        expectMeasured: { brightness: 'null' },
      };
    case 'unknown_type':
      return {
        fault,
        payload: { type: rng.pick(['frame', 'READINESS', 'thermal', '']) },
        describe: 'unknown event type',
        expectMeasured: {},
      };
    case 'missing_type':
      return {
        fault,
        payload: { state: 'ready', jointCoverage: 0.9 },
        describe: 'event without type',
        expectMeasured: {},
      };
    case 'non_object_payload':
      return {
        fault,
        payload: rng.pick([null, undefined, 'readiness', 7, true]),
        describe: 'non-object payload',
        expectMeasured: {},
      };
  }
}

function measuredOf(envelope: EnvelopeVerdict, dimension: string): unknown {
  const found = envelope.dimensions.find(d => d.dimension === dimension);
  check(found !== undefined, `envelope lacks dimension ${dimension}`);
  return (found as { measured: unknown }).measured;
}

function statusOf(envelope: EnvelopeVerdict, dimension: string): string {
  const found = envelope.dimensions.find(d => d.dimension === dimension);
  check(found !== undefined, `envelope lacks dimension ${dimension}`);
  return found!.status;
}

describe('stress/mod-capture — AnalyzeScreen over malformed native camera events', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    consumeTryAgainHandoff();
  });

  it('malformed events never crash the screen and never stamp a measurement nobody made into the analysis request', async () => {
    const rows = await runCampaign(
      'malformed-native-events',
      14,
      async (rng, _seed, label) => {
        const plans: EventPlan[] = [];
        const count = 1 + rng.int(5);
        for (let i = 0; i < count; i += 1) plans.push(planEvent(rng));
        const scenario = plans.map(p => p.describe).join(' | ');
        label(scenario);
        let resolveCapture!: (clip: unknown) => void;
        bridge.capture.mockImplementation(
          () =>
            new Promise(resolve => {
              resolveCapture = resolve;
            }),
        );
        runMock.mockImplementation((request: { captureId: string }) =>
          Promise.resolve(abstainedOutcome(`analysis-${request.captureId}`)),
        );
        const renderer = await mountScreen('camera');
        try {
          for (const plan of plans) {
            let emitError: unknown = null;
            await act(async () => {
              try {
                DeviceEventEmitter.emit(EVENT_NAME, plan.payload);
              } catch (error) {
                emitError = error;
              }
            });
            check(
              emitError === null,
              `${plan.describe}: the screen's event listener threw ${String(emitError)} (native emit would crash the JS thread)`,
            );
            check(
              !hasAlert(renderer),
              `${plan.describe}: a live event produced an error surface`,
            );
          }
          await act(async () => {
            resolveCapture(guidedClip('events'));
          });
          await flush();
          check(
            runMock.mock.calls.length === 1,
            `analysis ran ${runMock.mock.calls.length} times after the live window`,
          );
          const request = runMock.mock.calls[0]![0] as {
            captureEnvelope: EnvelopeVerdict | null;
          };
          const envelope = request.captureEnvelope;
          check(
            envelope !== null,
            'guided clip reached analysis without an envelope',
          );
          // Later events overwrite earlier ones for the same dimension, so the
          // last plan touching a dimension decides what is honest for it.
          const expected: Record<string, 'number' | 'null'> = {};
          for (const plan of plans)
            Object.assign(expected, plan.expectMeasured);
          for (const [dimension, kind] of Object.entries(expected)) {
            const measured = measuredOf(envelope!, dimension);
            const status = statusOf(envelope!, dimension);
            if (kind === 'number') {
              check(
                typeof measured === 'number' && Number.isFinite(measured),
                `${dimension}: measured=${String(measured)} (${typeof measured}) after a valid event`,
              );
            } else {
              check(
                measured === null && status === 'NOT_MEASURED',
                `${dimension}: measured=${JSON.stringify(measured) ?? String(measured)} status=${status} — an unmeasurable native value was stamped into the analysis request (and would be persisted with the analysis record)`,
              );
            }
          }
          // Whatever native sent, every persisted measurement must be a finite number or null.
          for (const d of envelope!.dimensions) {
            const measured = (d as { measured: unknown }).measured;
            check(
              measured === null ||
                (typeof measured === 'number' && Number.isFinite(measured)),
              `${d.dimension}: non-numeric measured=${JSON.stringify(measured) ?? String(measured)} would be JSON-persisted in local_analysis_record`,
            );
          }
          return `${count} events → envelope honest, analysis ran once`;
        } finally {
          await unmount(renderer);
        }
      },
    );
    expect(broken(rows)).toEqual([]);
  });
});
