import * as apiSession from '../src/account/apiSession';
import {
  BillingError,
  createCanonicalAccessClient,
  createRevenueCatBillingClient,
  type RevenueCatCustomerInfoLike,
  type RevenueCatPackageLike,
  type RevenueCatSdk,
} from '../src/billing';

const CANONICAL_USER_ID = '11111111-1111-4111-8111-111111111111';

function customerInfo(
  premium = false,
  entitlementId: 'premium' | 'pickle_sensei_pro' = 'premium',
): RevenueCatCustomerInfoLike {
  return {
    entitlements: {
      active: premium
        ? {
            [entitlementId]: {
              productIdentifier: 'premium_annual_3999',
              expirationDate: '2027-08-27T00:00:00.000Z',
            },
          }
        : {},
    },
  };
}

function storePackage(
  period: 'ANNUAL' | 'MONTHLY' | 'LIFETIME',
  options?: { trial?: boolean; androidTrial?: boolean },
): RevenueCatPackageLike {
  const identifiers = {
    ANNUAL: { pkg: '$rc_annual', product: 'premium_annual_3999' },
    MONTHLY: { pkg: '$rc_monthly', product: 'premium_monthly_499' },
    LIFETIME: { pkg: '$rc_lifetime', product: 'premium_lifetime_15999' },
  }[period];
  const pricing = {
    ANNUAL: { price: 39.99, priceString: '$39.99', perMonth: '$3.33' },
    MONTHLY: { price: 4.99, priceString: '$4.99', perMonth: '$4.99' },
    LIFETIME: { price: 159.99, priceString: '$159.99', perMonth: null },
  }[period];
  return {
    identifier: identifiers.pkg,
    packageType: period,
    product: {
      identifier: identifiers.product,
      price: pricing.price,
      priceString: pricing.priceString,
      pricePerMonthString: pricing.perMonth,
      introPrice: options?.trial
        ? { price: 0, cycles: 1, period: 'P7D' }
        : null,
      defaultOption: options?.androidTrial
        ? {
            freePhase: {
              billingPeriod: 'P1W',
              billingCycleCount: 1,
              price: { amountMicros: 0 },
            },
          }
        : null,
    },
  };
}

function sdk(options?: {
  eligible?: boolean;
  annual?: RevenueCatPackageLike | null;
  monthly?: RevenueCatPackageLike | null;
  lifetime?: RevenueCatPackageLike | null;
  entitlementId?: 'premium' | 'pickle_sensei_pro';
}): { [Key in keyof RevenueCatSdk]: RevenueCatSdk[Key] & jest.Mock } {
  let appUserId = CANONICAL_USER_ID;
  let configured = false;
  return {
    isConfigured: jest.fn(async () => configured),
    configure: jest.fn(async input => {
      configured = true;
      appUserId = input.appUserID;
    }),
    getAppUserID: jest.fn(async () => appUserId),
    logIn: jest.fn(async id => {
      appUserId = id;
    }),
    getOfferings: jest.fn(async () => ({
      current: {
        identifier: 'default',
        annual:
          options?.annual !== undefined
            ? options.annual
            : storePackage('ANNUAL', { trial: true }),
        monthly:
          options?.monthly !== undefined
            ? options.monthly
            : storePackage('MONTHLY'),
        lifetime: options?.lifetime ?? null,
      },
    })),
    purchasePackage: jest.fn(async () => ({
      customerInfo: customerInfo(true, options?.entitlementId),
    })),
    restorePurchases: jest.fn(async () =>
      customerInfo(true, options?.entitlementId),
    ),
    getCustomerInfo: jest.fn(async () => customerInfo(false)),
    checkTrialOrIntroductoryPriceEligibility: jest.fn(async () => ({
      premium_annual_3999: { status: options?.eligible ? 2 : 0 },
    })),
  };
}

const access = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2 as const,
    used: 1,
    reserved: 0,
    remaining: 1,
    availableToReserve: 1,
  },
  canStartRating: true,
  paywallRequired: false,
};

