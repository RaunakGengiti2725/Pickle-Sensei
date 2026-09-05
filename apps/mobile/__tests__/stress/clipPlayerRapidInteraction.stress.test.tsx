import React from 'react';
import { Image, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { writeFileSync } from 'node:fs';

/**
 * RAPID / CONCURRENT INTERACTION stress campaign for ClipPlayer.
 *
 * ClipPlayer is the JS face of the native PickleClipPlayerView: it forwards
 * `playing` / `seekMs` / `rate` / `sourceUri` and unwraps native events. A
 * seeded generator drives play/pause flip bursts, seek spam (including
 * repeated, negative and non-finite values), rate spam, source and poster
 * swaps, handler swaps, and native event bursts that land in the same React
 * batch as prop changes — then unmounts and fires late events. The
 * degraded (no native view) mode gets the same prop storm.
 *
 *   STRESS_ITER  iterations per campaign (default 40)
 *   STRESS_SEED  base seed (default 20260904)
 *   STRESS_OUT   optional JSON path for the seed → outcome table
 *   STRESS_ONLY  comma-separated seeds to replay
 *
 * Invariants:
 *   K1  exactly one native view is mounted and it is never remounted by a
 *       prop change (a remount would reset the AVPlayer)
 *   K2  after every burst the native props equal the latest intent:
 *       sourceUri, playing, seekMs, resizeMode (default cover), rate
 *       sanitised to a positive finite number (default 1)
 *   K3  every native event reaches the COMMITTED handler exactly once with the
 *       unwrapped payload; a missing error message reads "unreadable";
 *       absent handlers never throw
 *   K4  nothing throws, no console.error (act warnings included)
 *   K5  unmount removes the native view; late native events are harmless
 *   D1  degraded mode: poster Image iff posterUri, otherwise one plain View,
 *       never a native view, never both
 */

const NATIVE = 'PickleClipPlayerView';

interface NativeMount {
  alive: boolean;
}

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32)
// ---------------------------------------------------------------------------

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
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[this.int(items.length)] as T;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type ResizeMode = 'cover' | 'contain';

type Action =
  | { kind: 'playing'; flips: boolean[] }
  | { kind: 'seek'; values: number[] }
  | { kind: 'rate'; value: number | undefined }
  | { kind: 'uri'; index: number }
  | { kind: 'poster'; index: number }
  | { kind: 'resize'; mode: ResizeMode | undefined }
  | { kind: 'handlers'; present: boolean }
  | {
      kind: 'events';
      events: Array<
        | { type: 'progress'; positionMs: number }
        | { type: 'load'; durationMs: number }
        | { type: 'end' }
        | { type: 'error'; message: string | undefined }
      >;
    }
  | { kind: 'batch'; actions: Action[] };

const URIS: readonly string[] = [
  'file:///clips/cap-1.mov',
  'file:///clips/cap-2.mov',
  'file:///clips/cap-3.mov',
];
const POSTERS: ReadonlyArray<string | undefined> = [
  undefined,
  'file:///clips/cap-1.jpg',
  'file:///clips/cap-2.jpg',
];
const SEEKS: readonly number[] = [
  -1,
  0,
  0,
  0.01,
  500,
  500,
  1250,
  4200,
  99999,
  -50,
  Number.NaN,
];
const RATES: ReadonlyArray<number | undefined> = [
  undefined,
  1,
  0.5,
  2,
  0,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
];

function genEvents(rng: Rng): Extract<Action, { kind: 'events' }> {
  const count = 1 + rng.int(4);
  const events: Extract<Action, { kind: 'events' }>['events'] = [];
  for (let i = 0; i < count; i += 1) {
    const roll = rng.int(10);
    if (roll < 5) events.push({ type: 'progress', positionMs: rng.int(5000) });
    else if (roll < 7)
      events.push({ type: 'load', durationMs: 1 + rng.int(9000) });
    else if (roll < 9) events.push({ type: 'end' });
    else {
      events.push({
        type: 'error',
        message: rng.pick(['decode failed', 'unreadable', undefined] as const),
      });
    }
  }
  return { kind: 'events', events };
}

