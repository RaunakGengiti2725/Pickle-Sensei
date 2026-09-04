/**
 * xc-perf-startup-hydrate — fake-timer critical-path harness for the launch
 * hydration path (`authStore.hydrate()` → `appStore.hydrate()`), driven the
 * way App.tsx Gate drives it (auth first, app once an owner is known).
 *
 * Emits (git-ignored) JSON tables under artifacts/xc-perf-startup-hydrate:
 *   named_scenarios.json / named_scenarios_full.json — per-scenario timelines
 *   serial_prefix.json        — the serial kv/Keychain chain before the refresh
 *   refresh_latency_sweep.json — auth/app/ready times for refresh 0..20s
 *   matrix.json / matrix_summary.json — seeded randomized launches
 *
 * Run:  cd apps/mobile && npx jest --ci __tests__/xc/perfStartupHydrateTimeline.test.ts
 * Scale: XC_PERF_MATRIX_SIZE (default 400), XC_PERF_MATRIX_SEED (default 20260904)
 * Replay one matrix launch: XC_PERF_MATRIX_SIZE=1 XC_PERF_MATRIX_SEED=<seed>
 */
import * as Keychain from 'react-native-keychain';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  API_BASE_URL,
  type Analysis,
  type IoEvent,
  type KeychainItem,
  LAUNCH_REFRESH_WAIT_MS,
  type LatencyProfile,
  OWNER,
  REALISTIC_LATENCY,
  REQUEST_TIMEOUT_MS,
  type RouteBehaviour,
  T0,
  ZERO_LATENCY,
  analyse,
  driveUntilSettled,
  flushMicrotasks,
  formatOp,
  heapSnapshot,
  log,
  mark,
  meBody,
  meBodyNoProfile,
  mockKv,
  mockOutbox,
  mulberry32,
  nowMs,
  onboardingPutBody,
  percentile,
  refreshBody,
  resetLog,
  seedGuestMarker,
  seedLastProviderGoogle,
  seedLegacySessionKey,
  seedLocalProfile,
  seedPendingPreAuthProfile,
  seedVault,
  setLatency,
  setRoutes,
  installFetch,
  nodeEnv,
  writeArtifact,
} from '../../__perf__/perfStartupHarness';

// ─── Module seams ────────────────────────────────────────────────────────────

jest.mock('../../src/data/db', () => ({
  getDb: () =>
    jest
      .requireActual<typeof import('../../__perf__/perfStartupHarness')>(
        '../../__perf__/perfStartupHarness',
      )
      .createInstrumentedDb(),
}));
jest.mock('react-native-keychain', () =>
  jest
    .requireActual<typeof import('../../__perf__/perfStartupHarness')>(
      '../../__perf__/perfStartupHarness',
    )
    .wrapKeychain(jest.requireActual('../../__mocks__/react-native-keychain')),
);

const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(),
  signIn: jest.fn(),
  signInSilently: jest.fn(),
  hasPreviousSignIn: jest.fn(),
  signOut: jest.fn(),
  revokeAccess: jest.fn(),
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: mockGoogleSignin,
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

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, KeychainItem>;
};

// ─── Scenario model ──────────────────────────────────────────────────────────

interface Scenario {
  name: string;
  seed?: number;
  vault: 'none' | 'apple' | 'google';
  guest?: boolean;
  legacySessionKey?: boolean;
  lastProviderGoogle?: boolean;
  localProfile: boolean;
  pendingPreAuthProfile?: boolean;
  refresh: RouteBehaviour;
  me?: RouteBehaviour;
  onboardingPut?: RouteBehaviour;
  latency: LatencyProfile;
}

interface ScenarioResult {
  scenario: Scenario;
  auth: {
    hydratedAtMs: number;
    settled: boolean;
    sessionOwner: string | null;
    apiSessionInstalled: boolean;
    outcome: 'online' | 'offline' | 'signed-out' | 'DEADLOCK';
  };
  app: {
    startedAtMs: number;
    hydratedAtMs: number;
    settled: boolean;
    profileLoaded: boolean;
    hydrateError: string | null;
    wouldShowInAccountOnboarding: boolean;
  };
  readyAtMs: number;
  timeline: IoEvent[];
  analysis: { auth: Analysis; app: Analysis; total: Analysis };
  postLaunch: {
    apiSessionInstalledLaterAtMs: number | null;
    signedOutLaterAtMs: number | null;
    finalSessionOwner: string | null;
    appRehydratedAfterLateRefresh: boolean;
  };
}

