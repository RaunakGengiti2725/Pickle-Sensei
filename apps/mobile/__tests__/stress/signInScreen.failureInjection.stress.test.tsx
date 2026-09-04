/**
 * STRESS — scr-signinscreen / failure-injection.
 *
 * Mounts the REAL App (SafeAreaProvider → QueryClientProvider →
 * RootErrorBoundary → Gate → WelcomeScreen → SignInScreen) with the real
 * auth/app/notification/consistency stores and drives a user from launch to
 * "Continue with Apple / Google" while every dependency the flow reaches is
 * faulted one way or another:
 *
 *   fetch/api      bootstrap / me / refresh: throw, reject, timeout (abort),
 *                  never-resolves, slow, malformed, partial, 4xx/5xx
 *   SQLite         getDb: open-throws, all-throw, kv-get/set throw, hang,
 *                  slow, malformed rows, garbage values, dies mid-run
 *   Keychain       get/set/reset: sync throw, reject, hang, slow, malformed,
 *                  returns-false, silent-drop, module missing
 *   Apple native   NativeModules.PickleAuth: missing, throw, reject (error /
 *                  cancel / string / undefined), hang, slow, null / string /
 *                  no-token / empty / whitespace / partial results
 *   Google SDK     module missing, configure throws, Play Services reject /
 *                  hang / slow, signIn reject / throw / cancel / garbage /
 *                  hang / slow / null / partial
 *   permissions    notification SchedulerPort: denied, reject, throw, hang,
 *                  malformed, cancel/apply rejects (post-sign-in hydrate)
 *   RevenueCat     billing client construction throws inside
 *                  installApiSession; native SDK import throws
 *   config         API URL null / http / garbage; Google web client id null
 *   clock          device 1999 / 2099, server skew ±1d, mid-flight jumps
 *   navigation     Back / re-enter / double-tap / other provider / unmount
 *                  during the in-flight sign-in, remount storm
 *
 * Only native modules and fetch are mocked (plus the navigation-heavy
 * authenticated surfaces the app shows AFTER sign-in, which are not the unit
 * under test). Apple Vision and TTS are NOT dependencies of this screen and
 * the camera seam is reached only at module load —
 * `signInScreen.dependencyGraph.stress.test.ts` pins that from the import
 * graph; `signInScreen.moduleLoadFaults.stress.test.tsx` faults the camera
 * native module at import time.
 *
 * Every row is deterministic: the fixed catalog seeds are FNV-1a hashes of
 * the row id; the random-combination campaign draws from mulberry32(seed).
 * Results land in artifacts/stress-signin/*.json.
 *
 * Scale knobs:
 *   STRESS_ITER=<n>        seeded random-combination iterations (default 12)
 *   STRESS_SEED_START=<n>  first seed of that campaign (default 1)
 *   STRESS_SEED=<n>        replay exactly one seeded row (skips the catalog)
 *   STRESS_ONLY=<substr>   only catalog rows whose id contains <substr>
 *   STRESS_ARTIFACT_DIR    where the JSON tables go
 */
import React from 'react';
import { AppState, NativeModules, Text } from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';

import {
  FaultyApple,
  FaultyDb,
  FaultyGoogle,
  FaultyKeychain,
  FaultyScheduler,
  ScriptedServer,
  APPLE_IDENTITY_TOKEN,
  CANONICAL_ID,
  GOOGLE_ID_TOKEN,
  type ConfigFault,
  type RevenueCatFault,
} from '../../__harness__/stressSignIn/world';

// ─── Module seams (native modules + fetch only; see header) ──────────────────

const mockWorld = {
  db: new FaultyDb(),
  keychain: new FaultyKeychain(),
  apple: new FaultyApple(),
  google: new FaultyGoogle(),
  server: new ScriptedServer(),
  scheduler: new FaultyScheduler(),
  config: 'ok' as ConfigFault,
  revenueCat: 'ok' as RevenueCatFault,
};

jest.mock('../../src/data/db', () => ({
  getDb: () => mockWorld.db.handle(),
}));

jest.mock('react-native-keychain', () => ({
  get ACCESSIBLE() {
    return mockWorld.keychain.module.ACCESSIBLE;
  },
  setGenericPassword: (...args: unknown[]) => {
    if (mockWorld.keychain.faults.moduleMissing) {
      throw new TypeError(
        "Cannot read properties of null (reading 'setGenericPassword') — react-native-keychain native module missing (simulated)",
      );
    }
    return (
      mockWorld.keychain.module.setGenericPassword as (
        ...a: unknown[]
      ) => Promise<unknown>
    )(...args);
  },
  getGenericPassword: (...args: unknown[]) => {
    if (mockWorld.keychain.faults.moduleMissing) {
      throw new TypeError(
        "Cannot read properties of null (reading 'getGenericPassword') — react-native-keychain native module missing (simulated)",
      );
    }
    return (
      mockWorld.keychain.module.getGenericPassword as (
        ...a: unknown[]
      ) => Promise<unknown>
    )(...args);
  },
  resetGenericPassword: (...args: unknown[]) => {
    if (mockWorld.keychain.faults.moduleMissing) {
      throw new TypeError(
        "Cannot read properties of null (reading 'resetGenericPassword') — react-native-keychain native module missing (simulated)",
      );
    }
    return (
      mockWorld.keychain.module.resetGenericPassword as (
        ...a: unknown[]
      ) => Promise<unknown>
    )(...args);
  },
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  get GoogleSignin() {
    return mockWorld.google.module.GoogleSignin;
  },
}));

