/**
 * STRESS / long-run-leak — SignInScreen mounted and unmounted through the
 * REAL navigator + providers the app uses, hundreds of times in ONE process.
 *
 * Tree under test (mirrors App.tsx + RootNavigator.tsx's ConnectAccount
 * route): SafeAreaProvider → QueryClientProvider → NavigationContainer →
 * createNativeStackNavigator → `ConnectAccount` → <SignInScreen onBack=
 * {() => navigation.goBack()} />. The auth store, design components, hooks
 * and react-navigation are real. Only native seams are mocked: SQLite
 * (op-sqlite via src/data/db), Keychain, the Google Sign-In SDK, the
 * PickleAuth Apple native module, safe-area-context's own jest mock, and
 * `fetch`. `zustand` is wrapped (not replaced — real createStore/useStore)
 * purely to count live store subscriptions.
 *
 * Every iteration is a pure function of its seed: seed → scenario (which
 * provider is tapped, how the provider/backend answers, whether the error
 * card is dismissed, how the screen is left). After each iteration the
 * harness asserts timers, store subscriptions, RN emitter listeners and the
 * auth store's transient state are back at the post-warm-up baseline. Every
 * STRESS_HEAP_EVERY iterations it runs global.gc() (when exposed) and samples
 * heap + Node active handles; render/unmount time drift is measured across
 * the campaign.
 *
 * Campaign (what the coordinator asked for; ≥500 iterations, GC exposed):
 *   cd apps/mobile && NODE_OPTIONS=--expose-gc STRESS_ITER=500 \
 *     npx jest --ci --runInBand __tests__/stress/signInScreen.longRunLeak.stress.test.tsx
 * Default (suite-speed, no GC required): STRESS_ITER unset → 40 iterations;
 * the heap-slope invariant is only asserted when gc is exposed AND at least
 * three heap samples exist.
 * Replay one seed from a clean store:
 *   STRESS_SEED_FILTER=<seed> npx jest --ci __tests__/stress/signInScreen.longRunLeak.stress.test.tsx
 * Artifacts (gitignored): <repo>/artifacts/stress/scr-signinscreen-long-run-leak/
 *   (override with STRESS_ARTIFACT_DIR).
 */
import React from 'react';
import {
  AccessibilityInfo,
  AppState,
  Dimensions,
  Keyboard,
  Linking,
  NativeModules,
  Text,
  View,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { FakeLocalDb } from '../../xc-harness/lifecycle-persistence/fakeLocalDb';
import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import { makePrng, pick } from '../../xc-harness/lifecycle-persistence/seeds';

declare const __dirname: string;
declare const require: (id: string) => unknown;
declare const performance: { now(): number };
declare const setImmediate: (callback: () => void) => unknown;
declare const process: { getActiveResourcesInfo?: () => string[] };
declare const global: {
  gc?: () => void;
  __stressStoreSubscriptions?: () => number;
};

// ─── Instrumentation seam: count live zustand subscriptions ──────────────────
// Real createStore + real useStore; only `api.subscribe` is wrapped so the
// harness can prove every React subscriber unsubscribed on unmount.
jest.mock('zustand', () => {
  const actual = jest.requireActual<typeof import('zustand')>('zustand');
  const vanilla =
    jest.requireActual<typeof import('zustand/vanilla')>('zustand/vanilla');
  let live = 0;
  (globalThis as { __stressStoreSubscriptions?: () => number })[
    '__stressStoreSubscriptions'
  ] = () => live;
  const createImpl = (createState: unknown) => {
    const api = vanilla.createStore(createState as never) as {
      subscribe: (listener: unknown) => () => void;
    };
    const rawSubscribe = api.subscribe;
    api.subscribe = (listener: unknown) => {
      live += 1;
      const off = rawSubscribe(listener);
      let done = false;
      return () => {
        if (!done) {
          done = true;
          live -= 1;
        }
        off();
      };
    };
    const useBoundStore = (selector?: unknown) =>
      actual.useStore(api as never, selector as never);
    Object.assign(useBoundStore, api);
    return useBoundStore;
  };
  const create = (createState?: unknown) =>
    createState ? createImpl(createState) : createImpl;
  return { ...actual, create, default: create };
});

// ─── Native seams (the only mocks besides fetch) ─────────────────────────────
const mockDb = { current: new FakeLocalDb() };
jest.mock('../../src/data/db', () => ({
  getDb: () => mockDb.current.handle(),
}));

const mockKeychain = new Map<string, { username: string; password: string }>();
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
    mockKeychain.set(options.service ?? '__default__', { username, password });
    return { service: options.service, storage: 'mock' };
  },
  getGenericPassword: async (options: { service?: string } = {}) => {
    const item = mockKeychain.get(options.service ?? '__default__');
    if (!item) return false;
    return { service: options.service, storage: 'mock', ...item };
  },
  resetGenericPassword: async (options: { service?: string } = {}) =>
    mockKeychain.delete(options.service ?? '__default__'),
}));

