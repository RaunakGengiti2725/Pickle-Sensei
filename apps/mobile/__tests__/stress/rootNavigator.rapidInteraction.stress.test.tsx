/**
 * STRESS — cmp-navigation / lens `rapid-interaction` / RootNavigator.
 *
 * Renders the REAL RootNavigator on the REAL React Navigation runtime
 * (NavigationContainer + native-stack + bottom-tabs routers, PremiumTabBar as
 * the tab bar, the Analyze/Paywall/ConnectAccount route wrappers) with every
 * screen replaced by a recording stub. A seeded generator then fires bursts
 * of: tab taps (double/triple, batched into one act()), COACH menu taps during
 * the close transition, `navigationRef` spam with deep-fuzzed params for every
 * RootStackParams route, back / popToTop while the access gate is still
 * loading, Paywall close/purchase double-taps, ConnectAccount back, reminder
 * presses, and access/auth store flips at arbitrary points.
 *
 * UI presses are only delivered while `Tabs` is the focused root route (a
 * user cannot tap a tab bar that a pushed screen covers); `navigationRef`
 * actions, store flips and reminder presses can arrive at any time.
 *
 * Invariants (checked after every batch and again after settling):
 *   - nothing throws; no console.error / console.warn (act() warnings,
 *     "action not handled", key warnings); no unhandled rejection;
 *   - root stack is well-formed: Tabs at index 0, index === last, unique
 *     keys, every route registered, `Tabs` present EXACTLY ONCE;
 *   - the tab navigator keeps its 5 routes and a valid index;
 *   - exactly one PremiumTabBar and at most one visible COACH menu Modal;
 *   - no orphan loading: once the access store is terminal, an Analyze route
 *     either renders AnalyzeScreen or has been replaced;
 *   - after unmount, flushing the remaining timers is silent.
 *
 * Other root routes appearing twice (e.g. `Analyze` pushed from the ref while
 * an older `Analyze` sits lower in the stack) is React Navigation 7's
 * documented `navigate` semantics for programmatic pushes and is COUNTED
 * (info.duplicateRouteViaRef), not failed.
 *
 * Known defects. Two paths reproducibly break these invariants on the real
 * router; each is pinned as a deterministic `it.failing` in
 * rootNavigator.knownDefects.stress.test.tsx (flips red the moment it is
 * fixed). So that this campaign stays green and keeps hunting NEW failures,
 * the default STRESS_SKIP excludes exactly those paths:
 *   reminder, navigate:Tabs — KD-1: navigate('Tabs') from a pushed screen
 *                             pushes a SECOND MainTabs host;
 *   gateWhileCovered        — KD-2/KD-3: useRatingRouteGate's `replace` acts
 *                             on the FOCUSED route, so if `Analyze` is covered
 *                             when its gate fires (a store flip while covered,
 *                             or a second push in the same frame as the flip /
 *                             the Analyze push) the wrong route is replaced
 *                             and Analyze is orphaned in loading.
 * `STRESS_SKIP=none` runs the strict campaign (the failing seeds are the
 * reproductions reported alongside the pins).
 *
 * Replay:   STRESS_SEED=<seed> npx jest --ci __tests__/stress/rootNavigator.rapid
 * Scale:    STRESS_ITER=1000 npx jest --ci __tests__/stress/rootNavigator.rapid
 * Strict:   STRESS_SKIP=none STRESS_ITER=300 …
 * Isolate:  STRESS_SKIP=<comma list of action kinds / navigate:<Route> /
 *           gateWhileCovered>
 */
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-safe-area-context', () => {
  const mock = require('react-native-safe-area-context/jest/mock');
  return mock.default ?? mock;
});
// Share RootNavigator's module-private navigationRef with the test.
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  const shared = actual.createNavigationContainerRef();
  return { ...actual, createNavigationContainerRef: () => shared };
});

