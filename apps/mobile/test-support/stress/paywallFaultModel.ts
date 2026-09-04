/**
 * Fault model for the PaywallScreen failure-injection campaign
 * (`__tests__/stress/paywallScreen.failureInjection.test.tsx`).
 *
 * Everything here is deterministic given a seed: the RNG, the scenario a
 * seed expands to, and the fake RevenueCat SDK / canonical-access backend
 * that the scenario's faults are injected into. The suite renders the real
 * RootNavigator → PaywallRoute → PaywallScreen against the real accessStore
 * and the real billing clients; only the two leaf dependencies below (the
 * native RevenueCat SDK and `fetch`) plus `Linking.openURL` are replaced.
 *
 * Dependency graph of the unit (INFERRED from src, pinned by the suite):
 *   PaywallScreen → accessStore → billing/revenueCatClient → react-native-purchases
 *                                → billing/accessApi        → fetch
 *                → RootNavigator PaywallRoute → navigation.goBack, Linking.openURL
 *                → Animated / BackHandler (clock, hardware back)
 * SQLite, Keychain, camera, Vision, TTS and permissions are NOT on this
 * screen's path; the suite proves that by registering throwing mocks for
 * them and asserting they were never loaded.
 */
import type {
  RevenueCatCustomerInfoLike,
  RevenueCatPackageLike,
  RevenueCatSdk,
} from '../../src/billing/revenueCatClient';
import type { BillingFetch } from '../../src/billing/accessApi';

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

// ─── Fault catalogue ─────────────────────────────────────────────────────────

export const INIT_SITES = [
  'rc.isConfigured',
  'rc.configure',
  'rc.getAppUserID',
  'rc.logIn',
  'rc.getOfferings',
  'rc.trialEligibility',
  'api.getAccess',
] as const;

export const ACTION_SITES = [
  'rc.purchasePackage',
  'rc.restorePurchases',
  'api.billingSync',
  'native.openURL',
] as const;

export type FaultSite =
  (typeof INIT_SITES)[number] | (typeof ACTION_SITES)[number];
export const ALL_SITES: readonly FaultSite[] = [...INIT_SITES, ...ACTION_SITES];

export const FAULT_MODES = [
  'throw',
  'reject',
  'timeout',
  'malformed',
  'partial',
  'slow',
  'never',
  'http401',
  'http429',
  'http500',
  'http503',
  'nonJson',
] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

export interface Fault {
  site: FaultSite;
  mode: FaultMode;
  /** For `slow` / `timeout`: fake-clock delay before the promise settles. */
  delayMs: number;
  /** Selects between several malformed/partial payload shapes for a site. */
  variant: number;
}

const HTTP_MODES: readonly FaultMode[] = [
  'http401',
  'http429',
  'http500',
  'http503',
  'nonJson',
];

/** Which fault modes are meaningful for a given dependency call. */
export function modesFor(site: FaultSite): readonly FaultMode[] {
  const base: FaultMode[] = ['throw', 'reject', 'timeout', 'slow', 'never'];
  switch (site) {
    case 'api.getAccess':
    case 'api.billingSync':
      return [...base, 'malformed', 'partial', ...HTTP_MODES];
    case 'rc.getOfferings':
    case 'rc.purchasePackage':
    case 'rc.restorePurchases':
    case 'rc.getAppUserID':
    case 'rc.isConfigured':
    case 'rc.trialEligibility':
      return [...base, 'malformed', 'partial'];
    case 'rc.configure':
    case 'rc.logIn':
    case 'native.openURL':
      return base;
  }
}

/** Every (site × applicable mode) pair — the deterministic catalogue pass. */
export function faultCatalogue(): Array<{ site: FaultSite; mode: FaultMode }> {
  const list: Array<{ site: FaultSite; mode: FaultMode }> = [];
  for (const site of ALL_SITES) {
    for (const mode of modesFor(site)) list.push({ site, mode });
  }
  return list;
}

export function faultLabel(fault: Fault): string {
  const suffix =
    fault.mode === 'slow' || fault.mode === 'timeout'
      ? `@${fault.delayMs}ms`
      : fault.mode === 'malformed' || fault.mode === 'partial'
        ? `#${fault.variant}`
        : '';
  return `${fault.site}:${fault.mode}${suffix}`;
}

