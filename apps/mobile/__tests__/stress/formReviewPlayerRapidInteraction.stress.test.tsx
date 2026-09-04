/**
 * STRESS · rapid-interaction · FormReviewPlayer (+ FormReviewOverlay).
 *
 * A seeded generator scripts interaction BURSTS against the mounted replay
 * — double/triple taps on play and on the stage, spam on prev/next, taps
 * while the JS clock or the native player is mid-transition, simultaneous
 * controls in one frame, scrubs that never release, late native progress
 * events after a pause, duration changes mid-play, the clip failing under a
 * running replay, re-renders and unmounts with timers pending — and checks
 * after EVERY action that the rendered player still agrees with an
 * independent oracle built from the pure geometry helpers:
 *
 *   · one side effect per intent: k play taps flip playback k times, k
 *     next/prev taps move one stop per re-rendered frame, k speed taps
 *     cycle k steps, k AUTO taps flip the switch k times
 *   · one seek request per jump reaches the native player
 *   · auto-pause fires at most once per stop per pass, never while paused,
 *     never after a late progress event
 *   · no duplicate surfaces (one stop card, one timeline, one transport
 *     row, one highlighted marker, at most one arrow label)
 *   · no orphan clock: a paused replay does not move when timers advance;
 *     an unmounted replay leaves no console noise when timers advance
 *   · no console.error / console.warn (act() warnings, key warnings) and no
 *     unhandled promise rejections during any burst
 *
 * Replay one seed:  STRESS_SEED=<n> npx jest --ci stress/formReviewPlayer
 * Longer campaign:  STRESS_ITER=400 npx jest --ci stress/formReviewPlayer
 * Re-run a seed:    STRESS_SEED=<n> STRESS_REPEAT=10 npx jest --ci stress/formReviewPlayer
 * Results:          $STRESS_OUT (default <repo>/artifacts/stress/) as JSON,
 *                   one row per seed → outcome.
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

interface MockClipProps {
  playing: boolean;
  seekMs: number;
  rate?: number;
  onProgress?: (positionMs: number) => void;
  onLoad?: (durationMs: number) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
}

let mockNativeAvailable = false;
let mockClipProps: MockClipProps | null = null;
/** Read through a function so control-flow narrowing of the module-level
 *  binding does not collapse the props type at the call sites. */
const clipProps = (): MockClipProps | null => mockClipProps;
jest.mock('../../src/components/ClipPlayer', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    clipPlaybackAvailable: () => mockNativeAvailable,
    ClipPlayer: (props: MockClipProps) => {
      mockClipProps = props;
      return React.createElement(View, { testID: 'mock-clip-player' });
    },
  };
});

import fs from 'fs';
import path from 'path';
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
import { color } from '../../src/design/tokens';
import { FormReviewPlayer } from '../../src/review/FormReviewPlayer';
import {
  REVIEW_SPEEDS,
  currentStop,
  nextAutoPause,
  speedLabel,
} from '../../src/review/formReviewGeometry';
import {
  buildFormReviewScript,
  type FormReviewScript,
  type ReviewJoint,
  type ReviewPoseFrame,
  type ReviewPoseSequence,
  type ReviewStop,
} from '../../src/review/formReviewModel';

// ─── Campaign knobs ─────────────────────────────────────────────────────────

const ITERATIONS = Math.max(1, Number(process.env.STRESS_ITER ?? 60) || 60);
const ONLY_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number(process.env.STRESS_SEED)
    : null;
const REPEAT = Math.max(1, Number(process.env.STRESS_REPEAT ?? 1) || 1);
const SEED_BASE = 0x5eed_0001;
const OUT_DIR =
  process.env.STRESS_OUT ??
  path.resolve(__dirname, '..', '..', '..', '..', 'artifacts', 'stress');

const TICK_MS = 1000 / 30;
const END_TOLERANCE_MS = 30;

// ─── Seeded RNG (mulberry32) ────────────────────────────────────────────────

function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
    pick: <T,>(items: readonly T[]): T => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick from empty list');
      return item;
    },
  };
}

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

