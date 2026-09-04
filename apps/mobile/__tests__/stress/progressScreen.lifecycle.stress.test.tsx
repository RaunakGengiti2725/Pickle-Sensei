/**
 * STRESS — ProgressScreen × lifecycle interruption.
 *
 * Renders the REAL `<App />` (RootErrorBoundary → SafeAreaProvider →
 * NavigationContainer → RootNavigator → bottom tabs → ProgressScreen) with
 * only native modules and `fetch` replaced, signs a scripted account in
 * through the auth store's own `signInWithApple`, presses the real Progress
 * tab, and then replays a SEEDED schedule of interruptions against it:
 *
 *   background/foreground · tab away/back (blur/focus) · kill + relaunch
 *   (every in-memory singleton dropped, Keychain + SQLite kept) · account
 *   switch · server-side revocation · bearer rotation mid-request · SQLite
 *   fault + retry · new data landing mid-request · API 500 / network loss
 *
 * with independently seeded latencies for the local reads and the canonical
 * `/v1/progress` fetch so responses land before, during and after every
 * interruption.
 *
 * Invariants (each is a key of `Verdicts`):
 *   noCrash             RootErrorBoundary never rendered; no unhandled rejection
 *   ownerIsolation      the rendered owner marker + reps count only ever came
 *                       from a read issued FOR the signed-in account
 *   noStaleValue        the reps count on screen always equals a snapshot a
 *                       successfully settled local read for that owner returned
 *   converges           after the last step settles the screen shows the
 *                       current owner's live SQLite count (or, signed out, no
 *                       account data at all)
 *   idempotentRehydrate every relaunch reaches the same signed-in owner and
 *                       the same Progress values as the previous run held
 *   noLeakedTimers      after unmount + singleton stop, zero timers remain
 *   noLeakedListeners   after unmount + singleton stop, zero AppState listeners
 *   noSignedOutFetch    no account-scoped request left with a bearer after the
 *                       account it belonged to signed out
 *
 * Replay one iteration:   STRESS_SEED=<seed> npx jest --ci progressScreen.lifecycle
 * Minimise a schedule:    STRESS_SEED=<seed> STRESS_STEPS="rotate-token+77,kill-relaunch+50"
 * Campaign size:          STRESS_ITER=<n>   (default 12 — fast enough for CI)
 * Artifacts:              artifacts/stress-progress-lifecycle/*.json
 */
import React from 'react';
import { AppState, NativeModules } from 'react-native';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { StressLocalDb } from '../../stress-harness/progress-lifecycle/localDb';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  ScriptedBackend,
  type StressAccount,
} from '../../stress-harness/progress-lifecycle/backend';
import {
  buildSchedule,
  parseSteps,
  type Schedule,
  type Step,
} from '../../stress-harness/progress-lifecycle/schedule';
import {
  writeJsonArtifact,
  writeTextArtifact,
} from '../../stress-harness/progress-lifecycle/artifacts';
import { nodeProcess } from '../../xc-harness/lifecycle-persistence/nodeShim';

// ─── Module seams (native modules + fetch only) ──────────────────────────────

const mockDb = { current: new StressLocalDb() };
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
    return item
      ? { service: options.service, storage: 'mock', ...item }
      : false;
  },
  resetGenericPassword: async (options: { service?: string } = {}) =>
    mockKeychain.delete(options.service ?? '__default__'),
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
    apiBaseUrl: 'https://api.stress.test',
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
// Notification permission is native; the scheduler port is the seam the app
// itself defines for it. `mockPermission` is flipped by the schedule to model
// a permission revoked in Settings after the fact.
const mockPermission = { current: 'granted' as 'granted' | 'denied' };
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => ({
    permissionState: async () => mockPermission.current,
    requestPermission: async () => mockPermission.current,
    applyPlan: async () => {},
    cancelAllPlanned: async () => {},
    openSystemSettings: async () => {},
  }),
  screenTargetFromNotificationData: () => null,
  subscribeToNotificationPresses: () => () => {},
  registerBackgroundNotificationHandler: () => {},
}));
jest.mock('react-native-safe-area-context', () => {
  const mock = jest.requireActual<{ default: Record<string, unknown> }>(
    'react-native-safe-area-context/jest/mock',
  );
  return mock.default;
});
jest.mock('react-native-reanimated', () => {
  const { makeReanimatedMock } = jest.requireActual<
    typeof import('../../stress-harness/progress-lifecycle/reanimatedMock')
  >('../../stress-harness/progress-lifecycle/reanimatedMock');
  return makeReanimatedMock(
    jest.requireActual('react'),
    jest.requireActual('react-native'),
  );
});
jest.mock('react-native-linear-gradient', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    __esModule: true,
    default: (props: { children?: React.ReactNode }) =>
      R.createElement(View, null, props.children),
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
    Ellipse: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Polygon: Mock,
    Rect: Mock,
    G: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    RadialGradient: Mock,
    Stop: Mock,
    Text: Mock,
    ClipPath: Mock,
    Mask: Mock,
  };
});
jest.mock('react-native-webview', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: View, WebView: View };
});
jest.mock('react-native-video', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: View };
});

