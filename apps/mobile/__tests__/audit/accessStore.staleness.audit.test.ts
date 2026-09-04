/**
 * AUDIT HARNESS (mobile-analyze-capture execution pass, cloud plane).
 *
 * Adversarial probes for `accessStore` (the rating access gate):
 *  - the standalone `syncBilling` operation (uncovered by the existing
 *    suite at revision 4d812e1a: accessStore.ts lines 229-260);
 *  - sign-out / re-configuration racing an in-flight backend call;
 *  - out-of-order `refreshAccess` responses (a slow stale snapshot landing
 *    after a fresh one) — characterizes whether the store itself orders
 *    responses or relies on callers to serialize refreshes.
 *
 * New file only; production code and existing tests are untouched.
 */
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  StorePlans,
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectCanStartRating,
  selectPaywallRequired,
  useAccessStore,
} from '../../src/state/accessStore';

const oneLeft: CanonicalAccessState = {
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

const noneLeft: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 2,
    reserved: 0,
    remaining: 0,
    availableToReserve: 0,
  },
  canStartRating: false,
  paywallRequired: true,
};

const paid: CanonicalAccessState = {
  premium: true,
  entitlements: ['pickle_sensei_pro'],
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

function dependencies(options: {
  getAccess: () => Promise<CanonicalAccessState>;
  syncBilling?: BillingAccessDependencies['backend']['syncBilling'];
}): BillingAccessDependencies {
  const entitlement = {
    premium: true,
    productId: 'pickle_sensei_pro_annual',
    expirationDate: '2027-08-27T00:00:00.000Z',
  };
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async () => entitlement),
      restore: jest.fn(async () => entitlement),
      readEntitlement: jest.fn(async () => entitlement),
    },
    backend: {
      getAccess: jest.fn(options.getAccess),
      syncBilling: jest.fn(
        options.syncBilling ??
          (async () => ({
            billing: {
              premium: true,
              productKey: 'pickle_sensei_pro_annual',
              expiresAt: '2027-08-27T00:00:00.000Z',
              verifiedAt: '2026-08-27T00:00:00.000Z',
            },
            access: paid,
          })),
      ),
    },
  };
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('AUDIT accessStore — standalone syncBilling', () => {
  it('unconfigured syncBilling fails closed with billing.unconfigured and no access', async () => {
    const ok = await useAccessStore.getState().syncBilling();
    expect(ok).toBe(false);
    const state = useAccessStore.getState();
    expect(state.status).toBe('unconfigured');
    expect(state.canonicalAccess).toBeNull();
    expect(state.error?.code).toBe('billing.unconfigured');
    expect(selectPaywallRequired(state)).toBe(true);
  });

  it('a successful sync replaces the snapshot with the server one and reports premium', async () => {
    configureAccessStore(dependencies({ getAccess: async () => oneLeft }));
    await useAccessStore.getState().refreshAccess();
    expect(useAccessStore.getState().canonicalAccess).toEqual(oneLeft);

    const ok = await useAccessStore.getState().syncBilling();
    expect(ok).toBe(true);
    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.operation).toBe('idle');
    expect(state.canonicalAccess).toEqual(paid);
    expect(state.error).toBeNull();
  });

  it('a failed sync fails CLOSED: canonicalAccess null, verification_pending error, operation back to idle', async () => {
    configureAccessStore(
      dependencies({
        getAccess: async () => oneLeft,
        syncBilling: async () => {
          throw new Error('503');
        },
      }),
    );
    await useAccessStore.getState().refreshAccess();
    expect(selectCanStartRating(useAccessStore.getState())).toBe(true);

    const ok = await useAccessStore.getState().syncBilling();
    expect(ok).toBe(false);
    const state = useAccessStore.getState();
    expect(state.status).toBe('error');
    expect(state.operation).toBe('idle');
    // A verified free allowance is erased by a failed billing sync.
    expect(state.canonicalAccess).toBeNull();
    expect(selectCanStartRating(state)).toBe(false);
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    expect(state.error?.retryable).toBe(true);
  });

  it('a sync that returns a non-premium snapshot is NOT an error for the standalone operation (only purchase/restore treat it as pending)', async () => {
    configureAccessStore(
      dependencies({
        getAccess: async () => oneLeft,
        syncBilling: async () => ({
          billing: {
            premium: false,
            productKey: null,
            expiresAt: null,
            verifiedAt: '2026-08-27T00:00:00.000Z',
          },
          access: noneLeft,
        }),
      }),
    );
    const ok = await useAccessStore.getState().syncBilling();
    expect(ok).toBe(false);
    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.canonicalAccess).toEqual(noneLeft);
    expect(selectPaywallRequired(state)).toBe(true);
  });

  it('syncBilling is refused while another operation is in flight and does not call the backend', async () => {
    const gate = deferred<CanonicalAccessState>();
    const deps = dependencies({ getAccess: () => gate.promise });
    configureAccessStore(deps);
    useAccessStore.setState({ operation: 'purchasing' });
    const ok = await useAccessStore.getState().syncBilling();
    expect(ok).toBe(false);
    expect(deps.backend.syncBilling).not.toHaveBeenCalled();
    gate.resolve(oneLeft);
  });

  it('sign-out during an in-flight sync discards the late response (no cross-account leak)', async () => {
    const gate =
      deferred<
        Awaited<ReturnType<BillingAccessDependencies['backend']['syncBilling']>>
      >();
    configureAccessStore(
      dependencies({
        getAccess: async () => oneLeft,
        syncBilling: () => gate.promise,
      }),
    );
    const pending = useAccessStore.getState().syncBilling();
    expect(useAccessStore.getState().operation).toBe('syncing');
    clearAccessStoreConfiguration();
    gate.resolve({
      billing: {
        premium: true,
        productKey: 'pickle_sensei_pro_annual',
        expiresAt: '2027-08-27T00:00:00.000Z',
        verifiedAt: '2026-08-27T00:00:00.000Z',
      },
      access: paid,
    });
    expect(await pending).toBe(false);
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toBeNull();
    expect(state.operation).toBe('idle');
    expect(state.status).toBe('idle');
  });

  it('sign-out during an in-flight FAILING sync discards the late error too', async () => {
    const gate =
      deferred<
        Awaited<ReturnType<BillingAccessDependencies['backend']['syncBilling']>>
      >();
    configureAccessStore(
      dependencies({
        getAccess: async () => oneLeft,
        syncBilling: () => gate.promise,
      }),
    );
    const pending = useAccessStore.getState().syncBilling();
    clearAccessStoreConfiguration();
    gate.reject(new Error('503'));
    expect(await pending).toBe(false);
    const state = useAccessStore.getState();
    expect(state.error).toBeNull();
    expect(state.status).toBe('idle');
  });
});

