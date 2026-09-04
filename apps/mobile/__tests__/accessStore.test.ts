import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  StorePlans,
} from '../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectCanStartRating,
  selectHasPremium,
  useAccessStore,
} from '../src/state/accessStore';

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
    productId: 'premium_annual_3999',
    period: 'annual',
    price: 39.99,
    priceString: '$39.99',
    pricePerMonthString: '$3.33',
    freeTrial: null,
  },
  monthly: {
    id: 'monthly-plan',
    productId: 'premium_monthly_499',
    period: 'monthly',
    price: 4.99,
    priceString: '$4.99',
    pricePerMonthString: '$4.99',
    freeTrial: null,
  },
  lifetime: {
    id: 'lifetime-plan',
    productId: 'premium_lifetime_15999',
    period: 'lifetime',
    price: 159.99,
    priceString: '$159.99',
    pricePerMonthString: null,
    freeTrial: null,
  },
};

function dependencies(options?: {
  getAccess?: () => Promise<CanonicalAccessState>;
  syncBilling?: BillingAccessDependencies['backend']['syncBilling'];
  loadPlans?: () => Promise<StorePlans>;
}): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(options?.loadPlans ?? (async () => plans)),
      purchase: jest.fn(async () => ({
        premium: true,
        productId: 'premium_annual_3999',
        expirationDate: '2027-08-27T00:00:00.000Z',
      })),
      restore: jest.fn(async () => ({
        premium: true,
        productId: 'premium_annual_3999',
        expirationDate: '2027-08-27T00:00:00.000Z',
      })),
      readEntitlement: jest.fn(async () => ({
        premium: true,
        productId: 'premium_annual_3999',
        expirationDate: '2027-08-27T00:00:00.000Z',
      })),
    },
    backend: {
      getAccess: jest.fn(options?.getAccess ?? (async () => freeAccess)),
      syncBilling: jest.fn(
        options?.syncBilling ??
          (async () => ({
            billing: {
              premium: true,
              productKey: 'premium_annual_3999',
              expiresAt: '2027-08-27T00:00:00.000Z',
              verifiedAt: '2026-08-27T00:00:00.000Z',
            },
            access: paidAccess,
          })),
      ),
    },
  };
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('accessStore', () => {
  it('starts explicitly unconfigured and fails closed', async () => {
    await useAccessStore.getState().initialize();
    const state = useAccessStore.getState();
    expect(state.status).toBe('unconfigured');
    expect(state.canonicalAccess).toBeNull();
    expect(selectHasPremium(state)).toBe(false);
    expect(selectCanStartRating(state)).toBe(false);
  });

  it('loads canonical allowance and selects annual by default', async () => {
    configureAccessStore(dependencies());
    await useAccessStore.getState().initialize();
    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.selectedPeriod).toBe('annual');
    expect(state.plans?.lifetime?.id).toBe('lifetime-plan');
    expect(state.canonicalAccess).toEqual(freeAccess);
  });

  it('prefers the lifetime plan over monthly when annual is unavailable', async () => {
    configureAccessStore(
      dependencies({ loadPlans: async () => ({ ...plans, annual: null }) }),
    );
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().selectedPeriod).toBe('lifetime');
  });

  it('purchases the lifetime plan once it is selected', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    useAccessStore.getState().selectPeriod('lifetime');
    expect(useAccessStore.getState().selectedPeriod).toBe('lifetime');
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    expect(clients.store.purchase).toHaveBeenCalledWith('lifetime-plan');
  });

  it('ignores selecting a period whose plan the store did not return', async () => {
    configureAccessStore(
      dependencies({ loadPlans: async () => ({ ...plans, lifetime: null }) }),
    );
    await useAccessStore.getState().initialize();
    useAccessStore.getState().selectPeriod('lifetime');
    expect(useAccessStore.getState().selectedPeriod).toBe('annual');
  });

  it('keeps verified free ratings available when store pricing is unconfigured', async () => {
    const clients = dependencies();
    (clients.store.configure as jest.Mock).mockRejectedValueOnce(
      new Error('missing public SDK key'),
    );
    configureAccessStore(clients);

    await useAccessStore.getState().initialize();

    const state = useAccessStore.getState();
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(clients.store.loadPlans).not.toHaveBeenCalled();
    expect(state.canonicalAccess).toEqual(freeAccess);
    expect(selectCanStartRating(state)).toBe(true);
    expect(state.status).toBe('unconfigured');
    expect(state.error?.code).toBe('billing.unconfigured');
  });

  it('does not unlock from a store purchase when backend verification fails', async () => {
    const clients = dependencies({
      syncBilling: async () => {
        throw new Error('backend offline');
      },
    });
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    const purchased = await useAccessStore.getState().purchaseSelected();
    const state = useAccessStore.getState();
    expect(purchased).toBe(false);
    expect(clients.store.purchase).toHaveBeenCalledWith('annual-plan');
    expect(state.canonicalAccess).toBeNull();
    expect(selectHasPremium(state)).toBe(false);
    expect(state.error?.code).toBe('billing.backend_verification_pending');
  });

  it('unlocks only after canonical billing sync returns premium', async () => {
    configureAccessStore(dependencies());
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    const state = useAccessStore.getState();
    expect(selectHasPremium(state)).toBe(true);
    expect(state.canonicalAccess).toEqual(paidAccess);
  });

  it('discards a refresh that started before a purchase verified (stale GET never demotes premium)', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    let resolveStale!: (value: CanonicalAccessState) => void;
    const staleGet = new Promise<CanonicalAccessState>(resolve => {
      resolveStale = resolve;
    });
    (clients.backend.getAccess as jest.Mock).mockImplementationOnce(
      () => staleGet,
    );
    const staleRefresh = useAccessStore.getState().refreshAccess();

    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);

    resolveStale(freeAccess);
    await expect(staleRefresh).resolves.toBe(true);
    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.canonicalAccess).toEqual(paidAccess);
    expect(selectHasPremium(state)).toBe(true);
  });

  it('still applies a refresh that starts after a purchase verified (no over-correction)', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);

    // A NEWER server read wins even when it demotes: e.g. the subscription
    // lapsed or was refunded since the purchase sync.
    const lapsedAccess: CanonicalAccessState = {
      ...freeAccess,
      freeRatings: { ...freeAccess.freeRatings, used: 2, remaining: 0 },
    };
    (clients.backend.getAccess as jest.Mock).mockImplementationOnce(
      async () => lapsedAccess,
    );
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(
      true,
    );
    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.canonicalAccess).toEqual(lapsedAccess);
    expect(selectHasPremium(state)).toBe(false);
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(2);
  });

  it('applies the newest of two overlapping refreshes regardless of response order', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    let resolveFirst!: (value: CanonicalAccessState) => void;
    let resolveSecond!: (value: CanonicalAccessState) => void;
    (clients.backend.getAccess as jest.Mock)
      .mockImplementationOnce(
        () =>
          new Promise<CanonicalAccessState>(resolve => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<CanonicalAccessState>(resolve => {
            resolveSecond = resolve;
          }),
      );
    const first = useAccessStore.getState().refreshAccess();
    const second = useAccessStore.getState().refreshAccess();
    resolveSecond(paidAccess);
    await second;
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);
    expect(useAccessStore.getState().status).toBe('ready');
    resolveFirst(freeAccess);
    await expect(first).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);
    expect(useAccessStore.getState().status).toBe('ready');
  });

  it('initialize() configures the store exactly once even while a refresh is loading', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    let resolveRefresh!: (value: CanonicalAccessState) => void;
    (clients.backend.getAccess as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<CanonicalAccessState>(resolve => {
          resolveRefresh = resolve;
        }),
    );
    const refresh = useAccessStore.getState().refreshAccess();
    expect(useAccessStore.getState().status).toBe('loading');

    await Promise.all([
      useAccessStore.getState().initialize(),
      useAccessStore.getState().initialize(),
    ]);
    expect(clients.store.configure).toHaveBeenCalledTimes(1);
    expect(clients.store.loadPlans).toHaveBeenCalledTimes(1);
    expect(clients.store.restore).not.toHaveBeenCalled();
    expect(clients.backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState().plans).toEqual(plans);

    resolveRefresh(freeAccess);
    await refresh;
    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.canonicalAccess).toEqual(freeAccess);
    expect(state.plans).toEqual(plans);
    // The refresh that started first is the OLDER server read; initialize()'s
    // own GET landed after it and is what the store keeps.
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(2);
  });

  it('a sign-out during initialize() lets the next account initialize immediately', async () => {
    const first = dependencies();
    let resolveConfigure!: () => void;
    (first.store.configure as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          resolveConfigure = resolve;
        }),
    );
    configureAccessStore(first);
    const stalled = useAccessStore.getState().initialize();

    clearAccessStoreConfiguration();
    const second = dependencies();
    configureAccessStore(second);
    await useAccessStore.getState().initialize();
    expect(second.store.configure).toHaveBeenCalledTimes(1);
    expect(second.store.loadPlans).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().plans).toEqual(plans);

    resolveConfigure();
    await stalled;
    expect(first.store.loadPlans).not.toHaveBeenCalled();
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
  });

  it('clears stale access if a canonical refresh fails', async () => {
    let fail = false;
    configureAccessStore(
      dependencies({
        getAccess: async () => {
          if (fail) throw new Error('offline');
          return freeAccess;
        },
      }),
    );
    await useAccessStore.getState().initialize();
    fail = true;
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(
      false,
    );
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(selectCanStartRating(useAccessStore.getState())).toBe(false);
  });

  it('cannot repopulate the previous account after sign-out mid-refresh', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    let resolveOldAccount!: (value: CanonicalAccessState) => void;
    const oldAccountRefresh = new Promise<CanonicalAccessState>(resolve => {
      resolveOldAccount = resolve;
    });
    (clients.backend.getAccess as jest.Mock).mockImplementationOnce(
      () => oldAccountRefresh,
    );

    const refresh = useAccessStore.getState().refreshAccess();
    clearAccessStoreConfiguration();
    resolveOldAccount(paidAccess);
    await refresh;

    const state = useAccessStore.getState();
    expect(state.status).toBe('idle');
    expect(state.canonicalAccess).toBeNull();
    expect(selectHasPremium(state)).toBe(false);
  });
});
