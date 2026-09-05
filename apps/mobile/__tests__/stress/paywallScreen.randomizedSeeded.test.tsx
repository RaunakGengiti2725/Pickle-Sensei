/**
 * PaywallScreen — seeded randomized long-run stress (lens: randomized-seeded).
 *
 * The paywall is rendered THROUGH the production `RootNavigator` (real
 * `NavigationContainer`, real native-stack, real `PaywallRoute` wiring of
 * close/purchase → `navigation.goBack()`), on top of the real zustand
 * `accessStore`, the real RevenueCat billing client and the real canonical
 * access API client. Only native modules (RevenueCat SDK object, gradient,
 * svg, safe-area, reanimated, notifications, Linking, BackHandler) and `fetch`
 * are faked. Sibling screens that RootNavigator merely registers are stubbed,
 * exactly as `__tests__/wf/RootNavigator.buttons.test.tsx` does.
 *
 * Every sequence is generated from a recorded 32-bit seed (mulberry32). The
 * generator picks legal actions from what is currently ON SCREEN (pressing a
 * visible, enabled control; settling one in-flight SDK/backend call with a
 * seeded outcome; re-opening the paywall after it was dismissed) plus
 * near-legal ones (synchronous double taps, hardware back on the value page,
 * sign-out/sign-in reconfiguration mid-flight, app restart). After EVERY step
 * the model invariants below are checked against the rendered tree, the store
 * and the navigation state.
 *
 * Invariants (from AGENTS.md "Billing", PaywallScreen.tsx and accessStore.ts):
 *   I1  price provenance — every "$" amount on screen is a store-returned
 *       priceString / pricePerMonthString (never an estimate).
 *   I2  busy gating — while store.operation !== 'idle' Continue, Restore and
 *       Retry are disabled and exactly the matching button shows a spinner.
 *   I3  Continue is enabled ⇔ a selected plan exists AND canonicalAccess is
 *       non-null (fail closed) AND no operation is in flight.
 *   I4  plans !== null ⇒ selectedPeriod resolves to an existing plan; exactly
 *       one podium column reports selected; the CTA carries its priceString.
 *   I5  exactly one page is rendered (value | pricing | verified) and the
 *       chrome matches it (back button + "Step 2 of 2" only on pricing).
 *   I6  the verified page is shown ⇔ canonicalAccess.premium, and the store's
 *       canonicalAccess only ever equals a payload the fake backend returned
 *       (store-local entitlement never unlocks access).
 *   I7  error card ⇔ store.error, showing exactly store.error.message.
 *   I8  hardware-back subscription count == 1 exactly while PaywallScreen's
 *       internal page is 'pricing' (the verified page renders over that
 *       state without resetting it), else 0.
 *   I9  single flight — never more than one purchase/restore SDK call in
 *       flight; purchasePackage receives the package of the selected plan.
 *   I10 the paywall is dismissed via onPurchased only after a backend sync
 *       returned premium:true.
 *   I11 navigation — the two routes under the paywall are never popped by any
 *       paywall action (stale goBack after close must not pop a sibling).
 *   I12 liveness — with no pending SDK/backend call the store is quiescent
 *       (operation idle, status not loading).
 *   I13 no console.error / console.warn during a sequence.
 *   I14 copy — no Android / Google Play / guest mode / Live Court / DUPR /
 *       competitor / accuracy-% strings (APP_STORE_SUBMISSION.md §0).
 *
 * Run:
 *   npx jest --ci --silent __tests__/stress/paywallScreen.randomizedSeeded.test.tsx
 *   STRESS_ITER=2000 STRESS_OUT=/tmp/paywall-stress.json npx jest --ci ...
 *   STRESS_SEED=1234 npx jest --ci ...    (replays one seed, full trace)
 *   STRESS_SEED=1234 STRESS_ACTIONS='[{"type":"press","target":"close","taps":2}]'
 *       replays a concrete (e.g. minimized) action list on that seed's env
 *   STRESS_SEED_BASE=100000                (shift the seed window)
 *   STRESS_EXCLUDE=press:close x2,settle-while-busy,close-while-busy
 *       drop generator moves whose failure is already recorded, so a
 *       second campaign can look past known findings (documented in the
 *       JSON table under `exclude`).
 *   STRESS_MINIMIZE_PER_SIG=5              (failing seeds ddmin'd + replayed
 *       10x per failure class; every failing seed is still in the table)
 *
 * Campaign of 2026-09-05 (seeds 1..2000, 4 shards of 500, ~6 min each):
 *   I11 x1003 (`press:close x2` → the stale second goBack pops the route under
 *   the paywall; also `press:close` while a purchase is in flight → the late
 *   onPurchased goBack pops it) and I9 x54 (Continue/Restore while the first
 *   restore is still in flight after initialize() reset operation to idle).
 *   Determinism 480/480 identical; 40 minimized seeds replay 10/10.
 */
import fs from 'fs';
import React from 'react';
import { BackHandler, Linking, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { NavigationContainerRef } from '@react-navigation/native';
import type {
  BillingFetch,
  CanonicalAccessState,
  RevenueCatCustomerInfoLike,
  RevenueCatPackageLike,
  RevenueCatSdk,
} from '../../src/billing';
import { createBillingAccessDependencies } from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { BrandSpinner } from '../../src/design/components';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import type { RootStackParams } from '../../src/navigation/params';

// ─── Native module fakes (same boundary as the existing paywall suites) ──────

jest.mock('react-native-linear-gradient', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
// The library's own Jest mock keeps the contexts React Navigation reads.
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
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
jest.mock('react-native-reanimated', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const AnimatedView = (props: Record<string, unknown>) =>
    ReactLib.createElement(View, props);
  return {
    __esModule: true,
    default: {
      View: AnimatedView,
      createAnimatedComponent:
        (Component: React.ComponentType<Record<string, unknown>>) =>
        (props: Record<string, unknown>) =>
          ReactLib.createElement(Component, props),
    },
    Easing: {
      out: (fn: unknown) => fn,
      cubic: () => 0,
    },
    interpolate: () => 0,
    useAnimatedStyle: (updater: () => object) => updater(),
    useSharedValue: (init: unknown) => ({ value: init }),
    withTiming: (toValue: unknown) => toValue,
  };
});
jest.mock('../../src/notifications/service', () => ({
  __esModule: true,
  subscribeToNotificationPresses: () => () => undefined,
}));
// Plain zustand double: RootNavigator/PremiumTabBar only read `session`.
jest.mock('../../src/auth/authStore', () => {
  const { create } = require('zustand');
  const useAuthStore = create(() => ({
    hydrated: true,
    session: null,
    busy: false,
    error: null,
    signInWithApple: async () => undefined,
    signInWithGoogle: async () => undefined,
    clearError: () => undefined,
  }));
  return { __esModule: true, useAuthStore };
});

// The REAL navigation library, with two seams the harness needs: the
// container starts on Tabs → DrillLibrary → Paywall (the stack a user has
// when the rating gate opens the paywall over a sub-page), and the module's
// private `navigationRef` is exposed so a dismissed paywall can be reopened.
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  const ReactLib = require('react');
  const seam: {
    ref: unknown;
    initialState: unknown;
    onStateChange: ((state: unknown) => void) | null;
  } = { ref: null, initialState: undefined, onStateChange: null };
  const NavigationContainer = ReactLib.forwardRef(
    (props: Record<string, unknown>, ref: unknown) =>
      ReactLib.createElement(actual.NavigationContainer, {
        ...props,
        ref,
        initialState: seam.initialState,
        onStateChange: (state: unknown) => seam.onStateChange?.(state),
      }),
  );
  return {
    ...actual,
    NavigationContainer,
    createNavigationContainerRef: () => {
      const ref = actual.createNavigationContainerRef();
      seam.ref = ref;
      return ref;
    },
    __stressSeam: seam,
  };
});

