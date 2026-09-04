/**
 * STRESS — scr-onboardingscreen / randomized-seeded.
 *
 * Seeded randomized long-run over the REAL app tree: `<App />` (real Gate,
 * real Zustand auth/app/notification/consistency/walkthrough stores, real
 * `OnboardingScreen`, real Welcome/SignIn screens, real design components).
 * Only the native/persistence edges are replaced: SQLite (`FakeLocalDb`),
 * Keychain, the notification scheduler, safe-area, `fetch` (scripted account
 * server), the heavy RootNavigator/Splash/celebration leaves.
 *
 * Every scenario is generated from its seed by
 * `stress-harness/onboardingScreen/model.ts` (5–60 actions), driven through
 * the public controls (accessibility labels), and after EVERY action the
 * rendered tree + persisted world are compared with the executable model
 * (invariants I1–I10 documented there).
 *
 * Scale: STRESS_ITER=<n> (default 40 so the suite stays cheap in the normal
 * run); STRESS_SEED_BASE=<n> shifts the seed range; STRESS_DETERMINISM_EVERY
 * (default 10) replays every k-th seed a second time and compares traces;
 * STRESS_REPLAY=<seed> runs exactly one seed with a verbose trace.
 *
 * Results: `artifacts/stress/scr-onboardingscreen-randomized-seeded/
 * results-<timestamp>.json` (seed → mode/env/actions/trace/outcome, failures
 * with minimized action lists + 10× re-run rates, determinism table).
 */

