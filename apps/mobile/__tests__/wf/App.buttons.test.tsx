import React from 'react';
import { Alert, AppState, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Button ledger for App.tsx.
 *
 * App.tsx owns no Pressable of its own: every interactive element it wires is
 * a callback handed to a child screen (Welcome → Start / I already have an
 * account, pre-auth Onboarding → finished / Leave setup → Skip to sign-in,
 * SignIn → Back, Splash → onFinished) plus the AppState background listener.
 * This suite mounts the REAL App with the real Welcome / SignIn / Onboarding
 * screens and presses each of those controls, asserting the stage the Gate
 * renders next. Stores are replaced by controllable zustand instances (no
 * SQLite under jest); RootNavigator, the three global overlays and the splash
 * are stubbed so the assertions stay on App.tsx's own wiring.
 */

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  const passthrough = (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(RNView, null, props.children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

const mockHydrateApp = jest.fn<Promise<void>, []>(() => Promise.resolve());
const mockCompleteOnboarding = jest.fn<Promise<void>, [unknown]>(() =>
  Promise.resolve(),
);
const mockCompletePreAuthOnboarding = jest.fn<Promise<boolean>, [unknown]>(() =>
  Promise.resolve(true),
);
jest.mock('../../src/state/appStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  const { focusForGoal } = jest.requireActual<
    typeof import('../../src/state/profile')
  >('../../src/state/profile');
  return {
    focusForGoal,
    useAppStore: create(() => ({
      hydrated: false,
      ownerKey: null,
      profile: null,
      preAuthOnboarded: false,
      onboardingBusy: false,
      onboardingError: null,
      lastShotType: 'forehand_drive',
      hydrate: () => mockHydrateApp(),
      completeOnboarding: (profile: unknown) => mockCompleteOnboarding(profile),
      completePreAuthOnboarding: (profile: unknown) =>
        mockCompletePreAuthOnboarding(profile),
    })),
  };
});

const mockHydrateAuth = jest.fn<Promise<void>, []>(() => Promise.resolve());
const mockSignInWithApple = jest.fn();
const mockSignInWithGoogle = jest.fn();
const mockSignOut = jest.fn();
const mockClearError = jest.fn();
jest.mock('../../src/auth/authStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  return {
    useAuthStore: create(() => ({
      hydrated: false,
      session: null,
      busy: false,
      error: null,
      hydrate: () => mockHydrateAuth(),
      signInWithApple: () => mockSignInWithApple(),
      signInWithGoogle: () => mockSignInWithGoogle(),
      signOut: () => mockSignOut(),
      clearError: () => mockClearError(),
    })),
  };
});

const mockCompleteNotificationOnboarding = jest.fn<
  Promise<boolean>,
  ['enable' | 'not_now']
>(() => Promise.resolve(true));
jest.mock('../../src/notifications/notificationStore', () => {
  const state = {
    completeOnboardingStep: (choice: 'enable' | 'not_now') =>
      mockCompleteNotificationOnboarding(choice),
  };
  return {
    useNotificationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

const mockMaybeShowFirstRun = jest.fn<Promise<void>, []>(() =>
  Promise.resolve(),
);
jest.mock('../../src/walkthrough/walkthroughStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  return {
    useWalkthroughStore: create(() => ({
      visible: false,
      maybeShowFirstRun: () => mockMaybeShowFirstRun(),
    })),
  };
});

const mockNotificationBootstrap = jest.fn<void, [string | null]>();
jest.mock('../../src/notifications/useNotificationBootstrap', () => ({
  useNotificationBootstrap: (owner: string | null) =>
    mockNotificationBootstrap(owner),
}));
const mockConsistencyBootstrap = jest.fn<void, [string | null]>();
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: (owner: string | null) =>
    mockConsistencyBootstrap(owner),
}));

// Screens/overlays that are NOT App.tsx's own controls are stubbed with
// markers so the Gate's routing decisions are observable without dragging
// the whole navigator (and its many stores) into this suite.
jest.mock('../../src/navigation/RootNavigator', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    RootNavigator: () =>
      ReactActual.createElement(RNView, { testID: 'RootNavigator' }),
  };
});
jest.mock('../../src/components/RankUpCelebration', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    RankUpCelebration: () =>
      ReactActual.createElement(RNView, { testID: 'RankUpCelebration' }),
  };
});
jest.mock('../../src/consistency/StreakCelebration', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    StreakCelebration: () =>
      ReactActual.createElement(RNView, { testID: 'StreakCelebration' }),
  };
});
jest.mock('../../src/walkthrough/FirstRunWalkthrough', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    FirstRunWalkthrough: () =>
      ReactActual.createElement(RNView, { testID: 'FirstRunWalkthrough' }),
  };
});

