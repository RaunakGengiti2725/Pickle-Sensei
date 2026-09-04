/**
 * Structural audit #2 (mobile-billing-paywall) — RevenueCat client probes:
 * SDK error shapes, ISO-8601 trial periods as the installed SDK emits them
 * (react-native-purchases 10.8.1: `PurchasesIntroPrice.period` is a single
 * unit `P<n><D|W|M|Y>`, `PURCHASE_CANCELLED_ERROR = "1"` and the wrapper sets
 * `userCancelled` from it), null-guard surfaces, and the already-configured
 * / different-appUserID `logIn` path.
 */
// The react-native-purchases dist bundle is ESM (not requireable under jest);
// the offerings module it re-exports is CJS and carries the same types.
import {
  PERIOD_UNIT,
  type PricingPhase,
} from '@revenuecat/purchases-typescript-internal/dist/offerings';
import { BillingError } from '../../../src/billing/types';
import {
  createRevenueCatBillingClient,
  type RevenueCatCustomerInfoLike,
  type RevenueCatPackageLike,
  type RevenueCatSdk,
} from '../../../src/billing/revenueCatClient';

const CANONICAL_ID = '2f0f1c58-1e4d-4a8e-9a4b-3c1f2b7d6e5a';
const OTHER_ID = '9b2b7d8e-6c1f-4e2a-8f3d-1a2b3c4d5e6f';

function pkg(
  packageType: 'MONTHLY' | 'ANNUAL' | 'LIFETIME',
  productId: string,
  overrides?: Partial<RevenueCatPackageLike['product']>,
): RevenueCatPackageLike {
  return {
    identifier: `$rc_${packageType.toLowerCase()}`,
    packageType,
    product: {
      identifier: productId,
      price: packageType === 'LIFETIME' ? 159.99 : 7.99,
      priceString: packageType === 'LIFETIME' ? '$159.99' : '$7.99',
      pricePerMonthString: packageType === 'LIFETIME' ? null : '$7.99',
      introPrice: null,
      defaultOption: null,
      ...overrides,
    },
  };
}

function customerInfo(
  active: RevenueCatCustomerInfoLike['entitlements']['active'],
): RevenueCatCustomerInfoLike {
  return { entitlements: { active } };
}

