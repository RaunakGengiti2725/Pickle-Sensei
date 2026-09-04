/**
 * STRESS · rapid-interaction · SignInScreen as the in-app `ConnectAccount`
 * route of the real RootNavigator.
 *
 * Mounts the REAL <RootNavigator /> — the real NavigationContainer, the real
 * StackRouter (`@react-navigation/native` → core/routers), the real
 * `ConnectAccountRoute` (auto-pop on a non-guest provider) and the real
 * SignInScreen — for a local-only (guest) session, then drives the same
 * seeded bursts as the App-gate suite: same-tick multi-taps, simultaneous
 * controls, taps during provider/bootstrap flight, Back during async, and
 * `navigate('ConnectAccount')` ⇄ Back spam (what Settings' "Connect account"
 * control dispatches).
 *
 * The ONLY navigation piece replaced is the native-stack VIEW
 * (`react-native-screens` has no jest runtime): a JS stack built with the
 * library's own `useNavigationBuilder(StackRouter)` renders every route in
 * state and marks the focused one, so `navigate`/`goBack`/`replace`
 * semantics — including "GO_BACK not handled" dev errors — are the real
 * router's. Heavy tab/detail screens are text markers (not this unit).
 *
 * Invariants: stress-harness/rapid-interaction/runner.ts, plus (host):
 *   - the stack never holds two ConnectAccount routes (no duplicate modal);
 *   - after Back / enter the stack changed by exactly one route;
 *   - a landed canonical session pops ConnectAccount exactly once.
 *
 * Campaign size: STRESS_ITER (default 12). Replay one seed:
 *   STRESS_SEED_FILTER=<seed> npx jest --ci __tests__/stress/signInScreen.rapidInteraction.connectAccountRoute
 * Rows: artifacts/stress-signin-rapid-interaction/connect-account-route.rows.json
 */
import React from 'react';
import { NativeModules, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { FakeLocalDb } from '../../xc-harness/lifecycle-persistence/fakeLocalDb';
import type {
  BurstPlan,
  Target,
} from '../../stress-harness/rapid-interaction/plan';
import {
  campaignSeeds,
  planBurst,
} from '../../stress-harness/rapid-interaction/plan';
import {
  Observer,
  type ScriptedWorld,
} from '../../stress-harness/rapid-interaction/seams';
import {
  runBurst,
  tapLabelled,
  type BurstRow,
  type Host,
  type TapResult,
} from '../../stress-harness/rapid-interaction/runner';
import {
  writeCampaignArtifacts,
  campaignEnv,
} from '../../stress-harness/rapid-interaction/report';

// ─── Navigation: real container + real StackRouter, JS stack view ────────────

type StackSnapshot = { routes: string[]; focused: string | null };
type MockRouteLike = { key: string; name: string };
type Helpers = {
  navigate: (name: string) => void;
  goBack: () => void;
};
const mockNav: {
  helpers: Helpers | null;
  snapshot: StackSnapshot;
  history: StackSnapshot[];
} = {
  helpers: null,
  snapshot: { routes: [], focused: null },
  history: [],
};

jest.mock('@react-navigation/native-stack', () => {
  const ReactLib = require('react') as typeof import('react');
  const RN = require('react-native') as typeof import('react-native');
  const nav = jest.requireActual<typeof import('@react-navigation/native')>(
    '@react-navigation/native',
  );
  function JsStackNavigator(props: {
    children: React.ReactNode;
    screenOptions?: unknown;
    initialRouteName?: string;
    id?: string;
  }) {
    const { state, navigation, descriptors, NavigationContent } =
      nav.useNavigationBuilder(nav.StackRouter, {
        children: props.children,
        screenOptions: props.screenOptions as never,
        initialRouteName: props.initialRouteName,
        id: props.id as never,
      });
    const routes = state.routes as ReadonlyArray<MockRouteLike>;
    const focused = routes[state.index]?.name ?? null;
    mockNav.helpers = navigation as unknown as Helpers;
    mockNav.snapshot = { routes: routes.map(route => route.name), focused };
    return ReactLib.createElement(
      NavigationContent,
      null,
      routes.map((route, index) =>
        ReactLib.createElement(
          RN.View,
          {
            key: route.key,
            testID: `route:${route.name}:${index === state.index ? 'focused' : 'covered'}`,
          },
          descriptors[route.key]!.render(),
        ),
      ),
    );
  }
  return {
    createNativeStackNavigator: nav.createNavigatorFactory(JsStackNavigator),
  };
});

jest.mock('@react-navigation/bottom-tabs', () => {
  const ReactLib = require('react') as typeof import('react');
  const RN = require('react-native') as typeof import('react-native');
  return {
    createBottomTabNavigator: () => ({
      Navigator: () => ReactLib.createElement(RN.Text, null, 'TABS_HOME'),
      Screen: () => null,
    }),
  };
});

// ─── Heavy screens are markers; SignInScreen + ConnectAccountRoute are real ───

function mockMarker(name: string) {
  return () => {
    const RN = require('react-native') as typeof import('react-native');
    const ReactLib = require('react') as typeof import('react');
    return ReactLib.createElement(RN.Text, null, `[${name}]`);
  };
}
jest.mock('../../src/screens/HomeScreen', () => ({
  HomeScreen: mockMarker('HomeScreen'),
}));
jest.mock('../../src/screens/LibraryScreen', () => ({
  LibraryScreen: mockMarker('LibraryScreen'),
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: mockMarker('ProgressScreen'),
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: mockMarker('SettingsScreen'),
}));
jest.mock('../../src/screens/AnalyzeScreen', () => ({
  AnalyzeScreen: mockMarker('AnalyzeScreen'),
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: mockMarker('DrillLibraryScreen'),
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  ResultScreen: mockMarker('ResultScreen'),
}));
jest.mock('../../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: mockMarker('ResultDetailsScreen'),
}));
jest.mock('../../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: mockMarker('FormReviewScreen'),
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: mockMarker('StreakCalendarScreen'),
}));
jest.mock('../../src/screens/PaywallScreen', () => ({
  PaywallScreen: mockMarker('PaywallScreen'),
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: mockMarker('ManageAccountScreen'),
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: mockMarker('ConsentSettingsScreen'),
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: mockMarker('NotificationSettingsScreen'),
}));
jest.mock('../../src/navigation/PremiumTabBar', () => ({
  PremiumTabBar: () => null,
}));

