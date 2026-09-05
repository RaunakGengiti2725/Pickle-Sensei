/**
 * ADVERSARIAL PASS 3 / tester #4 — AnalyzeScreen lifecycle attacks against
 * 4d812e1a (mobile-analyze-capture). Each `it` is one attack; the assertion
 * pins the behaviour OBSERVED on this commit so the run is an executable
 * record. Attacks whose observed behaviour contradicts REVIEW.md / the
 * AGENTS.md contract are labelled `[BROKEN]` in their title and their
 * expectation comment; everything else is `[HELD]`. Pins inverted by the
 * MAC-03/MAC-04 fixes (S1 cancellation classification, S8 deferred ledger
 * refresh) and by the A2 fix (S10 practice-set commit for an abandoned
 * scored run) are labelled `[FIXED]` and now assert the contract.
 *
 * Camera + native are simulated exactly like the existing flow harnesses
 * (analyzeScreenExtractionProgress / analyzeScreenAccessRefresh): the typed
 * capture seam is mocked, the access store and practice-set planner are REAL.
 */
jest.mock('../src/data/db', () => ({ getDb: () => mockCurrentDb() }));
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../src/data/syncRuntime', () => ({
  triggerOutboxSync: jest.fn(),
}));

type CameraListener = (event: CameraEvent) => void;
const mockCameraListeners = new Set<CameraListener>();

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: jest.fn(),
    importStrokeVideo: jest.fn(),
    cancelCameraOperation: jest.fn(),
    importedPoseExtractionAvailable: jest.fn(() => true),
    extractImportedPoseSequence: jest.fn(),
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
  };
});
jest.mock('../src/camera/TargetSelector', () => ({
  TargetSelector: () => null,
}));
const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  popToTop: jest.fn(),
  navigate: jest.fn(),
};
let mockRouteParams: Record<string, unknown> = {};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: mockRouteParams }),
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
import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import { TargetSelector } from '../src/camera/TargetSelector';
import {
  assertCapturedClip,
  cancelCameraOperation,
  captureStrokeVideo,
  extractImportedPoseSequence,
  importStrokeVideo,
  type CameraEvent,
  type CapturedClip,
} from '../src/camera/capture';
import {
  runCaptureAnalysis,
  type CaptureAnalysisOutcome,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
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
import { practiceSetKeyForOwner } from '../src/analysis/practiceSet';
import { triggerOutboxSync } from '../src/data/syncRuntime';

// ─── Recording LocalDb: every statement is logged so commits are visible ─────

interface Statement {
  sql: string;
  params: unknown[];
}
let statements: Statement[] = [];
const kv = new Map<string, string>();
const recordingDb: LocalDb = {
  async execute(sql: string, params: unknown[] = []) {
    statements.push({ sql, params });
    if (sql.startsWith('SELECT value FROM kv')) {
      const value = kv.get(String(params[0]));
      return { rows: value === undefined ? [] : [{ value }] };
    }
    if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
      kv.set(String(params[0]), String(params[1]));
    }
    return { rows: [] };
  },
  close() {},
};
function mockCurrentDb(): LocalDb {
  return recordingDb;
}

const owner = '44444444-4444-4444-8444-444444444444';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const importedClip = assertCapturedClip({
  uri: 'file:///private/var/mobile/import.mov',
  durationMs: 4200,
  fps: 30,
  width: 1920,
  height: 1080,
  capturedAtIso: '2026-09-04T12:00:00.000Z',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
});

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
    analysisId: 'analysis-attack-1',
    record: {} as Extract<CaptureAnalysisOutcome, { kind: 'scored' }>['record'],
    freeLimitReached,
  };
}

function lowConfidenceOutcome(): CaptureAnalysisOutcome {
  return {
    kind: 'low_confidence',
    analysisId: 'analysis-attack-2',
    record: {} as Extract<CaptureAnalysisOutcome, { kind: 'scored' }>['record'],
    guidance: null,
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

function renderedText(renderer: ReactTestRenderer): string {
  const collect = (node: unknown): string => {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(collect).join('');
    const json = node as { children?: unknown[] };
    return (json.children ?? []).map(collect).join('\n');
  };
  return collect(renderer.toJSON());
}

function alertCount(renderer: ReactTestRenderer): number {
  return renderer.root.findAll(
    n => n.props.accessibilityRole === 'alert' && typeof n.type === 'string',
  ).length;
}

function pressByLabel(renderer: ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
  act(() => node.props.onPress());
}

function hasButton(renderer: ReactTestRenderer, label: string): boolean {
  return (
    renderer.root.findAll(
      n =>
        typeof n.props.onPress === 'function' &&
        n.findAll(t => t.type === Text && String(t.props.children) === label)
          .length > 0,
    ).length > 0
  );
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
    jest.advanceTimersByTime(0);
  });
  await act(async () => {});
}

