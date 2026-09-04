/**
 * Structural audit probes (mobile-billing-paywall, pass 1) for the RevenueCat
 * client against the shapes react-native-purchases 10.8.1 actually emits
 * (node_modules/@revenuecat/purchases-typescript-internal/dist/*.d.ts):
 * cancellation errors, ISO trial periods, Android pricing phases, entitlement
 * parsing, and the already-configured-SDK logIn path.
 */
import {
  createRevenueCatBillingClient,
  type RevenueCatCustomerInfoLike,
  type RevenueCatPackageLike,
  type RevenueCatSdk,
} from '../../src/billing';

const CANONICAL_USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';

function customerInfo(
  active: RevenueCatCustomerInfoLike['entitlements']['active'] = {},
): RevenueCatCustomerInfoLike {
  return { entitlements: { active } };
}

function annualPackage(
  intro: RevenueCatPackageLike['product']['introPrice'] = null,
  defaultOption: RevenueCatPackageLike['product']['defaultOption'] = null,
): RevenueCatPackageLike {
  return {
    identifier: '$rc_annual',
    packageType: 'ANNUAL',
    product: {
      identifier: 'pickle_sensei_pro_annual',
      price: 59.99,
      priceString: '$59.99',
      pricePerMonthString: '$5.00',
      introPrice: intro,
      defaultOption,
    },
  };
}

function sdk(overrides: Partial<RevenueCatSdk> = {}) {
  let appUserId: string | null = null;
  const base: RevenueCatSdk & Record<string, jest.Mock> = {
    isConfigured: jest.fn(async () => appUserId !== null),
    configure: jest.fn(async (input: { appUserID: string }) => {
      appUserId = input.appUserID;
    }),
    getAppUserID: jest.fn(async () => appUserId ?? ''),
    logIn: jest.fn(async (id: string) => {
      appUserId = id;
    }),
    getOfferings: jest.fn(async () => ({
      current: {
        identifier: 'default',
        annual: annualPackage(),
        monthly: null,
        lifetime: null,
      },
    })),
    purchasePackage: jest.fn(async () => ({
      customerInfo: customerInfo({
        pickle_sensei_pro: {
          productIdentifier: 'pickle_sensei_pro_annual',
          expirationDate: null,
        },
      }),
    })),
    restorePurchases: jest.fn(async () => customerInfo()),
    getCustomerInfo: jest.fn(async () => customerInfo()),
    checkTrialOrIntroductoryPriceEligibility: jest.fn(async () => ({
      pickle_sensei_pro_annual: { status: 2 },
    })),
  };
  return Object.assign(base, overrides) as typeof base & {
    setAppUserId(id: string | null): void;
  } & { readonly appUserId: string | null };
}

function iosClient(native: RevenueCatSdk) {
  return createRevenueCatBillingClient(
    { publicSdkKey: 'appl_public', canonicalAppUserId: CANONICAL_USER_ID },
    native,
    'ios',
  );
}

async function purchaseAnnual(native: RevenueCatSdk) {
  const client = iosClient(native);
  const plans = await client.loadPlans();
  return client.purchase(plans.annual!.id);
}

describe('audit: cancellation detection against the installed SDK error shape', () => {
  // react-native-purchases 10.8.1 sets `error.userCancelled = error.code ===
  // PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR` where the enum value is the
  // string "1".
  it('code "1" with userCancelled true → silent billing.purchase_cancelled', async () => {
    const native = sdk({
      purchasePackage: jest.fn(async () => {
        throw {
          code: '1',
          message: 'Purchase was cancelled.',
          readableErrorCode: 'PURCHASE_CANCELLED_ERROR',
          userInfo: { readableErrorCode: 'PURCHASE_CANCELLED_ERROR' },
          underlyingErrorMessage: '',
          userCancelled: true,
        };
      }),
    });
    await expect(purchaseAnnual(native)).rejects.toMatchObject({
      code: 'billing.purchase_cancelled',
      retryable: false,
    });
  });

  it('code "1" alone (userCancelled null) is still a cancellation', async () => {
    const native = sdk({
      purchasePackage: jest.fn(async () => {
        throw { code: '1', userCancelled: null };
      }),
    });
    await expect(purchaseAnnual(native)).rejects.toMatchObject({
      code: 'billing.purchase_cancelled',
    });
  });

  it('other SDK error codes are retryable purchase failures, never cancellations', async () => {
    for (const code of ['0', '2', '10', '13']) {
      const native = sdk({
        purchasePackage: jest.fn(async () => {
          throw { code, userCancelled: false };
        }),
      });
      await expect(purchaseAnnual(native)).rejects.toMatchObject({
        code: 'billing.purchase_failed',
        retryable: true,
      });
    }
  });

  it('a non-object rejection (string) is a retryable purchase failure', async () => {
    const native = sdk({
      purchasePackage: jest.fn(async () => {
        throw 'boom';
      }),
    });
    await expect(purchaseAnnual(native)).rejects.toMatchObject({
      code: 'billing.purchase_failed',
      retryable: true,
    });
  });
});

