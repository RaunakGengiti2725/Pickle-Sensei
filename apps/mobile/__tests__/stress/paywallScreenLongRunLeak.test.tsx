/**
 * LONG-RUN LEAK stress for PaywallScreen (unit `scr-paywallscreen`).
 *
 * The screen is mounted THROUGH the real app navigator: the real
 * `RootNavigator` (NavigationContainer + native stack + bottom tabs), the
 * real `PaywallRoute` wrapper, the real `accessStore` and the real billing
 * clients (`createBillingAccessDependencies`) driven by a fake RevenueCat SDK
 * and a fake `fetch`. Only native modules (SQLite, gradients, SVG, safe-area,
 * the RevenueCat SDK) and the network are replaced; the sibling screens that
 * RootNavigator registers are stubbed so their own native imports stay out of
 * this suite. `HomeScreen` is stubbed with a launcher that calls the REAL
 * `useNavigation().navigate('Paywall')`.
 *
 * Every iteration is a seeded scenario (mulberry32 over `STRESS_SEED` +
 * iteration): store world (free / premium / backend or store failure /
 * unconfigured), whether the store is cold (status idle → `initialize()` runs
 * inside the screen) or warm, a random interaction script over the real
 * pressables (see plans, back, hardware back, plan selection, continue,
 * restore, retry, legal links, dismiss error, mid-animation ticks) and an exit
 * mode (close button, verified purchase → onPurchased → goBack, or a full
 * root unmount). After every exit the harness asserts the lifecycle returned
 * to baseline: no PaywallScreen instance, no `paywall-*` node, zero live
 * BackHandler subscriptions, accessStore subscriber count, jest timer count
 * and renderer node count all equal to the post-mount baseline.
 *
 * Heap (after `global.gc()`) and Node active-resource counts are sampled
 * every `STRESS_HEAP_EVERY` iterations; mount and iteration wall-clock are
 * recorded per iteration. The campaign-level checks (heap slope > 5% per 100
 * iterations, mount-time drift) run only when `STRESS_ITER >= 300`, i.e. the
 * long-run campaign:
 *
 *   cd apps/mobile && STRESS_ITER=600 STRESS_OUT=/tmp/paywall-leak \
 *     NODE_OPTIONS=--expose-gc npx jest --ci --silent \
 *     __tests__/stress/paywallScreenLongRunLeak.test.tsx
 *
 * Replay one iteration: STRESS_SEED=<seed> STRESS_ITER=1 (the seed of
 * iteration i in a campaign is `campaignSeed + i`, both are in the JSON table
 * written under STRESS_OUT).
 */
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
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
  };
});
// authStore (imported by RootNavigator) pulls the SQLite module at load time;
// nothing on the paywall path opens the database.
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    throw new Error('native SQLite must not be opened by the paywall stress');
  },
}));
// Sibling routes are out of scope; their own native imports stay out.
jest.mock('../../src/screens/LibraryScreen', () => ({
  LibraryScreen: () => null,
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: () => null,
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: () => null,
}));
jest.mock('../../src/screens/AnalyzeScreen', () => ({
  AnalyzeScreen: () => null,
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: () => null,
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  ResultScreen: () => null,
}));
jest.mock('../../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: () => null,
}));
jest.mock('../../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: () => null,
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: () => null,
}));
jest.mock('../../src/screens/SignInScreen', () => ({
  SignInScreen: () => null,
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: () => null,
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: () => null,
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: () => null,
}));
// The Home tab becomes a launcher that navigates through the REAL navigator.
jest.mock('../../src/screens/HomeScreen', () => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  const { useNavigation } = require('@react-navigation/native');
  return {
    HomeScreen: () => {
      const navigation = useNavigation();
      return React.createElement(
        Pressable,
        {
          testID: 'stress-open-paywall',
          onPress: () => navigation.navigate('Paywall', { source: 'rating' }),
        },
        React.createElement(Text, null, 'Open paywall'),
      );
    },
  };
});

