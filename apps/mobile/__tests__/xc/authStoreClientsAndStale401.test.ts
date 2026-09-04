/**
 * authStore ↔ long-lived clients contract (mutation-testing survivors AU-11,
 * AU-12, AU-16):
 *
 *  - the billing (access) and training clients configured at sign-in send
 *    the CURRENT bearer on each request: after a relaunch rotates the access
 *    token they carry the rotated one, without being reconfigured;
 *  - a 401 reported for a session that is NOT the signed-in account's never
 *    rotates or ends the signed-in account's session.
 *
 * Same module seams as __tests__/authDurableSession.test.ts, which is the
 * canonical pin for this contract (AGENTS.md → "Auth sessions"): its
 * "access-token rotation" and "a 401 for a session that is not the signed-in
 * account" cases kill AU-11/AU-12/AU-16 on their own, so the mutation matrix
 * holds with `--suites existing`. This replica is the attack-branch record.
 */
import { NativeModules } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import {
  bearerTokenFor,
  clearApiSession,
  establishApiSession,
  getApiSession,
  reportApiUnauthorized,
} from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import { useAccessStore } from '../../src/state/accessStore';
import { useTrainingStore } from '../../src/training/store';
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

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const otherCanonicalId = '11111111-1111-4111-8111-111111111111';
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

type Route = (init?: RequestInit) => Response | Promise<Response>;

function installRoutes(routes: Record<string, Route>): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(init);
    }
    throw new Error(`network down (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function bearerOf(init?: RequestInit): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers.Authorization ?? headers.authorization;
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
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
});

async function signInThenRelaunchWithRotation(): Promise<{
  accessCalls: jest.Mock;
  trainingCalls: jest.Mock;
}> {
  installRoutes({
    '/v1/account/bootstrap': () =>
      response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
  });
  await useAuthStore.getState().signInWithApple();
  expect(bearerTokenFor(canonicalId)).toBe('access-1');

  seedVault('refresh-1');
  const accessCalls = jest.fn((init?: RequestInit) => {
    void init;
    return response({}, 500);
  });
  const trainingCalls = jest.fn((init?: RequestInit) => {
    void init;
    return response({}, 500);
  });
  installRoutes({
    '/v1/auth/refresh': () =>
      response(refreshBody({ access: 'access-2', refresh: 'refresh-2' })),
    '/v1/me/access': accessCalls,
    '/v1/me/saved-drills': trainingCalls,
  });
  await useAuthStore.getState().hydrate();
  expect(bearerTokenFor(canonicalId)).toBe('access-2');
  return { accessCalls, trainingCalls };
}

describe('long-lived clients carry the CURRENT bearer on the wire', () => {
  it('the billing/access client sends the rotated access token after a relaunch refresh', async () => {
    const { accessCalls } = await signInThenRelaunchWithRotation();
    await useAccessStore.getState().refreshAccess();
    expect(accessCalls).toHaveBeenCalledTimes(1);
    expect(bearerOf(accessCalls.mock.calls[0][0])).toBe('Bearer access-2');
  });

  it('the training client sends the rotated access token after a relaunch refresh', async () => {
    const { trainingCalls } = await signInThenRelaunchWithRotation();
    await useTrainingStore.getState().loadSavedDrills();
    expect(trainingCalls).toHaveBeenCalledTimes(1);
    expect(bearerOf(trainingCalls.mock.calls[0][0])).toBe('Bearer access-2');
  });

  it('after an in-session rotation both clients follow the new bearer without a reconfigure', async () => {
    const accessCalls = jest.fn((init?: RequestInit) => {
      void init;
      return response({}, 500);
    });
    const trainingCalls = jest.fn((init?: RequestInit) => {
      void init;
      return response({}, 500);
    });
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/refresh': () =>
        response(refreshBody({ access: 'access-3', refresh: 'refresh-3' })),
      '/v1/me/access': accessCalls,
      '/v1/me/saved-drills': trainingCalls,
    });
    await useAuthStore.getState().signInWithApple();

    await useAccessStore.getState().refreshAccess();
    await useTrainingStore.getState().loadSavedDrills();
    expect(bearerOf(accessCalls.mock.calls[0]?.[0])).toBe('Bearer access-1');
    expect(bearerOf(trainingCalls.mock.calls[0]?.[0])).toBe('Bearer access-1');

    // A 401 for the current bearer → the keeper rotates it right now.
    reportApiUnauthorized('access-1');
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(getApiSession()?.bearerToken).toBe('access-3');
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );

    await useAccessStore.getState().refreshAccess();
    await useTrainingStore.getState().loadSavedDrills();
    expect(bearerOf(accessCalls.mock.calls[1]?.[0])).toBe('Bearer access-3');
    expect(bearerOf(trainingCalls.mock.calls[1]?.[0])).toBe('Bearer access-3');
  });
});

describe('a 401 for a session that is not the signed-in account', () => {
  it('is ignored: no refresh call, no sign-out, no error', async () => {
    const refreshCalls = jest.fn(() =>
      response(refreshBody({ access: 'access-9', refresh: 'refresh-9' })),
    );
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody({ access: 'access-1', refresh: 'refresh-1' })),
      '/v1/auth/refresh': refreshCalls,
    });
    await useAuthStore.getState().signInWithApple();
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );

    // A stale ApiSession for another account becomes current (e.g. a
    // late-landing bootstrap for the previous owner) and its bearer is
    // rejected by the API.
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'other-access',
      canonicalAppUserId: otherCanonicalId,
      provider: 'google',
      refreshToken: 'other-refresh',
      bearerExpiresAtMs: FAR_FUTURE_SECONDS * 1000,
    });
    reportApiUnauthorized('other-access');
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(refreshCalls).not.toHaveBeenCalled();
    const state = useAuthStore.getState();
    expect(state.session?.canonicalAppUserId).toBe(canonicalId);
    expect(state.error).toBeNull();
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);
  });
});
