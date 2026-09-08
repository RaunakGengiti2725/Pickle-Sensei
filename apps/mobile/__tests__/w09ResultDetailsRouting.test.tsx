/**
 * W09-02 — RESULT DETAILS ROUTING: the `ResultDetails { analysisId }` route
 * (the full breakdown, `ResultBreakdownSheet`) is a deliberate secondary
 * entry, reachable from the shipping surfaces instead of registered-but-
 * unreachable:
 *
 *   Result  → details: the guide's SCORE page — the page every entry lands
 *                      on — carries ONE "Full breakdown" link in its footer
 *                      link row and navigates with the guide's own typed
 *                      params (`RootStackParams['ResultDetails']`, the same
 *                      shape `Result` takes, so a history row's id is passed
 *                      through unchanged).
 *   Library → details: Library history rows and the current-plan card open
 *                      `Result { analysisId }` (pinned by the Library suites);
 *                      that guide's SCORE page is the details entry for THAT
 *                      analysis.
 *
 * The recap page stays a quick recap with no breakdown link (the guide
 * suite pins that), and the abstained one-page result hosts the sheet inline
 * so it offers no second entry. The details route itself keeps loading its
 * own evidence for the routed id and its Back returns to the guide.
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
const mockRetryShotSync = jest.fn();
const mockListRealAnalysisFacts = jest.fn();
jest.mock('../src/data/syncRuntime', () => ({
  triggerOutboxSync: jest.fn(async () => {}),
}));
jest.mock('../src/data/repository', () => ({
  hasShotSyncReceipt: (...args: unknown[]) => mockHasShotSyncReceipt(...args),
  getShotOutboxStatus: (...args: unknown[]) => mockGetShotOutboxStatus(...args),
  retryShotSync: (...args: unknown[]) => mockRetryShotSync(...args),
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
import type { RootStackParams } from '../src/navigation/params';
import { ResultScreen } from '../src/screens/ResultScreen';
import { ResultDetailsScreen } from '../src/screens/ResultDetailsScreen';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import { clearTryAgainHandoff } from '../src/screens/tryAgainHandoff';
import type { StrokeResultEvidenceRecord } from '../src/components/strokeResultModel';
import { clearTrainingStoreConfiguration } from '../src/training/store';

// ─── Typed params: the details route takes EXACTLY what Result takes ────────

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const detailsTakesResultParams: Same<
  RootStackParams['ResultDetails'],
  RootStackParams['Result']
> = true;

// ─── Fixtures (same shapes as the result guide + details suites) ────────────

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

function scoredAnalysis(id: string): ShotAnalysis {
  return {
    id,
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
      checkpoint('paddle_path', 61, 'red', 'low'),
      checkpoint('contact_position', 48, 'red', 'late'),
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
      limitingFactors: ['paddle_track_unavailable'],
    },
  };
}

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

/** A scored read with a clip but no verified pose sidecar (video-only replay). */
function scoredEvidence(id: string) {
  return {
    analysis: scoredAnalysis(id),
    record: declaredRecord(id),
    clip: {
      uri: `file:///captures/${id}.mov`,
      durationMs: 3400,
      posterUri: `file:///captures/${id}.poster.jpg`,
    },
    review: { width: 1080, height: 1920, poseSequence: null },
    attempts: [
      {
        analysisId: id,
        capturedAtIso: '2026-09-01T10:00:00.000Z',
        sessionId: 'set-1',
      },
    ],
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

// ─── Harness ────────────────────────────────────────────────────────────────

const mounted: ReactTestRenderer[] = [];

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(element: React.ReactElement) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
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

function pressablesByTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    candidate =>
      candidate.props.testID === testID &&
      typeof candidate.props.onPress === 'function',
  );
}