// ─── Scenario ────────────────────────────────────────────────────────────────

export type Entry = 'analyze-gate' | 'direct';
export type Action =
  'purchase' | 'restore' | 'legal-terms' | 'legal-privacy' | 'none';
export type Disruption = 'none' | 'unmount-midflight' | 'signout-midflight';
export type Period = 'annual' | 'monthly' | 'lifetime';

export interface Scenario {
  id: string;
  seed: number;
  entry: Entry;
  /** Free ratings the backend reports as available on first load. */
  accessRemaining: 0 | 1 | 2;
  /** Whether the store (RevenueCat) reports a local entitlement after
   * purchase/restore. Deliberately independent of the backend answer. */
  storeEntitlement: boolean;
  /** Whether the backend's billing sync verifies premium. */
  backendPremiumAfterSync: boolean;
  /** Offerings carry an introductory free trial on the annual package
   * (the only case in which the SDK's trial-eligibility call is made). */
  trialOnAnnual: boolean;
  /** The native SDK is already configured under an anonymous app user id
   * when the store is wired (the only case in which `logIn` is called). */
  sdkPreconfigured: boolean;
  /** System-clock skew applied before rendering (ms, may be negative). */
  clockSkewMs: number;
  selectPeriod: Period;
  initFaults: Fault[];
  action: Action;
  actionFaults: Fault[];
  disruption: Disruption;
}

function makeFault(rng: Rng, site: FaultSite, mode: FaultMode): Fault {
  return {
    site,
    mode,
    delayMs:
      mode === 'timeout'
        ? 30_000
        : mode === 'slow'
          ? 2_000 + rng.int(43_000)
          : 0,
    variant: rng.int(4),
  };
}

function actionSitesFor(action: Action): FaultSite[] {
  switch (action) {
    case 'purchase':
      return ['rc.purchasePackage', 'api.billingSync'];
    case 'restore':
      return ['rc.restorePurchases', 'api.billingSync'];
    case 'legal-terms':
    case 'legal-privacy':
      return ['native.openURL'];
    case 'none':
      return [];
  }
}

function actionForSite(site: FaultSite, rng: Rng): Action {
  switch (site) {
    case 'rc.purchasePackage':
      return 'purchase';
    case 'rc.restorePurchases':
      return 'restore';
    case 'api.billingSync':
      return rng.chance(0.5) ? 'purchase' : 'restore';
    case 'native.openURL':
      return rng.chance(0.5) ? 'legal-terms' : 'legal-privacy';
    default:
      return rng.pick(['purchase', 'restore', 'none', 'legal-terms'] as const);
  }
}

/** Random scenario for a seed. Always injects at least one fault. */
export function scenarioForSeed(seed: number): Scenario {
  const rng = new Rng(seed);
  const entry: Entry = rng.chance(0.5) ? 'analyze-gate' : 'direct';
  // The Analyze gate only lands on the paywall when no free rating is left.
  const accessRemaining: 0 | 1 | 2 =
    entry === 'analyze-gate' ? 0 : rng.pick([0, 0, 1, 2] as const);

  const initFaults: Fault[] = [];
  const initCount = rng.pick([0, 1, 1, 1, 2] as const);
  const initPool = [...INIT_SITES];
  for (let i = 0; i < initCount && initPool.length > 0; i += 1) {
    const site = initPool.splice(rng.int(initPool.length), 1)[0]!;
    initFaults.push(makeFault(rng, site, rng.pick(modesFor(site))));
  }

  const action: Action = rng.pick([
    'purchase',
    'purchase',
    'restore',
    'legal-terms',
    'legal-privacy',
    'none',
  ] as const);
  const actionFaults: Fault[] = [];
  const actionSites = actionSitesFor(action);
  if (actionSites.length > 0 && (initFaults.length === 0 || rng.chance(0.7))) {
    const site = rng.pick(actionSites);
    actionFaults.push(makeFault(rng, site, rng.pick(modesFor(site))));
  }
  if (initFaults.length === 0 && actionFaults.length === 0) {
    const site = rng.pick(INIT_SITES);
    initFaults.push(makeFault(rng, site, rng.pick(modesFor(site))));
  }

  const disruption: Disruption =
    action === 'purchase' || action === 'restore'
      ? rng.pick([
          'none',
          'none',
          'none',
          'unmount-midflight',
          'signout-midflight',
        ] as const)
      : 'none';

  const faults = [...initFaults, ...actionFaults];
  return {
    id: `seed:${seed}`,
    seed,
    entry,
    accessRemaining,
    storeEntitlement: rng.chance(0.5),
    backendPremiumAfterSync: rng.chance(0.5),
    trialOnAnnual:
      faults.some(f => f.site === 'rc.trialEligibility') || rng.chance(0.3),
    sdkPreconfigured:
      faults.some(f => f.site === 'rc.logIn') || rng.chance(0.3),
    clockSkewMs: rng.pick([
      0,
      0,
      0,
      -86_400_000 * 400,
      86_400_000 * 400,
      -3_600_000,
    ]),
    selectPeriod: rng.pick([
      'annual',
      'annual',
      'monthly',
      'lifetime',
    ] as const),
    initFaults,
    action,
    actionFaults,
    disruption,
  };
}

