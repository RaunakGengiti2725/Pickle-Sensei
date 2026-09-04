/**
 * STRESS — scr-onboardingscreen × failure-injection.
 *
 * Mounts the REAL <App /> (Gate + RootErrorBoundary + SafeAreaProvider +
 * QueryClientProvider) against the real authStore / appStore /
 * notificationStore / consistencyStore / sessionKeeper and the real
 * WelcomeScreen → OnboardingScreen → SignInScreen pre-auth flow, with only the
 * process edges faked: a Keychain map, an in-memory SQLite (FakeLocalDb), the
 * OS notification scheduler, the Google SDK, a scripted HTTP server for
 * /v1/auth/refresh, /v1/me, /v1/me/onboarding and /v1/auth/logout, and the
 * clock (jest fake timers). RootNavigator (post-onboarding destination),
 * SplashScreen (react-native-video) and the celebration overlays are stubbed
 * because they are not dependencies of the unit.
 *
 * Every scenario walks the questionnaire to the notification step with one or
 * more injected faults (throw / reject / timeout / malformed / partial / slow /
 * never-resolves) on the unit's dependencies — SQLite kv, fetch, Keychain,
 * notification permission + scheduler, clock, navigation and pre-existing
 * persisted state — then presses the finishing control and asserts:
 *
 *   unitReached          the real OnboardingScreen rendered inside the Gate
 *   noCrash              no RootErrorBoundary, no unhandled rejection, no throw
 *   noStuckSpinner       after ≤60 s of fake time nothing is "Finishing setup…"
 *                        and the store is not busy
 *   visibleControl       progressed, or an ENABLED finish/back/leave control
 *   noSilentFailure      not progressed ⇒ the error copy is on screen;
 *                        progressed ⇒ the notification choice was persisted
 *   noFakeSuccess        progressed ⇒ the profile the user answered is durably
 *                        persisted (and, for a synced account, server-accepted)
 *   persistedStateSane   every onboarding kv slot is absent/''/well-formed and
 *                        no token material is in SQLite
 *   firstAttemptAsExpected  the fault's documented first-attempt outcome
 *   recoverable          after the faults clear, ONE more tap finishes setup
 *                        with the very same answers (nothing was lost)
 *   singleWrite          a double-tap never writes the profile twice
 *
 * Determinism: every scenario is a pure function of its name / 32-bit seed
 * (mulberry32). Replay:
 *   STRESS_SCENARIO=<name substring> npx jest --ci __tests__/stress/onboardingScreen.failureInjection.stress.test.tsx
 *   STRESS_SEED=<seed>[,<seed>…]      (seeded random combinations)
 *   STRESS_ITER=<n>   extra seeded combinations (default 10; 0 disables)
 *   STRESS_FULL=1     run every fault in EVERY applicable mode (default: one
 *                     representative mode per fault)
 * Artifacts: artifacts/stress-onboarding/failure-injection.{rows,summary}.json
 */
import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';
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
  RAW_STRING_VARIANTS,
  makePrng,
  pick,
  validVault,
} from '../../xc-harness/lifecycle-persistence/seeds';

declare const __dirname: string;

// ─── Fault knobs (read by every mock at CALL time, never at import time) ────

type RequestPermissionMode =
  | 'granted'
  | 'denied'
  | 'undetermined'
  | 'throw'
  | 'reject'
  | 'hang'
  | 'slow-5s'
  | 'malformed';
type ApplyPlanMode = 'ok' | 'throw' | 'hang' | 'slow-5s';
type CancelMode = 'ok' | 'throw' | 'hang';
type PermissionStateMode = 'ok' | 'throw' | 'hang';
type OnboardingPutMode =
  | 'ok'
  | 'network'
  | '500'
  | '401'
  | '429'
  | '400-message'
  | '503-html'
  | 'malformed-json'
  | 'empty-object'
  | 'invalid-checkpoint'
  | 'partial-json'
  | 'slow-5s'
  | 'slow-14s'
  | 'hang'
  | 'fail-once-network'
  | 'fail-once-500';
type MeMode = 'incomplete' | 'malformed' | 'complete-invalid';
type LogoutMode = 'ok' | '500' | 'network' | 'hang';

interface Faults {
  db: {
    openThrows: string | null;
    allThrow: string | null;
    kvSetThrows: Set<string>;
    kvGetThrows: Set<string>;
    latencyMs: number;
    hangAll: boolean;
    hangSetKeys: Set<string>;
    throwOnceSetKeys: Set<string>;
  };
  keychain: {
    getThrows: boolean;
    getMalformed: string | null;
    setThrows: boolean;
    resetThrows: boolean;
    resetHangs: boolean;
  };
  scheduler: {
    request: RequestPermissionMode;
    apply: ApplyPlanMode;
    cancel: CancelMode;
    state: PermissionStateMode;
  };
  server: {
    refreshLatencyMs: number;
    me: MeMode;
    onboardingPut: OnboardingPutMode;
    logout: LogoutMode;
    /** seconds the client clock is AHEAD of the server (bearer exp skew) */
    clockSkewSec: number;
  };
  google: { signOutThrows: boolean };
}

function neutralFaults(): Faults {
  return {
    db: {
      openThrows: null,
      allThrow: null,
      kvSetThrows: new Set(),
      kvGetThrows: new Set(),
      latencyMs: 0,
      hangAll: false,
      hangSetKeys: new Set(),
      throwOnceSetKeys: new Set(),
    },
    keychain: {
      getThrows: false,
      getMalformed: null,
      setThrows: false,
      resetThrows: false,
      resetHangs: false,
    },
    scheduler: { request: 'granted', apply: 'ok', cancel: 'ok', state: 'ok' },
    server: {
      refreshLatencyMs: 50,
      me: 'incomplete',
      onboardingPut: 'ok',
      logout: 'ok',
      clockSkewSec: 0,
    },
    google: { signOutThrows: false },
  };
}

function mockNever<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Module seams ────────────────────────────────────────────────────────────

const API_BASE = 'https://api.example.test';
/** "never resolves" for the client's purposes (its own 15 s abort ends it). */
const HANG_MS = 10 * 60_000;
/** advanced after every scenario so no in-flight timer leaks into the next */
const DRAIN_MS = 15 * 60_000;
const VAULT_SERVICE = 'com.picklesensei.auth.session';
const PENDING_PROFILE_KEY = 'onboarding.pending-profile';
const PENDING_NOTIFICATIONS_KEY = 'onboarding.pending-notifications';
const CANONICAL_OWNER = CANONICAL_ID.toLowerCase();
const GUEST_OWNER = 'device-guest';

