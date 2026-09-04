/**
 * ADVERSARIAL PASS 3 — FormReviewScreen loader + FormReviewPlayer transport.
 *
 * S5: analysisId changes while the FIRST sidecar read is still pending, then
 *     the first sidecar resolves → the stale sequence must never reach
 *     state.ready (the screen stays loading until the new route's own
 *     evidence + sidecar settle; the player receives only the new sequence).
 * S6: at the LAST stop, "next" is pressed 20× as fast as React allows →
 *     activeStopId stays on the last stop, no seek request is issued, and
 *     the +0.01 "nudge" never accumulates beyond one step from a stop's ms.
 * Extras: A→B→A route flip with distinguishable sequences, sidecar rejecting
 *     mid-flight, evidence rejecting after a route change, 20× prev/next
 *     ping-pong drift bound, 20× same-x scrubs drift bound, deep-linked phase
 *     that does not exist, unmount while both loads are pending.
 */
jest.mock('../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));

const mockLoadEvidence = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../src/components/strokeResultData', () => ({
  loadStrokeResultEvidence: (...args: unknown[]) => mockLoadEvidence(...args),
}));

const mockLoadSequence = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../src/review/poseSidecar', () => ({
  loadReviewPoseSequence: (...args: unknown[]) => mockLoadSequence(...args),
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
import { FormReviewScreen } from '../src/screens/FormReviewScreen';
import { FormReviewPlayer } from '../src/review/FormReviewPlayer';
import { ClipPlayer } from '../src/components/ClipPlayer';
import {
  buildFormReviewScript,
  type ReviewJoint,
  type ReviewPoseFrame,
  type ReviewPoseSequence,
} from '../src/review/formReviewModel';

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

function analysisFixture(id: string): ShotAnalysis {
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

function sidecarFor(id: string) {
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

function evidenceFor(id: string) {
  return {
    analysis: analysisFixture(id),
    record: null,
    clip: {
      uri: `file:///captures/${id}.mov`,
      durationMs: 3400,
      posterUri: `file:///captures/${id}.poster.jpg`,
    },
    review: { width: 1080, height: 1920, poseSequence: sidecarFor(id) },
    attempts: [],
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

/** Distinguishable sequences: the tag rides on `video.fps`. */
function sequenceTagged(fps: number): ReviewPoseSequence {
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
  return { frames, video: { width: 1080, height: 1920, fps } };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
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

async function settle(turns = 6) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderScreen() {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<FormReviewScreen />);
  });
  mounted.push(renderer);
  return renderer;
}

async function rerouteTo(renderer: ReactTestRenderer, analysisId: string) {
  mockRouteParams = { analysisId };
  await act(async () => {
    renderer.update(<FormReviewScreen />);
  });
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

function players(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType(FormReviewPlayer);
}

function seekMsOf(renderer: ReactTestRenderer): number {
  const [clip] = renderer.root.findAllByType(ClipPlayer);
  if (!clip) throw new Error('no ClipPlayer mounted');
  return clip.props.seekMs as number;
}

function byTestId(renderer: ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.testID === testID &&
      typeof candidate.props.onPress === 'function',
  );
  if (!node) throw new Error(`no pressable with testID ${testID}`);
  return node;
}

async function press(renderer: ReactTestRenderer, testID: string) {
  const node = byTestId(renderer, testID);
  await act(async () => {
    node.props.onPress();
  });
}

const STOPS = buildFormReviewScript(
  analysisFixture('analysis-1'),
  sequenceTagged(30),
).stops;
const LAST_STOP = STOPS[STOPS.length - 1]!;

let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockRouteParams = { analysisId: 'analysis-1' };
  mockLoadEvidence.mockImplementation((_db, id) =>
    Promise.resolve(evidenceFor(String(id))),
  );
  mockLoadSequence.mockResolvedValue(sequenceTagged(30));
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  consoleErrorSpy.mockRestore();
  jest.useRealTimers();
});

// ─── S5 — stale sidecar after a route change ────────────────────────────────

