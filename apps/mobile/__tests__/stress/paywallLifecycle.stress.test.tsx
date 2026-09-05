/**
 * Lifecycle-interruption stress campaign for the REAL PaywallScreen rendered
 * inside the REAL RootNavigator (NavigationContainer + native stack + bottom
 * tabs + PremiumTabBar) against the REAL accessStore, the REAL RevenueCat
 * client (fake native SDK object injected through the production
 * `createBillingAccessDependencies` seam) and the REAL canonical access API
 * client (fake `fetch`). Only native modules and fetch are doubled; the
 * unrelated heavy screens on the root stack are replaced by inert stubs so
 * their native dependencies do not run here.
 *
 * Every scenario is a seeded schedule (mulberry32 from
 * testing/xcBehavioral/evidence.ts) of user taps, in-flight network/StoreKit
 * settlements (success, 401, 5xx, network error, malformed body, StoreKit
 * cancel/failure, server verification lag), background/foreground,
 * unmount-mid-request, kill/relaunch (re-hydrate the session), bearer
 * rotation mid-request, account switch and later access revocation. After
 * every step the invariants below are checked against a model of the world:
 *
 *   I1  verified-premium UI / `onPurchased` only after the backend told THIS
 *       account, in THIS configuration epoch, `premium: true`
 *   I2  no state of a previous account survives a switch, and stale
 *       responses for a previous account/epoch never mutate the store
 *   I3  every outgoing request bears the bearer that is current for the
 *       signed-in account at send time (rotation never leaks the old one,
 *       a previous account's token never reaches the successor's requests)
 *   I4  the store is never left "busy" without a pending request
 *   I5  navigation matches the model: the paywall is dismissed only by the
 *       user or by a verified purchase/restore from THIS paywall mount
 *   I6  re-hydration is idempotent (double configure == single configure)
 *   I7  no leaked BackHandler/AppState subscriptions or timers after
 *       unmount; the whole suite runs clean under --detectOpenHandles
 *   I8  no unexpected console.error/console.warn
 *
 * Replay: STRESS_SEED=<seed>[,<seed>...] npx jest --ci __tests__/stress/paywallLifecycle.stress
 * Scale:  STRESS_ITER=<n> (default 12; the campaign in the report used 120)
 *         STRESS_BASE_SEED=<n> re-derives the whole campaign seed list
 * Evidence: artifacts/stress/paywall-lifecycle/<STRESS_RUN_ID>/results.json
 *
 * Known BROKEN classes on 1fb0efd7 (deterministic, 10/10 on every seed; the
 * minimized replays live in paywallLifecycle.minimized.test.tsx):
 *   I4  restore tapped while the paywall is still loading → initialize()
 *       resets operation to 'idle' while StoreKit restore is in flight
 *   I5/I8  paywall closed while a purchase is being verified → the late
 *       onPurchased calls goBack() from the popped route and pops whatever
 *       screen is on top now (or logs an unhandled GO_BACK at the root)
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
  () => require('react-native-safe-area-context/jest/mock').default,
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
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  const AnimatedView = (props: Record<string, unknown>) =>
    React.createElement(View, props);
  return {
    __esModule: true,
    default: {
      View: AnimatedView,
      createAnimatedComponent:
        (Component: React.ComponentType<Record<string, unknown>>) =>
        (props: Record<string, unknown>) =>
          React.createElement(Component, props),
    },
    Easing: {
      out: (fn: unknown) => fn,
      cubic: () => 0,
    },
    interpolate: () => 0,
    useAnimatedStyle: (updater: () => object) => updater(),
    useAnimatedProps: (updater: () => object) => updater(),
    useSharedValue: (init: unknown) => ({ value: init }),
    withTiming: (toValue: unknown) => toValue,
    withDelay: (_delay: number, value: unknown) => value,
  };
});
// The auth store owns sign-in UI state; the harness drives the session /
// billing configuration itself exactly the way authStore.installApiSession
// and clearSyncedRuntime do (apiSession + configureAccessStore).
jest.mock('../../src/auth/authStore', () => {
  const { create } = require('zustand');
  const useAuthStore = create(() => ({
    hydrated: true,
    session: { provider: 'apple', localOnly: false },
    busy: false,
    error: null,
    signInWithApple: jest.fn(async () => undefined),
    signInWithGoogle: jest.fn(async () => undefined),
    clearError: jest.fn(),
  }));
  return { __esModule: true, useAuthStore };
});
jest.mock('../../src/notifications/service', () => ({
  __esModule: true,
  subscribeToNotificationPresses: jest.fn(() => jest.fn()),
}));
// Inert stand-ins for the screens this campaign never visits. Home and
// DrillLibrary keep REAL navigation (useNavigation) so the paywall is opened
// and the stack is grown exactly as the app does it.
jest.mock('../../src/screens/HomeScreen', () => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  const { useNavigation } = require('@react-navigation/native');
  const HomeScreen = () => {
    const navigation = useNavigation();
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(Text, null, 'HOME_STUB'),
      React.createElement(
        Pressable,
        {
          testID: 'home-open-paywall',
          onPress: () => navigation.navigate('Paywall', { source: 'settings' }),
        },
        React.createElement(Text, null, 'paywall'),
      ),
      React.createElement(
        Pressable,
        {
          testID: 'home-open-drills',
          onPress: () => navigation.navigate('DrillLibrary'),
        },
        React.createElement(Text, null, 'drills'),
      ),
    );
  };
  return { __esModule: true, HomeScreen };
});
jest.mock('../../src/screens/DrillLibraryScreen', () => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  const { useNavigation } = require('@react-navigation/native');
  const DrillLibraryScreen = () => {
    const navigation = useNavigation();
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(Text, null, 'DRILLS_STUB'),
      React.createElement(
        Pressable,
        { testID: 'drills-back', onPress: () => navigation.goBack() },
        React.createElement(Text, null, 'back'),
      ),
    );
  };
  return { __esModule: true, DrillLibraryScreen };
});
jest.mock('../../src/screens/LibraryScreen', () => ({
  __esModule: true,
  LibraryScreen: () => null,
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  __esModule: true,
  ProgressScreen: () => null,
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  __esModule: true,
  SettingsScreen: () => null,
}));
jest.mock('../../src/screens/AnalyzeScreen', () => ({
  __esModule: true,
  AnalyzeScreen: () => null,
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  __esModule: true,
  ResultScreen: () => null,
}));
jest.mock('../../src/screens/ResultDetailsScreen', () => ({
  __esModule: true,
  ResultDetailsScreen: () => null,
}));
jest.mock('../../src/screens/FormReviewScreen', () => ({
  __esModule: true,
  FormReviewScreen: () => null,
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  __esModule: true,
  StreakCalendarScreen: () => null,
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  __esModule: true,
  ManageAccountScreen: () => null,
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  __esModule: true,
  ConsentSettingsScreen: () => null,
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  __esModule: true,
  NotificationSettingsScreen: () => null,
}));
jest.mock('../../src/screens/SignInScreen', () => ({
  __esModule: true,
  SignInScreen: () => null,
}));

import React from 'react';
import { AppState, BackHandler, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  createBillingAccessDependencies,
  type BillingFetch,
  type RevenueCatCustomerInfoLike,
  type RevenueCatPackageLike,
  type RevenueCatSdk,
} from '../../src/billing';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import {
  bearerTokenFor,
  clearApiSession,
  establishApiSession,
  getApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../../src/account/apiSession';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { seededRandom } from '../../testing/xcBehavioral/evidence';

declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
  appendFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

type HardwareBackPressEvent = Parameters<
  Parameters<typeof BackHandler.addEventListener>[1]
>[0];

// ─── Campaign parameters ─────────────────────────────────────────────────────

const DEFAULT_ITERATIONS = 12;
const STEPS_MIN = 30;
const STEPS_MAX = 50;
const iterationsEnv = Number(process.env['STRESS_ITER']);
const ITERATIONS =
  Number.isSafeInteger(iterationsEnv) && iterationsEnv > 0
    ? iterationsEnv
    : DEFAULT_ITERATIONS;
const pinnedSeedEnv = process.env['STRESS_SEED'];
const PINNED_SEEDS = pinnedSeedEnv
  ? pinnedSeedEnv
      .split(',')
      .map(part => Number(part.trim()))
      .filter(value => Number.isSafeInteger(value))
  : null;
const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';

function evidenceDir(): string {
  // apps/mobile/__tests__/stress → repo root
  return path.join(
    path.resolve(__dirname, '..', '..', '..', '..'),
    'artifacts',
    'stress',
    'paywall-lifecycle',
    RUN_ID,
  );
}

/** Campaign seeds: derived from a base so the whole run is replayable. */
function campaignSeeds(): number[] {
  if (PINNED_SEEDS && PINNED_SEEDS.length > 0) return PINNED_SEEDS;
  const base = Number(process.env['STRESS_BASE_SEED'] ?? 20260905);
  const random = seededRandom(base);
  const seeds: number[] = [];
  const seen = new Set<number>();
  while (seeds.length < ITERATIONS) {
    const seed = Math.floor(random() * 0x7fffffff) + 1;
    if (seen.has(seed)) continue;
    seen.add(seed);
    seeds.push(seed);
  }
  return seeds;
}

