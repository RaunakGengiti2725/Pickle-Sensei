/**
 * Stress — ResultDetailsScreen under rapid / concurrent interaction.
 *
 * The screen is mounted inside a REAL `NavigationContainer` + native stack
 * (Tabs stub → real ResultScreen → real ResultDetailsScreen; Analyze and
 * FormReview are recording stubs) with the real Zustand training store, the
 * real evidence/sync hooks and the real design-system pressables. Only the
 * data seams (SQLite repository, evidence loader, pose sidecar, training API,
 * feedback API, api session) and native modules (safe-area, svg) are mocked.
 *
 * A seeded generator scripts interaction bursts — same-tick double/triple
 * taps, spaced double taps, taps while evidence is still loading, header Back
 * while sequence/sync/plan requests are in flight, two different controls in
 * one tick, and navigation spam through the container ref. After every burst
 * the scenario settles (fake timers + microtasks) and the observed world is
 * compared with an intent model: one navigation per intent, one training
 * request per intent, one feedback submission per intent, one evidence load
 * per mounted (screen, analysisId), no orphan spinner / mutation / replay
 * timer, at most one visible modal, no console.error/warn (act() warnings
 * included), no unhandled rejection.
 *
 * Every iteration is replayable from its seed:
 *   STRESS_SEED=<n> npx jest --ci __tests__/stress/resultDetailsScreen.rapidInteraction
 * Campaign size (default 12 keeps the suite fast):
 *   STRESS_ITER=300 STRESS_OUT=/tmp/rd-stress.json npx jest --ci __tests__/stress/resultDetailsScreen.rapidInteraction
 *
 * Same-tick multi-taps deliberately re-enter a handler before React commits
 * the first press. As of 1fb0efd7 three controls have no re-entry guard and
 * fail that mode deterministically (the spaced-tap mode of the same controls
 * holds because the first commit removes or disables them):
 *   - header Back / "Go back": N goBack() calls pop N routes (e.g. seed 1013
 *     leaves [Tabs] instead of [Tabs, Result]);
 *   - feedback category chip: N submitAnalysisFeedback requests (seed 1192);
 *   - training-plan "Try again": N getCurrentPlan requests (seed 1028).
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
jest.mock('../../src/data/repository', () => ({
  hasShotSyncReceipt: (...args: unknown[]) => mockHasShotSyncReceipt(...args),
  getShotOutboxStatus: (...args: unknown[]) => mockGetShotOutboxStatus(...args),
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
}));

const mockGetApiSession = jest.fn();
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
  reportApiUnauthorized: jest.fn(),
}));

const mockListCatalogDrills = jest.fn();
jest.mock('../../src/training/api', () => ({
  createTrainingApi: () => ({ listCatalogDrills: mockListCatalogDrills }),
}));

const mockSubmitFeedback = jest.fn();
jest.mock('../../src/data/api', () => {
  const actual = jest.requireActual('../../src/data/api');
  return {
    ...actual,
    submitAnalysisFeedback: (...args: unknown[]) => mockSubmitFeedback(...args),
  };
});

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
jest.mock('../../src/consistency/DaySecuredBanner', () => ({
  DaySecuredBanner: () => null,
}));

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
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
    Ellipse: Mock,
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

import React, { useEffect } from 'react';
import { Modal, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  CommonActions,
  NavigationContainer,
  createNavigationContainerRef,
  useRoute,
  type NavigationAction,
  type NavigationState,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import type { RootStackParams } from '../../src/navigation/params';
import { ResultScreen } from '../../src/screens/ResultScreen';
import { ResultDetailsScreen } from '../../src/screens/ResultDetailsScreen';
import {
  clearTryAgainHandoff,
  consumeTryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';
import type {
  ReviewJoint,
  ReviewPoseFrame,
  ReviewPoseSequence,
} from '../../src/review/formReviewModel';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import type {
  DrillDetail,
  TrainingApi,
  TrainingPlan,
} from '../../src/training/types';
import { TrainingError } from '../../src/training/types';

declare const process: {
  env: Record<string, string | undefined>;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};
const { writeFileSync } = require('fs') as {
  writeFileSync: (path: string, data: string) => void;
};

// ─── Seeded RNG ─────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

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

const CURRENT_ID = 'analysis-1';
const OTHER_ID = 'analysis-0';

function scoredAnalysis(id: string): ShotAnalysis {
  return {
    id,
    sessionId: 'set-1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso:
      id === CURRENT_ID
        ? '2026-09-01T10:00:00.000Z'
        : '2026-09-01T09:55:00.000Z',
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

function declaredRecord(id: string): StrokeResultEvidenceRecord {
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
      limitingFactors: [
        'paddle_track_unavailable',
        'ball_track_unavailable',
        'court_geometry_unavailable',
      ],
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

function scoredEvidence(id: string) {
  return {
    analysis: scoredAnalysis(id),
    record: declaredRecord(id),
    clip: {
      uri: 'file:///captures/clip.mov',
      durationMs: 3400,
      posterUri: 'file:///captures/clip.poster.jpg',
    },
    review: { width: 1080, height: 1920, poseSequence: sidecarRef },
    attempts: [
      {
        analysisId: OTHER_ID,
        capturedAtIso: '2026-09-01T09:55:00.000Z',
        sessionId: 'set-1',
      },
      {
        analysisId: CURRENT_ID,
        capturedAtIso: '2026-09-01T10:00:00.000Z',
        sessionId: 'set-1',
      },
    ],
  };
}

const missingEvidence = {
  analysis: null,
  record: null,
  clip: null,
  review: null,
  attempts: [],
};

function drillDetail(slug: string): DrillDetail {
  return {
    id: `drill-${slug}`,
    slug,
    title: `Drill ${slug}`,
    description: 'Reviewed drill.',
    coachName: 'Coach',
    equipment: [],
    difficultyMin: null,
    difficultyMax: null,
    saved: false,
    mappings: [],
    instructionalMedia: [],
  };
}

function planFixture(sourceShotId: string, planId: string): TrainingPlan {
  const drill = (slug: string) => ({
    slug,
    title: `Drill ${slug}`,
    description: 'Reviewed drill.',
    coachName: 'Coach',
    equipment: [],
    saved: false,
  });
  return {
    id: planId,
    status: 'active',
    algorithmVersion: 'plan-v1',
    sourceShotId,
    shotType: 'forehand_drive',
    priorityCheckpoint: 'contact_position',
    priorityDirection: 'late',
    baselineScore: 7.1,
    baselineCheckpointScore: 48,
    reassessmentShotId: null,
    scoreDelta: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    completedAt: null,
    items: [
      {
        id: `${planId}-1`,
        position: 1,
        kind: 'warmup',
        drill: drill('warmup-a'),
        cueText: null,
        targetSets: 2,
        targetRepetitionsPerSet: 10,
        targetDurationSeconds: null,
        restSeconds: 30,
        completion: null,
      },
      {
        id: `${planId}-2`,
        position: 2,
        kind: 'targeted',
        drill: drill('targeted-b'),
        cueText: null,
        targetSets: 3,
        targetRepetitionsPerSet: 8,
        targetDurationSeconds: null,
        restSeconds: 30,
        completion: null,
      },
      {
        id: `${planId}-3`,
        position: 3,
        kind: 'targeted',
        drill: drill('targeted-c'),
        cueText: null,
        targetSets: null,
        targetRepetitionsPerSet: null,
        targetDurationSeconds: 120,
        restSeconds: 30,
        completion: null,
      },
    ],
  };
}

// ─── Scenario generation ────────────────────────────────────────────────────

type EvidenceKind = 'scored' | 'missing' | 'rejected';
type SyncKind =
  'synced' | 'pending' | 'rejected' | 'exhausted' | 'absent' | 'error';
type TrainingKind =
  'unconfigured' | 'no-plan' | 'active-other' | 'plan-for-this' | 'error';

interface Env {
  evidence: EvidenceKind;
  evidenceDelayMs: number;
  sequenceDelayMs: number;
  sync: SyncKind;
  syncDelayMs: number;
  training: TrainingKind;
  planDelayMs: number;
  mutationDelayMs: number;
  mutationFails: boolean;
  signedIn: boolean;
  feedbackDelayMs: number;
  feedbackFails: boolean;
}

type Target =
  | 'back'
  | 'goBackMissing'
  | 'formReview'
  | 'fixReview'
  | 'attemptChip'
  | 'captureNew'
  | 'buildPlan'
  | 'dialogKeep'
  | 'dialogReplace'
  | 'dialogNotYet'
  | 'dialogConfirmComplete'
  | 'dialogGotIt'
  | 'planRetry'
  | 'planSave'
  | 'planComplete'
  | 'feedbackYes'
  | 'feedbackNotQuite'
  | 'feedbackCategory'
  | 'feedbackRetry'
  | 'seeMore'
  | 'play';

type Step =
  | { t: 'tap'; target: Target; count: number; gapMs: number }
  | { t: 'wait'; ms: number }
  | { t: 'popTop' }
  | { t: 'pushDetails'; analysisId: string };

type BurstKind =
  | 'same-tick-multi-tap'
  | 'spaced-multi-tap'
  | 'tap-during-load'
  | 'back-during-async'
  | 'simultaneous-controls'
  | 'nav-spam'
  | 'mixed';

interface Scenario {
  seed: number;
  burst: BurstKind;
  env: Env;
  steps: Step[];
}

const ALL_TARGETS: readonly Target[] = [
  'back',
  'formReview',
  'fixReview',
  'attemptChip',
  'captureNew',
  'buildPlan',
  'dialogReplace',
  'dialogKeep',
  'planRetry',
  'planSave',
  'planComplete',
  'dialogConfirmComplete',
  'dialogNotYet',
  'feedbackYes',
  'feedbackNotQuite',
  'feedbackCategory',
  'feedbackRetry',
  'seeMore',
  'play',
  'goBackMissing',
  'dialogGotIt',
];

/**
 * Controls the loaded screen renders for this environment (INFERRED from
 * ResultScreen.TrainingPlanSection / AnalysisFeedbackPrompt branches). The
 * generator draws mostly from this set so bursts land on real controls; a
 * slice of every burst still draws from ALL_TARGETS to exercise the absent
 * paths.
 */
