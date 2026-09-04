/**
 * Structural audit #2 (mobile-billing-paywall) — canonical access API probes:
 * every individual parseAccess() arithmetic branch (I7), the payload shape
 * the edge function's accessPayload() actually emits, HTTP status mapping
 * (401 side effect, 429 retryability, Retry-After), billing/access parity,
 * malformed bodies, and per-request bearer resolution through the getter
 * `createBillingAccessDependencies` installs (I14).
 */
import { createBillingAccessDependencies } from '../../../src/billing';
import { createCanonicalAccessClient } from '../../../src/billing/accessApi';
import { BillingError } from '../../../src/billing/types';
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
} from '../../../src/account/apiSession';

const CANONICAL_ID = '2f0f1c58-1e4d-4a8e-9a4b-3c1f2b7d6e5a';

/** Exactly what supabase/functions/api accessPayload() emits for a free user. */
function serverFreeAccess(scoredCount: number, reservedCount: number) {
  const used = Math.min(2, scoredCount);
  const remaining = 2 - used;
  const reserved = Math.min(reservedCount, remaining);
  const availableToReserve = remaining - reserved;
  const canStartRating = availableToReserve > 0;
  return {
    premium: false,
    entitlements: [] as string[],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

/** accessPayload() for a verified premium user (entitlements always lead with 'premium'). */
function serverPremiumAccess(scoredCount = 2) {
  const free = serverFreeAccess(scoredCount, 0);
  return {
    ...free,
    premium: true,
    entitlements: ['premium', 'pickle_sensei_pro'],
    canStartRating: true,
    paywallRequired: false,
  };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function clientWith(
  respond: (input: string, init?: RequestInit) => Promise<Response> | Response,
  token: string | null = 'bearer-1',
) {
  const fetchFn = jest.fn(async (input: string, init?: RequestInit) =>
    respond(input, init),
  );
  return {
    fetchFn,
    client: createCanonicalAccessClient({
      baseUrl: 'https://api.example.test/',
      token,
      fetchFn,
    }),
  };
}

async function rejection(promise: Promise<unknown>): Promise<BillingError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BillingError);
    return error as BillingError;
  }
  throw new Error('expected rejection');
}

afterEach(() => {
  clearApiSession();
  setApiUnauthorizedListener(null);
});

describe('parseAccess — server payloads that MUST be accepted', () => {
  it.each([
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 0],
    [1, 1],
    [2, 0],
    [7, 3],
  ])(
    'accepts accessPayload() for scored=%i reserved=%i (server clamps used/reserved)',
    async (scored, reserved) => {
      const payload = serverFreeAccess(scored, reserved);
      const { client } = clientWith(() => jsonResponse(200, payload));
      await expect(client.getAccess()).resolves.toEqual(payload);
    },
  );

  it('accepts a premium payload whose entitlements lead with "premium" then the current id', async () => {
    const payload = serverPremiumAccess(2);
    const { client } = clientWith(() => jsonResponse(200, payload));
    await expect(client.getAccess()).resolves.toEqual(payload);
  });

  it('accepts a premium user with 0 used (premium is orthogonal to the ledger)', async () => {
    const payload = serverPremiumAccess(0);
    const { client } = clientWith(() => jsonResponse(200, payload));
    await expect(client.getAccess()).resolves.toMatchObject({
      premium: true,
      canStartRating: true,
      paywallRequired: false,
    });
  });

  it('accepts unknown extra entitlement ids alongside "premium" (forward compatible)', async () => {
    const payload = {
      ...serverPremiumAccess(),
      entitlements: ['premium', 'pickle_sensei_pro', 'future_addon'],
    };
    const { client } = clientWith(() => jsonResponse(200, payload));
    await expect(client.getAccess()).resolves.toMatchObject({ premium: true });
  });
});

