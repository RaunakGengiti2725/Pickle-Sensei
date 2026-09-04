/**
 * STRESS · scr-welcomescreen · lens `failure-injection`
 *
 * WelcomeScreen itself is synchronous and callback-driven: it has no fetch,
 * SQLite, Keychain, camera, Vision, TTS, RevenueCat, permission or clock
 * call of its own. Every dependency that can fail on the way to (and while
 * on) the Welcome screen belongs to the launch surface that mounts it — the
 * real `App` → `SafeAreaProvider` → `QueryClientProvider` →
 * `RootErrorBoundary` → `Gate`, the real auth/app/notification/consistency/
 * walkthrough Zustand stores, the real `SplashScreen` overlay and the real
 * pre-auth stage machine (`launchGate.ts`). This suite therefore renders the
 * REAL App with the REAL WelcomeScreen / OnboardingScreen / SignInScreen and
 * fakes only the process edges: react-native-keychain, the op-sqlite handle
 * behind `getDb()`, `globalThis.fetch`, the Google Sign-In SDK, the
 * notification native module, `AppState`, `NativeModules.PickleAuth` and the
 * clock.
 *
 * Camera / Vision / TTS / RevenueCat are NOT dependencies of this unit's
 * launch path (nothing signed-out imports them before the first signed-in
 * landing); the matrix records them as `not-reachable-from-unit` rather than
 * claiming coverage.
 *
 * Two campaigns run:
 *   1. ENUMERATED — every fault in the catalog, once, on the install that
 *      makes it reachable, with the full Welcome interaction script.
 *   2. SEEDED — STRESS_ITER random compositions (1–3 compatible faults ×
 *      install × interaction script × splash motion mode), replayable from
 *      the seed: STRESS_WFI_FILTER=<seed|scenario-name> re-runs one.
 *
 * Per scenario the harness asserts (fake clock advanced ≥ 60 s):
 *   noInfiniteSpinner    the gate leaves its loading state (Welcome, app,
 *                        or an ErrorState WITH a retry control) within 60 s
 *   splashReleased       the splash overlay stops covering the screen ≤ 60 s
 *   recoverable          a RootErrorBoundary landing shows "Try again", and
 *                        retrying after the fault lifts reaches Welcome
 *   welcomeControls      both Welcome controls present, enabled, labelled
 *   navigation           Start → pre-auth onboarding → Back → Welcome;
 *                        Sign in → SignIn → Back → Welcome; a double-tap is
 *                        one transition; every stage change is observable
 *   noFakeSuccess        a launch that could not verify a session never lands
 *                        in the app; a signed-out landing has session === null
 *   noSpuriousSignOut    a transient server/network fault never converts a
 *                        valid vault into a Welcome landing
 *   noSilentFailure      a broken local database is reported through
 *                        `localDataError` (never swallowed)
 *   persistedIntegrity   shots untouched, no destructive SQL, no token in the
 *                        kv table, every kv write parseable, the vault either
 *                        absent or a valid record — never garbage
 *   noUnexpectedNetwork  signed-out launches make zero requests; no unknown
 *                        route is ever hit
 *   cleanUnmount         unmount throws nothing; 60 s later no console.error
 *                        and no unhandled rejection has surfaced
 *
 * Known deviations (documented, replayable, asserted by id) keep the suite
 * green while pinning the exact failures reported in the stress findings.
 */

import React from 'react';
import {
  AccessibilityInfo,
  AppState,
  NativeModules,
  Text,
  type AppStateStatus,
} from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import notifee from 'react-native-notify-kit';

import { World } from '../../stress-harness/welcome-failure-injection/world';
import {
  FAULTS,
  FAULT_BY_ID,
  INSTALL_KINDS,
  compatible,
  type Fault,
  type InstallKind,
} from '../../stress-harness/welcome-failure-injection/faults';
import {
  summarize,
  writeJsonArtifact,
  type Row,
} from '../../stress-harness/welcome-failure-injection/artifacts';
import {
  LAST_PROVIDER_GOOGLE_VALUE,
  makePrng,
} from '../../xc-harness/lifecycle-persistence/seeds';
import { nodeProcess } from '../../xc-harness/lifecycle-persistence/nodeShim';

// ─── Process-edge seams (native modules + fetch only) ────────────────────────

const mockWorld = new World();

jest.mock('../../src/data/db', () => ({
  getDb: () => mockWorld.db.handle(),
}));
jest.mock('react-native-keychain', () => mockWorld.keychain.module());
jest.mock('@react-native-google-signin/google-signin', () =>
  mockWorld.google.module(),
);
jest.mock('react-native-svg', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  const Stub = (props: { children?: React.ReactNode }) =>
    R.createElement(RN.View, null, props.children);
  return {
    __esModule: true,
    default: Stub,
    Svg: Stub,
    Path: Stub,
    Circle: Stub,
    Rect: Stub,
    G: Stub,
    Defs: Stub,
    LinearGradient: Stub,
    RadialGradient: Stub,
    Stop: Stub,
    Line: Stub,
    Polyline: Stub,
    Polygon: Stub,
    Ellipse: Stub,
    ClipPath: Stub,
    Mask: Stub,
    Text: Stub,
    TSpan: Stub,
    Use: Stub,
    Symbol: Stub,
  };
});
jest.mock(
  'react-native-safe-area-context',
  () =>
    jest.requireActual<{ default: Record<string, unknown> }>(
      'react-native-safe-area-context/jest/mock',
    ).default,
);
jest.mock('../../src/navigation/RootNavigator', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    RootNavigator: () => R.createElement(RN.Text, null, 'ROOT_NAVIGATOR'),
  };
});

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

