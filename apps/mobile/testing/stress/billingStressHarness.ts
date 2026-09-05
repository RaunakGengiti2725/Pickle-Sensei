/**
 * Seeded concurrency harness for the billing unit (`src/billing/*` +
 * `src/state/accessStore.ts` + `src/account/apiSession.ts`).
 *
 * Nothing in production code is mocked. The only seams are the two things the
 * unit already treats as injectable: the RevenueCat native SDK
 * (`RevenueCatSdk`) and `fetch` (`BillingFetch`). Both are driven by a
 * scheduler that settles every outstanding native/network call in a
 * seed-chosen order, one per macrotask, so every interleaving the JS event
 * loop could produce on device is reachable and every run is replayable from
 * its seed.
 *
 * Replay one seed:
 *   STRESS_SEED=<seed> npx jest __tests__/stress/billingStoreConcurrency.stress.test.ts
 * Campaign size / JSON table:
 *   STRESS_ITER=2000 STRESS_OUT=/tmp/billing-stress.json npx jest __tests__/stress
 */
import {
  bearerTokenFor,
  clearApiSession,
  establishApiSession,
  getApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  createBillingAccessDependencies,
  type BillingFetch,
  type RevenueCatCustomerInfoLike,
  type RevenueCatPackageLike,
  type RevenueCatSdk,
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
} from '../../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  CanonicalBillingSync,
  StorePlans,
} from '../../src/billing/types';

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
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

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export interface PendingOp {
  id: number;
  label: string;
  settle: () => void;
}

/**
 * Every fake native/network call registers a pending op and returns a
 * promise. `run` settles ops in a seed-chosen order, yielding a macrotask
 * between settlements so all continuation microtasks run to completion first
 * — the same shape the RN bridge and fetch give the app.
 */
export class Scheduler {
  readonly pending: PendingOp[] = [];
  private nextId = 0;
  steps = 0;
  readonly trace: string[] = [];

  register<T>(label: string, outcome: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.trace.push(`+${label}`);
      this.pending.push({
        id: this.nextId++,
        label,
        settle: () => {
          try {
            resolve(outcome());
          } catch (error) {
            reject(error);
          }
        },
      });
    });
  }

  private async yieldMacrotask(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
  }

  /** Settle up to `count` pending ops (default: drain), one per macrotask. */
  async run(
    rng: Rng,
    options: { count?: number; maxSteps: number; between?: () => void },
  ): Promise<void> {
    let budget = options.count ?? Number.POSITIVE_INFINITY;
    // Callers register ops only after a few microtask hops (e.g. `await sdk()`
    // inside `configure`), so let those settle before looking at the queue.
    await this.yieldMacrotask();
    while (budget > 0) {
      if (this.pending.length === 0) {
        await this.yieldMacrotask();
        if (this.pending.length === 0) break;
      }
      if (this.steps >= options.maxSteps) {
        throw new Error(
          `scheduler exceeded ${options.maxSteps} steps (livelock?) pending=${this.pending
            .map(op => op.label)
            .join(',')}`,
        );
      }
      const index = rng.int(this.pending.length);
      const [op] = this.pending.splice(index, 1);
      if (!op) break;
      this.steps += 1;
      budget -= 1;
      this.trace.push(op.label);
      op.settle();
      await this.yieldMacrotask();
      options.between?.();
      await this.yieldMacrotask();
    }
  }

  async flush(): Promise<void> {
    await this.yieldMacrotask();
    await this.yieldMacrotask();
  }

  /**
   * Directed scripts: settle the first pending op whose label starts with
   * `prefix`. Throws when no such op is pending (the script's assumption about
   * what the unit is waiting on is wrong).
   */
  async settle(prefix: string): Promise<void> {
    await this.yieldMacrotask();
    const index = this.pending.findIndex(op => op.label.startsWith(prefix));
    if (index < 0) {
      throw new Error(
        `no pending op matches "${prefix}"; pending=${this.pending.map(op => op.label).join(',') || '(none)'}`,
      );
    }
    const [op] = this.pending.splice(index, 1);
    if (!op) return;
    this.steps += 1;
    this.trace.push(op.label);
    op.settle();
    await this.yieldMacrotask();
    await this.yieldMacrotask();
  }

  has(prefix: string): boolean {
    return this.pending.some(op => op.label.startsWith(prefix));
  }
}

