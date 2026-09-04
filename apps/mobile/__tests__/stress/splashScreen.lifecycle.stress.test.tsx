/**
 * STRESS — scr-splashscreen / lens `lifecycle`.
 *
 * Mounts the REAL <App /> (SafeAreaProvider → QueryClientProvider →
 * RootErrorBoundary → Gate) with the REAL SplashScreen, the real authStore /
 * appStore / notificationStore / consistencyStore / sessionKeeper and the real
 * design components. Only the process edges are faked: Keychain map,
 * FakeLocalDb (SQLite), a scripted fetch for /v1/auth/refresh + /v1/me,
 * AppState, AccessibilityInfo (reduce-motion), the notification scheduler, and
 * the leaf screens under the splash (Welcome / Onboarding / SignIn /
 * RootNavigator render an owner-tagged marker so the harness can tell WHOSE
 * screen the fade reveals). `react-native-video` is the repo's inert host-view
 * mock; the harness drives its onProgress / onEnd / onError from a per-seed
 * playback plan and pauses that clock while the app is backgrounded.
 *
 * Every seed is a deterministic timeline over one persisted install:
 *   cold launch → (background | foreground | skip-tap | remount |
 *   kill+relaunch | relaunch-as-other-user | sign-out | permission-revoke |
 *   reduce-motion | flip-server-online)* → settle → teardown
 * with the intro {ends at N ms | errors at N ms | stalls} and the server in
 * {rotate | 401 | network | hang | slow} with a seeded latency.
 *
 * Invariants (each a MatrixRow.invariants key):
 *   noCrash               RootErrorBoundary never renders, no hydrate() rejects,
 *                         no console.error
 *   splashLeavesOnce      per launch the overlay leaves at most once and never
 *                         comes back (Gate.splashDone is sticky)
 *   neverLeavesEarly      the overlay never leaves before BOTH the gate is ready
 *                         AND the intro is over (ended/errored/watchdog/skip)
 *   leavesWithinBudget    once both hold, the overlay is gone within
 *                         EXIT_MS + slack (skip honoured, watchdog honoured)
 *   noStrandedSplash      a launch that lived past the watchdog + launch
 *                         deadline has no overlay left (frozen-frame risk)
 *   revealPainted         the moment the overlay is gone the screen underneath
 *                         is a painted stage (marker or loading affordance),
 *                         never empty
 *   noStaleUserReveal     the revealed stage never carries a marker for an
 *                         owner other than the one the auth session names at
 *                         that instant (no state from a previous user)
 *   revealedStageExpected the revealed stage is the one the persisted truth
 *                         implies for that launch (idempotent re-hydrate); a
 *                         loading affordance is accepted only when the session
 *                         changed during the fade
 *   skipGateBeforeOneSecond  Skip is never rendered before 1 s of playback
 *   statusBarBalanced     the overlay's bar-style entry sits on top while it is
 *                         up, is popped when it leaves, stack empty after unmount
 *   volumeRampsToZero     a non-reduced-motion fade ends with volume 0
 *   onFinishedOncePerMount onFinished fires at most once per mounted overlay
 *   noLeakedTimers        after teardown jest.getTimerCount() === 0
 *   noLeakedListeners     after teardown no AppState listener remains
 *
 * Artifacts: <repo>/artifacts/stress-splash-lifecycle/
 *   splash-lifecycle.rows.json    one row per executed seed (seed → outcome)
 *   splash-lifecycle.summary.json counts + failing seeds + replay command
 * Scale: STRESS_ITER=<n> (default 12). Replay: STRESS_SEED=<seed>.
 */
import React from 'react';
import {
  AccessibilityInfo,
  AppState,
  NativeModules,
  StatusBar,
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
  CANONICAL_ID,
  OTHER_CANONICAL_ID,
  makePrng,
  pick,
  validProfile,
  validVault,
} from '../../xc-harness/lifecycle-persistence/seeds';
import type { MatrixRow } from '../../xc-harness/lifecycle-persistence/artifacts';

declare const __dirname: string;

// ─── Module seams (process edges only) ───────────────────────────────────────

const mockDb = { current: new FakeLocalDb() };
jest.mock('../../src/data/db', () => ({
  getDb: () => mockDb.current.handle(),
}));

const mockKeychain = {
  store: new Map<string, { username: string; password: string }>(),
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
    mockKeychain.store.set(options.service ?? '__default__', {
      username,
      password,
    });
    return { service: options.service, storage: 'mock' };
  },
  getGenericPassword: async (options: { service?: string } = {}) => {
    const item = mockKeychain.store.get(options.service ?? '__default__');
    if (!item) return false;
    return { service: options.service, storage: 'mock', ...item };
  },
  resetGenericPassword: async (options: { service?: string } = {}) =>
    mockKeychain.store.delete(options.service ?? '__default__'),
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

