import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { ShotAnalysis } from '@pickle/shared-types';
import { StrokeResult } from '../../src/components/StrokeResult';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';

/**
 * STRESS — unit `cmp-stroke-result`, lens `rapid-interaction`.
 *
 * Seeded, replayable interaction bursts against the canonical StrokeResult
 * surface (ReplayCard play/pause + scrubber + VoiceOver adjust, attempt
 * chips, measured-row expander, Try again / Done) under fake timers.
 *
 * Every burst is checked against an independent reference model of the
 * card's contract, and against these safety invariants:
 *  - exactly ONE callback per press (onTryAgain / onDone / onOpenAttempt
 *    with the pressed attempt id; the current chip is inert);
 *  - the Play/Pause label, ClipPlayer `playing`/`seekMs` props and the
 *    replay clock equal the model after every step;
 *  - live `setInterval` handles == 1 while the JS timeline plays, else 0
 *    (no stacked or orphaned tickers), and 0 after unmount;
 *  - exactly one host node per control label (no duplicate controls);
 *  - no console.error / console.warn (act(), key, state-update warnings)
 *    and no unhandled promise rejection during the burst.
 *
 * Realism tiers:
 *  - `discrete` (default): every event in its own act() — how React Native
 *    delivers touch/accessibility events: each native dispatch runs inside
 *    `batchedUpdates`, which flushes sync work before the next dispatch
 *    (react-native/Libraries/Renderer/implementations/ReactFabric-dev.js
 *    `dispatchEvent` → `batchedUpdatesImpl`). Full model equivalence.
 *  - `synthetic` (STRESS_SYNTHETIC=1): (a) `batched` — several events
 *    inside ONE act() (same-tick delivery no RN event path produces);
 *    (b) `transition` — prop swaps (clip appears/disappears, attempts
 *    change, current attempt repointed) mid-burst; hosts key the surface
 *    by analysisId and load evidence atomically, so no host performs these
 *    swaps today. Only the safety invariants are asserted. Both tiers
 *    reproduce known P3 hardening gaps in ReplayCard (stacked tickers on
 *    same-tick multi-tap; playback state not reconciled when `clip`
 *    changes) and are opt-in until those are addressed.
 *
 * Replay:  STRESS_SEED=<seed> STRESS_ITER=1 npx jest --ci strokeResultRapidInteraction
 *          (campaign c uses seed c*10_000 + STRESS_SEED + i)
 * Scale:   STRESS_ITER=<n> (default 40 per campaign; the coordinator campaign
 *          used 60 → 300 bursts). STRESS_REPORT=<path> writes the seed→outcome
 *          JSON table.
 */

// ─── Seeded PRNG (mulberry32) ──────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed: number) {
  const next = mulberry32(seed);
  return {
    next,
    int: (min: number, max: number) =>
      min + Math.floor(next() * (max - min + 1)),
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)]!;
    },
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof makeRng>;

// ─── Campaign knobs ────────────────────────────────────────────────────────

const ITER = Math.max(1, Number(process.env['STRESS_ITER'] ?? '') || 40);
const SEED_BASE = Number(process.env['STRESS_SEED'] ?? '') || 1;
const REPORT = process.env['STRESS_REPORT'];
const SYNTHETIC = process.env['STRESS_SYNTHETIC'] === '1';
const itSynthetic = SYNTHETIC ? it : it.skip;

// ─── ClipPlayer mock (both replay modes) ───────────────────────────────────

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

// ─── Fixtures ──────────────────────────────────────────────────────────────

const CLIP_MS = 1000;
const clipFixture = { uri: 'file:///clip.mov', durationMs: CLIP_MS };

const measurement = (
  metricKey: string,
  value: number,
): ShotAnalysis['measurements'][number] => ({
  metricKey,
  value,
  confidence: 0.8,
  unit: 'degrees',
  source: 'real',
});

function analysisFixture(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
    id: 'a2',
    sessionId: 's1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-30T10:05:00.000Z',
    timestamps: { startMs: 200, contactMs: null, endMs: 700 },
    phases: [],
    measurements: [
      measurement('elbow_extension', 42),
      measurement('hip_rotation', 31),
      measurement('knee_bend', 12),
      measurement('shoulder_turn', 55),
      measurement('wrist_lag', 9),
    ],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.82,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-heuristic-1',
      scoringModelVersion: 'scoring-1',
      shotConfigVersion: 'config-1',
    },
    source: 'real',
    ...overrides,
  };
}

