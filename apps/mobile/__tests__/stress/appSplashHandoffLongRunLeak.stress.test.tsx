/**
 * STRESS — unit `scr-splashscreen`, lens `long-run-leak`, in the REAL tree.
 *
 * The companion `splashScreenLongRunLeak.stress.test.tsx` drives the screen
 * directly under the App's provider shell. This harness launches the real
 * `App.tsx` (SafeAreaProvider → QueryClientProvider → StatusBar →
 * RootErrorBoundary → Gate) with the real appStore / notificationStore /
 * WelcomeScreen / SplashScreen, mocks only the native edges (SQLite kv,
 * Keychain-backed auth store, notification scheduler, SVG, video) and the
 * leaves outside the launch handoff (RootNavigator, SignInScreen, overlays),
 * and mounts/unmounts the whole launch ≥ STRESS_ITER times in one process:
 *
 *   fresh stores → <App/> → auth hydrates (seeded delay) → app hydrates →
 *   Gate flips `ready` → splash exits over the already-painted Welcome →
 *   `handleSplashFinished` removes the overlay → unmount.
 *
 * Every iteration is a seeded scenario (intro end / decode error / watchdog
 * / Skip, seeded hydration delay, reduced motion, teardown complete /
 * mid-exit / before-exit). After each unmount the harness asserts that
 * pending timers, the StatusBar stack, live Animated listeners and
 * AppState subscriptions are back at baseline, then samples the heap (after
 * a forced GC when --expose-gc is on) every 50 iterations.
 *
 *   cd apps/mobile && STRESS_ITER=500 node --expose-gc node_modules/.bin/jest \
 *     --ci --silent __tests__/stress/appSplashHandoffLongRunLeak.stress.test.tsx
 *   STRESS_SEED=<seed> replays one iteration.
 *
 * Artifacts: `<repo>/artifacts/xc-lifecycle-persistence/app-splash-leak.*`.
 */
import React from 'react';
import {
  AccessibilityInfo,
  Animated,
  AppState,
  StatusBar,
  Text,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PermissionState } from '../../src/notifications/service';
import type { Profile } from '../../src/state/profile';
import { EXIT_MS, WATCHDOG_MS } from '../../src/screens/SplashScreen';
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

// ─── Native edges (same set the existing App.tsx flow suites use) ────────────

jest.mock(
  'react-native-safe-area-context',
  () =>
    jest.requireActual<{ default: unknown }>(
      'react-native-safe-area-context/jest/mock',
    ).default,
);

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
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
    G: Mock,
    Ellipse: Mock,
  };
});

const mockKv = new Map<string, string>();
jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

interface MockSession {
  provider: 'guest' | 'apple';
  subject: string;
  canonicalAppUserId: string | null;
  localOnly: boolean;
  displayName: string | null;
  email: string | null;
}
interface MockAuthState {
  hydrated: boolean;
  session: MockSession | null;
  hydrate: () => Promise<void>;
}
// Seeded per iteration: how long the Keychain-backed restore takes.
let mockHydrateDelayMs = 0;
jest.mock('../../src/auth/authStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  const scope = jest.requireActual<
    typeof import('../../src/data/accountScope')
  >('../../src/data/accountScope');
  const useAuthStore = create<MockAuthState>(set => ({
    hydrated: false,
    session: null,
    hydrate: async () => {
      if (mockHydrateDelayMs > 0) {
        await new Promise<void>(resolve =>
          setTimeout(resolve, mockHydrateDelayMs),
        );
      }
      scope.setActiveDataOwner(scope.SIGNED_OUT_DATA_OWNER);
      set({ hydrated: true, session: null });
    },
  }));
  return { useAuthStore };
});

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));
jest.mock('../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: async () => null,
  saveCanonicalOnboardingProfile: async (_s: unknown, profile: Profile) =>
    profile,
}));

const mockScheduler = {
  async permissionState(): Promise<PermissionState> {
    return 'undetermined';
  },
  async requestPermission(): Promise<PermissionState> {
    return 'undetermined';
  },
  async applyPlan(): Promise<void> {},
  async cancelAllPlanned(): Promise<void> {},
  async openSystemSettings(): Promise<void> {},
};
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

