/**
 * Adversarial pass — mobile-billing-paywall #4 (pass 3/3), plane cloud.
 * Target: src/billing/accessApi.ts (createCanonicalAccessClient) at 4d812e1a.
 *
 * Attacks a hostile/buggy backend response set against the canonical access
 * parser. Every case below is a server response that MUST be rejected with
 * `billing.backend_invalid_response` (fail closed), or an edge in the HTTP
 * layer whose classification (retryable / unauthorized / unconfigured) must
 * hold exactly. Assigned scenarios covered here: S1 (premium+paywallRequired
 * cross-check), S2 (limit literal 2), S3 parser half (billing.premium !==
 * access.premium). No production code is touched.
 */
jest.mock('../src/account/apiSession', () => ({
  reportApiUnauthorized: jest.fn(),
}));

import { reportApiUnauthorized } from '../src/account/apiSession';
import {
  BillingError,
  createCanonicalAccessClient,
  type BillingFetch,
} from '../src/billing';

const TOKEN = 'access-token-1';
const BASE = 'https://api.example.test';

type Json = Record<string, unknown> | unknown[] | string | number | null;

function jsonResponse(body: Json, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function rawResponse(status: number, json: () => Promise<unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json,
  } as unknown as Response;
}

function freeAccessBody(overrides?: Record<string, unknown>) {
  return {
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
    ...overrides,
  };
}

function premiumAccessBody(overrides?: Record<string, unknown>) {
  return {
    premium: true,
    entitlements: ['premium'],
    freeRatings: {
      limit: 2,
      used: 2,
      reserved: 0,
      remaining: 0,
      availableToReserve: 0,
    },
    canStartRating: true,
    paywallRequired: false,
    ...overrides,
  };
}

function billingBody(premium: boolean) {
  return {
    premium,
    productKey: premium ? 'pickle_sensei_pro_annual' : null,
    expiresAt: premium ? '2027-08-27T00:00:00.000Z' : null,
    verifiedAt: '2026-09-04T00:00:00.000Z',
  };
}

function client(
  fetchFn: BillingFetch,
  options?: { token?: string | null; baseUrl?: string | null },
) {
  return createCanonicalAccessClient({
    baseUrl: options?.baseUrl === undefined ? BASE : options.baseUrl,
    token: options?.token === undefined ? TOKEN : options.token,
    fetchFn,
  });
}

const invalid = { code: 'billing.backend_invalid_response', retryable: true };

beforeEach(() => {
  (reportApiUnauthorized as jest.Mock).mockClear();
});

describe('S1 — premium:true with paywallRequired:true is rejected, never shown', () => {
  it('rejects premium:true + paywallRequired:true (canStartRating:true)', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(premiumAccessBody({ paywallRequired: true })),
    );
    await expect(client(fetchFn).getAccess()).rejects.toMatchObject(invalid);
  });

  it('rejects premium:true + paywallRequired:true + canStartRating:false', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(
        premiumAccessBody({ paywallRequired: true, canStartRating: false }),
      ),
    );
    await expect(client(fetchFn).getAccess()).rejects.toMatchObject(invalid);
  });

  it('rejects premium:true + canStartRating:false even with paywallRequired:false', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(premiumAccessBody({ canStartRating: false })),
    );
    await expect(client(fetchFn).getAccess()).rejects.toMatchObject(invalid);
  });

  it('rejects a free user with availableToReserve:0 whose paywallRequired is false', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(
        freeAccessBody({
          freeRatings: {
            limit: 2,
            used: 2,
            reserved: 0,
            remaining: 0,
            availableToReserve: 0,
          },
          canStartRating: false,
          paywallRequired: false,
        }),
      ),
    );
    await expect(client(fetchFn).getAccess()).rejects.toMatchObject(invalid);
  });

  it('rejects canStartRating:true for a free user with no reservable rating', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(
        freeAccessBody({
          freeRatings: {
            limit: 2,
            used: 2,
            reserved: 0,
            remaining: 0,
            availableToReserve: 0,
          },
          canStartRating: true,
          paywallRequired: true,
        }),
      ),
    );
    await expect(client(fetchFn).getAccess()).rejects.toMatchObject(invalid);
  });

  it('accepts the two self-consistent shapes (control)', async () => {
    await expect(
      client(async () => jsonResponse(premiumAccessBody())).getAccess(),
    ).resolves.toMatchObject({ premium: true, paywallRequired: false });
    await expect(
      client(async () => jsonResponse(freeAccessBody())).getAccess(),
    ).resolves.toMatchObject({ premium: false, canStartRating: true });
  });
});

