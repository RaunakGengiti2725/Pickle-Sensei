/**
 * W09-01 — accessible Form Review seeking. The replay timeline is an
 * ADJUSTABLE control for VoiceOver (role, value, increment/decrement
 * actions) that seeks exactly like a finger on the track: playback pauses,
 * the playhead moves, and every checkpoint ahead of the new position is
 * re-armed. Playback stays in the foreground — leaving the app pauses the
 * replay where it is and nothing resumes it behind the user's back. Reduced
 * motion is honoured by the player itself (coarser replay clock) and by the
 * overlay (no arrow entrance animation).
 */
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
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Text,
  type AppStateStatus,
} from 'react-native';
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
import { FormReviewPlayer } from '../src/review/FormReviewPlayer';
import { FormReviewOverlay } from '../src/review/FormReviewOverlay';
import {
  buildFormReviewScript,
  type ReviewJoint,
  type ReviewPoseFrame,
  type ReviewPoseSequence,
} from '../src/review/formReviewModel';

// ─── Fixtures (same stroke as the Form Review screen suite) ─────────────────

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

const clip = {
  uri: 'file:///captures/clip.mov',
  durationMs: 3400,
  posterUri: 'file:///captures/clip.poster.jpg',
};

const review = {
  width: 1080,
  height: 1920,
  poseSequence: {
    schemaVersion: 1 as const,
    format: 'pickle.pose-sequence.v1' as const,
    uri: 'file:///captures/clip.pose.json',
    frameCount: 81,
    sha256: 'ab'.repeat(32),
    coordinateSystem: 'normalized_image_top_left' as const,
    poseModelVersion: 'apple-vision-bodypose-1',
  },
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

const sequence = fullBodySequence();
const script = buildFormReviewScript(analysis, sequence);

/** VoiceOver moves the playhead by a twentieth of the clip per swipe. */
const SEEK_STEP_MS = clip.durationMs / 20;

// ─── Harness ────────────────────────────────────────────────────────────────

const mounted: ReactTestRenderer[] = [];
let appStateListeners: Set<(state: AppStateStatus) => void>;
let appStateSpy: jest.SpyInstance;

async function renderPlayer() {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <FormReviewPlayer
        analysis={analysis}
        clip={clip}
        review={review}
        sequence={sequence}
        script={script}
      />,
    );
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

/** The rendered timeline host View (what VoiceOver actually focuses). */
function timeline(renderer: ReactTestRenderer) {
  const [host] = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.testID === 'form-review-timeline',
  );
  if (!host) throw new Error('no form-review-timeline host');
  return host;
}

async function voiceOver(
  renderer: ReactTestRenderer,
  actionName: 'increment' | 'decrement' | 'activate',
) {
  const host = timeline(renderer);
  expect(typeof host.props.onAccessibilityAction).toBe('function');
  await act(async () => {
    host.props.onAccessibilityAction({ nativeEvent: { actionName } });
  });
}

function playLabel(renderer: ReactTestRenderer) {
  return byTestId(renderer, 'form-review-play').props.accessibilityLabel;
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

async function changeAppState(state: AppStateStatus) {
  await act(async () => {
    appStateListeners.forEach(listener => listener(state));
  });
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

/**
 * The OS reduce-motion switch, flipped through the listener the design
 * system's observer registered (the observer is a module singleton, so the
 * initial `isReduceMotionEnabled` read only counts once per test file).
 */
function reduceMotionListener(): (value: boolean) => void {
  const listener = (
    AccessibilityInfo.addEventListener as jest.Mock
  ).mock.calls.find(call => call[0] === 'reduceMotionChanged')?.[1];
  if (typeof listener !== 'function') {
    throw new Error('the reduce-motion observer never registered');
  }
  return listener;
}

beforeEach(() => {
  jest.useFakeTimers();
  appStateListeners = new Set();
  appStateSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    });
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  appStateSpy.mockRestore();
  jest.useRealTimers();
});

