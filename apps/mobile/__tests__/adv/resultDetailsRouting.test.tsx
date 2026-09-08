/**
 * INT-ui-flows-a11y adversary — ResultDetails routing under slow, failed,
 * corrupt and malformed inputs.
 *
 *  1. Slow read + route repoint: attempt A's evidence resolves AFTER the
 *     route was repointed to attempt B — the sheet must show B, never A.
 *  2. Corrupt persisted row (the evidence read rejects): honest "Result
 *     missing" with a working Go back, and a double tap on Go back must pop
 *     exactly once.
 *  3. Route opened without params (malformed link / stale state): the
 *     screen must render the missing state, not throw during render.
 *  4. Corrupt pose sidecar (hash mismatch → read rejects): the breakdown
 *     still renders, replay evidence degrades to null instead of crashing.
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
const mockListRealAnalysisFacts = jest.fn();
jest.mock('../../src/data/repository', () => ({
  hasShotSyncReceipt: (...args: unknown[]) => mockHasShotSyncReceipt(...args),
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
}));

const mockGetApiSession = jest.fn();
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

const mockListCatalogDrills = jest.fn();
jest.mock('../../src/training/api', () => ({
  createTrainingApi: () => ({ listCatalogDrills: mockListCatalogDrills }),
}));

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

const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  popTo: jest.fn(),
  popToTop: jest.fn(),
  navigate: jest.fn(),
};
let mockRouteParams: Record<string, unknown> | undefined = {
  analysisId: 'analysis-1',
};
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
import { ResultDetailsScreen } from '../../src/screens/ResultDetailsScreen';
import { ResultBreakdownSheet } from '../../src/screens/ResultScreen';
import { clearTryAgainHandoff } from '../../src/screens/tryAgainHandoff';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';
import { clearTrainingStoreConfiguration } from '../../src/training/store';

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
      checkpoint('preparation', 88, 'green', 'none'),
      checkpoint('paddle_set', 90, 'green', 'none'),
      checkpoint('swing_length', null, 'unscored', 'none'),
      checkpoint('sequencing', 82, 'green', 'none'),
      checkpoint('paddle_path', 61, 'red', 'low'),
      checkpoint('contact_position', 48, 'red', 'late'),
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

function record(id: string): StrokeResultEvidenceRecord {
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

function evidenceFor(id: string) {
  return {
    analysis: scoredAnalysis(id),
    record: record(id),
    clip: {
      uri: `file:///captures/${id}.mov`,
      durationMs: 3400,
      posterUri: `file:///captures/${id}.poster.jpg`,
    },
    review: { width: 1080, height: 1920, poseSequence: sidecarRef },
    attempts: [],
  };
}

const MISSING = {
  analysis: null,
  record: null,
  clip: null,
  review: null,
  attempts: [],
};

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

async function repoint(renderer: ReactTestRenderer, analysisId: string) {
  mockRouteParams = { analysisId };
  await act(async () => {
    renderer.update(<ResultDetailsScreen />);
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

function hostByTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function pressable(renderer: ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      typeof candidate.props.onPress === 'function' &&
      candidate.props.accessibilityLabel === label,
  );
  if (!node) throw new Error(`no pressable labelled ${label}`);
  return node;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  clearTryAgainHandoff();
  clearTrainingStoreConfiguration();
  mockRouteParams = { analysisId: 'analysis-1' };
  mockLoadEvidence.mockImplementation(async (_db: unknown, id: string) =>
    evidenceFor(id),
  );
  mockLoadSequence.mockResolvedValue(null);
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

describe('adv: ResultDetails routing', () => {
  it('a slow read for attempt A that lands after the route repointed to B never paints A', async () => {
    let resolveA!: (value: unknown) => void;
    mockLoadEvidence.mockImplementation((_db: unknown, id: string) =>
      id === 'analysis-A'
        ? new Promise(resolve => {
            resolveA = resolve;
          })
        : Promise.resolve(evidenceFor(id)),
    );
    mockRouteParams = { analysisId: 'analysis-A' };
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain('Opening your result…');

    await repoint(renderer, 'analysis-B');
    const sheetB = renderer.root.findByType(ResultBreakdownSheet);
    expect(sheetB.props.analysisId).toBe('analysis-B');
    expect(sheetB.props.analysis?.id).toBe('analysis-B');

    await act(async () => {
      resolveA(evidenceFor('analysis-A'));
    });
    await settle();
    const sheet = renderer.root.findByType(ResultBreakdownSheet);
    expect(sheet.props.analysisId).toBe('analysis-B');
    expect(sheet.props.analysis?.id).toBe('analysis-B');
    expect(sheet.props.record?.id).toBe('analysis-B');
    expect(sheet.props.clip?.uri).toBe('file:///captures/analysis-B.mov');
  });

  it('a corrupt persisted row (read rejects) shows Result missing; a double tap on Go back pops once', async () => {
    mockLoadEvidence.mockRejectedValue(new Error('SQLITE_CORRUPT'));
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain('Result missing');
    expect(hostByTestId(renderer, 'result-details-breakdown')).toHaveLength(0);
    expect(mockLoadSequence).not.toHaveBeenCalled();

    const goBack = pressable(renderer, 'Go back');
    await act(async () => {
      goBack.props.onPress();
      goBack.props.onPress();
    });
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('opened without params renders the missing state instead of throwing', async () => {
    mockRouteParams = undefined;
    let renderError: unknown = null;
    let renderer: ReactTestRenderer | null = null;
    try {
      await act(async () => {
        renderer = TestRenderer.create(<ResultDetailsScreen />);
      });
      await settle();
    } catch (error) {
      renderError = error;
    }
    if (renderer) mounted.push(renderer);
    expect(renderError).toBeNull();
    expect(renderer).not.toBeNull();
    expect(allText(renderer!)).toContain('Result missing');
  });

  it('a corrupt pose sidecar degrades the replay evidence to null without losing the breakdown', async () => {
    mockLoadSequence.mockRejectedValue(new Error('pose sidecar hash mismatch'));
    const renderer = await renderScreen();
    expect(mockLoadSequence).toHaveBeenCalledWith(sidecarRef);
    expect(hostByTestId(renderer, 'result-details-breakdown')).toHaveLength(1);
    const sheet = renderer.root.findByType(ResultBreakdownSheet);
    expect(sheet.props.sequence).toBeNull();
    expect(allText(renderer)).toContain('Full breakdown');
  });

  it('an evidence set with no analysis and no record (deleted attempt) is the missing state, never an empty sheet', async () => {
    mockLoadEvidence.mockResolvedValue(MISSING);
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain('Result missing');
    expect(hostByTestId(renderer, 'result-details-breakdown')).toHaveLength(0);
  });
});