function ownerOf(
  session: { provider: string; canonicalAppUserId?: string | null } | null,
) {
  if (!session) return null;
  if (session.provider === 'guest') return GUEST_DATA_OWNER;
  return session.canonicalAppUserId
    ? canonicalDataOwner(session.canonicalAppUserId)
    : null;
}

function resetWorld() {
  // Timers left behind by the previous launch (keeper retries, outbox
  // backoff) must not leak into the next timeline.
  jest.clearAllTimers();
  resetLog();
  mockKv.clear();
  mockOutbox.length = 0;
  __keychainStore.clear();
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
    onboardingBusy: false,
    onboardingError: null,
  });
  jest.clearAllMocks();
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
}

async function runScenario(
  s: Scenario,
  postLaunchWatchMs = 30_000,
): Promise<ScenarioResult> {
  resetWorld();
  jest.setSystemTime(T0);
  setLatency(s.latency);
  setRoutes({
    '/v1/auth/refresh': s.refresh,
    ...(s.me ? { '/v1/me': s.me } : {}),
    ...(s.onboardingPut ? { '/v1/me/onboarding': s.onboardingPut } : {}),
  });
  installFetch();
  if (s.vault !== 'none') seedVault(__keychainStore, s.vault);
  if (s.guest) seedGuestMarker();
  if (s.legacySessionKey) seedLegacySessionKey();
  if (s.lastProviderGoogle) seedLastProviderGoogle();
  if (s.pendingPreAuthProfile) seedPendingPreAuthProfile();
  const expectedOwner = s.guest
    ? GUEST_DATA_OWNER
    : s.vault === 'none'
      ? SIGNED_OUT_DATA_OWNER
      : OWNER;
  if (s.localProfile) seedLocalProfile(expectedOwner);

  // Mirror App.tsx Gate: auth hydrate first; app hydrate only once auth is hydrated.
  mark('auth.hydrate.start');
  const authRun = await driveUntilSettled(useAuthStore.getState().hydrate());
  const authHydratedAt = nowMs();
  mark(
    'auth.hydrate.end',
    useAuthStore.getState().session ? 'signed-in' : 'signed-out',
  );
  const authEvents = log.filter(e => e.startMs <= authHydratedAt);
  const sessionOwner = ownerOf(useAuthStore.getState().session);
  const apiInstalledAtAuthEnd = getApiSession() !== null;
  const outcome: ScenarioResult['auth']['outcome'] = !authRun.settled
    ? 'DEADLOCK'
    : sessionOwner === null
      ? 'signed-out'
      : apiInstalledAtAuthEnd
        ? 'online'
        : 'offline';

  mark('app.hydrate.start', getActiveDataOwner());
  const appStart = nowMs();
  const appRun = await driveUntilSettled(useAppStore.getState().hydrate());
  const appHydratedAt = nowMs();
  const appState = useAppStore.getState();
  mark(
    'app.hydrate.end',
    appState.profile
      ? 'profile'
      : appState.hydrateError
        ? 'error'
        : 'no-profile',
  );
  const appEvents = log.filter(e => e.startMs >= appStart && e.kind !== 'mark');
  const readyAt = nowMs();

  // Post-launch watch: does the late refresh land / revoke, and does anything
  // re-run appStore.hydrate once the API session is installed?
  const appHydrateCountBefore = log.filter(
    e => e.op === 'app.hydrate.start',
  ).length;
  let apiSessionInstalledLaterAtMs: number | null = null;
  let signedOutLaterAtMs: number | null = null;
  const watchStart = nowMs();
  while (nowMs() - watchStart < postLaunchWatchMs && jest.getTimerCount() > 0) {
    await jest.advanceTimersToNextTimerAsync();
    await flushMicrotasks(20);
    if (
      apiSessionInstalledLaterAtMs === null &&
      !apiInstalledAtAuthEnd &&
      getApiSession()
    )
      apiSessionInstalledLaterAtMs = nowMs();
    if (
      signedOutLaterAtMs === null &&
      sessionOwner &&
      !useAuthStore.getState().session
    )
      signedOutLaterAtMs = nowMs();
  }
  const timeline = log.slice();

  return {
    scenario: s,
    auth: {
      hydratedAtMs: authHydratedAt,
      settled: authRun.settled,
      sessionOwner,
      apiSessionInstalled: apiInstalledAtAuthEnd,
      outcome,
    },
    app: {
      startedAtMs: appStart,
      hydratedAtMs: appHydratedAt,
      settled: appRun.settled,
      profileLoaded: appState.profile !== null,
      hydrateError: appState.hydrateError,
      wouldShowInAccountOnboarding:
        appState.hydrated &&
        appState.profile === null &&
        appState.hydrateError === null &&
        sessionOwner !== null &&
        sessionOwner !== SIGNED_OUT_DATA_OWNER,
    },
    readyAtMs: readyAt,
    timeline,
    analysis: {
      auth: analyse(authEvents, authHydratedAt),
      app: analyse(appEvents, appHydratedAt - appStart),
      total: analyse(
        timeline.filter(e => e.startMs <= readyAt),
        readyAt,
      ),
    },
    postLaunch: {
      apiSessionInstalledLaterAtMs,
      signedOutLaterAtMs,
      finalSessionOwner: ownerOf(useAuthStore.getState().session),
      appRehydratedAfterLateRefresh:
        log.filter(e => e.op === 'app.hydrate.start').length >
        appHydrateCountBefore,
    },
  };
}

