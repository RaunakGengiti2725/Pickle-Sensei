/**
 * INT-state-consistency adversarial probes against accessStore (integration
 * head 2994371e). Every `it` is one attack; a FAILING attack is a confirmed
 * break, a PASSING attack is evidence that the boundary holds. Production
 * code and existing tests are untouched.
 */
import { BILLING_REQUEST_TIMEOUT_MS } from '../../src/billing/accessApi';
import {
  BillingError,
  type BillingAccessDependencies,
  type BillingFulfilmentRequest,
  type CanonicalAccessState,
  type CanonicalBillingSync,
  type StoreEntitlementState,
  type StorePlans,
} from '../../src/billing/types';
import {
  createPendingFulfilment,
  createPendingFulfilmentStorage,
  pendingFulfilmentKeyForOwner,
  type PendingFulfilment,
  type PendingFulfilmentStorage,
} from '../../src/billing/pendingFulfilment';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import type { LocalDb } from '../../src/data/db';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectCanStartRating,
  selectHasPremium,
  selectMembershipState,
  selectPaywallRequired,
  useAccessStore,
} from '../../src/state/accessStore';

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';

const oneRatingLeft: CanonicalAccessState = {
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
const exhausted: CanonicalAccessState = {
  ...oneRatingLeft,
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
  ...exhausted,
  premium: true,
  entitlements: ['premium'],
  canStartRating: true,
  paywallRequired: false,
};
const storeEntitlement: StoreEntitlementState = {
  premium: true,
  productId: 'pickle_sensei_pro_annual',
  expirationDate: '2027-09-01T00:00:00.000Z',
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

function synced(premium = true): CanonicalBillingSync {
  return {
    billing: {
      premium,
      productKey: premium ? storeEntitlement.productId : null,
      expiresAt: premium ? storeEntitlement.expirationDate : null,
      verifiedAt: '2026-09-01T00:00:00.000Z',
    },
    access: premium ? premiumAccess : exhausted,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function memoryStorage() {
  const records = new Map<string, string>();
  const storage: PendingFulfilmentStorage = {
    read: jest.fn(async owner => {
      const raw = records.get(owner);
      return raw ? (JSON.parse(raw) as PendingFulfilment) : null;
    }),
    write: jest.fn(async (record, assertActive) => {
      assertActive?.();
      records.set(record.owner, JSON.stringify(record));
    }),
    remove: jest.fn(async (record, assertActive) => {
      assertActive?.();
      if (records.get(record.owner) === JSON.stringify(record))
        records.delete(record.owner);
    }),
  };
  return { records, storage };
}

function sqliteDb() {
  const { DatabaseSync } = jest.requireActual('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        all(...params: unknown[]): Record<string, unknown>[];
        run(...params: unknown[]): { changes: number | bigint };
      };
      close(): void;
    };
  };
  const native = new DatabaseSync(':memory:');
  native.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const execute = jest.fn<
    ReturnType<LocalDb['execute']>,
    Parameters<LocalDb['execute']>
  >(async (sql, params = []) => {
    const statement = native.prepare(sql);
    if (sql.startsWith('SELECT')) return { rows: statement.all(...params) };
    return { rows: [], rowsAffected: Number(statement.run(...params).changes) };
  });
  const db: LocalDb = { execute, close: () => native.close() };
  return { db, execute, native };
}

function dependencies(access: CanonicalAccessState = oneRatingLeft) {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async (_planId: string) => storeEntitlement),
      restore: jest.fn(async () => storeEntitlement),
      readEntitlement: jest.fn(async () => storeEntitlement),
    },
    backend: {
      getAccess: jest.fn(async () => access),
      syncBilling: jest.fn(async (_request?: BillingFulfilmentRequest) =>
        synced(),
      ),
    },
  } satisfies BillingAccessDependencies;
}

function configure(
  clients: BillingAccessDependencies,
  storage: PendingFulfilmentStorage,
  owner = OWNER_A,
) {
  setActiveDataOwner(owner);
  configureAccessStore(clients, { owner, pendingFulfilmentStorage: storage });
}

