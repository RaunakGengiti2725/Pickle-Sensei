/**
 * XC matrix-lifecycle-persistence — harness C: launch ordering.
 *
 * Mounts the REAL <App /> (Gate + RootErrorBoundary + owner-scoped
 * bootstraps) against the real authStore / appStore / notificationStore /
 * consistencyStore / sessionKeeper / sessionLifecycle, with only the process
 * edges faked: a Keychain map, a FakeLocalDb (harness A), a scripted HTTP
 * server for /v1/auth/refresh + /v1/me, and AppState.
 *
 * Every scenario is a deterministic timeline over ONE persisted account:
 *   cold launch → (remount | second hydrate() | background/foreground |
 *   kill+relaunch | explicit sign-out)* → next-day cold relaunch
 * with the server in one of {rotate, 401, 5xx, network-error, hang, slow}
 * modes and a refresh-token reuse policy of {strict, 10s-window}.
 *
 * Invariants (each is a MatrixRow.invariants key):
 *   noCrash                 RootErrorBoundary never renders, no hydrate() rejects
 *   authFirst               appStore.hydrate() only starts after auth hydrated
 *   ownerSelectedFromAuth   the owner appStore hydrates for == the one the auth
 *                           session implies at that moment
 *   ownerAgreement          every store that reports an owner reports the
 *                           active owner at the time it finished
 *   readyWithinDeadline     Gate.ready within the 8 s launch deadline + slack
 *   singleInflightRefresh   the client never has two refresh requests in flight
 *   noImplicitSignOut       signed-out ⇒ the server answered 401/403 to a
 *                           token the client legitimately held (the one rule)
 *   noRotationLoss          every refresh token the server issued and delivered
 *                           to the client was persisted (vault == server truth)
 *   signOutDurable          after an explicit sign-out nothing restores the
 *                           account: vault empty, no later Keychain writes,
 *                           next launch signed-out
 *   foregroundPolicy        foreground with <5 min bearer left ⇒ a refresh
 *                           request; with plenty left ⇒ no request
 *   shotsPreserved          local_shot rows identical before/after
 *   noTokenInKv             no bearer/refresh token ever written to SQLite kv
 *   profiledAccountLandsInApp  a signed-in account with a profile ends the
 *                           timeline on ROOT_NAVIGATOR, never ONBOARDING
 *
 * Artifacts: artifactDir()/launch-order.{rows.json,summary.json,md,heap.json}
 * Replay: XC_LP_SEED_FILTER=<seed> XC_LP_SCENARIO_FILTER=<scenario> npx jest …
 */
import React from 'react';
import { AppState, NativeModules, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  PermissionState,
  SchedulerPort,
} from '../../../src/notifications/service';
import type { PlannedNotification } from '../../../src/notifications/types';
import { FakeLocalDb } from '../../../xc-harness/lifecycle-persistence/fakeLocalDb';
import { nodeProcess } from '../../../xc-harness/lifecycle-persistence/nodeShim';
import {
  CANONICAL_ID,
  makePrng,
  pick,
  validProfile,
  validVault,
} from '../../../xc-harness/lifecycle-persistence/seeds';
import {
  heapSnapshot,
  matrixMarkdown,
  summarize,
  writeJsonArtifact,
  writeTextArtifact,
  type MatrixRow,
} from '../../../xc-harness/lifecycle-persistence/artifacts';

// ─── Module seams ────────────────────────────────────────────────────────────

const mockDb = { current: new FakeLocalDb() };
jest.mock('../../../src/data/db', () => ({
  getDb: () => mockDb.current.handle(),
}));

const mockKeychain = {
  store: new Map<string, { username: string; password: string }>(),
  log: [] as { op: 'get' | 'set' | 'reset'; at: number }[],
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
    mockKeychain.log.push({ op: 'set', at: Date.now() });
    mockKeychain.store.set(options.service ?? '__default__', {
      username,
      password,
    });
    return { service: options.service, storage: 'mock' };
  },
  getGenericPassword: async (options: { service?: string } = {}) => {
    mockKeychain.log.push({ op: 'get', at: Date.now() });
    const item = mockKeychain.store.get(options.service ?? '__default__');
    if (!item) return false;
    return { service: options.service, storage: 'mock', ...item };
  },
  resetGenericPassword: async (options: { service?: string } = {}) => {
    mockKeychain.log.push({ op: 'reset', at: Date.now() });
    return mockKeychain.store.delete(options.service ?? '__default__');
  },
}));

