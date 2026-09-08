/**
 * ATTACK AREA: paywall -> purchase -> pending fulfilment -> relaunch /
 * account switch / double taps / corrupted persisted state.
 *
 * Invariants under attack (AGENTS.md "Billing" + program invariants):
 *  - StoreKit completion is never entitlement; only the backend verdict is;
 *  - a pending purchase is owner-bound: another account on the same phone
 *    must never verify, publish, or consume it;
 *  - one paywall tap == one StoreKit purchase, however many times the user
 *    taps Continue / Restore while the sheet is slow;
 *  - unknown/corrupt pending state never becomes premium, never becomes a
 *    clean "nothing pending" state, and never lets a SECOND charge through;
 *  - the durable record survives process death and is replayed exactly once.
 *
 * Storage is the SHIPPING `createPendingFulfilmentStorage` over a real
 * migrated SQLite database (testSupport/sqlite.ts), not a Map.
 */
import {
  createPendingFulfilmentStorage,
  pendingFulfilmentKeyForOwner,
} from '../../src/billing/pendingFulfilment';
import {
  type BillingAccessDependencies,
  type BillingFulfilmentRequest,
  type CanonicalAccessState,
  type CanonicalBillingSync,
  type StoreEntitlementState,
  type StorePlans,
} from '../../src/billing/types';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectHasPremium,
  useAccessStore,
} from '../../src/state/accessStore';
import {
  ADV_OWNER_A,
  ADV_OWNER_B,
  advOpenDb,
  deferred,
  type AdvStore,
} from '../../testSupport/advJourneyHarness';
import { closeSqliteTestDatabases } from '../../testSupport/sqlite';

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
const premiumAccess: CanonicalAccessState = {
  ...freeAccess,
  premium: true,
  entitlements: ['premium'],
  canStartRating: true,
  paywallRequired: false,
};
const PRODUCT = 'pickle_sensei_pro_annual';
const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual-plan',
    productId: PRODUCT,
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: null,
  lifetime: null,
};
const transactionA = {
  productId: PRODUCT,
  transactionId: '2000000000000001',
  purchasedAt: '2026-09-01T00:00:00.000Z',
};
const transactionB = {
  productId: PRODUCT,
  transactionId: '2000000000000002',
  purchasedAt: '2026-09-02T00:00:00.000Z',
};
const entitlement = (
  transaction: typeof transactionA,
): StoreEntitlementState => ({
  premium: true,
  productId: PRODUCT,
  expirationDate: '2027-09-01T00:00:00.000Z',
  transaction,
});

function synced(premium: boolean): CanonicalBillingSync {
  return {
    billing: {
      premium,
      productKey: premium ? PRODUCT : null,
      expiresAt: premium ? '2027-09-01T00:00:00.000Z' : null,
      verifiedAt: '2026-09-07T00:00:00.000Z',
    },
    access: premium ? premiumAccess : freeAccess,
  };
}

/** A backend that echoes the fulfilment request with the given outcome. */
function verdict(
  request: BillingFulfilmentRequest | undefined,
  outcome: 'pending' | 'fulfilled',
): CanonicalBillingSync {
  if (!request) return synced(false);
  return {
    ...synced(outcome === 'fulfilled'),
    fulfilment: {
      ...request,
      outcome,
      verifiedAt: '2026-09-07T00:00:00.000Z',
    },
  };
}

function clients(owner: 'A' | 'B') {
  const transaction = owner === 'A' ? transactionA : transactionB;
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async (_planId: string) => entitlement(transaction)),
      restore: jest.fn(async () => entitlement(transaction)),
      readEntitlement: jest.fn(async () => entitlement(transaction)),
    },
    backend: {
      getAccess: jest.fn(async () => freeAccess),
      syncBilling: jest.fn(async (request?: BillingFulfilmentRequest) =>
        verdict(request, 'fulfilled'),
      ),
    },
  } satisfies BillingAccessDependencies;
}

function configure(
  deps: BillingAccessDependencies,
  store: AdvStore,
  owner: string,
) {
  setActiveDataOwner(owner);
  configureAccessStore(deps, {
    owner,
    pendingFulfilmentStorage: createPendingFulfilmentStorage(() => store.db),
  });
}

