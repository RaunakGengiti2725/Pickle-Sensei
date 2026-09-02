import React from 'react';
import { Alert, Linking } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { StrokeIntentEnvelope } from '@pickle/analysis-pipeline';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';
import type { StrokeResultEvidence } from '../../src/components/strokeResultData';
import type { ShotOutboxStatus } from '../../src/data/repository';
import type {
  DrillDetail,
  TrainingApi,
  TrainingPlan,
  TrainingPlanItem,
} from '../../src/training/types';

/**
 * Button ledger for ResultScreen: every pressable the route renders (directly
 * or through StrokeResult / PlanDrillCard / AnalysisFeedbackPrompt) is pressed
 * here and its real observable effect asserted — navigation target + params,
 * training API calls through the real training store, Linking / Alert
 * calls, and the copy the user sees on both the success and failure paths.
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

const mockNavigation = {
  navigate: jest.fn(),
  replace: jest.fn(),
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
jest.mock('../../src/data/repository', () => ({
  hasShotSyncReceipt: (...args: unknown[]) => mockHasShotSyncReceipt(...args),
  getShotOutboxStatus: (...args: unknown[]) => mockGetShotOutboxStatus(...args),
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

import { ResultScreen } from '../../src/screens/ResultScreen';
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
    attempts: attemptRefs,
    ...overrides,
  };
}

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

let alertSpy: jest.SpyInstance;
let canOpenSpy: jest.SpyInstance;
let openUrlSpy: jest.SpyInstance;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function render(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<ResultScreen />);
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

function alertButton(title: string, buttonText: string) {
  const call = alertSpy.mock.calls.find(args => args[0] === title);
  expect(call).toBeDefined();
  const buttons = call![2] as {
    text: string;
    style?: string;
    onPress?: () => void;
  }[];
  const button = buttons.find(entry => entry.text === buttonText);
  expect(button).toBeDefined();
  return button!;
}

function pendingForever<T>() {
  return new Promise<T>(() => {});
}

beforeEach(() => {
  jest.useRealTimers();
  mockNavigation.navigate.mockClear();
  mockNavigation.replace.mockClear();
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

  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  canOpenSpy = jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
  openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

afterEach(() => {
  alertSpy.mockRestore();
  canOpenSpy.mockRestore();
  openUrlSpy.mockRestore();
  jest.useRealTimers();
});

// ─── Loading + missing states ───────────────────────────────────────────────

describe('ResultScreen buttons — loading and missing states', () => {
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
});

// ─── Result surface controls (StrokeResult) ─────────────────────────────────

describe('ResultScreen buttons — result surface', () => {
  it('Close pops to the top of the stack', async () => {
    const renderer = await render();
    await press(control(renderer, 'Close'));
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });

  it('attempt tabs replace the Result route with the tapped attempt; the current one is inert', async () => {
    const renderer = await render();
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
    expect(mockNavigation.replace).not.toHaveBeenCalled();

    await press(control(renderer, 'Attempt 2'));
    expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: 'a2',
    });
    await unmount(renderer);
  });

  it('attempt tabs are hidden for a single-attempt session', async () => {
    mockLoadEvidence.mockResolvedValue(
      evidenceFixture({ attempts: [attemptRefs[0]!] }),
    );
    const renderer = await render();
    expect(
      pressables(renderer).filter(
        node => node.props.accessibilityRole === 'tab',
      ),
    ).toHaveLength(0);
    await unmount(renderer);
  });

  it('Play replay starts the measured-timeline playback and Pause stops it', async () => {
    const renderer = await render();
    jest.useFakeTimers();
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
    jest.useRealTimers();
    await unmount(renderer);
  });

  it('the replay scrubber seeks the playhead from the touch position', async () => {
    const renderer = await render();
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
    const renderer = await render();
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

  it('Try again arms the same declared intent and opens the camera', async () => {
    const renderer = await render();
    const tryAgain = byTestID(renderer, 'stroke-result-try-again');
    expect(tryAgain.props.accessibilityLabel).toBe('Try again');
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
    });
    await unmount(renderer);
  });

  it('Try again on an AUTO run re-arms AUTO, never a fabricated declaration', async () => {
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
    await press(byTestID(renderer, 'stroke-result-try-again'));
    expect(consumeTryAgainHandoff()).toEqual({
      source: 'camera',
      declaredStroke: null,
      declaredCanonical: null,
      auto: true,
    });
    await unmount(renderer);
  });

  it('Done pops to the top of the stack', async () => {
    const renderer = await render();
    const done = byTestID(renderer, 'stroke-result-done');
    expect(done.props.accessibilityLabel).toBe('Done');
    await press(done);
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });

  it('CTAs are present on the abstained (result-null) path too', async () => {
    mockLoadEvidence.mockResolvedValue(
      evidenceFixture({
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
      }),
    );
    const renderer = await render();
    expect(textOf(renderer)).toContain('A score is required.');
    await press(byTestID(renderer, 'stroke-result-try-again'));
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    await press(byTestID(renderer, 'stroke-result-done'));
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });
});

// ─── Personalized training: plan creation ───────────────────────────────────

describe('ResultScreen buttons — Build reviewed plan', () => {
  it('creates a plan from this read and renders it', async () => {
    api.createPlan.mockResolvedValue(planFixture());
    const renderer = await render();
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
    const renderer = await render();
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
    const renderer = await render();
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
    const renderer = await render();
    expect(textOf(renderer)).toContain('Build from this read instead?');
    await press(control(renderer, 'Build reviewed plan'));
    expect(api.createPlan).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'Replace the current plan?',
      expect.stringContaining('supersede'),
      expect.any(Array),
    );
    expect(
      alertButton('Replace the current plan?', 'Keep current plan').style,
    ).toBe('cancel');
    await act(async () => {
      alertButton('Replace the current plan?', 'Replace plan').onPress!();
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
    const renderer = await render();
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
    const renderer = await render();
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
    const renderer = await render();
    expect(textOf(renderer)).toContain('The server did not accept this read.');
    expect(byLabel(renderer, 'Build reviewed plan')).toHaveLength(0);
    await press(control(renderer, 'Capture a new read'));
    expect(mockNavigation.navigate).toHaveBeenCalledWith(
      'Analyze',
      expect.anything(),
    );
    await unmount(renderer);
  });

  it('is unreachable with honest copy when no outbox record exists for the shot', async () => {
    mockHasShotSyncReceipt.mockResolvedValue(false);
    mockGetShotOutboxStatus.mockResolvedValue({ state: 'absent' });
    const renderer = await render();
    expect(textOf(renderer)).toContain('could not verify');
    expect(byLabel(renderer, 'Build reviewed plan')).toHaveLength(0);
    await unmount(renderer);
  });

  it('is unreachable when the sync receipt lookup itself fails', async () => {
    mockHasShotSyncReceipt.mockRejectedValue(new Error('sqlite'));
    const renderer = await render();
    expect(textOf(renderer)).toContain('could not verify');
    expect(byLabel(renderer, 'Build reviewed plan')).toHaveLength(0);
    await unmount(renderer);
  });
});

// ─── Personalized training: plan load retry ─────────────────────────────────

describe('ResultScreen buttons — plan load Try again', () => {
  it('reloads the current plan after a failed load', async () => {
    api.getCurrentPlan.mockRejectedValueOnce(new Error('offline'));
    const renderer = await render();
    expect(textOf(renderer)).toContain('Training could not be verified.');
    const retry = byLabel(renderer, 'Try again').find(
      node => node.props.testID === undefined,
    )!;
    expect(retry).toBeDefined();
    expect(retry.props.accessibilityRole).toBe('button');
    api.getCurrentPlan.mockResolvedValueOnce(null);
    await press(retry);
    expect(api.getCurrentPlan).toHaveBeenCalledTimes(2);
    expect(textOf(renderer)).not.toContain('Training could not be verified.');
    expect(textOf(renderer)).toContain('Turn this read into a plan.');
    await unmount(renderer);
  });

  it('shows the honest error again when the retry also fails', async () => {
    api.getCurrentPlan.mockRejectedValue(new Error('offline'));
    const renderer = await render();
    const retry = byLabel(renderer, 'Try again').find(
      node => node.props.testID === undefined,
    )!;
    await press(retry);
    expect(api.getCurrentPlan).toHaveBeenCalledTimes(2);
    expect(textOf(renderer)).toContain('Training could not be verified.');
    expect(textOf(renderer)).toContain('Training is temporarily unavailable.');
    await unmount(renderer);
  });
});

// ─── Personalized training: plan drill cards ────────────────────────────────

describe('ResultScreen buttons — PlanDrillCard controls', () => {
  beforeEach(() => {
    api.getCurrentPlan.mockResolvedValue(planFixture());
  });

  it('Save bookmarks the drill on the server and flips the label', async () => {
    const renderer = await render();
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
    const renderer = await render();
    await press(control(renderer, 'Remove Wall drive'));
    expect(api.unsaveDrill).toHaveBeenCalledWith('wall-drive');
    expect(byLabel(renderer, 'Save Wall drive')).toHaveLength(1);
    await unmount(renderer);
  });

  it('save failure shows the error and re-enables the bookmark', async () => {
    api.saveDrill.mockRejectedValue(new Error('offline'));
    const renderer = await render();
    await press(control(renderer, 'Save Shadow swings'));
    expect(textOf(renderer)).toContain('Training not changed');
    const save = control(renderer, 'Save Shadow swings');
    expect(isDisabled(save)).toBe(false);
    await unmount(renderer);
  });

  it('every card control is disabled while a mutation is pending', async () => {
    api.saveDrill.mockReturnValue(pendingForever());
    const renderer = await render();
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
    const renderer = await render();
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
    expect(alertSpy).not.toHaveBeenCalled();
    await unmount(renderer);
  });

  it('Watch form opens the playback URL for hosted media', async () => {
    const renderer = await render();
    await press(control(renderer, 'Watch reviewed instruction for Wall drive'));
    expect(openUrlSpy).toHaveBeenCalledWith(
      'https://cdn.example.test/wall-drive.mp4',
    );
    await unmount(renderer);
  });

  it('Watch form is absent when no media is published', async () => {
    const renderer = await render();
    expect(
      byLabel(renderer, 'Watch reviewed instruction for Timing toss'),
    ).toHaveLength(0);
    await unmount(renderer);
  });

  it('Watch form alerts when the URL cannot be opened', async () => {
    canOpenSpy.mockResolvedValue(false);
    const renderer = await render();
    await press(
      control(renderer, 'Watch reviewed instruction for Shadow swings'),
    );
    expect(openUrlSpy).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'Video unavailable',
      expect.stringContaining('could not be opened'),
    );
    await unmount(renderer);
  });

  it('Watch form alerts when opening rejects', async () => {
    openUrlSpy.mockRejectedValue(new Error('no handler'));
    const renderer = await render();
    await press(
      control(renderer, 'Watch reviewed instruction for Shadow swings'),
    );
    expect(alertSpy).toHaveBeenCalledWith(
      'Video unavailable',
      expect.any(String),
    );
    await unmount(renderer);
  });

  it('Confirm completion asks first, then logs the prescribed work on the server', async () => {
    api.completeDrill.mockResolvedValue(completion);
    const renderer = await render();
    const confirm = control(renderer, 'Confirm completion of Shadow swings');
    expect(confirm.props.accessibilityRole).toBe('button');
    expect(isDisabled(confirm)).toBe(false);
    await press(confirm);
    expect(api.completeDrill).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'Log real practice?',
      'Confirm only if you completed 3 × 10 reps of “Shadow swings.”',
      expect.any(Array),
    );
    expect(alertButton('Log real practice?', 'Not yet').style).toBe('cancel');
    await act(async () => {
      alertButton('Log real practice?', 'I completed it').onPress!();
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
    const renderer = await render();
    await press(control(renderer, 'Confirm completion of Wall drive'));
    await act(async () => {
      alertButton('Log real practice?', 'I completed it').onPress!();
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
    const renderer = await render();
    await press(control(renderer, 'Confirm completion of Shadow swings'));
    await act(async () => {
      alertButton('Log real practice?', 'I completed it').onPress!();
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
    const renderer = await render();
    expect(byLabel(renderer, 'Confirm completion of Timing toss')).toHaveLength(
      0,
    );
    expect(textOf(renderer)).not.toContain('I completed this prescription');
    expect(textOf(renderer)).toContain(
      'No sets, reps, or time were prescribed for this drill',
    );
    expect(alertSpy).not.toHaveBeenCalled();
    expect(api.completeDrill).not.toHaveBeenCalled();
    await unmount(renderer);
  });
});

// ─── Personalized training: reassessment ────────────────────────────────────

describe('ResultScreen buttons — Use as reassessment', () => {
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
    const renderer = await render();
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
    const renderer = await render();
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
    const renderer = await render();
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
    const renderer = await render();
    expect(byLabel(renderer, 'Use as reassessment')).toHaveLength(0);
    // The read is newer than an active plan for another shot, so the honest
    // alternative is the replace-plan offer, not a dead end.
    expect(textOf(renderer)).toContain('Build from this read instead?');
    await unmount(renderer);
  });
});

// ─── Analysis feedback prompt ───────────────────────────────────────────────

describe('ResultScreen buttons — AnalysisFeedbackPrompt', () => {
  const session = {
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    canonicalAppUserId: 'user-1',
    provider: 'apple',
  };

  it('is absent without an API session', async () => {
    const renderer = await render();
    expect(textOf(renderer)).not.toContain('Was this analysis accurate?');
    await unmount(renderer);
  });

  it('Yes submits an accurate rating for this analysis', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockSubmitAnalysisFeedback.mockResolvedValue({ reviewEligible: false });
    const renderer = await render();
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
    const renderer = await render();
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
    const renderer = await render();
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
    const renderer = await render();
    expect(textOf(renderer)).not.toContain('Was this analysis accurate?');
    await unmount(renderer);
  });
});

// ─── Ledger: no pressable escapes this file ─────────────────────────────────

describe('ResultScreen buttons — ledger', () => {
  it('every rendered pressable on the plan surface has a button/tab role and a label', async () => {
    mockGetApiSession.mockReturnValue({
      apiBaseUrl: 'https://api.test',
      bearerToken: 'token-1',
      canonicalAppUserId: 'user-1',
      provider: 'apple',
    });
    api.getCurrentPlan.mockResolvedValue(planFixture());
    const renderer = await render();
    const seen = new Set<string>();
    for (const node of pressables(renderer)) {
      expect(['button', 'tab']).toContain(node.props.accessibilityRole);
      const label: unknown = node.props.accessibilityLabel;
      const testID: unknown = node.props.testID;
      // Feedback chips carry descriptive visible text instead of a label.
      if (typeof label !== 'string') {
        expect(typeof testID).toBe('string');
        expect(String(testID).startsWith('feedback-')).toBe(true);
      }
      seen.add(typeof label === 'string' ? label : String(testID));
    }
    expect([...seen].sort()).toEqual(
      [
        'Attempt 1',
        'Attempt 2',
        'Close',
        'Confirm completion of Shadow swings',
        'Confirm completion of Wall drive',
        'Done',
        'Play replay',
        'Remove Wall drive',
        'Save Shadow swings',
        'Save Timing toss',
        'See 2 more',
        'Try again',
        'Watch reviewed instruction for Shadow swings',
        'Watch reviewed instruction for Wall drive',
        'feedback-not-quite',
        'feedback-yes',
      ].sort(),
    );
    await unmount(renderer);
  });
});
