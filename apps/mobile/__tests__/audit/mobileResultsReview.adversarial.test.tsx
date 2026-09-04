/**
 * Execution audit harness — subsystem `mobile-results-review` (cloud plane).
 *
 * Adversarial states the shipped suites do not pin (per `jest --coverage`
 * on 4d812e1a: FormReviewScreen.tsx L78/L88/L113/L124, ResultScreen.tsx L262
 * (sidecar loader REJECTS, not resolves null), tryAgainHandoff.ts TTL edge):
 *
 *  - the evidence read itself REJECTS (locked SQLite) on Form Review;
 *  - the pose sidecar loader REJECTS (corrupt/unreadable file) on both hosts;
 *  - route param changes / unmount while the read is still in flight
 *    (no state update on an unmounted tree, no stale evidence painted);
 *  - the sync-receipt / outbox lookups THROW (must degrade to "unknown");
 *  - TRY AGAIN TTL boundary (exactly TTL ms is still valid, TTL+1 is not),
 *    double consumption records telemetry exactly once;
 *  - App Store review: native `requestReview` rejects → the reporter still
 *    resolves, the prompt count was persisted BEFORE the ask, the next report
 *    still runs (queue is not poisoned).
 *
 * Test-only file. No production code is touched by this harness.
 */
jest.mock('../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));

const mockLoadEvidence = jest.fn();
jest.mock('../../src/components/strokeResultData', () => ({
  loadStrokeResultEvidence: (...args: unknown[]) => mockLoadEvidence(...args),
}));

const mockLoadSequence = jest.fn();
jest.mock('../../src/review/poseSidecar', () => ({
  loadReviewPoseSequence: (...args: unknown[]) => mockLoadSequence(...args),
}));

const mockHasShotSyncReceipt = jest.fn();
const mockGetShotOutboxStatus = jest.fn();
const mockListRealAnalysisFacts = jest.fn();
const mockGetKv = jest.fn();
const mockSetKv = jest.fn();
jest.mock('../../src/data/repository', () => ({
  hasShotSyncReceipt: (...args: unknown[]) => mockHasShotSyncReceipt(...args),
  getShotOutboxStatus: (...args: unknown[]) => mockGetShotOutboxStatus(...args),
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
  getKv: (...args: unknown[]) => mockGetKv(...args),
  setKv: (...args: unknown[]) => mockSetKv(...args),
}));

const mockGetApiSession = jest.fn();
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

const mockListCatalogDrills = jest.fn();
jest.mock('../../src/training/api', () => ({
  createTrainingApi: () => ({ listCatalogDrills: mockListCatalogDrills }),
}));

const mockConsistencyState = {
  refresh: jest.fn(async () => {}),
  daySecured: null as unknown,
  consumeDaySecured: jest.fn(() => null),
};
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (state: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState),
}));

const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  popTo: jest.fn(),
  popToTop: jest.fn(),
  navigate: jest.fn(),
};
let mockRouteParams: Record<string, unknown> = { analysisId: 'analysis-1' };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: mockRouteParams }),
}));
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: (props: { children?: React.ReactNode; testID?: string }) =>
      React.createElement(View, { testID: props.testID }, props.children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
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
    Defs: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    RadialGradient: Mock,
    LinearGradient: Mock,
    Rect: Mock,
    Stop: Mock,
  };
});

const mockStabilityRecord = jest.fn();
jest.mock('../../src/analysis/stabilityTelemetry', () => ({
  stabilitySlo: {
    record: (...args: unknown[]) => mockStabilityRecord(...args),
  },
}));

import React from 'react';
import { NativeModules, Platform, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import { FormReviewScreen } from '../../src/screens/FormReviewScreen';
import { ResultScreen } from '../../src/screens/ResultScreen';
import { ResultDetailsScreen } from '../../src/screens/ResultDetailsScreen';
import {
  TRY_AGAIN_HANDOFF_TTL_MS,
  armTryAgain,
  clearTryAgainHandoff,
  consumeTryAgainHandoff,
  peekTryAgainHandoff,
  tryAgainFromResult,
} from '../../src/screens/tryAgainHandoff';
import {
  REVIEW_PROMPT_KV_KEY,
  parseReviewPromptState,
  reportScoredAnalysisForReview,
} from '../../src/review/appStoreReview';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
} from '../../src/training/store';
import type { TrainingApi } from '../../src/training/types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function phase(
  key: PhaseKey,
  startMs: number,
  endMs: number,
  representativeMs = startMs + (endMs - startMs) / 2,
): PhaseSpan {
  return { key, startMs, representativeMs, endMs, confidence: 0.8 };
}

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
  overrides: Partial<CheckpointScore> = {},
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
    ...overrides,
  };
}

