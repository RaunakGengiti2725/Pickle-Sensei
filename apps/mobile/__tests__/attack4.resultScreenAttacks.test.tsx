/**
 * ADVERSARIAL PASS #4 — the mounted Result guide attacked through its data
 * boundaries (evidence loader, facts store, sidecar reader, drills API,
 * accessibility) and its navigation seams:
 *
 *  S4  sessionId with 200 facts none of which is comparable → THIS SET is
 *      hidden and no "0 of 0" / "Attempt 1 of 1" copy exists anywhere.
 *  S5  clip=null + a sidecar whose SHA mismatches → the problem page shows
 *      kicker / h1 / FixList and no pose caption leaks.
 *  S6  AccessibilityInfo.isReduceMotionEnabled resolves AFTER the first page
 *      renders → the page never animates twice or flashes.
 *  S7  three attempt switches while RecommendedDrills fetches are pending,
 *      resolved out of order → only the latest attempt's drills render.
 *  +   out-of-order EVIDENCE resolution across the same switches, unicode +
 *      huge ids, corrupt fact rows, reduce-motion toggling via the OS event.
 *
 * Tests titled "FINDING:" are reproductions that FAIL on 4d812e1a by design
 * (the failure is the evidence); everything else pins behaviour that held.
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
jest.mock('../src/data/repository', () => ({
  hasShotSyncReceipt: (...args: unknown[]) => mockHasShotSyncReceipt(...args),
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
import { AccessibilityInfo, Animated, Text } from 'react-native';
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
import { clearTryAgainHandoff } from '../src/screens/tryAgainHandoff';
import type {
  ReviewJoint,
  ReviewPoseFrame,
  ReviewPoseSequence,
} from '../src/review/formReviewModel';
import type { StrokeResultEvidenceRecord } from '../src/components/strokeResultModel';
import type { RealAnalysisFact } from '../src/data/repository';
import type { CatalogDrill } from '../src/training/api';
import { clearTrainingStoreConfiguration } from '../src/training/store';
import { summarizePracticeSet } from '../src/progress/practiceSetProgress';

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
    ],
    ...overrides,
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

const session = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'access-token',
  canonicalAppUserId: '00000000-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};

function fact(overrides: Partial<RealAnalysisFact>): RealAnalysisFact {
  return {
    id: 'fact',
    shotType: 'forehand_drive',
    capturedAt: '2026-09-01T09:50:00.000Z',
    overallScore: 6.4,
    confidence: 0.8,
    resultKind: 'scored',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
    sessionId: 'set-1',
    priorityCheckpoint: 'contact_position',
    checkpointScores: { contact_position: 41 },
    ...overrides,
  };
}

/** Seeded LCG so the 200-fact shapes are reproducible (seed recorded). */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
const SEED = 0x4d812e1a;

function deferred<T>() {
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

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderScreen() {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ResultScreen />);
  });
  await settle();
  mounted.push(renderer);
  return renderer;
}

/** Same-instance route param change (the setParams / replace-in-place seam). */
async function repoint(renderer: ReactTestRenderer, analysisId: string) {
  mockRouteParams = { analysisId };
  await act(async () => {
    renderer.update(<ResultScreen />);
  });
  await settle();
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

function allLabels(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll(node => typeof node.props.accessibilityLabel === 'string')
    .map(node => node.props.accessibilityLabel as string)
    .join(' | ');
}

function hostByTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function pressableByTestId(renderer: ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.testID === testID &&
      typeof candidate.props.onPress === 'function',
  );
  if (!node) throw new Error(`no pressable with testID ${testID}`);
  return node;
}

async function press(renderer: ReactTestRenderer, testID: string) {
  const node = pressableByTestId(renderer, testID);
  await act(async () => {
    node.props.onPress();
  });
  await settle();
}

function stepLabel(renderer: ReactTestRenderer): string {
  const [label] = hostByTestId(renderer, 'result-guide-step-label');
  if (!label) return '';
  const children = label.props.children;
  return Array.isArray(children) ? children.join('') : String(children);
}

function drillSlugs(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll(
      node =>
        typeof node.type === 'string' &&
        typeof node.props.testID === 'string' &&
        /^recommended-drill-[a-z0-9-]+$/.test(node.props.testID) &&
        !node.props.testID.endsWith('-save'),
    )
    .map(node =>
      (node.props.testID as string).slice('recommended-drill-'.length),
    );
}

