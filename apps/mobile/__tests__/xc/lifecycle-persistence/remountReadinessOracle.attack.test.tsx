/**
 * Adversarial companion to harness C (launchOrderMatrix.xc.test.tsx).
 *
 * Harness C stamps a launch "ready" from STORE state (`gateReady()`:
 * auth.hydrated && app.hydrated && app.ownerKey === desired). After the
 * XC-ADJ-LP-3 fix the Gate's readiness additionally depends on a component-
 * local `authSettled` flag that no store exposes, so on a remount — where
 * the stores are still hydrated from the previous mount — the oracle stamps
 * `readyAt = 0` while the Gate is rendering the loading affordance. From
 * that moment the harness cannot observe whether the remounted Gate ever
 * leaves the loading screen: the invariants `readyWithinDeadline` and the
 * test "no launch — cold, remount or relaunch — is left on the loading
 * screen" are vacuous for exactly the launch class the fix targets.
 *
 * Same module seams as harness C (real App / authStore / appStore /
 * sessionKeeper; faked Keychain, LocalDb, HTTP, AppState).
 */
import React from 'react';
import { AppState, NativeModules, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  PermissionState,
  SchedulerPort,
} from '../../../src/notifications/service';
import type { PlannedNotification } from '../../../src/notifications/types';
import { FakeLocalDb } from '../../../xc-harness/lifecycle-persistence/fakeLocalDb';
import {
  CANONICAL_ID,
  validProfile,
  validVault,
} from '../../../xc-harness/lifecycle-persistence/seeds';

const mockDb = { current: new FakeLocalDb() };
jest.mock('../../../src/data/db', () => ({
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
jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));
const API_BASE = 'https://api.example.test';
jest.mock('../../../src/config/runtimeConfig', () => ({
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
jest.mock('../../../src/account/deviceContext', () => ({
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
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  readonly applied: PlannedNotification[][] = [];
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.applied.push([...plan]);
  }
  async cancelAllPlanned(): Promise<void> {}
  async openSystemSettings(): Promise<void> {}
}
const mockScheduler = new FakeScheduler();
jest.mock('../../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
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
jest.mock('../../../src/navigation/RootNavigator', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    RootNavigator: () => R.createElement(RN.Text, null, 'ROOT_NAVIGATOR'),
  };
});
jest.mock('../../../src/screens/OnboardingScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    OnboardingScreen: () => R.createElement(RN.Text, null, 'ONBOARDING'),
  };
});
jest.mock('../../../src/screens/WelcomeScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return { WelcomeScreen: () => R.createElement(RN.Text, null, 'WELCOME') };
});
jest.mock('../../../src/screens/SignInScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return { SignInScreen: () => R.createElement(RN.Text, null, 'SIGN_IN') };
});
jest.mock('../../../src/screens/SplashScreen', () => {
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
jest.mock('../../../src/components/RankUpCelebration', () => ({
  RankUpCelebration: () => null,
}));
jest.mock('../../../src/consistency/StreakCelebration', () => ({
  StreakCelebration: () => null,
}));
jest.mock('../../../src/walkthrough/FirstRunWalkthrough', () => ({
  FirstRunWalkthrough: () => null,
}));
jest.mock('../../../src/design/BrandNotice', () => ({
  BrandNoticeHost: () => null,
}));
jest.mock('../../../src/design/components', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    LoadingState: (props: { label?: string }) =>
      R.createElement(RN.Text, null, `LOADING:${props.label ?? ''}`),
    ErrorState: (props: { title: string; detail?: string }) =>
      R.createElement(
        RN.Text,
        null,
        `ERROR:${props.title}:${props.detail ?? ''}`,
      ),
    BrandSpinner: () => null,
    BrandButton: () => null,
  };
});

import App from '../../../App';
import { useAuthStore } from '../../../src/auth/authStore';
import { useAppStore } from '../../../src/state/appStore';
import { clearApiSession } from '../../../src/account/apiSession';
import { stopSessionKeeper } from '../../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