async function renderScreen(
  source: 'library' | 'camera',
): Promise<ReactTestRenderer> {
  mockRouteParams = { source };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  if (source === 'library') {
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    await act(async () => {});
  }
  return renderer;
}

function deferred<T>(mock: jest.Mock): {
  resolve: (value: T) => Promise<void>;
  reject: (error: Error) => Promise<void>;
} {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: Error) => void;
  mock.mockImplementation(
    () =>
      new Promise<T>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      }),
  );
  return {
    resolve: async value => {
      await act(async () => {
        resolveFn(value);
      });
      await flush();
    },
    reject: async error => {
      await act(async () => {
        rejectFn(error);
      });
      await flush();
    },
  };
}

/** Declares a stroke and drives one zero-touch camera run up to the point
 * where `runCaptureAnalysis` has been invoked (ledger touched). */
async function startCameraRun(renderer: ReactTestRenderer) {
  pressByLabel(renderer, 'Forehand Drive');
  (captureStrokeVideo as jest.Mock).mockResolvedValue(guidedClip());
  pressButton(renderer, 'Open automatic camera');
  await flush();
  await flush();
  expect(runCaptureAnalysis).toHaveBeenCalledTimes(1);
}

function analysisRequest(): RunCaptureAnalysisRequest {
  const call = (runCaptureAnalysis as jest.Mock).mock.calls[0];
  if (!call) throw new Error('runCaptureAnalysis was not called');
  return call[0] as RunCaptureAnalysisRequest;
}

function sqlMatching(pattern: RegExp): Statement[] {
  return statements.filter(statement => pattern.test(statement.sql));
}

let clients: BillingAccessDependencies;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockCameraListeners.clear();
  statements = [];
  kv.clear();
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-attack',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  clearAccessStoreConfiguration();
  clients = backendReturning(async () => freeAccess(0));
  configureAccessStore(clients);
  useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess(0) });
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.useRealTimers();
});

// ─── S1: system interruption whose message contains "cancelled" ─────────────

describe('S1 — capture rejection whose message merely CONTAINS "cancel"', () => {
  const interruption = () =>
    new Error('Recording cancelled by system interruption');

  it('[FIXED] camera: the interruption reaches the error surface with the message and Try again — it is not a user cancel', async () => {
    (captureStrokeVideo as jest.Mock).mockRejectedValue(interruption());
    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');
    pressButton(renderer, 'Open automatic camera');
    await flush();
    await flush();

    const text = renderedText(renderer);
    // Only the typed native code `camera.cancelled` is a user cancel; a
    // rejection whose message merely contains "cancel" is a real failure and
    // must be surfaced (REVIEW.md "errors are surfaced, never swallowed").
    expect(alertCount(renderer)).toBe(1);
    expect(text).toContain('Nothing was rated.');
    expect(text).toContain('Recording cancelled by system interruption');
    expect(hasButton(renderer, 'Try again')).toBe(true);
    expect(hasButton(renderer, 'Open automatic camera')).toBe(false);
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
  });

  it('[FIXED] library: the interruption does NOT pop the screen — the player sees the error surface', async () => {
    (importStrokeVideo as jest.Mock).mockRejectedValue(interruption());
    // Library imports auto-launch the picker; the rejection lands before any
    // stroke picker is shown.
    const renderer = await renderScreen('library');
    await flush();
    await flush();
    expect(importStrokeVideo).toHaveBeenCalledTimes(1);
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
    expect(alertCount(renderer)).toBe(1);
    expect(renderedText(renderer)).toContain(
      'Recording cancelled by system interruption',
    );
    expect(hasButton(renderer, 'Try again')).toBe(true);
  });

  it('[FIXED] the native error CODE decides: a `camera.session_failed` rejection is a failure even though its message says "cancelled"', async () => {
    const nativeFailure = Object.assign(
      new Error('The operation was cancelled by the system.'),
      { code: 'camera.session_failed' },
    );
    (captureStrokeVideo as jest.Mock).mockRejectedValue(nativeFailure);
    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');
    pressButton(renderer, 'Open automatic camera');
    await flush();
    await flush();
    expect(alertCount(renderer)).toBe(1);
    expect(renderedText(renderer)).toContain(
      'The operation was cancelled by the system.',
    );
    expect(hasButton(renderer, 'Try again')).toBe(true);
    expect(hasButton(renderer, 'Open automatic camera')).toBe(false);
  });

  it('[HELD] control: the same interruption WITHOUT the substring reaches the error surface with Try again', async () => {
    (captureStrokeVideo as jest.Mock).mockRejectedValue(
      new Error('Recording stopped by system interruption'),
    );
    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');
    pressButton(renderer, 'Open automatic camera');
    await flush();
    await flush();
    const text = renderedText(renderer);
    expect(alertCount(renderer)).toBe(1);
    expect(text).toContain('Nothing was rated.');
    expect(text).toContain('Recording stopped by system interruption');
    expect(hasButton(renderer, 'Try again')).toBe(true);
  });

  it('[HELD] control: a genuine native user cancel (code camera.cancelled) returns to ready without an alert', async () => {
    (captureStrokeVideo as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Camera capture was canceled.'), {
        code: 'camera.cancelled',
      }),
    );
    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');
    pressButton(renderer, 'Open automatic camera');
    await flush();
    await flush();
    expect(alertCount(renderer)).toBe(0);
    expect(hasButton(renderer, 'Open automatic camera')).toBe(true);
  });
});