// The reduce-motion observer starts ONCE per module instance: every test in
// this file resolves it through the same deferred, so the S6 test must run
// with the resolution still pending when its first page renders.
const reduceMotionGate = deferred<boolean>();
const isReduceMotionEnabled =
  AccessibilityInfo.isReduceMotionEnabled as unknown as jest.Mock;
isReduceMotionEnabled.mockImplementation(() => reduceMotionGate.promise);

// Captured once: `jest.clearAllMocks()` in beforeEach wipes the mock's call
// log, but the observer registers its listener only on the FIRST render.
let capturedReduceMotionListener: ((value: boolean) => void) | null = null;
function reduceMotionListener(): (value: boolean) => void {
  if (capturedReduceMotionListener) return capturedReduceMotionListener;
  const listener = (
    AccessibilityInfo.addEventListener as unknown as jest.Mock
  ).mock.calls.find(call => call[0] === 'reduceMotionChanged')?.[1];
  if (typeof listener !== 'function') {
    throw new Error('reduceMotionChanged listener was never registered');
  }
  capturedReduceMotionListener = listener as (value: boolean) => void;
  return capturedReduceMotionListener;
}

/** StepReveal's own reveal (240ms ease-out) — other Animated.timing users
 * (the loading spinner's 1400ms spin, PressableScale) are filtered out. */
function revealCalls(timing: jest.SpyInstance): number {
  return timing.mock.calls.filter(
    call => (call[1] as { duration?: number }).duration === 240,
  ).length;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  isReduceMotionEnabled.mockImplementation(() => reduceMotionGate.promise);
  clearTryAgainHandoff();
  clearTrainingStoreConfiguration();
  mockRouteParams = { analysisId: 'analysis-1' };
  mockLoadEvidence.mockResolvedValue(scoredEvidence());
  mockLoadSequence.mockResolvedValue(fullBodySequence());
  mockHasShotSyncReceipt.mockResolvedValue(false);
  mockListRealAnalysisFacts.mockResolvedValue([]);
  mockGetApiSession.mockReturnValue(session);
  mockListCatalogDrills.mockResolvedValue([]);
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  jest.useRealTimers();
});

// ─── S6 (first: the observer's one-shot resolution must still be pending) ──

describe('attack4/S6 — reduce motion resolves after the first page renders', () => {
  it('no second reveal and no flash when isReduceMotionEnabled resolves late; Next after that is instant', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    const renderer = await renderScreen();
    expect(stepLabel(renderer)).toBe('1 OF 4 · SCORE');
    reduceMotionListener();
    // The first page never animates in (StepReveal skips its mount pass).
    expect(revealCalls(timing)).toBe(0);
    expect(isReduceMotionEnabled).toHaveBeenCalledTimes(1);

    // The OS answers AFTER the page is on screen: reduce motion ON.
    await act(async () => {
      reduceMotionGate.resolve(true);
      await Promise.resolve();
    });
    await settle();
    // A late "true" must not re-run the reveal (no flash, no second
    // animation) — the page is already fully visible.
    expect(revealCalls(timing)).toBe(0);
    expect(stepLabel(renderer)).toBe('1 OF 4 · SCORE');

    // With reduce motion on, the next page is instant.
    await press(renderer, 'result-guide-next');
    expect(stepLabel(renderer)).toBe('2 OF 4 · THE PROBLEM');
    expect(revealCalls(timing)).toBe(0);

    // OS switches reduce motion OFF; the NEXT page change animates exactly
    // once (the flip itself is the FINDING below).
    await act(async () => {
      reduceMotionListener()(false);
    });
    await settle();
    timing.mockClear();
    await press(renderer, 'result-guide-next');
    expect(stepLabel(renderer)).toBe('3 OF 4 · DRILLS');
    expect(revealCalls(timing)).toBe(1);
    timing.mockRestore();
  });

  // StepReveal's effect lists `reduced` in its deps: when the OS flips Reduce
  // Motion OFF while a page is fully visible (no page change), the effect
  // re-runs, drops opacity to 0 and fades the SAME page back in — a flash.
  it('FINDING: reduce motion flipping OFF with no page change must not re-reveal (flash) the visible page', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    const renderer = await renderScreen();
    await act(async () => {
      reduceMotionListener()(true);
    });
    await settle();
    await press(renderer, 'result-guide-next');
    expect(stepLabel(renderer)).toBe('2 OF 4 · THE PROBLEM');
    timing.mockClear();
    await act(async () => {
      reduceMotionListener()(false);
    });
    await settle();
    const spuriousReveals = revealCalls(timing);
    console.info(
      `[attack4/S6-toggle-off] StepReveal Animated.timing(240ms) calls caused by the reduce-motion OFF event alone (no page change): ${spuriousReveals}`,
    );
    expect(stepLabel(renderer)).toBe('2 OF 4 · THE PROBLEM');
    expect(spuriousReveals).toBe(0);
    timing.mockRestore();
  });

  it('reduce-motion flipping ON via the OS event with a page change in the same tick animates at most once', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    const renderer = await renderScreen();
    await act(async () => {
      reduceMotionListener()(false);
    });
    timing.mockClear();
    const next = pressableByTestId(renderer, 'result-guide-next');
    await act(async () => {
      next.props.onPress();
      reduceMotionListener()(true);
    });
    await settle();
    expect(stepLabel(renderer)).toBe('2 OF 4 · THE PROBLEM');
    expect(revealCalls(timing)).toBeLessThanOrEqual(1);
    // Restore the observer's value for later tests.
    await act(async () => {
      reduceMotionListener()(false);
    });
    timing.mockRestore();
  });
});

