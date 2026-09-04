/**
 * ADVERSARIAL PASS 3 — mobile-billing-paywall (access store layer).
 *
 *   S2  clearAccessStoreConfiguration() while store.purchase is pending:
 *       syncBilling must never run, state must be the defaults, and a later
 *       sign-in must not inherit stale premium.
 *   S1' the store's view of a stale plan id: purchaseSelected() with a plan
 *       the SDK no longer knows must fail closed and stay recoverable.
 *   extras: interleavings of refreshAccess / initialize with in-flight
 *       purchase and restore operations.
 *
 * Runs against the real zustand store with the real RevenueCat client (SDK
 * mocked) and a mocked canonical backend.
 *
 * Reproducers of confirmed defects are declared with `broken(...)` (see
 * attack-billing-clients.test.ts): `it.failing` until fixed;
 * ATTACK_SHOW_BROKEN=1 shows the raw assertion diff.
 */
import {
  BillingError,
  createRevenueCatBillingClient,
  type BillingAccessDependencies,
  type CanonicalAccessState,
  type CanonicalBillingSync,
  type RevenueCatPackageLike,
  type RevenueCatSdk,
  type StoreEntitlementState,
  type StorePlans,
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';

// The mobile tsconfig has no Node types (matches
// flow-app-store-compliance-ios-config.test.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
const { execSync } = require('child_process') as {
  execSync: (
    command: string,
    options: { cwd: string; encoding: 'utf8' },
  ) => string;
};

const broken = process.env.ATTACK_SHOW_BROKEN ? it : it.failing;

const USER_A = '11111111-1111-4111-8111-111111111111';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(ticks = 10) {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
}

function access(
  used: number,
  reserved = 0,
  premium = false,
): CanonicalAccessState {
  const remaining = 2 - used;
  const availableToReserve = remaining - reserved;
  const canStartRating = premium || availableToReserve > 0;
  return {
    premium,
    entitlements: premium ? ['premium', 'pickle_sensei_pro'] : [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

function sync(premium: boolean, used = 2): CanonicalBillingSync {
  return {
    billing: {
      premium,
      productKey: premium ? 'pickle_sensei_pro_annual' : null,
      expiresAt: null,
      verifiedAt: '2026-09-01T00:00:00.000Z',
    },
    access: access(used, 0, premium),
  };
}

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'default:annual:$rc_annual:pickle_sensei_pro_annual',
    productId: 'pickle_sensei_pro_annual',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: {
    id: 'default:monthly:$rc_monthly:pickle_sensei_pro_monthly',
    productId: 'pickle_sensei_pro_monthly',
    period: 'monthly',
    price: 7.99,
    priceString: '$7.99',
    pricePerMonthString: '$7.99',
    freeTrial: null,
  },
  lifetime: null,
};

const premiumEntitlement: StoreEntitlementState = {
  premium: true,
  productId: 'pickle_sensei_pro_annual',
  expirationDate: null,
};

type Deps = BillingAccessDependencies & {
  store: {
    configure: jest.Mock<Promise<void>, []>;
    loadPlans: jest.Mock<Promise<StorePlans>, []>;
    purchase: jest.Mock<Promise<StoreEntitlementState>, [string]>;
    restore: jest.Mock<Promise<StoreEntitlementState>, []>;
    readEntitlement: jest.Mock<Promise<StoreEntitlementState>, []>;
  };
  backend: {
    getAccess: jest.Mock<Promise<CanonicalAccessState>, []>;
    syncBilling: jest.Mock<Promise<CanonicalBillingSync>, []>;
  };
};

function deps(overrides?: {
  getAccess?: () => Promise<CanonicalAccessState>;
  syncBilling?: () => Promise<CanonicalBillingSync>;
  purchase?: (planId: string) => Promise<StoreEntitlementState>;
  restore?: () => Promise<StoreEntitlementState>;
  loadPlans?: () => Promise<StorePlans>;
  configure?: () => Promise<void>;
}): Deps {
  return {
    store: {
      configure: jest.fn(overrides?.configure ?? (async () => undefined)),
      loadPlans: jest.fn(overrides?.loadPlans ?? (async () => plans)),
      purchase: jest.fn(
        overrides?.purchase ?? (async () => premiumEntitlement),
      ),
      restore: jest.fn(overrides?.restore ?? (async () => premiumEntitlement)),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(overrides?.getAccess ?? (async () => access(1))),
      syncBilling: jest.fn(overrides?.syncBilling ?? (async () => sync(true))),
    },
  };
}

const DEFAULT_STATE = {
  status: 'idle',
  operation: 'idle',
  plans: null,
  selectedPeriod: 'annual',
  canonicalAccess: null,
  error: null,
};

function dataState() {
  const {
    status,
    operation,
    plans: p,
    selectedPeriod,
    canonicalAccess,
    error,
  } = useAccessStore.getState();
  return {
    status,
    operation,
    plans: p,
    selectedPeriod,
    canonicalAccess,
    error,
  };
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('S2 — sign-out while store.purchase is pending', () => {
  it('never calls syncBilling, leaves the defaults, and the next sign-in sees no stale premium', async () => {
    const pending = deferred<StoreEntitlementState>();
    const clientsA = deps({ purchase: () => pending.promise });
    configureAccessStore(clientsA);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().canonicalAccess).toEqual(access(1));

    const purchase = useAccessStore.getState().purchaseSelected();
    await settle();
    expect(useAccessStore.getState().operation).toBe('purchasing');
    expect(clientsA.store.purchase).toHaveBeenCalledWith(plans.annual!.id);

    // User signs out (authStore → clearAccessStoreConfiguration).
    clearAccessStoreConfiguration();
    expect(dataState()).toEqual(DEFAULT_STATE);

    // StoreKit finishes the purchase for the signed-out account.
    pending.resolve(premiumEntitlement);
    expect(await purchase).toBe(false);
    await settle();
    expect(clientsA.backend.syncBilling).not.toHaveBeenCalled();
    expect(dataState()).toEqual(DEFAULT_STATE);

    // A different account signs in: initialize() reflects ITS server truth.
    const clientsB = deps({ getAccess: async () => access(0) });
    configureAccessStore(clientsB);
    await useAccessStore.getState().initialize();
    expect(clientsB.backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess).toEqual(access(0));
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(false);
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().operation).toBe('idle');
  });

  it('the same account signing back in while the OLD purchase is pending: late resolution cannot leak into the new configuration', async () => {
    const pending = deferred<StoreEntitlementState>();
    const clientsA = deps({ purchase: () => pending.promise });
    configureAccessStore(clientsA);
    await useAccessStore.getState().initialize();
    const purchase = useAccessStore.getState().purchaseSelected();
    await settle();

    clearAccessStoreConfiguration();
    const clientsA2 = deps({ getAccess: async () => access(1) });
    configureAccessStore(clientsA2);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().status).toBe('ready');

    pending.resolve(premiumEntitlement);
    expect(await purchase).toBe(false);
    await settle();
    expect(clientsA.backend.syncBilling).not.toHaveBeenCalled();
    expect(clientsA2.backend.syncBilling).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess).toEqual(access(1));
    expect(useAccessStore.getState().operation).toBe('idle');
    expect(useAccessStore.getState().error).toBeNull();
  });

  it('a purchase REJECTION after sign-out leaves no error on the fresh state', async () => {
    const pending = deferred<StoreEntitlementState>();
    const clientsA = deps({ purchase: () => pending.promise });
    configureAccessStore(clientsA);
    await useAccessStore.getState().initialize();
    const purchase = useAccessStore.getState().purchaseSelected();
    await settle();
    clearAccessStoreConfiguration();
    pending.reject(
      new BillingError('billing.purchase_failed', 'declined', true),
    );
    expect(await purchase).toBe(false);
    expect(dataState()).toEqual(DEFAULT_STATE);
  });

  it('sign-out while syncBilling (post-purchase) is pending: the premium result is discarded', async () => {
    const pendingSync = deferred<CanonicalBillingSync>();
    const clientsA = deps({ syncBilling: () => pendingSync.promise });
    configureAccessStore(clientsA);
    await useAccessStore.getState().initialize();
    const purchase = useAccessStore.getState().purchaseSelected();
    await settle();
    expect(clientsA.backend.syncBilling).toHaveBeenCalledTimes(1);
    clearAccessStoreConfiguration();
    pendingSync.resolve(sync(true));
    expect(await purchase).toBe(false);
    expect(dataState()).toEqual(DEFAULT_STATE);
    // User B signs in and must not see A's membership.
    const clientsB = deps({ getAccess: async () => access(2) });
    configureAccessStore(clientsB);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(false);
    expect(useAccessStore.getState().canonicalAccess?.paywallRequired).toBe(
      true,
    );
  });

  it('rapid sign-out/sign-in churn (20x) during a pending purchase never lets a stale resolution through', async () => {
    const pendings: Array<ReturnType<typeof deferred<StoreEntitlementState>>> =
      [];
    const purchases: Array<Promise<boolean>> = [];
    const allDeps: Deps[] = [];
    for (let i = 0; i < 20; i += 1) {
      const pending = deferred<StoreEntitlementState>();
      pendings.push(pending);
      const clients = deps({
        purchase: () => pending.promise,
        getAccess: async () => access(i % 3),
      });
      allDeps.push(clients);
      configureAccessStore(clients);
      await useAccessStore.getState().initialize();
      if (useAccessStore.getState().canonicalAccess?.canStartRating) {
        purchases.push(useAccessStore.getState().purchaseSelected());
        await settle();
      }
      clearAccessStoreConfiguration();
    }
    for (const pending of pendings) pending.resolve(premiumEntitlement);
    await Promise.all(purchases);
    await settle();
    for (const clients of allDeps) {
      expect(clients.backend.syncBilling).not.toHaveBeenCalled();
    }
    expect(dataState()).toEqual(DEFAULT_STATE);
  });
});