function applicableTargets(env: Env): readonly Target[] {
  if (env.evidence !== 'scored') return ['back', 'goBackMissing'];
  const targets: Target[] = [
    'back',
    'formReview',
    'fixReview',
    'attemptChip',
    'play',
    'seeMore',
  ];
  const planReady =
    env.training === 'no-plan' || env.training === 'active-other';
  if (planReady && env.sync === 'synced') targets.push('buildPlan');
  if (planReady && env.sync === 'exhausted') targets.push('captureNew');
  if (env.training === 'error') targets.push('planRetry');
  if (env.training === 'plan-for-this')
    targets.push('planSave', 'planComplete');
  if (env.sync === 'synced' && env.signedIn)
    targets.push('feedbackYes', 'feedbackNotQuite');
  return targets;
}

/** Draw a target, mostly applicable, with a follow-up for two-step controls. */
function drawTargets(rng: Rng, env: Env): Target[] {
  const primary = rng.chance(0.15)
    ? rng.pick(ALL_TARGETS)
    : rng.pick(applicableTargets(env));
  switch (primary) {
    case 'buildPlan':
      return env.training === 'active-other'
        ? [primary, rng.pick<Target>(['dialogReplace', 'dialogKeep'])]
        : [primary];
    case 'planComplete':
      return [
        primary,
        rng.pick<Target>(['dialogConfirmComplete', 'dialogNotYet']),
      ];
    case 'feedbackNotQuite':
      return [primary, 'feedbackCategory'];
    case 'feedbackYes':
      return env.feedbackFails ? [primary, 'feedbackRetry'] : [primary];
    default:
      return [primary];
  }
}

