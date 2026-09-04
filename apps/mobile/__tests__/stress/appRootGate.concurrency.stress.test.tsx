/**
 * STRESS (lens: concurrency) — App.tsx root Gate + RootErrorBoundary.
 *
 * Drives the REAL App tree with the REAL appStore and authStore (durable
 * session vault, session keeper, data-owner scope). Every asynchronous seam
 * the launch path crosses — SQLite kv, the Keychain vault, fetch (refresh /
 * logout / bootstrap / me) — is routed through a seeded scheduler that fires
 * pending I/O in a random, seed-replayable order while extra actors are
 * injected between steps: duplicate hydrate() calls (call-during-call),
 * background/foreground flips, sign-out during a restore, error-boundary
 * crash → "Try again" remounts, concurrent sign-in taps, and clock skew.
 *
 * After every interleaving the tree must converge to a coherent state within
 * a bounded number of steps (no deadlock / no stuck loading), the rendered
 * screen must match the stores, the data owner must match the session, the
 * durable state (vault + kv) must match the in-memory session, the one-use
 * Apple authorization code must be spent at most once, and the stability SLO
 * must see exactly the crashes the scenario deliberately raised.
 *
 * Scale: `STRESS_ITER` iterations per family (default small so the suite
 * stays fast); `STRESS_SEED` fixes the campaign's base seed; `STRESS_ONLY`
 * replays one seed; `STRESS_ORDER` pins the completion order
 * (random | lane_fifo | fifo); `STRESS_OUT` writes the seed → outcome JSON
 * table. Replay one campaign seed:
 *   STRESS_ONLY=<seed> npx jest __tests__/stress/appRootGate.concurrency.stress.test.tsx -t "seed <seed> "
 */
import React from 'react';
import { AppState, NativeModules, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';
import { focusForGoal, type Profile } from '../../src/state/profile';

// The mobile tsconfig has no Node types (matches flow-app-store-compliance).
declare const process: { env: Record<string, string | undefined> };
const { writeFileSync } = jest.requireActual<{
  writeFileSync: (path: string, data: string) => void;
}>('fs');

// ─── Seeded RNG + scheduler ──────────────────────────────────────────────────

/** mulberry32: small, fast, and identical on every platform. */
class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
}

/** The native queue an operation completes on. */
type Lane = 'sqlite' | 'keychain' | 'network' | 'native';

/**
 * `random`: any pending completion may land next (adversarial, includes
 * reorders within one native queue). `lane_fifo`: each native queue
 * completes in issue order but queues interleave freely (iOS-realistic:
 * RN module method queues and the SQLite connection are serial). `fifo`:
 * everything completes in issue order (the "natural" schedule).
 */
type Order = 'random' | 'lane_fifo' | 'fifo';

interface PendingOp {
  label: string;
  lane: Lane;
  fire: () => void;
}

/** Every async seam parks here; the campaign decides the completion order. */
class Scheduler {
  private queue: PendingOp[] = [];
  readonly trace: string[] = [];

  defer<T>(lane: Lane, label: string, produce: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        label,
        lane,
        fire: () => {
          try {
            resolve(produce());
          } catch (error) {
            reject(error);
          }
        },
      });
    });
  }

  get size(): number {
    return this.queue.length;
  }

  fireNext(rng: SeededRng, order: Order): void {
    let index: number;
    if (order === 'fifo') {
      index = 0;
    } else if (order === 'lane_fifo') {
      const lanes = [...new Set(this.queue.map(op => op.lane))];
      const lane = rng.pick(lanes);
      index = this.queue.findIndex(op => op.lane === lane);
    } else {
      index = rng.int(this.queue.length);
    }
    const [op] = this.queue.splice(index, 1);
    if (!op) return;
    this.trace.push(op.label);
    op.fire();
  }

  reset(): void {
    this.queue = [];
    this.trace.length = 0;
  }
}

const mockSched = new Scheduler();

// ─── Module seams (all scheduler-driven) ─────────────────────────────────────