import React from 'react';
import { AppState, NativeModules, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import type {
  PermissionState,
  SchedulerPort,
} from '../../../src/notifications/service';
import type { PlannedNotification } from '../../../src/notifications/types';
import type { LocalDb } from '../../../src/data/db';
import { FakeLocalDb } from '../../../xc-harness/lifecycle-persistence/fakeLocalDb';
import { validVault } from '../../../xc-harness/lifecycle-persistence/seeds';
import {
  fs,
  nodeProcess,
  path,
} from '../../../xc-harness/lifecycle-persistence/nodeShim';
import {
  ACCOUNT_OWNER,
  CHOICES,
  MAX_SEQUENCE_LENGTH,
  MIN_SEQUENCE_LENGTH,
  SERVER_FAILURE_MESSAGE,
  SERVER_RECOMMENDED_CHECKPOINT,
  applyAction,
  busy,
  currentStep,
  describeAction,
  generateScenario,
  initialModel,
  stepComplete,
  type Action,
  type ChoiceStep,
  type Env,
  type Model,
  type Mode,
  type Permission,
  type Scenario,
  type ServerMode,
} from '../../../stress-harness/onboardingScreen/model';

declare const __dirname: string;

// ─── Module seams (native + persistence only) ────────────────────────────────

/**
 * SQLite is real I/O on the device: every statement takes a tick, so a fault
 * or environment change lands on the write that is *issued* after it, never
 * retroactively. The fake db resolves in microtasks, so it is wrapped with a
 * 1 ms latency (fault sampled when the statement actually runs).
 */
const DB_LATENCY_MS = 1;
const mockDb = { current: new FakeLocalDb() };
function mockLatencyHandle(db: FakeLocalDb): LocalDb {
  const real = db.handle();
  return {
    close: () => real.close(),
    execute: async (sql, params) => {
      await new Promise<void>(resolve => {
        setTimeout(resolve, DB_LATENCY_MS);
      });
      return real.execute(sql, params);
    },
  };
}
jest.mock('../../../src/data/db', () => ({
  getDb: () => mockLatencyHandle(mockDb.current),
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
    mockKeychain.store.set(options.service ?? 'default', {
      username,
      password,
    });
    return { service: options.service ?? 'default', storage: 'keychain' };
  },
  getGenericPassword: async (options: { service?: string } = {}) => {
    const entry = mockKeychain.store.get(options.service ?? 'default');
    return entry
      ? { ...entry, service: options.service ?? 'default', storage: 'keychain' }
      : false;
  },
  resetGenericPassword: async (options: { service?: string } = {}) => {
    mockKeychain.store.delete(options.service ?? 'default');
    return true;
  },
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: () => {},
    hasPreviousSignIn: () => false,
    signInSilently: async () => ({ type: 'noSavedCredentialFound' }),
    signIn: async () => ({ type: 'cancelled' }),
    signOut: async () => {},
    revokeAccess: async () => {},
  },
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
    appStoreId: '6806918402',
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
  permission: Permission = 'granted';
  requests = 0;
  applied: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  requestPermission(): Promise<PermissionState> {
    this.requests += 1;
    const answer: PermissionState = this.permission;
    return new Promise(resolve => {
      setTimeout(() => resolve(answer), 5);
    });
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
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: RN.View,
    SafeAreaProvider: RN.View,
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

import App from '../../../App';
import { useAuthStore } from '../../../src/auth/authStore';
import { useAppStore } from '../../../src/state/appStore';
import { useNotificationStore } from '../../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../../src/consistency/store';
import { useWalkthroughStore } from '../../../src/walkthrough/walkthroughStore';
import { clearApiSession } from '../../../src/account/apiSession';
import { stopSessionKeeper } from '../../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { BrandDialog } from '../../../src/design/components';
import { SESSION_VAULT_SERVICE } from '../../../src/account/sessionVault';
import { PENDING_ONBOARDING_PROFILE_KV_KEY } from '../../../src/state/appStore';
import { PENDING_NOTIFICATION_ONBOARDING_KV_KEY } from '../../../src/notifications/notificationStore';
import { notificationPrefsKeyForOwner } from '../../../src/notifications/types';
import { profileKeyForOwner } from '../../../src/data/accountScope';

function labelFor(step: ChoiceStep, value: string): string {
  return CHOICES[step].find(c => c.value === value)?.label ?? `?${value}`;
}

// ─── Scripted account server ─────────────────────────────────────────────────

const SERVER_LATENCY_MS = 20;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class ScriptedServer {
  mode: ServerMode = 'ok';
  putCalls: { body: unknown; outcome: string }[] = [];
  logoutCalls = 0;
  refreshCalls = 0;
  meCalls = 0;
  unexpected: string[] = [];
  private counter = 0;

  private delay(signal: AbortSignal | null | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, SERVER_LATENCY_MS);
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
    await this.delay(init.signal);
    const method = (init.method ?? 'GET').toUpperCase();
    if (url === `${API_BASE}/v1/auth/refresh`) {
      this.refreshCalls += 1;
      this.counter += 1;
      return jsonResponse(200, {
        session: {
          accessToken: `access-${this.counter}`,
          refreshToken: `refresh-${this.counter}`,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      });
    }
    if (url === `${API_BASE}/v1/me` && method === 'GET') {
      this.meCalls += 1;
      return jsonResponse(200, { onboardingState: 'pending' });
    }
    if (url === `${API_BASE}/v1/me/onboarding` && method === 'PUT') {
      const body: unknown = JSON.parse(String(init.body ?? 'null'));
      const call = { body, outcome: this.mode };
      this.putCalls.push(call);
      switch (this.mode) {
        case 'error-500':
          return jsonResponse(500, {
            error: { message: SERVER_FAILURE_MESSAGE },
          });
        case 'network':
          throw new TypeError('Network request failed');
        case 'ok':
          return jsonResponse(200, {
            onboardingState: 'complete',
            recommendedCheckpoint: SERVER_RECOMMENDED_CHECKPOINT,
          });
      }
    }
    if (url === `${API_BASE}/v1/auth/logout`) {
      this.logoutCalls += 1;
      return new Response(null, { status: 204 });
    }
    this.unexpected.push(`${method} ${url}`);
    return jsonResponse(404, { error: { message: 'unexpected route' } });
  };
}

// ─── Tree observation ────────────────────────────────────────────────────────

type Renderer = ReturnType<typeof TestRenderer.create>;
type Instance = Renderer['root'];

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string | number => typeof c !== 'object')
    .join('');
}

function isAncestor(node: Instance, candidate: Instance): boolean {
  let cursor: Instance | null = candidate.parent;
  while (cursor) {
    if (cursor === node) return true;
    cursor = cursor.parent;
  }
  return false;
}

/** Leaf-most nodes carrying the label with a press handler (the host
 * Pressable behind PressableScale / Button). */
function pressables(renderer: Renderer, label: string): Instance[] {
  const matches = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
  return matches.filter(
    node => !matches.some(other => other !== node && isAncestor(node, other)),
  );
}

interface ControlState {
  present: boolean;
  disabled: boolean;
}

function control(renderer: Renderer, label: string): ControlState {
  const nodes = pressables(renderer, label);
  if (nodes.length === 0) return { present: false, disabled: false };
  if (nodes.length > 1) {
    throw new Error(`ambiguous control "${label}" (${nodes.length} matches)`);
  }
  return { present: true, disabled: Boolean(nodes[0]!.props.disabled) };
}

function dialogVisible(renderer: Renderer): boolean {
  return renderer.root
    .findAllByType(BrandDialog)
    .some(dialog => dialog.props.visible === true);
}

/** Taps like RN would: a disabled Pressable swallows the press, and while
 * the leave dialog (an RN Modal) is up nothing behind it receives touches
 * or keyboard events. Returns whether the handler ran. */
function tap(
  renderer: Renderer,
  label: string,
): 'pressed' | 'disabled' | 'absent' | 'blocked' {
  if (dialogVisible(renderer)) return 'blocked';
  const state = control(renderer, label);
  if (!state.present) return 'absent';
  if (state.disabled) return 'disabled';
  act(() => {
    pressables(renderer, label)[0]!.props.onPress();
  });
  return 'pressed';
}

interface WorldObservation {
  putCalls: number;
  permissionRequests: number;
  logoutCalls: number;
  pendingProfileKv: unknown;
  pendingNotificationKv: unknown;
  accountProfileKv: unknown;
  accountPrefsKv: unknown;
  onboardingBusy: boolean;
  storeError: string | null;
}

interface Observation {
  screen: 'onboarding' | 'welcome' | 'signin' | 'root' | 'loading' | 'unknown';
  step: number | null;
  progressMax: number | null;
  header: 'Back' | 'Leave setup' | 'both' | 'none';
  continue: 'absent' | 'enabled' | 'disabled';
  nameValue: string | null;
  selected: string[];
  dialogVisible: boolean;
  finishLabel: 'Turn on reminders' | 'Finishing setup…' | 'absent';
  finishDisabled: boolean;
  notNow: 'absent' | 'enabled' | 'disabled';
  errorRendered: boolean;
  skipCopy: boolean;
  /** Only compared when the model has no async work in flight. */
  world: WorldObservation | null;
}

function parseKv(db: FakeLocalDb, key: string): unknown {
  const raw = db.kv.get(key);
  if (raw === undefined || raw === '') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return `UNPARSEABLE:${raw}`;
  }
}