function generateScenario(seed: number): Scenario {
  const rng = new Rng(seed);
  const burst = rng.pick<BurstKind>([
    'same-tick-multi-tap',
    'spaced-multi-tap',
    'tap-during-load',
    'back-during-async',
    'simultaneous-controls',
    'nav-spam',
    'mixed',
  ]);
  const env: Env = {
    evidence: rng.chance(0.78)
      ? 'scored'
      : rng.chance(0.5)
        ? 'missing'
        : 'rejected',
    evidenceDelayMs: rng.pick([0, 10, 80, 400]),
    sequenceDelayMs: rng.pick([0, 30, 200]),
    sync: rng.pick<SyncKind>([
      'synced',
      'synced',
      'synced',
      'pending',
      'rejected',
      'exhausted',
      'absent',
      'error',
    ]),
    syncDelayMs: rng.pick([0, 20, 120]),
    training: rng.pick<TrainingKind>([
      'unconfigured',
      'no-plan',
      'no-plan',
      'active-other',
      'plan-for-this',
      'error',
    ]),
    planDelayMs: rng.pick([0, 20, 120]),
    mutationDelayMs: rng.pick([10, 100]),
    mutationFails: rng.chance(0.25),
    signedIn: rng.chance(0.7),
    feedbackDelayMs: rng.pick([0, 40]),
    feedbackFails: rng.chance(0.3),
  };
  const loadWait =
    env.evidenceDelayMs +
    Math.max(env.sequenceDelayMs, env.syncDelayMs, env.planDelayMs) +
    10;
  const steps: Step[] = [];
  const tap = (target: Target, count: number, gapMs: number): Step => ({
    t: 'tap',
    target,
    count,
    gapMs,
  });
  switch (burst) {
    case 'same-tick-multi-tap': {
      steps.push({ t: 'wait', ms: loadWait });
      const n = 1 + rng.int(3);
      for (let i = 0; i < n; i += 1) {
        for (const target of drawTargets(rng, env)) {
          steps.push(tap(target, 2 + rng.int(2), 0));
          steps.push({ t: 'wait', ms: rng.pick([0, 50, 300]) });
        }
      }
      break;
    }
    case 'spaced-multi-tap': {
      steps.push({ t: 'wait', ms: loadWait });
      const n = 1 + rng.int(3);
      for (let i = 0; i < n; i += 1) {
        for (const target of drawTargets(rng, env)) {
          steps.push(tap(target, 2 + rng.int(2), rng.pick([1, 16, 60])));
          steps.push({ t: 'wait', ms: rng.pick([0, 50, 300]) });
        }
      }
      break;
    }
    case 'tap-during-load': {
      // Only the header Back exists while the evidence is loading.
      steps.push({ t: 'wait', ms: rng.pick([0, 5]) });
      if (rng.chance(0.5)) steps.push(tap('back', 1 + rng.int(3), 0));
      else steps.push({ t: 'popTop' });
      if (rng.chance(0.4))
        steps.push({ t: 'pushDetails', analysisId: CURRENT_ID });
      steps.push({ t: 'wait', ms: loadWait });
      if (rng.chance(0.5))
        steps.push(tap(drawTargets(rng, env)[0] as Target, 1, 0));
      break;
    }
    case 'back-during-async': {
      steps.push({ t: 'wait', ms: env.evidenceDelayMs + 1 });
      const pre = rng.pick(
        applicableTargets(env).filter(target =>
          [
            'buildPlan',
            'play',
            'feedbackYes',
            'planRetry',
            'planSave',
          ].includes(target),
        ),
      ) as Target | undefined;
      if (pre && rng.chance(0.7)) steps.push(tap(pre, 1, 0));
      steps.push({ t: 'wait', ms: rng.pick([0, 5]) });
      steps.push(
        tap(rng.chance(0.3) ? 'attemptChip' : 'back', 1 + rng.int(2), 0),
      );
      steps.push({ t: 'wait', ms: loadWait + 200 });
      break;
    }
    case 'simultaneous-controls': {
      steps.push({ t: 'wait', ms: loadWait });
      const n = 1 + rng.int(2);
      for (let i = 0; i < n; i += 1) {
        const a = drawTargets(rng, env)[0] as Target;
        let b = drawTargets(rng, env)[0] as Target;
        if (b === a) b = drawTargets(rng, env)[0] as Target;
        steps.push(tap(a, 1, 0));
        steps.push(tap(b, 1, 0));
        steps.push({ t: 'wait', ms: rng.pick([0, 50, 300]) });
      }
      break;
    }
    case 'nav-spam': {
      steps.push({ t: 'wait', ms: rng.chance(0.3) ? 0 : loadWait });
      const n = 3 + rng.int(5);
      for (let i = 0; i < n; i += 1) {
        const roll = rng.int(6);
        if (roll === 0) steps.push({ t: 'popTop' });
        else if (roll === 1)
          steps.push({
            t: 'pushDetails',
            analysisId: rng.chance(0.7) ? CURRENT_ID : OTHER_ID,
          });
        else
          steps.push(
            tap(
              rng.pick<Target>([
                'back',
                'formReview',
                'fixReview',
                'attemptChip',
                'captureNew',
                'goBackMissing',
              ]),
              1 + rng.int(2),
              rng.pick([0, 0, 16]),
            ),
          );
        steps.push({ t: 'wait', ms: rng.pick([0, 0, 20, loadWait]) });
      }
      break;
    }
    case 'mixed': {
      const n = 3 + rng.int(6);
      for (let i = 0; i < n; i += 1) {
        const roll = rng.int(8);
        if (roll === 0) steps.push({ t: 'popTop' });
        else if (roll === 1)
          steps.push({ t: 'pushDetails', analysisId: CURRENT_ID });
        else if (roll === 2) steps.push({ t: 'wait', ms: loadWait });
        else
          for (const target of drawTargets(rng, env))
            steps.push(tap(target, 1 + rng.int(3), rng.pick([0, 0, 1, 40])));
        steps.push({ t: 'wait', ms: rng.pick([0, 5, 60]) });
      }
      break;
    }
  }
  return { seed, burst, env, steps };
}

// ─── Controlled async seams ─────────────────────────────────────────────────

function later<T>(ms: number, produce: () => T): Promise<T> {
  if (ms <= 0) return Promise.resolve().then(produce);
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(produce());
      } catch (error) {
        reject(error);
      }
    }, ms);
  });
}