// The real splash finishes through an Animated.timing on the native driver,
// whose completion callback never fires under jest's NativeAnimatedModule
// mock. The stub exposes exactly the two props App.tsx wires (`ready`,
// `onFinished`) so the handoff can be driven and asserted.
jest.mock('../../src/screens/SplashScreen', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) =>
      ReactActual.createElement(RNView, {
        testID: 'SplashScreen',
        accessibilityLabel: 'Pickle Sensei is starting',
        ready: props.ready,
        onFinished: props.onFinished,
      }),
  };
});

import App from '../../App';
import { useAppStore } from '../../src/state/appStore';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';

const CANONICAL_ID = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
const CANONICAL_OWNER = CANONICAL_ID.toLowerCase();

const googleSession: AuthSession = {
  provider: 'google',
  subject: 'google-subject',
  canonicalAppUserId: CANONICAL_ID,
  localOnly: false,
  displayName: 'Dana',
  email: null,
};

const guestSession: AuthSession = {
  provider: 'guest',
  subject: 'guest',
  canonicalAppUserId: null,
  localOnly: true,
  displayName: null,
  email: null,
};

type Renderer = TestRenderer.ReactTestRenderer;
type ReactTestInstance = TestRenderer.ReactTestInstance;

const setContextSpy = jest.spyOn(stabilitySlo, 'setContext');
const recordSpy = jest.spyOn(stabilitySlo, 'record');
const appStateListener = AppState.addEventListener as jest.Mock;

/** Mimics the real appStore.hydrate: marks the given owner hydrated. */
function hydrateAppAs(owner: string, preAuthOnboarded = false) {
  mockHydrateApp.mockImplementation(async () => {
    useAppStore.setState({
      hydrated: true,
      ownerKey: owner,
      profile: null,
      preAuthOnboarded,
    });
  });
}

function resetStores() {
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    preAuthOnboarded: false,
    onboardingBusy: false,
    onboardingError: null,
  });
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
  });
}

const mounted: Renderer[] = [];

function render(): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(<App />);
  });
  mounted.push(renderer);
  return renderer;
}

function unmount(renderer: Renderer) {
  const index = mounted.indexOf(renderer);
  if (index >= 0) {
    mounted.splice(index, 1);
  }
  act(() => renderer.unmount());
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join('');
}

