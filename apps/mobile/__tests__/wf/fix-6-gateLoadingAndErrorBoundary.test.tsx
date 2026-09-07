import React from 'react';
import { Modal, ScrollView, StyleSheet, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { create } from 'zustand';
import type { AuthError, AuthRestoreState } from '../../src/auth/authStore';
import { SignInScreen } from '../../src/screens/SignInScreen';
import { SplashScreen } from '../../src/screens/SplashScreen';
import { WelcomeScreen } from '../../src/screens/WelcomeScreen';
import { OnboardingScreen } from '../../src/screens/OnboardingScreen';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
} from '../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * App.tsx Gate: after the launch splash is gone, every owner change
 * re-hydrates — that window must paint a real loading affordance, a failed
 * canonical hydrate must offer retry instead of re-asking the questionnaire,
 * and a render throw anywhere below the root must land on a recoverable
 * error state rather than a dead app.
 */

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    SafeAreaProvider: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
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
    OnboardingScreen: () => R.createElement(RN.Text, null, 'ONBOARDING'),
  };
});
jest.mock('../../src/screens/WelcomeScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return { WelcomeScreen: () => R.createElement(RN.Text, null, 'WELCOME') };
});
let mockHoldSplash = false;
jest.mock('../../src/screens/SplashScreen', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) => {
      R.useEffect(() => {
        if (props.ready && !mockHoldSplash) props.onFinished();
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

const CANONICAL_OWNER = '55555555-5555-4555-8555-555555555555';

interface MockAppState {
  hydrated: boolean;
  ownerKey: string | null;
  profile: { skillLevel: string } | null;
  hydrateError: string | null;
  awaitingApiSession: boolean;
  preAuthOnboarded: boolean;
  hydrate: () => Promise<void>;
}
const mockHydrateApp = jest.fn<Promise<void>, []>(async () => {});
const mockUseAppStore = create<MockAppState>(() => ({
  hydrated: false,
  ownerKey: null,
  profile: null,
  hydrateError: null,
  awaitingApiSession: false,
  preAuthOnboarded: true,
  hydrate: () => mockHydrateApp(),
}));
jest.mock('../../src/state/appStore', () => ({
  useAppStore: (selector: (s: MockAppState) => unknown) =>
    mockUseAppStore(selector),
}));

interface MockAuthState {
  hydrated: boolean;
  session: {
    provider: 'apple' | 'google' | 'guest';
    canonicalAppUserId?: string;
    localOnly?: boolean;
  } | null;
  restoreState?: AuthRestoreState;
  busy: boolean;
  error: AuthError | null;
  hydrate: () => Promise<void>;
  signOut: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  acknowledgeReturningSession: () => Promise<void>;
  retrySessionPersistence: () => Promise<void>;
  clearError: () => void;
}
const mockHydrateAuth = jest.fn(async () => {});
const mockSignOut = jest.fn(async () => {});
const mockSignInWithApple = jest.fn(async () => {});
const mockSignInWithGoogle = jest.fn(async () => {});
const mockAcknowledgeReturningSession = jest.fn(async () => {});
const mockRetryPersistence = jest.fn(async () => {});
const mockUseAuthStore = create<MockAuthState>(set => ({
  hydrated: true,
  session: { provider: 'apple', canonicalAppUserId: CANONICAL_OWNER },
  busy: false,
  error: null,
  hydrate: () => mockHydrateAuth(),
  signOut: () => mockSignOut(),
  signInWithApple: () => mockSignInWithApple(),
  signInWithGoogle: () => mockSignInWithGoogle(),
  acknowledgeReturningSession: () => mockAcknowledgeReturningSession(),
  retrySessionPersistence: mockRetryPersistence,
  clearError: () => set({ error: null }),
}));
jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: MockAuthState) => unknown = s => s) =>
      mockUseAuthStore(selector),
    { getState: () => mockUseAuthStore.getState() },
  ),
}));

import App, { RootErrorBoundary } from '../../App';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import { Button } from '../../src/design/components';
import {
  captureBoundaryError,
  resetDiagnosticsScope,
} from '../../src/diagnostics/sentry';

function tryAgain(renderer: TestRenderer.ReactTestRenderer) {
  const buttons = renderer.root
    .findAllByType(Button)
    .filter(node => node.props.label === 'Try again');
  expect(buttons).toHaveLength(1);
  return buttons[0]!;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join('\n');
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

function renderApp() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<App />);
  });
  mounted.push(renderer);
  return renderer;
}

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount());
  }
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