// Screens RootNavigator registers but this unit never drives.
jest.mock('../../src/screens/HomeScreen', () => ({ HomeScreen: () => null }));
jest.mock('../../src/screens/LibraryScreen', () => ({
  LibraryScreen: () => null,
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: () => null,
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: () => null,
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => {
  const ReactLib = require('react');
  const { Text: RNText } = require('react-native');
  return {
    DrillLibraryScreen: () =>
      ReactLib.createElement(
        RNText,
        { testID: 'drill-library-stub' },
        'Drill Library stub',
      ),
  };
});
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
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: () => null,
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: () => null,
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: () => null,
}));
jest.mock('../../src/screens/AnalyzeScreen', () => ({
  AnalyzeScreen: () => null,
}));
jest.mock('../../src/screens/SignInScreen', () => ({
  SignInScreen: () => null,
}));

interface NavSeam {
  ref: NavigationContainerRef<RootStackParams> | null;
  initialState: unknown;
  onStateChange: ((state: unknown) => void) | null;
}
const navSeam = (
  jest.requireMock('@react-navigation/native') as { __stressSeam: NavSeam }
).__stressSeam;

// ─── Campaign configuration ──────────────────────────────────────────────────

const ITER = Number(process.env.STRESS_ITER ?? 24);
const SEED_BASE = Number(process.env.STRESS_SEED_BASE ?? 1);
const SINGLE_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number(process.env.STRESS_SEED)
    : null;
const OUT_PATH = process.env.STRESS_OUT ?? null;
const REPLAY_ACTIONS: Action[] | null = process.env.STRESS_ACTIONS
  ? (JSON.parse(process.env.STRESS_ACTIONS) as Action[])
  : null;
const MIN_LEN = 5;
const MAX_LEN = 60;
const CHUNK = 50;
const DETERMINISM_EVERY = 25;
const EXCLUDE = new Set(
  (process.env.STRESS_EXCLUDE ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
);

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

class Rng {
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
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  weighted<T extends string>(table: ReadonlyArray<readonly [T, number]>): T {
    const total = table.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [value, weight] of table) {
      roll -= weight;
      if (roll < 0) return value;
    }
    const last = table[table.length - 1];
    if (!last) throw new Error('weighted from empty table');
    return last[0];
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CANONICAL_USER_ID = '2f1c6c2e-9b7a-4c1e-8f3d-1a2b3c4d5e6f';
const API_BASE_URL = 'https://api.example.test/functions/v1/api';
const PUBLIC_SDK_KEY = 'appl_test_public_key';
const BEARER = 'supabase-access-token';

type Period = 'ANNUAL' | 'MONTHLY' | 'LIFETIME';
type Entitlement = 'pickle_sensei_pro' | 'premium';

const PRICING: Record<
  Period,
  { price: number; priceString: string; perMonth: string | null }
> = {
  ANNUAL: { price: 59.99, priceString: '$59.99', perMonth: '$5.00' },
  MONTHLY: { price: 7.99, priceString: '$7.99', perMonth: '$7.99' },
  LIFETIME: { price: 159.99, priceString: '$159.99', perMonth: null },
};

function storePackage(period: Period, trial: boolean): RevenueCatPackageLike {
  const ids = {
    ANNUAL: { pkg: '$rc_annual', product: 'pickle_sensei_pro_annual' },
    MONTHLY: { pkg: '$rc_monthly', product: 'pickle_sensei_pro_monthly' },
    LIFETIME: { pkg: '$rc_lifetime', product: 'pickle_sensei_pro_lifetime' },
  }[period];
  const pricing = PRICING[period];
  return {
    identifier: ids.pkg,
    packageType: period,
    product: {
      identifier: ids.product,
      price: pricing.price,
      priceString: pricing.priceString,
      pricePerMonthString: pricing.perMonth,
      introPrice: trial ? { price: 0, cycles: 1, period: 'P7D' } : null,
      defaultOption: null,
    },
  };
}

function customerInfo(
  premium: boolean,
  entitlement: Entitlement,
): RevenueCatCustomerInfoLike {
  return {
    entitlements: {
      active: premium
        ? {
            [entitlement]: {
              productIdentifier: 'pickle_sensei_pro_annual',
              expirationDate: null,
            },
          }
        : {},
    },
  };
}

function accessPayload(premium: boolean, used: number): CanonicalAccessState {
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

// ─── Environment: deferred SDK + backend, every call settled by the sequence ─

type CallKind = 'offerings' | 'purchase' | 'restore' | 'access' | 'sync';

interface PendingCall {
  id: number;
  kind: CallKind;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  /** Package handed to purchasePackage, for I9. */
  packageId?: string;
}

interface EnvConfig {
  sdkKey: string | null;
  entitlement: Entitlement;
  trialEligible: boolean;
  offering:
    'full' | 'no-monthly' | 'no-lifetime' | 'no-annual' | 'only-monthly';
}

class Env {
  readonly pending: PendingCall[] = [];
  readonly sdkCalls: string[] = [];
  readonly backendCalls: string[] = [];
  /** Every access payload the fake backend has actually returned (I6). */
  readonly servedAccess: CanonicalAccessState[] = [];
  /** Sync payloads that returned premium:true (I10). */
  syncPremiumCount = 0;
  inFlightStoreOps = 0;
  maxInFlightStoreOps = 0;
  private nextId = 1;

  constructor(readonly config: EnvConfig) {}

  private defer<T>(kind: CallKind, extra?: Partial<PendingCall>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        id: this.nextId++,
        kind,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...extra,
      });
    });
  }

  readonly sdk: RevenueCatSdk = {
    isConfigured: async () => false,
    configure: async () => undefined,
    getAppUserID: async () => CANONICAL_USER_ID,
    logIn: async () => undefined,
    getOfferings: () => {
      this.sdkCalls.push('getOfferings');
      return this.defer('offerings');
    },
    purchasePackage: aPackage => {
      this.sdkCalls.push(`purchasePackage:${aPackage.identifier}`);
      this.inFlightStoreOps += 1;
      this.maxInFlightStoreOps = Math.max(
        this.maxInFlightStoreOps,
        this.inFlightStoreOps,
      );
      return this.defer('purchase', { packageId: aPackage.identifier });
    },
    restorePurchases: () => {
      this.sdkCalls.push('restorePurchases');
      this.inFlightStoreOps += 1;
      this.maxInFlightStoreOps = Math.max(
        this.maxInFlightStoreOps,
        this.inFlightStoreOps,
      );
      return this.defer('restore');
    },
    getCustomerInfo: async () => customerInfo(false, this.config.entitlement),
    checkTrialOrIntroductoryPriceEligibility: async ids => {
      const status = this.config.trialEligible ? 2 : 0;
      return Object.fromEntries(ids.map(id => [id, { status }]));
    },
  };

  readonly fetchFn: BillingFetch = (input, init) => {
    const method = init?.method ?? 'GET';
    const path = input.replace(API_BASE_URL, '');
    this.backendCalls.push(`${method} ${path}`);
    if (method === 'GET' && path === '/v1/me/access')
      return this.defer('access');
    if (method === 'POST' && path === '/v1/billing/sync')
      return this.defer('sync');
    return Promise.reject(new Error(`unexpected request ${method} ${path}`));
  };

  offerings() {
    const trial = this.config.trialEligible;
    const o = this.config.offering;
    return {
      identifier: 'default',
      annual:
        o === 'no-annual' || o === 'only-monthly'
          ? null
          : storePackage('ANNUAL', trial),
      monthly: o === 'no-monthly' ? null : storePackage('MONTHLY', false),
      lifetime:
        o === 'no-lifetime' || o === 'only-monthly'
          ? null
          : storePackage('LIFETIME', false),
    };
  }

  response(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }

  /** Settles the oldest pending call of `kind` with a concrete outcome. */
  settle(kind: CallKind, outcome: string): boolean {
    const index = this.pending.findIndex(call => call.kind === kind);
    if (index === -1) return false;
    const [call] = this.pending.splice(index, 1);
    if (!call) return false;
    const entitlement = this.config.entitlement;
    switch (kind) {
      case 'offerings':
        if (outcome === 'none') call.resolve({ current: null });
        else if (outcome === 'reject') call.reject(new Error('network'));
        else call.resolve({ current: this.offerings() });
        return true;
      case 'purchase':
        this.inFlightStoreOps -= 1;
        if (outcome === 'cancel')
          call.reject({ userCancelled: true, code: '1' });
        else if (outcome === 'fail') call.reject(new Error('SKErrorDomain 2'));
        else if (outcome === 'no-entitlement')
          call.resolve({ customerInfo: customerInfo(false, entitlement) });
        else call.resolve({ customerInfo: customerInfo(true, entitlement) });
        return true;
      case 'restore':
        this.inFlightStoreOps -= 1;
        if (outcome === 'fail') call.reject(new Error('restore failed'));
        else if (outcome === 'no-entitlement')
          call.resolve(customerInfo(false, entitlement));
        else call.resolve(customerInfo(true, entitlement));
        return true;
      case 'access': {
        if (outcome === 'network') {
          call.reject(new Error('offline'));
        } else if (outcome === '500') {
          call.resolve(this.response(503, { error: 'unavailable' }));
        } else if (outcome === '401') {
          call.resolve(this.response(401, { error: 'unauthorized' }));
        } else {
          const payload =
            outcome === 'premium'
              ? accessPayload(true, 2)
              : outcome === 'one-left'
                ? accessPayload(false, 1)
                : accessPayload(false, 2);
          this.servedAccess.push(payload);
          call.resolve(this.response(200, payload));
        }
        return true;
      }
      case 'sync': {
        if (outcome === '500') {
          call.resolve(this.response(500, { error: 'boom' }));
        } else if (outcome === 'network') {
          call.reject(new Error('offline'));
        } else if (outcome === 'mismatch') {
          // billing says premium, access says not: the client must reject it.
          call.resolve(
            this.response(200, {
              billing: {
                premium: true,
                productKey: 'pickle_sensei_pro_annual',
                expiresAt: null,
                verifiedAt: '2026-09-01T00:00:00.000Z',
              },
              access: accessPayload(false, 2),
            }),
          );
        } else {
          const premium = outcome === 'premium';
          const access = accessPayload(premium, 2);
          this.servedAccess.push(access);
          if (premium) this.syncPremiumCount += 1;
          call.resolve(
            this.response(200, {
              billing: {
                premium,
                productKey: premium ? 'pickle_sensei_pro_annual' : null,
                expiresAt: null,
                verifiedAt: '2026-09-01T00:00:00.000Z',
              },
              access,
            }),
          );
        }
        return true;
      }
    }
  }
}

