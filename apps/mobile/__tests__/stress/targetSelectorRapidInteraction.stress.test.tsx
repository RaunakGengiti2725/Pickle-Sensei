/**
 * STRESS SUITE — `src/camera/TargetSelector.tsx`, lens: RAPID / CONCURRENT
 * INTERACTION.
 *
 * The behavioural contract is pinned in `__tests__/wf/TargetSelector.buttons
 * .test.tsx`; this suite hammers the same surface with seeded interaction
 * bursts a real thumb (or two) produces:
 *
 *  - double / triple taps on the frame, on Analyze and on Skip;
 *  - taps that land in the SAME JS tick as a layout pass, a poster swap, a
 *    source-dimension change or an image decode failure (React batches the
 *    state updates, so every handler sees the previously COMMITTED state);
 *  - Analyze + Skip pressed together, Analyze pressed while disabled;
 *  - press-in / press-out animation churn with fake timers advanced between
 *    and during bursts;
 *  - unmount in the middle of a burst with actions still queued behind it.
 *
 * Every burst is generated from a seed (mulberry32) and replayed against an
 * ORACLE that models the component's documented semantics — closures see
 * committed state, `disabled` Pressables never fire (RN Pressability), taps
 * before layout are ignored, the last tap wins. After every tick the
 * rendered tree and the recorded callbacks must match the oracle exactly:
 *
 *  - one `onConfirm` per enabled Analyze press, carrying the committed seed
 *    (normalized, finite, cover-crop inverted) and the fake-clock ISO stamp;
 *  - one `onSkip` per Skip press, never an `onConfirm` without a seed;
 *  - status copy / Analyze disabled state / ring position / preview branch
 *    consistent with the model state;
 *  - exactly one frame touchable and two design buttons (no duplicate
 *    controls), no thrown error, no console.error/warn (act warnings,
 *    duplicate keys), no unhandled rejection.
 *
 * A second harness (`ConsumerHost`) mirrors how AnalyzeScreen consumes the
 * selector (setTargetSeed + a `scoringActive` re-entry guard that unmounts
 * the selector on the first accepted call) and asserts that any burst ever
 * starts AT MOST one analysis, with the seed that won.
 *
 * Scale: STRESS_ITER bursts per campaign (default 60 so the suite stays
 * cheap; the recorded campaign ran 400). STRESS_SEED=<n> replays one burst.
 * STRESS_OUT=<dir> writes the seed → outcome JSON table.
 */
jest.mock('react-native-svg', () => {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const make = (name: string) => {
    const Mock = (props: { children?: React.ReactNode }) =>
      React.createElement(View, null, props.children);
    Mock.displayName = name;
    return Mock;
  };
  return {
    __esModule: true,
    default: make('Svg'),
    Svg: make('Svg'),
    Circle: make('Circle'),
    Line: make('Line'),
    Path: make('Path'),
    Polyline: make('Polyline'),
    Rect: make('Rect'),
  };
});

import React, { useRef, useState } from 'react';
import {
  Image,
  Text,
  TouchableWithoutFeedback,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Circle } from 'react-native-svg';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  TargetSelector,
  viewPointToSourcePoint,
  type TargetSelection,
} from '../../src/camera/TargetSelector';

// Node built-ins for the campaign flags / JSON table. The mobile tsconfig
// deliberately excludes node typings, so the shims stay local.
declare const process: { env: Record<string, string | undefined> } & {
  on: (event: 'unhandledRejection', handler: (reason: unknown) => void) => void;
  off: (
    event: 'unhandledRejection',
    handler: (reason: unknown) => void,
  ) => void;
};
const fs = jest.requireActual<{
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
}>('fs');
const path = jest.requireActual<{ join: (...parts: string[]) => string }>(
  'path',
);

// ─── seeded RNG ─────────────────────────────────────────────────────────────

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

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ─── campaign configuration ─────────────────────────────────────────────────

const ITER = Number.parseInt(process.env.STRESS_ITER ?? '60', 10);
const ONLY_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number.parseInt(process.env.STRESS_SEED, 10)
    : null;
const OUT_DIR = process.env.STRESS_OUT ?? null;
const BASE_SEED = 0x7a11e7;
const NOW_ISO = '2026-09-04T12:00:00.000Z';