// ─── S8: unmount mid-runCaptureAnalysis after ratingLedgerTouched ───────────

describe('S8 — unmount while runCaptureAnalysis is in flight', () => {
  it('[HELD] refreshAccess fires exactly once for the abandoned run — after it settles — and observes the CONSUMED ledger, never the reserved one', async () => {
    // Server ledger as the analysis progresses: while the permit is
    // reserved the server reports reserved=1; once the run scores it
    // reports used=2. Which snapshot the unmount refresh sees is recorded.
    type Ledger = 'reserved' | 'consumed';
    let serverLedger: Ledger = 'reserved';
    const observed: Ledger[] = [];
    clients = backendReturning(async () => {
      observed.push(serverLedger);
      return serverLedger === 'reserved' ? freeAccess(1, 1) : freeAccess(2, 0);
    });
    configureAccessStore(clients);
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: freeAccess(1),
    });

    const analysis = deferred<CaptureAnalysisOutcome>(
      runCaptureAnalysis as jest.Mock,
    );
    const renderer = await renderScreen('camera');
    await startCameraRun(renderer);
    expect(clients.backend.getAccess).not.toHaveBeenCalled();

    await act(async () => renderer.unmount());
    await flush();
    // The cleanup defers the refresh until the analysis settles: no read
    // while the server still holds the RESERVED permit.
    expect(clients.backend.getAccess).not.toHaveBeenCalled();
    expect(observed).toEqual([]);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(1));
    // The camera operation itself was already over: no native cancel is
    // issued for an analysis that is only running in JS.
    expect(cancelCameraOperation).not.toHaveBeenCalled();

    serverLedger = 'consumed';
    await analysis.resolve(scoredOutcome(true));
    await flush();
    // Exactly one read, and it observes the consumed ledger (used=2).
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(observed).toEqual(['consumed']);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(2, 0));
    expect(useAccessStore.getState().canonicalAccess?.canStartRating).toBe(
      false,
    );
    // The unmounted screen never routes.
    expect(mockNavigation.replace).not.toHaveBeenCalled();
  });

  it('[FIXED] unmount mid-run + LOW-CONFIDENCE outcome: the deferred refresh observes the RELEASED ledger once and the store admits the next rating (canStartRating=true)', async () => {
    // Last free rating: store admitted the visit on availableToReserve=1.
    let serverLedger: 'reserved' | 'released' = 'reserved';
    clients = backendReturning(async () =>
      serverLedger === 'reserved' ? freeAccess(1, 1) : freeAccess(1, 0),
    );
    configureAccessStore(clients);
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: freeAccess(1),
    });
    const analysis = deferred<CaptureAnalysisOutcome>(
      runCaptureAnalysis as jest.Mock,
    );
    const renderer = await renderScreen('camera');
    await startCameraRun(renderer);

    await act(async () => renderer.unmount());
    await flush();
    // No read while the permit is reserved: the admitted snapshot stays.
    expect(clients.backend.getAccess).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess?.canStartRating).toBe(
      true,
    );

    serverLedger = 'released';
    await analysis.resolve(lowConfidenceOutcome());
    await flush();
    // The snapshot converges with the server after the run that touched the
    // ledger settles: reserved 0, remaining 1 — useRatingRouteGate admits
    // the next Analyze visit instead of routing to the Paywall.
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(1, 0));
    expect(useAccessStore.getState().canonicalAccess?.canStartRating).toBe(
      true,
    );
    expect(useAccessStore.getState().canonicalAccess?.paywallRequired).toBe(
      false,
    );
  });

  it('[BROKEN] refreshAccess failure at unmount DISCARDS the known-good snapshot (canonicalAccess → null, status error)', async () => {
    clients = backendReturning(async () => {
      throw new Error('network down');
    });
    configureAccessStore(clients);
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: freeAccess(0),
    });
    const analysis = deferred<CaptureAnalysisOutcome>(
      runCaptureAnalysis as jest.Mock,
    );
    const renderer = await renderScreen('camera');
    await startCameraRun(renderer);
    await act(async () => renderer.unmount());
    await flush();
    await analysis.resolve(scoredOutcome(false));
    await flush();
    // The deferred unmount refresh runs once the analysis settles.
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    // OBSERVED on 4d812e1a: accessStore.refreshAccess's catch branch sets
    // `canonicalAccess: null` (accessStore.ts ~L208-212). A transient
    // network failure at the moment the player leaves the screen therefore
    // erases the snapshot the gate admitted them on; useRatingRouteGate
    // (RootNavigator ~L128-139) then replaces the next Analyze visit with the
    // Paywall (status 'error', canStartRating undefined) although the player
    // still holds a free rating. Settings keeps "the old value on screen
    // until the new one lands" only for the success path.
    // EXPECTED: a failed refresh keeps the last known snapshot (or at least
    // does not route a still-entitled player to the Paywall).
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toBeNull();
    expect(state.status).toBe('error');
    expect(state.error?.code).toBe('billing.backend_unavailable');
  });
});

