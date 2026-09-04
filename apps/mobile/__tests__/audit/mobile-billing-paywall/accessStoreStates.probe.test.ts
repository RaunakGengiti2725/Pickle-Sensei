/**
 * Execution-audit probes for the server-authoritative access store
 * (src/state/accessStore.ts). Each test drives one loading / failure /
 * stale / missing-data path through the REAL store with controllable fake
 * billing dependencies and pins the behaviour that was observed on
 * 4d812e1a. Tests whose name starts with "OBSERVED:" document behaviour the
 * audit reports as a finding — they are evidence, not an endorsement.
 */
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  CanonicalBillingSync,
  StoreEntitlementState,
  StorePlans,
} from '../../../src/billing';
import { BillingError } from '../../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectCanStartRating,
  selectHasPremium,
  selectPaywallRequired,
  useAccessStore,
} from '../../../src/state/accessStore';

function access(overrides: Partial<CanonicalAccessState> = {}) {
  const base: CanonicalAccessState = {
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
  return { ...base, ...overrides };
}

const freeTwoLeft = access();
const freeOneLeft = access({
  freeRatings: {
    limit: 2,
    used: 1,
    reserved: 0,
    remaining: 1,
    availableToReserve: 1,
  },
});
const exhausted = access({
  freeRatings: {
    limit: 2,
    used: 2,
    reserved: 0,
    remaining: 0,
    availableToReserve: 0,
  },
  canStartRating: false,
  paywallRequired: true,
});
const paid = access({
  premium: true,
  entitlements: ['premium', 'pickle_sensei_pro'],
  freeRatings: {
    limit: 2,
    used: 2,
    reserved: 0,
    remaining: 0,
    availableToReserve: 0,
  },
});

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual-plan',
    productId: 'pickle_sensei_pro_annual',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: {
    id: 'monthly-plan',
    productId: 'pickle_sensei_pro_monthly',
    period: 'monthly',
    price: 7.99,
    priceString: '$7.99',
    pricePerMonthString: '$7.99',
    freeTrial: null,
  },
  lifetime: {
    id: 'lifetime-plan',
    productId: 'pickle_sensei_pro_lifetime',
    period: 'lifetime',
    price: 159.99,
    priceString: '$159.99',
    pricePerMonthString: null,
    freeTrial: null,
  },
};

const storeEntitlement: StoreEntitlementState = {
  premium: true,
  productId: 'pickle_sensei_pro_annual',
  expirationDate: null,
};

function sync(state: CanonicalAccessState): CanonicalBillingSync {
  return {
    billing: {
      premium: state.premium,
      productKey: state.premium ? 'pickle_sensei_pro_annual' : null,
      expiresAt: null,
      verifiedAt: '2026-09-01T00:00:00.000Z',
    },
    access: state,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const never = <T>() => new Promise<T>(() => undefined);

type Deps = {
  store: {
    configure: jest.Mock<Promise<void>, []>;
    loadPlans: jest.Mock<Promise<StorePlans>, []>;
    purchase: jest.Mock<Promise<StoreEntitlementState>, [string]>;
    restore: jest.Mock<Promise<StoreEntitlementState>, []>;
    readEntitlement: jest.Mock<Promise<StoreEntitlementState>, []>;
  };
  backend: {
    getAccess: jest.Mock<Promise<CanonicalAccessState>, []>;
    syncBilling: jest.Mock<Promise<CanonicalBillingSync>, []>;
  };
};

function deps(): Deps & BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn<Promise<StoreEntitlementState>, [string]>(
        async () => storeEntitlement,
      ),
      restore: jest.fn(async () => storeEntitlement),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(async () => freeTwoLeft),
      syncBilling: jest.fn(async () => sync(paid)),
    },
  };
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

afterEach(() => {
  clearAccessStoreConfiguration();
});

