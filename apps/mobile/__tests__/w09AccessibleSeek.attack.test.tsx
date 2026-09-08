/**
 * W09-01 adversarial suite — attacks on the accessible Form Review seek
 * control at its failure boundaries: reduced-motion clock granularity vs
 * auto-pause, float drift at the clamped ends, corrupt clip durations,
 * unknown accessibility actions, interleaved seek / clock / AppState events,
 * unmount + remount (process death), copy and value invariants for VoiceOver,
 * reduce-motion flips mid-playback and every non-active AppState value.
 *
 * Every test is a real assertion about behaviour the candidate claims. A
 * failing test here is a confirmed break of the candidate, not of this file.
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
import {
  buildFormReviewScript,
  type ReviewJoint,
  type ReviewPoseFrame,
  type ReviewPoseSequence,
  type ReviewStop,
} from '../src/review/formReviewModel';

// ─── Fixtures (same stroke as the candidate suite) ──────────────────────────

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

function fullBodySequence(lastMs = 3200): ReviewPoseSequence {
  const frames: ReviewPoseFrame[] = [];
  for (let t = 0; t <= lastMs; t += 40) {
    const sweep = t / lastMs;
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

/**
 * A stroke whose last measured checkpoint (recover, 2650ms) sits 15ms before
 * the end of a 2665ms clip. Playing on from the follow-through stop (2160ms):
 * the 30fps clock (33.33ms) ticks 2626.7 → 2660, crossing the stop before
 * the end; the reduced-motion clock (120ms) ticks 2640 → 2760, i.e. its only
 * tick that crosses the stop is the one that also runs off the end.
 */
const LATE_STOP_MS = 2650;
const LATE_CLIP_MS = 2665;
const lateAnalysis: ShotAnalysis = {
  ...analysis,
  id: 'analysis-late',
  timestamps: { startMs: 0, contactMs: 1900, endMs: LATE_CLIP_MS },
  phases: [
    phase('ready', 0, 900),
    phase('prepare', 900, 1500),
    phase('accelerate', 1500, 1900),
    phase('contact', 1880, 1920, 1900),
    phase('follow_through', 1920, 2400),
    phase('recover', 2400, LATE_CLIP_MS, LATE_STOP_MS),
  ],
};
const lateSequence = fullBodySequence(2600);
const lateScript = buildFormReviewScript(lateAnalysis, lateSequence);
const lateClip = { ...clip, durationMs: LATE_CLIP_MS };

const PROHIBITED_COPY =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?%|accurac|best|perfect|guarantee|world.?class|#1|number one|replaces? (a|your) coach/i;

// ─── Harness ────────────────────────────────────────────────────────────────

const mounted: ReactTestRenderer[] = [];
let appStateListeners: Set<(state: AppStateStatus) => void>;
let appStateSpy: jest.SpyInstance;

type PlayerProps = React.ComponentProps<typeof FormReviewPlayer>;

async function renderPlayer(overrides: Partial<PlayerProps> = {}) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <FormReviewPlayer
        analysis={analysis}
        clip={clip}
        review={review}
        sequence={sequence}
        script={script}
        {...overrides}
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

function timeline(renderer: ReactTestRenderer) {
  const [host] = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.testID === 'form-review-timeline',
  );
  if (!host) throw new Error('no form-review-timeline host');
  return host;
}

function value(renderer: ReactTestRenderer): {
  min: number;
  max: number;
  now: number;
  text: string;
} {
  return timeline(renderer).props.accessibilityValue;
}

async function voiceOver(renderer: ReactTestRenderer, actionName: string) {
  const host = timeline(renderer);
  await act(async () => {
    host.props.onAccessibilityAction({ nativeEvent: { actionName } });
  });
}

function playLabel(renderer: ReactTestRenderer) {
  return byTestId(renderer, 'form-review-play').props.accessibilityLabel;
}

function stopCardLabel(renderer: ReactTestRenderer): string {
  const [card] = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.testID === 'form-review-stop-card',
  );
  if (!card) throw new Error('no form-review-stop-card host');
  return card.props.accessibilityLabel;
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

/**
 * Real time passing while React commits between clock ticks (a single
 * `advanceTimersByTime` would fire every queued tick before the pause's
 * re-render can clear the interval, which no device does).
 */
async function playFor(ms: number, stepMs = 10) {
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    await advance(Math.min(stepMs, ms - elapsed));
  }
}

async function changeAppState(state: AppStateStatus) {
  await act(async () => {
    appStateListeners.forEach(listener => listener(state));
  });
}

