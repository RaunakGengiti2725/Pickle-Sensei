/**
 * Adversarial probes for the XC-ADJ-BEH-1 fix (accessStore write ordering,
 * candidate 38339aee). Each test names the interleaving it drives and the
 * invariant the cluster claims: "a completed purchase is never displaced by
 * an older snapshot"; verified membership / valid snapshots are never
 * regressed by an in-flight read.
 */
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  CanonicalBillingSync,
  StorePlans,
} from '../../src/billing/types';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { deferred, type Deferred } from '../../testing/xcBehavioral/deferred';

function access(premium: boolean, used = 0): CanonicalAccessState {
  const remaining = premium ? 2 : Math.max(0, 2 - used);
  return {
    premium,
    entitlements: premium ? ['pickle_sensei_pro'] : [],
    freeRatings: {
      limit: 2,
      used,
      reserved: 0,
      remaining,
      availableToReserve: remaining,
    },
    canStartRating: premium || remaining > 0,
    paywallRequired: !premium && remaining === 0,
  };
}

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual',
    productId: 'pickle_sensei_pro_yearly',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: null,
  lifetime: null,
};

const entitlement = {
  premium: true,
  productId: 'pickle_sensei_pro_yearly',
  expirationDate: null,
};

const premiumSync: CanonicalBillingSync = {
  billing: {
    premium: true,
    productKey: 'pickle_sensei_pro_yearly',
    expiresAt: null,
    verifiedAt: '2026-09-04T00:00:00.000Z',
  },
  access: access(true),
};

type CallName =
  | 'configure'
  | 'loadPlans'
  | 'purchase'
  | 'restore'
  | 'getAccess'
  | 'syncBilling';

