/**
 * W07-07 adversarial attacks against the billing lifecycle host at candidate
 * 95a33aff. Every attack drives the SHIPPING host (`startBillingLifecycle`)
 * with the real access store, and where the network layer matters, the real
 * `createCanonicalAccessClient` over a scripted `fetch`. Assertions state the
 * invariant the attack targets: no automatic StoreKit, no second charge, no
 * fabricated access or settlement, bounded retries (never 1 s polling), one
 * host timer, and honest reconciliation state.
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
import {
  BILLING_REQUEST_TIMEOUT_MS,
  createCanonicalAccessClient,
  type BillingFetch,
} from '../src/billing/accessApi';
import {
  createPendingFulfilment,
  PENDING_FULFILMENT_MAX_BACKOFF_MS,
  type PendingFulfilment,
  type PendingFulfilmentStorage,
} from '../src/billing/pendingFulfilment';
import {
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

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const START_MS = Date.parse('2026-09-06T00:00:00.000Z');
const HOUR_MS = 60 * 60_000;
const YEAR_MS = 365 * 24 * HOUR_MS;

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

function boundVerdict(
  outcome: 'fulfilled' | 'expired' | 'refunded' | 'pending',
  access: 'premium' | 'free',
) {
  return async (request?: BillingFulfilmentRequest) => {
    if (!request) throw new Error('a bound verdict requires the request');
    // The server stamps with its own clock, never earlier than the purchase.
    const verifiedAtMs = Math.max(
      Date.now(),
      Date.parse(request.transaction.purchasedAt),
    );
    return {
      ...(access === 'premium' ? premiumUntil(null) : notPremium()),
      fulfilment: { ...request, outcome, verifiedAt: iso(verifiedAtMs) },
    } satisfies CanonicalBillingSync;
  };
}

const offline = async () => {
  throw new TypeError('Network request failed');
};
const stalled = () => new Promise<never>(() => undefined);

function ports(owner: string) {
  const records = new Map<string, PendingFulfilment>();
  const storage = {
    read: jest.fn(async (key: string) => records.get(key) ?? null),
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
      purchase: jest.fn(async (): Promise<StoreEntitlementState> => {
        purchases += 1;
        return {
          ...restored,
          transaction: {
            productId: 'pickle_sensei_pro_annual',
            transactionId: `${owner.slice(0, 4)}-${purchases}`,
            purchasedAt: iso(Date.now()),
          },
        };
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

function signIn(
  owner: string,
  clients: BillingAccessDependencies,
  storage: PendingFulfilmentStorage,
) {
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.example.test',
    bearerToken: `access-${owner}`,
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  configureAccessStore(clients, { owner, pendingFulfilmentStorage: storage });
  startBillingLifecycle(owner);
}

/** The app's sign-out order: host, then store configuration, then session. */
function signOut() {
  stopBillingLifecycle();
  clearAccessStoreConfiguration();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
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

/** Advances the fake clock in 1 s steps and reports when work happened. */
async function observeCadence(
  totalMs: number,
  counter: () => number,
): Promise<number[]> {
  const ticks: number[] = [];
  let seen = counter();
  const start = Date.now();
  for (let elapsed = 1_000; elapsed <= totalMs; elapsed += 1_000) {
    await jest.advanceTimersByTimeAsync(1_000);
    const now = counter();
    if (now !== seen) {
      ticks.push(Date.now() - start);
      seen = now;
    }
  }
  return ticks;
}

function httpResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const lookup = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lookup.get(name.toLowerCase()) ?? null },
    json: async () => body,
  } as unknown as Response;
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
  signOut();
  await flush();
  expect(listeners.size).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
  AppState.currentState = originalAppState;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

async function purchaseHeldOffline(
  clients: ReturnType<typeof ports>['clients'],
  records: Map<string, PendingFulfilment>,
  owner: string,
) {
  await useAccessStore.getState().initialize();
  await flush();
  expect(membership().kind).toBe('free');
  clients.backend.syncBilling.mockImplementationOnce(offline);
  await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
    false,
  );
  await flush();
  expect(records.get(owner)).toMatchObject({ source: 'purchase', attempts: 1 });
  expect(membership().kind).toBe('hold');
}