describe('RevenueCat billing client', () => {
  it('retains only matching purchase transaction identifiers, never receipt or token fields', async () => {
    const native = sdk();
    native.purchasePackage.mockResolvedValue({
      customerInfo: customerInfo(true),
      transaction: {
        transactionIdentifier: '1000000123456789',
        productIdentifier: 'premium_annual_3999',
        purchaseDate: '2026-09-01T00:00:00Z',
        purchaseToken: 'never-retain-token',
        originalJson: 'never-retain-receipt',
        signature: 'never-retain-signature',
      },
    });
    const client = createRevenueCatBillingClient(
      { publicSdkKey: 'appl_public', canonicalAppUserId: CANONICAL_USER_ID },
      native,
      'ios',
    );
    const plans = await client.loadPlans();
    const result = await client.purchase(plans.annual!.id);
    expect(result.transaction).toEqual({
      productId: 'premium_annual_3999',
      transactionId: '1000000123456789',
      purchasedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain('never-retain');
    native.purchasePackage.mockResolvedValue({
      customerInfo: customerInfo(true),
      transaction: {
        transactionIdentifier: '1000000123456789',
        productIdentifier: 'another_product',
        purchaseDate: '2026-09-01T00:00:00Z',
      },
    });
    expect(
      (await client.purchase(plans.annual!.id)).transaction,
    ).toBeUndefined();
  });

  it('rejects auth-provider subjects instead of configuring RevenueCat', async () => {
    const native = sdk();
    const client = createRevenueCatBillingClient(
      { publicSdkKey: 'appl_public', canonicalAppUserId: 'google-user-123' },
      native,
      'ios',
    );
    await expect(client.configure()).rejects.toMatchObject({
      code: 'billing.unconfigured',
      unconfiguredReason: 'invalid_canonical_app_user_id',
    });
    expect(native.configure).not.toHaveBeenCalled();
  });

  it('rejects a server secret in the mobile build', async () => {
    const native = sdk();
    const client = createRevenueCatBillingClient(
      { publicSdkKey: 'sk_secret', canonicalAppUserId: CANONICAL_USER_ID },
      native,
      'ios',
    );
    await expect(client.configure()).rejects.toMatchObject({
      unconfiguredReason: 'secret_key_supplied_to_client',
    });
  });

  it('uses real annual/monthly store prices and shows iOS trial copy only when eligible', async () => {
    const native = sdk({ eligible: true });
    const client = createRevenueCatBillingClient(
      { publicSdkKey: 'appl_public', canonicalAppUserId: CANONICAL_USER_ID },
      native,
      'ios',
    );
    const plans = await client.loadPlans();
    expect(plans.annual).toMatchObject({
      productId: 'premium_annual_3999',
      priceString: '$39.99',
      freeTrial: { label: '7-day free trial', periodIso8601: 'P7D' },
    });
    expect(plans.monthly).toMatchObject({
      productId: 'premium_monthly_499',
      priceString: '$4.99',
      freeTrial: null,
    });
  });

  it('hides trial copy when iOS eligibility is unknown', async () => {
    const client = createRevenueCatBillingClient(
      { publicSdkKey: 'appl_public', canonicalAppUserId: CANONICAL_USER_ID },
      sdk({ eligible: false }),
      'ios',
    );
    expect((await client.loadPlans()).annual?.freeTrial).toBeNull();
  });

  it('uses the available Google Play free phase as the Android trial source', async () => {
    const native = sdk({
      annual: storePackage('ANNUAL', { androidTrial: true }),
    });
    const client = createRevenueCatBillingClient(
      { publicSdkKey: 'goog_public', canonicalAppUserId: CANONICAL_USER_ID },
      native,
      'android',
    );
    expect((await client.loadPlans()).annual?.freeTrial).toEqual({
      label: '1-week free trial',
      periodIso8601: 'P1W',
    });
    expect(
      native.checkTrialOrIntroductoryPriceEligibility,
    ).not.toHaveBeenCalled();
  });

  it('normalizes the lifetime package with no per-month price and no trial claim', async () => {
    // Even if the store attaches intro-offer data, a one-time purchase can
    // never advertise a free trial or a per-month rate.
    const native = sdk({
      eligible: true,
      lifetime: storePackage('LIFETIME', { trial: true }),
    });
    const client = createRevenueCatBillingClient(
      { publicSdkKey: 'appl_public', canonicalAppUserId: CANONICAL_USER_ID },
      native,
      'ios',
    );
    const plans = await client.loadPlans();
    expect(plans.lifetime).toMatchObject({
      productId: 'premium_lifetime_15999',
      period: 'lifetime',
      priceString: '$159.99',
      pricePerMonthString: null,
      freeTrial: null,
    });
  });

  it('loads plans when only the lifetime package is available', async () => {
    const client = createRevenueCatBillingClient(
      { publicSdkKey: 'appl_public', canonicalAppUserId: CANONICAL_USER_ID },
      sdk({ annual: null, monthly: null, lifetime: storePackage('LIFETIME') }),
      'ios',
    );
    const plans = await client.loadPlans();
    expect(plans.annual).toBeNull();
    expect(plans.monthly).toBeNull();
    expect(plans.lifetime?.priceString).toBe('$159.99');
  });

  it('reports offerings unavailable only when annual, monthly, and lifetime are all missing', async () => {
    const client = createRevenueCatBillingClient(
      { publicSdkKey: 'appl_public', canonicalAppUserId: CANONICAL_USER_ID },
      sdk({ annual: null, monthly: null, lifetime: null }),
      'ios',
    );
    await expect(client.loadPlans()).rejects.toMatchObject({
      code: 'billing.offerings_unavailable',
    });
  });

  it.each(['pickle_sensei_pro', 'premium'] as const)(
    'unlocks the store entitlement under the %s id',
    async entitlementId => {
      const native = sdk({ entitlementId });
      (native.getCustomerInfo as jest.Mock).mockResolvedValue(
        customerInfo(true, entitlementId),
      );
      const client = createRevenueCatBillingClient(
        { publicSdkKey: 'appl_public', canonicalAppUserId: CANONICAL_USER_ID },
        native,
        'ios',
      );
      await expect(client.readEntitlement()).resolves.toMatchObject({
        premium: true,
        productId: 'premium_annual_3999',
      });
    },
  );

  it('configures the real client only once across configure, offerings, and owner rechecks', async () => {
    const native = sdk();
    const client = createRevenueCatBillingClient(
      { publicSdkKey: 'appl_public', canonicalAppUserId: CANONICAL_USER_ID },
      native,
      'ios',
    );
    await client.configure();
    await client.loadPlans();
    await client.configure();
    expect(native.configure).toHaveBeenCalledTimes(1);
    expect(native.isConfigured).toHaveBeenCalledTimes(3);
    expect(native.getAppUserID.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(native.logIn).not.toHaveBeenCalled();
    expect(native.purchasePackage).not.toHaveBeenCalled();
    expect(native.restorePurchases).not.toHaveBeenCalled();
  });

  it('rebinds a configured SDK through logIn rather than configuring a second time', async () => {
    const native = sdk();
    const first = createRevenueCatBillingClient(
      { publicSdkKey: 'appl_public', canonicalAppUserId: CANONICAL_USER_ID },
      native,
      'ios',
    );
    const second = createRevenueCatBillingClient(
      {
        publicSdkKey: 'appl_public',
        canonicalAppUserId: '22222222-2222-4222-8222-222222222222',
      },
      native,
      'ios',
    );
    await first.configure();
    await second.configure();
    await second.loadPlans();
    expect(native.configure).toHaveBeenCalledTimes(1);
    expect(native.logIn).toHaveBeenCalledTimes(1);
    expect(native.logIn).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
    );
    await expect(native.getAppUserID()).resolves.toBe(
      '22222222-2222-4222-8222-222222222222',
    );
  });

  it('holds the original SDK owner until an explicit purchase finishes before configuring its successor', async () => {
    const native = sdk();
    native.isConfigured.mockResolvedValue(true);
    const first = createRevenueCatBillingClient(
      { publicSdkKey: 'appl_public', canonicalAppUserId: CANONICAL_USER_ID },
      native,
      'ios',
    );
    const second = createRevenueCatBillingClient(
      {
        publicSdkKey: 'appl_public',
        canonicalAppUserId: '22222222-2222-4222-8222-222222222222',
      },
      native,
      'ios',
    );
    const plans = await first.loadPlans();
    const completion = deferredResponse<{
      customerInfo: RevenueCatCustomerInfoLike;
    }>();
    native.purchasePackage.mockReturnValueOnce(completion.promise);
    const purchase = first.purchase(plans.annual!.id);
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
    expect(native.purchasePackage).toHaveBeenCalledTimes(1);
    const configureSecond = second.configure();
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
    expect(native.logIn).not.toHaveBeenCalled();
    completion.resolve({ customerInfo: customerInfo(true) });
    await expect(purchase).resolves.toMatchObject({ premium: true });
    await configureSecond;
    expect(native.logIn).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
    );
    expect(native.restorePurchases).not.toHaveBeenCalled();
  });

  it('preserves a completed store operation even if the SDK omits its customer-info snapshot', async () => {
    const native = sdk();
    const client = createRevenueCatBillingClient(
      { publicSdkKey: 'appl_public', canonicalAppUserId: CANONICAL_USER_ID },
      native,
      'ios',
    );
    const plans = await client.loadPlans();
    native.purchasePackage.mockResolvedValueOnce({});
    native.restorePurchases.mockResolvedValueOnce(null);
    await expect(client.purchase(plans.annual!.id)).resolves.toEqual({
      premium: false,
      productId: null,
      expirationDate: null,
    });
    await expect(client.restore()).resolves.toEqual({
      premium: false,
      productId: null,
      expirationDate: null,
    });
  });

  it('invalidates queued SDK work, but still returns a purchase completion for its original owner', async () => {
    const native = sdk();
    native.isConfigured.mockResolvedValue(true);
    const client = createRevenueCatBillingClient(
      { publicSdkKey: 'appl_public', canonicalAppUserId: CANONICAL_USER_ID },
      native,
      'ios',
    );
    const plans = await client.loadPlans();
    const completion = deferredResponse<{
      customerInfo: RevenueCatCustomerInfoLike;
    }>();
    native.purchasePackage.mockReturnValueOnce(completion.promise);
    const purchase = client.purchase(plans.annual!.id);
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
    const restore = client.restore();
    const rejection = expect(restore).rejects.toMatchObject({
      code: 'billing.unconfigured',
    });
    client.invalidatePendingOperations?.();
    completion.resolve({ customerInfo: customerInfo(true) });
    await expect(purchase).resolves.toMatchObject({ premium: true });
    await rejection;
    expect(native.restorePurchases).not.toHaveBeenCalled();
    await client.loadPlans();
    expect(native.getOfferings).toHaveBeenCalledTimes(2);
  });
});

describe('canonical access API', () => {
  it.each([
    'matched',
    'old-attempt',
    'other-transaction',
    'old-verdict',
    'invalid-outcome',
  ] as const)(
    'binds terminal backend evidence to the request: %s',
    async scenario => {
      const request = {
        pendingId: CANONICAL_USER_ID,
        attemptId: '22222222-2222-4222-8222-222222222222',
        transaction: {
          productId: 'premium_annual_3999',
          transactionId: '1000000123456789',
          purchasedAt: '2026-09-01T00:00:00.000Z',
        },
      };
      const fetchFn = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          billing: {
            premium: false,
            productKey: null,
            expiresAt: null,
            verifiedAt: '2026-09-07T00:00:00.000Z',
          },
          access,
          fulfilment: {
            ...request,
            attemptId: scenario === 'old-attempt' ? 'stale' : request.attemptId,
            transaction:
              scenario === 'other-transaction'
                ? { ...request.transaction, transactionId: 'other' }
                : request.transaction,
            outcome: scenario === 'invalid-outcome' ? ['expired'] : 'expired',
            verifiedAt:
              scenario === 'old-verdict'
                ? '2026-08-31T00:00:00.000Z'
                : '2026-09-07T00:00:00.000Z',
          },
        }),
      })) as unknown as jest.MockedFunction<typeof fetch>;
      const client = createCanonicalAccessClient({
        baseUrl: 'https://api.example.test',
        token: 'real-token',
        fetchFn,
      });
      if (scenario === 'matched')
        await expect(client.syncBilling(request)).resolves.toMatchObject({
          fulfilment: { outcome: 'expired' },
        });
      else
        await expect(client.syncBilling(request)).rejects.toMatchObject({
          code: 'billing.backend_invalid_response',
        });
      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.example.test/v1/billing/sync',
        expect.objectContaining({
          body: JSON.stringify({ fulfilment: request }),
        }),
      );
    },
  );

  it('reads access with bearer auth and accepts only coherent server counts', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => access,
    })) as unknown as jest.MockedFunction<typeof fetch>;
    const client = createCanonicalAccessClient({
      baseUrl: 'https://api.example.test/',
      token: 'real-token',
      fetchFn,
    });
    await expect(client.getAccess()).resolves.toEqual(access);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.test/v1/me/access',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer real-token',
        }),
      }),
    );
  });

  it('fails closed on inconsistent allowance data', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ...access,
        freeRatings: { ...access.freeRatings, remaining: 2 },
      }),
    })) as unknown as jest.MockedFunction<typeof fetch>;
    const client = createCanonicalAccessClient({
      baseUrl: 'https://api.example.test',
      token: 'real-token',
      fetchFn,
    });
    await expect(client.getAccess()).rejects.toBeInstanceOf(BillingError);
    await expect(client.getAccess()).rejects.toMatchObject({
      code: 'billing.backend_invalid_response',
    });
  });

  it('reports a missing auth token as explicitly unconfigured', async () => {
    const client = createCanonicalAccessClient({
      baseUrl: 'https://api.example.test',
      token: null,
    });
    await expect(client.getAccess()).rejects.toMatchObject({
      code: 'billing.backend_unconfigured',
      unconfiguredReason: 'missing_api_token',
      retryable: true,
    });
  });

  it('keeps an expired bearer retryable and resolves the rotated token per request', async () => {
    const report = jest
      .spyOn(apiSession, 'reportApiUnauthorized')
      .mockImplementation(() => undefined);
    let token = 'expired-access-token';
    const fetchFn = jest.fn(async () => ({
      ok: token !== 'expired-access-token',
      status: token === 'expired-access-token' ? 401 : 200,
      json: async () => access,
    })) as unknown as jest.MockedFunction<typeof fetch>;
    const client = createCanonicalAccessClient({
      baseUrl: 'https://api.example.test',
      get token() {
        return token;
      },
      fetchFn,
    });
    try {
      await expect(client.getAccess()).rejects.toMatchObject({
        code: 'billing.backend_unavailable',
        retryable: true,
      });
      expect(report).toHaveBeenCalledWith('expired-access-token');
      token = 'rotated-access-token';
      await expect(client.getAccess()).resolves.toEqual(access);
      expect(fetchFn.mock.calls[1]?.[1]?.headers).toMatchObject({
        Authorization: 'Bearer rotated-access-token',
      });
    } finally {
      report.mockRestore();
    }
  });

  it.each([408, 429, 503])('keeps HTTP %s retryable', async status => {
    const client = createCanonicalAccessClient({
      baseUrl: 'https://api.example.test',
      token: 'access-token',
      fetchFn: async () => ({ ok: false, status }) as Response,
    });
    await expect(client.getAccess()).rejects.toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: true,
    });
  });
});

