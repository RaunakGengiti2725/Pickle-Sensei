/**
 * STRESS — ResultScreen, lens `randomized-seeded` (seeded randomized long-run).
 *
 * The real `ResultScreen` is mounted inside the app's real providers
 * (`SafeAreaProvider`, `QueryClientProvider`) and a REAL React Navigation
 * container + native stack (`useNavigation`/`useRoute` are the real hooks, the
 * stack state is the real router state). Sibling routes the screen navigates
 * to (`Tabs`, `Analyze`, `FormReview`, `DrillLibrary`, `ResultDetails`) are
 * registered as marker stubs so the campaign stays on this unit; the training
 * and consistency zustand stores are the real ones. Only native modules and
 * the data seams are mocked: safe-area (the library's own jest mock, real
 * contexts), SVG, the SQLite handle and the repository/evidence/sidecar
 * readers, the training HTTP API and the API session.
 *
 * Per seed a WORLD is generated (1–4 attempts of one practice set, each
 * scored-with-replay / scored-no-replay / clean / clean-with-replay /
 * legacy-record-only / abstained / missing / rejected, with a sync outcome,
 * evidence + sidecar latency incl. manual deferral, catalog and training-API
 * behaviour), then a legal/near-legal ACTION SEQUENCE of length 5–60 over the
 * screen's public surface (guide controls incl. double taps, drill save
 * toggles, practice-set pills, navigator dispatches incl. an analysisId no
 * row backs, timer advances, microtask flushes, deferred load releases).
 * The fake training API keeps a server-side saved-drill ledger so saves
 * survive page remounts exactly as the product's do. After EVERY action the model-checked invariants below are
 * asserted; every violation is recorded with its seed, replayed for
 * determinism (same seed → identical trace) and minimised (greedy ddmin over
 * the action list).
 *
 * Invariants (model-checked after every step while the Result route exists):
 *  I1  no render/effect throw reaches the root error boundary, no
 *      unhandled rejection, no console.error;
 *  I2  exactly one Result surface is visible: spinner XOR "Result missing"
 *      XOR guide;
 *  I3  once the evidence read for the focused analysis has resolved and
 *      microtasks are drained, the spinner is gone (it never survives the load);
 *  I4  guide structure equals the oracle derived from the same pure selectors
 *      the product uses (`techniqueScoreSectionVisible`, `fixList`,
 *      `drillFocusFromAnalysis`): step label `N OF T · LABEL`, exactly one
 *      `result-guide-step-*` page, Back iff step>0, Next iff not last,
 *      Try-again + Done iff last, progress bar iff T>1 with correct
 *      accessibilityValue; an unscored record collapses to ONE page
 *      (`RESULT · NOT SCORED`, no Back/Next/progress);
 *  I5  the guide step follows the model: Next → min(T-1,i+1), Back →
 *      max(0,i-1), route repointed to another attempt → 0, a push of another
 *      route on top and back → unchanged;
 *  I6  the real stack follows the model: Close/Done → popToTop ([Tabs]);
 *      Try again → Analyze{source:'camera'} pushed and a try-again handoff
 *      armed with the record's declared stroke; practice-set pill of another
 *      attempt → replace (same depth, new analysisId); the current attempt's
 *      pill is inert; Open drill library → DrillLibrary pushed;
 *  I7  the practice-set card is present on the SCORE page iff
 *      `summarizePracticeSet(facts, sessionId)` is non-null, with one pill per
 *      comparable attempt;
 *  I8  a drill save toggle flips `accessibilityState.selected` iff the
 *      configured training API accepted the save (and stays flipped across
 *      page/attempt remounts — the server ledger is the truth); a
 *      refused/unconfigured save leaves it unchanged and shows
 *      `training-mutation-error`, which is store-level and so stays up on any
 *      attempt's DRILLS page until dismissed or the next mutation;
 *  I9  determinism: the same seed replays to an identical trace;
 *  I10 unmount never throws.
 *
 * Scale: `STRESS_ITER` sequences (default 40 so the suite stays fast; the
 * campaign runs 2000+), `STRESS_SEED_BASE` (default 20260904),
 * `STRESS_DETERMINISM_EVERY` (default 8: every 8th seed and every failing
 * seed is replayed), `STRESS_FLAKE_RUNS` (default 10 re-runs per failing
 * seed), `STRESS_OUT` (path of the JSON seed→outcome table; unset → no file),
 * `STRESS_REPLAY=<seed>:<action>,<action>,…` (replay ONE recorded or
 * minimised sequence instead of the campaign, e.g. a `minimizedActions` entry
 * of a previous JSON table), `STRESS_REPLAY_REPEAT` (run that replay N times
 * back to back — flake rate / heap probe; `heapSamples` in the JSON table are
 * exact when jest runs under `node --expose-gc`).
 *
 *   cd apps/mobile && STRESS_ITER=2000 STRESS_DETERMINISM_EVERY=1 \
 *     STRESS_OUT=/tmp/result-screen-stress.json \
 *     npx jest --ci --silent __tests__/stress/resultScreenRandomizedSeeded
 */
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
    Ellipse: Mock,
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
    Text: Mock,
  };
});
jest.mock('../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));
jest.mock('../../src/components/strokeResultData', () => ({
  loadStrokeResultEvidence: (...args: unknown[]) =>
    mockLoadEvidence(...(args as [unknown, string])),
}));
jest.mock('../../src/review/poseSidecar', () => ({
  loadReviewPoseSequence: (...args: unknown[]) =>
    mockLoadSequence(...(args as [unknown])),
}));
jest.mock('../../src/data/repository', () => ({
  hasShotSyncReceipt: (...args: unknown[]) =>
    mockHasReceipt(...(args as [unknown, string])),
  getShotOutboxStatus: (...args: unknown[]) =>
    mockOutboxStatus(...(args as [unknown, string])),
  listRealAnalysisFacts: () => mockListFacts(),
  // Real consistency store's persistence seam: an in-memory kv per world.
  getKv: async (_db: unknown, key: string) => mockKvStore.get(key) ?? null,
  setKv: async (_db: unknown, key: string, value: string) => {
    mockKvStore.set(key, value);
  },
  listActivityShots: async () => [],
}));
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockApiSession(),
}));
jest.mock('../../src/training/api', () => ({
  createTrainingApi: () => ({
    listCatalogDrills: () => mockListCatalog(),
  }),
}));

