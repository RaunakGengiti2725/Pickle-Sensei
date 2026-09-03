/**
 * Button ledger for SignInScreen — every pressable on the pre-auth sign-in
 * landing, pressed through its real handler into the real authStore:
 *
 *   Back (ScreenHeader)        -> props.onBack
 *   Continue with Apple (iOS)  -> useAuthStore.signInWithApple
 *   Continue with Google       -> useAuthStore.signInWithGoogle
 *   Dismiss sign-in error card -> useAuthStore.clearError
 *
 * Seams are the store's own boundaries (native PickleAuth module, Google
 * SDK, account bootstrap, SQLite kv), so busy/disabled/error copy and the
 * double-tap guard are the store's real behavior, not a stubbed action.
 */
import React from 'react';
import { NativeModules, Platform, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
}));

// SQLite is absent under jest; the store's kv writes are best-effort.
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
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
    legalPrivacyUrl: 'https://api.example.test/privacy',
    legalTermsUrl: 'https://api.example.test/terms',
    appStoreId: null,
    appStoreWriteReviewUrl: null,
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
jest.mock('../../src/account/bootstrap', () => {
  const actual = jest.requireActual<
    typeof import('../../src/account/bootstrap')
  >('../../src/account/bootstrap');
  return {
    AccountBootstrapError: actual.AccountBootstrapError,
    bootstrapCanonicalAccount: (...args: unknown[]) =>
      mockBootstrapCanonicalAccount(...args),
  };
});

import { SignInScreen } from '../../src/screens/SignInScreen';
import { useAuthStore } from '../../src/auth/authStore';
import { AccountBootstrapError } from '../../src/account/bootstrap';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { clearSyncRuntime } from '../../src/data/syncRuntime';

const CANONICAL_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';

function bootstrapResult(provider: 'apple' | 'google', email: string | null) {
  return {
    account: { id: CANONICAL_ID, email, onboardingState: 'complete' },
    apiSession: {
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'provider-token',
      canonicalAppUserId: CANONICAL_ID,
      provider,
    },
  };
}

function googleSuccess(idToken: string | null) {
  return {
    type: 'success',
    data: {
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
    },
  };
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

const mockAppleSignIn = jest.fn<
  Promise<{
    user: string;
    identityToken?: string;
    authorizationCode?: string;
    email?: string;
    givenName?: string;
    familyName?: string;
  }>,
  []
>();
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

/**
 * The Pressable element PressableScale renders: the only composite node
 * carrying onPress AND the resolved accessibilityRole (PressableScale itself
 * receives no role here, the host View receives no onPress).
 */
function isPressableElement(node: TestRenderer.ReactTestInstance) {
  return (
    typeof node.type !== 'string' &&
    typeof node.props.onPress === 'function' &&
    typeof node.props.accessibilityRole === 'string'
  );
}

function allPressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(isPressableElement);
}

function pressables(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return allPressables(renderer).filter(
    node => node.props.accessibilityLabel === label,
  );
}

function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = pressables(renderer, label);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function press(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return act(async () => {
    pressable(renderer, label).props.onPress();
  });
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, entry) => ({ ...acc, ...flattenStyle(entry) }),
      {},
    );
  }
  return style && typeof style === 'object'
    ? (style as Record<string, unknown>)
    : {};
}

function pressableStyle(node: TestRenderer.ReactTestInstance) {
  const style = node.props.style;
  return flattenStyle(
    typeof style === 'function' ? style({ pressed: false }) : style,
  );
}

const APPLE = 'Continue with Apple';
const GOOGLE = 'Continue with Google';
const BACK = 'Back';
const DISMISS = 'Dismiss sign-in error';

