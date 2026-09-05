/**
 * Round-2 adversarial ordering tests for the MBP-1 fix in
 * `src/state/accessStore.ts` (candidate b8e791b4 on top of f702f0f8).
 *
 * Every assertion is phrased as the EXPECTED behaviour, so a failing test
 * here is a real ordering hole (or a regression the guard introduced), not a
 * baseline pin. Sections:
 *
 *  C. write/write/read interleavings the round-1 suites do not cover
 *     (reads racing a purchase whose sync is still in flight, sync/purchase
 *     verification FAILURES as the newest operation, restore that verifies
 *     free).
 *  D. two real accounts (sign-out + sign-in) with reads from the previous
 *     account settling — success AND failure — after the new account's read
 *     committed.
 *  E. boundary sizes (200 overlapping reads, deterministic shuffled settle
 *     order, a commit in the middle), unicode / boundary payloads, malformed
 *     rejection reasons (undefined / null / string), and status coherence
 *     (a dropped read must never leave `status: 'loading'` behind).
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

const syncedPaid = {
  billing: {
    premium: true,
    productKey: 'pickle_sensei_pro_yearly',
    expiresAt: '2027-09-04T00:00:00.000Z',
    verifiedAt: '2026-09-04T00:00:00.000Z',
  },
  access: paidAccess,
};

const syncedFree = {
  billing: {
    premium: false,
    productKey: null,
    expiresAt: null,
    verifiedAt: '2026-09-04T00:00:00.000Z',
  },
  access: freeAccess,
};

type SyncResult = Awaited<
  ReturnType<BillingAccessDependencies['backend']['syncBilling']>
>;

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
      syncBilling: jest.fn(options?.syncBilling ?? (async () => syncedPaid)),
    },
  };
}

const mockGet = (clients: BillingAccessDependencies) =>
  clients.backend.getAccess as jest.Mock;
const mockSync = (clients: BillingAccessDependencies) =>
  clients.backend.syncBilling as jest.Mock;

function snapshot(label: string) {
  const state = useAccessStore.getState();
  return {
    label,
    status: state.status,
    operation: state.operation,
    canonicalAccess: state.canonicalAccess,
    premium: selectHasPremium(state),
    canStartRating: selectCanStartRating(state),
    paywallRequired: selectPaywallRequired(state),
    errorCode: state.error?.code ?? null,
  };
}

function expectPremium(label: string) {
  expect(snapshot(label)).toEqual({
    label,
    status: 'ready',
    operation: 'idle',
    canonicalAccess: paidAccess,
    premium: true,
    canStartRating: true,
    paywallRequired: false,
    errorCode: null,
  });
}

/** Ready store with plans + a verified free snapshot (purchase is enabled). */
async function readyForPurchase(clients: BillingAccessDependencies) {
  configureAccessStore(clients);
  await useAccessStore.getState().initialize();
  expect(snapshot('precondition')).toMatchObject({
    status: 'ready',
    canonicalAccess: freeAccess,
  });
  expect(useAccessStore.getState().plans).toEqual(plans);
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('C. reads racing a write whose backend sync is still in flight', () => {
  it('C1 refresh that lands DURING the purchase sync still applies (it is the newest read), and a refresh issued after that but before the sync commit is dropped', async () => {
    const clients = dependencies();
    await readyForPurchase(clients);

    const stalledSync = deferred<SyncResult>();
    mockSync(clients).mockImplementationOnce(() => stalledSync.promise);
    const firstGet = deferred<CanonicalAccessState>();
    const secondGet = deferred<CanonicalAccessState>();
    mockGet(clients)
      .mockImplementationOnce(() => firstGet.promise)
      .mockImplementationOnce(() => secondGet.promise);

    // Settings focus refresh #1 goes on the wire, then the user taps
    // Continue on the paywall; store.purchase resolves, sync is in flight.
    const refresh1 = useAccessStore.getState().refreshAccess();
    const purchase = useAccessStore.getState().purchaseSelected();
    await tick();
    expect(useAccessStore.getState().operation).toBe('purchasing');
    expect(mockSync(clients)).toHaveBeenCalledTimes(1);

    // Refresh #1 lands while the sync is pending: nothing newer has
    // committed, so it is the freshest server truth and applies.
    firstGet.resolve(freeAccess);
    await expect(refresh1).resolves.toBe(true);
    expect(snapshot('refresh #1 applied')).toMatchObject({
      status: 'ready',
      operation: 'purchasing',
      canonicalAccess: freeAccess,
    });

    // Settings focus refresh #2 goes on the wire (status is ready again),
    // then the purchase sync commits paid.
    const refresh2 = useAccessStore.getState().refreshAccess();
    await tick();
    stalledSync.resolve(syncedPaid);
    await expect(purchase).resolves.toBe(true);
    expectPremium('right after the purchase sync commit');

    // Refresh #2 began before the commit: dropped.
    secondGet.resolve(freeAccess);
    await expect(refresh2).resolves.toBe(true);
    expectPremium('after the stale refresh #2 landed');
  });

  it('C2 stale refresh SUCCESS with paid must not resurrect access after a newer syncBilling() FAILURE (fail-closed null is the newest operation)', async () => {
    const clients = dependencies();
    await readyForPurchase(clients);

    const stalledGet = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalledGet.promise);
    mockSync(clients).mockRejectedValueOnce(new Error('503 upstream'));

    const staleRefresh = useAccessStore.getState().refreshAccess();
    await tick();
    await expect(useAccessStore.getState().syncBilling()).resolves.toBe(false);
    expect(snapshot('after sync failure')).toMatchObject({
      status: 'error',
      operation: 'idle',
      canonicalAccess: null,
      errorCode: 'billing.backend_verification_pending',
    });

    stalledGet.resolve(paidAccess);
    await expect(staleRefresh).resolves.toBe(false);
    expect(snapshot('after the stale paid read landed')).toMatchObject({
      status: 'error',
      canonicalAccess: null,
      premium: false,
      paywallRequired: true,
      errorCode: 'billing.backend_verification_pending',
    });
  });

  it('C3 stale refresh must not clear the "verification pending" error a purchase whose sync verified NON-premium just set', async () => {
    const clients = dependencies();
    await readyForPurchase(clients);

    const stalledGet = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalledGet.promise);
    mockSync(clients).mockResolvedValueOnce(syncedFree);

    const staleRefresh = useAccessStore.getState().refreshAccess();
    await tick();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    const afterPurchase = snapshot('after non-premium verification');
    expect(afterPurchase).toMatchObject({
      status: 'error',
      operation: 'idle',
      canonicalAccess: freeAccess,
      errorCode: 'billing.backend_verification_pending',
    });

    stalledGet.resolve(freeAccess);
    await expect(staleRefresh).resolves.toBe(true);
    expect(snapshot('after non-premium verification')).toEqual(afterPurchase);
  });

  it('C4 stale refresh SUCCESS (paid) must not resurrect access after a purchase whose backend sync FAILED (newest op is fail-closed)', async () => {
    const clients = dependencies();
    await readyForPurchase(clients);

    const stalledGet = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalledGet.promise);
    mockSync(clients).mockRejectedValueOnce(new Error('network down'));

    const staleRefresh = useAccessStore.getState().refreshAccess();
    await tick();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expect(snapshot('after failed purchase sync')).toMatchObject({
      status: 'error',
      canonicalAccess: null,
      errorCode: 'billing.backend_verification_pending',
    });

    stalledGet.resolve(paidAccess);
    await expect(staleRefresh).resolves.toBe(false);
    expect(snapshot('after stale paid read')).toMatchObject({
      status: 'error',
      canonicalAccess: null,
      premium: false,
      canStartRating: false,
      paywallRequired: true,
      errorCode: 'billing.backend_verification_pending',
    });
  });

  it('C5 stale refresh FAILURE must not null a restore that verified premium while the restore was still in flight when the read went out', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    const stalledRestore = deferred<typeof entitlement>();
    (clients.store.restore as jest.Mock).mockImplementationOnce(
      () => stalledRestore.promise,
    );
    const stalledGet = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalledGet.promise);

    const restore = useAccessStore.getState().restorePurchases();
    await tick();
    expect(useAccessStore.getState().operation).toBe('restoring');
    // Settings focus refresh while the App Store sheet is up.
    const staleRefresh = useAccessStore.getState().refreshAccess();
    await tick();

    stalledRestore.resolve(entitlement);
    await expect(restore).resolves.toBe(true);
    expectPremium('right after restore commit');

    stalledGet.reject(new Error('request aborted'));
    await expect(staleRefresh).resolves.toBe(true);
    expectPremium('after the stale failed read landed');
  });

  it('C6 restore that verified FREE (no membership) is the newest write: a stale read that had seen paid must not re-grant premium', async () => {
    const clients = dependencies({ getAccess: async () => paidAccess });
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);

    const stalledGet = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalledGet.promise);
    mockSync(clients).mockResolvedValueOnce(syncedFree);

    const staleRefresh = useAccessStore.getState().refreshAccess();
    await tick();
    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      false,
    );
    const afterRestore = snapshot('after restore verified free');
    expect(afterRestore).toMatchObject({
      status: 'ready',
      canonicalAccess: freeAccess,
      premium: false,
      errorCode: 'billing.restore_failed',
    });

    stalledGet.resolve(paidAccess);
    await expect(staleRefresh).resolves.toBe(true);
    expect(snapshot('after restore verified free')).toEqual(afterRestore);
  });

  it('C7 initialize() in flight, then purchase (plans from an earlier session) commits paid, then a NEWER refresh downgrades: the newer read wins, the stale initialize does not', async () => {
    const clients = dependencies();
    await readyForPurchase(clients);
    // Simulate a refresh failure that nulls access → Paywall shows "Try again".
    mockGet(clients).mockRejectedValueOnce(new Error('503'));
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(
      false,
    );
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(useAccessStore.getState().plans).toEqual(plans);

    const stalledInit = deferred<CanonicalAccessState>();
    const laterGet = deferred<CanonicalAccessState>();
    mockGet(clients)
      .mockImplementationOnce(() => stalledInit.promise)
      .mockImplementationOnce(() => laterGet.promise);
    const retry = useAccessStore.getState().initialize();
    await tick();

    // A restore is the only write reachable here (purchase needs access).
    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      true,
    );
    expectPremium('after restore');

    // The loading guard blocks initialize() but not refreshAccess(); a
    // Settings focus refresh is skipped while loading, but AnalyzeScreen's
    // unmount refresh is not.
    const later = useAccessStore.getState().refreshAccess();
    await tick();
    stalledInit.resolve(freeAccess);
    await retry;
    // The newer read is still on the wire, so status is legitimately
    // 'loading'; the snapshot itself must be untouched.
    expect(snapshot('after stale initialize landed')).toMatchObject({
      status: 'loading',
      canonicalAccess: paidAccess,
      premium: true,
      canStartRating: true,
      paywallRequired: false,
    });

    laterGet.resolve(freeAccess);
    await expect(later).resolves.toBe(true);
    expect(snapshot('after the newer read downgraded')).toMatchObject({
      status: 'ready',
      canonicalAccess: freeAccess,
      premium: false,
    });
  });
});

