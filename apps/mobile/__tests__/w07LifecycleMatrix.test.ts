/**
 * W07-07 — ordered billing lifecycle matrix driven through the SHIPPING host
 * (`startBillingLifecycle`) with the real access store: restore, renewal,
 * grace, expiry, refund and transfer-out, in sequence, with network failures
 * (offline, 5xx, stalled request, unreadable journal) interleaved between
 * every business event and with foreground/background transitions in
 * between. Every state the user could see is asserted through
 * `selectMembershipState`, and every step re-checks the invariants: access is
 * server-authoritative, the host never opens StoreKit, a pending record is
 * never re-purchased or re-restored, ambiguous answers never become a refund
 * or an expiry, and retries stay bounded.
 */
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
  PENDING_FULFILMENT_MAX_BACKOFF_MS,
  type PendingFulfilment,
  type PendingFulfilmentStorage,
} from '../src/billing/pendingFulfilment';
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
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  BILLING_RECONCILIATION_INTERVAL_MS,
  BILLING_RECONCILIATION_RETRY_MS,
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectMembershipState,
  useAccessStore,
} from '../src/state/accessStore';

const OWNER = '11111111-1111-4111-8111-111111111111';
const START_MS = Date.parse('2026-09-06T00:00:00.000Z');
const MINUTE_MS = 60_000;

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

const iso = (ms: number) => new Date(ms).toISOString();

function premiumUntil(expiresAtMs: number | null): CanonicalBillingSync {
  return {
    billing: {
      premium: true,
      productKey: 'pickle_sensei_pro_annual',
      expiresAt: expiresAtMs === null ? null : iso(expiresAtMs),
      verifiedAt: iso(Date.now()),
    },
    access: premiumAccess,
  };
}

function notPremium(): CanonicalBillingSync {
  return {
    billing: {
      premium: false,
      productKey: null,
      expiresAt: null,
      verifiedAt: iso(Date.now()),
    },
    access: freeAccess,
  };
}

function settledAs(outcome: 'refunded' | 'expired') {
  return async (request?: BillingFulfilmentRequest) => {
    if (!request) throw new Error('settlement requires the device request');
    return {
      ...notPremium(),
      fulfilment: { ...request, outcome, verifiedAt: iso(Date.now()) },
    } satisfies CanonicalBillingSync;
  };
}

function fulfilledFor(expiresAtMs: number | null) {
  return async (request?: BillingFulfilmentRequest) => {
    if (!request) throw new Error('fulfilment requires the device request');
    return {
      ...premiumUntil(expiresAtMs),
      fulfilment: {
        ...request,
        outcome: 'fulfilled' as const,
        verifiedAt: iso(Date.now()),
      },
    } satisfies CanonicalBillingSync;
  };
}

const offline = async () => {
  throw new TypeError('Network request failed');
};
const serverError = async () => {
  throw new BillingError(
    'billing.backend_unavailable',
    'Membership verification is temporarily unavailable.',
    true,
  );
};
const stalled = () => new Promise<CanonicalBillingSync>(() => undefined);

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
  let purchases = 0;
  const restored: StoreEntitlementState = {
    premium: true,
    productId: 'pickle_sensei_pro_annual',
    expirationDate: null,
  };
  const clients = {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async () => {
        purchases += 1;
        return {
          ...restored,
          transaction: {
            productId: 'pickle_sensei_pro_annual',
            transactionId: `2000000${purchases}`,
            purchasedAt: iso(Date.now()),
          },
        } satisfies StoreEntitlementState;
      }),
      restore: jest.fn(async () => restored),
      readEntitlement: jest.fn(async () => restored),
    },
    backend: {
      getAccess: jest.fn(async () => freeAccess),
      syncBilling: jest.fn(async (_request?: BillingFulfilmentRequest) =>
        notPremium(),
      ),
    },
  } satisfies BillingAccessDependencies;
  return { clients, storage, records };
}

