/**
 * Adversarial pass — mobile-billing-paywall #4 (pass 3/3), plane cloud.
 * Target: src/state/accessStore.ts at 4d812e1a.
 *
 * Concurrency / interleaving attacks against the server-authoritative access
 * store. Each `it` asserts the behaviour the product contract REQUIRES
 * (canonicalAccess is the newest server truth, a verified premium purchase is
 * never demoted by a stale snapshot, account switches never leak). A failing
 * test here is a reproduced finding, not a harness error — do not weaken it.
 *
 * Assigned scenarios: S4 (account switch during restore), S5 store half
 * (cold-start offline → error/null → later refresh admits), S6 probe C
 * (initialize while refresh pending), S7 probe B (stale GET after purchase).
 */
import {
  BillingError,
  type BillingAccessDependencies,
  type BillingStoreClient,
  type CanonicalAccessClient,
  type CanonicalAccessState,
  type CanonicalBillingSync,
  type StoreEntitlementState,
  type StorePlans,
} from '../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectCanStartRating,
  selectHasPremium,
  selectPaywallRequired,
  useAccessStore,
} from '../src/state/accessStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (ticks = 3) => {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise<void>(res => setImmediate(res));
  }
};

const freeAccess = (used = 0): CanonicalAccessState => ({
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used,
    reserved: 0,
    remaining: 2 - used,
    availableToReserve: 2 - used,
  },
  canStartRating: used < 2,
  paywallRequired: used >= 2,
});

const exhaustedAccess = (): CanonicalAccessState => freeAccess(2);

const paidAccess: CanonicalAccessState = {
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
};

const paidSync: CanonicalBillingSync = {
  billing: {
    premium: true,
    productKey: 'pickle_sensei_pro_annual',
    expiresAt: '2027-09-04T00:00:00.000Z',
    verifiedAt: '2026-09-04T00:00:00.000Z',
  },
  access: paidAccess,
};

const freeSync = (access = freeAccess()): CanonicalBillingSync => ({
  billing: {
    premium: false,
    productKey: null,
    expiresAt: null,
    verifiedAt: '2026-09-04T00:00:00.000Z',
  },
  access,
});

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
  monthly: {
    id: 'default:monthly:$rc_monthly:pickle_sensei_pro_monthly',
    productId: 'pickle_sensei_pro_monthly',
    period: 'monthly',
    price: 7.99,
    priceString: '$7.99',
    pricePerMonthString: '$7.99',
    freeTrial: null,
  },
  lifetime: null,
};

const premiumEntitlement: StoreEntitlementState = {
  premium: true,
  productId: 'pickle_sensei_pro_annual',
  expirationDate: '2027-09-04T00:00:00.000Z',
};
const noEntitlement: StoreEntitlementState = {
  premium: false,
  productId: null,
  expirationDate: null,
};

type Mocked<T> = { [K in keyof T]: jest.Mock };

function makeDeps(overrides?: {
  store?: Partial<Mocked<BillingStoreClient>>;
  backend?: Partial<Mocked<CanonicalAccessClient>>;
}) {
  const store: Mocked<BillingStoreClient> = {
    configure: jest.fn(async () => undefined),
    loadPlans: jest.fn(async () => plans),
    purchase: jest.fn(async () => premiumEntitlement),
    restore: jest.fn(async () => premiumEntitlement),
    readEntitlement: jest.fn(async () => noEntitlement),
    ...overrides?.store,
  };
  const backend: Mocked<CanonicalAccessClient> = {
    getAccess: jest.fn(async () => freeAccess()),
    syncBilling: jest.fn(async () => paidSync),
    ...overrides?.backend,
  };
  const deps: BillingAccessDependencies = {
    store: store as unknown as BillingStoreClient,
    backend: backend as unknown as CanonicalAccessClient,
  };
  return { deps, store, backend };
}

const networkDown = () => new TypeError('Network request failed');

beforeEach(() => {
  clearAccessStoreConfiguration();
});

afterAll(() => {
  clearAccessStoreConfiguration();
});