const SIX_PHASES: PhaseSpan[] = [
  phase('ready', 0, 900),
  phase('prepare', 900, 1500),
  phase('accelerate', 1500, 1900),
  phase('contact', 1880, 1920, 1900),
  phase('follow_through', 1920, 2400),
  phase('recover', 2400, 3200),
];

function analysisFixture(phases: PhaseSpan[]): ShotAnalysis {
  return {
    id: 'analysis-stress',
    sessionId: 'set-1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases,
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

const CLIP = {
  uri: 'file:///captures/clip.mov',
  durationMs: 3400,
  posterUri: 'file:///captures/clip.poster.jpg',
};
const REVIEW = { width: 1080, height: 1920, poseSequence: null };

// ─── Scenario vocabulary ────────────────────────────────────────────────────

type Target = 'play' | 'stage' | 'next' | 'prev' | 'speed' | 'auto';
const TARGETS: readonly Target[] = [
  'play',
  'stage',
  'next',
  'prev',
  'speed',
  'auto',
];

type Action =
  | { kind: 'tap'; target: Target; count: number; sameFrame: boolean }
  | { kind: 'combo'; targets: Target[] }
  | { kind: 'scrub'; ratio: number; release: boolean }
  | { kind: 'release' }
  | { kind: 'tick'; ticks: number }
  | { kind: 'run'; ticks: number }
  | { kind: 'progress'; ms: number }
  | { kind: 'load'; durationMs: number }
  | { kind: 'end' }
  | { kind: 'error' }
  | { kind: 'rerender' };

interface Scenario {
  seed: number;
  mode: 'js' | 'native';
  stops: 'six' | 'one';
  initialStopIndex: number | null;
  actions: Action[];
}

function generate(seed: number): Scenario {
  const rng = makeRng(seed);
  const mode = rng.chance(0.5) ? 'native' : 'js';
  const stops = rng.chance(0.15) ? 'one' : 'six';
  const initialStopIndex = rng.chance(0.3)
    ? rng.int(stops === 'six' ? 6 : 1)
    : null;
  const length = 8 + rng.int(10);
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) {
    const roll = rng.next();
    if (roll < 0.36) {
      actions.push({
        kind: 'tap',
        target: rng.pick(TARGETS),
        count: rng.pick([1, 2, 2, 3, 3, 5]),
        sameFrame: rng.chance(0.4),
      });
    } else if (roll < 0.44) {
      const size = 2 + rng.int(2);
      const targets: Target[] = [];
      for (let k = 0; k < size; k += 1) targets.push(rng.pick(TARGETS));
      actions.push({ kind: 'combo', targets });
    } else if (roll < 0.54) {
      actions.push({
        kind: 'scrub',
        ratio: rng.pick([0, 0.01, 0.27, 0.5, 0.55, 0.99, 1, rng.next()]),
        release: rng.chance(0.7),
      });
    } else if (roll < 0.58) {
      actions.push({ kind: 'release' });
    } else if (roll < 0.7) {
      actions.push({
        kind: 'tick',
        ticks: rng.pick([1, 1, 2, 5, 12, 30, 60, 130]),
      });
    } else if (roll < 0.78) {
      actions.push({ kind: 'run', ticks: rng.pick([3, 9, 20, 40, 75, 140]) });
    } else if (roll < 0.86) {
      actions.push({ kind: 'progress', ms: Math.round(rng.next() * 3600) });
    } else if (roll < 0.9) {
      actions.push({
        kind: 'load',
        durationMs: rng.pick([2400, 3400, 5000, 0]),
      });
    } else if (roll < 0.93) {
      actions.push({ kind: 'end' });
    } else if (roll < 0.96) {
      actions.push({ kind: 'error' });
    } else {
      actions.push({ kind: 'rerender' });
    }
  }
  return { seed, mode, stops, initialStopIndex, actions };
}

// ─── Rendered-state readers ─────────────────────────────────────────────────

function flatStyle(node: { props: { style?: unknown } }) {
  return (StyleSheet.flatten(node.props.style as never) ?? {}) as Record<
    string,
    unknown
  >;
}

function pressables(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node =>
      node.props.testID === testID && typeof node.props.onPress === 'function',
  );
}