const OUTCOMES: Record<CallKind, ReadonlyArray<readonly [string, number]>> = {
  offerings: [
    ['ok', 82],
    ['none', 8],
    ['reject', 10],
  ],
  purchase: [
    ['premium', 60],
    ['cancel', 18],
    ['fail', 14],
    ['no-entitlement', 8],
  ],
  restore: [
    ['premium', 50],
    ['no-entitlement', 35],
    ['fail', 15],
  ],
  access: [
    ['free', 52],
    ['one-left', 16],
    ['premium', 8],
    ['500', 12],
    ['network', 6],
    ['401', 6],
  ],
  sync: [
    ['premium', 66],
    ['not-premium', 14],
    ['500', 10],
    ['network', 5],
    ['mismatch', 5],
  ],
};

// ─── Concrete actions (fully specified → replayable and minimizable) ─────────

type Action =
  | { type: 'press'; target: string; taps: 1 | 2 }
  | { type: 'hardware-back' }
  | { type: 'settle'; kind: CallKind; outcome: string }
  | { type: 'settle-all' }
  | { type: 'flush' }
  | { type: 'reopen' }
  | { type: 'reconfigure' }
  | { type: 'sign-out' }
  | { type: 'restart' };

function describeAction(action: Action): string {
  switch (action.type) {
    case 'press':
      return `press:${action.target}${action.taps === 2 ? ' x2' : ''}`;
    case 'settle':
      return `settle:${action.kind}=${action.outcome}`;
    default:
      return action.type;
  }
}

// ─── Reading the rendered tree ───────────────────────────────────────────────

interface Control {
  present: boolean;
  disabled: boolean;
  spinners: number;
  label: string | null;
  selected: boolean | null;
}

interface UiSnapshot {
  page: 'value' | 'pricing' | 'verified' | 'none' | 'ambiguous';
  routes: string[];
  controls: Record<string, Control>;
  stepDots: string | null;
  errorText: string | null;
  errorHint: string | null;
  text: string;
  dollarTokens: string[];
}

const CONTROLS: Record<string, { testID?: string; label?: string }> = {
  'see-plans': { testID: 'paywall-see-plans' },
  back: { testID: 'paywall-back' },
  continue: { testID: 'paywall-continue' },
  restore: { testID: 'paywall-restore' },
  retry: { testID: 'paywall-retry' },
  'plan-annual': { testID: 'paywall-plan-annual' },
  'plan-monthly': { testID: 'paywall-plan-monthly' },
  'plan-lifetime': { testID: 'paywall-plan-lifetime' },
  close: { label: 'Close membership offer' },
  'close-verified': { label: 'Close membership' },
  'continue-coaching': { label: 'Continue coaching' },
  'dismiss-error': { label: 'Dismiss membership message' },
  terms: { label: 'Terms of use' },
  privacy: { label: 'Privacy policy' },
};

