import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PermissionState } from '../../src/notifications/service';
import type { Profile } from '../../src/state/profile';

/**
 * Drives the real App.tsx Gate the way a user does: launch → Welcome →
 * pre-auth questionnaire → notification choice → sign-in → first owner →
 * main app. The appStore and notificationStore are REAL (in-memory kv, fake
 * OS scheduler); heavy leaves (RootNavigator, SignInScreen, overlays, splash
 * artwork) are replaced by minimal stand-ins that expose the same handlers.
 *
 * Pins the AGENTS.md launch invariants (product decision 2026-09-01): order
 * Welcome → onboarding → sign-in; "Start your first read" ALWAYS enters the
 * questionnaire (no device-level "already onboarded" marker, no skip to
 * sign-in — step one's Back returns to Welcome); single-use stash adoption
 * by the first writable owner, the freshly answered stash REPLACING any
 * profile that owner already had (newest intent wins); and the pending
 * notification choice adoption.
 */

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
jest.mock('../../src/data/db', () => ({
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

interface MockSession {
  provider: 'guest' | 'apple';
  subject: string;
  canonicalAppUserId: string | null;
  localOnly: boolean;
  displayName: string | null;
  email: string | null;
}
interface MockAuthState {
  hydrated: boolean;
  session: MockSession | null;
  hydrate: () => Promise<void>;
  continueAsGuest: () => Promise<void>;
  signInCanonical: (id: string) => Promise<void>;
  signOut: () => Promise<void>;
}
// Auth: a minimal zustand store with the same shape the Gate reads
// (hydrated/session/hydrate) plus the two transitions the flow needs.
jest.mock('../../src/auth/authStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  const scope = jest.requireActual<
    typeof import('../../src/data/accountScope')
  >('../../src/data/accountScope');
  const useAuthStore = create<MockAuthState>(set => ({
    hydrated: false,
    session: null,
    hydrate: async () => {
      scope.setActiveDataOwner(scope.SIGNED_OUT_DATA_OWNER);
      set({ hydrated: true, session: null });
    },
    continueAsGuest: async () => {
      scope.setActiveDataOwner(scope.GUEST_DATA_OWNER);
      set({
        session: {
          provider: 'guest',
          subject: 'local-only',
          canonicalAppUserId: null,
          localOnly: true,
          displayName: null,
          email: null,
        },
      });
    },
    signInCanonical: async id => {
      scope.setActiveDataOwner(scope.canonicalDataOwner(id));
      set({
        session: {
          provider: 'apple',
          subject: 'apple-subject',
          canonicalAppUserId: id,
          localOnly: false,
          displayName: null,
          email: null,
        },
      });
    },
    signOut: async () => {
      scope.setActiveDataOwner(scope.SIGNED_OUT_DATA_OWNER);
      set({ session: null });
    },
  }));
  return { useAuthStore };
});

let mockApiSession: {
  apiBaseUrl: string;
  bearerToken: string;
  canonicalAppUserId: string;
  provider: 'apple';
} | null = null;
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockApiSession,
  useApiSessionStore: <T,>(
    selector: (state: { session: typeof mockApiSession }) => T,
  ): T => selector({ session: mockApiSession }),
}));

const mockFetchCanonical = jest.fn<Promise<Profile | null>, [unknown]>(
  async () => null,
);
const mockSaveCanonical = jest.fn<Promise<Profile>, [unknown, Profile]>(
  async (_session, profile) => profile,
);
jest.mock('../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: (session: unknown) =>
    mockFetchCanonical(session),
  saveCanonicalOnboardingProfile: (session: unknown, profile: Profile) =>
    mockSaveCanonical(session, profile),
}));

const mockScheduler = {
  permission: 'undetermined' as PermissionState,
  requestResult: 'granted' as PermissionState,
  requestCalls: 0,
  cancelAllCalls: 0,
  appliedPlans: [] as unknown[],
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  },
  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
    this.permission = this.requestResult;
    return this.requestResult;
  },
  async applyPlan(plan: unknown): Promise<void> {
    this.appliedPlans.push(plan);
  },
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
  },
  async openSystemSettings(): Promise<void> {},
};
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

