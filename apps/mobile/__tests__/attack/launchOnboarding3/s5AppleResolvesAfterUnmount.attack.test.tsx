/**
 * ADVERSARIAL PASS 3 — scenario 5 (mobile-launch-onboarding).
 *
 * Attack: on the REAL App Gate + REAL authStore + REAL SignInScreen, press
 * Continue with Apple, leave the screen with Back while the native Apple
 * promise is still pending (SignInScreen unmounts, Welcome is back), and
 * only then let Apple resolve. Variants: Apple resolves while the user is
 * already inside the pre-auth questionnaire; the user re-enters sign-in
 * while the flow is still pending; Apple is canceled after the unmount;
 * Apple's bootstrap FAILS after the unmount and the user re-enters sign-in.
 *
 * Expected: the session still installs (authStore.session + api session +
 * Keychain vault), the Gate leaves the pre-auth screens for the signed-in
 * app, and React never logs a setState-after-unmount / act() warning.
 */
import React from 'react';
import { NativeModules, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { Profile } from '../../../src/state/profile';
import type { PermissionState } from '../../../src/notifications/service';

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Passthrough = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
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
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
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
jest.mock('../../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

jest.mock('../../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
    legalPrivacyUrl: 'https://api.example.test/privacy',
    legalTermsUrl: 'https://api.example.test/terms',
    appStoreId: null,
    appStoreWriteReviewUrl: null,
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

const mockBootstrapCanonicalAccount = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../../src/account/bootstrap', () => {
  const actual = jest.requireActual<
    typeof import('../../../src/account/bootstrap')
  >('../../../src/account/bootstrap');
  return {
    AccountBootstrapError: actual.AccountBootstrapError,
    bootstrapCanonicalAccount: (...args: unknown[]) =>
      mockBootstrapCanonicalAccount(...args),
  };
});

const mockFetchCanonical = jest.fn<Promise<Profile | null>, [unknown]>(
  async () => null,
);
const mockSaveCanonical = jest.fn<Promise<Profile>, [unknown, Profile]>(
  async (_session, profile) => profile,
);
jest.mock('../../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: (session: unknown) =>
    mockFetchCanonical(session),
  saveCanonicalOnboardingProfile: (session: unknown, profile: Profile) =>
    mockSaveCanonical(session, profile),
}));

const mockScheduler = {
  async permissionState(): Promise<PermissionState> {
    return 'undetermined';
  },
  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  },
  async applyPlan(): Promise<void> {},
  async cancelAllPlanned(): Promise<void> {},
  async openSystemSettings(): Promise<void> {},
};
jest.mock('../../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

jest.mock('../../../src/navigation/RootNavigator', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    RootNavigator: () => React.createElement(Text, null, 'ROOT_NAVIGATOR'),
  };
});
jest.mock('../../../src/screens/SplashScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) => {
      React.useEffect(() => {
        if (props.ready) props.onFinished();
      }, [props.ready, props.onFinished]);
      return React.createElement(Text, null, 'SPLASH');
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
jest.mock('../../../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: async () => {} };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

import App from '../../../App';
import { useAuthStore } from '../../../src/auth/authStore';
import { AccountBootstrapError } from '../../../src/account/bootstrap';
import {
  clearApiSession,
  getApiSession,
} from '../../../src/account/apiSession';
import { stopSessionKeeper } from '../../../src/account/sessionKeeper';
import {
  SESSION_VAULT_SERVICE,
  clearPersistedSession,
} from '../../../src/account/sessionVault';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { clearSyncRuntime } from '../../../src/data/syncRuntime';
import { useAppStore } from '../../../src/state/appStore';
import * as Keychain from 'react-native-keychain';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

type Renderer = TestRenderer.ReactTestRenderer;

type AppleResult = {
  user: string;
  identityToken?: string;
  authorizationCode?: string;
  email?: string;
  givenName?: string;
  familyName?: string;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mockAppleSignIn = jest.fn<Promise<AppleResult>, []>();
const nativeModules = NativeModules as { PickleAuth?: unknown };

const CANONICAL_ID = '55555555-5555-4555-8555-555555555555';
const FAR_FUTURE_MS = Date.now() + 60 * 60_000;

const serverProfile: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

function bootstrapResult() {
  return {
    account: {
      id: CANONICAL_ID,
      email: 'dana@example.test',
      onboardingState: 'complete',
    },
    apiSession: {
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'access-token-1',
      canonicalAppUserId: CANONICAL_ID,
      provider: 'apple',
      refreshToken: 'refresh-token-1',
      bearerExpiresAtMs: FAR_FUTURE_MS,
    },
  };
}

const APPLE_OK: AppleResult = {
  user: 'apple-user-5',
  identityToken: 'apple-identity-token',
  authorizationCode: 'apple-auth-code',
  email: 'dana@example.test',
  givenName: 'Dana',
};

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string | number => typeof c !== 'object')
    .join('');
}

function isAncestor(
  ancestor: TestRenderer.ReactTestInstance,
  node: TestRenderer.ReactTestInstance,
): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function pressables(renderer: Renderer, label: string) {
  const matches = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
  return matches.filter(
    node => !matches.some(other => other !== node && isAncestor(node, other)),
  );
}

async function settle() {
  await act(async () => {});
  await act(async () => {});
}

async function press(renderer: Renderer, label: string) {
  const nodes = pressables(renderer, label);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]!.props.disabled).toBeFalsy();
  act(() => {
    nodes[0]!.props.onPress();
  });
  await settle();
}

