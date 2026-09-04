/**
 * ADVERSARIAL probes for the XC-UAI-07 fix (Form Review timeline as an
 * adjustable screen-reader control, src/review/FormReviewPlayer.tsx).
 *
 * The player is mounted directly (not through the screen) so the native
 * ClipPlayer contract (onLoad / onProgress / seekMs) can be driven by hand
 * and both replay modes — JS clock and native-driven — are exercised.
 *
 * Run: cd apps/mobile && npx jest --ci __tests__/attack/formReviewTimelineAdjustable.attack.test.tsx
 */
const mockClip = { nativeAvailable: false };

jest.mock('../../src/components/ClipPlayer', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    clipPlaybackAvailable: () => mockClip.nativeAvailable,
    ClipPlayer: (props: Record<string, unknown>) =>
      ReactActual.createElement(RN.View, { testID: 'clip-player', ...props }),
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
import { FormReviewPlayer } from '../../src/review/FormReviewPlayer';
import {
  buildFormReviewScript,
  type ReviewJoint,
  type ReviewPoseFrame,
  type ReviewPoseSequence,
} from '../../src/review/formReviewModel';
import type { StrokeResultClip } from '../../src/components/StrokeResult';

// ─── Fixtures (identical to formReviewScreen.test.tsx) ──────────────────────

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

const sequence = fullBodySequence();
const script = buildFormReviewScript(analysis, sequence);
const review = {
  width: 1080,
  height: 1920,
  poseSequence: null,
} as unknown as import('../../src/components/strokeResultData').StrokeReviewEvidence;

function clipOf(durationMs: number): StrokeResultClip {
  return {
    uri: 'file:///captures/clip.mov',
    durationMs,
    posterUri: 'file:///captures/clip.poster.jpg',
  };
}

// ─── Harness ────────────────────────────────────────────────────────────────

const mounted: ReactTestRenderer[] = [];

async function mount(props: {
  clip: StrokeResultClip | null;
  initialStopPhase?: PhaseKey;
}) {
  const initialStop =
    props.initialStopPhase !== undefined
      ? (script.stops.find(stop => stop.phase === props.initialStopPhase) ??
        null)
      : null;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <FormReviewPlayer
        analysis={analysis}
        clip={props.clip}
        review={review}
        sequence={sequence}
        script={script}
        initialStop={initialStop}
      />,
    );
  });
  mounted.push(renderer);
  return renderer;
}

function host(renderer: ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
  if (!node) throw new Error(`no host with testID ${testID}`);
  return node;
}

function pressable(renderer: ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    node =>
      node.props.testID === testID && typeof node.props.onPress === 'function',
  );
  if (!node) throw new Error(`no pressable with testID ${testID}`);
  return node;
}

function clipPlayer(renderer: ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    node => node.props.testID === 'clip-player',
  );
  if (!node) throw new Error('no clip-player mounted');
  return node;
}

function clockTexts(renderer: ReactTestRenderer): string[] {
  return (
    renderer.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat(3)
      .filter((child): child is string => typeof child === 'string')
      .join(' ')
      .match(/\b\d+\.\d{2}s\b/g) ?? []
  );
}

async function a11y(renderer: ReactTestRenderer, actionName: string) {
  await act(async () => {
    host(renderer, 'form-review-timeline').props.onAccessibilityAction({
      nativeEvent: { actionName },
    });
  });
}

const value = (renderer: ReactTestRenderer) =>
  host(renderer, 'form-review-timeline').props.accessibilityValue as {
    min: number;
    max: number;
    now: number;
    text: string;
  };

beforeEach(() => {
  jest.useFakeTimers();
  mockClip.nativeAvailable = false;
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  jest.useRealTimers();
});