function hosts(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

/** The `Pressable` composite carrying the control (PressableScale forwards
 * the testID to it, so the press-in/out animations fire too); exactly one
 * host view may render it. */
function pressable(renderer: ReactTestRenderer, testID: string) {
  const rendered = hosts(renderer, testID).length;
  if (rendered !== 1) {
    throw new Error(`expected 1 rendered ${testID}, found ${rendered}`);
  }
  const nodes = pressables(renderer, testID);
  const node =
    nodes.find(candidate => typeof candidate.props.onPressIn === 'function') ??
    nodes[0];
  if (!node) throw new Error(`no pressable ${testID}`);
  return node;
}

function textOf(node: {
  findAllByType: ReactTestRenderer['root']['findAllByType'];
}) {
  return node
    .findAllByType(Text)
    .map(text => text.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ');
}

interface Observed {
  playing: boolean;
  stageHint: string;
  clockMs: number;
  stopIndex: number;
  stopCount: number;
  speed: string;
  autoPause: boolean;
  prevDisabled: boolean;
  nextDisabled: boolean;
  highlightedMarkers: number;
  arrowLabels: number;
  clipPlayers: number;
  caption: boolean;
}

function observe(renderer: ReactTestRenderer): Observed {
  const play = pressable(renderer, 'form-review-play');
  const stage = pressable(renderer, 'form-review-stage');
  const speed = pressable(renderer, 'form-review-speed');
  const auto = pressable(renderer, 'form-review-autopause');
  const prev = pressable(renderer, 'form-review-prev-stop');
  const next = pressable(renderer, 'form-review-next-stop');
  const allText = textOf(renderer.root);
  const clock = allText.match(/(\d+\.\d\d)s/g);
  if (!clock || clock.length !== 1) {
    throw new Error(
      `expected exactly one clock, found ${JSON.stringify(clock)}`,
    );
  }
  const counter = allText.match(/STOP (\d+) OF (\d+)/g);
  if (!counter || counter.length !== 1) {
    throw new Error(
      `expected exactly one stop counter, found ${JSON.stringify(counter)}`,
    );
  }
  const [, index, count] = /STOP (\d+) OF (\d+)/.exec(counter[0]!)!;
  const markers = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      flatStyle(node).borderWidth === 1.5 &&
      flatStyle(node).borderColor === color.onDark,
  );
  return {
    playing: play.props.accessibilityLabel === 'Pause replay',
    stageHint: String(stage.props.accessibilityHint),
    clockMs: Math.round(Number.parseFloat(clock[0]!) * 1000),
    stopIndex: Number(index) - 1,
    stopCount: Number(count),
    speed: textOf(speed),
    autoPause: auto.props.accessibilityState?.checked === true,
    prevDisabled: prev.props.disabled === true,
    nextDisabled: next.props.disabled === true,
    highlightedMarkers: markers.length,
    arrowLabels: hosts(renderer, 'form-review-arrow-label').length,
    clipPlayers: hosts(renderer, 'mock-clip-player').length,
    caption: allText.includes('The clip file is gone from this device'),
  };
}

// ─── Independent oracle ─────────────────────────────────────────────────────

interface Oracle {
  native: boolean;
  playing: boolean;
  playheadMs: number;
  durationMs: number;
  speedIndex: number;
  autoPause: boolean;
  activeStopId: string | null;
  visited: Set<string>;
  scrubbing: boolean;
  autoPauses: string[];
  seeks: number;
}

function expectedStopIndex(stops: readonly ReviewStop[], oracle: Oracle) {
  const shown =
    (oracle.activeStopId !== null
      ? stops.find(stop => stop.id === oracle.activeStopId)
      : undefined) ?? currentStop(stops, oracle.playheadMs);
  return shown ? stops.findIndex(stop => stop.id === shown.id) : -1;
}

function oracleJump(
  oracle: Oracle,
  stops: readonly ReviewStop[],
  ms: number,
  stopId: string | null,
) {
  oracle.playing = false;
  oracle.visited = new Set(
    stops.filter(stop => stop.atMs <= ms).map(stop => stop.id),
  );
  oracle.playheadMs = ms;
  oracle.activeStopId = stopId;
  oracle.seeks += 1;
}

function oracleFinish(oracle: Oracle) {
  oracle.playing = false;
  oracle.visited.clear();
  oracle.playheadMs = oracle.durationMs;
  oracle.activeStopId = null;
}

/** One progress tick: move, then auto-pause exactly like the contract says. */
function oracleAdvance(
  oracle: Oracle,
  stops: readonly ReviewStop[],
  positionMs: number,
) {
  if (!oracle.playing) return;
  const previous = oracle.playheadMs;
  oracle.playheadMs = positionMs;
  if (!oracle.autoPause || oracle.scrubbing) return;
  const stop = nextAutoPause(stops, previous, positionMs, oracle.visited);
  if (stop) {
    if (oracle.visited.has(stop.id)) {
      throw new Error(`oracle: auto-pause on already visited ${stop.id}`);
    }
    oracle.visited.add(stop.id);
    oracle.playing = false;
    oracle.playheadMs = stop.atMs;
    oracle.activeStopId = stop.id;
    oracle.autoPauses.push(stop.id);
    oracle.seeks += 1;
  }
}

function oracleTogglePlay(oracle: Oracle) {
  if (oracle.playing) {
    oracle.playing = false;
    return;
  }
  if (oracle.playheadMs >= oracle.durationMs - END_TOLERANCE_MS) {
    oracle.visited.clear();
    oracle.playheadMs = 0;
    oracle.seeks += 1;
  }
  oracle.activeStopId = null;
  oracle.playing = true;
}

function oracleJsTick(oracle: Oracle, stops: readonly ReviewStop[]) {
  if (oracle.native || !oracle.playing) return;
  const rate = REVIEW_SPEEDS[oracle.speedIndex] ?? 1;
  const next = oracle.playheadMs + TICK_MS * rate;
  if (next >= oracle.durationMs) {
    oracleAdvance(oracle, stops, oracle.durationMs);
    oracleFinish(oracle);
    return;
  }
  oracleAdvance(oracle, stops, next);
}

// ─── Harness ────────────────────────────────────────────────────────────────

const consoleNoise: string[] = [];
const rejections: string[] = [];
let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
const onRejection = (reason: unknown) => {
  rejections.push(String(reason));
};

interface Row {
  seed: number;
  mode: Scenario['mode'];
  stops: Scenario['stops'];
  initialStopIndex: number | null;
  actions: number;
  actionsRun: number;
  autoPauses: number;
  clockFires: number;
  timersAfterUnmount: number;
  timersAfterDrain: number;
  outcome: 'HELD' | 'BROKEN';
  failedAt: string | null;
  detail: string | null;
}

const rows: Row[] = [];
const mounted: ReactTestRenderer[] = [];

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'tap':
      return `tap ${action.target}×${action.count}${action.sameFrame ? ' same-frame' : ''}`;
    case 'combo':
      return `combo ${action.targets.join('+')}`;
    case 'scrub':
      return `scrub ${action.ratio.toFixed(3)}${action.release ? '' : ' (held)'}`;
    case 'release':
      return 'release';
    case 'tick':
      return `tick×${action.ticks}`;
    case 'run':
      return `run×${action.ticks}`;
    case 'progress':
      return `progress ${action.ms}`;
    case 'load':
      return `load ${action.durationMs}`;
    case 'end':
      return 'end';
    case 'error':
      return 'error';
    case 'rerender':
      return 'rerender';
  }
}