describe('D. two accounts: the previous account’s reads settle after the next account committed', () => {
  it('D1 previous account’s stale SUCCESS (paid) must not grant premium to the next account whose initialize() verified free', async () => {
    const previous = dependencies();
    configureAccessStore(previous);
    await useAccessStore.getState().initialize();
    const stalledGet = deferred<CanonicalAccessState>();
    mockGet(previous).mockImplementationOnce(() => stalledGet.promise);
    const staleRefresh = useAccessStore.getState().refreshAccess();
    await tick();

    clearAccessStoreConfiguration();
    const next = dependencies();
    configureAccessStore(next);
    await useAccessStore.getState().initialize();
    const nextState = snapshot('next account ready');
    expect(nextState).toMatchObject({
      status: 'ready',
      canonicalAccess: freeAccess,
    });

    stalledGet.resolve(paidAccess);
    await expect(staleRefresh).resolves.toBe(false);
    expect(snapshot('next account ready')).toEqual(nextState);
  });

  it('D2 previous account’s stale FAILURE must not null the next account’s verified premium (restore on the new account)', async () => {
    const previous = dependencies();
    configureAccessStore(previous);
    const stalledGet = deferred<CanonicalAccessState>();
    mockGet(previous).mockImplementationOnce(() => stalledGet.promise);
    const staleRefresh = useAccessStore.getState().refreshAccess();
    await tick();

    clearAccessStoreConfiguration();
    const next = dependencies();
    configureAccessStore(next);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      true,
    );
    expectPremium('next account restored');

    stalledGet.reject(new Error('401 session expired'));
    await expect(staleRefresh).resolves.toBe(false);
    expectPremium('after the previous account’s failed read landed');
  });

  it('D3 previous account’s stale initialize() must not write its plans/access over the next account', async () => {
    const previous = dependencies({
      loadPlans: async () => ({ ...plans, offeringId: 'previous-account' }),
    });
    configureAccessStore(previous);
    const stalledGet = deferred<CanonicalAccessState>();
    mockGet(previous).mockImplementationOnce(() => stalledGet.promise);
    const staleInit = useAccessStore.getState().initialize();
    await tick();

    clearAccessStoreConfiguration();
    const next = dependencies();
    configureAccessStore(next);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    expectPremium('next account purchased');

    stalledGet.resolve(freeAccess);
    await staleInit;
    expectPremium('after the previous account’s initialize landed');
    expect(useAccessStore.getState().plans?.offeringId).toBe('default');
  });

  it('D4 stale read from before sign-out must not repopulate an UNCONFIGURED store (signed-out state stays fail-closed)', async () => {
    const clients = dependencies();
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    const stalledGet = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalledGet.promise);
    const staleRefresh = useAccessStore.getState().refreshAccess();
    await tick();

    clearAccessStoreConfiguration();
    stalledGet.resolve(paidAccess);
    await expect(staleRefresh).resolves.toBe(false);
    expect(snapshot('signed out')).toMatchObject({
      status: 'idle',
      canonicalAccess: null,
      premium: false,
      paywallRequired: true,
    });
  });
});