describe('loading state', () => {
  test('OBSERVED: a backend access request that never settles leaves status=loading with no way to retry', async () => {
    const d = deps();
    d.backend.getAccess.mockImplementation(() => never());
    configureAccessStore(d);
    const store = useAccessStore.getState();
    void store.initialize();
    await settle();
    expect(useAccessStore.getState().status).toBe('loading');
    // A second initialize() is a no-op while loading: the Paywall Retry
    // button is hidden in this state and the rating gate shows
    // "Checking access…" until the platform network stack gives up.
    await useAccessStore.getState().initialize();
    expect(d.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().status).toBe('loading');
    expect(selectPaywallRequired(useAccessStore.getState())).toBe(true);
    expect(selectCanStartRating(useAccessStore.getState())).toBe(false);
  });

  test('OBSERVED: a hung refreshAccess() keeps status=loading; Settings skips further refreshes while loading', async () => {
    const d = deps();
    configureAccessStore(d);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().status).toBe('ready');
    d.backend.getAccess.mockImplementation(() => never());
    void useAccessStore.getState().refreshAccess();
    await settle();
    const state = useAccessStore.getState();
    expect(state.status).toBe('loading');
    // The previous snapshot stays on screen (documented) …
    expect(state.canonicalAccess).toEqual(freeTwoLeft);
    // … but every later initialize() is swallowed by the loading guard.
    await state.initialize();
    expect(d.backend.getAccess).toHaveBeenCalledTimes(2);
  });

  test('a store SDK configure() that never settles blocks the backend access read too', async () => {
    const d = deps();
    d.store.configure.mockImplementation(() => never());
    configureAccessStore(d);
    void useAccessStore.getState().initialize();
    await settle();
    expect(useAccessStore.getState().status).toBe('loading');
    // getAccess is sequenced AFTER store.configure(), so a hung RevenueCat
    // start also withholds the server-verified free allowance.
    expect(d.backend.getAccess).not.toHaveBeenCalled();
  });
});

describe('failure states (fail closed)', () => {
  test('backend failure clears canonical access even when the store loaded plans', async () => {
    const d = deps();
    d.backend.getAccess.mockRejectedValue(
      new TypeError('Network request failed'),
    );
    configureAccessStore(d);
    await useAccessStore.getState().initialize();
    const state = useAccessStore.getState();
    expect(state.status).toBe('error');
    expect(state.canonicalAccess).toBeNull();
    expect(state.plans).toEqual(plans);
    expect(state.error?.code).toBe('billing.backend_unavailable');
    expect(selectPaywallRequired(state)).toBe(true);
  });

  test('store failure keeps the verified free allowance and blocks purchase presentation', async () => {
    const d = deps();
    d.store.loadPlans.mockRejectedValue(
      new BillingError('billing.offerings_unavailable', 'no offering', true),
    );
    configureAccessStore(d);
    await useAccessStore.getState().initialize();
    const state = useAccessStore.getState();
    expect(state.status).toBe('error');
    expect(state.canonicalAccess).toEqual(freeTwoLeft);
    expect(state.plans).toBeNull();
    expect(selectCanStartRating(state)).toBe(true);
    // purchase with no plan is refused, and the free allowance survives
    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.offerings_unavailable',
    );
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeTwoLeft);
  });

  test('a transient refreshAccess() failure drops a PAID member to fail-closed (paywall required) until retry', async () => {
    const d = deps();
    d.backend.getAccess.mockResolvedValueOnce(paid);
    configureAccessStore(d);
    await useAccessStore.getState().initialize();
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    d.backend.getAccess.mockRejectedValueOnce(
      new BillingError('billing.backend_unavailable', 'unavailable', true),
    );
    expect(await useAccessStore.getState().refreshAccess()).toBe(false);
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toBeNull();
    expect(selectHasPremium(state)).toBe(false);
    expect(selectPaywallRequired(state)).toBe(true);
    // recoverable: the next refresh restores access
    d.backend.getAccess.mockResolvedValueOnce(paid);
    expect(await useAccessStore.getState().refreshAccess()).toBe(true);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
  });

  test('purchase whose backend verification throws clears access; Retry then re-enables Continue with no restore hint', async () => {
    const d = deps();
    configureAccessStore(d);
    await useAccessStore.getState().initialize();
    d.backend.syncBilling.mockRejectedValueOnce(
      new BillingError('billing.backend_unavailable', 'down', true),
    );
    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    let state = useAccessStore.getState();
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    expect(state.canonicalAccess).toBeNull();
    // Retry (initialize) re-reads access; the webhook may not have landed yet
    d.backend.getAccess.mockResolvedValueOnce(freeTwoLeft);
    await useAccessStore.getState().initialize();
    state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(selectHasPremium(state)).toBe(false);
    // Continue is purchasable again (canonicalAccess + plan present); the
    // "Try Restore purchases" guidance is gone.
    expect(Boolean(state.canonicalAccess && state.plans?.annual)).toBe(true);
  });

  test('purchase verified non-premium by the backend keeps the snapshot and reports verification pending', async () => {
    const d = deps();
    configureAccessStore(d);
    await useAccessStore.getState().initialize();
    d.backend.syncBilling.mockResolvedValueOnce(sync(freeTwoLeft));
    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    const state = useAccessStore.getState();
    expect(state.status).toBe('error');
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    expect(state.canonicalAccess).toEqual(freeTwoLeft);
    expect(selectHasPremium(state)).toBe(false);
  });

  test('user-cancelled purchase leaves no error and keeps access', async () => {
    const d = deps();
    configureAccessStore(d);
    await useAccessStore.getState().initialize();
    d.store.purchase.mockRejectedValueOnce(
      new BillingError('billing.purchase_cancelled', 'cancelled', false),
    );
    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    const state = useAccessStore.getState();
    expect(state.error).toBeNull();
    expect(state.operation).toBe('idle');
    expect(state.canonicalAccess).toEqual(freeTwoLeft);
    expect(d.backend.syncBilling).not.toHaveBeenCalled();
  });

  test('restore that the backend verifies as non-premium is non-retryable and keeps the snapshot', async () => {
    const d = deps();
    configureAccessStore(d);
    await useAccessStore.getState().initialize();
    d.backend.syncBilling.mockResolvedValueOnce(sync(freeOneLeft));
    expect(await useAccessStore.getState().restorePurchases()).toBe(false);
    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.error?.code).toBe('billing.restore_failed');
    expect(state.error?.retryable).toBe(false);
    expect(state.canonicalAccess).toEqual(freeOneLeft);
  });

  test('restore whose backend verification throws clears access (fail closed) and is retryable', async () => {
    const d = deps();
    configureAccessStore(d);
    await useAccessStore.getState().initialize();
    d.backend.syncBilling.mockRejectedValueOnce(new Error('boom'));
    expect(await useAccessStore.getState().restorePurchases()).toBe(false);
    const state = useAccessStore.getState();
    expect(state.status).toBe('error');
    expect(state.canonicalAccess).toBeNull();
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    expect(state.error?.retryable).toBe(true);
  });
});