// ─── Shared world state ──────────────────────────────────────────────────────

export interface Account {
  name: string;
  canonicalId: string;
}

export const ACCOUNTS: readonly Account[] = [
  { name: 'A', canonicalId: '0000000a-0000-4000-8000-00000000000a' },
  { name: 'B', canonicalId: '0000000b-0000-4000-8000-00000000000b' },
  { name: 'C', canonicalId: '0000000c-0000-4000-8000-00000000000c' },
];

export const API_BASE_URL = 'https://api.stress.test';
export const PUBLIC_SDK_KEY = 'appl_stress_public_key';

export const PRODUCTS = {
  annual: 'pickle_sensei_pro_yearly',
  monthly: 'pickle_sensei_pro_monthly',
  lifetime: 'pickle_sensei_pro_lifetime',
} as const;

function makePackage(
  packageType: 'ANNUAL' | 'MONTHLY' | 'LIFETIME',
  productId: string,
  price: number,
  withTrial: boolean,
): RevenueCatPackageLike {
  return {
    identifier: `$rc_${packageType.toLowerCase()}`,
    packageType,
    product: {
      identifier: productId,
      price,
      priceString: `$${price.toFixed(2)}`,
      pricePerMonthString:
        packageType === 'LIFETIME' ? null : `$${(price / 12).toFixed(2)}`,
      introPrice: withTrial ? { price: 0, cycles: 1, period: 'P1W' } : null,
      defaultOption: null,
    },
  };
}

export interface SdkPurchaseRecord {
  owner: string;
  appUserIdAtInvoke: string | null;
  appUserIdAtSettle: string | null;
  productId: string;
  outcome: 'success' | 'cancelled' | 'failed' | 'no_entitlement';
  concurrentInFlight: number;
  step: number;
}

export interface WorldOptions {
  /** Probability a network request answers with a transport failure. */
  networkFailureRate: number;
  /** Probability a healthy request answers 5xx / 429. */
  serverErrorRate: number;
  /** Probability a healthy request answers an incoherent/malformed body. */
  invalidBodyRate: number;
  /** Probability RevenueCat native calls fail. */
  sdkFailureRate: number;
  /** Probability a purchase is cancelled by the user. */
  purchaseCancelRate: number;
  /** Probability `/v1/billing/sync` lags behind a completed store purchase. */
  syncLagRate: number;
  /** Probability `configure` behaves synchronously (void) like the real SDK. */
  syncConfigureRate: number;
  /** Directed scripts: full offerings, fixed entitlement key, no skew, used=0. */
  deterministic: boolean;
}

export const DEFAULT_WORLD: WorldOptions = {
  networkFailureRate: 0.08,
  serverErrorRate: 0.08,
  invalidBodyRate: 0.04,
  sdkFailureRate: 0.06,
  purchaseCancelRate: 0.15,
  syncLagRate: 0.1,
  syncConfigureRate: 0.5,
  deterministic: false,
};

/** No random faults at all — directed scripts choose every outcome. */
export const CLEAN_WORLD: WorldOptions = {
  networkFailureRate: 0,
  serverErrorRate: 0,
  invalidBodyRate: 0,
  sdkFailureRate: 0,
  purchaseCancelRate: 0,
  syncLagRate: 0,
  syncConfigureRate: 0,
  deterministic: true,
};

interface ServerAccount {
  used: number;
  reserved: number;
  /** Bearer tokens the server currently accepts for this account. */
  validTokens: Set<string>;
  /** Every token the server ever minted for this account. */
  everTokens: Set<string>;
}

export interface RequestRecord {
  seq: number;
  path: string;
  token: string;
  tokenAccount: string | null;
  sessionAccountAtIssue: string | null;
  storeAccountAtIssue: string | null;
  outcome: string;
  landedStep: number;
}

export interface Tag {
  kind: 'access' | 'plans';
  account: string;
  configVersion: number;
  seq: number;
  premium: boolean;
}

/**
 * The world every fake talks to: one RevenueCat native singleton (its
 * `appUserID` is process-global, exactly like the real SDK), RevenueCat's
 * server-side entitlement ledger keyed by app user id, and the Pickle Sensei
 * backend's per-account state + accepted bearer tokens.
 */