function pressableByTestId(renderer: ReactTestRenderer, testID: string) {
  const [node] = pressablesByTestId(renderer, testID);
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

async function pressByLabel(renderer: ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.accessibilityLabel === label &&
      typeof candidate.props.onPress === 'function',
  );
  if (!node) throw new Error(`no pressable labelled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
  await settle();
}

const BREAKDOWN_LINK = 'result-guide-breakdown-link';

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  clearTryAgainHandoff();
  clearTrainingStoreConfiguration();
  mockRouteParams = { analysisId: 'analysis-1' };
  mockLoadEvidence.mockImplementation(async (_db: unknown, id: unknown) =>
    scoredEvidence(String(id)),
  );
  mockLoadSequence.mockResolvedValue(null);
  mockHasShotSyncReceipt.mockResolvedValue(false);
  mockGetShotOutboxStatus.mockResolvedValue({
    state: 'queued',
    attempts: 0,
    lastError: null,
  });
  mockRetryShotSync.mockResolvedValue(true);
  mockListRealAnalysisFacts.mockResolvedValue([]);
  mockGetApiSession.mockReturnValue(null);
  mockListCatalogDrills.mockResolvedValue([]);
  setActiveDataOwner('00000000-0000-4000-8000-000000000001');
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  jest.useRealTimers();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('W09-02 — Result → details', () => {
  it('the SCORE page offers ONE "Full breakdown" entry that opens ResultDetails for this analysis', async () => {
    const renderer = await render(<ResultScreen />);
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(1);

    const links = pressablesByTestId(renderer, BREAKDOWN_LINK);
    expect(links).toHaveLength(1);
    const [link] = links;
    expect(link!.props.accessibilityLabel).toBe('Full breakdown');
    expect(link!.props.accessibilityRole).toBe('button');
    expect(allText(renderer)).toContain('Full breakdown');
    // The entry is a footer link beside the pinned primary — the primary
    // itself still names the next page.
    expect(pressableByTestId(renderer, 'result-guide-next').props.label).toBe(
      'See what to fix',
    );

    await press(renderer, BREAKDOWN_LINK);
    const params: RootStackParams['ResultDetails'] = {
      analysisId: 'analysis-1',
    };
    expect(mockNavigation.navigate).toHaveBeenCalledTimes(1);
    expect(mockNavigation.navigate).toHaveBeenCalledWith(
      'ResultDetails',
      params,
    );
    // A push, never a swap: Back on the details route returns to this guide.
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(mockNavigation.popToTop).not.toHaveBeenCalled();
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
    expect(detailsTakesResultParams).toBe(true);
  });

  it('a history row opened from Library (Result { analysisId }) reaches the details of THAT analysis', async () => {
    // LibraryScreen navigates `Result { analysisId: item.id }` for a history
    // row (pinned by the Library suites); the guide it opens is the entry.
    const fromLibrary: RootStackParams['Result'] = { analysisId: 'shot-0002' };
    mockRouteParams = fromLibrary;
    const renderer = await render(<ResultScreen />);
    expect(mockLoadEvidence).toHaveBeenCalledWith({}, 'shot-0002');
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(1);

    await press(renderer, BREAKDOWN_LINK);
    expect(mockNavigation.navigate).toHaveBeenCalledTimes(1);
    expect(mockNavigation.navigate).toHaveBeenCalledWith('ResultDetails', {
      analysisId: 'shot-0002',
    });
    const [, passed] = mockNavigation.navigate.mock.calls[0] as [
      string,
      RootStackParams['ResultDetails'],
    ];
    // Exactly the typed params — nothing else rides along.
    expect(Object.keys(passed)).toEqual(['analysisId']);
  });

  it('the entry lives on the SCORE page only; the later pages and the recap stay as decided', async () => {
    const renderer = await render(<ResultScreen />);
    expect(pressablesByTestId(renderer, BREAKDOWN_LINK)).toHaveLength(1);

    // Walk every later page: no second entry anywhere, and the recap card
    // keeps its no-link decision.
    let guard = 0;
    while (pressablesByTestId(renderer, 'result-guide-next').length > 0) {
      await press(renderer, 'result-guide-next');
      expect(pressablesByTestId(renderer, BREAKDOWN_LINK)).toHaveLength(0);
      expect(allText(renderer)).not.toContain('Full breakdown');
      guard += 1;
      expect(guard).toBeLessThan(5);
    }
    expect(hostByTestId(renderer, 'result-guide-step-next')).toHaveLength(1);
    expect(mockNavigation.navigate).not.toHaveBeenCalledWith(
      'ResultDetails',
      expect.anything(),
    );

    // Back to the first page brings the entry back.
    while (pressablesByTestId(renderer, 'result-guide-back').length > 0) {
      await press(renderer, 'result-guide-back');
    }
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(1);
    expect(pressablesByTestId(renderer, BREAKDOWN_LINK)).toHaveLength(1);
  });

  it('an abstained result hosts the breakdown inline and offers no separate entry', async () => {
    mockRouteParams = { analysisId: 'analysis-2' };
    mockLoadEvidence.mockResolvedValue(abstainedEvidence());
    const renderer = await render(<ResultScreen />);
    expect(hostByTestId(renderer, 'result-guide-step-abstained')).toHaveLength(
      1,
    );
    expect(hostByTestId(renderer, 'result-guide-full-breakdown')).toHaveLength(
      1,
    );
    expect(pressablesByTestId(renderer, BREAKDOWN_LINK)).toHaveLength(0);
    expect(allText(renderer)).not.toContain('Full breakdown');
  });

  it('the details route loads the routed analysis and its Back returns to the guide', async () => {
    mockRouteParams = { analysisId: 'shot-0002' };
    const renderer = await render(<ResultDetailsScreen />);
    expect(mockLoadEvidence).toHaveBeenCalledWith({}, 'shot-0002');
    expect(hostByTestId(renderer, 'result-details-breakdown')).toHaveLength(1);
    expect(allText(renderer)).toContain('Full breakdown');
    // The details route never offers the guide's entry back into itself.
    expect(pressablesByTestId(renderer, BREAKDOWN_LINK)).toHaveLength(0);
    expect(hostByTestId(renderer, 'result-guide')).toHaveLength(0);

    await pressByLabel(renderer, 'Back');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    expect(mockNavigation.popToTop).not.toHaveBeenCalled();
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
  });
});
