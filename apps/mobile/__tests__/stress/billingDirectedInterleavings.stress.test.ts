/**
 * STRESS · mod-billing · concurrency lens — directed interleavings.
 *
 * Hand-scripted schedules on the same harness the seeded campaign uses
 * (`testing/stress/billingStressHarness.ts`): every native/network call is a
 * pending op settled by name, so each script is one exact interleaving of the
 * REAL access store + RevenueCat client + canonical access API.
 *
 * Tests named `REPRODUCES BUG` pin a reproduced defect: the scaffolding is
 * asserted strictly, then the OBSERVED (wrong) end state is asserted next to
 * the EXPECTED one in a comment. They fail the moment the store is fixed —
 * then invert the assertion and drop the matching KNOWN_BROKEN entry in
 * billingStoreConcurrency.stress.test.ts.
 */
import { getApiSession } from '../../src/account/apiSession';
import { useAccessStore } from '../../src/state/accessStore';
import {
  ACCOUNTS,
  CLEAN_WORLD,
  Driver,
  PRODUCTS,
  World,
  type Account,
} from '../../testing/stress/billingStressHarness';

const A = ACCOUNTS[0] as Account;
const B = ACCOUNTS[1] as Account;
const C = ACCOUNTS[2] as Account;

let world: World;
let driver: Driver;

function store() {
  return useAccessStore.getState();
}

/** Drain every pending op in FIFO order (a fully sequential device). */
async function drain(): Promise<void> {
  await world.scheduler.flush();
  while (world.scheduler.pending.length > 0) {
    const label = world.scheduler.pending[0]?.label ?? '';
    await world.scheduler.settle(label);
  }
  await world.scheduler.flush();
}

async function bootstrap(account: Account): Promise<void> {
  driver.signIn(account);
  const done = store().initialize();
  await drain();
  await done;
  expect(store()).toMatchObject({ status: 'ready', operation: 'idle' });
  expect(store().canonicalAccess?.premium).toBe(false);
  expect(store().plans?.annual?.productId).toBe(PRODUCTS.annual);
}

beforeEach(() => {
  world = new World(1, CLEAN_WORLD);
  driver = new Driver(world);
});

afterEach(() => {
  driver.dispose();
});

describe('duplicate calls and call-during-call', () => {
  it('50 concurrent purchaseSelected() calls reach StoreKit exactly once', async () => {
    await bootstrap(A);
    const burst = Array.from({ length: 50 }, () => store().purchaseSelected());
    await drain();
    const results = await Promise.all(burst);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(world.sdkPurchases).toHaveLength(1);
    expect(
      world.requests.filter(r => r.path === '/v1/billing/sync'),
    ).toHaveLength(1);
    expect(store()).toMatchObject({
      operation: 'idle',
      status: 'ready',
      error: null,
    });
    expect(store().canonicalAccess?.premium).toBe(true);
  });

  it('purchase, restore and sync fired together: one store op, one sync, others rejected', async () => {
    await bootstrap(A);
    const burst = [
      store().purchaseSelected(),
      store().restorePurchases(),
      store().syncBilling(),
      store().restorePurchases(),
      store().purchaseSelected(),
    ];
    await drain();
    const results = await Promise.all(burst);
    expect(results).toEqual([true, false, false, false, false]);
    expect(world.sdkPurchases).toHaveLength(1);
    expect(world.sdkRestoreCalls).toHaveLength(0);
    expect(
      world.requests.filter(r => r.path === '/v1/billing/sync'),
    ).toHaveLength(1);
  });

  it('initialize() during initialize() is a no-op; refreshAccess() bursts issue N requests but stay coherent', async () => {
    driver.signIn(A);
    const first = store().initialize();
    const second = store().initialize();
    const refreshes = Array.from({ length: 5 }, () => store().refreshAccess());
    await drain();
    await Promise.all([first, second, ...refreshes]);
    expect(world.sdkConfigureCalls).toBe(1);
    expect(world.requests.filter(r => r.path === '/v1/me/access')).toHaveLength(
      6,
    );
    expect(store()).toMatchObject({ status: 'ready', operation: 'idle' });
  });
});

