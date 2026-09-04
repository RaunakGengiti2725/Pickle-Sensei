import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PermissionState } from '../src/notifications/service';
import type { Profile } from '../src/state/profile';

/**
 * Gate render pin for canonical profile truth: a signed-in (canonical)
 * account is NEVER shown the in-account questionnaire until a canonical
 * profile fetch has actually completed — whatever it returns.
 *
 * The scenario that used to break this: the session is restored from the
 * Keychain on a device with no local profile (fresh device, or a local wipe)
 * while the refresh cannot reach the server. authStore proceeds signed in
 * with no bearer; appStore.hydrate() then finds neither a local profile nor
 * an API session. That is "unknown", not "no profile" — the Gate shows a
 * retryable state, and the moment the bearer arrives the canonical profile is
 * fetched and the app opens without any owner change.
 *
 * appStore and apiSession are REAL here; the auth store is a minimal stand-in
 * that plays the "restored offline" launch.
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
jest.mock('../src/data/db', () => ({
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
  provider: 'apple';
  subject: string;
  canonicalAppUserId: string;
  localOnly: boolean;
  displayName: string | null;
  email: string | null;
}
interface MockAuthState {
  hydrated: boolean;
  session: MockSession | null;
  hydrate: () => Promise<void>;
}
// Restored-from-Keychain launch whose refresh has not answered: signed in,
// data owner set, NO api session.
jest.mock('../src/auth/authStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  const scope =
    jest.requireActual<typeof import('../src/data/accountScope')>(
      '../src/data/accountScope',
    );
  const useAuthStore = create<MockAuthState>(set => ({
    hydrated: false,
    session: null,
    hydrate: async () => {
      const id = '33333333-3333-4333-8333-333333333333';
      scope.setActiveDataOwner(scope.canonicalDataOwner(id));
      set({
        hydrated: true,
        session: {
          provider: 'apple',
          subject: id,
          canonicalAppUserId: id,
          localOnly: false,
          displayName: 'Pat Player',
          email: 'pat@example.com',
        },
      });
    },
  }));
  return { useAuthStore };
});

const mockFetchCanonical = jest.fn<Promise<Profile | null>, [unknown]>(
  async () => null,
);
jest.mock('../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: (session: unknown) =>
    mockFetchCanonical(session),
  saveCanonicalOnboardingProfile: jest.fn(),
}));

const mockScheduler = {
  async permissionState(): Promise<PermissionState> {
    return 'undetermined';
  },
  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  },
  async applyPlan(): Promise<void> {},
  async cancelAllPlanned(): Promise<void> {},
  async openSystemSettings(): Promise<void> {},
};
jest.mock('../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

jest.mock('../src/navigation/RootNavigator', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    RootNavigator: () => React.createElement(Text, null, 'ROOT_NAVIGATOR'),
  };
});
jest.mock('../src/screens/SignInScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    SignInScreen: () => React.createElement(Text, null, 'SIGN_IN_SCREEN'),
  };
});
jest.mock('../src/screens/SplashScreen', () => {
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
jest.mock('../src/components/RankUpCelebration', () => ({
  RankUpCelebration: () => null,
}));
jest.mock('../src/consistency/StreakCelebration', () => ({
  StreakCelebration: () => null,
}));
jest.mock('../src/walkthrough/FirstRunWalkthrough', () => ({
  FirstRunWalkthrough: () => null,
}));
jest.mock('../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: async () => {} };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

import App from '../App';
import { useAuthStore } from '../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
  type ApiSession,
} from '../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { useAppStore } from '../src/state/appStore';

type Renderer = TestRenderer.ReactTestRenderer;

const CANONICAL_ID = '33333333-3333-4333-8333-333333333333';
const canonicalSession: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'access-1',
  canonicalAppUserId: CANONICAL_ID,
  provider: 'apple',
};
const serverProfile: Profile = {
  firstName: 'Pat',
  gender: 'male',
  skillLevel: '4.0',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'preparation',
};

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string | number => typeof c !== 'object')
    .join('');
}

async function settle() {
  await act(async () => {});
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

/** The in-account questionnaire (OnboardingScreen mode='account'). */
function expectNoQuestionnaire(renderer: Renderer) {
  const text = allText(renderer);
  expect(text).not.toContain('PLAYER SETUP');
  expect(text).not.toContain('What should we call you?');
}

