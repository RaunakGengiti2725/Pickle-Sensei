/**
 * Execution-audit probes for the canonical access client
 * (src/billing/accessApi.ts) driven with REAL `Response` objects for every
 * HTTP outcome the edge function can produce, plus malformed / stale /
 * inconsistent payloads. Names starting with "OBSERVED:" document audit
 * findings.
 */
import {
  BillingError,
  createCanonicalAccessClient,
} from '../../../src/billing';
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
} from '../../../src/account/apiSession';

const BASE = 'https://example.invalid/functions/v1/api';
const TOKEN = 'access-token-1';

const validAccess = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 1,
    reserved: 0,
    remaining: 1,
    availableToReserve: 1,
  },
  canStartRating: true,
  paywallRequired: false,
};

const validPremiumAccess = {
  premium: true,
  entitlements: ['premium', 'pickle_sensei_pro'],
  freeRatings: {
    limit: 2,
    used: 2,
    reserved: 0,
    remaining: 0,
    availableToReserve: 0,
  },
  canStartRating: true,
  paywallRequired: false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function fetchMock(impl: FetchLike): jest.MockedFunction<FetchLike> {
  return jest.fn(impl) as jest.MockedFunction<FetchLike>;
}

function client(
  fetchFn: jest.Mock | jest.MockedFunction<FetchLike>,
  token: string | null = TOKEN,
) {
  return createCanonicalAccessClient({
    baseUrl: BASE,
    token,
    fetchFn: fetchFn as unknown as (
      input: string,
      init?: RequestInit,
    ) => Promise<Response>,
  });
}

async function billingErrorOf(
  promise: Promise<unknown>,
): Promise<BillingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BillingError) return error;
    throw new Error(`expected BillingError, got ${String(error)}`);
  }
  throw new Error('expected rejection');
}

beforeAll(() => {
  expect(typeof Response).toBe('function');
});

afterEach(() => {
  clearApiSession();
  setApiUnauthorizedListener(null);
});

describe('request shape', () => {
  test('GET /v1/me/access carries bearer + Accept and strips trailing slashes from the base URL', async () => {
    const fetchFn = jest.fn(async () => json(validAccess));
    const api = createCanonicalAccessClient({
      baseUrl: `${BASE}///`,
      token: TOKEN,
      fetchFn,
    });
    await api.getAccess();
    expect(fetchFn).toHaveBeenCalledWith(`${BASE}/v1/me/access`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
    });
  });

  test('OBSERVED: billing requests carry no AbortSignal / client deadline (data/api.ts bounds every request at 20s)', async () => {
    const fetchFn = fetchMock(async () => json(validAccess));
    await client(fetchFn).getAccess();
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    expect(init?.signal).toBeUndefined();
    const source = Object.keys(init ?? {}).sort();
    expect(source).toEqual(['headers', 'method']);
  });

  test('token getter is read per request (rotation mid-session is honoured)', async () => {
    const fetchFn = fetchMock(async () => json(validAccess));
    let token = 'first';
    const api = createCanonicalAccessClient({
      baseUrl: BASE,
      get token() {
        return token;
      },
      fetchFn,
    });
    await api.getAccess();
    token = 'second';
    await api.getAccess();
    const headers = fetchFn.mock.calls.map(
      call => call[1]?.headers as Record<string, string>,
    );
    expect(headers.map(h => h.Authorization)).toEqual([
      'Bearer first',
      'Bearer second',
    ]);
  });
});

