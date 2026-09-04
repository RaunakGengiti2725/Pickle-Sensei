/**
 * STRUCTURAL AUDIT #1 (mobile-results-review) — async lifecycle probes.
 *
 * The architecture map lists "unmount / analysisId change during
 * loadStrokeResultEvidence or loadReviewPoseSequence" and "RecommendedDrills
 * stale-response discard on rapid attempt change" as untested. Each test
 * here races a SLOW first request against a FAST second one (or an unmount)
 * and asserts that only the live attempt's data ever reaches the screen.
 *
 *  1. useStrokeResultEvidence: evidence, sidecar and sync promises of a
 *     previous analysisId resolving AFTER the switch are discarded.
 *  2. useStrokeResultEvidence: a rejected evidence read for the OLD id after
 *     the switch does not overwrite the new id's evidence with the empty set.
 *  3. FormReviewScreen: the same race through the mounted screen.
 *  4. FormReviewScreen / hook: unmount mid-load → no state update, no
 *     React warning.
 *  5. RecommendedDrills: a stale catalog response (previous analysis id)
 *     resolving after the live one is dropped; a stale rejection is dropped.
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
import type { CatalogDrill } from '../../src/training/api';
import { useStrokeResultEvidence } from '../../src/screens/ResultScreen';
import { FormReviewScreen } from '../../src/screens/FormReviewScreen';
import { RecommendedDrills } from '../../src/review/RecommendedDrills';
import type {
  ReviewJoint,
  ReviewPoseFrame,
  ReviewPoseSequence,
} from '../../src/review/formReviewModel';

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

function analysisFixture(id: string, overrides: Partial<ShotAnalysis> = {}) {
  const analysis: ShotAnalysis = {
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
    ...overrides,
  };
  return analysis;
}

function recordFixture(id: string) {
  return {
    id,
    captureId: `capture-${id}`,
    strokeIntent: {
      declaredStroke: 'forehand_drive' as const,
      predictedStroke: null,
      resolutionBasis: 'declared' as const,
      resolvedProfileId: 'FOREHAND_DRIVE',
      resolvedProfileVersion: 'technique-profile-v1',
      disagreement: null,
    },
    result: null,
    uncertainty: {
      analysisConfidence: 0.84,
      presentation: 'normal' as const,
      limitingFactors: [],
    },
  };
}

function sidecarRef(id: string) {
  return {
    schemaVersion: 1 as const,
    format: 'pickle.pose-sequence.v1' as const,
    uri: `file:///captures/${id}.pose.json`,
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

/** A sequence whose frame count identifies its owner (tag frames). */
function sequenceFor(tagFrames: number): ReviewPoseSequence {
  const frames: ReviewPoseFrame[] = [];
  for (let i = 0; i < tagFrames; i += 1) {
    frames.push(
      frameAt(i * 40, {
        head: { x: 0.5, y: 0.18 },
        left_hip: { x: 0.46, y: 0.55 },
        right_hip: { x: 0.54, y: 0.55 },
      }),
    );
  }
  return { frames, video: { width: 1080, height: 1920, fps: 30 } };
}

function evidenceFor(id: string, overrides: Record<string, unknown> = {}) {
  return {
    analysis: analysisFixture(id),
    record: recordFixture(id),
    clip: {
      uri: `file:///captures/${id}.mov`,
      durationMs: 3400,
      posterUri: `file:///captures/${id}.poster.jpg`,
    },
    review: { width: 1080, height: 1920, poseSequence: sidecarRef(id) },
    attempts: [],
    ...overrides,
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

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const mounted: ReactTestRenderer[] = [];

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

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockRouteParams = { analysisId: 'analysis-1' };
  mockHasShotSyncReceipt.mockResolvedValue(false);
  mockGetShotOutboxStatus.mockResolvedValue({
    state: 'queued',
    attempts: 0,
    lastError: null,
  });
  mockListRealAnalysisFacts.mockResolvedValue([]);
  mockGetApiSession.mockReturnValue({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
  });
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  jest.useRealTimers();
});