import App from '../../App';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import { useRankCelebrationStore } from '../../src/progress/rankCelebration';
import { clearAccessStoreConfiguration } from '../../src/state/accessStore';
import { clearApiSession } from '../../src/account/apiSession';
import {
  refreshSessionNow,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

// ─── Observability: timers, AppState listeners, unhandled rejections ────────

const timerSites = new Map<number, string>();
const appStateListeners = new Set<(state: string) => void>();
const unhandledRejections: string[] = [];

function siteOf(stack: string | undefined): string {
  const lines = (stack ?? '').split('\n').slice(2);
  const own = lines.find(
    line =>
      /\/src\/|\/App\.tsx/.test(line) &&
      !/node_modules|stress-harness/.test(line),
  );
  return (own ?? lines[0] ?? '<unknown>').trim();
}

function trackTimers(): () => void {
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearTimeout = globalThis.clearTimeout;
  const realClearInterval = globalThis.clearInterval;
  const wrapSet =
    (real: typeof setTimeout, kind: string) =>
    (
      handler: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const site = `${kind}(${ms ?? 0}ms) @ ${siteOf(new Error().stack)}`;
      const id = real(
        (...inner: unknown[]) => {
          if (kind === 'setTimeout') timerSites.delete(Number(id));
          handler(...inner);
        },
        ms,
        ...args,
      );
      timerSites.set(Number(id), site);
      return id;
    };
  const wrapClear =
    (real: typeof clearTimeout) => (id: Parameters<typeof clearTimeout>[0]) => {
      if (id !== undefined && id !== null) timerSites.delete(Number(id));
      return real(id);
    };
  globalThis.setTimeout = wrapSet(
    realSetTimeout,
    'setTimeout',
  ) as typeof setTimeout;
  globalThis.setInterval = wrapSet(
    realSetInterval as unknown as typeof setTimeout,
    'setInterval',
  ) as unknown as typeof setInterval;
  globalThis.clearTimeout = wrapClear(realClearTimeout) as typeof clearTimeout;
  globalThis.clearInterval = wrapClear(
    realClearInterval,
  ) as typeof clearInterval;
  return () => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
    globalThis.clearTimeout = realClearTimeout;
    globalThis.clearInterval = realClearInterval;
  };
}

function emitAppState(state: 'active' | 'background' | 'inactive'): void {
  for (const listener of [...appStateListeners]) listener(state);
}

// ─── Rendered-tree probes ────────────────────────────────────────────────────

function texts(renderer: ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return out;
}

function findAllSafe(
  renderer: ReactTestRenderer,
  predicate: (node: ReactTestInstance) => boolean,
): ReactTestInstance[] {
  try {
    return renderer.root.findAll(predicate);
  } catch {
    return [];
  }
}

function tabButton(
  renderer: ReactTestRenderer,
  label: string,
): ReactTestInstance | null {
  const matches = findAllSafe(
    renderer,
    node =>
      node.props.accessibilityRole === 'tab' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  return matches[0] ?? null;
}

function tabSelected(button: ReactTestInstance): boolean {
  const state: unknown = button.props.accessibilityState;
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as { selected?: unknown }).selected === true
  );
}

function statValue(renderer: ReactTestRenderer, testID: string): string | null {
  const rows = findAllSafe(renderer, node => node.props.testID === testID);
  const row = rows[0];
  if (!row) return null;
  const children = row.findAll(node => (node.type as unknown) === 'Text');
  // StatDeltaRow renders label, value, previous, delta — the value is the
  // first Text after the label.
  const strings = children
    .map(node => node.props.children)
    .flat()
    .filter(
      (c): c is string | number =>
        typeof c === 'string' || typeof c === 'number',
    )
    .map(String);
  return strings[1] ?? null;
}

interface ScreenReading {
  /** which screen the tree is showing right now */
  surface:
    | 'progress'
    | 'progress-loading'
    | 'progress-error'
    | 'other-tab'
    | 'signed-out'
    | 'crashed'
    | 'unmounted';
  reps: number | null;
  markers: Array<'a' | 'b'>;
}

function readScreen(renderer: ReactTestRenderer | null): ScreenReading {
  if (!renderer) return { surface: 'unmounted', reps: null, markers: [] };
  const all = texts(renderer);
  const joined = all.join(' | ');
  const markers: Array<'a' | 'b'> = [];
  if (all.includes('signal owner a')) markers.push('a');
  if (all.includes('signal owner b')) markers.push('b');
  if (joined.includes('Something went wrong')) {
    return { surface: 'crashed', reps: null, markers };
  }
  const progressTab = tabButton(renderer, 'Progress');
  if (!progressTab) {
    return { surface: 'signed-out', reps: null, markers };
  }
  // Bottom tabs keep blurred screens mounted, so the Progress subtree (and
  // whatever it last showed) stays in the tree while another tab is focused.
  // Its content is still read — a previous owner's values sitting in a
  // background tab are exactly the leak the owner checks are after — but the
  // surface reports the FOCUSED tab.
  const repsText = statValue(renderer, 'technique-stat-reps');
  const reps = repsText === null ? null : Number(repsText);
  const finiteReps = reps !== null && Number.isFinite(reps) ? reps : null;
  if (!tabSelected(progressTab)) {
    return { surface: 'other-tab', reps: finiteReps, markers };
  }
  if (joined.includes('Loading measured progress')) {
    return { surface: 'progress-loading', reps: null, markers };
  }
  if (joined.includes('Progress couldn’t load')) {
    return { surface: 'progress-error', reps: null, markers };
  }
  if (repsText === null) return { surface: 'other-tab', reps: null, markers };
  return { surface: 'progress', reps: finiteReps, markers };
}

// ─── Process model ───────────────────────────────────────────────────────────

const nativeModules = NativeModules as { PickleAuth?: unknown };

/** OS kill: every in-memory singleton is gone; only Keychain + SQLite stay. */
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
  useRankCelebrationStore.setState({ current: null, pending: null });
}

const VALID_PROFILE = JSON.stringify({
  skillLevel: 'intermediate',
  handedness: 'right',
  goal: 'consistency',
  biggestProblem: 'popups',
  focusCheckpoint: 'contact_point',
});

