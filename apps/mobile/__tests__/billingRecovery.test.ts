import { createCanonicalAccessClient } from '../src/billing/accessApi';
import {
  BillingError,
  type BillingAccessDependencies,
  type BillingFulfilmentRequest,
  type CanonicalAccessState,
  type CanonicalBillingSync,
  type StoreEntitlementState,
  type StorePlans,
} from '../src/billing/types';
import {
  createPendingFulfilment,
  createPendingFulfilmentStorage,
  parsePendingFulfilment,
  pendingFulfilmentKeyForOwner,
  pendingFulfilmentRetryDue,
  PENDING_FULFILMENT_MAX_BACKOFF_MS,
  PENDING_FULFILMENT_MAX_LENGTH,
  type PendingFulfilment,
  type PendingFulfilmentStorage,
} from '../src/billing/pendingFulfilment';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import type { LocalDb } from '../src/data/db';
import * as apiSession from '../src/account/apiSession';
import {
  BILLING_RECONCILIATION_INTERVAL_MS,
  BILLING_RECONCILIATION_RETRY_MS,
  clearAccessStoreConfiguration,
  configureAccessStore,
  createBillingLifecycleCallback,
  discardPendingFulfilmentForOwner,
  selectBillingReconciliationRetryAtMs,
  selectHasPremium,
  useAccessStore,
} from '../src/state/accessStore';

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
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
    access: premium ? premiumAccess : freeAccess,
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

function durableStorage() {
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
      const raw = records.get(record.owner);
      if (raw === JSON.stringify(record)) {
        records.delete(record.owner);
      }
    }),
  };
  return { records, storage };
}

