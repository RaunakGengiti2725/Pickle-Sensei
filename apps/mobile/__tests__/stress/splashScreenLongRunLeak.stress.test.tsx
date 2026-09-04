/**
 * STRESS `scr-splashscreen` / lens `long-run-leak` — component campaign.
 *
 * Mounts the REAL `SplashScreen` (real Animated, real `useReducedMotion`
 * observer, real StatusBar stack entries, real PressableScale) inside the
 * same provider shell App.tsx wraps it in (SafeAreaProvider +
 * QueryClientProvider + the dark host View), then drives a seeded lifecycle
 * grammar N times in ONE process:
 *
 *   ready-at-mount / ready-later / never-ready
 *   × intro ends by onEnd / onError / watchdog / not at all
 *   × 0..N onProgress ticks (Skip reveal + its fade-in animation)
 *   × Skip pressed / not pressed
 *   × reduced motion on / off
 *   × prop-identity re-renders mid-flight
 *   × teardown before the exit / mid cross-fade / after the handoff
 *
 * Every iteration is replayable from its seed (STRESS_SEED=<n>). After each
 * one the unit must have returned the process to baseline: pending fake
 * timers, StatusBar stack depth, live Animated listeners and the
 * AccessibilityInfo subscription count must all match the pre-mount values,
 * and `onFinished` must never fire after the unit is gone. Heap, libuv
 * handles and wall-clock render time are sampled every 50 iterations; a
 * monotone heap slope > 5 % per 100 iterations (after forced GC) is a
 * finding, as is render-time drift.
 *
 * Default is a quick 40-iteration smoke so the suite stays fast. Campaign:
 *
 *   cd apps/mobile && STRESS_ITER=500 node --expose-gc node_modules/.bin/jest \
 *     --ci --silent __tests__/stress/splashScreenLongRunLeak.stress.test.tsx
 *
 * Artifacts land in `<repo>/artifacts/xc-lifecycle-persistence/` (override
 * with XC_ARTIFACT_DIR): `splash-leak.rows.json` (seed → outcome),
 * `splash-leak.heap.json`, `splash-leak.summary.json`, `splash-leak.md`.
 */