describe('E. boundary sizes, payload shapes and status coherence', () => {
  it('E1 200 overlapping reads with a purchase commit in the middle, settled in a deterministic shuffled order: only the last-issued read applies', async () => {
    const clients = dependencies();
    await readyForPurchase(clients);

    const total = 200;
    const commitAt = 97;
    const gets = Array.from({ length: total }, () =>
      deferred<CanonicalAccessState>(),
    );
    let issued = 0;
    mockGet(clients)
      .mockClear()
      .mockImplementation(() => gets[issued++]!.promise);

    const reads: Promise<boolean>[] = [];
    for (let i = 0; i < total; i += 1) {
      if (i === commitAt) {
        await expect(
          useAccessStore.getState().purchaseSelected(),
        ).resolves.toBe(true);
        expectPremium('purchase committed mid-stream');
      }
      reads.push(useAccessStore.getState().refreshAccess());
    }
    expect(mockGet(clients)).toHaveBeenCalledTimes(total);

    // Deterministic LCG shuffle so the run is reproducible.
    const order = Array.from({ length: total }, (_, i) => i);
    let seed = 0x2545f491;
    for (let i = order.length - 1; i > 0; i -= 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    // The newest read (index total-1) returns paid; every other read
    // returns free (pre-commit reads) or a downgrade nobody asked for.
    for (const index of order) {
      gets[index]!.resolve(index === total - 1 ? paidAccess : freeAccess);
      await tick();
    }
    const results = await Promise.all(reads);
    expect(results.every(Boolean)).toBe(true);
    expectPremium('after all 200 reads settled');
  });

  it('E2 200 overlapping reads, the newest one FAILS: fail-closed null wins and no older success resurrects access', async () => {
    const clients = dependencies();
    await readyForPurchase(clients);
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );

    const total = 200;
    const gets = Array.from({ length: total }, () =>
      deferred<CanonicalAccessState>(),
    );
    let issued = 0;
    mockGet(clients).mockImplementation(() => gets[issued++]!.promise);
    const reads = Array.from({ length: total }, () =>
      useAccessStore.getState().refreshAccess(),
    );
    gets[total - 1]!.reject(new Error('gateway timeout'));
    await tick();
    for (let i = 0; i < total - 1; i += 1) {
      gets[i]!.resolve(paidAccess);
    }
    const results = await Promise.all(reads);
    expect(results.every(result => result === false)).toBe(true);
    expect(snapshot('after all reads settled')).toMatchObject({
      status: 'error',
      canonicalAccess: null,
      premium: false,
      paywallRequired: true,
      errorCode: 'billing.backend_unavailable',
    });
  });

  it('E3 unicode / boundary payloads: ordering is by request identity, not payload equality — an identical stale payload is still dropped, a distinct newer one applies', async () => {
    const unicodePaid: CanonicalAccessState = {
      ...paidAccess,
      entitlements: [
        'pickle_sensei_pro',
        'ピクル先生🥒',
        '\u0000',
        'x'.repeat(4096),
      ],
      freeRatings: {
        limit: 2,
        used: 0,
        reserved: 0,
        remaining: Number.MAX_SAFE_INTEGER,
        availableToReserve: Number.MAX_SAFE_INTEGER,
      },
    };
    const clients = dependencies({
      syncBilling: async () => ({ ...syncedPaid, access: unicodePaid }),
    });
    await readyForPurchase(clients);

    const stalledGet = deferred<CanonicalAccessState>();
    mockGet(clients).mockImplementationOnce(() => stalledGet.promise);
    const staleRefresh = useAccessStore.getState().refreshAccess();
    await tick();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    expect(useAccessStore.getState().canonicalAccess).toBe(unicodePaid);

    // Stale read returns a structurally identical-but-distinct object with
    // one flag flipped deep inside; it must be ignored wholesale.
    stalledGet.resolve({ ...unicodePaid, canStartRating: false });
    await expect(staleRefresh).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toBe(unicodePaid);
    expect(selectCanStartRating(useAccessStore.getState())).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['string', 'ネットワーク切断'],
    ['number', 0],
    ['object without message', { code: 'ECONNRESET' }],
  ])(
    'E4 newest read rejecting with a malformed reason (%s) still fails closed with a retryable backend_unavailable error',
    async (_label, reason) => {
      const clients = dependencies();
      await readyForPurchase(clients);
      await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
        true,
      );
      mockGet(clients).mockImplementationOnce(() => Promise.reject(reason));
      await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(
        false,
      );
      expect(snapshot('after malformed failure')).toMatchObject({
        status: 'error',
        canonicalAccess: null,
        errorCode: 'billing.backend_unavailable',
      });
      expect(useAccessStore.getState().error?.retryable).toBe(true);
    },
  );

  it('E5 a dropped read never leaves status "loading": every interleaving ends with the status the newest operation settled', async () => {
    const clients = dependencies();
    await readyForPurchase(clients);

    // stale refresh → newer refresh → purchase → all settle out of order
    const g1 = deferred<CanonicalAccessState>();
    const g2 = deferred<CanonicalAccessState>();
    mockGet(clients)
      .mockImplementationOnce(() => g1.promise)
      .mockImplementationOnce(() => g2.promise);
    const r1 = useAccessStore.getState().refreshAccess();
    const r2 = useAccessStore.getState().refreshAccess();
    expect(useAccessStore.getState().status).toBe('loading');
    await tick();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    expect(useAccessStore.getState().status).toBe('ready');
    g2.reject(new Error('late failure'));
    g1.resolve(freeAccess);
    await expect(Promise.all([r1, r2])).resolves.toEqual([true, true]);
    expectPremium('after both stale reads settled');

    // stale initialize (plans fail) → newer refresh in flight → both settle
    clearAccessStoreConfiguration();
    const flaky = dependencies({
      loadPlans: async () => {
        throw new Error('offerings unavailable');
      },
    });
    configureAccessStore(flaky);
    const initGet = deferred<CanonicalAccessState>();
    const laterGet = deferred<CanonicalAccessState>();
    mockGet(flaky)
      .mockImplementationOnce(() => initGet.promise)
      .mockImplementationOnce(() => laterGet.promise);
    const init = useAccessStore.getState().initialize();
    await tick();
    const later = useAccessStore.getState().refreshAccess();
    await tick();
    initGet.resolve(paidAccess);
    await init;
    laterGet.resolve(freeAccess);
    await expect(later).resolves.toBe(true);
    expect(useAccessStore.getState().status).not.toBe('loading');
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
  });

  it('E6 reset() mid-read then a fresh initialize(): the pre-reset read (success or failure) never lands on the re-initialized store', async () => {
    const clients = dependencies();
    await readyForPurchase(clients);
    const staleOk = deferred<CanonicalAccessState>();
    const staleFail = deferred<CanonicalAccessState>();
    mockGet(clients)
      .mockImplementationOnce(() => staleOk.promise)
      .mockImplementationOnce(() => staleFail.promise);
    const readOk = useAccessStore.getState().refreshAccess();
    const readFail = useAccessStore.getState().refreshAccess();
    await tick();

    useAccessStore.getState().reset();
    expect(useAccessStore.getState().status).toBe('idle');
    // Same account, same clients: PaywallScreen re-initializes on idle.
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    expectPremium('re-initialized and purchased');

    staleOk.resolve(freeAccess);
    staleFail.reject(new Error('stale failure'));
    await Promise.all([readOk, readFail]);
    expectPremium('after pre-reset reads settled');
  });
});