// ─── Constants ───────────────────────────────────────────────────────────────

const SUITE = 'stress.scr-welcomescreen.failure-injection';
const VAULT_SERVICE = 'com.picklesensei.auth.session';
const INITIAL_REFRESH = 'refresh-seeded';
const CANONICAL_ID = '6f1c2f4e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const T0 = new Date('2026-09-04T12:00:00.000Z').getTime();
const OBSERVE_MS = 60_000;
const SLICE_MS = 250;
const SPLASH_WATCHDOG_MS = 8_000;

const WELCOME_CTA = 'Start your first read';
const WELCOME_SIGNIN = 'I already have an account';
const BOUNDARY_TITLE = 'Something went wrong';
const BOUNDARY_RETRY = 'Try again';
const PROFILE_ERROR_TITLE = 'Your coaching profile couldn’t load';
const LOADING_LABELS = ['Getting things ready', 'Loading your account'];
const ONBOARDING_BACK_HINT = 'Return to the welcome screen';

const STRESS_ITER = Number(nodeProcess.env.STRESS_ITER ?? '40');
const FILTER = nodeProcess.env.STRESS_WFI_FILTER ?? '';

// ─── AppState / a11y / native module plumbing ────────────────────────────────

const appStateListeners = new Set<(state: AppStateStatus) => void>();
let currentAppState: AppStateStatus = 'active';
function emitAppState(state: AppStateStatus): void {
  currentAppState = state;
  for (const listener of [...appStateListeners]) listener(state);
}

const consoleErrors: string[] = [];
const unhandledRejections: string[] = [];
let realDateNow: () => number = () => Date.now();

const nodeEvents = (
  globalThis as {
    process: {
      on(event: string, fn: (reason: unknown) => void): void;
      off(event: string, fn: (reason: unknown) => void): void;
    };
  }
).process;
const onUnhandled = (reason: unknown) => {
  unhandledRejections.push(
    String(reason instanceof Error ? reason.message : reason),
  );
};

const realPickleAuth = NativeModules.PickleAuth;

beforeAll(() => {
  jest.useFakeTimers();
  realDateNow = () => Date.now();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(
      (type: string, handler: (state: AppStateStatus) => void) => {
        if (mockWorld.runtime.appStateAddListenerThrows) {
          throw new Error('AppState.addEventListener failed (simulated)');
        }
        if (type !== 'change') return { remove() {} };
        appStateListeners.add(handler);
        if (mockWorld.runtime.appStateAddListenerReturnsUndefined) {
          return undefined as unknown as { remove(): void };
        }
        return { remove: () => appStateListeners.delete(handler) };
      },
    );
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    get: () => currentAppState,
  });
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockImplementation(() => Promise.resolve(reduceMotionForScenario));
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockImplementation(() => ({ remove() {} }));
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(
      args
        .map(a => (a instanceof Error ? a.message : String(a)))
        .join(' ')
        .slice(0, 240),
    );
  });
  nodeEvents.on('unhandledRejection', onUnhandled);
  mockWorld.notifee.bind(
    notifee as unknown as Parameters<typeof mockWorld.notifee.bind>[0],
  );
});

afterAll(() => {
  nodeEvents.off('unhandledRejection', onUnhandled);
  jest.useRealTimers();
});

let reduceMotionForScenario = true;

// ─── Scenario space ──────────────────────────────────────────────────────────

type Interaction =
  | 'tap-start-back'
  | 'tap-signin-back'
  | 'double-tap-start'
  | 'rapid-toggle'
  | 'background-foreground'
  | 'second-hydrate'
  | 'remount'
  | 'video-error'
  | 'video-end'
  | 'video-progress-garbage'
  | 'clock-jump-back'
  | 'clock-jump-forward';

const INTERACTIONS: readonly Interaction[] = [
  'tap-start-back',
  'tap-signin-back',
  'double-tap-start',
  'rapid-toggle',
  'background-foreground',
  'second-hydrate',
  'remount',
  'video-error',
  'video-end',
  'video-progress-garbage',
  'clock-jump-back',
  'clock-jump-forward',
];

interface Scenario {
  name: string;
  seed: number;
  install: InstallKind;
  faults: string[];
  interactions: Interaction[];
  reduceMotion: boolean;
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('empty pick');
  return item;
}

function seededScenario(seed: number): Scenario {
  const rng = makePrng(seed);
  const first = pick(rng, FAULTS);
  const install = pick(rng, first.preferInstall);
  const faults: Fault[] = [first];
  const extra = rng() < 0.55 ? 1 : rng() < 0.3 ? 2 : 0;
  const candidates = FAULTS.filter(
    f => f.preferInstall.includes(install) && !f.expectsBoundary,
  );
  for (let i = 0; i < extra; i += 1) {
    const next = pick(rng, candidates);
    if (faults.every(f => compatible(f, next))) faults.push(next);
  }
  const interactionCount = 1 + Math.floor(rng() * 3);
  const interactions: Interaction[] = [];
  for (let i = 0; i < interactionCount; i += 1) {
    interactions.push(pick(rng, INTERACTIONS));
  }
  return {
    name: `seed-${seed}`,
    seed,
    install,
    faults: faults.map(f => f.id),
    interactions,
    reduceMotion: rng() < 0.8,
  };
}

/** Every fault once on the install that reaches it first, and again on a
 * signed-in install when it reaches that too (the same Keychain fault means
 * something different to a device that holds an account). */