beforeEach(() => {
  jest.mocked(captureBoundaryError).mockClear();
  jest.mocked(resetDiagnosticsScope).mockClear();
  mockHoldSplash = false;
  mockHydrateApp.mockClear();
  mockHydrateAuth.mockReset();
  mockSignOut.mockReset();
  mockRetryPersistence.mockReset();
  mockSignInWithApple.mockReset();
  mockSignInWithGoogle.mockReset();
  mockAcknowledgeReturningSession.mockReset();
  mockAcknowledgeReturningSession.mockImplementation(async () => {
    const restoreState = mockUseAuthStore.getState().restoreState;
    if (restoreState?.status === 'reauth_required') {
      mockUseAuthStore.setState({
        restoreState: { ...restoreState, noticePending: false },
      });
    }
  });
  clearApiSession();
  setActiveDataOwner(CANONICAL_OWNER);
  mockUseAuthStore.setState({
    hydrated: true,
    session: { provider: 'apple', canonicalAppUserId: CANONICAL_OWNER },
    restoreState: undefined,
    busy: false,
    error: null,
    retrySessionPersistence: mockRetryPersistence,
  });
  mockUseAppStore.setState({
    hydrated: true,
    ownerKey: CANONICAL_OWNER,
    profile: { skillLevel: '3.5' },
    hydrateError: null,
    awaitingApiSession: false,
  });
});

describe('Gate loading affordance after the splash', () => {
  it('clears diagnostics on owner transitions without passing account metadata', () => {
    renderApp();
    expect(resetDiagnosticsScope).toHaveBeenCalledTimes(1);
    act(() => mockUseAppStore.setState({ profile: { skillLevel: '4.0' } }));
    expect(resetDiagnosticsScope).toHaveBeenCalledTimes(1);
    act(() =>
      mockUseAuthStore.setState({
        session: {
          provider: 'apple',
          canonicalAppUserId: '66666666-6666-4666-8666-666666666666',
        },
      }),
    );
    expect(resetDiagnosticsScope).toHaveBeenCalledTimes(2);
    act(() => mockUseAuthStore.setState({ session: null }));
    expect(resetDiagnosticsScope).toHaveBeenCalledTimes(3);
    expect(
      jest
        .mocked(resetDiagnosticsScope)
        .mock.calls.every(args => args.length === 0),
    ).toBe(true);
  });

  it('paints a loading state (never a bare surface) while a signed-in owner re-hydrates', () => {
    const renderer = renderApp();
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');

    act(() => {
      mockUseAppStore.setState({
        hydrated: false,
        profile: null,
        ownerKey: CANONICAL_OWNER,
      });
    });
    const text = allText(renderer);
    expect(text).not.toContain('ROOT_NAVIGATOR');
    expect(text).toContain('Loading your account');
    expect(text).toContain('Keep Pickle Sensei open.');

    act(() => {
      mockUseAppStore.setState({
        hydrated: true,
        profile: { skillLevel: '3.5' },
      });
    });
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
  });

  it('paints a loading state while the signed-out owner re-hydrates after sign-out', () => {
    const renderer = renderApp();
    act(() => {
      mockUseAuthStore.setState({ session: null });
      mockUseAppStore.setState({
        hydrated: false,
        profile: null,
        ownerKey: 'signed-out',
      });
    });
    expect(allText(renderer)).toContain('Getting things ready');

    act(() => {
      mockUseAppStore.setState({ hydrated: true });
    });
    expect(allText(renderer)).toContain('WELCOME');
  });
});

describe('Gate hydrate failure', () => {
  it('never replaces a missing restored profile with onboarding while waiting for the first bearer', () => {
    mockUseAppStore.setState({ profile: null, awaitingApiSession: true });
    const renderer = renderApp();

    expect(allText(renderer)).not.toContain('ONBOARDING');
    expect(allText(renderer)).toContain('Restoring your account');
    expect(
      renderer.root.findAllByType(Button).map(node => node.props.label),
    ).toEqual(expect.arrayContaining(['Try again', 'Sign out']));
    const calls = mockHydrateApp.mock.calls.length;
    act(() => tryAgain(renderer).props.onPress());
    expect(mockHydrateApp).toHaveBeenCalledTimes(calls + 1);
  });

  it('offers sign out as an escape from a persistent profile error', () => {
    mockUseAppStore.setState({
      profile: null,
      hydrateError: 'Could not reach your account.',
    });
    const renderer = renderApp();
    const signOut = renderer.root
      .findAllByType(Button)
      .find(node => node.props.label === 'Sign out');

    expect(signOut).toBeDefined();
    act(() => signOut!.props.onPress());
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).not.toContain('ONBOARDING');
  });

  it('keeps the cached account accessible while the first bearer is unavailable', () => {
    mockUseAppStore.setState({ awaitingApiSession: true });
    const renderer = renderApp();
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
  });

  it('shows a retry state instead of the account questionnaire, and retry re-runs hydrate', () => {
    const renderer = renderApp();
    act(() => {
      mockUseAppStore.setState({
        hydrated: true,
        profile: null,
        hydrateError: 'Could not reach your account.',
      });
    });
    const text = allText(renderer);
    expect(text).not.toContain('ONBOARDING');
    expect(text).toContain('Your coaching profile couldn’t load');
    expect(text).toContain('Could not reach your account.');

    const callsBeforeRetry = mockHydrateApp.mock.calls.length;
    act(() => {
      tryAgain(renderer).props.onPress();
    });
    expect(mockHydrateApp).toHaveBeenCalledTimes(callsBeforeRetry + 1);
  });

  it('still offers the in-account questionnaire when there is no profile and no error', () => {
    const renderer = renderApp();
    act(() => {
      mockUseAppStore.setState({ hydrated: true, profile: null });
    });
    expect(allText(renderer)).toContain('ONBOARDING');
  });
});