const FRAME_URI = 'file:///private/var/mobile/import.mov';
const POSTERS = [
  undefined,
  'file:///private/var/mobile/import.poster.jpg',
  'file:///private/var/mobile/import.poster-2.jpg',
] as const;
const SOURCE_DIMS: ReadonlyArray<{ w?: number; h?: number }> = [
  { w: 1920, h: 1080 },
  { w: 1080, h: 1920 },
  { w: 3840, h: 2160 },
  { w: 640, h: 480 },
  { w: 720, h: 720 },
  { w: undefined, h: undefined },
  { w: 1920, h: undefined },
  { w: 0, h: 0 },
  { w: -1920, h: 1080 },
  { w: Number.NaN, h: 1080 },
  { w: 1920, h: Number.POSITIVE_INFINITY },
];
const LAYOUTS: ReadonlyArray<{ width: number; height: number }> = [
  { width: 270, height: 480 },
  { width: 360, height: 380 },
  { width: 213.75, height: 380 },
  { width: 320, height: 568 },
  { width: 0, height: 0 },
  { width: 0, height: 380 },
  { width: 1, height: 1 },
];

type Action =
  | { kind: 'layout'; width: number; height: number }
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'confirm' }
  | { kind: 'skip' }
  | { kind: 'pressIn'; label: ButtonLabel }
  | { kind: 'pressOut'; label: ButtonLabel }
  | { kind: 'imageError' }
  | { kind: 'setSource'; w?: number; h?: number }
  | { kind: 'setPoster'; posterUri?: string }
  | { kind: 'advance'; ms: number }
  | { kind: 'unmount' };

type ButtonLabel = 'Analyze this player' | 'Skip — pick automatically';
const ANALYZE: ButtonLabel = 'Analyze this player';
const SKIP: ButtonLabel = 'Skip — pick automatically';

/** A tick = actions dispatched inside ONE act() (same JS task, batched). */
type Tick = Action[];

function genTap(rng: Rng): Action {
  // Mostly in-frame, sometimes wildly outside (thumb slid off the frame).
  const wild = rng.chance(0.2);
  const x = wild ? rng.pick([-40, -1, 9999, 1e6]) : rng.float() * 400;
  const y = wild ? rng.pick([-1, 9999, -5000, 0]) : rng.float() * 600;
  return { kind: 'tap', x, y };
}

function genAction(rng: Rng): Action {
  const roll = rng.float();
  if (roll < 0.28) return genTap(rng);
  if (roll < 0.5) return { kind: 'confirm' };
  if (roll < 0.62) return { kind: 'skip' };
  if (roll < 0.72) return { kind: 'layout', ...rng.pick(LAYOUTS) };
  if (roll < 0.78) return { kind: 'pressIn', label: rng.pick([ANALYZE, SKIP]) };
  if (roll < 0.84) {
    return { kind: 'pressOut', label: rng.pick([ANALYZE, SKIP]) };
  }
  if (roll < 0.88) return { kind: 'imageError' };
  if (roll < 0.92) return { kind: 'setSource', ...rng.pick(SOURCE_DIMS) };
  if (roll < 0.95) return { kind: 'setPoster', posterUri: rng.pick(POSTERS) };
  if (roll < 0.985)
    return { kind: 'advance', ms: rng.pick([0, 1, 16, 110, 150, 1000]) };
  return { kind: 'unmount' };
}

/**
 * A burst is 1–7 ticks; each tick holds 1–5 actions. ~35% of ticks are
 * multi-action "same frame" batches (double/triple taps, tap+confirm,
 * confirm+skip, layout+tap...). Half the bursts begin with a committed
 * layout so the interesting post-layout paths are exercised often.
 */
function genBurst(seed: number): Tick[] {
  const rng = new Rng(seed);
  const ticks: Tick[] = [];
  if (rng.chance(0.5)) ticks.push([{ kind: 'layout', ...LAYOUTS[0]! }]);
  const tickCount = rng.int(1, 7);
  for (let t = 0; t < tickCount; t += 1) {
    const multi = rng.chance(0.35);
    const n = multi ? rng.int(2, 5) : 1;
    const tick: Tick = [];
    for (let i = 0; i < n; i += 1) {
      // Repeat-heavy: a burst often means the same control hit repeatedly.
      if (i > 0 && rng.chance(0.45)) tick.push(tick[i - 1]!);
      else tick.push(genAction(rng));
    }
    ticks.push(tick);
  }
  return ticks;
}

