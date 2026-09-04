/**
 * STRESS · failure injection · PaywallScreen inside the real navigator.
 *
 * The real RootNavigator (real @react-navigation container + native stack,
 * real PaywallRoute, real AnalyzeRoute rating gate) renders the real
 * PaywallScreen against the real accessStore and the real billing clients.
 * Only the leaf dependencies are replaced: the native RevenueCat SDK, the
 * backend `fetch`, and `Linking.openURL`. Sibling screens that are not on
 * the paywall's path are stubbed with markers (the repo's navigator-test
 * convention) so the suite does not drag SQLite-backed stores into scope;
 * the native SQLite / Keychain / purchases modules are registered as
 * THROWING mocks and the suite asserts none of them was ever called.
 *
 * Every iteration is a seeded scenario (see test-support/stress/
 * paywallFaultModel.ts): one or more faults — throw / reject / timeout /
 * malformed / partial / slow / never-resolves / HTTP 401 429 500 503 /
 * non-JSON — are injected into the store SDK, the backend, or the link
 * opener during initialisation and/or during purchase / restore / legal
 * link, optionally with a mid-flight unmount (user closes the paywall) or a
 * mid-flight sign-out. After every checkpoint the fake clock is advanced
 * 60 s and the oracles run:
 *
 *   - no infinite spinner (no BrandSpinner / progressbar after 60 s)
 *   - a visible, enabled back/close control while the paywall is open
 *   - failures are never silent (error card or "unavailable" copy rendered)
 *   - retry is visible + enabled whenever plans / canonical access are
 *     missing (a failure with data intact recovers via Continue / Restore)
 *   - no fake success (paywall dismissed / "MEMBERSHIP VERIFIED" only after
 *     the BACKEND verified premium — the store-local entitlement never
 *     unlocks anything)
 *   - store state stays internally consistent (no corrupted state)
 *   - after the faults clear, "Try again" (or re-entering) recovers to a
 *     purchasable pricing page
 *
 * Scale:   STRESS_ITER=<n>      random seeds (default 40; the fault-free
 *                               controls and the catalogue pass of every
 *                               site × mode always run)
 * Replay:  STRESS_SEED=<seed>   one random seed
 *          STRESS_ONLY=<id>     one scenario id (e.g. catalogue:api.getAccess:never)
 * Output:  STRESS_OUT=<dir>     JSON results (default apps/mobile/artifacts/stress)
 *          STRESS_COMMIT=<sha>  recorded in the JSON table
 *
 * A BROKEN iteration fails its Jest test with the seed / scenario id, the
 * violated oracles and the exact replay command.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Linking, Text } from 'react-native';

// ─── Native module doubles ───────────────────────────────────────────────────

jest.mock('react-native-linear-gradient', () => {
  const ReactLib = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-safe-area-context', () => {
  const ReactLib = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const passthrough = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(View, null, props.children);
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    SafeAreaInsetsContext: ReactLib.createContext(insets),
    SafeAreaFrameContext: ReactLib.createContext(frame),
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: { frame, insets },
  };
});
jest.mock('react-native-svg', () => {
  const ReactLib = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
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

// Dependencies that are NOT on the paywall's path (SQLite, Keychain, the
// native RevenueCat bridge). Their modules may be *loaded* transitively by
// the navigator's import graph, so the oracle is on *calls*: every entry
// point records itself in a global ledger and throws, and each iteration
// asserts the ledger did not grow.
const foreignCalls = (): string[] => {
  const g = globalThis as { __stressForeignCalls?: string[] };
  g.__stressForeignCalls ??= [];
  return g.__stressForeignCalls;
};
jest.mock('@op-engineering/op-sqlite', () => {
  const ledger = globalThis as { __stressForeignCalls?: string[] };
  return {
    open: () => {
      (ledger.__stressForeignCalls ??= []).push('op-sqlite.open');
      throw new Error('injected: SQLite unavailable');
    },
  };
});
jest.mock('react-native-keychain', () => {
  const ledger = globalThis as { __stressForeignCalls?: string[] };
  const refuse = (name: string) => () => {
    (ledger.__stressForeignCalls ??= []).push(`keychain.${name}`);
    return Promise.reject(new Error(`injected: Keychain ${name}`));
  };
  return {
    getGenericPassword: refuse('getGenericPassword'),
    setGenericPassword: refuse('setGenericPassword'),
    resetGenericPassword: refuse('resetGenericPassword'),
    ACCESSIBLE: { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'x' },
  };
});
jest.mock('react-native-purchases', () => {
  const ledger = globalThis as { __stressForeignCalls?: string[] };
  const refuse = (name: string) => () => {
    (ledger.__stressForeignCalls ??= []).push(`purchases.${name}`);
    throw new Error(`injected: native RevenueCat ${name} must not be reached`);
  };
  return {
    __esModule: true,
    default: {
      configure: refuse('configure'),
      isConfigured: refuse('isConfigured'),
      getOfferings: refuse('getOfferings'),
      purchasePackage: refuse('purchasePackage'),
      restorePurchases: refuse('restorePurchases'),
      getCustomerInfo: refuse('getCustomerInfo'),
      logIn: refuse('logIn'),
      getAppUserID: refuse('getAppUserID'),
      checkTrialOrIntroductoryPriceEligibility: refuse(
        'checkTrialOrIntroductoryPriceEligibility',
      ),
    },
  };
});

// Sibling screens (markers) and the notification native bridge.
function mockStubScreen(name: string) {
  const ReactLib = require('react') as typeof import('react');
  const { Text: RNText } =
    require('react-native') as typeof import('react-native');
  return () => ReactLib.createElement(RNText, null, `[${name}]`);
}
jest.mock('../../src/screens/HomeScreen', () => {
  const ReactLib = require('react') as typeof import('react');
  const { Text: RNText } =
    require('react-native') as typeof import('react-native');
  const { useNavigation } =
    require('@react-navigation/native') as typeof import('@react-navigation/native');
  const HomeScreen = () => {
    const navigation = useNavigation<{
      navigate: (route: string, params?: { source: 'settings' }) => void;
    }>();
    return ReactLib.createElement(
      ReactLib.Fragment,
      null,
      ReactLib.createElement(
        RNText,
        {
          testID: 'stub-open-analyze',
          onPress: () => navigation.navigate('Analyze'),
        },
        '[Home] analyze',
      ),
      ReactLib.createElement(
        RNText,
        {
          testID: 'stub-open-paywall',
          onPress: () => navigation.navigate('Paywall', { source: 'settings' }),
        },
        '[Home] paywall',
      ),
    );
  };
  return { HomeScreen };
});
jest.mock('../../src/screens/LibraryScreen', () => ({
  LibraryScreen: mockStubScreen('LibraryScreen'),
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: mockStubScreen('ProgressScreen'),
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: mockStubScreen('SettingsScreen'),
}));
jest.mock('../../src/screens/AnalyzeScreen', () => ({
  AnalyzeScreen: mockStubScreen('AnalyzeScreen'),
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: mockStubScreen('DrillLibraryScreen'),
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  ResultScreen: mockStubScreen('ResultScreen'),
}));
jest.mock('../../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: mockStubScreen('ResultDetailsScreen'),
}));
jest.mock('../../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: mockStubScreen('FormReviewScreen'),
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: mockStubScreen('StreakCalendarScreen'),
}));
jest.mock('../../src/screens/SignInScreen', () => ({
  SignInScreen: mockStubScreen('SignInScreen'),
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: mockStubScreen('ManageAccountScreen'),
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: mockStubScreen('ConsentSettingsScreen'),
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: mockStubScreen('NotificationSettingsScreen'),
}));
jest.mock('../../src/navigation/PremiumTabBar', () => ({
  PremiumTabBar: () => null,
}));
jest.mock('../../src/notifications/service', () => ({
  subscribeToNotificationPresses: () => () => {},
}));

import { RootNavigator } from '../../src/navigation/RootNavigator';
import { BrandNoticeHost } from '../../src/design/BrandNotice';
import { BrandSpinner } from '../../src/design/components';
import { createBillingAccessDependencies } from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  establishApiSession,
  clearApiSession,
} from '../../src/account/apiSession';
import {
  API_BASE_URL,
  BEARER,
  CANONICAL_USER_ID,
  PUBLIC_SDK_KEY,
  FaultBox,
  fakeBackend,
  fakeRevenueCat,
  controlScenarios,
  faultCatalogue,
  faultLabel,
  scenarioFaults,
  scenarioForCatalogue,
  scenarioForSeed,
  storeStateViolations,
  type Fault,
  type Scenario,
} from '../../test-support/stress/paywallFaultModel';

import {
  defaultArtifactDir,
  env,
  writeJsonArtifact,
} from '../../test-support/stress/artifacts';

const ITERATIONS = Number(env.STRESS_ITER ?? 40);
const ONLY_SEED = env.STRESS_SEED ? Number(env.STRESS_SEED) : null;
const ONLY_ID = env.STRESS_ONLY ?? null;
const OUT_DIR = env.STRESS_OUT ?? defaultArtifactDir('stress');
const SETTLE_MS = 60_000;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: '000123.abcdef.0001',
  canonicalAppUserId: CANONICAL_USER_ID,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

// ─── Result table ────────────────────────────────────────────────────────────

type Violation =
  | 'crash'
  | 'infinite-spinner'
  | 'no-back-control'
  | 'no-retry'
  | 'silent-failure'
  | 'fake-success'
  | 'corrupt-state'
  | 'not-recoverable'
  | 'foreign-module-called'
  | 'wedged-after-reentry';

interface Checkpoint {
  name: string;
  page: 'value' | 'pricing' | 'premium' | 'absent';
  spinners: number;
  retry: 'enabled' | 'disabled' | 'absent';
  backControl: boolean;
  continueEnabled: boolean;
  errorText: string | null;
  unavailableCard: boolean;
  brandNotice: string | null;
  storeStatus: string;
  storeOperation: string;
  violations: Violation[];
  detail: string[];
}

interface IterationResult {
  id: string;
  seed: number;
  /** Faults armed for the scenario. */
  faults: string[];
  /** Armed faults whose dependency call actually happened (a fault earlier
   * in the flow can mask a later one — only fired faults are counted). */
  faultsFired: string[];
  scenario: Scenario;
  outcome: 'HELD' | 'BROKEN';
  violations: Violation[];
  checkpoints: Checkpoint[];
  calls: Array<{ site: string; fault: string | null; at: number }>;
  replay: string;
  durationMs: number;
}