function controlId(target: Target): string {
  return {
    play: 'form-review-play',
    stage: 'form-review-stage',
    next: 'form-review-next-stop',
    prev: 'form-review-prev-stop',
    speed: 'form-review-speed',
    auto: 'form-review-autopause',
  }[target];
}

/** A platform-faithful tap: a disabled Pressable never fires onPress. */
function tap(renderer: ReactTestRenderer, target: Target): boolean {
  const node = pressable(renderer, controlId(target));
  if (node.props.disabled === true) return false;
  node.props.onPressIn?.({ nativeEvent: {} });
  node.props.onPress();
  node.props.onPressOut?.({ nativeEvent: {} });
  return true;
}

function applyTapToOracle(
  oracle: Oracle,
  stops: readonly ReviewStop[],
  target: Target,
  stopIndexAtRender: number,
) {
  switch (target) {
    case 'play':
    case 'stage':
      oracleTogglePlay(oracle);
      return;
    case 'next': {
      const stop = stops[stopIndexAtRender + 1];
      if (stop) oracleJump(oracle, stops, stop.atMs, stop.id);
      return;
    }
    case 'prev': {
      const stop =
        stopIndexAtRender > 0 ? stops[stopIndexAtRender - 1] : undefined;
      if (stop) oracleJump(oracle, stops, stop.atMs, stop.id);
      return;
    }
    case 'speed':
      oracle.speedIndex = (oracle.speedIndex + 1) % REVIEW_SPEEDS.length;
      return;
    case 'auto':
      oracle.autoPause = !oracle.autoPause;
      return;
  }
}

