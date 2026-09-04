/**
 * STRESS / mod-access-store — deterministic reproductions of the failures the
 * seeded campaign in `accessStoreRandomized.stress.test.ts` found. Each test
 * hand-schedules the fake store/backend promises (no RNG, no timers) so the
 * interleaving is exact and the assertion states the EXPECTED contract from
 * AGENTS.md "Billing" / the accessStore.ts comments. These tests FAIL on the
 * current implementation on purpose — they are the regression pins for:
 *
 *  R1  initialize() completing while restore/purchase is in flight resets
 *      `operation` to 'idle' (accessStore.ts initialize → set({operation:
 *      'idle'})), re-enabling the Paywall buttons mid-operation and letting a
 *      second restore/purchase start (campaign invariant I8).
 *  R2  two overlapping refreshAccess() calls apply snapshots in completion
 *      order, so an OLDER backend answer overwrites a NEWER one (I3).
 *  R3  initialize()'s pre-verification getAccess snapshot, applied after a
 *      concurrent restore verified premium, overwrites the premium snapshot
 *      with a stale non-premium one (I3, UI-reachable: Paywall "Restore
 *      purchases" is enabled while status === 'loading').
 */
import {
  type BillingAccessDependencies,
  type CanonicalAccessState,
  type CanonicalBillingSync,
  type StoreEntitlementState,
  type StorePlans,
} from '../../src/billing/types';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectHasPremium,
  useAccessStore,
} from '../../src/state/accessStore';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function at<T>(list: Deferred<T>[], index: number): Deferred<T> {
  const d = list[index];
  if (!d) throw new Error(`expected pending call #${index}`);
  return d;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function access(
  premium: boolean,
  used: number,
  reserved = 0,
): CanonicalAccessState {
  const remaining = Math.max(0, 2 - used);
  const availableToReserve = Math.max(0, remaining - reserved);
  return {
    premium,
    entitlements: premium ? ['pickle_sensei_pro'] : [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating: premium || availableToReserve > 0,
    paywallRequired: !premium && availableToReserve === 0,
  };
}

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
  monthly: null,
  lifetime: null,
};

const entitlement: StoreEntitlementState = {
  premium: false,
  productId: null,
  expirationDate: null,
};

function synced(state: CanonicalAccessState): CanonicalBillingSync {
  return {
    billing: {
      premium: state.premium,
      productKey: state.premium ? 'pickle_sensei_pro_annual' : null,
      expiresAt: state.premium ? '2027-01-01T00:00:00.000Z' : null,
      verifiedAt: '2026-09-04T00:00:00.000Z',
    },
    access: state,
  };
}

interface Fakes {
  deps: BillingAccessDependencies;
  configure: Deferred<void>[];
  loadPlans: Deferred<StorePlans>[];
  restore: Deferred<StoreEntitlementState>[];
  purchase: Deferred<StoreEntitlementState>[];
  getAccess: Deferred<CanonicalAccessState>[];
  syncBilling: Deferred<CanonicalBillingSync>[];
}

function fakes(): Fakes {
  const f: Fakes = {
    deps: null as unknown as BillingAccessDependencies,
    configure: [],
    loadPlans: [],
    restore: [],
    purchase: [],
    getAccess: [],
    syncBilling: [],
  };
  const push = <T>(list: Deferred<T>[]): Promise<T> => {
    const d = deferred<T>();
    list.push(d);
    return d.promise;
  };
  f.deps = {
    store: {
      configure: () => push(f.configure),
      loadPlans: () => push(f.loadPlans),
      purchase: () => push(f.purchase),
      restore: () => push(f.restore),
      readEntitlement: () => Promise.resolve(entitlement),
    },
    backend: {
      getAccess: () => push(f.getAccess),
      syncBilling: () => push(f.syncBilling),
    },
  };
  return f;
}

afterEach(() => {
  clearAccessStoreConfiguration();
});

describe('accessStore race reproductions (deterministic)', () => {
  it('R1: initialize completing during restorePurchases must not report operation=idle nor admit a second restore', async () => {
    const f = fakes();
    configureAccessStore(f.deps);
    const store = useAccessStore.getState();

    const init = store.initialize();
    await flush();
    at(f.configure, 0).resolve();
    await flush();
    expect(f.getAccess).toHaveLength(1);
    expect(f.loadPlans).toHaveLength(1);
    expect(useAccessStore.getState().status).toBe('loading');

    // Paywall's "Restore purchases" is enabled here (busy derives from
    // operation, which is still 'idle' while initialize loads).
    const restore = store.restorePurchases();
    await flush();
    expect(f.restore).toHaveLength(1);
    expect(useAccessStore.getState().operation).toBe('restoring');

    // initialize finishes while StoreKit restore is still running.
    at(f.getAccess, 0).resolve(access(false, 0));
    at(f.loadPlans, 0).resolve(plans);
    await init;

    // EXPECTED: the restore that is still in flight keeps operation
    // 'restoring' (Paywall keeps its spinner / disabled buttons) …
    const operationAfterInit = useAccessStore.getState().operation;

    // … and a second restore is refused (returns false without touching
    // the store SDK). Observed today: initialize() wrote operation 'idle',
    // so this second tap starts a second StoreKit restore.
    const secondRestore = store.restorePurchases();
    await flush();
    const storeRestores = f.restore.length;

    expect({ operationAfterInit, storeRestores }).toEqual({
      operationAfterInit: 'restoring',
      storeRestores: 1,
    });

    // Let everything settle so the test leaves no dangling promises.
    for (const d of f.restore) d.resolve(entitlement);
    await flush();
    for (const d of f.syncBilling) d.resolve(synced(access(true, 0)));
    await Promise.all([restore, secondRestore]);
  });

  it('R2: overlapping refreshAccess calls must never let an older snapshot overwrite a newer one', async () => {
    const f = fakes();
    configureAccessStore(f.deps);
    const store = useAccessStore.getState();

    // e.g. AnalyzeScreen unmount refresh + SettingsScreen focus refresh.
    const first = store.refreshAccess();
    const second = store.refreshAccess();
    await flush();
    expect(f.getAccess).toHaveLength(2);

    // The later request answers first with the permit consumed …
    at(f.getAccess, 1).resolve(access(false, 1));
    await flush();
    expect(useAccessStore.getState().canonicalAccess?.freeRatings.used).toBe(1);

    // … then the earlier request lands with the pre-consumption count.
    at(f.getAccess, 0).resolve(access(false, 0));
    await Promise.all([first, second]);

    // EXPECTED: the newer answer (used=1) is still what the UI sees.
    expect(useAccessStore.getState().canonicalAccess?.freeRatings.used).toBe(1);
  });

  it('R3: a verified premium restore must not be overwritten by initialize()’s earlier non-premium snapshot', async () => {
    const f = fakes();
    configureAccessStore(f.deps);
    const store = useAccessStore.getState();

    const init = store.initialize();
    await flush();
    at(f.configure, 0).resolve();
    await flush();
    // getAccess answers quickly; StoreKit offerings are slow.
    at(f.getAccess, 0).resolve(access(false, 2));
    await flush();

    const restore = store.restorePurchases();
    await flush();
    at(f.restore, 0).resolve({
      premium: true,
      productId: 'pickle_sensei_pro_annual',
      expirationDate: '2027-01-01T00:00:00.000Z',
    });
    await flush();
    at(f.syncBilling, 0).resolve(synced(access(true, 2)));
    await restore;
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);

    // Offerings finally arrive and initialize applies its stale snapshot.
    at(f.loadPlans, 0).resolve(plans);
    await init;

    // EXPECTED: the server-verified premium state survives.
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(useAccessStore.getState().canonicalAccess?.paywallRequired).toBe(
      false,
    );
  });
});