function genAction(rng: Rng, depth: number): Action {
  const roll = rng.int(100);
  if (roll < 18) {
    const flips: boolean[] = [];
    const count = 1 + rng.int(3);
    for (let i = 0; i < count; i += 1) flips.push(rng.int(2) === 1);
    return { kind: 'playing', flips };
  }
  if (roll < 38) {
    const values: number[] = [];
    const count = 1 + rng.int(3);
    for (let i = 0; i < count; i += 1) values.push(rng.pick(SEEKS));
    return { kind: 'seek', values };
  }
  if (roll < 48) return { kind: 'rate', value: rng.pick(RATES) };
  if (roll < 55) return { kind: 'uri', index: rng.int(URIS.length) };
  if (roll < 62) return { kind: 'poster', index: rng.int(POSTERS.length) };
  if (roll < 68) {
    return {
      kind: 'resize',
      mode: rng.pick(['cover', 'contain', undefined] as const),
    };
  }
  if (roll < 75) return { kind: 'handlers', present: rng.int(4) !== 0 };
  if (roll < 92 || depth > 0) return genEvents(rng);
  const size = 2 + rng.int(2);
  const actions: Action[] = [];
  for (let i = 0; i < size; i += 1) actions.push(genAction(rng, 1));
  return { kind: 'batch', actions };
}

function genBurst(rng: Rng): Action[] {
  const length = 4 + rng.int(10);
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) actions.push(genAction(rng, 0));
  return actions;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;
type ClipPlayerModule = typeof import('../../src/components/ClipPlayer');

interface Violation {
  invariant: string;
  step: number;
  action: string;
  detail: string;
}

interface Outcome {
  seed: number;
  mode: 'native' | 'degraded';
  actions: number;
  interactions: number;
  violations: Violation[];
  outcome: 'HELD' | 'BROKEN';
  script: Action[];
}

interface Handlers {
  onProgress: jest.Mock;
  onLoad: jest.Mock;
  onEnd: jest.Mock;
  onError: jest.Mock;
}

interface Intent {
  uri: string;
  posterUri: string | undefined;
  playing: boolean;
  seekMs: number;
  rate: number | undefined;
  resizeMode: ResizeMode | undefined;
  handlers: Handlers | null;
}

function sanitizedRate(rate: number | undefined): number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0
    ? rate
    : 1;
}

function makeHandlers(): Handlers {
  return {
    onProgress: jest.fn(),
    onLoad: jest.fn(),
    onEnd: jest.fn(),
    onError: jest.fn(),
  };
}

function nativeNodes(renderer: Renderer): Instance[] {
  return renderer.root.findAll(n => (n.type as unknown) === NATIVE);
}

function loadNativeModule(mounts: NativeMount[]): ClipPlayerModule {
  let loaded!: ClipPlayerModule;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => {
      const actual =
        jest.requireActual<typeof import('react-native')>('react-native');
      // A mount-counting stand-in for the native view: any remount shows up
      // as a second ledger entry. Hooks must come from the React instance
      // that owns the test renderer (the outer one), not the isolated copy.
      const NativeView = (props: Record<string, unknown>) => {
        React.useEffect(() => {
          const entry: NativeMount = { alive: true };
          mounts.push(entry);
          return () => {
            entry.alive = false;
          };
        }, []);
        return React.createElement(NATIVE, props);
      };
      const overrides: Record<string, unknown> = {
        UIManager: {
          getViewManagerConfig: (name: string) =>
            name === NATIVE ? { Commands: {} } : null,
        },
        requireNativeComponent: (name: string) =>
          name === NATIVE ? NativeView : name,
      };
      return new Proxy(actual, {
        get: (target, prop: string) =>
          prop in overrides
            ? overrides[prop]
            : (target as unknown as Record<string, unknown>)[prop],
      });
    });
    loaded = require('../../src/components/ClipPlayer');
  });
  jest.dontMock('react-native');
  return loaded;
}

