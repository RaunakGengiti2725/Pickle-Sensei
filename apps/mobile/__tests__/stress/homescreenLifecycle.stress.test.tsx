/**
 * STRESS — HomeScreen × lifecycle interruption.
 *
 * Renders the REAL App (SafeAreaProvider → QueryClientProvider →
 * RootErrorBoundary → Gate → RootNavigator → native stack → bottom tabs →
 * HomeScreen) with only native modules and `fetch` replaced, then drives
 * seeded schedules of background/foreground, tab/stack navigation, pull to
 * refresh, process kill + relaunch (re-hydrate from Keychain + SQLite),
 * client token rotation and server-side revocation mid-request, sign-out,
 * sign-in and account switches, notification permission flips, held/faulted
 * local reads and retries — each interleaved at seed-derived points inside
 * pending local-database and network work.
 *
 * Process model: every launch boots a FRESH module registry
 * (`jest.resetModules()` + re-require of App and its stores), so a kill really
 * drops every in-memory singleton (auth/app/notification/consistency stores,
 * session keeper, sync runtime, query client, navigation ref) and only the
 * Keychain seam and the SQLite seam survive — exactly what iOS preserves.
 *
 * Invariants checked after EVERY step and after the final settle:
 *   I1 owner-render   Home never shows another owner's reads or rank.
 *   I2 owner-request  every /v1/progress + /v1/rank call carries the bearer of
 *                     the account that owns the active data owner.
 *   I3 fresh-bearer   no request carries a bearer the client had already
 *                     replaced (rotation adopted before the next call).
 *   I4 celebration    a rank-up ceremony belongs to the active owner.
 *   I5 no-crash       the root error boundary never renders.
 *   I6 no-data-loss   local_shot rows are byte-identical before and after;
 *                     no DELETE/DROP/UPDATE ever issued by this surface.
 *   I7 settles        signed-in + healthy DB ⇒ Home leaves the loading and
 *                     error states once work drains.
 *   I8 permission     after a foreground, the store's permission equals the
 *                     system's.
 *   I9 idempotent     a clean relaunch from the final persisted state renders
 *                     the same Home as the interrupted run converged to.
 *   I10 no-leak       after the tree unmounts only the two process singletons
 *                     (session keeper, sync runtime) may still listen to
 *                     AppState; after they stop + 15 fake minutes: zero
 *                     timers, zero listeners.
 *
 * Replay one seed: STRESS_SEED=<n> npx jest --ci --detectOpenHandles
 *   __tests__/stress/homescreenLifecycle.stress.test.tsx
 * Campaign size: STRESS_ITER (default 10 so the suite stays fast, ~15 s; the
 * lifecycle campaign is STRESS_ITER=100, ~2 min), first seed STRESS_FIRST_SEED.
 * Results table: STRESS_OUT=<path>.json (default apps/mobile/artifacts/stress/,
 * git-ignored); testing/stress/homescreen-lifecycle/summarize.py prints it.
 * Minimised repros: STRESS_SCHEDULE=<path>.json holding a StressSchedule[]
 * (hand-written world + steps) runs those instead of generated ones, e.g.
 * STRESS_SCHEDULE=testing/stress/homescreen-lifecycle/min-seed6.json.
 * Flake rate: STRESS_SEEDS=6,16,17 STRESS_REPEAT=10 runs each listed seed
 * ten times (the table then holds one row per run).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';

import { GatedLocalDb } from '../../testing/stress/homescreen-lifecycle/gatedDb';
import {
  ScriptedApi,
  type StressAccount,
} from '../../testing/stress/homescreen-lifecycle/scriptedApi';
import {
  describeStep,
  generateSchedule,
  type AccountKey,
  type StressSchedule,
  type StressStep,
} from '../../testing/stress/homescreen-lifecycle/schedule';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import type { PlannedNotification } from '../../src/notifications/types';
// Pure helpers/constants (no runtime state) — safe to share across processes.
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
} from '../../src/data/accountScope';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';

// ─── Native / config seams (nothing else is mocked) ──────────────────────────

const mockDb = { current: new GatedLocalDb() };
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

const mockGoogle = {
  nextIdToken: null as string | null,
  nextEmail: null as string | null,
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: () => {},
    hasPlayServices: async () => true,
    signIn: async () => ({
      type: 'success',
      data: {
        idToken: mockGoogle.nextIdToken,
        user: { name: 'Stress Player', email: mockGoogle.nextEmail },
      },
    }),
    signInSilently: async () => {
      throw new Error('no silent google session (simulated)');
    },
    hasPreviousSignIn: () => false,
    signOut: async () => {},
    revokeAccess: async () => {},
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
    appStoreId: null,
    appStoreWriteReviewUrl: null,
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

jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
);
jest.mock('react-native-linear-gradient', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockGradient = (props: { children?: unknown }) =>
    ReactModule.createElement(View, null, props.children as null);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-webview', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockWebView = () => ReactModule.createElement(View, null);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});
jest.mock('react-native-video', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockVideo = () => ReactModule.createElement(View, null);
  return { __esModule: true, default: MockVideo };
});

// ─── Process: one fresh module registry per launch ───────────────────────────

type AppStateHandler = (state: string) => void;

interface Proc {
  /** process generation, 0-based, bumped on every boot */
  gen: number;
  React: typeof import('react');
  TR: typeof import('react-test-renderer');
  RN: typeof import('react-native');
  App: typeof import('../../App').default;
  auth: typeof import('../../src/auth/authStore');
  notifications: typeof import('../../src/notifications/notificationStore');
  consistency: typeof import('../../src/consistency/store');
  rank: typeof import('../../src/progress/rankCelebration');
  keeper: typeof import('../../src/account/sessionKeeper');
  sync: typeof import('../../src/data/syncRuntime');
  scope: typeof import('../../src/data/accountScope');
  /** live AppState 'change' listeners registered by this process */
  listeners: Set<AppStateHandler>;
}

