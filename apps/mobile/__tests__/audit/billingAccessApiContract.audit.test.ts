/**
 * Structural audit probes (mobile-billing-paywall, pass 1) for the canonical
 * access client: every parseAccess arithmetic branch, HTTP status mapping,
 * bearer resolution per request, and the 401 side effect.
 */
import { createCanonicalAccessClient } from '../../src/billing/accessApi';
import type { CanonicalAccessState } from '../../src/billing/types';
import {
  clearApiSession,
  establishApiSession,
  reportApiUnauthorized,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';

const serverFree = {
  premium: false,
  entitlements: [] as string[],
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

// Mirrors supabase/functions/api/index.ts accessState(): premium responses
// always list "premium" first, then the RevenueCat entitlement ids.
const serverPremium = {
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

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function client(
  handler: (input: string, init?: RequestInit) => Promise<Response>,
  token: string | (() => string) = 'access-token',
) {
  return createCanonicalAccessClient({
    baseUrl: 'https://api.example.test/',
    get token() {
      return typeof token === 'function' ? token() : token;
    },
    fetchFn: jest.fn(handler),
  });
}

function accessWith(
  patch: Partial<Omit<CanonicalAccessState, 'freeRatings'>> & {
    freeRatings?: Partial<
      Record<keyof CanonicalAccessState['freeRatings'], unknown>
    >;
  },
) {
  return {
    ...serverFree,
    ...patch,
    freeRatings: { ...serverFree.freeRatings, ...(patch.freeRatings ?? {}) },
  };
}

afterEach(() => {
  clearApiSession();
  setApiUnauthorizedListener(null);
});

describe('audit: parseAccess accepts the server contract', () => {
  it('parses a free ledger and a premium ledger exactly as the edge function shapes them', async () => {
    const free = client(async () => jsonResponse(200, serverFree));
    await expect(free.getAccess()).resolves.toEqual(serverFree);
    const premium = client(async () => jsonResponse(200, serverPremium));
    await expect(premium.getAccess()).resolves.toEqual(serverPremium);
  });

  it('accepts every legal free-ledger cell (used 0..2, reserved 0..remaining)', async () => {
    for (let used = 0; used <= 2; used += 1) {
      const remaining = 2 - used;
      for (let reserved = 0; reserved <= remaining; reserved += 1) {
        const availableToReserve = remaining - reserved;
        const body = {
          premium: false,
          entitlements: [],
          freeRatings: {
            limit: 2,
            used,
            reserved,
            remaining,
            availableToReserve,
          },
          canStartRating: availableToReserve > 0,
          paywallRequired: availableToReserve === 0,
        };
        const api = client(async () => jsonResponse(200, body));
        await expect(api.getAccess()).resolves.toEqual(body);
      }
    }
  });
});

describe('audit: parseAccess rejects each arithmetic violation individually', () => {
  const cases: Array<[string, unknown]> = [
    ['used > 2', accessWith({ freeRatings: { used: 3, remaining: -1 } })],
    ['used < 0', accessWith({ freeRatings: { used: -1, remaining: 3 } })],
    ['remaining != 2 - used', accessWith({ freeRatings: { remaining: 2 } })],
    [
      'reserved > remaining',
      accessWith({ freeRatings: { reserved: 2, availableToReserve: -1 } }),
    ],
    [
      'reserved < 0',
      accessWith({ freeRatings: { reserved: -1, availableToReserve: 2 } }),
    ],
    [
      'availableToReserve != remaining - reserved',
      accessWith({ freeRatings: { availableToReserve: 0 } }),
    ],
    ['non-integer used', accessWith({ freeRatings: { used: 0.5 } })],
    ['string used', accessWith({ freeRatings: { used: '1' } })],
    ['limit != 2', accessWith({ freeRatings: { limit: 3 } })],
    [
      'premium true without "premium" entitlement',
      accessWith({ premium: true, entitlements: ['pickle_sensei_pro'] }),
    ],
    [
      'premium false with "premium" entitlement',
      accessWith({ premium: false, entitlements: ['premium'] }),
    ],
    [
      'non-string entitlement',
      accessWith({ entitlements: [1 as unknown as string] }),
    ],
    [
      'canStartRating contradicts ledger',
      accessWith({ canStartRating: false }),
    ],
    [
      'paywallRequired contradicts ledger',
      accessWith({ paywallRequired: true }),
    ],
    [
      'premium user flagged paywallRequired',
      { ...serverPremium, paywallRequired: true },
    ],
    ['missing freeRatings', { ...serverFree, freeRatings: undefined }],
    ['array body', [serverFree]],
    ['null body', null],
  ];

  it.each(cases)(
    '%s → billing.backend_invalid_response (retryable)',
    async (_, body) => {
      const api = client(async () => jsonResponse(200, body));
      await expect(api.getAccess()).rejects.toMatchObject({
        code: 'billing.backend_invalid_response',
        retryable: true,
      });
    },
  );
});

describe('audit: HTTP status mapping', () => {
  it('429 is a retryable backend_unavailable', async () => {
    const api = client(async () =>
      jsonResponse(429, { error: 'rate_limited' }),
    );
    await expect(api.syncBilling()).rejects.toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: true,
    });
  });

  it('5xx is retryable; 4xx other than 401/429 is not', async () => {
    await expect(
      client(async () => jsonResponse(503, {})).getAccess(),
    ).rejects.toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: true,
    });
    await expect(
      client(async () => jsonResponse(403, {})).getAccess(),
    ).rejects.toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: false,
    });
    await expect(
      client(async () => jsonResponse(404, {})).getAccess(),
    ).rejects.toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: false,
    });
  });

  it('network failure is retryable backend_unavailable', async () => {
    const api = client(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(api.getAccess()).rejects.toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: true,
    });
  });

  it('non-JSON 200 body is a retryable invalid response', async () => {
    const api = client(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token <');
          },
        }) as unknown as Response,
    );
    await expect(api.getAccess()).rejects.toMatchObject({
      code: 'billing.backend_invalid_response',
      retryable: true,
    });
  });

  it('billing/access premium parity mismatch in sync is a retryable invalid response', async () => {
    const api = client(async () =>
      jsonResponse(200, {
        billing: {
          premium: true,
          productKey: 'pickle_sensei_pro_annual',
          expiresAt: null,
          verifiedAt: '2026-09-01T00:00:00.000Z',
        },
        access: serverFree,
      }),
    );
    await expect(api.syncBilling()).rejects.toMatchObject({
      code: 'billing.backend_invalid_response',
      retryable: true,
    });
  });

  it('sync accepts a coherent premium payload and rejects malformed billing dates', async () => {
    const good = client(async () =>
      jsonResponse(200, {
        billing: {
          premium: true,
          productKey: 'pickle_sensei_pro_annual',
          expiresAt: '2027-09-01T00:00:00.000Z',
          verifiedAt: '2026-09-01T00:00:00.000Z',
        },
        access: serverPremium,
      }),
    );
    await expect(good.syncBilling()).resolves.toMatchObject({
      billing: { premium: true, productKey: 'pickle_sensei_pro_annual' },
      access: { premium: true },
    });
    const bad = client(async () =>
      jsonResponse(200, {
        billing: {
          premium: true,
          productKey: 'pickle_sensei_pro_annual',
          expiresAt: 'not-a-date',
          verifiedAt: '2026-09-01T00:00:00.000Z',
        },
        access: serverPremium,
      }),
    );
    await expect(bad.syncBilling()).rejects.toMatchObject({
      code: 'billing.backend_invalid_response',
    });
  });
});