// ─── Process edges ───────────────────────────────────────────────────────────

jest.mock('react-native-keychain');

const mockDb = { current: new FakeLocalDb() };
jest.mock('../../src/data/db', () => ({
  getDb: () => mockDb.current.handle(),
}));
const mockGoogle: { current: unknown } = { current: null };
jest.mock('@react-native-google-signin/google-signin', () => ({
  get GoogleSignin() {
    return mockGoogle.current;
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
    appStoreId: null,
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
  subscribeToNotificationPresses: () => () => {},
}));
jest.mock('react-native-safe-area-context', () => {
  const { View: RNView } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: RNView,
    SafeAreaProvider: RNView,
    initialWindowMetrics: null,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
jest.mock('react-native-linear-gradient', () => {
  const ReactLib = require('react');
  const { View: RNView } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(RNView, null, props.children);
  return { __esModule: true, default: MockGradient };
});

import * as KeychainMock from 'react-native-keychain';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useAccessStore } from '../../src/state/accessStore';
import { clearApiSession } from '../../src/account/apiSession';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const keychain = KeychainMock as unknown as {
  __keychainStore: Map<string, unknown>;
};
const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

const SUITE = 'signin-rapid-interaction/connect-account-route';

const guestSession: AuthSession = {
  provider: 'guest',
  subject: 'local-only',
  canonicalAppUserId: null,
  localOnly: true,
  displayName: null,
  email: null,
};

function resetProcessState(): void {
  clearSyncRuntime();
  stopSessionKeeper();
  clearApiSession();
  useAccessStore.getState().reset();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    session: null,
    hydrated: false,
    busy: false,
    error: null,
    localDataError: null,
    deletionCleanup: null,
  });
  mockNav.helpers = null;
  mockNav.snapshot = { routes: [], focused: null };
  mockNav.history.length = 0;
}

function signInBodies(renderer: TestRenderer.ReactTestRenderer): number {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' && node.props['testID'] === 'sign-in-body',
  ).length;
}