const results: IterationResult[] = [];

// ─── Render / query helpers ──────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;

function hostByTestId(renderer: Renderer, testID: string) {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props?.testID === testID,
  );
  return node ?? null;
}

function isDisabled(node: TestRenderer.ReactTestInstance | null): boolean {
  if (!node) return true;
  const state = node.props.accessibilityState as
    { disabled?: boolean } | undefined;
  return node.props.disabled === true || state?.disabled === true;
}

function hostByLabel(renderer: Renderer, label: string) {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props?.accessibilityLabel === label,
  );
  return node ?? null;
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function spinnerCount(renderer: Renderer): number {
  return (
    renderer.root.findAllByType(BrandSpinner).length +
    renderer.root.findAll(n => n.props?.accessibilityRole === 'progressbar')
      .length
  );
}

/** Presses a control the way a finger would: the innermost Pressable's
 * onPress, and only when it is not disabled (RN drops touches on disabled
 * Pressables; the host View carries no onPress prop in the test renderer). */
async function press(
  renderer: Renderer,
  target: { testID: string } | { label: string },
): Promise<boolean> {
  const matches = renderer.root.findAll(n => {
    if (typeof n.props?.onPress !== 'function') return false;
    return 'testID' in target
      ? n.props.testID === target.testID
      : n.props.accessibilityLabel === target.label;
  });
  const node = matches[matches.length - 1];
  if (!node) return false;
  if (node.props.disabled === true) return false;
  await act(async () => {
    node.props.onPress();
  });
  return true;
}