// ─── oracle model ───────────────────────────────────────────────────────────

interface ModelState {
  size: { width: number; height: number } | null;
  tap: {
    view: { x: number; y: number };
    source: { x: number; y: number };
  } | null;
  previewFailed: boolean;
  sourceW: number | undefined;
  sourceH: number | undefined;
  posterUri: string | undefined;
  mounted: boolean;
}

function clone(state: ModelState): ModelState {
  return {
    ...state,
    size: state.size ? { ...state.size } : null,
    tap: state.tap
      ? { view: { ...state.tap.view }, source: { ...state.tap.source } }
      : null,
  };
}

// ─── renderer helpers (mirror the button-ledger suite's selectors) ──────────

type Props = React.ComponentProps<typeof TargetSelector>;

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => React.Children.toArray(node.props.children).join(''))
    .join('\n');
}

function frameTouchables(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType(TouchableWithoutFeedback);
}

function frameViews(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    node => node.type === View && typeof node.props.onLayout === 'function',
  );
}

/** The RN `Pressable`s design Buttons render (explicit accessibilityState). */
function pressables(renderer: ReactTestRenderer, label?: string) {
  return renderer.root.findAll(
    node =>
      typeof node.props.accessibilityLabel === 'string' &&
      (label === undefined || node.props.accessibilityLabel === label) &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityState !== undefined,
  );
}

function ringCircles(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType(Circle)
    .filter(node => node.props.r === 26);
}

function isNormalized(point: { x: number; y: number }): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 &&
    point.x <= 1 &&
    point.y >= 0 &&
    point.y <= 1
  );
}

// ─── console / rejection guards ─────────────────────────────────────────────

const consoleLog: string[] = [];
const rejections: string[] = [];
let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
const onRejection = (reason: unknown) => {
  rejections.push(String(reason));
};

beforeAll(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation((...args) => {
    consoleLog.push(`error: ${args.map(String).join(' ')}`);
  });
  warnSpy = jest.spyOn(console, 'warn').mockImplementation((...args) => {
    consoleLog.push(`warn: ${args.map(String).join(' ')}`);
  });
  process.on('unhandledRejection', onRejection);
});

afterAll(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  process.off('unhandledRejection', onRejection);
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(NOW_ISO));
  consoleLog.length = 0;
  rejections.length = 0;
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── burst executor (isolated component vs oracle) ──────────────────────────

interface BurstOutcome {
  seed: number;
  ticks: number;
  actions: number;
  confirms: number;
  skips: number;
  droppedDisabledPresses: number;
  ignoredPreLayoutTaps: number;
  unmountedMidBurst: boolean;
  status: 'HELD' | 'BROKEN';
  violations: string[];
  burst: Tick[];
}

