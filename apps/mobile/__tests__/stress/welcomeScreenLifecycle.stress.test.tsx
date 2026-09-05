/**
 * STRESS — scr-welcomescreen / lens `lifecycle`.
 *
 * Mounts the REAL <App /> (SafeAreaProvider + QueryClientProvider +
 * RootErrorBoundary + Gate) with the REAL WelcomeScreen, SignInScreen,
 * OnboardingScreen, SplashScreen, design components, authStore, appStore,
 * notificationStore, consistencyStore, sessionKeeper, sessionLifecycle and
 * syncRuntime. Only process edges are faked: SQLite (FakeLocalDb), Keychain,
 * the native Apple sign-in sheet (NativeModules.PickleAuth), Google Sign-In,
 * the notification scheduler, AppState, react-native-svg, safe-area insets,
 * runtime config, and `fetch` (a scripted server for /v1/account/bootstrap,
 * /v1/me, /v1/auth/refresh, /v1/auth/logout). RootNavigator (the post-auth
 * stack WelcomeScreen never lives in) and the three post-auth overlays are
 * markers so the Gate's routing stays observable.
 *
 * Every iteration is a deterministic timeline derived from ONE seed:
 *   install ∈ {fresh, signed-out-kv, prior-user-vault-revoked,
 *              prior-user-stale-kv}
 *   → cold launch → k lifecycle steps from
 *     {background, foreground, permission-revoke, remount, kill-relaunch,
 *      second-hydrate, press-get-started, press-sign-in, back,
 *      apple-sign-in:A|B, cancel-native, sign-out, flip-server-ok}
 *   → settle → next-day cold relaunch → teardown.
 * with the bootstrap server in one of {ok, slow, refuse-401, error-500,
 * network, hang, malformed} and a short or long bearer TTL (so the session
 * keeper's rotation runs mid-timeline). Requests and native promises issued
 * by a process generation that was killed never settle (a dead process runs
 * no JS), which is how kill-mid-request is modelled.
 *
 * Invariants (each is a MatrixRow.invariants key) are documented next to
 * their computation in `runScenario`.
 *
 * Replay:  STRESS_SEED=<seed> npx jest --ci __tests__/stress/welcomeScreenLifecycle.stress.test.tsx
 * Campaign: STRESS_ITER=<n> [STRESS_SEED_START=<s>] npx jest --ci --detectOpenHandles __tests__/stress/welcomeScreenLifecycle.stress.test.tsx
 * Artifacts: $STRESS_ARTIFACT_DIR (default <repo>/artifacts/stress/welcomescreen-lifecycle)
 */
import React from 'react';
import {
  AccessibilityInfo,
  AppState,
  NativeModules,
  Pressable,
  Text,
} from 'react-native';
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
  makePrng,
  pick,
  validProfile,
  validVault,
} from '../../xc-harness/lifecycle-persistence/seeds';
import {
  heapSnapshot,
  type MatrixRow,
} from '../../xc-harness/lifecycle-persistence/artifacts';

declare const __dirname: string;
declare const require: (id: string) => unknown;

// ─── Module seams (native modules + fetch only) ─────────────────────────────

const mockDb = { current: new FakeLocalDb() };
jest.mock('../../src/data/db', () => ({
  getDb: () => mockDb.current.handle(),
}));

interface KeychainOp {
  op: 'get' | 'set' | 'reset';
  at: number;
  proc: number;
  token: string | null;
}
const mockKeychain = {
  store: new Map<string, { username: string; password: string }>(),
  log: [] as KeychainOp[],
  proc: 0,
  now: () => 0,
};
function mockVaultTokenOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { refreshToken?: unknown };
    return typeof parsed.refreshToken === 'string' ? parsed.refreshToken : null;
  } catch {
    return null;
  }
}
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
    mockKeychain.log.push({
      op: 'set',
      at: mockKeychain.now(),
      proc: mockKeychain.proc,
      token: mockVaultTokenOf(password),
    });
    mockKeychain.store.set(options.service ?? '__default__', {
      username,
      password,
    });
    return { service: options.service, storage: 'mock' };
  },
  getGenericPassword: async (options: { service?: string } = {}) => {
    mockKeychain.log.push({
      op: 'get',
      at: mockKeychain.now(),
      proc: mockKeychain.proc,
      token: null,
    });
    const item = mockKeychain.store.get(options.service ?? '__default__');
    if (!item) return false;
    return { service: options.service, storage: 'mock', ...item };
  },
  resetGenericPassword: async (options: { service?: string } = {}) => {
    mockKeychain.log.push({
      op: 'reset',
      at: mockKeychain.now(),
      proc: mockKeychain.proc,
      token: null,
    });
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
// Captured before the per-scenario console.error spy so verbose diagnostics
// bypass it (STRESS_VERBOSE=1).
const verbose: (line: string) => void = console.warn.bind(console);
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

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  permissionChecks = 0;
  applied: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  async permissionState(): Promise<PermissionState> {
    this.permissionChecks += 1;
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.applied.push([...plan]);
  }
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
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
  const R = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    R.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Polygon: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    RadialGradient: Mock,
    Stop: Mock,
    G: Mock,
    Ellipse: Mock,
    ClipPath: Mock,
    Mask: Mock,
    Text: Mock,
  };
});
jest.mock('../../src/navigation/RootNavigator', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    RootNavigator: () => R.createElement(RN.Text, null, 'ROOT_NAVIGATOR'),
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
import { WelcomeScreen } from '../../src/screens/WelcomeScreen';
import { SignInScreen } from '../../src/screens/SignInScreen';
import { OnboardingScreen } from '../../src/screens/OnboardingScreen';
import { SplashScreen } from '../../src/screens/SplashScreen';
import { ErrorState } from '../../src/design/components';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

// ─── Accounts ────────────────────────────────────────────────────────────────

interface Account {
  key: 'A' | 'B' | 'PRIOR';
  id: string;
  idToken: string;
  givenName: string;
  familyName: string;
  email: string;
  firstName: string;
}
const ACCOUNTS: Record<Account['key'], Account> = {
  A: {
    key: 'A',
    id: '11111111-1111-4111-8111-111111111111',
    idToken: 'id-token-A',
    givenName: 'Ava',
    familyName: 'Alpha',
    email: 'ava@example.test',
    firstName: 'Ava',
  },
  B: {
    key: 'B',
    id: '22222222-2222-4222-8222-222222222222',
    idToken: 'id-token-B',
    givenName: 'Bo',
    familyName: 'Beta',
    email: 'bo@example.test',
    firstName: 'Bo',
  },
  PRIOR: {
    key: 'PRIOR',
    id: '33333333-3333-4333-8333-333333333333',
    idToken: 'id-token-PRIOR',
    givenName: 'Pat',
    familyName: 'Player',
    email: 'pat@example.test',
    firstName: 'Pat',
  },
};
const ownerOf = (a: Account) => canonicalDataOwner(a.id);
/** Strings that must never appear on a signed-out screen. */
const IDENTITY_MARKERS = Object.values(ACCOUNTS).flatMap(a => [
  a.givenName,
  a.familyName,
  a.email,
  a.id,
]);

// ─── Scripted server ─────────────────────────────────────────────────────────

type BootstrapMode =
  'ok' | 'slow' | 'refuse-401' | 'error-500' | 'network' | 'hang' | 'malformed';
const BOOTSTRAP_MODES: readonly BootstrapMode[] = [
  'ok',
  'ok',
  'ok',
  'slow',
  'refuse-401',
  'error-500',
  'network',
  'hang',
  'malformed',
];

interface ServerCall {
  at: number;
  route: string;
  proc: number;
  account: string | null;
  /** auth.session owner when the request left the client (null = signed out) */
  sessionAtCall: string | null;
  outcome: string;
}

/**
 * Node's real `Response` reads its body through a stream whose completion
 * escapes the surrounding `act()` scope; this microtask-only stand-in keeps
 * every store update the app performs on a response inside `act`, so an
 * act() warning in the log is the app's, not the harness's.
 */
class FakeResponse {
  readonly headers: Headers;
  constructor(
    readonly status: number,
    private readonly body: string | null,
    contentType = 'application/json',
  ) {
    this.headers = new Headers(
      body === null ? {} : { 'Content-Type': contentType },
    );
  }
  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }
  async json(): Promise<unknown> {
    if (this.body === null)
      throw new SyntaxError('Unexpected end of JSON input');
    return JSON.parse(this.body) as unknown;
  }
  async text(): Promise<string> {
    return this.body ?? '';
  }
}
function jsonResponse(status: number, body: unknown): Response {
  return new FakeResponse(status, JSON.stringify(body)) as unknown as Response;
}
function rawResponse(
  status: number,
  body: string | null,
  contentType?: string,
): Response {
  return new FakeResponse(status, body, contentType) as unknown as Response;
}

