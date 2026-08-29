import {
  BillingError,
  createCanonicalAccessClient,
  createRevenueCatBillingClient,
  type RevenueCatCustomerInfoLike,
  type RevenueCatPackageLike,
  type RevenueCatSdk,
} from '../src/billing';

const CANONICAL_USER_ID = '11111111-1111-4111-8111-111111111111';

function customerInfo(premium = false): RevenueCatCustomerInfoLike {
  return {
    entitlements: {
      active: premium
        ? {
            premium: {
              productIdentifier: 'premium_annual_3999',
              expirationDate: '2027-08-27T00:00:00.000Z',
            },
          }
        : {},
    },
  };
}

function storePackage(
  period: 'ANNUAL' | 'MONTHLY',
  options?: { trial?: boolean; androidTrial?: boolean },
): RevenueCatPackageLike {
  const annual = period === 'ANNUAL';
  return {
    identifier: annual ? '$rc_annual' : '$rc_monthly',
    packageType: period,
    product: {
      identifier: annual ? 'premium_annual_3999' : 'premium_monthly_499',
      price: annual ? 39.99 : 4.99,
      priceString: annual ? '$39.99' : '$4.99',
      pricePerMonthString: annual ? '$3.33' : '$4.99',
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
        annual: options?.annual ?? storePackage('ANNUAL', { trial: true }),
        monthly: options?.monthly ?? storePackage('MONTHLY'),
      },
    })),
    purchasePackage: jest.fn(async () => ({
      customerInfo: customerInfo(true),
    })),
    restorePurchases: jest.fn(async () => customerInfo(true)),
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
