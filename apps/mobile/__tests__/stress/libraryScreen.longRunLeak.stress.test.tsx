/**
 * LONG-RUN LEAK campaign for src/screens/LibraryScreen.tsx.
 *
 * Mounts the REAL LibraryScreen inside the real provider/navigator stack the
 * app uses (SafeAreaProvider → QueryClientProvider → NavigationContainer →
 * native stack → bottom tabs → LibraryScreen, plus BrandNoticeHost) and tears
 * the whole tree down again, N times in ONE process. Navigation, the zustand
 * auth/training stores, the training API client and the repository are all
 * real; only native modules (op-sqlite, react-native-screens, safe-area
 * insets, Linking) and `fetch` are replaced, and `zustand/vanilla` is wrapped
 * (not replaced) so live store subscriptions can be counted.
 *
 * Every iteration is a pure function of a 32-bit seed (scenario data, server
 * behaviour, interaction script) so any row of the emitted JSON table can be
 * replayed alone. After each unmount the harness forces a GC and checks that
 * timers, RN event listeners, zustand subscriptions, the StatusBar stack and
 * console errors are back at baseline, and that the previous iterations'
 * renderer/db/server objects are collectable (WeakRef). Heap is sampled every
 * STRESS_SAMPLE_EVERY iterations; the campaign fails on a heap slope above
 * 5% per 100 iterations, and render time drift is reported.
 *
 * Default is a quick in-suite smoke (STRESS_ITER=40). The full campaign:
 *
 *   NODE_OPTIONS=--expose-gc STRESS_ITER=500 npx jest --ci -i \
 *     __tests__/stress/libraryScreen.longRunLeak.stress.test.tsx
 *
 * Replay one or more seeds: STRESS_REPLAY=<seed>,<seed>. Artifacts land in
 * <repo>/artifacts/stress/ (override with STRESS_ARTIFACT_DIR).
 */

// Wrap (never replace) zustand's store factory so the harness can count live
// subscriptions across every store in the process.
jest.mock('zustand/vanilla', () => {
  const actual =
    jest.requireActual<typeof import('zustand/vanilla')>('zustand/vanilla');
  const probe = jest.requireActual<
    typeof import('../../xc-harness/stress/zustandProbe')
  >('../../xc-harness/stress/zustandProbe');
  return {
    ...actual,
    createStore: probe.instrumentedCreateStore(actual.createStore),
  };
});

// Native modules only.
jest.mock(
  'react-native-safe-area-context',
  () =>
    jest.requireActual<{ default: unknown }>(
      'react-native-safe-area-context/jest/mock',
    ).default,
);
jest.mock('react-native-screens', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Passthrough = (props: { children?: React.ReactNode }) =>
    React.createElement(View, props, props.children);
  const statics: Record<string, unknown> = {
    __esModule: true,
    enableScreens: () => undefined,
    enableFreeze: () => undefined,
    screensEnabled: () => false,
    freezeEnabled: () => false,
    isSearchBarAvailableForCurrentPlatform: false,
    executeNativeBackPress: () => false,
    useTransitionProgress: () => ({ progress: { value: 1 } }),
    compatibilityFlags: {},
    featureFlags: {},
  };
  return new Proxy(statics, {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined;
      return prop in target ? target[prop] : Passthrough;
    },
  });
});
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    const g = globalThis as { __stressCurrentDb?: unknown };
    if (!g.__stressCurrentDb) throw new Error('stress db not configured');
    return g.__stressCurrentDb;
  },
}));

