/**
 * STRESS · failure-injection · unit `scr-settingsscreen`
 *
 * SettingsScreen is rendered inside the REAL RootNavigator (native stack +
 * bottom tabs + PremiumTabBar), the real RootErrorBoundary from App.tsx, the
 * real BrandNoticeHost and the real Zustand stores (auth, access, consent,
 * app, notification, consistency, walkthrough). The signed-in state is reached
 * the way a relaunch reaches it: `useAuthStore.hydrate()` reads the Keychain
 * vault and exchanges the refresh token against a scripted server. Sibling
 * screens that are not part of this unit (Home, Library, Progress, Analyze,
 * Result…, ManageAccount, NotificationSettings, StreakCalendar, SignIn) are
 * inert stubs with a real `goBack`. PaywallScreen and ConsentSettingsScreen
 * stay REAL because they are the recovery destinations of the two Settings
 * rows that surface remote state (membership, consent).
 *
 * Only native seams and fetch are faked, each with an injectable fault:
 *   fetch (/v1/auth/refresh, /v1/me, /v1/me/access, /v1/me/consent/status,
 *          /v1/auth/logout)  → network reject · 500 · 401 · 429 · malformed ·
 *                              partial · non-JSON · slow · hang (never resolves)
 *   SQLite (getDb)          → open throws · kv read throws · kv write throws ·
 *                              malformed persisted profile
 *   Keychain                → read throws · malformed record · reset rejects ·
 *                              reset hangs · write throws
 *   RevenueCat SDK          → configure throws/hangs · offerings reject /
 *                              malformed / hang · isConfigured throws
 *   notification scheduler  → permission throws / hangs / malformed ·
 *                              cancelAll rejects
 *   Linking.openURL         → reject · sync throw · hang
 *   StoreKit review module  → missing · reject · hang
 *   clock                   → system time far past / far future, fake timers
 *                              advanced 60 s after every fault
 *   navigation              → double taps, navigate while a load is pending,
 *                              remount mid-flight, focus/refocus cycles
 *
 * Camera, Vision provider and TTS are NOT dependencies of this screen:
 * SettingsScreen imports none of them; `scoringStackStatus()` is a pure
 * constant (src/vision/providers.ts) with no native or I/O seam, so there is
 * nothing to inject there. They are reported as not-applicable, not as held.
 *
 * Every iteration is derived from its seed alone. Replay one:
 *   cd apps/mobile && STRESS_SEED=<seed> npx jest --ci \
 *     __tests__/stress/settingsScreenFailureInjection.stress.test.tsx
 * Campaign size: STRESS_ITER=<n> (default 12; the fixed scenarios always run).
 * Raw rows: artifacts/stress/settingsscreen-failure-injection/*.json
 *
 * Rows are classified BROKEN/HELD in the JSON regardless of anything below.
 * Violations that reproduce a KNOWN_FINDING (see that table) are pinned by a
 * `test.failing` case each — the suite stays green while the defect exists
 * and turns red the moment a fix lands (remove the entry then). Set
 * STRESS_STRICT=1 to fail every BROKEN row, known or not.
 */
import React from 'react';
import { AppState, Linking, NativeModules, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import type { PlannedNotification } from '../../src/notifications/types';
import { FakeLocalDb } from '../../xc-harness/lifecycle-persistence/fakeLocalDb';
import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  CANONICAL_ID,
  makePrng,
  pick,
  validProfile,
  validVault,
} from '../../xc-harness/lifecycle-persistence/seeds';

declare const __dirname: string;

// ─── Native seams ────────────────────────────────────────────────────────────

const mockDb = { current: new FakeLocalDb() };
jest.mock('../../src/data/db', () => ({
  getDb: () => mockDb.current.handle(),
}));

type KeychainFault =
  | 'ok'
  | 'get-throws'
  | 'get-malformed'
  | 'reset-rejects'
  | 'reset-hangs'
  | 'set-throws';
const mockKeychain = {
  store: new Map<string, { username: string; password: string }>(),
  log: [] as { op: 'get' | 'set' | 'reset'; outcome: string }[],
  fault: 'ok' as KeychainFault,
  pendingHangs: 0,
};
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
      'AccessibleAfterFirstUnlockThisDeviceOnly',
  },
  setGenericPassword: async (
    username: string,
    password: string,
    options: { service?: string } = {},
  ) => {
    if (mockKeychain.fault === 'set-throws') {
      mockKeychain.log.push({ op: 'set', outcome: 'threw' });
      throw new Error('errSecInteractionNotAllowed (simulated)');
    }
    mockKeychain.log.push({ op: 'set', outcome: 'ok' });
    mockKeychain.store.set(options.service ?? '__default__', {
      username,
      password,
    });
    return { service: options.service, storage: 'mock' };
  },
  getGenericPassword: async (options: { service?: string } = {}) => {
    if (mockKeychain.fault === 'get-throws') {
      mockKeychain.log.push({ op: 'get', outcome: 'threw' });
      throw new Error('errSecItemNotFound (simulated)');
    }
    const item = mockKeychain.store.get(options.service ?? '__default__');
    if (!item) {
      mockKeychain.log.push({ op: 'get', outcome: 'absent' });
      return false;
    }
    mockKeychain.log.push({ op: 'get', outcome: 'ok' });
    if (mockKeychain.fault === 'get-malformed') {
      return {
        service: options.service,
        storage: 'mock',
        username: item.username,
        password: '{"version":1,"provider":"apple",',
      };
    }
    return { service: options.service, storage: 'mock', ...item };
  },
  resetGenericPassword: async (options: { service?: string } = {}) => {
    if (mockKeychain.fault === 'reset-rejects') {
      mockKeychain.log.push({ op: 'reset', outcome: 'rejected' });
      throw new Error('errSecIO (simulated)');
    }
    if (mockKeychain.fault === 'reset-hangs') {
      mockKeychain.log.push({ op: 'reset', outcome: 'hung' });
      mockKeychain.pendingHangs += 1;
      return new Promise<boolean>(() => {});
    }
    mockKeychain.log.push({ op: 'reset', outcome: 'ok' });
    return mockKeychain.store.delete(options.service ?? '__default__');
  },
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(),
    signIn: jest.fn(),
    signInSilently: jest.fn(async () => {
      throw new Error('no silent google session (simulated)');
    }),
    hasPreviousSignIn: jest.fn(() => false),
    signOut: jest.fn(async () => {}),
    revokeAccess: jest.fn(async () => {}),
  },
}));
jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));
const API_BASE = 'https://api.example.test';
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: 'appl_stress_test_key',
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
    legalPrivacyUrl: 'https://api.example.test/privacy',
    legalTermsUrl: 'https://api.example.test/terms',
    appStoreId: '6806918402',
    appStoreWriteReviewUrl:
      'https://apps.apple.com/app/id6806918402?action=write-review',
  }),
}));
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

type PermissionFault =
  | 'ok'
  | 'permission-throws'
  | 'permission-hangs'
  | 'permission-malformed'
  | 'cancel-all-rejects';
class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  fault: PermissionFault = 'ok';
  applied: PlannedNotification[][] = [];
  pendingHangs = 0;
  async permissionState(): Promise<PermissionState> {
    if (this.fault === 'permission-throws') {
      throw new Error('UNUserNotificationCenter unavailable (simulated)');
    }
    if (this.fault === 'permission-hangs') {
      this.pendingHangs += 1;
      return new Promise<PermissionState>(() => {});
    }
    if (this.fault === 'permission-malformed') {
      return 'ephemeral-weird' as unknown as PermissionState;
    }
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permissionState();
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.applied.push([...plan]);
  }
  async cancelAllPlanned(): Promise<void> {
    if (this.fault === 'cancel-all-rejects') {
      throw new Error('cancelAll failed (simulated)');
    }
  }
  async openSystemSettings(): Promise<void> {}
}
const mockScheduler = { current: new FakeScheduler() };
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler.current,
  screenTargetFromNotificationData: () => null,
  subscribeToNotificationPresses: () => () => {},
  registerBackgroundNotificationHandler: () => {},
}));

type RevenueCatFault =
  | 'ok'
  | 'configure-throws'
  | 'configure-hangs'
  | 'is-configured-throws'
  | 'offerings-reject'
  | 'offerings-malformed'
  | 'offerings-empty'
  | 'offerings-hang'
  | 'customer-info-rejects';