const SCREEN_MODULES = [
  'HomeScreen',
  'LibraryScreen',
  'ProgressScreen',
  'SettingsScreen',
  'AnalyzeScreen',
  'DrillLibraryScreen',
  'ResultScreen',
  'ResultDetailsScreen',
  'FormReviewScreen',
  'StreakCalendarScreen',
  'PaywallScreen',
  'SignInScreen',
  'ManageAccountScreen',
  'ConsentSettingsScreen',
  'NotificationSettingsScreen',
] as const;
type ScreenName = (typeof SCREEN_MODULES)[number];

jest.mock('../../src/screens/HomeScreen', () => ({
  HomeScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'HomeScreen' },
  ),
}));
jest.mock('../../src/screens/LibraryScreen', () => ({
  LibraryScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'LibraryScreen' },
  ),
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'ProgressScreen' },
  ),
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'SettingsScreen' },
  ),
}));
jest.mock('../../src/screens/AnalyzeScreen', () => ({
  AnalyzeScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'AnalyzeScreen' },
  ),
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'DrillLibraryScreen' },
  ),
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  ResultScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'ResultScreen' },
  ),
}));
jest.mock('../../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'ResultDetailsScreen' },
  ),
}));
jest.mock('../../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'FormReviewScreen' },
  ),
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'StreakCalendarScreen' },
  ),
}));
jest.mock('../../src/screens/PaywallScreen', () => ({
  PaywallScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'PaywallScreen' },
  ),
}));
jest.mock('../../src/screens/SignInScreen', () => ({
  SignInScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'SignInScreen' },
  ),
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'ManageAccountScreen' },
  ),
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'ConsentSettingsScreen' },
  ),
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: Object.defineProperty(
    jest.fn(() => null),
    'name',
    { value: 'NotificationSettingsScreen' },
  ),
}));

let mockNotificationPress: ((target: 'Home' | 'Performance') => void) | null =
  null;
jest.mock('../../src/notifications/service', () => ({
  subscribeToNotificationPresses: (
    cb: (target: 'Home' | 'Performance') => void,
  ) => {
    mockNotificationPress = cb;
    return () => {
      mockNotificationPress = null;
    };
  },
}));

type AccessStatus = 'idle' | 'loading' | 'ready' | 'unconfigured' | 'error';
type MockAccessState = {
  status: AccessStatus;
  canonicalAccess: { canStartRating: boolean } | null;
  initialize: () => Promise<void>;
};
jest.mock('../../src/state/accessStore', () => {
  const { create } = require('zustand');
  return {
    useAccessStore: create(() => ({
      status: 'ready',
      canonicalAccess: { canStartRating: true },
      initialize: async () => {},
    })),
  };
});
type MockAuthState = {
  session: { provider: string; localOnly: boolean } | null;
};
jest.mock('../../src/auth/authStore', () => {
  const { create } = require('zustand');
  return {
    useAuthStore: create(() => ({
      session: { provider: 'apple', localOnly: false },
    })),
  };
});
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    legalTermsUrl: 'https://api.example.test/terms',
    legalPrivacyUrl: 'https://api.example.test/privacy',
  }),
}));