function scoredAnalysis(id = 'analysis-1'): ShotAnalysis {
  return {
    id,
    sessionId: 'set-1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases: [
      phase('ready', 0, 900),
      phase('prepare', 900, 1500),
      phase('accelerate', 1500, 1900),
      phase('contact', 1880, 1920, 1900),
      phase('follow_through', 1920, 2400),
      phase('recover', 2400, 3200),
    ],
    measurements: [],
    checkpoints: [
      checkpoint('ready_position', 85, 'green', 'none'),
      checkpoint('athletic_base', 72, 'yellow', 'narrow'),
      checkpoint('preparation', 88, 'green', 'none'),
      checkpoint('paddle_set', 90, 'green', 'none'),
      checkpoint('swing_length', null, 'unscored', 'none'),
      checkpoint('sequencing', 82, 'green', 'none'),
      checkpoint('paddle_path', 61, 'red', 'low'),
      checkpoint('contact_position', 48, 'red', 'late'),
      checkpoint('face_wrist_stability', 30, 'red', 'unstable', {
        applicable: false,
      }),
      checkpoint('follow_through', 80, 'green', 'short'),
      checkpoint('recovery', 92, 'green', 'none'),
    ],
    overallScore: 7.1,
    analysisConfidence: 0.84,
    resultKind: 'scored',
    guidance: null,
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'lowest_score',
      severity: 0.52,
      confidence: 0.8,
    },
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-geometry-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

const record = {
  id: 'analysis-1',
  captureId: 'capture-1',
  strokeIntent: {
    declaredStroke: 'forehand_drive' as const,
    predictedStroke: null,
    resolutionBasis: 'declared' as const,
    resolvedProfileId: 'FOREHAND_DRIVE',
    resolvedProfileVersion: 'technique-profile-v1',
    disagreement: null,
  },
  result: null,
  uncertainty: {
    analysisConfidence: 0.84,
    presentation: 'normal' as const,
    limitingFactors: [],
  },
};

const session = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'access-token',
  canonicalAppUserId: '00000000-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};

function fakeTrainingApi(): TrainingApi {
  return {
    listSavedDrills: async () => [],
    getDrill: async () => {
      throw new Error('no catalog in this test');
    },
    saveDrill: async () => {},
    unsaveDrill: async () => {},
    getCurrentPlan: async () => null,
    createPlan: async () => {
      throw new Error('createPlan not configured');
    },
    completeDrill: async () => {
      throw new Error('completeDrill not configured');
    },
    reassessPlan: async () => {
      throw new Error('reassessPlan not configured');
    },
  };
}

const sidecarRef = {
  schemaVersion: 1 as const,
  format: 'pickle.pose-sequence.v1' as const,
  uri: 'file:///captures/clip.pose.json',
  frameCount: 81,
  sha256: 'ab'.repeat(32),
  coordinateSystem: 'normalized_image_top_left' as const,
  poseModelVersion: 'apple-vision-bodypose-1',
};

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    analysis: scoredAnalysis(),
    record,
    clip: {
      uri: 'file:///captures/clip.mov',
      durationMs: 3400,
      posterUri: 'file:///captures/clip.poster.jpg',
    },
    review: { width: 1080, height: 1920, poseSequence: sidecarRef },
    attempts: [],
    ...overrides,
  };
}

// ─── Harness ────────────────────────────────────────────────────────────────

const mounted: ReactTestRenderer[] = [];

async function settle(turns = 6) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(element: React.ReactElement) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  mounted.push(renderer);
  return renderer;
}

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

function pressByLabel(renderer: ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.accessibilityLabel === label &&
      typeof candidate.props.onPress === 'function',
  );
  if (!node) throw new Error(`no pressable labelled ${label}`);
  act(() => node.props.onPress());
}