const APPLE = 'Continue with Apple';
const GOOGLE = 'Continue with Google';
const BACK = 'Back';
const HAVE_ACCOUNT = 'I already have an account';
const GET_STARTED = 'Start your first read';
const DISMISS = 'Dismiss sign-in error';

function expectWelcome(renderer: Renderer) {
  const text = allText(renderer);
  expect(text).toContain('See the stroke.');
  expect(pressables(renderer, GET_STARTED)).toHaveLength(1);
  expect(pressables(renderer, HAVE_ACCOUNT)).toHaveLength(1);
  expect(pressables(renderer, APPLE)).toHaveLength(0);
}

function expectSignedInApp(renderer: Renderer) {
  const state = useAuthStore.getState();
  expect(state.busy).toBe(false);
  expect(state.error).toBeNull();
  expect(state.session?.canonicalAppUserId).toBe(CANONICAL_ID);
  expect(state.session?.localOnly).toBe(false);
  expect(getApiSession()?.bearerToken).toBe('access-token-1');
  expect(getActiveDataOwner()).toBe(canonicalDataOwner(CANONICAL_ID));
  const vault = __keychainStore.get(SESSION_VAULT_SERVICE);
  expect(vault).toBeDefined();
  expect(vault!.password).toContain('refresh-token-1');
  expect(vault!.password).not.toContain('access-token-1');
  expect(vault!.password).not.toContain('apple-identity-token');
  const text = allText(renderer);
  expect(text).toContain('ROOT_NAVIGATOR');
  expect(text).not.toContain('See the stroke.');
  expect(pressables(renderer, APPLE)).toHaveLength(0);
  expect(pressables(renderer, HAVE_ACCOUNT)).toHaveLength(0);
  expect(pressables(renderer, GET_STARTED)).toHaveLength(0);
}

let mounted: Renderer | null = null;
let consoleErrorSpy: jest.SpyInstance;
let consoleWarnSpy: jest.SpyInstance;

function reactWarnings() {
  return [...consoleErrorSpy.mock.calls, ...consoleWarnSpy.mock.calls]
    .map(args => args.map(String).join(' '))
    .filter(line =>
      /unmounted|memory leak|not wrapped in act|Can't perform a React state update|Warning:/i.test(
        line,
      ),
    );
}

async function launch(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
  });
  await settle();
  mounted = renderer;
  expectWelcome(renderer);
  return renderer;
}

