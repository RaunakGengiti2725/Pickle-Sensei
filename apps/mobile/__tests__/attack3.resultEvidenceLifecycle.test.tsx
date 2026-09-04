/**
 * ADVERSARIAL PASS 3 — useStrokeResultEvidence / ResultScreen lifecycle.
 *
 * S2: hasShotSyncReceipt REJECTS while getShotOutboxStatus would resolve
 *     rejected/attempts=3 → the sync badge must read 'unknown' ("could not
 *     verify"), never the refusal count; the receipt error short-circuits
 *     (the outbox is not consulted after a failed receipt read).
 * S4: loadStrokeResultEvidence resolves 500 ms AFTER ResultScreen unmounted →
 *     nothing renders, no downstream loader fires, refreshConsistency is not
 *     called again by the late result.
 * Extras: analysisId swap while evidence is pending (stale evidence must not
 *     paint the new route), receipt true + outbox throwing, outbox rejecting,
 *     receipt resolving AFTER the analysis changed, and the exhausted /
 *     rejected copy with a unicode last_error.
 */
jest.mock('../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));

const mockLoadEvidence = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../src/components/strokeResultData', () => ({
  loadStrokeResultEvidence: (...args: unknown[]) => mockLoadEvidence(...args),
}));

const mockLoadSequence = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../src/review/poseSidecar', () => ({
  loadReviewPoseSequence: (...args: unknown[]) => mockLoadSequence(...args),
}));

const mockHasShotSyncReceipt = jest.fn<Promise<boolean>, unknown[]>();
const mockGetShotOutboxStatus = jest.fn<Promise<unknown>, unknown[]>();
const mockListRealAnalysisFacts = jest.fn<Promise<unknown[]>, unknown[]>();
jest.mock('../src/data/repository', () => ({
  hasShotSyncReceipt: (...args: unknown[]) => mockHasShotSyncReceipt(...args),
  getShotOutboxStatus: (...args: unknown[]) => mockGetShotOutboxStatus(...args),
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
}));

const mockGetApiSession = jest.fn<unknown, []>(() => null);
jest.mock('../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

const mockListCatalogDrills = jest.fn<Promise<unknown[]>, unknown[]>();
jest.mock('../src/training/api', () => ({
  createTrainingApi: () => ({ listCatalogDrills: mockListCatalogDrills }),
}));

const mockRefreshConsistency = jest.fn<Promise<void>, unknown[]>(
  async () => {},
);
const mockConsistencyState = {
  refresh: (...args: unknown[]) => mockRefreshConsistency(...args),
  daySecured: null as unknown,
  consumeDaySecured: jest.fn(() => null),
  recordDrillCompletion: jest.fn(async () => {}),
};
jest.mock('../src/consistency/store', () => {
  const useConsistencyStore = (
    selector: (state: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState);
  useConsistencyStore.getState = () => mockConsistencyState;
  return { useConsistencyStore };
});

const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
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

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import {
  ResultScreen,
  useStrokeResultEvidence,
  type SyncEvidenceState,
} from '../src/screens/ResultScreen';
import { ResultDetailsScreen } from '../src/screens/ResultDetailsScreen';
import type { StrokeResultEvidenceRecord } from '../src/components/strokeResultModel';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
} from '../src/training/store';
import type { TrainingApi } from '../src/training/types';
import { OUTBOX_MAX_ATTEMPTS } from '../src/data/sync';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
  };
}