export class World {
  readonly scheduler = new Scheduler();
  readonly rng: Rng;
  readonly options: WorldOptions;

  // RevenueCat native singleton.
  sdkConfigured = false;
  sdkAppUserId: string | null = null;
  sdkConfigureCalls = 0;
  sdkLogInCalls = 0;
  sdkPurchaseInFlight = 0;
  readonly sdkPurchases: SdkPurchaseRecord[] = [];
  readonly sdkRestoreCalls: Array<{
    owner: string;
    appUserIdAtInvoke: string | null;
  }> = [];
  offeringVersion = 0;

  // RevenueCat server-side entitlements by app user id.
  readonly rcPremium = new Map<string, string>();

  // Backend.
  readonly accounts = new Map<string, ServerAccount>();
  readonly requests: RequestRecord[] = [];
  private requestSeq = 0;
  private tokenSeq = 0;

  // Response provenance (object identity → who produced it).
  readonly tags = new WeakMap<object, Tag>();

  /** Set by the driver: which account's dependencies the store currently holds. */
  storeAccount: string | null = null;
  storeConfigVersion = 0;

  unauthorizedReports: Array<{ account: string; token: string }> = [];
  expectedUnauthorizedReports = 0;

  /** Directed scripts: outcome of the NEXT purchase / fetch, then cleared. */
  nextPurchaseOutcome: SdkPurchaseRecord['outcome'] | null = null;
  nextFetchOutcome: 'network_error' | '500' | 'invalid_body' | null = null;

  constructor(seed: number, options: WorldOptions = DEFAULT_WORLD) {
    this.rng = new Rng(seed);
    this.options = options;
    for (const account of ACCOUNTS) {
      this.accounts.set(account.canonicalId, {
        used: options.deterministic ? 0 : this.rng.int(3),
        reserved: 0,
        validTokens: new Set(),
        everTokens: new Set(),
      });
    }
  }

