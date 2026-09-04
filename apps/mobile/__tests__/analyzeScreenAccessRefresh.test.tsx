import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { CapturedClip } from '../src/camera/capture';
import type { CaptureAnalysisOutcome } from '../src/analysis/runCaptureAnalysis';

/**
 * A scoring run reserves a permit that is then consumed (scored) or released,
 * so the access snapshot the rest of the app reads — Settings membership row,
 * tab-bar rating gate, Paywall allowance — goes stale the moment a run starts.
 * AnalyzeScreen re-reads it from the server once the screen unmounts, and
 * ONLY then: the route gate replaces a mounted screen whose canStartRating
 * flips false, which would tear down the "last free analysis" prompt before
 * the player could open their saved score.
 */

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

let mockCaptureImpl: () => Promise<CapturedClip> = () =>
  Promise.reject(new Error('capture mock not configured'));
jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: () => mockCaptureImpl(),
    importStrokeVideo: () => Promise.reject(new Error('out of scope')),
    cancelCameraOperation: () => undefined,
    subscribeToCameraEvents: () => () => undefined,
  };
});

// The analysis pipeline itself is exercised by analyzeScreenFullFlowE2E; here
// it is replaced so each test dictates the outcome that reaches the screen.
let mockOutcome: () => Promise<CaptureAnalysisOutcome> = () =>
  Promise.reject(new Error('outcome not configured'));
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: () => mockOutcome(),
}));

import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../src/billing/types';

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

function backendReturning(
  getAccess: () => Promise<CanonicalAccessState>,
): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => {
        throw new Error('plans are not part of this test');
      }),
      purchase: jest.fn(),
      restore: jest.fn(),
      readEntitlement: jest.fn(),
    },
    backend: { getAccess: jest.fn(getAccess), syncBilling: jest.fn() },
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

function scoredOutcome(freeLimitReached: boolean): CaptureAnalysisOutcome {
  return {
    kind: 'scored',
    analysisId: 'analysis-1',
    record: {} as CaptureAnalysisOutcome extends { record: infer R }
      ? R
      : never,
    freeLimitReached,
  };
}

function lowConfidenceOutcome(): CaptureAnalysisOutcome {
  return {
    kind: 'low_confidence',
    analysisId: 'analysis-1',
    record: {} as CaptureAnalysisOutcome extends { record: infer R }
      ? R
      : never,
    guidance: null,
  };
}

/**
 * A run whose settlement the test controls: `runCaptureAnalysis` stays
 * pending until `settle()` resolves it, mirroring a permit that is still
 * reserved (server-side) while the network round trip is in flight.
 */
function deferredRun(): {
  started: () => boolean;
  settle: (outcome: CaptureAnalysisOutcome) => Promise<void>;
} {
  let resolve!: (outcome: CaptureAnalysisOutcome) => void;
  const pending = new Promise<CaptureAnalysisOutcome>(r => {
    resolve = r;
  });
  let started = false;
  mockOutcome = () => {
    started = true;
    return pending;
  };
  return {
    started: () => started,
    async settle(outcome) {
      await act(async () => {
        resolve(outcome);
      });
      await flush();
    },
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

/** Declares a stroke and runs one zero-touch capture through to the
 * screen's routing of the mocked outcome. */
async function runOneAnalysis(renderer: TestRenderer.ReactTestRenderer) {
  pressByLabel(renderer, 'Forehand Drive');
  mockCaptureImpl = async () => guidedClip();
  pressButton(renderer, 'Open automatic camera');
  await flush();
}

let clients: BillingAccessDependencies;

beforeEach(() => {
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  mockNavigation.replace.mockClear();
  mockNavigation.navigate.mockClear();
  clearAccessStoreConfiguration();
  // The snapshot the gate admitted this visit on: two ratings untouched.
  // The server, by the time the screen is left, says otherwise.
  clients = backendReturning(async () => freeAccess(1, 1));
  configureAccessStore(clients);
  useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess(0) });
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('AnalyzeScreen access re-read', () => {
  it('re-reads the ledger only after a scored run leaves the screen', async () => {
    mockOutcome = async () => scoredOutcome(false);
    const renderer = await renderScreen();
    await runOneAnalysis(renderer);
    await waitFor(
      () => mockNavigation.replace.mock.calls.length > 0,
      'Result navigation',
    );
    expect(mockNavigation.replace.mock.calls[0]![0]).toBe('Result');

    // Still mounted (the navigator swaps screens after this) — nothing has
    // been asked of the server, so the gate has no reason to fire.
    expect(clients.backend.getAccess).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(0));

    await act(async () => renderer.unmount());
    await flush();
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(1, 1));
  });

  it('lets the last-free-analysis prompt finish before the ledger moves', async () => {
    mockOutcome = async () => scoredOutcome(true);
    const renderer = await renderScreen();
    await runOneAnalysis(renderer);
    await waitFor(
      () =>
        JSON.stringify(renderer.toJSON()).includes(
          'That was your last free analysis.',
        ),
      'free-limit prompt',
    );
    // The prompt is up on the still-mounted screen; a refresh here would
    // flip canStartRating and let the route gate replace the screen.
    expect(clients.backend.getAccess).not.toHaveBeenCalled();

    pressButton(renderer, 'See my score');
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'analysis-1',
    });

    await act(async () => renderer.unmount());
    await flush();
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess?.canStartRating).toBe(
      false,
    );
  });

  it('does not touch the server when the visit never started a run', async () => {
    const renderer = await renderScreen();
    await act(async () => renderer.unmount());
    await flush();
    expect(clients.backend.getAccess).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(0));
  });

  it('stays quiet on a store that was reset (signed out) before unmount', async () => {
    mockOutcome = async () => scoredOutcome(false);
    const renderer = await renderScreen();
    await runOneAnalysis(renderer);
    await waitFor(
      () => mockNavigation.replace.mock.calls.length > 0,
      'Result navigation',
    );
    clearAccessStoreConfiguration();
    await act(async () => renderer.unmount());
    await flush();
    expect(clients.backend.getAccess).not.toHaveBeenCalled();
    expect(useAccessStore.getState().status).toBe('idle');
  });
});