describe('audit: ISO 8601 trial periods (StoreKit introPrice.period)', () => {
  it.each([
    ['P7D', 1, '7-day free trial', 'P7D'],
    ['P1W', 1, '1-week free trial', 'P1W'],
    ['P1W', 2, '2-week free trial', 'P2W'],
    ['p3d', 1, '3-day free trial', 'P3D'],
    ['P1M', 1, '1-month free trial', 'P1M'],
    ['P2M', 3, '6-month free trial', 'P6M'],
    ['P1Y', 1, '1-year free trial', 'P1Y'],
  ])('%s × %s → %s', async (period, cycles, label, iso) => {
    const native = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: annualPackage({ price: 0, cycles, period }),
          monthly: null,
          lifetime: null,
        },
      })),
    });
    const plans = await iosClient(native).loadPlans();
    expect(plans.annual?.freeTrial).toEqual({ label, periodIso8601: iso });
  });

  it.each([['P1W2D'], ['PT24H'], ['P0D'], ['7D'], ['']])(
    'unsupported period %s renders standard pricing (no trial claim) instead of throwing',
    async period => {
      const native = sdk({
        getOfferings: jest.fn(async () => ({
          current: {
            identifier: 'default',
            annual: annualPackage({ price: 0, cycles: 1, period }),
            monthly: null,
            lifetime: null,
          },
        })),
      });
      const plans = await iosClient(native).loadPlans();
      expect(plans.annual).not.toBeNull();
      expect(plans.annual?.freeTrial).toBeNull();
    },
  );

  it('zero cycles or negative cycles produce no trial', async () => {
    for (const cycles of [0, -1]) {
      const native = sdk({
        getOfferings: jest.fn(async () => ({
          current: {
            identifier: 'default',
            annual: annualPackage({ price: 0, cycles, period: 'P7D' }),
            monthly: null,
            lifetime: null,
          },
        })),
      });
      const plans = await iosClient(native).loadPlans();
      expect(plans.annual?.freeTrial).toBeNull();
    }
  });

  it('a paid intro price (not zero) never renders as a free trial', async () => {
    const native = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: annualPackage({ price: 0.99, cycles: 1, period: 'P1M' }),
          monthly: null,
          lifetime: null,
        },
      })),
    });
    const plans = await iosClient(native).loadPlans();
    expect(plans.annual?.freeTrial).toBeNull();
    expect(
      native.checkTrialOrIntroductoryPriceEligibility,
    ).not.toHaveBeenCalled();
  });

  it('eligibility status other than 2 (or a thrown eligibility check) → standard pricing', async () => {
    for (const eligibility of [
      async () => ({ pickle_sensei_pro_annual: { status: 1 } }),
      async () => ({}),
      async () => {
        throw new Error('network');
      },
    ]) {
      const native = sdk({
        getOfferings: jest.fn(async () => ({
          current: {
            identifier: 'default',
            annual: annualPackage({ price: 0, cycles: 1, period: 'P7D' }),
            monthly: null,
            lifetime: null,
          },
        })),
        checkTrialOrIntroductoryPriceEligibility: jest.fn(eligibility),
      });
      const plans = await iosClient(native).loadPlans();
      expect(plans.annual?.freeTrial).toBeNull();
    }
  });
});

describe('audit: Android pricing-phase contract vs. the installed SDK', () => {
  // react-native-purchases 10.8.1: PricingPhase.billingPeriod is a `Period`
  // object { unit, value, iso8601 }, not a string. The client's
  // RevenueCatPricingPhaseLike declares `billingPeriod: string`.
  it('a real SDK-shaped freePhase (billingPeriod: Period object) must not break plan loading', async () => {
    const realShapedPhase = {
      billingPeriod: { unit: 'WEEK', value: 1, iso8601: 'P1W' },
      billingCycleCount: 1,
      price: { amountMicros: 0, formatted: '$0.00', currencyCode: 'USD' },
    };
    const native = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: annualPackage(null, {
            freePhase: realShapedPhase as unknown as NonNullable<
              RevenueCatPackageLike['product']['defaultOption']
            >['freePhase'],
          }),
          monthly: null,
          lifetime: null,
        },
      })),
    });
    const client = createRevenueCatBillingClient(
      { publicSdkKey: 'test_public', canonicalAppUserId: CANONICAL_USER_ID },
      native,
      'android',
    );
    const plans = await client.loadPlans();
    expect(plans.annual).not.toBeNull();
    expect(plans.annual?.freeTrial).toEqual({
      label: '1-week free trial',
      periodIso8601: 'P1W',
    });
  });
});

