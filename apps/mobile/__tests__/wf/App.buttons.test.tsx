import React from 'react';
import { Alert, AppState, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Button ledger for App.tsx.
 *
 * App.tsx owns no Pressable of its own: every interactive element it wires is
 * a callback handed to a child screen (Welcome → Start / I already have an
 * account, pre-auth Onboarding → finished / step-one Back → Welcome,
 * SignIn → Back, Splash → onFinished) plus the AppState background listener.
 * This suite mounts the REAL App with the real Welcome / SignIn / Onboarding
 * screens and presses each of those controls, asserting the stage the Gate
 * renders next. Stores are replaced by controllable zustand instances (no
 * SQLite under jest); RootNavigator, the three global overlays and the splash
 * are stubbed so the assertions stay on App.tsx's own wiring.
 *
 * Launch contract (product decision 2026-09-01): "Start your first read"
 * ALWAYS enters the questionnaire — there is no device-level "already
 * onboarded" marker and no skip-to-sign-in escape. The only way to sign-in
 * through the flow is finishing it; returning players take "I already have
 * an account".
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
      hydrateError: null,
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

// The real splash (an MP4 intro) finishes through an Animated.timing on the
// native driver, whose completion callback never fires under jest's
// NativeAnimatedModule mock. The stub exposes exactly the two props App.tsx
// wires (`ready`, `onFinished`) so the handoff can be driven and asserted.
jest.mock('../../src/screens/SplashScreen', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) =>
      ReactActual.createElement(RNView, {
        testID: 'SplashScreen',
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

const onboardedProfile = {
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
} as const;

/** Mimics the real appStore.hydrate: marks the given owner hydrated. */
function hydrateAppAs(
  owner: string,
  profile: typeof onboardedProfile | null = null,
) {
  mockHydrateApp.mockImplementation(async () => {
    useAppStore.setState({
      hydrated: true,
      ownerKey: owner,
      profile,
      hydrateError: null,
    });
  });
}

function resetStores() {
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
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
async function renderReadyWelcome() {
  hydrateAppAs(SIGNED_OUT_DATA_OWNER);
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
  expect(allText(renderer)).not.toContain('What should we call you?');
}

function onSignIn(renderer: Renderer) {
  expect(allText(renderer)).toContain('Your ratings,');
  expect(pressableCount(renderer, 'Back')).toBe(1);
  expect(pressableCount(renderer, 'Continue with Google')).toBe(1);
  expect(allText(renderer)).not.toContain('See the stroke.');
  expect(allText(renderer)).not.toContain('What should we call you?');
}

/**
 * Step one of the pre-auth questionnaire: its only control besides Continue
 * is a plain Back to Welcome. There is no "Leave setup" / skip affordance
 * anywhere in pre-auth mode (product decision 2026-09-01).
 */
function onPreAuthOnboarding(renderer: Renderer) {
  expect(allText(renderer)).toContain('What should we call you?');
  expect(allText(renderer)).not.toContain('See the stroke.');
  expect(allText(renderer)).not.toContain('Your ratings,');
  expect(allText(renderer)).not.toMatch(/skip/i);
  expect(pressableCount(renderer, 'Leave setup')).toBe(0);
  const back = findPressable(renderer, 'Back');
  expect(back.props.accessibilityHint).toBe('Return to the welcome screen');
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
    hydrateAppAs(CANONICAL_OWNER);
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
      // Mirrors appStore.hydrate's catch branch: hydrated, no profile, the
      // failure recorded in hydrateError.
      useAppStore.setState({
        hydrated: true,
        ownerKey: SIGNED_OUT_DATA_OWNER,
        profile: null,
        hydrateError: 'Your coaching profile could not be loaded.',
      });
    });
    const renderer = render();
    await act(async () => {
      useAuthStore.setState({ hydrated: true, session: null });
    });
    const [splash] = markers(renderer, 'SplashScreen');
    expect(splash!.props.ready).toBe(true);
    // Signed out, the retry state is never shown: Welcome paints as usual.
    onWelcome(renderer);
    expect(allText(renderer)).not.toContain(
      'Your coaching profile couldn’t load',
    );
    unmount(renderer);
  });
});