type Instance = TestRenderer.ReactTestInstance;

function findPressable(
  renderer: TestRenderer.ReactTestRenderer,
  key: string,
): Instance | null {
  const spec = CONTROLS[key];
  if (!spec) throw new Error(`unknown control ${key}`);
  const nodes = renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      (spec.testID
        ? n.props.testID === spec.testID
        : n.props.accessibilityLabel === spec.label),
  );
  // PressableScale → Pressable → host View all carry the same props; the
  // outermost composite is the one whose `disabled` mirrors the prop.
  return nodes[0] ?? null;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' | ');
}

function readUi(
  renderer: TestRenderer.ReactTestRenderer | null,
  routes: string[],
): UiSnapshot {
  if (!renderer) {
    return {
      page: 'none',
      routes,
      controls: {},
      stepDots: null,
      errorText: null,
      errorHint: null,
      text: '',
      dollarTokens: [],
    };
  }
  const controls: Record<string, Control> = {};
  for (const key of Object.keys(CONTROLS)) {
    const node = findPressable(renderer, key);
    controls[key] = node
      ? {
          present: true,
          disabled: node.props.disabled === true,
          spinners: node.findAllByType(BrandSpinner).length,
          label:
            typeof node.props.accessibilityLabel === 'string'
              ? node.props.accessibilityLabel
              : null,
          selected:
            node.props.accessibilityState &&
            typeof node.props.accessibilityState.selected === 'boolean'
              ? node.props.accessibilityState.selected
              : null,
        }
      : {
          present: false,
          disabled: false,
          spinners: 0,
          label: null,
          selected: null,
        };
  }
  const text = allText(renderer);
  const hasValue = controls['see-plans']?.present === true;
  const hasPricing = controls.continue?.present === true;
  const hasVerified = text.includes('MEMBERSHIP VERIFIED');
  const pages = [hasValue, hasPricing, hasVerified].filter(Boolean).length;
  const page =
    pages > 1
      ? 'ambiguous'
      : hasValue
        ? 'value'
        : hasPricing
          ? 'pricing'
          : hasVerified
            ? 'verified'
            : 'none';
  const dots = renderer.root.findAll(
    n =>
      typeof n.props.accessibilityLabel === 'string' &&
      /^Step \d of 2$/.test(n.props.accessibilityLabel),
  );
  const errorNode = findPressable(renderer, 'dismiss-error');
  const errorText = errorNode
    ? errorNode
        .findAllByType(Text)
        .map(t => t.props.children)
        .flat()
        .filter((c): c is string => typeof c === 'string')
        .join('')
    : null;
  return {
    page,
    routes,
    controls,
    stepDots: dots[0]?.props.accessibilityLabel ?? null,
    errorText,
    errorHint: errorNode?.props.accessibilityHint ?? null,
    text,
    dollarTokens: text.match(/\$\d[\d,]*(?:\.\d+)?/g) ?? [],
  };
}

// ─── Model checking ──────────────────────────────────────────────────────────

const FORBIDDEN_COPY: ReadonlyArray<readonly [string, RegExp]> = [
  ['android', /android/i],
  ['google-play', /google play/i],
  ['guest-mode', /guest mode/i],
  ['live-court', /live court/i],
  ['dupr', /\bDUPR\b/],
  ['competitor', /swingvision|pb vision|selkirk|joola/i],
  ['accuracy-percent', /\d+\s*%\s*accura/i],
  ['ai-coach-equivalence', /ai coach/i],
];

interface Violation {
  invariant: string;
  detail: string;
}

interface StepRecord {
  step: number;
  action: string;
  ui: {
    page: UiSnapshot['page'];
    routes: string[];
    stepDots: string | null;
    controls: Record<string, string>;
    errorText: string | null;
    dollarTokens: string[];
  };
  store: {
    status: string;
    operation: string;
    selectedPeriod: string;
    plans: string | null;
    access: string | null;
    error: string | null;
  };
  env: { pending: string[]; sdkCalls: number; backendCalls: number };
  violations: Violation[];
}

function storeSnapshot(): StepRecord['store'] {
  const s = useAccessStore.getState();
  return {
    status: s.status,
    operation: s.operation,
    selectedPeriod: s.selectedPeriod,
    plans: s.plans
      ? ['annual', 'monthly', 'lifetime']
          .filter(p => s.plans?.[p as 'annual' | 'monthly' | 'lifetime'])
          .join(',')
      : null,
    access: s.canonicalAccess
      ? `${s.canonicalAccess.premium ? 'premium' : 'free'}:${
          s.canonicalAccess.freeRatings.remaining
        }`
      : null,
    error: s.error?.code ?? null,
  };
}

function compactControls(ui: UiSnapshot): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, c] of Object.entries(ui.controls)) {
    if (!c.present) continue;
    out[key] = `${c.disabled ? 'disabled' : 'enabled'}${
      c.spinners ? `+spinner${c.spinners}` : ''
    }${c.selected === true ? '+selected' : ''}`;
  }
  return out;
}

