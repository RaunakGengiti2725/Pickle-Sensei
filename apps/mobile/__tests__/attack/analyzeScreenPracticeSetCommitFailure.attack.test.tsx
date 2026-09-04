/**
 * ADVERSARIAL (attack-fix-f356fd2a, XCF-07 neighbourhood): the practice-set
 * commit that now runs AFTER a scored analysis is durable must never turn a
 * scored, permit-consuming rating into a "Nothing was rated." error.
 *
 * On 4d812e1a AnalyzeScreen ran `commitPracticeSet(...).catch(() => {})` and
 * always routed the scored run to Result. f356fd2a replaced that with an
 * awaited `commitPracticeSetForShot(...)`, whose only handled failure is the
 * session write (retried twice, then the shot is detached). Every OTHER
 * failure inside the commit — the kv activity stamp write, the detach
 * transaction itself — propagates to the run's catch block, which renders
 * the analysis error surface ("Nothing was rated." / Try again). The score
 * IS saved, the permit IS consumed and the shot IS already queued for sync,
 * so the copy is false and "Try again" spends another of the two lifetime
 * free ratings on a re-capture.
 *
 * Same harness as analyzeScreenAccessRefresh.test.tsx (pipeline mocked; the
 * db is a scripted LocalDb).
 * Run: npx jest --ci __tests__/attack/analyzeScreenPracticeSetCommitFailure.attack.test.tsx
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
import { PRACTICE_SET_KV_NAMESPACE } from '../../src/analysis/practiceSet';

const owner = '22222222-2222-4222-8222-222222222222';
const liveSetId = '66666666-6666-4666-8666-666666666666';

const recordingDb: LocalDb = {
  async execute() {
    return { rows: [] };
  },
  close() {},
};
let currentDb: LocalDb = recordingDb;
function mockCurrentDb(): LocalDb {
  return currentDb;
}

interface ScriptedDbOptions {
  /** kv record returned for the practice-set key (a live, resumable set). */
  storedSet?: string | null;
  /** How many local_session writes fail before one succeeds. */
  sessionWriteFailures?: number;
  /** How many practice-set kv stamp writes fail before one succeeds. */
  kvStampFailures?: number;
  /** How many detach UPDATE statements fail before one succeeds. */
  detachFailures?: number;
}

function scriptedDb(options: ScriptedDbOptions) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  let sessionFailures = options.sessionWriteFailures ?? 0;
  let kvFailures = options.kvStampFailures ?? 0;
  let detachFailures = options.detachFailures ?? 0;
  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      statements.push({ sql, params });
      if (
        sql.includes('SELECT value FROM kv') &&
        String(params[0]).startsWith(`${PRACTICE_SET_KV_NAMESPACE}:`)
      ) {
        return options.storedSet
          ? { rows: [{ value: options.storedSet }] }
          : { rows: [] };
      }
      if (sql.includes('INSERT OR REPLACE INTO local_session')) {
        if (sessionFailures > 0) {
          sessionFailures -= 1;
          throw new Error('database is locked');
        }
      }
      if (
        sql.includes('INSERT OR REPLACE INTO kv') &&
        String(params[0]).startsWith(`${PRACTICE_SET_KV_NAMESPACE}:`)
      ) {
        if (kvFailures > 0) {
          kvFailures -= 1;
          throw new Error('disk I/O error');
        }
      }
      if (/UPDATE local_shot\s+SET session_id = NULL/.test(sql)) {
        if (detachFailures > 0) {
          detachFailures -= 1;
          throw new Error('database is locked');
        }
      }
      return { rows: [] };
    },
    close() {},
  };
  return { db, statements };
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

async function settle(renderer: TestRenderer.ReactTestRenderer) {
  // The run is a chain of awaited mocks; a handful of macrotask turns lets
  // it reach either Result navigation or the error surface.
  for (let i = 0; i < 20; i += 1) {
    if (
      mockNavigation.replace.mock.calls.length > 0 ||
      allText(renderer).includes('Nothing was rated.')
    ) {
      return;
    }
    await act(async () => {
      await new Promise(resolve => setTimeout(() => resolve(undefined), 10));
    });
  }
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
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

async function runOneAnalysis(renderer: TestRenderer.ReactTestRenderer) {
  pressByLabel(renderer, 'Forehand Drive');
  mockCaptureImpl = async () => guidedClip();
  pressButton(renderer, 'Open automatic camera');
  await settle(renderer);
}

/** What the player sees after a run whose score is already durable. */
function outcomeOf(renderer: TestRenderer.ReactTestRenderer) {
  const text = allText(renderer);
  return {
    routedToResult: mockNavigation.replace.mock.calls.some(
      call => call[0] === 'Result' && call[1]?.analysisId === 'analysis-1',
    ),
    saysNothingWasRated: text.includes('Nothing was rated.'),
    offersTryAgain: text.includes('Try again'),
  };
}

const expectedAfterDurableScore = {
  routedToResult: true,
  saysNothingWasRated: false,
  offersTryAgain: false,
};

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
  configureAccessStore(backendReturning(async () => freeAccess(1, 1)));
  useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess(0) });
  mockOutcome = async () => scoredOutcome();
});

afterEach(() => {
  currentDb = recordingDb;
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('XCF-07 attack: practice-set bookkeeping failures after a durable score', () => {
  it('control: a clean commit routes the scored run to Result', async () => {
    const { db } = scriptedDb({});
    currentDb = db;
    const renderer = await renderScreen();
    await runOneAnalysis(renderer);
    expect(outcomeOf(renderer)).toEqual(expectedAfterDurableScore);
    await act(async () => renderer.unmount());
  });

  it('a NEW set whose kv activity stamp fails once (session row written, shot queued) still reaches Result — not "Nothing was rated."', async () => {
    const { db, statements } = scriptedDb({ kvStampFailures: 1 });
    currentDb = db;
    const renderer = await renderScreen();
    await runOneAnalysis(renderer);
    // The commit got as far as persisting the session: the score, the
    // session row and the shot's sync row all exist.
    expect(
      statements.some(s =>
        s.sql.includes('INSERT OR REPLACE INTO local_session'),
      ),
    ).toBe(true);
    expect(outcomeOf(renderer)).toEqual(expectedAfterDurableScore);
    await act(async () => renderer.unmount());
  });

  it('a RESUMED live set (no session write at all) whose kv stamp fails still reaches Result', async () => {
    const stored = JSON.stringify({
      sessionId: liveSetId,
      shotType: 'forehand_drive',
      startedAtIso: new Date(Date.now() - 60_000).toISOString(),
      lastActivityAtIso: new Date(Date.now() - 30_000).toISOString(),
    });
    const { db, statements } = scriptedDb({
      storedSet: stored,
      kvStampFailures: 1,
    });
    currentDb = db;
    const renderer = await renderScreen();
    await runOneAnalysis(renderer);
    // Resumed: nothing but the stamp is written by the commit.
    expect(
      statements.some(s =>
        s.sql.includes('INSERT OR REPLACE INTO local_session'),
      ),
    ).toBe(false);
    expect(outcomeOf(renderer)).toEqual(expectedAfterDurableScore);
    await act(async () => renderer.unmount());
  });

  it('a session write that exhausts its retries AND a detach that fails on the same locked db still reaches Result', async () => {
    const { db } = scriptedDb({
      sessionWriteFailures: Number.POSITIVE_INFINITY,
      detachFailures: 1,
    });
    currentDb = db;
    const renderer = await renderScreen();
    await runOneAnalysis(renderer);
    expect(outcomeOf(renderer)).toEqual(expectedAfterDurableScore);
    await act(async () => renderer.unmount());
  });
});