// ─── S10 (extra): unmount mid-run must still commit the practice set ────────

describe('S10 (extra) — practice set commit for a run whose screen was left', () => {
  it('[FIXED] a scored analysis saved with a NEW sessionId gets its local_session row / session.create outbox entry / kv stamp even though the screen unmounted mid-run', async () => {
    const analysis = deferred<CaptureAnalysisOutcome>(
      runCaptureAnalysis as jest.Mock,
    );
    const renderer = await renderScreen('camera');
    await startCameraRun(renderer);
    const request = analysisRequest();
    // The plan chose a fresh set id and handed it to the analysis (the shot
    // row and its shot.sync outbox payload will carry this sessionId).
    expect(request.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(sqlMatching(/local_session/i)).toHaveLength(0);

    // Player taps X on "Measuring your swing…" / navigates away.
    await act(async () => renderer.unmount());
    await flush();
    await analysis.resolve(scoredOutcome(false));
    await flush();

    // The scored shot persisted inside runCaptureAnalysis references
    // request.sessionId, so the set is committed whenever a score exists —
    // whether or not the screen is still mounted. Without the session row
    // and its session.create outbox entry the shot.sync row would hit
    // `shot.session_not_found` (transient in sync.ts) on every drain.
    const sessionInserts = sqlMatching(/INSERT OR REPLACE INTO local_session/i);
    expect(sessionInserts).toHaveLength(1);
    expect(sessionInserts[0]!.params).toContain(request.sessionId);
    const outboxInserts = sqlMatching(/INSERT INTO outbox/i);
    expect(outboxInserts).toHaveLength(1);
    expect(outboxInserts[0]!.sql).toMatch(/'session\.create'/);
    expect(
      outboxInserts[0]!.params.some(
        param =>
          typeof param === 'string' &&
          param.includes(`"id":"${request.sessionId}"`),
      ),
    ).toBe(true);
    const stored = kv.get(practiceSetKeyForOwner(owner));
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!).sessionId).toBe(request.sessionId);
    // The outbox drain for the scored shot is still kicked off exactly once
    // and the unmounted screen never routes.
    expect(triggerOutboxSync).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
  });

  it('[HELD] control: the same run with the screen still mounted commits the set (session row + kv stamp)', async () => {
    const analysis = deferred<CaptureAnalysisOutcome>(
      runCaptureAnalysis as jest.Mock,
    );
    const renderer = await renderScreen('camera');
    await startCameraRun(renderer);
    const request = analysisRequest();
    await analysis.resolve(scoredOutcome(false));
    await flush();
    const sessionInserts = sqlMatching(/local_session/i);
    expect(sessionInserts.length).toBeGreaterThan(0);
    expect(
      sessionInserts.some(statement =>
        statement.params.includes(request.sessionId),
      ),
    ).toBe(true);
    const stored = kv.get(practiceSetKeyForOwner(owner));
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!).sessionId).toBe(request.sessionId);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'analysis-attack-1',
    });
  });

  it('[HELD] an abandoned run that settles LOW-CONFIDENCE commits nothing (no local_session row, no outbox row, no kv stamp, no drain kick)', async () => {
    const analysis = deferred<CaptureAnalysisOutcome>(
      runCaptureAnalysis as jest.Mock,
    );
    const renderer = await renderScreen('camera');
    await startCameraRun(renderer);
    const request = analysisRequest();
    expect(typeof request.sessionId).toBe('string');

    await act(async () => renderer.unmount());
    await flush();
    await analysis.resolve(lowConfidenceOutcome());
    await flush();

    expect(sqlMatching(/local_session/i)).toHaveLength(0);
    expect(sqlMatching(/INSERT INTO outbox/i)).toHaveLength(0);
    expect(kv.get(practiceSetKeyForOwner(owner))).toBeUndefined();
    expect(triggerOutboxSync).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
  });
});

