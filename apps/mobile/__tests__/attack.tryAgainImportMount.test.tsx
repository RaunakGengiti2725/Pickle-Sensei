/**
 * Adversarial pass 3 — TRY AGAIN armed on RESULT DETAILS, then the next
 * Analyze mount is NOT the guided camera.
 *
 * The handoff must be a continuation of one tap. If the player arms it from
 * the details route and the next Analyze mount is a library import
 * (`route.params.source = 'library'`, the app's import entry — the Analyze
 * route accepts only 'camera' | 'library'), the import must DROP the handoff
 * so a later camera mount starts clean and consumes null rather than the
 * abandoned declaration. Both real screens are mounted in ONE module registry
 * so the module-level handoff register is shared exactly as in the app.
 */
jest.mock('../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));

const mockLoadEvidence = jest.fn();
jest.mock('../src/components/strokeResultData', () => ({
  loadStrokeResultEvidence: (...args: unknown[]) => mockLoadEvidence(...args),
}));

const mockLoadSequence = jest.fn();
jest.mock('../src/review/poseSidecar', () => ({
  loadReviewPoseSequence: (...args: unknown[]) => mockLoadSequence(...args),
}));

const mockHasShotSyncReceipt = jest.fn();
const mockListRealAnalysisFacts = jest.fn();
const mockGetShotOutboxStatus = jest.fn();
jest.mock('../src/data/repository', () => ({
  hasShotSyncReceipt: (...args: unknown[]) => mockHasShotSyncReceipt(...args),
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
  getShotOutboxStatus: (...args: unknown[]) => mockGetShotOutboxStatus(...args),
  savePendingCapture: jest.fn(() => Promise.resolve()),
  setCaptureTargetSeed: jest.fn(() => Promise.resolve()),
  setDeclaredStroke: jest.fn(() => Promise.resolve()),
  getKv: jest.fn(() => Promise.resolve(null)),
  setKv: jest.fn(() => Promise.resolve()),
}));

jest.mock('../src/account/apiSession', () => ({
  getApiSession: jest.fn(() => null),
}));

const mockListCatalogDrills = jest.fn();
jest.mock('../src/training/api', () => ({
  createTrainingApi: () => ({ listCatalogDrills: mockListCatalogDrills }),
}));

const mockConsistencyState = {
  refresh: jest.fn(async () => {}),
  daySecured: null as unknown,
  consumeDaySecured: jest.fn(() => null),
};
jest.mock('../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (state: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState),
}));

jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));