function runIsolatedBurst(seed: number): BurstOutcome {
  const burst = genBurst(seed);
  const violations: string[] = [];
  const confirmCalls: TargetSelection[] = [];
  const skipCalls: number[] = [];
  const onConfirm = (selection: TargetSelection) => {
    confirmCalls.push(selection);
  };
  const onSkip = () => {
    skipCalls.push(1);
  };

  let committed: ModelState = {
    size: null,
    tap: null,
    previewFailed: false,
    sourceW: SOURCE_DIMS[0]!.w,
    sourceH: SOURCE_DIMS[0]!.h,
    posterUri: POSTERS[1],
    mounted: true,
  };
  const propsFor = (state: ModelState): Props => ({
    frameUri: FRAME_URI,
    posterUri: state.posterUri,
    sourceWidth: state.sourceW,
    sourceHeight: state.sourceH,
    onConfirm,
    onSkip,
  });

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<TargetSelector {...propsFor(committed)} />);
  });

  let actions = 0;
  let droppedDisabledPresses = 0;
  let ignoredPreLayoutTaps = 0;
  let unmountedMidBurst = false;

  for (const [tickIndex, tick] of burst.entries()) {
    if (!committed.mounted) break;
    const pending = clone(committed);
    const expectedConfirms: Array<{ x: number; y: number; iso: string }> = [];
    let expectedSkips = 0;
    const confirmsBefore = confirmCalls.length;
    const skipsBefore = skipCalls.length;

    try {
      act(() => {
        for (const action of tick) {
          if (!pending.mounted) break;
          actions += 1;
          switch (action.kind) {
            case 'layout': {
              const views = frameViews(renderer);
              if (views.length !== 1) {
                violations.push(
                  `tick ${tickIndex}: expected 1 frame view, found ${views.length}`,
                );
                break;
              }
              views[0]!.props.onLayout({
                nativeEvent: {
                  layout: {
                    x: 0,
                    y: 0,
                    width: action.width,
                    height: action.height,
                  },
                },
              } as LayoutChangeEvent);
              pending.size = { width: action.width, height: action.height };
              break;
            }
            case 'tap': {
              const touchables = frameTouchables(renderer);
              if (touchables.length !== 1) {
                violations.push(
                  `tick ${tickIndex}: expected 1 frame touchable, found ${touchables.length}`,
                );
                break;
              }
              touchables[0]!.props.onPress({
                nativeEvent: { locationX: action.x, locationY: action.y },
              });
              // Closure sees the COMMITTED size + source dims.
              const size = committed.size;
              if (!size || size.width <= 0 || size.height <= 0) {
                ignoredPreLayoutTaps += 1;
                break;
              }
              const view = {
                x: Math.min(size.width, Math.max(0, action.x)),
                y: Math.min(size.height, Math.max(0, action.y)),
              };
              const source =
                committed.sourceW !== undefined &&
                committed.sourceH !== undefined
                  ? { width: committed.sourceW, height: committed.sourceH }
                  : null;
              pending.tap = {
                view,
                source: viewPointToSourcePoint(view, size, source),
              };
              break;
            }
            case 'confirm': {
              const nodes = pressables(renderer, ANALYZE);
              if (nodes.length !== 1) {
                violations.push(
                  `tick ${tickIndex}: expected 1 Analyze pressable, found ${nodes.length}`,
                );
                break;
              }
              const node = nodes[0]!;
              // RN Pressability never fires onPress for disabled === true.
              if (node.props.disabled === true) {
                droppedDisabledPresses += 1;
                if (committed.tap !== null) {
                  violations.push(
                    `tick ${tickIndex}: Analyze disabled while a seed is committed`,
                  );
                }
                break;
              }
              if (committed.tap === null) {
                violations.push(
                  `tick ${tickIndex}: Analyze enabled with no committed seed`,
                );
              }
              // Fake clock at press time (advance actions move it mid-tick).
              const iso = new Date().toISOString();
              node.props.onPress();
              if (committed.tap) {
                expectedConfirms.push({ ...committed.tap.source, iso });
              }
              break;
            }
            case 'skip': {
              const nodes = pressables(renderer, SKIP);
              if (nodes.length !== 1) {
                violations.push(
                  `tick ${tickIndex}: expected 1 Skip pressable, found ${nodes.length}`,
                );
                break;
              }
              if (nodes[0]!.props.disabled === true) {
                violations.push(`tick ${tickIndex}: Skip is disabled`);
                break;
              }
              nodes[0]!.props.onPress();
              expectedSkips += 1;
              break;
            }
            case 'pressIn':
            case 'pressOut': {
              const nodes = pressables(renderer, action.label);
              if (nodes.length !== 1) break;
              const handler =
                action.kind === 'pressIn'
                  ? nodes[0]!.props.onPressIn
                  : nodes[0]!.props.onPressOut;
              if (typeof handler === 'function') handler();
              break;
            }
            case 'imageError': {
              const images = renderer.root.findAllByType(Image);
              if (committed.previewFailed) {
                if (images.length !== 0) {
                  violations.push(
                    `tick ${tickIndex}: Image still mounted after preview failure`,
                  );
                }
                break;
              }
              if (images.length !== 1) {
                violations.push(
                  `tick ${tickIndex}: expected 1 Image, found ${images.length}`,
                );
                break;
              }
              images[0]!.props.onError({
                nativeEvent: { error: 'decode failed' },
              });
              pending.previewFailed = true;
              break;
            }
            case 'setSource': {
              pending.sourceW = action.w;
              pending.sourceH = action.h;
              renderer.update(<TargetSelector {...propsFor(pending)} />);
              break;
            }
            case 'setPoster': {
              pending.posterUri = action.posterUri;
              renderer.update(<TargetSelector {...propsFor(pending)} />);
              break;
            }
            case 'advance': {
              jest.advanceTimersByTime(action.ms);
              break;
            }
            case 'unmount': {
              renderer.unmount();
              pending.mounted = false;
              unmountedMidBurst = true;
              break;
            }
          }
        }
      });
    } catch (error) {
      violations.push(`tick ${tickIndex}: threw ${String(error)}`);
      break;
    }

    // Timers between ticks (the finger lifts, animations settle).
    act(() => {
      jest.advanceTimersByTime(16);
    });
    committed = pending;

    // ── callbacks emitted by this tick ──
    const newConfirms = confirmCalls.slice(confirmsBefore);
    const newSkips = skipCalls.length - skipsBefore;
    if (newSkips !== expectedSkips) {
      violations.push(
        `tick ${tickIndex}: onSkip ×${newSkips}, expected ×${expectedSkips}`,
      );
    }
    if (newConfirms.length !== expectedConfirms.length) {
      violations.push(
        `tick ${tickIndex}: onConfirm ×${newConfirms.length}, expected ×${expectedConfirms.length}`,
      );
    } else {
      newConfirms.forEach((selection, i) => {
        const expected = expectedConfirms[i]!;
        if (
          selection.point.x !== expected.x ||
          selection.point.y !== expected.y
        ) {
          violations.push(
            `tick ${tickIndex}: confirm[${i}] point ${JSON.stringify(
              selection.point,
            )} != oracle ${JSON.stringify(expected)}`,
          );
        }
        if (!isNormalized(selection.point)) {
          violations.push(
            `tick ${tickIndex}: confirm[${i}] point not normalized ${JSON.stringify(
              selection.point,
            )}`,
          );
        }
        if (selection.selectedAtIso !== expected.iso) {
          violations.push(
            `tick ${tickIndex}: selectedAtIso ${selection.selectedAtIso} != clock ${expected.iso}`,
          );
        }
      });
    }

    if (!committed.mounted) break;

    // ── rendered tree vs model ──
    const text = allText(renderer);
    const wantSelected = committed.tap !== null;
    if (wantSelected !== text.includes('Player selected')) {
      violations.push(
        `tick ${tickIndex}: status copy mismatch (seed ${wantSelected ? 'set' : 'null'})`,
      );
    }
    if (wantSelected === text.includes('Tap the player to analyze')) {
      violations.push(`tick ${tickIndex}: both/neither status lines rendered`);
    }
    const analyze = pressables(renderer, ANALYZE);
    const skip = pressables(renderer, SKIP);
    if (analyze.length !== 1 || skip.length !== 1) {
      violations.push(
        `tick ${tickIndex}: duplicate/missing buttons (analyze ${analyze.length}, skip ${skip.length})`,
      );
    } else {
      if (analyze[0]!.props.disabled !== !wantSelected) {
        violations.push(
          `tick ${tickIndex}: Analyze disabled=${analyze[0]!.props.disabled}, seed ${
            wantSelected ? 'set' : 'null'
          }`,
        );
      }
      if (analyze[0]!.props.accessibilityState?.disabled !== !wantSelected) {
        violations.push(`tick ${tickIndex}: Analyze accessibilityState stale`);
      }
    }
    if (frameTouchables(renderer).length !== 1) {
      violations.push(`tick ${tickIndex}: frame touchable count != 1`);
    }
    const rings = ringCircles(renderer);
    const wantRing = committed.tap !== null && committed.size !== null;
    if (rings.length !== (wantRing ? 1 : 0)) {
      violations.push(
        `tick ${tickIndex}: ring count ${rings.length}, expected ${wantRing ? 1 : 0}`,
      );
    } else if (wantRing) {
      const ring = rings[0]!;
      if (
        ring.props.cx !== committed.tap!.view.x ||
        ring.props.cy !== committed.tap!.view.y
      ) {
        violations.push(
          `tick ${tickIndex}: ring at (${ring.props.cx},${ring.props.cy}) != tap view ${JSON.stringify(
            committed.tap!.view,
          )}`,
        );
      }
    }
    const images = renderer.root.findAllByType(Image);
    if (committed.previewFailed) {
      if (images.length !== 0 || !text.includes('Preview unavailable')) {
        violations.push(`tick ${tickIndex}: preview fallback not rendered`);
      }
    } else {
      if (images.length !== 1) {
        violations.push(
          `tick ${tickIndex}: expected 1 Image, found ${images.length}`,
        );
      } else {
        const wantUri = committed.posterUri ?? FRAME_URI;
        if (images[0]!.props.source?.uri !== wantUri) {
          violations.push(
            `tick ${tickIndex}: image uri ${images[0]!.props.source?.uri} != ${wantUri}`,
          );
        }
      }
      if (text.includes('Preview unavailable')) {
        violations.push(
          `tick ${tickIndex}: fallback copy shown with live image`,
        );
      }
    }
  }

  if (committed.mounted) {
    act(() => renderer.unmount());
  }
  act(() => {
    jest.runOnlyPendingTimers();
  });

  if (consoleLog.length > 0) {
    violations.push(...consoleLog.map(line => `console ${line}`));
    consoleLog.length = 0;
  }
  if (rejections.length > 0) {
    violations.push(...rejections.map(line => `unhandledRejection ${line}`));
    rejections.length = 0;
  }

  return {
    seed,
    ticks: burst.length,
    actions,
    confirms: confirmCalls.length,
    skips: skipCalls.length,
    droppedDisabledPresses,
    ignoredPreLayoutTaps,
    unmountedMidBurst,
    status: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
    burst,
  };
}