function pressByText(renderer: ReactTestRenderer, text: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      typeof candidate.props.onPress === 'function' &&
      candidate.findAll(child => child.props.children === text).length > 0,
  );
  if (!node) throw new Error(`no pressable reading ${text}`);
  act(() => node.props.onPress());
}

/** A promise the test resolves/rejects by hand — for in-flight races. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  clearTryAgainHandoff();
  clearTrainingStoreConfiguration();
  mockRouteParams = { analysisId: 'analysis-1' };
  mockLoadEvidence.mockResolvedValue(evidence());
  mockLoadSequence.mockResolvedValue(null);
  mockHasShotSyncReceipt.mockResolvedValue(false);
  mockGetShotOutboxStatus.mockResolvedValue({ state: 'absent' });
  mockListRealAnalysisFacts.mockResolvedValue([]);
  mockGetApiSession.mockReturnValue(null);
  mockListCatalogDrills.mockResolvedValue([]);
  mockGetKv.mockResolvedValue(null);
  mockSetKv.mockResolvedValue(undefined);
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  consoleError.mockRestore();
  jest.useRealTimers();
});

// ─── Form Review ────────────────────────────────────────────────────────────

describe('FormReviewScreen under failing storage', () => {
  it('a REJECTED evidence read lands on "Review unavailable" (never a throw, never a spinner) and its exit goes back', async () => {
    mockLoadEvidence.mockRejectedValue(new Error('database is locked'));
    const renderer = await mount(<FormReviewScreen />);
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('Review unavailable');
    expect(copy).not.toContain('Preparing your form review');
    expect(mockLoadSequence).not.toHaveBeenCalled();
    // AUDIT NOTE (P3, FormReviewScreen.tsx:121-126): no `retryLabel` is
    // passed, so ErrorState's default "Try again" is shown — but the action
    // is `navigation.goBack()`, not a retry (ResultScreen/ResultDetails pass
    // retryLabel="Go back" for the same action). Pinned as observed.
    expect(copy).toContain('Try again');
    expect(copy).not.toContain('Go back');
    pressByText(renderer, 'Try again');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    expect(mockLoadEvidence).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('a REJECTING sidecar loader (corrupt pose file) still yields a video-only replay', async () => {
    mockLoadSequence.mockRejectedValue(new Error('sha256 mismatch'));
    const renderer = await mount(<FormReviewScreen />);
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('No verified pose sequence is stored for this clip');
    expect(copy).toContain('STOP 1 OF');
    expect(copy).not.toContain('Review unavailable');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('a legacy record whose analysis lives only in record.result still opens', async () => {
    mockLoadEvidence.mockResolvedValue(
      evidence({
        analysis: null,
        record: { ...record, result: scoredAnalysis() },
        review: null,
        clip: null,
      }),
    );
    const renderer = await mount(<FormReviewScreen />);
    await settle();
    expect(allText(renderer)).toContain('STOP 1 OF');
    expect(mockLoadSequence).not.toHaveBeenCalled();
  });

  it('Close during the in-flight read goes back; a read that settles after unmount paints nothing', async () => {
    const pending = deferred<ReturnType<typeof evidence>>();
    mockLoadEvidence.mockReturnValue(pending.promise);
    const renderer = await mount(<FormReviewScreen />);
    expect(allText(renderer)).toContain('Preparing your form review');
    pressByLabel(renderer, 'Close');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.unmount();
    });
    mounted.splice(0);
    pending.resolve(evidence());
    await settle();
    // No "update on an unmounted component" / act() warning surfaced.
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('a route param change mid-read never paints the superseded stroke', async () => {
    const first = deferred<ReturnType<typeof evidence>>();
    mockLoadEvidence.mockImplementation((_db: unknown, id: string) =>
      id === 'analysis-1'
        ? first.promise
        : Promise.resolve(
            evidence({
              analysis: null,
              record: null,
              review: null,
              clip: null,
            }),
          ),
    );
    const renderer = await mount(<FormReviewScreen />);
    mockRouteParams = { analysisId: 'analysis-2' };
    await act(async () => {
      renderer.update(<FormReviewScreen />);
    });
    await settle();
    expect(allText(renderer)).toContain('Review unavailable');
    // The superseded read now lands with a full scored analysis — it must lose.
    first.resolve(evidence());
    await settle();
    expect(allText(renderer)).toContain('Review unavailable');
    expect(allText(renderer)).not.toContain('STOP 1 OF');
  });
});

// ─── Result (guide) ─────────────────────────────────────────────────────────

describe('ResultScreen under failing storage', () => {
  it('a REJECTING sidecar loader keeps the scored guide on its SCORE page (no crash, no fabricated pose)', async () => {
    mockLoadSequence.mockRejectedValue(new Error('ENOENT'));
    const renderer = await mount(<ResultScreen />);
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('1 OF');
    expect(copy).toContain('(≈ DUPR 5.3)');
    expect(copy).not.toContain('Result missing');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('THROWING sync-receipt and outbox lookups degrade to the honest "unknown" state, never a crash', async () => {
    mockGetApiSession.mockReturnValue(session);
    configureTrainingStore(fakeTrainingApi());
    mockHasShotSyncReceipt.mockRejectedValue(new Error('no such table'));
    mockGetShotOutboxStatus.mockRejectedValue(new Error('no such table'));
    const renderer = await mount(<ResultDetailsScreen />);
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain(
      'could not verify whether this shot reached the server',
    );
    expect(copy).not.toContain('Checking sync evidence');
    expect(copy).not.toContain('still in the secure outbox');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('a receipt says synced but the outbox lookup throws: the receipt wins (no lookup is made)', async () => {
    mockGetApiSession.mockReturnValue(session);
    configureTrainingStore(fakeTrainingApi());
    mockHasShotSyncReceipt.mockResolvedValue(true);
    mockGetShotOutboxStatus.mockRejectedValue(new Error('unreachable'));
    const renderer = await mount(<ResultDetailsScreen />);
    await settle();
    expect(mockGetShotOutboxStatus).not.toHaveBeenCalled();
    expect(allText(renderer)).not.toContain('could not verify');
  });

  it('a practice-set fact read that throws leaves the SCORE page without a set card', async () => {
    mockListRealAnalysisFacts.mockRejectedValue(new Error('locked'));
    const renderer = await mount(<ResultScreen />);
    await settle();
    expect(
      renderer.root.findAll(
        node => node.props.testID === 'result-guide-practice-set',
      ),
    ).toHaveLength(0);
    expect(allText(renderer)).toContain('1 OF');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('a superseded evidence read never overwrites the current route’s result', async () => {
    const first = deferred<ReturnType<typeof evidence>>();
    mockLoadEvidence.mockImplementation((_db: unknown, id: string) =>
      id === 'analysis-1'
        ? first.promise
        : Promise.resolve(
            evidence({
              analysis: null,
              record: null,
              review: null,
              clip: null,
            }),
          ),
    );
    const renderer = await mount(<ResultScreen />);
    expect(allText(renderer)).toContain('Opening your result');
    mockRouteParams = { analysisId: 'analysis-2' };
    await act(async () => {
      renderer.update(<ResultScreen />);
    });
    await settle();
    expect(allText(renderer)).toContain('Result missing');
    first.resolve(evidence());
    await settle();
    expect(allText(renderer)).toContain('Result missing');
    expect(allText(renderer)).not.toContain('(≈ DUPR');
  });
});

// ─── TRY AGAIN handoff ──────────────────────────────────────────────────────

describe('tryAgainHandoff TTL edges and telemetry', () => {
  const handoff = tryAgainFromResult(record, { shotType: 'forehand_drive' });

  it('is still valid at exactly TTL ms and gone at TTL+1', () => {
    armTryAgain(handoff);
    jest.setSystemTime(Date.now() + TRY_AGAIN_HANDOFF_TTL_MS);
    expect(peekTryAgainHandoff()).toEqual(handoff);
    jest.setSystemTime(Date.now() + 1);
    expect(peekTryAgainHandoff()).toBeNull();
  });

  it('expired consumption records try_again_failed ONCE; a second consume records nothing', () => {
    armTryAgain(handoff);
    jest.setSystemTime(Date.now() + TRY_AGAIN_HANDOFF_TTL_MS + 1);
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(mockStabilityRecord).toHaveBeenCalledTimes(1);
    expect(mockStabilityRecord).toHaveBeenCalledWith({
      kind: 'try_again_failed',
      reason: 'handoff_expired',
    });
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(mockStabilityRecord).toHaveBeenCalledTimes(1);
  });

  it('valid consumption records try_again_rearmed exactly once', () => {
    armTryAgain(handoff);
    expect(consumeTryAgainHandoff()).toEqual(handoff);
    expect(mockStabilityRecord).toHaveBeenCalledTimes(1);
    expect(mockStabilityRecord).toHaveBeenCalledWith({
      kind: 'try_again_rearmed',
    });
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(mockStabilityRecord).toHaveBeenCalledTimes(1);
  });

  it('a wall clock that jumps BACKWARDS after arming does not expire the handoff', () => {
    armTryAgain(handoff);
    jest.setSystemTime(Date.now() - 60 * 60 * 1000);
    expect(peekTryAgainHandoff()).toEqual(handoff);
  });

  it('a declared canonical from a DIFFERENT technique is dropped, not re-armed', () => {
    const mismatched = tryAgainFromResult(
      {
        strokeIntent: {
          ...record.strokeIntent,
          declaredStroke: 'forehand_drive',
          resolvedProfileId: 'BACKHAND_DRIVE',
        },
      },
      { shotType: 'forehand_drive' },
    );
    expect(mismatched.declaredStroke).toBe('forehand_drive');
    expect(mismatched.declaredCanonical).not.toBe('BACKHAND_DRIVE');
  });
});

// ─── App Store review prompt ────────────────────────────────────────────────

describe('App Store review reporter under a failing StoreKit bridge', () => {
  const originalOS = Platform.OS;
  const nativeModules = NativeModules as Record<string, unknown>;
  let originalBridge: unknown;

  beforeEach(() => {
    Platform.OS = 'ios';
    originalBridge = nativeModules['PickleStoreReview'];
  });

  afterEach(() => {
    Platform.OS = originalOS;
    nativeModules['PickleStoreReview'] = originalBridge;
  });

  it('requestReview REJECTING never rejects the reporter; the ask was persisted first and the queue keeps serving', async () => {
    const requestReview = jest
      .fn()
      .mockRejectedValueOnce(new Error('SKStoreReviewController unavailable'))
      .mockResolvedValue(true);
    nativeModules['PickleStoreReview'] = { requestReview };

    const first = reportScoredAnalysisForReview({ delayMs: 0 });
    await jest.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toBeUndefined();
    expect(requestReview).toHaveBeenCalledTimes(1);
    expect(mockSetKv).toHaveBeenCalledTimes(1);
    const persisted = parseReviewPromptState(
      mockSetKv.mock.calls[0]![2] as string,
    );
    expect(persisted).toMatchObject({ scoredAnalyses: 1, promptedCount: 1 });
    expect(mockSetKv.mock.calls[0]![1]).toBe(REVIEW_PROMPT_KV_KEY);

    // State now reads back with one ask; the next scored analysis asks again.
    mockGetKv.mockResolvedValue(JSON.stringify(persisted));
    const second = reportScoredAnalysisForReview({ delayMs: 0 });
    await jest.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toBeUndefined();
    expect(requestReview).toHaveBeenCalledTimes(2);
    expect(
      parseReviewPromptState(mockSetKv.mock.calls[1]![2] as string),
    ).toMatchObject({ scoredAnalyses: 2, promptedCount: 2 });
  });

  it('a persistence failure skips the ask entirely (no unbounded sheet replay)', async () => {
    const requestReview = jest.fn().mockResolvedValue(true);
    nativeModules['PickleStoreReview'] = { requestReview };
    mockSetKv.mockRejectedValue(new Error('disk full'));
    const run = reportScoredAnalysisForReview({ delayMs: 0 });
    await jest.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toBeUndefined();
    expect(requestReview).not.toHaveBeenCalled();
  });

  it('corrupt kv JSON is treated as a fresh device (asks) rather than throwing', async () => {
    const requestReview = jest.fn().mockResolvedValue(true);
    nativeModules['PickleStoreReview'] = { requestReview };
    mockGetKv.mockResolvedValue('{"reviewedAtIso":');
    const run = reportScoredAnalysisForReview({ delayMs: 0 });
    await jest.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toBeUndefined();
    expect(requestReview).toHaveBeenCalledTimes(1);
  });
});