function storePackage(
  packageType: 'ANNUAL' | 'MONTHLY' | 'LIFETIME',
  price: number,
) {
  return {
    identifier: `$rc_${packageType.toLowerCase()}`,
    packageType,
    product: {
      identifier: `pickle_sensei_pro_${packageType.toLowerCase()}`,
      price,
      priceString: `$${price.toFixed(2)}`,
      pricePerMonthString: null,
      introPrice: null,
      defaultOption: null,
    },
  };
}
const mockPurchases = {
  fault: 'ok' as RevenueCatFault,
  configured: false,
  appUserId: '',
  calls: [] as string[],
  pendingHangs: 0,
  async isConfigured() {
    this.calls.push('isConfigured');
    if (this.fault === 'is-configured-throws') {
      throw new Error('Purchases native module missing (simulated)');
    }
    return this.configured;
  },
  async configure(configuration: { apiKey: string; appUserID: string }) {
    this.calls.push('configure');
    if (this.fault === 'configure-throws') {
      throw new Error('Invalid API key (simulated)');
    }
    if (this.fault === 'configure-hangs') {
      this.pendingHangs += 1;
      return new Promise<void>(() => {});
    }
    this.configured = true;
    this.appUserId = configuration.appUserID;
  },
  async getAppUserID() {
    this.calls.push('getAppUserID');
    return this.appUserId;
  },
  async logIn(appUserID: string) {
    this.calls.push('logIn');
    this.appUserId = appUserID;
    return {};
  },
  async getOfferings() {
    this.calls.push('getOfferings');
    if (this.fault === 'offerings-reject') {
      throw new Error('OFFERINGS_EMPTY (simulated)');
    }
    if (this.fault === 'offerings-hang') {
      this.pendingHangs += 1;
      return new Promise<never>(() => {});
    }
    if (this.fault === 'offerings-empty') return { current: null };
    if (this.fault === 'offerings-malformed') {
      return {
        current: {
          identifier: 'default',
          annual: { identifier: '$rc_annual' },
          monthly: null,
          lifetime: 'not-a-package',
        },
      };
    }
    return {
      current: {
        identifier: 'default',
        annual: storePackage('ANNUAL', 59.99),
        monthly: storePackage('MONTHLY', 7.99),
        lifetime: storePackage('LIFETIME', 159.99),
      },
    };
  },
  async purchasePackage() {
    this.calls.push('purchasePackage');
    throw new Error('purchases are outside this harness');
  },
  async restorePurchases() {
    this.calls.push('restorePurchases');
    return { entitlements: { active: {} } };
  },
  async getCustomerInfo() {
    this.calls.push('getCustomerInfo');
    if (this.fault === 'customer-info-rejects') {
      throw new Error('customer info unavailable (simulated)');
    }
    return { entitlements: { active: {} } };
  },
  async checkTrialOrIntroductoryPriceEligibility(ids: string[]) {
    this.calls.push('checkTrialOrIntroductoryPriceEligibility');
    return Object.fromEntries(ids.map(id => [id, { status: 0 }]));
  },
};
// The production launch path (authStore → createBillingAccessDependencies)
// loads the RevenueCat SDK through `await import('react-native-purchases')`,
// which Jest's CJS runtime cannot evaluate; inject the scripted SDK at the
// same seam the app exposes for it (`createRevenueCatBillingClient(_, sdk)`)
// so the real client validation/entitlement logic runs against the faults.
jest.mock('../../src/billing/revenueCatClient', () => {
  const actual = jest.requireActual<
    typeof import('../../src/billing/revenueCatClient')
  >('../../src/billing/revenueCatClient');
  return {
    ...actual,
    createRevenueCatBillingClient: (
      config: Parameters<typeof actual.createRevenueCatBillingClient>[0],
      sdk: Parameters<typeof actual.createRevenueCatBillingClient>[1],
      platform: Parameters<typeof actual.createRevenueCatBillingClient>[2],
    ) =>
      actual.createRevenueCatBillingClient(
        config,
        sdk ?? (mockPurchases as unknown as NonNullable<typeof sdk>),
        platform,
      ),
  };
});

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    SafeAreaProvider: View,
    SafeAreaInsetsContext: {
      Consumer: (props: { children: (i: unknown) => unknown }) =>
        props.children({ top: 0, bottom: 0, left: 0, right: 0 }),
    },
    initialWindowMetrics: null,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
  };
});
jest.mock('react-native-linear-gradient', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    R.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

// Sibling screens outside the unit: inert, but with a REAL back control so
// every navigation the unit triggers can be returned from.
// (Function declarations are hoisted, so the hoisted jest.mock factories can
// call them; the `mock` prefix is what babel-plugin-jest-hoist requires.)
function mockStubScreen(name: string): Record<string, () => React.JSX.Element> {
  const R = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const Nav = jest.requireActual<typeof import('@react-navigation/native')>(
    '@react-navigation/native',
  );
  const Stub = () => {
    const navigation = Nav.useNavigation();
    return R.createElement(
      RN.View,
      null,
      R.createElement(RN.Text, null, `STUB:${name}`),
      R.createElement(
        RN.Pressable,
        {
          accessibilityLabel: 'Back',
          onPress: () => {
            if (navigation.canGoBack()) navigation.goBack();
          },
        },
        R.createElement(RN.Text, null, 'Back'),
      ),
    );
  };
  Stub.displayName = `Stub${name}`;
  return { [name]: Stub };
}
function mockStubSignInScreen(): {
  SignInScreen: (props: { onBack?: () => void }) => React.JSX.Element;
} {
  const R = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SignInScreen: props =>
      R.createElement(
        RN.View,
        null,
        R.createElement(RN.Text, null, 'STUB:SignInScreen'),
        R.createElement(
          RN.Pressable,
          { accessibilityLabel: 'Back', onPress: props.onBack },
          R.createElement(RN.Text, null, 'Back'),
        ),
      ),
  };
}
jest.mock('../../src/screens/HomeScreen', () => mockStubScreen('HomeScreen'));
jest.mock('../../src/screens/LibraryScreen', () =>
  mockStubScreen('LibraryScreen'),
);
jest.mock('../../src/screens/ProgressScreen', () =>
  mockStubScreen('ProgressScreen'),
);
jest.mock('../../src/screens/AnalyzeScreen', () =>
  mockStubScreen('AnalyzeScreen'),
);
jest.mock('../../src/screens/DrillLibraryScreen', () =>
  mockStubScreen('DrillLibraryScreen'),
);
jest.mock('../../src/screens/ResultScreen', () =>
  mockStubScreen('ResultScreen'),
);
jest.mock('../../src/screens/ResultDetailsScreen', () =>
  mockStubScreen('ResultDetailsScreen'),
);
jest.mock('../../src/screens/FormReviewScreen', () =>
  mockStubScreen('FormReviewScreen'),
);
jest.mock('../../src/screens/StreakCalendarScreen', () =>
  mockStubScreen('StreakCalendarScreen'),
);
jest.mock('../../src/screens/ManageAccountScreen', () =>
  mockStubScreen('ManageAccountScreen'),
);
jest.mock('../../src/screens/NotificationSettingsScreen', () =>
  mockStubScreen('NotificationSettingsScreen'),
);
jest.mock('../../src/screens/SignInScreen', () => mockStubSignInScreen());
// App.tsx is imported for its real RootErrorBoundary; the pre-auth screens it
// also pulls in are outside this unit.
jest.mock('../../src/screens/OnboardingScreen', () => ({
  OnboardingScreen: () => null,
}));
jest.mock('../../src/screens/WelcomeScreen', () => ({
  WelcomeScreen: () => null,
}));
jest.mock('../../src/screens/SplashScreen', () => ({
  SplashScreen: () => null,
}));
jest.mock('../../src/components/RankUpCelebration', () => ({
  RankUpCelebration: () => null,
}));
jest.mock('../../src/consistency/StreakCelebration', () => ({
  StreakCelebration: () => null,
}));
jest.mock('../../src/walkthrough/FirstRunWalkthrough', () => ({
  FirstRunWalkthrough: () => null,
}));
// The intro video needs a native player; the stub hands off the moment the
// Gate is ready, which is the only contract App.tsx relies on.
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

import App from '../../App';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import {
  clearAccessStoreConfiguration,
  useAccessStore,
} from '../../src/state/accessStore';
import { useConsentStore } from '../../src/state/consentStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import { clearApiSession } from '../../src/account/apiSession';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';

// ─── Scripted server (the only network seam) ─────────────────────────────────

type HttpFault =
  | 'ok'
  | 'network'
  | 'http500'
  | 'http401'
  | 'http429'
  | 'malformed'
  | 'partial'
  | 'nonjson'
  | 'slow'
  | 'hang';
type RefreshFault = 'ok' | 'http401' | 'http500' | 'hang';
const HTTP_FAULTS: readonly HttpFault[] = [
  'network',
  'http500',
  'http401',
  'http429',
  'malformed',
  'partial',
  'nonjson',
  'slow',
  'hang',
];

interface ServerFaults {
  access: HttpFault;
  consent: HttpFault;
  logout: HttpFault;
  /** applied to refresh calls AFTER the sign-in refresh succeeded */
  refreshLater: RefreshFault;
}

interface AccessLedger {
  premium: boolean;
  used: number;
  reserved: number;
}

function accessPayload(ledger: AccessLedger): Record<string, unknown> {
  const remaining = 2 - ledger.used;
  const availableToReserve = remaining - ledger.reserved;
  const canStartRating = ledger.premium || availableToReserve > 0;
  return {
    premium: ledger.premium,
    entitlements: ledger.premium ? ['premium'] : [],
    freeRatings: {
      limit: 2,
      used: ledger.used,
      reserved: ledger.reserved,
      remaining,
      availableToReserve,
    },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

function expectedMembershipLabel(ledger: AccessLedger): string {
  if (ledger.premium) return 'Pro active';
  const availableToReserve = 2 - ledger.used - ledger.reserved;
  if (availableToReserve > 0) {
    return `${availableToReserve} free rating${
      availableToReserve === 1 ? '' : 's'
    } left`;
  }
  return 'Upgrade required';
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface ServerCall {
  route: string;
  fault: string;
  outcome: string;
  at: number;
}

class ScriptedServer {
  faults: ServerFaults = {
    access: 'ok',
    consent: 'ok',
    logout: 'ok',
    refreshLater: 'ok',
  };
  ledger: AccessLedger = { premium: false, used: 0, reserved: 0 };
  consentActive = false;
  slowMs = 5_000;
  bearerTtlSec = 3600;
  readonly calls: ServerCall[] = [];
  readonly unexpected: string[] = [];
  /** requests that were told to hang and were never aborted by the client */
  pendingHangs = 0;
  private refreshCount = 0;
  private counter = 0;
  readonly validRefreshTokens = new Set<string>();
  now: () => number = () => Date.now();

  private delay(ms: number, signal: AbortSignal | null | undefined) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      });
    });
  }

  private async faulted(
    route: string,
    fault: HttpFault,
    signal: AbortSignal | null | undefined,
    ok: () => Response,
    partial: () => Response,
    malformed: () => Response,
  ): Promise<Response> {
    const call: ServerCall = {
      route,
      fault,
      outcome: 'pending',
      at: this.now(),
    };
    this.calls.push(call);
    try {
      switch (fault) {
        case 'hang':
          this.pendingHangs += 1;
          await this.delay(24 * 3_600_000, signal);
          this.pendingHangs -= 1;
          call.outcome = 'hang-elapsed';
          return new Response(null, { status: 599 });
        case 'slow':
          await this.delay(this.slowMs, signal);
          call.outcome = `ok-after-${this.slowMs}ms`;
          return ok();
        case 'network':
          call.outcome = 'network-error';
          throw new TypeError('Network request failed');
        case 'http500':
          call.outcome = '500';
          return jsonResponse(500, { error: { message: 'boom' } });
        case 'http401':
          call.outcome = '401';
          return jsonResponse(401, { error: { message: 'expired' } });
        case 'http429':
          call.outcome = '429';
          return jsonResponse(429, { error: { message: 'slow down' } });
        case 'malformed':
          call.outcome = '200-malformed';
          return malformed();
        case 'partial':
          call.outcome = '200-partial';
          return partial();
        case 'nonjson':
          call.outcome = '200-nonjson';
          return new Response('<html>gateway</html>', { status: 200 });
        case 'ok':
        default:
          call.outcome = '200';
          return ok();
      }
    } catch (error) {
      if (call.outcome === 'pending') {
        call.outcome =
          error instanceof Error && error.name === 'AbortError'
            ? 'aborted-by-client'
            : 'threw';
        if (fault === 'hang') this.pendingHangs -= 1;
      }
      throw error;
    }
  }

  seedRefreshToken(token: string): void {
    this.validRefreshTokens.add(token);
  }

  readonly fetch = async (
    url: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const signal = init.signal;
    if (url === `${API_BASE}/v1/auth/refresh`) {
      this.refreshCount += 1;
      const body = JSON.parse(String(init.body ?? '{}')) as {
        refreshToken?: string;
      };
      const token = String(body.refreshToken ?? '');
      const later = this.refreshCount > 1 ? this.faults.refreshLater : 'ok';
      const call: ServerCall = {
        route: 'refresh',
        fault: later,
        outcome: 'pending',
        at: this.now(),
      };
      this.calls.push(call);
      if (later === 'hang') {
        this.pendingHangs += 1;
        try {
          await this.delay(24 * 3_600_000, signal);
        } catch (error) {
          this.pendingHangs -= 1;
          call.outcome = 'aborted-by-client';
          throw error;
        }
      }
      if (later === 'http401') {
        call.outcome = '401';
        return jsonResponse(401, { error: { message: 'revoked' } });
      }
      if (later === 'http500') {
        call.outcome = '500';
        return jsonResponse(500, { error: { message: 'boom' } });
      }
      if (!this.validRefreshTokens.has(token)) {
        call.outcome = '401-unknown-token';
        return jsonResponse(401, { error: { message: 'unknown token' } });
      }
      this.counter += 1;
      this.validRefreshTokens.delete(token);
      const refresh = `refresh-${this.counter}`;
      this.validRefreshTokens.add(refresh);
      call.outcome = `rotated→${refresh}`;
      return jsonResponse(200, {
        session: {
          accessToken: `access-${this.counter}`,
          refreshToken: refresh,
          expiresAt: Math.floor(Date.now() / 1000) + this.bearerTtlSec,
        },
      });
    }
    if (url === `${API_BASE}/v1/me`) {
      this.calls.push({
        route: 'me',
        fault: 'ok',
        outcome: '200',
        at: this.now(),
      });
      return jsonResponse(200, {
        onboardingState: 'complete',
        profile: {
          skill_level: 'intermediate',
          handedness: 'right',
          primary_goal: 'consistency',
          biggest_problem: 'popups',
          first_name: 'Pat',
        },
      });
    }
    if (url === `${API_BASE}/v1/me/access`) {
      return this.faulted(
        'access',
        this.faults.access,
        signal,
        () => jsonResponse(200, accessPayload(this.ledger)),
        () =>
          jsonResponse(200, {
            premium: false,
            entitlements: [],
            freeRatings: { limit: 2, used: 1 },
          }),
        () =>
          jsonResponse(200, {
            premium: 'yes',
            entitlements: ['premium'],
            freeRatings: {
              limit: 3,
              used: -1,
              reserved: 0,
              remaining: 9,
              availableToReserve: 9,
            },
            canStartRating: true,
            paywallRequired: false,
          }),
      );
    }
    if (url === `${API_BASE}/v1/me/consent/status`) {
      return this.faulted(
        'consent',
        this.faults.consent,
        signal,
        () =>
          jsonResponse(200, {
            subjectPseudonym: 'pseudonym-1',
            scopes: [
              {
                scope: 'model_training',
                active: this.consentActive,
                consentVersion: this.consentActive ? '2026-01' : null,
                lastAction: this.consentActive ? 'granted' : null,
                lastActionAt: this.consentActive
                  ? '2026-02-01T00:00:00.000Z'
                  : null,
              },
            ],
          }),
        () => jsonResponse(200, { subjectPseudonym: 'pseudonym-1' }),
        () =>
          jsonResponse(200, {
            subjectPseudonym: 42,
            scopes: [{ scope: 'model_training', active: 'true' }],
          }),
      );
    }
    if (url === `${API_BASE}/v1/auth/logout`) {
      return this.faulted(
        'logout',
        this.faults.logout,
        signal,
        () => new Response(null, { status: 204 }),
        () => new Response('{', { status: 204 }),
        () => jsonResponse(200, { ok: 'maybe' }),
      );
    }
    this.unexpected.push(url);
    this.calls.push({
      route: url.replace(API_BASE, ''),
      fault: 'unexpected',
      outcome: '404',
      at: this.now(),
    });
    return jsonResponse(404, { error: { message: 'unexpected route' } });
  };
}