describe('S4 — account switch while the first account restore is pending', () => {
  it('a premium restore resolving after sign-out/sign-in never touches account B', async () => {
    const restoreA = deferred<StoreEntitlementState>();
    const a = makeDeps({
      store: { restore: jest.fn(() => restoreA.promise) },
      backend: { getAccess: jest.fn(async () => exhaustedAccess()) },
    });
    configureAccessStore(a.deps);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().canonicalAccess).toEqual(
      exhaustedAccess(),
    );

    const restoring = useAccessStore.getState().restorePurchases();
    await flush();
    expect(useAccessStore.getState().operation).toBe('restoring');

    // Sign out A, sign in B (B has one free rating left, no premium).
    clearAccessStoreConfiguration();
    expect(useAccessStore.getState()).toMatchObject({
      status: 'idle',
      operation: 'idle',
      canonicalAccess: null,
    });
    const b = makeDeps({
      backend: { getAccess: jest.fn(async () => freeAccess(1)) },
    });
    configureAccessStore(b.deps);
    await useAccessStore.getState().initialize();
    const bSnapshot = useAccessStore.getState();
    expect(bSnapshot.canonicalAccess).toEqual(freeAccess(1));

    restoreA.resolve(premiumEntitlement);
    await expect(restoring).resolves.toBe(false);
    await flush();

    const after = useAccessStore.getState();
    expect(after.canonicalAccess).toEqual(freeAccess(1));
    expect(after.operation).toBe('idle');
    expect(after.status).toBe('ready');
    expect(after.error).toBeNull();
    expect(selectHasPremium(after)).toBe(false);
    expect(a.backend.syncBilling).not.toHaveBeenCalled();
    expect(b.backend.syncBilling).not.toHaveBeenCalled();
  });

  it("A's backend sync resolving premium after the switch never lands on B", async () => {
    const syncA = deferred<CanonicalBillingSync>();
    const a = makeDeps({
      backend: {
        getAccess: jest.fn(async () => exhaustedAccess()),
        syncBilling: jest.fn(() => syncA.promise),
      },
    });
    configureAccessStore(a.deps);
    await useAccessStore.getState().initialize();
    const restoring = useAccessStore.getState().restorePurchases();
    await flush();
    expect(a.store.restore).toHaveBeenCalledTimes(1);
    expect(a.backend.syncBilling).toHaveBeenCalledTimes(1);

    clearAccessStoreConfiguration();
    const b = makeDeps({
      backend: { getAccess: jest.fn(async () => freeAccess(1)) },
    });
    configureAccessStore(b.deps);
    await useAccessStore.getState().initialize();

    syncA.resolve(paidSync);
    await expect(restoring).resolves.toBe(false);
    await flush();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(1));
    expect(selectHasPremium(useAccessStore.getState())).toBe(false);
  });

  it("A's pending restore never re-populates a signed-out (unconfigured) store", async () => {
    const restoreA = deferred<StoreEntitlementState>();
    const a = makeDeps({
      store: { restore: jest.fn(() => restoreA.promise) },
    });
    configureAccessStore(a.deps);
    await useAccessStore.getState().initialize();
    const restoring = useAccessStore.getState().restorePurchases();
    await flush();
    clearAccessStoreConfiguration();
    restoreA.resolve(premiumEntitlement);
    await expect(restoring).resolves.toBe(false);
    await flush();
    expect(useAccessStore.getState()).toMatchObject({
      status: 'idle',
      operation: 'idle',
      canonicalAccess: null,
      plans: null,
      error: null,
    });
    expect(a.backend.syncBilling).not.toHaveBeenCalled();
  });

  it("A's pending restore REJECTING after the switch never writes an error into B", async () => {
    const restoreA = deferred<StoreEntitlementState>();
    const a = makeDeps({
      store: { restore: jest.fn(() => restoreA.promise) },
    });
    configureAccessStore(a.deps);
    await useAccessStore.getState().initialize();
    const restoring = useAccessStore.getState().restorePurchases();
    await flush();
    clearAccessStoreConfiguration();
    const b = makeDeps({
      backend: { getAccess: jest.fn(async () => freeAccess(1)) },
    });
    configureAccessStore(b.deps);
    await useAccessStore.getState().initialize();
    restoreA.reject(
      new BillingError('billing.restore_failed', 'store failed', true),
    );
    await expect(restoring).resolves.toBe(false);
    await flush();
    expect(useAccessStore.getState().error).toBeNull();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(1));
  });

  it('a stale initialize() from account A cannot overwrite B after a rapid A→B switch', async () => {
    const accessA = deferred<CanonicalAccessState>();
    const a = makeDeps({
      backend: { getAccess: jest.fn(() => accessA.promise) },
    });
    configureAccessStore(a.deps);
    const initA = useAccessStore.getState().initialize();
    await flush();
    clearAccessStoreConfiguration();
    const b = makeDeps({
      backend: { getAccess: jest.fn(async () => freeAccess(1)) },
    });
    configureAccessStore(b.deps);
    await useAccessStore.getState().initialize();
    accessA.resolve(paidAccess);
    await initA;
    await flush();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(1));
    expect(selectHasPremium(useAccessStore.getState())).toBe(false);
  });
});