const SHOT_TYPES = ['dink', 'drive', 'serve', 'third_shot_drop'] as const;

/** Longer than the 15s canonical-progress timeout plus the slowest seeded
 * latency: anything still ticking after this is not "finishing". Per
 * iteration this is extended by a chain of the seeded latencies, because
 * abandoned work may be a SEQUENCE of reads (hydrate → consistency → …),
 * each paying the seeded latency once. */
const QUIESCE_MS = 25_000;
const QUIESCE_CHAIN_DEPTH = 12;

/** STRESS_TRACE=1 streams every timeline event with wall-clock ms to stderr. */
const TRACE = nodeProcess.env['STRESS_TRACE'] === '1';
declare const require: (id: string) => unknown;
const rawFs = require('node:fs') as {
  writeSync(fd: number, text: string): number;
};
// Straight to fd 2: jest buffers `console.*` until the test ends, which is
// useless for locating a hang.
const trace = (line: string): void => {
  rawFs.writeSync(2, `${line}\n`);
};
/** Every iteration starts here; `jest.clearAllTimers()` resets the fake
 * clock to the install instant, so the clock is re-pinned after each call. */
const EPOCH = new Date('2026-09-04T12:00:00Z');

function clearTimersKeepingClock(): void {
  const now = Date.now();
  jest.clearAllTimers();
  jest.setSystemTime(now);
}

// ─── One iteration ───────────────────────────────────────────────────────────

type Verdicts = Record<
  | 'noCrash'
  | 'ownerIsolation'
  | 'noStaleValue'
  | 'converges'
  | 'idempotentRehydrate'
  | 'noLeakedTimers'
  | 'noLeakedListeners'
  | 'noSignedOutFetch',
  boolean
>;

interface TimelineEvent {
  at: number;
  step: number;
  kind: string;
  detail?: Record<string, unknown>;
}

export interface IterationRow {
  seed: number;
  schedule: Schedule;
  outcome: 'HELD' | 'BROKEN' | 'ERROR';
  verdicts: Verdicts;
  violations: string[];
  timeline: TimelineEvent[];
  final: ScreenReading;
  fetches: number;
  dbReads: number;
  relaunches: number;
  leakedTimerSites: string[];
  leakedListeners: number;
  /** local reads / API calls the abandoned tree issued after unmount */
  postUnmountReads: number;
  postUnmountFetches: number;
  error?: string;
}

class World {
  readonly backend = new ScriptedBackend();
  readonly db = new StressLocalDb();
  renderer: ReactTestRenderer | null = null;
  account: StressAccount;
  /** owner the app is currently expected to be signed in as (null = out) */
  expectSignedInAs: StressAccount | null = null;
  readonly timeline: TimelineEvent[] = [];
  readonly violations: string[] = [];
  readonly verdicts: Verdicts = {
    noCrash: true,
    ownerIsolation: true,
    noStaleValue: true,
    converges: true,
    idempotentRehydrate: true,
    noLeakedTimers: true,
    noLeakedListeners: true,
    noSignedOutFetch: true,
  };
  leakedTimerSites: string[] = [];
  leakedListeners = 0;
  postUnmountReads = 0;
  postUnmountFetches = 0;
  relaunches = 0;
  step = 0;
  private dbFaultArmed = false;
  private apiOutcomeArmed: 'ok' | 'network' | '500' = 'ok';
  /** bearer owner → its most recent sign-out: the fake-ms instant and the
   * backend mint watermark, so only tokens minted BEFORE the sign-out are
   * stale (a later explicit re-sign-in mints fresh ones). */
  private readonly signedOutAt = new Map<
    'a' | 'b',
    { at: number; mintWatermark: number }
  >();

  private noteSignedOut(owner: 'a' | 'b'): void {
    this.signedOutAt.set(owner, {
      at: Date.now(),
      mintWatermark: this.backend.mintCount,
    });
  }
  /** owner → fake-ms instant `revoke-server` ran for it */
  private readonly revokedAt = new Map<'a' | 'b', number>();
  private lastKillAt: number | null = null;
  private rotationInFlightAtKill = false;
  private lastProgressReading: ScreenReading | null = null;

  constructor(readonly schedule: Schedule) {
    this.account = schedule.firstAccount === 'a' ? ACCOUNT_A : ACCOUNT_B;
    this.backend.accessLifetimeSec = schedule.seed % 2 === 0 ? 90 : 240;
    this.backend.policy = {
      latencyMs: record =>
        record.route === '/v1/progress'
          ? schedule.progressLatencyMs
          : schedule.apiLatencyMs,
      outcome: record => {
        if (record.route !== '/v1/progress') return 'ok';
        const armed = this.apiOutcomeArmed;
        this.apiOutcomeArmed = 'ok';
        return armed;
      },
    };
    this.db.policy = {
      latencyMs: record =>
        record.table === 'local_shot'
          ? schedule.dbLatencyMs
          : record.table === 'local_capture'
            ? schedule.captureLatencyMs
            : 0,
      faults: record => {
        if (record.table !== 'local_shot' || !this.dbFaultArmed) return false;
        this.dbFaultArmed = false;
        return true;
      },
    };
    mockDb.current = this.db;
    for (const owner of [ACCOUNT_A, ACCOUNT_B]) {
      this.db.kv.set(`profile:${owner.id}`, VALID_PROFILE);
    }
    const seedFacts = (owner: StressAccount, count: number) => {
      for (let i = 0; i < count; i += 1) {
        const daysAgo = 1 + ((i * 3 + owner.key.charCodeAt(0)) % 18);
        this.db.addFact(
          owner.id,
          new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
          SHOT_TYPES[i % SHOT_TYPES.length]!,
        );
      }
    };
    seedFacts(ACCOUNT_A, schedule.factsA);
    seedFacts(ACCOUNT_B, schedule.factsB);
    globalThis.fetch = this.backend.fetch as typeof fetch;
    nativeModules.PickleAuth = {
      signInWithApple: async () => ({
        identityToken: this.account.identityToken,
        authorizationCode: `code-${this.account.key}`,
        email: this.account.email,
        givenName: `Owner${this.account.key.toUpperCase()}`,
        familyName: 'Stress',
      }),
    };
  }

