/**
 * RESULT GUIDE — mounted-flow pins for the sequential Result surface: a
 * scored analysis opens on the score page and nothing else (no drills, no
 * replay, no training plan on the first screen), Next walks SCORE → THE
 * PROBLEM (the form-review replay IS the non-scrolling page: a clean stage
 * frozen on the priority fault, the stop card + timeline + transport UNDER
 * it, no page headline and no full-screen link — fix cards only when there
 * is no replay evidence) → DRILLS (catalog drills with a Save-to-library
 * toggle) → NEXT (try again / done over ONE recap card: score / held / to
 * fix tiles + priority-fix and strongest rows, no full-breakdown link), Back
 * returns, an abstained result collapses to ONE honest page (the full sheet,
 * inline), and every sentence on every page is the same evidence-derived
 * copy the canonical selectors produce.
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
import { ScrollView, StyleSheet, Text } from 'react-native';
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
import { ResultScreen } from '../src/screens/ResultScreen';
import {
  clearTryAgainHandoff,
  peekTryAgainHandoff,
} from '../src/screens/tryAgainHandoff';
import type {
  ReviewJoint,
  ReviewPoseFrame,
  ReviewPoseSequence,
} from '../src/review/formReviewModel';
import { coachingCue } from '../src/review/formReviewModel';
import { DRILL_MATCH_NOTE } from '../src/review/recommendedDrillsModel';
import type { StrokeResultEvidenceRecord } from '../src/components/strokeResultModel';
import type { RealAnalysisFact } from '../src/data/repository';
import type { CatalogDrill } from '../src/training/api';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
} from '../src/training/store';
import type { TrainingApi } from '../src/training/types';
import { DUPR_ESTIMATE_NOTE } from '../src/progress/duprEstimate';

// ─── Fixtures (same shapes as the form review + stroke result suites) ───────

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

/** Honest abstention: the classifier would not commit, nothing was scored. */
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

// ─── Harness ────────────────────────────────────────────────────────────────

const mounted: ReactTestRenderer[] = [];

