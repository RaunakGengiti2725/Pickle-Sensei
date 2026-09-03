/**
 * sign-in-auth flow — token expiry characterization.
 *
 * The bearer the app sends on every authenticated request IS the provider
 * identity token captured at sign-in (bootstrap contract; the edge function
 * re-verifies it via Supabase signInWithIdToken once its ~10 min auth cache
 * lapses). Apple identity tokens expire minutes after issue and Apple offers
 * no silent re-exchange, so the first 401 must be honest: the request fails
 * with sign-in-expired copy, the auth layer is told, and the user lands
 * signed out with an explanatory reason instead of retrying a dead bearer.
 */
import type { LocalDb } from '../../src/data/db';

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
    legalPrivacyUrl: null,
    legalTermsUrl: null,
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

import { NativeModules } from 'react-native';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession, getApiSession } from '../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import { createCanonicalAccessClient } from '../../src/billing/accessApi';
import { BillingError } from '../../src/billing/types';
import { ApiError, createAnalysisPermitClient } from '../../src/data/api';
import { isPermanentSyncFailure } from '../../src/data/sync';

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const mockAppleSignIn = jest.fn();
const nativeModules = NativeModules as {
  PickleAuth?: { signInWithApple: jest.Mock };
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const realFetch = globalThis.fetch;

beforeEach(async () => {
  jest.clearAllMocks();
  mockKv.clear();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: true,
    session: null,
    busy: false,
    error: null,
  });
  nativeModules.PickleAuth = { signInWithApple: mockAppleSignIn };
  mockAppleSignIn.mockResolvedValue({
    user: 'apple-sub-001',
    identityToken: 'apple-identity-token-short-lived',
    email: null,
    givenName: 'Pat',
    familyName: 'Player',
  });
  globalThis.fetch = jest.fn().mockResolvedValue(
    response({
      user: { id: canonicalId, email: 'pat@example.com' },
      onboardingState: 'complete',
    }),
  ) as unknown as typeof fetch;
  await useAuthStore.getState().signInWithApple();
  expect(useAuthStore.getState().session?.provider).toBe('apple');
});

afterEach(() => {
  clearSyncRuntime();
  clearApiSession();
  globalThis.fetch = realFetch;
  delete nativeModules.PickleAuth;
});

const SESSION_EXPIRED_MESSAGE =
  'Your sign-in expired. Sign in again to keep syncing — everything on this phone is still here.';

async function settleUnauthorizedHandling(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe('sign-in-auth token expiry (Apple: no silent refresh, honest sign-out)', () => {
  it('the api session bearer is the raw provider identity token and the store exposes no interactive refresh action', () => {
    expect(getApiSession()).toMatchObject({
      bearerToken: 'apple-identity-token-short-lived',
      provider: 'apple',
      canonicalAppUserId: canonicalId,
    });
    const actions = Object.keys(useAuthStore.getState()).filter(
      key => typeof useAuthStore.getState()[key as never] === 'function',
    );
    expect(actions.sort()).toEqual(
      [
        'clearError',
        'completeAccountDeletion',
        'continueAsGuest',
        'hydrate',
        'signInWithApple',
        'signInWithGoogle',
        'signOut',
      ].sort(),
    );
  });

  it('a 401 on /v1/me/access is a non-retryable sign-in-expired error and the expired session is signed out with an honest reason', async () => {
    const api = getApiSession()!;
    const fetchFn = jest
      .fn()
      .mockResolvedValue(
        response(
          { error: { message: 'The identity token could not be verified.' } },
          401,
        ),
      );
    const client = createCanonicalAccessClient({
      baseUrl: api.apiBaseUrl,
      token: api.bearerToken,
      fetchFn,
    });

    let caught: unknown;
    try {
      await client.getAccess();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BillingError);
    const billing = caught as BillingError;
    expect(billing.code).toBe('billing.backend_unavailable');
    expect(billing.message).toBe(
      'Your sign-in has expired. Sign in again to check membership access.',
    );
    expect(billing.retryable).toBe(false);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.test/v1/me/access',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer apple-identity-token-short-lived',
        }),
      }),
    );
    // The auth layer observed the 401: Apple has no silent restore, so the
    // dead bearer is dropped and the user is told why instead of every later
    // call repeating the same failure.
    await settleUnauthorizedHandling();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().error).toEqual({
      code: 'auth.session_expired',
      message: SESSION_EXPIRED_MESSAGE,
    });
    expect(getApiSession()).toBeNull();
    expect(mockAppleSignIn).toHaveBeenCalledTimes(1);
  });

  it('a 401 for a bearer that is no longer the active session does not sign the current session out', async () => {
    const api = getApiSession()!;
    const fetchFn = jest
      .fn()
      .mockResolvedValue(
        response(
          { error: { message: 'The identity token could not be verified.' } },
          401,
        ),
      );
    const client = createCanonicalAccessClient({
      baseUrl: api.apiBaseUrl,
      token: 'stale-superseded-bearer',
      fetchFn,
    });
    await expect(client.getAccess()).rejects.toBeInstanceOf(BillingError);
    await settleUnauthorizedHandling();
    expect(useAuthStore.getState().session?.provider).toBe('apple');
    expect(useAuthStore.getState().error).toBeNull();
    expect(getApiSession()?.bearerToken).toBe(
      'apple-identity-token-short-lived',
    );
  });

  it('a 401 on permit reserve passes the raw server message through and also expires the session', async () => {
    const api = getApiSession()!;
    const fetchFn = jest
      .fn()
      .mockResolvedValue(
        response(
          { error: { message: 'The identity token could not be verified.' } },
          401,
        ),
      );
    globalThis.fetch = fetchFn as unknown as typeof fetch;
    const permits = createAnalysisPermitClient({
      baseUrl: api.apiBaseUrl,
      token: api.bearerToken,
    });

    let caught: unknown;
    try {
      await permits.reserve('11111111-1111-4111-8111-111111111111');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(401);
    expect(apiError.message).toBe('The identity token could not be verified.');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.test/v1/analysis-permits',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer apple-identity-token-short-lived',
        }),
      }),
    );
    await settleUnauthorizedHandling();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().error?.code).toBe('auth.session_expired');
    expect(getApiSession()).toBeNull();
  });

  it('the sync outbox treats a 401 as transient forever (never consumes the attempt budget)', () => {
    expect(
      isPermanentSyncFailure(
        new ApiError(
          401,
          'auth.required',
          'The identity token could not be verified.',
        ),
      ),
    ).toBe(false);
    expect(
      isPermanentSyncFailure(new ApiError(400, 'bad_request', 'nope')),
    ).toBe(true);
  });
});