async function flush(turns = 40) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

beforeEach(() => {
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});
afterEach(() => {
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('ADV-01 corrupt pending-fulfilment journal row (real SQLite storage)', () => {
  it('fails closed for store actions and never fabricates premium', async () => {
    const { db } = sqliteDb();
    try {
      await db.execute('INSERT INTO kv(key, value) VALUES(?, ?)', [
        pendingFulfilmentKeyForOwner(OWNER_A),
        '{"schemaVersion":1,"garbage"',
      ]);
      const clients = dependencies();
      configure(
        clients,
        createPendingFulfilmentStorage(() => db),
      );
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().purchaseSelected();
      await useAccessStore.getState().restorePurchases();
      expect(clients.store.purchase).not.toHaveBeenCalled();
      expect(clients.store.restore).not.toHaveBeenCalled();
      expect(selectHasPremium(useAccessStore.getState())).toBe(false);
      expect(useAccessStore.getState().fulfilmentStatus).toBe('unavailable');
    } finally {
      db.close();
    }
  });

  it('still consults the server-authoritative free allowance (initialize, retry, relaunch)', async () => {
    const { db } = sqliteDb();
    try {
      await db.execute('INSERT INTO kv(key, value) VALUES(?, ?)', [
        pendingFulfilmentKeyForOwner(OWNER_A),
        '{"schemaVersion":1,"garbage"',
      ]);
      const clients = dependencies();
      configure(
        clients,
        createPendingFulfilmentStorage(() => db),
      );
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().retryPendingFulfilment();
      await useAccessStore.getState().refreshAccess();
      // Relaunch: new storage instance, same persisted row, fresh configure.
      clearAccessStoreConfiguration();
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      configure(
        clients,
        createPendingFulfilmentStorage(() => db),
      );
      await useAccessStore.getState().initialize();
      const state = useAccessStore.getState();
      expect(clients.backend.getAccess).toHaveBeenCalled();
      expect(state.canonicalAccess).toEqual(oneRatingLeft);
      expect(selectCanStartRating(state)).toBe(true);
      expect(selectPaywallRequired(state)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('ADV-02 dismissed error resurrected by a not-due reconcile pass', () => {
  it('keeps a dismissed reconciliation error dismissed when reconcileBilling finds nothing due', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-09-06T00:00:00.000Z') });
    const { storage } = memoryStorage();
    const clients = dependencies();
    clients.backend.syncBilling.mockRejectedValueOnce(new Error('offline'));
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    await useAccessStore.getState().purchaseSelected();
    expect(useAccessStore.getState().pendingFulfilment).not.toBeNull();
    expect(useAccessStore.getState().reconciliation.error).not.toBeNull();
    useAccessStore.getState().clearError();
    expect(useAccessStore.getState().reconciliation.error).toBeNull();
    const dismissed = selectMembershipState(useAccessStore.getState());
    await useAccessStore.getState().reconcileBilling();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().error).toBeNull();
    expect(useAccessStore.getState().reconciliation.error).toBeNull();
    expect(selectMembershipState(useAccessStore.getState())).toEqual(dismissed);
  });
});

describe('ADV-03 refreshAccess() with a pending journal bypasses the retry backoff', () => {
  it('does not re-verify a pending record before its retry deadline on a passive refresh', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-09-06T00:00:00.000Z') });
    const { storage } = memoryStorage();
    const clients = dependencies();
    clients.backend.syncBilling.mockRejectedValue(new Error('offline'));
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    await useAccessStore.getState().purchaseSelected();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    const before = useAccessStore.getState().pendingFulfilment;
    expect(before?.attempts).toBe(1);
    // Three Settings visits within one second, all inside the 5s backoff.
    await useAccessStore.getState().refreshAccess();
    await useAccessStore.getState().refreshAccess();
    await useAccessStore.getState().refreshAccess();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().pendingFulfilment?.attempts).toBe(1);
  });
});

describe('ADV-04 stale access snapshot after scoring (refresh dropped while one is in flight)', () => {
  it('lands the post-consumption snapshot when a refresh is requested during an older refresh', async () => {
    const { storage } = memoryStorage();
    const clients = dependencies();
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().canonicalAccess).toEqual(oneRatingLeft);

    const stale = deferred<CanonicalAccessState>();
    clients.backend.getAccess.mockReturnValueOnce(stale.promise);
    clients.backend.getAccess.mockResolvedValue(exhausted);
    const first = useAccessStore.getState().refreshAccess();
    await flush();
    // The scoring run consumed the last free rating; AnalyzeScreen unmount
    // asks for a fresh read while the pre-scoring read is still in flight.
    const second = useAccessStore.getState().refreshAccess();
    stale.resolve(oneRatingLeft);
    await Promise.all([first, second]);
    await flush();
    const state = useAccessStore.getState();
    expect(state.operation).toBe('idle');
    expect(state.canonicalAccess).toEqual(exhausted);
    expect(selectCanStartRating(state)).toBe(false);
  });
});

describe('ADV-05 reset() mid-purchase after the store already charged', () => {
  it('journals the completed purchase for the owner and never charges twice', async () => {
    const { records, storage } = memoryStorage();
    const clients = dependencies();
    const charge = deferred<StoreEntitlementState>();
    clients.store.purchase.mockReturnValueOnce(charge.promise);
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    const purchasing = useAccessStore.getState().purchaseSelected();
    await flush();
    useAccessStore.getState().reset();
    charge.resolve(storeEntitlement);
    await expect(purchasing).resolves.toBe(false);
    expect(records.has(OWNER_A)).toBe(true);
    expect(selectHasPremium(useAccessStore.getState())).toBe(false);
    await useAccessStore.getState().initialize();
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(records.has(OWNER_A)).toBe(false);
    await useAccessStore.getState().purchaseSelected();
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
  });
});

describe('ADV-06 slow store SDK (configure never resolves) with a fast backend', () => {
  it('publishes the verified free allowance once the SDK call times out', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-09-06T00:00:00.000Z') });
    const { storage } = memoryStorage();
    const clients = dependencies();
    clients.store.configure.mockReturnValue(
      new Promise<undefined>(() => undefined),
    );
    configure(clients, storage);
    const initializing = useAccessStore.getState().initialize();
    await flush();
    expect(useAccessStore.getState().status).toBe('loading');
    await jest.advanceTimersByTimeAsync(BILLING_REQUEST_TIMEOUT_MS + 1);
    await initializing;
    const state = useAccessStore.getState();
    expect(state.status).toBe('unconfigured');
    expect(state.canonicalAccess).toEqual(oneRatingLeft);
    expect(selectCanStartRating(state)).toBe(true);
    expect(state.plans).toBeNull();
    expect(state.operation).toBe('idle');
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('ADV-07 account switch A→B during A\u2019s journal write (real SQLite storage)', () => {
  it('rolls back A\u2019s attempt bump and B never sees A\u2019s record', async () => {
    const { db, execute } = sqliteDb();
    try {
      const storage = createPendingFulfilmentStorage(() => db);
      const a = dependencies();
      a.backend.syncBilling.mockRejectedValueOnce(new Error('offline'));
      configure(a, storage);
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().purchaseSelected();
      const journaled = await storage.read(OWNER_A);
      expect(journaled?.attempts).toBe(1);

      const gate = deferred<void>();
      const original = execute.getMockImplementation()!;
      execute.mockImplementation(async (sql, params) => {
        const result = await original(sql, params);
        if (sql.startsWith('INSERT INTO kv')) await gate.promise;
        return result;
      });
      const retry = useAccessStore.getState().retryPendingFulfilment();
      await flush(100);
      expect(
        execute.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO kv')),
      ).toBe(true);
      expect(a.backend.syncBilling).toHaveBeenCalledTimes(1);
      // Owner switch lands while the attempt bump is inside its transaction.
      const b = dependencies();
      configure(b, storage, OWNER_B);
      gate.resolve();
      await expect(retry).resolves.toBe(false);
      expect(a.backend.syncBilling).toHaveBeenCalledTimes(1);
      await useAccessStore.getState().initialize();
      const state = useAccessStore.getState();
      expect(state.pendingFulfilment).toBeNull();
      expect(state.fulfilmentStatus).toBe('clear');
      expect(selectHasPremium(state)).toBe(false);
      expect(await storage.read(OWNER_B)).toBeNull();
      expect(await storage.read(OWNER_A)).toEqual(journaled);
      expect(execute.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('ADV-08 hydrate ordering: billing configured before the data owner is set', () => {
  it('surfaces an explicit error instead of an idle store that silently ignores every action', async () => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const { storage } = memoryStorage();
    const clients = dependencies();
    configureAccessStore(clients, {
      owner: OWNER_A,
      pendingFulfilmentStorage: storage,
    });
    setActiveDataOwner(OWNER_A);
    await useAccessStore.getState().initialize();
    await useAccessStore.getState().refreshAccess();
    const state = useAccessStore.getState();
    const surfaced =
      state.status === 'unconfigured' ||
      state.status === 'error' ||
      state.canonicalAccess !== null;
    expect(surfaced).toBe(true);
  });
});

describe('ADV-09 backend verdict for a journaled record lands after sign-out and re-sign-in as the same owner', () => {
  it('does not publish the previous generation\u2019s verdict and re-verifies under the new generation', async () => {
    const { storage } = memoryStorage();
    const first = dependencies();
    first.backend.syncBilling.mockRejectedValueOnce(new Error('offline'));
    configure(first, storage);
    await useAccessStore.getState().initialize();
    await useAccessStore.getState().purchaseSelected();
    const verification = deferred<CanonicalBillingSync>();
    first.backend.syncBilling.mockReturnValueOnce(verification.promise);
    const retry = useAccessStore.getState().retryPendingFulfilment();
    await flush();
    clearAccessStoreConfiguration();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    expect(useAccessStore.getState().pendingFulfilment).toBeNull();
    const second = dependencies();
    configure(second, storage);
    verification.resolve(synced());
    await expect(retry).resolves.toBe(false);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(selectHasPremium(useAccessStore.getState())).toBe(false);
    await useAccessStore.getState().initialize();
    expect(second.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(first.store.purchase).toHaveBeenCalledTimes(1);
    expect(second.store.purchase).not.toHaveBeenCalled();
  });
});

describe('ADV-10 journal write failure right after the store charged, then process death', () => {
  it('recovers the unwritten completion in the same process and re-verifies without a second charge', async () => {
    const { records, storage } = memoryStorage();
    const clients = dependencies();
    (storage.write as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expect(records.has(OWNER_A)).toBe(false);
    expect(useAccessStore.getState().pendingFulfilment).not.toBeNull();
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.backend_verification_pending',
    );
    // Purchase again is refused while recovery is pending.
    await useAccessStore.getState().purchaseSelected();
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
    await expect(
      useAccessStore.getState().retryPendingFulfilment(),
    ).resolves.toBe(true);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
    expect(records.has(OWNER_A)).toBe(false);
    expect(
      (storage.write as jest.Mock).mock.calls.length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('a corrupt row written by an interrupted process cannot be silently replaced by a new purchase', async () => {
    const { db } = sqliteDb();
    try {
      await db.execute('INSERT INTO kv(key, value) VALUES(?, ?)', [
        pendingFulfilmentKeyForOwner(OWNER_A),
        JSON.stringify({
          ...createPendingFulfilment(OWNER_A, 'purchase'),
          attempts: 3,
          lastAttemptAtMs: null,
        }),
      ]);
      const storage = createPendingFulfilmentStorage(() => db);
      await expect(storage.read(OWNER_A)).rejects.toBeInstanceOf(BillingError);
      const clients = dependencies();
      configure(clients, storage);
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().purchaseSelected();
      expect(clients.store.purchase).not.toHaveBeenCalled();
      const { rows } = await db.execute('SELECT value FROM kv WHERE key = ?', [
        pendingFulfilmentKeyForOwner(OWNER_A),
      ]);
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.['value'])).toContain('"attempts":3');
    } finally {
      db.close();
    }
  });
});
