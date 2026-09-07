import { AppState, type AppStateStatus } from 'react-native';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  startBillingLifecycle,
  stopBillingLifecycle,
} from '../src/billing/lifecycle';
import { BILLING_REQUEST_TIMEOUT_MS } from '../src/billing/accessApi';
import {
  createPendingFulfilment,
  type PendingFulfilment,
  type PendingFulfilmentStorage,
} from '../src/billing/pendingFulfilment';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  CanonicalBillingSync,
  StorePlans,
} from '../src/billing/types';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  BILLING_RECONCILIATION_INTERVAL_MS,
  BILLING_RECONCILIATION_RETRY_MS,
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectBillingReconciliationRetryAtMs,
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
const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual',
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
      productKey: premium ? 'pickle_sensei_pro_annual' : null,
      expiresAt: null,
      verifiedAt: new Date().toISOString(),
    },
    access: premium ? premiumAccess : freeAccess,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function ports() {
  const records = new Map<string, PendingFulfilment>();
  const storage = {
    read: jest.fn(async (owner: string) => records.get(owner) ?? null),
    write: jest.fn(
      async (record: PendingFulfilment, assertActive?: () => void) => {
        assertActive?.();
        records.set(record.owner, { ...record });
      },
    ),
    remove: jest.fn(
      async (record: PendingFulfilment, assertActive?: () => void) => {
        assertActive?.();
        records.delete(record.owner);
      },
    ),
  } satisfies PendingFulfilmentStorage;
  const entitlement = {
    premium: true,
    productId: 'pickle_sensei_pro_annual',
    expirationDate: null,
  };
  const clients = {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async () => entitlement),
      restore: jest.fn(async () => entitlement),
      readEntitlement: jest.fn(async () => entitlement),
    },
    backend: {
      getAccess: jest.fn(async () => freeAccess),
      syncBilling: jest.fn(async () => synced()),
    },
  } satisfies BillingAccessDependencies;
  return { clients, storage, records };
}

function installSession(owner = OWNER_A) {
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.example.test',
    bearerToken: `access-${owner}`,
    canonicalAppUserId: owner,
    provider: 'apple',
  });
}

function configure(
  clients: BillingAccessDependencies,
  storage: PendingFulfilmentStorage,
  owner = OWNER_A,
) {
  installSession(owner);
  configureAccessStore(clients, { owner, pendingFulfilmentStorage: storage });
}

async function flush() {
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
}

type ChangeListener = (state: AppStateStatus) => void;
const listeners = new Set<ChangeListener>();
const originalAppState = AppState.currentState;

function changeAppState(state: AppStateStatus) {
  AppState.currentState = state;
  for (const listener of [...listeners]) listener(state);
}

beforeEach(() => {
  jest.useFakeTimers({ now: Date.parse('2026-09-06T00:00:00Z') });
  AppState.currentState = 'active';
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((event, listener) => {
      expect(event).toBe('change');
      const change = listener as ChangeListener;
      listeners.add(change);
      return { remove: jest.fn(() => listeners.delete(change)) };
    });
});