/**
 * The permit a run reserves is consumed or released INSIDE
 * `runCaptureAnalysis`; a re-read issued while that call is still in flight
 * observes the reserved ledger, not the settled one. Leaving the screen
 * mid-run (back gesture, tab switch, backgrounding that unmounts) must
 * therefore defer the re-read until the run settles — and a re-read that
 * fails must not throw away the snapshot the visit was admitted on.
 */
describe('AnalyzeScreen access re-read for a run abandoned mid-flight', () => {
  /** Server-side permit ledger: reserved while the run is in flight. */
  let permit: 'reserved' | 'released';

  beforeEach(() => {
    permit = 'reserved';
    // The last free rating is the one this run reserves.
    clearAccessStoreConfiguration();
    clients = backendReturning(async () =>
      permit === 'reserved' ? freeAccess(1, 1) : freeAccess(1, 0),
    );
    configureAccessStore(clients);
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: freeAccess(1),
    });
  });

  it('ends on the released ledger when an abandoned run settles as low confidence', async () => {
    const run = deferredRun();
    const renderer = await renderScreen();
    await runOneAnalysis(renderer);
    await waitFor(run.started, 'runCaptureAnalysis to start');

    await act(async () => renderer.unmount());
    await flush();

    // The server releases the permit as part of the low-confidence outcome,
    // then the in-flight call returns to the (gone) screen.
    permit = 'released';
    await run.settle(lowConfidenceOutcome());

    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(1, 0));
    expect(useAccessStore.getState().canonicalAccess?.canStartRating).toBe(
      true,
    );
  });

  it('re-reads once, after the run settles, not at the moment of unmount', async () => {
    const run = deferredRun();
    const renderer = await renderScreen();
    await runOneAnalysis(renderer);
    await waitFor(run.started, 'runCaptureAnalysis to start');

    await act(async () => renderer.unmount());
    await flush();
    expect(clients.backend.getAccess).not.toHaveBeenCalled();
    // The reserve-time snapshot stays in place until the settled read lands.
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(1));

    permit = 'released';
    await run.settle(scoredOutcome(true));
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);

    // Nothing else re-fires the read for this run.
    await flush();
    await flush();
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
  });

  it('keeps the known-good snapshot when the post-run re-read fails', async () => {
    clearAccessStoreConfiguration();
    clients = backendReturning(async () => {
      throw new Error('access read failed');
    });
    configureAccessStore(clients);
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: freeAccess(1),
    });

    mockOutcome = async () => scoredOutcome(false);
    const renderer = await renderScreen();
    await runOneAnalysis(renderer);
    await waitFor(
      () => mockNavigation.replace.mock.calls.length > 0,
      'Result navigation',
    );

    await act(async () => renderer.unmount());
    await flush();
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(1));
    expect(useAccessStore.getState().canonicalAccess?.canStartRating).toBe(
      true,
    );
    // The failed read is still reported; only the snapshot is preserved.
    expect(useAccessStore.getState().status).toBe('error');
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.backend_unavailable',
    );
  });

  it('does not repopulate a store that was reset while the re-read was in flight', async () => {
    clearAccessStoreConfiguration();
    let settleRead!: () => void;
    clients = backendReturning(
      () =>
        new Promise<never>((_, reject) => {
          settleRead = () => reject(new Error('access read failed'));
        }),
    );
    configureAccessStore(clients);
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: freeAccess(1),
    });

    mockOutcome = async () => scoredOutcome(false);
    const renderer = await renderScreen();
    await runOneAnalysis(renderer);
    await waitFor(
      () => mockNavigation.replace.mock.calls.length > 0,
      'Result navigation',
    );
    await act(async () => renderer.unmount());
    await flush();
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);

    // Sign-out resets the store before the read fails.
    clearAccessStoreConfiguration();
    await act(async () => {
      settleRead();
    });
    await flush();
    expect(useAccessStore.getState().status).toBe('idle');
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
  });
});