import React from 'react';
import { Linking, Pressable, StatusBar, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type {
  MainTabParams,
  RootStackParams,
} from '../../src/navigation/params';
import {
  LibraryScreen,
  MUTATION_ERROR_DISMISS_HINT,
} from '../../src/screens/LibraryScreen';
import { BrandNoticeHost } from '../../src/design/BrandNotice';
import { useAuthStore } from '../../src/auth/authStore';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import { createTrainingApi } from '../../src/training/api';
import { setActiveDataOwner } from '../../src/data/accountScope';
import {
  STRESS_OWNER,
  StressLocalDb,
  makeStressServer,
  scenarioFromSeed,
  type Interaction,
  type LibraryScenario,
} from '../../xc-harness/stress/libraryScenario';
import {
  activeResources,
  envInt,
  envIntList,
  forceGc,
  gcAvailable,
  heapSlope,
  iterationSeed,
  nowMs,
  round3,
  sampleHeap,
  timingDrift,
  writeStressArtifact,
  zustandSubscriptions,
  type HeapSample,
} from '../../xc-harness/stress/leakProbe';

const ITERATIONS = envInt('STRESS_ITER', 40);
/** Wall clock captured before fake timers take over Date. */
const startedAt = new Date().toISOString();
const CAMPAIGN_SEED = envInt('STRESS_SEED', 20260904);
const SAMPLE_EVERY = envInt('STRESS_SAMPLE_EVERY', 50);
const REPLAY = envIntList('STRESS_REPLAY');
const WARMUP = envInt(
  'STRESS_WARMUP',
  ITERATIONS >= 300 ? 100 : Math.min(10, Math.floor(ITERATIONS / 4)),
);
const KEEP_MOCK_CALLS = envInt('STRESS_KEEP_MOCK_CALLS', 0) === 1;
const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;
/** Per-iteration budget for the jest timeout (cold Babel transform included). */
const ITERATION_BUDGET_MS = 3000;

const seeds =
  REPLAY.length > 0
    ? REPLAY
    : Array.from({ length: ITERATIONS }, (_, i) =>
        iterationSeed(CAMPAIGN_SEED, i),
      );

// ---------------------------------------------------------------------------
// Real navigator shell mirroring RootNavigator's shape. Sibling routes are
// stubs (they are other units); Library is the real screen under test.

const Stack = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<MainTabParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();

function StubRoute({
  route,
  navigation,
}: NativeStackScreenProps<RootStackParams>) {
  return (
    <View>
      <Text>{`stub:${route.name}`}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`stub-back-${route.name}`}
        onPress={() => navigation.goBack()}
      >
        <Text>Back</Text>
      </Pressable>
    </View>
  );
}

function HomeStub() {
  return (
    <View>
      <Text>stub:Home</Text>
    </View>
  );
}

function MainTabs() {
  return (
    <Tabs.Navigator
      initialRouteName="Library"
      screenOptions={{ headerShown: false, tabBarHideOnKeyboard: true }}
    >
      <Tabs.Screen
        name="Home"
        component={HomeStub}
        options={{ tabBarButtonTestID: 'tab-Home' }}
      />
      <Tabs.Screen
        name="Library"
        component={LibraryScreen}
        options={{ tabBarButtonTestID: 'tab-Library' }}
      />
    </Tabs.Navigator>
  );
}

