import {
  ApiError,
  API_REQUEST_TIMEOUT_MS,
  api,
  createAnalysisPermitClient,
} from '../src/data/api';
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
} from '../src/account/apiSession';

const permit = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  accessSource: 'free' as const,
  status: 'reserved' as const,
  expiresAt: '2026-08-28T18:00:00.000Z',
};

describe('analysis permit API', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reserves with a stable idempotency key and bearer identity', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ permit }),
    } as Response);
    const client = createAnalysisPermitClient({
      baseUrl: 'https://api.example.test',
      token: 'account-token',
    });

    await expect(
      client.reserve('11111111-2222-4333-8444-555555555555'),
    ).resolves.toEqual({ permit, access: null });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/analysis-permits',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer account-token',
        }),
        body: JSON.stringify({
          idempotencyKey: '11111111-2222-4333-8444-555555555555',
        }),
      }),
    );
  });

  it('releases an abstention without inventing a rating id', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);
    const client = createAnalysisPermitClient({
      baseUrl: 'https://api.example.test',
      token: 'account-token',
    });

    await client.release(permit.id, 'low_confidence');
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.example.test/v1/analysis-permits/${permit.id}/finalize`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ outcome: 'low_confidence', ratingId: null }),
      }),
    );
  });

  it('fails before network access when no authenticated account exists', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const client = createAnalysisPermitClient({
      baseUrl: 'https://api.example.test',
      token: null,
    });

    await expect(
      client.reserve('11111111-2222-4333-8444-555555555555'),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ApiError>>({
        status: 401,
        code: 'auth.required',
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('API fetch and body deadlines', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    clearApiSession();
    setApiUnauthorizedListener(null);
  });

  it.each(['fetch', 'body'] as const)(
    'bounds an abort-ignoring %s and releases its timer',
    async phase => {
      jest.useFakeTimers();
      const never = new Promise<never>(() => {});
      const fetchMock = jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => {
          if (phase === 'fetch') return never;
          return {
            ok: true,
            status: 200,
            json: () => never,
          } as unknown as Response;
        });
      const settled = jest.fn();
      const pending = api.request(
        { baseUrl: 'https://api.example.test', token: 'owner-token' },
        'GET',
        '/v1/me/access',
      );
      void pending.then(settled, settled);
      await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledWith(
        expect.objectContaining({ status: 408, code: 'network.timeout' }),
      );
      await expect(pending).rejects.toBeInstanceOf(ApiError);
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each(['fetch', 'body'] as const)(
    'ignores a late 401 from a timed-out %s without unauthorized side effects',
    async phase => {
      jest.useFakeTimers();
      establishApiSession({
        apiBaseUrl: 'https://api.example.test',
        canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
        provider: 'apple',
        bearerToken: 'owner-token',
      });
      const unauthorized = jest.fn();
      setApiUnauthorizedListener(unauthorized);
      let finishFetch!: (response: Response) => void;
      let finishBody!: (body: unknown) => void;
      const body = new Promise<unknown>(resolve => {
        finishBody = resolve;
      });
      const response = {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: () => body,
      } as Response;
      jest.spyOn(globalThis, 'fetch').mockImplementation(() =>
        phase === 'fetch'
          ? new Promise<Response>(resolve => {
              finishFetch = resolve;
            })
          : Promise.resolve(response),
      );
      const settled = jest.fn();
      const pending = api.request(
        { baseUrl: 'https://api.example.test', token: 'owner-token' },
        'GET',
        '/v1/me/access',
      );
      void pending.then(settled, settled);
      await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);
      expect(settled).toHaveBeenCalledWith(
        expect.objectContaining({ status: 408 }),
      );
      if (phase === 'fetch') finishFetch(response);
      finishBody({
        error: { code: 'auth.required', message: 'Late unauthorized' },
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(unauthorized).not.toHaveBeenCalled();
      await expect(pending).rejects.toMatchObject({ code: 'network.timeout' });
    },
  );
});
