/**
 * W02-02 adversarial probe against candidate 7c06c0b6 at the shipping call
 * site of the owner switch: authStore. The candidate's notifyOwnerListeners()
 * commits the owner change, delivers it to every subscriber, then rethrows the
 * first subscriber failure to the caller. This file asks what the caller does
 * with that throw. The contract under test is the user-visible one: an
 * explicit sign-out clears the account, its Keychain record and its server
 * session; a sign-in installs exactly the new account. A faulty fence is a
 * programming error, but it must never leave the app half switched.
 */
import { NativeModules } from 'react-native';
import type { LocalDb } from '../src/data/db';
import { useAuthStore } from '../src/auth/authStore';
import {
  bearerTokenFor,
  clearApiSession,
  getApiSession,
} from '../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../src/account/sessionVault';
import { stopSessionKeeper } from '../src/account/sessionKeeper';
import { stopBillingLifecycle } from '../src/billing/lifecycle';
import { useAppStore } from '../src/state/appStore';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
  subscribeToDataOwner,
} from '../src/data/accountScope';
import { clearSyncRuntime } from '../src/data/syncRuntime';
import * as Keychain from 'react-native-keychain';

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

const OWNER_A = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const bootstrapBody = (
  owner: string,
  tokens: { access: string; refresh: string },
) => ({
  user: { id: owner, email: 'pat@example.com' },
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

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  __keychainStore.clear();
  stopBillingLifecycle();
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
    ownerContext: null,
    awaitingApiSession: false,
    profile: null,
    hydrateError: null,
  });
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signInSilently.mockResolvedValue({
    type: 'noSavedCredentialFound',
    data: null,
  });
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
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
  stopBillingLifecycle();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
});

describe('ATK-11 owner-change delivery failure at the shipping call sites', () => {
  it('explicit sign-out with one faulty fence still clears the account, the Keychain record and the server session', async () => {
    const fetchMock = installRoutes({
      '/v1/account/bootstrap': () =>
        response(
          bootstrapBody(OWNER_A, { access: 'access-a', refresh: 'refresh-a' }),
        ),
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().signInWithApple();
    expect(getActiveDataOwner()).toBe(OWNER_A);
    expect(vaultRecord()).not.toBeNull();

    const faulty = jest.fn(() => {
      throw new Error('fence failed');
    });
    const stop = subscribeToDataOwner(faulty);
    try {
      const signOut = useAuthStore.getState().signOut();
      const settled = await signOut.then(
        () => null,
        (error: unknown) => error,
      );
      expect(faulty).toHaveBeenCalledTimes(1);
      // The switch itself committed...
      expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
      expect(getApiSession()).toBeNull();
      expect(bearerTokenFor(OWNER_A)).toBeNull();
      // ...so the rest of sign-out must have completed too, whether or not
      // the fence failure is surfaced to the caller.
      expect({
        rejected: settled,
        session: useAuthStore.getState().session,
        vault: vaultRecord(),
        logoutCalls: fetchMock.mock.calls.filter(([url]) =>
          String(url).endsWith('/v1/auth/logout'),
        ).length,
      }).toEqual({
        rejected: settled,
        session: null,
        vault: null,
        logoutCalls: 1,
      });
    } finally {
      stop();
    }
  });

  it('a faulty fence left by account A cannot make a later launch restore A after the user signed out', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(
          bootstrapBody(OWNER_A, { access: 'access-a', refresh: 'refresh-a' }),
        ),
      '/v1/auth/logout': () => response(null, 204),
    });
    await useAuthStore.getState().signInWithApple();
    const stop = subscribeToDataOwner(() => {
      throw new Error('fence failed');
    });
    try {
      await useAuthStore
        .getState()
        .signOut()
        .catch(() => undefined);
    } finally {
      stop();
    }
    const vaultAfterSignOut = vaultRecord();

    // Relaunch: a refresh would only be attempted if the record survived.
    const fetchMock = installRoutes({
      '/v1/auth/refresh': () =>
        response({
          session: {
            accessToken: 'access-a2',
            refreshToken: 'refresh-a2',
            expiresAt: FAR_FUTURE_SECONDS,
          },
        }),
    });
    await useAuthStore.getState().hydrate();
    expect({
      vaultAfterSignOut,
      restoredOwner:
        useAuthStore.getState().session?.canonicalAppUserId ?? null,
      activeOwner: getActiveDataOwner(),
      bearer: bearerTokenFor(OWNER_A),
      refreshCalls: fetchMock.mock.calls.length,
    }).toEqual({
      vaultAfterSignOut: null,
      restoredOwner: null,
      activeOwner: SIGNED_OUT_DATA_OWNER,
      bearer: null,
      refreshCalls: 0,
    });
  });

  it('signing in as B over a still-registered faulty fence of A installs exactly B or leaves A intact — never a session without a bearer', async () => {
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(
          bootstrapBody(OWNER_A, { access: 'access-a', refresh: 'refresh-a' }),
        ),
    });
    await useAuthStore.getState().signInWithApple();
    expect(getActiveDataOwner()).toBe(OWNER_A);

    const faulty = jest.fn(() => {
      throw new Error('fence failed');
    });
    const stop = subscribeToDataOwner(faulty);
    try {
      installRoutes({
        '/v1/account/bootstrap': () =>
          response(
            bootstrapBody(OWNER_B, {
              access: 'access-b',
              refresh: 'refresh-b',
            }),
          ),
      });
      await useAuthStore
        .getState()
        .signInWithApple()
        .catch(() => undefined);
      expect(faulty).toHaveBeenCalled();
      const session = useAuthStore.getState().session;
      const observed = {
        sessionOwner: session?.canonicalAppUserId ?? null,
        activeOwner: getActiveDataOwner(),
        apiOwner: getApiSession()?.canonicalAppUserId ?? null,
        bearer: session?.canonicalAppUserId
          ? bearerTokenFor(session.canonicalAppUserId)
          : null,
        vaultOwner: vaultRecord()?.canonicalAppUserId ?? null,
      };
      const installedB = {
        sessionOwner: OWNER_B,
        activeOwner: OWNER_B,
        apiOwner: OWNER_B,
        bearer: 'access-b',
        vaultOwner: OWNER_B,
      };
      const keptA = {
        sessionOwner: OWNER_A,
        activeOwner: OWNER_A,
        apiOwner: OWNER_A,
        bearer: 'access-a',
        vaultOwner: OWNER_A,
      };
      const signedOut = {
        sessionOwner: null,
        activeOwner: SIGNED_OUT_DATA_OWNER,
        apiOwner: null,
        bearer: null,
        vaultOwner: null,
      };
      expect([installedB, keptA, signedOut]).toContainEqual(observed);
    } finally {
      stop();
    }
  });
});