function observeWorld(
  db: FakeLocalDb,
  server: ScriptedServer,
): WorldObservation {
  const prefsRaw = parseKv(db, notificationPrefsKeyForOwner(ACCOUNT_OWNER));
  const prefs =
    prefsRaw && typeof prefsRaw === 'object'
      ? {
          enabled: (prefsRaw as { enabled?: unknown }).enabled,
          promptDismissed: (prefsRaw as { promptDismissed?: unknown })
            .promptDismissed,
        }
      : prefsRaw;
  const pendingProfile = parseKv(db, PENDING_ONBOARDING_PROFILE_KV_KEY) as {
    version?: unknown;
    profile?: unknown;
  } | null;
  return {
    putCalls: server.putCalls.length,
    permissionRequests: mockScheduler.current.requests,
    logoutCalls: server.logoutCalls,
    pendingProfileKv:
      pendingProfile && pendingProfile.version === 1
        ? (pendingProfile.profile ?? null)
        : pendingProfile,
    pendingNotificationKv: parseKv(db, PENDING_NOTIFICATION_ONBOARDING_KV_KEY),
    accountProfileKv: parseKv(db, profileKeyForOwner(ACCOUNT_OWNER)),
    accountPrefsKv: prefs,
    onboardingBusy: useAppStore.getState().onboardingBusy,
    storeError: useAppStore.getState().onboardingError,
  };
}

