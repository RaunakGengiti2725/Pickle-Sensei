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
 * Pins the AGENTS.md launch invariants: order Welcome → onboarding → sign-in,
 * device-once questionnaire (`onboarding.device-complete`), single-use stash
 * adoption by the first writable owner, existing local/server profile beats
 * the stash, and the pending notification choice adoption.
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
  DEVICE_ONBOARDED_KV_KEY,
  DEVICE_ONBOARDED_VALUE,
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
      preAuthOnboarded: false,
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
    expect(allText(renderer)).toContain('PLAYER SETUP');
    expect(allText(renderer)).toContain('What should we call you?');

    await answerQuestionnaire(renderer);
    expect(mockScheduler.requestCalls).toBe(0);
    await pressAsync(renderer, 'Not now');

    // "Not now" never asked the OS; the device is marked onboarded; the
    // answers wait in the stash; the flow moved on to sign-in.
    expect(mockScheduler.requestCalls).toBe(0);
    expect(mockKv.get(DEVICE_ONBOARDED_KV_KEY)).toBe(DEVICE_ONBOARDED_VALUE);
    expect(JSON.parse(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)!)).toEqual({
      version: 1,
      profile: walkedProfile,
    });
    expect(
      JSON.parse(mockKv.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)!),
    ).toEqual({ version: 1, enabled: false });
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    expect(allText(renderer)).not.toContain('PLAYER SETUP');

    // Sign-in Back returns to Welcome; Welcome now skips the questionnaire.
    await pressAsync(renderer, 'Back');
    expectWelcome(renderer);
    await pressAsync(renderer, 'Start your first read');
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

  it('returning device (device-complete marker, no stash): "Start your first read" goes straight to sign-in; "I already have an account" too', async () => {
    mockKv.set(DEVICE_ONBOARDED_KV_KEY, DEVICE_ONBOARDED_VALUE);
    const renderer = await launch();
    expectWelcome(renderer);
    expect(useAppStore.getState().preAuthOnboarded).toBe(true);

    await pressAsync(renderer, 'Start your first read');
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    expect(allText(renderer)).not.toContain('PLAYER SETUP');
    await pressAsync(renderer, 'Back');
    expectWelcome(renderer);
    await pressAsync(renderer, 'I already have an account');
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');

    // Guest with no stash and no profile → in-account questionnaire, never a
    // blank screen or the tab bar without a profile.
    await pressAsync(renderer, 'Continue as guest');
    expect(allText(renderer)).toContain('PLAYER SETUP');
    expect(allText(renderer)).not.toContain('ROOT_NAVIGATOR');
    unmount();
  });

  it('pre-auth "Leave setup → Skip to sign-in" reaches sign-in without marking the device onboarded; Back → Welcome → Start re-enters the questionnaire', async () => {
    const { Alert } =
      jest.requireActual<typeof import('react-native')>('react-native');
    const alertSpy = jest
      .spyOn(Alert, 'alert')
      .mockImplementation(() => undefined);
    const renderer = await launch();
    await pressAsync(renderer, 'Start your first read');
    expect(allText(renderer)).toContain('PLAYER SETUP');
    await pressAsync(renderer, 'Leave setup');
    const buttons = alertSpy.mock.calls[0]?.[2] ?? [];
    await act(async () => {
      buttons.find(b => b.text === 'Skip to sign-in')!.onPress?.();
    });
    await settle();
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    expect(mockKv.has(DEVICE_ONBOARDED_KV_KEY)).toBe(false);
    expect(useAppStore.getState().preAuthOnboarded).toBe(false);

    await pressAsync(renderer, 'Back');
    expectWelcome(renderer);
    await pressAsync(renderer, 'Start your first read');
    expect(allText(renderer)).toContain('PLAYER SETUP');
    alertSpy.mockRestore();
    unmount();
  });

  it('an existing guest profile always beats a stale stash, and the stash is discarded', async () => {
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
    mockKv.set(DEVICE_ONBOARDED_KV_KEY, DEVICE_ONBOARDED_VALUE);
    const renderer = await launch();
    expect(useAppStore.getState().preAuthOnboarded).toBe(true);
    await pressAsync(renderer, 'Start your first read');
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    await pressAsync(renderer, 'Continue as guest');
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    expect(useAppStore.getState().profile).toEqual(existing);
    expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
    unmount();
  });

  it('a legacy guest profile with no device marker backfills the marker on hydrate, so a later sign-out goes straight to sign-in', async () => {
    const existing: Profile = {
      skillLevel: '4.0',
      handedness: 'left',
      goal: 'serve',
      biggestProblem: 'power',
      focusCheckpoint: 'sequencing',
    };
    mockKv.set(`profile:${GUEST_DATA_OWNER}`, JSON.stringify(existing));
    const renderer = await launch();
    expect(useAppStore.getState().preAuthOnboarded).toBe(false);
    await pressAsync(renderer, 'I already have an account');
    await pressAsync(renderer, 'Continue as guest');
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    expect(mockKv.get(DEVICE_ONBOARDED_KV_KEY)).toBe(DEVICE_ONBOARDED_VALUE);
    expect(useAppStore.getState().preAuthOnboarded).toBe(true);

    // Sign out: the marker survives, so Welcome → Start skips the quiz.
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
    await pressAsync(renderer, 'Start your first read');
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    expect(allText(renderer)).not.toContain('PLAYER SETUP');
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

    it('server profile wins over the stash; the stash is discarded without a save', async () => {
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
      expect(useAppStore.getState().profile).toEqual(server);
      expect(mockSaveCanonical).not.toHaveBeenCalled();
      expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
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