describe('audit: entitlement parsing', () => {
  it('prefers pickle_sensei_pro over the legacy alias when both are active', async () => {
    const native = sdk({
      restorePurchases: jest.fn(async () =>
        customerInfo({
          premium: { productIdentifier: 'legacy_annual', expirationDate: null },
          pickle_sensei_pro: {
            productIdentifier: 'pickle_sensei_pro_annual',
            expirationDate: '2027-01-01T00:00:00.000Z',
          },
        }),
      ),
    });
    await expect(iosClient(native).restore()).resolves.toEqual({
      premium: true,
      productId: 'pickle_sensei_pro_annual',
      expirationDate: '2027-01-01T00:00:00.000Z',
    });
  });

  it('unrelated active entitlements never grant premium', async () => {
    const native = sdk({
      restorePurchases: jest.fn(async () =>
        customerInfo({
          some_other_app: { productIdentifier: 'x', expirationDate: null },
        }),
      ),
    });
    await expect(iosClient(native).restore()).resolves.toMatchObject({
      premium: false,
      productId: null,
    });
  });

  it('a customerInfo without entitlements.active after purchase surfaces as a typed store error, not a raw TypeError', async () => {
    const native = sdk({
      purchasePackage: jest.fn(async () => ({
        customerInfo: {} as unknown as RevenueCatCustomerInfoLike,
      })),
    });
    await expect(purchaseAnnual(native)).rejects.toMatchObject({
      code: 'billing.purchase_failed',
    });
  });

  it('a customerInfo without entitlements.active on restore surfaces as a typed store error', async () => {
    const native = sdk({
      restorePurchases: jest.fn(
        async () => ({}) as unknown as RevenueCatCustomerInfoLike,
      ),
    });
    await expect(iosClient(native).restore()).rejects.toMatchObject({
      code: 'billing.restore_failed',
    });
  });
});

describe('audit: SDK already configured for another appUserID', () => {
  it('logs in to the canonical UUID instead of reconfiguring, then verifies the binding', async () => {
    const native = sdk();
    await native.configure({ apiKey: 'appl_public', appUserID: OTHER_USER_ID });
    (native.configure as jest.Mock).mockClear();
    const client = iosClient(native);
    await client.configure();
    expect(native.configure).not.toHaveBeenCalled();
    expect(native.logIn).toHaveBeenCalledWith(CANONICAL_USER_ID);
    expect(await native.getAppUserID()).toBe(CANONICAL_USER_ID);
  });

  it('fails closed when logIn does not bind the canonical UUID', async () => {
    const native = sdk({
      logIn: jest.fn(async () => undefined),
    });
    await native.configure({ apiKey: 'appl_public', appUserID: OTHER_USER_ID });
    const client = iosClient(native);
    await expect(client.configure()).rejects.toMatchObject({
      code: 'billing.unconfigured',
      unconfiguredReason: 'invalid_canonical_app_user_id',
    });
    // A failed configuration is not memoised: the next call retries.
    await expect(client.configure()).rejects.toMatchObject({
      code: 'billing.unconfigured',
    });
    expect(native.logIn).toHaveBeenCalledTimes(2);
  });

  it('a successful configuration is memoised across loadPlans/purchase/restore', async () => {
    const native = sdk();
    const client = iosClient(native);
    const plans = await client.loadPlans();
    await client.purchase(plans.annual!.id);
    await client.restore();
    expect(native.configure).toHaveBeenCalledTimes(1);
    expect(native.getAppUserID).toHaveBeenCalledTimes(1);
  });
});

describe('audit: offerings edge cases', () => {
  it('purchasing a plan id from a superseded loadPlans still resolves the package while ids are stable', async () => {
    const native = sdk();
    const client = iosClient(native);
    const first = await client.loadPlans();
    const second = await client.loadPlans();
    expect(second.annual?.id).toBe(first.annual?.id);
    await expect(client.purchase(first.annual!.id)).resolves.toMatchObject({
      premium: true,
    });
  });

  it('an unknown plan id is a retryable offerings_unavailable, not a store call', async () => {
    const native = sdk();
    const client = iosClient(native);
    await client.loadPlans();
    await expect(
      client.purchase('default:annual:nope:nope'),
    ).rejects.toMatchObject({
      code: 'billing.offerings_unavailable',
      retryable: true,
    });
    expect(native.purchasePackage).not.toHaveBeenCalled();
  });

  it('a package with a zero price string or negative price is dropped', async () => {
    const bad = annualPackage();
    bad.product.price = -1;
    const native = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: bad,
          monthly: null,
          lifetime: {
            identifier: '$rc_lifetime',
            packageType: 'LIFETIME',
            product: {
              identifier: 'pickle_sensei_pro_lifetime',
              price: 159.99,
              priceString: '$159.99',
              pricePerMonthString: '$13.33',
              introPrice: { price: 0, cycles: 1, period: 'P7D' },
              defaultOption: null,
            },
          },
        },
      })),
    });
    const plans = await iosClient(native).loadPlans();
    expect(plans.annual).toBeNull();
    expect(plans.lifetime).toMatchObject({
      pricePerMonthString: null,
      freeTrial: null,
    });
  });
});
