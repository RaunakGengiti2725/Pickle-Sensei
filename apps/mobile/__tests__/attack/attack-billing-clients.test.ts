/**
 * ADVERSARIAL PASS 3 — mobile-billing-paywall (client layer).
 *
 * Attacks the RevenueCat store client and the canonical access parser
 * directly (no store, no UI):
 *
 *   S1  stale plan ids after the offering rotates between loadPlans() calls
 *   S3  SDK already bound to a PRIOR account: logIn(new) must precede every
 *       offering / purchase call
 *   S6  reserved > remaining / negative availableToReserve must be rejected
 *       by parseAccess, never rendered as negative allowance copy
 *   S7  premium:true with only the canonical 'pickle_sensei_pro' entitlement
 *       (no 'premium' alias) is rejected by accessApi.ts:65; the UI ledgers
 *       hand-build exactly that shape and therefore never exercise the parser
 *
 * Seeded randomness (mulberry32) is used for the offering-rotation fuzz; the
 * seed is printed with every failure message.
 *
 * Reproducers of confirmed defects are declared with `broken(...)`: they
 * assert the EXPECTED behaviour and are registered through `it.failing`, so
 * the suite stays green while the defect exists and turns red the moment a
 * fix lands (flip them to `it`). Run with ATTACK_SHOW_BROKEN=1 to see the
 * raw assertion diffs.
 */
import {
  BillingError,
  createCanonicalAccessClient,
  createRevenueCatBillingClient,
  type CanonicalAccessState,
  type RevenueCatCustomerInfoLike,
  type RevenueCatPackageLike,
  type RevenueCatSdk,
} from '../../src/billing';
import { freeRatingAllowanceCopy } from '../../src/screens/paywallCopy';

// The mobile tsconfig has no Node types.
declare const process: { env: Record<string, string | undefined> };
declare const require: (id: string) => unknown;
declare const __dirname: string;

const broken = process.env.ATTACK_SHOW_BROKEN ? it : it.failing;

const CANONICAL_USER_ID = '11111111-1111-4111-8111-111111111111';
const PRIOR_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const SEED = 0x5eed_0003;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function customerInfo(
  premium: boolean,
  entitlementId: 'premium' | 'pickle_sensei_pro' = 'premium',
): RevenueCatCustomerInfoLike {
  return {
    entitlements: {
      active: premium
        ? {
            [entitlementId]: {
              productIdentifier: 'pickle_sensei_pro_annual',
              expirationDate: '2027-08-27T00:00:00.000Z',
            },
          }
        : {},
    },
  };
}

function storePackage(
  period: 'ANNUAL' | 'MONTHLY' | 'LIFETIME',
  suffix = '',
): RevenueCatPackageLike {
  const identifiers = {
    ANNUAL: { pkg: '$rc_annual', product: 'pickle_sensei_pro_annual' },
    MONTHLY: { pkg: '$rc_monthly', product: 'pickle_sensei_pro_monthly' },
    LIFETIME: { pkg: '$rc_lifetime', product: 'pickle_sensei_pro_lifetime' },
  }[period];
  const pricing = {
    ANNUAL: { price: 59.99, priceString: '$59.99', perMonth: '$5.00' },
    MONTHLY: { price: 7.99, priceString: '$7.99', perMonth: '$7.99' },
    LIFETIME: { price: 159.99, priceString: '$159.99', perMonth: null },
  }[period];
  return {
    identifier: `${identifiers.pkg}${suffix}`,
    packageType: period,
    product: {
      identifier: `${identifiers.product}${suffix}`,
      price: pricing.price,
      priceString: pricing.priceString,
      pricePerMonthString: pricing.perMonth,
      introPrice: null,
      defaultOption: null,
    },
  };
}

type Offering = {
  identifier: string;
  annual: RevenueCatPackageLike | null;
  monthly: RevenueCatPackageLike | null;
  lifetime: RevenueCatPackageLike | null;
};

function offering(identifier: string, suffix = ''): Offering {
  return {
    identifier,
    annual: storePackage('ANNUAL', suffix),
    monthly: storePackage('MONTHLY', suffix),
    lifetime: storePackage('LIFETIME', suffix),
  };
}

type SdkHarness = RevenueCatSdk & {
  calls: string[];
  setOffering(next: Offering | null): void;
  setAppUserId(id: string): void;
};