interface Counters {
  evidenceLoads: Record<string, number>;
  getCurrentPlan: number;
  createPlan: number;
  saveDrill: number;
  completeDrill: number;
  feedback: number;
  analyzeMounts: number;
  analyzeMountsWithoutHandoff: number;
  formReviewMounts: number;
  evidenceIntents: Record<string, number>;
  detailsMounts: number;
  resultMounts: number;
  planRetryLanded: number;
}

function freshCounters(): Counters {
  return {
    evidenceLoads: {},
    getCurrentPlan: 0,
    createPlan: 0,
    saveDrill: 0,
    completeDrill: 0,
    feedback: 0,
    analyzeMounts: 0,
    analyzeMountsWithoutHandoff: 0,
    formReviewMounts: 0,
    evidenceIntents: {},
    detailsMounts: 0,
    resultMounts: 0,
    planRetryLanded: 0,
  };
}

let counters = freshCounters();

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

function installSeams(env: Env) {
  mockLoadEvidence.mockImplementation((_db: unknown, id: string) => {
    bump(counters.evidenceLoads, id);
    return later(env.evidenceDelayMs, () => {
      if (env.evidence === 'rejected') throw new Error('sqlite read failed');
      if (env.evidence === 'missing') return missingEvidence;
      return scoredEvidence(id);
    });
  });
  mockLoadSequence.mockImplementation(() =>
    later(env.sequenceDelayMs, fullBodySequence),
  );
  mockHasShotSyncReceipt.mockImplementation(() =>
    later(env.syncDelayMs, () => {
      if (env.sync === 'error') throw new Error('sqlite read failed');
      return env.sync === 'synced';
    }),
  );
  mockGetShotOutboxStatus.mockImplementation(() =>
    later(0, () => {
      switch (env.sync) {
        case 'pending':
          return { state: 'queued', attempts: 1, lastError: null };
        case 'rejected':
          return { state: 'rejected', attempts: 2, lastError: 'HTTP 422' };
        case 'exhausted':
          return { state: 'exhausted', attempts: 8, lastError: 'HTTP 422' };
        default:
          return { state: 'absent' };
      }
    }),
  );
  mockListRealAnalysisFacts.mockResolvedValue([]);
  mockListCatalogDrills.mockResolvedValue([]);
  mockGetApiSession.mockReturnValue(
    env.signedIn
      ? {
          apiBaseUrl: 'https://example.invalid',
          bearerToken: 'test-bearer',
          canonicalAppUserId: 'user-1',
          provider: 'apple',
        }
      : null,
  );
  mockSubmitFeedback.mockImplementation(() => {
    counters.feedback += 1;
    return later(env.feedbackDelayMs, () => {
      if (env.feedbackFails) throw new Error('network');
      return { status: 'recorded' };
    });
  });

  if (env.training === 'unconfigured') {
    clearTrainingStoreConfiguration();
    return;
  }
  const activeOther = planFixture(OTHER_ID, 'plan-other');
  const forThis = planFixture(CURRENT_ID, 'plan-this');
  const mutation = <T,>(produce: () => T) =>
    later(env.mutationDelayMs, () => {
      if (env.mutationFails) {
        throw new TrainingError(
          'server_error',
          'Training server error',
          true,
          503,
        );
      }
      return produce();
    });
  const api: TrainingApi = {
    listSavedDrills: async () => [],
    getDrill: async slug => later(0, () => drillDetail(slug)),
    saveDrill: async () => {
      counters.saveDrill += 1;
      await mutation(() => undefined);
    },
    unsaveDrill: async () => {
      counters.saveDrill += 1;
      await mutation(() => undefined);
    },
    getCurrentPlan: () => {
      counters.getCurrentPlan += 1;
      return later(env.planDelayMs, () => {
        switch (env.training) {
          case 'error':
            throw new TrainingError(
              'server_error',
              'Training server error',
              true,
              503,
            );
          case 'active-other':
            return activeOther;
          case 'plan-for-this':
            return forThis;
          default:
            return null;
        }
      });
    },
    createPlan: sourceShotId => {
      counters.createPlan += 1;
      return mutation(() =>
        planFixture(sourceShotId, `plan-created-${counters.createPlan}`),
      );
    },
    completeDrill: evidence => {
      counters.completeDrill += 1;
      return mutation(() => ({
        id: `completion-${counters.completeDrill}`,
        completedAt: evidence.completedAt,
        actualRepetitions: evidence.actualRepetitions,
        actualDurationSeconds: evidence.actualDurationSeconds,
        qualifiesForStreak: true,
      }));
    },
    reassessPlan: (planId, shotId) => {
      return mutation(() => ({
        ...planFixture(shotId, planId),
        status: 'completed' as const,
      }));
    },
  };
  configureTrainingStore(api);
}

// ─── Navigator under test ───────────────────────────────────────────────────

const Stack = createNativeStackNavigator<RootStackParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();

function TabsStub() {
  return <Text>Tabs stub</Text>;
}

function AnalyzeStub() {
  useEffect(() => {
    counters.analyzeMounts += 1;
    if (consumeTryAgainHandoff() === null) {
      counters.analyzeMountsWithoutHandoff += 1;
    }
  }, []);
  return <Text>Analyze stub</Text>;
}

function FormReviewStub() {
  const route = useRoute();
  useEffect(() => {
    counters.formReviewMounts += 1;
  }, []);
  return <Text>{`FormReview ${JSON.stringify(route.params)}`}</Text>;
}

function ResultRoute() {
  const route = useRoute<{
    key: string;
    name: 'Result';
    params: { analysisId: string };
  }>();
  useEffect(() => {
    counters.resultMounts += 1;
  }, []);
  useEffect(() => {
    bump(counters.evidenceIntents, route.params.analysisId);
  }, [route.params.analysisId]);
  return <ResultScreen />;
}

function ResultDetailsRoute() {
  const route = useRoute<{
    key: string;
    name: 'ResultDetails';
    params: { analysisId: string };
  }>();
  useEffect(() => {
    counters.detailsMounts += 1;
  }, []);
  useEffect(() => {
    bump(counters.evidenceIntents, route.params.analysisId);
  }, [route.params.analysisId]);
  return <ResultDetailsScreen />;
}