function Harness({ queryClient }: { queryClient: QueryClient }) {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <NavigationContainer ref={navigationRef}>
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="Tabs" component={MainTabs} />
            <Stack.Screen name="Analyze" component={StubRoute} />
            <Stack.Screen name="Result" component={StubRoute} />
            <Stack.Screen name="DrillLibrary" component={StubRoute} />
            <Stack.Screen name="ConnectAccount" component={StubRoute} />
          </Stack.Navigator>
        </NavigationContainer>
        <BrandNoticeHost />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

// ---------------------------------------------------------------------------
// Listener accounting for the RN event surfaces a screen/navigator can hold.

interface Subscription {
  remove?: () => void;
}
type AddListener = (...args: unknown[]) => Subscription | undefined;

let activeRnListeners = 0;
const activeRnListenerKinds = new Map<string, number>();

function wrapListenerSurface(
  name: string,
  target: Record<string, unknown>,
  method: string,
): void {
  const original = target[method];
  if (typeof original !== 'function') return;
  target[method] = (...args: unknown[]) => {
    const subscription = (original as AddListener).apply(target, args);
    const kind = `${name}.${method}(${String(args[0])})`;
    activeRnListeners += 1;
    activeRnListenerKinds.set(kind, (activeRnListenerKinds.get(kind) ?? 0) + 1);
    let removed = false;
    const remove = subscription?.remove;
    const wrapped: Subscription = {
      ...(subscription ?? {}),
      remove: () => {
        if (!removed) {
          removed = true;
          activeRnListeners -= 1;
          activeRnListenerKinds.set(
            kind,
            (activeRnListenerKinds.get(kind) ?? 0) - 1,
          );
        }
        if (typeof remove === 'function') remove.call(subscription);
      },
    };
    return wrapped;
  };
}

function listenerKinds(): Record<string, number> {
  return Object.fromEntries(
    [...activeRnListenerKinds.entries()].filter(([, count]) => count !== 0),
  );
}

const RN = jest.requireActual<typeof import('react-native')>('react-native');
for (const [name, surface, method] of [
  ['AppState', RN.AppState, 'addEventListener'],
  ['Dimensions', RN.Dimensions, 'addEventListener'],
  ['Linking', RN.Linking, 'addEventListener'],
  ['Keyboard', RN.Keyboard, 'addListener'],
  ['AccessibilityInfo', RN.AccessibilityInfo, 'addEventListener'],
  ['BackHandler', RN.BackHandler, 'addEventListener'],
] as const) {
  wrapListenerSurface(
    name,
    surface as unknown as Record<string, unknown>,
    method,
  );
}

// ---------------------------------------------------------------------------
// Tree helpers (react-test-renderer).

type Renderer = TestRenderer.ReactTestRenderer;
type Node = TestRenderer.ReactTestInstance;

function subtreeHasText(node: Node, text: string): boolean {
  return (
    node.findAll(
      child =>
        child.type === Text &&
        (child.props.children === text ||
          (Array.isArray(child.props.children) &&
            child.props.children.join('') === text)),
    ).length > 0
  );
}

function findPressable(
  renderer: Renderer,
  predicate: (node: Node) => boolean,
): Node | null {
  const matches = renderer.root.findAll(
    node => typeof node.props.onPress === 'function' && predicate(node),
  );
  return matches[0] ?? null;
}

function byLabel(label: string | ((value: string) => boolean)) {
  return (node: Node) => {
    const value = node.props.accessibilityLabel;
    if (typeof value !== 'string') return false;
    return typeof label === 'string' ? value === label : label(value);
  };
}

function byText(text: string) {
  return (node: Node) => subtreeHasText(node, text);
}

async function press(node: Node): Promise<void> {
  await act(async () => {
    node.props.onPress();
  });
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

/** Advance fake timers and drain promise chains until the tree is quiet. */
async function settle(rounds = 6, stepMs = 200): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      jest.advanceTimersByTime(stepMs);
      await flushMicrotasks();
    });
  }
}

function currentRoute(): string | null {
  if (!navigationRef.isReady()) return null;
  return navigationRef.getCurrentRoute()?.name ?? null;
}

async function backToLibrary(renderer: Renderer): Promise<void> {
  for (let guard = 0; guard < 5; guard += 1) {
    const route = currentRoute();
    if (route === null || route === 'Library') return;
    const back = findPressable(renderer, byLabel(`stub-back-${route}`));
    if (!back) return;
    await press(back);
    await settle(2);
  }
}

// ---------------------------------------------------------------------------
// One iteration.

interface IterationRow {
  index: number;
  seed: number;
  inputs: LibraryScenario;
  observed: {
    interactions: string[];
    finalRoute: string | null;
    dbStatements: number;
    serverRequests: number;
    textNodesAtPeak: number;
    zustandSubsAtPeak: number;
    rnListenersAtPeak: number;
    timersAfterUnmount: number;
    rnListenersAfterUnmount: number;
    zustandSubsAfterUnmount: number;
    statusBarStackAfterUnmount: number;
    consoleErrors: string[];
    retainedOlder: number;
    retainedPrevious: number;
    mountToSettledMs: number;
    totalMs: number;
  };
  invariants: Record<string, boolean>;
  ok: boolean;
  failed: string[];
}

interface Retained {
  index: number;
  refs: WeakRef<object>[];
}

interface Baseline {
  timers: number;
  rnListeners: number;
  zustandSubs: number;
  statusBarStack: number;
}

const retained: Retained[] = [];

function statusBarStackDepth(): number {
  const stack = (StatusBar as unknown as { _propsStack?: unknown[] })
    ._propsStack;
  return Array.isArray(stack) ? stack.length : -1;
}

function countRetained(fromInclusive: number, toExclusive: number): number {
  let alive = 0;
  for (const entry of retained) {
    if (entry.index < fromInclusive || entry.index >= toExclusive) continue;
    for (const ref of entry.refs) if (ref.deref() !== undefined) alive += 1;
  }
  return alive;
}

function pruneRetained(): void {
  for (let i = retained.length - 1; i >= 0; i -= 1) {
    if (retained[i]!.refs.every(ref => ref.deref() === undefined)) {
      retained.splice(i, 1);
    }
  }
}