import fs from 'fs';
import path from 'path';
import React from 'react';
import { BackHandler, Linking, NativeModules } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import {
  createBillingAccessDependencies,
  type BillingFetch,
  type RevenueCatCustomerInfoLike,
  type RevenueCatPackageLike,
  type RevenueCatSdk,
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { PaywallScreen } from '../../src/screens/PaywallScreen';

// ───────────────────────────── configuration ─────────────────────────────

const ITERATIONS = Math.max(1, Number(process.env.STRESS_ITER ?? 60));
const CAMPAIGN_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const HEAP_EVERY = Math.max(
  1,
  Number(process.env.STRESS_HEAP_EVERY ?? Math.min(50, ITERATIONS)),
);
const OUT_DIR = process.env.STRESS_OUT ?? null;
/** Slope / drift assertions are only meaningful over a long campaign. */
const CAMPAIGN_MODE = ITERATIONS >= 300;
const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;
const MOUNT_DRIFT_LIMIT_RATIO = 3;
/** Iterations excluded from slope/drift statistics (module + JIT warm-up). */
const WARMUP_ITERATIONS = Math.min(100, Math.floor(ITERATIONS / 5));

// ───────────────────────────── seeded RNG ────────────────────────────────

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

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

// ───────────────────────────── fake world ────────────────────────────────

type AccessWorld =
  | 'free-2'
  | 'free-1'
  | 'free-0'
  | 'premium'
  | 'backend-503'
  | 'backend-invalid'
  | 'backend-401'
  | 'network-down';
type OfferingsWorld = 'full' | 'annual-only' | 'no-offering' | 'sdk-throws';
type SyncWorld = 'verified' | 'not-premium' | 'sync-503';
type PurchaseWorld = 'success' | 'cancelled' | 'failed';

interface World {
  access: AccessWorld;
  offerings: OfferingsWorld;
  sync: SyncWorld;
  purchase: PurchaseWorld;
  configured: boolean;
}

const ACCESS_WORLDS: readonly AccessWorld[] = [
  'free-2',
  'free-2',
  'free-1',
  'free-0',
  'premium',
  'backend-503',
  'backend-invalid',
  'backend-401',
  'network-down',
];
const OFFERINGS_WORLDS: readonly OfferingsWorld[] = [
  'full',
  'full',
  'full',
  'annual-only',
  'no-offering',
  'sdk-throws',
];
const SYNC_WORLDS: readonly SyncWorld[] = [
  'verified',
  'verified',
  'not-premium',
  'sync-503',
];
const PURCHASE_WORLDS: readonly PurchaseWorld[] = [
  'success',
  'success',
  'cancelled',
  'failed',
];

const CANONICAL_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const API_BASE = 'https://stress.invalid/functions/v1/api';

function accessBody(world: AccessWorld): Record<string, unknown> {
  if (world === 'premium') {
    return {
      premium: true,
      entitlements: ['premium'],
      freeRatings: {
        limit: 2,
        used: 2,
        reserved: 0,
        remaining: 0,
        availableToReserve: 0,
      },
      canStartRating: true,
      paywallRequired: false,
    };
  }
  const remaining = world === 'free-2' ? 2 : world === 'free-1' ? 1 : 0;
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
      used: 2 - remaining,
      reserved: 0,
      remaining,
      availableToReserve: remaining,
    },
    canStartRating: remaining > 0,
    paywallRequired: remaining === 0,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function rcPackage(
  type: 'ANNUAL' | 'MONTHLY' | 'LIFETIME',
  price: number,
  priceString: string,
): RevenueCatPackageLike {
  return {
    identifier: `$rc_${type.toLowerCase()}`,
    packageType: type,
    product: {
      identifier: `pickle_sensei_pro_${type.toLowerCase()}`,
      price,
      priceString,
      pricePerMonthString:
        type === 'ANNUAL' ? '$5.00' : type === 'MONTHLY' ? priceString : null,
      introPrice: null,
      defaultOption: null,
    },
  };
}

const PREMIUM_INFO: RevenueCatCustomerInfoLike = {
  entitlements: {
    active: {
      pickle_sensei_pro: {
        productIdentifier: 'pickle_sensei_pro_annual',
        expirationDate: null,
      },
    },
  },
};
const FREE_INFO: RevenueCatCustomerInfoLike = { entitlements: { active: {} } };

interface FakeNetwork {
  fetchCalls: number;
  sdkCalls: number;
  world: World;
}

function buildDependencies(net: FakeNetwork) {
  const fetchFn: BillingFetch = async (input, init) => {
    net.fetchCalls += 1;
    const w = net.world;
    if (input.endsWith('/v1/me/access') && (init?.method ?? 'GET') === 'GET') {
      switch (w.access) {
        case 'backend-503':
          return jsonResponse(503, { error: 'unavailable' });
        case 'backend-invalid':
          return jsonResponse(200, { premium: 'yes' });
        case 'backend-401':
          return jsonResponse(401, { error: 'unauthorized' });
        case 'network-down':
          throw new TypeError('Network request failed');
        default:
          return jsonResponse(200, accessBody(w.access));
      }
    }
    if (input.endsWith('/v1/billing/sync') && init?.method === 'POST') {
      switch (w.sync) {
        case 'sync-503':
          return jsonResponse(503, { error: 'unavailable' });
        case 'not-premium':
          return jsonResponse(200, {
            billing: {
              premium: false,
              productKey: null,
              expiresAt: null,
              verifiedAt: '2026-09-04T00:00:00.000Z',
            },
            access: accessBody('free-0'),
          });
        default:
          return jsonResponse(200, {
            billing: {
              premium: true,
              productKey: 'pickle_sensei_pro_annual',
              expiresAt: null,
              verifiedAt: '2026-09-04T00:00:00.000Z',
            },
            access: accessBody('premium'),
          });
      }
    }
    throw new Error(`unexpected request ${init?.method ?? 'GET'} ${input}`);
  };

  let configured = false;
  const sdk: RevenueCatSdk = {
    isConfigured: async () => {
      net.sdkCalls += 1;
      return configured;
    },
    configure: () => {
      net.sdkCalls += 1;
      configured = true;
    },
    getAppUserID: async () => {
      net.sdkCalls += 1;
      return CANONICAL_ID;
    },
    logIn: async () => {
      net.sdkCalls += 1;
      return undefined;
    },
    getOfferings: async () => {
      net.sdkCalls += 1;
      switch (net.world.offerings) {
        case 'sdk-throws':
          throw new Error('RevenueCat offerings unavailable');
        case 'no-offering':
          return { current: null };
        case 'annual-only':
          return {
            current: {
              identifier: 'default',
              annual: rcPackage('ANNUAL', 59.99, '$59.99'),
              monthly: null,
              lifetime: null,
            },
          };
        default:
          return {
            current: {
              identifier: 'default',
              annual: rcPackage('ANNUAL', 59.99, '$59.99'),
              monthly: rcPackage('MONTHLY', 7.99, '$7.99'),
              lifetime: rcPackage('LIFETIME', 159.99, '$159.99'),
            },
          };
      }
    },
    purchasePackage: async () => {
      net.sdkCalls += 1;
      switch (net.world.purchase) {
        case 'cancelled':
          throw { userCancelled: true, code: '1' };
        case 'failed':
          throw new Error('StoreKit failure');
        default:
          return { customerInfo: PREMIUM_INFO };
      }
    },
    restorePurchases: async () => {
      net.sdkCalls += 1;
      if (net.world.purchase === 'failed') throw new Error('restore failed');
      return net.world.sync === 'verified' ? PREMIUM_INFO : FREE_INFO;
    },
    getCustomerInfo: async () => {
      net.sdkCalls += 1;
      return FREE_INFO;
    },
    checkTrialOrIntroductoryPriceEligibility: async () => {
      net.sdkCalls += 1;
      return {};
    },
  };

  return createBillingAccessDependencies({
    revenueCatPublicSdkKey: 'appl_stress_public_key',
    canonicalAppUserId: CANONICAL_ID,
    apiBaseUrl: API_BASE,
    apiToken: 'stress-bearer-token',
    fetchFn,
    revenueCatSdk: sdk,
    platform: 'ios',
  });
}

// ─────────────────────────── instrumentation ────────────────────────────

/** Live BackHandler subscriptions (iOS BackHandler is a no-op; we count). */
type BackHandlerFn = Parameters<typeof BackHandler.addEventListener>[1];
const backHandlers = new Set<BackHandlerFn>();

/**
 * Live accessStore subscriptions. zustand's bound hook calls
 * `React.useSyncExternalStore(api.subscribe, …)` and copies `api.subscribe`
 * onto the hook, so the store's subscribe is recognised by identity and
 * wrapped once (stable identity, otherwise React would resubscribe per render).
 */
let accessSubscriptions = 0;

const consoleIssues: string[] = [];

/** Real (non-faked) timer primitives captured before fake timers install. */
const realSetTimeout = globalThis.setTimeout;

/**
 * Instrumentation deliberately avoids `jest.spyOn`/`jest.fn`: a jest mock
 * records every call's arguments in `mock.calls`, and the arguments here are
 * closures over component scope (snapshot getters, back handlers) — recording
 * them would retain every mounted PaywallScreen for the whole campaign and
 * masquerade as an application leak. Plain function replacement instead;
 * `restore()` puts the originals back.
 */
function installInstrumentation(): () => void {
  const wrapped = new WeakMap<object, (l: () => void) => () => void>();
  const realUseSyncExternalStore = React.useSyncExternalStore;
  const countingUseSyncExternalStore: typeof React.useSyncExternalStore = (
    subscribe,
    getSnapshot,
    getServerSnapshot,
  ) => {
    let effective = subscribe;
    if (subscribe === useAccessStore.subscribe) {
      let counted = wrapped.get(subscribe);
      if (!counted) {
        counted = listener => {
          accessSubscriptions += 1;
          const unsubscribe = subscribe(listener);
          let live = true;
          return () => {
            if (live) {
              live = false;
              accessSubscriptions -= 1;
            }
            unsubscribe();
          };
        };
        wrapped.set(subscribe, counted);
      }
      effective = counted;
    }
    return realUseSyncExternalStore(effective, getSnapshot, getServerSnapshot);
  };
  React.useSyncExternalStore = countingUseSyncExternalStore;

  const realAddEventListener = BackHandler.addEventListener;
  BackHandler.addEventListener = (_eventName, handler) => {
    backHandlers.add(handler);
    return {
      remove: () => {
        backHandlers.delete(handler);
      },
    };
  };

  const realConsole = { error: console.error, warn: console.warn };
  for (const level of ['error', 'warn'] as const) {
    console[level] = (...args: unknown[]) => {
      consoleIssues.push(
        `${level}: ${args
          .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ')
          .slice(0, 300)}`,
      );
    };
  }
  // Any network call that bypasses the injected fetch is a harness bug.
  const realFetch = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch?: unknown }).fetch = () => {
    throw new Error('global fetch is disabled in the paywall stress');
  };
  // The preset's Linking mock is a jest.fn; give it a resolved implementation.
  (Linking.openURL as jest.Mock).mockImplementation(async () => undefined);

  return () => {
    React.useSyncExternalStore = realUseSyncExternalStore;
    BackHandler.addEventListener = realAddEventListener;
    console.error = realConsole.error;
    console.warn = realConsole.warn;
    (globalThis as { fetch?: unknown }).fetch = realFetch;
  };
}