// Leaves outside this flow's scope.
jest.mock('../../src/navigation/RootNavigator', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    RootNavigator: () => React.createElement(Text, null, 'ROOT_NAVIGATOR'),
  };
});
jest.mock('../../src/screens/SignInScreen', () => {
  const React = require('react');
  const { Pressable, Text, View } = require('react-native');
  const { useAuthStore } = jest.requireMock<{
    useAuthStore: {
      getState: () => {
        continueAsGuest: () => Promise<void>;
        signInCanonical: (id: string) => Promise<void>;
      };
    };
  }>('../../src/auth/authStore');
  return {
    SignInScreen: (props: { onBack?: () => void }) =>
      React.createElement(
        View,
        null,
        React.createElement(Text, null, 'SIGN_IN_SCREEN'),
        React.createElement(
          Pressable,
          { accessibilityLabel: 'Back', onPress: props.onBack },
          React.createElement(Text, null, 'Back'),
        ),
        React.createElement(
          Pressable,
          {
            accessibilityLabel: 'Continue as guest',
            onPress: () => void useAuthStore.getState().continueAsGuest(),
          },
          React.createElement(Text, null, 'Continue as guest'),
        ),
        React.createElement(
          Pressable,
          {
            accessibilityLabel: 'Sign in with Apple',
            onPress: () =>
              void useAuthStore
                .getState()
                .signInCanonical('33333333-3333-4333-8333-333333333333'),
          },
          React.createElement(Text, null, 'Sign in with Apple'),
        ),
      ),
  };
});
jest.mock('../../src/screens/SplashScreen', () => {
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
jest.mock('../../src/components/RankUpCelebration', () => ({
  RankUpCelebration: () => null,
}));
jest.mock('../../src/consistency/StreakCelebration', () => ({
  StreakCelebration: () => null,
}));
jest.mock('../../src/walkthrough/FirstRunWalkthrough', () => ({
  FirstRunWalkthrough: () => null,
}));
const mockMaybeShowFirstRun = jest.fn(async () => {});
jest.mock('../../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: () => mockMaybeShowFirstRun() };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

import App from '../../App';
import { useAuthStore } from '../../src/auth/authStore';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';

type Renderer = TestRenderer.ReactTestRenderer;

const CANONICAL_ID = '33333333-3333-4333-8333-333333333333';

const walkedProfile: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
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

function press(renderer: Renderer, label: string) {
  const nodes = pressables(renderer, label);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]!.props.disabled).toBeFalsy();
  act(() => {
    nodes[0]!.props.onPress();
  });
}

async function settle() {
  await act(async () => {});
  await act(async () => {});
}

let mounted: Renderer | null = null;

async function launch(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
  });
  await settle();
  mounted = renderer;
  return renderer;
}

function unmount() {
  const renderer = mounted;
  mounted = null;
  if (renderer) act(() => renderer.unmount());
}

async function pressAsync(renderer: Renderer, label: string) {
  press(renderer, label);
  await settle();
}

async function answerQuestionnaire(renderer: Renderer) {
  act(() => renderer.root.findByType(TextInput).props.onChangeText(' Dana '));
  await pressAsync(renderer, 'Continue');
  await pressAsync(renderer, 'Female');
  await pressAsync(renderer, 'Continue');
  await pressAsync(renderer, '3.5');
  await pressAsync(renderer, 'Continue');
  await pressAsync(renderer, 'Right-handed');
  await pressAsync(renderer, 'Continue');
  await pressAsync(renderer, 'Third-shot drops');
  await pressAsync(renderer, 'Continue');
  await pressAsync(renderer, 'Control');
  await pressAsync(renderer, 'Continue');
  expect(allText(renderer)).toContain('YOUR STARTING PLAN');
  await pressAsync(renderer, 'Continue');
  expect(allText(renderer)).toContain('Stay match-ready.');
}

function expectWelcome(renderer: Renderer) {
  const text = allText(renderer);
  expect(text).toContain('See the stroke.');
  expect(pressables(renderer, 'Start your first read')).toHaveLength(1);
  expect(pressables(renderer, 'I already have an account')).toHaveLength(1);
  expect(text).not.toContain('SIGN_IN_SCREEN');
  expect(text).not.toContain('PLAYER SETUP');
}

/** Step one of the pre-auth questionnaire: Back to Welcome, no skip. */
function expectQuestionnaireStepOne(renderer: Renderer) {
  const text = allText(renderer);
  expect(text).toContain('PLAYER SETUP');
  expect(text).toContain('What should we call you?');
  expect(text).not.toContain('SIGN_IN_SCREEN');
  expect(text).not.toMatch(/skip/i);
  expect(pressables(renderer, 'Leave setup')).toHaveLength(0);
  const back = pressables(renderer, 'Back');
  expect(back).toHaveLength(1);
  expect(back[0]!.props.accessibilityHint).toBe('Return to the welcome screen');
}

