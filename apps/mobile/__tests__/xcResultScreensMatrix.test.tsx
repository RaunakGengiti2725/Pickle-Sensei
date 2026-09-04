/**
 * xc-3 · ResultScreen + ResultDetailsScreen render-state a11y/copy matrix.
 *
 * Every reachable state of the Result guide and the Full-breakdown route is
 * mounted with the real components (only the three stores, the sidecar
 * reader, the API session and navigation are mocked), then audited with
 * `auditRenderedTree`: text rows + contrast, controls + hit targets + names,
 * roles/live regions/alerts/modals, forbidden/unsupported/machine-token
 * lexicon, copy hygiene. Every state is written to
 * artifacts/xc-screen-ux-a11y-i18n-3/result-state-matrix.json.
 *
 * States covered:
 *   Result: loading · missing · abstained (inline sheet) · scored SCORE /
 *   PROBLEM / DRILLS / NEXT · scored without replay evidence (fix cards) ·
 *   clean stroke (skipped pages) · legacy row (analysis, no record) ·
 *   sync checking / synced / pending / unknown / rejected / exhausted
 *   (with and without lastError, incl. machine-token lastError) · training
 *   idle-loading / unconfigured / error / create-plan / plan-for-this-read /
 *   reassess / completed(delta) / completed(null delta) / mutation error ·
 *   catalog error on DRILLS · unusual analysisId / shotType.
 *   ResultDetails: loading · missing · ready (scored, synced) · back ·
 *   attempt chip repoints the guide · try again / done / form review.
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
const mockGetShotOutboxStatus = jest.fn();
const mockListRealAnalysisFacts = jest.fn();
jest.mock('../src/data/repository', () => ({
  hasShotSyncReceipt: (...args: unknown[]) => mockHasShotSyncReceipt(...args),
  getShotOutboxStatus: (...args: unknown[]) => mockGetShotOutboxStatus(...args),
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
}));

const mockGetApiSession = jest.fn();
jest.mock('../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
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

const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  popToTop: jest.fn(),
  popTo: jest.fn(),
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
    SafeAreaView: (props: {
      children?: React.ReactNode;
      testID?: string;
      style?: unknown;
    }) =>
      React.createElement(
        View,
        { testID: props.testID, style: props.style },
        props.children,
      ),
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
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import { ResultScreen } from '../src/screens/ResultScreen';
import { ResultDetailsScreen } from '../src/screens/ResultDetailsScreen';
import { clearTryAgainHandoff } from '../src/screens/tryAgainHandoff';
import type {
  ReviewJoint,
  ReviewPoseFrame,
  ReviewPoseSequence,
} from '../src/review/formReviewModel';
import type { StrokeResultEvidenceRecord } from '../src/components/strokeResultModel';
import type { CatalogDrill } from '../src/training/api';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../src/training/store';
import {
  TrainingError,
  type TrainingApi,
  type TrainingPlan,
} from '../src/training/types';
import { OUTBOX_MAX_ATTEMPTS } from '../src/data/sync';
import {
  auditRenderedTree,
  summarize,
  writeArtifact,
  appendLog,
  type StateAudit,
} from '../xc-audit/auditKit';
import { color } from '../src/design/tokens';

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

const scoredAnalysis: ShotAnalysis = {
  id: 'analysis-1',
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

const cleanAnalysis: ShotAnalysis = {
  ...scoredAnalysis,
  id: 'analysis-clean',
  overallScore: 9.4,
  checkpoints: scoredAnalysis.checkpoints.map(c =>
    c.score === null || !c.applicable
      ? c
      : { ...c, score: 90, band: 'green', direction: 'none', severity: 0.1 },
  ),
  priorityFix: null,
};

const declaredRecord: StrokeResultEvidenceRecord = {
  id: 'analysis-1',
  captureId: 'capture-1',
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
    limitingFactors: [
      'paddle_track_unavailable',
      'ball_track_unavailable',
      'court_geometry_unavailable',
    ],
  },
};

const abstainedRecord: StrokeResultEvidenceRecord = {
  id: 'analysis-2',
  captureId: 'capture-2',
  strokeIntent: {
    declaredStroke: null,
    predictedStroke: null,
    resolutionBasis: 'abstained',
    resolvedProfileId: null,
    resolvedProfileVersion: null,
    disagreement: null,
  },
  result: null,
  uncertainty: {
    analysisConfidence: 0,
    presentation: 'abstain',
    limitingFactors: ['analysis_confidence_below_threshold'],
  },
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

function frameAt(
  timestampMs: number,
  joints: Partial<Record<ReviewJoint, { x: number; y: number }>>,
): ReviewPoseFrame {
  return {
    timestampMs,
    confidence: 0.9,
    landmarks: Object.entries(joints).map(([name, point]) => ({
      name,
      x: point.x,
      y: point.y,
      visibility: 0.95,
    })),
  };
}

function fullBodySequence(): ReviewPoseSequence {
  const frames: ReviewPoseFrame[] = [];
  for (let t = 0; t <= 3200; t += 40) {
    const sweep = t / 3200;
    frames.push(
      frameAt(t, {
        head: { x: 0.5, y: 0.18 },
        left_shoulder: { x: 0.45, y: 0.3 },
        right_shoulder: { x: 0.55, y: 0.3 },
        left_elbow: { x: 0.4, y: 0.42 },
        right_elbow: { x: 0.62, y: 0.42 },
        left_wrist: { x: 0.38, y: 0.52 },
        right_wrist: { x: 0.3 + 0.4 * sweep, y: 0.5 },
        left_hip: { x: 0.46, y: 0.55 },
        right_hip: { x: 0.54, y: 0.55 },
        left_knee: { x: 0.46, y: 0.72 },
        right_knee: { x: 0.54, y: 0.72 },
        left_ankle: { x: 0.45, y: 0.9 },
        right_ankle: { x: 0.55, y: 0.9 },
      }),
    );
  }
  return { frames, video: { width: 1080, height: 1920, fps: 30 } };
}

function scoredEvidence(overrides: Record<string, unknown> = {}) {
  return {
    analysis: scoredAnalysis,
    record: declaredRecord,
    clip: {
      uri: 'file:///captures/clip.mov',
      durationMs: 3400,
      posterUri: 'file:///captures/clip.poster.jpg',
    },
    review: { width: 1080, height: 1920, poseSequence: sidecarRef },
    attempts: [
      {
        analysisId: 'analysis-1',
        capturedAtIso: '2026-09-01T10:00:00.000Z',
        sessionId: 'set-1',
      },
      {
        analysisId: 'analysis-0',
        capturedAtIso: '2026-09-01T09:50:00.000Z',
        sessionId: 'set-1',
      },
    ],
    ...overrides,
  };
}

function abstainedEvidence() {
  return {
    analysis: null,
    record: abstainedRecord,
    clip: { uri: 'file:///captures/clip-2.mov', durationMs: 3800 },
    review: { width: 1080, height: 1920, poseSequence: null },
    attempts: [],
  };
}

function drill(slug: string, families: string[]): CatalogDrill {
  return {
    id: `id-${slug}`,
    slug,
    title: slug
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' '),
    description: `Description for ${slug}.`,
    coachName: 'Pickle Sensei Training Library',
    equipment: ['paddle', 'balls'],
    difficultyMin: null,
    difficultyMax: null,
    families,
    validationState: 'UNVALIDATED',
    saved: false,
  };
}

const CATALOG: CatalogDrill[] = [
  drill('drive-and-recover', ['drive']),
  drill('crosscourt-drive-rally', ['drive', 'volley']),
  drill('shadow-swing-ladder', ['global']),
];

const session = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'access-token',
  canonicalAppUserId: '00000000-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};

function plan(overrides: Partial<TrainingPlan> = {}): TrainingPlan {
  const item = (
    id: string,
    position: number,
    kind: 'warmup' | 'targeted',
    completed: boolean,
  ) => ({
    id,
    position,
    kind,
    drill: {
      slug: `drill-${id}`,
      title: `Drill ${id}`,
      description: 'A reviewed drill.',
      coachName: 'Coach',
      equipment: [],
      saved: false,
    },
    cueText: 'Meet the ball in front.',
    targetSets: 3,
    targetRepetitionsPerSet: 10,
    targetDurationSeconds: null,
    restSeconds: 30,
    completion: completed
      ? {
          id: `c-${id}`,
          completedAt: '2026-09-02T10:00:00.000Z',
          actualRepetitions: 10,
          actualDurationSeconds: null,
          qualifiesForStreak: true,
        }
      : null,
  });
  return {
    id: 'plan-1',
    status: 'active',
    algorithmVersion: 'plan-v1',
    sourceShotId: 'analysis-1',
    shotType: 'forehand_drive',
    priorityCheckpoint: 'contact_position',
    priorityDirection: 'late',
    baselineScore: 7.1,
    baselineCheckpointScore: 48,
    reassessmentShotId: null,
    scoreDelta: null,
    createdAt: '2026-08-30T10:00:00.000Z',
    completedAt: null,
    items: [
      item('w', 1, 'warmup', false),
      item('t1', 2, 'targeted', false),
      item('t2', 3, 'targeted', false),
    ],
    ...overrides,
  };
}

function trainingApi(overrides: Partial<TrainingApi> = {}): TrainingApi {
  return {
    listSavedDrills: jest.fn(async () => []),
    getDrill: jest.fn(async slug => ({
      id: slug,
      slug,
      title: slug,
      description: '',
      coachName: 'Coach',
      equipment: [],
      difficultyMin: null,
      difficultyMax: null,
      saved: false,
      mappings: [],
      instructionalMedia: [],
    })),
    saveDrill: jest.fn(async () => {}),
    unsaveDrill: jest.fn(async () => {}),
    getCurrentPlan: jest.fn(async () => null),
    createPlan: jest.fn(async () => plan()),
    completeDrill: jest.fn(async () => ({
      id: 'c',
      completedAt: '2026-09-02T10:00:00.000Z',
      actualRepetitions: null,
      actualDurationSeconds: null,
      qualifiesForStreak: false,
    })),
    reassessPlan: jest.fn(async () => plan()),
    ...overrides,
  };
}

// ─── Harness ────────────────────────────────────────────────────────────────

const matrix: StateAudit[] = [];
const LOG = 'result-state-matrix.log';
const mounted: ReactTestRenderer[] = [];

function record(
  renderer: ReactTestRenderer,
  screen: 'ResultScreen' | 'ResultDetailsScreen',
  state: string,
  input: unknown,
  extra: Partial<StateAudit> = {},
): StateAudit {
  const audit = auditRenderedTree(renderer, {
    screen,
    state,
    input,
    screenBackground: screen === 'ResultScreen' ? color.ink : color.surface,
    // Eyebrow labels: "1 OF 4 · SCORE", stroke names, technique tokens.
    allowTokens: [/^[A-Z]{1,3}$/],
  });
  Object.assign(audit, extra);
  matrix.push(audit);
  appendLog(LOG, JSON.stringify(summarize(audit)));
  return audit;
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderResult(params: Record<string, unknown> = {}) {
  mockRouteParams = { analysisId: 'analysis-1', ...params };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ResultScreen />);
  });
  await settle();
  mounted.push(renderer);
  return renderer;
}

async function renderDetails(params: Record<string, unknown> = {}) {
  mockRouteParams = { analysisId: 'analysis-1', ...params };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ResultDetailsScreen />);
  });
  await settle();
  mounted.push(renderer);
  return renderer;
}

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll(n => String(n.type) === 'Text')
    .map(n =>
      (n.children ?? []).map(c => (typeof c === 'string' ? c : '')).join(''),
    )
    .join('\n');
}

function hostByTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props['testID'] === testID,
  );
}

function pressableByTestId(renderer: ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props['testID'] === testID &&
      typeof candidate.props['onPress'] === 'function',
  );
  if (!node) throw new Error(`no pressable with testID ${testID}`);
  return node;
}

async function press(renderer: ReactTestRenderer, testID: string) {
  const node = pressableByTestId(renderer, testID);
  await act(async () => {
    node.props['onPress']();
  });
  await settle();
}

function pressText(renderer: ReactTestRenderer, text: string): void {
  const textNode = renderer.root.findAll(
    n =>
      String(n.type) === 'Text' &&
      Array.isArray(n.children) &&
      n.children.some(c => c === text),
  )[0];
  if (!textNode) throw new Error(`text not found: ${text}`);
  let cursor = textNode.parent;
  while (cursor && typeof cursor.props['onPress'] !== 'function') {
    cursor = cursor.parent;
  }
  if (!cursor) throw new Error(`no pressable ancestor for: ${text}`);
  cursor.props['onPress']();
}

function setOutbox(
  status:
    | { state: 'absent' }
    | { state: 'queued' }
    | {
        state: 'rejected' | 'exhausted';
        attempts: number;
        lastError: string | null;
      },
) {
  mockHasShotSyncReceipt.mockResolvedValue(false);
  mockGetShotOutboxStatus.mockResolvedValue(status);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  clearTryAgainHandoff();
  clearTrainingStoreConfiguration();
  mockRouteParams = { analysisId: 'analysis-1' };
  mockLoadEvidence.mockResolvedValue(scoredEvidence());
  mockLoadSequence.mockResolvedValue(fullBodySequence());
  mockHasShotSyncReceipt.mockResolvedValue(false);
  mockGetShotOutboxStatus.mockResolvedValue({ state: 'absent' });
  mockListRealAnalysisFacts.mockResolvedValue([]);
  mockGetApiSession.mockReturnValue(session);
  mockListCatalogDrills.mockResolvedValue(CATALOG);
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  jest.useRealTimers();
});

afterAll(() => {
  const file = writeArtifact('result-state-matrix.json', {
    generatedAtIso: new Date().toISOString(),
    screens: ['ResultScreen', 'ResultDetailsScreen'],
    states: matrix.length,
    summary: matrix.map(summarize),
    states_detail: matrix,
  });
  appendLog(LOG, `wrote ${file}`);
});

const hardLexicon = (a: StateAudit) =>
  a.lexicon.filter(
    h =>
      h.rule !== 'cloud_video_feature' &&
      // Provenance trace deliberately prints version tokens; audited separately.
      !/^Scored with /.test(h.text),
  );

// ─── ResultScreen ───────────────────────────────────────────────────────────

describe('xc-3 · ResultScreen render-state matrix', () => {
  it('loading: header + analyzing caption, Close reachable, loading announced', async () => {
    mockLoadEvidence.mockReturnValue(new Promise(() => {}));
    const renderer = await renderResult();
    const audit = record(renderer, 'ResultScreen', 'loading', {});
    expect(allText(renderer)).toContain('Opening your result…');
    expect(audit.controls.some(c => c.name === 'Close')).toBe(true);
    expect(hardLexicon(audit)).toEqual([]);
    expect(
      audit.controls.filter(c => c.issues.includes('unnamed_control')),
    ).toEqual([]);
  });

  it('missing: honest empty state with a way back', async () => {
    mockLoadEvidence.mockResolvedValue({
      analysis: null,
      record: null,
      clip: null,
      review: null,
      attempts: [],
    });
    const renderer = await renderResult();
    const audit = record(renderer, 'ResultScreen', 'missing', {});
    expect(allText(renderer)).toContain('Result missing');
    expect(allText(renderer)).toContain('no longer on this device');
    await act(async () => pressText(renderer, 'Go back'));
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    expect(hardLexicon(audit)).toEqual([]);
  });

  it('missing (load rejected): the same honest state, nothing repaired', async () => {
    mockLoadEvidence.mockRejectedValue(new Error('sqlite: disk I/O error'));
    const renderer = await renderResult();
    const audit = record(renderer, 'ResultScreen', 'missing.load_rejected', {
      error: 'sqlite: disk I/O error',
    });
    expect(allText(renderer)).toContain('Result missing');
    expect(allText(renderer)).not.toContain('disk I/O');
    expect(hardLexicon(audit)).toEqual([]);
  });

  it('scored: SCORE → PROBLEM → DRILLS → NEXT, every page audited; progressbar semantics', async () => {
    const renderer = await renderResult();
    const steps = ['score', 'problem', 'drills', 'next'] as const;
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i]!;
      expect(hostByTestId(renderer, `result-guide-step-${step}`)).toHaveLength(
        1,
      );
      const audit = record(renderer, 'ResultScreen', `scored.${step}`, {
        analysisId: 'analysis-1',
        step: i + 1,
      });
      // Progressbar exposes value + label on every page.
      const bar = audit.valued.find(r => r.role === 'progressbar');
      expect(bar).toBeDefined();
      expect(bar?.value).toEqual({ min: 1, max: 4, now: i + 1 });
      expect(bar?.label).toBe(`Result step ${i + 1} of 4`);
      expect(
        audit.controls.filter(c => c.issues.includes('unnamed_control')),
      ).toEqual([]);
      expect(hardLexicon(audit)).toEqual([]);
      expect(audit.imagesWithoutLabel).toBe(0);
      if (i < steps.length - 1) await press(renderer, 'result-guide-next');
    }
    // Back walks to DRILLS again.
    await press(renderer, 'result-guide-back');
    expect(hostByTestId(renderer, 'result-guide-step-drills')).toHaveLength(1);
    // NEXT page actions.
    await press(renderer, 'result-guide-next');
    await act(async () => pressText(renderer, 'Try it again'));
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    await act(async () => pressText(renderer, 'Done'));
    expect(mockNavigation.popToTop).toHaveBeenCalled();
  });

  it('score page: technique-score accessibility label carries the number; DUPR estimate is informational only', async () => {
    const renderer = await renderResult();
    const audit = record(renderer, 'ResultScreen', 'scored.score.a11y', {});
    expect(
      renderer.root.findAll(
        n => n.props['accessibilityLabel'] === 'Technique score 7.1 out of 10',
      ).length,
    ).toBeGreaterThan(0);
    expect(audit.informational.some(h => h.rule === 'dupr_in_app')).toBe(true);
    expect(audit.lexicon.filter(h => /dupr/i.test(h.match))).toEqual([]);
  });

  it('scored, no replay evidence: THE PROBLEM shows fix cards; footer names it', async () => {
    mockLoadEvidence.mockResolvedValue(
      scoredEvidence({ review: null, clip: null }),
    );
    mockLoadSequence.mockResolvedValue(null);
    const renderer = await renderResult();
    await press(renderer, 'result-guide-next');
    const audit = record(
      renderer,
      'ResultScreen',
      'scored.problem.no_replay',
      {},
    );
    expect(hostByTestId(renderer, 'form-review-player')).toHaveLength(0);
    expect(hostByTestId(renderer, 'fix-list')).toHaveLength(1);
    expect(hardLexicon(audit)).toEqual([]);
  });

  it('scored, sidecar hash failure: replay degrades honestly (no invented frames)', async () => {
    mockLoadSequence.mockRejectedValue(
      new Error('pose_sequence.hash_mismatch'),
    );
    const renderer = await renderResult();
    await press(renderer, 'result-guide-next');
    const audit = record(
      renderer,
      'ResultScreen',
      'scored.problem.sidecar_rejected',
      {
        sidecarError: 'pose_sequence.hash_mismatch',
      },
    );
    expect(allText(renderer)).not.toContain('hash_mismatch');
    expect(hardLexicon(audit)).toEqual([]);
  });

  it('clean stroke with no replay: guide skips PROBLEM and DRILLS', async () => {
    mockLoadEvidence.mockResolvedValue(
      scoredEvidence({ analysis: cleanAnalysis, review: null, clip: null }),
    );
    mockLoadSequence.mockResolvedValue(null);
    const renderer = await renderResult();
    record(renderer, 'ResultScreen', 'scored.clean.score', {});
    await press(renderer, 'result-guide-next');
    const audit = record(renderer, 'ResultScreen', 'scored.clean.next', {});
    expect(hostByTestId(renderer, 'result-guide-step-next')).toHaveLength(1);
    const bar = audit.valued.find(r => r.role === 'progressbar');
    expect(bar?.value).toEqual({ min: 1, max: 2, now: 2 });
    expect(hardLexicon(audit)).toEqual([]);
  });

  it('legacy row (analysis without record) still renders the guide', async () => {
    mockLoadEvidence.mockResolvedValue(scoredEvidence({ record: null }));
    const renderer = await renderResult();
    const audit = record(
      renderer,
      'ResultScreen',
      'scored.legacy_no_record',
      {},
    );
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(1);
    expect(hardLexicon(audit)).toEqual([]);
  });

  it('abstained: single honest page, no score, ledger + training "score required"', async () => {
    mockLoadEvidence.mockResolvedValue(abstainedEvidence());
    mockLoadSequence.mockResolvedValue(null);
    mockRouteParams = { analysisId: 'analysis-2' };
    const renderer = await renderResult({ analysisId: 'analysis-2' });
    const audit = record(renderer, 'ResultScreen', 'abstained', {
      analysisId: 'analysis-2',
    });
    const text = allText(renderer);
    expect(text).toContain('A score is required.');
    expect(text).not.toMatch(/Technique score \d/);
    expect(text).not.toContain('analysis_confidence_below_threshold');
    expect(audit.roles['progressbar']).toBeUndefined();
    expect(hardLexicon(audit)).toEqual([]);
    expect(
      audit.controls.filter(c => c.issues.includes('unnamed_control')),
    ).toEqual([]);
  });

  it('DRILLS: catalog error and empty catalog render honest states', async () => {
    mockListCatalogDrills.mockRejectedValue(
      new Error('training.request_failed'),
    );
    let renderer = await renderResult();
    await press(renderer, 'result-guide-next');
    await press(renderer, 'result-guide-next');
    let audit = record(
      renderer,
      'ResultScreen',
      'scored.drills.catalog_error',
      {
        error: 'training.request_failed',
      },
    );
    expect(allText(renderer)).not.toContain('training.request_failed');
    expect(hardLexicon(audit)).toEqual([]);

    mockListCatalogDrills.mockResolvedValue([]);
    renderer = await renderResult();
    await press(renderer, 'result-guide-next');
    await press(renderer, 'result-guide-next');
    audit = record(renderer, 'ResultScreen', 'scored.drills.catalog_empty', {});
    expect(hardLexicon(audit)).toEqual([]);

    mockGetApiSession.mockReturnValue(null);
    renderer = await renderResult();
    await press(renderer, 'result-guide-next');
    await press(renderer, 'result-guide-next');
    audit = record(renderer, 'ResultScreen', 'scored.drills.no_session', {});
    expect(hardLexicon(audit)).toEqual([]);
  });

  it('unusual inputs: unknown shotType / odd analysisId never leak raw tokens on the guide', async () => {
    mockLoadEvidence.mockResolvedValue(
      scoredEvidence({
        analysis: {
          ...scoredAnalysis,
          shotType: 'zzz_unknown_stroke' as never,
          versionVector: {
            ...scoredAnalysis.versionVector,
            shotConfigVersion: 'zzz_unknown_stroke@9',
          },
        },
      }),
    );
    const renderer = await renderResult({
      analysisId: '  weird id/with?chars ',
    });
    const audit = record(renderer, 'ResultScreen', 'scored.unknown_shot_type', {
      shotType: 'zzz_unknown_stroke',
      analysisId: '  weird id/with?chars ',
    });
    // Whatever the fallback, the raw slug must not surface as-is.
    expect(
      audit.texts
        .filter(t => t.text.includes('zzz_unknown_stroke'))
        .map(t => t.text),
    ).toEqual([]);
  });
});

// ─── Sync + training states (the breakdown sheet, hosted by ResultDetails
//     and inline by the abstained guide page) ────────────────────────────────

describe('xc-3 · breakdown sheet sync/training states', () => {
  const OUTBOX_CASES: {
    name: string;
    receipt: boolean;
    outbox: Parameters<typeof setOutbox>[0] | null;
    reject?: boolean;
    expect: string;
  }[] = [
    {
      name: 'synced',
      receipt: true,
      outbox: null,
      expect: 'Turn this read into a plan.',
    },
    {
      name: 'pending',
      receipt: false,
      outbox: { state: 'queued' },
      expect: 'still in the secure outbox',
    },
    {
      name: 'unknown',
      receipt: false,
      outbox: { state: 'absent' },
      expect: 'could not verify whether this shot reached the server',
    },
    {
      name: 'unknown.receipt_rejected',
      receipt: false,
      outbox: null,
      reject: true,
      expect: 'could not verify whether this shot reached the server',
    },
    {
      name: 'rejected.no_error',
      receipt: false,
      outbox: { state: 'rejected', attempts: 2, lastError: null },
      expect: `The server refused this read 2 of ${OUTBOX_MAX_ATTEMPTS} times.`,
    },
    {
      name: 'rejected.with_error',
      receipt: false,
      outbox: {
        state: 'rejected',
        attempts: 1,
        lastError: 'HTTP 422 shot_config_version_mismatch',
      },
      expect: 'last response: HTTP 422 shot_config_version_mismatch',
    },
    {
      name: 'exhausted.no_error',
      receipt: false,
      outbox: {
        state: 'exhausted',
        attempts: OUTBOX_MAX_ATTEMPTS,
        lastError: null,
      },
      expect: `Sync was refused ${OUTBOX_MAX_ATTEMPTS} times`,
    },
    {
      name: 'exhausted.with_error',
      receipt: false,
      outbox: {
        state: 'exhausted',
        attempts: 9,
        lastError: 'HTTP 500 {"error":"internal"}',
      },
      expect: 'last response: HTTP 500 {"error":"internal"}',
    },
    {
      name: 'exhausted.attempts_1',
      receipt: false,
      outbox: { state: 'exhausted', attempts: 1, lastError: '' },
      expect: 'Sync was refused 1 times',
    },
  ];

  for (const c of OUTBOX_CASES) {
    it(`ResultDetails · sync ${c.name}`, async () => {
      configureTrainingStore(trainingApi());
      if (c.reject) {
        mockHasShotSyncReceipt.mockRejectedValue(new Error('sqlite busy'));
      } else if (c.receipt) {
        mockHasShotSyncReceipt.mockResolvedValue(true);
      } else if (c.outbox) {
        setOutbox(c.outbox);
      }
      const renderer = await renderDetails();
      const audit = record(renderer, 'ResultDetailsScreen', `sync.${c.name}`, {
        receipt: c.receipt,
        outbox: c.outbox,
        rejectReceipt: c.reject ?? false,
      });
      expect(allText(renderer)).toContain(c.expect);
      expect(
        audit.controls.filter(x => x.issues.includes('unnamed_control')),
      ).toEqual([]);
      expect(audit.imagesWithoutLabel).toBe(0);
    });
  }

  it('ResultDetails · sync checking (receipt never resolves) shows loading copy', async () => {
    configureTrainingStore(trainingApi());
    mockHasShotSyncReceipt.mockReturnValue(new Promise(() => {}));
    const renderer = await renderDetails();
    const audit = record(renderer, 'ResultDetailsScreen', 'sync.checking', {});
    expect(allText(renderer)).toContain('Checking sync evidence…');
    expect(hardLexicon(audit)).toEqual([]);
  });

  it('ResultDetails · training unconfigured (no API) names the requirement', async () => {
    mockHasShotSyncReceipt.mockResolvedValue(true);
    const renderer = await renderDetails();
    const audit = record(
      renderer,
      'ResultDetailsScreen',
      'training.unconfigured',
      {},
    );
    expect(allText(renderer)).toContain('Training is not connected.');
    expect(hardLexicon(audit)).toEqual([]);
  });

  it('ResultDetails · training loading (plan never resolves)', async () => {
    configureTrainingStore(
      trainingApi({ getCurrentPlan: () => new Promise(() => {}) }),
    );
    mockHasShotSyncReceipt.mockResolvedValue(true);
    const renderer = await renderDetails();
    const audit = record(
      renderer,
      'ResultDetailsScreen',
      'training.loading',
      {},
    );
    expect(allText(renderer)).toContain('Checking reviewed training…');
    expect(hardLexicon(audit)).toEqual([]);
  });

  const PLAN_ERRORS: { name: string; error: unknown; expectBody: string }[] = [
    {
      name: 'training_error',
      error: new TrainingError(
        'training.unavailable',
        'The training service is temporarily unavailable.',
        true,
        503,
      ),
      expectBody: 'The training service is temporarily unavailable.',
    },
    {
      name: 'plain_error',
      error: new Error('fetch failed: ECONNRESET'),
      expectBody: 'Training could not be verified.',
    },
    {
      name: 'non_error_thrown',
      error: { status: 500 },
      expectBody: 'Training could not be verified.',
    },
    {
      name: 'empty_message',
      error: new TrainingError('training.request_failed', '', true, 502),
      expectBody: 'Training could not be verified.',
    },
  ];
  for (const c of PLAN_ERRORS) {
    it(`ResultDetails · training error · ${c.name}`, async () => {
      configureTrainingStore(
        trainingApi({
          getCurrentPlan: jest.fn(async () => Promise.reject(c.error)),
        }),
      );
      mockHasShotSyncReceipt.mockResolvedValue(true);
      const renderer = await renderDetails();
      const audit = record(
        renderer,
        'ResultDetailsScreen',
        `training.error.${c.name}`,
        {
          error:
            c.error instanceof Error
              ? { name: c.error.name, message: c.error.message }
              : c.error,
        },
      );
      expect(allText(renderer)).toContain(c.expectBody);
      // Retry control exists and is named.
      expect(audit.controls.some(x => x.name === 'Try again')).toBe(true);
      expect(
        audit.controls.filter(x => x.issues.includes('unnamed_control')),
      ).toEqual([]);
    });
  }

  it('ResultDetails · plan for this read (0/3, 3/3), active-other-plan replace dialog, completed delta / null delta', async () => {
    mockHasShotSyncReceipt.mockResolvedValue(true);

    // 0/3 for this read.
    configureTrainingStore(
      trainingApi({ getCurrentPlan: jest.fn(async () => plan()) }),
    );
    let renderer = await renderDetails();
    let audit = record(
      renderer,
      'ResultDetailsScreen',
      'training.plan.this_read.0_of_3',
      {},
    );
    expect(allText(renderer)).toContain('0/3 DONE');
    expect(allText(renderer)).toContain(
      'Complete all three reviewed prescriptions',
    );
    expect(
      audit.controls.filter(x => x.issues.includes('unnamed_control')),
    ).toEqual([]);
    // Log-practice dialog is modal + named.
    const confirm = renderer.root.findAll(
      n =>
        typeof n.props['accessibilityLabel'] === 'string' &&
        n.props['accessibilityLabel'].startsWith('Confirm completion of') &&
        typeof n.props['onPress'] === 'function',
    )[0];
    expect(confirm).toBeDefined();
    await act(async () => confirm!.props['onPress']());
    audit = record(
      renderer,
      'ResultDetailsScreen',
      'training.plan.dialog.log_practice',
      {},
    );
    expect(audit.modals.count).toBeGreaterThan(0);
    await act(async () => {
      renderer.unmount();
    });
    mounted.splice(mounted.indexOf(renderer), 1);

    // 3/3 for this read.
    configureTrainingStore(
      trainingApi({
        getCurrentPlan: jest.fn(async () =>
          plan({
            items: plan().items.map(i => ({
              ...i,
              completion: {
                id: `c-${i.id}`,
                completedAt: '2026-09-02T10:00:00.000Z',
                actualRepetitions: 10,
                actualDurationSeconds: null,
                qualifiesForStreak: true,
              },
            })),
          }),
        ),
      }),
    );
    renderer = await renderDetails();
    audit = record(
      renderer,
      'ResultDetailsScreen',
      'training.plan.this_read.3_of_3',
      {},
    );
    expect(allText(renderer)).toContain('3/3 DONE');
    expect(allText(renderer)).toContain('Capture a newer forehand drive read.');
    await act(async () => {
      renderer.unmount();
    });
    mounted.splice(mounted.indexOf(renderer), 1);

    // Active plan for ANOTHER read (older) → "Build from this read instead?" + replace dialog.
    configureTrainingStore(
      trainingApi({
        getCurrentPlan: jest.fn(async () =>
          plan({ sourceShotId: 'analysis-0' }),
        ),
      }),
    );
    renderer = await renderDetails();
    audit = record(
      renderer,
      'ResultDetailsScreen',
      'training.plan.other_read.active',
      {},
    );
    expect(allText(renderer)).toContain('Build from this read instead?');
    await act(async () => pressText(renderer, 'Build reviewed plan'));
    audit = record(
      renderer,
      'ResultDetailsScreen',
      'training.plan.dialog.replace',
      {},
    );
    expect(allText(renderer)).toContain('Replace the current plan?');
    expect(audit.modals.count).toBeGreaterThan(0);
    await act(async () => {
      renderer.unmount();
    });
    mounted.splice(mounted.indexOf(renderer), 1);

    // Reassess-eligible: other read, all complete, newer capture, same shot.
    configureTrainingStore(
      trainingApi({
        getCurrentPlan: jest.fn(async () =>
          plan({
            sourceShotId: 'analysis-0',
            items: plan().items.map(i => ({
              ...i,
              completion: {
                id: `c-${i.id}`,
                completedAt: '2026-08-31T10:00:00.000Z',
                actualRepetitions: 10,
                actualDurationSeconds: null,
                qualifiesForStreak: true,
              },
            })),
          }),
        ),
      }),
    );
    renderer = await renderDetails();
    audit = record(
      renderer,
      'ResultDetailsScreen',
      'training.plan.reassess_eligible',
      {},
    );
    expect(allText(renderer)).toContain('Measure the change.');
    expect(audit.controls.some(x => x.name === 'Use as reassessment')).toBe(
      true,
    );
    await act(async () => {
      renderer.unmount();
    });
    mounted.splice(mounted.indexOf(renderer), 1);

    // Completed by this read: delta and null delta.
    for (const delta of [1.3, -0.4, 0, null]) {
      configureTrainingStore(
        trainingApi({
          getCurrentPlan: jest.fn(async () =>
            plan({
              status: 'completed',
              sourceShotId: 'analysis-0',
              reassessmentShotId: 'analysis-1',
              scoreDelta: delta,
              completedAt: '2026-09-01T10:00:00.000Z',
            }),
          ),
        }),
      );
      renderer = await renderDetails();
      audit = record(
        renderer,
        'ResultDetailsScreen',
        `training.plan.completed.delta_${String(delta)}`,
        {
          scoreDelta: delta,
        },
      );
      expect(allText(renderer)).toContain('REASSESSMENT VERIFIED');
      if (delta === null) expect(allText(renderer)).toContain('Plan complete');
      else
        expect(allText(renderer)).toContain(
          `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} points`,
        );
      expect(hardLexicon(audit)).toEqual([]);
      await act(async () => {
        renderer.unmount();
      });
      mounted.splice(mounted.indexOf(renderer), 1);
    }
  });

  it('ResultDetails · plan creation failure surfaces a dismissible mutation error (no raw code)', async () => {
    mockHasShotSyncReceipt.mockResolvedValue(true);
    configureTrainingStore(
      trainingApi({
        createPlan: jest.fn(async () =>
          Promise.reject(
            new TrainingError(
              'training.request_failed',
              'The server could not build a plan for this read.',
              true,
              409,
            ),
          ),
        ),
      }),
    );
    const renderer = await renderDetails();
    await act(async () => pressText(renderer, 'Build reviewed plan'));
    await settle();
    const audit = record(
      renderer,
      'ResultDetailsScreen',
      'training.mutation_error',
      {},
    );
    expect(allText(renderer)).toContain(
      'The server could not build a plan for this read.',
    );
    expect(allText(renderer)).not.toContain('training.request_failed');
    expect(hardLexicon(audit)).toEqual([]);
    expect(useTrainingStore.getState().mutationError).not.toBeNull();
  });
});

// ─── ResultDetailsScreen shell + navigation ─────────────────────────────────

describe('xc-3 · ResultDetailsScreen render-state matrix', () => {
  it('loading: header with Back, caption', async () => {
    mockLoadEvidence.mockReturnValue(new Promise(() => {}));
    const renderer = await renderDetails();
    const audit = record(renderer, 'ResultDetailsScreen', 'loading', {});
    expect(allText(renderer)).toContain('Opening your result…');
    expect(audit.controls.some(c => c.name === 'Back')).toBe(true);
    expect(hardLexicon(audit)).toEqual([]);
  });

  it('missing: honest state, Go back', async () => {
    mockLoadEvidence.mockResolvedValue({
      analysis: null,
      record: null,
      clip: null,
      review: null,
      attempts: [],
    });
    const renderer = await renderDetails();
    const audit = record(renderer, 'ResultDetailsScreen', 'missing', {});
    expect(allText(renderer)).toContain('Result missing');
    await act(async () => pressText(renderer, 'Go back'));
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    expect(hardLexicon(audit)).toEqual([]);
  });

  it('ready: full breakdown; Back → goBack; attempt chip → popTo Result; try again / done / form review', async () => {
    configureTrainingStore(trainingApi());
    mockHasShotSyncReceipt.mockResolvedValue(true);
    const renderer = await renderDetails();
    const audit = record(
      renderer,
      'ResultDetailsScreen',
      'ready.scored.synced',
      {},
    );
    expect(hostByTestId(renderer, 'result-details')).toHaveLength(1);
    expect(
      audit.controls.filter(c => c.issues.includes('unnamed_control')),
    ).toEqual([]);
    expect(audit.imagesWithoutLabel).toBe(0);
    expect(hardLexicon(audit)).toEqual([]);

    // Header back.
    const back = audit.controls.find(c => c.name === 'Back');
    expect(back).toBeDefined();
    // Header back is icon-only; exercise via its labelled node.
    const backNode = renderer.root.findAll(
      n =>
        n.props['accessibilityLabel'] === 'Back' &&
        typeof n.props['onPress'] === 'function',
    )[0];
    expect(backNode).toBeDefined();
    await act(async () => backNode!.props['onPress']());
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);

    // Attempt chips: the other attempt repoints the guide underneath (popTo);
    // the current one is a no-op.
    const chipsByLabel = new Map<string, ReactTestInstance>();
    for (const n of renderer.root.findAll(
      c =>
        c.props['accessibilityRole'] === 'tab' &&
        typeof c.props['onPress'] === 'function',
    )) {
      const label = String(n.props['accessibilityLabel']);
      if (!chipsByLabel.has(label)) chipsByLabel.set(label, n);
    }
    const chips = [...chipsByLabel.values()];
    expect(chips.map(c => c.props['accessibilityLabel'])).toEqual([
      'Attempt 1',
      'Attempt 2',
    ]);
    for (const chip of chips) {
      await act(async () => chip.props['onPress']());
    }
    const popToCalls = mockNavigation.popTo.mock.calls;
    expect(popToCalls).toEqual([['Result', { analysisId: 'analysis-0' }]]);
    appendLog(
      LOG,
      `attempt chips: ${chips.map(c => c.props['accessibilityLabel']).join(',')} → popTo ${JSON.stringify(popToCalls)}`,
    );
  });
});