/**
 * The RN jest preset implements `NativeAnimatedModule` with `jest.fn`s. Their
 * call logs grow without bound (and retain end callbacks), so the harness
 * reads the counts it cares about and clears the logs after every iteration.
 * Created − dropped is the number of native animated nodes still alive: every
 * `useNativeDriver: true` node PaywallScreen attaches must be dropped when the
 * route unmounts.
 */
const nativeAnimated = NativeModules.NativeAnimatedModule as Record<
  'createAnimatedNode' | 'dropAnimatedNode' | 'startAnimatingNode',
  jest.Mock
>;
const animatedTotals = { created: 0, dropped: 0, started: 0 };

function harvestAnimatedMockCalls() {
  animatedTotals.created += nativeAnimated.createAnimatedNode.mock.calls.length;
  animatedTotals.dropped += nativeAnimated.dropAnimatedNode.mock.calls.length;
  animatedTotals.started += nativeAnimated.startAnimatingNode.mock.calls.length;
  jest.clearAllMocks();
}

function liveAnimatedNodes(): number {
  harvestAnimatedMockCalls();
  return animatedTotals.created - animatedTotals.dropped;
}

type ResourceCounts = Record<string, number>;

function activeResources(): ResourceCounts {
  const p = process as unknown as { getActiveResourcesInfo?: () => string[] };
  const counts: ResourceCounts = {};
  for (const kind of p.getActiveResourcesInfo?.() ?? []) {
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

function sleepReal(ms: number): Promise<void> {
  return new Promise(resolve => {
    realSetTimeout(resolve, ms);
  });
}

const REAL_SETTLE_LIMIT_MS = 1500;

/**
 * Real Node handles (`Timeout`/`Immediate`) are not under fake timers: React's
 * reconciler and scheduler capture `setTimeout` at module init (Suspense
 * throttle, host timeouts), as does jest-circus for the test timeout. Lets the
 * REAL event loop turn until the counts are back at `target` (or the limit)
 * and reports how long that took.
 */
async function settleRealLoop(
  target: ResourceCounts | null,
): Promise<{ settleMs: number; resources: ResourceCounts }> {
  const started = nowMs();
  let resources = activeResources();
  const over = (r: ResourceCounts) =>
    target !== null &&
    ((r.Timeout ?? 0) > (target.Timeout ?? 0) ||
      (r.Immediate ?? 0) > (target.Immediate ?? 0));
  await sleepReal(10);
  resources = activeResources();
  while (over(resources) && nowMs() - started < REAL_SETTLE_LIMIT_MS) {
    await sleepReal(25);
    resources = activeResources();
  }
  return { settleMs: Number((nowMs() - started).toFixed(1)), resources };
}

/**
 * Full GC, repeated with a real event-loop turn in between so weak callbacks
 * and finalizers scheduled by the first collection are drained before the
 * measurement (a single `gc()` leaves tens of MB of already-dead objects).
 */
async function heapSample() {
  const g = globalThis as { gc?: () => void };
  if (!g.gc) {
    throw new Error(
      'global.gc is unavailable: run jest with NODE_OPTIONS=--expose-gc',
    );
  }
  for (let i = 0; i < 3; i += 1) {
    g.gc();
    await sleepReal(0);
  }
  g.gc();
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    rss: usage.rss,
  };
}

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

// ─────────────────────────── render helpers ─────────────────────────────

async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Runs pending timers until none are left (bounded), letting effects run. */
async function drainTimers(maxRounds = 20) {
  for (let i = 0; i < maxRounds && jest.getTimerCount() > 0; i += 1) {
    await act(async () => {
      jest.runOnlyPendingTimers();
      await Promise.resolve();
    });
  }
}

function pressableByTestId(
  renderer: ReactTestRenderer,
  testID: string,
): ReactTestInstance | null {
  return (
    renderer.root.findAll(
      n => n.props.testID === testID && typeof n.props.onPress === 'function',
    )[0] ?? null
  );
}

function pressableByLabel(
  renderer: ReactTestRenderer,
  label: string,
): ReactTestInstance | null {
  return (
    renderer.root.findAll(
      n =>
        n.props.accessibilityLabel === label &&
        typeof n.props.onPress === 'function',
    )[0] ?? null
  );
}

function paywallMounted(renderer: ReactTestRenderer): number {
  return renderer.root.findAllByType(PaywallScreen).length;
}

function paywallNodes(renderer: ReactTestRenderer): number {
  return renderer.root.findAll(
    n =>
      typeof n.props.testID === 'string' &&
      n.props.testID.startsWith('paywall-'),
  ).length;
}

function treeSize(renderer: ReactTestRenderer): number {
  return renderer.root.findAll(() => true).length;
}

// ─────────────────────────── scenario model ─────────────────────────────

type Step =
  | 'see-plans'
  | 'back'
  | 'hw-back'
  | 'plan-monthly'
  | 'plan-annual'
  | 'plan-lifetime'
  | 'continue'
  | 'restore'
  | 'retry'
  | 'terms'
  | 'privacy'
  | 'dismiss-error'
  | 'tick'
  | 'flush';
type ExitMode = 'close' | 'purchase-verified' | 'unmount-root';

const STEPS: readonly Step[] = [
  'see-plans',
  'see-plans',
  'back',
  'hw-back',
  'plan-monthly',
  'plan-annual',
  'plan-lifetime',
  'continue',
  'restore',
  'retry',
  'terms',
  'privacy',
  'dismiss-error',
  'tick',
  'flush',
];
const EXITS: readonly ExitMode[] = [
  'close',
  'close',
  'close',
  'purchase-verified',
  'unmount-root',
];

interface Scenario {
  seed: number;
  world: World;
  cold: boolean;
  steps: Step[];
  exit: ExitMode;
}

function scenarioFor(seed: number): Scenario {
  const rng = mulberry32(seed);
  const configured = rng() > 0.08;
  const world: World = {
    access: pick(rng, ACCESS_WORLDS),
    offerings: pick(rng, OFFERINGS_WORLDS),
    sync: pick(rng, SYNC_WORLDS),
    purchase: pick(rng, PURCHASE_WORLDS),
    configured,
  };
  const cold = rng() < 0.5;
  const length = Math.floor(rng() * 7);
  const steps: Step[] = [];
  for (let i = 0; i < length; i += 1) steps.push(pick(rng, STEPS));
  return { seed, world, cold, steps, exit: pick(rng, EXITS) };
}

interface IterationRow {
  iteration: number;
  seed: number;
  scenario: Omit<Scenario, 'seed'>;
  outcome: 'HELD' | 'BROKEN';
  violations: string[];
  applied: string[];
  mountMs: number;
  iterationMs: number;
  fetchCalls: number;
  sdkCalls: number;
  animationsStarted: number;
  consoleIssues: string[];
}

interface HeapRow {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  rss: number;
  timers: number;
  backHandlers: number;
  accessSubscriptions: number;
  liveAnimatedNodes: number;
  resources: ResourceCounts;
  realSettleMs: number;
}

interface Baseline {
  timers: number;
  /** NavigationContainer itself owns one hardwareBackPress subscription. */
  backHandlers: number;
  accessSubscriptions: number;
  treeSize: number;
  liveAnimatedNodes: number;
  resources: ResourceCounts;
}

function linearSlope(points: Array<{ x: number; y: number }>): number {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) * (p.x - mx);
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

async function takeHeapRow(
  iteration: number,
  target: ResourceCounts | null,
): Promise<HeapRow> {
  const settled = await settleRealLoop(target);
  const animated = liveAnimatedNodes();
  return {
    iteration,
    ...(await heapSample()),
    timers: jest.getTimerCount(),
    backHandlers: backHandlers.size,
    accessSubscriptions,
    liveAnimatedNodes: animated,
    resources: settled.resources,
    realSettleMs: settled.settleMs,
  };
}

// ─────────────────────────────── harness ────────────────────────────────

class Harness {
  renderer!: ReactTestRenderer;
  baseline!: Baseline;
  /** Paywall route pushes performed by the campaign. */
  paywallPushes = 0;
  /** Root re-mounts performed by `unmount-root` exits. */
  rootRemounts = 0;
  readonly net: FakeNetwork = {
    fetchCalls: 0,
    sdkCalls: 0,
    world: {
      access: 'free-2',
      offerings: 'full',
      sync: 'verified',
      purchase: 'success',
      configured: true,
    },
  };

  async mountRoot() {
    await act(async () => {
      this.renderer = TestRenderer.create(<RootNavigator />);
    });
    await flushMicrotasks();
    await drainTimers();
  }

  async unmountRoot() {
    await act(async () => {
      this.renderer.unmount();
    });
    await drainTimers();
  }

  async captureBaseline() {
    await drainTimers();
    const settled = await settleRealLoop(null);
    this.baseline = {
      timers: jest.getTimerCount(),
      backHandlers: backHandlers.size,
      accessSubscriptions,
      treeSize: treeSize(this.renderer),
      liveAnimatedNodes: liveAnimatedNodes(),
      resources: settled.resources,
    };
  }

  applyWorld(world: World, cold: boolean) {
    this.net.world = world;
    if (!world.configured) {
      clearAccessStoreConfiguration();
      return;
    }
    if (cold || useAccessStore.getState().status === 'idle') {
      configureAccessStore(buildDependencies(this.net));
    }
  }

  async openPaywall(): Promise<number> {
    const launcher = pressableByTestId(this.renderer, 'stress-open-paywall');
    if (!launcher) throw new Error('launcher missing: Home tab not mounted');
    const start = nowMs();
    await act(async () => {
      launcher.props.onPress();
    });
    this.paywallPushes += 1;
    await flushMicrotasks();
    const mounted = nowMs() - start;
    await drainTimers();
    return mounted;
  }

  /** Presses like a user: a disabled control is a no-op (`'disabled'`). */
  async press(node: ReactTestInstance | null): Promise<boolean | 'disabled'> {
    if (!node) return false;
    if (node.props.disabled === true) return 'disabled';
    await act(async () => {
      node.props.onPressIn?.();
      node.props.onPress();
      node.props.onPressOut?.();
    });
    await flushMicrotasks();
    return true;
  }

  async runStep(step: Step): Promise<string> {
    const r = this.renderer;
    switch (step) {
      case 'see-plans':
        return `${step}:${await this.press(pressableByTestId(r, 'paywall-see-plans'))}`;
      case 'back':
        return `${step}:${await this.press(pressableByTestId(r, 'paywall-back'))}`;
      case 'hw-back': {
        // RN semantics: newest subscription first, stop at the first `true`.
        const handlers = [...backHandlers].reverse();
        let handled = 0;
        await act(async () => {
          for (const h of handlers) {
            handled += 1;
            if (
              h({ type: 'hardwareBackPress', timeStamp: Date.now() }) === true
            ) {
              break;
            }
          }
        });
        await flushMicrotasks();
        return `${step}:${handled}/${handlers.length}`;
      }
      case 'plan-monthly':
      case 'plan-annual':
      case 'plan-lifetime':
        return `${step}:${await this.press(pressableByTestId(r, `paywall-${step}`))}`;
      case 'continue':
        return `${step}:${await this.press(pressableByTestId(r, 'paywall-continue'))}`;
      case 'restore':
        return `${step}:${await this.press(pressableByTestId(r, 'paywall-restore'))}`;
      case 'retry':
        return `${step}:${await this.press(pressableByTestId(r, 'paywall-retry'))}`;
      case 'terms':
        return `${step}:${await this.press(pressableByLabel(r, 'Terms of use'))}`;
      case 'privacy':
        return `${step}:${await this.press(pressableByLabel(r, 'Privacy policy'))}`;
      case 'dismiss-error':
        return `${step}:${await this.press(
          pressableByLabel(r, 'Dismiss membership message'),
        )}`;
      case 'tick':
        await act(async () => {
          jest.advanceTimersByTime(5);
        });
        return `${step}:${jest.getTimerCount()}`;
      case 'flush':
        await drainTimers();
        return `${step}:${jest.getTimerCount()}`;
    }
  }

  async exit(mode: ExitMode): Promise<string> {
    const r = this.renderer;
    if (mode === 'purchase-verified') {
      // Force a verifiable purchase so onPurchased → navigation.goBack() runs.
      this.net.world = {
        ...this.net.world,
        purchase: 'success',
        sync: 'verified',
      };
      let applied = `${mode}:`;
      applied += `${await this.press(pressableByTestId(r, 'paywall-see-plans'))}/`;
      const continued = await this.press(
        pressableByTestId(r, 'paywall-continue'),
      );
      applied += String(continued);
      await drainTimers();
      if (paywallMounted(r) === 0) return applied;
      if (
        continued === true &&
        useAccessStore.getState().canonicalAccess?.premium
      ) {
        throw new Error(
          'verified purchase did not pop the Paywall route (onPurchased → goBack)',
        );
      }
      // The purchase could not verify in this world (no plans / no access);
      // fall through to the close button so the iteration still exits.
      mode = 'close';
      applied += '→close';
      return `${applied}:${await this.closeViaButton()}`;
    }
    if (mode === 'unmount-root') {
      await this.unmountRoot();
      await this.mountRoot();
      this.rootRemounts += 1;
      return `${mode}:${paywallMounted(this.renderer) === 0}`;
    }
    return `${mode}:${await this.closeViaButton()}`;
  }

  async closeViaButton(): Promise<boolean | 'disabled'> {
    const r = this.renderer;
    const close =
      pressableByLabel(r, 'Close membership offer') ??
      pressableByLabel(r, 'Close membership');
    const pressed = await this.press(close);
    await drainTimers();
    if (paywallMounted(r) !== 0) {
      // Route still on the stack: goBack was refused or close did nothing.
      throw new Error(
        `Paywall still mounted after close (pressed=${String(pressed)}, page=${
          pressableByTestId(r, 'paywall-back') ? 'pricing' : 'value'
        })`,
      );
    }
    return pressed;
  }

  violations(): string[] {
    const r = this.renderer;
    const out: string[] = [];
    const mounted = paywallMounted(r);
    if (mounted !== 0)
      out.push(`PaywallScreen instances after exit: ${mounted}`);
    const nodes = paywallNodes(r);
    if (nodes !== 0) out.push(`paywall-* nodes after exit: ${nodes}`);
    if (backHandlers.size !== this.baseline.backHandlers) {
      out.push(
        `live BackHandler subscriptions ${backHandlers.size} != baseline ${this.baseline.backHandlers}`,
      );
    }
    const timers = jest.getTimerCount();
    if (timers !== this.baseline.timers) {
      out.push(`timers ${timers} != baseline ${this.baseline.timers}`);
    }
    if (accessSubscriptions !== this.baseline.accessSubscriptions) {
      out.push(
        `accessStore subscriptions ${accessSubscriptions} != baseline ${this.baseline.accessSubscriptions}`,
      );
    }
    const size = treeSize(r);
    if (size !== this.baseline.treeSize) {
      out.push(`renderer nodes ${size} != baseline ${this.baseline.treeSize}`);
    }
    return out;
  }
}

// ──────────────────────────────── suite ─────────────────────────────────

describe(`PaywallScreen long-run leak (${ITERATIONS} iterations, seed ${CAMPAIGN_SEED})`, () => {
  const rows: IterationRow[] = [];
  const heap: HeapRow[] = [];
  const harness = new Harness();
  let restoreInstrumentation = () => {};

  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'hrtime'],
    });
    restoreInstrumentation = installInstrumentation();
    harness.applyWorld(harness.net.world, true);
    await harness.mountRoot();
    await harness.captureBaseline();
  });

  afterAll(async () => {
    await harness.unmountRoot();
    await drainTimers();
    restoreInstrumentation();
    jest.useRealTimers();
    if (OUT_DIR) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(OUT_DIR, 'iterations.json'),
        JSON.stringify(
          {
            unit: 'scr-paywallscreen',
            lens: 'long-run-leak',
            campaignSeed: CAMPAIGN_SEED,
            iterations: ITERATIONS,
            heapEvery: HEAP_EVERY,
            baseline: harness.baseline,
            rows,
          },
          null,
          2,
        ),
      );
      fs.writeFileSync(
        path.join(OUT_DIR, 'heap.json'),
        JSON.stringify({ campaignSeed: CAMPAIGN_SEED, samples: heap }, null, 2),
      );
    }
  });

  it('mounts the real navigator with the paywall route unmounted', () => {
    expect(paywallMounted(harness.renderer)).toBe(0);
    expect(
      pressableByTestId(harness.renderer, 'stress-open-paywall'),
    ).not.toBeNull();
    expect(harness.baseline.timers).toBe(0);
  });

  it(`runs ${ITERATIONS} seeded mount → interact → unmount cycles through the navigator`, async () => {
    // The root mounted in beforeAll counts as the pre-campaign baseline;
    // record heap once before the first iteration so the slope has an origin.
    heap.push(await takeHeapRow(0, null));

    for (let i = 1; i <= ITERATIONS; i += 1) {
      const seed = CAMPAIGN_SEED + i;
      const scenario = scenarioFor(seed);
      consoleIssues.length = 0;
      const fetchBefore = harness.net.fetchCalls;
      const sdkBefore = harness.net.sdkCalls;
      const startedBefore = animatedTotals.started;
      const started = nowMs();
      const applied: string[] = [];
      const violations: string[] = [];
      let mountMs = 0;
      try {
        harness.applyWorld(scenario.world, scenario.cold);
        mountMs = await harness.openPaywall();
        if (paywallMounted(harness.renderer) !== 1) {
          violations.push(
            `PaywallScreen instances after navigate: ${paywallMounted(harness.renderer)}`,
          );
        }
        // PaywallScreen calls useAccessStore twice; a zero here means the
        // subscription instrumentation is not observing the real store.
        if (accessSubscriptions < harness.baseline.accessSubscriptions + 2) {
          violations.push(
            `accessStore subscriptions while mounted: ${accessSubscriptions} (baseline ${harness.baseline.accessSubscriptions})`,
          );
        }
        for (const step of scenario.steps)
          applied.push(await harness.runStep(step));
        applied.push(await harness.exit(scenario.exit));
        await drainTimers();
        violations.push(...harness.violations());
      } catch (error) {
        violations.push(
          `threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }
      // Mock call logs are harness state, not app state: drain them every
      // iteration so a heap sample only sees what the app itself retains.
      harvestAnimatedMockCalls();
      const row: IterationRow = {
        iteration: i,
        seed,
        scenario: {
          world: scenario.world,
          cold: scenario.cold,
          steps: scenario.steps,
          exit: scenario.exit,
        },
        outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
        violations,
        applied,
        mountMs: Number(mountMs.toFixed(3)),
        iterationMs: Number((nowMs() - started).toFixed(3)),
        fetchCalls: harness.net.fetchCalls - fetchBefore,
        sdkCalls: harness.net.sdkCalls - sdkBefore,
        animationsStarted: animatedTotals.started - startedBefore,
        consoleIssues: [...new Set(consoleIssues)],
      };
      rows.push(row);
      if (i % HEAP_EVERY === 0 || i === ITERATIONS) {
        heap.push(await takeHeapRow(i, heap[0]!.resources));
      }
    }

    const broken = rows.filter(r => r.outcome === 'BROKEN');
    expect(
      broken.map(r => `seed ${r.seed}: ${r.violations.join('; ')}`),
    ).toEqual([]);
    expect(rows).toHaveLength(ITERATIONS);
  });

  it('returns Node timers/immediates to the pre-campaign count at every heap sample', () => {
    const first = heap[0]!;
    for (const sample of heap) {
      expect({
        iteration: sample.iteration,
        Timeout: sample.resources.Timeout ?? 0,
        Immediate: sample.resources.Immediate ?? 0,
        timers: sample.timers,
        backHandlers: sample.backHandlers,
        accessSubscriptions: sample.accessSubscriptions,
      }).toEqual({
        iteration: sample.iteration,
        Timeout: first.resources.Timeout ?? 0,
        Immediate: first.resources.Immediate ?? 0,
        timers: harness.baseline.timers,
        backHandlers: harness.baseline.backHandlers,
        accessSubscriptions: harness.baseline.accessSubscriptions,
      });
    }
  });

  /**
   * KNOWN UPSTREAM BEHAVIOUR (react-native 0.87 `Libraries/Animated/AnimatedEvent.js`):
   * `Animated.event(..., { useNativeDriver: true })` makes its mapped values
   * native (`createAnimatedNode`) and `AnimatedEvent.__detach` only detaches
   * the event from the view — the value nodes are never `dropAnimatedNode`d.
   * Every native-stack route push therefore leaves exactly four event-only
   * value nodes behind: `@react-navigation/native-stack` `animatedHeaderHeight`
   * (initial 44) and `react-native-screens` `progress`/`closing`/`goingForward`
   * (initial 0). The root tree (tab screens) leaves nine per mount.
   *
   * PaywallScreen's OWN Animated nodes (`pageOpacity`, `pageShift`, props/
   * style/transform) are dropped on unmount — otherwise the residual would not
   * be exactly 4 per push. This pins that decomposition so a change in either
   * number is visible; it is not a pass on the retained event nodes.
   */
  it('leaves exactly 4 event-only native Animated value nodes per route push (navigator/screens), none from PaywallScreen', () => {
    const last = heap[heap.length - 1]!;
    expect({
      residual: last.liveAnimatedNodes - harness.baseline.liveAnimatedNodes,
      pushes: harness.paywallPushes,
      rootRemounts: harness.rootRemounts,
      baseline: harness.baseline.liveAnimatedNodes,
    }).toEqual({
      residual:
        4 * harness.paywallPushes +
        harness.baseline.liveAnimatedNodes * harness.rootRemounts,
      pushes: ITERATIONS,
      rootRemounts: rows.filter(r => r.scenario.exit === 'unmount-root').length,
      baseline: 9,
    });
  });

  it('exercised every world, exit mode and interaction step at least once', () => {
    if (ITERATIONS < 60) return;
    const seen = {
      access: new Set(rows.map(r => r.scenario.world.access)),
      offerings: new Set(rows.map(r => r.scenario.world.offerings)),
      exit: new Set(rows.map(r => r.scenario.exit)),
      steps: new Set(rows.flatMap(r => r.scenario.steps)),
      cold: new Set(rows.map(r => r.scenario.cold)),
    };
    expect([...seen.access].sort()).toEqual([...new Set(ACCESS_WORLDS)].sort());
    expect([...seen.offerings].sort()).toEqual(
      [...new Set(OFFERINGS_WORLDS)].sort(),
    );
    expect([...seen.exit].sort()).toEqual([...new Set(EXITS)].sort());
    expect([...seen.steps].sort()).toEqual([...new Set(STEPS)].sort());
    expect(seen.cold.size).toBe(2);
  });

  it(`heap slope after warm-up stays under ${HEAP_SLOPE_LIMIT_PCT_PER_100}% per 100 iterations (campaign mode only)`, () => {
    const samples = heap.filter(s => s.iteration >= WARMUP_ITERATIONS);
    const points = samples.map(s => ({ x: s.iteration, y: s.heapUsed }));
    const slopePer100 = linearSlope(points) * 100;
    const meanHeap =
      points.reduce((s, p) => s + p.y, 0) / Math.max(1, points.length);
    const slopePct = (slopePer100 / meanHeap) * 100;
    const increases = samples.filter(
      (s, i) => i > 0 && s.heapUsed > samples[i - 1]!.heapUsed,
    ).length;
    const summary = {
      samples: heap.map(s => ({
        iteration: s.iteration,
        heapUsedMB: Number((s.heapUsed / 1048576).toFixed(3)),
      })),
      warmupIterations: WARMUP_ITERATIONS,
      slopeBytesPer100: Math.round(slopePer100),
      slopePctPer100: Number(slopePct.toFixed(3)),
      monotoneIncreases: `${increases}/${Math.max(0, samples.length - 1)}`,
    };
    if (OUT_DIR) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(OUT_DIR, 'heap-summary.json'),
        JSON.stringify(summary, null, 2),
      );
    }
    if (!CAMPAIGN_MODE) return;
    expect(points.length).toBeGreaterThanOrEqual(5);
    const monotone = increases === samples.length - 1;
    expect({
      monotoneAndOverLimit: monotone && slopePct > HEAP_SLOPE_LIMIT_PCT_PER_100,
      summary,
    }).toEqual({
      monotoneAndOverLimit: false,
      summary,
    });
  });

  it(`mount time does not drift beyond ${MOUNT_DRIFT_LIMIT_RATIO}x between the first and last fifth (campaign mode only)`, () => {
    const steady = rows.filter(r => r.iteration > WARMUP_ITERATIONS);
    const fifth = Math.max(1, Math.floor(steady.length / 5));
    const head = steady.slice(0, fifth).map(r => r.mountMs);
    const tail = steady.slice(-fifth).map(r => r.mountMs);
    const iterHead = steady.slice(0, fifth).map(r => r.iterationMs);
    const iterTail = steady.slice(-fifth).map(r => r.iterationMs);
    const summary = {
      mountMedianHeadMs: Number(median(head).toFixed(3)),
      mountMedianTailMs: Number(median(tail).toFixed(3)),
      mountDriftRatio: Number(
        (median(tail) / Math.max(median(head), 1e-6)).toFixed(3),
      ),
      iterationMedianHeadMs: Number(median(iterHead).toFixed(3)),
      iterationMedianTailMs: Number(median(iterTail).toFixed(3)),
      iterationDriftRatio: Number(
        (median(iterTail) / Math.max(median(iterHead), 1e-6)).toFixed(3),
      ),
      mountP95Ms: Number(
        (
          [...steady.map(r => r.mountMs)].sort((a, b) => a - b)[
            Math.floor(steady.length * 0.95)
          ] ?? 0
        ).toFixed(3),
      ),
    };
    if (OUT_DIR) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(OUT_DIR, 'timing-summary.json'),
        JSON.stringify(summary, null, 2),
      );
    }
    if (!CAMPAIGN_MODE) return;
    expect(summary.mountDriftRatio).toBeLessThan(MOUNT_DRIFT_LIMIT_RATIO);
  });
});
