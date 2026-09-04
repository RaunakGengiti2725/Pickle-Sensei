/**
 * STRESS · mod-app-root · failure-injection
 *
 * Cold-launch failure injection against the REAL App.tsx root (providers,
 * RootErrorBoundary, Gate, splash handoff) with the real auth / app /
 * notification / consistency / walkthrough stores underneath. Every
 * root-connected dependency is replaced by a fault-injectable fake
 * (stress-harness/app-root/world.ts) and driven through
 * throw / reject / hang / slow / timeout / malformed / partial (+ HTTP
 * refusals, clock skew, navigation render faults, billing wiring, runtime
 * config).
 *
 * Per scenario:
 *   1. persist a device state (fresh / signed-in vault / guest / legacy Google)
 *   2. arm the faults, mount <App/>, advance fake time 60s in 1s steps,
 *      recording the visible screen at every step
 *   3. heal every dependency (late answers resolve, next call succeeds), press
 *      the visible retry control if any, advance another 60s
 *   4. kill the process (reset every in-memory singleton), relaunch healthy,
 *      advance 10s
 *   5. evaluate the invariants below and write the row
 *
 * Invariants (all evaluated for every row):
 *   noInfiniteSpinner     a non-loading screen is visible within 60s of launch
 *   visibleControl        an error screen always carries a retry control
 *   recoverable           an error or loading screen at 60s turns into a
 *                         healthy screen once the dependency answers / retry
 *                         is pressed (a late answer must unstick the app)
 *   landedOnAccount       the faulted launch lands on the persisted account
 *                         (or an error screen with a control) — never on a
 *                         silently different account, unless the server
 *                         refused the session or the vault itself was corrupt
 *   relaunchHealthy       a healthy relaunch lands on the persisted account
 *   noFakeSuccess         signed-in screens require a session AND a profile;
 *                         a refused refresh never stays signed in; a corrupt
 *                         or missing canonical profile never re-asks the
 *                         questionnaire
 *   noSilentFailure       a fired fault leaves an observable trace (surfaced
 *                         error text, store error flag, telemetry crash) or is
 *                         one of the documented best-effort degradations
 *   noUncaughtError       nothing escapes the React tree / act()
 *   vaultIntact           Keychain holds a parseable record with a token the
 *                         server issued, or nothing (never garbage)
 *   kvIntact              every kv value written is valid JSON or ''
 *   credentialsPreserved  a transient fault never drops the durable sign-in
 *   noDestructiveSql      hydrate never deletes or rewrites product rows
 *   noBearerPersisted     no access token reaches Keychain or SQLite
 *
 * Campaign shape: a fixed matrix (every dependency × every applicable mode,
 * one persona each) always runs; `STRESS_ITER` (default 24) adds seeded rows
 * that combine a persona with 1–2 random faults, latency and clock skew.
 * `STRESS_SEED=<n>` / `STRESS_CASE=<name>` replay one row. Rows are written to
 * artifacts/stress-app-root/ (STRESS_ARTIFACT_DIR).
 */

import React from 'react';
import { AppState, NativeModules } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  CANONICAL_ID,
  DEPENDENCIES,
  FakeKeychain,
  FakeScheduler,
  FaultWorld,
  MODES_FOR,
  SQLITE_SCOPES,
  ScriptedServer,
  StressDb,
  VALID_PROFILE,
  validVault,
  type Dependency,
  type Fault,
  type FaultMode,
  type SqliteScope,
} from '../../stress-harness/app-root/world';
import { chance, makePrng, pick } from '../../stress-harness/app-root/prng';
import {
  envInt,
  envString,
  summarize,
  writeJsonArtifact,
  type StressRow,
} from '../../stress-harness/app-root/artifacts';

// ─── World handle read lazily by every module mock ───────────────────────────

const mockWorld = {
  world: new FaultWorld(),
  db: null as StressDb | null,
  keychain: null as FakeKeychain | null,
  scheduler: null as FakeScheduler | null,
  server: null as ScriptedServer | null,
  navRenders: 0,
  navEffects: 0,
  welcomeRenders: 0,
  google: { hasPrevious: false },
};

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    const db = mockWorld.db;
    if (!db) throw new Error('no db in this scenario');
    return db.open();
  },
}));

jest.mock('react-native-keychain', () => {
  const proxy =
    (
      name:
        'getGenericPassword' | 'setGenericPassword' | 'resetGenericPassword',
    ) =>
    (...args: unknown[]) => {
      const keychain = mockWorld.keychain;
      if (!keychain) throw new Error('no keychain in this scenario');
      const module = keychain.module() as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      return module[name]!(...args);
    };
  return {
    ACCESSIBLE: { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afu-tdo' },
    getGenericPassword: proxy('getGenericPassword'),
    setGenericPassword: proxy('setGenericPassword'),
    resetGenericPassword: proxy('resetGenericPassword'),
  };
});

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: () => {
      const fault = mockWorld.world.syncGate('google-sdk', 'configure');
      if (fault?.mode === 'throw')
        throw new Error('GoogleSignin.configure threw (injected)');
    },
    hasPreviousSignIn: () => mockWorld.google.hasPrevious,
    signInSilently: async () => {
      const outcome = await mockWorld.world.ioGate(
        'google-sdk',
        'signInSilently',
      );
      if (outcome === 'malformed') return { type: 'weird', data: null };
      if (outcome === 'partial')
        return { type: 'success', data: { idToken: null, user: {} } };
      return {
        type: 'success',
        data: {
          idToken: 'google-id-token',
          user: { name: 'Pat', email: 'player@example.com' },
        },
      };
    },
    hasPlayServices: async () => true,
    signIn: async () => ({ type: 'cancelled' }),
    signOut: async () => undefined,
  },
}));

jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => {
    const fault = mockWorld.world.syncGate('config', 'getRuntimePublicConfig');
    if (fault?.mode === 'throw')
      throw new Error('runtime config unavailable (injected)');
    return {
      apiBaseUrl:
        fault?.mode === 'partial'
          ? null
          : fault?.mode === 'malformed'
            ? 'not a url'
            : 'https://api.example.test',
      revenueCatPublicSdkKey: 'appl_test',
      googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
      googleWebClientId: 'test-web-client.apps.googleusercontent.com',
      appVersion: '1.0',
      privacyPolicyUrl: 'https://example.test/privacy',
      termsOfUseUrl: 'https://example.test/terms',
      appStoreId: '0',
      supportEmail: 'support@example.test',
    };
  },
}));
jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));
jest.mock('../../src/account/deviceContext', () => ({
  getAccountBootstrapEnvironment: () => ({
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    device: {
      platform: 'ios',
      osVersion: '18.5',
      model: 'iPhone',
      appVersion: '1.0',
    },
  }),
}));

