/**
 * xc-failure-injection-mobile — CAMERA UNAVAILABLE.
 *
 * Two layers, both on the REAL `src/camera/capture.ts`:
 *  1. unit: the module is loaded in an isolated registry with
 *     `NativeModules.PickleVideoCapture` absent / rejecting / returning junk /
 *     hanging / throwing synchronously, exactly what a missing or broken
 *     native bridge produces;
 *  2. screen: the real AnalyzeScreen (camera source) is mounted and its
 *     `captureStrokeVideo` seam is routed to that isolated module, so the
 *     error phase, the Try again affordance and the working-phase bound are
 *     observed on the rendered surface, not inferred.
 *
 * Native AVFoundation behaviour itself is Apple-runtime truth and is NOT
 * claimed here (see blocked_external).
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../../src/data/db';
import type { CameraEvent, CapturedClip } from '../../../src/camera/capture';
import {
  runScenario,
  seededRng,
  pick,
  verdictFor,
  type Invariants,
} from '../../../scripts/failure-injection/recorder';

type CaptureModule = typeof import('../../../src/camera/capture');

// ─── Navigation / environment seams (shape of analyzeScreenFullFlowE2E) ─────

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

const mockDbState = { openError: null as Error | null, calls: [] as string[] };
function mockCurrentDb(): LocalDb {
  if (mockDbState.openError) throw mockDbState.openError;
  return {
    async execute(sql: string) {
      mockDbState.calls.push(sql.trim().replace(/\s+/g, ' '));
      return { rows: [] };
    },
    close() {},
  };
}
jest.mock('../../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

type CameraListener = (event: CameraEvent) => void;
const mockCameraListeners = new Set<CameraListener>();
const mockCancelSpy = jest.fn();
let mockCaptureImpl: () => Promise<CapturedClip> = () =>
  Promise.reject(new Error('capture seam not routed'));

jest.mock('../../../src/camera/capture', () => {
  const actual = jest.requireActual('../../../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: () => mockCaptureImpl(),
    importStrokeVideo: () =>
      Promise.reject(new Error('library import is out of scope here')),
    cancelCameraOperation: () => mockCancelSpy(),
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
    readCaptureArtifact: () =>
      Promise.reject(new Error('no sidecar in failure scenarios')),
  };
});

import { AnalyzeScreen } from '../../../src/screens/AnalyzeScreen';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
} from '../../../src/account/apiSession';
import { consumeTryAgainHandoff } from '../../../src/screens/tryAgainHandoff';

const SUITE = 'camera';
const FILES = {
  nativeRead: 'apps/mobile/src/camera/capture.ts:462-463',
  cameraAvailable: 'apps/mobile/src/camera/capture.ts:465-470',
  captureStrokeVideo: 'apps/mobile/src/camera/capture.ts:573-580',
  assertCapturedClip: 'apps/mobile/src/camera/capture.ts:688-718',
  screenRun: 'apps/mobile/src/screens/AnalyzeScreen.tsx:976-1059',
  screenCatch: 'apps/mobile/src/screens/AnalyzeScreen.tsx:1034-1055',
  screenSave: 'apps/mobile/src/screens/AnalyzeScreen.tsx:1004-1010',
};
const owner = '22222222-2222-4222-8222-222222222222';

/** Loads the REAL capture module with the given native bridge (or none). */
function loadCaptureWith(
  bridge: Record<string, unknown> | undefined,
): CaptureModule {
  let loaded: CaptureModule | null = null;
  jest.isolateModules(() => {
    const rn =
      jest.requireActual<typeof import('react-native')>('react-native');
    const modules = rn.NativeModules as Record<string, unknown>;
    if (bridge === undefined) delete modules['PickleVideoCapture'];
    else modules['PickleVideoCapture'] = bridge;
    loaded = jest.requireActual<CaptureModule>('../../../src/camera/capture');
  });
  if (!loaded) throw new Error('capture module did not load');
  return loaded;
}