// ---------------------------------------------------------------------------
// S1' — stale plan id through the store, using the REAL RevenueCat client
// ---------------------------------------------------------------------------

function storePackage(
  period: 'ANNUAL' | 'MONTHLY',
  suffix = '',
): RevenueCatPackageLike {
  const ids =
    period === 'ANNUAL'
      ? { pkg: '$rc_annual', product: 'pickle_sensei_pro_annual' }
      : { pkg: '$rc_monthly', product: 'pickle_sensei_pro_monthly' };
  return {
    identifier: `${ids.pkg}${suffix}`,
    packageType: period,
    product: {
      identifier: `${ids.product}${suffix}`,
      price: period === 'ANNUAL' ? 59.99 : 7.99,
      priceString: period === 'ANNUAL' ? '$59.99' : '$7.99',
      pricePerMonthString: period === 'ANNUAL' ? '$5.00' : '$7.99',
      introPrice: null,
      defaultOption: null,
    },
  };
}

function realStoreDeps(options: {
  getAccess?: () => Promise<CanonicalAccessState>;
}) {
  let offeringId = 'default';
  let suffix = '';
  let appUserId = USER_A;
  const sdk: RevenueCatSdk = {
    isConfigured: jest.fn(async () => true),
    configure: jest.fn(async () => undefined),
    getAppUserID: jest.fn(async () => appUserId),
    logIn: jest.fn(async id => {
      appUserId = id;
    }),
    getOfferings: jest.fn(async () => ({
      current: {
        identifier: offeringId,
        annual: storePackage('ANNUAL', suffix),
        monthly: storePackage('MONTHLY', suffix),
        lifetime: null,
      },
    })),
    purchasePackage: jest.fn(async () => ({
      customerInfo: {
        entitlements: {
          active: {
            premium: {
              productIdentifier: 'pickle_sensei_pro_annual',
              expirationDate: null,
            },
          },
        },
      },
    })),
    restorePurchases: jest.fn(async () => ({ entitlements: { active: {} } })),
    getCustomerInfo: jest.fn(async () => ({ entitlements: { active: {} } })),
    checkTrialOrIntroductoryPriceEligibility: jest.fn(async () => ({})),
  };
  const store = createRevenueCatBillingClient(
    { publicSdkKey: 'appl_public', canonicalAppUserId: USER_A },
    sdk,
    'ios',
  );
  const backend = {
    getAccess: jest.fn(options.getAccess ?? (async () => access(1))),
    syncBilling: jest.fn(async () => sync(true)),
  };
  return {
    clients: { store, backend } as BillingAccessDependencies,
    sdk,
    backend,
    rotateOffering(nextId: string, nextSuffix: string) {
      offeringId = nextId;
      suffix = nextSuffix;
    },
  };
}

