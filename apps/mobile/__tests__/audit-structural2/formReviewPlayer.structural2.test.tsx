/**
 * Structural audit #2 (mobile-results-review) — FormReviewPlayer probes.
 *
 * The player is mounted DIRECTLY (not through a screen) with a controllable
 * fake native clip layer so the audit can drive the exact timing paths the
 * mapper flagged as unverified:
 *   - JS-clock advance at ½× / ¼× and finish() at durationMs,
 *   - the +0.01 identical-seek nudge (must alternate, never accumulate),
 *   - a LATE native clip error after native auto-pause bookkeeping
 *     (visited set / playhead continuity when the JS clock takes over),
 *   - non-finite native progress (null/NaN assumption on the native edge).
 * New test file only; production code is untouched.
 */
let mockNativeAvailable = false;
const mockClipProps: Array<Record<string, unknown>> = [];
jest.mock('../../src/components/ClipPlayer', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    clipPlaybackAvailable: () => mockNativeAvailable,
    ClipPlayer: (props: Record<string, unknown>) => {
      mockClipProps.push(props);
      return React.createElement(View, { testID: 'fake-clip-player' });
    },
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

// ─── Fixtures (same shapes as formReviewScreen.test.tsx) ────────────────────

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
    frames.push(
      frameAt(t, {
        head: { x: 0.5, y: 0.18 },
        left_shoulder: { x: 0.45, y: 0.3 },
        right_shoulder: { x: 0.55, y: 0.3 },
        left_elbow: { x: 0.4, y: 0.42 },
        right_elbow: { x: 0.62, y: 0.42 },
        left_wrist: { x: 0.38, y: 0.52 },
        right_wrist: { x: 0.5, y: 0.5 },
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

const clip = { uri: 'file:///captures/clip.mov', durationMs: 3400 };
const review = { width: 1080, height: 1920, poseSequence: null };

// ─── Harness ────────────────────────────────────────────────────────────────

const mounted: ReactTestRenderer[] = [];

function mount(props: Partial<React.ComponentProps<typeof FormReviewPlayer>>) {
  const sequence =
    props.sequence === undefined ? fullBodySequence() : props.sequence;
  const script = buildFormReviewScript(analysis, sequence);
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <FormReviewPlayer
        analysis={analysis}
        clip={props.clip === undefined ? null : props.clip}
        review={review}
        sequence={sequence}
        script={script}
        {...(props.initialStop !== undefined
          ? { initialStop: props.initialStop }
          : {})}
      />,
    );
  });
  mounted.push(renderer);
  return { renderer, script };
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

function press(renderer: ReactTestRenderer, testID: string) {
  act(() => {
    byTestId(renderer, testID).props.onPress();
  });
}

function playLabel(renderer: ReactTestRenderer): string {
  return String(
    byTestId(renderer, 'form-review-play').props.accessibilityLabel,
  );
}

function lastClipProps(): Record<string, unknown> {
  const props = mockClipProps[mockClipProps.length - 1];
  if (!props) throw new Error('ClipPlayer never rendered');
  return props;
}

function nativeProgress(positionMs: number) {
  act(() => {
    (lastClipProps().onProgress as (ms: number) => void)(positionMs);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockNativeAvailable = false;
  mockClipProps.length = 0;
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount());
  }
  jest.useRealTimers();
});

// ─── JS clock (pose-only / no native player) ────────────────────────────────

describe('JS clock replay', () => {
  it('advances at rate × real time: ½× covers ~half the ms, ¼× a quarter', () => {
    const { renderer } = mount({ clip: null });
    press(renderer, 'form-review-autopause'); // off, so nothing freezes
    press(renderer, 'form-review-speed'); // ½×
    expect(allText(renderer)).toContain('½×');
    press(renderer, 'form-review-play');
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    // 30 ticks × 33.33ms × 0.5 ≈ 500ms.
    const halfText = allText(renderer);
    expect(halfText).toMatch(/0\.(4[5-9]|5[0-5])s/);

    press(renderer, 'form-review-play'); // pause
    press(renderer, 'form-review-speed'); // ¼×
    expect(allText(renderer)).toContain('¼×');
    press(renderer, 'form-review-play');
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    // +≈250ms → ≈0.75s
    expect(allText(renderer)).toMatch(/0\.(7[0-9]|8[0-2])s/);
  });

  it('finish(): the clock stops exactly on durationMs, playback ends, and a replay restarts from 0', () => {
    const { renderer } = mount({ clip: null });
    press(renderer, 'form-review-autopause');
    press(renderer, 'form-review-play');
    // Pose-only extent = max(end, phases, stops, last frame) + 250 = 3450.
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(playLabel(renderer)).toBe('Play replay');
    expect(allText(renderer)).toContain('3.45s');
    // The timer no longer runs once finished.
    const before = allText(renderer);
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(allText(renderer)).toBe(before);
    // Replay: restarts from 0 and plays.
    press(renderer, 'form-review-play');
    expect(playLabel(renderer)).toBe('Pause replay');
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(allText(renderer)).toMatch(/0\.(0[6-9]|1[0-3])s/);
  });

  it('auto-pause after finish(): every stop fires again on the next pass', () => {
    const { renderer } = mount({ clip: null });
    press(renderer, 'form-review-play');
    act(() => {
      jest.advanceTimersByTime(700);
    });
    expect(allText(renderer)).toContain('0.45s');
    press(renderer, 'form-review-autopause'); // off → run to the end
    press(renderer, 'form-review-play');
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(playLabel(renderer)).toBe('Play replay');
    press(renderer, 'form-review-autopause'); // on again
    press(renderer, 'form-review-play'); // restarts from 0
    act(() => {
      jest.advanceTimersByTime(700);
    });
    expect(allText(renderer)).toContain('0.45s');
    expect(playLabel(renderer)).toBe('Play replay');
  });
});

// ─── Native clip layer ──────────────────────────────────────────────────────

describe('native clip layer', () => {
  it('identical-seek nudge alternates between atMs and atMs+0.01 and never accumulates', () => {
    mockNativeAvailable = true;
    const { renderer } = mount({ clip });
    press(renderer, 'form-review-autopause');
    // Play to the end, replay from 0, repeatedly: every replay requests the
    // SAME seek (0), which is exactly the identical-seek case.
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      press(renderer, 'form-review-play');
      if (i > 0) seen.push(lastClipProps().seekMs as number);
      act(() => {
        (lastClipProps().onEnd as () => void)();
      });
    }
    expect(seen).toHaveLength(5);
    for (const value of seen) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0.011);
    }
    // Consecutive requests always differ numerically (the native view would
    // otherwise ignore the repeat).
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).not.toBe(seen[i - 1]);
    }
  });

  it('late clip error after native auto-pause hands over to the JS clock without re-firing visited stops or losing the playhead', () => {
    mockNativeAvailable = true;
    const { renderer } = mount({ clip });
    press(renderer, 'form-review-play');
    // Native progress crosses the first stop (ready @450) → auto-pause.
    nativeProgress(300);
    nativeProgress(500);
    expect(playLabel(renderer)).toBe('Play replay');
    expect(allText(renderer)).toContain('0.45s');
    expect(allText(renderer)).toContain('STOP 1 OF 6');

    // Resume natively, then the decoder dies at 1000ms.
    press(renderer, 'form-review-play');
    nativeProgress(1000);
    expect(allText(renderer)).toContain('1.00s');
    act(() => {
      (lastClipProps().onError as (m: string) => void)('decoder failed');
    });
    // The clip layer is gone; the honest caption appears; the replay is still
    // playing on the JS clock from where the native player stopped.
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          node.props.testID === 'fake-clip-player',
      ),
    ).toHaveLength(0);
    expect(allText(renderer)).toContain(
      'The clip file is gone from this device; the measured pose is shown instead.',
    );
    expect(playLabel(renderer)).toBe('Pause replay');
    act(() => {
      jest.advanceTimersByTime(400);
    });
    // Stop 2 (prepare @1200) fires; stop 1 is NOT re-fired; the clock kept
    // running from ~1000 (no snap back to 0).
    expect(allText(renderer)).toContain('1.20s');
    expect(allText(renderer)).toContain('STOP 2 OF 6');
    expect(playLabel(renderer)).toBe('Play replay');
  });

  it('onLoad with a different native duration re-bases the timeline; onEnd finishes at that duration', () => {
    mockNativeAvailable = true;
    const { renderer } = mount({ clip });
    act(() => {
      (lastClipProps().onLoad as (ms: number) => void)(4000);
    });
    press(renderer, 'form-review-autopause');
    press(renderer, 'form-review-play');
    nativeProgress(3900);
    act(() => {
      (lastClipProps().onEnd as () => void)();
    });
    expect(playLabel(renderer)).toBe('Play replay');
    expect(allText(renderer)).toContain('4.00s');
  });

  it('PROBE: a non-finite native progress position does not corrupt the visible clock', () => {
    mockNativeAvailable = true;
    const { renderer } = mount({ clip });
    press(renderer, 'form-review-autopause');
    press(renderer, 'form-review-play');
    nativeProgress(800);
    expect(allText(renderer)).toContain('0.80s');
    nativeProgress(Number.NaN);
    const text = allText(renderer);
    expect(text).not.toContain('NaN');
    // The last finite position (or a sane value) should remain visible.
    expect(text).toContain('0.80s');
  });

  it('PROBE: one non-finite native progress event must not make the next stop crossing skip its auto-pause', () => {
    mockNativeAvailable = true;
    const { renderer } = mount({ clip });
    press(renderer, 'form-review-play');
    nativeProgress(300);
    nativeProgress(Number.NaN);
    // The very next finite tick crosses the ready stop (450ms).
    nativeProgress(600);
    expect(playLabel(renderer)).toBe('Play replay');
    expect(allText(renderer)).toContain('0.45s');
  });
});
