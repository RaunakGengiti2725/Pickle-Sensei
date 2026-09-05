import React from 'react';
import { AppState, Dimensions, Linking, StatusBar, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  DefaultTheme,
  NavigationContainer,
  useNavigation,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * LONG-RUN LEAK stress campaign for `src/screens/SettingsScreen.tsx`.
 *
 * The screen is rendered the way the app renders it: inside a real
 * `NavigationContainer` → native-stack → bottom-tabs tree with the app's
 * `PremiumTabBar` and theme, under `SafeAreaProvider` + `QueryClientProvider`
 * (App.tsx), with the REAL zustand stores, `useNavigation`, and
 * `useFocusEffect`. Only native surfaces are replaced: SQLite (`src/data/db`
 * → op-sqlite), safe-area-context, linear-gradient, and `fetch`. Sibling
 * tab/stack screens are inert placeholders so the measurement isolates the
 * unit under test; every route Settings can navigate to is registered so
 * navigation resolves for real.
 *
 * Campaign (seeded, replayable):
 *   STRESS_ITER   iterations of the mount → interact → unmount cycle
 *                 (default 6 so the suite stays fast; the lens runs ≥500).
 *   STRESS_SEED   campaign seed (default 20260904). Iteration i uses seed
 *                 `iterationSeed(STRESS_SEED, i)`; `STRESS_REPLAY=<seed>[,…]`
 *                 replays exactly those iteration seeds.
 *   STRESS_OUT    directory that receives the JSON result tables.
 *
 * Run the lens at scale with the GC exposed:
 *   NODE_OPTIONS=--expose-gc STRESS_ITER=500 STRESS_OUT=/tmp/out \
 *     npx jest --ci --runInBand __tests__/stress/settingsScreenLongRunLeak
 *
 * Every 50 iterations the harness forces a GC, samples `process.memoryUsage`,
 * `process.getActiveResourcesInfo()`, the fake-timer queue, the live
 * zustand-subscription count per store, RN event-emitter subscriptions
 * (AppState / Linking / Dimensions) and the StatusBar prop stack. Mount /
 * interact / unmount wall time is recorded per iteration so drift between
 * the first and last 100 iterations can be reported.
 */

// ---------------------------------------------------------------------------
// Native-only substitutions.
// ---------------------------------------------------------------------------

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const { View: RNView } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const insets = { top: 47, bottom: 34, left: 0, right: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  const passthrough = (props: { children?: unknown }) =>
    R.createElement(RNView, { style: { flex: 1 } }, props.children as never);
  return {
    SafeAreaView: RNView,
    SafeAreaProvider: passthrough,
    SafeAreaInsetsContext: R.createContext(insets),
    SafeAreaFrameContext: R.createContext(frame),
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: { insets, frame },
  };
});

jest.mock('react-native-linear-gradient', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const { View: RNView } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockGradient = (props: { children?: unknown }) =>
    R.createElement(RNView, null, props.children as never);
  return { __esModule: true, default: MockGradient };
});

/**
 * Transparent instrumentation of zustand's `create`: identical to the
 * library's own `createImpl` (vanilla store + `useStore`), plus a live
 * subscription counter per store so listener leaks are observable. The
 * bound-store API and behaviour are unchanged.
 */
jest.mock('zustand', () => {
  const actual = jest.requireActual<typeof import('zustand')>('zustand');
  const vanilla =
    jest.requireActual<typeof import('zustand/vanilla')>('zustand/vanilla');
  const reactBinding =
    jest.requireActual<typeof import('zustand/react')>('zustand/react');
  const registry: Array<{
    api: unknown;
    entry: { live: number; ever: number };
  }> = [];
  (
    globalThis as { __zustandSubscriptionRegistry?: unknown }
  ).__zustandSubscriptionRegistry = registry;
  const createImpl = (createState: never) => {
    const api = vanilla.createStore(createState) as {
      subscribe: (listener: never) => () => void;
    };
    const entry = { live: 0, ever: 0 };
    const origSubscribe = api.subscribe;
    api.subscribe = (listener: never) => {
      entry.live += 1;
      entry.ever += 1;
      let done = false;
      const unsubscribe = origSubscribe(listener);
      return () => {
        if (!done) {
          done = true;
          entry.live -= 1;
        }
        unsubscribe();
      };
    };
    const useBoundStore = (selector?: never) =>
      reactBinding.useStore(api as never, selector as never);
    Object.assign(useBoundStore, api);
    registry.push({ api: useBoundStore, entry });
    return useBoundStore;
  };
  const create = (createState?: never) =>
    createState ? createImpl(createState) : createImpl;
  return { ...actual, create };
});

import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';
import { color } from '../../src/design/tokens';
import { useAppStore } from '../../src/state/appStore';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useConsentStore } from '../../src/state/consentStore';
import {
  establishApiSession,
  clearApiSession,
} from '../../src/account/apiSession';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';
import { useConsistencyStore } from '../../src/consistency/store';
import { buildConsistencySnapshot } from '../../src/consistency/engine';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../../src/billing/types';
import type {
  MainTabParams,
  RootStackParams,
} from '../../src/navigation/params';