jest.mock('../../src/billing', () => {
  const actual =
    jest.requireActual<typeof import('../../src/billing')>('../../src/billing');
  return {
    ...actual,
    createBillingAccessDependencies: (
      ...args: Parameters<typeof actual.createBillingAccessDependencies>
    ) => {
      const fault = mockWorld.world.syncGate(
        'billing',
        'createBillingAccessDependencies',
      );
      if (fault?.mode === 'throw')
        throw new Error('RevenueCat client construction failed (injected)');
      if (fault?.mode === 'malformed')
        return {} as ReturnType<typeof actual.createBillingAccessDependencies>;
      return actual.createBillingAccessDependencies(...args);
    },
  };
});

jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => {
    const scheduler = mockWorld.scheduler;
    if (!scheduler) throw new Error('no scheduler in this scenario');
    return scheduler;
  },
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

/** Screens that can fail are given the navigation faults. */
function mockFaultyScreen(
  marker: string,
  counter: 'navRenders' | 'welcomeRenders',
) {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return () => {
    mockWorld[counter] += 1;
    const fault = mockWorld.world.get('navigation');
    if (fault) {
      if (fault.mode === 'throw') {
        mockWorld.world.hit('navigation', `${marker}:throw`);
        throw new Error(`${marker} render threw (injected)`);
      }
      if (fault.mode === 'throw-once' && mockWorld[counter] === 1) {
        mockWorld.world.hit('navigation', `${marker}:throw-once`);
        throw new Error(`${marker} render threw once (injected)`);
      }
    }
    R.useEffect(() => {
      const effectFault = mockWorld.world.get('navigation');
      if (!effectFault) return;
      mockWorld.navEffects += 1;
      if (
        effectFault.mode === 'effect-throw-once' &&
        mockWorld.navEffects === 1
      ) {
        mockWorld.world.hit('navigation', `${marker}:effect-throw-once`);
        throw new Error(`${marker} effect threw once (injected)`);
      }
      if (effectFault.mode === 'reject') {
        mockWorld.world.hit('navigation', `${marker}:reject`);
        // Stands in for index.js's global rejection tracker (covered by the
        // sibling index suite): the rejection is observed, never rethrown into
        // the tree, and the screen must survive it.
        void Promise.reject(
          new Error(`${marker} async work rejected (injected)`),
        ).catch(() => {
          mockWorld.world.hit('navigation', 'unhandled-rejection-observed');
        });
      }
    }, []);
    return R.createElement(RN.Text, null, marker);
  };
}

jest.mock('../../src/navigation/RootNavigator', () => ({
  RootNavigator: mockFaultyScreen('ROOT_NAVIGATOR', 'navRenders'),
}));
jest.mock('../../src/screens/WelcomeScreen', () => ({
  WelcomeScreen: mockFaultyScreen('WELCOME', 'welcomeRenders'),
}));
jest.mock('../../src/screens/OnboardingScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    OnboardingScreen: () => R.createElement(RN.Text, null, 'ONBOARDING'),
  };
});
jest.mock('../../src/screens/SignInScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return { SignInScreen: () => R.createElement(RN.Text, null, 'SIGN_IN') };
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

import App, { RootErrorBoundary } from '../../App';
import { Button } from '../../src/design/components';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import { clearApiSession } from '../../src/account/apiSession';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

// ─── Scenario model ──────────────────────────────────────────────────────────

const PERSONAS = [
  'fresh',
  'vault-profile',
  'vault-no-profile',
  'guest',
  'legacy-google',
] as const;
type Persona = (typeof PERSONAS)[number];

interface Scenario {
  name: string;
  seed: number | null;
  persona: Persona;
  faults: Fault[];
  slowMs: number;
  /** Device clock at launch. */
  clockIso: string;
}

const LAUNCH_OBSERVE_MS = 60_000;
const RECOVERY_OBSERVE_MS = 60_000;
const RELAUNCH_OBSERVE_MS = 10_000;
const STEP_MS = 1_000;
/** sessionKeeper contract: ≤2 rotations (30s gap) + ≤12 retries (5s floor). */
const MAX_REFRESH_CALLS_PER_MINUTE = 15;

function countBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

/** Persona that makes each dependency reachable from the launch path. */
const PERSONA_FOR: Record<Dependency, Persona> = {
  keychain: 'vault-profile',
  sqlite: 'vault-profile',
  'api-refresh': 'vault-profile',
  'api-me': 'vault-no-profile',
  'api-bootstrap': 'legacy-google',
  'google-sdk': 'legacy-google',
  notifications: 'vault-profile',
  permissions: 'vault-profile',
  clock: 'vault-profile',
  navigation: 'vault-profile',
  billing: 'vault-profile',
  config: 'vault-profile',
};

function fixedMatrix(): Scenario[] {
  const rows: Scenario[] = [];
  for (const dep of DEPENDENCIES) {
    for (const mode of MODES_FOR[dep]) {
      if (dep === 'sqlite') {
        for (const scope of SQLITE_SCOPES) {
          if (scope === 'open' && mode !== 'throw') continue;
          for (const persona of ['vault-profile', 'guest'] as const) {
            rows.push({
              name: `fixed:${dep}:${mode}:${scope}:${persona}`,
              seed: null,
              persona,
              faults: [{ dep, mode, detail: scope }],
              slowMs: 3_000,
              clockIso: '2026-03-01T09:00:00.000Z',
            });
          }
        }
        continue;
      }
      const personas: Persona[] =
        dep === 'navigation'
          ? ['vault-profile', 'fresh']
          : dep === 'keychain'
            ? ['vault-profile', 'guest']
            : dep === 'api-refresh' || dep === 'config' || dep === 'clock'
              ? ['vault-profile', 'vault-no-profile']
              : [PERSONA_FOR[dep]];
      for (const persona of personas) {
        rows.push({
          name: `fixed:${dep}:${mode}:${persona}`,
          seed: null,
          persona,
          faults: [{ dep, mode }],
          slowMs: 3_000,
          clockIso: '2026-03-01T09:00:00.000Z',
        });
      }
    }
  }
  return rows;
}

/**
 * Dependencies a persona's launch actually touches (a signed-out launch never
 * calls /v1/auth/refresh, billing or the Google SDK). Seeded scenarios only
 * arm reachable ones so every row is a real injection; a fault that still
 * never fires (masked by another fault) makes the row UNREACHED, not HELD.
 */
const REACHABLE_FOR: Record<Persona, readonly Dependency[]> = {
  fresh: ['keychain', 'sqlite', 'notifications', 'navigation'],
  guest: ['keychain', 'sqlite', 'notifications', 'permissions', 'navigation'],
  'vault-profile': [
    'keychain',
    'sqlite',
    'api-refresh',
    'notifications',
    'permissions',
    'clock',
    'navigation',
    'billing',
    'config',
  ],
  'vault-no-profile': [
    'keychain',
    'sqlite',
    'api-refresh',
    'api-me',
    'notifications',
    'permissions',
    'clock',
    'navigation',
    'billing',
    'config',
  ],
  'legacy-google': [...DEPENDENCIES],
};

function seededScenario(seed: number): Scenario {
  const rng = makePrng(seed);
  const persona = pick(rng, PERSONAS);
  const faultCount = chance(rng, 0.35) ? 2 : 1;
  const faults: Fault[] = [];
  const used = new Set<Dependency>();
  while (faults.length < faultCount) {
    const dep = pick(rng, REACHABLE_FOR[persona]);
    if (used.has(dep)) continue;
    used.add(dep);
    const mode: FaultMode = pick(rng, MODES_FOR[dep]);
    const fault: Fault = { dep, mode };
    if (dep === 'sqlite') {
      const scope: SqliteScope =
        mode === 'throw'
          ? pick(rng, SQLITE_SCOPES)
          : pick(
              rng,
              SQLITE_SCOPES.filter(s => s !== 'open'),
            );
      fault.detail = scope;
    }
    faults.push(fault);
  }
  return {
    name: `seeded-${seed}`,
    seed,
    persona,
    faults,
    slowMs: pick(rng, [400, 3_000, 7_900, 9_000, 14_000]),
    clockIso: pick(rng, [
      '2026-03-01T09:00:00.000Z',
      '2001-01-01T00:00:00.000Z',
      '2099-12-31T23:59:00.000Z',
    ]),
  };
}

// ─── Process plumbing ────────────────────────────────────────────────────────

const appStateListeners = new Set<(state: string) => void>();
const CANONICAL_OWNER = canonicalDataOwner(CANONICAL_ID);
const LOCAL_GUEST_VALUE = JSON.stringify({ version: 1, mode: 'guest' });
const LAST_PROVIDER_GOOGLE_VALUE = JSON.stringify({
  version: 1,
  provider: 'google',
});

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
  stabilitySlo.reset();
  mockWorld.navRenders = 0;
  mockWorld.navEffects = 0;
  mockWorld.welcomeRenders = 0;
}

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