class FaultScheduler implements SchedulerPort {
  permission: PermissionState = 'undetermined';
  readonly calls: string[] = [];
  applied: PlannedNotification[][] = [];
  async permissionState(): Promise<PermissionState> {
    this.calls.push('permissionState');
    const mode = mockWorld.faults.scheduler.state;
    if (mode === 'throw') throw new Error('UNNotificationCenter unavailable');
    if (mode === 'hang') return mockNever();
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    this.calls.push('requestPermission');
    const mode = mockWorld.faults.scheduler.request;
    switch (mode) {
      case 'throw':
        throw new Error('requestPermission threw (simulated)');
      case 'reject':
        await sleep(20);
        throw new Error('requestPermission rejected (simulated)');
      case 'hang':
        return mockNever();
      case 'slow-5s':
        await sleep(5_000);
        this.permission = 'granted';
        return 'granted';
      case 'malformed':
        return 'maybe' as unknown as PermissionState;
      default:
        this.permission = mode;
        return mode;
    }
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.calls.push('applyPlan');
    const mode = mockWorld.faults.scheduler.apply;
    if (mode === 'throw') throw new Error('applyPlan threw (simulated)');
    if (mode === 'hang') return mockNever();
    if (mode === 'slow-5s') await sleep(5_000);
    this.applied.push([...plan]);
  }
  async cancelAllPlanned(): Promise<void> {
    this.calls.push('cancelAllPlanned');
    const mode = mockWorld.faults.scheduler.cancel;
    if (mode === 'throw') throw new Error('cancelAllPlanned threw (simulated)');
    if (mode === 'hang') return mockNever();
  }
  async openSystemSettings(): Promise<void> {}
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class ScriptedServer {
  readonly validRefresh = new Set<string>();
  readonly refreshCalls: string[] = [];
  readonly meCalls: number[] = [];
  readonly logoutCalls: string[] = [];
  readonly onboardingPuts: { body: unknown; outcome: string }[] = [];
  /** Profiles the server durably accepted (200) — server truth. */
  readonly acceptedProfiles: Record<string, unknown>[] = [];
  readonly unexpected: string[] = [];
  private counter = 0;
  private putAttempts = 0;

  private delay(ms: number, signal: AbortSignal | null | undefined) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('AbortError (simulated fetch abort)'));
      });
    });
  }

  readonly fetch = async (
    url: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const signal = init.signal;
    const faults = mockWorld.faults.server;
    if (url === `${API_BASE}/v1/auth/refresh`) {
      const body = JSON.parse(String(init.body ?? '{}')) as {
        refreshToken?: string;
      };
      const token = String(body.refreshToken ?? '');
      this.refreshCalls.push(token);
      await this.delay(faults.refreshLatencyMs, signal);
      if (!this.validRefresh.has(token)) {
        return jsonResponse(401, { error: { message: 'unknown token' } });
      }
      this.counter += 1;
      this.validRefresh.delete(token);
      const next = `REFRESH-TOKEN-${this.counter}`;
      this.validRefresh.add(next);
      return jsonResponse(200, {
        session: {
          accessToken: `ACCESS-TOKEN-${this.counter}`,
          refreshToken: next,
          expiresAt: Math.floor(Date.now() / 1000) + 3600 - faults.clockSkewSec,
        },
      });
    }
    if (url === `${API_BASE}/v1/me` && (init.method ?? 'GET') === 'GET') {
      this.meCalls.push(Date.now());
      await this.delay(50, signal);
      switch (faults.me) {
        case 'malformed':
          return new Response('{"onboardingState":', { status: 200 });
        case 'complete-invalid':
          return jsonResponse(200, {
            onboardingState: 'complete',
            profile: { skill_level: 3, handedness: 'both' },
          });
        default:
          return jsonResponse(200, { onboardingState: 'incomplete' });
      }
    }
    if (url === `${API_BASE}/v1/me/onboarding` && init.method === 'PUT') {
      const body = JSON.parse(String(init.body ?? 'null')) as Record<
        string,
        unknown
      >;
      this.putAttempts += 1;
      const entry = { body, outcome: 'pending' };
      this.onboardingPuts.push(entry);
      const mode = faults.onboardingPut;
      const accept = () => {
        this.acceptedProfiles.push(body);
        entry.outcome = '200';
        return jsonResponse(200, {
          onboardingState: 'complete',
          recommendedCheckpoint: 'paddle_set',
        });
      };
      try {
        switch (mode) {
          case 'network':
            entry.outcome = 'network';
            throw new TypeError('Network request failed');
          case '500':
            entry.outcome = '500';
            return jsonResponse(500, { error: { message: 'boom' } });
          case '401':
            entry.outcome = '401';
            return jsonResponse(401, {
              error: { message: 'Your session has expired.' },
            });
          case '429':
            entry.outcome = '429';
            return new Response(
              JSON.stringify({ error: { message: 'slow down' } }),
              { status: 429, headers: { 'Retry-After': '30' } },
            );
          case '400-message':
            entry.outcome = '400';
            return jsonResponse(400, {
              error: { message: 'skillLevel is not a recognised level.' },
            });
          case '503-html':
            entry.outcome = '503-html';
            return new Response('<html>Service Unavailable</html>', {
              status: 503,
            });
          case 'malformed-json':
            entry.outcome = '200-malformed';
            this.acceptedProfiles.push(body);
            return new Response('<html>ok</html>', { status: 200 });
          case 'empty-object':
            entry.outcome = '200-empty';
            this.acceptedProfiles.push(body);
            return jsonResponse(200, {});
          case 'invalid-checkpoint':
            entry.outcome = '200-invalid-checkpoint';
            this.acceptedProfiles.push(body);
            return jsonResponse(200, {
              onboardingState: 'complete',
              recommendedCheckpoint: 'left_foot',
            });
          case 'partial-json':
            entry.outcome = '200-partial';
            this.acceptedProfiles.push(body);
            return new Response('{"onboardingState":"complete","recomm', {
              status: 200,
            });
          case 'slow-5s':
            await this.delay(5_000, signal);
            return accept();
          case 'slow-14s':
            await this.delay(14_000, signal);
            return accept();
          case 'hang':
            await this.delay(HANG_MS, signal);
            entry.outcome = 'hang-elapsed';
            return new Response(null, { status: 599 });
          case 'fail-once-network':
            if (this.putAttempts === 1) {
              entry.outcome = 'network';
              throw new TypeError('Network request failed');
            }
            return accept();
          case 'fail-once-500':
            if (this.putAttempts === 1) {
              entry.outcome = '500';
              return jsonResponse(500, { error: { message: 'boom' } });
            }
            return accept();
          default:
            return accept();
        }
      } catch (error) {
        if (entry.outcome === 'pending') entry.outcome = 'aborted';
        throw error;
      }
    }
    if (url === `${API_BASE}/v1/auth/logout`) {
      this.logoutCalls.push(faults.logout);
      switch (faults.logout) {
        case '500':
          return jsonResponse(500, { error: { message: 'boom' } });
        case 'network':
          throw new TypeError('Network request failed');
        case 'hang':
          await this.delay(HANG_MS, signal);
          return new Response(null, { status: 599 });
        default:
          return new Response(null, { status: 204 });
      }
    }
    this.unexpected.push(`${init.method ?? 'GET'} ${url}`);
    return jsonResponse(404, { error: { message: 'unexpected route' } });
  };
}

interface World {
  faults: Faults;
  db: FakeLocalDb;
  dbLog: string[];
  keychain: Map<string, { username: string; password: string }>;
  keychainLog: string[];
  scheduler: FaultScheduler;
  server: ScriptedServer;
  googleSignOutCalls: number;
}

function freshWorld(): World {
  return {
    faults: neutralFaults(),
    db: new FakeLocalDb(),
    dbLog: [],
    keychain: new Map(),
    keychainLog: [],
    scheduler: new FaultScheduler(),
    server: new ScriptedServer(),
    googleSignOutCalls: 0,
  };
}

const mockWorld: World = freshWorld();

function mockDbHandle(): LocalDb {
  const f = mockWorld.faults.db;
  mockWorld.db.faults = {
    openThrows: f.openThrows,
    allThrow: f.allThrow,
    kvSetThrows: f.kvSetThrows,
    kvGetThrows: f.kvGetThrows,
  };
  const inner = mockWorld.db.handle();
  return {
    execute: async (sql: string, params: unknown[] = []) => {
      const statement = sql.trim().replace(/\s+/g, ' ');
      const isKvSet = statement.startsWith('INSERT OR REPLACE INTO kv');
      const key =
        isKvSet || statement.startsWith('SELECT value FROM kv')
          ? String(params[0])
          : null;
      const current = mockWorld.faults.db;
      if (current.hangAll || (isKvSet && key && current.hangSetKeys.has(key))) {
        mockWorld.dbLog.push(`hang ${isKvSet ? 'set' : 'stmt'} ${key ?? ''}`);
        return mockNever();
      }
      if (current.latencyMs > 0) await sleep(current.latencyMs);
      if (isKvSet && key && current.throwOnceSetKeys.has(key)) {
        current.throwOnceSetKeys.delete(key);
        mockWorld.dbLog.push(`throw-once set ${key}`);
        throw new Error(`SQLITE_BUSY (simulated, transient) writing ${key}`);
      }
      return inner.execute(sql, params);
    },
    close: () => inner.close(),
  };
}

