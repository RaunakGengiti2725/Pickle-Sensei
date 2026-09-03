import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import { createTrainingApi } from '../../src/training/api';

function unauthorized(): Response {
  return {
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    json: async () => ({
      error: { code: 'unauthorized', message: 'Unauthorized' },
    }),
  } as Response;
}

const SESSION = {
  apiBaseUrl: 'https://api.pickle.test',
  bearerToken: 'current-bearer',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'google' as const,
};

describe('training API 401 -> auth invalidation', () => {
  const listener = jest.fn();

  beforeEach(() => {
    listener.mockReset();
    establishApiSession(SESSION);
    setApiUnauthorizedListener(listener);
  });

  afterEach(() => {
    setApiUnauthorizedListener(null);
    clearApiSession();
  });

  it('reports the rejected bearer to the auth layer like the data API does', async () => {
    const client = createTrainingApi({
      baseUrl: SESSION.apiBaseUrl,
      token: SESSION.bearerToken,
      fetchFn: async () => unauthorized(),
    });
    await expect(client.listSavedDrills()).rejects.toMatchObject({
      code: 'training.session_expired',
      status: 401,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(SESSION);
  });

  it('ignores a late 401 for a bearer that is no longer current', async () => {
    const client = createTrainingApi({
      baseUrl: SESSION.apiBaseUrl,
      token: 'stale-bearer',
      fetchFn: async () => unauthorized(),
    });
    await expect(client.getCurrentPlan()).rejects.toMatchObject({
      code: 'training.session_expired',
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not report when the bearer was already cleared by sign-out', async () => {
    clearApiSession();
    const client = createTrainingApi({
      baseUrl: SESSION.apiBaseUrl,
      token: SESSION.bearerToken,
      fetchFn: async () => unauthorized(),
    });
    await expect(client.getCurrentPlan()).rejects.toMatchObject({
      code: 'training.session_expired',
    });
    expect(listener).not.toHaveBeenCalled();
  });
});