describe('parseAccess — every individual invariant violation is rejected', () => {
  const base = () => serverFreeAccess(1, 0);
  const cases: Array<[string, (p: ReturnType<typeof base>) => unknown]> = [
    ['limit ≠ 2', p => ({ ...p, freeRatings: { ...p.freeRatings, limit: 3 } })],
    [
      'remaining ≠ 2 − used',
      p => ({ ...p, freeRatings: { ...p.freeRatings, remaining: 2 } }),
    ],
    [
      'reserved > remaining',
      p => ({
        ...p,
        freeRatings: { ...p.freeRatings, reserved: 2, availableToReserve: -1 },
      }),
    ],
    [
      'availableToReserve ≠ remaining − reserved',
      p => ({ ...p, freeRatings: { ...p.freeRatings, availableToReserve: 0 } }),
    ],
    [
      'used > 2',
      p => ({
        ...p,
        freeRatings: {
          ...p.freeRatings,
          used: 3,
          remaining: -1,
          availableToReserve: -1,
        },
      }),
    ],
    [
      'used < 0',
      p => ({
        ...p,
        freeRatings: {
          ...p.freeRatings,
          used: -1,
          remaining: 3,
          availableToReserve: 3,
        },
      }),
    ],
    [
      'reserved < 0',
      p => ({
        ...p,
        freeRatings: { ...p.freeRatings, reserved: -1, availableToReserve: 2 },
      }),
    ],
    [
      'non-integer used',
      p => ({ ...p, freeRatings: { ...p.freeRatings, used: 1.5 } }),
    ],
    [
      'string counter',
      p => ({ ...p, freeRatings: { ...p.freeRatings, used: '1' } }),
    ],
    [
      'NaN counter',
      p => ({ ...p, freeRatings: { ...p.freeRatings, reserved: Number.NaN } }),
    ],
    [
      'premium=true without "premium" entitlement',
      p => ({
        ...p,
        premium: true,
        entitlements: ['pickle_sensei_pro'],
        canStartRating: true,
        paywallRequired: false,
      }),
    ],
    [
      '"premium" entitlement with premium=false',
      p => ({ ...p, entitlements: ['premium'] }),
    ],
    [
      'canStartRating contradicts availableToReserve',
      p => ({ ...p, canStartRating: false, paywallRequired: true }),
    ],
    [
      'paywallRequired contradicts canStartRating',
      p => ({ ...p, paywallRequired: true }),
    ],
    [
      'premium=true but canStartRating=false',
      p => ({
        ...p,
        premium: true,
        entitlements: ['premium'],
        canStartRating: false,
        paywallRequired: true,
      }),
    ],
    ['premium as string', p => ({ ...p, premium: 'true' })],
    ['entitlements not an array', p => ({ ...p, entitlements: 'premium' })],
    ['entitlements with non-string', p => ({ ...p, entitlements: [1] })],
    ['freeRatings missing', p => ({ ...p, freeRatings: undefined })],
    ['array body', () => [base()]],
    ['null body', () => null],
  ];

  it.each(cases)('rejects: %s', async (_label, mutate) => {
    const { client } = clientWith(() => jsonResponse(200, mutate(base())));
    const error = await rejection(client.getAccess());
    expect(error.code).toBe('billing.backend_invalid_response');
  });

  it('a screen-fixture style premium payload (entitlements ["pickle_sensei_pro"] only) is rejected by the real parser', async () => {
    // Several wf/*.buttons fixtures inject this shape straight into the store,
    // bypassing this parser; the server never emits it (accessPayload always
    // leads with "premium"). Pinning the parser side of that contract here.
    const { client } = clientWith(() =>
      jsonResponse(200, {
        ...serverPremiumAccess(),
        entitlements: ['pickle_sensei_pro'],
      }),
    );
    const error = await rejection(client.getAccess());
    expect(error.code).toBe('billing.backend_invalid_response');
  });
});

