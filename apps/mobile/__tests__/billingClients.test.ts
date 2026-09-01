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
}): RevenueCatSdk & Record<string, jest.Mock> {
  let appUserId = CANONICAL_USER_ID;
  return {
    isConfigured: jest.fn(async () => false),
    configure: jest.fn(async input => {
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
});

describe('canonical access API', () => {
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
    });
  });
});