function deferredResponse<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('canonical access API deadlines', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each(['getAccess', 'syncBilling'] as const)(
    '%s settles after ten seconds even when fetch ignores abort',
    async operation => {
      const pending = deferredResponse<Response>();
      const fetchFn = jest.fn<Promise<Response>, [string, RequestInit?]>(
        () => pending.promise,
      );
      const report = jest.spyOn(apiSession, 'reportApiUnauthorized');
      const client = createCanonicalAccessClient({
        baseUrl: 'https://api.example.test',
        token: 'access-token',
        fetchFn,
      });
      let result: unknown = null;
      const request = client[operation]().then(
        value => {
          result = value;
        },
        error => {
          result = error;
        },
      );
      await jest.advanceTimersByTimeAsync(9_999);
      expect(result).toBeNull();
      await jest.advanceTimersByTimeAsync(1);
      expect(result).toMatchObject({
        code: 'billing.backend_unavailable',
        retryable: true,
      });
      expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      const timeoutResult = result;
      pending.resolve({ ok: false, status: 401 } as Response);
      await request;
      await jest.advanceTimersByTimeAsync(0);
      expect(result).toBe(timeoutResult);
      expect(report).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each(['getAccess', 'syncBilling'] as const)(
    '%s includes a stalled JSON body in the same deadline as fetch',
    async operation => {
      const response = deferredResponse<Response>();
      const body = deferredResponse<unknown>();
      const fetchFn = jest.fn<Promise<Response>, [string, RequestInit?]>(
        () => response.promise,
      );
      const json = jest.fn(() => body.promise);
      const client = createCanonicalAccessClient({
        baseUrl: 'https://api.example.test',
        token: 'access-token',
        fetchFn,
      });
      let result: unknown = null;
      const request = client[operation]().then(
        value => {
          result = value;
        },
        error => {
          result = error;
        },
      );
      await jest.advanceTimersByTimeAsync(8_000);
      response.resolve({ ok: true, status: 200, json } as unknown as Response);
      await jest.advanceTimersByTimeAsync(1_999);
      expect(json).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
      await jest.advanceTimersByTimeAsync(1);
      expect(result).toMatchObject({
        code: 'billing.backend_unavailable',
        retryable: true,
      });
      expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      const timeoutResult = result;
      body.resolve(access);
      await request;
      await jest.advanceTimersByTimeAsync(0);
      expect(result).toBe(timeoutResult);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('clears the deadline after success and invalid JSON', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => access,
    })) as unknown as jest.MockedFunction<typeof fetch>;
    const client = createCanonicalAccessClient({
      baseUrl: 'https://api.example.test',
      token: 'access-token',
      fetchFn,
    });
    await expect(client.getAccess()).resolves.toEqual(access);
    expect(jest.getTimerCount()).toBe(0);
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('incomplete JSON');
      },
    } as unknown as Response);
    await expect(client.getAccess()).rejects.toMatchObject({
      code: 'billing.backend_invalid_response',
      retryable: true,
    });
    expect(jest.getTimerCount()).toBe(0);
  });
});