// Leaf stages under the overlay: owner-tagged markers so the harness can tell
// whose first screen the fade reveals. Everything above them is production.
function mockOwnerTaggedMarker(tag: string) {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  const scope = jest.requireActual<
    typeof import('../../src/data/accountScope')
  >('../../src/data/accountScope');
  return () =>
    R.createElement(RN.Text, null, `${tag}:${scope.getActiveDataOwner()}`);
}
jest.mock('../../src/navigation/RootNavigator', () => ({
  RootNavigator: mockOwnerTaggedMarker('ROOT_NAVIGATOR'),
}));
jest.mock('../../src/screens/OnboardingScreen', () => ({
  OnboardingScreen: mockOwnerTaggedMarker('ONBOARDING'),
}));
jest.mock('../../src/screens/WelcomeScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return { WelcomeScreen: () => R.createElement(RN.Text, null, 'WELCOME') };
});
jest.mock('../../src/screens/SignInScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return { SignInScreen: () => R.createElement(RN.Text, null, 'SIGN_IN') };
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
jest.mock('../../src/design/BrandNotice', () => ({
  BrandNoticeHost: () => null,
}));

// The REAL SplashScreen, wrapped only to observe its onFinished boundary
// (count per mount, and whether it fired while the overlay was unmounting).
const mockSplashProbe = {
  calls: [] as { mounted: boolean }[],
  mountedCount: 0,
};
jest.mock('../../src/screens/SplashScreen', () => {
  const actual = jest.requireActual<
    typeof import('../../src/screens/SplashScreen')
  >('../../src/screens/SplashScreen');
  const R = jest.requireActual<typeof import('react')>('react');
  function InstrumentedSplashScreen(props: {
    ready: boolean;
    onFinished: () => void;
  }) {
    const mountedRef = R.useRef(true);
    // Layout cleanups run parent-first, so this flag flips BEFORE the real
    // overlay's Animated nodes detach during the same unmount.
    R.useLayoutEffect(() => {
      mountedRef.current = true;
      mockSplashProbe.mountedCount += 1;
      return () => {
        mountedRef.current = false;
      };
    }, []);
    const { onFinished } = props;
    const wrapped = R.useCallback(() => {
      mockSplashProbe.calls.push({ mounted: mountedRef.current });
      onFinished();
    }, [onFinished]);
    return R.createElement(actual.SplashScreen, {
      ready: props.ready,
      onFinished: wrapped,
    });
  }
  return { ...actual, SplashScreen: InstrumentedSplashScreen };
});

import App from '../../App';
import { EXIT_MS, WATCHDOG_MS } from '../../src/screens/SplashScreen';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
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

// ─── Scripted server ─────────────────────────────────────────────────────────

type ServerMode = 'rotate' | 'refuse-401' | 'network' | 'hang' | 'error-500';
const SERVER_MODES: readonly ServerMode[] = [
  'rotate',
  'rotate',
  'refuse-401',
  'network',
  'hang',
  'error-500',
];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Supabase Auth's default refresh-token reuse interval: a token rotated
 * within this window still answers with the SAME successor session. */
const REUSE_WINDOW_MS = 10_000;

interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

class ScriptedServer {
  mode: ServerMode = 'rotate';
  latencyMs = 0;
  readonly valid = new Set<string>();
  readonly rotated = new Map<string, { at: number; next: IssuedSession }>();
  readonly refreshCalls: { at: number; outcome: string }[] = [];
  readonly unexpected: string[] = [];
  /** in-flight latency timers — a process kill drops them (socket gone) */
  readonly inflight = new Set<ReturnType<typeof setTimeout>>();
  now: () => number = () => Date.now();
  private counter = 0;

  private delay(ms: number, signal: AbortSignal | null | undefined) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflight.delete(timer);
        resolve();
      }, ms);
      this.inflight.add(timer);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        this.inflight.delete(timer);
        reject(new Error('AbortError (simulated fetch abort)'));
      });
    });
  }

  /** The process died: every request still on the wire never answers. */
  dropInflight(): void {
    for (const timer of this.inflight) clearTimeout(timer);
    this.inflight.clear();
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
      const call = { at: this.now(), outcome: 'pending' };
      this.refreshCalls.push(call);
      try {
        if (this.mode === 'hang') {
          await this.delay(10 * 60_000, signal);
          call.outcome = 'hang-elapsed';
          return new Response(null, { status: 599 });
        }
        await this.delay(this.latencyMs, signal);
        switch (this.mode) {
          case 'refuse-401':
            call.outcome = '401';
            return jsonResponse(401, { error: { message: 'revoked' } });
          case 'error-500':
            call.outcome = '500';
            return jsonResponse(500, { error: { message: 'boom' } });
          case 'network':
            call.outcome = 'network-error';
            throw new TypeError('Network request failed');
          case 'rotate':
          default: {
            const reuse = this.rotated.get(token);
            if (reuse && this.now() - reuse.at <= REUSE_WINDOW_MS) {
              call.outcome = `reused→${reuse.next.refreshToken}`;
              return jsonResponse(200, { session: reuse.next });
            }
            if (!this.valid.has(token)) {
              call.outcome = '401-unknown-token';
              return jsonResponse(401, { error: { message: 'unknown' } });
            }
            this.counter += 1;
            this.valid.delete(token);
            const refresh = `refresh-${this.counter}`;
            this.valid.add(refresh);
            const next: IssuedSession = {
              accessToken: `access-${this.counter}`,
              refreshToken: refresh,
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            };
            this.rotated.set(token, { at: this.now(), next });
            call.outcome = `rotated→${refresh}`;
            return jsonResponse(200, { session: next });
          }
        }
      } catch (error) {
        if (call.outcome === 'pending') call.outcome = 'aborted-by-client';
        throw error;
      }
    }
    if (url === `${API_BASE}/v1/me`) {
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
      await this.delay(Math.min(this.latencyMs, 200), signal);
      return new Response(null, { status: 204 });
    }
    this.unexpected.push(url);
    return jsonResponse(404, { error: { message: 'unexpected route' } });
  };
}

// ─── Native event plumbing ───────────────────────────────────────────────────

const appStateListeners = new Set<(state: string) => void>();
function emitAppState(state: 'active' | 'background'): void {
  for (const listener of [...appStateListeners]) listener(state);
}
const reduceMotionListeners = new Set<(value: boolean) => void>();
function emitReduceMotion(value: boolean): void {
  for (const listener of [...reduceMotionListeners]) listener(value);
}

// ─── Scenario space ──────────────────────────────────────────────────────────

type StepKind =
  | 'background'
  | 'foreground'
  | 'skip-tap'
  | 'remount'
  | 'kill-relaunch'
  | 'relaunch-as-other-user'
  | 'sign-out'
  | 'permission-revoke'
  | 'reduce-motion'
  | 'flip-server-online';
const STEP_KINDS: readonly StepKind[] = [
  'background',
  'foreground',
  'skip-tap',
  'skip-tap',
  'remount',
  'kill-relaunch',
  'relaunch-as-other-user',
  'sign-out',
  'permission-revoke',
  'reduce-motion',
  'flip-server-online',
];

type InstallKind =
  'fresh' | 'existing-vault' | 'existing-vault-no-profile' | 'existing-guest';
const INSTALL_KINDS: readonly InstallKind[] = [
  'fresh',
  'existing-vault',
  'existing-vault',
  'existing-vault-no-profile',
  'existing-guest',
];

type VideoPlan =
  | { kind: 'ends'; atMs: number }
  | { kind: 'errors'; atMs: number }
  | { kind: 'stalls' };