function configure(
  clients: BillingAccessDependencies,
  storage: PendingFulfilmentStorage,
) {
  setActiveDataOwner(OWNER);
  establishApiSession({
    apiBaseUrl: 'https://api.example.test',
    bearerToken: `access-${OWNER}`,
    canonicalAppUserId: OWNER,
    provider: 'apple',
  });
  configureAccessStore(clients, {
    owner: OWNER,
    pendingFulfilmentStorage: storage,
  });
}

async function flush() {
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
}

const membership = () => selectMembershipState(useAccessStore.getState());

type ChangeListener = (state: AppStateStatus) => void;
const listeners = new Set<ChangeListener>();
const originalAppState = AppState.currentState;

function changeAppState(state: AppStateStatus) {
  AppState.currentState = state;
  for (const listener of [...listeners]) listener(state);
}

/** iOS suspends timers in the background; the host must catch up on return. */
async function backgroundRoundTrip() {
  changeAppState('background');
  expect(jest.getTimerCount()).toBe(0);
  changeAppState('active');
  await flush();
}

function expectNoStoreKitFromHost(
  clients: ReturnType<typeof ports>['clients'],
  purchases: number,
  restores: number,
) {
  expect(clients.store.purchase).toHaveBeenCalledTimes(purchases);
  expect(clients.store.restore).toHaveBeenCalledTimes(restores);
  expect(clients.store.readEntitlement).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.useFakeTimers({ now: START_MS });
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

describe('W07-07 ordered billing lifecycle matrix through the live host', () => {
  it('restore → renewal → grace → expiry → purchase/refund → transfer-out, with failures between every event', async () => {
    const { clients, storage, records } = ports();
    configure(clients, storage);
    startBillingLifecycle(OWNER);
    await flush();
    await useAccessStore.getState().initialize();
    await flush();

    // 1. Cold start: the server states a free account. Nothing touched StoreKit.
    expect(membership().kind).toBe('free');
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expectNoStoreKitFromHost(clients, 0, 0);
    expect(jest.getTimerCount()).toBe(1);

    // 2. Restore while offline: the completed store restore is journaled and
    //    access fails closed as HOLD; the host owns the retry (5s, then 10s)
    //    and a background/foreground round trip neither loses nor doubles it.
    clients.backend.syncBilling.mockImplementationOnce(offline);
    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      false,
    );
    await flush();
    expect(records.get(OWNER)?.source).toBe('restore');
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(membership()).toMatchObject({
      kind: 'hold',
      purchaseAllowed: false,
      retryAllowed: true,
    });
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    await backgroundRoundTrip();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);

    clients.backend.syncBilling.mockImplementationOnce(serverError);
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_RETRY_MS - 1);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(3);
    expect(membership().kind).toBe('hold');
    expect(records.get(OWNER)?.attempts).toBe(2);

    const firstHorizon =
      Date.now() + 2 * BILLING_RECONCILIATION_RETRY_MS + 2 * MINUTE_MS;
    clients.backend.syncBilling.mockImplementationOnce(async () =>
      premiumUntil(firstHorizon),
    );
    await jest.advanceTimersByTimeAsync(2 * BILLING_RECONCILIATION_RETRY_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(4);
    expect(records.size).toBe(0);
    expect(useAccessStore.getState()).toMatchObject({
      status: 'ready',
      operation: 'idle',
      canonicalAccess: premiumAccess,
      pendingFulfilment: null,
      fulfilmentStatus: 'clear',
      error: null,
    });
    expect(membership()).toMatchObject({
      kind: 'fulfilled',
      horizon: iso(firstHorizon),
      manageSubscription: true,
    });
    expectNoStoreKitFromHost(clients, 0, 1);
    const restoreVerifiedAt = Date.now();

    // 3. Grace: the verified horizon passes before the next server check.
    //    Access stays exactly as last verified; the UI says so honestly.
    await jest.advanceTimersByTimeAsync(firstHorizon - Date.now());
    expect(membership()).toMatchObject({
      kind: 'grace',
      horizon: iso(firstHorizon),
    });
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(4);
    await backgroundRoundTrip();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(4);

    // 4. Renewal check fails (offline), then the retry stalls until the
    //    request deadline: still grace, never expired, never a store call.
    clients.backend.syncBilling.mockImplementationOnce(offline);
    await jest.advanceTimersByTimeAsync(
      restoreVerifiedAt + BILLING_RECONCILIATION_INTERVAL_MS - Date.now(),
    );
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(5);
    expect(useAccessStore.getState().canonicalAccess).toEqual(premiumAccess);
    expect(membership()).toMatchObject({ kind: 'grace' });
    expect(membership().detail).toContain('could not be reached');

    clients.backend.syncBilling.mockImplementationOnce(stalled);
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_RETRY_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(6);
    await jest.advanceTimersByTimeAsync(BILLING_REQUEST_TIMEOUT_MS);
    expect(useAccessStore.getState().reconciliation.status).toBe('unavailable');
    expect(membership().kind).toBe('grace');

    // 5. Renewal verified: a new horizon replaces the lapsed one.
    const renewedHorizon = Date.now() + 365 * 24 * 60 * MINUTE_MS;
    clients.backend.syncBilling.mockImplementationOnce(async () =>
      premiumUntil(renewedHorizon),
    );
    await jest.advanceTimersByTimeAsync(2 * BILLING_RECONCILIATION_RETRY_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(7);
    expect(membership()).toMatchObject({
      kind: 'fulfilled',
      horizon: iso(renewedHorizon),
    });
    expectNoStoreKitFromHost(clients, 0, 1);

    // 6. Expiry: the server later reports no membership. Without a verdict
    //    bound to this device's own purchase that is `free`, never `expired`.
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_INTERVAL_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(8);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
    expect(membership()).toMatchObject({ kind: 'free', purchaseAllowed: true });
    expectNoStoreKitFromHost(clients, 0, 1);

    // 7. Purchase whose verification stalls: HOLD. While on hold neither
    //    Restore nor Continue may reach StoreKit again.
    clients.backend.syncBilling.mockImplementationOnce(stalled);
    const purchase = useAccessStore.getState().purchaseSelected();
    await jest.advanceTimersByTimeAsync(BILLING_REQUEST_TIMEOUT_MS);
    await expect(purchase).resolves.toBe(false);
    expect(records.get(OWNER)).toMatchObject({
      source: 'purchase',
      schemaVersion: 2,
      attempts: 1,
    });
    expect(membership().kind).toBe('hold');
    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      false,
    );
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expectNoStoreKitFromHost(clients, 1, 1);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(9);

    // 8. Refund: the server binds a `refunded` verdict to this exact request.
    //    The journal closes, access is free, and the UI names the refund. The
    //    stalled attempt left the record's retry overdue, so returning to the
    //    foreground catches up immediately instead of waiting for a timer.
    clients.backend.syncBilling.mockImplementationOnce(settledAs('refunded'));
    await backgroundRoundTrip();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(10);
    expect(records.size).toBe(0);
    expect(useAccessStore.getState()).toMatchObject({
      status: 'ready',
      canonicalAccess: freeAccess,
      pendingFulfilment: null,
      fulfilmentVerdict: { outcome: 'refunded' },
      error: { code: 'billing.purchase_settled' },
    });
    expect(membership()).toMatchObject({
      kind: 'expired',
      eyebrow: 'PURCHASE REFUNDED',
      purchaseAllowed: true,
    });
    const refundedAt = Date.now();

    // 9. The refund verdict survives the next routine check (still free).
    clients.backend.syncBilling.mockImplementationOnce(offline);
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_INTERVAL_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(11);
    expect(membership().kind).toBe('expired');
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_RETRY_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(12);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
    expect(membership()).toMatchObject({
      kind: 'expired',
      eyebrow: 'PURCHASE REFUNDED',
    });
    expect(Date.now()).toBe(
      refundedAt +
        BILLING_RECONCILIATION_INTERVAL_MS +
        BILLING_RECONCILIATION_RETRY_MS,
    );

    // 10. A new purchase is fulfilled: the refund verdict is superseded.
    const secondHorizon = Date.now() + 30 * 24 * 60 * MINUTE_MS;
    clients.backend.syncBilling.mockImplementationOnce(
      fulfilledFor(secondHorizon),
    );
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    await flush();
    expect(records.size).toBe(0);
    expect(useAccessStore.getState().fulfilmentVerdict).toBeNull();
    expect(membership()).toMatchObject({
      kind: 'fulfilled',
      horizon: iso(secondHorizon),
    });
    expectNoStoreKitFromHost(clients, 2, 1);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(13);

    // 11. Transfer-out: the entitlement moves to another account. The server
    //     answers non-premium; a user restore is verified negative without
    //     fabricating premium, an expiry or a refund.
    clients.backend.syncBilling.mockImplementationOnce(serverError);
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_INTERVAL_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(14);
    expect(membership()).toMatchObject({
      kind: 'fulfilled',
      horizon: iso(secondHorizon),
    });
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_RETRY_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(15);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
    expect(membership()).toMatchObject({ kind: 'free', purchaseAllowed: true });

    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      false,
    );
    await flush();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(16);
    expect(records.size).toBe(0);
    expect(useAccessStore.getState()).toMatchObject({
      status: 'ready',
      canonicalAccess: freeAccess,
      pendingFulfilment: null,
      fulfilmentVerdict: null,
      error: { code: 'billing.restore_failed', retryable: false },
    });
    expect(membership().kind).toBe('free');
    expectNoStoreKitFromHost(clients, 2, 2);

    // Throughout: one host, one timer, no automatic StoreKit, plans once.
    expect(clients.store.configure).toHaveBeenCalledTimes(1);
    expect(clients.store.loadPlans).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('a reinstall with a durable restore record and an unreachable server holds with bounded backoff, then fulfils without StoreKit', async () => {
    const { clients, storage, records } = ports();
    records.set(OWNER, createPendingFulfilment(OWNER, 'restore'));
    clients.backend.syncBilling.mockImplementation(offline);
    configure(clients, storage);
    startBillingLifecycle(OWNER);
    await flush();
    expect(clients.backend.getAccess).not.toHaveBeenCalled();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(membership().kind).toBe('hold');

    for (let attempt = 2; attempt <= 9; attempt += 1) {
      const delay = Math.min(
        BILLING_RECONCILIATION_RETRY_MS * 2 ** (attempt - 2),
        PENDING_FULFILMENT_MAX_BACKOFF_MS,
      );
      await backgroundRoundTrip();
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(clients.backend.syncBilling).toHaveBeenCalledTimes(attempt - 1);
      await jest.advanceTimersByTimeAsync(1);
      expect(clients.backend.syncBilling).toHaveBeenCalledTimes(attempt);
      expect(records.get(OWNER)?.attempts).toBe(attempt);
      expect(membership().kind).toBe('hold');
      expect(useAccessStore.getState().canonicalAccess).toBeNull();
    }

    clients.backend.syncBilling.mockImplementation(async () =>
      premiumUntil(null),
    );
    await jest.advanceTimersByTimeAsync(PENDING_FULFILMENT_MAX_BACKOFF_MS);
    expect(records.size).toBe(0);
    expect(membership()).toMatchObject({
      kind: 'fulfilled',
      horizon: null,
      manageSubscription: false,
    });
    expectNoStoreKitFromHost(clients, 0, 0);
    expect(clients.backend.getAccess).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
  });

  it('an ambiguous `pending` verdict for a paid purchase stays pending across failures and never settles or re-charges', async () => {
    const { clients, storage, records } = ports();
    configure(clients, storage);
    startBillingLifecycle(OWNER);
    await flush();
    await useAccessStore.getState().initialize();
    await flush();

    clients.backend.syncBilling.mockImplementationOnce(
      async (request?: BillingFulfilmentRequest) => ({
        ...notPremium(),
        fulfilment: {
          ...request!,
          outcome: 'pending' as const,
          verifiedAt: iso(Date.now()),
        },
      }),
    );
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    await flush();
    expect(records.get(OWNER)?.attempts).toBe(1);
    expect(useAccessStore.getState()).toMatchObject({
      status: 'error',
      canonicalAccess: freeAccess,
      fulfilmentVerdict: { outcome: 'pending' },
      error: { code: 'billing.backend_verification_pending' },
    });
    expect(membership()).toMatchObject({
      kind: 'pending',
      purchaseAllowed: false,
    });

    clients.backend.syncBilling.mockImplementationOnce(offline);
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_RETRY_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(3);
    expect(membership().kind).toBe('hold');
    expect(records.get(OWNER)?.attempts).toBe(2);

    clients.backend.syncBilling.mockImplementationOnce(settledAs('expired'));
    await jest.advanceTimersByTimeAsync(2 * BILLING_RECONCILIATION_RETRY_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(4);
    expect(records.size).toBe(0);
    expect(membership()).toMatchObject({
      kind: 'expired',
      eyebrow: 'MEMBERSHIP EXPIRED',
      purchaseAllowed: true,
    });
    expectNoStoreKitFromHost(clients, 1, 0);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('an unreadable journal beside a remembered purchase follows the reconciliation backoff instead of polling storage every second', async () => {
    const { clients, storage, records } = ports();
    configure(clients, storage);
    startBillingLifecycle(OWNER);
    await flush();
    await useAccessStore.getState().initialize();
    await flush();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);

    clients.backend.syncBilling.mockImplementationOnce(offline);
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    await flush();
    expect(records.get(OWNER)?.attempts).toBe(1);
    expect(membership().kind).toBe('hold');
    const readsBefore = storage.read.mock.calls.length;

    // The journal row becomes unreadable (corrupt/locked) while the purchase
    // is still remembered in memory: the record cannot be attempted, so the
    // store records a reconciliation failure with exponential backoff.
    storage.read.mockRejectedValue(new Error('SQLITE_CORRUPT'));
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_RETRY_MS);
    expect(storage.read).toHaveBeenCalledTimes(readsBefore + 1);
    expect(useAccessStore.getState()).toMatchObject({
      fulfilmentStatus: 'unavailable',
      pendingFulfilment: { attempts: 1 },
      reconciliation: { status: 'unavailable' },
    });
    expect(membership().kind).toBe('hold');
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);

    for (let failure = 2; failure <= 7; failure += 1) {
      const delay = Math.min(
        BILLING_RECONCILIATION_RETRY_MS * 2 ** (failure - 1),
        BILLING_RECONCILIATION_INTERVAL_MS,
      );
      expect(useAccessStore.getState().reconciliation.nextAttemptAtMs).toBe(
        Date.now() + delay,
      );
      await backgroundRoundTrip();
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(storage.read).toHaveBeenCalledTimes(readsBefore + failure - 1);
      await jest.advanceTimersByTimeAsync(1);
      expect(storage.read).toHaveBeenCalledTimes(readsBefore + failure);
      expect(membership().kind).toBe('hold');
    }
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    expectNoStoreKitFromHost(clients, 1, 0);

    // Storage recovers: the remembered purchase is verified once, from the
    // journal, without another store request.
    storage.read.mockImplementation(async owner => records.get(owner) ?? null);
    clients.backend.syncBilling.mockImplementationOnce(fulfilledFor(null));
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_INTERVAL_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(3);
    expect(records.size).toBe(0);
    expect(membership()).toMatchObject({ kind: 'fulfilled', horizon: null });
    expectNoStoreKitFromHost(clients, 1, 0);
    expect(jest.getTimerCount()).toBe(1);
  });
});