const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(),
  signIn: jest.fn(),
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
jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));
const API_BASE = 'https://api.example.test';
jest.mock('../../../src/config/runtimeConfig', () => ({
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
jest.mock('../../../src/account/deviceContext', () => ({
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
  applied: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  async permissionState(): Promise<PermissionState> {
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
jest.mock('../../../src/notifications/service', () => ({
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
jest.mock('../../../src/navigation/RootNavigator', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    RootNavigator: () => R.createElement(RN.Text, null, 'ROOT_NAVIGATOR'),
  };
});
jest.mock('../../../src/screens/OnboardingScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    OnboardingScreen: () => R.createElement(RN.Text, null, 'ONBOARDING'),
  };
});
jest.mock('../../../src/screens/WelcomeScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return { WelcomeScreen: () => R.createElement(RN.Text, null, 'WELCOME') };
});
jest.mock('../../../src/screens/SignInScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return { SignInScreen: () => R.createElement(RN.Text, null, 'SIGN_IN') };
});
jest.mock('../../../src/screens/SplashScreen', () => {
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
jest.mock('../../../src/components/RankUpCelebration', () => ({
  RankUpCelebration: () => null,
}));
jest.mock('../../../src/consistency/StreakCelebration', () => ({
  StreakCelebration: () => null,
}));
jest.mock('../../../src/walkthrough/FirstRunWalkthrough', () => ({
  FirstRunWalkthrough: () => null,
}));
jest.mock('../../../src/design/BrandNotice', () => ({
  BrandNoticeHost: () => null,
}));
jest.mock('../../../src/design/components', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    LoadingState: (props: { label?: string }) =>
      R.createElement(RN.Text, null, `LOADING:${props.label ?? ''}`),
    ErrorState: (props: { title: string; detail?: string }) =>
      R.createElement(
        RN.Text,
        null,
        `ERROR:${props.title}:${props.detail ?? ''}`,
      ),
    BrandSpinner: () => null,
    BrandButton: () => null,
  };
});

import App from '../../../App';
import { useAuthStore } from '../../../src/auth/authStore';
import { useAppStore } from '../../../src/state/appStore';
import { useNotificationStore } from '../../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../../src/consistency/store';
import { useWalkthroughStore } from '../../../src/walkthrough/walkthroughStore';
import {
  clearApiSession,
  getApiSession,
} from '../../../src/account/apiSession';
import { discardSessionKeeper } from '../../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

// ─── Scripted server ─────────────────────────────────────────────────────────

type ServerMode =
  | 'rotate'
  | 'refuse-401'
  | 'refuse-403'
  | 'error-500'
  | 'error-429'
  | 'network'
  | 'hang'
  | 'malformed-200';
type ReusePolicy = 'strict' | 'reuse-10s';
const SERVER_MODES: readonly ServerMode[] = [
  'rotate',
  'refuse-401',
  'refuse-403',
  'error-500',
  'error-429',
  'network',
  'hang',
  'malformed-200',
];

interface RefreshCall {
  /** ms since scenario start (fake clock) */
  at: number;
  token: string;
  outcome: string;
  /** other refresh requests from the SAME process already in flight */
  inflightAtStart: number;
  /** process generation (bumped on kill+relaunch) that issued the request */
  proc: number;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class ScriptedServer {
  mode: ServerMode = 'rotate';
  reuse: ReusePolicy = 'strict';
  latencyMs = 0;
  bearerTtlSec = 3600;
  readonly valid = new Set<string>();
  /** token → successor pair issued when it was rotated away, and when. */
  readonly rotated = new Map<
    string,
    { at: number; successor: { access: string; refresh: string; exp: number } }
  >();
  readonly refreshCalls: RefreshCall[] = [];
  readonly meCalls: number[] = [];
  readonly logoutCalls: number[] = [];
  readonly unexpected: string[] = [];
  /** in-flight refresh requests per process generation */
  readonly inflightByProc = new Map<number, number>();
  /** max concurrent refresh requests from one live process */
  maxInflightSameProc = 0;
  /** max concurrent refresh requests across processes (dead ones included) */
  maxInflightAny = 0;
  proc = 0;
  now: () => number = () => Date.now();
  private counter = 0;
  /** Every refresh token this server ever handed out, in order. */
  readonly issued: string[] = [];

  seed(token: string): void {
    this.valid.add(token);
    this.issued.push(token);
  }

  private delay(
    ms: number,
    signal: AbortSignal | null | undefined,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('AbortError (simulated fetch abort)'));
      });
    });
  }

  private rotate(token: string): {
    access: string;
    refresh: string;
    exp: number;
  } {
    this.counter += 1;
    const successor = {
      access: `access-${this.counter}`,
      refresh: `refresh-${this.counter}`,
      exp: Math.floor(Date.now() / 1000) + this.bearerTtlSec,
    };
    this.valid.delete(token);
    this.valid.add(successor.refresh);
    this.issued.push(successor.refresh);
    this.rotated.set(token, { at: Date.now(), successor });
    return successor;
  }

  readonly fetch = async (
    url: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const signal = init.signal;
    if (url === `${API_BASE}/v1/auth/refresh`) {
      const body = JSON.parse(String(init.body ?? '{}')) as {
        refreshToken?: string;
      };
      const token = String(body.refreshToken ?? '');
      const proc = this.proc;
      const sameProc = this.inflightByProc.get(proc) ?? 0;
      const call: RefreshCall = {
        at: this.now(),
        token,
        outcome: 'pending',
        inflightAtStart: sameProc,
        proc,
      };
      this.refreshCalls.push(call);
      this.inflightByProc.set(proc, sameProc + 1);
      this.maxInflightSameProc = Math.max(
        this.maxInflightSameProc,
        sameProc + 1,
      );
      let any = 0;
      for (const n of this.inflightByProc.values()) any += n;
      this.maxInflightAny = Math.max(this.maxInflightAny, any);
      try {
        if (this.mode === 'hang') {
          // Never answers; the client's 15 s AbortController is what ends it.
          await this.delay(10 * 60_000, signal);
          call.outcome = 'hang-elapsed';
          return new Response(null, { status: 599 });
        }
        await this.delay(this.latencyMs, signal);
        switch (this.mode) {
          case 'refuse-401':
            call.outcome = '401';
            return jsonResponse(401, { error: { message: 'revoked' } });
          case 'refuse-403':
            call.outcome = '403';
            return jsonResponse(403, { error: { message: 'forbidden' } });
          case 'error-500':
            call.outcome = '500';
            return jsonResponse(500, { error: { message: 'boom' } });
          case 'error-429':
            call.outcome = '429';
            return jsonResponse(429, { error: { message: 'slow down' } });
          case 'network':
            call.outcome = 'network-error';
            throw new TypeError('Network request failed');
          case 'malformed-200':
            call.outcome = '200-malformed';
            return new Response('<html>not json</html>', { status: 200 });
          case 'rotate':
          default: {
            if (this.valid.has(token)) {
              const next = this.rotate(token);
              call.outcome = `rotated→${next.refresh}`;
              return jsonResponse(200, {
                session: {
                  accessToken: next.access,
                  refreshToken: next.refresh,
                  expiresAt: next.exp,
                },
              });
            }
            const prior = this.rotated.get(token);
            if (
              prior &&
              this.reuse === 'reuse-10s' &&
              Date.now() - prior.at <= 10_000
            ) {
              call.outcome = `reuse-window→${prior.successor.refresh}`;
              return jsonResponse(200, {
                session: {
                  accessToken: prior.successor.access,
                  refreshToken: prior.successor.refresh,
                  expiresAt: prior.successor.exp,
                },
              });
            }
            call.outcome = prior ? '401-already-rotated' : '401-unknown-token';
            return jsonResponse(401, {
              error: {
                message: 'The session could not be refreshed. Sign in again.',
              },
            });
          }
        }
      } catch (error) {
        if (call.outcome === 'pending') call.outcome = 'aborted-by-client';
        throw error;
      } finally {
        this.inflightByProc.set(proc, (this.inflightByProc.get(proc) ?? 1) - 1);
      }
    }
    if (url === `${API_BASE}/v1/me`) {
      this.meCalls.push(this.now());
      await this.delay(Math.min(this.latencyMs, 200), signal);
      return jsonResponse(200, {
        onboardingState: 'complete',
        profile: {
          skill_level: 'intermediate',
          handedness: 'right',
          primary_goal: 'consistency',
          biggest_problem: 'popups',
          first_name: 'Server',
        },
      });
    }
    if (url === `${API_BASE}/v1/auth/logout`) {
      this.logoutCalls.push(this.now());
      await this.delay(Math.min(this.latencyMs, 200), signal);
      return new Response(null, { status: 204 });
    }
    this.unexpected.push(url);
    return jsonResponse(404, {
      error: { message: 'unexpected route in harness' },
    });
  };
}

