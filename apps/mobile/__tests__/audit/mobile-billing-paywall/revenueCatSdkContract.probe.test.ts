/**
 * Execution-audit probes for the RevenueCat adapter
 * (src/billing/revenueCatClient.ts) against the INSTALLED
 * react-native-purchases package: the hand-written `RevenueCatSdk` interface
 * must be satisfiable by the real `Purchases` class (checked by tsc over
 * this file), the error / eligibility constants the adapter hardcodes must
 * match the SDK's generated enums, and every store-side failure path must
 * surface as a typed BillingError.
 */
import type Purchases from 'react-native-purchases';
// The CJS internals package carries the generated enums react-native-purchases
// re-exports; the wrapper itself cannot be required under this repo's Jest
// config (see the OBSERVED test below).
import {
  INTRO_ELIGIBILITY_STATUS,
  PURCHASES_ERROR_CODE,
} from '@revenuecat/purchases-typescript-internal';
import {
  BillingError,
  createRevenueCatBillingClient,
  type CanonicalAccessState,
  type RevenueCatCustomerInfoLike,
  type RevenueCatPackageLike,
  type RevenueCatSdk,
} from '../../../src/billing';
import type { BillingAccessDependencies } from '../../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../../src/state/accessStore';

// Type-level contract, member by member: does the installed SDK's method
// type satisfy the adapter's hand-written structural interface? Production
// hides any drift behind `module.default as unknown as RevenueCatSdk`
// (revenueCatClient.ts loadNativeSdk), so this is the only place it shows.
// Checked by `npx tsc --noEmit` over this file.
type Sdk = typeof Purchases;
type Satisfies<K extends keyof RevenueCatSdk> = Sdk[K] extends RevenueCatSdk[K]
  ? 'ok'
  : 'MISMATCH';
const sdkContract: {
  isConfigured: Satisfies<'isConfigured'>;
  configure: Satisfies<'configure'>;
  getAppUserID: Satisfies<'getAppUserID'>;
  logIn: Satisfies<'logIn'>;
  restorePurchases: Satisfies<'restorePurchases'>;
  getCustomerInfo: Satisfies<'getCustomerInfo'>;
  checkTrialOrIntroductoryPriceEligibility: Satisfies<'checkTrialOrIntroductoryPriceEligibility'>;
  // OBSERVED: PurchasesPackage.product.defaultOption.freePhase.billingPeriod
  // is a `Period` object ({unit, value, iso8601}) in react-native-purchases
  // 10.8.1, but RevenueCatPricingPhaseLike declares it as `string`.
  getOfferings: Satisfies<'getOfferings'>;
  purchasePackage: Satisfies<'purchasePackage'>;
} = {
  isConfigured: 'ok',
  configure: 'ok',
  getAppUserID: 'ok',
  logIn: 'ok',
  restorePurchases: 'ok',
  getCustomerInfo: 'ok',
  checkTrialOrIntroductoryPriceEligibility: 'ok',
  getOfferings: 'MISMATCH',
  purchasePackage: 'MISMATCH',
};

const CANONICAL = '11111111-1111-4111-8111-111111111111';

const freshAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 0,
    reserved: 0,
    remaining: 2,
    availableToReserve: 2,
  },
  canStartRating: true,
  paywallRequired: false,
};

function customerInfo(
  active: Record<string, unknown> = {},
): RevenueCatCustomerInfoLike {
  return {
    entitlements: { active },
  } as unknown as RevenueCatCustomerInfoLike;
}

function pkg(
  period: 'ANNUAL' | 'MONTHLY' | 'LIFETIME' | 'CUSTOM',
  options: {
    identifier?: string;
    intro?: { price: number; cycles: number; period: string } | null;
  } = {},
): RevenueCatPackageLike {
  const productIds = {
    ANNUAL: 'pickle_sensei_pro_annual',
    MONTHLY: 'pickle_sensei_pro_monthly',
    LIFETIME: 'pickle_sensei_pro_lifetime',
    CUSTOM: 'pickle_sensei_pro_custom',
  };
  return {
    identifier: options.identifier ?? `$rc_${period.toLowerCase()}`,
    packageType: period,
    product: {
      identifier: productIds[period],
      price: 59.99,
      priceString: '$59.99',
      pricePerMonthString: '$5.00',
      introPrice: options.intro ?? null,
      defaultOption: null,
    },
  } as unknown as RevenueCatPackageLike;
}

type SdkMock = { [K in keyof RevenueCatSdk]: jest.Mock };