describe('F. seeded random interleavings against an ordering oracle', () => {
  /**
   * Oracle: every GET /v1/me/access is stamped when it is ISSUED, every
   * backend sync is stamped when it COMMITS (resolves). The snapshot the
   * store must hold once everything has settled is the payload of the
   * highest stamp — a read issued after the last commit wins over that
   * commit regardless of settle order, a read issued before it loses; a
   * failure as the newest operation is a null (fail-closed) payload.
   */
  type Op = {
    kind: 'read' | 'write';
    seq: number;
    payload: CanonicalAccessState | null;
    settle: (ok: boolean) => void;
    settled: boolean;
  };

  function lcg(seed: number) {
    let state = seed >>> 0;
    return (bound: number) => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state % bound;
    };
  }

  const variants: CanonicalAccessState[] = [
    freeAccess,
    paidAccess,
    { ...paidAccess, entitlements: ['premium'] },
    {
      ...freeAccess,
      freeRatings: { ...freeAccess.freeRatings, used: 1, remaining: 1 },
    },
  ];

  it.each(Array.from({ length: 40 }, (_, i) => [i + 1]))(
    'F1 seed %i: after every interleaving settles, canonicalAccess equals the newest-stamped payload and nothing is left loading/busy',
    async seed => {
      const rand = lcg(seed * 7919);
      const records: Op[] = [];
      let seq = 1;
      const log: string[] = [];

      const clients = dependencies();
      await readyForPurchase(clients);
      let expected: CanonicalAccessState | null = freeAccess;
      let expectedSeq = 0;

      mockGet(clients).mockImplementation(() => {
        const d = deferred<CanonicalAccessState>();
        const record: Op = {
          kind: 'read',
          seq: seq++,
          payload: null,
          settled: false,
          settle: ok => {
            record.settled = true;
            if (ok) {
              record.payload = variants[rand(variants.length)]!;
              d.resolve(record.payload);
            } else {
              record.payload = null;
              d.reject(new Error(`read ${record.seq} failed`));
            }
          },
        };
        records.push(record);
        log.push(`GET#${record.seq}`);
        return d.promise;
      });
      mockSync(clients).mockImplementation(() => {
        const d = deferred<SyncResult>();
        const record: Op = {
          kind: 'write',
          seq: -1,
          payload: null,
          settled: false,
          settle: ok => {
            record.settled = true;
            record.seq = seq++;
            if (ok) {
              record.payload = variants[rand(variants.length)]!;
              d.resolve({ ...syncedPaid, access: record.payload });
            } else {
              record.payload = null;
              d.reject(new Error(`sync ${record.seq} failed`));
            }
            log.push(`SYNC commit#${record.seq} ${ok ? 'ok' : 'fail'}`);
          },
        };
        records.push(record);
        log.push('SYNC issued');
        return d.promise;
      });

      const pending: Promise<unknown>[] = [];
      const steps = 12 + rand(20);
      for (let step = 0; step < steps; step += 1) {
        const roll = rand(10);
        if (roll < 3) {
          log.push('refreshAccess()');
          pending.push(useAccessStore.getState().refreshAccess());
        } else if (roll === 3) {
          log.push('initialize()');
          pending.push(useAccessStore.getState().initialize());
        } else if (roll === 4) {
          log.push('purchaseSelected()');
          pending.push(useAccessStore.getState().purchaseSelected());
        } else if (roll === 5) {
          log.push('restorePurchases()');
          pending.push(useAccessStore.getState().restorePurchases());
        } else if (roll === 6) {
          log.push('syncBilling()');
          pending.push(useAccessStore.getState().syncBilling());
        } else {
          const open = records.filter(r => !r.settled);
          if (open.length > 0) {
            const record = open[rand(open.length)]!;
            const ok = rand(4) !== 0;
            log.push(
              `settle ${record.kind}${record.kind === 'read' ? `#${record.seq}` : ''} ${ok ? 'ok' : 'fail'}`,
            );
            record.settle(ok);
          }
        }
        await tick();
        await tick();
      }
      // Drain: settle everything still open in a shuffled order.
      let open = records.filter(r => !r.settled);
      while (open.length > 0) {
        const record = open[rand(open.length)]!;
        const ok = rand(4) !== 0;
        log.push(
          `drain ${record.kind}${record.kind === 'read' ? `#${record.seq}` : ''} ${ok ? 'ok' : 'fail'}`,
        );
        record.settle(ok);
        await tick();
        await tick();
        open = records.filter(r => !r.settled);
      }
      await Promise.all(pending);
      await tick();

      for (const record of records) {
        if (record.seq > expectedSeq) {
          expectedSeq = record.seq;
          expected = record.payload;
        }
      }
      const state = useAccessStore.getState();
      expect({
        seed,
        trace: log.join(' | '),
        status: state.status,
        operation: state.operation,
        canonicalAccess: state.canonicalAccess,
      }).toEqual({
        seed,
        trace: log.join(' | '),
        status: expect.not.stringMatching(/^loading$/),
        operation: 'idle',
        canonicalAccess: expected,
      });
    },
  );
});