// ─── Fixtures: two accounts, never the production project ────────────────────

const API_BASE_URL = 'https://api.example.test/functions/v1/api';

interface Account {
  label: 'A' | 'B';
  canonicalAppUserId: string;
  /** Distinct free-rating usage so the account is recognizable in state. */
  used: number;
  /** Distinct annual price so `plans` is recognizable in state. */
  priceString: string;
}

const ACCOUNTS: Record<'A' | 'B', Account> = {
  A: {
    label: 'A',
    canonicalAppUserId: '2f1c6c2e-9b7a-4c1e-8f3d-1a2b3c4d5e6f',
    used: 2,
    priceString: '$59.99',
  },
  B: {
    label: 'B',
    canonicalAppUserId: '7b2d0a44-5c3e-4f61-9a8b-0c1d2e3f4a5b',
    used: 1,
    priceString: '$61.99',
  },
};

function accessPayload(premium: boolean, used: number) {
  const remaining = Math.max(0, 2 - used);
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

function syncPayload(premium: boolean, used: number) {
  return {
    billing: {
      premium,
      productKey: premium ? 'pickle_sensei_pro_annual' : null,
      expiresAt: null,
      verifiedAt: '2026-09-01T00:00:00.000Z',
    },
    access: accessPayload(premium, used),
  };
}

function storePackage(
  period: 'ANNUAL' | 'MONTHLY',
  priceString: string,
): RevenueCatPackageLike {
  const identifiers = {
    ANNUAL: { pkg: '$rc_annual', product: 'pickle_sensei_pro_annual' },
    MONTHLY: { pkg: '$rc_monthly', product: 'pickle_sensei_pro_monthly' },
  }[period];
  return {
    identifier: identifiers.pkg,
    packageType: period,
    product: {
      identifier: identifiers.product,
      price: Number(priceString.replace('$', '')),
      priceString,
      pricePerMonthString: period === 'ANNUAL' ? '$5.00' : priceString,
      introPrice: null,
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

// ─── World: pending operations the schedule settles ─────────────────────────

type OpKind =
  | 'sdk.logIn'
  | 'sdk.getOfferings'
  | 'sdk.purchasePackage'
  | 'sdk.restorePurchases'
  | 'GET /v1/me/access'
  | 'POST /v1/billing/sync';

type HttpOutcome =
  | 'ok'
  | 'http401'
  | 'http500'
  | 'http503'
  | 'networkError'
  | 'invalidBody'
  | 'syncNotPremium';
type SdkOutcome = 'ok' | 'cancelled' | 'storeError' | 'noOfferings';

interface PendingOp {
  id: number;
  kind: OpKind;
  /** Account the request was issued for (token owner / RC app user). */
  account: 'A' | 'B' | 'unknown';
  /** Configuration epoch (sign-in generation) at issue time. */
  epoch: number;
  /** Paywall mount that (transitively) started this op, when known. */
  paywallMount: number | null;
  bearer: string | null;
  settle: (outcome: HttpOutcome | SdkOutcome) => void;
  settled: boolean;
  /** What the response actually told the client (HTTP ops only). */
  result: 'premium' | 'notPremium' | 'error' | null;
  step: number;
}

interface AccountWorld {
  /** RevenueCat says this app user holds the entitlement. */
  storePremium: boolean;
  /** Backend billing_entitlements row says premium (server truth). */
  serverPremium: boolean;
  /** Latest access revocation state (server side). */
  revoked: boolean;
  tokens: string[];
}

interface World {
  accounts: Record<'A' | 'B', AccountWorld>;
  current: 'A' | 'B' | null;
  epoch: number;
  ops: PendingOp[];
  nextOpId: number;
  /** `${account}:${epoch}` → what the LAST applied backend response said. */
  lastTold: Map<string, boolean>;
  /** RevenueCat singleton app user binding. */
  rcAppUserId: string | null;
  rcConfigured: boolean;
  requests: Array<{
    step: number;
    kind: OpKind;
    account: string;
    bearerOk: boolean;
    epoch: number;
  }>;
  violations: string[];
  unauthorizedReports: number;
}

function currentToken(world: World, account: 'A' | 'B'): string {
  const tokens = world.accounts[account].tokens;
  return tokens[tokens.length - 1] ?? '';
}

function accountForToken(world: World, token: string): 'A' | 'B' | 'unknown' {
  for (const label of ['A', 'B'] as const) {
    if (world.accounts[label].tokens.includes(token)) return label;
  }
  return 'unknown';
}

function accountForUserId(userId: string | null): 'A' | 'B' | 'unknown' {
  if (userId === ACCOUNTS.A.canonicalAppUserId) return 'A';
  if (userId === ACCOUNTS.B.canonicalAppUserId) return 'B';
  return 'unknown';
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function brokenBodyResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;
}

// ─── Scenario driver ─────────────────────────────────────────────────────────

type Action =
  | 'openPaywall'
  | 'seePlans'
  | 'back'
  | 'hardwareBack'
  | 'close'
  | 'continue'
  | 'restore'
  | 'retry'
  | 'selectMonthly'
  | 'openDrills'
  | 'drillsBack'
  | 'settleOne'
  | 'settleAll'
  | 'background'
  | 'foreground'
  | 'rotateToken'
  | 'switchAccount'
  | 'killRelaunch'
  | 'revokeLater'
  | 'unmountNavigator'
  | 'remountNavigator'
  | 'refreshFromSettings'
  | 'flush';

const ACTION_WEIGHTS: Array<[Action, number]> = [
  ['openPaywall', 12],
  ['seePlans', 14],
  ['back', 2],
  ['hardwareBack', 2],
  ['close', 3],
  ['continue', 14],
  ['restore', 6],
  ['retry', 4],
  ['selectMonthly', 2],
  ['openDrills', 3],
  ['drillsBack', 2],
  ['settleOne', 30],
  ['settleAll', 6],
  ['background', 3],
  ['foreground', 4],
  ['rotateToken', 4],
  ['switchAccount', 2],
  ['killRelaunch', 2],
  ['revokeLater', 4],
  ['unmountNavigator', 2],
  ['remountNavigator', 6],
  ['refreshFromSettings', 3],
  ['flush', 2],
];

const HTTP_OUTCOME_WEIGHTS: Array<[HttpOutcome, number]> = [
  ['ok', 76],
  ['http401', 5],
  ['http500', 4],
  ['http503', 4],
  ['networkError', 5],
  ['invalidBody', 2],
  ['syncNotPremium', 4],
];

const SDK_OUTCOME_WEIGHTS: Array<[SdkOutcome, number]> = [
  ['ok', 82],
  ['cancelled', 8],
  ['storeError', 7],
  ['noOfferings', 3],
];

function pick<T>(random: () => number, weights: Array<[T, number]>): T {
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [value, weight] of weights) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return weights[weights.length - 1]![0];
}

interface StepRecord {
  step: number;
  action: Action;
  detail?: string;
  visible: string;
  status: string;
  operation: string;
  premium: boolean;
}

interface ScenarioResult {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  steps: number;
  requests: number;
  settled: number;
  actionsExecuted: Record<string, number>;
  error: string | null;
  failingStep: number | null;
  trace: StepRecord[];
  consoleErrors: string[];
  durationMs: number;
}

/** A tapped element: the composite carrying the testID / label whose onPress IS the handler. */
function findPressable(
  renderer: TestRenderer.ReactTestRenderer,
  match: (props: Record<string, unknown>) => boolean,
) {
  const [node] = renderer.root.findAll(
    n =>
      match(n.props as Record<string, unknown>) &&
      typeof n.props.onPress === 'function',
  );
  return node ?? null;
}

function byTestId(renderer: TestRenderer.ReactTestRenderer, id: string) {
  return findPressable(renderer, props => props.testID === id);
}

function byLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return findPressable(renderer, props => props.accessibilityLabel === label);
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

async function settleAnimations(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 260));
  });
}

