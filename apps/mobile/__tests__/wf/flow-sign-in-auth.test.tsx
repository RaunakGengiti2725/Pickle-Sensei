/**
 * sign-in-auth flow, driven through the SignInScreen buttons exactly as a
 * user would tap them: Continue with Apple / Continue with Google / Back /
 * the dismissable error card. Every branch is exercised end-to-end through
 * the real authStore + bootstrapCanonicalAccount over a mocked fetch:
 * success, provider cancel, provider failure, backend 401, backend outage,
 * missing configuration, double-tap, and Back while busy.
 *
 * Mock style follows authHydrateRestore.test.ts (kv-backed LocalDb, Google
 * SDK module mock, jest.fn fetch) and manageAccountScreen.test.tsx
 * (react-test-renderer + act, accessibilityLabel lookups).
 */
import React from 'react';
import { NativeModules, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';
import { BrandSpinner } from '../../src/design/components';

// ─── Module seams ────────────────────────────────────────────────────────────

const mockKv = new Map<string, string>();
function mockCurrentDb(): LocalDb {
  return {
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
  };
}
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

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

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    initialWindowMetrics: null,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

import { SignInScreen } from '../../src/screens/SignInScreen';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const LAST_PROVIDER_KEY = 'auth.last-provider';
const LOCAL_MODE_KEY = 'auth.local-mode';
const GOOGLE_FLAG = JSON.stringify({ version: 1, provider: 'google' });
const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';

type NativeApple = {
  signInWithApple: jest.Mock;
};
const mockAppleSignIn = jest.fn();
const nativeModules = NativeModules as { PickleAuth?: NativeApple };

function applePayload(identityToken: string) {
  return {
    user: 'apple-sub-001',
    identityToken,
    email: 'pat@privaterelay.example',
    givenName: 'Pat',
    familyName: 'Player',
  };
}

function googleUser(idToken: string | null) {
  return {
    user: {
      id: 'google-uid-1',
      name: 'Pat Player',
      email: 'pat@gmail.example',
      photo: null,
      familyName: 'Player',
      givenName: 'Pat',
    },
    scopes: [],
    idToken,
    serverAuthCode: null,
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function bootstrapSuccessFetch(): jest.Mock {
  return jest.fn().mockResolvedValue(
    response({
      user: { id: canonicalId, email: 'pat@example.com' },
      onboardingState: 'complete',
    }),
  );
}

const realFetch = globalThis.fetch;
function installFetch(fetchMock: jest.Mock): void {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

function nativeError(code: string, message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ─── Render helpers ──────────────────────────────────────────────────────────

const onBack = jest.fn();
const mounted: TestRenderer.ReactTestRenderer[] = [];

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<SignInScreen onBack={onBack} />);
  });
  mounted.push(renderer);
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

// Every tappable control in the flow is a PressableScale → Pressable; the
// Pressable (label + onPress + accessibilityState) is the element a user and
// the accessibility tree hit.
function maybeControl(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityState !== undefined,
  );
}

function control(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = maybeControl(renderer, label);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

async function press(node: TestRenderer.ReactTestInstance) {
  await act(async () => {
    node.props.onPress();
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function expectIdleButtons(renderer: TestRenderer.ReactTestRenderer) {
  for (const label of ['Continue with Apple', 'Continue with Google']) {
    const button = control(renderer, label);
    expect(button.props.disabled).toBe(false);
    expect(button.props.accessibilityState.disabled).toBe(false);
    expect(typeof button.props.onPress).toBe('function');
  }
  expect(renderer.root.findAllByType(BrandSpinner)).toHaveLength(0);
  expect(allText(renderer)).not.toContain('Signing in securely…');
}

function expectBusyButtons(renderer: TestRenderer.ReactTestRenderer) {
  for (const label of ['Continue with Apple', 'Continue with Google']) {
    const button = control(renderer, label);
    expect(button.props.disabled).toBe(true);
    expect(button.props.accessibilityState.disabled).toBe(true);
  }
  expect(renderer.root.findAllByType(BrandSpinner)).toHaveLength(1);
  expect(allText(renderer)).toContain('Signing in securely…');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: true,
    session: null,
    busy: false,
    error: null,
  });
  nativeModules.PickleAuth = { signInWithApple: mockAppleSignIn };
  mockAppleSignIn.mockReset();
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signIn.mockResolvedValue({ type: 'cancelled', data: null });
  mockGoogleSignin.signOut.mockResolvedValue(null);
  installFetch(
    jest.fn().mockRejectedValue(new Error('fetch not configured in test')),
  );
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => {
      renderer.unmount();
    });
  }
  clearSyncRuntime();
  clearApiSession();
  globalThis.fetch = realFetch;
  delete nativeModules.PickleAuth;
});