describe('HTTP outcomes', () => {
  test.each([
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [400, false],
    [403, false],
    [404, false],
    [409, false],
  ])(
    'status %s → billing.backend_unavailable retryable=%s',
    async (status, retryable) => {
      const fetchFn = jest.fn(async () =>
        json({ error: { code: 'x', message: 'y' } }, status),
      );
      const error = await billingErrorOf(client(fetchFn).getAccess());
      expect(error.code).toBe('billing.backend_unavailable');
      expect(error.retryable).toBe(retryable);
    },
  );

  test('401 reports the SENT bearer to the api session only when it is still current', async () => {
    const listener = jest.fn();
    setApiUnauthorizedListener(listener);
    establishApiSession({
      provider: 'apple',
      canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
      bearerToken: TOKEN,
      apiBaseUrl: BASE,
    });
    const fetchFn = jest.fn(async () => json({ error: 'unauthorized' }, 401));
    const error = await billingErrorOf(client(fetchFn).getAccess());
    expect(error.code).toBe('billing.backend_unavailable');
    expect(error.retryable).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    // A 401 for a bearer that has already rotated is ignored.
    const stale = await billingErrorOf(
      client(fetchFn, 'old-token').getAccess(),
    );
    expect(stale.retryable).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('network failure (fetch rejects) → retryable backend_unavailable', async () => {
    const fetchFn = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    const error = await billingErrorOf(client(fetchFn).getAccess());
    expect(error.code).toBe('billing.backend_unavailable');
    expect(error.retryable).toBe(true);
  });

  test('2xx with a non-JSON (HTML gateway) body → backend_invalid_response', async () => {
    const fetchFn = jest.fn(
      async () =>
        new Response('<html>gateway</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    const error = await billingErrorOf(client(fetchFn).getAccess());
    expect(error.code).toBe('billing.backend_invalid_response');
    expect(error.retryable).toBe(true);
  });

  test('204 / empty body → backend_invalid_response', async () => {
    const fetchFn = jest.fn(async () => new Response(null, { status: 204 }));
    const error = await billingErrorOf(client(fetchFn).getAccess());
    expect(error.code).toBe('billing.backend_invalid_response');
  });
});

describe('payload validation (server contract)', () => {
  const invalid: Array<[string, unknown]> = [
    ['null body', null],
    ['array body', [validAccess]],
    [
      'limit 3',
      { ...validAccess, freeRatings: { ...validAccess.freeRatings, limit: 3 } },
    ],
    [
      'used 3',
      {
        ...validAccess,
        freeRatings: {
          limit: 2,
          used: 3,
          reserved: 0,
          remaining: -1,
          availableToReserve: -1,
        },
      },
    ],
    [
      'remaining mismatch',
      {
        ...validAccess,
        freeRatings: { ...validAccess.freeRatings, remaining: 2 },
      },
    ],
    [
      'reserved > remaining',
      {
        ...validAccess,
        freeRatings: {
          limit: 2,
          used: 1,
          reserved: 2,
          remaining: 1,
          availableToReserve: -1,
        },
      },
    ],
    [
      'availableToReserve mismatch',
      {
        ...validAccess,
        freeRatings: { ...validAccess.freeRatings, availableToReserve: 0 },
      },
    ],
    ['premium without premium entitlement', { ...validAccess, premium: true }],
    [
      'premium entitlement without premium flag',
      { ...validAccess, entitlements: ['premium'] },
    ],
    [
      'canStartRating contradicts allowance',
      { ...validAccess, canStartRating: false },
    ],
    [
      'paywallRequired contradicts canStartRating',
      { ...validAccess, paywallRequired: true },
    ],
    [
      'non-integer used',
      {
        ...validAccess,
        freeRatings: { ...validAccess.freeRatings, used: 1.5 },
      },
    ],
    ['string entitlement list', { ...validAccess, entitlements: 'premium' }],
    ['numeric entitlement', { ...validAccess, entitlements: [1] }],
  ];

  test.each(invalid)(
    'rejects %s as backend_invalid_response',
    async (_label, body) => {
      const fetchFn = jest.fn(async () => json(body));
      const error = await billingErrorOf(client(fetchFn).getAccess());
      expect(error.code).toBe('billing.backend_invalid_response');
    },
  );

  test('accepts a paid snapshot whose entitlements list names the legacy alias first', async () => {
    const fetchFn = jest.fn(async () => json(validPremiumAccess));
    const access = await client(fetchFn).getAccess();
    expect(access.premium).toBe(true);
    expect(access.entitlements).toEqual(['premium', 'pickle_sensei_pro']);
  });

  test('pickle_sensei_pro alone (no "premium" alias) is REJECTED by the client contract', async () => {
    const fetchFn = jest.fn(async () =>
      json({ ...validPremiumAccess, entitlements: ['pickle_sensei_pro'] }),
    );
    const error = await billingErrorOf(client(fetchFn).getAccess());
    expect(error.code).toBe('billing.backend_invalid_response');
  });

  test('returned snapshot is a defensive copy (mutating it does not touch the parsed source)', async () => {
    const body = { ...validAccess, entitlements: ['x'] as string[] };
    body.premium = false;
    body.entitlements = [];
    const fetchFn = jest.fn(async () => json(body));
    const access = await client(fetchFn).getAccess();
    access.entitlements.push('premium');
    const again = await client(fetchFn).getAccess();
    expect(again.entitlements).toEqual([]);
  });
});

describe('POST /v1/billing/sync', () => {
  const billing = {
    premium: true,
    productKey: 'pickle_sensei_pro_annual',
    expiresAt: '2027-01-01T00:00:00.000Z',
    verifiedAt: '2026-09-01T00:00:00.000Z',
  };

  test('accepts a consistent premium sync', async () => {
    const fetchFn = fetchMock(async () =>
      json({ billing, access: validPremiumAccess }),
    );
    const synced = await client(fetchFn).syncBilling();
    expect(fetchFn.mock.calls[0]?.[0]).toBe(`${BASE}/v1/billing/sync`);
    expect(fetchFn.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(synced.billing.premium).toBe(true);
    expect(synced.access.premium).toBe(true);
  });

  test.each<[string, unknown]>([
    [
      'billing.premium disagrees with access.premium',
      { billing, access: validAccess },
    ],
    ['missing access', { billing }],
    ['missing billing', { access: validPremiumAccess }],
    [
      'verifiedAt not a date',
      {
        billing: { ...billing, verifiedAt: 'yesterday' },
        access: validPremiumAccess,
      },
    ],
    [
      'expiresAt not a date',
      { billing: { ...billing, expiresAt: 42 }, access: validPremiumAccess },
    ],
    [
      'productKey number',
      { billing: { ...billing, productKey: 7 }, access: validPremiumAccess },
    ],
  ])('rejects %s', async (_label, body) => {
    const fetchFn = jest.fn(async () => json(body));
    const error = await billingErrorOf(client(fetchFn).syncBilling());
    expect(error.code).toBe('billing.backend_invalid_response');
  });
});

describe('unconfigured client', () => {
  test('missing base URL and missing token are non-retryable backend_unconfigured with reasons', async () => {
    const fetchFn = jest.fn();
    const noBase = await billingErrorOf(
      createCanonicalAccessClient({
        baseUrl: '   ',
        token: TOKEN,
        fetchFn,
      }).getAccess(),
    );
    expect(noBase.code).toBe('billing.backend_unconfigured');
    expect(noBase.retryable).toBe(false);
    expect(noBase.unconfiguredReason).toBe('missing_api_base_url');
    const noToken = await billingErrorOf(client(fetchFn, '').getAccess());
    expect(noToken.unconfiguredReason).toBe('missing_api_token');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
