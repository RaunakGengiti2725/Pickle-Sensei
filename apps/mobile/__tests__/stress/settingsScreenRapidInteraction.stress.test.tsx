/**
 * STRESS — SettingsScreen under rapid / concurrent interaction.
 *
 * Unit: apps/mobile/src/screens/SettingsScreen.tsx rendered inside the REAL
 * RootNavigator (real @react-navigation NavigationContainer, native-stack and
 * bottom-tabs, real PremiumTabBar, real zustand stores, real BrandNoticeHost).
 * Only native modules are replaced: react-native-screens (plain Views),
 * safe-area-context (the package's own jest mock), SVG/gradient, SQLite
 * (throws, like every other suite), and the sibling screens SettingsScreen
 * navigates to (markers with a Back control, so "back during async" is a real
 * stack pop through the real route components).
 *
 * A seeded generator scripts interaction BURSTS — double/triple taps,
 * same-frame taps (two handlers before React re-renders, i.e. two touch
 * events in one bridge/event-beat batch), taps while a backend call is in
 * flight, cancel/confirm/backdrop races on the sign-out sheet, tab spam, stack
 * push/pop spam, hardware-style back — and after every frame the harness
 * checks these invariants against a ledger of the user's intent:
 *
 *   - one navigation per intent: after a frame of N taps on a row, the
 *     target route is in the root stack exactly once and on top; no route
 *     ever appears twice in the stack;
 *   - one request per intent: never two `getAccess` calls in flight, never a
 *     refresh started while a load is in flight, never one for a guest, and
 *     never more refreshes than Settings focus events;
 *   - one sign-out per confirm: `signOut` is called exactly once per FRAME
 *     that carried a confirm tap (a same-frame double confirm counts once),
 *     and never after cancel / backdrop / close / hardware back;
 *   - no duplicate modal: at most one visible sign-out sheet and one visible
 *     brand notice at any time; SettingsScreen mounted exactly once;
 *   - no orphan loading state: `status === 'loading'` only while a request is
 *     really in flight, and never once every deferred has settled;
 *   - no console.error/warn (React act() warnings land there) and no
 *     unhandled promise rejection during the burst.
 *
 * Replay one iteration:
 *   STRESS_SEED=<n> npx jest --ci __tests__/stress/settingsScreenRapidInteraction
 * Campaign size: STRESS_ITER=<n> (default 40), STRESS_SEED_BASE=<n> (1000).
 * JSON table (seed → outcome, counters, trace): STRESS_OUT=<path>.
 */
import React from 'react';
import { Linking, Modal, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Native module doubles ───────────────────────────────────────────────────

jest.mock('react-native-screens', () => {
  const ReactLib = require('react');
  const { View: RNView } = require('react-native');
  const Passthrough = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(RNView, null, props.children);
  const Nothing = () => null;
  return {
    __esModule: true,
    enableScreens: () => undefined,
    enableFreeze: () => undefined,
    screensEnabled: () => true,
    freezeEnabled: () => false,
    isSearchBarAvailableForCurrentPlatform: false,
    executeNativeBackPress: () => true,
    compatibilityFlags: { usesHeaderFlexboxImplementation: false },
    featureFlags: { experiment: {} },
    Screen: Passthrough,
    InnerScreen: Passthrough,
    ScreenContext: ReactLib.createContext(Passthrough),
    ScreenContainer: Passthrough,
    ScreenStack: Passthrough,
    ScreenStackItem: Passthrough,
    ScreenContentWrapper: Passthrough,
    ScreenFooter: Passthrough,
    FullWindowOverlay: Passthrough,
    ScreenStackHeaderConfig: Nothing,
    ScreenStackHeaderSubview: Nothing,
    ScreenStackHeaderLeftView: Nothing,
    ScreenStackHeaderCenterView: Nothing,
    ScreenStackHeaderRightView: Nothing,
    ScreenStackHeaderBackButtonImage: Nothing,
    ScreenStackHeaderSearchBarView: Nothing,
    SearchBar: Nothing,
    useTransitionProgress: () => ({
      progress: { interpolate: () => 0 },
      closing: { interpolate: () => 0 },
      goingForward: { interpolate: () => 0 },
    }),
  };
});
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('react-native-linear-gradient', () => {
  const ReactLib = require('react');
  const { View: RNView } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(RNView, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-svg', () => {
  const ReactLib = require('react');
  const { View: RNView } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(RNView, null, props.children);
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
jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));
jest.mock('../../src/notifications/service', () => ({
  __esModule: true,
  subscribeToNotificationPresses: () => () => undefined,
}));

// Sibling screens: markers with a real Back control (navigation.goBack()).
function mockMarkerScreen(name: string) {
  return () => {
    const ReactLib = require('react');
    const { Pressable, Text: RNText } = require('react-native');
    const { useNavigation } = require('@react-navigation/native');
    const navigation = useNavigation();
    return ReactLib.createElement(
      ReactLib.Fragment,
      null,
      ReactLib.createElement(RNText, { testID: `marker-${name}` }, `[${name}]`),
      ReactLib.createElement(
        Pressable,
        {
          accessibilityLabel: `Back from ${name}`,
          onPress: () => navigation.goBack(),
        },
        ReactLib.createElement(RNText, null, 'Back'),
      ),
    );
  };
}
jest.mock('../../src/screens/HomeScreen', () => ({
  HomeScreen: () => {
    const ReactLib = require('react');
    const { Text: RNText } = require('react-native');
    return ReactLib.createElement(RNText, { testID: 'marker-Home' }, '[Home]');
  },
}));
jest.mock('../../src/screens/LibraryScreen', () => ({
  LibraryScreen: () => null,
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: () => null,
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
  StreakCalendarScreen: mockMarkerScreen('StreakCalendar'),
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: mockMarkerScreen('ManageAccount'),
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: mockMarkerScreen('ConsentSettings'),
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: mockMarkerScreen('NotificationSettings'),
}));
// PaywallRoute / ConnectAccountRoute (RootNavigator) stay real; the surfaces
// they mount are markers whose Back/Close reach the route's goBack handlers.
jest.mock('../../src/screens/PaywallScreen', () => ({
  PaywallScreen: (props: { onClose: () => void }) => {
    const ReactLib = require('react');
    const { Pressable, Text: RNText } = require('react-native');
    return ReactLib.createElement(
      ReactLib.Fragment,
      null,
      ReactLib.createElement(RNText, { testID: 'marker-Paywall' }, '[Paywall]'),
      ReactLib.createElement(
        Pressable,
        { accessibilityLabel: 'Back from Paywall', onPress: props.onClose },
        ReactLib.createElement(RNText, null, 'Close'),
      ),
    );
  },
}));
jest.mock('../../src/screens/SignInScreen', () => ({
  SignInScreen: (props: { onBack: () => void }) => {
    const ReactLib = require('react');
    const { Pressable, Text: RNText } = require('react-native');
    return ReactLib.createElement(
      ReactLib.Fragment,
      null,
      ReactLib.createElement(
        RNText,
        { testID: 'marker-ConnectAccount' },
        '[ConnectAccount]',
      ),
      ReactLib.createElement(
        Pressable,
        {
          accessibilityLabel: 'Back from ConnectAccount',
          onPress: props.onBack,
        },
        ReactLib.createElement(RNText, null, 'Back'),
      ),
    );
  },
}));

// Capture RootNavigator's container ref so the harness can read the real
// navigation state and dispatch a hardware-style back.
// (jest.mock factories are hoisted above module-level consts, so the capture
// list lives on globalThis and is created lazily inside the factory.)
const CAPTURED_REFS_KEY = '__settingsStressCapturedNavRefs';
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual<typeof import('@react-navigation/native')>(
    '@react-navigation/native',
  );
  const holder = globalThis as unknown as Record<string, unknown[]>;
  holder.__settingsStressCapturedNavRefs ??= [];
  return {
    ...actual,
    createNavigationContainerRef: () => {
      const ref = actual.createNavigationContainerRef();
      holder.__settingsStressCapturedNavRefs!.push(ref);
      return ref;
    },
  };
});
const mockCapturedRefs = (globalThis as unknown as Record<string, unknown[]>)[
  CAPTURED_REFS_KEY
]!;

