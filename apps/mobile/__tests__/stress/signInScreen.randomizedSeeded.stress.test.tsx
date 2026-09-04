/**
 * STRESS — unit `scr-signinscreen`, lens `randomized-seeded`.
 *
 * Seeded randomized long-run over the SignInScreen as the product composes
 * it: the REAL `App` (SafeAreaProvider → QueryClientProvider →
 * RootErrorBoundary → Gate) with the real WelcomeScreen, SignInScreen,
 * authStore, appStore, notification/consistency stores, apiSession,
 * sessionKeeper, accountScope and bootstrapCanonicalAccount. Only native
 * seams and the network are replaced:
 *   - `fetch`                              → scripted server (bootstrap answers
 *                                            are DEFERRED and resolved by actions)
 *   - `NativeModules.PickleAuth`           → deferred Apple sheet
 *   - `@react-native-google-signin`        → deferred Google sheet
 *   - `react-native-keychain`              → repo `__mocks__` in-memory Keychain
 *   - `src/data/db`                        → kv-backed FakeLocalDb (no SQLite)
 *   - `src/config/runtimeConfig|authConfig`→ test client ids / api base
 *   - `react-native-safe-area-context`     → passthrough views
 *   - RootNavigator / OnboardingScreen / SplashScreen → text markers (the
 *     screens the Gate swaps to AFTER sign-in are not the unit; the pre-auth
 *     SignInScreen is rendered by the Gate directly in production, not by
 *     the stack navigator).
 *
 * Every sequence is a pure function of its 32-bit seed: world parameters
 * (platform, provider availability, server profile, kv write faults) and a
 * 5–60 step action list drawn from the screen's public surface plus the
 * environment events that surround it:
 *   tap Continue with Apple / Continue with Google / Back / Dismiss sign-in
 *   error / I already have an account; resolve the pending provider sheet
 *   (success | cancel | failure | no-token); answer the pending bootstrap
 *   request (200 | 200-legacy-no-session | 401 | 403 | 500 | 429 | network |
 *   malformed | bad-account); advance the fake clock (incl. past the 15 s
 *   bootstrap abort); background/foreground; React remount of <App/>;
 *   process kill + cold relaunch; sign-out from the signed-in landing.
 *
 * Invariants (model-checked after EVERY step, once microtasks settle):
 *   busyMirrorsUi        store.busy ⇔ "Signing in securely…" shown ⇔ provider
 *                        buttons disabled (while the screen is mounted)
 *   busyExcludesError    busy ⇒ error === null
 *   busyLock             provider SDK invocations == taps accepted while idle
 *                        (a tap on a disabled button never reaches the SDK)
 *   errorCardMirrorsStore error card ⇔ error && code !== 'auth.canceled';
 *                        title NOT CONFIGURED YET ⇔ code auth.not_configured,
 *                        else SIGN-IN FAILED; message text rendered
 *   providerVisibility   Apple button ⇔ Platform.OS === 'ios'; Google always
 *   backAlwaysReachable  Back is rendered and enabled whenever SignIn shows
 *   sessionConsistency   session ⇔ apiSession (same canonical id) ⇔ active
 *                        data owner; no session ⇒ owner signed-out
 *   noTokenInKv          no id/access/refresh token string ever reaches kv
 *   vaultMirrorsSession  Keychain record ⇔ session with a refresh token
 *   gateMirrorsSession   session ⇒ Gate left the pre-auth screens; no session
 *                        ⇒ Welcome or SignIn (or Loading while hydrating)
 *   resolutionEffect     the outcome of each provider/server answer lands as
 *                        the predicted store state (see `predict`)
 *   noPendingLeak        busy ⇒ exactly one provider or bootstrap chain is
 *                        pending; idle ⇒ nothing pending
 *   noConsoleError       nothing logged through console.error during the step
 *   noThrow              no action threw out of React/act
 *   determinism          same seed twice ⇒ byte-identical trace
 *
 * Campaign size: STRESS_ITER (default 40 sequences, fast enough for the
 * suite). Replay one seed with STRESS_SEED=<n>. Artifacts (JSON table
 * seed → outcome, minimized failures, determinism report) are written to
 * STRESS_ARTIFACT_DIR or <repo>/artifacts/stress-signin-randomized-seeded/.
 *
 *   cd apps/mobile && STRESS_ITER=2000 npx jest --ci \
 *     __tests__/stress/signInScreen.randomizedSeeded.stress.test.tsx
 */
import React from 'react';
import { AppState, NativeModules, Platform, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { FakeLocalDb } from '../../xc-harness/lifecycle-persistence/fakeLocalDb';
import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import { makePrng } from '../../xc-harness/lifecycle-persistence/seeds';

// ─── Module seams ────────────────────────────────────────────────────────────

const mockDb = { current: new FakeLocalDb() };
jest.mock('../../src/data/db', () => ({
  getDb: () => mockDb.current.handle(),
}));

const API_BASE = 'https://api.example.test';
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
    legalPrivacyUrl: null,
    legalTermsUrl: null,
    appStoreId: null,
    appStoreWriteReviewUrl: null,
  }),
}));