class ConnectAccountRouteHost implements Host {
  readonly name = SUITE;
  private current: TestRenderer.ReactTestRenderer | null = null;
  /** Nav intents pressed since the last afterAct(). */
  private intents: Array<'back' | 'enter'> = [];
  /** Stack as of the last afterAct(): the "before" of the next act. */
  private lastRoutes: string[] = [];
  private readonly navLog: string[] = [];
  private readonly failures: string[] = [];
  private backPressed = 0;
  private enterPressed = 0;
  private backPops = 0;
  private autoPops = 0;

  async mount(plan: BurstPlan, world: ScriptedWorld): Promise<void> {
    void plan;
    this.intents = [];
    this.lastRoutes = [];
    this.navLog.length = 0;
    this.failures.length = 0;
    this.backPressed = 0;
    this.enterPressed = 0;
    this.backPops = 0;
    this.autoPops = 0;
    const db = new FakeLocalDb();
    mockDb.current = db;
    keychain.__keychainStore.clear();
    resetProcessState();
    // A local-only user inside the app (the only way to reach this route).
    setActiveDataOwner(GUEST_DATA_OWNER);
    useAuthStore.setState({
      hydrated: true,
      session: guestSession,
      busy: false,
      error: null,
    });
    nativeModules.PickleAuth = world.appleNative;
    mockGoogle.current = world.google;
    globalThis.fetch = world.fetch as typeof fetch;

    await act(async () => {
      this.current = TestRenderer.create(<RootNavigator />);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
    });
    if (mockNav.snapshot.focused !== 'Tabs' || !mockNav.helpers) {
      throw new Error(
        `mount: Tabs not focused, snapshot=${JSON.stringify(mockNav.snapshot)}`,
      );
    }
    await act(async () => {
      this.tap('enter');
    });
    this.intents = [];
    this.lastRoutes = mockNav.snapshot.routes.slice();
    if (!this.signInVisible()) {
      throw new Error(
        `mount: ConnectAccount not focused after navigate, snapshot=${JSON.stringify(mockNav.snapshot)}`,
      );
    }
  }

  unmount(): void {
    const renderer = this.current;
    this.current = null;
    if (renderer) {
      act(() => {
        renderer.unmount();
      });
    }
    resetProcessState();
    delete nativeModules.PickleAuth;
    mockGoogle.current = null;
    globalThis.fetch = realFetch;
  }

  renderer(): TestRenderer.ReactTestRenderer | null {
    return this.current;
  }

  tap(target: Target): TapResult {
    if (!this.current) return 'absent';
    if (target === 'enter') {
      // Settings → "Connect account": navigation.navigate('ConnectAccount').
      const helpers = mockNav.helpers;
      if (!helpers) return 'absent';
      helpers.navigate('ConnectAccount');
      this.enterPressed += 1;
      this.intents.push('enter');
      this.navLog.push('enter');
      return 'pressed';
    }
    const result = tapLabelled(this.current, target);
    if (target === 'back' && result === 'pressed') {
      this.backPressed += 1;
      this.intents.push('back');
      this.navLog.push('back');
    }
    return result;
  }

  signInVisible(): boolean {
    return (
      this.current !== null &&
      mockNav.snapshot.focused === 'ConnectAccount' &&
      signInBodies(this.current) === 1
    );
  }

  postAuthLanded(): boolean {
    const session = useAuthStore.getState().session;
    return (
      Boolean(session) &&
      session?.provider !== 'guest' &&
      mockNav.snapshot.focused === 'Tabs' &&
      !mockNav.snapshot.routes.includes('ConnectAccount') &&
      this.autoPops <= 1
    );
  }

