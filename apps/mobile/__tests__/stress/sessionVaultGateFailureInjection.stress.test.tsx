/**
 * STRESS / failure-injection — sessionVault at the launch surface.
 *
 * Mounts the REAL <App /> (Gate + RootErrorBoundary) over the real authStore /
 * appStore / sessionKeeper / sessionLifecycle with only the process edges
 * faked: the FaultyKeychain from `stress-harness/session-vault`, a
 * FakeLocalDb, and a scripted fetch for /v1/auth/refresh + /v1/me.
 *
 * Every scenario is a cold launch with ONE persisted Keychain state
 * (valid / accepted-noisy / garbage / oversized / empty) and up to three
 * armed Keychain faults (get / set / reset drawn from the catalogue), against
 * a server in {rotate, 401, 500, network, hang} and a SQLite in {ok,
 * open-throws}. The clock is advanced 60 s (+5 s for late persists).
 *
 * Invariants:
 *   noCrash               RootErrorBoundary never renders
 *   noInfiniteSpinner60s  the gate has left LoadingState by 60 s
 *   visibleControl        whatever it landed on carries a user control:
 *                         Welcome/Sign-in (sign in again), ErrorState with a
 *                         retry, or the app itself
 *   noFakeSignIn          signed in ⇒ the store held a contract-valid record
 *                         for exactly that account and the read succeeded
 *   noImplicitSignOut     valid record + readable Keychain + server did not
 *                         refuse (401) ⇒ still signed in as that account,
 *                         whatever else failed (SQLite, network, hang, 500)
 *   revokedSignsOut       server 401 ⇒ signed out
 *   vaultIntegrity        final Keychain content ∈ {unchanged, the rotated
 *                         record, empty, partial-write prefix when the
 *                         partial set fault is armed}
 *   rotationPersisted     rotate + working set ⇒ the vault holds the token
 *                         the server issued
 *   readFaultKeepsRecord  a failed Keychain read never destroys the record
 *   noTokenInKv           no bearer / refresh token ever lands in SQLite kv
 *   shotsPreserved        local_shot rows identical before/after
 *   noDestructiveSql      no DROP / DELETE-without-WHERE against local data
 *
 * Rows → artifacts/stress/session-vault/gate-rows.json (+ summary).
 * Replay: STRESS_SEED=<seed> npx jest __tests__/stress/sessionVaultGate…
 */
import React from 'react';
import { AppState, NativeModules, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { FakeLocalDb } from '../../xc-harness/lifecycle-persistence/fakeLocalDb';
import { nodeProcess } from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  makePrng,
  pick,
  validProfile,
} from '../../xc-harness/lifecycle-persistence/seeds';
import {
  GET_FAULTS,
  RECORD_CORRUPTIONS,
  RESET_FAULTS,
  SET_FAULTS,
  deliversRealResult,
  mockKeychain,
  referenceParse,
  seededRecord,
  stressIterations,
  summarizeRows,
  writeStressArtifact,
  type KeychainFault,
  type RecordCorruption,
  type StressRow,
  type VaultRecord,
} from '../../stress-harness/session-vault/keychainFaults';

type Harness =
  typeof import('../../stress-harness/session-vault/keychainFaults');

// ─── Module seams ────────────────────────────────────────────────────────────

jest.mock('react-native-keychain', () => {
  const harness = jest.requireActual(
    '../../stress-harness/session-vault/keychainFaults',
  ) as Harness;
  return harness.buildKeychainModule(harness.mockKeychain);
});