const recordFixture: StrokeResultEvidenceRecord = {
  id: 'a2',
  captureId: 'capture-2',
  strokeIntent: {
    declaredStroke: 'forehand_drive',
    predictedStroke: null,
    resolutionBasis: 'declared',
    resolvedProfileId: 'FOREHAND_DRIVE',
    resolvedProfileVersion: 'technique-profile-v1',
    disagreement: null,
  },
  result: null,
  uncertainty: {
    analysisConfidence: 0.82,
    presentation: 'normal',
    limitingFactors: [],
  },
};

const attemptsFixture = [
  { analysisId: 'a1', capturedAtIso: '2026-08-30T10:00:00Z', sessionId: 's1' },
  { analysisId: 'a2', capturedAtIso: '2026-08-30T10:05:00Z', sessionId: 's1' },
  { analysisId: 'a3', capturedAtIso: '2026-08-30T10:09:00Z', sessionId: 's1' },
];
const CHIP_LABELS = ['Attempt 1', 'Attempt 2', 'Attempt 3'] as const;
const CHIP_IDS = ['a1', 'a2', 'a3'] as const;
const HIDDEN_ROWS = 2; // stroke window + 5 measurements = 6 rows → 2 hidden

// ─── Renderer helpers ──────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

function formatSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(2)}s`;
}

function pressableByLabel(renderer: Renderer, label: string): Instance | null {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.accessibilityLabel === label &&
      typeof candidate.props.onPress === 'function',
  );
  return node ?? null;
}

function hostCountByLabel(renderer: Renderer, label: string): number {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' && node.props.accessibilityLabel === label,
  ).length;
}

function hostCountByTestId(renderer: Renderer, testID: string): number {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  ).length;
}

function scrubber(renderer: Renderer): Instance | null {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.testID === 'stroke-result-scrubber' &&
      typeof candidate.props.onResponderGrant === 'function',
  );
  return node ?? null;
}

function clipPlayer(renderer: Renderer): Instance | null {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.testID === 'clip-player' &&
      typeof candidate.props.onProgress === 'function',
  );
  return node ?? null;
}

function replayClock(renderer: Renderer): string | null {
  const replay = renderer.root.findAll(
    node => node.props.testID === 'stroke-result-replay',
  )[0];
  if (!replay) return null;
  const texts = replay.findAll(node => String(node.type) === 'Text');
  for (const text of texts) {
    const children = text.props.children;
    if (typeof children === 'string' && /^\d+\.\d\ds$/.test(children)) {
      return children;
    }
  }
  return null;
}

// ─── Observation: warnings, rejections, live intervals ─────────────────────

const consoleMessages: string[] = [];
const rejections: string[] = [];
const liveIntervals = new Set<unknown>();
let consoleErrorSpy: jest.SpyInstance;
let consoleWarnSpy: jest.SpyInstance;
let setIntervalSpy: jest.SpyInstance;
let clearIntervalSpy: jest.SpyInstance;

const onRejection = (reason: unknown) => {
  rejections.push(String(reason));
};

/** Each iteration starts from a clean clock so one BROKEN seed cannot leak
 * its stray timers into the seeds that follow. */
function resetObservation() {
  jest.clearAllTimers();
  liveIntervals.clear();
  consoleMessages.length = 0;
  rejections.length = 0;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockClip.nativeAvailable = false;
  consoleMessages.length = 0;
  rejections.length = 0;
  liveIntervals.clear();
  consoleErrorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleMessages.push(`error: ${args.map(String).join(' ')}`);
    });
  consoleWarnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      consoleMessages.push(`warn: ${args.map(String).join(' ')}`);
    });
  const fakeSetInterval = global.setInterval;
  const fakeClearInterval = global.clearInterval;
  setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(((
    ...args: Parameters<typeof setInterval>
  ) => {
    const id = fakeSetInterval(...args);
    liveIntervals.add(id);
    return id;
  }) as typeof setInterval);
  clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(((
    id: Parameters<typeof clearInterval>[0],
  ) => {
    liveIntervals.delete(id);
    fakeClearInterval(id);
  }) as typeof clearInterval);
  process.on('unhandledRejection', onRejection);
});

afterEach(() => {
  process.off('unhandledRejection', onRejection);
  setIntervalSpy.mockRestore();
  clearIntervalSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ─── Reference model of the surface's interaction contract ─────────────────

interface Base {
  startMs: number;
  endMs: number;
}

interface Ticker {
  nextTickAt: number;
  stepMs: number;
  /** `base.endMs` captured by the interval closure when play started. */
  endMs: number;
}

interface Model {
  base: Base;
  native: boolean;
  now: number;
  playheadMs: number;
  playing: boolean;
  seekMs: number;
  trackWidth: number;
  rowsExpanded: boolean;
  /** Ticker referenced by `playTimer.current` (null when none). */
  ticker: Ticker | null;
  tryAgain: number;
  done: number;
  opened: string[];
}

function baseFor(clip: boolean, analysis: ShotAnalysis): Base {
  if (clip) return { startMs: 0, endMs: CLIP_MS };
  return {
    startMs: Math.max(0, analysis.timestamps.startMs - 250),
    endMs: analysis.timestamps.endMs + 250,
  };
}

function newModel(
  clip: boolean,
  native: boolean,
  analysis: ShotAnalysis,
): Model {
  const base = baseFor(clip, analysis);
  return {
    base,
    native,
    now: 0,
    playheadMs: base.startMs,
    playing: false,
    seekMs: -1,
    trackWidth: 0,
    rowsExpanded: false,
    ticker: null,
    tryAgain: 0,
    done: 0,
    opened: [],
  };
}

const TICK_MS = 40; // useReducedMotion() is false under the RN jest preset

function modelStop(m: Model) {
  m.ticker = null;
  m.playing = false;
}

function modelSeekTo(m: Model, ms: number) {
  modelStop(m);
  const next = Math.min(m.base.endMs, Math.max(m.base.startMs, ms));
  m.playheadMs = next;
  if (m.native) m.seekMs = next - m.base.startMs;
}

function modelTogglePlay(m: Model) {
  if (m.playing) {
    modelStop(m);
    return;
  }
  if (m.playheadMs >= m.base.endMs - 30) {
    m.playheadMs = m.base.startMs;
    if (m.native) m.seekMs = 0;
  }
  m.playing = true;
  if (m.native) return;
  m.ticker = {
    nextTickAt: m.now + TICK_MS,
    stepMs: TICK_MS,
    endMs: m.base.endMs,
  };
}

function modelAdvance(m: Model, ms: number) {
  const target = m.now + ms;
  while (m.ticker && m.ticker.nextTickAt <= target) {
    const ticker = m.ticker;
    m.now = ticker.nextTickAt;
    ticker.nextTickAt += ticker.stepMs;
    const next = m.playheadMs + ticker.stepMs;
    if (next >= ticker.endMs) {
      modelStop(m);
      m.playheadMs = ticker.endMs;
    } else {
      m.playheadMs = next;
    }
  }
  m.now = target;
}

function modelScrubX(m: Model, locationX: number) {
  if (m.trackWidth <= 0) return;
  const span = m.base.endMs - m.base.startMs;
  const ratio = Math.min(1, Math.max(0, locationX / m.trackWidth));
  modelSeekTo(m, m.base.startMs + ratio * span);
}

function modelScrubStep(m: Model, direction: 1 | -1) {
  const span = m.base.endMs - m.base.startMs;
  modelSeekTo(m, m.playheadMs + direction * (span / 20));
}

// ─── Actions ───────────────────────────────────────────────────────────────

type Action =
  | { kind: 'play'; taps: number }
  | { kind: 'advance'; ms: number }
  | { kind: 'layout'; width: number }
  | { kind: 'scrub-grant'; x: number }
  | { kind: 'scrub-move'; x: number }
  | { kind: 'scrub-step'; direction: 1 | -1; taps: number }
  | { kind: 'chip'; index: 0 | 1 | 2; taps: number }
  | { kind: 'rows'; taps: number }
  | { kind: 'try-again'; taps: number }
  | { kind: 'done'; taps: number }
  | { kind: 'cta-both' }
  | { kind: 'press-in-out' }
  | { kind: 'native-progress'; positionMs: number }
  | { kind: 'native-end' };

const ACTION_KINDS: readonly Action['kind'][] = [
  'play',
  'play',
  'play',
  'advance',
  'advance',
  'advance',
  'layout',
  'scrub-grant',
  'scrub-move',
  'scrub-step',
  'chip',
  'chip',
  'rows',
  'try-again',
  'done',
  'cta-both',
  'press-in-out',
  'native-progress',
  'native-end',
];

function randomAction(rng: Rng): Action {
  const kind = rng.pick(ACTION_KINDS);
  const taps = rng.chance(0.45) ? 1 : rng.chance(0.6) ? 2 : 3;
  switch (kind) {
    case 'play':
      return { kind, taps };
    case 'advance':
      return {
        kind,
        ms: rng.pick([0, 1, 39, 40, 41, 80, 200, 500, 960, 1000, 1500, 2500]),
      };
    case 'layout':
      return { kind, width: rng.pick([0, 0, 1, 120, 300, 300, 375]) };
    case 'scrub-grant':
    case 'scrub-move':
      return { kind, x: rng.pick([-40, 0, 1, 50, 150, 299, 300, 301, 1000]) };
    case 'scrub-step':
      return { kind, direction: rng.chance(0.5) ? 1 : -1, taps };
    case 'chip':
      return { kind, index: rng.pick([0, 1, 2] as const), taps };
    case 'rows':
    case 'try-again':
    case 'done':
      return { kind, taps };
    case 'native-progress':
      return { kind, positionMs: rng.pick([0, 40, 250, 500, 970, 999, 1000]) };
    case 'cta-both':
    case 'press-in-out':
    case 'native-end':
      return { kind };
  }
}

function describeAction(action: Action): string {
  return Object.values(action).join(':');
}

// ─── Driver ────────────────────────────────────────────────────────────────

interface Harness {
  renderer: Renderer;
  model: Model;
  calls: { tryAgain: number; done: number; opened: string[] };
  render: (overrides?: Partial<SurfaceProps>) => void;
  props: SurfaceProps;
}

interface SurfaceProps {
  clip: boolean;
  attempts: boolean;
  currentAnalysisId: string;
}

function mountSurface(props: SurfaceProps, native: boolean): Harness {
  const analysis = analysisFixture({ id: props.currentAnalysisId });
  const calls = { tryAgain: 0, done: 0, opened: [] as string[] };
  const harness = {
    calls,
    model: newModel(props.clip, native && props.clip, analysis),
    props,
  } as Harness;
  const element = (current: SurfaceProps) => (
    <StrokeResult
      analysis={analysisFixture({ id: current.currentAnalysisId })}
      record={{ ...recordFixture, id: current.currentAnalysisId }}
      clip={current.clip ? clipFixture : null}
      attempts={current.attempts ? attemptsFixture : []}
      currentAnalysisId={current.currentAnalysisId}
      onOpenAttempt={id => calls.opened.push(id)}
      onTryAgain={() => {
        calls.tryAgain += 1;
      }}
      onDone={() => {
        calls.done += 1;
      }}
    />
  );
  act(() => {
    harness.renderer = TestRenderer.create(element(props));
  });
  harness.render = overrides => {
    harness.props = { ...harness.props, ...overrides };
    act(() => {
      harness.renderer.update(element(harness.props));
    });
  };
  return harness;
}

/** Fires one event on the tree; `model` (when given) mirrors the intent. */
function fire(h: Harness, action: Action, event: number, model: Model | null) {
  const r = h.renderer;
  switch (action.kind) {
    case 'play': {
      const node =
        pressableByLabel(r, 'Play replay') ??
        pressableByLabel(r, 'Pause replay');
      if (!node) throw new Error('no play control');
      node.props.onPress();
      if (model) modelTogglePlay(model);
      return;
    }
    case 'advance':
      jest.advanceTimersByTime(action.ms);
      if (model) modelAdvance(model, action.ms);
      return;
    case 'layout': {
      const node = scrubber(r);
      if (!node) throw new Error('no scrubber');
      node.props.onLayout({ nativeEvent: { layout: { width: action.width } } });
      if (model) model.trackWidth = action.width;
      return;
    }
    case 'scrub-grant':
    case 'scrub-move': {
      const node = scrubber(r);
      if (!node) throw new Error('no scrubber');
      const gesture = { nativeEvent: { locationX: action.x } };
      if (action.kind === 'scrub-grant') node.props.onResponderGrant(gesture);
      else node.props.onResponderMove(gesture);
      if (model) modelScrubX(model, action.x);
      return;
    }
    case 'scrub-step': {
      const node = scrubber(r);
      if (!node) throw new Error('no scrubber');
      node.props.onAccessibilityAction({
        nativeEvent: {
          actionName: action.direction === 1 ? 'increment' : 'decrement',
        },
      });
      if (model) modelScrubStep(model, action.direction);
      return;
    }
    case 'chip': {
      if (!h.props.attempts) return;
      const node = pressableByLabel(r, CHIP_LABELS[action.index]);
      if (!node) throw new Error(`no chip ${CHIP_LABELS[action.index]}`);
      node.props.onPress();
      const id = CHIP_IDS[action.index];
      if (model && id !== h.props.currentAnalysisId) model.opened.push(id);
      return;
    }
    case 'rows': {
      const node =
        pressableByLabel(r, `See ${HIDDEN_ROWS} more`) ??
        pressableByLabel(r, 'Show fewer rows');
      if (!node) throw new Error('no rows toggle');
      node.props.onPress();
      if (model) model.rowsExpanded = !model.rowsExpanded;
      return;
    }
    case 'try-again': {
      const node = pressableByLabel(r, 'Try again');
      if (!node) throw new Error('no Try again');
      node.props.onPress();
      if (model) model.tryAgain += 1;
      return;
    }
    case 'done': {
      const node = pressableByLabel(r, 'Done');
      if (!node) throw new Error('no Done');
      node.props.onPress();
      if (model) model.done += 1;
      return;
    }
    case 'cta-both': {
      // "Simultaneous controls": both CTAs land in the same event.
      const tryAgain = pressableByLabel(r, 'Try again');
      const done = pressableByLabel(r, 'Done');
      if (!tryAgain || !done) throw new Error('no CTA row');
      if (event === 0) tryAgain.props.onPress();
      else done.props.onPress();
      if (model) {
        if (event === 0) model.tryAgain += 1;
        else model.done += 1;
      }
      return;
    }
    case 'press-in-out': {
      // Touch-down/up feedback animation on the play control (no press).
      const node =
        pressableByLabel(r, 'Play replay') ??
        pressableByLabel(r, 'Pause replay');
      if (!node) throw new Error('no play control');
      const inner = node.findAll(
        n => typeof n.props.onPressIn === 'function' && n !== node,
      )[0];
      if (!inner) throw new Error('no inner pressable');
      if (event === 0) inner.props.onPressIn();
      else inner.props.onPressOut();
      return;
    }
    case 'native-progress': {
      const player = clipPlayer(r);
      if (!player) return; // no clip in this tree
      player.props.onProgress(action.positionMs);
      if (model) model.playheadMs = model.base.startMs + action.positionMs;
      return;
    }
    case 'native-end': {
      const player = clipPlayer(r);
      if (!player) return;
      player.props.onEnd();
      if (model) {
        modelStop(model);
        model.playheadMs = model.base.endMs;
      }
      return;
    }
  }
}

function eventCount(action: Action): number {
  switch (action.kind) {
    case 'cta-both':
    case 'press-in-out':
      return 2;
    case 'play':
    case 'scrub-step':
    case 'chip':
    case 'rows':
    case 'try-again':
    case 'done':
      return action.taps;
    default:
      return 1;
  }
}

/** Discrete delivery: each event in its own act (RN's real cadence). */
function dispatchDiscrete(h: Harness, action: Action, model: Model | null) {
  for (let i = 0; i < eventCount(action); i += 1) {
    act(() => fire(h, action, i, model));
  }
}

/** Same-tick delivery: every event of the burst inside ONE act. */
function dispatchBatched(h: Harness, action: Action) {
  act(() => {
    for (let i = 0; i < eventCount(action); i += 1) fire(h, action, i, null);
  });
}

// ─── Invariants ────────────────────────────────────────────────────────────

function expectSafety(h: Harness, faults: string[], mounted: boolean) {
  if (consoleMessages.length)
    faults.push(`console: ${consoleMessages.join(' | ')}`);
  if (rejections.length)
    faults.push(`unhandledRejection: ${rejections.join(' | ')}`);
  if (!mounted) {
    if (liveIntervals.size !== 0)
      faults.push(`orphan intervals after unmount: ${liveIntervals.size}`);
    return;
  }
  const r = h.renderer;
  const playLabelCount =
    hostCountByLabel(r, 'Play replay') + hostCountByLabel(r, 'Pause replay');
  if (playLabelCount !== 1) faults.push(`play controls: ${playLabelCount}`);
  if (hostCountByTestId(r, 'stroke-result-scrubber') !== 1)
    faults.push('scrubber count != 1');
  if (hostCountByLabel(r, 'Try again') !== 1)
    faults.push('Try again count != 1');
  if (hostCountByLabel(r, 'Done') !== 1) faults.push('Done count != 1');
  if (h.props.attempts) {
    for (const label of CHIP_LABELS) {
      if (hostCountByLabel(r, label) !== 1) faults.push(`${label} count != 1`);
    }
  }
  const rowsToggles =
    hostCountByLabel(r, `See ${HIDDEN_ROWS} more`) +
    hostCountByLabel(r, 'Show fewer rows');
  if (rowsToggles !== 1) faults.push(`rows toggles: ${rowsToggles}`);
  const playing = pressableByLabel(r, 'Pause replay') !== null;
  const jsTimeline = !(h.props.clip && mockClip.nativeAvailable);
  const expectedIntervals = playing && jsTimeline ? 1 : 0;
  if (liveIntervals.size !== expectedIntervals) {
    faults.push(
      `live intervals ${liveIntervals.size} (expected ${expectedIntervals}, playing=${playing})`,
    );
  }
}

function expectModel(h: Harness, m: Model, faults: string[]) {
  const r = h.renderer;
  const playing = pressableByLabel(r, 'Pause replay') !== null;
  if (playing !== m.playing)
    faults.push(`playing ${playing} != model ${m.playing}`);
  const clock = replayClock(r);
  const expectedClock = formatSeconds(m.playheadMs - m.base.startMs);
  if (clock !== expectedClock)
    faults.push(`clock ${clock} != model ${expectedClock}`);
  const expectedIntervals = m.ticker ? 1 : 0;
  if (liveIntervals.size !== expectedIntervals) {
    faults.push(
      `live intervals ${liveIntervals.size} != model ${expectedIntervals}`,
    );
  }
  if (h.calls.tryAgain !== m.tryAgain)
    faults.push(`onTryAgain ${h.calls.tryAgain} != ${m.tryAgain}`);
  if (h.calls.done !== m.done)
    faults.push(`onDone ${h.calls.done} != ${m.done}`);
  if (h.calls.opened.join(',') !== m.opened.join(',')) {
    faults.push(`onOpenAttempt [${h.calls.opened}] != [${m.opened}]`);
  }
  const player = clipPlayer(r);
  if (h.props.clip && !player) faults.push('clip present but no ClipPlayer');
  if (player) {
    if (player.props.playing !== m.playing)
      faults.push(`ClipPlayer.playing ${player.props.playing} != ${m.playing}`);
    if (player.props.seekMs !== m.seekMs)
      faults.push(`ClipPlayer.seekMs ${player.props.seekMs} != ${m.seekMs}`);
  }
  const expandedLabel = pressableByLabel(r, 'Show fewer rows') !== null;
  if (expandedLabel !== m.rowsExpanded)
    faults.push(`rowsExpanded ${expandedLabel} != ${m.rowsExpanded}`);
}

function unmountAndDrain(h: Harness) {
  act(() => {
    h.renderer.unmount();
  });
  act(() => {
    jest.advanceTimersByTime(5000);
  });
}

// ─── Result table ──────────────────────────────────────────────────────────

interface Row {
  campaign: string;
  seed: number;
  steps: number;
  events: number;
  outcome: 'HELD' | 'BROKEN';
  script: string;
  faults: string[];
}

const table: Row[] = [];

afterAll(() => {
  if (!REPORT) return;
  mkdirSync(dirname(REPORT), { recursive: true });
  const summary = {
    unit: 'cmp-stroke-result',
    lens: 'rapid-interaction',
    iterationsPerCampaign: ITER,
    seedBase: SEED_BASE,
    executed: table.length,
    events: table.reduce((sum, row) => sum + row.events, 0),
    broken: table.filter(row => row.outcome === 'BROKEN').length,
    rows: table,
  };
  writeFileSync(REPORT, JSON.stringify(summary, null, 2));
});

function record(row: Row) {
  table.push(row);
}

function failures(rows: Row[]): string[] {
  return rows
    .filter(row => row.outcome === 'BROKEN')
    .map(
      row =>
        `${row.campaign} seed=${row.seed}: ${row.faults.join('; ')}\n  script: ${row.script}`,
    );
}

// ─── Campaigns ─────────────────────────────────────────────────────────────

function runDiscreteBurst(
  campaign: string,
  seed: number,
  native: boolean,
): Row {
  resetObservation();
  const rng = makeRng(seed);
  mockClip.nativeAvailable = native;
  const props: SurfaceProps = {
    clip: native ? true : rng.chance(0.6),
    attempts: rng.chance(0.85),
    currentAnalysisId: 'a2',
  };
  const h = mountSurface(props, native);
  const model = h.model;
  const steps = rng.int(6, 24);
  const script: string[] = [];
  const faults: string[] = [];
  let events = 0;
  const unmountAt = rng.chance(0.3) ? rng.int(1, steps) : -1;
  for (let step = 0; step < steps; step += 1) {
    const action = randomAction(rng);
    script.push(describeAction(action));
    dispatchDiscrete(h, action, model);
    events += eventCount(action);
    expectModel(h, model, faults);
    expectSafety(h, faults, true);
    if (faults.length) break;
    if (step + 1 === unmountAt) {
      script.push('unmount');
      break;
    }
  }
  unmountAndDrain(h);
  expectSafety(h, faults, false);
  if (jest.getTimerCount() !== 0)
    faults.push(`timers left after unmount+drain: ${jest.getTimerCount()}`);
  return {
    campaign,
    seed,
    steps: script.length,
    events,
    outcome: faults.length ? 'BROKEN' : 'HELD',
    script: `${native ? 'native' : 'js'} clip=${props.clip} attempts=${props.attempts} | ${script.join(' ')}`,
    faults,
  };
}

function runBatchedBurst(campaign: string, seed: number): Row {
  resetObservation();
  const rng = makeRng(seed);
  const native = rng.chance(0.4);
  mockClip.nativeAvailable = native;
  const props: SurfaceProps = {
    clip: native ? true : rng.chance(0.6),
    attempts: true,
    currentAnalysisId: 'a2',
  };
  const h = mountSurface(props, native);
  const steps = rng.int(4, 16);
  const script: string[] = [];
  const faults: string[] = [];
  let events = 0;
  let presses = { tryAgain: 0, done: 0, opened: [] as string[] };
  for (let step = 0; step < steps; step += 1) {
    const action = randomAction(rng);
    script.push(describeAction(action));
    dispatchBatched(h, action);
    const count = eventCount(action);
    events += count;
    if (action.kind === 'try-again') presses.tryAgain += count;
    if (action.kind === 'done') presses.done += count;
    if (action.kind === 'cta-both')
      presses = {
        ...presses,
        tryAgain: presses.tryAgain + 1,
        done: presses.done + 1,
      };
    if (
      action.kind === 'chip' &&
      CHIP_IDS[action.index] !== props.currentAnalysisId
    ) {
      for (let i = 0; i < count; i += 1)
        presses.opened.push(CHIP_IDS[action.index]);
    }
    expectSafety(h, faults, true);
    if (h.calls.tryAgain !== presses.tryAgain)
      faults.push(
        `onTryAgain ${h.calls.tryAgain} != presses ${presses.tryAgain}`,
      );
    if (h.calls.done !== presses.done)
      faults.push(`onDone ${h.calls.done} != presses ${presses.done}`);
    if (h.calls.opened.join(',') !== presses.opened.join(','))
      faults.push(
        `onOpenAttempt [${h.calls.opened}] != presses [${presses.opened}]`,
      );
    if (faults.length) break;
  }
  unmountAndDrain(h);
  expectSafety(h, faults, false);
  if (jest.getTimerCount() !== 0)
    faults.push(`timers left after unmount+drain: ${jest.getTimerCount()}`);
  return {
    campaign,
    seed,
    steps: script.length,
    events,
    outcome: faults.length ? 'BROKEN' : 'HELD',
    script: `${native ? 'native' : 'js'} clip=${props.clip} | ${script.join(' ')}`,
    faults,
  };
}

function runTransitionBurst(campaign: string, seed: number): Row {
  resetObservation();
  const rng = makeRng(seed);
  const native = rng.chance(0.5);
  mockClip.nativeAvailable = native;
  const initial: SurfaceProps = {
    clip: rng.chance(0.5),
    attempts: rng.chance(0.7),
    currentAnalysisId: 'a2',
  };
  const h = mountSurface(initial, native);
  const steps = rng.int(4, 16);
  const script: string[] = [];
  const faults: string[] = [];
  let events = 0;
  for (let step = 0; step < steps; step += 1) {
    if (rng.chance(0.35)) {
      const swap = rng.pick(['clip', 'attempts', 'current'] as const);
      script.push(`swap:${swap}`);
      if (swap === 'clip') h.render({ clip: !h.props.clip });
      else if (swap === 'attempts') h.render({ attempts: !h.props.attempts });
      else h.render({ currentAnalysisId: rng.pick(CHIP_IDS) });
      events += 1;
    } else {
      const action = randomAction(rng);
      if (action.kind === 'chip' && !h.props.attempts) continue;
      script.push(describeAction(action));
      dispatchDiscrete(h, action, null);
      events += eventCount(action);
    }
    expectSafety(h, faults, true);
    if (faults.length) break;
  }
  unmountAndDrain(h);
  expectSafety(h, faults, false);
  if (jest.getTimerCount() !== 0)
    faults.push(`timers left after unmount+drain: ${jest.getTimerCount()}`);
  return {
    campaign,
    seed,
    steps: script.length,
    events,
    outcome: faults.length ? 'BROKEN' : 'HELD',
    script: `${native ? 'native' : 'js'} clip=${initial.clip} attempts=${initial.attempts} | ${script.join(' ')}`,
    faults,
  };
}

function runRemountSpam(campaign: string, seed: number): Row {
  resetObservation();
  const rng = makeRng(seed);
  const native = rng.chance(0.3);
  mockClip.nativeAvailable = native;
  const mounts = rng.int(3, 8);
  const script: string[] = [];
  const faults: string[] = [];
  let events = 0;
  for (let i = 0; i < mounts; i += 1) {
    const h = mountSurface(
      {
        clip: rng.chance(0.6),
        attempts: true,
        currentAnalysisId: rng.pick(CHIP_IDS),
      },
      native,
    );
    const inner = rng.int(0, 3);
    for (let j = 0; j < inner; j += 1) {
      const action = randomAction(rng);
      script.push(describeAction(action));
      dispatchDiscrete(h, action, null);
      events += eventCount(action);
    }
    // Back out of the screen: unmount without draining, then remount.
    act(() => {
      h.renderer.unmount();
    });
    script.push('remount');
    events += 1;
    if (liveIntervals.size !== 0) {
      faults.push(
        `orphan intervals after unmount #${i}: ${liveIntervals.size}`,
      );
      break;
    }
    if (consoleMessages.length) {
      faults.push(`console: ${consoleMessages.join(' | ')}`);
      break;
    }
  }
  act(() => {
    jest.advanceTimersByTime(5000);
  });
  if (rejections.length)
    faults.push(`unhandledRejection: ${rejections.join(' | ')}`);
  if (jest.getTimerCount() !== 0)
    faults.push(`timers left after drain: ${jest.getTimerCount()}`);
  return {
    campaign,
    seed,
    steps: script.length,
    events,
    outcome: faults.length ? 'BROKEN' : 'HELD',
    script: `${native ? 'native' : 'js'} | ${script.join(' ')}`,
    faults,
  };
}

