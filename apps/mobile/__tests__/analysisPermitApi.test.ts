import { ApiError, createAnalysisPermitClient } from '../src/data/api';

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
