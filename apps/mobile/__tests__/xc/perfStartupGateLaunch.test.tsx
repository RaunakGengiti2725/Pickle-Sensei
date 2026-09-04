/**
 * xc-perf-startup-hydrate — Gate-level launch harness.
 *
 * Renders the REAL App.tsx Gate with the REAL authStore/appStore on a fake
 * clock, with the same instrumented SQLite / Keychain / fetch seams as the
 * timeline harness. Screens, navigator and the splash video are stubbed so
 * the measurement is about orchestration, not pixels:
 *
 *   - what is painted on the first commit (work before first frame)
 *   - the order auth-hydrate → owner → app-hydrate → ready
 *   - how many I/O ops precede `ready`, and how long `ready` takes on the
 *     fake clock under slow refresh / slow canonical profile
 *   - how the SplashScreen's 8s watchdog composes with `ready` (modelled from
 *     SplashScreen.tsx: exit fires once ready && (playbackOver || skip))
 *   - which owner-scoped bootstraps (notifications, consistency) are kicked
 *     off before the first frame is ready
 *
 * Run:  cd apps/mobile && npx jest --ci __tests__/xc/perfStartupGateLaunch.test.tsx
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import * as Keychain from 'react-native-keychain';
import {
  type KeychainItem,
  LAUNCH_REFRESH_WAIT_MS,
  type LatencyProfile,
  OWNER,
  REALISTIC_LATENCY,
  REQUEST_TIMEOUT_MS,
  type RouteBehaviour,
  SPLASH_WATCHDOG_MS,
  T0,
  analyse,
  flushMicrotasks,
  formatOp,
  installFetch,
  log,
  mark,
  meBody,
  mockKv,
  mockOutbox,
  nowMs,
  refreshBody,
  resetLog,
  seedGuestMarker,
  seedLocalProfile,
  seedVault,
  setLatency,
  setRoutes,
  writeArtifact,
} from '../../__perf__/perfStartupHarness';

// ─── I/O seams (same as the timeline harness) ────────────────────────────────

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
    signOut: jest.fn(),
    revokeAccess: jest.fn(),
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

// ─── UI seams (same set the existing Gate test uses) ─────────────────────────

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View, SafeAreaProvider: View };
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
    OnboardingScreen: (props: { mode?: string }) =>
      R.createElement(
        RN.Text,
        null,
        props.mode === 'preauth' ? 'ONBOARDING_PREAUTH' : 'ONBOARDING_ACCOUNT',
      ),
  };
});
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

/**
 * Splash probe. Mirrors SplashScreen.tsx's gating logic (WATCHDOG_MS timer →
 * playbackOver; exit when ready && playbackOver; EXIT_MS animation collapsed
 * to 0) without the video/Animated machinery, and records the transitions on
 * the fake clock.
 */
