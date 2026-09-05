import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { CapturedClip } from '../src/camera/capture';
import type { LocalDb } from '../src/data/db';
import type {
  CaptureAnalysisOutcome,
  RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';

const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  navigate: jest.fn(),
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
const mockCapture = jest.fn<Promise<CapturedClip>, []>();
const mockCancel = jest.fn();
jest.mock('../src/camera/capture', () => ({
  ...jest.requireActual('../src/camera/capture'),
  captureStrokeVideo: () => mockCapture(),
  cancelCameraOperation: () => mockCancel(),
  subscribeToCameraEvents: () => () => {},
}));
const mockRunAnalysis = jest.fn<
  Promise<CaptureAnalysisOutcome>,
  [RunCaptureAnalysisRequest]
>();
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: (request: RunCaptureAnalysisRequest) =>
    mockRunAnalysis(request),
}));
const mockCommitPracticeSet = jest.fn<Promise<void>, unknown[]>(async () => {});
jest.mock('../src/analysis/practiceSet', () => ({
  ...jest.requireActual('../src/analysis/practiceSet'),
  commitPracticeSet: (...args: unknown[]) => mockCommitPracticeSet(...args),
}));
const mockSync = jest.fn();
const mockReview = jest.fn(async () => {});
jest.mock('../src/data/syncRuntime', () => ({
  triggerOutboxSync: () => mockSync(),
}));
jest.mock('../src/review/appStoreReview', () => ({
  reportScoredAnalysisForReview: () => mockReview(),
}));
let mockDb: LocalDb;
jest.mock('../src/data/db', () => ({ getDb: () => mockDb }));

import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import {
  armTryAgain,
  clearTryAgainHandoff,
} from '../src/screens/tryAgainHandoff';
import {
  captureDataOwnerScope,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';

const owner = '11111111-1111-4111-8111-111111111111';
const otherOwner = '22222222-2222-4222-8222-222222222222';
const clip: CapturedClip = {
  uri: 'file:///captures/atomic-ui.mov',
  durationMs: 3000,
  fps: 60,
  width: 1080,
  height: 1080,
  capturedAtIso: '2026-09-04T10:00:00.000Z',
  captureMode: 'automatic_pose_trigger',
  recognition: {
    status: 'unknown',
    reason: 'validated_classifier_unavailable',
  },
  ballSpeed: {
    status: 'unavailable',
    reason: 'calibrated_ball_tracker_unavailable',
  },
  preRollMs: 2000,
  postRollMs: 1500,
  trigger: {
    startMs: 0,
    endMs: 3000,
    confidence: 0.9,
    source: 'temporal_pose_motion',
    modelVersion: 'temporal-stroke-heuristic-4',
  },
  captureEvidence: {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'apple_vision_body_pose',
    poseModelVersion: 'apple-vision-bodypose-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-4',
    motionUnit: 'normalized_image_units_per_second',
    analysisInputFrameCount: 180,
    poseFrameCount: 180,
    poseMissingFrameCount: 0,
    trackedDurationMs: 3000,
    meanCanonicalJointVisibility: 0.9,
    meanJointCoverage: 0.9,
    minimumJointCoverage: 0.8,
    fullBodyVisibleFrameCount: 180,
    jointMotion: [],
  },
  poseSequence: {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri: 'file:///captures/atomic-ui.pose.json',
    frameCount: 180,
    sha256: 'a'.repeat(64),
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
  },
};
const scored = {
  kind: 'scored',
  analysisId: 'scored-analysis',
  freeLimitReached: false,
  record: {},
} as Extract<CaptureAnalysisOutcome, { kind: 'scored' }>;
const calls: Array<{ sql: string; params: unknown[] }> = [];
let mounted: TestRenderer.ReactTestRenderer | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function launch() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  mounted = renderer;
  await act(async () => {
    jest.advanceTimersByTime(160);
  });
  return renderer;
}

function closeAnalysis(renderer: TestRenderer.ReactTestRenderer) {
  const button = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === 'Close' &&
      typeof node.props.onPress === 'function',
  )[0];
  expect(button).toBeDefined();
  button!.props.onPress();
}