  log(kind: string, detail?: Record<string, unknown>): void {
    if (TRACE) {
      trace(
        `[seed ${this.schedule.seed}] step ${this.step} fake@${Date.now()} ${kind} ${detail ? JSON.stringify(detail) : ''}`,
      );
    }
    this.timeline.push({
      at: Date.now(),
      step: this.step,
      kind,
      ...(detail ? { detail } : {}),
    });
  }

  fail(invariant: keyof Verdicts, message: string): void {
    this.verdicts[invariant] = false;
    this.violations.push(
      `step ${this.step} @${Date.now()}ms [${invariant}] ${message}`,
    );
    this.log('violation', { invariant, message });
    if (TRACE) {
      for (const call of this.backend.calls.slice(-8)) {
        trace(
          `    call#${call.seq} ${call.method} ${call.route} owner=${call.bearerOwner ?? '-'} issued=${call.issuedAt} settled=${call.settledAt ?? '-'} ${call.outcome}`,
        );
      }
    }
  }

  async flush(ms: number): Promise<void> {
    if (TRACE) {
      trace(
        `[seed ${this.schedule.seed}] flush ${ms}ms fake@${Date.now()} timers=${jest.getTimerCount()} surface=${readScreen(this.renderer).surface}`,
      );
    }
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
    this.observe();
  }

  /** Runs the fake clock until `predicate` holds or `budgetMs` elapses. */
  async until(
    predicate: () => boolean,
    budgetMs: number,
    stepMs = 50,
  ): Promise<boolean> {
    let spent = 0;
    while (spent < budgetMs) {
      if (predicate()) return true;
      await this.flush(stepMs);
      spent += stepMs;
    }
    return predicate();
  }

  /** Checks the tree after every clock advance — the invariants are
   * continuous, not end-of-run. */
  observe(): void {
    const reading = readScreen(this.renderer);
    if (reading.surface === 'crashed') {
      this.fail('noCrash', 'RootErrorBoundary rendered');
    }
    this.reconcileSession('observe');
    const signedIn = this.expectSignedInAs;
    const showsProgressContent =
      reading.surface === 'progress' ||
      (reading.surface === 'other-tab' &&
        (reading.reps !== null || reading.markers.length > 0));
    if (showsProgressContent && signedIn) {
      const owner = signedIn.id;
      const foreign = reading.markers.filter(m => m !== signedIn.key);
      if (foreign.length > 0) {
        this.fail(
          'ownerIsolation',
          `screen shows marker(s) of ${foreign.join(',')} while signed in as ${signedIn.key}`,
        );
      }
      const okSnapshots = new Set(
        this.db.reads
          .filter(
            r =>
              r.table === 'local_shot' &&
              r.owner === owner &&
              r.outcome === 'ok',
          )
          .map(r => r.snapshotCount),
      );
      if (reading.reps !== null && !okSnapshots.has(reading.reps)) {
        const otherOwner = signedIn.key === 'a' ? ACCOUNT_B : ACCOUNT_A;
        const otherSnapshots = this.db.reads
          .filter(
            r =>
              r.table === 'local_shot' &&
              r.owner === otherOwner.id &&
              r.outcome === 'ok',
          )
          .map(r => r.snapshotCount);
        if (otherSnapshots.includes(reading.reps)) {
          this.fail(
            'ownerIsolation',
            `reps=${reading.reps} matches only a read issued for ${otherOwner.key}`,
          );
        } else {
          this.fail(
            'noStaleValue',
            `reps=${reading.reps} matches no successful local read for ${signedIn.key} (${[...okSnapshots].join(',')})`,
          );
        }
      }
      this.lastProgressReading = reading;
    }
    if (
      reading.surface !== 'signed-out' &&
      reading.surface !== 'unmounted' &&
      !signedIn
    ) {
      if (reading.surface === 'progress' || reading.surface === 'other-tab') {
        this.fail(
          'ownerIsolation',
          `signed-in surface "${reading.surface}" while no account is signed in`,
        );
      }
    }
    for (const call of this.backend.calls) {
      if (
        call.bearerOwner === null ||
        call.route.startsWith('/v1/auth/') ||
        call.route === '/v1/account/bootstrap'
      )
        continue;
      const out = this.signedOutAt.get(call.bearerOwner);
      if (out === undefined || call.issuedAt <= out.at) continue;
      const mint = ScriptedBackend.mintOf(call.bearer);
      if (mint !== null && mint > out.mintWatermark) continue; // re-signed-in
      this.fail(
        'noSignedOutFetch',
        `${call.route} issued at ${call.issuedAt} with ${call.bearerOwner}'s pre-sign-out bearer ${call.bearer ?? '-'} (signed out at ${out.at})`,
      );
      this.signedOutAt.delete(call.bearerOwner); // report once
    }
  }

  // ── lifecycle primitives ──────────────────────────────────────────────

  async mount(): Promise<void> {
    await act(async () => {
      this.renderer = create(<App />);
    });
    this.log('mount');
  }

  async unmount(): Promise<void> {
    const renderer = this.renderer;
    this.renderer = null;
    if (renderer) {
      await act(async () => {
        renderer.unmount();
      });
    }
    this.log('unmount');
  }