describe('SignInScreen button ledger', () => {
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
    // A successful sign-in arms the outbox sync interval; stop it so the
    // suite exits cleanly.
    clearSyncRuntime();
    clearApiSession();
    delete nativeModules.PickleAuth;
    jest.restoreAllMocks();
  });

  it('renders exactly the ledger pressables on iOS, each a labelled button with a >=44pt target', () => {
    const renderer = renderScreen();
    const back = pressable(renderer, BACK);
    const apple = pressable(renderer, APPLE);
    const google = pressable(renderer, GOOGLE);
    // No error is showing, so the dismiss card is not mounted yet.
    expect(pressables(renderer, DISMISS)).toHaveLength(0);
    expect(allPressables(renderer)).toHaveLength(3);

    for (const node of [back, apple, google]) {
      expect(node.props.accessibilityRole).toBe('button');
      expect(typeof node.props.onPress).toBe('function');
      expect(node.props.accessibilityState.disabled).not.toBe(true);
    }
    const backStyle = pressableStyle(back);
    expect(backStyle.width).toBe(44);
    expect(backStyle.height).toBe(44);
    expect(back.props.hitSlop).toBe(8);
    expect(pressableStyle(apple).minHeight).toBeGreaterThanOrEqual(44);
    expect(pressableStyle(google).minHeight).toBeGreaterThanOrEqual(44);
    act(() => renderer.unmount());
  });

  it('hides Continue with Apple on Android and keeps Google reachable', () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const renderer = renderScreen();
    expect(pressables(renderer, APPLE)).toHaveLength(0);
    pressable(renderer, GOOGLE);
    pressable(renderer, BACK);
    act(() => renderer.unmount());
  });

  it('Back -> props.onBack', async () => {
    const onBack = jest.fn();
    const renderer = renderScreen(onBack);
    await press(renderer, BACK);
    expect(onBack).toHaveBeenCalledTimes(1);
    // Back is not gated on busy: a user can always leave the screen.
    act(() => {
      useAuthStore.setState({ busy: true });
    });
    expect(pressable(renderer, BACK).props.disabled).toBeUndefined();
    await press(renderer, BACK);
    expect(onBack).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  it('Continue with Apple -> signInWithApple: busy copy, disabled providers, double-tap guard, synced session', async () => {
    const apple = deferred<{
      user: string;
      identityToken?: string;
      authorizationCode?: string;
      email?: string;
      givenName?: string;
      familyName?: string;
    }>();
    mockAppleSignIn.mockReturnValue(apple.promise);
    mockBootstrapCanonicalAccount.mockResolvedValue(
      bootstrapResult('apple', 'pat@privaterelay.example'),
    );
    const renderer = renderScreen();

    await press(renderer, APPLE);
    expect(mockAppleSignIn).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('Signing in securely…');
    expect(pressable(renderer, APPLE).props.disabled).toBe(true);
    expect(pressable(renderer, GOOGLE).props.disabled).toBe(true);
    expect(pressable(renderer, APPLE).props.accessibilityState).toMatchObject({
      disabled: true,
    });
    // Even bypassing the disabled prop, the store refuses a second flow.
    await press(renderer, APPLE);
    await press(renderer, GOOGLE);
    expect(mockAppleSignIn).toHaveBeenCalledTimes(1);
    expect(mockGoogleSignin.signIn).not.toHaveBeenCalled();

    await act(async () => {
      apple.resolve({
        user: 'apple-user-1',
        identityToken: 'apple-identity-token',
        authorizationCode: 'one-use-apple-code',
        email: 'pat@privaterelay.example',
        givenName: 'Pat',
        familyName: 'Player',
      });
    });
    expect(mockBootstrapCanonicalAccount).toHaveBeenCalledTimes(1);
    expect(mockBootstrapCanonicalAccount.mock.calls[0]![0]).toMatchObject({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'apple-identity-token',
      provider: 'apple',
      appleAuthorizationCode: 'one-use-apple-code',
    });
    const state = useAuthStore.getState();
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
    expect(state.session).toMatchObject({
      provider: 'apple',
      canonicalAppUserId: CANONICAL_ID,
      localOnly: false,
      displayName: 'Pat Player',
      email: 'pat@privaterelay.example',
    });
    expect(getApiSession()).toMatchObject({
      provider: 'apple',
      canonicalAppUserId: CANONICAL_ID,
    });
    expect(allText(renderer)).not.toContain('Signing in securely…');
    expect(pressable(renderer, APPLE).props.disabled).toBe(false);
    expect(pressable(renderer, GOOGLE).props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('Continue with Apple failure -> SIGN-IN FAILED card with the message, providers re-enabled; card press -> clearError', async () => {
    mockAppleSignIn.mockRejectedValue(new Error('Apple could not verify you.'));
    const renderer = renderScreen();

    await press(renderer, APPLE);
    expect(mockBootstrapCanonicalAccount).not.toHaveBeenCalled();
    const copy = allText(renderer);
    expect(copy).toContain('SIGN-IN FAILED');
    expect(copy).toContain('Apple could not verify you.');
    expect(copy).not.toContain('Signing in securely…');
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().busy).toBe(false);
    expect(pressable(renderer, APPLE).props.disabled).toBe(false);
    expect(pressable(renderer, GOOGLE).props.disabled).toBe(false);

    const dismiss = pressable(renderer, DISMISS);
    expect(dismiss.props.accessibilityRole).toBe('button');
    expect(dismiss.props.accessibilityHint).toBe('Apple could not verify you.');
    expect(dismiss.props.accessibilityLiveRegion).toBe('assertive');

    await press(renderer, DISMISS);
    expect(useAuthStore.getState().error).toBeNull();
    expect(pressables(renderer, DISMISS)).toHaveLength(0);
    expect(allText(renderer)).not.toContain('SIGN-IN FAILED');
    act(() => renderer.unmount());
  });

  it('Continue with Apple with the native module missing -> NOT CONFIGURED YET card, no fake session', async () => {
    delete nativeModules.PickleAuth;
    const renderer = renderScreen();

    await press(renderer, APPLE);
    const copy = allText(renderer);
    expect(copy).toContain('NOT CONFIGURED YET');
    expect(copy).toContain(
      'Native Apple sign-in module is missing from this build.',
    );
    expect(useAuthStore.getState().session).toBeNull();
    expect(pressable(renderer, APPLE).props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('Continue with Apple canceled by the user -> no error card, providers re-enabled', async () => {
    mockAppleSignIn.mockRejectedValue({
      code: 'auth.canceled',
      message: 'Sign-in canceled.',
    });
    const renderer = renderScreen();

    await press(renderer, APPLE);
    expect(pressables(renderer, DISMISS)).toHaveLength(0);
    expect(allText(renderer)).not.toContain('SIGN-IN FAILED');
    expect(allText(renderer)).not.toContain('Signing in securely…');
    expect(useAuthStore.getState().busy).toBe(false);
    expect(pressable(renderer, APPLE).props.disabled).toBe(false);
    expect(pressable(renderer, GOOGLE).props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('Continue with Apple whose bootstrap fails -> SIGN-IN FAILED with the server message, runtime torn down', async () => {
    mockAppleSignIn.mockResolvedValue({
      user: 'apple-user-1',
      identityToken: 'apple-identity-token',
    });
    mockBootstrapCanonicalAccount.mockRejectedValue(
      new AccountBootstrapError(
        'account.unavailable',
        'The account service is unavailable. Try again shortly.',
        true,
      ),
    );
    const renderer = renderScreen();

    await press(renderer, APPLE);
    const copy = allText(renderer);
    expect(copy).toContain('SIGN-IN FAILED');
    expect(copy).toContain(
      'The account service is unavailable. Try again shortly.',
    );
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(pressable(renderer, APPLE).props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('Continue with Google -> signInWithGoogle: SDK configured with both client ids, synced session', async () => {
    const signIn = deferred<unknown>();
    mockGoogleSignin.signIn.mockReturnValue(signIn.promise);
    mockBootstrapCanonicalAccount.mockResolvedValue(
      bootstrapResult('google', 'pat@example.com'),
    );
    const renderer = renderScreen();

    await press(renderer, GOOGLE);
    expect(mockGoogleSignin.configure).toHaveBeenCalledWith({
      webClientId: 'test-web-client.apps.googleusercontent.com',
      iosClientId: 'test-ios-client.apps.googleusercontent.com',
    });
    expect(mockGoogleSignin.hasPlayServices).toHaveBeenCalledWith({
      showPlayServicesUpdateDialog: false,
    });
    expect(mockGoogleSignin.signIn).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('Signing in securely…');
    expect(pressable(renderer, GOOGLE).props.disabled).toBe(true);
    expect(pressable(renderer, APPLE).props.disabled).toBe(true);
    await press(renderer, GOOGLE);
    expect(mockGoogleSignin.signIn).toHaveBeenCalledTimes(1);

    await act(async () => {
      signIn.resolve(googleSuccess('google-id-token'));
    });
    expect(mockBootstrapCanonicalAccount.mock.calls[0]![0]).toMatchObject({
      bearerToken: 'google-id-token',
      provider: 'google',
    });
    const state = useAuthStore.getState();
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
    expect(state.session).toMatchObject({
      provider: 'google',
      canonicalAppUserId: CANONICAL_ID,
      localOnly: false,
      displayName: 'Pat Player',
      email: 'pat@example.com',
    });
    expect(allText(renderer)).not.toContain('Signing in securely…');
    expect(pressable(renderer, GOOGLE).props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('Continue with Google canceled in the SDK sheet -> no error card, providers re-enabled', async () => {
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'cancelled',
      data: null,
    });
    const renderer = renderScreen();

    await press(renderer, GOOGLE);
    expect(mockBootstrapCanonicalAccount).not.toHaveBeenCalled();
    expect(pressables(renderer, DISMISS)).toHaveLength(0);
    expect(allText(renderer)).not.toContain('SIGN-IN FAILED');
    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().session).toBeNull();
    expect(pressable(renderer, GOOGLE).props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('Continue with Google SDK failure -> SIGN-IN FAILED with the SDK message; dismiss clears it', async () => {
    mockGoogleSignin.signIn.mockRejectedValue(
      new Error('Google Play services are out of date.'),
    );
    const renderer = renderScreen();

    await press(renderer, GOOGLE);
    const copy = allText(renderer);
    expect(copy).toContain('SIGN-IN FAILED');
    expect(copy).toContain('Google Play services are out of date.');
    expect(useAuthStore.getState().busy).toBe(false);
    expect(pressable(renderer, GOOGLE).props.disabled).toBe(false);

    await press(renderer, DISMISS);
    expect(pressables(renderer, DISMISS)).toHaveLength(0);
    expect(useAuthStore.getState().error).toBeNull();
    act(() => renderer.unmount());
  });

  it('Continue with Google whose bootstrap reports not_configured -> NOT CONFIGURED YET card', async () => {
    mockGoogleSignin.signIn.mockResolvedValue(googleSuccess('google-id-token'));
    mockBootstrapCanonicalAccount.mockRejectedValue(
      new AccountBootstrapError(
        'account.not_configured',
        'Synced accounts need a public API URL in the release configuration.',
        false,
      ),
    );
    const renderer = renderScreen();

    await press(renderer, GOOGLE);
    const copy = allText(renderer);
    expect(copy).toContain('NOT CONFIGURED YET');
    expect(copy).toContain(
      'Synced accounts need a public API URL in the release configuration.',
    );
    expect(useAuthStore.getState().session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(pressable(renderer, GOOGLE).props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('Continue with Google with a rejected server bootstrap -> SIGN-IN FAILED, retry re-runs the flow', async () => {
    mockGoogleSignin.signIn.mockResolvedValue(googleSuccess('google-id-token'));
    mockBootstrapCanonicalAccount
      .mockRejectedValueOnce(
        new AccountBootstrapError(
          'account.rejected',
          'This sign-in was rejected. Please try again.',
          false,
        ),
      )
      .mockResolvedValueOnce(bootstrapResult('google', 'pat@example.com'));
    const renderer = renderScreen();

    await press(renderer, GOOGLE);
    expect(allText(renderer)).toContain(
      'This sign-in was rejected. Please try again.',
    );
    expect(useAuthStore.getState().session).toBeNull();

    // Retrying from the same screen clears the error and completes.
    await press(renderer, GOOGLE);
    expect(mockGoogleSignin.signIn).toHaveBeenCalledTimes(2);
    expect(mockBootstrapCanonicalAccount).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().error).toBeNull();
    expect(useAuthStore.getState().session).toMatchObject({
      provider: 'google',
    });
    expect(pressables(renderer, DISMISS)).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('error card never renders raw for a canceled code but does for every other code', () => {
    useAuthStore.setState({
      error: { code: 'auth.canceled', message: 'Sign-in canceled.' },
    });
    const renderer = renderScreen();
    expect(pressables(renderer, DISMISS)).toHaveLength(0);

    act(() => {
      useAuthStore.setState({
        error: { code: 'auth.failed', message: 'Sign-in failed.' },
      });
    });
    expect(pressable(renderer, DISMISS).props.accessibilityHint).toBe(
      'Sign-in failed.',
    );
    expect(allText(renderer)).toContain('SIGN-IN FAILED');
    act(() => renderer.unmount());
  });
});