async function settle(ms = SETTLE_MS) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

async function flush() {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

function pageOf(renderer: Renderer): Checkpoint['page'] {
  if (hostByLabel(renderer, 'Continue coaching')) return 'premium';
  if (hostByTestId(renderer, 'paywall-back')) return 'pricing';
  if (hostByTestId(renderer, 'paywall-see-plans')) return 'value';
  return 'absent';
}

function snapshot(renderer: Renderer, name: string): Checkpoint {
  const state = useAccessStore.getState();
  const retryNode = hostByTestId(renderer, 'paywall-retry');
  const continueNode = hostByTestId(renderer, 'paywall-continue');
  const errorNode = hostByLabel(renderer, 'Dismiss membership message');
  const noticeNode = hostByTestId(renderer, 'brand-notice');
  const text = allText(renderer);
  const page = pageOf(renderer);
  return {
    name,
    page,
    spinners: spinnerCount(renderer),
    retry: retryNode
      ? isDisabled(retryNode)
        ? 'disabled'
        : 'enabled'
      : 'absent',
    backControl:
      hostByTestId(renderer, 'paywall-back') !== null ||
      hostByLabel(renderer, 'Close membership offer') !== null ||
      hostByLabel(renderer, 'Close membership') !== null,
    continueEnabled: continueNode !== null && !isDisabled(continueNode),
    errorText: errorNode
      ? ((errorNode.props.accessibilityHint as string | undefined) ?? '')
      : null,
    unavailableCard: text.includes('Store pricing is unavailable'),
    brandNotice: noticeNode
      ? text.includes('could not be opened')
        ? 'link-failure'
        : 'other'
      : null,
    storeStatus: state.status,
    storeOperation: state.operation,
    violations: [],
    detail: [],
  };
}

// ─── Oracles ─────────────────────────────────────────────────────────────────

interface Truth {
  /** Whether the fake backend has served a premium=true sync response —
   * the ONLY event that may unlock anything. */
  backendVerifiedPremium: () => boolean;
}

function judge(
  renderer: Renderer,
  checkpoint: Checkpoint,
  truth: Truth,
  options?: { expectRecovered?: boolean; afterFault?: boolean },
): Checkpoint {
  const state = useAccessStore.getState();
  const violations: Violation[] = [];
  const detail: string[] = [];

  if (checkpoint.spinners > 0) {
    violations.push('infinite-spinner');
    detail.push(
      `spinners=${checkpoint.spinners} status=${state.status} op=${state.operation}`,
    );
  }
  if (checkpoint.page !== 'absent' && !checkpoint.backControl) {
    violations.push('no-back-control');
  }
  // Missing plans or canonical access on the pricing page is a dead end
  // unless the user can retry; a failure with data intact is recovered
  // through Continue / Restore instead (retry is not required there).
  const dataMissing =
    checkpoint.page === 'pricing' &&
    state.status !== 'loading' &&
    (!state.plans || state.canonicalAccess === null);
  if (dataMissing && checkpoint.retry !== 'enabled') {
    violations.push('no-retry');
    detail.push(`retry=${checkpoint.retry} status=${state.status}`);
  }
  if (checkpoint.page === 'pricing' && state.status === 'loading') {
    // Still loading after the 60 s settle: nothing the user can press.
    if (checkpoint.retry !== 'enabled') {
      violations.push('no-retry');
      detail.push('still loading after settle; retry hidden');
    }
  }
  if (options?.afterFault) {
    const failed =
      state.status === 'error' ||
      state.status === 'unconfigured' ||
      dataMissing ||
      (checkpoint.page === 'pricing' && state.status === 'loading');
    if (
      failed &&
      checkpoint.errorText === null &&
      !checkpoint.unavailableCard &&
      checkpoint.brandNotice === null
    ) {
      violations.push('silent-failure');
      detail.push(
        `store status=${state.status} plans=${state.plans ? 'yes' : 'no'} access=${state.canonicalAccess ? 'yes' : 'no'} but no error card / unavailable copy`,
      );
    }
  }
  if (checkpoint.page === 'premium' && !truth.backendVerifiedPremium()) {
    violations.push('fake-success');
    detail.push('MEMBERSHIP VERIFIED rendered without backend verification');
  }
  if (
    state.canonicalAccess?.premium === true &&
    !truth.backendVerifiedPremium()
  ) {
    violations.push('fake-success');
    detail.push('canonicalAccess.premium=true without backend verification');
  }
  const corrupt = storeStateViolations(state);
  if (corrupt.length > 0) {
    violations.push('corrupt-state');
    detail.push(...corrupt);
  }
  if (options?.expectRecovered) {
    const recovered =
      checkpoint.page === 'premium' ||
      (checkpoint.page === 'pricing' &&
        state.operation === 'idle' &&
        state.plans !== null &&
        state.canonicalAccess !== null &&
        checkpoint.spinners === 0 &&
        checkpoint.continueEnabled);
    if (!recovered) {
      violations.push('not-recoverable');
      detail.push(
        `after faults cleared: page=${checkpoint.page} status=${state.status} op=${state.operation} plans=${state.plans ? 'yes' : 'no'} access=${state.canonicalAccess ? 'yes' : 'no'} continue=${checkpoint.continueEnabled}`,
      );
    }
  }
  void renderer;
  return { ...checkpoint, violations, detail };
}

// ─── One iteration ───────────────────────────────────────────────────────────

function wire(scenario: Scenario, box: FaultBox) {
  const rc = fakeRevenueCat(scenario, box);
  const backend = fakeBackend(scenario, box);
  configureAccessStore(
    createBillingAccessDependencies({
      revenueCatPublicSdkKey: PUBLIC_SDK_KEY,
      canonicalAppUserId: CANONICAL_USER_ID,
      apiBaseUrl: API_BASE_URL,
      apiToken: BEARER,
      fetchFn: backend.fetchFn,
      revenueCatSdk: rc.sdk,
      platform: 'ios',
    }),
  );
  return { rc, backend };
}

function openUrlDouble(box: FaultBox, base: string) {
  return jest.spyOn(Linking, 'openURL').mockImplementation((url: string) => {
    const fault = box.record('native.openURL');
    if (!fault) return Promise.resolve(true as unknown as void);
    switch (fault.mode) {
      case 'throw':
        throw new Error(`injected throw opening ${url}`);
      case 'never':
        return new Promise<void>(() => {});
      case 'slow':
        return new Promise<void>(resolve =>
          setTimeout(() => resolve(), fault.delayMs),
        );
      case 'timeout':
        return new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error('injected timeout')),
            fault.delayMs,
          ),
        );
      default:
        return Promise.reject(
          new Error(`injected ${fault.mode} opening ${base}`),
        );
    }
  });
}