function checkInvariants(
  ui: UiSnapshot,
  env: Env,
  liveBackHandlers: number,
  consoleMessages: string[],
  quiescent: boolean,
  modelPage: 'value' | 'pricing',
): Violation[] {
  const v: Violation[] = [];
  const s = useAccessStore.getState();
  const paywallOnTop = ui.routes[ui.routes.length - 1] === 'Paywall';
  const c = ui.controls;
  const ctl = (k: string): Control =>
    c[k] ?? {
      present: false,
      disabled: false,
      spinners: 0,
      label: null,
      selected: null,
    };

  // I11 navigation
  if (ui.routes[0] !== 'Tabs' || ui.routes[1] !== 'DrillLibrary') {
    v.push({
      invariant: 'I11',
      detail: `routes under paywall changed: ${ui.routes.join('>')}`,
    });
  }
  if (ui.routes.length > 3 || (ui.routes.length === 3 && !paywallOnTop)) {
    v.push({
      invariant: 'I11',
      detail: `unexpected stack ${ui.routes.join('>')}`,
    });
  }
  const paywallRendered = ui.page !== 'none';
  if (paywallRendered !== paywallOnTop) {
    v.push({
      invariant: 'I11',
      detail: `paywall rendered=${paywallRendered} but route on top=${paywallOnTop} (page=${ui.page})`,
    });
  }

  // I5 exactly one page + matching chrome
  if (ui.page === 'ambiguous')
    v.push({ invariant: 'I5', detail: 'more than one page rendered' });
  if (paywallOnTop && ui.page !== 'verified') {
    const pricing = ui.page === 'pricing';
    if (ctl('back').present !== pricing)
      v.push({
        invariant: 'I5',
        detail: `back button present=${ctl('back').present} on ${ui.page}`,
      });
    if (ui.stepDots !== (pricing ? 'Step 2 of 2' : 'Step 1 of 2'))
      v.push({
        invariant: 'I5',
        detail: `step dots "${ui.stepDots}" on ${ui.page}`,
      });
    if (!ctl('close').present)
      v.push({ invariant: 'I5', detail: 'close button missing' });
  }

  // I6 verified page ⇔ premium; access only ever a served payload
  const premium = s.canonicalAccess?.premium === true;
  if (paywallOnTop && (ui.page === 'verified') !== premium) {
    v.push({
      invariant: 'I6',
      detail: `verified page=${ui.page === 'verified'} premium=${premium}`,
    });
  }
  if (
    s.canonicalAccess &&
    !env.servedAccess.some(
      served => JSON.stringify(served) === JSON.stringify(s.canonicalAccess),
    )
  ) {
    v.push({
      invariant: 'I6',
      detail: 'canonicalAccess is not a payload the backend returned',
    });
  }
  if (ui.page === 'verified' && ui.dollarTokens.length > 0) {
    v.push({
      invariant: 'I6',
      detail: `price on verified page: ${ui.dollarTokens.join(',')}`,
    });
  }

  // I1 price provenance
  const allowed = new Set<string>();
  for (const p of [s.plans?.annual, s.plans?.monthly, s.plans?.lifetime]) {
    if (!p) continue;
    allowed.add(p.priceString);
    if (p.pricePerMonthString) allowed.add(p.pricePerMonthString);
  }
  for (const token of ui.dollarTokens) {
    if (!allowed.has(token))
      v.push({
        invariant: 'I1',
        detail: `"${token}" is not a store-returned price`,
      });
  }

  if (ui.page === 'pricing') {
    const busy = s.operation !== 'idle';
    const selectedPlan = s.plans
      ? s.selectedPeriod === 'annual'
        ? s.plans.annual
        : s.selectedPeriod === 'lifetime'
          ? s.plans.lifetime
          : s.plans.monthly
      : null;
    const cont = ctl('continue');
    const restore = ctl('restore');
    const retry = ctl('retry');

    // I2 busy gating + spinner placement
    if (busy) {
      if (!cont.disabled)
        v.push({
          invariant: 'I2',
          detail: `Continue enabled while ${s.operation}`,
        });
      if (!restore.disabled)
        v.push({
          invariant: 'I2',
          detail: `Restore enabled while ${s.operation}`,
        });
      if (retry.present && !retry.disabled)
        v.push({
          invariant: 'I2',
          detail: `Retry enabled while ${s.operation}`,
        });
      const wantContinueSpinner =
        s.operation === 'purchasing' || s.operation === 'syncing';
      if (cont.spinners > 0 !== wantContinueSpinner)
        v.push({
          invariant: 'I2',
          detail: `Continue spinner=${cont.spinners} during ${s.operation}`,
        });
      if (restore.spinners > 0 !== (s.operation === 'restoring'))
        v.push({
          invariant: 'I2',
          detail: `Restore spinner=${restore.spinners} during ${s.operation}`,
        });
    } else {
      if (cont.spinners || restore.spinners)
        v.push({ invariant: 'I2', detail: 'spinner shown while idle' });
      if (restore.disabled)
        v.push({ invariant: 'I2', detail: 'Restore disabled while idle' });
    }

    // I3 Continue enablement rule
    const expectEnabled = Boolean(selectedPlan && s.canonicalAccess) && !busy;
    if (!cont.disabled !== expectEnabled) {
      v.push({
        invariant: 'I3',
        detail: `Continue enabled=${!cont.disabled}, expected ${expectEnabled} (plan=${Boolean(
          selectedPlan,
        )} access=${Boolean(s.canonicalAccess)} op=${s.operation})`,
      });
    }

    // I4 selection coherence
    if (s.plans) {
      if (!selectedPlan)
        v.push({
          invariant: 'I4',
          detail: `selectedPeriod=${s.selectedPeriod} has no plan`,
        });
      const selectedColumns = [
        'plan-annual',
        'plan-monthly',
        'plan-lifetime',
      ].filter(k => ctl(k).selected === true);
      if (selectedColumns.length !== 1)
        v.push({
          invariant: 'I4',
          detail: `selected columns: ${selectedColumns.join(',') || 'none'}`,
        });
      if (
        selectedColumns[0] &&
        selectedColumns[0] !== `plan-${s.selectedPeriod}`
      )
        v.push({
          invariant: 'I4',
          detail: `column ${selectedColumns[0]} selected for ${s.selectedPeriod}`,
        });
      if (selectedPlan && !busy && cont.label) {
        const expectedLabel = selectedPlan.freeTrial
          ? 'Start free trial'
          : `Continue · ${selectedPlan.priceString}`;
        if (!cont.label.startsWith(expectedLabel))
          v.push({
            invariant: 'I4',
            detail: `CTA "${cont.label}" for ${selectedPlan.priceString}`,
          });
      }
      for (const period of ['annual', 'monthly', 'lifetime'] as const) {
        if (Boolean(s.plans[period]) !== ctl(`plan-${period}`).present)
          v.push({
            invariant: 'I4',
            detail: `${period} column present=${ctl(`plan-${period}`).present}`,
          });
      }
    } else if (
      ['plan-annual', 'plan-monthly', 'plan-lifetime'].some(k => ctl(k).present)
    ) {
      v.push({
        invariant: 'I4',
        detail: 'plan columns rendered without store plans',
      });
    }

    // I7 error card
    if (Boolean(s.error) !== ctl('dismiss-error').present) {
      v.push({
        invariant: 'I7',
        detail: `error card present=${ctl('dismiss-error').present} store.error=${s.error?.code ?? null}`,
      });
    } else if (
      s.error &&
      (ui.errorText !== s.error.message || ui.errorHint !== s.error.message)
    ) {
      v.push({
        invariant: 'I7',
        detail: `error card "${ui.errorText}" != "${s.error.message}"`,
      });
    }

    // Retry visibility mirrors the screen's own rule (documented in the tsx).
    const showRetry =
      s.status !== 'loading' && (!s.plans || s.canonicalAccess === null);
    if (retry.present !== showRetry)
      v.push({
        invariant: 'I2',
        detail: `Retry present=${retry.present} expected ${showRetry}`,
      });
  }

  // I8 hardware back subscription follows the screen's internal page state
  if (
    paywallOnTop &&
    (ui.page === 'value' || ui.page === 'pricing') &&
    ui.page !== modelPage
  ) {
    v.push({
      invariant: 'I8',
      detail: `model page ${modelPage} but ${ui.page} rendered`,
    });
  }
  const expectHandlers = paywallOnTop && modelPage === 'pricing' ? 1 : 0;
  if (liveBackHandlers !== expectHandlers) {
    v.push({
      invariant: 'I8',
      detail: `${liveBackHandlers} hardwareBackPress handlers on ${ui.page} (internal page ${modelPage})`,
    });
  }

  // I9 single flight
  if (env.maxInFlightStoreOps > 1) {
    v.push({
      invariant: 'I9',
      detail: `${env.maxInFlightStoreOps} store purchase/restore calls in flight`,
    });
  }

  // I12 liveness at quiescence
  if (quiescent && env.pending.length === 0) {
    if (s.operation !== 'idle')
      v.push({ invariant: 'I12', detail: `operation stuck at ${s.operation}` });
    if (s.status === 'loading')
      v.push({ invariant: 'I12', detail: 'status stuck at loading' });
  }

  // I13 console
  for (const message of consoleMessages) {
    v.push({ invariant: 'I13', detail: message.slice(0, 300) });
  }

  // I14 copy
  for (const [name, pattern] of FORBIDDEN_COPY) {
    if (pattern.test(ui.text))
      v.push({ invariant: 'I14', detail: `forbidden copy: ${name}` });
  }
  return v;
}