describe('W07-07 attacks: lifecycle host at its failure boundaries', () => {
  async function journalWriteFailsAtRetry() {
    const { clients, storage, records } = ports(OWNER_A);
    signIn(OWNER_A, clients, storage);
    await flush();
    await purchaseHeldOffline(clients, records, OWNER_A);
    expect(useAccessStore.getState().reconciliation.status).toBe('unavailable');

    // The disk fills up: the attempt bookkeeping cannot be journaled, so the
    // pass fails before it reaches the network.
    storage.write.mockRejectedValue(new Error('SQLITE_FULL'));
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_RETRY_MS);
    expect(storage.write).toHaveBeenCalledTimes(3);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    expect(useAccessStore.getState()).toMatchObject({
      status: 'error',
      operation: 'idle',
      canonicalAccess: null,
      pendingFulfilment: { attempts: 2 },
      error: { code: 'billing.backend_verification_pending' },
    });
    expect(jest.getTimerCount()).toBe(1);
    return { clients, storage, records };
  }

  it('A1a: a journal write failure at the retry must not leave reconciliation reporting an in-flight check', async () => {
    await journalWriteFailsAtRetry();
    // Nothing is in flight, so the published reconciliation state must not
    // claim it is: the membership copy and the paywall retry path read it.
    expect(useAccessStore.getState().reconciliation.status).not.toBe(
      'checking',
    );
    expect(membership()).toMatchObject({
      kind: 'hold',
      purchaseAllowed: false,
    });
  });

  it('A1b: a journal write failure at the retry stays bounded, blocks StoreKit and settles once the disk recovers', async () => {
    const { clients, storage, records } = await journalWriteFailsAtRetry();
    expect(membership().purchaseAllowed).toBe(false);

    // Retries follow the record's own backoff, never a 1 s storage poll.
    const ticks = await observeCadence(
      60_000,
      () => storage.write.mock.calls.length,
    );
    expect(ticks).toEqual([10_000, 30_000]);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    expectNoStoreKitFromHost(clients, 1, 0);
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expectNoStoreKitFromHost(clients, 1, 0);

    // The disk recovers: the remembered purchase (attempts carried in
    // memory) is verified once, from the journal, without StoreKit.
    storage.write.mockImplementation(async (record, assertActive) => {
      assertActive?.();
      records.set(record.owner, { ...record });
    });
    clients.backend.syncBilling.mockImplementationOnce(
      boundVerdict('fulfilled', 'premium'),
    );
    await jest.advanceTimersByTimeAsync(PENDING_FULFILMENT_MAX_BACKOFF_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(3);
    expect(records.size).toBe(0);
    expect(membership().kind).toBe('fulfilled');
    expectNoStoreKitFromHost(clients, 1, 0);
  });

  it('A2: a wall-clock rollback during an unreadable-journal hold does not restart 1 s polling or fabricate state', async () => {
    const { clients, storage, records } = ports(OWNER_A);
    signIn(OWNER_A, clients, storage);
    await flush();
    await purchaseHeldOffline(clients, records, OWNER_A);

    storage.read.mockRejectedValue(new Error('SQLITE_CORRUPT'));
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_RETRY_MS);
    await jest.advanceTimersByTimeAsync(2 * BILLING_RECONCILIATION_RETRY_MS);
    await jest.advanceTimersByTimeAsync(4 * BILLING_RECONCILIATION_RETRY_MS);
    expect(useAccessStore.getState().reconciliation).toMatchObject({
      status: 'unavailable',
      lastAttemptAtMs: Date.now(),
      nextAttemptAtMs: Date.now() + 8 * BILLING_RECONCILIATION_RETRY_MS,
    });
    const readsBefore = storage.read.mock.calls.length;

    // The device clock jumps back one hour (NTP correction / manual change).
    jest.setSystemTime(Date.now() - HOUR_MS);
    await backgroundRoundTrip();
    // At most one catch-up pass, then the store's backoff bounds it again.
    const ticks = await observeCadence(
      3 * 60_000,
      () => storage.read.mock.calls.length,
    );
    expect(storage.read.mock.calls.length - readsBefore).toBeLessThanOrEqual(4);
    const gaps = ticks
      .slice(1)
      .map((tick, index) => tick - (ticks[index] ?? 0));
    for (const gap of gaps)
      expect(gap).toBeGreaterThanOrEqual(BILLING_RECONCILIATION_RETRY_MS);
    expect(membership().kind).toBe('hold');
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(2);
    expectNoStoreKitFromHost(clients, 1, 0);
    expect(jest.getTimerCount()).toBe(1);

    // Storage recovers: verified once from the journal.
    storage.read.mockImplementation(async key => records.get(key) ?? null);
    clients.backend.syncBilling.mockImplementationOnce(
      boundVerdict('fulfilled', 'premium'),
    );
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_INTERVAL_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(3);
    expect(membership().kind).toBe('fulfilled');
    expect(records.size).toBe(0);
    expectNoStoreKitFromHost(clients, 1, 0);
  });

  it('A3: a durable record whose journal read stalls at cold start is held on the bounded deadline, never read as empty', async () => {
    const { clients, storage, records } = ports(OWNER_A);
    records.set(OWNER_A, createPendingFulfilment(OWNER_A, 'restore'));
    let stalledReads = 0;
    storage.read.mockImplementation(() => {
      stalledReads += 1;
      return stalled();
    });
    signIn(OWNER_A, clients, storage);
    await flush();
    expect(stalledReads).toBe(1);
    expect(useAccessStore.getState().operation).toBe('syncing');

    // While the read hangs, foreground churn and a user restore tap must not
    // start anything else (no second read, no StoreKit, no network).
    changeAppState('background');
    changeAppState('active');
    await flush();
    await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
      false,
    );
    expect(stalledReads).toBe(1);
    await jest.advanceTimersByTimeAsync(BILLING_REQUEST_TIMEOUT_MS);
    expect(useAccessStore.getState()).toMatchObject({
      operation: 'idle',
      status: 'error',
      canonicalAccess: null,
      pendingFulfilment: null,
      fulfilmentStatus: 'unavailable',
      reconciliation: { status: 'unavailable' },
    });
    expect(membership()).toMatchObject({
      kind: 'hold',
      purchaseAllowed: false,
    });
    expect(clients.backend.getAccess).not.toHaveBeenCalled();
    expect(clients.backend.syncBilling).not.toHaveBeenCalled();
    expectNoStoreKitFromHost(clients, 0, 0);
    expect(jest.getTimerCount()).toBe(1);

    // Each further stall costs the deadline plus the doubling backoff.
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_RETRY_MS - 1);
    expect(stalledReads).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(stalledReads).toBe(2);
    await jest.advanceTimersByTimeAsync(BILLING_REQUEST_TIMEOUT_MS);
    await jest.advanceTimersByTimeAsync(
      2 * BILLING_RECONCILIATION_RETRY_MS - 1,
    );
    expect(stalledReads).toBe(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(stalledReads).toBe(3);
    await jest.advanceTimersByTimeAsync(BILLING_REQUEST_TIMEOUT_MS);
    expect(membership().kind).toBe('hold');

    // The journal answers again: the durable restore is verified without
    // StoreKit and without ever having been treated as "no record".
    storage.read.mockImplementation(async key => records.get(key) ?? null);
    clients.backend.syncBilling.mockImplementationOnce(async () =>
      premiumUntil(null),
    );
    await jest.advanceTimersByTimeAsync(4 * BILLING_RECONCILIATION_RETRY_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(records.size).toBe(0);
    expect(membership().kind).toBe('fulfilled');
    expect(clients.backend.getAccess).not.toHaveBeenCalled();
    expectNoStoreKitFromHost(clients, 0, 0);
  });

  it('A4: through the real API client, 429 + Retry-After and a redirect never settle, charge, or unlock; retry waits out Retry-After', async () => {
    const { clients, storage, records } = ports(OWNER_A);
    const fetchFn = jest.fn<ReturnType<BillingFetch>, Parameters<BillingFetch>>(
      async url =>
        String(url).endsWith('/v1/me/access')
          ? httpResponse(200, freeAccess)
          : httpResponse(200, notPremium()),
    );
    const backend = createCanonicalAccessClient({
      baseUrl: 'https://api.example.test',
      token: `access-${OWNER_A}`,
      fetchFn,
    });
    const realClients = { ...clients, backend };
    signIn(OWNER_A, realClients, storage);
    await flush();
    await useAccessStore.getState().initialize();
    await flush();
    expect(membership().kind).toBe('free');
    const coldStartRequests = fetchFn.mock.calls.length;

    // The purchase completes in StoreKit; the server rate-limits verification.
    const retryAfterSeconds = 120;
    fetchFn.mockImplementationOnce(async () =>
      httpResponse(
        429,
        { error: 'rate_limited' },
        { 'Retry-After': String(retryAfterSeconds) },
      ),
    );
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(coldStartRequests + 1);
    expect(records.get(OWNER_A)).toMatchObject({
      source: 'purchase',
      attempts: 1,
    });
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(membership()).toMatchObject({
      kind: 'hold',
      purchaseAllowed: false,
    });
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expectNoStoreKitFromHost(clients, 1, 0);

    // Every retry inside the Retry-After window is a redirect (a captive
    // portal / gateway answer): it must never be read as access, a verdict,
    // or a reason to open StoreKit again.
    fetchFn.mockImplementation(async () =>
      httpResponse(302, null, { Location: 'https://portal.example.test/' }),
    );
    const requestsBefore = fetchFn.mock.calls.length;
    await jest.advanceTimersByTimeAsync(retryAfterSeconds * 1_000 - 1);
    expect(membership().kind).toBe('hold');
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(useAccessStore.getState().fulfilmentVerdict).toBeNull();
    expect(records.get(OWNER_A)?.source).toBe('purchase');
    expectNoStoreKitFromHost(clients, 1, 0);
    for (const [, init] of fetchFn.mock.calls.slice(requestsBefore)) {
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer access-${OWNER_A}`,
      });
    }
    // A 429 with Retry-After asked the client to wait; retrying sooner burns
    // the same per-user budget and lengthens the hold.
    expect(fetchFn.mock.calls.length - requestsBefore).toBe(0);

    // Once the server answers with a bound verdict the purchase settles once.
    fetchFn.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        fulfilment: BillingFulfilmentRequest;
      };
      return httpResponse(200, {
        ...premiumUntil(null),
        fulfilment: {
          ...body.fulfilment,
          outcome: 'fulfilled',
          verifiedAt: iso(Date.now()),
        },
      });
    });
    await jest.advanceTimersByTimeAsync(PENDING_FULFILMENT_MAX_BACKOFF_MS);
    expect(records.size).toBe(0);
    expect(membership().kind).toBe('fulfilled');
    expectNoStoreKitFromHost(clients, 1, 0);
  });

  it('A5: a bound `expired` verdict beside premium access neither shows an ended membership nor fabricates a lapse later', async () => {
    const { clients, storage, records } = ports(OWNER_A);
    signIn(OWNER_A, clients, storage);
    await flush();
    await useAccessStore.getState().initialize();
    await flush();

    // The server: this device's purchase expired, but the account is premium
    // through another (renewed / transferred-in) purchase.
    clients.backend.syncBilling.mockImplementationOnce(
      boundVerdict('expired', 'premium'),
    );
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    await flush();
    expect(records.size).toBe(0);
    expect(useAccessStore.getState()).toMatchObject({
      status: 'ready',
      canonicalAccess: premiumAccess,
      pendingFulfilment: null,
      fulfilmentVerdict: null,
    });
    // What the premium account sees: an active membership, no ended copy.
    expect(membership()).toMatchObject({
      kind: 'fulfilled',
      purchaseAllowed: false,
    });
    expect(`${membership().label} ${membership().title}`).not.toMatch(
      /expired|refunded|ended/i,
    );

    // A later non-premium answer (transfer-out) is `free`, not `expired`: the
    // stale settlement of an older purchase says nothing about this lapse.
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_INTERVAL_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(3);
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
    expect(membership()).toMatchObject({ kind: 'free', purchaseAllowed: true });
    expectNoStoreKitFromHost(clients, 1, 0);
  });

  it('A6: an A → B → A account switch while A is held keeps journals, verdicts and trackers per owner', async () => {
    const { clients: clientsA, storage, records } = ports(OWNER_A);
    signIn(OWNER_A, clientsA, storage);
    await flush();
    await purchaseHeldOffline(clientsA, records, OWNER_A);
    const recordA = records.get(OWNER_A)!;
    expect(jest.getTimerCount()).toBe(1);

    // Sign out A, sign in B on the same device (same journal storage).
    signOut();
    await flush();
    expect(jest.getTimerCount()).toBe(0);
    const { clients: clientsB } = ports(OWNER_B);
    signIn(OWNER_B, clientsB, storage);
    await flush();
    await useAccessStore.getState().initialize();
    await flush();
    expect(storage.read).toHaveBeenLastCalledWith(OWNER_B);
    expect(membership().kind).toBe('free');
    expect(useAccessStore.getState().pendingFulfilment).toBeNull();
    expect(clientsB.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(clientsB.backend.syncBilling).toHaveBeenLastCalledWith();

    // B purchases and is fulfilled; A's record is untouched in the journal.
    clientsB.backend.syncBilling.mockImplementationOnce(
      boundVerdict('fulfilled', 'premium'),
    );
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      true,
    );
    await flush();
    expect(membership().kind).toBe('fulfilled');
    expect(records.get(OWNER_B)).toBeUndefined();
    expect(records.get(OWNER_A)).toEqual(recordA);
    const requestB = clientsB.backend.syncBilling.mock.calls[1]?.[0];
    expect(requestB?.pendingId).not.toBe(recordA.id);
    expectNoStoreKitFromHost(clientsB, 1, 0);

    // Back to A: the hold resumes from A's own journal and backoff, without
    // inheriting B's premium, and settles only against A's own record.
    signOut();
    await flush();
    signIn(OWNER_A, clientsA, storage);
    await flush();
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(membership().kind).toBe('hold');
    expect(clientsA.backend.syncBilling).toHaveBeenCalledTimes(2);
    expectNoStoreKitFromHost(clientsA, 1, 0);
    clientsA.backend.syncBilling.mockImplementationOnce(
      boundVerdict('refunded', 'free'),
    );
    await jest.advanceTimersByTimeAsync(PENDING_FULFILMENT_MAX_BACKOFF_MS);
    expect(clientsA.backend.syncBilling).toHaveBeenCalledTimes(3);
    const requestA = clientsA.backend.syncBilling.mock.calls[2]?.[0];
    expect(requestA).toMatchObject({
      pendingId: recordA.id,
      transaction: recordA.transaction,
    });
    expect(records.size).toBe(0);
    expect(membership()).toMatchObject({
      kind: 'expired',
      eyebrow: 'PURCHASE REFUNDED',
    });
    expectNoStoreKitFromHost(clientsA, 1, 0);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('A7: restarting the host during a hold does not add timers, StoreKit calls or an extra network attempt', async () => {
    const { clients, storage, records } = ports(OWNER_A);
    signIn(OWNER_A, clients, storage);
    await flush();
    await purchaseHeldOffline(clients, records, OWNER_A);
    const syncs = clients.backend.syncBilling.mock.calls.length;

    for (let restart = 0; restart < 5; restart += 1) {
      startBillingLifecycle(OWNER_A);
      await flush();
      expect(listeners.size).toBe(1);
      expect(jest.getTimerCount()).toBe(1);
    }
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(syncs);
    expect(records.get(OWNER_A)?.attempts).toBe(1);
    expectNoStoreKitFromHost(clients, 1, 0);

    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_RETRY_MS - 1);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(syncs);
    clients.backend.syncBilling.mockImplementationOnce(
      boundVerdict('fulfilled', 'premium'),
    );
    await jest.advanceTimersByTimeAsync(1);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(syncs + 1);
    expect(membership().kind).toBe('fulfilled');
    expect(records.size).toBe(0);
  });

  it('A8: a durable record stamped by a far-future clock is attempted once and then backs off; a far-future horizon stays fulfilled', async () => {
    const { clients, storage, records } = ports(OWNER_A);
    const stamped: PendingFulfilment = {
      ...createPendingFulfilment(OWNER_A, 'purchase', {
        productId: 'pickle_sensei_pro_annual',
        transactionId: '2000000001',
        purchasedAt: iso(START_MS - HOUR_MS),
      }),
      attempts: 3,
      lastAttemptAtMs: START_MS + YEAR_MS,
    };
    records.set(OWNER_A, stamped);
    clients.backend.syncBilling.mockImplementation(offline);
    signIn(OWNER_A, clients, storage);
    await flush();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(records.get(OWNER_A)).toMatchObject({
      attempts: 4,
      lastAttemptAtMs: START_MS,
    });
    expect(membership().kind).toBe('hold');

    const ticks = await observeCadence(
      3 * 60_000,
      () => clients.backend.syncBilling.mock.calls.length,
    );
    expect(ticks).toEqual([40_000, 120_000]);
    expectNoStoreKitFromHost(clients, 0, 0);
    expect(clients.backend.getAccess).not.toHaveBeenCalled();

    // Fulfilled with a horizon beyond any representable date: no NaN grace.
    clients.backend.syncBilling.mockImplementation(
      async (request?: BillingFulfilmentRequest) => ({
        billing: {
          premium: true,
          productKey: 'pickle_sensei_pro_annual',
          expiresAt: '+275760-09-13T00:00:00.000Z',
          verifiedAt: iso(Date.now()),
        },
        access: premiumAccess,
        fulfilment: {
          ...request!,
          outcome: 'fulfilled' as const,
          verifiedAt: iso(Date.now()),
        },
      }),
    );
    await jest.advanceTimersByTimeAsync(PENDING_FULFILMENT_MAX_BACKOFF_MS);
    expect(records.size).toBe(0);
    expect(membership()).toMatchObject({
      kind: 'fulfilled',
      purchaseAllowed: false,
    });
    expect(membership().label).not.toContain('NaN');
    expect(membership().label).not.toContain('Invalid');
    expect(jest.getTimerCount()).toBe(1);
  });

  it('A9: concurrent user retries and a foreground event during a stalled verification keep one attempt, one request and one timer', async () => {
    const { clients, storage, records } = ports(OWNER_A);
    signIn(OWNER_A, clients, storage);
    await flush();
    await purchaseHeldOffline(clients, records, OWNER_A);

    clients.backend.syncBilling.mockImplementation(stalled);
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_RETRY_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(3);
    expect(useAccessStore.getState().operation).toBe('syncing');
    expect(records.get(OWNER_A)?.attempts).toBe(2);

    // The user hammers Retry, Settings refreshes, and the app is backgrounded
    // and foregrounded while the request is still in flight.
    const retries = Promise.all([
      useAccessStore.getState().retryPendingFulfilment(),
      useAccessStore.getState().refreshAccess(),
      useAccessStore.getState().syncBilling(),
      useAccessStore.getState().restorePurchases(),
      useAccessStore.getState().purchaseSelected(),
    ]);
    changeAppState('background');
    changeAppState('active');
    await flush();
    await expect(retries).resolves.toEqual([false, false, false, false, false]);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(3);
    expect(records.get(OWNER_A)?.attempts).toBe(2);
    expectNoStoreKitFromHost(clients, 1, 0);

    await jest.advanceTimersByTimeAsync(BILLING_REQUEST_TIMEOUT_MS);
    expect(useAccessStore.getState().operation).toBe('idle');
    expect(membership().kind).toBe('hold');
    expect(jest.getTimerCount()).toBe(1);

    // After the deadline the user's explicit retry is one bound request.
    clients.backend.syncBilling.mockImplementation(
      boundVerdict('fulfilled', 'premium'),
    );
    await expect(
      useAccessStore.getState().retryPendingFulfilment(),
    ).resolves.toBe(true);
    await flush();
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(4);
    expect(records.size).toBe(0);
    expect(membership().kind).toBe('fulfilled');
    expectNoStoreKitFromHost(clients, 1, 0);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('A10: corrupt, oversized or foreign durable rows hold the account instead of becoming an empty journal', async () => {
    const corruptRows: Array<{ name: string; row: unknown }> = [
      {
        name: 'attempts past the bound',
        row: { ...createPendingFulfilment(OWNER_A, 'restore'), attempts: 40 },
      },
      {
        name: 'oversized transaction evidence',
        row: {
          ...createPendingFulfilment(OWNER_A, 'purchase', {
            productId: 'pickle_sensei_pro_annual',
            transactionId: '2000000002',
            purchasedAt: iso(START_MS),
          }),
          transaction: {
            productId: 'pickle_sensei_pro_annual',
            transactionId: 'x'.repeat(4_096),
            purchasedAt: iso(START_MS),
          },
        },
      },
      {
        name: 'transaction evidence with an unparseable purchase time',
        row: {
          ...createPendingFulfilment(OWNER_A, 'purchase', {
            productId: 'pickle_sensei_pro_annual',
            transactionId: '2000000003',
            purchasedAt: iso(START_MS),
          }),
          transaction: {
            productId: 'pickle_sensei_pro_annual',
            transactionId: '2000000003',
            purchasedAt: 'not-a-date',
          },
        },
      },
      {
        name: 'another owner’s record',
        row: createPendingFulfilment(OWNER_B, 'purchase', {
          productId: 'pickle_sensei_pro_annual',
          transactionId: '3000000001',
          purchasedAt: iso(START_MS),
        }),
      },
      {
        name: 'NaN timestamps',
        row: {
          ...createPendingFulfilment(OWNER_A, 'restore'),
          attempts: 1,
          lastAttemptAtMs: Number.NaN,
        },
      },
      {
        name: 'negative timestamps',
        row: {
          ...createPendingFulfilment(OWNER_A, 'restore'),
          completedAtMs: -1,
        },
      },
    ];
    for (const { name, row } of corruptRows) {
      const { clients, storage } = ports(OWNER_A);
      storage.read.mockImplementation(async () => row as PendingFulfilment);
      signIn(OWNER_A, clients, storage);
      await flush();
      await useAccessStore.getState().initialize();
      await flush();
      expect([name, useAccessStore.getState().fulfilmentStatus]).toEqual([
        name,
        'unavailable',
      ]);
      expect([name, membership().kind]).toEqual([name, 'hold']);
      await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
        false,
      );
      await expect(useAccessStore.getState().restorePurchases()).resolves.toBe(
        false,
      );
      expect(clients.backend.getAccess).not.toHaveBeenCalled();
      expect(clients.backend.syncBilling).not.toHaveBeenCalled();
      expectNoStoreKitFromHost(clients, 0, 0);
      expect(jest.getTimerCount()).toBe(1);
      // Bounded: the corrupt row is not re-read every second.
      const ticks = await observeCadence(
        30_000,
        () => storage.read.mock.calls.length,
      );
      expect([name, ticks]).toEqual([name, [5_000, 15_000]]);
      signOut();
      await flush();
    }
  });

  it('A11: a bound settlement whose journal cleanup fails is not reported settled, and settles exactly once when cleanup recovers', async () => {
    const { clients, storage, records } = ports(OWNER_A);
    signIn(OWNER_A, clients, storage);
    await flush();
    await purchaseHeldOffline(clients, records, OWNER_A);

    // The server binds `refunded`; the journal delete fails (I/O error).
    storage.remove.mockRejectedValueOnce(new Error('SQLITE_IOERR'));
    clients.backend.syncBilling.mockImplementationOnce(
      boundVerdict('refunded', 'free'),
    );
    await jest.advanceTimersByTimeAsync(BILLING_RECONCILIATION_RETRY_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(3);
    expect(records.get(OWNER_A)?.attempts).toBe(2);
    expect(useAccessStore.getState()).toMatchObject({
      status: 'error',
      canonicalAccess: null,
      pendingFulfilment: { attempts: 2 },
      error: { code: 'billing.backend_verification_pending' },
    });
    // Not settled: the record is still journaled, so the UI must keep the
    // user out of StoreKit rather than announce a refund.
    expect(membership().kind).not.toBe('expired');
    expect(membership().purchaseAllowed).toBe(false);
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    expectNoStoreKitFromHost(clients, 1, 0);
    expect(jest.getTimerCount()).toBe(1);

    // The next bounded retry re-asks with a fresh attempt id and settles once.
    clients.backend.syncBilling.mockImplementationOnce(
      boundVerdict('refunded', 'free'),
    );
    await jest.advanceTimersByTimeAsync(2 * BILLING_RECONCILIATION_RETRY_MS);
    expect(clients.backend.syncBilling).toHaveBeenCalledTimes(4);
    const [second] = clients.backend.syncBilling.mock.calls[2] ?? [];
    const [third] = clients.backend.syncBilling.mock.calls[3] ?? [];
    expect(third?.pendingId).toBe(second?.pendingId);
    expect(third?.attemptId).not.toBe(second?.attemptId);
    expect(records.size).toBe(0);
    expect(storage.remove).toHaveBeenCalledTimes(2);
    expect(membership()).toMatchObject({
      kind: 'expired',
      eyebrow: 'PURCHASE REFUNDED',
      purchaseAllowed: true,
    });
    expectNoStoreKitFromHost(clients, 1, 0);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('A12: a purchase the store completed without transaction evidence, later refunded, must not lock the device out of the store forever', async () => {
    const { clients, storage, records } = ports(OWNER_A);
    // StoreKit / RevenueCat answered the purchase without a transaction
    // (the client then journals a schema-1 purchase record).
    clients.store.purchase.mockImplementation(async () => ({
      premium: true,
      productId: 'pickle_sensei_pro_annual',
      expirationDate: null,
    }));
    signIn(OWNER_A, clients, storage);
    await flush();
    await useAccessStore.getState().initialize();
    await flush();
    clients.backend.syncBilling.mockImplementationOnce(offline);
    await expect(useAccessStore.getState().purchaseSelected()).resolves.toBe(
      false,
    );
    await flush();
    expect(records.get(OWNER_A)).toMatchObject({
      schemaVersion: 1,
      source: 'purchase',
      attempts: 1,
    });
    expect(membership().kind).toBe('hold');

    // The server is reachable again and answers, authoritatively, that this
    // account holds no membership (the purchase was refunded by Apple). With
    // no evidence to bind, every answer is treated as "still pending".
    let syncs = clients.backend.syncBilling.mock.calls.length;
    await jest.advanceTimersByTimeAsync(24 * HOUR_MS);
    expect(clients.backend.syncBilling.mock.calls.length).toBeGreaterThan(
      syncs,
    );
    syncs = clients.backend.syncBilling.mock.calls.length;
    for (const call of clients.backend.syncBilling.mock.calls.slice(2))
      expect(call[0]).toBeUndefined();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);
    expect(records.get(OWNER_A)?.attempts).toBe(31);
    expectNoStoreKitFromHost(clients, 1, 0);
    expect(jest.getTimerCount()).toBe(1);

    // The user explicitly retries and the server again says "no membership":
    // after a full day of authoritative non-premium answers the account must
    // have a way to buy again on this device, or the copy must not promise
    // that retrying will ever complete.
    await expect(
      useAccessStore.getState().retryPendingFulfilment(),
    ).resolves.toBe(false);
    await flush();
    const state = membership();
    expect(state.kind).toBe('pending');
    const wayForward =
      state.purchaseAllowed ||
      /support|contact/i.test(`${state.detail} ${state.title}`);
    expect({
      wayForward,
      purchaseAllowed: state.purchaseAllowed,
      detail: state.detail,
      attempts: records.get(OWNER_A)?.attempts,
      syncs: clients.backend.syncBilling.mock.calls.length - syncs,
    }).toMatchObject({ wayForward: true });
  });
});