async function runIteration(scenario: Scenario): Promise<IterationResult> {
  const startedAt = Date.now();
  // Unhandled promise rejections are not collected here: jest-circus owns
  // the process-level handler and fails the running test outright, so a
  // leaked rejection shows up as a failed iteration in the Jest output
  // (verified by mutation) rather than as a row in the JSON table.

  jest.useFakeTimers();
  if (scenario.clockSkewMs !== 0) {
    jest.setSystemTime(Date.now() + scenario.clockSkewMs);
  }
  const box = new FaultBox(() => Date.now());
  const checkpoints: Checkpoint[] = [];
  const violations = new Set<Violation>();
  let renderer: Renderer | null = null;
  const openUrl = openUrlDouble(box, scenario.id);
  const foreignBefore = foreignCalls().length;

  let wired: ReturnType<typeof wire> | null = null;
  const truth: Truth = {
    backendVerifiedPremium: () =>
      (wired?.backend.premiumSyncsServed() ?? 0) > 0,
  };
  const initFaultLabels = scenario.initFaults.map(faultLabel);
  const actionFaultLabels = scenario.actionFaults.map(faultLabel);

  const checkpoint = (
    name: string,
    options?: { expectRecovered?: boolean; afterFault?: boolean },
  ) => {
    if (!renderer) return;
    const judged = judge(renderer, snapshot(renderer, name), truth, options);
    checkpoints.push(judged);
    for (const v of judged.violations) violations.add(v);
  };

  try {
    // Signed-in, synced account (the only state the paywall ships for).
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
    });
    establishApiSession({
      apiBaseUrl: API_BASE_URL,
      bearerToken: BEARER,
      canonicalAppUserId: CANONICAL_USER_ID,
      provider: 'apple',
    });
    wired = wire(scenario, box);
    box.arm(scenario.initFaults);

    await act(async () => {
      renderer = TestRenderer.create(
        <>
          <RootNavigator />
          <BrandNoticeHost />
        </>,
      );
    });
    const r = renderer as unknown as Renderer;

    // ── Enter the paywall the way the app does ──
    if (scenario.entry === 'analyze-gate') {
      await press(r, { testID: 'stub-open-analyze' });
      await settle();
      // The gate must either land on the paywall or (never-resolving access)
      // keep its "Checking access…" placeholder — never the Analyze screen.
      if (allText(r).includes('[AnalyzeScreen]')) {
        violations.add('fake-success');
        checkpoints.push({
          ...snapshot(r, 'gate'),
          violations: ['fake-success'],
          detail: [
            'Analyze rendered although the backend reported no free rating',
          ],
        });
      }
      if (pageOf(r) === 'absent') {
        // Gate still waiting (access never resolved). Record and enter directly.
        const gateSpinners = spinnerCount(r);
        checkpoints.push({
          ...snapshot(r, 'gate-waiting'),
          violations: gateSpinners > 0 ? ['infinite-spinner'] : [],
          detail: [
            `gate placeholder after ${SETTLE_MS}ms; status=${useAccessStore.getState().status}`,
          ],
        });
        if (gateSpinners > 0) violations.add('infinite-spinner');
        await press(r, { label: 'Close membership offer' });
        // Analyze route is still on the stack under its placeholder; go home.
        await press(r, { testID: 'stub-open-paywall' });
        await flush();
      }
    } else {
      await press(r, { testID: 'stub-open-paywall' });
      await flush();
    }

    if (pageOf(r) === 'value') {
      checkpoint('value-page');
      await press(r, { testID: 'paywall-see-plans' });
    }
    await settle();
    checkpoint('pricing-after-init', { afterFault: true });

    // ── Recovery from the init faults (or the failed-init state) ──
    box.disarm();
    if (
      useAccessStore.getState().status !== 'ready' ||
      !useAccessStore.getState().plans
    ) {
      const pressed = await press(r, { testID: 'paywall-retry' });
      if (!pressed) {
        // No usable retry: try the only other path a user has — close and
        // come back in.
        await press(r, { label: 'Close membership offer' });
        await flush();
        await press(r, { testID: 'stub-open-paywall' });
        await flush();
        if (pageOf(r) === 'value')
          await press(r, { testID: 'paywall-see-plans' });
        await settle();
        const again = judge(r, snapshot(r, 'reentry-after-init-fault'), truth, {
          expectRecovered: true,
          afterFault: true,
        });
        if (again.violations.includes('not-recoverable')) {
          again.violations.push('wedged-after-reentry');
        }
        checkpoints.push(again);
        for (const v of again.violations) violations.add(v);
      } else {
        await settle();
        checkpoint('after-retry', { expectRecovered: true });
      }
    }

    // ── The action, with its faults ──
    const healthyBeforeAction =
      useAccessStore.getState().status === 'ready' &&
      useAccessStore.getState().plans !== null &&
      useAccessStore.getState().canonicalAccess !== null &&
      pageOf(r) === 'pricing';

    if (healthyBeforeAction && scenario.action !== 'none') {
      if (scenario.action === 'purchase' || scenario.action === 'restore') {
        await press(r, { testID: `paywall-plan-${scenario.selectPeriod}` });
        await flush();
      }
      box.arm(scenario.actionFaults);

      const target =
        scenario.action === 'purchase'
          ? { testID: 'paywall-continue' }
          : scenario.action === 'restore'
            ? { testID: 'paywall-restore' }
            : scenario.action === 'legal-terms'
              ? { label: 'Terms of use' }
              : { label: 'Privacy policy' };
      const pressed = await press(r, target);

      if (pressed && scenario.disruption === 'unmount-midflight') {
        await flush();
        await press(r, { label: 'Close membership offer' });
        await flush();
        checkpoints.push({
          ...snapshot(r, 'closed-midflight'),
          violations: [],
          detail: [],
        });
        await settle();
        // The pending operation settles while nothing is mounted; re-enter.
        await press(r, { testID: 'stub-open-paywall' });
        await flush();
        if (pageOf(r) === 'value')
          await press(r, { testID: 'paywall-see-plans' });
        await settle();
        checkpoint('reentered-after-midflight-close', { afterFault: true });
      } else if (pressed && scenario.disruption === 'signout-midflight') {
        await flush();
        clearAccessStoreConfiguration();
        clearApiSession();
        await settle();
        checkpoint('after-signout-midflight', { afterFault: true });
        // Signing back in re-wires billing; the paywall must come back clean.
        establishApiSession({
          apiBaseUrl: API_BASE_URL,
          bearerToken: BEARER,
          canonicalAppUserId: CANONICAL_USER_ID,
          provider: 'apple',
        });
        box.disarm();
        wired = wire(scenario, box);
        await flush();
        if (pageOf(r) === 'absent') {
          await press(r, { testID: 'stub-open-paywall' });
          await flush();
        }
        if (pageOf(r) === 'value')
          await press(r, { testID: 'paywall-see-plans' });
        await settle();
        checkpoint('after-signin-rewire', { expectRecovered: true });
      } else {
        await settle();
        checkpoint('after-action', { afterFault: true });
        // Paywall popped only counts as legitimate if the backend verified.
        if (pageOf(r) === 'absent' && !truth.backendVerifiedPremium()) {
          violations.add('fake-success');
          checkpoints.push({
            ...snapshot(r, 'popped-without-verification'),
            violations: ['fake-success'],
            detail: [
              'paywall dismissed (goBack) without backend premium verification',
            ],
          });
        }
        if (
          scenario.action === 'legal-terms' ||
          scenario.action === 'legal-privacy'
        ) {
          const fault = scenario.actionFaults[0];
          const failed =
            fault !== undefined &&
            fault.mode !== 'slow' &&
            fault.mode !== 'never';
          const last = checkpoints[checkpoints.length - 1];
          if (failed && last && last.brandNotice !== 'link-failure') {
            last.violations.push('silent-failure');
            last.detail.push(
              'openURL failed but no "could not be opened" notice',
            );
            violations.add('silent-failure');
          }
          if (last && last.brandNotice) {
            await press(r, { label: 'Close dialog' });
            await flush();
          }
        }
      }

      // ── Recovery from the action faults ──
      if (pageOf(r) !== 'absent' && pageOf(r) !== 'premium') {
        box.disarm();
        await press(r, { label: 'Dismiss membership message' });
        const retried = await press(r, { testID: 'paywall-retry' });
        if (!retried && useAccessStore.getState().operation !== 'idle') {
          // Busy forever: the user's only escape is closing; re-enter.
          await press(r, { label: 'Close membership offer' });
          await flush();
          await press(r, { testID: 'stub-open-paywall' });
          await flush();
          if (pageOf(r) === 'value')
            await press(r, { testID: 'paywall-see-plans' });
          await settle();
          const again = judge(
            r,
            snapshot(r, 'reentry-after-action-fault'),
            truth,
            {
              expectRecovered: true,
              afterFault: true,
            },
          );
          if (again.violations.includes('not-recoverable')) {
            again.violations.push('wedged-after-reentry');
          }
          checkpoints.push(again);
          for (const v of again.violations) violations.add(v);
        } else {
          await settle();
          checkpoint('after-action-recovery', { expectRecovered: true });
        }
      }
    }
  } catch (error) {
    violations.add('crash');
    checkpoints.push({
      name: 'crash',
      page: 'absent',
      spinners: 0,
      retry: 'absent',
      backControl: false,
      continueEnabled: false,
      errorText: null,
      unavailableCard: false,
      brandNotice: null,
      storeStatus: useAccessStore.getState().status,
      storeOperation: useAccessStore.getState().operation,
      violations: ['crash'],
      detail: [
        error instanceof Error
          ? `${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(1, 6).join('\n')}`
          : String(error),
      ],
    });
  } finally {
    if (renderer) {
      const r = renderer as unknown as Renderer;
      await act(async () => {
        r.unmount();
      });
    }
    openUrl.mockRestore();
    clearAccessStoreConfiguration();
    clearApiSession();
    useAuthStore.setState({ session: null });
    jest.clearAllTimers();
    jest.useRealTimers();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }

  if (foreignCalls().length > foreignBefore)
    violations.add('foreign-module-called');

  const replay = scenario.id.startsWith('seed:')
    ? `cd apps/mobile && STRESS_SEED=${scenario.seed} npx jest --ci __tests__/stress/paywallScreen.failureInjection.test.tsx`
    : `cd apps/mobile && STRESS_ONLY='${scenario.id}' npx jest --ci __tests__/stress/paywallScreen.failureInjection.test.tsx`;

  const armed = [...initFaultLabels, ...actionFaultLabels];
  const hit = new Set(box.calls.map(call => call.fault).filter(Boolean));
  return {
    id: scenario.id,
    seed: scenario.seed,
    faults: armed,
    faultsFired: armed.filter(label => hit.has(label)),
    scenario,
    outcome: violations.size === 0 ? 'HELD' : 'BROKEN',
    violations: [...violations],
    checkpoints,
    calls: box.calls,
    replay,
    durationMs: Date.now() - startedAt,
  };
}

