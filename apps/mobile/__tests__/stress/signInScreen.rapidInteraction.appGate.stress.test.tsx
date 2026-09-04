/**
 * STRESS · rapid-interaction · SignInScreen inside the real App gate.
 *
 * Mounts the REAL <App /> (SafeAreaProvider → QueryClientProvider →
 * RootErrorBoundary → Gate) with the real authStore / appStore /
 * notificationStore / consistencyStore / walkthroughStore, the real
 * WelcomeScreen and the real SignInScreen, and drives seeded bursts of
 * adversarial input against the sign-in surface: same-tick double/triple
 * taps, simultaneous Apple+Google+Back, taps while the provider or the
 * bootstrap request is in flight, Back during async work, and Welcome ⇄
 * SignIn navigation spam. Only process edges are scripted: the native Apple
 * module, the Google SDK object, `fetch`, Keychain (in-memory __mocks__),
 * SQLite (FakeLocalDb), the notification scheduler, safe-area insets, the
 * MP4 splash and the post-sign-in destinations (RootNavigator / in-account
 * OnboardingScreen are markers — they are not this unit).
 *
 * Invariants: see stress-harness/rapid-interaction/runner.ts.
 *
 * Campaign size: STRESS_ITER (default 12). Replay one seed:
 *   STRESS_SEED_FILTER=<seed> npx jest --ci __tests__/stress/signInScreen.rapidInteraction.appGate
 * Rows: artifacts/stress-signin-rapid-interaction/app-gate.rows.json
 */
import React from 'react';
import { NativeModules } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { FakeLocalDb } from '../../xc-harness/lifecycle-persistence/fakeLocalDb';
import { validProfile } from '../../xc-harness/lifecycle-persistence/seeds';
import type {
  BurstPlan,
  Target,
} from '../../stress-harness/rapid-interaction/plan';
import {
  campaignSeeds,
  planBurst,
} from '../../stress-harness/rapid-interaction/plan';
import {
  CANONICAL_ID,
  Observer,
  type ScriptedWorld,
} from '../../stress-harness/rapid-interaction/seams';
import {
  allText,
  controls,
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

// ─── Process edges ───────────────────────────────────────────────────────────

// In-memory Keychain (apps/mobile/__mocks__/react-native-keychain.ts).
jest.mock('react-native-keychain');

const mockDb = { current: new FakeLocalDb() };
jest.mock('../../src/data/db', () => ({
  getDb: () => mockDb.current.handle(),
}));

// The SDK object is swapped per burst so every call lands in that burst's
// scripted world.
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
jest.mock('react-native-linear-gradient', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
// Post-sign-in destinations are markers: the unit under stress is the
// sign-in surface, and what the Gate renders after a session is asserted
// by text.
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
// The real splash finishes through a native-driver Animated.timing whose
// completion never fires under jest's NativeAnimatedModule mock.
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

import * as KeychainMock from 'react-native-keychain';
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

const keychain = KeychainMock as unknown as {
  __keychainStore: Map<string, unknown>;
};
const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

const SUITE = 'signin-rapid-interaction/app-gate';
const WELCOME_CTA = 'I already have an account';

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
}

/** The Gate's mutually exclusive stages, read from the rendered tree. */
type Stage =
  | 'welcome'
  | 'signin'
  | 'loading'
  | 'root'
  | 'onboarding'
  | 'profile-error'
  | 'crash';

function stagesVisible(renderer: TestRenderer.ReactTestRenderer): Stage[] {
  const text = allText(renderer);
  const stages: Stage[] = [];
  if (controls(renderer, WELCOME_CTA).length > 0) stages.push('welcome');
  if (
    renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props['testID'] === 'sign-in-body',
    ).length > 0
  ) {
    stages.push('signin');
  }
  if (
    text.includes('Getting things ready') ||
    text.includes('Loading your account')
  ) {
    stages.push('loading');
  }
  if (text.includes('ROOT_NAVIGATOR')) stages.push('root');
  if (text.includes('ONBOARDING')) stages.push('onboarding');
  if (text.includes('Your coaching profile couldn’t load')) {
    stages.push('profile-error');
  }
  if (text.includes('Something went wrong')) stages.push('crash');
  return stages;
}