describe('S5 — signInWithApple resolves after SignInScreen was unmounted via Back', () => {
  beforeEach(() => {
    mockKv.clear();
    __keychainStore.clear();
    mockAppleSignIn.mockReset();
    mockBootstrapCanonicalAccount.mockReset();
    mockFetchCanonical.mockReset();
    mockFetchCanonical.mockResolvedValue(serverProfile);
    mockSaveCanonical.mockClear();
    Object.values(mockGoogleSignin).forEach(fn => fn.mockReset());
    nativeModules.PickleAuth = { signInWithApple: mockAppleSignIn };
    clearApiSession();
    clearSyncRuntime();
    stopSessionKeeper();
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
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    const renderer = mounted;
    mounted = null;
    if (renderer) act(() => renderer.unmount());
    await settle();
    clearSyncRuntime();
    stopSessionKeeper();
    clearApiSession();
    await clearPersistedSession();
    delete nativeModules.PickleAuth;
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('Apple → Back → Apple resolves: session installs, Gate goes to the signed-in app, no React warning', async () => {
    const apple = deferred<AppleResult>();
    mockAppleSignIn.mockReturnValue(apple.promise);
    mockBootstrapCanonicalAccount.mockResolvedValue(bootstrapResult());
    const renderer = await launch();

    await press(renderer, HAVE_ACCOUNT);
    expect(pressables(renderer, APPLE)).toHaveLength(1);
    await press(renderer, APPLE);
    expect(mockAppleSignIn).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().busy).toBe(true);
    expect(allText(renderer)).toContain('Signing in securely…');

    await press(renderer, BACK);
    expectWelcome(renderer);
    // The flow is still in flight with no screen owning it.
    expect(useAuthStore.getState().busy).toBe(true);
    expect(useAuthStore.getState().session).toBeNull();

    await act(async () => {
      apple.resolve(APPLE_OK);
    });
    await settle();
    await settle();

    expect(mockBootstrapCanonicalAccount).toHaveBeenCalledTimes(1);
    expectSignedInApp(renderer);
    expect(reactWarnings()).toEqual([]);
  });

  it('Apple → Back → "Start your first read" (questionnaire step one) → Apple resolves: Gate leaves the questionnaire for the app', async () => {
    const apple = deferred<AppleResult>();
    mockAppleSignIn.mockReturnValue(apple.promise);
    mockBootstrapCanonicalAccount.mockResolvedValue(bootstrapResult());
    const renderer = await launch();

    await press(renderer, HAVE_ACCOUNT);
    await press(renderer, APPLE);
    await press(renderer, BACK);
    await press(renderer, GET_STARTED);
    expect(allText(renderer)).toContain('PLAYER SETUP');

    await act(async () => {
      apple.resolve(APPLE_OK);
    });
    await settle();
    await settle();

    expectSignedInApp(renderer);
    expect(allText(renderer)).not.toContain('PLAYER SETUP');
    // The pre-auth stash was never written (the questionnaire was abandoned
    // on step one), so nothing was pushed to the account.
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    expect(reactWarnings()).toEqual([]);
  });

  it('Apple → Back → re-enter sign-in while pending: providers stay disabled and the busy row is shown; Back again → resolve → app', async () => {
    const apple = deferred<AppleResult>();
    mockAppleSignIn.mockReturnValue(apple.promise);
    mockBootstrapCanonicalAccount.mockResolvedValue(bootstrapResult());
    const renderer = await launch();

    await press(renderer, HAVE_ACCOUNT);
    await press(renderer, APPLE);
    await press(renderer, BACK);
    await press(renderer, HAVE_ACCOUNT);
    expect(allText(renderer)).toContain('Signing in securely…');
    expect(pressables(renderer, APPLE)[0]!.props.disabled).toBe(true);
    expect(pressables(renderer, GOOGLE)[0]!.props.disabled).toBe(true);
    // Straight through the store, bypassing the disabled props.
    await act(async () => {
      await useAuthStore.getState().signInWithApple();
      await useAuthStore.getState().signInWithGoogle();
    });
    expect(mockAppleSignIn).toHaveBeenCalledTimes(1);
    expect(mockGoogleSignin.signIn).not.toHaveBeenCalled();

    await press(renderer, BACK);
    expectWelcome(renderer);
    await act(async () => {
      apple.resolve(APPLE_OK);
    });
    await settle();
    await settle();
    expectSignedInApp(renderer);
    expect(mockBootstrapCanonicalAccount).toHaveBeenCalledTimes(1);
    expect(reactWarnings()).toEqual([]);
  });

  it('Apple → Back → Apple CANCELED after unmount: stays signed out on Welcome, re-entering sign-in is idle with no error card', async () => {
    const apple = deferred<AppleResult>();
    mockAppleSignIn.mockReturnValue(apple.promise);
    const renderer = await launch();

    await press(renderer, HAVE_ACCOUNT);
    await press(renderer, APPLE);
    await press(renderer, BACK);
    await act(async () => {
      apple.reject({ code: 'auth.canceled', message: 'Sign-in canceled.' });
    });
    await settle();

    expectWelcome(renderer);
    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(mockBootstrapCanonicalAccount).not.toHaveBeenCalled();

    await press(renderer, HAVE_ACCOUNT);
    const copy = allText(renderer);
    expect(copy).not.toContain('Signing in securely…');
    expect(copy).not.toContain('SIGN-IN FAILED');
    expect(pressables(renderer, DISMISS)).toHaveLength(0);
    expect(pressables(renderer, APPLE)[0]!.props.disabled).toBe(false);
    expect(pressables(renderer, GOOGLE)[0]!.props.disabled).toBe(false);
    expect(reactWarnings()).toEqual([]);
  });

  it('Apple → Back → bootstrap FAILS after unmount: signed out on Welcome; re-entering sign-in later must not surface the stale failure card', async () => {
    const apple = deferred<AppleResult>();
    mockAppleSignIn.mockReturnValue(apple.promise);
    mockBootstrapCanonicalAccount.mockRejectedValue(
      new AccountBootstrapError(
        'account.unavailable',
        'The account service is unavailable. Try again shortly.',
        true,
      ),
    );
    const renderer = await launch();

    await press(renderer, HAVE_ACCOUNT);
    await press(renderer, APPLE);
    await press(renderer, BACK);
    await act(async () => {
      apple.resolve(APPLE_OK);
    });
    await settle();
    await settle();

    expectWelcome(renderer);
    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(reactWarnings()).toEqual([]);

    // Time passes; the user takes the questionnaire route and comes back to
    // sign in fresh. The failure belonged to an attempt no screen owns any
    // more — a fresh SignInScreen must start clean.
    await press(renderer, GET_STARTED);
    await press(renderer, BACK);
    await press(renderer, HAVE_ACCOUNT);
    const copy = allText(renderer);
    expect(pressables(renderer, APPLE)[0]!.props.disabled).toBe(false);
    expect(copy).not.toContain('SIGN-IN FAILED');
    expect(pressables(renderer, DISMISS)).toHaveLength(0);
  });
});
