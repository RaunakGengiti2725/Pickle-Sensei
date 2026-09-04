/**
 * ADVERSARIAL PASS 3 — scenario 2 (mobile-launch-onboarding).
 *
 * Attack: on the real SignInScreen + real authStore, press Apple, then press
 * Google IMMEDIATELY (same tick, before any microtask) while the native
 * Apple promise is still pending, then reject Apple with `auth.canceled`.
 * Also: Google pressed straight through the store (bypassing the disabled
 * prop), Google pressed in the same microtask turn the cancel lands, and a
 * seeded burst of Apple/Google presses around the cancel.
 *
 * Expected: the Google flow never starts (no SDK configure/signIn, no
 * bootstrap), the screen returns to idle (busy=false, providers enabled, no
 * "Signing in securely…"), and no error card is rendered for the cancel.
 */
import React from 'react';
import { NativeModules, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
}));

jest.mock('../../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
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

import { SignInScreen } from '../../../src/screens/SignInScreen';
import { useAuthStore } from '../../../src/auth/authStore';
import {
  clearApiSession,
  getApiSession,
} from '../../../src/account/apiSession';
import { clearSyncRuntime } from '../../../src/data/syncRuntime';

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

function renderScreen(onBack: () => void = jest.fn()) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<SignInScreen onBack={onBack} />);
  });
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function isPressableElement(node: TestRenderer.ReactTestInstance) {
  return (
    typeof node.type !== 'string' &&
    typeof node.props.onPress === 'function' &&
    typeof node.props.accessibilityRole === 'string'
  );
}

function pressables(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root
    .findAll(isPressableElement)
    .filter(node => node.props.accessibilityLabel === label);
}

function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = pressables(renderer, label);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

const APPLE = 'Continue with Apple';
const GOOGLE = 'Continue with Google';
const DISMISS = 'Dismiss sign-in error';
const CANCELED = { code: 'auth.canceled', message: 'Sign-in canceled.' };

function expectIdleNoErrorCard(renderer: TestRenderer.ReactTestRenderer) {
  const state = useAuthStore.getState();
  expect(state.busy).toBe(false);
  expect(state.session).toBeNull();
  expect(getApiSession()).toBeNull();
  const copy = allText(renderer);
  expect(copy).not.toContain('Signing in securely…');
  expect(copy).not.toContain('SIGN-IN FAILED');
  expect(copy).not.toContain('NOT CONFIGURED YET');
  expect(pressables(renderer, DISMISS)).toHaveLength(0);
  expect(pressable(renderer, APPLE).props.disabled).toBe(false);
  expect(pressable(renderer, GOOGLE).props.disabled).toBe(false);
}