// ─── Harness ─────────────────────────────────────────────────────────────────

interface SequenceResult {
  seed: number;
  length: number;
  mode: 'deferred' | 'auto';
  env: EnvConfig;
  outcome: 'ok' | 'violation' | 'exception';
  failedStep: number | null;
  violations: Violation[];
  error: string | null;
  actions: Action[];
  trace: StepRecord[];
  durationMs: number;
}

function envConfigFor(rng: Rng): EnvConfig {
  return {
    sdkKey: rng.chance(0.06) ? null : PUBLIC_SDK_KEY,
    entitlement: rng.chance(0.15) ? 'premium' : 'pickle_sensei_pro',
    trialEligible: rng.chance(0.55),
    offering: rng.weighted([
      ['full', 62],
      ['no-monthly', 10],
      ['no-lifetime', 10],
      ['no-annual', 10],
      ['only-monthly', 8],
    ] as const),
  };
}

class Harness {
  renderer: TestRenderer.ReactTestRenderer | null = null;
  routes: string[] = [];
  env: Env;
  /** PaywallScreen's internal value|pricing page (kept under the verified page). */
  modelPage: 'value' | 'pricing' = 'value';
  private backHandlers: Array<{
    handler: () => boolean | null | undefined;
    live: boolean;
  }> = [];
  consoleMessages: string[] = [];
  private restoreSpies: Array<() => void> = [];

  constructor(readonly config: EnvConfig) {
    this.env = new Env(config);
  }

  private wire(): void {
    configureAccessStore(
      createBillingAccessDependencies({
        revenueCatPublicSdkKey: this.config.sdkKey,
        canonicalAppUserId: CANONICAL_USER_ID,
        apiBaseUrl: API_BASE_URL,
        apiToken: BEARER,
        fetchFn: this.env.fetchFn,
        revenueCatSdk: this.env.sdk,
        platform: 'ios',
      }),
    );
  }

  async mount(): Promise<void> {
    navSeam.initialState = {
      index: 2,
      routes: [
        { name: 'Tabs' },
        { name: 'DrillLibrary' },
        { name: 'Paywall', params: { source: 'rating' } },
      ],
    };
    navSeam.onStateChange = state => {
      const typed = state as { routes: Array<{ name: string }> } | undefined;
      this.routes = typed ? typed.routes.map(r => r.name) : [];
    };
    this.routes = ['Tabs', 'DrillLibrary', 'Paywall'];
    await act(async () => {
      this.renderer = TestRenderer.create(<RootNavigator />);
    });
    await this.flush();
  }

  install(): void {
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        this.consoleMessages.push(
          `console.error: ${args.map(String).join(' ')}`,
        );
      });
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation((...args: unknown[]) => {
        this.consoleMessages.push(
          `console.warn: ${args.map(String).join(' ')}`,
        );
      });
    const backSpy = jest
      .spyOn(BackHandler, 'addEventListener')
      .mockImplementation((_event, handler) => {
        const entry = {
          handler: handler as () => boolean | null | undefined,
          live: true,
        };
        this.backHandlers.push(entry);
        return {
          remove: () => {
            entry.live = false;
          },
        };
      });
    const linkSpy = jest
      .spyOn(Linking, 'openURL')
      .mockImplementation(async () => undefined);
    this.restoreSpies = [
      () => errorSpy.mockRestore(),
      () => warnSpy.mockRestore(),
      () => backSpy.mockRestore(),
      () => linkSpy.mockRestore(),
    ];
    this.wire();
  }

  /**
   * PaywallScreen's own subscription only — NavigationContainer also holds a
   * hardwareBackPress listener for the whole lifetime of the navigator.
   */
  liveBackHandlers(): number {
    return this.backHandlers.filter(
      h => h.live && h.handler.toString().includes('transitionTo'),
    ).length;
  }

  async flush(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 3; i += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      jest.advanceTimersByTime(300);
      await new Promise<void>(resolve => setImmediate(resolve));
    });
  }

  /** Drains every pending call FIFO on the happy path (fast, reliable network). */
  async settleAll(): Promise<void> {
    let guard = 0;
    while (this.env.pending.length > 0 && guard < 12) {
      const call = this.env.pending[0];
      if (!call) break;
      const outcome =
        call.kind === 'access'
          ? 'free'
          : call.kind === 'offerings'
            ? 'ok'
            : 'premium';
      await act(async () => {
        this.env.settle(call.kind, outcome);
      });
      await this.flush();
      guard += 1;
    }
  }

  async apply(action: Action): Promise<void> {
    switch (action.type) {
      case 'press': {
        const node = this.renderer
          ? findPressable(this.renderer, action.target)
          : null;
        if (!node || node.props.disabled === true) return; // near-legal no-op
        await act(async () => {
          node.props.onPress();
          if (action.taps === 2) node.props.onPress();
        });
        await this.flush();
        return;
      }
      case 'hardware-back': {
        // Only the paywall is under test: back on a sibling screen is out of scope.
        const paywallOnTop = this.routes[this.routes.length - 1] === 'Paywall';
        if (!paywallOnTop) return;
        await act(async () => {
          for (let i = this.backHandlers.length - 1; i >= 0; i -= 1) {
            const entry = this.backHandlers[i];
            if (entry?.live && entry.handler() === true) break;
          }
        });
        this.modelPage = 'value';
        await this.flush();
        return;
      }
      case 'settle': {
        await act(async () => {
          this.env.settle(action.kind, action.outcome);
        });
        await this.flush();
        return;
      }
      case 'settle-all':
        await this.settleAll();
        return;
      case 'flush':
        await this.flush();
        return;
      case 'reopen': {
        const ref = navSeam.ref;
        if (
          !ref ||
          !ref.isReady() ||
          this.routes[this.routes.length - 1] === 'Paywall'
        )
          return;
        await act(async () => {
          ref.navigate('Paywall', { source: 'rating' });
        });
        await this.flush();
        return;
      }
      case 'reconfigure': {
        // Sign-in again: a fresh account → fresh dependencies, new version.
        await act(async () => {
          this.env = new Env(this.config);
          this.wire();
        });
        await this.flush();
        return;
      }
      case 'sign-out': {
        await act(async () => {
          clearAccessStoreConfiguration();
        });
        await this.flush();
        return;
      }
      case 'restart': {
        if (this.renderer) {
          const renderer = this.renderer;
          await act(async () => {
            renderer.unmount();
          });
          this.renderer = null;
        }
        this.modelPage = 'value';
        await this.mount();
        return;
      }
    }
  }

  snapshot(): UiSnapshot {
    const ui = readUi(this.renderer, this.routes);
    if (ui.page === 'value' || ui.page === 'pricing') this.modelPage = ui.page;
    else if (ui.page === 'none') this.modelPage = 'value';
    return ui;
  }

  async teardown(): Promise<void> {
    if (this.renderer) {
      const renderer = this.renderer;
      await act(async () => {
        renderer.unmount();
      });
      this.renderer = null;
    }
    clearAccessStoreConfiguration();
    for (const restore of this.restoreSpies) restore();
    navSeam.onStateChange = null;
  }
}