import type {
  NavigationContainerRefWithCurrent,
  NavigationState,
} from '@react-navigation/native';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { BrandNoticeHost } from '../../src/design/BrandNotice';
import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { useConsentStore } from '../../src/state/consentStore';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import type { RootStackParams } from '../../src/navigation/params';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../../src/billing/types';

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const syncedSession: AuthSession = {
  provider: 'google',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

const guestSession: AuthSession = {
  provider: 'guest',
  subject: 'local-only',
  canonicalAppUserId: null,
  localOnly: true,
  displayName: null,
  email: null,
};

function access(used: number, premium = false): CanonicalAccessState {
  const remaining = 2 - used;
  const canStartRating = premium || remaining > 0;
  return {
    premium,
    entitlements: premium ? ['pickle_sensei_pro'] : [],
    freeRatings: {
      limit: 2,
      used,
      reserved: 0,
      remaining,
      availableToReserve: remaining,
    },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

interface Deferred<T> {
  id: number;
  kind: DeferredKind;
  settled: boolean;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  promise: Promise<T>;
}

type DeferredKind = 'getAccess' | 'signOut' | 'openURL';

class DeferredLedger {
  private nextId = 1;
  readonly all: Deferred<unknown>[] = [];
  create<T>(kind: DeferredKind): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: Deferred<T> = {
      id: this.nextId++,
      kind,
      settled: false,
      promise,
      resolve: value => {
        entry.settled = true;
        resolve(value);
      },
      reject: error => {
        entry.settled = true;
        reject(error);
      },
    };
    this.all.push(entry as Deferred<unknown>);
    return entry;
  }
  pending(kind?: DeferredKind) {
    return this.all.filter(d => !d.settled && (!kind || d.kind === kind));
  }
}

// ─── Model of the screen's controls ──────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;
type RouteName = keyof RootStackParams;
type Layout = 'synced' | 'guest';

interface NavRow {
  label: RegExp;
  route: RouteName;
  layout: Layout | null; // null = present in both layouts
}

const NAV_ROWS: readonly NavRow[] = [
  { label: /^Pickle Sensei Pro, /, route: 'Paywall', layout: 'synced' },
  { label: /^Pickle Sensei Pro, /, route: 'ConnectAccount', layout: 'guest' },
  { label: /^Connect account, /, route: 'ConnectAccount', layout: 'guest' },
  { label: /^Consistency, /, route: 'StreakCalendar', layout: null },
  { label: /^Notifications, /, route: 'NotificationSettings', layout: null },
  { label: /^Data & consent, /, route: 'ConsentSettings', layout: null },
  { label: /^Manage account, /, route: 'ManageAccount', layout: 'synced' },
];

const LINK_ROWS: readonly RegExp[] = [
  /^Privacy policy, /,
  /^Terms of use, /,
  /^Rate Pickle Sensei, /,
];

const TAB_LABELS = ['Home', 'Library', 'Progress', 'Settings'] as const;
type TabLabel = (typeof TAB_LABELS)[number];

type SheetControl =
  'confirm' | 'cancel' | 'backdrop' | 'close' | 'requestClose';

type Step =
  | { kind: 'tapNav'; row: NavRow; sameFrame: boolean }
  | { kind: 'tapLink'; label: RegExp; sameFrame: boolean }
  | { kind: 'tapWalkthrough'; sameFrame: boolean }
  | { kind: 'tapSignOut'; sameFrame: boolean }
  | { kind: 'tapSheet'; control: SheetControl; sameFrame: boolean }
  | { kind: 'tapNoticeDismiss'; sameFrame: boolean }
  | { kind: 'tab'; label: TabLabel }
  | { kind: 'back'; via: 'marker' | 'dispatch' }
  | { kind: 'settle'; target: DeferredKind | 'any'; ok: boolean }
  | { kind: 'advance'; ms: number }
  | { kind: 'flush' };

function describeStep(step: Step): string {
  const sf = (flag: boolean) => (flag ? ' +sameFrame' : '');
  switch (step.kind) {
    case 'tapNav':
      return `tapNav(${step.row.label.source} → ${step.row.route})${sf(step.sameFrame)}`;
    case 'tapLink':
      return `tapLink(${step.label.source})${sf(step.sameFrame)}`;
    case 'tapWalkthrough':
      return `tapWalkthrough${sf(step.sameFrame)}`;
    case 'tapSignOut':
      return `tapSignOut${sf(step.sameFrame)}`;
    case 'tapSheet':
      return `tapSheet(${step.control})${sf(step.sameFrame)}`;
    case 'tapNoticeDismiss':
      return `tapNoticeDismiss${sf(step.sameFrame)}`;
    case 'tab':
      return `tab(${step.label})`;
    case 'back':
      return `back(${step.via})`;
    case 'settle':
      return `settle(${step.target}, ${step.ok ? 'resolve' : 'reject'})`;
    case 'advance':
      return `advance(${step.ms}ms)`;
    case 'flush':
      return 'flush';
  }
}

function generateBurst(rng: Rng, layout: Layout): Step[] {
  const steps: Step[] = [];
  const length = 8 + rng.int(20);
  const rows = NAV_ROWS.filter(
    row => row.layout === null || row.layout === layout,
  );
  const repeat = () => (rng.chance(0.45) ? 1 : rng.chance(0.6) ? 2 : 3);
  const pushTaps = (make: (sameFrame: boolean) => Step) => {
    const n = repeat();
    const sameFrame = n > 1 && rng.chance(0.45);
    for (let i = 0; i < n; i += 1) steps.push(make(sameFrame && i > 0));
  };
  for (let i = 0; i < length; i += 1) {
    const roll = rng.int(100);
    if (roll < 20) {
      const row = rng.pick(rows);
      pushTaps(sameFrame => ({ kind: 'tapNav', row, sameFrame }));
    } else if (roll < 30) {
      const label = rng.pick(LINK_ROWS);
      pushTaps(sameFrame => ({ kind: 'tapLink', label, sameFrame }));
    } else if (roll < 36) {
      pushTaps(sameFrame => ({ kind: 'tapWalkthrough', sameFrame }));
    } else if (roll < 48) {
      pushTaps(sameFrame => ({ kind: 'tapSignOut', sameFrame }));
    } else if (roll < 63) {
      const control = rng.pick<SheetControl>([
        'confirm',
        'confirm',
        'cancel',
        'backdrop',
        'close',
        'requestClose',
      ]);
      pushTaps(sameFrame => ({ kind: 'tapSheet', control, sameFrame }));
      // Simultaneous controls: a second control in the same frame.
      if (rng.chance(0.35)) {
        steps.push({
          kind: 'tapSheet',
          control: rng.pick<SheetControl>(['confirm', 'cancel', 'backdrop']),
          sameFrame: true,
        });
      }
    } else if (roll < 67) {
      pushTaps(sameFrame => ({ kind: 'tapNoticeDismiss', sameFrame }));
    } else if (roll < 77) {
      steps.push({ kind: 'tab', label: rng.pick(TAB_LABELS) });
      if (rng.chance(0.6)) steps.push({ kind: 'tab', label: 'Settings' });
    } else if (roll < 85) {
      steps.push({
        kind: 'back',
        via: rng.chance(0.5) ? 'marker' : 'dispatch',
      });
    } else if (roll < 94) {
      steps.push({
        kind: 'settle',
        target: rng.pick<DeferredKind | 'any'>([
          'getAccess',
          'signOut',
          'openURL',
          'any',
        ]),
        ok: rng.chance(0.7),
      });
    } else if (roll < 98) {
      steps.push({ kind: 'advance', ms: rng.pick([0, 16, 50, 250, 1200]) });
    } else {
      steps.push({ kind: 'flush' });
    }
  }
  return steps;
}

// ─── Tree queries ────────────────────────────────────────────────────────────

/** Deepest node carrying this onPress (the <Pressable>, not a wrapper). */
function isHostHandler(node: Instance): boolean {
  return node.children.every(
    child =>
      typeof child === 'string' ||
      child.props == null ||
      child.props.onPress !== node.props.onPress,
  );
}

function hasLabel(node: Instance, label: RegExp | string): boolean {
  const value = node.props?.accessibilityLabel;
  if (typeof value !== 'string') return false;
  return typeof label === 'string' ? value === label : label.test(value);
}

function findPressables(root: Instance, label: RegExp | string): Instance[] {
  return root.findAll(
    node =>
      node.props != null &&
      typeof node.props.onPress === 'function' &&
      hasLabel(node, label) &&
      isHostHandler(node),
  );
}

function visibleModals(renderer: Renderer): Instance[] {
  return renderer.root
    .findAllByType(Modal)
    .filter(node => node.props.visible === true);
}

function visibleSignOutSheets(renderer: Renderer): Instance[] {
  return visibleModals(renderer).filter(
    modal => findPressables(modal, 'Cancel sign out').length > 0,
  );
}

function visibleBrandNotices(renderer: Renderer): Instance[] {
  return visibleModals(renderer).filter(
    modal =>
      modal.findAll(
        node => node.props != null && node.props.testID === 'brand-notice',
      ).length > 0,
  );
}

function rootState(
  ref: NavigationContainerRefWithCurrent<RootStackParams>,
): NavigationState | undefined {
  return ref.isReady() ? ref.getRootState() : undefined;
}

function routeNames(state: NavigationState | undefined): RouteName[] {
  return (state?.routes ?? []).map(route => route.name as RouteName);
}

function focusedTab(state: NavigationState | undefined): string | null {
  if (!state) return null;
  const top = state.routes[state.index];
  if (!top || top.name !== 'Tabs') return null;
  const tabs = top.state;
  if (!tabs) return 'Home';
  return tabs.routes[tabs.index ?? 0]?.name ?? null;
}

function settingsFocused(state: NavigationState | undefined): boolean {
  return focusedTab(state) === 'Settings';
}

// App.tsx swaps RootNavigator for the sign-in flow the moment the session is
// gone, so a confirmed sign-out unmounts SettingsScreen mid-burst exactly as
// in production.
function SessionGate() {
  const session = useAuthStore(s => s.session);
  return session ? (
    <RootNavigator />
  ) : (
    <Text testID="marker-SignedOut">[SignedOut]</Text>
  );
}

// ─── Iteration ───────────────────────────────────────────────────────────────

interface BurstOutcome {
  seed: number;
  layout: Layout;
  steps: number;
  frames: number;
  outcome: 'HELD' | 'BROKEN';
  violations: string[];
  counters: Record<string, number>;
  trace: string[];
}

async function runIteration(
  seed: number,
  scripted?: { layout: Layout; steps: Step[] },
): Promise<BurstOutcome> {
  const rng = new Rng(seed);
  const layout: Layout =
    scripted?.layout ?? (rng.chance(0.75) ? 'synced' : 'guest');
  const ledger = new DeferredLedger();
  const violations: string[] = [];
  const trace: string[] = [];
  const counters: Record<string, number> = {
    frames: 0,
    getAccessCalls: 0,
    maxGetAccessInFlight: 0,
    focusEvents: 0,
    signOutCalls: 0,
    confirmFrames: 0,
    sameFrameDoubleConfirms: 0,
    dismissFrames: 0,
    openURLCalls: 0,
    linkTaps: 0,
    linkRepeatTaps: 0,
    navTaps: 0,
    navFrames: 0,
    stackPushes: 0,
    stackPops: 0,
    tabSwitches: 0,
    walkthroughTaps: 0,
    replayCalls: 0,
    noticesShown: 0,
    rejectedDeferreds: 0,
    consoleErrors: 0,
    unhandledRejections: 0,
  };
  const bump = (key: string, by = 1) => {
    counters[key] = (counters[key] ?? 0) + by;
  };
  const consoleMessages: string[] = [];
  const unhandled: string[] = [];

  // Console + unhandled-rejection capture. Any console.error/warn during the
  // burst is a violation (React's act() warnings land there).
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      bump('consoleErrors');
      consoleMessages.push(args.map(String).join(' ').slice(0, 400));
    });
  const warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      bump('consoleErrors');
      consoleMessages.push(args.map(String).join(' ').slice(0, 400));
    });
  const onUnhandled = (reason: unknown) => {
    bump('unhandledRejections');
    unhandled.push(String(reason).slice(0, 400));
  };
  process.on('unhandledRejection', onUnhandled);

  // Backend: every getAccess is a deferred the script settles later.
  const backend: BillingAccessDependencies = {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => {
        throw new Error('plans are not part of this stress');
      }),
      purchase: jest.fn(),
      restore: jest.fn(),
      readEntitlement: jest.fn(),
    },
    backend: {
      getAccess: jest.fn(() => {
        bump('getAccessCalls');
        const inFlight = ledger.pending('getAccess').length + 1;
        counters.maxGetAccessInFlight = Math.max(
          counters.maxGetAccessInFlight!,
          inFlight,
        );
        return ledger.create<CanonicalAccessState>('getAccess').promise;
      }),
      syncBilling: jest.fn(),
    },
  };
  clearAccessStoreConfiguration();
  configureAccessStore(backend);
  useAccessStore.setState({
    status: 'ready',
    operation: 'idle',
    canonicalAccess: access(rng.int(3), rng.chance(0.2)),
    error: null,
  });

  // Auth: the real store; `signOut` is swapped for a deferred double that
  // mirrors the real action's synchronous session clear (authStore.ts) so the
  // screen re-renders into its signed-out layout exactly like production.
  const realSignOut = useAuthStore.getState().signOut;
  const signOut = jest.fn(() => {
    bump('signOutCalls');
    useAuthStore.setState({ session: null, error: null, busy: false });
    return ledger.create<void>('signOut').promise;
  });
  useAuthStore.setState({
    session: layout === 'synced' ? syncedSession : guestSession,
    busy: false,
    error: null,
    hydrated: true,
    signOut,
  });
  useAppStore.setState({
    profile: {
      firstName: 'Alex',
      gender: 'nonbinary',
      skillLevel: 'intermediate',
      handedness: 'right',
      goal: 'dinks',
      biggestProblem: 'consistency',
      focusCheckpoint: 'contact_position',
    },
  });
  useConsentStore.setState({
    availability: 'ready',
    modelTrainingActive: false,
  });
  useWalkthroughStore.setState({ visible: false, queued: false });
  const realReplay = useWalkthroughStore.getState().replay;
  useWalkthroughStore.setState({
    replay: () => {
      bump('replayCalls');
      realReplay();
    },
  });

  // Linking: deferred per call so a link can still be "opening" when the
  // next tap lands.
  const openURL = jest.spyOn(Linking, 'openURL').mockImplementation(() => {
    bump('openURLCalls');
    return ledger.create<void>('openURL').promise;
  });

  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(
      <>
        <SessionGate />
        <BrandNoticeHost />
      </>,
    );
  });
  // RootNavigator creates its container ref once at module load.
  expect(mockCapturedRefs).toHaveLength(1);
  const ref =
    mockCapturedRefs[0] as unknown as NavigationContainerRefWithCurrent<RootStackParams>;

  let previousFocused = false;
  let previousStackDepth = 1;
  let previousTab: string | null = 'Home';
  const observeNavigation = () => {
    if (useAuthStore.getState().session === null) return;
    const state = rootState(ref);
    const focused = settingsFocused(state);
    if (focused && !previousFocused) bump('focusEvents');
    previousFocused = focused;
    const depth = routeNames(state).length;
    if (depth > previousStackDepth)
      bump('stackPushes', depth - previousStackDepth);
    if (depth < previousStackDepth)
      bump('stackPops', previousStackDepth - depth);
    previousStackDepth = depth;
    const tab = focusedTab(state);
    if (tab !== null && previousTab !== null && tab !== previousTab)
      bump('tabSwitches');
    if (tab !== null) previousTab = tab;
  };

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      jest.advanceTimersByTime(0);
    });
    observeNavigation();
  };

  // Land on the Settings tab through the real tab bar.
  await flush();
  const settingsTab = findPressables(renderer.root, 'Settings').filter(
    node => node.props.accessibilityRole === 'tab',
  );
  expect(settingsTab).toHaveLength(1);
  await act(async () => {
    settingsTab[0]!.props.onPress();
  });
  await flush();
  expect(settingsFocused(rootState(ref))).toBe(true);
  expect(renderer.root.findAllByType(SettingsScreen)).toHaveLength(1);

  const snapshotInvariants = (where: string) => {
    const names = routeNames(rootState(ref));
    const seen = new Map<string, number>();
    for (const name of names) seen.set(name, (seen.get(name) ?? 0) + 1);
    for (const [name, count] of seen) {
      if (count > 1) {
        violations.push(
          `${where}: route ${name} appears ${count}x in stack [${names.join(' > ')}]`,
        );
      }
    }
    const sheets = visibleSignOutSheets(renderer).length;
    if (sheets > 1)
      violations.push(`${where}: ${sheets} visible sign-out sheets`);
    const notices = visibleBrandNotices(renderer).length;
    if (notices > 1)
      violations.push(`${where}: ${notices} visible brand notices`);
    const mounted = renderer.root.findAllByType(SettingsScreen).length;
    const expectedMounts = useAuthStore.getState().session ? 1 : 0;
    if (mounted !== expectedMounts) {
      violations.push(
        `${where}: SettingsScreen mounted ${mounted}x (expected ${expectedMounts})`,
      );
    }
    const inFlight = ledger.pending('getAccess').length;
    if (inFlight > 1)
      violations.push(`${where}: ${inFlight} getAccess in flight`);
    if (useAccessStore.getState().status === 'loading' && inFlight === 0) {
      violations.push(`${where}: status=loading with no getAccess in flight`);
    }
    if (layout === 'guest' && counters.getAccessCalls! > 0) {
      violations.push(`${where}: guest layout issued a getAccess call`);
    }
  };

  // Rows are reachable only while Settings is the focused tab, no stack route
  // covers it and no modal (sheet / notice) is up — exactly what a finger
  // could hit.
  const rowsReachable = () =>
    useAuthStore.getState().session !== null &&
    settingsFocused(rootState(ref)) &&
    visibleModals(renderer).length === 0;

  // Frames: taps flagged sameFrame are batched with the previous tap and run
  // inside ONE act() — two handlers before React re-renders.
  interface FrameIntent {
    handlers: Array<() => void>;
    confirms: number;
    dismisses: number;
    navRoutes: RouteName[];
    linkTaps: number;
    walkthroughTaps: number;
    stepIndex: number;
  }
  let frame: FrameIntent | null = null;
  const beginFrame = (stepIndex: number): FrameIntent => {
    if (!frame) {
      frame = {
        handlers: [],
        confirms: 0,
        dismisses: 0,
        navRoutes: [],
        linkTaps: 0,
        walkthroughTaps: 0,
        stepIndex,
      };
    }
    return frame;
  };
  const commitFrame = async () => {
    if (!frame) return;
    const current = frame;
    frame = null;
    if (current.handlers.length === 0) return;
    bump('frames');
    const signOutBefore = counters.signOutCalls!;
    const openURLBefore = counters.openURLCalls!;
    const replayBefore = counters.replayCalls!;
    const stackBefore = routeNames(rootState(ref));
    await act(async () => {
      for (const handler of current.handlers) handler();
    });
    await flush();
    const where = `frame@step ${current.stepIndex}`;
    if (current.confirms > 0) {
      bump('confirmFrames');
      if (current.confirms > 1) bump('sameFrameDoubleConfirms');
      const calls = counters.signOutCalls! - signOutBefore;
      if (calls !== 1) {
        violations.push(
          `${where}: ${current.confirms} confirm tap(s) in one frame → signOut called ${calls}x (expected 1)`,
        );
      }
      if (visibleSignOutSheets(renderer).length !== 0) {
        violations.push(`${where}: sign-out sheet still visible after confirm`);
      }
      if (renderer.root.findAllByType(RootNavigator).length !== 0) {
        violations.push(
          `${where}: navigator still mounted after sign-out cleared the session`,
        );
      }
    } else if (current.dismisses > 0) {
      bump('dismissFrames');
      if (counters.signOutCalls! !== signOutBefore) {
        violations.push(`${where}: dismiss-only frame called signOut`);
      }
      if (visibleSignOutSheets(renderer).length !== 0) {
        violations.push(`${where}: sign-out sheet still visible after dismiss`);
      }
    }
    if (current.navRoutes.length > 0) {
      bump('navFrames');
      const stackAfter = routeNames(rootState(ref));
      const target = current.navRoutes[0]!;
      const occurrences = stackAfter.filter(name => name === target).length;
      if (occurrences !== 1) {
        violations.push(
          `${where}: ${current.navRoutes.length} tap(s) → ${target} appears ${occurrences}x in [${stackAfter.join(' > ')}] (before [${stackBefore.join(' > ')}])`,
        );
      }
      if (stackAfter[stackAfter.length - 1] !== target) {
        violations.push(
          `${where}: ${target} is not the top route after navigating to it`,
        );
      }
    }
    if (current.linkTaps > 0) {
      const calls = counters.openURLCalls! - openURLBefore;
      if (calls !== current.linkTaps) {
        violations.push(
          `${where}: ${current.linkTaps} link tap(s) → openURL called ${calls}x`,
        );
      }
      if (current.linkTaps > 1) bump('linkRepeatTaps', current.linkTaps - 1);
    }
    if (current.walkthroughTaps > 0) {
      const calls = counters.replayCalls! - replayBefore;
      if (calls !== current.walkthroughTaps) {
        violations.push(
          `${where}: ${current.walkthroughTaps} walkthrough tap(s) → replay called ${calls}x`,
        );
      }
      if (focusedTab(rootState(ref)) !== 'Home') {
        violations.push(`${where}: walkthrough replay did not land on Home`);
      }
      if (!useWalkthroughStore.getState().visible) {
        violations.push(`${where}: walkthrough not visible after replay`);
      }
    }
  };
  const queueTap = async (
    stepIndex: number,
    sameFrame: boolean,
    resolveHandler: () => (() => void) | null,
    record: (intent: FrameIntent) => void,
  ) => {
    if (!sameFrame) await commitFrame();
    const handler = resolveHandler();
    if (!handler) {
      trace.push('   ↳ control not reachable — no-op');
      return;
    }
    const intent = beginFrame(stepIndex);
    intent.handlers.push(handler);
    record(intent);
  };

  const steps = scripted?.steps ?? generateBurst(rng, layout);
  for (const [index, step] of steps.entries()) {
    trace.push(`${index}: ${describeStep(step)}`);
    switch (step.kind) {
      case 'tapNav': {
        await queueTap(
          index,
          step.sameFrame,
          () =>
            rowsReachable()
              ? (findPressables(renderer.root, step.row.label)[0]?.props
                  .onPress ?? null)
              : null,
          intent => {
            bump('navTaps');
            intent.navRoutes.push(step.row.route);
          },
        );
        break;
      }
      case 'tapLink': {
        await queueTap(
          index,
          step.sameFrame,
          () =>
            rowsReachable()
              ? (findPressables(renderer.root, step.label)[0]?.props.onPress ??
                null)
              : null,
          intent => {
            bump('linkTaps');
            intent.linkTaps += 1;
          },
        );
        break;
      }
      case 'tapWalkthrough': {
        await queueTap(
          index,
          step.sameFrame,
          () =>
            rowsReachable()
              ? (findPressables(renderer.root, /^App walkthrough, /)[0]?.props
                  .onPress ?? null)
              : null,
          intent => {
            bump('walkthroughTaps');
            intent.walkthroughTaps += 1;
          },
        );
        break;
      }
      case 'tapSignOut': {
        await queueTap(
          index,
          step.sameFrame,
          () =>
            rowsReachable()
              ? (findPressables(renderer.root, 'Sign out').filter(
                  node => node.props.accessibilityRole === 'button',
                )[0]?.props.onPress ?? null)
              : null,
          () => undefined,
        );
        break;
      }
      case 'tapSheet': {
        await queueTap(
          index,
          step.sameFrame,
          () => {
            const sheet = visibleSignOutSheets(renderer)[0];
            if (!sheet) return null;
            switch (step.control) {
              case 'confirm':
                return (
                  findPressables(sheet, 'Sign out')[0]?.props.onPress ?? null
                );
              case 'cancel':
                return (
                  findPressables(sheet, 'Keep me signed in')[0]?.props
                    .onPress ?? null
                );
              case 'backdrop':
                return (
                  findPressables(sheet, 'Cancel sign out')[0]?.props.onPress ??
                  null
                );
              case 'close':
                return (
                  findPressables(sheet, 'Close sign out confirmation')[0]?.props
                    .onPress ?? null
                );
              case 'requestClose':
                return sheet.props.onRequestClose ?? null;
            }
          },
          intent => {
            if (step.control === 'confirm') intent.confirms += 1;
            else intent.dismisses += 1;
          },
        );
        break;
      }
      case 'tapNoticeDismiss': {
        await queueTap(
          index,
          step.sameFrame,
          () => {
            const notice = visibleBrandNotices(renderer)[0];
            if (!notice) return null;
            return findPressables(notice, 'Got it')[0]?.props.onPress ?? null;
          },
          () => undefined,
        );
        break;
      }
      case 'tab': {
        await commitFrame();
        const tab = findPressables(renderer.root, step.label).filter(
          node => node.props.accessibilityRole === 'tab',
        )[0];
        if (tab) {
          await act(async () => {
            tab.props.onPress();
          });
        } else {
          trace.push('   ↳ tab bar not reachable — no-op');
        }
        await flush();
        break;
      }
      case 'back': {
        await commitFrame();
        if (step.via === 'dispatch') {
          if (ref.isReady() && ref.canGoBack()) {
            await act(async () => {
              ref.goBack();
            });
          } else {
            trace.push('   ↳ nothing to go back to — no-op');
          }
        } else {
          const backs = findPressables(renderer.root, /^Back from /);
          const top = backs[backs.length - 1];
          if (top) {
            await act(async () => {
              top.props.onPress();
            });
          } else {
            trace.push('   ↳ no pushed screen — no-op');
          }
        }
        await flush();
        break;
      }
      case 'settle': {
        await commitFrame();
        const pending = ledger.pending(
          step.target === 'any' ? undefined : step.target,
        );
        const target = pending[0];
        if (target) {
          trace.push(`   ↳ ${target.kind}#${target.id}`);
          if (!step.ok) bump('rejectedDeferreds');
          const noticesBefore = visibleBrandNotices(renderer).length;
          await act(async () => {
            if (step.ok) {
              target.resolve(
                target.kind === 'getAccess'
                  ? access(rng.int(3), rng.chance(0.2))
                  : undefined,
              );
            } else {
              target.reject(new Error(`${target.kind} failed (seed ${seed})`));
            }
          });
          await flush();
          if (visibleBrandNotices(renderer).length > noticesBefore)
            bump('noticesShown');
        } else {
          trace.push('   ↳ nothing pending — no-op');
          await flush();
        }
        break;
      }
      case 'advance': {
        await commitFrame();
        await act(async () => {
          jest.advanceTimersByTime(step.ms);
        });
        await flush();
        break;
      }
      case 'flush':
        await commitFrame();
        await flush();
        break;
    }
    snapshotInvariants(`step ${index} ${describeStep(step)}`);
  }
  await commitFrame();

  // Drain: settle everything still pending, flush, then terminal checks.
  for (let guard = 0; guard < 20 && ledger.pending().length > 0; guard += 1) {
    const pending = ledger.pending();
    await act(async () => {
      for (const entry of pending) {
        entry.resolve(entry.kind === 'getAccess' ? access(0) : undefined);
      }
    });
    await flush();
  }
  await act(async () => {
    jest.advanceTimersByTime(5000);
  });
  await flush();
  snapshotInvariants('terminal');

  if (useAccessStore.getState().status === 'loading') {
    violations.push(
      'terminal: access store left in loading (orphan loading state)',
    );
  }
  if (ledger.pending().length > 0) {
    violations.push(
      `terminal: ${ledger.pending().length} deferred(s) never settled`,
    );
  }
  if (counters.signOutCalls !== counters.confirmFrames) {
    violations.push(
      `signOut called ${counters.signOutCalls}x for ${counters.confirmFrames} confirm frame(s)`,
    );
  }
  if (counters.openURLCalls !== counters.linkTaps) {
    violations.push(
      `openURL called ${counters.openURLCalls}x for ${counters.linkTaps} link tap(s)`,
    );
  }
  if (counters.replayCalls !== counters.walkthroughTaps) {
    violations.push(
      `walkthrough replay called ${counters.replayCalls}x for ${counters.walkthroughTaps} tap(s)`,
    );
  }
  if (counters.maxGetAccessInFlight! > 1) {
    violations.push(
      `getAccess in flight peaked at ${counters.maxGetAccessInFlight}`,
    );
  }
  if (counters.getAccessCalls! > counters.focusEvents!) {
    violations.push(
      `${counters.getAccessCalls} getAccess call(s) for ${counters.focusEvents} Settings focus event(s)`,
    );
  }
  if (consoleMessages.length > 0) {
    violations.push(`console: ${consoleMessages.join(' | ')}`);
  }
  if (unhandled.length > 0) {
    violations.push(`unhandledRejection: ${unhandled.join(' | ')}`);
  }

  act(() => renderer.unmount());
  await flush();
  process.off('unhandledRejection', onUnhandled);
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  openURL.mockRestore();
  useAuthStore.setState({ signOut: realSignOut });
  useWalkthroughStore.setState({
    replay: realReplay,
    visible: false,
    queued: false,
  });
  clearAccessStoreConfiguration();

  return {
    seed,
    layout,
    steps: steps.length,
    frames: counters.frames!,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
    counters,
    trace,
  };
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const ITERATIONS = Number(process.env.STRESS_ITER ?? '40');
const SEED_BASE = Number(process.env.STRESS_SEED_BASE ?? '1000');
const SINGLE_SEED = process.env.STRESS_SEED
  ? Number(process.env.STRESS_SEED)
  : null;
