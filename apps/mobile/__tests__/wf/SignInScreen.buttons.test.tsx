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
import {
  BackHandler,
  Modal,
  NativeModules,
  Platform,
  ScrollView,
  Text,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { create } from 'zustand';
import * as Keychain from 'react-native-keychain';
import {
  getActiveDataOwner,
  captureDataOwnerContext,
} from '../../src/data/accountScope';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SESSION_VAULT_SERVICE,
  readPersistedSession,
} from '../../src/account/sessionVault';

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaProvider: View,
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
  };
});

// SQLite is absent under jest; the store's kv writes are best-effort.
const mockKv = new Map<string, string>();
let mockRestoreWriteGate: Promise<void> | null = null;
jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        if (params[0] === 'auth.restore-state' && mockRestoreWriteGate)
          await mockRestoreWriteGate;
        mockKv.set(String(params[0]), String(params[1]));
      }
      return { rows: [] };
    },
    close() {},
  }),
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

const mockGateAppHydrate = jest.fn(async () => {
  const ownerKey = getActiveDataOwner();
  mockGateAppStore.setState({
    hydrated: true,
    ownerKey,
    profile: ownerKey === SIGNED_OUT_DATA_OWNER ? null : { skillLevel: '3.5' },
  });
});
const mockGateAppStore = create<{
  hydrated: boolean;
  ownerKey: string | null;
  profile: { skillLevel: string } | null;
  hydrateError: string | null;
  awaitingApiSession: boolean;
  hydrate: () => Promise<void>;
}>(() => ({
  hydrated: false,
  ownerKey: null,
  profile: null,
  hydrateError: null,
  awaitingApiSession: false,
  hydrate: mockGateAppHydrate,
}));
jest.mock('../../src/state/appStore', () => ({
  useAppStore: (
    selector: (s: ReturnType<typeof mockGateAppStore.getState>) => unknown,
  ) => mockGateAppStore(selector),
}));
jest.mock('../../src/navigation/RootNavigator', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    RootNavigator: () => {
      const [route, setRoute] = R.useState('ROOT_NAVIGATOR');
      return R.createElement(
        RN.View,
        { style: { flex: 1 } },
        R.createElement(RN.Text, null, route),
        R.createElement(
          RN.Pressable,
          {
            accessibilityRole: 'button',
            accessibilityLabel: 'Open another screen',
            onPress: () => setRoute('ANOTHER_ROUTE'),
          },
          R.createElement(RN.Text, null, 'Open another screen'),
        ),
      );
    },
  };
});
jest.mock('../../src/screens/WelcomeScreen', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    WelcomeScreen: (props: { onSignIn: () => void }) =>
      R.createElement(
        RN.Pressable,
        {
          accessibilityRole: 'button',
          accessibilityLabel: 'I already have an account',
          onPress: props.onSignIn,
        },
        R.createElement(RN.Text, null, 'WELCOME'),
      ),
  };
});
jest.mock('../../src/screens/OnboardingScreen', () => ({
  OnboardingScreen: () => null,
}));
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
jest.mock('../../src/flow/CeremonyHost', () => ({
  CeremonyHost: ({ children }: { children: React.ReactNode }) => children,
}));
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
jest.mock('../../src/notifications/useNotificationBootstrap', () => ({
  useNotificationBootstrap: () => {},
}));
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));
jest.mock('../../src/diagnostics/sentry', () => ({
  captureBoundaryError: jest.fn(),
  resetDiagnosticsScope: jest.fn(),
}));

import App from '../../App';
import { SignInScreen } from '../../src/screens/SignInScreen';
import { useAuthStore, type AuthRestoreState } from '../../src/auth/authStore';
import { AccountBootstrapError } from '../../src/account/bootstrap';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { ScreenHeader } from '../../src/design/components';
import { type } from '../../src/design/tokens';

const CANONICAL_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const OWNER_B = '11111111-1111-4111-8111-111111111111';
const keychainStore = (
  Keychain as unknown as {
    __keychainStore: Map<string, { username: string; password: string }>;
  }
).__keychainStore;

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

const mounted: TestRenderer.ReactTestRenderer[] = [];

