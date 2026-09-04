/**
 * Structural audit #2 (mobile-results-review) — async lifecycle probes.
 *
 * REVIEW.md requires every async load to be guarded on unmount / analysisId
 * change. The architecture map flags "mid-load unmount" for
 * `FormReviewScreen` and `useStrokeResultEvidence` as untested. These probes
 * hold the evidence / sidecar promises open, unmount or swap the analysis id
 * while they are pending, then resolve them and assert nothing stale lands.
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

const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  navigate: jest.fn(),
  canGoBack: jest.fn(() => true),
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
jest.mock('../../src/data/repository', () => ({
  getShotOutboxStatus: jest.fn(async () => null),
  hasShotSyncReceipt: jest.fn(async () => false),
  listRealAnalysisFacts: jest.fn(async () => []),
}));

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
import { FormReviewScreen } from '../../src/screens/FormReviewScreen';
import { useStrokeResultEvidence } from '../../src/screens/ResultScreen';

function phase(key: PhaseKey, startMs: number, endMs: number): PhaseSpan {
  return {
    key,
    startMs,
    representativeMs: startMs + (endMs - startMs) / 2,
    endMs,
    confidence: 0.8,
  };
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
function analysisFor(id: string): ShotAnalysis {
  return {
    id,
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases: [phase('ready', 0, 900), phase('contact', 1880, 1920)],
    measurements: [],
    checkpoints: [
      checkpoint('athletic_base', 72, 'yellow', 'narrow'),
      checkpoint('contact_position', 48, 'red', 'late'),
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
    analysis: analysisFor(id),
    record: null,
    clip: { uri: `file:///captures/${id}.mov`, durationMs: 3400 },
    review: { width: 1080, height: 1920, poseSequence: sidecarRef },
    attempts: [],
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node =>
      React.Children.toArray(node.props.children)
        .filter(child => typeof child === 'string' || typeof child === 'number')
        .join(''),
    )
    .join(' ');
}

let consoleError: jest.SpyInstance;
beforeEach(() => {
  mockLoadEvidence.mockReset();
  mockLoadSequence.mockReset();
  mockRouteParams = { analysisId: 'analysis-1' };
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
});

describe('FormReviewScreen — mid-load lifecycle', () => {
  it('unmount while the evidence read is pending: the late resolution updates nothing (no act/unmounted warnings)', async () => {
    const pending = deferred<unknown>();
    mockLoadEvidence.mockReturnValue(pending.promise);
    mockLoadSequence.mockResolvedValue(null);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<FormReviewScreen />);
    });
    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      pending.resolve(evidenceFor('analysis-1'));
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('PROBE: after unmount, the evidence resolving late must NOT start the sidecar read + hash (cancelled work stays cancelled)', async () => {
    const pending = deferred<unknown>();
    mockLoadEvidence.mockReturnValue(pending.promise);
    mockLoadSequence.mockResolvedValue(null);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<FormReviewScreen />);
    });
    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      pending.resolve(evidenceFor('analysis-1'));
    });
    expect(mockLoadSequence).not.toHaveBeenCalled();
  });

  it('unmount while the SIDECAR read is pending: the late sequence updates nothing', async () => {
    mockLoadEvidence.mockResolvedValue(evidenceFor('analysis-1'));
    const pendingSidecar = deferred<unknown>();
    mockLoadSequence.mockReturnValue(pendingSidecar.promise);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<FormReviewScreen />);
    });
    expect(mockLoadSequence).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      pendingSidecar.resolve(null);
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('analysisId changes while attempt 1 is loading: attempt 1 resolving LATE never overwrites attempt 2', async () => {
    const first = deferred<unknown>();
    mockLoadEvidence
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(evidenceFor('analysis-2'));
    mockLoadSequence.mockResolvedValue(null);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<FormReviewScreen />);
    });
    mockRouteParams = { analysisId: 'analysis-2' };
    await act(async () => {
      renderer.update(<FormReviewScreen />);
    });
    expect(mockLoadEvidence).toHaveBeenLastCalledWith({}, 'analysis-2');
    await act(async () => {
      first.resolve({
        ...evidenceFor('analysis-1'),
        clip: { uri: 'file:///captures/STALE.mov', durationMs: 999 },
      });
    });
    const clipNodes = renderer.root.findAll(
      node =>
        typeof node.props.source === 'object' &&
        node.props.source !== null &&
        typeof node.props.source.uri === 'string' &&
        node.props.source.uri.includes('STALE'),
    );
    expect(clipNodes).toHaveLength(0);
    expect(allText(renderer)).not.toContain('Analyzing');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('a sidecar read that REJECTS after the analysis changed neither shows an error nor touches the new attempt', async () => {
    const firstSidecar = deferred<unknown>();
    mockLoadEvidence
      .mockResolvedValueOnce(evidenceFor('analysis-1'))
      .mockResolvedValueOnce(evidenceFor('analysis-2'));
    mockLoadSequence
      .mockReturnValueOnce(firstSidecar.promise)
      .mockResolvedValueOnce(null);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<FormReviewScreen />);
    });
    mockRouteParams = { analysisId: 'analysis-2' };
    await act(async () => {
      renderer.update(<FormReviewScreen />);
    });
    await act(async () => {
      firstSidecar.reject(new Error('hash mismatch'));
    });
    expect(allText(renderer)).not.toContain('hash mismatch');
    expect(consoleError).not.toHaveBeenCalled();
    await act(async () => {
      renderer.unmount();
    });
  });
});

function Host(props: { analysisId: string }) {
  const { evidence, sequence } = useStrokeResultEvidence(props.analysisId);
  return (
    <Text testID="host">
      {evidence === undefined
        ? 'loading'
        : `clip:${evidence.clip?.uri ?? 'none'} seq:${
            sequence === undefined
              ? 'pending'
              : sequence === null
                ? 'null'
                : 'ready'
          }`}
    </Text>
  );
}

describe('useStrokeResultEvidence — mid-load lifecycle', () => {
  it('a late evidence resolution for a PREVIOUS analysisId never lands', async () => {
    const first = deferred<unknown>();
    mockLoadEvidence
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(evidenceFor('analysis-2'));
    mockLoadSequence.mockResolvedValue(null);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Host analysisId="analysis-1" />);
    });
    expect(allText(renderer)).toBe('loading');
    await act(async () => {
      renderer.update(<Host analysisId="analysis-2" />);
    });
    expect(allText(renderer)).toContain('clip:file:///captures/analysis-2.mov');
    await act(async () => {
      first.resolve(evidenceFor('analysis-1'));
    });
    expect(allText(renderer)).toContain('clip:file:///captures/analysis-2.mov');
    expect(allText(renderer)).not.toContain('analysis-1.mov');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('a late SIDECAR resolution for a previous evidence never lands on the next one', async () => {
    const firstSidecar = deferred<unknown>();
    mockLoadEvidence
      .mockResolvedValueOnce(evidenceFor('analysis-1'))
      .mockResolvedValueOnce(evidenceFor('analysis-2'));
    mockLoadSequence
      .mockReturnValueOnce(firstSidecar.promise)
      .mockResolvedValueOnce(null);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Host analysisId="analysis-1" />);
    });
    expect(allText(renderer)).toContain('seq:pending');
    await act(async () => {
      renderer.update(<Host analysisId="analysis-2" />);
    });
    expect(allText(renderer)).toContain('seq:null');
    await act(async () => {
      firstSidecar.resolve({ frames: [], video: null });
    });
    expect(allText(renderer)).toContain('seq:null');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('unmount while both reads are pending leaves no warnings behind', async () => {
    const first = deferred<unknown>();
    mockLoadEvidence.mockReturnValue(first.promise);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Host analysisId="analysis-1" />);
    });
    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      first.reject(new Error('db closed'));
    });
    expect(consoleError).not.toHaveBeenCalled();
  });
});
