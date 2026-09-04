/**
 * Structural audit #2 (mobile-billing-paywall) — accessStore concurrency and
 * timing probes. Every test states the invariant the store SHOULD hold; a
 * failing test on the audited commit is the reproduction of a finding.
 *
 * Realistic triggers modelled here (see accessStore.ts):
 *  - SettingsScreen `useFocusEffect` → refreshAccess() on every visit
 *  - AnalyzeScreen unmount cleanup → refreshAccess() after a scoring run
 *  - PaywallScreen effect → initialize() only while status === 'idle'
 *  - RootNavigator PaywallRoute → onPurchased → navigation.goBack()
 */
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  CanonicalBillingSync,
  StorePlans,
} from '../../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectHasPremium,
  useAccessStore,
} from '../../../src/state/accessStore';

const freeAccess: CanonicalAccessState = {
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

const paidAccess: CanonicalAccessState = {
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

function premiumSync(): CanonicalBillingSync {
  return {
    billing: {
      premium: true,
      productKey: 'pickle_sensei_pro_annual',
      expiresAt: '2027-09-01T00:00:00.000Z',
      verifiedAt: '2026-09-04T00:00:00.000Z',
    },
    access: paidAccess,
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

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function dependencies(overrides?: {
  getAccess?: () => Promise<CanonicalAccessState>;
  syncBilling?: () => Promise<CanonicalBillingSync>;
  purchase?: BillingAccessDependencies['store']['purchase'];
  loadPlans?: () => Promise<StorePlans>;
}): BillingAccessDependencies & {
  store: { loadPlans: jest.Mock; purchase: jest.Mock };
  backend: { getAccess: jest.Mock; syncBilling: jest.Mock };
} {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(overrides?.loadPlans ?? (async () => plans)),
      purchase: jest.fn(
        overrides?.purchase ??
          (async () => ({
            premium: true,
            productId: 'pickle_sensei_pro_annual',
            expirationDate: '2027-09-01T00:00:00.000Z',
          })),
      ),
      restore: jest.fn(async () => ({
        premium: true,
        productId: 'pickle_sensei_pro_annual',
        expirationDate: '2027-09-01T00:00:00.000Z',
      })),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(overrides?.getAccess ?? (async () => freeAccess)),
      syncBilling: jest.fn(
        overrides?.syncBilling ?? (async () => premiumSync()),
      ),
    },
  };
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('probe B — stale refreshAccess() result vs. a newer purchase sync', () => {
  it('a GET /v1/me/access started before the purchase must not revert verified premium', async () => {
    const slowGet = deferred<CanonicalAccessState>();
    let calls = 0;
    const deps = dependencies({
      getAccess: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve(freeAccess) : slowGet.promise;
      },
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().plans).toEqual(plans);

    // AnalyzeScreen unmount (or a Settings visit) kicks off a refresh whose
    // response is slow on a degraded network …
    const refresh = useAccessStore.getState().refreshAccess();
    await flush();
    expect(useAccessStore.getState().status).toBe('loading');

    // … meanwhile the user completes a purchase; the backend verifies it.
    const purchased = await useAccessStore.getState().purchaseSelected();
    expect(purchased).toBe(true);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(deps.backend.syncBilling).toHaveBeenCalledTimes(1);

    // The pre-purchase snapshot finally lands.
    slowGet.resolve(freeAccess);
    await refresh;

    // INVARIANT: the newer, server-verified premium sync wins; a stale
    // pre-purchase snapshot must not clobber it (paywallRequired flips back
    // to true and the rating gate sends a paying user to the Paywall).
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(useAccessStore.getState().canonicalAccess?.paywallRequired).toBe(
      false,
    );
  });
});

describe('probe C — refreshAccess() before initialize() (Settings visited first)', () => {
  it('opening the Paywall after a Settings-first refresh must still load store plans', async () => {
    const deps = dependencies();
    configureAccessStore(deps);

    // Fresh sign-in: status idle. SettingsScreen focus → refreshAccess().
    await useAccessStore.getState().refreshAccess();
    expect(useAccessStore.getState().status).toBe('ready');

    // Settings › Membership → Paywall. The screen only calls initialize()
    // while status === 'idle', so nothing here triggers it; but even an
    // explicit initialize() must load plans for the pricing page.
    await useAccessStore.getState().initialize();

    // INVARIANT: a 'ready' store with a configured account has plans (or a
    // typed offerings error). Here it has neither: the pricing page renders
    // "Store pricing is unavailable" with Continue disabled until Try again.
    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(deps.store.loadPlans).toHaveBeenCalled();
    expect(state.plans).toEqual(plans);
  });

  it('initialize() must not be skipped while refreshAccess() holds status loading', async () => {
    const slowGet = deferred<CanonicalAccessState>();
    let calls = 0;
    const deps = dependencies({
      getAccess: () => {
        calls += 1;
        return calls === 1 ? slowGet.promise : Promise.resolve(freeAccess);
      },
    });
    configureAccessStore(deps);

    const refresh = useAccessStore.getState().refreshAccess();
    await flush();
    expect(useAccessStore.getState().status).toBe('loading');

    const init = useAccessStore.getState().initialize();
    slowGet.resolve(freeAccess);
    await Promise.all([refresh, init]);

    expect(useAccessStore.getState().status).toBe('ready');
    expect(deps.store.configure).toHaveBeenCalled();
    expect(useAccessStore.getState().plans).toEqual(plans);
  });
});

describe('probe D — sign-out between store purchase and backend sync', () => {
  it('drops the stale sync result and never unlocks the next account (by design)', async () => {
    const storePurchase = deferred<{
      premium: boolean;
      productId: string | null;
      expirationDate: string | null;
    }>();
    const deps = dependencies({ purchase: () => storePurchase.promise });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();

    const purchase = useAccessStore.getState().purchaseSelected();
    await flush();
    expect(useAccessStore.getState().operation).toBe('purchasing');

    // Sign-out: authStore clears the configuration (new version).
    clearAccessStoreConfiguration();
    storePurchase.resolve({
      premium: true,
      productId: 'pickle_sensei_pro_annual',
      expirationDate: null,
    });
    expect(await purchase).toBe(false);

    // The sync for the signed-out account is intentionally abandoned; the
    // RevenueCat webhook / a later Restore is the recovery path (I23).
    expect(deps.backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(useAccessStore.getState().status).toBe('idle');
    expect(useAccessStore.getState().operation).toBe('idle');
  });
});

describe('probe E — backend sync fails after a completed store purchase', () => {
  it('fails closed with a retryable verification-pending error (documented behaviour)', async () => {
    const deps = dependencies({
      syncBilling: async () => {
        throw new Error('network');
      },
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();

    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    const state = useAccessStore.getState();
    expect(state.status).toBe('error');
    expect(state.operation).toBe('idle');
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    expect(state.error?.retryable).toBe(true);
    // Fail-closed: the previously valid free snapshot is dropped too, so the
    // Paywall shows "Verify access" until Try again / Restore / a refresh.
    expect(state.canonicalAccess).toBeNull();
    // Recovery paths remain available without a fresh purchase.
    expect(await useAccessStore.getState().refreshAccess()).toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
  });
});

describe('probe F — concurrent refreshAccess() calls', () => {
  it('two overlapping refreshes: the LAST response wins regardless of request order', async () => {
    const first = deferred<CanonicalAccessState>();
    const second = deferred<CanonicalAccessState>();
    let calls = 0;
    const deps = dependencies({
      getAccess: () => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
    });
    configureAccessStore(deps);
    const r1 = useAccessStore.getState().refreshAccess();
    const r2 = useAccessStore.getState().refreshAccess();
    // Newer request answers first with the newer ledger (used=2)…
    second.resolve(freeAccess);
    await flush();
    // …then the older request answers with an OLDER ledger (used=1).
    first.resolve({
      ...freeAccess,
      freeRatings: {
        limit: 2,
        used: 1,
        reserved: 0,
        remaining: 1,
        availableToReserve: 1,
      },
      canStartRating: true,
      paywallRequired: false,
    });
    await Promise.all([r1, r2]);
    // INVARIANT: an out-of-order older snapshot must not overwrite a newer one.
    expect(useAccessStore.getState().canonicalAccess?.freeRatings.used).toBe(2);
  });
});

describe('probe G — purchase after plans were never loaded', () => {
  it('purchaseSelected() with plans null surfaces a typed offerings error (no crash)', async () => {
    configureAccessStore(dependencies());
    await useAccessStore.getState().refreshAccess();
    expect(useAccessStore.getState().plans).toBeNull();
    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.offerings_unavailable',
    );
    expect(useAccessStore.getState().status).toBe('error');
  });
});

describe('probe H — transient refresh failure after a verified premium snapshot', () => {
  // Trigger: SettingsScreen useFocusEffect → refreshAccess() on every visit.
  // A paying member whose Settings visit hits one network blip loses the
  // verified snapshot (canonicalAccess → null, status → error), and
  // useRatingRouteGate (RootNavigator.tsx:133-139) then routes Analyze to
  // the Paywall until a retry succeeds.
  it('a retryable network error must not discard a previously verified premium snapshot', async () => {
    let calls = 0;
    const deps = dependencies({
      getAccess: async () => {
        calls += 1;
        if (calls === 1) return paidAccess;
        throw new TypeError('Network request failed');
      },
    });
    configureAccessStore(deps);
    expect(await useAccessStore.getState().refreshAccess()).toBe(true);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);

    expect(await useAccessStore.getState().refreshAccess()).toBe(false);
    const state = useAccessStore.getState();
    expect(state.error?.code).toBe('billing.backend_unavailable');
    expect(state.error?.retryable).toBe(true);
    // INVARIANT under test: the last verified snapshot survives a transient
    // failure (the error is reported alongside it, not instead of it).
    expect(state.canonicalAccess).toEqual(paidAccess);
    expect(selectHasPremium(state)).toBe(true);
  });

  it('documents the gate outcome: status error + canonicalAccess null is exactly the Paywall branch', async () => {
    const deps = dependencies({
      getAccess: async () => {
        throw new TypeError('Network request failed');
      },
    });
    configureAccessStore(deps);
    await useAccessStore.getState().refreshAccess();
    const { status, canonicalAccess } = useAccessStore.getState();
    expect(status).toBe('error');
    expect(canonicalAccess).toBeNull();
    // Mirrors RootNavigator.useRatingRouteGate's replace('Paywall') condition.
    const routesToPaywall =
      !canonicalAccess?.canStartRating &&
      (canonicalAccess !== null ||
        status === 'ready' ||
        status === 'unconfigured' ||
        status === 'error');
    expect(routesToPaywall).toBe(true);
  });
});