describe('S5 (store half) — cold start offline fails closed, later refresh admits', () => {
  it('getAccess TypeError → status error, canonicalAccess null, paywall required', async () => {
    const { deps, backend } = makeDeps({
      backend: {
        getAccess: jest.fn(async () => {
          throw networkDown();
        }),
      },
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    const state = useAccessStore.getState();
    expect(state.status).toBe('error');
    expect(state.canonicalAccess).toBeNull();
    expect(state.plans).toEqual(plans);
    expect(state.error).toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: true,
    });
    expect(selectPaywallRequired(state)).toBe(true);
    expect(selectCanStartRating(state)).toBe(false);
    expect(selectHasPremium(state)).toBe(false);

    backend.getAccess.mockImplementation(async () => paidAccess);
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    const recovered = useAccessStore.getState();
    expect(recovered.status).toBe('ready');
    expect(recovered.error).toBeNull();
    expect(recovered.canonicalAccess).toEqual(paidAccess);
    expect(selectCanStartRating(recovered)).toBe(true);
    expect(selectPaywallRequired(recovered)).toBe(false);
  });

  it('offline purchase attempt with canonicalAccess null is refused before the store is touched', async () => {
    const { deps, store } = makeDeps({
      backend: {
        getAccess: jest.fn(async () => {
          throw networkDown();
        }),
      },
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expect(store.purchase).not.toHaveBeenCalled();
    expect(useAccessStore.getState().error).toMatchObject({
      code: 'billing.backend_unavailable',
    });
  });

  it('offline RESTORE is allowed but fails closed when the sync cannot reach the server', async () => {
    const { deps, store } = makeDeps({
      backend: {
        getAccess: jest.fn(async () => {
          throw networkDown();
        }),
        syncBilling: jest.fn(async () => {
          throw networkDown();
        }),
      },
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      false,
    );
    expect(store.restore).toHaveBeenCalledTimes(1);
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toBeNull();
    expect(state.status).toBe('error');
    expect(state.error).toMatchObject({
      code: 'billing.backend_verification_pending',
    });
    expect(selectHasPremium(state)).toBe(false);
  });
});

describe('S6 — probe C: initialize() while refreshAccess() is pending', () => {
  it('plans are eventually loaded and non-null', async () => {
    const access = deferred<CanonicalAccessState>();
    const { deps, store } = makeDeps({
      backend: { getAccess: jest.fn(() => access.promise) },
    });
    configureAccessStore(deps);

    const refreshing = useAccessStore.getState().refreshAccess();
    await flush();
    expect(useAccessStore.getState().status).toBe('loading');

    const initializing = useAccessStore.getState().initialize();
    access.resolve(freeAccess());
    await Promise.all([refreshing, initializing]);
    await flush();

    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.canonicalAccess).toEqual(freeAccess());
    expect(store.loadPlans).toHaveBeenCalled();
    expect(state.plans).not.toBeNull();
  });

  it('SettingsScreen path: refreshAccess() on a never-initialized store leaves plans null with status ready', async () => {
    // SettingsScreen's useFocusEffect calls refreshAccess() whenever status is
    // not 'loading' — including 'idle' on a cold start where the camera tab
    // was never opened. PaywallScreen only initializes when status==='idle',
    // so the paywall opened from Settings afterwards has no store pricing.
    const { deps, store } = makeDeps();
    configureAccessStore(deps);
    expect(useAccessStore.getState().status).toBe('idle');
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.canonicalAccess).toEqual(freeAccess());
    expect(store.configure).not.toHaveBeenCalled();
    expect(store.loadPlans).not.toHaveBeenCalled();
    expect(state.plans).toBeNull();
  });

  it('a second initialize() after the refresh settles does load plans (control for probe C)', async () => {
    const access = deferred<CanonicalAccessState>();
    const { deps, store } = makeDeps({
      backend: { getAccess: jest.fn(() => access.promise) },
    });
    configureAccessStore(deps);
    const refreshing = useAccessStore.getState().refreshAccess();
    await flush();
    await useAccessStore.getState().initialize();
    access.resolve(freeAccess());
    await refreshing;
    await useAccessStore.getState().initialize();
    expect(store.loadPlans).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().plans).toEqual(plans);
  });
});