class ScriptedServer {
  bootstrapMode: BootstrapMode = 'ok';
  latencyMs = 0;
  bearerTtlSec = 3600;
  /** Whether the seeded PRIOR account's refresh token is still honoured. */
  priorRefreshAccepted = false;
  onboardingState: Record<Account['key'], 'pending' | 'complete'> = {
    A: 'complete',
    B: 'complete',
    PRIOR: 'complete',
  };
  proc = 0;
  now: () => number = () => 0;
  sessionProbe: () => string | null = () => null;
  readonly calls: ServerCall[] = [];
  readonly unexpected: string[] = [];
  /** refresh token → account key (valid tokens only) */
  readonly validRefresh = new Map<string, Account['key']>();
  /** access token → account key */
  readonly accessOwner = new Map<string, Account['key']>();
  readonly issuedRefresh: string[] = [];
  /** in-flight requests per process generation */
  readonly inflightByProc = new Map<number, number>();
  readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private counter = 0;

  seedRefresh(token: string, account: Account['key']): void {
    this.validRefresh.set(token, account);
    this.issuedRefresh.push(token);
  }

  inflight(proc: number): number {
    return this.inflightByProc.get(proc) ?? 0;
  }

  /**
   * Waits `ms` of fake time. A request whose process was killed meanwhile
   * never settles — the dead process runs no JS, so neither the response nor
   * the client's abort can be observed by anything.
   */
  private delay(
    ms: number,
    signal: AbortSignal | null | undefined,
    proc: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (this.proc !== proc) return;
        resolve();
      }, ms);
      this.timers.add(timer);
      signal?.addEventListener('abort', () => {
        if (this.proc !== proc) return;
        clearTimeout(timer);
        this.timers.delete(timer);
        reject(new Error('AbortError (simulated fetch abort)'));
      });
    });
  }

  private mint(account: Account['key']): {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  } {
    this.counter += 1;
    const refreshToken = `refresh-${account}-${this.counter}`;
    const accessToken = `access-${account}-${this.counter}`;
    this.validRefresh.set(refreshToken, account);
    this.accessOwner.set(accessToken, account);
    this.issuedRefresh.push(refreshToken);
    return {
      accessToken,
      refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + this.bearerTtlSec,
    };
  }

  private accountForBearer(init: RequestInit): Account['key'] | null {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const auth = headers['Authorization'] ?? headers['authorization'] ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    for (const a of Object.values(ACCOUNTS)) {
      if (a.idToken === token) return a.key;
    }
    return this.accessOwner.get(token) ?? null;
  }

  readonly fetch = async (
    url: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const proc = this.proc;
    const route = url.startsWith(API_BASE) ? url.slice(API_BASE.length) : url;
    const call: ServerCall = {
      at: this.now(),
      route,
      proc,
      account: null,
      sessionAtCall: this.sessionProbe(),
      outcome: 'pending',
    };
    this.calls.push(call);
    this.inflightByProc.set(proc, this.inflight(proc) + 1);
    try {
      if (route === '/v1/account/bootstrap') {
        const account = this.accountForBearer(init);
        call.account = account;
        const mode = this.bootstrapMode;
        if (mode === 'hang') {
          await this.delay(10 * 60_000, init.signal, proc);
          call.outcome = 'hang-elapsed';
          return rawResponse(599, null);
        }
        await this.delay(
          mode === 'slow' ? Math.max(this.latencyMs, 6_000) : this.latencyMs,
          init.signal,
          proc,
        );
        if (!account) {
          call.outcome = '401-unknown-identity';
          return jsonResponse(401, { error: { message: 'unknown identity' } });
        }
        switch (mode) {
          case 'refuse-401':
            call.outcome = '401';
            return jsonResponse(401, {
              error: { message: 'identity token rejected' },
            });
          case 'error-500':
            call.outcome = '500';
            return jsonResponse(500, { error: { message: 'boom' } });
          case 'network':
            call.outcome = 'network-error';
            throw new TypeError('Network request failed');
          case 'malformed':
            call.outcome = '200-malformed';
            return rawResponse(200, '<html>not json</html>', 'text/html');
          default: {
            const session = this.mint(account);
            call.outcome = `ok→${session.refreshToken}`;
            return jsonResponse(200, {
              user: {
                id: ACCOUNTS[account].id,
                email: ACCOUNTS[account].email,
              },
              onboardingState: this.onboardingState[account],
              session,
            });
          }
        }
      }
      if (route === '/v1/auth/refresh') {
        const body = JSON.parse(String(init.body ?? '{}')) as {
          refreshToken?: string;
        };
        const token = String(body.refreshToken ?? '');
        const account = this.validRefresh.get(token) ?? null;
        call.account = account;
        await this.delay(Math.min(this.latencyMs, 1500), init.signal, proc);
        if (!account || (account === 'PRIOR' && !this.priorRefreshAccepted)) {
          call.outcome = account ? '401-prior-revoked' : '401-unknown-token';
          return jsonResponse(401, {
            error: {
              message: 'The session could not be refreshed. Sign in again.',
            },
          });
        }
        this.validRefresh.delete(token);
        const session = this.mint(account);
        call.outcome = `rotated→${session.refreshToken}`;
        return jsonResponse(200, { session });
      }
      if (route === '/v1/me') {
        const account = this.accountForBearer(init);
        call.account = account;
        await this.delay(Math.min(this.latencyMs, 300), init.signal, proc);
        if (!account) {
          call.outcome = '401';
          return jsonResponse(401, { error: { message: 'bad bearer' } });
        }
        call.outcome = '200';
        return jsonResponse(200, {
          onboardingState: this.onboardingState[account],
          profile:
            this.onboardingState[account] === 'complete'
              ? {
                  skill_level: 'intermediate',
                  handedness: 'right',
                  primary_goal: 'consistency',
                  biggest_problem: 'popups',
                  first_name: ACCOUNTS[account].firstName,
                }
              : null,
        });
      }
      if (route === '/v1/auth/logout') {
        call.account = this.accountForBearer(init);
        await this.delay(Math.min(this.latencyMs, 300), init.signal, proc);
        call.outcome = '204';
        return rawResponse(204, null);
      }
      this.unexpected.push(route);
      call.outcome = '404-unexpected';
      return jsonResponse(404, {
        error: { message: 'unexpected route in harness' },
      });
    } catch (error) {
      if (call.outcome === 'pending') call.outcome = 'aborted-by-client';
      throw error;
    } finally {
      this.inflightByProc.set(proc, this.inflight(proc) - 1);
    }
  };

  clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

// ─── Native Apple sign-in sheet ──────────────────────────────────────────────

interface NativeAppleResult {
  user: string;
  identityToken?: string;
  authorizationCode?: string;
  email?: string;
  givenName?: string;
  familyName?: string;
}

class FakeAppleSheet {
  /** Which account the next sheet resolves with. */
  account: Account['key'] = 'A';
  delayMs = 0;
  proc = 0;
  now: () => number = () => 0;
  readonly presentations: { at: number; proc: number; outcome: string }[] = [];
  private pending: {
    proc: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: (r: NativeAppleResult) => void;
    reject: (e: unknown) => void;
    entry: { at: number; proc: number; outcome: string };
  } | null = null;

  get isPending(): boolean {
    return this.pending !== null && this.pending.proc === this.proc;
  }

