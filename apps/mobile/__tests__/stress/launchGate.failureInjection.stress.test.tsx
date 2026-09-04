/**
 * STRESS · failure-injection · unit `mod-launch-gate` (flow/launchGate.ts).
 *
 * launchGate.ts itself is pure (three stage transitions, no I/O). Its
 * dependencies live in the App.tsx Gate that consumes it: auth hydration
 * (Keychain vault + /v1/auth/refresh), SQLite kv (local mode, pending
 * stashes, owner profiles), the OS notification scheduler (permissions),
 * the provider sign-in leaves (native Apple module, Google SDK,
 * /v1/account/bootstrap), the canonical profile API (/v1/me,
 * /v1/me/onboarding), the clock, and the stage-callback "navigation". This
 * harness mounts the REAL App with the REAL authStore / appStore /
 * notificationStore and injects throw / reject / never-resolves / slow /
 * timeout / malformed / partial faults at exactly those seams, one primary
 * fault per scenario (deterministic coverage of FAULT_TABLE) plus seeded
 * secondary faults, launch state and user-action perturbations.
 *
 * Camera / Vision (PickleVideoCapture), TTS (PickleAudioCoach) and
 * RevenueCat (react-native-purchases) are NOT dependencies of the gate: each
 * scenario installs poisoned modules that throw on any call and asserts the
 * launch never consulted them.
 *
 * Invariants checked per scenario (see `checkInvariants`):
 *   - no infinite spinner: after 60s of virtual time no LoadingState /
 *     "Finishing setup…" / busy sign-in remains without a recovery control;
 *   - visible retry/back control whenever the flow is not on a happy screen;
 *   - no silent failure: a failed user-initiated action leaves an error text;
 *   - no fake success: the flow never advances past a step whose durable
 *     write failed, never renders the main app without a profile, never keeps
 *     a session the server refused;
 *   - no corrupted persisted state: every kv / Keychain value the app WROTE
 *     parses under its schema; no session material in SQLite;
 *   - launchGate ordering: the primary CTA always enters the questionnaire,
 *     step one's Back returns to Welcome, no skip affordance, sign-in only via
 *     finishing or the explicit link — under every fault;
 *   - recoverability: once the dependency heals, the flow completes.
 *
 * Scale:   STRESS_ITER=<n>    scenarios (default = FAULT_TABLE.length, ≥ 60;
 *                            the whole default campaign runs in ~5s)
 * Replay:  STRESS_ONLY=<seed> run one scenario
 * Strict:  STRESS_STRICT=1    KNOWN_BROKEN primaries fail the suite instead
 *                            of being pinned with `it.failing`
 * Minimize: STRESS_PRIMARY_ONLY=1  drop the seeded secondary faults so a
 *                            failure is attributed to the primary alone
 * Output:  STRESS_OUT=<dir>   JSON table seed → outcome
 *          (default artifacts/stress/launch-gate-failure-injection)
 */
import React from 'react';
import { NativeModules, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';
import type { PermissionState } from '../../src/notifications/service';
import type { Profile } from '../../src/state/profile';

declare const require: <T = unknown>(id: string) => T;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

const MOCK_CANONICAL_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';

// ─── Fault model ─────────────────────────────────────────────────────────────

type Dep =
  | 'keychain.get'
  | 'keychain.set'
  | 'keychain.reset'
  | 'sqlite.open'
  | 'sqlite.read'
  | 'sqlite.write'
  | 'sqlite.data'
  | 'fetch.refresh'
  | 'fetch.bootstrap'
  | 'fetch.me'
  | 'fetch.onboardingPut'
  | 'scheduler.cancelAll'
  | 'scheduler.permissionState'
  | 'scheduler.requestPermission'
  | 'scheduler.applyPlan'
  | 'apple.native'
  | 'google.sdk'
  | 'clock'
  | 'navigation';

type Mode =
  | 'throw'
  | 'reject'
  | 'never'
  | 'slow'
  | 'timeout'
  | 'malformed'
  | 'partial'
  | 'http401'
  | 'http403'
  | 'http429'
  | 'http500'
  | 'transient'
  | 'skew-past'
  | 'skew-future'
  | 'double-tap'
  | 'back-spam'
  | 'link-then-back';

interface Fault {
  dep: Dep;
  mode: Mode;
  /** `transient`: fail this many calls, then heal by itself. */
  budget?: number;
}

/** Every (dependency × failure mode) pair reachable through the launch gate
 * integration. Scenario k takes entry k % length as its primary fault, so
 * the default run covers the whole table at least once. */
const FAULT_TABLE: readonly Fault[] = [
  { dep: 'keychain.get', mode: 'throw' },
  { dep: 'keychain.get', mode: 'reject' },
  { dep: 'keychain.get', mode: 'never' },
  { dep: 'keychain.get', mode: 'slow' },
  { dep: 'keychain.get', mode: 'malformed' },
  { dep: 'keychain.get', mode: 'partial' },
  { dep: 'keychain.set', mode: 'reject' },
  { dep: 'keychain.set', mode: 'never' },
  { dep: 'keychain.set', mode: 'malformed' },
  { dep: 'keychain.reset', mode: 'reject' },
  { dep: 'keychain.reset', mode: 'never' },
  { dep: 'sqlite.open', mode: 'throw' },
  { dep: 'sqlite.read', mode: 'reject' },
  { dep: 'sqlite.read', mode: 'never' },
  { dep: 'sqlite.read', mode: 'slow' },
  { dep: 'sqlite.read', mode: 'malformed' },
  { dep: 'sqlite.read', mode: 'partial' },
  { dep: 'sqlite.read', mode: 'transient', budget: 2 },
  { dep: 'sqlite.write', mode: 'reject' },
  { dep: 'sqlite.write', mode: 'never' },
  { dep: 'sqlite.write', mode: 'slow' },
  { dep: 'sqlite.write', mode: 'throw' },
  { dep: 'sqlite.write', mode: 'transient', budget: 1 },
  // What SQLite hands back is well-formed at the driver level but the stored
  // owner profile row is torn (malformed) or the wrong shape (partial).
  { dep: 'sqlite.data', mode: 'malformed' },
  { dep: 'sqlite.data', mode: 'partial' },
  { dep: 'fetch.refresh', mode: 'http401' },
  { dep: 'fetch.refresh', mode: 'http403' },
  { dep: 'fetch.refresh', mode: 'http429' },
  { dep: 'fetch.refresh', mode: 'http500' },
  { dep: 'fetch.refresh', mode: 'reject' },
  { dep: 'fetch.refresh', mode: 'throw' },
  { dep: 'fetch.refresh', mode: 'never' },
  { dep: 'fetch.refresh', mode: 'slow' },
  { dep: 'fetch.refresh', mode: 'timeout' },
  { dep: 'fetch.refresh', mode: 'malformed' },
  { dep: 'fetch.refresh', mode: 'partial' },
  { dep: 'fetch.bootstrap', mode: 'http401' },
  { dep: 'fetch.bootstrap', mode: 'http500' },
  { dep: 'fetch.bootstrap', mode: 'http429' },
  { dep: 'fetch.bootstrap', mode: 'reject' },
  { dep: 'fetch.bootstrap', mode: 'never' },
  { dep: 'fetch.bootstrap', mode: 'slow' },
  { dep: 'fetch.bootstrap', mode: 'malformed' },
  { dep: 'fetch.bootstrap', mode: 'partial' },
  { dep: 'fetch.me', mode: 'http500' },
  { dep: 'fetch.me', mode: 'reject' },
  { dep: 'fetch.me', mode: 'never' },
  { dep: 'fetch.me', mode: 'malformed' },
  { dep: 'fetch.me', mode: 'partial' },
  { dep: 'fetch.onboardingPut', mode: 'http500' },
  { dep: 'fetch.onboardingPut', mode: 'reject' },
  { dep: 'fetch.onboardingPut', mode: 'never' },
  { dep: 'fetch.onboardingPut', mode: 'malformed' },
  { dep: 'fetch.onboardingPut', mode: 'partial' },
  { dep: 'scheduler.cancelAll', mode: 'reject' },
  { dep: 'scheduler.cancelAll', mode: 'slow' },
  { dep: 'scheduler.cancelAll', mode: 'never' },
  { dep: 'scheduler.permissionState', mode: 'reject' },
  { dep: 'scheduler.permissionState', mode: 'never' },
  { dep: 'scheduler.permissionState', mode: 'malformed' },
  { dep: 'scheduler.requestPermission', mode: 'reject' },
  { dep: 'scheduler.requestPermission', mode: 'throw' },
  { dep: 'scheduler.requestPermission', mode: 'never' },
  { dep: 'scheduler.requestPermission', mode: 'slow' },
  { dep: 'scheduler.requestPermission', mode: 'malformed' },
  { dep: 'scheduler.applyPlan', mode: 'reject' },
  { dep: 'scheduler.applyPlan', mode: 'never' },
  { dep: 'apple.native', mode: 'reject' },
  { dep: 'apple.native', mode: 'throw' },
  { dep: 'apple.native', mode: 'never' },
  { dep: 'apple.native', mode: 'slow' },
  { dep: 'apple.native', mode: 'malformed' },
  { dep: 'google.sdk', mode: 'throw' },
  { dep: 'google.sdk', mode: 'reject' },
  { dep: 'google.sdk', mode: 'never' },
  { dep: 'google.sdk', mode: 'malformed' },
  { dep: 'clock', mode: 'skew-past' },
  { dep: 'clock', mode: 'skew-future' },
  { dep: 'navigation', mode: 'double-tap' },
  { dep: 'navigation', mode: 'back-spam' },
  { dep: 'navigation', mode: 'link-then-back' },
];

const MOCK_SLOW_MS: Record<string, number> = {
  'keychain.get': 3_000,
  'sqlite.read': 2_500,
  'sqlite.write': 2_500,
  'fetch.refresh': 6_000, // inside the 8s launch wait
  'fetch.bootstrap': 4_000,
  'scheduler.requestPermission': 3_000,
  'apple.native': 3_000,
};
/** `timeout`: the request hangs until the caller's AbortSignal fires. */
const SIXTY_SECONDS = 60_000;

// ─── Fault runtime ───────────────────────────────────────────────────────────

const mockActive = new Map<Dep, Fault>();
const mockHits: Record<string, number> = {};
const MOCK_NEVER = new Promise<never>(() => {});

function mockFaultFor(dep: Dep): Fault | null {
  const fault = mockActive.get(dep);
  if (!fault) return null;
  if (fault.mode === 'transient') {
    if ((fault.budget ?? 0) <= 0) return null;
    fault.budget = (fault.budget ?? 0) - 1;
  }
  return fault;
}
function mockHit(dep: Dep, mode: string) {
  const key = `${dep}:${mode}`;
  mockHits[key] = (mockHits[key] ?? 0) + 1;
}
function mockSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function mockHangUntilAbort(
  signal: AbortSignal | null | undefined,
): Promise<never> {
  if (!signal) return MOCK_NEVER;
  return new Promise<never>((_, reject) => {
    const abort = () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort);
  });
}