describe('App.tsx — WelcomeScreen callbacks', () => {
  it('"Start your first read" -> onGetStarted: fresh device goes to the pre-auth questionnaire', async () => {
    const renderer = await renderReadyWelcome();
    press(renderer, 'Start your first read');
    onPreAuthOnboarding(renderer);
    expect(pressableCount(renderer, 'Start your first read')).toBe(0);
    unmount(renderer);
  });

  // The device-level "already onboarded" short-circuit to sign-in was removed
  // 2026-09-01 (invest first, then create the account): the primary CTA takes
  // no device-history input, so a phone that has already held a fully
  // onboarded account gets exactly the same path as a fresh one.
  it('"Start your first read" -> onGetStarted: a device that already held an onboarded profile STILL enters the questionnaire (no device-history short-circuit)', async () => {
    const renderer = await renderReadyWelcome();

    // Sign in with a finished profile (the main app mounts), then sign out.
    hydrateAppAs(CANONICAL_OWNER, onboardedProfile);
    await act(async () => {
      useAuthStore.setState({ session: googleSession });
    });
    expect(markers(renderer, 'RootNavigator')).toHaveLength(1);
    hydrateAppAs(SIGNED_OUT_DATA_OWNER);
    await act(async () => {
      useAuthStore.setState({ session: null });
    });
    onWelcome(renderer);

    press(renderer, 'Start your first read');
    onPreAuthOnboarding(renderer);
    unmount(renderer);
  });

  it('"I already have an account" -> onSignIn: the explicit returning-player route goes straight to sign-in', async () => {
    const renderer = await renderReadyWelcome();
    const link = findPressable(renderer, 'I already have an account');
    expect(link.props.accessibilityHint).toBe('Sign in to an existing account');
    press(renderer, 'I already have an account');
    onSignIn(renderer);
    unmount(renderer);
  });
});

describe('App.tsx — SignInScreen callback', () => {
  it('"Back" -> onBack: returns to Welcome from sign-in (both entry paths)', async () => {
    const renderer = await renderReadyWelcome();
    press(renderer, 'I already have an account');
    onSignIn(renderer);
    const back = findPressable(renderer, 'Back');
    expect(back.props.hitSlop).toBe(8);
    press(renderer, 'Back');
    onWelcome(renderer);

    // Reaching sign-in the other way — by FINISHING the questionnaire (the
    // only route through it) — also backs out to Welcome, never back into
    // the questionnaire.
    press(renderer, 'Start your first read');
    walkToNotifications(renderer);
    press(renderer, 'Not now');
    await act(async () => {});
    onSignIn(renderer);
    press(renderer, 'Back');
    onWelcome(renderer);
    unmount(renderer);
  });

  it('sign-in provider buttons on the App-mounted screen reach the auth store (no dead controls)', async () => {
    const renderer = await renderReadyWelcome();
    press(renderer, 'I already have an account');
    onSignIn(renderer);
    press(renderer, 'Continue with Google');
    expect(mockSignInWithGoogle).toHaveBeenCalledTimes(1);
    press(renderer, 'Continue with Apple');
    expect(mockSignInWithApple).toHaveBeenCalledTimes(1);
    unmount(renderer);
  });
});

