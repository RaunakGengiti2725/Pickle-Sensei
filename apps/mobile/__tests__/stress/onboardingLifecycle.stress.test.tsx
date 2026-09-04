/**
 * STRESS scr-onboardingscreen / lens `lifecycle`.
 *
 * Mounts the REAL <App /> (Gate + RootErrorBoundary + owner-scoped bootstraps
 * + the real WelcomeScreen / SignInScreen / OnboardingScreen) against the
 * real authStore / appStore / notificationStore / consistencyStore /
 * sessionKeeper, faking only the process edges: Keychain, SQLite (FakeLocalDb),
 * the notification scheduler, AppState, the native Apple sign-in module and
 * `fetch` (a scripted account API).
 *
 * A seeded driver walks the questionnaire like a player would (reading the
 * rendered tree, pressing labelled controls) while the schedule injects
 * lifecycle interruptions at seeded points: background/foreground, remount,
 * kill + relaunch (re-hydrate from Keychain + SQLite), back, token rotation,
 * server-side session revocation, account switch, and interruptions fired
 * while the completion request is still in flight. After the app is reached
 * the schedule may revoke the reminder permission, switch accounts again or
 * kill/relaunch once more; every run ends with a cold relaunch, two extra
 * hydrate() calls and a leak audit.
 *
 * Invariants (MatrixRow.invariants keys):
 *   noCrash                RootErrorBoundary never rendered; no driver exception
 *   reachedApp             the final signed-in account lands on ROOT_NAVIGATOR
 *   profileTruthLocal      store profile == SQLite profile:<owner> == answers
 *   profileTruthServer     server profile for the owner == answers (core fields)
 *   noCrossAccount         no profile / PUT for account X carries account Y's
 *                          answers; the questionnaire renders empty for a new
 *                          account (no previous user's name)
 *   pendingCleared         device-level pending profile/notification slots are
 *                          consumed once a signed-in account adopted them
 *   noDuplicatePut         saved PUTs per account <= finish taps for it
 *   notificationTruth      prefs:<owner>.enabled reflects the owner's choice ×
 *                          the OS answer; promptDismissed after onboarding
 *   permissionRevoke       after revoke + foreground the plan is cancelled and
 *                          nothing is re-applied while denied
 *   busyNotStuck           onboardingBusy never stays true with no request in
 *                          flight; final state not busy
 *   idempotentRehydrate    two extra hydrate() calls change nothing and issue
 *                          no PUT
 *   noLeaks                after the final unmount: 0 fake timers, 0 AppState
 *                          listeners
 *   noTokenInKv            no bearer / refresh token in SQLite kv
 *   ownerAgreement         every store hydrate finished for the active owner
 *   noUnexpectedRoutes     the client only called the routes the contract names
 *   requestsSettled        every request the surviving process issued settled
 *                          (no pending/unroutable request, no harness error)
 *
 * Scale: STRESS_ITER (default 12) seeded iterations + the fixed seeds below.
 * Replay one seed: STRESS_SEED=<seed> npx jest --ci __tests__/stress/onboardingLifecycle.stress.test.tsx
 * Artifacts: artifacts/stress-onboarding-lifecycle/onboarding-lifecycle.{rows,summary}.json
 */
import React from 'react';
import { AppState, NativeModules, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import type { PlannedNotification } from '../../src/notifications/types';
import { FakeLocalDb } from '../../xc-harness/lifecycle-persistence/fakeLocalDb';
import { nodeProcess } from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  CANONICAL_ID,
  OTHER_CANONICAL_ID,
  validVault,
} from '../../xc-harness/lifecycle-persistence/seeds';
import {
  ScriptedAccountServer,
  type StoredProfile,
} from '../../stress-harness/onboarding-lifecycle/server';
import {
  seededScenario,
  reanswer,
  type Answers,
  type LifecycleEventKind,
  type Scenario,
} from '../../stress-harness/onboarding-lifecycle/scenario';
import {
  summarize,
  wallMs,
  writeJsonArtifact,
  type StressRow,
} from '../../stress-harness/onboarding-lifecycle/artifacts';