const mockImportStrokeVideo = jest.fn();
const mockCaptureStrokeVideo = jest.fn();
jest.mock('../src/camera/capture', () => ({
  subscribeToCameraEvents: () => () => {},
  captureStrokeVideo: (...args: unknown[]) => mockCaptureStrokeVideo(...args),
  importStrokeVideo: (...args: unknown[]) => mockImportStrokeVideo(...args),
  cancelCameraOperation: jest.fn(),
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

import React from 'react';
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
import { stabilitySlo } from '../src/analysis/stabilityTelemetry';
import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import { ResultDetailsScreen } from '../src/screens/ResultDetailsScreen';
import {
  TRY_AGAIN_HANDOFF_TTL_MS,
  armTryAgain,
  clearTryAgainHandoff,
  consumeTryAgainHandoff,
  peekTryAgainHandoff,
  type TryAgainHandoff,
} from '../src/screens/tryAgainHandoff';
import type { StrokeResultEvidenceRecord } from '../src/components/strokeResultModel';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
} from '../src/training/store';
import type { TrainingApi } from '../src/training/types';

// ─── Fixtures (same shapes as the result details suite) ─────────────────────

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

const scoredAnalysis: ShotAnalysis = {
  id: 'analysis-1',
  sessionId: 'set-7',
  shotType: 'backhand_drive',
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
    checkpoint('paddle_path', 61, 'red', 'low'),
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
    shotConfigVersion: 'backhand_drive@1',
  },
  source: 'real',
};

const declaredRecord: StrokeResultEvidenceRecord = {
  id: 'analysis-1',
  captureId: 'capture-1',
  strokeIntent: {
    declaredStroke: 'backhand_drive',
    predictedStroke: null,
    resolutionBasis: 'declared',
    resolvedProfileId: 'BACKHAND_DRIVE',
    resolvedProfileVersion: 'technique-profile-v1',
    disagreement: null,
  },
  result: null,
  uncertainty: {
    analysisConfidence: 0.84,
    presentation: 'normal',
    limitingFactors: [
      'paddle_track_unavailable',
      'ball_track_unavailable',
      'court_geometry_unavailable',
    ],
  },
};

const EXPECTED_HANDOFF: TryAgainHandoff = {
  source: 'camera',
  declaredStroke: 'backhand_drive',
  declaredCanonical: 'BACKHAND_DRIVE',
  auto: false,
  sessionId: 'set-7',
};

// ─── Harness ────────────────────────────────────────────────────────────────

const mounted: ReactTestRenderer[] = [];

async function settle() {
  for (let i = 0; i < 4; i += 1) {
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
  await settle();
  mounted.push(renderer);
  return renderer;
}

async function unmountAll() {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
}

async function press(
  renderer: ReactTestRenderer,
  predicate: (props: Record<string, unknown>) => boolean,
) {
  const [node] = renderer.root.findAll(
    candidate =>
      typeof candidate.props.onPress === 'function' &&
      predicate(candidate.props),
  );
  if (!node) throw new Error('no matching pressable');
  await act(async () => {
    node.props.onPress();
  });
  await settle();
}

/** Arms the handoff through the REAL ResultDetailsScreen: the "Capture a new
 * read" button shown when the outbox has exhausted its sync budget routes
 * through the sheet's onTryAgain, which is the details route's re-arm. */
async function armFromResultDetails() {
  mockRouteParams = { analysisId: 'analysis-1' };
  const details = await mount(<ResultDetailsScreen />);
  await press(details, props => props.label === 'Capture a new read');
  expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze', {
    source: 'camera',
  });
  expect(peekTryAgainHandoff()).toEqual(EXPECTED_HANDOFF);
  await unmountAll();
}

function kinds(): string[] {
  return stabilitySlo.events().map(event => event.kind);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
  jest.clearAllMocks();
  stabilitySlo.reset();
  clearTryAgainHandoff();
  clearTrainingStoreConfiguration();
  // A configured training API with no plan: the training section is
  // 'ready' and therefore reports the outbox's exhausted sync state with the
  // "Capture a new read" re-arm CTA.
  const unreachable = () => Promise.reject(new Error('not exercised'));
  const trainingApi: TrainingApi = {
    listSavedDrills: () => Promise.resolve([]),
    getDrill: unreachable,
    saveDrill: unreachable,
    unsaveDrill: unreachable,
    getCurrentPlan: () => Promise.resolve(null),
    createPlan: unreachable,
    completeDrill: unreachable,
    reassessPlan: unreachable,
  };
  configureTrainingStore(trainingApi);
  mockLoadEvidence.mockResolvedValue({
    analysis: scoredAnalysis,
    record: declaredRecord,
    clip: null,
    review: null,
    attempts: [
      {
        analysisId: 'analysis-1',
        capturedAtIso: '2026-09-01T10:00:00.000Z',
        sessionId: 'set-7',
      },
    ],
  });
  mockLoadSequence.mockResolvedValue(null);
  mockHasShotSyncReceipt.mockResolvedValue(false);
  mockGetShotOutboxStatus.mockResolvedValue({
    state: 'exhausted',
    attempts: 5,
    lastError: 'server refused',
  });
  mockListRealAnalysisFacts.mockResolvedValue([]);
  mockListCatalogDrills.mockResolvedValue([]);
  // The import picker is cancelled mid-flight, the way a user backs out of
  // the Photos sheet: the screen treats a "cancel" message as abandonment.
  mockImportStrokeVideo.mockRejectedValue(new Error('Import cancelled'));
  mockCaptureStrokeVideo.mockReturnValue(new Promise(() => {}));
});

