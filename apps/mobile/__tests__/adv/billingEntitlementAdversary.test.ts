// INT-billing-entitlement adversary (attacked head
// 30a4065036a917514fb4984fde73f87867f38619). Mobile-side attacks on the
// durable purchase-recovery loop: what the device does when the backend's
// disposition never settles, when the backend contradicts itself, when the
// store hands back odd transaction shapes, and when the user double-acts.
import { createCanonicalAccessClient } from '../../src/billing/accessApi';
import {
  parseBillingTransaction,
  type BillingAccessDependencies,
  type BillingFulfilmentRequest,
  type CanonicalAccessState,
  type CanonicalBillingSync,
  type StoreEntitlementState,
  type StorePlans,
} from '../../src/billing/types';
import {
  type PendingFulfilment,
  type PendingFulfilmentStorage,
} from '../../src/billing/pendingFulfilment';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const MONTHLY = 'pickle_sensei_pro_monthly';

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
  entitlements: ['premium', 'pickle_sensei_pro'],
  canStartRating: true,
  paywallRequired: false,
};
const transaction = {
  productId: MONTHLY,
  transactionId: '1000000652379790',
  purchasedAt: '2026-08-01T12:34:56.000Z',
};
const storeEntitlement: StoreEntitlementState = {
  premium: true,
  productId: MONTHLY,
  expirationDate: '2027-09-01T12:34:56.000Z',
  transaction,
};
const plans: StorePlans = {
  offeringId: 'default',
  monthly: {
    id: 'monthly-plan',
    productId: MONTHLY,
    period: 'monthly',
    price: 7.99,
    priceString: '$7.99',
    pricePerMonthString: '$7.99',
    freeTrial: null,
  },
  annual: null,
  lifetime: null,
};