function rawRecord(store: AdvStore, owner: string): string | null {
  const row = store.native
    .prepare('SELECT value FROM kv WHERE key = ?')
    .get(pendingFulfilmentKeyForOwner(owner));
  return row ? String(row.value) : null;
}

function transactionsSent(deps: ReturnType<typeof clients>) {
  return deps.backend.syncBilling.mock.calls
    .map(([request]) => request?.transaction?.transactionId ?? null)
    .filter((id): id is string => id !== null);
}

async function flush(turns = 30) {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

let store: AdvStore;

beforeEach(() => {
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  store = advOpenDb();
});
afterEach(() => {
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  closeSqliteTestDatabases();
  jest.useRealTimers();
});

describe('paywall double taps while StoreKit is slow', () => {
  it('two Continue taps plus a Restore tap during one slow StoreKit sheet charge ONCE and verify ONCE', async () => {
    const deps = clients('A');
    const sheet = deferred<StoreEntitlementState>();
    deps.store.purchase.mockReturnValue(sheet.promise);
    configure(deps, store, ADV_OWNER_A);
    await useAccessStore.getState().initialize();

    const tap1 = useAccessStore.getState().purchaseSelected();
    const tap2 = useAccessStore.getState().purchaseSelected();
    const restoreTap = useAccessStore.getState().restorePurchases();
    await flush();
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);
    expect(deps.store.restore).not.toHaveBeenCalled();
    // Nothing is pending yet: StoreKit has not completed anything.
    expect(rawRecord(store, ADV_OWNER_A)).toBeNull();

    sheet.resolve(entitlement(transactionA));
    const results = await Promise.all([tap1, tap2, restoreTap]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);
    expect(deps.store.restore).not.toHaveBeenCalled();
    expect(transactionsSent(deps)).toEqual([transactionA.transactionId]);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(rawRecord(store, ADV_OWNER_A)).toBeNull();

    // A late fourth tap after fulfilment must not reach StoreKit again
    // while the account is already premium according to the backend.
    await useAccessStore.getState().purchaseSelected();
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);
  });

  it('a purchase whose backend verification is still in flight cannot be purchased again from a second tap', async () => {
    const deps = clients('A');
    const verification = deferred<CanonicalBillingSync>();
    deps.backend.syncBilling.mockReturnValueOnce(verification.promise);
    configure(deps, store, ADV_OWNER_A);
    await useAccessStore.getState().initialize();

    const first = useAccessStore.getState().purchaseSelected();
    await flush();
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);
    // StoreKit charged; the durable record exists BEFORE the backend answers.
    expect(rawRecord(store, ADV_OWNER_A)).toEqual(
      expect.stringContaining(transactionA.transactionId),
    );
    expect(selectHasPremium(useAccessStore.getState())).toBe(false);

    const second = useAccessStore.getState().purchaseSelected();
    await flush();
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);

    verification.resolve(
      verdict(deps.backend.syncBilling.mock.calls[0]?.[0], 'fulfilled'),
    );
    await Promise.all([first, second]);
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(rawRecord(store, ADV_OWNER_A)).toBeNull();
  });
});

