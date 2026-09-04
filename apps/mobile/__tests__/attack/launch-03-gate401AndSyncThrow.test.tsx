import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { Profile } from '../../src/state/profile';

/**
 * ADVERSARIAL PASS (mobile-launch-onboarding, tester #2, pass 3).
 *
 * The REAL App.tsx Gate, REAL appStore and REAL `account/onboarding.ts` wire
 * client (over a mocked global fetch) — only heavy leaves are stand-ins.
 *
 *   S4  first canonical hydrate after sign-in answers 401 (stale bearer):
 *       Gate must show the retry state, must NOT sign the account out, and a
 *       refreshed session's retry must adopt the stash.
 *   S6  (real-store half) the first synchronous step of hydrate() — opening
 *       the database — throws before any await: the Gate must reach the
 *       error/retry state, not hang behind the splash.
 *   +   double-tap "Try again" interleaving, and the sign-out escape from the
 *       error state.
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
let mockGetDbFault: Error | null = null;
let mockGetDbCalls = 0;
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    mockGetDbCalls += 1;
    if (mockGetDbFault) throw mockGetDbFault;
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
  },
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
  signOutCalls: number;
  hydrate: () => Promise<void>;
  continueAsGuest: () => Promise<void>;
  signInCanonical: (id: string) => Promise<void>;
  signOut: () => Promise<void>;
}
jest.mock('../../src/auth/authStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  const scope = jest.requireActual<
    typeof import('../../src/data/accountScope')
  >('../../src/data/accountScope');
  const useAuthStore = create<MockAuthState>((set, get) => ({
    hydrated: false,
    session: null,
    signOutCalls: 0,
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
      set({ session: null, signOutCalls: get().signOutCalls + 1 });
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

jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => ({
    async permissionState() {
      return 'undetermined';
    },
    async requestPermission() {
      return 'granted';
    },
    async applyPlan() {},
    async cancelAllPlanned() {},
    async openSystemSettings() {},
  }),
}));

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
    SignInScreen: () =>
      React.createElement(
        View,
        null,
        React.createElement(Text, null, 'SIGN_IN_SCREEN'),
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
                .signInCanonical('66666666-6666-4666-8666-666666666666'),
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
jest.mock('../../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: async () => {} };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

import App from '../../App';
import { useAuthStore as useRealAuthStore } from '../../src/auth/authStore';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';

// The module is mocked above with a wider MockAuthState; retype the import.
const useAuthStore = useRealAuthStore as unknown as {
  getState: () => MockAuthState;
  setState: (patch: Partial<MockAuthState>) => void;
};

type Renderer = TestRenderer.ReactTestRenderer;

const CANONICAL_ID = '66666666-6666-4666-8666-666666666666';
const API = 'https://api.example.test';

const walkedProfile: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

interface Call {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}
const calls: Call[] = [];
type Responder = (call: Call) => Promise<Response>;
let responder: Responder = async () => json({}, 500);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      authorization: headers['Authorization'],
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

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

/** Walk the real pre-auth flow up to the sign-in screen. */
async function reachSignIn(): Promise<Renderer> {
  const renderer = await launch();
  await pressAsync(renderer, 'Start your first read');
  await answerQuestionnaire(renderer);
  await pressAsync(renderer, 'Not now');
  expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
  expect(JSON.parse(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)!)).toEqual({
    version: 1,
    profile: walkedProfile,
  });
  return renderer;
}

function armApiSession(bearer: string) {
  mockApiSession = {
    apiBaseUrl: API,
    bearerToken: bearer,
    canonicalAppUserId: CANONICAL_ID,
    provider: 'apple',
  };
}

