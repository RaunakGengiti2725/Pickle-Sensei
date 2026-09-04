import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  StorePlans,
} from '../src/billing';
import { BillingError } from '../src/billing/types';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectCanStartRating,
  selectHasPremium,
  useAccessStore,
} from '../src/state/accessStore';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';

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
  clearApiSession();
});

const owner = '11111111-1111-4111-8111-111111111111';

function apiSession(bearerToken: string, canonicalAppUserId = owner) {
  return {
    apiBaseUrl: 'https://api.example.test',
    bearerToken,
    canonicalAppUserId,
    provider: 'google' as const,
    refreshToken: `refresh-${bearerToken}`,
    bearerExpiresAtMs: Date.now() + 3_600_000,
  };
}

/** What accessApi throws for a 401 (it also reports the bearer to the auth
 * store, whose keeper then rotates it). */
function signInExpired(): BillingError {
  return new BillingError(
    'billing.backend_unavailable',
    'Your sign-in has expired. Sign in again to check membership access.',
    false,
  );
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

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

  describe('recovery after bearer rotation (XCF-06)', () => {
    it('a 401 on the first access load followed by a bearer rotation re-runs the load automatically', async () => {
      establishApiSession(apiSession('stale-bearer'));
      const getAccess = jest
        .fn<Promise<CanonicalAccessState>, []>()
        .mockRejectedValueOnce(signInExpired())
        .mockResolvedValue(freeAccess);
      configureAccessStore(dependencies({ getAccess }));

      await useAccessStore.getState().initialize();
      expect(useAccessStore.getState().status).toBe('error');
      expect(useAccessStore.getState().canonicalAccess).toBeNull();
      expect(getAccess).toHaveBeenCalledTimes(1);

      // The keeper answers the 401 by rotating the bearer for the SAME account.
      establishApiSession(apiSession('rotated-bearer'));
      await flushMicrotasks();

      expect(getAccess).toHaveBeenCalledTimes(2);
      const state = useAccessStore.getState();
      expect(state.status).toBe('ready');
      expect(state.canonicalAccess).toEqual(freeAccess);
      expect(state.error).toBeNull();
      expect(selectCanStartRating(state)).toBe(true);
    });

    it('a failed refreshAccess() is re-run once the bearer rotates, and only once per rotation', async () => {
      establishApiSession(apiSession('bearer-1'));
      const getAccess = jest
        .fn<Promise<CanonicalAccessState>, []>()
        .mockResolvedValueOnce(freeAccess)
        .mockRejectedValueOnce(signInExpired())
        .mockRejectedValueOnce(new Error('still offline'))
        .mockResolvedValue(paidAccess);
      configureAccessStore(dependencies({ getAccess }));
      await useAccessStore.getState().initialize();
      await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(
        false,
      );
      expect(getAccess).toHaveBeenCalledTimes(2);

      establishApiSession(apiSession('bearer-2'));
      await flushMicrotasks();
      // Re-run once; it failed again — no loop until the bearer moves again.
      expect(getAccess).toHaveBeenCalledTimes(3);
      expect(useAccessStore.getState().status).toBe('error');
      await flushMicrotasks();
      expect(getAccess).toHaveBeenCalledTimes(3);

      establishApiSession(apiSession('bearer-3'));
      await flushMicrotasks();
      expect(getAccess).toHaveBeenCalledTimes(4);
      expect(useAccessStore.getState().status).toBe('ready');
      expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);
    });

    it('a rotation that lands while the failed load is still in flight re-runs it as soon as the failure settles', async () => {
      establishApiSession(apiSession('stale-bearer'));
      let rejectFirst!: (error: unknown) => void;
      const getAccess = jest
        .fn<Promise<CanonicalAccessState>, []>()
        .mockImplementationOnce(
          () =>
            new Promise<CanonicalAccessState>((_, reject) => {
              rejectFirst = reject;
            }),
        )
        .mockResolvedValue(freeAccess);
      configureAccessStore(dependencies({ getAccess }));
      const load = useAccessStore.getState().initialize();
      await flushMicrotasks();
      establishApiSession(apiSession('rotated-bearer'));
      rejectFirst(signInExpired());
      await load;
      await flushMicrotasks();
      expect(getAccess).toHaveBeenCalledTimes(2);
      expect(useAccessStore.getState().status).toBe('ready');
      expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
    });

    it('a successful load is never re-run by a routine rotation, and no rotation re-runs a cleared configuration or another account', async () => {
      establishApiSession(apiSession('bearer-1'));
      const getAccess = jest
        .fn<Promise<CanonicalAccessState>, []>()
        .mockResolvedValue(freeAccess);
      configureAccessStore(dependencies({ getAccess }));
      await useAccessStore.getState().initialize();
      expect(getAccess).toHaveBeenCalledTimes(1);
      establishApiSession(apiSession('bearer-2'));
      await flushMicrotasks();
      expect(getAccess).toHaveBeenCalledTimes(1);

      const failing = jest
        .fn<Promise<CanonicalAccessState>, []>()
        .mockRejectedValue(signInExpired());
      configureAccessStore(dependencies({ getAccess: failing }));
      await useAccessStore.getState().initialize();
      expect(failing).toHaveBeenCalledTimes(1);
      // Another account's session is never this configuration's recovery.
      establishApiSession(
        apiSession('other-bearer', '22222222-2222-4222-8222-222222222222'),
      );
      await flushMicrotasks();
      expect(failing).toHaveBeenCalledTimes(1);
      clearAccessStoreConfiguration();
      establishApiSession(apiSession('bearer-3'));
      await flushMicrotasks();
      expect(failing).toHaveBeenCalledTimes(1);
      expect(useAccessStore.getState().status).toBe('idle');
    });
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