function timeline(renderer: ReactTestRenderer) {
  const nodes = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.testID === 'form-review-timeline' &&
      typeof node.props.onResponderGrant === 'function',
  );
  if (nodes.length !== 1)
    throw new Error(`expected 1 timeline, found ${nodes.length}`);
  return nodes[0]!;
}

async function layout(renderer: ReactTestRenderer) {
  const [stage] = renderer.root.findAll(
    node =>
      node.props.testID === 'form-review-stage' &&
      typeof node.props.onLayout === 'function',
  );
  await act(async () => {
    stage!.props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 420 } },
    });
    timeline(renderer).props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 32 } },
    });
  });
}

function assertConsistent(
  observed: Observed,
  oracle: Oracle,
  stops: readonly ReviewStop[],
  where: string,
) {
  const problems: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };
  check(
    observed.playing === oracle.playing,
    `playing ${observed.playing} ≠ oracle ${oracle.playing}`,
  );
  check(
    observed.stageHint ===
      (oracle.playing ? 'Pauses the replay' : 'Plays the replay'),
    `stage hint "${observed.stageHint}" disagrees with playing=${oracle.playing}`,
  );
  check(
    Math.abs(observed.clockMs - oracle.playheadMs) <= 10,
    `clock ${observed.clockMs} ≠ oracle playhead ${oracle.playheadMs.toFixed(2)}`,
  );
  check(observed.clockMs >= 0, `clock ${observed.clockMs} < 0`);
  check(
    observed.stopCount === stops.length,
    `stop count ${observed.stopCount} ≠ ${stops.length}`,
  );
  const index = expectedStopIndex(stops, oracle);
  check(
    observed.stopIndex === index,
    `stop index ${observed.stopIndex} ≠ oracle ${index}`,
  );
  check(
    observed.highlightedMarkers === 1,
    `${observed.highlightedMarkers} highlighted markers`,
  );
  check(observed.arrowLabels <= 1, `${observed.arrowLabels} arrow labels`);
  check(
    observed.speed === speedLabel(REVIEW_SPEEDS[oracle.speedIndex] ?? 1),
    `speed ${observed.speed} ≠ oracle ${speedLabel(REVIEW_SPEEDS[oracle.speedIndex] ?? 1)}`,
  );
  check(
    observed.autoPause === oracle.autoPause,
    `AUTO ${observed.autoPause} ≠ oracle ${oracle.autoPause}`,
  );
  check(
    observed.prevDisabled === index <= 0,
    `prev disabled ${observed.prevDisabled} at index ${index}`,
  );
  check(
    observed.nextDisabled === index >= stops.length - 1,
    `next disabled ${observed.nextDisabled} at index ${index}`,
  );
  check(
    observed.clipPlayers === (oracle.native ? 1 : 0),
    `${observed.clipPlayers} clip players (native=${oracle.native})`,
  );
  if (oracle.native) {
    check(mockClipProps !== null, 'native player rendered without props');
    check(
      mockClipProps?.playing === oracle.playing,
      `native playing prop ${mockClipProps?.playing} ≠ ${oracle.playing}`,
    );
    check(
      (mockClipProps?.rate ?? 1) === (REVIEW_SPEEDS[oracle.speedIndex] ?? 1),
      `native rate ${mockClipProps?.rate} ≠ ${REVIEW_SPEEDS[oracle.speedIndex]}`,
    );
  }
  check(
    consoleNoise.length === 0,
    `console noise: ${consoleNoise.join(' | ')}`,
  );
  check(
    rejections.length === 0,
    `unhandled rejections: ${rejections.join(' | ')}`,
  );
  if (problems.length > 0) {
    throw new Error(`${where}: ${problems.join('; ')}`);
  }
}