let processGeneration = 0;
let appStateCurrent: 'active' | 'background' = 'active';

/** Drop every pending fake timer without moving the fake clock
 * (`clearAllTimers` resets the clock to its install time). */
function dropAllTimers(): void {
  const now = Date.now();
  jest.clearAllTimers();
  jest.setSystemTime(now);
}

function bootProcess(): Proc {
  jest.resetModules();
  const RN = require('react-native') as typeof import('react-native');
  const listeners = new Set<AppStateHandler>();
  (RN.AppState as unknown as { currentState: string }).currentState =
    appStateCurrent;
  jest.spyOn(RN.AppState, 'addEventListener').mockImplementation(((
    type: string,
    handler: AppStateHandler,
  ) => {
    if (type === 'change') listeners.add(handler);
    return {
      remove: () => {
        listeners.delete(handler);
      },
    };
  }) as unknown as typeof RN.AppState.addEventListener);
  const proc: Proc = {
    gen: processGeneration,
    React: require('react') as typeof import('react'),
    TR: require('react-test-renderer') as typeof import('react-test-renderer'),
    RN,
    App: (require('../../App') as typeof import('../../App')).default,
    auth: require('../../src/auth/authStore') as typeof import('../../src/auth/authStore'),
    notifications:
      require('../../src/notifications/notificationStore') as typeof import('../../src/notifications/notificationStore'),
    consistency:
      require('../../src/consistency/store') as typeof import('../../src/consistency/store'),
    rank: require('../../src/progress/rankCelebration') as typeof import('../../src/progress/rankCelebration'),
    keeper:
      require('../../src/account/sessionKeeper') as typeof import('../../src/account/sessionKeeper'),
    sync: require('../../src/data/syncRuntime') as typeof import('../../src/data/syncRuntime'),
    scope:
      require('../../src/data/accountScope') as typeof import('../../src/data/accountScope'),
    listeners,
  };
  processGeneration += 1;
  return proc;
}

function dispatchAppState(proc: Proc, next: 'active' | 'background'): void {
  appStateCurrent = next;
  (proc.RN.AppState as unknown as { currentState: string }).currentState = next;
  for (const handler of [...proc.listeners]) handler(next);
}

// ─── World ───────────────────────────────────────────────────────────────────

const ACCOUNTS: Record<AccountKey, StressAccount> = {
  A: {
    id: '7fc2c743-028f-4ec6-942c-a84508f3be38',
    email: 'a@example.test',
    idToken: 'google-id-token-A',
    rank: { rating: 4.2, tier: 'silver' },
    progressStreakDays: 3,
  },
  B: {
    id: '0b4d1f9e-3c2a-4b8e-9f1d-2a6c7e8b9d01',
    email: 'b@example.test',
    idToken: 'google-id-token-B',
    rank: { rating: 7.8, tier: 'diamond' },
    progressStreakDays: 9,
  },
};
const OWNER_A = canonicalDataOwner(ACCOUNTS.A.id);
const OWNER_B = canonicalDataOwner(ACCOUNTS.B.id);

/** Each owner's reads use ONE distinct stroke and ONE rating band so a
 * rendered card or rank label identifies whose data it is. */
const OWNER_SIGNATURE: Record<
  string,
  { shotType: string; scoreBase: number; tier: 'bronze' | 'silver' | 'diamond' }
> = {
  [OWNER_A]: { shotType: 'forehand_drive', scoreBase: 4.0, tier: 'silver' },
  [OWNER_B]: { shotType: 'dink', scoreBase: 7.6, tier: 'diamond' },
  [GUEST_DATA_OWNER]: { shotType: 'serve', scoreBase: 2.0, tier: 'bronze' },
};
function tierForRating(
  rating: number,
): 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' {
  if (rating >= 7.5) return 'diamond';
  if (rating >= 6.5) return 'platinum';
  if (rating >= 5) return 'gold';
  if (rating >= 3.5) return 'silver';
  return 'bronze';
}

const PROFILE = {
  skillLevel: 'intermediate',
  handedness: 'right',
  goal: 'consistency',
  biggestProblem: 'popups',
  focusCheckpoint: 'contact_point',
};

const T0 = new Date('2026-03-01T09:00:00.000Z').getTime();