// ─── consumer model (AnalyzeScreen lines ~1393–1404 + scoringActive guard) ──

interface ConsumerLedger {
  starts: Array<{ seed: TargetSelection | null }>;
  confirmCalls: number;
  skipCalls: number;
}

function ConsumerHost(props: {
  ledger: ConsumerLedger;
  sourceWidth?: number;
  sourceHeight?: number;
}) {
  const [phase, setPhase] = useState<'review' | 'working'>('review');
  const [targetSeed, setTargetSeed] = useState<TargetSelection | null>(null);
  const scoringActive = useRef(false);
  const score = (seed: TargetSelection | null) => {
    if (scoringActive.current) return;
    scoringActive.current = true;
    props.ledger.starts.push({ seed });
    setPhase('working');
  };
  if (phase === 'working') {
    return (
      <View testID="working">
        <Text>{targetSeed ? 'seeded' : 'unseeded'}</Text>
      </View>
    );
  }
  return (
    <TargetSelector
      frameUri={FRAME_URI}
      posterUri={POSTERS[1]}
      sourceWidth={props.sourceWidth}
      sourceHeight={props.sourceHeight}
      onConfirm={selection => {
        props.ledger.confirmCalls += 1;
        setTargetSeed(selection);
        score(selection);
      }}
      onSkip={() => {
        props.ledger.skipCalls += 1;
        score(null);
      }}
    />
  );
}