type Screen =
  | 'LOADING'
  | 'ERROR_PROFILE'
  | 'ERROR_ROOT'
  | 'WELCOME'
  | 'SIGN_IN'
  | 'ONBOARDING'
  | 'ROOT_NAVIGATOR'
  | 'BLANK'
  | 'UNMOUNTED';

interface View {
  screen: Screen;
  retryControls: number;
  text: string;
}

function inspect(renderer: TestRenderer.ReactTestRenderer | null): View {
  if (!renderer) return { screen: 'UNMOUNTED', retryControls: 0, text: '' };
  const json = renderer.toJSON();
  const text = collectText(json);
  const retryControls = renderer.root
    .findAllByType(Button)
    .filter(node => node.props.label === 'Try again').length;
  let screen: Screen = 'BLANK';
  if (text.includes('ROOT_NAVIGATOR')) screen = 'ROOT_NAVIGATOR';
  else if (text.includes('ONBOARDING')) screen = 'ONBOARDING';
  else if (text.includes('SIGN_IN')) screen = 'SIGN_IN';
  else if (text.includes('WELCOME')) screen = 'WELCOME';
  else if (text.includes('Something went wrong')) screen = 'ERROR_ROOT';
  else if (text.includes('couldn’t load')) screen = 'ERROR_PROFILE';
  else if (
    text.includes('Getting things ready') ||
    text.includes('Loading your account')
  )
    screen = 'LOADING';
  return { screen, retryControls, text };
}

function collectText(
  node: ReturnType<TestRenderer.ReactTestRenderer['toJSON']>,
): string {
  if (node === null) return '';
  if (Array.isArray(node)) return node.map(collectText).join('|');
  const parts: string[] = [];
  const props = node.props as Record<string, unknown>;
  if (typeof props['accessibilityLabel'] === 'string')
    parts.push(props['accessibilityLabel']);
  if (node.children) {
    for (const child of node.children) {
      parts.push(typeof child === 'string' ? child : collectText(child));
    }
  }
  return parts.join('|');
}

function pressRetry(renderer: TestRenderer.ReactTestRenderer): boolean {
  const buttons = renderer.root
    .findAllByType(Button)
    .filter(node => node.props.label === 'Try again');
  const button = buttons[0];
  if (!button) return false;
  act(() => {
    (button.props as { onPress: () => void }).onPress();
  });
  return true;
}

function persist(persona: Persona, db: StressDb, keychain: FakeKeychain): void {
  switch (persona) {
    case 'fresh':
      return;
    case 'vault-profile':
      keychain.stored = JSON.stringify(validVault());
      db.kv.set(
        profileKeyForOwner(CANONICAL_OWNER),
        JSON.stringify(VALID_PROFILE),
      );
      db.seedShots(CANONICAL_OWNER, 4);
      return;
    case 'vault-no-profile':
      keychain.stored = JSON.stringify(validVault());
      db.seedShots(CANONICAL_OWNER, 2);
      return;
    case 'guest':
      db.kv.set('auth.local-mode', LOCAL_GUEST_VALUE);
      db.kv.set(
        profileKeyForOwner(GUEST_DATA_OWNER),
        JSON.stringify(VALID_PROFILE),
      );
      db.seedShots(GUEST_DATA_OWNER, 3);
      return;
    case 'legacy-google':
      db.kv.set('auth.last-provider', LAST_PROVIDER_GOOGLE_VALUE);
      mockWorld.google.hasPrevious = true;
      return;
    default:
      return;
  }
}

