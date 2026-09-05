/**
 * Rapid/concurrent-interaction stress harness for PaywallScreen.
 *
 * The real PaywallScreen is mounted inside a REAL React Navigation
 * NavigationContainer + native-stack navigator (the same libraries and the
 * same close/purchase → goBack wiring RootNavigator's PaywallRoute uses),
 * against the real accessStore, the real RevenueCat billing client (fake
 * native SDK) and the real canonical access API client (fake fetch). Only
 * native modules (gradient, svg, safe area) and fetch are replaced.
 *
 * Every scenario is derived from a single 32-bit seed: the store/backend
 * latencies and fault injection, the interaction script (double/triple taps,
 * taps during the 220 ms page transition, two controls in one JS tick,
 * hardware/close back during in-flight async work, navigation spam) and the
 * settle procedure are all deterministic functions of that seed, so any
 * failing seed replays exactly with `STRESS_SEED=<seed>`.
 *
 *   npx jest --ci --silent __tests__/stress/paywallScreen.rapidInteraction
 *   STRESS_ITER=300 STRESS_OUT=/tmp/paywall-stress.json npx jest --ci ...
 *   STRESS_SEED=1042 STRESS_REPEAT=10 npx jest --ci ...
 */
jest.mock('react-native-linear-gradient', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-svg', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(View, null, props.children);
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

import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import React, { useEffect } from 'react';
import { BackHandler, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  NavigationContainer,
  createNavigationContainerRef,
  type NavigationState,
  type PartialState,
} from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
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
  type AccessOperation,
  type AccessLoadStatus,
} from '../../src/state/accessStore';
import { PaywallScreen } from '../../src/screens/PaywallScreen';
import { BrandSpinner, PressableScale } from '../../src/design/components';

// ─── Seeded RNG ─────────────────────────────────────────────────────────────

/** mulberry32 — small, fast, and fully reproducible from a 32-bit seed. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

// ─── Environment (faults + latencies) ───────────────────────────────────────

export type PurchaseOutcome = 'premium' | 'cancel' | 'store_error' | 'hang';
export type RestoreOutcome = 'premium' | 'not_premium' | 'store_error';
export type SyncOutcome = 'ok' | 'not_premium' | 'server_error';
export type AccessOutcome = 'free' | 'premium' | 'offline';
export type OfferingsOutcome = 'ok' | 'none' | 'error';

export interface StressEnvironment {
  sdkLatencyMs: number;
  backendLatencyMs: number;
  purchase: PurchaseOutcome;
  restore: RestoreOutcome;
  sync: SyncOutcome;
  access: AccessOutcome;
  offerings: OfferingsOutcome;
  /** After the first failure the store/backend recover (Retry must work). */
  recoverAfterFirstFailure: boolean;
}

export function environmentFor(rng: Rng): StressEnvironment {
  return {
    sdkLatencyMs: rng.pick([0, 0, 16, 50, 120, 300]),
    backendLatencyMs: rng.pick([0, 0, 16, 50, 120, 300]),
    purchase: rng.chance(0.72)
      ? 'premium'
      : rng.pick(['cancel', 'store_error', 'hang']),
    restore: rng.chance(0.6)
      ? 'premium'
      : rng.pick(['not_premium', 'store_error']),
    sync: rng.chance(0.8) ? 'ok' : rng.pick(['not_premium', 'server_error']),
    access: rng.chance(0.85) ? 'free' : rng.pick(['premium', 'offline']),
    offerings: rng.chance(0.88) ? 'ok' : rng.pick(['none', 'error']),
    recoverAfterFirstFailure: rng.chance(0.7),
  };
}

// ─── Fake native SDK ────────────────────────────────────────────────────────

const CANONICAL_USER_ID = '2f1c6c2e-9b7a-4c1e-8f3d-1a2b3c4d5e6f';
const API_BASE_URL = 'https://api.example.test/functions/v1/api';
const PUBLIC_SDK_KEY = 'appl_test_public_key';
const BEARER = 'access-token';

function storePackage(
  period: 'ANNUAL' | 'MONTHLY' | 'LIFETIME',
): RevenueCatPackageLike {
  const identifiers = {
    ANNUAL: { pkg: '$rc_annual', product: 'pickle_sensei_pro_annual' },
    MONTHLY: { pkg: '$rc_monthly', product: 'pickle_sensei_pro_monthly' },
    LIFETIME: { pkg: '$rc_lifetime', product: 'pickle_sensei_pro_lifetime' },
  }[period];
  const pricing = {
    ANNUAL: { price: 59.99, priceString: '$59.99', perMonth: '$5.00' },
    MONTHLY: { price: 7.99, priceString: '$7.99', perMonth: '$7.99' },
    LIFETIME: { price: 159.99, priceString: '$159.99', perMonth: null },
  }[period];
  return {
    identifier: identifiers.pkg,
    packageType: period,
    product: {
      identifier: identifiers.product,
      price: pricing.price,
      priceString: pricing.priceString,
      pricePerMonthString: pricing.perMonth,
      introPrice:
        period === 'ANNUAL' ? { price: 0, cycles: 1, period: 'P7D' } : null,
      defaultOption: null,
    },
  };
}