async function runIteration(
  index: number,
  seed: number,
  baseline: Baseline,
  consoleErrors: string[],
): Promise<IterationRow> {
  const scenario = scenarioFromSeed(seed);
  const startedAt = nowMs();
  consoleErrors.length = 0;

  // --- state the app would hold for this account ---------------------------
  useTrainingStore.getState().reset();
  clearTrainingStoreConfiguration();
  const server = makeStressServer(scenario);
  if (scenario.savedServer !== 'unconfigured') {
    configureTrainingStore(
      createTrainingApi({
        baseUrl: 'https://stress.invalid',
        token: 'stress-bearer',
        fetchFn: server.fetch,
      }),
    );
  }
  setActiveDataOwner(STRESS_OWNER);
  useAuthStore.setState({
    session: {
      provider: scenario.localOnly ? 'guest' : 'apple',
      subject: 'stress-subject',
      canonicalAppUserId: scenario.localOnly ? null : STRESS_OWNER,
      localOnly: scenario.localOnly,
      displayName: null,
      email: null,
    },
  });
  const db = new StressLocalDb(scenario, {
    failFirstReads: scenario.readsMode === 'fail-then-retry' ? 2 : 0,
    gated: scenario.readsMode === 'never-settles',
  });
  (globalThis as { __stressCurrentDb?: unknown }).__stressCurrentDb = db;
  const canOpen = jest
    .spyOn(Linking, 'canOpenURL')
    .mockImplementation(async () => scenario.mediaOpens);
  const openUrl = jest
    .spyOn(Linking, 'openURL')
    .mockImplementation(async () => undefined);
  const queryClient = new QueryClient();

  // --- mount ---------------------------------------------------------------
  let renderer!: Renderer;
  const mountStart = nowMs();
  await act(async () => {
    renderer = TestRenderer.create(<Harness queryClient={queryClient} />);
  });
  const midFlight = scenario.unmountMidFlight;
  if (!midFlight) await settle();
  const mountToSettledMs = nowMs() - mountStart;
  const textNodesAtPeak = renderer.root.findAllByType(Text).length;
  const zustandSubsAtPeak = zustandSubscriptions();
  const rnListenersAtPeak = activeRnListeners;

  // --- interactions --------------------------------------------------------
  const applied: string[] = [];
  const selectTab = async (label: 'Saved drills' | 'Reads') => {
    const tab = findPressable(
      renderer,
      node => node.props.accessibilityRole === 'tab' && byText(label)(node),
    );
    if (!tab) return false;
    if (tab.props.accessibilityState?.selected === true) return true;
    await press(tab);
    await settle(2);
    return true;
  };
  const SAVED_TAB_STEPS: Interaction[] = [
    'browse-drills',
    'connect-account',
    'retry-saved',
    'unsave-first',
    'dismiss-mutation-error',
    'open-media',
    'open-plan',
  ];
  const READS_TAB_STEPS: Interaction[] = [
    'open-first-read',
    'retry-reads',
    'analyze-cta',
  ];
  const perform = async (step: Interaction): Promise<string> => {
    if (SAVED_TAB_STEPS.includes(step)) await selectTab('Saved drills');
    if (READS_TAB_STEPS.includes(step)) await selectTab('Reads');
    switch (step) {
      case 'tab-saved':
      case 'tab-reads': {
        const label = step === 'tab-saved' ? 'Saved drills' : 'Reads';
        const tab = findPressable(
          renderer,
          node => node.props.accessibilityRole === 'tab' && byText(label)(node),
        );
        if (!tab) return `${step}:missing`;
        await press(tab);
        return step;
      }
      case 'open-first-read': {
        const row = findPressable(
          renderer,
          byLabel(v => v.startsWith('Open ') && v.endsWith(' result')),
        );
        if (!row) return `${step}:missing`;
        await press(row);
        await settle(2);
        const route = currentRoute();
        await backToLibrary(renderer);
        return `${step}:${route}`;
      }
      case 'open-plan': {
        const card = findPressable(
          renderer,
          byLabel('Open your current personalized plan'),
        );
        if (!card) return `${step}:missing`;
        await press(card);
        await settle(2);
        const route = currentRoute();
        await backToLibrary(renderer);
        return `${step}:${route}`;
      }
      case 'browse-drills': {
        const card = findPressable(
          renderer,
          byLabel('Explore the Drill Library'),
        );
        if (!card) return `${step}:missing`;
        await press(card);
        await settle(2);
        const route = currentRoute();
        await backToLibrary(renderer);
        return `${step}:${route}`;
      }
      case 'connect-account': {
        const button = findPressable(renderer, byText('Connect account'));
        if (!button) return `${step}:missing`;
        await press(button);
        await settle(2);
        const route = currentRoute();
        await backToLibrary(renderer);
        return `${step}:${route}`;
      }
      case 'analyze-cta': {
        const button = findPressable(
          renderer,
          byText('Analyze your first stroke'),
        );
        if (!button) return `${step}:missing`;
        await press(button);
        await settle(2);
        const route = currentRoute();
        await backToLibrary(renderer);
        return `${step}:${route}`;
      }
      case 'retry-reads':
      case 'retry-saved': {
        const button = findPressable(renderer, byText('Try again'));
        if (!button) return `${step}:missing`;
        await press(button);
        return step;
      }
      case 'unsave-first': {
        const button = findPressable(
          renderer,
          byLabel(
            v => v.startsWith('Remove ') && v.endsWith('from saved drills'),
          ),
        );
        if (!button) return `${step}:missing`;
        await press(button);
        return step;
      }
      case 'dismiss-mutation-error': {
        const button = findPressable(
          renderer,
          node => node.props.accessibilityHint === MUTATION_ERROR_DISMISS_HINT,
        );
        if (!button) return `${step}:missing`;
        await press(button);
        return step;
      }
      case 'open-media': {
        const button = findPressable(
          renderer,
          byLabel(v => v.startsWith('Watch reviewed instruction for')),
        );
        if (!button) return `${step}:missing`;
        await press(button);
        await settle(2);
        const notice = renderer.root.findAll(
          node => node.props.testID === 'brand-notice',
        );
        const gotIt = findPressable(renderer, byText('Got it'));
        if (gotIt) {
          await press(gotIt);
          return `${step}:notice-dismissed`;
        }
        return `${step}:${notice.length > 0 ? 'notice' : 'opened'}`;
      }
      case 'blur-home-and-back': {
        const home = findPressable(
          renderer,
          node => node.props.testID === 'tab-Home',
        );
        const library = findPressable(
          renderer,
          node => node.props.testID === 'tab-Library',
        );
        if (!home || !library) return `${step}:missing`;
        await press(home);
        await settle(2);
        await press(library);
        return step;
      }
    }
  };
  if (!midFlight) {
    for (const step of scenario.interactions) {
      applied.push(await perform(step));
      await settle(2);
    }
    if (db.gate && !db.gate.opened) {
      db.gate.open();
      await settle(3);
    }
  } else {
    await act(async () => {
      await flushMicrotasks();
    });
  }
  const finalRoute = currentRoute();

  // --- unmount ---------------------------------------------------------------
  await act(async () => {
    renderer.unmount();
  });
  if (db.gate && !db.gate.opened) db.gate.open();
  await settle(3, 500);
  await act(async () => {
    jest.advanceTimersByTime(5000);
    await flushMicrotasks();
  });
  queryClient.clear();
  canOpen.mockRestore();
  openUrl.mockRestore();
  (globalThis as { __stressCurrentDb?: unknown }).__stressCurrentDb = undefined;
  // Jest mocks (the RN preset's native-module jest.fn()s included) record
  // every call's arguments forever; those records pin props/closures and are
  // harness state, not app state. Drop them unless a diagnosis wants them.
  if (!KEEP_MOCK_CALLS) jest.clearAllMocks();

  const timersAfterUnmount = jest.getTimerCount();
  const rnListenersAfterUnmount = activeRnListeners;
  const zustandSubsAfterUnmount = zustandSubscriptions();
  const statusBarStackAfterUnmount = statusBarStackDepth();

  retained.push({
    index,
    refs: [new WeakRef(renderer), new WeakRef(db), new WeakRef(server)],
  });
  renderer = undefined as unknown as Renderer;
  forceGc();
  await flushMicrotasks();
  forceGc();
  const retainedOlder = countRetained(0, index - 1);
  const retainedPrevious = countRetained(index - 1, index);
  pruneRetained();

  const errors = [...consoleErrors];
  const invariants: Record<string, boolean> = {
    mountedAndUnmountedWithoutThrow: true,
    timersBackToBaseline: timersAfterUnmount <= baseline.timers,
    rnListenersBackToBaseline: rnListenersAfterUnmount <= baseline.rnListeners,
    zustandSubscriptionsBackToBaseline:
      zustandSubsAfterUnmount <= baseline.zustandSubs,
    statusBarStackBackToBaseline:
      statusBarStackAfterUnmount <= baseline.statusBarStack,
    noConsoleErrors: errors.length === 0,
    olderIterationsCollected: !gcAvailable() || retainedOlder === 0,
  };
  const failed = Object.entries(invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  return {
    index,
    seed,
    inputs: scenario,
    observed: {
      interactions: applied,
      finalRoute,
      dbStatements: db.statements.length,
      serverRequests: server.requests.length,
      textNodesAtPeak,
      zustandSubsAtPeak,
      rnListenersAtPeak,
      timersAfterUnmount,
      rnListenersAfterUnmount,
      zustandSubsAfterUnmount,
      statusBarStackAfterUnmount,
      consoleErrors: errors,
      retainedOlder,
      retainedPrevious,
      mountToSettledMs: round3(mountToSettledMs),
      totalMs: round3(nowMs() - startedAt),
    },
    invariants,
    ok: failed.length === 0,
    failed,
  };
}

// ---------------------------------------------------------------------------

describe('LibraryScreen long-run leak campaign', () => {
  const rows: IterationRow[] = [];
  const heapSamples: HeapSample[] = [];
  const durations: number[] = [];
  const consoleErrors: string[] = [];
  let baseline!: Baseline;
  let baselineHandles = -1;
  let baselineListenerKinds: Record<string, number> = {};
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  const campaignLabel =
    REPLAY.length > 0
      ? `replay ${REPLAY.join(',')}`
      : `seed ${CAMPAIGN_SEED} × ${ITERATIONS}`;

  beforeAll(() => {
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'hrtime',
        'performance',
      ],
    });
    const record =
      (prefix: string) =>
      (...args: unknown[]) => {
        consoleErrors.push(
          `${prefix}: ${args
            .map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
            .join(' ')
            .slice(0, 400)}`,
        );
      };
    errorSpy = jest.spyOn(console, 'error').mockImplementation(record('error'));
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(record('warn'));
  });

  afterAll(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    jest.useRealTimers();
  });

  it(
    `mounts and unmounts the real Library tab ${seeds.length}× (${campaignLabel}) without retaining timers, listeners, subscriptions or heap`,
    async () => {
      const campaignStartMs = nowMs();
      // Warm the module graph once so the baseline is not the first-render cost.
      const warm = new QueryClient();
      let warmRenderer!: Renderer;
      (globalThis as { __stressCurrentDb?: unknown }).__stressCurrentDb =
        new StressLocalDb(scenarioFromSeed(0), {
          failFirstReads: 0,
          gated: false,
        });
      setActiveDataOwner(STRESS_OWNER);
      await act(async () => {
        warmRenderer = TestRenderer.create(<Harness queryClient={warm} />);
      });
      await settle(2);
      await act(async () => {
        warmRenderer.unmount();
      });
      await settle(2, 500);
      warm.clear();
      (globalThis as { __stressCurrentDb?: unknown }).__stressCurrentDb =
        undefined;
      consoleErrors.length = 0;

      baseline = {
        timers: jest.getTimerCount(),
        rnListeners: activeRnListeners,
        zustandSubs: zustandSubscriptions(),
        statusBarStack: statusBarStackDepth(),
      };
      baselineListenerKinds = listenerKinds();
      const first = sampleHeap(0);
      baselineHandles = first.activeHandles;
      heapSamples.push(first);

      for (let i = 0; i < seeds.length; i += 1) {
        const seed = seeds[i]!;
        let row: IterationRow;
        try {
          row = await runIteration(i + 1, seed, baseline, consoleErrors);
        } catch (error) {
          row = {
            index: i + 1,
            seed,
            inputs: scenarioFromSeed(seed),
            observed: {
              interactions: [],
              finalRoute: currentRoute(),
              dbStatements: -1,
              serverRequests: -1,
              textNodesAtPeak: -1,
              zustandSubsAtPeak: -1,
              rnListenersAtPeak: -1,
              timersAfterUnmount: jest.getTimerCount(),
              rnListenersAfterUnmount: activeRnListeners,
              zustandSubsAfterUnmount: zustandSubscriptions(),
              statusBarStackAfterUnmount: statusBarStackDepth(),
              consoleErrors: [
                ...consoleErrors,
                `threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
              ],
              retainedOlder: -1,
              retainedPrevious: -1,
              mountToSettledMs: -1,
              totalMs: -1,
            },
            invariants: { mountedAndUnmountedWithoutThrow: false },
            ok: false,
            failed: ['mountedAndUnmountedWithoutThrow'],
          };
        }
        rows.push(row);
        durations.push(row.observed.mountToSettledMs);
        if ((i + 1) % SAMPLE_EVERY === 0 || i + 1 === seeds.length) {
          heapSamples.push(sampleHeap(i + 1));
        }
      }

      const slope = heapSlope(heapSamples, WARMUP);
      const drift = timingDrift(durations, WARMUP);
      const last = heapSamples[heapSamples.length - 1]!;
      const failedRows = rows.filter(row => !row.ok);
      const campaign = {
        unit: 'scr-libraryscreen',
        lens: 'long-run-leak',
        file: 'apps/mobile/src/screens/LibraryScreen.tsx',
        node: process.version,
        gcAvailable: gcAvailable(),
        campaignSeed: CAMPAIGN_SEED,
        replay: REPLAY,
        requestedIterations: seeds.length,
        executedIterations: rows.length,
        sampleEvery: SAMPLE_EVERY,
        warmupIterations: WARMUP,
        mockCallRecordsClearedPerIteration: !KEEP_MOCK_CALLS,
        baseline: {
          ...baseline,
          rnListenerKinds: baselineListenerKinds,
          activeHandles: baselineHandles,
        },
        final: {
          timers: jest.getTimerCount(),
          rnListeners: activeRnListeners,
          rnListenerKinds: listenerKinds(),
          zustandSubs: zustandSubscriptions(),
          statusBarStack: statusBarStackDepth(),
          activeHandles: last.activeHandles,
          activeResources: activeResources(),
        },
        heapSlope: slope,
        heapSlopeLimitPctPer100: HEAP_SLOPE_LIMIT_PCT_PER_100,
        heapSlopeEvaluated: gcAvailable() && slope !== null,
        timingDrift: drift,
        passed: rows.length - failedRows.length,
        failed: failedRows.length,
        failedSeeds: failedRows.map(row => ({
          seed: row.seed,
          index: row.index,
          failed: row.failed,
        })),
        byInvariant: Object.fromEntries(
          Array.from(
            new Set(rows.flatMap(row => Object.keys(row.invariants))),
          ).map(name => [
            name,
            {
              checked: rows.filter(row => name in row.invariants).length,
              failed: rows.filter(row => row.invariants[name] === false).length,
            },
          ]),
        ),
        startedAt,
        wallClockMs: Math.round(nowMs() - campaignStartMs),
      };
      const summaryPath = writeStressArtifact(
        'libraryScreen.longRunLeak.summary.json',
        campaign,
      );
      writeStressArtifact('libraryScreen.longRunLeak.rows.json', rows);
      writeStressArtifact('libraryScreen.longRunLeak.heap.json', heapSamples);
      writeStressArtifact(
        'libraryScreen.longRunLeak.seeds.json',
        rows.map(row => ({
          seed: row.seed,
          outcome: row.ok ? 'HELD' : `BROKEN:${row.failed.join('+')}`,
          interactions: row.observed.interactions,
          mountToSettledMs: row.observed.mountToSettledMs,
        })),
      );

      expect(rows.length).toBe(seeds.length);
      expect({
        failedSeeds: campaign.failedSeeds,
        artifact: summaryPath,
      }).toEqual({ failedSeeds: [], artifact: summaryPath });
      expect(last.activeHandles).toBeLessThanOrEqual(baselineHandles);
      if (campaign.heapSlopeEvaluated && slope) {
        expect(slope.slopePctPer100).toBeLessThanOrEqual(
          HEAP_SLOPE_LIMIT_PCT_PER_100,
        );
      }
      // The real screen and stores must actually have been exercised.
      expect(
        Math.max(...rows.map(r => r.observed.zustandSubsAtPeak)),
      ).toBeGreaterThan(0);
      expect(
        Math.max(...rows.map(r => r.observed.textNodesAtPeak)),
      ).toBeGreaterThan(5);
    },
    Math.max(60000, (seeds.length + 1) * ITERATION_BUDGET_MS),
  );
});
