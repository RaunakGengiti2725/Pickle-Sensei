/**
 * Structural audit #1 (mobile-analyze-capture) — overlapping
 * `refreshAccess()` calls on the access store.
 *
 * Two callers can legitimately overlap (AGENTS.md "Free-rating ledger
 * freshness"): SettingsScreen's focus refresh and AnalyzeScreen's unmount
 * refresh. `refreshAccess` has no in-flight guard and no response ordering
 * check, so the LAST response to land wins regardless of which request was
 * issued last. These cases pin the expected behaviour: the most recently
 * issued request's outcome must be the one that survives.
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
  useAccessStore,
} from '../../src/state/accessStore';

const oneLeft: CanonicalAccessState = {
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

const noneLeft: CanonicalAccessState = {
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

function dependencies(
  getAccess: () => Promise<CanonicalAccessState>,
): BillingAccessDependencies {
  const entitlement = {
    premium: false,
    productId: null,
    expirationDate: null,
  };
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async () => entitlement),
      restore: jest.fn(async () => entitlement),
      readEntitlement: jest.fn(async () => entitlement),
    },
    backend: {
      getAccess: jest.fn(getAccess),
      syncBilling: jest.fn(async () => ({
        billing: {
          premium: false,
          productKey: null,
          expiresAt: null,
          verifiedAt: '2026-08-27T00:00:00.000Z',
        },
        access: oneLeft,
      })),
    },
  };
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('structural audit #1 — overlapping refreshAccess calls', () => {
  it('a stale failure landing after a newer successful refresh does not lock the user out', async () => {
    const first = deferred<CanonicalAccessState>();
    const second = deferred<CanonicalAccessState>();
    const responses = [first, second];
    configureAccessStore(dependencies(() => responses.shift()!.promise));
    // Warm the store so it holds a verified allowance before the overlap.
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: oneLeft,
      error: null,
    });

    const store = useAccessStore.getState();
    const olderRefresh = store.refreshAccess(); // e.g. Settings focus
    const newerRefresh = store.refreshAccess(); // e.g. Analyze unmount

    second.resolve(oneLeft);
    await expect(newerRefresh).resolves.toBe(true);
    expect(useAccessStore.getState().status).toBe('ready');

    first.reject(new Error('network timeout'));
    await expect(olderRefresh).resolves.toBe(false);

    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    expect(state.canonicalAccess).toEqual(oneLeft);
    expect(selectCanStartRating(state)).toBe(true);
  });

  it('a stale snapshot landing after a newer one does not overwrite the newer ledger', async () => {
    const first = deferred<CanonicalAccessState>();
    const second = deferred<CanonicalAccessState>();
    const responses = [first, second];
    configureAccessStore(dependencies(() => responses.shift()!.promise));
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: oneLeft,
      error: null,
    });

    const store = useAccessStore.getState();
    const olderRefresh = store.refreshAccess();
    const newerRefresh = store.refreshAccess();

    // The newer request observes the ledger AFTER the last free rating was
    // spent; the older one still carries the pre-spend snapshot.
    second.resolve(noneLeft);
    await newerRefresh;
    expect(useAccessStore.getState().canonicalAccess).toEqual(noneLeft);

    first.resolve(oneLeft);
    await olderRefresh;

    expect(useAccessStore.getState().canonicalAccess).toEqual(noneLeft);
  });
});
