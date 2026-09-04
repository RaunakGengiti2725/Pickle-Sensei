/**
 * STRUCTURAL AUDIT #1 (mobile-results-review) — FormReviewPlayer probes.
 *
 * Each test targets a lifecycle / state hotspot the architecture map listed
 * as untested. A failing test here is a finding against 4d812e1a; a passing
 * one is a `verified_ok` entry. No production code is touched.
 *
 *  1. JS clock advances at the scaled rate (½×, ¼×) and finishes exactly at
 *     durationMs (playhead parks on the end, playback stops, visited resets
 *     so the next play restarts the pass).
 *  2. The JS interval never outlives an unmount (no dangling timers).
 *  3. A late native clip error (onError after native progress + an
 *     auto-pause) switches to the JS clock without re-firing visited stops
 *     and without losing the playhead.
 *  4. requestSeek's +0.01 nudge alternates (atMs → atMs+0.01 → atMs) — it
 *     never accumulates across repeated identical seeks.
 *  5. A checkpoint moment inside the final JS tick before durationMs is
 *     auto-paused on like any other stop (probe of advanceTo → finish
 *     ordering in the interval callback).
 */

const mockClip = { nativeAvailable: false };
const mockClipPlayerProps: Record<string, unknown>[] = [];

jest.mock('../../src/components/ClipPlayer', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    clipPlaybackAvailable: () => mockClip.nativeAvailable,
    ClipPlayer: (props: Record<string, unknown>) => {
      mockClipPlayerProps.push(props);
      return ReactActual.createElement(RN.View, { testID: 'clip-player' });
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
import { StyleSheet, Text } from 'react-native';
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

function analysisFixture(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
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
    ...overrides,
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

function fullBodySequence(endMs = 3200): ReviewPoseSequence {
  const frames: ReviewPoseFrame[] = [];
  for (let t = 0; t <= endMs; t += 40) {
    const sweep = t / endMs;
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

const review = { width: 1080, height: 1920, poseSequence: null };

// ─── Harness ────────────────────────────────────────────────────────────────

const mounted: ReactTestRenderer[] = [];

async function renderPlayer(options: {
  analysis?: ShotAnalysis;
  clip?: { uri: string; durationMs: number } | null;
  sequence?: ReviewPoseSequence | null;
}) {
  const analysis = options.analysis ?? analysisFixture();
  const sequence =
    options.sequence === undefined ? fullBodySequence() : options.sequence;
  const clip =
    options.clip === undefined
      ? { uri: 'file:///captures/clip.mov', durationMs: 3400 }
      : options.clip;
  const script = buildFormReviewScript(analysis, sequence);
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

async function press(renderer: ReactTestRenderer, testID: string) {
  const node = byTestId(renderer, testID);
  await act(async () => {
    node.props.onPress();
  });
}

function playLabel(renderer: ReactTestRenderer): string {
  return byTestId(renderer, 'form-review-play').props.accessibilityLabel;
}

function stageLabel(renderer: ReactTestRenderer): string {
  return byTestId(renderer, 'form-review-stage').props.accessibilityLabel;
}

function latestClipProps(): Record<string, unknown> {
  const props = mockClipPlayerProps[mockClipPlayerProps.length - 1];
  if (!props) throw new Error('ClipPlayer was never rendered');
  return props;
}

async function nativeProgress(ms: number) {
  const onProgress = latestClipProps().onProgress as (ms: number) => void;
  await act(async () => {
    onProgress(ms);
  });
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockClip.nativeAvailable = false;
  mockClipPlayerProps.length = 0;
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  jest.useRealTimers();
});

// ─── 1. JS clock: rate scaling and finish() ─────────────────────────────────

describe('JS clock (no native player)', () => {
  it('advances at the scaled rate: ½× covers half the wall time, ¼× a quarter', async () => {
    const { renderer } = await renderPlayer({});
    // AUTO off so nothing freezes the pass mid-measurement.
    await press(renderer, 'form-review-autopause');

    await press(renderer, 'form-review-play');
    await advance(600);
    // 18 ticks × 33.33ms × 1 = 600ms.
    expect(stageLabel(renderer)).toContain('Replay at 0.60s');
    await press(renderer, 'form-review-play'); // pause

    await press(renderer, 'form-review-speed'); // ½×
    expect(allText(renderer)).toContain('½×');
    await press(renderer, 'form-review-play');
    await advance(600);
    // 18 ticks × 33.33ms × 0.5 = 300ms further → 0.90s.
    expect(stageLabel(renderer)).toContain('Replay at 0.90s');
    await press(renderer, 'form-review-play');

    await press(renderer, 'form-review-speed'); // ¼×
    expect(allText(renderer)).toContain('¼×');
    await press(renderer, 'form-review-play');
    await advance(600);
    // 18 ticks × 33.33ms × 0.25 = 150ms further → 1.05s.
    expect(stageLabel(renderer)).toContain('Replay at 1.05s');
  });

  it('finishes exactly at durationMs, stops, and the next play restarts the pass from 0 with stops re-armed', async () => {
    const { renderer } = await renderPlayer({});
    await press(renderer, 'form-review-autopause'); // AUTO off
    await press(renderer, 'form-review-play');
    // Clip is 3400ms; run well past it.
    await advance(5000);
    expect(playLabel(renderer)).toBe('Play replay');
    expect(stageLabel(renderer)).toContain('Replay at 3.40s');
    // Card shows the last passed stop (recover), not a stale active stop.
    expect(allText(renderer)).toContain('STOP 6 OF 6');

    // AUTO back on, play again: playhead resets to 0 and the FIRST stop
    // (ready @450ms) fires — visited was cleared by finish().
    await press(renderer, 'form-review-autopause');
    await press(renderer, 'form-review-play');
    expect(playLabel(renderer)).toBe('Pause replay');
    await advance(700);
    expect(playLabel(renderer)).toBe('Play replay');
    expect(stageLabel(renderer)).toContain('Replay at 0.45s');
    expect(allText(renderer)).toContain('STOP 1 OF 6');
  });

  it('clears its interval on unmount — every setInterval the player armed is cleared', async () => {
    const setSpy = jest.spyOn(globalThis, 'setInterval');
    const clearSpy = jest.spyOn(globalThis, 'clearInterval');
    try {
      const { renderer } = await renderPlayer({});
      await press(renderer, 'form-review-play');
      await advance(100);
      expect(setSpy.mock.results.length).toBeGreaterThan(0);
      await act(async () => {
        renderer.unmount();
      });
      mounted.splice(mounted.indexOf(renderer), 1);
      const armed: unknown[] = setSpy.mock.results.map(
        (r: { value: unknown }) => r.value,
      );
      const cleared: unknown[] = clearSpy.mock.calls.map(
        (c: readonly unknown[]) => c[0],
      );
      for (const id of armed) expect(cleared).toContain(id);
      // Nothing keeps ticking after unmount.
      const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
      await advance(1000);
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it('pose-only replay (clip null): the time base is the measured extent + 250ms pad and every stop is reachable', async () => {
    const { renderer, script } = await renderPlayer({ clip: null });
    await press(renderer, 'form-review-autopause'); // AUTO off
    await press(renderer, 'form-review-play');
    await advance(6000);
    // endMs 3200 + EXTENT_PAD_MS 250 = 3450.
    expect(stageLabel(renderer)).toContain('Replay at 3.45s');
    expect(playLabel(renderer)).toBe('Play replay');
    for (const stop of script.stops) expect(stop.atMs).toBeLessThan(3450);
  });
});

// ─── 3. Late native clip error → JS clock handover ──────────────────────────

describe('native → JS handover on a late clip error', () => {
  it('keeps the playhead and the visited set; the JS clock resumes from where native stopped', async () => {
    mockClip.nativeAvailable = true;
    const { renderer } = await renderPlayer({});
    const clipHosts = () =>
      renderer.root.findAll(
        n => typeof n.type === 'string' && n.props.testID === 'clip-player',
      );
    expect(clipHosts()).toHaveLength(1);

    // Native drives: play, progress crosses the ready stop (450ms) → pause.
    await press(renderer, 'form-review-play');
    await nativeProgress(300);
    await nativeProgress(500);
    expect(playLabel(renderer)).toBe('Play replay');
    expect(stageLabel(renderer)).toContain('Replay at 0.45s');
    expect(allText(renderer)).toContain('STOP 1 OF 6');

    // Resume; native reaches 900ms, then the file turns unreadable.
    await press(renderer, 'form-review-play');
    await nativeProgress(900);
    expect(stageLabel(renderer)).toContain('Replay at 0.90s');
    const onError = latestClipProps().onError as () => void;
    await act(async () => {
      onError();
    });
    // Native layer is gone, honest caption shown, still "playing".
    expect(clipHosts()).toHaveLength(0);
    expect(allText(renderer)).toContain(
      'The clip file is gone from this device; the measured pose is shown instead.',
    );
    expect(playLabel(renderer)).toBe('Pause replay');

    // JS clock takes over from 900ms: the prepare stop (1200ms) fires once;
    // the ready stop (already visited) does NOT re-fire.
    await advance(400);
    expect(playLabel(renderer)).toBe('Play replay');
    expect(stageLabel(renderer)).toContain('Replay at 1.20s');
    expect(allText(renderer)).toContain('STOP 2 OF 6');

    // Resume once more → accelerate (1700ms) fires next, nothing earlier.
    await press(renderer, 'form-review-play');
    await advance(600);
    expect(playLabel(renderer)).toBe('Play replay');
    expect(stageLabel(renderer)).toContain('Replay at 1.70s');
    expect(allText(renderer)).toContain('STOP 3 OF 6');
  });

  it('a late native progress event after an auto-pause is ignored (playhead stays on the checkpoint frame)', async () => {
    mockClip.nativeAvailable = true;
    const { renderer } = await renderPlayer({});
    await press(renderer, 'form-review-play');
    await nativeProgress(500); // crosses ready @450 → pause
    expect(stageLabel(renderer)).toContain('Replay at 0.45s');
    await nativeProgress(560); // stale event from the native side
    expect(stageLabel(renderer)).toContain('Replay at 0.45s');
    expect(playLabel(renderer)).toBe('Play replay');
  });

  it('a late native END event after an auto-pause on the last stop is ignored like a late progress event', async () => {
    // JS-level contract probe only: whether AVPlayerItemDidPlayToEndTime can
    // still be delivered after JS flipped `playing` false near the end is
    // Apple-runtime behaviour this Linux suite cannot observe (UNKNOWN).
    mockClip.nativeAvailable = true;
    const analysis = analysisFixture({
      timestamps: { startMs: 0, contactMs: 1915, endMs: 1920 },
      phases: [phase('ready', 0, 900), phase('contact', 1900, 1920, 1915)],
      checkpoints: [
        checkpoint('ready_position', 85, 'green', 'none'),
        checkpoint('contact_position', 48, 'red', 'late'),
      ],
    });
    const { renderer } = await renderPlayer({
      analysis,
      clip: { uri: 'file:///captures/clip.mov', durationMs: 1920 },
      sequence: fullBodySequence(1920),
    });
    await press(renderer, 'form-review-play');
    await nativeProgress(500); // ready @450 → pause
    await press(renderer, 'form-review-play');
    await nativeProgress(1918); // contact @1915 → pause (playing=false)
    expect(playLabel(renderer)).toBe('Play replay');
    expect(allText(renderer)).toContain('STOP 2 OF 2');
    const onEnd = latestClipProps().onEnd as () => void;
    await act(async () => {
      onEnd();
    });
    // Paused on the checkpoint: the frame and the stop selection must stay.
    expect(allText(renderer)).toContain('STOP 2 OF 2');
    expect(timelineKnobLeftPct(renderer)).toBeCloseTo((1915 / 1920) * 100, 3);
  });
});

/** Percentage `left` of the timeline playhead knob (last child of the track). */
function timelineKnobLeftPct(renderer: ReactTestRenderer): number {
  const [timeline] = renderer.root.findAll(
    n =>
      typeof n.type === 'string' && n.props.testID === 'form-review-timeline',
  );
  if (!timeline) throw new Error('timeline host missing');
  const knob = timeline.children[timeline.children.length - 1];
  if (!knob || typeof knob === 'string') throw new Error('playhead missing');
  const knobStyle = StyleSheet.flatten(knob.props.style as never) as {
    left?: string;
  };
  if (knobStyle.left === undefined) throw new Error('playhead has no left');
  return Number.parseFloat(knobStyle.left);
}

// ─── 4. requestSeek nudge ───────────────────────────────────────────────────

describe('requestSeek identical-seek nudge', () => {
  it('alternates atMs → atMs+0.01 → atMs; the offset never accumulates', async () => {
    mockClip.nativeAvailable = true;
    const { renderer } = await renderPlayer({});
    const seeks = () => mockClipPlayerProps.map(p => p.seekMs as number);

    // Jump to stop 2 (prepare @1200), back to 1, forward to 2 again, and
    // again: the seek target for 1200 must never drift past 1200.01.
    await press(renderer, 'form-review-next-stop');
    expect(seeks().at(-1)).toBe(1200);
    await press(renderer, 'form-review-prev-stop');
    expect(seeks().at(-1)).toBe(450);
    await press(renderer, 'form-review-next-stop');
    expect(seeks().at(-1)).toBe(1200);

    // Identical consecutive seek: re-select the same stop through prev→next
    // is not identical; simulate identical via the timeline: jumpTo(1200)
    // twice by pressing next-stop while already at 1200 would move to 1700.
    // Instead drive the same stop twice via scrub events at the same x.
    const [track] = renderer.root.findAll(
      n =>
        n.props.testID === 'form-review-timeline' &&
        typeof n.props.onLayout === 'function',
    );
    if (!track) throw new Error('timeline missing');
    await act(async () => {
      track.props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 340, height: 24 } },
      });
    });
    const grant = track.props.onResponderGrant as (e: unknown) => void;
    const release = track.props.onResponderRelease as () => void;
    const evt = { nativeEvent: { locationX: 170 } }; // 50% → 1700ms
    await act(async () => {
      grant(evt);
      release();
    });
    expect(seeks().at(-1)).toBe(1700);
    await act(async () => {
      grant(evt);
      release();
    });
    expect(seeks().at(-1)).toBeCloseTo(1700.01, 6);
    await act(async () => {
      grant(evt);
      release();
    });
    expect(seeks().at(-1)).toBe(1700);
    await act(async () => {
      grant(evt);
      release();
    });
    expect(seeks().at(-1)).toBeCloseTo(1700.01, 6);
  });
});

// ─── 5. Checkpoint inside the final tick ────────────────────────────────────

describe('auto-pause on a checkpoint inside the final JS tick', () => {
  it('freezes on the stop instead of skipping straight to the end', async () => {
    // Clip ends at 1920ms; the contact stop sits at 1915ms. The JS clock
    // ticks 33.33ms: tick 57 lands at ~1900, tick 58 would be ~1933 ≥ 1920,
    // so the crossing of 1915 happens on the tick that also ends the pass.
    const analysis = analysisFixture({
      timestamps: { startMs: 0, contactMs: 1915, endMs: 1920 },
      phases: [phase('ready', 0, 900), phase('contact', 1900, 1920, 1915)],
      checkpoints: [
        checkpoint('ready_position', 85, 'green', 'none'),
        checkpoint('contact_position', 48, 'red', 'late'),
      ],
    });
    const { renderer, script } = await renderPlayer({
      analysis,
      clip: { uri: 'file:///captures/clip.mov', durationMs: 1920 },
      sequence: fullBodySequence(1920),
    });
    expect(script.stops.map(s => s.atMs)).toEqual([450, 1915]);

    await press(renderer, 'form-review-play');
    await advance(700); // ready @450 → pause
    expect(stageLabel(renderer)).toContain('Replay at 0.45s');
    await press(renderer, 'form-review-play');
    await advance(2000);

    // Expected: paused ON the contact checkpoint (1.92s clock rounding of
    // 1915 → "1.92s" — formatClock uses toFixed(2)), stop card = STOP 2,
    // playback stopped BY the auto-pause (not by finish()).
    expect(playLabel(renderer)).toBe('Play replay');
    expect(allText(renderer)).toContain('STOP 2 OF 2');
    expect(stageLabel(renderer)).toContain('Replay at 1.92s');
    // finish() would have parked the playhead at durationMs (1920) — the
    // stage label cannot distinguish 1915 from 1920 at 2 decimals, so probe
    // the timeline playhead position instead: 1915/1920 vs 1920/1920.
    // The playhead knob is the LAST child of the track (after the band and
    // the stop markers). At 1915/1920 it reads 99.74%; finish() puts it at
    // exactly 100%.
    expect(timelineKnobLeftPct(renderer)).toBeCloseTo((1915 / 1920) * 100, 3);
  });
});