/** One catalogue scenario: exactly one fault, otherwise healthy. */
export function scenarioForCatalogue(
  index: number,
  site: FaultSite,
  mode: FaultMode,
): Scenario {
  const seed = 1_000_000 + index;
  const rng = new Rng(seed);
  const fault = makeFault(rng, site, mode);
  const isInit = (INIT_SITES as readonly string[]).includes(site);
  const action = isInit ? 'none' : actionForSite(site, rng);
  return {
    id: `catalogue:${site}:${mode}`,
    seed,
    entry: 'direct',
    accessRemaining: 0,
    storeEntitlement: true,
    backendPremiumAfterSync: false,
    trialOnAnnual: site === 'rc.trialEligibility',
    sdkPreconfigured: site === 'rc.logIn',
    clockSkewMs: 0,
    selectPeriod: 'annual',
    initFaults: isInit ? [fault] : [],
    action,
    actionFaults: isInit ? [] : [fault],
    disruption: 'none',
  };
}

/** Fault-free positive controls: they prove the oracle accepts the legitimate
 * outcomes (paywall pops only after a backend-verified premium sync; a store
 * entitlement the backend does not confirm keeps the paywall up with a
 * visible message) so a fully-HELD campaign is not a vacuous pass. */
export function controlScenarios(): Scenario[] {
  const base = {
    entry: 'direct' as const,
    accessRemaining: 0 as const,
    trialOnAnnual: true,
    sdkPreconfigured: false,
    clockSkewMs: 0,
    selectPeriod: 'annual' as const,
    initFaults: [],
    actionFaults: [],
    disruption: 'none' as const,
  };
  return [
    {
      ...base,
      id: 'control:purchase-verified',
      seed: 2_000_000,
      storeEntitlement: true,
      backendPremiumAfterSync: true,
      action: 'purchase',
    },
    {
      ...base,
      id: 'control:restore-verified',
      seed: 2_000_001,
      storeEntitlement: true,
      backendPremiumAfterSync: true,
      action: 'restore',
    },
    {
      ...base,
      id: 'control:purchase-store-only',
      seed: 2_000_002,
      storeEntitlement: true,
      backendPremiumAfterSync: false,
      action: 'purchase',
    },
    {
      ...base,
      id: 'control:restore-nothing-to-restore',
      seed: 2_000_003,
      storeEntitlement: false,
      backendPremiumAfterSync: false,
      action: 'restore',
    },
  ];
}

