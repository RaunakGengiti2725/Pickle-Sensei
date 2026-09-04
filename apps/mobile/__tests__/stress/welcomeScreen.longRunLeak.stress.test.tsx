/**
 * STRESS `scr-welcomescreen` / LENS `long-run-leak` — harness A: the screen.
 *
 * Mounts the REAL WelcomeScreen inside the exact provider shell App.tsx uses
 * (real SafeAreaProvider with iPhone metrics, the real QueryClientProvider,
 * the app's StatusBar, the real RootErrorBoundary) under a Gate-shaped host
 * that owns the pre-auth stage exactly like Gate does (`stageAfterGetStarted`
 * is the real launch-gate rule), then unmounts it — N times in ONE process.
 * Nothing under the screen is mocked: react-native-svg (CourtStory), the
 * design components (Animated press feedback, the Reduce Motion observer)
 * and the react-native-safe-area-context provider are the real modules.
 * Only process edges are faked: fetch (must never be called), the SQLite
 * and Google Sign-In native modules App.tsx's import graph touches, and the
 * non-unit sibling screens behind the Gate (RootNavigator / Onboarding /
 * SignIn are text markers so their own native graphs stay out of the heap).
 *
 * Every iteration is a seeded scenario (insets profile, with/without the
 * sign-in link, a press/re-render/reduce-motion/AppState action script,
 * fake-clock advances) and its own row in the JSON table. After each
 * unmount the pending fake timers, the StatusBar props stack, the live RN
 * event subscriptions, the React Query cache and the fetch count must all be
 * back at the pre-mount baseline. Every CHECKPOINT_EVERY iterations the heap
 * is measured after a forced GC together with the libuv handle table; a
 * monotone slope > 5 % per 100 iterations is a finding, as is a render-time
 * p50 that drifts past DRIFT_RATIO_LIMIT.
 *
 * Default:   npx jest --ci __tests__/stress/welcomeScreen.longRunLeak.stress.test.tsx
 * Campaign:  STRESS_ITER=500 NODE_OPTIONS=--expose-gc npx jest --ci --runInBand <file>
 * Replay:    STRESS_REPLAY=<seed> npx jest --ci --runInBand <file>
 * Artifacts: artifacts/stress/welcomeScreen.longRunLeak.{rows,summary}.json
 *            + .trace.jsonl (one full scenario/observed/checks record per row)
 */