  readonly signInWithApple = (): Promise<NativeAppleResult> => {
    const proc = this.proc;
    const entry = { at: this.now(), proc, outcome: 'pending' };
    this.presentations.push(entry);
    return new Promise<NativeAppleResult>((resolve, reject) => {
      const account = ACCOUNTS[this.account];
      const timer = setTimeout(() => {
        if (this.pending?.timer === timer) this.pending = null;
        if (this.proc !== proc) return; // dead process: never settles
        entry.outcome = `resolved:${account.key}`;
        resolve({
          user: `apple-${account.key}`,
          identityToken: account.idToken,
          authorizationCode: `code-${account.key}`,
          email: account.email,
          givenName: account.givenName,
          familyName: account.familyName,
        });
      }, this.delayMs);
      this.pending = { proc, timer, resolve, reject, entry };
    });
  };

  /** The user dismissed the sheet while it was up. */
  cancel(): boolean {
    if (!this.isPending || !this.pending) return false;
    clearTimeout(this.pending.timer);
    this.pending.entry.outcome = 'canceled';
    this.pending.reject({
      code: 'auth.canceled',
      message: 'Sign-in canceled.',
    });
    this.pending = null;
    return true;
  }

  clearTimers(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }
}

// ─── AppState + AccessibilityInfo plumbing ───────────────────────────────────

const appStateListeners = new Set<(state: string) => void>();
function emitAppState(state: 'active' | 'background' | 'inactive'): void {
  for (const listener of [...appStateListeners]) listener(state);
}
const a11yListeners = new Set<unknown>();

// ─── Scenario space ──────────────────────────────────────────────────────────

type StepKind =
  | 'background'
  | 'foreground'
  | 'permission-revoke'
  | 'remount'
  | 'kill-relaunch'
  | 'second-hydrate'
  | 'press-get-started'
  | 'press-sign-in'
  | 'back'
  | 'apple-sign-in:A'
  | 'apple-sign-in:B'
  | 'cancel-native'
  | 'sign-out'
  | 'flip-server-ok';

interface Step {
  /** fake ms after the previous step */
  gapMs: number;
  kind: StepKind;
}

type InstallKind =
  | 'fresh'
  | 'signed-out-kv'
  | 'prior-user-vault-revoked'
  | 'prior-user-stale-kv';
const INSTALL_KINDS: readonly InstallKind[] = [
  'fresh',
  'fresh',
  'signed-out-kv',
  'prior-user-vault-revoked',
  'prior-user-stale-kv',
];

interface Scenario {
  seed: number;
  install: InstallKind;
  bootstrapMode: BootstrapMode;
  latencyMs: number;
  nativeDelayMs: number;
  bearerTtlSec: number;
  onboardingA: 'pending' | 'complete';
  onboardingB: 'pending' | 'complete';
  /** fake ms after mount at which the intro video reports its end */
  introEndMs: number;
  steps: Step[];
  settleMs: number;
}

const GAPS = [0, 0, 10, 50, 250, 1000, 3000, 9000, 20_000] as const;
const SHORT_GAPS = [0, 10, 50, 250, 900] as const;
const LATENCIES = [0, 20, 300, 1500, 4000] as const;
const NATIVE_DELAYS = [0, 100, 800, 3000] as const;
const TTLS = [3600, 3600, 120, 75] as const;
const INTRO_ENDS = [0, 300, 1200, 2500, 9000] as const;
const SETTLES = [0, 500, 2000, 10_000, 45_000] as const;

/** Model of what the Gate is expected to show, used only to bias generation
 * toward steps that apply; the runner re-checks every precondition. */
type ModelScreen = 'welcome' | 'signin' | 'onboarding' | 'maybe-signed-in';

function seededScenario(seed: number): Scenario {
  const rng = makePrng(seed);
  const stepCount = 4 + Math.floor(rng() * 9);
  const steps: Step[] = [];
  let screen: ModelScreen = 'welcome';
  const push = (kind: StepKind, gapMs: number = pick(rng, GAPS)) =>
    steps.push({ gapMs, kind });
  /** A native sheet is up: race it with the lifecycle before it resolves. */
  const raceSheet = () => {
    const q = rng();
    if (q < 0.25) push('cancel-native', pick(rng, SHORT_GAPS));
    else if (q < 0.4) push('kill-relaunch', pick(rng, SHORT_GAPS));
    else if (q < 0.5) push('remount', pick(rng, SHORT_GAPS));
    else if (q < 0.6) {
      push('background', pick(rng, SHORT_GAPS));
      push('foreground');
    }
    screen = q < 0.25 ? 'signin' : 'maybe-signed-in';
  };
  for (let i = 0; i < stepCount; i += 1) {
    const r = rng();
    if (r < 0.12) {
      push('background');
      if (rng() < 0.35) push('permission-revoke');
      push('foreground');
      continue;
    }
    if (r < 0.18) {
      push('remount');
      continue;
    }
    if (r < 0.26) {
      push('kill-relaunch');
      screen = 'maybe-signed-in';
      continue;
    }
    if (r < 0.32) {
      push('second-hydrate');
      continue;
    }
    switch (screen) {
      case 'welcome':
        if (rng() < 0.6) {
          push('press-sign-in');
          screen = 'signin';
        } else {
          push('press-get-started');
          screen = 'onboarding';
        }
        break;
      case 'onboarding':
        push('back');
        screen = 'welcome';
        break;
      case 'signin':
        if (rng() < 0.2) {
          push('back');
          screen = 'welcome';
        } else {
          push(rng() < 0.7 ? 'apple-sign-in:A' : 'apple-sign-in:B');
          raceSheet();
        }
        break;
      case 'maybe-signed-in': {
        const q = rng();
        if (q < 0.3) {
          push('sign-out');
          screen = rng() < 0.5 ? 'welcome' : 'signin';
        } else if (q < 0.45) {
          push('flip-server-ok');
        } else if (q < 0.6) {
          push('second-hydrate');
        } else if (q < 0.75) {
          push('kill-relaunch');
        } else {
          // Still signed out (failed/canceled sign-in): try the other account.
          push('press-sign-in');
          push(rng() < 0.5 ? 'apple-sign-in:B' : 'apple-sign-in:A');
          raceSheet();
        }
        break;
      }
    }
  }
  return {
    seed,
    install: pick(rng, INSTALL_KINDS),
    bootstrapMode: pick(rng, BOOTSTRAP_MODES),
    latencyMs: pick(rng, LATENCIES),
    nativeDelayMs: pick(rng, NATIVE_DELAYS),
    bearerTtlSec: pick(rng, TTLS),
    onboardingA: rng() < 0.75 ? 'complete' : 'pending',
    onboardingB: rng() < 0.75 ? 'complete' : 'pending',
    introEndMs: pick(rng, INTRO_ENDS),
    steps,
    settleMs: pick(rng, SETTLES),
  };
}

// ─── Render helpers ──────────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

// RN exports Pressable as React.memo(Pressable); the test tree holds the
// inner component, so unwrap the memo to match the real press targets.
const PressableInner = (
  Pressable as unknown as { type: React.ComponentType<unknown> }
).type;

const LAUNCH_DEADLINE_MS = 8_000;
const CANCELED_TEXT = 'Sign-in canceled.';

function renderedText(renderer: Renderer | null): string {
  if (!renderer) return '<unmounted>';
  try {
    return renderer.root
      .findAllByType(Text)
      .map(node => {
        const children = node.props['children'] as unknown;
        return Array.isArray(children)
          ? children.map(c => (typeof c === 'string' ? c : '')).join('')
          : typeof children === 'string'
            ? children
            : '';
      })
      .filter(Boolean)
      .join('|');
  } catch {
    return '<no-text>';
  }
}

function mounted(renderer: Renderer | null, type: React.ElementType): boolean {
  if (!renderer) return false;
  try {
    return renderer.root.findAllByType(type).length > 0;
  } catch {
    return false;
  }
}