describe('S5 — analysisId changes while loadReviewPoseSequence is pending', () => {
  it('the stale sequence never reaches state.ready; only the new route paints', async () => {
    const staleSidecar = deferred<ReviewPoseSequence>();
    const freshSidecar = deferred<ReviewPoseSequence>();
    mockLoadSequence.mockImplementation(ref =>
      (ref as { uri: string }).uri.includes('analysis-1')
        ? staleSidecar.promise
        : freshSidecar.promise,
    );
    const renderer = await renderScreen();
    await settle();
    expect(mockLoadEvidence).toHaveBeenCalledTimes(1);
    expect(mockLoadSequence).toHaveBeenCalledTimes(1);
    expect(players(renderer)).toHaveLength(0);
    expect(allText(renderer)).toContain('Preparing your form review…');

    await rerouteTo(renderer, 'analysis-2');
    await settle();
    expect(mockLoadEvidence).toHaveBeenCalledTimes(2);
    expect(mockLoadEvidence.mock.calls[1]![1]).toBe('analysis-2');
    expect(mockLoadSequence).toHaveBeenCalledTimes(2);

    // The FIRST (stale) sidecar resolves now.
    const stale = sequenceTagged(1);
    await act(async () => {
      staleSidecar.resolve(stale);
    });
    await settle();
    expect(players(renderer)).toHaveLength(0);
    expect(allText(renderer)).toContain('Preparing your form review…');

    const fresh = sequenceTagged(2);
    await act(async () => {
      freshSidecar.resolve(fresh);
    });
    await settle();
    const [player] = players(renderer);
    expect(player).toBeDefined();
    expect(player!.props.sequence).toBe(fresh);
    expect(player!.props.sequence).not.toBe(stale);
    expect((player!.props.analysis as ShotAnalysis).id).toBe('analysis-2');
    expect((player!.props.clip as { uri: string }).uri).toContain('analysis-2');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('A→B→A flip: the first A sidecar (stale) never paints; the third load owns the screen', async () => {
    const loads: Array<Deferred<ReviewPoseSequence>> = [];
    mockLoadSequence.mockImplementation(() => {
      const d = deferred<ReviewPoseSequence>();
      loads.push(d);
      return d.promise;
    });
    const renderer = await renderScreen();
    await settle();
    await rerouteTo(renderer, 'analysis-2');
    await settle();
    await rerouteTo(renderer, 'analysis-1');
    await settle();
    expect(loads).toHaveLength(3);

    const staleA = sequenceTagged(11);
    await act(async () => {
      loads[0]!.resolve(staleA);
    });
    await settle();
    expect(players(renderer)).toHaveLength(0);

    const staleB = sequenceTagged(22);
    await act(async () => {
      loads[1]!.resolve(staleB);
    });
    await settle();
    expect(players(renderer)).toHaveLength(0);

    const liveA = sequenceTagged(33);
    await act(async () => {
      loads[2]!.resolve(liveA);
    });
    await settle();
    const [player] = players(renderer);
    expect(player!.props.sequence).toBe(liveA);
    expect((player!.props.analysis as ShotAnalysis).id).toBe('analysis-1');
  });

  it('stale sidecar REJECTING after the route change is inert; the new route still needs its own reads', async () => {
    const staleSidecar = deferred<ReviewPoseSequence>();
    const freshSidecar = deferred<ReviewPoseSequence>();
    mockLoadSequence.mockImplementation(ref =>
      (ref as { uri: string }).uri.includes('analysis-1')
        ? staleSidecar.promise
        : freshSidecar.promise,
    );
    const renderer = await renderScreen();
    await settle();
    await rerouteTo(renderer, 'analysis-2');
    await settle();
    await act(async () => {
      staleSidecar.reject(new Error('sha256 mismatch'));
    });
    await settle();
    expect(players(renderer)).toHaveLength(0);
    // Fresh sidecar corrupt → honest pose-less replay for analysis-2.
    await act(async () => {
      freshSidecar.reject(new Error('sha256 mismatch'));
    });
    await settle();
    const [player] = players(renderer);
    expect(player!.props.sequence).toBeNull();
    expect((player!.props.analysis as ShotAnalysis).id).toBe('analysis-2');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('stale EVIDENCE (not just the sidecar) resolving after a route change never paints, even as "missing"', async () => {
    const staleEvidence = deferred<unknown>();
    const freshEvidence = deferred<unknown>();
    mockLoadEvidence.mockImplementation((_db, id) =>
      id === 'analysis-1' ? staleEvidence.promise : freshEvidence.promise,
    );
    const renderer = await renderScreen();
    await settle();
    await rerouteTo(renderer, 'analysis-2');
    await settle();
    // Stale route's evidence turns out missing: must NOT flip the new
    // route's screen to "Review unavailable".
    await act(async () => {
      staleEvidence.resolve(null);
    });
    await settle();
    expect(allText(renderer)).not.toContain('Review unavailable');
    expect(allText(renderer)).toContain('Preparing your form review…');
    await act(async () => {
      freshEvidence.resolve(evidenceFor('analysis-2'));
    });
    await settle();
    expect(players(renderer)).toHaveLength(1);
    expect(mockLoadSequence).toHaveBeenCalledTimes(1);
    expect(
      (mockLoadSequence.mock.calls[0]![0] as { uri: string }).uri,
    ).toContain('analysis-2');
  });

  it('unmount while evidence is pending: the late evidence causes no render/error (the sidecar hash-read still runs once, result dropped)', async () => {
    const evidence = deferred<unknown>();
    mockLoadEvidence.mockReturnValue(evidence.promise);
    const renderer = await renderScreen();
    await act(async () => {
      renderer.unmount();
    });
    mounted.splice(mounted.indexOf(renderer), 1);
    await act(async () => {
      jest.advanceTimersByTime(500);
      evidence.resolve(evidenceFor('analysis-1'));
    });
    await settle();
    expect(renderer.toJSON()).toBeNull();
    // Observed (not a defect, recorded for the report): the effect only
    // checks `cancelled` AFTER the sidecar await, so one hash-verify read is
    // issued for a screen that is already gone. Its result never paints.
    expect(mockLoadSequence).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('deep-linked phase that the script does not have opens on no stop (no throw, no fake stop)', async () => {
    mockRouteParams = { analysisId: 'analysis-1', phase: 'not-a-phase' };
    const renderer = await renderScreen();
    await settle();
    const [player] = players(renderer);
    expect(player!.props.initialStop).toBeNull();
    expect(allText(renderer)).toContain(`STOP 1 OF ${STOPS.length}`);
  });
});

// ─── S6 — next-stop hammering at the last stop ──────────────────────────────

describe('S6 — "next" pressed 20× rapidly at the last stop', () => {
  async function openAtLastStop() {
    const renderer = await renderScreen();
    await settle();
    for (let i = 0; i < STOPS.length - 1; i += 1) {
      await press(renderer, 'form-review-next-stop');
    }
    expect(allText(renderer)).toContain(
      `STOP ${STOPS.length} OF ${STOPS.length}`,
    );
    expect(seekMsOf(renderer)).toBe(LAST_STOP.atMs);
    return renderer;
  }

  it('20 presses in one frame: stop stays last, seek never re-requested, control disabled', async () => {
    const renderer = await openAtLastStop();
    const next = byTestId(renderer, 'form-review-next-stop');
    expect(next.props.disabled).toBe(true);
    const seekBefore = seekMsOf(renderer);
    await act(async () => {
      for (let i = 0; i < 20; i += 1) next.props.onPress();
    });
    await settle();
    expect(allText(renderer)).toContain(
      `STOP ${STOPS.length} OF ${STOPS.length}`,
    );
    expect(allText(renderer)).toContain(LAST_STOP.headline);
    expect(seekMsOf(renderer)).toBe(seekBefore);
    expect(seekMsOf(renderer)).toBe(LAST_STOP.atMs);
    expect(byTestId(renderer, 'form-review-next-stop').props.disabled).toBe(
      true,
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('20 presses across 20 renders: no +0.01 accumulation', async () => {
    const renderer = await openAtLastStop();
    for (let i = 0; i < 20; i += 1) {
      await press(renderer, 'form-review-next-stop');
    }
    expect(seekMsOf(renderer)).toBe(LAST_STOP.atMs);
    expect(allText(renderer)).toContain(
      `STOP ${STOPS.length} OF ${STOPS.length}`,
    );
  });

  it('prev/next ping-pong 20× ends on the last stop with |seek − stop| ≤ 0.01', async () => {
    const renderer = await openAtLastStop();
    const seen = new Set<number>();
    for (let i = 0; i < 20; i += 1) {
      await press(renderer, 'form-review-prev-stop');
      await press(renderer, 'form-review-next-stop');
      seen.add(seekMsOf(renderer));
    }
    expect(allText(renderer)).toContain(
      `STOP ${STOPS.length} OF ${STOPS.length}`,
    );
    for (const value of seen) {
      expect(Math.abs(value - LAST_STOP.atMs)).toBeLessThanOrEqual(0.01);
    }
    // Repeated identical targets alternate between ms and ms+0.01 at most.
    expect(seen.size).toBeLessThanOrEqual(2);
  });

  it('20 scrubs at the same x drift by at most one 0.01 nudge (alternating, never accumulating)', async () => {
    const renderer = await renderScreen();
    await settle();
    const [track] = renderer.root.findAll(
      node =>
        node.props.testID === 'form-review-timeline' &&
        typeof node.props.onResponderGrant === 'function',
    );
    await act(async () => {
      track!.props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 340, height: 24 } },
      });
    });
    const values: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      await act(async () => {
        track!.props.onResponderGrant({ nativeEvent: { locationX: 170 } });
        track!.props.onResponderRelease();
      });
      values.push(seekMsOf(renderer));
    }
    const target = 0.5 * 3400;
    for (const value of values) {
      expect(Math.abs(value - target)).toBeLessThanOrEqual(0.01);
    }
    expect(new Set(values).size).toBeLessThanOrEqual(2);
    // Scrub jumps clear the active stop (caption follows the playhead).
    expect(allText(renderer)).toContain('1.70s');
  });

  it('prev pressed 20× at the FIRST stop mirrors: stays on stop 1, no seek churn', async () => {
    const renderer = await renderScreen();
    await settle();
    const seekBefore = seekMsOf(renderer);
    const prev = byTestId(renderer, 'form-review-prev-stop');
    expect(prev.props.disabled).toBe(true);
    await act(async () => {
      for (let i = 0; i < 20; i += 1) prev.props.onPress();
    });
    await settle();
    expect(allText(renderer)).toContain(`STOP 1 OF ${STOPS.length}`);
    expect(seekMsOf(renderer)).toBe(seekBefore);
  });
});
