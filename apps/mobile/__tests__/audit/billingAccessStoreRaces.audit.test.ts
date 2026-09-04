/**
 * Structural audit probes (mobile-billing-paywall, pass 1) for accessStore
 * concurrency and lifecycle. Every `it` states the invariant the store SHOULD
 * hold; a failing case is a reproduced defect at the audited commit.
 */
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  CanonicalBillingSync,
  StoreEntitlementState,
  StorePlans,
} from '../../src/billing/types';

const freeAccess: CanonicalAccessState = {
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
};

const premiumAccess: CanonicalAccessState = {
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

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'default:annual:$rc_annual:pickle_sensei_pro_annual',
    productId: 'pickle_sensei_pro_annual',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: null,
  lifetime: null,
};

const storeEntitlement: StoreEntitlementState = {
  premium: true,
  productId: 'pickle_sensei_pro_annual',
  expirationDate: null,
};

function premiumSync(): CanonicalBillingSync {
  return {
    billing: {
      premium: true,
      productKey: 'pickle_sensei_pro_annual',
      expiresAt: null,
      verifiedAt: '2026-09-01T00:00:00.000Z',
    },
    access: premiumAccess,
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

type Deps = BillingAccessDependencies & {
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

function dependencies(): Deps {
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
      getAccess: jest.fn(async () => freeAccess),
      syncBilling: jest.fn(async () => premiumSync()),
    },
  };
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('audit: refreshAccess vs. purchase ordering (probe B)', () => {
  it('a GET /v1/me/access started before a purchase must not overwrite the verified premium sync', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);

    // Settings focus / Analyze unmount kicks a refresh whose response is slow.
    const slowGet = deferred<CanonicalAccessState>();
    deps.backend.getAccess.mockImplementationOnce(() => slowGet.promise);
    const refresh = useAccessStore.getState().refreshAccess();
    expect(useAccessStore.getState().status).toBe('loading');

    // Meanwhile the user buys and the backend verifies premium.
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    expect(useAccessStore.getState().status).toBe('ready');

    // The stale GET (issued before the purchase) lands last.
    slowGet.resolve(freeAccess);
    await refresh;

    // Invariant: the newest server truth (post-sync premium) must win.
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
  });

  it('a stale GET landing during an in-flight purchase does not move status away from the purchase', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();

    const slowPurchase = deferred<StoreEntitlementState>();
    deps.store.purchase.mockImplementationOnce(() => slowPurchase.promise);
    const purchase = useAccessStore.getState().purchaseSelected();
    await flush();
    expect(useAccessStore.getState().operation).toBe('purchasing');

    await useAccessStore.getState().refreshAccess();
    // Refresh completing mid-purchase leaves the purchase operation intact.
    expect(useAccessStore.getState().operation).toBe('purchasing');

    slowPurchase.resolve(storeEntitlement);
    await expect(purchase).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
  });
});

describe('audit: initialize() vs. refreshAccess() (probe C)', () => {
  it('initialize() called while a refresh holds status=loading still loads store plans', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    // Prime canonical access without touching the store (Settings-only path).
    const slowGet = deferred<CanonicalAccessState>();
    deps.backend.getAccess.mockImplementationOnce(() => slowGet.promise);
    const refresh = useAccessStore.getState().refreshAccess();
    expect(useAccessStore.getState().status).toBe('loading');

    // Paywall "Try again" / route gate asks for full initialization now.
    const init = useAccessStore.getState().initialize();
    slowGet.resolve(freeAccess);
    await Promise.all([refresh, init]);
    await flush();

    // Invariant: the paywall needs plans; an initialize request must not be
    // silently dropped because an unrelated refresh was in flight.
    expect(deps.store.loadPlans).toHaveBeenCalled();
    expect(useAccessStore.getState().plans).toEqual(plans);
  });

  it('real-world order: Settings refreshAccess() first, then Paywall mount → plans must be loadable without a manual retry', async () => {
    const deps = dependencies();
    configureAccessStore(deps);

    // SettingsScreen useFocusEffect on a fresh launch (status idle).
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);

    // PaywallScreen mount effect: `if (status === 'idle') void initialize();`
    if (useAccessStore.getState().status === 'idle') {
      await useAccessStore.getState().initialize();
    }

    // Invariant: the pricing page should have store plans (store healthy),
    // not the "Store pricing is unavailable" card with a disabled Continue.
    expect(deps.store.configure).toHaveBeenCalled();
    expect(useAccessStore.getState().plans).not.toBeNull();
    expect(useAccessStore.getState().error).toBeNull();
  });
});