function validClip(): CapturedClip {
  return {
    uri: 'file:///captures/fi.mov',
    durationMs: 3200,
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
      analysisInputFrameCount: 192,
      poseFrameCount: 192,
      poseMissingFrameCount: 0,
      trackedDurationMs: 700,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: 192,
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
  };
}

async function unmount(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    renderer.unmount();
  });
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
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await act(async () => {
      await new Promise(resolve => setTimeout(() => resolve(undefined), 15));
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

async function openCamera(renderer: TestRenderer.ReactTestRenderer) {
  pressByLabel(renderer, 'Forehand Drive');
  pressButton(renderer, 'Open automatic camera');
  await flush();
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.useRealTimers();
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  mockDbState.openError = null;
  mockDbState.calls.length = 0;
  mockCameraListeners.clear();
  mockCancelSpy.mockClear();
  mockNavigation.replace.mockClear();
  mockNavigation.goBack.mockClear();
  consumeTryAgainHandoff();
  globalThis.fetch = jest.fn(async (url: string) => {
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});

describe('xc-failure-injection — camera unavailable', () => {
  it('CAM-01 native bridge absent: cameraAvailable()=false, captureStrokeVideo rejects with a typed message, cancel/subscribe are no-ops', async () => {
    await runScenario(
      {
        id: 'CAM-01',
        failureClass: 'camera',
        suite: SUITE,
        title: 'NativeModules.PickleVideoCapture undefined',
        seed: 31,
        inputs: { bridge: 'absent', platform: 'ios' },
        files: [
          FILES.nativeRead,
          FILES.cameraAvailable,
          FILES.captureStrokeVideo,
        ],
      },
      async () => {
        const capture = loadCaptureWith(undefined);
        expect(capture.cameraAvailable()).toBe(false);
        expect(capture.videoImportAvailable()).toBe(false);
        expect(capture.sessionCaptureAvailable()).toBe(false);
        await expect(capture.captureStrokeVideo()).rejects.toThrow(
          'Real guided camera capture is not available on this device.',
        );
        expect(() => capture.cancelCameraOperation()).not.toThrow();
        const unsubscribe = capture.subscribeToCameraEvents(() => {});
        expect(() => unsubscribe()).not.toThrow();
        const invariants: Invariants = {
          noInfiniteSpinner: 'n/a',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'Availability false; capture rejected with typed copy; cancel/subscribe safe.',
          expected: 'Honest unavailable, never a TypeError.',
        };
      },
    );
  });

  it('CAM-02 native capture() rejects (camera in use / AVFoundation error): AnalyzeScreen shows the error phase with Try again, no navigation, no stale result', async () => {
    const message =
      'The camera could not start: AVCaptureSession is in use by another app (AVErrorDeviceInUseByAnotherApplication).';
    await runScenario(
      {
        id: 'CAM-02',
        failureClass: 'camera',
        suite: SUITE,
        title: 'bridge.capture rejects with an AVFoundation-style error',
        seed: 32,
        inputs: { bridge: 'capture_rejects', message },
        files: [FILES.captureStrokeVideo, FILES.screenRun, FILES.screenCatch],
      },
      async () => {
        const capture = loadCaptureWith({
          capture: jest.fn(async () => {
            throw new Error(message);
          }),
          cancel: jest.fn(),
        });
        mockCaptureImpl = () => capture.captureStrokeVideo();
        const renderer = await renderScreen();
        await openCamera(renderer);
        await waitFor(
          () => textOf(renderer).includes('Try again'),
          'error phase',
        );
        const text = textOf(renderer);
        expect(text).toContain(message);
        expect(text).not.toContain('Opening camera');
        expect(mockNavigation.replace).not.toHaveBeenCalled();
        expect(
          mockDbState.calls.some(sql => sql.includes('local_capture')),
        ).toBe(false);
        await unmount(renderer);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'Error phase rendered with the native message and "Try again"; nothing persisted.',
          expected: 'Retryable typed error phase (stage capture).',
        };
      },
    );
  });

  it('CAM-03 native capture() resolves a malformed clip: rejected by assertCapturedClip, screen shows the invalid-result error, nothing persisted', async () => {
    await runScenario(
      {
        id: 'CAM-03',
        failureClass: 'camera',
        suite: SUITE,
        title: 'bridge.capture resolves { uri } only',
        seed: 33,
        inputs: {
          bridge: 'capture_malformed',
          payload: { uri: 'file:///captures/broken.mov' },
        },
        files: [FILES.assertCapturedClip, FILES.screenCatch],
      },
      async () => {
        const capture = loadCaptureWith({
          capture: jest.fn(async () => ({
            uri: 'file:///captures/broken.mov',
          })),
          cancel: jest.fn(),
        });
        mockCaptureImpl = () => capture.captureStrokeVideo();
        const renderer = await renderScreen();
        await openCamera(renderer);
        await waitFor(
          () => textOf(renderer).includes('Try again'),
          'error phase',
        );
        expect(textOf(renderer)).toContain(
          'The native camera returned an invalid or incomplete video result.',
        );
        expect(
          mockDbState.calls.some(sql => sql.includes('local_capture')),
        ).toBe(false);
        await unmount(renderer);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'Malformed payload never reached persistence; typed error surfaced.',
          expected: 'Invalid payloads are rejected, never repaired.',
        };
      },
    );
  });

  it('CAM-04 native capture() throws SYNCHRONOUSLY (bridge method itself faults): still lands in the error phase', async () => {
    await runScenario(
      {
        id: 'CAM-04',
        failureClass: 'camera',
        suite: SUITE,
        title: 'bridge.capture throws synchronously',
        seed: 34,
        inputs: { bridge: 'capture_throws_sync' },
        files: [FILES.captureStrokeVideo, FILES.screenCatch],
      },
      async () => {
        const capture = loadCaptureWith({
          capture: () => {
            throw new TypeError(
              'PickleVideoCapture.capture is not a function (bridge partially initialised)',
            );
          },
          cancel: jest.fn(),
        });
        mockCaptureImpl = () => capture.captureStrokeVideo();
        const renderer = await renderScreen();
        await openCamera(renderer);
        await waitFor(
          () => textOf(renderer).includes('Try again'),
          'error phase',
        );
        expect(textOf(renderer)).toContain('bridge partially initialised');
        await unmount(renderer);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'Synchronous throw became a rejection inside the async wrapper; error phase rendered.',
          expected: 'No uncaught exception out of the screen.',
        };
      },
    );
  });

  it('CAM-05 native capture() never settles: the JS layer has NO bound — AnalyzeScreen stays on "Opening camera…" for 10 minutes of fake time', async () => {
    jest.useFakeTimers();
    await runScenario(
      {
        id: 'CAM-05',
        failureClass: 'camera',
        suite: SUITE,
        title: 'bridge.capture hangs forever',
        seed: 35,
        inputs: { bridge: 'capture_hangs', fakeTimeBudgetMs: 600_000 },
        files: [FILES.captureStrokeVideo, FILES.screenRun],
      },
      async () => {
        const capture = loadCaptureWith({
          capture: () => new Promise<never>(() => {}),
          cancel: jest.fn(),
        });
        mockCaptureImpl = () => capture.captureStrokeVideo();
        const renderer = await renderScreen();
        pressByLabel(renderer, 'Forehand Drive');
        pressButton(renderer, 'Open automatic camera');
        await act(async () => {
          await jest.advanceTimersByTimeAsync(600_000);
        });
        const text = textOf(renderer);
        expect(text).toContain('Opening camera');
        expect(text).not.toContain('Try again');
        // Leaving the screen is the only exit: unmount cancels the native op.
        await unmount(renderer);
        expect(mockCancelSpy).toHaveBeenCalledTimes(1);
        const invariants: Invariants = {
          noInfiniteSpinner: 'fail',
          noSilentFailure: 'fail',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'After 600s of fake time the working surface still read "Opening camera…"; no error/retry appeared. Unmount did call cancelCameraOperation (1×).',
          expected:
            'The JS seam relies entirely on the native module settling. Whether the native module has its own start-up timeout is Apple-runtime truth (UNKNOWN from Linux).',
        };
      },
    );
  });

  it('CAM-06 [sqlite] capture succeeds but SQLite cannot open when saving the pending capture: error phase with driver text; the recorded clip is orphaned', async () => {
    const cantopen =
      '[OP-SQLITE] unable to open database file (code 14 SQLITE_CANTOPEN)';
    await runScenario(
      {
        id: 'CAM-06',
        failureClass: 'sqlite',
        suite: SUITE,
        title: 'getDb() throws after a valid clip was captured',
        seed: 36,
        inputs: { bridge: 'capture_ok', dbOpenError: cantopen },
        files: [FILES.screenSave, FILES.screenCatch],
      },
      async () => {
        const capture = loadCaptureWith({
          capture: jest.fn(async () => validClip()),
          cancel: jest.fn(),
        });
        mockCaptureImpl = () => capture.captureStrokeVideo();
        mockDbState.openError = new Error(cantopen);
        const renderer = await renderScreen();
        await openCamera(renderer);
        await waitFor(
          () => textOf(renderer).includes('Try again'),
          'error phase',
        );
        expect(textOf(renderer)).toContain(cantopen);
        expect(mockNavigation.replace).not.toHaveBeenCalled();
        await unmount(renderer);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: 'degraded',
          observed:
            'Error phase (stage capture, recovery retry) rendered the raw SQLite driver text; the clip file recorded by the native camera is not referenced anywhere.',
          expected:
            'Surfaced and retryable, but the user must re-record and reads driver text instead of product copy.',
        };
      },
    );
  });

  it('CAM-07 seeded sweep ×32: one required clip field corrupted at random — assertCapturedClip always throws invalidClip, never returns a partial clip', async () => {
    const capture = loadCaptureWith({ capture: jest.fn(), cancel: jest.fn() });
    expect(() =>
      capture.assertCapturedClip(validClip(), 'automatic_pose_trigger'),
    ).not.toThrow();
    const requiredKeys = [
      'uri',
      'durationMs',
      'fps',
      'width',
      'height',
      'capturedAtIso',
      'captureMode',
      'recognition',
    ] as const;
    const badValues: unknown[] = [
      undefined,
      null,
      'garbage',
      -1,
      {},
      Number.NaN,
    ];
    let checked = 0;
    for (let seed = 300; seed < 332; seed += 1) {
      const rng = seededRng(seed);
      const key = pick(rng, requiredKeys);
      const value = pick(rng, badValues);
      await runScenario(
        {
          id: `CAM-07/${seed}`,
          failureClass: 'camera',
          suite: SUITE,
          title: 'assertCapturedClip with one corrupted required field',
          seed,
          inputs: {
            key,
            value:
              value === undefined
                ? '<undefined>'
                : Number.isNaN(value)
                  ? 'NaN'
                  : value,
          },
          files: [FILES.assertCapturedClip],
        },
        () => {
          const clip = { ...validClip(), [key]: value } as unknown;
          expect(() =>
            capture.assertCapturedClip(clip, 'automatic_pose_trigger'),
          ).toThrow(
            'The native camera returned an invalid or incomplete video result.',
          );
          checked += 1;
          const invariants: Invariants = {
            noInfiniteSpinner: 'n/a',
            noSilentFailure: 'pass',
            noStoreCrash: 'pass',
          };
          return {
            invariants,
            verdict: verdictFor(invariants),
            observed: `${key}=${String(value)} rejected.`,
            expected: 'Rejected.',
          };
        },
      );
    }
    expect(checked).toBe(32);
  });
});