// ─── Static surface ──────────────────────────────────────────────────────────

describe('SignInScreen surface', () => {
  it('renders both provider buttons and a Back control with button semantics; no busy row or error card at rest', () => {
    const renderer = renderScreen();
    const copy = allText(renderer);
    expect(copy).toContain('Continue with Apple');
    expect(copy).toContain('Continue with Google');
    expect(copy).toContain('Your ratings,');
    expect(copy).toContain('tied to you.');
    expect(copy).toContain(
      'A connected account is required for free ratings, membership, and server-verified coaching. Synced progress stays with that account.',
    );

    for (const label of [
      'Continue with Apple',
      'Continue with Google',
      'Back',
    ]) {
      const node = control(renderer, label);
      expect(node.props.accessibilityRole).toBe('button');
      expect(node.props.accessibilityLabel).toBe(label);
      expect(typeof node.props.onPress).toBe('function');
    }
    expectIdleButtons(renderer);
    expect(maybeControl(renderer, 'Dismiss sign-in error')).toHaveLength(0);
  });

  it('Back is wired to the caller-supplied onBack (pre-auth: Welcome; ConnectAccount: navigation.goBack)', async () => {
    const renderer = renderScreen();
    await press(control(renderer, 'Back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

// ─── Sign in with Apple ──────────────────────────────────────────────────────

describe('Continue with Apple', () => {
  it('success: busy row + disabled buttons while pending, then a synced Apple session with the canonical id and no persisted token', async () => {
    const pending = deferred<ReturnType<typeof applePayload>>();
    mockAppleSignIn.mockReturnValue(pending.promise);
    const fetchMock = bootstrapSuccessFetch();
    installFetch(fetchMock);
    // A stale Google flag must not survive an Apple sign-in.
    mockKv.set(LAST_PROVIDER_KEY, GOOGLE_FLAG);

    const renderer = renderScreen();
    await press(control(renderer, 'Continue with Apple'));

    expect(mockAppleSignIn).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().busy).toBe(true);
    expectBusyButtons(renderer);
    // Back stays reachable while the provider sheet is up.
    expect(control(renderer, 'Back').props.disabled).toBeUndefined();

    await act(async () => {
      pending.resolve(applePayload('apple-identity-token-1'));
    });
    await settle();

    const state = useAuthStore.getState();
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
    expect(state.session).toEqual({
      provider: 'apple',
      subject: canonicalId,
      canonicalAppUserId: canonicalId,
      localOnly: false,
      displayName: 'Pat Player',
      email: 'pat@example.com',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/account/bootstrap',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer apple-identity-token-1',
        }),
      }),
    );
    expect(getApiSession()).toMatchObject({
      bearerToken: 'apple-identity-token-1',
      canonicalAppUserId: canonicalId,
      provider: 'apple',
    });
    expect(getActiveDataOwner()).toBe(canonicalId);
    // Apple has no silent-restore path: the flag is disarmed, and the token
    // itself never reaches the kv store.
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe('');
    for (const value of mockKv.values()) {
      expect(value).not.toContain('apple-identity-token-1');
    }
    expectIdleButtons(renderer);
    expect(maybeControl(renderer, 'Dismiss sign-in error')).toHaveLength(0);
  });

  it('cancel: the native auth.canceled rejection clears busy, shows no error card, and leaves both buttons tappable', async () => {
    mockAppleSignIn.mockRejectedValue(
      nativeError('auth.canceled', 'Sign-in canceled.'),
    );
    const fetchMock = bootstrapSuccessFetch();
    installFetch(fetchMock);

    const renderer = renderScreen();
    await press(control(renderer, 'Continue with Apple'));
    await settle();

    const state = useAuthStore.getState();
    expect(state.busy).toBe(false);
    expect(state.session).toBeNull();
    expect(state.error).toEqual({
      code: 'auth.canceled',
      message: 'Sign-in canceled.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getApiSession()).toBeNull();
    expectIdleButtons(renderer);
    expect(maybeControl(renderer, 'Dismiss sign-in error')).toHaveLength(0);
    expect(allText(renderer)).not.toContain('SIGN-IN FAILED');

    // The user can immediately try again.
    mockAppleSignIn.mockResolvedValue(applePayload('apple-identity-token-2'));
    await press(control(renderer, 'Continue with Apple'));
    await settle();
    expect(useAuthStore.getState().session?.provider).toBe('apple');
  });

  it('provider failure: a SIGN-IN FAILED card with the message, assertive live region, and a dismiss action that restores the idle screen', async () => {
    mockAppleSignIn.mockRejectedValue(
      nativeError(
        'auth.failed',
        'Apple authorization failed (com.apple.AuthenticationServices.AuthorizationError code 1000): The operation couldn’t be completed.',
      ),
    );

    const renderer = renderScreen();
    await press(control(renderer, 'Continue with Apple'));
    await settle();

    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().session).toBeNull();
    const copy = allText(renderer);
    expect(copy).toContain('SIGN-IN FAILED');
    expect(copy).toContain('Apple authorization failed');

    const card = control(renderer, 'Dismiss sign-in error');
    expect(card.props.accessibilityRole).toBe('button');
    expect(card.props.accessibilityLiveRegion).toBe('assertive');
    expect(card.props.accessibilityHint).toContain(
      'Apple authorization failed',
    );
    expectIdleButtons(renderer);

    await press(card);
    expect(useAuthStore.getState().error).toBeNull();
    expect(maybeControl(renderer, 'Dismiss sign-in error')).toHaveLength(0);
    expect(allText(renderer)).not.toContain('SIGN-IN FAILED');
  });

  it('backend 401 during bootstrap: SIGN-IN FAILED with the server message, no session, no api session, busy cleared', async () => {
    mockAppleSignIn.mockResolvedValue(applePayload('apple-identity-token-3'));
    installFetch(
      jest
        .fn()
        .mockResolvedValue(
          response(
            { error: { message: 'The identity token could not be verified.' } },
            401,
          ),
        ),
    );

    const renderer = renderScreen();
    await press(control(renderer, 'Continue with Apple'));
    await settle();

    const state = useAuthStore.getState();
    expect(state.busy).toBe(false);
    expect(state.session).toBeNull();
    expect(state.error).toEqual({
      code: 'auth.failed',
      message: 'The identity token could not be verified.',
    });
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(allText(renderer)).toContain(
      'The identity token could not be verified.',
    );
    expectIdleButtons(renderer);
  });

  it('backend outage during bootstrap: an honest temporarily-unavailable card and a retry that succeeds', async () => {
    mockAppleSignIn.mockResolvedValue(applePayload('apple-identity-token-4'));
    installFetch(jest.fn().mockRejectedValue(new Error('network down')));

    const renderer = renderScreen();
    await press(control(renderer, 'Continue with Apple'));
    await settle();

    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().error).toEqual({
      code: 'auth.failed',
      message: 'Secure account setup is temporarily unavailable.',
    });
    expect(allText(renderer)).toContain(
      'Secure account setup is temporarily unavailable.',
    );
    expectIdleButtons(renderer);

    installFetch(bootstrapSuccessFetch());
    await press(control(renderer, 'Continue with Apple'));
    await settle();
    expect(useAuthStore.getState().error).toBeNull();
    expect(useAuthStore.getState().session?.provider).toBe('apple');
    expect(maybeControl(renderer, 'Dismiss sign-in error')).toHaveLength(0);
  });

  it('missing native module: NOT CONFIGURED YET card, never a fake session, busy cleared', async () => {
    delete nativeModules.PickleAuth;

    const renderer = renderScreen();
    await press(control(renderer, 'Continue with Apple'));
    await settle();

    const state = useAuthStore.getState();
    expect(state.busy).toBe(false);
    expect(state.session).toBeNull();
    expect(state.error?.code).toBe('auth.not_configured');
    const copy = allText(renderer);
    expect(copy).toContain('NOT CONFIGURED YET');
    expect(copy).toContain(
      'Native Apple sign-in module is missing from this build.',
    );
    expectIdleButtons(renderer);
  });

  it('double-tap guard: repeated presses and a Google press while Apple is pending are ignored', async () => {
    const pending = deferred<ReturnType<typeof applePayload>>();
    mockAppleSignIn.mockReturnValue(pending.promise);
    installFetch(bootstrapSuccessFetch());

    const renderer = renderScreen();
    const apple = control(renderer, 'Continue with Apple');
    await press(apple);
    // The disabled prop already blocks real taps; the store guard covers a
    // press that races the re-render.
    await press(apple);
    await press(control(renderer, 'Continue with Google'));
    await act(async () => {
      await useAuthStore.getState().signInWithApple();
      await useAuthStore.getState().signInWithGoogle();
    });

    expect(mockAppleSignIn).toHaveBeenCalledTimes(1);
    expect(mockGoogleSignin.signIn).not.toHaveBeenCalled();
    expectBusyButtons(renderer);

    await act(async () => {
      pending.resolve(applePayload('apple-identity-token-5'));
    });
    await settle();
    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().session?.provider).toBe('apple');
  });
});

// ─── Google sign-in ──────────────────────────────────────────────────────────

describe('Continue with Google', () => {
  it('success: configures the SDK with both client ids and lands a synced Google session that arms silent restore', async () => {
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'success',
      data: googleUser('google-id-token-1'),
    });
    const fetchMock = bootstrapSuccessFetch();
    installFetch(fetchMock);

    const renderer = renderScreen();
    await press(control(renderer, 'Continue with Google'));
    await settle();

    expect(mockGoogleSignin.configure).toHaveBeenCalledWith({
      webClientId: 'test-web-client.apps.googleusercontent.com',
      iosClientId: 'test-ios-client.apps.googleusercontent.com',
    });
    expect(mockGoogleSignin.hasPlayServices).toHaveBeenCalledWith({
      showPlayServicesUpdateDialog: false,
    });
    const state = useAuthStore.getState();
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
    expect(state.session).toEqual({
      provider: 'google',
      subject: canonicalId,
      canonicalAppUserId: canonicalId,
      localOnly: false,
      displayName: 'Pat Player',
      email: 'pat@example.com',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/account/bootstrap',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer google-id-token-1',
        }),
      }),
    );
    expect(getApiSession()).toMatchObject({
      bearerToken: 'google-id-token-1',
      provider: 'google',
    });
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe(GOOGLE_FLAG);
    for (const value of mockKv.values()) {
      expect(value).not.toContain('google-id-token-1');
    }
    expectIdleButtons(renderer);
  });

  it('cancel: the SDK "cancelled" result clears busy with no error card and no bootstrap call', async () => {
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'cancelled',
      data: null,
    });
    const fetchMock = bootstrapSuccessFetch();
    installFetch(fetchMock);

    const renderer = renderScreen();
    await press(control(renderer, 'Continue with Google'));
    await settle();

    const state = useAuthStore.getState();
    expect(state.busy).toBe(false);
    expect(state.session).toBeNull();
    expect(state.error?.code).toBe('auth.canceled');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBeUndefined();
    expect(maybeControl(renderer, 'Dismiss sign-in error')).toHaveLength(0);
    expectIdleButtons(renderer);
  });

  it('provider failure: SDK rejection surfaces SIGN-IN FAILED with the SDK message and a dismiss action', async () => {
    mockGoogleSignin.signIn.mockRejectedValue(
      nativeError('SIGN_IN_REQUIRED', 'Google sign-in is unavailable.'),
    );

    const renderer = renderScreen();
    await press(control(renderer, 'Continue with Google'));
    await settle();

    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().error).toEqual({
      code: 'auth.failed',
      message: 'Google sign-in is unavailable.',
    });
    const copy = allText(renderer);
    expect(copy).toContain('SIGN-IN FAILED');
    expect(copy).toContain('Google sign-in is unavailable.');
    await press(control(renderer, 'Dismiss sign-in error'));
    expect(useAuthStore.getState().error).toBeNull();
    expectIdleButtons(renderer);
  });

  it('Play Services failure surfaces as a typed failure, never an infinite busy state', async () => {
    mockGoogleSignin.hasPlayServices.mockRejectedValue(
      nativeError('PLAY_SERVICES_NOT_AVAILABLE', 'Play services not available'),
    );

    const renderer = renderScreen();
    await press(control(renderer, 'Continue with Google'));
    await settle();

    expect(mockGoogleSignin.signIn).not.toHaveBeenCalled();
    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().error).toEqual({
      code: 'auth.failed',
      message: 'Play services not available',
    });
    expectIdleButtons(renderer);
  });

  it('SDK success without an idToken is rejected before any account is created', async () => {
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'success',
      data: googleUser(null),
    });
    const fetchMock = bootstrapSuccessFetch();
    installFetch(fetchMock);

    const renderer = renderScreen();
    await press(control(renderer, 'Continue with Google'));
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().error).toEqual({
      code: 'auth.failed',
      message:
        'The identity provider did not return a token for secure account setup.',
    });
    expect(allText(renderer)).toContain('SIGN-IN FAILED');
  });

  it('backend 401 during bootstrap: SIGN-IN FAILED with the server message and no armed silent restore', async () => {
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'success',
      data: googleUser('google-id-token-2'),
    });
    installFetch(
      jest
        .fn()
        .mockResolvedValue(
          response(
            { error: { message: 'The identity token could not be verified.' } },
            401,
          ),
        ),
    );

    const renderer = renderScreen();
    await press(control(renderer, 'Continue with Google'));
    await settle();

    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().error?.message).toBe(
      'The identity token could not be verified.',
    );
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBeUndefined();
    expect(getApiSession()).toBeNull();
    expect(allText(renderer)).toContain('SIGN-IN FAILED');
    expectIdleButtons(renderer);
  });

  it('double-tap guard: a second press while the Google sheet is up never starts a second sign-in', async () => {
    const pending = deferred<{
      type: 'success';
      data: ReturnType<typeof googleUser>;
    }>();
    mockGoogleSignin.signIn.mockReturnValue(pending.promise);
    installFetch(bootstrapSuccessFetch());

    const renderer = renderScreen();
    const google = control(renderer, 'Continue with Google');
    await press(google);
    await press(google);
    await act(async () => {
      await useAuthStore.getState().signInWithGoogle();
    });
    expect(mockGoogleSignin.signIn).toHaveBeenCalledTimes(1);
    expectBusyButtons(renderer);

    await act(async () => {
      pending.resolve({
        type: 'success',
        data: googleUser('google-id-token-3'),
      });
    });
    await settle();
    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().session?.provider).toBe('google');
  });
});