function compact(r: ScenarioResult) {
  return {
    name: r.scenario.name,
    seed: r.scenario.seed ?? null,
    authHydratedAtMs: r.auth.hydratedAtMs,
    authOutcome: r.auth.outcome,
    appHydrateMs: r.app.hydratedAtMs - r.app.startedAtMs,
    readyAtMs: r.readyAtMs,
    profileLoaded: r.app.profileLoaded,
    hydrateError: r.app.hydrateError,
    wouldShowInAccountOnboarding: r.app.wouldShowInAccountOnboarding,
    ioCount: r.analysis.total.ioCount,
    ioBusyMs: r.analysis.total.ioBusyMs,
    idleMs: r.analysis.total.idleMs,
    maxConcurrency: r.analysis.total.maxConcurrency,
    apiSessionInstalledLaterAtMs: r.postLaunch.apiSessionInstalledLaterAtMs,
    signedOutLaterAtMs: r.postLaunch.signedOutLaterAtMs,
    appRehydratedAfterLateRefresh: r.postLaunch.appRehydratedAfterLateRefresh,
    ops: r.timeline.filter(e => e.kind !== 'mark').map(formatOp),
  };
}

const realFetch = globalThis.fetch;
beforeAll(() => {
  jest.useFakeTimers();
});
afterAll(() => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});
afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
});

// ─── Named scenarios ─────────────────────────────────────────────────────────

const ok200 = (latencyMs: number): RouteBehaviour => ({
  mode: 'respond',
  latencyMs,
  status: 200,
  body: refreshBody(),
});
const me200 = (latencyMs: number): RouteBehaviour => ({
  mode: 'respond',
  latencyMs,
  status: 200,
  body: meBody(),
});
const status = (latencyMs: number, code: number): RouteBehaviour => ({
  mode: 'respond',
  latencyMs,
  status: code,
  body: { error: { message: 'x' } },
});

