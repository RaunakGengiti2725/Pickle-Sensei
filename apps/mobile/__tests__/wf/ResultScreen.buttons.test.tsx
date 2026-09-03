import React from 'react';
import { Linking } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { StrokeIntentEnvelope } from '@pickle/analysis-pipeline';
import type { CheckpointScore, ShotAnalysis } from '@pickle/shared-types';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';
import type { StrokeResultEvidence } from '../../src/components/strokeResultData';
import type {
  RealAnalysisFact,
  ShotOutboxStatus,
} from '../../src/data/repository';
import type { CatalogDrill } from '../../src/training/api';
import type {
  DrillDetail,
  TrainingApi,
  TrainingPlan,
  TrainingPlanItem,
} from '../../src/training/types';
import { BrandDialog } from '../../src/design/components';

/**
 * Button ledger for the Result routes. The Result route (`ResultScreen`) is
 * a four-page guide — SCORE → THE PROBLEM → DRILLS → NEXT, pages without
 * evidence skipped — whose own controls are the top-row Close, the
 * descriptive Next, Back / Done and the last page's "Try it again", plus the
 * THIS SET attempt pills (score page) and the catalog drills' Save toggles /
 * "Open drill library" (drills page). EVERYTHING the former one-page surface
 * held — the canonical StrokeResult (attempt tabs, replay, measured rows),
 * the personalized training section (Build reviewed plan, PlanDrillCard
 * controls, Use as reassessment) and the AnalysisFeedbackPrompt — is
 * `ResultBreakdownSheet`, hosted by the `ResultDetails` route
 * (`ResultDetailsScreen`) and, inline, by the guide's abstained page.
 *
 * Every pressable either host renders is pressed here and its real
 * observable effect asserted — navigation target + params, training API
 * calls through the real training store, Linking / Alert calls, and the copy
 * the user sees on both the success and failure paths.
 */

jest.mock('../../src/data/db', () => ({
  getDb: jest.fn(() => ({
    execute: jest.fn(async () => ({ rows: [] })),
    close() {},
  })),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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

const mockNavigation = {
  navigate: jest.fn(),
  replace: jest.fn(),
  popTo: jest.fn(),
  goBack: jest.fn(),
  popToTop: jest.fn(),
};
const mockRoute = { params: { analysisId: 'a1' } };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => mockRoute,
}));

const mockLoadEvidence = jest.fn<Promise<StrokeResultEvidence>, unknown[]>();
jest.mock('../../src/components/strokeResultData', () => ({
  loadStrokeResultEvidence: (...args: unknown[]) => mockLoadEvidence(...args),
}));

const mockHasShotSyncReceipt = jest.fn<Promise<boolean>, unknown[]>();
const mockGetShotOutboxStatus = jest.fn<Promise<ShotOutboxStatus>, unknown[]>();
const mockListRealAnalysisFacts = jest.fn<
  Promise<RealAnalysisFact[]>,
  unknown[]
>();
jest.mock('../../src/data/repository', () => ({
  hasShotSyncReceipt: (...args: unknown[]) => mockHasShotSyncReceipt(...args),
  getShotOutboxStatus: (...args: unknown[]) => mockGetShotOutboxStatus(...args),
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
}));

const mockConsistencyState = {
  daySecured: null as unknown,
  refresh: jest.fn(async () => {}),
  consumeDaySecured: jest.fn(() => null),
  recordDrillCompletion: jest.fn(async () => {}),
};
jest.mock('../../src/consistency/store', () => {
  const useConsistencyStore = (
    selector: (s: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState);
  useConsistencyStore.getState = () => mockConsistencyState;
  return { useConsistencyStore };
});

const mockGetApiSession = jest.fn<unknown, []>(() => null);
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

const mockSubmitAnalysisFeedback = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../src/data/api', () => {
  const actual =
    jest.requireActual<typeof import('../../src/data/api')>(
      '../../src/data/api',
    );
  return {
    ...actual,
    submitAnalysisFeedback: (...args: unknown[]) =>
      mockSubmitAnalysisFeedback(...args),
  };
});

// The guide's DRILLS page reads the catalog through the training API client;
// the training STORE (saves, plans) keeps its injected api below.
const mockListCatalogDrills = jest.fn<Promise<CatalogDrill[]>, unknown[]>();
jest.mock('../../src/training/api', () => ({
  createTrainingApi: () => ({
    listCatalogDrills: (...args: unknown[]) => mockListCatalogDrills(...args),
  }),
}));

import { ResultScreen } from '../../src/screens/ResultScreen';
import { ResultDetailsScreen } from '../../src/screens/ResultDetailsScreen';
import {
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import { consumeTryAgainHandoff } from '../../src/screens/tryAgainHandoff';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function analysisFixture(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
    id: 'a1',
    sessionId: 's1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    timestamps: { startMs: 2000, contactMs: null, endMs: 2700 },
    phases: [],
    measurements: [
      {
        metricKey: 'elbow_extension',
        value: 0.42,
        confidence: 0.8,
        unit: 'ratio',
        source: 'real',
      },
      {
        metricKey: 'swing_duration',
        value: 700,
        confidence: 0.9,
        unit: 'ms',
        source: 'real',
      },
      {
        metricKey: 'hip_rotation',
        value: 31,
        confidence: 0.7,
        unit: 'degrees',
        source: 'real',
      },
      {
        metricKey: 'knee_bend',
        value: 12,
        confidence: 0.7,
        unit: 'degrees',
        source: 'real',
      },
    ],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.82,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-heuristic-1',
      scoringModelVersion: 'scoring-1',
      shotConfigVersion: 'config-1',
    },
    source: 'real',
    ...overrides,
  };
}

function checkpoint(
  key: CheckpointScore['key'],
  score: number,
  band: CheckpointScore['band'],
  direction: CheckpointScore['direction'],
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: (100 - score) / 100,
    applicable: true,
  };
}

/** A scored read with ONE measured fault: THE PROBLEM and DRILLS pages exist. */
function faultedAnalysis(): ShotAnalysis {
  return analysisFixture({
    checkpoints: [
      checkpoint('ready_position', 85, 'green', 'none'),
      checkpoint('contact_position', 48, 'red', 'late'),
    ],
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'lowest_score',
      severity: 0.52,
      confidence: 0.8,
    },
  });
}

const declaredEnvelope: StrokeIntentEnvelope = {
  declaredStroke: 'forehand_drive',
  predictedStroke: null,
  resolutionBasis: 'declared',
  resolvedProfileId: 'FOREHAND_DRIVE',
  resolvedProfileVersion: 'technique-profile-v1',
  disagreement: null,
};

const recordFixture = {
  id: 'a1',
  captureId: 'capture-1',
  strokeIntent: declaredEnvelope,
  result: null,
  uncertainty: {
    analysisConfidence: 0.82,
    presentation: 'normal',
    limitingFactors: [],
  },
  contact: {
    status: 'estimated',
    estimatedContactMs: 2400,
    confidence: 0.7,
    ballConfirmed: true,
    paddleConfirmed: false,
    limitingFactors: [],
    supportingEvidence: [],
  },
} as StrokeResultEvidenceRecord;

const attemptRefs = [
  { analysisId: 'a1', capturedAtIso: '2026-08-30T10:00:00Z', sessionId: 's1' },
  { analysisId: 'a2', capturedAtIso: '2026-08-30T10:05:00Z', sessionId: 's1' },
];

function evidenceFixture(
  overrides: Partial<StrokeResultEvidence> = {},
): StrokeResultEvidence {
  return {
    analysis: analysisFixture(),
    record: recordFixture,
    clip: null,
    review: null,
    attempts: attemptRefs,
    ...overrides,
  };
}