function signedOut(restoreState: AuthRestoreState | undefined) {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockUseAuthStore.setState({ session: null, restoreState });
  mockUseAppStore.setState({
    hydrated: true,
    ownerKey: SIGNED_OUT_DATA_OWNER,
    profile: null,
  });
}

function returningState(
  reason: Extract<
    AuthRestoreState,
    { status: 'reauth_required' }
  >['reason'] = 'legacy_credentials_missing',
  noticePending = true,
): AuthRestoreState {
  return {
    status: 'reauth_required',
    reason,
    provider: 'apple',
    noticePending,
  };
}

async function pressControl(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const control = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      node.props.accessibilityState !== undefined &&
      typeof node.props.onPress === 'function',
  )[0];
  expect(control).toBeDefined();
  await act(async () => control!.props.onPress());
}

const STORAGE_ERROR: AuthError = {
  code: 'auth.storage_unavailable',
  message:
    'This device could not save the sign-out. Try signing out again before closing the app.',
};

const OWNER_B = '66666666-6666-4666-8666-666666666666';

function signInAsB() {
  setActiveDataOwner(OWNER_B);
  establishApiSession({
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'test-access-b',
    canonicalAppUserId: OWNER_B,
    provider: 'apple',
  });
  mockUseAuthStore.setState({
    session: { provider: 'apple', canonicalAppUserId: OWNER_B },
    restoreState: { status: 'restored', connectivity: 'online' },
    error: null,
  });
}