  /** Waits for the launch gate to resolve to either the tab bar or the
   * pre-auth landing. */
  async awaitGate(): Promise<'tabs' | 'landing' | 'stuck'> {
    const settled = await this.until(
      () => {
        const r = readScreen(this.renderer);
        const t = texts(this.renderer!).join('|');
        return (
          r.surface !== 'unmounted' &&
          !t.match(/Getting things ready|Loading your account/)
        );
      },
      12_000,
      100,
    );
    if (!settled) return 'stuck';
    const reading = readScreen(this.renderer);
    return reading.surface === 'signed-out' ? 'landing' : 'tabs';
  }

  /** Fires a store action whose completion depends on seeded latencies and
   * drives the fake clock until the store reports it done (awaiting it inside
   * `act` would deadlock the fake timers). */
  async storeAction(label: string, action: () => Promise<void>): Promise<void> {
    let done = false;
    let failure: unknown = null;
    act(() => {
      action().then(
        () => {
          done = true;
        },
        (reason: unknown) => {
          done = true;
          failure = reason;
        },
      );
    });
    const settled = await this.until(() => done, 30_000, 25);
    if (!settled) throw new Error(`${label} never settled (30s fake)`);
    if (failure !== null) throw failure;
  }

  async signIn(): Promise<void> {
    // Expected owner is set BEFORE the action: the tab bar may appear during
    // a clock advance inside `storeAction`, and it must be judged against
    // the account that is signing in.
    this.expectSignedInAs = this.account;
    await this.storeAction('signInWithApple', () =>
      useAuthStore.getState().signInWithApple(),
    );
    const authError = useAuthStore.getState().error?.message ?? null;
    this.log('signInWithApple', { as: this.account.key, error: authError });
    if (authError !== null) {
      this.expectSignedInAs = null;
      this.fail('converges', `signInWithApple failed: ${authError}`);
      return;
    }
    const gate = await this.awaitGate();
    if (gate !== 'tabs') {
      this.fail('converges', `after sign-in the gate resolved to "${gate}"`);
    }
  }

  async pressTab(
    label: 'Progress' | 'Home' | 'Library' | 'Settings',
  ): Promise<boolean> {
    const button = this.renderer ? tabButton(this.renderer, label) : null;
    if (!button) {
      this.log('tab-missing', { label });
      return false;
    }
    await act(async () => {
      button.props.onPress();
    });
    this.log('press-tab', { label });
    return true;
  }

  async launch(): Promise<void> {
    await this.mount();
    const gate = await this.awaitGate();
    if (gate === 'stuck') {
      this.fail('converges', 'launch gate never resolved (12s fake)');
      return;
    }
    if (gate === 'landing') {
      if (this.expectSignedInAs) {
        // Signed OUT after a kill although a session was persisted: only
        // legitimate when the relaunch refresh was refused by the server.
        const state = useAuthStore.getState();
        if (state.session || !state.hydrated || state.busy) {
          this.fail(
            'idempotentRehydrate',
            `relaunch shows the landing while the store holds ${state.session ? 'a session' : 'an unsettled state'} for ${this.expectSignedInAs.key}`,
          );
          this.expectSignedInAs = null;
          return;
        }
        if (!this.reconcileSession('relaunch')) return;
        return;
      }
      await this.signIn();
    } else if (!this.expectSignedInAs) {
      this.fail(
        'ownerIsolation',
        'launch reached the tab bar with no persisted account',
      );
    }
    if (this.expectSignedInAs) {
      const session = useAuthStore.getState().session;
      if (session?.canonicalAppUserId !== this.expectSignedInAs.id) {
        this.fail(
          'idempotentRehydrate',
          `session owner ${session?.canonicalAppUserId ?? 'none'} ≠ expected ${this.expectSignedInAs.id}`,
        );
      }
      if (getActiveDataOwner() !== this.expectSignedInAs.id) {
        this.fail(
          'ownerIsolation',
          `active data owner ${getActiveDataOwner()} ≠ ${this.expectSignedInAs.id}`,
        );
      }
      await this.pressTab('Progress');
    }
  }

  /** Budget for the Progress screen to leave its spinner: it awaits the two
   * local reads AND the canonical request together. */
  progressLoadBudgetMs(): number {
    return (
      Math.max(
        this.schedule.dbLatencyMs,
        this.schedule.captureLatencyMs,
        this.schedule.progressLatencyMs,
      ) + 2_000
    );
  }

  async killAndRelaunch(): Promise<void> {
    const before = this.lastProgressReading;
    // A refresh that is in flight when the process dies is still served by
    // the server (the token rotates) but its response is lost. Remembered
    // so the relaunch outcome can be classified.
    this.rotationInFlightAtKill = this.backend.calls.some(
      c => c.route === '/v1/auth/refresh' && c.outcome === 'pending',
    );
    this.lastKillAt = Date.now();
    await this.unmount();
    await this.measureLeaks('kill');
    resetProcessState();
    clearTimersKeepingClock();
    timerSites.clear();
    appStateListeners.clear();
    this.relaunches += 1;
    this.log('relaunch');
    await this.launch();
    if (before && this.expectSignedInAs) {
      const settled = await this.until(
        () => readScreen(this.renderer).surface === 'progress',
        this.progressLoadBudgetMs(),
      );
      const after = readScreen(this.renderer);
      if (!settled) {
        this.fail(
          'idempotentRehydrate',
          `relaunched Progress did not load (surface=${after.surface})`,
        );
      } else if (after.reps !== this.db.scoredCount(this.expectSignedInAs.id)) {
        this.fail(
          'idempotentRehydrate',
          `relaunched reps=${after.reps} ≠ SQLite ${this.db.scoredCount(this.expectSignedInAs.id)}`,
        );
      }
    }
  }