jest.mock('../../src/config/authConfig', () => ({
  get GOOGLE_WEB_CLIENT_ID() {
    return mockWorld.config === 'google-web-client-null'
      ? null
      : 'test-web-client.apps.googleusercontent.com';
  },
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

jest.mock('../../src/config/runtimeConfig', () => {
  const { apiBaseUrlFor: baseUrlFor } = jest.requireActual<
    typeof import('../../__harness__/stressSignIn/world')
  >('../../__harness__/stressSignIn/world');
  return {
    getRuntimePublicConfig: () => ({
      apiBaseUrl: baseUrlFor(mockWorld.config),
      revenueCatPublicSdkKey: 'test_stress_public_key',
      googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
      googleWebClientId:
        mockWorld.config === 'google-web-client-null'
          ? null
          : 'test-web-client.apps.googleusercontent.com',
      appVersion: '1.0',
      legalPrivacyUrl: null,
      legalTermsUrl: null,
    }),
  };
});

jest.mock('../../src/account/deviceContext', () => ({
  getAccountBootstrapEnvironment: () => ({
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    device: {
      platform: 'ios',
      osVersion: '18.5',
      appVersion: '1.0',
      model: 'iOS phone',
    },
  }),
}));

jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockWorld.scheduler,
  screenTargetFromNotificationData: () => null,
  subscribeToNotificationPresses: () => () => {},
  registerBackgroundNotificationHandler: () => {},
}));

jest.mock('../../src/billing/revenueCatClient', () => {
  const actual = jest.requireActual<
    typeof import('../../src/billing/revenueCatClient')
  >('../../src/billing/revenueCatClient');
  return {
    ...actual,
    createRevenueCatBillingClient: (
      ...args: Parameters<typeof actual.createRevenueCatBillingClient>
    ) => {
      if (mockWorld.revenueCat === 'client-construct-throws') {
        throw new Error(
          'RevenueCat billing client construction threw (simulated)',
        );
      }
      return actual.createRevenueCatBillingClient(...args);
    },
  };
});

jest.mock('react-native-purchases', () => {
  if (mockWorld.revenueCat === 'sdk-import-throws') {
    throw new Error("Cannot find module 'react-native-purchases' (simulated)");
  }
  return {
    __esModule: true,
    default: {
      configure: () => {},
      getCustomerInfo: () => Promise.resolve({ entitlements: { active: {} } }),
      getOfferings: () => Promise.resolve({ current: null }),
    },
  };
});

// TTS is NOT a dependency of this screen (graph test) — a throwing factory
// turns any accidental import into a crash the campaign would record. The
// camera seam IS reached at module load (repository.ts imports its clip
// validator); its native-module faults are exercised per isolated module
// registry in signInScreen.moduleLoadFaults.stress.test.tsx.
jest.mock('../../src/audio/tts', () => {
  throw new Error('audio/tts imported from the sign-in flow (unexpected)');
});

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    SafeAreaProvider: View,
    initialWindowMetrics: null,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
jest.mock('react-native-svg', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  const Stub = (props: { children?: React.ReactNode }) =>
    R.createElement(RN.View, null, props.children);
  return {
    __esModule: true,
    default: Stub,
    Svg: Stub,
    Path: Stub,
    Circle: Stub,
    Rect: Stub,
    G: Stub,
    Line: Stub,
    Polyline: Stub,
    Polygon: Stub,
    Defs: Stub,
    LinearGradient: Stub,
    Stop: Stub,
    ClipPath: Stub,
    Ellipse: Stub,
    Text: Stub,
  };
});
jest.mock('react-native-linear-gradient', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RN.View, LinearGradient: RN.View };
});

// Authenticated surfaces shown AFTER a successful sign-in — not the unit.
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
jest.mock('../../src/screens/SplashScreen', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) => {
      R.useEffect(() => {
        if (props.ready) props.onFinished();
      }, [props.ready, props.onFinished]);
      return null;
    },
  };
});
jest.mock('../../src/components/RankUpCelebration', () => ({
  RankUpCelebration: () => null,
}));
jest.mock('../../src/consistency/StreakCelebration', () => ({
  StreakCelebration: () => null,
}));
jest.mock('../../src/walkthrough/FirstRunWalkthrough', () => ({
  FirstRunWalkthrough: () => null,
}));

import App from '../../App';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { useAccessStore } from '../../src/state/accessStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  KNOWN_BROKEN,
  KNOWN_BROKEN_PINS,
  buildCatalog,
  expectation,
  seededScenario,
  type Expectation,
  type Scenario,
} from '../../__harness__/stressSignIn/faults';
import {
  stressIterations,
  stressOnlyFilter,
  stressReplaySeed,
  stressSeedStart,
  writeStressJson,
  writeStressText,
} from '../../__harness__/stressSignIn/artifacts';

