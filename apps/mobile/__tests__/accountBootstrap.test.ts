import { bootstrapCanonicalAccount } from '../src/account/bootstrap';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  subscribeToApiSession,
} from '../src/account/apiSession';

const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const environment = {
  locale: 'en-US',
  timezone: 'America/Los_Angeles',
  device: {
    platform: 'ios' as const,
    osVersion: '18.5',
    appVersion: '1.0',
    model: 'iOS phone',
  },
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('canonical account bootstrap', () => {
  it('sends the real runtime context and returns only the backend UUID as canonical ID', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      response({
        user: { id: canonicalId, email: 'player@example.com' },
        onboardingState: 'pending',
      }),
    );

    const result = await bootstrapCanonicalAccount({
      apiBaseUrl: 'https://api.pickle.example/',
      bearerToken: 'provider-issued-jwt',
      provider: 'google',
      environment,
      fetchFn,
    });

    expect(result.account.id).toBe(canonicalId);
    expect(result.apiSession).toEqual({
      apiBaseUrl: 'https://api.pickle.example',
      bearerToken: 'provider-issued-jwt',
      canonicalAppUserId: canonicalId,
      provider: 'google',
    });
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.pickle.example/v1/account/bootstrap',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer provider-issued-jwt',
          'X-Client-Version': '1.0',
        }),
        body: JSON.stringify(environment),
      }),
    );
  });

  it('fails closed when release public configuration is missing or insecure', async () => {
    await expect(
      bootstrapCanonicalAccount({
        apiBaseUrl: null,
        bearerToken: 'token',
        provider: 'apple',
        environment,
      }),
    ).rejects.toMatchObject({
      code: 'account.not_configured',
      retryable: false,
    });

    await expect(
      bootstrapCanonicalAccount({
        apiBaseUrl: 'http://api.pickle.example',
        bearerToken: 'token',
        provider: 'apple',
        environment,
      }),
    ).rejects.toMatchObject({
      code: 'account.not_configured',
    });
  });

  it('rejects a provider subject or malformed value returned in place of a canonical UUID', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      response({
        user: { id: 'google-subject-123', email: null },
        onboardingState: 'complete',
      }),
    );
    await expect(
      bootstrapCanonicalAccount({
        apiBaseUrl: 'https://api.pickle.example',
        bearerToken: 'token',
        provider: 'google',
        environment,
        fetchFn,
      }),
    ).rejects.toMatchObject({
      code: 'account.invalid_response',
    });
  });

  it('surfaces issuer or audience rejection without weakening verification', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      response(
        {
          error: {
            message: 'Token verification failed.',
          },
        },
        401,
      ),
    );
    await expect(
      bootstrapCanonicalAccount({
        apiBaseUrl: 'https://api.pickle.example',
        bearerToken: 'wrong-issuer-token',
        provider: 'apple',
        environment,
        fetchFn,
      }),
    ).rejects.toMatchObject({
      code: 'account.rejected',
      message: 'Token verification failed.',
      retryable: false,
    });
  });
});

describe('in-memory API session', () => {
  afterEach(clearApiSession);

  it('notifies consumers and clears all bearer material', () => {
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeToApiSession(session =>
      seen.push(session?.canonicalAppUserId ?? null),
    );
    establishApiSession({
      apiBaseUrl: 'https://api.pickle.example',
      bearerToken: 'memory-only-token',
      canonicalAppUserId: canonicalId,
      provider: 'apple',
    });
    expect(getApiSession()?.bearerToken).toBe('memory-only-token');
    clearApiSession();
    unsubscribe();
    expect(getApiSession()).toBeNull();
    expect(seen).toEqual([canonicalId, null]);
  });
});