function sdk(options?: {
  configured?: boolean;
  appUserId?: string;
  offering?: Offering | null;
  /** When false, logIn "succeeds" without changing the SDK identity. */
  logInBinds?: boolean;
  logInError?: Error;
}): SdkHarness {
  const calls: string[] = [];
  let appUserId = options?.appUserId ?? CANONICAL_USER_ID;
  let configured = options?.configured ?? false;
  let current: Offering | null =
    options?.offering === undefined ? offering('default') : options.offering;
  return {
    calls,
    setOffering(next) {
      current = next;
    },
    setAppUserId(id) {
      appUserId = id;
    },
    isConfigured: jest.fn(async () => {
      calls.push('isConfigured');
      return configured;
    }),
    configure: jest.fn(async input => {
      calls.push(`configure:${input.appUserID}`);
      configured = true;
      appUserId = input.appUserID;
    }),
    getAppUserID: jest.fn(async () => {
      calls.push(`getAppUserID:${appUserId}`);
      return appUserId;
    }),
    logIn: jest.fn(async id => {
      calls.push(`logIn:${id}`);
      if (options?.logInError) throw options.logInError;
      if (options?.logInBinds !== false) appUserId = id;
    }),
    getOfferings: jest.fn(async () => {
      calls.push('getOfferings');
      return { current };
    }),
    purchasePackage: jest.fn(async (aPackage: RevenueCatPackageLike) => {
      calls.push(`purchasePackage:${aPackage.product.identifier}`);
      return { customerInfo: customerInfo(true) };
    }),
    restorePurchases: jest.fn(async () => {
      calls.push('restorePurchases');
      return customerInfo(true);
    }),
    getCustomerInfo: jest.fn(async () => {
      calls.push('getCustomerInfo');
      return customerInfo(false);
    }),
    checkTrialOrIntroductoryPriceEligibility: jest.fn(async () => {
      calls.push('checkTrialOrIntroductoryPriceEligibility');
      return {};
    }),
  };
}

function client(native: RevenueCatSdk) {
  return createRevenueCatBillingClient(
    { publicSdkKey: 'appl_public', canonicalAppUserId: CANONICAL_USER_ID },
    native,
    'ios',
  );
}

async function settle(ticks = 8) {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
}

async function billingErrorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BillingError) return error.code;
    throw new Error(`expected BillingError, got ${String(error)}`);
  }
  throw new Error('expected rejection, promise resolved');
}