function loadDegradedModule(): ClipPlayerModule {
  let loaded!: ClipPlayerModule;
  jest.isolateModules(() => {
    loaded = require('../../src/components/ClipPlayer');
  });
  return loaded;
}

async function runIteration(
  seed: number,
  mode: 'native' | 'degraded',
  ClipPlayer: ClipPlayerModule['ClipPlayer'],
  mounts: NativeMount[],
): Promise<Outcome> {
  const rng = new Rng(seed);
  const script = genBurst(rng);
  const violations: Violation[] = [];
  let interactions = 0;
  let step = 0;
  let stepLabel = 'mount';
  const record = (invariant: string, detail: string) => {
    violations.push({ invariant, step, action: stepLabel, detail });
  };

  const consoleErrors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(a => String(a)).join(' '));
    });

  const intent: Intent = {
    uri: URIS[rng.int(URIS.length)] ?? 'file:///clips/cap-1.mov',
    posterUri: POSTERS[rng.int(POSTERS.length)],
    playing: rng.int(2) === 1,
    seekMs: -1,
    rate: undefined,
    resizeMode: undefined,
    handlers: makeHandlers(),
  };
  mounts.length = 0;

  const element = () => (
    <ClipPlayer
      uri={intent.uri}
      {...(intent.posterUri !== undefined
        ? { posterUri: intent.posterUri }
        : {})}
      playing={intent.playing}
      seekMs={intent.seekMs}
      {...(intent.rate !== undefined ? { rate: intent.rate } : {})}
      {...(intent.resizeMode !== undefined
        ? { resizeMode: intent.resizeMode }
        : {})}
      {...(intent.handlers ?? {})}
    />
  );

  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(element());
  });

  // Expected per-handler call ledger (payloads in order).
  const expectedCalls = new Map<jest.Mock, unknown[][]>();
  const expectCall = (handler: jest.Mock | undefined, args: unknown[]) => {
    if (!handler) return;
    const list = expectedCalls.get(handler) ?? [];
    list.push(args);
    expectedCalls.set(handler, list);
  };

  const check = () => {
    const natives = nativeNodes(renderer);
    const images = renderer.root.findAllByType(Image);
    if (mode === 'native') {
      if (natives.length !== 1)
        record('K1', `${natives.length} native views in tree`);
      if (mounts.length !== 1 || mounts.filter(m => m.alive).length !== 1) {
        record(
          'K1',
          `native view mounted ${mounts.length}× (alive ${mounts.filter(m => m.alive).length})`,
        );
      }
      if (images.length !== 0)
        record(
          'K1',
          `${images.length} poster Image(s) drawn over the native view`,
        );
      const [native] = natives;
      if (native) {
        const want = {
          sourceUri: intent.uri,
          playing: intent.playing,
          seekMs: intent.seekMs,
          resizeMode: intent.resizeMode ?? 'cover',
          rate: sanitizedRate(intent.rate),
        };
        const got = {
          sourceUri: native.props.sourceUri,
          playing: native.props.playing,
          seekMs: native.props.seekMs,
          resizeMode: native.props.resizeMode,
          rate: native.props.rate,
        };
        for (const key of Object.keys(want) as Array<keyof typeof want>) {
          if (!Object.is(want[key], got[key])) {
            record(
              'K2',
              `${key}: native ${String(got[key])}, intent ${String(want[key])}`,
            );
          }
        }
      }
    } else {
      if (natives.length !== 0)
        record('D1', `${natives.length} native views in degraded mode`);
      if (intent.posterUri !== undefined) {
        const [image] = images;
        if (
          images.length !== 1 ||
          image?.props.source?.uri !== intent.posterUri
        ) {
          record(
            'D1',
            `poster ${intent.posterUri} expected, got ${images.length} image(s) ${JSON.stringify(image?.props.source)}`,
          );
        }
        if (
          image &&
          image.props.resizeMode !== (intent.resizeMode ?? 'cover')
        ) {
          record('D1', `poster resizeMode ${image.props.resizeMode}`);
        }
      } else {
        if (images.length !== 0)
          record('D1', `${images.length} image(s) without a poster`);
        if (renderer.root.findAllByType(View).length !== 1) {
          record(
            'D1',
            `${renderer.root.findAllByType(View).length} Views for the blank surface`,
          );
        }
      }
    }
    for (const [handler, calls] of expectedCalls) {
      const actual = handler.mock.calls;
      if (JSON.stringify(actual) !== JSON.stringify(calls)) {
        record(
          'K3',
          `handler received ${JSON.stringify(actual).slice(0, 160)}, expected ${JSON.stringify(calls).slice(0, 160)}`,
        );
        expectedCalls.set(
          handler,
          actual.map(c => [...c]),
        );
      }
    }
  };

  const fireOne = (
    action: Action,
    nativeAtStart: Instance | null,
    committedHandlers: Handlers | null,
  ) => {
    switch (action.kind) {
      case 'playing':
        interactions += action.flips.length;
        for (const flip of action.flips) {
          intent.playing = flip;
          renderer.update(element());
        }
        return;
      case 'seek':
        interactions += action.values.length;
        for (const value of action.values) {
          intent.seekMs = value;
          renderer.update(element());
        }
        return;
      case 'rate':
        interactions += 1;
        intent.rate = action.value;
        renderer.update(element());
        return;
      case 'uri':
        interactions += 1;
        intent.uri = URIS[action.index] ?? intent.uri;
        renderer.update(element());
        return;
      case 'poster':
        interactions += 1;
        intent.posterUri = POSTERS[action.index];
        renderer.update(element());
        return;
      case 'resize':
        interactions += 1;
        intent.resizeMode = action.mode;
        renderer.update(element());
        return;
      case 'handlers':
        interactions += 1;
        intent.handlers = action.present ? makeHandlers() : null;
        renderer.update(element());
        return;
      case 'events': {
        if (mode !== 'native') return;
        const native = nativeAtStart ?? nativeNodes(renderer)[0] ?? null;
        if (!native) return;
        // Events reach the handlers COMMITTED when they fire: inside one
        // batch (act) a prop change queued earlier has not committed yet, so
        // the native view still calls the previous render's callbacks.
        const handlers = committedHandlers;
        for (const event of action.events) {
          interactions += 1;
          switch (event.type) {
            case 'progress':
              native.props.onClipProgress({
                nativeEvent: { positionMs: event.positionMs },
              });
              expectCall(handlers?.onProgress, [event.positionMs]);
              break;
            case 'load':
              native.props.onClipLoad({
                nativeEvent: { durationMs: event.durationMs },
              });
              expectCall(handlers?.onLoad, [event.durationMs]);
              break;
            case 'end':
              native.props.onClipEnd();
              expectCall(handlers?.onEnd, []);
              break;
            case 'error':
              native.props.onClipError({
                nativeEvent:
                  event.message === undefined ? {} : { message: event.message },
              });
              expectCall(handlers?.onError, [event.message ?? 'unreadable']);
              break;
          }
        }
        return;
      }
      case 'batch':
        return;
    }
  };

  const run = async (action: Action) => {
    stepLabel = JSON.stringify(action);
    const nativeAtStart = nativeNodes(renderer)[0] ?? null;
    const committedHandlers = intent.handlers;
    await act(async () => {
      if (action.kind === 'batch') {
        for (const inner of action.actions)
          fireOne(inner, nativeAtStart, committedHandlers);
      } else {
        fireOne(action, null, committedHandlers);
      }
    });
    check();
  };

  try {
    check();
    for (const action of script) {
      step += 1;
      await run(action);
    }
    step += 1;
    stepLabel = 'unmount';
    const lastNative = nativeNodes(renderer)[0] ?? null;
    const lastProps = lastNative ? { ...lastNative.props } : null;
    await act(async () => {
      renderer.unmount();
    });
    if (mode === 'native' && mounts.some(m => m.alive)) {
      record('K5', 'native view survives unmount');
    }
    if (renderer.toJSON() !== null) record('K5', 'tree survives unmount');
    if (lastProps) {
      step += 1;
      stepLabel = 'late-events';
      await act(async () => {
        lastProps.onClipProgress({ nativeEvent: { positionMs: 1 } });
        lastProps.onClipEnd();
        lastProps.onClipError({ nativeEvent: {} });
      });
      interactions += 3;
    }
  } catch (error) {
    record(
      'K4',
      `threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  } finally {
    errorSpy.mockRestore();
  }
  if (consoleErrors.length > 0) {
    record('K4', `console.error: ${consoleErrors.join(' || ').slice(0, 400)}`);
  }

  return {
    seed,
    mode,
    actions: script.length,
    interactions,
    violations,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    script,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const ITER = Number(process.env.STRESS_ITER ?? 40);
const BASE_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const ONLY = (process.env.STRESS_ONLY ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);

function seeds(): number[] {
  return ONLY.length > 0
    ? ONLY
    : Array.from({ length: ITER }, (_, i) => BASE_SEED + i);
}

function summarize(outcomes: Outcome[], mode: 'native' | 'degraded') {
  const broken = outcomes.filter(o => o.outcome === 'BROKEN');
  return {
    unit: 'cmp-players/ClipPlayer',
    lens: 'rapid-interaction',
    mode,
    baseSeed: BASE_SEED,
    iterations: outcomes.length,
    interactions: outcomes.reduce((n, o) => n + o.interactions, 0),
    held: outcomes.length - broken.length,
    broken: broken.length,
    brokenByFirstInvariant: broken.reduce<Record<string, number[]>>(
      (acc, o) => {
        const key = o.violations[0]?.invariant ?? '?';
        (acc[key] ??= []).push(o.seed);
        return acc;
      },
      {},
    ),
    results: outcomes.map(o => ({
      seed: o.seed,
      outcome: o.outcome,
      actions: o.actions,
      interactions: o.interactions,
      firstViolation: o.violations[0],
      violations: o.violations,
      script: o.outcome === 'BROKEN' ? o.script : undefined,
    })),
  };
}

function assertAllHeld(outcomes: Outcome[]) {
  const broken = outcomes.filter(o => o.outcome === 'BROKEN');
  const summary = broken
    .slice(0, 12)
    .map(
      o =>
        `seed ${o.seed}: ${o.violations
          .map(
            v =>
              `[${v.invariant} @${v.step} ${v.action.slice(0, 90)}] ${v.detail}`,
          )
          .join('; ')}`,
    )
    .join('\n');
  expect(`${broken.length} broken\n${summary}`).toBe('0 broken\n');
}

describe('ClipPlayer — rapid/concurrent interaction campaign', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it(`native view: holds K1–K5 across ${seeds().length} seeded bursts`, async () => {
    const mounts: NativeMount[] = [];
    const { ClipPlayer, clipPlaybackAvailable } = loadNativeModule(mounts);
    expect(clipPlaybackAvailable()).toBe(true);
    const outcomes: Outcome[] = [];
    for (const seed of seeds()) {
      outcomes.push(await runIteration(seed, 'native', ClipPlayer, mounts));
    }
    if (process.env.STRESS_OUT) {
      writeFileSync(
        process.env.STRESS_OUT.replace(/\.json$/, '') + '.native.json',
        JSON.stringify(summarize(outcomes, 'native'), null, 2),
      );
    }
    assertAllHeld(outcomes);
  }, 600000);

  it(`degraded (no native view): holds D1 + K4 across ${seeds().length} seeded bursts`, async () => {
    const { ClipPlayer, clipPlaybackAvailable } = loadDegradedModule();
    expect(clipPlaybackAvailable()).toBe(false);
    const outcomes: Outcome[] = [];
    for (const seed of seeds()) {
      outcomes.push(await runIteration(seed, 'degraded', ClipPlayer, []));
    }
    if (process.env.STRESS_OUT) {
      writeFileSync(
        process.env.STRESS_OUT.replace(/\.json$/, '') + '.degraded.json',
        JSON.stringify(summarize(outcomes, 'degraded'), null, 2),
      );
    }
    assertAllHeld(outcomes);
  }, 600000);
});