describe(`StrokeResult rapid-interaction stress (STRESS_ITER=${ITER}, seed base ${SEED_BASE})`, () => {
  it('discrete bursts on the measured-timeline replay match the reference model', () => {
    const rows: Row[] = [];
    for (let i = 0; i < ITER; i += 1) {
      const row = runDiscreteBurst('discrete-js', SEED_BASE + i, false);
      rows.push(row);
      record(row);
    }
    expect(failures(rows)).toEqual([]);
    expect(rows).toHaveLength(ITER);
  });

  it('discrete bursts on the native-player replay match the reference model', () => {
    const rows: Row[] = [];
    for (let i = 0; i < ITER; i += 1) {
      const row = runDiscreteBurst(
        'discrete-native',
        10_000 + SEED_BASE + i,
        true,
      );
      rows.push(row);
      record(row);
    }
    expect(failures(rows)).toEqual([]);
    expect(rows).toHaveLength(ITER);
  });

  itSynthetic(
    'same-tick (batched) bursts never stack tickers, duplicate controls or double-fire callbacks',
    () => {
      const rows: Row[] = [];
      for (let i = 0; i < ITER; i += 1) {
        const row = runBatchedBurst('batched', 20_000 + SEED_BASE + i);
        rows.push(row);
        record(row);
      }
      expect(failures(rows)).toEqual([]);
      expect(rows).toHaveLength(ITER);
    },
  );

  itSynthetic(
    'prop transitions mid-burst leave no orphan ticker, warning or duplicate control',
    () => {
      const rows: Row[] = [];
      for (let i = 0; i < ITER; i += 1) {
        const row = runTransitionBurst('transition', 30_000 + SEED_BASE + i);
        rows.push(row);
        record(row);
      }
      expect(failures(rows)).toEqual([]);
      expect(rows).toHaveLength(ITER);
    },
  );

  it('back-out / remount spam leaves no timer or warning behind', () => {
    const rows: Row[] = [];
    for (let i = 0; i < ITER; i += 1) {
      const row = runRemountSpam('remount', 40_000 + SEED_BASE + i);
      rows.push(row);
      record(row);
    }
    expect(failures(rows)).toEqual([]);
    expect(rows).toHaveLength(ITER);
  });
});