function customerInfo(premium: boolean): RevenueCatCustomerInfoLike {
  return {
    entitlements: {
      active: premium
        ? {
            pickle_sensei_pro: {
              productIdentifier: 'pickle_sensei_pro_annual',
              expirationDate: null,
            },
          }
        : {},
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface SdkCounters {
  getOfferings: number;
  purchasePackage: number;
  restorePurchases: number;
  purchaseSettledOk: number;
  restoreSettledOk: number;
}

interface FakeSdk {
  sdk: RevenueCatSdk;
  counters: SdkCounters;
}

function fakeSdk(env: StressEnvironment): FakeSdk {
  const counters: SdkCounters = {
    getOfferings: 0,
    purchasePackage: 0,
    restorePurchases: 0,
    purchaseSettledOk: 0,
    restoreSettledOk: 0,
  };
  let appUserId = '';
  let offeringsFailures = 0;
  let purchaseFailures = 0;
  let restoreFailures = 0;
  const recovered = (failures: number) =>
    env.recoverAfterFirstFailure && failures > 0;

  const sdk: RevenueCatSdk = {
    isConfigured: async () => false,
    configure: async input => {
      appUserId = input.appUserID;
    },
    getAppUserID: async () => appUserId,
    logIn: async id => {
      appUserId = id;
    },
    getOfferings: async () => {
      counters.getOfferings += 1;
      await delay(env.sdkLatencyMs);
      if (env.offerings === 'error' && !recovered(offeringsFailures)) {
        offeringsFailures += 1;
        throw new Error('offerings unavailable');
      }
      if (env.offerings === 'none' && !recovered(offeringsFailures)) {
        offeringsFailures += 1;
        return { current: null };
      }
      return {
        current: {
          identifier: 'default',
          annual: storePackage('ANNUAL'),
          monthly: storePackage('MONTHLY'),
          lifetime: storePackage('LIFETIME'),
        },
      };
    },
    purchasePackage: async () => {
      counters.purchasePackage += 1;
      await delay(env.sdkLatencyMs);
      if (env.purchase === 'hang' && !recovered(purchaseFailures)) {
        purchaseFailures += 1;
        // StoreKit sheet never returns inside the scenario budget.
        await delay(60 * 60_000);
      }
      if (env.purchase === 'cancel' && !recovered(purchaseFailures)) {
        purchaseFailures += 1;
        throw { userCancelled: true, message: 'Purchase was cancelled.' };
      }
      if (env.purchase === 'store_error' && !recovered(purchaseFailures)) {
        purchaseFailures += 1;
        throw new Error('SKErrorDomain 2');
      }
      counters.purchaseSettledOk += 1;
      return { customerInfo: customerInfo(true) };
    },
    restorePurchases: async () => {
      counters.restorePurchases += 1;
      await delay(env.sdkLatencyMs);
      if (env.restore === 'store_error' && !recovered(restoreFailures)) {
        restoreFailures += 1;
        throw new Error('network');
      }
      counters.restoreSettledOk += 1;
      return customerInfo(env.restore !== 'not_premium');
    },
    getCustomerInfo: async () => customerInfo(false),
    checkTrialOrIntroductoryPriceEligibility: async () => ({
      pickle_sensei_pro_annual: { status: 2 },
    }),
  };
  return { sdk, counters };
}

// ─── Fake backend (fetch) ───────────────────────────────────────────────────

export interface BackendCounters {
  getAccess: number;
  postSync: number;
  postSyncPremium: number;
  unexpected: string[];
}

function accessPayload(premium: boolean, used = 2) {
  const remaining = 2 - used;
  return {
    premium,
    entitlements: premium ? ['premium', 'pickle_sensei_pro'] : [],
    freeRatings: {
      limit: 2,
      used,
      reserved: 0,
      remaining,
      availableToReserve: remaining,
    },
    canStartRating: premium || remaining > 0,
    paywallRequired: !(premium || remaining > 0),
  };
}

function fakeBackend(env: StressEnvironment): {
  fetchFn: BillingFetch;
  counters: BackendCounters;
} {
  const counters: BackendCounters = {
    getAccess: 0,
    postSync: 0,
    postSyncPremium: 0,
    unexpected: [],
  };
  let accessFailures = 0;
  let syncFailures = 0;
  const recovered = (failures: number) =>
    env.recoverAfterFirstFailure && failures > 0;
  const respond = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response;

  const fetchFn: BillingFetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const path = input.replace(API_BASE_URL, '');
    await delay(env.backendLatencyMs);
    if (method === 'GET' && path === '/v1/me/access') {
      counters.getAccess += 1;
      if (env.access === 'offline' && !recovered(accessFailures)) {
        accessFailures += 1;
        throw new TypeError('Network request failed');
      }
      return respond(200, accessPayload(env.access === 'premium'));
    }
    if (method === 'POST' && path === '/v1/billing/sync') {
      counters.postSync += 1;
      if (env.sync === 'server_error' && !recovered(syncFailures)) {
        syncFailures += 1;
        return respond(503, { error: 'unavailable' });
      }
      const premium = env.sync !== 'not_premium' || recovered(syncFailures);
      if (env.sync === 'not_premium') syncFailures += 1;
      if (premium) counters.postSyncPremium += 1;
      return respond(200, {
        billing: {
          premium,
          productKey: premium ? 'pickle_sensei_pro_annual' : null,
          expiresAt: null,
          verifiedAt: '2026-09-01T00:00:00.000Z',
        },
        access: accessPayload(premium),
      });
    }
    counters.unexpected.push(`${method} ${path}`);
    throw new Error(`unexpected request ${method} ${path}`);
  };
  return { fetchFn, counters };
}

// ─── Real navigator around the real screen ──────────────────────────────────

/**
 * Home ≙ RootNavigator's `Tabs`, Result ≙ the `Result` screen that
 * AnalyzeScreen leaves beneath the paywall (`replace('Result')` then
 * `navigate('Paywall')`), Paywall ≙ the real PaywallRoute wiring.
 */
type StackParams = {
  Home: undefined;
  Result: undefined;
  Paywall: { source: 'settings' | 'rating' } | undefined;
};

const Stack = createNativeStackNavigator<StackParams>();
const navigationRef = createNavigationContainerRef<StackParams>();

export interface HostCounters {
  openTerms: number;
  openPrivacy: number;
  paywallMounts: number;
  paywallUnmounts: number;
}

let hostCounters: HostCounters = {
  openTerms: 0,
  openPrivacy: 0,
  paywallMounts: 0,
  paywallUnmounts: 0,
};

function HomeDriver({
  navigation,
  route,
}: NativeStackScreenProps<StackParams, 'Home' | 'Result'>) {
  return (
    <>
      <Text>[{route.name}]</Text>
      <PressableScale
        testID={`${route.name}-open-paywall`}
        accessibilityLabel="Open paywall"
        onPress={() => navigation.navigate('Paywall', { source: 'settings' })}
      >
        <Text>Open paywall</Text>
      </PressableScale>
    </>
  );
}

/** Mirrors RootNavigator's PaywallRoute wiring exactly. */
function PaywallRoute({
  navigation,
}: NativeStackScreenProps<StackParams, 'Paywall'>) {
  useEffect(() => {
    hostCounters.paywallMounts += 1;
    return () => {
      hostCounters.paywallUnmounts += 1;
    };
  }, []);
  return (
    <PaywallScreen
      onClose={() => navigation.goBack()}
      onPurchased={() => navigation.goBack()}
      onOpenTerms={() => {
        hostCounters.openTerms += 1;
      }}
      onOpenPrivacy={() => {
        hostCounters.openPrivacy += 1;
      }}
    />
  );
}

function StressApp() {
  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator initialRouteName="Paywall">
        <Stack.Screen name="Home" component={HomeDriver} />
        <Stack.Screen name="Result" component={HomeDriver} />
        <Stack.Screen
          name="Paywall"
          component={PaywallRoute}
          options={{
            animation: 'slide_from_bottom',
            presentation: 'fullScreenModal',
          }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

function routeNames(
  state: NavigationState | PartialState<NavigationState> | undefined,
): string[] {
  if (!state) return [];
  return state.routes.map(route => route.name);
}

// ─── Interaction script ─────────────────────────────────────────────────────

export type Control =
  | 'see-plans'
  | 'back'
  | 'close'
  | 'plan-annual'
  | 'plan-monthly'
  | 'plan-lifetime'
  | 'continue'
  | 'restore'
  | 'retry'
  | 'dismiss-error'
  | 'terms'
  | 'privacy'
  | 'verified-close'
  | 'verified-continue'
  | 'home-open-paywall'
  | 'hardware-back';

const CONTROL_QUERY: Record<
  Exclude<Control, 'hardware-back'>,
  { testID?: string; label?: string }
> = {
  'see-plans': { testID: 'paywall-see-plans' },
  back: { testID: 'paywall-back' },
  close: { label: 'Close membership offer' },
  'plan-annual': { testID: 'paywall-plan-annual' },
  'plan-monthly': { testID: 'paywall-plan-monthly' },
  'plan-lifetime': { testID: 'paywall-plan-lifetime' },
  continue: { testID: 'paywall-continue' },
  restore: { testID: 'paywall-restore' },
  retry: { testID: 'paywall-retry' },
  'dismiss-error': { label: 'Dismiss membership message' },
  terms: { label: 'Terms of use' },
  privacy: { label: 'Privacy policy' },
  'verified-close': { label: 'Close membership' },
  'verified-continue': { label: 'Continue coaching' },
  /** Resolved against the top-most non-paywall route at press time. */
  'home-open-paywall': { testID: 'open-paywall' },
};

export type Step =
  /** `count` taps on one control, `gapMs` apart (0 = same JS tick). */
  | { kind: 'burst'; control: Control; count: number; gapMs: number }
  /** Two different controls pressed in the same JS tick. */
  | { kind: 'simultaneous'; controls: [Control, Control] }
  /** Let fake time pass (animations, latencies). */
  | { kind: 'advance'; ms: number };

const WEIGHTED_TARGETS: readonly Control[] = [
  'see-plans',
  'see-plans',
  'see-plans',
  'back',
  'back',
  'continue',
  'continue',
  'continue',
  'restore',
  'restore',
  'plan-annual',
  'plan-monthly',
  'plan-lifetime',
  'retry',
  'close',
  'close',
  'hardware-back',
  'hardware-back',
  'dismiss-error',
  'terms',
  'privacy',
  'verified-close',
  'verified-continue',
  'home-open-paywall',
  'home-open-paywall',
];

const SIMULTANEOUS_PAIRS: readonly [Control, Control][] = [
  ['continue', 'restore'],
  ['restore', 'continue'],
  ['back', 'continue'],
  ['see-plans', 'close'],
  ['plan-annual', 'plan-monthly'],
  ['plan-monthly', 'plan-lifetime'],
  ['close', 'continue'],
  ['continue', 'close'],
  ['hardware-back', 'continue'],
  ['restore', 'hardware-back'],
  ['retry', 'retry'],
  ['see-plans', 'back'],
  ['close', 'close'],
  ['home-open-paywall', 'home-open-paywall'],
  ['plan-lifetime', 'continue'],
];

/** Gaps chosen around the 220 ms page transition and the 110/150 ms press
 * scale animations so taps land mid-transition as well as on settled UI. */
const TAP_GAPS_MS = [0, 0, 16, 50, 110, 200, 260];
const ADVANCE_MS = [0, 16, 50, 110, 219, 221, 350, 600, 1_500];

export function scriptFor(rng: Rng): Step[] {
  const length = 6 + rng.int(15);
  const steps: Step[] = [];
  // Open with a page change most of the time so pricing controls are reachable.
  if (rng.chance(0.8)) {
    steps.push({
      kind: 'burst',
      control: 'see-plans',
      count: 1 + rng.int(3),
      gapMs: rng.pick(TAP_GAPS_MS),
    });
  }
  while (steps.length < length) {
    const roll = rng.next();
    if (roll < 0.55) {
      steps.push({
        kind: 'burst',
        control: rng.pick(WEIGHTED_TARGETS),
        count: rng.chance(0.35) ? 1 : 2 + rng.int(2),
        gapMs: rng.pick(TAP_GAPS_MS),
      });
    } else if (roll < 0.75) {
      steps.push({
        kind: 'simultaneous',
        controls: rng.pick(SIMULTANEOUS_PAIRS),
      });
    } else {
      steps.push({ kind: 'advance', ms: rng.pick(ADVANCE_MS) });
    }
  }
  return steps;
}

// ─── Runtime ────────────────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;

function pressablesIn(renderer: Renderer) {
  return renderer.root.findAll(
    node =>
      node.type === PressableScale && typeof node.props.onPress === 'function',
  );
}

function topRoute(): string | undefined {
  if (!navigationRef.isReady()) return undefined;
  const names = routeNames(navigationRef.getRootState());
  return names[names.length - 1];
}

function findControl(
  renderer: Renderer,
  control: Exclude<Control, 'hardware-back'>,
) {
  const query = CONTROL_QUERY[control];
  const testID =
    control === 'home-open-paywall'
      ? `${topRoute()}-open-paywall`
      : query.testID;
  const matches = pressablesIn(renderer).filter(node =>
    testID
      ? node.props.testID === testID
      : node.props.accessibilityLabel === query.label,
  );
  return matches;
}

type PressResult = 'pressed' | 'absent' | 'disabled' | 'duplicate';

interface StepTrace {
  step: Step;
  results: PressResult[];
  routesAfter: string[];
  operationAfter: AccessOperation;
  statusAfter: AccessLoadStatus;
  /** console.error entries emitted during this step (1-based indices). */
  consoleErrorsDuring: number[];
}

export interface Violation {
  invariant: string;
  detail: string;
}

export interface ScenarioResult {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  environment: StressEnvironment;
  steps: number;
  taps: number;
  violations: Violation[];
  counters: {
    sdk: SdkCounters;
    backend: BackendCounters;
    host: HostCounters;
    purchaseStarts: number;
    restoreStarts: number;
    initializeStarts: number;
    pops: number;
    pushes: number;
    maxRoutes: number;
    maxPaywallRoutes: number;
  };
  final: {
    routes: string[];
    operation: AccessOperation;
    status: AccessLoadStatus;
    pendingTimers: number;
    premium: boolean;
    /** console.error entries emitted after the last scripted step. */
    consoleErrorsDuringSettle: number[];
  };
  consoleErrors: string[];
  consoleWarnings: string[];
  unhandledRejections: string[];
  trace: StepTrace[];
}

function messageOf(args: unknown[]): string {
  return args
    .map(arg =>
      arg instanceof Error
        ? `${arg.name}: ${arg.message}`
        : typeof arg === 'string'
          ? arg
          : JSON.stringify(arg),
    )
    .join(' ')
    .slice(0, 400);
}

async function tick(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

export async function runScenario(seed: number): Promise<ScenarioResult> {
  const rng = new Rng(seed);
  return execute(seed, environmentFor(rng), scriptFor(rng));
}

/** Hand-written (minimized) scenario; `seed` is only a label here. */
export async function execute(
  seed: number,
  env: StressEnvironment,
  script: Step[],
): Promise<ScenarioResult> {
  hostCounters = {
    openTerms: 0,
    openPrivacy: 0,
    paywallMounts: 0,
    paywallUnmounts: 0,
  };
  const sdk = fakeSdk(env);
  const backend = fakeBackend(env);
  configureAccessStore(
    createBillingAccessDependencies({
      revenueCatPublicSdkKey: PUBLIC_SDK_KEY,
      canonicalAppUserId: CANONICAL_USER_ID,
      apiBaseUrl: API_BASE_URL,
      apiToken: BEARER,
      fetchFn: backend.fetchFn,
      revenueCatSdk: sdk.sdk,
      platform: 'ios',
    }),
  );

  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const unhandledRejections: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(messageOf(args));
    });
  const warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      consoleWarnings.push(messageOf(args));
    });
  const onUnhandled = (reason: unknown) => {
    unhandledRejections.push(messageOf([reason]));
  };
  process.on('unhandledRejection', onUnhandled);

  const backHandlers: Array<() => boolean | null | undefined> = [];
  const backSpy = jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((_event, handler) => {
      const callback = handler as () => boolean | null | undefined;
      backHandlers.push(callback);
      return {
        remove: () => {
          const index = backHandlers.indexOf(callback);
          if (index >= 0) backHandlers.splice(index, 1);
        },
      };
    });
  const hardwareBack = () => {
    for (let i = backHandlers.length - 1; i >= 0; i -= 1) {
      if (backHandlers[i]?.() === true) return;
    }
  };

  let purchaseStarts = 0;
  let restoreStarts = 0;
  let initializeStarts = 0;
  let previous = useAccessStore.getState();
  const unsubscribe = useAccessStore.subscribe(state => {
    if (previous.operation !== 'purchasing' && state.operation === 'purchasing')
      purchaseStarts += 1;
    if (previous.operation !== 'restoring' && state.operation === 'restoring')
      restoreStarts += 1;
    if (previous.status !== 'loading' && state.status === 'loading')
      initializeStarts += 1;
    previous = state;
  });

  let pops = 0;
  let pushes = 0;
  let maxRoutes = 0;
  let maxPaywallRoutes = 0;
  let lastRouteCount = 0;
  const observeRoutes = () => {
    const routes = navigationRef.isReady()
      ? routeNames(navigationRef.getRootState())
      : [];
    if (routes.length > lastRouteCount)
      pushes += routes.length - lastRouteCount;
    if (routes.length < lastRouteCount) pops += lastRouteCount - routes.length;
    lastRouteCount = routes.length;
    maxRoutes = Math.max(maxRoutes, routes.length);
    maxPaywallRoutes = Math.max(
      maxPaywallRoutes,
      routes.filter(name => name === 'Paywall').length,
    );
    return routes;
  };

  const violations: Violation[] = [];
  const trace: StepTrace[] = [];
  let taps = 0;
  let renderer!: Renderer;

  try {
    await act(async () => {
      renderer = TestRenderer.create(<StressApp />);
    });
    // The stack starts on Paywall so its mount is the "opened as a modal"
    // state; Home is beneath it so close/back/purchase have somewhere to go.
    await act(async () => {
      navigationRef.reset({
        index: 2,
        routes: [
          { name: 'Home' },
          { name: 'Result' },
          { name: 'Paywall', params: { source: 'rating' } },
        ],
      });
    });
    await tick(0);
    observeRoutes();

    const press = (control: Control): PressResult => {
      taps += 1;
      if (control === 'hardware-back') {
        // Only a paywall-directed back press is part of the unit under test;
        // with the paywall gone the navigator's own handler would pop Result.
        if (topRoute() !== 'Paywall') return 'absent';
        hardwareBack();
        return 'pressed';
      }
      const matches = findControl(renderer, control);
      if (matches.length > 1) return 'duplicate';
      const node = matches[0];
      if (!node) return 'absent';
      if (node.props.disabled === true) return 'disabled';
      node.props.onPress();
      return 'pressed';
    };

    for (const step of script) {
      const results: PressResult[] = [];
      if (step.kind === 'advance') {
        await tick(step.ms);
      } else if (step.kind === 'simultaneous') {
        await act(async () => {
          results.push(press(step.controls[0]));
          results.push(press(step.controls[1]));
        });
      } else if (step.gapMs === 0) {
        await act(async () => {
          for (let i = 0; i < step.count; i += 1)
            results.push(press(step.control));
        });
      } else {
        for (let i = 0; i < step.count; i += 1) {
          await act(async () => {
            results.push(press(step.control));
          });
          if (i < step.count - 1) await tick(step.gapMs);
        }
      }
      const routes = observeRoutes();
      const state = useAccessStore.getState();
      const errorsBefore = trace.reduce(
        (count, entry) => count + entry.consoleErrorsDuring.length,
        0,
      );
      trace.push({
        step,
        results,
        routesAfter: routes,
        operationAfter: state.operation,
        statusAfter: state.status,
        consoleErrorsDuring: consoleErrors
          .map((_, index) => index + 1)
          .filter(index => index > errorsBefore),
      });
      if (results.includes('duplicate')) {
        violations.push({
          invariant: 'no duplicate control rendered',
          detail: `step ${trace.length}: ${JSON.stringify(step)} matched more than one pressable`,
        });
      }
      if (routes.filter(name => name === 'Paywall').length > 1) {
        violations.push({
          invariant: 'no duplicate paywall modal',
          detail: `step ${trace.length}: routes ${routes.join(',')}`,
        });
      }
      if (routes[0] !== 'Home' || routes[1] !== 'Result') {
        violations.push({
          invariant:
            'paywall only ever pops itself (screen beneath it survives)',
          detail: `step ${trace.length}: ${JSON.stringify(step)} → routes ${routes.join(',')}`,
        });
      }
    }

    // Settle: everything with a finite latency must come to rest.
    const settleBudgetMs = env.purchase === 'hang' ? 5_000 : 20_000;
    for (let elapsed = 0; elapsed < settleBudgetMs; elapsed += 250) {
      await tick(250);
      const state = useAccessStore.getState();
      if (
        state.operation === 'idle' &&
        state.status !== 'loading' &&
        jest.getTimerCount() === 0
      ) {
        break;
      }
    }
    const routes = observeRoutes();
    const state = useAccessStore.getState();
    const paywallMounted = routes.includes('Paywall');
    const errorsInSteps = trace.reduce(
      (count, entry) => count + entry.consoleErrorsDuring.length,
      0,
    );
    const consoleErrorsDuringSettle = consoleErrors
      .map((_, index) => index + 1)
      .filter(index => index > errorsInSteps);
    const premium = state.canonicalAccess?.premium === true;

    // ── Oracles ──
    const hung = env.purchase === 'hang' && sdk.counters.purchasePackage > 0;
    if (!hung) {
      if (state.operation !== 'idle') {
        violations.push({
          invariant: 'no orphan operation after settle',
          detail: `operation=${state.operation}`,
        });
      }
      if (state.status === 'loading') {
        violations.push({
          invariant: 'no orphan loading state after settle',
          detail: `status=loading`,
        });
      }
      if (paywallMounted) {
        const spinners = renderer.root.findAllByType(BrandSpinner).length;
        if (spinners > 0) {
          violations.push({
            invariant: 'no spinner rendered once idle',
            detail: `${spinners} BrandSpinner(s) rendered with operation=${state.operation} status=${state.status}`,
          });
        }
      }
    }
    if (paywallMounted && !premium) {
      const seePlans = findControl(renderer, 'see-plans').length;
      const back = findControl(renderer, 'back').length;
      if (seePlans + back !== 1) {
        violations.push({
          invariant: 'exactly one paywall page rendered',
          detail: `see-plans=${seePlans} back=${back}`,
        });
      }
    }
    if (paywallMounted && premium) {
      const verified = findControl(renderer, 'verified-continue').length;
      const cta = findControl(renderer, 'continue').length;
      if (verified !== 1 || cta !== 0) {
        violations.push({
          invariant: 'verified page replaces pricing once premium',
          detail: `verified-continue=${verified} continue=${cta}`,
        });
      }
    }
    if (sdk.counters.purchasePackage !== purchaseStarts) {
      violations.push({
        invariant: 'one store purchase request per purchase intent',
        detail: `purchasePackage=${sdk.counters.purchasePackage} purchaseStarts=${purchaseStarts}`,
      });
    }
    if (sdk.counters.restorePurchases !== restoreStarts) {
      violations.push({
        invariant: 'one store restore request per restore intent',
        detail: `restorePurchases=${sdk.counters.restorePurchases} restoreStarts=${restoreStarts}`,
      });
    }
    if (sdk.counters.getOfferings !== initializeStarts) {
      violations.push({
        invariant: 'one offerings load per initialize',
        detail: `getOfferings=${sdk.counters.getOfferings} initializeStarts=${initializeStarts}`,
      });
    }
    if (backend.counters.getAccess !== initializeStarts) {
      violations.push({
        invariant: 'one access read per initialize',
        detail: `getAccess=${backend.counters.getAccess} initializeStarts=${initializeStarts}`,
      });
    }
    const settledOk =
      sdk.counters.purchaseSettledOk + sdk.counters.restoreSettledOk;
    if (backend.counters.postSync !== settledOk) {
      violations.push({
        invariant:
          'exactly one billing sync per store-settled purchase/restore',
        detail: `postSync=${backend.counters.postSync} storeSettledOk=${settledOk}`,
      });
    }
    if (backend.counters.unexpected.length > 0) {
      violations.push({
        invariant: 'no unexpected backend requests',
        detail: backend.counters.unexpected.join(', '),
      });
    }
    if (backend.counters.postSyncPremium > 0 && paywallMounted && !premium) {
      violations.push({
        invariant: 'verified premium reaches the screen',
        detail: 'sync returned premium but canonicalAccess is not premium',
      });
    }
    if (pops > pushes + 1) {
      violations.push({
        invariant: 'at most one pop per open paywall',
        detail: `pops=${pops} pushes=${pushes}`,
      });
    }
    if (routes[0] !== 'Home' || routes[1] !== 'Result') {
      violations.push({
        invariant: 'paywall only ever pops itself (screen beneath it survives)',
        detail: `after settle: routes ${routes.join(',')}`,
      });
    }
    if (maxPaywallRoutes > 1) {
      violations.push({
        invariant: 'no duplicate paywall modal',
        detail: `maxPaywallRoutes=${maxPaywallRoutes}`,
      });
    }
    if (
      hostCounters.paywallMounts - hostCounters.paywallUnmounts !==
      (paywallMounted ? 1 : 0)
    ) {
      violations.push({
        invariant: 'mounted paywall instances match navigator state',
        detail: `mounts=${hostCounters.paywallMounts} unmounts=${hostCounters.paywallUnmounts} routes=${routes.join(',')}`,
      });
    }
    if (consoleErrors.length > 0) {
      violations.push({
        invariant:
          'no console.error (act warnings, unhandled navigation, render-phase updates)',
        detail: consoleErrors.join(' | '),
      });
    }
    if (consoleWarnings.length > 0) {
      violations.push({
        invariant: 'no console.warn',
        detail: consoleWarnings.join(' | '),
      });
    }
    if (unhandledRejections.length > 0) {
      violations.push({
        invariant: 'no unhandled promise rejections',
        detail: unhandledRejections.join(' | '),
      });
    }

    const pendingTimers = jest.getTimerCount();
    return {
      seed,
      outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
      environment: env,
      steps: script.length,
      taps,
      violations,
      counters: {
        sdk: sdk.counters,
        backend: backend.counters,
        host: hostCounters,
        purchaseStarts,
        restoreStarts,
        initializeStarts,
        pops,
        pushes,
        maxRoutes,
        maxPaywallRoutes,
      },
      final: {
        routes,
        operation: state.operation,
        status: state.status,
        pendingTimers,
        premium,
        consoleErrorsDuringSettle,
      },
      consoleErrors,
      consoleWarnings,
      unhandledRejections,
      trace,
    };
  } finally {
    unsubscribe();
    if (renderer) {
      act(() => renderer.unmount());
    }
    // Drain anything the unmount scheduled before the next scenario.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60 * 60_000);
    });
    clearAccessStoreConfiguration();
    process.off('unhandledRejection', onUnhandled);
    backSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }
}