describe('S2 — freeRatings.limit literal 2 never widens', () => {
  it.each([3, 1, 0, -2, '2', 2.5, null, undefined, Number.NaN, 1e300])(
    'rejects syncBilling whose access.freeRatings.limit is %p',
    async limit => {
      const fetchFn = jest.fn(async () =>
        jsonResponse({
          billing: billingBody(false),
          access: freeAccessBody({
            freeRatings: {
              limit,
              used: 0,
              reserved: 0,
              remaining: 2,
              availableToReserve: 2,
            },
          }),
        }),
      );
      await expect(client(fetchFn).syncBilling()).rejects.toMatchObject(
        invalid,
      );
    },
  );

  it('rejects limit:3 even when every derived field is consistent with 3', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse({
        billing: billingBody(false),
        access: freeAccessBody({
          freeRatings: {
            limit: 3,
            used: 0,
            reserved: 0,
            remaining: 3,
            availableToReserve: 3,
          },
        }),
      }),
    );
    await expect(client(fetchFn).syncBilling()).rejects.toMatchObject(invalid);
    await expect(
      client(async () =>
        jsonResponse(
          freeAccessBody({
            freeRatings: {
              limit: 3,
              used: 0,
              reserved: 0,
              remaining: 3,
              availableToReserve: 3,
            },
          }),
        ),
      ).getAccess(),
    ).rejects.toMatchObject(invalid);
  });

  it('rejects remaining:3 / used:-1 (an arithmetic route to a third rating)', async () => {
    await expect(
      client(async () =>
        jsonResponse(
          freeAccessBody({
            freeRatings: {
              limit: 2,
              used: -1,
              reserved: 0,
              remaining: 3,
              availableToReserve: 3,
            },
          }),
        ),
      ).getAccess(),
    ).rejects.toMatchObject(invalid);
  });
});

describe('S3 — billing/access premium disagreement', () => {
  it('rejects { billing.premium:true, access.premium:false }', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse({ billing: billingBody(true), access: freeAccessBody() }),
    );
    await expect(client(fetchFn).syncBilling()).rejects.toMatchObject(invalid);
  });

  it('rejects { billing.premium:false, access.premium:true }', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse({
        billing: billingBody(false),
        access: premiumAccessBody(),
      }),
    );
    await expect(client(fetchFn).syncBilling()).rejects.toMatchObject(invalid);
  });

  it('rejects a sync body missing billing or access', async () => {
    await expect(
      client(async () =>
        jsonResponse({ access: freeAccessBody() }),
      ).syncBilling(),
    ).rejects.toMatchObject(invalid);
    await expect(
      client(async () =>
        jsonResponse({ billing: billingBody(false) }),
      ).syncBilling(),
    ).rejects.toMatchObject(invalid);
  });

  it('accepts a consistent premium sync (control)', async () => {
    await expect(
      client(async () =>
        jsonResponse({
          billing: billingBody(true),
          access: premiumAccessBody(),
        }),
      ).syncBilling(),
    ).resolves.toMatchObject({
      billing: { premium: true },
      access: { premium: true },
    });
  });
});