function analysisFixture(id: string): ShotAnalysis {
  return {
    id,
    sessionId: 'set-1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases: [],
    measurements: [],
    checkpoints: [
      checkpoint('ready_position', 85, 'green', 'none'),
      checkpoint('contact_position', 48, 'red', 'late'),
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

function recordFixture(id: string): StrokeResultEvidenceRecord {
  return {
    id,
    captureId: `capture-${id}`,
    strokeIntent: {
      declaredStroke: 'forehand_drive',
      predictedStroke: null,
      resolutionBasis: 'declared',
      resolvedProfileId: 'FOREHAND_DRIVE',
      resolvedProfileVersion: 'technique-profile-v1',
      disagreement: null,
    },
    result: null,
    uncertainty: {
      analysisConfidence: 0.84,
      presentation: 'normal',
      limitingFactors: [],
    },
  };
}

const session = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'access-token',
  canonicalAppUserId: '00000000-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};

const sidecarRef = {
  schemaVersion: 1 as const,
  format: 'pickle.pose-sequence.v1' as const,
  uri: 'file:///captures/clip.pose.json',
  frameCount: 81,
  sha256: 'ab'.repeat(32),
  coordinateSystem: 'normalized_image_top_left' as const,
  poseModelVersion: 'apple-vision-bodypose-1',
};

function evidenceFor(id: string, withSidecar = false) {
  return {
    analysis: analysisFixture(id),
    record: recordFixture(id),
    clip: null,
    review: withSidecar
      ? { width: 1080, height: 1920, poseSequence: sidecarRef }
      : null,
    attempts: [],
  };
}

/** Minimal connected training store so the sync-evidence card renders. */
function connectTraining() {
  const api: jest.Mocked<TrainingApi> = {
    listSavedDrills: jest.fn(async () => []),
    getDrill: jest.fn(),
    saveDrill: jest.fn(),
    unsaveDrill: jest.fn(),
    getCurrentPlan: jest.fn(async () => null),
    createPlan: jest.fn(),
    completeDrill: jest.fn(),
    reassessPlan: jest.fn(),
  };
  configureTrainingStore(api);
  mockGetApiSession.mockReturnValue(session);
  return api;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

/** Bare hook probe: records every render's sync/evidence state. */
function Probe(props: {
  analysisId: string;
  onRender: (snapshot: {
    sync: SyncEvidenceState;
    analysisId: string | null;
    evidenceLoaded: boolean;
  }) => void;
}) {
  const { evidence, analysis, syncEvidence } = useStrokeResultEvidence(
    props.analysisId,
  );
  props.onRender({
    sync: syncEvidence,
    analysisId: analysis?.id ?? null,
    evidenceLoaded: evidence !== undefined,
  });
  return null;
}

async function renderProbe(analysisId: string) {
  const renders: Array<{
    sync: SyncEvidenceState;
    analysisId: string | null;
    evidenceLoaded: boolean;
  }> = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Probe analysisId={analysisId} onRender={s => renders.push(s)} />,
    );
  });
  mounted.push(renderer);
  return { renderer, renders };
}

async function renderScreen(Screen: React.ComponentType = ResultScreen) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Screen />);
  });
  mounted.push(renderer);
  return renderer;
}

let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  clearTrainingStoreConfiguration();
  mockRouteParams = { analysisId: 'analysis-1' };
  mockLoadEvidence.mockResolvedValue(evidenceFor('analysis-1'));
  mockLoadSequence.mockResolvedValue(null);
  mockHasShotSyncReceipt.mockResolvedValue(false);
  mockGetShotOutboxStatus.mockResolvedValue({ state: 'absent' });
  mockListRealAnalysisFacts.mockResolvedValue([]);
  mockGetApiSession.mockReturnValue(null);
  mockListCatalogDrills.mockResolvedValue([]);
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  consoleErrorSpy.mockRestore();
  jest.useRealTimers();
});

// ─── S2 — receipt read fails, outbox says rejected ×3 ───────────────────────