describe('stale and concurrent responses', () => {
  test('OBSERVED: an older in-flight refreshAccess() response overwrites a newer one (last writer wins, no sequencing)', async () => {
    const d = deps();
    configureAccessStore(d);
    await useAccessStore.getState().initialize();
    const slowOld = deferred<CanonicalAccessState>();
    const fastNew = deferred<CanonicalAccessState>();
    d.backend.getAccess
      .mockImplementationOnce(() => slowOld.promise)
      .mockImplementationOnce(() => fastNew.promise);
    // 1) Settings focus starts a refresh (status: loading)
    const first = useAccessStore.getState().refreshAccess();
    // 2) AnalyzeScreen unmount cleanup refreshes too (it only skips 'idle')
    const second = useAccessStore.getState().refreshAccess();
    expect(d.backend.getAccess).toHaveBeenCalledTimes(3);
    // The newer request returns the post-scoring ledger first …
    fastNew.resolve(freeOneLeft);
    await second;
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeOneLeft);
    // … then the older request lands with the pre-scoring ledger.
    slowOld.resolve(freeTwoLeft);
    await first;
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeTwoLeft);
    expect(useAccessStore.getState().status).toBe('ready');
  });

  test('OBSERVED: a refreshAccess() still in flight when a purchase is verified lands afterwards and reverts premium=true to the pre-purchase snapshot', async () => {
    const d = deps();
    configureAccessStore(d);
    await useAccessStore.getState().initialize();
    const slowRefresh = deferred<CanonicalAccessState>();
    d.backend.getAccess.mockImplementationOnce(() => slowRefresh.promise);
    // AnalyzeScreen unmount cleanup refresh (no client deadline) is in flight …
    const refresh = useAccessStore.getState().refreshAccess();
    await settle();
    expect(useAccessStore.getState().status).toBe('loading');
    // … the snapshot is still present, so PaywallScreen's Continue is enabled
    // (canPurchase = selectedPlan && canonicalAccess) and the purchase proceeds.
    d.backend.syncBilling.mockResolvedValueOnce(sync(paid));
    expect(await useAccessStore.getState().purchaseSelected()).toBe(true);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    // The pre-purchase refresh response now lands and wins.
    slowRefresh.resolve(exhausted);
    await refresh;
    const state = useAccessStore.getState();
    expect(state.canonicalAccess?.premium).toBe(false);
    expect(state.canonicalAccess?.paywallRequired).toBe(true);
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
  });

  test('OBSERVED: a slow initialize() access read lands after a newer refreshAccess() and overwrites it', async () => {
    const d = deps();
    const slowInit = deferred<CanonicalAccessState>();
    d.backend.getAccess.mockImplementationOnce(() => slowInit.promise);
    configureAccessStore(d);
    const init = useAccessStore.getState().initialize();
    await settle();
    expect(useAccessStore.getState().status).toBe('loading');
    d.backend.getAccess.mockResolvedValueOnce(exhausted);
    await useAccessStore.getState().refreshAccess();
    expect(useAccessStore.getState().canonicalAccess).toEqual(exhausted);
    slowInit.resolve(freeTwoLeft);
    await init;
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeTwoLeft);
    expect(selectCanStartRating(useAccessStore.getState())).toBe(true);
  });

  test('sign-out (clearAccessStoreConfiguration) during an in-flight purchase discards the late result and never syncs', async () => {
    const d = deps();
    configureAccessStore(d);
    await useAccessStore.getState().initialize();
    const purchase = deferred<StoreEntitlementState>();
    d.store.purchase.mockImplementationOnce(() => purchase.promise);
    const pending = useAccessStore.getState().purchaseSelected();
    await settle();
    expect(useAccessStore.getState().operation).toBe('purchasing');
    clearAccessStoreConfiguration();
    purchase.resolve(storeEntitlement);
    expect(await pending).toBe(false);
    expect(d.backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState()).toMatchObject({
      status: 'idle',
      operation: 'idle',
      canonicalAccess: null,
    });
  });

  test('re-configuring for another account during initialize() drops the first account result', async () => {
    const first = deps();
    const slow = deferred<CanonicalAccessState>();
    first.backend.getAccess.mockImplementationOnce(() => slow.promise);
    configureAccessStore(first);
    const init = useAccessStore.getState().initialize();
    await settle();
    const second = deps();
    second.backend.getAccess.mockResolvedValue(exhausted);
    configureAccessStore(second);
    await useAccessStore.getState().initialize();
    slow.resolve(paid);
    await init;
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toEqual(exhausted);
    expect(selectHasPremium(state)).toBe(false);
  });

  test('syncBilling() action: success replaces the snapshot; failure clears it and reports verification pending', async () => {
    const d = deps();
    configureAccessStore(d);
    await useAccessStore.getState().initialize();
    expect(await useAccessStore.getState().syncBilling()).toBe(true);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    d.backend.syncBilling.mockRejectedValueOnce(
      new BillingError(
        'billing.backend_unconfigured',
        'no token',
        false,
        'missing_api_token',
      ),
    );
    expect(await useAccessStore.getState().syncBilling()).toBe(false);
    const state = useAccessStore.getState();
    expect(state.status).toBe('unconfigured');
    expect(state.canonicalAccess).toBeNull();
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    expect(state.error?.unconfiguredReason).toBe('missing_api_token');
  });

  test('syncBilling() is refused while another operation is in flight', async () => {
    const d = deps();
    configureAccessStore(d);
    await useAccessStore.getState().initialize();
    const purchase = deferred<StoreEntitlementState>();
    d.store.purchase.mockImplementationOnce(() => purchase.promise);
    const pending = useAccessStore.getState().purchaseSelected();
    await settle();
    expect(await useAccessStore.getState().syncBilling()).toBe(false);
    expect(d.backend.syncBilling).not.toHaveBeenCalled();
    purchase.resolve(storeEntitlement);
    expect(await pending).toBe(true);
  });
});