/** Seeds for a campaign; `STRESS_SEED` narrows to one seed for replay. */
export function campaignSeeds(): number[] {
  const single = process.env.STRESS_SEED;
  if (single) {
    const repeat = Number(process.env.STRESS_REPEAT ?? '1');
    return Array.from({ length: repeat }, () => Number(single));
  }
  const iterations = Number(process.env.STRESS_ITER ?? '24');
  const base = Number(process.env.STRESS_BASE ?? '1000');
  return Array.from({ length: iterations }, (_, i) => base + i);
}

// ─── Campaign ───────────────────────────────────────────────────────────────

const seeds = campaignSeeds();
const results: ScenarioResult[] = [];

beforeAll(() => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
  });
});

afterAll(() => {
  jest.useRealTimers();
  const out = process.env.STRESS_OUT;
  if (!out) return;
  mkdirSync(dirname(out), { recursive: true });
  const broken = results.filter(result => result.outcome === 'BROKEN');
  writeFileSync(
    out,
    JSON.stringify(
      {
        unit: 'scr-paywallscreen',
        lens: 'rapid-interaction',
        executed: results.length,
        held: results.length - broken.length,
        broken: broken.length,
        brokenSeeds: broken.map(result => result.seed),
        totalTaps: results.reduce((sum, result) => sum + result.taps, 0),
        totalSteps: results.reduce((sum, result) => sum + result.steps, 0),
        results,
      },
      null,
      2,
    ),
  );
});

