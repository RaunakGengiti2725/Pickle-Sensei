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
 * ADVERSARIAL (XCF-07 fix, 4476417d): the AnalyzeScreen now awaits
 * commitPracticeSetForAnalysis after a SCORED outcome and lets its throw fall
 * into the generic analysis error surface. That surface is the "Nothing was
 * rated." screen with a "Try again" button that starts a new capture.
 *
 * But by the time the commit runs, runCaptureAnalysis has ALREADY returned
 * kind:'scored': the analysis row and its shot.sync outbox row are durable
 * and the analysis permit is consumed — a rating exists. On 4d812e1a the
 * commit failure was swallowed and every scored run reached the Result
 * screen. On the candidate a session-write failure that also defeats the
 * detach (both go through inTransaction/BEGIN IMMEDIATE on the same
 * connection, so one storage fault covers both) tells the player nothing was
 * rated, offers a re-record that reserves ANOTHER permit for a stroke that is
 * already scored in their library, and skips triggerOutboxSync() for the
 * durable shot. The stroke intent surface never sees the score either.
 *
 * Expected: a scored outcome routes to Result (the rating exists) regardless
 * of set bookkeeping; the set failure is surfaced without denying the score.
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

const mockTriggerOutboxSync = jest.fn();
jest.mock('../src/data/syncRuntime', () => ({
  triggerOutboxSync: () => mockTriggerOutboxSync(),
}));

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

// The pipeline is replaced: each test dictates the (already durable) outcome
// that reaches the screen, exactly like analyzeScreenAccessRefresh does.
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

/**
 * The real practiceSet module runs against this db. The kv read that plans
 * the set sees no live set (a NEW set → saveSession path); every write that
 * opens a transaction fails like a device whose SQLite file just went
 * read-only / out of space — saveSession's 3 tries AND detachShotFromSession
 * all begin with `BEGIN IMMEDIATE`, so this single fault defeats both.
 */
const executed: string[] = [];
const brokenStorageDb: LocalDb = {
  async execute(sql) {
    executed.push(sql.replace(/\s+/g, ' ').trim());
    if (/^BEGIN/i.test(sql.trim())) {
      throw new Error('database or disk is full (code 13 SQLITE_FULL)');
    }
    return { rows: [] };
  },
  close() {},
};
function mockCurrentDb(): LocalDb {
  return brokenStorageDb;
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

function rendered(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

beforeEach(() => {
  executed.length = 0;
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  mockNavigation.replace.mockClear();
  mockNavigation.navigate.mockClear();
  mockTriggerOutboxSync.mockClear();
  clearAccessStoreConfiguration();
  configureAccessStore(backendReturning(async () => freeAccess(1, 1)));
  useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess(0) });
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('ATTACK XCF-07: scored run whose set commit throws', () => {
  it('still routes a durable scored analysis to Result and kicks the outbox', async () => {
    mockOutcome = async () => scoredOutcome();
    const renderer = await renderScreen();
    pressByLabel(renderer, 'Forehand Drive');
    mockCaptureImpl = async () => guidedClip();
    pressButton(renderer, 'Open automatic camera');
    await flush();
    await waitFor(
      () =>
        mockNavigation.replace.mock.calls.length > 0 ||
        rendered(renderer).includes('Nothing was rated.'),
      'the screen to route the scored outcome',
    );

    // Precondition of the attack: the real commit path ran and gave up —
    // saveSession was tried PRACTICE_SET_COMMIT_ATTEMPTS times and the
    // detach was attempted; all four opened a transaction on the broken db.
    expect(executed.filter(s => /^BEGIN IMMEDIATE/.test(s))).toHaveLength(4);

    // The analysis is scored and durable (runCaptureAnalysis returned
    // kind:'scored'): the player must reach their score.
    expect(rendered(renderer)).not.toContain('Nothing was rated.');
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'analysis-1',
    });
    // …and the durable shot.sync row must still be pushed toward the server.
    expect(mockTriggerOutboxSync).toHaveBeenCalled();
  });
});