describe('audit: sign-out between store purchase and backend sync', () => {
  it('drops the result, never syncs under the next account, and leaves no pending operation', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();

    const slowPurchase = deferred<StoreEntitlementState>();
    deps.store.purchase.mockImplementationOnce(() => slowPurchase.promise);
    const purchase = useAccessStore.getState().purchaseSelected();
    await flush();
    expect(useAccessStore.getState().operation).toBe('purchasing');

    clearAccessStoreConfiguration();
    slowPurchase.resolve(storeEntitlement);
    await expect(purchase).resolves.toBe(false);

    expect(deps.backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState()).toMatchObject({
      status: 'idle',
      operation: 'idle',
      canonicalAccess: null,
      plans: null,
    });
  });

  it('a stale premium sync from a previous configuration never lands on the next account', async () => {
    const first = dependencies();
    configureAccessStore(first);
    await useAccessStore.getState().initialize();
    const slowSync = deferred<CanonicalBillingSync>();
    first.backend.syncBilling.mockImplementationOnce(() => slowSync.promise);
    const purchase = useAccessStore.getState().purchaseSelected();
    await flush();

    const second = dependencies();
    configureAccessStore(second);
    await useAccessStore.getState().initialize();
    slowSync.resolve(premiumSync());
    await expect(purchase).resolves.toBe(false);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(false);
  });
});

describe('audit: refresh failure semantics (fail closed)', () => {
  it('a transient refresh failure nulls canonicalAccess (fail closed) and keeps plans', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    deps.backend.getAccess.mockRejectedValueOnce(new Error('offline'));
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(
      false,
    );
    const state = useAccessStore.getState();
    expect(state.status).toBe('error');
    expect(state.canonicalAccess).toBeNull();
    expect(state.plans).toEqual(plans);
    expect(state.error?.code).toBe('billing.backend_unavailable');
    expect(state.error?.retryable).toBe(true);
  });

  it('a refresh after the failure restores access without re-initializing the store', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    deps.backend.getAccess.mockRejectedValueOnce(new Error('offline'));
    await useAccessStore.getState().refreshAccess();
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
    expect(deps.store.configure).toHaveBeenCalledTimes(1);
  });

  it('a backend sync failure after a successful store purchase nulls access and reports verification pending', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    deps.backend.syncBilling.mockRejectedValueOnce(new Error('503'));
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    const state = useAccessStore.getState();
    expect(state.status).toBe('error');
    expect(state.operation).toBe('idle');
    expect(state.canonicalAccess).toBeNull();
    expect(state.error?.code).toBe('billing.backend_verification_pending');
  });
});

describe('audit: operation guards', () => {
  it('second purchase tap while purchasing is ignored and the store is called once', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    const slowPurchase = deferred<StoreEntitlementState>();
    deps.store.purchase.mockImplementationOnce(() => slowPurchase.promise);
    const first = useAccessStore.getState().purchaseSelected();
    await flush();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      false,
    );
    await expect(useAccessStore.getState().syncBilling()).resolves.toBe(false);
    slowPurchase.resolve(storeEntitlement);
    await expect(first).resolves.toBe(true);
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);
    expect(deps.backend.syncBilling).toHaveBeenCalledTimes(1);
  });

  it('purchase refuses to start while canonicalAccess is null', async () => {
    const deps = dependencies();
    deps.backend.getAccess.mockRejectedValueOnce(new Error('offline'));
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(useAccessStore.getState().plans).toEqual(plans);
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expect(deps.store.purchase).not.toHaveBeenCalled();
  });

  it('local store entitlement never unlocks: non-premium backend sync after purchase keeps premium false', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    deps.backend.syncBilling.mockResolvedValueOnce({
      billing: {
        premium: false,
        productKey: null,
        expiresAt: null,
        verifiedAt: '2026-09-01T00:00:00.000Z',
      },
      access: freeAccess,
    });
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    const state = useAccessStore.getState();
    expect(state.canonicalAccess?.premium).toBe(false);
    expect(state.status).toBe('error');
    expect(state.error?.code).toBe('billing.backend_verification_pending');
  });
});