async function settle() {
  // Evidence → sidecar → catalog resolve on successive microtask turns.
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

/** The pinned primary's label (the design-system Button carries `label`). */
function primaryLabel(renderer: ReactTestRenderer, testID: string): string {
  const node = pressableByTestId(renderer, testID);
  return String(node.props.label ?? node.props.accessibilityLabel);
}

function flatStyle(node: { props: { style?: unknown } }) {
  return (StyleSheet.flatten(node.props.style as never) ?? {}) as Record<
    string,
    unknown
  >;
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

// ─── Scored: the four pages ─────────────────────────────────────────────────

describe('Result guide — scored analysis', () => {
  it('opens on the SCORE page: ring, DUPR estimate, ONE measured insight — and no drills, replay or plan', async () => {
    const renderer = await renderScreen();
    expect(mockLoadEvidence).toHaveBeenCalledWith({}, 'analysis-1');
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(1);
    expect(stepLabel(renderer)).toBe('1 OF 4 · SCORE');

    const copy = allText(renderer);
    expect(copy).toContain('TECHNIQUE SCORE · FOREHAND DRIVE');
    expect(
      renderer.root.findAll(
        node =>
          node.props.accessibilityLabel === 'Technique score 7.1 out of 10',
      ).length,
    ).toBeGreaterThan(0);
    expect(copy).toContain('(≈ DUPR 5.3)');
    expect(copy).toContain(DUPR_ESTIMATE_NOTE);
    // The ONE insight is the engine's worst measured checkpoint + its cue.
    expect(copy).toContain('WHAT THE CAMERA MEASURED');
    expect(copy).toContain('Contact position scored 48 — contact came late.');
    expect(copy).toContain(
      coachingCue('contact_position', 'late', 'forehand_drive'),
    );
    expect(copy).not.toMatch(/paddle track/i);

    // Nothing from the later pages leaks onto the first screen.
    expect(hostByTestId(renderer, 'result-guide-step-drills')).toHaveLength(0);
    expect(hostByTestId(renderer, 'recommended-drills')).toHaveLength(0);
    expect(hostByTestId(renderer, 'form-review-player')).toHaveLength(0);
    expect(hostByTestId(renderer, 'fix-list')).toHaveLength(0);
    expect(hostByTestId(renderer, 'stroke-result-surface')).toHaveLength(0);
    expect(copy.toLowerCase()).not.toContain('drill');
    expect(copy).not.toContain('Personalized training');
    expect(copy).not.toContain('Stroke map');
    expect(mockListCatalogDrills).not.toHaveBeenCalled();

    // The footer names the next page; there is no Back on the first page.
    expect(primaryLabel(renderer, 'result-guide-next')).toBe('See what to fix');
    expect(
      renderer.root.findAll(node => node.props.testID === 'result-guide-back'),
    ).toHaveLength(0);
  });

  it('Next walks SCORE → THE PROBLEM → DRILLS → NEXT; Back returns', async () => {
    const renderer = await renderScreen();

    // ── 2. THE PROBLEM: the replay IS the page — a clean stage frozen on
    //       the fault, the stop card under it naming the fault, then the
    //       timeline and transport; nothing scrolls, nothing overlaps ──
    await press(renderer, 'result-guide-next');
    expect(hostByTestId(renderer, 'result-guide-step-problem')).toHaveLength(1);
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(0);
    expect(stepLabel(renderer)).toBe('2 OF 4 · THE PROBLEM');
    let copy = allText(renderer);
    // The player is the same form-review replay, frozen on the fault's stop
    // (contact is stop 4 of 6 in this script) — the sidecar was verified.
    expect(mockLoadSequence).toHaveBeenCalledWith(sidecarRef);
    expect(hostByTestId(renderer, 'form-review-player')).toHaveLength(1);
    expect(hostByTestId(renderer, 'form-review-stage')).toHaveLength(1);
    expect(hostByTestId(renderer, 'form-review-stop-card')).toHaveLength(1);
    // The stop card is the page's thesis: the engine's priority checkpoint
    // leads this stop, so the verdict reads PRIORITY FIX; the measured
    // headline and the cue are the same strings the selectors produce.
    expect(copy).toContain('PRIORITY FIX · CONTACT');
    expect(copy).toContain('STOP 4 OF 6');
    expect(copy).toContain('Contact position scored 48 — contact came late');
    expect(copy).toContain(
      coachingCue('contact_position', 'late', 'forehand_drive'),
    );
    expect(copy).toContain('1.90s');
    // No second headline competes with the video: the old kicker / h1 / sub
    // block is gone from the replay page.
    expect(copy).not.toContain('THE PROBLEM · PRIORITY');
    expect(copy).not.toContain('Scored 48 — contact came late.');
    expect(copy).not.toContain('COACHING CUE');
    // Controls: play/pause, previous/next stop, speed, AUTO-pause.
    pressableByTestId(renderer, 'form-review-play');
    pressableByTestId(renderer, 'form-review-prev-stop');
    pressableByTestId(renderer, 'form-review-next-stop');
    pressableByTestId(renderer, 'form-review-speed');
    expect(
      pressableByTestId(renderer, 'form-review-autopause').props
        .accessibilityState,
    ).toMatchObject({ checked: true });
    expect(hostByTestId(renderer, 'form-review-timeline')).toHaveLength(1);
    // No scrolling: the page is a fixed flex column and the player fills it.
    expect(renderer.root.findAllByType(ScrollView)).toHaveLength(0);
    expect(hostByTestId(renderer, 'result-guide-page')).toHaveLength(1);
    expect(
      flatStyle(hostByTestId(renderer, 'form-review-player')[0]!),
    ).toMatchObject({ flex: 1 });
    expect(
      flatStyle(hostByTestId(renderer, 'form-review-stage')[0]!).height,
    ).toBeUndefined();
    // With the replay on the page there are NO fix cards — the headline
    // already names the priority fault and the cue appears at the stops.
    expect(hostByTestId(renderer, 'fix-list')).toHaveLength(0);
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          typeof node.props.testID === 'string' &&
          /^fix-item-[a-z_]+$/.test(node.props.testID),
      ),
    ).toHaveLength(0);
    expect(copy).not.toContain('Keep doing:');
    expect(copy).not.toContain('What to fix');
    expect(hostByTestId(renderer, 'recommended-drills')).toHaveLength(0);
    // No "Full screen" link: the inline replay already has the whole page.
    expect(hostByTestId(renderer, 'result-guide-open-review')).toHaveLength(0);
    expect(copy).not.toContain('Full screen');
    expect(primaryLabel(renderer, 'result-guide-next')).toBe(
      'Fix it with drills',
    );

    // ── Back returns to the score page ──
    await press(renderer, 'result-guide-back');
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(1);
    expect(hostByTestId(renderer, 'result-guide-step-problem')).toHaveLength(0);
    expect(stepLabel(renderer)).toBe('1 OF 4 · SCORE');

    // ── 3. DRILLS ──
    await press(renderer, 'result-guide-next');
    await press(renderer, 'result-guide-next');
    expect(hostByTestId(renderer, 'result-guide-step-drills')).toHaveLength(1);
    expect(stepLabel(renderer)).toBe('3 OF 4 · DRILLS');
    copy = allText(renderer);
    expect(copy).toContain('Drills to fix it');
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
    expect(mockListCatalogDrills).toHaveBeenCalledWith({ family: 'drive' });
    expect(hostByTestId(renderer, 'recommended-drills')).toHaveLength(1);
    expect(copy).toContain('Drive And Recover');
    expect(copy).toContain(DRILL_MATCH_NOTE);
    expect(
      hostByTestId(renderer, 'result-guide-open-review').length +
        hostByTestId(renderer, 'form-review-player').length,
    ).toBe(0);
    expect(primaryLabel(renderer, 'result-guide-next')).toBe('Continue');

    // ── 4. NEXT: ONE recap card — three tiles + two rows — and no link ──
    await press(renderer, 'result-guide-next');
    expect(hostByTestId(renderer, 'result-guide-step-next')).toHaveLength(1);
    expect(stepLabel(renderer)).toBe('4 OF 4 · NEXT');
    copy = allText(renderer);
    expect(copy).toContain('NEXT');
    expect(copy).toContain('Ready for another swing?');
    // The recap tiles count the record's own bands: 6 green checkpoints
    // held, 3 (one yellow, two red) are to fix — the inapplicable and the
    // unscored ones count for nothing.
    expect(hostByTestId(renderer, 'result-guide-summary')).toHaveLength(1);
    expect(copy).toContain('7.1 /10 SCORE');
    expect(copy).toContain('6 HELD');
    expect(copy).toContain('3 TO FIX');
    expect(
      hostByTestId(renderer, 'result-guide-tile-score')[0]!.props
        .accessibilityLabel,
    ).toBe('Score 7.1 out of 10');
    expect(
      hostByTestId(renderer, 'result-guide-tile-held')[0]!.props
        .accessibilityLabel,
    ).toBe('6 checkpoints held');
    expect(
      hostByTestId(renderer, 'result-guide-tile-to-fix')[0]!.props
        .accessibilityLabel,
    ).toBe('3 checkpoints to fix');
    // The rows: the priority fix and the strongest checkpoint, in the same
    // words the earlier pages used. Nothing else is said on this page.
    expect(copy).toContain('Priority fix Contact position — contact came late');
    expect(copy).toContain('Strongest Recovery · 92');
    expect(copy).not.toContain('Drills');
    // No full-breakdown link (product decision 2026-09-02) and NOTHING of the
    // breakdown inline — no disclosure, no evidence surface, no plan, no
    // measured rows.
    expect(copy).not.toContain('See full breakdown');
    expect(hostByTestId(renderer, 'result-guide-breakdown-link')).toHaveLength(
      0,
    );
    expect(hostByTestId(renderer, 'result-guide-full-breakdown')).toHaveLength(
      0,
    );
    expect(
      renderer.root.findAll(
        node => node.props.testID === 'result-guide-breakdown-toggle',
      ),
    ).toHaveLength(0);
    expect(hostByTestId(renderer, 'stroke-result-surface')).toHaveLength(0);
    expect(hostByTestId(renderer, 'training-plan-section')).toHaveLength(0);
    expect(hostByTestId(renderer, 'fix-list')).toHaveLength(0);
    expect(hostByTestId(renderer, 'measured-rows')).toHaveLength(0);
    expect(hostByTestId(renderer, 'form-review-card')).toHaveLength(0);
    expect(copy).not.toContain('observed');
    expect(copy).not.toContain('Stroke map');
    expect(copy).not.toContain('Personalized training');
    expect(copy).not.toContain('What to fix');
    // No scrolling here either: the page is a fixed column.
    expect(renderer.root.findAllByType(ScrollView)).toHaveLength(0);
    // The last page's primary is TRY AGAIN, with Back and Done beside it.
    expect(
      renderer.root.findAll(node => node.props.testID === 'result-guide-next'),
    ).toHaveLength(0);
    pressableByTestId(renderer, 'result-guide-try-again');
    pressableByTestId(renderer, 'result-guide-back');
    pressableByTestId(renderer, 'result-guide-done');
    expect(mockNavigation.navigate).not.toHaveBeenCalledWith(
      'ResultDetails',
      expect.anything(),
    );
  });

  it('a clean stroke with a replay says "Every checkpoint held" on the recap card', async () => {
    mockLoadEvidence.mockResolvedValue(
      scoredEvidence({
        analysis: {
          ...scoredAnalysis,
          checkpoints: [
            checkpoint('ready_position', 85, 'green', 'none'),
            checkpoint('contact_position', 91, 'green', 'none'),
          ],
          priorityFix: null,
        },
      }),
    );
    const renderer = await renderScreen();
    // SCORE → THE PROBLEM (replay only, no fault) → NEXT: no drills page.
    expect(stepLabel(renderer)).toBe('1 OF 3 · SCORE');
    await press(renderer, 'result-guide-next');
    expect(hostByTestId(renderer, 'result-guide-step-problem')).toHaveLength(1);
    let copy = allText(renderer);
    // With no fault there is no priority stop to open on: the replay opens
    // on its first stop, whose card carries a STRONG verdict — nothing is
    // invented for a clean stroke to say.
    expect(hostByTestId(renderer, 'form-review-player')).toHaveLength(1);
    expect(copy).toContain('STRONG · READY STANCE');
    expect(copy).toContain('Ready position scored 85 — held its target');
    expect(copy).not.toContain('PRIORITY FIX');
    expect(hostByTestId(renderer, 'fix-list')).toHaveLength(0);
    await press(renderer, 'result-guide-next');
    copy = allText(renderer);
    expect(copy).toContain('7.1 /10 SCORE');
    expect(copy).toContain('2 HELD');
    expect(copy).toContain('0 TO FIX');
    expect(copy).toContain('Priority fix Every checkpoint held');
    expect(copy).toContain('Strongest Contact position · 91');
  });

  it('Try it again re-arms the same-intent handoff and opens the guided camera; Done and Close pop to top', async () => {
    const renderer = await renderScreen();
    for (let i = 0; i < 3; i += 1) await press(renderer, 'result-guide-next');
    expect(peekTryAgainHandoff()).toBeNull();
    await press(renderer, 'result-guide-try-again');
    expect(peekTryAgainHandoff()).toEqual({
      source: 'camera',
      declaredStroke: 'forehand_drive',
      declaredCanonical: 'FOREHAND_DRIVE',
      auto: false,
      sessionId: 'set-1',
    });
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });

    await press(renderer, 'result-guide-done');
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);
    await press(renderer, 'result-guide-close');
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(2);
  });

  it('the replay page is the player alone: no headline, no full-screen link, nothing drawn over the stage', async () => {
    const renderer = await renderScreen();
    await press(renderer, 'result-guide-next');
    const [page] = hostByTestId(renderer, 'result-guide-step-problem');
    expect(page).toBeDefined();
    // The page's only child is the player (which fills it); the old kicker /
    // h1 / sub block and the "Full screen" link are gone.
    expect(page!.children).toHaveLength(1);
    expect(hostByTestId(renderer, 'form-review-player')).toHaveLength(1);
    expect(hostByTestId(renderer, 'result-guide-open-review')).toHaveLength(0);
    expect(mockNavigation.navigate).not.toHaveBeenCalledWith(
      'FormReview',
      expect.anything(),
    );
    // The stage holds ONLY the video, the overlay and the arrow label — the
    // stop card, timeline and transport are its SIBLINGS, never its children.
    const [stage] = hostByTestId(renderer, 'form-review-stage');
    const inside = (testID: string) =>
      stage!.findAll(
        node => typeof node.type === 'string' && node.props.testID === testID,
      );
    expect(inside('form-review-overlay')).toHaveLength(1);
    expect(inside('form-review-stop-card')).toHaveLength(0);
    expect(inside('form-review-timeline')).toHaveLength(0);
    expect(
      stage!.findAll(node => node.props.testID === 'form-review-play'),
    ).toHaveLength(0);
    expect(hostByTestId(renderer, 'form-review-stop-card')).toHaveLength(1);
    expect(hostByTestId(renderer, 'form-review-timeline')).toHaveLength(1);
  });

  it('the DRILLS page saves a drill to the library through the training store', async () => {
    const saveDrill = jest.fn(async () => {});
    const api: TrainingApi = {
      listSavedDrills: jest.fn(async () => []),
      getDrill: jest.fn(async () => {
        throw new Error('not needed');
      }),
      saveDrill,
      unsaveDrill: jest.fn(async () => {}),
      getCurrentPlan: jest.fn(async () => null),
      createPlan: jest.fn(async () => {
        throw new Error('not needed');
      }),
      completeDrill: jest.fn(async () => {
        throw new Error('not needed');
      }),
      reassessPlan: jest.fn(async () => {
        throw new Error('not needed');
      }),
    };
    configureTrainingStore(api);
    const renderer = await renderScreen();
    await press(renderer, 'result-guide-next');
    await press(renderer, 'result-guide-next');

    const toggle = pressableByTestId(
      renderer,
      'recommended-drill-drive-and-recover-save',
    );
    expect(toggle.props.accessibilityLabel).toBe(
      'Save Drive And Recover to your library',
    );
    expect(toggle.props.accessibilityState).toMatchObject({ selected: false });
    await press(renderer, 'recommended-drill-drive-and-recover-save');
    expect(saveDrill).toHaveBeenCalledWith('drive-and-recover');
    const saved = pressableByTestId(
      renderer,
      'recommended-drill-drive-and-recover-save',
    );
    expect(saved.props.accessibilityLabel).toBe(
      'Remove Drive And Recover from your library',
    );
    expect(saved.props.accessibilityState).toMatchObject({ selected: true });
    expect(allText(renderer)).toContain('SAVED');
    // Untouched drills keep their catalog state.
    expect(
      pressableByTestId(renderer, 'recommended-drill-shadow-swing-ladder-save')
        .props.accessibilityState,
    ).toMatchObject({ selected: false });
  });

  it('a failed save reports honestly without flipping the toggle', async () => {
    // No training API configured: the store refuses the mutation.
    const renderer = await renderScreen();
    await press(renderer, 'result-guide-next');
    await press(renderer, 'result-guide-next');
    await press(renderer, 'recommended-drill-drive-and-recover-save');
    expect(
      pressableByTestId(renderer, 'recommended-drill-drive-and-recover-save')
        .props.accessibilityState,
    ).toMatchObject({ selected: false });
    expect(hostByTestId(renderer, 'training-mutation-error')).toHaveLength(1);
    expect(allText(renderer)).toContain('Training not changed');
  });

  it('shows THIS SET on the score page only once two comparable attempts exist', async () => {
    mockListRealAnalysisFacts.mockResolvedValue([
      fact({ id: 'earlier', overallScore: 6.4 }),
      fact({
        id: 'analysis-1',
        capturedAt: '2026-09-01T10:00:00.000Z',
        overallScore: 7.1,
        checkpointScores: { contact_position: 48 },
      }),
    ]);
    const renderer = await renderScreen();
    expect(hostByTestId(renderer, 'result-guide-practice-set')).toHaveLength(1);
    const copy = allText(renderer);
    expect(copy).toContain('THIS SET');
    expect(copy).toContain('+0.7');
  });

  it('without replay evidence THE PROBLEM page shows the fix cards alone — no player, no full-screen link', async () => {
    mockLoadEvidence.mockResolvedValue(
      scoredEvidence({
        clip: null,
        review: { width: 1080, height: 1920, poseSequence: null },
      }),
    );
    const renderer = await renderScreen();
    await press(renderer, 'result-guide-next');
    expect(hostByTestId(renderer, 'result-guide-step-problem')).toHaveLength(1);
    expect(mockLoadSequence).not.toHaveBeenCalled();
    expect(hostByTestId(renderer, 'form-review-player')).toHaveLength(0);
    expect(hostByTestId(renderer, 'result-guide-open-review')).toHaveLength(0);
    expect(hostByTestId(renderer, 'fix-item-contact_position')).toHaveLength(1);
    const copy = allText(renderer);
    expect(copy).toContain('Contact position scored 48 — contact came late');
    expect(copy).not.toContain('No clip file or recorded pose');
  });

  it('a clean stroke with no replay skips THE PROBLEM and DRILLS pages', async () => {
    mockLoadEvidence.mockResolvedValue(
      scoredEvidence({
        analysis: {
          ...scoredAnalysis,
          checkpoints: [
            checkpoint('ready_position', 85, 'green', 'none'),
            checkpoint('contact_position', 91, 'green', 'none'),
          ],
          priorityFix: null,
        },
        clip: null,
        review: { width: 1080, height: 1920, poseSequence: null },
      }),
    );
    const renderer = await renderScreen();
    expect(stepLabel(renderer)).toBe('1 OF 2 · SCORE');
    expect(allText(renderer)).toContain(
      'Every measured checkpoint held its target — strongest was Contact position at 91.',
    );
    expect(primaryLabel(renderer, 'result-guide-next')).toBe('Continue');
    await press(renderer, 'result-guide-next');
    expect(hostByTestId(renderer, 'result-guide-step-next')).toHaveLength(1);
    expect(mockListCatalogDrills).not.toHaveBeenCalled();
  });
});