function dependencies() {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async (_planId: string) => storeEntitlement),
      restore: jest.fn(async () => storeEntitlement),
      readEntitlement: jest.fn(async () => storeEntitlement),
    },
    backend: {
      getAccess: jest.fn(async () => freeAccess),
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

async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
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

describe('owner-bound durable billing fulfilment', () => {
  it.each([
    'absence',
    'pending',
    'old-attempt',
    'other-transaction',
    'old-verdict',
  ] as const)(
    'retains a transaction-bound purchase when recovery supplies %s',
    async reason => {
      const { storage } = durableStorage();
      const clients = dependencies();
      const transaction = {
        productId: storeEntitlement.productId!,
        transactionId: '1000000123456789',
        purchasedAt: '2026-09-01T00:00:00.000Z',
      };
      clients.store.purchase.mockResolvedValue({
        ...storeEntitlement,
        transaction,
      });
      clients.backend.syncBilling.mockImplementation(async request => ({
        ...synced(false),
        ...(reason === 'absence'
          ? {}
          : {
              fulfilment: {
                ...request!,
                outcome:
                  reason === 'pending'
                    ? ('pending' as const)
                    : ('expired' as const),
                attemptId:
                  reason === 'old-attempt' ? 'old-attempt' : request!.attemptId,
                transaction:
                  reason === 'other-transaction'
                    ? { ...transaction, transactionId: 'other' }
                    : transaction,
                verifiedAt:
                  reason === 'old-verdict'
                    ? '2026-08-31T00:00:00.000Z'
                    : '2026-09-07T00:00:00.000Z',
              },
            }),
      }));
      configure(clients, storage);
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().purchaseSelected();
      await useAccessStore.getState().retryPendingFulfilment();
      expect(await storage.read(OWNER_A)).toMatchObject({
        schemaVersion: 2,
        transaction,
      });
      expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
      expect(
        clients.backend.syncBilling.mock.calls[0]?.[0]?.attemptId,
      ).not.toBe(clients.backend.syncBilling.mock.calls[1]?.[0]?.attemptId);
      await useAccessStore.getState().purchaseSelected();
      expect(clients.store.purchase).toHaveBeenCalledTimes(1);
      expect(clients.store.restore).not.toHaveBeenCalled();
    },
  );

  it.each(['expired', 'refunded'] as const)(
    'relaunch clears a transaction-bound %s purchase only after a fresh backend disposition',
    async outcome => {
      const { db, storage } = await sqliteStorage();
      try {
        const transaction = {
          productId: storeEntitlement.productId!,
          transactionId: '1000000123456789',
          purchasedAt: '2026-09-01T00:00:00.000Z',
        };
        const first = dependencies();
        first.store.purchase.mockResolvedValue({
          ...storeEntitlement,
          transaction,
        });
        first.backend.syncBilling.mockRejectedValueOnce(
          new Error('offline after charge'),
        );
        configure(first, storage);
        await useAccessStore.getState().initialize();
        await useAccessStore.getState().purchaseSelected();
        expect(await storage.read(OWNER_A)).toMatchObject({
          schemaVersion: 2,
          transaction,
        });
        clearAccessStoreConfiguration();

        const relaunched = dependencies();
        relaunched.backend.syncBilling.mockImplementation(async request => {
          if (!request)
            throw new Error('Recovery must send its durable purchase identity');
          return {
            ...synced(false),
            fulfilment: {
              ...request,
              outcome,
              verifiedAt: '2026-09-07T00:00:00.000Z',
            },
          };
        });
        configure(relaunched, storage);
        await useAccessStore.getState().initialize();
        expect(relaunched.backend.syncBilling).toHaveBeenCalledWith({
          pendingId: expect.any(String),
          attemptId: expect.any(String),
          transaction,
        });
        expect(await storage.read(OWNER_A)).toBeNull();
        expect(useAccessStore.getState()).toMatchObject({
          fulfilmentStatus: 'clear',
          canonicalAccess: { premium: false },
          error: { code: 'billing.purchase_settled', retryable: false },
        });
        expect(first.store.purchase).toHaveBeenCalledTimes(1);
        expect(relaunched.store.purchase).not.toHaveBeenCalled();
        expect(relaunched.store.restore).not.toHaveBeenCalled();
        expect(relaunched.store.readEntitlement).not.toHaveBeenCalled();
      } finally {
        clearAccessStoreConfiguration();
        await db.close();
      }
    },
  );

  it.each(['purchaseSelected', 'restorePurchases'] as const)(
    '%s persists completion before backend verification and never grants from StoreKit',
    async operation => {
      const { records, storage } = durableStorage();
      const clients = dependencies();
      const verification = deferred<CanonicalBillingSync>();
      clients.backend.syncBilling.mockReturnValueOnce(verification.promise);
      configure(clients, storage);
      await useAccessStore.getState().initialize();
      const pending = useAccessStore.getState()[operation]();
      await flush();

      expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
      expect(records.has(OWNER_A)).toBe(true);
      expect(JSON.parse(records.get(OWNER_A)!)).toMatchObject({
        schemaVersion: 1,
        owner: OWNER_A,
        source: operation === 'purchaseSelected' ? 'purchase' : 'restore',
        state: 'pending',
      });
      expect(records.get(OWNER_A)).not.toMatch(
        /premium|token|receipt|expirationDate|priceString/,
      );
      expect(selectHasPremium(useAccessStore.getState())).toBe(false);
      verification.reject(
        new Error('backend unavailable after StoreKit completion'),
      );
      await expect(pending).resolves.toBe(false);
      expect(useAccessStore.getState()).toMatchObject({
        operation: 'idle',
        canonicalAccess: null,
        pendingFulfilment: { owner: OWNER_A },
        error: {
          code: 'billing.backend_verification_pending',
          retryable: true,
        },
      });
      expect(records.has(OWNER_A)).toBe(true);
    },
  );

  it.each(['purchaseSelected', 'restorePurchases'] as const)(
    'relaunch after %s re-verifies with the backend without restore, purchase, or a stale GET',
    async operation => {
      const { records, storage } = durableStorage();
      const first = dependencies();
      first.backend.syncBilling.mockRejectedValueOnce(new Error('offline'));
      configure(first, storage);
      await useAccessStore.getState().initialize();
      await useAccessStore.getState()[operation]();
      clearAccessStoreConfiguration();
      const relaunched = dependencies();
      configure(relaunched, storage);
      expect(useAccessStore.getState().canonicalAccess).toBeNull();
      await useAccessStore.getState().initialize();

      expect(relaunched.backend.syncBilling).toHaveBeenCalledTimes(1);
      expect(relaunched.backend.getAccess).not.toHaveBeenCalled();
      expect(relaunched.store.purchase).not.toHaveBeenCalled();
      expect(relaunched.store.restore).not.toHaveBeenCalled();
      expect(relaunched.store.readEntitlement).not.toHaveBeenCalled();
      expect(records.has(OWNER_A)).toBe(false);
      expect(useAccessStore.getState().pendingFulfilment).toBeNull();
      expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    },
  );

  it('reinitialization retains a nonpremium completed purchase and never offers a second charge', async () => {
    const { records, storage } = durableStorage();
    const clients = dependencies();
    clients.backend.syncBilling.mockResolvedValue(synced(false));
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    await useAccessStore.getState().purchaseSelected();
    await useAccessStore.getState().initialize();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().pendingFulfilment).not.toBeNull();
    await useAccessStore.getState().purchaseSelected();
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
    expect(records.has(OWNER_A)).toBe(true);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
  });

  it('an explicit backend retry does not depend on store configuration or pricing', async () => {
    const { storage } = durableStorage();
    const first = dependencies();
    first.backend.syncBilling.mockRejectedValueOnce(new Error('offline'));
    configure(first, storage);
    await useAccessStore.getState().initialize();
    await useAccessStore.getState().purchaseSelected();
    const next = dependencies();
    next.store.configure.mockRejectedValue(new Error('SDK unavailable'));
    configure(next, storage);
    await expect(
      useAccessStore.getState().retryPendingFulfilment(),
    ).resolves.toBe(true);
    expect(next.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(next.store.configure).not.toHaveBeenCalled();
    expect(next.store.loadPlans).not.toHaveBeenCalled();
    expect(next.store.restore).not.toHaveBeenCalled();
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
  });

  it('does not persist cancelled or failed purchases', async () => {
    const { records, storage } = durableStorage();
    const clients = dependencies();
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    clients.store.purchase.mockRejectedValueOnce(
      new BillingError('billing.purchase_cancelled', 'Cancelled', false),
    );
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expect(useAccessStore.getState().error).toBeNull();
    clients.store.purchase.mockRejectedValueOnce(
      new Error('StoreKit unavailable'),
    );
    await useAccessStore.getState().purchaseSelected();
    expect(records.size).toBe(0);
    expect(clients.backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState().operation).toBe('idle');
  });

  it('a verified negative restore ends pending recovery without fabricating premium', async () => {
    const { records, storage } = durableStorage();
    const clients = dependencies();
    clients.backend.syncBilling.mockRejectedValueOnce(new Error('offline'));
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    await useAccessStore.getState().restorePurchases();
    clients.backend.syncBilling.mockResolvedValueOnce(synced(false));
    await useAccessStore.getState().retryPendingFulfilment();
    expect(records.size).toBe(0);
    expect(useAccessStore.getState()).toMatchObject({
      status: 'ready',
      operation: 'idle',
      pendingFulfilment: null,
      canonicalAccess: freeAccess,
      error: { code: 'billing.restore_failed', retryable: false },
    });
    expect(clients.store.restore).toHaveBeenCalledTimes(1);
  });

  it('keeps completion in memory when durable writing fails, then retries persistence and backend only', async () => {
    const { records, storage } = durableStorage();
    const clients = dependencies();
    (storage.write as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expect(useAccessStore.getState()).toMatchObject({
      operation: 'idle',
      pendingFulfilment: { owner: OWNER_A },
      error: { retryable: true },
    });
    await expect(
      useAccessStore.getState().retryPendingFulfilment(),
    ).resolves.toBe(true);
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
    expect(clients.store.restore).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
  });

  it('a marker cleanup failure is retryable and does not report fulfilment success', async () => {
    const { records, storage } = durableStorage();
    const clients = dependencies();
    (storage.remove as jest.Mock).mockRejectedValueOnce(
      new Error('write failed'),
    );
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expect(records.has(OWNER_A)).toBe(true);
    expect(useAccessStore.getState().operation).toBe('idle');
    await expect(
      useAccessStore.getState().retryPendingFulfilment(),
    ).resolves.toBe(true);
    expect(records.size).toBe(0);
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
  });

  it('late StoreKit completion is saved for its original owner without publishing or verifying as the successor', async () => {
    const { records, storage } = durableStorage();
    const first = dependencies();
    const sdkCompletion = deferred<StoreEntitlementState>();
    first.store.purchase.mockReturnValueOnce(sdkCompletion.promise);
    configure(first, storage);
    await useAccessStore.getState().initialize();
    const purchasing = useAccessStore.getState().purchaseSelected();
    await flush();
    const second = dependencies();
    configure(second, storage, OWNER_B);
    await useAccessStore.getState().initialize();
    sdkCompletion.resolve(storeEntitlement);
    await expect(purchasing).resolves.toBe(false);

    expect(records.has(OWNER_A)).toBe(true);
    expect(records.has(OWNER_B)).toBe(false);
    expect(first.backend.syncBilling).not.toHaveBeenCalled();
    expect(second.backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState().pendingFulfilment).toBeNull();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
    configure(first, storage);
    await useAccessStore.getState().initialize();
    expect(first.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(first.store.purchase).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'a late backend response cannot clear or publish through a new configuration, same owner=%s',
    async sameOwner => {
      const { records, storage } = durableStorage();
      const first = dependencies();
      const verification = deferred<CanonicalBillingSync>();
      first.backend.syncBilling.mockReturnValueOnce(verification.promise);
      configure(first, storage);
      await useAccessStore.getState().initialize();
      const purchasing = useAccessStore.getState().purchaseSelected();
      await flush();
      configure(
        sameOwner ? first : dependencies(),
        storage,
        sameOwner ? OWNER_A : OWNER_B,
      );
      verification.resolve(synced());
      await expect(purchasing).resolves.toBe(false);
      expect(records.has(OWNER_A)).toBe(true);
      expect(useAccessStore.getState()).toMatchObject({
        status: 'idle',
        operation: 'idle',
        canonicalAccess: null,
        pendingFulfilment: null,
      });
    },
  );

  it('automatic retry uses bounded backoff and single flight; explicit retry can run immediately', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-09-06T00:00:00.000Z') });
    const { storage } = durableStorage();
    const clients = dependencies();
    clients.backend.syncBilling.mockRejectedValueOnce(new Error('offline'));
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    await useAccessStore.getState().purchaseSelected();
    await useAccessStore.getState().retryPendingFulfilment({ automatic: true });
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    const verification = deferred<CanonicalBillingSync>();
    clients.backend.syncBilling.mockReturnValueOnce(verification.promise);
    const retry = useAccessStore
      .getState()
      .retryPendingFulfilment({ automatic: true });
    await flush();
    await useAccessStore.getState().retryPendingFulfilment({ automatic: true });
    await useAccessStore.getState().initialize();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    verification.reject(new Error('still offline'));
    await retry;
    await useAccessStore.getState().retryPendingFulfilment({ automatic: true });
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    await expect(
      useAccessStore.getState().retryPendingFulfilment(),
    ).resolves.toBe(true);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(3);
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
    expect(clients.store.restore).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});

async function sqliteStorage() {
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
  return { db, execute, storage: createPendingFulfilmentStorage(() => db) };
}

describe('pending fulfilment storage contract', () => {
  it('validates schema, owner, size, and lifecycle consistency without persisting entitlement or session material', () => {
    const record = createPendingFulfilment(OWNER_A, 'purchase');
    expect(parsePendingFulfilment(JSON.stringify(record), OWNER_A)).toEqual(
      record,
    );
    expect(parsePendingFulfilment(null, OWNER_A)).toBeNull();
    expect(pendingFulfilmentKeyForOwner(` ${OWNER_A.toUpperCase()} `)).toBe(
      `billing.pending-fulfilment:${OWNER_A}`,
    );
    for (const raw of [
      '',
      '{',
      '[]',
      'null',
      'x'.repeat(PENDING_FULFILMENT_MAX_LENGTH + 1),
      JSON.stringify({ ...record, owner: OWNER_B }),
      JSON.stringify({ ...record, schemaVersion: 2 }),
      JSON.stringify({ ...record, state: 'verified' }),
      JSON.stringify({ ...record, source: 'automatic-restore' }),
      JSON.stringify({ ...record, id: 'not-an-operation-id' }),
      JSON.stringify({ ...record, completedAtMs: -1 }),
      JSON.stringify({ ...record, attempts: 1 }),
      JSON.stringify({ ...record, attempts: 32, lastAttemptAtMs: Date.now() }),
      JSON.stringify({ ...record, attempts: 0, lastAttemptAtMs: Date.now() }),
    ]) {
      expect(() => parsePendingFulfilment(raw, OWNER_A)).toThrow(BillingError);
    }
    expect(() => pendingFulfilmentKeyForOwner('device-guest')).toThrow();
    const parsed = parsePendingFulfilment(
      JSON.stringify({
        ...record,
        premium: true,
        receipt: 'untrusted',
        bearerToken: 'not-a-credential',
      }),
      OWNER_A,
    );
    expect(parsed).toEqual(record);
  });

  it('caps automatic retry delay and recovers from a backwards wall clock without granting access', () => {
    const record = createPendingFulfilment(OWNER_A, 'purchase');
    expect(pendingFulfilmentRetryDue(record, 0)).toBe(true);
    const attempted = { ...record, attempts: 1, lastAttemptAtMs: 10_000 };
    expect(pendingFulfilmentRetryDue(attempted, 14_999)).toBe(false);
    expect(pendingFulfilmentRetryDue(attempted, 15_000)).toBe(true);
    expect(pendingFulfilmentRetryDue(attempted, 9_999)).toBe(true);
    expect(
      pendingFulfilmentRetryDue({ ...attempted, attempts: 2 }, 19_999),
    ).toBe(false);
    const capped = { ...attempted, attempts: 31 };
    expect(
      pendingFulfilmentRetryDue(
        capped,
        10_000 + PENDING_FULFILMENT_MAX_BACKOFF_MS - 1,
      ),
    ).toBe(false);
    expect(
      pendingFulfilmentRetryDue(
        capped,
        10_000 + PENDING_FULFILMENT_MAX_BACKOFF_MS,
      ),
    ).toBe(true);
  });

  it('isolates SQLite owner rows, rejects stale replacement/cleanup, and rehydrates from a new storage instance', async () => {
    const { db, storage } = await sqliteStorage();
    try {
      const a = createPendingFulfilment(OWNER_A, 'purchase');
      const b = createPendingFulfilment(OWNER_B, 'restore');
      await Promise.all([storage.write(a), storage.write(b)]);
      const attempted = { ...a, attempts: 1, lastAttemptAtMs: Date.now() };
      await storage.write(attempted);
      await expect(storage.write(a)).rejects.toBeInstanceOf(BillingError);
      await expect(
        storage.write(createPendingFulfilment(OWNER_A, 'restore')),
      ).rejects.toBeInstanceOf(BillingError);
      await expect(storage.remove(a)).rejects.toBeInstanceOf(BillingError);
      const restarted = createPendingFulfilmentStorage(() => db);
      expect(await restarted.read(OWNER_A)).toEqual(attempted);
      await restarted.remove(attempted);
      expect(await restarted.read(OWNER_A)).toBeNull();
      expect(await restarted.read(OWNER_B)).toEqual(b);
    } finally {
      db.close();
    }
  });

  it.each(['', '{', JSON.stringify({ schemaVersion: 1, owner: OWNER_B })])(
    'fails closed on a corrupt persisted row: %s',
    async raw => {
      const { db, storage } = await sqliteStorage();
      try {
        await db.execute('INSERT INTO kv(key, value) VALUES(?, ?)', [
          pendingFulfilmentKeyForOwner(OWNER_A),
          raw,
        ]);
        await expect(storage.read(OWNER_A)).rejects.toMatchObject({
          code: 'billing.backend_verification_pending',
          retryable: true,
        });
        await expect(
          storage.write(createPendingFulfilment(OWNER_A, 'purchase')),
        ).rejects.toBeInstanceOf(BillingError);
      } finally {
        db.close();
      }
    },
  );

  it('rolls back SQLite cleanup when the billing generation changes after DELETE but before commit', async () => {
    const { db, execute, storage } = await sqliteStorage();
    try {
      const first = dependencies();
      first.backend.syncBilling.mockRejectedValueOnce(new Error('offline'));
      configure(first, storage);
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().purchaseSelected();
      const gate = deferred<void>();
      const original = execute.getMockImplementation()!;
      execute.mockImplementation(async (sql, params) => {
        const result = await original(sql, params);
        if (sql.startsWith('DELETE')) await gate.promise;
        return result;
      });
      const verification = useAccessStore.getState().retryPendingFulfilment();
      for (let index = 0; index < 100; index += 1) await Promise.resolve();
      expect(execute.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(
        true,
      );
      configure(first, storage);
      gate.resolve();
      await expect(verification).resolves.toBe(false);
      expect((await storage.read(OWNER_A))?.source).toBe('purchase');
      expect(useAccessStore.getState().canonicalAccess).toBeNull();
      expect(execute.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('billing recovery generations and failures', () => {
  it('uses the dependency owner with a SQLite journal and no fulfilment-owner override', async () => {
    const { db, storage } = await sqliteStorage();
    const clients = dependencies();
    try {
      setActiveDataOwner(OWNER_A);
      configureAccessStore(
        { ...clients, canonicalAppUserId: OWNER_A },
        { pendingFulfilmentStorage: storage },
      );
      await useAccessStore.getState().initialize();
      expect(useAccessStore.getState().status).toBe('ready');
      await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
        true,
      );
      expect(await storage.read(OWNER_A)).toBeNull();
      expect(useAccessStore.getState().pendingFulfilment).toBeNull();
    } finally {
      discardPendingFulfilmentForOwner(OWNER_A);
      db.close();
    }
  });

  it('rejects a fulfilment-owner override that disagrees with the configured store account', async () => {
    const { storage } = durableStorage();
    const clients = dependencies();
    setActiveDataOwner(OWNER_B);
    configureAccessStore(
      { ...clients, canonicalAppUserId: OWNER_A },
      { owner: OWNER_B, pendingFulfilmentStorage: storage },
    );
    expect(useAccessStore.getState()).toMatchObject({
      status: 'unconfigured',
      canonicalAccess: null,
    });
    await useAccessStore.getState().restorePurchases();
    expect(clients.store.restore).not.toHaveBeenCalled();
    expect(clients.backend.syncBilling).not.toHaveBeenCalled();
  });

  it('cannot configure access for A under an active B data-owner context', async () => {
    const { storage } = durableStorage();
    const clients = dependencies();
    setActiveDataOwner(OWNER_B);
    configureAccessStore(
      { ...clients, canonicalAppUserId: OWNER_A },
      { pendingFulfilmentStorage: storage },
    );
    await useAccessStore.getState().initialize();
    expect(clients.store.configure).not.toHaveBeenCalled();
    expect(clients.backend.getAccess).not.toHaveBeenCalled();
    expect(useAccessStore.getState()).toMatchObject({
      operation: 'idle',
      canonicalAccess: null,
    });
  });

  it('does not report purchase success through a subscriber-triggered account change at publication', async () => {
    const { storage } = durableStorage();
    const first = dependencies();
    const second = dependencies();
    configure(first, storage);
    await useAccessStore.getState().initialize();
    const unsubscribe = useAccessStore.subscribe(state => {
      if (state.canonicalAccess?.premium) configure(second, storage, OWNER_B);
    });
    try {
      await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
        false,
      );
      expect(useAccessStore.getState().canonicalAccess).toBeNull();
      expect(second.backend.syncBilling).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('relaunch with SQLite data and no in-memory completion retries the backend and leaves another owner untouched', async () => {
    const { db, storage } = await sqliteStorage();
    try {
      const first = dependencies();
      first.backend.syncBilling.mockRejectedValueOnce(new Error('offline'));
      configure(first, storage);
      await useAccessStore.getState().initialize();
      await useAccessStore.getState().purchaseSelected();
      const other = createPendingFulfilment(OWNER_B, 'purchase');
      await storage.write(other);
      clearAccessStoreConfiguration();
      const restarted = dependencies();
      configure(
        restarted,
        createPendingFulfilmentStorage(() => db),
      );
      await useAccessStore.getState().initialize();
      expect(restarted.backend.syncBilling).toHaveBeenCalledTimes(1);
      expect(restarted.backend.getAccess).not.toHaveBeenCalled();
      expect(restarted.store.restore).not.toHaveBeenCalled();
      expect(restarted.store.purchase).not.toHaveBeenCalled();
      expect(await storage.read(OWNER_A)).toBeNull();
      expect(await storage.read(OWNER_B)).toEqual(other);
    } finally {
      db.close();
    }
  });

  it('preserves an unwritten completion across sign-out in the same process and never purchases twice', async () => {
    const { storage } = durableStorage();
    const first = dependencies();
    (storage.write as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
    configure(first, storage);
    await useAccessStore.getState().initialize();
    await useAccessStore.getState().purchaseSelected();
    expect(first.backend.syncBilling).not.toHaveBeenCalled();
    clearAccessStoreConfiguration();
    const next = dependencies();
    configure(next, storage);
    await useAccessStore.getState().initialize();
    expect(next.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(next.backend.getAccess).not.toHaveBeenCalled();
    expect(next.store.purchase).not.toHaveBeenCalled();
  });

  it('blocks store actions if recovery storage cannot be read, including after the error is dismissed', async () => {
    const { storage } = durableStorage();
    const clients = dependencies();
    (storage.read as jest.Mock).mockRejectedValue(
      new Error('database unavailable'),
    );
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    useAccessStore.getState().clearError();
    await useAccessStore.getState().purchaseSelected();
    await useAccessStore.getState().restorePurchases();
    expect(clients.store.purchase).not.toHaveBeenCalled();
    expect(clients.store.restore).not.toHaveBeenCalled();
    expect(clients.backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState()).toMatchObject({
      operation: 'idle',
      fulfilmentStatus: 'unavailable',
    });
    (storage.read as jest.Mock).mockResolvedValue(
      createPendingFulfilment(OWNER_A, 'purchase'),
    );
    await expect(
      useAccessStore.getState().retryPendingFulfilment(),
    ).resolves.toBe(true);
  });

  it('a data-owner A to B to A switch invalidates an in-flight response even without reconfiguring billing', async () => {
    const { records, storage } = durableStorage();
    const clients = dependencies();
    const verification = deferred<CanonicalBillingSync>();
    clients.backend.syncBilling.mockReturnValueOnce(verification.promise);
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    const purchase = useAccessStore.getState().purchaseSelected();
    await flush();
    setActiveDataOwner(OWNER_B);
    setActiveDataOwner(OWNER_A);
    verification.resolve(synced());
    await expect(purchase).resolves.toBe(false);
    expect(records.has(OWNER_A)).toBe(true);
    expect(useAccessStore.getState()).toMatchObject({
      status: 'idle',
      operation: 'idle',
      canonicalAccess: null,
    });
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('holds the native single flight across reconfiguration of the same owner', async () => {
    const { records, storage } = durableStorage();
    const first = dependencies();
    const completion = deferred<StoreEntitlementState>();
    first.store.purchase.mockReturnValueOnce(completion.promise);
    configure(first, storage);
    await useAccessStore.getState().initialize();
    const purchase = useAccessStore.getState().purchaseSelected();
    await flush();
    const next = dependencies();
    configure(next, storage);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expect(next.store.purchase).not.toHaveBeenCalled();
    completion.resolve(storeEntitlement);
    await expect(purchase).resolves.toBe(false);
    expect(records.has(OWNER_A)).toBe(true);
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expect(next.store.purchase).not.toHaveBeenCalled();
    await expect(
      useAccessStore.getState().retryPendingFulfilment(),
    ).resolves.toBe(true);
    expect(next.backend.syncBilling).toHaveBeenCalledTimes(1);
  });

  it('prevents late completion from recreating the marker after the confirmed-deletion invalidation hook', async () => {
    const { records, storage } = durableStorage();
    const clients = dependencies();
    const completion = deferred<StoreEntitlementState>();
    clients.store.purchase.mockReturnValueOnce(completion.promise);
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    const purchase = useAccessStore.getState().purchaseSelected();
    await flush();
    discardPendingFulfilmentForOwner(OWNER_A);
    records.delete(OWNER_A);
    completion.resolve(storeEntitlement);
    await expect(purchase).resolves.toBe(false);
    expect(records.size).toBe(0);
    expect(storage.write).not.toHaveBeenCalled();
    expect(clients.backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
  });

  it('uses persisted backoff after a storage-instance restart, while manual retry can bypass the delay', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-09-06T00:00:00.000Z') });
    const { storage } = durableStorage();
    const first = dependencies();
    first.backend.syncBilling.mockRejectedValueOnce(new Error('offline'));
    configure(first, storage);
    await useAccessStore.getState().initialize();
    await useAccessStore.getState().purchaseSelected();
    clearAccessStoreConfiguration();
    const next = dependencies();
    configure(next, { ...storage });
    await useAccessStore.getState().retryPendingFulfilment({ automatic: true });
    expect(next.backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState().operation).toBe('idle');
    await expect(
      useAccessStore.getState().retryPendingFulfilment(),
    ).resolves.toBe(true);
    expect(next.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(next.store.configure).not.toHaveBeenCalled();
  });

  it('retains completion through a transient 401 and uses the rotated owner-bound bearer without resetting billing', async () => {
    const { records, storage } = durableStorage();
    const clients = dependencies();
    const report = jest
      .spyOn(apiSession, 'reportApiUnauthorized')
      .mockImplementation(() => undefined);
    const session = {
      apiBaseUrl: 'https://api.example.test',
      canonicalAppUserId: OWNER_A,
      provider: 'apple' as const,
      bearerToken: 'expired-access-token',
    };
    apiSession.establishApiSession(session);
    const fetchFn = jest.fn(async (url: string, init?: RequestInit) => {
      const unauthorized =
        url.endsWith('/v1/billing/sync') &&
        (init?.headers as Record<string, string>).Authorization ===
          'Bearer expired-access-token';
      return {
        ok: !unauthorized,
        status: unauthorized ? 401 : 200,
        json: async () =>
          url.endsWith('/v1/me/access') ? freeAccess : synced(),
      } as Response;
    });
    const backend = createCanonicalAccessClient({
      baseUrl: session.apiBaseUrl,
      get token() {
        return apiSession.bearerTokenFor(OWNER_A);
      },
      fetchFn,
    });
    try {
      configure({ ...clients, backend }, storage);
      await useAccessStore.getState().initialize();
      await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
        false,
      );
      const id = useAccessStore.getState().pendingFulfilment?.id;
      expect(records.has(OWNER_A)).toBe(true);
      expect(report).toHaveBeenCalledWith('expired-access-token');
      expect(apiSession.getApiSession()?.canonicalAppUserId).toBe(OWNER_A);
      apiSession.establishApiSession({
        ...session,
        bearerToken: 'rotated-access-token',
      });
      await expect(
        useAccessStore.getState().retryPendingFulfilment(),
      ).resolves.toBe(true);
      expect(fetchFn.mock.calls[2]?.[1]?.headers).toMatchObject({
        Authorization: 'Bearer rotated-access-token',
      });
      expect((storage.remove as jest.Mock).mock.calls[0]?.[0].id).toBe(id);
      expect(clients.store.purchase).toHaveBeenCalledTimes(1);
      expect(clients.store.restore).not.toHaveBeenCalled();
      expect(records.size).toBe(0);
    } finally {
      apiSession.clearApiSession();
    }
  });
});

describe('backend-only billing lifecycle', () => {
  beforeEach(() =>
    jest.useFakeTimers({ now: Date.parse('2026-09-06T00:00:00Z') }),
  );

  it('verifies a paid account at cold start without a marker, SDK calls, or a new purchase', async () => {
    const { records, storage } = durableStorage();
    const clients = dependencies();
    configure(clients, storage);
    const reconcile = createBillingLifecycleCallback(OWNER_A);
    await expect(reconcile()).resolves.toBe(true);
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(useAccessStore.getState().reconciliation.status).toBe('verified');
    expect(records.size).toBe(0);
    expect(storage.write).not.toHaveBeenCalled();
    for (const method of Object.values(clients.store))
      expect(method).not.toHaveBeenCalled();
    await reconcile();
    await reconcile();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
  });

  it('coalesces startup reconciliation requested while pricing initialization is still running', async () => {
    const { storage } = durableStorage();
    const clients = dependencies();
    const accessRead = deferred<CanonicalAccessState>();
    clients.backend.getAccess.mockReturnValueOnce(accessRead.promise);
    configure(clients, storage);
    const initialize = useAccessStore.getState().initialize();
    const reconcile = createBillingLifecycleCallback(OWNER_A);
    await reconcile();
    await reconcile();
    expect(clients.backend.syncBilling).not.toHaveBeenCalled();
    accessRead.resolve(freeAccess);
    await initialize;
    await flush();
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(clients.store.purchase).not.toHaveBeenCalled();
    expect(clients.store.restore).not.toHaveBeenCalled();
  });

  it('drops a queued startup callback when the account changes before initialization completes', async () => {
    const { storage } = durableStorage();
    const first = dependencies();
    const accessRead = deferred<CanonicalAccessState>();
    first.backend.getAccess.mockReturnValueOnce(accessRead.promise);
    configure(first, storage);
    const initialize = useAccessStore.getState().initialize();
    await flush();
    await createBillingLifecycleCallback(OWNER_A)();
    const next = dependencies();
    configure(next, storage, OWNER_B);
    accessRead.resolve(freeAccess);
    await initialize;
    await flush();
    expect(first.backend.syncBilling).not.toHaveBeenCalled();
    expect(next.backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
  });

  it('recovers after process loss following a failed first postpurchase journal write', async () => {
    const { records, storage } = durableStorage();
    const first = dependencies();
    (storage.write as jest.Mock).mockRejectedValueOnce(
      new Error('disk full after payment'),
    );
    configure(first, storage);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expect(first.store.purchase).toHaveBeenCalledTimes(1);
    expect(first.backend.syncBilling).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
    clearAccessStoreConfiguration();
    const next = dependencies();
    configure(next, { ...storage });
    await expect(createBillingLifecycleCallback(OWNER_A)()).resolves.toBe(true);
    expect(next.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(next.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(next.store.purchase).not.toHaveBeenCalled();
    expect(next.store.restore).not.toHaveBeenCalled();
    expect(useAccessStore.getState().pendingFulfilment).toBeNull();
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
  });

  it('keeps valid free access on optional verification failure, backs off, and permits explicit backend retry', async () => {
    const { storage } = durableStorage();
    const clients = dependencies();
    const allowance = {
      ...freeAccess,
      freeRatings: {
        limit: 2 as const,
        used: 0,
        reserved: 0,
        remaining: 2,
        availableToReserve: 2,
      },
      canStartRating: true,
      paywallRequired: false,
    };
    clients.backend.getAccess.mockResolvedValue(allowance);
    clients.backend.syncBilling.mockRejectedValueOnce(
      new Error('RevenueCat unavailable'),
    );
    configure(clients, storage);
    const reconcile = createBillingLifecycleCallback(OWNER_A);
    await expect(reconcile()).resolves.toBe(false);
    expect(useAccessStore.getState()).toMatchObject({
      status: 'ready',
      operation: 'idle',
      canonicalAccess: allowance,
      error: null,
      reconciliation: { status: 'unavailable', error: { retryable: true } },
    });
    await reconcile();
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_RETRY_MS - 1);
    await reconcile();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    await expect(
      useAccessStore.getState().reconcileBilling({ force: true }),
    ).resolves.toBe(true);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(clients.store.purchase).not.toHaveBeenCalled();
    expect(clients.store.restore).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ends optional body-read stalls without losing the verified free allowance', async () => {
    const { storage } = durableStorage();
    const clients = dependencies();
    const body = deferred<unknown>();
    const allowance = {
      ...freeAccess,
      freeRatings: {
        limit: 2 as const,
        used: 1,
        reserved: 0,
        remaining: 1,
        availableToReserve: 1,
      },
      canStartRating: true,
      paywallRequired: false,
    };
    const backend = createCanonicalAccessClient({
      baseUrl: 'https://api.example.test',
      token: 'access-token',
      fetchFn: async url =>
        ({
          ok: true,
          status: 200,
          json: () =>
            url.endsWith('/v1/me/access')
              ? Promise.resolve(allowance)
              : body.promise,
        }) as Response,
    });
    configure({ ...clients, backend }, storage);
    const request = createBillingLifecycleCallback(OWNER_A)();
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(request).resolves.toBe(false);
    expect(useAccessStore.getState()).toMatchObject({
      status: 'ready',
      operation: 'idle',
      canonicalAccess: allowance,
      error: null,
      reconciliation: { status: 'unavailable' },
    });
    body.resolve(synced());
    await flush();
    expect(useAccessStore.getState().canonicalAccess).toEqual(allowance);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reconciles renewal and expiry mismatches on the bounded foreground interval, never from SDK indications', async () => {
    const { storage } = durableStorage();
    const clients = dependencies();
    clients.backend.syncBilling.mockResolvedValueOnce(synced(false));
    configure(clients, storage);
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: premiumAccess,
    });
    const reconcile = createBillingLifecycleCallback(OWNER_A);
    await expect(reconcile()).resolves.toBe(false);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
    expect(clients.store.readEntitlement).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_INTERVAL_MS - 1);
    await reconcile();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(reconcile()).resolves.toBe(true);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    expect(clients.backend.getAccess).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess).toEqual(premiumAccess);
    expect(clients.store.restore).not.toHaveBeenCalled();
    expect(clients.store.purchase).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'cancels a captured lifecycle callback across reconfiguration, same owner=%s',
    async sameOwner => {
      const { storage } = durableStorage();
      const first = dependencies();
      const verification = deferred<CanonicalBillingSync>();
      first.backend.syncBilling.mockReturnValueOnce(verification.promise);
      configure(first, storage);
      const oldCallback = createBillingLifecycleCallback(OWNER_A);
      const pending = oldCallback();
      await flush();
      const next = dependencies();
      configure(next, storage, sameOwner ? OWNER_A : OWNER_B);
      await expect(oldCallback()).resolves.toBe(false);
      verification.resolve(synced());
      await expect(pending).resolves.toBe(false);
      expect(next.backend.getAccess).not.toHaveBeenCalled();
      expect(next.backend.syncBilling).not.toHaveBeenCalled();
      expect(useAccessStore.getState().canonicalAccess).toBeNull();
    },
  );

  it('loads a fresh access snapshot after reconfiguration without bypassing the per-owner verification cooldown', async () => {
    const { storage } = durableStorage();
    const first = dependencies();
    first.backend.syncBilling.mockResolvedValueOnce(synced(false));
    configure(first, storage);
    await createBillingLifecycleCallback(OWNER_A)();
    const next = dependencies();
    configure(next, storage);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    await createBillingLifecycleCallback(OWNER_A)();
    expect(next.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(next.backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
  });

  it('keeps one backend verification in flight even when its owner is reconfigured', async () => {
    const { storage } = durableStorage();
    const first = dependencies();
    const verification = deferred<CanonicalBillingSync>();
    first.backend.syncBilling.mockReturnValueOnce(verification.promise);
    configure(first, storage);
    const pending = createBillingLifecycleCallback(OWNER_A)();
    await flush();
    const next = dependencies();
    configure(next, storage);
    const callback = createBillingLifecycleCallback(OWNER_A);
    await callback();
    expect(next.backend.syncBilling).not.toHaveBeenCalled();
    verification.resolve(synced());
    await pending;
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(callback()).resolves.toBe(true);
    expect(next.backend.syncBilling).toHaveBeenCalledTimes(1);
  });

  it('keeps paid pending recovery explicit and retries it sooner than the optional renewal interval', async () => {
    const { records, storage } = durableStorage();
    const clients = dependencies();
    clients.backend.syncBilling.mockResolvedValueOnce(synced(false));
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    await useAccessStore.getState().purchaseSelected();
    expect(records.has(OWNER_A)).toBe(true);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(false);
    expect(
      selectBillingReconciliationRetryAtMs(useAccessStore.getState()),
    ).toBe(Date.now() + BILLING_RECONCILIATION_RETRY_MS);
    const reconcile = createBillingLifecycleCallback(OWNER_A);
    await reconcile();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_RETRY_MS);
    await expect(reconcile()).resolves.toBe(true);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
    expect(clients.store.restore).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
  });

  it('bounds exponential optional retry backoff and never retries merely because an event repeats', async () => {
    const { storage } = durableStorage();
    const clients = dependencies();
    clients.backend.syncBilling.mockRejectedValue(
      new Error('provider unavailable'),
    );
    configure(clients, storage);
    const reconcile = createBillingLifecycleCallback(OWNER_A);
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await reconcile();
      expect(clients.backend.syncBilling).toHaveBeenCalledTimes(attempt);
      const delay = Math.min(
        BILLING_RECONCILIATION_RETRY_MS * 2 ** (attempt - 1),
        BILLING_RECONCILIATION_INTERVAL_MS,
      );
      const state = useAccessStore.getState();
      expect(state.reconciliation.nextAttemptAtMs).toBe(Date.now() + delay);
      expect(selectBillingReconciliationRetryAtMs(state)).toBe(
        Date.now() + delay,
      );
      expect(
        selectBillingReconciliationRetryAtMs(
          state,
          state.reconciliation.lastAttemptAtMs! - 1,
        ),
      ).toBe(0);
      expect(state.canonicalAccess).toEqual(freeAccess);
      await reconcile();
      await jest.advanceTimersByTimeAsync(delay - 1);
      await reconcile();
      expect(clients.backend.syncBilling).toHaveBeenCalledTimes(attempt);
      await jest.advanceTimersByTimeAsync(1);
    }
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(clients.store.configure).not.toHaveBeenCalled();
    expect(clients.store.restore).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('backs off failed initial access reads rather than looping without a verified bearer', async () => {
    const { storage } = durableStorage();
    const clients = dependencies();
    clients.backend.getAccess.mockRejectedValueOnce(
      new BillingError(
        'billing.backend_unconfigured',
        'Waiting for account connection',
        true,
        'missing_api_token',
      ),
    );
    configure(clients, storage);
    const reconcile = createBillingLifecycleCallback(OWNER_A);
    await reconcile();
    await reconcile();
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(clients.backend.syncBilling).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_RETRY_MS);
    await expect(reconcile()).resolves.toBe(true);
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(2);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
  });
});

describe('bounded membership operations', () => {
  beforeEach(() => jest.useFakeTimers());

  it.each(['configure', 'loadPlans'] as const)(
    'bounds a stalled store %s without erasing a verified free allowance',
    async method => {
      const { storage } = durableStorage();
      const clients = dependencies();
      (clients.store[method] as jest.Mock).mockReturnValueOnce(
        new Promise(() => {}),
      );
      configure(clients, storage);
      const initialization = useAccessStore.getState().initialize();
      await jest.advanceTimersByTimeAsync(10_000);
      await initialization;
      expect(useAccessStore.getState()).toMatchObject({
        operation: 'idle',
        canonicalAccess: freeAccess,
        error: { retryable: true },
      });
      expect(useAccessStore.getState().status).not.toBe('loading');
      expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
      expect(clients.store.purchase).not.toHaveBeenCalled();
      expect(clients.store.restore).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each(['read', 'write', 'remove'] as const)(
    'ends busy state after storage %s stalls and never claims fulfillment',
    async method => {
      const { records, storage } = durableStorage();
      const clients = dependencies();
      configure(clients, storage);
      if (method !== 'read') await useAccessStore.getState().initialize();
      (storage[method] as jest.Mock).mockReturnValueOnce(new Promise(() => {}));
      const request =
        method === 'read'
          ? useAccessStore.getState().initialize()
          : useAccessStore.getState().purchaseSelected();
      await jest.advanceTimersByTimeAsync(10_000);
      await request;
      expect(useAccessStore.getState()).toMatchObject({
        operation: 'idle',
        canonicalAccess: null,
        error: { retryable: true },
      });
      expect(useAccessStore.getState().status).not.toBe('loading');
      if (method !== 'read')
        expect(useAccessStore.getState().pendingFulfilment?.owner).toBe(
          OWNER_A,
        );
      if (method === 'remove') expect(records.has(OWNER_A)).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('does not recreate a fulfilled marker when an initial storage write resolves after a timeout and successful retry', async () => {
    const { records, storage } = durableStorage();
    const clients = dependencies();
    const gate = deferred<void>();
    const original = (storage.write as jest.Mock).getMockImplementation()!;
    (storage.write as jest.Mock).mockImplementationOnce(
      async (record, assertActive) => {
        await gate.promise;
        return original(record, assertActive);
      },
    );
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    const purchase = useAccessStore.getState().purchaseSelected();
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(purchase).resolves.toBe(false);
    await expect(
      useAccessStore.getState().retryPendingFulfilment(),
    ).resolves.toBe(true);
    expect(records.size).toBe(0);
    gate.resolve();
    await flush();
    expect(records.size).toBe(0);
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    'syncBilling',
    'purchaseSelected',
    'restorePurchases',
    'retryPendingFulfilment',
  ] as const)(
    'resets %s after an unexpected synchronous backend throw',
    async operation => {
      const { storage } = durableStorage();
      const clients = dependencies();
      clients.backend.syncBilling.mockImplementation(() => {
        throw new Error('synchronous backend failure');
      });
      configure(clients, storage);
      await useAccessStore.getState().initialize();
      if (operation === 'retryPendingFulfilment')
        await useAccessStore.getState().purchaseSelected();
      await expect(useAccessStore.getState()[operation]()).resolves.toBe(false);
      expect(useAccessStore.getState()).toMatchObject({
        operation: 'idle',
        status: 'error',
        error: { retryable: true },
      });
      if (operation !== 'syncBilling')
        expect(useAccessStore.getState().pendingFulfilment?.owner).toBe(
          OWNER_A,
        );
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each([
    'initialize',
    'refreshAccess',
    'syncBilling',
    'purchaseSelected',
    'restorePurchases',
  ] as const)(
    '%s resets busy after a stalled response body and ignores a late premium body',
    async operation => {
      const { records, storage } = durableStorage();
      const clients = dependencies();
      const body = deferred<unknown>();
      let stalled = false;
      const backend = createCanonicalAccessClient({
        baseUrl: 'https://api.example.test',
        token: 'access-token',
        fetchFn: async url =>
          ({
            ok: true,
            status: 200,
            json: () =>
              stalled
                ? body.promise
                : Promise.resolve(
                    url.endsWith('/v1/me/access') ? freeAccess : synced(),
                  ),
          }) as Response,
      });
      configure({ ...clients, backend }, storage);
      if (operation !== 'initialize')
        await useAccessStore.getState().initialize();
      stalled = true;
      let settled = false;
      const run = useAccessStore.getState()[operation];
      const request = run().then(() => {
        settled = true;
      });
      await flush();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(true);
      await request;
      expect(useAccessStore.getState()).toMatchObject({
        operation: 'idle',
        status: 'error',
        canonicalAccess: null,
        error: { retryable: true },
      });
      if (
        operation === 'purchaseSelected' ||
        operation === 'restorePurchases'
      ) {
        expect(records.has(OWNER_A)).toBe(true);
      }
      body.resolve(
        operation === 'initialize' || operation === 'refreshAccess'
          ? premiumAccess
          : synced(),
      );
      await flush();
      expect(selectHasPremium(useAccessStore.getState())).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
});