describe('S7 — probe B: stale GET resolving after a verified premium purchase', () => {
  it('canonicalAccess.premium stays true after the pre-purchase snapshot lands', async () => {
    const { deps, backend, store } = makeDeps();
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess());

    const staleGet = deferred<CanonicalAccessState>();
    backend.getAccess.mockImplementation(() => staleGet.promise);
    const refreshing = useAccessStore.getState().refreshAccess();
    await flush();

    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    expect(store.purchase).toHaveBeenCalledTimes(1);
    expect(backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);

    staleGet.resolve(freeAccess());
    await refreshing;
    await flush();

    const state = useAccessStore.getState();
    expect(state.canonicalAccess?.premium).toBe(true);
    expect(selectHasPremium(state)).toBe(true);
    expect(selectPaywallRequired(state)).toBe(false);
  });

  it('a stale GET that REJECTS after a verified purchase must not null the verified access', async () => {
    const { deps, backend } = makeDeps();
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    const staleGet = deferred<CanonicalAccessState>();
    backend.getAccess.mockImplementation(() => staleGet.promise);
    const refreshing = useAccessStore.getState().refreshAccess();
    await flush();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    staleGet.reject(networkDown());
    await refreshing;
    await flush();
    const state = useAccessStore.getState();
    expect(state.canonicalAccess?.premium).toBe(true);
    expect(selectHasPremium(state)).toBe(true);
  });

  it('two overlapping refreshes: the one issued LAST wins, even if it resolves first', async () => {
    const { deps, backend } = makeDeps();
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();

    const first = deferred<CanonicalAccessState>();
    const second = deferred<CanonicalAccessState>();
    backend.getAccess
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const r1 = useAccessStore.getState().refreshAccess();
    const r2 = useAccessStore.getState().refreshAccess();
    await flush();
    second.resolve(paidAccess);
    await r2;
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);
    first.resolve(exhaustedAccess());
    await r1;
    await flush();
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);
  });

  it('a stale GET resolving after a verified RESTORE must not demote premium', async () => {
    const { deps, backend } = makeDeps({
      backend: { getAccess: jest.fn(async () => exhaustedAccess()) },
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    const staleGet = deferred<CanonicalAccessState>();
    backend.getAccess.mockImplementation(() => staleGet.promise);
    const refreshing = useAccessStore.getState().refreshAccess();
    await flush();
    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      true,
    );
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);
    staleGet.resolve(exhaustedAccess());
    await refreshing;
    await flush();
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
  });
});