function sdk(overrides?: Partial<RevenueCatSdk>): RevenueCatSdk & {
  configure: jest.Mock;
  logIn: jest.Mock;
  purchasePackage: jest.Mock;
} {
  let configured = false;
  let appUserId = '$RCAnonymousID:abc';
  const base = {
    isConfigured: jest.fn(async () => configured),
    configure: jest.fn(async (c: { apiKey: string; appUserID: string }) => {
      configured = true;
      appUserId = c.appUserID;
    }),
    getAppUserID: jest.fn(async () => appUserId),
    logIn: jest.fn(async (id: string) => {
      appUserId = id;
      return {};
    }),
    getOfferings: jest.fn(async () => ({
      current: {
        identifier: 'default',
        annual: pkg('ANNUAL', 'pickle_sensei_pro_annual', {
          price: 59.99,
          priceString: '$59.99',
          pricePerMonthString: '$5.00',
          introPrice: { price: 0, cycles: 1, period: 'P1W' },
        }),
        monthly: pkg('MONTHLY', 'pickle_sensei_pro_monthly'),
        lifetime: pkg('LIFETIME', 'pickle_sensei_pro_lifetime'),
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
    restorePurchases: jest.fn(async () => customerInfo({})),
    getCustomerInfo: jest.fn(async () => customerInfo({})),
    checkTrialOrIntroductoryPriceEligibility: jest.fn(async (ids: string[]) =>
      Object.fromEntries(ids.map(id => [id, { status: 2 }])),
    ),
  };
  return { ...base, ...overrides } as RevenueCatSdk & {
    configure: jest.Mock;
    logIn: jest.Mock;
    purchasePackage: jest.Mock;
  };
}

function client(native: RevenueCatSdk, platform: 'ios' | 'android' = 'ios') {
  return createRevenueCatBillingClient(
    { publicSdkKey: 'appl_publicKey', canonicalAppUserId: CANONICAL_ID },
    native,
    platform,
  );
}

async function purchaseErrorCode(thrown: unknown): Promise<string> {
  const native = sdk({
    purchasePackage: jest.fn(async () => {
      throw thrown;
    }),
  });
  const store = client(native);
  const plans = await store.loadPlans();
  try {
    await store.purchase(plans.annual!.id);
  } catch (error) {
    expect(error).toBeInstanceOf(BillingError);
    return (error as BillingError).code;
  }
  throw new Error('purchase unexpectedly succeeded');
}

describe('cancellation detection against the installed SDK error shapes', () => {
  it('maps the wrapper shape {code:"1", userCancelled:true} to a silent cancel', async () => {
    const error = Object.assign(new Error('Purchase was cancelled.'), {
      code: '1',
      userCancelled: true,
      userInfo: { readableErrorCode: 'PURCHASE_CANCELLED_ERROR' },
    });
    expect(await purchaseErrorCode(error)).toBe('billing.purchase_cancelled');
  });

  it('maps the bare native code "1" (wrapper flag absent) to a cancel', async () => {
    expect(await purchaseErrorCode({ code: '1' })).toBe(
      'billing.purchase_cancelled',
    );
  });

  it('never treats a non-cancel SDK error as a cancel (store problem stays visible)', async () => {
    // PURCHASE_NOT_ALLOWED_ERROR = "3", PAYMENT_PENDING_ERROR = "20"
    expect(await purchaseErrorCode({ code: '3', userCancelled: false })).toBe(
      'billing.purchase_failed',
    );
    expect(await purchaseErrorCode({ code: '20', userCancelled: false })).toBe(
      'billing.purchase_failed',
    );
    expect(await purchaseErrorCode(new Error('boom'))).toBe(
      'billing.purchase_failed',
    );
    expect(await purchaseErrorCode('cancelled')).toBe(
      'billing.purchase_failed',
    );
    expect(await purchaseErrorCode(null)).toBe('billing.purchase_failed');
  });

  it('does not recognise a numeric code 1 (documents the exact-shape dependency; the SDK emits strings)', async () => {
    expect(await purchaseErrorCode({ code: 1 })).toBe(
      'billing.purchase_failed',
    );
  });
});

describe('ISO-8601 trial periods as emitted by StoreKit via RevenueCat', () => {
  it.each([
    ['P3D', '3-day free trial'],
    ['P1W', '1-week free trial'],
    ['P2W', '2-week free trial'],
    ['P1M', '1-month free trial'],
    ['P1Y', '1-year free trial'],
    ['p7d', '7-day free trial'],
  ])('renders %s as "%s" on iOS when eligible', async (period, label) => {
    const native = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: pkg('ANNUAL', 'pickle_sensei_pro_annual', {
            introPrice: { price: 0, cycles: 1, period },
          }),
          monthly: null,
          lifetime: null,
        },
      })),
    });
    const plans = await client(native).loadPlans();
    expect(plans.annual?.freeTrial?.label).toBe(label);
  });

  it('multiplies cycles into the total (3 × P1W → 3-week free trial)', async () => {
    const native = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: pkg('ANNUAL', 'pickle_sensei_pro_annual', {
            introPrice: { price: 0, cycles: 3, period: 'P1W' },
          }),
          monthly: null,
          lifetime: null,
        },
      })),
    });
    const plans = await client(native).loadPlans();
    expect(plans.annual?.freeTrial).toEqual({
      label: '3-week free trial',
      periodIso8601: 'P3W',
    });
  });

  it('drops the trial claim (standard pricing) for unparseable or zero periods rather than guessing', async () => {
    for (const period of ['P0D', 'PT24H', 'P1W3D', '', '7 days']) {
      const native = sdk({
        getOfferings: jest.fn(async () => ({
          current: {
            identifier: 'default',
            annual: pkg('ANNUAL', 'pickle_sensei_pro_annual', {
              introPrice: { price: 0, cycles: 1, period },
            }),
            monthly: null,
            lifetime: null,
          },
        })),
      });
      const plans = await client(native).loadPlans();
      expect(plans.annual?.freeTrial).toBeNull();
      expect(plans.annual?.priceString).toBe('$7.99');
    }
  });

  it('shows no trial when eligibility is UNKNOWN(0), INELIGIBLE(1), NO_INTRO(3), missing, or throws', async () => {
    for (const status of [0, 1, 3, undefined, 'throw'] as const) {
      const native = sdk({
        checkTrialOrIntroductoryPriceEligibility: jest.fn(async ids => {
          if (status === 'throw') throw new Error('offline');
          if (status === undefined) return {};
          return Object.fromEntries(ids.map(id => [id, { status }]));
        }),
      });
      const plans = await client(native).loadPlans();
      expect(plans.annual?.freeTrial).toBeNull();
    }
  });

  it('a paid intro price (not $0) never renders as a free trial', async () => {
    const native = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: pkg('ANNUAL', 'pickle_sensei_pro_annual', {
            introPrice: { price: 0.99, cycles: 1, period: 'P1W' },
          }),
          monthly: null,
          lifetime: null,
        },
      })),
    });
    const plans = await client(native).loadPlans();
    expect(plans.annual?.freeTrial).toBeNull();
  });
});