  async measureLeaks(reason: string): Promise<void> {
    // Module singletons outlive the tree legitimately; stop them the way the
    // process teardown would. In-flight requests and finite reveal animations
    // are allowed to run out (safely abandoned, per REVIEW.md); a timer that
    // is STILL alive after the quiescence window is a loop or a re-arm the
    // unmount did not stop.
    stopSessionKeeper();
    clearSyncRuntime();
    const readsBefore = this.db.reads.length;
    const callsBefore = this.backend.calls.length;
    const chain =
      QUIESCE_CHAIN_DEPTH *
      Math.max(
        this.schedule.dbLatencyMs,
        this.schedule.captureLatencyMs,
        this.schedule.progressLatencyMs,
        this.schedule.apiLatencyMs,
      );
    await this.flush(QUIESCE_MS + chain);
    const timers = jest.getTimerCount();
    const sites = [...timerSites.values()];
    const listeners = appStateListeners.size;
    // Work the abandoned tree kept issuing AFTER it was gone — not a
    // violation (it lands on the `active` guards) but recorded per seed.
    const postUnmountReads = this.db.reads.length - readsBefore;
    const postUnmountFetches = this.backend.calls.length - callsBefore;
    this.postUnmountReads += postUnmountReads;
    this.postUnmountFetches += postUnmountFetches;
    this.log('leak-check', {
      reason,
      timers,
      sites,
      listeners,
      postUnmountReads,
      postUnmountFetches,
    });
    if (timers > 0) {
      this.leakedTimerSites = sites;
      this.fail(
        'noLeakedTimers',
        `${timers} timer(s) alive after unmount (${reason}): ${sites.join(' ; ')}`,
      );
    }
    if (listeners > 0) {
      this.leakedListeners = listeners;
      this.fail(
        'noLeakedListeners',
        `${listeners} AppState listener(s) alive after unmount (${reason})`,
      );
    }
  }

  async switchAccount(): Promise<void> {
    const leaving = this.account;
    this.noteSignedOut(leaving.key);
    this.expectSignedInAs = null;
    await this.storeAction('signOut', () => useAuthStore.getState().signOut());
    this.log('signOut', { was: leaving.key });
    await this.flush(50);
    // A sign-out must leave nothing of the previous owner on screen.
    const reading = readScreen(this.renderer);
    if (reading.surface !== 'signed-out' && reading.surface !== 'crashed') {
      this.fail(
        'ownerIsolation',
        `after signOut the surface is "${reading.surface}"`,
      );
    }
    this.account = leaving.key === 'a' ? ACCOUNT_B : ACCOUNT_A;
    this.lastProgressReading = null;
    await this.signIn();
    await this.pressTab('Progress');
  }

  // ── schedule execution ────────────────────────────────────────────────

  async run(step: Step): Promise<void> {
    this.log(step.kind);
    switch (step.kind) {
      case 'settle':
        break;
      case 'background':
        act(() => emitAppState('background'));
        break;
      case 'foreground':
        act(() => emitAppState('active'));
        break;
      case 'tab-away':
        await this.pressTab(this.schedule.seed % 3 === 0 ? 'Settings' : 'Home');
        break;
      case 'tab-back':
        await this.pressTab('Progress');
        break;
      case 'kill-relaunch':
        await this.killAndRelaunch();
        break;
      case 'switch-account':
        await this.switchAccount();
        break;
      case 'revoke-server':
        this.backend.revokeAll(this.account.key);
        this.revokedAt.set(this.account.key, Date.now());
        break;
      case 'rotate-token':
        act(() => refreshSessionNow());
        break;
      case 'db-fault-next':
        this.dbFaultArmed = true;
        break;
      case 'retry': {
        const retry = this.renderer
          ? findAllSafe(
              this.renderer,
              n =>
                n.props.accessibilityLabel === 'Try again' ||
                (n.props.children === 'Try again' &&
                  typeof n.props.onPress === 'function'),
            )
          : [];
        const pressable =
          retry.find(n => typeof n.props.onPress === 'function') ??
          retry[0]?.parent ??
          null;
        if (pressable && typeof pressable.props.onPress === 'function') {
          await act(async () => {
            pressable.props.onPress();
          });
          this.log('press-retry');
        }
        break;
      }
      case 'add-fact':
        this.db.addFact(
          this.account.id,
          new Date(Date.now() - 3_600_000).toISOString(),
          SHOT_TYPES[this.db.facts.length % SHOT_TYPES.length]!,
        );
        break;
      case 'api-500-next':
        this.apiOutcomeArmed = '500';
        break;
      case 'api-network-next':
        this.apiOutcomeArmed = 'network';
        break;
    }
    await this.flush(step.thenMs);
  }

  /** The ONE legitimate implicit sign-out: the server refused the refresh
   * token after `revoke-server` (AGENTS.md § Auth sessions). */
  serverRefusedSince(owner: 'a' | 'b'): boolean {
    const revokedAt = this.revokedAt.get(owner);
    if (revokedAt === undefined) return false;
    // The server decides when the request is SERVED (settledAt), so a
    // refresh that left before the revocation and landed after it counts.
    return this.backend.calls.some(
      c =>
        c.route === '/v1/auth/refresh' &&
        c.outcome === 'revoked' &&
        (c.settledAt ?? c.issuedAt) >= revokedAt,
    );
  }