describe('cancel-during-call', () => {
  it('user cancels the sheet: operation idle, no error, no sync, access untouched', async () => {
    await bootstrap(A);
    const before = store().canonicalAccess;
    world.nextPurchaseOutcome = 'cancelled';
    const purchase = store().purchaseSelected();
    await drain();
    expect(await purchase).toBe(false);
    expect(store()).toMatchObject({ operation: 'idle', error: null });
    expect(store().canonicalAccess).toBe(before);
    expect(
      world.requests.filter(r => r.path === '/v1/billing/sync'),
    ).toHaveLength(0);
  });

  it('a second tap while the sheet is up is rejected; the cancelled purchase leaves the store idle', async () => {
    await bootstrap(A);
    world.nextPurchaseOutcome = 'cancelled';
    const first = store().purchaseSelected();
    await world.scheduler.flush();
    expect(world.scheduler.has('sdk.purchasePackage')).toBe(true);
    const second = store().purchaseSelected();
    expect(await second).toBe(false);
    await drain();
    expect(await first).toBe(false);
    expect(world.sdkPurchases).toHaveLength(1);
    expect(store().operation).toBe('idle');
  });

  it('store purchase succeeds but /v1/billing/sync fails: fail closed, retryable error', async () => {
    await bootstrap(A);
    const purchase = store().purchaseSelected();
    await world.scheduler.flush();
    world.nextFetchOutcome = '500';
    await drain();
    expect(await purchase).toBe(false);
    expect(store().canonicalAccess).toBeNull();
    expect(store().error?.code).toBe('billing.backend_verification_pending');
    expect(store().error?.retryable).toBe(true);
    // The entitlement exists at RevenueCat; a later sync restores access.
    const sync = store().syncBilling();
    await drain();
    expect(await sync).toBe(true);
    expect(store().canonicalAccess?.premium).toBe(true);
  });
});

describe('token rotation / sign-out during a request', () => {
  it('rotation after the request was issued: request carries the bearer current at issue; a 401 for it is NOT reported', async () => {
    await bootstrap(A);
    const issuedWith = getApiSession()?.bearerToken;
    const refresh = store().refreshAccess();
    await world.scheduler.flush();
    const request = world.requests[world.requests.length - 1];
    expect(request?.token).toBe(issuedWith);
    world.rotateSession(); // revokes the old bearer server-side (deterministic)
    // The response was computed at issue time (200); simulate the server
    // having rejected the old bearer instead by issuing another request now.
    await drain();
    expect(await refresh).toBe(true);
    world.expireCurrentBearer();
    const stale = store().refreshAccess();
    await world.scheduler.flush();
    world.rotateSession(); // rotation lands before the 401
    await drain();
    expect(await stale).toBe(false);
    expect(world.unauthorizedReports).toHaveLength(0);
    expect(store().error?.code).toBe('billing.backend_unavailable');
  });

  it('401s for the CURRENT bearer are reported once per rejected request (apiSession does not dedupe)', async () => {
    await bootstrap(A);
    world.installUnauthorizedListener(() => undefined);
    world.expireCurrentBearer();
    const burst = [
      store().refreshAccess(),
      store().refreshAccess(),
      store().syncBilling(),
    ];
    await drain();
    expect(await Promise.all(burst)).toEqual([false, false, false]);
    // Every one of the three requests bore the still-current bearer, so the
    // session layer sees three reports; apiSession's contract is "report when
    // the rejected bearer is still current" (authStore.handleApiUnauthorized
    // is the single-flight layer).
    expect(world.unauthorizedReports).toHaveLength(
      world.expectedUnauthorizedReports,
    );
    expect(world.unauthorizedReports).toHaveLength(3);
  });

  it('sign-out while StoreKit purchase is pending: result discarded, no request with A token, store empty', async () => {
    await bootstrap(A);
    const purchase = store().purchaseSelected();
    await world.scheduler.flush();
    expect(world.scheduler.has('sdk.purchasePackage')).toBe(true);
    const requestsBefore = world.requests.length;
    driver.signOut();
    await drain();
    expect(await purchase).toBe(false);
    expect(world.requests).toHaveLength(requestsBefore);
    expect(store()).toMatchObject({
      status: 'idle',
      operation: 'idle',
      canonicalAccess: null,
      plans: null,
    });
  });

  it('sign-out then sign-in as B while A sync is pending: A response never reaches B store', async () => {
    await bootstrap(A);
    const purchase = store().purchaseSelected();
    await world.scheduler.flush();
    await world.scheduler.settle('sdk.purchasePackage');
    expect(world.scheduler.has('fetch#')).toBe(true);
    driver.signOut();
    driver.signIn(B);
    const initB = store().initialize();
    await drain();
    await Promise.all([purchase, initB]);
    expect(store().canonicalAccess?.premium).toBe(false);
    expect(world.tags.get(store().canonicalAccess as object)?.account).toBe(
      B.canonicalId,
    );
    for (const request of world.requests) {
      expect(request.tokenAccount).toBe(request.storeAccountAtIssue);
    }
  });
});