/** The honest abstention: the classifier would not commit, nothing scored. */
function abstainedEvidence(
  overrides: Partial<StrokeResultEvidence> = {},
): StrokeResultEvidence {
  return evidenceFixture({
    analysis: null,
    record: {
      ...recordFixture,
      strokeIntent: {
        ...declaredEnvelope,
        declaredStroke: null,
        resolutionBasis: 'abstained',
        resolvedProfileId: null,
        resolvedProfileVersion: null,
      },
      uncertainty: {
        analysisConfidence: 0,
        presentation: 'abstain',
        limitingFactors: ['paddle_track_missing'],
      },
      contact: {
        status: 'abstained',
        reason: 'insufficient evidence mass',
        limitingFactors: ['insufficient_evidence_mass'],
      },
    },
    attempts: [],
    ...overrides,
  });
}

/** Set `s1` as the repository reports it: two comparable scored attempts. */
function setFacts(): RealAnalysisFact[] {
  const base = {
    shotType: 'forehand_drive',
    confidence: 0.82,
    resultKind: 'scored' as const,
    scoringModelVersion: 'scoring-1',
    shotConfigVersion: 'config-1',
    sessionId: 's1',
    priorityCheckpoint: null,
    checkpointScores: {},
  };
  return [
    {
      ...base,
      id: 'a1',
      capturedAt: '2026-08-30T10:00:00.000Z',
      overallScore: 7.4,
    },
    {
      ...base,
      id: 'a2',
      capturedAt: '2026-08-30T10:05:00.000Z',
      overallScore: 8.1,
    },
  ];
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
  drill('shadow-swing-ladder', ['global']),
];

function planItem(overrides: Partial<TrainingPlanItem> = {}): TrainingPlanItem {
  return {
    id: 'item-1',
    position: 1,
    kind: 'warmup',
    drill: {
      slug: 'shadow-swings',
      title: 'Shadow swings',
      description: 'Swing without a ball.',
      coachName: 'Coach Kim',
      equipment: [],
      saved: false,
    },
    cueText: 'Finish high',
    targetSets: 3,
    targetRepetitionsPerSet: 10,
    targetDurationSeconds: null,
    restSeconds: 30,
    completion: null,
    ...overrides,
  };
}

function planFixture(overrides: Partial<TrainingPlan> = {}): TrainingPlan {
  return {
    id: 'plan-1',
    status: 'active',
    algorithmVersion: 'v1',
    sourceShotId: 'a1',
    shotType: 'forehand_drive',
    priorityCheckpoint: 'contact_point',
    priorityDirection: 'late',
    baselineScore: 7.4,
    baselineCheckpointScore: 6,
    reassessmentShotId: null,
    scoreDelta: null,
    createdAt: '2026-08-29T10:00:00.000Z',
    completedAt: null,
    items: [
      planItem(),
      planItem({
        id: 'item-2',
        position: 2,
        kind: 'targeted',
        drill: {
          slug: 'wall-drive',
          title: 'Wall drive',
          description: 'Drive against a wall.',
          coachName: 'Coach Kim',
          equipment: [],
          saved: true,
        },
        targetRepetitionsPerSet: null,
        targetDurationSeconds: 45,
      }),
      planItem({
        id: 'item-3',
        position: 3,
        kind: 'targeted',
        drill: {
          slug: 'timing-toss',
          title: 'Timing toss',
          description: 'Toss and drive.',
          coachName: 'Coach Kim',
          equipment: [],
          saved: false,
        },
        targetSets: null,
        targetRepetitionsPerSet: null,
      }),
    ],
    ...overrides,
  };
}

const completion = {
  id: 'completion-1',
  completedAt: '2026-08-30T11:00:00.000Z',
  actualRepetitions: 30,
  actualDurationSeconds: null,
  qualifiesForStreak: true,
};

function completedPlan(): TrainingPlan {
  const plan = planFixture();
  return {
    ...plan,
    items: plan.items.map(item => ({
      ...item,
      targetSets: 3,
      targetRepetitionsPerSet: 10,
      completion,
    })),
  };
}

function detailFixture(slug: string): DrillDetail {
  return {
    id: `detail-${slug}`,
    slug,
    title: slug,
    description: 'detail',
    coachName: 'Coach Kim',
    equipment: [],
    difficultyMin: null,
    difficultyMax: null,
    saved: false,
    mappings: [],
    instructionalMedia:
      slug === 'shadow-swings'
        ? [
            {
              kind: 'embed',
              id: 'media-embed',
              provider: 'youtube',
              videoId: 'abc123',
              embedUrl: 'https://www.youtube.com/embed/abc123',
              sourceUrl: 'https://www.youtube.com/watch?v=abc123',
              creatorName: 'Coach Kim',
              licenseName: 'CC BY 4.0',
              licenseUrl: null,
              attribution: 'Coach Kim · CC BY 4.0',
            },
          ]
        : slug === 'wall-drive'
          ? [
              {
                kind: 'hosted',
                id: 'media-hosted',
                playbackUrl: 'https://cdn.example.test/wall-drive.mp4',
                expiresAt: '2999-01-01T00:00:00.000Z',
                sourceUrl: 'https://cdn.example.test/wall-drive',
                creatorName: 'Coach Kim',
                licenseName: 'Licensed',
                licenseUrl: null,
                attribution: 'Coach Kim · Licensed',
              },
            ]
          : [],
  };
}

const session = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-1',
  canonicalAppUserId: 'user-1',
  provider: 'apple',
};

// ─── Harness ────────────────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;

const api: jest.Mocked<TrainingApi> = {
  listSavedDrills: jest.fn(),
  getDrill: jest.fn(),
  saveDrill: jest.fn(),
  unsaveDrill: jest.fn(),
  getCurrentPlan: jest.fn(),
  createPlan: jest.fn(),
  completeDrill: jest.fn(),
  reassessPlan: jest.fn(),
};

let canOpenSpy: jest.SpyInstance;
let openUrlSpy: jest.SpyInstance;

/** Evidence → receipt → outbox / plan / catalog resolve on successive
 * microtask turns (timers are faked, so no Animated tick outlives a test). */
async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** The Result route: the four-page guide. */
async function render(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<ResultScreen />);
  });
  await flush();
  return renderer;
}

/** The ResultDetails route: the full breakdown sheet. */
async function renderDetails(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<ResultDetailsScreen />);
  });
  await flush();
  return renderer;
}

async function unmount(renderer: Renderer) {
  await act(async () => {
    renderer.unmount();
  });
}

function textOf(renderer: Renderer): string {
  return JSON.stringify(renderer.toJSON());
}

/** Every RN Pressable in the tree — the real touch targets. */
function pressables(renderer: Renderer) {
  return renderer.root.findAll(node => {
    if (typeof node.type === 'string') return false;
    const type = node.type as { displayName?: string; name?: string };
    return (
      (type.displayName ?? type.name) === 'Pressable' &&
      typeof node.props.onPress === 'function'
    );
  });
}

function byLabel(renderer: Renderer, label: string) {
  return pressables(renderer).filter(
    node => node.props.accessibilityLabel === label,
  );
}