const named: Scenario[] = [
  {
    name: 'S01 fresh install (no vault, no guest)',
    vault: 'none',
    localProfile: false,
    refresh: { mode: 'hang' },
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S02 guest mode with local profile',
    vault: 'none',
    guest: true,
    localProfile: true,
    refresh: { mode: 'hang' },
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S03 vault + cached profile, refresh 300ms',
    vault: 'apple',
    localProfile: true,
    refresh: ok200(300),
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S04 vault + cached profile, refresh 7900ms (just inside budget)',
    vault: 'apple',
    localProfile: true,
    refresh: ok200(7_900),
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S05 vault + cached profile, refresh lands at 12000ms (past budget)',
    vault: 'apple',
    localProfile: true,
    refresh: ok200(12_000),
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S06 vault + cached profile, refresh hangs forever (15s abort → retry)',
    vault: 'apple',
    localProfile: true,
    refresh: { mode: 'hang' },
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S07 vault + cached profile, network down (fast error)',
    vault: 'apple',
    localProfile: true,
    refresh: { mode: 'network-error', latencyMs: 20 },
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S08 vault + cached profile, 503 after 400ms',
    vault: 'apple',
    localProfile: true,
    refresh: status(400, 503),
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S09 vault, 401 within budget (revoked), legacy google flag set',
    vault: 'apple',
    lastProviderGoogle: true,
    localProfile: true,
    refresh: status(500, 401),
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S10 vault, 401 lands at 10000ms (after the app was shown)',
    vault: 'apple',
    localProfile: true,
    refresh: status(10_000, 401),
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S11 vault, NO cached profile, refresh 300ms, /v1/me 400ms',
    vault: 'apple',
    localProfile: false,
    refresh: ok200(300),
    me: me200(400),
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S12 vault, NO cached profile, refresh 7900ms, /v1/me hangs (15s abort)',
    vault: 'apple',
    localProfile: false,
    refresh: ok200(7_900),
    me: { mode: 'hang' },
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S13 vault, NO cached profile, refresh 7900ms, /v1/me 14000ms (slow but succeeds)',
    vault: 'apple',
    localProfile: false,
    refresh: ok200(7_900),
    me: me200(14_000),
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S14 vault, NO cached profile, refresh lands at 12000ms (past budget)',
    vault: 'apple',
    localProfile: false,
    refresh: ok200(12_000),
    me: me200(200),
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S15 vault + pending pre-auth profile, refresh 300ms, PUT /v1/me/onboarding hangs',
    vault: 'apple',
    localProfile: false,
    pendingPreAuthProfile: true,
    refresh: ok200(300),
    me: {
      mode: 'respond',
      latencyMs: 200,
      status: 200,
      body: meBodyNoProfile(),
    },
    onboardingPut: { mode: 'hang' },
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S16 legacy auth.session key present + vault (extra kv write)',
    vault: 'apple',
    legacySessionKey: true,
    localProfile: true,
    refresh: ok200(300),
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S17 zero-latency I/O, refresh hangs — isolates the pure deadline',
    vault: 'apple',
    localProfile: true,
    refresh: { mode: 'hang' },
    latency: ZERO_LATENCY,
  },
  {
    name: 'S18 slow storage (sqlite 50/80ms, keychain 400/400ms), refresh 300ms',
    vault: 'apple',
    localProfile: true,
    refresh: ok200(300),
    latency: {
      sqliteReadMs: 50,
      sqliteWriteMs: 80,
      keychainReadMs: 400,
      keychainWriteMs: 400,
    },
  },
  {
    name: 'S19 no vault, legacy google flag, SDK has no saved credential',
    vault: 'none',
    lastProviderGoogle: true,
    localProfile: false,
    refresh: { mode: 'hang' },
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'S20 vault + pending pre-auth profile, refresh 300ms, PUT 600ms succeeds',
    vault: 'apple',
    localProfile: true,
    pendingPreAuthProfile: true,
    refresh: ok200(300),
    me: me200(200),
    onboardingPut: {
      mode: 'respond',
      latencyMs: 600,
      status: 200,
      body: onboardingPutBody(),
    },
    latency: REALISTIC_LATENCY,
  },
];

const results: ScenarioResult[] = [];