describe('S1 — stale plan id after the offering rotates between loadPlans() calls', () => {
  it('purchase(oldPlanId) throws billing.offerings_unavailable and never reaches StoreKit', async () => {
    const native = sdk({ offering: offering('default') });
    const store = client(native);

    const first = await store.loadPlans();
    const oldAnnualId = first.annual!.id;
    const oldLifetimeId = first.lifetime!.id;
    expect(oldAnnualId).toBe(
      'default:annual:$rc_annual:pickle_sensei_pro_annual',
    );

    // RevenueCat rotates the current offering (experiment / targeting rule).
    native.setOffering(offering('spring_2026', '_v2'));
    const second = await store.loadPlans();
    expect(second.offeringId).toBe('spring_2026');
    expect(second.annual!.id).not.toBe(oldAnnualId);

    expect(await billingErrorCode(store.purchase(oldAnnualId))).toBe(
      'billing.offerings_unavailable',
    );
    expect(await billingErrorCode(store.purchase(oldLifetimeId))).toBe(
      'billing.offerings_unavailable',
    );
    expect(native.purchasePackage).not.toHaveBeenCalled();

    // The fresh id purchases the fresh package.
    await store.purchase(second.annual!.id);
    expect(native.purchasePackage).toHaveBeenCalledTimes(1);
    expect(native.calls.filter(c => c.startsWith('purchasePackage:'))).toEqual([
      'purchasePackage:pickle_sensei_pro_annual_v2',
    ]);
  });

  it('a second loadPlans() that fails with no current offering keeps the previous cache (ids still purchasable)', async () => {
    const native = sdk({ offering: offering('default') });
    const store = client(native);
    const first = await store.loadPlans();
    native.setOffering(null);
    expect(await billingErrorCode(store.loadPlans())).toBe(
      'billing.offerings_unavailable',
    );
    // The cache is only cleared once a current offering exists, so the plan
    // the user is still looking at can be purchased (consistent with the
    // store keeping plans: null on failure — see attack-billing-store).
    await store.purchase(first.annual!.id);
    expect(native.purchasePackage).toHaveBeenCalledTimes(1);
  });

  it('a second loadPlans() whose offering has no usable package clears the cache before throwing', async () => {
    const native = sdk({ offering: offering('default') });
    const store = client(native);
    const first = await store.loadPlans();
    native.setOffering({
      identifier: 'broken',
      annual: null,
      monthly: null,
      lifetime: null,
    });
    expect(await billingErrorCode(store.loadPlans())).toBe(
      'billing.offerings_unavailable',
    );
    expect(await billingErrorCode(store.purchase(first.annual!.id))).toBe(
      'billing.offerings_unavailable',
    );
    expect(native.purchasePackage).not.toHaveBeenCalled();
  });

  it('two in-flight loadPlans() calls: the cache reflects the LAST resolved offering, never a merge', async () => {
    const native = sdk({ offering: offering('A') });
    const store = client(native);
    await store.configure();

    const gates: Array<() => void> = [];
    const offerings = [offering('A', '_a'), offering('B', '_b')];
    (native.getOfferings as jest.Mock).mockImplementation(
      () =>
        new Promise(resolve => {
          const mine = offerings.shift()!;
          gates.push(() => resolve({ current: mine }));
        }),
    );
    const loadA = store.loadPlans();
    const loadB = store.loadPlans();
    await settle();
    expect(gates).toHaveLength(2);
    // B resolves first, then A: the cache ends holding A's packages while
    // B's caller received B's ids.
    gates[1]!();
    const plansB = await loadB;
    gates[0]!();
    const plansA = await loadA;

    expect(plansB.offeringId).toBe('B');
    expect(plansA.offeringId).toBe('A');
    expect(await billingErrorCode(store.purchase(plansB.annual!.id))).toBe(
      'billing.offerings_unavailable',
    );
    await store.purchase(plansA.annual!.id);
    expect(native.purchasePackage).toHaveBeenCalledTimes(1);
  });

  it(`fuzz(seed=${SEED}): across 200 random offering rotations every superseded id is refused and every live id is honored`, async () => {
    const rand = mulberry32(SEED);
    const native = sdk({ offering: offering('seed') });
    const store = client(native);
    const alphabet = ['default', 'promo', 'ünïcødé-🥒', 'x'.repeat(512), ''];
    let previous = await store.loadPlans();
    for (let round = 0; round < 200; round += 1) {
      const id = alphabet[Math.floor(rand() * alphabet.length)]!;
      const suffix = rand() < 0.5 ? '' : `_${Math.floor(rand() * 1e6)}`;
      const next = offering(id, suffix);
      if (rand() < 0.3) next.lifetime = null;
      if (rand() < 0.2) next.monthly = null;
      native.setOffering(next);
      const plans = await store.loadPlans();
      const liveIds = new Set(
        [plans.annual, plans.monthly, plans.lifetime]
          .filter((p): p is NonNullable<typeof p> => p !== null)
          .map(p => p.id),
      );
      for (const old of [
        previous.annual,
        previous.monthly,
        previous.lifetime,
      ]) {
        if (!old) continue;
        const outcome = await store.purchase(old.id).then(
          () => 'purchased',
          (error: unknown) =>
            error instanceof BillingError ? error.code : String(error),
        );
        const expected = liveIds.has(old.id)
          ? 'purchased'
          : 'billing.offerings_unavailable';
        if (outcome !== expected) {
          throw new Error(
            `seed=${SEED} round=${round} id=${JSON.stringify(old.id)} expected ${expected} got ${outcome}`,
          );
        }
      }
      previous = plans;
    }
  });
});