// ─── AppState + timeline plumbing ────────────────────────────────────────────

const appStateListeners = new Set<(state: string) => void>();
function emitAppState(state: 'active' | 'background' | 'inactive'): void {
  for (const listener of [...appStateListeners]) listener(state);
}

interface TimelineEvent {
  at: number;
  kind: string;
  detail?: Record<string, unknown>;
}

// ─── Scenario space ──────────────────────────────────────────────────────────

type StepKind =
  | 'remount'
  | 'second-hydrate'
  | 'background'
  | 'foreground'
  | 'kill-relaunch'
  | 'sign-out'
  | 'flip-server-online';

interface Step {
  /** ms after the current launch started */
  atMs: number;
  kind: StepKind;
}

type InstallKind =
  | 'fresh'
  | 'existing-vault'
  | 'existing-vault-no-profile'
  | 'existing-guest'
  | 'existing-signed-out-kv';
const INSTALL_KINDS: readonly InstallKind[] = [
  'fresh',
  'existing-vault',
  'existing-vault-no-profile',
  'existing-guest',
  'existing-signed-out-kv',
];

interface Scenario {
  name: string;
  seed: number | null;
  install: InstallKind;
  mode: ServerMode;
  reuse: ReusePolicy;
  latencyMs: number;
  /** seconds of bearer TTL the server issues on each rotation */
  bearerTtlSec: number;
  steps: Step[];
  /** advance this much after the last step before the final cold relaunch */
  settleMs: number;
}

const FIXED_SCENARIOS: Scenario[] = [
  {
    name: 'cold-fresh-install',
    seed: null,
    install: 'fresh',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 0,
    bearerTtlSec: 3600,
    steps: [],
    settleMs: 1000,
  },
  {
    name: 'cold-existing-online',
    seed: null,
    install: 'existing-vault',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 50,
    bearerTtlSec: 3600,
    steps: [],
    settleMs: 1000,
  },
  {
    name: 'cold-existing-offline',
    seed: null,
    install: 'existing-vault',
    mode: 'network',
    reuse: 'strict',
    latencyMs: 0,
    bearerTtlSec: 3600,
    steps: [],
    settleMs: 1000,
  },
  {
    name: 'cold-existing-hang-then-online',
    seed: null,
    install: 'existing-vault',
    mode: 'hang',
    reuse: 'strict',
    latencyMs: 0,
    bearerTtlSec: 3600,
    steps: [{ atMs: 20_000, kind: 'flip-server-online' }],
    settleMs: 60_000,
  },
  {
    name: 'cold-existing-500-then-online',
    seed: null,
    install: 'existing-vault',
    mode: 'error-500',
    reuse: 'strict',
    latencyMs: 10,
    bearerTtlSec: 3600,
    steps: [{ atMs: 5_000, kind: 'flip-server-online' }],
    settleMs: 60_000,
  },
  {
    name: 'cold-existing-429-then-online',
    seed: null,
    install: 'existing-vault',
    mode: 'error-429',
    reuse: 'strict',
    latencyMs: 10,
    bearerTtlSec: 3600,
    steps: [{ atMs: 5_000, kind: 'flip-server-online' }],
    settleMs: 60_000,
  },
  {
    name: 'cold-existing-malformed-then-online',
    seed: null,
    install: 'existing-vault',
    mode: 'malformed-200',
    reuse: 'strict',
    latencyMs: 10,
    bearerTtlSec: 3600,
    steps: [{ atMs: 5_000, kind: 'flip-server-online' }],
    settleMs: 60_000,
  },
  {
    name: 'cold-existing-revoked-401',
    seed: null,
    install: 'existing-vault',
    mode: 'refuse-401',
    reuse: 'strict',
    latencyMs: 10,
    bearerTtlSec: 3600,
    steps: [],
    settleMs: 1000,
  },
  {
    name: 'cold-existing-revoked-403',
    seed: null,
    install: 'existing-vault',
    mode: 'refuse-403',
    reuse: 'strict',
    latencyMs: 10,
    bearerTtlSec: 3600,
    steps: [],
    settleMs: 1000,
  },
  {
    name: 'cold-existing-slow-refresh-9s',
    seed: null,
    install: 'existing-vault',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 9_000,
    bearerTtlSec: 3600,
    steps: [],
    settleMs: 2000,
  },
  {
    name: 'cold-existing-no-profile-online',
    seed: null,
    install: 'existing-vault-no-profile',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 50,
    bearerTtlSec: 3600,
    steps: [],
    settleMs: 1000,
  },
  {
    name: 'cold-existing-no-profile-slow-9s',
    seed: null,
    install: 'existing-vault-no-profile',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 9_000,
    bearerTtlSec: 3600,
    steps: [],
    settleMs: 2000,
  },
  {
    name: 'cold-guest',
    seed: null,
    install: 'existing-guest',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 0,
    bearerTtlSec: 3600,
    steps: [],
    settleMs: 1000,
  },
  {
    name: 'cold-signed-out-kv',
    seed: null,
    install: 'existing-signed-out-kv',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 0,
    bearerTtlSec: 3600,
    steps: [],
    settleMs: 1000,
  },
  {
    name: 'warm-remount-after-ready',
    seed: null,
    install: 'existing-vault',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 50,
    bearerTtlSec: 3600,
    steps: [{ atMs: 2_000, kind: 'remount' }],
    settleMs: 1000,
  },
  {
    name: 'warm-remount-during-refresh-strict',
    seed: null,
    install: 'existing-vault',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 3_000,
    bearerTtlSec: 3600,
    steps: [{ atMs: 1_000, kind: 'remount' }],
    settleMs: 5000,
  },
  {
    name: 'warm-remount-during-refresh-reuse10s',
    seed: null,
    install: 'existing-vault',
    mode: 'rotate',
    reuse: 'reuse-10s',
    latencyMs: 3_000,
    bearerTtlSec: 3600,
    steps: [{ atMs: 1_000, kind: 'remount' }],
    settleMs: 5000,
  },
  {
    name: 'concurrent-hydrate-during-refresh-strict',
    seed: null,
    install: 'existing-vault',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 3_000,
    bearerTtlSec: 3600,
    steps: [{ atMs: 500, kind: 'second-hydrate' }],
    settleMs: 5000,
  },
  {
    name: 'concurrent-hydrate-immediate',
    seed: null,
    install: 'existing-vault',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 50,
    bearerTtlSec: 3600,
    steps: [{ atMs: 0, kind: 'second-hydrate' }],
    settleMs: 1000,
  },
  {
    name: 'kill-during-refresh-relaunch-strict',
    seed: null,
    install: 'existing-vault',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 3_000,
    bearerTtlSec: 3600,
    steps: [{ atMs: 1_000, kind: 'kill-relaunch' }],
    settleMs: 5000,
  },
  {
    name: 'kill-during-refresh-relaunch-reuse10s',
    seed: null,
    install: 'existing-vault',
    mode: 'rotate',
    reuse: 'reuse-10s',
    latencyMs: 3_000,
    bearerTtlSec: 3600,
    steps: [{ atMs: 1_000, kind: 'kill-relaunch' }],
    settleMs: 5000,
  },
  {
    name: 'foreground-plenty-ttl-no-refresh',
    seed: null,
    install: 'existing-vault',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 50,
    bearerTtlSec: 3600,
    steps: [
      { atMs: 2_000, kind: 'background' },
      { atMs: 4_000, kind: 'foreground' },
    ],
    settleMs: 1000,
  },
  {
    name: 'foreground-short-ttl-refreshes',
    seed: null,
    install: 'existing-vault',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 50,
    bearerTtlSec: 200,
    steps: [
      { atMs: 2_000, kind: 'background' },
      { atMs: 4_000, kind: 'foreground' },
    ],
    settleMs: 1000,
  },
  {
    name: 'foreground-while-offline-keeps-session',
    seed: null,
    install: 'existing-vault',
    mode: 'network',
    reuse: 'strict',
    latencyMs: 0,
    bearerTtlSec: 3600,
    steps: [
      { atMs: 2_000, kind: 'background' },
      { atMs: 4_000, kind: 'foreground' },
      { atMs: 6_000, kind: 'flip-server-online' },
    ],
    settleMs: 60_000,
  },
  {
    name: 'sign-out-then-relaunch',
    seed: null,
    install: 'existing-vault',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 50,
    bearerTtlSec: 3600,
    steps: [{ atMs: 2_000, kind: 'sign-out' }],
    settleMs: 1000,
  },
  {
    name: 'sign-out-during-refresh',
    seed: null,
    install: 'existing-vault',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 3_000,
    bearerTtlSec: 3600,
    steps: [{ atMs: 1_000, kind: 'sign-out' }],
    settleMs: 5000,
  },
  {
    name: 'sign-out-offline-then-relaunch',
    seed: null,
    install: 'existing-vault',
    mode: 'network',
    reuse: 'strict',
    latencyMs: 0,
    bearerTtlSec: 3600,
    steps: [
      { atMs: 2_000, kind: 'sign-out' },
      { atMs: 3_000, kind: 'flip-server-online' },
    ],
    settleMs: 1000,
  },
  {
    name: 'triple-remount-storm',
    seed: null,
    install: 'existing-vault',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 400,
    bearerTtlSec: 3600,
    steps: [
      { atMs: 100, kind: 'remount' },
      { atMs: 300, kind: 'remount' },
      { atMs: 500, kind: 'remount' },
    ],
    settleMs: 5000,
  },
  {
    name: 'keeper-rotation-over-25min',
    seed: null,
    install: 'existing-vault',
    mode: 'rotate',
    reuse: 'strict',
    latencyMs: 50,
    bearerTtlSec: 600,
    steps: [],
    settleMs: 25 * 60_000,
  },
];