const mockSplashProbe = {
  readyTransitions: [] as Array<{ atMs: number; ready: boolean }>,
  finishedAtMs: null as number | null,
  watchdogFiredAtMs: null as number | null,
  reset() {
    this.readyTransitions.length = 0;
    this.finishedAtMs = null;
    this.watchdogFiredAtMs = null;
  },
};
jest.mock('../../src/screens/SplashScreen', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const H = jest.requireActual<
    typeof import('../../__perf__/perfStartupHarness')
  >('../../__perf__/perfStartupHarness');
  return {
    WATCHDOG_MS: H.SPLASH_WATCHDOG_MS,
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) => {
      const [playbackOver, setPlaybackOver] = R.useState(false);
      const finished = R.useRef(false);
      R.useEffect(() => {
        const timer = setTimeout(() => {
          mockSplashProbe.watchdogFiredAtMs = H.nowMs();
          setPlaybackOver(true);
        }, H.SPLASH_WATCHDOG_MS);
        return () => clearTimeout(timer);
      }, []);
      R.useEffect(() => {
        mockSplashProbe.readyTransitions.push({
          atMs: H.nowMs(),
          ready: props.ready,
        });
      }, [props.ready]);
      R.useEffect(() => {
        if (!props.ready || !playbackOver || finished.current) return;
        finished.current = true;
        mockSplashProbe.finishedAtMs = H.nowMs();
        props.onFinished();
      }, [props.ready, playbackOver, props.onFinished]);
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
jest.mock('../../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: async () => {} };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

// Owner-scoped bootstraps: recorded, not executed (their cost is out of scope
// for this role; the record shows WHEN Gate kicks them off relative to ready).
const mockBootstrapCalls: Array<{ hook: string; owner: string; atMs: number }> =
  [];
jest.mock('../../src/notifications/useNotificationBootstrap', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const H = jest.requireActual<
    typeof import('../../__perf__/perfStartupHarness')
  >('../../__perf__/perfStartupHarness');
  return {
    useNotificationBootstrap: (ownerKey: string | null) => {
      R.useEffect(() => {
        if (ownerKey)
          mockBootstrapCalls.push({
            hook: 'notifications',
            owner: ownerKey,
            atMs: H.nowMs(),
          });
      }, [ownerKey]);
    },
  };
});
jest.mock('../../src/consistency/useConsistencyBootstrap', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const H = jest.requireActual<
    typeof import('../../__perf__/perfStartupHarness')
  >('../../__perf__/perfStartupHarness');
  return {
    useConsistencyBootstrap: (ownerKey: string | null) => {
      R.useEffect(() => {
        if (ownerKey)
          mockBootstrapCalls.push({
            hook: 'consistency',
            owner: ownerKey,
            atMs: H.nowMs(),
          });
      }, [ownerKey]);
    },
  };
});

import App from '../../App';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, KeychainItem>;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function allText(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string');
}

interface LaunchScenario {
  name: string;
  vault: boolean;
  guest?: boolean;
  localProfile: boolean;
  refresh: RouteBehaviour;
  me?: RouteBehaviour;
  latency: LatencyProfile;
}

interface LaunchResult {
  name: string;
  firstFrame: {
    text: string[];
    ioStartedBeforeFirstCommit: number;
    ioCompletedBeforeFirstCommit: number;
  };
  authHydratedAtMs: number | null;
  appHydrateStartedAtMs: number | null;
  appHydratedAtMs: number | null;
  readyAtMs: number | null;
  splashFinishedAtMs: number | null;
  watchdogFiredAtMs: number | null;
  screenAtReady: string[];
  screenAtSplashEnd: string[];
  /** After driving `postSplashWatchMs` further: did a late refresh land, and what is on screen. */
  postSplash: {
    watchedUntilMs: number;
    apiSessionInstalled: boolean;
    screen: string[];
    appRehydrated: boolean;
  };
  bootstrapCalls: typeof mockBootstrapCalls;
  ioBeforeReady: number;
  ioBusyBeforeReadyMs: number;
  idleBeforeReadyMs: number;
  apiSessionInstalledAtReady: boolean;
  ops: string[];
}

function resetWorld() {
  jest.clearAllTimers();
  resetLog();
  mockKv.clear();
  mockOutbox.length = 0;
  __keychainStore.clear();
  mockSplashProbe.reset();
  mockBootstrapCalls.length = 0;
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
  jest.setSystemTime(T0);
}

async function runLaunch(
  s: LaunchScenario,
  maxMs = 40_000,
  postSplashWatchMs = 10_000,
): Promise<LaunchResult> {
  resetWorld();
  setLatency(s.latency);
  setRoutes({
    '/v1/auth/refresh': s.refresh,
    ...(s.me ? { '/v1/me': s.me } : {}),
  });
  installFetch();
  if (s.vault) seedVault(__keychainStore);
  if (s.guest) seedGuestMarker();
  if (s.localProfile)
    seedLocalProfile(
      s.guest ? 'device-guest' : s.vault ? OWNER : SIGNED_OUT_DATA_OWNER,
    );

  // Observe store transitions on the fake clock.
  let authHydratedAtMs: number | null = null;
  let appHydratedAtMs: number | null = null;
  let appHydrateStartedAtMs: number | null = null;
  const unsubAuth = useAuthStore.subscribe(state => {
    if (state.hydrated && authHydratedAtMs === null) {
      authHydratedAtMs = nowMs();
      mark('auth.hydrated', state.session ? 'signed-in' : 'signed-out');
    }
  });
  const unsubApp = useAppStore.subscribe(state => {
    if (state.hydrated && appHydratedAtMs === null) {
      appHydratedAtMs = nowMs();
      mark('app.hydrated', state.ownerKey ?? '');
    }
  });
  const realHydrateApp = useAppStore.getState().hydrate;
  let appHydrateCalls = 0;
  useAppStore.setState({
    hydrate: async () => {
      appHydrateCalls++;
      if (appHydrateStartedAtMs === null) {
        appHydrateStartedAtMs = nowMs();
        mark('app.hydrate.start');
      }
      return realHydrateApp();
    },
  });

  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<App />);
  });
  const firstFrameText = allText(renderer);
  const firstCommitIo = log.filter(e => e.kind !== 'mark');
  const firstFrame = {
    text: firstFrameText,
    ioStartedBeforeFirstCommit: firstCommitIo.length,
    ioCompletedBeforeFirstCommit: firstCommitIo.filter(e => e.endMs !== null)
      .length,
  };

  // Drive the fake clock timer-by-timer until the splash has finished (ready
  // && watchdog) or maxMs elapses.
  let readyAtMs: number | null = null;
  let screenAtReady: string[] = [];
  const start = nowMs();
  const observe = () => {
    if (readyAtMs === null) {
      const t = mockSplashProbe.readyTransitions.find(x => x.ready);
      if (t) {
        readyAtMs = t.atMs;
        screenAtReady = allText(renderer);
        mark('gate.ready', screenAtReady.join('|'));
      }
    }
  };
  await act(async () => {
    await flushMicrotasks(20);
  });
  observe();
  while (
    mockSplashProbe.finishedAtMs === null &&
    nowMs() - start < maxMs &&
    jest.getTimerCount() > 0
  ) {
    await act(async () => {
      await jest.advanceTimersToNextTimerAsync();
      await flushMicrotasks(20);
    });
    observe();
  }
  const screenAtSplashEnd = allText(renderer);
  const apiSessionInstalledAtReady = getApiSession() !== null;

  // Keep the app "open" a little longer: does a refresh that lands after the
  // budget change what the user sees?
  const callsAtSplashEnd = appHydrateCalls;
  const postStart = nowMs();
  while (nowMs() - postStart < postSplashWatchMs && jest.getTimerCount() > 0) {
    await act(async () => {
      await jest.advanceTimersToNextTimerAsync();
      await flushMicrotasks(20);
    });
  }
  const postSplash = {
    watchedUntilMs: nowMs(),
    apiSessionInstalled: getApiSession() !== null,
    screen: allText(renderer),
    appRehydrated: appHydrateCalls > callsAtSplashEnd,
  };
  const timeline = log.slice();
  const readyCut = readyAtMs ?? nowMs();
  const beforeReady = analyse(
    timeline.filter(e => e.kind !== 'mark' && e.startMs < readyCut),
    readyCut,
  );

  unsubAuth();
  unsubApp();
  act(() => renderer.unmount());
  useAppStore.setState({ hydrate: realHydrateApp });

  return {
    name: s.name,
    firstFrame,
    authHydratedAtMs,
    appHydrateStartedAtMs,
    appHydratedAtMs,
    readyAtMs,
    splashFinishedAtMs: mockSplashProbe.finishedAtMs,
    watchdogFiredAtMs: mockSplashProbe.watchdogFiredAtMs,
    screenAtReady,
    screenAtSplashEnd,
    postSplash,
    bootstrapCalls: mockBootstrapCalls.slice(),
    ioBeforeReady: beforeReady.ioCount,
    ioBusyBeforeReadyMs: beforeReady.ioBusyMs,
    idleBeforeReadyMs: beforeReady.idleMs,
    apiSessionInstalledAtReady,
    ops: timeline.map(formatOp),
  };
}

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

