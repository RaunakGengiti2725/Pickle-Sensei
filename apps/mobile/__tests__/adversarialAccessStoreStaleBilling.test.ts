/**
 * ADVERSARIAL PASS 3 — mobile-analyze-capture / access gate (accessStore).
 *
 * Attack: sign-out (`clearAccessStoreConfiguration`) — and its cousins
 * `reset()` / re-`configureAccessStore` for the NEXT account — while a billing
 * operation is in flight. The stale StoreKit / backend result must never
 * repopulate the store: no premium leak into the signed-out or next-account
 * state, no error surfaced from the previous account, no stale backend call.
 *
 * Every store/backend function is a deferred double the test resolves by hand
 * so the interleaving is exact (no timers, no races decided by the runtime).
 */
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
  selectPaywallRequired,
  useAccessStore,
} from '../src/state/accessStore';

const freeAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 0,
    reserved: 0,
    remaining: 2,
    availableToReserve: 2,
  },
  canStartRating: true,
  paywallRequired: false,
};

const exhaustedAccess: CanonicalAccessState = {
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

type Entitlement = Awaited<
  ReturnType<BillingAccessDependencies['store']['purchase']>
>;
type Synced = Awaited<
  ReturnType<BillingAccessDependencies['backend']['syncBilling']>
>;

const entitlement: Entitlement = {
  premium: true,
  productId: 'pickle_sensei_pro_annual',
  expirationDate: '2027-09-04T00:00:00.000Z',
};

const syncedPaid: Synced = {
  billing: {
    premium: true,
    productKey: 'pickle_sensei_pro_annual',
    expiresAt: '2027-09-04T00:00:00.000Z',
    verifiedAt: '2026-09-04T00:00:00.000Z',
  },
  access: paidAccess,
};

/** Dependencies whose every async call is gated behind a Deferred the test
 * controls. Each call returns a fresh gate (pushed to the matching queue). */
function gatedDependencies(initialAccess: CanonicalAccessState) {
  const purchases: Deferred<Entitlement>[] = [];
  const restores: Deferred<Entitlement>[] = [];
  const syncs: Deferred<Synced>[] = [];
  const accesses: Deferred<CanonicalAccessState>[] = [];
  const clients: BillingAccessDependencies = {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(() => {
        const gate = deferred<Entitlement>();
        purchases.push(gate);
        return gate.promise;
      }),
      restore: jest.fn(() => {
        const gate = deferred<Entitlement>();
        restores.push(gate);
        return gate.promise;
      }),
      readEntitlement: jest.fn(async () => entitlement),
    },
    backend: {
      getAccess: jest.fn(() => {
        const gate = deferred<CanonicalAccessState>();
        accesses.push(gate);
        return gate.promise;
      }),
      syncBilling: jest.fn(() => {
        const gate = deferred<Synced>();
        syncs.push(gate);
        return gate.promise;
      }),
    },
  };
  /** configure + initialize, resolving the initial access read. */
  const boot = async () => {
    configureAccessStore(clients);
    const init = useAccessStore.getState().initialize();
    await flush();
    accesses[accesses.length - 1]!.resolve(initialAccess);
    await init;
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().canonicalAccess).toEqual(initialAccess);
  };
  return { clients, purchases, restores, syncs, accesses, boot };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function expectSignedOutDefaults(): void {
  const state = useAccessStore.getState();
  expect(state.status).toBe('idle');
  expect(state.operation).toBe('idle');
  expect(state.plans).toBeNull();
  expect(state.canonicalAccess).toBeNull();
  expect(state.error).toBeNull();
  expect(selectHasPremium(state)).toBe(false);
  expect(selectCanStartRating(state)).toBe(false);
  expect(selectPaywallRequired(state)).toBe(true);
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('clearAccessStoreConfiguration while purchase() is in flight', () => {
  it('stale StoreKit success → no backend sync, no premium, store stays signed-out', async () => {
    const a = gatedDependencies(exhaustedAccess);
    await a.boot();
    const purchase = useAccessStore.getState().purchaseSelected();
    await flush();
    expect(useAccessStore.getState().operation).toBe('purchasing');
    expect(a.purchases).toHaveLength(1);

    clearAccessStoreConfiguration(); // sign-out mid purchase sheet
    expectSignedOutDefaults();

    a.purchases[0]!.resolve(entitlement); // StoreKit completes late
    await expect(purchase).resolves.toBe(false);
    expectSignedOutDefaults();
    // The stale operation must NOT hit the previous account's backend.
    expect(a.clients.backend.syncBilling).not.toHaveBeenCalled();
    expect(a.syncs).toHaveLength(0);
  });

  it('stale StoreKit rejection → no error surfaced into the signed-out store', async () => {
    const a = gatedDependencies(exhaustedAccess);
    await a.boot();
    const purchase = useAccessStore.getState().purchaseSelected();
    await flush();
    clearAccessStoreConfiguration();
    a.purchases[0]!.reject(new Error('StoreKit: 権限がありません \u{1F4B8}'));
    await expect(purchase).resolves.toBe(false);
    expectSignedOutDefaults();
  });

  it('clear DURING the post-purchase syncBilling → stale premium access is discarded', async () => {
    const a = gatedDependencies(exhaustedAccess);
    await a.boot();
    const purchase = useAccessStore.getState().purchaseSelected();
    await flush();
    a.purchases[0]!.resolve(entitlement);
    await flush();
    expect(a.syncs).toHaveLength(1); // backend verification in flight
    expect(useAccessStore.getState().operation).toBe('purchasing');

    clearAccessStoreConfiguration();
    expectSignedOutDefaults();

    a.syncs[0]!.resolve(syncedPaid);
    await expect(purchase).resolves.toBe(false);
    expectSignedOutDefaults();
  });

  it('stale purchase result cannot leak into the NEXT account configured after sign-out', async () => {
    const a = gatedDependencies(exhaustedAccess);
    await a.boot();
    const purchaseA = useAccessStore.getState().purchaseSelected();
    await flush();
    a.purchases[0]!.resolve(entitlement);
    await flush();
    expect(a.syncs).toHaveLength(1);

    clearAccessStoreConfiguration();
    const b = gatedDependencies(freeAccess);
    await b.boot(); // account B signs in, free tier

    // A's backend verification lands AFTER B is live.
    a.syncs[0]!.resolve(syncedPaid);
    await expect(purchaseA).resolves.toBe(false);
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toEqual(freeAccess);
    expect(selectHasPremium(state)).toBe(false);
    expect(state.status).toBe('ready');
    expect(state.operation).toBe('idle');
    expect(state.error).toBeNull();
    // B can still purchase (A's stale operation released no lock on B's store).
    const purchaseB = useAccessStore.getState().purchaseSelected();
    await flush();
    expect(b.purchases).toHaveLength(1);
    b.purchases[0]!.resolve(entitlement);
    await flush();
    b.syncs[0]!.resolve(syncedPaid);
    await expect(purchaseB).resolves.toBe(true);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
  });

  it('same dependency object re-configured (version bump only) still invalidates the in-flight result', async () => {
    const a = gatedDependencies(exhaustedAccess);
    await a.boot();
    const purchase = useAccessStore.getState().purchaseSelected();
    await flush();
    a.purchases[0]!.resolve(entitlement);
    await flush();
    expect(a.syncs).toHaveLength(1);

    // Identity-equal clients, new configuration version.
    configureAccessStore(a.clients);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    a.syncs[0]!.resolve(syncedPaid);
    await expect(purchase).resolves.toBe(false);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(useAccessStore.getState().operation).toBe('idle');
  });

  it('reset() mid-flight (same account, in-memory wipe) also discards the stale result', async () => {
    const a = gatedDependencies(exhaustedAccess);
    await a.boot();
    const purchase = useAccessStore.getState().purchaseSelected();
    await flush();
    useAccessStore.getState().reset();
    a.purchases[0]!.resolve(entitlement);
    await expect(purchase).resolves.toBe(false);
    expect(a.clients.backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
  });
});

describe('clearAccessStoreConfiguration while syncBilling() / restore / refresh are in flight', () => {
  it('stale syncBilling success does not repopulate', async () => {
    const a = gatedDependencies(exhaustedAccess);
    await a.boot();
    const sync = useAccessStore.getState().syncBilling();
    await flush();
    expect(useAccessStore.getState().operation).toBe('syncing');
    clearAccessStoreConfiguration();
    a.syncs[0]!.resolve(syncedPaid);
    await expect(sync).resolves.toBe(false);
    expectSignedOutDefaults();
  });

  it('stale syncBilling failure does not surface an error', async () => {
    const a = gatedDependencies(exhaustedAccess);
    await a.boot();
    const sync = useAccessStore.getState().syncBilling();
    await flush();
    clearAccessStoreConfiguration();
    a.syncs[0]!.reject(new Error('503 ' + 'x'.repeat(50_000)));
    await expect(sync).resolves.toBe(false);
    expectSignedOutDefaults();
  });

  it('stale restorePurchases (store phase and backend phase) does not repopulate', async () => {
    const a = gatedDependencies(exhaustedAccess);
    await a.boot();
    const restore1 = useAccessStore.getState().restorePurchases();
    await flush();
    clearAccessStoreConfiguration();
    a.restores[0]!.resolve(entitlement);
    await expect(restore1).resolves.toBe(false);
    expect(a.clients.backend.syncBilling).not.toHaveBeenCalled();
    expectSignedOutDefaults();

    const b = gatedDependencies(exhaustedAccess);
    await b.boot();
    const restore2 = useAccessStore.getState().restorePurchases();
    await flush();
    b.restores[0]!.resolve(entitlement);
    await flush();
    expect(b.syncs).toHaveLength(1);
    clearAccessStoreConfiguration();
    b.syncs[0]!.resolve(syncedPaid);
    await expect(restore2).resolves.toBe(false);
    expectSignedOutDefaults();
  });

  it('stale refreshAccess and stale initialize do not repopulate', async () => {
    const a = gatedDependencies(exhaustedAccess);
    await a.boot();
    const refresh = useAccessStore.getState().refreshAccess();
    await flush();
    expect(useAccessStore.getState().status).toBe('loading');
    clearAccessStoreConfiguration();
    a.accesses[a.accesses.length - 1]!.resolve(paidAccess);
    await expect(refresh).resolves.toBe(false);
    expectSignedOutDefaults();

    // initialize(): clear between configure() and the access/plans reads.
    const b = gatedDependencies(exhaustedAccess);
    configureAccessStore(b.clients);
    const init = useAccessStore.getState().initialize();
    await flush();
    clearAccessStoreConfiguration();
    b.accesses[0]!.resolve(paidAccess);
    await init;
    expectSignedOutDefaults();
  });
});

describe('rapid repeats and interleavings', () => {
  it('double-tap purchase: exactly one StoreKit purchase, second call is a no-op false', async () => {
    const a = gatedDependencies(exhaustedAccess);
    await a.boot();
    const first = useAccessStore.getState().purchaseSelected();
    const second = useAccessStore.getState().purchaseSelected();
    const third = useAccessStore.getState().restorePurchases();
    const fourth = useAccessStore.getState().syncBilling();
    await flush();
    expect(a.clients.store.purchase).toHaveBeenCalledTimes(1);
    expect(a.clients.store.restore).not.toHaveBeenCalled();
    await expect(second).resolves.toBe(false);
    await expect(third).resolves.toBe(false);
    await expect(fourth).resolves.toBe(false);
    expect(a.clients.backend.syncBilling).not.toHaveBeenCalled();
    a.purchases[0]!.resolve(entitlement);
    await flush();
    expect(a.clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    a.syncs[0]!.resolve(syncedPaid);
    await expect(first).resolves.toBe(true);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
  });

  it('seeded random interleaving of clear/configure/resolve never yields premium without a live verified sync', async () => {
    const SEED = 20260904;
    let s = SEED >>> 0;
    const rng = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let round = 0; round < 40; round += 1) {
      clearAccessStoreConfiguration();
      const a = gatedDependencies(exhaustedAccess);
      await a.boot();
      const purchase = useAccessStore.getState().purchaseSelected();
      await flush();
      // Attack step chosen by the seed: 0 clear before StoreKit resolves,
      // 1 clear between StoreKit and backend, 2 no clear (control).
      const step = Math.floor(rng() * 3);
      if (step === 0) clearAccessStoreConfiguration();
      a.purchases[0]!.resolve(entitlement);
      await flush();
      if (step === 1) clearAccessStoreConfiguration();
      if (a.syncs[0]) a.syncs[0].resolve(syncedPaid);
      const result = await purchase;
      const state = useAccessStore.getState();
      if (step === 2) {
        expect(result).toBe(true);
        expect(selectHasPremium(state)).toBe(true);
      } else {
        expect(result).toBe(false);
        expect(selectHasPremium(state)).toBe(false);
        expect(state.canonicalAccess).toBeNull();
        expect(state.operation).toBe('idle');
        if (step === 0) expect(a.syncs).toHaveLength(0);
      }
    }
  });
});
