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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** Dependencies whose every getAccess() call is a separately gated promise. */
function gatedDependencies() {
  const accesses: ReturnType<typeof deferred<CanonicalAccessState>>[] = [];
  const clients = dependencies({
    getAccess: () => {
      const gate = deferred<CanonicalAccessState>();
      accesses.push(gate);
      return gate.promise;
    },
  });
  return { clients, accesses };
}

describe('accessStore read sequencing (latest issued read wins)', () => {
  it('a superseded refresh that succeeds returns false and leaves the newer snapshot untouched', async () => {
    const { clients, accesses } = gatedDependencies();
    configureAccessStore(clients);
    useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess });

    const older = useAccessStore.getState().refreshAccess();
    const newer = useAccessStore.getState().refreshAccess();
    expect(accesses).toHaveLength(2);

    accesses[1]!.resolve(paidAccess);
    await expect(newer).resolves.toBe(true);
    const afterNewer = useAccessStore.getState();
    expect(afterNewer.status).toBe('ready');
    expect(afterNewer.canonicalAccess).toEqual(paidAccess);

    accesses[0]!.resolve(freeAccess);
    await expect(older).resolves.toBe(false);
    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.canonicalAccess).toEqual(paidAccess);
  });

  it('a superseded refresh that fails returns false and neither nulls the snapshot nor surfaces an error', async () => {
    const { clients, accesses } = gatedDependencies();
    configureAccessStore(clients);
    useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess });

    const older = useAccessStore.getState().refreshAccess();
    const newer = useAccessStore.getState().refreshAccess();

    accesses[1]!.resolve(paidAccess);
    await expect(newer).resolves.toBe(true);

    accesses[0]!.reject(new Error('network timeout'));
    await expect(older).resolves.toBe(false);
    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.canonicalAccess).toEqual(paidAccess);
    expect(selectHasPremium(state)).toBe(true);
  });

  it('an initialize overtaken by a refresh still installs store plans but never its stale access snapshot', async () => {
    const { clients, accesses } = gatedDependencies();
    configureAccessStore(clients);

    const init = useAccessStore.getState().initialize();
    expect(useAccessStore.getState().status).toBe('loading');
    // Analyze's unmount refresh only skips 'idle', so it can overlap a
    // loading initialize().
    const refresh = useAccessStore.getState().refreshAccess();
    await flush();
    expect(accesses).toHaveLength(2);
    // getAccess order: the refresh read fires synchronously, initialize's
    // read waits for store.configure().
    const refreshRead = accesses[0]!;
    const initializeRead = accesses[1]!;

    refreshRead.resolve(paidAccess);
    await expect(refresh).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);

    initializeRead.resolve(freeAccess);
    await init;

    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toEqual(paidAccess);
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.plans).toEqual(plans);
    expect(state.selectedPeriod).toBe('annual');
  });

  it('a refresh issued after a superseded initialize is not blocked by it (only the newest read commits)', async () => {
    const { clients, accesses } = gatedDependencies();
    configureAccessStore(clients);
    const init = useAccessStore.getState().initialize();
    const refresh = useAccessStore.getState().refreshAccess();
    await flush();
    // Older initialize read lands first with the pre-run ledger.
    accesses[1]!.resolve(freeAccess);
    await init;
    expect(useAccessStore.getState().status).toBe('loading');
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    // Newest read lands last and is the one that commits.
    accesses[0]!.resolve(paidAccess);
    await expect(refresh).resolves.toBe(true);
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);
  });

  it('a canonical billing sync that commits while an older refresh is in flight is not overwritten by that read', async () => {
    const { clients, accesses } = gatedDependencies();
    configureAccessStore(clients);
    useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess });

    const older = useAccessStore.getState().refreshAccess();
    await expect(useAccessStore.getState().syncBilling()).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);

    accesses[0]!.resolve(freeAccess);
    await expect(older).resolves.toBe(false);
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toEqual(paidAccess);
    expect(state.status).toBe('ready');
    expect(selectHasPremium(state)).toBe(true);
  });

  it('a refresh issued after a billing sync commits still wins over that sync', async () => {
    configureAccessStore(dependencies());
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().syncBilling()).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
  });
});