// ---------------------------------------------------------------------------
// Campaign configuration.
// ---------------------------------------------------------------------------

const DEFAULT_ITERATIONS = 6;
const SAMPLE_EVERY = 50;
const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;
const TIME_DRIFT_LIMIT_RATIO = 1.5;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  }
  return parsed;
}

const ITERATIONS = envInt('STRESS_ITER', DEFAULT_ITERATIONS);
const CAMPAIGN_SEED = envInt('STRESS_SEED', 20260904);
const REPLAY_SEEDS = (process.env['STRESS_REPLAY'] ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(s => s.length > 0)
  .map(s => Number.parseInt(s, 10) >>> 0);
const OUT_DIR = process.env['STRESS_OUT'] ?? null;

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) + per-iteration seed derivation (splitmix-style).
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

export function iterationSeed(campaignSeed: number, index: number): number {
  let z = (campaignSeed + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
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
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ---------------------------------------------------------------------------
// Scenario model: everything an iteration does is derived from its seed.
// ---------------------------------------------------------------------------

type SessionKind = 'apple' | 'google' | 'guest' | 'none';
type AccessKind = 'premium' | 'free' | 'null';
type BackendMode = 'resolve' | 'reject' | 'late';
type ConsentMode = 'active' | 'inactive' | 'http500' | 'network' | 'late';
type Entry = 'initialSettings' | 'tabPress';
type Interaction =
  | 'signOutSheetCancel'
  | 'signOutSheetClose'
  | 'signOutSheetBackdrop'
  | 'tabAwayAndBack'
  | 'pushRouteAndBack'
  | 'storeChurn'
  | 'sessionSwap';

interface Scenario {
  seed: number;
  session: SessionKind;
  profile: 'full' | 'partial' | 'null';
  access: AccessKind;
  freeUsed: number;
  freeReserved: number;
  accessStatus: 'ready' | 'idle' | 'loading';
  backend: BackendMode;
  consent: ConsentMode;
  notificationsEnabled: boolean;
  permission: 'granted' | 'denied' | 'undetermined' | 'unknown';
  practiceReminder: boolean;
  practiceReminderMinutes: number;
  consistency: boolean;
  entry: Entry;
  interactions: Interaction[];
  pushRoute: keyof RootStackParams;
}

const PUSH_ROUTES: ReadonlyArray<keyof RootStackParams> = [
  'Paywall',
  'ConsentSettings',
  'NotificationSettings',
  'StreakCalendar',
  'ManageAccount',
  'ConnectAccount',
];

function scenarioFor(seed: number): Scenario {
  const rng = new Rng(seed);
  const interactionCount = rng.int(5);
  const interactions: Interaction[] = [];
  for (let i = 0; i < interactionCount; i += 1) {
    interactions.push(
      rng.pick<Interaction>([
        'signOutSheetCancel',
        'signOutSheetClose',
        'signOutSheetBackdrop',
        'tabAwayAndBack',
        'tabAwayAndBack',
        'pushRouteAndBack',
        'pushRouteAndBack',
        'storeChurn',
        'sessionSwap',
      ]),
    );
  }
  return {
    seed,
    session: rng.pick<SessionKind>([
      'apple',
      'google',
      'apple',
      'guest',
      'none',
    ]),
    profile: rng.pick(['full', 'full', 'partial', 'null'] as const),
    access: rng.pick<AccessKind>(['premium', 'free', 'free', 'null']),
    freeUsed: rng.int(3),
    freeReserved: rng.int(2),
    accessStatus: rng.pick(['ready', 'ready', 'idle', 'loading'] as const),
    backend: rng.pick<BackendMode>(['resolve', 'resolve', 'reject', 'late']),
    consent: rng.pick<ConsentMode>([
      'active',
      'inactive',
      'inactive',
      'http500',
      'network',
      'late',
    ]),
    notificationsEnabled: rng.chance(0.6),
    permission: rng.pick([
      'granted',
      'denied',
      'undetermined',
      'unknown',
    ] as const),
    practiceReminder: rng.chance(0.5),
    practiceReminderMinutes: rng.int(24 * 60),
    consistency: rng.chance(0.7),
    entry: rng.pick<Entry>(['initialSettings', 'tabPress']),
    interactions,
    pushRoute: rng.pick(PUSH_ROUTES),
  };
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const APPLE_ID = '11111111-1111-4111-8111-111111111111';
const GOOGLE_ID = '22222222-2222-4222-8222-222222222222';

function sessionFor(kind: SessionKind): AuthSession | null {
  switch (kind) {
    case 'apple':
      return {
        provider: 'apple',
        subject: APPLE_ID,
        canonicalAppUserId: APPLE_ID,
        localOnly: false,
        displayName: 'Alex Chen',
        email: 'alex@example.com',
      };
    case 'google':
      return {
        provider: 'google',
        subject: GOOGLE_ID,
        canonicalAppUserId: GOOGLE_ID,
        localOnly: false,
        displayName: null,
        email: 'sam@example.com',
      };
    case 'guest':
      return {
        provider: 'guest',
        subject: 'local-only',
        canonicalAppUserId: null,
        localOnly: true,
        displayName: null,
        email: null,
      };
    case 'none':
      return null;
  }
}

function accessFor(scenario: Scenario): CanonicalAccessState | null {
  if (scenario.access === 'null') return null;
  const premium = scenario.access === 'premium';
  const used = Math.min(scenario.freeUsed, 2);
  const reserved = Math.min(scenario.freeReserved, 2 - used);
  const remaining = 2 - used;
  const availableToReserve = remaining - reserved;
  const canStartRating = premium || availableToReserve > 0;
  return {
    premium,
    entitlements: premium ? ['premium'] : [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

const CONSISTENCY_SNAPSHOT = buildConsistencySnapshot(
  [
    {
      kind: 'stroke',
      atIso: '2026-03-09T10:00:00.000Z',
      shotType: 'dink',
      overallScore: 6.2,
      resultKind: 'scored',
    },
    {
      kind: 'stroke',
      atIso: '2026-03-10T09:00:00.000Z',
      shotType: 'serve',
      overallScore: 8.1,
      resultKind: 'scored',
    },
  ],
  { asOfIso: '2026-03-10T18:00:00.000Z', timeZone: 'UTC' },
);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function consentPayload(active: boolean): string {
  return JSON.stringify({
    subjectPseudonym: 'pseud-1',
    scopes: [
      {
        scope: 'model_training',
        active,
        consentVersion: active ? '2026-01' : null,
        lastAction: active ? 'granted' : null,
        lastActionAt: active ? '2026-02-01T00:00:00.000Z' : null,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Faithful replica of RootNavigator's tree with inert sibling screens.
// ---------------------------------------------------------------------------

const Stack = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<MainTabParams>();

function TabPlaceholder() {
  return <View />;
}

/** The navigation object of whichever stack route is on top, so the harness
 * can pop a pushed route the way that route's header back button would. */
const goBackRef: { current: (() => void) | null } = { current: null };

function StackPlaceholder() {
  const navigation = useNavigation();
  React.useEffect(() => {
    goBackRef.current = () => navigation.goBack();
    return () => {
      goBackRef.current = null;
    };
  }, [navigation]);
  return <View />;
}

const theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: color.surface,
    primary: color.court,
  },
};

function MainTabs({ initialTab }: { initialTab: keyof MainTabParams }) {
  return (
    <Tabs.Navigator
      initialRouteName={initialTab}
      tabBar={props => <PremiumTabBar {...props} />}
      screenOptions={{ headerShown: false, tabBarHideOnKeyboard: true }}
    >
      <Tabs.Screen name="Home" component={TabPlaceholder} />
      <Tabs.Screen name="Library" component={TabPlaceholder} />
      <Tabs.Screen name="Add" component={TabPlaceholder} />
      <Tabs.Screen name="Performance" component={TabPlaceholder} />
      <Tabs.Screen name="Settings" component={SettingsScreen} />
    </Tabs.Navigator>
  );
}

function Harness({ initialTab }: { initialTab: keyof MainTabParams }) {
  const [client] = React.useState(() => new QueryClient());
  const TabsRoute = React.useCallback(
    () => <MainTabs initialTab={initialTab} />,
    [initialTab],
  );
  return (
    <QueryClientProvider client={client}>
      <StatusBar barStyle="dark-content" />
      <NavigationContainer theme={theme}>
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            animation: 'fade_from_bottom',
            contentStyle: { backgroundColor: color.surface },
          }}
        >
          <Stack.Screen
            name="Tabs"
            component={TabsRoute}
            options={{ headerShown: false, animation: 'none' }}
          />
          <Stack.Screen name="Analyze" component={StackPlaceholder} />
          <Stack.Screen name="Result" component={StackPlaceholder} />
          <Stack.Screen name="ResultDetails" component={StackPlaceholder} />
          <Stack.Screen name="FormReview" component={StackPlaceholder} />
          <Stack.Screen name="DrillLibrary" component={StackPlaceholder} />
          <Stack.Screen name="StreakCalendar" component={StackPlaceholder} />
          <Stack.Screen
            name="Paywall"
            component={StackPlaceholder}
            options={{
              animation: 'slide_from_bottom',
              presentation: 'fullScreenModal',
            }}
          />
          <Stack.Screen name="ManageAccount" component={StackPlaceholder} />
          <Stack.Screen name="ConsentSettings" component={StackPlaceholder} />
          <Stack.Screen
            name="NotificationSettings"
            component={StackPlaceholder}
          />
          <Stack.Screen
            name="ConnectAccount"
            component={StackPlaceholder}
            options={{
              animation: 'slide_from_bottom',
              presentation: 'fullScreenModal',
            }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Instrumentation: subscriptions, timers, handles, heap.
// ---------------------------------------------------------------------------

type SubscriptionEntry = { live: number; ever: number };
const zustandRegistry = (
  globalThis as {
    __zustandSubscriptionRegistry?: Array<{
      api: unknown;
      entry: SubscriptionEntry;
    }>;
  }
).__zustandSubscriptionRegistry;

const STORES = {
  app: useAppStore,
  auth: useAuthStore,
  access: useAccessStore,
  consent: useConsentStore,
  notifications: useNotificationStore,
  consistency: useConsistencyStore,
  walkthrough: useWalkthroughStore,
} as const;

/** Stores SettingsScreen reads through hooks (walkthrough is read
 * imperatively via getState, so it never holds a subscription). */
const HOOKED_STORES: ReadonlyArray<keyof typeof STORES> = [
  'app',
  'auth',
  'access',
  'consent',
  'notifications',
  'consistency',
];

function storeSubscriptions(): Record<string, number> {
  const out: Record<string, number> = {};
  let others = 0;
  for (const row of zustandRegistry ?? []) {
    const named = (Object.keys(STORES) as Array<keyof typeof STORES>).find(
      key => STORES[key] === row.api,
    );
    if (named) out[named] = row.entry.live;
    else others += row.entry.live;
  }
  out['otherStores'] = others;
  return out;
}

type EmitterName = 'AppState' | 'Linking' | 'Dimensions';
const emitterLive: Record<EmitterName, number> = {
  AppState: 0,
  Linking: 0,
  Dimensions: 0,
};

function instrumentEmitter(
  name: EmitterName,
  target: { addEventListener: (...args: never[]) => unknown },
) {
  const original = target.addEventListener as (
    ...args: unknown[]
  ) => { remove: () => void } | undefined;
  target.addEventListener = ((...args: unknown[]) => {
    emitterLive[name] += 1;
    const sub = original.apply(target, args);
    let done = false;
    const remove = () => {
      if (!done) {
        done = true;
        emitterLive[name] -= 1;
      }
      sub?.remove();
    };
    return { ...(sub ?? {}), remove };
  }) as never;
}

instrumentEmitter('AppState', AppState);
instrumentEmitter('Linking', Linking);
instrumentEmitter('Dimensions', Dimensions);

function statusBarStackDepth(): number {
  const stack = (StatusBar as unknown as { _propsStack?: unknown[] })
    ._propsStack;
  return Array.isArray(stack) ? stack.length : -1;
}

function activeResources(): Record<string, number> {
  const info = process.getActiveResourcesInfo();
  const out: Record<string, number> = {};
  for (const kind of info) out[kind] = (out[kind] ?? 0) + 1;
  return out;
}

const gcFn: (() => void) | null =
  typeof (globalThis as { gc?: () => void }).gc === 'function'
    ? (globalThis as { gc: () => void }).gc
    : null;

interface Sample {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  rss: number;
  fakeTimers: number;
  activeResources: Record<string, number>;
  storeSubscriptions: Record<string, number>;
  emitters: Record<EmitterName, number>;
  statusBarStack: number;
}

function takeSample(iteration: number): Sample {
  if (gcFn) {
    gcFn();
    gcFn();
  }
  const mem = process.memoryUsage();
  return {
    iteration,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    rss: mem.rss,
    fakeTimers: jest.getTimerCount(),
    activeResources: activeResources(),
    storeSubscriptions: storeSubscriptions(),
    emitters: { ...emitterLive },
    statusBarStack: statusBarStackDepth(),
  };
}

// ---------------------------------------------------------------------------
// Rendering helpers.
// ---------------------------------------------------------------------------

type Renderer = TestRenderer.ReactTestRenderer;

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function pressables(renderer: Renderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
}

function press(renderer: Renderer, label: string): void {
  const matches = pressables(renderer, label);
  if (matches.length === 0) {
    throw new Error(`no pressable labelled "${label}"`);
  }
  act(() => {
    matches[0]!.props.onPress();
  });
}

/** SettingRow labels its pressable `${label}, ${value}`; match on the label. */
function rowPressables(renderer: Renderer, label: string) {
  const prefix = `${label}, `;
  return renderer.root.findAll(
    node =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith(prefix) &&
      typeof node.props.onPress === 'function',
  );
}

function tab(renderer: Renderer, label: string) {
  const matches = renderer.root.findAll(
    node =>
      node.props.accessibilityRole === 'tab' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  if (matches.length === 0) throw new Error(`no tab labelled "${label}"`);
  return matches[0]!;
}

function texts(renderer: Renderer): string[] {
  return renderer.root
    .findAll(node => {
      const type: unknown = node.type;
      return type === 'Text' || type === 'RCTText';
    })
    .map(node => {
      const children = node.props.children as unknown;
      return Array.isArray(children)
        ? children.map(c => String(c)).join('')
        : String(children ?? '');
    });
}

function rowValue(renderer: Renderer, label: string): string | null {
  const prefix = `${label}, `;
  const matches = renderer.root.findAll(
    node =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith(prefix) &&
      typeof node.props.onPress === 'function',
  );
  return matches.length > 0
    ? String(matches[0]!.props.accessibilityLabel).slice(prefix.length)
    : null;
}

// ---------------------------------------------------------------------------
// Console capture: any React/RN warning during an iteration is an anomaly.
// ---------------------------------------------------------------------------

const consoleLog: string[] = [];
let consoleSpies: jest.SpyInstance[] = [];

function startConsoleCapture() {
  consoleSpies = (['error', 'warn'] as const).map(level =>
    jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleLog.push(
        `${level}: ${args
          .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ')
          .slice(0, 400)}`,
      );
    }),
  );
}

function stopConsoleCapture() {
  for (const spy of consoleSpies) spy.mockRestore();
  consoleSpies = [];
}

// ---------------------------------------------------------------------------
// One iteration.
// ---------------------------------------------------------------------------

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

interface IterationResult {
  iteration: number;
  seed: number;
  outcome: 'ok' | 'fail';
  mountMs: number;
  interactMs: number;
  unmountMs: number;
  interactions: Interaction[];
  entry: Entry;
  session: SessionKind;
  access: AccessKind;
  accessStatus: Scenario['accessStatus'];
  backend: BackendMode;
  consent: ConsentMode;
  getAccessCalls: number;
  consentFetchCalls: number;
  consoleLines: string[];
  errors: string[];
}

interface PendingWork {
  access: Deferred<CanonicalAccessState>[];
  consent: Deferred<Response>[];
}

function applyScenarioStores(scenario: Scenario, pending: PendingWork) {
  const session = sessionFor(scenario.session);
  useAuthStore.setState({
    hydrated: true,
    session,
    busy: false,
    error: null,
  });
  if (session && !session.localOnly && session.canonicalAppUserId) {
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'bearer-test',
      canonicalAppUserId: session.canonicalAppUserId,
      provider: session.provider === 'google' ? 'google' : 'apple',
    });
  } else {
    clearApiSession();
  }

  useAppStore.setState({
    profile:
      scenario.profile === 'null'
        ? null
        : scenario.profile === 'full'
          ? {
              firstName: 'Alex',
              gender: 'nonbinary',
              skillLevel: 'intermediate',
              handedness: 'right',
              goal: 'dinks',
              biggestProblem: 'consistency',
              focusCheckpoint: 'contact_position',
            }
          : {
              skillLevel: 'beginner',
              handedness: 'left',
              goal: 'serve',
              biggestProblem: 'power',
              focusCheckpoint: 'sequencing',
            },
  });

  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });

  useNotificationStore.setState({
    prefs: {
      ...DEFAULT_NOTIFICATION_PREFS,
      enabled: scenario.notificationsEnabled,
      practiceReminder: scenario.practiceReminder,
      practiceReminderMinutes: scenario.practiceReminderMinutes,
    },
    permission: scenario.permission,
  });

  useConsistencyStore.setState({
    snapshot: scenario.consistency ? CONSISTENCY_SNAPSHOT : null,
  });
  useWalkthroughStore.setState({ visible: false });

  const access = accessFor(scenario);
  const clients: BillingAccessDependencies = {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => {
        throw new Error('plans are not part of this campaign');
      }),
      purchase: jest.fn(),
      restore: jest.fn(),
      readEntitlement: jest.fn(),
    },
    backend: {
      getAccess: jest.fn(async () => {
        const fresh = accessFor({
          ...scenario,
          freeUsed: scenario.freeUsed + 1,
        });
        switch (scenario.backend) {
          case 'resolve':
            return fresh ?? accessFor({ ...scenario, access: 'free' })!;
          case 'reject':
            throw new Error('backend unavailable (campaign)');
          case 'late': {
            const d = deferred<CanonicalAccessState>();
            pending.access.push(d);
            return d.promise;
          }
        }
      }),
      syncBilling: jest.fn(),
    },
  };
  clearAccessStoreConfiguration();
  configureAccessStore(clients);
  useAccessStore.setState({
    status: scenario.accessStatus,
    canonicalAccess: access,
    error: null,
  });

  const fetchMock = jest.fn(async (): Promise<Response> => {
    switch (scenario.consent) {
      case 'active':
        return new Response(consentPayload(true), { status: 200 });
      case 'inactive':
        return new Response(consentPayload(false), { status: 200 });
      case 'http500':
        return new Response('{"error":"boom"}', { status: 500 });
      case 'network':
        throw new TypeError('Network request failed');
      case 'late': {
        const d = deferred<Response>();
        pending.consent.push(d);
        return d.promise;
      }
    }
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { clients, fetchMock };
}

async function settlePending(pending: PendingWork, scenario: Scenario) {
  await act(async () => {
    for (const d of pending.access.splice(0)) {
      d.resolve(accessFor({ ...scenario, access: 'premium' })!);
    }
    for (const d of pending.consent.splice(0)) {
      d.resolve(new Response(consentPayload(true), { status: 200 }));
    }
    await Promise.resolve();
    await Promise.resolve();
  });
  await flush();
}

async function runInteraction(
  renderer: Renderer,
  scenario: Scenario,
  interaction: Interaction,
  errors: string[],
) {
  switch (interaction) {
    case 'signOutSheetCancel': {
      press(renderer, 'Sign out');
      await flush();
      const keep = renderer.root
        .findAll(node => node.props.label === 'Keep me signed in')
        .find(node => typeof node.props.onPress === 'function');
      if (!keep) throw new Error('sign-out sheet did not open');
      act(() => keep.props.onPress());
      await flush();
      break;
    }
    case 'signOutSheetClose': {
      press(renderer, 'Sign out');
      await flush();
      press(renderer, 'Close sign out confirmation');
      await flush();
      break;
    }
    case 'signOutSheetBackdrop': {
      press(renderer, 'Sign out');
      await flush();
      press(renderer, 'Cancel sign out');
      await flush();
      break;
    }
    case 'tabAwayAndBack': {
      const home = tab(renderer, 'Home');
      act(() => home.props.onPress());
      await flush();
      const settings = tab(renderer, 'Settings');
      act(() => settings.props.onPress());
      await flush();
      break;
    }
    case 'pushRouteAndBack': {
      const label = pushLabelFor(scenario);
      const matches = rowPressables(renderer, label);
      if (matches.length === 0) {
        errors.push(`missing row for ${label}`);
        break;
      }
      act(() => matches[0]!.props.onPress());
      await flush();
      if (goBackRef.current === null) {
        errors.push(`pressing ${label} did not push a stack route`);
        break;
      }
      act(() => {
        goBackRef.current?.();
      });
      await flush();
      if (goBackRef.current !== null) {
        errors.push(`stack route pushed by ${label} did not pop`);
      }
      break;
    }
    case 'storeChurn': {
      act(() => {
        useNotificationStore.setState(state => ({
          prefs: { ...state.prefs, enabled: !state.prefs.enabled },
        }));
        useConsentStore.setState(state => ({
          availability: 'ready',
          modelTrainingActive: !state.modelTrainingActive,
        }));
        useConsistencyStore.setState(state => ({
          snapshot: state.snapshot ? null : CONSISTENCY_SNAPSHOT,
        }));
      });
      await flush();
      act(() => {
        useAccessStore.setState({
          status: 'ready',
          canonicalAccess: accessFor({ ...scenario, access: 'premium' }),
        });
      });
      await flush();
      break;
    }
    case 'sessionSwap': {
      const next: SessionKind =
        scenario.session === 'guest' || scenario.session === 'none'
          ? 'apple'
          : 'guest';
      act(() => {
        useAuthStore.setState({ session: sessionFor(next) });
      });
      await flush();
      act(() => {
        useAuthStore.setState({ session: sessionFor(scenario.session) });
      });
      await flush();
      break;
    }
  }
}

function pushLabelFor(scenario: Scenario): string {
  const synced = scenario.session === 'apple' || scenario.session === 'google';
  switch (scenario.pushRoute) {
    case 'Paywall':
    case 'ConnectAccount':
      return scenario.session === 'guest'
        ? 'Connect account'
        : 'Pickle Sensei Pro';
    case 'ConsentSettings':
      return 'Data & consent';
    case 'NotificationSettings':
      return 'Notifications';
    case 'StreakCalendar':
      return 'Consistency';
    case 'ManageAccount':
      return synced ? 'Manage account' : 'Consistency';
    default:
      return 'Consistency';
  }
}

function expectedMembershipValue(scenario: Scenario): string | null {
  if (scenario.session === 'guest') return 'Sign in first';
  const access = useAccessStore.getState().canonicalAccess;
  if (!access) return 'Verify access';
  if (access.premium) return 'Pro active';
  if (!access.canStartRating) return 'Upgrade required';
  const n = access.freeRatings.availableToReserve;
  return `${n} free rating${n === 1 ? '' : 's'} left`;
}

async function runIteration(
  iteration: number,
  seed: number,
  onMounted?: (renderer: Renderer) => void,
): Promise<IterationResult> {
  const scenario = scenarioFor(seed);
  const pending: PendingWork = { access: [], consent: [] };
  const errors: string[] = [];
  const consoleStart = consoleLog.length;
  const { clients, fetchMock } = applyScenarioStores(scenario, pending);

  let renderer: Renderer | null = null;
  const t0 = nowMs();
  let t1 = t0;
  let t2 = t0;
  let t3 = t0;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <Harness
          initialTab={
            scenario.entry === 'initialSettings' ? 'Settings' : 'Home'
          }
        />,
      );
    });
    await flush();
    if (scenario.entry === 'tabPress') {
      const settings = tab(renderer!, 'Settings');
      act(() => settings.props.onPress());
      await flush();
    }
    t1 = nowMs();
    onMounted?.(renderer!);

    // Invariants that must hold on every render.
    const shown = texts(renderer!);
    if (!shown.includes('Settings')) errors.push('hero title missing');
    const membership = rowValue(renderer!, 'Pickle Sensei Pro');
    if (membership === null) errors.push('membership row missing');
    else if (scenario.backend !== 'late' || scenario.session === 'guest') {
      const expected = expectedMembershipValue(scenario);
      if (membership !== expected) {
        errors.push(`membership "${membership}" expected "${expected}"`);
      }
    }
    const synced =
      scenario.session === 'apple' || scenario.session === 'google';
    const manage = rowValue(renderer!, 'Manage account');
    if (synced && manage === null) errors.push('Manage account row missing');
    if (!synced && manage !== null) errors.push('Manage account row leaked');
    if (statusBarStackDepth() < 1) errors.push('StatusBar entry not pushed');

    for (const interaction of scenario.interactions) {
      await runInteraction(renderer!, scenario, interaction, errors);
    }
    t2 = nowMs();
  } catch (error) {
    errors.push(
      `threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    if (renderer) {
      const r: Renderer = renderer;
      act(() => {
        r.unmount();
      });
    }
    renderer = null;
    t3 = nowMs();
    await settlePending(pending, scenario);
    await flush();
  } catch (error) {
    errors.push(
      `unmount threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  clearAccessStoreConfiguration();
  clearApiSession();

  const lines = consoleLog.slice(consoleStart);
  if (lines.length > 0) errors.push(`console: ${lines.length} line(s)`);
  const getAccessCalls = (clients.backend.getAccess as jest.Mock).mock.calls
    .length;
  const consentFetchCalls = fetchMock.mock.calls.length;
  // The RN jest preset's native-module mocks are `jest.fn()`s that record
  // every call (with its arguments) for the life of the process; left alone
  // that recording alone grows the heap ~0.4 MB per render of ANY component
  // and would swamp the measurement. Dropping the recorded calls keeps the
  // sample about the unit under test; implementations are untouched.
  jest.clearAllMocks();

  return {
    iteration,
    seed,
    outcome: errors.length === 0 ? 'ok' : 'fail',
    mountMs: t1 - t0,
    interactMs: t2 - t1,
    unmountMs: t3 - t2,
    interactions: scenario.interactions,
    entry: scenario.entry,
    session: scenario.session,
    access: scenario.access,
    accessStatus: scenario.accessStatus,
    backend: scenario.backend,
    consent: scenario.consent,
    getAccessCalls,
    consentFetchCalls,
    consoleLines: lines,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Analysis.
// ---------------------------------------------------------------------------

function linearSlope(points: Array<{ x: number; y: number }>): number {
  if (points.length < 2) return 0;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

interface HeapVerdict {
  samples: number;
  firstHeapUsed: number;
  lastHeapUsed: number;
  slopeBytesPerIteration: number;
  slopePctPer100: number;
  postWarmupSlopePctPer100: number;
  monotoneIncreases: number;
  limitPctPer100: number;
  exceeds: boolean;
}

function heapVerdict(samples: Sample[]): HeapVerdict {
  const pts = samples.map(s => ({ x: s.iteration, y: s.heapUsed }));
  const slope = linearSlope(pts);
  const base = samples[0]?.heapUsed ?? 1;
  const post = pts.slice(1);
  const postSlope = linearSlope(post);
  const postBase = post[0]?.y ?? base;
  let monotone = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i]!.heapUsed > samples[i - 1]!.heapUsed) monotone += 1;
  }
  const postPct = (postSlope * 100 * 100) / postBase;
  return {
    samples: samples.length,
    firstHeapUsed: base,
    lastHeapUsed: samples[samples.length - 1]?.heapUsed ?? base,
    slopeBytesPerIteration: slope,
    slopePctPer100: (slope * 100 * 100) / base,
    postWarmupSlopePctPer100: postPct,
    monotoneIncreases: monotone,
    limitPctPer100: HEAP_SLOPE_LIMIT_PCT_PER_100,
    exceeds: post.length >= 3 && postPct > HEAP_SLOPE_LIMIT_PCT_PER_100,
  };
}

interface DriftVerdict {
  window: number;
  firstWindowMedianMs: number;
  lastWindowMedianMs: number;
  ratio: number;
  limitRatio: number;
  exceeds: boolean;
}

function driftVerdict(results: IterationResult[]): DriftVerdict {
  const total = results.map(r => r.mountMs + r.interactMs + r.unmountMs);
  const window = Math.max(1, Math.min(100, Math.floor(total.length / 2)));
  const first = median(total.slice(0, window));
  const last = median(total.slice(-window));
  const ratio = first === 0 ? 1 : last / first;
  return {
    window,
    firstWindowMedianMs: first,
    lastWindowMedianMs: last,
    ratio,
    limitRatio: TIME_DRIFT_LIMIT_RATIO,
    exceeds: total.length >= 100 && ratio > TIME_DRIFT_LIMIT_RATIO,
  };
}

function writeArtifact(name: string, payload: unknown) {
  if (!OUT_DIR) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, name),
    JSON.stringify(payload, null, 2),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// The campaign.
// ---------------------------------------------------------------------------

describe('SettingsScreen long-run leak campaign (real navigator + stores)', () => {
  beforeAll(() => {
    jest.useFakeTimers({
      doNotFake: ['performance', 'hrtime', 'nextTick', 'queueMicrotask'],
    });
    startConsoleCapture();
  });

  afterAll(() => {
    stopConsoleCapture();
    jest.useRealTimers();
  });

  const seeds =
    REPLAY_SEEDS.length > 0
      ? REPLAY_SEEDS
      : Array.from({ length: ITERATIONS }, (_, i) =>
          iterationSeed(CAMPAIGN_SEED, i),
        );
  // ~100 ms per iteration observed; budget 1 s each plus slack so a long
  // campaign is bounded by the work, not Jest's 5 s default.
  const TEST_TIMEOUT_MS = 30_000 + seeds.length * 1_000;

  test(
    `mount → interact → unmount ×${seeds.length}: heap, handles, timers and subscriptions return to baseline`,
    async () => {
      // Warm the module graph and JIT once so the baseline sample is not the
      // very first render of the process, and prove the instrumentation sees
      // the mounted screen (subscriptions, StatusBar entries) before trusting
      // its zeros after unmount.
      let mountedProbe: Sample | null = null;
      await runIteration(
        -1,
        iterationSeed(CAMPAIGN_SEED ^ 0x5bd1e995, 0),
        () => {
          mountedProbe = takeSample(-1);
        },
      );
      await flush();
      const probe = mountedProbe as Sample | null;
      if (!probe) throw new Error('warm-up iteration never mounted');
      for (const key of HOOKED_STORES) {
        if ((probe.storeSubscriptions[key] ?? 0) < 1) {
          throw new Error(`instrumentation blind: no live ${key} subscription`);
        }
      }
      if (probe.statusBarStack < 2) {
        throw new Error('instrumentation blind: StatusBar stack not observed');
      }

      const baseline = takeSample(0);
      const samples: Sample[] = [baseline];
      const results: IterationResult[] = [];

      for (let i = 0; i < seeds.length; i += 1) {
        const result = await runIteration(i, seeds[i]!);
        results.push(result);
        if ((i + 1) % SAMPLE_EVERY === 0) samples.push(takeSample(i + 1));
      }
      if (samples[samples.length - 1]!.iteration !== seeds.length) {
        samples.push(takeSample(seeds.length));
      }
      const final = samples[samples.length - 1]!;

      const heap = heapVerdict(samples);
      const drift = driftVerdict(results);
      const failed = results.filter(r => r.outcome === 'fail');

      const baselineDiffs: string[] = [];
      if (final.fakeTimers !== baseline.fakeTimers) {
        baselineDiffs.push(
          `fake timers ${baseline.fakeTimers} → ${final.fakeTimers}`,
        );
      }
      for (const key of Object.keys(final.storeSubscriptions)) {
        const before = baseline.storeSubscriptions[key] ?? 0;
        const after = final.storeSubscriptions[key] ?? 0;
        if (before !== after) {
          baselineDiffs.push(`store ${key} subscriptions ${before} → ${after}`);
        }
      }
      for (const key of Object.keys(final.emitters) as EmitterName[]) {
        if (final.emitters[key] !== baseline.emitters[key]) {
          baselineDiffs.push(
            `${key} listeners ${baseline.emitters[key]} → ${final.emitters[key]}`,
          );
        }
      }
      if (final.statusBarStack !== baseline.statusBarStack) {
        baselineDiffs.push(
          `StatusBar stack ${baseline.statusBarStack} → ${final.statusBarStack}`,
        );
      }
      const resourceKinds = new Set([
        ...Object.keys(baseline.activeResources),
        ...Object.keys(final.activeResources),
      ]);
      for (const kind of resourceKinds) {
        const before = baseline.activeResources[kind] ?? 0;
        const after = final.activeResources[kind] ?? 0;
        if (after > before) {
          baselineDiffs.push(`active ${kind} handles ${before} → ${after}`);
        }
      }

      const report = {
        unit: 'scr-settingsscreen',
        lens: 'long-run-leak',
        campaignSeed: CAMPAIGN_SEED,
        replaySeeds: REPLAY_SEEDS,
        iterationsRequested: seeds.length,
        iterationsExecuted: results.length,
        gcExposed: gcFn !== null,
        node: process.version,
        sampleEvery: SAMPLE_EVERY,
        mountedProbe: probe,
        baseline,
        final,
        baselineDiffs,
        heap,
        drift,
        timing: {
          mountMedianMs: median(results.map(r => r.mountMs)),
          interactMedianMs: median(results.map(r => r.interactMs)),
          unmountMedianMs: median(results.map(r => r.unmountMs)),
          totalMs: results.reduce(
            (s, r) => s + r.mountMs + r.interactMs + r.unmountMs,
            0,
          ),
        },
        failedSeeds: failed.map(r => ({ seed: r.seed, errors: r.errors })),
        interactionsExecuted: results.reduce(
          (s, r) => s + r.interactions.length,
          0,
        ),
      };
      writeArtifact('settings-long-run-leak-report.json', report);
      writeArtifact('settings-long-run-leak-samples.json', samples);
      writeArtifact(
        'settings-long-run-leak-seeds.json',
        results.map(r => ({
          iteration: r.iteration,
          seed: r.seed,
          outcome: r.outcome,
          entry: r.entry,
          session: r.session,
          access: r.access,
          accessStatus: r.accessStatus,
          backend: r.backend,
          consent: r.consent,
          interactions: r.interactions,
          getAccessCalls: r.getAccessCalls,
          consentFetchCalls: r.consentFetchCalls,
          mountMs: Number(r.mountMs.toFixed(3)),
          interactMs: Number(r.interactMs.toFixed(3)),
          unmountMs: Number(r.unmountMs.toFixed(3)),
          errors: r.errors,
          consoleLines: r.consoleLines,
        })),
      );

      expect(results.length).toBe(seeds.length);
      expect(failed.map(r => ({ seed: r.seed, errors: r.errors }))).toEqual([]);
      expect(baselineDiffs).toEqual([]);
      expect(heap.exceeds).toBe(false);
      expect(drift.exceeds).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
