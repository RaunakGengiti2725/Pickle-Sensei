/**
 * Adversarial regression tests against candidate ff26c54a (XC-RS-06 fix).
 *
 *   cd apps/mobile && npx jest --ci __tests__/attackFixFf26c54aHydrate.test.ts
 *
 * The fix hoists the SQLite launch-preference reads (`readLaunchPrefs`) in
 * front of the Keychain restore so that a storage fault cannot sign the user
 * out. Doing so also freezes `auth.last-provider` BEFORE the restore runs —
 * but `dropRevokedSession()` clears that very flag when the server refuses
 * the refresh token, precisely so that the legacy Google silent path cannot
 * resurrect a revoked session ("an explicit sign-in is required to come
 * back", authStore.ts). On 4d812e1a the flag was read AFTER the restore and
 * therefore observed the cleared value; on ff26c54a hydrate() acts on the
 * stale pre-revocation value.
 */
import { NativeModules } from 'react-native';
import type { LocalDb } from '../src/data/db';
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
jest.mock('../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

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
  provider: 'apple' | 'google' = 'google',
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

/** The state of a device that signed in with Google on a build with the vault:
 * signInWithGoogle() writes BOTH the Keychain record and the legacy
 * `auth.last-provider` flag (authStore.ts signInWithGoogle →
 * persistLastProvider('google')). */
function seedGoogleDevice(refreshToken: string) {
  seedVault(refreshToken, 'google');
  mockKv.set(
    'auth.last-provider',
    JSON.stringify({ version: 1, provider: 'google' }),
  );
}

function googleSdkHoldsACredential() {
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(true);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'success',
    data: {
      idToken: 'google-id-token-still-cached-in-sdk',
      user: { name: 'Pat Player', email: 'pat@example.com' },
    },
  });
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
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

describe('ATTACK ff26c54a — a server-revoked session must not be resurrected by the legacy Google silent path', () => {
  it('RV-01: refresh refused (401) on a Google device → lands signed OUT; the Google SDK is never consulted and no new account is bootstrapped', async () => {
    seedGoogleDevice('refresh-revoked-elsewhere');
    googleSdkHoldsACredential();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response({ error: { message: 'Sign in again.' } }, 401),
      '/v1/account/bootstrap': () =>
        response(
          bootstrapBody({ access: 'access-new', refresh: 'refresh-new' }),
        ),
    });

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    // dropRevokedSession() did its part: the flag is cleared in SQLite …
    expect(mockKv.get('auth.last-provider')).toBe('');
    // … so the ONE implicit sign-out must actually stick.
    expect(mockGoogleSignin.hasPreviousSignIn).not.toHaveBeenCalled();
    expect(mockGoogleSignin.signInSilently).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/v1/account/bootstrap'),
      ),
    ).toHaveLength(0);
    expect(state.session).toBeNull();
    expect(getApiSession()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(vaultRecord()).toBeNull();
  });

  it('RV-02: refresh refused (403, account deleted from another device) → no silent re-registration through the cached Google credential', async () => {
    seedGoogleDevice('refresh-of-deleted-account');
    googleSdkHoldsACredential();
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response({ error: { message: 'Account is gone.' } }, 403),
      '/v1/account/bootstrap': () =>
        response(
          bootstrapBody({ access: 'access-new', refresh: 'refresh-new' }),
        ),
    });

    await useAuthStore.getState().hydrate();

    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/v1/account/bootstrap'),
      ),
    ).toHaveLength(0);
    expect(useAuthStore.getState().session).toBeNull();
    expect(vaultRecord()).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  });
});