describe('XC-UAI-07 attack: adjustable Form Review timeline', () => {
  test('ordering: two swipes dispatched before React re-renders both apply (no stale playhead)', async () => {
    const renderer = await mount({ clip: clipOf(3400) });
    const timeline = host(renderer, 'form-review-timeline');
    await act(async () => {
      timeline.props.onAccessibilityAction({
        nativeEvent: { actionName: 'increment' },
      });
      timeline.props.onAccessibilityAction({
        nativeEvent: { actionName: 'increment' },
      });
    });
    expect(value(renderer)).toMatchObject({ now: 340, text: '0.34s' });
    expect(clockTexts(renderer)).toContain('0.34s');
  });

  test('fractional duration: 20 increments land exactly on the end, never beyond it, and the value stays inside [min,max]', async () => {
    const renderer = await mount({ clip: clipOf(3333) });
    for (let i = 0; i < 20; i += 1) await a11y(renderer, 'increment');
    expect(value(renderer)).toMatchObject({ min: 0, max: 3333, now: 3333 });
    expect(clockTexts(renderer)).toContain('3.33s');
    await a11y(renderer, 'increment');
    expect(value(renderer).now).toBe(3333);
    for (let i = 0; i < 40; i += 1) {
      await a11y(renderer, 'decrement');
      const v = value(renderer);
      expect(v.now).toBeGreaterThanOrEqual(v.min);
      expect(v.now).toBeLessThanOrEqual(v.max);
    }
    expect(value(renderer).now).toBe(0);
    expect(clockTexts(renderer)).toContain('0.00s');
  });

  test('deep link: opening frozen on the contact stop, a swipe steps from THAT moment', async () => {
    const renderer = await mount({
      clip: clipOf(3400),
      initialStopPhase: 'contact',
    });
    expect(value(renderer)).toMatchObject({ now: 1900, text: '1.90s' });
    await a11y(renderer, 'increment');
    expect(value(renderer)).toMatchObject({ now: 2070, text: '2.07s' });
    expect(clockTexts(renderer)).toContain('2.07s');
    await a11y(renderer, 'decrement');
    await a11y(renderer, 'decrement');
    expect(value(renderer)).toMatchObject({ now: 1730, text: '1.73s' });
  });

  test('pose-only replay (no clip file): the value uses the measured extent as its max and swipes still move the clock', async () => {
    const renderer = await mount({ clip: null });
    // measuredExtentMs = max(3200 …) + 250ms pad.
    expect(value(renderer)).toMatchObject({ min: 0, max: 3450, now: 0 });
    await a11y(renderer, 'increment');
    // 3450 / 20 = 172.5 → the clock reads 0.17s; `now` rounds the same way
    // iOS would speak it, and stays inside the extent.
    expect(clockTexts(renderer)).toContain('0.17s');
    const v = value(renderer);
    expect(v.now).toBeGreaterThan(0);
    expect(v.now).toBeLessThanOrEqual(v.max);
  });

  test('JS clock: after playback runs to the end, a swipe down steps back from the end and play resumes from there (no restart)', async () => {
    const renderer = await mount({ clip: null });
    await act(async () => {
      pressable(renderer, 'form-review-autopause').props.onPress();
    });
    await act(async () => {
      pressable(renderer, 'form-review-play').props.onPress();
    });
    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    expect(value(renderer).now).toBe(3450);
    expect(
      pressable(renderer, 'form-review-play').props.accessibilityLabel,
    ).toBe('Play replay');
    await a11y(renderer, 'decrement');
    expect(clockTexts(renderer)).toContain('3.28s');
    await act(async () => {
      pressable(renderer, 'form-review-play').props.onPress();
    });
    await act(async () => {
      jest.advanceTimersByTime(40);
    });
    // Resumed from 3.28s, not from 0.
    const v = value(renderer);
    expect(v.now).toBeGreaterThan(3277);
  });

  describe('native-driven clip (PickleClipPlayerView present)', () => {
    beforeEach(() => {
      mockClip.nativeAvailable = true;
    });

    test('the swipe forwards a seek to the native player and the step follows the loaded duration', async () => {
      const renderer = await mount({ clip: clipOf(3400) });
      expect(clipPlayer(renderer).props.seekMs).toBe(-1);
      await act(async () => {
        clipPlayer(renderer).props.onLoad(5000);
      });
      expect(value(renderer)).toMatchObject({ max: 5000, now: 0 });
      await a11y(renderer, 'increment');
      expect(value(renderer)).toMatchObject({ now: 250, text: '0.25s' });
      expect(clipPlayer(renderer).props.seekMs).toBe(250);
      expect(clipPlayer(renderer).props.playing).toBe(false);
    });

    test('a swipe while the native clip is playing pauses it, and a late native progress tick cannot drag the playhead away', async () => {
      const renderer = await mount({ clip: clipOf(3400) });
      // Auto-pause off so the progress tick below is not itself a stop.
      await act(async () => {
        pressable(renderer, 'form-review-autopause').props.onPress();
      });
      await act(async () => {
        pressable(renderer, 'form-review-play').props.onPress();
      });
      expect(clipPlayer(renderer).props.playing).toBe(true);
      await act(async () => {
        clipPlayer(renderer).props.onProgress(1000);
      });
      expect(value(renderer).now).toBe(1000);
      await a11y(renderer, 'increment');
      expect(value(renderer).now).toBe(1170);
      expect(clipPlayer(renderer).props.playing).toBe(false);
      expect(clipPlayer(renderer).props.seekMs).toBe(1170);
      // Late progress event from the native side after the pause.
      await act(async () => {
        clipPlayer(renderer).props.onProgress(1033);
      });
      expect(value(renderer).now).toBe(1170);
      expect(clockTexts(renderer)).toContain('1.17s');
    });

    test('INVARIANT PROBE: accessibilityValue.now never exceeds max, and "increment" never moves the playhead BACKWARDS, when the native player reports a shorter clip than the stored metadata', async () => {
      // Stored metadata says 3400ms; the deep link opens on the contact
      // stop (1900ms); the native player then reports the file is 1500ms.
      const renderer = await mount({
        clip: clipOf(3400),
        initialStopPhase: 'contact',
      });
      await act(async () => {
        clipPlayer(renderer).props.onLoad(1500);
      });
      const before = value(renderer);
      expect(before.max).toBe(1500);
      await a11y(renderer, 'increment');
      const after = value(renderer);
      // Swipe UP must never move the playhead backwards.
      expect(after.now).toBeGreaterThanOrEqual(before.now);
      expect(before.now).toBeLessThanOrEqual(before.max);
    });
  });

  test('INVARIANT PROBE: stored clip shorter than the stop it opens on — value.now must not exceed max and swipe-up must not go backwards', async () => {
    const renderer = await mount({
      clip: clipOf(1000),
      initialStopPhase: 'contact',
    });
    const before = value(renderer);
    await a11y(renderer, 'increment');
    // Swipe UP must never move the playhead backwards.
    expect(value(renderer).now).toBeGreaterThanOrEqual(before.now);
    expect(before.now).toBeLessThanOrEqual(before.max);
  });
});