const mockDb = { current: new FakeLocalDb() };
jest.mock('../../src/data/db', () => ({
  getDb: () => mockDb.current.handle(),
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
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => ({
    permissionState: async () => 'granted',
    requestPermission: async () => 'granted',
    applyPlan: async () => {},
    cancelAllPlanned: async () => {},
    openSystemSettings: async () => {},
  }),
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
jest.mock('../../src/navigation/RootNavigator', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    RootNavigator: () => R.createElement(RN.Text, null, 'ROOT_NAVIGATOR'),
  };
});
jest.mock('../../src/screens/OnboardingScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    OnboardingScreen: () => R.createElement(RN.Text, null, 'ONBOARDING'),
  };
});
jest.mock('../../src/screens/WelcomeScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    WelcomeScreen: (props: { onSignIn?: () => void }) =>
      R.createElement(RN.Text, null, `WELCOME:signIn=${typeof props.onSignIn}`),
  };
});
jest.mock('../../src/screens/SignInScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    SignInScreen: (props: { onBack?: () => void }) =>
      R.createElement(RN.Text, null, `SIGN_IN:back=${typeof props.onBack}`),
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
jest.mock('../../src/design/components', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    LoadingState: (props: { label?: string }) =>
      R.createElement(RN.Text, null, `LOADING:${props.label ?? ''}`),
    ErrorState: (props: {
      title: string;
      detail?: string;
      onRetry?: () => void;
    }) =>
      R.createElement(
        RN.Text,
        null,
        `ERROR:${props.title}:retry=${typeof props.onRetry}`,
      ),
    BrandSpinner: () => null,
    BrandButton: () => null,
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
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

// ─── Scripted server ─────────────────────────────────────────────────────────

type ServerMode = 'rotate' | 'refuse-401' | 'error-500' | 'network' | 'hang';
const SERVER_MODES: readonly ServerMode[] = [
  'rotate',
  'refuse-401',
  'error-500',
  'network',
  'hang',
];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class ScriptedServer {
  mode: ServerMode = 'rotate';
  /** Single-use refresh tokens: only the latest issued (or the seeded
   * original) is honoured; anything older is refused like production. */
  strict = false;
  original: string | null = null;
  readonly issued: string[] = [];
  readonly refreshTokensSeen: string[] = [];
  readonly refused: string[] = [];
  meCalls = 0;
  private counter = 0;

  current(): string | null {
    return this.issued[this.issued.length - 1] ?? this.original;
  }

  readonly fetch = async (
    url: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    if (url === `${API_BASE}/v1/auth/refresh`) {
      const body = JSON.parse(String(init.body ?? '{}')) as {
        refreshToken?: string;
      };
      const presented = String(body.refreshToken ?? '');
      this.refreshTokensSeen.push(presented);
      if (
        this.strict &&
        this.mode === 'rotate' &&
        presented !== this.current()
      ) {
        this.refused.push(presented);
        return jsonResponse(401, {
          error: { message: 'refresh token revoked' },
        });
      }
      switch (this.mode) {
        case 'hang':
          return new Promise<Response>((_, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new Error('AbortError (simulated fetch abort)')),
            );
          });
        case 'refuse-401':
          return jsonResponse(401, { error: { message: 'revoked' } });
        case 'error-500':
          return jsonResponse(500, { error: { message: 'boom' } });
        case 'network':
          throw new TypeError('Network request failed');
        default: {
          this.counter += 1;
          const refresh = `rotated-${this.counter}`;
          this.issued.push(refresh);
          return jsonResponse(200, {
            session: {
              accessToken: `access-${this.counter}`,
              refreshToken: refresh,
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            },
          });
        }
      }
    }
    if (url === `${API_BASE}/v1/me`) {
      this.meCalls += 1;
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
      return new Response(null, { status: 204 });
    }
    return jsonResponse(404, { error: { message: 'unexpected route' } });
  };
}

// ─── Scenario space ──────────────────────────────────────────────────────────

type VaultKind = 'valid' | 'accepted-noisy' | 'garbage' | 'oversized' | 'empty';
const VAULT_KINDS: readonly VaultKind[] = [
  'valid',
  'valid',
  'valid',
  'accepted-noisy',
  'garbage',
  'oversized',
  'empty',
];
type DbMode = 'ok' | 'open-throws';