const SEEDED_COUNT = Number(nodeProcess.env['XC_LP_LAUNCH_SEEDS'] ?? 400);
const STEP_KINDS: readonly StepKind[] = [
  'remount',
  'second-hydrate',
  'background',
  'foreground',
  'kill-relaunch',
  'sign-out',
  'flip-server-online',
];

function seededScenario(seed: number): Scenario {
  const rng = makePrng(seed);
  const stepCount = Math.floor(rng() * 4);
  const steps: Step[] = [];
  let cursor = 0;
  let signedOut = false;
  for (let i = 0; i < stepCount; i += 1) {
    cursor += Math.floor(rng() * 6000);
    let kind = pick(rng, STEP_KINDS);
    if (signedOut && (kind === 'sign-out' || kind === 'second-hydrate'))
      kind = 'foreground';
    if (kind === 'sign-out') signedOut = true;
    // A background must precede a foreground for AppState realism.
    if (
      kind === 'foreground' &&
      steps[steps.length - 1]?.kind !== 'background'
    ) {
      steps.push({ atMs: cursor, kind: 'background' });
      cursor += 200;
    }
    steps.push({ atMs: cursor, kind });
  }
  const latencyMs = pick(rng, [0, 50, 400, 3_000, 9_000, 14_000]);
  const mode = pick(rng, SERVER_MODES);
  const install = pick(rng, INSTALL_KINDS);
  return {
    name: `seeded-${seed}`,
    seed,
    install,
    mode,
    reuse: pick(rng, ['strict', 'reuse-10s'] as const),
    latencyMs,
    bearerTtlSec: pick(rng, [120, 200, 600, 3600]),
    steps,
    settleMs: pick(rng, [1_000, 5_000, 60_000]),
  };
}

// ─── Per-scenario runner ─────────────────────────────────────────────────────

const VAULT_SERVICE = 'com.picklesensei.auth.session';
const INITIAL_REFRESH = 'refresh-initial';
const CANONICAL_OWNER = canonicalDataOwner(CANONICAL_ID);
const LAUNCH_DEADLINE_MS = 8_000;

interface LaunchState {
  renderer: ReturnType<typeof TestRenderer.create> | null;
  launchStartedAt: number;
  launchIndex: number;
}

