/**
 * Structural audit #1 (mobile-analyze-capture) — the unmount ledger re-read
 * vs a scoring run that is still in flight when the screen is left.
 *
 * AnalyzeScreen re-reads canonical access in its unmount cleanup once a run
 * touched the ledger (AnalyzeScreen.tsx:623-629). `scoreCapture()` is fired
 * with `void`, so leaving the screen mid-run performs the re-read while the
 * server still holds the run's RESERVED permit. If that run then ends
 * without a score, its permit is released — but nothing re-reads the ledger
 * again, and the store keeps the snapshot in which the last free rating
 * looked reserved (`canStartRating: false`).
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
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

let mockCaptureImpl: () => Promise<CapturedClip> = () =>
  Promise.reject(new Error('capture mock not configured'));
jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: () => mockCaptureImpl(),
    importStrokeVideo: () => Promise.reject(new Error('out of scope')),
    cancelCameraOperation: () => undefined,
    subscribeToCameraEvents: () => () => undefined,
  };
});
let mockOutcome: () => Promise<CaptureAnalysisOutcome> = () =>
  Promise.reject(new Error('outcome not configured'));
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: () => mockOutcome(),
}));

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
import type { CanonicalAccessState } from '../../src/billing/types';

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

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(() => resolve(undefined), 0));
  });
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

beforeEach(() => {
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  mockNavigation.replace.mockClear();
  clearAccessStoreConfiguration();
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('structural audit #1 — leaving AnalyzeScreen while the scoring run is in flight', () => {
  it('a run that releases its permit after the screen is gone does not leave the ledger snapshot on the reserved read', async () => {
    // Player has ONE free rating left. While the run holds its permit the
    // server reports it reserved (nothing available); once the run fails
    // and releases, the rating is available again.
    let permitHeld = true;
    const backend = {
      getAccess: jest.fn(async () =>
        permitHeld ? freeAccess(1, 1) : freeAccess(1, 0),
      ),
      syncBilling: jest.fn(),
    };
    configureAccessStore({
      store: {
        configure: jest.fn(async () => undefined),
        loadPlans: jest.fn(async () => {
          throw new Error('plans are not part of this test');
        }),
        purchase: jest.fn(),
        restore: jest.fn(),
        readEntitlement: jest.fn(),
      },
      backend,
    });
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: freeAccess(1),
    });
    expect(useAccessStore.getState().canonicalAccess?.canStartRating).toBe(
      true,
    );

    let settleRun!: (outcome: CaptureAnalysisOutcome) => void;
    mockOutcome = () =>
      new Promise<CaptureAnalysisOutcome>(resolve => {
        settleRun = resolve;
      });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<AnalyzeScreen />);
    });
    pressByLabel(renderer, 'Forehand Drive');
    mockCaptureImpl = async () => guidedClip();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    expect(backend.getAccess).not.toHaveBeenCalled();

    // The player leaves the screen while runCaptureAnalysis is still in
    // flight (permit reserved on the server). The re-read must NOT race the
    // reservation: no GET /v1/me/access until the run settles, so the store
    // never captures the transient "reserved" ledger.
    await act(async () => renderer.unmount());
    await flush();
    expect(backend.getAccess).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(1));

    // The abandoned run now ends without a score; its permit is released.
    permitHeld = false;
    await act(async () => {
      settleRun({ kind: 'unavailable', reason: 'The read did not complete.' });
    });
    await flush();
    await flush();

    // Expected: exactly one deferred re-read, and the ledger the rest of the
    // app reads reflects the release.
    expect(backend.getAccess).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess?.canStartRating).toBe(
      true,
    );
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(1, 0));
  });
});