describe('purchase pending across process death and account switch', () => {
  it("A buys offline, B signs in on the same phone, A returns: B never sees or spends A's purchase and A is fulfilled exactly once", async () => {
    // Process 1: A purchases; the backend is unreachable after the charge.
    const first = clients('A');
    first.backend.syncBilling.mockRejectedValue(new Error('network down'));
    configure(first, store, ADV_OWNER_A);
    await useAccessStore.getState().initialize();
    await useAccessStore.getState().purchaseSelected();
    expect(first.store.purchase).toHaveBeenCalledTimes(1);
    expect(rawRecord(store, ADV_OWNER_A)).toEqual(
      expect.stringContaining(transactionA.transactionId),
    );
    expect(selectHasPremium(useAccessStore.getState())).toBe(false);
    expect(useAccessStore.getState().fulfilmentStatus).toBe('pending');

    // Account switch: B signs in. B's backend says B is free.
    clearAccessStoreConfiguration();
    const forB = clients('B');
    configure(forB, store, ADV_OWNER_B);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().fulfilmentStatus).toBe('clear');
    expect(useAccessStore.getState().pendingFulfilment).toBeNull();
    expect(selectHasPremium(useAccessStore.getState())).toBe(false);
    expect(transactionsSent(forB)).toEqual([]);
    expect(forB.store.purchase).not.toHaveBeenCalled();
    expect(forB.store.restore).not.toHaveBeenCalled();
    // A's durable record is untouched by B's session.
    expect(rawRecord(store, ADV_OWNER_A)).toEqual(
      expect.stringContaining(transactionA.transactionId),
    );
    expect(rawRecord(store, ADV_OWNER_B)).toBeNull();

    // B buys their own membership; the verdict is for B's transaction only.
    await useAccessStore.getState().purchaseSelected();
    expect(forB.store.purchase).toHaveBeenCalledTimes(1);
    expect(transactionsSent(forB)).toEqual([transactionB.transactionId]);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(rawRecord(store, ADV_OWNER_B)).toBeNull();
    expect(rawRecord(store, ADV_OWNER_A)).toEqual(
      expect.stringContaining(transactionA.transactionId),
    );

    // A returns (relaunch as A): the pending purchase is replayed ONCE, with
    // A's transaction, and no new StoreKit purchase is made.
    clearAccessStoreConfiguration();
    const back = clients('A');
    configure(back, store, ADV_OWNER_A);
    await useAccessStore.getState().initialize();
    expect(transactionsSent(back)).toEqual([transactionA.transactionId]);
    expect(back.store.purchase).not.toHaveBeenCalled();
    expect(back.store.restore).not.toHaveBeenCalled();
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(rawRecord(store, ADV_OWNER_A)).toBeNull();
    // Nothing left to replay on a further relaunch.
    clearAccessStoreConfiguration();
    const again = clients('A');
    configure(again, store, ADV_OWNER_A);
    await useAccessStore.getState().initialize();
    expect(transactionsSent(again)).toEqual([]);
    expect(again.backend.getAccess).toHaveBeenCalledTimes(1);
  });

  it('a backend that keeps answering "pending" under concurrent retry taps never double-submits and never grants premium early', async () => {
    const deps = clients('A');
    deps.backend.syncBilling.mockImplementation(async request =>
      verdict(request, 'pending'),
    );
    configure(deps, store, ADV_OWNER_A);
    await useAccessStore.getState().initialize();
    await useAccessStore.getState().purchaseSelected();
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);
    expect(selectHasPremium(useAccessStore.getState())).toBe(false);
    expect(useAccessStore.getState().fulfilmentStatus).toBe('pending');
    expect(deps.backend.syncBilling).toHaveBeenCalledTimes(1);

    // Slow backend: the user hammers "Retry" while the first is in flight.
    const slow = deferred<CanonicalBillingSync>();
    deps.backend.syncBilling.mockReturnValueOnce(slow.promise);
    const retry1 = useAccessStore.getState().retryPendingFulfilment();
    await flush();
    const retry2 = useAccessStore.getState().retryPendingFulfilment();
    const retry3 = useAccessStore.getState().retryPendingFulfilment();
    await flush();
    expect(deps.backend.syncBilling).toHaveBeenCalledTimes(2);
    slow.resolve(
      verdict(deps.backend.syncBilling.mock.calls[1]?.[0], 'pending'),
    );
    await Promise.all([retry1, retry2, retry3]);
    expect(deps.backend.syncBilling).toHaveBeenCalledTimes(2);
    expect(selectHasPremium(useAccessStore.getState())).toBe(false);
    expect(useAccessStore.getState().fulfilmentStatus).toBe('pending');
    // Every attempt reused the SAME pending identity (never a new purchase id)
    // and the durable attempt counter moved with it.
    const pendingIds = new Set(
      deps.backend.syncBilling.mock.calls.map(
        ([request]) => request?.pendingId,
      ),
    );
    expect(pendingIds.size).toBe(1);
    expect(JSON.parse(rawRecord(store, ADV_OWNER_A) ?? 'null')).toMatchObject({
      attempts: 2,
      transaction: transactionA,
    });
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);

    // Backend finally fulfils: premium is granted exactly once and the
    // record is gone; further retries make no backend calls.
    deps.backend.syncBilling.mockImplementation(async request =>
      verdict(request, 'fulfilled'),
    );
    await expect(
      useAccessStore.getState().retryPendingFulfilment(),
    ).resolves.toBe(true);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(rawRecord(store, ADV_OWNER_A)).toBeNull();
    expect(deps.backend.syncBilling).toHaveBeenCalledTimes(3);
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);
  });
});