function Harness(props: {
  onUnhandledAction: (action: NavigationAction) => void;
}) {
  return (
    <NavigationContainer
      ref={navigationRef}
      onUnhandledAction={props.onUnhandledAction}
      initialState={{
        index: 2,
        routes: [
          { name: 'Tabs' },
          { name: 'Result', params: { analysisId: CURRENT_ID } },
          { name: 'ResultDetails', params: { analysisId: CURRENT_ID } },
        ],
      }}
    >
      <Stack.Navigator
        screenOptions={{ headerShown: false, animation: 'none' }}
      >
        <Stack.Screen name="Tabs" component={TabsStub} />
        <Stack.Screen name="Analyze" component={AnalyzeStub} />
        <Stack.Screen name="Result" component={ResultRoute} />
        <Stack.Screen name="ResultDetails" component={ResultDetailsRoute} />
        <Stack.Screen name="FormReview" component={FormReviewStub} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// ─── Tree helpers ───────────────────────────────────────────────────────────

type Instance = ReactTestRenderer['root'];

function routeStack(): { name: string; params: unknown }[] {
  const state: NavigationState | undefined = navigationRef.isReady()
    ? navigationRef.getRootState()
    : undefined;
  return (state?.routes ?? []).map(route => ({
    name: route.name,
    params: route.params,
  }));
}

function topRouteName(): string | null {
  const stack = routeStack();
  return stack.length
    ? (stack[stack.length - 1] as { name: string }).name
    : null;
}

function topAnalysisId(): string {
  const stack = routeStack();
  const params = stack.length
    ? (stack[stack.length - 1] as { params: unknown }).params
    : undefined;
  const id =
    typeof params === 'object' && params !== null
      ? (params as { analysisId?: unknown }).analysisId
      : undefined;
  return typeof id === 'string' ? id : CURRENT_ID;
}

function detailsSubtree(renderer: ReactTestRenderer): Instance | null {
  const screens = renderer.root.findAll(
    node =>
      (node.type as unknown) === 'RNSScreen' &&
      typeof node.props.screenId === 'string' &&
      node.props.screenId.startsWith('ResultDetails-'),
  );
  return screens.length ? (screens[screens.length - 1] as Instance) : null;
}

function pressables(
  root: Instance,
  predicate: (props: Record<string, unknown>) => boolean,
) {
  return root.findAll(
    node =>
      typeof node.type !== 'string' &&
      typeof node.props.onPress === 'function' &&
      predicate(node.props),
  );
}

function hostsByTestId(root: Instance, testID: string) {
  return root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function label(props: Record<string, unknown>): string {
  return typeof props.accessibilityLabel === 'string'
    ? props.accessibilityLabel
    : '';
}
function testId(props: Record<string, unknown>): string {
  return typeof props.testID === 'string' ? props.testID : '';
}

function findTarget(
  renderer: ReactTestRenderer,
  target: Target,
  rng: Rng,
): Instance | null {
  const details = detailsSubtree(renderer);
  if (!details) return null;
  const first = (predicate: (props: Record<string, unknown>) => boolean) => {
    const found = pressables(details, predicate);
    return found.length ? (found[0] as Instance) : null;
  };
  switch (target) {
    case 'back':
      return first(p => label(p) === 'Back');
    case 'goBackMissing':
      return first(p => label(p) === 'Go back');
    case 'formReview':
      return first(p => testId(p).startsWith('form-review-card'));
    case 'fixReview': {
      const found = pressables(details, p =>
        /^fix-item-.+-review$/.test(testId(p)),
      );
      return found.length ? (found[rng.int(found.length)] as Instance) : null;
    }
    case 'attemptChip':
      return first(p => label(p) === 'Attempt 1');
    case 'captureNew':
      return first(p => label(p) === 'Capture a new read');
    case 'buildPlan':
      return first(
        p =>
          label(p) === 'Build reviewed plan' || label(p) === 'Building plan…',
      );
    case 'dialogKeep':
      return first(p => label(p) === 'Keep current plan');
    case 'dialogReplace':
      return first(p => label(p) === 'Replace plan');
    case 'dialogNotYet':
      return first(p => label(p) === 'Not yet');
    case 'dialogConfirmComplete':
      return first(p => label(p) === 'I completed it');
    case 'dialogGotIt':
      return first(p => label(p) === 'Got it');
    case 'planRetry': {
      const section = hostsByTestId(details, 'training-plan-section')[0];
      if (!section) return null;
      const found = pressables(
        section as Instance,
        p => label(p) === 'Try again',
      );
      return found.length ? (found[0] as Instance) : null;
    }
    case 'planSave':
      return first(p => /^(Save|Remove) Drill /.test(label(p)));
    case 'planComplete':
      return first(p => label(p).startsWith('Confirm completion of'));
    case 'feedbackYes':
      return first(p => testId(p) === 'feedback-yes');
    case 'feedbackNotQuite':
      return first(p => testId(p) === 'feedback-not-quite');
    case 'feedbackCategory': {
      const found = pressables(details, p =>
        testId(p).startsWith('feedback-category-'),
      );
      return found.length ? (found[rng.int(found.length)] as Instance) : null;
    }
    case 'feedbackRetry':
      return first(p => testId(p) === 'feedback-retry');
    case 'seeMore':
      return first(
        p => /^See \d+ more$/.test(label(p)) || label(p) === 'Show fewer rows',
      );
    case 'play':
      return first(
        p => label(p) === 'Play replay' || label(p) === 'Pause replay',
      );
  }
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  if (ms <= 0) {
    await flushMicrotasks();
    return;
  }
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 50);
    await act(async () => {
      jest.advanceTimersByTime(chunk);
      await Promise.resolve();
      await Promise.resolve();
    });
    remaining -= chunk;
  }
}

// ─── Intent model ───────────────────────────────────────────────────────────

interface ModelRoute {
  name: string;
  params: Record<string, unknown> | undefined;
}

class IntentModel {
  stack: ModelRoute[] = [
    { name: 'Tabs', params: undefined },
    { name: 'Result', params: { analysisId: CURRENT_ID } },
    { name: 'ResultDetails', params: { analysisId: CURRENT_ID } },
  ];
  analyzePushes = 0;
  formReviewPushes = 0;
  createPlanIntents = 0;
  saveIntents = 0;
  completeIntents = 0;
  feedbackIntents = 0;
  retryIntents = 0;
  detailsMounts = 1;
  resultMounts = 1;
  evidenceIntents: Record<string, number> = { [CURRENT_ID]: 2 };

  private top(): ModelRoute {
    return this.stack[this.stack.length - 1] as ModelRoute;
  }
  goBack() {
    if (this.stack.length > 1) this.stack.pop();
  }
  navigate(name: string, params: Record<string, unknown> | undefined) {
    if (this.top().name === name) {
      this.top().params = params;
      return;
    }
    this.stack.push({ name, params });
    if (name === 'Analyze') this.analyzePushes += 1;
    if (name === 'FormReview') this.formReviewPushes += 1;
    if (name === 'ResultDetails') {
      this.detailsMounts += 1;
      bump(this.evidenceIntents, String(params?.analysisId));
    }
  }
  popTo(name: string, params: Record<string, unknown>) {
    let index = -1;
    for (let i = this.stack.length - 1; i >= 0; i -= 1) {
      if ((this.stack[i] as ModelRoute).name === name) {
        index = i;
        break;
      }
    }
    if (index === -1) {
      this.stack.pop();
      this.stack.push({ name, params });
      if (name === 'Result') {
        this.resultMounts += 1;
        bump(this.evidenceIntents, String(params.analysisId));
      }
      return;
    }
    const route = this.stack[index] as ModelRoute;
    const changed = JSON.stringify(route.params) !== JSON.stringify(params);
    this.stack.length = index + 1;
    route.params = params;
    if (changed && name === 'Result')
      bump(this.evidenceIntents, String(params.analysisId));
  }
  popToTop() {
    this.stack.length = 1;
  }
}

// ─── Scenario runner ────────────────────────────────────────────────────────

interface StepLog {
  step: Step;
  landed: number;
  skipped: 'absent' | 'disabled' | 'covered' | null;
  topBefore: string | null;
}

interface Outcome {
  seed: number;
  burst: BurstKind;
  env: Env;
  steps: StepLog[];
  expectedStack: ModelRoute[];
  observedStack: { name: string; params: unknown }[];
  counters: Counters;
  model: {
    analyzePushes: number;
    formReviewPushes: number;
    createPlanIntents: number;
    saveIntents: number;
    completeIntents: number;
    feedbackIntents: number;
    retryIntents: number;
    evidenceIntents: Record<string, number>;
  };
  unhandledActions: number;
  consoleErrors: string[];
  consoleWarns: string[];
  unhandledRejections: string[];
  thrown: string | null;
  violations: string[];
  pass: boolean;
}

/** Wildcard for a params value the model only requires to be a string. */
const ANY_STRING = '*';

/**
 * `shownId` is the analysis the focused ResultDetails route displays; the
 * review links carry it and the "Attempt 1" chip (= OTHER_ID) is a no-op
 * when it already is the shown attempt.
 */
function applyIntent(
  model: IntentModel,
  target: Target,
  env: Env,
  shownId: string,
) {
  switch (target) {
    case 'back':
    case 'goBackMissing':
      model.goBack();
      return;
    case 'formReview':
      model.navigate('FormReview', { analysisId: shownId });
      return;
    case 'fixReview':
      model.navigate('FormReview', {
        analysisId: shownId,
        phase: ANY_STRING,
      });
      return;
    case 'attemptChip':
      if (shownId !== OTHER_ID) {
        model.popTo('Result', { analysisId: OTHER_ID });
      }
      return;
    case 'captureNew':
      model.navigate('Analyze', { source: 'camera' });
      return;
    case 'buildPlan':
      // With another plan active the tap only opens the confirm dialog; the
      // request is issued from "Replace plan".
      if (env.training !== 'active-other') model.createPlanIntents += 1;
      return;
    case 'dialogReplace':
      model.createPlanIntents += 1;
      return;
    case 'planSave':
      model.saveIntents += 1;
      return;
    case 'dialogConfirmComplete':
      model.completeIntents += 1;
      return;
    case 'planRetry':
      model.retryIntents += 1;
      return;
    case 'feedbackYes':
    case 'feedbackCategory':
    case 'feedbackRetry':
      model.feedbackIntents += 1;
      return;
    default:
      return;
  }
}

function intentIsFresh(target: Target, renderer: ReactTestRenderer): boolean {
  switch (target) {
    case 'buildPlan':
    case 'dialogReplace':
    case 'planSave':
    case 'dialogConfirmComplete':
      return useTrainingStore.getState().mutation === 'idle';
    case 'planRetry':
      return useTrainingStore.getState().planStatus !== 'loading';
    case 'feedbackYes':
    case 'feedbackCategory':
    case 'feedbackRetry': {
      const details = detailsSubtree(renderer);
      return (
        details === null ||
        hostsByTestId(details, 'feedback-sending').length === 0
      );
    }
    default:
      return true;
  }
}

function paramsMatch(expected: unknown, observed: unknown): boolean {
  if (expected === undefined || expected === null) {
    return observed === undefined || observed === null;
  }
  if (
    typeof expected !== 'object' ||
    typeof observed !== 'object' ||
    observed === null
  ) {
    return false;
  }
  const e = expected as Record<string, unknown>;
  const o = observed as Record<string, unknown>;
  const keys = new Set([...Object.keys(e), ...Object.keys(o)]);
  for (const key of keys) {
    if (e[key] === ANY_STRING) {
      if (typeof o[key] !== 'string') return false;
    } else if (JSON.stringify(e[key]) !== JSON.stringify(o[key])) {
      return false;
    }
  }
  return true;
}

async function runScenario(scenario: Scenario): Promise<Outcome> {
  const { env, seed } = scenario;
  const rng = new Rng(seed ^ 0x9e3779b9);
  counters = freshCounters();
  clearTryAgainHandoff();
  installSeams(env);
  useTrainingStore.getState().reset();

  const consoleErrors: string[] = [];
  const consoleWarns: string[] = [];
  const unhandledRejections: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' ').slice(0, 400));
    });
  const warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      consoleWarns.push(args.map(String).join(' ').slice(0, 400));
    });
  const onRejection = (reason: unknown) => {
    unhandledRejections.push(String(reason).slice(0, 400));
  };
  process.on('unhandledRejection', onRejection);

  let unhandledActions = 0;
  const model = new IntentModel();
  const steps: StepLog[] = [];
  let thrown: string | null = null;
  let renderer: ReactTestRenderer | null = null;
  const violations: string[] = [];
  let finalStack: { name: string; params: unknown }[] = [];

  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <Harness
          onUnhandledAction={() => {
            unhandledActions += 1;
          }}
        />,
      );
    });
    await flushMicrotasks();
    const r = renderer as unknown as ReactTestRenderer;

    for (const step of scenario.steps) {
      const topBefore = topRouteName();
      const log: StepLog = { step, landed: 0, skipped: null, topBefore };
      steps.push(log);
      switch (step.t) {
        case 'wait':
          await advance(step.ms);
          break;
        case 'popTop': {
          if (routeStack().length > 1) {
            await act(async () => {
              navigationRef.dispatch(CommonActions.goBack());
            });
            log.landed = 1;
            model.goBack();
          } else {
            log.skipped = 'absent';
          }
          await flushMicrotasks();
          break;
        }
        case 'pushDetails': {
          // The app only enters ResultDetails from the Result guide, so the
          // push is only issued when that guide is the focused route.
          if (topRouteName() !== 'Result') {
            log.skipped = 'covered';
            break;
          }
          await act(async () => {
            navigationRef.navigate('ResultDetails', {
              analysisId: step.analysisId,
            });
          });
          log.landed = 1;
          model.navigate('ResultDetails', { analysisId: step.analysisId });
          await flushMicrotasks();
          break;
        }
        case 'tap': {
          if (topRouteName() !== 'ResultDetails') {
            log.skipped = 'covered';
            break;
          }
          const shownId = topAnalysisId();
          if (step.gapMs === 0) {
            // Same tick: every tap resolves against the pre-commit tree.
            const node = findTarget(r, step.target, rng);
            if (!node) {
              log.skipped = 'absent';
              break;
            }
            if (node.props.disabled === true) {
              log.skipped = 'disabled';
              break;
            }
            await act(async () => {
              for (let i = 0; i < step.count; i += 1) {
                node.props.onPress();
                log.landed += 1;
              }
            });
            applyIntent(model, step.target, env, shownId);
            await flushMicrotasks();
          } else {
            for (let i = 0; i < step.count; i += 1) {
              if (topRouteName() !== 'ResultDetails') {
                if (log.landed === 0) log.skipped = 'covered';
                break;
              }
              const node = findTarget(r, step.target, rng);
              if (!node) {
                if (log.landed === 0) log.skipped = 'absent';
                break;
              }
              if (node.props.disabled === true) {
                if (log.landed === 0) log.skipped = 'disabled';
                break;
              }
              // A spaced tap is a fresh intent only when the previous side
              // effect has already settled; otherwise it must be absorbed.
              const fresh = intentIsFresh(step.target, r);
              await act(async () => {
                node.props.onPress();
              });
              log.landed += 1;
              if (fresh) applyIntent(model, step.target, env, shownId);
              await advance(step.gapMs);
            }
          }
          break;
        }
      }
    }

    // Settle everything outstanding (requests, animations, replay ticks).
    await advance(6000);

    // ── Observations ──
    const observedStack = routeStack();
    finalStack = observedStack;
    const expectedStack = model.stack.map(route => ({ ...route }));
    const sameStack =
      observedStack.length === expectedStack.length &&
      observedStack.every(
        (route, i) =>
          route.name === (expectedStack[i] as ModelRoute).name &&
          paramsMatch((expectedStack[i] as ModelRoute).params, route.params),
      );
    if (!sameStack) {
      violations.push(
        `stack-mismatch expected=${JSON.stringify(expectedStack)} observed=${JSON.stringify(observedStack)}`,
      );
    }
    const routeCounts: Record<string, number> = {};
    for (const route of observedStack) bump(routeCounts, route.name);
    for (const [name, count] of Object.entries(routeCounts)) {
      if (count > 1) violations.push(`duplicate-route ${name}x${count}`);
    }

    if (counters.analyzeMounts !== model.analyzePushes) {
      violations.push(
        `analyze-mounts expected=${model.analyzePushes} observed=${counters.analyzeMounts}`,
      );
    }
    if (counters.analyzeMountsWithoutHandoff > 0) {
      violations.push(
        `analyze-without-handoff x${counters.analyzeMountsWithoutHandoff}`,
      );
    }
    if (counters.formReviewMounts !== model.formReviewPushes) {
      violations.push(
        `formreview-mounts expected=${model.formReviewPushes} observed=${counters.formReviewMounts}`,
      );
    }

    // One evidence load per mounted (screen, analysisId) — no duplicate reads.
    for (const [id, loads] of Object.entries(counters.evidenceLoads)) {
      const intents = counters.evidenceIntents[id] ?? 0;
      if (loads !== intents) {
        violations.push(
          `evidence-loads[${id}] expected=${intents} observed=${loads}`,
        );
      }
    }

    if (env.training !== 'unconfigured') {
      if (counters.createPlan > model.createPlanIntents) {
        violations.push(
          `createPlan-requests expected<=${model.createPlanIntents} observed=${counters.createPlan}`,
        );
      }
      if (counters.saveDrill > model.saveIntents) {
        violations.push(
          `saveDrill-requests expected<=${model.saveIntents} observed=${counters.saveDrill}`,
        );
      }
      if (counters.completeDrill > model.completeIntents) {
        violations.push(
          `completeDrill-requests expected<=${model.completeIntents} observed=${counters.completeDrill}`,
        );
      }
      const expectedPlanLoads =
        counters.detailsMounts + counters.resultMounts + model.retryIntents;
      if (counters.getCurrentPlan > expectedPlanLoads) {
        violations.push(
          `getCurrentPlan-requests expected<=${expectedPlanLoads} observed=${counters.getCurrentPlan}`,
        );
      }
      const store = useTrainingStore.getState();
      if (store.mutation !== 'idle') {
        violations.push(`orphan-mutation ${store.mutation}`);
      }
      if (store.planStatus === 'loading') {
        violations.push('orphan-plan-loading');
      }
    }

    if (counters.feedback > model.feedbackIntents) {
      violations.push(
        `feedback-requests expected<=${model.feedbackIntents} observed=${counters.feedback}`,
      );
    }

    // Orphan UI state inside a still-mounted details route.
    const details = detailsSubtree(r);
    if (details) {
      if (hostsByTestId(details, 'stroke-result-analyzing').length > 0) {
        violations.push('orphan-evidence-spinner');
      }
      if (hostsByTestId(details, 'feedback-sending').length > 0) {
        violations.push('orphan-feedback-sending');
      }
      const texts = details
        .findAllByType(Text)
        .map(node => node.props.children)
        .flat(3)
        .filter((child): child is string => typeof child === 'string');
      if (
        texts.includes('Checking reviewed training…') &&
        env.training !== 'unconfigured'
      ) {
        violations.push('orphan-plan-spinner-text');
      }
      if (texts.includes('Checking sync evidence…')) {
        violations.push('orphan-sync-spinner-text');
      }
      const replay = pressables(
        details,
        p => label(p) === 'Play replay' || label(p) === 'Pause replay',
      );
      if (replay.length && label(replay[0]!.props) === 'Play replay') {
        const before = hostsByTestId(details, 'stroke-result-scrubber')[0]
          ?.props.accessibilityValue?.now;
        await advance(1000);
        const after = hostsByTestId(details, 'stroke-result-scrubber')[0]?.props
          .accessibilityValue?.now;
        if (before !== after) {
          violations.push(
            `orphan-replay-timer playhead ${before}->${after} while paused`,
          );
        }
      }
    }
    const visibleModals = r.root
      .findAllByType(Modal)
      .filter(node => node.props.visible !== false);
    if (visibleModals.length > 1) {
      violations.push(`duplicate-modal x${visibleModals.length}`);
    }
  } catch (error) {
    thrown =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    violations.push(`thrown ${thrown}`);
  } finally {
    if (renderer) {
      try {
        await act(async () => {
          (renderer as unknown as ReactTestRenderer).unmount();
        });
      } catch (error) {
        violations.push(`unmount-threw ${String(error)}`);
      }
    }
    await advance(200);
    process.off('unhandledRejection', onRejection);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }

  if (consoleErrors.length)
    violations.push(`console.error x${consoleErrors.length}`);
  if (consoleWarns.length)
    violations.push(`console.warn x${consoleWarns.length}`);
  if (unhandledRejections.length) {
    violations.push(`unhandled-rejection x${unhandledRejections.length}`);
  }

  return {
    seed,
    burst: scenario.burst,
    env,
    steps,
    expectedStack: model.stack,
    observedStack: finalStack,
    counters,
    model: {
      analyzePushes: model.analyzePushes,
      formReviewPushes: model.formReviewPushes,
      createPlanIntents: model.createPlanIntents,
      saveIntents: model.saveIntents,
      completeIntents: model.completeIntents,
      feedbackIntents: model.feedbackIntents,
      retryIntents: model.retryIntents,
      evidenceIntents: model.evidenceIntents,
    },
    unhandledActions,
    consoleErrors,
    consoleWarns,
    unhandledRejections,
    thrown,
    violations,
    pass: violations.length === 0,
  };
}