/**
 * Wraps a dependency call. `throw` is synchronous (the native bridge
 * throwing before a promise exists); `reject` is a rejected promise; `never`
 * never settles; `slow` settles after MOCK_SLOW_MS; `malformed` / `partial` /
 * `httpNNN` return the caller-supplied shape.
 */
function mockGate<T>(
  dep: Dep,
  ok: () => T | Promise<T>,
  shapes: Partial<Record<Mode, () => T | Promise<T>>> = {},
  signal?: AbortSignal | null,
): T | Promise<T> {
  const fault = mockFaultFor(dep);
  if (!fault) {
    mockHit(dep, 'ok');
    return ok();
  }
  mockHit(dep, fault.mode);
  switch (fault.mode) {
    case 'throw':
    case 'transient':
      throw new Error(`${dep}: injected synchronous failure`);
    case 'reject':
      return Promise.reject(new Error(`${dep}: injected rejection`));
    case 'never':
      // A request the caller can abort hangs until it does (a real socket
      // honours the AbortSignal); one without a signal hangs forever.
      return signal ? mockHangUntilAbort(signal) : MOCK_NEVER;
    case 'timeout':
      return mockHangUntilAbort(signal);
    case 'slow':
      return mockSleep(MOCK_SLOW_MS[dep] ?? 2_000).then(() => ok());
    default: {
      const shape = shapes[fault.mode];
      if (!shape) return ok();
      return shape();
    }
  }
}

// ─── Module seams ────────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => {
  const React = require<typeof import('react')>('react');
  const { View } = require<typeof import('react-native')>('react-native');
  const Passthrough = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    SafeAreaProvider: Passthrough,
    SafeAreaView: Passthrough,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

jest.mock('react-native-svg', () => {
  const React = require<typeof import('react')>('react');
  const { View } = require<typeof import('react-native')>('react-native');
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
    G: Mock,
    Ellipse: Mock,
  };
});

// SQLite kv: the real repository's SELECT/INSERT statements over a Map.
const mockKv = new Map<string, string>();
function mockCurrentDb(): LocalDb {
  const opened = mockGate<LocalDb>('sqlite.open', () => ({
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const key = String(params[0]);
        return mockGate(
          'sqlite.read',
          () => {
            const value = mockKv.get(key);
            return { rows: value === undefined ? [] : [{ value }] };
          },
          {
            // Driver handed back a row without the column / a non-string.
            malformed: () => ({ rows: [{ value: 42 }] }) as never,
            // Truncated result set: the row exists but came back empty.
            partial: () => ({ rows: undefined }) as never,
          },
        );
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        return mockGate('sqlite.write', () => {
          mockKv.set(String(params[0]), String(params[1]));
          return { rows: [] };
        });
      }
      return { rows: [] };
    },
    close() {},
  }));
  if (opened instanceof Promise) {
    // getDb() is synchronous in production; a pending open is a programming
    // error in the harness, not a scenario.
    throw new Error('sqlite.open cannot be asynchronous');
  }
  return opened;
}
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

// Keychain: in-memory store behind the same three calls sessionVault makes.
const mockKeychain = new Map<string, { username: string; password: string }>();
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AfterFirstUnlockThisDeviceOnly',
  },
  getGenericPassword: (options: { service: string }) =>
    mockGate('keychain.get', () => mockKeychain.get(options.service) ?? false, {
      malformed: () => ({ username: 'session', password: '{not json' }),
      partial: () => ({
        username: 'session',
        password: JSON.stringify({
          version: 1,
          provider: 'apple',
          canonicalAppUserId: MOCK_CANONICAL_ID,
          // refreshToken missing: the record is unusable.
        }),
      }),
    }),
  setGenericPassword: (
    username: string,
    password: string,
    options: { service: string },
  ) =>
    mockGate<false | { service: string; storage: string }>(
      'keychain.set',
      () => {
        mockKeychain.set(options.service, { username, password });
        return { service: options.service, storage: 'keychain' };
      },
      {
        // The bridge answered but did not store anything.
        malformed: () => false,
      },
    ),
  resetGenericPassword: (options: { service: string }) =>
    mockGate('keychain.reset', () => {
      mockKeychain.delete(options.service);
      return true;
    }),
}));

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
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

// Google SDK (legacy silent restore path only).
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: () => {
      const fault = mockActive.get('google.sdk');
      if (fault?.mode === 'throw') {
        mockHit('google.sdk', 'throw');
        throw new Error('google.sdk: configure threw');
      }
    },
    hasPreviousSignIn: () => true,
    signInSilently: () =>
      mockGate(
        'google.sdk',
        () => ({
          type: 'success',
          data: {
            idToken: 'google-id-token',
            user: { name: 'Pat Player', email: 'pat@example.com' },
          },
        }),
        {
          // Success envelope with no token: nothing verifiable for the backend.
          malformed: () => ({ type: 'success', data: { user: {} } }) as never,
        },
      ),
    hasPlayServices: async () => true,
    signIn: async () => ({ type: 'cancelled' }),
    signOut: async () => {},
    revokeAccess: async () => {},
  },
}));

// OS notification scheduler (SchedulerPort).
const mockScheduler = {
  permission: 'undetermined' as PermissionState,
  appliedPlans: [] as unknown[],
  permissionState(): Promise<PermissionState> {
    return Promise.resolve(
      mockGate<PermissionState>(
        'scheduler.permissionState',
        () => this.permission,
        {
          malformed: () => 'banana' as never,
        },
      ),
    );
  },
  requestPermission(): Promise<PermissionState> {
    return Promise.resolve(
      mockGate<PermissionState>(
        'scheduler.requestPermission',
        () => {
          this.permission = 'granted';
          return 'granted';
        },
        { malformed: () => undefined as never },
      ),
    );
  },
  applyPlan(plan: unknown): Promise<void> {
    return Promise.resolve(
      mockGate<void>('scheduler.applyPlan', () => {
        this.appliedPlans.push(plan);
      }),
    );
  },
  cancelAllPlanned(): Promise<void> {
    return Promise.resolve(mockGate<void>('scheduler.cancelAll', () => {}));
  },
  async openSystemSettings(): Promise<void> {},
};
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