import React from 'react';
import { Modal, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { StoreApi, UseBoundStore } from 'zustand';
import {
  createNavigationContainerRef,
  StackActions,
  type NavigationState,
} from '@react-navigation/native';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import type {
  MainTabParams,
  RootStackParams,
} from '../../src/navigation/params';
import {
  campaignConfig,
  campaignSeeds,
  FUZZ_STRINGS,
  invariant,
  InvariantViolation,
  minimizeScript,
  NoiseCapture,
  SeededRng,
  summarize,
  writeTable,
  type IterationOutcome,
} from '../../__harness__/stress/rapidInteraction.harness';

const SUITE = 'rootNavigator.rapidInteraction';
const navigationRef = createNavigationContainerRef<RootStackParams>();
const useMockAccessStore = (
  jest.requireMock('../../src/state/accessStore') as {
    useAccessStore: UseBoundStore<StoreApi<MockAccessState>>;
  }
).useAccessStore;
const useMockAuthStore = (
  jest.requireMock('../../src/auth/authStore') as {
    useAuthStore: UseBoundStore<StoreApi<MockAuthState>>;
  }
).useAuthStore;

type ScreenStub = jest.Mock<null, [Record<string, unknown>]>;
const screens = Object.fromEntries(
  SCREEN_MODULES.map(name => [
    name,
    (
      jest.requireMock(`../../src/screens/${name}`) as Record<
        string,
        ScreenStub
      >
    )[name],
  ]),
) as Record<ScreenName, ScreenStub>;

const ROOT_ROUTES: (keyof RootStackParams)[] = [
  'Tabs',
  'Analyze',
  'Result',
  'ResultDetails',
  'FormReview',
  'DrillLibrary',
  'StreakCalendar',
  'ConnectAccount',
  'ManageAccount',
  'ConsentSettings',
  'NotificationSettings',
  'Paywall',
];
const TAB_ROUTES: (keyof MainTabParams)[] = [
  'Home',
  'Library',
  'Add',
  'Performance',
  'Settings',
];
const TAB_LABEL: Record<Exclude<keyof MainTabParams, 'Add'>, string> = {
  Home: 'Home',
  Library: 'Library',
  Performance: 'Progress',
  Settings: 'Settings',
};
const COACH_ACTIONS = [
  'Auto Analyze',
  'Import Video',
  'Drill Library',
] as const;

// ─── Script ──────────────────────────────────────────────────────────────────

type Action =
  | { t: 'tab'; which: Exclude<keyof MainTabParams, 'Add'> }
  | { t: 'fab' }
  | { t: 'overlayFab' }
  | { t: 'backdrop' }
  | { t: 'menuBack' }
  | { t: 'coach'; which: (typeof COACH_ACTIONS)[number] }
  | { t: 'navigate'; route: keyof RootStackParams; params: unknown }
  | { t: 'goBack' }
  | { t: 'pop'; count: number }
  | { t: 'popToTop' }
  | {
      t: 'paywall';
      which: 'onClose' | 'onPurchased' | 'onOpenTerms' | 'onOpenPrivacy';
    }
  | { t: 'connectBack' }
  | { t: 'reminder'; target: 'Home' | 'Performance' }
  | { t: 'access'; status: AccessStatus; canStart: boolean | null }
  | { t: 'resolveAccess'; canStart: boolean | 'error' }
  | { t: 'auth'; session: 'apple' | 'google' | 'guest' | 'none' }
  | { t: 'advance'; ms: number }
  | { t: 'flush' };
type Batch = Action[];

const ADVANCES = [0, 1, 16, 100, 209, 210, 211, 500];

function fuzzParams(rng: SeededRng, route: keyof RootStackParams): unknown {
  const str = () => rng.pick(FUZZ_STRINGS);
  switch (route) {
    case 'Tabs':
      return rng.chance(0.3)
        ? undefined
        : {
            screen: rng.pick(TAB_ROUTES),
            ...(rng.chance(0.3) ? { params: undefined } : {}),
          };
    case 'Analyze':
      return rng.chance(0.3)
        ? undefined
        : { source: rng.pick(['camera', 'library'] as const) };
    case 'Result':
    case 'ResultDetails':
      return { analysisId: str() };
    case 'FormReview':
      return rng.chance(0.5)
        ? { analysisId: str() }
        : { analysisId: str(), phase: str() };
    case 'Paywall':
      return rng.chance(0.3)
        ? undefined
        : { source: rng.pick(['rating', 'training', 'settings'] as const) };
    default:
      return undefined;
  }
}

function randomAction(rng: SeededRng): Action {
  return rng.weighted<Action>([
    [
      10,
      {
        t: 'tab',
        which: rng.pick([
          'Home',
          'Library',
          'Performance',
          'Settings',
        ] as const),
      },
    ],
    [8, { t: 'fab' }],
    [3, { t: 'overlayFab' }],
    [4, { t: 'backdrop' }],
    [2, { t: 'menuBack' }],
    [10, { t: 'coach', which: rng.pick(COACH_ACTIONS) }],
    [
      10,
      (() => {
        const route = rng.pick(ROOT_ROUTES);
        return {
          t: 'navigate',
          route,
          params: fuzzParams(rng, route),
        } as Action;
      })(),
    ],
    [8, { t: 'goBack' }],
    [2, { t: 'pop', count: 1 + rng.int(3) }],
    [2, { t: 'popToTop' }],
    [
      5,
      {
        t: 'paywall',
        which: rng.weighted([
          [5, 'onClose'],
          [3, 'onPurchased'],
          [1, 'onOpenTerms'],
          [1, 'onOpenPrivacy'],
        ] as const),
      },
    ],
    [3, { t: 'connectBack' }],
    [2, { t: 'reminder', target: rng.pick(['Home', 'Performance'] as const) }],
    [
      4,
      {
        t: 'access',
        status: rng.pick([
          'idle',
          'loading',
          'ready',
          'unconfigured',
          'error',
        ] as const),
        canStart: rng.pick([true, false, null]),
      },
    ],
    [
      4,
      {
        t: 'resolveAccess',
        canStart: rng.pick([true, false, 'error'] as const),
      },
    ],
    [
      3,
      {
        t: 'auth',
        session: rng.pick(['apple', 'google', 'guest', 'none'] as const),
      },
    ],
    [6, { t: 'advance', ms: rng.pick(ADVANCES) }],
    [3, { t: 'flush' }],
  ]);
}

const KNOWN_DEFECT_SKIPS = 'reminder,navigate:Tabs,gateWhileCovered';
const SKIP = new Set(
  (process.env.STRESS_SKIP ?? KNOWN_DEFECT_SKIPS)
    .split(',')
    .map(s => s.trim())
    .filter(s => s && s !== 'none'),
);

function skipped(action: Action): boolean {
  if (SKIP.has(action.t)) return true;
  return action.t === 'navigate' && SKIP.has(`navigate:${action.route}`);
}

function nextAction(rng: SeededRng): Action {
  for (;;) {
    const action = randomAction(rng);
    if (!skipped(action)) return action;
  }
}

function generateScript(rng: SeededRng): Batch[] {
  const batches: Batch[] = [];
  const length = 5 + rng.int(20);
  for (let i = 0; i < length; i += 1) {
    const size = rng.weighted([
      [6, 1],
      [2, 2],
      [1, 3],
      [1, 4],
    ] as const);
    const batch: Batch = [];
    for (let j = 0; j < size; j += 1) batch.push(nextAction(rng));
    if (rng.chance(0.3) && !['advance', 'flush'].includes(batch[0]!.t)) {
      const copies = 1 + rng.int(2);
      for (let c = 0; c < copies; c += 1) batch.push(batch[0]!);
    }
    batches.push(batch);
    if (rng.chance(0.4))
      batches.push([{ t: 'advance', ms: rng.pick(ADVANCES) }]);
  }
  return batches;
}

function short(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > 40 ? `${text.slice(0, 37)}…` : text;
}

function describeAction(action: Action): string {
  switch (action.t) {
    case 'tab':
    case 'coach':
    case 'paywall':
      return `${action.t}:${action.which}`;
    case 'navigate':
      return `navigate:${action.route}${action.params === undefined ? '' : `(${short(action.params)})`}`;
    case 'pop':
      return `pop:${action.count}`;
    case 'reminder':
      return `reminder:${action.target}`;
    case 'access':
      return `access:${action.status}/${String(action.canStart)}`;
    case 'resolveAccess':
      return `resolveAccess:${String(action.canStart)}`;
    case 'auth':
      return `auth:${action.session}`;
    case 'advance':
      return `advance:${action.ms}`;
    default:
      return action.t;
  }
}

// ─── Execution ───────────────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;
type Node = TestRenderer.ReactTestInstance;

function outermost(nodes: Node[]): Node[] {
  const set = new Set(nodes);
  return nodes.filter(node => {
    for (let p = node.parent; p; p = p.parent) if (set.has(p)) return false;
    return true;
  });
}

function pressablesByLabel(renderer: Renderer, label: string) {
  return outermost(
    renderer.root.findAll(
      n =>
        n.props.accessibilityLabel === label &&
        typeof n.props.onPress === 'function',
    ),
  );
}

function insideModal(node: Node): boolean {
  for (let p = node.parent; p; p = p.parent) if (p.type === Modal) return true;
  return false;
}

function fabs(renderer: Renderer) {
  return [
    ...pressablesByLabel(renderer, 'Open coach actions'),
    ...pressablesByLabel(renderer, 'Close coach actions'),
  ].filter(n => n.props.accessibilityState?.expanded !== undefined);
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(n => n.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

type Run = {
  renderer: Renderer;
  info: Record<string, number>;
  /** Pending initialize() calls waiting for a `resolveAccess` action. */
  pendingInit: number;
};

function bump(run: Run, key: string) {
  run.info[key] = (run.info[key] ?? 0) + 1;
}

function rootState(): NavigationState<RootStackParams> {
  invariant(navigationRef.isReady(), () => 'navigationRef not ready');
  return navigationRef.getRootState() as NavigationState<RootStackParams>;
}

function lastProps(stub: ScreenStub): Record<string, unknown> | null {
  const call = stub.mock.calls.at(-1);
  return call ? call[0] : null;
}

const UI_ACTIONS = new Set<Action['t']>([
  'tab',
  'fab',
  'overlayFab',
  'backdrop',
  'menuBack',
  'coach',
]);
const STORE_FLIPS = new Set<Action['t']>(['access', 'resolveAccess', 'auth']);

function focusedRoute(): keyof RootStackParams {
  const state = rootState();
  return state.routes[state.index]!.name;
}

function tabsFocused(): boolean {
  return focusedRoute() === 'Tabs';
}

function analyzeCovered(): boolean {
  return (
    focusedRoute() !== 'Analyze' &&
    rootState().routes.some(r => r.name === 'Analyze')
  );
}

/** Mirrors useRatingRouteGate: will its effect redirect for the CURRENT stores? */
function gateWillRedirect(): boolean {
  const access = useMockAccessStore.getState();
  if (useMockAuthStore.getState().session?.localOnly === true) return true;
  if (access.canonicalAccess?.canStartRating === true) return false;
  if (access.status === 'idle') return false;
  return (
    access.canonicalAccess !== null ||
    access.status === 'ready' ||
    access.status === 'unconfigured' ||
    access.status === 'error'
  );
}

const COVERING_PUSHES = new Set<Action['t']>(['navigate', 'reminder']);

function applyAction(run: Run, action: Action) {
  const { renderer } = run;
  if (UI_ACTIONS.has(action.t) && !tabsFocused()) return bump(run, 'skipped');
  if (SKIP.has('gateWhileCovered')) {
    if (STORE_FLIPS.has(action.t) && analyzeCovered())
      return bump(run, 'skippedGateWhileCovered');
    // A push landing in the same frame as a pending redirect covers Analyze
    // before its effect runs — same defect, different trigger.
    if (
      COVERING_PUSHES.has(action.t) &&
      focusedRoute() === 'Analyze' &&
      gateWillRedirect()
    ) {
      return bump(run, 'skippedGateWhileCovered');
    }
  }
  switch (action.t) {
    case 'tab': {
      const [node] = pressablesByLabel(renderer, TAB_LABEL[action.which]);
      invariant(node, () => `tab ${action.which} not rendered`);
      node.props.onPress();
      bump(run, 'tabPress');
      return;
    }
    case 'fab': {
      const bar = fabs(renderer).filter(n => !insideModal(n));
      invariant(
        bar.length === 1,
        () => `${bar.length} in-bar COACH buttons rendered`,
      );
      bar[0]!.props.onPress();
      bump(
        run,
        bar[0]!.props.accessibilityState.expanded ? 'fabClose' : 'fabOpen',
      );
      return;
    }
    case 'overlayFab': {
      const node = fabs(renderer).find(insideModal);
      if (!node) return bump(run, 'skipped');
      node.props.onPress();
      bump(run, 'overlayFab');
      return;
    }
    case 'backdrop': {
      const node = pressablesByLabel(renderer, 'Close coach actions').find(
        n => n.props.accessibilityState?.expanded === undefined,
      );
      if (!node) return bump(run, 'skipped');
      node.props.onPress();
      bump(run, 'backdrop');
      return;
    }
    case 'menuBack': {
      const modal = renderer.root
        .findAllByType(Modal)
        .find(m => m.props.visible === true);
      if (!modal) return bump(run, 'skipped');
      modal.props.onRequestClose();
      bump(run, 'menuBack');
      return;
    }
    case 'coach': {
      const [row] = pressablesByLabel(renderer, action.which);
      if (!row) return bump(run, 'skipped');
      row.props.onPress();
      bump(run, 'coachAction');
      return;
    }
    case 'navigate': {
      // The typed overload set does not admit a generic (route, unknown) call.
      (navigationRef.navigate as (name: string, params?: unknown) => void)(
        action.route,
        action.params,
      );
      bump(run, `navigate:${action.route}`);
      return;
    }
    case 'goBack': {
      if (!navigationRef.canGoBack()) return bump(run, 'skipped');
      navigationRef.goBack();
      bump(run, 'goBack');
      return;
    }
    case 'pop': {
      // canGoBack() is also true when only the tab navigator can go back
      // (backBehavior firstRoute); POP/POP_TO_TOP need a root stack depth.
      if (rootState().index === 0) return bump(run, 'skipped');
      navigationRef.dispatch(
        StackActions.pop(Math.min(action.count, rootState().index)),
      );
      bump(run, 'pop');
      return;
    }
    case 'popToTop': {
      if (rootState().index === 0) return bump(run, 'skipped');
      navigationRef.dispatch(StackActions.popToTop());
      bump(run, 'popToTop');
      return;
    }
    case 'paywall': {
      if (focusedRoute() !== 'Paywall') return bump(run, 'skipped');
      const props = lastProps(screens.PaywallScreen);
      const handler = props?.[action.which];
      if (typeof handler !== 'function') return bump(run, 'skipped');
      handler();
      bump(run, `paywall:${action.which}`);
      return;
    }
    case 'connectBack': {
      if (focusedRoute() !== 'ConnectAccount') return bump(run, 'skipped');
      const props = lastProps(screens.SignInScreen);
      const handler = props?.onBack;
      if (typeof handler !== 'function') return bump(run, 'skipped');
      handler();
      bump(run, 'connectBack');
      return;
    }
    case 'reminder': {
      invariant(mockNotificationPress, () => 'reminder subscription missing');
      mockNotificationPress(action.target);
      bump(run, 'reminder');
      return;
    }
    case 'access': {
      useMockAccessStore.setState({
        status: action.status,
        canonicalAccess:
          action.canStart === null ? null : { canStartRating: action.canStart },
      });
      bump(run, 'accessFlip');
      return;
    }
    case 'resolveAccess': {
      if (
        run.pendingInit === 0 &&
        useMockAccessStore.getState().status !== 'loading'
      ) {
        return bump(run, 'skipped');
      }
      run.pendingInit = 0;
      useMockAccessStore.setState(
        action.canStart === 'error'
          ? { status: 'error', canonicalAccess: null }
          : {
              status: 'ready',
              canonicalAccess: { canStartRating: action.canStart },
            },
      );
      bump(run, 'accessResolved');
      return;
    }
    case 'auth': {
      useMockAuthStore.setState({
        session:
          action.session === 'none'
            ? null
            : {
                provider: action.session,
                localOnly: action.session === 'guest',
              },
      });
      bump(run, 'authFlip');
      return;
    }
    case 'advance':
      jest.advanceTimersByTime(action.ms);
      bump(run, 'advance');
      return;
    case 'flush':
      bump(run, 'flush');
      return;
  }
}

function checkInvariants(run: Run, where: string) {
  const { renderer } = run;
  const state = rootState();
  invariant(
    state.type === 'stack',
    () => `${where}: root state type ${state.type}`,
  );
  invariant(state.routes.length >= 1, () => `${where}: empty root stack`);
  invariant(
    state.routes[0]!.name === 'Tabs',
    () => `${where}: root[0] is ${state.routes[0]!.name}`,
  );
  invariant(
    state.index === state.routes.length - 1,
    () =>
      `${where}: stack index ${state.index} ≠ last (${state.routes.length - 1})`,
  );
  const keys = new Set(state.routes.map(r => r.key));
  invariant(
    keys.size === state.routes.length,
    () => `${where}: duplicate route keys`,
  );
  const names = state.routes.map(r => r.name);
  for (const name of names) {
    invariant(
      ROOT_ROUTES.includes(name),
      () => `${where}: unknown route ${name} in stack`,
    );
  }
  const tabsCount = names.filter(name => name === 'Tabs').length;
  invariant(
    tabsCount === 1,
    () =>
      `${where}: "Tabs" appears ${tabsCount}× in the root stack — a second MainTabs host was pushed: [${names.join(' > ')}]`,
  );
  if (names.some((name, i) => names.indexOf(name) !== i))
    bump(run, 'duplicateRouteViaRef');
  const tabs = state.routes[0]!.state;
  if (tabs) {
    invariant(
      JSON.stringify(tabs.routeNames) === JSON.stringify(TAB_ROUTES),
      () => `${where}: tab routes ${JSON.stringify(tabs.routeNames)}`,
    );
    invariant(
      typeof tabs.index === 'number' &&
        tabs.index >= 0 &&
        tabs.index < TAB_ROUTES.length,
      () => `${where}: tab index ${String(tabs.index)}`,
    );
    if (tabs.routes[tabs.index!]!.name === 'Add') bump(run, 'focusedAddTab');
  }
  const barFabs = fabs(renderer).filter(n => !insideModal(n));
  invariant(
    barFabs.length === 1,
    () => `${where}: ${barFabs.length} PremiumTabBar instances mounted`,
  );
  const visibleModals = renderer.root
    .findAllByType(Modal)
    .filter(m => m.props.visible === true);
  invariant(
    visibleModals.length <= 1,
    () => `${where}: ${visibleModals.length} modals visible at once`,
  );
  if (visibleModals.length === 1) bump(run, 'menuVisibleAfterBatch');
  if (names.length > 1) bump(run, 'stackDepthAboveTabs');
}

function checkNoOrphanLoading(run: Run, where: string) {
  const { renderer } = run;
  const state = rootState();
  const access = useMockAccessStore.getState();
  const analyzeMounted = state.routes.some(r => r.name === 'Analyze');
  const loading = allText(renderer).includes('Checking access…');
  if (!analyzeMounted) {
    invariant(
      !loading,
      () => `${where}: "Checking access…" rendered without an Analyze route`,
    );
    return;
  }
  const terminal =
    access.status === 'ready' ||
    access.status === 'error' ||
    access.status === 'unconfigured';
  if (!terminal) return;
  const localOnly = useMockAuthStore.getState().session?.localOnly === true;
  invariant(
    !loading,
    () =>
      `${where}: orphan loading — Analyze still shows "Checking access…" with access ${access.status}/${JSON.stringify(access.canonicalAccess)} localOnly=${localOnly}; stack [${state.routes.map(r => r.name).join(' > ')}]`,
  );
  invariant(
    screens.AnalyzeScreen.mock.calls.length > 0 ||
      access.canonicalAccess?.canStartRating !== true,
    () => `${where}: Analyze allowed but AnalyzeScreen never rendered`,
  );
}

function runScript(script: Batch[]): {
  failure: string | null;
  info: Record<string, number>;
  actions: number;
} {
  jest.useFakeTimers();
  const run: Run = {
    renderer: null as unknown as Renderer,
    info: {},
    pendingInit: 0,
  };
  for (const stub of Object.values(screens)) stub.mockClear();
  useMockAccessStore.setState({
    status: 'ready',
    canonicalAccess: { canStartRating: true },
    initialize: async () => {
      run.pendingInit += 1;
      useMockAccessStore.setState({ status: 'loading' });
    },
  });
  useMockAuthStore.setState({
    session: { provider: 'apple', localOnly: false },
  });
  const noise = new NoiseCapture();
  noise.start();
  let mounted = false;
  let actions = 0;
  try {
    act(() => {
      run.renderer = TestRenderer.create(<RootNavigator />);
    });
    mounted = true;
    checkInvariants(run, 'mount');
    let step = 0;
    for (const batch of script) {
      step += 1;
      const where = `step ${step} (${batch.map(describeAction).join('+')})`;
      act(() => {
        for (const action of batch) {
          actions += 1;
          applyAction(run, action);
        }
      });
      checkInvariants(run, where);
      checkNoOrphanLoading(run, where);
    }
    // Settle: resolve any in-flight access lookup, let every timer fire.
    const access = useMockAccessStore.getState();
    if (access.status === 'idle' || access.status === 'loading') {
      act(() => {
        useMockAccessStore.setState({
          status: 'ready',
          canonicalAccess: { canStartRating: true },
        });
      });
      run.pendingInit = 0;
    }
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    checkInvariants(run, 'settle');
    checkNoOrphanLoading(run, 'settle');
    const menu = run.renderer.root
      .findAllByType(Modal)
      .find(m => m.props.visible === true);
    if (menu) {
      // A menu that is still open after settling with no in-flight close is a
      // user-left-it-open state, which is fine; a menu that is closing must
      // have finished.
      const bar = fabs(run.renderer).filter(n => !insideModal(n));
      invariant(
        bar[0]!.props.accessibilityState.expanded === true,
        () =>
          'menu visible after settle but FAB reports closed (close transition never completed)',
      );
    }
    act(() => run.renderer.unmount());
    mounted = false;
    // The RN jest preset's NativeAnimated mock schedules 16 ms callbacks for
    // every Animated call, so a non-zero count here is environmental; what
    // must hold is that flushing them after unmount is silent.
    run.info.timersPendingAfterUnmount = jest.getTimerCount();
    act(() => {
      jest.runOnlyPendingTimers();
    });
    const noiseReport = noise.report();
    invariant(
      noiseReport === null,
      () => `console/rejection noise:\n${noiseReport}`,
    );
    return { failure: null, info: run.info, actions };
  } catch (error) {
    const message =
      error instanceof InvariantViolation
        ? error.message
        : `thrown: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
    return { failure: message, info: run.info, actions };
  } finally {
    if (mounted) {
      try {
        act(() => run.renderer.unmount());
      } catch {
        // already reported
      }
    }
    noise.stop();
    jest.clearAllTimers();
    jest.useRealTimers();
  }
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const config = campaignConfig(160);
const seeds = campaignSeeds(config);
const results: IterationOutcome[] = [];

describe('stress/rapid-interaction: RootNavigator seeded bursts on the real router', () => {
  afterAll(() => {
    writeTable(config, summarize(SUITE, config, results));
  });

  it.each(seeds.map((seed, i) => [i, seed] as const))(
    'iteration %i (seed %i) — well-formed stack, no duplicate route, no orphan loading, no console noise',
    (_iteration, seed) => {
      const script = generateScript(new SeededRng(seed));
      const { failure, info, actions } = runScript(script);
      const flat = script.map(batch => batch.map(describeAction).join('+'));
      results.push({
        seed,
        outcome: failure ? 'fail' : 'pass',
        actions,
        script: flat,
        ...(failure ? { failure } : {}),
        info,
      });
      if (failure && config.minimize) {
        const minimal = minimizeScript(script, s => runScript(s).failure);
        throw new Error(
          `seed ${seed} FAILED: ${failure}\nminimal script (${minimal.script.length} batches):\n${minimal.script
            .map(b => '  ' + b.map(describeAction).join('+'))
            .join('\n')}\nminimal failure: ${minimal.failure}`,
        );
      }
      if (failure) {
        throw new Error(
          `seed ${seed} FAILED: ${failure}\nscript:\n${flat.map(s => '  ' + s).join('\n')}`,
        );
      }
    },
  );
});
