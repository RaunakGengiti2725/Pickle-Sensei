/**
 * Adversarial ordering tests for the MBP-1 fix in
 * `src/state/accessStore.ts` (candidate 87e4fa36 on top of f702f0f8).
 *
 * Every assertion is phrased as the EXPECTED behaviour ("a read that began
 * before a newer backend-verified commit never replaces that commit"), so a
 * failing test here is a real ordering hole, not a baseline pin.
 *
 * Section A drives `initialize()` — the OTHER GET /v1/me/access reader in the
 * same file — through the exact interleavings the fix guards in
 * `refreshAccess()`. Section B stress-tests the fixed `refreshAccess()` path
 * with orderings the candidate's own suite does not cover.
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
  selectHasPremium,
  selectPaywallRequired,
  useAccessStore,
} from '../../src/state/accessStore';

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

const oneLeftAccess: CanonicalAccessState = {
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
    productId: 'pickle_sensei_pro_yearly',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: {
    id: 'monthly-plan',
    productId: 'pickle_sensei_pro_monthly',
    period: 'monthly',
    price: 7.99,
    priceString: '$7.99',
    pricePerMonthString: '$7.99',
    freeTrial: null,
  },
  lifetime: {
    id: 'lifetime-plan',
    productId: 'pickle_sensei_pro_lifetime',
    period: 'lifetime',
    price: 159.99,
    priceString: '$159.99',
    pricePerMonthString: null,
    freeTrial: null,
  },
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

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const entitlement = {
  premium: true,
  productId: 'pickle_sensei_pro_yearly',
  expirationDate: '2027-09-04T00:00:00.000Z',
};

const paidSync = async () => ({
  billing: {
    premium: true,
    productKey: 'pickle_sensei_pro_yearly',
    expiresAt: '2027-09-04T00:00:00.000Z',
    verifiedAt: '2026-09-04T00:00:00.000Z',
  },
  access: paidAccess,
});

function dependencies(options?: {
  getAccess?: () => Promise<CanonicalAccessState>;
  loadPlans?: () => Promise<StorePlans>;
  syncBilling?: BillingAccessDependencies['backend']['syncBilling'];
}): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(options?.loadPlans ?? (async () => plans)),
      purchase: jest.fn(async () => entitlement),
      restore: jest.fn(async () => entitlement),
      readEntitlement: jest.fn(async () => entitlement),
    },
    backend: {
      getAccess: jest.fn(options?.getAccess ?? (async () => freeAccess)),
      syncBilling: jest.fn(options?.syncBilling ?? paidSync),
    },
  };
}

const mockGet = (clients: BillingAccessDependencies) =>
  clients.backend.getAccess as jest.Mock;

function expectPremium(label: string) {
  const state = useAccessStore.getState();
  expect({
    label,
    canonicalAccess: state.canonicalAccess,
    premium: selectHasPremium(state),
    canStartRating: selectCanStartRating(state),
    paywallRequired: selectPaywallRequired(state),
  }).toEqual({
    label,
    canonicalAccess: paidAccess,
    premium: true,
    canStartRating: true,
    paywallRequired: false,
  });
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('A. initialize() is the same GET /v1/me/access reader and must obey the same ordering', () => {
  it('A1 Paywall "Try again" (initialize) whose GET stalls, then Restore purchases verifies premium: the stale GET must not revert premium', async () => {
    // Settings-first: refreshAccess() ran, status is ready, plans never
    // loaded → PaywallScreen shows "Try again" (showRetry), which calls
    // initialize(). Restore purchases is enabled (busy === false).
    const clients = dependencies();
    configureAccessStore(clients);
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().plans).toBeNull();

    const stalledGet = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalledGet.promise);
    const retry = useAccessStore.getState().initialize();
    await tick(); // the GET is on the wire before the user acts

    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      true,
    );
    expectPremium('right after restore commit');

    stalledGet.resolve(freeAccess);
    await retry;
    expectPremium('after the stale initialize() GET landed');
    expect(useAccessStore.getState().status).toBe('ready');
  });

  it('A2 rating-gate initialize() in flight, user restores from Settings → Membership: the stale GET must not revert premium', async () => {
    // Fresh sign-in → status idle → useRatingRouteGate calls initialize().
    // The user switches tabs to Settings (focus refresh skipped: loading),
    // opens Membership (Paywall does not re-initialize: not idle) and taps
    // Restore purchases.
    const clients = dependencies();
    configureAccessStore(clients);
    const stalledGet = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalledGet.promise);
    const gateInitialize = useAccessStore.getState().initialize();
    expect(useAccessStore.getState().status).toBe('loading');
    await tick(); // the GET is on the wire before the user acts

    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      true,
    );
    expectPremium('right after restore commit');

    stalledGet.resolve(freeAccess);
    await gateInitialize;
    expectPremium('after the stale gate initialize() GET landed');
  });

  it('A3 initialize() GET that started before restore and then FAILS must not null the verified premium snapshot', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().refreshAccess();

    const stalledGet = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalledGet.promise);
    const retry = useAccessStore.getState().initialize();
    await tick(); // the GET is on the wire before the user acts

    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      true,
    );
    expectPremium('right after restore commit');

    stalledGet.reject(new Error('offline'));
    await retry;
    expectPremium('after the stale initialize() GET failed');
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().error).toBeNull();
  });

  it('A4 initialize() GET that started before syncBilling() resolved must not overwrite the synced premium snapshot', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    const stalledGet = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalledGet.promise);
    const initialize = useAccessStore.getState().initialize();
    await tick(); // the GET is on the wire before the user acts

    await expect(useAccessStore.getState().syncBilling()).resolves.toBe(true);
    expectPremium('right after sync commit');

    stalledGet.resolve(freeAccess);
    await initialize;
    expectPremium('after the stale initialize() GET landed');
  });

  it('A5 an initialize() GET that started before a newer refreshAccess() must not overwrite the newer ledger read', async () => {
    // Read-vs-read ordering: the older read (initialize) lands after a newer
    // refresh already applied a later server state.
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().refreshAccess();

    const olderGet = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => olderGet.promise);
    const retry = useAccessStore.getState().initialize();
    // initialize() awaits store.configure() before issuing its GET; let that
    // GET go out first so the refresh below is unambiguously the newer read.
    await tick();
    expect(mockGet(clients)).toHaveBeenCalledTimes(2);

    mockGet(clients).mockImplementationOnce(async () => freeAccess);
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);

    olderGet.resolve(oneLeftAccess);
    await retry;
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
    expect(selectCanStartRating(useAccessStore.getState())).toBe(false);
  });

  it('A6 an initialize() that lands while a restore is in flight must not reset operation to idle (re-arms Restore mid-restore)', async () => {
    const clients = dependencies();
    const sync = deferred<Awaited<ReturnType<typeof paidSync>>>();
    (clients.backend.syncBilling as jest.Mock).mockImplementationOnce(
      () => sync.promise,
    );
    configureAccessStore(clients);
    const stalledGet = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalledGet.promise);
    const gateInitialize = useAccessStore.getState().initialize();
    await tick();

    const restore = useAccessStore.getState().restorePurchases();
    await tick();
    expect(useAccessStore.getState().operation).toBe('restoring');

    stalledGet.resolve(freeAccess);
    await gateInitialize;
    // The restore has not committed yet: Restore/Continue must stay busy.
    expect(useAccessStore.getState().operation).toBe('restoring');
    expect(clients.store.restore).toHaveBeenCalledTimes(1);
    // A second tap must be a no-op while the first restore is still syncing.
    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      false,
    );
    expect(clients.store.restore).toHaveBeenCalledTimes(1);

    sync.resolve(await paidSync());
    await expect(restore).resolves.toBe(true);
    expectPremium('after the restore commit');
  });
});

describe('C. boundary / cancellation / reset variants on the ordering guard', () => {
  it('C1 forty overlapping refreshes landing in reverse order: only the newest applies, status settles ready', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    const gets = Array.from({ length: 40 }, () =>
      deferred<CanonicalAccessState>(),
    );
    for (const d of gets)
      mockGet(clients).mockImplementationOnce(() => d.promise);
    const refreshes = gets.map(() => useAccessStore.getState().refreshAccess());

    const newest = gets.at(-1);
    if (!newest) throw new Error('no deferred reads');
    newest.resolve(paidAccess);
    await expect(refreshes.at(-1)).resolves.toBe(true);
    for (let index = gets.length - 2; index >= 0; index -= 1) {
      const older = gets[index];
      if (!older) throw new Error(`no deferred read ${index}`);
      if (index % 2 === 0) older.resolve(freeAccess);
      else older.reject(new Error(`stale ${index}`));
      await expect(refreshes[index]).resolves.toBe(true);
    }
    expectPremium('after 39 stale reads landed');
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().error).toBeNull();
  });

  it('C2 a purchase whose backend verification THROWS is the newest verdict: an older successful read may not repopulate access', async () => {
    const clients = dependencies();
    (clients.backend.syncBilling as jest.Mock).mockRejectedValueOnce(
      new Error('502'),
    );
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    const stalled = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalled.promise);
    const staleRefresh = useAccessStore.getState().refreshAccess();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.backend_verification_pending',
    );

    stalled.resolve(oneLeftAccess);
    await expect(staleRefresh).resolves.toBe(false);
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toBeNull();
    expect(state.status).toBe('error');
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    expect(selectCanStartRating(state)).toBe(false);
  });

  it('C3 reset() mid-refresh cancels the read; the next refresh on the same dependencies applies normally', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    const stalled = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalled.promise);
    const stale = useAccessStore.getState().refreshAccess();

    useAccessStore.getState().reset();
    expect(useAccessStore.getState().status).toBe('idle');
    stalled.resolve(paidAccess);
    await expect(stale).resolves.toBe(false);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(useAccessStore.getState().status).toBe('idle');

    mockGet(clients).mockImplementationOnce(async () => oneLeftAccess);
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(oneLeftAccess);
    expect(useAccessStore.getState().status).toBe('ready');
  });

  it('C4 a refresh that starts AFTER the purchase commit is a newer read and applies (a later downgrade is honoured)', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    expectPremium('after purchase');
    mockGet(clients).mockImplementationOnce(async () => freeAccess);
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
    expect(selectHasPremium(useAccessStore.getState())).toBe(false);
  });

  it('C5 refresh in flight → purchase commit → SECOND refresh fails → stale first read lands: fail-closed null wins', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    const first = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => first.promise);
    const firstRefresh = useAccessStore.getState().refreshAccess();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    mockGet(clients).mockRejectedValueOnce(new Error('offline'));
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(
      false,
    );
    expect(useAccessStore.getState().canonicalAccess).toBeNull();

    first.resolve(paidAccess);
    await expect(firstRefresh).resolves.toBe(false);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(useAccessStore.getState().status).toBe('error');
  });
});

describe('B. refreshAccess() ordering guard — variants beyond the candidate suite', () => {
  it('B1 three overlapping refreshes landing newest-first then oldest: the newest result sticks and status settles', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    const a = deferred<CanonicalAccessState>();
    const b = deferred<CanonicalAccessState>();
    const c = deferred<CanonicalAccessState>();
    mockGet(clients)
      .mockImplementationOnce(() => a.promise)
      .mockImplementationOnce(() => b.promise)
      .mockImplementationOnce(() => c.promise);
    const ra = useAccessStore.getState().refreshAccess();
    const rb = useAccessStore.getState().refreshAccess();
    const rc = useAccessStore.getState().refreshAccess();

    c.resolve(paidAccess);
    await expect(rc).resolves.toBe(true);
    expectPremium('after newest refresh applied');

    a.resolve(freeAccess);
    await ra;
    b.reject(new Error('offline'));
    await rb;
    expectPremium('after older refreshes landed');
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().error).toBeNull();
  });

  it('B2 a refresh that started DURING the purchase (after the store sheet, before the backend commit) is discarded when it lands after the commit', async () => {
    const clients = dependencies();
    const sync = deferred<Awaited<ReturnType<typeof paidSync>>>();
    (clients.backend.syncBilling as jest.Mock).mockImplementationOnce(
      () => sync.promise,
    );
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    const purchase = useAccessStore.getState().purchaseSelected();
    await Promise.resolve();
    expect(useAccessStore.getState().operation).toBe('purchasing');

    const stalled = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalled.promise);
    const midPurchaseRefresh = useAccessStore.getState().refreshAccess();

    sync.resolve(await paidSync());
    await expect(purchase).resolves.toBe(true);
    expectPremium('after purchase commit');

    stalled.resolve(freeAccess);
    await midPurchaseRefresh;
    expectPremium('after the mid-purchase refresh landed');
    expect(useAccessStore.getState().status).toBe('ready');
  });

  it('B3 a refresh that started before a purchase whose backend verification is PENDING keeps the pending error visible', async () => {
    const pendingAccess: CanonicalAccessState = {
      ...freeAccess,
      canStartRating: false,
      paywallRequired: true,
    };
    const clients = dependencies({
      syncBilling: async () => ({
        billing: {
          premium: false,
          productKey: null,
          expiresAt: null,
          verifiedAt: '2026-09-04T00:00:00.000Z',
        },
        access: pendingAccess,
      }),
    });
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    const stalled = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalled.promise);
    const staleRefresh = useAccessStore.getState().refreshAccess();

    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.backend_verification_pending',
    );

    stalled.resolve(oneLeftAccess);
    await staleRefresh;
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toEqual(pendingAccess);
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    expect(state.status).toBe('error');
  });

  it('B4 a stale refresh that lands after sign-out and a NEW sign-in never touches the next account, and the new account refreshes normally', async () => {
    const first = dependencies();
    configureAccessStore(first);
    await useAccessStore.getState().initialize();
    const stalled = deferred<CanonicalAccessState>();
    mockGet(first).mockImplementationOnce(() => stalled.promise);
    const staleRefresh = useAccessStore.getState().refreshAccess();

    clearAccessStoreConfiguration();
    const second = dependencies({ getAccess: async () => oneLeftAccess });
    configureAccessStore(second);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().canonicalAccess).toEqual(oneLeftAccess);

    stalled.resolve(paidAccess);
    await expect(staleRefresh).resolves.toBe(false);
    expect(useAccessStore.getState().canonicalAccess).toEqual(oneLeftAccess);
    expect(selectHasPremium(useAccessStore.getState())).toBe(false);

    mockGet(second).mockImplementationOnce(async () => freeAccess);
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
  });

  it('B5 a NEWER refresh failure after a purchase still fails closed even if an OLDER successful read lands afterwards', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );

    const older = deferred<CanonicalAccessState>();
    mockGet(clients)
      .mockImplementationOnce(() => older.promise)
      .mockRejectedValueOnce(new Error('offline'));
    const olderRefresh = useAccessStore.getState().refreshAccess();
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(
      false,
    );
    expect(useAccessStore.getState().canonicalAccess).toBeNull();

    older.resolve(paidAccess);
    await expect(olderRefresh).resolves.toBe(false);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(useAccessStore.getState().status).toBe('error');
    expect(selectPaywallRequired(useAccessStore.getState())).toBe(true);
  });

  it('B6 a refresh that started before a purchase whose STORE step failed still applies (nothing newer was verified)', async () => {
    const clients = dependencies();
    (clients.store.purchase as jest.Mock).mockRejectedValueOnce(
      new Error('store down'),
    );
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    const stalled = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalled.promise);
    const refresh = useAccessStore.getState().refreshAccess();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.purchase_failed',
    );

    stalled.resolve(oneLeftAccess);
    await expect(refresh).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(oneLeftAccess);
    expect(useAccessStore.getState().status).toBe('ready');
  });

  it('B7 status never sticks at loading once every in-flight read has settled', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    const a = deferred<CanonicalAccessState>();
    const b = deferred<CanonicalAccessState>();
    mockGet(clients)
      .mockImplementationOnce(() => a.promise)
      .mockImplementationOnce(() => b.promise);
    const ra = useAccessStore.getState().refreshAccess();
    const rb = useAccessStore.getState().refreshAccess();
    a.resolve(oneLeftAccess);
    await ra;
    // b is still in flight → loading is legitimate here.
    expect(useAccessStore.getState().status).toBe('loading');
    b.reject(new Error('offline'));
    await rb;
    expect(useAccessStore.getState().status).toBe('error');
    expect(useAccessStore.getState().canonicalAccess).toBeNull();

    // A purchase commit while a refresh is in flight must leave status
    // ready after the stale refresh is discarded.
    mockGet(clients).mockImplementationOnce(async () => oneLeftAccess);
    await useAccessStore.getState().refreshAccess();
    const c = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => c.promise);
    const rc = useAccessStore.getState().refreshAccess();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    c.resolve(freeAccess);
    await rc;
    expect(useAccessStore.getState().status).toBe('ready');
    expectPremium('after purchase then stale refresh');
  });

  it('B8 restore that finds no membership is a newer server verdict: an older refresh may not resurrect canStartRating', async () => {
    const noMembershipAccess: CanonicalAccessState = { ...freeAccess };
    const clients = dependencies({
      syncBilling: async () => ({
        billing: {
          premium: false,
          productKey: null,
          expiresAt: null,
          verifiedAt: '2026-09-04T00:00:00.000Z',
        },
        access: noMembershipAccess,
      }),
    });
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    const stalled = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalled.promise);
    const staleRefresh = useAccessStore.getState().refreshAccess();
    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      false,
    );
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.restore_failed',
    );

    stalled.resolve(oneLeftAccess);
    await staleRefresh;
    expect(useAccessStore.getState().canonicalAccess).toEqual(
      noMembershipAccess,
    );
    expect(selectCanStartRating(useAccessStore.getState())).toBe(false);
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.restore_failed',
    );
  });
});