// Leaves outside the gate's scope.
jest.mock('../../src/navigation/RootNavigator', () => {
  const React = require<typeof import('react')>('react');
  const { Text } = require<typeof import('react-native')>('react-native');
  return {
    RootNavigator: () => React.createElement(Text, null, 'ROOT_NAVIGATOR'),
  };
});
// Sign-in leaf: real authStore transitions behind the same controls the
// product screen offers; store errors are rendered so the "silent failure"
// invariant can read them from the tree.
jest.mock('../../src/screens/SignInScreen', () => {
  const React = require<typeof import('react')>('react');
  const { Pressable, Text, View } = require<
    typeof import('react-native')
  >('react-native');
  const { useAuthStore } = jest.requireActual<
    typeof import('../../src/auth/authStore')
  >('../../src/auth/authStore');
  return {
    SignInScreen: (props: { onBack?: () => void }) => {
      const busy = useAuthStore(s => s.busy);
      const error = useAuthStore(s => s.error);
      return React.createElement(
        View,
        null,
        React.createElement(Text, null, 'SIGN_IN_SCREEN'),
        busy ? React.createElement(Text, null, 'Signing in…') : null,
        error
          ? React.createElement(Text, null, `AUTH_ERROR:${error.message}`)
          : null,
        React.createElement(
          Pressable,
          { accessibilityLabel: 'Back', onPress: props.onBack },
          React.createElement(Text, null, 'Back'),
        ),
        React.createElement(
          Pressable,
          {
            accessibilityLabel: 'Sign in with Apple',
            disabled: busy,
            onPress: () => void useAuthStore.getState().signInWithApple(),
          },
          React.createElement(Text, null, 'Sign in with Apple'),
        ),
      );
    },
  };
});
jest.mock('../../src/screens/SplashScreen', () => {
  const React = require<typeof import('react')>('react');
  const { Text } = require<typeof import('react-native')>('react-native');
  return {
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) => {
      React.useEffect(() => {
        if (props.ready) props.onFinished();
      }, [props.ready, props.onFinished]);
      return React.createElement(Text, null, 'SPLASH');
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
jest.mock('../../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: async () => {} };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

// Poisoned non-dependencies: any call is a failure of the "launch never
// consults camera / Vision / TTS / RevenueCat" invariant.
const mockPoisonCalls: string[] = [];
function mockPoison(name: string): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return (...args: unknown[]) => {
          mockPoisonCalls.push(`${name}.${String(prop)}(${args.length})`);
          throw new Error(`${name}.${String(prop)} consulted during launch`);
        };
      },
    },
  );
}
jest.mock('react-native-purchases', () => {
  mockPoisonCalls.push('react-native-purchases:loaded');
  return { __esModule: true, default: mockPoison('Purchases') };
});
const nativeModules = NativeModules as Record<string, unknown>;
nativeModules['PickleVideoCapture'] = mockPoison('PickleVideoCapture');
nativeModules['PickleAudioCoach'] = mockPoison('PickleAudioCoach');
nativeModules['PickleAuth'] = {
  signInWithApple: () =>
    mockGate(
      'apple.native',
      () => ({
        user: 'apple-subject',
        identityToken: 'apple-identity-token',
        authorizationCode: 'apple-auth-code',
        email: 'pat@example.com',
        givenName: 'Pat',
        familyName: 'Player',
      }),
      {
        // Credential sheet returned, but without a token to exchange.
        malformed: () => ({ user: 'apple-subject' }),
      },
    ),
};

// App and stores are loaded AFTER the native poison is installed (capture.ts
// / tts.ts read NativeModules at module scope).
const App = jest.requireActual<typeof import('../../App')>('../../App').default;
const { useAuthStore } = jest.requireActual<
  typeof import('../../src/auth/authStore')
>('../../src/auth/authStore');
const {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  profileKeyForOwner,
  setActiveDataOwner,
} = jest.requireActual<typeof import('../../src/data/accountScope')>(
  '../../src/data/accountScope',
);
const { PENDING_ONBOARDING_PROFILE_KV_KEY, useAppStore } = jest.requireActual<
  typeof import('../../src/state/appStore')
>('../../src/state/appStore');
const { PENDING_NOTIFICATION_ONBOARDING_KV_KEY, useNotificationStore } =
  jest.requireActual<
    typeof import('../../src/notifications/notificationStore')
  >('../../src/notifications/notificationStore');
const { DEFAULT_NOTIFICATION_PREFS } = jest.requireActual<
  typeof import('../../src/notifications/types')
>('../../src/notifications/types');
const { SESSION_VAULT_SERVICE } = jest.requireActual<
  typeof import('../../src/account/sessionVault')
>('../../src/account/sessionVault');
const { stopSessionKeeper } = jest.requireActual<
  typeof import('../../src/account/sessionKeeper')
>('../../src/account/sessionKeeper');
const { clearApiSession, getApiSession } = jest.requireActual<
  typeof import('../../src/account/apiSession')
>('../../src/account/apiSession');
const { clearSyncRuntime } = jest.requireActual<
  typeof import('../../src/data/syncRuntime')
>('../../src/data/syncRuntime');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CANONICAL_OWNER = canonicalDataOwner(MOCK_CANONICAL_ID);
const LOCAL_GUEST_VALUE = JSON.stringify({ version: 1, mode: 'guest' });
const LAST_PROVIDER_GOOGLE_VALUE = JSON.stringify({
  version: 1,
  provider: 'google',
});
const REAL_NOW_MS = Date.now();
// Device-clock skew. Kept under Node's 2^31-1 ms timer ceiling: the fake
// timers (like Node) collapse a longer setTimeout to ~1 ms, which would
// manufacture a refresh storm that React Native's timers do not have.
const SKEW_MS = 20 * 24 * 3600 * 1000;

const walkedProfile: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};
const storedProfile: Profile = {
  skillLevel: '3.0',
  handedness: 'left',
  goal: 'all-around',
  biggestProblem: 'not sure',
  focusCheckpoint: 'contact_position',
};

// Server clock is REAL time; the device clock may be skewed per scenario.
let tokenSerial = 0;
function serverExpiresAtSeconds(): number {
  return Math.floor(REAL_NOW_MS / 1000) + 3600;
}
function sessionBody() {
  tokenSerial += 1;
  return {
    accessToken: `access-${tokenSerial}`,
    refreshToken: `refresh-${tokenSerial}`,
    expiresAt: serverExpiresAtSeconds(),
  };
}
function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}
function brokenJsonResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;
}
const httpShapes = (okBody: () => unknown, partialBody: () => unknown) => ({
  http401: () => response({ error: { message: 'refused' } }, 401),
  http403: () => response({ error: { message: 'forbidden' } }, 403),
  http429: () => response({ error: { message: 'slow down' } }, 429),
  http500: () => response({ error: { message: 'boom' } }, 500),
  malformed: () => brokenJsonResponse(),
  partial: () => response(partialBody()),
  ok: () => response(okBody()),
});

const fetchLog: string[] = [];
function installFetch() {
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    fetchLog.push(`${init?.method ?? 'GET'} ${url}`);
    const signal = init?.signal;
    if (url.endsWith('/v1/auth/refresh')) {
      const shapes = httpShapes(
        () => ({ session: sessionBody() }),
        // Half a session: no refresh token, expiresAt as a string.
        () => ({
          session: { accessToken: 'access-partial', expiresAt: 'soon' },
        }),
      );
      return Promise.resolve(
        mockGate('fetch.refresh', shapes.ok, shapes, signal),
      );
    }
    if (url.endsWith('/v1/account/bootstrap')) {
      const shapes = httpShapes(
        () => ({
          user: { id: MOCK_CANONICAL_ID, email: 'pat@example.com' },
          onboardingState: 'pending',
          session: sessionBody(),
        }),
        // Account without a session (pre-contract server) and a bad uuid.
        () => ({
          user: { id: 'not-a-uuid', email: null },
          onboardingState: 'pending',
        }),
      );
      return Promise.resolve(
        mockGate('fetch.bootstrap', shapes.ok, shapes, signal),
      );
    }
    if (url.endsWith('/v1/me/onboarding')) {
      const shapes = httpShapes(
        () => ({ recommendedCheckpoint: 'paddle_set' }),
        () => ({ recommendedCheckpoint: 'not_a_checkpoint' }),
      );
      return Promise.resolve(
        mockGate('fetch.onboardingPut', shapes.ok, shapes, signal),
      );
    }
    if (url.endsWith('/v1/me')) {
      const shapes = httpShapes(
        () => ({ onboardingState: 'pending', profile: null }),
        () => ({
          onboardingState: 'complete',
          profile: { skill_level: '3.0', primary_goal: 'drops' }, // handedness missing
        }),
      );
      return Promise.resolve(mockGate('fetch.me', shapes.ok, shapes, signal));
    }
    if (url.endsWith('/v1/auth/logout')) return Promise.resolve(response({}));
    return Promise.reject(new Error(`unexpected route ${url}`));
  }) as unknown as typeof fetch;
}