const OUT_PATH = process.env.STRESS_OUT ?? null;
const KEEP_TRACES = process.env.STRESS_TRACE === '1';

const seeds =
  SINGLE_SEED !== null
    ? [SINGLE_SEED]
    : Array.from({ length: ITERATIONS }, (_, i) => SEED_BASE + i);

describe('SettingsScreen rapid-interaction stress (real RootNavigator)', () => {
  const results: BurstOutcome[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  afterAll(() => {
    if (!OUT_PATH) return;
    const totals: Record<string, number> = {};
    for (const result of results) {
      for (const [key, value] of Object.entries(result.counters)) {
        totals[key] = key.startsWith('max')
          ? Math.max(totals[key] ?? 0, value)
          : (totals[key] ?? 0) + value;
      }
    }
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(
      OUT_PATH,
      JSON.stringify(
        {
          unit: 'scr-settingsscreen',
          lens: 'rapid-interaction',
          suite:
            'apps/mobile/__tests__/stress/settingsScreenRapidInteraction.stress.test.tsx',
          seedBase: SINGLE_SEED ?? SEED_BASE,
          iterations: results.length,
          held: results.filter(r => r.outcome === 'HELD').length,
          broken: results.filter(r => r.outcome === 'BROKEN').length,
          totalSteps: results.reduce((sum, r) => sum + r.steps, 0),
          totalFrames: results.reduce((sum, r) => sum + r.frames, 0),
          totals,
          results: results.map(r => ({
            seed: r.seed,
            layout: r.layout,
            steps: r.steps,
            frames: r.frames,
            outcome: r.outcome,
            violations: r.violations,
            counters: r.counters,
            ...(r.outcome === 'BROKEN' || KEEP_TRACES
              ? { trace: r.trace }
              : {}),
          })),
        },
        null,
        2,
      ),
    );
  });

  it.each(seeds)(
    'seed %i: every rapid-interaction invariant holds',
    async seed => {
      const outcome = await runIteration(seed);
      results.push(outcome);
      if (outcome.outcome !== 'HELD') {
        throw new Error(
          `seed ${seed} (${outcome.layout}) BROKEN:\n  ${outcome.violations.join(
            '\n  ',
          )}\ntrace:\n${outcome.trace.join('\n')}`,
        );
      }
    },
  );
});

// ─── Minimized repro of the one failure mode the campaign found ──────────────
//
// Campaign seeds 1013, 1034, 1107, 1138, 1173, 1200, 1204, 1209, 1252, 1286
// (STRESS_ITER=300) all reduce to this: two confirm taps on the sign-out sheet
// delivered in ONE frame — both `onConfirm` handlers run before React commits
// `setConfirmingSignOut(false)` — call `signOut()` twice
// (SettingsScreen.tsx `<SignOutSheet onConfirm={...}>`). A second tap in the
// NEXT frame is harmless: the sheet is gone and the navigator has been
// swapped out with the session, so the tap hits nothing (asserted below).
describe('SettingsScreen sign-out confirm — minimized rapid-tap repro', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('two confirm taps in the same frame sign out once (minimized from seed 1034)', async () => {
    const outcome = await runIteration(1034, {
      layout: 'guest',
      steps: [
        { kind: 'tapSignOut', sameFrame: false },
        { kind: 'tapSheet', control: 'confirm', sameFrame: false },
        { kind: 'tapSheet', control: 'confirm', sameFrame: true },
      ],
    });
    if (outcome.outcome !== 'HELD') {
      throw new Error(
        `BROKEN:\n  ${outcome.violations.join('\n  ')}\ntrace:\n${outcome.trace.join('\n')}`,
      );
    }
  });

  it('two confirm taps in consecutive frames sign out once', async () => {
    const outcome = await runIteration(1034, {
      layout: 'synced',
      steps: [
        { kind: 'tapSignOut', sameFrame: false },
        { kind: 'tapSheet', control: 'confirm', sameFrame: false },
        { kind: 'tapSheet', control: 'confirm', sameFrame: false },
        { kind: 'settle', target: 'signOut', ok: true },
      ],
    });
    expect(outcome.counters.signOutCalls).toBe(1);
    expect(outcome.violations).toEqual([]);
  });
});