  /** Reconcile the expected owner with the auth store once it is settled
   * (hydrated, not busy). Returns true when an implicit sign-out was accepted. */
  reconcileSession(context: string): boolean {
    const expected = this.expectSignedInAs;
    if (!expected) return false;
    const state = useAuthStore.getState();
    if (!state.hydrated || state.busy || state.session) return false;
    if (this.serverRefusedSince(expected.key)) {
      this.log('implicit-signout', { owner: expected.key, context });
      this.noteSignedOut(expected.key);
      this.expectSignedInAs = null;
      return true;
    }
    // No revocation was scheduled. If the process died while a rotation
    // was in flight, the server consumed the persisted refresh token and
    // the relaunch presented the stale one: a lost session on relaunch.
    const refusedAfterKill =
      this.lastKillAt !== null &&
      this.backend.calls.some(
        c =>
          c.route === '/v1/auth/refresh' &&
          c.outcome === 'revoked' &&
          c.issuedAt >= this.lastKillAt!,
      );
    if (refusedAfterKill && this.rotationInFlightAtKill) {
      this.fail(
        'idempotentRehydrate',
        `${context}: relaunch refresh refused — the refresh token persisted before the kill was consumed by a rotation still in flight when the process died (session for ${expected.key} lost without any server-side revocation)`,
      );
    } else {
      this.fail(
        context === 'relaunch' ? 'idempotentRehydrate' : 'converges',
        `${context}: session for ${expected.key} vanished without a server refusal`,
      );
    }
    this.noteSignedOut(expected.key);
    this.expectSignedInAs = null;
    return false;
  }

  /** Final convergence: everything in flight lands, then a FRESH focus of
   * the screen must show the live SQLite count and the owner's own canonical
   * marker (or the signed-out landing if nobody is signed in). The screen
   * only re-reads on focus/retry, so a fact added while it sat mounted is
   * legitimately absent until then — hence the tab-away/tab-back first. */
  async converge(): Promise<void> {
    this.dbFaultArmed = false;
    this.apiOutcomeArmed = 'ok';
    const budget =
      Math.max(
        this.schedule.dbLatencyMs,
        this.schedule.progressLatencyMs,
        this.schedule.captureLatencyMs,
      ) + 3_000;
    await this.flush(budget);
    this.reconcileSession('converge');
    if (!this.expectSignedInAs) {
      const reading = readScreen(this.renderer);
      if (reading.surface !== 'signed-out') {
        this.fail(
          'converges',
          `signed out but surface is "${reading.surface}"`,
        );
      }
      return;
    }
    const owner = this.expectSignedInAs;
    await this.pressTab('Home');
    await this.flush(50);
    await this.pressTab('Progress');
    await this.flush(budget);
    const reading = readScreen(this.renderer);
    if (!this.expectSignedInAs) {
      // The keeper's rotation was refused during the refocus (revoke-server
      // earlier in the schedule): the landing must be showing now.
      if (reading.surface !== 'signed-out') {
        this.fail(
          'converges',
          `signed out during refocus but surface is "${reading.surface}"`,
        );
      }
      return;
    }
    if (reading.surface !== 'progress') {
      const last = this.db.reads
        .filter(r => r.table === 'local_shot' && r.owner === owner.id)
        .at(-1);
      this.fail(
        'converges',
        `fresh focus for ${owner.key} shows "${reading.surface}" (last local read: ${last?.outcome ?? 'none'})`,
      );
      return;
    }
    const live = this.db.scoredCount(owner.id);
    if (reading.reps !== live) {
      this.fail(
        'converges',
        `reps=${reading.reps} ≠ live SQLite count ${live} for ${owner.key}`,
      );
    }
    // With the owner's tokens revoked server-side, /v1/progress is refused
    // until the keeper's next rotation ends the session; the screen
    // legitimately shows local-only data until then.
    if (
      !this.revokedAt.has(owner.key) &&
      !reading.markers.includes(owner.key)
    ) {
      this.fail(
        'converges',
        `fresh focus for ${owner.key} did not render its canonical marker (markers=${reading.markers.join(',') || 'none'})`,
      );
    }
  }

  fetchSummary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const call of this.backend.calls) {
      const key = `${call.route}:${call.outcome}`;
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }
}

