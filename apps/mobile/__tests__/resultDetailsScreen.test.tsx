/**
 * RESULT DETAILS — the "Full breakdown" route the Result guide's last page
 * links to. It must hold EXACTLY what the guide's collapsed disclosure used
 * to unfold inline: the canonical StrokeResult (header, replay, insight,
 * measured rows, provenance), the form-review entry card, WHAT TO FIX in
 * full with strengths, the stroke map, the scoring trace, the personalized
 * training section and — only once the shot is synced — the feedback prompt.
 * It loads its own evidence (separate route), keeps the guide's TRY AGAIN
 * loop semantics, and never renders a second CTA row.
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
import { Text } from 'react-native';
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
import { ResultDetailsScreen } from '../src/screens/ResultDetailsScreen';
import {
  clearTryAgainHandoff,
  peekTryAgainHandoff,
} from '../src/screens/tryAgainHandoff';
import type {
  ReviewJoint,
  ReviewPoseFrame,
  ReviewPoseSequence,
} from '../src/review/formReviewModel';
import type { StrokeResultEvidenceRecord } from '../src/components/strokeResultModel';
import { clearTrainingStoreConfiguration } from '../src/training/store';

// ─── Fixtures (same shapes as the result guide suite) ───────────────────────

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
        analysisId: 'analysis-0',
        capturedAtIso: '2026-09-01T09:55:00.000Z',
        sessionId: 'set-1',
      },
      {
        analysisId: 'analysis-1',
        capturedAtIso: '2026-09-01T10:00:00.000Z',
        sessionId: 'set-1',
      },
    ],
    ...overrides,
  };
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
    renderer = TestRenderer.create(<ResultDetailsScreen />);
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

function pressable(
  renderer: ReactTestRenderer,
  predicate: (props: Record<string, unknown>) => boolean,
) {
  const [node] = renderer.root.findAll(
    candidate =>
      typeof candidate.props.onPress === 'function' &&
      predicate(candidate.props),
  );
  if (!node) throw new Error('no matching pressable');
  return node;
}

async function press(
  renderer: ReactTestRenderer,
  predicate: (props: Record<string, unknown>) => boolean,
) {
  const node = pressable(renderer, predicate);
  await act(async () => {
    node.props.onPress();
  });
  await settle();
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
  mockGetApiSession.mockReturnValue(null);
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

describe('ResultDetailsScreen — the full breakdown on its own route', () => {
  it('loads its own evidence and renders EXACTLY the sheet the guide used to fold inline', async () => {
    const renderer = await renderScreen();
    expect(mockLoadEvidence).toHaveBeenCalledWith({}, 'analysis-1');
    expect(mockLoadSequence).toHaveBeenCalledWith(sidecarRef);
    expect(mockHasShotSyncReceipt).toHaveBeenCalledWith({}, 'analysis-1');

    expect(hostByTestId(renderer, 'result-details')).toHaveLength(1);
    expect(hostByTestId(renderer, 'result-details-breakdown')).toHaveLength(1);
    expect(hostByTestId(renderer, 'stroke-result-surface')).toHaveLength(1);
    const copy = allText(renderer);
    expect(copy).toContain('Full breakdown');
    // Everything that used to be on the single Result page is here.
    expect(copy).toContain('Stroke map');
    expect(copy).toContain('observed');
    expect(copy).toContain('Scored with sm-v1');
    expect(copy).toContain('You chose this technique.');
    expect(copy).toContain('Stroke window');
    expect(copy).toContain('What to fix');
    expect(copy).toContain('Keep doing:');
    expect(copy).toContain('Personalized training');
    expect(hostByTestId(renderer, 'training-plan-section')).toHaveLength(1);
    expect(hostByTestId(renderer, 'measured-rows')).toHaveLength(1);
    expect(hostByTestId(renderer, 'stroke-result-replay')).toHaveLength(1);
    expect(hostByTestId(renderer, 'form-review-card')).toHaveLength(1);
    expect(hostByTestId(renderer, 'fix-list')).toHaveLength(1);
    expect(hostByTestId(renderer, 'fix-item-contact_position')).toHaveLength(1);
    expect(hostByTestId(renderer, 'fix-item-paddle_path')).toHaveLength(1);
    expect(hostByTestId(renderer, 'fix-item-athletic_base')).toHaveLength(1);
    // Not synced yet: no feedback prompt is asked for an unaccepted shot.
    expect(hostByTestId(renderer, 'feedback-ask')).toHaveLength(0);
    // The sheet embeds the surface without a second CTA row — TRY AGAIN and
    // Done belong to the guide's footer.
    expect(
      renderer.root.findAll(
        node => node.props.testID === 'stroke-result-try-again',
      ),
    ).toHaveLength(0);
    // Nothing of the guide leaks onto the details route.
    expect(hostByTestId(renderer, 'result-guide')).toHaveLength(0);
    expect(hostByTestId(renderer, 'form-review-player')).toHaveLength(0);
    expect(hostByTestId(renderer, 'recommended-drills')).toHaveLength(0);
  });

  it('wires the same loops as the guide: form review, attempt chips, back', async () => {
    const renderer = await renderScreen();

    // The form-review card opens the full-screen replay for this attempt.
    await press(
      renderer,
      props =>
        typeof props.testID === 'string' &&
        props.testID.startsWith('form-review-card'),
    );
    expect(mockNavigation.navigate).toHaveBeenCalledWith('FormReview', {
      analysisId: 'analysis-1',
    });

    // "See it in your form review" on a fix names its phase.
    await press(
      renderer,
      props => props.testID === 'fix-item-paddle_path-review',
    );
    expect(mockNavigation.navigate).toHaveBeenCalledWith('FormReview', {
      analysisId: 'analysis-1',
      phase: 'accelerate',
    });

    // Another attempt's chip repoints the GUIDE underneath and pops back to
    // it — the details route never stacks a second Result.
    await press(renderer, props => props.accessibilityLabel === 'Attempt 1');
    expect(mockNavigation.popTo).toHaveBeenCalledWith('Result', {
      analysisId: 'analysis-0',
    });
    expect(mockNavigation.replace).not.toHaveBeenCalled();

    // Header back returns to the guide.
    await press(renderer, props => props.accessibilityLabel === 'Back');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    expect(peekTryAgainHandoff()).toBeNull();
  });

  it('shows the missing state when the analysis is gone from this device', async () => {
    mockLoadEvidence.mockResolvedValue({
      analysis: null,
      record: null,
      clip: null,
      review: null,
      attempts: [],
    });
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain('Result missing');
    expect(hostByTestId(renderer, 'result-details-breakdown')).toHaveLength(0);
    expect(mockLoadSequence).not.toHaveBeenCalled();
  });
});