function observe(
  renderer: Renderer,
  db: FakeLocalDb,
  server: ScriptedServer,
  includeWorld: boolean,
): Observation {
  const text = allText(renderer);
  const progress = renderer.root.findAll(
    node => node.props?.accessibilityRole === 'progressbar',
  );
  let screen: Observation['screen'] = 'unknown';
  if (progress.length > 0) screen = 'onboarding';
  else if (control(renderer, 'Start your first read').present)
    screen = 'welcome';
  else if (control(renderer, 'Continue with Apple').present) screen = 'signin';
  else if (text.includes('ROOT_NAVIGATOR')) screen = 'root';
  else if (/Getting things ready|Loading your account/.test(text)) {
    screen = 'loading';
  }

  const back = control(renderer, 'Back');
  const leave = control(renderer, 'Leave setup');
  const cont = control(renderer, 'Continue');
  const finish = control(renderer, 'Turn on reminders');
  const finishing = control(renderer, 'Finishing setup…');
  const notNow = control(renderer, 'Not now');
  const inputs = renderer.root.findAllByType(TextInput);
  const nameInput = inputs.find(
    node => node.props.accessibilityLabel === 'First name',
  );
  const selected = renderer.root
    .findAll(
      node =>
        node.props?.accessibilityState?.selected === true &&
        typeof node.props?.onPress === 'function',
    )
    .map(node => String(node.props.accessibilityLabel));
  const dialogs = renderer.root.findAllByType(BrandDialog);
  const storeError = useAppStore.getState().onboardingError;
  return {
    screen,
    step:
      screen === 'onboarding'
        ? Number(progress[0]!.props.accessibilityValue?.now)
        : null,
    progressMax:
      screen === 'onboarding'
        ? Number(progress[0]!.props.accessibilityValue?.max)
        : null,
    header:
      back.present && leave.present
        ? 'both'
        : back.present
          ? 'Back'
          : leave.present
            ? 'Leave setup'
            : 'none',
    continue: cont.present
      ? cont.disabled
        ? 'disabled'
        : 'enabled'
      : 'absent',
    nameValue: nameInput ? String(nameInput.props.value) : null,
    selected: Array.from(new Set(selected)).sort(),
    dialogVisible: dialogs.some(dialog => dialog.props.visible === true),
    finishLabel: finishing.present
      ? 'Finishing setup…'
      : finish.present
        ? 'Turn on reminders'
        : 'absent',
    finishDisabled: finishing.present
      ? finishing.disabled
      : finish.present
        ? finish.disabled
        : false,
    notNow: notNow.present
      ? notNow.disabled
        ? 'disabled'
        : 'enabled'
      : 'absent',
    errorRendered: storeError !== null && text.includes(storeError),
    skipCopy: /skip/i.test(text) || /guest/i.test(text),
    world: includeWorld ? observeWorld(db, server) : null,
  };
}

// ─── Expected observation from the model ─────────────────────────────────────

function expected(model: Model, includeWorld: boolean): Observation {
  const onboarding = model.screen === 'onboarding';
  const step = onboarding ? currentStep(model) : null;
  const finishing = onboarding && step === 'notifications';
  const isBusy = busy(model);
  const screen: Observation['screen'] =
    model.signOutPending && model.screen === 'welcome'
      ? 'loading'
      : model.screen;
  return {
    screen,
    step: onboarding ? model.stepIndex + 1 : null,
    progressMax: onboarding ? 8 : null,
    header: onboarding
      ? model.stepIndex > 0 || model.mode === 'preauth'
        ? 'Back'
        : 'Leave setup'
      : model.screen === 'signin'
        ? 'Back'
        : 'none',
    continue:
      onboarding && step !== 'notifications'
        ? stepComplete(model)
          ? 'enabled'
          : 'disabled'
        : 'absent',
    nameValue: onboarding && step === 'name' ? model.name : null,
    selected:
      onboarding &&
      step !== null &&
      step !== 'name' &&
      step !== 'reveal' &&
      step !== 'notifications' &&
      model.answers[step] !== undefined
        ? [labelFor(step, model.answers[step]!)]
        : [],
    dialogVisible: onboarding && model.dialogOpen,
    finishLabel: finishing
      ? isBusy
        ? 'Finishing setup…'
        : 'Turn on reminders'
      : 'absent',
    finishDisabled: finishing ? isBusy : false,
    notNow: finishing ? (isBusy ? 'disabled' : 'enabled') : 'absent',
    errorRendered: finishing && model.storeError !== null,
    skipCopy: false,
    world: includeWorld
      ? {
          putCalls: model.putCalls,
          permissionRequests: model.permissionRequests,
          logoutCalls: model.logoutCalls,
          pendingProfileKv: model.pendingProfileKv,
          pendingNotificationKv: model.pendingNotificationKv,
          accountProfileKv: model.accountProfileKv,
          accountPrefsKv: model.accountPrefsKv,
          onboardingBusy: false,
          storeError: model.storeError,
        }
      : null,
  };
}