export function scenarioFaults(scenario: Scenario): Fault[] {
  return [...scenario.initFaults, ...scenario.actionFaults];
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

export const CANONICAL_USER_ID = '2f1c6c2e-9b7a-4c1e-8f3d-1a2b3c4d5e6f';
export const API_BASE_URL = 'https://api.example.test/functions/v1/api';
export const PUBLIC_SDK_KEY = 'appl_test_public_key';
export const BEARER = 'supabase-access-token';

export function storePackage(
  period: 'ANNUAL' | 'MONTHLY' | 'LIFETIME',
  options?: { trial?: boolean },
): RevenueCatPackageLike {
  const identifiers = {
    ANNUAL: { pkg: '$rc_annual', product: 'pickle_sensei_pro_yearly' },
    MONTHLY: { pkg: '$rc_monthly', product: 'pickle_sensei_pro_monthly' },
    LIFETIME: { pkg: '$rc_lifetime', product: 'pickle_sensei_pro_lifetime' },
  }[period];
  const pricing = {
    ANNUAL: { price: 59.99, priceString: '$59.99', perMonth: '$5.00' },
    MONTHLY: { price: 7.99, priceString: '$7.99', perMonth: '$7.99' },
    LIFETIME: { price: 159.99, priceString: '$159.99', perMonth: null },
  }[period];
  return {
    identifier: identifiers.pkg,
    packageType: period,
    product: {
      identifier: identifiers.product,
      price: pricing.price,
      priceString: pricing.priceString,
      pricePerMonthString: pricing.perMonth,
      introPrice: options?.trial
        ? { price: 0, cycles: 1, period: 'P7D' }
        : null,
      defaultOption: null,
    },
  };
}

export function customerInfo(premium: boolean): RevenueCatCustomerInfoLike {
  return {
    entitlements: {
      active: premium
        ? {
            pickle_sensei_pro: {
              productIdentifier: 'pickle_sensei_pro_yearly',
              expirationDate: null,
            },
          }
        : {},
    },
  };
}

export function accessBody(remaining: 0 | 1 | 2, premium: boolean) {
  const used = 2 - remaining;
  const canStart = premium || remaining > 0;
  return {
    premium,
    entitlements: premium ? ['premium'] : [],
    freeRatings: {
      limit: 2,
      used,
      reserved: 0,
      remaining,
      availableToReserve: remaining,
    },
    canStartRating: canStart,
    paywallRequired: !canStart,
  };
}

export function syncBody(remaining: 0 | 1 | 2, premium: boolean) {
  return {
    billing: {
      premium,
      productKey: premium ? 'pickle_sensei_pro_yearly' : null,
      expiresAt: null,
      verifiedAt: '2026-09-04T00:00:00.000Z',
    },
    access: accessBody(remaining, premium),
  };
}

// ─── Fault injection runtime ─────────────────────────────────────────────────

export interface CallRecord {
  site: FaultSite;
  fault: string | null;
  at: number;
}

/**
 * Holds the currently armed faults. Faults are armed per phase (init /
 * action) and disarmed by the driver before the recovery step, so a fault
 * fires on every call while armed and never afterwards.
 */
export class FaultBox {
  private armed = new Map<FaultSite, Fault>();
  readonly calls: CallRecord[] = [];
  private clock: () => number;

  constructor(clock: () => number) {
    this.clock = clock;
  }

  arm(faults: readonly Fault[]): void {
    for (const fault of faults) this.armed.set(fault.site, fault);
  }

  disarm(): void {
    this.armed.clear();
  }

  armedFault(site: FaultSite): Fault | null {
    return this.armed.get(site) ?? null;
  }

  record(site: FaultSite): Fault | null {
    const fault = this.armedFault(site);
    this.calls.push({
      site,
      fault: fault ? faultLabel(fault) : null,
      at: this.clock(),
    });
    return fault;
  }

  callCount(site: FaultSite): number {
    return this.calls.filter(call => call.site === site).length;
  }
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function after<T>(delayMs: number, settle: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(settle());
      } catch (error) {
        reject(error);
      }
    }, delayMs);
  });
}

/**
 * Applies the generic (non-payload) fault modes to a dependency call. The
 * caller supplies the healthy result and the site-specific malformed /
 * partial payloads; HTTP modes are handled by the backend only.
 */
function inject<T>(
  fault: Fault | null,
  healthy: () => T,
  shaped: {
    malformed: (variant: number) => T;
    partial: (variant: number) => T;
  },
): Promise<T> {
  if (!fault) return Promise.resolve(healthy());
  switch (fault.mode) {
    case 'throw':
      throw new Error(`injected throw at ${fault.site}`);
    case 'reject':
      return Promise.reject(new Error(`injected reject at ${fault.site}`));
    case 'timeout':
      return after(fault.delayMs, () => {
        throw new Error(`injected timeout at ${fault.site}`);
      });
    case 'slow':
      return after(fault.delayMs, healthy);
    case 'never':
      return never<T>();
    case 'malformed':
      return Promise.resolve(shaped.malformed(fault.variant));
    case 'partial':
      return Promise.resolve(shaped.partial(fault.variant));
    case 'http401':
    case 'http429':
    case 'http500':
    case 'http503':
    case 'nonJson':
      // Only meaningful for the backend; a store call treats it as a reject.
      return Promise.reject(
        new Error(`injected ${fault.mode} at ${fault.site}`),
      );
  }
}