describe('Gate returning authentication', () => {
  it.each(['online', 'offline'] as const)(
    'keeps a valid %s restored session in the normal app without prompting sign-in',
    connectivity => {
      mockUseAuthStore.setState({
        restoreState: { status: 'restored', connectivity },
      });
      const renderer = renderApp();
      expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
      expect(renderer.root.findAllByType(SignInScreen)).toHaveLength(0);
      expect(mockSignInWithApple).not.toHaveBeenCalled();
      expect(mockSignInWithGoogle).not.toHaveBeenCalled();
      expect(mockAcknowledgeReturningSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    'legacy_credentials_missing',
    'credentials_missing',
    'revoked',
  ] as const)(
    '%s opens returning sign-in, not Welcome or a new questionnaire',
    reason => {
      signedOut(returningState(reason));
      const renderer = renderApp();
      expect(allText(renderer)).toContain('Sign in again.');
      expect(allText(renderer)).toContain('check for a saved coaching profile');
      expect(allText(renderer)).not.toMatch(
        /WELCOME|ONBOARDING|ROOT_NAVIGATOR/,
      );
      expect(
        renderer.root.findAllByProps({ testID: 'returning-session-notice' })
          .length,
      ).toBeGreaterThan(0);
      expect(mockSignInWithApple).not.toHaveBeenCalled();
      expect(mockSignInWithGoogle).not.toHaveBeenCalled();
      expect(mockAcknowledgeReturningSession).not.toHaveBeenCalled();
    },
  );

  it('never consumes or displays the contextual notice behind the splash', async () => {
    mockHoldSplash = true;
    signedOut(returningState());
    const renderer = renderApp();
    expect(renderer.root.findByType(SplashScreen).props.ready).toBe(true);
    expect(renderer.root.findAllByType(SignInScreen)).toHaveLength(1);
    expect(
      renderer.root.findAllByProps({ testID: 'returning-session-notice' }),
    ).toHaveLength(0);
    expect(mockAcknowledgeReturningSession).not.toHaveBeenCalled();
    await pressControl(renderer, 'Back');
    expect(mockAcknowledgeReturningSession).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType(SignInScreen)).toHaveLength(1);
    act(() => renderer.root.findByType(SplashScreen).props.onFinished());
    expect(
      renderer.root.findAllByProps({ testID: 'returning-session-notice' })
        .length,
    ).toBeGreaterThan(0);
    expect(mockAcknowledgeReturningSession).not.toHaveBeenCalled();
  });

  it('acknowledges only an explicit Got it, then Back reaches Welcome without a reroute loop', async () => {
    signedOut(returningState());
    const renderer = renderApp();
    await pressControl(renderer, 'Got it');
    expect(mockAcknowledgeReturningSession).toHaveBeenCalledTimes(1);
    expect(
      renderer.root.findAllByProps({ testID: 'returning-session-notice' }),
    ).toHaveLength(0);
    expect(renderer.root.findAllByType(SignInScreen)).toHaveLength(1);
    await pressControl(renderer, 'Back');
    expect(allText(renderer)).toContain('WELCOME');
    act(() =>
      mockUseAuthStore.setState({
        restoreState: returningState('legacy_credentials_missing', false),
      }),
    );
    expect(allText(renderer)).toContain('WELCOME');
    act(() => renderer.root.findByType(WelcomeScreen).props.onGetStarted());
    expect(renderer.root.findByType(OnboardingScreen).props.mode).toBe(
      'preauth',
    );
    expect(mockAcknowledgeReturningSession).toHaveBeenCalledTimes(1);
  });

  it('Back still reaches Welcome intentionally when durable acknowledgement remains pending', async () => {
    signedOut(returningState());
    mockAcknowledgeReturningSession.mockImplementation(async () => {});
    const renderer = renderApp();
    await pressControl(renderer, 'Got it');
    expect(mockUseAuthStore.getState().restoreState).toMatchObject({
      noticePending: true,
    });
    await pressControl(renderer, 'Back');
    expect(allText(renderer)).toContain('WELCOME');
    expect(mockUseAuthStore.getState().restoreState).toMatchObject({
      noticePending: true,
    });
  });

  it('Back acknowledges a pending notice; a later launch still starts at sign-in without repeating it', async () => {
    signedOut(returningState());
    const renderer = renderApp();
    await pressControl(renderer, 'Back');
    expect(mockAcknowledgeReturningSession).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('WELCOME');
    act(() => renderer.unmount());
    const relaunched = renderApp();
    expect(allText(relaunched)).toContain('Sign in again.');
    expect(
      relaunched.root.findAllByProps({ testID: 'returning-session-notice' }),
    ).toHaveLength(0);
    expect(mockAcknowledgeReturningSession).toHaveBeenCalledTimes(1);
  });

  it('a new revoked session routes to sign-in even after an earlier returning Back choice', async () => {
    signedOut(returningState('revoked'));
    const renderer = renderApp();
    await pressControl(renderer, 'Back');
    expect(allText(renderer)).toContain('WELCOME');
    act(() => {
      signInAsB();
      mockUseAppStore.setState({
        ownerKey: OWNER_B,
        profile: { skillLevel: '4.0' },
      });
    });
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    act(() => signedOut(returningState('revoked')));
    expect(allText(renderer)).toContain('Sign in again.');
    expect(allText(renderer)).not.toContain('WELCOME');
  });

  it('does not authenticate from a cached profile, and waits for the verified owner before choosing account onboarding', () => {
    signedOut(returningState());
    mockUseAppStore.setState({ profile: { skillLevel: '3.5' } });
    const renderer = renderApp();
    expect(allText(renderer)).toContain('Sign in again.');
    expect(allText(renderer)).not.toContain('ROOT_NAVIGATOR');
    act(() => signInAsB());
    expect(allText(renderer)).toContain('Loading your account');
    expect(allText(renderer)).not.toMatch(/ROOT_NAVIGATOR|ONBOARDING/);
    act(() => mockUseAppStore.setState({ ownerKey: OWNER_B, profile: null }));
    expect(allText(renderer)).toContain('ONBOARDING');
    act(() => mockUseAppStore.setState({ profile: { skillLevel: '4.0' } }));
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
  });

  it('keeps real restoring states gated even if a legacy hydrated flag is true', () => {
    signedOut({ status: 'restoring' });
    const renderer = renderApp();
    expect(allText(renderer)).toContain('Getting things ready');
    expect(allText(renderer)).not.toMatch(/WELCOME|ONBOARDING|ROOT_NAVIGATOR/);
    expect(renderer.root.findAllByType(SignInScreen)).toHaveLength(0);
    expect(renderer.root.findByType(SplashScreen).props.ready).toBe(false);
  });

  it.each(['new_install', 'user_sign_out', 'account_deleted'] as const)(
    '%s starts at Welcome and still requires the pre-auth questionnaire from Start',
    reason => {
      signedOut({ status: 'signed_out', reason });
      const renderer = renderApp();
      expect(allText(renderer)).toContain('WELCOME');
      act(() => renderer.root.findByType(WelcomeScreen).props.onGetStarted());
      const onboarding = renderer.root.findByType(OnboardingScreen);
      expect(onboarding.props.mode).toBe('preauth');
      act(() => onboarding.props.onBack());
      expect(allText(renderer)).toContain('WELCOME');
      act(() => renderer.root.findByType(WelcomeScreen).props.onGetStarted());
      act(() => renderer.root.findByType(OnboardingScreen).props.onFinished());
      expect(renderer.root.findAllByType(SignInScreen)).toHaveLength(1);
      expect(allText(renderer)).not.toContain('Sign in again.');
    },
  );
});