describe('extra — entitlement / premium cross-checks', () => {
  it('rejects premium:false whose entitlements contain "premium"', async () => {
    await expect(
      client(async () =>
        jsonResponse(freeAccessBody({ entitlements: ['premium'] })),
      ).getAccess(),
    ).rejects.toMatchObject(invalid);
  });

  it('rejects premium:true with only the store entitlement id (server normalises to "premium")', async () => {
    await expect(
      client(async () =>
        jsonResponse(
          premiumAccessBody({ entitlements: ['pickle_sensei_pro'] }),
        ),
      ).getAccess(),
    ).rejects.toMatchObject(invalid);
  });

  it('rejects premium:true with an empty entitlement list', async () => {
    await expect(
      client(async () =>
        jsonResponse(premiumAccessBody({ entitlements: [] })),
      ).getAccess(),
    ).rejects.toMatchObject(invalid);
  });

  it('rejects non-string entitlements (object / number / nested array)', async () => {
    for (const entitlements of [
      [{ id: 'premium' }],
      ['premium', 1],
      [['premium']],
      'premium',
    ]) {
      await expect(
        client(async () =>
          jsonResponse(premiumAccessBody({ entitlements })),
        ).getAccess(),
      ).rejects.toMatchObject(invalid);
    }
  });

  it('accepts (and copies) a huge unicode entitlement list containing "premium"', async () => {
    // 100k entries is far beyond anything the server returns; the parser must
    // stay linear and must return its own array, never the parsed body.
    const noise = Array.from({ length: 100_000 }, (_, i) => `🥒-${i}-ü`);
    const body = premiumAccessBody({ entitlements: [...noise, 'premium'] });
    const started = Date.now();
    const parsed = await client(async () => jsonResponse(body)).getAccess();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(parsed.premium).toBe(true);
    expect(parsed.entitlements).not.toBe(body.entitlements);
    expect(parsed.entitlements).toHaveLength(100_001);
  });
});

describe('extra — freeRatings arithmetic fuzz (seeded)', () => {
  // Deterministic LCG; seed recorded so a failure is reproducible.
  const SEED = 0x5eed_2026;
  function lcg(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s;
    };
  }

  it(`accepts exactly the self-consistent tuples and rejects every other (seed ${SEED})`, async () => {
    const rnd = lcg(SEED);
    const pick = (values: number[]) => values[rnd() % values.length]!;
    const domain = [-1, 0, 1, 2, 3, 1.5, Number.NaN];
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 400; i += 1) {
      const used = pick(domain);
      const reserved = pick(domain);
      const remaining = pick(domain);
      const availableToReserve = pick(domain);
      const premium = rnd() % 2 === 0;
      const expectedCanStart = premium || availableToReserve > 0;
      const consistent =
        Number.isSafeInteger(used) &&
        Number.isSafeInteger(reserved) &&
        Number.isSafeInteger(remaining) &&
        Number.isSafeInteger(availableToReserve) &&
        used >= 0 &&
        used <= 2 &&
        reserved >= 0 &&
        remaining === 2 - used &&
        reserved <= remaining &&
        availableToReserve === remaining - reserved;
      const body = {
        premium,
        entitlements: premium ? ['premium'] : [],
        freeRatings: {
          limit: 2,
          used,
          reserved,
          remaining,
          availableToReserve,
        },
        canStartRating: expectedCanStart,
        paywallRequired: !expectedCanStart,
      };
      const outcome = await client(async () => jsonResponse(body))
        .getAccess()
        .then(() => 'ok' as const)
        .catch((error: unknown) =>
          error instanceof BillingError ? error.code : 'unexpected',
        );
      if (consistent) {
        expect(outcome).toBe('ok');
        accepted += 1;
      } else {
        expect(outcome).toBe('billing.backend_invalid_response');
        rejected += 1;
      }
    }
    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });
});