async function runScenario(scenario: Scenario): Promise<Row> {
  const analysis = analysisFixture(scenario.stops === 'six' ? SIX_PHASES : []);
  const sequence = fullBodySequence();
  const script: FormReviewScript = buildFormReviewScript(analysis, sequence);
  const stops = script.stops;
  const initialStop =
    scenario.initialStopIndex !== null
      ? (stops[scenario.initialStopIndex] ?? null)
      : null;
  mockNativeAvailable = scenario.mode === 'native';
  mockClipProps = null;
  const clip = scenario.mode === 'native' ? CLIP : null;
  const measuredExtent = Math.max(
    1000,
    Math.max(3200, ...stops.map(stop => stop.endMs)) + 250,
  );

  const oracle: Oracle = {
    native: scenario.mode === 'native',
    playing: false,
    playheadMs: initialStop?.atMs ?? 0,
    durationMs: scenario.mode === 'native' ? CLIP.durationMs : measuredExtent,
    speedIndex: 0,
    autoPause: true,
    activeStopId: initialStop?.id ?? null,
    visited: new Set(
      initialStop
        ? stops.filter(stop => stop.atMs <= initialStop.atMs).map(s => s.id)
        : [],
    ),
    scrubbing: false,
    autoPauses: [],
    seeks: 0,
  };

  const element = (
    <FormReviewPlayer
      analysis={analysis}
      clip={clip}
      review={REVIEW}
      sequence={sequence}
      script={script}
      initialStop={initialStop}
      stageHeight={420}
    />
  );

  // Count the replay clock's real callbacks: fake timers schedule a 33.33ms
  // interval on integer boundaries, so N advances of TICK_MS are not always
  // exactly N callbacks. The oracle follows the callbacks that fired.
  let clockFires = 0;
  const realSetInterval = globalThis.setInterval;
  const intervalSpy = jest
    .spyOn(globalThis, 'setInterval')
    .mockImplementation(((
      handler: (...args: unknown[]) => void,
      delay?: number,
    ) => {
      if (
        typeof handler === 'function' &&
        Math.abs((delay ?? 0) - TICK_MS) < 0.01
      ) {
        return realSetInterval(() => {
          clockFires += 1;
          handler();
        }, delay);
      }
      return realSetInterval(handler, delay);
    }) as typeof setInterval);

  const ticks = async (count: number) => {
    for (let k = 0; k < count; k += 1) {
      const before = clockFires;
      await act(async () => {
        jest.advanceTimersByTime(TICK_MS);
      });
      for (let fired = before; fired < clockFires; fired += 1) {
        oracleJsTick(oracle, stops);
      }
    }
  };

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  mounted.push(renderer);
  await layout(renderer);

  const row: Row = {
    seed: scenario.seed,
    mode: scenario.mode,
    stops: scenario.stops,
    initialStopIndex: scenario.initialStopIndex,
    actions: scenario.actions.length,
    actionsRun: 0,
    autoPauses: 0,
    clockFires: 0,
    timersAfterUnmount: -1,
    timersAfterDrain: -1,
    outcome: 'HELD',
    failedAt: null,
    detail: null,
  };

  try {
    assertConsistent(observe(renderer), oracle, stops, 'after mount');

    for (const action of scenario.actions) {
      const label = `#${row.actionsRun + 1} ${describeAction(action)}`;
      switch (action.kind) {
        case 'tap': {
          if (action.sameFrame) {
            // Every press in ONE batch: the closures all see the same frame.
            const indexAtRender = expectedStopIndex(stops, oracle);
            let fired = 0;
            await act(async () => {
              for (let k = 0; k < action.count; k += 1) {
                if (tap(renderer, action.target)) fired += 1;
              }
            });
            // Every closure saw the frame rendered BEFORE the batch, so k
            // next/prev taps all aim at the same stop (one jump), while k
            // play/speed/AUTO taps each take effect (ref- or updater-based).
            for (let k = 0; k < fired; k += 1) {
              applyTapToOracle(oracle, stops, action.target, indexAtRender);
            }
          } else {
            for (let k = 0; k < action.count; k += 1) {
              const indexAtRender = expectedStopIndex(stops, oracle);
              let fired = false;
              await act(async () => {
                fired = tap(renderer, action.target);
              });
              if (fired)
                applyTapToOracle(oracle, stops, action.target, indexAtRender);
            }
          }
          break;
        }
        case 'combo': {
          // Two or three different controls pressed in the same frame.
          const indexAtRender = expectedStopIndex(stops, oracle);
          const fired: Target[] = [];
          await act(async () => {
            for (const target of action.targets) {
              if (tap(renderer, target)) fired.push(target);
            }
          });
          for (const target of fired) {
            applyTapToOracle(oracle, stops, target, indexAtRender);
          }
          break;
        }
        case 'scrub': {
          const track = timeline(renderer);
          const event = { nativeEvent: { locationX: action.ratio * 300 } };
          await act(async () => {
            track.props.onResponderGrant(event);
            track.props.onResponderMove(event);
            if (action.release) track.props.onResponderRelease();
          });
          oracle.scrubbing = !action.release;
          oracleJump(
            oracle,
            stops,
            Math.min(1, Math.max(0, action.ratio)) * oracle.durationMs,
            null,
          );
          break;
        }
        case 'release': {
          const track = timeline(renderer);
          await act(async () => {
            track.props.onResponderRelease();
          });
          oracle.scrubbing = false;
          break;
        }
        case 'tick': {
          await ticks(action.ticks);
          break;
        }
        case 'run': {
          if (!oracle.playing) {
            const indexAtRender = expectedStopIndex(stops, oracle);
            let fired = false;
            await act(async () => {
              fired = tap(renderer, 'play');
            });
            if (fired) applyTapToOracle(oracle, stops, 'play', indexAtRender);
          }
          if (oracle.native) {
            // The native player reports progress every frame; a late tap
            // lands between two reports.
            let position = oracle.playheadMs;
            for (let k = 0; k < action.ticks; k += 1) {
              position += TICK_MS * (REVIEW_SPEEDS[oracle.speedIndex] ?? 1);
              const props = clipProps();
              await act(async () => {
                props?.onProgress?.(position);
              });
              oracleAdvance(oracle, stops, position);
              if (!oracle.playing) break;
            }
          } else {
            await ticks(action.ticks);
          }
          break;
        }
        case 'progress': {
          if (!oracle.native) break;
          const props = clipProps();
          await act(async () => {
            props?.onProgress?.(action.ms);
          });
          oracleAdvance(oracle, stops, action.ms);
          break;
        }
        case 'load': {
          if (!oracle.native) break;
          const props = clipProps();
          await act(async () => {
            props?.onLoad?.(action.durationMs);
          });
          if (action.durationMs > 0) oracle.durationMs = action.durationMs;
          break;
        }
        case 'end': {
          if (!oracle.native) break;
          const props = clipProps();
          await act(async () => {
            props?.onEnd?.();
          });
          oracleFinish(oracle);
          break;
        }
        case 'error': {
          if (!oracle.native) break;
          const props = clipProps();
          await act(async () => {
            props?.onError?.('unreadable');
          });
          // The native layer comes down; the JS clock takes over from the
          // same playhead. The measured extent becomes the time base only
          // for a fresh mount — durationMs state is kept.
          oracle.native = false;
          break;
        }
        case 'rerender': {
          await act(async () => {
            renderer.update(
              <FormReviewPlayer
                analysis={{ ...analysis }}
                clip={clip ? { ...clip } : null}
                review={{ ...REVIEW }}
                sequence={sequence}
                script={script}
                initialStop={initialStop}
                stageHeight={420}
              />,
            );
          });
          break;
        }
      }
      row.actionsRun += 1;
      assertConsistent(observe(renderer), oracle, stops, label);
    }

    // Orphan-clock probe: a paused replay must not move when time passes.
    if (!oracle.playing) {
      const before = observe(renderer).clockMs;
      await act(async () => {
        jest.advanceTimersByTime(TICK_MS * 6);
      });
      const after = observe(renderer).clockMs;
      if (after !== before) {
        throw new Error(
          `orphan clock: paused replay moved ${before} → ${after}`,
        );
      }
    }

    // Unmount with whatever is pending, then let time pass: no noise allowed
    // and the replay clock must be gone.
    const firesAtUnmount = clockFires;
    await act(async () => {
      renderer.unmount();
    });
    mounted.splice(mounted.indexOf(renderer), 1);
    row.timersAfterUnmount = jest.getTimerCount();
    await act(async () => {
      jest.advanceTimersByTime(2_000);
    });
    row.timersAfterDrain = jest.getTimerCount();
    if (clockFires !== firesAtUnmount) {
      throw new Error('orphan clock: the replay interval fired after unmount');
    }
    if (consoleNoise.length > 0) {
      throw new Error(
        `console noise after unmount: ${consoleNoise.join(' | ')}`,
      );
    }
    if (rejections.length > 0) {
      throw new Error(
        `unhandled rejections after unmount: ${rejections.join(' | ')}`,
      );
    }
  } catch (error) {
    row.outcome = 'BROKEN';
    row.failedAt = `action ${row.actionsRun}/${row.actions}`;
    row.detail = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    intervalSpy.mockRestore();
    row.autoPauses = oracle.autoPauses.length;
    row.clockFires = clockFires;
    rows.push(row);
  }
  return row;
}