function control(renderer: Renderer, label: string) {
  const matches = byLabel(renderer, label);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function byTestID(renderer: Renderer, testID: string) {
  const matches = pressables(renderer).filter(
    node => node.props.testID === testID,
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function hasTestID(renderer: Renderer, testID: string): boolean {
  return pressables(renderer).some(node => node.props.testID === testID);
}

async function press(node: TestRenderer.ReactTestInstance) {
  await act(async () => {
    node.props.onPress();
  });
  await flush();
}

function isDisabled(node: TestRenderer.ReactTestInstance): boolean {
  return (
    node.props.disabled === true &&
    node.props.accessibilityState?.disabled === true
  );
}

/** The guide's "n OF m · PAGE" label. */
function stepLabel(renderer: Renderer): string {
  const [label] = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.testID === 'result-guide-step-label',
  );
  if (!label) return '';
  const children = label.props.children;
  return Array.isArray(children) ? children.join('') : String(children);
}

/** Labels of every pressable currently on screen (feedback chips carry a
 * descriptive testID instead of a label), sorted. */
function ledger(renderer: Renderer): string[] {
  const seen = new Set<string>();
  for (const node of pressables(renderer)) {
    expect(['button', 'tab']).toContain(node.props.accessibilityRole);
    const label: unknown = node.props.accessibilityLabel;
    const testID: unknown = node.props.testID;
    if (typeof label !== 'string') {
      expect(typeof testID).toBe('string');
      expect(String(testID).startsWith('feedback-')).toBe(true);
    }
    seen.add(typeof label === 'string' ? label : String(testID));
  }
  return [...seen].sort();
}

function trainingDialog(renderer: Renderer) {
  return renderer.root.findByType(BrandDialog);
}

function dialogButton(renderer: Renderer, title: string, buttonText: string) {
  const dialog = trainingDialog(renderer);
  expect(dialog.props.visible).toBe(true);
  expect(dialog.props.title).toBe(title);
  const button = dialog.props.actions.find(
    (entry: { label: string }) => entry.label === buttonText,
  );
  expect(button).toBeDefined();
  return button!;
}

function pendingForever<T>() {
  return new Promise<T>(() => {});
}

beforeEach(() => {
  jest.useFakeTimers();
  mockNavigation.navigate.mockClear();
  mockNavigation.replace.mockClear();
  mockNavigation.popTo.mockClear();
  mockNavigation.goBack.mockClear();
  mockNavigation.popToTop.mockClear();
  mockRoute.params = { analysisId: 'a1' };
  mockLoadEvidence.mockReset();
  mockLoadEvidence.mockResolvedValue(evidenceFixture());
  mockHasShotSyncReceipt.mockReset();
  mockHasShotSyncReceipt.mockResolvedValue(true);
  mockGetShotOutboxStatus.mockReset();
  mockGetShotOutboxStatus.mockResolvedValue({
    state: 'queued',
    attempts: 0,
    lastError: null,
  });
  mockListRealAnalysisFacts.mockReset();
  mockListRealAnalysisFacts.mockResolvedValue([]);
  mockListCatalogDrills.mockReset();
  mockListCatalogDrills.mockResolvedValue(CATALOG);
  mockConsistencyState.refresh.mockClear();
  mockConsistencyState.recordDrillCompletion.mockClear();
  mockGetApiSession.mockReset();
  mockGetApiSession.mockReturnValue(null);
  mockSubmitAnalysisFeedback.mockReset();
  consumeTryAgainHandoff();

  for (const fn of Object.values(api)) fn.mockReset();
  api.listSavedDrills.mockResolvedValue([]);
  api.getDrill.mockImplementation(async slug => detailFixture(slug));
  api.saveDrill.mockResolvedValue(undefined);
  api.unsaveDrill.mockResolvedValue(undefined);
  api.getCurrentPlan.mockResolvedValue(null);
  configureTrainingStore(api);

  canOpenSpy = jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
  openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

afterEach(() => {
  canOpenSpy.mockRestore();
  openUrlSpy.mockRestore();
  jest.useRealTimers();
});

// ─── Loading + missing states ───────────────────────────────────────────────

describe('Result guide buttons — loading and missing states', () => {
  it('Close (while evidence loads) pops to the top of the stack', async () => {
    mockLoadEvidence.mockReturnValue(pendingForever());
    const renderer = await render();
    expect(textOf(renderer)).toContain('Opening your result…');
    const close = control(renderer, 'Close');
    expect(close.props.accessibilityRole).toBe('button');
    expect(close.props.hitSlop).toBe(8);
    await press(close);
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });

  it('Result missing → Go back goes back (no retry is offered for evidence that is gone)', async () => {
    mockLoadEvidence.mockResolvedValue({
      analysis: null,
      record: null,
      clip: null,
      review: null,
      attempts: [],
    });
    const renderer = await render();
    expect(textOf(renderer)).toContain('Result missing');
    expect(byLabel(renderer, 'Try again')).toHaveLength(0);
    const retry = control(renderer, 'Go back');
    expect(retry.props.accessibilityRole).toBe('button');
    await press(retry);
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });

  it('a rejected evidence load still lands on the missing state (no infinite loading)', async () => {
    mockLoadEvidence.mockRejectedValue(new Error('sqlite'));
    const renderer = await render();
    expect(textOf(renderer)).not.toContain('Opening your result…');
    expect(textOf(renderer)).toContain('Result missing');
    await unmount(renderer);
  });

  it('ResultDetails: Back (while evidence loads) goes back; a gone result offers Go back', async () => {
    mockLoadEvidence.mockReturnValue(pendingForever());
    const loading = await renderDetails();
    expect(textOf(loading)).toContain('Opening your result…');
    expect(textOf(loading)).toContain('Full breakdown');
    const back = control(loading, 'Back');
    expect(back.props.accessibilityRole).toBe('button');
    expect(back.props.hitSlop).toBe(8);
    await press(back);
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    await unmount(loading);

    mockLoadEvidence.mockRejectedValue(new Error('sqlite'));
    const missing = await renderDetails();
    expect(textOf(missing)).toContain('Result missing');
    expect(byLabel(missing, 'Try again')).toHaveLength(0);
    await press(control(missing, 'Go back'));
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(2);
    await unmount(missing);
  });
});

// ─── The guide's own controls (ResultScreen) ────────────────────────────────

describe('Result guide buttons — Close / Next / Back / Done', () => {
  it('Close pops to the top of the stack from any page', async () => {
    const renderer = await render();
    const close = byTestID(renderer, 'result-guide-close');
    expect(close.props.accessibilityLabel).toBe('Close');
    expect(close.props.hitSlop).toBe(8);
    await press(close);
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);
    await press(byTestID(renderer, 'result-guide-next'));
    await press(byTestID(renderer, 'result-guide-close'));
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(2);
    await unmount(renderer);
  });

  it('Next names the coming page, Back returns, and Done (last page only) pops to top', async () => {
    const renderer = await render();
    // No fault, no replay, no drill focus → SCORE → NEXT is the whole guide.
    expect(stepLabel(renderer)).toBe('1 OF 2 · SCORE');
    const next = byTestID(renderer, 'result-guide-next');
    expect(next.props.accessibilityLabel).toBe('Continue');
    expect(next.props.accessibilityRole).toBe('button');
    expect(hasTestID(renderer, 'result-guide-back')).toBe(false);
    expect(hasTestID(renderer, 'result-guide-done')).toBe(false);
    expect(hasTestID(renderer, 'result-guide-try-again')).toBe(false);

    await press(next);
    expect(stepLabel(renderer)).toBe('2 OF 2 · NEXT');
    expect(textOf(renderer)).toContain('Ready for another swing?');
    expect(hasTestID(renderer, 'result-guide-next')).toBe(false);
    const back = byTestID(renderer, 'result-guide-back');
    expect(back.props.accessibilityLabel).toBe('Back');
    await press(back);
    expect(stepLabel(renderer)).toBe('1 OF 2 · SCORE');
    expect(mockNavigation.popToTop).not.toHaveBeenCalled();

    await press(byTestID(renderer, 'result-guide-next'));
    const done = byTestID(renderer, 'result-guide-done');
    expect(done.props.accessibilityLabel).toBe('Done');
    expect(done.props.accessibilityRole).toBe('button');
    await press(done);
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });

  it('a faulted read walks SCORE → THE PROBLEM → DRILLS → NEXT with descriptive Next labels', async () => {
    mockLoadEvidence.mockResolvedValue(
      evidenceFixture({ analysis: faultedAnalysis() }),
    );
    const renderer = await render();
    expect(stepLabel(renderer)).toBe('1 OF 4 · SCORE');
    expect(
      byTestID(renderer, 'result-guide-next').props.accessibilityLabel,
    ).toBe('See what to fix');
    await press(byTestID(renderer, 'result-guide-next'));
    expect(stepLabel(renderer)).toBe('2 OF 4 · THE PROBLEM');
    // No replay evidence on this device: the fix cards stand in for the
    // player, and none of them is a pressable (no form review to open).
    expect(textOf(renderer)).toContain('THE PROBLEM · PRIORITY');
    expect(textOf(renderer)).toContain('Contact position');
    expect(ledger(renderer)).toEqual(['Back', 'Close', 'Fix it with drills']);
    await press(byTestID(renderer, 'result-guide-next'));
    expect(stepLabel(renderer)).toBe('3 OF 4 · DRILLS');
    expect(
      byTestID(renderer, 'result-guide-next').props.accessibilityLabel,
    ).toBe('Continue');
    await press(byTestID(renderer, 'result-guide-next'));
    expect(stepLabel(renderer)).toBe('4 OF 4 · NEXT');
    expect(ledger(renderer)).toEqual(['Back', 'Close', 'Done', 'Try it again']);
    await unmount(renderer);
  });
});

describe('Result guide buttons — Try it again', () => {
  it('arms the same declared intent (and practice set) and opens the camera', async () => {
    const renderer = await render();
    await press(byTestID(renderer, 'result-guide-next'));
    const tryAgain = byTestID(renderer, 'result-guide-try-again');
    expect(tryAgain.props.accessibilityLabel).toBe('Try it again');
    expect(tryAgain.props.accessibilityRole).toBe('button');
    await press(tryAgain);
    expect(mockNavigation.navigate).toHaveBeenCalledTimes(1);
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    expect(consumeTryAgainHandoff()).toEqual({
      source: 'camera',
      declaredStroke: 'forehand_drive',
      declaredCanonical: 'FOREHAND_DRIVE',
      auto: false,
      sessionId: 's1',
    });
    await unmount(renderer);
  });

  it('on an AUTO run re-arms AUTO, never a fabricated declaration', async () => {
    mockLoadEvidence.mockResolvedValue(
      evidenceFixture({
        record: {
          ...recordFixture,
          strokeIntent: {
            ...declaredEnvelope,
            declaredStroke: null,
            resolutionBasis: 'predicted_l3',
          },
        },
      }),
    );
    const renderer = await render();
    await press(byTestID(renderer, 'result-guide-next'));
    await press(byTestID(renderer, 'result-guide-try-again'));
    expect(consumeTryAgainHandoff()).toEqual({
      source: 'camera',
      declaredStroke: null,
      declaredCanonical: null,
      auto: true,
      sessionId: 's1',
    });
    await unmount(renderer);
  });

  it('the abstained (result-null) path collapses to ONE page with the same footer and the sheet inline', async () => {
    mockLoadEvidence.mockResolvedValue(
      abstainedEvidence({ attempts: attemptRefs }),
    );
    const renderer = await render();
    expect(textOf(renderer)).toContain('RESULT · NOT SCORED');
    // The inline sheet's training section is honest about the missing score.
    expect(textOf(renderer)).toContain('A score is required.');
    expect(hasTestID(renderer, 'result-guide-next')).toBe(false);
    expect(hasTestID(renderer, 'result-guide-back')).toBe(false);
    // ONE CTA pair — the guide's footer; the sheet renders no second row.
    expect(hasTestID(renderer, 'stroke-result-try-again')).toBe(false);
    expect(hasTestID(renderer, 'stroke-result-done')).toBe(false);

    // The inline sheet's attempt tabs repoint THIS route (replace).
    await press(control(renderer, 'Attempt 1'));
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    await press(control(renderer, 'Attempt 2'));
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'a2',
    });

    await press(byTestID(renderer, 'result-guide-try-again'));
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    expect(consumeTryAgainHandoff()).toEqual({
      source: 'camera',
      declaredStroke: null,
      declaredCanonical: null,
      auto: true,
      sessionId: null,
    });
    await press(byTestID(renderer, 'result-guide-done'));
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });
});

describe('Result guide buttons — THIS SET attempt pills (score page)', () => {
  it('open the other attempt via replace; the attempt on screen is inert', async () => {
    mockListRealAnalysisFacts.mockResolvedValue(setFacts());
    const renderer = await render();
    expect(mockListRealAnalysisFacts).toHaveBeenCalledWith(
      expect.anything(),
      200,
    );
    expect(textOf(renderer)).toContain('THIS SET');
    const current = byTestID(renderer, 'practice-set-attempt-a1');
    const other = byTestID(renderer, 'practice-set-attempt-a2');
    expect(current.props.accessibilityLabel).toBe('Attempt 1 of 2, score 7.4');
    expect(other.props.accessibilityLabel).toBe(
      'Attempt 2 of 2, score 8.1, latest',
    );
    expect(current.props.accessibilityRole).toBe('button');
    await press(current);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    await press(other);
    expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'a2',
    });
    await unmount(renderer);
  });

  it('are absent until two comparable attempts exist (nothing is compared to nothing)', async () => {
    const renderer = await render();
    expect(textOf(renderer)).not.toContain('THIS SET');
    expect(
      pressables(renderer).filter(
        node =>
          typeof node.props.testID === 'string' &&
          node.props.testID.startsWith('practice-set-attempt-'),
      ),
    ).toHaveLength(0);
    await unmount(renderer);
  });
});