function billingDeps() {
  const pending: Array<{ name: CallName; d: Deferred<unknown> }> = [];
  const hold = <T>(name: CallName): Promise<T> => {
    const d = deferred<T>();
    pending.push({ name, d: d as Deferred<unknown> });
    return d.promise;
  };
  const deps: BillingAccessDependencies = {
    store: {
      configure: () => hold<void>('configure'),
      loadPlans: () => hold<StorePlans>('loadPlans'),
      purchase: () => hold<typeof entitlement>('purchase'),
      restore: () => hold<typeof entitlement>('restore'),
      readEntitlement: () =>
        Promise.resolve({
          premium: false,
          productId: null,
          expirationDate: null,
        }),
    },
    backend: {
      getAccess: () => hold<CanonicalAccessState>('getAccess'),
      syncBilling: () => hold<CanonicalBillingSync>('syncBilling'),
    },
  };
  const take = (name: CallName) => {
    const index = pending.findIndex(p => p.name === name);
    if (index < 0) throw new Error(`no pending ${name}`);
    const [entry] = pending.splice(index, 1);
    return entry!.d;
  };
  return { deps, pending, take };
}

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function readyStore(b: ReturnType<typeof billingDeps>) {
  configureAccessStore(b.deps);
  const init = useAccessStore.getState().initialize();
  await flush();
  b.take('configure').resolve(undefined);
  await flush();
  b.take('getAccess').resolve(access(false, 1));
  b.take('loadPlans').resolve(plans);
  await init;
  expect(useAccessStore.getState().status).toBe('ready');
  expect(useAccessStore.getState().canonicalAccess).toEqual(access(false, 1));
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

afterEach(() => {
  clearAccessStoreConfiguration();
});

describe('XC-ADJ-BEH-1 attack: accessStore write ordering', () => {
  for (const winner of [
    'purchaseSelected',
    'restorePurchases',
    'syncBilling',
  ] as const) {
    it(`${winner}: a refresh ISSUED after the verification request but ANSWERED after it (server read before the entitlement write) must not displace the verified membership`, async () => {
      const b = billingDeps();
      await readyStore(b);

      // 1. Verification starts: store step (if any) completes, the backend
      //    syncBilling request is on the wire, re-verifying with RevenueCat.
      const win = useAccessStore.getState()[winner]();
      await flush();
      if (winner === 'purchaseSelected') {
        b.take('purchase').resolve(entitlement);
        await flush();
      } else if (winner === 'restorePurchases') {
        b.take('restore').resolve(entitlement);
        await flush();
      }
      const sync = b.take('syncBilling');

      // 2. While the sync is in flight the user backs out to Settings (or an
      //    Analyze run unmounts) → refreshAccess() goes out. Its GET reaches
      //    the server BEFORE the sync wrote billing_entitlements, so the
      //    payload is the pre-purchase free snapshot.
      const refresh = useAccessStore.getState().refreshAccess();
      await flush();
      const staleGet = b.take('getAccess');

      // 3. The sync answers first with the verified membership.
      sync.resolve(premiumSync);
      expect(await win).toBe(true);
      expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);

      // 4. The refresh answers last, carrying the OLDER server snapshot.
      staleGet.resolve(access(false, 1));
      await refresh;

      const state = useAccessStore.getState();
      // Invariant from the cluster: a completed purchase is never displaced
      // by an older snapshot.
      expect(state.canonicalAccess?.premium).toBe(true);
      expect(state.canonicalAccess).toEqual(access(true));
    });
  }

  it('a NEWER refresh that fails must not discard an OLDER refresh that succeeded with a valid snapshot (fail-closed on a transient error the base commit recovered from)', async () => {
    const b = billingDeps();
    await readyStore(b);

    const slow = useAccessStore.getState().refreshAccess();
    await flush();
    const slowGet = b.take('getAccess');
    const fast = useAccessStore.getState().refreshAccess();
    await flush();
    const fastGet = b.take('getAccess');

    fastGet.reject(new Error('503'));
    expect(await fast).toBe(false);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();

    slowGet.resolve(access(false, 1));
    const landed = await slow;

    const state = useAccessStore.getState();
    // The server DID answer with a valid allowance; the account is not
    // "unavailable". Base commit 4d812e1a lands it; the candidate drops it.
    expect(landed).toBe(true);
    expect(state.canonicalAccess).toEqual(access(false, 1));
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
  });

  it('a syncBilling that FAILS must not discard an older refresh that succeeded (verification failure carries no server truth)', async () => {
    const b = billingDeps();
    await readyStore(b);

    const slow = useAccessStore.getState().refreshAccess();
    await flush();
    const slowGet = b.take('getAccess');
    const sync = useAccessStore.getState().syncBilling();
    await flush();
    b.take('syncBilling').reject(new Error('503'));
    expect(await sync).toBe(false);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();

    slowGet.resolve(access(false, 1));
    const landed = await slow;
    const state = useAccessStore.getState();
    expect(landed).toBe(true);
    expect(state.canonicalAccess).toEqual(access(false, 1));
    expect(state.status).toBe('ready');
  });

  it('initialize() dropped by a newer refresh must not swallow the offerings error (Paywall loses "pricing unavailable")', async () => {
    const b = billingDeps();
    configureAccessStore(b.deps);
    const init = useAccessStore.getState().initialize();
    await flush();
    b.take('configure').resolve(undefined);
    await flush();
    const initGet = b.take('getAccess');
    const initPlans = b.take('loadPlans');

    // An Analyze-unmount refresh lands while initialize is still loading.
    const refresh = useAccessStore.getState().refreshAccess();
    await flush();
    b.take('getAccess').resolve(access(false, 1));
    expect(await refresh).toBe(true);

    initGet.resolve(access(false, 1));
    initPlans.reject(new Error('offerings unavailable'));
    await init;

    const state = useAccessStore.getState();
    expect(state.plans).toBeNull();
    // Base commit 4d812e1a: status 'error' + billing.offerings_unavailable.
    expect(state.error?.code).toBe('billing.offerings_unavailable');
    expect(state.status).toBe('error');
  });

  it('initialize() dropped by a newer refresh must not swallow a store configure failure (billing.unconfigured is non-retryable and must surface)', async () => {
    const b = billingDeps();
    configureAccessStore(b.deps);
    const init = useAccessStore.getState().initialize();
    await flush();
    b.take('configure').reject(new Error('RevenueCat not configured'));
    await flush();
    const initGet = b.take('getAccess');

    const refresh = useAccessStore.getState().refreshAccess();
    await flush();
    b.take('getAccess').resolve(access(false, 1));
    expect(await refresh).toBe(true);

    initGet.resolve(access(false, 1));
    await init;

    const state = useAccessStore.getState();
    expect(state.plans).toBeNull();
    expect(state.error?.code).toBe('billing.unconfigured');
    expect(state.status).toBe('unconfigured');
  });
});
