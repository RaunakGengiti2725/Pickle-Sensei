/**
 * FORM REVIEW screen — mounted-flow pins for the flagship replay: the
 * coaching caption names the worst measured checkpoint of the stop under the
 * playhead, prev/next move between measured stops, auto-pause freezes on a
 * checkpoint moment exactly once per pass, the re-analyze CTA re-arms the
 * guided camera with the same intent, and a stroke whose clip file is gone
 * still renders its pose-only stage without inventing a frame.
 *
 * Layout pins (Photos-app style, 2026-09-03): every control — timeline,
 * previous/play/next, speed, AUTO-pause — sits ON the video in a bottom bar;
 * the caption floats above it and hides while playing; a tap on the stage
 * toggles playback; the page is a fixed column (header · player filling ·
 * pinned CTAs) with no ScrollView.
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
import { FormReviewScreen } from '../src/screens/FormReviewScreen';
import {
  clearTryAgainHandoff,
  peekTryAgainHandoff,
} from '../src/screens/tryAgainHandoff';
import type {
  ReviewJoint,
  ReviewPoseFrame,
  ReviewPoseSequence,
} from '../src/review/formReviewModel';

// ─── Fixtures (same shape as the review model tests) ────────────────────────

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

const analysis: ShotAnalysis = {
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

const record = {
  id: 'analysis-1',
  captureId: 'capture-1',
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

/** 40ms frames of a full body; the right wrist sweeps left → right. */
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

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    analysis,
    record,
    clip: {
      uri: 'file:///captures/clip.mov',
      durationMs: 3400,
      posterUri: 'file:///captures/clip.poster.jpg',
    },
    review: { width: 1080, height: 1920, poseSequence: sidecarRef },
    attempts: [],
    ...overrides,
  };
}

// ─── Harness ────────────────────────────────────────────────────────────────

const mounted: ReactTestRenderer[] = [];

async function renderScreen() {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<FormReviewScreen />);
  });
  // Let the evidence + sidecar promises settle.
  await act(async () => {
    await Promise.resolve();
  });
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

/** First HOST node carrying the testID (the rendered View, not a wrapper). */
function hostByTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function flatStyle(node: { props: { style?: unknown } }) {
  return (StyleSheet.flatten(node.props.style as never) ?? {}) as Record<
    string,
    unknown
  >;
}

async function layoutStage(renderer: ReactTestRenderer) {
  const [stage] = renderer.root.findAll(
    node =>
      node.props.testID === 'form-review-stage' &&
      typeof node.props.onLayout === 'function',
  );
  await act(async () => {
    stage!.props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 420 } },
    });
  });
}

beforeEach(() => {
  // Fake timers for EVERY test in this file: the replay's JS clock and the
  // arrow pulse must never outlive a test, and (as the other mounted-screen
  // suites do) a file never mixes fake and real timers between tests.
  jest.useFakeTimers();
  jest.clearAllMocks();
  clearTryAgainHandoff();
  mockRouteParams = { analysisId: 'analysis-1' };
  mockLoadEvidence.mockResolvedValue(evidence());
  mockLoadSequence.mockResolvedValue(fullBodySequence());
});

afterEach(async () => {
  // Every mounted screen comes down even when an assertion failed, so one
  // test's replay state can never leak into the next.
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  jest.useRealTimers();
});