// ─── Campaign ────────────────────────────────────────────────────────────────

function plan(): Scenario[] {
  if (ONLY_SEED !== null) return [scenarioForSeed(ONLY_SEED)];
  const catalogue = [
    ...controlScenarios(),
    ...faultCatalogue().map((entry, index) =>
      scenarioForCatalogue(index, entry.site, entry.mode),
    ),
  ];
  if (ONLY_ID) {
    const match = catalogue.find(s => s.id === ONLY_ID);
    if (!match) throw new Error(`Unknown STRESS_ONLY id ${ONLY_ID}`);
    return [match];
  }
  const random: Scenario[] = [];
  for (let seed = 1; seed <= ITERATIONS; seed += 1)
    random.push(scenarioForSeed(seed));
  return [...catalogue, ...random];
}

const scenarios = plan();

afterAll(() => {
  const faultsArmed = results.reduce((n, r) => n + r.faults.length, 0);
  const faultsFired = results.reduce((n, r) => n + r.faultsFired.length, 0);
  const table = {
    unit: 'scr-paywallscreen',
    lens: 'failure-injection',
    commit: env.STRESS_COMMIT ?? null,
    generatedAt: new Date().toISOString(),
    settleMs: SETTLE_MS,
    iterations: results.length,
    faultsArmed,
    faultsFired,
    held: results.filter(r => r.outcome === 'HELD').length,
    broken: results.filter(r => r.outcome === 'BROKEN').length,
    violationCounts: results
      .flatMap(r => r.violations)
      .reduce<Record<string, number>>((acc, v) => {
        acc[v] = (acc[v] ?? 0) + 1;
        return acc;
      }, {}),
    brokenByFault: results
      .filter(r => r.outcome === 'BROKEN')
      .reduce<Record<string, number>>((acc, r) => {
        for (const f of r.faults) {
          const key = f.replace(/[@#].*$/, '');
          acc[key] = (acc[key] ?? 0) + 1;
        }
        return acc;
      }, {}),
    results,
  };
  writeJsonArtifact(OUT_DIR, 'paywall-failure-injection.json', table);
  writeJsonArtifact(OUT_DIR, 'paywall-failure-injection.summary.json', {
    ...table,
    results: results.map(r => ({
      id: r.id,
      seed: r.seed,
      faults: r.faults,
      outcome: r.outcome,
      violations: r.violations,
      replay: r.replay,
    })),
  });
});

describe('PaywallScreen · failure injection inside the real navigator', () => {
  test.each(scenarios.map(s => [s.id, s] as const))(
    '%s',
    async (_id, scenario) => {
      const result = await runIteration(scenario);
      results.push(result);
      // Print the failing table row so a red run is self-explanatory.
      if (result.outcome === 'BROKEN') {
        const rows = result.checkpoints
          .filter(c => c.violations.length > 0)
          .map(
            c =>
              `  ${c.name}: ${c.violations.join(',')} — ${c.detail.join('; ')}`,
          )
          .join('\n');
        throw new Error(
          `BROKEN ${scenario.id} faults=[${result.faults.join(', ')}] violations=[${result.violations.join(', ')}]\n${rows}\nreplay: ${result.replay}`,
        );
      }
      expect(result.outcome).toBe('HELD');
    },
  );

  test('foreign native modules were never called (SQLite, Keychain, native RevenueCat)', () => {
    expect(foreignCalls()).toEqual([]);
  });

  test('the campaign fired at least 60 faults', () => {
    const faultsFired = results.reduce((n, r) => n + r.faultsFired.length, 0);
    if (ONLY_SEED === null && !ONLY_ID)
      expect(faultsFired).toBeGreaterThanOrEqual(60);
  });
});

// Referenced so the model's exported types stay part of the compiled surface.
export type { Fault };
void scenarioFaults;