describe('extra — body shape and HTTP classification', () => {
  it.each<Json>([null, [], 'premium', 42, { premium: true }])(
    'rejects non-record / partial body %p as invalid_response',
    async body => {
      await expect(
        client(async () => jsonResponse(body)).getAccess(),
      ).rejects.toMatchObject(invalid);
    },
  );

  it('rejects a 200 whose body is not JSON as invalid_response', async () => {
    await expect(
      client(async () =>
        rawResponse(200, async () => {
          throw new SyntaxError('Unexpected token <');
        }),
      ).getAccess(),
    ).rejects.toMatchObject(invalid);
  });

  it('maps a network TypeError to retryable backend_unavailable', async () => {
    await expect(
      client(async () => {
        throw new TypeError('Network request failed');
      }).getAccess(),
    ).rejects.toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: true,
    });
  });

  it('401 reports the exact bearer as unauthorized and is not retryable', async () => {
    await expect(
      client(async () =>
        jsonResponse({ error: 'unauthorized' }, 401),
      ).getAccess(),
    ).rejects.toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: false,
    });
    expect(reportApiUnauthorized).toHaveBeenCalledTimes(1);
    expect(reportApiUnauthorized).toHaveBeenCalledWith(TOKEN);
  });

  it.each([
    [403, false],
    [404, false],
    [409, false],
    [429, true],
    [500, true],
    [503, true],
  ])(
    'status %i → backend_unavailable retryable=%p',
    async (status, retryable) => {
      await expect(
        client(async () => jsonResponse({}, status)).getAccess(),
      ).rejects.toMatchObject({
        code: 'billing.backend_unavailable',
        retryable,
      });
      expect(reportApiUnauthorized).not.toHaveBeenCalled();
    },
  );

  it('never trusts a 4xx/5xx body even if it looks like premium access', async () => {
    await expect(
      client(async () => jsonResponse(premiumAccessBody(), 500)).getAccess(),
    ).rejects.toMatchObject({ code: 'billing.backend_unavailable' });
  });

  it('reads the token per request so a rotated bearer is used immediately', async () => {
    const headers: Array<string | undefined> = [];
    const fetchFn: BillingFetch = async (_input, init) => {
      const auth = (init?.headers as Record<string, string | undefined>)
        .Authorization;
      headers.push(auth);
      return jsonResponse(freeAccessBody());
    };
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
    expect(headers).toEqual(['Bearer first', 'Bearer second']);
  });

  it('a token that rotates to empty mid-session is backend_unconfigured, not a request', async () => {
    const fetchFn = jest.fn(async () => jsonResponse(freeAccessBody()));
    let token: string | null = TOKEN;
    const api = createCanonicalAccessClient({
      baseUrl: BASE,
      get token() {
        return token;
      },
      fetchFn,
    });
    await api.getAccess();
    token = '   ';
    await expect(api.getAccess()).rejects.toMatchObject({
      code: 'billing.backend_unconfigured',
      unconfiguredReason: 'missing_api_token',
      retryable: false,
    });
    token = null;
    await expect(api.syncBilling()).rejects.toMatchObject({
      unconfiguredReason: 'missing_api_token',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('normalises trailing slashes and hits the exact route with the exact method', async () => {
    const calls: Array<[string, string | undefined]> = [];
    const fetchFn: BillingFetch = async (input, init) => {
      calls.push([input, init?.method]);
      return jsonResponse(
        input.endsWith('/v1/billing/sync')
          ? { billing: billingBody(false), access: freeAccessBody() }
          : freeAccessBody(),
      );
    };
    const api = client(fetchFn, { baseUrl: `${BASE}///  ` });
    await api.getAccess();
    await api.syncBilling();
    expect(calls).toEqual([
      [`${BASE}/v1/me/access`, 'GET'],
      [`${BASE}/v1/billing/sync`, 'POST'],
    ]);
  });

  it('missing base URL is unconfigured with the documented reason', async () => {
    await expect(
      client(async () => jsonResponse(freeAccessBody()), {
        baseUrl: '   ',
      }).getAccess(),
    ).rejects.toMatchObject({
      code: 'billing.backend_unconfigured',
      unconfiguredReason: 'missing_api_base_url',
    });
  });

  it('billing state with a non-ISO verifiedAt or expiresAt is rejected', async () => {
    for (const billing of [
      { ...billingBody(true), verifiedAt: 'not a date' },
      { ...billingBody(true), expiresAt: 12345 },
      { ...billingBody(true), productKey: 7 },
      { ...billingBody(true), verifiedAt: null },
    ]) {
      await expect(
        client(async () =>
          jsonResponse({ billing, access: premiumAccessBody() }),
        ).syncBilling(),
      ).rejects.toMatchObject(invalid);
    }
  });

  it('parsed access is a defensive copy (mutating the body cannot move access)', async () => {
    const body = freeAccessBody();
    const parsed = await client(async () => jsonResponse(body)).getAccess();
    body.premium = true;
    body.freeRatings.availableToReserve = 99;
    expect(parsed.premium).toBe(false);
    expect(parsed.freeRatings.availableToReserve).toBe(1);
  });
});
