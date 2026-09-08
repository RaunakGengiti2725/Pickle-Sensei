import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  StorePlans,
} from '../../src/billing';
import { BILLING_REQUEST_TIMEOUT_MS } from '../../src/billing/accessApi';
import type {
  PendingFulfilment,
  PendingFulfilmentStorage,
} from '../../src/billing/pendingFulfilment';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectHasPremium,
  useAccessStore,
} from '../../src/state/accessStore';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';

/**
 * INT-state-consistency adversarial pass (attacked HEAD 30a40650).
 * Store/state consistency attacks against accessStore: reconfigure resets,
 * concurrent updates, account-switch races, malformed store output.
 * These tests assert the documented invariants; a failing test is a
 * confirmed break, not something to fix here.
 */

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';

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

const paidSync = {
  billing: {
    premium: true,
    productKey: 'pickle_sensei_pro_annual',
    expiresAt: '2027-08-27T00:00:00.000Z',
    verifiedAt: '2026-09-08T00:00:00.000Z',
  },
  access: paidAccess,
};

const freeSync = {
  billing: {
    premium: false,
    productKey: null,
    expiresAt: null,
    verifiedAt: '2026-09-08T00:00:00.000Z',
  },
  access: freeAccess,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(turns = 60) {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function memoryStorage(): PendingFulfilmentStorage & {
  records: Map<string, PendingFulfilment>;
} {
  const records = new Map<string, PendingFulfilment>();
  return {
    records,
    read: async owner => records.get(owner) ?? null,
    write: async (record, assertActive) => {
      assertActive?.();
      records.set(record.owner, record);
    },
    remove: async (record, assertActive) => {
      assertActive?.();
      if (records.get(record.owner)?.id === record.id)
        records.delete(record.owner);
    },
  };
}

type Deps = BillingAccessDependencies & {
  store: BillingAccessDependencies['store'] & {
    purchase: jest.Mock;
    configure: jest.Mock;
    loadPlans: jest.Mock;
  };
  backend: BillingAccessDependencies['backend'] & {
    getAccess: jest.Mock;
    syncBilling: jest.Mock;
  };
};

function dependencies(options?: {
  getAccess?: BillingAccessDependencies['backend']['getAccess'];
  syncBilling?: BillingAccessDependencies['backend']['syncBilling'];
  purchase?: BillingAccessDependencies['store']['purchase'];
}): Deps {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(
        options?.purchase ??
          (async () => ({
            premium: true,
            productId: 'pickle_sensei_pro_annual',
            expirationDate: '2027-08-27T00:00:00.000Z',
            transaction: {
              productId: 'pickle_sensei_pro_annual',
              transactionId: 'txn-1',
              purchasedAt: '2026-09-08T00:00:00.000Z',
            },
          })),
      ),
      restore: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(options?.getAccess ?? (async () => freeAccess)),
      syncBilling: jest.fn(options?.syncBilling ?? (async () => paidSync)),
    },
  };
}

function signIn(
  owner: string,
  deps: BillingAccessDependencies,
  storage: PendingFulfilmentStorage,
) {
  setActiveDataOwner(owner);
  configureAccessStore(deps, { owner, pendingFulfilmentStorage: storage });
}

function signOut() {
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
}

beforeEach(() => {
  signOut();
});

afterEach(() => {
  signOut();
});