// ─── Scenario generation ─────────────────────────────────────────────────────

type LaunchProfile =
  | 'fresh'
  | 'guest-local'
  | 'persisted-apple'
  | 'persisted-google'
  | 'legacy-google-flag'
  | 'stale-stash';
type SeededProfile = 'absent' | 'valid' | 'corrupt-json' | 'not-a-profile';
type FinishChoice = 'not_now' | 'enable';

interface Scenario {
  seed: number;
  primary: Fault;
  secondary: Fault[];
  launch: LaunchProfile;
  seededProfile: SeededProfile;
  seededStash: 'none' | 'valid' | 'corrupt';
  finishChoice: FinishChoice;
}

const LAUNCH_PROFILES: readonly LaunchProfile[] = [
  'fresh',
  'guest-local',
  'persisted-apple',
  'persisted-google',
  'legacy-google-flag',
  'stale-stash',
];

/** Which launch states make a primary fault reachable at all. */
function launchProfilesFor(fault: Fault): readonly LaunchProfile[] {
  switch (fault.dep) {
    case 'fetch.refresh':
    case 'keychain.reset':
      return ['persisted-apple', 'persisted-google'];
    case 'keychain.get':
      return fault.mode === 'malformed' || fault.mode === 'partial'
        ? ['persisted-apple']
        : ['persisted-apple', 'fresh', 'guest-local'];
    case 'google.sdk':
      return ['legacy-google-flag'];
    case 'keychain.set':
      return ['fresh', 'legacy-google-flag', 'persisted-apple'];
    case 'sqlite.data':
      return ['persisted-apple', 'persisted-google', 'guest-local'];
    case 'sqlite.write':
      return ['fresh', 'guest-local', 'stale-stash', 'legacy-google-flag'];
    case 'navigation':
    case 'scheduler.requestPermission':
      return ['fresh', 'guest-local', 'stale-stash'];
    case 'apple.native':
    case 'fetch.bootstrap':
    case 'fetch.me':
    case 'fetch.onboardingPut':
      return ['fresh', 'stale-stash'];
    case 'scheduler.applyPlan':
    case 'scheduler.permissionState':
      return ['fresh', 'guest-local', 'persisted-apple', 'stale-stash'];
    default:
      return LAUNCH_PROFILES;
  }
}

function generate(seed: number, index: number): Scenario {
  const random = rng(seed);
  const template = FAULT_TABLE[index % FAULT_TABLE.length];
  if (!template) throw new Error('empty fault table');
  const primary: Fault = { ...template };
  const secondary: Fault[] = [];
  // The vault is only reset when the server refuses the refresh token (or
  // the record is unreadable): pair a reset fault with that trigger.
  if (primary.dep === 'keychain.reset') {
    secondary.push({ dep: 'fetch.refresh', mode: 'http401' });
  }
  const extraCount = random() < 0.4 ? 1 : random() < 0.15 ? 2 : 0;
  for (let i = 0; i < extraCount; i += 1) {
    // Drawn even when dropped so the rest of the seed's stream is unchanged.
    const candidate = { ...pick(random, FAULT_TABLE) };
    const clashes = [primary, ...secondary].some(
      f => f.dep === candidate.dep || f.dep === 'navigation',
    );
    // Secondary faults degrade; they must not block the path to the primary
    // fault, or the scenario stops being attributable to it.
    const degrading = SECONDARY_MODES.includes(candidate.mode);
    const prerequisite = SECONDARY_EXCLUDED_DEPS.includes(candidate.dep);
    if (
      !PRIMARY_ONLY &&
      !clashes &&
      degrading &&
      !prerequisite &&
      candidate.dep !== 'navigation'
    ) {
      secondary.push(candidate);
    }
  }
  const launch = pick(random, launchProfilesFor(primary));
  const data = [primary, ...secondary].find(f => f.dep === 'sqlite.data');
  // Faults that only fire while a profile is being written need a launch
  // that still has to run the questionnaire.
  const needsQuestionnaire =
    primary.dep === 'scheduler.requestPermission' ||
    primary.dep === 'scheduler.applyPlan' ||
    primary.dep === 'sqlite.write';
  const seededProfile: SeededProfile = data
    ? data.mode === 'malformed'
      ? 'corrupt-json'
      : 'not-a-profile'
    : needsQuestionnaire
      ? 'absent'
      : pick<SeededProfile>(random, ['absent', 'absent', 'valid']);
  const seededStash =
    launch === 'stale-stash'
      ? pick<'valid' | 'corrupt'>(random, ['valid', 'corrupt'])
      : 'none';
  const finishChoice: FinishChoice =
    primary.dep === 'scheduler.requestPermission' ||
    primary.dep === 'scheduler.applyPlan'
      ? 'enable'
      : pick<FinishChoice>(random, ['not_now', 'enable']);
  return {
    seed,
    primary,
    secondary,
    launch,
    seededProfile,
    seededStash,
    finishChoice,
  };
}

const PRIMARY_ONLY = process.env.STRESS_PRIMARY_ONLY === '1';
const SECONDARY_MODES: readonly Mode[] = [
  'slow',
  'malformed',
  'partial',
  'http429',
  'http500',
  'transient',
  'skew-past',
  'skew-future',
];
const SECONDARY_EXCLUDED_DEPS: readonly Dep[] = [
  'keychain.get',
  'sqlite.open',
  'sqlite.read',
  'sqlite.data',
  'apple.native',
  'google.sdk',
  'fetch.bootstrap',
];

function seedState(scenario: Scenario) {
  mockKv.clear();
  mockKeychain.clear();
  const owner =
    scenario.launch === 'guest-local'
      ? GUEST_DATA_OWNER
      : scenario.launch.startsWith('persisted')
        ? CANONICAL_OWNER
        : null;
  if (scenario.launch === 'guest-local') {
    mockKv.set('auth.local-mode', LOCAL_GUEST_VALUE);
  }
  if (scenario.launch.startsWith('persisted')) {
    mockKeychain.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify({
        version: 1,
        provider: scenario.launch === 'persisted-apple' ? 'apple' : 'google',
        canonicalAppUserId: MOCK_CANONICAL_ID,
        refreshToken: 'refresh-persisted',
        email: 'pat@example.com',
        displayName: 'Pat Player',
      }),
    });
  }
  if (scenario.launch === 'legacy-google-flag') {
    mockKv.set('auth.last-provider', LAST_PROVIDER_GOOGLE_VALUE);
  }
  if (scenario.launch === 'stale-stash') {
    mockKv.set('auth.session', 'legacy-provider-subject');
    mockKv.set('profile', JSON.stringify(storedProfile));
    mockKv.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      scenario.seededStash === 'valid'
        ? JSON.stringify({ version: 1, profile: walkedProfile })
        : '{"version":1,"profile":{"skillLevel":3',
    );
    mockKv.set(
      PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
      scenario.seededStash === 'valid'
        ? JSON.stringify({ version: 1, enabled: true })
        : '{"version":"one","enabled":"yes"}',
    );
  }
  if (owner) {
    const key = profileKeyForOwner(owner);
    if (scenario.seededProfile === 'valid') {
      mockKv.set(key, JSON.stringify(storedProfile));
    } else if (scenario.seededProfile === 'corrupt-json') {
      mockHit('sqlite.data', 'malformed');
      mockKv.set(key, '{"skillLevel":"3.0","handedness":');
    } else if (scenario.seededProfile === 'not-a-profile') {
      mockHit('sqlite.data', 'partial');
      mockKv.set(key, JSON.stringify({ hello: 'world' }));
    }
  }
}

function applyClock(scenario: Scenario) {
  const clock = [scenario.primary, ...scenario.secondary].find(
    f => f.dep === 'clock',
  );
  const skew =
    clock?.mode === 'skew-past'
      ? -SKEW_MS
      : clock?.mode === 'skew-future'
        ? SKEW_MS
        : 0;
  jest.setSystemTime(REAL_NOW_MS + skew);
}