describe('corrupted pending-fulfilment state on relaunch', () => {
  const validRecord = () => ({
    schemaVersion: 2,
    id: '33333333-3333-4333-8333-333333333333',
    owner: ADV_OWNER_A,
    source: 'purchase',
    state: 'pending',
    completedAtMs: 1_756_684_800_000,
    attempts: 1,
    lastAttemptAtMs: 1_756_684_801_000,
    transaction: transactionA,
  });
  const corruptions: ReadonlyArray<[string, string]> = [
    [
      'a record that claims to be already fulfilled + premium',
      JSON.stringify({
        ...validRecord(),
        state: 'fulfilled',
        premium: true,
        entitlements: ['premium'],
      }),
    ],
    [
      "another owner's record stored under A's key",
      JSON.stringify({ ...validRecord(), owner: ADV_OWNER_B }),
    ],
    [
      'a record with an impossible attempt counter',
      JSON.stringify({ ...validRecord(), attempts: 40 }),
    ],
    [
      'a v2 record without transaction evidence',
      JSON.stringify({ ...validRecord(), transaction: undefined }),
    ],
    [
      'a restore record carrying purchase evidence (v2 restore)',
      JSON.stringify({ ...validRecord(), source: 'restore' }),
    ],
    ['truncated JSON', JSON.stringify(validRecord()).slice(0, 60)],
    [
      'an oversized record',
      JSON.stringify({ ...validRecord(), pad: 'x'.repeat(3_000) }),
    ],
    ['an array', JSON.stringify([validRecord()])],
  ];

  it.each(corruptions)(
    '%s never becomes premium, never becomes "nothing pending", and blocks a second StoreKit charge',
    async (_label, raw) => {
      store.native
        .prepare('INSERT INTO kv(key, value) VALUES(?, ?)')
        .run(pendingFulfilmentKeyForOwner(ADV_OWNER_A), raw);
      const deps = clients('A');
      configure(deps, store, ADV_OWNER_A);
      await useAccessStore.getState().initialize();

      const state = useAccessStore.getState();
      expect(selectHasPremium(state)).toBe(false);
      expect(state.fulfilmentStatus).toBe('unavailable');
      expect(state.error?.code).toBe('billing.backend_verification_pending');
      // The corrupt record is not silently destroyed (unknown != clear) …
      expect(rawRecord(store, ADV_OWNER_A)).toBe(raw);
      // … and no fabricated fulfilment request was sent to the backend.
      expect(transactionsSent(deps)).toEqual([]);

      // Continue / Restore must both refuse to reach StoreKit: a second
      // charge on top of an unreadable first one is the money-loss path.
      await useAccessStore.getState().purchaseSelected();
      await useAccessStore.getState().restorePurchases();
      expect(deps.store.purchase).not.toHaveBeenCalled();
      expect(deps.store.restore).not.toHaveBeenCalled();
      expect(selectHasPremium(useAccessStore.getState())).toBe(false);
      expect(rawRecord(store, ADV_OWNER_A)).toBe(raw);
    },
  );

  it('a stale but VALID record for A is replayed for A only, never for B who signs in first', async () => {
    store.native
      .prepare('INSERT INTO kv(key, value) VALUES(?, ?)')
      .run(
        pendingFulfilmentKeyForOwner(ADV_OWNER_A),
        JSON.stringify(validRecord()),
      );
    const forB = clients('B');
    configure(forB, store, ADV_OWNER_B);
    await useAccessStore.getState().initialize();
    expect(transactionsSent(forB)).toEqual([]);
    expect(useAccessStore.getState().fulfilmentStatus).toBe('clear');
    expect(selectHasPremium(useAccessStore.getState())).toBe(false);

    clearAccessStoreConfiguration();
    const forA = clients('A');
    configure(forA, store, ADV_OWNER_A);
    await useAccessStore.getState().initialize();
    expect(transactionsSent(forA)).toEqual([transactionA.transactionId]);
    expect(forA.backend.syncBilling.mock.calls[0]?.[0]?.pendingId).toBe(
      validRecord().id,
    );
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(rawRecord(store, ADV_OWNER_A)).toBeNull();
    expect(forA.store.purchase).not.toHaveBeenCalled();
  });
});