/** Host views only, so a stubbed screen counts once (not composite + host). */
function markers(renderer: Renderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

/**
 * Every design control (Button / PressableScale / ScreenHeader) bottoms out
 * in a react-native `Pressable`, which is where accessibilityRole, hitSlop
 * and disabled are finally resolved. Wrappers forward the label down, so the
 * ledger keeps only the innermost labelled node with an onPress.
 */
function findAllPressables(renderer: Renderer, label: string) {
  const isMatch = (node: ReactTestInstance) =>
    node.props?.accessibilityLabel === label &&
    typeof node.props?.onPress === 'function';
  const matches = renderer.root.findAll(isMatch);
  return matches.filter(
    node =>
      node.findAll(child => child !== node && isMatch(child)).length === 0,
  );
}

function findPressable(renderer: Renderer, label: string) {
  const nodes = findAllPressables(renderer, label);
  expect(nodes.length).toBeGreaterThan(0);
  return nodes[0]!;
}

function pressableCount(renderer: Renderer, label: string) {
  return findAllPressables(renderer, label).length;
}

function press(renderer: Renderer, label: string) {
  const node = findPressable(renderer, label);
  expect(node.props.disabled).toBeFalsy();
  expect(['button', 'radio']).toContain(node.props.accessibilityRole);
  act(() => {
    node.props.onPress();
  });
}

/** Signed-out, hydrated, first screen painted, splash still overlaid. */
async function renderReadyWelcome(preAuthOnboarded = false) {
  hydrateAppAs(SIGNED_OUT_DATA_OWNER, preAuthOnboarded);
  const renderer = render();
  await act(async () => {
    useAuthStore.setState({ hydrated: true, session: null });
  });
  expect(allText(renderer)).toContain('See the stroke.');
  return renderer;
}

function onWelcome(renderer: Renderer) {
  expect(allText(renderer)).toContain('See the stroke.');
  expect(pressableCount(renderer, 'Start your first read')).toBe(1);
  expect(pressableCount(renderer, 'I already have an account')).toBe(1);
}

function onSignIn(renderer: Renderer) {
  expect(allText(renderer)).toContain('Your ratings,');
  expect(pressableCount(renderer, 'Back')).toBe(1);
  expect(pressableCount(renderer, 'Continue with Google')).toBe(1);
  expect(allText(renderer)).not.toContain('See the stroke.');
}

function onPreAuthOnboarding(renderer: Renderer) {
  expect(allText(renderer)).toContain('What should we call you?');
  const leave = findPressable(renderer, 'Leave setup');
  expect(leave.props.accessibilityHint).toBe(
    'Skip ahead to the sign-in screen',
  );
}

/** Answers every questionnaire step so the notification step is reachable. */
function walkToNotifications(renderer: Renderer) {
  act(() => renderer.root.findByType(TextInput).props.onChangeText(' Dana '));
  press(renderer, 'Continue');
  press(renderer, 'Female');
  press(renderer, 'Continue');
  press(renderer, '3.5');
  press(renderer, 'Continue');
  press(renderer, 'Right-handed');
  press(renderer, 'Continue');
  press(renderer, 'Third-shot drops');
  press(renderer, 'Continue');
  press(renderer, 'Control');
  press(renderer, 'Continue');
  expect(allText(renderer)).toContain('Built for Dana.');
  press(renderer, 'Continue');
  expect(allText(renderer)).toContain('Stay match-ready.');
}

afterEach(() => {
  while (mounted.length > 0) {
    unmount(mounted[mounted.length - 1]!);
  }
});

beforeEach(() => {
  resetStores();
  mockHydrateApp.mockReset();
  mockHydrateApp.mockImplementation(() => Promise.resolve());
  mockHydrateAuth.mockClear();
  mockCompleteOnboarding.mockClear();
  mockCompletePreAuthOnboarding.mockReset();
  mockCompletePreAuthOnboarding.mockResolvedValue(true);
  mockCompleteNotificationOnboarding.mockReset();
  mockCompleteNotificationOnboarding.mockResolvedValue(true);
  mockMaybeShowFirstRun.mockClear();
  mockNotificationBootstrap.mockClear();
  mockConsistencyBootstrap.mockClear();
  mockSignOut.mockClear();
  setContextSpy.mockClear();
  recordSpy.mockClear();
  appStateListener.mockClear();
});

describe('App.tsx — launch gate and splash', () => {
  it('hydrates auth once on mount and paints ONLY the splash until hydration lands', () => {
    const renderer = render();
    expect(mockHydrateAuth).toHaveBeenCalledTimes(1);
    // No owner yet → no app hydration, no owner-scoped bootstraps.
    expect(mockHydrateApp).not.toHaveBeenCalled();
    expect(mockNotificationBootstrap).toHaveBeenLastCalledWith(null);
    expect(mockConsistencyBootstrap).toHaveBeenLastCalledWith(null);

    const [splash] = markers(renderer, 'SplashScreen');
    expect(splash).toBeDefined();
    expect(splash!.props.ready).toBe(false);
    expect(allText(renderer)).not.toContain('See the stroke.');
    expect(markers(renderer, 'RootNavigator')).toHaveLength(0);

    // Global overlays are mounted from the very first frame.
    expect(markers(renderer, 'RankUpCelebration')).toHaveLength(1);
    expect(markers(renderer, 'StreakCelebration')).toHaveLength(1);
    expect(markers(renderer, 'FirstRunWalkthrough')).toHaveLength(1);
    unmount(renderer);
  });

  it('signed-out hydration: resolves the signed-out owner, hydrates the app store, tags telemetry and renders Welcome under a ready splash', async () => {
    const renderer = await renderReadyWelcome();
    expect(mockHydrateApp).toHaveBeenCalledTimes(1);
    expect(mockNotificationBootstrap).toHaveBeenLastCalledWith(
      SIGNED_OUT_DATA_OWNER,
    );
    expect(mockConsistencyBootstrap).toHaveBeenLastCalledWith(
      SIGNED_OUT_DATA_OWNER,
    );
    expect(setContextSpy).toHaveBeenCalledWith({
      userKey: SIGNED_OUT_DATA_OWNER,
      sessionKey: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    const [splash] = markers(renderer, 'SplashScreen');
    expect(splash!.props.ready).toBe(true);
    onWelcome(renderer);
    unmount(renderer);
  });

  it('SplashScreen onFinished -> handleSplashFinished removes the overlay for the rest of the run', async () => {
    const renderer = await renderReadyWelcome();
    const [splash] = markers(renderer, 'SplashScreen');
    act(() => {
      splash!.props.onFinished();
    });
    expect(markers(renderer, 'SplashScreen')).toHaveLength(0);
    onWelcome(renderer);

    // A later owner switch re-hydrates the app store but never brings the
    // splash back.
    hydrateAppAs(CANONICAL_OWNER, true);
    await act(async () => {
      useAuthStore.setState({ session: googleSession });
    });
    expect(markers(renderer, 'SplashScreen')).toHaveLength(0);
    unmount(renderer);
  });

  it('splash stays unready (no first screen) while the app store still belongs to a stale owner', async () => {
    // hydrate() for the new owner never resolves in this scenario.
    mockHydrateApp.mockImplementation(() => new Promise(() => {}));
    const renderer = render();
    await act(async () => {
      useAppStore.setState({
        hydrated: true,
        ownerKey: GUEST_DATA_OWNER,
        profile: null,
      });
      useAuthStore.setState({ hydrated: true, session: null });
    });
    expect(mockHydrateApp).toHaveBeenCalledTimes(1);
    const [splash] = markers(renderer, 'SplashScreen');
    expect(splash!.props.ready).toBe(false);
    expect(allText(renderer)).not.toContain('See the stroke.');
    expect(markers(renderer, 'RootNavigator')).toHaveLength(0);
    unmount(renderer);
  });

  it('a hydrate() that lands in its catch path (hydrated with no profile) still readies the gate — no infinite splash', async () => {
    mockHydrateApp.mockImplementation(async () => {
      // Mirrors appStore.hydrate's catch branch.
      useAppStore.setState({
        hydrated: true,
        ownerKey: SIGNED_OUT_DATA_OWNER,
        profile: null,
        preAuthOnboarded: false,
      });
    });
    const renderer = render();
    await act(async () => {
      useAuthStore.setState({ hydrated: true, session: null });
    });
    const [splash] = markers(renderer, 'SplashScreen');
    expect(splash!.props.ready).toBe(true);
    onWelcome(renderer);
    unmount(renderer);
  });
});

describe('App.tsx — WelcomeScreen callbacks', () => {
  it('"Start your first read" -> onGetStarted: fresh device goes to the pre-auth questionnaire', async () => {
    const renderer = await renderReadyWelcome(false);
    press(renderer, 'Start your first read');
    onPreAuthOnboarding(renderer);
    expect(pressableCount(renderer, 'Start your first read')).toBe(0);
    unmount(renderer);
  });

  it('"Start your first read" -> onGetStarted: an already-onboarded device skips straight to sign-in', async () => {
    const renderer = await renderReadyWelcome(true);
    press(renderer, 'Start your first read');
    onSignIn(renderer);
    expect(allText(renderer)).not.toContain('What should we call you?');
    unmount(renderer);
  });

  it('"I already have an account" -> onSignIn: goes to sign-in regardless of onboarding state', async () => {
    const renderer = await renderReadyWelcome(false);
    const link = findPressable(renderer, 'I already have an account');
    expect(link.props.accessibilityHint).toBe('Skip setup and go to sign-in');
    press(renderer, 'I already have an account');
    onSignIn(renderer);
    unmount(renderer);
  });
});

describe('App.tsx — SignInScreen callback', () => {
  it('"Back" -> onBack: returns to Welcome from sign-in (both entry paths)', async () => {
    const renderer = await renderReadyWelcome(false);
    press(renderer, 'I already have an account');
    onSignIn(renderer);
    const back = findPressable(renderer, 'Back');
    expect(back.props.hitSlop).toBe(8);
    press(renderer, 'Back');
    onWelcome(renderer);

    // Reaching sign-in via the questionnaire skip also backs out to Welcome,
    // not into the questionnaire.
    const alertSpy = jest
      .spyOn(Alert, 'alert')
      .mockImplementation(() => undefined);
    press(renderer, 'Start your first read');
    press(renderer, 'Leave setup');
    const skip = (alertSpy.mock.calls[0]?.[2] ?? []).find(
      button => button.text === 'Skip to sign-in',
    );
    act(() => skip!.onPress?.());
    onSignIn(renderer);
    press(renderer, 'Back');
    onWelcome(renderer);
    alertSpy.mockRestore();
    unmount(renderer);
  });

  it('sign-in provider buttons on the App-mounted screen reach the auth store (no dead controls)', async () => {
    const renderer = await renderReadyWelcome(true);
    press(renderer, 'Start your first read');
    press(renderer, 'Continue with Google');
    expect(mockSignInWithGoogle).toHaveBeenCalledTimes(1);
    press(renderer, 'Continue with Apple');
    expect(mockSignInWithApple).toHaveBeenCalledTimes(1);
    unmount(renderer);
  });
});

describe('App.tsx — pre-auth OnboardingScreen callbacks', () => {
  it('"Leave setup" -> Alert "Skip to sign-in" -> onExitToSignIn: lands on sign-in without touching the session', async () => {
    const alertSpy = jest
      .spyOn(Alert, 'alert')
      .mockImplementation(() => undefined);
    const renderer = await renderReadyWelcome(false);
    press(renderer, 'Start your first read');
    onPreAuthOnboarding(renderer);

    const leave = findPressable(renderer, 'Leave setup');
    expect(leave.props.hitSlop).toBe(12);
    press(renderer, 'Leave setup');
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0]?.[0]).toBe('Skip setup?');
    const buttons = alertSpy.mock.calls[0]?.[2] ?? [];
    expect(buttons.map(b => b.text)).toEqual([
      'Keep setting up',
      'Skip to sign-in',
    ]);

    // Cancel keeps the questionnaire.
    act(() => buttons[0]!.onPress?.());
    onPreAuthOnboarding(renderer);

    act(() => buttons[1]!.onPress?.());
    onSignIn(renderer);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockCompletePreAuthOnboarding).not.toHaveBeenCalled();
    alertSpy.mockRestore();
    unmount(renderer);
  });

  it('"Not now" -> completePreAuthOnboarding ok -> onFinished: hands off to sign-in', async () => {
    const renderer = await renderReadyWelcome(false);
    press(renderer, 'Start your first read');
    walkToNotifications(renderer);

    press(renderer, 'Not now');
    await act(async () => {});
    expect(mockCompleteNotificationOnboarding).toHaveBeenCalledWith('not_now');
    expect(mockCompletePreAuthOnboarding).toHaveBeenCalledTimes(1);
    expect(mockCompleteOnboarding).not.toHaveBeenCalled();
    onSignIn(renderer);
    unmount(renderer);
  });

  it('"Turn on reminders" -> completePreAuthOnboarding ok -> onFinished: hands off to sign-in', async () => {
    const renderer = await renderReadyWelcome(false);
    press(renderer, 'Start your first read');
    walkToNotifications(renderer);

    press(renderer, 'Turn on reminders');
    await act(async () => {});
    expect(mockCompleteNotificationOnboarding).toHaveBeenCalledWith('enable');
    expect(mockCompletePreAuthOnboarding).toHaveBeenCalledTimes(1);
    onSignIn(renderer);
    unmount(renderer);
  });

  it('failure path: a failed stash keeps the questionnaire on screen with the error copy and re-enabled buttons', async () => {
    mockCompletePreAuthOnboarding.mockImplementation(async () => {
      useAppStore.setState({
        onboardingBusy: false,
        onboardingError: 'Your answers could not be saved.',
      });
      return false;
    });
    const renderer = await renderReadyWelcome(false);
    press(renderer, 'Start your first read');
    walkToNotifications(renderer);

    press(renderer, 'Not now');
    await act(async () => {});
    expect(mockCompletePreAuthOnboarding).toHaveBeenCalledTimes(1);
    // Still on the notification step, never on sign-in.
    expect(allText(renderer)).toContain('Stay match-ready.');
    expect(allText(renderer)).toContain('Your answers could not be saved.');
    expect(allText(renderer)).not.toContain('Your ratings,');
    expect(findPressable(renderer, 'Not now').props.disabled).toBeFalsy();
    expect(
      findPressable(renderer, 'Turn on reminders').props.disabled,
    ).toBeFalsy();

    // Retry succeeds → the handoff finally happens.
    mockCompletePreAuthOnboarding.mockImplementation(async () => {
      useAppStore.setState({ onboardingError: null });
      return true;
    });
    press(renderer, 'Not now');
    await act(async () => {});
    // The notification choice was already recorded; only the stash retries.
    expect(mockCompleteNotificationOnboarding).toHaveBeenCalledTimes(1);
    onSignIn(renderer);
    unmount(renderer);
  });
});