// ─── S4 ─────────────────────────────────────────────────────────────────────

describe('attack4/S4 — 200 facts, none comparable', () => {
  function nonMatchingFacts(): RealAnalysisFact[] {
    const rand = seeded(SEED);
    const facts: RealAnalysisFact[] = [];
    for (let i = 0; i < 200; i++) {
      const reason = Math.floor(rand() * 5);
      const base = {
        id: `fact-${i}`,
        capturedAt: new Date(
          Date.UTC(2026, 8, 1, 9, 0, Math.floor(rand() * 3000)),
        ).toISOString(),
        overallScore: Math.round(rand() * 100) / 10,
      };
      switch (reason) {
        case 0:
          facts.push(fact({ ...base, sessionId: `other-set-${i}` }));
          break;
        case 1:
          facts.push(fact({ ...base, sessionId: '' }));
          break;
        case 2:
          facts.push(fact({ ...base, sessionId: null as unknown as string }));
          break;
        case 3:
          facts.push(fact({ ...base, sessionId: 'SET-1' })); // case differs
          break;
        default:
          facts.push(fact({ ...base, sessionId: 'set-1 ' })); // trailing space
      }
    }
    return facts;
  }

  it('THIS SET stays hidden; no "0 of 0", no "Attempt 1 of 1" anywhere', async () => {
    const facts = nonMatchingFacts();
    expect(facts).toHaveLength(200);
    expect(facts.filter(f => f.sessionId === 'set-1')).toHaveLength(0);
    mockListRealAnalysisFacts.mockResolvedValue(facts);
    const renderer = await renderScreen();
    expect(mockListRealAnalysisFacts).toHaveBeenCalledWith({}, 200);
    expect(hostByTestId(renderer, 'result-guide-practice-set')).toHaveLength(0);
    expect(hostByTestId(renderer, 'practice-set-card')).toHaveLength(0);
    const copy = `${allText(renderer)} || ${allLabels(renderer)}`;
    expect(copy).not.toContain('THIS SET');
    expect(copy).not.toMatch(/\b0 of 0\b/);
    expect(copy).not.toMatch(/Attempt \d+ of \d+/);
    // Walk every page: nothing leaks there either.
    for (let i = 0; i < 3; i++) {
      await press(renderer, 'result-guide-next');
      const page = `${allText(renderer)} || ${allLabels(renderer)}`;
      expect(page).not.toContain('THIS SET');
      expect(page).not.toMatch(/\b0 of 0\b/);
      expect(page).not.toMatch(/Attempt \d+ of \d+/);
    }
    expect(stepLabel(renderer)).toBe('4 OF 4 · NEXT');
  });

  it('200 facts in the set but only ONE comparable (the current read) → still hidden', async () => {
    const rand = seeded(SEED + 1);
    const facts: RealAnalysisFact[] = [
      fact({
        id: 'analysis-1',
        overallScore: 7.1,
        capturedAt: '2026-09-01T10:00:00.000Z',
      }),
    ];
    for (let i = 1; i < 200; i++) {
      const reason = Math.floor(rand() * 4);
      const base = {
        id: `fact-${i}`,
        capturedAt: `2026-09-01T09:${String(10 + (i % 49)).padStart(2, '0')}:00.000Z`,
      };
      switch (reason) {
        case 0:
          facts.push(fact({ ...base, shotType: 'backhand_drive' }));
          break;
        case 1:
          facts.push(fact({ ...base, scoringModelVersion: 'sm-v0' }));
          break;
        case 2:
          facts.push(fact({ ...base, shotConfigVersion: 'forehand_drive@0' }));
          break;
        default:
          facts.push(
            fact({
              ...base,
              resultKind: 'low_confidence',
              overallScore: null as unknown as number,
            }),
          );
      }
    }
    expect(summarizePracticeSet(facts, 'set-1')).toBeNull();
    mockListRealAnalysisFacts.mockResolvedValue(facts);
    const renderer = await renderScreen();
    expect(hostByTestId(renderer, 'result-guide-practice-set')).toHaveLength(0);
    const copy = `${allText(renderer)} || ${allLabels(renderer)}`;
    expect(copy).not.toContain('THIS SET');
    expect(copy).not.toMatch(/\b0 of 0\b|\b1 of 1\b/);
  });

  it('corrupt fact rows (NaN scores, non-object checkpoint maps, unicode ids) never crash and never show a set', async () => {
    const facts: RealAnalysisFact[] = [
      fact({ id: 'analysis-1', overallScore: 7.1 }),
      fact({ id: '🥒-fact', overallScore: Number.NaN }),
      fact({ id: 'fact-inf', overallScore: Number.POSITIVE_INFINITY }),
      fact({
        id: 'fact-list',
        overallScore: 6,
        checkpointScores: ['contact_position'] as unknown as Record<
          string,
          number
        >,
        resultKind: 'scored',
        shotType: 'backhand_drive',
      }),
      fact({ id: 'fact-str', overallScore: '7.0' as unknown as number }),
    ];
    mockListRealAnalysisFacts.mockResolvedValue(facts);
    const renderer = await renderScreen();
    expect(hostByTestId(renderer, 'result-guide-practice-set')).toHaveLength(0);
    expect(allText(renderer)).not.toMatch(/NaN|Infinity/);
  });

  it('facts loader rejecting → no set, no crash; facts arriving after a repoint are dropped', async () => {
    mockListRealAnalysisFacts.mockRejectedValue(new Error('sqlite locked'));
    const renderer = await renderScreen();
    expect(hostByTestId(renderer, 'result-guide-practice-set')).toHaveLength(0);
    expect(stepLabel(renderer)).toBe('1 OF 4 · SCORE');

    // Two comparable facts arrive only after the screen repointed to an
    // attempt in a DIFFERENT set: the stale summary must not attach to it.
    const late = deferred<RealAnalysisFact[]>();
    mockListRealAnalysisFacts.mockReturnValueOnce(late.promise);
    mockListRealAnalysisFacts.mockResolvedValue([]);
    mockLoadEvidence.mockImplementation(async (_db: unknown, id: string) =>
      id === 'analysis-9'
        ? scoredEvidence({
            analysis: { ...scoredAnalysis, id, sessionId: 'set-9' },
            attempts: [],
          })
        : scoredEvidence(),
    );
    await repoint(renderer, 'analysis-1b');
    await repoint(renderer, 'analysis-9');
    await act(async () => {
      late.resolve([
        fact({ id: 'a', overallScore: 5 }),
        fact({
          id: 'b',
          overallScore: 6.5,
          capturedAt: '2026-09-01T09:55:00.000Z',
        }),
      ]);
    });
    await settle();
    expect(hostByTestId(renderer, 'result-guide-practice-set')).toHaveLength(0);
    expect(allText(renderer)).not.toContain('THIS SET');
  });
});

