import { createTrainingApi } from '../src/training/api';
import { TrainingError } from '../src/training/types';
import {
  establishApiSession,
  setApiUnauthorizedListener,
  useApiSessionStore,
  type ApiSession,
} from '../src/account/apiSession';

/**
 * ADVERSARIAL PASS 3 — the training API client's error surface, pinned at
 * the transport boundary (status, body shape, headers) so the report can cite
 * exactly what the screen receives for each hostile response.
 */

const session: ApiSession = {
  apiBaseUrl: 'https://api.pickle.test',
  bearerToken: 'access-token-A',
  canonicalAppUserId: 'user-1',
  provider: 'apple',
};

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function htmlResponse(status: number, html = '<html>nope</html>'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    headers: { get: () => 'text/html' },
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
    text: async () => html,
  } as unknown as Response;
}

async function captureError(promise: Promise<unknown>): Promise<TrainingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TrainingError) return error;
    throw new Error(`Expected TrainingError, got ${String(error)}`);
  }
  throw new Error('Expected the request to reject');
}

function client(fetchFn: jest.Mock, token = 'access-token-A') {
  return createTrainingApi({
    baseUrl: 'https://api.pickle.test',
    token,
    fetchFn,
  });
}

describe('attack 3 — training API error surface', () => {
  const unauthorized = jest.fn();

  beforeEach(() => {
    unauthorized.mockClear();
    setApiUnauthorizedListener(unauthorized);
    establishApiSession({ ...session });
  });

  afterEach(() => {
    setApiUnauthorizedListener(null);
    useApiSessionStore.setState({ session: null });
  });

  // S7 ─────────────────────────────────────────────────────────────────────
  it('503 with an HTML body → training.invalid_response, status null, retryable', async () => {
    const fetchFn = jest.fn(async () => htmlResponse(503));
    const error = await captureError(client(fetchFn).listCatalogDrills({}));
    expect(error.code).toBe('training.invalid_response');
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(true);
    expect(error.message).toBe(
      'The training server returned an invalid response.',
    );
    expect(error.toState()).toEqual({
      code: 'training.invalid_response',
      message: 'The training server returned an invalid response.',
      retryable: true,
      status: null,
    });
  });

  it.each([500, 502, 504, 429, 403, 404, 400])(
    '%i with an HTML body is indistinguishable from 503: same code, status null',
    async status => {
      const fetchFn = jest.fn(async () => htmlResponse(status));
      const error = await captureError(client(fetchFn).listCatalogDrills({}));
      expect(error.code).toBe('training.invalid_response');
      expect(error.status).toBeNull();
      // A 4xx HTML page (e.g. a captive portal) is reported as retryable too.
      expect(error.retryable).toBe(true);
    },
  );

  it('503 with the generic JSON body keeps the status and the server copy', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(503, {
        error: { code: 'internal_error', message: 'Something went wrong.' },
      }),
    );
    const error = await captureError(client(fetchFn).listCatalogDrills({}));
    expect(error.code).toBe('internal_error');
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('Something went wrong.');
  });

  it('a 200 whose body is HTML on the catalog list is also training.invalid_response', async () => {
    const fetchFn = jest.fn(async () => htmlResponse(200));
    const error = await captureError(client(fetchFn).listCatalogDrills({}));
    expect(error.code).toBe('training.invalid_response');
    expect(error.status).toBeNull();
  });

  // S6 ─────────────────────────────────────────────────────────────────────
  it('429 with Retry-After: server copy and status survive, Retry-After is dropped', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(
        429,
        {
          error: {
            code: 'rate_limited',
            message:
              'Too many requests. Please slow down and try again shortly.',
          },
        },
        { 'Retry-After': '17' },
      ),
    );
    const error = await captureError(client(fetchFn).listCatalogDrills({}));
    expect(error.code).toBe('rate_limited');
    expect(error.status).toBe(429);
    expect(error.retryable).toBe(true);
    expect(error.message).toBe(
      'Too many requests. Please slow down and try again shortly.',
    );
    // Nothing on the error carries the server's retry window.
    expect(Object.keys(error)).not.toContain('retryAfterSeconds');
    expect(JSON.stringify(error.toState())).not.toContain('17');
  });

  // S5 ─────────────────────────────────────────────────────────────────────
  it('401 on save after the bearer rotated: listener NOT notified, session untouched, session_expired thrown', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(401, { error: { code: 'unauthorized', message: 'x' } }),
    );
    const api = client(fetchFn, 'access-token-A');
    establishApiSession({ ...session, bearerToken: 'access-token-B' });
    const error = await captureError(api.saveDrill('dink-target-ladder'));
    expect(unauthorized).not.toHaveBeenCalled();
    expect(useApiSessionStore.getState().session?.bearerToken).toBe(
      'access-token-B',
    );
    expect(error.code).toBe('training.session_expired');
    expect(error.status).toBe(401);
    expect(error.retryable).toBe(false);
    expect(error.message).toBe(
      'Your sign-in expired. Sign in again to continue.',
    );
  });

  it('401 with the bearer still current notifies the listener exactly once with the session', async () => {
    const fetchFn = jest.fn(async () => jsonResponse(401, {}));
    await captureError(client(fetchFn).saveDrill('dink-target-ladder'));
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(unauthorized.mock.calls[0]?.[0]).toMatchObject({
      bearerToken: 'access-token-A',
    });
  });

  it('401 with an HTML body is still session_expired (the body is never read)', async () => {
    const fetchFn = jest.fn(async () => htmlResponse(401));
    const error = await captureError(client(fetchFn).saveDrill('x'));
    expect(error.code).toBe('training.session_expired');
    expect(error.status).toBe(401);
  });

  it('401 after the session was cleared entirely is a no-op for the listener', async () => {
    const fetchFn = jest.fn(async () => jsonResponse(401, {}));
    const api = client(fetchFn);
    useApiSessionStore.setState({ session: null });
    await captureError(api.saveDrill('x'));
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('the config-level onUnauthorized fires even for a stale bearer (screen passes none)', async () => {
    const onUnauthorized = jest.fn();
    const fetchFn = jest.fn(async () => jsonResponse(401, {}));
    const api = createTrainingApi({
      baseUrl: 'https://api.pickle.test',
      token: 'access-token-A',
      fetchFn,
      onUnauthorized,
    });
    establishApiSession({ ...session, bearerToken: 'access-token-B' });
    await captureError(api.saveDrill('x'));
    expect(unauthorized).not.toHaveBeenCalled();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  // Save/unsave body edges ─────────────────────────────────────────────────
  it('saveDrill: a 204 (no body) is rejected as invalid_response although the server accepted', async () => {
    const fetchFn = jest.fn(async () => jsonResponse(204, undefined));
    const error = await captureError(client(fetchFn).saveDrill('dink'));
    expect(error.code).toBe('training.invalid_response');
  });

  it('saveDrill: an echo for a DIFFERENT slug is rejected', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(200, { slug: 'other', saved: true }),
    );
    const error = await captureError(client(fetchFn).saveDrill('dink'));
    expect(error.code).toBe('training.invalid_response');
  });

  it('unsaveDrill: 204, or any JSON 2xx, resolves; an HTML 200 rejects', async () => {
    await expect(
      client(jest.fn(async () => jsonResponse(204, undefined))).unsaveDrill(
        'd',
      ),
    ).resolves.toBeUndefined();
    await expect(
      client(jest.fn(async () => jsonResponse(200, { ok: true }))).unsaveDrill(
        'd',
      ),
    ).resolves.toBeUndefined();
    const error = await captureError(
      client(jest.fn(async () => htmlResponse(200))).unsaveDrill('d'),
    );
    expect(error.code).toBe('training.invalid_response');
  });

  it('slugs with unicode and reserved characters are encoded exactly once', async () => {
    const fetchFn = jest.fn(async (_url: string) =>
      jsonResponse(200, { slug: 'dink/🥒?x=1&y=2', saved: true }),
    );
    await client(fetchFn).saveDrill('dink/🥒?x=1&y=2');
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      `https://api.pickle.test/v1/me/saved-drills/${encodeURIComponent(
        'dink/🥒?x=1&y=2',
      )}`,
    );
  });

  it('a thrown fetch (offline) is training.unavailable with status null, retryable', async () => {
    const fetchFn = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    const error = await captureError(client(fetchFn).listCatalogDrills({}));
    expect(error.code).toBe('training.unavailable');
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(true);
  });
});