interface GateScenario {
  name: string;
  seed: number;
  vault: VaultKind;
  corruption: RecordCorruption | null;
  faults: KeychainFault[];
  server: ServerMode;
  db: DbMode;
  profile: boolean;
}

const ACCEPTED = RECORD_CORRUPTIONS.filter(
  c => c.expect === 'accept' && c.category === 'accepted',
);
const GARBAGE = RECORD_CORRUPTIONS.filter(
  c => c.expect === 'reject' && c.category !== 'oversized',
);
const OVERSIZED = RECORD_CORRUPTIONS.filter(c => c.category === 'oversized');

function seededScenario(seed: number): GateScenario {
  const rng = makePrng(seed);
  const vault = pick(rng, VAULT_KINDS);
  const faults: KeychainFault[] = [];
  if (rng() < 0.55) faults.push(pick(rng, GET_FAULTS));
  if (rng() < 0.45) faults.push(pick(rng, SET_FAULTS));
  if (rng() < 0.35) faults.push(pick(rng, RESET_FAULTS));
  return {
    name: `seeded/${seed}`,
    seed,
    vault,
    corruption:
      vault === 'accepted-noisy'
        ? pick(rng, ACCEPTED)
        : vault === 'garbage'
          ? pick(rng, GARBAGE)
          : vault === 'oversized'
            ? pick(rng, OVERSIZED)
            : null,
    faults,
    server: pick(rng, SERVER_MODES),
    db: rng() < 0.15 ? 'open-throws' : 'ok',
    profile: rng() < 0.7,
  };
}

function catalogueScenarios(): GateScenario[] {
  const out: GateScenario[] = [];
  let index = 0;
  for (const fault of GET_FAULTS) {
    index += 1;
    out.push({
      name: `catalogue/${fault.id}`,
      seed: 100_000 + index,
      vault: 'valid',
      corruption: null,
      faults: [fault],
      server: 'rotate',
      db: 'ok',
      profile: true,
    });
  }
  for (const fault of SET_FAULTS) {
    index += 1;
    out.push({
      name: `catalogue/${fault.id}`,
      seed: 100_000 + index,
      vault: 'valid',
      corruption: null,
      faults: [fault],
      server: 'rotate',
      db: 'ok',
      profile: true,
    });
  }
  for (const fault of RESET_FAULTS) {
    index += 1;
    out.push({
      name: `catalogue/${fault.id}/garbage`,
      seed: 100_000 + index,
      vault: 'garbage',
      corruption: GARBAGE[index % GARBAGE.length] ?? null,
      faults: [fault],
      server: 'rotate',
      db: 'ok',
      profile: true,
    });
    index += 1;
    out.push({
      name: `catalogue/${fault.id}/revoked`,
      seed: 100_000 + index,
      vault: 'valid',
      corruption: null,
      faults: [fault],
      server: 'refuse-401',
      db: 'ok',
      profile: true,
    });
  }
  return out;
}

// ─── Known deviations ────────────────────────────────────────────────────────

const KNOWN_DEVIATIONS = {
  'SV-FI-3':
    'savePersistedSession() returning false / hanging after the server rotated the refresh token is ignored (authStore.ts adoptRotatedTokens: `void persistSession(...)`), so the vault keeps the now-dead token; the very next cold launch presents it, gets 401 and lands signed out — a silent, unretried durable-write failure',
  'SV-FI-4':
    'A malformed getGenericPassword RESULT (object without a string password) makes loadPersistedSession() call clearPersistedSession() (sessionVault.ts:114): the VALID stored session is deleted and every later launch lands signed out',
  'SV-FI-1':
    'getGenericPassword never settles ⇒ loadPersistedSession never settles (no timeout, sessionVault.ts:109) ⇒ authStore.hydrate() blocks at authStore.ts:580 ⇒ Gate stays on LoadingState("Getting things ready") past 60 s with no retry/back control',
  'SV-FI-2':
    'resetGenericPassword never settles while the vault holds garbage ⇒ loadPersistedSession awaits clearPersistedSession forever (sessionVault.ts:114) ⇒ same launch hang as SV-FI-1',
} as const;
type DeviationId = keyof typeof KNOWN_DEVIATIONS;