describe('Android free-phase shape as the installed SDK types it (PricingPhase.billingPeriod is a Period object)', () => {
  // react-native-purchases 10.8.1: SubscriptionOption.freePhase.billingPeriod
  // is `Period { unit, value, iso8601 }`, not the ISO string the client's
  // RevenueCatPackageLike declares (the `as unknown as RevenueCatSdk` cast at
  // revenueCatClient.ts:138 hides the mismatch from tsc).
  const sdkFreePhase: PricingPhase = {
    billingPeriod: { unit: PERIOD_UNIT.WEEK, value: 1, iso8601: 'P1W' },
    recurrenceMode: null,
    billingCycleCount: 1,
    price: { formatted: '$0.00', amountMicros: 0, currencyCode: 'USD' },
    offerPaymentMode: null,
  };

  function androidOfferings() {
    return {
      current: {
        identifier: 'default',
        annual: {
          ...pkg('ANNUAL', 'pickle_sensei_pro_annual'),
          product: {
            ...pkg('ANNUAL', 'pickle_sensei_pro_annual').product,
            defaultOption: { freePhase: sdkFreePhase },
          },
        } as unknown as RevenueCatPackageLike,
        monthly: pkg('MONTHLY', 'pickle_sensei_pro_monthly'),
        lifetime: null,
      },
    };
  }

  it('loadPlans() on android must not throw a raw TypeError for a real SDK freePhase', async () => {
    const native = sdk({
      getOfferings: jest.fn(async () => androidOfferings()),
    });
    const store = client(native, 'android');
    let thrown: unknown = null;
    try {
      await store.loadPlans();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeInstanceOf(TypeError);
  });

  it('loadPlans() on android reads the trial from Period.iso8601 (1-week free trial)', async () => {
    const native = sdk({
      getOfferings: jest.fn(async () => androidOfferings()),
    });
    const plans = await client(native, 'android').loadPlans();
    expect(plans.annual?.freeTrial).toEqual({
      label: '1-week free trial',
      periodIso8601: 'P1W',
    });
  });

  it('on iOS the same package is unaffected (defaultOption is Google Play only)', async () => {
    const native = sdk({
      getOfferings: jest.fn(async () => androidOfferings()),
    });
    const plans = await client(native, 'ios').loadPlans();
    expect(plans.annual?.freeTrial).toBeNull();
    expect(plans.monthly?.priceString).toBe('$7.99');
  });
});

describe('entitlement extraction null/undefined surfaces', () => {
  it('purchase() with a customerInfo lacking entitlements.active throws a typed BillingError, not a TypeError', async () => {
    const native = sdk({
      purchasePackage: jest.fn(async () => ({
        customerInfo: { entitlements: {} } as RevenueCatCustomerInfoLike,
      })),
    });
    const store = client(native);
    const plans = await store.loadPlans();
    await expect(store.purchase(plans.annual!.id)).rejects.toBeInstanceOf(
      BillingError,
    );
  });

  it('restore() with a malformed customerInfo throws a typed restore_failed error', async () => {
    const native = sdk({
      restorePurchases: jest.fn(
        async () =>
          ({ entitlements: null }) as unknown as RevenueCatCustomerInfoLike,
      ),
    });
    const store = client(native);
    await expect(store.restore()).rejects.toMatchObject({
      code: 'billing.restore_failed',
    });
  });

  it('readEntitlement() (no production caller) leaks a raw TypeError on a malformed customerInfo', async () => {
    const native = sdk({
      getCustomerInfo: jest.fn(
        async () => ({ entitlements: {} }) as RevenueCatCustomerInfoLike,
      ),
    });
    await expect(client(native).readEntitlement()).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('honours the current and legacy entitlement ids and prefers the current one', async () => {
    const native = sdk({
      getCustomerInfo: jest.fn(async () =>
        customerInfo({
          premium: {
            productIdentifier: 'legacy_product',
            expirationDate: '2027-01-01T00:00:00.000Z',
          },
          pickle_sensei_pro: {
            productIdentifier: 'pickle_sensei_pro_lifetime',
            expirationDate: null,
          },
        }),
      ),
    });
    expect(await client(native).readEntitlement()).toEqual({
      premium: true,
      productId: 'pickle_sensei_pro_lifetime',
      expirationDate: null,
    });
  });
});

describe('configure(): SDK already configured for a different appUserID', () => {
  it('calls logIn(canonical) instead of configure() and binds to the canonical UUID', async () => {
    let appUserId = OTHER_ID;
    const native = sdk({
      isConfigured: jest.fn(async () => true),
      getAppUserID: jest.fn(async () => appUserId),
      logIn: jest.fn(async (id: string) => {
        appUserId = id;
        return {};
      }),
    });
    const store = client(native);
    await store.configure();
    expect(native.configure).not.toHaveBeenCalled();
    expect(native.logIn).toHaveBeenCalledWith(CANONICAL_ID);
    expect(await native.getAppUserID()).toBe(CANONICAL_ID);
  });

  it('fails closed when logIn() leaves the SDK bound to the other user, and allows a retry', async () => {
    const native = sdk({
      isConfigured: jest.fn(async () => true),
      getAppUserID: jest.fn(async () => OTHER_ID),
      logIn: jest.fn(async () => ({})),
    });
    const store = client(native);
    await expect(store.configure()).rejects.toMatchObject({
      code: 'billing.unconfigured',
      unconfiguredReason: 'invalid_canonical_app_user_id',
    });
    // The failed configuration promise is not cached; a retry re-attempts.
    await expect(store.configure()).rejects.toBeInstanceOf(BillingError);
    expect(native.logIn).toHaveBeenCalledTimes(2);
  });

  it('skips logIn when the SDK is already bound to the canonical id', async () => {
    const native = sdk({
      isConfigured: jest.fn(async () => true),
      getAppUserID: jest.fn(async () => CANONICAL_ID),
    });
    await client(native).configure();
    expect(native.configure).not.toHaveBeenCalled();
    expect(native.logIn).not.toHaveBeenCalled();
  });

  it('configures once for concurrent callers (loadPlans + purchase share the promise)', async () => {
    const native = sdk();
    const store = client(native);
    await Promise.all([
      store.configure(),
      store.configure(),
      store.loadPlans(),
    ]);
    expect(native.configure).toHaveBeenCalledTimes(1);
    expect(native.configure).toHaveBeenCalledWith({
      apiKey: 'appl_publicKey',
      appUserID: CANONICAL_ID,
    });
  });
});

describe('offerings shape guards', () => {
  it('lifetime-only offering normalises to a single lifetime plan with no /mo and no trial', async () => {
    const native = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: null,
          monthly: null,
          lifetime: pkg('LIFETIME', 'pickle_sensei_pro_lifetime', {
            pricePerMonthString: '$13.33',
            introPrice: { price: 0, cycles: 1, period: 'P1W' },
          }),
        },
      })),
    });
    const plans = await client(native).loadPlans();
    expect(plans.annual).toBeNull();
    expect(plans.monthly).toBeNull();
    expect(plans.lifetime).toMatchObject({
      period: 'lifetime',
      pricePerMonthString: null,
      freeTrial: null,
      priceString: '$159.99',
    });
  });

  it('a package under the wrong slot (MONTHLY type in the annual slot) is dropped, not mislabelled', async () => {
    const native = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: pkg('MONTHLY', 'pickle_sensei_pro_monthly'),
          monthly: pkg('MONTHLY', 'pickle_sensei_pro_monthly'),
          lifetime: null,
        },
      })),
    });
    const plans = await client(native).loadPlans();
    expect(plans.annual).toBeNull();
    expect(plans.monthly?.productId).toBe('pickle_sensei_pro_monthly');
  });

  it('rejects products with a non-finite/negative price or empty priceString (never invents a price)', async () => {
    const native = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: pkg('ANNUAL', 'pickle_sensei_pro_annual', {
            price: Number.NaN,
          }),
          monthly: pkg('MONTHLY', 'pickle_sensei_pro_monthly', {
            priceString: '',
          }),
          lifetime: pkg('LIFETIME', 'pickle_sensei_pro_lifetime', {
            price: -1,
          }),
        },
      })),
    });
    await expect(client(native).loadPlans()).rejects.toMatchObject({
      code: 'billing.offerings_unavailable',
      retryable: true,
    });
  });

  it('purchase() with a plan id from a previous offerings load still resolves after reload (deterministic ids)', async () => {
    const native = sdk();
    const store = client(native);
    const first = await store.loadPlans();
    await store.loadPlans();
    await expect(store.purchase(first.annual!.id)).resolves.toMatchObject({
      premium: true,
    });
    expect(native.purchasePackage).toHaveBeenCalledTimes(1);
  });

  it('purchase() with an unknown plan id fails typed and retryable without touching StoreKit', async () => {
    const native = sdk();
    const store = client(native);
    await store.loadPlans();
    await expect(
      store.purchase('default:annual:nope:nope'),
    ).rejects.toMatchObject({
      code: 'billing.offerings_unavailable',
      retryable: true,
    });
    expect(native.purchasePackage).not.toHaveBeenCalled();
  });
});