// ─── Row shape ───────────────────────────────────────────────────────────────

interface Row {
  id: string;
  seed: number;
  provider: 'apple' | 'google';
  category: string;
  mode: string;
  faults: Scenario['faults'];
  expectation: Expectation;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  failed: string[];
  ok: boolean;
  /** Failures that only arise from a fault the real platform cannot
   * produce (see Expectation.synthetic). */
  syntheticOnly: boolean;
  replay: string;
  durationMs: number;
}

const TEST_FILE =
  '__tests__/stress/signInScreen.failureInjection.stress.test.tsx';
const T0 = new Date('2026-06-01T12:00:00.000Z');
const SETTLE_WINDOW_MS = 60_000;

// ─── Process reset (stores are module singletons) ────────────────────────────

const nativeModules = NativeModules as {
  PickleAuth?: { signInWithApple?: () => unknown };
};
const realFetch = globalThis.fetch;
const appStateListeners = new Set<(state: string) => void>();
let unhandled: string[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason instanceof Error ? reason.message : String(reason));
};

function resetProcess(): void {
  // A previous row's still-pending fake timers (slow faults, keeper retries)
  // must not resume inside this row and write into its fresh world.
  jest.clearAllTimers();
  clearSyncRuntime();
  stopSessionKeeper();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    session: null,
    hydrated: false,
    busy: false,
    error: null,
    deletionCleanup: null,
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
  });
  useAccessStore.getState().reset();
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
  useWalkthroughStore.setState({ visible: false, queued: false });
  mockWorld.db.reset();
  mockWorld.keychain.reset();
  mockWorld.server.reset();
  mockWorld.apple = new FaultyApple();
  mockWorld.google = new FaultyGoogle();
  mockWorld.scheduler = new FaultyScheduler();
  mockWorld.config = 'ok';
  mockWorld.revenueCat = 'ok';
  appStateListeners.clear();
  unhandled = [];
}

// ─── Tree probes ─────────────────────────────────────────────────────────────

type Renderer = ReturnType<typeof TestRenderer.create>;

function texts(renderer: Renderer): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(visit);
  };
  for (const text of renderer.root.findAllByType(Text)) {
    visit(text.props.children);
  }
  return out;
}

/** The Pressable element PressableScale renders: the only composite node
 * carrying onPress AND a resolved accessibilityRole. */
function pressables(renderer: Renderer): ReactTestInstance[] {
  return renderer.root.findAll(
    node =>
      typeof node.type !== 'string' &&
      typeof node.props.onPress === 'function' &&
      typeof node.props.accessibilityRole === 'string',
  );
}

function pressable(
  renderer: Renderer,
  label: string,
): ReactTestInstance | null {
  const match = pressables(renderer).filter(
    node => node.props.accessibilityLabel === label,
  );
  return match[0] ?? null;
}

function isEnabled(node: ReactTestInstance | null): boolean {
  return Boolean(node) && !node!.props.disabled;
}

/** Presses like RN's Pressability: a disabled Pressable swallows the tap. */
async function press(
  renderer: Renderer,
  label: string,
  log: (kind: string, detail?: Record<string, unknown>) => void,
): Promise<'pressed' | 'blocked' | 'absent'> {
  const node = pressable(renderer, label);
  if (!node) {
    log('press-absent', { label });
    return 'absent';
  }
  if (node.props.disabled) {
    log('press-blocked', { label });
    return 'blocked';
  }
  await act(async () => {
    node.props.onPress?.();
  });
  log('press', { label });
  return 'pressed';
}

function hasLoadingState(renderer: Renderer): boolean {
  return (
    renderer.root.findAll(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.includes('Keep Pickle Sensei open'),
    ).length > 0
  );
}

interface Snapshot {
  mounted: boolean;
  screen:
    | 'launch'
    | 'welcome'
    | 'signin'
    | 'root'
    | 'onboarding'
    | 'error'
    | 'boundary'
    | 'unknown';
  busySpinner: boolean;
  loadingState: boolean;
  errorCard: string | null;
  errorCardTitle: string | null;
  backEnabled: boolean;
  appleEnabled: boolean;
  googleEnabled: boolean;
  retryVisible: boolean;
  welcomeSignInEnabled: boolean;
}