function renderedText(
  renderer: ReturnType<typeof TestRenderer.create> | null,
): string {
  if (!renderer) return '<unmounted>';
  try {
    const texts = renderer.root
      .findAllByType(Text)
      .map(node => String(node.props['children']));
    return texts.join('|');
  } catch {
    return '<no-text>';
  }
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

function desiredOwnerNow(): string | null {
  const auth = useAuthStore.getState();
  if (!auth.hydrated) return null;
  return auth.session?.provider === 'guest'
    ? 'device-guest'
    : auth.session?.canonicalAppUserId
      ? canonicalDataOwner(auth.session.canonicalAppUserId)
      : SIGNED_OUT_DATA_OWNER;
}

let processResetting = false;

function resetProcessState(): void {
  // Equivalent of the OS killing the process: every in-memory singleton is
  // gone (a refresh request on the wire with it), only Keychain + SQLite
  // survive.
  processResetting = true;
  clearSyncRuntime();
  discardSessionKeeper();
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
  processResetting = false;
}

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

async function runScenario(scenario: Scenario): Promise<MatrixRow> {
  const startedWall = Date.now();
  jest.setSystemTime(new Date('2026-03-01T09:00:00.000Z'));
  const t0 = Date.now();
  const rel = () => Date.now() - t0;
  const timeline: TimelineEvent[] = [];
  const log = (kind: string, detail?: Record<string, unknown>) => {
    timeline.push({ at: rel(), kind, ...(detail ? { detail } : {}) });
  };

  // Persisted world.
  const db = new FakeLocalDb();
  mockDb.current = db;
  mockKeychain.store.clear();
  mockKeychain.log.length = 0;
  const server = new ScriptedServer();
  server.mode = scenario.mode;
  server.reuse = scenario.reuse;
  server.latencyMs = scenario.latencyMs;
  server.bearerTtlSec = scenario.bearerTtlSec;
  server.now = rel;
  (globalThis as { fetch: unknown }).fetch = server.fetch;
  mockScheduler.current = new FakeScheduler();

  let expectedOwnerAtStart: string = SIGNED_OUT_DATA_OWNER;
  if (
    scenario.install === 'existing-vault' ||
    scenario.install === 'existing-vault-no-profile'
  ) {
    mockKeychain.store.set(VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify(validVault({ refreshToken: INITIAL_REFRESH })),
    });
    server.seed(INITIAL_REFRESH);
    db.seedShots(CANONICAL_OWNER, 40, 'real');
    if (scenario.install === 'existing-vault') {
      db.kv.set(`profile:${CANONICAL_OWNER}`, JSON.stringify(validProfile()));
    }
    db.kv.set('walkthrough.device-complete', JSON.stringify({ version: 1 }));
    expectedOwnerAtStart = CANONICAL_OWNER;
  } else if (scenario.install === 'existing-guest') {
    db.kv.set('auth.local-mode', JSON.stringify({ version: 1, mode: 'guest' }));
    db.kv.set('profile:device-guest', JSON.stringify(validProfile()));
    db.seedShots('device-guest', 12, 'real');
    expectedOwnerAtStart = 'device-guest';
  } else if (scenario.install === 'existing-signed-out-kv') {
    db.kv.set(
      'auth.local-mode',
      JSON.stringify({ version: 1, mode: 'signed-out' }),
    );
    db.kv.set('auth.last-provider', '');
    db.seedShots(CANONICAL_OWNER, 7, 'real');
  }
  // Rows that belong to nobody reachable must still never be touched.
  db.seedShots('other-owner', 3, 'stranger');
  const shotsBefore = db.shotFingerprint();

  resetProcessState();

  // ── Store subscriptions: record ordering facts as they happen.
  const unsubscribers: (() => void)[] = [];
  let authHydratedAt: number | null = null;
  let appHydrateStartsBeforeAuth = 0;
  let appHydrateStartsBeforeAuthTimestamp = 0;
  let ownerMismatchAtAppStart = 0;
  let firstAppHydrateOwner: string | null = null;
  let signedOutBeforeFirstAppHydrate = false;
  let ownerMismatchAtStoreFinish = 0;
  const signOutEvents: { at: number; from: string }[] = [];
  const launches: {
    index: number;
    startedAt: number;
    /** ms after startedAt at which the process was killed/unmounted, if it was */
    endedAfterMs: number | null;
    readyAt: number | null;
    readyText: string | null;
  }[] = [];

  unsubscribers.push(
    useAuthStore.subscribe((next, prev) => {
      if (!prev.hydrated && next.hydrated) {
        authHydratedAt = rel();
        log('auth.hydrated', {
          session: next.session
            ? `${next.session.provider}:${next.session.canonicalAppUserId ?? '-'}`
            : null,
          activeOwner: getActiveDataOwner(),
        });
      }
      if (prev.session && !next.session) {
        // A process kill drops the in-memory session too; that is not a
        // sign-out (the vault record survives).
        if (!processResetting)
          signOutEvents.push({ at: rel(), from: prev.session.provider });
        log('auth.session-cleared', {
          from: prev.session.provider,
          processKill: processResetting,
        });
      }
      if (!prev.session && next.session) {
        log('auth.session-set', {
          session: `${next.session.provider}:${next.session.canonicalAppUserId ?? '-'}`,
        });
      }
    }),
  );
  unsubscribers.push(
    useAppStore.subscribe((next, prev) => {
      // hydrate() begins by set({hydrated:false, ownerKey: owner, profile: null})
      if (prev.hydrated !== false || prev.ownerKey !== next.ownerKey) {
        if (!next.hydrated && next.ownerKey) {
          const authNow = useAuthStore.getState();
          if (!authNow.hydrated) appHydrateStartsBeforeAuth += 1;
          const launch = launches[launches.length - 1];
          if (
            launch &&
            authHydratedAt !== null &&
            authHydratedAt < launch.startedAt
          ) {
            // auth.hydrated stamp predates this launch: app hydration ran on
            // a stale auth result.
            appHydrateStartsBeforeAuthTimestamp += 1;
          }
          if (firstAppHydrateOwner === null) {
            firstAppHydrateOwner = next.ownerKey;
            signedOutBeforeFirstAppHydrate = signOutEvents.length > 0;
          }
          const desired = desiredOwnerNow();
          if (desired !== null && desired !== next.ownerKey)
            ownerMismatchAtAppStart += 1;
          log('app.hydrate-start', {
            owner: next.ownerKey,
            authHydrated: authNow.hydrated,
            desired,
          });
        }
      }
      if (!prev.hydrated && next.hydrated) {
        if (next.ownerKey !== getActiveDataOwner())
          ownerMismatchAtStoreFinish += 1;
        log('app.hydrated', {
          owner: next.ownerKey,
          activeOwner: getActiveDataOwner(),
          profile: next.profile ? 'present' : null,
          hydrateError: next.hydrateError,
        });
      }
    }),
  );
  unsubscribers.push(
    useNotificationStore.subscribe((next, prev) => {
      if (!prev.hydrated && next.hydrated) {
        if (next.ownerKey !== getActiveDataOwner())
          ownerMismatchAtStoreFinish += 1;
        log('notifications.hydrated', {
          owner: next.ownerKey,
          activeOwner: getActiveDataOwner(),
        });
      }
    }),
  );
  unsubscribers.push(
    useConsistencyStore.subscribe((next, prev) => {
      if (!prev.hydrated && next.hydrated) {
        if (next.ownerKey !== getActiveDataOwner())
          ownerMismatchAtStoreFinish += 1;
        log('consistency.hydrated', {
          owner: next.ownerKey,
          activeOwner: getActiveDataOwner(),
        });
      }
    }),
  );

  const state: LaunchState = {
    renderer: null,
    launchStartedAt: 0,
    launchIndex: 0,
  };
  let errorBoundarySeen = false;
  const hydrateRejections: string[] = [];
  const secondHydratePromises: Promise<void>[] = [];

  const observeReady = () => {
    const launch = launches[launches.length - 1];
    if (launch && launch.readyAt === null && gateReady()) {
      launch.readyAt = rel() - launch.startedAt;
      launch.readyText = renderedText(state.renderer);
      log('gate.ready', { launch: launch.index, text: launch.readyText });
    }
    if (
      state.renderer &&
      renderedText(state.renderer).includes('Something went wrong')
    ) {
      errorBoundarySeen = true;
    }
  };

  const mount = (why: string) => {
    state.launchStartedAt = rel();
    state.launchIndex += 1;
    launches.push({
      index: state.launchIndex,
      startedAt: state.launchStartedAt,
      endedAfterMs: null,
      readyAt: null,
      readyText: null,
    });
    log('mount', { why, launch: state.launchIndex });
    act(() => {
      state.renderer = TestRenderer.create(<App />);
    });
  };
  const unmount = (why: string) => {
    log('unmount', { why });
    const launch = launches[launches.length - 1];
    if (launch && launch.endedAfterMs === null)
      launch.endedAfterMs = rel() - launch.startedAt;
    act(() => {
      state.renderer?.unmount();
    });
    state.renderer = null;
  };

  /** Advance the fake clock in small slices so readiness is stamped precisely. */
  const advance = async (ms: number) => {
    let left = ms;
    while (left > 0) {
      const slice = Math.min(left, 250);
      await flush(slice);
      left -= slice;
      observeReady();
    }
  };

  // ── Cold launch.
  mount('cold-launch');
  await flush(0);
  observeReady();

  let cursor = 0;
  let explicitSignOutAt: number | null = null;
  const foregroundChecks: {
    at: number;
    bearerLeftMs: number | null;
    refreshCallsBefore: number;
    refreshCallsAfter1s: number;
  }[] = [];
  const pendingForegroundChecks: {
    at: number;
    bearerLeftMs: number | null;
    refreshCallsBefore: number;
  }[] = [];
  const settleForeground = () => {
    for (const check of pendingForegroundChecks) {
      if (rel() - check.at >= 1000) {
        foregroundChecks.push({
          ...check,
          refreshCallsAfter1s: server.refreshCalls.filter(
            c => c.at >= check.at && c.at <= check.at + 1000,
          ).length,
        });
      }
    }
    for (const done of foregroundChecks) {
      const idx = pendingForegroundChecks.findIndex(p => p.at === done.at);
      if (idx >= 0) pendingForegroundChecks.splice(idx, 1);
    }
  };

  for (const step of scenario.steps) {
    const wait = Math.max(0, step.atMs - cursor);
    await advance(wait);
    cursor = step.atMs;
    settleForeground();
    log(`step.${step.kind}`);
    switch (step.kind) {
      case 'remount':
        unmount('remount');
        mount('remount');
        await flush(0);
        break;
      case 'second-hydrate': {
        const p = useAuthStore
          .getState()
          .hydrate()
          .catch((error: unknown) => {
            hydrateRejections.push(
              `second-hydrate: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        secondHydratePromises.push(p);
        await flush(0);
        break;
      }
      case 'background':
        act(() => emitAppState('background'));
        await flush(0);
        break;
      case 'foreground': {
        const api = getApiSession();
        pendingForegroundChecks.push({
          at: rel(),
          bearerLeftMs:
            api?.bearerExpiresAtMs != null
              ? api.bearerExpiresAtMs - Date.now()
              : null,
          refreshCallsBefore: server.refreshCalls.length,
        });
        act(() => emitAppState('active'));
        await flush(0);
        break;
      }
      case 'kill-relaunch':
        unmount('kill');
        resetProcessState();
        server.proc += 1;
        cursor = 0;
        mount('relaunch-after-kill');
        await flush(0);
        break;
      case 'sign-out': {
        explicitSignOutAt = rel();
        const p = useAuthStore
          .getState()
          .signOut()
          .catch((error: unknown) => {
            hydrateRejections.push(
              `signOut: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        secondHydratePromises.push(p);
        await flush(0);
        break;
      }
      case 'flip-server-online':
        server.mode = 'rotate';
        server.latencyMs = Math.min(server.latencyMs, 50);
        break;
    }
    observeReady();
  }

  await advance(scenario.settleMs);
  settleForeground();
  // Whatever the settle window, make sure the launch deadline has passed
  // for the current launch so `hydrated` is stamped for every mode.
  const currentLaunch = launches[launches.length - 1]!;
  const sinceLaunch = rel() - currentLaunch.startedAt;
  if (sinceLaunch < LAUNCH_DEADLINE_MS + 2_000)
    await advance(LAUNCH_DEADLINE_MS + 2_000 - sinceLaunch);
  settleForeground();

  const midSession = useAuthStore.getState().session;
  const midApi = getApiSession();
  const midText = renderedText(state.renderer);
  const midVaultRaw = mockKeychain.store.get(VAULT_SERVICE)?.password ?? null;

  // ── Next-day cold relaunch with the server healthy.
  log('next-day-relaunch');
  unmount('next-day');
  resetProcessState();
  server.proc += 1;
  server.mode = 'rotate';
  server.latencyMs = 50;
  jest.setSystemTime(new Date(Date.now() + 24 * 3600_000));
  mount('next-day-cold');
  await flush(0);
  await advance(LAUNCH_DEADLINE_MS + 2_000);
  const finalText = renderedText(state.renderer);
  const finalSession = useAuthStore.getState().session;
  const finalApi = getApiSession();
  const finalVaultRaw = mockKeychain.store.get(VAULT_SERVICE)?.password ?? null;
  unmount('end');
  await Promise.all(secondHydratePromises);
  for (const unsubscribe of unsubscribers) unsubscribe();
  clearSyncRuntime();
  discardSessionKeeper();
  clearApiSession();

  // ── Oracle.
  const vaultToken = (raw: string | null): string | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { refreshToken?: unknown };
      return typeof parsed.refreshToken === 'string'
        ? parsed.refreshToken
        : null;
    } catch {
      return null;
    }
  };
  const midVaultToken = vaultToken(midVaultRaw);
  const finalVaultToken = vaultToken(finalVaultRaw);
  const accountInstall =
    scenario.install === 'existing-vault' ||
    scenario.install === 'existing-vault-no-profile';
  const refusedOutcomes = server.refreshCalls.filter(
    c => c.outcome.startsWith('401') || c.outcome.startsWith('403'),
  );
  const legitimateRefusal = refusedOutcomes.some(
    c => c.outcome === '401' || c.outcome === '403',
  );
  const staleRefusal = refusedOutcomes.some(
    c =>
      c.outcome === '401-already-rotated' || c.outcome === '401-unknown-token',
  );
  // Rotations the server completed whose successor the client never persisted.
  const deliveredSuccessors = server.refreshCalls
    .filter(
      c =>
        c.outcome.startsWith('rotated→') ||
        c.outcome.startsWith('reuse-window→'),
    )
    .map(c => c.outcome.split('→')[1]!);
  const lastDelivered =
    deliveredSuccessors[deliveredSuccessors.length - 1] ?? null;
  const keychainSetsAfterSignOut =
    explicitSignOutAt === null
      ? 0
      : mockKeychain.log.filter(
          e => e.op === 'set' && e.at - t0 > explicitSignOutAt!,
        ).length;
  const kvTokenLeak = db
    .kvWrites()
    .some(w => /refresh-|access-|refreshToken|bearerToken/.test(w.value));

  const invariants: Record<string, boolean> = {};
  invariants['noCrash'] = !errorBoundarySeen && hydrateRejections.length === 0;
  // A remount reuses the already-hydrated auth state by design (App.tsx keeps
  // the stores alive across Gate remounts), so only an app hydrate that
  // starts while auth.hydrated is false breaks auth-first ordering.
  invariants['authFirst'] = appHydrateStartsBeforeAuth === 0;
  invariants['ownerSelectedFromAuth'] = ownerMismatchAtAppStart === 0;
  // The cold launch must partition local data under the owner the persisted
  // state (vault record / guest kv / nothing) designates. A sign-out that
  // lands before app hydration (server refusal, explicit sign-out) moves it
  // to signed-out; whether that sign-out was allowed is noImplicitSignOut's
  // job.
  invariants['coldOwnerFromPersistedState'] =
    firstAppHydrateOwner ===
    (signedOutBeforeFirstAppHydrate
      ? SIGNED_OUT_DATA_OWNER
      : expectedOwnerAtStart);
  invariants['ownerAgreement'] = ownerMismatchAtStoreFinish === 0;
  // A launch the OS killed (or the harness remounted) before the deadline
  // cannot be judged for readiness; every launch that lived long enough must
  // have become ready inside the deadline.
  invariants['readyWithinDeadline'] = launches.every(l =>
    l.endedAfterMs !== null &&
    l.endedAfterMs < LAUNCH_DEADLINE_MS + 1_500 &&
    l.readyAt === null
      ? true
      : l.readyAt !== null && l.readyAt <= LAUNCH_DEADLINE_MS + 1_500,
  );
  invariants['singleInflightRefresh'] = server.maxInflightSameProc <= 1;
  invariants['shotsPreserved'] =
    db.shotFingerprint() === shotsBefore &&
    db.destructiveStatements().length === 0;
  invariants['noTokenInKv'] = !kvTokenLeak;
  invariants['noUnexpectedRoutes'] = server.unexpected.length === 0;

  if (accountInstall && explicitSignOutAt === null) {
    // The one allowed rule: a 401/403 the server issued for a token the client
    // legitimately held. A refusal caused by the client presenting an already-
    // rotated token it should have replaced is NOT that rule.
    const endedSignedIn =
      finalSession?.provider === 'apple' &&
      finalSession.canonicalAppUserId === CANONICAL_ID;
    invariants['noImplicitSignOut'] = legitimateRefusal ? true : endedSignedIn;
    invariants['noRotationLoss'] =
      lastDelivered === null || legitimateRefusal
        ? true
        : finalVaultToken === lastDelivered ||
          server.valid.has(finalVaultToken ?? '');
    invariants['vaultTokenServerValid'] = legitimateRefusal
      ? finalVaultRaw === null
      : finalVaultToken !== null && server.valid.has(finalVaultToken);
    invariants['profiledAccountLandsInApp'] = legitimateRefusal
      ? finalText.includes('WELCOME')
      : finalText.includes('ROOT_NAVIGATOR');
  }
  if (explicitSignOutAt !== null) {
    invariants['signOutDurable'] =
      finalSession === null &&
      finalVaultRaw === null &&
      keychainSetsAfterSignOut === 0 &&
      finalText.includes('WELCOME') &&
      finalApi === null;
  }
  if (scenario.install === 'existing-guest' && explicitSignOutAt === null) {
    invariants['guestRestored'] =
      finalSession?.provider === 'guest' &&
      finalText.includes('ROOT_NAVIGATOR') &&
      server.refreshCalls.length === 0;
  }
  if (
    scenario.install === 'fresh' ||
    scenario.install === 'existing-signed-out-kv'
  ) {
    invariants['signedOutLandsOnWelcome'] =
      finalSession === null &&
      finalText.includes('WELCOME') &&
      server.refreshCalls.length === 0;
  }
  if (foregroundChecks.length > 0) {
    invariants['foregroundPolicy'] = foregroundChecks.every(check => {
      if (check.bearerLeftMs === null) return true; // no api session at that moment: nothing to refresh
      return check.bearerLeftMs < 5 * 60_000
        ? check.refreshCallsAfter1s >= 1
        : check.refreshCallsAfter1s === 0;
    });
  }

  const failed = Object.entries(invariants)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    suite: 'launch-order',
    scenario: scenario.name,
    seed: scenario.seed,
    inputs: {
      install: scenario.install,
      mode: scenario.mode,
      reuse: scenario.reuse,
      latencyMs: scenario.latencyMs,
      bearerTtlSec: scenario.bearerTtlSec,
      steps: scenario.steps,
      settleMs: scenario.settleMs,
    },
    observed: {
      timeline,
      launches,
      refreshCalls: server.refreshCalls,
      maxInflightSameProc: server.maxInflightSameProc,
      maxInflightAny: server.maxInflightAny,
      meCalls: server.meCalls.length,
      logoutCalls: server.logoutCalls.length,
      serverValidTokens: [...server.valid],
      issuedTokens: server.issued,
      keychainOps: mockKeychain.log.map(e => `${e.op}@${e.at - t0}`),
      midSession: midSession
        ? `${midSession.provider}:${midSession.canonicalAppUserId ?? '-'}`
        : null,
      midApiBearer: midApi?.bearerToken ?? null,
      midVaultToken,
      midText,
      finalSession: finalSession
        ? `${finalSession.provider}:${finalSession.canonicalAppUserId ?? '-'}`
        : null,
      finalApiBearer: finalApi?.bearerToken ?? null,
      finalVaultToken,
      finalText,
      signOutEvents,
      foregroundChecks,
      hydrateRejections,
      appHydrateStartsOnStaleAuth: appHydrateStartsBeforeAuthTimestamp,
      launchesStuckLoading: launches
        .filter(
          l =>
            l.readyAt === null &&
            (l.endedAfterMs === null ||
              l.endedAfterMs >= LAUNCH_DEADLINE_MS + 1_500),
        )
        .map(l => l.index),
      staleRefusal,
      legitimateRefusal,
      lastDelivered,
      errorBoundarySeen,
    },
    invariants,
    ok: failed.length === 0,
    failed,
    durationMs: Date.now() - startedWall,
  };
}