// ─── S9: unmount while extractImportedPoseSequence is pending ───────────────

describe('S9 — unmount during imported pose extraction', () => {
  it('[BROKEN] native cancel() is NOT invoked for a pending extraction (operationActive is already false once the picker returned)', async () => {
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
    const extraction = deferred<unknown>(
      extractImportedPoseSequence as jest.Mock,
    );
    const renderer = await renderScreen('library');
    pressByLabel(renderer, 'Forehand drive');
    const selector = renderer.root.findByType(TargetSelector);
    await act(async () => {
      selector.props.onSkip();
    });
    await flush();
    expect(extractImportedPoseSequence).toHaveBeenCalledTimes(1);
    expect(renderedText(renderer)).toContain('Reading player movement');

    await act(async () => renderer.unmount());
    await flush();
    // OBSERVED on 4d812e1a: the unmount cleanup only cancels while
    // `operationActive.current` is true, which covers the picker/camera
    // phase and is reset in run()'s `finally` BEFORE scoreCapture starts the
    // extraction. The native Vision pass keeps running to completion for a
    // screen that no longer exists. EXPECTED (REVIEW.md lifecycle
    // cancellation): cancelCameraOperation() on unmount while the extraction
    // is pending.
    expect(cancelCameraOperation).not.toHaveBeenCalled();

    // The late result is discarded (abandoned) — no analysis is started.
    await extraction.resolve({
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///private/var/mobile/import.pose.json',
      frameCount: 126,
      sha256: 'ab'.repeat(32),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    });
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
  });

  it('[HELD] the working-screen X during extraction DOES call cancelCameraOperation once and pops the screen', async () => {
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
    deferred<unknown>(extractImportedPoseSequence as jest.Mock);
    const renderer = await renderScreen('library');
    pressByLabel(renderer, 'Forehand drive');
    const selector = renderer.root.findByType(TargetSelector);
    await act(async () => {
      selector.props.onSkip();
    });
    await flush();
    const [header] = renderer.root.findAll(
      n => typeof n.props.onClose === 'function',
    );
    if (!header) throw new Error('No working header with onClose');
    act(() => header.props.onClose());
    expect(cancelCameraOperation).toHaveBeenCalledTimes(1);
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
    // Unmount after the explicit close does not double-cancel.
    expect(cancelCameraOperation).toHaveBeenCalledTimes(1);
  });

  it('[HELD] unmount while the picker itself is still open cancels natively exactly once', async () => {
    deferred<CapturedClip>(importStrokeVideo as jest.Mock);
    const renderer = await renderScreen('library');
    await flush();
    expect(importStrokeVideo).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
    expect(cancelCameraOperation).toHaveBeenCalledTimes(1);
  });
});

// ─── Extra: rapid repeats ────────────────────────────────────────────────────

describe('extra — rapid repeated taps', () => {
  it('[HELD] hammering "Open automatic camera" 25× starts exactly one capture', async () => {
    deferred<CapturedClip>(captureStrokeVideo as jest.Mock);
    const renderer = await renderScreen('camera');
    pressByLabel(renderer, 'Forehand Drive');
    pressButton(renderer, 'Open automatic camera');
    // The screen has swapped to the working surface; re-press whatever
    // pressables remain (the close X) must not start a second capture.
    for (let i = 0; i < 25; i += 1) {
      if (hasButton(renderer, 'Open automatic camera')) {
        pressButton(renderer, 'Open automatic camera');
      }
    }
    await flush();
    expect(captureStrokeVideo).toHaveBeenCalledTimes(1);
  });
});
