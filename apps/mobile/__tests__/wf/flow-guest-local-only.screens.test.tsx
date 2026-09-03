/**
 * Guest / local-only flow — the screens, driven through their buttons.
 *
 * Every control a guest can reach that needs a canonical account must route
 * to `ConnectAccount` (never to a paywall the guest cannot buy from, never to
 * a request that would 401): Settings → "Connect account" / "Pickle Sensei
 * Pro", the COACH menu capture actions, and the Analyze route gate (see the
 * navigator suite). Manage account / deletion never render for a guest. Sign
 * out from a guest confirms first, can be cancelled three ways, and on
 * confirm really signs the guest out. The Connect-account screen (SignIn)
 * disables its providers while busy, hides cancellations, and surfaces every
 * other failure with dismissible copy — nothing spins forever.
 */
import React from 'react';
import { Modal, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import type { LocalDb } from '../../src/data/db';

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

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
  };
});

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
  // SettingsScreen re-reads server access on every focus (synced sessions
  // only); under the test renderer "focus" is simply mount.
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => callback(), [callback]);
  },
}));

jest.mock('react-native-reanimated', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const AnimatedView = (props: Record<string, unknown>) =>
    ReactLib.createElement(View, props);
  return {
    __esModule: true,
    default: {
      View: AnimatedView,
      createAnimatedComponent:
        (Component: React.ComponentType<Record<string, unknown>>) =>
        (props: Record<string, unknown>) =>
          ReactLib.createElement(Component, props),
    },
    Easing: { out: (fn: unknown) => fn, cubic: () => 0 },
    interpolate: () => 0,
    useAnimatedStyle: (updater: () => object) => updater(),
    useSharedValue: (init: unknown) => ({ value: init }),
    withTiming: (toValue: unknown) => toValue,
  };
});
jest.mock('react-native-linear-gradient', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

// Settings reads the scoring stack version for its About card only.
jest.mock('../../src/vision/providers', () => ({
  scoringStackStatus: () => ({
    installed: true,
    version: 'test-stack',
    requirement: 'recorded_pose_sequence',
  }),
}));
jest.mock('../../src/review/appStoreReview', () => ({
  rateAppFromSettings: jest.fn(async () => undefined),
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
    legalTermsUrl: 'https://api.example.test/terms',
    legalPrivacyUrl: 'https://api.example.test/privacy',
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

const mockRequestAccountDeletion = jest.fn<
  Promise<{ challenge: string; expiresAt: string }>,
  unknown[]
>();
const mockConfirmAccountDeletion = jest.fn<Promise<void>, unknown[]>();
jest.mock('../../src/account/deletion', () => {
  // Only the network calls are stubbed; the survey vocabulary/caps the
  // screen renders from are the real ones.
  const actual = jest.requireActual<
    typeof import('../../src/account/deletion')
  >('../../src/account/deletion');
  return {
    ...actual,
    requestAccountDeletion: (...args: unknown[]) =>
      mockRequestAccountDeletion(...args),
    confirmAccountDeletion: (...args: unknown[]) =>
      mockConfirmAccountDeletion(...args),
  };
});

import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { SignInScreen } from '../../src/screens/SignInScreen';
import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { useAccessStore } from '../../src/state/accessStore';
import { useConsentStore } from '../../src/state/consentStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const LOCAL_MODE_KEY = 'auth.local-mode';
const GUEST_FLAG = JSON.stringify({ version: 1, mode: 'guest' });

const guestSession: AuthSession = {
  provider: 'guest',
  subject: 'local-only',
  canonicalAppUserId: null,
  localOnly: true,
  displayName: null,
  email: null,
};

const syncedSession: AuthSession = {
  provider: 'google',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

function asGuest() {
  mockKv.set(LOCAL_MODE_KEY, GUEST_FLAG);
  setActiveDataOwner(GUEST_DATA_OWNER);
  useAuthStore.setState({
    hydrated: true,
    session: guestSession,
    busy: false,
    error: null,
  });
}

function asSynced() {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: true,
    session: syncedSession,
    busy: false,
    error: null,
  });
}

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
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

// The innermost labelled node with an onPress is the react-native Pressable
// instance — the one carrying the final accessibilityRole / accessibilityState
// / disabled props a screen reader sees — not a wrapping composite.
function innermostPressables(
  root: TestRenderer.ReactTestInstance,
  label: string,
) {
  const matches = root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  return matches.filter(
    match =>
      !matches.some(
        other => other !== match && match.findAll(n => n === other).length > 0,
      ),
  );
}

function pressables(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return innermostPressables(renderer.root, label);
}

function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const nodes = pressables(renderer, label);
  if (nodes.length === 0) throw new Error(`No pressable labeled ${label}`);
  return nodes[0]!;
}

async function press(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const node = pressable(renderer, label);
  await act(async () => {
    node.props.onPress();
  });
}

function visibleModal(renderer: TestRenderer.ReactTestRenderer): boolean {
  return renderer.root
    .findAllByType(Modal)
    .some(modal => modal.props.visible === true);
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  clearApiSession();
  useAccessStore.getState().reset();
  useConsentStore.setState({
    availability: 'signed_out',
    modelTrainingActive: false,
    busy: false,
    error: null,
  });
  useAppStore.setState({
    hydrated: true,
    ownerKey: GUEST_DATA_OWNER,
    profile: {
      firstName: 'Dana',
      gender: 'female',
      skillLevel: '3.5',
      handedness: 'right',
      goal: 'drops',
      biggestProblem: 'control',
      focusCheckpoint: 'paddle_set',
    },
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
    lastShotType: 'forehand_drive',
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signIn.mockResolvedValue({ type: 'cancelled', data: null });
  mockGoogleSignin.signOut.mockResolvedValue(null);
  globalThis.fetch = jest
    .fn()
    .mockRejectedValue(
      new Error('no network in test'),
    ) as unknown as typeof fetch;
});

afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = realFetch;
});

// ─── Settings as a guest ─────────────────────────────────────────────────────

describe('SettingsScreen — guest', () => {
  it('labels the account LOCAL, explains where progress lives, and hides Manage account', () => {
    asGuest();
    const renderer = render(<SettingsScreen />);

    const copy = allText(renderer);
    expect(copy).toContain('LOCAL');
    expect(copy).toContain('Guest · this device');
    expect(copy).not.toContain('SYNCED');
    expect(pressables(renderer, 'Manage account, Details')).toHaveLength(0);
    expect(copy).not.toContain('Manage account');
    act(() => renderer.unmount());
  });

  it('a guest without a name reads the plain-language explanation', () => {
    asGuest();
    useAppStore.setState({ profile: null });
    const renderer = render(<SettingsScreen />);
    expect(allText(renderer)).toContain(
      'Progress stays on this phone until you connect an account.',
    );
    act(() => renderer.unmount());
  });

  it('"Connect account" is a labelled button that routes to ConnectAccount', async () => {
    asGuest();
    const renderer = render(<SettingsScreen />);

    const row = pressable(renderer, 'Connect account, For ratings');
    expect(row.props.accessibilityRole).toBe('button');
    await press(renderer, 'Connect account, For ratings');

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('ConnectAccount');
    act(() => renderer.unmount());
  });

  it('"Pickle Sensei Pro" for a guest says "Sign in first" and routes to ConnectAccount, never the paywall', async () => {
    asGuest();
    const renderer = render(<SettingsScreen />);

    const row = pressable(renderer, 'Pickle Sensei Pro, Sign in first');
    expect(row.props.accessibilityRole).toBe('button');
    await press(renderer, 'Pickle Sensei Pro, Sign in first');

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('ConnectAccount');
    expect(mockNavigate).not.toHaveBeenCalledWith('Paywall', expect.anything());
    act(() => renderer.unmount());
  });

  it('a synced session gets the paywall with source=settings and no Connect row', async () => {
    asSynced();
    const renderer = render(<SettingsScreen />);

    expect(pressables(renderer, 'Connect account, For ratings')).toHaveLength(
      0,
    );
    await press(renderer, 'Pickle Sensei Pro, Verify access');
    expect(mockNavigate).toHaveBeenCalledWith('Paywall', {
      source: 'settings',
    });
    expect(pressable(renderer, 'Manage account, Details')).toBeTruthy();
    act(() => renderer.unmount());
  });

  it('Settings never fires a backend request on behalf of a guest', () => {
    asGuest();
    const renderer = render(<SettingsScreen />);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(getApiSession()).toBeNull();
    act(() => renderer.unmount());
  });
});

describe('SettingsScreen — guest sign out', () => {
  it('"Sign out" opens a confirmation; the three cancel paths keep the guest signed in', async () => {
    asGuest();
    const renderer = render(<SettingsScreen />);
    expect(visibleModal(renderer)).toBe(false);

    for (const cancel of [
      'Keep me signed in',
      'Cancel sign out',
      'Close sign out confirmation',
    ]) {
      await press(renderer, 'Sign out');
      expect(visibleModal(renderer)).toBe(true);
      expect(allText(renderer)).toContain('Sign out of Pickle Sensei?');
      await press(renderer, cancel);
      expect(visibleModal(renderer)).toBe(false);
      expect(useAuthStore.getState().session).toEqual(guestSession);
      expect(mockKv.get(LOCAL_MODE_KEY)).toBe(GUEST_FLAG);
    }
    act(() => renderer.unmount());
  });

  it('confirming really signs the guest out: session null, flag cleared, owner signed-out', async () => {
    asGuest();
    const renderer = render(<SettingsScreen />);

    await press(renderer, 'Sign out');
    // The sheet exposes two "Sign out" pressables now (row + confirm button);
    // the confirm button is the one rendered inside the Modal.
    const modal = renderer.root
      .findAllByType(Modal)
      .find(node => node.props.visible === true);
    expect(modal).toBeTruthy();
    const confirm = innermostPressables(modal!, 'Sign out')[0];
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm!.props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(visibleModal(renderer)).toBe(false);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().busy).toBe(false);
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(mockKv.get(LOCAL_MODE_KEY)).toBe('');
    expect(mockGoogleSignin.signOut).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

// ─── Connect account (SignInScreen) from a guest ─────────────────────────────

describe('SignInScreen reached from a guest (ConnectAccount route)', () => {
  it('Back is a labelled button wired to onBack', async () => {
    asGuest();
    const onBack = jest.fn();
    const renderer = render(<SignInScreen onBack={onBack} />);

    const back = pressable(renderer, 'Back');
    expect(back.props.accessibilityRole).toBe('button');
    await press(renderer, 'Back');
    expect(onBack).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('explains why an account is needed and that on-device reads stay', () => {
    asGuest();
    const renderer = render(<SignInScreen onBack={() => {}} />);
    const copy = allText(renderer);
    expect(copy).toContain('A connected account is required for free ratings');
    expect(copy).toContain(
      'Your existing on-device reads stay here when you connect.',
    );
    act(() => renderer.unmount());
  });

  it('cancelling Google keeps the guest, shows no error card and re-enables the buttons', async () => {
    asGuest();
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'cancelled',
      data: null,
    });
    const renderer = render(<SignInScreen onBack={() => {}} />);

    await press(renderer, 'Continue with Google');
    await act(async () => {
      await Promise.resolve();
    });

    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().session).toEqual(guestSession);
    expect(pressables(renderer, 'Dismiss sign-in error')).toHaveLength(0);
    expect(allText(renderer)).not.toContain('SIGN-IN FAILED');
    expect(
      pressable(renderer, 'Continue with Google').props.accessibilityState
        .disabled,
    ).toBe(false);
    act(() => renderer.unmount());
  });

  it('a failed bootstrap shows dismissible failure copy and leaves the guest intact', async () => {
    asGuest();
    mockGoogleSignin.signIn.mockResolvedValue({
      type: 'success',
      data: {
        user: {
          id: 'google-uid-1',
          name: 'Pat',
          email: 'pat@gmail.example',
          photo: null,
          familyName: null,
          givenName: null,
        },
        scopes: [],
        idToken: 'google-id-token',
        serverAuthCode: null,
      },
    });
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: { message: 'Account service is down.' } }),
    }) as unknown as typeof fetch;
    const renderer = render(<SignInScreen onBack={() => {}} />);

    await press(renderer, 'Continue with Google');
    await act(async () => {
      await Promise.resolve();
    });

    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().session).toEqual(guestSession);
    expect(getActiveDataOwner()).toBe(GUEST_DATA_OWNER);
    const copy = allText(renderer);
    expect(copy).toContain('SIGN-IN FAILED');
    expect(copy).toContain('Account service is down.');
    const dismiss = pressable(renderer, 'Dismiss sign-in error');
    expect(dismiss.props.accessibilityHint).toBe('Account service is down.');
    expect(dismiss.props.accessibilityLiveRegion).toBe('assertive');
    await press(renderer, 'Dismiss sign-in error');
    expect(pressables(renderer, 'Dismiss sign-in error')).toHaveLength(0);
    expect(useAuthStore.getState().error).toBeNull();
    act(() => renderer.unmount());
  });

  it('while busy both providers are disabled (double-tap guard) and progress copy shows; busy always ends', async () => {
    asGuest();
    let resolveSignIn!: (value: unknown) => void;
    mockGoogleSignin.signIn.mockReturnValue(
      new Promise(resolve => {
        resolveSignIn = resolve;
      }),
    );
    const renderer = render(<SignInScreen onBack={() => {}} />);

    await press(renderer, 'Continue with Google');
    expect(useAuthStore.getState().busy).toBe(true);
    expect(allText(renderer)).toContain('Signing in securely…');
    for (const label of ['Continue with Apple', 'Continue with Google']) {
      const button = pressable(renderer, label);
      expect(button.props.disabled).toBe(true);
      expect(button.props.accessibilityState.disabled).toBe(true);
    }
    // A second tap while busy is a no-op at the store level.
    await act(async () => {
      await useAuthStore.getState().signInWithGoogle();
    });
    expect(mockGoogleSignin.signIn).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSignIn({ type: 'cancelled', data: null });
      await Promise.resolve();
    });
    expect(useAuthStore.getState().busy).toBe(false);
    expect(allText(renderer)).not.toContain('Signing in securely…');
    expect(pressable(renderer, 'Continue with Google').props.disabled).toBe(
      false,
    );
    act(() => renderer.unmount());
  });

  it('Apple unavailable in this build reports NOT CONFIGURED YET instead of a dead tap', async () => {
    asGuest();
    const renderer = render(<SignInScreen onBack={() => {}} />);

    await press(renderer, 'Continue with Apple');
    await act(async () => {
      await Promise.resolve();
    });

    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().session).toEqual(guestSession);
    expect(allText(renderer)).toContain('NOT CONFIGURED YET');
    expect(pressable(renderer, 'Dismiss sign-in error')).toBeTruthy();
    act(() => renderer.unmount());
  });
});