function snapshot(renderer: Renderer | null): Snapshot {
  if (!renderer) {
    return {
      mounted: false,
      screen: 'unknown',
      busySpinner: false,
      loadingState: false,
      errorCard: null,
      errorCardTitle: null,
      backEnabled: false,
      appleEnabled: false,
      googleEnabled: false,
      retryVisible: false,
      welcomeSignInEnabled: false,
    };
  }
  const all = texts(renderer);
  const signInBody = renderer.root.findAll(
    n => n.props.testID === 'sign-in-body',
  );
  const errorNode = pressable(renderer, 'Dismiss sign-in error');
  const boundary = all.some(t => t === 'Something went wrong');
  const profileError = all.some(t =>
    t.includes('coaching profile couldn’t load'),
  );
  const screen: Snapshot['screen'] = boundary
    ? 'boundary'
    : all.includes('ROOT_NAVIGATOR')
      ? 'root'
      : all.includes('ONBOARDING')
        ? 'onboarding'
        : profileError
          ? 'error'
          : signInBody.length > 0
            ? 'signin'
            : pressable(renderer, 'I already have an account')
              ? 'welcome'
              : hasLoadingState(renderer)
                ? 'launch'
                : 'unknown';
  return {
    mounted: true,
    screen,
    busySpinner: all.some(t => t.includes('Signing in securely')),
    loadingState: hasLoadingState(renderer),
    errorCard: errorNode
      ? String(errorNode.props.accessibilityHint ?? '')
      : null,
    errorCardTitle: errorNode
      ? all.includes('NOT CONFIGURED YET')
        ? 'NOT CONFIGURED YET'
        : all.includes('SIGN-IN FAILED')
          ? 'SIGN-IN FAILED'
          : 'unknown'
      : null,
    backEnabled: isEnabled(pressable(renderer, 'Back')),
    appleEnabled: isEnabled(pressable(renderer, 'Continue with Apple')),
    googleEnabled: isEnabled(pressable(renderer, 'Continue with Google')),
    retryVisible: isEnabled(pressable(renderer, 'Try again')),
    welcomeSignInEnabled: isEnabled(
      pressable(renderer, 'I already have an account'),
    ),
  };
}

async function mount(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
  });
  return renderer;
}

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/** Advance in 1s steps for up to `windowMs`, returning the first offset at
 * which `done()` held (or null if it never did). */
async function settle(
  windowMs: number,
  done: () => boolean,
): Promise<number | null> {
  for (let elapsed = 0; elapsed < windowMs; elapsed += 1_000) {
    if (done()) return elapsed;
    await flush(1_000);
  }
  return done() ? windowMs : null;
}

// ─── Persisted-state inspection ──────────────────────────────────────────────

const VAULT_SERVICE = 'com.picklesensei.auth.session';
const TOKEN_MATERIAL = [
  APPLE_IDENTITY_TOKEN,
  GOOGLE_ID_TOKEN,
  'access-',
  'refresh-',
];

function vaultRecord(): {
  raw: string | null;
  parsed: Record<string, unknown> | null;
} {
  const item = mockWorld.keychain.store.get(VAULT_SERVICE);
  if (!item) return { raw: null, parsed: null };
  try {
    const parsed = JSON.parse(item.password) as unknown;
    return {
      raw: item.password,
      parsed:
        parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)
          : null,
    };
  } catch {
    return { raw: item.password, parsed: null };
  }
}

// ─── One scenario ────────────────────────────────────────────────────────────

