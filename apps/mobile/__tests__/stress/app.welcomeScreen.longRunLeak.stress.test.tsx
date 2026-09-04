/**
 * STRESS — unit `scr-welcomescreen`, lens `long-run-leak`, host = the REAL
 * App (`App.tsx`: SafeAreaProvider → QueryClientProvider → StatusBar →
 * RootErrorBoundary → Gate) with the REAL zustand stores (auth, app,
 * notification, consistency, walkthrough), the real launch Splash and the
 * real global overlays. Only process edges are replaced: SQLite (FakeLocalDb),
 * Google Sign-In, fetch, the safe-area native metrics, and the three screens
 * that are not this unit (RootNavigator / Onboarding / SignIn → text markers)
 * so a press on Welcome's controls is observable without their native graphs.
 *
 * Every iteration replays a launch from its seed: (optionally) cold stores →
 * mount <App/> → auth+app hydrate → Welcome paints under the splash → the
 * splash ends (video onEnd / skip / 8s watchdog, or stays up) → seeded
 * interactions on Welcome → unmount → settle. After every iteration timers,
 * StatusBar entries, and native listeners must be back at the steady state
 * pinned after the first launch; heap is sampled (after GC) every
 * CHECKPOINT_EVERY iterations and judged on slope; mount and total time are
 * checked for drift.
 *
 * Default:   npx jest --ci __tests__/stress/app.welcomeScreen.longRunLeak.stress.test.tsx
 * Campaign:  STRESS_ITER=500 NODE_OPTIONS=--expose-gc npx jest --ci --runInBand <file>
 * Replay:    STRESS_REPLAY=<seed> npx jest --ci --runInBand <file>
 * Artifacts: artifacts/stress/app.welcomeScreen.longRunLeak.{rows,summary}.json
 *            + .trace.jsonl
 */
import React from 'react';
import {
  AccessibilityInfo,
  Appearance,
  AppState,
  DeviceEventEmitter,
  Dimensions,
  Keyboard,
  Linking,
  StatusBar,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import Video from 'react-native-video';
import { FakeLocalDb } from '../../xc-harness/lifecycle-persistence/fakeLocalDb';
import {
  CHECKPOINT_EVERY,
  acquireGc,
  canaryRetain,
  activeResources,
  artifactPath,
  chance,
  intBetween,
  judgeChecks,
  judgeDrift,
  judgeHeap,
  makePrng,
  nodeVersion,
  nowMs,
  openJsonlArtifact,
  pick,
  planCampaign,
  replayHint,
  resourceGrowth,
  sameCounts,
  shouldClearMockRecords,
  takeHeapSample,
  trackListeners,
  writeJsonArtifact,
  type CampaignSummary,
  type HeapSample,
  type IterationRow,
  type IterationTrace,
} from '../../xc-harness/stress/leakProbe';

// ─── Process edges ───────────────────────────────────────────────────────────

const mockDb = { current: new FakeLocalDb() };
jest.mock('../../src/data/db', () => ({
  getDb: () => mockDb.current.handle(),
}));
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(),
    signIn: jest.fn(),
    signInSilently: jest.fn(async () => {
      throw new Error('no silent google session (stress stub)');
    }),
    hasPreviousSignIn: jest.fn(() => false),
    signOut: jest.fn(async () => {}),
    revokeAccess: jest.fn(async () => {}),
  },
}));
// The real provider paints nothing until the native view reports its
// metrics; App.tsx passes none, so the frame the device would deliver is
// supplied here. Everything else in the module (SafeAreaView, hooks) is real.
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual<
    typeof import('react-native-safe-area-context')
  >('react-native-safe-area-context');
  const R = jest.requireActual<typeof import('react')>('react');
  const metrics = {
    frame: { x: 0, y: 0, width: 393, height: 852 },
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  };
  return {
    ...actual,
    SafeAreaProvider: (props: { children?: React.ReactNode }) =>
      R.createElement(
        actual.SafeAreaProvider,
        { initialMetrics: metrics },
        props.children,
      ),
  };
});
jest.mock('../../src/navigation/RootNavigator', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    RootNavigator: () => R.createElement(RN.Text, null, 'ROOT_NAVIGATOR'),
  };
});
jest.mock('../../src/screens/OnboardingScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    OnboardingScreen: () => R.createElement(RN.Text, null, 'ONBOARDING'),
  };
});
jest.mock('../../src/screens/SignInScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return { SignInScreen: () => R.createElement(RN.Text, null, 'SIGN_IN') };
});