type Offerings = Awaited<ReturnType<RevenueCatSdk['getOfferings']>>;

export interface FakeRevenueCat {
  sdk: RevenueCatSdk;
  /** The app user id the SDK currently reports (null before configure). */
  appUserId: () => string | null;
}

export function fakeRevenueCat(
  scenario: Scenario,
  box: FaultBox,
): FakeRevenueCat {
  let configured = scenario.sdkPreconfigured;
  let appUserId: string | null = scenario.sdkPreconfigured
    ? '$RCAnonymousID:deadbeef'
    : null;
  const annual = storePackage('ANNUAL', { trial: scenario.trialOnAnnual });
  const monthly = storePackage('MONTHLY');
  const lifetime = storePackage('LIFETIME');

  const brokenPackage = (variant: number): RevenueCatPackageLike => {
    const base = storePackage('ANNUAL');
    switch (variant % 4) {
      case 0:
        return { ...base, product: { ...base.product, price: Number.NaN } };
      case 1:
        return { ...base, product: { ...base.product, priceString: '' } };
      case 2:
        return { ...base, packageType: 'CUSTOM' };
      default:
        return { ...base, product: { ...base.product, price: -1 } };
    }
  };

  const sdk: RevenueCatSdk = {
    isConfigured: () =>
      inject(box.record('rc.isConfigured'), () => configured, {
        // Wrong types the native bridge could hand back.
        malformed: variant =>
          (variant % 2 === 0 ? 'yes' : 1) as unknown as boolean,
        partial: () => undefined as unknown as boolean,
      }),
    configure: configuration =>
      inject(
        box.record('rc.configure'),
        () => {
          configured = true;
          appUserId = configuration.appUserID;
        },
        { malformed: () => undefined, partial: () => undefined },
      ),
    getAppUserID: () =>
      inject(
        box.record('rc.getAppUserID'),
        () => appUserId ?? '$RCAnonymousID:deadbeef',
        {
          malformed: variant =>
            (variant % 2 === 0
              ? 'not-the-canonical-user'
              : null) as unknown as string,
          partial: () => '' as string,
        },
      ),
    logIn: id =>
      inject(
        box.record('rc.logIn'),
        () => {
          appUserId = id;
          return { customerInfo: customerInfo(false), created: false };
        },
        { malformed: () => null, partial: () => ({}) },
      ),
    getOfferings: () =>
      inject(
        box.record('rc.getOfferings'),
        () => ({
          current: { identifier: 'default', annual, monthly, lifetime },
        }),
        {
          malformed: variant =>
            variant % 3 === 0
              ? { current: null }
              : variant % 3 === 1
                ? ({} as unknown as Offerings)
                : {
                    current: {
                      identifier: 'default',
                      annual: brokenPackage(variant),
                      monthly: brokenPackage(variant + 1),
                      lifetime: brokenPackage(variant + 2),
                    },
                  },
          partial: variant =>
            variant % 2 === 0
              ? {
                  current: {
                    identifier: 'default',
                    annual,
                    monthly: null,
                    lifetime: null,
                  },
                }
              : {
                  current: {
                    identifier: 'default',
                    annual: null,
                    monthly: null,
                    lifetime,
                  },
                },
        },
      ),
    purchasePackage: () =>
      inject(
        box.record('rc.purchasePackage'),
        () => ({ customerInfo: customerInfo(scenario.storeEntitlement) }),
        {
          malformed: variant =>
            (variant % 2 === 0
              ? { customerInfo: { entitlements: null } }
              : { customerInfo: 'purchased' }) as unknown as {
              customerInfo: RevenueCatCustomerInfoLike;
            },
          partial: () =>
            ({}) as unknown as { customerInfo: RevenueCatCustomerInfoLike },
        },
      ),
    restorePurchases: () =>
      inject(
        box.record('rc.restorePurchases'),
        () => customerInfo(scenario.storeEntitlement),
        {
          malformed: variant =>
            (variant % 2 === 0
              ? { entitlements: { active: null } }
              : null) as unknown as RevenueCatCustomerInfoLike,
          partial: () => ({}) as unknown as RevenueCatCustomerInfoLike,
        },
      ),
    getCustomerInfo: () => Promise.resolve(customerInfo(false)),
    checkTrialOrIntroductoryPriceEligibility: ids =>
      inject(
        box.record('rc.trialEligibility'),
        () =>
          Object.fromEntries(ids.map(id => [id, { status: 2 }])) as Record<
            string,
            { status: number }
          >,
        {
          malformed: variant =>
            (variant % 2 === 0 ? null : 'eligible') as unknown as Record<
              string,
              { status: number }
            >,
          partial: () => ({}),
        },
      ),
  };

  return { sdk, appUserId: () => appUserId };
}