// ─── S5 ─────────────────────────────────────────────────────────────────────

describe('attack4/S5 — clip=null with a hash-mismatched sidecar', () => {
  // `reviewAvailable` (ResultScreen.tsx) is decided from the sidecar REF in
  // the evidence row, not from the verified sequence: when the clip file is
  // gone AND the sidecar fails its SHA check, the problem page still mounts
  // the replay — an empty stage captioned "No clip file or recorded pose is
  // stored … The checkpoints below are still the ones the engine scored"
  // with NO fix cards below it — instead of the kicker / h1 / FixList page.
  it('FINDING: problem page: kicker + h1 + FixList, no pose caption, no player', async () => {
    mockLoadEvidence.mockResolvedValue(scoredEvidence({ clip: null }));
    // The sidecar reader returns null on a SHA mismatch (poseSidecar.ts);
    // that null is what reaches the guide.
    mockLoadSequence.mockResolvedValue(null);
    const renderer = await renderScreen();
    expect(mockLoadSequence).toHaveBeenCalledWith(sidecarRef);
    await press(renderer, 'result-guide-next');
    expect(stepLabel(renderer)).toBe('2 OF 4 · THE PROBLEM');
    expect(hostByTestId(renderer, 'result-guide-step-problem')).toHaveLength(1);
    console.info(
      `[attack4/S5] clip=null + sha-mismatch sidecar → player=${hostByTestId(renderer, 'form-review-player').length} stage=${hostByTestId(renderer, 'form-review-stage').length} fixList=${hostByTestId(renderer, 'fix-list').length} text="${allText(renderer).slice(0, 220)}"`,
    );
    expect(hostByTestId(renderer, 'form-review-player')).toHaveLength(0);
    expect(hostByTestId(renderer, 'form-review-stage')).toHaveLength(0);
    expect(hostByTestId(renderer, 'fix-list')).toHaveLength(1);
    const copy = allText(renderer);
    expect(copy).toContain('THE PROBLEM · PRIORITY');
    expect(copy).toContain('Contact position');
    expect(copy).toContain('Scored 48 — contact came late.');
    expect(copy).not.toContain('clip file is gone');
    expect(copy).not.toContain('measured pose is shown instead');
    expect(copy).not.toContain('No verified pose sequence');
    expect(copy).not.toContain('No clip file or recorded pose');
    expect(copy).not.toContain('Preparing your replay');
    expect(copy).not.toContain('STOP ');
  });

  it('sidecar reader REJECTING renders the identical page to it returning null (one code path, no second failure mode)', async () => {
    mockLoadEvidence.mockResolvedValue(scoredEvidence({ clip: null }));
    mockLoadSequence.mockResolvedValue(null);
    const viaNull = await renderScreen();
    await press(viaNull, 'result-guide-next');
    const nullText = allText(viaNull);
    const nullPlayer = hostByTestId(viaNull, 'form-review-player').length;

    mockLoadSequence.mockRejectedValue(new Error('sha256 mismatch'));
    const viaReject = await renderScreen();
    await press(viaReject, 'result-guide-next');
    expect(allText(viaReject)).toBe(nullText);
    expect(hostByTestId(viaReject, 'form-review-player')).toHaveLength(
      nullPlayer,
    );
    // The stop card still names the measured fault + cue on both.
    expect(nullText).toContain(
      'Contact position scored 48 — contact came late',
    );
    expect(nullText).not.toMatch(/NaN|undefined|null/);
  });

  it('sidecar still unresolved when the problem page opens: no caption flashes before the verdict', async () => {
    mockLoadEvidence.mockResolvedValue(scoredEvidence({ clip: null }));
    const gate = deferred<ReviewPoseSequence | null>();
    mockLoadSequence.mockReturnValue(gate.promise);
    const renderer = await renderScreen();
    await press(renderer, 'result-guide-next');
    let copy = allText(renderer);
    // Evidence says a sidecar exists → the replay page is chosen; while the
    // read is in flight it shows the loading state, never a pose caption.
    expect(copy).not.toMatch(/pose/i);
    expect(copy).not.toContain('clip file is gone');
    expect(copy).toContain('Preparing your replay');
    await act(async () => {
      gate.resolve(null);
    });
    await settle();
    copy = allText(renderer);
    console.info(
      `[attack4/S5-late-null] page after late null sidecar: player=${hostByTestId(renderer, 'form-review-player').length} fixList=${hostByTestId(renderer, 'fix-list').length} text="${copy.slice(0, 160)}"`,
    );
    // The loading state is gone and the fault is named (the page content
    // itself is the S5 FINDING above; this pins that nothing hangs).
    expect(copy).not.toContain('Preparing your replay');
    expect(copy).toContain('Contact position scored 48');
  });
});