import React from 'react';
import { Text, View } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  NavigationContainer,
  StackActions,
  createNavigationContainerRef,
  type RouteProp,
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
import { ResultScreen } from '../../src/screens/ResultScreen';
import {
  clearTryAgainHandoff,
  peekTryAgainHandoff,
  tryAgainFromResult,
  type TryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';
import type { RootStackParams } from '../../src/navigation/params';
import type {
  ReviewJoint,
  ReviewPoseFrame,
  ReviewPoseSequence,
} from '../../src/review/formReviewModel';
import { fixList } from '../../src/review/formReviewModel';
import { drillFocusFromAnalysis } from '../../src/review/recommendedDrillsModel';
import { techniqueScoreSectionVisible } from '../../src/components/strokeResultModel';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';
import type { StrokeResultEvidence } from '../../src/components/strokeResultData';
import type {
  RealAnalysisFact,
  ShotOutboxStatus,
} from '../../src/data/repository';
import { summarizePracticeSet } from '../../src/progress/practiceSetProgress';
import type { CatalogDrill } from '../../src/training/api';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import type { TrainingApi } from '../../src/training/types';
import { useConsistencyStore } from '../../src/consistency/store';

// ─── Seeded RNG (mulberry32) ────────────────────────────────────────────────

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  range(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
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

const FAULTY_CHECKPOINTS: CheckpointScore[] = [
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
];

const CLEAN_CHECKPOINTS: CheckpointScore[] = [
  checkpoint('ready_position', 85, 'green', 'none'),
  checkpoint('contact_position', 91, 'green', 'none'),
];

function scoredAnalysis(
  id: string,
  sessionId: string,
  capturedAtIso: string,
  clean: boolean,
  overallScore: number,
): ShotAnalysis {
  return {
    id,
    sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso,
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
    checkpoints: clean ? CLEAN_CHECKPOINTS : FAULTY_CHECKPOINTS,
    overallScore,
    analysisConfidence: 0.84,
    resultKind: 'scored',
    guidance: null,
    priorityFix: clean
      ? null
      : {
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

function declaredRecord(
  id: string,
  result: ShotAnalysis | null,
): StrokeResultEvidenceRecord {
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
    result,
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

function abstainedRecord(id: string): StrokeResultEvidenceRecord {
  return {
    id,
    captureId: `capture-${id}`,
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
}

function sidecarFor(attemptId: string) {
  return {
    schemaVersion: 1 as const,
    format: 'pickle.pose-sequence.v1' as const,
    uri: `file:///captures/${attemptId}.pose.json`,
    frameCount: 81,
    sha256: 'ab'.repeat(32),
    coordinateSystem: 'normalized_image_top_left' as const,
    poseModelVersion: 'apple-vision-bodypose-1',
  };
}

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
const POSE_SEQUENCE = fullBodySequence();

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

const API_SESSION = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'access-token',
  canonicalAppUserId: '00000000-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};

// ─── World model ────────────────────────────────────────────────────────────

type AttemptKind =
  | 'full'
  | 'noreplay'
  | 'clean'
  | 'cleanReplay'
  | 'legacy'
  | 'abstained'
  | 'missing'
  | 'rejected';
type SyncKind =
  | 'synced'
  | 'pending'
  | 'rejected'
  | 'exhausted'
  | 'unknown'
  | 'throws'
  | 'never';
type Latency = 0 | 1 | 2 | 'manual';
type SequenceKind = 'ok' | 'null' | 'throw' | 'manual';
type CatalogKind = 'ok' | 'throw' | 'empty' | 'noSession';
type TrainingKind = 'none' | 'ok' | 'saveThrows';

interface AttemptSpec {
  id: string;
  kind: AttemptKind;
  sync: SyncKind;
  evidenceLatency: Latency;
  sequence: SequenceKind;
  score: number;
  capturedAtIso: string;
}

interface World {
  seed: number;
  sessionId: string;
  attempts: AttemptSpec[];
  initialAttempt: number;
  practiceSetFacts: boolean;
  catalog: CatalogKind;
  training: TrainingKind;
}

const ATTEMPT_KINDS: AttemptKind[] = [
  'full',
  'full',
  'full',
  'noreplay',
  'clean',
  'cleanReplay',
  'legacy',
  'abstained',
  'missing',
  'rejected',
];
const SYNC_KINDS: SyncKind[] = [
  'synced',
  'synced',
  'pending',
  'rejected',
  'exhausted',
  'unknown',
  'throws',
  'never',
];
const LATENCIES: Latency[] = [0, 0, 1, 2, 'manual'];
const SEQUENCE_KINDS: SequenceKind[] = ['ok', 'ok', 'null', 'throw', 'manual'];
const CATALOG_KINDS: CatalogKind[] = [
  'ok',
  'ok',
  'throw',
  'empty',
  'noSession',
];
const TRAINING_KINDS: TrainingKind[] = ['none', 'ok', 'ok', 'saveThrows'];

function generateWorld(seed: number, rng: Rng): World {
  const count = rng.range(1, 4);
  const sessionId = `set-${seed}`;
  const attempts: AttemptSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    attempts.push({
      id: `att-${seed}-${i + 1}`,
      kind: rng.pick(ATTEMPT_KINDS),
      sync: rng.pick(SYNC_KINDS),
      evidenceLatency: rng.pick(LATENCIES),
      sequence: rng.pick(SEQUENCE_KINDS),
      score: Math.round(rng.range(30, 95)) / 10,
      capturedAtIso: `2026-09-01T10:0${i}:00.000Z`,
    });
  }
  return {
    seed,
    sessionId,
    attempts,
    initialAttempt: rng.int(count),
    practiceSetFacts: rng.chance(0.6),
    catalog: rng.pick(CATALOG_KINDS),
    training: rng.pick(TRAINING_KINDS),
  };
}

function analysisFor(world: World, attempt: AttemptSpec): ShotAnalysis | null {
  switch (attempt.kind) {
    case 'full':
    case 'noreplay':
    case 'legacy':
      return scoredAnalysis(
        attempt.id,
        world.sessionId,
        attempt.capturedAtIso,
        false,
        attempt.score,
      );
    case 'clean':
    case 'cleanReplay':
      return scoredAnalysis(
        attempt.id,
        world.sessionId,
        attempt.capturedAtIso,
        true,
        attempt.score,
      );
    default:
      return null;
  }
}

function evidenceFor(world: World, attempt: AttemptSpec): StrokeResultEvidence {
  const analysis = analysisFor(world, attempt);
  const attemptsRefs = world.attempts.map(other => ({
    analysisId: other.id,
    capturedAtIso: other.capturedAtIso,
    sessionId: world.sessionId,
  }));
  const withReplay = attempt.kind === 'full' || attempt.kind === 'cleanReplay';
  switch (attempt.kind) {
    case 'missing':
    case 'rejected':
      return {
        analysis: null,
        record: null,
        clip: null,
        review: null,
        attempts: [],
      };
    case 'abstained':
      return {
        analysis: null,
        record: abstainedRecord(attempt.id),
        clip: { uri: `file:///captures/${attempt.id}.mov`, durationMs: 3800 },
        review: { width: 1080, height: 1920, poseSequence: null },
        attempts: attemptsRefs,
      };
    case 'legacy':
      // Analysis only on the record (legacy rating row); no capture row.
      return {
        analysis: null,
        record: declaredRecord(attempt.id, analysis),
        clip: null,
        review: null,
        attempts: attemptsRefs,
      };
    default:
      return {
        analysis,
        record: declaredRecord(attempt.id, null),
        clip: withReplay
          ? {
              uri: `file:///captures/${attempt.id}.mov`,
              durationMs: 3400,
              posterUri: `file:///captures/${attempt.id}.poster.jpg`,
            }
          : null,
        review: {
          width: 1080,
          height: 1920,
          poseSequence: withReplay ? sidecarFor(attempt.id) : null,
        },
        attempts: attemptsRefs,
      };
  }
}

function factsFor(world: World): RealAnalysisFact[] {
  if (!world.practiceSetFacts) return [];
  const facts: RealAnalysisFact[] = [];
  for (const attempt of world.attempts) {
    const analysis = analysisFor(world, attempt);
    if (!analysis) continue;
    facts.push({
      id: attempt.id,
      shotType: analysis.shotType,
      capturedAt: attempt.capturedAtIso,
      overallScore: attempt.score,
      confidence: 0.8,
      resultKind: 'scored',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
      sessionId: world.sessionId,
      priorityCheckpoint: analysis.priorityFix?.checkpoint ?? null,
      checkpointScores: Object.fromEntries(
        analysis.checkpoints
          .filter(cp => cp.applicable && cp.score !== null)
          .map(cp => [cp.key, cp.score as number]),
      ),
    });
  }
  return facts;
}

type GuideStep = 'score' | 'problem' | 'drills' | 'next';
const STEP_LABEL: Record<GuideStep, string> = {
  score: 'SCORE',
  problem: 'THE PROBLEM',
  drills: 'DRILLS',
  next: 'NEXT',
};

/** Oracle: the step list the guide must show for an attempt (same selectors). */
function oracleSteps(world: World, attempt: AttemptSpec): GuideStep[] {
  const evidence = evidenceFor(world, attempt);
  const analysis = evidence.analysis ?? evidence.record?.result ?? null;
  if (!techniqueScoreSectionVisible(analysis) || !analysis) return [];
  const fixes = fixList(analysis);
  const reviewAvailable =
    evidence.clip !== null || evidence.review?.poseSequence != null;
  const list: GuideStep[] = ['score'];
  if (fixes.length > 0 || reviewAvailable) list.push('problem');
  if (drillFocusFromAnalysis(analysis)) list.push('drills');
  list.push('next');
  return list;
}

type Surface = 'spinner' | 'missing' | 'guide';
function oracleSurface(attempt: AttemptSpec | undefined): Surface {
  if (!attempt) return 'missing';
  return attempt.kind === 'missing' || attempt.kind === 'rejected'
    ? 'missing'
    : 'guide';
}

// ─── Data seams (driven by the current world) ───────────────────────────────

let world: World | null = null;
const mockKvStore = new Map<string, string>();
/** Manually deferred reads; the `release` action resolves them all. */
let deferred: Array<() => void> = [];
/** Evidence reads per analysisId (started vs settled) for I3. */
let evidenceReads = new Map<string, { started: number; settled: number }>();

function readsFor(analysisId: string): { started: number; settled: number } {
  let entry = evidenceReads.get(analysisId);
  if (!entry) {
    entry = { started: 0, settled: 0 };
    evidenceReads.set(analysisId, entry);
  }
  return entry;
}

/** True once every evidence read issued for the id has settled. */
function evidenceSettled(analysisId: string): boolean {
  const entry = evidenceReads.get(analysisId);
  return (
    entry !== undefined && entry.started > 0 && entry.settled === entry.started
  );
}

function defer<T>(produce: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    deferred.push(() => {
      produce().then(resolve, reject);
    });
  });
}

async function afterTicks<T>(ticks: number, value: () => T): Promise<T> {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
  return value();
}

function attemptById(id: string): AttemptSpec | undefined {
  return world?.attempts.find(attempt => attempt.id === id);
}

function mockLoadEvidence(
  _db: unknown,
  analysisId: string,
): Promise<StrokeResultEvidence> {
  const w = world;
  if (!w) return Promise.reject(new Error('no world'));
  const attempt = attemptById(analysisId);
  readsFor(analysisId).started += 1;
  const produce = async (): Promise<StrokeResultEvidence> => {
    readsFor(analysisId).settled += 1;
    if (!attempt) {
      return {
        analysis: null,
        record: null,
        clip: null,
        review: null,
        attempts: [],
      };
    }
    if (attempt.kind === 'rejected')
      throw new Error(`evidence read failed ${analysisId}`);
    return evidenceFor(w, attempt);
  };
  const latency = attempt?.evidenceLatency ?? 0;
  if (latency === 'manual') return defer(produce);
  return afterTicks(latency, () => null).then(produce);
}

function mockLoadSequence(
  sidecar: unknown,
): Promise<ReviewPoseSequence | null> {
  const uri = (sidecar as { uri?: string } | null)?.uri ?? '';
  const match = /\/captures\/(.+)\.pose\.json$/.exec(uri);
  const current = match?.[1] ? attemptById(match[1]) : undefined;
  const kind = current?.sequence ?? 'ok';
  const produce = async () => {
    if (kind === 'throw') throw new Error('sidecar hash mismatch');
    if (kind === 'null') return null;
    return POSE_SEQUENCE;
  };
  if (kind === 'manual') return defer(produce);
  return afterTicks(1, () => null).then(produce);
}

function mockHasReceipt(_db: unknown, shotId: string): Promise<boolean> {
  const attempt = attemptById(shotId);
  const sync = attempt?.sync ?? 'unknown';
  if (sync === 'never') return new Promise<boolean>(() => {});
  if (sync === 'throws')
    return Promise.reject(new Error('receipt read failed'));
  return Promise.resolve(sync === 'synced');
}

function mockOutboxStatus(
  _db: unknown,
  shotId: string,
): Promise<ShotOutboxStatus> {
  const attempt = attemptById(shotId);
  switch (attempt?.sync) {
    case 'pending':
      return Promise.resolve({ state: 'queued', attempts: 1, lastError: null });
    case 'rejected':
      return Promise.resolve({
        state: 'rejected',
        attempts: 2,
        lastError: 'server said no',
      });
    case 'exhausted':
      return Promise.resolve({
        state: 'exhausted',
        attempts: 8,
        lastError: 'gave up',
      });
    default:
      return Promise.resolve({ state: 'absent' });
  }
}

function mockListFacts(): Promise<RealAnalysisFact[]> {
  return Promise.resolve(world ? factsFor(world) : []);
}

function mockApiSession() {
  return world?.catalog === 'noSession' ? null : API_SESSION;
}

/** Server-side saved-drill ledger the fake training API keeps per run. */
const savedLedger = new Set<string>();

function catalogSnapshot(): CatalogDrill[] {
  return CATALOG.map(entry => ({
    ...entry,
    saved: savedLedger.has(entry.slug),
  }));
}

function mockListCatalog(): Promise<CatalogDrill[]> {
  switch (world?.catalog) {
    case 'throw':
      return Promise.reject(new Error('catalog unavailable'));
    case 'empty':
      return Promise.resolve([]);
    default:
      return Promise.resolve(catalogSnapshot());
  }
}

function trainingApiFor(kind: TrainingKind): TrainingApi | null {
  if (kind === 'none') return null;
  const refuse = async (): Promise<never> => {
    throw new Error('not needed');
  };
  return {
    listCatalogDrills: async () => catalogSnapshot(),
    listSavedDrills: async () =>
      catalogSnapshot()
        .filter(entry => entry.saved)
        .map(entry => ({
          id: entry.id,
          slug: entry.slug,
          title: entry.title,
          description: entry.description,
          coachName: entry.coachName,
          equipment: entry.equipment,
          difficultyMin: entry.difficultyMin,
          difficultyMax: entry.difficultyMax,
          savedAt: '2026-09-01T10:00:00.000Z',
        })),
    getDrill: refuse,
    saveDrill: async (slug: string) => {
      if (kind === 'saveThrows') throw new Error('save refused');
      savedLedger.add(slug);
    },
    unsaveDrill: async (slug: string) => {
      if (kind === 'saveThrows') throw new Error('unsave refused');
      savedLedger.delete(slug);
    },
    getCurrentPlan: async () => null,
    createPlan: refuse,
    completeDrill: refuse,
    reassessPlan: refuse,
  } as unknown as TrainingApi;
}

// ─── Real navigator with marker stubs for the sibling routes ────────────────

const Stack = createNativeStackNavigator<RootStackParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();

function marker(name: keyof RootStackParams) {
  return function Marker({ route }: { route: RouteProp<RootStackParams> }) {
    return (
      <View testID={`stub-${name}`}>
        <Text>{JSON.stringify(route.params ?? null)}</Text>
      </View>
    );
  };
}
const TabsStub = marker('Tabs');
const AnalyzeStub = marker('Analyze');
const ResultDetailsStub = marker('ResultDetails');
const FormReviewStub = marker('FormReview');
const DrillLibraryStub = marker('DrillLibrary');

class Boundary extends React.Component<
  { children: React.ReactNode; onError: (error: unknown) => void },
  { caught: boolean }
> {
  state = { caught: false };
  static getDerivedStateFromError() {
    return { caught: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.caught ? (
      <Text testID="boundary-caught">crashed</Text>
    ) : (
      this.props.children
    );
  }
}

function App(props: {
  initialAnalysisId: string;
  onError: (error: unknown) => void;
}) {
  const [queryClient] = React.useState(() => new QueryClient());
  return (
    <Boundary onError={props.onError}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <NavigationContainer
            ref={navigationRef}
            initialState={{
              index: 1,
              routes: [
                { name: 'Tabs' },
                {
                  name: 'Result',
                  params: { analysisId: props.initialAnalysisId },
                },
              ],
            }}
          >
            <Stack.Navigator screenOptions={{ headerShown: false }}>
              <Stack.Screen name="Tabs" component={TabsStub} />
              <Stack.Screen name="Analyze" component={AnalyzeStub} />
              <Stack.Screen name="Result" component={ResultScreen} />
              <Stack.Screen
                name="ResultDetails"
                component={ResultDetailsStub}
              />
              <Stack.Screen name="FormReview" component={FormReviewStub} />
              <Stack.Screen name="DrillLibrary" component={DrillLibraryStub} />
            </Stack.Navigator>
          </NavigationContainer>
        </QueryClientProvider>
      </SafeAreaProvider>
    </Boundary>
  );
}

// ─── Tree helpers (scoped to one mounted ResultScreen instance) ─────────────

type Scope = ReactTestInstance;

function hostsByTestId(scope: Scope, testID: string): ReactTestInstance[] {
  return scope.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

/** Outermost pressable owners of a testID (PressableScale forwards the id to
 * the inner Pressable, so nested duplicates are collapsed to the owner). */
function pressables(scope: Scope, testID: string): ReactTestInstance[] {
  const all = scope.findAll(
    node =>
      node.props.testID === testID && typeof node.props.onPress === 'function',
  );
  return all.filter(
    node => !all.some(other => other !== node && isAncestor(other, node)),
  );
}

function isAncestor(
  ancestor: ReactTestInstance,
  node: ReactTestInstance,
): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function pressablesMatching(scope: Scope, prefix: string): ReactTestInstance[] {
  const seen = new Set<string>();
  return scope
    .findAll(
      node =>
        typeof node.props.testID === 'string' &&
        node.props.testID.startsWith(prefix) &&
        typeof node.props.onPress === 'function',
    )
    .filter(node => {
      const id = node.props.testID as string;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

function allText(scope: Scope): string {
  return scope
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

function stepLabelText(scope: Scope): string | null {
  const [label] = hostsByTestId(scope, 'result-guide-step-label');
  if (!label) return null;
  const children = label.props.children;
  return Array.isArray(children) ? children.join('') : String(children);
}

/** Every mounted ResultScreen, bottom → top (native-stack keeps them all). */
function resultInstances(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAllByType(ResultScreen);
}

async function flushMicrotasks(turns = 4) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

// ─── Actions ────────────────────────────────────────────────────────────────

type Action =
  | { kind: 'next' }
  | { kind: 'back' }
  | { kind: 'doubleNext' }
  | { kind: 'doubleBack' }
  | { kind: 'toDrills' }
  | { kind: 'navToGhost' }
  | { kind: 'done' }
  | { kind: 'close' }
  | { kind: 'tryAgain' }
  | { kind: 'openLibrary' }
  | { kind: 'retryDrills' }
  | { kind: 'toggleSave'; index: number }
  | { kind: 'dismissError' }
  | { kind: 'openAttempt'; index: number }
  | { kind: 'navBack' }
  | { kind: 'navToResult'; index: number }
  | { kind: 'pushFormReview' }
  | { kind: 'settle' }
  | { kind: 'tick'; ms: number }
  | { kind: 'release' };

const ACTION_WEIGHTS: Array<[Action['kind'], number]> = [
  ['next', 18],
  ['back', 8],
  ['doubleNext', 3],
  ['doubleBack', 2],
  ['toDrills', 8],
  ['navToGhost', 1],
  ['done', 2],
  ['close', 2],
  ['tryAgain', 3],
  ['openLibrary', 3],
  ['retryDrills', 2],
  ['toggleSave', 12],
  ['dismissError', 2],
  ['openAttempt', 6],
  ['navBack', 4],
  ['navToResult', 5],
  ['pushFormReview', 3],
  ['settle', 8],
  ['tick', 6],
  ['release', 6],
];
const WEIGHT_TOTAL = ACTION_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);

function generateAction(rng: Rng, w: World): Action {
  let roll = rng.int(WEIGHT_TOTAL);
  let kind: Action['kind'] = 'settle';
  for (const [candidate, weight] of ACTION_WEIGHTS) {
    if (roll < weight) {
      kind = candidate;
      break;
    }
    roll -= weight;
  }
  switch (kind) {
    case 'toggleSave':
      return { kind, index: rng.int(3) };
    case 'openAttempt':
    case 'navToResult':
      return { kind, index: rng.int(w.attempts.length) };
    case 'tick':
      return { kind, ms: rng.pick([16, 50, 120, 300, 1000]) };
    default:
      return { kind } as Action;
  }
}

function generateActions(rng: Rng, w: World): Action[] {
  const length = rng.range(5, 60);
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) actions.push(generateAction(rng, w));
  return actions;
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'toggleSave':
    case 'openAttempt':
    case 'navToResult':
      return `${action.kind}(${action.index})`;
    case 'tick':
      return `tick(${action.ms})`;
    default:
      return action.kind;
  }
}

function parseAction(text: string): Action {
  const match = /^([a-zA-Z]+)(?:\((\d+)\))?$/.exec(text);
  if (!match) throw new Error(`bad action ${text}`);
  const kind = match[1] as Action['kind'];
  const arg = match[2] === undefined ? undefined : Number(match[2]);
  switch (kind) {
    case 'toggleSave':
    case 'openAttempt':
    case 'navToResult':
      return { kind, index: arg ?? 0 };
    case 'tick':
      return { kind, ms: arg ?? 16 };
    default:
      return { kind } as Action;
  }
}

// ─── Model ──────────────────────────────────────────────────────────────────

interface Entry {
  name: string;
  analysisId: string | null;
  stepIndex: number;
}

function resultEntry(analysisId: string): Entry {
  return { name: 'Result', analysisId, stepIndex: 0 };
}

function stubEntry(name: string): Entry {
  return { name, analysisId: null, stepIndex: 0 };
}

interface Violation {
  step: number;
  action: string;
  invariant: string;
  detail: string;
}

interface StepTrace {
  step: number;
  action: string;
  stack: string[];
  surfaces: string[];
  labels: Array<string | null>;
}

interface Coverage {
  /** Distinct `surface@label` states observed on the focused Result. */
  states: string[];
  maxDepth: number;
  maxResultInstances: number;
  /** Actions whose model effect was non-trivial (pressed/navigated). */
  effective: number;
  /** Drill save toggles actually pressed (I8 exercised). */
  toggles: number;
}

interface RunResult {
  seed: number;
  length: number;
  world: Omit<World, 'seed'>;
  actions: string[];
  violations: Violation[];
  trace: StepTrace[];
  traceHash: string;
  crashed: string | null;
  coverage: Coverage;
}

function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function realStack(): Array<{ name: string; analysisId: string | null }> {
  if (!navigationRef.isReady()) return [];
  const state = navigationRef.getRootState();
  if (!state) return [];
  return state.routes.map(route => ({
    name: route.name,
    analysisId:
      (route.params as { analysisId?: string } | undefined)?.analysisId ?? null,
  }));
}

function surfaceOf(scope: Scope): {
  spinner: number;
  missing: number;
  guide: number;
} {
  const text = allText(scope);
  return {
    spinner: (text.match(/Opening your result…/g) ?? []).length,
    missing: (text.match(/Result missing/g) ?? []).length,
    guide: hostsByTestId(scope, 'result-guide').length,
  };
}

// ─── Scenario runner ────────────────────────────────────────────────────────

function worldWithoutSeed(w: World): Omit<World, 'seed'> {
  return {
    sessionId: w.sessionId,
    attempts: w.attempts,
    initialAttempt: w.initialAttempt,
    practiceSetFacts: w.practiceSetFacts,
    catalog: w.catalog,
    training: w.training,
  };
}

async function runScenario(
  seed: number,
  presetActions: Action[] | null,
): Promise<RunResult> {
  const rng = new Rng(seed);
  const w = generateWorld(seed, rng);
  const actions = presetActions ?? generateActions(rng, w);

  // Fresh process-level state for this iteration.
  world = w;
  deferred = [];
  evidenceReads = new Map();
  savedLedger.clear();
  mockKvStore.clear();
  clearTryAgainHandoff();
  const api = trainingApiFor(w.training);
  if (api) configureTrainingStore(api);
  else clearTrainingStoreConfiguration();
  useConsistencyStore.setState(consistencyInitial, true);

  const violations: Violation[] = [];
  const trace: StepTrace[] = [];
  const consoleErrors: string[] = [];
  let crashed: string | null = null;
  const onError = (error: unknown) => {
    crashed =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  };
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(
      args.map(arg => (typeof arg === 'string' ? arg : String(arg))).join(' '),
    );
  };
  const onRejection = (reason: unknown) => {
    consoleErrors.push(`unhandledRejection: ${String(reason)}`);
  };
  process.on('unhandledRejection', onRejection);

  const initial = w.attempts[w.initialAttempt];
  if (!initial) throw new Error('world without attempts');
  const model: {
    stack: Entry[];
    handoffArmed: boolean;
    handoff: TryAgainHandoff | null;
    /** Save toggles confirmed by the model (slug → saved); server-side, so shared across screens. */
    saved: Record<string, boolean>;
    /** The training store's `mutationError` is store-level: it stays up on
     *  every DrillsPage (any attempt) until dismissed or the next mutation. */
    expectMutationError: boolean;
  } = {
    stack: [stubEntry('Tabs'), resultEntry(initial.id)],
    handoffArmed: false,
    handoff: null,
    saved: {},
    expectMutationError: false,
  };
  const top = () => model.stack[model.stack.length - 1]!;
  const topResult = (): Entry | null =>
    top().name === 'Result' ? top() : null;
  const topResultScope = (
    renderer: ReactTestRenderer,
  ): ReactTestInstance | null => {
    if (!topResult()) return null;
    const instances = resultInstances(renderer);
    return instances[instances.length - 1] ?? null;
  };

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <App initialAnalysisId={initial.id} onError={onError} />,
    );
  });
  await flushMicrotasks();

  const record = (
    step: number,
    action: string,
    invariant: string,
    detail: string,
  ) => {
    violations.push({ step, action, invariant, detail });
  };

  let lastActionSettled = true;
  const states = new Set<string>();
  const coverage: Coverage = {
    states: [],
    maxDepth: 0,
    maxResultInstances: 0,
    effective: 0,
    toggles: 0,
  };

  const checkResultInstance = (
    step: number,
    actionName: string,
    scope: ReactTestInstance,
    entry: Entry,
    focused: boolean,
  ): { surface: string; label: string | null } => {
    const attempt = entry.analysisId
      ? attemptById(entry.analysisId)
      : undefined;
    const surface = surfaceOf(scope);
    const label = stepLabelText(scope);
    const shown = surface.spinner + surface.missing + surface.guide;
    if (shown !== 1)
      record(step, actionName, 'I2-surface', JSON.stringify(surface));
    const surfaceName = surface.guide
      ? 'guide'
      : surface.missing
        ? 'missing'
        : surface.spinner
          ? 'spinner'
          : 'none';
    if (!attempt) {
      // An id outside the world: the read resolves to the empty evidence set.
      if (
        lastActionSettled &&
        evidenceSettled(entry.analysisId ?? '') &&
        surfaceName !== 'missing'
      )
        record(
          step,
          actionName,
          'I2-oracle',
          `surface ${surfaceName} expected missing`,
        );
      return { surface: surfaceName, label };
    }
    const loaded = evidenceSettled(attempt.id);
    if (loaded && lastActionSettled) {
      if (surface.spinner > 0)
        record(
          step,
          actionName,
          'I3-spinner',
          'spinner survived a settled evidence load',
        );
      const expected = oracleSurface(attempt);
      if (surfaceName !== expected)
        record(
          step,
          actionName,
          'I2-oracle',
          `surface ${surfaceName} expected ${expected}`,
        );
    }
    if (surface.guide !== 1) return { surface: surfaceName, label };

    const steps = oracleSteps(w, attempt);
    if (steps.length === 0) {
      if (label !== 'RESULT · NOT SCORED')
        record(step, actionName, 'I4-label', `${label}`);
      if (hostsByTestId(scope, 'result-guide-step-abstained').length !== 1)
        record(step, actionName, 'I4-abstained-page', 'missing abstained page');
      if (
        pressables(scope, 'result-guide-next').length !== 0 ||
        pressables(scope, 'result-guide-back').length !== 0
      )
        record(
          step,
          actionName,
          'I4-abstained-controls',
          'Next/Back on the unscored page',
        );
      if (
        pressables(scope, 'result-guide-try-again').length !== 1 ||
        pressables(scope, 'result-guide-done').length !== 1
      )
        record(
          step,
          actionName,
          'I4-abstained-footer',
          'Try again/Done missing',
        );
      if (hostsByTestId(scope, 'result-guide-progress').length !== 0)
        record(
          step,
          actionName,
          'I4-abstained-progress',
          'progress bar on the unscored page',
        );
      return { surface: surfaceName, label };
    }

    const i = entry.stepIndex;
    const total = steps.length;
    const current = steps[i];
    if (current === undefined) {
      record(step, actionName, 'I5-model', `model step ${i} out of ${total}`);
      return { surface: surfaceName, label };
    }
    const expectedLabel = `${i + 1} OF ${total} · ${STEP_LABEL[current]}`;
    if (label !== expectedLabel)
      record(
        step,
        actionName,
        'I4-label',
        `${label} expected ${expectedLabel}`,
      );
    const pages = (
      ['score', 'problem', 'drills', 'next'] as GuideStep[]
    ).filter(
      page => hostsByTestId(scope, `result-guide-step-${page}`).length > 0,
    );
    if (pages.length !== 1 || pages[0] !== current)
      record(
        step,
        actionName,
        'I4-page',
        `pages ${pages.join(',')} expected ${current}`,
      );
    const isLast = i === total - 1;
    if ((pressables(scope, 'result-guide-back').length === 1) !== i > 0)
      record(step, actionName, 'I4-back', `back presence wrong at step ${i}`);
    if ((pressables(scope, 'result-guide-next').length === 1) !== !isLast)
      record(step, actionName, 'I4-next', `next presence wrong at step ${i}`);
    if ((pressables(scope, 'result-guide-try-again').length === 1) !== isLast)
      record(
        step,
        actionName,
        'I4-try-again',
        `try-again presence wrong at step ${i}`,
      );
    if ((pressables(scope, 'result-guide-done').length === 1) !== isLast)
      record(step, actionName, 'I4-done', `done presence wrong at step ${i}`);
    const progress = hostsByTestId(scope, 'result-guide-progress');
    if ((progress.length === 1) !== total > 1) {
      record(
        step,
        actionName,
        'I4-progress',
        `progress presence wrong (total ${total})`,
      );
    } else if (progress[0]) {
      const value = progress[0].props.accessibilityValue as {
        now?: number;
        max?: number;
      };
      if (value?.now !== i + 1 || value?.max !== total)
        record(step, actionName, 'I4-progress-value', JSON.stringify(value));
    }
    if (current === 'score' && lastActionSettled) {
      const summary = summarizePracticeSet(factsFor(w), w.sessionId);
      const card = hostsByTestId(scope, 'result-guide-practice-set');
      if ((card.length === 1) !== (summary !== null)) {
        record(
          step,
          actionName,
          'I7-practice-set',
          `card ${card.length} expected ${summary ? 1 : 0}`,
        );
      } else if (summary) {
        const pills = pressablesMatching(scope, 'practice-set-attempt-');
        const own = pressables(scope, `practice-set-attempt-${attempt.id}`);
        if (pills.length !== summary.attempts.length || own.length !== 1)
          record(
            step,
            actionName,
            'I7-pills',
            `pressable ${pills.length} own ${own.length} of ${summary.attempts.length}`,
          );
      }
    }
    if (current === 'drills' && lastActionSettled && focused) {
      const error = hostsByTestId(scope, 'training-mutation-error').length;
      if ((error === 1) !== model.expectMutationError)
        record(
          step,
          actionName,
          'I8-error',
          `mutation error ${error} expected ${model.expectMutationError ? 1 : 0}`,
        );
      for (const [slug, saved] of Object.entries(model.saved)) {
        const [toggle] = pressables(scope, `recommended-drill-${slug}-save`);
        if (toggle) {
          const selected = (
            toggle.props.accessibilityState as { selected?: boolean }
          )?.selected;
          if (selected !== saved)
            record(
              step,
              actionName,
              'I8-toggle',
              `${slug} selected ${selected} expected ${saved}`,
            );
        }
      }
    }
    return { surface: surfaceName, label };
  };

  const check = (step: number, actionName: string) => {
    if (crashed) {
      record(step, actionName, 'I1-crash', crashed);
      trace.push({
        step,
        action: actionName,
        stack: ['<crashed>'],
        surfaces: [],
        labels: [],
      });
      return;
    }
    for (const message of consoleErrors.splice(0))
      record(step, actionName, 'I1-console.error', message);

    const stack = realStack();
    const modelStack = model.stack.map(entry => ({
      name: entry.name,
      analysisId: entry.analysisId,
    }));
    if (JSON.stringify(stack) !== JSON.stringify(modelStack)) {
      record(
        step,
        actionName,
        'I6-stack',
        `real ${JSON.stringify(stack)} model ${JSON.stringify(modelStack)}`,
      );
    }
    if (model.handoffArmed && peekTryAgainHandoff() === null) {
      record(step, actionName, 'I6-handoff', 'try-again handoff not armed');
    }
    if (model.handoff) {
      const handoff = peekTryAgainHandoff();
      if (JSON.stringify(handoff) !== JSON.stringify(model.handoff))
        record(
          step,
          actionName,
          'I6-handoff-shape',
          `${JSON.stringify(handoff)} expected ${JSON.stringify(model.handoff)}`,
        );
    }
    if (navigationRef.isReady()) {
      for (const route of navigationRef.getRootState()?.routes ?? []) {
        if (
          route.name === 'Analyze' &&
          (route.params as { source?: string } | undefined)?.source !== 'camera'
        )
          record(
            step,
            actionName,
            'I6-analyze-params',
            JSON.stringify(route.params ?? null),
          );
      }
    }

    const instances = resultInstances(renderer);
    const entries = model.stack.filter(entry => entry.name === 'Result');
    if (instances.length !== entries.length) {
      record(
        step,
        actionName,
        'I2-instances',
        `mounted ${instances.length} Result screens, stack has ${entries.length}`,
      );
    }
    const surfaces: string[] = [];
    const labels: Array<string | null> = [];
    const topIndex = model.stack.length - 1;
    entries.forEach((entry, index) => {
      const scope = instances[index];
      if (!scope) return;
      const focused = model.stack[topIndex] === entry;
      const seen = checkResultInstance(step, actionName, scope, entry, focused);
      surfaces.push(seen.surface);
      labels.push(seen.label);
    });
    trace.push({
      step,
      action: actionName,
      stack: stack.map(
        r => `${r.name}${r.analysisId ? `:${r.analysisId}` : ''}`,
      ),
      surfaces,
      labels,
    });
    coverage.maxDepth = Math.max(coverage.maxDepth, stack.length);
    coverage.maxResultInstances = Math.max(
      coverage.maxResultInstances,
      instances.length,
    );
    if (model.stack[topIndex]?.name === 'Result') {
      const last = surfaces.length - 1;
      states.add(`${surfaces[last] ?? 'none'}@${labels[last] ?? '-'}`);
    }
  };

  check(0, 'mount');

  const pressFirst = async (
    scope: ReactTestInstance,
    testID: string,
  ): Promise<boolean> => {
    const [node] = pressables(scope, testID);
    if (!node) return false;
    await act(async () => {
      node.props.onPress();
    });
    return true;
  };

  const repoint = (entry: Entry, analysisId: string) => {
    if (entry.analysisId === analysisId) return;
    entry.analysisId = analysisId;
    entry.stepIndex = 0;
  };

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    const name = describeAction(action);
    const entry = topResult();
    const scope = topResultScope(renderer);
    const attempt = entry?.analysisId
      ? attemptById(entry.analysisId)
      : undefined;
    const steps = attempt ? oracleSteps(w, attempt) : [];
    const guide =
      entry && scope && hostsByTestId(scope, 'result-guide').length === 1
        ? scope
        : null;
    lastActionSettled = true;
    const before = JSON.stringify(model.stack);
    try {
      switch (action.kind) {
        case 'next': {
          if (
            guide &&
            entry &&
            steps.length > 0 &&
            (await pressFirst(guide, 'result-guide-next'))
          ) {
            entry.stepIndex = Math.min(steps.length - 1, entry.stepIndex + 1);
          }
          break;
        }
        case 'back': {
          if (
            guide &&
            entry &&
            steps.length > 0 &&
            (await pressFirst(guide, 'result-guide-back'))
          ) {
            entry.stepIndex = Math.max(0, entry.stepIndex - 1);
          }
          break;
        }
        case 'toDrills': {
          // Walk forward until the DRILLS page (or the last page) is showing.
          if (!guide || !entry || steps.length === 0) break;
          const target = steps.indexOf('drills');
          const stop = target === -1 ? steps.length - 1 : target;
          while (entry.stepIndex < stop) {
            if (!(await pressFirst(guide, 'result-guide-next'))) break;
            entry.stepIndex += 1;
          }
          break;
        }
        case 'doubleNext':
        case 'doubleBack': {
          // Two taps inside one event loop turn (a double tap before re-render).
          if (!guide || !entry || steps.length === 0) break;
          const id =
            action.kind === 'doubleNext'
              ? 'result-guide-next'
              : 'result-guide-back';
          const [node] = pressables(guide, id);
          if (!node) break;
          await act(async () => {
            node.props.onPress();
            node.props.onPress();
          });
          entry.stepIndex =
            action.kind === 'doubleNext'
              ? Math.min(steps.length - 1, entry.stepIndex + 2)
              : Math.max(0, entry.stepIndex - 2);
          break;
        }
        case 'navToGhost': {
          // An analysisId no row backs (deleted shot, stale deep link).
          const ghost = `ghost-${seed}`;
          const current = top();
          if (current.name === 'Tabs') {
            await act(async () => {
              navigationRef.navigate('Result', { analysisId: ghost });
            });
            model.stack = [...model.stack, resultEntry(ghost)];
          } else if (current.name === 'Result') {
            await act(async () => {
              navigationRef.navigate('Result', { analysisId: ghost });
            });
            repoint(current, ghost);
          }
          break;
        }
        case 'done':
        case 'close': {
          const id =
            action.kind === 'done' ? 'result-guide-done' : 'result-guide-close';
          let pressed = guide ? await pressFirst(guide, id) : false;
          if (
            !pressed &&
            scope &&
            action.kind === 'close' &&
            surfaceOf(scope).spinner === 1
          ) {
            // The opening spinner's header Close (ScreenHeader, no testID).
            const [close] = scope.findAll(
              node =>
                node.props.accessibilityLabel === 'Close' &&
                typeof node.props.onPress === 'function',
            );
            if (close) {
              await act(async () => {
                close.props.onPress();
              });
              pressed = true;
            }
          }
          if (pressed) model.stack = [model.stack[0]!];
          break;
        }
        case 'tryAgain': {
          if (
            guide &&
            attempt &&
            (await pressFirst(guide, 'result-guide-try-again'))
          ) {
            model.stack = [...model.stack, stubEntry('Analyze')];
            model.handoffArmed = true;
            const evidence = evidenceFor(w, attempt);
            model.handoff = tryAgainFromResult(
              evidence.record,
              evidence.analysis ?? evidence.record?.result ?? null,
            );
          }
          break;
        }
        case 'openLibrary': {
          if (
            guide &&
            (await pressFirst(guide, 'recommended-drills-open-library'))
          ) {
            model.stack = [...model.stack, stubEntry('DrillLibrary')];
          }
          break;
        }
        case 'retryDrills': {
          if (guide) await pressFirst(guide, 'recommended-drills-retry');
          break;
        }
        case 'toggleSave': {
          if (!guide || !entry) break;
          const toggles = pressablesMatching(
            guide,
            'recommended-drill-',
          ).filter(node => String(node.props.testID).endsWith('-save'));
          const toggle = toggles[action.index % Math.max(1, toggles.length)];
          if (!toggle || toggle.props.disabled) break;
          const slug = String(toggle.props.testID).slice(
            'recommended-drill-'.length,
            -'-save'.length,
          );
          const before = Boolean(
            (toggle.props.accessibilityState as { selected?: boolean })
              ?.selected,
          );
          const mutationIdle = useTrainingStore.getState().mutation === 'idle';
          coverage.toggles += 1;
          await act(async () => {
            toggle.props.onPress();
          });
          await flushMicrotasks();
          if (!mutationIdle) break;
          if (w.training === 'ok') {
            model.saved[slug] = !before;
            model.expectMutationError = false;
          } else {
            model.saved[slug] = before;
            model.expectMutationError = true;
          }
          break;
        }
        case 'dismissError': {
          if (!guide || !entry) break;
          const [card] = hostsByTestId(guide, 'training-mutation-error');
          if (!card) break;
          const [button] = card.findAll(
            node =>
              typeof node.props.onPress === 'function' &&
              node.props.label === 'Dismiss',
          );
          if (!button) break;
          await act(async () => {
            button.props.onPress();
          });
          model.expectMutationError = false;
          break;
        }
        case 'openAttempt': {
          if (!guide || !entry) break;
          const target = w.attempts[action.index];
          if (!target) break;
          const [pill] = pressables(guide, `practice-set-attempt-${target.id}`);
          if (!pill) break;
          await act(async () => {
            pill.props.onPress();
          });
          // navigation.replace('Result', …): same depth, fresh route (new key).
          if (target.id !== entry.analysisId) {
            model.stack = [...model.stack.slice(0, -1), resultEntry(target.id)];
          }
          break;
        }
        case 'navBack': {
          if (model.stack.length <= 1 || !navigationRef.canGoBack()) break;
          await act(async () => {
            navigationRef.goBack();
          });
          model.stack = model.stack.slice(0, -1);
          break;
        }
        case 'navToResult': {
          const target = w.attempts[action.index];
          if (!target) break;
          const current = top();
          if (current.name === 'Tabs') {
            // Home/Library/Progress → navigate('Result'): a push.
            await act(async () => {
              navigationRef.navigate('Result', { analysisId: target.id });
            });
            model.stack = [...model.stack, resultEntry(target.id)];
          } else if (current.name === 'Analyze') {
            // AnalyzeScreen → replace('Result') once the analysis lands.
            await act(async () => {
              navigationRef.dispatch(
                StackActions.replace('Result', { analysisId: target.id }),
              );
            });
            model.stack = [...model.stack.slice(0, -1), resultEntry(target.id)];
          } else if (current.name === 'Result') {
            // navigate() onto the focused route only repoints its params.
            await act(async () => {
              navigationRef.navigate('Result', { analysisId: target.id });
            });
            repoint(current, target.id);
          } else {
            // ResultDetails → popTo('Result', …): back to the nearest Result.
            await act(async () => {
              navigationRef.dispatch(
                StackActions.popTo('Result', { analysisId: target.id }),
              );
            });
            let at = -1;
            for (let i = model.stack.length - 1; i >= 0; i -= 1) {
              if (model.stack[i]!.name === 'Result') {
                at = i;
                break;
              }
            }
            if (at === -1) {
              model.stack = [
                ...model.stack.slice(0, -1),
                resultEntry(target.id),
              ];
            } else {
              model.stack = model.stack.slice(0, at + 1);
              repoint(model.stack[at]!, target.id);
            }
          }
          break;
        }
        case 'pushFormReview': {
          if (!entry?.analysisId) break;
          const analysisId = entry.analysisId;
          await act(async () => {
            navigationRef.navigate('FormReview', { analysisId });
          });
          model.stack = [
            ...model.stack,
            { ...stubEntry('FormReview'), analysisId },
          ];
          break;
        }
        case 'settle': {
          await flushMicrotasks(6);
          break;
        }
        case 'tick': {
          await act(async () => {
            jest.advanceTimersByTime(action.ms);
          });
          lastActionSettled = false;
          break;
        }
        case 'release': {
          const pending = deferred.splice(0);
          await act(async () => {
            for (const release of pending) release();
          });
          break;
        }
      }
    } catch (error) {
      record(
        index + 1,
        name,
        'I1-throw',
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      );
    }
    if (action.kind !== 'tick') await flushMicrotasks();
    if (JSON.stringify(model.stack) !== before) coverage.effective += 1;
    check(index + 1, name);
  }

  try {
    await act(async () => {
      renderer.unmount();
    });
  } catch (error) {
    record(
      actions.length + 1,
      'unmount',
      'I10-unmount',
      error instanceof Error ? error.message : String(error),
    );
  }
  await flushMicrotasks();
  for (const message of consoleErrors.splice(0))
    record(actions.length + 1, 'unmount', 'I1-console.error', message);
  // Drop timers the unmounted tree left on the fake clock (query GC, stack
  // transitions) and the recorded `mock.calls` of the preset's native-module
  // mocks (they pin animation closures over dead trees) so iterations do not
  // accumulate — measured at ~2.5 MB/seed without this.
  jest.clearAllTimers();
  jest.clearAllMocks();

  console.error = originalError;
  process.off('unhandledRejection', onRejection);
  deferred = [];

  return {
    seed,
    length: actions.length,
    world: worldWithoutSeed(w),
    actions: actions.map(describeAction),
    violations,
    trace,
    traceHash: hashString(JSON.stringify(trace)),
    crashed,
    coverage: { ...coverage, states: [...states].sort() },
  };
}

const consistencyInitial = useConsistencyStore.getState();

// ─── Minimisation (greedy ddmin over the action list) ───────────────────────

function signature(result: RunResult): string {
  const first = result.violations[0];
  return first ? first.invariant : result.crashed ? 'crash' : 'ok';
}

async function minimise(
  seed: number,
  actions: Action[],
  target: string,
): Promise<Action[]> {
  let current = actions;
  let progress = true;
  let budget = 120;
  while (progress && budget > 0) {
    progress = false;
    for (let i = 0; i < current.length && budget > 0; i += 1) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      budget -= 1;
      const result = await runScenario(seed, candidate);
      if (signature(result) === target) {
        current = candidate;
        progress = true;
        i -= 1;
      }
    }
  }
  return current;
}

function actionsForSeed(seed: number): Action[] {
  const rng = new Rng(seed);
  const w = generateWorld(seed, rng);
  return generateActions(rng, w);
}

// ─── Campaign ───────────────────────────────────────────────────────────────

const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? 40));
const SEED_BASE = Number(process.env.STRESS_SEED_BASE ?? 20260904);
const DETERMINISM_EVERY = Math.max(
  1,
  Number(process.env.STRESS_DETERMINISM_EVERY ?? 8),
);
const FLAKE_RUNS = Math.max(1, Number(process.env.STRESS_FLAKE_RUNS ?? 10));
const OUT = process.env.STRESS_OUT ?? null;
/** `STRESS_REPLAY="<seed>:<action>,<action>,…"` replays one minimised case. */
const REPLAY = process.env.STRESS_REPLAY ?? null;
/** Times the replayed case is run back to back (flake rate / heap probe). */
const REPLAY_REPEAT = Math.max(
  1,
  Number(process.env.STRESS_REPLAY_REPEAT ?? 1),
);
const CHUNK = 100;