interface Step {
  /** ms after the current launch started (fake clock) */
  atMs: number;
  kind: StepKind;
}

interface Scenario {
  seed: number;
  install: InstallKind;
  mode: ServerMode;
  latencyMs: number;
  video: VideoPlan;
  steps: Step[];
}

function seededScenario(seed: number): Scenario {
  const rng = makePrng(seed);
  const install = pick(rng, INSTALL_KINDS);
  const mode = pick(rng, SERVER_MODES);
  const latencyMs = pick(rng, [0, 50, 400, 3_000, 7_500, 9_000, 14_000]);
  const videoKind = pick(rng, [
    'ends',
    'ends',
    'ends',
    'errors',
    'stalls',
  ] as const);
  const video: VideoPlan =
    videoKind === 'ends'
      ? { kind: 'ends', atMs: pick(rng, [900, 2_500, 5_000, 7_900, 9_500]) }
      : videoKind === 'errors'
        ? { kind: 'errors', atMs: pick(rng, [0, 300, 1_200, 4_000]) }
        : { kind: 'stalls' };
  const stepCount = 1 + Math.floor(rng() * 4);
  const steps: Step[] = [];
  let cursor = 0;
  let backgrounded = false;
  for (let i = 0; i < stepCount; i += 1) {
    cursor += Math.floor(rng() * 3_000);
    let kind = pick(rng, STEP_KINDS);
    if (kind === 'foreground' && !backgrounded) kind = 'background';
    if (kind === 'background' && backgrounded) kind = 'foreground';
    if (kind === 'background') backgrounded = true;
    if (kind === 'foreground') backgrounded = false;
    // A process kill or remount lands the app in the foreground again.
    if (
      kind === 'kill-relaunch' ||
      kind === 'relaunch-as-other-user' ||
      kind === 'remount'
    ) {
      backgrounded = false;
      steps.push({ atMs: cursor, kind });
      // Times after a relaunch are relative to the new launch; a fresh
      // cursor keeps later steps inside the new intro.
      cursor = 0;
      continue;
    }
    steps.push({ atMs: cursor, kind });
  }
  if (backgrounded) {
    cursor += 500;
    steps.push({ atMs: cursor, kind: 'foreground' });
  }
  return { seed, install, mode, latencyMs, video, steps };
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const VAULT_SERVICE = 'com.picklesensei.auth.session';
const INITIAL_REFRESH = 'refresh-initial';
const OTHER_REFRESH = 'refresh-other-user';
const CANONICAL_OWNER = canonicalDataOwner(CANONICAL_ID);
const OTHER_OWNER = canonicalDataOwner(OTHER_CANONICAL_ID);
const LAUNCH_DEADLINE_MS = 8_000;
const SLICE_MS = 100;
/** Scheduling slack on top of EXIT_MS: one slice for the effect that starts
 * the fade plus one for the completion callback. */
const HANDOFF_SLACK_MS = 3 * SLICE_MS;
/** How long a launch is allowed to live before the overlay counts as stranded. */
const STRANDED_AFTER_MS = WATCHDOG_MS + LAUNCH_DEADLINE_MS + 2_000;
const LOADING_MARKERS = ['Loading your account', 'Getting things ready'];
const STAGE_MARKERS = ['WELCOME', 'SIGN_IN', 'ONBOARDING:', 'ROOT_NAVIGATOR:'];

type Renderer = ReturnType<typeof TestRenderer.create>;

function hostNodes(renderer: Renderer | null, testID: string) {
  if (!renderer) return [];
  try {
    return renderer.root.findAll(
      node => node.props['testID'] === testID && typeof node.type === 'string',
    );
  } catch {
    return [];
  }
}

/** The Skip control: the one pressable the overlay owns (any depth). */
function findSkip(renderer: Renderer | null) {
  if (!renderer) return undefined;
  try {
    return renderer.root.findAll(
      node =>
        node.props['testID'] === 'splash-skip' &&
        typeof node.props['onPress'] === 'function',
    )[0];
  } catch {
    return undefined;
  }
}

function renderedText(renderer: Renderer | null): string {
  if (!renderer) return '<unmounted>';
  try {
    return renderer.root
      .findAllByType(Text)
      .map(node => String(node.props['children']))
      .join('|');
  } catch {
    return '<no-text>';
  }
}

function desiredOwnerNow(): string | null {
  const auth = useAuthStore.getState();
  if (!auth.hydrated) return null;
  return auth.session?.provider === 'guest'
    ? GUEST_DATA_OWNER
    : auth.session?.canonicalAppUserId
      ? canonicalDataOwner(auth.session.canonicalAppUserId)
      : SIGNED_OUT_DATA_OWNER;
}

function gateReady(): boolean {
  const app = useAppStore.getState();
  const desired = desiredOwnerNow();
  return desired !== null && app.hydrated && app.ownerKey === desired;
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
  useWalkthroughStore.setState({ visible: false, queued: false });
}

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

interface Launch {
  index: number;
  /** why this launch started */
  why: string;
  /** persisted owner this launch should land on */
  expectedOwner: string;
  startedAt: number;
  endedAfterMs: number | null;
  readyAt: number | null;
  /** intro over (ended / errored / watchdog) — relative to launch */
  playbackOverAt: number | null;
  /** first skip tap that hit a rendered Skip control — relative to launch */
  skipAt: number | null;
  skipVisibleAt: number | null;
  /** playback delivered when Skip first rendered */
  skipVisibleVideoMs: number | null;
  skipTapsIgnored: number;
  /** explicit signOut() issued while this launch was up (ms since launch) */
  signedOutAt: number | null;
  /** reduce-motion switched on while this launch was up (ms since launch) */
  reduceMotionAt: number | null;
  splashGoneAt: number | null;
  splashReturned: boolean;
  revealedText: string | null;
  revealedOwner: string | null;
  revealedReady: boolean | null;
  /** distinct player volumes in render order */
  volumes: number[];
  /** reduce-motion already on when this launch started */
  reducedMotionAtStart: boolean;
  statusBarDepthWhileUp: number[];
  statusBarDepthAfterReveal: number | null;
  onFinishedCalls: number;
  /** onFinished fired after this launch's overlay had unmounted */
  onFinishedAfterUnmount: number;
  /** ms of playback the fake player delivered */
  videoTimeMs: number;
}

interface VideoState {
  timeMs: number;
  ended: boolean;
  errored: boolean;
}

function seedInstall(
  db: FakeLocalDb,
  install: InstallKind,
  server: ScriptedServer,
): string {
  if (install === 'existing-vault' || install === 'existing-vault-no-profile') {
    mockKeychain.store.set(VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify(validVault({ refreshToken: INITIAL_REFRESH })),
    });
    server.valid.add(INITIAL_REFRESH);
    db.seedShots(CANONICAL_OWNER, 12, 'real');
    if (install === 'existing-vault') {
      db.kv.set(`profile:${CANONICAL_OWNER}`, JSON.stringify(validProfile()));
    }
    db.kv.set('walkthrough.device-complete', JSON.stringify({ version: 1 }));
    return CANONICAL_OWNER;
  }
  if (install === 'existing-guest') {
    db.kv.set('auth.local-mode', JSON.stringify({ version: 1, mode: 'guest' }));
    db.kv.set(`profile:${GUEST_DATA_OWNER}`, JSON.stringify(validProfile()));
    db.seedShots(GUEST_DATA_OWNER, 5, 'real');
    db.kv.set('walkthrough.device-complete', JSON.stringify({ version: 1 }));
    return GUEST_DATA_OWNER;
  }
  return SIGNED_OUT_DATA_OWNER;
}