import App from '../../App';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import {
  stageAfterGetStarted,
  type PreAuthStage,
} from '../../src/flow/launchGate';
import { WATCHDOG_MS } from '../../src/screens/SplashScreen';

const SUITE = '__tests__/stress/app.welcomeScreen.longRunLeak.stress.test.tsx';
const UNIT = 'scr-welcomescreen';
const START_LABEL = 'Start your first read';
const SIGN_IN_LABEL = 'I already have an account';
const SKIP_LABEL = 'Skip intro';
const HERO = 'See the stroke.';
const BOUNDARY_TITLE = 'Something went wrong';
const LOADING = 'Getting things ready';
const MARKER: Record<PreAuthStage, string> = {
  welcome: HERO,
  onboarding: 'ONBOARDING',
  signin: 'SIGN_IN',
};
/** Upper bound on 50ms hydration slices before a launch is declared stuck. */
const HYDRATION_SLICES = 200;

// ─── Seeded scenario ─────────────────────────────────────────────────────────

type SplashExit = 'videoEnd' | 'videoError' | 'skip' | 'watchdog' | 'none';

type Action =
  | { kind: 'advance'; ms: number }
  | { kind: 'pressInOut'; control: 'start' | 'signIn'; holdMs: number }
  | { kind: 'reduceMotion'; value: boolean }
  | { kind: 'appState'; state: 'background' | 'active' | 'inactive' }
  | { kind: 'pressStart' }
  | { kind: 'pressSignIn' };

interface Scenario {
  coldLaunch: boolean;
  splashExit: SplashExit;
  splashProgressS: number;
  actions: Action[];
  settleMs: number;
}

function buildScenario(seed: number): Scenario {
  const rng = makePrng(seed);
  const coldLaunch = chance(rng, 0.7);
  const splashExit = pick(rng, [
    'videoEnd',
    'videoEnd',
    'videoError',
    'skip',
    'watchdog',
    'none',
  ] as const);
  const splashProgressS = intBetween(rng, 0, 4);
  const actions: Action[] = [];
  const count = intBetween(rng, 0, 6);
  for (let i = 0; i < count; i += 1) {
    const roll = rng();
    if (roll < 0.25) {
      actions.push({ kind: 'advance', ms: intBetween(rng, 0, 600) });
    } else if (roll < 0.5) {
      actions.push({
        kind: 'pressInOut',
        control: chance(rng, 0.6) ? 'start' : 'signIn',
        holdMs: intBetween(rng, 0, 300),
      });
    } else if (roll < 0.65) {
      actions.push({ kind: 'reduceMotion', value: chance(rng, 0.5) });
    } else if (roll < 0.85) {
      actions.push({
        kind: 'appState',
        state: pick(rng, ['background', 'active', 'inactive'] as const),
      });
    } else if (roll < 0.94) {
      actions.push({ kind: 'pressStart' });
      break;
    } else {
      actions.push({ kind: 'pressSignIn' });
      break;
    }
  }
  return {
    coldLaunch,
    splashExit,
    splashProgressS,
    actions,
    settleMs: intBetween(rng, 0, 2000),
  };
}

// ─── Store snapshots (a cold launch = every store back to module-load state)

type Store = {
  getState(): object;
  setState(state: object, replace: true): void;
};

const stores: Store[] = [
  useAuthStore as unknown as Store,
  useAppStore as unknown as Store,
  useNotificationStore as unknown as Store,
  useConsistencyStore as unknown as Store,
  useWalkthroughStore as unknown as Store,
];
const pristine = stores.map(store => store.getState());

function coldStores() {
  stores.forEach((store, i) => store.setState(pristine[i] as object, true));
}

// ─── Tree helpers ────────────────────────────────────────────────────────────

type Renderer = ReturnType<typeof TestRenderer.create>;

function pressables(renderer: Renderer, label: string): ReactTestInstance[] {
  const isMatch = (node: ReactTestInstance) =>
    node.props?.accessibilityLabel === label &&
    typeof node.props?.onPress === 'function';
  return renderer.root
    .findAll(isMatch)
    .filter(
      node =>
        node.findAll(child => child !== node && isMatch(child)).length === 0,
    );
}

function treeText(renderer: Renderer): string {
  return JSON.stringify(renderer.toJSON());
}

function statusBarStack(): number {
  return (StatusBar as unknown as { _propsStack: unknown[] })._propsStack
    .length;
}