// ─── Renderer helpers ────────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string | number => typeof c !== 'object')
    .join('');
}
function isAncestor(
  ancestor: TestRenderer.ReactTestInstance,
  node: TestRenderer.ReactTestInstance,
): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}
function pressables(renderer: Renderer, label: string) {
  const matches = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
  return matches.filter(
    node => !matches.some(other => other !== node && isAncestor(node, other)),
  );
}
function enabledPressables(renderer: Renderer, label: string) {
  return pressables(renderer, label).filter(node => !node.props.disabled);
}
function loadingLabel(renderer: Renderer): string | null {
  const node = renderer.root.findAll(
    n =>
      typeof n.props?.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.endsWith('Keep Pickle Sensei open.'),
  )[0];
  return node ? String(node.props.accessibilityLabel) : null;
}

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
    });
  }
}
async function advance(ms: number) {
  // Timers may schedule promises that schedule timers: step in 1s slices.
  let remaining = ms;
  while (remaining > 0) {
    const slice = Math.min(1_000, remaining);
    await act(async () => {
      jest.advanceTimersByTime(slice);
    });
    await settle(1);
    remaining -= slice;
  }
  await settle(2);
}
async function pressAsync(renderer: Renderer, label: string) {
  const nodes = enabledPressables(renderer, label);
  if (nodes.length !== 1) {
    throw new Error(
      `expected one enabled "${label}", found ${nodes.length}; screen: ${allText(renderer).slice(0, 200)}`,
    );
  }
  await act(async () => {
    nodes[0]!.props.onPress();
  });
  await settle();
}
/** Fire the same control twice inside one tick (double-tap). */
async function doublePress(renderer: Renderer, label: string) {
  const nodes = enabledPressables(renderer, label);
  if (nodes.length !== 1) throw new Error(`expected one enabled "${label}"`);
  await act(async () => {
    nodes[0]!.props.onPress();
    nodes[0]!.props.onPress();
  });
  await settle();
}

type Screen =
  | 'loading'
  | 'welcome'
  | 'questionnaire'
  | 'notifications'
  | 'signin'
  | 'signin-busy'
  | 'error-state'
  | 'account-onboarding'
  | 'root'
  | 'finishing'
  | 'unknown';

function screenOf(renderer: Renderer): Screen {
  const text = allText(renderer);
  if (loadingLabel(renderer)) return 'loading';
  if (text.includes('ROOT_NAVIGATOR')) return 'root';
  if (text.includes('SIGN_IN_SCREEN'))
    return text.includes('Signing in…') ? 'signin-busy' : 'signin';
  if (text.includes('Finishing setup…')) return 'finishing';
  if (text.includes('Stay match-ready.')) return 'notifications';
  if (text.includes('See the stroke.')) return 'welcome';
  if (text.includes('PLAYER SETUP') || text.includes('YOUR STARTING PLAN')) {
    return pressables(renderer, 'Leave setup').length > 0
      ? 'account-onboarding'
      : 'questionnaire';
  }
  if (text.includes('Try again')) return 'error-state';
  return 'unknown';
}

const RECOVERY_CONTROLS = [
  'Try again',
  'Back',
  'Not now',
  'Turn on reminders',
  'Sign in with Apple',
  'Start your first read',
  'I already have an account',
  'Continue',
  'Leave setup',
];
function recoveryControls(renderer: Renderer): string[] {
  return RECOVERY_CONTROLS.filter(
    label => enabledPressables(renderer, label).length > 0,
  );
}

// ─── Persisted-state audit ───────────────────────────────────────────────────

function isProfileShape(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return [
    'skillLevel',
    'handedness',
    'goal',
    'biggestProblem',
    'focusCheckpoint',
  ].every(key => typeof record[key] === 'string');
}
function parseJson(raw: string): unknown | typeof INVALID {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return INVALID;
  }
}
const INVALID = Symbol('invalid');

/** Returns integrity issues for every value the APP wrote (seeded values the
 * app never touched are excluded — they are inputs, not corruption). */
function auditPersistedState(seeded: Map<string, string>): string[] {
  const issues: string[] = [];
  for (const [key, value] of mockKv) {
    if (seeded.get(key) === value) continue;
    if (key === 'auth.session') {
      if (value !== '') issues.push(`kv ${key}: session material retained`);
    } else if (key === 'auth.local-mode') {
      if (value !== '' && value !== LOCAL_GUEST_VALUE)
        issues.push(`kv ${key}: unknown value ${value}`);
    } else if (key === 'auth.last-provider') {
      if (value !== '' && value !== LAST_PROVIDER_GOOGLE_VALUE)
        issues.push(`kv ${key}: unknown value ${value}`);
    } else if (key === 'profile' || key.startsWith('profile:')) {
      if (value !== '' && !isProfileShape(parseJson(value)))
        issues.push(`kv ${key}: not a Profile: ${value.slice(0, 60)}`);
    } else if (key === PENDING_ONBOARDING_PROFILE_KV_KEY) {
      const parsed = parseJson(value) as
        Record<string, unknown> | typeof INVALID;
      if (
        value !== '' &&
        (parsed === INVALID ||
          typeof parsed !== 'object' ||
          parsed['version'] !== 1 ||
          !isProfileShape(parsed['profile']))
      )
        issues.push(`kv ${key}: invalid stash ${value.slice(0, 60)}`);
    } else if (key === PENDING_NOTIFICATION_ONBOARDING_KV_KEY) {
      const parsed = parseJson(value) as
        Record<string, unknown> | typeof INVALID;
      if (
        value !== '' &&
        (parsed === INVALID ||
          typeof parsed !== 'object' ||
          parsed['version'] !== 1 ||
          typeof parsed['enabled'] !== 'boolean')
      )
        issues.push(`kv ${key}: invalid pending choice ${value}`);
    } else if (key.startsWith('notifications')) {
      const parsed = parseJson(value) as
        Record<string, unknown> | typeof INVALID;
      if (
        parsed === INVALID ||
        typeof parsed !== 'object' ||
        parsed['version'] !== 1 ||
        typeof parsed['enabled'] !== 'boolean'
      )
        issues.push(`kv ${key}: invalid prefs ${value.slice(0, 60)}`);
    } else if (parseJson(value) === INVALID && value !== '') {
      issues.push(`kv ${key}: unparseable ${value.slice(0, 60)}`);
    }
    if (/identityToken|accessToken|"access-\d/.test(value))
      issues.push(`kv ${key}: token material in SQLite`);
  }
  const vault = mockKeychain.get(SESSION_VAULT_SERVICE);
  if (vault) {
    const parsed = parseJson(vault.password) as
      Record<string, unknown> | typeof INVALID;
    if (
      parsed === INVALID ||
      typeof parsed !== 'object' ||
      parsed['version'] !== 1 ||
      (parsed['provider'] !== 'apple' && parsed['provider'] !== 'google') ||
      typeof parsed['canonicalAppUserId'] !== 'string' ||
      typeof parsed['refreshToken'] !== 'string' ||
      !parsed['refreshToken']
    ) {
      issues.push(`keychain: invalid record ${vault.password.slice(0, 80)}`);
    } else if ('accessToken' in parsed || 'identityToken' in parsed) {
      issues.push('keychain: access/identity token persisted');
    }
  }
  return issues;
}

// ─── Scenario execution ──────────────────────────────────────────────────────

interface Checkpoint {
  at: string;
  screen: Screen;
  controls: string[];
  failures: string[];
}
interface Outcome {
  seed: number;
  index: number;
  scenario: Omit<Scenario, 'seed'>;
  replay: string;
  faultsHit: Record<string, number>;
  checkpoints: Checkpoint[];
  finalScreen: Screen;
  recovered: boolean | null;
  failures: string[];
  degradedByDesign: string[];
  unhandledRejections: number;
  consoleErrors: string[];
  refreshRequests: number;
  poisonCalls: string[];
  exercised: boolean;
  knownBroken: boolean;
  classification: 'HELD' | 'BROKEN';
  ok: boolean;
}

const unhandled: unknown[] = [];
const consoleErrors: string[] = [];
let mounted: Renderer | null = null;

function hasFault(dep: Dep, ...modes: Mode[]): boolean {
  const fault = mockActive.get(dep);
  return Boolean(fault) && (modes.length === 0 || modes.includes(fault!.mode));
}
async function answerQuestionnaire(renderer: Renderer) {
  await act(async () => {
    renderer.root.findByType(TextInput).props.onChangeText(' Dana ');
  });
  await settle();
  const steps: string[][] = [
    ['Continue'],
    ['Female', 'Continue'],
    ['3.5', 'Continue'],
    ['Right-handed', 'Continue'],
    ['Third-shot drops', 'Continue'],
    ['Control', 'Continue'],
    ['Continue'],
  ];
  for (const labels of steps) {
    for (const label of labels) await pressAsync(renderer, label);
  }
}

function checkInvariants(
  renderer: Renderer,
  at: string,
  seeded: Map<string, string>,
  phase: 'faulted' | 'healed',
  degraded: string[],
): Checkpoint {
  const failures: string[] = [];
  const screen = screenOf(renderer);
  const controls = recoveryControls(renderer);
  const text = allText(renderer);

  // No infinite spinner: every checkpoint is taken after ≥ 60s virtual time.
  // A spinner that still offers a control is driven further (the driver
  // presses it) and judged by whether the flow can then complete.
  if (
    screen === 'loading' ||
    screen === 'finishing' ||
    screen === 'signin-busy'
  ) {
    if (controls.length === 0) {
      failures.push(
        `infinite-spinner: still "${screen}" after 60s (${loadingLabel(renderer) ?? text.slice(0, 80)})`,
      );
    } else {
      degraded.push(
        `busy-with-control: "${screen}" still busy after 60s; ${controls.join('/')} visible`,
      );
    }
  }
  // Visible recovery control on every non-terminal screen.
  if (screen !== 'root' && controls.length === 0) {
    failures.push(`no-recovery-control on "${screen}"`);
  }
  if (screen === 'unknown')
    failures.push(`unknown-screen: ${text.slice(0, 120)}`);

  // launchGate ordering: whenever Welcome shows, both entries exist and no
  // sign-in / setup content leaks in; no skip affordance anywhere pre-auth.
  if (screen === 'welcome') {
    if (enabledPressables(renderer, 'Start your first read').length !== 1)
      failures.push('welcome: primary CTA missing');
    if (enabledPressables(renderer, 'I already have an account').length !== 1)
      failures.push('welcome: explicit sign-in link missing');
    if (text.includes('SIGN_IN_SCREEN') || text.includes('PLAYER SETUP'))
      failures.push('welcome: sign-in or setup rendered under Welcome');
  }
  if (screen === 'questionnaire' || screen === 'notifications') {
    if (/skip/i.test(text)) failures.push('pre-auth questionnaire offers skip');
    if (pressables(renderer, 'Leave setup').length > 0)
      failures.push('pre-auth questionnaire offers "Leave setup"');
    if (text.includes('SIGN_IN_SCREEN'))
      failures.push('sign-in rendered under questionnaire');
  }

  // No fake success.
  const auth = useAuthStore.getState();
  const app = useAppStore.getState();
  if (screen === 'root') {
    if (!auth.session)
      failures.push('fake-success: main app without a session');
    if (!app.profile) failures.push('fake-success: main app without a profile');
    if (app.profile && !isProfileShape(app.profile))
      failures.push(
        `fake-success: main app with a non-Profile profile ${JSON.stringify(app.profile)}`,
      );
    if (app.ownerKey !== getActiveDataOwner())
      failures.push('fake-success: main app for a different owner than active');
  }
  if (at.startsWith('faulted:0:')) {
    // A refused refresh token is the ONE implicit sign-out — a 401/403 that
    // was actually served at launch must not leave the restored session (or
    // its vault record) behind. Checked at the launch checkpoint only: a
    // later explicit sign-in legitimately creates a new session + record.
    const refused = ['fetch.refresh:http401', 'fetch.refresh:http403'].some(
      key => (mockHits[key] ?? 0) > 0,
    );
    if (refused && auth.session)
      failures.push(
        'fake-success: session kept after the server refused the refresh token',
      );
    if (
      refused &&
      mockKeychain.has(SESSION_VAULT_SERVICE) &&
      !hasFault('keychain.reset')
    )
      failures.push(
        'corrupt-state: refused refresh token still in the Keychain vault',
      );
  }
  if (screen === 'signin' && auth.session)
    failures.push('sign-in rendered while a session exists');

  // No corrupted persisted state.
  for (const issue of auditPersistedState(seeded))
    failures.push(`corrupt-state: ${issue}`);
  if (unhandled.length > 0)
    failures.push(`unhandled-rejection ×${unhandled.length}`);
  if (mockPoisonCalls.length > 0)
    failures.push(`non-dependency consulted: ${mockPoisonCalls.join(',')}`);
  const crash = consoleErrors.find(m => m.includes('The above error occurred'));
  if (crash) failures.push('render-crash caught by RootErrorBoundary');
  return { at, screen, controls, failures };
}

async function launch(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
  });
  await settle();
  mounted = renderer;
  return renderer;
}
function unmount() {
  const renderer = mounted;
  mounted = null;
  if (renderer) act(() => renderer.unmount());
}