// ─── Other native seams driven per iteration ─────────────────────────────────

type LinkingFault = 'ok' | 'rejects' | 'throws-sync' | 'hangs';
type StoreReviewFault = 'ok' | 'missing' | 'rejects' | 'hangs';
type SqliteFault =
  | 'ok'
  | 'open-throws'
  | 'kv-read-throws'
  | 'kv-write-throws'
  | 'profile-malformed';
type ClockFault = 'normal' | 'far-past' | 'far-future';
type Install = 'synced' | 'guest' | 'signed-out';

const PROFILE_MALFORMED_VARIANTS: Record<string, string> = {
  'focus-number': JSON.stringify({ ...validProfile(), focusCheckpoint: 7 }),
  'firstname-number': JSON.stringify({ ...validProfile(), firstName: 42 }),
  'gender-unknown': JSON.stringify({ ...validProfile(), gender: 'other' }),
  'json-array': JSON.stringify([1, 2, 3]),
  'json-string': JSON.stringify('abc'),
  'json-number': '42',
  'not-json': '{not json',
  'null-fields': JSON.stringify({
    skillLevel: null,
    handedness: null,
    goal: null,
    biggestProblem: null,
    focusCheckpoint: null,
  }),
};

const linkingState = {
  fault: 'ok' as LinkingFault,
  opened: [] as string[],
  pendingHangs: 0,
};
const storeReviewState = {
  fault: 'ok' as StoreReviewFault,
  requests: 0,
  pendingHangs: 0,
};

const nativeModules = NativeModules as {
  PickleAuth?: unknown;
  PickleStoreReview?: unknown;
};

function installStoreReviewModule(): void {
  if (storeReviewState.fault === 'missing') {
    delete nativeModules.PickleStoreReview;
    return;
  }
  nativeModules.PickleStoreReview = {
    requestReview: async () => {
      storeReviewState.requests += 1;
      if (storeReviewState.fault === 'rejects') {
        throw new Error('SKStoreReviewController unavailable (simulated)');
      }
      if (storeReviewState.fault === 'hangs') {
        storeReviewState.pendingHangs += 1;
        return new Promise<boolean>(() => {});
      }
      return true;
    },
  };
}

// ─── Scenario space ──────────────────────────────────────────────────────────

type ActionKind =
  | 'settle'
  | 'advance-60s'
  | 'tap-membership'
  | 'tap-membership-twice'
  | 'tap-consent'
  | 'tap-consent-retry'
  | 'tap-notifications'
  | 'tap-consistency'
  | 'tap-manage-account'
  | 'tap-privacy'
  | 'tap-terms'
  | 'tap-rate'
  | 'tap-walkthrough'
  | 'sign-out-cancel'
  | 'sign-out-confirm'
  | 'refocus-settings'
  | 'remount'
  | 'heal-server'
  | 'rotate-bearer';

const ACTION_KINDS: readonly ActionKind[] = [
  'settle',
  'advance-60s',
  'tap-membership',
  'tap-membership-twice',
  'tap-consent',
  'tap-consent-retry',
  'tap-notifications',
  'tap-consistency',
  'tap-manage-account',
  'tap-privacy',
  'tap-terms',
  'tap-rate',
  'tap-walkthrough',
  'sign-out-cancel',
  'sign-out-confirm',
  'refocus-settings',
  'remount',
  'heal-server',
  'rotate-bearer',
];

interface Scenario {
  name: string;
  seed: number | null;
  install: Install;
  server: ServerFaults;
  ledger: AccessLedger;
  consentActive: boolean;
  slowMs: number;
  keychain: KeychainFault;
  sqlite: SqliteFault;
  profileVariant: string | null;
  revenueCat: RevenueCatFault;
  permissions: PermissionFault;
  linking: LinkingFault;
  storeReview: StoreReviewFault;
  clock: ClockFault;
  actions: ActionKind[];
}

function injectedFaults(scenario: Scenario): string[] {
  const faults: string[] = [];
  if (scenario.server.access !== 'ok')
    faults.push(`fetch.access=${scenario.server.access}`);
  if (scenario.server.consent !== 'ok')
    faults.push(`fetch.consent=${scenario.server.consent}`);
  if (scenario.server.logout !== 'ok')
    faults.push(`fetch.logout=${scenario.server.logout}`);
  if (scenario.server.refreshLater !== 'ok') {
    faults.push(`fetch.refresh=${scenario.server.refreshLater}`);
  }
  if (scenario.keychain !== 'ok') faults.push(`keychain=${scenario.keychain}`);
  if (scenario.sqlite !== 'ok') {
    faults.push(
      `sqlite=${scenario.sqlite}${
        scenario.profileVariant ? `:${scenario.profileVariant}` : ''
      }`,
    );
  }
  if (scenario.revenueCat !== 'ok')
    faults.push(`revenuecat=${scenario.revenueCat}`);
  if (scenario.permissions !== 'ok')
    faults.push(`permissions=${scenario.permissions}`);
  if (scenario.linking !== 'ok') faults.push(`linking=${scenario.linking}`);
  if (scenario.storeReview !== 'ok')
    faults.push(`storeReview=${scenario.storeReview}`);
  if (scenario.clock !== 'normal') faults.push(`clock=${scenario.clock}`);
  return faults;
}

const KEYCHAIN_FAULTS: readonly KeychainFault[] = [
  'get-throws',
  'get-malformed',
  'reset-rejects',
  'reset-hangs',
  'set-throws',
];
const SQLITE_FAULTS: readonly SqliteFault[] = [
  'open-throws',
  'kv-read-throws',
  'kv-write-throws',
  'profile-malformed',
];
const REVENUECAT_FAULTS: readonly RevenueCatFault[] = [
  'configure-throws',
  'configure-hangs',
  'is-configured-throws',
  'offerings-reject',
  'offerings-malformed',
  'offerings-empty',
  'offerings-hang',
  'customer-info-rejects',
];
const PERMISSION_FAULTS: readonly PermissionFault[] = [
  'permission-throws',
  'permission-hangs',
  'permission-malformed',
  'cancel-all-rejects',
];
const LINKING_FAULTS: readonly LinkingFault[] = [
  'rejects',
  'throws-sync',
  'hangs',
];
const STORE_REVIEW_FAULTS: readonly StoreReviewFault[] = [
  'missing',
  'rejects',
  'hangs',
];
const CLOCK_FAULTS: readonly ClockFault[] = ['far-past', 'far-future'];