// ─── Online generator: legal / near-legal actions from what is on screen ─────

function generateAction(
  rng: Rng,
  ui: UiSnapshot,
  env: Env,
  mode: 'deferred' | 'auto',
): Action {
  const busy = useAccessStore.getState().operation !== 'idle';
  const pendingKinds = env.pending
    .map(c => c.kind)
    .filter(
      kind =>
        !(
          EXCLUDE.has('settle-while-busy') &&
          busy &&
          (kind === 'offerings' || kind === 'access')
        ),
    );
  const enabled = (k: string) =>
    ui.controls[k]?.present === true && ui.controls[k]?.disabled !== true;
  const table: Array<[Action, number]> = [];
  const add = (action: Action, weight: number) => {
    if (EXCLUDE.has(describeAction(action))) return;
    if (
      EXCLUDE.has('close-while-busy') &&
      busy &&
      action.type === 'press' &&
      action.target.startsWith('close')
    ) {
      return;
    }
    table.push([action, weight]);
  };

  if (pendingKinds.length > 0) {
    // 'auto' = a fast network: every in-flight call lands before the next tap,
    // FIFO. 'deferred' = the user keeps tapping while calls are in flight.
    if (mode === 'auto') {
      const kind = pendingKinds[0] ?? 'access';
      const settle: Action = {
        type: 'settle',
        kind,
        outcome: rng.weighted(OUTCOMES[kind]),
      };
      if (!EXCLUDE.has(describeAction(settle))) return settle;
    }
    for (const kind of new Set(pendingKinds)) {
      add({ type: 'settle', kind, outcome: rng.weighted(OUTCOMES[kind]) }, 22);
    }
  }
  add({ type: 'flush' }, 4);

  if (ui.page === 'none') {
    add({ type: 'reopen' }, 40);
  } else if (ui.page === 'value') {
    add({ type: 'press', target: 'see-plans', taps: 1 }, 34);
    add({ type: 'press', target: 'see-plans', taps: 2 }, 4);
    add({ type: 'press', target: 'close', taps: 1 }, 6);
    add({ type: 'press', target: 'close', taps: 2 }, 2);
    add({ type: 'hardware-back' }, 3);
  } else if (ui.page === 'pricing') {
    for (const plan of ['plan-annual', 'plan-monthly', 'plan-lifetime']) {
      if (enabled(plan)) add({ type: 'press', target: plan, taps: 1 }, 7);
    }
    if (enabled('continue')) {
      add({ type: 'press', target: 'continue', taps: 1 }, 20);
      add({ type: 'press', target: 'continue', taps: 2 }, 4);
    }
    if (enabled('restore')) {
      add({ type: 'press', target: 'restore', taps: 1 }, 9);
      add({ type: 'press', target: 'restore', taps: 2 }, 2);
    }
    if (enabled('retry')) add({ type: 'press', target: 'retry', taps: 1 }, 10);
    if (enabled('dismiss-error'))
      add({ type: 'press', target: 'dismiss-error', taps: 1 }, 6);
    if (enabled('terms')) add({ type: 'press', target: 'terms', taps: 1 }, 2);
    if (enabled('privacy'))
      add({ type: 'press', target: 'privacy', taps: 1 }, 2);
    add({ type: 'press', target: 'back', taps: 1 }, 5);
    add({ type: 'hardware-back' }, 5);
    add({ type: 'press', target: 'close', taps: 1 }, 6);
    add({ type: 'press', target: 'close', taps: 2 }, 2);
    // Pressing a control the screen has disabled is a no-op (near-legal).
    add({ type: 'press', target: 'continue', taps: 1 }, 2);
    add({ type: 'press', target: 'retry', taps: 1 }, 1);
  } else if (ui.page === 'verified') {
    add({ type: 'press', target: 'continue-coaching', taps: 1 }, 30);
    add({ type: 'press', target: 'close-verified', taps: 1 }, 20);
    add({ type: 'press', target: 'close-verified', taps: 2 }, 3);
  }
  add({ type: 'sign-out' }, 1.5);
  add({ type: 'reconfigure' }, 1.5);
  add({ type: 'restart' }, 1);

  const total = table.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng.next() * total;
  for (const [action, weight] of table) {
    roll -= weight;
    if (roll < 0) return action;
  }
  return { type: 'flush' };
}

async function runSequence(
  seed: number,
  options?: { actions?: Action[]; keepTrace?: boolean },
): Promise<SequenceResult> {
  const started = Date.now();
  const rng = new Rng(seed);
  const length = MIN_LEN + rng.int(MAX_LEN - MIN_LEN + 1);
  const mode: 'deferred' | 'auto' = rng.chance(0.3) ? 'auto' : 'deferred';
  const config = envConfigFor(rng);
  const harness = new Harness(config);
  const result: SequenceResult = {
    seed,
    length,
    mode,
    env: config,
    outcome: 'ok',
    failedStep: null,
    violations: [],
    error: null,
    actions: [],
    trace: [],
    durationMs: 0,
  };
  const replay = options?.actions;
  const total = replay ? replay.length : length;
  harness.install();
  try {
    await harness.mount();
    for (let step = 0; step < total; step += 1) {
      const action =
        replay?.[step] ??
        generateAction(rng, harness.snapshot(), harness.env, mode);
      result.actions.push(action);
      harness.consoleMessages = [];
      await harness.apply(action);
      const ui = harness.snapshot();
      const violations = checkInvariants(
        ui,
        harness.env,
        harness.liveBackHandlers(),
        harness.consoleMessages,
        true,
        harness.modelPage,
      );
      const record: StepRecord = {
        step,
        action: describeAction(action),
        ui: {
          page: ui.page,
          routes: ui.routes,
          stepDots: ui.stepDots,
          controls: compactControls(ui),
          errorText: ui.errorText,
          dollarTokens: ui.dollarTokens,
        },
        store: storeSnapshot(),
        env: {
          pending: harness.env.pending.map(c => c.kind),
          sdkCalls: harness.env.sdkCalls.length,
          backendCalls: harness.env.backendCalls.length,
        },
        violations,
      };
      result.trace.push(record);
      if (violations.length > 0) {
        result.outcome = 'violation';
        result.failedStep = step;
        result.violations = violations;
        break;
      }
    }
    // Drain: whatever is still pending must not break the model afterwards.
    if (result.outcome === 'ok') {
      harness.consoleMessages = [];
      await harness.settleAll();
      const ui = harness.snapshot();
      const violations = checkInvariants(
        ui,
        harness.env,
        harness.liveBackHandlers(),
        harness.consoleMessages,
        true,
        harness.modelPage,
      );
      result.trace.push({
        step: total,
        action: 'drain',
        ui: {
          page: ui.page,
          routes: ui.routes,
          stepDots: ui.stepDots,
          controls: compactControls(ui),
          errorText: ui.errorText,
          dollarTokens: ui.dollarTokens,
        },
        store: storeSnapshot(),
        env: {
          pending: harness.env.pending.map(c => c.kind),
          sdkCalls: harness.env.sdkCalls.length,
          backendCalls: harness.env.backendCalls.length,
        },
        violations,
      });
      if (violations.length > 0) {
        result.outcome = 'violation';
        result.failedStep = total;
        result.violations = violations;
      }
    }
  } catch (error) {
    result.outcome = 'exception';
    result.failedStep = result.actions.length - 1;
    result.error =
      error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
        : String(error);
  } finally {
    await harness.teardown();
    // Sequences must be independent: no timer from an unmounted tree survives.
    jest.clearAllTimers();
    // The RN preset's native-module jest.fn()s (NativeAnimatedModule etc.)
    // record every call; tens of thousands of animation frames per sequence
    // would otherwise be retained for the whole campaign.
    jest.clearAllMocks();
  }
  result.durationMs = Date.now() - started;
  if (!options?.keepTrace) {
    result.trace = result.outcome === 'ok' ? [] : result.trace.slice(-6);
  }
  return result;
}