interface DataSnapshot {
  status: string;
  operation: string;
  plans: unknown;
  selectedPeriod: string;
  canonicalAccess: unknown;
  error: unknown;
}

function dataSnapshot(): DataSnapshot {
  const state = useAccessStore.getState();
  return {
    status: state.status,
    operation: state.operation,
    plans: state.plans,
    selectedPeriod: state.selectedPeriod,
    canonicalAccess: state.canonicalAccess,
    error: state.error,
  };
}

class InvariantViolation extends Error {
  constructor(
    public readonly invariant: string,
    message: string,
  ) {
    super(`${invariant}: ${message}`);
  }
}

// ─── Native-module instrumentation (leak accounting) ─────────────────────────

interface Instrumentation {
  backSubscriptions: Set<
    (event: HardwareBackPressEvent) => boolean | null | undefined
  >;
  appStateListeners: Set<(state: string) => void>;
  backAdds: number;
  backRemoves: number;
  appStateAdds: number;
  appStateRemoves: number;
  restore: () => void;
}

function instrumentNativeModules(): Instrumentation {
  const inst: Instrumentation = {
    backSubscriptions: new Set(),
    appStateListeners: new Set(),
    backAdds: 0,
    backRemoves: 0,
    appStateAdds: 0,
    appStateRemoves: 0,
    restore: () => undefined,
  };
  const backSpy = jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((_event, handler) => {
      inst.backAdds += 1;
      inst.backSubscriptions.add(handler);
      let removed = false;
      return {
        remove: () => {
          if (removed) return;
          removed = true;
          inst.backRemoves += 1;
          inst.backSubscriptions.delete(handler);
        },
      };
    });
  const appStateSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((_type: string, handler: (state: string) => void) => {
      inst.appStateAdds += 1;
      inst.appStateListeners.add(handler);
      let removed = false;
      return {
        remove: () => {
          if (removed) return;
          removed = true;
          inst.appStateRemoves += 1;
          inst.appStateListeners.delete(handler);
        },
      };
    }) as unknown as typeof AppState.addEventListener);
  inst.restore = () => {
    backSpy.mockRestore();
    appStateSpy.mockRestore();
  };
  return inst;
}

// ─── One scenario ────────────────────────────────────────────────────────────