// ─── Abstained: ONE honest page ─────────────────────────────────────────────

describe('Result guide — abstained result', () => {
  it('collapses to a single page with the ledger and TRY AGAIN / Done — no score, no steps, no drills', async () => {
    mockRouteParams = { analysisId: 'analysis-2' };
    mockLoadEvidence.mockResolvedValue(abstainedEvidence());
    const renderer = await renderScreen();
    expect(hostByTestId(renderer, 'result-guide-step-abstained')).toHaveLength(
      1,
    );
    expect(hostByTestId(renderer, 'result-guide-progress')).toHaveLength(0);
    expect(hostByTestId(renderer, 'stroke-result-surface')).toHaveLength(1);
    expect(hostByTestId(renderer, 'abstention-ledger')).toHaveLength(1);
    const copy = allText(renderer);
    expect(copy).toContain('RESULT · NOT SCORED');
    expect(copy).toContain('Stroke not identified');
    expect(copy).toContain('WHAT HELD');
    expect(copy).toContain('WHAT WE COULDN’T ESTABLISH');
    expect(copy).toContain(
      'Enough analysis confidence to clear the scoring threshold.',
    );
    expect(copy).not.toContain('out of 10');
    expect(copy).not.toContain('TECHNIQUE SCORE');
    expect(copy.toLowerCase()).not.toContain('drill');
    expect(mockLoadSequence).not.toHaveBeenCalled();
    expect(mockListCatalogDrills).not.toHaveBeenCalled();

    expect(
      renderer.root.findAll(node => node.props.testID === 'result-guide-next'),
    ).toHaveLength(0);
    expect(
      renderer.root.findAll(node => node.props.testID === 'result-guide-back'),
    ).toHaveLength(0);
    // The ONE CTA pair: the guide's footer, not a second row in the surface.
    expect(
      renderer.root.findAll(
        node => node.props.testID === 'stroke-result-try-again',
      ),
    ).toHaveLength(0);
    await press(renderer, 'result-guide-try-again');
    expect(peekTryAgainHandoff()).toEqual({
      source: 'camera',
      declaredStroke: null,
      declaredCanonical: null,
      auto: true,
      sessionId: null,
    });
    await press(renderer, 'result-guide-done');
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);
  });

  it('a legacy row with a product analysis but no record still renders', async () => {
    mockLoadEvidence.mockResolvedValue(
      scoredEvidence({ record: null, clip: null, review: null }),
    );
    const renderer = await renderScreen();
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(1);
    expect(allText(renderer)).toContain('TECHNIQUE SCORE · FOREHAND DRIVE');
  });

  it('shows the missing state when neither analysis nor record exists', async () => {
    mockLoadEvidence.mockResolvedValue({
      analysis: null,
      record: null,
      clip: null,
      review: null,
      attempts: [],
    });
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain('Result missing');
  });
});