async function resetRuntime() {
  unmount();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    localDataError: null,
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
  mockScheduler.permission = 'undetermined';
  mockScheduler.appliedPlans = [];
  mockActive.clear();
  for (const key of Object.keys(mockHits)) delete mockHits[key];
  fetchLog.length = 0;
  mockPoisonCalls.length = 0;
  unhandled.length = 0;
  consoleErrors.length = 0;
  jest.setSystemTime(REAL_NOW_MS);
}

/**
 * Drives the gate as a user would, stopping at the first checkpoint whose
 * invariants fail or when the flow reaches the main app. Every step waits 60s
 * of virtual time before judging, so a hang has every chance to resolve.
 */
async function drive(
  renderer: Renderer,
  scenario: Scenario,
  seeded: Map<string, string>,
  degraded: string[],
  checkpoints: Checkpoint[],
  phase: 'faulted' | 'healed',
): Promise<Screen> {
  const nav = [scenario.primary, ...scenario.secondary].find(
    f => f.dep === 'navigation',
  );
  let screen = screenOf(renderer);
  let triedRetry = 0;
  for (let step = 0; step < 14; step += 1) {
    const checkpoint = checkInvariants(
      renderer,
      `${phase}:${step}:${screen}`,
      seeded,
      phase,
      degraded,
    );
    checkpoints.push(checkpoint);
    if (checkpoint.failures.length > 0 || screen === 'root') return screen;

    if (
      (screen === 'finishing' || screen === 'signin-busy') &&
      checkpoint.controls.includes('Back')
    ) {
      // The only way out of a stuck busy state is the Back control: take it,
      // then try to finish again from where it lands.
      await pressAsync(renderer, 'Back');
      await settle();
      screen = screenOf(renderer);
      if (
        screen === 'questionnaire' &&
        pressables(renderer, 'Continue').length > 0
      ) {
        await pressAsync(renderer, 'Continue');
        await settle();
        screen = screenOf(renderer);
      }
      continue;
    }

    if (screen === 'welcome') {
      if (nav?.mode === 'link-then-back' && step === 0 && phase === 'faulted') {
        await pressAsync(renderer, 'I already have an account');
        await advance(SIXTY_SECONDS);
        if (
          screenOf(renderer) !== 'signin' &&
          screenOf(renderer) !== 'signin-busy'
        ) {
          checkpoints.push({
            at: `${phase}:${step}:link`,
            screen: screenOf(renderer),
            controls: recoveryControls(renderer),
            failures: ['explicit sign-in link did not reach sign-in'],
          });
          return screenOf(renderer);
        }
        await pressAsync(renderer, 'Back');
        await settle();
        if (screenOf(renderer) !== 'welcome') {
          checkpoints.push({
            at: `${phase}:${step}:link-back`,
            screen: screenOf(renderer),
            controls: recoveryControls(renderer),
            failures: ['sign-in Back did not return to Welcome'],
          });
          return screenOf(renderer);
        }
      }
      if (nav?.mode === 'double-tap' && phase === 'faulted') {
        await doublePress(renderer, 'Start your first read');
      } else {
        await pressAsync(renderer, 'Start your first read');
      }
      await settle();
      // The primary CTA ALWAYS enters the questionnaire — never sign-in.
      const after = screenOf(renderer);
      if (after !== 'questionnaire') {
        checkpoints.push({
          at: `${phase}:${step}:cta`,
          screen: after,
          controls: recoveryControls(renderer),
          failures: [
            `primary CTA landed on "${after}" instead of the questionnaire`,
          ],
        });
        return after;
      }
      const back = pressables(renderer, 'Back');
      if (
        back.length !== 1 ||
        back[0]!.props.accessibilityHint !== 'Return to the welcome screen'
      ) {
        checkpoints.push({
          at: `${phase}:${step}:step-one`,
          screen: after,
          controls: recoveryControls(renderer),
          failures: ['step one lacks the Back-to-Welcome control'],
        });
        return after;
      }
      if (nav?.mode === 'back-spam' && phase === 'faulted') {
        // Back → Welcome → Start → Back → Welcome → Start: the stage machine
        // must survive rapid reversals and never skip forward.
        for (let i = 0; i < 3; i += 1) {
          await pressAsync(renderer, 'Back');
          if (screenOf(renderer) !== 'welcome') {
            checkpoints.push({
              at: `${phase}:${step}:back-spam`,
              screen: screenOf(renderer),
              controls: recoveryControls(renderer),
              failures: ['step-one Back did not return to Welcome'],
            });
            return screenOf(renderer);
          }
          await pressAsync(renderer, 'Start your first read');
          if (screenOf(renderer) !== 'questionnaire') {
            checkpoints.push({
              at: `${phase}:${step}:back-spam`,
              screen: screenOf(renderer),
              controls: recoveryControls(renderer),
              failures: [
                'primary CTA after Back did not re-enter the questionnaire',
              ],
            });
            return screenOf(renderer);
          }
        }
      }
      await answerQuestionnaire(renderer);
      screen = screenOf(renderer);
      continue;
    }

    if (screen === 'questionnaire') {
      // Mid-questionnaire only happens after a failed/healed retry; resume.
      await answerQuestionnaire(renderer);
      screen = screenOf(renderer);
      continue;
    }

    if (screen === 'notifications') {
      const label =
        scenario.finishChoice === 'enable' ? 'Turn on reminders' : 'Not now';
      if (nav?.mode === 'double-tap' && phase === 'faulted') {
        await doublePress(renderer, label);
      } else {
        await pressAsync(renderer, label);
      }
      await advance(SIXTY_SECONDS);
      const after = screenOf(renderer);
      const failures: string[] = [];
      const stash = mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
      const durable =
        stash !== undefined &&
        JSON.stringify(
          (parseJson(stash) as { profile?: unknown } | typeof INVALID) ===
            INVALID
            ? null
            : (parseJson(stash) as { profile?: unknown }).profile,
        ) === JSON.stringify(walkedProfile);
      if (after === 'signin' || after === 'signin-busy') {
        // Advancing is only honest once the answers are durably stashed.
        if (!durable)
          failures.push(
            'fake-success: reached sign-in without a durable stash of the answers',
          );
        if (useAppStore.getState().onboardingError)
          failures.push(
            'advanced to sign-in while an onboarding error is still set',
          );
      } else if (after === 'notifications') {
        // Staying put is only honest with a visible reason.
        const error = useAppStore.getState().onboardingError;
        if (!error)
          failures.push(
            'silent-failure: finish did nothing and showed no error',
          );
        else if (!allText(renderer).includes(error))
          failures.push(
            'silent-failure: onboarding error set but not rendered',
          );
        if (
          durable &&
          phase === 'faulted' &&
          !hasFault('sqlite.write', 'transient')
        )
          failures.push(
            'stash written durably yet the flow reported a failure',
          );
      }
      if (
        phase === 'faulted' &&
        hasFault('sqlite.write', 'slow') &&
        after !== 'signin' &&
        after !== 'signin-busy'
      )
        failures.push(`slow write: expected sign-in after 60s, got "${after}"`);
      // "Not now"/"Turn on reminders" whose pending-choice write failed is a
      // designed silent degrade (reminders default off; asked again later).
      if (
        phase === 'faulted' &&
        (after === 'signin' || after === 'signin-busy') &&
        mockKv.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY) === undefined
      ) {
        degraded.push(
          'pending notification choice lost silently (no user-visible error)',
        );
      }
      if (failures.length > 0) {
        checkpoints.push({
          at: `${phase}:${step}:finish`,
          screen: after,
          controls: recoveryControls(renderer),
          failures,
        });
        return after;
      }
      screen = after;
      continue;
    }

    if (screen === 'signin') {
      const auth = useAuthStore.getState();
      if (phase === 'faulted' && auth.error && triedRetry > 0) {
        // Already failed once under fault; nothing more to learn here.
        return screen;
      }
      triedRetry += 1;
      const bootstrapOkBefore =
        (mockHits['fetch.bootstrap:ok'] ?? 0) +
        (mockHits['fetch.bootstrap:slow'] ?? 0);
      await pressAsync(renderer, 'Sign in with Apple');
      await advance(SIXTY_SECONDS);
      const after = screenOf(renderer);
      const failures: string[] = [];
      const state = useAuthStore.getState();
      const bootstrapOk =
        (mockHits['fetch.bootstrap:ok'] ?? 0) +
          (mockHits['fetch.bootstrap:slow'] ?? 0) >
        bootstrapOkBefore;
      if (state.session && !bootstrapOk)
        failures.push(
          `fake-success: a session exists although /v1/account/bootstrap never answered OK (${after})`,
        );
      if (after === 'signin' && !state.session && !state.error)
        failures.push(
          'silent-failure: sign-in did nothing and surfaced no error',
        );
      if (
        after === 'signin' &&
        state.error &&
        !allText(renderer).includes(state.error.message)
      )
        failures.push('silent-failure: auth error set but not rendered');
      if (state.session && !state.session.localOnly && bootstrapOk) {
        const vault = mockKeychain.get(SESSION_VAULT_SERVICE);
        if (!vault && !hasFault('keychain.set'))
          failures.push(
            'durable session not persisted after a successful sign-in',
          );
      }
      if (failures.length > 0) {
        checkpoints.push({
          at: `${phase}:${step}:signin`,
          screen: after,
          controls: recoveryControls(renderer),
          failures,
        });
        return after;
      }
      screen = after;
      if (screen === 'signin') return screen;
      continue;
    }

    if (screen === 'error-state') {
      if (phase === 'faulted' && triedRetry > 0) return screen;
      triedRetry += 1;
      await pressAsync(renderer, 'Try again');
      await advance(SIXTY_SECONDS);
      screen = screenOf(renderer);
      continue;
    }

    if (screen === 'account-onboarding') {
      // A signed-in owner without a profile: the in-account questionnaire.
      if (phase === 'faulted' && triedRetry > 0) return screen;
      triedRetry += 1;
      await answerQuestionnaire(renderer);
      await pressAsync(
        renderer,
        scenario.finishChoice === 'enable' ? 'Turn on reminders' : 'Not now',
      );
      await advance(SIXTY_SECONDS);
      const after = screenOf(renderer);
      if (
        after === 'root' &&
        !getApiSession() &&
        useAuthStore.getState().session &&
        !useAuthStore.getState().session!.localOnly
      ) {
        degraded.push(
          'canonical account completed onboarding with NO live api session: profile saved locally only, never synced',
        );
      }
      screen = after;
      continue;
    }

    // loading / finishing / signin-busy / unknown: wait it out once.
    await advance(SIXTY_SECONDS);
    screen = screenOf(renderer);
  }
  return screen;
}

