/**
 * Adjudication reproductions for the durable-session failure modes of
 * `src/auth/authStore.ts` + `src/account/sessionVault.ts`:
 *
 *  - a Keychain WRITE that fails is swallowed (sign-in and rotation alike);
 *  - a Keychain DELETE that fails is swallowed, so a signed-out account comes
 *    back on the next launch;
 *  - a local SQLite failure at hydrate lands signed out even though the
 *    Keychain record is intact and readable.
 *
 * Written as reproductions of the behaviour at 4d812e1a.
 */
import { NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import {
  SESSION_VAULT_SERVICE,
  loadPersistedSession,
} from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';

// ─── Controllable Keychain ───────────────────────────────────────────────────

const mockKeychainStore = new Map<
  string,
  { username: string; password: string }
>();
const mockKeychainFails = { save: false, load: false, clear: false };

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
      'AccessibleAfterFirstUnlockThisDeviceOnly',
  },
  setGenericPassword: jest.fn(
    async (
      username: string,
      password: string,
      options: { service: string },
    ) => {
      if (mockKeychainFails.save)
        throw new Error('errSecInteractionNotAllowed');
      mockKeychainStore.set(options.service, { username, password });
      return { service: options.service, storage: 'mock' };
    },
  ),
  getGenericPassword: jest.fn(async (options: { service: string }) => {
    if (mockKeychainFails.load) throw new Error('errSecInteractionNotAllowed');
    const item = mockKeychainStore.get(options.service);
    return item
      ? { ...item, service: options.service, storage: 'mock' }
      : false;
  }),
  resetGenericPassword: jest.fn(async (options: { service: string }) => {
    if (mockKeychainFails.clear) throw new Error('errSecInteractionNotAllowed');
    return mockKeychainStore.delete(options.service);
  }),
}));

// ─── Controllable local database ─────────────────────────────────────────────

const mockKv = new Map<string, string>();
const mockDbFails = { open: false };

function mockCurrentDb(): LocalDb {
  if (mockDbFails.open) throw new Error('database is locked');
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const bootstrapBody = (tokens: { access: string; refresh: string }) => ({
  user: { id: canonicalId, email: 'pat@example.com' },
  onboardingState: 'complete',
  session: {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: FAR_FUTURE_SECONDS,
  },
});

const refreshBody = (tokens: { access: string; refresh: string }) => ({
  session: {
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: FAR_FUTURE_SECONDS,
  },
});

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
  const item = mockKeychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

function seedVault(refreshToken: string) {
  mockKeychainStore.set(SESSION_VAULT_SERVICE, {
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

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  mockKeychainStore.clear();
  mockKeychainFails.save = false;
  mockKeychainFails.load = false;
  mockKeychainFails.clear = false;
  mockDbFails.open = false;
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
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signOut.mockResolvedValue(null);
  nativeModules.PickleAuth = {
    signInWithApple: jest.fn().mockResolvedValue({
      user: 'apple-user-opaque',
      identityToken: 'apple-identity-token',
      authorizationCode: 'one-use-apple-code',
      email: 'pat@privaterelay.example',
      givenName: 'Pat',
      familyName: 'Player',
    }),
  };
  installRoutes({});
});

afterEach(() => {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
});

// ─── Keychain WRITE failures ─────────────────────────────────────────────────

describe('a Keychain write that fails is swallowed', () => {
  it('sign-in reports success with nothing durable, so the next launch is signed out', async () => {
    mockKeychainFails.save = true;
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });

    await useAuthStore.getState().signInWithApple();

    const state = useAuthStore.getState();
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(state.error).toBeNull(); // no signal that the vault write failed
    expect(vaultRecord()).toBeNull();
    await expect(loadPersistedSession()).resolves.toBeNull();

    // Relaunch: the durable-session contract is silently broken.
    mockKeychainFails.save = false;
    stopSessionKeeper();
    clearApiSession();
    useAuthStore.setState({ hydrated: false, session: null });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
  });

  it('a rotation whose re-persist fails leaves the SPENT refresh token in the vault', async () => {
    seedVault('refresh-1');
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    mockKeychainFails.save = true;

    await useAuthStore.getState().hydrate();

    expect(getApiSession()).toMatchObject({
      bearerToken: 'access-2',
      refreshToken: 'refresh-2',
    });
    // The vault still holds refresh-1, which the server has already rotated
    // away — nothing retries the write and nothing tells the user.
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });

    // Next cold launch: the spent token is refused → implicit sign-out.
    mockKeychainFails.save = false;
    stopSessionKeeper();
    clearApiSession();
    useAuthStore.setState({ hydrated: false, session: null });
    installRoutes({
      '/v1/auth/refresh': init => {
        expect(String(init?.body)).toContain('refresh-1');
        return response({ error: { message: 'Sign in again.' } }, 401);
      },
    });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
  });
});

// ─── Keychain DELETE failures ────────────────────────────────────────────────

describe('a Keychain delete that fails is swallowed', () => {
  it('an offline sign-out brings the account back on the next launch', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
    });
    await useAuthStore.getState().signInWithApple();
    expect(vaultRecord()).not.toBeNull();

    mockKeychainFails.clear = true;
    installRoutes({}); // offline: the logout call cannot reach the server
    await expect(useAuthStore.getState().signOut()).resolves.toBeUndefined();
    expect(useAuthStore.getState().session).toBeNull();
    // The record the sign-out was supposed to destroy is still there.
    expect(vaultRecord()).toMatchObject({ refreshToken: 'refresh-1' });

    mockKeychainFails.clear = false;
    useAuthStore.setState({ hydrated: false, session: null });
    installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    await useAuthStore.getState().hydrate();

    // A signed-out account is signed back in, with a live bearer.
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    expect(getApiSession()?.bearerToken).toBe('access-2');
  });
});

// ─── Local database failure at hydrate ───────────────────────────────────────

describe('a local SQLite failure at hydrate', () => {
  it('lands signed out even though the Keychain record is intact', async () => {
    seedVault('refresh-1');
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    });
    mockDbFails.open = true;

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
    // The vault was never consulted: no refresh was attempted at all.
    expect(fetchMock).not.toHaveBeenCalled();
    mockDbFails.open = false;
    await expect(loadPersistedSession()).resolves.toMatchObject({
      refreshToken: 'refresh-1',
    });
  });
});