// ─── Driver ──────────────────────────────────────────────────────────────────

const VAULT_SERVICE = SESSION_VAULT_SERVICE;
const appStateListeners = new Set<(state: string) => void>();

function resetProcessState(): void {
  // Spies keep every call (Math.random runs thousands of times per seed).
  jest.clearAllMocks();
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

const FAULT_KEYS = [
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  profileKeyForOwner(ACCOUNT_OWNER),
  notificationPrefsKeyForOwner(ACCOUNT_OWNER),
];

function applyEnv(db: FakeLocalDb, server: ScriptedServer, env: Env): void {
  db.faults = env.dbWriteFails ? { kvSetThrows: new Set(FAULT_KEYS) } : {};
  server.mode = env.server;
  mockScheduler.current.permission = env.permission;
}

interface Mismatch {
  key: string;
  expected: unknown;
  observed: unknown;
}

function diff(exp: Observation, obs: Observation): Mismatch[] {
  const out: Mismatch[] = [];
  const keys = Object.keys(exp) as (keyof Observation)[];
  for (const key of keys) {
    if (key === 'world') continue;
    const a = JSON.stringify(exp[key]);
    const b = JSON.stringify(obs[key]);
    if (a !== b) out.push({ key, expected: exp[key], observed: obs[key] });
  }
  if (exp.world && obs.world) {
    for (const key of Object.keys(exp.world) as (keyof WorldObservation)[]) {
      const a = JSON.stringify(exp.world[key] ?? null);
      const b = JSON.stringify(obs.world[key] ?? null);
      if (a !== b) {
        out.push({
          key: `world.${key}`,
          expected: exp.world[key] ?? null,
          observed: obs.world[key] ?? null,
        });
      }
    }
  }
  return out;
}

function compact(obs: Observation): string {
  const parts = [
    obs.screen,
    obs.step === null ? '-' : `s${obs.step}`,
    `h:${obs.header}`,
    `c:${obs.continue}`,
    obs.nameValue === null ? 'n:-' : `n:${JSON.stringify(obs.nameValue)}`,
    `sel:${obs.selected.join('|') || '-'}`,
    obs.dialogVisible ? 'dlg' : '',
    obs.finishLabel === 'absent'
      ? ''
      : `fin:${obs.finishLabel === 'Finishing setup…' ? 'busy' : 'ready'}${
          obs.finishDisabled ? '!' : ''
        }/${obs.notNow}`,
    obs.errorRendered ? 'err' : '',
    obs.world
      ? `w:put=${obs.world.putCalls},perm=${obs.world.permissionRequests},out=${obs.world.logoutCalls},pp=${
          obs.world.pendingProfileKv ? 1 : 0
        },pn=${JSON.stringify(obs.world.pendingNotificationKv)},ap=${
          obs.world.accountProfileKv ? 1 : 0
        },apr=${JSON.stringify(obs.world.accountPrefsKv)},busy=${
          obs.world.onboardingBusy ? 1 : 0
        },err=${obs.world.storeError === null ? 0 : 1}`
      : '',
  ];
  return parts.filter(Boolean).join(' ');
}

interface StepRecord {
  i: number;
  action: string;
  tap?: string;
  observed: string;
}

interface Failure {
  step: number;
  action: string;
  mismatches: Mismatch[];
  expected: Observation;
  observed: Observation;
}

interface RunResult {
  seed: number;
  mode: Mode;
  env: Env;
  length: number;
  actions: string[];
  trace: StepRecord[];
  outcome: 'HELD' | 'BROKEN' | 'HARNESS_ERROR';
  failure: Failure | null;
  error: string | null;
  unexpectedRoutes: string[];
  durationMs: number;
}

/**
 * Mounts the real App for the scenario's mode and drives the actions.
 * `actions` overrides the generated sequence (used by the minimizer).
 */
async function runScenario(
  scenario: Scenario,
  actions: Action[] = scenario.actions,
): Promise<RunResult> {
  const started = realNow();
  jest.setSystemTime(new Date('2026-03-01T09:00:00.000Z'));
  const db = new FakeLocalDb();
  mockDb.current = db;
  mockKeychain.store.clear();
  const server = new ScriptedServer();
  (globalThis as { fetch: unknown }).fetch = server.fetch;
  mockScheduler.current = new FakeScheduler();
  applyEnv(db, server, scenario.env);
  resetProcessState();

  if (scenario.mode === 'account') {
    mockKeychain.store.set(VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify(validVault({ refreshToken: 'refresh-seeded' })),
    });
    db.kv.set('walkthrough.device-complete', JSON.stringify({ version: 1 }));
  }

  const model = initialModel(scenario.mode, scenario.env);
  const trace: StepRecord[] = [];
  let renderer: Renderer | null = null;
  let failure: Failure | null = null;
  let error: string | null = null;

  const check = (i: number, action: string, tapResult?: string): boolean => {
    const includeWorld = model.pending.length === 0 && !model.signOutPending;
    const obs = observe(renderer!, db, server, includeWorld);
    const exp = expected(model, includeWorld);
    trace.push({
      i,
      action,
      ...(tapResult ? { tap: tapResult } : {}),
      observed: compact(obs),
    });
    const mismatches = diff(exp, obs);
    if (mismatches.length > 0) {
      failure = { step: i, action, mismatches, expected: exp, observed: obs };
      return false;
    }
    return true;
  };

  try {
    act(() => {
      renderer = TestRenderer.create(<App />);
    });
    // Launch: auth hydrate (+ refresh round-trip in account mode), app
    // hydrate, splash hand-off.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await flush(100);
      const screen = observe(renderer!, db, server, false).screen;
      if (scenario.mode === 'account' && screen === 'onboarding') break;
      if (scenario.mode === 'preauth' && screen === 'welcome') break;
    }
    if (scenario.mode === 'preauth') {
      const result = tap(renderer!, 'Start your first read');
      if (result !== 'pressed') {
        throw new Error(`launch: Welcome not reachable (${result})`);
      }
    }
    if (!check(-1, 'launch')) {
      throw new Error('launch state does not match the model');
    }

    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i]!;
      let tapResult: string | undefined;
      switch (action.kind) {
        case 'typeName': {
          const inputs = renderer!.root
            .findAllByType(TextInput)
            .filter(node => node.props.accessibilityLabel === 'First name');
          if (dialogVisible(renderer!)) {
            tapResult = 'blocked';
          } else if (inputs.length === 1) {
            act(() => inputs[0]!.props.onChangeText(action.text));
            tapResult = 'typed';
          } else {
            tapResult = 'absent';
          }
          break;
        }
        case 'submitName': {
          const inputs = renderer!.root
            .findAllByType(TextInput)
            .filter(node => node.props.accessibilityLabel === 'First name');
          if (dialogVisible(renderer!)) {
            tapResult = 'blocked';
          } else if (inputs.length === 1) {
            act(() => inputs[0]!.props.onSubmitEditing());
            tapResult = 'submitted';
          } else {
            tapResult = 'absent';
          }
          break;
        }
        case 'pressChoice':
          tapResult = tap(renderer!, action.label);
          break;
        case 'pressContinue':
          tapResult = tap(renderer!, 'Continue');
          break;
        case 'pressBack': {
          const back = tap(renderer!, 'Back');
          tapResult =
            back === 'absent' ? `leave:${tap(renderer!, 'Leave setup')}` : back;
          break;
        }
        case 'pressDialog': {
          const dialogs = renderer!.root
            .findAllByType(BrandDialog)
            .filter(dialog => dialog.props.visible === true);
          const button = dialogs[0]?.props.actions.find(
            (a: { label: string }) => a.label === action.label,
          );
          if (button?.onPress) {
            act(() => button.onPress?.());
            tapResult = 'pressed';
          } else {
            tapResult = 'absent';
          }
          break;
        }
        case 'pressFinish': {
          const label =
            action.choice === 'enable' ? 'Turn on reminders' : 'Not now';
          const first = tap(renderer!, label);
          if (action.taps === 2) {
            let second = tap(renderer!, label);
            if (second === 'absent')
              second = tap(renderer!, 'Finishing setup…');
            tapResult = `${first},${second}`;
          } else {
            tapResult = first;
          }
          break;
        }
        case 'pressGetStarted':
          tapResult = tap(renderer!, 'Start your first read');
          break;
        case 'settle':
          await flush(300);
          await flush(300);
          break;
        case 'setDbWrite':
        case 'setServer':
        case 'setPermission':
          break;
      }
      applyAction(model, action);
      if (
        action.kind === 'setDbWrite' ||
        action.kind === 'setServer' ||
        action.kind === 'setPermission'
      ) {
        applyEnv(db, server, model.env);
      }
      if (!check(i, describeAction(action), tapResult)) break;
    }
  } catch (caught) {
    error = caught instanceof Error ? `${caught.message}` : String(caught);
  } finally {
    if (renderer) {
      const r = renderer;
      act(() => r.unmount());
    }
    // Drain anything still scheduled so it cannot leak into the next seed.
    await flush(1000);
    resetProcessState();
  }

  const outcome: RunResult['outcome'] = error
    ? 'HARNESS_ERROR'
    : failure
      ? 'BROKEN'
      : 'HELD';
  return {
    seed: scenario.seed,
    mode: scenario.mode,
    env: scenario.env,
    length: actions.length,
    actions: actions.map(describeAction),
    trace,
    outcome,
    failure,
    error,
    unexpectedRoutes: server.unexpected,
    durationMs: realNow() - started,
  };
}