/** The previous user is gone from the device; a second account signed in
 * before the kill and left its own vault record + profile behind. */
function switchPersistedUser(db: FakeLocalDb, server: ScriptedServer): string {
  mockKeychain.store.set(VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify(
      validVault({
        canonicalAppUserId: OTHER_CANONICAL_ID,
        refreshToken: OTHER_REFRESH,
        email: 'sam@example.com',
        displayName: 'Sam Second',
      }),
    ),
  });
  server.valid.add(OTHER_REFRESH);
  db.kv.set('auth.local-mode', '');
  db.kv.set(`profile:${OTHER_OWNER}`, JSON.stringify(validProfile()));
  db.seedShots(OTHER_OWNER, 3, 'second');
  return OTHER_OWNER;
}

/** Stages the persisted truth allows the fade to reveal for this launch. */
function expectedStages(scenario: Scenario, launch: Launch): string[] {
  const signedOutBeforeReveal =
    launch.signedOutAt !== null &&
    launch.splashGoneAt !== null &&
    launch.signedOutAt <= launch.splashGoneAt;
  if (signedOutBeforeReveal) return ['WELCOME'];
  const owner = launch.expectedOwner;
  if (owner === SIGNED_OUT_DATA_OWNER) return ['WELCOME'];
  if (owner === GUEST_DATA_OWNER) return [`ROOT_NAVIGATOR:${GUEST_DATA_OWNER}`];
  const profiled =
    owner === OTHER_OWNER || scenario.install === 'existing-vault';
  // Without a local profile the store adopts the canonical one when the
  // refresh landed inside the launch window (→ app), else asks onboarding.
  const inApp = profiled
    ? [`ROOT_NAVIGATOR:${owner}`]
    : [`ROOT_NAVIGATOR:${owner}`, `ONBOARDING:${owner}`];
  if (scenario.mode === 'refuse-401') {
    // A refusal inside the launch window signs out before the gate is ready;
    // a late one (after the 8 s launch wait) reveals the app signed in and
    // the implicit sign-out follows. Anything that restarts or re-times the
    // refresh before it answers (server flip, remount's second hydrate, a
    // foreground re-check) can legitimately land either way.
    const disturbed = scenario.steps.some(
      s =>
        s.kind === 'flip-server-online' ||
        s.kind === 'remount' ||
        ((s.kind === 'background' ||
          s.kind === 'foreground' ||
          s.kind === 'permission-revoke') &&
          s.atMs < scenario.latencyMs),
    );
    return scenario.latencyMs < LAUNCH_DEADLINE_MS &&
      !disturbed &&
      launch.why !== 'remount'
      ? ['WELCOME']
      : [...inApp, 'WELCOME'];
  }
  return inApp;
}

/** Wall clock captured before fake timers replace `Date`. */
const realNow: () => number = Date.now.bind(Date);

/** Drops every pending fake timer WITHOUT moving the clock (jest's
 * clearAllTimers also rewinds the fake clock to its install time). */
function dropAllTimers(): void {
  const now = Date.now();
  jest.clearAllTimers();
  jest.setSystemTime(now);
}