describe('Result guide buttons — DRILLS page', () => {
  beforeEach(() => {
    mockGetApiSession.mockReturnValue(session);
    mockLoadEvidence.mockResolvedValue(
      evidenceFixture({ analysis: faultedAnalysis() }),
    );
  });

  async function openDrills(): Promise<Renderer> {
    const renderer = await render();
    await press(byTestID(renderer, 'result-guide-next'));
    await press(byTestID(renderer, 'result-guide-next'));
    expect(stepLabel(renderer)).toBe('3 OF 4 · DRILLS');
    expect(mockListCatalogDrills).toHaveBeenCalledWith({ family: 'drive' });
    return renderer;
  }

  it('Open drill library navigates to DrillLibrary', async () => {
    const renderer = await openDrills();
    const open = byTestID(renderer, 'recommended-drills-open-library');
    expect(open.props.accessibilityLabel).toBe('Open drill library');
    expect(open.props.accessibilityRole).toBe('button');
    await press(open);
    expect(mockNavigation.navigate).toHaveBeenCalledWith('DrillLibrary');
    await unmount(renderer);
  });

  it('Save bookmarks the drill through the training store and flips the toggle', async () => {
    const renderer = await openDrills();
    const save = byTestID(renderer, 'recommended-drill-drive-and-recover-save');
    expect(save.props.accessibilityLabel).toBe(
      'Save Drive And Recover to your library',
    );
    expect(save.props.accessibilityState).toMatchObject({ selected: false });
    expect(isDisabled(save)).toBe(false);
    await press(save);
    expect(api.saveDrill).toHaveBeenCalledWith('drive-and-recover');
    const saved = byTestID(
      renderer,
      'recommended-drill-drive-and-recover-save',
    );
    expect(saved.props.accessibilityLabel).toBe(
      'Remove Drive And Recover from your library',
    );
    expect(saved.props.accessibilityState).toMatchObject({ selected: true });
    await press(saved);
    expect(api.unsaveDrill).toHaveBeenCalledWith('drive-and-recover');
    await unmount(renderer);
  });

  it('a failed save reports honestly, keeps the toggle unflipped, and Dismiss clears the error', async () => {
    api.saveDrill.mockRejectedValue(new Error('offline'));
    const renderer = await openDrills();
    await press(byTestID(renderer, 'recommended-drill-drive-and-recover-save'));
    expect(
      byTestID(renderer, 'recommended-drill-drive-and-recover-save').props
        .accessibilityState,
    ).toMatchObject({ selected: false });
    expect(textOf(renderer)).toContain('Training not changed');
    await press(control(renderer, 'Dismiss'));
    expect(textOf(renderer)).not.toContain('Training not changed');
    await unmount(renderer);
  });

  it('every pressable on the page has a role and a label', async () => {
    const renderer = await openDrills();
    expect(ledger(renderer)).toEqual([
      'Back',
      'Close',
      'Continue',
      'Open drill library',
      'Save Drive And Recover to your library',
      'Save Shadow Swing Ladder to your library',
    ]);
    await unmount(renderer);
  });
});