import React from 'react';
import {
  AccessibilityInfo,
  Animated,
  NativeModules,
  StatusBar,
  View,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import {
  EXIT_MS,
  SKIP_AFTER_S,
  SplashScreen,
  WATCHDOG_MS,
} from '../../src/screens/SplashScreen';
import { color } from '../../src/design/tokens';
import { makePrng } from '../../xc-harness/lifecycle-persistence/seeds';
import {
  heapSnapshot,
  matrixMarkdown,
  summarize,
  writeJsonArtifact,
  writeTextArtifact,
  type MatrixRow,
} from '../../xc-harness/lifecycle-persistence/artifacts';
import {
  HEAP_CHECKPOINT_EVERY,
  driftReport,
  gcExposed,
  heapSample,
  keepMockHistory,
  realNowMs,
  slopeReport,
  stressIterations,
  stressSeedFilter,
  trackAnimatedListeners,
  type AnimatedListenerLedger,
  type HeapSample,
  type ListenerHost,
} from '../../stress-harness/leakProbe';

// The library's own jest mock: real contexts/hooks, provider without the
// native measuring view.
jest.mock(
  'react-native-safe-area-context',
  () =>
    jest.requireActual<{ default: unknown }>(
      'react-native-safe-area-context/jest/mock',
    ).default,
);

type Renderer = TestRenderer.ReactTestRenderer;

// ─── Scenario grammar ────────────────────────────────────────────────────────

type IntroKind = 'end' | 'error' | 'watchdog' | 'none';
type Teardown = 'complete' | 'mid-exit' | 'before-exit';

interface Scenario {
  seed: number;
  /** 0 = ready from the first frame; null = hydration never completes. */
  readyAtMs: number | null;
  reducedMotion: boolean;
  /** onProgress ticks are fired every 100 ms of fake time until this point. */
  progressUntilMs: number;
  intro: { kind: IntroKind; atMs: number };
  /** Skip is pressed here if the control is visible by then. */
  skipAtMs: number | null;
  /** Prop-identity re-renders (fresh onFinished closure) at these times. */
  rerenderAtMs: number[];
  teardown: Teardown;
  /** For mid-exit: fraction of EXIT_MS elapsed before the unmount. */
  cutFraction: number;
  /** For before-exit: ms after mount at which the unit is torn down. */
  cutAtMs: number;
}

function seededScenario(seed: number): Scenario {
  const rnd = makePrng(seed);
  const pick = <T,>(items: readonly T[]): T =>
    items[Math.floor(rnd() * items.length)]!;
  const int = (min: number, max: number) =>
    min + Math.floor(rnd() * (max - min + 1));

  const readyMode = pick(['mount', 'mount', 'later', 'later', 'never']);
  const readyAtMs =
    readyMode === 'mount' ? 0 : readyMode === 'later' ? int(50, 4000) : null;
  const introKind = pick<IntroKind>([
    'end',
    'end',
    'end',
    'error',
    'watchdog',
    'none',
  ]);
  const introAtMs =
    introKind === 'watchdog'
      ? WATCHDOG_MS
      : introKind === 'none'
        ? Number.POSITIVE_INFINITY
        : int(200, 5000);
  const progressUntilMs = Math.min(
    int(0, 4000),
    Number.isFinite(introAtMs) ? introAtMs : 4000,
  );
  // Always on a half-tick so a press never coincides with a progress tick.
  const skipAtMs = rnd() < 0.4 ? int(3, 45) * 100 + 50 : null;
  const rerenderCount = pick([0, 0, 1, 2, 3]);
  const rerenderAtMs = Array.from({ length: rerenderCount }, () =>
    int(10, 6000),
  ).sort((a, b) => a - b);
  const teardown =
    readyAtMs === null || introKind === 'none'
      ? // The handoff can still happen through Skip; otherwise only a
        // before-exit cut is meaningful.
        skipAtMs !== null && readyAtMs !== null
        ? pick<Teardown>(['complete', 'mid-exit', 'before-exit'])
        : 'before-exit'
      : pick<Teardown>([
          'complete',
          'complete',
          'complete',
          'mid-exit',
          'before-exit',
        ]);
  return {
    seed,
    readyAtMs,
    reducedMotion: rnd() < 0.2,
    progressUntilMs,
    intro: { kind: introKind, atMs: introAtMs },
    skipAtMs,
    rerenderAtMs,
    teardown,
    cutFraction: Math.round(rnd() * 90) / 100 + 0.05,
    cutAtMs: int(0, 9000),
  };
}

// ─── Harness plumbing ────────────────────────────────────────────────────────

const statusBar = StatusBar as unknown as {
  _propsStack: unknown[];
  pushStackEntry: jest.Mock;
  popStackEntry: jest.Mock;
  replaceStackEntry: jest.Mock;
};
const a11yAddListener = AccessibilityInfo.addEventListener as jest.Mock;
const nativeAnimatedModule = NativeModules.NativeAnimatedModule as Record<
  string,
  jest.Mock
>;

/** Recorded-call volume of the preset's NativeAnimatedModule mock. */
function nativeAnimatedMockHistory() {
  const counts: Record<string, number> = {};
  for (const [name, fn] of Object.entries(nativeAnimatedModule)) {
    if (typeof fn === 'function' && 'mock' in fn) {
      counts[name] = fn.mock.calls.length;
    }
  }
  return counts;
}

const queryClient = new QueryClient();

function Shell(props: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <View style={{ flex: 1, backgroundColor: color.surfaceDark }}>
          {props.children}
        </View>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

function hostNodes(renderer: Renderer) {
  return renderer.root.findAll(node => typeof node.type === 'string');
}

function hostByTestId(renderer: Renderer, testID: string) {
  const nodes = hostNodes(renderer).filter(
    node => node.props.testID === testID,
  );
  return nodes.length === 1 ? nodes[0]! : null;
}

function skipPressable(renderer: Renderer) {
  const matches = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === 'Skip intro' &&
      typeof node.props?.onPress === 'function',
  );
  const innermost = matches.filter(
    node =>
      node.findAll(
        child =>
          child !== node &&
          child.props?.accessibilityLabel === 'Skip intro' &&
          typeof child.props?.onPress === 'function',
      ).length === 0,
  );
  return innermost[0] ?? null;
}

async function advance(ms: number) {
  if (ms <= 0) return;
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

let reduceMotionHandler: ((value: boolean) => void) | null = null;
let reducedMotionNow = false;

function resolveReduceMotionHandler() {
  if (reduceMotionHandler) return reduceMotionHandler;
  const call = a11yAddListener.mock.calls.find(
    ([eventName]) => eventName === 'reduceMotionChanged',
  );
  if (!call) return null;
  reduceMotionHandler = call[1] as (value: boolean) => void;
  return reduceMotionHandler;
}

async function setReducedMotion(value: boolean) {
  if (reducedMotionNow === value) return;
  const handler = resolveReduceMotionHandler();
  if (!handler) return;
  await act(async () => handler(value));
  reducedMotionNow = value;
}

type Phase = 'mounted' | 'unmounting' | 'unmounted';

interface IterationResult {
  row: MatrixRow;
  mountMs: number;
  iterationMs: number;
}

let ledger: AnimatedListenerLedger;
let a11yListenerRegistrations = 0;

async function runIteration(
  scenario: Scenario,
  index: number,
): Promise<IterationResult> {
  const started = realNowMs();
  const baseline = {
    timers: jest.getTimerCount(),
    statusStack: statusBar._propsStack.length,
    animatedListeners: ledger.live(),
  };

  let phase: Phase = 'mounted';
  const finishes: { phase: Phase; atMs: number }[] = [];
  let ready = scenario.readyAtMs === 0;
  let onFinishedIdentity = 0;
  const makeOnFinished = () => {
    onFinishedIdentity += 1;
    return () => {
      finishes.push({ phase, atMs: Date.now() - t0 });
    };
  };
  let onFinished = makeOnFinished();

  const t0 = Date.now();
  await setReducedMotion(scenario.reducedMotion);

  let renderer!: Renderer;
  const mountStart = realNowMs();
  await act(async () => {
    renderer = TestRenderer.create(
      <Shell>
        <SplashScreen ready={ready} onFinished={onFinished} />
      </Shell>,
    );
  });
  const mountMs = realNowMs() - mountStart;

  const rerender = async () => {
    await act(async () => {
      renderer.update(
        <Shell>
          <SplashScreen ready={ready} onFinished={onFinished} />
        </Shell>,
      );
    });
  };

  const observed: Record<string, unknown> = {
    rootPresentAtMount: hostByTestId(renderer, 'splash-screen') !== null,
    videoPresentAtMount: hostByTestId(renderer, 'splash-video') !== null,
    pointerEventsAtMount: hostByTestId(renderer, 'splash-screen')?.props
      .pointerEvents,
    skipVisibleAtMount: skipPressable(renderer) !== null,
  };

  // Timeline of fake-time events, executed in order.
  type Event = { at: number; kind: string; run: () => Promise<void> };
  const events: Event[] = [];
  const clockNow = () => Date.now() - t0;
  const video = () => hostByTestId(renderer, 'splash-video');

  for (let ms = 100; ms <= scenario.progressUntilMs; ms += 100) {
    const currentTime = ms / 1000;
    events.push({
      at: ms,
      kind: 'progress',
      run: async () => {
        const node = video();
        if (!node) return;
        await act(async () => {
          node.props.onProgress({
            currentTime,
            playableDuration: 5,
            seekableDuration: 5,
          });
        });
      },
    });
  }
  if (scenario.readyAtMs !== null && scenario.readyAtMs > 0) {
    events.push({
      at: scenario.readyAtMs,
      kind: 'ready',
      run: async () => {
        ready = true;
        await rerender();
      },
    });
  }
  for (const at of scenario.rerenderAtMs) {
    events.push({
      at,
      kind: 'rerender',
      run: async () => {
        onFinished = makeOnFinished();
        await rerender();
      },
    });
  }
  if (scenario.intro.kind === 'end' || scenario.intro.kind === 'error') {
    const kind = scenario.intro.kind;
    events.push({
      at: scenario.intro.atMs,
      kind: `intro-${kind}`,
      run: async () => {
        const node = video();
        if (!node) return;
        await act(async () => {
          if (kind === 'end') node.props.onEnd();
          else node.props.onError({ error: { code: -11800 } });
        });
      },
    });
  }
  let skipPressed = false;
  let skipMissed = false;
  if (scenario.skipAtMs !== null) {
    events.push({
      at: scenario.skipAtMs,
      kind: 'skip',
      run: async () => {
        const skip = skipPressable(renderer);
        if (!skip) {
          skipMissed = true;
          return;
        }
        skipPressed = true;
        await act(async () => {
          skip.props.onPress();
        });
      },
    });
  }
  events.sort((a, b) => a.at - b.at);

  // The exit starts on the commit after BOTH ready and the intro being over.
  const introOverAt = (() => {
    const candidates: number[] = [];
    if (scenario.intro.kind === 'end' || scenario.intro.kind === 'error') {
      candidates.push(scenario.intro.atMs);
    }
    candidates.push(WATCHDOG_MS);
    if (scenario.skipAtMs !== null) {
      // Skip only counts if the control is revealed by then (>= 1 s of
      // progress fired before the press).
      const revealedAt = SKIP_AFTER_S * 1000;
      if (
        scenario.progressUntilMs >= revealedAt &&
        scenario.skipAtMs > revealedAt
      ) {
        candidates.push(scenario.skipAtMs);
      }
    }
    return Math.min(...candidates);
  })();
  const exitStartsAt =
    scenario.readyAtMs === null
      ? null
      : Math.max(scenario.readyAtMs, introOverAt);
  const exitDuration = scenario.reducedMotion ? 0 : EXIT_MS;

  // Where the run is cut for 'before-exit'; never after the exit begins.
  const cutAt =
    scenario.teardown === 'before-exit'
      ? exitStartsAt === null
        ? scenario.cutAtMs
        : Math.min(scenario.cutAtMs, Math.max(0, exitStartsAt - 1))
      : null;

  let pointerEventsDuringExit: unknown = 'n/a';
  let rootPresentDuringExit: boolean | null = null;
  let finishedBeforeExitEnd = false;

  const stopAt =
    scenario.teardown === 'before-exit'
      ? cutAt!
      : scenario.teardown === 'mid-exit'
        ? exitStartsAt! +
          Math.max(1, Math.floor(exitDuration * scenario.cutFraction))
        : exitStartsAt! + exitDuration + 60;

  for (const event of events) {
    if (event.at >= stopAt) break;
    await advance(event.at - clockNow());
    await event.run();
    if (
      exitStartsAt !== null &&
      event.at >= exitStartsAt &&
      phase === 'mounted'
    ) {
      const root = hostByTestId(renderer, 'splash-screen');
      rootPresentDuringExit = root !== null;
      pointerEventsDuringExit = root?.props.pointerEvents;
    }
  }
  if (exitStartsAt !== null && scenario.teardown !== 'before-exit') {
    // Land exactly on the exit start commit and record the exiting shape.
    await advance(exitStartsAt - clockNow());
    await advance(1);
    const root = hostByTestId(renderer, 'splash-screen');
    rootPresentDuringExit = root !== null;
    pointerEventsDuringExit = root?.props.pointerEvents;
    if (scenario.teardown === 'complete' && exitDuration > 0) {
      const checkAt = exitStartsAt + exitDuration - 60;
      if (clockNow() < checkAt) {
        await advance(checkAt - clockNow());
        finishedBeforeExitEnd = finishes.length > 0;
      }
    }
  }
  await advance(stopAt - clockNow());

  const finishesBeforeUnmount = finishes.length;
  phase = 'unmounting';
  const unmountStart = realNowMs();
  await act(async () => {
    renderer.unmount();
  });
  const unmountMs = realNowMs() - unmountStart;
  phase = 'unmounted';
  // What the unit leaves behind the instant its tree is gone (React's
  // AnimatedProps detach runs in a queued microtask, so it is included by
  // flushing microtasks without advancing the clock).
  await advance(0);
  const rightAfterUnmount = {
    timers: jest.getTimerCount(),
    statusStack: statusBar._propsStack.length,
    animatedListeners: ledger.live(),
    finishes: finishes.length,
  };
  // Anything the unit left behind gets every chance to fire.
  await advance(WATCHDOG_MS + EXIT_MS + 1000);

  const after = {
    timers: jest.getTimerCount(),
    statusStack: statusBar._propsStack.length,
    animatedListeners: ledger.live(),
  };
  a11yListenerRegistrations += a11yAddListener.mock.calls.length;
  a11yAddListener.mockClear();
  // Note: `jest.clearAllMocks()` resets call history only; implementations
  // (the StatusBar stack, the NativeAnimatedModule end-callback timer) stay.
  if (!keepMockHistory()) jest.clearAllMocks();

  const expectFinish = scenario.teardown === 'complete';
  const finishedDuringUnmount = finishes.filter(
    f => f.phase === 'unmounting',
  ).length;
  const finishedAfterUnmount = finishes.filter(
    f => f.phase === 'unmounted',
  ).length;

  const invariants: Record<string, boolean> = {
    rendersRootAndVideo:
      observed.rootPresentAtMount === true &&
      observed.videoPresentAtMount === true,
    ownsTouchesAtMount: observed.pointerEventsAtMount === 'auto',
    noSkipBeforeFirstSecond: observed.skipVisibleAtMount === false,
    handoffAtMostOnce: finishes.length <= 1,
    handoffExactlyOnceWhenCompleted: expectFinish
      ? finishesBeforeUnmount === 1
      : finishesBeforeUnmount === 0,
    handoffNotBeforeCrossFadeEnds: !finishedBeforeExitEnd,
    releasesTouchesWhileExiting:
      scenario.teardown === 'before-exit' ||
      exitStartsAt === null ||
      pointerEventsDuringExit === 'none',
    stillMountedWhileExiting:
      scenario.teardown === 'before-exit' ||
      exitStartsAt === null ||
      rootPresentDuringExit === true,
    noHandoffAfterUnmount: finishedAfterUnmount === 0,
    noHandoffFiredByTeardown: finishedDuringUnmount === 0,
    timersReturnToBaseline: after.timers === baseline.timers,
    statusBarStackReturnsToBaseline: after.statusStack === baseline.statusStack,
    animatedListenersReturnToBaseline:
      after.animatedListeners === baseline.animatedListeners,
    // The observer is registered once per process (by the warm-up mount);
    // no iteration may add another AccessibilityInfo subscription.
    accessibilityObserverNotReRegistered: a11yListenerRegistrations === 0,
  };
  const failed = Object.entries(invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  const iterationMs = realNowMs() - started;

  const row: MatrixRow = {
    suite: 'stress/splash-long-run-leak',
    scenario: `iter-${index}`,
    seed: scenario.seed,
    inputs: {
      ...scenario,
      intro: { ...scenario.intro, atMs: String(scenario.intro.atMs) },
    },
    observed: {
      ...observed,
      exitStartsAt,
      exitDuration,
      stopAt,
      skipPressed,
      skipMissed,
      onFinishedIdentities: onFinishedIdentity,
      finishes,
      finishedDuringUnmount,
      finishedAfterUnmount,
      pointerEventsDuringExit,
      rootPresentDuringExit,
      baseline,
      rightAfterUnmount,
      after,
      mountMs: Math.round(mountMs * 1000) / 1000,
      unmountMs: Math.round(unmountMs * 1000) / 1000,
    },
    invariants,
    ok: failed.length === 0,
    failed,
    durationMs: Math.round(iterationMs * 1000) / 1000,
  };
  return { row, mountMs, iterationMs };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const ITERATIONS = stressIterations(40);
const SEED_FILTER = stressSeedFilter();
const FIRST_SEED = 1000;

const rows: MatrixRow[] = [];
const heap: HeapSample[] = [];
const mountTimes: number[] = [];
const iterationTimes: number[] = [];

beforeAll(() => {
  jest.useFakeTimers();
  ledger = trackAnimatedListeners(
    Animated.Value.prototype as unknown as ListenerHost,
  );
});

afterAll(() => {
  ledger.restore();
  jest.useRealTimers();
});

function checkpoint(iteration: number) {
  // Drop the jest.fn call history of the setup-file mocks so the sample
  // reflects the unit, not the harness's own bookkeeping.
  statusBar.pushStackEntry.mockClear();
  statusBar.popStackEntry.mockClear();
  statusBar.replaceStackEntry.mockClear();
  heap.push(
    heapSample(iteration, {
      statusBarStack: statusBar._propsStack.length,
      animatedListenersLive: ledger.live(),
      animatedListenersAdded: ledger.added,
      animatedListenersRemoved: ledger.removed,
      a11yRegistrations: a11yListenerRegistrations,
      queryCacheSize: queryClient.getQueryCache().getAll().length,
    }),
  );
}

describe(`STRESS scr-splashscreen long-run-leak (${ITERATIONS} iterations, gc=${gcExposed() ? 'exposed' : 'NOT exposed'})`, () => {
  const seeds =
    SEED_FILTER !== null
      ? [SEED_FILTER]
      : Array.from({ length: ITERATIONS }, (_, i) => FIRST_SEED + i);

  it('warm-up mount registers the one reduced-motion observer, then baseline heap sample', async () => {
    let renderer!: Renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <Shell>
          <SplashScreen ready={false} onFinished={() => {}} />
        </Shell>,
      );
    });
    await act(async () => {
      renderer.unmount();
    });
    await advance(WATCHDOG_MS + EXIT_MS + 1000);
    expect(resolveReduceMotionHandler()).not.toBeNull();
    a11yAddListener.mockClear();
    a11yListenerRegistrations = 0;
    checkpoint(0);
    expect(heap).toHaveLength(1);
  });

  for (let start = 0; start < seeds.length; start += HEAP_CHECKPOINT_EVERY) {
    const slice = seeds.slice(start, start + HEAP_CHECKPOINT_EVERY);
    it(`iterations ${start + 1}..${start + slice.length} (seeds ${slice[0]}..${slice[slice.length - 1]})`, async () => {
      for (let i = 0; i < slice.length; i += 1) {
        const index = start + i + 1;
        const result = await runIteration(seededScenario(slice[i]!), index);
        rows.push(result.row);
        mountTimes.push(result.mountMs);
        iterationTimes.push(result.iterationMs);
        if (index % HEAP_CHECKPOINT_EVERY === 0) checkpoint(index);
      }
      if (slice.length % HEAP_CHECKPOINT_EVERY !== 0) {
        checkpoint(start + slice.length);
      }
    }, 600_000);
  }

  it('writes artifacts; every failed invariant is a finding', () => {
    const heapSlope = slopeReport(heap, s => s.heapUsed);
    const rssSlope = slopeReport(heap, s => s.rss);
    const externalSlope = slopeReport(heap, s => s.external);
    const mountDrift = driftReport(mountTimes);
    const iterationDrift = driftReport(iterationTimes);
    const handleKinds = new Set<string>();
    for (const sample of heap) {
      for (const kind of Object.keys(sample.activeResources))
        handleKinds.add(kind);
    }
    const handleDrift = Object.fromEntries(
      [...handleKinds].map(kind => [
        kind,
        {
          first: heap[0]?.activeResources[kind] ?? 0,
          last: heap[heap.length - 1]?.activeResources[kind] ?? 0,
          max: Math.max(...heap.map(s => s.activeResources[kind] ?? 0)),
        },
      ]),
    );
    const summary = {
      ...summarize(rows),
      iterationsRequested: seeds.length,
      iterationsExecuted: rows.length,
      gcExposed: gcExposed(),
      mockHistoryKept: keepMockHistory(),
      nativeAnimatedMockHistoryAtEnd: nativeAnimatedMockHistory(),
      heapCheckpoints: heap.length,
      heapSlope,
      rssSlope,
      externalSlope,
      handleDrift,
      fakeTimersAtCheckpoints: heap.map(s => s.fakeTimers),
      mountDrift,
      iterationDrift,
      teardownMix: countBy(rows, r => String(r.inputs.teardown)),
      introMix: countBy(rows, r =>
        String((r.inputs.intro as { kind: string }).kind),
      ),
      finishedDuringUnmountRows: rows
        .filter(r => Number(r.observed.finishedDuringUnmount) > 0)
        .map(r => r.seed),
      finishedAfterUnmountRows: rows
        .filter(r => Number(r.observed.finishedAfterUnmount) > 0)
        .map(r => r.seed),
      failedByInvariant: countBy(
        rows.flatMap(r => r.failed),
        name => name,
      ),
      replay:
        'cd apps/mobile && STRESS_SEED=<seed> node --expose-gc node_modules/.bin/jest --ci __tests__/stress/splashScreenLongRunLeak.stress.test.tsx',
      finalHeap: heapSnapshot(),
    };
    const paths = [
      writeJsonArtifact('splash-leak.rows.json', rows),
      writeJsonArtifact('splash-leak.heap.json', heap),
      writeJsonArtifact('splash-leak.summary.json', summary),
      writeTextArtifact('splash-leak.md', matrixMarkdown(rows)),
    ];
    console.log(
      JSON.stringify({
        harness: 'stress/splash-long-run-leak',
        rows: rows.length,
        failed: rows.filter(r => !r.ok).length,
        heapSlope,
        mountDrift,
        iterationDrift,
        paths,
      }),
    );

    expect(rows.length).toBe(seeds.length);

    // Reproduced deviation (see the stress report for this unit): when the
    // screen is torn down while the cross-fade is running, the JS-driven
    // `fade` timing is not attached to any Animated prop, so nothing stops it
    // on unmount and the parallel's completion callback still calls
    // `onFinished()` on the already-unmounted screen (EXIT_MS after the exit
    // started). It is pinned here EXACTLY — every mid-exit row, only that
    // invariant, and nothing else — so a fix flips this expectation and any
    // other failure is still a hard stop.
    const midExitSeeds = rows
      .filter(r => r.inputs.teardown === 'mid-exit')
      .map(r => r.seed);
    const lateHandoffSeeds = rows
      .filter(
        r => r.failed.length === 1 && r.failed[0] === 'noHandoffAfterUnmount',
      )
      .map(r => r.seed);
    expect(lateHandoffSeeds).toEqual(midExitSeeds);
    for (const seed of lateHandoffSeeds) {
      const row = rows.find(r => r.seed === seed)!;
      const o = row.observed as {
        finishes: { phase: string; atMs: number }[];
        exitStartsAt: number;
        exitDuration: number;
        stopAt: number;
      };
      expect(o.finishes).toHaveLength(1);
      expect(o.finishes[0]!.phase).toBe('unmounted');
      // Two mechanisms, both after unmount: the detached native `exit` value
      // stops its still-running timing (→ parallel ends "unfinished" at the
      // unmount tick — the path a device takes), or the unattached JS `fade`
      // simply runs out EXIT_MS after the exit started.
      expect([o.stopAt, o.exitStartsAt + o.exitDuration]).toContain(
        o.finishes[0]!.atMs,
      );
    }
    expect(
      rows
        .filter(r => !r.ok && !lateHandoffSeeds.includes(r.seed))
        .map(r => ({ seed: r.seed, failed: r.failed })),
    ).toEqual([]);
    if (heapSlope) expect(heapSlope.leakSuspected).toBe(false);
    if (rssSlope) expect(rssSlope.leakSuspected).toBe(false);
    // Pending fake timers must be flat across the whole run.
    expect(new Set(heap.map(s => s.fakeTimers)).size).toBe(1);
  });
});

function countBy<T>(items: readonly T[], key: (item: T) => string) {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}