async function runScenario(scenario: Scenario): Promise<MatrixRow> {
  const startedWall = realNow();
  // Whatever the previous scenario's process left behind died with it (and
  // was already scored against that scenario).
  dropAllTimers();
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

  // Persisted world.
  const db = new FakeLocalDb();
  mockDb.current = db;
  mockKeychain.store.clear();
  const server = new ScriptedServer();
  server.mode = scenario.mode;
  server.latencyMs = scenario.latencyMs;
  server.now = rel;
  (globalThis as { fetch: unknown }).fetch = server.fetch;
  mockScheduler.current = new FakeScheduler();
  mockSplashProbe.calls.length = 0;
  mockSplashProbe.mountedCount = 0;
  let persistedOwner = seedInstall(db, scenario.install, server);
  let shotsBefore = db.shotFingerprint();
  resetProcessState();
  emitReduceMotion(false);
  const statusBarStack = (
    StatusBar as unknown as { _propsStack: { barStyle: unknown }[] }
  )._propsStack;
  statusBarStack.length = 0;
  const timersBefore = jest.getTimerCount();
  const listenersBefore = appStateListeners.size;

  const consoleErrors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(a => String(a))
          .join(' ')
          .slice(0, 300),
      );
    });
  const rejections: string[] = [];
  const pending: Promise<void>[] = [];

  const launches: Launch[] = [];
  const sessionTag = (
    s: { provider: string; canonicalAppUserId: string | null } | null,
  ) => (s ? `${s.provider}:${s.canonicalAppUserId ?? '-'}` : null);
  const sessionChanges: {
    at: number;
    from: string | null;
    to: string | null;
  }[] = [];
  const unsubscribe = useAuthStore.subscribe((next, prev) => {
    const from = sessionTag(prev.session);
    const to = sessionTag(next.session);
    if (next.hydrated && from !== to)
      sessionChanges.push({ at: rel(), from, to });
  });

  let renderer: Renderer | null = null;
  let backgrounded = false;
  let reducedMotion = false;
  let video: VideoState = { timeMs: 0, ended: false, errored: false };
  let probeCallsSeen = 0;
  let errorBoundarySeen = false;

  const current = () => launches[launches.length - 1]!;
  const sinceLaunch = () => rel() - current().startedAt;

  const mount = (why: string) => {
    video = { timeMs: 0, ended: false, errored: false };
    launches.push({
      index: launches.length + 1,
      why,
      expectedOwner: persistedOwner,
      startedAt: rel(),
      endedAfterMs: null,
      readyAt: null,
      playbackOverAt: null,
      skipAt: null,
      skipVisibleAt: null,
      skipVisibleVideoMs: null,
      skipTapsIgnored: 0,
      signedOutAt: null,
      reduceMotionAt: null,
      splashGoneAt: null,
      splashReturned: false,
      revealedText: null,
      revealedOwner: null,
      revealedReady: null,
      volumes: [],
      reducedMotionAtStart: reducedMotion,
      statusBarDepthWhileUp: [],
      statusBarDepthAfterReveal: null,
      onFinishedCalls: 0,
      onFinishedAfterUnmount: 0,
      videoTimeMs: 0,
    });
    log('mount', { why, launch: launches.length });
    act(() => {
      renderer = TestRenderer.create(<App />);
    });
  };

  /** Runs `fn` inside an async act so every store update it triggers (and the
   * microtasks it unleashes) is flushed as React expects. */
  const within = async (fn: () => void) => {
    await act(async () => {
      fn();
      await jest.advanceTimersByTimeAsync(0);
    });
  };

  // An onFinished that arrives with the overlay already unmounted belongs to
  // the launch whose overlay went away last, not to the one now on screen.
  let lastUnmounted: Launch | null = null;
  const accountProbe = () => {
    while (probeCallsSeen < mockSplashProbe.calls.length) {
      const call = mockSplashProbe.calls[probeCallsSeen]!;
      probeCallsSeen += 1;
      const launch = call.mounted ? current() : (lastUnmounted ?? current());
      launch.onFinishedCalls += 1;
      if (!call.mounted) launch.onFinishedAfterUnmount += 1;
      log('splash.onFinished', { mounted: call.mounted, launch: launch.index });
    }
  };

  const unmount = (why: string) => {
    const launch = current();
    if (launch.endedAfterMs === null) launch.endedAfterMs = sinceLaunch();
    log('unmount', { why });
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
    accountProbe();
    if (launch.splashGoneAt === null) lastUnmounted = launch;
  };

  /** Process death: nothing scheduled by the dead process ever runs again —
   * its timers, its in-flight sockets, its pending promises. Persisted state
   * (Keychain, SQLite) survives untouched. */
  const killProcess = () => {
    server.dropInflight();
    dropAllTimers();
    resetProcessState();
  };

  /** Observe the tree after every slice: readiness, overlay, reveal. */
  const observe = () => {
    const launch = current();
    if (!renderer) return;
    accountProbe();
    const text = renderedText(renderer);
    if (text.includes('Something went wrong')) errorBoundarySeen = true;
    if (launch.readyAt === null && gateReady()) {
      launch.readyAt = sinceLaunch();
      log('gate.ready', { launch: launch.index, text });
    }
    const overlay = hostNodes(renderer, 'splash-screen')[0];
    const skip = findSkip(renderer);
    if (skip && launch.skipVisibleAt === null) {
      launch.skipVisibleAt = sinceLaunch();
      launch.skipVisibleVideoMs = video.timeMs;
      log('splash.skip-visible', { videoTimeMs: video.timeMs });
    }
    if (overlay) {
      launch.statusBarDepthWhileUp.push(statusBarStack.length);
      if (launch.splashGoneAt !== null) launch.splashReturned = true;
    } else if (launch.splashGoneAt === null) {
      launch.splashGoneAt = sinceLaunch();
      launch.revealedText = text;
      launch.revealedReady = gateReady();
      launch.revealedOwner = desiredOwnerNow();
      launch.statusBarDepthAfterReveal = statusBarStack.length;
      log('splash.gone', { text, ready: launch.revealedReady });
    }
  };

  /** One 100 ms slice of fake time: timers, then the fake player's clock. */
  const slice = async () => {
    await flush(SLICE_MS);
    const launch = current();
    const player = hostNodes(renderer, 'splash-video')[0];
    if (player && !backgrounded && !video.ended && !video.errored) {
      const props = player.props as {
        onProgress?: (e: {
          currentTime: number;
          playableDuration: number;
          seekableDuration: number;
        }) => void;
        onEnd?: () => void;
        onError?: (e: unknown) => void;
        volume?: number;
      };
      video.timeMs += SLICE_MS;
      launch.videoTimeMs = video.timeMs;
      const plan = scenario.video;
      await act(async () => {
        if (plan.kind === 'errors' && video.timeMs >= plan.atMs) {
          video.errored = true;
          props.onError?.({ error: { code: -11800, domain: 'AVFoundation' } });
        } else {
          props.onProgress?.({
            currentTime: video.timeMs / 1000,
            playableDuration: 9.5,
            seekableDuration: 9.5,
          });
          if (plan.kind === 'ends' && video.timeMs >= plan.atMs) {
            video.ended = true;
            props.onEnd?.();
          }
        }
      });
      if (video.ended || video.errored) {
        launch.playbackOverAt = sinceLaunch();
        log(video.ended ? 'video.end' : 'video.error');
      }
    }
    if (launch.playbackOverAt === null && sinceLaunch() >= WATCHDOG_MS) {
      launch.playbackOverAt = WATCHDOG_MS;
      log('video.watchdog');
    }
    const playerNow = hostNodes(renderer, 'splash-video')[0];
    if (playerNow) {
      const v = (playerNow.props as { volume?: number }).volume;
      if (
        typeof v === 'number' &&
        launch.volumes[launch.volumes.length - 1] !== v
      ) {
        launch.volumes.push(v);
      }
    }
    observe();
  };

  const advance = async (ms: number) => {
    let left = ms;
    while (left > 0) {
      await slice();
      left -= SLICE_MS;
    }
  };

  // ── Cold launch.
  mount('cold-launch');
  await flush(0);
  observe();

  for (const step of scenario.steps) {
    const wait = step.atMs - sinceLaunch();
    if (wait > 0) await advance(wait);
    log(`step.${step.kind}`, { sinceLaunch: sinceLaunch() });
    switch (step.kind) {
      case 'background':
        backgrounded = true;
        await within(() => emitAppState('background'));
        break;
      case 'foreground':
        backgrounded = false;
        await within(() => emitAppState('active'));
        break;
      case 'skip-tap': {
        const skip = findSkip(renderer as Renderer | null);
        if (skip) {
          if (current().skipAt === null) current().skipAt = sinceLaunch();
          await within(() => {
            (skip.props as { onPress: () => void }).onPress();
          });
        } else {
          current().skipTapsIgnored += 1;
        }
        break;
      }
      case 'remount':
        unmount('remount');
        mount('remount');
        await flush(0);
        break;
      case 'kill-relaunch':
        unmount('kill');
        killProcess();
        mount('relaunch-after-kill');
        await flush(0);
        break;
      case 'relaunch-as-other-user':
        unmount('kill-before-user-switch');
        killProcess();
        persistedOwner = switchPersistedUser(db, server);
        shotsBefore = db.shotFingerprint();
        mount('relaunch-as-other-user');
        await flush(0);
        break;
      case 'sign-out': {
        if (useAuthStore.getState().session) {
          current().signedOutAt = sinceLaunch();
          persistedOwner = SIGNED_OUT_DATA_OWNER;
          await within(() => {
            pending.push(
              useAuthStore
                .getState()
                .signOut()
                .catch((error: unknown) => {
                  rejections.push(
                    `signOut: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }),
            );
          });
        }
        break;
      }
      case 'permission-revoke':
        mockScheduler.current.permission = 'denied';
        if (!backgrounded) {
          await within(() => emitAppState('background'));
          await within(() => emitAppState('active'));
        }
        break;
      case 'reduce-motion':
        reducedMotion = true;
        if (current().reduceMotionAt === null) {
          current().reduceMotionAt = sinceLaunch();
        }
        await within(() => emitReduceMotion(true));
        break;
      case 'flip-server-online':
        server.mode = 'rotate';
        server.latencyMs = Math.min(server.latencyMs, 50);
        break;
    }
    observe();
  }

  // ── Settle: long enough for the watchdog, the launch deadline and the fade.
  const settleTarget = STRANDED_AFTER_MS + 1_000;
  if (sinceLaunch() < settleTarget) await advance(settleTarget - sinceLaunch());
  const finalText = renderedText(renderer);
  const finalSession = useAuthStore.getState().session;
  unmount('end');
  await Promise.all(pending);
  unsubscribe();
  resetProcessState();
  await flush(0);
  // Teardown is the app's own sign-out/stop path (stopSessionKeeper drops an
  // in-flight refresh's result when it lands rather than aborting it). A
  // timer that self-cancels inside a bounded request timeout is not a leak;
  // anything still armed — or any NEW request — a minute later is.
  const timersAtTeardown = jest.getTimerCount();
  const serverPendingAtTeardown = server.inflight.size;
  const refreshCallsAtTeardown = server.refreshCalls.length;
  await flush(60_000);
  const timersAfter = jest.getTimerCount();
  const requestsAfterTeardown =
    server.refreshCalls.length - refreshCallsAtTeardown;
  const listenersAfter = appStateListeners.size;
  const statusBarAfter = statusBarStack.length;
  errorSpy.mockRestore();

  // ── Oracle.
  const inv: Record<string, boolean> = {};
  const lived = (l: Launch) => l.endedAfterMs ?? Number.POSITIVE_INFINITY;
  const triggerAt = (l: Launch): number | null => {
    if (l.readyAt === null) return null;
    const over =
      l.skipAt !== null && l.playbackOverAt !== null
        ? Math.min(l.skipAt, l.playbackOverAt)
        : (l.skipAt ?? l.playbackOverAt);
    if (over === null) return null;
    return Math.max(l.readyAt, over);
  };

  inv['noCrash'] =
    !errorBoundarySeen &&
    rejections.length === 0 &&
    consoleErrors.length === 0 &&
    server.unexpected.length === 0;
  inv['splashLeavesOnce'] = launches.every(
    l => !l.splashReturned && l.onFinishedCalls <= 1,
  );
  inv['neverLeavesEarly'] = launches.every(l => {
    if (l.splashGoneAt === null) return true;
    const t = triggerAt(l);
    // Quantised to the observation slice: the fade may complete inside the
    // same slice its trigger landed in.
    return t !== null && l.splashGoneAt + SLICE_MS >= t;
  });
  const reducedAt = (l: Launch, atMs: number) =>
    l.reducedMotionAtStart ||
    (l.reduceMotionAt !== null && l.reduceMotionAt <= atMs);
  inv['leavesWithinBudget'] = launches.every(l => {
    const t = triggerAt(l);
    if (t === null) return true;
    const budget = t + (reducedAt(l, t) ? 0 : EXIT_MS) + HANDOFF_SLACK_MS;
    if (lived(l) < budget) return true; // killed before it could finish
    return l.splashGoneAt !== null && l.splashGoneAt <= budget;
  });
  inv['noStrandedSplash'] = launches.every(
    l => lived(l) < STRANDED_AFTER_MS || l.splashGoneAt !== null,
  );
  inv['revealPainted'] = launches.every(
    l =>
      l.revealedText === null ||
      [...STAGE_MARKERS, ...LOADING_MARKERS].some(m =>
        l.revealedText!.includes(m),
      ),
  );
  inv['noStaleUserReveal'] = launches.every(l => {
    if (l.revealedText === null) return true;
    const owners = [CANONICAL_OWNER, OTHER_OWNER, GUEST_DATA_OWNER];
    return owners.every(
      o => !l.revealedText!.includes(`:${o}`) || o === l.revealedOwner,
    );
  });
  inv['revealedStageExpected'] = launches.every(l => {
    if (l.revealedText === null) return true;
    const allowed = expectedStages(scenario, l);
    if (allowed.some(m => l.revealedText!.includes(m))) return true;
    // A loading affordance is honest only if the session changed during the
    // fade (owner flip mid-exit re-hydrates under the departing overlay).
    const goneAbs = l.startedAt + (l.splashGoneAt ?? 0);
    const flippedDuringFade = sessionChanges.some(
      c => c.at >= goneAbs - EXIT_MS - HANDOFF_SLACK_MS && c.at <= goneAbs,
    );
    return (
      flippedDuringFade &&
      LOADING_MARKERS.some(m => l.revealedText!.includes(m))
    );
  });
  inv['skipGateBeforeOneSecond'] = launches.every(
    l => l.skipVisibleVideoMs === null || l.skipVisibleVideoMs >= 1_000,
  );
  inv['statusBarBalanced'] =
    launches.every(
      l =>
        l.statusBarDepthWhileUp.every(d => d >= 2) &&
        (l.statusBarDepthAfterReveal === null ||
          l.statusBarDepthAfterReveal === 1),
    ) && statusBarAfter === 0;
  // The player only ever hears the sound go DOWN (a fade that restarted or a
  // remount that re-applied full volume mid-exit would show a rise).
  inv['volumeNeverRises'] = launches.every(l =>
    l.volumes.every((v, i) => i === 0 || v <= l.volumes[i - 1]!),
  );
  inv['onFinishedOncePerMount'] =
    launches.every(l => l.onFinishedCalls <= 1) &&
    mockSplashProbe.calls.length <= mockSplashProbe.mountedCount;
  // An overlay torn down mid-fade must not report completion afterwards: the
  // parent that would receive it is gone (or, on a remount, a different one).
  inv['noOnFinishedAfterUnmount'] = launches.every(
    l => l.onFinishedAfterUnmount === 0,
  );
  inv['noLeakedTimers'] =
    timersBefore === 0 && timersAfter === 0 && requestsAfterTeardown === 0;
  inv['noLeakedListeners'] =
    listenersAfter === listenersBefore && listenersAfter === 0;
  inv['shotsPreserved'] =
    db.shotFingerprint() === shotsBefore &&
    db.destructiveStatements().length === 0;

  const failed = Object.entries(inv)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    suite: 'stress-splash-lifecycle',
    scenario: `seed-${scenario.seed}`,
    seed: scenario.seed,
    inputs: {
      install: scenario.install,
      mode: scenario.mode,
      latencyMs: scenario.latencyMs,
      video: scenario.video,
      steps: scenario.steps,
    },
    observed: {
      launches,
      sessionChanges,
      refreshCalls: server.refreshCalls,
      onFinishedAfterUnmount: launches.reduce(
        (n, l) => n + l.onFinishedAfterUnmount,
        0,
      ),
      serverPendingAtTeardown,
      timersAtTeardown,
      requestsAfterTeardown,
      finalText,
      finalSession: finalSession
        ? `${finalSession.provider}:${finalSession.canonicalAppUserId ?? '-'}`
        : null,
      timersBefore,
      timersAfter,
      listenersBefore,
      listenersAfter,
      statusBarAfter,
      consoleErrors,
      rejections,
      errorBoundarySeen,
      timeline,
    },
    invariants: inv,
    ok: failed.length === 0,
    failed,
    durationMs: realNow() - startedWall,
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
          '../../../../artifacts/stress-splash-lifecycle',
        );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
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
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockImplementation(async () => false);
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((
    _type: string,
    handler: (value: boolean) => void,
  ) => {
    reduceMotionListeners.add(handler);
    return { remove: () => reduceMotionListeners.delete(handler) };
  }) as unknown as typeof AccessibilityInfo.addEventListener);
  nativeModules.PickleAuth = { signInWithApple: jest.fn() };
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  delete nativeModules.PickleAuth;
  jest.useRealTimers();
});

const ITER = Number(nodeProcess.env['STRESS_ITER'] ?? 12);
const SEED_BASE = Number(nodeProcess.env['STRESS_SEED_BASE'] ?? 5000);
const SEED_FILTER = nodeProcess.env['STRESS_SEED'];

describe('STRESS scr-splashscreen / lifecycle — real App + real SplashScreen', () => {
  const rows: MatrixRow[] = [];
  const seeds = SEED_FILTER
    ? SEED_FILTER.split(',').map(s => Number(s.trim()))
    : Array.from({ length: ITER }, (_, i) => SEED_BASE + i);

  const CHUNK = 25;
  for (let start = 0; start < seeds.length; start += CHUNK) {
    const chunk = seeds.slice(start, start + CHUNK);
    it(`seeds ${chunk[0]}..${chunk[chunk.length - 1]}`, async () => {
      for (const seed of chunk)
        rows.push(await runScenario(seededScenario(seed)));
    }, 600_000);
  }

  it('writes the seed → outcome table and every seed held its invariants', () => {
    const failing = rows.filter(r => !r.ok);
    const summary = {
      suite: 'stress-splash-lifecycle',
      executed: rows.length,
      passed: rows.length - failing.length,
      failed: failing.length,
      invariantFailures: rows.reduce<Record<string, number>>((acc, r) => {
        for (const name of r.failed) acc[name] = (acc[name] ?? 0) + 1;
        return acc;
      }, {}),
      onFinishedAfterUnmountRows: rows.filter(
        r => (r.observed['onFinishedAfterUnmount'] as number) > 0,
      ).length,
      strandedRows: rows.filter(r => r.failed.includes('noStrandedSplash'))
        .length,
      failingSeeds: failing.map(r => ({ seed: r.seed, failed: r.failed })),
      seedTable: rows.map(r => ({
        seed: r.seed,
        ok: r.ok,
        failed: r.failed,
        install: r.inputs['install'],
        mode: r.inputs['mode'],
        latencyMs: r.inputs['latencyMs'],
        video: r.inputs['video'],
        steps: (r.inputs['steps'] as Step[]).map(s => `${s.kind}@${s.atMs}`),
        launches: (r.observed['launches'] as Launch[]).map(l => ({
          why: l.why,
          readyAt: l.readyAt,
          playbackOverAt: l.playbackOverAt,
          skipAt: l.skipAt,
          splashGoneAt: l.splashGoneAt,
          revealed: l.revealedText,
          endedAfterMs: l.endedAfterMs,
        })),
      })),
      replay:
        'cd apps/mobile && STRESS_SEED=<seed> npx jest --ci --detectOpenHandles __tests__/stress/splashScreen.lifecycle.stress.test.tsx',
    };
    const paths = [
      writeJson('splash-lifecycle.rows.json', rows),
      writeJson('splash-lifecycle.summary.json', summary),
    ];
    console.log(
      JSON.stringify({
        harness: 'stress-splash-lifecycle',
        executed: rows.length,
        failed: failing.length,
        invariantFailures: summary.invariantFailures,
        paths,
      }),
    );
    expect(rows.length).toBe(seeds.length);
    expect(failing.map(r => ({ seed: r.seed, failed: r.failed }))).toEqual([]);
  });
});

// ─── Directed interleavings ─────────────────────────────────────────────────
// Hand-placed interrupts inside the windows the random schedule rarely hits:
// the 520 ms exit fade (900..1420 after a 900 ms intro) and the instant the
// gate flips ready. Same runner, same oracle; seeds 9000+ are reserved.

const DIRECTED: { name: string; scenario: Scenario; pinnedDefect?: string }[] =
  [
    {
      name: 'remount while the exit fade is running',
      // Pinned defect (stress finding, seed 9001): the exit `Animated.parallel`
      // has no effect cleanup, so its completion callback still runs after the
      // overlay unmounted and calls `onFinished` on a dead parent. `it.failing`
      // keeps the suite green while pinning the behaviour; once SplashScreen
      // stops the animation / guards the callback on unmount this test turns
      // red — then drop `pinnedDefect`.
      pinnedDefect: 'noOnFinishedAfterUnmount',
      scenario: {
        seed: 9001,
        install: 'existing-guest',
        mode: 'rotate',
        latencyMs: 0,
        video: { kind: 'ends', atMs: 900 },
        steps: [{ atMs: 1_100, kind: 'remount' }],
      },
    },
    {
      name: 'kill + relaunch while the exit fade is running',
      scenario: {
        seed: 9002,
        install: 'existing-vault',
        mode: 'rotate',
        latencyMs: 0,
        video: { kind: 'ends', atMs: 900 },
        steps: [{ atMs: 1_100, kind: 'kill-relaunch' }],
      },
    },
    {
      name: 'background then foreground inside the exit fade',
      scenario: {
        seed: 9003,
        install: 'existing-vault',
        mode: 'rotate',
        latencyMs: 0,
        video: { kind: 'ends', atMs: 900 },
        steps: [
          { atMs: 1_000, kind: 'background' },
          { atMs: 1_300, kind: 'foreground' },
        ],
      },
    },
    {
      name: 'sign-out lands mid-fade: the reveal must be the signed-out stage',
      scenario: {
        seed: 9004,
        install: 'existing-vault',
        mode: 'rotate',
        latencyMs: 0,
        video: { kind: 'ends', atMs: 900 },
        steps: [{ atMs: 1_100, kind: 'sign-out' }],
      },
    },
    {
      name: 'account switch (kill) mid-fade: no first-user state on relaunch',
      scenario: {
        seed: 9005,
        install: 'existing-vault',
        mode: 'rotate',
        latencyMs: 0,
        video: { kind: 'ends', atMs: 900 },
        steps: [{ atMs: 1_100, kind: 'relaunch-as-other-user' }],
      },
    },
    {
      name: 'token rotation answers 100 ms after Skip is tapped',
      scenario: {
        seed: 9006,
        install: 'existing-vault-no-profile',
        mode: 'rotate',
        latencyMs: 2_500,
        video: { kind: 'stalls' },
        steps: [{ atMs: 2_400, kind: 'skip-tap' }],
      },
    },
    {
      name: 'refresh refused exactly as the intro ends',
      scenario: {
        seed: 9007,
        install: 'existing-vault',
        mode: 'refuse-401',
        latencyMs: 900,
        video: { kind: 'ends', atMs: 900 },
        steps: [],
      },
    },
    {
      name: 'notification permission revoked while the fade runs',
      scenario: {
        seed: 9008,
        install: 'existing-guest',
        mode: 'rotate',
        latencyMs: 0,
        video: { kind: 'ends', atMs: 900 },
        steps: [{ atMs: 1_000, kind: 'permission-revoke' }],
      },
    },
    {
      name: 'reduce-motion flips on mid-fade',
      scenario: {
        seed: 9009,
        install: 'existing-guest',
        mode: 'rotate',
        latencyMs: 0,
        video: { kind: 'ends', atMs: 900 },
        steps: [{ atMs: 1_100, kind: 'reduce-motion' }],
      },
    },
    {
      name: 'watchdog fires while the refresh still hangs, then a kill',
      scenario: {
        seed: 9010,
        install: 'existing-vault',
        mode: 'hang',
        latencyMs: 0,
        video: { kind: 'stalls' },
        steps: [{ atMs: 8_600, kind: 'kill-relaunch' }],
      },
    },
  ];

describe('STRESS scr-splashscreen / lifecycle — directed interleavings', () => {
  const rows: MatrixRow[] = [];

  for (const { name, scenario, pinnedDefect } of DIRECTED) {
    if (pinnedDefect) {
      let pinnedRow: MatrixRow | null = null;
      it(`${scenario.seed}: ${name} — every other invariant holds`, async () => {
        pinnedRow = await runScenario(scenario);
        rows.push(pinnedRow);
        expect(pinnedRow.failed.filter(f => f !== pinnedDefect)).toEqual([]);
      }, 120_000);
      // Passes only while the defect is still present; goes red once fixed.
      it.failing(
        `${scenario.seed}: ${name} [pinned defect: ${pinnedDefect}]`,
        () => {
          expect(pinnedRow).not.toBeNull();
          expect(pinnedRow?.failed).not.toContain(pinnedDefect);
        },
      );
      continue;
    }
    it(`${scenario.seed}: ${name}`, async () => {
      const row = await runScenario(scenario);
      rows.push(row);
      expect(row.failed).toEqual([]);
    }, 120_000);
  }

  afterAll(() => {
    writeJson('splash-lifecycle.directed.json', rows);
  });
});