const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(),
  signIn: jest.fn(),
  signInSilently: jest.fn(),
  hasPreviousSignIn: jest.fn(() => false),
  signOut: jest.fn(async () => {}),
  revokeAccess: jest.fn(async () => {}),
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: mockGoogleSignin,
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
    legalPrivacyUrl: null,
    legalTermsUrl: null,
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
// The library's own jest mock: a real SafeAreaProvider/insets context backed
// by fixed metrics instead of the native view.
jest.mock(
  'react-native-safe-area-context',
  () =>
    jest.requireActual<{ default: unknown }>(
      'react-native-safe-area-context/jest/mock',
    ).default,
);

import { SignInScreen } from '../../src/screens/SignInScreen';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession } from '../../src/account/apiSession';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

// ─── Campaign knobs ──────────────────────────────────────────────────────────

const ITERATIONS = Number(nodeProcess.env['STRESS_ITER'] ?? 40);
const BASE_SEED = Number(nodeProcess.env['STRESS_SEED'] ?? 20260904);
const HEAP_EVERY = Number(nodeProcess.env['STRESS_HEAP_EVERY'] ?? 50);
const SEED_FILTER = nodeProcess.env['STRESS_SEED_FILTER'];
/** Bisection knobs: restrict the seeded action/exit space, or swap the
 * screen for an inert placeholder to separate navigator cost from screen cost. */
const ACTION_FILTER = listEnv('STRESS_ACTIONS');
const EXIT_FILTER = listEnv('STRESS_EXITS');
const SCREEN_UNDER_TEST = nodeProcess.env['STRESS_SCREEN'] ?? 'signin';
/** STRESS_HEAP_SNAPSHOT=1 writes v8 heap snapshots at baseline and at the end
 * (retainer attribution for any residual slope). */
const WRITE_HEAP_SNAPSHOTS = nodeProcess.env['STRESS_HEAP_SNAPSHOT'] === '1';

function writeHeapSnapshot(name: string): string | null {
  if (!WRITE_HEAP_SNAPSHOTS) return null;
  const v8 = require('node:v8') as {
    writeHeapSnapshot: (file: string) => string;
  };
  return v8.writeHeapSnapshot(path.join(artifactDir(), name));
}

function listEnv(name: string): string[] | null {
  const raw = nodeProcess.env[name];
  if (!raw) return null;
  const items = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}
/** Bound before fake timers are installed, so artifacts carry wall-clock time. */
const realDateNow = Date.now;
const WARMUP_ITERATIONS = 3;
/** Finding threshold from the lens: monotone heap growth > 5 % per 100 iters. */
const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;
/** Late-campaign median render time may not exceed 3× the early median. */
const DRIFT_LIMIT_RATIO = 3;

function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(
          __dirname,
          '../../../../artifacts/stress/scr-signinscreen-long-run-leak',
        );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeArtifact(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(
    file,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
  );
  return file;
}

// ─── Seeded scenarios ────────────────────────────────────────────────────────

type Action =
  | 'none'
  | 'apple-cancel'
  | 'apple-error'
  | 'apple-missing-module'
  | 'apple-backend-401'
  | 'apple-backend-500'
  | 'apple-network'
  | 'apple-malformed-200'
  | 'apple-double-tap-cancel'
  | 'apple-hang-leave-then-cancel'
  | 'google-cancel'
  | 'google-error'
  | 'google-play-services-error'
  | 'google-backend-401'
  | 'google-hang-leave-then-error';
type Exit = 'header-back' | 'navigation-goBack' | 'remount-tree';

const ACTIONS: readonly Action[] = [
  'none',
  'apple-cancel',
  'apple-error',
  'apple-missing-module',
  'apple-backend-401',
  'apple-backend-500',
  'apple-network',
  'apple-malformed-200',
  'apple-double-tap-cancel',
  'apple-hang-leave-then-cancel',
  'google-cancel',
  'google-error',
  'google-play-services-error',
  'google-backend-401',
  'google-hang-leave-then-error',
];

interface Scenario {
  seed: number;
  action: Action;
  /** Dismiss the error card (when one is showing) before leaving. */
  dismissError: boolean;
  exit: Exit;
  /** Fake-clock ms allowed for press/exit animations to settle. */
  settleMs: number;
}

function scenarioFor(seed: number): Scenario {
  const rng = makePrng(seed);
  const actionPool = ACTION_FILTER
    ? ACTIONS.filter(a => ACTION_FILTER.includes(a))
    : ACTIONS;
  const action = pick(rng, actionPool.length > 0 ? actionPool : ACTIONS);
  const dismissError = rng() < 0.5;
  const exitRoll = rng();
  let exit: Exit =
    exitRoll < 0.1
      ? 'remount-tree'
      : exitRoll < 0.55
        ? 'header-back'
        : 'navigation-goBack';
  if (EXIT_FILTER && !EXIT_FILTER.includes(exit)) {
    exit = (EXIT_FILTER[0] as Exit | undefined) ?? exit;
  }
  const settleMs = pick(rng, [0, 16, 250, 1000]);
  return { seed, action, dismissError, exit, settleMs };
}

// ─── Real tree: providers + native stack + ConnectAccount route ──────────────