// ─── 1–2. useStrokeResultEvidence ───────────────────────────────────────────

interface HookSnapshot {
  evidenceId: string | null | undefined;
  sequenceFrames: number | null | undefined;
  syncKind: string;
}

const hookSnapshots: HookSnapshot[] = [];

function HookProbe(props: { analysisId: string }) {
  const { evidence, sequence, syncEvidence } = useStrokeResultEvidence(
    props.analysisId,
  );
  hookSnapshots.push({
    evidenceId:
      evidence === undefined ? undefined : (evidence.analysis?.id ?? null),
    sequenceFrames:
      sequence === undefined ? undefined : (sequence?.frames.length ?? null),
    syncKind: syncEvidence.kind,
  });
  return null;
}

function latest(): HookSnapshot {
  const snapshot = hookSnapshots[hookSnapshots.length - 1];
  if (!snapshot) throw new Error('hook never rendered');
  return snapshot;
}

describe('useStrokeResultEvidence — analysisId switch mid-load', () => {
  beforeEach(() => {
    hookSnapshots.length = 0;
  });

  it('discards the previous id evidence/sidecar/sync results that land after the switch', async () => {
    const slowEvidence = deferred<unknown>();
    const fastEvidence = deferred<unknown>();
    mockLoadEvidence.mockImplementation((_db: unknown, id: string) =>
      id === 'analysis-1' ? slowEvidence.promise : fastEvidence.promise,
    );
    const slowSequence = deferred<unknown>();
    const fastSequence = deferred<unknown>();
    mockLoadSequence.mockImplementation((ref: { uri: string }) =>
      ref.uri.includes('analysis-1')
        ? slowSequence.promise
        : fastSequence.promise,
    );
    const slowReceipt = deferred<boolean>();
    mockHasShotSyncReceipt.mockImplementation((_db: unknown, id: string) =>
      id === 'analysis-1' ? slowReceipt.promise : Promise.resolve(false),
    );

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<HookProbe analysisId="analysis-1" />);
    });
    mounted.push(renderer);
    expect(latest()).toEqual({
      evidenceId: undefined,
      sequenceFrames: undefined,
      syncKind: 'checking',
    });

    // Switch before the first evidence read completes.
    await act(async () => {
      renderer.update(<HookProbe analysisId="analysis-2" />);
    });
    fastEvidence.resolve(evidenceFor('analysis-2'));
    await flush();
    expect(latest().evidenceId).toBe('analysis-2');
    fastSequence.resolve(sequenceFor(20));
    await flush();
    expect(latest().sequenceFrames).toBe(20);
    expect(latest().syncKind).toBe('pending');

    // The stale id's reads land now — nothing may change.
    slowEvidence.resolve(evidenceFor('analysis-1'));
    slowSequence.resolve(sequenceFor(99));
    slowReceipt.resolve(true);
    await flush();
    expect(latest()).toEqual({
      evidenceId: 'analysis-2',
      sequenceFrames: 20,
      syncKind: 'pending',
    });
    // The stale sidecar was never even requested for the new evidence.
    expect(mockLoadSequence).toHaveBeenCalledTimes(1);
    expect(mockLoadSequence).toHaveBeenCalledWith(sidecarRef('analysis-2'));
  });

  it('a stale REJECTED evidence read does not replace the live id with the empty evidence set', async () => {
    const slowEvidence = deferred<unknown>();
    mockLoadEvidence.mockImplementation((_db: unknown, id: string) =>
      id === 'analysis-1'
        ? slowEvidence.promise
        : Promise.resolve(evidenceFor('analysis-2')),
    );
    mockLoadSequence.mockResolvedValue(sequenceFor(20));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<HookProbe analysisId="analysis-1" />);
    });
    mounted.push(renderer);
    await act(async () => {
      renderer.update(<HookProbe analysisId="analysis-2" />);
    });
    await flush();
    expect(latest().evidenceId).toBe('analysis-2');

    slowEvidence.reject(new Error('db closed'));
    await flush();
    expect(latest().evidenceId).toBe('analysis-2');
  });

  it('a sidecar read that resolves after the sequence effect re-ran for the same evidence is discarded', async () => {
    // evidence for analysis-1 resolves; sidecar read is slow; then the
    // evidence object is replaced (same id, new read) before the sidecar
    // lands: the first sidecar promise must not win over the second.
    const firstSidecar = deferred<unknown>();
    const secondSidecar = deferred<unknown>();
    let sidecarCalls = 0;
    mockLoadSequence.mockImplementation(() =>
      sidecarCalls++ === 0 ? firstSidecar.promise : secondSidecar.promise,
    );
    const evidenceA = evidenceFor('analysis-1');
    mockLoadEvidence.mockResolvedValue(evidenceA);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<HookProbe analysisId="analysis-1" />);
    });
    mounted.push(renderer);
    await flush();
    expect(latest().evidenceId).toBe('analysis-1');
    expect(latest().sequenceFrames).toBeUndefined();

    // Re-key to a different id and back is how a host would re-read; here
    // simulate a re-read by switching ids away and back with fresh objects.
    mockLoadEvidence.mockResolvedValue(evidenceFor('analysis-2'));
    await act(async () => {
      renderer.update(<HookProbe analysisId="analysis-2" />);
    });
    await flush();
    expect(latest().evidenceId).toBe('analysis-2');
    secondSidecar.resolve(sequenceFor(7));
    await flush();
    expect(latest().sequenceFrames).toBe(7);

    firstSidecar.resolve(sequenceFor(99));
    await flush();
    expect(latest().sequenceFrames).toBe(7);
  });

  it('unmount mid-load: late evidence/sidecar/sync results cause no state update or React warning', async () => {
    const slowEvidence = deferred<unknown>();
    mockLoadEvidence.mockReturnValue(slowEvidence.promise);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<HookProbe analysisId="analysis-1" />);
      });
      const renders = hookSnapshots.length;
      await act(async () => {
        renderer.unmount();
      });
      slowEvidence.resolve(evidenceFor('analysis-1'));
      await flush();
      expect(hookSnapshots.length).toBe(renders);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