describe('empty / missing data', () => {
  test('offering with only a monthly package selects monthly and refuses annual/lifetime selection', async () => {
    const d = deps();
    d.store.loadPlans.mockResolvedValue({
      offeringId: 'default',
      annual: null,
      lifetime: null,
      monthly: plans.monthly,
    });
    configureAccessStore(d);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().selectedPeriod).toBe('monthly');
    useAccessStore.getState().selectPeriod('annual');
    expect(useAccessStore.getState().selectedPeriod).toBe('monthly');
    useAccessStore.getState().selectPeriod('lifetime');
    expect(useAccessStore.getState().selectedPeriod).toBe('monthly');
  });

  test('no dependencies: every action fails closed as unconfigured', async () => {
    clearAccessStoreConfiguration();
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().status).toBe('unconfigured');
    expect(await useAccessStore.getState().refreshAccess()).toBe(false);
    expect(await useAccessStore.getState().syncBilling()).toBe(false);
    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    expect(await useAccessStore.getState().restorePurchases()).toBe(false);
    const state = useAccessStore.getState();
    expect(state.status).toBe('unconfigured');
    expect(state.canonicalAccess).toBeNull();
    expect(state.error?.code).toBe('billing.unconfigured');
    expect(selectPaywallRequired(state)).toBe(true);
  });

  test('purchase with a snapshot missing (fail-closed) is refused before touching the store', async () => {
    const d = deps();
    d.backend.getAccess.mockRejectedValueOnce(new Error('offline'));
    configureAccessStore(d);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    expect(d.store.purchase).not.toHaveBeenCalled();
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.backend_unavailable',
    );
  });
});