/** Failure class: which invariants broke (or the exception's first line). */
function signature(result: SequenceResult): string {
  if (result.outcome === 'ok') return 'ok';
  if (result.outcome === 'exception') {
    return `exception:${(result.error ?? '').split('\n')[0] ?? ''}`;
  }
  return [...new Set(result.violations.map(v => v.invariant))].sort().join('+');
}

/**
 * ddmin over the concrete action list, replaying on the same seed (same env,
 * same mode). A candidate counts only if it reproduces the SAME failure class.
 */
async function minimize(
  seed: number,
  actions: Action[],
  target: string,
): Promise<Action[]> {
  const fails = async (candidate: Action[]) =>
    signature(await runSequence(seed, { actions: candidate })) === target;
  let current = actions;
  let n = 2;
  while (current.length >= 2) {
    const chunk = Math.ceil(current.length / n);
    let reduced = false;
    for (let i = 0; i < current.length; i += chunk) {
      const candidate = [...current.slice(0, i), ...current.slice(i + chunk)];
      if (candidate.length > 0 && (await fails(candidate))) {
        current = candidate;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(n * 2, current.length);
    }
  }
  return current;
}

function traceKey(result: SequenceResult): string {
  return JSON.stringify({
    outcome: result.outcome,
    failedStep: result.failedStep,
    actions: result.actions,
    trace: result.trace,
  });
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const seeds: number[] =
  SINGLE_SEED !== null
    ? [SINGLE_SEED]
    : Array.from({ length: ITER }, (_, i) => SEED_BASE + i);

const results: SequenceResult[] = [];
const determinism: Array<{ seed: number; identical: boolean }> = [];
const minimized: Array<{
  seed: number;
  signature: string;
  original: number;
  minimized: Action[];
}> = [];
const MINIMIZE_PER_SIGNATURE = Number(process.env.STRESS_MINIMIZE_PER_SIG ?? 5);
const flakiness: Array<{ seed: number; failures: number; runs: number }> = [];

beforeAll(() => {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
  });
});

afterAll(() => {
  jest.useRealTimers();
  if (!OUT_PATH) return;
  const table = results.map(r => ({
    seed: r.seed,
    length: r.length,
    mode: r.mode,
    env: r.env,
    outcome: r.outcome,
    failedStep: r.failedStep,
    violations: r.violations,
    error: r.error,
    actions: r.actions.map(describeAction),
    trace: r.trace,
    durationMs: r.durationMs,
  }));
  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        unit: 'scr-paywallscreen',
        lens: 'randomized-seeded',
        generatedAt: new Date().toISOString(),
        seedBase: SEED_BASE,
        exclude: [...EXCLUDE],
        sequences: results.length,
        stepsExecuted: results.reduce((sum, r) => sum + r.actions.length, 0),
        failing: results.filter(r => r.outcome !== 'ok').map(r => r.seed),
        failingBySignature: results
          .filter(r => r.outcome !== 'ok')
          .reduce<Record<string, number[]>>((acc, r) => {
            const sig = signature(r);
            (acc[sig] ??= []).push(r.seed);
            return acc;
          }, {}),
        determinism,
        minimized: minimized.map(m => ({
          ...m,
          minimized: m.minimized.map(describeAction),
          minimizedRaw: m.minimized,
        })),
        flakiness,
        results: table,
      },
      null,
      2,
    ),
  );
});

describe('PaywallScreen inside RootNavigator — seeded randomized long-run', () => {
  for (let start = 0; start < seeds.length; start += CHUNK) {
    const chunk = seeds.slice(start, start + CHUNK);
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    test(`seeds ${first}..${last} hold every invariant after every step`, async () => {
      for (const seed of chunk) {
        results.push(
          await runSequence(seed, {
            keepTrace: SINGLE_SEED !== null,
            ...(SINGLE_SEED !== null && REPLAY_ACTIONS
              ? { actions: REPLAY_ACTIONS }
              : {}),
          }),
        );
      }
    }, 600_000);
  }

  test('determinism: the same seed twice produces an identical trace', async () => {
    const sample = seeds.filter((_, i) => i % DETERMINISM_EVERY === 0);
    const failing = results.filter(r => r.outcome !== 'ok').map(r => r.seed);
    const chosen = [...new Set([...sample, ...failing])].slice(0, 120);
    for (const seed of chosen) {
      const a = await runSequence(seed, { keepTrace: true });
      const b = await runSequence(seed, { keepTrace: true });
      determinism.push({ seed, identical: traceKey(a) === traceKey(b) });
    }
    expect(determinism.filter(d => !d.identical)).toEqual([]);
  }, 600_000);

  test('failing seeds are minimized per failure class and re-run 10× for flakiness', async () => {
    const perSignature = new Map<string, number>();
    const failing = results.filter(r => {
      if (r.outcome === 'ok') return false;
      const sig = signature(r);
      const seen = perSignature.get(sig) ?? 0;
      perSignature.set(sig, seen + 1);
      return seen < MINIMIZE_PER_SIGNATURE;
    });
    for (const failure of failing) {
      const sig = signature(failure);
      const reduced = await minimize(failure.seed, failure.actions, sig);
      minimized.push({
        seed: failure.seed,
        signature: sig,
        original: failure.actions.length,
        minimized: reduced,
      });
      let failures = 0;
      for (let i = 0; i < 10; i += 1) {
        if ((await runSequence(failure.seed)).outcome !== 'ok') failures += 1;
      }
      flakiness.push({ seed: failure.seed, failures, runs: 10 });
    }
  }, 7_200_000);

  test('no seed violated an invariant', () => {
    const failing = results
      .filter(r => r.outcome !== 'ok')
      .map(r => ({
        seed: r.seed,
        step: r.failedStep,
        violations: r.violations,
        error: r.error,
        lastActions: r.actions.slice(-5).map(describeAction),
      }));
    expect(results.length).toBe(seeds.length);
    expect(failing).toEqual([]);
  });
});