jest.mock('react-native-safe-area-context', () => {
  const R = require('react');
  const { View } = require('react-native');
  const Passthrough = (props: { children?: React.ReactNode }) =>
    R.createElement(View, null, props.children);
  return {
    SafeAreaProvider: Passthrough,
    SafeAreaView: Passthrough,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

jest.mock('react-native-svg', () => {
  const R = require('react');
  const { View } = require('react-native');
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
    G: Mock,
    Ellipse: Mock,
  };
});

const mockKv = new Map<string, string>();
const mockKvWrites: string[] = [];
function mockDb(): LocalDb {
  return {
    execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      const key = String(params[0]);
      if (statement.startsWith('SELECT value FROM kv')) {
        return mockSched.defer('sqlite', `kv.get ${key}`, () => {
          const value = mockKv.get(key);
          return { rows: value === undefined ? [] : [{ value }] };
        });
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        return mockSched.defer('sqlite', `kv.set ${key}`, () => {
          mockKv.set(key, String(params[1]));
          mockKvWrites.push(key);
          return { rows: [] };
        });
      }
      return mockSched.defer('sqlite', `db ${statement.slice(0, 24)}`, () => ({
        rows: [],
      }));
    },
    close() {},
  };
}
jest.mock('../../src/data/db', () => ({ getDb: () => mockDb() }));

const mockVault = new Map<string, { username: string; password: string }>();
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AfterFirstUnlockThisDeviceOnly',
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WhenUnlockedThisDeviceOnly',
  },
  setGenericPassword: (
    username: string,
    password: string,
    options: { service?: string } = {},
  ) =>
    mockSched.defer('keychain', 'keychain.set', () => {
      mockVault.set(options.service ?? '__default__', { username, password });
      return { service: options.service ?? '__default__', storage: 'mock' };
    }),
  getGenericPassword: (options: { service?: string } = {}) =>
    mockSched.defer('keychain', 'keychain.get', () => {
      const item = mockVault.get(options.service ?? '__default__');
      return item
        ? {
            service: options.service ?? '__default__',
            storage: 'mock',
            username: item.username,
            password: item.password,
          }
        : false;
    }),
  resetGenericPassword: (options: { service?: string } = {}) =>
    mockSched.defer('keychain', 'keychain.reset', () =>
      mockVault.delete(options.service ?? '__default__'),
    ),
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(async () => true),
    signIn: jest.fn(),
    signInSilently: jest.fn(async () => ({
      type: 'noSavedCredentialFound',
      data: null,
    })),
    hasPreviousSignIn: jest.fn(() => false),
    signOut: jest.fn(async () => null),
    revokeAccess: jest.fn(async () => null),
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