describe('S3 — SDK already configured for a PRIOR account', () => {
  it('logIn(newId) precedes getOfferings on loadPlans()', async () => {
    const native = sdk({ configured: true, appUserId: PRIOR_ACCOUNT_ID });
    const store = client(native);
    await store.loadPlans();
    const logInAt = native.calls.indexOf(`logIn:${CANONICAL_USER_ID}`);
    const offeringsAt = native.calls.indexOf('getOfferings');
    expect(logInAt).toBeGreaterThanOrEqual(0);
    expect(offeringsAt).toBeGreaterThan(logInAt);
    expect(native.configure).not.toHaveBeenCalled();
    // Post-login identity re-check happens before offerings are read.
    expect(native.calls.slice(0, offeringsAt)).toEqual([
      'isConfigured',
      `getAppUserID:${PRIOR_ACCOUNT_ID}`,
      `logIn:${CANONICAL_USER_ID}`,
      `getAppUserID:${CANONICAL_USER_ID}`,
    ]);
  });

  it('logIn(newId) precedes purchasePackage when purchase() is the first call on the client', async () => {
    const native = sdk({ configured: true, appUserId: PRIOR_ACCOUNT_ID });
    const store = client(native);
    // No plan is cached yet: purchase must still bind identity first and
    // then refuse the unknown id — StoreKit is never reached.
    expect(await billingErrorCode(store.purchase('default:annual:x:y'))).toBe(
      'billing.offerings_unavailable',
    );
    expect(native.calls).toEqual([
      'isConfigured',
      `getAppUserID:${PRIOR_ACCOUNT_ID}`,
      `logIn:${CANONICAL_USER_ID}`,
      `getAppUserID:${CANONICAL_USER_ID}`,
    ]);
    expect(native.purchasePackage).not.toHaveBeenCalled();
  });

  it('restore() and readEntitlement() also bind identity first', async () => {
    const native = sdk({ configured: true, appUserId: PRIOR_ACCOUNT_ID });
    const store = client(native);
    await store.restore();
    expect(native.calls.indexOf(`logIn:${CANONICAL_USER_ID}`)).toBeLessThan(
      native.calls.indexOf('restorePurchases'),
    );
    // Configuration is cached: a second call must not log in again.
    await store.readEntitlement();
    expect(native.logIn).toHaveBeenCalledTimes(1);
  });

  it('refuses to read offerings when logIn "succeeds" but the SDK still reports the prior account', async () => {
    const native = sdk({
      configured: true,
      appUserId: PRIOR_ACCOUNT_ID,
      logInBinds: false,
    });
    const store = client(native);
    expect(await billingErrorCode(store.loadPlans())).toBe(
      'billing.unconfigured',
    );
    expect(native.getOfferings).not.toHaveBeenCalled();
    // The failed configuration is not cached: the next attempt retries the
    // bind rather than replaying the failure.
    expect(await billingErrorCode(store.purchase('any'))).toBe(
      'billing.unconfigured',
    );
    expect(native.logIn).toHaveBeenCalledTimes(2);
    expect(native.purchasePackage).not.toHaveBeenCalled();
  });

  it('a rejected logIn surfaces and blocks offerings/purchase', async () => {
    const native = sdk({
      configured: true,
      appUserId: PRIOR_ACCOUNT_ID,
      logInError: new Error('network down'),
    });
    const store = client(native);
    await expect(store.loadPlans()).rejects.toThrow('network down');
    await expect(store.purchase('any')).rejects.toThrow('network down');
    expect(native.getOfferings).not.toHaveBeenCalled();
    expect(native.purchasePackage).not.toHaveBeenCalled();
  });

  it('concurrent first calls share ONE logIn and both wait for it', async () => {
    const native = sdk({ configured: true, appUserId: PRIOR_ACCOUNT_ID });
    let releaseLogIn!: () => void;
    (native.logIn as jest.Mock).mockImplementation(
      (id: string) =>
        new Promise<void>(resolve => {
          native.calls.push(`logIn:${id}`);
          releaseLogIn = () => {
            native.setAppUserId(id);
            resolve();
          };
        }),
    );
    const store = client(native);
    const plans = store.loadPlans();
    const entitlement = store.readEntitlement();
    await settle();
    expect(native.getOfferings).not.toHaveBeenCalled();
    expect(native.getCustomerInfo).not.toHaveBeenCalled();
    releaseLogIn();
    await Promise.all([plans, entitlement]);
    expect(native.logIn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Canonical access parser
// ---------------------------------------------------------------------------

function accessClient(payload: unknown, status = 200) {
  // Round-trip through JSON so NaN/-0/undefined behave as they would on the
  // wire (NaN → null, -0 → 0, undefined → dropped).
  const wire = JSON.parse(JSON.stringify(payload)) as unknown;
  const fetchFn = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => wire,
  })) as unknown as jest.MockedFunction<typeof fetch>;
  return createCanonicalAccessClient({
    baseUrl: 'https://api.test',
    token: 'token',
    fetchFn,
  });
}

type FreeRatingsOverride = Partial<
  Record<keyof CanonicalAccessState['freeRatings'], number>
>;

function payload(
  overrides: Partial<Omit<CanonicalAccessState, 'freeRatings'>> & {
    freeRatings?: FreeRatingsOverride;
  },
): Record<string, unknown> {
  return {
    premium: false,
    entitlements: [],
    canStartRating: true,
    paywallRequired: false,
    ...overrides,
    freeRatings: {
      limit: 2,
      used: 0,
      reserved: 0,
      remaining: 2,
      availableToReserve: 2,
      ...overrides.freeRatings,
    },
  };
}

describe('S6 — negative allowance corruption is rejected by parseAccess', () => {
  it('reserved:3 remaining:2 availableToReserve:-1 → billing.backend_invalid_response', async () => {
    const body = payload({
      canStartRating: false,
      paywallRequired: true,
      freeRatings: {
        used: 0,
        reserved: 3,
        remaining: 2,
        availableToReserve: -1,
      },
    });
    expect(await billingErrorCode(accessClient(body).getAccess())).toBe(
      'billing.backend_invalid_response',
    );
  });

  it('the same corruption via syncBilling is rejected too', async () => {
    const body = {
      billing: {
        premium: false,
        productKey: null,
        expiresAt: null,
        verifiedAt: '2026-09-01T00:00:00.000Z',
      },
      access: payload({
        canStartRating: false,
        paywallRequired: true,
        freeRatings: {
          used: 0,
          reserved: 3,
          remaining: 2,
          availableToReserve: -1,
        },
      }),
    };
    expect(await billingErrorCode(accessClient(body).syncBilling())).toBe(
      'billing.backend_invalid_response',
    );
  });

  it.each([
    [
      'availableToReserve off by one',
      { used: 0, reserved: 2, remaining: 2, availableToReserve: -1 },
    ],
    [
      'remaining inconsistent with used',
      { used: 1, reserved: 0, remaining: 2, availableToReserve: 2 },
    ],
    [
      'used above the limit',
      { used: 3, reserved: 0, remaining: -1, availableToReserve: -1 },
    ],
    [
      'negative reserved',
      { used: 0, reserved: -1, remaining: 2, availableToReserve: 3 },
    ],
    [
      'negative used',
      { used: -1, reserved: 0, remaining: 3, availableToReserve: 3 },
    ],
    [
      'non-integer reserved',
      { used: 0, reserved: 0.5, remaining: 2, availableToReserve: 1.5 },
    ],
    [
      'unsafe integer',
      { used: 0, reserved: 0, remaining: 2, availableToReserve: 2 ** 53 },
    ],
    [
      'NaN',
      { used: Number.NaN, reserved: 0, remaining: 2, availableToReserve: 2 },
    ],
  ])('%s → backend_invalid_response', async (_label, freeRatings) => {
    const body = payload({
      canStartRating: freeRatings.availableToReserve > 0,
      paywallRequired: !(freeRatings.availableToReserve > 0),
      freeRatings,
    });
    expect(await billingErrorCode(accessClient(body).getAccess())).toBe(
      'billing.backend_invalid_response',
    );
  });

  it('limit must be exactly 2, and -0 / 1e0 style numerics still parse as integers', async () => {
    expect(
      await billingErrorCode(
        accessClient(payload({ freeRatings: { limit: 3 } })).getAccess(),
      ),
    ).toBe('billing.backend_invalid_response');
    // Body produced by JSON.stringify with -0 becomes 0 — must parse fine.
    const ok = await accessClient(
      payload({ freeRatings: { used: -0, reserved: -0 } }),
    ).getAccess();
    expect(ok.freeRatings.availableToReserve).toBe(2);
  });

  it('paywallCopy would print a negative allowance if the parser let it through (documenting the guarded surface)', () => {
    const corrupt: CanonicalAccessState = {
      premium: false,
      entitlements: [],
      freeRatings: {
        limit: 2,
        used: 0,
        reserved: 3,
        remaining: 2,
        availableToReserve: -1,
      },
      canStartRating: false,
      paywallRequired: true,
    };
    // The copy layer trusts its input: this is why the parser is the gate.
    expect(freeRatingAllowanceCopy(corrupt)).toBe(
      '2 free ratings remain, but 3 captures are still being finalized.',
    );
  });
});

describe('S7 — canonical-only entitlement list is rejected by accessApi.ts:65', () => {
  const canonicalOnly = payload({
    premium: true,
    entitlements: ['pickle_sensei_pro'],
    canStartRating: true,
    paywallRequired: false,
    freeRatings: { used: 2, reserved: 0, remaining: 0, availableToReserve: 0 },
  });

  it("premium:true + entitlements:['pickle_sensei_pro'] → billing.backend_invalid_response", async () => {
    expect(
      await billingErrorCode(accessClient(canonicalOnly).getAccess()),
    ).toBe('billing.backend_invalid_response');
  });

  it("the alias form the edge function actually emits (['premium','pickle_sensei_pro']) parses", async () => {
    const access = await accessClient({
      ...canonicalOnly,
      entitlements: ['premium', 'pickle_sensei_pro'],
    }).getAccess();
    expect(access.premium).toBe(true);
    expect(access.entitlements).toEqual(['premium', 'pickle_sensei_pro']);
  });

  it("premium:false with a stray 'premium' entitlement is rejected as well", async () => {
    expect(
      await billingErrorCode(
        accessClient(
          payload({ premium: false, entitlements: ['premium'] }),
        ).getAccess(),
      ),
    ).toBe('billing.backend_invalid_response');
  });

  it('flags every hand-built UI fixture that uses the parser-rejected shape', async () => {
    // These are the literal `premiumAccess` fixtures from
    // __tests__/wf/PaywallScreen.buttons.test.tsx:76-88,
    // __tests__/wf/RootNavigator.buttons.test.tsx:283-295 and
    // __tests__/wf/SettingsScreen.buttons.test.tsx:314-326. They are
    // injected straight into useAccessStore as CanonicalAccessState, so
    // the parser never sees them. Fed through the real client they are
    // rejected — meaning those ledgers pass on a state the production
    // backend/parser pair can never produce.
    const fixture: CanonicalAccessState = {
      premium: true,
      entitlements: ['pickle_sensei_pro'],
      freeRatings: {
        limit: 2,
        used: 2,
        reserved: 0,
        remaining: 0,
        availableToReserve: 0,
      },
      canStartRating: true,
      paywallRequired: false,
    };
    expect(await billingErrorCode(accessClient(fixture).getAccess())).toBe(
      'billing.backend_invalid_response',
    );

    // Derive the flagged set from source so the list cannot go stale: every
    // wf test whose `premium: true` fixture lists ONLY the canonical id.
    const { execSync } = require('child_process') as {
      execSync: (
        command: string,
        options: { cwd: string; encoding: 'utf8' },
      ) => string;
    };
    const { join } = require('path') as {
      join: (...parts: string[]) => string;
    };
    const flagged = execSync(
      'grep -rlE "entitlements: \\[\'pickle_sensei_pro\'\\]" __tests__/wf',
      { cwd: join(__dirname, '..', '..'), encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .sort();
    expect(flagged).toEqual(
      [
        // Exercises the parser and EXPECTS the rejection — not a bypass.
        '__tests__/wf/be-billing-entitlement-sync.test.ts',
        // The three named by the coordinator + two more with the same
        // shape, all injected straight into useAccessStore (parser bypassed).
        '__tests__/wf/PaywallScreen.buttons.test.tsx',
        '__tests__/wf/RootNavigator.buttons.test.tsx',
        '__tests__/wf/SettingsScreen.buttons.test.tsx',
        '__tests__/wf/flow-app-store-compliance-paywall.test.tsx',
        '__tests__/wf/flow-settings-about.test.tsx',
      ].sort(),
    );
  });
});

describe('extra — paywallCopy grammar on the singular reserved branch', () => {
  broken(
    '[BROKEN P3] "1 free rating remain" is ungrammatical (singular subject, plural verb)',
    () => {
      const copy = freeRatingAllowanceCopy({
        premium: false,
        entitlements: [],
        freeRatings: {
          limit: 2,
          used: 1,
          reserved: 1,
          remaining: 1,
          availableToReserve: 0,
        },
        canStartRating: false,
        paywallRequired: true,
      });
      // Documented failure: the sentence produced is
      // "1 free rating remain, but 1 capture is still being finalized."
      expect(copy).not.toMatch(/^1 free rating remain,/);
    },
  );
});
