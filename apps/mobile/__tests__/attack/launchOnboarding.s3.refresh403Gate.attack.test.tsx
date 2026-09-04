/**
 * ADVERSARIAL S3 — a valid Keychain session whose launch refresh is refused
 * (POST /v1/auth/refresh → 403) while a pre-auth stash is pending.
 *
 * Expected (AGENTS.md "Auth sessions" + "Launch flow"): the 401/403 refusal
 * is the ONE implicit sign-out — the Gate must land signed-out on Welcome,
 * the device stash must survive (it belongs to whoever signs in next), and
 * "Start your first read" must still enter the questionnaire.
 *
 * Runs the REAL App (Gate + real authStore/appStore/sessionKeeper) with the
 * heavy signed-in surfaces stubbed out.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';
import type { Profile } from '../../src/state/profile';
import * as Keychain from 'react-native-keychain';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

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

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPreviousSignIn: jest.fn(() => false),
    signInSilently: jest.fn(),
    signIn: jest.fn(),
    signOut: jest.fn(),
    revokeAccess: jest.fn(),
    hasPlayServices: jest.fn(),
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
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaProvider: (props: { children?: React.ReactNode }) =>
      ReactActual.createElement(View, null, props.children),
    SafeAreaView: (props: { children?: React.ReactNode; testID?: string }) =>
      ReactActual.createElement(View, { testID: props.testID }, props.children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

jest.mock('react-native-svg', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Defs: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    RadialGradient: Mock,
    LinearGradient: Mock,
    Rect: Mock,
    Stop: Mock,
  };
});

// Signed-in-only surfaces and global overlays: not under test here.
jest.mock('../../src/navigation/RootNavigator', () => {
  const ReactActual = require('react');
  const { Text: T } = require('react-native');
  return {
    RootNavigator: () => ReactActual.createElement(T, null, 'ROOT_NAVIGATOR'),
  };
});
jest.mock('../../src/screens/SignInScreen', () => {
  const ReactActual = require('react');
  const { Text: T } = require('react-native');
  return {
    SignInScreen: () => ReactActual.createElement(T, null, 'SIGN_IN_SCREEN'),
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
jest.mock('../../src/design/BrandNotice', () => ({
  BrandNoticeHost: () => null,
  showBrandNotice: () => {},
}));
jest.mock('../../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: async () => {} };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
const mockNotificationBootstrap = jest.fn();
jest.mock('../../src/notifications/useNotificationBootstrap', () => ({
  useNotificationBootstrap: (owner: string | null) =>
    mockNotificationBootstrap(owner),
}));
const mockConsistencyBootstrap = jest.fn();
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: (owner: string | null) =>
    mockConsistencyBootstrap(owner),
}));
jest.mock('../../src/analysis/stabilityTelemetry', () => ({
  UNASSIGNED_STABILITY_USER_KEY: 'unassigned',
  stabilitySlo: { setContext: () => {}, record: () => {} },
}));

import App from '../../App';
import { useAuthStore } from '../../src/auth/authStore';
import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';

const stashed: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function seedVault() {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider: 'apple',
      canonicalAppUserId: canonicalId,
      refreshToken: 'refresh-stale',
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join('|');
}

function findPressable(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const nodes = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
  expect(nodes.length).toBeGreaterThan(0);
  return nodes[0]!;
}

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
  }
}

const realFetch = globalThis.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  mockKv.clear();
  __keychainStore.clear();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
  fetchMock = jest.fn(async (url: string) => {
    if (url.endsWith('/v1/auth/refresh')) {
      return response({ error: { message: 'Sign in again.' } }, 403);
    }
    throw new Error(`network down (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  globalThis.fetch = realFetch;
});

describe('S3 launch with a persisted session refused by /v1/auth/refresh (403)', () => {
  it('lands signed-out on Welcome, keeps the pre-auth stash, and "Start your first read" still enters onboarding', async () => {
    seedVault();
    mockKv.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: stashed }),
    );
    // A stale legacy Google flag must not resurrect anything either.
    mockKv.set(
      'auth.last-provider',
      JSON.stringify({ version: 1, provider: 'google' }),
    );

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    await settle();

    const auth = useAuthStore.getState();
    const app = useAppStore.getState();
    const text = allText(renderer);
    console.log(
      JSON.stringify({
        scenario: 'S3',
        refreshCalls: fetchMock.mock.calls.filter((c: unknown[]) =>
          String(c[0]).endsWith('/v1/auth/refresh'),
        ).length,
        authHydrated: auth.hydrated,
        session: auth.session,
        authError: auth.error,
        owner: getActiveDataOwner(),
        apiSession: getApiSession(),
        vault: __keychainStore.has(SESSION_VAULT_SERVICE),
        appHydrated: app.hydrated,
        appOwnerKey: app.ownerKey,
        appProfile: app.profile,
        stash: mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY),
        lastProvider: mockKv.get('auth.last-provider'),
        screen: text.includes('See the stroke.')
          ? 'welcome'
          : text.includes('SIGN_IN_SCREEN')
            ? 'signin'
            : text.includes('ROOT_NAVIGATOR')
              ? 'app'
              : text.slice(0, 120),
      }),
    );

    // Signed out, vault cleared, no bearer, owner is the signed-out scope.
    expect(auth.hydrated).toBe(true);
    expect(auth.session).toBeNull();
    expect(auth.error).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
    expect(mockKv.get('auth.last-provider')).toBe('');
    // Exactly one refresh attempt — a refused token is never retried.
    expect(
      fetchMock.mock.calls.filter((c: unknown[]) =>
        String(c[0]).endsWith('/v1/auth/refresh'),
      ),
    ).toHaveLength(1);

    // App store hydrated for the signed-out owner with the stash intact.
    expect(app.hydrated).toBe(true);
    expect(app.ownerKey).toBe(SIGNED_OUT_DATA_OWNER);
    expect(app.profile).toBeNull();
    expect(
      JSON.parse(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY) ?? ''),
    ).toEqual({
      version: 1,
      profile: stashed,
    });

    // Gate content is Welcome (under the splash overlay), not sign-in.
    expect(text).toContain('See the stroke.');
    expect(text).not.toContain('SIGN_IN_SCREEN');
    expect(text).not.toContain('ROOT_NAVIGATOR');
    expect(text).not.toContain('Loading your account');

    // The primary CTA enters the questionnaire.
    const cta = findPressable(renderer, 'Start your first read');
    expect(cta.props.disabled).toBeFalsy();
    await act(async () => {
      cta.props.onPress();
    });
    const after = allText(renderer);
    expect(after).toContain('What should we call you?');
    expect(after).not.toContain('SIGN_IN_SCREEN');
    // The stash is untouched by merely entering onboarding.
    expect(
      JSON.parse(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY) ?? ''),
    ).toEqual({
      version: 1,
      profile: stashed,
    });

    // Step-one Back returns to Welcome (no skip to sign-in).
    const back = findPressable(renderer, 'Back');
    await act(async () => {
      back.props.onPress();
    });
    expect(allText(renderer)).toContain('See the stroke.');

    act(() => renderer.unmount());
  });

  it('a late 403 from a slow refresh still signs out cleanly after the Gate already rendered signed-in', async () => {
    seedVault();
    mockKv.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: stashed }),
    );
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/auth/refresh')) {
        await gate;
        return response({ error: { message: 'Sign in again.' } }, 403);
      }
      throw new Error(`network down (${url})`);
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    await settle(3);
    // While the refresh is in flight the user is signed in from the record
    // (auth not yet hydrated → Gate shows the loading affordance).
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(useAuthStore.getState().hydrated).toBe(false);
    expect(allText(renderer)).toContain('Loading your account');
    // The pending stash must NOT have been adopted by the (soon-dead) owner.
    expect(fetchMock.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
      'https://api.example.test/v1/auth/refresh',
    ]);

    release();
    await settle();

    const auth = useAuthStore.getState();
    const app = useAppStore.getState();
    console.log(
      JSON.stringify({
        scenario: 'S3-late-403',
        session: auth.session,
        owner: getActiveDataOwner(),
        appOwnerKey: app.ownerKey,
        appHydrated: app.hydrated,
        stash: mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY),
        profileKeys: [...mockKv.keys()].filter(k => k.startsWith('profile')),
      }),
    );
    expect(auth.session).toBeNull();
    expect(auth.hydrated).toBe(true);
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(app.ownerKey).toBe(SIGNED_OUT_DATA_OWNER);
    expect(app.hydrated).toBe(true);
    expect(
      JSON.parse(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY) ?? ''),
    ).toEqual({
      version: 1,
      profile: stashed,
    });
    // The dead owner never got the stash written into its profile slot.
    expect(mockKv.get(`profile:${canonicalId}`)).toBeUndefined();
    expect(allText(renderer)).toContain('See the stroke.');
    act(() => renderer.unmount());
  });
});