// ─── Result surface controls (StrokeResult, on the ResultDetails route) ─────

describe('ResultDetails buttons — result surface', () => {
  it('Back returns to the guide', async () => {
    const renderer = await renderDetails();
    expect(textOf(renderer)).toContain('Full breakdown');
    await press(control(renderer, 'Back'));
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });

  it('renders no second CTA row: Try again and Done belong to the guide', async () => {
    const renderer = await renderDetails();
    expect(hasTestID(renderer, 'stroke-result-try-again')).toBe(false);
    expect(hasTestID(renderer, 'stroke-result-done')).toBe(false);
    expect(byLabel(renderer, 'Done')).toHaveLength(0);
    await unmount(renderer);
  });

  it('attempt tabs pop back to the guide repointed at the tapped attempt; the current one is inert', async () => {
    const renderer = await renderDetails();
    const tabs = pressables(renderer).filter(
      node => node.props.accessibilityRole === 'tab',
    );
    expect(tabs.map(tab => tab.props.accessibilityLabel)).toEqual([
      'Attempt 1',
      'Attempt 2',
    ]);
    const current = tabs.find(
      tab => tab.props.accessibilityState?.selected === true,
    )!;
    expect(current.props.accessibilityLabel).toBe('Attempt 1');
    await press(current);
    expect(mockNavigation.popTo).not.toHaveBeenCalled();

    await press(control(renderer, 'Attempt 2'));
    // Never a second Result on the stack.
    expect(mockNavigation.popTo).toHaveBeenCalledTimes(1);
    expect(mockNavigation.popTo).toHaveBeenCalledWith('Result', {
      analysisId: 'a2',
    });
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    await unmount(renderer);
  });

  it('attempt tabs are hidden for a single-attempt session', async () => {
    mockLoadEvidence.mockResolvedValue(
      evidenceFixture({ attempts: [attemptRefs[0]!] }),
    );
    const renderer = await renderDetails();
    expect(
      pressables(renderer).filter(
        node => node.props.accessibilityRole === 'tab',
      ),
    ).toHaveLength(0);
    await unmount(renderer);
  });

  it('Play replay starts the measured-timeline playback and Pause stops it', async () => {
    const renderer = await renderDetails();
    const play = control(renderer, 'Play replay');
    expect(play.props.accessibilityRole).toBe('button');
    expect(textOf(renderer)).toContain('0.00s');
    await act(async () => {
      play.props.onPress();
    });
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    expect(byLabel(renderer, 'Play replay')).toHaveLength(0);
    const pause = control(renderer, 'Pause replay');
    expect(textOf(renderer)).not.toContain('0.00s');
    await act(async () => {
      pause.props.onPress();
    });
    const clockAfterPause = textOf(renderer).match(/\d+\.\d\ds/)![0];
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(textOf(renderer)).toContain(clockAfterPause);
    expect(byLabel(renderer, 'Play replay')).toHaveLength(1);
    await unmount(renderer);
  });

  it('the replay scrubber seeks the playhead from the touch position', async () => {
    const renderer = await renderDetails();
    const [scrubber] = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityLabel === 'Replay timeline scrubber',
    );
    expect(scrubber).toBeDefined();
    expect(scrubber!.props.onStartShouldSetResponder()).toBe(true);
    await act(async () => {
      scrubber!.props.onLayout({ nativeEvent: { layout: { width: 200 } } });
    });
    await act(async () => {
      scrubber!.props.onResponderGrant({ nativeEvent: { locationX: 100 } });
    });
    // Time base is the analyzed window padded by 250ms (1750..2950ms):
    // a tap at 50% lands 600ms into the timeline.
    expect(textOf(renderer)).toContain('0.60s');
    await act(async () => {
      scrubber!.props.onResponderMove({ nativeEvent: { locationX: 0 } });
    });
    expect(textOf(renderer)).toContain('0.00s');
    await unmount(renderer);
  });

  it('See N more expands the measured rows and Show fewer collapses them', async () => {
    const renderer = await renderDetails();
    expect(textOf(renderer)).not.toContain('Knee bend');
    const [seeMore] = pressables(renderer).filter(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        /^See \d+ more$/.test(node.props.accessibilityLabel),
    );
    expect(seeMore).toBeDefined();
    expect(seeMore!.props.accessibilityRole).toBe('button');
    await press(seeMore!);
    expect(textOf(renderer)).toContain('Knee bend');
    await press(control(renderer, 'Show fewer rows'));
    expect(textOf(renderer)).not.toContain('Knee bend');
    await unmount(renderer);
  });
});

// ─── Personalized training: plan creation ───────────────────────────────────