function seedShots(db: GatedLocalDb, owner: string, count: number): void {
  const signature = OWNER_SIGNATURE[owner]!;
  for (let i = 0; i < count; i += 1) {
    const id = `${owner.slice(0, 12)}-shot-${i}`;
    const capturedAt = new Date(T0 - (i + 1) * 6 * 3_600_000).toISOString();
    const score = Math.round((signature.scoreBase + (i % 4) * 0.1) * 10) / 10;
    const payload = {
      id,
      sessionId: null,
      shotType: signature.shotType,
      cameraView: 'side',
      handedness: 'right',
      capturedAtIso: capturedAt,
      timestamps: { startMs: 0, contactMs: 400, endMs: 900 },
      phases: [],
      measurements: [],
      checkpoints: [
        { key: 'contact_point', applicable: true, score: score, weight: 1 },
      ],
      overallScore: score,
      analysisConfidence: 0.9,
      resultKind: 'scored',
      guidance: null,
      priorityFix: { checkpoint: 'contact_point' },
      versionVector: {
        appVersion: '1.0',
        modelBundleVersion: 'mb1',
        poseModelVersion: 'p1',
        paddleModelVersion: 'pd1',
        strokeDetectorVersion: 's1',
        phaseModelVersion: 'ph1',
        scoringModelVersion: 'v1',
        shotConfigVersion: 'c1',
      },
      source: 'real',
    };
    db.addShot({
      ownerKey: owner,
      id,
      sessionId: null,
      shotType: signature.shotType,
      capturedAt,
      overallScore: score,
      confidence: 0.9,
      resultKind: 'scored',
      source: 'real',
      favorite: 0,
      payload: JSON.stringify(payload),
    });
  }
}

// ─── Render observation ──────────────────────────────────────────────────────

interface RenderSnapshot {
  screen:
    | 'home'
    | 'home-loading'
    | 'home-error'
    | 'gate-loading'
    | 'welcome'
    | 'crash'
    | 'other';
  recentTypes: string[];
  rankRating: number | null;
  rankTier: string | null;
  streakBadge: string | null;
  texts: number;
}

const HOME_MARKER =
  'Stroke Analysis. Analyze one movement with fast, detailed feedback.';

function labelOf(node: ReactTestInstance): string | null {
  const label = node.props['accessibilityLabel'];
  return typeof label === 'string' ? label : null;
}

const EMPTY_SNAPSHOT: RenderSnapshot = {
  screen: 'other',
  recentTypes: [],
  rankRating: null,
  rankTier: null,
  streakBadge: null,
  texts: 0,
};

function snapshot(
  proc: Proc,
  renderer: ReactTestRenderer | null,
): RenderSnapshot {
  if (!renderer) return EMPTY_SNAPSHOT;
  const root = renderer.root;
  const labels: string[] = [];
  const walk = (node: ReactTestInstance) => {
    const label = labelOf(node);
    if (label) labels.push(label);
    for (const child of node.children) {
      if (typeof child !== 'string') walk(child);
    }
  };
  walk(root);
  const texts = root.findAllByType(proc.RN.Text).map(node => {
    const children = node.props['children'];
    return Array.isArray(children) ? children.join('') : String(children ?? '');
  });
  const has = (needle: string) => texts.some(text => text.includes(needle));
  let screen: RenderSnapshot['screen'] = 'other';
  if (has('Something went wrong')) screen = 'crash';
  else if (labels.includes(HOME_MARKER)) screen = 'home';
  else if (has('Loading your court')) screen = 'home-loading';
  else if (has('Your court couldn’t load')) screen = 'home-error';
  else if (has('Loading your account') || has('Getting things ready'))
    screen = 'gate-loading';
  else if (labels.includes('I already have an account')) screen = 'welcome';
  const recentTypes = labels
    .map(label => /^Open (.+) result$/.exec(label)?.[1] ?? null)
    .filter((type): type is string => type !== null)
    .map(type => type.replace(/ /g, '_'));
  const rankLabel = labels.find(label => label.startsWith('Player rank'));
  const ratingMatch = rankLabel
    ? /rating ([0-9.]+) out of 10/.exec(rankLabel)
    : null;
  const rankRating = ratingMatch ? Number(ratingMatch[1]) : null;
  const streakBadge =
    labels.find(label =>
      /training streak\. Opens the consistency calendar/.test(label),
    ) ?? null;
  return {
    screen,
    recentTypes: [...new Set(recentTypes)],
    rankRating,
    rankTier: rankRating === null ? null : tierForRating(rankRating),
    streakBadge,
    texts: texts.length,
  };
}

function findByLabel(
  renderer: ReactTestRenderer,
  predicate: (label: string) => boolean,
): ReactTestInstance | null {
  const found = renderer.root.findAll(node => {
    const label = labelOf(node);
    return (
      label !== null &&
      predicate(label) &&
      typeof node.props['onPress'] === 'function'
    );
  });
  return found[0] ?? null;
}

// ─── Iteration ───────────────────────────────────────────────────────────────

interface Violation {
  invariant: string;
  step: number;
  detail: string;
}

interface IterationRow {
  seed: number;
  world: StressSchedule['world'];
  steps: string[];
  outcome: 'pass' | 'fail';
  violations: Violation[];
  /** per step: `<i> <step> @+<ms> proc<g> screen=… session=… owner=… busy=… hydrated=… req=<n> keychain=<bool>` */
  trace: string[];
  observed: {
    final: RenderSnapshot;
    reference: RenderSnapshot;
    finalOwner: string;
    finalSession: string | null;
    requests: number;
    requestsByRoute: Record<string, number>;
    unexpectedRoutes: string[];
    statements: number;
    pendingAtSettle: string[];
    killedStatements: number;
    killedRequests: number;
    rotations: number;
    kills: number;
    ceremoniesDismissed: number;
    processes: number;
    timersAfterTeardown: number;
    listenersAfterUnmount: number;
    listenersAfterTeardown: number;
    consoleErrors: string[];
    wallMs: number;
  };
}