const VAULT_SERVICE = 'com.picklesensei.auth.session';
const CANONICAL_OWNER = canonicalDataOwner(CANONICAL_ID);

/** Verbatim copy of harness C's readiness oracle (launchOrderMatrix.xc.test.tsx `gateReady`). */
function harnessGateReady(): boolean {
  const auth = useAuthStore.getState();
  const app = useAppStore.getState();
  if (!auth.hydrated) return false;
  const desired =
    auth.session?.provider === 'guest'
      ? 'device-guest'
      : auth.session?.canonicalAppUserId
        ? canonicalDataOwner(auth.session.canonicalAppUserId)
        : SIGNED_OUT_DATA_OWNER;
  return app.hydrated && app.ownerKey === desired;
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => String(node.props['children']))
    .join('|');
}

let rotation = 0;
const server = {
  fetch: async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url === `${API_BASE}/v1/auth/refresh`) {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      rotation += 1;
      return new Response(
        JSON.stringify({
          session: {
            accessToken: `access-${rotation}`,
            refreshToken: `refresh-${rotation}`,
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url === `${API_BASE}/v1/auth/logout`) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected route in attack test: ${url} ${init.method}`);
  },
};

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeAll(() => {
  jest.useFakeTimers();
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((() => ({
    remove: () => {},
  })) as unknown as typeof AppState.addEventListener);
  nativeModules.PickleAuth = { signInWithApple: jest.fn() };
  (globalThis as { fetch: unknown }).fetch = server.fetch;
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  delete nativeModules.PickleAuth;
  jest.useRealTimers();
});

beforeEach(() => {
  jest.setSystemTime(new Date('2026-03-01T09:00:00.000Z'));
  const db = new FakeLocalDb();
  mockDb.current = db;
  mockKeychain.store.clear();
  mockKeychain.store.set(VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify(validVault({ refreshToken: 'refresh-initial' })),
  });
  db.kv.set(`profile:${CANONICAL_OWNER}`, JSON.stringify(validProfile()));
  db.kv.set('walkthrough.device-complete', JSON.stringify({ version: 1 }));
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
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
  });
});

afterEach(() => {
  clearSyncRuntime();
  stopSessionKeeper();
  clearApiSession();
});

describe('Gate remount readiness vs harness C store oracle (XC-ADJ-LP-3 fix)', () => {
  it('a remounted Gate leaves the loading screen (rendered-text pin of the fix)', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<App />);
    });
    await flush(2_000);
    expect(renderedText(renderer)).toContain('ROOT_NAVIGATOR');

    act(() => renderer.unmount());
    act(() => {
      renderer = TestRenderer.create(<App />);
    });
    await flush(0);
    expect(renderedText(renderer)).toContain('LOADING:Loading your account');
    await flush(2_000);
    expect(renderedText(renderer)).toContain('ROOT_NAVIGATOR');
    act(() => renderer.unmount());
  });

  it("harness C's store-derived readiness oracle must not report a remounted Gate ready while it renders the loading screen", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<App />);
    });
    await flush(2_000);
    expect(renderedText(renderer)).toContain('ROOT_NAVIGATOR');
    expect(harnessGateReady()).toBe(true);

    act(() => renderer.unmount());
    act(() => {
      renderer = TestRenderer.create(<App />);
    });
    await flush(0);

    // This is the instant harness C stamps `readyAt = 0` for the remount
    // launch (observeReady() right after mount). The Gate is on the loading
    // screen — its readiness depends on the component-local `authSettled`
    // flag the stores do not expose — so the oracle and the screen disagree,
    // and every later loading-screen outcome of this launch is invisible to
    // `readyWithinDeadline` / `launchesStuckLoading`.
    const text = renderedText(renderer);
    const gateOnLoadingScreen = text.includes('LOADING:');
    expect({
      oracleReady: harnessGateReady(),
      gateOnLoadingScreen,
      text,
    }).toEqual({ oracleReady: false, gateOnLoadingScreen: true, text });
    act(() => renderer.unmount());
  });
});