const scenarios: LaunchScenario[] = [
  {
    name: 'G01 fresh install → Welcome',
    vault: false,
    localProfile: false,
    refresh: { mode: 'hang' },
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'G02 guest + cached profile → RootNavigator',
    vault: false,
    guest: true,
    localProfile: true,
    refresh: { mode: 'hang' },
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'G03 vault + cached profile, refresh 300ms',
    vault: true,
    localProfile: true,
    refresh: ok200(300),
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'G04 vault + cached profile, refresh 12000ms (past budget)',
    vault: true,
    localProfile: true,
    refresh: ok200(12_000),
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'G05 vault + cached profile, refresh hangs',
    vault: true,
    localProfile: true,
    refresh: { mode: 'hang' },
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'G06 vault, no cached profile, refresh 7900ms, /v1/me 400ms',
    vault: true,
    localProfile: false,
    refresh: ok200(7_900),
    me: me200(400),
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'G07 vault, no cached profile, refresh 7900ms, /v1/me hangs',
    vault: true,
    localProfile: false,
    refresh: ok200(7_900),
    me: { mode: 'hang' },
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'G08 vault, no cached profile, refresh 12000ms (past budget) → in-account onboarding',
    vault: true,
    localProfile: false,
    refresh: ok200(12_000),
    me: me200(200),
    latency: REALISTIC_LATENCY,
  },
  {
    name: 'G09 vault + cached profile, refresh 300ms, slow storage (sqlite 50/80, keychain 400/400)',
    vault: true,
    localProfile: true,
    refresh: ok200(300),
    latency: {
      sqliteReadMs: 50,
      sqliteWriteMs: 80,
      keychainReadMs: 400,
      keychainWriteMs: 400,
    },
  },
];