async function runScenario(scenario: Scenario): Promise<Row> {
  const startedWall = Date.now();
  const exp = expectation(scenario);
  const f = scenario.faults;
  const timeline: {
    at: number;
    kind: string;
    detail?: Record<string, unknown>;
  }[] = [];
  resetProcess();

  // Clock.
  const deviceBase =
    f.clock === 'device-1999'
      ? new Date('1999-12-31T23:59:00.000Z')
      : f.clock === 'device-2099'
        ? new Date('2099-01-01T00:00:00.000Z')
        : T0;
  jest.setSystemTime(deviceBase);
  const t0 = Date.now();
  const log = (kind: string, detail?: Record<string, unknown>) => {
    timeline.push({ at: Date.now() - t0, kind, ...(detail ? { detail } : {}) });
  };
  if (f.clock === 'server-skew-plus-1d') mockWorld.server.clockSkewSec = 86_400;
  if (f.clock === 'server-skew-minus-1d')
    mockWorld.server.clockSkewSec = -86_400;

  // Faults live from launch unless they are SQLite faults armed after launch.
  mockWorld.keychain.faults = { ...f.keychain };
  if (!f.dbArmAfterLaunch) mockWorld.db.fault = f.db;
  mockWorld.config = f.config;
  mockWorld.revenueCat = f.revenueCat;
  mockWorld.scheduler.fault = f.permission;
  mockWorld.apple.fault = f.apple;
  mockWorld.google.fault = f.google;
  mockWorld.server.bootstrap = f.bootstrap;
  mockWorld.server.me = f.me;
  mockWorld.server.refresh = f.refresh;
  const appleModule = mockWorld.apple.nativeModule();
  if (appleModule) nativeModules.PickleAuth = appleModule;
  else delete nativeModules.PickleAuth;
  (globalThis as { fetch: unknown }).fetch = mockWorld.server.fetch;

  const providerLabel =
    scenario.provider === 'apple'
      ? 'Continue with Apple'
      : 'Continue with Google';
  const otherLabel =
    scenario.provider === 'apple'
      ? 'Continue with Google'
      : 'Continue with Apple';
  const providerToken =
    scenario.provider === 'apple' ? APPLE_IDENTITY_TOKEN : GOOGLE_ID_TOKEN;

  let renderer: Renderer | null = null;
  let harnessError: string | null = null;
  const observed: Record<string, unknown> = {};
  const invariants: Record<string, boolean> = {};

  try {
    renderer = await mount();
    log('mounted');

    // 1. Launch → Welcome (or a launch hang).
    const launchAt = await settle(
      SETTLE_WINDOW_MS,
      () =>
        snapshot(renderer).screen !== 'launch' &&
        snapshot(renderer).screen !== 'unknown',
    );
    observed['launchSettledMs'] = launchAt;
    observed['launchScreen'] = snapshot(renderer).screen;
    log('launch-settled', { at: launchAt, screen: snapshot(renderer).screen });

    if (snapshot(renderer).screen === 'welcome') {
      // 2. Welcome → SignIn.
      await press(renderer!, 'I already have an account', log);
      if (f.nav === 'remount-storm-before-tap') {
        for (let i = 0; i < 5; i += 1) {
          await press(renderer!, 'Back', log);
          await press(renderer!, 'I already have an account', log);
        }
      }
      observed['signInReached'] = snapshot(renderer).screen === 'signin';

      // 3. Arm post-launch SQLite faults, then tap the provider.
      if (f.dbArmAfterLaunch) mockWorld.db.fault = f.db;
      const tap = await press(renderer!, providerLabel, log);
      observed['providerTap'] = tap;
      await flush(0);
      const afterTap = snapshot(renderer);
      observed['busyAfterTap'] = useAuthStore.getState().busy;
      observed['spinnerAfterTap'] = afterTap.busySpinner;
      observed['providersDisabledWhileBusy'] =
        !afterTap.appleEnabled && !afterTap.googleEnabled;
      observed['backEnabledWhileBusy'] = afterTap.backEnabled;
      if (useAuthStore.getState().busy) {
        invariants['busyGateHeld'] =
          !afterTap.appleEnabled && !afterTap.googleEnabled;
        invariants['busyShowsProgress'] = afterTap.busySpinner;
      }

      // 4. Navigation / interaction perturbations while in flight.
      await flush(100);
      switch (f.nav) {
        case 'double-tap':
          observed['secondTap'] = await press(renderer!, providerLabel, log);
          break;
        case 'tap-other-provider-during-busy':
          // Only meaningful while the first attempt is in flight; once it
          // has settled the tap would start a legitimate sign-in with the
          // other provider, which this row's oracle does not model.
          observed['otherTap'] = useAuthStore.getState().busy
            ? await press(renderer!, otherLabel, log)
            : 'skipped-not-busy';
          break;
        case 'back-during-busy':
          observed['backTap'] = await press(renderer!, 'Back', log);
          break;
        case 'back-reenter-during-busy':
          observed['backTap'] = await press(renderer!, 'Back', log);
          await flush(50);
          observed['reenterTap'] = await press(
            renderer!,
            'I already have an account',
            log,
          );
          break;
        case 'unmount-app-during-busy':
          await act(async () => {
            renderer!.unmount();
          });
          renderer = null;
          log('unmounted-during-busy');
          break;
        default:
          break;
      }
      if (f.clock === 'jump-forward-1h-mid-flight') {
        jest.setSystemTime(Date.now() + 3_600_000);
        log('clock-jump', { deltaMs: 3_600_000 });
      } else if (f.clock === 'jump-back-1h-mid-flight') {
        jest.setSystemTime(Date.now() - 3_600_000);
        log('clock-jump', { deltaMs: -3_600_000 });
      }
      const providerCallsBefore =
        scenario.provider === 'apple'
          ? mockWorld.apple.calls
          : mockWorld.google.signInCalls;
      observed['providerCallsAfterPerturbation'] = providerCallsBefore;

      // 5. Settle: up to 60s of fake time, sampled each second.
      const settledAt = await settle(SETTLE_WINDOW_MS, () => {
        const auth = useAuthStore.getState();
        if (auth.busy) return false;
        const snap = snapshot(renderer);
        if (!snap.mounted) return true;
        if (snap.screen === 'launch') return false;
        return !snap.loadingState;
      });
      observed['settledMs'] = settledAt;
      log('settled', { at: settledAt });

      // 6. Post-sign-in RevenueCat SDK import fault: the access store is the
      //    first consumer of the billing dependencies installApiSession wired.
      if (
        f.revenueCat === 'sdk-import-throws' &&
        useAuthStore.getState().session
      ) {
        void useAccessStore.getState().initialize();
        await flush(2_000);
        observed['accessStatusAfterSdkImportFault'] =
          useAccessStore.getState().status;
        invariants['accessStoreSurvivesSdkImportThrow'] =
          useAccessStore.getState().status !== 'loading' &&
          useAuthStore.getState().session !== null;
      }
    } else {
      observed['signInReached'] = false;
    }
  } catch (error) {
    harnessError =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    log('harness-error', { error: harnessError });
  }

  // ── Observe terminal state ────────────────────────────────────────────────
  const auth = useAuthStore.getState();
  const snap = snapshot(renderer);
  const api = getApiSession();
  const vault = vaultRecord();
  const kv = Object.fromEntries(mockWorld.db.inner.kv);
  const kvWrites = mockWorld.db.inner.kvWrites();
  const refreshCalls = mockWorld.server.calls.filter(
    c => c.route === '/v1/auth/refresh',
  );
  const bootstrapCalls = mockWorld.server.calls.filter(
    c => c.route === '/v1/account/bootstrap',
  );

  Object.assign(observed, {
    terminalScreen: snap.screen,
    renderedTexts: renderer ? texts(renderer).slice(0, 24) : [],
    renderedControls: renderer
      ? pressables(renderer)
          .map(
            n =>
              `${String(n.props.accessibilityLabel)}${n.props.disabled ? '(disabled)' : ''}`,
          )
          .slice(0, 24)
      : [],
    appStore: {
      hydrated: useAppStore.getState().hydrated,
      ownerKey: useAppStore.getState().ownerKey,
      hydrateError: useAppStore.getState().hydrateError,
      hasProfile: useAppStore.getState().profile !== null,
    },
    busy: auth.busy,
    hydrated: auth.hydrated,
    session: auth.session
      ? {
          provider: auth.session.provider,
          canonicalAppUserId: auth.session.canonicalAppUserId,
          localOnly: auth.session.localOnly,
        }
      : null,
    storeError: auth.error,
    errorCard: snap.errorCard,
    errorCardTitle: snap.errorCardTitle,
    busySpinner: snap.busySpinner,
    loadingState: snap.loadingState,
    backEnabled: snap.backEnabled,
    appleEnabled: snap.appleEnabled,
    googleEnabled: snap.googleEnabled,
    retryVisible: snap.retryVisible,
    apiSession: api
      ? {
          bearer: api.bearerToken,
          refresh: api.refreshToken ?? null,
          expiresAtMs: api.bearerExpiresAtMs ?? null,
        }
      : null,
    vault: vault.parsed
      ? {
          provider: vault.parsed['provider'],
          canonicalAppUserId: vault.parsed['canonicalAppUserId'],
          refreshToken: vault.parsed['refreshToken'],
        }
      : vault.raw,
    keychainOps: mockWorld.keychain.log.map(e => e.op),
    kv,
    kvWriteCount: kvWrites.length,
    destructiveSql: mockWorld.db.inner.destructiveStatements(),
    serverCalls: mockWorld.server.calls.map(c => `${c.route}:${c.outcome}`),
    bootstrapCalls: bootstrapCalls.length,
    refreshCalls: refreshCalls.length,
    unexpectedRoutes: mockWorld.server.unexpected,
    providerCalls:
      scenario.provider === 'apple'
        ? mockWorld.apple.calls
        : mockWorld.google.signInCalls,
    unhandledRejections: [...unhandled],
    harnessError,
    pendingTimers: jest.getTimerCount(),
    timeline,
  });

  // ── Invariants ────────────────────────────────────────────────────────────
  const appleBearerLeak = api ? api.bearerToken === providerToken : false;
  const serverMintedAccess = mockWorld.server.issuedAccess.length > 0;

  invariants['noCrash'] =
    harnessError === null &&
    snap.screen !== 'boundary' &&
    unhandled.length === 0;

  invariants['spinnerSettles60s'] = !snap.mounted
    ? !auth.busy
    : !auth.busy && !snap.busySpinner && !snap.loadingState;

  invariants['recoverableControl'] = !snap.mounted
    ? true
    : snap.screen === 'root' ||
      snap.screen === 'onboarding' ||
      snap.backEnabled ||
      snap.retryVisible ||
      snap.welcomeSignInEnabled;

  const userNavigatedAway =
    f.nav === 'back-during-busy' || f.nav === 'unmount-app-during-busy';
  if (auth.session === null && observed['providerTap'] === 'pressed') {
    if (exp.userCancelled) {
      invariants['cancelIsQuiet'] =
        snap.errorCard === null && auth.error?.code === 'auth.canceled';
    } else {
      const surfaced =
        snap.errorCard !== null ||
        snap.retryVisible ||
        (auth.error !== null &&
          (userNavigatedAway || snap.screen !== 'signin'));
      invariants['noSilentFailure'] = surfaced && !auth.busy;
    }
  }

  const landed = snap.screen === 'root' || snap.screen === 'onboarding';
  // A bearer is legitimate when the server minted it, or — the documented
  // transitional fallback for servers that return no usable session — when
  // it is the provider token itself and nothing was persisted.
  const bearerLegit =
    api !== null &&
    (mockWorld.server.issuedAccess.includes(api.bearerToken) ||
      (api.bearerToken === providerToken &&
        !exp.serverMintsRefresh &&
        vault.raw === null));
  invariants['noFakeSuccess'] = auth.busy
    ? !landed
    : auth.session === null
      ? api === null && !landed
      : exp.serverAccepts &&
        !exp.postAcceptThrows &&
        auth.session.canonicalAppUserId === CANONICAL_ID &&
        auth.session.provider === scenario.provider &&
        bearerLegit;
  observed['providerTokenUsedAsBearer'] = appleBearerLeak;
  observed['transitionalNonDurableSession'] =
    auth.session !== null && appleBearerLeak && vault.raw === null;
  observed['serverMintedAccess'] = serverMintedAccess;

  const vaultSane =
    vault.raw === null
      ? true
      : f.keychain.set === 'malformed'
        ? true
        : vault.parsed !== null &&
          vault.parsed['provider'] === scenario.provider &&
          vault.parsed['canonicalAppUserId'] === CANONICAL_ID &&
          typeof vault.parsed['refreshToken'] === 'string' &&
          mockWorld.server.issuedRefresh.includes(
            vault.parsed['refreshToken'] as string,
          ) &&
          auth.session !== null;
  const kvSane =
    Object.values(kv).every(
      value => !TOKEN_MATERIAL.some(m => value.includes(m)),
    ) &&
    (kv['auth.local-mode'] === undefined || kv['auth.local-mode'] === '') &&
    (kv['auth.last-provider'] === undefined ||
      kv['auth.last-provider'] === '' ||
      (scenario.provider === 'google' && auth.session !== null)) &&
    mockWorld.db.inner.destructiveStatements().length === 0;
  invariants['persistedStateSane'] = vaultSane && kvSane;
  observed['vaultSane'] = vaultSane;
  observed['kvSane'] = kvSane;

  invariants['noRefreshStorm'] = refreshCalls.length <= 3;
  invariants['noUnexpectedRoutes'] = mockWorld.server.unexpected.length === 0;

  // ── Recovery: heal every fault and retry from wherever the user is ────────
  if (
    renderer &&
    auth.session === null &&
    !auth.busy &&
    snap.screen !== 'boundary'
  ) {
    mockWorld.db.fault = 'ok';
    mockWorld.keychain.faults = {
      moduleMissing: false,
      get: 'ok',
      set: 'ok',
      reset: 'ok',
    };
    mockWorld.apple.fault = 'ok';
    mockWorld.google.fault = 'ok';
    mockWorld.server.bootstrap = 'ok';
    mockWorld.server.me = 'ok';
    mockWorld.server.refresh = 'ok';
    mockWorld.config = 'ok';
    mockWorld.revenueCat = 'ok';
    mockWorld.scheduler.fault = 'ok';
    nativeModules.PickleAuth = mockWorld.apple.nativeModule();
    log('healed');
    try {
      if (snapshot(renderer).screen === 'welcome') {
        await press(renderer, 'I already have an account', log);
      }
      if (pressable(renderer, 'Dismiss sign-in error')) {
        await press(renderer, 'Dismiss sign-in error', log);
        observed['errorDismissed'] =
          pressable(renderer, 'Dismiss sign-in error') === null;
      }
      observed['retryTap'] = await press(renderer, providerLabel, log);
      const recoveredAt = await settle(SETTLE_WINDOW_MS, () => {
        const s = snapshot(renderer);
        return (
          (s.screen === 'root' || s.screen === 'onboarding') &&
          !useAuthStore.getState().busy
        );
      });
      observed['recoveredMs'] = recoveredAt;
      invariants['retryRecovers'] =
        recoveredAt !== null &&
        useAuthStore.getState().session?.canonicalAppUserId === CANONICAL_ID;
    } catch (error) {
      observed['recoveryError'] =
        error instanceof Error ? error.message : String(error);
      invariants['retryRecovers'] = false;
    }
  } else if (renderer && auth.busy) {
    // A hung dependency left the store busy: the guard swallows every retry.
    observed['retryTapWhileHung'] = await press(renderer, providerLabel, log);
    invariants['retryRecovers'] = false;
  }

  if (renderer) {
    await act(async () => {
      renderer!.unmount();
    });
  }
  await flush(1_000);
  observed['timersAfterUnmount'] = jest.getTimerCount();
  (globalThis as { fetch: unknown }).fetch = realFetch;

  const failed = Object.entries(invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  return {
    id: scenario.id,
    seed: scenario.seed,
    provider: scenario.provider,
    category: scenario.category,
    mode: scenario.mode,
    faults: scenario.faults,
    expectation: exp,
    observed,
    invariants,
    failed,
    ok: failed.length === 0,
    syntheticOnly: failed.length > 0 && exp.synthetic.length > 0,
    replay:
      scenario.category === 'combo' && scenario.id.startsWith('seed/')
        ? `cd apps/mobile && STRESS_SEED=${scenario.seed} npx jest --ci ${TEST_FILE}`
        : `cd apps/mobile && STRESS_ONLY='${scenario.id}' STRESS_ITER=0 npx jest --ci ${TEST_FILE}`,
    durationMs: Date.now() - startedWall,
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

beforeAll(() => {
  jest.useFakeTimers();
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: (state: string) => void,
  ) => {
    appStateListeners.add(handler);
    return { remove: () => appStateListeners.delete(handler) };
  }) as unknown as typeof AppState.addEventListener);
  process.on('unhandledRejection', onUnhandled);
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  (globalThis as { fetch: unknown }).fetch = realFetch;
  delete nativeModules.PickleAuth;
  jest.useRealTimers();
});