interface SeedOutcome {
  seed: number;
  length: number;
  outcome: 'HELD' | 'BROKEN';
  traceHash: string;
  deterministic: boolean | null;
  violations: Violation[];
  world: Omit<World, 'seed'>;
  actions: string[];
  coverage: Coverage;
  /** Full per-step trace, kept for failures and the first seeds of a run. */
  trace?: StepTrace[];
}

interface FailureReport {
  seed: number;
  signature: string;
  violations: Violation[];
  minimizedActions: string[];
  minimizedLength: number;
  originalLength: number;
  flakeRuns: number;
  flakeFailures: number;
  trace: StepTrace[];
}

const outcomes: SeedOutcome[] = [];
const failures: FailureReport[] = [];
let executed = 0;
let determinismChecks = 0;
/** heapUsed (MB) sampled at the end of every chunk — flags harness leaks. */
const heapSamples: Array<{ afterSeed: number; heapUsedMb: number }> = [];

/** Forces a GC when jest runs under `node --expose-gc` so samples compare. */
function heapUsedMb(): number {
  const { gc } = globalThis as { gc?: () => void };
  if (gc) gc();
  return Math.round(process.memoryUsage().heapUsed / 1048576);
}
let determinismMismatches = 0;

const chunks: number[][] = [];
for (let start = 0; start < ITER; start += CHUNK) {
  const chunk: number[] = [];
  for (let i = start; i < Math.min(ITER, start + CHUNK); i += 1)
    chunk.push(SEED_BASE + i);
  chunks.push(chunk);
}