// ─── Known deviations (rows whose failure set is exactly explained) ─────────

//
// Re-entrant hydration (Gate remount / second hydrate()) is NOT a deviation:
// a rotation that lands after stopSessionKeeper() must still be delivered and
// persisted, a re-started keeper must join the refresh already in flight for
// its token instead of presenting it twice, and the Gate must re-drive
// appStore.hydrate() once the re-entrant auth hydration settles.

const KNOWN_DEVIATIONS = {
  'XC-LP-7':
    'process kill during an in-flight refresh: the server rotated, the client never received it, the vault keeps the pre-rotation token; on relaunch a strict single-use server answers 401 and the client signs out. Client-side only a persist-before-use ordering or a server reuse window can mitigate.',
} as const;
type DeviationId = keyof typeof KNOWN_DEVIATIONS;

function classifyDeviation(row: MatrixRow): DeviationId | null {
  const inputs = row.inputs as {
    steps: Step[];
    mode: ServerMode;
    reuse: ReusePolicy;
  };
  const observed = row.observed as { staleRefusal: boolean };
  const kinds = inputs.steps.map(s => s.kind);
  const explainedByStaleToken = new Set([
    'noImplicitSignOut',
    'noRotationLoss',
    'vaultTokenServerValid',
    'profiledAccountLandsInApp',
  ]);
  const unexplained = row.failed.filter(
    name => !explainedByStaleToken.has(name),
  );
  if (unexplained.length > 0) return null;
  if (!observed.staleRefusal || inputs.reuse !== 'strict') return null;
  if (kinds.includes('kill-relaunch')) return 'XC-LP-7';
  return null;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

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
  nativeModules.PickleAuth = { signInWithApple: jest.fn() };
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  delete nativeModules.PickleAuth;
  jest.useRealTimers();
});