async function runScenario(
  scenario: Scenario,
  index: number,
): Promise<Outcome> {
  await resetRuntime();
  seedState(scenario);
  const seeded = new Map(mockKv);
  for (const fault of [scenario.primary, ...scenario.secondary])
    mockActive.set(fault.dep, { ...fault });
  applyClock(scenario);
  installFetch();

  const checkpoints: Checkpoint[] = [];
  const degraded: string[] = [];
  const renderer = await launch();
  // Launch: let the 8s launch wait, retries and any slow dependency run.
  await advance(SIXTY_SECONDS);
  let finalScreen = await drive(
    renderer,
    scenario,
    seeded,
    degraded,
    checkpoints,
    'faulted',
  );

  // Refresh storm check under clock skew: within the 60s window the keeper
  // must rotate at most a handful of times (MIN_ROTATION_GAP_MS = 30s).
  const refreshRequests = fetchLog.filter(l =>
    l.endsWith('/v1/auth/refresh'),
  ).length;
  const stormFailures: string[] = [];
  if (refreshRequests > 6)
    stormFailures.push(
      `refresh-storm: ${refreshRequests} refresh requests in the first minutes`,
    );

  // Heal every dependency and prove the flow can complete from where it is.
  mockActive.clear();
  let recovered: boolean | null = null;
  const faultedFailures = checkpoints
    .flatMap(c => c.failures)
    .concat(stormFailures);
  if (finalScreen !== 'root') {
    const healScreen = screenOf(renderer);
    if (
      (healScreen === 'loading' ||
        healScreen === 'finishing' ||
        healScreen === 'signin-busy') &&
      recoveryControls(renderer).length === 0
    ) {
      // Nothing to press: a hang with no control cannot recover in-process.
      recovered = false;
    } else {
      finalScreen = await drive(
        renderer,
        scenario,
        seeded,
        degraded,
        checkpoints,
        'healed',
      );
      recovered = finalScreen === 'root';
    }
  } else {
    recovered = true;
  }
  const healedFailures = checkpoints
    .flatMap(c => c.failures)
    .filter(f => !faultedFailures.includes(f));
  const failures = [...new Set([...faultedFailures, ...healedFailures])];
  if (recovered === false)
    failures.push(
      `not-recoverable: healed dependencies but flow ended on "${finalScreen}"`,
    );
  // Coverage honesty: a scenario only counts as an injected fault when the
  // primary fault was actually reached by the flow (clock/navigation faults
  // are applied by the driver rather than through a gated dependency).
  const { dep, mode } = scenario.primary;
  const exercised =
    dep === 'clock' ||
    dep === 'navigation' ||
    (mockHits[`${dep}:${mode}`] ?? 0) > 0;
  if (!exercised)
    failures.push(`harness: primary fault ${dep}/${mode} was never reached`);

  return {
    seed: scenario.seed,
    index,
    scenario: {
      primary: scenario.primary,
      secondary: scenario.secondary,
      launch: scenario.launch,
      seededProfile: scenario.seededProfile,
      seededStash: scenario.seededStash,
      finishChoice: scenario.finishChoice,
    },
    replay: `cd apps/mobile && STRESS_ONLY=${scenario.seed} npx jest --ci --silent __tests__/stress/launchGate.failureInjection.stress.test.tsx`,
    faultsHit: { ...mockHits },
    checkpoints,
    finalScreen,
    recovered,
    failures,
    degradedByDesign: [...new Set(degraded)],
    unhandledRejections: unhandled.length,
    consoleErrors: consoleErrors.slice(0, 3),
    refreshRequests,
    poisonCalls: [...mockPoisonCalls],
    exercised,
    knownBroken: isKnownBroken(scenario),
    classification: failures.length === 0 ? 'HELD' : 'BROKEN',
    ok: failures.length === 0,
  };
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const BASE_SEED = 0x1a7c_9e31;
const ITER = Number(process.env.STRESS_ITER ?? FAULT_TABLE.length);
const ONLY = process.env.STRESS_ONLY ? Number(process.env.STRESS_ONLY) : null;
const STRICT = process.env.STRESS_STRICT === '1';

/**
 * Primary faults the gate is KNOWN not to survive (campaign 2026-09-04 on
 * 1fb0efd7). Pinned with `it.failing` so the suite stays green while the
 * findings are open and turns red the moment one is fixed (delete the entry
 * then). STRESS_STRICT=1 runs them as ordinary failing tests.
 *
 *   keychain.get/never, sqlite.read/never, google.sdk/never,
 *   keychain.set/never (legacy Google restore persists before hydrated)
 *     authStore.hydrate awaits the vault read/write / kv read / Google silent
 *     restore with no deadline → "Getting things ready" forever, no control.
 *   sqlite.read/malformed, sqlite.data/partial
 *     appStore.hydrate `JSON.parse(raw) as Profile` never validates the
 *     shape → RootNavigator renders with a non-Profile value (fake success).
 *   sqlite.data/malformed
 *     a torn profile row throws in hydrate → ErrorState whose "Try again"
 *     re-reads the same row forever; no path discards it or re-runs setup.
 *   sqlite.write/never, scheduler.requestPermission/never,
 *   scheduler.cancelAll/never (in-account "Not now" → setPrefs → syncNow)
 *     finishOnboarding awaits without a deadline; `notificationBusy` stays
 *     true so every later finish press is a silent no-op.
 *   apple.native/never
 *     signInWithApple awaits the native sheet without a deadline; `busy`
 *     stays true so Back → re-enter → Sign in is a silent no-op.
 */
interface KnownBroken extends Pick<Fault, 'dep' | 'mode'> {
  launch?: LaunchProfile;
  seededProfile?: SeededProfile;
  finishChoice?: FinishChoice;
}
const KNOWN_BROKEN: readonly KnownBroken[] = [
  { dep: 'keychain.get', mode: 'never' },
  { dep: 'keychain.set', mode: 'never', launch: 'legacy-google-flag' },
  { dep: 'sqlite.read', mode: 'never' },
  { dep: 'sqlite.read', mode: 'malformed' },
  { dep: 'sqlite.write', mode: 'never' },
  { dep: 'sqlite.data', mode: 'malformed' },
  { dep: 'sqlite.data', mode: 'partial' },
  {
    dep: 'scheduler.cancelAll',
    mode: 'never',
    launch: 'guest-local',
    seededProfile: 'absent',
    finishChoice: 'not_now',
  },
  { dep: 'scheduler.requestPermission', mode: 'never' },
  { dep: 'apple.native', mode: 'never' },
  { dep: 'google.sdk', mode: 'never' },
];
function isKnownBroken(scenario: Scenario): boolean {
  return KNOWN_BROKEN.some(
    k =>
      k.dep === scenario.primary.dep &&
      k.mode === scenario.primary.mode &&
      (k.launch === undefined || k.launch === scenario.launch) &&
      (k.seededProfile === undefined ||
        k.seededProfile === scenario.seededProfile) &&
      (k.finishChoice === undefined ||
        k.finishChoice === scenario.finishChoice),
  );
}
const OUT_DIR =
  process.env.STRESS_OUT ??
  join(
    __dirname,
    '..',
    '..',
    'artifacts',
    'stress',
    'launch-gate-failure-injection',
  );

function scenarios(): Array<{ scenario: Scenario; index: number }> {
  if (ONLY !== null) {
    const index = ONLY - BASE_SEED;
    if (!Number.isInteger(index) || index < 0)
      throw new Error(
        `STRESS_ONLY must be a seed produced by this suite, got ${ONLY}`,
      );
    return [{ scenario: generate(ONLY, index), index }];
  }
  return Array.from({ length: ITER }, (_, index) => ({
    scenario: generate(BASE_SEED + index, index),
    index,
  }));
}

const results: Outcome[] = [];
const realFetch = globalThis.fetch;
const realConsoleError = console.error;
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(REAL_NOW_MS);
  process.on('unhandledRejection', onUnhandled);
  console.error = (...args: unknown[]) => {
    consoleErrors.push(
      args.map(a => (a instanceof Error ? a.message : String(a))).join(' '),
    );
  };
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  console.error = realConsoleError;
  globalThis.fetch = realFetch;
  jest.useRealTimers();
  const failed = results.filter(r => !r.ok);
  const injected: Record<string, number> = {};
  for (const r of results) {
    for (const [key, n] of Object.entries(r.faultsHit)) {
      if (!key.endsWith(':ok')) injected[key] = (injected[key] ?? 0) + n;
    }
  }
  const byFailure: Record<string, number> = {};
  for (const r of failed)
    for (const f of r.failures) {
      const kind = f.split(':')[0] ?? f;
      byFailure[kind] = (byFailure[kind] ?? 0) + 1;
    }
  const summary = {
    generatedAt: new Date().toISOString(),
    unit: 'mod-launch-gate',
    lens: 'failure-injection',
    baseSeed: BASE_SEED,
    iterations: ITER,
    only: ONLY,
    strict: STRICT,
    executed: results.length,
    exercised: results.filter(r => r.exercised).length,
    held: results.length - failed.length,
    broken: failed.length,
    brokenKnown: failed.filter(r => r.knownBroken).length,
    brokenNew: failed.filter(r => !r.knownBroken).length,
    fixedKnown: results.filter(r => r.ok && r.knownBroken).map(r => r.seed),
    distinctFaultsInjected: Object.keys(injected).length,
    injectedFaultCalls: Object.values(injected).reduce((a, b) => a + b, 0),
    byFailure,
    degradedByDesign: [...new Set(results.flatMap(r => r.degradedByDesign))],
    failedSeeds: failed.map(r => ({
      seed: r.seed,
      primary: r.scenario.primary,
      knownBroken: r.knownBroken,
      failures: r.failures,
      replay: r.replay,
    })),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, 'summary.json'),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, 'results.json'),
    JSON.stringify(results, null, 2),
  );
});