describe('W09-01 accessible Form Review seeking', () => {
  it('exposes the timeline as an adjustable control whose value is the playhead', async () => {
    const renderer = await renderPlayer();
    const host = timeline(renderer);

    expect(host.props.accessibilityRole).toBe('adjustable');
    expect(host.props.accessibilityActions).toEqual(
      expect.arrayContaining([{ name: 'increment' }, { name: 'decrement' }]),
    );
    // The spoken value is the clock plus the checkpoint under the playhead.
    expect(host.props.accessibilityValue).toEqual({
      min: 0,
      max: clip.durationMs,
      now: 0,
      text: `0.00s, ${script.stops[0]!.title}`,
    });
    // The finger path is untouched: the same track still scrubs on drag.
    expect(typeof host.props.onResponderGrant).toBe('function');
    expect(typeof host.props.onResponderMove).toBe('function');
  });

  it('increment and decrement seek by a twentieth of the clip and clamp at both ends', async () => {
    const renderer = await renderPlayer();

    await voiceOver(renderer, 'increment');
    expect(timeline(renderer).props.accessibilityValue).toMatchObject({
      now: SEEK_STEP_MS,
    });
    expect(allText(renderer)).toContain('0.17s');
    // The stage caption follows the seek (the same clock a sighted user
    // reads), so VoiceOver on the video hears the new position too.
    expect(
      byTestId(renderer, 'form-review-stage').props.accessibilityLabel,
    ).toContain('0.17s');

    await voiceOver(renderer, 'decrement');
    await voiceOver(renderer, 'decrement');
    expect(timeline(renderer).props.accessibilityValue).toMatchObject({
      now: 0,
    });
    expect(allText(renderer)).toContain('0.00s');

    for (let i = 0; i < 25; i += 1) {
      await voiceOver(renderer, 'increment');
    }
    // Past the last measured phase the stop under the playhead is the last
    // one passed — the same stop the card and stage caption show.
    expect(timeline(renderer).props.accessibilityValue).toMatchObject({
      now: clip.durationMs,
      text: `3.40s, ${script.stops[script.stops.length - 1]!.title}`,
    });
    expect(allText(renderer)).toContain('3.40s');

    // An action the control did not advertise changes nothing.
    await voiceOver(renderer, 'activate');
    expect(timeline(renderer).props.accessibilityValue).toMatchObject({
      now: clip.durationMs,
    });
  });

  it('a VoiceOver seek pauses playback and re-arms the checkpoints ahead of the new position', async () => {
    const renderer = await renderPlayer();

    // Play through the ready checkpoint (450ms): auto-pause freezes there.
    await press(renderer, 'form-review-play');
    await advance(700);
    expect(allText(renderer)).toContain('0.45s');
    expect(playLabel(renderer)).toBe('Play replay');

    // Resume, then seek backwards mid-flight: playback stops on the seek.
    await press(renderer, 'form-review-play');
    await advance(100);
    expect(playLabel(renderer)).toBe('Pause replay');
    await voiceOver(renderer, 'decrement');
    await voiceOver(renderer, 'decrement');
    expect(playLabel(renderer)).toBe('Play replay');
    const seeked = timeline(renderer).props.accessibilityValue.now;
    expect(seeked).toBeGreaterThanOrEqual(0);
    expect(seeked).toBeLessThan(450);
    // Nothing advances while paused after the seek.
    await advance(500);
    expect(timeline(renderer).props.accessibilityValue.now).toBe(seeked);

    // Playing again re-crosses the ready checkpoint, which fires once more
    // exactly like a finger scrub back would re-arm it.
    await press(renderer, 'form-review-play');
    await advance(700);
    expect(allText(renderer)).toContain('0.45s');
    expect(playLabel(renderer)).toBe('Play replay');
    expect(timeline(renderer).props.accessibilityValue).toMatchObject({
      now: 450,
      text: `0.45s, ${script.stops[0]!.title}`,
    });
  });

  it('keeps playback in the foreground: backgrounding pauses where it is and never resumes by itself', async () => {
    const renderer = await renderPlayer();
    expect(appStateListeners.size).toBeGreaterThan(0);

    await press(renderer, 'form-review-play');
    await advance(300);
    expect(playLabel(renderer)).toBe('Pause replay');
    const before = timeline(renderer).props.accessibilityValue.now;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(450);

    await changeAppState('background');
    expect(playLabel(renderer)).toBe('Play replay');
    expect(timeline(renderer).props.accessibilityValue.now).toBe(before);
    // Time passing in the background moves nothing.
    await advance(2000);
    expect(timeline(renderer).props.accessibilityValue.now).toBe(before);

    // Coming back does not restart the replay behind the user's back.
    await changeAppState('active');
    expect(playLabel(renderer)).toBe('Play replay');
    expect(timeline(renderer).props.accessibilityValue.now).toBe(before);

    // A deliberate play resumes from the kept position, controls still mounted.
    await press(renderer, 'form-review-play');
    await advance(700);
    expect(allText(renderer)).toContain('0.45s');
    timeline(renderer);
    byTestId(renderer, 'form-review-prev-stop');
    byTestId(renderer, 'form-review-next-stop');

    // The listener does not outlive the player.
    await act(async () => {
      mounted.splice(0).forEach(r => r.unmount());
    });
    expect(appStateListeners.size).toBe(0);
  });

  it('honours reduced motion: the replay clock ticks coarsely and the arrow never animates', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    const renderer = await renderPlayer();
    const setReduced = reduceMotionListener();
    await act(async () => {
      setReduced(true);
    });
    timing.mockClear();
    try {
      await layoutStage(renderer);
      // The overlay is told, and its arrow appears without an entrance tween.
      const overlay = renderer.root.findByType(FormReviewOverlay);
      expect(overlay.props.reducedMotion).toBe(true);
      expect(
        renderer.root.findAll(
          node => node.props.testID === 'form-review-arrow-label',
        ),
      ).not.toHaveLength(0);
      expect(timing).not.toHaveBeenCalled();

      // The JS replay clock advances in coarse steps rather than at 30fps:
      // 100ms of playback shows no movement yet, the first step lands at 120ms.
      await press(renderer, 'form-review-play');
      await advance(100);
      expect(timeline(renderer).props.accessibilityValue.now).toBe(0);
      await advance(20);
      expect(timeline(renderer).props.accessibilityValue.now).toBe(120);
      // Real time is preserved: after 400ms the playhead reads 0.36s (three
      // coarse ticks), and the ready checkpoint still freezes playback.
      await advance(280);
      expect(timeline(renderer).props.accessibilityValue.now).toBe(360);
      await advance(200);
      expect(allText(renderer)).toContain('0.45s');
      expect(playLabel(renderer)).toBe('Play replay');
    } finally {
      await act(async () => {
        setReduced(false);
      });
      timing.mockRestore();
    }
  });

  it('without reduced motion the replay clock runs at frame rate', async () => {
    const renderer = await renderPlayer();
    await press(renderer, 'form-review-play');
    await advance(100);
    const now = timeline(renderer).props.accessibilityValue.now;
    expect(now).toBeGreaterThan(0);
    expect(now).toBeLessThan(120);
  });
});