// ─── Connect account (guest → provider) and sign-out ─────────────────────────

describe('ConnectAccount and sign-out', () => {
  it('a guest connecting Apple moves from the guest owner to the canonical owner and disarms the local-only flag', async () => {
    await act(async () => {
      await useAuthStore.getState().continueAsGuest();
    });
    expect(useAuthStore.getState().session).toMatchObject({
      provider: 'guest',
      localOnly: true,
      canonicalAppUserId: null,
    });
    expect(getActiveDataOwner()).toBe(GUEST_DATA_OWNER);
    expect(getApiSession()).toBeNull();
    expect(mockKv.get(LOCAL_MODE_KEY)).toBe(
      JSON.stringify({ version: 1, mode: 'guest' }),
    );

    mockAppleSignIn.mockResolvedValue(applePayload('apple-identity-token-6'));
    installFetch(bootstrapSuccessFetch());
    const renderer = renderScreen();
    await press(control(renderer, 'Continue with Apple'));
    await settle();

    // ConnectAccountRoute's effect keys off provider !== 'guest' to pop
    // itself; this is the state transition it observes.
    expect(useAuthStore.getState().session).toMatchObject({
      provider: 'apple',
      localOnly: false,
      canonicalAppUserId: canonicalId,
    });
    expect(getActiveDataOwner()).toBe(canonicalId);
    expect(mockKv.get(LOCAL_MODE_KEY)).toBe('');
  });

  it('sign-out after Google: clears session, api session, owner, and the restore flag, and tolerates SDK sign-out failure', async () => {
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'success',
      data: googleUser('google-id-token-4'),
    });
    installFetch(bootstrapSuccessFetch());
    const renderer = renderScreen();
    await press(control(renderer, 'Continue with Google'));
    await settle();
    expect(useAuthStore.getState().session?.provider).toBe('google');

    mockGoogleSignin.signOut.mockRejectedValue(new Error('sdk offline'));
    await act(async () => {
      await useAuthStore.getState().signOut();
    });

    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(mockKv.get(LAST_PROVIDER_KEY)).toBe('');
    expect(mockKv.get(LOCAL_MODE_KEY)).toBe('');
    expect(mockGoogleSignin.signOut).toHaveBeenCalledTimes(1);
  });

  it('sign-out after Apple never touches the Google SDK', async () => {
    mockAppleSignIn.mockResolvedValue(applePayload('apple-identity-token-7'));
    installFetch(bootstrapSuccessFetch());
    await act(async () => {
      await useAuthStore.getState().signInWithApple();
    });
    expect(useAuthStore.getState().session?.provider).toBe('apple');

    await act(async () => {
      await useAuthStore.getState().signOut();
    });
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(mockGoogleSignin.signOut).not.toHaveBeenCalled();
  });
});