describe('audit: bearer resolution and 401 side effects', () => {
  it('reads the bearer per request (rotation between calls is honoured)', async () => {
    let current = 'token-1';
    const seen: string[] = [];
    const api = client(
      async (_input, init) => {
        seen.push(
          String((init?.headers as Record<string, string>).Authorization),
        );
        return jsonResponse(200, serverFree);
      },
      () => current,
    );
    await api.getAccess();
    current = 'token-2';
    await api.getAccess();
    expect(seen).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('401 reports the rejected bearer once per response and is non-retryable', async () => {
    const listener = jest.fn();
    setApiUnauthorizedListener(listener);
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'access-token',
      canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
      provider: 'apple',
    });
    const api = client(async () => jsonResponse(401, {}));
    await expect(api.getAccess()).rejects.toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: false,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a late 401 for an already-rotated bearer does not tear down the successor session', async () => {
    const listener = jest.fn();
    setApiUnauthorizedListener(listener);
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'token-2',
      canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
      provider: 'apple',
    });
    // The client captured token-1 for a request that returns 401 after rotation.
    const api = client(async () => jsonResponse(401, {}), 'token-1');
    await expect(api.getAccess()).rejects.toMatchObject({ retryable: false });
    expect(listener).not.toHaveBeenCalled();
    reportApiUnauthorized('token-2');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('missing token or base URL fails with backend_unconfigured before any network call', async () => {
    const fetchFn = jest.fn();
    const noToken = createCanonicalAccessClient({
      baseUrl: 'https://api.example.test',
      token: '',
      fetchFn,
    });
    await expect(noToken.getAccess()).rejects.toMatchObject({
      code: 'billing.backend_unconfigured',
      unconfiguredReason: 'missing_api_token',
    });
    const noUrl = createCanonicalAccessClient({
      baseUrl: null,
      token: 'x',
      fetchFn,
    });
    await expect(noUrl.getAccess()).rejects.toMatchObject({
      code: 'billing.backend_unconfigured',
      unconfiguredReason: 'missing_api_base_url',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