export interface FakeBackend {
  fetchFn: BillingFetch;
  /** Number of sync responses that reported premium=true. */
  premiumSyncsServed: () => number;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function nonJsonResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;
}

export function fakeBackend(scenario: Scenario, box: FaultBox): FakeBackend {
  let premiumSyncs = 0;
  const remaining = scenario.accessRemaining;

  const malformedAccess = (variant: number): unknown => {
    const healthy = accessBody(remaining, false);
    switch (variant % 4) {
      case 0:
        return { ...healthy, premium: 'yes' };
      case 1:
        // Arithmetic that does not add up: remaining ≠ limit − used.
        return {
          ...healthy,
          freeRatings: { ...healthy.freeRatings, remaining: 5 },
        };
      case 2:
        // Store-style "premium" claim without the entitlement list agreeing.
        return {
          ...healthy,
          premium: true,
          canStartRating: true,
          paywallRequired: false,
        };
      default:
        return [];
    }
  };
  const partialAccess = (variant: number): unknown => {
    const healthy = accessBody(remaining, false);
    switch (variant % 3) {
      case 0:
        return { premium: false };
      case 1: {
        const { freeRatings, ...rest } = healthy;
        void freeRatings;
        return rest;
      }
      default:
        return { ...healthy, freeRatings: { limit: 2, used: 2 - remaining } };
    }
  };
  const malformedSync = (variant: number): unknown => {
    const healthy = syncBody(remaining, true);
    switch (variant % 3) {
      case 0:
        // Billing says premium, access says not — must fail closed.
        return { ...healthy, access: accessBody(remaining, false) };
      case 1:
        return {
          ...healthy,
          billing: { ...healthy.billing, verifiedAt: 'yesterday' },
        };
      default:
        return 'ok';
    }
  };
  const partialSync = (variant: number): unknown => {
    const healthy = syncBody(remaining, true);
    return variant % 2 === 0
      ? { access: healthy.access }
      : { billing: healthy.billing };
  };

  const respond = (
    site: 'api.getAccess' | 'api.billingSync',
    healthyBody: () => unknown,
    shaped: {
      malformed: (variant: number) => unknown;
      partial: (variant: number) => unknown;
    },
  ): Promise<Response> => {
    const fault = box.record(site);
    if (!fault) return Promise.resolve(jsonResponse(200, healthyBody()));
    switch (fault.mode) {
      case 'http401':
        return Promise.resolve(jsonResponse(401, { error: 'unauthorized' }));
      case 'http429':
        return Promise.resolve(jsonResponse(429, { error: 'rate_limited' }));
      case 'http500':
        return Promise.resolve(jsonResponse(500, { error: 'internal' }));
      case 'http503':
        return Promise.resolve(jsonResponse(503, { error: 'unavailable' }));
      case 'nonJson':
        return Promise.resolve(nonJsonResponse());
      default:
        return inject(fault, () => jsonResponse(200, healthyBody()), {
          malformed: variant => jsonResponse(200, shaped.malformed(variant)),
          partial: variant => jsonResponse(200, shaped.partial(variant)),
        });
    }
  };

  const fetchFn: BillingFetch = (input, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && input === `${API_BASE_URL}/v1/me/access`) {
      return respond('api.getAccess', () => accessBody(remaining, false), {
        malformed: malformedAccess,
        partial: partialAccess,
      });
    }
    if (method === 'POST' && input === `${API_BASE_URL}/v1/billing/sync`) {
      return respond(
        'api.billingSync',
        () => {
          if (scenario.backendPremiumAfterSync) premiumSyncs += 1;
          return syncBody(remaining, scenario.backendPremiumAfterSync);
        },
        { malformed: malformedSync, partial: partialSync },
      );
    }
    return Promise.resolve(jsonResponse(404, { error: 'not_found' }));
  };

  return { fetchFn, premiumSyncsServed: () => premiumSyncs };
}