describe('S2 — hasShotSyncReceipt rejects while the outbox says rejected/attempts=3', () => {
  beforeEach(() => {
    mockHasShotSyncReceipt.mockRejectedValue(new Error('sqlite: disk I/O'));
    mockGetShotOutboxStatus.mockResolvedValue({
      state: 'rejected',
      attempts: 3,
      lastError: 'shot.invalid: HTTP 422',
    });
  });

  it('hook: the badge settles on unknown and the outbox is NOT consulted (receipt error short-circuits)', async () => {
    const { renders } = await renderProbe('analysis-1');
    await settle();
    const last = renders[renders.length - 1]!;
    expect(last.evidenceLoaded).toBe(true);
    expect(last.analysisId).toBe('analysis-1');
    expect(last.sync).toEqual({ kind: 'unknown' });
    expect(mockHasShotSyncReceipt).toHaveBeenCalledTimes(1);
    expect(mockGetShotOutboxStatus).not.toHaveBeenCalled();
    // The rejected/3 state must never have been painted at any render.
    expect(renders.some(r => r.sync.kind === 'rejected')).toBe(false);
    expect(renders.some(r => r.sync.kind === 'exhausted')).toBe(false);
    expect(renders.some(r => r.sync.kind === 'synced')).toBe(false);
  });

  it('ResultDetails: copy says the app could not verify; no refusal count, no plan CTA, no error surface', async () => {
    const api = connectTraining();
    const renderer = await renderScreen(ResultDetailsScreen);
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain('could not verify');
    expect(copy).not.toContain('refused this read');
    expect(copy).not.toContain('3 of');
    expect(copy).not.toContain('HTTP 422');
    expect(copy).not.toContain('sqlite');
    expect(copy).not.toContain('Build reviewed plan');
    expect(api.createPlan).not.toHaveBeenCalled();
    expect(mockGetShotOutboxStatus).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('inverse: receipt=false but the OUTBOX read rejects → unknown, not a crash', async () => {
    mockHasShotSyncReceipt.mockResolvedValue(false);
    mockGetShotOutboxStatus.mockRejectedValue(new Error('sqlite: locked'));
    const { renders } = await renderProbe('analysis-1');
    await settle();
    expect(renders[renders.length - 1]!.sync).toEqual({ kind: 'unknown' });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('receipt=true short-circuits to synced even when the outbox would throw', async () => {
    mockHasShotSyncReceipt.mockResolvedValue(true);
    mockGetShotOutboxStatus.mockRejectedValue(new Error('must not be read'));
    const { renders } = await renderProbe('analysis-1');
    await settle();
    expect(renders[renders.length - 1]!.sync).toEqual({ kind: 'synced' });
    expect(mockGetShotOutboxStatus).not.toHaveBeenCalled();
  });

  it('control: receipt=false + rejected/3 (no receipt error) DOES paint the refusal count with the unicode last_error verbatim', async () => {
    mockHasShotSyncReceipt.mockResolvedValue(false);
    mockGetShotOutboxStatus.mockResolvedValue({
      state: 'rejected',
      attempts: 3,
      lastError: 'shot.invalid: ¡Ünïcödé — 「拒否」 🥒',
    });
    connectTraining();
    const renderer = await renderScreen(ResultDetailsScreen);
    await settle();
    const copy = allText(renderer);
    expect(copy).toContain(
      `refused this read 3 of ${OUTBOX_MAX_ATTEMPTS} times`,
    );
    expect(copy).toContain('¡Ünïcödé — 「拒否」 🥒');
    expect(copy).not.toContain('could not verify');
  });

  it('attempts at/over the budget reads exhausted; attempts=NaN from a corrupt row reads as pending, never a throw', async () => {
    mockHasShotSyncReceipt.mockResolvedValue(false);
    mockGetShotOutboxStatus.mockResolvedValue({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS + 5,
      lastError: null,
    });
    const first = await renderProbe('analysis-1');
    await settle();
    expect(first.renders[first.renders.length - 1]!.sync).toEqual({
      kind: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS + 5,
      lastError: null,
    });

    mockGetShotOutboxStatus.mockResolvedValue({
      state: 'queued',
      attempts: Number.NaN,
      lastError: null,
    });
    const second = await renderProbe('analysis-1');
    await settle();
    expect(second.renders[second.renders.length - 1]!.sync).toEqual({
      kind: 'pending',
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('a receipt that settles AFTER the analysis changed never paints on the new analysis', async () => {
    const first = deferred<boolean>();
    mockHasShotSyncReceipt.mockImplementation((_db, id) =>
      id === 'analysis-1' ? first.promise : Promise.resolve(false),
    );
    mockGetShotOutboxStatus.mockResolvedValue({
      state: 'rejected',
      attempts: 3,
      lastError: 'x',
    });
    mockLoadEvidence.mockImplementation((_db, id) =>
      Promise.resolve(evidenceFor(String(id))),
    );
    const { renderer, renders } = await renderProbe('analysis-1');
    await settle();
    expect(renders[renders.length - 1]!.sync).toEqual({ kind: 'checking' });

    await act(async () => {
      renderer.update(
        <Probe analysisId="analysis-2" onRender={s => renders.push(s)} />,
      );
    });
    await settle();
    expect(renders[renders.length - 1]!.analysisId).toBe('analysis-2');
    expect(renders[renders.length - 1]!.sync).toEqual({
      kind: 'rejected',
      attempts: 3,
      lastError: 'x',
    });

    // The stale analysis-1 receipt now says "synced": must not leak in.
    await act(async () => {
      first.resolve(true);
    });
    await settle();
    expect(renders[renders.length - 1]!.sync).toEqual({
      kind: 'rejected',
      attempts: 3,
      lastError: 'x',
    });
    expect(renders.some(r => r.sync.kind === 'synced')).toBe(false);
  });
});

// ─── S4 — evidence resolves 500 ms after unmount ────────────────────────────

describe('S4 — loadStrokeResultEvidence resolves 500 ms after ResultScreen unmounted', () => {
  it('no render, no downstream loader, no extra refreshConsistency after the late result', async () => {
    const late = deferred<unknown>();
    mockLoadEvidence.mockReturnValue(late.promise);
    // Trap: any code path that READS the resolved evidence after unmount
    // trips this getter.
    // (`then` is read by Promise resolution itself and is not a consumer.)
    let evidenceReads = 0;
    const trapped = new Proxy(evidenceFor('analysis-1', true), {
      get(target, prop, receiver) {
        if (prop !== 'then') evidenceReads += 1;
        return Reflect.get(target, prop, receiver);
      },
    });

    const renderer = await renderScreen();
    await settle();
    expect(renderer.toJSON()).not.toBeNull();
    expect(mockLoadEvidence).toHaveBeenCalledTimes(1);
    // Mount-time streak refresh (by design — the analysis was just saved).
    const refreshCallsAtMount = mockRefreshConsistency.mock.calls.length;
    expect(refreshCallsAtMount).toBe(1);

    await act(async () => {
      renderer.unmount();
    });
    mounted.splice(mounted.indexOf(renderer), 1);

    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    await act(async () => {
      late.resolve(trapped);
    });
    await settle();

    expect(renderer.toJSON()).toBeNull();
    expect(evidenceReads).toBe(0);
    expect(mockLoadSequence).not.toHaveBeenCalled();
    expect(mockHasShotSyncReceipt).not.toHaveBeenCalled();
    expect(mockGetShotOutboxStatus).not.toHaveBeenCalled();
    expect(mockListRealAnalysisFacts).not.toHaveBeenCalled();
    expect(mockListCatalogDrills).not.toHaveBeenCalled();
    expect(mockRefreshConsistency).toHaveBeenCalledTimes(refreshCallsAtMount);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('a late REJECTION after unmount is equally inert', async () => {
    const late = deferred<unknown>();
    mockLoadEvidence.mockReturnValue(late.promise);
    const renderer = await renderScreen();
    await act(async () => {
      renderer.unmount();
    });
    mounted.splice(mounted.indexOf(renderer), 1);
    await act(async () => {
      jest.advanceTimersByTime(500);
      late.reject(new Error('sqlite gone'));
    });
    await settle();
    expect(renderer.toJSON()).toBeNull();
    expect(mockHasShotSyncReceipt).not.toHaveBeenCalled();
    expect(mockRefreshConsistency).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('route swap while evidence is pending: stale analysis-1 evidence never paints the analysis-2 screen', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mockLoadEvidence.mockImplementation((_db, id) =>
      id === 'analysis-1' ? first.promise : second.promise,
    );
    const renderer = await renderScreen();
    await settle();

    mockRouteParams = { analysisId: 'analysis-2' };
    await act(async () => {
      renderer.update(<ResultScreen />);
    });
    await settle();
    expect(mockLoadEvidence).toHaveBeenCalledTimes(2);
    expect(mockLoadEvidence.mock.calls[1]![1]).toBe('analysis-2');

    // Stale evidence settles FIRST, for a different stroke entirely.
    const stale = {
      ...evidenceFor('analysis-1'),
      analysis: {
        ...analysisFixture('analysis-1'),
        shotType: 'backhand_drive' as const,
      },
    };
    await act(async () => {
      first.resolve(stale);
    });
    await settle();
    // Still loading: the stale result must not have painted anything.
    expect(mockHasShotSyncReceipt).not.toHaveBeenCalled();
    expect(allText(renderer)).not.toMatch(/backhand/i);

    await act(async () => {
      second.resolve(evidenceFor('analysis-2'));
    });
    await settle();
    expect(mockHasShotSyncReceipt).toHaveBeenCalledTimes(1);
    expect(mockHasShotSyncReceipt.mock.calls[0]![1]).toBe('analysis-2');
    expect(allText(renderer)).toMatch(/forehand drive/i);
    expect(allText(renderer)).not.toMatch(/backhand/i);
    // One streak refresh per analysisId — not per settled promise.
    expect(mockRefreshConsistency).toHaveBeenCalledTimes(2);
  });

  it('20 rapid mount/unmount cycles with every evidence promise resolving late leave zero downstream calls', async () => {
    const lates: Array<Deferred<unknown>> = [];
    mockLoadEvidence.mockImplementation(() => {
      const d = deferred<unknown>();
      lates.push(d);
      return d.promise;
    });
    for (let i = 0; i < 20; i += 1) {
      const renderer = await renderScreen();
      await act(async () => {
        renderer.unmount();
      });
      mounted.splice(mounted.indexOf(renderer), 1);
    }
    expect(lates).toHaveLength(20);
    await act(async () => {
      jest.advanceTimersByTime(500);
      for (const d of lates) d.resolve(evidenceFor('analysis-1', true));
    });
    await settle();
    expect(mockLoadSequence).not.toHaveBeenCalled();
    expect(mockHasShotSyncReceipt).not.toHaveBeenCalled();
    expect(mockListRealAnalysisFacts).not.toHaveBeenCalled();
    expect(mockRefreshConsistency).toHaveBeenCalledTimes(20);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