describe('flow: launch-onboarding — App Gate end-to-end', () => {
  beforeEach(() => {
    mockKv.clear();
    mockApiSession = null;
    mockFetchCanonical.mockReset();
    mockFetchCanonical.mockResolvedValue(null);
    mockSaveCanonical.mockReset();
    mockSaveCanonical.mockImplementation(async (_s, profile) => profile);
    mockMaybeShowFirstRun.mockClear();
    mockScheduler.permission = 'undetermined';
    mockScheduler.requestResult = 'granted';
    mockScheduler.requestCalls = 0;
    mockScheduler.cancelAllCalls = 0;
    mockScheduler.appliedPlans = [];
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    useAuthStore.setState({ hydrated: false, session: null });
    useAppStore.setState({
      hydrated: false,
      ownerKey: null,
      profile: null,
      hydrateError: null,
      onboardingBusy: false,
      onboardingError: null,
    });
    useNotificationStore.setState({
      hydrated: false,
      ownerKey: null,
      prefs: { ...DEFAULT_NOTIFICATION_PREFS },
      permission: 'unknown',
    });
  });

  afterEach(() => {
    unmount();
  });

  it('fresh device: Welcome → questionnaire → "Not now" → sign-in → guest adopts the stash and lands in the app', async () => {
    const renderer = await launch();
    // Splash cleared once hydration finished; Welcome is the first screen.
    expect(allText(renderer)).not.toContain('SPLASH');
    expectWelcome(renderer);
    // A signed-out process cancels app-owned reminders.
    expect(mockScheduler.cancelAllCalls).toBeGreaterThan(0);

    await pressAsync(renderer, 'Start your first read');
    expectQuestionnaireStepOne(renderer);

    await answerQuestionnaire(renderer);
    expect(mockScheduler.requestCalls).toBe(0);
    await pressAsync(renderer, 'Not now');

    // "Not now" never asked the OS; the answers and the reminder choice wait
    // in their stashes — and those two keys are the ONLY device writes (no
    // "device onboarded" marker exists any more); the flow moved on to
    // sign-in.
    expect(mockScheduler.requestCalls).toBe(0);
    expect(JSON.parse(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)!)).toEqual({
      version: 1,
      profile: walkedProfile,
    });
    expect(
      JSON.parse(mockKv.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)!),
    ).toEqual({ version: 1, enabled: false });
    expect([...mockKv.keys()].sort()).toEqual(
      [
        PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
        PENDING_ONBOARDING_PROFILE_KV_KEY,
      ].sort(),
    );
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    expect(allText(renderer)).not.toContain('PLAYER SETUP');

    // Sign-in Back returns to Welcome. Even with the answers stashed, the
    // primary CTA re-enters the questionnaire — the gate never consults
    // device history — and step one's Back returns to Welcome leaving the
    // stash untouched. Sign-in is reached through the explicit link.
    await pressAsync(renderer, 'Back');
    expectWelcome(renderer);
    await pressAsync(renderer, 'Start your first read');
    expectQuestionnaireStepOne(renderer);
    await pressAsync(renderer, 'Back');
    expectWelcome(renderer);
    expect(JSON.parse(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)!)).toEqual({
      version: 1,
      profile: walkedProfile,
    });
    await pressAsync(renderer, 'I already have an account');
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');

    await pressAsync(renderer, 'Continue as guest');
    expect(getActiveDataOwner()).toBe(GUEST_DATA_OWNER);
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    expect(allText(renderer)).not.toContain('PLAYER SETUP');
    expect(useAppStore.getState().profile).toEqual(walkedProfile);
    expect(useAppStore.getState().ownerKey).toBe(GUEST_DATA_OWNER);
    expect(JSON.parse(mockKv.get(`profile:${GUEST_DATA_OWNER}`)!)).toEqual(
      walkedProfile,
    );
    // Stash is single-use.
    expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
    expect(mockKv.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)).toBe('');
    // The pending notification choice became the owner's prefs.
    const prefs = useNotificationStore.getState().prefs;
    expect(useNotificationStore.getState().ownerKey).toBe(GUEST_DATA_OWNER);
    expect(prefs.enabled).toBe(false);
    expect(prefs.promptDismissed).toBe(true);
    expect(mockScheduler.appliedPlans).toEqual([]);
    expect(mockMaybeShowFirstRun).toHaveBeenCalled();
    unmount();
  });

  it('fresh device: "Turn on reminders" asks the OS once and the guest owner inherits enabled prefs and a schedule', async () => {
    const renderer = await launch();
    await pressAsync(renderer, 'Start your first read');
    await answerQuestionnaire(renderer);
    await pressAsync(renderer, 'Turn on reminders');
    expect(mockScheduler.requestCalls).toBe(1);
    expect(
      JSON.parse(mockKv.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)!),
    ).toEqual({ version: 1, enabled: true });
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');

    await pressAsync(renderer, 'Continue as guest');
    await settle();
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    expect(mockScheduler.requestCalls).toBe(1);
    const prefs = useNotificationStore.getState().prefs;
    expect(prefs.enabled).toBe(true);
    expect(prefs.promptDismissed).toBe(true);
    expect(useNotificationStore.getState().permission).toBe('granted');
    expect(mockScheduler.appliedPlans.length).toBeGreaterThan(0);
    unmount();
  });

  // The device-level "already onboarded" marker (`onboarding.device-complete`)
  // that used to short-circuit "Start your first read" to sign-in was removed
  // 2026-09-01: the primary CTA takes no device-history input.
  it('returning player (no stash): "Start your first read" still enters the questionnaire; only "I already have an account" reaches sign-in, and a guest with no profile lands in the in-account questionnaire', async () => {
    const renderer = await launch();
    expectWelcome(renderer);
    expect(useAppStore.getState()).not.toHaveProperty('preAuthOnboarded');

    await pressAsync(renderer, 'Start your first read');
    expectQuestionnaireStepOne(renderer);
    await pressAsync(renderer, 'Back');
    expectWelcome(renderer);
    await pressAsync(renderer, 'I already have an account');
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    expect(allText(renderer)).not.toContain('PLAYER SETUP');

    // Guest with no stash and no profile → in-account questionnaire, never a
    // blank screen or the tab bar without a profile.
    await pressAsync(renderer, 'Continue as guest');
    expect(allText(renderer)).toContain('PLAYER SETUP');
    expect(allText(renderer)).not.toContain('ROOT_NAVIGATOR');
    // In-account mode: the only exit is signing out — no Back to Welcome.
    expect(pressables(renderer, 'Back')).toHaveLength(0);
    expect(pressables(renderer, 'Leave setup')).toHaveLength(1);
    unmount();
  });

  // The pre-auth "Leave setup → Skip to sign-in" alert was removed
  // 2026-09-01 (the questionnaire is required). Step one's control is a plain
  // Back to Welcome through stageWhenLeavingOnboarding().
  it('pre-auth step-one Back returns to Welcome without an alert or any write; Start re-enters the questionnaire and sign-in is never reached that way', async () => {
    const { Alert } =
      jest.requireActual<typeof import('react-native')>('react-native');
    const alertSpy = jest
      .spyOn(Alert, 'alert')
      .mockImplementation(() => undefined);
    const renderer = await launch();
    await pressAsync(renderer, 'Start your first read');
    expectQuestionnaireStepOne(renderer);
    await pressAsync(renderer, 'Back');
    expect(alertSpy).not.toHaveBeenCalled();
    expectWelcome(renderer);
    expect(allText(renderer)).not.toContain('SIGN_IN_SCREEN');
    expect(mockKv.size).toBe(0);

    await pressAsync(renderer, 'Start your first read');
    expectQuestionnaireStepOne(renderer);
    // Past step one, Back stays inside the questionnaire.
    act(() => renderer.root.findByType(TextInput).props.onChangeText('Dana'));
    await pressAsync(renderer, 'Continue');
    expect(allText(renderer)).toContain('How do you identify?');
    await pressAsync(renderer, 'Back');
    expectQuestionnaireStepOne(renderer);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockKv.size).toBe(0);
    alertSpy.mockRestore();
    unmount();
  });

  // Newest intent wins (2026-09-01): a freshly answered questionnaire is what
  // the player meant, so the stash REPLACES an existing profile on adoption
  // instead of being discarded in its favour.
  it('a freshly answered stash replaces an existing guest profile on adoption (newest intent wins) and is single-use', async () => {
    const existing: Profile = {
      skillLevel: '4.0',
      handedness: 'left',
      goal: 'serve',
      biggestProblem: 'power',
      focusCheckpoint: 'sequencing',
    };
    mockKv.set(`profile:${GUEST_DATA_OWNER}`, JSON.stringify(existing));
    mockKv.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: walkedProfile }),
    );
    const renderer = await launch();
    expectWelcome(renderer);
    // Signed out, the stash waits.
    expect(JSON.parse(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)!)).toEqual({
      version: 1,
      profile: walkedProfile,
    });
    await pressAsync(renderer, 'I already have an account');
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    await pressAsync(renderer, 'Continue as guest');
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    expect(useAppStore.getState().profile).toEqual(walkedProfile);
    expect(JSON.parse(mockKv.get(`profile:${GUEST_DATA_OWNER}`)!)).toEqual(
      walkedProfile,
    );
    expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    unmount();
  });

  it('a device that already held a guest profile: hydrate writes no device-level marker, and after sign-out Welcome → Start STILL enters the questionnaire', async () => {
    const existing: Profile = {
      skillLevel: '4.0',
      handedness: 'left',
      goal: 'serve',
      biggestProblem: 'power',
      focusCheckpoint: 'sequencing',
    };
    mockKv.set(`profile:${GUEST_DATA_OWNER}`, JSON.stringify(existing));
    const renderer = await launch();
    await pressAsync(renderer, 'I already have an account');
    await pressAsync(renderer, 'Continue as guest');
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    expect(useAppStore.getState().profile).toEqual(existing);
    // Hydrating an existing profile leaves no "this device onboarded"
    // history behind that a future gate could consult.
    expect([...mockKv.keys()]).toEqual([`profile:${GUEST_DATA_OWNER}`]);
    expect(useAppStore.getState()).not.toHaveProperty('preAuthOnboarded');

    await act(async () => {
      await useAuthStore.getState().signOut();
    });
    await settle();
    // The pre-auth stage is remembered: sign-out lands on sign-in, as the
    // in-account "Leave setup" copy promises.
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    expect(mockScheduler.cancelAllCalls).toBeGreaterThan(0);
    await pressAsync(renderer, 'Back');
    expectWelcome(renderer);
    // Same CTA, same path — the phone having held a profile changes nothing.
    await pressAsync(renderer, 'Start your first read');
    expectQuestionnaireStepOne(renderer);
    unmount();
  });

  describe('canonical (Apple) first sign-in', () => {
    beforeEach(() => {
      mockApiSession = {
        apiBaseUrl: 'https://api.example.test',
        bearerToken: 'token',
        canonicalAppUserId: CANONICAL_ID,
        provider: 'apple',
      };
    });

    // Newest intent wins (2026-09-01): the answers just given on this device
    // replace the account's existing server profile — saved through the
    // canonical endpoint like any onboarding completion.
    it('a freshly answered stash replaces the existing server profile through the canonical save; the stash is discarded', async () => {
      const server: Profile = {
        skillLevel: '4.5',
        handedness: 'right',
        goal: 'volleys',
        biggestProblem: 'contact',
        focusCheckpoint: 'face_wrist_stability',
      };
      mockFetchCanonical.mockResolvedValue(server);
      const renderer = await launch();
      await pressAsync(renderer, 'Start your first read');
      await answerQuestionnaire(renderer);
      await pressAsync(renderer, 'Not now');
      await pressAsync(renderer, 'Sign in with Apple');
      await settle();
      expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
      expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
      expect(mockSaveCanonical.mock.calls[0]?.[1]).toEqual(walkedProfile);
      expect(useAppStore.getState().profile).toEqual(walkedProfile);
      expect(JSON.parse(mockKv.get(`profile:${CANONICAL_ID}`)!)).toEqual(
        walkedProfile,
      );
      expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
      unmount();
    });

    it('when replacing the server profile fails, the account keeps its existing profile and the stash survives for the next hydrate', async () => {
      const server: Profile = {
        skillLevel: '4.5',
        handedness: 'right',
        goal: 'volleys',
        biggestProblem: 'contact',
        focusCheckpoint: 'face_wrist_stability',
      };
      mockFetchCanonical.mockResolvedValue(server);
      mockSaveCanonical.mockRejectedValue(new Error('offline'));
      const renderer = await launch();
      await pressAsync(renderer, 'Start your first read');
      await answerQuestionnaire(renderer);
      await pressAsync(renderer, 'Not now');
      await pressAsync(renderer, 'Sign in with Apple');
      await settle();
      // Nothing invented and nothing lost: the app opens on the old profile…
      expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
      expect(useAppStore.getState().profile).toEqual(server);
      expect(useAppStore.getState().hydrateError).toBeNull();
      // …and the answers wait for the next hydrate.
      expect(
        JSON.parse(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)!),
      ).toEqual({ version: 1, profile: walkedProfile });
      unmount();
    });

    it('no server profile: the stash is saved through the canonical endpoint and the server focus wins', async () => {
      mockFetchCanonical.mockResolvedValue(null);
      mockSaveCanonical.mockImplementation(async (_s, profile) => ({
        ...profile,
        focusCheckpoint: 'preparation',
      }));
      const renderer = await launch();
      await pressAsync(renderer, 'Start your first read');
      await answerQuestionnaire(renderer);
      await pressAsync(renderer, 'Not now');
      await pressAsync(renderer, 'Sign in with Apple');
      await settle();
      expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
      expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
      expect(mockSaveCanonical.mock.calls[0]?.[1]).toEqual(walkedProfile);
      expect(useAppStore.getState().profile).toEqual({
        ...walkedProfile,
        focusCheckpoint: 'preparation',
      });
      expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
      unmount();
    });

    it('while the canonical profile fetch is in flight after sign-in, the Gate paints a labelled loading state (never a bare surface)', async () => {
      let resolveFetch!: (value: Profile | null) => void;
      mockFetchCanonical.mockImplementation(
        () =>
          new Promise<Profile | null>(resolve => {
            resolveFetch = resolve;
          }),
      );
      const renderer = await launch();
      await pressAsync(renderer, 'Start your first read');
      await answerQuestionnaire(renderer);
      await pressAsync(renderer, 'Not now');
      expect(allText(renderer)).toContain('SIGN_IN_SCREEN');

      await pressAsync(renderer, 'Sign in with Apple');
      await settle();
      // The sign-in screen is gone and the splash already dismissed, so the
      // not-ready state must paint a real loading affordance until the
      // network round-trip finishes.
      expect(allText(renderer)).not.toContain('SIGN_IN_SCREEN');
      expect(allText(renderer)).not.toContain('ROOT_NAVIGATOR');
      expect(allText(renderer)).toContain('Loading your account');
      expect(
        renderer.root.findAll(
          n =>
            n.props.accessibilityLabel ===
            'Loading your account. Keep Pickle Sensei open.',
        ).length,
      ).toBeGreaterThan(0);
      expect(useAppStore.getState().hydrated).toBe(false);

      await act(async () => {
        resolveFetch(null);
      });
      await settle();
      expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
      unmount();
    });

    it('a failed canonical fetch (offline) shows a retryable error instead of re-asking the questionnaire; the stash survives and is adopted on retry', async () => {
      mockFetchCanonical.mockRejectedValueOnce(new Error('offline'));
      const renderer = await launch();
      await pressAsync(renderer, 'Start your first read');
      await answerQuestionnaire(renderer);
      await pressAsync(renderer, 'Not now');
      await pressAsync(renderer, 'Sign in with Apple');
      await settle();

      // The just-answered questionnaire is NOT shown again; the Gate explains
      // the failure and offers a retry.
      expect(allText(renderer)).toContain(
        'Your coaching profile couldn’t load',
      );
      expect(allText(renderer)).not.toContain('PLAYER SETUP');
      expect(allText(renderer)).not.toContain('ROOT_NAVIGATOR');
      expect(useAppStore.getState().hydrated).toBe(true);
      expect(useAppStore.getState().profile).toBeNull();
      expect(useAppStore.getState().hydrateError).toEqual(expect.any(String));
      expect(mockSaveCanonical).not.toHaveBeenCalled();
      expect(
        JSON.parse(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)!),
      ).toEqual({ version: 1, profile: walkedProfile });

      // Retry once the network is back: the stash is adopted through the
      // canonical endpoint and the app opens.
      mockFetchCanonical.mockResolvedValue(null);
      mockSaveCanonical.mockImplementation(async (_s, profile) => profile);
      await pressAsync(renderer, 'Try again');
      await settle();
      expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
      expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
      expect(mockSaveCanonical.mock.calls[0]?.[1]).toEqual(walkedProfile);
      expect(useAppStore.getState().profile).toEqual(walkedProfile);
      expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
      unmount();
    });
  });
});