beforeEach(() => {
  jest.useFakeTimers();
  calls.length = 0;
  mockDb = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
    close() {},
  };
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'owner-token',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  armTryAgain({
    source: 'camera',
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    auto: false,
    sessionId: null,
  });
  mockCapture.mockReset().mockResolvedValue(clip);
  mockRunAnalysis
    .mockReset()
    .mockResolvedValue({ ...scored, practiceSetCommitted: true });
  mockCommitPracticeSet.mockClear();
  mockSync.mockClear();
  mockReview.mockClear();
  mockCancel.mockClear();
  Object.values(mockNavigation).forEach(mock => mock.mockClear());
});

afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  clearTryAgainHandoff();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.useRealTimers();
});

describe('Analyze flow practice-set ownership and completion', () => {
  it('passes the actual owner-scoped plan into analysis and never recommits an atomic scored result', async () => {
    await launch();
    expect(mockRunAnalysis).toHaveBeenCalledTimes(1);
    const request = mockRunAnalysis.mock.calls[0]![0];
    expect(request.practiceSetPlan).toMatchObject({
      owner,
      ownerGeneration: captureDataOwnerScope().generation,
      resumed: false,
      shotType: 'forehand_drive',
      sessionId: request.sessionId,
    });
    expect(mockCommitPracticeSet).not.toHaveBeenCalled();
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: scored.analysisId,
    });
  });

  it('keeps a separate commit only for legacy scored outcomes without atomic persistence confirmation', async () => {
    mockRunAnalysis.mockResolvedValue(scored);
    await launch();
    expect(mockCommitPracticeSet).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledTimes(1);
  });

  it.each(['close', 'unmount'] as const)(
    'preserves same-owner completion after %s without late result UI or a second practice commit',
    async leave => {
      const pending = deferred<CaptureAnalysisOutcome>();
      mockRunAnalysis.mockReturnValue(pending.promise);
      const renderer = await launch();
      expect(mockRunAnalysis).toHaveBeenCalledTimes(1);
      if (leave === 'close') {
        act(() => closeAnalysis(renderer));
      } else {
        act(() => renderer.unmount());
        mounted = null;
      }
      const closedTree = renderer.toJSON();
      await act(async () =>
        pending.resolve({ ...scored, practiceSetCommitted: true }),
      );
      expect(mockSync).toHaveBeenCalledTimes(1);
      expect(mockCommitPracticeSet).not.toHaveBeenCalled();
      expect(mockNavigation.replace).not.toHaveBeenCalled();
      expect(mockNavigation.navigate).not.toHaveBeenCalled();
      expect(mockReview).not.toHaveBeenCalled();
      expect(renderer.toJSON()).toEqual(closedTree);
    },
  );

  it('does not revive scoring UI or sync after leaving and returning to the same owner in another generation', async () => {
    const pending = deferred<CaptureAnalysisOutcome>();
    mockRunAnalysis.mockReturnValue(pending.promise);
    const renderer = await launch();
    const before = renderer.toJSON();
    setActiveDataOwner(otherOwner);
    setActiveDataOwner(owner);
    await act(async () =>
      pending.resolve({ ...scored, practiceSetCommitted: true }),
    );
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockCommitPracticeSet).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(mockReview).not.toHaveBeenCalled();
    expect(renderer.toJSON()).toEqual(before);
  });

  it('does not persist a late native capture after an owner generation changed', async () => {
    const pending = deferred<CapturedClip>();
    mockCapture.mockReturnValue(pending.promise);
    await launch();
    expect(mockCapture).toHaveBeenCalledTimes(1);
    setActiveDataOwner(otherOwner);
    setActiveDataOwner(owner);
    await act(async () => pending.resolve(clip));
    expect(calls).toEqual([]);
    expect(mockRunAnalysis).not.toHaveBeenCalled();
  });

  it('surfaces an atomic storage failure as retryable without committing a practice set or navigating', async () => {
    mockRunAnalysis.mockResolvedValue({
      kind: 'unavailable',
      cause: 'storage_failed',
      reason:
        'The analysis could not be saved. Your capture is still available to try again.',
    });
    const renderer = await launch();
    expect(JSON.stringify(renderer.toJSON())).toContain('Nothing was rated.');
    expect(JSON.stringify(renderer.toJSON())).toContain(
      'Your capture is still available to try again.',
    );
    expect(mockCommitPracticeSet).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
  });
});
