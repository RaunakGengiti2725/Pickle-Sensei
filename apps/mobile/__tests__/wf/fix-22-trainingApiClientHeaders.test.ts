import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import { createTrainingApi } from '../../src/training/api';
import { TrainingError } from '../../src/training/types';

function response(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => payload,
  } as Response;
}

describe('training API client request envelope', () => {
  it('reports the shipped app version in X-Client-Version', async () => {
    let headers: Record<string, string> = {};
    const client = createTrainingApi({
      baseUrl: 'https://api.pickle.test',
      token: 'signed-token',
      fetchFn: async (_input, init) => {
        headers = init?.headers as Record<string, string>;
        return response(200, { plan: null });
      },
    });
    await client.getCurrentPlan();
    expect(headers['X-Client-Version']).toBe(
      getRuntimePublicConfig().appVersion,
    );
    expect(headers['X-Client-Version']).toBe('1.0');
    expect(headers['X-Client-Version']).not.toBe('0.1.0');
  });

  it('turns a 401 into an actionable session_expired error and signals the caller', async () => {
    const onUnauthorized = jest.fn();
    const client = createTrainingApi({
      baseUrl: 'https://api.pickle.test',
      token: 'stale-token',
      fetchFn: async () =>
        response(401, {
          error: { code: 'unauthorized', message: 'Unauthorized' },
        }),
      onUnauthorized,
    });
    let caught: unknown;
    try {
      await client.listSavedDrills();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TrainingError);
    expect(caught).toMatchObject({
      code: 'training.session_expired',
      message: 'Your sign-in expired. Sign in again to continue.',
      retryable: false,
      status: 401,
    } satisfies Partial<TrainingError>);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('classifies a 401 without a JSON body the same way', async () => {
    const client = createTrainingApi({
      baseUrl: 'https://api.pickle.test',
      token: 'stale-token',
      fetchFn: async () =>
        ({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: async () => {
            throw new SyntaxError('not json');
          },
        }) as unknown as Response,
    });
    await expect(client.getCurrentPlan()).rejects.toMatchObject({
      code: 'training.session_expired',
      retryable: false,
      status: 401,
    });
  });

  it('leaves other failures on the server-code path', async () => {
    const onUnauthorized = jest.fn();
    const client = createTrainingApi({
      baseUrl: 'https://api.pickle.test',
      token: 'signed-token',
      fetchFn: async () =>
        response(403, {
          error: { code: 'forbidden', message: 'Forbidden' },
        }),
      onUnauthorized,
    });
    await expect(client.getCurrentPlan()).rejects.toMatchObject({
      code: 'forbidden',
      retryable: false,
      status: 403,
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