describe('ResultDetails buttons — Build reviewed plan', () => {
  it('creates a plan from this read and renders it', async () => {
    api.createPlan.mockResolvedValue(planFixture());
    const renderer = await renderDetails();
    expect(textOf(renderer)).toContain('Turn this read into a plan.');
    const build = control(renderer, 'Build reviewed plan');
    expect(build.props.accessibilityRole).toBe('button');
    expect(isDisabled(build)).toBe(false);
    await press(build);
    expect(api.createPlan).toHaveBeenCalledTimes(1);
    expect(api.createPlan).toHaveBeenCalledWith('a1');
    expect(textOf(renderer)).toContain('YOUR REVIEWED PLAN');
    expect(textOf(renderer)).toContain('Shadow swings');
    expect(byLabel(renderer, 'Build reviewed plan')).toHaveLength(0);
    await unmount(renderer);
  });

  it('is disabled with pending copy while the server builds (double-tap guard)', async () => {
    api.createPlan.mockReturnValue(pendingForever());
    const renderer = await renderDetails();
    const build = control(renderer, 'Build reviewed plan');
    await act(async () => {
      build.props.onPress();
    });
    const pending = control(renderer, 'Building plan…');
    expect(isDisabled(pending)).toBe(true);
    await act(async () => {
      pending.props.onPress();
    });
    expect(api.createPlan).toHaveBeenCalledTimes(1);
    expect(useTrainingStore.getState().mutation).toBe('creating-plan');
    await unmount(renderer);
  });

  it('shows the server error and re-enables the button when creation fails', async () => {
    api.createPlan.mockRejectedValue(new Error('boom'));
    const renderer = await renderDetails();
    await press(control(renderer, 'Build reviewed plan'));
    const rendered = textOf(renderer);
    expect(rendered).toContain('Training not changed');
    expect(rendered).toContain('Training is temporarily unavailable.');
    const build = control(renderer, 'Build reviewed plan');
    expect(isDisabled(build)).toBe(false);
    expect(useTrainingStore.getState().mutation).toBe('idle');

    const dismiss = control(renderer, 'Dismiss');
    expect(dismiss.props.accessibilityRole).toBe('button');
    await press(dismiss);
    expect(textOf(renderer)).not.toContain('Training not changed');
    await unmount(renderer);
  });

  it('asks before replacing another read’s active plan; Replace plan calls the API', async () => {
    api.getCurrentPlan.mockResolvedValue(
      planFixture({ id: 'plan-other', sourceShotId: 'other-shot' }),
    );
    api.createPlan.mockResolvedValue(planFixture());
    const renderer = await renderDetails();
    expect(textOf(renderer)).toContain('Build from this read instead?');
    await press(control(renderer, 'Build reviewed plan'));
    expect(api.createPlan).not.toHaveBeenCalled();
    expect(trainingDialog(renderer).props.title).toBe(
      'Replace the current plan?',
    );
    expect(trainingDialog(renderer).props.detail).toContain('supersede');
    expect(
      dialogButton(renderer, 'Replace the current plan?', 'Keep current plan')
        .variant,
    ).toBe('dark');
    await act(async () => {
      dialogButton(
        renderer,
        'Replace the current plan?',
        'Replace plan',
      ).onPress();
    });
    await flush();
    expect(api.createPlan).toHaveBeenCalledWith('a1');
    expect(textOf(renderer)).toContain('YOUR REVIEWED PLAN');
    await unmount(renderer);
  });

  it('is unreachable (honest copy, no dead button) while the shot is queued in the outbox', async () => {
    mockHasShotSyncReceipt.mockResolvedValue(false);
    mockGetShotOutboxStatus.mockResolvedValue({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
    const renderer = await renderDetails();
    expect(textOf(renderer)).toContain('Sync this read first.');
    expect(textOf(renderer)).toContain('secure outbox');
    expect(byLabel(renderer, 'Build reviewed plan')).toHaveLength(0);
    await unmount(renderer);
  });

  it('states the refusal count when the server rejected the shot but retries remain', async () => {
    mockHasShotSyncReceipt.mockResolvedValue(false);
    mockGetShotOutboxStatus.mockResolvedValue({
      state: 'rejected',
      attempts: 2,
      lastError: 'HTTP 422',
    });
    const renderer = await renderDetails();
    expect(textOf(renderer)).toContain('Sync this read first.');
    expect(textOf(renderer)).toContain('refused this read 2 of');
    expect(textOf(renderer)).toContain('HTTP 422');
    expect(byLabel(renderer, 'Build reviewed plan')).toHaveLength(0);
    await unmount(renderer);
  });

  it('offers a new capture, not a plan, once the outbox has given up on the shot', async () => {
    mockHasShotSyncReceipt.mockResolvedValue(false);
    mockGetShotOutboxStatus.mockResolvedValue({
      state: 'exhausted',
      attempts: 8,
      lastError: null,
    });
    const renderer = await renderDetails();
    expect(textOf(renderer)).toContain('The server did not accept this read.');
    expect(byLabel(renderer, 'Build reviewed plan')).toHaveLength(0);
    const capture = control(renderer, 'Capture a new read');
    expect(capture.props.accessibilityRole).toBe('button');
    await press(capture);
    // The sheet's own TRY AGAIN: same-intent handoff + the guided camera.
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    expect(consumeTryAgainHandoff()).toEqual({
      source: 'camera',
      declaredStroke: 'forehand_drive',
      declaredCanonical: 'FOREHAND_DRIVE',
      auto: false,
      sessionId: 's1',
    });
    await unmount(renderer);
  });

  it('is unreachable with honest copy when no outbox record exists for the shot', async () => {
    mockHasShotSyncReceipt.mockResolvedValue(false);
    mockGetShotOutboxStatus.mockResolvedValue({ state: 'absent' });
    const renderer = await renderDetails();
    expect(textOf(renderer)).toContain('could not verify');
    expect(byLabel(renderer, 'Build reviewed plan')).toHaveLength(0);
    await unmount(renderer);
  });

  it('is unreachable when the sync receipt lookup itself fails', async () => {
    mockHasShotSyncReceipt.mockRejectedValue(new Error('sqlite'));
    const renderer = await renderDetails();
    expect(textOf(renderer)).toContain('could not verify');
    expect(byLabel(renderer, 'Build reviewed plan')).toHaveLength(0);
    await unmount(renderer);
  });
});

// ─── Personalized training: plan load retry ─────────────────────────────────

describe('ResultDetails buttons — plan load Try again', () => {
  it('reloads the current plan after a failed load', async () => {
    api.getCurrentPlan.mockRejectedValueOnce(new Error('offline'));
    const renderer = await renderDetails();
    expect(textOf(renderer)).toContain('Training could not be verified.');
    // The sheet has no camera CTA row: this is the ONLY "Try again".
    expect(byLabel(renderer, 'Try again')).toHaveLength(1);
    const retry = control(renderer, 'Try again');
    expect(retry.props.accessibilityRole).toBe('button');
    api.getCurrentPlan.mockResolvedValueOnce(null);
    await press(retry);
    expect(api.getCurrentPlan).toHaveBeenCalledTimes(2);
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
    expect(textOf(renderer)).not.toContain('Training could not be verified.');
    expect(textOf(renderer)).toContain('Turn this read into a plan.');
    await unmount(renderer);
  });

  it('shows the honest error again when the retry also fails', async () => {
    api.getCurrentPlan.mockRejectedValue(new Error('offline'));
    const renderer = await renderDetails();
    await press(control(renderer, 'Try again'));
    expect(api.getCurrentPlan).toHaveBeenCalledTimes(2);
    expect(textOf(renderer)).toContain('Training could not be verified.');
    expect(textOf(renderer)).toContain('Training is temporarily unavailable.');
    await unmount(renderer);
  });
});

// ─── Personalized training: plan drill cards ────────────────────────────────

describe('ResultDetails buttons — PlanDrillCard controls', () => {
  beforeEach(() => {
    api.getCurrentPlan.mockResolvedValue(planFixture());
  });

  it('Save bookmarks the drill on the server and flips the label', async () => {
    const renderer = await renderDetails();
    const save = control(renderer, 'Save Shadow swings');
    expect(save.props.accessibilityRole).toBe('button');
    expect(isDisabled(save)).toBe(false);
    await press(save);
    expect(api.saveDrill).toHaveBeenCalledWith('shadow-swings');
    expect(api.listSavedDrills).toHaveBeenCalled();
    expect(byLabel(renderer, 'Remove Shadow swings')).toHaveLength(1);
    await unmount(renderer);
  });

  it('Remove unsaves a saved drill', async () => {
    const renderer = await renderDetails();
    await press(control(renderer, 'Remove Wall drive'));
    expect(api.unsaveDrill).toHaveBeenCalledWith('wall-drive');
    expect(byLabel(renderer, 'Save Wall drive')).toHaveLength(1);
    await unmount(renderer);
  });

  it('save failure shows the error and re-enables the bookmark', async () => {
    api.saveDrill.mockRejectedValue(new Error('offline'));
    const renderer = await renderDetails();
    await press(control(renderer, 'Save Shadow swings'));
    expect(textOf(renderer)).toContain('Training not changed');
    const save = control(renderer, 'Save Shadow swings');
    expect(isDisabled(save)).toBe(false);
    await unmount(renderer);
  });

  it('every card control is disabled while a mutation is pending', async () => {
    api.saveDrill.mockReturnValue(pendingForever());
    const renderer = await renderDetails();
    await act(async () => {
      control(renderer, 'Save Shadow swings').props.onPress();
    });
    expect(isDisabled(control(renderer, 'Save Shadow swings'))).toBe(true);
    expect(isDisabled(control(renderer, 'Remove Wall drive'))).toBe(true);
    expect(
      isDisabled(control(renderer, 'Confirm completion of Shadow swings')),
    ).toBe(true);
    await act(async () => {
      control(renderer, 'Remove Wall drive').props.onPress();
    });
    expect(api.unsaveDrill).not.toHaveBeenCalled();
    await unmount(renderer);
  });

  it('Watch form opens the canonical watch URL for an embed (never /embed/)', async () => {
    const renderer = await renderDetails();
    const watch = control(
      renderer,
      'Watch reviewed instruction for Shadow swings',
    );
    expect(watch.props.accessibilityRole).toBe('button');
    await press(watch);
    expect(canOpenSpy).toHaveBeenCalledWith(
      'https://www.youtube.com/watch?v=abc123',
    );
    expect(openUrlSpy).toHaveBeenCalledWith(
      'https://www.youtube.com/watch?v=abc123',
    );
    expect(openUrlSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('/embed/'),
    );
    expect(trainingDialog(renderer).props.visible).toBe(false);
    await unmount(renderer);
  });

  it('Watch form opens the playback URL for hosted media', async () => {
    const renderer = await renderDetails();
    await press(control(renderer, 'Watch reviewed instruction for Wall drive'));
    expect(openUrlSpy).toHaveBeenCalledWith(
      'https://cdn.example.test/wall-drive.mp4',
    );
    await unmount(renderer);
  });

  it('Watch form is absent when no media is published', async () => {
    const renderer = await renderDetails();
    expect(
      byLabel(renderer, 'Watch reviewed instruction for Timing toss'),
    ).toHaveLength(0);
    await unmount(renderer);
  });

  it('Watch form alerts when the URL cannot be opened', async () => {
    canOpenSpy.mockResolvedValue(false);
    const renderer = await renderDetails();
    await press(
      control(renderer, 'Watch reviewed instruction for Shadow swings'),
    );
    expect(openUrlSpy).not.toHaveBeenCalled();
    expect(trainingDialog(renderer).props.title).toBe('Video unavailable');
    expect(trainingDialog(renderer).props.detail).toContain(
      'could not be opened',
    );
    await unmount(renderer);
  });

  it('Watch form alerts when opening rejects', async () => {
    openUrlSpy.mockRejectedValue(new Error('no handler'));
    const renderer = await renderDetails();
    await press(
      control(renderer, 'Watch reviewed instruction for Shadow swings'),
    );
    expect(trainingDialog(renderer).props.title).toBe('Video unavailable');
    expect(typeof trainingDialog(renderer).props.detail).toBe('string');
    await unmount(renderer);
  });

  it('Confirm completion asks first, then logs the prescribed work on the server', async () => {
    api.completeDrill.mockResolvedValue(completion);
    const renderer = await renderDetails();
    const confirm = control(renderer, 'Confirm completion of Shadow swings');
    expect(confirm.props.accessibilityRole).toBe('button');
    expect(isDisabled(confirm)).toBe(false);
    await press(confirm);
    expect(api.completeDrill).not.toHaveBeenCalled();
    expect(trainingDialog(renderer).props.title).toBe('Log real practice?');
    expect(trainingDialog(renderer).props.detail).toBe(
      'Confirm only if you completed 3 × 10 reps of “Shadow swings.”',
    );
    expect(
      dialogButton(renderer, 'Log real practice?', 'Not yet').variant,
    ).toBe('dark');
    await act(async () => {
      dialogButton(renderer, 'Log real practice?', 'I completed it').onPress();
    });
    await flush();
    expect(api.completeDrill).toHaveBeenCalledTimes(1);
    expect(api.completeDrill).toHaveBeenCalledWith(
      expect.objectContaining({
        drillSlug: 'shadow-swings',
        trainingPlanItemId: 'item-1',
        actualRepetitions: 30,
        actualDurationSeconds: null,
      }),
    );
    expect(textOf(renderer)).toContain('Completed · streak credit earned');
    expect(textOf(renderer)).toContain('1/3 DONE');
    expect(
      isDisabled(control(renderer, 'Shadow swings completion logged')),
    ).toBe(true);
    expect(mockConsistencyState.recordDrillCompletion).toHaveBeenCalledWith({
      id: 'completion-1',
      slug: 'shadow-swings',
      title: 'Shadow swings',
      completedAtIso: '2026-08-30T11:00:00.000Z',
    });
    await unmount(renderer);
  });

  it('duration prescriptions log seconds, not reps', async () => {
    api.completeDrill.mockResolvedValue({
      ...completion,
      id: 'completion-2',
      actualRepetitions: null,
      actualDurationSeconds: 135,
      qualifiesForStreak: false,
    });
    const renderer = await renderDetails();
    await press(control(renderer, 'Confirm completion of Wall drive'));
    await act(async () => {
      dialogButton(renderer, 'Log real practice?', 'I completed it').onPress();
    });
    await flush();
    expect(api.completeDrill).toHaveBeenCalledWith(
      expect.objectContaining({
        drillSlug: 'wall-drive',
        actualRepetitions: null,
        actualDurationSeconds: 135,
      }),
    );
    expect(textOf(renderer)).toContain('Completion logged');
    expect(mockConsistencyState.recordDrillCompletion).not.toHaveBeenCalled();
    await unmount(renderer);
  });

  it('completion failure shows the error and re-enables the control', async () => {
    api.completeDrill.mockRejectedValue(new Error('offline'));
    const renderer = await renderDetails();
    await press(control(renderer, 'Confirm completion of Shadow swings'));
    await act(async () => {
      dialogButton(renderer, 'Log real practice?', 'I completed it').onPress();
    });
    await flush();
    expect(textOf(renderer)).toContain('Training not changed');
    expect(
      isDisabled(control(renderer, 'Confirm completion of Shadow swings')),
    ).toBe(false);
    expect(useTrainingStore.getState().mutation).toBe('idle');
    await unmount(renderer);
  });

  it('a prescription without a valid target renders honest copy instead of a dead completion control', async () => {
    const renderer = await renderDetails();
    expect(byLabel(renderer, 'Confirm completion of Timing toss')).toHaveLength(
      0,
    );
    expect(textOf(renderer)).not.toContain('I completed this prescription');
    expect(textOf(renderer)).toContain(
      'No sets, reps, or time were prescribed for this drill',
    );
    expect(trainingDialog(renderer).props.visible).toBe(false);
    expect(api.completeDrill).not.toHaveBeenCalled();
    await unmount(renderer);
  });
});

// ─── Personalized training: reassessment ────────────────────────────────────

describe('ResultDetails buttons — Use as reassessment', () => {
  const newerRead = () =>
    evidenceFixture({
      analysis: analysisFixture({
        id: 'a9',
        capturedAtIso: '2026-08-31T10:00:00.000Z',
      }),
      record: { ...recordFixture, id: 'a9' },
      attempts: [],
    });

  beforeEach(() => {
    mockRoute.params = { analysisId: 'a9' };
    mockLoadEvidence.mockResolvedValue(newerRead());
    api.getCurrentPlan.mockResolvedValue(completedPlan());
  });

  it('sends the plan + this shot to the server and renders the verified delta', async () => {
    api.reassessPlan.mockResolvedValue({
      ...completedPlan(),
      status: 'completed',
      reassessmentShotId: 'a9',
      scoreDelta: 0.6,
    });
    const renderer = await renderDetails();
    expect(textOf(renderer)).toContain('Measure the change.');
    const reassess = control(renderer, 'Use as reassessment');
    expect(reassess.props.accessibilityRole).toBe('button');
    expect(isDisabled(reassess)).toBe(false);
    await press(reassess);
    expect(api.reassessPlan).toHaveBeenCalledWith('plan-1', 'a9');
    expect(textOf(renderer)).toContain('REASSESSMENT VERIFIED');
    expect(textOf(renderer)).toContain('+0.6 points');
    await unmount(renderer);
  });

  it('is disabled with pending copy while verifying', async () => {
    api.reassessPlan.mockReturnValue(pendingForever());
    const renderer = await renderDetails();
    await act(async () => {
      control(renderer, 'Use as reassessment').props.onPress();
    });
    const pending = control(renderer, 'Verifying…');
    expect(isDisabled(pending)).toBe(true);
    await act(async () => {
      pending.props.onPress();
    });
    expect(api.reassessPlan).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });

  it('failure shows the error and re-enables the button', async () => {
    api.reassessPlan.mockRejectedValue(new Error('offline'));
    const renderer = await renderDetails();
    await press(control(renderer, 'Use as reassessment'));
    expect(textOf(renderer)).toContain('Training not changed');
    expect(isDisabled(control(renderer, 'Use as reassessment'))).toBe(false);
    await press(control(renderer, 'Dismiss'));
    expect(textOf(renderer)).not.toContain('Training not changed');
    await unmount(renderer);
  });

  it('is unreachable until all three prescriptions are complete', async () => {
    const plan = completedPlan();
    api.getCurrentPlan.mockResolvedValue({
      ...plan,
      items: plan.items.map((item, index) =>
        index === 2 ? { ...item, completion: null } : item,
      ),
    });
    const renderer = await renderDetails();
    expect(byLabel(renderer, 'Use as reassessment')).toHaveLength(0);
    // The read is newer than an active plan for another shot, so the honest
    // alternative is the replace-plan offer, not a dead end.
    expect(textOf(renderer)).toContain('Build from this read instead?');
    await unmount(renderer);
  });
});

// ─── Analysis feedback prompt ───────────────────────────────────────────────

describe('ResultDetails buttons — AnalysisFeedbackPrompt', () => {
  it('is absent without an API session', async () => {
    const renderer = await renderDetails();
    expect(textOf(renderer)).not.toContain('Was this analysis accurate?');
    await unmount(renderer);
  });

  it('Yes submits an accurate rating for this analysis', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockSubmitAnalysisFeedback.mockResolvedValue({ reviewEligible: false });
    const renderer = await renderDetails();
    const yes = byTestID(renderer, 'feedback-yes');
    expect(yes.props.accessibilityRole).toBe('button');
    await press(yes);
    expect(mockSubmitAnalysisFeedback).toHaveBeenCalledWith(
      { baseUrl: 'https://api.test', token: 'token-1' },
      'a1',
      'accurate',
      null,
    );
    expect(textOf(renderer)).toContain('Thanks');
    await unmount(renderer);
  });

  it('Not quite → category chip submits a not_quite rating with the category', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockSubmitAnalysisFeedback.mockResolvedValue({ reviewEligible: true });
    const renderer = await renderDetails();
    await press(byTestID(renderer, 'feedback-not-quite'));
    expect(mockSubmitAnalysisFeedback).not.toHaveBeenCalled();
    expect(textOf(renderer)).toContain('What looked off?');
    for (const category of [
      'wrong_stroke',
      'wrong_player',
      'contact_looks_wrong',
      'feedback_mismatch',
      'other',
    ]) {
      expect(
        byTestID(renderer, `feedback-category-${category}`).props
          .accessibilityRole,
      ).toBe('button');
    }
    await press(byTestID(renderer, 'feedback-category-wrong_stroke'));
    expect(mockSubmitAnalysisFeedback).toHaveBeenCalledWith(
      { baseUrl: 'https://api.test', token: 'token-1' },
      'a1',
      'not_quite',
      'wrong_stroke',
    );
    expect(textOf(renderer)).toContain('Thanks');
    await unmount(renderer);
  });

  it('a failed submission shows error copy and Try again returns to the question', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockSubmitAnalysisFeedback.mockRejectedValue(new Error('offline'));
    const renderer = await renderDetails();
    await press(byTestID(renderer, 'feedback-yes'));
    expect(textOf(renderer)).toContain('Feedback could not be sent right now.');
    const retry = byTestID(renderer, 'feedback-retry');
    expect(retry.props.accessibilityRole).toBe('button');
    await press(retry);
    expect(textOf(renderer)).toContain('Was this analysis accurate?');
    expect(byTestID(renderer, 'feedback-yes')).toBeDefined();
    await unmount(renderer);
  });

  it('is absent (no dead button) when the shot has not synced', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockHasShotSyncReceipt.mockResolvedValue(false);
    const renderer = await renderDetails();
    expect(textOf(renderer)).not.toContain('Was this analysis accurate?');
    await unmount(renderer);
  });

  it('never renders on the guide — the prompt belongs to the breakdown', async () => {
    mockGetApiSession.mockReturnValue(session);
    const renderer = await render();
    expect(textOf(renderer)).not.toContain('Was this analysis accurate?');
    await press(byTestID(renderer, 'result-guide-next'));
    expect(textOf(renderer)).not.toContain('Was this analysis accurate?');
    expect(hasTestID(renderer, 'feedback-yes')).toBe(false);
    await unmount(renderer);
  });
});