// ─── Campaign ───────────────────────────────────────────────────────────────

const ITER = Number(process.env.STRESS_ITER ?? 12);
const BASE_SEED = Number(process.env.STRESS_BASE_SEED ?? 1000);
const ONLY_SEED = process.env.STRESS_SEED
  ? Number(process.env.STRESS_SEED)
  : null;
const OUT = process.env.STRESS_OUT ?? null;

const seeds =
  ONLY_SEED !== null
    ? [ONLY_SEED]
    : Array.from({ length: ITER }, (_, i) => BASE_SEED + i);

const outcomes: Outcome[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});

afterEach(() => {
  clearTrainingStoreConfiguration();
  clearTryAgainHandoff();
  jest.useRealTimers();
});

afterAll(() => {
  if (!OUT) return;
  const summary = {
    generatedAt: new Date().toISOString(),
    iterations: outcomes.length,
    passed: outcomes.filter(o => o.pass).length,
    failedSeeds: outcomes.filter(o => !o.pass).map(o => o.seed),
    tapsLanded: outcomes.reduce(
      (sum, o) => sum + o.steps.reduce((s, step) => s + step.landed, 0),
      0,
    ),
    byBurst: Object.fromEntries(
      [...new Set(outcomes.map(o => o.burst))].map(kind => [
        kind,
        {
          total: outcomes.filter(o => o.burst === kind).length,
          failed: outcomes.filter(o => o.burst === kind && !o.pass).length,
        },
      ]),
    ),
    violations: Object.fromEntries(
      [
        ...new Set(
          outcomes.flatMap(o => o.violations.map(v => v.split(' ')[0] ?? v)),
        ),
      ].map(key => [
        key,
        outcomes
          .filter(o => o.violations.some(v => v.startsWith(key)))
          .map(o => o.seed),
      ]),
    ),
    outcomes,
  };
  writeFileSync(OUT, JSON.stringify(summary, null, 2));
});

describe('ResultDetailsScreen — rapid interaction stress (real navigator + stores)', () => {
  it.each(seeds)(
    'seed %i holds single-effect-per-intent invariants',
    async seed => {
      const scenario = generateScenario(seed);
      const outcome = await runScenario(scenario);
      outcomes.push(outcome);
      expect({
        seed,
        burst: outcome.burst,
        violations: outcome.violations,
        steps: outcome.steps.map(s => ({
          ...s.step,
          landed: s.landed,
          skipped: s.skipped,
        })),
      }).toEqual({
        seed,
        burst: outcome.burst,
        violations: [],
        steps: expect.anything(),
      });
    },
  );
});