// ─── Minimizer ───────────────────────────────────────────────────────────────

function failureKey(result: RunResult): string | null {
  if (result.outcome === 'HARNESS_ERROR') return `error:${result.error}`;
  if (!result.failure) return null;
  return result.failure.mismatches
    .map(m => m.key)
    .sort()
    .join(',');
}

async function minimize(
  scenario: Scenario,
  original: RunResult,
): Promise<{ actions: Action[]; replays: number }> {
  const key = failureKey(original);
  let current = scenario.actions.slice(
    0,
    original.failure ? original.failure.step + 1 : scenario.actions.length,
  );
  let replays = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const candidate = current.filter((_, index) => index !== i);
      replays += 1;
      const result = await runScenario(scenario, candidate);
      if (failureKey(result) === key) {
        current = candidate;
        changed = true;
      }
    }
  }
  return { actions: current, replays };
}

// ─── Artifact ────────────────────────────────────────────────────────────────

function artifactPath(name: string): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(
          __dirname,
          '../../../../../artifacts/stress/scr-onboardingscreen-randomized-seeded',
        );
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function envInt(name: string, fallback: number): number {
  const raw = nodeProcess.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;
/** Wall clock captured before fake timers take over `Date`. */
const realNow: () => number = Date.now.bind(Date);

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
  jest.restoreAllMocks();
});

