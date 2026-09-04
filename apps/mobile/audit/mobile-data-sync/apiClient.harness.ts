/**
 * Audit harness (execution tester, pass 2) — api.ts edge cases the existing
 * suites do not execute: non-JSON bodies on both OK and error responses,
 * token rotation while a request is in flight, malformed reserve payloads,
 * and the fetch-level (non-abort) failure path.
 *
 * Run: cd apps/mobile && npx jest --ci --testMatch '**\/audit/**\/*.harness.ts' audit/mobile-data-sync/apiClient.harness.ts
 */
import {
  ApiError,
  createAnalysisPermitClient,
  createTransport,
  submitAnalysisFeedback,
} from '../../src/data/api';
import { reportApiUnauthorized } from '../../src/account/apiSession';

jest.mock('../../src/account/apiSession', () => ({
  reportApiUnauthorized: jest.fn(),
}));

const BASE = 'https://api.example.test';

function response(init: {
  ok: boolean;
  status: number;
  statusText?: string;
  json?: () => Promise<unknown>;
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    statusText: init.statusText ?? '',
    json: init.json ?? (async () => ({})),
  } as unknown as Response;
}

const nonJsonBody = async () => {
  throw new SyntaxError('Unexpected token < in JSON at position 0');
};

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('api.ts request() body handling', () => {
  it('a 5xx with a non-JSON body becomes a typed ApiError carrying the HTTP statusText (never a SyntaxError)', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: nonJsonBody,
      }),
    );
    const transport = createTransport({ baseUrl: BASE, token: 't' });
    await expect(transport.syncShots([])).rejects.toMatchObject({
      status: 502,
      code: 'unknown',
      message: 'Bad Gateway',
    });
  });

  it('a 200 with a non-JSON body resolves to null: syncShots callers see acceptedIds on null (TypeError, transient in the outbox taxonomy)', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        response({ ok: true, status: 200, json: nonJsonBody }),
      );
    const transport = createTransport({ baseUrl: BASE, token: 't' });
    const result = await transport.syncShots([]);
    expect(result).toBeNull();
  });

  it('a fetch-level rejection that is NOT the timeout propagates unchanged (TypeError: Network request failed)', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('Network request failed'));
    const transport = createTransport({ baseUrl: BASE, token: 't' });
    await expect(transport.createSession({})).rejects.toThrow(
      new TypeError('Network request failed'),
    );
  });

  it('a 401 reports the token that was SENT even when the per-request getter rotates during the call', async () => {
    let current = 'token-A';
    let releaseFetch: (() => void) | null = null;
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>(resolve => {
          releaseFetch = () =>
            resolve(
              response({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                json: async () => ({
                  error: { code: 'auth.expired', message: 'expired' },
                }),
              }),
            );
        }),
    );
    const transport = createTransport({
      baseUrl: BASE,
      get token() {
        return current;
      },
    });
    const pending = transport.finalizeSession('s1');
    current = 'token-B';
    releaseFetch!();
    await expect(pending).rejects.toMatchObject({
      status: 401,
      code: 'auth.expired',
    });
    expect(reportApiUnauthorized).toHaveBeenCalledWith('token-A');
    expect(reportApiUnauthorized).not.toHaveBeenCalledWith('token-B');
  });

  it('a 401 with no bearer does not call reportApiUnauthorized', async () => {
    (reportApiUnauthorized as jest.Mock).mockClear();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        response({ ok: false, status: 401, statusText: 'Unauthorized' }),
      );
    const transport = createTransport({ baseUrl: BASE, token: null });
    await expect(transport.syncShots([])).rejects.toBeInstanceOf(ApiError);
    expect(reportApiUnauthorized).not.toHaveBeenCalled();
  });

  it('the timeout timer is cleared on a fast response (no dangling 20 s handle)', async () => {
    jest.useFakeTimers();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        response({ ok: true, status: 200, json: async () => ({ ok: true }) }),
      );
    const transport = createTransport({ baseUrl: BASE, token: 't' });
    await transport.createSession({});
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('api.ts analysis permit client', () => {
  const permit = {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    accessSource: 'free' as const,
    status: 'reserved' as const,
    expiresAt: '2026-08-28T18:00:00.000Z',
  };

  it('a 200 with a permit whose status is not reserved is a typed 409, never a silent success', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({
        ok: true,
        status: 200,
        json: async () => ({ permit: { ...permit, status: 'expired' } }),
      }),
    );
    const client = createAnalysisPermitClient({ baseUrl: BASE, token: 't' });
    await expect(client.reserve('k')).rejects.toMatchObject({
      status: 409,
      code: 'access.permit_not_reserved',
    });
  });

  it('a 200 whose body has no permit surfaces as a TypeError (untyped) rather than an ApiError', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        response({ ok: true, status: 200, json: async () => ({}) }),
      );
    const client = createAnalysisPermitClient({ baseUrl: BASE, token: 't' });
    let caught: unknown = null;
    try {
      await client.reserve('k');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(ApiError);
  });

  it('malformed access snapshots degrade to null without failing the reservation', async () => {
    const malformed: unknown[] = [
      undefined,
      null,
      'premium',
      { premium: 'yes', freeRatings: {} },
      { premium: true },
      {
        premium: false,
        freeRatings: {
          limit: 2,
          used: 1,
          reserved: 0,
          remaining: Number.NaN,
          availableToReserve: 1,
        },
      },
      {
        premium: false,
        freeRatings: {
          limit: '2',
          used: 1,
          reserved: 0,
          remaining: 1,
          availableToReserve: 1,
        },
      },
    ];
    for (const access of malformed) {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        response({
          ok: true,
          status: 200,
          json: async () => ({ permit, access }),
        }),
      );
      const client = createAnalysisPermitClient({
        baseUrl: BASE,
        token: 't',
      });
      await expect(client.reserve('k')).resolves.toEqual({
        permit,
        access: null,
      });
      jest.restoreAllMocks();
    }
  });

  it('a well-formed access snapshot is returned verbatim', async () => {
    const access = {
      premium: false,
      freeRatings: {
        limit: 2,
        used: 1,
        reserved: 1,
        remaining: 1,
        availableToReserve: 0,
      },
    };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({
        ok: true,
        status: 200,
        json: async () => ({ permit, access, extra: 'ignored' }),
      }),
    );
    const client = createAnalysisPermitClient({ baseUrl: BASE, token: 't' });
    await expect(client.reserve('k')).resolves.toEqual({ permit, access });
  });

  it('reserve/release refuse to hit the network without a bearer (whitespace counts as missing)', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const client = createAnalysisPermitClient({
      baseUrl: BASE,
      token: '   ',
    });
    await expect(client.reserve('k')).rejects.toMatchObject({
      status: 401,
      code: 'auth.required',
    });
    await expect(client.release(permit.id, 'failed')).rejects.toMatchObject({
      status: 401,
      code: 'auth.required',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('release encodes the permit id into the path', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(response({ ok: true, status: 200 }));
    const client = createAnalysisPermitClient({ baseUrl: BASE, token: 't' });
    await client.release('a/b c?d', 'cancelled');
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/v1/analysis-permits/a%2Fb%20c%3Fd/finalize`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('api.ts feedback + evaluation routes', () => {
  it('submitAnalysisFeedback posts rating+category to the encoded analysis path and unwraps reviewEligible', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({
        ok: true,
        status: 200,
        json: async () => ({ feedback: { reviewEligible: true } }),
      }),
    );
    await expect(
      submitAnalysisFeedback(
        { baseUrl: BASE, token: 't' },
        'id with space',
        'not_quite',
        'wrong_stroke',
      ),
    ).resolves.toEqual({ reviewEligible: true });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/v1/analyses/id%20with%20space/feedback`,
      expect.objectContaining({
        body: JSON.stringify({ rating: 'not_quite', category: 'wrong_stroke' }),
      }),
    );
  });

  it('uploadEvaluationTrials returns the parsed server body', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({
        ok: true,
        status: 200,
        json: async () => ({ acceptedIds: ['t1'], rejected: [] }),
      }),
    );
    const transport = createTransport({ baseUrl: BASE, token: 't' });
    await expect(
      transport.uploadEvaluationTrials!([{ id: 't1' }] as never),
    ).resolves.toEqual({ acceptedIds: ['t1'], rejected: [] });
  });
});