async function runScenario(
  seed: number,
  inst: Instrumentation,
  consoleErrors: string[],
): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const random = seededRandom(seed);
  const stepCount =
    STEPS_MIN + Math.floor(random() * (STEPS_MAX - STEPS_MIN + 1));

  const world: World = {
    accounts: {
      A: {
        storePremium: false,
        serverPremium: false,
        revoked: false,
        tokens: [],
      },
      B: {
        storePremium: false,
        serverPremium: false,
        revoked: false,
        tokens: [],
      },
    },
    current: null,
    epoch: 0,
    ops: [],
    nextOpId: 1,
    lastTold: new Map(),
    rcAppUserId: null,
    rcConfigured: false,
    requests: [],
    violations: [],
    unauthorizedReports: 0,
  };

  const model = {
    paywallOpen: false,
    /** Monotonic id of the paywall mount currently on screen. */
    paywallMount: 0,
    nextPaywallMount: 1,
    /** Which paywall mount started the purchase/restore currently in flight. */
    purchaseOriginMount: null as number | null,
    drillsOpen: false,
    navigatorMounted: false,
    appState: 'active' as 'active' | 'background',
    /** A verified purchase from an UNMOUNTED paywall must change nothing. */
    staleGoBackExpected: false,
    /** The server refused the current bearer; production signs out. */
    signOutPending: false,
  };

  const trace: StepRecord[] = [];
  const actionsExecuted: Record<string, number> = {};
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  let tokenCounter = 0;

  const issueToken = (account: 'A' | 'B') => {
    tokenCounter += 1;
    const token = `bearer-${account}-${seed}-${tokenCounter}`;
    world.accounts[account].tokens.push(token);
    return token;
  };

  // ── Fake native SDK (RevenueCat singleton semantics) ──
  const newOp = (
    kind: OpKind,
    account: 'A' | 'B' | 'unknown',
    bearer: string | null,
    settle: (outcome: HttpOutcome | SdkOutcome) => void,
  ): PendingOp => {
    const op: PendingOp = {
      id: world.nextOpId++,
      kind,
      account,
      epoch: world.epoch,
      // The billing sync is issued from the purchase/restore async chain, so
      // it belongs to the paywall mount whose tap started that chain.
      paywallMount:
        kind === 'POST /v1/billing/sync'
          ? model.purchaseOriginMount
          : model.paywallOpen
            ? model.paywallMount
            : null,
      bearer,
      settled: false,
      result: null,
      step: trace.length,
      settle: outcome => {
        if (op.settled) return;
        op.settled = true;
        world.ops = world.ops.filter(candidate => candidate !== op);
        settle(outcome);
      },
    };
    world.ops.push(op);
    return op;
  };

  const sdk: RevenueCatSdk = {
    isConfigured: async () => world.rcConfigured,
    configure: async configuration => {
      world.rcConfigured = true;
      world.rcAppUserId = configuration.appUserID;
    },
    getAppUserID: async () => world.rcAppUserId ?? '',
    logIn: appUserID =>
      new Promise((resolve, reject) => {
        newOp('sdk.logIn', accountForUserId(appUserID), null, outcome => {
          if (outcome === 'storeError') {
            reject(new Error('RevenueCat logIn failed (network)'));
            return;
          }
          world.rcAppUserId = appUserID;
          resolve({});
        });
      }),
    getOfferings: () =>
      new Promise((resolve, reject) => {
        const account = accountForUserId(world.rcAppUserId);
        newOp('sdk.getOfferings', account, null, outcome => {
          if (outcome === 'storeError') {
            reject(new Error('Offerings fetch failed'));
            return;
          }
          if (outcome === 'noOfferings') {
            resolve({ current: null });
            return;
          }
          const price =
            account === 'unknown' ? '$0.00' : ACCOUNTS[account].priceString;
          resolve({
            current: {
              identifier: 'default',
              annual: storePackage('ANNUAL', price),
              monthly: storePackage('MONTHLY', '$7.99'),
              lifetime: null,
            },
          });
        });
      }),
    purchasePackage: () =>
      new Promise((resolve, reject) => {
        const account = accountForUserId(world.rcAppUserId);
        newOp('sdk.purchasePackage', account, null, outcome => {
          if (outcome === 'cancelled') {
            reject({ userCancelled: true, code: '1' });
            return;
          }
          if (outcome === 'storeError' || outcome === 'noOfferings') {
            reject(new Error('StoreKit purchase failed'));
            return;
          }
          if (account !== 'unknown')
            world.accounts[account].storePremium = true;
          resolve({ customerInfo: customerInfo(true) });
        });
      }),
    restorePurchases: () =>
      new Promise((resolve, reject) => {
        const account = accountForUserId(world.rcAppUserId);
        newOp('sdk.restorePurchases', account, null, outcome => {
          if (outcome === 'storeError' || outcome === 'noOfferings') {
            reject(new Error('StoreKit restore failed'));
            return;
          }
          resolve(
            customerInfo(
              account !== 'unknown' && world.accounts[account].storePremium,
            ),
          );
        });
      }),
    getCustomerInfo: async () =>
      customerInfo(
        world.rcAppUserId !== null &&
          accountForUserId(world.rcAppUserId) !== 'unknown' &&
          world.accounts[accountForUserId(world.rcAppUserId) as 'A' | 'B']
            .storePremium,
      ),
    checkTrialOrIntroductoryPriceEligibility: async () => ({}),
  };

  // ── Fake fetch (canonical access API) ──
  const fetchFn: BillingFetch = (input, init) =>
    new Promise<Response>((resolve, reject) => {
      if (!input.startsWith(API_BASE_URL)) {
        world.violations.push(`request to unexpected host: ${input}`);
        reject(new TypeError('Network request failed'));
        return;
      }
      const pathPart = input.slice(API_BASE_URL.length);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const bearer = headers['Authorization']?.replace(/^Bearer /, '') ?? null;
      const account = bearer ? accountForToken(world, bearer) : 'unknown';
      const kind: OpKind =
        pathPart === '/v1/me/access'
          ? 'GET /v1/me/access'
          : pathPart === '/v1/billing/sync'
            ? 'POST /v1/billing/sync'
            : (pathPart as OpKind);
      // I3: the bearer must be the CURRENT one of the CURRENT account.
      const expected = world.current
        ? currentToken(world, world.current)
        : null;
      const bearerOk = bearer !== null && bearer === expected;
      world.requests.push({
        step: trace.length,
        kind,
        account,
        bearerOk,
        epoch: world.epoch,
      });
      if (!bearerOk) {
        world.violations.push(
          `I3 request ${kind} at step ${trace.length} bore ${
            bearer ?? 'no token'
          } (account ${account}) but current is ${expected ?? 'none'} (account ${
            world.current ?? 'none'
          })`,
        );
      }
      const op = newOp(kind, account, bearer, outcome => {
        const owner = account === 'unknown' ? null : world.accounts[account];
        const bearerIsCurrent =
          bearer !== null &&
          account !== 'unknown' &&
          bearer === currentToken(world, account);
        // A rotated bearer is a still-valid JWT until it expires; the seed
        // decides whether the server still honours it or has expired it.
        const rotatedButAccepted = !bearerIsCurrent && random() < 0.5;
        op.result = 'error';
        if (outcome === 'networkError') {
          reject(new TypeError('Network request failed'));
          return;
        }
        if (
          outcome === 'http401' ||
          !owner ||
          account === 'unknown' ||
          (!bearerIsCurrent && !rotatedButAccepted)
        ) {
          resolve(jsonResponse(401, { error: 'unauthorized' }));
          return;
        }
        if (outcome === 'http500') {
          resolve(jsonResponse(500, { error: 'internal' }));
          return;
        }
        if (outcome === 'http503') {
          resolve(jsonResponse(503, { error: 'unavailable' }));
          return;
        }
        if (outcome === 'invalidBody') {
          resolve(brokenBodyResponse());
          return;
        }
        const used = ACCOUNTS[account].used;
        const tell = (premium: boolean) => {
          op.result = premium ? 'premium' : 'notPremium';
          if (op.epoch === world.epoch && account === world.current) {
            world.lastTold.set(`${account}:${op.epoch}`, premium);
          }
        };
        if (kind === 'GET /v1/me/access') {
          const premium = owner.serverPremium && !owner.revoked;
          tell(premium);
          resolve(jsonResponse(200, accessPayload(premium, used)));
          return;
        }
        // POST /v1/billing/sync: the server re-reads RevenueCat.
        if (outcome === 'syncNotPremium') {
          tell(false);
          resolve(jsonResponse(200, syncPayload(false, used)));
          return;
        }
        owner.serverPremium = owner.storePremium;
        const premium = owner.serverPremium && !owner.revoked;
        tell(premium);
        resolve(jsonResponse(200, syncPayload(premium, used)));
      });
    });

  // ── Session plumbing, mirroring authStore.installApiSession / clearSyncedRuntime ──
  const signIn = (account: 'A' | 'B') => {
    const token = issueToken(account);
    const session: ApiSession = {
      apiBaseUrl: API_BASE_URL,
      bearerToken: token,
      canonicalAppUserId: ACCOUNTS[account].canonicalAppUserId,
      provider: 'apple',
      refreshToken: `refresh-${account}`,
      bearerExpiresAtMs: Date.now() + 3_600_000,
    };
    world.current = account;
    world.epoch += 1;
    establishApiSession(session);
    configureAccessStore(
      createBillingAccessDependencies({
        revenueCatPublicSdkKey: getRuntimePublicConfig().revenueCatPublicSdkKey,
        canonicalAppUserId: session.canonicalAppUserId,
        apiBaseUrl: session.apiBaseUrl,
        get apiToken() {
          return bearerTokenFor(session.canonicalAppUserId);
        },
        fetchFn,
        revenueCatSdk: sdk,
        platform: 'ios',
      }),
    );
  };

  const signOut = () => {
    world.current = null;
    world.epoch += 1;
    clearApiSession();
    clearAccessStoreConfiguration();
  };

  setApiUnauthorizedListener(session => {
    world.unauthorizedReports += 1;
    const account = accountForUserId(session.canonicalAppUserId);
    if (account === 'unknown') return;
    if (bearerTokenFor(session.canonicalAppUserId) !== session.bearerToken) {
      world.violations.push('I3 unauthorized report for a non-current bearer');
      return;
    }
    // Production: sessionKeeper refreshes the bearer (rotation) or ends the
    // session when the refresh token is refused. Seeded choice; the sign-out
    // is asynchronous in production too, so it lands after this settlement.
    if (random() < 0.7) {
      const token = issueToken(account);
      establishApiSession({ ...session, bearerToken: token });
    } else {
      model.signOutPending = true;
    }
  });

  const mountNavigator = async () => {
    await act(async () => {
      renderer = TestRenderer.create(<RootNavigator />);
    });
    model.navigatorMounted = true;
    model.paywallOpen = false;
    model.drillsOpen = false;
    model.purchaseOriginMount = null;
  };

  const unmountNavigator = async () => {
    if (!renderer) return;
    const current = renderer;
    renderer = null;
    await act(async () => current.unmount());
    model.navigatorMounted = false;
    model.paywallOpen = false;
    model.drillsOpen = false;
    model.purchaseOriginMount = null;
  };

  const visibleSummary = (): string => {
    if (!renderer) return 'unmounted';
    const shown = texts(renderer);
    if (shown.includes('MEMBERSHIP VERIFIED')) return 'paywall:premium';
    if (byTestId(renderer, 'paywall-continue')) return 'paywall:pricing';
    if (byTestId(renderer, 'paywall-see-plans')) return 'paywall:value';
    if (shown.includes('DRILLS_STUB')) return 'drills';
    if (shown.includes('HOME_STUB')) return 'home';
    return `other:${shown.slice(0, 3).join('|')}`;
  };

  const paywallVisible = () =>
    renderer !== null && visibleSummary().startsWith('paywall:');

  // ── Invariants ──
  const checkInvariants = (action: Action) => {
    const state = useAccessStore.getState();
    const current = world.current;
    const key = current ? `${current}:${world.epoch}` : null;

    if (world.violations.length > 0) {
      throw new InvariantViolation('I3', world.violations.join('; '));
    }

    // I1 — premium only after the backend said so for this account+epoch.
    if (state.canonicalAccess?.premium === true) {
      if (!key || world.lastTold.get(key) !== true) {
        throw new InvariantViolation(
          'I1',
          `store shows premium for ${key ?? 'no account'} without a verified backend response in this epoch`,
        );
      }
    }
    if (renderer && visibleSummary() === 'paywall:premium') {
      if (!key || world.lastTold.get(key) !== true) {
        throw new InvariantViolation(
          'I1',
          `premium page rendered without verified backend response for ${key ?? 'no account'}`,
        );
      }
    }

    // I2 — nothing from the other account.
    if (current) {
      const other = current === 'A' ? 'B' : 'A';
      const access = state.canonicalAccess;
      if (access && access.freeRatings.used === ACCOUNTS[other].used) {
        throw new InvariantViolation(
          'I2',
          `canonicalAccess.used=${access.freeRatings.used} belongs to account ${other} while ${current} is signed in`,
        );
      }
      const annual = state.plans?.annual;
      if (annual && annual.priceString === ACCOUNTS[other].priceString) {
        throw new InvariantViolation(
          'I2',
          `plans.annual ${annual.priceString} belongs to account ${other} while ${current} is signed in`,
        );
      }
    } else {
      const snapshot = dataSnapshot();
      if (snapshot.status !== 'idle' && snapshot.status !== 'unconfigured') {
        throw new InvariantViolation(
          'I2',
          `signed-out store still holds status=${snapshot.status}`,
        );
      }
      if (snapshot.canonicalAccess !== null || snapshot.plans !== null) {
        throw new InvariantViolation(
          'I2',
          'signed-out store still holds access/plans of a previous account',
        );
      }
    }

    // I4 — busy only with a live request (checked after flush).
    if (action === 'flush' || action === 'settleAll') {
      const liveForCurrent = world.ops.filter(
        op => op.epoch === world.epoch,
      ).length;
      if (state.operation !== 'idle' && liveForCurrent === 0) {
        throw new InvariantViolation(
          'I4',
          `operation=${state.operation} with no pending request`,
        );
      }
      if (state.status === 'loading' && liveForCurrent === 0) {
        throw new InvariantViolation(
          'I4',
          'status=loading with no pending request',
        );
      }
    }
    // I4 — and the converse: while a purchase/restore of the CURRENT account
    // is still at the store, the store must say so (the buttons key off it).
    const storeOpInFlight = world.ops.find(
      op =>
        (op.kind === 'sdk.purchasePackage' ||
          op.kind === 'sdk.restorePurchases') &&
        op.epoch === world.epoch &&
        op.account === world.current,
    );
    if (storeOpInFlight && state.operation === 'idle') {
      throw new InvariantViolation(
        'I4',
        `operation=idle while ${storeOpInFlight.kind}#${storeOpInFlight.id} (issued step ${storeOpInFlight.step}) is still pending at the store`,
      );
    }

    // I5 — navigation matches the model.
    if (renderer) {
      const visible = paywallVisible();
      if (visible !== model.paywallOpen) {
        throw new InvariantViolation(
          'I5',
          `paywall ${visible ? 'visible' : 'hidden'} but model expects ${
            model.paywallOpen ? 'open' : 'closed'
          } (screen=${visibleSummary()})`,
        );
      }
      if (!model.paywallOpen) {
        const summary = visibleSummary();
        const expected = model.drillsOpen ? 'drills' : 'home';
        if (summary !== expected) {
          throw new InvariantViolation(
            'I5',
            `expected ${expected} on screen, saw ${summary}`,
          );
        }
      }
    }

    // I8 — no console noise.
    if (consoleErrors.length > 0) {
      throw new InvariantViolation('I8', consoleErrors.join(' || '));
    }
  };

  /** Applies a settled op's expected navigation side effects to the model. */
  const applySettlementToModel = (op: PendingOp) => {
    if (op.kind !== 'POST /v1/billing/sync') return;
    if (op.epoch !== world.epoch || op.account !== world.current) return;
    if (op.result !== 'premium') return;
    // The origin paywall mount's onPurchased → navigation.goBack().
    if (op.paywallMount === null) return;
    if (model.paywallOpen && model.paywallMount === op.paywallMount) {
      model.paywallOpen = false;
      model.purchaseOriginMount = null;
    } else {
      // Callback from an unmounted paywall: the model expects NO change.
      model.staleGoBackExpected = true;
    }
  };

  const settleOp = async (op: PendingOp, outcome: HttpOutcome | SdkOutcome) => {
    const stale = op.epoch !== world.epoch || op.account !== world.current;
    const before = stale ? JSON.stringify(dataSnapshot()) : null;
    const screenBefore = visibleSummary();
    await act(async () => {
      op.settle(outcome);
    });
    await flush();
    if (stale && before !== null) {
      const after = JSON.stringify(dataSnapshot());
      if (before !== after) {
        throw new InvariantViolation(
          'I2',
          `stale ${op.kind} (account ${op.account}, epoch ${op.epoch}) mutated the store of ${
            world.current ?? 'nobody'
          } epoch ${world.epoch}: ${before} → ${after}`,
        );
      }
    }
    applySettlementToModel(op);
    if (model.staleGoBackExpected) {
      model.staleGoBackExpected = false;
      const screenAfter = visibleSummary();
      if (screenAfter !== screenBefore) {
        throw new InvariantViolation(
          'I5',
          `stale onPurchased from paywall mount ${op.paywallMount} changed the screen from ${screenBefore} to ${screenAfter}`,
        );
      }
    }
    if (model.signOutPending) {
      model.signOutPending = false;
      await unmountNavigator();
      await act(async () => {
        signOut();
      });
      await flush();
    }
  };

  const outcomeFor = (op: PendingOp): HttpOutcome | SdkOutcome =>
    op.kind.startsWith('sdk.')
      ? pick(random, SDK_OUTCOME_WEIGHTS)
      : pick(random, HTTP_OUTCOME_WEIGHTS);

  // ── Actions ──
  const tap = async (node: ReturnType<typeof byTestId>): Promise<boolean> => {
    if (!node || node.props.disabled === true) return false;
    await act(async () => {
      (node.props.onPress as () => void)();
    });
    await flush();
    return true;
  };

  /** Only actions a user / the platform could actually take right now. */
  const applicable = (action: Action): boolean => {
    const state = useAccessStore.getState();
    const enabled = (node: ReturnType<typeof byTestId>) =>
      node !== null && node.props.disabled !== true;
    switch (action) {
      case 'openPaywall':
      case 'openDrills':
        return renderer !== null && !model.paywallOpen && !model.drillsOpen;
      case 'seePlans':
        return (
          renderer !== null && byTestId(renderer, 'paywall-see-plans') !== null
        );
      case 'back':
        return renderer !== null && byTestId(renderer, 'paywall-back') !== null;
      case 'hardwareBack':
        return (
          renderer !== null &&
          inst.backSubscriptions.size > 0 &&
          visibleSummary() !== 'home'
        );
      case 'close':
        return renderer !== null && model.paywallOpen;
      case 'continue':
        return (
          renderer !== null && enabled(byTestId(renderer, 'paywall-continue'))
        );
      case 'restore':
        return (
          renderer !== null && enabled(byTestId(renderer, 'paywall-restore'))
        );
      case 'retry':
        return (
          renderer !== null && enabled(byTestId(renderer, 'paywall-retry'))
        );
      case 'selectMonthly':
        return (
          renderer !== null &&
          enabled(byTestId(renderer, 'paywall-plan-monthly'))
        );
      case 'drillsBack':
        return renderer !== null && model.drillsOpen && !model.paywallOpen;
      case 'settleOne':
      case 'settleAll':
        return world.ops.length > 0;
      case 'background':
        return model.appState === 'active';
      case 'foreground':
        return model.appState === 'background';
      case 'rotateToken':
      case 'killRelaunch':
        return world.current !== null;
      case 'revokeLater': {
        if (!world.current) return false;
        const owner = world.accounts[world.current];
        return owner.serverPremium && !owner.revoked;
      }
      case 'unmountNavigator':
        return renderer !== null;
      case 'remountNavigator':
        return renderer === null && world.current !== null;
      case 'refreshFromSettings':
        return (
          renderer !== null &&
          world.current !== null &&
          !model.paywallOpen &&
          state.status !== 'loading'
        );
      case 'switchAccount':
      case 'flush':
        return true;
    }
  };

  const perform = async (action: Action): Promise<string | undefined> => {
    switch (action) {
      case 'openPaywall': {
        if (!renderer || model.paywallOpen || model.drillsOpen) return 'skip';
        await tap(byTestId(renderer, 'home-open-paywall'));
        model.paywallOpen = true;
        model.paywallMount = model.nextPaywallMount++;
        return `mount=${model.paywallMount}`;
      }
      case 'seePlans': {
        if (!renderer || !model.paywallOpen) return 'skip';
        return (await tap(byTestId(renderer, 'paywall-see-plans')))
          ? undefined
          : 'skip';
      }
      case 'back': {
        if (!renderer || !model.paywallOpen) return 'skip';
        return (await tap(byTestId(renderer, 'paywall-back')))
          ? undefined
          : 'skip';
      }
      case 'hardwareBack': {
        if (!renderer) return 'skip';
        const handlers = [...inst.backSubscriptions].reverse();
        if (handlers.length === 0) return 'skip:no-subscription';
        const before = visibleSummary();
        // BackHandler semantics: most recently subscribed handler first,
        // stop at the first one that returns true.
        await act(async () => {
          const event: HardwareBackPressEvent = {
            type: 'hardwareBackPress',
            timeStamp: Date.now(),
          };
          for (const handler of handlers) {
            if (handler(event) === true) break;
          }
        });
        await flush();
        if (before === 'paywall:pricing') {
          if (!byTestId(renderer, 'paywall-see-plans')) {
            throw new InvariantViolation(
              'I5',
              'hardware back on the pricing page did not return to the value page',
            );
          }
        } else if (before.startsWith('paywall:')) {
          model.paywallOpen = false;
        } else if (before === 'drills') {
          model.drillsOpen = false;
        }
        return `from=${before}`;
      }
      case 'close': {
        if (!renderer || !model.paywallOpen) return 'skip';
        const node =
          byLabel(renderer, 'Close membership offer') ??
          byLabel(renderer, 'Close membership') ??
          byLabel(renderer, 'Continue coaching');
        if (!(await tap(node))) return 'skip';
        model.paywallOpen = false;
        return undefined;
      }
      case 'continue': {
        if (!renderer || !model.paywallOpen) return 'skip';
        const node = byTestId(renderer, 'paywall-continue');
        if (!node || node.props.disabled === true) return 'skip';
        model.purchaseOriginMount = model.paywallMount;
        await tap(node);
        return `mount=${model.paywallMount}`;
      }
      case 'restore': {
        if (!renderer || !model.paywallOpen) return 'skip';
        const node = byTestId(renderer, 'paywall-restore');
        if (!node || node.props.disabled === true) return 'skip';
        model.purchaseOriginMount = model.paywallMount;
        await tap(node);
        return `mount=${model.paywallMount}`;
      }
      case 'retry': {
        if (!renderer || !model.paywallOpen) return 'skip';
        const node = byTestId(renderer, 'paywall-retry');
        if (!(await tap(node))) return 'skip';
        return undefined;
      }
      case 'selectMonthly': {
        if (!renderer || !model.paywallOpen) return 'skip';
        const node = byTestId(renderer, 'paywall-plan-monthly');
        if (!(await tap(node))) return 'skip';
        return undefined;
      }
      case 'openDrills': {
        if (!renderer || model.paywallOpen || model.drillsOpen) return 'skip';
        await tap(byTestId(renderer, 'home-open-drills'));
        model.drillsOpen = true;
        return undefined;
      }
      case 'drillsBack': {
        if (!renderer || !model.drillsOpen || model.paywallOpen) return 'skip';
        await tap(byTestId(renderer, 'drills-back'));
        model.drillsOpen = false;
        return undefined;
      }
      case 'settleOne': {
        if (world.ops.length === 0) return 'skip';
        const op = world.ops[Math.floor(random() * world.ops.length)]!;
        const outcome = outcomeFor(op);
        await settleOp(op, outcome);
        return `${op.kind}#${op.id}(${op.account}/e${op.epoch})→${outcome}`;
      }
      case 'settleAll': {
        if (world.ops.length === 0) return 'skip';
        const details: string[] = [];
        while (world.ops.length > 0) {
          const op = world.ops[0]!;
          const outcome = outcomeFor(op);
          await settleOp(op, outcome);
          details.push(`${op.kind}#${op.id}→${outcome}`);
        }
        return details.join(',');
      }
      case 'background': {
        if (model.appState === 'background') return 'skip';
        model.appState = 'background';
        await act(async () => {
          for (const listener of [...inst.appStateListeners])
            listener('background');
        });
        await flush();
        return undefined;
      }
      case 'foreground': {
        if (model.appState === 'active') return 'skip';
        model.appState = 'active';
        await act(async () => {
          for (const listener of [...inst.appStateListeners])
            listener('active');
        });
        await flush();
        return undefined;
      }
      case 'rotateToken': {
        if (!world.current) return 'skip';
        const session = getApiSession();
        if (!session) return 'skip';
        const token = issueToken(world.current);
        await act(async () => {
          establishApiSession({ ...session, bearerToken: token });
        });
        await flush();
        return `pending=${world.ops.length}`;
      }
      case 'switchAccount': {
        const next: 'A' | 'B' = world.current === 'A' ? 'B' : 'A';
        const pending = world.ops.length;
        await act(async () => {
          signOut();
        });
        // Signed-out store must carry no account data. A still-mounted
        // paywall legitimately re-runs initialize() against the cleared
        // configuration (status 'unconfigured'), exactly as production does
        // until the App gate swaps to the sign-in screen.
        const snapshot = dataSnapshot();
        if (
          snapshot.plans !== null ||
          snapshot.canonicalAccess !== null ||
          snapshot.operation !== 'idle' ||
          (snapshot.status !== 'idle' && snapshot.status !== 'unconfigured')
        ) {
          throw new InvariantViolation(
            'I2',
            `store not reset on sign-out: ${JSON.stringify(snapshot)}`,
          );
        }
        await unmountNavigator();
        await act(async () => {
          signIn(next);
        });
        await mountNavigator();
        await flush();
        return `→${next} pendingBefore=${pending}`;
      }
      case 'killRelaunch': {
        if (!world.current) return 'skip';
        const account = world.current;
        const pending = world.ops.length;
        await unmountNavigator();
        await act(async () => {
          signOut();
        });
        // Relaunch: hydrate() re-installs the session for the same account.
        await act(async () => {
          signIn(account);
        });
        const once = JSON.stringify(dataSnapshot());
        // I6: hydrating twice (e.g. hydrate + refresh landing) is idempotent.
        await act(async () => {
          signIn(account);
        });
        const twice = JSON.stringify(dataSnapshot());
        if (once !== twice) {
          throw new InvariantViolation(
            'I6',
            `re-hydrate not idempotent: ${once} vs ${twice}`,
          );
        }
        await mountNavigator();
        await flush();
        return `${account} pendingBefore=${pending}`;
      }
      case 'revokeLater': {
        if (!world.current) return 'skip';
        const owner = world.accounts[world.current];
        if (!owner.serverPremium || owner.revoked) return 'skip';
        owner.revoked = true;
        // Revocation reaches the client only through the next server read;
        // the snapshot it holds until then is still the last verified word.
        return 'revoked';
      }
      case 'unmountNavigator': {
        if (!renderer) return 'skip';
        await unmountNavigator();
        return `pending=${world.ops.length}`;
      }
      case 'remountNavigator': {
        if (renderer) return 'skip';
        if (!world.current) return 'skip';
        await mountNavigator();
        await flush();
        return undefined;
      }
      case 'refreshFromSettings': {
        // SettingsScreen useFocusEffect → refreshAccess() (skipped while loading).
        const state = useAccessStore.getState();
        if (!world.current || state.status === 'loading') return 'skip';
        await act(async () => {
          void state.refreshAccess();
        });
        await flush();
        return undefined;
      }
      case 'flush': {
        await flush();
        return undefined;
      }
    }
  };

  // ── Schedule ──
  let error: string | null = null;
  let failingStep: number | null = null;
  try {
    await act(async () => {
      signIn('A');
    });
    await mountNavigator();
    await flush();
    checkInvariants('flush');

    for (let step = 0; step < stepCount; step += 1) {
      const choices = ACTION_WEIGHTS.filter(([action]) => applicable(action));
      const action = pick(random, choices);
      let detail: string | undefined;
      try {
        detail = await perform(action);
        if (detail !== 'skip' && !detail?.startsWith('skip:')) {
          actionsExecuted[action] = (actionsExecuted[action] ?? 0) + 1;
        }
        checkInvariants(action);
      } catch (cause) {
        failingStep = step;
        throw cause;
      } finally {
        const state = useAccessStore.getState();
        trace.push({
          step,
          action,
          ...(detail !== undefined ? { detail } : {}),
          visible: visibleSummary(),
          status: state.status,
          operation: state.operation,
          premium: state.canonicalAccess?.premium === true,
        });
      }
    }

    // Drain: everything pending settles as the seed dictates, then the store
    // must be quiescent and the screen consistent.
    if (!renderer && world.current) await mountNavigator();
    while (world.ops.length > 0) {
      const op = world.ops[0]!;
      await settleOp(op, outcomeFor(op));
    }
    await flush();
    checkInvariants('flush');
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    if (failingStep === null) failingStep = trace.length;
  }

  // Revocation must surface on the next access read: verified explicitly.
  if (error === null && world.current) {
    const owner = world.accounts[world.current];
    if (owner.revoked) {
      const state = useAccessStore.getState();
      await act(async () => {
        void state.refreshAccess();
      });
      await flush();
      const op = world.ops.find(
        candidate => candidate.kind === 'GET /v1/me/access',
      );
      if (op) await settleOp(op, 'ok');
      await flush();
      if (useAccessStore.getState().canonicalAccess?.premium === true) {
        error = 'I1: premium still shown after revocation reached the client';
        failingStep = trace.length;
      }
    }
  }

  // Teardown: unmount, settle animations, and account for leaks (I7).
  try {
    await unmountNavigator();
    await settleAnimations();
    if (inst.backSubscriptions.size !== 0) {
      throw new InvariantViolation(
        'I7',
        `${inst.backSubscriptions.size} hardwareBackPress subscription(s) leaked after unmount`,
      );
    }
    if (inst.appStateListeners.size !== 0) {
      throw new InvariantViolation(
        'I7',
        `${inst.appStateListeners.size} AppState listener(s) leaked after unmount`,
      );
    }
  } catch (cause) {
    if (error === null) {
      error = cause instanceof Error ? cause.message : String(cause);
      failingStep = trace.length;
    }
  } finally {
    // Reject anything still in flight so no promise outlives the scenario.
    for (const op of [...world.ops]) op.settle('networkError');
    await flush();
    setApiUnauthorizedListener(null);
    signOut();
    world.rcConfigured = false;
    world.rcAppUserId = null;
  }

  if (error === null && consoleErrors.length > 0) {
    error = `I8: ${consoleErrors.join(' || ')}`;
    failingStep = trace.length;
  }

  return {
    seed,
    outcome: error === null ? 'HELD' : 'BROKEN',
    steps: trace.length,
    requests: world.requests.length,
    settled: world.nextOpId - 1 - world.ops.length,
    actionsExecuted,
    error,
    failingStep,
    trace,
    consoleErrors: [...consoleErrors],
    durationMs: Date.now() - startedAt,
  };
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const results: ScenarioResult[] = [];
const seeds = campaignSeeds();