function synced(premium: boolean): CanonicalBillingSync {
  return {
    billing: {
      premium,
      productKey: premium ? MONTHLY : null,
      expiresAt: premium ? storeEntitlement.expirationDate : null,
      verifiedAt: '2026-09-08T00:00:00.000Z',
    },
    access: premium ? premiumAccess : freeAccess,
  };
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
      if (records.get(record.owner) === JSON.stringify(record))
        records.delete(record.owner);
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
        synced(true),
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

beforeEach(() => {
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});
afterEach(() => {
  clearAccessStoreConfiguration();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.restoreAllMocks();
});

describe('INT-billing-entitlement mobile adversary', () => {
  it('ADV-M1 a purchase whose backend disposition never settles (pending, not premium) blocks BOTH Continue and Restore on every relaunch — there is no user exit from the loop', async () => {
    const { storage, records } = durableStorage();
    const first = dependencies();
    // Mirrors the head's /v1/billing/sync answer once RevenueCat's latest
    // transaction for the product has been replaced by a renewal and the
    // subscription then lapsed (Deno ADV-3): billing.premium=false with the
    // fulfilment stuck at "pending".
    first.backend.syncBilling.mockImplementation(async request => ({
      ...synced(false),
      ...(request
        ? {
            fulfilment: {
              ...request,
              outcome: 'pending' as const,
              verifiedAt: '2026-09-08T00:00:00.000Z',
            },
          }
        : {}),
    }));
    configure(first, storage);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expect(first.store.purchase).toHaveBeenCalledTimes(1);
    expect(records.has(OWNER_A)).toBe(true);

    for (let relaunch = 0; relaunch < 3; relaunch += 1) {
      clearAccessStoreConfiguration();
      const again = dependencies();
      again.backend.syncBilling.mockImplementation(
        first.backend.syncBilling.getMockImplementation()!,
      );
      configure(again, storage);
      await useAccessStore.getState().initialize();
      await expect(
        useAccessStore.getState().retryPendingFulfilment(),
      ).resolves.toBe(false);
      await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
        false,
      );
      await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
        false,
      );
      expect(again.store.purchase).not.toHaveBeenCalled();
      expect(again.store.restore).not.toHaveBeenCalled();
      expect(useAccessStore.getState().error?.code).toBe(
        'billing.backend_verification_pending',
      );
    }
    const record = await storage.read(OWNER_A);
    expect(record).toMatchObject({ schemaVersion: 2, transaction });
    expect(record?.attempts).toBeGreaterThanOrEqual(4);
  });

  it('ADV-M2 the device sends StoreKit evidence normalised to millisecond ISO and a numeric-looking id verbatim; a non-string id from the SDK drops the evidence entirely', () => {
    expect(
      parseBillingTransaction({
        productId: MONTHLY,
        transactionId: '1000000652379790',
        purchasedAt: '2026-08-01T12:34:56Z',
      }),
    ).toEqual(transaction);
    expect(
      parseBillingTransaction({
        productId: MONTHLY,
        transactionId: '1000000652379790',
        purchasedAt: '2026-08-01T14:34:56.417+02:00',
      }),
    ).toEqual({ ...transaction, purchasedAt: '2026-08-01T12:34:56.417Z' });
    expect(
      parseBillingTransaction({
        productId: MONTHLY,
        transactionId: 1000000652379790,
        purchasedAt: '2026-08-01T12:34:56Z',
      }),
    ).toBeNull();
    expect(
      parseBillingTransaction({
        productId: MONTHLY,
        transactionId: '1e15',
        purchasedAt: '2026-08-01T12:34:56Z',
      }),
    ).toEqual({ ...transaction, transactionId: '1e15' });
  });

  it('ADV-M3 a backend body whose fulfilment says fulfilled while billing/access disagree on premium is rejected, and the durable record survives for the next honest answer', async () => {
    const { storage, records } = durableStorage();
    const clients = dependencies();
    let mode: 'contradiction' | 'honest' = 'contradiction';
    const fetchFn = jest.fn(async (url: string, init?: RequestInit) => {
      const request = init?.body
        ? (JSON.parse(String(init.body)) as {
            fulfilment?: BillingFulfilmentRequest;
          })
        : {};
      const body: unknown = url.endsWith('/v1/me/access')
        ? freeAccess
        : mode === 'contradiction'
          ? {
              billing: synced(true).billing,
              access: freeAccess,
              ...(request.fulfilment
                ? {
                    fulfilment: {
                      ...request.fulfilment,
                      outcome: 'fulfilled',
                      verifiedAt: '2026-09-08T00:00:00.000Z',
                    },
                  }
                : {}),
            }
          : {
              ...synced(true),
              ...(request.fulfilment
                ? {
                    fulfilment: {
                      ...request.fulfilment,
                      outcome: 'fulfilled',
                      verifiedAt: '2026-09-08T00:00:00.000Z',
                    },
                  }
                : {}),
            };
      return { ok: true, status: 200, json: async () => body } as Response;
    });
    const backend = createCanonicalAccessClient({
      baseUrl: 'https://api.example.test',
      token: 'access-token',
      fetchFn,
    });
    configure({ ...clients, backend }, storage);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expect(useAccessStore.getState().canonicalAccess?.premium ?? false).toBe(
      false,
    );
    expect(records.has(OWNER_A)).toBe(true);

    mode = 'honest';
    await expect(
      useAccessStore.getState().retryPendingFulfilment(),
    ).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(records.has(OWNER_A)).toBe(false);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
  });

  it('ADV-M4 a terminal disposition (expired/refunded) whose verifiedAt predates the purchase is not trusted: the record stays, premium is not fabricated, nothing is re-charged', async () => {
    const { storage, records } = durableStorage();
    const clients = dependencies();
    clients.backend.syncBilling.mockImplementation(async request => ({
      ...synced(false),
      ...(request
        ? {
            fulfilment: {
              ...request,
              outcome: 'refunded' as const,
              verifiedAt: '2026-08-01T12:34:55.999Z',
            },
          }
        : {}),
    }));
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    await expect(
      useAccessStore.getState().retryPendingFulfilment(),
    ).resolves.toBe(false);
    expect(records.has(OWNER_A)).toBe(true);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(false);
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.backend_verification_pending',
    );
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
  });

  it('ADV-M5 double-tap: concurrent Continue + Restore reach the store once, and a second account cannot see or clear the first account\u2019s pending purchase', async () => {
    const { storage, records } = durableStorage();
    const clients = dependencies();
    let release: (() => void) | null = null;
    clients.store.purchase.mockImplementation(
      () =>
        new Promise<StoreEntitlementState>(resolve => {
          release = () => resolve(storeEntitlement);
        }),
    );
    clients.backend.syncBilling.mockImplementation(async request => ({
      ...synced(false),
      ...(request
        ? {
            fulfilment: {
              ...request,
              outcome: 'pending' as const,
              verifiedAt: '2026-09-08T00:00:00.000Z',
            },
          }
        : {}),
    }));
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    const firstTap = useAccessStore.getState().purchaseSelected();
    const secondTap = useAccessStore.getState().purchaseSelected();
    const restoreTap = useAccessStore.getState().restorePurchases();
    await expect(secondTap).resolves.toBe(false);
    await expect(restoreTap).resolves.toBe(false);
    for (let spin = 0; release === null && spin < 50; spin += 1)
      await new Promise(resolve => setTimeout(resolve, 0));
    expect(release).not.toBeNull();
    release!();
    await expect(firstTap).resolves.toBe(false);
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
    expect(clients.store.restore).not.toHaveBeenCalled();
    expect(records.has(OWNER_A)).toBe(true);

    clearAccessStoreConfiguration();
    const other = dependencies();
    other.backend.syncBilling.mockImplementation(async request => ({
      ...synced(true),
      ...(request
        ? {
            fulfilment: {
              ...request,
              outcome: 'fulfilled' as const,
              verifiedAt: '2026-09-08T00:00:00.000Z',
            },
          }
        : {}),
    }));
    configure(other, storage, OWNER_B);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().pendingFulfilment).toBeNull();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    expect(other.store.purchase).toHaveBeenCalledTimes(1);
    expect(records.has(OWNER_A)).toBe(true);
    expect(records.has(OWNER_B)).toBe(false);
    expect((await storage.read(OWNER_A))?.owner).toBe(OWNER_A);
  });

  it('ADV-M6 corrupted persisted state: a record whose transaction lost its purchase date fails closed — no store call, no fabricated recovery, and it stays failed after relaunch', async () => {
    const { storage, records } = durableStorage();
    const clients = dependencies();
    clients.backend.syncBilling.mockResolvedValue(synced(false));
    configure(clients, storage);
    await useAccessStore.getState().initialize();
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    const raw = JSON.parse(records.get(OWNER_A)!) as Omit<
      PendingFulfilment,
      'transaction'
    > & {
      transaction: {
        productId: string;
        transactionId: string;
        purchasedAt?: string;
      };
    };
    delete raw.transaction.purchasedAt;
    records.set(OWNER_A, JSON.stringify(raw));

    for (let relaunch = 0; relaunch < 2; relaunch += 1) {
      clearAccessStoreConfiguration();
      const again = dependencies();
      configure(again, storage);
      await useAccessStore.getState().initialize();
      expect(useAccessStore.getState().fulfilmentStatus).toBe('unavailable');
      await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
        false,
      );
      await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
        false,
      );
      expect(again.store.purchase).not.toHaveBeenCalled();
      expect(again.store.restore).not.toHaveBeenCalled();
      expect(again.backend.syncBilling).not.toHaveBeenCalled();
      expect(useAccessStore.getState().canonicalAccess?.premium ?? false).toBe(
        false,
      );
    }
    expect(records.has(OWNER_A)).toBe(true);
  });
});