import React, { useState } from 'react';
import {
  AccessibilityInfo,
  Appearance,
  AppState,
  DeviceEventEmitter,
  Dimensions,
  Keyboard,
  Linking,
  StatusBar,
  Text,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

// ─── Process edges (native modules + non-unit screens) ───────────────────────

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

import { RootErrorBoundary } from '../../App';
import { WelcomeScreen } from '../../src/screens/WelcomeScreen';
import {
  stageAfterGetStarted,
  type PreAuthStage,
} from '../../src/flow/launchGate';

const SUITE = '__tests__/stress/welcomeScreen.longRunLeak.stress.test.tsx';
const UNIT = 'scr-welcomescreen';
const START_LABEL = 'Start your first read';
const SIGN_IN_LABEL = 'I already have an account';
const HERO = 'See the stroke.';
const BOUNDARY_TITLE = 'Something went wrong';

// ─── Seeded scenario ─────────────────────────────────────────────────────────

const INSET_PROFILES = {
  'iphone-se-375x667': {
    frame: { x: 0, y: 0, width: 375, height: 667 },
    insets: { top: 20, bottom: 0, left: 0, right: 0 },
  },
  'iphone-15-393x852': {
    frame: { x: 0, y: 0, width: 393, height: 852 },
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  },
  'iphone-15-pro-max-430x932': {
    frame: { x: 0, y: 0, width: 430, height: 932 },
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  },
  'iphone-13-mini-375x812': {
    frame: { x: 0, y: 0, width: 375, height: 812 },
    insets: { top: 50, bottom: 34, left: 0, right: 0 },
  },
} as const;
type InsetProfile = keyof typeof INSET_PROFILES;

type Action =
  | { kind: 'advance'; ms: number }
  | { kind: 'pressInOut'; control: 'start' | 'signIn'; holdMs: number }
  | { kind: 'rerender' }
  | { kind: 'toggleSignIn' }
  | { kind: 'reduceMotion'; value: boolean }
  | { kind: 'appState'; state: 'background' | 'active' | 'inactive' }
  | { kind: 'pressStart' }
  | { kind: 'pressSignIn' };

interface Scenario {
  insets: InsetProfile;
  signIn: boolean;
  actions: Action[];
  settleMs: number;
}

function buildScenario(seed: number): Scenario {
  const rng = makePrng(seed);
  const insets = pick(rng, Object.keys(INSET_PROFILES) as InsetProfile[]);
  const signIn = chance(rng, 0.85);
  const actions: Action[] = [];
  const count = intBetween(rng, 0, 6);
  for (let i = 0; i < count; i += 1) {
    const roll = rng();
    if (roll < 0.2) {
      actions.push({ kind: 'advance', ms: intBetween(rng, 0, 600) });
    } else if (roll < 0.45) {
      actions.push({
        kind: 'pressInOut',
        control: chance(rng, 0.6) ? 'start' : 'signIn',
        holdMs: intBetween(rng, 0, 300),
      });
    } else if (roll < 0.58) {
      actions.push({ kind: 'rerender' });
    } else if (roll < 0.66) {
      actions.push({ kind: 'toggleSignIn' });
    } else if (roll < 0.78) {
      actions.push({ kind: 'reduceMotion', value: chance(rng, 0.5) });
    } else if (roll < 0.88) {
      actions.push({
        kind: 'appState',
        state: pick(rng, ['background', 'active', 'inactive'] as const),
      });
    } else if (roll < 0.95) {
      actions.push({ kind: 'pressStart' });
      break;
    } else {
      actions.push({ kind: 'pressSignIn' });
      break;
    }
  }
  return { insets, signIn, actions, settleMs: intBetween(rng, 0, 2000) };
}

// ─── Gate-shaped host ────────────────────────────────────────────────────────

const stageLog: PreAuthStage[] = [];

function PreAuthHost(props: { signIn: boolean; generation: number }) {
  const [stage, setStage] = useState<PreAuthStage>('welcome');
  if (stage !== 'welcome') return <Text>{`STAGE:${stage}`}</Text>;
  const go = (next: PreAuthStage) => {
    stageLog.push(next);
    setStage(next);
  };
  return (
    <WelcomeScreen
      key={props.generation}
      onGetStarted={() => go(stageAfterGetStarted())}
      onSignIn={props.signIn ? () => go('signin') : undefined}
    />
  );
}

const queryClient = new QueryClient();

function shell(scenario: Scenario, signIn: boolean, generation: number) {
  const metrics = INSET_PROFILES[scenario.insets];
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <QueryClientProvider client={queryClient}>
        <StatusBar barStyle="dark-content" />
        <RootErrorBoundary>
          <PreAuthHost signIn={signIn} generation={generation} />
        </RootErrorBoundary>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
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

describe('STRESS scr-welcomescreen — long-run-leak (screen in the app shell)', () => {
  const plan = planCampaign();
  const suffix = plan.replaySeed === null ? '' : `.replay-${plan.replaySeed}`;

  it(
    `mounts and unmounts WelcomeScreen ${plan.iterations}× without leaking timers, listeners, StatusBar entries, queries or heap`,
    async () => {
      const wallStart = nowMs();
      const gc = acquireGc();
      const clearMockRecords = shouldClearMockRecords();
      let canaryInjected = false;
      const rows: IterationRow[] = [];
      const trace = openJsonlArtifact(
        `welcomeScreen.longRunLeak${suffix}.trace.jsonl`,
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
      // The design system's Reduce Motion observer subscribes ONCE per
      // process on the first mount and stays (module singleton, by design);
      // the steady state is pinned after the first iteration and every later
      // iteration must return exactly to it.
      let steadyListeners: Record<string, number> | null = null;

      for (let index = 0; index < plan.seeds.length; index += 1) {
        const seed = plan.seeds[index] as number;
        const scenario = buildScenario(seed);
        const rng = makePrng(seed ^ 0x5bd1e995);
        const stageBefore = stageLog.length;
        const fetchBefore = fetchCalls.length;
        let signIn = scenario.signIn;
        let generation = 0;
        let navigatedTo: PreAuthStage | null = null;
        const observed: Record<string, unknown> = {};

        const iterationStart = nowMs();
        let renderer!: Renderer;
        act(() => {
          renderer = TestRenderer.create(shell(scenario, signIn, generation));
        });
        const mountMs = nowMs() - iterationStart;

        const afterMount = treeText(renderer);
        const checks: Record<string, boolean> = {
          heroPainted: afterMount.includes(HERO),
          onePrimaryCta: pressables(renderer, START_LABEL).length === 1,
          signInLinkMatchesProps:
            pressables(renderer, SIGN_IN_LABEL).length === (signIn ? 1 : 0),
          noErrorBoundaryOnMount: !afterMount.includes(BOUNDARY_TITLE),
        };

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
            case 'rerender':
              generation += 1;
              act(() => {
                renderer.update(shell(scenario, signIn, generation));
              });
              break;
            case 'toggleSignIn':
              signIn = !signIn;
              act(() => {
                renderer.update(shell(scenario, signIn, generation));
              });
              checks.signInLinkFollowsRerender =
                pressables(renderer, SIGN_IN_LABEL).length === (signIn ? 1 : 0);
              break;
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
              act(() => {
                for (const handler of handlers) {
                  if (typeof handler === 'function') handler(action.state);
                }
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
              checks.signInLinkPresenceMatches = Boolean(node) === signIn;
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
          checks.navigationUnmountedScreen =
            afterActions.includes(`STAGE:${navigatedTo}`) &&
            !afterActions.includes(HERO);
          checks.stageCallbackFiredOnce =
            stageLog.length === stageBefore + 1 &&
            stageLog[stageLog.length - 1] === navigatedTo;
        } else {
          checks.screenStillPainted = afterActions.includes(HERO);
          checks.noStageCallbackWithoutPress = stageLog.length === stageBefore;
        }

        const unmountStart = nowMs();
        act(() => {
          renderer.unmount();
        });
        const unmountMs = nowMs() - unmountStart;
        await advance(scenario.settleMs);
        await advance(2000);
        const totalMs = nowMs() - iterationStart;

        const timersAfter = jest.getTimerCount();
        const stackAfter = statusBarStack();
        const listenersAfter = ledger.live();
        if (steadyListeners === null) {
          steadyListeners = listenersAfter;
          checks.firstMountAddsAtMostTheReduceMotionSingleton =
            ledger.liveCount() -
              Object.values(baseline.listeners).reduce((a, b) => a + b, 0) <=
              1 &&
            (listenersAfter['AccessibilityInfo'] ?? 0) -
              (baseline.listeners['AccessibilityInfo'] ?? 0) <=
              1;
        }
        checks.timersBackToBaseline = timersAfter === baseline.timers;
        checks.statusBarStackBackToBaseline =
          stackAfter === baseline.statusBarStack;
        checks.listenersBackToSteadyState = sameCounts(
          listenersAfter,
          steadyListeners,
        );
        checks.queryCacheEmpty =
          queryClient.getQueryCache().getAll().length === 0 &&
          queryClient.getMutationCache().getAll().length === 0;
        checks.noNetwork = fetchCalls.length === fetchBefore;

        Object.assign(observed, {
          timersAfter,
          statusBarStackAfter: stackAfter,
          listenersAfter,
          navigatedTo,
          finalSignIn: signIn,
          rerenders: generation,
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
        timersAtBaselineAtEnd: jest.getTimerCount() === baseline.timers,
        statusBarStackAtBaselineAtEnd:
          statusBarStack() === baseline.statusBarStack,
        fetchNeverCalled: fetchCalls.length === 0,
      };
      const campaign = judgeChecks(campaignChecks);

      const rowsFile = writeJsonArtifact(
        `welcomeScreen.longRunLeak${suffix}.rows.json`,
        rows,
      );
      const summaryFile = artifactPath(
        `welcomeScreen.longRunLeak${suffix}.summary.json`,
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
        `welcomeScreen.longRunLeak${suffix}.summary.json`,
        summary,
      );
      expect(summaryFile).toBe(summary.artifacts.summary);

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