// ─── Store-state invariants (no corrupted persisted state) ───────────────────

export interface AccessStateLike {
  status: string;
  operation: string;
  plans: {
    offeringId: string;
    annual: PlanLike | null;
    monthly: PlanLike | null;
    lifetime: PlanLike | null;
  } | null;
  selectedPeriod: string;
  canonicalAccess: {
    premium: boolean;
    entitlements: string[];
    freeRatings: {
      limit: number;
      used: number;
      reserved: number;
      remaining: number;
      availableToReserve: number;
    };
    canStartRating: boolean;
    paywallRequired: boolean;
  } | null;
  error: { code: string; message: string } | null;
}

interface PlanLike {
  id: string;
  productId: string;
  period: string;
  price: number;
  priceString: string;
  pricePerMonthString: string | null;
  freeTrial: { label: string; periodIso8601: string } | null;
}

const STATUSES = ['idle', 'loading', 'ready', 'unconfigured', 'error'];
const OPERATIONS = ['idle', 'purchasing', 'restoring', 'syncing'];

/** Returns a list of violated store invariants (empty when the state is sane). */
export function storeStateViolations(state: AccessStateLike): string[] {
  const violations: string[] = [];
  if (!STATUSES.includes(state.status))
    violations.push(`status=${state.status}`);
  if (!OPERATIONS.includes(state.operation)) {
    violations.push(`operation=${state.operation}`);
  }
  if (state.plans) {
    const plans = [
      state.plans.annual,
      state.plans.monthly,
      state.plans.lifetime,
    ];
    if (plans.every(plan => plan === null))
      violations.push('plans:empty-object');
    for (const plan of plans) {
      if (!plan) continue;
      if (!Number.isFinite(plan.price) || plan.price < 0) {
        violations.push(`plan.${plan.period}.price=${plan.price}`);
      }
      if (!plan.priceString)
        violations.push(`plan.${plan.period}.priceString=""`);
      if (!plan.productId) violations.push(`plan.${plan.period}.productId=""`);
      if (plan.period === 'lifetime' && plan.freeTrial) {
        violations.push('plan.lifetime.freeTrial');
      }
    }
    const selected =
      state.selectedPeriod === 'annual'
        ? state.plans.annual
        : state.selectedPeriod === 'monthly'
          ? state.plans.monthly
          : state.plans.lifetime;
    if (!selected)
      violations.push(`selectedPeriod=${state.selectedPeriod}:no-plan`);
  }
  const access = state.canonicalAccess;
  if (access) {
    const fr = access.freeRatings;
    if (fr.limit !== 2) violations.push(`access.limit=${fr.limit}`);
    if (fr.used < 0 || fr.used > 2) violations.push(`access.used=${fr.used}`);
    if (fr.remaining !== 2 - fr.used)
      violations.push('access.remaining≠limit−used');
    if (fr.reserved < 0 || fr.reserved > fr.remaining) {
      violations.push(`access.reserved=${fr.reserved}`);
    }
    if (fr.availableToReserve !== fr.remaining - fr.reserved) {
      violations.push('access.availableToReserve≠remaining−reserved');
    }
    if (access.premium !== access.entitlements.includes('premium')) {
      violations.push('access.premium≠entitlements');
    }
    const expectedCanStart = access.premium || fr.availableToReserve > 0;
    if (access.canStartRating !== expectedCanStart) {
      violations.push('access.canStartRating');
    }
    if (access.paywallRequired !== !expectedCanStart) {
      violations.push('access.paywallRequired');
    }
  }
  if (state.error && (!state.error.code || !state.error.message)) {
    violations.push('error:missing-code-or-message');
  }
  if (state.status === 'idle' && (state.plans || state.canonicalAccess)) {
    violations.push('status=idle-with-data');
  }
  return violations;
}