function describeConsistency(proc: Proc): string {
  const state = proc.consistency.useConsistencyStore.getState();
  const snap = state.snapshot;
  return `consistency owner=${state.ownerKey?.slice(0, 8) ?? 'none'} hydrated=${state.hydrated} loadError=${state.loadError} streak=${snap?.currentStreak ?? '-'} trainedToday=${snap?.trainedToday ?? '-'} asOfDay=${snap?.asOfDay ?? '-'} tz=${snap?.timeZone ?? '-'} days=${snap ? Object.keys(snap.days).join(',') : '-'}`;
}

function accountForOwner(owner: string): StressAccount | null {
  if (owner === OWNER_A) return ACCOUNTS.A;
  if (owner === OWNER_B) return ACCOUNTS.B;
  return null;
}

function ownerOfSession(proc: Proc): string | null {
  const session = proc.auth.useAuthStore.getState().session;
  if (!session) return null;
  if (session.provider === 'guest') return GUEST_DATA_OWNER;
  return session.canonicalAppUserId
    ? canonicalDataOwner(session.canonicalAppUserId)
    : SIGNED_OUT_DATA_OWNER;
}

async function runIteration(schedule: StressSchedule): Promise<IterationRow> {
  const wallStart = jest.getRealSystemTime();
  const { world, steps } = schedule;
  jest.setSystemTime(new Date(T0));
  const violations: Violation[] = [];
  const trace: string[] = [];
  const consoleErrors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(arg => String(arg))
          .join(' ')
          .slice(0, 300),
      );
    });

  // ── Persisted world (survives kills): SQLite seam + Keychain seam.
  let proc: Proc | null = null;
  const ownerNow = () => proc?.scope.getActiveDataOwner() ?? 'no-process';
  const db = new GatedLocalDb(ownerNow);
  mockDb.current = db;
  let holdArmed = world.shotsHold;
  db.latency = kind => {
    switch (kind) {
      case 'kv-get':
        return world.dbLatency.kvGet;
      case 'kv-set':
        return world.dbLatency.kvSet;
      case 'shots':
        if (holdArmed) {
          holdArmed = false;
          return Infinity;
        }
        return world.dbLatency.shots;
      default:
        return 0;
    }
  };
  seedShots(db, OWNER_A, world.shotsA);
  seedShots(db, OWNER_B, world.shotsB);
  seedShots(db, GUEST_DATA_OWNER, world.shotsGuest);
  db.kv.set(`profile:${OWNER_A}`, JSON.stringify(PROFILE));
  db.kv.set(`profile:${OWNER_B}`, JSON.stringify(PROFILE));
  db.kv.set(`profile:${GUEST_DATA_OWNER}`, JSON.stringify(PROFILE));
  db.kv.set('walkthrough.device-complete', JSON.stringify({ version: 1 }));
  const shotsBefore = db.shotFingerprint();

  mockKeychain.store.clear();
  const api = new ScriptedApi(API_BASE, ownerNow);
  api.addAccount(ACCOUNTS.A);
  api.addAccount(ACCOUNTS.B);
  api.progressMode = world.progressMode;
  api.rankMode = world.rankMode;
  api.latencyMs = world.apiLatencyMs;
  api.bearerTtlSec = world.bearerTtlSec;
  if (world.start === 'persisted-A-slow-refresh') api.refreshLatencyMs = 6_000;
  if (world.start === 'persisted-A-hung-refresh') api.refreshLatencyMs = 60_000;
  (globalThis as { fetch: unknown }).fetch = api.fetch;
  mockScheduler.current = new FakeScheduler();

  if (world.start.startsWith('persisted-A')) {
    api.seedRefreshToken(ACCOUNTS.A.id, 'refresh-seeded-A');
    mockKeychain.store.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify({
        version: 1,
        provider: 'google',
        canonicalAppUserId: ACCOUNTS.A.id,
        refreshToken: 'refresh-seeded-A',
        email: ACCOUNTS.A.email,
        displayName: 'A Player',
      }),
    });
  } else if (world.start === 'guest') {
    db.kv.set('auth.local-mode', JSON.stringify({ version: 1, mode: 'guest' }));
  }

  appStateCurrent = 'active';
  const firstGeneration = processGeneration;

  let renderer: ReactTestRenderer | null = null;
  let kills = 0;
  let killedStatements = 0;
  let killedRequests = 0;
  let pushed = false;
  let faulted = false;
  let lastRevokeAt: number | null = null;

  const act = async (body: () => void | Promise<void>) => {
    if (!proc) throw new Error('no process booted');
    await proc.TR.act(async () => {
      await body();
    });
  };
  const flush = async (ms: number) => {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  };
  const launch = async () => {
    appStateCurrent = 'active';
    proc = bootProcess();
    const p = proc;
    await act(() => {
      renderer = p.TR.create(p.React.createElement(p.App));
    });
    await flush(0);
  };
  const unmountTree = async () => {
    if (!renderer) return;
    const r = renderer;
    await act(() => {
      r.unmount();
    });
    renderer = null;
  };
  /** The OS kills the process: tree, singletons and every pending timer die;
   * in-flight statements/requests never settle. Keychain + SQLite survive. */
  let ceremoniesDismissed = 0;
  const kill = async () => {
    kills += 1;
    await unmountTree();
    killedStatements += db.kill();
    killedRequests += api.kill();
    dropAllTimers();
    proc = null;
    pushed = false;
    holdArmed = world.shotsHold;
  };

  const check = (stepIndex: number, snap: RenderSnapshot) => {
    if (!proc) return;
    const owner = proc.scope.getActiveDataOwner();
    const sessionOwner = ownerOfSession(proc);
    // I5 no-crash
    if (snap.screen === 'crash') {
      violations.push({
        invariant: 'I5 no-crash',
        step: stepIndex,
        detail: 'RootErrorBoundary rendered',
      });
    }
    // I1 owner-render
    if (snap.screen === 'home') {
      const signature = OWNER_SIGNATURE[owner];
      if (!signature) {
        violations.push({
          invariant: 'I1 owner-render',
          step: stepIndex,
          detail: `Home visible while active owner is ${owner}`,
        });
      } else {
        const foreign = snap.recentTypes.filter(
          type => type !== signature.shotType,
        );
        if (foreign.length) {
          violations.push({
            invariant: 'I1 owner-render',
            step: stepIndex,
            detail: `owner ${owner} sees reads of type ${foreign.join(',')} (theirs: ${signature.shotType})`,
          });
        }
        if (snap.rankTier && snap.rankTier !== signature.tier) {
          violations.push({
            invariant: 'I1 owner-render',
            step: stepIndex,
            detail: `owner ${owner} sees rank tier ${snap.rankTier} rating ${snap.rankRating} (theirs: ${signature.tier})`,
          });
        }
        if (sessionOwner !== owner) {
          violations.push({
            invariant: 'I1 owner-render',
            step: stepIndex,
            detail: `Home visible with session owner ${sessionOwner} but active owner ${owner}`,
          });
        }
      }
    }
    // I4 celebration
    const celebration = proc.rank.useRankCelebrationStore.getState().current;
    if (celebration) {
      const signature = OWNER_SIGNATURE[owner];
      const tier = tierForRating(celebration.summary.rating);
      if (!signature || tier !== signature.tier) {
        violations.push({
          invariant: 'I4 celebration',
          step: stepIndex,
          detail: `rank-up ceremony for tier ${tier} (rating ${celebration.summary.rating}) shown while active owner is ${owner}`,
        });
      }
    }
  };

  const press = async (node: ReactTestInstance | null) => {
    if (!node) return false;
    await act(() => {
      node.props['onPress']();
    });
    return true;
  };

  /** Auth actions only where the real UI offers them: sign-out needs a
   * signed-in, hydrated, idle store (Settings); sign-in needs Welcome. */
  const authUi = () => {
    if (!proc) return { canSignOut: false, canSignIn: false };
    const state = proc.auth.useAuthStore.getState();
    return {
      canSignOut: state.hydrated && state.session !== null && !state.busy,
      canSignIn: state.hydrated && state.session === null && !state.busy,
    };
  };

  /** The rank ceremony is a root Modal: on device it blocks every touch
   * until tapped away, so before each user interaction the harness dismisses
   * a ceremony that legitimately belongs to the active owner (I4 still flags
   * one that does not). */
  const dismissOwnCelebration = async () => {
    if (!proc) return;
    const p = proc;
    const celebration = p.rank.useRankCelebrationStore.getState().current;
    if (!celebration) return;
    const signature = OWNER_SIGNATURE[p.scope.getActiveDataOwner()];
    if (!signature) return;
    if (tierForRating(celebration.summary.rating) !== signature.tier) return;
    ceremoniesDismissed += 1;
    await act(() => {
      p.rank.useRankCelebrationStore.getState().dismiss();
    });
  };

  const run = async (step: StressStep, index: number) => {
    let note = '';
    await dismissOwnCelebration();
    switch (step.kind) {
      case 'advance':
        if (proc) await flush(step.ms);
        else jest.setSystemTime(Date.now() + step.ms);
        break;
      case 'settle': {
        if (!proc) break;
        let waited = 0;
        for (;;) {
          const screen = snapshot(proc, renderer).screen;
          const busy = proc.auth.useAuthStore.getState().busy;
          if (!busy && screen !== 'gate-loading' && screen !== 'home-loading') {
            break;
          }
          if (waited >= step.maxMs) {
            note = `still-${screen}`;
            break;
          }
          await flush(250);
          waited += 250;
        }
        break;
      }
      case 'background':
        if (!proc) break;
        await act(() => {
          dispatchAppState(proc!, 'background');
        });
        break;
      case 'foreground':
        if (!proc) break;
        await act(() => {
          dispatchAppState(proc!, 'active');
        });
        break;
      case 'tab': {
        if (!renderer) break;
        if (!(await press(findByLabel(renderer, label => label === step.tab))))
          note = 'no-tab';
        break;
      }
      case 'pushStreak': {
        if (!renderer) break;
        const target = findByLabel(renderer, label =>
          /training streak\. Opens the consistency calendar/.test(label),
        );
        if (await press(target)) pushed = true;
        else note = 'no-badge';
        break;
      }
      case 'back': {
        if (!renderer) break;
        const backButton = pushed
          ? findByLabel(renderer, label => label === 'Back')
          : null;
        if (!(await press(backButton))) note = 'no-back-ui';
        pushed = false;
        break;
      }
      case 'pullRefresh': {
        if (!renderer) break;
        const control = renderer.root.findAll(
          node =>
            typeof node.props['onRefresh'] === 'function' &&
            node.props['refreshing'] !== undefined,
        )[0];
        if (control) {
          await act(() => {
            control.props['onRefresh']();
          });
        } else note = 'no-refresh-control';
        break;
      }
      case 'kill':
        if (proc) await kill();
        else note = 'already-dead';
        break;
      case 'relaunch':
        if (!proc) await launch();
        else note = 'already-running';
        break;
      case 'rotateNow':
        if (!proc) break;
        await act(() => {
          proc!.keeper.refreshSessionNow();
        });
        break;
      case 'serverRevoke': {
        const account = accountForOwner(ownerNow());
        if (account) {
          api.revokeAccount(account.id);
          lastRevokeAt = Date.now();
        } else note = 'nobody-to-revoke';
        break;
      }
      case 'signOut':
        if (authUi().canSignOut) {
          await act(() => {
            void proc!.auth.useAuthStore.getState().signOut();
          });
          pushed = false;
        } else note = 'no-sign-out-ui';
        break;
      case 'signIn':
        if (authUi().canSignIn) {
          mockGoogle.nextIdToken = ACCOUNTS[step.account].idToken;
          mockGoogle.nextEmail = ACCOUNTS[step.account].email;
          await act(() => {
            void proc!.auth.useAuthStore.getState().signInWithGoogle();
          });
        } else note = 'no-sign-in-ui';
        break;
      case 'switchAccount':
        if (authUi().canSignOut) {
          await act(() => {
            void proc!.auth.useAuthStore.getState().signOut();
          });
          pushed = false;
          // Sign-out clears the session synchronously and Welcome is already
          // on screen while its async clean-up (Keychain, server revoke)
          // still runs: the fastest possible user re-entry.
          if (authUi().canSignIn) {
            mockGoogle.nextIdToken = ACCOUNTS[step.to].idToken;
            mockGoogle.nextEmail = ACCOUNTS[step.to].email;
            await act(() => {
              void proc!.auth.useAuthStore.getState().signInWithGoogle();
            });
          } else note = 'sign-out-only';
        } else note = 'no-sign-out-ui';
        break;
      case 'permission':
        mockScheduler.current.permission = step.state;
        break;
      case 'releaseDb':
        if (proc) {
          await act(() => {
            db.releaseHeld();
          });
        } else db.releaseHeld();
        break;
      case 'dbFault':
        faulted = step.on;
        db.faults = { shotsThrow: step.on };
        break;
      case 'pressRetry': {
        if (!renderer) break;
        if (
          !(await press(findByLabel(renderer, label => label === 'Try again')))
        )
          note = 'no-retry-ui';
        break;
      }
    }
    if (proc) await flush(0);
    const snap = snapshot(proc ?? ({} as Proc), proc ? renderer : null);
    const auth = proc?.auth.useAuthStore.getState();
    trace.push(
      `${index} ${describeStep(step)}${note ? ` [${note}]` : ''} @+${Date.now() - T0}ms proc${proc ? proc.gen - firstGeneration : '-'} screen=${snap.screen} session=${proc ? (ownerOfSession(proc)?.slice(0, 8) ?? 'none') : '-'} owner=${ownerNow().slice(0, 8)} busy=${auth?.busy ?? '-'} hydrated=${auth?.hydrated ?? '-'} req=${api.requests.length} keychain=${mockKeychain.store.has(SESSION_VAULT_SERVICE)}`,
    );
    check(index, snap);
  };

  await launch();
  check(-1, snapshot(proc!, renderer));
  for (let i = 0; i < steps.length; i += 1) {
    await run(steps[i]!, i);
  }

  // ── Settle: let every timeout, retry and held read drain.
  if (!proc) await launch();
  holdArmed = false;
  db.releaseHeld();
  if (faulted) {
    db.faults = {};
    faulted = false;
  }
  for (let i = 0; i < 6; i += 1) await flush(5_000);
  await flush(70_000);
  // A Home left in the error state by a fault that has since cleared must
  // recover through its own retry affordance.
  if (renderer && snapshot(proc!, renderer).screen === 'home-error') {
    await press(findByLabel(renderer, label => label === 'Try again'));
    await flush(20_000);
  }
  // I8: a foreground after the last permission flip must reconcile.
  await act(() => {
    dispatchAppState(proc!, 'background');
  });
  await flush(10);
  await act(() => {
    dispatchAppState(proc!, 'active');
  });
  await flush(2_000);

  const settledProc = proc!;
  const finalSnapshot = snapshot(settledProc, renderer);
  const settledStep = steps.length;
  const pendingAtSettle = [
    ...db.statements
      .filter(s => s.outcome === 'pending')
      .map(
        s =>
          `db#${s.seq} ${s.kind} proc${s.proc} +${s.issuedAt - T0}ms owner=${s.ownerAtIssue}`,
      ),
    ...api.requests
      .filter(r => r.outcome === 'pending')
      .map(
        r =>
          `api#${r.seq} ${r.path} proc${r.proc} +${r.at - T0}ms owner=${r.ownerAtRequest}`,
      ),
  ];
  check(settledStep, finalSnapshot);
  const finalOwner = ownerNow();
  const finalSession = ownerOfSession(settledProc);
  trace.push(
    `settled @+${Date.now() - T0}ms ${describeConsistency(settledProc)}`,
  );

  // I7 settles
  const revokedPending = lastRevokeAt !== null && finalSession !== null;
  if (finalSession !== null && finalSession !== SIGNED_OUT_DATA_OWNER) {
    if (finalSnapshot.screen !== 'home' && !pushed && !revokedPending) {
      // A pushed StreakCalendar or a foreign tab legitimately hides Home; the
      // schedule model does not track tab focus after relaunch, so only the
      // loading/error states are violations.
      if (
        finalSnapshot.screen === 'home-loading' ||
        finalSnapshot.screen === 'home-error' ||
        finalSnapshot.screen === 'gate-loading'
      ) {
        violations.push({
          invariant: 'I7 settles',
          step: settledStep,
          detail: `signed in as ${finalSession} but screen is ${finalSnapshot.screen} after settle`,
        });
      }
    }
  }
  // I8 permission
  if (finalSession !== null) {
    const stored =
      settledProc.notifications.useNotificationStore.getState().permission;
    if (stored !== mockScheduler.current.permission) {
      violations.push({
        invariant: 'I8 permission',
        step: settledStep,
        detail: `store permission ${stored} but system is ${mockScheduler.current.permission}`,
      });
    }
  }
  // I2 owner-request / I3 fresh-bearer
  for (const request of api.requests) {
    if (request.path !== '/v1/progress' && request.path !== '/v1/rank')
      continue;
    const expected = accountForOwner(request.ownerAtRequest);
    if (!expected || request.bearerAccount !== expected.id) {
      violations.push({
        invariant: 'I2 owner-request',
        step: settledStep,
        detail: `${request.path} #${request.seq} at +${request.at - T0}ms carried bearer of ${request.bearerAccount?.slice(0, 8) ?? 'nobody'} while active owner was ${request.ownerAtRequest}`,
      });
    }
    if (request.bearer && !request.bearerCurrent && request.bearerAccount) {
      const superseded = api.supersededAt(request.bearer);
      const grace = (api.refreshLatencyMs ?? api.latencyMs) + 250;
      if (superseded !== null && request.at - superseded > grace) {
        violations.push({
          invariant: 'I3 fresh-bearer',
          step: settledStep,
          detail: `${request.path} #${request.seq} used bearer ${request.bearer} ${request.at - superseded}ms after it was rotated away`,
        });
      }
    }
  }
  // I6 no-data-loss
  if (db.shotFingerprint() !== shotsBefore) {
    violations.push({
      invariant: 'I6 no-data-loss',
      step: settledStep,
      detail: 'local_shot rows changed during the run',
    });
  }
  const destructive = db.destructiveStatements();
  if (destructive.length) {
    violations.push({
      invariant: 'I6 no-data-loss',
      step: settledStep,
      detail: `destructive SQL issued: ${destructive.slice(0, 3).join(' | ')}`,
    });
  }

  // I9 idempotent re-hydrate: a clean relaunch of the persisted state must
  // render the same Home the interrupted run converged to.
  await kill();
  holdArmed = false;
  const requestsBeforeReference = api.requests.length;
  await launch();
  await flush(20_000);
  await flush(70_000);
  const referenceProc = proc!;
  const reference = snapshot(referenceProc, renderer);
  trace.push(
    `reference @+${Date.now() - T0}ms ${describeConsistency(referenceProc)}`,
  );
  const comparable = (snap: RenderSnapshot) => ({
    screen: snap.screen,
    recentTypes: snap.recentTypes,
    rankTier: snap.rankTier,
  });
  if (
    !revokedPending &&
    finalSnapshot.screen === 'home' &&
    JSON.stringify(comparable(finalSnapshot)) !==
      JSON.stringify(comparable(reference))
  ) {
    violations.push({
      invariant: 'I9 idempotent',
      step: settledStep,
      detail: `converged ${JSON.stringify(comparable(finalSnapshot))} but a clean relaunch renders ${JSON.stringify(comparable(reference))}`,
    });
  }
  const referenceRequests = api.requests.slice(requestsBeforeReference);
  for (const request of referenceRequests) {
    if (request.path !== '/v1/progress' && request.path !== '/v1/rank')
      continue;
    const expected = accountForOwner(request.ownerAtRequest);
    if (!expected || request.bearerAccount !== expected.id) {
      violations.push({
        invariant: 'I2 owner-request',
        step: settledStep + 1,
        detail: `(reference launch) ${request.path} #${request.seq} carried bearer of ${request.bearerAccount?.slice(0, 8) ?? 'nobody'} while active owner was ${request.ownerAtRequest}`,
      });
    }
  }

  // I10 no-leak: unmount the tree; then the process singletons stop (as
  // sign-out would stop them) and nothing may remain 15 minutes later.
  const referenceSession = ownerOfSession(referenceProc);
  await unmountTree();
  const listenersAfterUnmount = referenceProc.listeners.size;
  const signedInSynced =
    referenceSession === OWNER_A || referenceSession === OWNER_B;
  const allowedAfterUnmount = signedInSynced ? 2 : 0;
  if (listenersAfterUnmount > allowedAfterUnmount) {
    violations.push({
      invariant: 'I10 no-leak',
      step: settledStep + 1,
      detail: `${listenersAfterUnmount} AppState listeners survive the tree unmount (allowed ${allowedAfterUnmount}: session keeper + sync runtime while signed in)`,
    });
  }
  referenceProc.keeper.stopSessionKeeper();
  referenceProc.sync.clearSyncRuntime();
  await flush(15 * 60_000);
  const timersAfterTeardown = jest.getTimerCount();
  const listenersAfterTeardown = referenceProc.listeners.size;
  if (timersAfterTeardown !== 0 || listenersAfterTeardown !== 0) {
    violations.push({
      invariant: 'I10 no-leak',
      step: settledStep + 1,
      detail: `${timersAfterTeardown} timers and ${listenersAfterTeardown} AppState listeners alive 15 minutes after teardown`,
    });
  }
  // Iteration boundary: this process is gone too.
  killedStatements += db.kill();
  killedRequests += api.kill();
  dropAllTimers();
  proc = null;

  errorSpy.mockRestore();
  const requestsByRoute: Record<string, number> = {};
  for (const request of api.requests) {
    requestsByRoute[request.path] = (requestsByRoute[request.path] ?? 0) + 1;
  }
  return {
    seed: schedule.seed,
    world,
    steps: steps.map(describeStep),
    outcome: violations.length ? 'fail' : 'pass',
    violations,
    trace,
    observed: {
      final: finalSnapshot,
      reference,
      finalOwner,
      finalSession,
      requests: api.requests.length,
      requestsByRoute,
      unexpectedRoutes: [...new Set(api.unexpected)],
      statements: db.statements.length,
      pendingAtSettle,
      killedStatements,
      killedRequests,
      rotations: api.rotations.length,
      kills,
      ceremoniesDismissed,
      processes: processGeneration - firstGeneration,
      timersAfterTeardown,
      listenersAfterUnmount,
      listenersAfterTeardown,
      consoleErrors: [...new Set(consoleErrors)].slice(0, 5),
      wallMs: Math.round(jest.getRealSystemTime() - wallStart),
    },
  };
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const ONLY_SEED = process.env['STRESS_SEED']
  ? Number(process.env['STRESS_SEED'])
  : null;