// Leaves outside this unit: markers only, with the Gate's callbacks exposed.
const mockNavigator = { throwOnRender: false, renders: 0 };
jest.mock('../../src/navigation/RootNavigator', () => {
  const R = require('react');
  const { Text: T } = require('react-native');
  return {
    RootNavigator: () => {
      mockNavigator.renders += 1;
      if (mockNavigator.throwOnRender) {
        throw new Error('stress: RootNavigator render failure');
      }
      return R.createElement(T, null, 'ROOT_NAVIGATOR');
    },
  };
});
jest.mock('../../src/screens/OnboardingScreen', () => {
  const R = require('react');
  const { Text: T } = require('react-native');
  return {
    OnboardingScreen: (props: { mode?: string }) =>
      R.createElement(
        T,
        null,
        props.mode === 'preauth' ? 'ONBOARDING_PREAUTH' : 'ONBOARDING_ACCOUNT',
      ),
  };
});
jest.mock('../../src/screens/WelcomeScreen', () => {
  const R = require('react');
  const { Text: T } = require('react-native');
  return { WelcomeScreen: () => R.createElement(T, null, 'WELCOME') };
});
jest.mock('../../src/screens/SignInScreen', () => {
  const R = require('react');
  const { Text: T } = require('react-native');
  return { SignInScreen: () => R.createElement(T, null, 'SIGNIN') };
});
jest.mock('../../src/screens/SplashScreen', () => {
  const R = require('react');
  const { Text: T } = require('react-native');
  return {
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) => {
      R.useEffect(() => {
        if (props.ready) props.onFinished();
      }, [props.ready, props.onFinished]);
      return R.createElement(T, null, 'SPLASH');
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
jest.mock('../../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: async () => {} };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../src/notifications/useNotificationBootstrap', () => ({
  useNotificationBootstrap: () => {},
}));
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

import App from '../../App';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CANONICAL_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const CANONICAL_OWNER = canonicalDataOwner(CANONICAL_ID);
const LOCAL_GUEST_VALUE = JSON.stringify({ version: 1, mode: 'guest' });

const storedProfile: Profile = {
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'dinks',
  biggestProblem: 'popups',
  focusCheckpoint: focusForGoal('dinks'),
};

const serverProfileBody = {
  onboardingState: 'complete',
  profile: {
    skill_level: '3.5',
    handedness: 'right',
    primary_goal: 'dinks',
    biggest_problem: 'popups',
  },
};

/**
 * Refresh-token server model: the current token rotates; the previous token
 * is honoured for a reuse window (Supabase's refresh_token_reuse_interval),
 * returning the pair already issued; anything else is a dead token (401).
 */
interface TokenServer {
  current: string;
  previous: string | null;
  issued: number;
  refreshCalls: number;
  bootstrapCalls: number;
  logoutCalls: number;
  meCalls: number;
  onboardingPuts: number;
  mode: 'ok' | 'server_error' | 'network' | 'revoked';
  me: 'profile' | 'empty' | 'error';
}

let server: TokenServer;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function sessionBody(access: string, refresh: string) {
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function handleFetch(url: string, init?: RequestInit): Response {
  if (url.endsWith('/v1/auth/refresh')) {
    server.refreshCalls += 1;
    if (server.mode === 'network') throw new Error('network down');
    if (server.mode === 'server_error') return jsonResponse({}, 503);
    if (server.mode === 'revoked') return jsonResponse({}, 401);
    const sent = (JSON.parse(String(init?.body)) as { refreshToken: string })
      .refreshToken;
    if (sent === server.current) {
      server.issued += 1;
      server.previous = server.current;
      server.current = `refresh-${server.issued}`;
      return jsonResponse({
        session: sessionBody(`access-${server.issued}`, server.current),
      });
    }
    if (sent === server.previous) {
      return jsonResponse({
        session: sessionBody(`access-${server.issued}`, server.current),
      });
    }
    return jsonResponse({}, 401);
  }
  if (url.endsWith('/v1/auth/logout')) {
    server.logoutCalls += 1;
    return jsonResponse({ ok: true });
  }
  if (url.endsWith('/v1/account/bootstrap')) {
    server.bootstrapCalls += 1;
    server.issued += 1;
    server.previous = null;
    server.current = `refresh-${server.issued}`;
    return jsonResponse({
      user: { id: CANONICAL_ID, email: 'pat@example.com' },
      onboardingState: 'complete',
      session: sessionBody(`access-${server.issued}`, server.current),
    });
  }
  if (url.endsWith('/v1/me/onboarding')) {
    server.onboardingPuts += 1;
    return jsonResponse(serverProfileBody);
  }
  if (url.endsWith('/v1/me')) {
    server.meCalls += 1;
    if (server.me === 'error') return jsonResponse({}, 503);
    return jsonResponse(
      server.me === 'profile' ? serverProfileBody : { profile: null },
    );
  }
  throw new Error(`unrouted ${url}`);
}

function seedVault(refreshToken: string) {
  mockVault.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider: 'apple',
      canonicalAppUserId: CANONICAL_ID,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

function vaultRefreshToken(): string | null {
  const item = mockVault.get(SESSION_VAULT_SERVICE);
  if (!item) return null;
  return (JSON.parse(item.password) as { refreshToken: string }).refreshToken;
}

// ─── Rendering helpers ───────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join('\n');
}

function pressButton(renderer: Renderer, label: string): number {
  const buttons = renderer.root.findAll(
    node =>
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node
        .findAllByType(Text)
        .some(t => String(t.props.children).includes(label)),
  );
  // The innermost host Pressable carries the onPress; outer wrappers repeat it.
  const target = buttons[buttons.length - 1];
  if (!target) return 0;
  target.props.onPress();
  return 1;
}

const appStateHandlers = new Set<(state: string) => void>();
function emitAppState(state: 'background' | 'active') {
  for (const handler of [...appStateHandlers]) handler(state);
}

// ─── Scenario model ──────────────────────────────────────────────────────────

type Family =
  | 'cold_launch_signed_in'
  | 'crash_retry_remount'
  | 'signout_during_restore'
  | 'signin_burst_signed_out';

const FAMILIES: readonly Family[] = [
  'cold_launch_signed_in',
  'crash_retry_remount',
  'signout_during_restore',
  'signin_burst_signed_out',
];

interface ScenarioConfig {
  family: Family;
  order: Order;
  localProfile: boolean;
  refresh: TokenServer['mode'];
  me: TokenServer['me'];
  clockSkewMs: number;
  injectRate: number;
  retryPresses: number;
  signInTaps: number;
  /** Deterministic actors fired once the step counter reaches `atStep`. */
  forced?: ReadonlyArray<{ atStep: number; kind: Injection }>;
}

type Injection =
  'dup_hydrate_app' | 'dup_hydrate_auth' | 'background_active' | 'sign_out';

interface Outcome {
  seed: number;
  config: ScenarioConfig;
  steps: number;
  injections: string[];
  finalText: string;
  server: Pick<
    TokenServer,
    | 'refreshCalls'
    | 'bootstrapCalls'
    | 'logoutCalls'
    | 'meCalls'
    | 'onboardingPuts'
  >;
  crashEvents: number;
  violations: string[];
  outcome: 'held' | 'broken';
  trace?: string[];
}

const SKEWS = [0, 0, -86_400_000, 86_400_000, 30 * 365 * 86_400_000];

const ORDER_OVERRIDE = process.env['STRESS_ORDER'] as Order | undefined;

function planScenario(seed: number, family: Family): ScenarioConfig {
  const rng = new SeededRng(seed ^ 0x9e3779b9);
  return {
    family,
    order: ORDER_OVERRIDE ?? rng.pick(['random', 'lane_fifo', 'lane_fifo']),
    localProfile: rng.chance(0.6),
    refresh: rng.pick(['ok', 'ok', 'ok', 'server_error', 'network', 'revoked']),
    me: rng.pick(['profile', 'profile', 'empty', 'error']),
    clockSkewMs: rng.pick(SKEWS),
    injectRate: rng.pick([0, 0.15, 0.35, 0.6]),
    retryPresses: rng.pick([1, 1, 2]),
    signInTaps: 2 + rng.int(4),
  };
}

const MAX_STEPS = 400;
/** Actors are a finite storm; afterwards the tree must settle on its own. */
const MAX_INJECTIONS = 8;

function desiredOwnerOf(): string | null {
  const auth = useAuthStore.getState();
  if (!auth.hydrated) return null;
  if (auth.session?.provider === 'guest') return GUEST_DATA_OWNER;
  if (auth.session?.canonicalAppUserId) {
    return canonicalDataOwner(auth.session.canonicalAppUserId);
  }
  return SIGNED_OUT_DATA_OWNER;
}

async function inject(kind: Injection): Promise<void> {
  await act(async () => {
    if (kind === 'dup_hydrate_app') void useAppStore.getState().hydrate();
    else if (kind === 'dup_hydrate_auth') {
      void useAuthStore.getState().hydrate();
    } else if (kind === 'background_active') {
      emitAppState('background');
      emitAppState('active');
    } else void useAuthStore.getState().signOut();
    await flush();
  });
}

/** Forced actors not yet fired; consumed by `drain` as the step counter passes. */
let forcedPending: Array<{ atStep: number; kind: Injection }> = [];

/** Fires pending I/O in seeded order, injecting actors between steps. */
async function drain(
  rng: SeededRng,
  order: Order,
  injectRate: number,
  injections: string[],
  steps: { count: number },
  allowSignOut: boolean,
): Promise<void> {
  while (mockSched.size > 0 && steps.count < MAX_STEPS) {
    steps.count += 1;
    await act(async () => {
      mockSched.fireNext(rng, order);
      await flush();
    });
    const due = forcedPending.filter(f => f.atStep <= steps.count);
    forcedPending = forcedPending.filter(f => f.atStep > steps.count);
    for (const f of due) {
      injections.push(`${steps.count}:${f.kind}(forced)`);
      await inject(f.kind);
    }
    if (
      injectRate > 0 &&
      injections.length < MAX_INJECTIONS &&
      rng.chance(injectRate)
    ) {
      const kind = rng.pick<Injection>([
        'dup_hydrate_app',
        'dup_hydrate_auth',
        'background_active',
        ...(allowSignOut ? (['sign_out'] as const) : []),
      ]);
      injections.push(`${steps.count}:${kind}`);
      await inject(kind);
    }
  }
}

/** Lets the ≤ 8s launch-refresh deadline (and nothing longer) elapse. */
async function letShortTimersElapse(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(10_000);
    await flush();
  });
}

function checkInvariants(renderer: Renderer): string[] {
  const violations: string[] = [];
  const text = allText(renderer);
  const auth = useAuthStore.getState();
  const app = useAppStore.getState();
  const desired = desiredOwnerOf();

  if (!auth.hydrated) violations.push('auth never hydrated');
  if (!app.hydrated) violations.push('appStore.hydrated=false at convergence');
  if (desired && app.ownerKey !== desired) {
    violations.push(`appStore.ownerKey=${app.ownerKey} desired=${desired}`);
  }
  if (desired && getActiveDataOwner() !== desired) {
    violations.push(
      `activeDataOwner=${getActiveDataOwner()} desired=${desired}`,
    );
  }
  if (
    text.includes('Loading your account') ||
    text.includes('Getting things ready')
  ) {
    violations.push('stuck on LoadingState after all I/O settled');
  }
  if (text.includes('SPLASH')) violations.push('splash never cleared');

  const session = auth.session;
  const hasProfile = Boolean(app.profile);
  const expectedScreen = !session
    ? 'WELCOME'
    : hasProfile
      ? 'ROOT_NAVIGATOR'
      : app.hydrateError
        ? 'Your coaching profile couldn’t load'
        : 'ONBOARDING_ACCOUNT';
  if (!text.includes(expectedScreen)) {
    violations.push(
      `screen mismatch: expected ${expectedScreen}, got ${text.replace(/\n/g, ' | ')}`,
    );
  }

  if (session && desired && hasProfile) {
    const durable = mockKv.get(profileKeyForOwner(desired));
    if (durable !== JSON.stringify(app.profile)) {
      violations.push(
        'rendered profile is not the durable profile of the owner',
      );
    }
  }

  const apiSession = getApiSession();
  if (!session || session.provider === 'guest') {
    if (apiSession)
      violations.push('ApiSession survives a signed-out/guest session');
    if (vaultRefreshToken())
      violations.push('vault still holds a session for a signed-out user');
  } else {
    if (
      apiSession &&
      apiSession.canonicalAppUserId !== session.canonicalAppUserId
    ) {
      violations.push(
        'ApiSession bound to a different account than the session',
      );
    }
    const vaultToken = vaultRefreshToken();
    if (!vaultToken)
      violations.push('signed-in session lost its durable vault record');
    else if (vaultToken !== server.current && vaultToken !== server.previous) {
      violations.push(
        `vault token ${vaultToken} is dead on the server (current ${server.current})`,
      );
    }
  }
  const guestFlag = mockKv.get('auth.local-mode') === LOCAL_GUEST_VALUE;
  if (guestFlag !== (session?.provider === 'guest')) {
    violations.push(
      `kv guest flag=${guestFlag} but session=${session?.provider ?? 'none'}`,
    );
  }

  if (server.bootstrapCalls > 1) {
    violations.push(`one-use Apple code spent ${server.bootstrapCalls} times`);
  }
  return violations;
}

async function runScenario(
  seed: number,
  family: Family,
  overrides: Partial<ScenarioConfig> = {},
): Promise<Outcome> {
  const config = { ...planScenario(seed, family), ...overrides };
  const { order } = config;
  const rng = new SeededRng(seed);
  const injections: string[] = [];
  const steps = { count: 0 };
  forcedPending = [...(config.forced ?? [])];

  // Fresh world per seed.
  mockSched.reset();
  mockKv.clear();
  mockKvWrites.length = 0;
  mockVault.clear();
  appStateHandlers.clear();
  mockNavigator.throwOnRender = false;
  mockNavigator.renders = 0;
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
  });
  const crashesBefore = stabilitySlo
    .events()
    .filter(e => e.kind === 'crash').length;
  server = {
    current: 'refresh-0',
    previous: null,
    issued: 0,
    refreshCalls: 0,
    bootstrapCalls: 0,
    logoutCalls: 0,
    meCalls: 0,
    onboardingPuts: 0,
    mode: config.refresh,
    me: config.me,
  };
  jest.setSystemTime(
    new Date('2026-09-04T12:00:00Z').getTime() + config.clockSkewMs,
  );

  const signedInLaunch = family !== 'signin_burst_signed_out';
  if (signedInLaunch) {
    seedVault('refresh-0');
    if (config.localProfile) {
      mockKv.set(
        profileKeyForOwner(CANONICAL_OWNER),
        JSON.stringify(storedProfile),
      );
    }
  }

  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
    await flush();
  });
  let deliberateCrashes = 0;

  try {
    // Phase 1: cold launch under the seeded interleaving.
    await drain(
      rng,
      order,
      family === 'cold_launch_signed_in' || family === 'signout_during_restore'
        ? config.injectRate
        : 0,
      injections,
      steps,
      family === 'signout_during_restore',
    );
    if (
      family === 'signout_during_restore' &&
      !injections.some(i => i.includes('sign_out'))
    ) {
      // Guarantee the actor fires at least once, at a seeded point after launch.
      injections.push(`${steps.count}:sign_out(forced)`);
      await act(async () => {
        void useAuthStore.getState().signOut();
        await flush();
      });
      await drain(rng, order, config.injectRate, injections, steps, false);
    }

    // Phase 2: crash the main screen and press "Try again" (remount race).
    if (family === 'crash_retry_remount') {
      await letShortTimersElapse();
      await drain(rng, order, 0, injections, steps, false);
      if (allText(renderer).includes('ROOT_NAVIGATOR')) {
        mockNavigator.throwOnRender = true;
        deliberateCrashes += 1;
        await act(async () => {
          // Any Gate re-render reaches the navigator; a new profile object is
          // the same transition a synced profile update produces.
          const current = useAppStore.getState().profile;
          useAppStore.setState({ profile: current ? { ...current } : current });
          await flush();
        });
        if (!allText(renderer).includes('Something went wrong')) {
          injections.push('boundary-did-not-catch');
        }
        mockNavigator.throwOnRender = false;
        await act(async () => {
          let pressed = 0;
          for (let i = 0; i < config.retryPresses; i += 1) {
            pressed += pressButton(renderer, 'Try again');
          }
          injections.push(`${steps.count}:retry×${pressed}`);
          await flush();
        });
        await drain(rng, order, config.injectRate, injections, steps, true);
      } else {
        injections.push('no-main-screen-to-crash');
      }
    }

    // Phase 3: concurrent sign-in taps from the signed-out landing.
    if (family === 'signin_burst_signed_out') {
      const taps: Promise<void>[] = [];
      await act(async () => {
        for (let i = 0; i < config.signInTaps; i += 1) {
          taps.push(useAuthStore.getState().signInWithApple());
        }
        injections.push(`${steps.count}:signin×${config.signInTaps}`);
        await flush();
      });
      await drain(rng, order, config.injectRate, injections, steps, false);
      await Promise.all(taps);
    }

    // Convergence: the launch-refresh deadline may still be the only thing
    // holding a superseded hydrate open.
    await letShortTimersElapse();
    await drain(rng, order, 0, injections, steps, false);

    const violations = checkInvariants(renderer);
    if (steps.count >= MAX_STEPS)
      violations.push(`no convergence within ${MAX_STEPS} steps`);
    const crashEvents =
      stabilitySlo.events().filter(e => e.kind === 'crash').length -
      crashesBefore;
    if (crashEvents !== deliberateCrashes) {
      violations.push(
        `stability crash events=${crashEvents}, deliberate=${deliberateCrashes}`,
      );
    }
    return {
      seed,
      config,
      steps: steps.count,
      injections,
      finalText: allText(renderer).replace(/\n/g, ' | '),
      server: {
        refreshCalls: server.refreshCalls,
        bootstrapCalls: server.bootstrapCalls,
        logoutCalls: server.logoutCalls,
        meCalls: server.meCalls,
        onboardingPuts: server.onboardingPuts,
      },
      crashEvents,
      violations,
      outcome: violations.length === 0 ? 'held' : 'broken',
      ...(violations.length > 0 ? { trace: [...mockSched.trace] } : {}),
    };
  } finally {
    await act(async () => {
      renderer.unmount();
      await flush();
    });
    stopSessionKeeper();
    clearSyncRuntime();
    clearApiSession();
    mockSched.reset();
  }
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const ITER = Math.max(1, Number(process.env['STRESS_ITER'] ?? 6));
const BASE_SEED = Number(process.env['STRESS_SEED'] ?? 20260904);
const ONLY = process.env['STRESS_ONLY']
  ? Number(process.env['STRESS_ONLY'])
  : null;