async function runIteration(seed: number): Promise<IterationRow> {
  const schedule = buildSchedule(seed);
  if (STEPS_OVERRIDE) schedule.steps = parseSteps(STEPS_OVERRIDE);
  timerSites.clear();
  appStateListeners.clear();
  unhandledRejections.length = 0;
  mockKeychain.clear();
  mockPermission.current = 'granted';
  resetProcessState();
  jest.clearAllTimers();
  jest.setSystemTime(EPOCH);
  const world = new World(schedule);
  let error: string | undefined;
  try {
    await world.launch();
    await world.until(
      () => readScreen(world.renderer).surface === 'progress',
      world.progressLoadBudgetMs(),
    );
    for (const step of schedule.steps) {
      world.step += 1;
      await world.run(step);
    }
    world.step += 1;
    await world.converge();
    await world.unmount();
    await world.measureLeaks('final');
  } catch (caught) {
    error =
      caught instanceof Error
        ? `${caught.name}: ${caught.message}\n${caught.stack ?? ''}`
        : String(caught);
    world.fail('noCrash', `harness caught: ${error.split('\n')[0]}`);
    await world.unmount().catch(() => {});
  }
  if (unhandledRejections.length > 0) {
    world.fail(
      'noCrash',
      `unhandled rejection(s): ${unhandledRejections.join(' ; ')}`,
    );
  }
  resetProcessState();
  clearTimersKeepingClock();
  const held = Object.values(world.verdicts).every(Boolean);
  return {
    seed,
    schedule,
    outcome: error ? 'ERROR' : held ? 'HELD' : 'BROKEN',
    verdicts: world.verdicts,
    violations: world.violations,
    timeline: world.timeline,
    final: readScreen(null),
    fetches: world.backend.calls.length,
    dbReads: world.db.reads.length,
    relaunches: world.relaunches,
    leakedTimerSites: world.leakedTimerSites,
    leakedListeners: world.leakedListeners,
    postUnmountReads: world.postUnmountReads,
    postUnmountFetches: world.postUnmountFetches,
    ...(error ? { error } : {}),
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
let untrackTimers: () => void = () => {};
const onUnhandled = (reason: unknown) => {
  unhandledRejections.push(
    reason instanceof Error ? reason.message : String(reason),
  );
};
declare const process: {
  on(event: string, fn: (reason: unknown) => void): void;
  off(event: string, fn: (reason: unknown) => void): void;
};

const realRaf = globalThis.requestAnimationFrame;
const realCaf = globalThis.cancelAnimationFrame;

beforeAll(() => {
  jest.useFakeTimers();
  untrackTimers = trackTimers();
  // The RN jest preset shims requestAnimationFrame as setTimeout(…, 0): under
  // fake timers a JS-driven Animated.timing then re-arms at the SAME instant
  // forever and never reaches its duration. A 16ms frame keeps every reveal
  // animation finite in fake time, exactly as a 60Hz display would.
  globalThis.requestAnimationFrame = ((callback: (now: number) => void) =>
    globalThis.setTimeout(
      () => callback(Date.now()),
      16,
    )) as unknown as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) =>
    globalThis.clearTimeout(id)) as typeof cancelAnimationFrame;
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: (state: string) => void,
  ) => {
    appStateListeners.add(handler);
    return { remove: () => appStateListeners.delete(handler) };
  }) as unknown as typeof AppState.addEventListener);
  process.on('unhandledRejection', onUnhandled);
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  globalThis.fetch = realFetch;
  delete nativeModules.PickleAuth;
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCaf;
  untrackTimers();
  jest.useRealTimers();
});

const ITERATIONS = Number(nodeProcess.env['STRESS_ITER'] ?? 12);
const SEED_BASE = Number(nodeProcess.env['STRESS_SEED_BASE'] ?? 7_000);
const ONLY_SEED = nodeProcess.env['STRESS_SEED'];
const STEPS_OVERRIDE = nodeProcess.env['STRESS_STEPS'];
const seeds = ONLY_SEED
  ? [Number(ONLY_SEED)]
  : Array.from({ length: ITERATIONS }, (_, i) => SEED_BASE + i);

describe('STRESS scr-progressscreen × lifecycle — seeded interleavings', () => {
  const rows: IterationRow[] = [];

  afterAll(() => {
    const summary = {
      generatedAt: new Date().toISOString(),
      iterations: rows.length,
      held: rows.filter(r => r.outcome === 'HELD').length,
      broken: rows.filter(r => r.outcome === 'BROKEN').length,
      error: rows.filter(r => r.outcome === 'ERROR').length,
      byInvariant: Object.fromEntries(
        (Object.keys(rows[0]?.verdicts ?? {}) as Array<keyof Verdicts>).map(
          k => [k, rows.filter(r => !r.verdicts[k]).map(r => r.seed)],
        ),
      ),
      stepKinds: rows.reduce<Record<string, number>>((acc, r) => {
        for (const s of r.schedule.steps) acc[s.kind] = (acc[s.kind] ?? 0) + 1;
        return acc;
      }, {}),
      totalFetches: rows.reduce((n, r) => n + r.fetches, 0),
      totalDbReads: rows.reduce((n, r) => n + r.dbReads, 0),
      totalRelaunches: rows.reduce((n, r) => n + r.relaunches, 0),
      table: rows.map(r => ({
        seed: r.seed,
        outcome: r.outcome,
        steps: r.schedule.steps.map(s => s.kind).join('>'),
        dbMs: r.schedule.dbLatencyMs,
        progressMs: r.schedule.progressLatencyMs,
        violations: r.violations,
      })),
    };
    const tag = ONLY_SEED
      ? `seed-${ONLY_SEED}`
      : `campaign-${SEED_BASE}-${rows.length}`;
    writeJsonArtifact(`${tag}.summary.json`, summary);
    writeJsonArtifact(`${tag}.rows.json`, rows);
    writeTextArtifact(
      `${tag}.table.md`,
      [
        '| seed | outcome | db ms | progress ms | steps | violations |',
        '|---|---|---|---|---|---|',
      ]
        .concat(
          rows.map(
            r =>
              `| ${r.seed} | ${r.outcome} | ${r.schedule.dbLatencyMs} | ${r.schedule.progressLatencyMs} | ${r.schedule.steps.map(s => s.kind).join(' › ')} | ${r.violations.length === 0 ? '' : r.violations.map(v => v.replace(/\|/g, '/')).join('<br>')} |`,
          ),
        )
        .join('\n') + '\n',
    );
  });

  for (const seed of seeds) {
    it(`seed ${seed} holds every lifecycle invariant`, async () => {
      const row = await runIteration(seed);
      rows.push(row);
      if (row.outcome !== 'HELD') {
        throw new Error(
          `seed ${seed} ${row.outcome}\n` +
            row.violations.map(v => `  - ${v}`).join('\n') +
            (row.error ? `\n${row.error}` : '') +
            `\nschedule: ${row.schedule.steps.map(s => `${s.kind}+${s.thenMs}`).join(' › ')}` +
            `\nlatencies: db=${row.schedule.dbLatencyMs} progress=${row.schedule.progressLatencyMs} capture=${row.schedule.captureLatencyMs}`,
        );
      }
    }, 120_000);
  }
});