describe("S1' — stale plan id via purchaseSelected() (real RevenueCat client)", () => {
  it('a rotated offering makes purchaseSelected() fail closed with offerings_unavailable and StoreKit is never reached', async () => {
    const harness = realStoreDeps({});
    configureAccessStore(harness.clients);
    await useAccessStore.getState().initialize();
    const staleId = useAccessStore.getState().plans!.annual!.id;
    expect(staleId).toBe('default:annual:$rc_annual:pickle_sensei_pro_annual');

    // Simulate the SDK's offering rotating: another loadPlans() (e.g. a
    // second initialize after Retry) repopulates the cache under new ids.
    harness.rotateOffering('spring_2026', '_v2');
    await harness.clients.store.loadPlans();

    // The store still holds the OLD plans object.
    expect(useAccessStore.getState().plans!.annual!.id).toBe(staleId);
    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    expect(harness.sdk.purchasePackage).not.toHaveBeenCalled();
    expect(harness.backend.syncBilling).not.toHaveBeenCalled();
    const state = useAccessStore.getState();
    expect(state.operation).toBe('idle');
    expect(state.error?.code).toBe('billing.offerings_unavailable');
    expect(state.error?.message).toBe(
      'That store plan is no longer available. Refresh pricing and try again.',
    );
    // status stays 'ready' with plans present → PaywallScreen hides Retry.
    expect(state.status).toBe('ready');
    expect(state.plans).not.toBeNull();
    expect(state.canonicalAccess).not.toBeNull();
  });

  it('the store and the client cache can only diverge through a direct client.loadPlans() call, which no production caller makes (initialize() is the sole loader and always writes plans)', async () => {
    const harness = realStoreDeps({});
    configureAccessStore(harness.clients);
    await useAccessStore.getState().initialize();
    harness.rotateOffering('spring_2026', '_v2');
    await harness.clients.store.loadPlans();
    (harness.sdk.getOfferings as jest.Mock).mockClear();

    // With a forced divergence the store fails closed on every attempt and
    // never re-reads offerings by itself: the only recovery is initialize().
    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    useAccessStore.getState().clearError();
    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.offerings_unavailable',
    );
    expect(harness.sdk.getOfferings).not.toHaveBeenCalled();
    expect(harness.sdk.purchasePackage).not.toHaveBeenCalled();

    // Production: every loadPlans() runs inside initialize(), which replaces
    // `plans` with the very result that repopulated the cache (or null when
    // it threw, after which the cache is also unusable) — so the two cannot
    // drift. Pinned by the source assertion below.
    const storeSource = readFileSync(
      join(__dirname, '..', '..', 'src', 'state', 'accessStore.ts'),
      'utf8',
    );
    expect(storeSource.match(/\.loadPlans\(\)/g)).toHaveLength(1);
    const appSource = execSync(
      "grep -rl 'loadPlans' src --include='*.ts' --include='*.tsx'",
      { cwd: join(__dirname, '..', '..'), encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .sort();
    expect(appSource).toEqual([
      'src/billing/revenueCatClient.ts',
      'src/billing/types.ts',
      'src/state/accessStore.ts',
    ]);
    // initialize() re-reads and the fresh id purchases.
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().plans!.annual!.id).toBe(
      'spring_2026:annual:$rc_annual_v2:pickle_sensei_pro_annual_v2',
    );
    expect(await useAccessStore.getState().purchaseSelected()).toBe(true);
  });

  it('after Retry (initialize again) purchaseSelected uses the FRESH plan id', async () => {
    let failAccess = true;
    const harness = realStoreDeps({
      getAccess: async () => {
        if (failAccess) throw new Error('backend down');
        return access(1);
      },
    });
    configureAccessStore(harness.clients);
    await useAccessStore.getState().initialize();
    // Plans loaded, canonicalAccess null → Paywall shows Retry.
    expect(useAccessStore.getState().plans!.offeringId).toBe('default');
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    const staleId = useAccessStore.getState().plans!.annual!.id;

    harness.rotateOffering('spring_2026', '_v2');
    failAccess = false;
    await useAccessStore.getState().initialize();
    const fresh = useAccessStore.getState().plans!;
    expect(fresh.offeringId).toBe('spring_2026');
    expect(fresh.annual!.id).not.toBe(staleId);

    expect(await useAccessStore.getState().purchaseSelected()).toBe(true);
    expect(harness.sdk.purchasePackage).toHaveBeenCalledTimes(1);
    const purchased = (harness.sdk.purchasePackage as jest.Mock).mock
      .calls[0]![0] as RevenueCatPackageLike;
    expect(purchased.product.identifier).toBe('pickle_sensei_pro_annual_v2');
  });
});