interface ConsumerOutcome {
  seed: number;
  actions: number;
  starts: number;
  startedWith: 'confirm' | 'skip' | null;
  confirmCalls: number;
  skipCalls: number;
  seedStateDisagreesWithStart: boolean;
  status: 'HELD' | 'BROKEN';
  violations: string[];
}

function runConsumerBurst(seed: number): ConsumerOutcome {
  const burst = genBurst(seed);
  const violations: string[] = [];
  const ledger: ConsumerLedger = { starts: [], confirmCalls: 0, skipCalls: 0 };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <ConsumerHost ledger={ledger} sourceWidth={1920} sourceHeight={1080} />,
    );
  });
  let actions = 0;
  let mounted = true;
  let lastAcceptedIntent: 'confirm' | 'skip' | null = null;
  let seedStateDisagreesWithStart = false;

  for (const [tickIndex, tick] of burst.entries()) {
    if (!mounted) break;
    const startsBefore = ledger.starts.length;
    let firstIntentThisTick: 'confirm' | 'skip' | null = null;
    try {
      act(() => {
        for (const action of tick) {
          if (!mounted) break;
          actions += 1;
          switch (action.kind) {
            case 'layout': {
              const views = frameViews(renderer);
              if (views.length === 1) {
                views[0]!.props.onLayout({
                  nativeEvent: {
                    layout: {
                      x: 0,
                      y: 0,
                      width: action.width,
                      height: action.height,
                    },
                  },
                } as LayoutChangeEvent);
              }
              break;
            }
            case 'tap': {
              const touchables = frameTouchables(renderer);
              if (touchables.length === 1) {
                touchables[0]!.props.onPress({
                  nativeEvent: { locationX: action.x, locationY: action.y },
                });
              }
              break;
            }
            case 'confirm': {
              const nodes = pressables(renderer, ANALYZE);
              if (nodes.length === 1 && nodes[0]!.props.disabled !== true) {
                nodes[0]!.props.onPress();
                if (firstIntentThisTick === null)
                  firstIntentThisTick = 'confirm';
              }
              break;
            }
            case 'skip': {
              const nodes = pressables(renderer, SKIP);
              if (nodes.length === 1 && nodes[0]!.props.disabled !== true) {
                nodes[0]!.props.onPress();
                if (firstIntentThisTick === null) firstIntentThisTick = 'skip';
              }
              break;
            }
            case 'pressIn':
            case 'pressOut': {
              const nodes = pressables(renderer, action.label);
              if (nodes.length !== 1) break;
              const handler =
                action.kind === 'pressIn'
                  ? nodes[0]!.props.onPressIn
                  : nodes[0]!.props.onPressOut;
              if (typeof handler === 'function') handler();
              break;
            }
            case 'imageError': {
              const images = renderer.root.findAllByType(Image);
              if (images.length === 1) {
                images[0]!.props.onError({ nativeEvent: { error: 'decode' } });
              }
              break;
            }
            case 'setSource': {
              renderer.update(
                <ConsumerHost
                  ledger={ledger}
                  sourceWidth={action.w}
                  sourceHeight={action.h}
                />,
              );
              break;
            }
            case 'setPoster':
              break;
            case 'advance':
              jest.advanceTimersByTime(action.ms);
              break;
            case 'unmount':
              renderer.unmount();
              mounted = false;
              break;
          }
        }
      });
    } catch (error) {
      violations.push(`tick ${tickIndex}: threw ${String(error)}`);
      break;
    }
    act(() => {
      jest.advanceTimersByTime(16);
    });
    if (!mounted) break;

    const newStarts = ledger.starts.slice(startsBefore);
    if (newStarts.length > 1) {
      violations.push(
        `tick ${tickIndex}: ${newStarts.length} analyses started`,
      );
    }
    if (newStarts.length === 1) {
      if (lastAcceptedIntent !== null) {
        violations.push(
          `tick ${tickIndex}: second analysis start in the burst`,
        );
      }
      lastAcceptedIntent = firstIntentThisTick;
      const start = newStarts[0]!;
      if (firstIntentThisTick === 'confirm' && start.seed === null) {
        violations.push(
          `tick ${tickIndex}: confirm won but analysis started unseeded`,
        );
      }
      if (firstIntentThisTick === 'skip' && start.seed !== null) {
        violations.push(
          `tick ${tickIndex}: skip won but analysis started seeded`,
        );
      }
      if (start.seed && !isNormalized(start.seed.point)) {
        violations.push(`tick ${tickIndex}: analysis seed not normalized`);
      }
      // After the first accepted call the selector must be gone.
      if (
        pressables(renderer).length !== 0 ||
        frameTouchables(renderer).length !== 0
      ) {
        violations.push(
          `tick ${tickIndex}: selector still mounted after analysis start`,
        );
      }
      const text = allText(renderer);
      const stateSeeded = text.includes('seeded') && !text.includes('unseeded');
      if (stateSeeded !== (start.seed !== null)) {
        // Skip-first + confirm in the same batch: state retains a seed the
        // run never received. Recorded, judged in the campaign summary.
        seedStateDisagreesWithStart = true;
      }
    } else if (firstIntentThisTick !== null && lastAcceptedIntent === null) {
      violations.push(
        `tick ${tickIndex}: ${firstIntentThisTick} pressed but no analysis started`,
      );
    }
  }

  if (mounted) act(() => renderer.unmount());
  act(() => {
    jest.runOnlyPendingTimers();
  });
  if (consoleLog.length > 0) {
    violations.push(...consoleLog.map(line => `console ${line}`));
    consoleLog.length = 0;
  }
  if (rejections.length > 0) {
    violations.push(...rejections.map(line => `unhandledRejection ${line}`));
    rejections.length = 0;
  }
  return {
    seed,
    actions,
    starts: ledger.starts.length,
    startedWith: lastAcceptedIntent,
    confirmCalls: ledger.confirmCalls,
    skipCalls: ledger.skipCalls,
    seedStateDisagreesWithStart,
    status: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
  };
}