/** The real press target (RN Pressable) carrying `accessibilityLabel`. */
function pressablesIn(root: Instance): Instance[] {
  return root
    .findAllByType(PressableInner)
    .filter(node => typeof node.props['onPress'] === 'function');
}
function findControl(
  renderer: Renderer | null,
  label: string,
): Instance | null {
  if (!renderer) return null;
  try {
    const matches = pressablesIn(renderer.root).filter(
      node => node.props['accessibilityLabel'] === label,
    );
    return matches[0] ?? null;
  } catch {
    return null;
  }
}

async function pressControl(control: Instance): Promise<void> {
  await act(async () => {
    const props = control.props as {
      onPressIn?: (e: unknown) => void;
      onPress?: (e: unknown) => void;
      onPressOut?: (e: unknown) => void;
    };
    props.onPressIn?.({});
    props.onPress?.({});
    props.onPressOut?.({});
  });
}

type ScreenName =
  | 'splash+welcome'
  | 'welcome'
  | 'signin'
  | 'onboarding'
  | 'app'
  | 'loading'
  | 'error'
  | 'unmounted'
  | 'other';

function currentScreen(renderer: Renderer | null): ScreenName {
  if (!renderer) return 'unmounted';
  if (mounted(renderer, ErrorState)) return 'error';
  const splash = mounted(renderer, SplashScreen);
  if (mounted(renderer, WelcomeScreen))
    return splash ? 'splash+welcome' : 'welcome';
  if (mounted(renderer, SignInScreen)) return 'signin';
  if (mounted(renderer, OnboardingScreen)) return 'onboarding';
  const text = renderedText(renderer);
  if (text.includes('ROOT_NAVIGATOR')) return 'app';
  if (
    text.includes('Getting things ready') ||
    text.includes('Loading your account')
  )
    return 'loading';
  return 'other';
}

interface WelcomeAudit {
  controls: number;
  primaryOk: boolean;
  secondaryOk: boolean;
  identityLeak: string[];
  sessionNull: boolean;
  profileNull: boolean;
  ownerSignedOut: boolean;
  apiSessionNull: boolean;
  activeOwnerSignedOut: boolean;
}

function auditWelcome(renderer: Renderer): WelcomeAudit {
  const welcome = renderer.root.findAllByType(WelcomeScreen)[0]!;
  const buttons = pressablesIn(welcome).filter(
    node => node.props['accessibilityRole'] === 'button',
  );
  const primary = buttons.find(
    b => b.props['accessibilityLabel'] === 'Start your first read',
  );
  const secondary = buttons.find(
    b => b.props['accessibilityLabel'] === 'I already have an account',
  );
  const text = renderedText(renderer);
  const auth = useAuthStore.getState();
  const app = useAppStore.getState();
  return {
    controls: buttons.length,
    primaryOk: Boolean(primary) && primary!.props['disabled'] !== true,
    secondaryOk:
      Boolean(secondary) &&
      secondary!.props['accessibilityHint'] ===
        'Sign in to an existing account',
    identityLeak: IDENTITY_MARKERS.filter(m => text.includes(m)),
    sessionNull: auth.session === null,
    profileNull: app.profile === null,
    ownerSignedOut: !app.hydrated || app.ownerKey === SIGNED_OUT_DATA_OWNER,
    apiSessionNull: getApiSession() === null,
    activeOwnerSignedOut: getActiveDataOwner() === SIGNED_OUT_DATA_OWNER,
  };
}

function gateReady(): boolean {
  const auth = useAuthStore.getState();
  const app = useAppStore.getState();
  if (!auth.hydrated) return false;
  const desired =
    auth.session?.provider === 'guest'
      ? 'device-guest'
      : auth.session?.canonicalAppUserId
        ? canonicalDataOwner(auth.session.canonicalAppUserId)
        : SIGNED_OUT_DATA_OWNER;
  return app.hydrated && app.ownerKey === desired;
}