const ITERATIONS =
  ONLY_SEED !== null ? 1 : Number(process.env['STRESS_ITER'] ?? 10);
const FIRST_SEED = Number(process.env['STRESS_FIRST_SEED'] ?? 1);
const SCHEDULE_FILE = process.env['STRESS_SCHEDULE'] ?? null;
const SEED_LIST = process.env['STRESS_SEEDS']
  ? process.env['STRESS_SEEDS'].split(',').map(Number)
  : null;
const REPEAT = Number(process.env['STRESS_REPEAT'] ?? 1);
const OUT_PATH =
  process.env['STRESS_OUT'] ??
  path.join(
    __dirname,
    '..',
    '..',
    'artifacts',
    'stress',
    'homescreen-lifecycle.json',
  );

jest.setTimeout(30 * 60_000);

describe('stress: HomeScreen lifecycle interruption (seeded)', () => {
  beforeAll(() => {
    jest.useFakeTimers();
  });
  afterAll(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('holds every lifecycle invariant across the seeded interleavings', async () => {
    const seeds =
      SEED_LIST ??
      (ONLY_SEED !== null
        ? [ONLY_SEED]
        : Array.from({ length: ITERATIONS }, (_, i) => FIRST_SEED + i));
    const once: StressSchedule[] = SCHEDULE_FILE
      ? (JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')) as StressSchedule[])
      : seeds.map(generateSchedule);
    const schedules = Array.from({ length: REPEAT }, () => once).flat();
    const rows: IterationRow[] = [];
    for (const schedule of schedules) {
      rows.push(await runIteration(schedule));
    }
    const failed = rows.filter(row => row.outcome === 'fail');
    const byInvariant: Record<string, number> = {};
    for (const row of failed) {
      for (const violation of row.violations) {
        byInvariant[violation.invariant] =
          (byInvariant[violation.invariant] ?? 0) + 1;
      }
    }
    const stepKinds: Record<string, number> = {};
    for (const row of rows) {
      for (const step of row.steps) {
        const kind = step.replace(/\(.*$/, '');
        stepKinds[kind] = (stepKinds[kind] ?? 0) + 1;
      }
    }
    const report = {
      unit: 'scr-homescreen',
      lens: 'lifecycle',
      generatedAt: new Date(jest.getRealSystemTime()).toISOString(),
      iterations: rows.length,
      passed: rows.length - failed.length,
      failed: failed.length,
      failingSeeds: failed.map(row => row.seed),
      violationsByInvariant: byInvariant,
      stepKinds,
      totalRequests: rows.reduce((sum, row) => sum + row.observed.requests, 0),
      totalStatements: rows.reduce(
        (sum, row) => sum + row.observed.statements,
        0,
      ),
      totalKills: rows.reduce((sum, row) => sum + row.observed.kills, 0),
      totalProcesses: rows.reduce(
        (sum, row) => sum + row.observed.processes,
        0,
      ),
      totalRotations: rows.reduce(
        (sum, row) => sum + row.observed.rotations,
        0,
      ),
      wallMs: rows.reduce((sum, row) => sum + row.observed.wallMs, 0),
      rows,
    };
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
    expect({
      failingSeeds: report.failingSeeds,
      violationsByInvariant: byInvariant,
    }).toEqual({ failingSeeds: [], violationsByInvariant: {} });
  });
});