function sdk(overrides: Partial<SdkMock> = {}): SdkMock {
  return {
    isConfigured: jest.fn(async () => false),
    configure: jest.fn(async () => undefined),
    getAppUserID: jest.fn(async () => CANONICAL),
    logIn: jest.fn(async () => ({})),
    getOfferings: jest.fn(async () => ({
      current: {
        identifier: 'default',
        annual: pkg('ANNUAL'),
        monthly: pkg('MONTHLY'),
        lifetime: pkg('LIFETIME'),
      },
    })),
    purchasePackage: jest.fn(async () => ({ customerInfo: customerInfo() })),
    restorePurchases: jest.fn(async () => customerInfo()),
    getCustomerInfo: jest.fn(async () => customerInfo()),
    checkTrialOrIntroductoryPriceEligibility: jest.fn(async () => ({})),
    ...overrides,
  };
}

const ANNUAL_PLAN_ID = 'default:annual:$rc_annual:pickle_sensei_pro_annual';

function client(
  native: SdkMock,
  platform: 'ios' | 'android' | 'other' = 'ios',
) {
  return createRevenueCatBillingClient(
    { publicSdkKey: 'appl_test_public_key', canonicalAppUserId: CANONICAL },
    native as unknown as RevenueCatSdk,
    platform,
  );
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

describe('installed SDK constants the adapter hardcodes', () => {
  test('OBSERVED: the real Purchases class satisfies RevenueCatSdk for every member EXCEPT the package shape (getOfferings/purchasePackage)', () => {
    expect(sdkContract).toEqual({
      isConfigured: 'ok',
      configure: 'ok',
      getAppUserID: 'ok',
      logIn: 'ok',
      restorePurchases: 'ok',
      getCustomerInfo: 'ok',
      checkTrialOrIntroductoryPriceEligibility: 'ok',
      getOfferings: 'MISMATCH',
      purchasePackage: 'MISMATCH',
    });
  });

  test('OBSERVED: react-native-purchases 10.8.1 cannot be required under the repo Jest config (ESM @revenuecat/purchases-js-hybrid-mappings is not transformed)', () => {
    let failure: unknown = null;
    try {
      jest.requireActual('react-native-purchases');
    } catch (error) {
      failure = error;
    }
    // The error is constructed inside Jest's module vm realm, so compare by
    // name rather than instanceof.
    expect((failure as Error).name).toBe('SyntaxError');
    expect(String((failure as Error).message)).toMatch(
      /Unexpected token 'export'/,
    );
  });

  test('OBSERVED: with no injected SDK, initialize() maps the module-load failure to billing.unconfigured and keeps server access', async () => {
    const deps: BillingAccessDependencies = {
      store: createRevenueCatBillingClient(
        { publicSdkKey: 'appl_test_public_key', canonicalAppUserId: CANONICAL },
        undefined,
        'ios',
      ),
      backend: {
        getAccess: jest.fn(async () => freshAccess),
        syncBilling: jest.fn(),
      },
    };
    configureAccessStore(deps);
    try {
      await useAccessStore.getState().initialize();
      const state = useAccessStore.getState();
      expect(state.status).toBe('unconfigured');
      expect(state.error?.code).toBe('billing.unconfigured');
      expect(state.error?.message).toBe(
        'RevenueCat could not start in this build.',
      );
      expect(state.plans).toBeNull();
      expect(state.canonicalAccess?.canStartRating).toBe(true);
    } finally {
      clearAccessStoreConfiguration();
    }
  });

  test('PURCHASE_CANCELLED_ERROR is the string "1" the adapter matches on', () => {
    expect(PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR).toBe('1');
  });

  test('INTRO_ELIGIBILITY_STATUS_ELIGIBLE is 2 (adapter constant ELIGIBLE_FOR_INTRO_OFFER)', () => {
    expect(INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE).toBe(2);
    expect(INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_UNKNOWN).toBe(0);
  });
});

describe('configure()', () => {
  test('rejects a RevenueCat SECRET key before touching the SDK', async () => {
    const native = sdk();
    const store = createRevenueCatBillingClient(
      { publicSdkKey: 'sk_live_secret', canonicalAppUserId: CANONICAL },
      native as unknown as RevenueCatSdk,
      'ios',
    );
    const error = await billingErrorOf(store.configure());
    expect(error.code).toBe('billing.unconfigured');
    expect(error.retryable).toBe(false);
    expect(error.unconfiguredReason).toBe('secret_key_supplied_to_client');
    expect(native.configure).not.toHaveBeenCalled();
  });

  test('rejects a non-UUID canonical id (provider subject) before touching the SDK', async () => {
    const native = sdk();
    const store = createRevenueCatBillingClient(
      { publicSdkKey: 'appl_x', canonicalAppUserId: '001234.abcdef.5678' },
      native as unknown as RevenueCatSdk,
      'ios',
    );
    const error = await billingErrorOf(store.configure());
    expect(error.unconfiguredReason).toBe('invalid_canonical_app_user_id');
    expect(native.configure).not.toHaveBeenCalled();
  });

  test('already configured for another app user → logIn, then verified; mismatch after logIn is fatal', async () => {
    const native = sdk({
      isConfigured: jest.fn(async () => true),
      getAppUserID: jest
        .fn()
        .mockResolvedValueOnce('$RCAnonymousID:abc')
        .mockResolvedValueOnce(CANONICAL),
    });
    await client(native).configure();
    expect(native.logIn).toHaveBeenCalledWith(CANONICAL);
    expect(native.configure).not.toHaveBeenCalled();

    const stuck = sdk({
      isConfigured: jest.fn(async () => true),
      getAppUserID: jest.fn(async () => '$RCAnonymousID:abc'),
    });
    const error = await billingErrorOf(client(stuck).configure());
    expect(error.code).toBe('billing.unconfigured');
    expect(error.unconfiguredReason).toBe('invalid_canonical_app_user_id');
  });

  test('a failed configure() is not cached: the next call retries the SDK', async () => {
    const native = sdk({
      configure: jest
        .fn()
        .mockRejectedValueOnce(new Error('native module missing'))
        .mockResolvedValueOnce(undefined),
    });
    const store = client(native);
    // The raw SDK error is propagated as-is here; accessStore.initialize maps
    // it to billing.unconfigured.
    await expect(store.configure()).rejects.toThrow('native module missing');
    await expect(store.configure()).resolves.toBeUndefined();
    expect(native.configure).toHaveBeenCalledTimes(2);
  });

  test('a successful configure() is cached across loadPlans/purchase/restore', async () => {
    const native = sdk();
    const store = client(native);
    await store.loadPlans();
    await store.purchase(ANNUAL_PLAN_ID);
    await store.restore();
    await store.readEntitlement();
    expect(native.configure).toHaveBeenCalledTimes(1);
  });
});

describe('loadPlans() empty / malformed offerings', () => {
  test('no current offering → offerings_unavailable (retryable)', async () => {
    const native = sdk({
      getOfferings: jest.fn(async () => ({ current: null })),
    });
    const error = await billingErrorOf(client(native).loadPlans());
    expect(error.code).toBe('billing.offerings_unavailable');
    expect(error.retryable).toBe(true);
  });

  test('offering whose packages are all null → offerings_unavailable', async () => {
    const native = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: null,
          monthly: null,
          lifetime: null,
        },
      })),
    });
    const error = await billingErrorOf(client(native).loadPlans());
    expect(error.code).toBe('billing.offerings_unavailable');
  });

  test('a package slotted as annual but typed CUSTOM is dropped (AGENTS.md: standard types only)', async () => {
    const native = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: pkg('CUSTOM', { identifier: 'yearly_custom' }),
          monthly: pkg('MONTHLY'),
          lifetime: null,
        },
      })),
    });
    const plans = await client(native).loadPlans();
    expect(plans.annual).toBeNull();
    expect(plans.monthly?.period).toBe('monthly');
    expect(plans.lifetime).toBeNull();
  });

  test('getOfferings rejecting propagates the RAW SDK error from loadPlans(); accessStore maps it to offerings_unavailable', async () => {
    const native = sdk({
      getOfferings: jest.fn(async () => {
        throw Object.assign(new Error('offline'), { code: '10' });
      }),
    });
    await expect(client(native).loadPlans()).rejects.toThrow('offline');
    configureAccessStore({
      store: client(native),
      backend: {
        getAccess: jest.fn(async () => freshAccess),
        syncBilling: jest.fn(),
      },
    });
    try {
      await useAccessStore.getState().initialize();
      const state = useAccessStore.getState();
      expect(state.status).toBe('error');
      expect(state.error?.code).toBe('billing.offerings_unavailable');
      expect(state.error?.retryable).toBe(true);
      expect(state.canonicalAccess?.canStartRating).toBe(true);
    } finally {
      clearAccessStoreConfiguration();
    }
  });

  test('trial eligibility UNKNOWN (0) or a rejected eligibility call renders standard pricing (no trial claim)', async () => {
    const withIntro = pkg('ANNUAL', {
      intro: { price: 0, cycles: 1, period: 'P7D' },
    });
    const unknown = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: withIntro,
          monthly: null,
          lifetime: null,
        },
      })),
      checkTrialOrIntroductoryPriceEligibility: jest.fn(async () => ({
        [withIntro.product.identifier]: { status: 0 },
      })),
    });
    expect((await client(unknown).loadPlans()).annual?.freeTrial).toBeNull();

    const rejecting = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: withIntro,
          monthly: null,
          lifetime: null,
        },
      })),
      checkTrialOrIntroductoryPriceEligibility: jest.fn(async () => {
        throw new Error('eligibility unavailable');
      }),
    });
    expect((await client(rejecting).loadPlans()).annual?.freeTrial).toBeNull();

    const eligible = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: withIntro,
          monthly: null,
          lifetime: null,
        },
      })),
      checkTrialOrIntroductoryPriceEligibility: jest.fn(async () => ({
        [withIntro.product.identifier]: { status: 2 },
      })),
    });
    expect((await client(eligible).loadPlans()).annual?.freeTrial).toEqual({
      label: '7-day free trial',
      periodIso8601: 'P7D',
    });
  });

  test('a PAID intro price (not a free trial) is never shown as a trial', async () => {
    const paidIntro = pkg('ANNUAL', {
      intro: { price: 9.99, cycles: 1, period: 'P1M' },
    });
    const native = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: paidIntro,
          monthly: null,
          lifetime: null,
        },
      })),
      checkTrialOrIntroductoryPriceEligibility: jest.fn(async () => ({
        [paidIntro.product.identifier]: { status: 2 },
      })),
    });
    expect((await client(native).loadPlans()).annual?.freeTrial).toBeNull();
  });
});