// ─── 3–4. FormReviewScreen ──────────────────────────────────────────────────

describe('FormReviewScreen — analysisId switch / unmount mid-load', () => {
  it('shows only the live id even when the previous id evidence + sidecar land later', async () => {
    const slowEvidence = deferred<unknown>();
    const slowSequence = deferred<unknown>();
    mockLoadEvidence.mockImplementation((_db: unknown, id: string) =>
      id === 'analysis-1'
        ? slowEvidence.promise
        : Promise.resolve(
            evidenceFor('analysis-2', {
              analysis: analysisFixture('analysis-2', {
                // Distinguishable copy: analysis-2 has NO faults at contact.
                checkpoints: [
                  checkpoint('ready_position', 85, 'green', 'none'),
                  checkpoint('athletic_base', 40, 'red', 'wide'),
                ],
                phases: [phase('ready', 0, 900)],
                priorityFix: null,
              }),
            }),
          ),
    );
    mockLoadSequence.mockImplementation((ref: { uri: string }) =>
      ref.uri.includes('analysis-1')
        ? slowSequence.promise
        : Promise.resolve(sequenceFor(20)),
    );

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<FormReviewScreen />);
    });
    mounted.push(renderer);
    mockRouteParams = { analysisId: 'analysis-2' };
    await act(async () => {
      renderer.update(<FormReviewScreen />);
    });
    await flush();
    let copy = allText(renderer);
    expect(copy).toContain('STOP 1 OF 1');
    expect(copy).toContain('Athletic base scored 40 — was wide');

    slowEvidence.resolve(evidenceFor('analysis-1'));
    slowSequence.resolve(sequenceFor(99));
    await flush();
    copy = allText(renderer);
    expect(copy).toContain('STOP 1 OF 1');
    expect(copy).not.toContain('STOP 1 OF 6');
    expect(copy).not.toContain('Contact position scored 48');
  });

  it('unmount while the sidecar is still loading: no late setState', async () => {
    const slowSequence = deferred<unknown>();
    mockLoadEvidence.mockResolvedValue(evidenceFor('analysis-1'));
    mockLoadSequence.mockReturnValue(slowSequence.promise);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<FormReviewScreen />);
      });
      await flush();
      expect(allText(renderer)).toContain('Preparing your form review');
      await act(async () => {
        renderer.unmount();
      });
      slowSequence.resolve(sequenceFor(20));
      await flush();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

