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

  it('applies a refresh that starts after a purchase resolved', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);

    const expiredAccess: CanonicalAccessState = {
      ...freeAccess,
      freeRatings: { ...freeAccess.freeRatings, used: 2, remaining: 0 },
      canStartRating: false,
      paywallRequired: true,
    };
    (clients.backend.getAccess as jest.Mock).mockImplementationOnce(
      async () => expiredAccess,
    );

    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.canonicalAccess).toEqual(expiredAccess);
    expect(selectHasPremium(state)).toBe(false);
  });

  it('a refresh that started before purchaseSelected() resolved never overwrites the verified premium snapshot', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);

    let resolveStale!: (value: CanonicalAccessState) => void;
    (clients.backend.getAccess as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<CanonicalAccessState>(resolve => {
          resolveStale = resolve;
        }),
    );
    const staleRefresh = useAccessStore.getState().refreshAccess();

    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);

    resolveStale({
      ...freeAccess,
      canStartRating: false,
      paywallRequired: true,
    });
    await staleRefresh;

    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.canonicalAccess).toEqual(paidAccess);
    expect(selectHasPremium(state)).toBe(true);
    expect(selectCanStartRating(state)).toBe(true);
  });

  it('a refresh that started before restorePurchases() resolved never overwrites the restored premium snapshot', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    let resolveStale!: (value: CanonicalAccessState) => void;
    (clients.backend.getAccess as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<CanonicalAccessState>(resolve => {
          resolveStale = resolve;
        }),
    );
    const staleRefresh = useAccessStore.getState().refreshAccess();

    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      true,
    );
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);

    resolveStale({
      ...freeAccess,
      canStartRating: false,
      paywallRequired: true,
    });
    await staleRefresh;

    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toEqual(paidAccess);
    expect(selectHasPremium(state)).toBe(true);
  });

  it('a refresh that started before syncBilling() resolved never overwrites the synced premium snapshot', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    let resolveStale!: (value: CanonicalAccessState) => void;
    (clients.backend.getAccess as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<CanonicalAccessState>(resolve => {
          resolveStale = resolve;
        }),
    );
    const staleRefresh = useAccessStore.getState().refreshAccess();

    await expect(useAccessStore.getState().syncBilling()).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);

    resolveStale({
      ...freeAccess,
      canStartRating: false,
      paywallRequired: true,
    });
    await staleRefresh;

    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.canonicalAccess).toEqual(paidAccess);
    expect(selectHasPremium(state)).toBe(true);
  });

  it('a refresh that started before a purchase and then FAILS never nulls the verified premium snapshot', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    let rejectStale!: (reason: unknown) => void;
    (clients.backend.getAccess as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<CanonicalAccessState>((_resolve, reject) => {
          rejectStale = reject;
        }),
    );
    const staleRefresh = useAccessStore.getState().refreshAccess();

    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);

    rejectStale(new Error('offline'));
    await staleRefresh;

    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.canonicalAccess).toEqual(paidAccess);
    expect(selectHasPremium(state)).toBe(true);
    expect(selectCanStartRating(state)).toBe(true);
  });

  it('an older refresh that lands after a newer refresh never overwrites the newer snapshot', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    const spentAccess: CanonicalAccessState = {
      ...freeAccess,
      freeRatings: {
        ...freeAccess.freeRatings,
        used: 2,
        remaining: 0,
        availableToReserve: 0,
      },
      canStartRating: false,
      paywallRequired: true,
    };
    let resolveOlder!: (value: CanonicalAccessState) => void;
    let resolveNewer!: (value: CanonicalAccessState) => void;
    (clients.backend.getAccess as jest.Mock)
      .mockImplementationOnce(
        () =>
          new Promise<CanonicalAccessState>(resolve => {
            resolveOlder = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<CanonicalAccessState>(resolve => {
            resolveNewer = resolve;
          }),
      );
    const olderRefresh = useAccessStore.getState().refreshAccess();
    const newerRefresh = useAccessStore.getState().refreshAccess();

    resolveNewer(spentAccess);
    await expect(newerRefresh).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(spentAccess);

    resolveOlder(freeAccess);
    await olderRefresh;

    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.canonicalAccess).toEqual(spentAccess);
    expect(selectCanStartRating(state)).toBe(false);
  });

  it('a refresh failure that is the newest operation still fails closed after a purchase', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    (clients.backend.getAccess as jest.Mock).mockRejectedValueOnce(
      new Error('offline'),
    );

    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(
      false,
    );
    const state = useAccessStore.getState();
    expect(state.status).toBe('error');
    expect(state.canonicalAccess).toBeNull();
    expect(selectHasPremium(state)).toBe(false);
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