function splashMounted(renderer: Renderer): boolean {
  return renderer.root.findAllByType(Video).length > 0;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const fetchCalls: string[] = [];
const realFetch = globalThis.fetch;
const ledger = trackListeners([
  {
    name: 'AppState',
    host: AppState as unknown as Record<string, unknown>,
    method: 'addEventListener',
  },
  {
    name: 'Dimensions',
    host: Dimensions as unknown as Record<string, unknown>,
    method: 'addEventListener',
  },
  {
    name: 'Appearance',
    host: Appearance as unknown as Record<string, unknown>,
    method: 'addChangeListener',
  },
  {
    name: 'AccessibilityInfo',
    host: AccessibilityInfo as unknown as Record<string, unknown>,
    method: 'addEventListener',
  },
  {
    name: 'Keyboard',
    host: Keyboard as unknown as Record<string, unknown>,
    method: 'addListener',
  },
  {
    name: 'Linking',
    host: Linking as unknown as Record<string, unknown>,
    method: 'addEventListener',
  },
  {
    name: 'DeviceEventEmitter',
    host: DeviceEventEmitter as unknown as Record<string, unknown>,
    method: 'addListener',
  },
]);

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['performance', 'hrtime'] });
  (globalThis as { fetch: unknown }).fetch = async (input: unknown) => {
    fetchCalls.push(String(input));
    throw new TypeError('Network request failed (stress stub)');
  };
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  ledger.restore();
  jest.useRealTimers();
});