describe('two actors on one RevenueCat singleton (KNOWN BROKEN)', () => {
  /**
   * Interleaving: the device was last used by C (SDK configured). A signs in;
   * A's client sees appUserID=C and issues the network-bound `logIn(A)`. Before
   * that round-trip returns, the user signs out and B signs in; B's client's
   * local reads and its own `logIn(B)` complete first, so B's configure() is
   * resolved and cached. Then A's `logIn(A)` returns and rebinds the singleton
   * to A. Nothing in A's discarded bootstrap checks ownership before/after the
   * native call, and B's client never re-checks the singleton (configure() is
   * single-flight and cached for the client's lifetime).
   *
   * Observed: B's `purchasePackage` runs with appUserID=A, so the StoreKit
   * transaction is posted to A's RevenueCat ledger; B's `/v1/billing/sync`
   * finds no entitlement and B is told verification is pending.
   */
  it('REPRODUCES BUG: B signs in while A`s FIRST configure() is mid-flight; B`s purchase is attributed to A', async () => {
    driver.signIn(C);
    const initC = store().initialize();
    await drain();
    await initC;
    expect(world.sdkAppUserId).toBe(C.canonicalId);

    driver.signOut();
    driver.signIn(A);
    const initA = store().initialize();
    await world.scheduler.settle('sdk.isConfigured(A)');
    await world.scheduler.settle('sdk.getAppUserID(A)');
    expect(world.scheduler.has('sdk.logIn(A)')).toBe(true);

    driver.signOut();
    driver.signIn(B);
    const initB = store().initialize();
    await world.scheduler.settle('sdk.isConfigured(B)');
    await world.scheduler.settle('sdk.getAppUserID(B)');
    await world.scheduler.settle('sdk.logIn(B)');
    await world.scheduler.settle('sdk.getAppUserID(B)');
    await world.scheduler.settle('sdk.logIn(A)');
    await drain();
    await Promise.all([initA, initB]);

    const accessB = store().canonicalAccess;
    expect(accessB && world.tags.get(accessB)?.account).toBe(B.canonicalId);
    const singletonAfterBBootstrap = world.sdkAppUserId;

    const purchase = store().purchaseSelected();
    await drain();
    const verified = await purchase;
    const record = world.sdkPurchases[0];

    // EXPECTED: singleton=B, purchase invoked under B, entitlement on B,
    // verified=true. OBSERVED (pinned):
    expect(singletonAfterBBootstrap).toBe(A.canonicalId);
    expect(record?.appUserIdAtInvoke).toBe(A.canonicalId);
    expect(world.rcPremium.get(A.canonicalId)).toBe(PRODUCTS.annual);
    expect(world.rcPremium.has(B.canonicalId)).toBe(false);
    expect(verified).toBe(false);
    expect(store().error?.code).toBe('billing.backend_verification_pending');
  });
});

