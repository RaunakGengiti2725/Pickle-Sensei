/**
 * AUDIT PROBE (structural pass 1, mobile-launch-onboarding) — end to end
 * through the REAL authStore + appStore, no ApiSession mock.
 *
 * Scenario: the user answered the pre-auth questionnaire, signed in (Apple),
 * and the app was killed before the stash was adopted — OR the same device
 * relaunches after a reinstall (Keychain record survives, SQLite gone) while
 * offline. authStore.hydrate() restores the Keychain session; the refresh
 * cannot reach the server, so the launch proceeds signed-in with
 * getApiSession() === null (pinned by authDurableSession.test.ts). The Gate
 * then runs appStore.hydrate() for the canonical owner.
 *
 * Invariant under test (AGENTS.md "Launch flow"): canonical accounts save the
 * stash through /v1/me/onboarding FIRST; a save that cannot happen keeps the
 * stash for the next hydrate.
 */
import type { LocalDb } from '../../src/data/db';
import type { Profile } from '../../src/state/profile';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import * as Keychain from 'react-native-keychain';
import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

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
    hasPlayServices: jest.fn(),
    signIn: jest.fn(),
    signInSilently: jest.fn(),
    hasPreviousSignIn: jest.fn(() => false),
    signOut: jest.fn(),
    revokeAccess: jest.fn(),
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

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';

const answers: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

function seedVault(refreshToken: string) {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider: 'apple',
      canonicalAppUserId: canonicalId,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
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
  });
  // Dead network: every request rejects.
  fetchMock = jest.fn(async (url: string) => {
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

describe('offline launch of a restored canonical session, with a pre-auth stash on disk', () => {
  it('keeps the stash for the next hydrate instead of adopting it locally without the canonical PUT', async () => {
    seedVault('refresh-1');
    mockKv.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: answers }),
    );

    // Launch: authStore restores the record; refresh fails (offline).
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getActiveDataOwner()).toBe(canonicalId);
    expect(getApiSession()).toBeNull(); // pre-condition (pinned elsewhere)

    // Gate: appStore.hydrate() for the canonical owner.
    await useAppStore.getState().hydrate();

    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.ownerKey).toBe(canonicalId);

    // No request reached /v1/me/onboarding (network is down and there is no
    // bearer) — so by the documented contract the stash MUST still be here
    // and no canonical profile row may exist.
    const onboardingPuts = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/me/onboarding'),
    );
    expect(onboardingPuts).toHaveLength(0);
    expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY) ?? '').not.toBe('');
    expect(mockKv.get(`profile:${canonicalId}`)).toBeUndefined();
  });
});