describe('App.tsx — signed-in routing', () => {
  it('canonical session without a profile: hydrates the canonical owner and shows the in-account OnboardingScreen', async () => {
    const renderer = await renderReadyWelcome(true);
    press(renderer, 'Start your first read');
    onSignIn(renderer);

    hydrateAppAs(CANONICAL_OWNER, true);
    await act(async () => {
      useAuthStore.setState({ session: googleSession });
    });
    expect(mockHydrateApp).toHaveBeenCalledTimes(2);
    expect(mockNotificationBootstrap).toHaveBeenLastCalledWith(CANONICAL_OWNER);
    expect(mockConsistencyBootstrap).toHaveBeenLastCalledWith(CANONICAL_OWNER);
    expect(setContextSpy).toHaveBeenLastCalledWith({
      userKey: CANONICAL_OWNER,
      sessionKey: expect.any(String),
    });
    expect(allText(renderer)).toContain('What should we call you?');
    // Account mode: the escape route signs out instead of skipping ahead.
    expect(findPressable(renderer, 'Leave setup').props.accessibilityHint).toBe(
      'Sign out and return to the sign-in screen',
    );
    expect(markers(renderer, 'RootNavigator')).toHaveLength(0);
    expect(mockMaybeShowFirstRun).not.toHaveBeenCalled();
    unmount(renderer);
  });

  it('session + profile: mounts RootNavigator and raises the first-run walkthrough exactly once', async () => {
    const renderer = await renderReadyWelcome(true);
    mockHydrateApp.mockImplementation(async () => {
      useAppStore.setState({
        hydrated: true,
        ownerKey: CANONICAL_OWNER,
        preAuthOnboarded: true,
        profile: {
          skillLevel: '3.5',
          handedness: 'right',
          goal: 'drops',
          biggestProblem: 'control',
          focusCheckpoint: 'paddle_set',
        },
      });
    });
    await act(async () => {
      useAuthStore.setState({ session: googleSession });
    });
    expect(markers(renderer, 'RootNavigator')).toHaveLength(1);
    expect(allText(renderer)).not.toContain('See the stroke.');
    expect(mockMaybeShowFirstRun).toHaveBeenCalledTimes(1);

    // Unrelated re-renders do not re-fire the walkthrough effect.
    await act(async () => {
      useAuthStore.setState({ busy: true });
      useAuthStore.setState({ busy: false });
    });
    expect(mockMaybeShowFirstRun).toHaveBeenCalledTimes(1);

    // Signing out drops the navigator and returns to the pre-auth gate.
    hydrateAppAs(SIGNED_OUT_DATA_OWNER, true);
    await act(async () => {
      useAuthStore.setState({ session: null });
    });
    expect(markers(renderer, 'RootNavigator')).toHaveLength(0);
    expect(mockNotificationBootstrap).toHaveBeenLastCalledWith(
      SIGNED_OUT_DATA_OWNER,
    );
    unmount(renderer);
  });

  it('guest session resolves the device-guest owner', async () => {
    hydrateAppAs(GUEST_DATA_OWNER, true);
    const renderer = render();
    await act(async () => {
      useAuthStore.setState({ hydrated: true, session: guestSession });
    });
    expect(mockNotificationBootstrap).toHaveBeenLastCalledWith(
      GUEST_DATA_OWNER,
    );
    expect(mockConsistencyBootstrap).toHaveBeenLastCalledWith(GUEST_DATA_OWNER);
    expect(setContextSpy).toHaveBeenLastCalledWith({
      userKey: GUEST_DATA_OWNER,
      sessionKey: expect.any(String),
    });
    // Guest with no profile → in-account onboarding.
    expect(allText(renderer)).toContain('What should we call you?');
    unmount(renderer);
  });
});

describe('App.tsx — AppState listener', () => {
  it('records a clean session end on background only, and unsubscribes on unmount', () => {
    const renderer = render();
    // App.tsx registers exactly one AppState listener of its own (the two
    // bootstrap hooks are mocked here).
    expect(appStateListener).toHaveBeenCalledTimes(1);
    const [event, listener] = appStateListener.mock.calls[0] as [
      string,
      (state: string) => void,
    ];
    expect(event).toBe('change');

    act(() => listener('active'));
    act(() => listener('inactive'));
    expect(recordSpy).not.toHaveBeenCalledWith({
      kind: 'session_ended_clean',
    });

    act(() => listener('background'));
    expect(recordSpy).toHaveBeenCalledWith({ kind: 'session_ended_clean' });

    const subscription = appStateListener.mock.results[0]?.value as {
      remove: jest.Mock;
    };
    unmount(renderer);
    expect(subscription.remove).toHaveBeenCalledTimes(1);
  });
});