// ---------------------------------------------------------------------------
// extras — interleavings
// ---------------------------------------------------------------------------

describe('extra — refreshAccess() interleaved with purchase / restore', () => {
  broken(
    '[BROKEN P3] a refreshAccess() that lands after a failed restore wipes the "No active membership" error (accessStore.ts:199 sets error:null)',
    async () => {
      const clients = deps({
        restore: async () => ({
          premium: false,
          productId: null,
          expirationDate: null,
        }),
        syncBilling: async () => sync(false),
      });
      configureAccessStore(clients);
      await useAccessStore.getState().initialize();

      // A slow refreshAccess() (Settings focus / Analyze unmount) is still in
      // flight when the user taps Restore on the Paywall and the store answers.
      const pendingAccess = deferred<CanonicalAccessState>();
      clients.backend.getAccess.mockImplementationOnce(
        () => pendingAccess.promise,
      );
      const refresh = useAccessStore.getState().refreshAccess();
      await settle();
      expect(await useAccessStore.getState().restorePurchases()).toBe(false);
      expect(useAccessStore.getState().error?.code).toBe(
        'billing.restore_failed',
      );

      pendingAccess.resolve(access(2));
      await refresh;
      // Expected: the restore verdict stays visible (refreshAccess only
      // touched canonicalAccess). Observed: error cleared by refreshAccess.
      expect(useAccessStore.getState().error?.code).toBe(
        'billing.restore_failed',
      );
    },
  );

  broken(
    '[BROKEN P3] the same late refreshAccess() also wipes a purchase failure (offerings_unavailable) the user has not yet read',
    async () => {
      const clients = deps({
        purchase: async () => {
          throw new BillingError(
            'billing.offerings_unavailable',
            'That membership plan is unavailable from the app store.',
            true,
          );
        },
      });
      configureAccessStore(clients);
      await useAccessStore.getState().initialize();
      const pendingAccess = deferred<CanonicalAccessState>();
      clients.backend.getAccess.mockImplementationOnce(
        () => pendingAccess.promise,
      );
      const refresh = useAccessStore.getState().refreshAccess();
      await settle();
      expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
      expect(useAccessStore.getState().error?.code).toBe(
        'billing.offerings_unavailable',
      );
      pendingAccess.resolve(access(1));
      await refresh;
      expect(useAccessStore.getState().error?.code).toBe(
        'billing.offerings_unavailable',
      );
    },
  );

  it('the reverse order is safe: an error raised AFTER the refresh landed is kept', async () => {
    const clients = deps({
      restore: async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      }),
      syncBilling: async () => sync(false),
    });
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    await useAccessStore.getState().refreshAccess();
    expect(await useAccessStore.getState().restorePurchases()).toBe(false);
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.restore_failed',
    );
    expect(useAccessStore.getState().status).toBe('ready');
  });

  it('refreshAccess() during a pending purchase does not reset the purchasing operation', async () => {
    const pending = deferred<StoreEntitlementState>();
    const clients = deps({ purchase: () => pending.promise });
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    const purchase = useAccessStore.getState().purchaseSelected();
    await settle();
    expect(useAccessStore.getState().operation).toBe('purchasing');
    await useAccessStore.getState().refreshAccess();
    expect(useAccessStore.getState().operation).toBe('purchasing');
    expect(useAccessStore.getState().status).toBe('ready');
    // A second purchaseSelected while pending is refused (no double dispatch).
    expect(await useAccessStore.getState().purchaseSelected()).toBe(false);
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
    pending.resolve(premiumEntitlement);
    expect(await purchase).toBe(true);
  });

  it('refreshAccess() failure mid-purchase nulls canonicalAccess but the purchase still verifies through syncBilling', async () => {
    const pending = deferred<StoreEntitlementState>();
    const clients = deps({ purchase: () => pending.promise });
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    const purchase = useAccessStore.getState().purchaseSelected();
    await settle();
    clients.backend.getAccess.mockRejectedValueOnce(new Error('offline'));
    expect(await useAccessStore.getState().refreshAccess()).toBe(false);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(useAccessStore.getState().status).toBe('error');
    pending.resolve(premiumEntitlement);
    expect(await purchase).toBe(true);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().error).toBeNull();
  });

  it('initialize() completing while a purchase is pending resets operation to idle (store-level invariant probe)', async () => {
    // Not reachable from PaywallScreen (Retry is disabled while busy and
    // initialize() only auto-runs on status idle) — recorded here so any
    // future caller of initialize() during a purchase is caught.
    const pendingPlans = deferred<StorePlans>();
    const pendingPurchase = deferred<StoreEntitlementState>();
    const clients = deps({
      loadPlans: () => pendingPlans.promise,
      purchase: () => pendingPurchase.promise,
    });
    configureAccessStore(clients);
    // First initialize with plans so a plan can be selected.
    pendingPlans.resolve(plans);
    await useAccessStore.getState().initialize();
    // Second initialize hangs on loadPlans; purchase begins meanwhile.
    const hang = deferred<StorePlans>();
    clients.store.loadPlans.mockImplementationOnce(() => hang.promise);
    const init2 = useAccessStore.getState().initialize();
    await settle();
    expect(useAccessStore.getState().status).toBe('loading');
    const purchase = useAccessStore.getState().purchaseSelected();
    await settle();
    expect(useAccessStore.getState().operation).toBe('purchasing');
    hang.resolve(plans);
    await init2;
    const operationAfterInit = useAccessStore.getState().operation;
    pendingPurchase.resolve(premiumEntitlement);
    expect(await purchase).toBe(true);
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
    // Documented observation (INFERRED reachability: none from the UI):
    expect(operationAfterInit).toBe('idle');
  });
});