// ─── campaign ───────────────────────────────────────────────────────────────

function seeds(): number[] {
  if (ONLY_SEED !== null) return [ONLY_SEED];
  return Array.from({ length: ITER }, (_, i) => BASE_SEED + i);
}

function writeTable(name: string, rows: unknown[], summary: unknown) {
  if (!OUT_DIR) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, `${name}.json`),
    JSON.stringify({ summary, rows }, null, 2),
  );
}

describe('TargetSelector rapid-interaction stress', () => {
  it(`isolated component holds its contract across ${seeds().length} seeded bursts`, () => {
    const outcomes = seeds().map(runIsolatedBurst);
    const broken = outcomes.filter(o => o.status === 'BROKEN');
    const summary = {
      component: 'TargetSelector',
      harness: 'isolated-oracle',
      seeds: outcomes.length,
      ticks: outcomes.reduce((n, o) => n + o.ticks, 0),
      actions: outcomes.reduce((n, o) => n + o.actions, 0),
      confirms: outcomes.reduce((n, o) => n + o.confirms, 0),
      skips: outcomes.reduce((n, o) => n + o.skips, 0),
      droppedDisabledPresses: outcomes.reduce(
        (n, o) => n + o.droppedDisabledPresses,
        0,
      ),
      ignoredPreLayoutTaps: outcomes.reduce(
        (n, o) => n + o.ignoredPreLayoutTaps,
        0,
      ),
      unmountedMidBurst: outcomes.filter(o => o.unmountedMidBurst).length,
      broken: broken.map(o => o.seed),
    };
    writeTable(
      'targetSelector.isolated',
      outcomes.map(({ burst, ...row }) => ({
        ...row,
        burst: burst.map(tick => tick.map(a => a.kind).join('+')).join(' | '),
      })),
      summary,
    );
    expect(
      broken.map(o => ({ seed: o.seed, violations: o.violations })),
    ).toEqual([]);
  });

  it(`AnalyzeScreen-style consumer starts at most one analysis per burst across ${seeds().length} seeds`, () => {
    const outcomes = seeds().map(runConsumerBurst);
    const broken = outcomes.filter(o => o.status === 'BROKEN');
    const summary = {
      component: 'TargetSelector',
      harness: 'consumer-model',
      seeds: outcomes.length,
      actions: outcomes.reduce((n, o) => n + o.actions, 0),
      burstsThatStarted: outcomes.filter(o => o.starts > 0).length,
      startedByConfirm: outcomes.filter(o => o.startedWith === 'confirm')
        .length,
      startedBySkip: outcomes.filter(o => o.startedWith === 'skip').length,
      totalConfirmCallbacks: outcomes.reduce((n, o) => n + o.confirmCalls, 0),
      totalSkipCallbacks: outcomes.reduce((n, o) => n + o.skipCalls, 0),
      seedStateDisagreesWithStart: outcomes
        .filter(o => o.seedStateDisagreesWithStart)
        .map(o => o.seed),
      broken: broken.map(o => o.seed),
    };
    writeTable('targetSelector.consumer', outcomes, summary);
    expect(outcomes.every(o => o.starts <= 1)).toBe(true);
    expect(
      broken.map(o => ({ seed: o.seed, violations: o.violations })),
    ).toEqual([]);
  });

  it('a burst replays identically from its seed', () => {
    const seed = BASE_SEED + 7;
    expect(genBurst(seed)).toEqual(genBurst(seed));
    const a = runIsolatedBurst(seed);
    const b = runIsolatedBurst(seed);
    expect(a).toEqual(b);
  });
});