function resetProcessState(): void {
  // The OS killed the process: every in-memory singleton is gone, only
  // Keychain + SQLite survive.
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

// ─── Runner ──────────────────────────────────────────────────────────────────

interface StepRecord extends Step {
  at: number;
  applied: boolean;
  screenBefore: ScreenName;
  screenAfter: ScreenName;
  note?: string;
}

interface Launch {
  index: number;
  proc: number;
  startedAt: number;
  endedAfterMs: number | null;
  readyAt: number | null;
  readyScreen: ScreenName | null;
  listenersBeforeMount: number;
  listenersAfterUnmount: number | null;
  signedInAtUnmount: boolean | null;
}

const nativeModules = NativeModules as { PickleAuth?: unknown };

async function runScenario(scenario: Scenario): Promise<MatrixRow> {
  const startedWall = Date.now();
  jest.setSystemTime(new Date('2026-03-01T09:00:00.000Z'));
  const t0 = Date.now();
  const rel = () => Date.now() - t0;
  const timeline: { at: number; kind: string; detail?: unknown }[] = [];
  const log = (kind: string, detail?: unknown) =>
    timeline.push({
      at: rel(),
      kind,
      ...(detail !== undefined ? { detail } : {}),
    });

  // ── Persisted world.
  const db = new FakeLocalDb();
  mockDb.current = db;
  mockKeychain.store.clear();
  mockKeychain.log.length = 0;
  mockKeychain.proc = 0;
  mockKeychain.now = rel;
  const server = new ScriptedServer();
  server.bootstrapMode = scenario.bootstrapMode;
  server.latencyMs = scenario.latencyMs;
  server.bearerTtlSec = scenario.bearerTtlSec;
  server.onboardingState.A = scenario.onboardingA;
  server.onboardingState.B = scenario.onboardingB;
  server.now = rel;
  server.sessionProbe = () =>
    useAuthStore.getState().session?.canonicalAppUserId ?? null;
  (globalThis as { fetch: unknown }).fetch = server.fetch;
  const sheet = new FakeAppleSheet();
  sheet.delayMs = scenario.nativeDelayMs;
  sheet.now = rel;
  nativeModules.PickleAuth = { signInWithApple: sheet.signInWithApple };
  mockScheduler.current = new FakeScheduler();

  const prior = ACCOUNTS.PRIOR;
  if (scenario.install === 'prior-user-vault-revoked') {
    mockKeychain.store.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify(
        validVault({
          canonicalAppUserId: prior.id,
          refreshToken: 'refresh-PRIOR-seeded',
          email: prior.email,
          displayName: `${prior.givenName} ${prior.familyName}`,
        }),
      ),
    });
    server.seedRefresh('refresh-PRIOR-seeded', 'PRIOR');
    server.priorRefreshAccepted = false;
    db.kv.set(
      `profile:${ownerOf(prior)}`,
      JSON.stringify(validProfile({ firstName: prior.firstName })),
    );
    db.seedShots(ownerOf(prior), 9, 'prior');
  } else if (scenario.install === 'prior-user-stale-kv') {
    db.kv.set(
      'auth.local-mode',
      JSON.stringify({ version: 1, mode: 'signed-out' }),
    );
    db.kv.set(
      `profile:${ownerOf(prior)}`,
      JSON.stringify(validProfile({ firstName: prior.firstName })),
    );
    db.kv.set(`profile:${SIGNED_OUT_DATA_OWNER}`, '');
    db.seedShots(ownerOf(prior), 5, 'prior');
  } else if (scenario.install === 'signed-out-kv') {
    db.kv.set(
      'auth.local-mode',
      JSON.stringify({ version: 1, mode: 'signed-out' }),
    );
    db.kv.set('auth.last-provider', '');
  }
  db.seedShots('other-owner', 2, 'stranger');
  const shotsBefore = db.shotFingerprint();

  resetProcessState();

  // ── Observation state.
  const consoleErrors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      const [format, ...rest] = args;
      let message = String(format);
      for (const arg of rest) message = message.replace(/%s/, String(arg));
      consoleErrors.push(message.split('\n')[0]!.slice(0, 300));
      if (nodeProcess.env['STRESS_VERBOSE']) {
        verbose(
          `[console.error @${rel()}ms] ${args.map(a => String(a)).join(' ')}`,
        );
      }
    });
  const hydrateRejections: string[] = [];
  const backgroundPromises: Promise<unknown>[] = [];
  const welcomeAudits: (WelcomeAudit & { at: number })[] = [];
  const launches: Launch[] = [];
  const stepRecords: StepRecord[] = [];
  let errorBoundarySeen = false;
  /** The Gate's in-memory pre-auth stage (React state: resets on remount/kill). */
  let preAuthStage: 'welcome' | 'signin' | 'onboarding' = 'welcome';
  let signOutAt: number | null = null;
  /** A sign-in whose completion has not been audited yet. */
  let pendingSignIn: { account: Account['key']; at: number } | null = null;
  let keychainSetsAfterSignOut = 0;
  let signInAfterSignOut = false;
  const rehydrateChecks: {
    at: number;
    before: ScreenName;
    after: ScreenName;
    /** account the vault token was valid for when the second hydrate started */
    vaultOwnerBefore: string | null;
    /** …and once it settled (a sign-in racing the hydrate may have landed) */
    vaultOwnerAfter: string | null;
    signInInFlight: boolean;
    sessionBefore: string | null;
    sessionAfter: string | null;
    /**
     * The session settled on the vault's truth (a token the server honours →
     * that account, else signed out) and — unless a sign-in was racing the
     * hydrate — the vault itself did not change under a double refresh.
     */
    sessionMatchesVault: boolean;
  }[] = [];
  const cancelChecks: {
    at: number;
    busy: boolean;
    errorCode: string | null;
    sessionNull: boolean;
    vaultEmpty: boolean;
    screen: ScreenName;
    canceledTextShown: boolean;
  }[] = [];
  const killChecks: {
    at: number;
    inflightAtKill: number;
    sheetPendingAtKill: boolean;
    vaultTokenAtKill: string | null;
    sessionAfterRelaunch: string | null;
    vaultTokenAfterRelaunch: string | null;
    screenAfterRelaunch: ScreenName;
    deadProcKeychainSets: number;
  }[] = [];
  const routeChecks: {
    kind: StepKind;
    expected: ScreenName;
    got: ScreenName;
  }[] = [];
  const accountChecks: {
    at: number;
    auditedAt: number;
    account: Account['key'];
    apiUser: string | null;
    appOwner: string | null;
    profileFirstName: string | null;
    notifOwner: string | null;
    consistencyOwner: string | null;
    otherIdentityInText: string[];
  }[] = [];
  const permissionChecks: { at: number; permissionAfter: string }[] = [];

  const unsubscribers: (() => void)[] = [];
  unsubscribers.push(
    useAuthStore.subscribe((next, prev) => {
      if (prev.session && !next.session)
        log('auth.session-cleared', prev.session.provider);
      if (!prev.session && next.session)
        log('auth.session-set', next.session.canonicalAppUserId);
      if (!prev.hydrated && next.hydrated) log('auth.hydrated');
    }),
  );
  unsubscribers.push(
    useAppStore.subscribe((next, prev) => {
      if (!prev.hydrated && next.hydrated)
        log('app.hydrated', {
          owner: next.ownerKey,
          profile: next.profile?.firstName ?? null,
        });
    }),
  );

  const state: { renderer: Renderer | null; introEnded: boolean } = {
    renderer: null,
    introEnded: false,
  };

  const observe = async () => {
    const launch = launches[launches.length - 1];
    const screen = currentScreen(state.renderer);
    if (launch && launch.readyAt === null && gateReady()) {
      launch.readyAt = rel() - launch.startedAt;
      launch.readyScreen = screen;
      log('gate.ready', { launch: launch.index, screen });
    }
    if (screen === 'error') errorBoundarySeen = true;
    if (
      state.renderer &&
      (screen === 'welcome' || screen === 'splash+welcome')
    ) {
      welcomeAudits.push({ at: rel(), ...auditWelcome(state.renderer) });
    }
    // The intro video ends on the seeded schedule (the mock player never does).
    if (
      state.renderer &&
      !state.introEnded &&
      launch &&
      rel() - launch.startedAt >= scenario.introEndMs
    ) {
      const video = state.renderer.root.findAll(
        node =>
          node.props['testID'] === 'splash-video' &&
          typeof node.type === 'string',
      )[0];
      if (video) {
        state.introEnded = true;
        await act(async () => {
          (video.props as { onEnd?: () => void }).onEnd?.();
        });
      }
    }
  };

  const mount = async (why: string) => {
    const proc = server.proc;
    launches.push({
      index: launches.length + 1,
      proc,
      startedAt: rel(),
      endedAfterMs: null,
      readyAt: null,
      readyScreen: null,
      listenersBeforeMount: appStateListeners.size,
      listenersAfterUnmount: null,
      signedInAtUnmount: null,
    });
    state.introEnded = false;
    preAuthStage = 'welcome';
    log('mount', { why, launch: launches.length, proc });
    await act(async () => {
      state.renderer = TestRenderer.create(<App />);
    });
  };
  const unmount = async (why: string) => {
    const launch = launches[launches.length - 1];
    log('unmount', { why });
    if (launch && launch.endedAfterMs === null)
      launch.endedAfterMs = rel() - launch.startedAt;
    if (launch)
      launch.signedInAtUnmount = useAuthStore.getState().session !== null;
    await act(async () => {
      state.renderer?.unmount();
    });
    state.renderer = null;
    if (launch) launch.listenersAfterUnmount = appStateListeners.size;
  };
  const kill = async () => {
    await unmount('kill');
    resetProcessState();
    server.proc += 1;
    sheet.proc += 1;
    mockKeychain.proc = server.proc;
  };

  const advance = async (ms: number) => {
    let left = ms;
    while (left > 0) {
      const slice = Math.min(left, 250);
      await flush(slice);
      left -= slice;
      await observe();
    }
    if (ms === 0) {
      await flush(0);
      await observe();
    }
  };

  const vaultToken = () =>
    mockVaultTokenOf(
      mockKeychain.store.get(SESSION_VAULT_SERVICE)?.password ?? null,
    );
  /** Canonical id the vault's refresh token is currently valid for on the server. */
  const vaultOwner = (): string | null => {
    const token = vaultToken();
    const key = token ? (server.validRefresh.get(token) ?? null) : null;
    return key && (key !== 'PRIOR' || server.priorRefreshAccepted)
      ? ACCOUNTS[key].id
      : null;
  };

  const signInSettled = () =>
    !sheet.isPending &&
    !useAuthStore.getState().busy &&
    server.inflight(server.proc) === 0;
  /**
   * Audits the account that landed after a sign-in once the flow is idle
   * (`force` waits up to the client's own 15 s abort for it to become idle).
   */
  const auditSignIn = async (force: boolean) => {
    if (!pendingSignIn) return;
    if (!signInSettled()) {
      if (!force) return;
      let waited = 0;
      while (!signInSettled() && waited < scenario.nativeDelayMs + 16_000) {
        await advance(250);
        waited += 250;
      }
    }
    const { account, at } = pendingSignIn;
    pendingSignIn = null;
    const api = getApiSession();
    const app = useAppStore.getState();
    const text = renderedText(state.renderer);
    const other = Object.values(ACCOUNTS).filter(a => a.key !== account);
    accountChecks.push({
      at,
      auditedAt: rel(),
      account,
      apiUser: api?.canonicalAppUserId ?? null,
      appOwner: app.ownerKey,
      profileFirstName: app.profile?.firstName ?? null,
      notifOwner: useNotificationStore.getState().ownerKey,
      consistencyOwner: useConsistencyStore.getState().ownerKey,
      otherIdentityInText: other
        .flatMap(a => [a.givenName, a.email])
        .filter(m => text.includes(m)),
    });
  };

  // ── Cold launch.
  await mount('cold-launch');
  await advance(0);

  // ── Steps.
  for (const step of scenario.steps) {
    await advance(step.gapMs);
    const screenBefore = currentScreen(state.renderer);
    const sessionBefore = useAuthStore.getState().session;
    const record: StepRecord = {
      ...step,
      at: rel(),
      applied: false,
      screenBefore,
      screenAfter: screenBefore,
    };
    log(`step.${step.kind}`, { screenBefore });
    const pressable =
      screenBefore !== 'splash+welcome' && state.renderer !== null;
    switch (step.kind) {
      case 'background':
        if (state.renderer) {
          record.applied = true;
          await act(async () => emitAppState('inactive'));
          await act(async () => emitAppState('background'));
        }
        break;
      case 'foreground':
        if (state.renderer) {
          record.applied = true;
          await act(async () => emitAppState('active'));
        }
        break;
      case 'permission-revoke':
        record.applied = true;
        mockScheduler.current.permission = 'denied';
        break;
      case 'remount':
        if (state.renderer) {
          record.applied = true;
          await unmount('remount');
          await mount('remount');
        }
        break;
      case 'kill-relaunch': {
        record.applied = true;
        const inflightAtKill = server.inflight(server.proc);
        const sheetPendingAtKill = sheet.isPending;
        const vaultTokenAtKill = vaultToken();
        const logBefore = mockKeychain.log.length;
        const deadProc = server.proc;
        await kill();
        await mount('relaunch-after-kill');
        await advance(0);
        await advance(LAUNCH_DEADLINE_MS + 1_000);
        const deadProcKeychainSets = mockKeychain.log
          .slice(logBefore)
          .filter(e => e.op === 'set' && e.proc === deadProc).length;
        const session = useAuthStore.getState().session;
        killChecks.push({
          at: record.at,
          inflightAtKill,
          sheetPendingAtKill,
          vaultTokenAtKill,
          sessionAfterRelaunch: session?.canonicalAppUserId ?? null,
          vaultTokenAfterRelaunch: vaultToken(),
          screenAfterRelaunch: currentScreen(state.renderer),
          deadProcKeychainSets,
        });
        break;
      }
      case 'second-hydrate': {
        record.applied = true;
        const vaultOwnerBefore = vaultOwner();
        const signInInFlight = pendingSignIn !== null && !signInSettled();
        await act(async () => {
          backgroundPromises.push(
            useAuthStore
              .getState()
              .hydrate()
              .catch((error: unknown) => {
                hydrateRejections.push(
                  `second-hydrate: ${error instanceof Error ? error.message : String(error)}`,
                );
              }),
          );
        });
        await advance(0);
        await advance(LAUNCH_DEADLINE_MS + 1_000);
        const after = currentScreen(state.renderer);
        const sessionAfter =
          useAuthStore.getState().session?.canonicalAppUserId ?? null;
        const vaultOwnerAfter = vaultOwner();
        rehydrateChecks.push({
          at: record.at,
          before: screenBefore,
          after,
          vaultOwnerBefore,
          vaultOwnerAfter,
          signInInFlight,
          sessionBefore: sessionBefore?.canonicalAppUserId ?? null,
          sessionAfter,
          sessionMatchesVault:
            sessionAfter === vaultOwnerAfter &&
            (signInInFlight || vaultOwnerAfter === vaultOwnerBefore),
        });
        break;
      }
      case 'press-get-started': {
        const control = pressable
          ? findControl(state.renderer, 'Start your first read')
          : null;
        if (control && screenBefore === 'welcome') {
          record.applied = true;
          preAuthStage = 'onboarding';
          await pressControl(control);
          await advance(0);
          routeChecks.push({
            kind: step.kind,
            expected: 'onboarding',
            got: currentScreen(state.renderer),
          });
        }
        break;
      }
      case 'press-sign-in': {
        const control = pressable
          ? findControl(state.renderer, 'I already have an account')
          : null;
        if (control && screenBefore === 'welcome') {
          record.applied = true;
          preAuthStage = 'signin';
          await pressControl(control);
          await advance(0);
          routeChecks.push({
            kind: step.kind,
            expected: 'signin',
            got: currentScreen(state.renderer),
          });
        }
        break;
      }
      case 'back': {
        const control =
          pressable &&
          useAuthStore.getState().session === null &&
          (screenBefore === 'signin' || screenBefore === 'onboarding')
            ? findControl(state.renderer, 'Back')
            : null;
        if (control) {
          record.applied = true;
          preAuthStage = 'welcome';
          await pressControl(control);
          await advance(0);
          routeChecks.push({
            kind: step.kind,
            expected: 'welcome',
            got: currentScreen(state.renderer),
          });
        }
        break;
      }
      case 'apple-sign-in:A':
      case 'apple-sign-in:B': {
        const control =
          pressable && screenBefore === 'signin'
            ? findControl(state.renderer, 'Continue with Apple')
            : null;
        if (control && !sheet.isPending && !useAuthStore.getState().busy) {
          record.applied = true;
          const account: Account['key'] = step.kind.endsWith(':A') ? 'A' : 'B';
          sheet.account = account;
          if (signOutAt !== null) signInAfterSignOut = true;
          await pressControl(control);
          await advance(0);
          // The sheet + bootstrap + profile fetch now race whatever the
          // schedule does next; the account audit runs once the flow has
          // settled (see auditSignIn).
          pendingSignIn = { account, at: record.at };
        }
        break;
      }
      case 'cancel-native': {
        if (sheet.isPending) {
          record.applied = true;
          const vaultBefore = vaultToken();
          await act(async () => {
            sheet.cancel();
          });
          await advance(0);
          await advance(50);
          const auth = useAuthStore.getState();
          cancelChecks.push({
            at: record.at,
            busy: auth.busy,
            errorCode: auth.error?.code ?? null,
            sessionNull: auth.session === null,
            vaultEmpty: vaultToken() === vaultBefore,
            screen: currentScreen(state.renderer),
            canceledTextShown: renderedText(state.renderer).includes(
              CANCELED_TEXT,
            ),
          });
        }
        break;
      }
      case 'sign-out': {
        // Only screens that actually offer "Sign out" (Settings inside the
        // app, the onboarding leave dialog) can trigger it.
        if (
          useAuthStore.getState().session &&
          (screenBefore === 'app' || screenBefore === 'onboarding')
        ) {
          record.applied = true;
          signOutAt = rel();
          signInAfterSignOut = false;
          const setsBefore = mockKeychain.log.length;
          await act(async () => {
            backgroundPromises.push(
              useAuthStore
                .getState()
                .signOut()
                .catch((error: unknown) => {
                  hydrateRejections.push(
                    `signOut: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }),
            );
          });
          await advance(0);
          await advance(2_000);
          keychainSetsAfterSignOut += mockKeychain.log
            .slice(setsBefore)
            .filter(e => e.op === 'set').length;
          // The Gate remembers its pre-auth stage (pinned by
          // flow-launch-onboarding-gate: "sign-out lands on sign-in"), so a
          // session started from the sign-in screen signs out onto it and a
          // session restored at launch signs out onto Welcome.
          routeChecks.push({
            kind: step.kind,
            expected: preAuthStage,
            got: currentScreen(state.renderer),
          });
        }
        break;
      }
      case 'flip-server-ok':
        record.applied = true;
        server.bootstrapMode = 'ok';
        server.latencyMs = Math.min(server.latencyMs, 50);
        break;
    }
    if (step.kind === 'foreground' && record.applied) {
      await advance(300);
      permissionChecks.push({
        at: record.at,
        permissionAfter: useNotificationStore.getState().permission,
      });
    }
    await advance(0);
    await auditSignIn(false);
    record.screenAfter = currentScreen(state.renderer);
    stepRecords.push(record);
  }

  await auditSignIn(true);
  await advance(scenario.settleMs);
  const current = launches[launches.length - 1]!;
  const sinceLaunch = rel() - current.startedAt;
  if (state.renderer && sinceLaunch < LAUNCH_DEADLINE_MS + 2_000)
    await advance(LAUNCH_DEADLINE_MS + 2_000 - sinceLaunch);
  const midScreen = currentScreen(state.renderer);
  const midSession =
    useAuthStore.getState().session?.canonicalAppUserId ?? null;

  // ── Next-day cold relaunch.
  log('next-day-relaunch');
  if (state.renderer) await unmount('next-day');
  resetProcessState();
  server.proc += 1;
  sheet.proc += 1;
  mockKeychain.proc = server.proc;
  server.bootstrapMode = 'ok';
  server.latencyMs = 50;
  jest.setSystemTime(new Date(Date.now() + 24 * 3600_000));
  await mount('next-day-cold');
  await advance(0);
  await advance(LAUNCH_DEADLINE_MS + 2_000);
  const finalScreen = currentScreen(state.renderer);
  const finalSession = useAuthStore.getState().session;
  const finalVaultToken = vaultToken();
  const finalVaultOwner = finalVaultToken
    ? (server.validRefresh.get(finalVaultToken) ?? null)
    : null;
  const finalText = renderedText(state.renderer);
  const finalWelcomeAudit =
    state.renderer &&
    (finalScreen === 'welcome' || finalScreen === 'splash+welcome')
      ? auditWelcome(state.renderer)
      : null;

  // ── Teardown (kill) and leak measurement.
  await unmount('end');
  const listenersAfterFinalUnmount = appStateListeners.size;
  resetProcessState();
  server.proc += 1;
  sheet.proc += 1;
  server.clearTimers();
  sheet.clearTimers();
  await flush(30_000);
  await Promise.all(backgroundPromises);
  const timersAfterTeardown = jest.getTimerCount();
  const listenersAfterTeardown = appStateListeners.size;
  for (const u of unsubscribers) u();
  errorSpy.mockRestore();
  // Drop the per-call bookkeeping every jest.fn/spy accumulates (the
  // Math.random spy alone records ~20k results per scenario); implementations
  // stay in place.
  jest.clearAllMocks();

  // ── Oracle.
  const refreshCallsWhileSignedOut = server.calls.filter(
    c => c.route === '/v1/auth/refresh' && c.sessionAtCall === null,
  ).length;
  const invariants: Record<string, boolean> = {};
  // noCrash: RootErrorBoundary never rendered; hydrate()/signOut() never rejected.
  invariants['noCrash'] = !errorBoundarySeen && hydrateRejections.length === 0;
  // noReactErrors: nothing logged through console.error during the timeline
  // (act() warnings, state updates on unmounted trees, key warnings…).
  invariants['noReactErrors'] = consoleErrors.length === 0;
  // readyWithinDeadline: every launch that lived long enough became ready
  // inside the 8 s launch deadline (+ slack).
  invariants['readyWithinDeadline'] = launches.every(l =>
    l.endedAfterMs !== null &&
    l.endedAfterMs < LAUNCH_DEADLINE_MS + 1_500 &&
    l.readyAt === null
      ? true
      : l.readyAt !== null && l.readyAt <= LAUNCH_DEADLINE_MS + 1_500,
  );
  // welcomeWiring: every time WelcomeScreen was on screen it carried exactly
  // its two enabled controls with the canonical labels and hint.
  invariants['welcomeWiring'] = welcomeAudits.every(
    a => a.controls === 2 && a.primaryOk && a.secondaryOk,
  );
  // welcomeIsSignedOut: WelcomeScreen never showed with a session, a profile,
  // an API session, a non-signed-out data owner, or an identity string of
  // any account (including the PRIOR user's persisted state).
  invariants['welcomeIsSignedOut'] = welcomeAudits.every(
    a =>
      a.sessionNull &&
      a.profileNull &&
      a.ownerSignedOut &&
      a.apiSessionNull &&
      a.activeOwnerSignedOut &&
      a.identityLeak.length === 0,
  );
  // pressesRoute: Start → onboarding, I already have an account → sign-in,
  // Back → welcome, sign-out → the remembered pre-auth stage.
  invariants['pressesRoute'] = routeChecks.every(r => r.got === r.expected);
  // rehydrateIdempotent: a re-entrant authStore.hydrate() settles on the
  // vault's truth — a token the server still honours keeps that account
  // signed in (the self-inflicted double refresh must not turn into an
  // implicit sign-out), anything else lands signed out — and, while signed
  // out, leaves the Gate on the same pre-auth screen.
  invariants['rehydrateIdempotent'] = rehydrateChecks.every(
    r =>
      r.sessionMatchesVault &&
      (r.signInInFlight ||
      r.before === 'app' ||
      r.before === 'loading' ||
      r.before === 'unmounted'
        ? true
        : r.after === r.before ||
          (r.before === 'splash+welcome' && r.after === 'welcome')),
  );
  // cancelMidFlight: dismissing the Apple sheet lands busy=false with
  // auth.canceled, no session, no vault write, still on sign-in, and the
  // canceled message is NOT rendered as an error (SignInScreen hides it).
  invariants['cancelMidFlight'] = cancelChecks.every(
    c =>
      !c.busy &&
      c.errorCode === 'auth.canceled' &&
      c.sessionNull &&
      c.vaultEmpty &&
      c.screen === 'signin' &&
      !c.canceledTextShown,
  );
  // killMidRequest: a process killed mid-request never writes the Keychain
  // afterwards, and the relaunch restores exactly the vault as it stood at
  // the kill (token present ⇒ that account or signed-out after a refusal;
  // absent ⇒ signed-out on Welcome).
  invariants['killMidRequest'] = killChecks.every(k => {
    if (k.deadProcKeychainSets !== 0) return false;
    if (k.vaultTokenAtKill === null)
      return (
        k.sessionAfterRelaunch === null && k.screenAfterRelaunch === 'welcome'
      );
    return true;
  });
  // signOutDurable: after an explicit sign-out nothing re-wrote the vault
  // unless a NEW sign-in followed; the next-day relaunch is signed-out.
  invariants['signOutDurable'] =
    signOutAt === null ||
    signInAfterSignOut ||
    (keychainSetsAfterSignOut === 0 &&
      finalSession === null &&
      finalVaultToken === null &&
      (finalScreen === 'welcome' || finalScreen === 'splash+welcome'));
  // accountIsolation: after a completed sign-in as X, every owner-scoped
  // store reports X's owner (or nothing yet), the profile is X's, and no
  // other account's identity is rendered. A sign-in the server refused /
  // that never completed (apiUser null) is signed-out territory.
  invariants['accountIsolation'] = accountChecks.every(c => {
    const me = ACCOUNTS[c.account];
    if (c.apiUser === null) {
      return (
        (c.appOwner === null ||
          c.appOwner === SIGNED_OUT_DATA_OWNER ||
          c.appOwner === ownerOf(me)) &&
        c.profileFirstName === null &&
        c.otherIdentityInText.length === 0
      );
    }
    if (c.apiUser !== me.id) return false;
    const owner = ownerOf(me);
    return (
      (c.appOwner === owner || c.appOwner === null) &&
      (c.profileFirstName === null || c.profileFirstName === me.firstName) &&
      (c.notifOwner === null || c.notifOwner === owner) &&
      (c.consistencyOwner === null || c.consistencyOwner === owner) &&
      c.otherIdentityInText.length === 0
    );
  });
  // noRefreshWhileSignedOut: the session keeper never runs for nobody.
  invariants['noRefreshWhileSignedOut'] = refreshCallsWhileSignedOut === 0;
  // noListenerLeak: a signed-out Gate unmount never leaves more AppState
  // listeners than existed before the mount (fewer is fine: a keeper started
  // by an optimistic restore that the server then refused has stopped); after
  // the final kill no listener survives.
  invariants['noListenerLeak'] =
    launches.every(l =>
      l.listenersAfterUnmount === null || l.signedInAtUnmount
        ? true
        : l.listenersAfterUnmount <= l.listenersBeforeMount,
    ) && listenersAfterTeardown === 0;
  // noTimerLeak: 30 s after the final kill no timer is pending (splash
  // watchdog, keeper, bootstrap abort, sync backoff all released).
  invariants['noTimerLeak'] = timersAfterTeardown === 0;
  // shotsPreserved / noTokenInKv: a pre-auth flow never touches shot rows or
  // writes session material to SQLite.
  invariants['shotsPreserved'] =
    db.shotFingerprint() === shotsBefore &&
    db.destructiveStatements().length === 0;
  invariants['noTokenInKv'] = !db
    .kvWrites()
    .some(w =>
      /refresh-|access-|id-token|refreshToken|bearerToken/.test(w.value),
    );
  invariants['noUnexpectedRoutes'] = server.unexpected.length === 0;
  // finalLaunchMatchesVault: the next-day cold launch is signed in iff the
  // vault holds a refresh token the server still honours.
  invariants['finalLaunchMatchesVault'] =
    finalVaultOwner !== null && finalVaultOwner !== 'PRIOR'
      ? finalSession?.canonicalAppUserId === ACCOUNTS[finalVaultOwner].id &&
        (finalScreen === 'app' || finalScreen === 'onboarding')
      : finalSession === null &&
        (finalScreen === 'welcome' || finalScreen === 'splash+welcome') &&
        finalWelcomeAudit !== null &&
        finalWelcomeAudit.identityLeak.length === 0;

  const failed = Object.entries(invariants)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    suite: 'welcomescreen-lifecycle',
    scenario: `seed-${scenario.seed}`,
    seed: scenario.seed,
    inputs: { ...scenario },
    observed: {
      timeline,
      launches,
      steps: stepRecords,
      appliedSteps: stepRecords.filter(s => s.applied).length,
      serverCalls: server.calls,
      unexpectedRoutes: server.unexpected,
      sheetPresentations: sheet.presentations,
      keychainOps: mockKeychain.log.map(e => `${e.op}@${e.at}/p${e.proc}`),
      welcomeAuditsCount: welcomeAudits.length,
      welcomeAuditFailures: welcomeAudits.filter(
        a =>
          !(a.controls === 2 && a.primaryOk && a.secondaryOk) ||
          !a.sessionNull ||
          !a.profileNull ||
          !a.ownerSignedOut ||
          !a.apiSessionNull ||
          !a.activeOwnerSignedOut ||
          a.identityLeak.length > 0,
      ),
      routeChecks,
      rehydrateChecks,
      cancelChecks,
      killChecks,
      accountChecks,
      permissionChecks,
      refreshCallsWhileSignedOut,
      signOutAt,
      keychainSetsAfterSignOut,
      midScreen,
      midSession,
      finalScreen,
      finalSession: finalSession?.canonicalAppUserId ?? null,
      finalVaultToken,
      finalVaultOwner,
      finalText,
      consoleErrors,
      hydrateRejections,
      errorBoundarySeen,
      listenersAfterFinalUnmount,
      listenersAfterTeardown,
      timersAfterTeardown,
      a11yListenersTotal: a11yListeners.size,
      heapUsedMbAfter: heapUsedMbAfterGc(),
    },
    invariants,
    ok: failed.length === 0,
    failed,
    durationMs: Date.now() - startedWall,
  };
}

/** Heap after a forced GC when jest runs under `node --expose-gc` (else lazy). */
function heapUsedMbAfterGc(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return heapSnapshot()['heapUsedMb'] ?? 0;
}

// ─── Artifacts ───────────────────────────────────────────────────────────────

function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(
          __dirname,
          '../../../../artifacts/stress/welcomescreen-lifecycle',
        );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function writeJson(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

/**
 * STRESS_HEAPSNAP="10,40" writes a V8 heap snapshot after those iterations
 * into the artifact dir (diagnosing cross-iteration heap growth).
 */
function maybeWriteHeapSnapshot(iteration: number): void {
  const wanted = (nodeProcess.env['STRESS_HEAPSNAP'] ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number);
  if (!wanted.includes(iteration)) return;
  const v8 = require('node:v8') as { writeHeapSnapshot(file: string): string };
  (globalThis as { gc?: () => void }).gc?.();
  v8.writeHeapSnapshot(
    path.join(
      artifactDir(),
      `welcomescreen-lifecycle.iter${iteration}.heapsnapshot`,
    ),
  );
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
const ITER = Number(nodeProcess.env['STRESS_ITER'] ?? 12);
const SEED_START = Number(nodeProcess.env['STRESS_SEED_START'] ?? 1);
const SEED_FILTER = nodeProcess.env['STRESS_SEED'];
const REPLAY =
  'cd apps/mobile && STRESS_SEED=<seed> npx jest --ci __tests__/stress/welcomeScreenLifecycle.stress.test.tsx';

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
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockImplementation(() => Promise.resolve(false));
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((
    _type: string,
    handler: unknown,
  ) => {
    a11yListeners.add(handler);
    return { remove: () => a11yListeners.delete(handler) };
  }) as unknown as typeof AccessibilityInfo.addEventListener);
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  delete nativeModules.PickleAuth;
  jest.useRealTimers();
});

describe('STRESS scr-welcomescreen — lifecycle interleavings inside the real App', () => {
  const rows: MatrixRow[] = [];
  const seeds = SEED_FILTER
    ? [Number(SEED_FILTER)]
    : Array.from({ length: ITER }, (_, i) => SEED_START + i);

  const CHUNK = 25;
  for (let start = 0; start < seeds.length; start += CHUNK) {
    const slice = seeds.slice(start, start + CHUNK);
    it(`seeds ${slice[0]}..${slice[slice.length - 1]}`, async () => {
      for (const seed of slice) {
        rows.push(await runScenario(seededScenario(seed)));
        maybeWriteHeapSnapshot(rows.length);
      }
    }, 900_000);
  }

  it('writes the seed → outcome table and every invariant held', () => {
    const table = rows.map(r => ({
      seed: r.seed,
      ok: r.ok,
      failed: r.failed,
      install: r.inputs['install'],
      bootstrapMode: r.inputs['bootstrapMode'],
      steps: (r.inputs['steps'] as Step[]).map(s => s.kind),
      appliedSteps: r.observed['appliedSteps'],
      finalScreen: r.observed['finalScreen'],
      durationMs: r.durationMs,
    }));
    const stepKindCounts: Record<string, number> = {};
    for (const r of rows)
      for (const s of r.observed['steps'] as StepRecord[])
        if (s.applied)
          stepKindCounts[s.kind] = (stepKindCounts[s.kind] ?? 0) + 1;
    const invariantCounts: Record<string, { held: number; failed: number }> =
      {};
    for (const r of rows)
      for (const [name, ok] of Object.entries(r.invariants)) {
        const c = (invariantCounts[name] ??= { held: 0, failed: 0 });
        if (ok) c.held += 1;
        else c.failed += 1;
      }
    const summary = {
      suite: 'welcomescreen-lifecycle',
      iterations: rows.length,
      passed: rows.filter(r => r.ok).length,
      failedSeeds: rows
        .filter(r => !r.ok)
        .map(r => ({ seed: r.seed, failed: r.failed })),
      appliedStepsTotal: rows.reduce(
        (n, r) => n + (r.observed['appliedSteps'] as number),
        0,
      ),
      stepKindCounts,
      invariantCounts,
      a11yListenersTotal: a11yListeners.size,
      heap: heapSnapshot(),
      /** heapUsed after each scenario (post-GC under `node --expose-gc`) — flat ⇒ no cross-launch retention */
      heapUsedMbAfterScenario: {
        first: rows[0]?.observed['heapUsedMbAfter'] ?? null,
        last: rows[rows.length - 1]?.observed['heapUsedMbAfter'] ?? null,
        max: Math.max(
          ...rows.map(r => r.observed['heapUsedMbAfter'] as number),
        ),
      },
      replay: REPLAY,
    };
    const paths = [
      writeJson('welcomescreen-lifecycle.rows.json', rows),
      writeJson('welcomescreen-lifecycle.table.json', table),
      writeJson('welcomescreen-lifecycle.summary.json', summary),
    ];
    console.log(
      JSON.stringify({
        suite: 'welcomescreen-lifecycle',
        iterations: rows.length,
        passed: summary.passed,
        failedSeeds: summary.failedSeeds,
        paths,
      }),
    );
    // The reduced-motion observer is a deliberate process-level singleton:
    // exactly one native subscription for the whole worker, never one per
    // mount.
    expect(a11yListeners.size).toBeLessThanOrEqual(1);
    expect(summary.failedSeeds).toEqual([]);
  });
});