const OUT = process.env['STRESS_OUT'];

const outcomes: Outcome[] = [];

beforeAll(() => {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask'],
  });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      const fn = handler as (state: string) => void;
      appStateHandlers.add(fn);
      return { remove: () => appStateHandlers.delete(fn) } as ReturnType<
        typeof AppState.addEventListener
      >;
    });
  globalThis.fetch = ((url: string, init?: RequestInit) =>
    mockSched.defer(
      'network',
      `fetch ${url.replace('https://api.example.test', '')}`,
      () => handleFetch(url, init),
    )) as unknown as typeof fetch;
  (NativeModules as { PickleAuth?: unknown }).PickleAuth = {
    signInWithApple: () =>
      mockSched.defer('native', 'native.signInWithApple', () => ({
        user: 'apple-user-opaque',
        identityToken: 'apple-identity-token',
        authorizationCode: 'one-use-apple-code',
        email: 'pat@privaterelay.example',
        givenName: 'Pat',
        familyName: 'Player',
      })),
  };
});

afterAll(() => {
  jest.useRealTimers();
  delete (NativeModules as { PickleAuth?: unknown }).PickleAuth;
  if (OUT) {
    const held = outcomes.filter(o => o.outcome === 'held').length;
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          suite: 'appRootGate.concurrency',
          baseSeed: BASE_SEED,
          iterationsPerFamily: ITER,
          executed: outcomes.length,
          held,
          broken: outcomes.length - held,
          rows: outcomes,
        },
        null,
        2,
      ),
    );
  }
});