describe('XC matrix-lifecycle-persistence — harness C: launch ordering', () => {
  const rows: MatrixRow[] = [];
  const seedFilter = nodeProcess.env['XC_LP_SEED_FILTER'];
  const scenarioFilter = nodeProcess.env['XC_LP_SCENARIO_FILTER'];

  const fixed = FIXED_SCENARIOS.filter(
    s => !scenarioFilter || s.name === scenarioFilter,
  ).filter(() => !seedFilter);
  const seeded = seedFilter
    ? [seededScenario(Number(seedFilter))]
    : scenarioFilter
      ? []
      : Array.from({ length: SEEDED_COUNT }, (_, i) =>
          seededScenario(1000 + i),
        );

  for (const scenario of fixed) {
    it(`fixed: ${scenario.name}`, async () => {
      rows.push(await runScenario(scenario));
    }, 120_000);
  }

  const CHUNK = 50;
  for (let start = 0; start < seeded.length; start += CHUNK) {
    const slice = seeded.slice(start, start + CHUNK);
    it(`seeded ${slice[0]!.seed}..${slice[slice.length - 1]!.seed}`, async () => {
      for (const scenario of slice) rows.push(await runScenario(scenario));
    }, 600_000);
  }

  it('writes artifacts and every failure is a catalogued deviation', () => {
    const deviations: Record<DeviationId, MatrixRow[]> = {
      'XC-LP-7': [],
    };
    const untriaged: MatrixRow[] = [];
    for (const row of rows) {
      if (row.ok) continue;
      const id = classifyDeviation(row);
      if (id) deviations[id].push(row);
      else untriaged.push(row);
    }
    const summary = {
      ...summarize(rows),
      deviations: Object.fromEntries(
        Object.entries(deviations).map(([id, list]) => [
          id,
          {
            description: KNOWN_DEVIATIONS[id as DeviationId],
            rows: list.length,
            scenarios: list.map(r => ({
              scenario: r.scenario,
              seed: r.seed,
              failed: r.failed,
              inputs: r.inputs,
            })),
          },
        ]),
      ),
      untriaged: untriaged.map(r => ({
        scenario: r.scenario,
        seed: r.seed,
        failed: r.failed,
        inputs: r.inputs,
      })),
      replay:
        'cd apps/mobile && XC_LP_SEED_FILTER=<seed> npx jest --ci __tests__/xc/lifecycle-persistence/launchOrderMatrix.xc.test.tsx  (or XC_LP_SCENARIO_FILTER=<name>)',
    };
    const paths = [
      writeJsonArtifact('launch-order.rows.json', rows),
      writeJsonArtifact('launch-order.summary.json', summary),
      writeTextArtifact('launch-order.md', matrixMarkdown(rows)),
      writeJsonArtifact('launch-order.heap.json', heapSnapshot()),
    ];
    console.log(
      JSON.stringify({
        harness: 'C',
        rows: rows.length,
        untriaged: untriaged.length,
        deviations: Object.fromEntries(
          Object.entries(deviations).map(([k, v]) => [k, v.length]),
        ),
        paths,
      }),
    );
    expect(
      untriaged.map(r => ({
        scenario: r.scenario,
        seed: r.seed,
        failed: r.failed,
      })),
    ).toEqual([]);
  });
});