describe('ATTACK accessStore: reconfigure/reset and account-switch races', () => {
  it('A1 sign-out while a backend verification is in flight must not leave the same owner blocked from the store on re-sign-in', async () => {
    const storage = memoryStorage();
    const verify = deferred<typeof paidSync>();
    const first = dependencies({ syncBilling: () => verify.promise });
    signIn(OWNER_A, first, storage);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().status).toBe('ready');

    const sync = useAccessStore.getState().syncBilling();
    await flush();
    expect(useAccessStore.getState().reconciliation.status).toBe('checking');

    signOut();
    verify.reject(new Error('network lost'));
    expect(await sync).toBe(false);
    await flush();

    // Same owner signs back in on the same device: the durable-pending journal
    // and the reconciliation tracker are keyed per owner and survive sign-out.
    const second = dependencies();
    signIn(OWNER_A, second, storage);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().pendingFulfilment).toBeNull();

    // Nothing is in flight for this owner, so the paywall's Continue must
    // reach the store instead of being refused with a "verify first" error.
    const purchased = await useAccessStore.getState().purchaseSelected();
    expect(useAccessStore.getState().error).toBeNull();
    expect(second.store.purchase).toHaveBeenCalledTimes(1);
    expect(purchased).toBe(true);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(useAccessStore.getState().reconciliation.status).not.toBe(
      'checking',
    );
  });

  it('A1b the stale "checking" tracker only clears once a lifecycle reconcile runs past the 10 s cooldown', async () => {
    const storage = memoryStorage();
    const verify = deferred<typeof paidSync>();
    const first = dependencies({ syncBilling: () => verify.promise });
    signIn(OWNER_A, first, storage);
    await useAccessStore.getState().initialize();
    const sync = useAccessStore.getState().syncBilling();
    await flush();
    signOut();
    verify.reject(new Error('network lost'));
    await sync;

    const second = dependencies({ syncBilling: async () => freeSync });
    signIn(OWNER_A, second, storage);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().reconciliation.status).toBe('checking');

    // Lifecycle pass inside the cooldown cannot repair the tracker.
    expect(await useAccessStore.getState().reconcileBilling()).toBe(false);
    expect(second.backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState().reconciliation.status).toBe('checking');
    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    expect(second.store.purchase).not.toHaveBeenCalled();

    const realNow = Date.now();
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow + 11_000);
    try {
      expect(await useAccessStore.getState().reconcileBilling()).toBe(false);
      expect(second.backend.syncBilling).toHaveBeenCalledTimes(1);
      expect(useAccessStore.getState().reconciliation.status).toBe('verified');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('A2 reset() during an in-flight refresh drops the late snapshot and leaves the store re-initialisable', async () => {
    const storage = memoryStorage();
    const late = deferred<CanonicalAccessState>();
    let calls = 0;
    const deps = dependencies({
      getAccess: () => {
        calls += 1;
        return calls === 2 ? late.promise : Promise.resolve(freeAccess);
      },
    });
    signIn(OWNER_A, deps, storage);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);

    const refresh = useAccessStore.getState().refreshAccess();
    await flush();
    expect(useAccessStore.getState().status).toBe('loading');
    useAccessStore.getState().reset();
    late.resolve(paidAccess);
    expect(await refresh).toBe(false);
    await flush();

    expect(useAccessStore.getState()).toMatchObject({
      status: 'idle',
      operation: 'idle',
      canonicalAccess: null,
      plans: null,
    });
    expect(selectHasPremium(useAccessStore.getState())).toBe(false);

    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState()).toMatchObject({
      status: 'ready',
      operation: 'idle',
      canonicalAccess: freeAccess,
    });
    expect(deps.backend.getAccess).toHaveBeenCalledTimes(3);
  });

  it('A3 a paid snapshot for A that resolves after the store is reconfigured for B never reaches B', async () => {
    const storage = memoryStorage();
    const lateA = deferred<CanonicalAccessState>();
    const depsA = dependencies({ getAccess: () => lateA.promise });
    signIn(OWNER_A, depsA, storage);
    const initA = useAccessStore.getState().initialize();
    await flush();
    expect(useAccessStore.getState().status).toBe('loading');

    const depsB = dependencies({ getAccess: async () => freeAccess });
    signIn(OWNER_B, depsB, storage);
    expect(useAccessStore.getState()).toMatchObject({
      status: 'idle',
      operation: 'idle',
      canonicalAccess: null,
    });

    lateA.resolve(paidAccess);
    await initA;
    await flush();
    expect(useAccessStore.getState()).toMatchObject({
      status: 'idle',
      operation: 'idle',
      canonicalAccess: null,
    });
    expect(selectHasPremium(useAccessStore.getState())).toBe(false);

    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState()).toMatchObject({
      status: 'ready',
      canonicalAccess: freeAccess,
    });
    expect(depsB.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(depsB.store.purchase).not.toHaveBeenCalled();
  });
});