describe('harness self-check', () => {
  it('derives the same environment and script from the same seed', () => {
    const a = new Rng(4242);
    const b = new Rng(4242);
    expect(environmentFor(a)).toEqual(environmentFor(b));
    expect(scriptFor(a)).toEqual(scriptFor(b));
    expect(scriptFor(new Rng(1))).not.toEqual(scriptFor(new Rng(2)));
  });

  it('covers every control and every fault across the first 300 seeds', () => {
    const controls = new Set<Control>();
    const purchases = new Set<PurchaseOutcome>();
    const gaps = new Set<number>();
    for (let seed = 1000; seed < 1300; seed += 1) {
      const rng = new Rng(seed);
      purchases.add(environmentFor(rng).purchase);
      for (const step of scriptFor(rng)) {
        if (step.kind === 'burst') {
          controls.add(step.control);
          gaps.add(step.gapMs);
        }
        if (step.kind === 'simultaneous') {
          controls.add(step.controls[0]);
          controls.add(step.controls[1]);
        }
      }
    }
    expect([...controls].sort()).toEqual(
      [...WEIGHTED_TARGETS].filter((c, i, all) => all.indexOf(c) === i).sort(),
    );
    expect([...purchases].sort()).toEqual([
      'cancel',
      'hang',
      'premium',
      'store_error',
    ]);
    expect([...gaps].sort((x, y) => x - y)).toEqual(
      [...TAP_GAPS_MS]
        .filter((g, i, all) => all.indexOf(g) === i)
        .sort((x, y) => x - y),
    );
  });
});

