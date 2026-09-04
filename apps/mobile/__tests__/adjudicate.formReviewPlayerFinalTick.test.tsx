/**
 * ADJUDICATION (mobile-results-review) — FormReviewPlayer: an auto-pause on
 * the last review stop is discarded by finish() when the stop is crossed on
 * the same event that ends the pass.
 *
 * JS clock: the interval callback runs `advanceTo(durationMs)` (which pauses
 * on the stop) and then unconditionally `finish()` (which clears the visited
 * set, parks the playhead at durationMs and clears the active stop).
 * Native: `onEnd={finish}` has no playing guard, so a stale END delivered
 * after JS already paused on the checkpoint is handled the same way. Whether
 * AVFoundation delivers that END is Apple-runtime behaviour (UNKNOWN from
 * Linux); this file pins only the JS contract.
 *
 * Expected on a fixed build: paused ON the checkpoint (STOP 2 OF 2 visible,
 * playhead at 1915/1920), not parked at the end with no stop selected.
 */

const mockClip = { nativeAvailable: false };
const mockClipPlayerProps: Record<string, unknown>[] = [];

jest.mock('../src/components/ClipPlayer', () => {
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
import { FormReviewPlayer } from '../src/review/FormReviewPlayer';
import {
  buildFormReviewScript,
  type ReviewJoint,
  type ReviewPoseFrame,
  type ReviewPoseSequence,
} from '../src/review/formReviewModel';

const CLIP_MS = 1920;
const LAST_STOP_MS = 1915;

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
  score: number,
  band: ScoreBand,
  direction: FaultDirection,
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: (100 - score) / 100,
    applicable: true,
  };
}

/** Two stops: ready @450 and contact @1915 — the latter sits inside the
 * final 33.3 ms JS tick of a 1920 ms clip. */
function analysisFixture(): ShotAnalysis {
  return {
    id: 'analysis-1',
    sessionId: 'set-1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: LAST_STOP_MS, endMs: CLIP_MS },
    phases: [
      phase('ready', 0, 900),
      phase('contact', 1900, CLIP_MS, LAST_STOP_MS),
    ],
    measurements: [],
    checkpoints: [
      checkpoint('ready_position', 85, 'green', 'none'),
      checkpoint('contact_position', 48, 'red', 'late'),
    ],
    overallScore: 6.5,
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

function fullBodySequence(endMs: number): ReviewPoseSequence {
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

const mounted: ReactTestRenderer[] = [];

async function renderPlayer() {
  const analysis = analysisFixture();
  const sequence = fullBodySequence(CLIP_MS);
  const script = buildFormReviewScript(analysis, sequence);
  expect(script.stops.map(s => s.atMs)).toEqual([450, LAST_STOP_MS]);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <FormReviewPlayer
        analysis={analysis}
        clip={{ uri: 'file:///captures/clip.mov', durationMs: CLIP_MS }}
        review={{ width: 1080, height: 1920, poseSequence: null }}
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

function pressable(renderer: ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.testID === testID &&
      typeof candidate.props.onPress === 'function',
  );
  if (!node) throw new Error(`no pressable with testID ${testID}`);
  return node;
}

async function press(renderer: ReactTestRenderer, testID: string) {
  const node = pressable(renderer, testID);
  await act(async () => {
    node.props.onPress();
  });
}

function playLabel(renderer: ReactTestRenderer): string {
  return pressable(renderer, 'form-review-play').props.accessibilityLabel;
}

/** Percentage `left` of the timeline playhead knob (last child of the track). */
function playheadPct(renderer: ReactTestRenderer): number {
  const [timeline] = renderer.root.findAll(
    n =>
      typeof n.type === 'string' && n.props.testID === 'form-review-timeline',
  );
  if (!timeline) throw new Error('timeline host missing');
  const knob = timeline.children[timeline.children.length - 1];
  if (!knob || typeof knob === 'string') throw new Error('playhead missing');
  const style = StyleSheet.flatten(knob.props.style as never) as {
    left?: string;
  };
  if (style.left === undefined) throw new Error('playhead has no left');
  return Number.parseFloat(style.left);
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

const EXPECTED_PCT = (LAST_STOP_MS / CLIP_MS) * 100;

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

describe('FormReviewPlayer — auto-pause on the last stop vs finish()', () => {
  it('JS clock: a checkpoint crossed on the final tick pauses ON the checkpoint, not at the end', async () => {
    const renderer = await renderPlayer();

    await press(renderer, 'form-review-play');
    await advance(700); // ready @450 → auto-pause
    expect(playLabel(renderer)).toBe('Play replay');
    expect(allText(renderer)).toContain('STOP 1 OF 2');

    await press(renderer, 'form-review-play');
    await advance(2000); // crosses contact @1915 on the tick that reaches 1920

    expect(playLabel(renderer)).toBe('Play replay');
    expect(allText(renderer)).toContain('STOP 2 OF 2');
    expect(playheadPct(renderer)).toBeCloseTo(EXPECTED_PCT, 3);
  });

  it('JS clock: after the final-tick auto-pause, play resumes from the checkpoint instead of restarting the pass', async () => {
    const renderer = await renderPlayer();
    await press(renderer, 'form-review-play');
    await advance(700);
    await press(renderer, 'form-review-play');
    await advance(2000);

    // Resuming from the paused checkpoint must NOT re-fire the already
    // visited ready stop (finish() clears the visited set → it would).
    await press(renderer, 'form-review-play');
    await advance(700);
    expect(allText(renderer)).not.toContain('STOP 1 OF 2');
  });

  it('native: a stale END delivered after JS paused on the last stop is ignored like a stale progress event', async () => {
    mockClip.nativeAvailable = true;
    const renderer = await renderPlayer();

    await press(renderer, 'form-review-play');
    await nativeProgress(500); // ready @450 → auto-pause
    await press(renderer, 'form-review-play');
    await nativeProgress(1918); // contact @1915 → auto-pause (playing=false)
    expect(playLabel(renderer)).toBe('Play replay');
    expect(allText(renderer)).toContain('STOP 2 OF 2');

    // Late progress while paused is already ignored by advanceTo's guard.
    await nativeProgress(1920);
    expect(playheadPct(renderer)).toBeCloseTo(EXPECTED_PCT, 3);

    const onEnd = latestClipProps().onEnd as () => void;
    await act(async () => {
      onEnd();
    });
    expect(allText(renderer)).toContain('STOP 2 OF 2');
    expect(playheadPct(renderer)).toBeCloseTo(EXPECTED_PCT, 3);
  });
});