function classifyDeviation(
  scenario: GateScenario,
  invariant: string,
): DeviationId | null {
  const get = scenario.faults.find(f => f.op === 'get');
  const set = scenario.faults.find(f => f.op === 'set');
  const reset = scenario.faults.find(f => f.op === 'reset');
  if (invariant === 'readFaultKeepsRecord') {
    return get?.category === 'malformed' ? 'SV-FI-4' : null;
  }
  if (invariant === 'relaunchKeepsSession') {
    const setLost =
      set !== undefined &&
      (!deliversRealResult(set) || (set.delayMs ?? 0) >= BUDGET_MS);
    return setLost && scenario.server === 'rotate' ? 'SV-FI-3' : null;
  }
  if (invariant !== 'noInfiniteSpinner60s' && invariant !== 'visibleControl') {
    return null;
  }
  if (get?.category === 'never-resolves') return 'SV-FI-1';
  const readGarbage =
    deliversRealResult(get ?? null) &&
    referenceParse(scenario.corruption?.raw() ?? null) === null &&
    scenario.corruption !== null;
  if (reset?.category === 'never-resolves' && readGarbage) return 'SV-FI-2';
  return null;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const BUDGET_MS = 60_000;
const LATE_PERSIST_MS = 5_000;

function renderedText(
  renderer: ReturnType<typeof TestRenderer.create> | null,
): string {
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

type Landing = 'spinner' | 'signed-out' | 'error-retry' | 'signed-in' | 'crash';

function landingOf(text: string): Landing {
  if (text.includes('ERROR:Something went wrong')) return 'crash';
  if (text.includes('LOADING:')) return 'spinner';
  if (text.includes('WELCOME:') || text.includes('SIGN_IN:'))
    return 'signed-out';
  if (text.includes('ERROR:')) return 'error-retry';
  if (text.includes('ROOT_NAVIGATOR') || text.includes('ONBOARDING')) {
    return 'signed-in';
  }
  return 'spinner';
}

function hasControl(text: string, landing: Landing): boolean {
  switch (landing) {
    case 'signed-out':
      return text.includes('signIn=function') || text.includes('back=function');
    case 'error-retry':
      return text.includes('retry=function');
    case 'signed-in':
      return true;
    default:
      return false;
  }
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
    localDataError: null,
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

const rows: StressRow[] = [];

async function runScenario(scenario: GateScenario): Promise<StressRow> {
  const startedReal = jest.getRealSystemTime();
  jest.setSystemTime(new Date('2026-03-01T09:00:00.000Z'));

  // Persisted world.
  const db = new FakeLocalDb();
  mockDb.current = db;
  mockKeychain.reset();
  const record: VaultRecord | null =
    scenario.vault === 'valid' ? seededRecord(scenario.seed) : null;
  if (record) mockKeychain.seed(record);
  if (scenario.corruption) mockKeychain.seed(scenario.corruption.raw());
  const rawBefore = mockKeychain.raw();
  const recordBefore = referenceParse(rawBefore);
  const owner = recordBefore
    ? canonicalDataOwner(recordBefore.canonicalAppUserId)
    : null;
  if (owner) {
    db.seedShots(owner, 25, 'real');
    if (scenario.profile) {
      db.kv.set(`profile:${owner}`, JSON.stringify(validProfile()));
    }
  }
  db.seedShots('other-owner', 3, 'stranger');
  db.kv.set('walkthrough.device-complete', JSON.stringify({ version: 1 }));
  const shotsBefore = db.shotFingerprint();
  if (scenario.db === 'open-throws') {
    db.faults = { openThrows: 'SQLITE_CANTOPEN (simulated)' };
  }
  const server = new ScriptedServer();
  server.mode = scenario.server;
  server.original = recordBefore?.refreshToken ?? null;
  (globalThis as { fetch: unknown }).fetch = server.fetch;
  for (const fault of scenario.faults) mockKeychain.arm(fault);

  resetProcessState();
  let renderer: ReturnType<typeof TestRenderer.create> | null = null;
  act(() => {
    renderer = TestRenderer.create(<App />);
  });
  const view = renderer as ReturnType<typeof TestRenderer.create> | null;

  // Advance in slices so the moment the spinner clears is stamped.
  let spinnerClearedAt: number | null = null;
  let elapsed = 0;
  while (elapsed < BUDGET_MS) {
    await flush(500);
    elapsed += 500;
    if (
      spinnerClearedAt === null &&
      landingOf(renderedText(view)) !== 'spinner'
    ) {
      spinnerClearedAt = elapsed;
    }
  }
  const textAt60 = renderedText(view);
  const landing = landingOf(textAt60);
  await flush(LATE_PERSIST_MS);

  const auth = useAuthStore.getState();
  const rawAfter = mockKeychain.raw();
  const recordAfter = referenceParse(rawAfter);
  const get = scenario.faults.find(f => f.op === 'get') ?? null;
  const set = scenario.faults.find(f => f.op === 'set') ?? null;
  const reset = scenario.faults.find(f => f.op === 'reset') ?? null;
  const readOk = deliversRealResult(get);
  const garbageBefore = rawBefore !== null && recordBefore === null;
  const readFailed = get !== null && !readOk;
  const setWorks = deliversRealResult(set) && (set?.delayMs ?? 0) < BUDGET_MS;
  const revoked = scenario.server === 'refuse-401';
  const rotated = server.issued[server.issued.length - 1] ?? null;
  const expectedRotatedRecord: VaultRecord | null =
    recordBefore && rotated ? { ...recordBefore, refreshToken: rotated } : null;
  const partialArmed = set?.storeEffect === 'partial';

  const invariants: Record<string, boolean> = {};
  invariants['noCrash'] = landing !== 'crash';
  invariants['noInfiniteSpinner60s'] = landing !== 'spinner';
  invariants['visibleControl'] = hasControl(textAt60, landing);
  invariants['noFakeSignIn'] =
    auth.session === null ||
    (recordBefore !== null &&
      readOk &&
      auth.session.canonicalAppUserId === recordBefore.canonicalAppUserId);
  if (recordBefore && readOk && !revoked) {
    invariants['noImplicitSignOut'] =
      auth.session !== null &&
      auth.session.canonicalAppUserId === recordBefore.canonicalAppUserId;
  }
  if (recordBefore && readOk && revoked) {
    invariants['revokedSignsOut'] = auth.session === null;
  }
  if (readFailed && !garbageBefore) {
    invariants['readFaultKeepsRecord'] = rawAfter === rawBefore;
  }
  const sameAsBefore = rawAfter === rawBefore;
  const isRotated =
    recordAfter !== null &&
    expectedRotatedRecord !== null &&
    JSON.stringify(recordAfter) === JSON.stringify(expectedRotatedRecord) &&
    rawAfter !== null &&
    referenceParse(rawAfter) !== null &&
    Object.keys(JSON.parse(rawAfter) as object).length === 6;
  const isPartial =
    partialArmed &&
    rawAfter !== null &&
    expectedRotatedRecord !== null &&
    referenceParse(rawAfter) === null;
  invariants['vaultIntegrity'] =
    sameAsBefore || rawAfter === null || isRotated || isPartial;
  if (recordBefore && readOk && scenario.server === 'rotate' && setWorks) {
    invariants['rotationPersisted'] =
      rotated !== null && recordAfter?.refreshToken === rotated;
  }
  if (readOk && garbageBefore && deliversRealResult(reset)) {
    invariants['garbageDiscarded'] = rawAfter === null;
  }
  const tokens = [
    recordBefore?.refreshToken,
    ...server.issued,
    ...server.issued.map((_, i) => `access-${i + 1}`),
  ].filter((t): t is string => typeof t === 'string' && t.length > 0);
  invariants['noTokenInKv'] = db
    .kvWrites()
    .every(w => tokens.every(t => !w.value.includes(t)));
  if (scenario.db === 'ok') {
    invariants['shotsPreserved'] = db.shotFingerprint() === shotsBefore;
  }
  invariants['noDestructiveSql'] = db.destructiveStatements().length === 0;

  act(() => {
    view?.unmount();
  });
  mockKeychain.arm(null);
  resetProcessState();
  // Drain anything the unmount left scheduled.
  await flush(1_000);

  // Cold relaunch with a healthy Keychain and the network back, against a
  // server that only honours the token it last issued: what the user sees
  // next time they open the app after this launch.
  const rawBeforeRelaunch = mockKeychain.raw();
  const recordBeforeRelaunch = referenceParse(rawBeforeRelaunch);
  server.strict = true;
  if (server.mode !== 'refuse-401') server.mode = 'rotate';
  db.faults = {};
  const opsBeforeRelaunch = mockKeychain.calls.length;
  let relaunch: ReturnType<typeof TestRenderer.create> | null = null;
  act(() => {
    relaunch = TestRenderer.create(<App />);
  });
  const relaunchView = relaunch as ReturnType<
    typeof TestRenderer.create
  > | null;
  await flush(10_000);
  const relaunchText = renderedText(relaunchView);
  const relaunchLanding = landingOf(relaunchText);
  const relaunchAuth = useAuthStore.getState();
  invariants['relaunchNoCrash'] = relaunchLanding !== 'crash';
  invariants['relaunchNoSpinner10s'] = relaunchLanding !== 'spinner';
  invariants['relaunchNoFakeSignIn'] =
    relaunchAuth.session === null ||
    (recordBeforeRelaunch !== null &&
      relaunchAuth.session.canonicalAppUserId ===
        recordBeforeRelaunch.canonicalAppUserId);
  if (auth.session !== null && !revoked) {
    invariants['relaunchKeepsSession'] =
      relaunchAuth.session !== null &&
      relaunchAuth.session.canonicalAppUserId ===
        auth.session.canonicalAppUserId;
  }
  const relaunchObserved = {
    landing: relaunchLanding,
    text: relaunchText,
    authSession: relaunchAuth.session
      ? {
          provider: relaunchAuth.session.provider,
          id: relaunchAuth.session.canonicalAppUserId,
        }
      : null,
    vaultBefore: mockKeychainClass(rawBeforeRelaunch),
    vaultAfter: mockKeychainClass(mockKeychain.raw()),
    presented: server.refreshTokensSeen.slice(
      server.refreshTokensSeen.length -
        Math.max(0, server.refused.length + server.issued.length),
    ),
    refused: server.refused,
    keychainOps: mockKeychain.calls.slice(opsBeforeRelaunch).map(c => c.op),
  };
  act(() => {
    relaunchView?.unmount();
  });
  resetProcessState();
  await flush(1_000);

  const knownDeviations: string[] = [];
  const failed: string[] = [];
  for (const [name, held] of Object.entries(invariants)) {
    if (held) continue;
    const deviation = classifyDeviation(scenario, name);
    if (deviation) knownDeviations.push(`${deviation}:${name}`);
    else failed.push(name);
  }
  const row: StressRow = {
    suite: 'sessionVaultGateFailureInjection',
    campaign: scenario.name.startsWith('catalogue/')
      ? 'gate/catalogue'
      : 'gate/seeded',
    scenario: scenario.name,
    seed: scenario.seed,
    faults: scenario.faults.map(f => f.id),
    inputs: {
      vault: scenario.vault,
      corruption: scenario.corruption?.id ?? null,
      server: scenario.server,
      db: scenario.db,
      profile: scenario.profile,
      token: recordBefore?.refreshToken ?? null,
    },
    observed: {
      landing,
      textAt60,
      spinnerClearedAtMs: spinnerClearedAt,
      authSession: auth.session
        ? {
            provider: auth.session.provider,
            id: auth.session.canonicalAppUserId,
          }
        : null,
      hydrated: auth.hydrated,
      localDataError: auth.localDataError?.code ?? null,
      refreshTokensSeen: server.refreshTokensSeen,
      issued: server.issued,
      meCalls: server.meCalls,
      vaultBefore: mockKeychainClass(rawBefore),
      vaultAfter: mockKeychainClass(rawAfter),
      vaultAfterToken: recordAfter?.refreshToken ?? null,
      keychainOps: mockKeychain.calls
        .slice(0, opsBeforeRelaunch)
        .map(c => `${c.op}${c.fault ? `!${c.fault}` : ''}`),
      relaunch: relaunchObserved,
    },
    invariants,
    ok: failed.length === 0,
    failed,
    knownDeviations,
    durationMs: jest.getRealSystemTime() - startedReal,
  };
  rows.push(row);
  return row;
}

function mockKeychainClass(raw: string | null): string {
  if (raw === null) return 'empty';
  return referenceParse(raw)
    ? `valid(${raw.length}b)`
    : `garbage(${raw.length}b)`;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;
const SEEDED_COUNT = stressIterations('STRESS_ITER_GATE', 120);
const seedFilter = nodeProcess.env['STRESS_SEED'];

beforeAll(() => {
  jest.useFakeTimers();
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((() => ({
    remove: () => {},
  })) as unknown as typeof AppState.addEventListener);
  nativeModules.PickleAuth = { signInWithApple: jest.fn() };
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  delete nativeModules.PickleAuth;
  mockKeychain.reset();
  jest.useRealTimers();
  writeStressArtifact('gate-rows.json', rows);
  writeStressArtifact('gate-summary.json', {
    ...summarizeRows(rows),
    knownDeviationCatalogue: KNOWN_DEVIATIONS,
    iterations: { seeded: SEEDED_COUNT },
  });
});

describe('sessionVault failure injection at the launch gate', () => {
  // Replay: STRESS_SEED selects one row — catalogue seeds are 100001+,
  // anything else is a seeded launch.
  const replaySeed = seedFilter === undefined ? null : Number(seedFilter);
  const catalogue =
    replaySeed === null
      ? catalogueScenarios()
      : catalogueScenarios().filter(s => s.seed === replaySeed);
  const seeded =
    replaySeed === null
      ? Array.from({ length: SEEDED_COUNT }, (_, i) => seededScenario(1 + i))
      : catalogue.length > 0
        ? []
        : [seededScenario(replaySeed)];

  it(`catalogue: every Keychain fault at a cold launch (${catalogue.length} rows)`, async () => {
    for (const scenario of catalogue) await runScenario(scenario);
  });

  it(`seeded cold launches ×${seeded.length} (mulberry32, seed = index)`, async () => {
    for (const scenario of seeded) await runScenario(scenario);
  });

  it('every triaged deviation is still reproduced (remove it once fixed)', () => {
    if (seedFilter) return;
    const seen = new Set(
      rows.flatMap(row => row.knownDeviations.map(e => e.split(':')[0])),
    );
    for (const id of Object.keys(KNOWN_DEVIATIONS)) {
      expect(seen.has(id)).toBe(true);
    }
  });

  it('no launch fails an invariant outside the known deviations', () => {
    const failing = rows
      .filter(row => !row.ok)
      .map(row => ({
        scenario: row.scenario,
        seed: row.seed,
        faults: row.faults,
        failed: row.failed,
        landing: row.observed['landing'],
      }));
    expect(failing).toEqual([]);
    expect(rows.length).toBeGreaterThan(0);
  });
});
