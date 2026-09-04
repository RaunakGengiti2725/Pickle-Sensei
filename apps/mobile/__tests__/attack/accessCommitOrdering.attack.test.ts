/**
 * Adversarial follow-up to xc-matrix::XC-ADJ-BEH-1 (candidate c033e3c1).
 *
 * The candidate suppresses a read (initialize / refreshAccess) whose result
 * lands after ANY other canonicalAccess commit. The finding only asked that
 * an OLDER read never displace a NEWER purchase/restore/sync. These scenarios
 * check what the same rule does to two overlapping READS and to an
 * initialize() that overlaps a refresh:
 *
 *   refreshInOrder   — refresh A issued first, refresh B issued second, both
 *                      responses land in issue order (the normal HTTP case).
 *                      B's snapshot reflects a ledger movement (a scored shot
 *                      synced between the two requests). The store must end
 *                      on B's snapshot: the later-issued read is the fresher
 *                      server truth, and nothing "verified" stood in between.
 *   initializePlansError — initialize() whose store step fails overlaps a
 *                      refreshAccess() that lands first: the offerings
 *                      failure must still be surfaced, not swallowed.
 *
 * Baseline 4d812e1a passes both (last-landed wins); the candidate fails both.
 */
import type { CanonicalAccessState, StorePlans } from '../../src/billing/types';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';

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

function access(used: number): CanonicalAccessState {
  const remaining = Math.max(0, 2 - used);
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
      used,
      reserved: 0,
      remaining,
      availableToReserve: remaining,
    },
    canStartRating: remaining > 0,
    paywallRequired: remaining === 0,
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

interface Calls {
  configure: number;
  loadPlans: number;
  getAccess: number;
}

function billingDeps() {
  const calls: Calls = { configure: 0, loadPlans: 0, getAccess: 0 };
  const pending: Array<{ name: keyof Calls; d: Deferred<unknown> }> = [];
  const hold = <T>(name: keyof Calls): Promise<T> => {
    calls[name] += 1;
    const d = deferred<T>();
    pending.push({ name, d: d as Deferred<unknown> });
    return d.promise;
  };
  const deps = {
    store: {
      configure: () => hold<void>('configure'),
      loadPlans: () => hold<StorePlans>('loadPlans'),
      purchase: () => Promise.reject(new Error('unused')),
      restore: () => Promise.reject(new Error('unused')),
      readEntitlement: () =>
        Promise.resolve({
          premium: false,
          productId: null,
          expirationDate: null,
        }),
    },
    backend: {
      getAccess: () => hold<CanonicalAccessState>('getAccess'),
      syncBilling: () => Promise.reject(new Error('unused')),
    },
  };
  return { deps, calls, pending };
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
  b.pending.find(p => p.name === 'configure')!.d.resolve(undefined);
  await flush();
  b.pending.find(p => p.name === 'getAccess')!.d.resolve(access(1));
  b.pending.find(p => p.name === 'loadPlans')!.d.resolve(plans);
  await init;
  b.pending.length = 0;
  expect(useAccessStore.getState().status).toBe('ready');
}

beforeEach(() => clearAccessStoreConfiguration());
afterEach(() => clearAccessStoreConfiguration());

describe('attack: two overlapping refreshAccess() reads landing in issue order', () => {
  it('keeps the LATER-issued snapshot (a scored shot synced between the reads)', async () => {
    const b = billingDeps();
    await readyStore(b);

    // A: Analyze unmount re-read, stalls on the wire (no client timeout on
    // GET /v1/me/access).
    const refreshA = useAccessStore.getState().refreshAccess();
    await flush();
    const getA = b.pending.find(p => p.name === 'getAccess')!;
    b.pending.length = 0;

    // Meanwhile the user scores their last free shot; its permit syncs, the
    // server ledger moves to used=2. The next Analyze unmount re-reads.
    const refreshB = useAccessStore.getState().refreshAccess();
    await flush();
    const getB = b.pending.find(p => p.name === 'getAccess')!;
    expect(getB).toBeDefined();
    expect(getB).not.toBe(getA);

    // Responses arrive in issue order: A (used=1) then B (used=2).
    getA.d.resolve(access(1));
    await flush();
    getB.d.resolve(access(2));
    await Promise.all([refreshA, refreshB]);

    const state = useAccessStore.getState();
    expect(state.status).toBe('ready');
    // The later read is the fresher server truth: 0 ratings left, paywall.
    expect(state.canonicalAccess).toEqual(access(2));
    expect(state.canonicalAccess?.canStartRating).toBe(false);
  });
});

describe('attack: initialize() store failure overlapping a refreshAccess() that lands first', () => {
  it('still surfaces the offerings failure instead of publishing plans=null with no error', async () => {
    const b = billingDeps();
    await readyStore(b);
    // A sign-in re-configures the store; the Paywall drives initialize().
    configureAccessStore(b.deps);
    const init = useAccessStore.getState().initialize();
    await flush();
    b.pending.find(p => p.name === 'configure')!.d.resolve(undefined);
    await flush();
    const initGet = b.pending.find(p => p.name === 'getAccess')!;
    const initPlans = b.pending.find(p => p.name === 'loadPlans')!;
    b.pending.length = 0;

    // A refresh (Analyze unmount; status is 'loading', not 'idle') lands
    // before the initialize() reads settle.
    const refresh = useAccessStore.getState().refreshAccess();
    await flush();
    b.pending.find(p => p.name === 'getAccess')!.d.resolve(access(1));
    await refresh;

    initGet.d.resolve(access(1));
    initPlans.d.reject(new Error('offerings unavailable'));
    await init;

    const state = useAccessStore.getState();
    expect(state.canonicalAccess).toEqual(access(1));
    expect(state.plans).toBeNull();
    // Store failure blocks purchase presentation: the Paywall needs the
    // error to explain the missing prices.
    expect(state.error?.code).toBe('billing.offerings_unavailable');
  });
});