describe(`PaywallScreen lifecycle interruption stress (${seeds.length} seeded interleavings)`, () => {
  let inst: Instrumentation;
  const consoleErrors: string[] = [];
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeAll(() => {
    inst = instrumentNativeModules();
    const capture =
      (level: string) =>
      (...args: unknown[]) => {
        consoleErrors.push(
          `${level}: ${args
            .map(arg =>
              arg instanceof Error
                ? arg.message
                : typeof arg === 'string'
                  ? arg
                  : JSON.stringify(arg),
            )
            .join(' ')
            .slice(0, 400)}`,
        );
      };
    errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(capture('error'));
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(capture('warn'));
  });

  afterAll(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    inst.restore();
    const dir = evidenceDir();
    fs.mkdirSync(dir, { recursive: true });
    const held = results.filter(r => r.outcome === 'HELD').length;
    const summary = {
      runId: RUN_ID,
      iterations: results.length,
      held,
      broken: results.length - held,
      totalSteps: results.reduce((sum, r) => sum + r.steps, 0),
      totalRequests: results.reduce((sum, r) => sum + r.requests, 0),
      totalSettled: results.reduce((sum, r) => sum + r.settled, 0),
      failingSeeds: results
        .filter(r => r.outcome === 'BROKEN')
        .map(r => ({ seed: r.seed, step: r.failingStep, error: r.error })),
      seeds: results.map(r => ({
        seed: r.seed,
        outcome: r.outcome,
        steps: r.steps,
        requests: r.requests,
        settled: r.settled,
        durationMs: r.durationMs,
        error: r.error,
        failingStep: r.failingStep,
        actions: r.actionsExecuted,
      })),
    };
    fs.writeFileSync(
      path.join(dir, 'results.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'traces.ndjson'),
      results.map(r => JSON.stringify(r)).join('\n') + '\n',
    );
  });

  beforeEach(() => {
    consoleErrors.length = 0;
    inst.backSubscriptions.clear();
    inst.appStateListeners.clear();
  });

  it.each(seeds.map(seed => [seed] as [number]))(
    'seed %d holds every lifecycle invariant',
    async seed => {
      const result = await runScenario(seed, inst, consoleErrors);
      results.push(result);
      if (result.outcome === 'BROKEN') {
        const failing =
          result.trace[result.failingStep ?? result.trace.length - 1];
        throw new Error(
          `seed ${seed} BROKEN at step ${result.failingStep}: ${result.error}\n` +
            `failing step: ${JSON.stringify(failing)}\n` +
            `trace: ${result.trace
              .map(
                t =>
                  `${t.step}:${t.action}${t.detail ? `[${t.detail}]` : ''}→${t.visible}/${t.status}/${t.operation}${t.premium ? '/premium' : ''}`,
              )
              .join(' | ')}`,
        );
      }
    },
  );
});