describe('initialize() completing during an in-flight operation (KNOWN BROKEN)', () => {
  /**
   * Paywall "Retry" starts initialize() (status=loading, operation stays
   * idle); the Continue button is only disabled by `operation`, so the user
   * taps it while offerings are still loading. When initialize() finishes it
   * writes `operation: 'idle'` unconditionally, erasing the in-flight
   * `purchasing` marker — the duplicate-call guard is now open while StoreKit
   * / `/v1/billing/sync` for the first purchase is still pending.
   * Seeded campaign hit: seed 493 (I6).
   */
  it('REPRODUCES BUG: a second purchasePackage() is accepted while the first is still in flight', async () => {
    await bootstrap(A);
    const init = store().initialize(); // configure() is cached: no SDK bootstrap ops
    await world.scheduler.settle('fetch#');
    expect(store()).toMatchObject({ status: 'loading', operation: 'idle' });

    const first = store().purchaseSelected();
    await world.scheduler.flush();
    expect(store().operation).toBe('purchasing');
    expect(world.scheduler.has('sdk.purchasePackage')).toBe(true);

    await world.scheduler.settle('sdk.getOfferings(A)');
    await init;
    expect(world.scheduler.pending.map(op => op.label)).toEqual([
      'sdk.purchasePackage(A:success)',
    ]);
    // EXPECTED: operation stays 'purchasing' until the purchase settles.
    // OBSERVED (pinned): initialize() reset it.
    expect(store().operation).toBe('idle');

    const second = store().purchaseSelected();
    await world.scheduler.flush();
    // EXPECTED: second === false, one StoreKit purchase in flight.
    // OBSERVED (pinned): two concurrent purchasePackage calls.
    expect(world.sdkPurchases).toHaveLength(2);
    expect(world.sdkPurchases[1]?.concurrentInFlight).toBe(1);
    await drain();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(
      world.requests.filter(r => r.path === '/v1/billing/sync'),
    ).toHaveLength(2);
  });
});

describe('freshness of canonicalAccess (KNOWN BROKEN)', () => {
  it('REPRODUCES BUG: restore verified premium during a slow initialize() is reverted by the older snapshot', async () => {
    await bootstrap(A);
    // Paywall "Retry" (or a re-mount) calls initialize() again; StoreKit
    // offerings are slow, the backend snapshot is fast.
    const init = store().initialize(); // configure() is cached: no SDK bootstrap ops
    await world.scheduler.settle('fetch#'); // getAccess → free snapshot (stale from here on)
    expect(store().status).toBe('loading');
    expect(world.scheduler.has('sdk.getOfferings(A)')).toBe(true);

    // Restore button is enabled (operation idle) while status is 'loading'.
    world.rcGrant(A.canonicalId, PRODUCTS.annual);
    const restore = store().restorePurchases();
    await world.scheduler.settle('sdk.restorePurchases(A)');
    await world.scheduler.settle('fetch#'); // /v1/billing/sync → premium
    expect(await restore).toBe(true);
    expect(store().canonicalAccess?.premium).toBe(true);

    // Offerings finally arrive; initialize() applies its stale access snapshot.
    await drain();
    await init;

    // EXPECTED: premium=true (server-verified AFTER the snapshot was issued).
    // OBSERVED (pinned): the older free snapshot wins; paywall re-appears.
    expect(store().canonicalAccess?.premium).toBe(false);
    expect(store().status).toBe('ready');
    expect(store().error).toBeNull();
  });

  it('REPRODUCES BUG: a newer refreshAccess() (ratings spent elsewhere) is overwritten by initialize()`s older count', async () => {
    await bootstrap(A);
    const init = store().initialize(); // configure() is cached: no SDK bootstrap ops
    await world.scheduler.settle('fetch#'); // used=0 snapshot
    world.serverSpend(A.canonicalId);
    world.serverSpend(A.canonicalId); // both free ratings spent on another device
    const refresh = store().refreshAccess();
    await world.scheduler.settle('fetch#');
    expect(await refresh).toBe(true);
    expect(store().canonicalAccess?.freeRatings.used).toBe(2);
    expect(store().canonicalAccess?.canStartRating).toBe(false);

    await drain();
    await init;

    // EXPECTED: used=2, canStartRating=false (newest server truth).
    // OBSERVED (pinned): the older snapshot re-opens the rating gate.
    expect(store().canonicalAccess?.freeRatings.used).toBe(0);
    expect(store().canonicalAccess?.canStartRating).toBe(true);
  });
});
