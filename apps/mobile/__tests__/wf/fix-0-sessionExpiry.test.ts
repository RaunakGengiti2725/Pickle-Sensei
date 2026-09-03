/**
 * Session-expiry plumbing and deletion cleanup honesty:
 *   - a 401 on any API call reports the EXACT bearer that failed, so a late
 *     response from an old token can never invalidate a newer session;
 *   - requests advertise the real app version, not a stale literal;
 *   - completeAccountDeletion() records whether the on-device purge actually
 *     succeeded (after retrying) instead of swallowing the failure.
 */
import {
  clearApiSession,
  establishApiSession,
  reportApiUnauthorized,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../../src/account/apiSession';
import { useAuthStore } from '../../src/auth/authStore';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import { ApiError, api } from '../../src/data/api';
import { getDb } from '../../src/data/db';
import { purgeOwnerData } from '../../src/data/repository';

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

jest.mock('../../src/data/repository', () => ({
  ...jest.requireActual('../../src/data/repository'),
  purgeOwnerData: jest.fn(),
}));

const session: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'token-current',
  canonicalAppUserId: '7fc2c743-028f-4ec6-942c-a84508f3be38',
  provider: 'apple',
};

afterEach(() => {
  setApiUnauthorizedListener(null);
  clearApiSession();
  delete (globalThis as { fetch?: unknown }).fetch;
  jest.clearAllMocks();
});

describe('bearer-aware unauthorized reporting', () => {
  it('notifies the listener only for the session that is still current', () => {
    const listener = jest.fn();
    establishApiSession(session);
    setApiUnauthorizedListener(listener);

    reportApiUnauthorized('token-old');
    expect(listener).not.toHaveBeenCalled();

    reportApiUnauthorized('token-current');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(session);
  });

  it('is silent when no session is established', () => {
    const listener = jest.fn();
    setApiUnauthorizedListener(listener);
    reportApiUnauthorized('token-current');
    expect(listener).not.toHaveBeenCalled();
  });

  it('a 401 from api.request reports the failing bearer and still throws a typed ApiError', async () => {
    const listener = jest.fn();
    establishApiSession(session);
    setApiUnauthorizedListener(listener);
    (globalThis as { fetch?: unknown }).fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'auth.expired', message: 'Token expired.' },
          }),
          { status: 401 },
        ),
    );

    const error = await api
      .request(
        { baseUrl: session.apiBaseUrl, token: 'token-current' },
        'GET',
        '/v1/me',
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(listener).toHaveBeenCalledWith(session);
  });

  it('a late 401 for a superseded bearer does not touch the newer session', async () => {
    const listener = jest.fn();
    establishApiSession(session);
    setApiUnauthorizedListener(listener);
    (globalThis as { fetch?: unknown }).fetch = jest.fn(
      async () => new Response('{}', { status: 401 }),
    );

    await expect(
      api.request(
        { baseUrl: session.apiBaseUrl, token: 'token-old' },
        'GET',
        '/v1/me',
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('x-client-version header', () => {
  it('sends the runtime app version', async () => {
    const fetchFn = jest.fn<Promise<Response>, [string, RequestInit]>(
      async () => new Response('{}', { status: 200 }),
    );
    (globalThis as { fetch?: unknown }).fetch = fetchFn;
    await api.request(
      { baseUrl: session.apiBaseUrl, token: 'token-current' },
      'GET',
      '/v1/me',
    );
    const init = fetchFn.mock.calls[0]![1];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-client-version']).toBe(
      getRuntimePublicConfig().appVersion,
    );
    expect(headers['x-client-version']).not.toBe('0.1.0');
  });
});

describe('completeAccountDeletion local purge reporting', () => {
  const signedIn = {
    provider: 'apple' as const,
    subject: 'apple-subject',
    canonicalAppUserId: session.canonicalAppUserId,
    localOnly: false,
    displayName: null,
    email: null,
  };

  beforeEach(() => {
    useAuthStore.setState({
      hydrated: true,
      session: signedIn,
      busy: false,
      error: null,
      deletionCleanup: null,
    });
    (getDb as jest.Mock).mockReturnValue({});
  });

  it('reports complete when the purge succeeds', async () => {
    (purgeOwnerData as jest.Mock).mockResolvedValue(undefined);
    await useAuthStore.getState().completeAccountDeletion();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'complete',
    });
    expect(purgeOwnerData).toHaveBeenCalledTimes(1);
  });

  it('retries a failing purge and reports failed once every attempt is spent', async () => {
    (purgeOwnerData as jest.Mock).mockRejectedValue(new Error('sqlite busy'));
    await useAuthStore.getState().completeAccountDeletion();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'failed',
    });
    expect(purgeOwnerData).toHaveBeenCalledTimes(3);
  });

  it('a purge that succeeds on a retry is reported as complete', async () => {
    (purgeOwnerData as jest.Mock)
      .mockRejectedValueOnce(new Error('sqlite busy'))
      .mockResolvedValueOnce(undefined);
    await useAuthStore.getState().completeAccountDeletion();
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'complete',
    });
    expect(purgeOwnerData).toHaveBeenCalledTimes(2);
  });

  it('a local-only account has nothing to purge', async () => {
    useAuthStore.setState({
      session: { ...signedIn, localOnly: true, canonicalAppUserId: null },
    });
    await useAuthStore.getState().completeAccountDeletion();
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'not_needed',
    });
    expect(purgeOwnerData).not.toHaveBeenCalled();
  });
});