describe('xc-perf-startup-hydrate: named launch scenarios (fake clock)', () => {
  afterAll(() => {
    writeArtifact('named_scenarios.json', results.map(compact));
    writeArtifact('named_scenarios_full.json', results);
  });

  for (const scenario of named) {
    it(scenario.name, async () => {
      const r = await runScenario(scenario);
      results.push(r);
      expect(r.auth.settled).toBe(true);
      expect(r.app.settled).toBe(true);
    });
  }

  it('auth hydrate never waits longer than the 8s launch budget for the refresh', () => {
    const withRefresh = results.filter(r =>
      r.timeline.some(e => e.op === 'POST /v1/auth/refresh'),
    );
    expect(withRefresh.length).toBeGreaterThan(0);
    for (const r of withRefresh) {
      const fetchStart = r.timeline.find(e => e.kind === 'fetch')!.startMs;
      expect(r.auth.hydratedAtMs).toBeLessThanOrEqual(
        fetchStart + LAUNCH_REFRESH_WAIT_MS + 50,
      );
    }
  });

  it('S17: with zero-latency I/O the auth hydrate resolves at exactly 8000ms, signed in, offline', () => {
    const r = results.find(x => x.scenario.name.startsWith('S17'))!;
    expect(r.auth.hydratedAtMs).toBe(LAUNCH_REFRESH_WAIT_MS);
    expect(r.auth.outcome).toBe('offline');
    expect(r.auth.sessionOwner).toBe(OWNER);
    expect(r.readyAtMs).toBe(LAUNCH_REFRESH_WAIT_MS);
  });

  it('transient refresh failures never sign the user out; only 401 does', () => {
    for (const r of results) {
      if (r.scenario.vault === 'none') continue;
      const is401 =
        r.scenario.refresh.mode === 'respond' &&
        r.scenario.refresh.status === 401;
      if (is401) expect(r.postLaunch.finalSessionOwner).toBeNull();
      else {
        expect(r.auth.sessionOwner).toBe(OWNER);
        expect(r.postLaunch.finalSessionOwner).toBe(OWNER);
      }
    }
  });

  it('S09: a 401 inside the budget clears the legacy google flag, so the SDK fallback is not consulted', () => {
    const r = results.find(x => x.scenario.name.startsWith('S09'))!;
    expect(r.auth.outcome).toBe('signed-out');
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
    expect(r.timeline.map(e => e.op)).toEqual(
      expect.arrayContaining(['resetGenericPassword', 'kv.set', 'kv.get']),
    );
  });

  it('before the refresh POST starts, every kv/Keychain op is strictly serial — the avoidable serial prefix', () => {
    const prefixRows: Array<Record<string, unknown>> = [];
    for (const r of results) {
      const fetchStart =
        r.timeline.find(e => e.kind === 'fetch')?.startMs ??
        r.auth.hydratedAtMs;
      const prefix = r.timeline.filter(
        e => e.kind !== 'mark' && e.startMs < fetchStart,
      );
      const a = analyse(prefix, fetchStart);
      prefixRows.push({
        name: r.scenario.name,
        prefixOps: prefix.map(
          e => `${e.kind}:${e.op}${e.detail ? ' ' + e.detail : ''}`,
        ),
        prefixMs: fetchStart,
        serialChainMs: a.serialChainMs,
        maxConcurrency: a.maxConcurrency,
      });
      expect(a.maxConcurrency).toBeLessThanOrEqual(1);
      // Fully serial: the wall time of the prefix equals the sum of its ops.
      expect(a.serialChainMs).toBe(fetchStart);
    }
    writeArtifact('serial_prefix.json', prefixRows);
  });

  it('once the refresh lands inside the budget, installApiSession() starts an outbox drain + Keychain write that overlap appStore.hydrate()', () => {
    const online = results.filter(r => r.auth.outcome === 'online');
    expect(online.length).toBeGreaterThan(0);
    for (const r of online) {
      const between = r.timeline.filter(
        e =>
          e.kind !== 'mark' &&
          e.startMs >= r.auth.hydratedAtMs &&
          e.startMs < r.readyAtMs,
      );
      const ops = between.map(e => e.op);
      expect(ops).toContain('outbox.select');
      expect(ops).toContain('setGenericPassword');
      expect(
        analyse(between, r.readyAtMs - r.auth.hydratedAtMs).maxConcurrency,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('appStore.hydrate() issues its two kv reads serially although they are independent', () => {
    for (const r of results) {
      const appKv = r.timeline.filter(
        e =>
          e.kind === 'sqlite' &&
          e.op === 'kv.get' &&
          e.startMs >= r.app.startedAtMs &&
          e.startMs < r.readyAtMs,
      );
      const pending = appKv.find(
        e => e.detail === 'onboarding.pending-profile',
      );
      const profile = appKv.find(e => e.detail.startsWith('profile:'));
      if (!pending || !profile) continue;
      expect(profile.startMs).toBeGreaterThanOrEqual(pending.endMs ?? 0);
    }
  });
});

// ─── Refresh-latency sweep ───────────────────────────────────────────────────

describe('xc-perf-startup-hydrate: refresh-latency sweep (0 → 20s, step 250ms)', () => {
  it('auth hydrate time = fixed I/O + min(refreshLatency, 8000); ready is bounded when the profile is cached', async () => {
    const rows: Array<Record<string, number | string | boolean | null>> = [];
    for (let ms = 0; ms <= 20_000; ms += 250) {
      const r = await runScenario(
        {
          name: `sweep refresh=${ms}`,
          vault: 'apple',
          localProfile: true,
          refresh: ok200(ms),
          latency: REALISTIC_LATENCY,
        },
        16_000,
      );
      const fetchStart = r.timeline.find(e => e.kind === 'fetch')!.startMs;
      const expectedAuth = fetchStart + Math.min(ms, LAUNCH_REFRESH_WAIT_MS);
      rows.push({
        refreshLatencyMs: ms,
        fetchStartMs: fetchStart,
        authHydratedAtMs: r.auth.hydratedAtMs,
        expectedAuthHydratedAtMs: expectedAuth,
        authOutcome: r.auth.outcome,
        appHydrateMs: r.app.hydratedAtMs - r.app.startedAtMs,
        readyAtMs: r.readyAtMs,
        overBudgetMs: Math.max(0, r.readyAtMs - LAUNCH_REFRESH_WAIT_MS),
        apiSessionInstalledLaterAtMs: r.postLaunch.apiSessionInstalledLaterAtMs,
        ioCount: r.analysis.total.ioCount,
      });
      // Exact: the deadline and the refresh are the only two timers racing.
      expect(r.auth.hydratedAtMs).toBe(expectedAuth);
      if (ms >= REQUEST_TIMEOUT_MS) {
        // The 15s AbortController fires first: the answer is thrown away and
        // the keeper retries (5s backoff) — a server that consistently needs
        // ≥15s never yields a bearer.
        expect(r.auth.outcome).toBe('offline');
        expect(r.postLaunch.apiSessionInstalledLaterAtMs).toBeNull();
      } else if (ms > LAUNCH_REFRESH_WAIT_MS) {
        expect(r.auth.outcome).toBe('offline');
        expect(r.postLaunch.apiSessionInstalledLaterAtMs).toBe(fetchStart + ms);
      } else {
        expect(r.auth.outcome).toBe('online');
      }
    }
    writeArtifact('refresh_latency_sweep.json', rows);
    const maxReady = Math.max(...rows.map(r => Number(r.readyAtMs)));
    expect(maxReady).toBeLessThan(LAUNCH_REFRESH_WAIT_MS + 500);
  });
});

// ─── Seeded randomized matrix ────────────────────────────────────────────────

const MATRIX_SIZE = Number(nodeEnv.XC_PERF_MATRIX_SIZE ?? 400);
const MATRIX_BASE_SEED = Number(nodeEnv.XC_PERF_MATRIX_SEED ?? 20260904);

function randomScenario(seed: number): Scenario {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const refreshKind = pick([
    'fast',
    'fast',
    'slow',
    'hang',
    'error',
    '503',
    '401',
  ]);
  const refresh: RouteBehaviour =
    refreshKind === 'fast'
      ? ok200(Math.floor(rnd() * 2000))
      : refreshKind === 'slow'
        ? ok200(2000 + Math.floor(rnd() * 18_000))
        : refreshKind === 'hang'
          ? { mode: 'hang' }
          : refreshKind === 'error'
            ? { mode: 'network-error', latencyMs: Math.floor(rnd() * 3000) }
            : refreshKind === '503'
              ? status(Math.floor(rnd() * 3000), 503)
              : status(Math.floor(rnd() * 12_000), 401);
  const meKind = pick(['fast', 'slow', 'hang', 'error']);
  const me: RouteBehaviour =
    meKind === 'fast'
      ? me200(Math.floor(rnd() * 1500))
      : meKind === 'slow'
        ? me200(1500 + Math.floor(rnd() * 13_000))
        : meKind === 'hang'
          ? { mode: 'hang' }
          : { mode: 'network-error', latencyMs: Math.floor(rnd() * 2000) };
  return {
    name: `matrix seed=${seed}`,
    seed,
    vault: pick(['apple', 'apple', 'google']),
    localProfile: rnd() < 0.7,
    pendingPreAuthProfile: rnd() < 0.1,
    legacySessionKey: rnd() < 0.1,
    lastProviderGoogle: rnd() < 0.2,
    refresh,
    me,
    onboardingPut: {
      mode: 'respond',
      latencyMs: Math.floor(rnd() * 2000),
      status: 200,
      body: onboardingPutBody(),
    },
    latency: {
      sqliteReadMs: Math.floor(rnd() * 60),
      sqliteWriteMs: Math.floor(rnd() * 120),
      keychainReadMs: Math.floor(rnd() * 500),
      keychainWriteMs: Math.floor(rnd() * 500),
    },
  };
}

describe(`xc-perf-startup-hydrate: seeded matrix (${MATRIX_SIZE} launches, base seed ${MATRIX_BASE_SEED})`, () => {
  it('invariants hold for every seed; distribution written to matrix.json', async () => {
    const rows: ReturnType<typeof compact>[] = [];
    const violations: Array<{
      seed: number;
      invariant: string;
      detail: string;
    }> = [];
    const heapBefore = heapSnapshot();
    let overBudget = 0;
    let readyOver15s = 0;
    const returningUserRoutedToOnboarding: number[] = [];
    for (let i = 0; i < MATRIX_SIZE; i++) {
      const seed = MATRIX_BASE_SEED + i;
      const s = randomScenario(seed);
      const r = await runScenario(s, 20_000);
      rows.push(compact(r));
      const fetchStart =
        r.timeline.find(e => e.kind === 'fetch')?.startMs ??
        r.auth.hydratedAtMs;
      const is401 = s.refresh.mode === 'respond' && s.refresh.status === 401;
      if (!r.auth.settled)
        violations.push({
          seed,
          invariant: 'auth settles',
          detail: 'deadlock',
        });
      if (!r.app.settled)
        violations.push({ seed, invariant: 'app settles', detail: 'deadlock' });
      if (r.auth.hydratedAtMs > fetchStart + LAUNCH_REFRESH_WAIT_MS)
        violations.push({
          seed,
          invariant: 'auth ≤ fetchStart+8000',
          detail: String(r.auth.hydratedAtMs),
        });
      if (!is401 && r.postLaunch.finalSessionOwner !== OWNER)
        violations.push({
          seed,
          invariant: 'no implicit sign-out without 401',
          detail: String(r.postLaunch.finalSessionOwner),
        });
      if (
        is401 &&
        s.refresh.mode === 'respond' &&
        s.refresh.latencyMs <= LAUNCH_REFRESH_WAIT_MS &&
        r.auth.sessionOwner !== null
      )
        violations.push({
          seed,
          invariant: '401 inside budget → signed out at hydrate',
          detail: String(r.auth.sessionOwner),
        });
      // The legacy `auth.session` key may only ever be blanked, never filled.
      const legacyValue = mockKv.get('auth.session');
      if (legacyValue !== undefined && legacyValue !== '')
        violations.push({
          seed,
          invariant: 'no session material in kv',
          detail: `auth.session=${legacyValue.slice(0, 40)}`,
        });
      for (const [k, v] of mockKv)
        if (
          v.includes('access-2') ||
          v.includes('refresh-2') ||
          v.includes('refresh-1')
        )
          violations.push({
            seed,
            invariant: 'no session material in kv',
            detail: `${k} contains a token`,
          });
      if (r.readyAtMs > LAUNCH_REFRESH_WAIT_MS) overBudget++;
      if (r.readyAtMs > REQUEST_TIMEOUT_MS) readyOver15s++;
      if (
        r.app.wouldShowInAccountOnboarding &&
        !s.pendingPreAuthProfile &&
        !is401
      )
        returningUserRoutedToOnboarding.push(seed);
    }
    const heapAfter = heapSnapshot();
    const summary = {
      matrixSize: MATRIX_SIZE,
      baseSeed: MATRIX_BASE_SEED,
      replay:
        'XC_PERF_MATRIX_SIZE=1 XC_PERF_MATRIX_SEED=<seed> npx jest --ci __tests__/xc/perfStartupHydrateTimeline.test.ts',
      violations,
      readyOver8sCount: overBudget,
      readyOver15sCount: readyOver15s,
      returningUserRoutedToInAccountOnboardingSeeds:
        returningUserRoutedToOnboarding,
      readyAtMs: {
        p50: percentile(
          rows.map(r => r.readyAtMs),
          0.5,
        ),
        p90: percentile(
          rows.map(r => r.readyAtMs),
          0.9,
        ),
        p99: percentile(
          rows.map(r => r.readyAtMs),
          0.99,
        ),
        max: Math.max(...rows.map(r => r.readyAtMs)),
      },
      heap: { before: heapBefore, after: heapAfter },
    };
    writeArtifact('matrix.json', rows);
    writeArtifact('matrix_summary.json', summary);
    expect(violations).toEqual([]);
  });
});

// ─── Documented behaviours at the edge of the budget ─────────────────────────

describe('xc-perf-startup-hydrate: late refresh / slow canonical profile', () => {
  it('S14: profile-less returning user is routed to in-account onboarding and NOT re-hydrated when the refresh lands', async () => {
    const r = await runScenario(named.find(s => s.name.startsWith('S14'))!);
    expect(r.auth.outcome).toBe('offline');
    expect(r.app.profileLoaded).toBe(false);
    expect(r.app.hydrateError).toBeNull();
    // apiSession null at app hydrate → the canonical GET /v1/me is skipped.
    expect(
      r.timeline.some(e => e.op === 'GET /v1/me' && e.startMs < r.readyAtMs),
    ).toBe(false);
    expect(r.app.wouldShowInAccountOnboarding).toBe(true);
    // Refresh lands later and installs the API session…
    expect(r.postLaunch.apiSessionInstalledLaterAtMs).not.toBeNull();
    // …but nothing re-runs appStore.hydrate (Gate re-hydrates only on owner change).
    expect(r.postLaunch.appRehydratedAfterLateRefresh).toBe(false);
    expect(r.timeline.some(e => e.op === 'GET /v1/me')).toBe(false);
    writeArtifact('s14_late_refresh_no_profile.json', compact(r));
  });

  it('S12: canonical profile fetch is bounded only by the 15s request timeout, not the 8s launch budget', async () => {
    const r = await runScenario(named.find(s => s.name.startsWith('S12'))!);
    expect(r.auth.outcome).toBe('online');
    const me = r.timeline.find(e => e.op === 'GET /v1/me')!;
    expect(me.result).toBe('aborted');
    expect((me.endMs ?? 0) - me.startMs).toBe(REQUEST_TIMEOUT_MS);
    expect(r.readyAtMs).toBeGreaterThan(
      LAUNCH_REFRESH_WAIT_MS + REQUEST_TIMEOUT_MS - 200,
    );
    expect(r.app.hydrateError).not.toBeNull();
    writeArtifact('s12_me_timeout.json', compact(r));
  });

  it('S15: a hanging PUT /v1/me/onboarding holds the launch for the full 15s request timeout, then keeps the stash', async () => {
    const r = await runScenario(named.find(s => s.name.startsWith('S15'))!);
    expect(r.auth.outcome).toBe('online');
    const put = r.timeline.find(e => e.op === 'PUT /v1/me/onboarding')!;
    expect(put.result).toBe('aborted');
    expect((put.endMs ?? 0) - put.startMs).toBe(REQUEST_TIMEOUT_MS);
    expect(r.readyAtMs).toBeGreaterThan(REQUEST_TIMEOUT_MS);
    expect(mockKv.has('onboarding.pending-profile')).toBe(true);
    writeArtifact('s15_pending_put_timeout.json', compact(r));
  });

  it('S20: pending pre-auth adoption = GET skipped (profile cached) → PUT → 2 serial kv writes, all before ready', async () => {
    const r = await runScenario(named.find(s => s.name.startsWith('S20'))!);
    expect(r.auth.outcome).toBe('online');
    const ops = r.timeline.filter(
      e => e.kind !== 'mark' && e.startMs < r.readyAtMs,
    );
    expect(ops.some(e => e.op === 'GET /v1/me')).toBe(false);
    const put = ops.find(e => e.op === 'PUT /v1/me/onboarding')!;
    expect(put.result).toBe('HTTP 200');
    const writes = ops.filter(
      e => e.op === 'kv.set' && e.startMs >= (put.endMs ?? 0),
    );
    expect(writes.map(e => e.detail)).toEqual([
      `profile:${OWNER}`,
      'onboarding.pending-profile',
    ]);
    expect(writes[1]!.startMs).toBeGreaterThanOrEqual(writes[0]!.endMs ?? 0);
    expect(mockKv.get('onboarding.pending-profile')).toBe('');
    expect(r.app.profileLoaded).toBe(true);
    writeArtifact('s20_pending_adoption.json', compact(r));
  });

  it('S06: a hanging refresh is aborted at 15s and retried with backoff (5s, 10s, …) — the launch itself is done at 8s', async () => {
    const r = await runScenario(
      named.find(s => s.name.startsWith('S06'))!,
      60_000,
    );
    expect(r.auth.outcome).toBe('offline');
    expect(r.readyAtMs).toBeLessThan(LAUNCH_REFRESH_WAIT_MS + 100);
    const refreshes = r.timeline.filter(e => e.op === 'POST /v1/auth/refresh');
    expect(refreshes.length).toBeGreaterThanOrEqual(3);
    expect(refreshes[0]!.result).toBe('aborted');
    expect((refreshes[0]!.endMs ?? 0) - refreshes[0]!.startMs).toBe(
      REQUEST_TIMEOUT_MS,
    );
    const gaps = refreshes
      .slice(1)
      .map((e, i) => e.startMs - (refreshes[i]!.endMs ?? 0));
    expect(gaps[0]).toBe(5_000);
    expect(gaps[1]).toBe(10_000);
    writeArtifact('s06_hang_retry.json', compact(r));
  });

  it('no launch path writes session material to SQLite kv (only Keychain)', async () => {
    for (const name of ['S03', 'S05', 'S11']) {
      const r = await runScenario(named.find(s => s.name.startsWith(name))!);
      const kvWrites = r.timeline
        .filter(e => e.op === 'kv.set')
        .map(e => e.detail);
      expect(kvWrites.every(k => !k.startsWith('auth.session'))).toBe(true);
      for (const [k, v] of mockKv) {
        expect(v).not.toContain('access-2');
        expect(v).not.toContain('refresh-2');
        expect(k).not.toBe('auth.session');
      }
    }
    expect(API_BASE_URL).toBe('https://api.example.test');
  });
});