// ─── 5. RecommendedDrills ───────────────────────────────────────────────────

function drill(id: string, title: string): CatalogDrill {
  return {
    id,
    slug: id,
    title,
    description: `${title} description`,
    coachName: 'Coach',
    equipment: [],
    difficultyMin: null,
    difficultyMax: null,
    families: ['drive'],
    validationState: 'validated',
    saved: false,
  };
}

const noop = () => {};

describe('RecommendedDrills — stale catalog responses on rapid attempt change', () => {
  it('drops a previous-attempt response that lands after the live one', async () => {
    const slow = deferred<CatalogDrill[]>();
    const fast = deferred<CatalogDrill[]>();
    let calls = 0;
    mockListCatalogDrills.mockImplementation(() =>
      calls++ === 0 ? slow.promise : fast.promise,
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <RecommendedDrills
          analysis={analysisFixture('analysis-1')}
          onOpenLibrary={noop}
        />,
      );
    });
    mounted.push(renderer);
    await act(async () => {
      renderer.update(
        <RecommendedDrills
          analysis={analysisFixture('analysis-2')}
          onOpenLibrary={noop}
        />,
      );
    });
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(2);

    fast.resolve([drill('d-live', 'Live attempt drill')]);
    await flush();
    expect(allText(renderer)).toContain('Live attempt drill');

    slow.resolve([drill('d-stale', 'Stale attempt drill')]);
    await flush();
    const copy = allText(renderer);
    expect(copy).toContain('Live attempt drill');
    expect(copy).not.toContain('Stale attempt drill');
  });

  it('drops a previous-attempt REJECTION that lands after the live response', async () => {
    const slow = deferred<CatalogDrill[]>();
    let calls = 0;
    mockListCatalogDrills.mockImplementation(() =>
      calls++ === 0
        ? slow.promise
        : Promise.resolve([drill('d-live', 'Live attempt drill')]),
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <RecommendedDrills
          analysis={analysisFixture('analysis-1')}
          onOpenLibrary={noop}
        />,
      );
    });
    mounted.push(renderer);
    await act(async () => {
      renderer.update(
        <RecommendedDrills
          analysis={analysisFixture('analysis-2')}
          onOpenLibrary={noop}
        />,
      );
    });
    await flush();
    expect(allText(renderer)).toContain('Live attempt drill');

    slow.reject(new Error('network down'));
    await flush();
    const copy = allText(renderer);
    expect(copy).toContain('Live attempt drill');
    expect(copy).not.toContain('Retry');
  });

  it('unmount mid-fetch: the late response causes no state update or warning', async () => {
    const slow = deferred<CatalogDrill[]>();
    mockListCatalogDrills.mockReturnValue(slow.promise);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <RecommendedDrills
            analysis={analysisFixture('analysis-1')}
            onOpenLibrary={noop}
          />,
        );
      });
      await act(async () => {
        renderer.unmount();
      });
      slow.resolve([drill('d-late', 'Late drill')]);
      await flush();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