// ─── Ledger: no pressable escapes this file ─────────────────────────────────

describe('Result buttons — ledger', () => {
  it('every rendered pressable on the guide has a button role and a label, page by page', async () => {
    mockGetApiSession.mockReturnValue(session);
    const renderer = await render();
    expect(ledger(renderer)).toEqual(['Close', 'Continue']);
    await press(byTestID(renderer, 'result-guide-next'));
    expect(ledger(renderer)).toEqual(['Back', 'Close', 'Done', 'Try it again']);
    await unmount(renderer);
  });

  it('every rendered pressable on the breakdown sheet has a button/tab role and a label', async () => {
    mockGetApiSession.mockReturnValue(session);
    api.getCurrentPlan.mockResolvedValue(planFixture());
    const renderer = await renderDetails();
    // No Close / Done / Try again here: the guide owns the loop's CTAs.
    expect(ledger(renderer)).toEqual(
      [
        'Attempt 1',
        'Attempt 2',
        'Back',
        'Confirm completion of Shadow swings',
        'Confirm completion of Wall drive',
        'Play replay',
        'Remove Wall drive',
        'Save Shadow swings',
        'Save Timing toss',
        'See 2 more',
        'Watch reviewed instruction for Shadow swings',
        'Watch reviewed instruction for Wall drive',
        'feedback-not-quite',
        'feedback-yes',
      ].sort(),
    );
    await unmount(renderer);
  });
});