  afterAct(): string[] {
    if (!this.current) return [];
    const out: string[] = [];
    const snapshot = mockNav.snapshot;
    const before = this.lastRoutes;
    const intents = this.intents;
    this.intents = [];
    this.lastRoutes = snapshot.routes.slice();

    const connectRoutes = snapshot.routes.filter(
      name => name === 'ConnectAccount',
    ).length;
    if (connectRoutes > 1 || signInBodies(this.current) > 1) {
      out.push(
        `noDuplicateSurface: stack=${snapshot.routes.join('>')} signInBodies=${signInBodies(this.current)}`,
      );
    }
    if (snapshot.routes[0] !== 'Tabs') {
      out.push(
        `navigationSingleEffect: root lost, stack=${snapshot.routes.join('>')}`,
      );
    }
    const had = before.includes('ConnectAccount');
    const has = snapshot.routes.includes('ConnectAccount');
    const guest = useAuthStore.getState().session?.provider === 'guest';
    if (had && !has) {
      if (intents.includes('back')) this.backPops += 1;
      else this.autoPops += 1;
    }
    if (this.autoPops > 1) {
      out.push(
        `navigationSingleEffect: ConnectAccount auto-popped ${this.autoPops}×`,
      );
    }
    // One nav intent per act ⇒ exactly one stack change (StackRouter's
    // `navigate` to a route already in the stack is a no-op by design).
    if (intents.length === 1 && guest) {
      const intent = intents[0];
      const expected =
        intent === 'enter'
          ? had
            ? before
            : [...before, 'ConnectAccount']
          : before.slice(0, -1);
      if (expected.join('>') !== snapshot.routes.join('>')) {
        out.push(
          `navigationSingleEffect: ${intent} ${before.join('>')} → ${snapshot.routes.join('>')} (expected ${expected.join('>')})`,
        );
      }
    }
    if (
      intents.length === 0 &&
      guest &&
      before.join('>') !== snapshot.routes.join('>')
    ) {
      out.push(
        `navigationSingleEffect: stack moved without an intent ${before.join('>')} → ${snapshot.routes.join('>')}`,
      );
    }
    if (!guest && useAuthStore.getState().session && has) {
      out.push(
        `navigationSingleEffect: canonical session but ConnectAccount still stacked ${snapshot.routes.join('>')}`,
      );
    }
    this.failures.push(...out);
    return out;
  }

  navObserved(): Record<string, unknown> {
    return {
      backPressed: this.backPressed,
      enterPressed: this.enterPressed,
      backPops: this.backPops,
      autoPops: this.autoPops,
      log: this.navLog.join(' '),
      finalStack: mockNav.snapshot.routes.join('>'),
      finalFocused: mockNav.snapshot.focused,
    };
  }

  navFailures(): string[] {
    return this.failures.filter(f => f.startsWith('navigationSingleEffect'));
  }

  keychainRecords(): number {
    return keychain.__keychainStore.size;
  }

  db(): FakeLocalDb {
    return mockDb.current;
  }
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const env = campaignEnv();
const seeds = campaignSeeds(env);
const observer = new Observer();
const host = new ConnectAccountRouteHost();
const rows: BurstRow[] = [];

beforeAll(() => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'performance'],
  });
  observer.install();
});

afterAll(() => {
  observer.uninstall();
  jest.useRealTimers();
  writeCampaignArtifacts('connect-account-route', rows);
});

afterEach(() => {
  host.unmount();
});

const CHUNK = 25;
const chunks: number[][] = [];
for (let i = 0; i < seeds.length; i += CHUNK) {
  chunks.push(seeds.slice(i, i + CHUNK));
}

describe(`SignInScreen rapid interaction as the real ConnectAccount route (${seeds.length} bursts)`, () => {
  it('renders the real SignInScreen under a focused ConnectAccount route (sanity)', async () => {
    const world = new (jest.requireActual<
      typeof import('../../stress-harness/rapid-interaction/seams')
    >('../../stress-harness/rapid-interaction/seams').ScriptedWorld)(
      ['success'],
      ['ok-session'],
      'deferred',
      () => 0,
    );
    await host.mount(planBurst(seeds[0] ?? 1), world);
    const renderer = host.renderer()!;
    const texts = renderer.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat()
      .filter((c): c is string => typeof c === 'string');
    expect(texts).toContain('TABS_HOME');
    expect(
      renderer.root.findAll(
        node =>
          node.type === View &&
          node.props['testID'] === 'route:ConnectAccount:focused',
      ),
    ).toHaveLength(1);
    expect(host.signInVisible()).toBe(true);
  });

  it.each(chunks.map((chunk, index) => [index, chunk] as const))(
    'bursts chunk %#: every seed holds all invariants',
    async (_index, chunk) => {
      const failed: BurstRow[] = [];
      for (const seed of chunk) {
        const row = await runBurst(SUITE, planBurst(seed), host, observer);
        rows.push(row);
        host.unmount();
        if (!row.ok) failed.push(row);
      }
      expect(
        failed.map(row => `${row.plan}\n  ${row.failures.join('\n  ')}`),
      ).toEqual([]);
    },
  );
});