describe('STRESS scr-signinscreen — failure injection', () => {
  const rows: Row[] = [];
  const replaySeed = stressReplaySeed();
  const only = stressOnlyFilter();
  const catalog =
    replaySeed !== null
      ? []
      : buildCatalog().filter(s => !only || s.id.includes(only));
  const seedStart = stressSeedStart();
  const seeded =
    replaySeed !== null
      ? [seededScenario(replaySeed)]
      : only
        ? []
        : Array.from({ length: stressIterations(12) }, (_, i) =>
            seededScenario(seedStart + i),
          );

  const strict = process.env['STRESS_STRICT'] === '1';

  /** Synthetic-only faults (cannot happen on the real platform) and rows
   * pinned to a known finding are reported in the artifact but do not fail
   * the suite unless STRESS_STRICT=1. */
  function assertRow(row: Row): void {
    if (row.ok) return;
    if (row.syntheticOnly) return;
    if (row.expectation.knownBroken !== null && !strict) return;
    expect(row.failed).toEqual([]);
  }

  for (const scenario of catalog) {
    test(`catalog ${scenario.id} (seed ${scenario.seed})`, async () => {
      const row = await runScenario(scenario);
      rows.push(row);
      assertRow(row);
    }, 120_000);
  }

  for (const scenario of seeded) {
    test(`seeded ${scenario.id}`, async () => {
      const row = await runScenario(scenario);
      rows.push(row);
      assertRow(row);
    }, 120_000);
  }

  // Strict xfail: every known finding must still reproduce on its minimal
  // catalog row. When production fixes one, this test turns red so the pin
  // (KNOWN_BROKEN_PINS / expectation().knownBroken) gets removed.
  const pinnedIds = Object.values(KNOWN_BROKEN_PINS).flat();
  const pinnedInRun = catalog.filter(s => pinnedIds.includes(s.id));
  if (pinnedInRun.length > 0) {
    test('known-broken pins still reproduce (remove the pin once fixed)', () => {
      const stillBroken = Object.fromEntries(
        pinnedInRun.map(s => {
          const row = rows.find(r => r.id === s.id);
          return [s.id, row ? row.failed : ['<row missing>']];
        }),
      );
      for (const [id, failed] of Object.entries(stillBroken)) {
        expect({ id, failed }).not.toEqual({ id, failed: [] });
      }
    });
  }

  afterAll(() => {
    const failing = rows.filter(r => !r.ok);
    const summary = {
      suite: 'scr-signinscreen/failure-injection',
      testFile: TEST_FILE,
      executed: rows.length,
      catalogRows: rows.filter(r => !r.id.startsWith('seed/')).length,
      seededRows: rows.filter(r => r.id.startsWith('seed/')).length,
      held: rows.length - failing.length,
      failed: failing.length,
      failedSyntheticOnly: failing.filter(r => r.syntheticOnly).length,
      failedKnownBroken: failing.filter(
        r => !r.syntheticOnly && r.expectation.knownBroken !== null,
      ).length,
      failedUnexpected: failing.filter(
        r => !r.syntheticOnly && r.expectation.knownBroken === null,
      ).length,
      knownBroken: KNOWN_BROKEN,
      knownBrokenPins: KNOWN_BROKEN_PINS,
      byCategory: Object.fromEntries(
        [...new Set(rows.map(r => r.category))].map(category => {
          const inCategory = rows.filter(r => r.category === category);
          return [
            category,
            {
              executed: inCategory.length,
              failed: inCategory.filter(r => !r.ok).length,
            },
          ];
        }),
      ),
      byMode: Object.fromEntries(
        [...new Set(rows.map(r => r.mode))].map(mode => [
          mode,
          rows.filter(r => r.mode === mode).length,
        ]),
      ),
      invariantFailures: Object.fromEntries(
        [...new Set(failing.flatMap(r => r.failed))].map(name => [
          name,
          failing.filter(r => r.failed.includes(name)).length,
        ]),
      ),
      failingSeeds: failing.map(r => ({
        id: r.id,
        seed: r.seed,
        failed: r.failed,
        syntheticOnly: r.syntheticOnly,
        synthetic: r.expectation.synthetic,
        knownBroken: r.expectation.knownBroken,
        replay: r.replay,
      })),
    };
    const stamp =
      replaySeed !== null ? `seed-${replaySeed}` : only ? 'filtered' : 'full';
    writeStressJson(`signin-failure-injection.${stamp}.rows.json`, rows);
    writeStressJson(`signin-failure-injection.${stamp}.summary.json`, summary);
    writeStressText(
      `signin-failure-injection.${stamp}.table.md`,
      [
        '| seed | id | provider | outcome | failed | synthetic | finding |',
        '|---|---|---|---|---|---|---|',
        ...rows.map(
          r =>
            `| ${r.seed} | ${r.id} | ${r.provider} | ${r.ok ? 'HELD' : r.syntheticOnly ? 'BROKEN(synthetic)' : 'BROKEN'} | ${r.failed.join(' ') || '-'} | ${r.expectation.synthetic.join(' ') || '-'} | ${r.expectation.knownBroken ?? '-'} |`,
        ),
      ].join('\n') + '\n',
    );
  });
});