describe('extra — operation exclusivity and rapid repeats', () => {
  it('purchaseSelected ×5 in the same tick → exactly one store purchase and one sync', async () => {
    const purchase = deferred<StoreEntitlementState>();
    const { deps, store, backend } = makeDeps({
      store: { purchase: jest.fn(() => purchase.promise) },
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    const results = [1, 2, 3, 4, 5].map(() =>
      useAccessStore.getState().purchaseSelected(),
    );
    await flush();
    expect(store.purchase).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().operation).toBe('purchasing');
    purchase.resolve(premiumEntitlement);
    const settled = await Promise.all(results);
    expect(settled.filter(Boolean)).toHaveLength(1);
    expect(backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().operation).toBe('idle');
  });

  it('restorePurchases + syncBilling during a purchase are refused without touching store/backend', async () => {
    const purchase = deferred<StoreEntitlementState>();
    const { deps, store, backend } = makeDeps({
      store: { purchase: jest.fn(() => purchase.promise) },
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    const purchasing = useAccessStore.getState().purchaseSelected();
    await flush();
    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      false,
    );
    await expect(useAccessStore.getState().syncBilling()).resolves.toBe(false);
    expect(store.restore).not.toHaveBeenCalled();
    expect(backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState().operation).toBe('purchasing');
    purchase.resolve(premiumEntitlement);
    await expect(purchasing).resolves.toBe(true);
  });

  it('a local premium entitlement from the store never unlocks when the server disagrees', async () => {
    const { deps } = makeDeps({
      backend: {
        syncBilling: jest.fn(async () => freeSync(exhaustedAccess())),
      },
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    const state = useAccessStore.getState();
    expect(selectHasPremium(state)).toBe(false);
    expect(state.canonicalAccess).toEqual(exhaustedAccess());
    expect(state.error).toMatchObject({
      code: 'billing.backend_verification_pending',
    });
  });

  it('purchase cancellation clears the error and stays on the previous access', async () => {
    const { deps, backend } = makeDeps({
      store: {
        purchase: jest.fn(async () => {
          throw new BillingError('billing.purchase_cancelled', 'cancel', false);
        }),
      },
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expect(useAccessStore.getState()).toMatchObject({
      operation: 'idle',
      error: null,
      canonicalAccess: freeAccess(),
    });
    expect(backend.syncBilling).not.toHaveBeenCalled();
  });

  it('store.purchase that never settles keeps every other action refused (no self-heal timeout)', async () => {
    // Documents current behaviour: the store has no purchase timeout, so a
    // hung StoreKit sheet leaves `operation:'purchasing'` until the app dies.
    const { deps } = makeDeps({
      store: { purchase: jest.fn(() => new Promise<never>(() => undefined)) },
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    void useAccessStore.getState().purchaseSelected();
    await flush(10);
    expect(useAccessStore.getState().operation).toBe('purchasing');
    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      false,
    );
    // refreshAccess is NOT gated on `operation`, so a hung purchase does not
    // block server truth from being re-read.
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    expect(useAccessStore.getState().operation).toBe('purchasing');
  });

  it('reset() during a purchase discards the late premium result', async () => {
    const purchase = deferred<StoreEntitlementState>();
    const { deps, backend } = makeDeps({
      store: { purchase: jest.fn(() => purchase.promise) },
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    const purchasing = useAccessStore.getState().purchaseSelected();
    await flush();
    useAccessStore.getState().reset();
    purchase.resolve(premiumEntitlement);
    await expect(purchasing).resolves.toBe(false);
    await flush();
    expect(backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState()).toMatchObject({
      status: 'idle',
      operation: 'idle',
      canonicalAccess: null,
    });
  });

  it('selectPeriod ignores periods the store did not return (lifetime absent)', async () => {
    const { deps } = makeDeps();
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().selectedPeriod).toBe('annual');
    useAccessStore.getState().selectPeriod('lifetime');
    expect(useAccessStore.getState().selectedPeriod).toBe('annual');
    useAccessStore.getState().selectPeriod('monthly');
    expect(useAccessStore.getState().selectedPeriod).toBe('monthly');
  });

  it('initialize with a store that throws a non-BillingError still exposes the free allowance', async () => {
    const { deps } = makeDeps({
      store: {
        configure: jest.fn(async () => {
          throw new Error('💥 native module missing');
        }),
      },
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toEqual(freeAccess());
    expect(state.plans).toBeNull();
    expect(state.status).toBe('unconfigured');
    expect(selectCanStartRating(state)).toBe(true);
    expect(state.error).toMatchObject({ code: 'billing.unconfigured' });
  });
});
