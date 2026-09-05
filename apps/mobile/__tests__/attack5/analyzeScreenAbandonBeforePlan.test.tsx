/**
 * MAC-03 contract (AnalyzeScreen.tsx `ratingLedgerTouched` /
 * `ledgerRunSettled`, AGENTS.md "Free-rating ledger freshness"): a scoring
 * run that is still in flight when the player leaves the screen re-reads the
 * canonical access snapshot once the run settles, so the ledger the rest of
 * the app reads reflects the consumed/released permit.
 *
 * Ordering variant pinned here: the player leaves DURING the practice-set
 * planning read that sits between the clip save and the rating run. The run
 * must then NOT start at all — no permit is reserved, no rating is spent for
 * a screen nobody is looking at, and no access re-read is needed.
 *
 * Harness: typed capture seam + runCaptureAnalysis mocked (as in
 * attack4AnalyzeScreenLifecycle); access store and practice-set planner REAL;
 * SQLite simulated with a gate on the practice-set kv read.
 */
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../../src/data/syncRuntime', () => ({
  triggerOutboxSync: jest.fn(),
}));
jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: jest.fn(),
    importStrokeVideo: jest.fn(),
    cancelCameraOperation: jest.fn(),
    importedPoseExtractionAvailable: jest.fn(() => true),
    extractImportedPoseSequence: jest.fn(),
    subscribeToCameraEvents: () => () => undefined,
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
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { source: 'camera' } }),
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
import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import {
  captureStrokeVideo,
  type CapturedClip,
} from '../../src/camera/capture';
import {
  runCaptureAnalysis,
  type CaptureAnalysisOutcome,
} from '../../src/analysis/runCaptureAnalysis';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
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
import { practiceSetKeyForOwner } from '../../src/analysis/practiceSet';

const owner = '66666666-6666-4666-8666-666666666666';

// ─── Simulated SQLite with a gate on the practice-set planning read ─────────

let releasePlanRead: (() => void) | null = null;
let planReadStarted: Promise<void> = Promise.resolve();
let gatePlanRead = false;

const recordingDb: LocalDb = {
  async execute(sql: string, params: unknown[] = []) {
    if (
      gatePlanRead &&
      sql.startsWith('SELECT value FROM kv') &&
      params[0] === practiceSetKeyForOwner(owner)
    ) {
      gatePlanRead = false;
      await new Promise<void>(resolve => {
        releasePlanRead = resolve;
      });
    }
    return { rows: [] };
  },
  close() {},
};
function mockCurrentDb(): LocalDb {
  return recordingDb;
}