function seedsFor(family: Family): number[] {
  if (ONLY !== null) return [ONLY];
  const familyIndex = FAMILIES.indexOf(family);
  return Array.from(
    { length: ITER },
    (_, i) => BASE_SEED + familyIndex * 100_000 + i,
  );
}

describe.each(FAMILIES)('root Gate concurrency — %s', family => {
  it.each(seedsFor(family))(
    'seed %i converges to a coherent root state',
    async seed => {
      const outcome = await runScenario(seed, family);
      outcomes.push(outcome);
      expect(outcome.violations).toEqual([]);
    },
  );
});

// Minimized, actor-free schedules: no random injections, no clock skew,
// every native queue completing in issue order. Each pins one interleaving
// the campaign reached; the `forced` actor stands in for the second
// `hydrateAuth()` a RootErrorBoundary remount issues (App.tsx mount effect).
const NATURAL = {
  order: 'fifo' as const,
  localProfile: true,
  refresh: 'ok' as const,
  me: 'profile' as const,
  clockSkewMs: 0,
  injectRate: 0,
  retryPresses: 1,
};

describe('root Gate — minimized interleavings', () => {
  it('seed 1: caught render crash + "Try again" remounts a signed-in account onto the main screen', async () => {
    const outcome = await runScenario(1, 'crash_retry_remount', NATURAL);
    outcomes.push(outcome);
    expect(outcome.violations).toEqual([]);
  });

  it('seed 2: hydrateAuth re-entered while one sign-in bootstrap is in flight', async () => {
    const outcome = await runScenario(2, 'signin_burst_signed_out', {
      ...NATURAL,
      signInTaps: 1,
      forced: [{ atStep: 7, kind: 'dup_hydrate_auth' }],
    });
    outcomes.push(outcome);
    expect(outcome.violations).toEqual([]);
  });

  // `random` lets the Keychain lane reorder (reset before an earlier set);
  // this is the one minimized schedule that needs a non-FIFO native queue.
  it('seed 3: signOut lands while the launch refresh is persisting rotated tokens (random Keychain order)', async () => {
    const outcome = await runScenario(3, 'signout_during_restore', {
      ...NATURAL,
      order: 'random',
      forced: [{ atStep: 4, kind: 'sign_out' }],
    });
    outcomes.push(outcome);
    expect(outcome.violations).toEqual([]);
  });
});