  private server(accountId: string): ServerAccount {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`unknown account ${accountId}`);
    return account;
  }

  mintToken(accountId: string): string {
    const token = `tok_${ACCOUNTS.find(a => a.canonicalId === accountId)?.name ?? '?'}_${++this.tokenSeq}`;
    const account = this.server(accountId);
    account.validTokens.add(token);
    account.everTokens.add(token);
    return token;
  }

  revokeToken(accountId: string, token: string): void {
    this.server(accountId).validTokens.delete(token);
  }

  revokeAllTokens(accountId: string): void {
    this.server(accountId).validTokens.clear();
  }

  accountOfToken(token: string): string | null {
    for (const [id, account] of this.accounts) {
      if (account.everTokens.has(token)) return id;
    }
    return null;
  }

  /** Another device (or the server) spends a free rating. */
  serverSpend(accountId: string): void {
    const account = this.server(accountId);
    if (account.used < 2) account.used += 1;
    account.reserved = 0;
  }

  serverReserve(accountId: string): void {
    const account = this.server(accountId);
    account.reserved = Math.min(2 - account.used, account.reserved + 1);
  }

  serverRelease(accountId: string): void {
    this.server(accountId).reserved = 0;
  }

  /** RevenueCat webhook / entitlement expiry seen by the backend. */
  rcRevoke(appUserId: string): void {
    this.rcPremium.delete(appUserId);
  }

  rcGrant(appUserId: string, productId: string): void {
    this.rcPremium.set(appUserId, productId);
  }

  // ── Backend body builders ──────────────────────────────────────────────────

  private accessBody(
    accountId: string,
    premium: boolean,
  ): Record<string, unknown> {
    const account = this.server(accountId);
    const remaining = 2 - account.used;
    const reserved = Math.min(account.reserved, remaining);
    const availableToReserve = remaining - reserved;
    const canStartRating = premium || availableToReserve > 0;
    return {
      premium,
      entitlements: premium ? ['premium'] : [],
      freeRatings: {
        limit: 2,
        used: account.used,
        reserved,
        remaining,
        availableToReserve,
      },
      canStartRating,
      paywallRequired: !canStartRating,
    };
  }

  private corruptAccess(
    body: Record<string, unknown>,
  ): Record<string, unknown> {
    const freeRatings = body.freeRatings as Record<string, unknown>;
    switch (this.rng.int(6)) {
      case 0:
        return { ...body, freeRatings: { ...freeRatings, used: 3 } };
      case 1:
        return { ...body, freeRatings: { ...freeRatings, limit: 3 } };
      case 2:
        return { ...body, premium: !body.premium };
      case 3:
        return { ...body, canStartRating: !body.canStartRating };
      case 4:
        return { ...body, freeRatings: { ...freeRatings, remaining: 5 } };
      default:
        return { premium: 'yes' };
    }
  }

  private billingBody(
    accountId: string,
    premium: boolean,
  ): Record<string, unknown> {
    const now = Date.now();
    if (this.options.deterministic) {
      return {
        premium,
        productKey: premium
          ? (this.rcPremium.get(accountId) ?? PRODUCTS.annual)
          : null,
        expiresAt: premium ? '2030-01-01T00:00:00.000Z' : null,
        verifiedAt: new Date(now).toISOString(),
      };
    }
    // Clock skew: expiry in the past / far future, verifiedAt in the future.
    const skew = this.rng.pick([
      -86_400_000 * 400,
      -1,
      0,
      1,
      86_400_000 * 3650,
    ]);
    return {
      premium,
      productKey: premium
        ? (this.rcPremium.get(accountId) ?? PRODUCTS.annual)
        : null,
      expiresAt: premium
        ? this.rng.chance(0.2)
          ? null
          : new Date(now + skew).toISOString()
        : null,
      verifiedAt: new Date(
        now + this.rng.pick([0, 5_000, -5_000, 3_600_000]),
      ).toISOString(),
    };
  }

  // ── fetch ──────────────────────────────────────────────────────────────────

  readonly fetchFn: BillingFetch = (input, init) => {
    const seq = ++this.requestSeq;
    const path = input.replace(API_BASE_URL, '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = headers.Authorization?.replace(/^Bearer /, '') ?? '';
    const tokenAccount = this.accountOfToken(token);
    const record: RequestRecord = {
      seq,
      path,
      token,
      tokenAccount,
      sessionAccountAtIssue: getApiSession()?.canonicalAppUserId ?? null,
      storeAccountAtIssue: this.storeAccount,
      outcome: 'pending',
      landedStep: -1,
    };
    this.requests.push(record);

    // The server processes the request now (state snapshot at issue time); the
    // response is delivered whenever the scheduler settles it.
    const rng = this.rng;
    let outcome: () => Response;
    const valid =
      tokenAccount !== null && this.server(tokenAccount).validTokens.has(token);
    const forced = this.nextFetchOutcome;
    this.nextFetchOutcome = null;
    if (
      forced === 'network_error' ||
      rng.chance(this.options.networkFailureRate)
    ) {
      record.outcome = 'network_error';
      outcome = () => {
        throw new TypeError('Network request failed');
      };
    } else if (!valid) {
      record.outcome = '401';
      outcome = () => this.response(401, {});
    } else if (forced === '500' || rng.chance(this.options.serverErrorRate)) {
      const status = forced ? 500 : rng.pick([500, 502, 503, 429, 409, 400]);
      record.outcome = String(status);
      outcome = () => this.response(status, {});
    } else if (
      forced === 'invalid_body' ||
      rng.chance(this.options.invalidBodyRate)
    ) {
      record.outcome = 'invalid_body';
      const accountId = tokenAccount as string;
      const premium = this.rcPremium.has(accountId);
      const body =
        forced || rng.chance(0.3)
          ? null
          : path === '/v1/me/access'
            ? this.corruptAccess(this.accessBody(accountId, premium))
            : rng.chance(0.5)
              ? {
                  billing: this.billingBody(accountId, !premium),
                  access: this.accessBody(accountId, premium),
                }
              : {
                  billing: this.billingBody(accountId, premium),
                  access: this.corruptAccess(
                    this.accessBody(accountId, premium),
                  ),
                };
      outcome = () => this.response(200, body, body === null);
    } else {
      const accountId = tokenAccount as string;
      const rcPremium = this.rcPremium.has(accountId);
      const premium =
        path === '/v1/billing/sync' &&
        rcPremium &&
        rng.chance(this.options.syncLagRate)
          ? false
          : rcPremium;
      record.outcome = premium ? '200_premium' : '200_free';
      const body =
        path === '/v1/me/access'
          ? this.accessBody(accountId, premium)
          : {
              billing: this.billingBody(accountId, premium),
              access: this.accessBody(accountId, premium),
            };
      outcome = () => this.response(200, body);
    }
    return this.scheduler.register(
      `fetch#${seq}:${path}:${record.outcome}`,
      () => {
        record.landedStep = this.scheduler.steps;
        if (record.outcome === '401') {
          const session = getApiSession();
          if (session && session.bearerToken === token)
            this.expectedUnauthorizedReports += 1;
        }
        return outcome();
      },
    );
  };

  private response(
    status: number,
    body: unknown,
    malformedJson = false,
  ): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => {
        if (malformedJson) throw new SyntaxError('Unexpected token < in JSON');
        return body;
      },
    } as unknown as Response;
  }

  // ── RevenueCat native SDK facade (one per client, shared singleton state) ──

  private offering(): {
    identifier: string;
    annual: RevenueCatPackageLike | null;
    monthly: RevenueCatPackageLike | null;
    lifetime: RevenueCatPackageLike | null;
  } | null {
    const rng = this.rng;
    const version = this.offeringVersion;
    if (this.options.deterministic) {
      return {
        identifier: `offering_v${version}`,
        annual: makePackage('ANNUAL', PRODUCTS.annual, 59.99, false),
        monthly: makePackage('MONTHLY', PRODUCTS.monthly, 7.99, false),
        lifetime: makePackage('LIFETIME', PRODUCTS.lifetime, 159.99, false),
      };
    }
    if (rng.chance(0.05)) return null;
    const trial = rng.chance(0.4);
    const annual = rng.chance(0.9)
      ? makePackage('ANNUAL', PRODUCTS.annual, 59.99, trial)
      : null;
    const monthly = rng.chance(0.9)
      ? makePackage('MONTHLY', PRODUCTS.monthly, 7.99, false)
      : null;
    const lifetime = rng.chance(0.8)
      ? makePackage('LIFETIME', PRODUCTS.lifetime, 159.99, false)
      : null;
    return { identifier: `offering_v${version}`, annual, monthly, lifetime };
  }

  private customerInfo(appUserId: string | null): RevenueCatCustomerInfoLike {
    const productId = appUserId ? this.rcPremium.get(appUserId) : undefined;
    return {
      entitlements: {
        active: productId
          ? {
              [!this.options.deterministic && this.rng.chance(0.2)
                ? 'premium'
                : 'pickle_sensei_pro']: {
                productIdentifier: productId,
                expirationDate:
                  productId === PRODUCTS.lifetime
                    ? null
                    : '2030-01-01T00:00:00.000Z',
              },
            }
          : {},
      },
    };
  }

  sdkFor(owner: Account): RevenueCatSdk {
    const rng = this.rng;
    const sched = this.scheduler;
    const fail = (label: string) => () => {
      throw new Error(`RevenueCat native failure (${label})`);
    };
    return {
      isConfigured: () =>
        sched.register(
          `sdk.isConfigured(${owner.name})`,
          () => this.sdkConfigured,
        ),
      configure: configuration => {
        this.sdkConfigureCalls += 1;
        const apply = () => {
          this.sdkConfigured = true;
          this.sdkAppUserId = configuration.appUserID;
        };
        if (rng.chance(this.options.syncConfigureRate)) {
          apply();
          return undefined;
        }
        return sched.register(`sdk.configure(${owner.name})`, apply);
      },
      getAppUserID: () =>
        sched.register(
          `sdk.getAppUserID(${owner.name})`,
          () => this.sdkAppUserId ?? '',
        ),
      logIn: appUserID => {
        this.sdkLogInCalls += 1;
        return sched.register(
          `sdk.logIn(${owner.name})`,
          rng.chance(this.options.sdkFailureRate)
            ? fail('logIn')
            : () => {
                this.sdkAppUserId = appUserID;
                return {
                  customerInfo: this.customerInfo(appUserID),
                  created: false,
                };
              },
        );
      },
      getOfferings: () =>
        sched.register(
          `sdk.getOfferings(${owner.name})`,
          rng.chance(this.options.sdkFailureRate)
            ? fail('getOfferings')
            : () => ({ current: this.offering() }),
        ),
      purchasePackage: aPackage => {
        const record: SdkPurchaseRecord = {
          owner: owner.canonicalId,
          appUserIdAtInvoke: this.sdkAppUserId,
          appUserIdAtSettle: null,
          productId: aPackage.product.identifier,
          outcome: 'success',
          concurrentInFlight: this.sdkPurchaseInFlight,
          step: sched.steps,
        };
        this.sdkPurchaseInFlight += 1;
        this.sdkPurchases.push(record);
        const roll = rng.next();
        if (this.nextPurchaseOutcome) {
          record.outcome = this.nextPurchaseOutcome;
          this.nextPurchaseOutcome = null;
        } else if (roll < this.options.purchaseCancelRate)
          record.outcome = 'cancelled';
        else if (
          roll <
          this.options.purchaseCancelRate + this.options.sdkFailureRate
        )
          record.outcome = 'failed';
        else if (
          roll <
          this.options.purchaseCancelRate + this.options.sdkFailureRate + 0.05
        )
          record.outcome = 'no_entitlement';
        return sched.register(
          `sdk.purchasePackage(${owner.name}:${record.outcome})`,
          () => {
            this.sdkPurchaseInFlight -= 1;
            record.appUserIdAtSettle = this.sdkAppUserId;
            switch (record.outcome) {
              case 'cancelled':
                throw rng.chance(0.5)
                  ? { userCancelled: true, code: '1' }
                  : { code: '1' };
              case 'failed':
                throw { code: '2', message: 'Store problem' };
              case 'no_entitlement':
                return { customerInfo: { entitlements: { active: {} } } };
              default: {
                // StoreKit charges the App Store account; RevenueCat attributes it
                // to whichever app user id the singleton holds right now.
                const attributedTo = this.sdkAppUserId;
                if (attributedTo)
                  this.rcPremium.set(attributedTo, aPackage.product.identifier);
                return { customerInfo: this.customerInfo(attributedTo) };
              }
            }
          },
        );
      },
      restorePurchases: () => {
        this.sdkRestoreCalls.push({
          owner: owner.canonicalId,
          appUserIdAtInvoke: this.sdkAppUserId,
        });
        return sched.register(
          `sdk.restorePurchases(${owner.name})`,
          rng.chance(this.options.sdkFailureRate)
            ? fail('restore')
            : () => this.customerInfo(this.sdkAppUserId),
        );
      },
      getCustomerInfo: () =>
        sched.register(
          `sdk.getCustomerInfo(${owner.name})`,
          rng.chance(this.options.sdkFailureRate)
            ? fail('getCustomerInfo')
            : () => this.customerInfo(this.sdkAppUserId),
        ),
      checkTrialOrIntroductoryPriceEligibility: ids =>
        sched.register(
          `sdk.eligibility(${owner.name})`,
          rng.chance(this.options.sdkFailureRate)
            ? fail('eligibility')
            : () =>
                Object.fromEntries(
                  ids.map(id => [
                    id,
                    {
                      status: this.options.deterministic
                        ? 0
                        : rng.chance(0.6)
                          ? 2
                          : 0,
                    },
                  ]),
                ),
        ),
    };
  }

  // ── Dependencies wrapper: tags every object the store may adopt ────────────

  wrapDependencies(
    deps: BillingAccessDependencies,
    account: Account,
    configVersion: number,
  ): BillingAccessDependencies {
    const tag = <T extends object>(
      value: T,
      kind: Tag['kind'],
      premium: boolean,
      seq: number,
    ): T => {
      this.tags.set(value, {
        kind,
        account: account.canonicalId,
        configVersion,
        seq,
        premium,
      });
      return value;
    };
    // `accessApi.request` calls fetch synchronously (before its first await),
    // so the request issued by a backend call is the one appended right here.
    const issued = <T>(
      call: () => Promise<T>,
    ): { promise: Promise<T>; seq: number } => {
      const before = this.requests.length;
      const promise = call();
      const record = this.requests[before];
      return { promise, seq: record?.seq ?? -1 };
    };
    return {
      store: {
        configure: () => deps.store.configure(),
        loadPlans: async () =>
          tag(await deps.store.loadPlans(), 'plans', false, 0) as StorePlans,
        purchase: planId => deps.store.purchase(planId),
        restore: () => deps.store.restore(),
        readEntitlement: () => deps.store.readEntitlement(),
      },
      backend: {
        getAccess: async () => {
          const { promise, seq } = issued(() => deps.backend.getAccess());
          const access: CanonicalAccessState = await promise;
          return tag(access, 'access', access.premium, seq);
        },
        syncBilling: async () => {
          const { promise, seq } = issued(() => deps.backend.syncBilling());
          const synced: CanonicalBillingSync = await promise;
          tag(synced.access, 'access', synced.access.premium, seq);
          return synced;
        },
      },
    };
  }

  // ── Session helpers ────────────────────────────────────────────────────────

  establishSession(account: Account): string {
    const token = this.mintToken(account.canonicalId);
    const session: ApiSession = {
      apiBaseUrl: API_BASE_URL,
      bearerToken: token,
      canonicalAppUserId: account.canonicalId,
      provider: 'apple',
      refreshToken: `refresh_${token}`,
      bearerExpiresAtMs: Date.now() + 3_600_000,
    };
    establishApiSession(session);
    return token;
  }

  /** Access-token rotation for the current session (sessionKeeper behaviour). */
  rotateSession(): void {
    const session = getApiSession();
    if (!session) return;
    const old = session.bearerToken;
    const token = this.mintToken(session.canonicalAppUserId);
    establishApiSession({ ...session, bearerToken: token });
    // GoTrue keeps the previous access token verifiable until it expires; a
    // logout revokes it. Model both.
    if (this.options.deterministic || this.rng.chance(0.5)) {
      this.revokeToken(session.canonicalAppUserId, old);
    }
  }

  /** Server-side expiry of the current bearer (the request will 401). */
  expireCurrentBearer(): void {
    const session = getApiSession();
    if (!session) return;
    this.revokeToken(session.canonicalAppUserId, session.bearerToken);
  }

  signOut(): void {
    const session = getApiSession();
    if (session) this.revokeAllTokens(session.canonicalAppUserId);
    clearApiSession();
  }

  installUnauthorizedListener(onReport: (session: ApiSession) => void): void {
    setApiUnauthorizedListener(session => {
      this.unauthorizedReports.push({
        account: session.canonicalAppUserId,
        token: session.bearerToken,
      });
      onReport(session);
    });
  }
}