/**
 * Minimized reproductions of the two failure modes the seeded campaign
 * surfaced (seeds 1010 / 1002 …). Kept deterministic and tiny so a fix can
 * be pinned without the full campaign.
 */
describe('minimized reproductions', () => {
  const calm: StressEnvironment = {
    sdkLatencyMs: 120,
    backendLatencyMs: 16,
    purchase: 'premium',
    restore: 'premium',
    sync: 'ok',
    access: 'free',
    offerings: 'ok',
    recoverAfterFirstFailure: false,
  };

  it('double-tapping Close in one tick pops only the paywall (seed 1010 minimized)', async () => {
    const result = await execute(1010, calm, [
      { kind: 'advance', ms: 500 },
      { kind: 'burst', control: 'close', count: 2, gapMs: 0 },
    ]);
    expect(result.trace.map(entry => entry.routesAfter)).toEqual([
      ['Home', 'Result', 'Paywall'],
      ['Home', 'Result'],
    ]);
    expect(result.violations).toEqual([]);
  });

  it('Close while a purchase is in flight leaves the screen beneath untouched when it later verifies (seed 1002 minimized)', async () => {
    const result = await execute(1002, calm, [
      { kind: 'burst', control: 'see-plans', count: 1, gapMs: 0 },
      { kind: 'advance', ms: 500 },
      { kind: 'burst', control: 'continue', count: 1, gapMs: 0 },
      { kind: 'burst', control: 'close', count: 1, gapMs: 0 },
      { kind: 'advance', ms: 2_000 },
    ]);
    expect(result.counters.sdk.purchasePackage).toBe(1);
    expect(result.counters.backend.postSync).toBe(1);
    expect(result.final.routes).toEqual(['Home', 'Result']);
    expect(result.violations).toEqual([]);
  });

  it('Close while a restore is in flight leaves the screen beneath untouched when it later verifies (seed 1011 minimized)', async () => {
    const result = await execute(1011, calm, [
      { kind: 'burst', control: 'see-plans', count: 1, gapMs: 0 },
      { kind: 'advance', ms: 500 },
      { kind: 'simultaneous', controls: ['restore', 'close'] },
      { kind: 'advance', ms: 2_000 },
    ]);
    expect(result.counters.sdk.restorePurchases).toBe(1);
    expect(result.final.routes).toEqual(['Home', 'Result']);
    expect(result.violations).toEqual([]);
  });
});

describe(`PaywallScreen rapid-interaction stress (${seeds.length} seeded bursts)`, () => {
  it.each(seeds)(
    'seed %i: single side effect per intent, no orphan state, no warnings',
    async seed => {
      const result = await runScenario(seed);
      results.push(result);
      expect({
        seed,
        violations: result.violations,
        trace: result.violations.length ? result.trace : undefined,
      }).toEqual({
        seed,
        violations: [],
        trace: undefined,
      });
    },
  );
});