beforeEach(() => {
  mockKv.clear();
  calls.length = 0;
  responder = async () => json({}, 500);
  mockApiSession = null;
  mockGetDbFault = null;
  mockGetDbCalls = 0;
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({ hydrated: false, session: null, signOutCalls: 0 });
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

describe('S4 — GET /v1/me → 401 on the first canonical hydrate after sign-in', () => {
  it('HELD: Gate shows the typed retry state (not the questionnaire, not the app), the session stays signed in, no PUT under the stale bearer, stash intact', async () => {
    const renderer = await reachSignIn();
    armApiSession('stale-bearer');
    responder = async () =>
      json(
        { error: { code: 'unauthorized', message: 'Bearer expired.' } },
        401,
      );

    await pressAsync(renderer, 'Sign in with Apple');
    await settle();

    const text = allText(renderer);
    expect(text).toContain('Your coaching profile couldn’t load');
    expect(text).toContain(CANONICAL_PROFILE_UNAVAILABLE_MESSAGE);
    expect(text).not.toContain('PLAYER SETUP');
    expect(text).not.toContain('ROOT_NAVIGATOR');
    expect(text).not.toContain('SIGN_IN_SCREEN');
    expect(text).not.toContain('Something went wrong');
    expect(pressables(renderer, 'Try again')).toHaveLength(1);

    // No implicit sign-out: session, owner and bearer all still in place.
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      CANONICAL_ID,
    );
    expect(useAuthStore.getState().signOutCalls).toBe(0);
    expect(getActiveDataOwner()).toBe(CANONICAL_ID);
    expect(useAppStore.getState().ownerKey).toBe(CANONICAL_ID);

    expect(calls).toEqual([
      expect.objectContaining({
        method: 'GET',
        url: `${API}/v1/me`,
        authorization: 'Bearer stale-bearer',
      }),
    ]);
    expect(JSON.parse(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)!)).toEqual({
      version: 1,
      profile: walkedProfile,
    });
    expect(mockKv.get(`profile:${CANONICAL_ID}`)).toBeUndefined();
  });

  it('HELD: the raw server error text never reaches the screen — only the typed copy', async () => {
    const renderer = await reachSignIn();
    armApiSession('stale-bearer');
    responder = async () =>
      json({ error: { message: 'JWT expired at 2026-09-04T11:00:00Z' } }, 401);
    await pressAsync(renderer, 'Sign in with Apple');
    await settle();
    expect(allText(renderer)).not.toContain('JWT');
    expect(allText(renderer)).toContain(CANONICAL_PROFILE_UNAVAILABLE_MESSAGE);
  });

  it('HELD: after the session refreshes, "Try again" sends the new bearer, adopts the stash through PUT and opens the app', async () => {
    const renderer = await reachSignIn();
    armApiSession('stale-bearer');
    responder = async () => json({ error: { message: 'expired' } }, 401);
    await pressAsync(renderer, 'Sign in with Apple');
    await settle();
    expect(allText(renderer)).toContain('Your coaching profile couldn’t load');

    // sessionKeeper rotates the bearer; the Gate is untouched by that.
    calls.length = 0;
    armApiSession('fresh-bearer');
    responder = async call =>
      call.method === 'GET'
        ? json({ onboardingState: 'pending', profile: null })
        : json({ recommendedCheckpoint: 'preparation', profile: {} });

    await pressAsync(renderer, 'Try again');
    await settle();

    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    expect(calls.map(c => [c.method, c.authorization])).toEqual([
      ['GET', 'Bearer fresh-bearer'],
      ['PUT', 'Bearer fresh-bearer'],
    ]);
    expect(calls[1]?.body).toEqual({
      skillLevel: '3.5',
      handedness: 'right',
      goal: 'drops',
      biggestProblem: 'control',
      firstName: 'Dana',
      gender: 'female',
    });
    expect(useAppStore.getState().profile).toEqual({
      ...walkedProfile,
      focusCheckpoint: 'preparation',
    });
    expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
    expect(useAuthStore.getState().signOutCalls).toBe(0);
  });

  it('HELD: "Try again" with the bearer STILL stale keeps the same typed retry state (no error-boundary, no questionnaire) — three times over', async () => {
    const renderer = await reachSignIn();
    armApiSession('stale-bearer');
    responder = async () => json({ error: { message: 'expired' } }, 401);
    await pressAsync(renderer, 'Sign in with Apple');
    await settle();
    for (let i = 0; i < 3; i += 1) {
      await pressAsync(renderer, 'Try again');
      await settle();
      const text = allText(renderer);
      expect(text).toContain('Your coaching profile couldn’t load');
      expect(text).not.toContain('Something went wrong');
      expect(text).not.toContain('PLAYER SETUP');
    }
    expect(calls).toHaveLength(4);
    expect(calls.every(c => c.method === 'GET')).toBe(true);
    expect(useAuthStore.getState().signOutCalls).toBe(0);
  });

  it('FINDING (minor): a rapid double-tap on "Try again" issues two overlapping hydrates → two GETs and two PUTs of the same stash', async () => {
    const renderer = await reachSignIn();
    armApiSession('stale-bearer');
    responder = async () => json({ error: { message: 'expired' } }, 401);
    await pressAsync(renderer, 'Sign in with Apple');
    await settle();

    calls.length = 0;
    armApiSession('fresh-bearer');
    responder = async call =>
      call.method === 'GET'
        ? json({ onboardingState: 'pending', profile: null })
        : json({ recommendedCheckpoint: 'preparation', profile: {} });
    const retry = pressables(renderer, 'Try again')[0]!;
    await act(async () => {
      retry.props.onPress();
      retry.props.onPress();
    });
    await settle();

    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    expect(calls.map(c => c.method).sort()).toEqual([
      'GET',
      'GET',
      'PUT',
      'PUT',
    ]);
  });

  it('HELD: from the error state, signing out (auth transition) clears the owner and returns to the sign-in stage with the stash preserved for the next owner', async () => {
    const renderer = await reachSignIn();
    armApiSession('stale-bearer');
    responder = async () => json({ error: { message: 'expired' } }, 401);
    await pressAsync(renderer, 'Sign in with Apple');
    await settle();
    expect(allText(renderer)).toContain('Your coaching profile couldn’t load');

    mockApiSession = null;
    await act(async () => {
      await useAuthStore.getState().signOut();
    });
    await settle();
    // The pre-auth stage was 'signin' when the account signed in, so the
    // signed-out Gate resumes there (not the error state, not the app).
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    expect(allText(renderer)).not.toContain(
      'Your coaching profile couldn’t load',
    );
    expect(useAppStore.getState().hydrateError).toBeNull();
    expect(useAppStore.getState().ownerKey).toBe(SIGNED_OUT_DATA_OWNER);
    expect(JSON.parse(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)!)).toEqual({
      version: 1,
      profile: walkedProfile,
    });
  });
});