describe('FormReviewScreen', () => {
  it('opens on the first stop and names its worst measured checkpoint; next/prev walk the stops', async () => {
    const renderer = await renderScreen();
    expect(mockLoadEvidence).toHaveBeenCalledWith({}, 'analysis-1');
    expect(mockLoadSequence).toHaveBeenCalledWith(sidecarRef);

    let copy = allText(renderer);
    expect(copy).toContain('Form review');
    // The ready stop owns ready_position (85) and athletic_base (72): the
    // worst of the two leads the stop card UNDER the stage — verdict · phase,
    // the counter, the measured headline and the cue. Nothing is drawn over
    // the body.
    expect(hostByTestId(renderer, 'form-review-stop-card')).toHaveLength(1);
    expect(copy).toContain('WATCH · READY STANCE');
    expect(copy).toContain('STOP 1 OF 6');
    expect(copy).toContain('Athletic base scored 72 — was narrow');
    expect(copy).toContain('Widen your base');
    // Only the SHOWN stop's phase is named (no legend of every phase
    // competes with the video); the old "title · checkpoint · n / 100" meta
    // line and the COACHING CUE label are gone.
    expect(copy).not.toContain('FOLLOW-THROUGH');
    expect(copy).not.toContain('RECOVERY');
    expect(copy).not.toContain('72 / 100');
    expect(copy).not.toContain('COACHING CUE');
    // The timeline and ONE transport row sit under the card.
    expect(hostByTestId(renderer, 'form-review-timeline')).toHaveLength(1);
    for (const control of [
      'form-review-prev-stop',
      'form-review-play',
      'form-review-next-stop',
      'form-review-speed',
      'form-review-autopause',
    ]) {
      byTestId(renderer, control);
    }
    expect(
      byTestId(renderer, 'form-review-autopause').props.accessibilityRole,
    ).toBe('switch');
    expect(copy).toContain('AUTO');
    expect(copy).not.toContain('AUTO-PAUSE');

    await press(renderer, 'form-review-next-stop');
    copy = allText(renderer);
    expect(copy).toContain('STOP 2 OF 6');
    expect(copy).toContain('PREPARATION');
    expect(copy).toContain('Preparation scored 88 — held its target');
    expect(copy).toContain('STRONG');

    await press(renderer, 'form-review-next-stop');
    await press(renderer, 'form-review-next-stop');
    copy = allText(renderer);
    expect(copy).toContain('STOP 4 OF 6');
    expect(copy).toContain('Contact position scored 48 — contact came late');
    expect(copy).toContain('FIX');
    expect(copy).toContain('1.90s');

    await press(renderer, 'form-review-prev-stop');
    copy = allText(renderer);
    expect(copy).toContain('STOP 3 OF 6');
    expect(copy).toContain('Paddle path scored 61 — sat low');
  });

  it('opens frozen on the requested phase when a fix link names one', async () => {
    // "See it in your form review" on the contact-position fix → the replay
    // opens paused on the contact stop, with every earlier stop counted as
    // seen so resuming does not re-pause on them.
    mockRouteParams = { analysisId: 'analysis-1', phase: 'contact' };
    const renderer = await renderScreen();
    const copy = allText(renderer);
    expect(copy).toContain('STOP 4 OF 6');
    expect(copy).toContain('Contact position scored 48 — contact came late');
    expect(copy).toContain('1.90s');
  });

  it('ignores a requested phase the script has no stop for', async () => {
    mockRouteParams = { analysisId: 'analysis-1', phase: 'not_a_phase' };
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain('STOP 1 OF 6');
  });

  it('draws the arrow label for the shown stop once the stage has a size', async () => {
    const renderer = await renderScreen();
    await layoutStage(renderer);
    // Ready stop: athletic_base 'narrow' → an arrow on the ankle reading
    // "Widen your base"; the label chip is an RN Text, not SVG text.
    const [label] = renderer.root.findAll(
      node => node.props.testID === 'form-review-arrow-label',
    );
    expect(label).toBeDefined();
    expect(allText(renderer)).toContain('WIDEN YOUR BASE');
  });

  it('auto-pauses on each checkpoint moment exactly once per pass, and the speed chip cycles', async () => {
    const renderer = await renderScreen();
    // Without the native player the JS clock drives the replay: play, and
    // the first crossed checkpoint (ready @450ms) freezes playback.
    await press(renderer, 'form-review-play');
    expect(
      byTestId(renderer, 'form-review-play').props.accessibilityLabel,
    ).toBe('Pause replay');
    await act(async () => {
      jest.advanceTimersByTime(700);
    });
    let copy = allText(renderer);
    expect(copy).toContain('0.45s');
    expect(copy).toContain('STOP 1 OF 6');
    expect(
      byTestId(renderer, 'form-review-play').props.accessibilityLabel,
    ).toBe('Play replay');

    // Resume: the same stop never fires twice; the next one (1200ms) does.
    await press(renderer, 'form-review-play');
    await act(async () => {
      jest.advanceTimersByTime(1200);
    });
    copy = allText(renderer);
    expect(copy).toContain('1.20s');
    expect(copy).toContain('STOP 2 OF 6');

    // Auto-pause off: playback runs straight through the accelerate stop.
    // The compact AUTO pill carries its state as a switch, not as words.
    expect(
      byTestId(renderer, 'form-review-autopause').props.accessibilityState,
    ).toMatchObject({ checked: true });
    await press(renderer, 'form-review-autopause');
    expect(
      byTestId(renderer, 'form-review-autopause').props.accessibilityState,
    ).toMatchObject({ checked: false });
    await press(renderer, 'form-review-play');
    await act(async () => {
      jest.advanceTimersByTime(700);
    });
    copy = allText(renderer);
    expect(copy).not.toContain('1.70s');
    expect(copy).toContain('AUTO');
    expect(
      byTestId(renderer, 'form-review-play').props.accessibilityLabel,
    ).toBe('Pause replay');

    // Speed chip cycles 1× → ½× → ¼× → 1×.
    expect(allText(renderer)).toContain('1×');
    await press(renderer, 'form-review-speed');
    expect(allText(renderer)).toContain('½×');
    await press(renderer, 'form-review-speed');
    expect(allText(renderer)).toContain('¼×');
    await press(renderer, 'form-review-speed');
    expect(allText(renderer)).toContain('1×');
  });

  it('a tap on the stage toggles playback like Photos; the stop card stays readable while playing', async () => {
    const renderer = await renderScreen();
    const stage = byTestId(renderer, 'form-review-stage');
    expect(stage.props.accessibilityLabel).toContain('Ready stance');
    expect(hostByTestId(renderer, 'form-review-stop-card')).toHaveLength(1);

    await press(renderer, 'form-review-stage');
    expect(
      byTestId(renderer, 'form-review-play').props.accessibilityLabel,
    ).toBe('Pause replay');
    // Playing: the card lives UNDER the stage, so it never has to get out
    // of the body's way — it stays mounted, visible and readable by screen
    // readers, and the controls stay with it.
    const cardPlaying = hostByTestId(renderer, 'form-review-stop-card')[0]!;
    expect(cardPlaying.props.accessibilityElementsHidden).toBeUndefined();
    expect(cardPlaying.props.accessibilityLabel).toContain('Athletic base');
    expect(allText(renderer)).toContain('Widen your base');
    byTestId(renderer, 'form-review-play');
    expect(hostByTestId(renderer, 'form-review-timeline')).toHaveLength(1);

    await press(renderer, 'form-review-stage');
    expect(
      byTestId(renderer, 'form-review-play').props.accessibilityLabel,
    ).toBe('Play replay');
    expect(hostByTestId(renderer, 'form-review-stop-card')).toHaveLength(1);
  });

  it('the timeline is an adjustable control: swipe up/down (increment/decrement) moves the playhead without a drag', async () => {
    const renderer = await renderScreen();
    const timelineAt = () => hostByTestId(renderer, 'form-review-timeline')[0]!;
    const clockText = () => allText(renderer).match(/\b\d+\.\d{2}s\b/g) ?? [];
    const timeline = timelineAt();
    expect(timeline.props.accessibilityRole).toBe('adjustable');
    expect(timeline.props.accessibilityActions).toEqual(
      expect.arrayContaining([{ name: 'increment' }, { name: 'decrement' }]),
    );
    expect(typeof timeline.props.onAccessibilityAction).toBe('function');
    expect(timeline.props.accessibilityHint).toMatch(/swipe up (and|or) down/i);
    // The value mirrors the playhead: 0 of the clip's 3400ms at open.
    expect(timeline.props.accessibilityValue).toMatchObject({
      min: 0,
      max: 3400,
      now: 0,
      text: '0.00s',
    });
    expect(clockText()).toContain('0.00s');

    // Swipe up: the playhead advances one step (1/20th of the clip = 170ms)
    // and the rendered clock, the announced value and the label agree.
    await act(async () => {
      timelineAt().props.onAccessibilityAction({
        nativeEvent: { actionName: 'increment' },
      });
    });
    expect(clockText()).toContain('0.17s');
    expect(clockText()).not.toContain('0.00s');
    expect(timelineAt().props.accessibilityValue).toMatchObject({
      now: 170,
      text: '0.17s',
    });
    await act(async () => {
      timelineAt().props.onAccessibilityAction({
        nativeEvent: { actionName: 'increment' },
      });
    });
    expect(clockText()).toContain('0.34s');
    expect(timelineAt().props.accessibilityValue).toMatchObject({ now: 340 });

    // Swipe down walks back; it never goes before the start of the clip.
    await act(async () => {
      timelineAt().props.onAccessibilityAction({
        nativeEvent: { actionName: 'decrement' },
      });
    });
    expect(clockText()).toContain('0.17s');
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        timelineAt().props.onAccessibilityAction({
          nativeEvent: { actionName: 'decrement' },
        });
      });
    }
    expect(clockText()).toContain('0.00s');
    expect(timelineAt().props.accessibilityValue).toMatchObject({ now: 0 });

    // And never past the end: 25 swipes up land on the clip's last moment.
    for (let i = 0; i < 25; i += 1) {
      await act(async () => {
        timelineAt().props.onAccessibilityAction({
          nativeEvent: { actionName: 'increment' },
        });
      });
    }
    expect(clockText()).toContain('3.40s');
    expect(timelineAt().props.accessibilityValue).toMatchObject({
      now: 3400,
      text: '3.40s',
    });

    // A step while playing behaves like a drag: playback pauses on the
    // new frame instead of racing away from it.
    await press(renderer, 'form-review-play');
    expect(
      byTestId(renderer, 'form-review-play').props.accessibilityLabel,
    ).toBe('Pause replay');
    await act(async () => {
      timelineAt().props.onAccessibilityAction({
        nativeEvent: { actionName: 'decrement' },
      });
    });
    expect(
      byTestId(renderer, 'form-review-play').props.accessibilityLabel,
    ).toBe('Play replay');

    // Unknown actions are ignored.
    const before = timelineAt().props.accessibilityValue.now;
    await act(async () => {
      timelineAt().props.onAccessibilityAction({
        nativeEvent: { actionName: 'magicTap' },
      });
    });
    expect(timelineAt().props.accessibilityValue.now).toBe(before);
  });

  it('fills the page: no ScrollView, the player and its stage are flex columns, CTAs stay pinned', async () => {
    const renderer = await renderScreen();
    expect(renderer.root.findAllByType(ScrollView)).toHaveLength(0);
    const [player] = hostByTestId(renderer, 'form-review-player');
    expect(flatStyle(player!)).toMatchObject({ flex: 1 });
    const [stage] = hostByTestId(renderer, 'form-review-stage');
    const stageStyle = flatStyle(stage!);
    expect(stageStyle).toMatchObject({ flex: 1 });
    expect(stageStyle.height).toBeUndefined();
    byTestId(renderer, 'form-review-reanalyze');
    byTestId(renderer, 'form-review-back');
  });

  it('re-analyze arms the same-intent handoff and opens the guided camera', async () => {
    const renderer = await renderScreen();
    expect(peekTryAgainHandoff()).toBeNull();
    await press(renderer, 'form-review-reanalyze');
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

    await press(renderer, 'form-review-back');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('renders the pose-only stage when the clip file is gone, without inventing frames', async () => {
    mockLoadEvidence.mockResolvedValue(evidence({ clip: null }));
    const renderer = await renderScreen();
    await layoutStage(renderer);
    const copy = allText(renderer);
    expect(copy).toContain(
      'The clip file is gone from this device; the measured pose is shown instead.',
    );
    expect(copy).toContain('Athletic base scored 72 — was narrow');
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          node.props.testID === 'form-review-overlay',
      ),
    ).toHaveLength(1);
    // No clip poster is drawn from nowhere.
    expect(
      renderer.root.findAll(
        node => node.props.accessibilityLabel === 'Captured clip poster',
      ),
    ).toHaveLength(0);
  });

  it('tells the truth when the sidecar fails verification: video without an exoskeleton', async () => {
    mockLoadSequence.mockResolvedValue(null);
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain(
      'No verified pose sequence is stored for this clip',
    );
    // The script still exists — stops come from the analysis, not the pose.
    expect(allText(renderer)).toContain('STOP 1 OF 6');
  });

  it('shows the unavailable state when the analysis is missing', async () => {
    mockLoadEvidence.mockResolvedValue({
      analysis: null,
      record: null,
      clip: null,
      review: null,
      attempts: [],
    });
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain('Review unavailable');
    expect(mockLoadSequence).not.toHaveBeenCalled();
  });
});