function renderScreen(onBack: () => void = jest.fn(), gateActive?: boolean) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SignInScreen onBack={onBack} gateActive={gateActive} />,
    );
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

function requireReturningSignIn(
  reason: Extract<
    AuthRestoreState,
    { status: 'reauth_required' }
  >['reason'] = 'legacy_credentials_missing',
  noticePending = true,
  provider: 'apple' | 'google' | null = 'apple',
) {
  useAuthStore.setState({
    restoreState: {
      status: 'reauth_required',
      reason,
      provider,
      noticePending,
    },
  });
}

describe('SignInScreen button ledger', () => {
  beforeEach(() => {
    mockKv.clear();
    mockRestoreWriteGate = null;
    keychainStore.clear();
    stopSessionKeeper();
    mockGateAppHydrate.mockClear();
    mockGateAppStore.setState({
      hydrated: false,
      ownerKey: null,
      profile: null,
    });
    mockAppleSignIn.mockReset();
    mockBootstrapCanonicalAccount.mockReset();
    Object.values(mockGoogleSignin).forEach(fn => fn.mockReset());
    mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
    nativeModules.PickleAuth = { signInWithApple: mockAppleSignIn };
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    useAuthStore.setState({
      hydrated: true,
      session: null,
      busy: false,
      error: null,
      restoreState: { status: 'signed_out', reason: 'new_install' },
    });
  });

  afterEach(() => {
    for (const renderer of mounted.splice(0)) act(() => renderer.unmount());
    // A successful sign-in arms the outbox sync interval; stop it so the
    // suite exits cleanly.
    clearSyncRuntime();
    stopSessionKeeper();
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

  describe('returning sign-in notice', () => {
    it.each([
      [
        'legacy_credentials_missing',
        'An earlier version couldn’t keep your sign-in on this device. Please sign in once more.',
      ],
      [
        'credentials_missing',
        'This device no longer has the credentials needed to restore your sign-in.',
      ],
      [
        'revoked',
        'Your previous sign-in is no longer valid. Please sign in again to reconnect.',
      ],
    ] as const)(
      '%s explains the reason inline, without claiming a profile or launching a provider',
      (reason, explanation) => {
        requireReturningSignIn(reason);
        const renderer = renderScreen();
        expect(allText(renderer)).toContain('Sign in again.');
        expect(allText(renderer)).toContain(explanation);
        expect(allText(renderer)).toContain(
          'Use the same Apple account to check for a saved coaching profile and synced progress.',
        );
        expect(allText(renderer)).toContain(
          'Any saved profile stays private until the matching account is verified.',
        );
        expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
        expect(
          pressableStyle(pressable(renderer, 'Got it')).minHeight,
        ).toBeGreaterThanOrEqual(44);
        expect(mockAppleSignIn).not.toHaveBeenCalled();
        expect(mockGoogleSignin.signIn).not.toHaveBeenCalled();
        expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
        expect(useAuthStore.getState().restoreState).toMatchObject({
          noticePending: true,
        });
      },
    );

    it.each([
      ['google', 'Use the same Google account'],
      [null, 'Use the account you used before'],
    ] as const)(
      'uses only the %s provider hint, not an unverified name or profile',
      (provider, copy) => {
        requireReturningSignIn('credentials_missing', true, provider);
        const renderer = renderScreen();
        expect(allText(renderer)).toContain(copy);
        expect(allText(renderer)).toContain(
          'check for a saved coaching profile',
        );
        expect(useAuthStore.getState().session).toBeNull();
      },
    );

    it('is visible only when pending; mounting, hiding and unmounting never acknowledges it', () => {
      requireReturningSignIn();
      const onBack = jest.fn();
      const renderer = renderScreen(onBack, false);
      expect(pressables(renderer, 'Got it')).toHaveLength(0);
      expect(useAuthStore.getState().restoreState).toMatchObject({
        noticePending: true,
      });
      act(() => renderer.update(<SignInScreen onBack={onBack} gateActive />));
      expect(pressables(renderer, 'Got it')).toHaveLength(1);
      expect(useAuthStore.getState().restoreState).toMatchObject({
        noticePending: true,
      });
      act(() => renderer.unmount());
      expect(useAuthStore.getState().restoreState).toMatchObject({
        noticePending: true,
      });
      requireReturningSignIn('legacy_credentials_missing', false);
      const acknowledged = renderScreen();
      expect(allText(acknowledged)).toContain('Sign in again.');
      expect(allText(acknowledged)).not.toContain('An earlier version');
      expect(pressables(acknowledged, 'Got it')).toHaveLength(0);
    });

    it('Got it consumes the notice through the store without signing in or navigating', async () => {
      requireReturningSignIn();
      const onBack = jest.fn();
      const renderer = renderScreen(onBack);
      await press(renderer, 'Got it');
      expect(useAuthStore.getState().restoreState).toMatchObject({
        status: 'reauth_required',
        noticePending: false,
      });
      expect(JSON.parse(mockKv.get('auth.restore-state')!)).toMatchObject({
        status: 'reauth_required',
        noticePending: false,
      });
      expect(pressables(renderer, 'Got it')).toHaveLength(0);
      expect(allText(renderer)).toContain('Sign in again.');
      expect(onBack).not.toHaveBeenCalled();
      expect(mockAppleSignIn).not.toHaveBeenCalled();
      expect(mockGoogleSignin.signIn).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      'Back consumes a visible notice and remains usable with busy=%s',
      async busy => {
        requireReturningSignIn();
        useAuthStore.setState({ busy });
        const onBack = jest.fn();
        const renderer = renderScreen(onBack);
        await press(renderer, BACK);
        expect(onBack).toHaveBeenCalledTimes(1);
        expect(useAuthStore.getState().restoreState).toMatchObject({
          noticePending: false,
        });
        expect(pressable(renderer, BACK).props.disabled).toBeUndefined();
      },
    );

    it('a hidden or stale notice action cannot consume a new returning context', async () => {
      requireReturningSignIn();
      const onBack = jest.fn();
      const renderer = renderScreen(onBack, true);
      const acknowledge = pressable(renderer, 'Got it').props.onPress;
      act(() => requireReturningSignIn('revoked'));
      await act(async () => acknowledge());
      expect(useAuthStore.getState().restoreState).toMatchObject({
        reason: 'revoked',
        noticePending: true,
      });
      act(() =>
        renderer.update(<SignInScreen onBack={onBack} gateActive={false} />),
      );
      await press(renderer, BACK);
      expect(onBack).not.toHaveBeenCalled();
      expect(useAuthStore.getState().restoreState).toMatchObject({
        noticePending: true,
      });
    });

    it('provider cancel and failure leave the notice pending; a verified sign-in success consumes it', async () => {
      requireReturningSignIn();
      mockAppleSignIn
        .mockRejectedValueOnce({
          code: 'auth.canceled',
          message: 'Sign-in canceled.',
        })
        .mockRejectedValueOnce(new Error('Apple could not verify you.'))
        .mockResolvedValueOnce({
          user: 'apple-user-1',
          identityToken: 'test-provider-token',
        });
      mockBootstrapCanonicalAccount.mockResolvedValue(
        bootstrapResult('apple', 'pat@example.test'),
      );
      const renderer = renderScreen();
      await press(renderer, APPLE);
      expect(useAuthStore.getState().restoreState).toMatchObject({
        noticePending: true,
      });
      expect(pressables(renderer, DISMISS)).toHaveLength(0);
      await press(renderer, APPLE);
      expect(useAuthStore.getState().restoreState).toMatchObject({
        noticePending: true,
      });
      expect(allText(renderer)).toContain('Apple could not verify you.');
      await press(renderer, DISMISS);
      expect(useAuthStore.getState().restoreState).toMatchObject({
        noticePending: true,
      });
      await press(renderer, APPLE);
      expect(useAuthStore.getState().restoreState).toEqual({
        status: 'restored',
        connectivity: 'online',
      });
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
        CANONICAL_ID,
      );
      expect(pressables(renderer, 'Got it')).toHaveLength(0);
    });

    it('a rejected backend bootstrap cannot claim the profile or consume the notice', async () => {
      requireReturningSignIn();
      mockAppleSignIn.mockResolvedValue({
        user: 'apple-user-1',
        identityToken: 'test-provider-token',
      });
      mockBootstrapCanonicalAccount.mockRejectedValue(
        new AccountBootstrapError(
          'account.rejected',
          'Sign-in could not be verified.',
          false,
        ),
      );
      const renderer = renderScreen();
      await press(renderer, APPLE);
      expect(useAuthStore.getState().session).toBeNull();
      expect(useAuthStore.getState().restoreState).toMatchObject({
        noticePending: true,
      });
      expect(allText(renderer)).toContain('Sign-in could not be verified.');
      expect(allText(renderer)).toContain('check for a saved coaching profile');
    });

    it('keeps notices, provider buttons and long errors inside a scalable scroll area with Back outside it', () => {
      requireReturningSignIn();
      useAuthStore.setState({
        error: {
          code: 'auth.failed',
          message: 'A long recoverable sign-in error. '.repeat(30),
        },
      });
      const renderer = renderScreen();
      const scroll = renderer.root.findByType(ScrollView);
      expect(scroll.props.scrollEnabled).not.toBe(false);
      expect(flattenStyle(scroll.props.contentContainerStyle).flexGrow).toBe(1);
      expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
      expect(scroll.findAllByType(ScreenHeader)).toHaveLength(0);
      const labels = scroll
        .findAll(isPressableElement)
        .map(node => node.props.accessibilityLabel);
      expect(labels).toEqual(
        expect.arrayContaining([APPLE, GOOGLE, 'Got it', DISMISS]),
      );
      expect(labels).not.toContain(BACK);
      for (const node of renderer.root.findAllByType(Text)) {
        expect(node.props.allowFontScaling).not.toBe(false);
        expect(node.props.maxFontSizeMultiplier).not.toBe(1);
      }
      const title = renderer.root
        .findAllByType(Text)
        .find(node => node.props.children === 'Sign in again.');
      expect(flattenStyle(title!.props.style)).toMatchObject(type.hero);
      const providerLabel = renderer.root
        .findAllByType(Text)
        .find(node => node.props.children === GOOGLE);
      expect(flattenStyle(providerLabel!.props.style)).toMatchObject({
        ...type.bodyBold,
        flexShrink: 1,
      });
    });

    it('handles hardware Back only while the Gate sign-in is active and removes the handler on exit', async () => {
      requireReturningSignIn();
      const remove = jest.fn();
      const addEventListener = jest
        .spyOn(BackHandler, 'addEventListener')
        .mockReturnValue({ remove });
      const onBack = jest.fn();
      const renderer = renderScreen(onBack, false);
      expect(addEventListener).not.toHaveBeenCalled();
      act(() => renderer.update(<SignInScreen onBack={onBack} gateActive />));
      const handler = addEventListener.mock.calls.find(
        ([event]) => event === 'hardwareBackPress',
      )?.[1];
      expect(handler).toBeDefined();
      await act(async () => {
        expect(handler!({ type: 'hardwareBackPress', timeStamp: 0 })).toBe(
          true,
        );
      });
      expect(onBack).toHaveBeenCalledTimes(1);
      expect(useAuthStore.getState().restoreState).toMatchObject({
        noticePending: false,
      });
      act(() =>
        renderer.update(<SignInScreen onBack={onBack} gateActive={false} />),
      );
      expect(remove).toHaveBeenCalled();
    });
  });

  describe('Gate with real session persistence retries', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
      stopSessionKeeper();
      jest.useRealTimers();
    });

    async function flushGate() {
      await act(async () => {
        for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
      });
    }

    function durableBootstrap(owner = CANONICAL_ID) {
      const base = bootstrapResult('apple', 'pat@example.test');
      mockAppleSignIn.mockResolvedValue({
        user: 'test-apple-user',
        identityToken: 'test-provider-token',
      });
      mockBootstrapCanonicalAccount.mockResolvedValue({
        account: { ...base.account, id: owner },
        apiSession: {
          ...base.apiSession,
          canonicalAppUserId: owner,
          bearerToken: `test-access-${owner}`,
          refreshToken: `test-refresh-${owner}`,
          bearerExpiresAtMs: Date.now() + 3_600_000,
        },
      });
    }

    async function failedVaultSignIn() {
      durableBootstrap();
      const fault = jest
        .spyOn(Keychain, 'setGenericPassword')
        .mockRejectedValue(new Error('Vault write unavailable'));
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<App />);
      });
      mounted.push(renderer);
      await flushGate();
      await press(renderer, 'I already have an account');
      expect(renderer.root.findAllByType(SignInScreen)).toHaveLength(1);
      await press(renderer, APPLE);
      await flushGate();
      expect(useAuthStore.getState().error?.code).toBe(
        'auth.storage_unavailable',
      );
      expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
      expect(renderer.root.findAllByType(SignInScreen)).toHaveLength(0);
      return { renderer, fault };
    }

    it('keeps the real failed-save warning after SignIn unmounts; retry failure retains it and confirmed native success removes it without resetting navigation', async () => {
      const { renderer, fault } = await failedVaultSignIn();
      expect(allText(renderer)).toContain('Save sign-in on this device');
      const session = useAuthStore.getState().session;
      const api = getApiSession();
      const owner = captureDataOwnerContext();
      const generation = JSON.parse(
        mockKv.get('auth.restore-state')!,
      ).generation;
      const hydrates = mockGateAppHydrate.mock.calls.length;
      await press(renderer, 'Open another screen');
      await press(renderer, 'Retry saving sign-in');
      await flushGate();
      expect(fault).toHaveBeenCalledTimes(2);
      expect(allText(renderer)).toContain('Save sign-in on this device');
      expect(allText(renderer)).toContain('ANOTHER_ROUTE');
      expect(pressable(renderer, 'Retry saving sign-in').props.disabled).toBe(
        false,
      );
      fault.mockRestore();
      await press(renderer, 'Retry saving sign-in');
      await flushGate();
      expect(useAuthStore.getState().error).toBeNull();
      expect(allText(renderer)).not.toContain('Save sign-in on this device');
      expect(allText(renderer)).toContain('ANOTHER_ROUTE');
      expect(useAuthStore.getState().session).toBe(session);
      expect(getApiSession()).toBe(api);
      expect(captureDataOwnerContext()).toEqual(owner);
      expect(mockGateAppHydrate).toHaveBeenCalledTimes(hydrates);
      expect(mockAppleSignIn).toHaveBeenCalledTimes(1);
      expect(mockBootstrapCanonicalAccount).toHaveBeenCalledTimes(1);
      expect(mockGoogleSignin.signIn).not.toHaveBeenCalled();
      expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
      await expect(readPersistedSession()).resolves.toMatchObject({
        status: 'available',
        session: { canonicalAppUserId: CANONICAL_ID, generation },
      });
    });

    it('an eight-second retry deadline releases only the retry control; the warning waits for actual native confirmation', async () => {
      const { renderer, fault } = await failedVaultSignIn();
      fault.mockRestore();
      const held = deferred<void>();
      const write = Keychain.setGenericPassword;
      const writing = jest
        .spyOn(Keychain, 'setGenericPassword')
        .mockImplementation(async (username, password, options) => {
          await held.promise;
          return write(username, password, options);
        });
      try {
        await press(renderer, 'Retry saving sign-in');
        expect(pressable(renderer, 'Retry saving sign-in').props.disabled).toBe(
          true,
        );
        await press(renderer, 'Open another screen');
        await act(async () => {
          await jest.advanceTimersByTimeAsync(8_000);
        });
        await flushGate();
        expect(pressable(renderer, 'Retry saving sign-in').props.disabled).toBe(
          false,
        );
        expect(allText(renderer)).toContain('Save sign-in on this device');
        expect(allText(renderer)).toContain('ANOTHER_ROUTE');
        expect(useAuthStore.getState().error?.code).toBe(
          'auth.storage_unavailable',
        );
        expect(keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
        await press(renderer, 'Retry saving sign-in');
        expect(writing).toHaveBeenCalledTimes(1);
        expect(allText(renderer)).toContain('Save sign-in on this device');
      } finally {
        held.resolve();
        await flushGate();
      }
      expect(useAuthStore.getState().error).toBeNull();
      expect(allText(renderer)).not.toContain('Save sign-in on this device');
      expect(allText(renderer)).toContain('ANOTHER_ROUTE');
    });

    it('an obsolete native A completion and stale A button cannot clear or retry a newer verified B warning', async () => {
      const { renderer, fault } = await failedVaultSignIn();
      fault.mockRestore();
      const heldA = deferred<void>();
      const heldB = deferred<void>();
      const write = Keychain.setGenericPassword;
      const writing = jest
        .spyOn(Keychain, 'setGenericPassword')
        .mockImplementation(async (username, password, options) => {
          await (JSON.parse(password).canonicalAppUserId === CANONICAL_ID
            ? heldA.promise
            : heldB.promise);
          return write(username, password, options);
        });
      const staleRetry = pressable(renderer, 'Retry saving sign-in').props
        .onPress;
      try {
        await press(renderer, 'Retry saving sign-in');
        durableBootstrap(OWNER_B);
        let signingIn!: Promise<void>;
        act(() => {
          signingIn = useAuthStore.getState().signInWithApple();
        });
        await flushGate();
        await act(async () => {
          await jest.advanceTimersByTimeAsync(8_000);
          await signingIn;
        });
        await flushGate();
        const sessionB = useAuthStore.getState().session;
        const apiB = getApiSession();
        const errorB = useAuthStore.getState().error;
        expect(sessionB?.canonicalAppUserId).toBe(OWNER_B);
        expect(errorB?.code).toBe('auth.storage_unavailable');
        expect(allText(renderer)).toContain('Save sign-in on this device');
        await act(async () => {
          staleRetry();
        });
        expect(writing).toHaveBeenCalledTimes(1);
        heldA.resolve();
        await flushGate();
        expect(writing).toHaveBeenCalledTimes(2);
        expect(useAuthStore.getState().error).toBe(errorB);
        expect(useAuthStore.getState().session).toBe(sessionB);
        expect(getApiSession()).toBe(apiB);
        expect(allText(renderer)).toContain('Save sign-in on this device');
        expect(mockAppleSignIn).toHaveBeenCalledTimes(2);
      } finally {
        heldA.resolve();
        heldB.resolve();
        await flushGate();
      }
      expect(useAuthStore.getState().error).toBeNull();
      expect(allText(renderer)).not.toContain('Save sign-in on this device');
      await expect(readPersistedSession()).resolves.toMatchObject({
        status: 'available',
        session: { canonicalAppUserId: OWNER_B },
      });
    });

    it('Got it does not dismiss a still-pending durable notice when its bounded wait resolves; Back remains intentional', async () => {
      requireReturningSignIn();
      const held = deferred<void>();
      mockRestoreWriteGate = held.promise;
      const onBack = jest.fn();
      const renderer = renderScreen(onBack, true);
      try {
        await press(renderer, 'Got it');
        await act(async () => {
          await jest.advanceTimersByTimeAsync(8_000);
        });
        expect(useAuthStore.getState().restoreState).toMatchObject({
          noticePending: true,
        });
        expect(pressables(renderer, 'Got it')).toHaveLength(1);
        await press(renderer, BACK);
        expect(onBack).toHaveBeenCalledTimes(1);
        expect(useAuthStore.getState().restoreState).toMatchObject({
          noticePending: true,
        });
      } finally {
        mockRestoreWriteGate = null;
        held.resolve();
        await flushGate();
      }
      expect(useAuthStore.getState().restoreState).toMatchObject({
        noticePending: false,
      });
      expect(pressables(renderer, 'Got it')).toHaveLength(0);
    });
  });

  it('labels a returning storage error without claiming the provider sign-in failed', () => {
    requireReturningSignIn();
    useAuthStore.setState({
      error: {
        code: 'auth.storage_unavailable',
        message: 'This device could not save your sign-in explanation.',
      },
    });
    const renderer = renderScreen();
    expect(allText(renderer)).toContain('STORAGE UNAVAILABLE');
    expect(allText(renderer)).not.toContain('SIGN-IN FAILED');
    expect(pressables(renderer, 'Got it')).toHaveLength(1);
    expect(mockAppleSignIn).not.toHaveBeenCalled();
    expect(mockGoogleSignin.signIn).not.toHaveBeenCalled();
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