function seededScenario(seed: number): Scenario {
  const rng = makePrng(seed);
  const maybe = <T,>(
    probability: number,
    items: readonly T[],
    fallback: T,
  ): T => (rng() < probability ? pick(rng, items) : fallback);
  const install: Install =
    rng() < 0.8 ? 'synced' : rng() < 0.6 ? 'guest' : 'signed-out';
  const scenario: Scenario = {
    name: `seed-${seed}`,
    seed,
    install,
    server: {
      access: maybe(0.6, HTTP_FAULTS, 'ok'),
      consent: maybe(0.5, HTTP_FAULTS, 'ok'),
      logout: maybe(0.4, HTTP_FAULTS, 'ok'),
      refreshLater: maybe(0.2, ['http401', 'http500', 'hang'] as const, 'ok'),
    },
    ledger: {
      premium: rng() < 0.25,
      used: Math.floor(rng() * 3),
      reserved: 0,
    },
    consentActive: rng() < 0.5,
    slowMs: pick(rng, [1_500, 3_000, 9_000, 20_000, 45_000]),
    keychain: maybe(0.3, KEYCHAIN_FAULTS, 'ok'),
    sqlite: maybe(0.3, SQLITE_FAULTS, 'ok'),
    profileVariant: null,
    revenueCat: maybe(0.4, REVENUECAT_FAULTS, 'ok'),
    permissions: maybe(0.3, PERMISSION_FAULTS, 'ok'),
    linking: maybe(0.3, LINKING_FAULTS, 'ok'),
    storeReview: maybe(0.3, STORE_REVIEW_FAULTS, 'ok'),
    clock: maybe(0.2, CLOCK_FAULTS, 'normal'),
    actions: [],
  };
  if (scenario.ledger.used < 2 && rng() < 0.3) scenario.ledger.reserved = 1;
  if (scenario.sqlite === 'profile-malformed') {
    scenario.profileVariant = pick(
      rng,
      Object.keys(PROFILE_MALFORMED_VARIANTS),
    );
  }
  // The Keychain read faults decide the install: a record that cannot be
  // read lands signed out, so keep those on synced installs only.
  if (
    (scenario.keychain === 'get-throws' ||
      scenario.keychain === 'get-malformed') &&
    install !== 'synced'
  ) {
    scenario.keychain = 'ok';
  }
  const steps = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < steps; i += 1) {
    scenario.actions.push(pick(rng, ACTION_KINDS));
  }
  // Every seed ends by removing the faults and re-focusing the screen, so the
  // recovery invariant is measured on every iteration.
  scenario.actions.push(
    'advance-60s',
    'heal-server',
    'refocus-settings',
    'settle',
  );
  if (injectedFaults(scenario).length === 0) {
    scenario.server.access = HTTP_FAULTS[seed % HTTP_FAULTS.length] ?? 'hang';
  }
  return scenario;
}

function fixedScenario(
  name: string,
  overrides: Partial<Scenario> & { actions: ActionKind[] },
): Scenario {
  return {
    name,
    seed: null,
    install: 'synced',
    server: { access: 'ok', consent: 'ok', logout: 'ok', refreshLater: 'ok' },
    ledger: { premium: false, used: 1, reserved: 0 },
    consentActive: true,
    slowMs: 3_000,
    keychain: 'ok',
    sqlite: 'ok',
    profileVariant: null,
    revenueCat: 'ok',
    permissions: 'ok',
    linking: 'ok',
    storeReview: 'ok',
    clock: 'normal',
    ...overrides,
  };
}

const FIXED_SCENARIOS: Scenario[] = [
  fixedScenario('control-no-fault', {
    actions: [
      'settle',
      'tap-membership',
      'tap-consent',
      'advance-60s',
      'refocus-settings',
      'settle',
    ],
  }),
  ...HTTP_FAULTS.map(fault =>
    fixedScenario(`access-${fault}`, {
      server: {
        access: fault,
        consent: 'ok',
        logout: 'ok',
        refreshLater: 'ok',
      },
      actions: [
        'settle',
        'advance-60s',
        'tap-membership',
        'advance-60s',
        'heal-server',
        'refocus-settings',
        'settle',
      ],
    }),
  ),
  ...HTTP_FAULTS.map(fault =>
    fixedScenario(`consent-${fault}`, {
      server: {
        access: 'ok',
        consent: fault,
        logout: 'ok',
        refreshLater: 'ok',
      },
      actions: [
        'settle',
        'advance-60s',
        'tap-consent',
        'tap-consent-retry',
        'advance-60s',
        'heal-server',
        'refocus-settings',
        'settle',
      ],
    }),
  ),
  ...(['network', 'http500', 'slow', 'hang'] as const).map(fault =>
    fixedScenario(`logout-${fault}`, {
      server: {
        access: 'ok',
        consent: 'ok',
        logout: fault,
        refreshLater: 'ok',
      },
      actions: [
        'settle',
        'sign-out-cancel',
        'sign-out-confirm',
        'advance-60s',
        'settle',
      ],
    }),
  ),
  ...KEYCHAIN_FAULTS.map(fault =>
    fixedScenario(`keychain-${fault}`, {
      keychain: fault,
      actions: ['settle', 'sign-out-confirm', 'advance-60s', 'settle'],
    }),
  ),
  ...SQLITE_FAULTS.filter(f => f !== 'profile-malformed').map(fault =>
    fixedScenario(`sqlite-${fault}`, {
      sqlite: fault,
      actions: [
        'settle',
        'tap-rate',
        'tap-notifications',
        'advance-60s',
        'settle',
      ],
    }),
  ),
  ...Object.keys(PROFILE_MALFORMED_VARIANTS).map(variant =>
    fixedScenario(`sqlite-profile-${variant}`, {
      sqlite: 'profile-malformed',
      profileVariant: variant,
      actions: ['settle', 'advance-60s', 'settle'],
    }),
  ),
  ...Object.keys(PROFILE_MALFORMED_VARIANTS).map(variant =>
    fixedScenario(`sqlite-profile-guest-${variant}`, {
      install: 'guest',
      sqlite: 'profile-malformed',
      profileVariant: variant,
      actions: ['settle', 'advance-60s', 'settle'],
    }),
  ),
  ...REVENUECAT_FAULTS.map(fault =>
    fixedScenario(`revenuecat-${fault}`, {
      revenueCat: fault,
      actions: [
        'settle',
        'tap-membership',
        'advance-60s',
        'refocus-settings',
        'settle',
      ],
    }),
  ),
  ...PERMISSION_FAULTS.map(fault =>
    fixedScenario(`permissions-${fault}`, {
      permissions: fault,
      actions: ['settle', 'tap-notifications', 'advance-60s', 'settle'],
    }),
  ),
  ...LINKING_FAULTS.map(fault =>
    fixedScenario(`linking-${fault}`, {
      linking: fault,
      actions: [
        'settle',
        'tap-privacy',
        'tap-terms',
        'tap-rate',
        'advance-60s',
        'settle',
      ],
    }),
  ),
  ...STORE_REVIEW_FAULTS.map(fault =>
    fixedScenario(`storereview-${fault}`, {
      storeReview: fault,
      linking: 'rejects',
      actions: ['settle', 'tap-rate', 'advance-60s', 'settle'],
    }),
  ),
  ...CLOCK_FAULTS.map(fault =>
    fixedScenario(`clock-${fault}`, {
      clock: fault,
      actions: [
        'settle',
        'tap-membership',
        'advance-60s',
        'refocus-settings',
        'settle',
      ],
    }),
  ),
  ...(['http401', 'http500', 'hang'] as const).map(fault =>
    fixedScenario(`refresh-later-${fault}`, {
      server: {
        access: 'ok',
        consent: 'ok',
        logout: 'ok',
        refreshLater: fault,
      },
      actions: [
        'settle',
        'rotate-bearer',
        'advance-60s',
        'refocus-settings',
        'settle',
      ],
    }),
  ),
  fixedScenario('navigation-double-tap-while-access-hangs', {
    server: { access: 'hang', consent: 'ok', logout: 'ok', refreshLater: 'ok' },
    actions: [
      'settle',
      'tap-membership-twice',
      'advance-60s',
      'remount',
      'settle',
    ],
  }),
  fixedScenario('navigation-remount-during-slow-access', {
    server: {
      access: 'slow',
      consent: 'slow',
      logout: 'ok',
      refreshLater: 'ok',
    },
    slowMs: 9_000,
    actions: ['settle', 'remount', 'advance-60s', 'refocus-settings', 'settle'],
  }),
  fixedScenario('guest-control', {
    install: 'guest',
    actions: [
      'settle',
      'tap-membership',
      'tap-consent',
      'advance-60s',
      'settle',
    ],
  }),
  fixedScenario('signed-out-control', {
    install: 'signed-out',
    actions: ['settle', 'tap-consent', 'advance-60s', 'settle'],
  }),
];

// ─── Tree helpers ────────────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;
type Node = TestRenderer.ReactTestInstance;

function textsOf(renderer: Renderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => {
      const children = node.props.children as unknown;
      return Array.isArray(children) ? children : [children];
    })
    .filter((child): child is string => typeof child === 'string');
}

function pressables(renderer: Renderer): Node[] {
  return renderer.root.findAll(
    node => typeof node.props.onPress === 'function',
  );
}

function labelOf(node: Node): string {
  return String(
    node.props.accessibilityLabel ?? node.props['aria-label'] ?? '',
  );
}

function findPressable(
  renderer: Renderer,
  predicate: (label: string, node: Node) => boolean,
): Node | null {
  return (
    pressables(renderer).find(node => predicate(labelOf(node), node)) ?? null
  );
}

function hasSpinner(renderer: Renderer): boolean {
  return (
    renderer.root.findAll(node => {
      const type = node.type as
        { displayName?: string; name?: string } | string;
      const typeName =
        typeof type === 'string' ? type : (type.displayName ?? type.name ?? '');
      return (
        typeName === 'BrandSpinner' ||
        typeName === 'ActivityIndicator' ||
        node.props.accessibilityRole === 'progressbar'
      );
    }).length > 0
  );
}

function visibleTexts(renderer: Renderer): string[] {
  return textsOf(renderer);
}

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

// The real App: SafeArea + QueryClient providers, RootErrorBoundary, the Gate
// (auth → owner stores → pre-auth / profile-error / onboarding / RootNavigator),
// BrandNoticeHost. Only the video splash is stubbed (it hands off as soon as
// the Gate reports ready).
function Harness() {
  return <App />;
}

// ─── Process reset (in-memory singletons; Keychain + SQLite survive) ─────────