// Leaves outside the launch handoff.
jest.mock('../../src/navigation/RootNavigator', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    RootNavigator: () => React.createElement(Text, null, 'ROOT_NAVIGATOR'),
  };
});
jest.mock('../../src/screens/SignInScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    SignInScreen: () => React.createElement(Text, null, 'SIGN_IN_SCREEN'),
  };
});
jest.mock('../../src/components/RankUpCelebration', () => ({
  RankUpCelebration: () => null,
}));
jest.mock('../../src/consistency/StreakCelebration', () => ({
  StreakCelebration: () => null,
}));
jest.mock('../../src/walkthrough/FirstRunWalkthrough', () => ({
  FirstRunWalkthrough: () => null,
}));
jest.mock('../../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: async () => {} };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

import App from '../../App';
import { useAuthStore } from '../../src/auth/authStore';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { useAppStore } from '../../src/state/appStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';

type Renderer = TestRenderer.ReactTestRenderer;

// ─── Scenario grammar ────────────────────────────────────────────────────────

type IntroKind = 'end' | 'error' | 'watchdog' | 'skip';
type Teardown = 'complete' | 'mid-exit' | 'before-exit';

interface Scenario {
  seed: number;
  /** Auth-restore latency the Gate waits on before it can hydrate the app. */
  hydrateDelayMs: number;
  reducedMotion: boolean;
  /** onProgress ticks every 100 ms of fake time until this point. */
  progressUntilMs: number;
  intro: { kind: IntroKind; atMs: number };
  teardown: Teardown;
  cutFraction: number;
  cutAtMs: number;
}

function seededScenario(seed: number): Scenario {
  const rnd = makePrng(seed);
  const pick = <T,>(items: readonly T[]): T =>
    items[Math.floor(rnd() * items.length)]!;
  const int = (min: number, max: number) =>
    min + Math.floor(rnd() * (max - min + 1));

  const hydrateDelayMs = pick([0, 0, int(20, 600), int(600, 4000)]);
  const introKind = pick<IntroKind>([
    'end',
    'end',
    'end',
    'error',
    'watchdog',
    'skip',
  ]);
  // Skip lands on a half-tick after the control is revealed (>= 1 s of
  // playback progress) so the press never coincides with a progress tick.
  const introAtMs =
    introKind === 'watchdog'
      ? WATCHDOG_MS
      : introKind === 'skip'
        ? int(11, 40) * 100 + 50
        : int(200, 5000);
  const progressUntilMs =
    introKind === 'skip' ? introAtMs : Math.min(int(0, 4000), introAtMs);
  return {
    seed,
    hydrateDelayMs,
    reducedMotion: rnd() < 0.2,
    progressUntilMs,
    intro: { kind: introKind, atMs: introAtMs },
    teardown: pick<Teardown>([
      'complete',
      'complete',
      'complete',
      'mid-exit',
      'before-exit',
    ]),
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
const appStateAddListener = AppState.addEventListener as jest.Mock;

// The preset's AppState mock returns an inert handle; count subscriptions
// through it so a missing `remove()` in any launch hook is visible.
let appStateSubscriptionsLive = 0;
let appStateSubscriptionsAdded = 0;
appStateAddListener.mockImplementation(() => {
  appStateSubscriptionsLive += 1;
  appStateSubscriptionsAdded += 1;
  let removed = false;
  return {
    remove: () => {
      if (removed) return;
      removed = true;
      appStateSubscriptionsLive -= 1;
    },
  };
});

function hostNodes(renderer: Renderer) {
  return renderer.root.findAll(node => typeof node.type === 'string');
}

function hostByTestId(renderer: Renderer, testID: string) {
  const nodes = hostNodes(renderer).filter(
    node => node.props.testID === testID,
  );
  return nodes.length === 1 ? nodes[0]! : null;
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string | number => typeof c !== 'object')
    .join('');
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
  if (ms <= 0) {
    await act(async () => {});
    return;
  }
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

function resetStores() {
  mockKv.clear();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({ hydrated: false, session: null });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
  });
}

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
  resetStores();
  mockHydrateDelayMs = scenario.hydrateDelayMs;
  const baseline = {
    timers: jest.getTimerCount(),
    statusStack: statusBar._propsStack.length,
    animatedListeners: ledger.live(),
    appStateSubscriptions: appStateSubscriptionsLive,
  };
  await setReducedMotion(scenario.reducedMotion);

  const t0 = Date.now();
  const clockNow = () => Date.now() - t0;

  let renderer!: Renderer;
  const mountStart = realNowMs();
  await act(async () => {
    renderer = TestRenderer.create(<App />);
  });
  const mountMs = realNowMs() - mountStart;
  // Flush the hydration promise chain that needs no clock.
  await advance(0);

  const splash = () => hostByTestId(renderer, 'splash-screen');
  const video = () => hostByTestId(renderer, 'splash-video');

  const observed: Record<string, unknown> = {
    splashPresentAtMount: splash() !== null,
    videoPresentAtMount: video() !== null,
    pointerEventsAtMount: splash()?.props.pointerEvents,
    loadingUnderSplashBeforeReady:
      scenario.hydrateDelayMs > 0
        ? allText(renderer).includes('Getting things ready')
        : 'n/a',
    welcomeUnderSplashAtMount: allText(renderer).includes('See the stroke.'),
  };

  // Gate's `ready` flips once auth (seeded delay) and app hydration settle;
  // both mocks resolve on the same tick so ready lands at hydrateDelayMs.
  const readyAt = scenario.hydrateDelayMs;

  type Event = { at: number; run: () => Promise<void> };
  const events: Event[] = [];
  for (let ms = 100; ms <= scenario.progressUntilMs; ms += 100) {
    const currentTime = ms / 1000;
    events.push({
      at: ms,
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
  let skipPressed = false;
  let skipMissed = false;
  if (scenario.intro.kind !== 'watchdog') {
    const kind = scenario.intro.kind;
    events.push({
      at: scenario.intro.atMs,
      run: async () => {
        if (kind === 'skip') {
          const skip = skipPressable(renderer);
          if (!skip) {
            skipMissed = true;
            return;
          }
          skipPressed = true;
          await act(async () => {
            skip.props.onPress();
          });
          return;
        }
        const node = video();
        if (!node) return;
        await act(async () => {
          if (kind === 'end') node.props.onEnd();
          else node.props.onError({ error: { code: -11800 } });
        });
      },
    });
  }
  events.sort((a, b) => a.at - b.at);

  const introOverAt = Math.min(scenario.intro.atMs, WATCHDOG_MS);
  const exitStartsAt = Math.max(readyAt, introOverAt);
  const exitDuration = scenario.reducedMotion ? 0 : EXIT_MS;
  const cutAt =
    scenario.teardown === 'before-exit'
      ? Math.min(scenario.cutAtMs, Math.max(0, exitStartsAt - 1))
      : null;
  const stopAt =
    scenario.teardown === 'before-exit'
      ? cutAt!
      : scenario.teardown === 'mid-exit'
        ? exitStartsAt +
          Math.max(1, Math.floor(exitDuration * scenario.cutFraction))
        : exitStartsAt + exitDuration + 60;

  let welcomeUnderSplashWhenReady: boolean | null = null;
  let pointerEventsDuringExit: unknown = 'n/a';
  let splashPresentDuringExit: boolean | null = null;
  let welcomeDuringExit: boolean | null = null;
  let splashGoneBeforeExitEnd: boolean | null = null;

  for (const event of events) {
    if (event.at >= stopAt) break;
    await advance(event.at - clockNow());
    await event.run();
  }
  if (readyAt < stopAt) {
    await advance(readyAt - clockNow());
    await advance(1);
    welcomeUnderSplashWhenReady =
      splash() !== null && allText(renderer).includes('See the stroke.');
  }
  if (scenario.teardown !== 'before-exit') {
    await advance(exitStartsAt - clockNow());
    await advance(1);
    const root = splash();
    splashPresentDuringExit = root !== null;
    pointerEventsDuringExit = root?.props.pointerEvents;
    welcomeDuringExit = allText(renderer).includes('See the stroke.');
    if (scenario.teardown === 'complete' && exitDuration > 0) {
      const checkAt = exitStartsAt + exitDuration - 60;
      if (clockNow() < checkAt) await advance(checkAt - clockNow());
      splashGoneBeforeExitEnd = splash() === null;
    }
  }
  await advance(stopAt - clockNow());

  const splashPresentBeforeUnmount = splash() !== null;
  const welcomeBeforeUnmount = allText(renderer).includes('See the stroke.');

  const unmountStart = realNowMs();
  await act(async () => {
    renderer.unmount();
  });
  const unmountMs = realNowMs() - unmountStart;
  await advance(0);
  const rightAfterUnmount = {
    timers: jest.getTimerCount(),
    statusStack: statusBar._propsStack.length,
    animatedListeners: ledger.live(),
    appStateSubscriptions: appStateSubscriptionsLive,
  };
  // Anything the tree left behind gets every chance to fire.
  await advance(WATCHDOG_MS + EXIT_MS + 1000);
  const after = {
    timers: jest.getTimerCount(),
    statusStack: statusBar._propsStack.length,
    animatedListeners: ledger.live(),
    appStateSubscriptions: appStateSubscriptionsLive,
  };
  a11yListenerRegistrations += a11yAddListener.mock.calls.length;
  a11yAddListener.mockClear();
  // Call history only; the mocks' implementations (StatusBar stack,
  // NativeAnimatedModule end-callback timer, AppState counter) stay.
  if (!keepMockHistory()) jest.clearAllMocks();

  const complete = scenario.teardown === 'complete';
  const invariants: Record<string, boolean> = {
    splashCoversLaunch:
      observed.splashPresentAtMount === true &&
      observed.videoPresentAtMount === true &&
      observed.pointerEventsAtMount === 'auto',
    loadingPaintedUnderSplashBeforeReady:
      observed.loadingUnderSplashBeforeReady !== false,
    welcomePaintedUnderSplashOnceReady: welcomeUnderSplashWhenReady !== false,
    splashStillCoversWhileExiting:
      scenario.teardown === 'before-exit' || splashPresentDuringExit === true,
    releasesTouchesWhileExiting:
      scenario.teardown === 'before-exit' || pointerEventsDuringExit === 'none',
    welcomeVisibleWhileExiting:
      scenario.teardown === 'before-exit' || welcomeDuringExit === true,
    splashNotRemovedBeforeCrossFadeEnds: splashGoneBeforeExitEnd !== true,
    handoffRemovesSplashWhenCompleted: complete
      ? !splashPresentBeforeUnmount && welcomeBeforeUnmount
      : splashPresentBeforeUnmount,
    skipPressedWhenScheduled: scenario.intro.kind !== 'skip' || !skipMissed,
    timersReturnToBaseline: after.timers === baseline.timers,
    statusBarStackReturnsToBaseline: after.statusStack === baseline.statusStack,
    animatedListenersReturnToBaseline:
      after.animatedListeners === baseline.animatedListeners,
    appStateSubscriptionsReturnToBaseline:
      after.appStateSubscriptions === baseline.appStateSubscriptions,
    accessibilityObserverNotReRegistered: a11yListenerRegistrations === 0,
  };
  const failed = Object.entries(invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  const iterationMs = realNowMs() - started;

  const row: MatrixRow = {
    suite: 'stress/app-splash-handoff-long-run-leak',
    scenario: `iter-${index}`,
    seed: scenario.seed,
    inputs: { ...scenario },
    observed: {
      ...observed,
      readyAt,
      exitStartsAt,
      exitDuration,
      stopAt,
      skipPressed,
      skipMissed,
      welcomeUnderSplashWhenReady,
      splashPresentDuringExit,
      pointerEventsDuringExit,
      welcomeDuringExit,
      splashGoneBeforeExitEnd,
      splashPresentBeforeUnmount,
      welcomeBeforeUnmount,
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

const ITERATIONS = stressIterations(30);
const SEED_FILTER = stressSeedFilter();
const FIRST_SEED = 5000;

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
  statusBar.pushStackEntry.mockClear();
  statusBar.popStackEntry.mockClear();
  statusBar.replaceStackEntry.mockClear();
  heap.push(
    heapSample(iteration, {
      statusBarStack: statusBar._propsStack.length,
      animatedListenersLive: ledger.live(),
      animatedListenersAdded: ledger.added,
      animatedListenersRemoved: ledger.removed,
      appStateSubscriptionsLive,
      appStateSubscriptionsAdded,
      a11yRegistrations: a11yListenerRegistrations,
      kvEntries: mockKv.size,
    }),
  );
}

describe(`STRESS scr-splashscreen in real App.tsx long-run-leak (${ITERATIONS} launches, gc=${gcExposed() ? 'exposed' : 'NOT exposed'})`, () => {
  const seeds =
    SEED_FILTER !== null
      ? [SEED_FILTER]
      : Array.from({ length: ITERATIONS }, (_, i) => FIRST_SEED + i);

  it('warm-up launch reaches Welcome through the real Gate, then baseline heap sample', async () => {
    resetStores();
    mockHydrateDelayMs = 0;
    let renderer!: Renderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    await advance(0);
    expect(hostByTestId(renderer, 'splash-screen')).not.toBeNull();
    expect(allText(renderer)).toContain('See the stroke.');
    await act(async () => {
      hostByTestId(renderer, 'splash-video')!.props.onEnd();
    });
    await advance(EXIT_MS + 100);
    expect(hostByTestId(renderer, 'splash-screen')).toBeNull();
    expect(allText(renderer)).toContain('See the stroke.');
    await act(async () => {
      renderer.unmount();
    });
    await advance(WATCHDOG_MS + EXIT_MS + 1000);
    expect(resolveReduceMotionHandler()).not.toBeNull();
    expect(appStateSubscriptionsLive).toBe(0);
    a11yAddListener.mockClear();
    a11yListenerRegistrations = 0;
    checkpoint(0);
    expect(heap).toHaveLength(1);
  });

  for (let start = 0; start < seeds.length; start += HEAP_CHECKPOINT_EVERY) {
    const slice = seeds.slice(start, start + HEAP_CHECKPOINT_EVERY);
    it(`launches ${start + 1}..${start + slice.length} (seeds ${slice[0]}..${slice[slice.length - 1]})`, async () => {
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
    }, 900_000);
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
      heapCheckpoints: heap.length,
      heapSlope,
      rssSlope,
      externalSlope,
      handleDrift,
      fakeTimersAtCheckpoints: heap.map(s => s.fakeTimers),
      appStateSubscriptionsAtCheckpoints: heap.map(
        s => s.extra.appStateSubscriptionsLive,
      ),
      mountDrift,
      iterationDrift,
      teardownMix: countBy(rows, r => String(r.inputs.teardown)),
      introMix: countBy(rows, r =>
        String((r.inputs.intro as { kind: string }).kind),
      ),
      hydrateDelayMix: countBy(rows, r => {
        const ms = Number(r.inputs.hydrateDelayMs);
        return ms === 0 ? 'ready-at-mount' : ms < 600 ? '<600ms' : '>=600ms';
      }),
      failedByInvariant: countBy(
        rows.flatMap(r => r.failed),
        name => name,
      ),
      replay:
        'cd apps/mobile && STRESS_SEED=<seed> node --expose-gc node_modules/.bin/jest --ci __tests__/stress/appSplashHandoffLongRunLeak.stress.test.tsx',
      finalHeap: heapSnapshot(),
    };
    const paths = [
      writeJsonArtifact('app-splash-leak.rows.json', rows),
      writeJsonArtifact('app-splash-leak.heap.json', heap),
      writeJsonArtifact('app-splash-leak.summary.json', summary),
      writeTextArtifact('app-splash-leak.md', matrixMarkdown(rows)),
    ];
    console.log(
      JSON.stringify({
        harness: 'stress/app-splash-handoff-long-run-leak',
        rows: rows.length,
        failed: rows.filter(r => !r.ok).length,
        heapSlope,
        mountDrift,
        iterationDrift,
        paths,
      }),
    );

    expect(rows.length).toBe(seeds.length);
    expect(
      rows.filter(r => !r.ok).map(r => ({ seed: r.seed, failed: r.failed })),
    ).toEqual([]);
    if (heapSlope) expect(heapSlope.leakSuspected).toBe(false);
    if (rssSlope) expect(rssSlope.leakSuspected).toBe(false);
    expect(new Set(heap.map(s => s.fakeTimers)).size).toBe(1);
    expect(new Set(heap.map(s => s.extra.appStateSubscriptionsLive)).size).toBe(
      1,
    );
  });
});

function countBy<T>(items: readonly T[], key: (item: T) => string) {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}