jest.mock('../../src/data/db', () => ({
  getDb: () => mockDbHandle(),
}));

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
    mockWorld.keychainLog.push('set');
    if (mockWorld.faults.keychain.setThrows) {
      throw new Error('errSecInteractionNotAllowed (simulated)');
    }
    mockWorld.keychain.set(options.service ?? '__default__', {
      username,
      password,
    });
    return { service: options.service, storage: 'mock' };
  },
  getGenericPassword: async (options: { service?: string } = {}) => {
    mockWorld.keychainLog.push('get');
    const faults = mockWorld.faults.keychain;
    if (faults.getThrows) throw new Error('errSecItemNotFound (simulated)');
    if (faults.getMalformed !== null) {
      return {
        service: options.service,
        storage: 'mock',
        username: 'session',
        password: faults.getMalformed,
      };
    }
    const item = mockWorld.keychain.get(options.service ?? '__default__');
    if (!item) return false;
    return { service: options.service, storage: 'mock', ...item };
  },
  resetGenericPassword: async (options: { service?: string } = {}) => {
    mockWorld.keychainLog.push('reset');
    const faults = mockWorld.faults.keychain;
    if (faults.resetHangs) return mockNever<boolean>();
    if (faults.resetThrows) throw new Error('errSecAuthFailed (simulated)');
    return mockWorld.keychain.delete(options.service ?? '__default__');
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
    signOut: jest.fn(async () => {
      mockWorld.googleSignOutCalls += 1;
      if (mockWorld.faults.google.signOutThrows) {
        throw new Error('GoogleSignin.signOut failed (simulated)');
      }
    }),
    revokeAccess: jest.fn(async () => {}),
  },
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
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockWorld.scheduler,
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
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});
// Not dependencies of the unit: the post-onboarding destination, the video
// intro overlay and the celebration overlays.
jest.mock('../../src/navigation/RootNavigator', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    RootNavigator: () => R.createElement(RN.Text, null, 'ROOT_NAVIGATOR'),
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
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import { clearApiSession } from '../../src/account/apiSession';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { OnboardingScreen } from '../../src/screens/OnboardingScreen';
import { WelcomeScreen } from '../../src/screens/WelcomeScreen';
import { SignInScreen } from '../../src/screens/SignInScreen';
import { BrandDialog } from '../../src/design/components';
import { focusForGoal } from '../../src/state/profile';
import { notificationPrefsKeyForOwner } from '../../src/notifications/types';

// ─── Scenario space ──────────────────────────────────────────────────────────

type Mode = 'preauth' | 'guest' | 'canonical';
const MODES: readonly Mode[] = ['preauth', 'guest', 'canonical'];
type Window = 'launch' | 'finish';
type Dependency =
  | 'sqlite'
  | 'fetch'
  | 'keychain'
  | 'permissions'
  | 'scheduler'
  | 'clock'
  | 'navigation'
  | 'persisted-state';
type FirstAttempt = 'success' | 'fail' | 'any';
type Inflight = 'none' | 'double-tap' | 'remount' | 'signout' | 'back-forward';

interface FaultSpec {
  id: string;
  dependency: Dependency;
  /** the ONE knob this fault turns — two faults on one knob never combine */
  knob: string;
  modes: readonly Mode[];
  window: Window;
  /** documented outcome of the FIRST finishing tap while the fault is live */
  firstAttempt: FirstAttempt;
  apply: (world: World, scenario: Scenario) => void;
  /** navigation faults are procedural rather than knob-based */
  inflight?: Inflight;
  /** false: exercise the inflight action WITHOUT tapping finish first */
  finishFirst?: boolean;
  clockAdvanceMs?: number;
  step1Back?: boolean;
  leaveKeep?: boolean;
}

interface Scenario {
  name: string;
  seed: number;
  mode: Mode;
  faults: FaultSpec[];
  choice: 'enable' | 'not_now';
  answers: {
    name: string;
    gender: number;
    level: number;
    hand: number;
    goal: number;
    problem: number;
  };
  /** question indexes (0..4) after which Back → Continue is exercised */
  backAt: number[];
  vaultProvider: 'apple' | 'google';
}

const GENDER_LABELS = ['Female', 'Male', 'Non-binary', 'Prefer not to say'];
const GENDER_VALUES = ['female', 'male', 'nonbinary', 'prefer_not_to_say'];
const LEVEL_LABELS = ['Brand new', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0+'];
const LEVEL_VALUES = ['Beginner', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0+'];
const HAND_LABELS = ['Right-handed', 'Left-handed'];
const HAND_VALUES = ['right', 'left'];
const GOAL_LABELS = [
  'Dinks',
  'Drives',
  'Third-shot drops',
  'Serve',
  'Volleys',
  'Footwork',
  'All-around',
];
const GOAL_VALUES = [
  'dinks',
  'drives',
  'drops',
  'serve',
  'volleys',
  'footwork',
  'all-around',
];
const PROBLEM_LABELS = [
  'Consistency',
  'Control',
  'Power',
  'Contact',
  'Footwork',
  'Placement',
  'Not sure',
];
const PROBLEM_VALUES = [
  'consistency',
  'control',
  'power',
  'contact',
  'footwork',
  'placement',
  'not sure',
];
const NAMES = ['Dana', ' Sam ', 'Ó Brien', '李', 'x', 'A'.repeat(64)];

const ACCOUNT_MODES: readonly Mode[] = ['guest', 'canonical'];

const RAW_MALFORMED: (keyof typeof RAW_STRING_VARIANTS)[] = [
  'not-json',
  'truncated-json',
  'json-null',
  'json-array',
  'json-empty-object',
  'json-nested-garbage',
  'huge-1mb',
];

function profileKeyFor(mode: Mode): string {
  return mode === 'guest'
    ? `profile:${GUEST_OWNER}`
    : `profile:${CANONICAL_OWNER}`;
}
function prefsKeyFor(mode: Mode): string {
  return notificationPrefsKeyForOwner(
    mode === 'guest' ? GUEST_OWNER : CANONICAL_OWNER,
  );
}

const FAULTS: FaultSpec[] = [
  // ── SQLite ────────────────────────────────────────────────────────────────
  {
    id: 'sqlite.pending-profile-write.throw',
    dependency: 'sqlite',
    knob: 'db.kvSet',
    modes: ['preauth'],
    window: 'finish',
    firstAttempt: 'fail',
    apply: w => w.faults.db.kvSetThrows.add(PENDING_PROFILE_KEY),
  },
  {
    id: 'sqlite.pending-profile-write.throw-once',
    dependency: 'sqlite',
    knob: 'db.kvSet',
    modes: ['preauth'],
    window: 'finish',
    firstAttempt: 'fail',
    apply: w => w.faults.db.throwOnceSetKeys.add(PENDING_PROFILE_KEY),
  },
  {
    id: 'sqlite.pending-profile-write.hang',
    dependency: 'sqlite',
    knob: 'db.kvSet',
    modes: ['preauth'],
    window: 'finish',
    firstAttempt: 'any',
    apply: w => w.faults.db.hangSetKeys.add(PENDING_PROFILE_KEY),
  },
  {
    id: 'sqlite.pending-notifications-write.throw',
    dependency: 'sqlite',
    knob: 'db.kvSet',
    modes: ['preauth'],
    window: 'finish',
    firstAttempt: 'any',
    apply: w => w.faults.db.kvSetThrows.add(PENDING_NOTIFICATIONS_KEY),
  },
  {
    id: 'sqlite.pending-notifications-write.hang',
    dependency: 'sqlite',
    knob: 'db.kvSet',
    modes: ['preauth'],
    window: 'finish',
    firstAttempt: 'any',
    apply: w => w.faults.db.hangSetKeys.add(PENDING_NOTIFICATIONS_KEY),
  },
  {
    id: 'sqlite.profile-write.throw',
    dependency: 'sqlite',
    knob: 'db.kvSet',
    modes: ACCOUNT_MODES,
    window: 'finish',
    firstAttempt: 'fail',
    apply: (w, s) => w.faults.db.kvSetThrows.add(profileKeyFor(s.mode)),
  },
  {
    id: 'sqlite.profile-write.throw-once',
    dependency: 'sqlite',
    knob: 'db.kvSet',
    modes: ACCOUNT_MODES,
    window: 'finish',
    firstAttempt: 'fail',
    apply: (w, s) => w.faults.db.throwOnceSetKeys.add(profileKeyFor(s.mode)),
  },
  {
    id: 'sqlite.profile-write.hang',
    dependency: 'sqlite',
    knob: 'db.kvSet',
    modes: ACCOUNT_MODES,
    window: 'finish',
    firstAttempt: 'any',
    apply: (w, s) => w.faults.db.hangSetKeys.add(profileKeyFor(s.mode)),
  },
  {
    id: 'sqlite.notification-prefs-write.throw',
    dependency: 'sqlite',
    knob: 'db.kvSet',
    modes: ACCOUNT_MODES,
    window: 'finish',
    firstAttempt: 'any',
    apply: (w, s) => w.faults.db.kvSetThrows.add(prefsKeyFor(s.mode)),
  },
  {
    id: 'sqlite.notification-prefs-write.hang',
    dependency: 'sqlite',
    knob: 'db.kvSet',
    modes: ACCOUNT_MODES,
    window: 'finish',
    firstAttempt: 'any',
    apply: (w, s) => w.faults.db.hangSetKeys.add(prefsKeyFor(s.mode)),
  },
  {
    id: 'sqlite.all-statements.throw',
    dependency: 'sqlite',
    knob: 'db.all',
    modes: MODES,
    window: 'finish',
    firstAttempt: 'fail',
    apply: w => {
      w.faults.db.allThrow = 'SQLITE_IOERR (simulated) database gone';
    },
  },
  {
    id: 'sqlite.open.throw',
    dependency: 'sqlite',
    knob: 'db.all',
    modes: MODES,
    window: 'finish',
    firstAttempt: 'fail',
    apply: w => {
      w.faults.db.openThrows = 'SQLITE_CANTOPEN (simulated)';
    },
  },
  {
    id: 'sqlite.slow-3s',
    dependency: 'sqlite',
    knob: 'db.all',
    modes: MODES,
    window: 'finish',
    firstAttempt: 'success',
    apply: w => {
      w.faults.db.latencyMs = 3_000;
    },
  },
  {
    id: 'sqlite.slow-10s',
    dependency: 'sqlite',
    knob: 'db.all',
    modes: MODES,
    window: 'finish',
    firstAttempt: 'success',
    apply: w => {
      w.faults.db.latencyMs = 10_000;
    },
  },
  {
    id: 'sqlite.all-statements.hang',
    dependency: 'sqlite',
    knob: 'db.all',
    modes: MODES,
    window: 'finish',
    firstAttempt: 'any',
    apply: w => {
      w.faults.db.hangAll = true;
    },
  },
  {
    id: 'sqlite.launch-reads.throw',
    dependency: 'sqlite',
    knob: 'db.kvGet',
    modes: ['preauth'],
    window: 'launch',
    firstAttempt: 'success',
    apply: w => {
      w.faults.db.kvGetThrows.add(PENDING_PROFILE_KEY);
      w.faults.db.kvGetThrows.add(`profile:${SIGNED_OUT_DATA_OWNER}`);
    },
  },
  {
    id: 'sqlite.launch-slow-2s',
    dependency: 'sqlite',
    knob: 'db.all',
    modes: MODES,
    window: 'launch',
    firstAttempt: 'success',
    apply: w => {
      w.faults.db.latencyMs = 2_000;
    },
  },
  // ── Pre-existing persisted state (a crashed earlier run) ─────────────────
  ...RAW_MALFORMED.map<FaultSpec>(variant => ({
    id: `persisted.pending-profile.${variant}`,
    dependency: 'persisted-state',
    knob: `kv.${PENDING_PROFILE_KEY}`,
    modes: MODES,
    window: 'launch',
    firstAttempt: 'success',
    apply: w => {
      w.db.kv.set(PENDING_PROFILE_KEY, RAW_STRING_VARIANTS[variant] ?? '');
    },
  })),
  ...RAW_MALFORMED.map<FaultSpec>(variant => ({
    id: `persisted.pending-notifications.${variant}`,
    dependency: 'persisted-state',
    knob: `kv.${PENDING_NOTIFICATIONS_KEY}`,
    modes: MODES,
    window: 'launch',
    firstAttempt: 'success',
    apply: w => {
      w.db.kv.set(
        PENDING_NOTIFICATIONS_KEY,
        RAW_STRING_VARIANTS[variant] ?? '',
      );
    },
  })),
  {
    id: 'persisted.notification-prefs.not-json',
    dependency: 'persisted-state',
    knob: 'kv.prefs',
    modes: ACCOUNT_MODES,
    window: 'launch',
    firstAttempt: 'success',
    apply: (w, s) => {
      w.db.kv.set(prefsKeyFor(s.mode), RAW_STRING_VARIANTS['not-json']);
    },
  },
  {
    id: 'persisted.pending-profile.valid-stale',
    dependency: 'persisted-state',
    knob: `kv.${PENDING_PROFILE_KEY}`,
    modes: ['preauth'],
    window: 'launch',
    firstAttempt: 'success',
    apply: w => {
      w.db.kv.set(
        PENDING_PROFILE_KEY,
        JSON.stringify({
          version: 1,
          profile: {
            firstName: 'Stale',
            skillLevel: '2.5',
            handedness: 'left',
            goal: 'serve',
            biggestProblem: 'power',
            focusCheckpoint: 'recovery',
          },
        }),
      );
    },
  },
  // ── fetch / API (synced account only — the pre-auth + guest flows must
  //    never touch the network) ────────────────────────────────────────────
  ...(
    [
      ['network', 'fail'],
      ['500', 'fail'],
      ['401', 'fail'],
      ['429', 'fail'],
      ['400-message', 'fail'],
      ['503-html', 'fail'],
      ['malformed-json', 'fail'],
      ['empty-object', 'fail'],
      ['invalid-checkpoint', 'fail'],
      ['partial-json', 'fail'],
      ['slow-5s', 'success'],
      ['slow-14s', 'success'],
      ['hang', 'fail'],
      ['fail-once-network', 'success'],
      ['fail-once-500', 'success'],
    ] as const
  ).map<FaultSpec>(([mode, firstAttempt]) => ({
    id: `fetch.onboarding-put.${mode}`,
    dependency: 'fetch',
    knob: 'server.onboardingPut',
    modes: ['canonical'],
    window: 'finish',
    firstAttempt,
    apply: w => {
      w.faults.server.onboardingPut = mode;
    },
  })),
  {
    id: 'fetch.me.malformed-at-launch',
    dependency: 'fetch',
    knob: 'server.me',
    modes: ['canonical'],
    window: 'launch',
    firstAttempt: 'success',
    apply: w => {
      w.faults.server.me = 'malformed';
    },
  },
  {
    id: 'fetch.me.complete-but-invalid-at-launch',
    dependency: 'fetch',
    knob: 'server.me',
    modes: ['canonical'],
    window: 'launch',
    firstAttempt: 'success',
    apply: w => {
      w.faults.server.me = 'complete-invalid';
    },
  },
  {
    id: 'fetch.refresh.slow-6s-at-launch',
    dependency: 'fetch',
    knob: 'server.refresh',
    modes: ['canonical'],
    window: 'launch',
    firstAttempt: 'success',
    apply: w => {
      w.faults.server.refreshLatencyMs = 6_000;
    },
  },
  {
    id: 'fetch.logout.500-on-sign-out',
    dependency: 'fetch',
    knob: 'server.logout',
    modes: ['canonical'],
    window: 'finish',
    firstAttempt: 'any',
    inflight: 'signout',
    finishFirst: false,
    apply: w => {
      w.faults.server.logout = '500';
    },
  },
  {
    id: 'fetch.logout.network-on-sign-out',
    dependency: 'fetch',
    knob: 'server.logout',
    modes: ['canonical'],
    window: 'finish',
    firstAttempt: 'any',
    inflight: 'signout',
    finishFirst: false,
    apply: w => {
      w.faults.server.logout = 'network';
    },
  },
  {
    id: 'fetch.logout.hang-on-sign-out',
    dependency: 'fetch',
    knob: 'server.logout',
    modes: ['canonical'],
    window: 'finish',
    firstAttempt: 'any',
    inflight: 'signout',
    finishFirst: false,
    apply: w => {
      w.faults.server.logout = 'hang';
    },
  },
  // ── Keychain ──────────────────────────────────────────────────────────────
  {
    id: 'keychain.get.throw-at-launch',
    dependency: 'keychain',
    knob: 'keychain.get',
    modes: ['preauth', 'guest'],
    window: 'launch',
    firstAttempt: 'success',
    apply: w => {
      w.faults.keychain.getThrows = true;
    },
  },
  {
    id: 'keychain.get.malformed-record-at-launch',
    dependency: 'keychain',
    knob: 'keychain.get',
    modes: ['preauth', 'guest'],
    window: 'launch',
    firstAttempt: 'success',
    apply: w => {
      w.faults.keychain.getMalformed = '{"version":1,"provider":"app';
    },
  },
  {
    id: 'keychain.set.throw-at-launch',
    dependency: 'keychain',
    knob: 'keychain.set',
    modes: ['canonical'],
    window: 'launch',
    firstAttempt: 'success',
    apply: w => {
      w.faults.keychain.setThrows = true;
    },
  },
  {
    id: 'keychain.reset.throw-on-sign-out',
    dependency: 'keychain',
    knob: 'keychain.reset',
    modes: ACCOUNT_MODES,
    window: 'finish',
    firstAttempt: 'any',
    inflight: 'signout',
    finishFirst: false,
    apply: w => {
      w.faults.keychain.resetThrows = true;
    },
  },
  {
    id: 'keychain.reset.hang-on-sign-out',
    dependency: 'keychain',
    knob: 'keychain.reset',
    modes: ACCOUNT_MODES,
    window: 'finish',
    firstAttempt: 'any',
    inflight: 'signout',
    finishFirst: false,
    apply: w => {
      w.faults.keychain.resetHangs = true;
    },
  },
  {
    id: 'google.sign-out.throw-on-sign-out',
    dependency: 'keychain',
    knob: 'google.signOut',
    modes: ['canonical'],
    window: 'finish',
    firstAttempt: 'any',
    inflight: 'signout',
    finishFirst: false,
    apply: w => {
      w.faults.google.signOutThrows = true;
    },
  },
  // ── Notification permission + scheduler ──────────────────────────────────
  ...(
    [
      ['denied', 'success'],
      ['undetermined', 'success'],
      ['throw', 'success'],
      ['reject', 'success'],
      ['hang', 'any'],
      ['slow-5s', 'success'],
      ['malformed', 'success'],
    ] as const
  ).map<FaultSpec>(([mode, firstAttempt]) => ({
    id: `permissions.request.${mode}`,
    dependency: 'permissions',
    knob: 'scheduler.request',
    modes: MODES,
    window: 'finish',
    firstAttempt,
    apply: w => {
      w.faults.scheduler.request = mode;
    },
  })),
  ...(
    [
      ['throw', 'success'],
      ['hang', 'any'],
      ['slow-5s', 'success'],
    ] as const
  ).map<FaultSpec>(([mode, firstAttempt]) => ({
    id: `scheduler.apply-plan.${mode}`,
    dependency: 'scheduler',
    knob: 'scheduler.apply',
    modes: ACCOUNT_MODES,
    window: 'finish',
    firstAttempt,
    apply: w => {
      w.faults.scheduler.apply = mode;
    },
  })),
  ...(
    [
      ['throw', 'success'],
      ['hang', 'any'],
    ] as const
  ).map<FaultSpec>(([mode, firstAttempt]) => ({
    id: `scheduler.cancel-all.${mode}`,
    dependency: 'scheduler',
    knob: 'scheduler.cancel',
    modes: ACCOUNT_MODES,
    window: 'finish',
    firstAttempt,
    apply: w => {
      w.faults.scheduler.cancel = mode;
    },
  })),
  {
    id: 'scheduler.permission-state.throw-at-launch',
    dependency: 'scheduler',
    knob: 'scheduler.state',
    modes: MODES,
    window: 'launch',
    firstAttempt: 'success',
    apply: w => {
      w.faults.scheduler.state = 'throw';
    },
  },
  {
    id: 'scheduler.permission-state.hang-at-launch',
    dependency: 'scheduler',
    knob: 'scheduler.state',
    modes: MODES,
    window: 'launch',
    firstAttempt: 'success',
    apply: w => {
      w.faults.scheduler.state = 'hang';
    },
  },
  // ── Clock ─────────────────────────────────────────────────────────────────
  {
    id: 'clock.client-2h-ahead-of-server',
    dependency: 'clock',
    knob: 'server.clockSkew',
    modes: ['canonical'],
    window: 'launch',
    firstAttempt: 'success',
    apply: w => {
      w.faults.server.clockSkewSec = 2 * 3600;
    },
  },
  {
    id: 'clock.client-2h-behind-server',
    dependency: 'clock',
    knob: 'server.clockSkew',
    modes: ['canonical'],
    window: 'launch',
    firstAttempt: 'success',
    apply: w => {
      w.faults.server.clockSkewSec = -2 * 3600;
    },
  },
  {
    id: 'clock.idle-70min-on-notification-step',
    dependency: 'clock',
    knob: 'clock.advance',
    modes: MODES,
    window: 'finish',
    firstAttempt: 'success',
    clockAdvanceMs: 70 * 60_000,
    apply: () => {},
  },
  // ── Navigation ────────────────────────────────────────────────────────────
  {
    id: 'navigation.step1-back-to-welcome-and-reenter',
    dependency: 'navigation',
    knob: 'nav.step1Back',
    modes: ['preauth'],
    window: 'launch',
    firstAttempt: 'success',
    step1Back: true,
    apply: () => {},
  },
  {
    id: 'navigation.leave-setup-keep-setting-up',
    dependency: 'navigation',
    knob: 'nav.leaveKeep',
    modes: ACCOUNT_MODES,
    window: 'launch',
    firstAttempt: 'success',
    leaveKeep: true,
    apply: () => {},
  },
  {
    id: 'navigation.double-tap-finish-while-sqlite-slow',
    dependency: 'navigation',
    knob: 'db.all',
    modes: MODES,
    window: 'finish',
    firstAttempt: 'success',
    inflight: 'double-tap',
    apply: w => {
      w.faults.db.latencyMs = 2_000;
    },
  },
  {
    id: 'navigation.remount-app-while-sqlite-slow',
    dependency: 'navigation',
    knob: 'db.all',
    modes: MODES,
    window: 'finish',
    firstAttempt: 'any',
    inflight: 'remount',
    apply: w => {
      w.faults.db.latencyMs = 2_000;
    },
  },
  {
    id: 'navigation.back-during-inflight-then-forward',
    dependency: 'navigation',
    knob: 'db.all',
    modes: MODES,
    window: 'finish',
    firstAttempt: 'success',
    inflight: 'back-forward',
    apply: w => {
      w.faults.db.latencyMs = 2_000;
    },
  },
  {
    id: 'navigation.sign-out-while-sqlite-slow',
    dependency: 'navigation',
    knob: 'db.all',
    modes: ACCOUNT_MODES,
    window: 'finish',
    firstAttempt: 'any',
    inflight: 'signout',
    apply: w => {
      w.faults.db.latencyMs = 2_000;
    },
  },
  {
    id: 'navigation.sign-out-while-fetch-slow',
    dependency: 'navigation',
    knob: 'server.onboardingPut',
    modes: ['canonical'],
    window: 'finish',
    firstAttempt: 'any',
    inflight: 'signout',
    apply: w => {
      w.faults.server.onboardingPut = 'slow-5s';
    },
  },
];

function fnv1a(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededAnswers(rng: () => number): Scenario['answers'] {
  return {
    name: pick(rng, NAMES),
    gender: Math.floor(rng() * GENDER_LABELS.length),
    level: Math.floor(rng() * LEVEL_LABELS.length),
    hand: Math.floor(rng() * HAND_LABELS.length),
    goal: Math.floor(rng() * GOAL_LABELS.length),
    problem: Math.floor(rng() * PROBLEM_LABELS.length),
  };
}

function seededBackWalk(rng: () => number): number[] {
  const count = Math.floor(rng() * 3);
  const out = new Set<number>();
  for (let i = 0; i < count; i += 1) out.add(Math.floor(rng() * 5));
  return [...out].sort((a, b) => a - b);
}

/** One representative mode per fault: the most dependency-rich one. */
function representativeMode(spec: FaultSpec): Mode {
  if (spec.modes.includes('canonical')) return 'canonical';
  if (spec.modes.includes('guest')) return 'guest';
  return 'preauth';
}

function sweepScenario(spec: FaultSpec, mode: Mode): Scenario {
  const name = `sweep:${spec.id}:${mode}`;
  const seed = fnv1a(name);
  const rng = makePrng(seed);
  return {
    name,
    seed,
    mode,
    faults: [spec],
    // The permission prompt and the scheduler plan only run for "enable",
    // cancelling only for "not now": a sweep must actually reach its fault.
    choice:
      spec.knob === 'scheduler.request' || spec.knob === 'scheduler.apply'
        ? 'enable'
        : spec.knob === 'scheduler.cancel'
          ? 'not_now'
          : rng() < 0.65
            ? 'enable'
            : 'not_now',
    answers: seededAnswers(rng),
    backAt: seededBackWalk(rng),
    vaultProvider:
      spec.knob === 'google.signOut' || rng() < 0.3 ? 'google' : 'apple',
  };
}

function seededScenario(seed: number): Scenario {
  const rng = makePrng(seed);
  const mode = pick(rng, MODES);
  const applicable = FAULTS.filter(
    f => f.modes.includes(mode) && !f.inflight && !f.step1Back && !f.leaveKeep,
  );
  const count = 1 + Math.floor(rng() * 3);
  const faults: FaultSpec[] = [];
  const knobs = new Set<string>();
  let guard = 0;
  while (faults.length < count && guard < 40) {
    guard += 1;
    const candidate = pick(rng, applicable);
    if (knobs.has(candidate.knob)) continue;
    knobs.add(candidate.knob);
    faults.push(candidate);
  }
  return {
    name: `seeded-${seed}`,
    seed,
    mode,
    faults,
    choice: rng() < 0.65 ? 'enable' : 'not_now',
    answers: seededAnswers(rng),
    backAt: seededBackWalk(rng),
    vaultProvider: rng() < 0.3 ? 'google' : 'apple',
  };
}

const env = nodeProcess.env;
const STRESS_ITER = Number(env['STRESS_ITER'] ?? 10);
const STRESS_FULL = env['STRESS_FULL'] === '1';
const SEED_FILTER = (env['STRESS_SEED'] ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);
const SCENARIO_FILTER = env['STRESS_SCENARIO'] ?? '';

function buildScenarios(): Scenario[] {
  if (SEED_FILTER.length > 0) return SEED_FILTER.map(seededScenario);
  const sweep: Scenario[] = [];
  for (const spec of FAULTS) {
    const modes = STRESS_FULL ? spec.modes : [representativeMode(spec)];
    for (const mode of modes) sweep.push(sweepScenario(spec, mode));
  }
  const seeded: Scenario[] = [];
  for (let i = 0; i < STRESS_ITER; i += 1) {
    seeded.push(seededScenario(fnv1a(`stress-onboarding-${i}`)));
  }
  const all = [...sweep, ...seeded];
  return SCENARIO_FILTER
    ? all.filter(s => s.name.includes(SCENARIO_FILTER))
    : all;
}

// ─── Driving helpers ─────────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;

function isAncestor(
  candidate: ReactTestInstance,
  node: ReactTestInstance,
): boolean {
  let cursor: ReactTestInstance | null = node.parent;
  while (cursor) {
    if (cursor === candidate) return true;
    cursor = cursor.parent;
  }
  return false;
}

function pressables(renderer: Renderer, label: string): ReactTestInstance[] {
  const matches = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
  return matches.filter(
    node => !matches.some(other => other !== node && isAncestor(node, other)),
  );
}

type PressResult = 'pressed' | 'missing' | 'disabled';

/**
 * Rejections of async onPress handlers. React Native drops the promise an
 * onPress returns, so a rejection there is an UNHANDLED rejection in the app
 * (silent in release builds). Jest's sandbox `process` never sees real
 * 'unhandledRejection' events, so the harness captures them at the source.
 */
const handlerRejections: string[] = [];

function invokeHandler(fn: () => unknown, label: string): void {
  act(() => {
    const result = fn();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).then(undefined, (error: unknown) => {
        handlerRejections.push(
          `${label}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  });
}

function press(renderer: Renderer, label: string): PressResult {
  const nodes = pressables(renderer, label);
  const node = nodes[0];
  if (!node) return 'missing';
  if (node.props.disabled) return 'disabled';
  invokeHandler(() => node.props.onPress(), label);
  return 'pressed';
}

function enabledControl(renderer: Renderer, label: string): boolean {
  const node = pressables(renderer, label)[0];
  return Boolean(node) && !node?.props.disabled;
}

function allText(renderer: Renderer): string {
  try {
    return renderer.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat()
      .filter((c): c is string | number => typeof c !== 'object')
      .join('|');
  } catch {
    return '';
  }
}

function typeName(renderer: Renderer, name: string): void {
  act(() => renderer.root.findByType(TextInput).props.onChangeText(name));
}

function countType(renderer: Renderer, type: React.ElementType): number {
  try {
    return renderer.root.findAllByType(type).length;
  } catch {
    return 0;
  }
}

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

async function until(
  predicate: () => boolean,
  maxMs: number,
  stepMs = 100,
): Promise<boolean> {
  let elapsed = 0;
  while (elapsed < maxMs) {
    if (predicate()) return true;
    await flush(stepMs);
    elapsed += stepMs;
  }
  return predicate();
}

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

function resetWorld(world: World): void {
  const fresh = freshWorld();
  world.faults = fresh.faults;
  world.db = fresh.db;
  world.dbLog = fresh.dbLog;
  world.keychain = fresh.keychain;
  world.keychainLog = fresh.keychainLog;
  world.scheduler = fresh.scheduler;
  world.server = fresh.server;
  world.googleSignOutCalls = 0;
}

function installMode(world: World, scenario: Scenario): void {
  if (scenario.mode === 'guest') {
    world.db.kv.set(
      'auth.local-mode',
      JSON.stringify({ version: 1, mode: 'guest' }),
    );
    world.db.kv.set(
      'walkthrough.device-complete',
      JSON.stringify({ version: 1 }),
    );
  } else if (scenario.mode === 'canonical') {
    world.keychain.set(VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify(
        validVault({
          refreshToken: 'REFRESH-TOKEN-0',
          provider: scenario.vaultProvider,
        }),
      ),
    });
    world.server.validRefresh.add('REFRESH-TOKEN-0');
    world.db.seedShots(CANONICAL_OWNER, 5, 'real');
    world.db.kv.set(
      'walkthrough.device-complete',
      JSON.stringify({ version: 1 }),
    );
  }
}

// ─── Observations + invariants ───────────────────────────────────────────────

interface Row {
  name: string;
  seed: number;
  mode: Mode;
  faults: string[];
  dependencies: Dependency[];
  choice: 'enable' | 'not_now';
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  failed: string[];
  ok: boolean;
  durationMs: number;
}

interface ExpectedProfile {
  firstName: string;
  gender: string;
  skillLevel: string;
  handedness: string;
  goal: string;
  biggestProblem: string;
  focusCheckpoint: string;
}

function expectedProfile(scenario: Scenario): ExpectedProfile {
  const goal = GOAL_VALUES[scenario.answers.goal] ?? 'all-around';
  return {
    firstName: scenario.answers.name.trim(),
    gender: GENDER_VALUES[scenario.answers.gender] ?? 'female',
    skillLevel: LEVEL_VALUES[scenario.answers.level] ?? '3.0',
    handedness: HAND_VALUES[scenario.answers.hand] ?? 'right',
    goal,
    biggestProblem: PROBLEM_VALUES[scenario.answers.problem] ?? 'not sure',
    focusCheckpoint: focusForGoal(goal),
  };
}

function parseJson(raw: string | undefined): unknown | undefined {
  if (raw === undefined || raw === '') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return Symbol.for('unparseable');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isProfileShape(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    [
      'skillLevel',
      'handedness',
      'goal',
      'biggestProblem',
      'focusCheckpoint',
    ].every(key => typeof value[key] === 'string')
  );
}

function profileMatches(
  stored: unknown,
  expected: ExpectedProfile,
  focusFromServer: boolean,
): boolean {
  if (!isProfileShape(stored)) return false;
  return (
    stored['firstName'] === expected.firstName &&
    stored['gender'] === expected.gender &&
    stored['skillLevel'] === expected.skillLevel &&
    stored['handedness'] === expected.handedness &&
    stored['goal'] === expected.goal &&
    stored['biggestProblem'] === expected.biggestProblem &&
    (focusFromServer
      ? stored['focusCheckpoint'] === 'paddle_set'
      : stored['focusCheckpoint'] === expected.focusCheckpoint)
  );
}

/**
 * Every onboarding-related kv slot the APP WROTE this scenario must be
 * absent, cleared ('') or well-formed, and SQLite must hold no token material.
 * Pre-seeded garbage the app never touched is the seed's business, not a
 * corruption.
 */
function persistedStateSane(world: World, mode: Mode): string[] {
  const problems: string[] = [];
  // A write the fault swallowed never landed; the pre-seeded value it left
  // behind is not the app's doing.
  const written = new Set(
    world.db
      .kvWrites()
      .filter(w => world.db.kv.get(w.key) === w.value)
      .map(w => w.key),
  );
  const pendingProfile = written.has(PENDING_PROFILE_KEY)
    ? parseJson(world.db.kv.get(PENDING_PROFILE_KEY))
    : undefined;
  if (
    pendingProfile !== undefined &&
    !(
      isRecord(pendingProfile) &&
      pendingProfile['version'] === 1 &&
      isProfileShape(pendingProfile['profile'])
    )
  ) {
    problems.push(`kv ${PENDING_PROFILE_KEY} malformed`);
  }
  const pendingNotifications = written.has(PENDING_NOTIFICATIONS_KEY)
    ? parseJson(world.db.kv.get(PENDING_NOTIFICATIONS_KEY))
    : undefined;
  if (
    pendingNotifications !== undefined &&
    !(
      isRecord(pendingNotifications) &&
      pendingNotifications['version'] === 1 &&
      typeof pendingNotifications['enabled'] === 'boolean'
    )
  ) {
    problems.push(`kv ${PENDING_NOTIFICATIONS_KEY} malformed`);
  }
  if (mode !== 'preauth') {
    const profile = written.has(profileKeyFor(mode))
      ? parseJson(world.db.kv.get(profileKeyFor(mode)))
      : undefined;
    if (profile !== undefined && !isProfileShape(profile)) {
      problems.push(`kv ${profileKeyFor(mode)} malformed`);
    }
    const prefs = written.has(prefsKeyFor(mode))
      ? parseJson(world.db.kv.get(prefsKeyFor(mode)))
      : undefined;
    if (prefs !== undefined && !(isRecord(prefs) && prefs['version'] === 1)) {
      problems.push(`kv ${prefsKeyFor(mode)} malformed`);
    }
  }
  for (const [key, value] of world.db.kv) {
    if (/ACCESS-TOKEN-|REFRESH-TOKEN-/.test(value)) {
      problems.push(`token material in kv ${key}`);
    }
  }
  return problems;
}

// ─── Per-scenario runner ─────────────────────────────────────────────────────

const SETTLE_MS = 60_000;
const SETTLE_STEP_MS = 250;

function progressed(renderer: Renderer | null, mode: Mode): boolean {
  if (!renderer) return false;
  return mode === 'preauth'
    ? countType(renderer, SignInScreen) > 0
    : allText(renderer).includes('ROOT_NAVIGATOR');
}

/** The Gate has settled on SOME screen (not LoadingState). */
function screenRendered(renderer: Renderer | null): boolean {
  if (!renderer) return false;
  const text = allText(renderer);
  return (
    countType(renderer, WelcomeScreen) > 0 ||
    countType(renderer, OnboardingScreen) > 0 ||
    countType(renderer, SignInScreen) > 0 ||
    text.includes('ROOT_NAVIGATOR') ||
    text.includes('couldn’t load') ||
    text.includes('Something went wrong')
  );
}

/**
 * In-account the only exit is "Leave setup" on step one: walk Back to it
 * (Back stays enabled while a finish is in flight), then confirm "Sign out".
 */
function signOutFromScreen(renderer: Renderer, log: string[]): boolean {
  for (let i = 0; i < 8 && !enabledControl(renderer, 'Leave setup'); i += 1) {
    log.push(`back-to-step-1:${press(renderer, 'Back')}`);
  }
  const leave = press(renderer, 'Leave setup');
  log.push(`leave:${leave}`);
  if (leave !== 'pressed') return false;
  const dialog = renderer.root.findAllByType(BrandDialog)[0];
  if (!dialog || dialog.props.visible !== true) {
    log.push('sign-out:dialog-not-visible');
    return false;
  }
  const signOut = dialog.props.actions?.find(
    (a: { label: string }) => a.label === 'Sign out',
  );
  if (!signOut) {
    log.push('sign-out:missing');
    return false;
  }
  invokeHandler(() => signOut.onPress(), 'Sign out');
  log.push('sign-out:pressed');
  return true;
}

function onOnboarding(renderer: Renderer | null): boolean {
  return Boolean(renderer) && countType(renderer!, OnboardingScreen) > 0;
}

function busyVisible(renderer: Renderer | null): boolean {
  return (
    Boolean(renderer) && pressables(renderer!, 'Finishing setup…').length > 0
  );
}

function crashed(renderer: Renderer | null): boolean {
  return (
    Boolean(renderer) && allText(renderer!).includes('Something went wrong')
  );
}

function anyEnabledControl(renderer: Renderer | null): string | null {
  if (!renderer) return null;
  for (const label of [
    'Turn on reminders',
    'Not now',
    'Back',
    'Leave setup',
    'Continue',
    'Start your first read',
    'I already have an account',
    'Continue with Apple',
    'Continue with Google',
    'Retry',
    'Try again',
  ]) {
    if (enabledControl(renderer, label)) return label;
  }
  return null;
}

function mount(): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(<App />);
  });
  return renderer;
}

/**
 * Advance fake time until the flow progressed or the screen is idle (not
 * busy, store not busy) for one full step after at least `minIdleMs`, capped
 * at SETTLE_MS. Returns how long the busy label was visible.
 */
async function settle(
  renderer: () => Renderer | null,
  mode: Mode,
  minIdleMs = 500,
): Promise<{ busyMs: number; elapsedMs: number }> {
  let elapsed = 0;
  let busyMs = 0;
  let idleMs = 0;
  while (elapsed < SETTLE_MS) {
    const r = renderer();
    if (progressed(r, mode)) break;
    const busy = busyVisible(r) || useAppStore.getState().onboardingBusy;
    if (busy) {
      busyMs += SETTLE_STEP_MS;
      idleMs = 0;
    } else {
      idleMs += SETTLE_STEP_MS;
      if (idleMs >= minIdleMs) break;
    }
    await flush(SETTLE_STEP_MS);
    elapsed += SETTLE_STEP_MS;
  }
  return { busyMs, elapsedMs: elapsed };
}

async function runScenario(scenario: Scenario): Promise<Row> {
  const startedWall = Date.now();
  jest.setSystemTime(new Date('2026-03-01T09:00:00.000Z'));
  const world = mockWorld;
  resetWorld(world);
  resetProcessState();
  installMode(world, scenario);
  (globalThis as { fetch: unknown }).fetch = world.server.fetch;

  handlerRejections.length = 0;
  const unhandled = handlerRejections;
  // The finish handlers are `void finishOnboarding(...)` — fire-and-forget —
  // so a rejection there is unhandled in the app. Observe the two store
  // actions it awaits (behaviour unchanged: the rejection is re-thrown).
  const originalComplete = useAppStore.getState().completeOnboarding;
  const originalNotifications =
    useNotificationStore.getState().completeOnboardingStep;
  useAppStore.setState({
    completeOnboarding: async profile => {
      try {
        return await originalComplete(profile);
      } catch (error) {
        unhandled.push(
          `completeOnboarding: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    },
  });
  useNotificationStore.setState({
    completeOnboardingStep: async (choice, deps) => {
      try {
        return await originalNotifications(choice, deps);
      } catch (error) {
        unhandled.push(
          `completeNotificationOnboarding: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    },
  });

  const observed: Record<string, unknown> = {};
  const invariants: Record<string, boolean> = {};
  const expected = expectedProfile(scenario);
  const launchFaults = scenario.faults.filter(f => f.window === 'launch');
  const finishFaults = scenario.faults.filter(f => f.window === 'finish');
  const inflight: Inflight =
    scenario.faults.find(f => f.inflight)?.inflight ?? 'none';
  const clockAdvanceMs = scenario.faults.reduce(
    (max, f) => Math.max(max, f.clockAdvanceMs ?? 0),
    0,
  );
  const step1Back = scenario.faults.some(f => f.step1Back);
  const leaveKeep = scenario.faults.some(f => f.leaveKeep);
  const finishFirst = !scenario.faults.some(f => f.finishFirst === false);
  const finishLabel =
    scenario.choice === 'enable' ? 'Turn on reminders' : 'Not now';

  let renderer: Renderer | null = null;
  let crashError: string | null = null;
  let unitReached = false;
  let firstAttemptProgressed = false;
  let firstAttemptError: string | null = null;
  let firstErrorOnScreen = false;
  let firstBusyMs = 0;
  let stuckBusy = false;
  let retryPress: PressResult | 'not-needed' | 'skipped' = 'not-needed';
  let retryProgressed = false;
  let retryError: string | null = null;
  let doubleTapPress: PressResult | null = null;
  let controlAfterFirst: string | null = null;
  let signedOutLanding: string | null = null;
  const walkLog: string[] = [];

  try {
    for (const fault of launchFaults) fault.apply(world, scenario);

    renderer = mount();
    const reachedEntry = await until(
      () =>
        countType(renderer!, WelcomeScreen) > 0 ||
        onOnboarding(renderer) ||
        crashed(renderer),
      20_000,
    );
    observed['entryReached'] = reachedEntry;
    if (!reachedEntry) observed['entryText'] = allText(renderer).slice(0, 300);

    if (scenario.mode === 'preauth') {
      walkLog.push(`welcome:${press(renderer, 'Start your first read')}`);
      await flush(50);
      if (step1Back) {
        // Step-one Back returns to Welcome; re-entering starts fresh.
        walkLog.push(`step1-back:${press(renderer, 'Back')}`);
        await flush(50);
        observed['backLandedOnWelcome'] =
          countType(renderer, WelcomeScreen) > 0;
        walkLog.push(`reenter:${press(renderer, 'Start your first read')}`);
        await flush(50);
      }
    }
    unitReached = await until(() => onOnboarding(renderer), 5_000);
    observed['unitReachedAtMs'] =
      Date.now() - new Date('2026-03-01T09:00:00.000Z').getTime();

    if (unitReached) {
      // ── Walk the questionnaire.
      typeName(renderer, scenario.answers.name);
      if (leaveKeep) {
        // "Leave setup" exists only on step one (in-account).
        walkLog.push(`leave:${press(renderer, 'Leave setup')}`);
        const dialog = renderer.root.findAllByType(BrandDialog)[0];
        const keep =
          dialog?.props.visible === true
            ? dialog.props.actions?.find(
                (a: { label: string }) => a.label === 'Keep setting up',
              )
            : undefined;
        if (keep) invokeHandler(() => keep.onPress(), 'Keep setting up');
        observed['leaveDialogDismissed'] =
          Boolean(keep) &&
          renderer.root.findAllByType(BrandDialog)[0]?.props.visible ===
            false &&
          onOnboarding(renderer);
      }
      walkLog.push(`name:${press(renderer, 'Continue')}`);
      const questions: [string[], number][] = [
        [GENDER_LABELS, scenario.answers.gender],
        [LEVEL_LABELS, scenario.answers.level],
        [HAND_LABELS, scenario.answers.hand],
        [GOAL_LABELS, scenario.answers.goal],
        [PROBLEM_LABELS, scenario.answers.problem],
      ];
      let backOk = true;
      questions.forEach(([labels, index], q) => {
        const label = labels[index] ?? labels[0]!;
        walkLog.push(`q${q}:${label}:${press(renderer!, label)}`);
        if (scenario.backAt.includes(q)) {
          walkLog.push(`q${q}-back:${press(renderer!, 'Back')}`);
          // The previous answer is still selected: Continue must be enabled.
          const forward = press(renderer!, 'Continue');
          walkLog.push(`q${q}-forward:${forward}`);
          if (forward !== 'pressed') backOk = false;
          // Our own selection on this step must have survived the round trip.
          if (!enabledControl(renderer!, 'Continue')) backOk = false;
        }
        walkLog.push(`q${q}-continue:${press(renderer!, 'Continue')}`);
      });
      observed['backWalkOk'] = backOk;
      observed['revealShown'] =
        allText(renderer).includes('YOUR STARTING PLAN');
      walkLog.push(`reveal:${press(renderer, 'Continue')}`);
      const onNotifications = allText(renderer).includes('Stay match-ready.');
      observed['notificationStepShown'] = onNotifications;

      if (clockAdvanceMs > 0) {
        await flush(clockAdvanceMs);
        observed['stillOnUnitAfterIdle'] = onOnboarding(renderer);
      }

      // ── Inject the finish-window faults and press the finishing control.
      for (const fault of finishFaults) fault.apply(world, scenario);
      const dbWritesBefore = world.db
        .kvWrites()
        .filter(
          w =>
            w.key === PENDING_PROFILE_KEY ||
            w.key === profileKeyFor(scenario.mode),
        ).length;
      if (finishFirst) {
        walkLog.push(`finish:${press(renderer, finishLabel)}`);
        await flush(100);
      } else {
        walkLog.push('finish:not-pressed-by-design');
      }

      if (inflight === 'double-tap') {
        doubleTapPress = press(renderer, finishLabel);
        if (doubleTapPress === 'missing') {
          doubleTapPress = busyVisible(renderer) ? 'disabled' : 'missing';
        }
      } else if (inflight === 'remount') {
        act(() => renderer!.unmount());
        renderer = mount();
        observed['remountSettled'] = await until(
          () => screenRendered(renderer),
          SETTLE_MS,
        );
      } else if (inflight === 'signout') {
        observed['signOutIssued'] = signOutFromScreen(renderer, walkLog);
        observed['signOutSettled'] = await until(
          () => screenRendered(renderer) && !onOnboarding(renderer),
          SETTLE_MS,
        );
      } else if (inflight === 'back-forward') {
        // The finish is in flight: step back to the reveal and forward again.
        walkLog.push(`inflight-back:${press(renderer, 'Back')}`);
        observed['backDuringInflightShowedReveal'] =
          allText(renderer).includes('YOUR STARTING PLAN');
        walkLog.push(`inflight-forward:${press(renderer, 'Continue')}`);
        observed['forwardDuringInflightOnNotifications'] =
          allText(renderer).includes('Stay match-ready.');
      }

      const first = await settle(() => renderer, scenario.mode);
      firstBusyMs = first.busyMs;
      firstAttemptProgressed = progressed(renderer, scenario.mode);
      firstAttemptError = useAppStore.getState().onboardingError;
      stuckBusy =
        busyVisible(renderer) || useAppStore.getState().onboardingBusy;
      controlAfterFirst = anyEnabledControl(renderer);
      observed['firstAttempt'] = {
        progressed: firstAttemptProgressed,
        error: firstAttemptError,
        errorOnScreen: (firstErrorOnScreen =
          Boolean(firstAttemptError) &&
          allText(renderer).includes(String(firstAttemptError))),
        busyMs: firstBusyMs,
        elapsedMs: first.elapsedMs,
        stuckBusy,
        enabledControl: controlAfterFirst,
        stillOnUnit: onOnboarding(renderer),
        profileWrites:
          world.db
            .kvWrites()
            .filter(
              w =>
                w.key === PENDING_PROFILE_KEY ||
                w.key === profileKeyFor(scenario.mode),
            ).length - dbWritesBefore,
      };

      if (inflight === 'signout') {
        signedOutLanding =
          countType(renderer, WelcomeScreen) > 0
            ? 'welcome'
            : onOnboarding(renderer)
              ? 'onboarding'
              : allText(renderer).includes('ROOT_NAVIGATOR')
                ? 'root'
                : allText(renderer).slice(0, 120);
        observed['signOut'] = {
          landing: signedOutLanding,
          authSession: useAuthStore.getState().session,
          storeProfile: useAppStore.getState().profile,
          keychainVault: world.keychain.has(VAULT_SERVICE),
          logoutCalls: world.server.logoutCalls.length,
          googleSignOutCalls: world.googleSignOutCalls,
        };
      }

      // ── Recovery: faults gone, ONE more tap must finish setup.
      if (
        !firstAttemptProgressed &&
        inflight !== 'remount' &&
        inflight !== 'signout'
      ) {
        world.faults = neutralFaults();
        await flush(SETTLE_STEP_MS);
        retryPress = press(renderer, finishLabel);
        if (retryPress === 'missing' && busyVisible(renderer))
          retryPress = 'disabled';
        const second = await settle(() => renderer, scenario.mode);
        retryProgressed = progressed(renderer, scenario.mode);
        retryError = useAppStore.getState().onboardingError;
        observed['retry'] = {
          press: retryPress,
          progressed: retryProgressed,
          error: retryError,
          busyMs: second.busyMs,
          stuckBusy:
            busyVisible(renderer) || useAppStore.getState().onboardingBusy,
        };
      } else if (inflight === 'remount' || inflight === 'signout') {
        retryPress = 'skipped';
      }
    }
  } catch (error) {
    crashError =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  }

  // Let anything still in flight surface (unhandled rejections, late writes).
  try {
    await flush(1_000);
  } catch (error) {
    crashError ??= error instanceof Error ? error.message : String(error);
  }

  const kvProblems = persistedStateSane(world, scenario.mode);
  const finalProgressed = progressed(renderer, scenario.mode);
  const finalBusy =
    busyVisible(renderer) || useAppStore.getState().onboardingBusy;
  // What the persisted notification record must say after a success. The
  // permission answer is taken on the FIRST tap (notificationChoice is
  // remembered by the screen), so a faulted permission answer sticks even
  // after a retry; every non-granted answer means "not enabled".
  const enabledOutcome =
    scenario.choice === 'enable' &&
    !finishFaults.some(
      f =>
        f.knob === 'scheduler.request' &&
        f.id !== 'permissions.request.slow-5s',
    );

  const pendingProfile = parseJson(world.db.kv.get(PENDING_PROFILE_KEY));
  const storedProfile = parseJson(
    world.db.kv.get(profileKeyFor(scenario.mode)),
  );
  const pendingNotifications = parseJson(
    world.db.kv.get(PENDING_NOTIFICATIONS_KEY),
  );
  const prefs = parseJson(world.db.kv.get(prefsKeyFor(scenario.mode)));
  const durableProfileOk =
    scenario.mode === 'preauth'
      ? isRecord(pendingProfile) &&
        pendingProfile['version'] === 1 &&
        profileMatches(pendingProfile['profile'], expected, false)
      : profileMatches(
          storedProfile,
          expected,
          scenario.mode === 'canonical',
        ) &&
        profileMatches(
          useAppStore.getState().profile,
          expected,
          scenario.mode === 'canonical',
        );
  const serverAccepted =
    scenario.mode !== 'canonical' ||
    world.server.acceptedProfiles.some(
      body =>
        body['skillLevel'] === expected.skillLevel &&
        body['handedness'] === expected.handedness &&
        body['goal'] === expected.goal &&
        body['biggestProblem'] === expected.biggestProblem,
    );
  const choicePersisted =
    scenario.mode === 'preauth'
      ? isRecord(pendingNotifications) &&
        pendingNotifications['enabled'] === enabledOutcome
      : isRecord(prefs) &&
        prefs['enabled'] === enabledOutcome &&
        prefs['promptDismissed'] === true;

  observed['unhandledRejections'] = [...unhandled];
  observed['crashError'] = crashError;
  observed['walk'] = walkLog;
  observed['kv'] = Object.fromEntries(
    [...world.db.kv.entries()].map(([k, v]) => [
      k,
      v.length > 200 ? `${v.slice(0, 200)}…(${v.length})` : v,
    ]),
  );
  observed['kvProblems'] = kvProblems;
  observed['storeProfile'] = useAppStore.getState().profile;
  observed['notificationStore'] = {
    permission: useNotificationStore.getState().permission,
    prefs: useNotificationStore.getState().prefs,
    persistFailed: useNotificationStore.getState().persistFailed,
    scheduleFailed: useNotificationStore.getState().scheduleFailed,
  };
  observed['scheduler'] = {
    calls: world.scheduler.calls,
    applied: world.scheduler.applied.length,
  };
  observed['server'] = {
    refreshCalls: world.server.refreshCalls.length,
    meCalls: world.server.meCalls.length,
    onboardingPuts: world.server.onboardingPuts,
    acceptedProfiles: world.server.acceptedProfiles.length,
    logoutCalls: world.server.logoutCalls,
    unexpected: [...new Set(world.server.unexpected)],
  };
  observed['keychainLog'] = world.keychainLog;
  observed['dbLog'] = world.dbLog;
  observed['finalProgressed'] = finalProgressed;
  observed['finalBusy'] = finalBusy;

  const firstAttemptSpec: FirstAttempt = scenario.faults.reduce<FirstAttempt>(
    (acc, f) => {
      if (f.window !== 'finish') return acc;
      if (f.firstAttempt === 'fail' || acc === 'fail') return 'fail';
      if (f.firstAttempt === 'any' || acc === 'any') return 'any';
      return 'success';
    },
    'success',
  );

  const procedural = inflight === 'remount' || inflight === 'signout';
  invariants['unitReached'] = unitReached;
  invariants['walkIntact'] =
    observed['backWalkOk'] === true &&
    observed['revealShown'] === true &&
    observed['notificationStepShown'] === true &&
    (!step1Back || observed['backLandedOnWelcome'] === true) &&
    (!leaveKeep || observed['leaveDialogDismissed'] === true) &&
    (clockAdvanceMs === 0 || observed['stillOnUnitAfterIdle'] === true);
  invariants['noCrash'] =
    crashError === null && unhandled.length === 0 && !crashed(renderer);
  invariants['noStuckSpinner'] = !finalBusy;
  invariants['visibleControl'] =
    finalProgressed || anyEnabledControl(renderer) !== null;
  invariants['noSilentFailure'] = procedural
    ? true
    : firstAttemptProgressed
      ? choicePersisted
      : firstErrorOnScreen;
  invariants['noFakeSuccess'] = procedural
    ? true
    : !finalProgressed || (durableProfileOk && serverAccepted);
  invariants['persistedStateSane'] = kvProblems.length === 0;
  invariants['firstAttemptAsExpected'] = procedural
    ? true
    : firstAttemptSpec === 'any' ||
      (firstAttemptSpec === 'success'
        ? firstAttemptProgressed
        : !firstAttemptProgressed);
  invariants['recoverable'] = procedural
    ? true
    : firstAttemptProgressed ||
      (retryPress === 'pressed' && retryProgressed && durableProfileOk);
  invariants['singleWrite'] =
    inflight !== 'double-tap' ||
    ((observed['firstAttempt'] as { profileWrites: number }).profileWrites <=
      1 &&
      doubleTapPress !== 'pressed');
  if (inflight === 'signout') {
    invariants['signOutLandsOnWelcome'] =
      signedOutLanding === 'welcome' &&
      useAuthStore.getState().session === null &&
      useAppStore.getState().profile === null;
  }
  if (inflight === 'remount') {
    // After a remount nothing may be half-written and the flow must be usable.
    invariants['usableAfterRemount'] =
      anyEnabledControl(renderer) !== null || finalProgressed;
  }
  if (inflight === 'back-forward') {
    invariants['backForwardIntact'] =
      observed['backDuringInflightShowedReveal'] === true &&
      observed['forwardDuringInflightOnNotifications'] === true;
  }
  if (!unitReached) {
    // Nothing downstream is meaningful; keep the row honest.
    for (const key of Object.keys(invariants)) {
      if (
        key !== 'unitReached' &&
        key !== 'noCrash' &&
        key !== 'persistedStateSane'
      ) {
        invariants[key] = true;
      }
    }
  }

  if (renderer) {
    try {
      act(() => renderer!.unmount());
    } catch {
      // ignore teardown errors; they are already in the row if they matter
    }
  }
  // Drain every slow/hung timer into THIS world so nothing leaks into the next
  // scenario; a rejection surfacing only now is still the app's, so it counts.
  const unhandledBeforeDrain = unhandled.length;
  try {
    await flush(DRAIN_MS);
  } catch (error) {
    crashError ??= error instanceof Error ? error.message : String(error);
  }
  observed['lateUnhandledRejections'] = unhandled.slice(unhandledBeforeDrain);
  if (unhandled.length > unhandledBeforeDrain) {
    invariants['noCrash'] = false;
    observed['unhandledRejections'] = [...unhandled];
  }
  useAppStore.setState({ completeOnboarding: originalComplete });
  useNotificationStore.setState({
    completeOnboardingStep: originalNotifications,
  });
  resetProcessState();

  const failed = Object.entries(invariants)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);
  return {
    name: scenario.name,
    seed: scenario.seed,
    mode: scenario.mode,
    faults: scenario.faults.map(f => f.id),
    dependencies: [...new Set(scenario.faults.map(f => f.dependency))],
    choice: scenario.choice,
    inputs: {
      answers: scenario.answers,
      backAt: scenario.backAt,
      vaultProvider: scenario.vaultProvider,
      windows: scenario.faults.map(f => `${f.id}@${f.window}`),
      inflight,
      clockAdvanceMs,
      step1Back,
      leaveKeep,
      expectedProfile: expected,
      expectedNotificationEnabled: enabledOutcome,
    },
    observed,
    invariants,
    failed,
    ok: failed.length === 0,
    durationMs: Date.now() - startedWall,
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const SCENARIOS = buildScenarios();
const rows: Row[] = [];

function artifactDir(): string {
  const configured = env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress-onboarding');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(() => {
  jest.useFakeTimers();
});

afterAll(() => {
  const dir = artifactDir();
  const byInvariant: Record<string, string[]> = {};
  for (const row of rows) {
    for (const key of row.failed) {
      (byInvariant[key] ??= []).push(row.name);
    }
  }
  const summary = {
    suite: 'stress/onboardingScreen.failureInjection',
    executed: rows.length,
    unitReached: rows.filter(r => r.invariants['unitReached']).length,
    ok: rows.filter(r => r.ok).length,
    failed: rows
      .filter(r => !r.ok)
      .map(r => ({
        name: r.name,
        seed: r.seed,
        mode: r.mode,
        faults: r.faults,
        failed: r.failed,
      })),
    byInvariant,
    distinctFaults: new Set(rows.flatMap(r => r.faults)).size,
    byDependency: Object.fromEntries(
      (
        [
          'sqlite',
          'fetch',
          'keychain',
          'permissions',
          'scheduler',
          'clock',
          'navigation',
          'persisted-state',
        ] as Dependency[]
      ).map(dep => [
        dep,
        rows.filter(r => r.dependencies.includes(dep)).length,
      ]),
    ),
    byMode: Object.fromEntries(
      MODES.map(mode => [mode, rows.filter(r => r.mode === mode).length]),
    ),
    replay:
      'cd apps/mobile && STRESS_SCENARIO=<name> npx jest --ci __tests__/stress/onboardingScreen.failureInjection.stress.test.tsx  (or STRESS_SEED=<seed>)',
    env: { STRESS_ITER, STRESS_FULL, SEED_FILTER, SCENARIO_FILTER },
  };
  fs.writeFileSync(
    path.join(dir, 'failure-injection.rows.json'),
    JSON.stringify(rows, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'failure-injection.summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );
  jest.useRealTimers();
});

describe('OnboardingScreen × failure injection (real App/Gate/stores)', () => {
  test.each(SCENARIOS.map(s => [s.name, s] as const))(
    '%s',
    async (_name, scenario) => {
      const row = await runScenario(scenario);
      rows.push(row);
      expect({
        seed: row.seed,
        mode: row.mode,
        faults: row.faults,
        failed: row.failed,
        firstAttempt: row.observed['firstAttempt'],
        retry: row.observed['retry'],
        crash: row.observed['crashError'],
        unhandled: row.observed['unhandledRejections'],
      }).toEqual(expect.objectContaining({ failed: [] }));
    },
    120_000,
  );
});