// ─── COACH menu capture actions as a guest ───────────────────────────────────

describe('PremiumTabBar capture actions — guest', () => {
  const mockRootNavigate = jest.fn();

  function tabBarProps(): BottomTabBarProps {
    return {
      state: {
        index: 0,
        routes: [
          { key: 'Home-1', name: 'Home' },
          { key: 'Library-1', name: 'Library' },
          { key: 'Add-1', name: 'Add' },
          { key: 'Performance-1', name: 'Performance' },
          { key: 'Settings-1', name: 'Settings' },
        ],
      },
      navigation: {
        emit: () => ({ defaultPrevented: false }),
        navigate: jest.fn(),
        getParent: () => ({ navigate: mockRootNavigate }),
      },
      descriptors: {},
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    } as unknown as BottomTabBarProps;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    mockRootNavigate.mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(['Auto Analyze', 'Import Video'])(
    '"%s" routes a guest to ConnectAccount without touching the access store or network',
    async action => {
      asGuest();
      const initializeSpy = jest.spyOn(useAccessStore.getState(), 'initialize');
      const renderer = render(<PremiumTabBar {...tabBarProps()} />);

      await press(renderer, 'Open coach actions');
      await press(renderer, action);
      await act(async () => {
        jest.advanceTimersByTime(400);
      });

      expect(mockRootNavigate).toHaveBeenCalledTimes(1);
      expect(mockRootNavigate).toHaveBeenCalledWith('ConnectAccount');
      expect(initializeSpy).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(useAccessStore.getState().status).toBe('idle');
      initializeSpy.mockRestore();
      act(() => renderer.unmount());
    },
  );

  it('the same actions send a canonical session without access through the paywall (source=rating), once', async () => {
    asSynced();
    // Unconfigured billing (no bootstrap in this test): the access store
    // resolves to 'unconfigured' and the bar routes on that answer. (An
    // unchecked 'idle' store is handed to the Analyze gate instead — the bar
    // never awaits initialize() itself.)
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    expect(useAccessStore.getState().status).toBe('unconfigured');
    const renderer = render(<PremiumTabBar {...tabBarProps()} />);

    await press(renderer, 'Open coach actions');
    await press(renderer, 'Auto Analyze');
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Honest paywall, no loop.
    expect(useAccessStore.getState().status).toBe('unconfigured');
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Paywall', {
      source: 'rating',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

// ─── Manage account: guests never see deletion; synced failure branches ──────

/**
 * The deletion dialog opens on a two-question exit survey ("What's making
 * you leave?" → "What would have kept you?") before the confirmation page.
 * These guest-flow cases care about the confirmation's failure branches, so
 * they take the survey's "Skip the survey" link (nothing is sent: the request
 * carries a `null` survey) to reach "Delete your account?".
 */
async function openDeletionConfirmation(
  renderer: TestRenderer.ReactTestRenderer,
) {
  await press(renderer, 'Delete account');
  expect(visibleModal(renderer)).toBe(true);
  expect(allText(renderer)).toContain("What's making you leave?");
  await press(renderer, 'Skip the survey');
  expect(allText(renderer)).toContain('Delete your account?');
}

function visibleModalOf(renderer: TestRenderer.ReactTestRenderer) {
  const modal = renderer.root
    .findAllByType(Modal)
    .find(node => node.props.visible === true);
  expect(modal).toBeTruthy();
  return modal!;
}

describe('ManageAccountScreen', () => {
  it('a guest sees LOCAL details and no Delete account control', () => {
    asGuest();
    const renderer = render(<ManageAccountScreen />);

    expect(allText(renderer)).toContain('LOCAL');
    expect(pressables(renderer, 'Delete account')).toHaveLength(0);
    expect(visibleModal(renderer)).toBe(false);
    act(() => renderer.unmount());
  });

  it('synced: cancelling the deletion dialog from every page and control deletes nothing, and re-opening starts the survey over', async () => {
    asSynced();
    const renderer = render(<ManageAccountScreen />);

    const cancelPaths: Array<{ reach: () => Promise<void>; cancel: string }> = [
      // Question 1: header close + backdrop.
      { reach: async () => {}, cancel: 'Close and keep my account' },
      { reach: async () => {}, cancel: 'Cancel account deletion' },
      // Question 2 (needs a reason to get there): header close.
      {
        reach: async () => {
          await press(renderer, "I don't use it enough");
          await press(renderer, 'Next');
          expect(allText(renderer)).toContain('What would have kept you?');
        },
        cancel: 'Close and keep my account',
      },
      // Confirmation page: primary "Keep my account", header close, backdrop.
      {
        reach: async () => press(renderer, 'Skip the survey'),
        cancel: 'Keep my account',
      },
      {
        reach: async () => press(renderer, 'Skip the survey'),
        cancel: 'Close account deletion confirmation',
      },
      {
        reach: async () => press(renderer, 'Skip the survey'),
        cancel: 'Cancel account deletion',
      },
    ];
    for (const { reach, cancel } of cancelPaths) {
      await press(renderer, 'Delete account');
      expect(visibleModal(renderer)).toBe(true);
      // Every presentation starts over at question 1 with nothing selected.
      expect(allText(renderer)).toContain("What's making you leave?");
      expect(pressable(renderer, 'Next').props.disabled).toBe(true);
      await reach();
      const control = pressable(renderer, cancel);
      expect(control.props.accessibilityRole).toBe('button');
      expect(control.props.disabled).toBeFalsy();
      await press(renderer, cancel);
      expect(visibleModal(renderer)).toBe(false);
    }
    // Android back (onRequestClose) is a cancel too while nothing is busy.
    await press(renderer, 'Delete account');
    const modal = visibleModalOf(renderer);
    expect(typeof modal.props.onRequestClose).toBe('function');
    await act(async () => {
      modal.props.onRequestClose();
    });
    expect(visibleModal(renderer)).toBe(false);

    expect(mockRequestAccountDeletion).not.toHaveBeenCalled();
    expect(mockConfirmAccountDeletion).not.toHaveBeenCalled();
    expect(useAuthStore.getState().session).toEqual(syncedSession);
    act(() => renderer.unmount());
  });

  it('synced: a failed deletion request shows copy, returns to review, and nothing is deleted', async () => {
    asSynced();
    mockRequestAccountDeletion.mockRejectedValue(new Error('boom'));
    const renderer = render(<ManageAccountScreen />);

    await openDeletionConfirmation(renderer);
    await press(renderer, 'Continue to delete');
    await act(async () => {
      await Promise.resolve();
    });

    // A skipped survey sends nothing: the request carries a null survey.
    expect(mockRequestAccountDeletion).toHaveBeenCalledTimes(1);
    expect(mockRequestAccountDeletion).toHaveBeenCalledWith(null, null);
    expect(allText(renderer)).toContain(
      'The deletion request could not be completed. Nothing was deleted.',
    );
    expect(pressable(renderer, 'Continue to delete').props.disabled).toBe(
      false,
    );
    expect(useAuthStore.getState().session).toEqual(syncedSession);
    expect(mockConfirmAccountDeletion).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('synced: while requesting, every dialog control is disabled (double-tap guard, no dismiss) and busy ends on failure', async () => {
    asSynced();
    let rejectRequest!: (error: Error) => void;
    mockRequestAccountDeletion.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRequest = reject;
      }),
    );
    const renderer = render(<ManageAccountScreen />);

    await openDeletionConfirmation(renderer);
    await press(renderer, 'Continue to delete');

    expect(pressable(renderer, 'Requesting…').props.disabled).toBe(true);
    expect(pressable(renderer, 'Keep my account').props.disabled).toBe(true);
    // Neither the header close, the backdrop, nor Android back can dismiss a
    // dialog with a request in flight.
    expect(
      pressable(renderer, 'Close account deletion confirmation').props.disabled,
    ).toBe(true);
    // The backdrop is not merely disabled — it has no handler at all.
    const backdrop = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityLabel === 'Cancel account deletion',
    );
    expect(backdrop.props.accessibilityState?.disabled).toBe(true);
    expect(pressables(renderer, 'Cancel account deletion')).toHaveLength(0);
    expect(visibleModalOf(renderer).props.onRequestClose).toBeUndefined();
    expect(mockRequestAccountDeletion).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectRequest(new Error('offline'));
      await Promise.resolve();
    });
    expect(pressable(renderer, 'Keep my account').props.disabled).toBe(false);
    expect(pressable(renderer, 'Continue to delete').props.disabled).toBe(
      false,
    );
    expect(
      pressable(renderer, 'Close account deletion confirmation').props.disabled,
    ).toBe(false);
    expect(typeof visibleModalOf(renderer).props.onRequestClose).toBe(
      'function',
    );
    act(() => renderer.unmount());
  });

  it('synced: a failed confirm keeps the account, shows copy, and re-arms the final button', async () => {
    jest.useFakeTimers();
    asSynced();
    mockRequestAccountDeletion.mockResolvedValue({
      challenge: 'challenge-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockConfirmAccountDeletion.mockRejectedValue(new Error('server 500'));
    const renderer = render(<ManageAccountScreen />);

    await openDeletionConfirmation(renderer);
    await press(renderer, 'Continue to delete');
    await act(async () => {
      await Promise.resolve();
    });
    expect(pressable(renderer, 'Permanently delete (5)').props.disabled).toBe(
      true,
    );
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(pressable(renderer, 'Permanently delete').props.disabled).toBe(
      false,
    );

    await press(renderer, 'Permanently delete');
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockConfirmAccountDeletion).toHaveBeenCalledWith(
      null,
      'challenge-1',
    );
    expect(allText(renderer)).toContain(
      'The deletion could not be completed. Nothing was deleted.',
    );
    expect(pressable(renderer, 'Permanently delete').props.disabled).toBe(
      false,
    );
    expect(useAuthStore.getState().session).toEqual(syncedSession);
    expect(pressable(renderer, 'Keep my account').props.disabled).toBe(false);
    act(() => renderer.unmount());
    jest.useRealTimers();
  });
});