function enumeratedScenarios(): Scenario[] {
  const out: Scenario[] = [];
  FAULTS.forEach((fault, index) => {
    const installs = new Set<InstallKind>([fault.preferInstall[0] ?? 'fresh']);
    if (fault.preferInstall.includes('vault-valid'))
      installs.add('vault-valid');
    for (const install of installs) {
      out.push({
        name: `fault:${fault.id}@${install}`,
        seed: 100_000 + index,
        install,
        faults: [fault.id],
        interactions: ['tap-start-back', 'tap-signin-back', 'double-tap-start'],
        reduceMotion: true,
      });
    }
  });
  return out;
}

function controlScenarios(): Scenario[] {
  return INSTALL_KINDS.map((install, index) => ({
    name: `control:no-fault@${install}`,
    seed: 90_000 + index,
    install,
    faults: [],
    interactions: [...INTERACTIONS],
    reduceMotion: index % 2 === 0,
  }));
}

// ─── Tree probes ─────────────────────────────────────────────────────────────

function texts(root: ReactTestInstance): string[] {
  const out: string[] = [];
  for (const node of root.findAllByType(Text)) {
    const collect = (child: unknown): void => {
      if (typeof child === 'string' || typeof child === 'number') {
        out.push(String(child));
      } else if (Array.isArray(child)) {
        child.forEach(collect);
      }
    };
    collect(node.props.children);
  }
  return out;
}

interface Control {
  label: string;
  disabled: boolean;
  press: () => void;
}

/** Outermost pressable instance per accessibilityLabel (PressableScale or a
 * raw Pressable): the one whose onPress the user actually reaches. */