describe('STRESS scr-welcomescreen — long-run-leak (real App, real stores, real splash)', () => {
  const plan = planCampaign();
  const suffix = plan.replaySeed === null ? '' : `.replay-${plan.replaySeed}`;

  it(
    `launches the real App to WelcomeScreen ${plan.iterations}× without leaking timers, listeners, StatusBar entries or heap`,
    async () => {
      const wallStart = nowMs();
      const gc = acquireGc();
      const clearMockRecords = shouldClearMockRecords();
      let canaryInjected = false;
      const rows: IterationRow[] = [];
      const trace = openJsonlArtifact(
        `app.welcomeScreen.longRunLeak${suffix}.trace.jsonl`,
      );
      const heapSamples: HeapSample[] = [];
      const mountTimes: number[] = [];
      const totalTimes: number[] = [];

      await advance(0);
      const baseline = {
        timers: jest.getTimerCount(),
        statusBarStack: statusBarStack(),
        listeners: ledger.live(),
        activeResources: activeResources(),
      };
      // Process singletons that subscribe once on first launch and stay by
      // design (Reduce Motion observer, store-level bootstraps) are pinned
      // after iteration 0; every later launch must return exactly to them.
      let steadyListeners: Record<string, number> | null = null;
      let steadyTimers: number | null = null;

      for (let index = 0; index < plan.seeds.length; index += 1) {
        const seed = plan.seeds[index] as number;
        const scenario = buildScenario(seed);
        const rng = makePrng(seed ^ 0x5bd1e995);
        const fetchBefore = fetchCalls.length;
        const observed: Record<string, unknown> = {};
        const checks: Record<string, boolean> = {};
        let navigatedTo: PreAuthStage | null = null;

        if (scenario.coldLaunch) coldStores();
        const wasHydrated = useAuthStore.getState().hydrated;

        const iterationStart = nowMs();
        let renderer!: Renderer;
        act(() => {
          renderer = TestRenderer.create(<App />);
        });
        const mountMs = nowMs() - iterationStart;

        const firstPaint = treeText(renderer);
        checks.splashUpOnFirstPaint = splashMounted(renderer);
        checks.loadingOrWelcomeOnFirstPaint =
          firstPaint.includes(LOADING) || firstPaint.includes(HERO);

        let slices = 0;
        while (
          !treeText(renderer).includes(HERO) &&
          slices < HYDRATION_SLICES
        ) {
          await advance(50);
          slices += 1;
        }
        observed.hydrationSlices = slices;
        observed.coldLaunch = scenario.coldLaunch;
        observed.storesAlreadyHydrated = wasHydrated;
        const readyMs = nowMs() - iterationStart;
        const painted = treeText(renderer);
        checks.welcomePaintedAfterHydration = painted.includes(HERO);
        checks.signedOutAfterHydration =
          useAuthStore.getState().hydrated &&
          useAuthStore.getState().session === null;
        checks.onePrimaryCta = pressables(renderer, START_LABEL).length === 1;
        checks.oneSignInLink = pressables(renderer, SIGN_IN_LABEL).length === 1;
        checks.noErrorBoundaryAfterHydration =
          !painted.includes(BOUNDARY_TITLE);

        // Splash exit path (the overlay sits over Welcome until then).
        const video = renderer.root.findAllByType(Video)[0];
        checks.splashStillOverWelcome = Boolean(video);
        let splashExited = scenario.splashExit !== 'none';
        if (video && scenario.splashProgressS > 0) {
          act(() => {
            video.props.onProgress?.({
              currentTime: scenario.splashProgressS,
              playableDuration: 6,
              seekableDuration: 6,
            });
          });
        }
        switch (scenario.splashExit) {
          case 'videoEnd':
            if (video) act(() => void video.props.onEnd?.());
            break;
          case 'videoError':
            if (video) {
              act(
                () =>
                  void video.props.onError?.({
                    error: {
                      code: -1,
                      domain: 'stress',
                      localizedDescription: 'stub',
                    },
                  }),
              );
            }
            break;
          case 'skip': {
            await advance(400);
            const skip = pressables(renderer, SKIP_LABEL)[0];
            observed.skipVisible = Boolean(skip);
            checks.skipShownAfterOneSecond =
              Boolean(skip) === scenario.splashProgressS >= 1;
            if (skip) act(() => void skip.props.onPress());
            else splashExited = false;
            break;
          }
          case 'watchdog':
            await advance(WATCHDOG_MS + 50);
            break;
          case 'none':
            break;
        }
        observed.splashExited = splashExited;
        if (splashExited) {
          await advance(1200);
          checks.splashGoneAfterExit = !splashMounted(renderer);
          checks.welcomeStillPaintedAfterSplash =
            treeText(renderer).includes(HERO);
        }

        for (const action of scenario.actions) {
          switch (action.kind) {
            case 'advance':
              await advance(action.ms);
              break;
            case 'pressInOut': {
              const label =
                action.control === 'start' ? START_LABEL : SIGN_IN_LABEL;
              const node = pressables(renderer, label)[0];
              if (!node) break;
              act(() => {
                node.props.onPressIn?.();
              });
              await advance(action.holdMs);
              act(() => {
                node.props.onPressOut?.();
              });
              break;
            }
            case 'reduceMotion': {
              const handlers = ledger.handlers('AccessibilityInfo');
              observed.reduceMotionHandlers = handlers.length;
              act(() => {
                for (const handler of handlers) {
                  if (typeof handler === 'function') handler(action.value);
                }
              });
              break;
            }
            case 'appState': {
              const handlers = ledger.handlers('AppState');
              observed.appStateHandlers = handlers.length;
              await act(async () => {
                for (const handler of handlers) {
                  if (typeof handler === 'function') handler(action.state);
                }
                await jest.advanceTimersByTimeAsync(0);
              });
              break;
            }
            case 'pressStart': {
              const node = pressables(renderer, START_LABEL)[0];
              checks.primaryCtaPresentBeforePress = Boolean(node);
              if (!node) break;
              act(() => {
                node.props.onPress();
              });
              navigatedTo = stageAfterGetStarted();
              break;
            }
            case 'pressSignIn': {
              const node = pressables(renderer, SIGN_IN_LABEL)[0];
              checks.signInLinkPresentBeforePress = Boolean(node);
              if (!node) break;
              act(() => {
                node.props.onPress();
              });
              navigatedTo = 'signin';
              break;
            }
          }
          if (chance(rng, 0.3)) await advance(intBetween(rng, 0, 200));
        }

        const afterActions = treeText(renderer);
        checks.noErrorBoundaryAfterActions =
          !afterActions.includes(BOUNDARY_TITLE);
        if (navigatedTo) {
          checks.gateRoutedOffWelcome =
            afterActions.includes(MARKER[navigatedTo]) &&
            !afterActions.includes(HERO);
        } else {
          checks.welcomeStillPainted = afterActions.includes(HERO);
        }
        checks.stillSignedOut = useAuthStore.getState().session === null;

        const unmountStart = nowMs();
        act(() => {
          renderer.unmount();
        });
        const unmountMs = nowMs() - unmountStart;
        await advance(scenario.settleMs);
        await advance(WATCHDOG_MS + 2000);
        const totalMs = nowMs() - iterationStart;

        const timersAfter = jest.getTimerCount();
        const stackAfter = statusBarStack();
        const listenersAfter = ledger.live();
        if (steadyListeners === null || steadyTimers === null) {
          steadyListeners = listenersAfter;
          steadyTimers = timersAfter;
          checks.firstLaunchLeavesNoTimers = timersAfter === baseline.timers;
          checks.firstLaunchAddsAtMostTheReduceMotionSingleton =
            ledger.liveCount() -
              Object.values(baseline.listeners).reduce((a, b) => a + b, 0) <=
            1;
        }
        checks.timersBackToSteadyState = timersAfter === steadyTimers;
        checks.statusBarStackBackToBaseline =
          stackAfter === baseline.statusBarStack;
        checks.listenersBackToSteadyState = sameCounts(
          listenersAfter,
          steadyListeners,
        );
        checks.noNetwork = fetchCalls.length === fetchBefore;

        Object.assign(observed, {
          readyMs,
          timersAfter,
          statusBarStackAfter: stackAfter,
          listenersAfter,
          navigatedTo,
        });
        const verdict = judgeChecks(checks);
        const row: IterationRow = {
          index,
          seed,
          outcome: verdict.outcome,
          failed: verdict.failed,
          mountMs,
          unmountMs,
          totalMs,
        };
        rows.push(row);
        trace.append({
          ...row,
          scenario: scenario as unknown as Record<string, unknown>,
          observed,
          checks,
        } satisfies IterationTrace);
        mountTimes.push(mountMs);
        totalTimes.push(totalMs);
        if (clearMockRecords) jest.clearAllMocks();
        canaryInjected = canaryRetain(index) || canaryInjected;

        const done = index + 1;
        if (done % CHECKPOINT_EVERY === 0 || done === plan.seeds.length) {
          heapSamples.push(
            takeHeapSample(done, gc?.gc ?? null, timersAfter, listenersAfter),
          );
        }
      }

      const heap = judgeHeap(heapSamples);
      const mountDrift = judgeDrift(mountTimes);
      const totalDrift = judgeDrift(totalTimes);
      const finalResources = activeResources();
      const growth = resourceGrowth(baseline.activeResources, finalResources);
      const brokenRows = rows.filter(row => row.outcome === 'BROKEN');
      const campaignChecks: Record<string, boolean> = {
        everyIterationHeld: brokenRows.length === 0,
        heapSlopeWithinLimit: !heap.finding,
        gcAvailable: gc !== null,
        mountTimeDriftWithinLimit: !mountDrift.overLimit,
        totalTimeDriftWithinLimit: !totalDrift.overLimit,
        noAppVisibleHandleGrowth: Object.keys(growth).length === 0,
        timersAtSteadyStateAtEnd: jest.getTimerCount() === (steadyTimers ?? 0),
        statusBarStackAtBaselineAtEnd:
          statusBarStack() === baseline.statusBarStack,
        fetchNeverCalled: fetchCalls.length === 0,
      };
      const campaign = judgeChecks(campaignChecks);

      const rowsFile = writeJsonArtifact(
        `app.welcomeScreen.longRunLeak${suffix}.rows.json`,
        rows,
      );
      const summaryFile = artifactPath(
        `app.welcomeScreen.longRunLeak${suffix}.summary.json`,
      );
      const summary: CampaignSummary = {
        unit: UNIT,
        lens: 'long-run-leak',
        suite: SUITE,
        node: nodeVersion(),
        gc: gc?.source ?? null,
        plan,
        trackedListenerSources: ledger.tracked(),
        mockRecordsCleared: clearMockRecords,
        canaryLeakInjected: canaryInjected,
        executed: rows.length,
        held: rows.length - brokenRows.length,
        broken: brokenRows.length,
        brokenSeeds: brokenRows.map(row => row.seed),
        heap,
        heapSamples,
        mountDrift,
        totalDrift,
        baseline,
        final: {
          timers: jest.getTimerCount(),
          statusBarStack: statusBarStack(),
          listeners: ledger.live(),
          activeResources: finalResources,
          resourceGrowth: growth,
        },
        campaignChecks,
        campaignFailed: campaign.failed,
        wallMs: nowMs() - wallStart,
        artifacts: { rows: rowsFile, trace: trace.file, summary: summaryFile },
      };
      writeJsonArtifact(
        `app.welcomeScreen.longRunLeak${suffix}.summary.json`,
        summary,
      );

      const report = {
        executed: rows.length,
        campaignFailed: campaign.failed,
        brokenSeeds: brokenRows.map(row => ({
          seed: row.seed,
          failed: row.failed,
          replay: replayHint(SUITE, row.seed),
        })),
        summary: summaryFile,
      };
      expect(report).toEqual({
        executed: plan.iterations,
        campaignFailed: [],
        brokenSeeds: [],
        summary: summaryFile,
      });
    },
    30 * 60_000,
  );
});