function reduceMotionListener(): (value: boolean) => void {
  const listener = (
    AccessibilityInfo.addEventListener as jest.Mock
  ).mock.calls.find(call => call[0] === 'reduceMotionChanged')?.[1];
  if (typeof listener !== 'function') {
    throw new Error('the reduce-motion observer never registered');
  }
  return listener;
}

async function withReducedMotion(run: () => Promise<void>) {
  const setReduced = reduceMotionListener();
  await act(async () => {
    setReduced(true);
  });
  try {
    await run();
  } finally {
    await act(async () => {
      setReduced(false);
    });
  }
}

/** Percentage widths of every host View styled `{ width: 'NN%' }`. */
function playedWidthsPct(renderer: ReactTestRenderer): number[] {
  const out: number[] = [];
  renderer.root
    .findAll(node => typeof node.type === 'string')
    .forEach(node => {
      const styles: unknown[] = Array.isArray(node.props.style)
        ? node.props.style
        : [node.props.style];
      for (const style of styles) {
        if (typeof style !== 'object' || style === null) continue;
        const width = (style as { width?: unknown }).width;
        if (typeof width === 'string' && width.endsWith('%')) {
          out.push(Number.parseFloat(width));
        }
      }
    });
  return out;
}

/** Every string a VoiceOver user or a sighted user can read on the player. */
function everyCopy(renderer: ReactTestRenderer): string[] {
  const copy: string[] = [allText(renderer)];
  renderer.root
    .findAll(node => typeof node.type === 'string')
    .forEach(node => {
      const { accessibilityLabel, accessibilityHint, accessibilityValue } =
        node.props;
      if (typeof accessibilityLabel === 'string') copy.push(accessibilityLabel);
      if (typeof accessibilityHint === 'string') copy.push(accessibilityHint);
      if (accessibilityValue && typeof accessibilityValue.text === 'string') {
        copy.push(accessibilityValue.text);
      }
    });
  return copy;
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

/**
 * Park the player on the second-to-last checkpoint (every earlier one is
 * then counted as seen) so the next play crosses only the last checkpoint.
 */
async function jumpToSecondLast(
  renderer: ReactTestRenderer,
  stops: readonly ReviewStop[],
) {
  const target = stops[stops.length - 2]!;
  for (let i = 0; i < stops.length; i += 1) {
    if (value(renderer).now === target.atMs) break;
    await press(renderer, 'form-review-next-stop');
  }
  expect(value(renderer).now).toBe(target.atMs);
  expect(playLabel(renderer)).toBe('Play replay');
}

// ─── Attacks ────────────────────────────────────────────────────────────────

describe('W09-01 attack: reduced-motion clock granularity vs auto-pause', () => {
  it('A1a control — at frame rate the last checkpoint 15ms before the clip end still auto-pauses', async () => {
    const renderer = await renderPlayer({
      analysis: lateAnalysis,
      clip: lateClip,
      sequence: lateSequence,
      script: lateScript,
    });
    const last = lateScript.stops[lateScript.stops.length - 1]!;
    expect(last.atMs).toBe(LATE_STOP_MS);

    await jumpToSecondLast(renderer, lateScript.stops);
    await press(renderer, 'form-review-play');
    await playFor(LATE_CLIP_MS);
    // Frozen on the checkpoint frame with its caption, not run off the end.
    expect(playLabel(renderer)).toBe('Play replay');
    expect(value(renderer).now).toBe(LATE_STOP_MS);
    expect(stopCardLabel(renderer)).toContain(last.title);
    expect(stopCardLabel(renderer)).toContain(
      `stop ${lateScript.stops.length} of ${lateScript.stops.length}`,
    );
  });

  it('A1b with Reduce Motion on, the same checkpoint must still freeze the replay (coarse clock is a rendering choice, not a behaviour change)', async () => {
    const renderer = await renderPlayer({
      analysis: lateAnalysis,
      clip: lateClip,
      sequence: lateSequence,
      script: lateScript,
    });
    const last = lateScript.stops[lateScript.stops.length - 1]!;
    await withReducedMotion(async () => {
      await jumpToSecondLast(renderer, lateScript.stops);
      await press(renderer, 'form-review-play');
      await playFor(LATE_CLIP_MS);
      expect(playLabel(renderer)).toBe('Play replay');
      // The claim under test: "auto-pause still freezes on the exact
      // checkpoint frame" with reduced motion.
      expect(value(renderer).now).toBe(LATE_STOP_MS);
      expect(stopCardLabel(renderer)).toContain(last.title);
    });
  });
});

describe('W09-01 attack: boundary values at the clamped ends', () => {
  it('A2 a non-integral seek step never drifts below 0, above the clip or into NaN across 120 swipes', async () => {
    const oddClip = { ...clip, durationMs: 3333 };
    const renderer = await renderPlayer({ clip: oddClip });
    const seen: number[] = [];
    const widths: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      await voiceOver(renderer, 'increment');
      seen.push(value(renderer).now);
      widths.push(...playedWidthsPct(renderer));
    }
    expect(value(renderer)).toMatchObject({ max: 3333, now: 3333 });
    for (let i = 0; i < 60; i += 1) {
      await voiceOver(renderer, 'decrement');
      seen.push(value(renderer).now);
      widths.push(...playedWidthsPct(renderer));
    }
    expect(value(renderer).now).toBe(0);
    expect(value(renderer).text).toBe(`0.00s, ${script.stops[0]!.title}`);
    for (const now of seen) {
      expect(Number.isInteger(now)).toBe(true);
      expect(now).toBeGreaterThanOrEqual(0);
      expect(now).toBeLessThanOrEqual(3333);
    }
    // The played band never overflows the track either.
    expect(widths.length).toBeGreaterThan(0);
    for (const pct of widths) {
      expect(Number.isFinite(pct)).toBe(true);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });

  it('A2b seeking to the very end then playing restarts from 0 and re-arms every checkpoint', async () => {
    const renderer = await renderPlayer();
    for (let i = 0; i < 20; i += 1) await voiceOver(renderer, 'increment');
    expect(value(renderer).now).toBe(clip.durationMs);
    await press(renderer, 'form-review-play');
    await advance(700);
    expect(value(renderer).now).toBe(script.stops[0]!.atMs);
    expect(playLabel(renderer)).toBe('Play replay');
  });
});

describe('W09-01 attack: corrupt / partial persisted clip state', () => {
  it('A3a a clip record with a NaN or zero duration degrades to the measured extent (finite, ≥ 1000ms)', async () => {
    for (const durationMs of [Number.NaN, 0, -1]) {
      const renderer = await renderPlayer({ clip: { ...clip, durationMs } });
      const v = value(renderer);
      expect(Number.isFinite(v.max)).toBe(true);
      expect(v.max).toBeGreaterThanOrEqual(1000);
      await voiceOver(renderer, 'increment');
      expect(value(renderer).now).toBe(Math.round(v.max / 20));
    }
  });

  it('A3b a clip shorter than the analysis: opening on a stop past the clip end keeps the adjustable value inside [min, max]', async () => {
    const shortClip = { ...clip, durationMs: 1000 };
    const initialStop: ReviewStop = script.stops[script.stops.length - 1]!;
    expect(initialStop.atMs).toBeGreaterThan(shortClip.durationMs);
    const renderer = await renderPlayer({ clip: shortClip, initialStop });
    const opened = value(renderer);
    expect(opened.max).toBe(1000);
    // VoiceOver's adjustable contract: now ∈ [min, max].
    expect(opened.now).toBeLessThanOrEqual(opened.max);
  });

  it('A3c ... and a swipe up (increment) from there never moves the playhead backwards', async () => {
    const shortClip = { ...clip, durationMs: 1000 };
    const initialStop: ReviewStop = script.stops[script.stops.length - 1]!;
    const renderer = await renderPlayer({ clip: shortClip, initialStop });
    const before = value(renderer).now;
    await voiceOver(renderer, 'increment');
    expect(value(renderer).now).toBeGreaterThanOrEqual(before);
  });
});

describe('W09-01 attack: unknown, replayed and duplicate accessibility actions', () => {
  it('A4 unadvertised actions (activate, magicTap, escape, longpress, empty, undefined) never seek or pause', async () => {
    const renderer = await renderPlayer();
    await press(renderer, 'form-review-play');
    await advance(100);
    const before = value(renderer).now;
    expect(playLabel(renderer)).toBe('Pause replay');
    const host = timeline(renderer);
    for (const actionName of [
      'activate',
      'magicTap',
      'escape',
      'longpress',
      '',
    ]) {
      await act(async () => {
        host.props.onAccessibilityAction({ nativeEvent: { actionName } });
      });
    }
    await act(async () => {
      host.props.onAccessibilityAction({ nativeEvent: {} });
    });
    expect(playLabel(renderer)).toBe('Pause replay');
    expect(value(renderer).now).toBe(before);
    // Only the two advertised actions exist — no duplicates, no extras.
    expect(host.props.accessibilityActions).toEqual([
      { name: 'increment' },
      { name: 'decrement' },
    ]);
  });
});

describe('W09-01 attack: concurrency — seek, clock tick and AppState interleaved', () => {
  it('A5 a VoiceOver seek during playback wins over the already-queued clock tick, and a background/active pair afterwards moves nothing', async () => {
    const renderer = await renderPlayer();
    await press(renderer, 'form-review-play');
    await advance(200);
    expect(playLabel(renderer)).toBe('Pause replay');
    // Seek right before the next tick would fire.
    await advance(30);
    await voiceOver(renderer, 'increment');
    const seeked = value(renderer).now;
    expect(playLabel(renderer)).toBe('Play replay');
    await advance(400);
    expect(value(renderer).now).toBe(seeked);

    await changeAppState('background');
    await changeAppState('active');
    expect(value(renderer).now).toBe(seeked);
    expect(playLabel(renderer)).toBe('Play replay');

    // Interleave the other way: background lands between two seeks. One
    // 30fps tick (33.3ms) runs before the first swipe; each swipe is 170ms.
    await press(renderer, 'form-review-play');
    await advance(50);
    await voiceOver(renderer, 'decrement');
    await changeAppState('inactive');
    await voiceOver(renderer, 'decrement');
    await changeAppState('active');
    expect(playLabel(renderer)).toBe('Play replay');
    const expected = Math.round(
      seeked + 1000 / 30 - 2 * (clip.durationMs / 20),
    );
    expect(value(renderer).now).toBe(expected);
    await advance(1000);
    expect(value(renderer).now).toBe(expected);
  });

  it('A5b every non-active AppState value pauses; active never does; a second listener is never registered', async () => {
    for (const state of ['inactive', 'background', 'extension', 'unknown']) {
      const renderer = await renderPlayer();
      expect(appStateListeners.size).toBe(1);
      await press(renderer, 'form-review-play');
      await advance(100);
      expect(playLabel(renderer)).toBe('Pause replay');
      await changeAppState(state as AppStateStatus);
      expect(playLabel(renderer)).toBe('Play replay');
      await act(async () => {
        mounted.splice(0).forEach(r => r.unmount());
      });
      expect(appStateListeners.size).toBe(0);
    }
    const renderer = await renderPlayer();
    await press(renderer, 'form-review-play');
    await advance(100);
    await changeAppState('active');
    expect(playLabel(renderer)).toBe('Pause replay');
    // Re-renders (seek, speed change) must not stack listeners.
    await press(renderer, 'form-review-speed');
    await voiceOver(renderer, 'increment');
    expect(appStateListeners.size).toBe(1);
  });
});

describe('W09-01 attack: process death and restart', () => {
  it('A6 unmounting mid-playback leaves no timer or AppState listener; remounting on a stop restores the seek and visited state', async () => {
    // Baseline: mount and unmount without playing, let every one-shot
    // timer the tree owns run out; whatever remains is not the replay clock.
    const idle = await renderPlayer();
    await act(async () => {
      idle.unmount();
    });
    mounted.splice(0);
    await advance(10_000);
    const baselineTimers = jest.getTimerCount();

    const renderer = await renderPlayer();
    await press(renderer, 'form-review-play');
    await advance(100);
    expect(playLabel(renderer)).toBe('Pause replay');
    await act(async () => {
      mounted.splice(0).forEach(r => r.unmount());
    });
    expect(appStateListeners.size).toBe(0);
    // The replay clock (an interval) died with the player.
    await advance(10_000);
    expect(jest.getTimerCount()).toBe(baselineTimers);

    const stop = script.stops[1]!;
    const restored = await renderPlayer({ initialStop: stop });
    expect(value(restored)).toMatchObject({
      now: stop.atMs,
      text: `${(stop.atMs / 1000).toFixed(2)}s, ${stop.title}`,
    });
    expect(stopCardLabel(restored)).toContain(stop.title);
    // Playing on from the restored stop fires the NEXT checkpoint, not an
    // earlier one that a fresh mount would have counted as unseen.
    await press(restored, 'form-review-play');
    await advance(script.stops[2]!.atMs - stop.atMs + 100);
    expect(playLabel(restored)).toBe('Play replay');
    expect(value(restored).now).toBe(script.stops[2]!.atMs);
  });
});

describe('W09-01 attack: copy and accessibility invariants', () => {
  it('A7 no prohibited copy anywhere on the player, at rest, playing, on every stop and at both ends', async () => {
    const renderer = await renderPlayer();
    const snapshots: string[] = [];
    snapshots.push(...everyCopy(renderer));
    await press(renderer, 'form-review-play');
    await advance(100);
    snapshots.push(...everyCopy(renderer));
    for (let i = 0; i < script.stops.length + 1; i += 1) {
      await press(renderer, 'form-review-next-stop');
      snapshots.push(...everyCopy(renderer));
    }
    for (let i = 0; i < 25; i += 1) {
      await voiceOver(renderer, 'increment');
      const v = value(renderer);
      expect(v.now).toBeGreaterThanOrEqual(v.min);
      expect(v.now).toBeLessThanOrEqual(v.max);
      snapshots.push(...everyCopy(renderer));
    }
    const offenders = snapshots.filter(copy => PROHIBITED_COPY.test(copy));
    expect(offenders).toEqual([]);

    const host = timeline(renderer);
    expect(host.props.accessible).toBe(true);
    expect(host.props.accessibilityLabel).toBe('Review timeline');
    expect(typeof host.props.accessibilityHint).toBe('string');
    // The hint speaks of swiping — the VoiceOver gesture for adjustable
    // controls — and does not promise a drag-only interaction.
    expect(host.props.accessibilityHint).toMatch(/swipe/i);
  });

  it('A7b the spoken value and the stop card name the same checkpoint on every stop reached through the transport', async () => {
    const renderer = await renderPlayer();
    const visited = new Set<number>();
    for (let i = 0; i < script.stops.length; i += 1) {
      await press(renderer, 'form-review-next-stop');
      const v = value(renderer);
      const stop = script.stops.find(s => s.atMs === v.now);
      expect(stop).toBeDefined();
      visited.add(v.now);
      expect(v.text).toBe(`${(v.now / 1000).toFixed(2)}s, ${stop!.title}`);
      expect(stopCardLabel(renderer)).toContain(stop!.title);
    }
    for (let i = 0; i < script.stops.length; i += 1) {
      await press(renderer, 'form-review-prev-stop');
      const v = value(renderer);
      const stop = script.stops.find(s => s.atMs === v.now);
      expect(stop).toBeDefined();
      visited.add(v.now);
      expect(v.text).toBe(`${(v.now / 1000).toFixed(2)}s, ${stop!.title}`);
      expect(stopCardLabel(renderer)).toContain(stop!.title);
    }
    // Walking next then previous across the whole clip reaches every stop.
    expect([...visited].sort((a, b) => a - b)).toEqual(
      script.stops.map(s => s.atMs),
    );
  });
});

describe('W09-01 attack: reduce motion flipped while the replay runs', () => {
  it('A8 the wall-clock rate is preserved across a mid-playback flip and at ¼× under reduced motion', async () => {
    const renderer = await renderPlayer();
    await press(renderer, 'form-review-autopause');
    await press(renderer, 'form-review-play');
    await advance(300);
    const atFlip = value(renderer).now;
    expect(atFlip).toBeGreaterThanOrEqual(266);
    expect(atFlip).toBeLessThanOrEqual(334);
    await withReducedMotion(async () => {
      expect(playLabel(renderer)).toBe('Pause replay');
      await advance(600);
      const after = value(renderer).now;
      // 600ms of real time is 600ms of clip time, ± one coarse tick.
      expect(after - atFlip).toBeGreaterThanOrEqual(480);
      expect(after - atFlip).toBeLessThanOrEqual(720);
      expect(playLabel(renderer)).toBe('Pause replay');

      // ¼× under reduced motion: 120ms ticks advance 30ms of clip.
      await press(renderer, 'form-review-play');
      await press(renderer, 'form-review-speed');
      await press(renderer, 'form-review-speed');
      expect(
        byTestId(renderer, 'form-review-speed').props.accessibilityHint,
      ).toContain('¼×');
      const start = value(renderer).now;
      await press(renderer, 'form-review-play');
      await advance(1200);
      expect(value(renderer).now - start).toBe(300);
    });
  });
});

describe('W09-01 attack: VoiceOver seek landing between checkpoints', () => {
  it('A9 "Next checkpoint" after a VoiceOver seek goes to the first checkpoint AHEAD of the playhead', async () => {
    const renderer = await renderPlayer();
    // 6 swipes → 1020ms: inside the prepare span (900–1500) but before its
    // checkpoint at 1200ms.
    for (let i = 0; i < 6; i += 1) await voiceOver(renderer, 'increment');
    expect(value(renderer).now).toBe(1020);
    const ahead = script.stops.find(stop => stop.atMs > 1020)!;
    expect(ahead.atMs).toBe(1200);
    await press(renderer, 'form-review-next-stop');
    expect(value(renderer).now).toBe(ahead.atMs);
  });
});
