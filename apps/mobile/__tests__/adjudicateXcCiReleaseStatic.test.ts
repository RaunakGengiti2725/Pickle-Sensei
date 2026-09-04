/**
 * Adjudication repro for cluster xc-ci-release-static (XC-RS-06).
 *
 *   cd apps/mobile && npx jest --ci __tests__/adjudicateXcCiReleaseStatic.test.ts -t 'SQ-01'
 *
 * SQ-01: the local SQLite database fails to open at launch (SQLITE_CANTOPEN)
 * while the Keychain still holds a valid durable session. Local preferences
 * (guest flag, legacy provider flag) live in SQLite kv; the durable session
 * lives in the Keychain. A storage fault unrelated to auth must never sign
 * the user out: hydrate() has to reach the vault, exchange the refresh token
 * through /v1/auth/refresh and land signed in.
 */
import { NativeModules } from 'react-native';
import { useAuthStore } from '../src/auth/authStore';
import { clearApiSession, getApiSession } from '../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../src/account/sessionVault';
import { stopSessionKeeper } from '../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { clearSyncRuntime } from '../src/data/syncRuntime';
import * as Keychain from 'react-native-keychain';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// ─── Module seams ────────────────────────────────────────────────────────────

const mockGetDb = jest.fn();
jest.mock('../src/data/db', () => ({ getDb: () => mockGetDb() }));

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

jest.mock('../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

jest.mock('../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
  }),
}));

jest.mock('../src/account/deviceContext', () => ({
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function sqliteCantOpen(): Error {
  const error = new Error(
    '[OP-SQLite] unable to open database file (SQLITE_CANTOPEN)',
  );
  (error as Error & { code: string }).code = 'SQLITE_CANTOPEN';
  return error;
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function installRoutes(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(init);
    }
    throw new Error(`network down (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function vaultRecord(): Record<string, unknown> | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

function seedVault(
  refreshToken: string,
  provider: 'apple' | 'google' = 'apple',
) {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider,
      canonicalAppUserId: canonicalId,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
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
  mockGetDb.mockImplementation(() => {
    throw sqliteCantOpen();
  });
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  nativeModules.PickleAuth = { signInWithApple: jest.fn() };
  installRoutes({});
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
});

describe('XC-RS-06 — SQLite failing to open must not sign out a Keychain session', () => {
  it('SQ-01: getDb() throws SQLITE_CANTOPEN at launch; hydrate() still restores the vault session through /v1/auth/refresh and lands signed in', async () => {
    seedVault('refresh-1', 'apple');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response({
          session: {
            accessToken: 'access-2',
            refreshToken: 'refresh-2',
            expiresAt: FAR_FUTURE_SECONDS,
          },
        }),
    });

    await useAuthStore.getState().hydrate();

    expect(mockGetDb).toHaveBeenCalled();
    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toEqual({
      provider: 'apple',
      subject: canonicalId,
      canonicalAppUserId: canonicalId,
      localOnly: false,
      displayName: 'Pat Player',
      email: 'pat@example.com',
    });
    expect(state.error).toBeNull();
    expect(getActiveDataOwner()).toBe(canonicalId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/auth/refresh',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ refreshToken: 'refresh-1' }),
      }),
    );
    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-2',
      refreshToken: 'refresh-2',
      canonicalAppUserId: canonicalId,
    });
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-2' });
    // The vault is authoritative; the legacy Google silent path is never
    // consulted, with or without readable local preferences.
    expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
  });

  it('SQ-01b: getDb() throws and the refresh cannot reach the server — still signed in from the record (offline launch semantics are unchanged)', async () => {
    seedVault('refresh-1', 'google');
    installRoutes({}); // dead network

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(state.error).toBeNull();
    expect(getActiveDataOwner()).toBe(canonicalId);
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });
  });

  it('SQ-01c: getDb() throws with no durable session — lands signed out without throwing (nothing to restore)', async () => {
    const fetchMock = installRoutes({});

    await expect(useAuthStore.getState().hydrate()).resolves.toBeUndefined();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