describe('AUDIT accessStore — refreshAccess ordering under concurrency', () => {
  it('sign-out during an in-flight refresh discards the late snapshot', async () => {
    const gate = deferred<CanonicalAccessState>();
    configureAccessStore(dependencies({ getAccess: () => gate.promise }));
    const pending = useAccessStore.getState().refreshAccess();
    clearAccessStoreConfiguration();
    gate.resolve(oneLeft);
    expect(await pending).toBe(false);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(useAccessStore.getState().status).toBe('idle');
  });

  it('re-configuration for a NEW account during an in-flight refresh discards the old account snapshot', async () => {
    const oldGate = deferred<CanonicalAccessState>();
    configureAccessStore(dependencies({ getAccess: () => oldGate.promise }));
    const oldPending = useAccessStore.getState().refreshAccess();
    // New sign-in: fresh dependencies, fresh version.
    configureAccessStore(dependencies({ getAccess: async () => noneLeft }));
    await useAccessStore.getState().refreshAccess();
    oldGate.resolve(paid);
    expect(await oldPending).toBe(false);
    expect(useAccessStore.getState().canonicalAccess).toEqual(noneLeft);
  });

  it('CHARACTERIZATION: two overlapping refreshes on the SAME configuration resolve last-writer-wins — a slow stale snapshot overwrites a fresher one', async () => {
    const first = deferred<CanonicalAccessState>();
    const second = deferred<CanonicalAccessState>();
    const responses = [first.promise, second.promise];
    configureAccessStore(
      dependencies({
        getAccess: () => {
          const next = responses.shift();
          if (!next) throw new Error('unexpected third getAccess');
          return next;
        },
      }),
    );
    const slow = useAccessStore.getState().refreshAccess();
    const fast = useAccessStore.getState().refreshAccess();
    // The newer request answers first with the up-to-date ledger…
    second.resolve(noneLeft);
    expect(await fast).toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(noneLeft);
    // …then the older request answers with the pre-scoring snapshot.
    first.resolve(oneLeft);
    expect(await slow).toBe(true);
    // The store has no request ordering: the stale value wins.
    expect(useAccessStore.getState().canonicalAccess).toEqual(oneLeft);
    expect(selectCanStartRating(useAccessStore.getState())).toBe(true);
  });

  it('refreshAccess while status is already loading is NOT de-duplicated by the store (callers must guard)', async () => {
    const gate = deferred<CanonicalAccessState>();
    const deps = dependencies({ getAccess: () => gate.promise });
    configureAccessStore(deps);
    const a = useAccessStore.getState().refreshAccess();
    const b = useAccessStore.getState().refreshAccess();
    expect(deps.backend.getAccess).toHaveBeenCalledTimes(2);
    gate.resolve(oneLeft);
    await Promise.all([a, b]);
  });
});