jest.setTimeout(30 * 60 * 1000);

beforeAll(() => {
  jest.useFakeTimers();
});

afterAll(() => {
  jest.useRealTimers();
  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(
      OUT,
      JSON.stringify(
        {
          unit: 'scr-resultscreen',
          lens: 'randomized-seeded',
          seedBase: SEED_BASE,
          requested: ITER,
          executed,
          held: outcomes.filter(o => o.outcome === 'HELD').length,
          broken: outcomes.filter(o => o.outcome === 'BROKEN').length,
          determinismChecks,
          determinismMismatches,
          heapSamples,
          failures,
          results: outcomes,
        },
        null,
        2,
      ),
    );
  }
});

describe('ResultScreen — seeded randomized long-run (real navigator + stores)', () => {
  if (REPLAY) {
    it(`replays ${REPLAY}`, async () => {
      const [seedText, actionText] = REPLAY.split(':');
      const seed = Number(seedText);
      const actions = actionText
        ? actionText.split(',').map(parseAction)
        : null;
      const failed: number[] = [];
      for (let repeat = 0; repeat < REPLAY_REPEAT; repeat += 1) {
        const result = await runScenario(seed, actions);
        executed += 1;
        if (result.violations.length > 0) failed.push(repeat);
        outcomes.push({
          seed,
          length: result.length,
          outcome: result.violations.length > 0 ? 'BROKEN' : 'HELD',
          traceHash: result.traceHash,
          deterministic: null,
          violations: result.violations,
          world: result.world,
          actions: result.actions,
          coverage: result.coverage,
          ...(repeat === 0 || result.violations.length > 0
            ? { trace: result.trace }
            : {}),
        });
        if (repeat % 10 === 9)
          heapSamples.push({
            afterSeed: repeat,
            heapUsedMb: heapUsedMb(),
          });
      }
      expect(failed).toEqual([]);
    });
    return;
  }

  it.each(chunks.map((chunk, index) => [index, chunk] as const))(
    'chunk %i holds every invariant on every seed',
    async (_index, chunk) => {
      for (const seed of chunk) {
        const first = await runScenario(seed, null);
        executed += 1;
        const broken = first.violations.length > 0;
        let deterministic: boolean | null = null;
        if (broken || (seed - SEED_BASE) % DETERMINISM_EVERY === 0) {
          const second = await runScenario(seed, null);
          executed += 1;
          determinismChecks += 1;
          deterministic = second.traceHash === first.traceHash;
          if (!deterministic) {
            determinismMismatches += 1;
            first.violations.push({
              step: -1,
              action: 'replay',
              invariant: 'I9-determinism',
              detail: `trace ${first.traceHash} vs ${second.traceHash}`,
            });
          }
        }
        outcomes.push({
          seed,
          length: first.length,
          outcome: first.violations.length > 0 ? 'BROKEN' : 'HELD',
          traceHash: first.traceHash,
          deterministic,
          violations: first.violations,
          world: first.world,
          actions: first.actions,
          coverage: first.coverage,
          ...(first.violations.length > 0 || seed - SEED_BASE < 25
            ? { trace: first.trace }
            : {}),
        });
        if (first.violations.length > 0) {
          const target = signature(first);
          let flakeFailures = 0;
          for (let run = 0; run < FLAKE_RUNS; run += 1) {
            const again = await runScenario(seed, null);
            executed += 1;
            if (again.violations.length > 0) flakeFailures += 1;
          }
          const minimized =
            target === 'ok'
              ? actionsForSeed(seed)
              : await minimise(seed, actionsForSeed(seed), target);
          failures.push({
            seed,
            signature: target,
            violations: first.violations,
            minimizedActions: minimized.map(describeAction),
            minimizedLength: minimized.length,
            originalLength: first.length,
            flakeRuns: FLAKE_RUNS,
            flakeFailures,
            trace: first.trace,
          });
        }
      }
      heapSamples.push({
        afterSeed: chunk[chunk.length - 1]!,
        heapUsedMb: heapUsedMb(),
      });
      const brokenSeeds = outcomes
        .filter(o => chunk.includes(o.seed) && o.outcome === 'BROKEN')
        .map(
          o =>
            `${o.seed}: ${o.violations
              .map(v => `${v.invariant}@${v.step}(${v.action}) ${v.detail}`)
              .join(' | ')}`,
        );
      expect(brokenSeeds).toEqual([]);
    },
  );
});