const ITERATIONS = envInt('STRESS_ITER', 40);
const SEED_BASE = envInt('STRESS_SEED_BASE', 1);
const DETERMINISM_EVERY = envInt('STRESS_DETERMINISM_EVERY', 10);
const REPLAY_SEED = nodeProcess.env['STRESS_REPLAY'];
const FLAKE_RERUNS = 10;
const HEAP_SAMPLE_EVERY = 50;

describe('OnboardingScreen — seeded randomized long-run (real App tree)', () => {
  it('generator: 5–60 actions per seed, deterministic per seed', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const a = generateScenario(seed);
      const b = generateScenario(seed);
      expect(a.actions.length).toBeGreaterThanOrEqual(MIN_SEQUENCE_LENGTH);
      expect(a.actions.length).toBeLessThanOrEqual(MAX_SEQUENCE_LENGTH);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it(
    `campaign: ${REPLAY_SEED ? `replay seed ${REPLAY_SEED}` : `${ITERATIONS} seeds from ${SEED_BASE}`} — invariants I1–I10 hold after every action`,
    async () => {
      const seeds = REPLAY_SEED
        ? [Number(REPLAY_SEED)]
        : Array.from({ length: ITERATIONS }, (_, i) => SEED_BASE + i);
      const rows: RunResult[] = [];
      const determinism: {
        seed: number;
        identical: boolean;
        firstDivergence: number | null;
      }[] = [];
      const failures: {
        seed: number;
        key: string | null;
        minimizedActions: string[];
        minimizeReplays: number;
        rerunFailures: number;
        rerunTotal: number;
        original: RunResult;
        minimized: RunResult;
      }[] = [];
      /** Process health every HEAP_SAMPLE_EVERY seeds: a long run must not grow without bound. */
      const heapSamples: {
        afterSeeds: number;
        heapUsedMb: number;
        fakeTimers: number;
        appStateListeners: number;
      }[] = [];
      const sampleHeap = (afterSeeds: number) => {
        // Retained size, not garbage: `node --expose-gc` makes this exact.
        (globalThis as { gc?: () => void }).gc?.();
        heapSamples.push({
          afterSeeds,
          heapUsedMb: Math.round(nodeProcess.memoryUsage().heapUsed / 1048576),
          fakeTimers: jest.getTimerCount(),
          appStateListeners: appStateListeners.size,
        });
      };

      sampleHeap(0);
      for (const seed of seeds) {
        const scenario = generateScenario(seed);
        const result = await runScenario(scenario);
        rows.push(result);
        if (rows.length % HEAP_SAMPLE_EVERY === 0) sampleHeap(rows.length);
        const wantsDeterminism =
          result.outcome !== 'HELD' ||
          (DETERMINISM_EVERY > 0 &&
            (seed - SEED_BASE) % DETERMINISM_EVERY === 0);
        if (wantsDeterminism) {
          const again = await runScenario(scenario);
          const a = result.trace.map(step => step.observed);
          const b = again.trace.map(step => step.observed);
          let firstDivergence: number | null = null;
          for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
            if (a[i] !== b[i]) {
              firstDivergence = i;
              break;
            }
          }
          determinism.push({
            seed,
            identical:
              firstDivergence === null && result.outcome === again.outcome,
            firstDivergence,
          });
        }
        if (result.outcome !== 'HELD') {
          const { actions, replays } = await minimize(scenario, result);
          const minimized = await runScenario(scenario, actions);
          let rerunFailures = 0;
          for (let n = 0; n < FLAKE_RERUNS; n += 1) {
            const rerun = await runScenario(scenario, actions);
            if (rerun.outcome !== 'HELD') rerunFailures += 1;
          }
          failures.push({
            seed,
            key: failureKey(result),
            minimizedActions: actions.map(describeAction),
            minimizeReplays: replays,
            rerunFailures,
            rerunTotal: FLAKE_RERUNS,
            original: result,
            minimized,
          });
        }
      }

      const held = rows.filter(r => r.outcome === 'HELD').length;
      const broken = rows.filter(r => r.outcome === 'BROKEN').length;
      const harnessErrors = rows.filter(
        r => r.outcome === 'HARNESS_ERROR',
      ).length;
      const lengths = rows.map(r => r.length);
      const actionsExecuted = rows.reduce(
        (sum, r) => sum + r.trace.filter(step => step.i >= 0).length,
        0,
      );
      const summary = {
        unit: 'scr-onboardingscreen',
        lens: 'randomized-seeded',
        commit: nodeProcess.env['STRESS_COMMIT'] ?? null,
        node: nodeProcess.version,
        iterations: rows.length,
        seedRange: [seeds[0], seeds[seeds.length - 1]],
        actionsExecuted,
        lengthMin: Math.min(...lengths),
        lengthMax: Math.max(...lengths),
        modes: {
          account: rows.filter(r => r.mode === 'account').length,
          preauth: rows.filter(r => r.mode === 'preauth').length,
        },
        held,
        broken,
        harnessErrors,
        determinismChecked: determinism.length,
        determinismMismatches: determinism.filter(d => !d.identical).length,
        unexpectedRoutes: Array.from(
          new Set(rows.flatMap(r => r.unexpectedRoutes)),
        ),
        durationMs: rows.reduce((sum, r) => sum + r.durationMs, 0),
        failureSeeds: failures.map(f => f.seed),
        heapSamples,
      };
      const stamp = new Date(realNow()).toISOString().replace(/[:.]/g, '-');
      const file = artifactPath(`results-${stamp}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({ summary, determinism, failures, rows }, null, 2) +
          '\n',
      );
      console.log(
        `[stress scr-onboardingscreen] ${JSON.stringify(summary)} → ${file}`,
      );
      if (REPLAY_SEED) {
        console.log(JSON.stringify(rows[0], null, 2));
      }

      expect(summary.unexpectedRoutes).toEqual([]);
      expect(summary.determinismMismatches).toBe(0);
      expect(harnessErrors).toBe(0);
      expect(
        failures.map(f => ({
          seed: f.seed,
          key: f.key,
          minimized: f.minimizedActions,
          mismatches: f.minimized.failure?.mismatches ?? f.minimized.error,
          rate: `${f.rerunFailures}/${f.rerunTotal}`,
        })),
      ).toEqual([]);
    },
    // Generous: the full STRESS_ITER campaign runs thousands of App mounts.
    24 * 60 * 60 * 1000,
  );
});