describe('HTTP status mapping', () => {
  it('429 → backend_unavailable, retryable (server per-user budget on /v1/billing/sync)', async () => {
    const { client } = clientWith(() =>
      jsonResponse(429, { error: 'rate_limited' }, { 'retry-after': '7' }),
    );
    const error = await rejection(client.syncBilling());
    expect(error.code).toBe('billing.backend_unavailable');
    expect(error.retryable).toBe(true);
  });

  it.each([500, 502, 503, 504])(
    '%i → retryable backend_unavailable',
    async status => {
      const { client } = clientWith(() => jsonResponse(status, undefined));
      const error = await rejection(client.getAccess());
      expect(error.code).toBe('billing.backend_unavailable');
      expect(error.retryable).toBe(true);
    },
  );

  it.each([400, 403, 404, 409, 422])(
    '%i → non-retryable backend_unavailable',
    async status => {
      const { client } = clientWith(() => jsonResponse(status, { error: 'x' }));
      const error = await rejection(client.getAccess());
      expect(error.code).toBe('billing.backend_unavailable');
      expect(error.retryable).toBe(false);
    },
  );

  it('network failure (fetch throws) → retryable backend_unavailable', async () => {
    const { client } = clientWith(() => {
      throw new TypeError('Network request failed');
    });
    const error = await rejection(client.getAccess());
    expect(error.code).toBe('billing.backend_unavailable');
    expect(error.retryable).toBe(true);
  });

  it('200 with a non-JSON body → invalid_response', async () => {
    const { client } = clientWith(
      () => new Response('<html>gateway</html>', { status: 200 }),
    );
    const error = await rejection(client.getAccess());
    expect(error.code).toBe('billing.backend_invalid_response');
  });

  it('sends Accept + Bearer, no body, correct method and path (no trailing slash doubling)', async () => {
    const { client, fetchFn } = clientWith(() =>
      jsonResponse(200, serverFreeAccess(0, 0)),
    );
    await client.getAccess();
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.test/v1/me/access',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer bearer-1',
        },
      }),
    );
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.body).toBeUndefined();
  });
});