// ─── Suite ──────────────────────────────────────────────────────────────────

const seeds: number[] =
  ONLY_SEED !== null
    ? Array.from({ length: REPEAT }, () => ONLY_SEED)
    : Array.from({ length: ITERATIONS }, (_, i) => SEED_BASE + i);

beforeAll(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation((...args) => {
    consoleNoise.push(args.map(String).join(' '));
  });
  warnSpy = jest.spyOn(console, 'warn').mockImplementation((...args) => {
    consoleNoise.push(args.map(String).join(' '));
  });
  process.on('unhandledRejection', onRejection);
});

afterAll(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  process.off('unhandledRejection', onRejection);
  const held = rows.filter(row => row.outcome === 'HELD').length;
  const report = {
    suite: 'cmp-form-review-ui/rapid-interaction/formReviewPlayer',
    generatedAt: new Date().toISOString(),
    iterations: rows.length,
    actionsRun: rows.reduce((sum, row) => sum + row.actionsRun, 0),
    autoPauses: rows.reduce((sum, row) => sum + row.autoPauses, 0),
    held,
    broken: rows.length - held,
    maxTimersAfterUnmount: Math.max(
      -1,
      ...rows.map(row => row.timersAfterUnmount),
    ),
    maxTimersAfterDrain: Math.max(-1, ...rows.map(row => row.timersAfterDrain)),
    rows,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'formReviewPlayer.rapid-interaction.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
});

beforeEach(() => {
  jest.useFakeTimers();
  consoleNoise.length = 0;
  rejections.length = 0;
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  jest.useRealTimers();
});

describe('FormReviewPlayer under rapid, concurrent interaction', () => {
  it.each(seeds.map((seed, i) => [seed, i]))(
    'seed %i holds every invariant (run %i)',
    async (seed: number) => {
      const scenario = generate(seed);
      const row = await runScenario(scenario);
      expect(row.outcome).toBe('HELD');
      expect(row.actionsRun).toBe(scenario.actions.length);
    },
  );

  it('the generator is deterministic per seed', () => {
    expect(generate(SEED_BASE)).toEqual(generate(SEED_BASE));
    expect(JSON.stringify(generate(SEED_BASE))).not.toBe(
      JSON.stringify(generate(SEED_BASE + 1)),
    );
  });
});