/** Mutable so a sequence can model a build without Google client ids. */
const mockAuthConfig = {
  googleConfigured: true,
};
jest.mock('../../src/config/authConfig', () => ({
  get GOOGLE_IOS_CLIENT_ID() {
    return mockAuthConfig.googleConfigured
      ? 'test-ios-client.apps.googleusercontent.com'
      : null;
  },
  get GOOGLE_WEB_CLIENT_ID() {
    return mockAuthConfig.googleConfigured
      ? 'test-web-client.apps.googleusercontent.com'
      : null;
  },
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
}
function deferred<T>(): Deferred<T> {
  const d: Partial<Deferred<T>> = { settled: false };
  d.promise = new Promise<T>((resolve, reject) => {
    d.resolve = value => {
      d.settled = true;
      resolve(value);
    };
    d.reject = reason => {
      d.settled = true;
      reject(reason);
    };
  });
  return d as Deferred<T>;
}

type ProviderKind = 'apple' | 'google';
interface PendingProvider {
  kind: ProviderKind;
  proc: number;
  apple?: Deferred<AppleResult>;
  google?: Deferred<GoogleResponse>;
}
interface AppleResult {
  user: string;
  identityToken: string;
  authorizationCode?: string | null;
  email: string | null;
  givenName: string | null;
  familyName: string | null;
}
type GoogleResponse =
  | { type: 'cancelled'; data: null }
  | {
      type: 'success';
      data: {
        idToken: string | null;
        serverAuthCode: string | null;
        scopes: string[];
        user: {
          id: string;
          name: string | null;
          email: string;
          photo: string | null;
          familyName: string | null;
          givenName: string | null;
        };
      };
    };

const harness = {
  proc: 0,
  providerQueue: [] as PendingProvider[],
  providerCalls: [] as { kind: ProviderKind; proc: number }[],
  googleConfigureCalls: [] as Record<string, unknown>[],
  playServicesCalls: [] as Record<string, unknown>[],
  playServicesFail: false,
};

const mockGoogleSignin = {
  configure: jest.fn((options: Record<string, unknown>) => {
    harness.googleConfigureCalls.push(options);
  }),
  hasPlayServices: jest.fn(async (options: Record<string, unknown>) => {
    harness.playServicesCalls.push(options);
    if (harness.playServicesFail) {
      throw new Error('Play services unavailable (simulated)');
    }
    return true;
  }),
  signIn: jest.fn(() => {
    const d = deferred<GoogleResponse>();
    harness.providerQueue.push({
      kind: 'google',
      proc: harness.proc,
      google: d,
    });
    harness.providerCalls.push({ kind: 'google', proc: harness.proc });
    return d.promise;
  }),
  signInSilently: jest.fn(async () => {
    throw new Error('no silent google session (simulated)');
  }),
  hasPreviousSignIn: jest.fn(() => false),
  signOut: jest.fn(async () => {}),
  revokeAccess: jest.fn(async () => {}),
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: mockGoogleSignin,
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const passthrough = (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(View, null, props.children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    initialWindowMetrics: null,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
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

import * as Keychain from 'react-native-keychain';
import App from '../../App';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const keychainMock = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};
const VAULT_SERVICE = 'com.picklesensei.auth.session';

// ─── Scripted server ─────────────────────────────────────────────────────────

const CANONICAL_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const SERVER_EMAIL = 'pat@example.com';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface PendingBootstrap {
  deferred: Deferred<Response>;
  proc: number;
  bearer: string;
  aborted: boolean;
}

class ScriptedServer {
  readonly pendingBootstrap: PendingBootstrap[] = [];
  readonly bootstrapCalls: { proc: number; bearer: string }[] = [];
  readonly meCalls: number[] = [];
  readonly logoutCalls: number[] = [];
  readonly refreshCalls: string[] = [];
  readonly unexpected: string[] = [];
  profile: 'complete' | 'pending' = 'complete';
  private counter = 0;

  issueTokens(): {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  } {
    this.counter += 1;
    return {
      accessToken: `access-${this.counter}`,
      refreshToken: `refresh-${this.counter}`,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  readonly fetch = (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    if (url === `${API_BASE}/v1/account/bootstrap` && method === 'POST') {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const bearer = String(headers['Authorization'] ?? '').replace(
        /^Bearer /,
        '',
      );
      const d = deferred<Response>();
      const pending: PendingBootstrap = {
        deferred: d,
        proc: harness.proc,
        bearer,
        aborted: false,
      };
      this.pendingBootstrap.push(pending);
      this.bootstrapCalls.push({ proc: harness.proc, bearer });
      init.signal?.addEventListener('abort', () => {
        if (d.settled) return;
        pending.aborted = true;
        const index = this.pendingBootstrap.indexOf(pending);
        if (index >= 0) this.pendingBootstrap.splice(index, 1);
        const error = new Error('Aborted (simulated fetch abort)');
        error.name = 'AbortError';
        d.reject(error);
      });
      return d.promise;
    }
    if (url === `${API_BASE}/v1/me` && method === 'GET') {
      this.meCalls.push(Date.now());
      return Promise.resolve(
        jsonResponse(200, {
          onboardingState: this.profile,
          profile:
            this.profile === 'complete'
              ? {
                  skill_level: 'intermediate',
                  handedness: 'right',
                  primary_goal: 'consistency',
                  biggest_problem: 'popups',
                  first_name: 'Server',
                }
              : null,
        }),
      );
    }
    if (url === `${API_BASE}/v1/auth/refresh`) {
      const body = JSON.parse(String(init.body ?? '{}')) as {
        refreshToken?: string;
      };
      this.refreshCalls.push(String(body.refreshToken ?? ''));
      return Promise.resolve(
        jsonResponse(200, { session: this.issueTokens() }),
      );
    }
    if (url === `${API_BASE}/v1/auth/logout`) {
      this.logoutCalls.push(Date.now());
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    this.unexpected.push(`${method} ${url}`);
    return Promise.resolve(
      jsonResponse(404, { error: { message: 'unexpected route in harness' } }),
    );
  };
}

// ─── AppState plumbing ───────────────────────────────────────────────────────

const appStateListeners = new Set<(state: string) => void>();
function emitAppState(state: 'active' | 'background'): void {
  for (const listener of [...appStateListeners]) listener(state);
}

// ─── Scenario space ──────────────────────────────────────────────────────────

interface GenHints {
  providerPending: boolean;
  serverPending: boolean;
  session: boolean;
  busy: boolean;
  screen: Screen;
  errorVisible: boolean;
}

type TapTarget =
  'apple' | 'google' | 'back' | 'dismiss' | 'already-have-account';
type ProviderOutcome = 'success' | 'cancel' | 'failure' | 'no-token';
type ServerOutcome =
  | '200'
  | '200-legacy'
  | '401'
  | '403'
  | '500'
  | '429'
  | 'network'
  | 'malformed'
  | 'bad-account';

type Action =
  | { kind: 'tap'; target: TapTarget }
  | { kind: 'resolve-provider'; outcome: ProviderOutcome }
  | { kind: 'resolve-server'; outcome: ServerOutcome }
  | { kind: 'advance'; ms: number }
  | { kind: 'app-state'; state: 'background' | 'active' }
  | { kind: 'remount-ui' }
  | { kind: 'kill-relaunch' }
  | { kind: 'sign-out' };

interface World {
  os: 'ios' | 'android';
  appleNative: 'present' | 'missing';
  googleConfigured: boolean;
  playServicesFail: boolean;
  serverProfile: 'complete' | 'pending';
  /** kv writes of these keys throw (best-effort markers must not break sign-in). */
  kvWriteFaults: string[];
  /** legacy silent-restore flag left by a pre-vault build */
  staleGoogleFlag: boolean;
}

/** Where the runner gets its i-th action: a seeded generator or a fixed list. */
interface ActionSource {
  length: number;
  at(index: number, hints: GenHints): Action;
}

interface Scenario {
  seed: number;
  world: World;
  actions: ActionSource;
}

const TAP_TARGETS: readonly TapTarget[] = [
  'apple',
  'google',
  'back',
  'dismiss',
  'already-have-account',
];
const PROVIDER_OUTCOMES: readonly ProviderOutcome[] = [
  'success',
  'success',
  'success',
  'cancel',
  'failure',
  'no-token',
];
const SERVER_OUTCOMES: readonly ServerOutcome[] = [
  '200',
  '200',
  '200',
  '200-legacy',
  '401',
  '403',
  '500',
  '429',
  'network',
  'malformed',
  'bad-account',
];
const ADVANCE_MS: readonly number[] = [0, 1, 50, 250, 1_000, 5_000, 16_000];

function pickFrom<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.floor(rng() * items.length);
  return items[Math.min(index, items.length - 1)] as T;
}

function worldFromRng(rng: () => number): World {
  const faults: string[] = [];
  if (rng() < 0.1) faults.push('auth.last-provider');
  if (rng() < 0.05) faults.push('auth.local-mode');
  return {
    os: rng() < 0.85 ? 'ios' : 'android',
    appleNative: rng() < 0.9 ? 'present' : 'missing',
    googleConfigured: rng() >= 0.1,
    playServicesFail: rng() < 0.05,
    serverProfile: rng() < 0.7 ? 'complete' : 'pending',
    kvWriteFaults: faults,
    staleGoogleFlag: rng() < 0.15,
  };
}

/**
 * Draws the next action. The generator is state-aware only through the
 * `hints` snapshot (what is pending / whether a session exists) so the
 * sequence stays mostly legal — a fraction of draws ignore the hints on
 * purpose and produce near-legal no-ops (resolving nothing, tapping a
 * control that is not on screen).
 */
function drawAction(rng: () => number, hints: GenHints): Action {
  const blind = rng() < 0.08;
  if (!blind) {
    // Steer back onto the unit: the Gate parks on Welcome after Back or a
    // relaunch, and the screen's own affordances deserve extra weight.
    if (hints.screen === 'welcome' && rng() < 0.6) {
      return { kind: 'tap', target: 'already-have-account' };
    }
    if (hints.serverPending && rng() < 0.15) {
      return { kind: 'advance', ms: 16_000 };
    }
    if (hints.errorVisible && rng() < 0.3) {
      return { kind: 'tap', target: 'dismiss' };
    }
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const r = rng();
    let action: Action;
    if (r < 0.34) {
      action = { kind: 'tap', target: pickFrom(rng, TAP_TARGETS) };
    } else if (r < 0.52) {
      action = {
        kind: 'resolve-provider',
        outcome: pickFrom(rng, PROVIDER_OUTCOMES),
      };
    } else if (r < 0.7) {
      action = {
        kind: 'resolve-server',
        outcome: pickFrom(rng, SERVER_OUTCOMES),
      };
    } else if (r < 0.82) {
      action = { kind: 'advance', ms: pickFrom(rng, ADVANCE_MS) };
    } else if (r < 0.88) {
      action = {
        kind: 'app-state',
        state: rng() < 0.5 ? 'background' : 'active',
      };
    } else if (r < 0.92) {
      action = { kind: 'remount-ui' };
    } else if (r < 0.945) {
      action = { kind: 'kill-relaunch' };
    } else {
      action = { kind: 'sign-out' };
    }
    if (blind) return action;
    if (action.kind === 'resolve-provider' && !hints.providerPending) continue;
    if (action.kind === 'resolve-server' && !hints.serverPending) continue;
    if (action.kind === 'sign-out' && !hints.session) continue;
    if (
      action.kind === 'kill-relaunch' &&
      (hints.busy || hints.providerPending || hints.serverPending)
    ) {
      continue;
    }
    return action;
  }
  return { kind: 'advance', ms: 50 };
}

function scenarioLength(rng: () => number): number {
  return 5 + Math.floor(rng() * 56); // 5..60
}

// ─── Rendering helpers ───────────────────────────────────────────────────────

type Renderer = ReturnType<typeof TestRenderer.create>;

function isPressableElement(node: TestRenderer.ReactTestInstance): boolean {
  return (
    typeof node.type !== 'string' &&
    typeof node.props['onPress'] === 'function' &&
    typeof node.props['accessibilityRole'] === 'string'
  );
}

function pressables(
  renderer: Renderer | null,
  label: string,
): TestRenderer.ReactTestInstance[] {
  if (!renderer) return [];
  const matches = renderer.root
    .findAll(isPressableElement)
    .filter(node => node.props['accessibilityLabel'] === label);
  // PressableScale forwards role + label to the Pressable it renders, so a
  // control appears as an outer/inner pair: keep the innermost element only.
  const hasMatchingDescendant = (node: TestRenderer.ReactTestInstance) =>
    matches.some(other => {
      if (other === node) return false;
      let cursor = other.parent;
      while (cursor) {
        if (cursor === node) return true;
        cursor = cursor.parent;
      }
      return false;
    });
  return matches.filter(node => !hasMatchingDescendant(node));
}

function isDisabled(node: TestRenderer.ReactTestInstance): boolean {
  const state = node.props['accessibilityState'] as
    { disabled?: boolean } | undefined;
  return node.props['disabled'] === true || state?.disabled === true;
}

function allText(renderer: Renderer | null): string {
  if (!renderer) return '';
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props['children'] as unknown)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' | ');
}

const APPLE = 'Continue with Apple';
const GOOGLE = 'Continue with Google';
const BACK = 'Back';
const DISMISS = 'Dismiss sign-in error';
const ALREADY = 'I already have an account';

type Screen =
  | 'signin'
  | 'welcome'
  | 'loading'
  | 'root'
  | 'onboarding'
  | 'error'
  | 'unmounted'
  | 'unknown';

function currentScreen(renderer: Renderer | null): Screen {
  if (!renderer) return 'unmounted';
  const text = allText(renderer);
  const markers: Screen[] = [];
  if (pressables(renderer, GOOGLE).length > 0 || text.includes('Your ratings,'))
    markers.push('signin');
  if (pressables(renderer, ALREADY).length > 0) markers.push('welcome');
  if (text.includes('ROOT_NAVIGATOR')) markers.push('root');
  if (text.includes('ONBOARDING')) markers.push('onboarding');
  if (
    text.includes('Getting things ready') ||
    text.includes('Loading your account')
  )
    markers.push('loading');
  if (text.includes('couldn’t load') || text.includes('Something went wrong'))
    markers.push('error');
  if (markers.length === 1) return markers[0] as Screen;
  return 'unknown';
}

// ─── Model / snapshot ────────────────────────────────────────────────────────

interface Snapshot {
  screen: Screen;
  busy: boolean;
  error: string | null;
  errorCardTitle: string | null;
  session: string | null;
  apiSession: string | null;
  owner: string;
  vault: boolean;
  providerPending: number;
  serverPending: number;
  providerCalls: number;
  bootstrapCalls: number;
  appleVisible: boolean;
  googleVisible: boolean;
  appleDisabled: boolean | null;
  googleDisabled: boolean | null;
  backPresent: boolean;
  lastProviderKv: string | null;
  kvKeys: string[];
}

function snapshot(renderer: Renderer | null, server: ScriptedServer): Snapshot {
  const auth = useAuthStore.getState();
  const api = getApiSession();
  const apple = pressables(renderer, APPLE);
  const google = pressables(renderer, GOOGLE);
  const text = allText(renderer);
  const errorCard = pressables(renderer, DISMISS);
  return {
    screen: currentScreen(renderer),
    busy: auth.busy,
    error: auth.error ? auth.error.code : null,
    errorCardTitle:
      errorCard.length === 0
        ? null
        : text.includes('NOT CONFIGURED YET')
          ? 'NOT CONFIGURED YET'
          : text.includes('SIGN-IN FAILED')
            ? 'SIGN-IN FAILED'
            : 'card-without-title',
    session: auth.session
      ? `${auth.session.provider}:${auth.session.canonicalAppUserId ?? '-'}`
      : null,
    apiSession: api ? `${api.provider}:${api.canonicalAppUserId}` : null,
    owner: getActiveDataOwner(),
    vault: keychainMock.__keychainStore.has(VAULT_SERVICE),
    providerPending: harness.providerQueue.filter(p => p.proc === harness.proc)
      .length,
    serverPending: server.pendingBootstrap.filter(p => p.proc === harness.proc)
      .length,
    providerCalls: harness.providerCalls.length,
    bootstrapCalls: server.bootstrapCalls.length,
    appleVisible: apple.length > 0,
    googleVisible: google.length > 0,
    appleDisabled: apple[0] ? isDisabled(apple[0]) : null,
    googleDisabled: google[0] ? isDisabled(google[0]) : null,
    backPresent: pressables(renderer, BACK).some(node => !isDisabled(node)),
    lastProviderKv: mockDb.current.kv.get('auth.last-provider') ?? null,
    kvKeys: [...mockDb.current.kv.keys()].sort(),
  };
}

interface Prediction {
  /** which action produced this prediction */
  from: string;
  busy: boolean;
  error: string | null;
  session: ProviderKind | null;
  serverPendingDelta: number;
  /** text the error card must show (server messages surface verbatim) */
  message?: string;
}

interface StepRecord {
  i: number;
  action: Action;
  effect: string;
  after: Snapshot;
  failed: string[];
  consoleErrors: string[];
}

interface SequenceResult {
  seed: number;
  world: World;
  steps: number;
  ok: boolean;
  failedInvariants: string[];
  firstFailureStep: number | null;
  trace: StepRecord[];
  actionsExecuted: Action[];
  /** effect label → occurrences (what the sequence really exercised) */
  effects: Record<string, number>;
  /** screens observed after steps */
  screens: Record<string, number>;
  durationMs: number;
  unexpectedRoutes: string[];
}

const TOKEN_PATTERN = /(id-token-|access-\d|refresh-\d|apple-authz-)/;

// ─── Process / world reset ───────────────────────────────────────────────────

function resetProcessState(): void {
  clearSyncRuntime();
  stopSessionKeeper();
  clearApiSession();
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
    onboardingBusy: false,
    onboardingError: null,
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
  useWalkthroughStore.setState({ visible: false, queued: false });
}

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

// ─── Sequence runner ─────────────────────────────────────────────────────────

const nativeModules = NativeModules as {
  PickleAuth?: { signInWithApple: () => Promise<AppleResult> };
};

function installApple(present: boolean): void {
  if (!present) {
    delete nativeModules.PickleAuth;
    return;
  }
  nativeModules.PickleAuth = {
    signInWithApple: () => {
      const d = deferred<AppleResult>();
      harness.providerQueue.push({
        kind: 'apple',
        proc: harness.proc,
        apple: d,
      });
      harness.providerCalls.push({ kind: 'apple', proc: harness.proc });
      return d.promise;
    },
  };
}

async function runSequence(
  scenario: Scenario,
  options: { recordTrace: boolean },
): Promise<SequenceResult> {
  const startedWall = realNow();
  const { world } = scenario;
  jest.setSystemTime(new Date('2026-03-01T09:00:00.000Z'));

  // World.
  const db = new FakeLocalDb();
  db.faults = { kvSetThrows: new Set(world.kvWriteFaults) };
  if (world.staleGoogleFlag) {
    db.kv.set(
      'auth.last-provider',
      JSON.stringify({ version: 1, provider: 'google' }),
    );
  }
  mockDb.current = db;
  keychainMock.__keychainStore.clear();
  harness.providerQueue.length = 0;
  harness.providerCalls.length = 0;
  for (const fn of Object.values(mockGoogleSignin)) fn.mockClear();
  harness.googleConfigureCalls.length = 0;
  harness.playServicesCalls.length = 0;
  harness.playServicesFail = world.playServicesFail;
  harness.proc += 1;
  mockAuthConfig.googleConfigured = world.googleConfigured;
  installApple(world.appleNative === 'present');
  const platform = jest.replaceProperty(Platform, 'OS', world.os);
  const server = new ScriptedServer();
  server.profile = world.serverProfile;
  (globalThis as { fetch: unknown }).fetch = server.fetch;
  resetProcessState();

  const consoleErrors: string[] = [];
  const consoleSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(a => String(a)).join(' '));
    });

  let renderer: Renderer | null = null;
  const mount = () => {
    act(() => {
      renderer = TestRenderer.create(<App />);
    });
  };
  const unmount = () => {
    const current = renderer;
    renderer = null;
    if (!current) return;
    act(() => {
      current.unmount();
    });
  };

  const trace: StepRecord[] = [];
  const actionsExecuted: Action[] = [];
  const failedInvariants = new Set<string>();
  let firstFailureStep: number | null = null;
  let acceptedTaps = 0;
  let prediction: Prediction | null = null;
  // The model's view of what the last provider tap started.
  let activeProvider: ProviderKind | null = null;

  const fail = (step: number, name: string) => {
    failedInvariants.add(name);
    if (firstFailureStep === null) firstFailureStep = step;
  };

  const check = (step: number, before: Snapshot, after: Snapshot): string[] => {
    const failed: string[] = [];
    const auth = useAuthStore.getState();
    const api = getApiSession();
    const onSignIn = after.screen === 'signin';

    // busyMirrorsUi
    if (onSignIn) {
      const text = allText(renderer);
      const busyText = text.includes('Signing in securely…');
      if (busyText !== after.busy) failed.push('busyMirrorsUi');
      if (after.googleDisabled !== after.busy) failed.push('busyMirrorsUi');
      if (after.appleVisible && after.appleDisabled !== after.busy)
        failed.push('busyMirrorsUi');
    }
    // busyExcludesError
    if (after.busy && auth.error) failed.push('busyExcludesError');
    // busyLock
    if (after.providerCalls !== acceptedTaps) failed.push('busyLock');
    // errorCardMirrorsStore
    if (onSignIn) {
      const shouldShow = Boolean(
        auth.error && auth.error.code !== 'auth.canceled',
      );
      const shows = after.errorCardTitle !== null;
      if (shouldShow !== shows) failed.push('errorCardMirrorsStore');
      if (shows && auth.error) {
        const expectedTitle =
          auth.error.code === 'auth.not_configured'
            ? 'NOT CONFIGURED YET'
            : 'SIGN-IN FAILED';
        if (after.errorCardTitle !== expectedTitle)
          failed.push('errorCardMirrorsStore');
        if (!allText(renderer).includes(auth.error.message))
          failed.push('errorCardMirrorsStore');
      }
    } else if (
      after.screen !== 'loading' &&
      after.screen !== 'unknown' &&
      after.errorCardTitle !== null
    ) {
      failed.push('errorCardMirrorsStore');
    }
    // providerVisibility
    if (onSignIn) {
      if (after.appleVisible !== (world.os === 'ios'))
        failed.push('providerVisibility');
      if (!after.googleVisible) failed.push('providerVisibility');
    }
    // backAlwaysReachable
    if (onSignIn && !after.backPresent) failed.push('backAlwaysReachable');
    // sessionConsistency
    if (auth.session && auth.session.canonicalAppUserId) {
      const id = auth.session.canonicalAppUserId;
      if (!api || api.canonicalAppUserId !== id)
        failed.push('sessionConsistency');
      if (after.owner !== canonicalDataOwner(id))
        failed.push('sessionConsistency');
    } else if (!auth.session) {
      // A pending chain may have installed nothing yet; idle ⇒ fully cleared.
      if (api) failed.push('sessionConsistency');
      if (after.owner !== SIGNED_OUT_DATA_OWNER)
        failed.push('sessionConsistency');
    }
    // noTokenInKv
    for (const value of db.kv.values()) {
      if (TOKEN_PATTERN.test(value)) {
        failed.push('noTokenInKv');
        break;
      }
    }
    for (const write of db.kvWrites()) {
      if (TOKEN_PATTERN.test(write.value)) {
        failed.push('noTokenInKv');
        break;
      }
    }
    // vaultMirrorsSession
    const hasRefresh = Boolean(api?.refreshToken);
    if (after.vault !== (Boolean(auth.session) && hasRefresh))
      failed.push('vaultMirrorsSession');
    // gateMirrorsSession (only meaningful while mounted and settled)
    if (renderer && after.screen !== 'loading' && after.screen !== 'unknown') {
      if (
        auth.session &&
        (after.screen === 'signin' || after.screen === 'welcome')
      )
        failed.push('gateMirrorsSession');
      if (
        !auth.session &&
        (after.screen === 'root' || after.screen === 'onboarding')
      )
        failed.push('gateMirrorsSession');
      if (auth.session) {
        const expected =
          world.serverProfile === 'complete' ? 'root' : 'onboarding';
        if (after.screen !== expected && after.screen !== 'error')
          failed.push('gateMirrorsSession');
      }
    }
    if (renderer && after.screen === 'unknown')
      failed.push('gateMirrorsSession');
    // noPendingLeak
    const pending = after.providerPending + after.serverPending;
    if (after.busy && pending !== 1) failed.push('noPendingLeak');
    if (!after.busy && pending !== 0) failed.push('noPendingLeak');
    // resolutionEffect
    if (prediction) {
      const p = prediction;
      if (after.busy !== p.busy) failed.push('resolutionEffect');
      if (after.error !== p.error) failed.push('resolutionEffect');
      const sessionProvider = auth.session?.provider ?? null;
      if (sessionProvider !== p.session) failed.push('resolutionEffect');
      if (after.serverPending - before.serverPending !== p.serverPendingDelta)
        failed.push('resolutionEffect');
      if (p.message && auth.error && auth.error.message !== p.message)
        failed.push('resolutionEffect');
      prediction = null;
    }
    return failed;
  };

  const step = async (i: number, action: Action): Promise<void> => {
    const before = snapshot(renderer, server);
    consoleErrors.length = 0;
    let effect = 'noop';
    let threw: string | null = null;
    try {
      switch (action.kind) {
        case 'tap': {
          const label =
            action.target === 'apple'
              ? APPLE
              : action.target === 'google'
                ? GOOGLE
                : action.target === 'back'
                  ? BACK
                  : action.target === 'dismiss'
                    ? DISMISS
                    : ALREADY;
          const nodes = pressables(renderer, label);
          if (nodes.length === 0) {
            effect = 'absent';
            break;
          }
          if (nodes.length > 1) {
            effect = `duplicate-control:${nodes.length}`;
            fail(i, 'duplicateControl');
            break;
          }
          const node = nodes[0] as TestRenderer.ReactTestInstance;
          if (isDisabled(node)) {
            effect = 'ignored-disabled';
            break;
          }
          const wasBusy = useAuthStore.getState().busy;
          await act(async () => {
            (node.props['onPress'] as () => void)();
          });
          effect = 'pressed';
          if (action.target === 'apple' || action.target === 'google') {
            if (wasBusy) {
              // A rendered-enabled button while busy is itself a
              // busyMirrorsUi failure; the store lock still refuses it.
              effect = 'pressed-while-busy';
            } else if (action.target === 'apple') {
              if (world.appleNative === 'present') {
                acceptedTaps += 1;
                activeProvider = 'apple';
                effect = 'apple-sheet-opened';
              } else {
                effect = 'apple-not-configured';
                prediction = {
                  from: 'tap-apple-missing-native',
                  busy: false,
                  error: 'auth.not_configured',
                  session: null,
                  serverPendingDelta: 0,
                };
              }
            } else if (!world.googleConfigured) {
              effect = 'google-not-configured';
              prediction = {
                from: 'tap-google-unconfigured',
                busy: false,
                error: 'auth.not_configured',
                session: null,
                serverPendingDelta: 0,
              };
            } else if (world.playServicesFail) {
              effect = 'google-play-services-failed';
              prediction = {
                from: 'tap-google-play-services',
                busy: false,
                error: 'auth.failed',
                session: null,
                serverPendingDelta: 0,
                message: 'Play services unavailable (simulated)',
              };
            } else {
              acceptedTaps += 1;
              activeProvider = 'google';
              effect = 'google-sheet-opened';
            }
          }
          break;
        }
        case 'resolve-provider': {
          const pending = harness.providerQueue.find(
            p => p.proc === harness.proc,
          );
          if (!pending) {
            effect = 'nothing-pending';
            break;
          }
          harness.providerQueue.splice(
            harness.providerQueue.indexOf(pending),
            1,
          );
          const token = `id-token-${scenario.seed}-${i}`;
          await act(async () => {
            if (pending.kind === 'apple' && pending.apple) {
              const d = pending.apple;
              switch (action.outcome) {
                case 'success':
                  d.resolve({
                    user: 'apple-sub-001',
                    identityToken: token,
                    authorizationCode: `apple-authz-${i}`,
                    email: 'pat@privaterelay.example',
                    givenName: 'Pat',
                    familyName: 'Player',
                  });
                  break;
                case 'cancel': {
                  const error = new Error('Sign-in canceled.') as Error & {
                    code: string;
                  };
                  error.code = 'auth.canceled';
                  d.reject(error);
                  break;
                }
                case 'failure':
                  d.reject(new Error('ASAuthorizationError 1000 (simulated)'));
                  break;
                case 'no-token':
                  d.resolve({
                    user: 'apple-sub-001',
                    identityToken: '',
                    authorizationCode: null,
                    email: null,
                    givenName: null,
                    familyName: null,
                  });
                  break;
              }
            } else if (pending.google) {
              const d = pending.google;
              const user = {
                id: 'google-uid-1',
                name: 'Pat Player',
                email: 'pat@gmail.example',
                photo: null,
                familyName: 'Player',
                givenName: 'Pat',
              };
              switch (action.outcome) {
                case 'success':
                  d.resolve({
                    type: 'success',
                    data: {
                      idToken: token,
                      serverAuthCode: null,
                      scopes: [],
                      user,
                    },
                  });
                  break;
                case 'cancel':
                  d.resolve({ type: 'cancelled', data: null });
                  break;
                case 'failure':
                  d.reject(new Error('Google sign-in failed (simulated)'));
                  break;
                case 'no-token':
                  d.resolve({
                    type: 'success',
                    data: {
                      idToken: null,
                      serverAuthCode: null,
                      scopes: [],
                      user,
                    },
                  });
                  break;
              }
            }
          });
          await flush(0);
          effect = `${pending.kind}:${action.outcome}`;
          switch (action.outcome) {
            case 'success':
              prediction = {
                from: effect,
                busy: true,
                error: null,
                session: null,
                serverPendingDelta: 1,
              };
              break;
            case 'cancel':
              prediction = {
                from: effect,
                busy: false,
                error: 'auth.canceled',
                session: null,
                serverPendingDelta: 0,
              };
              break;
            case 'failure':
              prediction = {
                from: effect,
                busy: false,
                error: 'auth.failed',
                session: null,
                serverPendingDelta: 0,
                message:
                  pending.kind === 'apple'
                    ? 'ASAuthorizationError 1000 (simulated)'
                    : 'Google sign-in failed (simulated)',
              };
              break;
            case 'no-token':
              prediction = {
                from: effect,
                busy: false,
                error: 'auth.failed',
                session: null,
                serverPendingDelta: 0,
                message:
                  'The identity provider did not return a token for secure account setup.',
              };
              break;
          }
          break;
        }
        case 'resolve-server': {
          const pending = server.pendingBootstrap.find(
            p => p.proc === harness.proc,
          );
          if (!pending) {
            effect = 'nothing-pending';
            break;
          }
          server.pendingBootstrap.splice(
            server.pendingBootstrap.indexOf(pending),
            1,
          );
          const provider = activeProvider;
          await act(async () => {
            const d = pending.deferred;
            switch (action.outcome) {
              case '200':
                d.resolve(
                  jsonResponse(200, {
                    user: { id: CANONICAL_ID, email: SERVER_EMAIL },
                    onboardingState: 'complete',
                    session: server.issueTokens(),
                  }),
                );
                break;
              case '200-legacy':
                d.resolve(
                  jsonResponse(200, {
                    user: { id: CANONICAL_ID, email: SERVER_EMAIL },
                    onboardingState: 'complete',
                  }),
                );
                break;
              case '401':
                d.resolve(
                  jsonResponse(401, { error: { message: 'Token rejected.' } }),
                );
                break;
              case '403':
                d.resolve(
                  jsonResponse(403, { error: { message: 'Forbidden.' } }),
                );
                break;
              case '500':
                d.resolve(
                  jsonResponse(500, { error: { message: 'Server error.' } }),
                );
                break;
              case '429':
                d.resolve(
                  jsonResponse(429, { error: { message: 'Slow down.' } }),
                );
                break;
              case 'network':
                d.reject(new TypeError('Network request failed'));
                break;
              case 'malformed':
                d.resolve(
                  new Response('<html>not json</html>', { status: 200 }),
                );
                break;
              case 'bad-account':
                d.resolve(
                  jsonResponse(200, {
                    user: { id: 'not-a-uuid', email: SERVER_EMAIL },
                    onboardingState: 'complete',
                  }),
                );
                break;
            }
          });
          // Bootstrap → installApiSession → appStore re-hydrate for the new
          // owner (GET /v1/me) → Gate swap. Let it all settle.
          await flush(0);
          await flush(50);
          effect = `server:${action.outcome}`;
          const failed = (message: string): Prediction => ({
            from: effect,
            busy: false,
            error: 'auth.failed',
            session: null,
            serverPendingDelta: -1,
            message,
          });
          switch (action.outcome) {
            case '200':
            case '200-legacy':
              prediction = {
                from: effect,
                busy: false,
                error: null,
                session: provider,
                serverPendingDelta: -1,
              };
              break;
            case '401':
              prediction = failed('Token rejected.');
              break;
            case '403':
              prediction = failed('Forbidden.');
              break;
            case '500':
              prediction = failed('Server error.');
              break;
            case '429':
              prediction = failed('Slow down.');
              break;
            case 'network':
              prediction = failed(
                'Secure account setup is temporarily unavailable.',
              );
              break;
            case 'malformed':
              prediction = failed(
                'The account server returned an unreadable response.',
              );
              break;
            case 'bad-account':
              prediction = failed(
                'The account server returned invalid canonical account data.',
              );
              break;
          }
          break;
        }
        case 'advance': {
          const hadServerPending = server.pendingBootstrap.some(
            p => p.proc === harness.proc,
          );
          await flush(action.ms);
          effect = `advanced:${action.ms}`;
          if (hadServerPending && action.ms >= 15_000) {
            // The client's own 15 s AbortController ends the request.
            effect = 'bootstrap-timeout';
            prediction = {
              from: effect,
              busy: false,
              error: 'auth.failed',
              session: null,
              serverPendingDelta: -1,
              message: 'Secure account setup is temporarily unavailable.',
            };
          }
          break;
        }
        case 'app-state': {
          await act(async () => {
            emitAppState(action.state);
          });
          await flush(0);
          effect = `app-state:${action.state}`;
          break;
        }
        case 'remount-ui': {
          unmount();
          await flush(0);
          mount();
          await flush(0);
          effect = 'remounted';
          break;
        }
        case 'kill-relaunch': {
          const pendingNow =
            harness.providerQueue.some(p => p.proc === harness.proc) ||
            server.pendingBootstrap.some(p => p.proc === harness.proc);
          if (pendingNow || useAuthStore.getState().busy) {
            effect = 'skipped-inflight';
            break;
          }
          const hadSession = Boolean(useAuthStore.getState().session);
          unmount();
          resetProcessState();
          harness.proc += 1;
          acceptedTaps = harness.providerCalls.length;
          activeProvider = null;
          mount();
          await flush(0);
          await flush(100);
          effect = hadSession
            ? 'relaunched-with-vault'
            : 'relaunched-signed-out';
          break;
        }
        case 'sign-out': {
          if (!useAuthStore.getState().session) {
            effect = 'not-signed-in';
            break;
          }
          await act(async () => {
            await useAuthStore.getState().signOut();
          });
          await flush(0);
          effect = 'signed-out';
          prediction = {
            from: effect,
            busy: false,
            error: null,
            session: null,
            serverPendingDelta: 0,
          };
          break;
        }
      }
    } catch (error) {
      threw =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
    }
    // Let whatever the action started settle before judging the world.
    try {
      await flush(0);
    } catch (error) {
      threw = threw ?? (error instanceof Error ? error.message : String(error));
    }
    actionsExecuted.push(action);
    const after = snapshot(renderer, server);
    const failed = check(i, before, after);
    if (threw) failed.push('noThrow');
    if (consoleErrors.length > 0) failed.push('noConsoleError');
    for (const name of new Set(failed)) fail(i, name);
    trace.push({
      i,
      action,
      effect: threw ? `${effect} THREW ${threw}` : effect,
      after,
      failed: [...new Set(failed)],
      consoleErrors: [...consoleErrors],
    });
  };

  // ── Launch: cold start on Welcome, then the returning-player link.
  mount();
  await flush(0);
  await flush(100);
  const launchScreen = currentScreen(renderer);
  if (launchScreen !== 'welcome') {
    fail(-1, 'launchLandsOnWelcome');
    trace.push({
      i: -1,
      action: { kind: 'advance', ms: 100 },
      effect: `launch:${launchScreen}`,
      after: snapshot(renderer, server),
      failed: ['launchLandsOnWelcome'],
      consoleErrors: [...consoleErrors],
    });
  } else {
    await step(-1, { kind: 'tap', target: 'already-have-account' });
    if (currentScreen(renderer) !== 'signin')
      fail(-1, 'alreadyHaveAccountOpensSignIn');
  }

  for (let i = 0; i < scenario.actions.length; i += 1) {
    const action = scenario.actions.at(i, {
      providerPending: harness.providerQueue.some(p => p.proc === harness.proc),
      serverPending: server.pendingBootstrap.some(p => p.proc === harness.proc),
      session: Boolean(useAuthStore.getState().session),
      busy: useAuthStore.getState().busy,
      screen: currentScreen(renderer),
      errorVisible: pressables(renderer, DISMISS).length > 0,
    });
    await step(i, action);
  }

  // ── Teardown. A sequence may end mid-flight (sheet open, bootstrap
  // pending); its never-answered promises stay inert, but the bootstrap's
  // 15 s abort timer would fire inside the NEXT sequence and write onto the
  // singleton store — the "process" ends here, so its timers die with it.
  unmount();
  resetProcessState();
  jest.clearAllTimers();
  consoleSpy.mockRestore();
  platform.restore();
  return {
    seed: scenario.seed,
    world,
    steps: scenario.actions.length,
    ok: failedInvariants.size === 0,
    failedInvariants: [...failedInvariants].sort(),
    firstFailureStep,
    trace: options.recordTrace ? trace : trace.filter(t => t.failed.length > 0),
    actionsExecuted,
    effects: trace.reduce<Record<string, number>>((acc, t) => {
      const key = t.effect.split(' THREW ')[0] as string;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    screens: trace.reduce<Record<string, number>>((acc, t) => {
      acc[t.after.screen] = (acc[t.after.screen] ?? 0) + 1;
      return acc;
    }, {}),
    durationMs: Math.round(realNow() - startedWall),
    unexpectedRoutes: [...server.unexpected],
  };
}

/**
 * The generator needs the live world to keep sequences mostly legal, so the
 * scenario is materialised WHILE running: each step draws the next action
 * from the seeded rng using a hint snapshot, then executes it. Replaying a
 * seed reproduces the same draws because every hint is itself a function of
 * the earlier (deterministic) steps; minimisation replays the RECORDED
 * action list against the same world instead.
 */
async function runSeed(
  seed: number,
  options: { recordTrace: boolean },
): Promise<SequenceResult> {
  const rng = makePrng(seed);
  const world = worldFromRng(rng);
  const length = scenarioLength(rng);
  const source: ActionSource = {
    length,
    at: (_index, hints) => drawAction(rng, hints),
  };
  return runSequence({ seed, world, actions: source }, options);
}

function fixedActions(actions: Action[]): ActionSource {
  return { length: actions.length, at: index => actions[index] as Action };
}

// ─── Minimisation (ddmin-lite over the recorded action list) ─────────────────

async function replay(
  seed: number,
  world: World,
  actions: Action[],
): Promise<SequenceResult> {
  return runSequence(
    { seed, world, actions: fixedActions(actions) },
    { recordTrace: false },
  );
}

async function minimize(
  failing: SequenceResult,
): Promise<{ actions: Action[]; failedInvariants: string[]; replays: number }> {
  let current = failing.actionsExecuted.slice(
    0,
    (failing.firstFailureStep ?? failing.actionsExecuted.length - 1) + 1,
  );
  let replays = 0;
  const target = new Set(failing.failedInvariants);
  const stillFails = async (candidate: Action[]) => {
    replays += 1;
    const result = await replay(failing.seed, failing.world, candidate);
    return result.failedInvariants.some(name => target.has(name));
  };
  let chunk = Math.max(1, Math.floor(current.length / 2));
  while (current.length > 1 && chunk >= 1) {
    let reduced = false;
    for (let start = 0; start < current.length; start += chunk) {
      const candidate = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      if (candidate.length === 0) continue;
      if (await stillFails(candidate)) {
        current = candidate;
        reduced = true;
        break;
      }
    }
    if (!reduced) chunk = Math.floor(chunk / 2);
    if (replays > 400) break;
  }
  const final = await replay(failing.seed, failing.world, current);
  return {
    actions: current,
    failedInvariants: final.failedInvariants,
    replays,
  };
}

// ─── Artifacts ───────────────────────────────────────────────────────────────

function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(
          __dirname,
          '../../../../artifacts/stress-signin-randomized-seeded',
        );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function writeJson(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

function traceDigest(result: SequenceResult): string {
  return JSON.stringify(
    result.trace.map(t => ({
      i: t.i,
      action: t.action,
      effect: t.effect,
      after: t.after,
      failed: t.failed,
    })),
  );
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const ITER = Math.max(1, Number(nodeProcess.env['STRESS_ITER'] ?? '40') || 40);
const SEED_FILTER = nodeProcess.env['STRESS_SEED'];
const DETERMINISM_SAMPLE = Math.min(
  ITER,
  Math.max(10, Number(nodeProcess.env['STRESS_DETERMINISM'] ?? '50') || 50),
);
const BASE_SEED = 0x5157_0001;

const HEAP_SAMPLE_EVERY = 100;
const maybeGc = (globalThis as { gc?: () => void }).gc;

/** Heap after N sequences (forced GC when run with --expose-gc) plus the
 *  live-listener counts that would betray a per-sequence leak. */
function sampleHeap(sequences: number): Record<string, number> {
  maybeGc?.();
  return {
    sequences,
    heapUsedMb: Math.round(nodeProcess.memoryUsage().heapUsed / 1_048_576),
    appStateListeners: appStateListeners.size,
    fakeTimers: jest.getTimerCount(),
  };
}

const realFetch = globalThis.fetch;
const realRandom = Math.random;
/** Captured before fake timers install, so it keeps reading the real clock. */
const realDateNow = Date.now;
const realNow = (): number => realDateNow();
// @react-native/jest-preset installs `performance.now = jest.fn(Date.now)` and
// React's scheduler captures that object at load. A jest.fn records every
// call (args, result, order) and the scheduler makes hundreds per step —
// across 2000 sequences that is a multi-GB "leak" of mock bookkeeping.
(globalThis.performance as { now: () => number }).now = realNow;

beforeAll(() => {
  jest.useFakeTimers();
  // Plain replacement, not jest.spyOn: a spy records every call (args,
  // result, order) and the render path draws hundreds of times per step.
  Math.random = () => 0.5;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: (state: string) => void,
  ) => {
    appStateListeners.add(handler);
    return { remove: () => appStateListeners.delete(handler) };
  }) as unknown as typeof AppState.addEventListener);
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  delete nativeModules.PickleAuth;
  Math.random = realRandom;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('SignInScreen — seeded randomized long-run (real App/Gate/authStore)', () => {
  const seeds: number[] = SEED_FILTER
    ? [Number(SEED_FILTER)]
    : Array.from({ length: ITER }, (_, i) => (BASE_SEED + i * 7919) >>> 0);

  it(
    `runs ${seeds.length} seeded sequences and holds every invariant after every step`,
    async () => {
      const results: SequenceResult[] = [];
      const table: Record<string, unknown>[] = [];
      const heapSamples: Record<string, number>[] = [];
      let totalSteps = 0;
      for (const [index, seed] of seeds.entries()) {
        const result = await runSeed(seed, {
          recordTrace: Boolean(SEED_FILTER),
        });
        results.push(result);
        totalSteps += result.steps;
        if (index % HEAP_SAMPLE_EVERY === 0 || index === seeds.length - 1) {
          heapSamples.push(sampleHeap(index + 1));
        }
        table.push({
          seed: result.seed,
          steps: result.steps,
          ok: result.ok,
          failedInvariants: result.failedInvariants,
          firstFailureStep: result.firstFailureStep,
          world: result.world,
          durationMs: result.durationMs,
        });
      }

      const failing = results.filter(r => !r.ok);
      const minimized: Record<string, unknown>[] = [];
      for (const failure of failing.slice(0, 25)) {
        const reduced = await minimize(failure);
        // Flakiness probe: replay the minimized case 10×.
        let reproduced = 0;
        for (let k = 0; k < 10; k += 1) {
          const again = await replay(
            failure.seed,
            failure.world,
            reduced.actions,
          );
          if (!again.ok) reproduced += 1;
        }
        minimized.push({
          seed: failure.seed,
          world: failure.world,
          originalSteps: failure.steps,
          firstFailureStep: failure.firstFailureStep,
          failedInvariants: failure.failedInvariants,
          minimizedActions: reduced.actions,
          minimizedFailedInvariants: reduced.failedInvariants,
          replaysDuringMinimization: reduced.replays,
          reproducedOutOf10: reproduced,
          failingTrace: failure.trace,
        });
      }

      // Determinism: the first N seeds (and every failing seed) twice.
      const determinismSeeds = [
        ...seeds.slice(0, DETERMINISM_SAMPLE),
        ...failing.map(f => f.seed),
      ];
      const determinism: Record<string, unknown>[] = [];
      let nondeterministic = 0;
      for (const seed of new Set(determinismSeeds)) {
        const a = await runSeed(seed, { recordTrace: true });
        const b = await runSeed(seed, { recordTrace: true });
        const same = traceDigest(a) === traceDigest(b);
        if (!same) nondeterministic += 1;
        determinism.push({
          seed,
          identical: same,
          steps: a.steps,
          ...(same
            ? {}
            : {
                firstDivergence: a.trace.findIndex(
                  (t, idx) =>
                    JSON.stringify(t) !== JSON.stringify(b.trace[idx]),
                ),
              }),
        });
      }

      const summary = {
        unit: 'scr-signinscreen',
        lens: 'randomized-seeded',
        iterations: seeds.length,
        totalSteps,
        sequenceLengthRange: [5, 60],
        failingSeeds: failing.map(f => f.seed),
        failedInvariantCounts: failing.reduce<Record<string, number>>(
          (acc, f) => {
            for (const name of f.failedInvariants)
              acc[name] = (acc[name] ?? 0) + 1;
            return acc;
          },
          {},
        ),
        determinismChecked: determinism.length,
        nondeterministic,
        effectCounts: results.reduce<Record<string, number>>((acc, r) => {
          for (const [key, n] of Object.entries(r.effects))
            acc[key] = (acc[key] ?? 0) + n;
          return acc;
        }, {}),
        screenCounts: results.reduce<Record<string, number>>((acc, r) => {
          for (const [key, n] of Object.entries(r.screens))
            acc[key] = (acc[key] ?? 0) + n;
          return acc;
        }, {}),
        sequencesReachingSignedIn: results.filter(
          r => (r.screens['root'] ?? 0) + (r.screens['onboarding'] ?? 0) > 0,
        ).length,
        worldMix: {
          android: results.filter(r => r.world.os === 'android').length,
          appleMissing: results.filter(r => r.world.appleNative === 'missing')
            .length,
          googleUnconfigured: results.filter(r => !r.world.googleConfigured)
            .length,
          playServicesFail: results.filter(r => r.world.playServicesFail)
            .length,
          kvWriteFaults: results.filter(r => r.world.kvWriteFaults.length > 0)
            .length,
          staleGoogleFlag: results.filter(r => r.world.staleGoogleFlag).length,
          serverProfilePending: results.filter(
            r => r.world.serverProfile === 'pending',
          ).length,
        },
        wallMs: results.reduce((acc, r) => acc + r.durationMs, 0),
        heapSamples,
      };
      const files = [
        writeJson('seeds.json', table),
        writeJson('summary.json', summary),
        writeJson('minimized-failures.json', minimized),
        writeJson('determinism.json', determinism),
      ];
      if (SEED_FILTER) {
        files.push(
          writeJson(`trace-${SEED_FILTER}.json`, results[0]?.trace ?? []),
        );
      }
      console.log(
        `[stress scr-signinscreen] ${seeds.length} sequences / ${totalSteps} steps; ` +
          `failing=${failing.length} nondeterministic=${nondeterministic}; ` +
          `artifacts: ${files.join(', ')}`,
      );

      expect(nondeterministic).toBe(0);
      expect(
        failing.map(f => ({ seed: f.seed, failed: f.failedInvariants })),
      ).toEqual([]);
    },
    Math.max(60_000, seeds.length * 4_000),
  );
});