describe('ATTACK accessStore: concurrent and repeated actions', () => {
  it('A4 two concurrent initialize() calls perform one access read and one store configuration and settle ready', async () => {
    const storage = memoryStorage();
    const access = deferred<CanonicalAccessState>();
    const deps = dependencies({ getAccess: () => access.promise });
    signIn(OWNER_A, deps, storage);

    const first = useAccessStore.getState().initialize();
    const second = useAccessStore.getState().initialize();
    await flush();
    access.resolve(freeAccess);
    await Promise.all([first, second]);

    expect(deps.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(deps.store.configure).toHaveBeenCalledTimes(1);
    expect(deps.store.loadPlans).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState()).toMatchObject({
      status: 'ready',
      operation: 'idle',
      canonicalAccess: freeAccess,
      plans,
      selectedPeriod: 'annual',
    });
  });

  it('A5 purchaseSelected() during an in-flight refresh is refused without opening the store and the refresh still publishes', async () => {
    const storage = memoryStorage();
    let calls = 0;
    const late = deferred<CanonicalAccessState>();
    const deps = dependencies({
      getAccess: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve(freeAccess) : late.promise;
      },
    });
    signIn(OWNER_A, deps, storage);
    await useAccessStore.getState().initialize();

    const refresh = useAccessStore.getState().refreshAccess();
    await flush();
    const purchased = await useAccessStore.getState().purchaseSelected();
    expect(purchased).toBe(false);
    expect(deps.store.purchase).not.toHaveBeenCalled();
    expect(useAccessStore.getState().status).toBe('loading');

    late.resolve({
      ...freeAccess,
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
    expect(await refresh).toBe(true);
    expect(useAccessStore.getState()).toMatchObject({
      status: 'ready',
      operation: 'idle',
      error: null,
    });
    expect(useAccessStore.getState().canonicalAccess?.canStartRating).toBe(
      false,
    );
  });

  it('A6 a store purchase whose transaction evidence is malformed stays a recoverable pending purchase and never permits a second charge', async () => {
    const storage = memoryStorage();
    let premiumOnServer = false;
    const deps = dependencies({
      purchase: async () => ({
        premium: true,
        productId: 'pickle_sensei_pro_annual',
        expirationDate: '2027-08-27T00:00:00.000Z',
        transaction: {
          productId: 'pickle_sensei_pro_annual',
          transactionId: '',
          purchasedAt: 'yesterday',
        },
      }),
      syncBilling: async () => (premiumOnServer ? paidSync : freeSync),
    });
    signIn(OWNER_A, deps, storage);
    await useAccessStore.getState().initialize();

    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);
    expect(deps.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(deps.backend.syncBilling).toHaveBeenLastCalledWith();
    const state = useAccessStore.getState();
    expect(state.pendingFulfilment).toMatchObject({
      schemaVersion: 1,
      owner: OWNER_A,
      source: 'purchase',
      attempts: 1,
    });
    expect(state.pendingFulfilment?.transaction).toBeUndefined();
    expect(state.fulfilmentStatus).toBe('pending');
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    expect(selectHasPremium(state)).toBe(false);
    expect(storage.records.get(OWNER_A)?.id).toBe(state.pendingFulfilment?.id);

    // Repeated action: the user taps Continue again.
    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.backend_verification_pending',
    );

    // Relaunch on the same device: the journal is the only source.
    signOut();
    const relaunch = dependencies({
      syncBilling: async () => (premiumOnServer ? paidSync : freeSync),
    });
    signIn(OWNER_A, relaunch, storage);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().pendingFulfilment?.attempts).toBe(2);
    expect(relaunch.store.purchase).not.toHaveBeenCalled();

    premiumOnServer = true;
    expect(await useAccessStore.getState().retryPendingFulfilment()).toBe(true);
    expect(useAccessStore.getState()).toMatchObject({
      status: 'ready',
      pendingFulfilment: null,
      fulfilmentStatus: 'clear',
      error: null,
    });
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(storage.records.has(OWNER_A)).toBe(false);
    expect(relaunch.store.purchase).not.toHaveBeenCalled();
  });

  it('A8 store SDK failure during initialize() keeps the server access snapshot authoritative and does not fabricate or drop premium', async () => {
    const storage = memoryStorage();
    const deps = dependencies({ getAccess: async () => paidAccess });
    deps.store.configure.mockRejectedValue(new Error('RevenueCat unreachable'));
    signIn(OWNER_A, deps, storage);

    await useAccessStore.getState().initialize();
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toEqual(paidAccess);
    expect(selectHasPremium(state)).toBe(true);
    expect(state.plans).toBeNull();
    expect(state.error?.code).toBe('billing.unconfigured');
    expect(deps.store.loadPlans).not.toHaveBeenCalled();

    // Purchase is impossible without offerings, but must not throw or unlock.
    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    expect(deps.store.purchase).not.toHaveBeenCalled();
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
  });

  it('A9 an access read that exceeds the request bound fails closed, and its late payload is discarded when it finally arrives', async () => {
    jest.useFakeTimers();
    try {
      const storage = memoryStorage();
      const slow = deferred<CanonicalAccessState>();
      let calls = 0;
      const deps = dependencies({
        getAccess: () => {
          calls += 1;
          return calls === 1 ? slow.promise : Promise.resolve(freeAccess);
        },
      });
      signIn(OWNER_A, deps, storage);

      const init = useAccessStore.getState().initialize();
      await flush();
      expect(useAccessStore.getState().status).toBe('loading');
      jest.advanceTimersByTime(BILLING_REQUEST_TIMEOUT_MS + 1);
      await init;
      expect(useAccessStore.getState()).toMatchObject({
        status: 'error',
        operation: 'idle',
        canonicalAccess: null,
      });
      expect(useAccessStore.getState().error?.retryable).toBe(true);

      slow.resolve(paidAccess);
      await flush();
      expect(useAccessStore.getState().canonicalAccess).toBeNull();
      expect(selectHasPremium(useAccessStore.getState())).toBe(false);

      expect(await useAccessStore.getState().refreshAccess()).toBe(true);
      expect(useAccessStore.getState()).toMatchObject({
        status: 'ready',
        canonicalAccess: freeAccess,
        error: null,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('A10 a structurally invalid pending record returned by storage fails closed and blocks purchase and restore', async () => {
    const storage = memoryStorage();
    const invalid = {
      schemaVersion: 1,
      id: '55555555-5555-4555-8555-555555555555',
      owner: OWNER_A,
      source: 'purchase',
      state: 'pending',
      completedAtMs: Date.now(),
      attempts: 40,
      lastAttemptAtMs: Date.now(),
    } as unknown as PendingFulfilment;
    storage.records.set(OWNER_A, invalid);
    const deps = dependencies();
    signIn(OWNER_A, deps, storage);

    await useAccessStore.getState().initialize();
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toBeNull();
    expect(state.fulfilmentStatus).toBe('unavailable');
    expect(state.pendingFulfilment).toBeNull();
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    expect(deps.backend.getAccess).not.toHaveBeenCalled();
    expect(deps.backend.syncBilling).not.toHaveBeenCalled();

    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    expect(deps.store.purchase).not.toHaveBeenCalled();
    expect(await useAccessStore.getState().restorePurchases()).toBe(false);
    expect(deps.store.restore).not.toHaveBeenCalled();
    expect(selectHasPremium(useAccessStore.getState())).toBe(false);
    expect(storage.records.get(OWNER_A)).toBe(invalid);
  });

  it('A7 clearError() during a pending recovery does not erase the pending marker or reopen the store', async () => {
    const storage = memoryStorage();
    const deps = dependencies({ syncBilling: async () => freeSync });
    signIn(OWNER_A, deps, storage);
    await useAccessStore.getState().initialize();
    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    expect(useAccessStore.getState().pendingFulfilment).not.toBeNull();

    useAccessStore.getState().clearError();
    expect(useAccessStore.getState().error).toBeNull();
    expect(useAccessStore.getState().pendingFulfilment).not.toBeNull();

    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.backend_verification_pending',
    );
    expect(await useAccessStore.getState().restorePurchases()).toBe(false);
    expect(deps.store.restore).not.toHaveBeenCalled();
  });
});