afterEach(async () => {
  await resetRuntime();
});

async function runCase({
  scenario,
  index,
}: {
  scenario: Scenario;
  index: number;
}) {
  const outcome = await runScenario(scenario, index);
  results.push(outcome);
  if (!outcome.ok) {
    throw new Error(
      `seed ${scenario.seed} BROKEN\n` +
        outcome.failures.map(f => `  - ${f}`).join('\n') +
        `\n  final screen: ${outcome.finalScreen}\n  replay: ${outcome.replay}\n` +
        `  faults hit: ${JSON.stringify(outcome.faultsHit)}`,
    );
  }
}

describe('stress: launch gate failure injection (App Gate × real stores)', () => {
  const all = scenarios();
  const expectedHeld = all.filter(c => STRICT || !isKnownBroken(c.scenario));
  const expectedBroken = all.filter(c => !STRICT && isKnownBroken(c.scenario));
  const title =
    'seed $scenario.seed · $scenario.primary.dep/$scenario.primary.mode · $scenario.launch';

  if (expectedHeld.length > 0) it.each(expectedHeld)(title, runCase, 120_000);
  // Open findings: these MUST still fail; a pass means the bug is fixed and
  // the KNOWN_BROKEN entry must be removed so the scenario guards it.
  if (expectedBroken.length > 0)
    it.failing.each(expectedBroken)(`KNOWN_BROKEN ${title}`, runCase, 120_000);

  it('the default campaign covers the whole reachable dependency × mode table (≥ 60 faults)', () => {
    expect(FAULT_TABLE.length).toBeGreaterThanOrEqual(60);
    if (ONLY === null && process.env.STRESS_ITER === undefined) {
      expect(ITER).toBe(FAULT_TABLE.length);
    }
  });
});