class AppGateHost implements Host {
  readonly name = SUITE;
  private current: TestRenderer.ReactTestRenderer | null = null;
  private plan: BurstPlan | null = null;
  /** Nav intents pressed in the current act, checked by afterAct(). */
  private pendingIntent: 'back' | 'enter' | null = null;
  private readonly navLog: string[] = [];
  private readonly failures: string[] = [];
  private backPressed = 0;
  private enterPressed = 0;

  async mount(plan: BurstPlan, world: ScriptedWorld): Promise<void> {
    this.plan = plan;
    this.pendingIntent = null;
    this.navLog.length = 0;
    this.failures.length = 0;
    this.backPressed = 0;
    this.enterPressed = 0;
    const db = new FakeLocalDb();
    mockDb.current = db;
    keychain.__keychainStore.clear();
    if (plan.profiled) {
      db.kv.set(
        `profile:${canonicalDataOwner(CANONICAL_ID)}`,
        JSON.stringify(validProfile()),
      );
    }
    db.kv.set('walkthrough.device-complete', JSON.stringify({ version: 1 }));
    resetProcessState();
    nativeModules.PickleAuth = world.appleNative;
    mockGoogle.current = world.google;
    globalThis.fetch = world.fetch as typeof fetch;

    await act(async () => {
      this.current = TestRenderer.create(<App />);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(200);
    });
    if (!stagesVisible(this.current!).includes('welcome')) {
      throw new Error(
        `mount: Welcome not reached, stages=${stagesVisible(this.current!).join(',')} text=${allText(this.current!).slice(0, 200)}`,
      );
    }
    await act(async () => {
      this.tap('enter');
    });
    this.pendingIntent = null;
    if (!this.signInVisible()) {
      throw new Error('mount: SignIn not reached after Welcome CTA');
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
    // Between bursts the "process" is gone: every singleton is reset.
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
      const node = controls(this.current, WELCOME_CTA)[0];
      if (!node) return 'absent';
      (node.props['onPress'] as () => void)();
      this.enterPressed += 1;
      this.pendingIntent = 'enter';
      this.navLog.push('enter');
      return 'pressed';
    }
    const result = tapLabelled(this.current, target);
    if (target === 'back' && result === 'pressed') {
      this.backPressed += 1;
      this.pendingIntent = 'back';
      this.navLog.push('back');
    }
    return result;
  }

  signInVisible(): boolean {
    return this.current
      ? stagesVisible(this.current).includes('signin')
      : false;
  }

  postAuthLanded(): boolean {
    if (!this.current || !this.plan) return false;
    const stages = stagesVisible(this.current);
    return (
      stages.length === 1 &&
      stages[0] === (this.plan.profiled ? 'root' : 'onboarding')
    );
  }

  afterAct(): string[] {
    if (!this.current) return [];
    const out: string[] = [];
    const stages = stagesVisible(this.current);
    if (stages.length !== 1) {
      out.push(
        `noDuplicateSurface: gate stages visible together: ${stages.join(',') || 'none'}`,
      );
    }
    const intent = this.pendingIntent;
    this.pendingIntent = null;
    if (intent && useAuthStore.getState().session === null) {
      const expected: Stage = intent === 'back' ? 'welcome' : 'signin';
      if (!stages.includes(expected)) {
        out.push(
          `navigationSingleEffect: after ${intent} expected ${expected}, saw ${stages.join(',')}`,
        );
      }
    }
    this.failures.push(...out);
    return out;
  }

  navObserved(): Record<string, unknown> {
    return {
      backPressed: this.backPressed,
      enterPressed: this.enterPressed,
      log: this.navLog.join(' '),
      finalStages: this.current ? stagesVisible(this.current) : [],
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
const host = new AppGateHost();
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
  writeCampaignArtifacts('app-gate', rows);
});

afterEach(() => {
  host.unmount();
});

const CHUNK = 25;
const chunks: number[][] = [];
for (let i = 0; i < seeds.length; i += CHUNK) {
  chunks.push(seeds.slice(i, i + CHUNK));
}

describe(`SignInScreen rapid interaction inside the real App gate (${seeds.length} bursts)`, () => {
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