function expectNoGoogleFlow() {
  expect(mockGoogleSignin.configure).not.toHaveBeenCalled();
  expect(mockGoogleSignin.hasPlayServices).not.toHaveBeenCalled();
  expect(mockGoogleSignin.signIn).not.toHaveBeenCalled();
  expect(mockBootstrapCanonicalAccount).not.toHaveBeenCalled();
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const SEED = 0x5eed02;

describe('S2 — Apple pending, Google pressed, Apple canceled', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null;

  beforeEach(() => {
    mockAppleSignIn.mockReset();
    mockBootstrapCanonicalAccount.mockReset();
    Object.values(mockGoogleSignin).forEach(fn => fn.mockReset());
    mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
    nativeModules.PickleAuth = { signInWithApple: mockAppleSignIn };
    useAuthStore.setState({
      hydrated: true,
      session: null,
      busy: false,
      error: null,
    });
  });

  afterEach(() => {
    if (renderer) act(() => renderer!.unmount());
    renderer = null;
    clearSyncRuntime();
    clearApiSession();
    delete nativeModules.PickleAuth;
    jest.restoreAllMocks();
  });

  it('Apple → Google in the SAME tick through the real button handlers, then auth.canceled: Google never starts, idle, no card', async () => {
    const apple = deferred<AppleResult>();
    mockAppleSignIn.mockReturnValue(apple.promise);
    renderer = renderScreen();
    const appleHandler = pressable(renderer, APPLE).props.onPress as () => void;
    const googleHandler = pressable(renderer, GOOGLE).props
      .onPress as () => void;

    // Same synchronous tick: the render that disables Google has not run yet,
    // so this is the store's busy guard doing the work, not the prop.
    act(() => {
      appleHandler();
      googleHandler();
    });
    expect(mockAppleSignIn).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().busy).toBe(true);
    expect(allText(renderer)).toContain('Signing in securely…');
    expectNoGoogleFlow();

    await act(async () => {
      apple.reject(CANCELED);
    });
    await act(async () => {});
    expectNoGoogleFlow();
    expectIdleNoErrorCard(renderer);
    expect(useAuthStore.getState().error).toEqual(CANCELED);
  });

  it('Google pressed on the store directly while Apple pends (disabled prop bypassed), then canceled: no Google flow, idle', async () => {
    const apple = deferred<AppleResult>();
    mockAppleSignIn.mockReturnValue(apple.promise);
    renderer = renderScreen();

    await act(async () => {
      pressable(renderer!, APPLE).props.onPress();
    });
    expect(pressable(renderer, GOOGLE).props.disabled).toBe(true);
    // Bypass the disabled prop three times in a row.
    await act(async () => {
      await useAuthStore.getState().signInWithGoogle();
      await useAuthStore.getState().signInWithGoogle();
      await useAuthStore.getState().signInWithGoogle();
    });
    expectNoGoogleFlow();
    expect(useAuthStore.getState().busy).toBe(true);

    await act(async () => {
      apple.reject(CANCELED);
    });
    await act(async () => {});
    expectNoGoogleFlow();
    expectIdleNoErrorCard(renderer);
  });

  it('Google pressed in the same act as the cancel lands (before the store settles) still never starts a Google flow', async () => {
    const apple = deferred<AppleResult>();
    mockAppleSignIn.mockReturnValue(apple.promise);
    renderer = renderScreen();
    await act(async () => {
      pressable(renderer!, APPLE).props.onPress();
    });
    const googleHandler = pressable(renderer, GOOGLE).props
      .onPress as () => void;

    // Reject and press Google synchronously: the rejection is only delivered
    // on a later microtask, so `busy` is still true when Google is pressed.
    act(() => {
      apple.reject(CANCELED);
      googleHandler();
    });
    expect(mockGoogleSignin.signIn).not.toHaveBeenCalled();
    await act(async () => {});
    await act(async () => {});
    expectNoGoogleFlow();
    expectIdleNoErrorCard(renderer);
  });

  it('Apple pending → Google → Apple again → cancel: exactly one native Apple call, no Google, idle', async () => {
    const apple = deferred<AppleResult>();
    mockAppleSignIn.mockReturnValue(apple.promise);
    renderer = renderScreen();
    const appleHandler = pressable(renderer, APPLE).props.onPress as () => void;
    const googleHandler = pressable(renderer, GOOGLE).props
      .onPress as () => void;
    act(() => {
      appleHandler();
      googleHandler();
      appleHandler();
      googleHandler();
      appleHandler();
    });
    expect(mockAppleSignIn).toHaveBeenCalledTimes(1);
    await act(async () => {
      apple.reject(CANCELED);
    });
    await act(async () => {});
    expect(mockAppleSignIn).toHaveBeenCalledTimes(1);
    expectNoGoogleFlow();
    expectIdleNoErrorCard(renderer);
  });

  it(`seeded burst (seed ${SEED}) of Apple/Google presses across 25 pending→canceled cycles: never a Google flow, always back to idle`, async () => {
    renderer = renderScreen();
    const rand = lcg(SEED);
    let appleCalls = 0;
    for (let cycle = 0; cycle < 25; cycle += 1) {
      const apple = deferred<AppleResult>();
      mockAppleSignIn.mockReturnValueOnce(apple.promise);
      const appleHandler = pressable(renderer, APPLE).props
        .onPress as () => void;
      const googleHandler = pressable(renderer, GOOGLE).props
        .onPress as () => void;
      // Always lead with Apple so the pending flow is Apple's, then a random
      // burst of both buttons while it pends.
      act(() => {
        appleHandler();
        const burst = 1 + Math.floor(rand() * 8);
        for (let i = 0; i < burst; i += 1) {
          if (rand() < 0.5) appleHandler();
          else googleHandler();
        }
      });
      appleCalls += 1;
      expect(mockAppleSignIn).toHaveBeenCalledTimes(appleCalls);
      expect(useAuthStore.getState().busy).toBe(true);
      // Sometimes another Google press races the rejection itself.
      const raceReject = rand() < 0.5;
      act(() => {
        apple.reject(CANCELED);
        if (raceReject) googleHandler();
      });
      await act(async () => {});
      await act(async () => {});
      expectNoGoogleFlow();
      expectIdleNoErrorCard(renderer);
    }
  });

  it('canceled Apple, then a REAL Google press afterwards, does start Google (the guard releases; it is not stuck busy)', async () => {
    mockAppleSignIn.mockRejectedValue(CANCELED);
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'cancelled',
      data: null,
    });
    renderer = renderScreen();
    await act(async () => {
      pressable(renderer!, APPLE).props.onPress();
    });
    expectIdleNoErrorCard(renderer);
    await act(async () => {
      pressable(renderer!, GOOGLE).props.onPress();
    });
    await act(async () => {});
    expect(mockGoogleSignin.signIn).toHaveBeenCalledTimes(1);
    // Google's own cancel is also silent.
    expectIdleNoErrorCard(renderer);
  });
});