describe('401 handling (I15)', () => {
  function session(bearerToken: string) {
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken,
      canonicalAppUserId: CANONICAL_ID,
      provider: 'apple',
    });
  }

  it('reports the rejected bearer once per 401 and the error is non-retryable', async () => {
    const listener = jest.fn();
    setApiUnauthorizedListener(listener);
    session('bearer-1');
    const { client } = clientWith(() =>
      jsonResponse(401, { error: 'unauthorized' }),
    );
    const error = await rejection(client.getAccess());
    expect(error.code).toBe('billing.backend_unavailable');
    expect(error.retryable).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('repeated 401s for a bearer that was already rotated do NOT re-fire the listener', async () => {
    const listener = jest.fn(() => session('bearer-2'));
    setApiUnauthorizedListener(listener);
    session('bearer-1');
    const { client } = clientWith(() =>
      jsonResponse(401, { error: 'unauthorized' }),
    );
    await rejection(client.getAccess());
    await rejection(client.getAccess()); // still sends bearer-1: stale, ignored
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a 401 for another account (or after sign-out) is ignored', async () => {
    const listener = jest.fn();
    setApiUnauthorizedListener(listener);
    clearApiSession();
    const { client } = clientWith(() =>
      jsonResponse(401, { error: 'unauthorized' }),
    );
    await rejection(client.getAccess());
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('syncBilling parity and shape (I8)', () => {
  const billing = {
    premium: true,
    productKey: 'pickle_sensei_pro_annual',
    expiresAt: '2027-09-01T00:00:00.000Z',
    verifiedAt: '2026-09-04T00:00:00.000Z',
  };

  it('accepts a consistent premium sync and lifetime (expiresAt null)', async () => {
    const { client } = clientWith(() =>
      jsonResponse(200, {
        billing: { ...billing, expiresAt: null },
        access: serverPremiumAccess(),
      }),
    );
    await expect(client.syncBilling()).resolves.toMatchObject({
      billing: { premium: true, expiresAt: null },
      access: { premium: true },
    });
  });

  it('billing.premium ≠ access.premium → invalid_response (retryable, surfaces as verification pending)', async () => {
    const { client } = clientWith(() =>
      jsonResponse(200, { billing, access: serverFreeAccess(2, 0) }),
    );
    const error = await rejection(client.syncBilling());
    expect(error.code).toBe('billing.backend_invalid_response');
    expect(error.retryable).toBe(true);
  });

  it('rejects malformed billing (bad dates, productKey type) even when access is valid', async () => {
    for (const bad of [
      { ...billing, verifiedAt: 'yesterday' },
      { ...billing, expiresAt: 12345 },
      { ...billing, productKey: 7 },
      { ...billing, premium: 'yes' },
    ]) {
      const { client } = clientWith(() =>
        jsonResponse(200, { billing: bad, access: serverPremiumAccess() }),
      );
      const error = await rejection(client.syncBilling());
      expect(error.code).toBe('billing.backend_invalid_response');
    }
  });

  it('a 200 sync body without access/billing keys is rejected', async () => {
    const { client } = clientWith(() => jsonResponse(200, { ok: true }));
    const error = await rejection(client.syncBilling());
    expect(error.code).toBe('billing.backend_invalid_response');
  });
});

describe('bearer resolution per request (I14)', () => {
  it('createBillingAccessDependencies reads apiToken on every request (rotation observed, no reconfigure)', async () => {
    let token: string | null = 'bearer-1';
    const fetchFn = jest.fn(async () =>
      jsonResponse(200, serverFreeAccess(0, 0)),
    );
    const deps = createBillingAccessDependencies({
      revenueCatPublicSdkKey: 'appl_x',
      canonicalAppUserId: CANONICAL_ID,
      apiBaseUrl: 'https://api.example.test',
      get apiToken() {
        return token;
      },
      fetchFn,
    });
    await deps.backend.getAccess();
    token = 'bearer-2';
    await deps.backend.getAccess();
    const auth = (i: number) =>
      (fetchFn.mock.calls[i] as unknown as [string, RequestInit])[1].headers;
    expect(auth(0)).toMatchObject({ Authorization: 'Bearer bearer-1' });
    expect(auth(1)).toMatchObject({ Authorization: 'Bearer bearer-2' });
  });

  it('a null token (account superseded / signed out) fails closed before any network call', async () => {
    let token: string | null = 'bearer-1';
    const fetchFn = jest.fn(async () =>
      jsonResponse(200, serverFreeAccess(0, 0)),
    );
    const deps = createBillingAccessDependencies({
      revenueCatPublicSdkKey: 'appl_x',
      canonicalAppUserId: CANONICAL_ID,
      apiBaseUrl: 'https://api.example.test',
      get apiToken() {
        return token;
      },
      fetchFn,
    });
    token = null;
    const error = await rejection(deps.backend.getAccess());
    expect(error.code).toBe('billing.backend_unconfigured');
    expect(error.unconfiguredReason).toBe('missing_api_token');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('index.ts reads config.apiToken at call time: a later mutation of a plain field is observed too (never captured)', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(200, serverFreeAccess(0, 0)),
    );
    const config = {
      revenueCatPublicSdkKey: 'appl_x',
      canonicalAppUserId: CANONICAL_ID,
      apiBaseUrl: 'https://api.example.test',
      apiToken: 'bearer-1' as string | null,
      fetchFn,
    };
    const deps = createBillingAccessDependencies(config);
    config.apiToken = 'bearer-2'; // mutation of the SAME object is still observed
    await deps.backend.getAccess();
    const headers = (
      fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    )[1].headers;
    expect(headers).toMatchObject({ Authorization: 'Bearer bearer-2' });
  });
});