describe('purchase() / restore() failure mapping with real SDK error shapes', () => {
  test('SDK error {code:"1", userCancelled:true} → purchase_cancelled (non-retryable)', async () => {
    const native = sdk({
      purchasePackage: jest.fn(async () => {
        throw {
          code: PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR,
          message: 'Purchase was cancelled.',
          userCancelled: true,
          readableErrorCode: 'PURCHASE_CANCELLED_ERROR',
          userInfo: { readableErrorCode: 'PURCHASE_CANCELLED_ERROR' },
          underlyingErrorMessage: '',
        };
      }),
    });
    const store = client(native);
    await store.loadPlans();
    const error = await billingErrorOf(store.purchase(ANNUAL_PLAN_ID));
    expect(error.code).toBe('billing.purchase_cancelled');
    expect(error.retryable).toBe(false);
  });

  test('SDK error {code:"2"} (store problem) → purchase_failed retryable', async () => {
    const native = sdk({
      purchasePackage: jest.fn(async () => {
        throw {
          code: PURCHASES_ERROR_CODE.STORE_PROBLEM_ERROR,
          message: 'store',
        };
      }),
    });
    const store = client(native);
    await store.loadPlans();
    const error = await billingErrorOf(store.purchase(ANNUAL_PLAN_ID));
    expect(error.code).toBe('billing.purchase_failed');
    expect(error.retryable).toBe(true);
  });

  test('purchase(planId) for a plan id not returned by loadPlans() → offerings_unavailable, SDK not called', async () => {
    const native = sdk();
    const store = client(native);
    await store.loadPlans();
    const error = await billingErrorOf(
      store.purchase('default:annual:$rc_annual:pickle_sensei_pro_yearly'),
    );
    expect(error.code).toBe('billing.offerings_unavailable');
    expect(native.purchasePackage).not.toHaveBeenCalled();
  });

  test('purchase() before loadPlans() → offerings_unavailable (package map empty)', async () => {
    const native = sdk();
    const error = await billingErrorOf(client(native).purchase(ANNUAL_PLAN_ID));
    expect(error.code).toBe('billing.offerings_unavailable');
    expect(native.purchasePackage).not.toHaveBeenCalled();
  });

  test('purchase() success maps the store entitlement (pickle_sensei_pro or legacy premium) — local state only', async () => {
    const native = sdk({
      purchasePackage: jest.fn(async () => ({
        customerInfo: customerInfo({
          pickle_sensei_pro: {
            productIdentifier: 'pickle_sensei_pro_annual',
            expirationDate: '2027-09-01T00:00:00.000Z',
          },
        }),
      })),
    });
    const store = client(native);
    await store.loadPlans();
    const state = await store.purchase(ANNUAL_PLAN_ID);
    expect(state).toEqual({
      premium: true,
      productId: 'pickle_sensei_pro_annual',
      expirationDate: '2027-09-01T00:00:00.000Z',
    });
  });

  test('restore() with no active entitlement returns premium=false (does not throw)', async () => {
    const native = sdk();
    const state = await client(native).restore();
    expect(state).toEqual({
      premium: false,
      productId: null,
      expirationDate: null,
    });
  });

  test('restore() SDK rejection → restore_failed retryable', async () => {
    const native = sdk({
      restorePurchases: jest.fn(async () => {
        throw { code: PURCHASES_ERROR_CODE.NETWORK_ERROR, message: 'offline' };
      }),
    });
    const error = await billingErrorOf(client(native).restore());
    expect(error.code).toBe('billing.restore_failed');
    expect(error.retryable).toBe(true);
  });

  test('an unrelated active entitlement never unlocks', async () => {
    const native = sdk({
      getCustomerInfo: jest.fn(async () =>
        customerInfo({
          some_other_app_entitlement: {
            productIdentifier: 'x',
            expirationDate: null,
          },
        }),
      ),
    });
    expect((await client(native).readEntitlement()).premium).toBe(false);
  });
});