/** The screen a healthy launch of this persisted state must reach. */
function healthyScreensFor(
  persona: Persona,
  db: StressDb,
  keychain: FakeKeychain,
): Screen[] {
  const vault = keychain.stored ? safeParse(keychain.stored) : null;
  const signedIn = vault !== null && typeof vault === 'object';
  const guest = db.kv.get('auth.local-mode') === LOCAL_GUEST_VALUE;
  if (guest) {
    return db.kv.get(profileKeyForOwner(GUEST_DATA_OWNER))
      ? ['ROOT_NAVIGATOR']
      : ['ONBOARDING'];
  }
  if (signedIn) {
    // A missing local profile is fetched from /v1/me (server has one).
    return ['ROOT_NAVIGATOR'];
  }
  if (
    persona === 'legacy-google' &&
    db.kv.get('auth.last-provider') === LAST_PROVIDER_GOOGLE_VALUE
  ) {
    return ['ROOT_NAVIGATOR', 'WELCOME'];
  }
  return ['WELCOME'];
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function storeSignals() {
  const auth = useAuthStore.getState();
  const app = useAppStore.getState();
  const notifications = useNotificationStore.getState();
  const consistency = useConsistencyStore.getState();
  const events = stabilitySlo.events();
  return {
    authHydrated: auth.hydrated,
    sessionProvider: auth.session?.provider ?? null,
    sessionCanonical: auth.session?.canonicalAppUserId ?? null,
    authError: auth.error?.code ?? null,
    localDataError: auth.localDataError,
    appHydrated: app.hydrated,
    appOwner: app.ownerKey,
    hasProfile: app.profile !== null,
    hydrateError: app.hydrateError,
    notificationPermission: notifications.permission,
    notificationPersistFailed: notifications.persistFailed,
    notificationScheduleFailed: notifications.scheduleFailed,
    consistencyLoadError: consistency.loadError,
    crashEvents: events.filter(event => event.kind === 'crash').length,
  };
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function runScenario(scenario: Scenario): Promise<StressRow> {
  const startedWall = Date.now();
  jest.setSystemTime(new Date(scenario.clockIso));
  const t0 = Date.now();
  // Scenario-relative ms; phase 2 resets the system clock, so the timeline
  // keeps counting from where the launch phase stopped.
  let phaseOffset = 0;
  let phaseStart = t0;
  const rel = () => phaseOffset + (Date.now() - phaseStart);

  const faultWorld = new FaultWorld();
  faultWorld.slowMs = scenario.slowMs;
  mockWorld.world = faultWorld;
  const db = new StressDb(faultWorld);
  const keychain = new FakeKeychain(faultWorld);
  const scheduler = new FakeScheduler(faultWorld);
  const server = new ScriptedServer(faultWorld);
  mockWorld.db = db;
  mockWorld.keychain = keychain;
  mockWorld.scheduler = scheduler;
  mockWorld.server = server;
  mockWorld.google.hasPrevious = false;
  (globalThis as { fetch: unknown }).fetch = server.fetch;

  persist(scenario.persona, db, keychain);
  const healthyScreens = healthyScreensFor(scenario.persona, db, keychain);
  const shotsBefore = db.shotFingerprint();
  const vaultBefore = keychain.stored;
  const kvBefore = new Map(db.kv);

  for (const fault of scenario.faults) faultWorld.set(fault);
  resetProcessState();

  const uncaught: string[] = [];
  const timeline: { at: number; screen: Screen; retry: number }[] = [];
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  const consoleError = jest
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
  try {
    // Phase 1: faulted launch.
    try {
      act(() => {
        renderer = TestRenderer.create(<App />);
      });
    } catch (error) {
      uncaught.push(`mount: ${String(error)}`);
    }
    const record = () => {
      const view = inspect(renderer);
      const last = timeline[timeline.length - 1];
      if (
        !last ||
        last.screen !== view.screen ||
        last.retry !== view.retryControls
      ) {
        timeline.push({
          at: rel(),
          screen: view.screen,
          retry: view.retryControls,
        });
      }
      return view;
    };
    record();
    for (let elapsed = 0; elapsed < LAUNCH_OBSERVE_MS; elapsed += STEP_MS) {
      try {
        await flush(STEP_MS);
      } catch (error) {
        uncaught.push(`launch@${rel()}: ${String(error)}`);
      }
      record();
    }
    const atSixty = inspect(renderer);
    const launchSignals = storeSignals();
    const hitsDuringLaunch = { ...faultWorld.hits };
    const firstNonLoading = timeline.find(
      entry => entry.screen !== 'LOADING' && entry.screen !== 'BLANK',
    );
    const everError = timeline.some(
      entry =>
        entry.screen === 'ERROR_ROOT' || entry.screen === 'ERROR_PROFILE',
    );
    const errorWithoutControl = timeline.some(
      entry =>
        (entry.screen === 'ERROR_ROOT' || entry.screen === 'ERROR_PROFILE') &&
        entry.retry === 0,
    );

    // Phase 2: heal + retry.
    faultWorld.heal();
    jest.setSystemTime(new Date('2026-03-01T09:00:00.000Z'));
    phaseOffset = LAUNCH_OBSERVE_MS;
    phaseStart = Date.now();
    let pressedRetry = false;
    let recoveredAt: number | null = null;
    let afterHeal = inspect(renderer);
    if (renderer && afterHeal.retryControls > 0)
      pressedRetry = pressRetry(renderer);
    for (let elapsed = 0; elapsed < RECOVERY_OBSERVE_MS; elapsed += STEP_MS) {
      try {
        await flush(STEP_MS);
      } catch (error) {
        uncaught.push(`recovery@${rel()}: ${String(error)}`);
      }
      afterHeal = record();
      if (!pressedRetry && renderer && afterHeal.retryControls > 0)
        pressedRetry = pressRetry(renderer);
      // Recovery may legitimately land on the account the faulted launch
      // transitioned to (refused refresh, corrupt vault cleared).
      const recoveryTargets = new Set([
        ...healthyScreens,
        ...healthyScreensFor(scenario.persona, db, keychain),
      ]);
      if (recoveryTargets.has(afterHeal.screen) && recoveredAt === null)
        recoveredAt = rel();
    }
    const recoverySignals = storeSignals();

    // Phase 3: process kill + healthy relaunch.
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
    resetProcessState();
    mockWorld.google.hasPrevious = scenario.persona === 'legacy-google';
    // The faulted launch may have legitimately changed the account (refused
    // refresh, corrupt vault cleared): relaunch is judged on what is persisted
    // NOW, while `landedOnAccount` judges the faulted launch against BEFORE.
    const relaunchHealthyScreens = healthyScreensFor(
      scenario.persona,
      db,
      keychain,
    );
    let relaunchView: View = inspect(null);
    try {
      act(() => {
        renderer = TestRenderer.create(<App />);
      });
      for (let elapsed = 0; elapsed < RELAUNCH_OBSERVE_MS; elapsed += STEP_MS) {
        await flush(STEP_MS);
      }
      relaunchView = inspect(renderer);
    } catch (error) {
      uncaught.push(`relaunch: ${String(error)}`);
    }
    const relaunchSignals = storeSignals();
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
    await flush(0);

    // ── Persisted state ──
    const vaultAfter = keychain.stored;
    const vaultParsed = vaultAfter === null ? null : safeParse(vaultAfter);
    const vaultRecord =
      vaultParsed && typeof vaultParsed === 'object'
        ? (vaultParsed as Record<string, unknown>)
        : null;
    const vaultIntact =
      vaultAfter === null ||
      (vaultRecord !== null &&
        vaultRecord['version'] === 1 &&
        typeof vaultRecord['refreshToken'] === 'string' &&
        server.issuedRefreshTokens.has(vaultRecord['refreshToken']));
    const kvWrites = db.kvWrites();
    const kvIntact = [...db.kv.entries()].every(([key, value]) => {
      if (value === '') return true;
      if (!kvBefore.has(key) || kvBefore.get(key) !== value)
        return safeParse(value) !== null || !isJsonKey(key);
      return true;
    });
    const bearerLeak =
      [...server.issuedAccessTokens].some(
        token =>
          vaultAfter?.includes(token) ||
          [...db.kv.values()].some(v => v.includes(token)),
      ) || [...db.kv.values()].some(v => v.includes('google-id-token'));
    const destructive = db.destructiveStatements();
    const shotsIntact = db.shotFingerprint() === shotsBefore;

    // ── Credentials ──
    const hadVault = vaultBefore !== null;
    const refused = server.refused;
    const keychainFault = scenario.faults.find(f => f.dep === 'keychain');
    const keychainDestructive =
      keychainFault !== undefined &&
      (keychainFault.mode === 'partial' || keychainFault.mode === 'malformed');
    const credentialsPreserved =
      !hadVault || refused || keychainDestructive || vaultAfter !== null;

    // ── Fake success ──
    const signedInScreenNeedsProfile = !(
      (atSixty.screen === 'ROOT_NAVIGATOR' &&
        !(
          launchSignals.hasProfile && launchSignals.sessionProvider !== null
        )) ||
      (afterHeal.screen === 'ROOT_NAVIGATOR' &&
        !(
          recoverySignals.hasProfile && recoverySignals.sessionProvider !== null
        ))
    );
    const refusedNeverSignedIn = !(
      refused &&
      launchSignals.sessionProvider !== null &&
      launchSignals.sessionProvider !== 'guest'
    );
    const meFault = scenario.faults.find(f => f.dep === 'api-me');
    const meHit = Object.keys(hitsDuringLaunch).some(key =>
      key.startsWith('api-me:'),
    );
    const noReaskOnBrokenProfile = !(
      (scenario.persona === 'vault-no-profile' ||
        scenario.persona === 'legacy-google') &&
      meFault !== undefined &&
      meHit &&
      atSixty.screen === 'ONBOARDING'
    );
    const noFakeSuccess =
      signedInScreenNeedsProfile &&
      refusedNeverSignedIn &&
      noReaskOnBrokenProfile;

    // ── Refresh storm ──
    // MIN_ROTATION_GAP_MS (30s) bounds successful rotations to ~2/min and the
    // retry floor (5s) bounds failures to ~12/min; anything above that is the
    // keeper re-arming faster than its own contract allows.
    const refreshCallsDuringLaunch = server.calls.filter(
      call => call.route === 'refresh' && call.atMs - t0 <= LAUNCH_OBSERVE_MS,
    ).length;

    // ── Silent failure ──
    const firedDeps = new Set(
      Object.keys(hitsDuringLaunch).map(key => key.split(':')[0] as Dependency),
    );
    const silent: string[] = [];
    const traces: Record<string, string> = {};
    // "Healthy" for trace purposes includes the account the faulted launch
    // legitimately transitioned to (refused refresh, corrupt vault cleared).
    const postLaunchHealthy = new Set([
      ...healthyScreens,
      ...healthyScreensFor(scenario.persona, db, keychain),
    ]);
    for (const dep of firedDeps) {
      const trace = surfacedTrace(
        dep,
        scenario,
        atSixty,
        launchSignals,
        timeline,
        {
          hits: hitsDuringLaunch,
          kvWriteKeys: db.kvWriteFailures(),
          kvReadKeys: db.kvReadFailures(),
          kvBefore,
          refused,
          healthy: postLaunchHealthy.has(atSixty.screen),
          refreshCalls: refreshCallsDuringLaunch,
        },
      );
      if (!trace) silent.push(dep);
      else traces[dep] = trace;
    }

    const stuckOrErrorAtSixty =
      atSixty.screen === 'LOADING' ||
      atSixty.screen === 'BLANK' ||
      atSixty.screen === 'ERROR_ROOT' ||
      atSixty.screen === 'ERROR_PROFILE';
    const landedOnAccount =
      healthyScreens.includes(atSixty.screen) ||
      atSixty.screen === 'ERROR_ROOT' ||
      atSixty.screen === 'ERROR_PROFILE' ||
      refused ||
      (keychainDestructive && hadVault);

    const invariants: Record<string, boolean> = {
      noInfiniteSpinner:
        atSixty.screen !== 'LOADING' && atSixty.screen !== 'BLANK',
      visibleControl: !errorWithoutControl,
      recoverable: !stuckOrErrorAtSixty || recoveredAt !== null,
      landedOnAccount,
      relaunchHealthy: relaunchHealthyScreens.includes(relaunchView.screen),
      noFakeSuccess,
      noSilentFailure: silent.length === 0,
      noUncaughtError: uncaught.length === 0,
      vaultIntact,
      kvIntact,
      credentialsPreserved,
      noDestructiveSql: destructive.length === 0 && shotsIntact,
      noBearerPersisted: !bearerLeak,
      noRefreshStorm: refreshCallsDuringLaunch <= MAX_REFRESH_CALLS_PER_MINUTE,
    };
    const failed = Object.entries(invariants)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    const faultsFired: Record<string, boolean> = {};
    for (const fault of scenario.faults) {
      faultsFired[
        `${fault.dep}:${fault.mode}${fault.detail ? `:${fault.detail}` : ''}`
      ] = Object.keys(hitsDuringLaunch).some(key =>
        key.startsWith(`${fault.dep}:`),
      );
    }
    const everyFaultFired = Object.values(faultsFired).every(Boolean);
    return {
      suite: 'appRootFailureInjection',
      scenario: scenario.name,
      seed: scenario.seed,
      inputs: {
        persona: scenario.persona,
        faults: scenario.faults,
        slowMs: scenario.slowMs,
        clockIso: scenario.clockIso,
      },
      observed: {
        timeline,
        firstNonLoadingAtMs: firstNonLoading?.at ?? null,
        screenAt60s: atSixty.screen,
        everError,
        launchSignals,
        pressedRetry,
        recoveredAtMs: recoveredAt,
        screenAfterRecovery: afterHeal.screen,
        recoverySignals,
        relaunchScreen: relaunchView.screen,
        relaunchSignals,
        healthyScreens,
        relaunchHealthyScreens,
        traces,
        refreshCallsDuringLaunch,
        refreshStormAborted: server.stormAborted,
        serverCallCounts: countBy(
          server.calls,
          call => `${call.route}:${call.mode}`,
        ),
        serverCalls: server.calls.slice(0, 40),
        keychainOps: keychain.log,
        vaultAfter:
          vaultAfter === null ? null : (safeParse(vaultAfter) ?? 'UNPARSEABLE'),
        kvWrites,
        destructive,
        silentDependencies: silent,
        uncaught,
        consoleErrors: consoleError.mock.calls.length,
      },
      invariants,
      hits: hitsDuringLaunch,
      ok: failed.length === 0,
      failed,
      faultsFired,
      verdict: !everyFaultFired
        ? 'UNREACHED'
        : failed.length === 0
          ? 'HELD'
          : 'BROKEN',
      deviations: [],
      durationMs: Date.now() - startedWall,
    };
  } finally {
    consoleError.mockRestore();
    if (renderer) {
      act(() => {
        (renderer as TestRenderer.ReactTestRenderer).unmount();
      });
    }
    faultWorld.heal();
    resetProcessState();
  }
}

function isJsonKey(key: string): boolean {
  return (
    key.startsWith('profile:') ||
    key.startsWith('auth.') ||
    key.startsWith('onboarding.') ||
    key.startsWith('notifications.')
  );
}

/**
 * What counts as "the failure was not silent" per dependency. Returns the
 * trace name, or null when the launch ended with no observable consequence.
 * Documented best-effort degradations are named explicitly so the row shows
 * WHICH contract absorbed the fault.
 */
function surfacedTrace(
  dep: Dependency,
  scenario: Scenario,
  atSixty: View,
  signals: ReturnType<typeof storeSignals>,
  timeline: { at: number; screen: Screen; retry: number }[],
  context: {
    hits: Record<string, number>;
    kvWriteKeys: string[];
    kvReadKeys: string[];
    kvBefore: Map<string, string>;
    refused: boolean;
    healthy: boolean;
    refreshCalls: number;
  },
): string | null {
  const errorScreen = timeline.some(
    entry => entry.screen === 'ERROR_ROOT' || entry.screen === 'ERROR_PROFILE',
  );
  const fault = scenario.faults.find(f => f.dep === dep);
  const mode = fault?.mode;
  const transientMode =
    mode === 'slow' || mode === 'hang' || mode === 'timeout';
  const hitKeys = Object.keys(context.hits).filter(key =>
    key.startsWith(`${dep}:`),
  );
  switch (dep) {
    case 'keychain':
      if (transientMode && signals.sessionProvider !== null)
        return 'late-restore-completed';
      if (
        signals.sessionProvider === null &&
        (atSixty.screen === 'WELCOME' || atSixty.screen === 'ERROR_ROOT')
      ) {
        // An unreadable/torn record is cleared on purpose (sessionVault);
        // a read error is treated as "no record" (SR-1).
        return mode === 'malformed' || mode === 'partial'
          ? 'corrupt-vault-cleared(no-message)'
          : 'signed-out-landing(no-message)';
      }
      return signals.sessionProvider !== null ? 'session-restored' : null;
    case 'sqlite': {
      if (signals.localDataError)
        return 'authStore.localDataError(not-rendered)';
      if (signals.hydrateError || errorScreen) return 'hydrateError-screen';
      if (signals.consistencyLoadError) return 'consistencyStore.loadError';
      if (
        signals.notificationPersistFailed ||
        signals.notificationScheduleFailed
      )
        return 'notificationStore.flags';
      if (transientMode && atSixty.screen !== 'LOADING')
        return 'late-read-completed';
      // Launch-time kv writes are caches (consistency ledger, walkthrough
      // seen-flag): their failure is absorbed by design (walkthroughStore
      // suppresses the tour; the ledger is re-derived from shots).
      const bestEffortWritesOnly =
        context.kvWriteKeys.length > 0 &&
        context.kvWriteKeys.every(
          key =>
            key.startsWith('consistency:') ||
            key === 'walkthrough.device-complete',
        );
      if (
        hitKeys.every(key => key.startsWith('sqlite:kv-write:')) &&
        bestEffortWritesOnly &&
        context.healthy
      ) {
        return 'best-effort-cache-write(documented)';
      }
      if (mode !== 'malformed' && mode !== 'partial') return null;
      // Data faults (garbage / incomplete results, acknowledged-but-lost
      // writes) are judged per statement kind; the row is explained only
      // when EVERY kind that fired has no client-visible signal by
      // construction. The relaunch phase judges what lost keys cost.
      const explained: string[] = [];
      for (const kind of new Set(hitKeys.map(key => key.split(':')[1]))) {
        if (kind === 'kv-read') {
          // An incomplete row for a key that had no value is indistinguishable
          // from "no row"; only an incomplete read of a key that HAD a value
          // can change the launch (a garbage read always can).
          if (
            mode === 'partial' &&
            context.kvReadKeys.every(key => !context.kvBefore.has(key))
          ) {
            explained.push('incomplete-rows-for-absent-keys(no-effect)');
          } else return null;
        } else if (kind === 'kv-write') {
          // A write the driver acknowledges but never stores (malformed) or a
          // half-landed write sequence (partial) has no client-visible signal.
          explained.push(
            bestEffortWritesOnly
              ? 'best-effort-cache-write(documented)'
              : 'undetectable-by-client(acknowledged-write-lost)',
          );
        } else if (kind === 'sql') {
          // SQLite result rows are schema-typed (NOT NULL columns): a row-level
          // garbage/truncation fault has no client-detectable signal. Shot
          // rows never decide the landing screen (kv does), so any landed
          // screen qualifies; a stuck launch does not.
          if (atSixty.screen !== 'LOADING' && atSixty.screen !== 'BLANK') {
            explained.push('undetectable-by-client(schema-typed-rows)');
          } else return null;
        } else return null;
      }
      return explained.length > 0 ? explained.join('+') : null;
    }
    case 'api-refresh':
      if (
        signals.sessionProvider === null &&
        (atSixty.screen === 'WELCOME' || context.refused)
      ) {
        return context.refused
          ? 'signed-out-landing(refresh-refused)'
          : 'signed-out-landing';
      }
      if (signals.sessionProvider !== null)
        return 'offline-signed-in(keeper-retries)';
      return null;
    case 'api-me':
      if (signals.hydrateError || errorScreen) return 'hydrateError-screen';
      if (signals.hasProfile) return 'profile-loaded';
      return null;
    case 'api-bootstrap':
    case 'google-sdk':
      if (signals.sessionProvider !== null) return 'session-restored';
      if (atSixty.screen === 'WELCOME') return 'signed-out-landing(no-message)';
      return null;
    case 'notifications':
      if (
        signals.notificationScheduleFailed ||
        signals.notificationPersistFailed
      )
        return 'notificationStore.flags';
      if (transientMode) return 'late-completion';
      // A scheduler that reports success while doing nothing cannot be
      // detected by any client; recorded as such.
      if (mode === 'malformed') return 'undetectable-by-client(lying-success)';
      // Signed-out hydrate only clears stale schedules and swallows the
      // failure on purpose (notificationStore.hydrate: `.catch(() => {})`).
      if (signals.sessionProvider === null)
        return 'signed-out-cancel(best-effort-by-design)';
      return null;
    case 'permissions':
      if (signals.notificationPermission !== 'granted')
        return `permission=${signals.notificationPermission}`;
      if (transientMode) return 'late-completion';
      return null;
    case 'clock':
      if (context.refreshCalls > MAX_REFRESH_CALLS_PER_MINUTE) return null;
      if (signals.sessionProvider !== null) return 'session-kept';
      if (atSixty.screen === 'WELCOME') return 'signed-out-landing';
      return null;
    case 'navigation':
      if (signals.crashEvents > 0 || errorScreen) return 'boundary+telemetry';
      if (mode === 'reject') return 'unhandled-rejection(outside-boundary)';
      // React replays a render that threw once before committing to the
      // boundary, so a single render throw is absorbed by React itself.
      if (mode === 'throw-once' && context.healthy)
        return 'react-render-replay-absorbed';
      return null;
    case 'billing':
      // configureAccessStore runs inside installApiSession (after the
      // bearer rotates); a throw there is a keeper failure it retries with
      // backoff, and the launch itself is decided by auth/app hydration.
      if (signals.sessionProvider !== null)
        return 'session-kept(keeper-retries)';
      if (errorScreen) return 'error-screen';
      // authStore.hydrate: the legacy Google restore is "opportunistic only":
      // any failure lands signed-out without a message and the flag is kept
      // so the next launch retries (the bootstrap did persist the vault).
      if (scenario.persona === 'legacy-google' && atSixty.screen === 'WELCOME')
        return 'legacy-restore-abandoned(by-design,next-launch-retries)';
      return null;
    case 'config':
      if (signals.sessionProvider !== null) return 'offline-signed-in';
      if (atSixty.screen === 'WELCOME') return 'signed-out-landing';
      return null;
    default:
      return null;
  }
}

// ─── Triage ──────────────────────────────────────────────────────────────────

/**
 * Deviations reproduced by this campaign and reported to the coordinator.
 * A row whose failed invariants are ALL explained by a deviation whose
 * `matches` predicate holds is BROKEN-but-triaged; anything else fails the
 * suite. Remove an entry once the production fix lands (the guard test below
 * fails when a triaged deviation stops reproducing).
 */
interface Deviation {
  id: string;
  summary: string;
  invariants: string[];
  matches: (row: StressRow) => boolean;
}

function faultsOf(row: StressRow): Fault[] {
  return row.inputs['faults'] as Fault[];
}

function has(
  row: StressRow,
  dep: Dependency,
  modes: readonly FaultMode[],
  detail?: readonly string[],
): boolean {
  return faultsOf(row).some(
    fault =>
      fault.dep === dep &&
      modes.includes(fault.mode) &&
      (detail === undefined || detail.includes(fault.detail ?? 'all')),
  );
}

function screenAt60(row: StressRow): Screen {
  return row.observed['screenAt60s'] as Screen;
}

function persona(row: StressRow): Persona {
  return row.inputs['persona'] as Persona;
}

const STUCK_INVARIANTS = [
  'noInfiniteSpinner',
  'landedOnAccount',
  'noSilentFailure',
  'recoverable',
];

const KNOWN_DEVIATIONS: Deviation[] = [
  {
    id: 'SR-1 keychain read throw/reject lands signed-out without message or retry',
    summary:
      'sessionVault.loadPersistedSession is fail-soft: a Keychain read error (throw or reject) is treated as "no record", so a signed-in user lands on Welcome with no explanation and no in-session retry; the record survives and the next launch restores it. (authStore.hydrate → loadPersistedSession)',
    invariants: ['landedOnAccount', 'noSilentFailure'],
    matches: row =>
      has(row, 'keychain', ['throw', 'reject']) &&
      (persona(row) === 'vault-profile' ||
        persona(row) === 'vault-no-profile') &&
      (screenAt60(row) === 'WELCOME' || screenAt60(row) === 'ERROR_ROOT'),
  },
  {
    id: 'SR-2 keychain read that never answers blocks launch on the loading screen indefinitely',
    summary:
      'authStore.hydrate awaits loadPersistedSession() with no deadline, before SQLite local-mode is consulted; a hung Keychain read leaves "Getting things ready" on screen forever (both signed-in and guest devices) with no control.',
    invariants: STUCK_INVARIANTS,
    matches: row =>
      has(row, 'keychain', ['hang']) && screenAt60(row) === 'LOADING',
  },
  {
    id: 'SR-3 SQLite statement that hangs or is very slow on the launch path blocks launch indefinitely, even with a valid Keychain session',
    summary:
      'authStore.hydrate awaits getKv(legacy session) and getKv(local-mode) with no deadline before it adopts the vault session; appStore.hydrate awaits getKv(profile) and, after fetching the canonical profile, `await setKv(profile:<owner>)` on the same path. A hung statement, or ≥5 serial statements at 14s each, keeps the loading screen up past 60s with no control, although the comment says SQLite "never decides the sign-in state".',
    invariants: STUCK_INVARIANTS,
    matches: row =>
      has(row, 'sqlite', ['hang', 'timeout', 'slow']) &&
      screenAt60(row) === 'LOADING',
  },
  {
    id: 'SR-4 SQLite read fault at launch silently signs out a device whose sign-in state lives only in SQLite',
    summary:
      'For a device whose sign-in state lives only in SQLite (auth.local-mode = guest, or the legacy auth.last-provider = google flag), any kv-read fault (open/throw/reject/malformed/partial) makes hydrate land on Welcome: localDataError is set but never rendered by Gate, an incomplete row sets nothing at all. Data is intact and the next launch restores it. Note: continueAsGuest has no UI caller in this build, so only legacy devices carry either flag.',
    invariants: ['landedOnAccount', 'noSilentFailure'],
    matches: row =>
      has(
        row,
        'sqlite',
        ['throw', 'reject', 'malformed', 'partial'],
        ['open', 'all', 'kv-read'],
      ) &&
      (persona(row) === 'guest' || persona(row) === 'legacy-google') &&
      screenAt60(row) === 'WELCOME',
  },
  {
    id: 'SR-5 malformed or partial /v1/me body re-asks the onboarding questionnaire',
    summary:
      'fetchCanonicalOnboardingProfile returns null for a 200 whose body is not a complete profile, and appStore.hydrate treats null as "onboarding pending": a signed-in user with a server profile is shown the questionnaire (fake fresh-account state) instead of the retryable "profile couldn’t load" screen; completing it would overwrite the server profile.',
    invariants: ['landedOnAccount', 'noFakeSuccess', 'noSilentFailure'],
    matches: row =>
      has(row, 'api-me', ['malformed', 'partial']) &&
      (persona(row) === 'vault-no-profile' ||
        persona(row) === 'legacy-google') &&
      screenAt60(row) === 'ONBOARDING',
  },
  {
    id: 'SR-6 legacy Google silent-restore that never answers blocks launch indefinitely',
    summary:
      'authStore.hydrate awaits restoreGoogleSessionSilently (GoogleSignin.configure/signInSilently) with no deadline on the legacy last-provider path; a hung SDK keeps the loading screen up forever.',
    invariants: STUCK_INVARIANTS,
    matches: row =>
      has(row, 'google-sdk', ['hang']) &&
      persona(row) === 'legacy-google' &&
      screenAt60(row) === 'LOADING',
  },
  {
    id: 'SR-7 signed-in launch without a usable bearer re-asks the onboarding questionnaire when no local profile exists',
    summary:
      'restorePersistedSession resolves "offline" after 8s (refresh slow/hung/5xx/429/malformed/expiresAt missing) or at once (no apiBaseUrl), and appStore.hydrate then sees getApiSession() === null: with no local profile:<owner> row it lands hydrated with profile=null and Gate renders the onboarding questionnaire to a signed-in account whose profile lives on the server (e.g. reinstall + flaky network: the Keychain vault survives reinstall, SQLite does not). Expected: the retryable "profile couldn’t load" screen or a wait for the bearer.',
    invariants: ['landedOnAccount'],
    matches: row =>
      persona(row) === 'vault-no-profile' &&
      screenAt60(row) === 'ONBOARDING' &&
      (has(row, 'api-refresh', [
        'hang',
        'slow',
        'timeout',
        'malformed',
        'partial',
        'reject',
        'throw',
        'status-500',
        'status-429',
      ]) ||
        has(row, 'config', ['throw', 'malformed', 'partial']) ||
        has(row, 'clock', [
          'expires-missing',
          'expires-string',
          'expires-zero',
        ])),
  },
  {
    id: 'SR-8 bearer expiry more than ~24.8 days ahead of the device clock turns the keeper into a refresh-per-millisecond storm',
    summary:
      'sessionKeeper.schedule passes `untilExpiry - 60s` straight to setTimeout; a delay above 2^31-1 ms (device clock behind the server by ≥25 days, or a long-lived expiresAt) is clamped to 1 ms by Node/browser timer semantics (jest fake timers reproduce the same clamp), so the keeper rotates, re-arms at 1 ms, rotates again — 60k /v1/auth/refresh round trips per minute (VERIFIED under Jest/Node timer semantics; whether React Native’s iOS Timing module clamps identically is UNKNOWN from Linux).',
    invariants: ['noRefreshStorm', 'noSilentFailure'],
    matches: row => has(row, 'clock', ['device-behind-1y', 'expires-huge']),
  },
];

function triage(row: StressRow): { triaged: boolean; deviations: string[] } {
  if (row.ok) return { triaged: true, deviations: [] };
  const matched = KNOWN_DEVIATIONS.filter(deviation => deviation.matches(row));
  const explained = new Set(matched.flatMap(deviation => deviation.invariants));
  const unexplained = row.failed.filter(name => !explained.has(name));
  return {
    triaged: unexplained.length === 0,
    deviations: matched.map(deviation => deviation.id),
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;
const rows: StressRow[] = [];

const STRESS_ITER = envInt('STRESS_ITER', 24);
const STRESS_SEED_START = envInt('STRESS_SEED_START', 1);
const ONLY_SEED = envString('STRESS_SEED');
const ONLY_CASE = envString('STRESS_CASE');

const seededRows = Array.from({ length: STRESS_ITER }, (_, i) =>
  seededScenario(STRESS_SEED_START + i),
);
const scenarios =
  ONLY_SEED !== null
    ? [seededScenario(Number(ONLY_SEED))]
    : [...fixedMatrix(), ...seededRows].filter(
        scenario => ONLY_CASE === null || scenario.name.includes(ONLY_CASE),
      );

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
  const summary = summarize(rows);
  const triaged = rows.map(row => ({
    scenario: row.scenario,
    seed: row.seed,
    ...triage(row),
  }));
  writeJsonArtifact('appRootFailureInjection.rows.json', rows);
  writeJsonArtifact('appRootFailureInjection.summary.json', {
    ...summary,
    knownDeviations: KNOWN_DEVIATIONS.map(deviation => ({
      id: deviation.id,
      summary: deviation.summary,
    })),
    untriaged: triaged.filter(entry => !entry.triaged),
    reproducedDeviations: [
      ...new Set(
        rows
          .filter(row => row.verdict === 'BROKEN')
          .flatMap(row => row.deviations),
      ),
    ],
    env: { STRESS_ITER, STRESS_SEED_START, ONLY_SEED, ONLY_CASE },
  });
});

describe('mod-app-root failure injection (fixed matrix + seeded campaign)', () => {
  it.each(scenarios.map(scenario => [scenario.name, scenario] as const))(
    '%s',
    async (_name, scenario) => {
      const row = await runScenario(scenario);
      const verdict = triage(row);
      row.deviations = verdict.deviations;
      rows.push(row);
      // The fixed matrix must only name reachable injections.
      if (scenario.seed === null && row.verdict === 'UNREACHED') {
        throw new Error(
          `fixed scenario ${row.scenario} armed a fault that never fired: ${JSON.stringify(row.faultsFired)}`,
        );
      }
      if (!verdict.triaged) {
        throw new Error(
          `UNTRIAGED BROKEN ${row.scenario}: failed=${row.failed.join(',')}\n` +
            JSON.stringify(
              { inputs: row.inputs, observed: row.observed, hits: row.hits },
              null,
              2,
            ),
        );
      }
    },
  );

  it('every triaged deviation is still reproduced by the fixed matrix (remove it once fixed)', () => {
    if (ONLY_SEED !== null || ONLY_CASE !== null) return;
    const seen = new Set(
      rows
        .filter(row => row.verdict === 'BROKEN')
        .flatMap(row => row.deviations),
    );
    expect([...seen].sort()).toEqual(
      KNOWN_DEVIATIONS.map(deviation => deviation.id).sort(),
    );
  });

  it('RootErrorBoundary alone: retry re-renders the child and records one crash per catch', () => {
    stabilitySlo.reset();
    let shouldThrow = true;
    function Child() {
      if (shouldThrow) throw new Error('boom');
      return <Button label="child-ok" onPress={() => undefined} />;
    }
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <RootErrorBoundary>
          <Child />
        </RootErrorBoundary>,
      );
    });
    expect(inspect(renderer).retryControls).toBe(1);
    expect(
      stabilitySlo.events().filter(event => event.kind === 'crash'),
    ).toHaveLength(1);
    shouldThrow = false;
    pressRetry(renderer);
    expect(
      renderer.root
        .findAllByType(Button)
        .some(node => node.props.label === 'child-ok'),
    ).toBe(true);
    act(() => renderer.unmount());
    consoleError.mockRestore();
  });
});