afterEach(async () => {
  await unmountAll();
  clearTryAgainHandoff();
  clearTrainingStoreConfiguration();
  jest.useRealTimers();
});

describe('attack — TRY AGAIN armed on Result Details, next Analyze mount is an import', () => {
  it('ResultDetails arms the declared handoff, a library-source Analyze mount drops it, and the later camera mount consumes null', async () => {
    await armFromResultDetails();

    // The armed handoff is inside its TTL when the import mounts.
    jest.setSystemTime(Date.now() + 1_000);
    mockRouteParams = { source: 'library' };
    await mount(<AnalyzeScreen />);
    // Cleared synchronously by the mount's lazy state initialiser — before
    // the import's auto-launch timer (160 ms) has even fired.
    expect(peekTryAgainHandoff()).toBeNull();
    // Dropping is not a re-arm and not a failure: no TRY AGAIN telemetry.
    expect(kinds()).toEqual([]);

    // Let the import auto-launch and be cancelled by the user.
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    await settle();
    expect(mockImportStrokeVideo).toHaveBeenCalledTimes(1);
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    await unmountAll();

    // The next guided camera mount starts clean: no declaration is seeded.
    mockRouteParams = { source: 'camera' };
    await mount(<AnalyzeScreen />);
    expect(peekTryAgainHandoff()).toBeNull();
    expect(kinds()).toEqual([]);
    // The camera did not auto-launch: an un-armed guided capture waits for
    // the player to declare and start.
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(mockCaptureStrokeVideo).not.toHaveBeenCalled();
    expect(consumeTryAgainHandoff()).toBeNull();
  });

  it('an undefined route param (deep link without params) counts as camera and CONSUMES the handoff', async () => {
    await armFromResultDetails();
    mockRouteParams = undefined as unknown as Record<string, unknown>;
    await mount(<AnalyzeScreen />);
    expect(peekTryAgainHandoff()).toBeNull();
    expect(kinds()).toEqual(['try_again_rearmed']);
  });

  it('an unknown source value is not the camera: it drops the handoff rather than seeding it', async () => {
    await armFromResultDetails();
    mockRouteParams = { source: 'import' };
    await mount(<AnalyzeScreen />);
    expect(peekTryAgainHandoff()).toBeNull();
    expect(kinds()).toEqual([]);
    await unmountAll();

    mockRouteParams = { source: 'camera' };
    await mount(<AnalyzeScreen />);
    expect(kinds()).toEqual([]);
    expect(consumeTryAgainHandoff()).toBeNull();
  });

  it('a camera mount after the TTL expired reports the failed re-arm instead of seeding stale intent', async () => {
    await armFromResultDetails();
    jest.setSystemTime(Date.now() + TRY_AGAIN_HANDOFF_TTL_MS + 1);
    mockRouteParams = { source: 'camera' };
    await mount(<AnalyzeScreen />);
    expect(peekTryAgainHandoff()).toBeNull();
    expect(stabilitySlo.events()).toEqual([
      expect.objectContaining({
        kind: 'try_again_failed',
        reason: 'handoff_expired',
      }),
    ]);
  });

  it('two rapid camera mounts (double navigation) re-arm exactly once — the second sees null', async () => {
    await armFromResultDetails();
    mockRouteParams = { source: 'camera' };
    await mount(<AnalyzeScreen />);
    await mount(<AnalyzeScreen />);
    expect(kinds()).toEqual(['try_again_rearmed']);
    expect(peekTryAgainHandoff()).toBeNull();
  });

  it('re-arming directly with a different declaration then importing still drops everything', async () => {
    await armFromResultDetails();
    armTryAgain({
      source: 'camera',
      declaredStroke: 'forehand_drive',
      declaredCanonical: 'FOREHAND_DRIVE',
      auto: false,
      sessionId: null,
    });
    mockRouteParams = { source: 'library' };
    await mount(<AnalyzeScreen />);
    expect(peekTryAgainHandoff()).toBeNull();
    expect(kinds()).toEqual([]);
  });
});