beforeEach(() => {
  mockKv.clear();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockFetchCanonical.mockReset();
  mockFetchCanonical.mockResolvedValue(null);
  useAuthStore.setState({ hydrated: false, session: null });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
});

afterEach(() => {
  unmount();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('Gate: a signed-in account never sees the questionnaire before canonical truth', () => {
  it('restored offline with no local profile: shows a retryable state, then opens the app once the bearer arrives and the server profile is fetched — no owner change', async () => {
    mockFetchCanonical.mockResolvedValue(serverProfile);
    const renderer = await launch();

    // Signed in, no bearer, nothing local: unknown ≠ "no profile".
    expectNoQuestionnaire(renderer);
    expect(allText(renderer)).not.toContain('ROOT_NAVIGATOR');
    expect(allText(renderer)).toContain('Your coaching profile couldn’t load');
    expect(mockFetchCanonical).not.toHaveBeenCalled();
    expect(useAppStore.getState().ownerKey).toBe(CANONICAL_ID);
    expect(useAppStore.getState().profile).toBeNull();

    // The keeper's refresh lands: the bearer exists for the same account.
    await act(async () => {
      establishApiSession(canonicalSession);
    });
    await settle();

    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expect(mockFetchCanonical).toHaveBeenCalledWith(canonicalSession);
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    expectNoQuestionnaire(renderer);
    expect(useAppStore.getState().ownerKey).toBe(CANONICAL_ID);
    expect(getActiveDataOwner()).toBe(CANONICAL_ID);
    expect(useAppStore.getState().profile).toEqual(serverProfile);
    expect(JSON.parse(mockKv.get(profileKeyForOwner(CANONICAL_ID))!)).toEqual(
      serverProfile,
    );
  });

  it('the questionnaire appears only AFTER the server has answered "no profile"', async () => {
    mockFetchCanonical.mockResolvedValue(null);
    const renderer = await launch();

    expectNoQuestionnaire(renderer);
    expect(allText(renderer)).not.toContain('ROOT_NAVIGATOR');

    await act(async () => {
      establishApiSession(canonicalSession);
    });
    await settle();

    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    // Now the account genuinely has no profile: the in-account setup is right.
    expect(allText(renderer)).toContain('PLAYER SETUP');
    expect(allText(renderer)).not.toContain('ROOT_NAVIGATOR');
    expect(useAppStore.getState().hydrateError).toBeNull();
  });

  it('while the canonical fetch is in flight, the Gate is loading — not the questionnaire', async () => {
    let resolveFetch!: (value: Profile | null) => void;
    mockFetchCanonical.mockImplementation(
      () =>
        new Promise<Profile | null>(resolve => {
          resolveFetch = resolve;
        }),
    );
    const renderer = await launch();
    expectNoQuestionnaire(renderer);

    await act(async () => {
      establishApiSession(canonicalSession);
    });
    await settle();
    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expectNoQuestionnaire(renderer);
    expect(allText(renderer)).toContain('Loading your account');

    await act(async () => {
      resolveFetch(serverProfile);
    });
    await settle();
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
  });

  it('Try again without a bearer stays honest (still no questionnaire) and the later bearer still resolves it', async () => {
    mockFetchCanonical.mockResolvedValue(serverProfile);
    const renderer = await launch();
    expect(allText(renderer)).toContain('Your coaching profile couldn’t load');

    const retry = renderer.root.findAll(
      node =>
        node.props?.accessibilityLabel === 'Try again' &&
        typeof node.props?.onPress === 'function',
    );
    expect(retry.length).toBeGreaterThan(0);
    await act(async () => {
      retry[0]!.props.onPress();
    });
    await settle();
    expectNoQuestionnaire(renderer);
    expect(allText(renderer)).toContain('Your coaching profile couldn’t load');
    expect(mockFetchCanonical).not.toHaveBeenCalled();

    await act(async () => {
      establishApiSession(canonicalSession);
    });
    await settle();
    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
  });
});
