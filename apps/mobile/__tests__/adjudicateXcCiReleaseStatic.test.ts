/**
 * Adjudication reproductions for area `xc-ci-release-static` (mobile plane).
 *
 * Each case asserts the CONTRACT (AGENTS.md "Auth sessions": closing the app
 * must never sign the user out; the one implicit sign-out is the server
 * refusing the refresh token). Cases that fail on 4d812e1a are the confirmed
 * findings; the `documents` case passes and pins the mobile half of the
 * Auth-outage → 401 → permanent sign-out chain (the edge half lives in
 * supabase/functions/api/__wf__/adjudicate_xc_ci_release_static.test.ts).
 */
import { NativeModules } from 'react-native';
import type { LocalDb } from '../src/data/db';
import { useAuthStore } from '../src/auth/authStore';
import { clearApiSession } from '../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../src/account/sessionVault';
import { stopSessionKeeper } from '../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { clearSyncRuntime } from '../src/data/syncRuntime';
import * as Keychain from 'react-native-keychain';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// ─── Module seams ────────────────────────────────────────────────────────────

const mockKv = new Map<string, string>();
let mockDbFault: Error | null = null;
function mockCurrentDb(): LocalDb {
  if (mockDbFault) throw mockDbFault;
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

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn().mockResolvedValue(true),
    signIn: jest.fn(),
    signInSilently: jest
      .fn()
      .mockResolvedValue({ type: 'noSavedCredentialFound', data: null }),
    hasPreviousSignIn: jest.fn().mockReturnValue(false),
    signOut: jest.fn().mockResolvedValue(null),
    revokeAccess: jest.fn().mockResolvedValue(null),
  },
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

const healthyRefresh = () =>
  response({
    session: {
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      expiresAt: FAR_FUTURE_SECONDS,
    },
  });

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.restoreAllMocks();
  mockKv.clear();
  mockDbFault = null;
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

describe('xc-ci-release-static adjudication — hydrate() vs local-storage faults', () => {
  it('SQ-01 SQLite failing to open at launch must not sign out a device holding a valid Keychain session', async () => {
    seedVault('refresh-durable');
    mockDbFault = new Error('SQLITE_CANTOPEN: unable to open database file');
    const fetchMock = installRoutes({ '/v1/auth/refresh': healthyRefresh });

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    // Observed on 4d812e1a: session=null, refresh never attempted — the
    // getDb() throw lands in hydrate()'s outer catch BEFORE the vault is read.
    expect(fetchMock).toHaveBeenCalled();
    expect(state.session).toMatchObject({ canonicalAppUserId: canonicalId });
  });

  it('KC-01 a rejecting Keychain read at launch must not land signed-out with a valid record still stored', async () => {
    seedVault('refresh-durable');
    jest
      .spyOn(Keychain, 'getGenericPassword')
      .mockRejectedValue(new Error('errSecInteractionNotAllowed (-25308)'));
    installRoutes({ '/v1/auth/refresh': healthyRefresh });

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    // Observed on 4d812e1a: hydrated=true, session=null, error=null while
    // the record is intact — loadPersistedSession() folds a read ERROR into
    // "nothing stored".
    const landedSignedOutSilently =
      state.hydrated && state.session === null && state.error === null;
    expect(landedSignedOutSilently).toBe(false);
  });

  it('KC-03 a failed Keychain write during sign-in must not be reported as a durable success', async () => {
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValue(new Error('errSecIO (-36)'));
    installRoutes({
      '/v1/account/bootstrap': () =>
        response({
          user: { id: canonicalId, email: 'pat@example.com' },
          onboardingState: 'complete',
          session: {
            accessToken: 'access-1',
            refreshToken: 'refresh-1',
            expiresAt: FAR_FUTURE_SECONDS,
          },
        }),
    });

    await useAuthStore.getState().signInWithApple();

    const state = useAuthStore.getState();
    expect(state.session).toMatchObject({ canonicalAppUserId: canonicalId });
    // Observed on 4d812e1a: error=null and no vault record — the boolean from
    // savePersistedSession() is discarded, so the next launch is signed out
    // with no warning to the user or telemetry.
    const persisted = __keychainStore.has(SESSION_VAULT_SERVICE);
    expect(persisted || state.error !== null).toBe(true);
  });

  it('documents: a 401 from /v1/auth/refresh clears the Keychain record for good (mobile half of the Auth-outage chain; contract-correct here, the defect is the edge fn answering 401 for transient Auth failures)', async () => {
    seedVault('refresh-durable');
    installRoutes({
      '/v1/auth/refresh': () =>
        response(
          {
            error: {
              message: 'The session could not be refreshed. Sign in again.',
            },
          },
          401,
        ),
    });

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
  });
});