type StackParams = { Home: undefined; ConnectAccount: undefined };
const Stack = createNativeStackNavigator<StackParams>();
const navigationRef = createNavigationContainerRef<StackParams>();

function HomeRoute() {
  return (
    <View testID="stress-home">
      <Text>HOME</Text>
    </View>
  );
}

// Inert stand-in used only for bisection (STRESS_SCREEN=placeholder).
function PlaceholderScreen(props: { onBack: () => void }) {
  return (
    <View testID="sign-in-body">
      <Text
        onPress={props.onBack}
        accessibilityLabel="Back"
        accessibilityState={{ disabled: false }}
      >
        PLACEHOLDER
      </Text>
    </View>
  );
}

// Same body as RootNavigator.tsx's ConnectAccountRoute.
function ConnectAccountRoute({
  navigation,
}: NativeStackScreenProps<StackParams, 'ConnectAccount'>) {
  if (SCREEN_UNDER_TEST === 'placeholder') {
    return <PlaceholderScreen onBack={() => navigation.goBack()} />;
  }
  return <SignInScreen onBack={() => navigation.goBack()} />;
}

function Tree(props: { queryClient: QueryClient }) {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={props.queryClient}>
        <NavigationContainer ref={navigationRef}>
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="Home" component={HomeRoute} />
            <Stack.Screen
              name="ConnectAccount"
              component={ConnectAccountRoute}
              options={{ presentation: 'fullScreenModal' }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

// ─── Listener/handle accounting ──────────────────────────────────────────────

interface EmitterLike {
  addEventListener?: (...args: unknown[]) => { remove: () => void };
  addListener?: (...args: unknown[]) => { remove: () => void };
}

const emitterCounts: Record<string, number> = {};
function trackEmitter(name: string, target: EmitterLike): void {
  const method: 'addEventListener' | 'addListener' =
    typeof target.addEventListener === 'function'
      ? 'addEventListener'
      : 'addListener';
  const original = target[method];
  if (typeof original !== 'function') return;
  emitterCounts[name] = 0;
  target[method] = (...args: unknown[]) => {
    const subscription = original.apply(target, args);
    emitterCounts[name] = (emitterCounts[name] ?? 0) + 1;
    let removed = false;
    const rawRemove = subscription?.remove;
    const wrapped = {
      ...subscription,
      remove: () => {
        if (!removed) {
          removed = true;
          emitterCounts[name] = (emitterCounts[name] ?? 0) - 1;
        }
        if (typeof rawRemove === 'function') rawRemove.call(subscription);
      },
    };
    return wrapped;
  };
}

trackEmitter('AppState', AppState as unknown as EmitterLike);
trackEmitter('AccessibilityInfo', AccessibilityInfo as unknown as EmitterLike);
trackEmitter('Dimensions', Dimensions as unknown as EmitterLike);
trackEmitter('Keyboard', Keyboard as unknown as EmitterLike);
trackEmitter('Linking', Linking as unknown as EmitterLike);

function storeSubscriptions(): number {
  return global.__stressStoreSubscriptions?.() ?? -1;
}

interface Baseline {
  timers: number;
  storeSubscriptions: number;
  emitters: Record<string, number>;
}

function snapshotCounts(): Baseline {
  return {
    timers: jest.getTimerCount(),
    storeSubscriptions: storeSubscriptions(),
    emitters: { ...emitterCounts },
  };
}

function activeHandles(): Record<string, number> {
  const info = process.getActiveResourcesInfo?.() ?? [];
  const counts: Record<string, number> = {};
  for (const kind of info) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

function heapNow(): { heapUsedMb: number; heapTotalMb: number; rssMb: number } {
  const usage = nodeProcess.memoryUsage();
  return {
    heapUsedMb: round(usage.heapUsed / 1048576),
    heapTotalMb: round(usage.heapTotal / 1048576),
    rssMb: round(usage.rss / 1048576),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/** Least-squares slope of heapUsed (MB) per iteration. */
function slope(points: { x: number; y: number }[]): number {
  const n = points.length;
  if (n < 2) return 0;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

// ─── Provider/backend doubles driven by the scenario ─────────────────────────

const nativeModules = NativeModules as {
  PickleAuth?: { signInWithApple: jest.Mock };
};
const mockAppleSignIn = jest.fn();

function nativeError(code: string, message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function applePayload(iteration: number) {
  return {
    user: 'apple-sub-stress',
    identityToken: `apple-identity-token-${iteration}`,
    authorizationCode: `apple-code-${iteration}`,
    email: 'pat@privaterelay.example',
    givenName: 'Pat',
    familyName: 'Player',
  };
}

function googleSuccess(iteration: number) {
  return {
    type: 'success',
    data: {
      user: {
        id: 'google-uid-stress',
        name: 'Pat Player',
        email: 'pat@gmail.example',
        photo: null,
        familyName: 'Player',
        givenName: 'Pat',
      },
      scopes: [],
      idToken: `google-id-token-${iteration}`,
      serverAuthCode: null,
    },
  };
}

function response(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const fetchState = { calls: 0 };
type FetchMode = 'unreachable' | '401' | '500' | 'network' | 'malformed-200';
let fetchMode: FetchMode = 'unreachable';
const fetchDouble: typeof fetch = async () => {
  fetchState.calls += 1;
  switch (fetchMode) {
    case '401':
      return response({ error: 'invalid identity token' }, 401);
    case '500':
      return response({ error: 'boom' }, 500);
    case 'network':
      throw new TypeError('Network request failed');
    case 'malformed-200':
      return response({ definitely: 'not a bootstrap payload' }, 200);
    default:
      throw new Error('stress harness: fetch reached in a no-network scenario');
  }
};

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ─── Tree helpers ────────────────────────────────────────────────────────────

type Renderer = ReturnType<typeof TestRenderer.create>;
const tree: { renderer: Renderer | null; queryClient: QueryClient | null } = {
  renderer: null,
  queryClient: null,
};

function mountTree(): void {
  tree.queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const client = tree.queryClient;
  act(() => {
    tree.renderer = TestRenderer.create(<Tree queryClient={client} />);
  });
}

function unmountTree(): void {
  act(() => {
    tree.renderer?.unmount();
  });
  tree.renderer = null;
  tree.queryClient?.clear();
  tree.queryClient = null;
}

function renderer(): Renderer {
  if (!tree.renderer) throw new Error('tree not mounted');
  return tree.renderer;
}

function signInBodies(): number {
  return renderer().root.findAll(
    n => typeof n.type === 'string' && n.props['testID'] === 'sign-in-body',
  ).length;
}

function controls(label: string) {
  return renderer().root.findAll(
    node =>
      node.props['accessibilityLabel'] === label &&
      typeof node.props['onPress'] === 'function' &&
      node.props['accessibilityState'] !== undefined,
  );
}

function allText(): string {
  return renderer()
    .root.findAllByType(Text)
    .map(node => node.props['children'])
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

async function press(label: string): Promise<boolean> {
  const [node] = controls(label);
  if (!node) return false;
  await act(async () => {
    node.props['onPress']();
  });
  return true;
}

/** Advance the fake clock, then drain every pending microtask (setImmediate is real). */
async function settle(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 4; i += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  });
}

function currentRoute(): string | null {
  return navigationRef.isReady()
    ? (navigationRef.getCurrentRoute()?.name ?? null)
    : null;
}

// ─── Iteration ───────────────────────────────────────────────────────────────

interface IterationRow {
  iteration: number;
  seed: number;
  scenario: Omit<Scenario, 'seed'>;
  mountMs: number;
  unmountMs: number;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  ok: boolean;
  failed: string[];
}

const consoleErrors: string[] = [];
let consoleErrorCount = 0;

/**
 * Every jest.fn records each call (calls/results/contexts/instances/
 * invocationCallOrder) until cleared. @react-native/jest-preset installs
 * `global.performance.now = jest.fn(Date.now)` (the React scheduler calls it
 * ~1.3k times per mount/unmount → ~0.16 MB/iteration) plus jest.fn stubs on
 * host components (`measure`, …). That memory belongs to the test preset, not
 * to the app, so the records are cleared per iteration to keep the heap slope
 * attributable to the tree under test. Implementations (mockResolvedValue
 * etc.) survive mockClear; the harness sets them after this call anyway.
 * Verified with v8 heap snapshots (STRESS_HEAP_SNAPSHOT=1): before this the
 * top retained arrays were `mock.calls` et al. of `performance.now`.
 */
function clearMockCallRecords(): void {
  jest.clearAllMocks();
}

async function runIteration(
  iteration: number,
  scenario: Scenario,
  baseline: Baseline | null,
): Promise<IterationRow> {
  const errorsBefore = consoleErrorCount;
  clearMockCallRecords();
  // The fake DB keeps a statement log for assertions; it is harness state,
  // not app state, so it must not be counted as heap growth.
  mockDb.current.statements.length = 0;
  fetchState.calls = 0;
  fetchMode = 'unreachable';
  nativeModules.PickleAuth = { signInWithApple: mockAppleSignIn };
  mockAppleSignIn.mockReset();
  mockGoogleSignin.hasPlayServices.mockReset();
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signIn.mockReset();
  mockGoogleSignin.signIn.mockResolvedValue({ type: 'cancelled', data: null });

  let pendingApple: Deferred | null = null;
  let pendingGoogle: Deferred | null = null;

  switch (scenario.action) {
    case 'apple-cancel':
    case 'apple-double-tap-cancel':
      mockAppleSignIn.mockRejectedValue(
        nativeError('auth.canceled', 'Sign-in canceled.'),
      );
      break;
    case 'apple-error':
      mockAppleSignIn.mockRejectedValue(
        nativeError('ASAuthorizationError', 'Apple sign-in failed (1000).'),
      );
      break;
    case 'apple-missing-module':
      delete nativeModules.PickleAuth;
      break;
    case 'apple-backend-401':
      mockAppleSignIn.mockResolvedValue(applePayload(iteration));
      fetchMode = '401';
      break;
    case 'apple-backend-500':
      mockAppleSignIn.mockResolvedValue(applePayload(iteration));
      fetchMode = '500';
      break;
    case 'apple-network':
      mockAppleSignIn.mockResolvedValue(applePayload(iteration));
      fetchMode = 'network';
      break;
    case 'apple-malformed-200':
      mockAppleSignIn.mockResolvedValue(applePayload(iteration));
      fetchMode = 'malformed-200';
      break;
    case 'apple-hang-leave-then-cancel':
      pendingApple = deferred();
      mockAppleSignIn.mockReturnValue(pendingApple.promise);
      break;
    case 'google-cancel':
      break;
    case 'google-error':
      mockGoogleSignin.signIn.mockRejectedValue(
        nativeError('SIGN_IN_REQUIRED', 'Google SDK failure (simulated).'),
      );
      break;
    case 'google-play-services-error':
      mockGoogleSignin.hasPlayServices.mockRejectedValue(
        nativeError('PLAY_SERVICES_NOT_AVAILABLE', 'Play services missing.'),
      );
      break;
    case 'google-backend-401':
      mockGoogleSignin.signIn.mockResolvedValue(googleSuccess(iteration));
      fetchMode = '401';
      break;
    case 'google-hang-leave-then-error':
      pendingGoogle = deferred();
      mockGoogleSignin.signIn.mockReturnValue(pendingGoogle.promise);
      break;
    case 'none':
      break;
  }

  const errorBefore = useAuthStore.getState().error;

  // ── Mount: push the ConnectAccount route (what the app does).
  const mountStart = performance.now();
  await act(async () => {
    navigationRef.navigate('ConnectAccount');
  });
  await settle(0);
  const mountMs = performance.now() - mountStart;
  const mountedBodies = signInBodies();
  const routeAfterPush = currentRoute();
  const subscriptionsWhileMounted = storeSubscriptions();

  // ── Interact.
  let pressed = false;
  let busySeen = false;
  let errorCardSeen = false;
  let errorCardText: string | null = null;
  const providerLabel = scenario.action.startsWith('apple')
    ? 'Continue with Apple'
    : 'Continue with Google';
  if (scenario.action !== 'none') {
    pressed = await press(providerLabel);
    if (scenario.action === 'apple-double-tap-cancel') {
      await press(providerLabel);
    }
    if (pendingApple || pendingGoogle) {
      await settle(0);
      busySeen =
        useAuthStore.getState().busy &&
        allText().includes('Signing in securely…');
    } else {
      await settle(scenario.settleMs);
      await settle(0);
      const dismiss = controls('Dismiss sign-in error');
      errorCardSeen = dismiss.length > 0;
      if (errorCardSeen) {
        const text = allText();
        errorCardText = text.includes('NOT CONFIGURED YET')
          ? 'NOT CONFIGURED YET'
          : text.includes('SIGN-IN FAILED')
            ? 'SIGN-IN FAILED'
            : 'unknown';
        if (scenario.dismissError) await press('Dismiss sign-in error');
      }
    }
  }
  const storeAfterAction = useAuthStore.getState();
  const errorAfterAction = storeAfterAction.error;
  const busyAfterAction = storeAfterAction.busy;

  // ── Exit.
  const exitStart = performance.now();
  let exitPerformed: string = scenario.exit;
  if (scenario.exit === 'header-back') {
    const ok = await press('Back');
    if (!ok) exitPerformed = 'header-back:missing';
  } else if (scenario.exit === 'navigation-goBack') {
    await act(async () => {
      if (navigationRef.canGoBack()) navigationRef.goBack();
    });
  } else {
    unmountTree();
  }
  await settle(scenario.settleMs);
  await settle(1000);
  if (scenario.exit === 'remount-tree') mountTree();
  await settle(0);
  const unmountMs = performance.now() - exitStart;

  // ── Provider sheet finishing AFTER the screen is gone.
  let lateResolution = false;
  if (pendingApple) {
    pendingApple.reject(nativeError('auth.canceled', 'Sign-in canceled.'));
    lateResolution = true;
  }
  if (pendingGoogle) {
    pendingGoogle.reject(
      nativeError('SIGN_IN_REQUIRED', 'Google SDK failure (simulated).'),
    );
    lateResolution = true;
  }
  if (lateResolution) await settle(0);
  // Animations that may outlive the screen (PressableScale spring, error card).
  await settle(2000);

  const bodiesAfter = signInBodies();
  const routeAfter = currentRoute();
  const counts = snapshotCounts();
  const storeAfter = useAuthStore.getState();
  const newConsoleErrors = consoleErrorCount - errorsBefore;

  const expectsProviderError = ![
    'none',
    'apple-cancel',
    'apple-double-tap-cancel',
    'google-cancel',
    'apple-hang-leave-then-cancel',
    'google-hang-leave-then-error',
  ].includes(scenario.action);
  const expectedCardLabel =
    scenario.action === 'apple-missing-module'
      ? 'NOT CONFIGURED YET'
      : 'SIGN-IN FAILED';

  const invariants: Record<string, boolean> = {
    mounted: mountedBodies === 1 && routeAfterPush === 'ConnectAccount',
    storeSubscribedWhileMounted:
      SCREEN_UNDER_TEST === 'placeholder' || subscriptionsWhileMounted > 0,
    pressedWhenRequested: scenario.action === 'none' || pressed,
    errorCardMatchesOutcome: expectsProviderError
      ? errorCardSeen && errorCardText === expectedCardLabel
      : !errorCardSeen,
    busyClearedAfterAction:
      !pendingApple && !pendingGoogle ? !busyAfterAction : busySeen,
    unmounted: bodiesAfter === 0 && routeAfter === 'Home',
    storeIdleAfterExit:
      storeAfter.busy === false && storeAfter.session === null,
    timersAtBaseline: baseline ? counts.timers === baseline.timers : true,
    storeSubscriptionsAtBaseline: baseline
      ? counts.storeSubscriptions === baseline.storeSubscriptions
      : true,
    emitterListenersAtBaseline: baseline
      ? Object.keys(baseline.emitters).every(
          key => counts.emitters[key] === baseline.emitters[key],
        )
      : true,
    noConsoleErrors: newConsoleErrors === 0,
    noFetchInOfflineScenario:
      fetchMode !== 'unreachable' || fetchState.calls === 0,
  };
  const failed = Object.entries(invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);

  return {
    iteration,
    seed: scenario.seed,
    scenario: {
      action: scenario.action,
      dismissError: scenario.dismissError,
      exit: scenario.exit,
      settleMs: scenario.settleMs,
    },
    mountMs: round(mountMs),
    unmountMs: round(unmountMs),
    observed: {
      routeAfterPush,
      mountedBodies,
      subscriptionsWhileMounted,
      routeAfter,
      bodiesAfterExit: bodiesAfter,
      exitPerformed,
      busySeen,
      errorCardSeen,
      errorCardText,
      errorBefore: errorBefore?.code ?? null,
      errorAfterAction: errorAfterAction?.code ?? null,
      errorAfterExit: storeAfter.error?.code ?? null,
      fetchCalls: fetchState.calls,
      lateResolution,
      counts,
      consoleErrors: newConsoleErrors,
    },
    invariants,
    ok: failed.length === 0,
    failed,
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
let consoleErrorSpy: jest.SpyInstance | null = null;

beforeAll(() => {
  // Wall-clock + microtask plumbing stay real so mount/unmount timings are
  // real and promise chains drain; every app timer/rAF is fake and counted.
  jest.useFakeTimers({
    doNotFake: [
      'performance',
      'hrtime',
      'nextTick',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
    ],
  });
  jest.setSystemTime(new Date('2026-09-04T09:00:00.000Z'));
  globalThis.fetch = fetchDouble;
  consoleErrorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrorCount += 1;
      if (consoleErrors.length < 20)
        consoleErrors.push(
          args
            .map(a => String(a))
            .join(' ')
            .slice(0, 400),
        );
    });
});

afterAll(() => {
  if (tree.renderer) unmountTree();
  clearSyncRuntime();
  clearApiSession();
  globalThis.fetch = realFetch;
  delete nativeModules.PickleAuth;
  consoleErrorSpy?.mockRestore();
  jest.useRealTimers();
});

beforeEach(() => {
  mockDb.current = new FakeLocalDb();
  mockKeychain.clear();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: true,
    session: null,
    busy: false,
    error: null,
  });
});

describe('SignInScreen long-run leak (real navigator + providers)', () => {
  it(
    `mounts/unmounts SignInScreen ${SEED_FILTER ? 'for one replayed seed' : `${ITERATIONS} times`} in one process with timers, subscriptions, listeners and heap back at baseline`,
    async () => {
      const gcAvailable = typeof global.gc === 'function';
      const gc = () => {
        clearMockCallRecords();
        if (global.gc) global.gc();
      };

      mountTree();
      await settle(0);
      expect(currentRoute()).toBe('Home');

      const seeds: number[] = SEED_FILTER
        ? [Number(SEED_FILTER)]
        : Array.from({ length: ITERATIONS }, (_, i) => BASE_SEED + i);

      // Warm-up: lets process-lifetime singletons (reduced-motion observer,
      // lazily-imported Google SDK, navigation caches) initialise so the
      // baseline is what a steady-state process looks like.
      const warmup: IterationRow[] = [];
      for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
        warmup.push(
          await runIteration(-(i + 1), scenarioFor(BASE_SEED - 1 - i), null),
        );
      }
      gc();
      const baseline = snapshotCounts();
      const baselineHeap = heapNow();
      const baselineHandles = activeHandles();
      const snapshotBefore = writeHeapSnapshot('heap-baseline.heapsnapshot');

      const rows: IterationRow[] = [];
      const heapSamples: {
        iteration: number;
        heapUsedMb: number;
        heapTotalMb: number;
        rssMb: number;
        handles: Record<string, number>;
        counts: Baseline;
      }[] = [
        {
          iteration: 0,
          ...baselineHeap,
          handles: baselineHandles,
          counts: baseline,
        },
      ];

      for (let i = 0; i < seeds.length; i += 1) {
        const seed = seeds[i] as number;
        const row = await runIteration(i + 1, scenarioFor(seed), baseline);
        rows.push(row);
        if ((i + 1) % HEAP_EVERY === 0 || i + 1 === seeds.length) {
          gc();
          heapSamples.push({
            iteration: i + 1,
            ...heapNow(),
            handles: activeHandles(),
            counts: snapshotCounts(),
          });
        }
      }

      const snapshotAfter = writeHeapSnapshot('heap-final.heapsnapshot');

      // ── Heap slope: least-squares MB/iteration → % of baseline per 100 iters.
      const points = heapSamples.map(s => ({
        x: s.iteration,
        y: s.heapUsedMb,
      }));
      const mbPerIteration = slope(points);
      const slopePctPer100 =
        baselineHeap.heapUsedMb > 0
          ? (mbPerIteration * 100 * 100) / baselineHeap.heapUsedMb
          : 0;
      const monotone =
        heapSamples.length >= 3 &&
        heapSamples.every(
          (s, idx) =>
            idx === 0 || s.heapUsedMb > (heapSamples[idx - 1]?.heapUsedMb ?? 0),
        );
      const lastHeap = heapSamples[heapSamples.length - 1];
      const heapDeltaMb = round(
        (lastHeap?.heapUsedMb ?? 0) - baselineHeap.heapUsedMb,
      );
      const heapSlopeMeasurable = gcAvailable && heapSamples.length >= 3;
      const heapSlopeOk = !heapSlopeMeasurable
        ? true
        : !(monotone && slopePctPer100 > HEAP_SLOPE_LIMIT_PCT_PER_100);

      // ── Handles: per-kind count at the end vs baseline.
      const handleKinds = new Set([
        ...Object.keys(baselineHandles),
        ...Object.keys(lastHeap?.handles ?? {}),
      ]);
      const handleDelta: Record<string, number> = {};
      for (const kind of handleKinds) {
        handleDelta[kind] =
          (lastHeap?.handles[kind] ?? 0) - (baselineHandles[kind] ?? 0);
      }
      // Fake timers own every setTimeout; anything else growing is a leak.
      const handlesOk = Object.values(handleDelta).every(delta => delta <= 0);

      // ── Time drift: early vs late median mount + unmount.
      const window = Math.max(5, Math.floor(rows.length / 5));
      const early = rows.slice(0, window);
      const late = rows.slice(-window);
      const mountEarly = median(early.map(r => r.mountMs));
      const mountLate = median(late.map(r => r.mountMs));
      const unmountEarly = median(early.map(r => r.unmountMs));
      const unmountLate = median(late.map(r => r.unmountMs));
      const mountDriftRatio = mountEarly > 0 ? mountLate / mountEarly : 1;
      const unmountDriftRatio =
        unmountEarly > 0 ? unmountLate / unmountEarly : 1;
      const driftOk =
        rows.length < 20 ||
        (mountDriftRatio <= DRIFT_LIMIT_RATIO &&
          unmountDriftRatio <= DRIFT_LIMIT_RATIO);

      const finalCounts = snapshotCounts();
      const failedRows = rows.filter(r => !r.ok);
      const byInvariant: Record<string, { checked: number; failed: number }> =
        {};
      for (const row of rows) {
        for (const [name, held] of Object.entries(row.invariants)) {
          const slot = (byInvariant[name] ??= { checked: 0, failed: 0 });
          slot.checked += 1;
          if (!held) slot.failed += 1;
        }
      }
      const byAction: Record<string, number> = {};
      for (const row of rows)
        byAction[row.scenario.action] =
          (byAction[row.scenario.action] ?? 0) + 1;

      const campaign = {
        unit: 'scr-signinscreen',
        lens: 'long-run-leak',
        node: nodeProcess.version,
        gcAvailable,
        baseSeed: BASE_SEED,
        seedFilter: SEED_FILTER ?? null,
        screen: SCREEN_UNDER_TEST,
        actionFilter: ACTION_FILTER,
        exitFilter: EXIT_FILTER,
        iterationsRequested: seeds.length,
        iterationsExecuted: rows.length,
        warmupIterations: warmup.length,
        heapEvery: HEAP_EVERY,
        baseline: {
          counts: baseline,
          heap: baselineHeap,
          handles: baselineHandles,
        },
        final: { counts: finalCounts, heap: lastHeap, handleDelta },
        heap: {
          samples: heapSamples.map(s => ({
            iteration: s.iteration,
            heapUsedMb: s.heapUsedMb,
            heapTotalMb: s.heapTotalMb,
            rssMb: s.rssMb,
            timers: s.counts.timers,
            storeSubscriptions: s.counts.storeSubscriptions,
            emitters: s.counts.emitters,
            handles: s.handles,
          })),
          mbPerIteration: round(mbPerIteration),
          slopePctPer100Iterations: round(slopePctPer100),
          monotone,
          deltaMbBaselineToEnd: heapDeltaMb,
          measurable: heapSlopeMeasurable,
          limitPctPer100: HEAP_SLOPE_LIMIT_PCT_PER_100,
          ok: heapSlopeOk,
          snapshots: { baseline: snapshotBefore, final: snapshotAfter },
        },
        timing: {
          window,
          mountMedianEarlyMs: round(mountEarly),
          mountMedianLateMs: round(mountLate),
          mountDriftRatio: round(mountDriftRatio),
          unmountMedianEarlyMs: round(unmountEarly),
          unmountMedianLateMs: round(unmountLate),
          unmountDriftRatio: round(unmountDriftRatio),
          mountMaxMs: round(Math.max(0, ...rows.map(r => r.mountMs))),
          limitRatio: DRIFT_LIMIT_RATIO,
          ok: driftOk,
        },
        handles: { ok: handlesOk, delta: handleDelta },
        rows: {
          executed: rows.length,
          passed: rows.length - failedRows.length,
          failed: failedRows.length,
          byInvariant,
          byAction,
          failedSeeds: failedRows.map(r => ({
            seed: r.seed,
            iteration: r.iteration,
            failed: r.failed,
            scenario: r.scenario,
            observed: r.observed,
          })),
        },
        consoleErrors: { count: consoleErrorCount, first: consoleErrors },
        replay:
          'cd apps/mobile && STRESS_SEED_FILTER=<seed> npx jest --ci --runInBand __tests__/stress/signInScreen.longRunLeak.stress.test.tsx',
        generatedAt: new Date(realDateNow()).toISOString(),
      };

      const bisect = [
        SCREEN_UNDER_TEST !== 'signin' ? SCREEN_UNDER_TEST : null,
        ACTION_FILTER ? `actions-${ACTION_FILTER.join('+')}` : null,
        EXIT_FILTER ? `exits-${EXIT_FILTER.join('+')}` : null,
      ]
        .filter(Boolean)
        .join('-');
      const tag = `${SEED_FILTER ? `seed-${SEED_FILTER}` : `iter-${rows.length}`}${bisect ? `-${bisect}` : ''}`;
      const summaryFile = writeArtifact(`summary-${tag}.json`, campaign);
      const rowsFile = writeArtifact(`rows-${tag}.json`, {
        warmup,
        rows,
      });
      const seedTable = rows.map(r => ({
        seed: r.seed,
        iteration: r.iteration,
        action: r.scenario.action,
        exit: r.scenario.exit,
        dismissError: r.scenario.dismissError,
        settleMs: r.scenario.settleMs,
        mountMs: r.mountMs,
        unmountMs: r.unmountMs,
        outcome: r.ok ? 'HELD' : `BROKEN:${r.failed.join(',')}`,
      }));
      const seedFile = writeArtifact(`seeds-${tag}.json`, seedTable);
      const heapMd = [
        '| iteration | heapUsedMb | heapTotalMb | rssMb | timers | storeSubs | emitters | handles |',
        '|---|---|---|---|---|---|---|---|',
        ...heapSamples.map(
          s =>
            `| ${s.iteration} | ${s.heapUsedMb} | ${s.heapTotalMb} | ${s.rssMb} | ${s.counts.timers} | ${s.counts.storeSubscriptions} | ${JSON.stringify(s.counts.emitters)} | ${JSON.stringify(s.handles)} |`,
        ),
        '',
        `slope: ${round(mbPerIteration)} MB/iteration = ${round(slopePctPer100)} % of baseline heap per 100 iterations (monotone=${monotone}, gc=${gcAvailable})`,
        `timing: mount median early ${round(mountEarly)}ms → late ${round(mountLate)}ms (×${round(mountDriftRatio)}); unmount median early ${round(unmountEarly)}ms → late ${round(unmountLate)}ms (×${round(unmountDriftRatio)})`,
        '',
      ].join('\n');
      const heapFile = writeArtifact(`heap-${tag}.md`, heapMd);

      // Surface where the evidence went (visible without --silent).
      console.log(
        `[stress:scr-signinscreen:long-run-leak] ${rows.length} iterations, ${failedRows.length} failed rows, heap slope ${round(slopePctPer100)}%/100 (gc=${gcAvailable}), artifacts: ${summaryFile}, ${rowsFile}, ${seedFile}, ${heapFile}`,
      );

      expect(rows.length).toBe(seeds.length);
      expect(failedRows.map(r => ({ seed: r.seed, failed: r.failed }))).toEqual(
        [],
      );
      expect(finalCounts.timers).toBe(baseline.timers);
      expect(finalCounts.storeSubscriptions).toBe(baseline.storeSubscriptions);
      expect(finalCounts.emitters).toEqual(baseline.emitters);
      expect({ handlesOk, handleDelta }).toEqual({
        handlesOk: true,
        handleDelta,
      });
      expect({
        heapSlopeOk,
        monotone,
        slopePctPer100: round(slopePctPer100),
      }).toEqual({
        heapSlopeOk: true,
        monotone,
        slopePctPer100: round(slopePctPer100),
      });
      expect({ driftOk, mountDriftRatio, unmountDriftRatio }).toEqual({
        driftOk: true,
        mountDriftRatio,
        unmountDriftRatio,
      });
    },
    // 500 iterations × ~15 act() rounds each; generous so the campaign never
    // fails on wall-clock alone.
    Math.max(120_000, ITERATIONS * 2_000),
  );
});