describe('platform gating', () => {
  test('OBSERVED: platform "other" (neither ios nor android) still configures the SDK; only trial detection is gated', async () => {
    const native = sdk();
    await client(native, 'other').configure();
    expect(native.configure).toHaveBeenCalledTimes(1);
    const withIntro = pkg('ANNUAL', {
      intro: { price: 0, cycles: 1, period: 'P7D' },
    });
    const trial = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: withIntro,
          monthly: null,
          lifetime: null,
        },
      })),
      checkTrialOrIntroductoryPriceEligibility: jest.fn(async () => ({
        [withIntro.product.identifier]: { status: 2 },
      })),
    });
    expect(
      (await client(trial, 'other').loadPlans()).annual?.freeTrial,
    ).toBeNull();
    expect(
      trial.checkTrialOrIntroductoryPriceEligibility,
    ).not.toHaveBeenCalled();
  });

  test('OBSERVED: android freePhase.billingPeriod shaped like the real SDK (`Period` object) makes loadPlans() throw a TypeError (offerings_unavailable in the store)', async () => {
    // Shape per @revenuecat/purchases-typescript-internal offerings.d.ts:
    // PricingPhase.billingPeriod: Period = { unit, value, iso8601 }.
    const sdkShapedPkg = {
      ...pkg('ANNUAL'),
      product: {
        ...pkg('ANNUAL').product,
        defaultOption: {
          freePhase: {
            billingPeriod: { unit: 'WEEK', value: 1, iso8601: 'P1W' },
            billingCycleCount: 1,
            price: { amountMicros: 0, currencyCode: 'USD', formatted: '$0.00' },
          },
        },
      },
    } as unknown as RevenueCatPackageLike;
    const native = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: sdkShapedPkg,
          monthly: null,
          lifetime: null,
        },
      })),
    });
    await expect(client(native, 'android').loadPlans()).rejects.toThrow(
      /toUpperCase is not a function/,
    );
    // The same package on iOS is unaffected (iOS reads introPrice.period: string).
    await expect(client(native, 'ios').loadPlans()).resolves.toMatchObject({
      annual: { freeTrial: null },
    });
  });

  test('android trial comes from defaultOption.freePhase (string billingPeriod, as the adapter types it), not iOS eligibility', async () => {
    const androidPkg = {
      ...pkg('ANNUAL'),
      product: {
        ...pkg('ANNUAL').product,
        defaultOption: {
          freePhase: {
            billingPeriod: 'P1W',
            billingCycleCount: 1,
            price: { amountMicros: 0 },
          },
        },
      },
    } as unknown as RevenueCatPackageLike;
    const native = sdk({
      getOfferings: jest.fn(async () => ({
        current: {
          identifier: 'default',
          annual: androidPkg,
          monthly: null,
          lifetime: null,
        },
      })),
    });
    const plans = await client(native, 'android').loadPlans();
    expect(plans.annual?.freeTrial).toEqual({
      label: '1-week free trial',
      periodIso8601: 'P1W',
    });
    expect(
      native.checkTrialOrIntroductoryPriceEligibility,
    ).not.toHaveBeenCalled();
  });
});