describe('Gate auth recovery', () => {
  it.each([
    ['vault_unavailable', 'secure storage'],
    ['vault_invalid', 'saved sign-in'],
    ['vault_unsupported', 'Update Pickle Sensei'],
    ['local_storage_unavailable', 'saved app state'],
    ['legacy_restore_unavailable', 'previous sign-in'],
  ] as const)(
    '%s offers a safe retry independently of app hydration',
    async (reason, detail) => {
      signedOut({ status: 'unavailable', reason });
      mockUseAppStore.setState({ hydrated: false, ownerKey: CANONICAL_OWNER });
      const renderer = renderApp();
      expect(allText(renderer)).toContain(detail);
      expect(allText(renderer)).not.toMatch(
        /WELCOME|ONBOARDING|ROOT_NAVIGATOR/,
      );
      expect(renderer.root.findAllByType(SignInScreen)).toHaveLength(0);
      expect(renderer.root.findAllByType(SplashScreen)).toHaveLength(0);
      expect(
        renderer.root.findAllByType(Button).map(node => node.props.label),
      ).toEqual(['Try again']);
      expect(mockHydrateAuth).toHaveBeenCalledTimes(1);
      await act(async () => tryAgain(renderer).props.onPress());
      expect(mockHydrateAuth).toHaveBeenCalledTimes(2);
      expect(mockSignOut).not.toHaveBeenCalled();
      expect(mockSignInWithApple).not.toHaveBeenCalled();
      expect(mockSignInWithGoogle).not.toHaveBeenCalled();
      expect(mockAcknowledgeReturningSession).not.toHaveBeenCalled();
    },
  );

  it('an unsupported vault stays non-destructive even with a retained storage error', async () => {
    signedOut({ status: 'unavailable', reason: 'vault_unsupported' });
    mockUseAuthStore.setState({ error: STORAGE_ERROR });
    const renderer = renderApp();
    expect(allText(renderer)).toContain('Update Pickle Sensei');
    expect(allText(renderer)).not.toContain('Finish signing out');
    await act(async () => tryAgain(renderer).props.onPress());
    expect(mockHydrateAuth).toHaveBeenCalledTimes(2);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('a returning-notice storage error is not treated as permission to clear credentials', async () => {
    signedOut(returningState());
    mockUseAuthStore.setState({
      error: {
        code: 'auth.storage_unavailable',
        message: 'This device could not save your sign-in explanation.',
      },
    });
    const renderer = renderApp();
    expect(allText(renderer)).toContain('Sign in again.');
    expect(allText(renderer)).toContain(
      'This device could not save your sign-in explanation.',
    );
    await pressControl(renderer, 'Got it');
    expect(mockAcknowledgeReturningSession).toHaveBeenCalledTimes(1);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('retries a failed restore through loading to returning sign-in, never cold Welcome', async () => {
    signedOut({ status: 'unavailable', reason: 'vault_unavailable' });
    const renderer = renderApp();
    mockHydrateAuth.mockImplementation(async () => {
      mockUseAuthStore.setState({
        hydrated: false,
        restoreState: { status: 'restoring' },
      });
    });
    await act(async () => tryAgain(renderer).props.onPress());
    expect(allText(renderer)).toContain('Getting things ready');
    expect(allText(renderer)).not.toContain('WELCOME');
    act(() =>
      mockUseAuthStore.setState({
        hydrated: true,
        restoreState: returningState('credentials_missing'),
      }),
    );
    expect(allText(renderer)).toContain('Sign in again.');
    expect(allText(renderer)).not.toContain('WELCOME');
  });

  it('a stale restore retry cannot replace a newly signed-in B session', async () => {
    signedOut({ status: 'unavailable', reason: 'vault_unavailable' });
    const renderer = renderApp();
    const retry = tryAgain(renderer).props.onPress;
    act(() => signInAsB());
    await act(async () => retry());
    expect(mockHydrateAuth).toHaveBeenCalledTimes(1);
    expect(mockUseAuthStore.getState().session?.canonicalAppUserId).toBe(
      OWNER_B,
    );
  });

  it('surfaces a failed sign-out above Welcome and retries clearing rather than restoring the saved credential', async () => {
    mockUseAppStore.setState({
      profile: null,
      hydrateError: 'Profile unavailable.',
    });
    mockSignOut.mockImplementationOnce(async () => {
      signedOut({ status: 'signed_out', reason: 'user_sign_out' });
      mockUseAuthStore.setState({ error: STORAGE_ERROR });
    });
    const renderer = renderApp();
    await pressControl(renderer, 'Sign out');
    expect(allText(renderer)).toContain('Finish signing out');
    expect(allText(renderer)).toContain(STORAGE_ERROR.message);
    expect(allText(renderer)).not.toContain('WELCOME');
    mockSignOut.mockImplementationOnce(async () => {
      mockUseAuthStore.setState({ error: null });
    });
    await act(async () => tryAgain(renderer).props.onPress());
    expect(mockSignOut).toHaveBeenCalledTimes(2);
    expect(mockHydrateAuth).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('WELCOME');
    expect(allText(renderer)).not.toContain(STORAGE_ERROR.message);
  });

  it('keeps sign-out failures visible during app hydration and refuses a duplicate retry while busy', async () => {
    signedOut({ status: 'signed_out', reason: 'user_sign_out' });
    mockUseAuthStore.setState({ error: STORAGE_ERROR });
    mockUseAppStore.setState({ hydrated: false });
    const renderer = renderApp();
    expect(allText(renderer)).toContain(STORAGE_ERROR.message);
    expect(renderer.root.findAllByType(SplashScreen)).toHaveLength(0);
    const retry = tryAgain(renderer).props.onPress;
    act(() => mockUseAuthStore.setState({ busy: true }));
    await act(async () => retry());
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain(STORAGE_ERROR.message);
  });

  it('stale sign-out retry cannot clear B or a later signed-out context', async () => {
    signedOut({ status: 'signed_out', reason: 'user_sign_out' });
    mockUseAuthStore.setState({ error: STORAGE_ERROR });
    const renderer = renderApp();
    const retry = tryAgain(renderer).props.onPress;
    act(() => signInAsB());
    await act(async () => retry());
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockUseAuthStore.getState().session?.canonicalAppUserId).toBe(
      OWNER_B,
    );
    act(() => {
      signedOut({ status: 'signed_out', reason: 'user_sign_out' });
      mockUseAuthStore.setState({ error: { ...STORAGE_ERROR } });
    });
    await act(async () => retry());
    expect(mockSignOut).not.toHaveBeenCalled();
    await act(async () => tryAgain(renderer).props.onPress());
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('will not clear while a new API session is installed but the UI still appears signed out', async () => {
    signedOut({ status: 'signed_out', reason: 'user_sign_out' });
    mockUseAuthStore.setState({ error: STORAGE_ERROR });
    const renderer = renderApp();
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'test-access-b',
      canonicalAppUserId: OWNER_B,
      provider: 'apple',
    });
    await act(async () => tryAgain(renderer).props.onPress());
    expect(mockSignOut).not.toHaveBeenCalled();
    clearApiSession();
    setActiveDataOwner(OWNER_B);
    await act(async () => tryAgain(renderer).props.onPress());
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});

function showLiveStorageWarning(owner = CANONICAL_OWNER) {
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'test-access',
    refreshToken: 'test-refresh',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  mockUseAuthStore.setState({
    session: { provider: 'apple', canonicalAppUserId: owner, localOnly: false },
    restoreState: { status: 'restored', connectivity: 'online' },
    error: {
      code: 'auth.storage_unavailable',
      message:
        'This device could not save your sign-in. Try again before closing it.',
    },
  });
  mockUseAppStore.setState({ ownerKey: owner, profile: { skillLevel: '3.5' } });
}

function persistenceRetry(renderer: TestRenderer.ReactTestRenderer) {
  const nodes = renderer.root.findAll(
    node =>
      node.props.testID === 'session-persistence-retry' &&
      typeof node.type === 'function' &&
      node.type.name === 'Pressable',
  );
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

function pendingRetry() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Gate live session persistence warning', () => {
  it('keeps Root mounted beside a compact non-modal, scalable warning with a 44pt retry', () => {
    showLiveStorageWarning();
    const renderer = renderApp();
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    expect(allText(renderer)).toContain('Save sign-in on this device');
    expect(allText(renderer)).not.toContain('Finish signing out');
    expect(renderer.root.findAllByType(SignInScreen)).toHaveLength(0);
    expect(
      renderer.root.findAllByType(Modal).filter(node => node.props.visible),
    ).toHaveLength(0);
    const warning = renderer.root.findAllByProps({
      testID: 'session-persistence-warning',
    })[0]!;
    expect(warning.findAllByType(Modal)).toHaveLength(0);
    const scroll = renderer.root.findByType(ScrollView);
    expect(scroll.props.scrollEnabled).not.toBe(false);
    expect(StyleSheet.flatten(scroll.props.style).maxHeight).toBeGreaterThan(
      44,
    );
    expect(
      StyleSheet.flatten(scroll.props.contentContainerStyle).flexWrap,
    ).toBe('wrap');
    expect(scroll.findAllByProps({ children: 'ROOT_NAVIGATOR' })).toHaveLength(
      0,
    );
    for (const text of scroll.findAllByType(Text)) {
      expect(text.props.allowFontScaling).not.toBe(false);
      expect(text.props.maxFontSizeMultiplier).not.toBe(1);
      expect(text.props.numberOfLines).toBeUndefined();
    }
    const retry = persistenceRetry(renderer);
    const style =
      typeof retry.props.style === 'function'
        ? retry.props.style({ pressed: false })
        : retry.props.style;
    expect(StyleSheet.flatten(style).minHeight).toBeGreaterThanOrEqual(44);
    expect(retry.props.accessibilityLabel).toBe('Retry saving sign-in');
    expect(mockRetryPersistence).not.toHaveBeenCalled();
    expect(mockSignInWithApple).not.toHaveBeenCalled();
    expect(mockSignInWithGoogle).not.toHaveBeenCalled();
  });

  it('waits for the splash to finish without consuming or retrying the warning', () => {
    mockHoldSplash = true;
    showLiveStorageWarning();
    const renderer = renderApp();
    expect(allText(renderer)).not.toContain('Save sign-in on this device');
    act(() => renderer.root.findByType(SplashScreen).props.onFinished());
    expect(allText(renderer)).toContain('Save sign-in on this device');
    expect(mockRetryPersistence).not.toHaveBeenCalled();
  });

  it('disables only its own retry while waiting, never hides the warning on resolution, and never hydrates', async () => {
    showLiveStorageWarning();
    const pending = pendingRetry();
    mockRetryPersistence.mockReturnValue(pending.promise);
    const renderer = renderApp();
    const error = mockUseAuthStore.getState().error;
    const authHydrates = mockHydrateAuth.mock.calls.length;
    const appHydrates = mockHydrateApp.mock.calls.length;
    const retry = persistenceRetry(renderer).props.onPress;
    act(() => {
      retry();
      retry();
    });
    expect(mockRetryPersistence).toHaveBeenCalledTimes(1);
    expect(persistenceRetry(renderer).props.disabled).toBe(true);
    expect(mockUseAuthStore.getState().busy).toBe(false);
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    const content = renderer.root.findAllByProps({
      testID: 'gate-content',
    })[0]!;
    expect(content.props.pointerEvents).not.toBe('none');
    expect(content.props.accessibilityElementsHidden).not.toBe(true);
    await act(async () => pending.resolve());
    expect(allText(renderer)).toContain('Save sign-in on this device');
    expect(persistenceRetry(renderer).props.disabled).toBe(false);
    expect(mockUseAuthStore.getState().error).toBe(error);
    expect(mockHydrateAuth).toHaveBeenCalledTimes(authHydrates);
    expect(mockHydrateApp).toHaveBeenCalledTimes(appHydrates);
    expect(mockSignOut).not.toHaveBeenCalled();
    act(() => mockUseAuthStore.setState({ error: null }));
    expect(allText(renderer)).not.toContain('Save sign-in on this device');
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
  });

  it('retains the warning and retry after an unexpected action rejection', async () => {
    showLiveStorageWarning();
    mockRetryPersistence.mockRejectedValueOnce(
      new Error('Temporary storage failure'),
    );
    const renderer = renderApp();
    await act(async () => persistenceRetry(renderer).props.onPress());
    expect(allText(renderer)).toContain('Save sign-in on this device');
    expect(persistenceRetry(renderer).props.disabled).toBe(false);
    expect(mockUseAuthStore.getState().error?.code).toBe(
      'auth.storage_unavailable',
    );
  });

  it.each(['session', 'api', 'owner-generation', 'error', 'action'] as const)(
    'a stale handler cannot retry after the %s identity changes',
    async changed => {
      showLiveStorageWarning();
      const renderer = renderApp();
      const retry = persistenceRetry(renderer).props.onPress;
      const replacement = jest.fn(async () => {});
      act(() => {
        const state = mockUseAuthStore.getState();
        if (changed === 'session') showLiveStorageWarning(OWNER_B);
        if (changed === 'api') establishApiSession({ ...getApiSession()! });
        if (changed === 'owner-generation') {
          setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
          setActiveDataOwner(CANONICAL_OWNER);
        }
        if (changed === 'error')
          mockUseAuthStore.setState({ error: { ...state.error! } });
        if (changed === 'action')
          mockUseAuthStore.setState({ retrySessionPersistence: replacement });
      });
      await act(async () => retry());
      expect(mockRetryPersistence).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();
    },
  );

  it('an old completion cannot clear B’s warning or its local in-flight retry', async () => {
    showLiveStorageWarning();
    const pendingA = pendingRetry();
    const pendingB = pendingRetry();
    mockRetryPersistence
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise);
    const renderer = renderApp();
    act(() => {
      persistenceRetry(renderer).props.onPress();
    });
    act(() => showLiveStorageWarning(OWNER_B));
    expect(persistenceRetry(renderer).props.disabled).toBe(false);
    act(() => {
      persistenceRetry(renderer).props.onPress();
    });
    const errorB = mockUseAuthStore.getState().error;
    await act(async () => pendingA.resolve());
    expect(persistenceRetry(renderer).props.disabled).toBe(true);
    expect(mockUseAuthStore.getState().error).toBe(errorB);
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    await act(async () => pendingB.resolve());
    expect(persistenceRetry(renderer).props.disabled).toBe(false);
    expect(mockUseAuthStore.getState().error).toBe(errorB);
  });

  it.each(['guest', 'local-only', 'no-api', 'unsupported', 'reauth'] as const)(
    'does not offer a live persistence retry for %s',
    kind => {
      showLiveStorageWarning();
      const session = mockUseAuthStore.getState().session!;
      if (kind === 'guest')
        mockUseAuthStore.setState({
          session: { ...session, provider: 'guest' },
          restoreState: { status: 'guest' },
        });
      if (kind === 'local-only')
        mockUseAuthStore.setState({ session: { ...session, localOnly: true } });
      if (kind === 'no-api') clearApiSession();
      if (kind === 'unsupported')
        signedOut({ status: 'unavailable', reason: 'vault_unsupported' });
      if (kind === 'reauth') signedOut(returningState());
      const renderer = renderApp();
      expect(allText(renderer)).not.toContain('Save sign-in on this device');
      expect(mockRetryPersistence).not.toHaveBeenCalled();
    },
  );
});

describe('RootErrorBoundary', () => {
  let explode = true;
  function Bomb() {
    if (explode) throw new Error('render exploded');
    return <Text>ALIVE</Text>;
  }

  it('catches a render throw, records a non-fatal crash, and recovers on retry', () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    stabilitySlo.reset();
    explode = true;
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <RootErrorBoundary>
          <Bomb />
        </RootErrorBoundary>,
      );
    });
    const text = allText(renderer);
    expect(text).toContain('Something went wrong');
    expect(text).toContain('Try again');

    const crashes = stabilitySlo
      .events()
      .filter(event => event.kind === 'crash');
    expect(crashes).toHaveLength(1);
    expect(captureBoundaryError).toHaveBeenCalledTimes(1);
    expect(captureBoundaryError).toHaveBeenCalledWith(expect.any(Error));
    expect(crashes[0]).toMatchObject({ kind: 'crash', fatal: false });
    expect((crashes[0] as { fingerprint: string }).fingerprint).toMatch(
      /^[0-9a-f]{8}$/,
    );

    explode = false;
    act(() => {
      tryAgain(renderer).props.onPress();
    });
    expect(allText(renderer)).toContain('ALIVE');
    consoleError.mockRestore();
  });

  it('wraps the Gate so a throwing screen degrades to the error state', () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const renderer = renderApp();
    const rootNavigator = jest.requireMock<{
      RootNavigator: () => React.ReactElement;
    }>('../../src/navigation/RootNavigator');
    const original = rootNavigator.RootNavigator;
    rootNavigator.RootNavigator = () => {
      throw new Error('screen exploded');
    };
    try {
      act(() => {
        mockUseAppStore.setState({ profile: { skillLevel: '4.0' } });
      });
      expect(allText(renderer)).toContain('Something went wrong');
    } finally {
      rootNavigator.RootNavigator = original;
      consoleError.mockRestore();
    }
  });
});