describe('App.tsx — pre-auth OnboardingScreen callbacks', () => {
  // The former "Leave setup" → Alert → "Skip to sign-in" escape
  // (onExitToSignIn) was removed 2026-09-01: the questionnaire is required.
  // Step one's control is now a plain Back that returns to Welcome through
  // stageWhenLeavingOnboarding() — no alert, no sign-in, session untouched.
  it('step-one "Back" -> onBack -> stageWhenLeavingOnboarding: returns to Welcome without an alert, never to sign-in', async () => {
    const alertSpy = jest
      .spyOn(Alert, 'alert')
      .mockImplementation(() => undefined);
    const renderer = await renderReadyWelcome();
    press(renderer, 'Start your first read');
    onPreAuthOnboarding(renderer);

    const back = findPressable(renderer, 'Back');
    expect(back.props.hitSlop).toBe(12);
    press(renderer, 'Back');
    expect(alertSpy).not.toHaveBeenCalled();
    onWelcome(renderer);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockCompletePreAuthOnboarding).not.toHaveBeenCalled();

    // Re-entering starts the questionnaire over at step one — the CTA never
    // skips ahead, however many times the device has been here.
    press(renderer, 'Start your first read');
    onPreAuthOnboarding(renderer);
    alertSpy.mockRestore();
    unmount(renderer);
  });

  it('"Back" past step one returns to the previous question — it never leaves the questionnaire or reaches sign-in', async () => {
    const renderer = await renderReadyWelcome();
    press(renderer, 'Start your first read');
    act(() => renderer.root.findByType(TextInput).props.onChangeText('Dana'));
    press(renderer, 'Continue');
    expect(allText(renderer)).toContain('How do you identify?');
    expect(allText(renderer)).not.toMatch(/skip/i);
    const back = findPressable(renderer, 'Back');
    expect(back.props.accessibilityHint).toBe(
      'Return to the previous question',
    );

    press(renderer, 'Back');
    // Back on step one again — still inside the flow, name preserved.
    onPreAuthOnboarding(renderer);
    expect(renderer.root.findByType(TextInput).props.value).toBe('Dana');
    expect(mockCompletePreAuthOnboarding).not.toHaveBeenCalled();
    unmount(renderer);
  });

  it('"Not now" -> completePreAuthOnboarding ok -> onFinished: hands off to sign-in', async () => {
    const renderer = await renderReadyWelcome();
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
    const renderer = await renderReadyWelcome();
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
    const renderer = await renderReadyWelcome();
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
    // A returning player who never finished setup signs in via the explicit
    // link — and still lands in the (in-account) questionnaire afterwards.
    const renderer = await renderReadyWelcome();
    press(renderer, 'I already have an account');
    onSignIn(renderer);

    hydrateAppAs(CANONICAL_OWNER);
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
    // Account mode: the only exit besides finishing is signing out; there is
    // no Back to Welcome (there is no Welcome to go back to) and no skip.
    expect(findPressable(renderer, 'Leave setup').props.accessibilityHint).toBe(
      'Sign out and return to the sign-in screen',
    );
    expect(pressableCount(renderer, 'Back')).toBe(0);
    expect(allText(renderer)).not.toMatch(/skip/i);
    expect(markers(renderer, 'RootNavigator')).toHaveLength(0);
    expect(mockMaybeShowFirstRun).not.toHaveBeenCalled();
    unmount(renderer);
  });

  it('canonical session without a profile whose hydrate failed: shows the retry state instead of re-asking the questionnaire', async () => {
    const renderer = await renderReadyWelcome();
    mockHydrateApp.mockImplementation(async () => {
      useAppStore.setState({
        hydrated: true,
        ownerKey: CANONICAL_OWNER,
        profile: null,
        hydrateError:
          'Pickle Sensei could not reach your account to load your coaching profile. Check your connection and try again.',
      });
    });
    await act(async () => {
      useAuthStore.setState({ session: googleSession });
    });
    expect(mockHydrateApp).toHaveBeenCalledTimes(2);
    expect(allText(renderer)).toContain('Your coaching profile couldn’t load');
    expect(allText(renderer)).not.toContain('What should we call you?');
    expect(markers(renderer, 'RootNavigator')).toHaveLength(0);

    // "Try again" -> hydrateApp: a successful re-hydrate lands in the
    // in-account questionnaire.
    hydrateAppAs(CANONICAL_OWNER);
    const retry = findPressable(renderer, 'Try again');
    await act(async () => {
      retry.props.onPress();
    });
    expect(mockHydrateApp).toHaveBeenCalledTimes(3);
    expect(allText(renderer)).toContain('What should we call you?');
    unmount(renderer);
  });

  it('session + profile: mounts RootNavigator and raises the first-run walkthrough exactly once', async () => {
    const renderer = await renderReadyWelcome();
    hydrateAppAs(CANONICAL_OWNER, onboardedProfile);
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
    hydrateAppAs(SIGNED_OUT_DATA_OWNER);
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
    hydrateAppAs(GUEST_DATA_OWNER);
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