function armPlanReadGate() {
  gatePlanRead = true;
  releasePlanRead = null;
  planReadStarted = new Promise<void>(resolve => {
    const poll = () => {
      if (releasePlanRead) resolve();
      else setImmediate(poll);
    };
    poll();
  });
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function guidedClip(): CapturedClip {
  return {
    uri: 'file:///captures/guided.mov',
    durationMs: 4200,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-04T12:00:00.000Z',
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
      analysisInputFrameCount: 120,
      poseFrameCount: 120,
      poseMissingFrameCount: 0,
      trackedDurationMs: 4200,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: 120,
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
      frameCount: 120,
      sha256: 'cd'.repeat(32),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

function scoredOutcome(freeLimitReached: boolean): CaptureAnalysisOutcome {
  return {
    kind: 'scored',
    analysisId: 'analysis-fix2-1',
    record: {} as Extract<CaptureAnalysisOutcome, { kind: 'scored' }>['record'],
    freeLimitReached,
  };
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

// ─── Driving helpers ─────────────────────────────────────────────────────────

function pressByLabel(renderer: ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
  act(() => node.props.onPress());
}

function pressButton(renderer: ReactTestRenderer, label: string) {
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

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(() => resolve(undefined), 0));
  });
  await act(async () => {});
}

function deferredRun(): {
  resolve: (value: CaptureAnalysisOutcome) => Promise<void>;
} {
  let resolveFn!: (value: CaptureAnalysisOutcome) => void;
  (runCaptureAnalysis as jest.Mock).mockImplementation(
    () =>
      new Promise<CaptureAnalysisOutcome>(resolve => {
        resolveFn = resolve;
      }),
  );
  return {
    resolve: async value => {
      await act(async () => {
        resolveFn(value);
      });
      await flush();
    },
  };
}

let clients: BillingAccessDependencies;

beforeEach(() => {
  jest.clearAllMocks();
  gatePlanRead = false;
  releasePlanRead = null;
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-fix2',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  clearAccessStoreConfiguration();
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('A2 — leaving AnalyzeScreen during the practice-set planning read (before the permit is reserved)', () => {
  it('the run is not started after the screen is gone: no permit reserved, no rating spent, no access re-read needed', async () => {
    // Player has ONE free rating left; the server would consume it if the
    // abandoned run scored.
    let serverLedger: 'idle' | 'reserved' | 'consumed' = 'idle';
    clients = backendReturning(async () =>
      serverLedger === 'consumed' ? freeAccess(2, 0) : freeAccess(1, 0),
    );
    configureAccessStore(clients);
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: freeAccess(1),
    });

    (runCaptureAnalysis as jest.Mock).mockImplementation(() => {
      serverLedger = 'reserved';
      return new Promise<CaptureAnalysisOutcome>(() => undefined);
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<AnalyzeScreen />);
    });
    pressByLabel(renderer, 'Forehand Drive');
    (captureStrokeVideo as jest.Mock).mockResolvedValue(guidedClip());
    armPlanReadGate();
    pressButton(renderer, 'Open automatic camera');
    // The clip is saved; scoreCapture is now parked inside planPracticeSet's
    // kv read.
    await act(async () => {
      await planReadStarted;
    });
    expect(runCaptureAnalysis).not.toHaveBeenCalled();

    // The player leaves (tab switch / back) while the planner read is
    // pending. The unmount cleanup runs NOW, with the ledger untouched.
    await act(async () => renderer.unmount());
    await flush();
    expect(clients.backend.getAccess).not.toHaveBeenCalled();

    // The planner read completes; scoreCapture observes the abandonment and
    // never reaches the server.
    await act(async () => {
      releasePlanRead!();
    });
    await flush();
    await flush();
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
    expect(serverLedger).toBe('idle');
    expect(clients.backend.getAccess).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(1));
    expect(useAccessStore.getState().canonicalAccess?.canStartRating).toBe(
      true,
    );
  });

  it('control: leaving one tick later — after runCaptureAnalysis was invoked — schedules exactly one deferred re-read that observes the consumed ledger', async () => {
    let serverLedger: 'reserved' | 'consumed' = 'reserved';
    clients = backendReturning(async () =>
      serverLedger === 'consumed' ? freeAccess(2, 0) : freeAccess(1, 1),
    );
    configureAccessStore(clients);
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: freeAccess(1),
    });
    const analysis = deferredRun();

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<AnalyzeScreen />);
    });
    pressByLabel(renderer, 'Forehand Drive');
    (captureStrokeVideo as jest.Mock).mockResolvedValue(guidedClip());
    pressButton(renderer, 'Open automatic camera');
    await flush();
    await flush();
    expect(runCaptureAnalysis).toHaveBeenCalledTimes(1);

    await act(async () => renderer.unmount());
    await flush();
    expect(clients.backend.getAccess).not.toHaveBeenCalled();

    serverLedger = 'consumed';
    await analysis.resolve(scoredOutcome(true));
    await flush();
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(2, 0));
  });

  it('control: the working-screen Close during the run + a run that REJECTS → one deferred re-read, no routing', async () => {
    let serverLedger: 'reserved' | 'released' = 'reserved';
    clients = backendReturning(async () =>
      serverLedger === 'released' ? freeAccess(1, 0) : freeAccess(1, 1),
    );
    configureAccessStore(clients);
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: freeAccess(1),
    });
    let rejectRun!: (error: Error) => void;
    (runCaptureAnalysis as jest.Mock).mockImplementation(
      () =>
        new Promise<CaptureAnalysisOutcome>((_resolve, reject) => {
          rejectRun = reject;
        }),
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<AnalyzeScreen />);
    });
    pressByLabel(renderer, 'Forehand Drive');
    (captureStrokeVideo as jest.Mock).mockResolvedValue(guidedClip());
    pressButton(renderer, 'Open automatic camera');
    await flush();
    await flush();
    expect(runCaptureAnalysis).toHaveBeenCalledTimes(1);

    // The X on the working screen: abandoned + goBack, then the host
    // navigator unmounts the screen.
    pressByLabel(renderer, 'Close');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
    await flush();
    expect(clients.backend.getAccess).not.toHaveBeenCalled();

    serverLedger = 'released';
    await act(async () => {
      rejectRun(new Error('inference exploded after the permit was released'));
    });
    await flush();
    await flush();
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(1, 0));
    expect(mockNavigation.replace).not.toHaveBeenCalled();
  });
});