afterEach(async () => {
  stopBillingLifecycle();
  clearAccessStoreConfiguration();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  await flush();
  expect(listeners.size).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
  AppState.currentState = originalAppState;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('billing lifecycle host with real access reconciliation', () => {
  it('waits for the matching API owner, then recovers a no-marker purchase without touching the store SDK', async () => {
    const { clients, storage, records } = ports();
    const timers = jest.spyOn(globalThis, 'setTimeout');
    setActiveDataOwner(OWNER_A);
    configureAccessStore(clients, {
      owner: OWNER_A,
      pendingFulfilmentStorage: storage,
    });
    startBillingLifecycle(OWNER_A);
    expect(listeners.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(storage.read).not.toHaveBeenCalled();

    installSession();
    startBillingLifecycle(OWNER_A);
    await flush();
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess).toEqual(premiumAccess);
    expect(records.size).toBe(0);
    expect(storage.write).not.toHaveBeenCalled();
    for (const method of Object.values(clients.store))
      expect(method).not.toHaveBeenCalled();
    expect(listeners.size).toBe(1);
    expect(jest.getTimerCount()).toBe(1);
    for (const [, delay] of timers.mock.calls) {
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
    }

    changeAppState('active');
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_INTERVAL_MS - 1);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('defers background startup and catches up once on foreground without leaving a background timer', async () => {
    const { clients, storage } = ports();
    AppState.currentState = 'background';
    configure(clients, storage);
    startBillingLifecycle(OWNER_A);
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_INTERVAL_MS * 2);
    expect(storage.read).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    changeAppState('active');
    await flush();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    changeAppState('inactive');
    expect(jest.getTimerCount()).toBe(0);
    changeAppState('background');
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_INTERVAL_MS * 2);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    changeAppState('active');
    changeAppState('active');
    await flush();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('ignores a canceled timer callback delivered after foreground has replaced its timer', async () => {
    const { clients, storage } = ports();
    const timers = jest.spyOn(globalThis, 'setTimeout');
    configure(clients, storage);
    startBillingLifecycle(OWNER_A);
    await flush();
    const queued = timers.mock.calls[timers.mock.calls.length - 1]![0];
    changeAppState('background');
    changeAppState('active');
    await flush();
    expect(jest.getTimerCount()).toBe(1);
    (queued as () => void)();
    await flush();
    expect(jest.getTimerCount()).toBe(1);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_INTERVAL_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('honors exponential backoff despite repeated foreground and access-state events', async () => {
    const { clients, storage } = ports();
    clients.backend.syncBilling.mockRejectedValue(new Error('offline'));
    configure(clients, storage);
    startBillingLifecycle(OWNER_A);
    await flush();

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const delay = Math.min(
        BILLING_RECONCILIATION_RETRY_MS * 2 ** (attempt - 1),
        BILLING_RECONCILIATION_INTERVAL_MS,
      );
      expect(
        selectBillingReconciliationRetryAtMs(useAccessStore.getState()),
      ).toBe(Date.now() + delay);
      for (let event = 0; event < 5; event += 1) {
        changeAppState('background');
        expect(jest.getTimerCount()).toBe(0);
        changeAppState('active');
        useAccessStore.getState().clearError();
      }
      await flush();
      expect(jest.getTimerCount()).toBe(1);
      expect(storage.read).toHaveBeenCalledTimes(attempt);
      expect(clients.backend.syncBilling).toHaveBeenCalledTimes(attempt);
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(clients.backend.syncBilling).toHaveBeenCalledTimes(attempt);
      if (attempt < 8) await jest.advanceTimersByTimeAsync(1);
    }
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
    for (const method of Object.values(clients.store))
      expect(method).not.toHaveBeenCalled();
  });

  it('waits for busy initialization without queueing a reconciliation that could start in the background', async () => {
    const { clients, storage } = ports();
    const access = deferred<CanonicalAccessState>();
    clients.backend.getAccess.mockReturnValueOnce(access.promise);
    configure(clients, storage);
    const initialization = useAccessStore.getState().initialize();
    startBillingLifecycle(OWNER_A);
    await flush();
    changeAppState('background');
    access.resolve(freeAccess);
    await initialization;
    await flush();
    expect(clients.backend.syncBilling).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    changeAppState('active');
    await flush();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(clients.store.configure).toHaveBeenCalledTimes(1);
    expect(clients.store.loadPlans).toHaveBeenCalledTimes(1);
    expect(clients.store.readEntitlement).not.toHaveBeenCalled();
    expect(clients.store.restore).not.toHaveBeenCalled();
    expect(clients.store.purchase).not.toHaveBeenCalled();
  });

  it('keeps one in-flight pass and does not schedule from its background completion', async () => {
    const { clients, storage } = ports();
    const verification = deferred<CanonicalBillingSync>();
    clients.backend.syncBilling.mockReturnValueOnce(verification.promise);
    configure(clients, storage);
    startBillingLifecycle(OWNER_A);
    await flush();
    for (let event = 0; event < 5; event += 1) {
      changeAppState('background');
      changeAppState('active');
      useAccessStore.getState().clearError();
    }
    await flush();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(storage.read).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);
    changeAppState('background');
    verification.resolve(synced());
    await flush();
    expect(jest.getTimerCount()).toBe(0);
    changeAppState('active');
    await flush();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('recalculates its timer when a user purchase leaves a pending marker, without another store purchase', async () => {
    const { clients, storage, records } = ports();
    clients.backend.syncBilling.mockResolvedValueOnce(synced(false));
    configure(clients, storage);
    startBillingLifecycle(OWNER_A);
    await flush();
    await useAccessStore.getState().initialize();
    clients.backend.syncBilling.mockRejectedValueOnce(
      new Error('offline after purchase'),
    );
    await useAccessStore.getState().purchaseSelected();
    await flush();
    expect(records.has(OWNER_A)).toBe(true);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_RETRY_MS - 1);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(3);
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
    expect(clients.store.restore).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
    expect(useAccessStore.getState().canonicalAccess).toEqual(premiumAccess);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('uses a positive delay when a bounded pending write leaves an already-overdue retry', async () => {
    const { clients, storage, records } = ports();
    const write = deferred<void>();
    records.set(OWNER_A, createPendingFulfilment(OWNER_A, 'purchase'));
    storage.write.mockReturnValueOnce(write.promise);
    configure(clients, storage);
    startBillingLifecycle(OWNER_A);
    await flush();
    await jest.advanceTimersByTimeAsync(BILLING_REQUEST_TIMEOUT_MS);
    expect(
      selectBillingReconciliationRetryAtMs(useAccessStore.getState()),
    ).toBeLessThan(Date.now());
    expect(storage.write).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(999);
    expect(storage.write).toHaveBeenCalledTimes(1);
    expect(clients.backend.syncBilling).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(storage.write).toHaveBeenCalledTimes(2);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    write.resolve();
    await flush();
    expect(records.size).toBe(0);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('ignores old A and B callbacks and late A completion across A → B → A', async () => {
    const first = ports();
    const verification = deferred<CanonicalBillingSync>();
    first.clients.backend.syncBilling.mockReturnValueOnce(verification.promise);
    configure(first.clients, first.storage);
    startBillingLifecycle(OWNER_A);
    const oldA = [...listeners][0]!;
    await flush();

    const b = ports();
    configure(b.clients, first.storage, OWNER_B);
    startBillingLifecycle(OWNER_B);
    const oldB = [...listeners][0]!;
    await flush();
    const nextA = ports();
    nextA.clients.backend.syncBilling.mockResolvedValue(synced(false));
    configure(nextA.clients, first.storage);
    startBillingLifecycle(OWNER_A);
    await flush();
    oldA('background');
    oldA('active');
    oldB('background');
    oldB('active');
    verification.resolve(synced());
    await flush();
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(nextA.clients.backend.getAccess).not.toHaveBeenCalled();
    expect(nextA.clients.backend.syncBilling).not.toHaveBeenCalled();
    expect(first.clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(b.clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(BILLING_REQUEST_TIMEOUT_MS);
    expect(nextA.clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(nextA.clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('invalidates the captured generation even when the active owner returns to A before an event', async () => {
    const { clients, storage } = ports();
    configure(clients, storage);
    startBillingLifecycle(OWNER_A);
    await flush();
    setActiveDataOwner(OWNER_B);
    setActiveDataOwner(OWNER_A);
    changeAppState('active');
    expect(jest.getTimerCount()).toBe(0);
    expect(listeners.size).toBe(0);
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_INTERVAL_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
  });

  it.each(['reset', 'reconfigure'] as const)(
    'closes on %s and requires an explicit new host for the new configuration',
    async reset => {
      const { clients, storage } = ports();
      configure(clients, storage);
      startBillingLifecycle(OWNER_A);
      const old = [...listeners][0]!;
      await flush();
      if (reset === 'reset') useAccessStore.getState().reset();
      else
        configureAccessStore(clients, {
          owner: OWNER_A,
          pendingFulfilmentStorage: storage,
        });
      expect(jest.getTimerCount()).toBe(0);
      expect(listeners.size).toBe(0);
      old('background');
      old('active');
      await flush();
      expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
      expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
      startBillingLifecycle(OWNER_A);
      await flush();
      expect(clients.backend.getAccess).toHaveBeenCalledTimes(2);
      expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(1);
    },
  );

  it('does not reschedule from a stopped pass, a removed listener, or later access changes', async () => {
    const { clients, storage } = ports();
    const verification = deferred<CanonicalBillingSync>();
    clients.backend.syncBilling.mockReturnValueOnce(verification.promise);
    configure(clients, storage);
    startBillingLifecycle(OWNER_A);
    const old = [...listeners][0]!;
    await flush();
    stopBillingLifecycle();
    expect(listeners.size).toBe(0);
    verification.resolve(synced());
    await flush();
    old('background');
    old('active');
    useAccessStore.getState().clearError();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_INTERVAL_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
  });

  it('clearing the API and access configuration stops a late initial read before backend reconciliation', async () => {
    const { clients, storage } = ports();
    const access = deferred<CanonicalAccessState>();
    clients.backend.getAccess.mockReturnValueOnce(access.promise);
    configure(clients, storage);
    startBillingLifecycle(OWNER_A);
    await flush();
    clearApiSession();
    clearAccessStoreConfiguration();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    expect(listeners.size).toBe(0);
    access.resolve(premiumAccess);
    await flush();
    expect(clients.backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([NaN, Infinity, -Infinity])(
    'never schedules a non-finite retry deadline (%s)',
    async nextAttemptAtMs => {
      const { clients, storage } = ports();
      configure(clients, storage);
      startBillingLifecycle(OWNER_A);
      await flush();
      useAccessStore.setState({
        reconciliation: {
          ...useAccessStore.getState().reconciliation,
          nextAttemptAtMs,
        },
      });
      expect(jest.getTimerCount()).toBe(0);
      changeAppState('background');
      changeAppState('active');
      await flush();
      expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
});