const realFetch = globalThis.fetch;
const results: LaunchResult[] = [];

beforeAll(() => {
  jest.useFakeTimers();
});
afterAll(() => {
  writeArtifact('gate_launch.json', results);
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});
afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
});

describe('xc-perf-startup-hydrate: App.tsx Gate launch on a fake clock', () => {
  for (const s of scenarios) {
    it(s.name, async () => {
      const r = await runLaunch(s);
      results.push(r);
      // First commit paints the dark loading affordance with nothing else, and
      // no I/O has completed yet (hydrate starts from a passive effect).
      expect(r.firstFrame.text[0]).toBe('Getting things ready');
      expect(r.firstFrame.text).not.toContain('ROOT_NAVIGATOR');
      expect(r.firstFrame.ioCompletedBeforeFirstCommit).toBe(0);
      // Ordering: auth hydrated → app hydrate started → app hydrated → ready.
      expect(r.authHydratedAtMs).not.toBeNull();
      expect(r.appHydrateStartedAtMs).not.toBeNull();
      expect(r.appHydrateStartedAtMs!).toBeGreaterThanOrEqual(
        r.authHydratedAtMs!,
      );
      expect(r.appHydratedAtMs!).toBeGreaterThanOrEqual(
        r.appHydrateStartedAtMs!,
      );
      expect(r.readyAtMs).not.toBeNull();
      expect(r.readyAtMs!).toBeGreaterThanOrEqual(r.appHydratedAtMs!);
      // Owner-scoped bootstraps fire as soon as the owner is known — before ready.
      const hooks = r.bootstrapCalls.map(c => c.hook).sort();
      expect(hooks).toEqual(['consistency', 'notifications']);
      for (const c of r.bootstrapCalls)
        expect(c.atMs).toBeLessThanOrEqual(r.readyAtMs!);
      // Splash: gone at max(ready, watchdog).
      expect(r.splashFinishedAtMs).toBe(
        Math.max(r.readyAtMs!, SPLASH_WATCHDOG_MS),
      );
    });
  }

  it('cached-profile launches are ready within 8s + fixed I/O regardless of refresh latency (G03/G04/G05/G09)', () => {
    for (const r of results.filter(x => /^G0[345]|^G09/.test(x.name))) {
      expect(r.readyAtMs!).toBeLessThanOrEqual(LAUNCH_REFRESH_WAIT_MS + 1_000);
      expect(r.screenAtReady).toEqual(['ROOT_NAVIGATOR']);
    }
  });

  it('G01/G02 land on Welcome / RootNavigator with no network at all; splash still holds until the 8s watchdog', () => {
    const g01 = results.find(x => x.name.startsWith('G01'))!;
    const g02 = results.find(x => x.name.startsWith('G02'))!;
    expect(g01.screenAtReady).toEqual(['WELCOME']);
    expect(g02.screenAtReady).toEqual(['ROOT_NAVIGATOR']);
    expect(g01.readyAtMs!).toBeLessThan(200);
    expect(g02.readyAtMs!).toBeLessThan(200);
    expect(g01.ops.filter(o => o.includes('fetch:'))).toEqual([]);
    expect(g01.splashFinishedAtMs).toBe(SPLASH_WATCHDOG_MS);
  });

  it('G07: a hanging /v1/me holds the "Loading your account" frame until 8s + 15s, then shows the retry state', () => {
    const r = results.find(x => x.name.startsWith('G07'))!;
    expect(r.readyAtMs!).toBeGreaterThanOrEqual(
      LAUNCH_REFRESH_WAIT_MS + REQUEST_TIMEOUT_MS - 200,
    );
    expect(r.screenAtReady.join('\n')).toContain(
      'Your coaching profile couldn’t load',
    );
    // 15s of loading past the splash watchdog with the splash already gone.
    expect(r.watchdogFiredAtMs).toBe(SPLASH_WATCHDOG_MS);
    expect(r.splashFinishedAtMs).toBe(r.readyAtMs);
  });

  it('G08: refresh past the budget + no cached profile → in-account onboarding is shown to a returning user', () => {
    const r = results.find(x => x.name.startsWith('G08'))!;
    expect(r.readyAtMs!).toBeLessThanOrEqual(LAUNCH_REFRESH_WAIT_MS + 200);
    expect(r.screenAtReady).toEqual(['ONBOARDING_ACCOUNT']);
    expect(r.apiSessionInstalledAtReady).toBe(false);
    expect(r.screenAtSplashEnd).toEqual(['ONBOARDING_ACCOUNT']);
    // The refresh lands at ~12s and installs the API session, but nothing
    // re-runs appStore.hydrate() (Gate re-hydrates only on owner change), so
    // the canonical profile is never fetched and the returning user stays on
    // the in-account questionnaire.
    expect(r.postSplash.watchedUntilMs).toBeGreaterThan(12_033);
    expect(r.postSplash.apiSessionInstalled).toBe(true);
    expect(r.postSplash.appRehydrated).toBe(false);
    expect(r.postSplash.screen).toEqual(['ONBOARDING_ACCOUNT']);
    expect(r.ops.some(o => o.includes('GET /v1/me'))).toBe(false);
  });

  it('records I/O before ready per scenario (critical-path table)', () => {
    const table = results.map(r => ({
      name: r.name,
      authHydratedAtMs: r.authHydratedAtMs,
      appHydrateStartedAtMs: r.appHydrateStartedAtMs,
      appHydratedAtMs: r.appHydratedAtMs,
      readyAtMs: r.readyAtMs,
      splashFinishedAtMs: r.splashFinishedAtMs,
      ioBeforeReady: r.ioBeforeReady,
      ioBusyBeforeReadyMs: r.ioBusyBeforeReadyMs,
      idleBeforeReadyMs: r.idleBeforeReadyMs,
      screenAtReady: r.screenAtReady.join('|'),
      screenAfterPostSplashWatch: r.postSplash.screen.join('|'),
      apiSessionInstalledAfterWatch: r.postSplash.apiSessionInstalled,
    }));
    writeArtifact('gate_launch_table.json', table);
    expect(table.length).toBe(scenarios.length);
    for (const row of table) {
      expect(row.ioBeforeReady).toBeGreaterThan(0);
    }
  });

  it('the Gate never overlaps the two hydrates: every appStore kv read starts after auth is hydrated', () => {
    for (const r of results) {
      const appReads = r.ops.filter(o =>
        /kv\.get (onboarding\.pending-profile|profile:)/.test(o),
      );
      expect(appReads.length).toBeGreaterThanOrEqual(2);
      for (const op of appReads) {
        const startMs = Number(op.split('-')[0]);
        expect(startMs).toBeGreaterThanOrEqual(r.authHydratedAtMs!);
      }
    }
  });
});