// ─── S7 ─────────────────────────────────────────────────────────────────────

describe('attack4/S7 — three attempt switches with pending drills, resolved out of order', () => {
  const ATTEMPTS = ['attempt-A', 'attempt-B', 'attempt-C'] as const;

  function evidenceFor(id: string) {
    return scoredEvidence({
      analysis: { ...scoredAnalysis, id },
      record: { ...declaredRecord, id },
      attempts: ATTEMPTS.map(analysisId => ({
        analysisId,
        capturedAtIso: '2026-09-01T10:00:00.000Z',
        sessionId: 'set-1',
      })),
    });
  }

  it('same-instance repoint ×3 while each attempt is on its DRILLS page → only C drills render', async () => {
    mockLoadEvidence.mockImplementation(async (_db: unknown, id: string) =>
      evidenceFor(id),
    );
    const pending: Array<ReturnType<typeof deferred<CatalogDrill[]>>> = [];
    mockListCatalogDrills.mockImplementation(() => {
      const gate = deferred<CatalogDrill[]>();
      pending.push(gate);
      return gate.promise;
    });
    mockRouteParams = { analysisId: 'attempt-A' };
    const renderer = await renderScreen();
    for (const id of ATTEMPTS) {
      if (id !== 'attempt-A') await repoint(renderer, id);
      expect(stepLabel(renderer)).toBe('1 OF 4 · SCORE');
      await press(renderer, 'result-guide-next');
      await press(renderer, 'result-guide-next');
      expect(stepLabel(renderer)).toBe('3 OF 4 · DRILLS');
    }
    expect(pending).toHaveLength(3);
    expect(drillSlugs(renderer)).toEqual([]);

    // Resolve A, then C, then B.
    await act(async () => {
      pending[0]!.resolve([drill('drill-from-a', ['drive'])]);
    });
    await settle();
    expect(drillSlugs(renderer)).toEqual([]);
    await act(async () => {
      pending[2]!.resolve([drill('drill-from-c', ['drive'])]);
    });
    await settle();
    expect(drillSlugs(renderer)).toEqual(['drill-from-c']);
    await act(async () => {
      pending[1]!.resolve([drill('drill-from-b', ['drive'])]);
    });
    await settle();
    expect(drillSlugs(renderer)).toEqual(['drill-from-c']);
    const copy = allText(renderer);
    expect(copy).toContain('Drill From C');
    expect(copy).not.toContain('Drill From A');
    expect(copy).not.toContain('Drill From B');
  });

  it('stale drills REJECTING after the switch never surface an error on the latest attempt', async () => {
    mockLoadEvidence.mockImplementation(async (_db: unknown, id: string) =>
      evidenceFor(id),
    );
    const pending: Array<ReturnType<typeof deferred<CatalogDrill[]>>> = [];
    mockListCatalogDrills.mockImplementation(() => {
      const gate = deferred<CatalogDrill[]>();
      pending.push(gate);
      return gate.promise;
    });
    mockRouteParams = { analysisId: 'attempt-A' };
    const renderer = await renderScreen();
    for (const id of ATTEMPTS) {
      if (id !== 'attempt-A') await repoint(renderer, id);
      await press(renderer, 'result-guide-next');
      await press(renderer, 'result-guide-next');
    }
    await act(async () => {
      pending[0]!.reject(new Error('A timed out'));
      pending[1]!.reject(new Error('B timed out'));
    });
    await settle();
    expect(allText(renderer)).not.toContain('couldn’t be loaded');
    expect(hostByTestId(renderer, 'recommended-drills-retry')).toHaveLength(0);
    await act(async () => {
      pending[2]!.resolve([drill('drill-from-c', ['drive'])]);
    });
    await settle();
    expect(drillSlugs(renderer)).toEqual(['drill-from-c']);
  });

  it('EVIDENCE for three repoints resolving out of order (C, A, B) leaves attempt C on screen', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<unknown>>>();
    mockLoadEvidence.mockImplementation((_db: unknown, id: string) => {
      const gate = deferred<unknown>();
      gates.set(id, gate);
      return gate.promise;
    });
    mockRouteParams = { analysisId: 'attempt-A' };
    const renderer = await renderScreen();
    await repoint(renderer, 'attempt-B');
    await repoint(renderer, 'attempt-C');
    expect(gates.size).toBe(3);
    expect(allText(renderer)).toContain('Opening your result…');

    const distinct = (id: string, score: number) =>
      scoredEvidence({
        analysis: { ...scoredAnalysis, id, overallScore: score },
        record: { ...declaredRecord, id },
      });
    await act(async () => {
      gates.get('attempt-C')!.resolve(distinct('attempt-C', 3.3));
    });
    await settle();
    expect(allLabels(renderer)).toContain('Technique score 3.3 out of 10');
    await act(async () => {
      gates.get('attempt-A')!.resolve(distinct('attempt-A', 9.9));
      gates.get('attempt-B')!.resolve(distinct('attempt-B', 6.6));
    });
    await settle();
    const labels = allLabels(renderer);
    expect(labels).toContain('Technique score 3.3 out of 10');
    expect(labels).not.toContain('Technique score 9.9 out of 10');
    expect(labels).not.toContain('Technique score 6.6 out of 10');
  });

  it('attempt pill press → navigation.replace with the target only (never the current attempt)', async () => {
    mockLoadEvidence.mockImplementation(async (_db: unknown, id: string) =>
      evidenceFor(id),
    );
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({
        id: 'attempt-A',
        overallScore: 5.0,
        capturedAt: '2026-09-01T09:50:00.000Z',
      }),
      fact({
        id: 'attempt-B',
        overallScore: 6.0,
        capturedAt: '2026-09-01T09:55:00.000Z',
      }),
      fact({
        id: 'attempt-C',
        overallScore: 7.1,
        capturedAt: '2026-09-01T10:00:00.000Z',
      }),
    ]);
    mockRouteParams = { analysisId: 'attempt-C' };
    const renderer = await renderScreen();
    expect(hostByTestId(renderer, 'result-guide-practice-set')).toHaveLength(1);
    // One node per attempt label (PressableScale forwards the same props
    // through several composite layers).
    const byLabel = new Map<string, ReactTestInstance>();
    for (const node of renderer.root.findAll(
      candidate =>
        typeof candidate.props.accessibilityLabel === 'string' &&
        /^Attempt \d of 3/.test(candidate.props.accessibilityLabel) &&
        typeof candidate.props.onPress === 'function',
    )) {
      const label = node.props.accessibilityLabel as string;
      if (!byLabel.has(label)) byLabel.set(label, node);
    }
    const pills = [...byLabel.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, node]) => node);
    expect([...byLabel.keys()].sort()).toEqual([
      'Attempt 1 of 3, score 5.0',
      'Attempt 2 of 3, score 6.0',
      'Attempt 3 of 3, score 7.1, latest',
    ]);
    // Rapid: tap A, B, C, A in one burst.
    await act(async () => {
      pills[0]!.props.onPress();
      pills[1]!.props.onPress();
      pills[2]!.props.onPress();
      pills[0]!.props.onPress();
    });
    const calls = mockNavigation.replace.mock.calls.map(
      call => call[1].analysisId,
    );
    expect(calls).toEqual(['attempt-A', 'attempt-B', 'attempt-A']);
  });

  it('unicode + 4k-char analysis ids round-trip through repoint without corrupting the loader call', async () => {
    const weird = `🥒${'x'.repeat(4000)}\u202e-analysis`;
    mockLoadEvidence.mockImplementation(async (_db: unknown, id: string) =>
      scoredEvidence({ analysis: { ...scoredAnalysis, id } }),
    );
    const renderer = await renderScreen();
    await repoint(renderer, weird);
    expect(mockLoadEvidence).toHaveBeenLastCalledWith({}, weird);
    expect(stepLabel(renderer)).toBe('1 OF 4 · SCORE');
    expect(allText(renderer)).not.toContain('xxxxxxxx');
  });
});