describe('S6 (real store) — hydrate() fails synchronously at its first step', () => {
  it('HELD: getDb() throwing before any await lands the Gate in the retry state after the splash — never a hang, never the error boundary', async () => {
    mockGetDbFault = new Error('sqlite open failed: SQLITE_CANTOPEN');
    const renderer = await launch();
    // Splash cleared (ready = hydrated true for the signed-out owner).
    expect(allText(renderer)).not.toContain('SPLASH');
    expect(useAppStore.getState().hydrated).toBe(true);
    expect(useAppStore.getState().hydrateError).toBe(
      'sqlite open failed: SQLITE_CANTOPEN',
    );
    // Signed out: the Gate still lands on Welcome (the error state is only
    // rendered for a signed-in owner without a profile).
    expect(allText(renderer)).toContain('See the stroke.');
    expect(allText(renderer)).not.toContain('Something went wrong');
    expect(mockGetDbCalls).toBeGreaterThan(0);
  });

  it('FINDING (P3 copy): for a signed-in owner the raw driver message is rendered verbatim as the error detail', async () => {
    mockGetDbFault = new Error('sqlite open failed: SQLITE_CANTOPEN');
    const renderer = await launch();
    expect(allText(renderer)).toContain('See the stroke.');
    // The guest path skips the questionnaire stash (db is down) — go straight
    // to the sign-in screen and continue as guest.
    await pressAsync(renderer, 'I already have an account');
    await pressAsync(renderer, 'Continue as guest');
    await settle();
    const text = allText(renderer);
    expect(text).toContain('Your coaching profile couldn’t load');
    expect(text).toContain('sqlite open failed: SQLITE_CANTOPEN');
    expect(text).not.toContain('Something went wrong');
    expect(pressables(renderer, 'Try again')).toHaveLength(1);

    // Recovery: the database comes back → Try again → in-account onboarding
    // (guest, no profile yet).
    mockGetDbFault = null;
    await pressAsync(renderer, 'Try again');
    await settle();
    expect(allText(renderer)).toContain('PLAYER SETUP');
  });
});