export function accountByName(name: string): Account {
  const account = ACCOUNTS.find(a => a.name === name);
  if (!account) throw new Error(`unknown account ${name}`);
  return account;
}

/**
 * Mirrors `authStore.installApiSession`: establish the bearer session, then
 * hand the store real `createBillingAccessDependencies` whose token is
 * resolved per request through `bearerTokenFor` (never captured).
 */
export class Driver {
  current: Account | null = null;
  configVersion = 0;

  constructor(readonly world: World) {
    clearApiSession();
    clearAccessStoreConfiguration();
    setApiUnauthorizedListener(null);
  }

  signIn(account: Account): void {
    this.world.establishSession(account);
    this.configVersion += 1;
    this.current = account;
    this.world.storeAccount = account.canonicalId;
    this.world.storeConfigVersion = this.configVersion;
    const deps = createBillingAccessDependencies({
      revenueCatPublicSdkKey: PUBLIC_SDK_KEY,
      canonicalAppUserId: account.canonicalId,
      apiBaseUrl: API_BASE_URL,
      get apiToken() {
        return bearerTokenFor(account.canonicalId);
      },
      fetchFn: this.world.fetchFn,
      revenueCatSdk: this.world.sdkFor(account),
      platform: 'ios',
    });
    configureAccessStore(
      this.world.wrapDependencies(deps, account, this.configVersion),
    );
  }

  signOut(): void {
    this.world.signOut();
    clearAccessStoreConfiguration();
    this.current = null;
    this.world.storeAccount = null;
    this.world.storeConfigVersion = -1;
  }

  dispose(): void {
    setApiUnauthorizedListener(null);
    clearApiSession();
    clearAccessStoreConfiguration();
  }
}