function resetProcessState(): void {
  clearSyncRuntime();
  stopSessionKeeper();
  clearApiSession();
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    session: null,
    hydrated: false,
    busy: false,
    error: null,
    localDataError: null,
    deletionCleanup: null,
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
  });
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
  useConsentStore.setState({
    availability: 'signed_out',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
  useWalkthroughStore.setState({ visible: false, queued: false });
}

// ─── One iteration ───────────────────────────────────────────────────────────

interface Row {
  scenario: string;
  seed: number | null;
  install: Install;
  faults: string[];
  actions: ActionKind[];
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  failed: string[];
  /** Finding ids (from KNOWN_FINDINGS) that explain each failed invariant. */
  knownFindings: string[];
  ok: boolean;
  timeline: { at: number; event: string; detail?: unknown }[];
  durationMs: number;
}

const INITIAL_REFRESH = 'refresh-seeded';
const CANONICAL_OWNER = canonicalDataOwner(CANONICAL_ID);

// ─── Known findings (reproduced defects, each pinned by a test.failing) ──────
//
// F1  PaywallScreen only calls `initialize()` while accessStore.status is
//     'idle' (PaywallScreen.tsx `if (status === 'idle') void initialize()`),
//     but SettingsScreen's focus refresh has already moved the status to
//     'ready'/'error' before the membership row is tapped. Opened from
//     Settings, the pricing page therefore shows "Store pricing is unavailable"
//     with a healthy store that was never asked; "Try again" recovers.
// F2  `/v1/me/access` has no client-side timeout (billing/accessApi.ts).
//     A hung request leaves accessStore.status === 'loading' for ever: the
//     Settings focus refresh is skipped while loading, the membership row
//     stays "Verify access" and the paywall's pricing page shows the
//     "Loading App Store pricing" spinner with no retry control.
// F3  RevenueCat SDK `configure`/`getOfferings` that never settle keep
//     `initialize()` pending: same never-ending spinner, no retry.
// F4  appStore.hydrate() trusts the persisted profile row
//     (`JSON.parse(raw) as Profile`, appStore.ts). A non-string
//     `focusCheckpoint` (any install) or `firstName` (local-only install)
//     throws inside SettingsScreen's render (`.replace`, `.charAt`) and the
//     RootErrorBoundary's "Try again" re-throws on the same data.
const KNOWN_FINDINGS = {
  'F1.paywall-from-settings-never-asks-store':
    'PaywallScreen skips initialize() when access status is not idle',
  'F2.access-request-without-timeout':
    'hung /v1/me/access pins accessStore in loading for ever',
  'F3.revenuecat-sdk-hang-without-timeout':
    'hung RevenueCat SDK call pins initialize() for ever',
  'F4.malformed-persisted-profile-crashes-settings':
    'non-string profile field throws in SettingsScreen render',
} as const;
type KnownFindingId = keyof typeof KNOWN_FINDINGS;

function knownFindingFor(
  scenario: Scenario,
  invariant: string,
  detail: string,
): KnownFindingId | null {
  const accessHangs = scenario.server.access === 'hang';
  const sdkHangs =
    scenario.revenueCat === 'configure-hangs' ||
    scenario.revenueCat === 'offerings-hang';
  if (
    invariant === 'I8.paywall-asks-store' &&
    detail.includes('RevenueCat was never asked')
  ) {
    return 'F1.paywall-from-settings-never-asks-store';
  }
  if (invariant === 'I2.no-infinite-spinner' && accessHangs) {
    return 'F2.access-request-without-timeout';
  }
  if (
    invariant === 'I7.recovers-after-heal' &&
    accessHangs &&
    detail.includes('accessStore.status=loading')
  ) {
    return 'F2.access-request-without-timeout';
  }
  if (
    invariant === 'I2.no-infinite-spinner' &&
    sdkHangs &&
    /Try again|advance-60s/.test(detail)
  ) {
    return 'F3.revenuecat-sdk-hang-without-timeout';
  }
  if (
    invariant === 'I1.no-crash' &&
    detail.includes('RootErrorBoundary') &&
    (scenario.profileVariant === 'focus-number' ||
      (scenario.profileVariant === 'firstname-number' &&
        scenario.install === 'guest'))
  ) {
    return 'F4.malformed-persisted-profile-crashes-settings';
  }
  return null;
}

async function runScenario(scenario: Scenario): Promise<Row> {
  const startedWall = Date.now();
  const systemTime =
    scenario.clock === 'far-past'
      ? new Date('2001-01-01T00:00:00.000Z')
      : scenario.clock === 'far-future'
        ? new Date('2099-12-31T23:59:00.000Z')
        : new Date('2026-03-01T09:00:00.000Z');
  jest.setSystemTime(systemTime);
  const t0 = Date.now();
  const rel = () => Date.now() - t0;
  const timeline: Row['timeline'] = [];
  const log = (event: string, detail?: unknown) => {
    timeline.push({
      at: rel(),
      event,
      ...(detail !== undefined ? { detail } : {}),
    });
  };
  const violations = new Map<string, string>();
  const violate = (invariant: string, detail: string) => {
    if (!violations.has(invariant)) violations.set(invariant, detail);
    log(`VIOLATION ${invariant}`, detail);
  };

  // ── Persisted world.
  const db = new FakeLocalDb();
  mockDb.current = db;
  mockKeychain.store.clear();
  mockKeychain.log.length = 0;
  mockKeychain.pendingHangs = 0;
  mockKeychain.fault = scenario.keychain;
  const server = new ScriptedServer();
  server.faults = { ...scenario.server };
  server.ledger = { ...scenario.ledger };
  server.consentActive = scenario.consentActive;
  server.slowMs = scenario.slowMs;
  server.now = rel;
  (globalThis as { fetch: unknown }).fetch = server.fetch;
  mockScheduler.current = new FakeScheduler();
  mockScheduler.current.fault = scenario.permissions;
  mockPurchases.fault = scenario.revenueCat;
  mockPurchases.configured = false;
  mockPurchases.appUserId = '';
  mockPurchases.calls.length = 0;
  mockPurchases.pendingHangs = 0;
  linkingState.fault = scenario.linking;
  linkingState.opened.length = 0;
  linkingState.pendingHangs = 0;
  storeReviewState.fault = scenario.storeReview;
  storeReviewState.requests = 0;
  storeReviewState.pendingHangs = 0;
  installStoreReviewModule();

  const profileKey = `profile:${CANONICAL_OWNER}`;
  const guestProfileKey = `profile:${GUEST_DATA_OWNER}`;
  if (scenario.install === 'synced') {
    mockKeychain.store.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify(validVault({ refreshToken: INITIAL_REFRESH })),
    });
    server.seedRefreshToken(INITIAL_REFRESH);
    db.kv.set(profileKey, JSON.stringify(validProfile()));
    db.seedShots(CANONICAL_OWNER, 12, 'real');
  } else if (scenario.install === 'guest') {
    db.kv.set('auth.local-mode', JSON.stringify({ version: 1, mode: 'guest' }));
    db.kv.set(
      guestProfileKey,
      JSON.stringify({ ...validProfile(), firstName: 'Sam' }),
    );
    db.seedShots(GUEST_DATA_OWNER, 5, 'real');
  } else {
    db.kv.set(
      'auth.local-mode',
      JSON.stringify({ version: 1, mode: 'signed-out' }),
    );
  }
  db.kv.set('walkthrough.device-complete', JSON.stringify({ version: 1 }));
  db.seedShots('other-owner', 3, 'stranger');
  if (scenario.sqlite === 'profile-malformed' && scenario.profileVariant) {
    const raw = PROFILE_MALFORMED_VARIANTS[scenario.profileVariant];
    if (raw !== undefined) {
      db.kv.set(
        scenario.install === 'guest' ? guestProfileKey : profileKey,
        raw,
      );
    }
  }
  const kvBefore = new Map(db.kv);
  const shotsBefore = db.shotFingerprint();
  const vaultBefore =
    mockKeychain.store.get(SESSION_VAULT_SERVICE)?.password ?? null;
  if (scenario.sqlite === 'open-throws') {
    db.faults.openThrows = 'SQLITE_CANTOPEN (simulated)';
  } else if (scenario.sqlite === 'kv-read-throws') {
    db.faults.kvGetThrows = new Set([
      profileKey,
      guestProfileKey,
      'auth.local-mode',
      'review.state',
      `notifications:${CANONICAL_OWNER}`,
    ]);
    db.faults.sqlThrows = /SELECT value FROM kv/;
  } else if (scenario.sqlite === 'kv-write-throws') {
    db.faults.sqlThrows = /INSERT OR REPLACE INTO kv/;
  }

  resetProcessState();

  // ── Mount the real tree; the Gate runs the launch path (auth first, then the
  // owner's stores) exactly as on device.
  let renderer: Renderer | null = null;
  const mount = () => {
    act(() => {
      renderer = TestRenderer.create(<Harness />);
    });
  };
  const unmount = () => {
    if (!renderer) return;
    const current = renderer;
    act(() => current.unmount());
    renderer = null;
  };
  const current = (): Renderer => {
    if (!renderer) throw new Error('tree not mounted');
    return renderer;
  };

  let crashed = false;
  const renderErrors: string[] = [];
  const realConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    // React 19 reports boundary-caught errors as console.error('%o…', error, …).
    const thrown = args.find((arg): arg is Error => arg instanceof Error);
    const message = thrown
      ? `${thrown.name}: ${thrown.message}`
      : String(args[0] ?? '');
    if (/Error/.test(message) && !/act\(\)/.test(message)) {
      renderErrors.push((message.split('\n')[0] ?? message).slice(0, 300));
    }
  };
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason instanceof Error ? reason.message : String(reason));
  };
  (
    nodeProcess as unknown as {
      on(event: string, listener: (reason: unknown) => void): void;
    }
  ).on('unhandledRejection', onUnhandled);

  const boundaryTripped = () =>
    visibleTexts(current()).includes('Something went wrong');

  // The Gate only mounts RootNavigator (and so the Settings tab) with a
  // session AND a profile; anywhere else Settings is unreachable by contract.
  const mainAppExpected = () =>
    Boolean(useAuthStore.getState().session) &&
    Boolean(useAppStore.getState().profile);

  const openSettingsTab = async () => {
    if (!mainAppExpected() || boundaryTripped()) return false;
    const tab = findPressable(
      current(),
      (label, node) =>
        label === 'Settings' && node.props.accessibilityRole === 'tab',
    );
    if (!tab) {
      violate('I3.visible-control', 'no Settings tab pressable in tree');
      return false;
    }
    act(() => tab.props.onPress());
    await flush(50);
    return true;
  };

  type GateState =
    | 'main-app'
    | 'pre-auth'
    | 'profile-error'
    | 'onboarding'
    | 'loading'
    | 'crashed';
  // Launch/relaunch: the Gate waits for auth (≤ 8 s refresh budget) and the
  // owner's stores before it paints anything but the loading state.
  const awaitGate = async (): Promise<GateState> => {
    await flush(0);
    for (
      let waited = 0;
      waited < 9_000 &&
      !(useAuthStore.getState().hydrated && useAppStore.getState().hydrated);
      waited += 250
    ) {
      await flush(250);
    }
    await flush(100);
    const auth = useAuthStore.getState();
    const app = useAppStore.getState();
    const gate: GateState = boundaryTripped()
      ? 'crashed'
      : !auth.hydrated || !app.hydrated
        ? 'loading'
        : !auth.session
          ? 'pre-auth'
          : !app.profile && app.hydrateError
            ? 'profile-error'
            : !app.profile
              ? 'onboarding'
              : 'main-app';
    log('launch.gate', {
      gate,
      session: auth.session
        ? `${auth.session.provider}:${auth.session.localOnly ? 'local' : 'synced'}`
        : null,
      hydrateError: app.hydrateError,
    });
    if (gate === 'profile-error') {
      // App.tsx ErrorState: the failure must be visible and retryable.
      const texts = visibleTexts(current());
      if (!texts.some(t => t.includes('profile'))) {
        violate(
          'I4.no-silent-failure',
          'profile-error gate shows no profile message',
        );
      }
      if (!findPressable(current(), label => /try again|retry/i.test(label))) {
        violate(
          'I3.visible-control',
          'profile-error gate has no retry control',
        );
      }
    }
    if (gate === 'loading') {
      violate('I2.no-infinite-spinner', 'Gate still loading 9 s after launch');
    }
    if (gate === 'main-app') {
      await openSettingsTab();
      log('settings.opened', { texts: visibleTexts(current()).length });
    } else {
      log('settings.unreachable', gate);
    }
    return gate;
  };

  const onSettings = () =>
    visibleTexts(current()).includes('Settings') &&
    visibleTexts(current()).some(t => t.startsWith('Your player profile'));

  const goBackIfPossible = async () => {
    const back = findPressable(
      current(),
      label =>
        label === 'Back' ||
        label === 'Close membership offer' ||
        label === 'Close membership' ||
        label === 'Back to membership benefits',
    );
    if (!back) return false;
    act(() => back.props.onPress());
    await flush(50);
    return true;
  };

  const checkSpinnerAfter60s = async (where: string) => {
    await flush(60_000);
    if (boundaryTripped()) return;
    if (hasSpinner(current())) {
      const retry = findPressable(
        current(),
        label =>
          /retry|try again/i.test(label) ||
          label === 'Back' ||
          label.startsWith('Close membership'),
      );
      violate(
        'I2.no-infinite-spinner',
        `${where}: spinner still visible 60s after the fault${
          retry
            ? ` (a "${labelOf(retry)}" control is visible)`
            : ' and no retry/back control'
        }`,
      );
    }
  };

  const tapRow = async (prefix: string) => {
    const row = findPressable(
      current(),
      label => label.startsWith(`${prefix},`) || label === prefix,
    );
    if (!row) {
      if (onSettings()) {
        log('row.missing', prefix);
      }
      return false;
    }
    act(() => row.props.onPress());
    await flush(50);
    return true;
  };

  mount();
  const launchGate = await awaitGate();

  const signedInSynced = () => {
    const session = useAuthStore.getState().session;
    return session !== null && !session.localOnly;
  };

  const rowsSeenOnSettings = (renderer: Renderer) =>
    pressables(renderer)
      .map(labelOf)
      .filter(label => label.includes(','));

  // ── Drive the seeded action script.
  for (const action of scenario.actions) {
    if (boundaryTripped()) break;
    log(`action.${action}`);
    switch (action) {
      case 'settle':
        await flush(500);
        break;
      case 'advance-60s':
        await checkSpinnerAfter60s(`after ${action}`);
        break;
      case 'tap-membership':
      case 'tap-membership-twice': {
        const tapped =
          (await tapRow('Pickle Sensei Pro')) ||
          (await tapRow('Connect account'));
        if (tapped && action === 'tap-membership-twice') {
          // A second tap on the row that is still underneath the modal.
          const row = findPressable(current(), label =>
            label.startsWith('Pickle Sensei Pro,'),
          );
          if (row) act(() => row.props.onPress());
          await flush(50);
        }
        if (!tapped) break;
        await flush(1_000);
        const onPaywall = visibleTexts(current()).some(t =>
          /membership|Pro|pricing/i.test(t),
        );
        log('paywall.visible', onPaywall);
        // The paywall's value page never shows pricing; the loading / price /
        // unavailable states live on step 2, so step onto it like a user.
        const seePlans = findPressable(
          current(),
          label => label === 'See membership plans',
        );
        const storeCallsBefore = mockPurchases.calls.length;
        if (seePlans) {
          act(() => seePlans.props.onPress());
          await flush(400);
        }
        await checkSpinnerAfter60s('Paywall pricing page opened from Settings');
        const priceShown = (texts: string[]) =>
          texts.some(t => /^Continue · \$/.test(t));
        const storeHealthy =
          scenario.revenueCat === 'ok' ||
          scenario.revenueCat === 'customer-info-rejects';
        if (!boundaryTripped()) {
          let texts = visibleTexts(current());
          let store = useAccessStore.getState();
          const unavailable = texts.includes('Store pricing is unavailable');
          const storeAsked = mockPurchases.calls
            .slice(storeCallsBefore)
            .some(call => call === 'configure' || call === 'getOfferings');
          log('paywall.pricing-page', {
            reached: seePlans !== null,
            unavailable,
            priced: priceShown(texts),
            storeAsked,
            accessStatus: store.status,
          });
          // No fake success: a paywall may only show a price from the store.
          if (!storeHealthy && priceShown(texts)) {
            violate(
              'I5.no-fake-success',
              `paywall shows a price while RevenueCat fault=${scenario.revenueCat}`,
            );
          }
          if (
            seePlans &&
            store.status !== 'loading' &&
            !store.plans &&
            !unavailable
          ) {
            violate(
              'I4.no-silent-failure',
              'pricing page has no plans, is not loading, and shows no unavailable notice',
            );
          }
          // No fake failure: "unavailable" may only be claimed after the store
          // was actually asked (a healthy store reported as down is a silent
          // failure of the load path, not a store outage).
          if (seePlans && unavailable && !storeAsked && !store.plans) {
            violate(
              'I8.paywall-asks-store',
              `pricing page shows "Store pricing is unavailable" but RevenueCat was never asked (accessStatus=${store.status}, purchasesCalls=${JSON.stringify(mockPurchases.calls)})`,
            );
          }
          if (seePlans && unavailable) {
            const retry = findPressable(
              current(),
              label => label === 'Retry loading membership',
            );
            if (!retry) {
              violate(
                'I3.visible-control',
                'pricing unavailable but no "Retry loading membership" control',
              );
            } else {
              act(() => retry.props.onPress());
              await flush(50);
              await checkSpinnerAfter60s('Paywall after "Try again"');
              if (!boundaryTripped()) {
                texts = visibleTexts(current());
                store = useAccessStore.getState();
                const pricedAfterRetry = priceShown(texts);
                log('paywall.after-retry', {
                  priced: pricedAfterRetry,
                  unavailable: texts.includes('Store pricing is unavailable'),
                  accessStatus: store.status,
                  error: store.error?.message ?? null,
                });
                if (!storeHealthy && pricedAfterRetry) {
                  violate(
                    'I5.no-fake-success',
                    `retry shows a price while RevenueCat fault=${scenario.revenueCat}`,
                  );
                }
                if (storeHealthy && !pricedAfterRetry) {
                  violate(
                    'I7.recovers-after-heal',
                    `store is healthy but "Try again" did not surface store pricing (accessStatus=${store.status}, error=${store.error?.message ?? 'none'})`,
                  );
                }
                if (
                  !pricedAfterRetry &&
                  store.status !== 'loading' &&
                  !texts.includes('Store pricing is unavailable')
                ) {
                  violate(
                    'I4.no-silent-failure',
                    'after retry: no price, not loading, and no unavailable notice',
                  );
                }
              }
            }
          }
          if (!boundaryTripped()) {
            const exitControl = findPressable(
              current(),
              label =>
                label.startsWith('Close membership') ||
                label === 'Back to membership benefits' ||
                // local-only installs land on ConnectAccount (SignIn) instead
                label === 'Back',
            );
            if (!exitControl)
              violate(
                'I3.visible-control',
                'membership destination has no close/back control',
              );
          }
        }
        while (
          !boundaryTripped() &&
          !onSettings() &&
          (await goBackIfPossible())
        ) {
          // unwind to Settings
        }
        break;
      }
      case 'tap-consent':
      case 'tap-consent-retry': {
        if (!(await tapRow('Data & consent'))) break;
        await flush(500);
        if (action === 'tap-consent-retry') {
          await flush(16_000);
          const retry = findPressable(
            current(),
            label => label === 'Try again',
          );
          if (retry) {
            act(() => retry.props.onPress());
            await flush(50);
          } else if (
            useConsentStore.getState().availability === 'unavailable' &&
            !boundaryTripped()
          ) {
            violate(
              'I3.visible-control',
              'consent unavailable but no "Try again" control on ConsentSettings',
            );
          }
        }
        await checkSpinnerAfter60s('ConsentSettings opened from Settings');
        if (!boundaryTripped()) {
          const consent = useConsentStore.getState();
          const texts = visibleTexts(current());
          if (consent.availability === 'unavailable' && !consent.error) {
            violate(
              'I4.no-silent-failure',
              'consent unavailable with no error message in store',
            );
          }
          if (
            consent.availability !== 'ready' &&
            texts.some(t => t === 'Training: contributing')
          ) {
            violate(
              'I5.no-fake-success',
              'consent row claims contributing while status is not ready',
            );
          }
          if (!findPressable(current(), label => label === 'Back')) {
            violate(
              'I3.visible-control',
              'ConsentSettings has no Back control',
            );
          }
        }
        while (
          !boundaryTripped() &&
          !onSettings() &&
          (await goBackIfPossible())
        ) {
          // unwind
        }
        break;
      }
      case 'tap-notifications':
        if (await tapRow('Notifications')) {
          await flush(200);
          if (
            !boundaryTripped() &&
            !findPressable(current(), l => l === 'Back')
          ) {
            violate(
              'I3.visible-control',
              'NotificationSettings has no Back control',
            );
          }
          while (
            !boundaryTripped() &&
            !onSettings() &&
            (await goBackIfPossible())
          ) {
            // unwind
          }
        }
        break;
      case 'tap-consistency':
        if (await tapRow('Consistency')) {
          await flush(200);
          while (
            !boundaryTripped() &&
            !onSettings() &&
            (await goBackIfPossible())
          ) {
            // unwind
          }
        }
        break;
      case 'tap-manage-account':
        if (await tapRow('Manage account')) {
          await flush(200);
          while (
            !boundaryTripped() &&
            !onSettings() &&
            (await goBackIfPossible())
          ) {
            // unwind
          }
        }
        break;
      case 'tap-privacy':
      case 'tap-terms': {
        const openedBefore = linkingState.opened.length;
        const tapped = await tapRow(
          action === 'tap-privacy' ? 'Privacy policy' : 'Terms of use',
        );
        if (!tapped) break;
        await flush(500);
        const texts = visibleTexts(current());
        const noticeShown = texts.some(t => /could not be opened/.test(t));
        if (
          scenario.linking === 'rejects' ||
          scenario.linking === 'throws-sync'
        ) {
          if (!noticeShown) {
            violate(
              'I4.no-silent-failure',
              `Linking.openURL ${scenario.linking} but no "could not be opened" notice`,
            );
          }
          const dismiss = findPressable(current(), label =>
            /got it|ok|dismiss|close/i.test(label),
          );
          if (dismiss) {
            act(() => dismiss.props.onPress());
            await flush(50);
          }
        } else if (
          scenario.linking === 'ok' &&
          linkingState.opened.length === openedBefore
        ) {
          violate(
            'I4.no-silent-failure',
            'legal row tapped but Linking.openURL never called',
          );
        }
        break;
      }
      case 'tap-rate': {
        if (!(await tapRow('Rate Pickle Sensei'))) break;
        await flush(500);
        const texts = visibleTexts(current());
        const unavailable = texts.includes('Rating unavailable right now');
        const linkFailed =
          scenario.linking === 'rejects' || scenario.linking === 'throws-sync';
        const nativeFailed =
          scenario.storeReview === 'missing' ||
          scenario.storeReview === 'rejects';
        if (linkFailed && nativeFailed && !unavailable) {
          violate(
            'I4.no-silent-failure',
            'store page and native review both failed but no notice shown',
          );
        }
        if (!linkFailed && unavailable && scenario.linking !== 'hangs') {
          violate(
            'I5.no-fake-success',
            'rating notice claims unavailable although the store page opened',
          );
        }
        const dismiss = findPressable(current(), label =>
          /got it|ok|dismiss|close/i.test(label),
        );
        if (dismiss) {
          act(() => dismiss.props.onPress());
          await flush(50);
        }
        break;
      }
      case 'tap-walkthrough':
        if (await tapRow('App walkthrough')) {
          await flush(200);
          if (
            !useWalkthroughStore.getState().visible &&
            !useWalkthroughStore.getState().queued
          ) {
            violate(
              'I4.no-silent-failure',
              'walkthrough replay requested but store neither visible nor queued',
            );
          }
          useWalkthroughStore.setState({ visible: false, queued: false });
          await openSettingsTab();
        }
        break;
      case 'sign-out-cancel': {
        if (!useAuthStore.getState().session) break;
        const signOut = findPressable(current(), label => label === 'Sign out');
        if (!signOut) break;
        act(() => signOut.props.onPress());
        await flush(50);
        const cancel = findPressable(
          current(),
          label => label === 'Keep me signed in',
        );
        if (!cancel) {
          violate('I3.visible-control', 'sign-out sheet has no cancel control');
          break;
        }
        act(() => cancel.props.onPress());
        await flush(50);
        if (!useAuthStore.getState().session) {
          violate(
            'I5.no-fake-success',
            'cancelling the sign-out sheet signed the user out',
          );
        }
        break;
      }
      case 'sign-out-confirm': {
        const before = useAuthStore.getState().session;
        const signOut = findPressable(current(), label => label === 'Sign out');
        if (!signOut || !before) break;
        // The row and the sheet's confirm button share the label "Sign out";
        // the confirm is whichever pressable appeared once the sheet opened.
        const rowNodes = new Set(
          pressables(current()).filter(node => labelOf(node) === 'Sign out'),
        );
        act(() => signOut.props.onPress());
        await flush(50);
        const confirm = findPressable(
          current(),
          (label, node) => label === 'Sign out' && !rowNodes.has(node),
        );
        if (!confirm) {
          violate(
            'I3.visible-control',
            'sign-out sheet has no confirm control',
          );
          break;
        }
        act(() => confirm.props.onPress());
        await flush(50);
        if (useAuthStore.getState().session) {
          violate(
            'I4.no-silent-failure',
            'confirmed sign-out left the session in place',
          );
        }
        await flush(60_000);
        const vault = mockKeychain.store.get(SESSION_VAULT_SERVICE);
        if (before.provider !== 'guest' && vault) {
          if (
            scenario.keychain === 'reset-hangs' ||
            scenario.keychain === 'reset-rejects'
          ) {
            log('signout.vault-survived-keychain-fault', scenario.keychain);
          } else {
            violate(
              'I6.persisted-state',
              'signed out but the Keychain session record survived',
            );
          }
        }
        if (vault && vault.password.includes('access-')) {
          violate('I6.persisted-state', 'an access token reached the Keychain');
        }
        break;
      }
      case 'refocus-settings': {
        const home = findPressable(
          current(),
          (label, node) =>
            label === 'Home' && node.props.accessibilityRole === 'tab',
        );
        if (home) {
          act(() => home.props.onPress());
          await flush(50);
        }
        await openSettingsTab();
        await flush(500);
        break;
      }
      case 'remount':
        unmount();
        await flush(20);
        mount();
        await awaitGate();
        break;
      case 'heal-server':
        server.faults = {
          access: 'ok',
          consent: 'ok',
          logout: 'ok',
          refreshLater: 'ok',
        };
        mockPurchases.fault = 'ok';
        mockScheduler.current.fault = 'ok';
        linkingState.fault = 'ok';
        mockKeychain.fault = 'ok';
        db.faults = {};
        log('healed');
        // A relaunch whose refresh hung proceeds signed-in offline and the
        // sessionKeeper retries with backoff capped at 5 min; give it that
        // window so the check that follows measures recovery, not cadence.
        await flush(5 * 60_000 + 5_000);
        break;
      case 'rotate-bearer': {
        // Keeper-driven refresh: the bearer's TTL was 3600 s; jump past it.
        await flush(3_601_000);
        break;
      }
      default:
        break;
    }
  }

  // ── Final read-out.
  let boundaryRetryTripped: boolean | null = null;
  if (boundaryTripped()) {
    crashed = true;
    const retry = findPressable(
      current(),
      label => /try again|retry/i.test(label) || label.length > 0,
    );
    violate(
      'I1.no-crash',
      `RootErrorBoundary caught a render/effect throw${retry ? ' (boundary offers retry)' : ''}: ${
        renderErrors[0] ?? 'error not captured'
      }`,
    );
    if (retry) {
      // The boundary wraps the whole navigator, so "Try again" remounts it on
      // the Home tab; the user has to come back to Settings to see whether the
      // screen survives a second render of the same persisted data.
      act(() => retry.props.onPress());
      await flush(200);
      if (!boundaryTripped()) await openSettingsTab();
      await flush(200);
      boundaryRetryTripped = boundaryTripped();
      log('boundary.retry', { trippedAgainOnSettings: boundaryRetryTripped });
    }
  }
  console.error = realConsoleError;
  const finalTexts = renderer ? visibleTexts(current()) : [];
  const access = useAccessStore.getState();
  const consent = useConsentStore.getState();
  const auth = useAuthStore.getState();
  const membershipRow = renderer
    ? (rowsSeenOnSettings(current()).find(label =>
        label.startsWith('Pickle Sensei Pro,'),
      ) ?? null)
    : null;
  const membershipValue = membershipRow
    ? membershipRow.slice('Pickle Sensei Pro, '.length)
    : null;

  // Recovery: after heal + refocus, a synced account must show the server
  // ledger (the whole point of the focus refresh), never a stale/fake label.
  const healed =
    scenario.actions.includes('heal-server') &&
    scenario.actions.includes('refocus-settings');
  if (!crashed && renderer && healed && signedInSynced() && onSettings()) {
    const expected = expectedMembershipLabel(scenario.ledger);
    if (membershipValue !== expected) {
      violate(
        'I7.recovers-after-heal',
        `membership row "${membershipValue}" ≠ server ledger "${expected}" after faults were removed; accessStore.status=${access.status}, pending hung requests=${server.pendingHangs}`,
      );
    }
  }
  // No fake success at any point: a numeric/pro label must come from a
  // validated server payload.
  if (!crashed && renderer && signedInSynced() && membershipValue) {
    const claimsLedger = /free rating|Pro active|Upgrade required/.test(
      membershipValue,
    );
    if (claimsLedger && !access.canonicalAccess) {
      violate(
        'I5.no-fake-success',
        `membership row "${membershipValue}" while canonicalAccess is null`,
      );
    }
    if (access.canonicalAccess) {
      const fromStore = expectedMembershipLabel({
        premium: access.canonicalAccess.premium,
        used: access.canonicalAccess.freeRatings.used,
        reserved: access.canonicalAccess.freeRatings.reserved,
      });
      if (membershipValue !== fromStore) {
        violate(
          'I5.no-fake-success',
          `membership row "${membershipValue}" disagrees with store ledger "${fromStore}"`,
        );
      }
    }
  }
  if (!crashed && access.status === 'error' && !access.error) {
    violate(
      'I4.no-silent-failure',
      'accessStore status=error without an error message',
    );
  }
  // `slow` is a delayed success: the route answers correctly after slowMs.
  if (
    consent.availability === 'ready' &&
    scenario.server.consent !== 'ok' &&
    scenario.server.consent !== 'slow' &&
    !healed
  ) {
    violate(
      'I5.no-fake-success',
      `consent ready although /v1/me/consent/status fault=${scenario.server.consent}`,
    );
  }

  // Persisted state: only keys the flows legitimately write may differ, and
  // the shots table and the stranger's rows are untouched.
  const kvAfter = new Map(db.kv);
  const kvChanged = [
    ...new Set([...kvBefore.keys(), ...kvAfter.keys()]),
  ].filter(key => kvBefore.get(key) !== kvAfter.get(key));
  const allowedKvWrites = new Set([
    'auth.local-mode',
    'auth.last-provider',
    'review.state',
    'review.prompt-state',
    'walkthrough.device-complete',
    'onboarding.pending-profile',
    'notifications.pending-onboarding',
    `notifications:${CANONICAL_OWNER}`,
    `notifications:${GUEST_DATA_OWNER}`,
    // Gate's useConsistencyBootstrap derives the owner's streak record.
    `consistency:${CANONICAL_OWNER}`,
    `consistency:${GUEST_DATA_OWNER}`,
    profileKey,
    guestProfileKey,
  ]);
  const unexpectedKv = kvChanged.filter(
    key => !allowedKvWrites.has(key) && !key.startsWith('notifications'),
  );
  if (unexpectedKv.length > 0) {
    violate(
      'I6.persisted-state',
      `unexpected kv writes: ${unexpectedKv.join(', ')}`,
    );
  }
  // The profile row must never be rewritten to something different from
  // what was there (only a legitimate clear/replace via onboarding could).
  for (const key of [profileKey, guestProfileKey]) {
    const before = kvBefore.get(key);
    const after = kvAfter.get(key);
    if (
      before !== undefined &&
      after !== undefined &&
      before !== after &&
      after !== ''
    ) {
      violate(
        'I6.persisted-state',
        `profile kv ${key} rewritten by the settings flow`,
      );
    }
  }
  if (db.shotFingerprint() !== shotsBefore) {
    violate('I6.persisted-state', 'local shots changed');
  }
  if (db.destructiveStatements().length > 0) {
    violate(
      'I6.persisted-state',
      `destructive SQL: ${db.destructiveStatements().join(' | ')}`,
    );
  }
  const vaultAfter =
    mockKeychain.store.get(SESSION_VAULT_SERVICE)?.password ?? null;
  if (vaultAfter !== null) {
    try {
      const parsed = JSON.parse(vaultAfter) as Record<string, unknown>;
      if (
        typeof parsed['refreshToken'] !== 'string' ||
        'accessToken' in parsed
      ) {
        violate(
          'I6.persisted-state',
          'Keychain record malformed or carries an access token',
        );
      }
    } catch {
      violate('I6.persisted-state', 'Keychain record is not JSON');
    }
  }
  const signedOutDuringRun =
    scenario.actions.includes('sign-out-confirm') ||
    scenario.server.refreshLater === 'http401';
  if (
    scenario.install === 'synced' &&
    !signedOutDuringRun &&
    scenario.keychain === 'ok' &&
    vaultAfter === null &&
    vaultBefore !== null
  ) {
    violate(
      'I6.persisted-state',
      'Keychain session record vanished without a sign-out',
    );
  }

  if (unhandled.length > 0) {
    violate(
      'I1.no-crash',
      `unhandled promise rejection(s): ${unhandled.slice(0, 3).join(' | ')}`,
    );
  }

  (
    nodeProcess as unknown as {
      off(event: string, listener: (reason: unknown) => void): void;
    }
  ).off('unhandledRejection', onUnhandled);
  unmount();
  await flush(50);
  resetProcessState();
  (globalThis as { fetch: unknown }).fetch = server.fetch;

  const invariants: Record<string, boolean> = {};
  for (const name of [
    'I1.no-crash',
    'I2.no-infinite-spinner',
    'I3.visible-control',
    'I4.no-silent-failure',
    'I5.no-fake-success',
    'I6.persisted-state',
    'I7.recovers-after-heal',
  ]) {
    invariants[name] = !violations.has(name);
  }
  const failed = [...violations.keys()];
  return {
    scenario: scenario.name,
    seed: scenario.seed,
    install: scenario.install,
    faults: injectedFaults(scenario),
    actions: scenario.actions,
    observed: {
      launchGate,
      finalTexts: finalTexts.slice(0, 40),
      membershipValue,
      accessStatus: access.status,
      accessError: access.error?.message ?? null,
      consentAvailability: consent.availability,
      consentError: consent.error,
      authSession: auth.session
        ? `${auth.session.provider}:${auth.session.localOnly ? 'local' : 'synced'}`
        : null,
      authError: auth.error?.message ?? null,
      serverCalls: server.calls.map(
        c => `${c.route}:${c.fault}→${c.outcome}@${c.at}`,
      ),
      unexpectedRoutes: server.unexpected,
      serverPendingHangs: server.pendingHangs,
      keychainOps: mockKeychain.log.map(
        entry => `${entry.op}:${entry.outcome}`,
      ),
      keychainPendingHangs: mockKeychain.pendingHangs,
      purchasesCalls: mockPurchases.calls,
      purchasesPendingHangs: mockPurchases.pendingHangs,
      linkingOpened: linkingState.opened,
      storeReviewRequests: storeReviewState.requests,
      kvChanged,
      renderErrors: renderErrors.slice(0, 5),
      boundaryRetryTripped,
      violations: Object.fromEntries(violations),
    },
    invariants,
    failed,
    knownFindings: [
      ...new Set(
        failed
          .map(invariant =>
            knownFindingFor(
              scenario,
              invariant,
              violations.get(invariant) ?? '',
            ),
          )
          .filter((id): id is KnownFindingId => id !== null),
      ),
    ],
    ok: failed.length === 0,
    timeline,
    durationMs: Date.now() - startedWall,
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
const SEEDED_COUNT = Number(nodeProcess.env['STRESS_ITER'] ?? 12);
const SEED_FILTER = nodeProcess.env['STRESS_SEED'];
const SCENARIO_FILTER = nodeProcess.env['STRESS_SCENARIO'];
const STRICT = nodeProcess.env['STRESS_STRICT'] === '1';

function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(
          __dirname,
          '../../../../artifacts/stress/settingsscreen-failure-injection',
        );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(() => {
  jest.useFakeTimers();
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((() => ({
    remove: () => {},
  })) as unknown as typeof AppState.addEventListener);
  jest.spyOn(Linking, 'openURL').mockImplementation((url: string) => {
    linkingState.opened.push(url);
    if (linkingState.fault === 'throws-sync') {
      throw new Error('openURL threw synchronously (simulated)');
    }
    if (linkingState.fault === 'rejects') {
      return Promise.reject(new Error('Unable to open URL (simulated)'));
    }
    if (linkingState.fault === 'hangs') {
      linkingState.pendingHangs += 1;
      return new Promise<void>(() => {});
    }
    return Promise.resolve();
  });
  nativeModules.PickleAuth = { signInWithApple: jest.fn() };
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  delete nativeModules.PickleAuth;
  delete nativeModules.PickleStoreReview;
  jest.useRealTimers();
});

describe('STRESS scr-settingsscreen · failure-injection', () => {
  const rows: Row[] = [];
  const fixed = SEED_FILTER
    ? []
    : FIXED_SCENARIOS.filter(
        s => !SCENARIO_FILTER || s.name === SCENARIO_FILTER,
      );
  const seeded = SEED_FILTER
    ? SEED_FILTER.split(',').map(s => seededScenario(Number(s)))
    : SCENARIO_FILTER
      ? []
      : Array.from({ length: SEEDED_COUNT }, (_, i) =>
          seededScenario(1000 + i),
        );

  const originalConsoleError = console.error;
  afterEach(() => {
    console.error = originalConsoleError;
  });

  const replayKey = (scenario: Scenario) =>
    scenario.seed === null
      ? `STRESS_SCENARIO=${scenario.name}`
      : `STRESS_SEED=${scenario.seed}`;

  for (const scenario of [...fixed, ...seeded]) {
    test(`${scenario.name} [${injectedFaults(scenario).join(' ')}]`, async () => {
      const row = await runScenario(scenario);
      rows.push(row);
      const violations = row.observed['violations'] as Record<string, string>;
      const unexplained = STRICT
        ? row.failed
        : row.failed.filter(
            invariant =>
              knownFindingFor(
                scenario,
                invariant,
                violations[invariant] ?? '',
              ) === null,
          );
      if (unexplained.length > 0) {
        // Fail loudly with the replay key; the JSON row carries the evidence.
        throw new Error(
          `BROKEN ${scenario.name}: ${unexplained.join(', ')} — ${JSON.stringify(
            Object.fromEntries(
              unexplained.map(name => [name, violations[name]]),
            ),
          )} — replay: cd apps/mobile && ${replayKey(scenario)} npx jest --ci __tests__/stress/settingsScreenFailureInjection.stress.test.tsx`,
        );
      }
    }, 120_000);
  }

  // Each known finding is pinned on its minimal scenario: the case is expected
  // to FAIL while the defect exists (test.failing passes), and flips to a real
  // failure once a fix lands — remove the KNOWN_FINDINGS entry at that point.
  const pins: [KnownFindingId, string][] = [
    ['F1.paywall-from-settings-never-asks-store', 'control-no-fault'],
    ['F2.access-request-without-timeout', 'access-hang'],
    ['F3.revenuecat-sdk-hang-without-timeout', 'revenuecat-offerings-hang'],
    [
      'F4.malformed-persisted-profile-crashes-settings',
      'sqlite-profile-focus-number',
    ],
  ];
  for (const [finding, scenarioName] of pins) {
    const scenario = FIXED_SCENARIOS.find(s => s.name === scenarioName);
    if (
      !scenario ||
      (SCENARIO_FILTER && SCENARIO_FILTER !== scenarioName) ||
      SEED_FILTER
    ) {
      continue;
    }
    test.failing(
      `KNOWN ${finding}: ${KNOWN_FINDINGS[finding]} [${scenarioName}]`,
      async () => {
        const row = await runScenario(scenario);
        rows.push({ ...row, scenario: `pin:${row.scenario}` });
        expect(row.knownFindings).not.toContain(finding);
      },
      120_000,
    );
  }

  afterAll(() => {
    const dir = artifactDir();
    const totalFaults = rows.reduce((sum, row) => sum + row.faults.length, 0);
    const byInvariant: Record<string, number> = {};
    const byKnownFinding: Record<string, number> = {};
    for (const row of rows) {
      for (const name of row.failed)
        byInvariant[name] = (byInvariant[name] ?? 0) + 1;
      for (const id of row.knownFindings)
        byKnownFinding[id] = (byKnownFinding[id] ?? 0) + 1;
    }
    const unexplained = rows.filter(row => {
      const violations = row.observed['violations'] as Record<string, string>;
      const scenario = [...fixed, ...seeded].find(
        s => s.name === row.scenario.replace(/^pin:/, ''),
      );
      return (
        scenario !== undefined &&
        row.failed.some(
          invariant =>
            knownFindingFor(
              scenario,
              invariant,
              violations[invariant] ?? '',
            ) === null,
        )
      );
    });
    const summary = {
      suite: 'scr-settingsscreen/failure-injection',
      node: nodeProcess.version,
      scenariosExecuted: rows.length,
      fixedScenarios: rows.filter(r => r.seed === null).length,
      seededScenarios: rows.filter(r => r.seed !== null).length,
      injectedFaults: totalFaults,
      held: rows.filter(r => r.ok).length,
      broken: rows.filter(r => !r.ok).length,
      brokenByInvariant: byInvariant,
      brokenByKnownFinding: byKnownFinding,
      brokenUnexplained: unexplained.map(r =>
        r.seed === null ? r.scenario : String(r.seed),
      ),
      brokenSeeds: rows.filter(r => !r.ok && r.seed !== null).map(r => r.seed),
      brokenFixed: rows
        .filter(r => !r.ok && r.seed === null)
        .map(r => r.scenario),
      seedToOutcome: Object.fromEntries(
        rows.map(r => [
          r.seed === null ? r.scenario : String(r.seed),
          r.ok ? 'HELD' : `BROKEN:${r.failed.join('+')}`,
        ]),
      ),
      notApplicableDependencies: {
        camera: 'not imported by SettingsScreen',
        tts: 'not imported by SettingsScreen',
        visionProvider:
          'scoringStackStatus() is a pure constant (src/vision/providers.ts) — no native/I/O seam to inject',
      },
    };
    const suffix = SEED_FILTER
      ? `-seed-${SEED_FILTER.replace(/,/g, '_')}`
      : SCENARIO_FILTER
        ? `-scenario-${SCENARIO_FILTER}`
        : '';
    fs.writeFileSync(
      path.join(dir, `rows${suffix}.json`),
      JSON.stringify(rows, null, 2) + '\n',
    );
    fs.writeFileSync(
      path.join(dir, `summary${suffix}.json`),
      JSON.stringify(summary, null, 2) + '\n',
    );
  });
});