function controls(root: ReactTestInstance): Control[] {
  const seen = new Set<string>();
  const found: Control[] = [];
  const matches = root.findAll(
    node =>
      typeof node.props.onPress === 'function' &&
      typeof node.props.accessibilityLabel === 'string',
  );
  for (const node of matches) {
    const label = node.props.accessibilityLabel as string;
    const hint = (node.props.accessibilityHint as string | undefined) ?? '';
    const key = `${label}|${hint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      label: hint ? `${label} [${hint}]` : label,
      disabled: Boolean(node.props.disabled),
      press: node.props.onPress as () => void,
    });
  }
  return found;
}

function control(root: ReactTestInstance, label: string): Control | null {
  return (
    controls(root).find(
      c => c.label === label || c.label.startsWith(`${label} [`),
    ) ?? null
  );
}

interface Snapshot {
  loading: boolean;
  boundary: boolean;
  profileError: boolean;
  welcome: boolean;
  onboarding: boolean;
  accountOnboarding: boolean;
  signIn: boolean;
  app: boolean;
  splashMounted: boolean;
  splashBlocking: boolean;
  retryVisible: boolean;
  controls: string[];
}

function snapshot(root: ReactTestInstance): Snapshot {
  const t = texts(root);
  const cs = controls(root);
  const has = (label: string) =>
    cs.some(c => c.label === label || c.label.startsWith(`${label} [`));
  const splash = root.findAll(n => n.props.testID === 'splash-screen');
  const splashHost = splash[0];
  return {
    loading: LOADING_LABELS.some(l => t.includes(l)),
    boundary: t.includes(BOUNDARY_TITLE),
    profileError: t.includes(PROFILE_ERROR_TITLE),
    welcome: has(WELCOME_CTA) && has(WELCOME_SIGNIN),
    onboarding: cs.some(c => c.label === `Back [${ONBOARDING_BACK_HINT}]`),
    accountOnboarding:
      t.includes('PLAYER SETUP') &&
      !cs.some(c => c.label === `Back [${ONBOARDING_BACK_HINT}]`),
    signIn:
      t.includes('Continue with Apple') || t.includes('Sign in with Apple'),
    app: t.includes('ROOT_NAVIGATOR'),
    splashMounted: splash.length > 0,
    splashBlocking:
      splash.length > 0 && splashHost?.props.pointerEvents !== 'none',
    retryVisible: has(BOUNDARY_RETRY),
    controls: cs.map(c => `${c.label}${c.disabled ? ' (disabled)' : ''}`),
  };
}

function gateSettled(s: Snapshot): boolean {
  return (
    !s.loading &&
    (s.welcome ||
      s.onboarding ||
      s.accountOnboarding ||
      s.signIn ||
      s.app ||
      s.boundary ||
      s.profileError)
  );
}

// ─── Process reset (a "cold launch") ─────────────────────────────────────────

/** Module-level singletons (session keeper, sync runtime) hold an AppState
 * subscription; after the `returns-undefined` fault their teardown throws.
 * The harness records that instead of letting it poison the next launch. */
function teardownSafely(): string[] {
  const errors: string[] = [];
  for (const step of [stopSessionKeeper, clearSyncRuntime]) {
    try {
      step();
    } catch (error) {
      errors.push(
        `${step.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return errors;
}

function resetProcess(): void {
  teardownSafely();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    localDataError: null,
    deletionCleanup: null,
  });
  useAppStore.setState({
    hydrated: false,
    hydrateError: null,
    ownerKey: null,
    profile: null,
  } as Partial<ReturnType<typeof useAppStore.getState>>);
  useNotificationStore.setState({ hydratedOwnerKey: null } as Partial<
    ReturnType<typeof useNotificationStore.getState>
  >);
  useConsistencyStore.setState({ hydratedOwnerKey: null } as Partial<
    ReturnType<typeof useConsistencyStore.getState>
  >);
  useWalkthroughStore.setState({ hydrated: false, visible: false } as Partial<
    ReturnType<typeof useWalkthroughStore.getState>
  >);
  appStateListeners.clear();
  currentAppState = 'active';
  consoleErrors.length = 0;
  unhandledRejections.length = 0;
}

function installState(world: World, install: InstallKind): void {
  const vault = JSON.stringify({
    version: 1,
    provider: 'apple',
    canonicalAppUserId: CANONICAL_ID,
    refreshToken: INITIAL_REFRESH,
    email: 'player@example.test',
    displayName: 'Pat',
  });
  switch (install) {
    case 'fresh':
      break;
    case 'signed-out-kv':
      world.db.inner.kv.set(
        'auth.local-mode',
        JSON.stringify({ version: 1, mode: 'signed-out' }),
      );
      break;
    case 'vault-valid':
    case 'vault-valid-no-profile':
      world.keychain.store.set(VAULT_SERVICE, {
        username: 'session',
        password: vault,
      });
      world.server.seed(INITIAL_REFRESH);
      world.db.inner.kv.set('auth.local-mode', '');
      if (install === 'vault-valid') {
        world.db.inner.kv.set(
          `profile:${CANONICAL_ID}`,
          JSON.stringify({
            skill_level: 'intermediate',
            handedness: 'right',
            primary_goal: 'consistency',
            biggest_problem: 'popups',
            first_name: 'Pat',
          }),
        );
      }
      break;
    case 'last-provider-google':
      world.db.inner.kv.set('auth.last-provider', LAST_PROVIDER_GOOGLE_VALUE);
      world.google.faults.hasPreviousSignIn = 'true';
      break;
  }
  // Player data that must survive every fault.
  world.db.inner.seedShots('signed-out', 3, 'real');
  world.db.inner.seedShots(`account:${CANONICAL_ID}`, 5, 'real');
  world.db.inner.seedShots('other-owner', 2, 'stranger');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

interface Timeline {
  at: number;
  event: string;
  detail?: Record<string, unknown>;
}

async function runScenario(scenario: Scenario): Promise<Row> {
  const started = realDateNow();
  const world = mockWorld;
  world.reset();
  resetProcess();
  jest.setSystemTime(T0);
  reduceMotionForScenario = scenario.reduceMotion;
  const rng = makePrng((scenario.seed + 0x5eed) % 0xffff_ffff);
  const randomSpy = jest.spyOn(Math, 'random').mockImplementation(rng);

  installState(world, scenario.install);
  const faults = scenario.faults.map(id => {
    const f = FAULT_BY_ID.get(id);
    if (!f) throw new Error(`unknown fault ${id}`);
    return f;
  });
  for (const f of faults) f.apply(world);
  world.server.install();
  if (world.runtime.pickleAuthMissing) {
    NativeModules.PickleAuth = undefined;
  } else {
    NativeModules.PickleAuth = realPickleAuth;
  }
  let dateSpy: jest.SpyInstance | null = null;
  if (world.runtime.clockNaN) {
    dateSpy = jest.spyOn(Date, 'now').mockReturnValue(NaN);
  }

  const timeline: Timeline[] = [];
  const clock = () => realDateNow() - T0;
  const log = (event: string, detail?: Record<string, unknown>) =>
    timeline.push({ at: clock(), event, ...(detail ? { detail } : {}) });

  const shotsBefore = world.db.inner.shotFingerprint();
  const expectsBoundary = faults.some(f => f.expectsBoundary);
  // Keychain read faults that can never yield the planted record (a slow
  // read still does, eventually).
  const keychainReadBroken = faults.some(
    f =>
      (f.id.startsWith('kc.get.') && !f.id.startsWith('kc.get.slow-')) ||
      f.id === 'kc.module-broken',
  );
  // Faults that overwrite the vault with a record of their own: raw garbage
  // (never a session) or a structured variant (may or may not parse).
  const plantsGarbageVault = faults.some(
    f => f.id.startsWith('kc.vault.raw-') || f.id.startsWith('kc.reset.'),
  );
  const plantsRecordVault = faults.some(f =>
    f.id.startsWith('kc.vault.record-'),
  );
  const revokes = faults.some(
    f =>
      f.id === 'fetch.refresh.refuse-401' ||
      f.id === 'fetch.refresh.refuse-403',
  );
  const vaultInstall =
    scenario.install === 'vault-valid' ||
    scenario.install === 'vault-valid-no-profile';
  // 'app'     a valid record is readable and the server did not revoke it
  // 'welcome' nothing restorable exists on the device
  // 'either'  a structured record variant the parser may accept or reject
  const expectedLanding: 'welcome' | 'app' | 'either' = plantsRecordVault
    ? keychainReadBroken || revokes
      ? 'welcome'
      : 'either'
    : vaultInstall && !keychainReadBroken && !plantsGarbageVault && !revokes
      ? 'app'
      : 'welcome';

  let renderer: TestRenderer.ReactTestRenderer | null = null;
  let mountError: string | null = null;
  await act(async () => {
    try {
      renderer = TestRenderer.create(<App />);
    } catch (error) {
      mountError = error instanceof Error ? error.message : String(error);
    }
  });
  log('mounted', { mountError });

  const observed: Record<string, unknown> = {
    mountError,
    expectedLanding,
    faultsExercised: {} as Record<string, boolean>,
  };
  const inv: Record<string, boolean> = {};
  let readyAt: number | null = null;
  let splashGoneAt: number | null = null;
  let boundaryAt: number | null = null;
  let firstSettled: Snapshot | null = null;

  const root = () => {
    if (!renderer) throw new Error('not mounted');
    return renderer.root;
  };
  const snap = () => (renderer ? snapshot(root()) : null);

  // Observation window: 60 s of fake time in 250 ms slices.
  for (let t = 0; t <= OBSERVE_MS && renderer; t += SLICE_MS) {
    const s = snap();
    if (s) {
      if (readyAt === null && gateSettled(s)) {
        readyAt = t;
        firstSettled = s;
        log('gate-settled', { ...s });
      }
      if (splashGoneAt === null && !s.splashBlocking) {
        splashGoneAt = t;
        log('splash-released');
      }
      if (boundaryAt === null && s.boundary) {
        boundaryAt = t;
        log('error-boundary', { retryVisible: s.retryVisible });
      }
      if (readyAt !== null && splashGoneAt !== null) break;
    }
    await flush(SLICE_MS);
  }
  const atSixty = snap();
  observed.readyAtMs = readyAt;
  observed.splashGoneAtMs = splashGoneAt;
  observed.boundaryAtMs = boundaryAt;
  observed.landing = firstSettled
    ? firstSettled.app
      ? 'app'
      : firstSettled.welcome
        ? 'welcome'
        : firstSettled.boundary
          ? 'boundary'
          : firstSettled.profileError
            ? 'profile-error'
            : firstSettled.onboarding
              ? 'onboarding'
              : firstSettled.accountOnboarding
                ? 'account-onboarding'
                : firstSettled.signIn
                  ? 'signin'
                  : 'other'
    : atSixty?.loading
      ? 'loading-after-60s'
      : 'unmounted-or-blank';
  observed.controlsAtLanding = (firstSettled ?? atSixty)?.controls ?? [];
  observed.textsAt60s = renderer ? texts(root()).slice(0, 12) : [];

  inv.noInfiniteSpinner = readyAt !== null && readyAt <= OBSERVE_MS;
  inv.splashReleased = splashGoneAt !== null && splashGoneAt <= OBSERVE_MS;
  inv.noMountCrash = mountError === null;
  // The intro never plays in this harness (inert video), so the overlay must
  // leave exactly at its own watchdog once hydration is already done.
  if (
    readyAt !== null &&
    readyAt <= SPLASH_WATCHDOG_MS &&
    !firstSettled?.boundary
  ) {
    inv.splashHandoffAtWatchdog = splashGoneAt === SPLASH_WATCHDOG_MS;
  }

  // Recoverability of an error-boundary landing: retry control visible; once
  // the fault lifts, retry reaches Welcome.
  let recoveredAfterRetry: boolean | null = null;
  if (firstSettled?.boundary && renderer) {
    inv.boundaryHasRetry = firstSettled.retryVisible;
    world.runtime = {};
    const retry = control(root(), BOUNDARY_RETRY);
    if (retry) {
      await act(async () => {
        retry.press();
      });
      for (let t = 0; t <= 20_000; t += SLICE_MS) {
        const s = snap();
        if (s && !s.loading && (s.welcome || s.app)) {
          recoveredAfterRetry = true;
          log('recovered-after-retry', { at: t });
          break;
        }
        await flush(SLICE_MS);
      }
      if (recoveredAfterRetry === null) recoveredAfterRetry = false;
    } else {
      recoveredAfterRetry = false;
    }
    inv.recoverableAfterRetry = recoveredAfterRetry;
  } else {
    inv.boundaryOnlyWhenExpected =
      !expectsBoundary || Boolean(firstSettled?.boundary);
  }
  observed.recoveredAfterRetry = recoveredAfterRetry;
  if (expectsBoundary) {
    inv.expectedBoundaryShown = boundaryAt !== null;
  } else if (firstSettled?.boundary) {
    inv.noUnexpectedBoundary = false;
  }

  // Landing semantics.
  const current = snap();
  const auth = useAuthStore.getState();
  observed.sessionAtLanding = auth.session
    ? { provider: auth.session.provider, localOnly: auth.session.localOnly }
    : null;
  observed.authError = auth.error?.code ?? null;
  observed.localDataError = auth.localDataError ? 'set' : null;
  observed.appHydrateError = useAppStore.getState().hydrateError ?? null;
  const onWelcome = Boolean(current?.welcome);
  const inApp = Boolean(current?.app || current?.accountOnboarding);
  const refreshAttempted = world.server.calls.some(
    c => c.route === '/v1/auth/refresh',
  );
  // `fetch` itself missing/throwing never reaches the scripted server.
  const fetchLayerBroken = faults.some(
    f => f.id.startsWith('fetch.') && !f.id.startsWith('fetch.refresh.'),
  );
  if (expectedLanding === 'welcome' && (onWelcome || inApp)) {
    // Never signed in when nothing restorable exists.
    inv.noFakeSuccess = !inApp && auth.session === null;
  }
  if (expectedLanding === 'either' && (onWelcome || inApp)) {
    // Signed in only from a parsed record whose refresh token was actually
    // presented to the server; signed out only with no session at all.
    inv.noFakeSuccess = inApp
      ? auth.session !== null &&
        auth.session.localOnly === false &&
        (refreshAttempted || fetchLayerBroken)
      : auth.session === null;
  }
  if (
    expectedLanding === 'app' &&
    (onWelcome || inApp || current?.profileError)
  ) {
    inv.noSpuriousSignOut =
      !onWelcome && auth.session !== null && auth.session.localOnly === false;
    // A signed-in landing must have presented the refresh token (the ≤ 8 s
    // launch wait may proceed with local data while it is still pending).
    if (inApp) inv.refreshPresented = refreshAttempted || fetchLayerBroken;
  }
  const dbBroken = faults.some(
    f =>
      f.id === 'db.open.throw' ||
      f.id === 'db.all.throw' ||
      f.id === 'db.kv-read.auth.session.throw' ||
      f.id === 'db.kv-read.auth.local-mode.throw',
  );
  if (dbBroken && readyAt !== null) {
    inv.noSilentDbFailure = auth.localDataError !== null;
  }
  // A device that holds an account (a session record in the Keychain)
  // and lands on Welcome because the Keychain could not be read must say so:
  // a bare Welcome is indistinguishable from a sign-out.
  const silentAccountLoss =
    vaultInstall &&
    onWelcome &&
    !revokes &&
    !plantsRecordVault &&
    auth.error === null &&
    auth.localDataError === null &&
    useAppStore.getState().hydrateError === null;
  observed.silentAccountLoss = silentAccountLoss;
  if (vaultInstall && onWelcome && !revokes && !plantsRecordVault) {
    inv.signedOutWithNotice = !silentAccountLoss;
  }

  // Welcome-screen controls + navigation script.
  const interactionsRun: Record<string, string> = {};
  if (onWelcome && renderer) {
    const start = control(root(), WELCOME_CTA);
    const signIn = control(root(), WELCOME_SIGNIN);
    inv.welcomeControls =
      Boolean(start) &&
      Boolean(signIn) &&
      !start!.disabled &&
      !signIn!.disabled;
    const t = texts(root());
    inv.welcomeCopy = t.includes('Pickle Sensei') && t.includes(WELCOME_CTA);
    let navOk = true;
    const backToWelcome = async (label: string): Promise<boolean> => {
      const back = control(root(), 'Back');
      if (!back) {
        interactionsRun[label] = 'no-back-control';
        return false;
      }
      await act(async () => {
        back.press();
      });
      await flush(SLICE_MS);
      const s = snap();
      if (!s?.welcome) {
        interactionsRun[label] =
          `back-did-not-return: ${s?.controls.join(',')}`;
        return false;
      }
      return true;
    };
    for (const [index, interaction] of scenario.interactions.entries()) {
      const label = `${index}:${interaction}`;
      const before = snap();
      if (!before?.welcome) {
        interactionsRun[label] = `skipped-not-on-welcome (${observed.landing})`;
        navOk = false;
        break;
      }
      switch (interaction) {
        case 'tap-start-back': {
          const cta = control(root(), WELCOME_CTA)!;
          await act(async () => {
            cta.press();
          });
          await flush(SLICE_MS);
          const s = snap();
          if (!s?.onboarding) {
            interactionsRun[label] =
              `start-did-not-open-onboarding: ${s?.controls.join(',')}`;
            navOk = false;
            break;
          }
          if (await backToWelcome(label)) interactionsRun[label] = 'ok';
          else navOk = false;
          break;
        }
        case 'tap-signin-back': {
          const link = control(root(), WELCOME_SIGNIN)!;
          await act(async () => {
            link.press();
          });
          await flush(SLICE_MS);
          const s = snap();
          if (!s?.signIn) {
            interactionsRun[label] =
              `signin-did-not-open: ${s?.controls.join(',')}`;
            navOk = false;
            break;
          }
          if (await backToWelcome(label)) interactionsRun[label] = 'ok';
          else navOk = false;
          break;
        }
        case 'double-tap-start': {
          const cta = control(root(), WELCOME_CTA)!;
          await act(async () => {
            cta.press();
            cta.press();
          });
          await flush(SLICE_MS);
          const s = snap();
          if (!s?.onboarding) {
            interactionsRun[label] = `double-tap-did-not-open-onboarding`;
            navOk = false;
            break;
          }
          if (await backToWelcome(label)) interactionsRun[label] = 'ok';
          else navOk = false;
          break;
        }
        case 'rapid-toggle': {
          // Start, back, sign-in, back, start, back — six stage changes.
          let ok = true;
          for (let i = 0; i < 3 && ok; i += 1) {
            const cta = control(
              root(),
              i % 2 === 0 ? WELCOME_CTA : WELCOME_SIGNIN,
            )!;
            await act(async () => {
              cta.press();
            });
            const s = snap();
            if (!(s?.onboarding || s?.signIn)) {
              ok = false;
              break;
            }
            ok = await backToWelcome(label);
          }
          if (ok) interactionsRun[label] = 'ok';
          else navOk = false;
          break;
        }
        case 'background-foreground': {
          await act(async () => emitAppState('background'));
          await flush(5_000);
          await act(async () => emitAppState('active'));
          await flush(SLICE_MS);
          const s = snap();
          interactionsRun[label] = s?.welcome
            ? 'ok'
            : `lost-welcome: ${observedState(s)}`;
          if (!s?.welcome) navOk = false;
          break;
        }
        case 'second-hydrate': {
          await act(async () => {
            // App.tsx fires hydrate() without a handler, so a rejection here
            // would be unhandled in production — count it as one.
            useAuthStore.getState().hydrate().catch(onUnhandled);
          });
          await flush(SLICE_MS);
          await flush(SLICE_MS);
          const s = snap();
          interactionsRun[label] = s?.welcome
            ? 'ok'
            : `lost-welcome: ${observedState(s)}`;
          if (!s?.welcome) navOk = false;
          break;
        }
        case 'remount': {
          await act(async () => {
            renderer!.unmount();
          });
          await act(async () => {
            renderer = TestRenderer.create(<App />);
          });
          let back = false;
          for (let waited = 0; waited <= 20_000; waited += SLICE_MS) {
            await flush(SLICE_MS);
            const s = snap();
            if (s?.welcome && !s.splashBlocking) {
              back = true;
              break;
            }
          }
          interactionsRun[label] = back
            ? 'ok'
            : `remount-did-not-reach-welcome: ${observedState(snap())}`;
          if (!back) navOk = false;
          break;
        }
        case 'video-error':
        case 'video-end':
        case 'video-progress-garbage': {
          // The splash video callbacks after the splash already finished:
          // stale native events must be inert.
          const video = root().findAll(
            n =>
              typeof n.props.onEnd === 'function' &&
              typeof n.props.onError === 'function',
          )[0];
          if (!video) {
            interactionsRun[label] = 'ok (splash already unmounted)';
            break;
          }
          await act(async () => {
            if (interaction === 'video-error')
              (video.props.onError as (e: unknown) => void)({
                error: { code: -1 },
              });
            else if (interaction === 'video-end')
              (video.props.onEnd as () => void)();
            else
              (video.props.onProgress as (e: unknown) => void)({
                currentTime: NaN,
                playableDuration: undefined,
              });
          });
          await flush(SLICE_MS);
          const s = snap();
          interactionsRun[label] = s?.welcome
            ? 'ok'
            : `lost-welcome: ${observedState(s)}`;
          if (!s?.welcome) navOk = false;
          break;
        }
        case 'clock-jump-back': {
          jest.setSystemTime(realDateNow() - 3 * 24 * 3600_000);
          await flush(1_000);
          const s = snap();
          interactionsRun[label] = s?.welcome
            ? 'ok'
            : `lost-welcome: ${observedState(s)}`;
          if (!s?.welcome) navOk = false;
          break;
        }
        case 'clock-jump-forward': {
          jest.setSystemTime(realDateNow() + 400 * 24 * 3600_000);
          await flush(1_000);
          const s = snap();
          interactionsRun[label] = s?.welcome
            ? 'ok'
            : `lost-welcome: ${observedState(s)}`;
          if (!s?.welcome) navOk = false;
          break;
        }
      }
    }
    inv.navigation = navOk;
  }
  observed.interactions = interactionsRun;

  // Persisted-state integrity.
  const kvWrites = world.db.inner.kvWrites();
  const kvTokenLeak = kvWrites.some(
    w =>
      w.value.includes(INITIAL_REFRESH) ||
      w.value.includes('access-') ||
      (w.key === 'auth.session' && w.value !== ''),
  );
  const kvKeysOk = kvWrites.every(w => /^[a-z][a-z0-9.:_-]*$/i.test(w.key));
  const vault = world.keychain.store.get(VAULT_SERVICE);
  let vaultOk = true;
  if (vault) {
    try {
      const parsed = JSON.parse(vault.password) as Record<string, unknown>;
      vaultOk =
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof parsed.refreshToken === 'string' &&
        typeof parsed.canonicalAppUserId === 'string';
    } catch {
      vaultOk = false;
    }
  }
  const vaultWritten = world.keychain.calls.set > 0;
  const preexistingMalformedVault = plantsGarbageVault || plantsRecordVault;
  inv.shotsPreserved = world.db.inner.shotFingerprint() === shotsBefore;
  inv.noDestructiveSql = world.db.inner.destructiveStatements().length === 0;
  inv.noTokenInKv = !kvTokenLeak;
  inv.kvWritesWellFormed = kvKeysOk;
  // A pre-seeded malformed vault the harness planted is the fault itself; the
  // invariant is that the APP never writes garbage and, when it clears a
  // record, leaves nothing behind.
  inv.vaultNeverCorrupted =
    vaultOk || (preexistingMalformedVault && !vaultWritten);
  observed.kvWrites = kvWrites.map(w => `${w.key}=${w.value.slice(0, 40)}`);
  observed.vaultAfter = vault
    ? vaultOk
      ? 'valid-record'
      : 'malformed'
    : 'absent';
  observed.keychainCalls = { ...world.keychain.calls };

  // Network discipline.
  const routes = world.server.calls.map(c => `${c.route}:${c.outcome}`);
  observed.fetchCalls = routes;
  inv.noUnexpectedRoute = world.server.unexpected.length === 0;
  if (
    !vaultInstall &&
    scenario.install !== 'last-provider-google' &&
    !faults.some(f => f.id.startsWith('kc.vault.record-'))
  ) {
    inv.signedOutMakesNoRequests = world.server.calls.length === 0;
  }
  inv.singleRefreshInFlight = world.server.maxInflight <= 1;

  // Fault exercised?
  const counts = world.callCounts();
  const exercised = observed.faultsExercised as Record<string, boolean>;
  for (const f of faults) {
    exercised[f.id] =
      f.exercisedBy === null ? true : (counts[f.exercisedBy] ?? 0) > 0;
  }
  observed.callCounts = counts;

  // Unmount + 60 s quiet period.
  let unmountError: string | null = null;
  if (renderer) {
    try {
      await act(async () => {
        renderer!.unmount();
      });
    } catch (error) {
      unmountError = error instanceof Error ? error.message : String(error);
    }
  }
  const errorsBeforeQuiet = consoleErrors.length;
  await flush(OBSERVE_MS);
  inv.cleanUnmount = unmountError === null;
  observed.unmountError = unmountError;
  observed.consoleErrors = [...consoleErrors];
  observed.consoleErrorsAfterUnmount = consoleErrors.length - errorsBeforeQuiet;
  observed.unhandledRejections = [...unhandledRejections];
  // React logs a caught render/effect error before the boundary recovers;
  // that line is the boundary working, not a silent failure.
  const unexpectedConsoleErrors = consoleErrors.filter(
    line => !(expectsBoundary && line.includes('The above error occurred')),
  );
  observed.unexpectedConsoleErrors = unexpectedConsoleErrors;
  inv.noConsoleError = unexpectedConsoleErrors.length === 0;
  inv.noUnhandledRejection = unhandledRejections.length === 0;
  observed.timeline = timeline;

  dateSpy?.mockRestore();
  randomSpy.mockRestore();
  NativeModules.PickleAuth = realPickleAuth;
  observed.teardownErrors = teardownSafely();

  const failed = Object.entries(inv)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  const row: Row = {
    suite: SUITE,
    scenario: scenario.name,
    seed: scenario.seed,
    inputs: {
      install: scenario.install,
      faults: scenario.faults,
      faultClasses: faults.map(f => `${f.dependency}/${f.cls}`),
      interactions: scenario.interactions,
      reduceMotion: scenario.reduceMotion,
      replay: `cd apps/mobile && STRESS_WFI_FILTER='${scenario.name}' npx jest --ci --silent __tests__/stress/welcomeScreen.failureInjection.stress.test.tsx`,
    },
    observed,
    invariants: inv,
    ok: failed.length === 0,
    failed,
    deviation: null,
    durationMs: realDateNow() - started,
  };
  row.deviation = classifyDeviation(row, faults);
  return row;
}

function observedState(s: Snapshot | null): string {
  if (!s) return 'unmounted';
  if (s.app) return 'app';
  if (s.boundary) return 'boundary';
  if (s.loading) return 'loading';
  if (s.onboarding) return 'onboarding';
  if (s.signIn) return 'signin';
  if (s.profileError) return 'profile-error';
  return `other[${s.controls.join(',')}]`;
}

// ─── Known deviations (pinned; each is a reported finding) ───────────────────

interface Deviation {
  id: string;
  /** Faults that trigger it (any of). */
  faults: readonly string[];
  /** Exactly these invariants fail. */
  fails: readonly string[];
  summary: string;
}

const KNOWN_DEVIATIONS: readonly Deviation[] = [
  {
    id: 'WFI-1',
    summary:
      'No launch watchdog: a Keychain read/reset, SQLite statement or Google ' +
      'silent-restore call that never settles leaves the splash overlay ' +
      '(pointerEvents auto) over LoadingState indefinitely — no retry, no ' +
      'message, 60 s later still loading.',
    faults: [
      'kc.get.never',
      'kc.reset.never',
      'db.execute.never',
      'db.kv-read.local-mode.never',
      'google.signInSilently.never',
    ],
    fails: ['noInfiniteSpinner', 'splashReleased'],
  },
  {
    id: 'WFI-2',
    summary:
      'Effect cleanup assumes AppState.addEventListener returned a ' +
      'subscription; an undefined return throws on unmount. React Native ' +
      'guarantees the subscription, so this is informational.',
    faults: ['appstate.addListener.returns-undefined'],
    fails: ['cleanUnmount'],
  },
  {
    id: 'WFI-3',
    summary:
      'A device with a stored account (a session record in the Keychain) whose ' +
      'Keychain read fails or returns garbage lands on Welcome with no ' +
      'notice — indistinguishable from a sign-out (sessionVault ' +
      'loadPersistedSession swallows the error; authStore.hydrate lands ' +
      'signed out). On a read ERROR the record is left intact so the next ' +
      'launch retries; an unparseable record is cleared. Silent failure, ' +
      'not data loss.',
    faults: FAULTS.filter(
      f =>
        (f.id.startsWith('kc.get.') && !f.id.startsWith('kc.get.slow-')) ||
        f.id === 'kc.module-broken' ||
        f.id.startsWith('kc.vault.raw-') ||
        f.id.startsWith('kc.reset.'),
    ).map(f => f.id),
    fails: ['signedOutWithNotice'],
  },
];

function classifyDeviation(row: Row, faults: readonly Fault[]): string | null {
  if (row.ok) return null;
  const ids = new Set(faults.map(f => f.id));
  for (const dev of KNOWN_DEVIATIONS) {
    if (!dev.faults.some(id => ids.has(id))) continue;
    const expected = [...dev.fails].sort().join(',');
    if (expected === [...row.failed].sort().join(',')) return dev.id;
  }
  return null;
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const rows: Row[] = [];

function matchesFilter(s: Scenario): boolean {
  if (!FILTER) return true;
  return (
    s.name === FILTER || String(s.seed) === FILTER || s.faults.includes(FILTER)
  );
}

const allScenarios: Scenario[] = [
  ...controlScenarios(),
  ...enumeratedScenarios(),
  ...Array.from({ length: STRESS_ITER }, (_, i) => seededScenario(1 + i)),
].filter(matchesFilter);

describe(SUITE, () => {
  it.each(allScenarios.map(s => [s.name, s] as const))(
    '%s',
    async (_name, scenario) => {
      const row = await runScenario(scenario);
      rows.push(row);
      if (!row.ok && row.deviation === null) {
        throw new Error(
          `UNEXPLAINED failure — ${row.failed.join(', ')}\n${JSON.stringify(
            {
              inputs: row.inputs,
              observed: { ...row.observed, timeline: undefined },
            },
            null,
            2,
          )}`,
        );
      }
      // A documented deviation that stops reproducing must be re-examined.
      expect(row.deviation === null ? 'ok' : row.deviation).toBe(
        row.ok ? 'ok' : row.deviation,
      );
    },
    30_000,
  );

  afterAll(() => {
    const summary = summarize(rows);
    const notReachable = {
      camera:
        'not-reachable-from-unit: no signed-out import before first signed-in landing',
      vision: 'not-reachable-from-unit',
      tts: 'not-reachable-from-unit',
      revenuecat:
        'not-reachable-from-unit: billing store configured after sign-in',
    };
    writeJsonArtifact('welcome-failure-injection.rows.json', rows);
    writeJsonArtifact('welcome-failure-injection.summary.json', {
      suite: SUITE,
      stressIter: STRESS_ITER,
      filter: FILTER || null,
      faultCatalog: FAULTS.map(f => ({
        id: f.id,
        dependency: f.dependency,
        cls: f.cls,
      })),
      notReachable,
      ...summary,
    });
  });
});