// ─── Module seams (native modules + process edges only) ──────────────────────

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
  permission: PermissionState = 'undetermined';
  requestResult: PermissionState = 'granted';
  applied: { at: number; plan: PlannedNotification[] }[] = [];
  cancelAll: number[] = [];
  requests = 0;
  now: () => number = () => 0;
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    this.requests += 1;
    if (this.permission === 'undetermined')
      this.permission = this.requestResult;
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.applied.push({ at: this.now(), plan: [...plan] });
  }
  async cancelAllPlanned(): Promise<void> {
    this.cancelAll.push(this.now());
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
// The main navigator is out of scope (it pulls the whole signed-in app);
// a marker text is the observable "landed in the app" state.
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
jest.mock('../../src/design/BrandNotice', () => ({
  BrandNoticeHost: () => null,
}));
// Real design components (the screen's Button / PressableScale / BrandDialog
// are the controls under test); only the endless spinner loop is stubbed so
// it cannot masquerade as a leaked timer.
jest.mock('../../src/design/components', () => ({
  ...jest.requireActual<typeof import('../../src/design/components')>(
    '../../src/design/components',
  ),
  BrandSpinner: () => null,
}));

import App from '../../App';
import { useAuthStore } from '../../src/auth/authStore';
import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../../src/notifications/notificationStore';
import { notificationPrefsKeyForOwner } from '../../src/notifications/types';
import { useConsistencyStore } from '../../src/consistency/store';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { Profile } from '../../src/state/profile';

// ─── Constants ───────────────────────────────────────────────────────────────

const VAULT_SERVICE = 'com.picklesensei.auth.session';
const INITIAL_REFRESH = 'refresh-initial';
const ACCOUNTS = {
  A: {
    id: CANONICAL_ID,
    owner: canonicalDataOwner(CANONICAL_ID),
    email: 'pat@example.com',
    identityToken: 'apple-identity-token-A',
  },
  B: {
    id: OTHER_CANONICAL_ID,
    owner: canonicalDataOwner(OTHER_CANONICAL_ID),
    email: 'bea@example.com',
    identityToken: 'apple-identity-token-B',
  },
} as const;
type AccountKey = keyof typeof ACCOUNTS;

const GENDER_LABEL: Record<string, string> = {
  female: 'Female',
  male: 'Male',
  nonbinary: 'Non-binary',
  prefer_not_to_say: 'Prefer not to say',
};
const LEVEL_LABEL: Record<string, string> = { Beginner: 'Brand new' };
const HANDEDNESS_LABEL: Record<string, string> = {
  right: 'Right-handed',
  left: 'Left-handed',
};
const GOAL_LABEL: Record<string, string> = {
  dinks: 'Dinks',
  drives: 'Drives',
  drops: 'Third-shot drops',
  serve: 'Serve',
  volleys: 'Volleys',
  footwork: 'Footwork',
  'all-around': 'All-around',
};
const PROBLEM_LABEL: Record<string, string> = {
  consistency: 'Consistency',
  control: 'Control',
  power: 'Power',
  contact: 'Contact',
  footwork: 'Footwork',
  placement: 'Placement',
  'not sure': 'Not sure',
};

const STEP_TITLES = {
  gender: 'How do you identify?',
  level: 'Where is your game today?',
  handedness: 'Which side is home?',
  goal: 'What do you want to own?',
  problem: 'What breaks down most?',
  reveal: 'YOUR STARTING PLAN',
  notifications: 'Stay match-ready.',
} as const;

const MAX_TICKS = 600;
const ERROR_BOUNDARY_TEXT = 'Something went wrong';

// ─── Test-renderer helpers ───────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;

function renderedText(renderer: Renderer | null): string {
  if (!renderer) return '';
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string | number => typeof c !== 'object')
    .join('|');
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

function pressable(renderer: Renderer, label: string) {
  return pressables(renderer, label)[0] ?? null;
}

function nameInput(renderer: Renderer) {
  return renderer.root.findAllByType(TextInput)[0] ?? null;
}

// ─── AppState plumbing ───────────────────────────────────────────────────────

const appStateListeners = new Set<(state: string) => void>();
function emitAppState(state: 'active' | 'background'): void {
  for (const listener of [...appStateListeners]) listener(state);
}

const nativeModules = NativeModules as {
  PickleAuth?: { signInWithApple: () => Promise<unknown> };
};
const signInTarget: { current: AccountKey } = { current: 'A' };

// ─── Process reset (what an OS kill destroys) ────────────────────────────────

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

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

// ─── Screen classification ───────────────────────────────────────────────────

type Screen =
  | 'crash'
  | 'app'
  | 'welcome'
  | 'signin'
  | 'hydrate-error'
  | 'ob-name'
  | 'ob-gender'
  | 'ob-level'
  | 'ob-handedness'
  | 'ob-goal'
  | 'ob-problem'
  | 'ob-reveal'
  | 'ob-notifications'
  | 'loading'
  | 'unmounted'
  | 'unknown';

function classify(renderer: Renderer | null): Screen {
  if (!renderer) return 'unmounted';
  const text = renderedText(renderer);
  if (text.includes(ERROR_BOUNDARY_TEXT)) return 'crash';
  if (text.includes('ROOT_NAVIGATOR')) return 'app';
  if (text.includes('Your coaching profile couldn’t load'))
    return 'hydrate-error';
  if (pressable(renderer, 'Start your first read')) return 'welcome';
  if (pressable(renderer, 'Continue with Apple')) return 'signin';
  if (text.includes(STEP_TITLES.notifications)) return 'ob-notifications';
  if (text.includes(STEP_TITLES.reveal)) return 'ob-reveal';
  if (text.includes(STEP_TITLES.problem)) return 'ob-problem';
  if (text.includes(STEP_TITLES.goal)) return 'ob-goal';
  if (text.includes(STEP_TITLES.handedness)) return 'ob-handedness';
  if (text.includes(STEP_TITLES.level)) return 'ob-level';
  if (text.includes(STEP_TITLES.gender)) return 'ob-gender';
  if (nameInput(renderer) && pressable(renderer, 'Continue')) return 'ob-name';
  if (
    text.includes('Getting things ready') ||
    text.includes('Loading your account')
  )
    return 'loading';
  return 'unknown';
}

function coreOf(profile: Partial<Profile> | StoredProfile | null | undefined) {
  if (!profile) return null;
  return {
    skillLevel: profile.skillLevel,
    handedness: profile.handedness,
    goal: profile.goal,
    biggestProblem: profile.biggestProblem,
  };
}

function coreOfAnswers(answers: Answers) {
  return {
    skillLevel: answers.level,
    handedness: answers.handedness,
    goal: answers.goal,
    biggestProblem: answers.problem,
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseJson(raw: string | undefined | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

// ─── Scenario runner ─────────────────────────────────────────────────────────

interface TimelineEvent {
  at: number;
  kind: string;
  detail?: Record<string, unknown>;
}

async function runScenario(scenario: Scenario): Promise<StressRow> {
  const startedWall = wallMs();
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
  const server = new ScriptedAccountServer();
  server.addAccount(ACCOUNTS.A);
  server.addAccount(ACCOUNTS.B);
  server.latencyMs = scenario.latencyMs;
  server.putLatencyMs = scenario.putLatencyMs;
  server.putMode = scenario.putMode;
  server.bearerPolicy = scenario.bearerPolicy;
  server.bearerTtlSec = scenario.bearerTtlSec;
  server.now = rel;
  (globalThis as { fetch: unknown }).fetch = server.fetch;
  const scheduler = new FakeScheduler();
  scheduler.requestResult = scenario.permission;
  scheduler.now = rel;
  mockScheduler.current = scheduler;
  signInTarget.current = 'A';

  if (scenario.install === 'account') {
    mockKeychain.store.set(VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify(validVault({ refreshToken: INITIAL_REFRESH })),
    });
    server.seedRefreshToken(ACCOUNTS.A.id, INITIAL_REFRESH);
  }
  db.kv.set('walkthrough.device-complete', JSON.stringify({ version: 1 }));

  resetProcessState();

  // ── Store subscriptions: owner agreement at every hydrate finish.
  const unsubscribers: (() => void)[] = [];
  let ownerMismatchAtStoreFinish = 0;
  unsubscribers.push(
    useAppStore.subscribe((next, prev) => {
      if (!prev.hydrated && next.hydrated) {
        if (next.ownerKey !== getActiveDataOwner())
          ownerMismatchAtStoreFinish += 1;
        log('app.hydrated', {
          owner: next.ownerKey,
          activeOwner: getActiveDataOwner(),
          hasProfile: Boolean(next.profile),
        });
      }
    }),
  );
  unsubscribers.push(
    useNotificationStore.subscribe((next, prev) => {
      if (!prev.hydrated && next.hydrated) {
        if (next.ownerKey !== getActiveDataOwner())
          ownerMismatchAtStoreFinish += 1;
      }
    }),
  );
  unsubscribers.push(
    useAuthStore.subscribe((next, prev) => {
      if (prev.session && !next.session) log('auth.signed-out');
      if (!prev.session && next.session)
        log('auth.signed-in', { account: next.session.canonicalAppUserId });
    }),
  );

  let renderer: Renderer | null = null;
  let errorBoundarySeen = false;
  const driverErrors: string[] = [];
  const firstScreenAfterOwnerChange: {
    owner: string;
    nameValue: unknown;
    leakedName: string | null;
  }[] = [];
  let lastOnboardingOwner: string | null = null;
  const finishTaps: {
    at: number;
    account: string;
    choice: string;
    osWouldGrant: boolean;
    answers: Answers;
  }[] = [];
  let busyIdleTicks = 0;
  let busyStuckMax = 0;
  let permissionRevokedAt: number | null = null;
  let cancelAfterRevoke = false;
  let appliedAfterRevoke = 0;
  let finishInterruptFired = scenario.finishInterrupt === 'none';
  let hungReleasedAt: number | null = null;
  const firedEvents: { beforeAction: number; kind: string }[] = [];

  const observe = () => {
    if (renderer && renderedText(renderer).includes(ERROR_BOUNDARY_TEXT)) {
      errorBoundarySeen = true;
    }
  };

  const mount = (why: string) => {
    log('mount', { why });
    act(() => {
      renderer = TestRenderer.create(<App />);
    });
  };
  const unmount = (why: string) => {
    log('unmount', { why });
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
  };
  const advance = async (ms: number) => {
    let left = ms;
    while (left > 0) {
      const slice = Math.min(left, 250);
      await flush(slice);
      left -= slice;
      observe();
    }
  };

  const currentAccount = (): AccountKey | null => {
    const session = useAuthStore.getState().session;
    if (!session?.canonicalAppUserId) return null;
    return session.canonicalAppUserId === ACCOUNTS.A.id ? 'A' : 'B';
  };
  const baseAnswers = (key: AccountKey): Answers =>
    key === 'A' ? scenario.answersA : scenario.answersB;
  // Every fresh walk of the questionnaire (empty name field) answers
  // differently, so a stale completion landing late is visible.
  const walksStarted: Record<AccountKey, number> = { A: 0, B: 0 };
  const answersFor = (key: AccountKey): Answers =>
    reanswer(baseAnswers(key), Math.max(0, walksStarted[key] - 1));
  /** Who is answering right now: the signed-in account, or (pre-auth) A. */
  const answeringAccount = (): AccountKey =>
    currentAccount() ?? signInTarget.current;

  const press = (label: string): boolean => {
    if (!renderer) return false;
    const node = pressable(renderer, label);
    if (!node || node.props.disabled) return false;
    act(() => {
      node.props.onPress();
    });
    log('press', { label });
    return true;
  };

  // ── Lifecycle interruptions.
  const jumpToNearExpiry = () => {
    const api = getApiSession();
    if (api?.bearerExpiresAtMs == null) return;
    const target = api.bearerExpiresAtMs - 2 * 60_000;
    if (target > Date.now()) jest.setSystemTime(new Date(target));
  };
  const backgroundForeground = async (gapMs: number) => {
    act(() => emitAppState('background'));
    await advance(Math.min(gapMs, 2_000));
    if (gapMs > 2_000) jest.setSystemTime(new Date(Date.now() + gapMs - 2_000));
    act(() => emitAppState('active'));
    await flush(0);
  };
  const killRelaunch = async () => {
    unmount('kill');
    resetProcessState();
    server.proc += 1;
    mount('relaunch');
    await flush(0);
  };
  const runEvent = async (kind: LifecycleEventKind, gapMs = 100) => {
    log(`event.${kind}`);
    switch (kind) {
      case 'background-foreground':
        await backgroundForeground(gapMs);
        break;
      case 'remount':
        unmount('remount');
        mount('remount');
        await flush(0);
        break;
      case 'kill-relaunch':
        await killRelaunch();
        break;
      case 'back':
        press('Back');
        await flush(0);
        break;
      case 'token-rotation':
        jumpToNearExpiry();
        await backgroundForeground(100);
        break;
      case 'revoke-session': {
        const account = currentAccount();
        if (account) server.revokeAccountSessions(ACCOUNTS[account].id);
        jumpToNearExpiry();
        await backgroundForeground(100);
        break;
      }
      case 'account-switch': {
        const account = currentAccount();
        if (!account) break;
        signInTarget.current = account === 'A' ? 'B' : 'A';
        if (press('Leave setup')) {
          await flush(0);
          if (!press('Sign out')) {
            void useAuthStore.getState().signOut();
          }
        } else {
          void useAuthStore.getState().signOut();
        }
        await flush(0);
        break;
      }
      case 'permission-revoke-later':
        scheduler.permission = 'denied';
        permissionRevokedAt = rel();
        await backgroundForeground(100);
        break;
    }
  };

  // ── Driver.
  let actionCount = 0;
  let ticks = 0;
  const pendingEvents = [...scenario.events];

  const fireDueEvents = async () => {
    while (
      pendingEvents.length &&
      pendingEvents[0]!.beforeAction <= actionCount
    ) {
      const event = pendingEvents.shift()!;
      firedEvents.push({ beforeAction: event.beforeAction, kind: event.kind });
      await runEvent(event.kind, event.gapMs);
    }
  };

  const selectAndContinue = (label: string): void => {
    if (!press(label)) throw new Error(`option not pressable: ${label}`);
    actionCount += 1;
  };

  const tapFinish = async (answers: Answers) => {
    const account = answeringAccount();
    const label = answers.finish === 'enable' ? 'Turn on reminders' : 'Not now';
    if (!press(label)) return;
    finishTaps.push({
      at: rel(),
      account: ACCOUNTS[account].id,
      choice: answers.finish,
      answers,
      osWouldGrant:
        scheduler.permission === 'granted' ||
        (scheduler.permission === 'undetermined' &&
          scheduler.requestResult === 'granted'),
    });
    actionCount += 1;
    if (!finishInterruptFired) {
      finishInterruptFired = true;
      await advance(scenario.finishInterruptAfterMs);
      log('finish-interrupt', { kind: scenario.finishInterrupt });
      switch (scenario.finishInterrupt) {
        case 'unmount-remount':
          await runEvent('remount');
          break;
        case 'kill-relaunch':
          await runEvent('kill-relaunch');
          break;
        case 'background-foreground':
          await runEvent('background-foreground', 30_000);
          break;
        case 'account-switch':
          await runEvent('account-switch');
          break;
        case 'revoke-session':
          await runEvent('revoke-session');
          break;
        case 'token-rotation':
          await runEvent('token-rotation');
          break;
        case 'none':
          break;
      }
    }
  };

  const goalReached = (): boolean => {
    const account = currentAccount();
    return (
      classify(renderer) === 'app' &&
      account !== null &&
      account === signInTarget.current &&
      pendingEvents.length === 0
    );
  };

  const step = async (): Promise<void> => {
    ticks += 1;
    observe();
    // Hung PUTs are released after the interrupt had its chance to fire.
    if (
      server.hungCount() > 0 &&
      finishInterruptFired &&
      hungReleasedAt === null &&
      rel() - (finishTaps[finishTaps.length - 1]?.at ?? 0) >=
        scenario.humanDelayMs + 200
    ) {
      hungReleasedAt = rel();
      log('release-hung', { count: server.releaseHung() });
    }
    const busy = useAppStore.getState().onboardingBusy;
    if (busy && server.inflight === 0 && server.hungCount() === 0) {
      busyIdleTicks += 1;
      busyStuckMax = Math.max(busyStuckMax, busyIdleTicks);
    } else {
      busyIdleTicks = 0;
    }

    const screen = classify(renderer);
    if (screen.startsWith('ob-')) {
      const owner = getActiveDataOwner();
      if (owner !== lastOnboardingOwner) {
        lastOnboardingOwner = owner;
        const text = renderedText(renderer);
        const otherNames = [
          scenario.answersA.name,
          scenario.answersB.name,
        ].filter(name => name !== answersFor(answeringAccount()).name);
        firstScreenAfterOwnerChange.push({
          owner,
          nameValue: renderer ? nameInput(renderer)?.props.value : undefined,
          leakedName: otherNames.find(name => text.includes(name)) ?? null,
        });
      }
      await fireDueEvents();
    }
    const current = classify(renderer);
    if (current === 'ob-name' && renderer) {
      const input = nameInput(renderer);
      if (input && input.props.value === '') {
        walksStarted[answeringAccount()] += 1;
        log('walk-start', {
          account: answeringAccount(),
          attempt: walksStarted[answeringAccount()],
        });
      }
    }
    const answers = answersFor(answeringAccount());
    switch (current) {
      case 'welcome': {
        const pendingStashed = Boolean(
          db.kv.get(PENDING_ONBOARDING_PROFILE_KV_KEY),
        );
        const wantsSignIn = scenario.install === 'account' || pendingStashed;
        press(
          wantsSignIn ? 'I already have an account' : 'Start your first read',
        );
        break;
      }
      case 'signin':
        press('Continue with Apple');
        break;
      case 'hydrate-error':
        press('Try again');
        break;
      case 'ob-name': {
        if (!renderer) break;
        const input = nameInput(renderer);
        if (input && input.props.value !== answers.name) {
          act(() => input.props.onChangeText(answers.name));
          actionCount += 1;
          break;
        }
        if (press('Continue')) actionCount += 1;
        break;
      }
      case 'ob-gender':
        selectAndContinue(GENDER_LABEL[answers.gender]!);
        if (press('Continue')) actionCount += 1;
        break;
      case 'ob-level':
        selectAndContinue(LEVEL_LABEL[answers.level] ?? answers.level);
        if (press('Continue')) actionCount += 1;
        break;
      case 'ob-handedness':
        selectAndContinue(HANDEDNESS_LABEL[answers.handedness]!);
        if (press('Continue')) actionCount += 1;
        break;
      case 'ob-goal':
        selectAndContinue(GOAL_LABEL[answers.goal]!);
        if (press('Continue')) actionCount += 1;
        break;
      case 'ob-problem':
        selectAndContinue(PROBLEM_LABEL[answers.problem]!);
        if (press('Continue')) actionCount += 1;
        break;
      case 'ob-reveal':
        if (press('Continue')) actionCount += 1;
        break;
      case 'ob-notifications':
        await tapFinish(answers);
        break;
      case 'app':
      case 'loading':
      case 'unknown':
      case 'crash':
      case 'unmounted':
        break;
    }
    await advance(scenario.humanDelayMs);
  };

  // ── Timeline.
  mount('cold-launch');
  await flush(0);
  try {
    while (!goalReached() && ticks < MAX_TICKS && !errorBoundarySeen) {
      await step();
    }
    const stuckAt = goalReached() ? null : classify(renderer);
    log('walk-done', { ticks, stuckAt });

    // Post-app interruptions: each may sign the account out again, in which
    // case the driver walks the new account in.
    for (const kind of scenario.postEvents) {
      if (errorBoundarySeen) break;
      await advance(500);
      await runEvent(kind, 100);
      await advance(500);
      let more = 0;
      while (!goalReached() && more < MAX_TICKS && !errorBoundarySeen) {
        await step();
        more += 1;
      }
      ticks += more;
    }
  } catch (error) {
    driverErrors.push(error instanceof Error ? error.message : String(error));
  }

  // Let anything in flight land (hung PUTs included).
  if (server.hungCount() > 0)
    log('release-hung-final', { count: server.releaseHung() });
  await advance(3_000);
  const midText = renderedText(renderer);
  const midScreen = classify(renderer);

  // ── Cold relaunch: re-hydrate from Keychain + SQLite only.
  unmount('final-kill');
  resetProcessState();
  server.proc += 1;
  mount('final-relaunch');
  await flush(0);
  await advance(10_000);
  const finalScreen = classify(renderer);
  const finalOwner = getActiveDataOwner();
  const finalAccount = currentAccount();
  const snapshot = () => ({
    app: (() => {
      const s = useAppStore.getState();
      return {
        profile: s.profile,
        ownerKey: s.ownerKey,
        hydrated: s.hydrated,
        hydrateError: s.hydrateError,
        onboardingBusy: s.onboardingBusy,
        onboardingError: s.onboardingError,
      };
    })(),
    notifications: (() => {
      const s = useNotificationStore.getState();
      return { prefs: s.prefs, ownerKey: s.ownerKey, permission: s.permission };
    })(),
    kvProfile: finalAccount
      ? (db.kv.get(profileKeyForOwner(ACCOUNTS[finalAccount].owner)) ?? null)
      : null,
    puts: server.requests.filter(r => r.method === 'PUT').length,
  });
  const snap0 = snapshot();
  const rehydrateRejections: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    await act(async () => {
      await Promise.all([
        useAppStore
          .getState()
          .hydrate()
          .catch((error: unknown) =>
            rehydrateRejections.push(
              error instanceof Error ? error.message : String(error),
            ),
          ),
        useNotificationStore
          .getState()
          .hydrate()
          .catch((error: unknown) =>
            rehydrateRejections.push(
              error instanceof Error ? error.message : String(error),
            ),
          ),
      ]);
    });
    await advance(2_000);
  }
  const snap2 = snapshot();
  const finalScreenAfterRehydrate = classify(renderer);
  const finalBusy = useAppStore.getState().onboardingBusy;

  // Permission revocation bookkeeping.
  if (permissionRevokedAt !== null) {
    const revokedAt = permissionRevokedAt;
    cancelAfterRevoke = scheduler.cancelAll.some(at => at >= revokedAt);
    appliedAfterRevoke = scheduler.applied.filter(
      entry => entry.at >= revokedAt && entry.plan.length > 0,
    ).length;
  }

  // ── Tear down like the end of the process.
  unmount('end');
  for (const unsubscribe of unsubscribers) unsubscribe();
  resetProcessState();
  await flush(0);
  const timersLeft = jest.getTimerCount();
  const listenersLeft = appStateListeners.size;

  // ── Oracle.
  const expectedFinal = signInTarget.current;
  const tapsFor = (key: AccountKey) =>
    finishTaps.filter(tap => tap.account === ACCOUNTS[key].id);
  const expectedAnswers =
    tapsFor(expectedFinal).at(-1)?.answers ?? baseAnswers(expectedFinal);
  const finalOwnerExpected = ACCOUNTS[expectedFinal].owner;
  const kvProfileFinal = parseJson(
    db.kv.get(profileKeyForOwner(finalOwnerExpected)),
  ) as Profile | null;
  const storeProfile = snap2.app.profile;
  const serverProfile = server.profiles.get(ACCOUNTS[expectedFinal].id) ?? null;

  const crossAccountViolations: string[] = [];
  for (const key of ['A', 'B'] as const) {
    const otherKey = key === 'A' ? 'B' : 'A';
    const own = baseAnswers(key);
    const ownCores = [own, ...tapsFor(key).map(tap => tap.answers)].map(a =>
      JSON.stringify(coreOfAnswers(a)),
    );
    const otherCores = [
      baseAnswers(otherKey),
      ...tapsFor(otherKey).map(tap => tap.answers),
    ].map(a => JSON.stringify(coreOfAnswers(a)));
    const kv = parseJson(
      db.kv.get(profileKeyForOwner(ACCOUNTS[key].owner)),
    ) as Profile | null;
    if (kv && kv.firstName !== undefined && kv.firstName !== own.name) {
      crossAccountViolations.push(
        `kv profile:${key} firstName=${kv.firstName}`,
      );
    }
    if (
      kv &&
      !ownCores.includes(JSON.stringify(coreOf(kv))) &&
      otherCores.includes(JSON.stringify(coreOf(kv)))
    ) {
      crossAccountViolations.push(
        `kv profile:${key} holds ${key === 'A' ? 'B' : 'A'} answers`,
      );
    }
    const remote = server.profiles.get(ACCOUNTS[key].id);
    if (remote?.firstName !== undefined && remote.firstName !== own.name) {
      crossAccountViolations.push(
        `server profile ${key} firstName=${remote.firstName}`,
      );
    }
    for (const put of server.putsFor(ACCOUNTS[key].id)) {
      const body = put.body as { firstName?: unknown } | null;
      if (
        body &&
        typeof body.firstName === 'string' &&
        body.firstName !== own.name
      ) {
        crossAccountViolations.push(
          `PUT for ${key} carried firstName=${body.firstName}`,
        );
      }
    }
  }
  for (const first of firstScreenAfterOwnerChange) {
    if (first.leakedName) {
      crossAccountViolations.push(
        `screen for ${first.owner} showed ${first.leakedName}`,
      );
    }
    if (typeof first.nameValue === 'string' && first.nameValue.length > 0) {
      crossAccountViolations.push(
        `name field for ${first.owner} pre-filled ${first.nameValue}`,
      );
    }
  }

  const savedPutsByAccount: Record<string, number> = {};
  const tapsByAccount: Record<string, number> = {};
  for (const put of server.requests) {
    if (
      put.method === 'PUT' &&
      put.outcome.startsWith('saved:') &&
      put.account
    ) {
      savedPutsByAccount[put.account] =
        (savedPutsByAccount[put.account] ?? 0) + 1;
    }
  }
  for (const tap of finishTaps) {
    tapsByAccount[tap.account] = (tapsByAccount[tap.account] ?? 0) + 1;
  }
  const duplicatePut = Object.entries(savedPutsByAccount).some(
    ([account, saved]) => saved > (tapsByAccount[account] ?? 0),
  );

  const prefsRaw = db.kv.get(notificationPrefsKeyForOwner(finalOwnerExpected));
  const prefs = parseJson(prefsRaw) as {
    enabled?: unknown;
    promptDismissed?: unknown;
  } | null;
  const lastFinalTap = [...finishTaps]
    .reverse()
    .find(tap => tap.account === ACCOUNTS[expectedFinal].id);
  const expectedEnabled =
    expectedAnswers.finish === 'enable' &&
    (lastFinalTap?.osWouldGrant ?? scenario.permission === 'granted');
  const notificationTruth =
    prefs !== null &&
    prefs.enabled === expectedEnabled &&
    prefs.promptDismissed === true;

  const pendingProfileRaw = db.kv.get(PENDING_ONBOARDING_PROFILE_KV_KEY) ?? '';
  const pendingNotifRaw =
    db.kv.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY) ?? '';

  const tokenLeak = db
    .kvWrites()
    .some(w =>
      /access-[0-9a-f]{8}-\d+|refresh-[0-9a-f]{8}-\d+|refresh-initial|apple-identity-token/.test(
        w.value,
      ),
    );

  const reachedApp =
    finalScreen === 'app' &&
    finalAccount === expectedFinal &&
    finalOwner === finalOwnerExpected &&
    finalScreenAfterRehydrate === 'app';

  const invariants: Record<string, boolean> = {
    noCrash: !errorBoundarySeen && driverErrors.length === 0,
    reachedApp,
    profileTruthLocal:
      storeProfile !== null &&
      sameJson(coreOf(storeProfile), coreOfAnswers(expectedAnswers)) &&
      storeProfile.firstName === expectedAnswers.name &&
      kvProfileFinal !== null &&
      sameJson(kvProfileFinal, storeProfile),
    profileTruthServer:
      serverProfile !== null &&
      sameJson(coreOf(serverProfile), coreOfAnswers(expectedAnswers)),
    noCrossAccount: crossAccountViolations.length === 0,
    pendingCleared: pendingProfileRaw === '' && pendingNotifRaw === '',
    noDuplicatePut: !duplicatePut,
    notificationTruth,
    permissionRevoke:
      permissionRevokedAt === null ||
      (cancelAfterRevoke && appliedAfterRevoke === 0),
    busyNotStuck: busyStuckMax < 20 && finalBusy === false,
    idempotentRehydrate:
      sameJson(snap0, snap2) && rehydrateRejections.length === 0,
    noLeaks: timersLeft === 0 && listenersLeft === 0,
    noTokenInKv: !tokenLeak,
    ownerAgreement: ownerMismatchAtStoreFinish === 0,
    noUnexpectedRoutes: server.unexpected.length === 0,
    requestsSettled: server.requests.every(
      r => r.outcome !== 'pending' && !r.outcome.startsWith('harness-error'),
    ),
  };
  const failed = Object.entries(invariants)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  return {
    suite: 'stress-onboarding-lifecycle',
    seed: scenario.seed,
    inputs: { ...scenario },
    observed: {
      ticks,
      actionCount,
      firedEvents,
      finishInterruptFired,
      finishTaps,
      midScreen,
      midText: midText.slice(0, 300),
      finalScreen,
      finalScreenAfterRehydrate,
      finalOwner,
      finalAccount,
      storeProfile,
      kvProfileFinal,
      serverProfile,
      serverFirstNameMatches: serverProfile?.firstName === expectedAnswers.name,
      savedPutsByAccount,
      tapsByAccount,
      requests: server.requests.map(r => ({
        at: r.at,
        proc: r.proc,
        method: r.method,
        path: r.path,
        account: r.account ? r.account.slice(0, 8) : null,
        outcome: r.outcome,
        resolvedAt: r.resolvedAt,
      })),
      maxInflight: server.maxInflight,
      prefs,
      pendingProfileRaw: pendingProfileRaw.slice(0, 120),
      pendingNotifRaw,
      scheduler: {
        permission: scheduler.permission,
        requests: scheduler.requests,
        applied: scheduler.applied.map(a => ({
          at: a.at,
          count: a.plan.length,
        })),
        cancelAll: scheduler.cancelAll,
      },
      permissionRevokedAt,
      cancelAfterRevoke,
      appliedAfterRevoke,
      busyStuckMax,
      timersLeft,
      listenersLeft,
      ownerMismatchAtStoreFinish,
      crossAccountViolations,
      firstScreenAfterOwnerChange,
      rehydrateRejections,
      driverErrors,
      unexpectedRoutes: server.unexpected,
      timeline: timeline.slice(0, 400),
    },
    invariants,
    ok: failed.length === 0,
    failed,
    durationMs: wallMs() - startedWall,
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
const rows: StressRow[] = [];

const FIXED_SEEDS = [1, 2, 3, 7, 42, 1337, 2026, 65537];
const iterations = Math.max(
  0,
  Number(nodeProcess.env['STRESS_ITER'] ?? 12) || 0,
);
const seedFilter = nodeProcess.env['STRESS_SEED'];
const seeds: number[] = seedFilter
  ? seedFilter
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n))
  : [
      ...FIXED_SEEDS,
      ...Array.from(
        { length: iterations },
        (_, i) => 0x9e3779b9 ^ ((i + 1) * 0x85ebca6b),
      ).map(n => n >>> 0),
    ];

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
  nativeModules.PickleAuth = {
    signInWithApple: async () => ({
      user: `apple-user-${signInTarget.current}`,
      identityToken: ACCOUNTS[signInTarget.current].identityToken,
      authorizationCode: 'apple-auth-code',
      email: ACCOUNTS[signInTarget.current].email,
    }),
  };
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  delete nativeModules.PickleAuth;
  const rowsFile = writeJsonArtifact('onboarding-lifecycle.rows.json', rows);
  const summaryFile = writeJsonArtifact('onboarding-lifecycle.summary.json', {
    ...summarize(rows),
    seeds,
    replay:
      'cd apps/mobile && STRESS_SEED=<seed> npx jest --ci __tests__/stress/onboardingLifecycle.stress.test.tsx',
    rowsFile,
    summaryFile: undefined,
  });
  void summaryFile;
  jest.useRealTimers();
});

describe('STRESS scr-onboardingscreen — lifecycle interleavings', () => {
  for (const seed of seeds) {
    test(`seed ${seed}`, async () => {
      const row = await runScenario(seededScenario(seed));
      rows.push(row);
      expect({
        seed: row.seed,
        failed: row.failed,
        observed: row.ok ? null : row.observed,
      }).toEqual({
        seed: row.seed,
        failed: [],
        observed: null,
      });
    }, 120_000);
  }
});
