/**
 * STRUCTURAL AUDIT #2 (mobile-analyze-capture) — accessStore.refreshAccess
 * under overlapping calls.
 *
 * Two production hooks issue refreshes independently (SettingsScreen focus,
 * AnalyzeScreen unmount), so overlap is a real schedule. refreshAccess drops
 * results from a STALE CONFIGURATION (configurationVersion) but has no
 * in-flight ordering guard: these cases pin what happens when two refreshes
 * of the SAME configuration resolve out of order or with one failing.
 */
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectCanStartRating,
  useAccessStore,
} from '../src/state/accessStore';

function freeAccess(used: number, reserved = 0): CanonicalAccessState {
  const remaining = 2 - used;
  const availableToReserve = remaining - reserved;
  return {
    premium: false,
    entitlements: [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating: availableToReserve > 0,
    paywallRequired: availableToReserve <= 0,
  };
}

function dependencies(
  getAccess: () => Promise<CanonicalAccessState>,
): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => {
        throw new Error('plans are not part of this test');
      }),
      purchase: jest.fn(),
      restore: jest.fn(),
      readEntitlement: jest.fn(),
    },
    backend: { getAccess: jest.fn(getAccess), syncBilling: jest.fn() },
  };
}

function gate<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('accessStore.refreshAccess overlapping calls (audit)', () => {
  it('an OLDER refresh resolving after a NEWER one must not roll the ledger back to the stale snapshot', async () => {
    const first = gate<CanonicalAccessState>();
    const second = gate<CanonicalAccessState>();
    const responses = [first.promise, second.promise];
    configureAccessStore(dependencies(() => responses.shift()!));
    useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess(0) });

    // Settings focus issues refresh #1; the Analyze unmount issues #2 after
    // a scoring run consumed the last free rating.
    const refresh1 = useAccessStore.getState().refreshAccess();
    const refresh2 = useAccessStore.getState().refreshAccess();

    // Newer truth lands first: both free ratings are spent.
    second.resolve(freeAccess(2));
    await refresh2;
    expect(selectCanStartRating(useAccessStore.getState())).toBe(false);

    // The older request finally answers with the pre-run ledger.
    first.resolve(freeAccess(1));
    await refresh1;

    // Expected: the newest server truth stays; the gate stays closed.
    const state = useAccessStore.getState();
    expect(state.canonicalAccess?.freeRatings.used).toBe(2);
    expect(selectCanStartRating(state)).toBe(false);
  });

  it('a transient failure of an OLDER overlapping refresh must not null out the snapshot a NEWER successful refresh just installed', async () => {
    const first = gate<CanonicalAccessState>();
    const second = gate<CanonicalAccessState>();
    const responses = [first.promise, second.promise];
    configureAccessStore(dependencies(() => responses.shift()!));
    useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess(0) });

    const refresh1 = useAccessStore.getState().refreshAccess();
    const refresh2 = useAccessStore.getState().refreshAccess();

    second.resolve(freeAccess(1));
    await refresh2;
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(1));

    first.reject(new Error('network request failed'));
    await refresh1;

    // Expected: a fresh successful read is authoritative over an older
    // request's transport failure — the user keeps the rating they have.
    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toEqual(freeAccess(1));
    expect(selectCanStartRating(state)).toBe(true);
  });

  it('VERIFY: overlapping refreshes of the same configuration both hit the backend (no dedupe is claimed) and the store is never left in "loading"', async () => {
    const clients = dependencies(async () => freeAccess(1));
    configureAccessStore(clients);
    useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess(0) });
    await Promise.all([
      useAccessStore.getState().refreshAccess(),
      useAccessStore.getState().refreshAccess(),
    ]);
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(2);
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(1));
  });

  it('VERIFY: a refresh that outlives its configuration is dropped and cannot repopulate a cleared store', async () => {
    const pending = gate<CanonicalAccessState>();
    configureAccessStore(dependencies(() => pending.promise));
    useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess(0) });
    const refresh = useAccessStore.getState().refreshAccess();
    clearAccessStoreConfiguration();
    pending.resolve(freeAccess(0));
    await expect(refresh).resolves.toBe(false);
    expect(useAccessStore.getState().status).toBe('idle');
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
  });
});
