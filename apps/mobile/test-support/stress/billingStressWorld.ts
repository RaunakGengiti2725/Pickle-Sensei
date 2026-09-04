/**
 * mod-billing stress — the fake world around the REAL billing unit.
 *
 * The unit under test is the composition the app ships:
 * `createBillingAccessDependencies` (revenueCatClient + accessApi) driven by
 * the real Zustand `accessStore`. The only seams are the ones production
 * injects too: the RevenueCat SDK object and the `fetch` function. Every
 * native / network call becomes a PendingCall the harness settles explicitly
 * with a seeded outcome, so any interleaving of purchase / restore / sync /
 * refresh / sign-out / token rotation is reachable and replayable.
 *
 * Nothing in here reaches a network, a store, or a native module.
 */
import type { BillingFetch } from '../../src/billing/accessApi';
import { createBillingAccessDependencies } from '../../src/billing';
import type {
  RevenueCatCustomerInfoLike,
  RevenueCatPackageLike,
  RevenueCatSdk,
} from '../../src/billing/revenueCatClient';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../../src/billing/types';
import { bearerTokenFor, getApiSession } from '../../src/account/apiSession';
import { deferred, type Deferred } from '../../testing/xcBehavioral/deferred';

export type PendingKind =
  | 'sdk.configure'
  | 'sdk.logIn'
  | 'sdk.getOfferings'
  | 'sdk.checkTrial'
  | 'sdk.purchasePackage'
  | 'sdk.restorePurchases'
  | 'sdk.getCustomerInfo'
  | 'http.getAccess'
  | 'http.syncBilling';

/** Seeded outcome labels per call kind. Index = floor(roll * length); the
 * repetition of a label is its weight. */
export const OUTCOMES: Record<PendingKind, readonly string[]> = {
  'sdk.configure': ['ok', 'ok', 'ok', 'error'],
  'sdk.logIn': ['ok', 'ok', 'no_bind', 'error'],
  'sdk.getOfferings': [
    'full',
    'full',
    'annual_only',
    'lifetime_only',
    'monthly_trial',
    'wrong_types',
    'no_current',
    'error',
  ],
  'sdk.checkTrial': ['eligible', 'ineligible', 'error'],
  'sdk.purchasePackage': [
    'entitled',
    'entitled',
    'entitled',
    'not_entitled',
    'cancelled',
    'cancelled_code1',
    'error',
  ],
  'sdk.restorePurchases': ['entitled', 'entitled', 'none', 'error'],
  'sdk.getCustomerInfo': ['entitled', 'none', 'error'],
  'http.getAccess': [
    'free0',
    'free1',
    'free1r1',
    'free2',
    'premium',
    'premium',
    'incoherent',
    'malformed',
    '401',
    '403',
    '429',
    '500',
    '503',
    'network',
  ],
  'http.syncBilling': [
    'premium',
    'premium',
    'premium',
    'free0',
    'free2',
    'mismatch',
    'bad_billing',
    'malformed',
    '401',
    '429',
    '500',
    'network',
  ],
};

export function outcomeFor(kind: PendingKind, roll: number): string {
  const labels = OUTCOMES[kind];
  const index = Math.min(labels.length - 1, Math.floor(roll * labels.length));
  return labels[index]!;
}

/** The parsed access snapshot the client will hold after a VALID body, or
 * null when the body must be rejected by `parseAccess`. */
export function accessSnapshotFor(label: string): CanonicalAccessState | null {
  const free = (used: number, reserved: number): CanonicalAccessState => {
    const remaining = 2 - used;
    const availableToReserve = remaining - reserved;
    return {
      premium: false,
      entitlements: [],
      freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
      canStartRating: availableToReserve > 0,
      paywallRequired: !(availableToReserve > 0),
    };
  };
  switch (label) {
    case 'free0':
      return free(0, 0);
    case 'free1':
      return free(1, 0);
    case 'free1r1':
      return free(1, 1);
    case 'free2':
      return free(2, 0);
    case 'premium':
      return {
        premium: true,
        entitlements: ['premium', 'pickle_sensei_pro'],
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
    default:
      return null;
  }
}

function accessBody(label: string): unknown {
  if (label === 'incoherent') {
    // used=1 but remaining claims 2: parseAccess must reject it.
    return {
      premium: false,
      entitlements: [],
      freeRatings: {
        limit: 2,
        used: 1,
        reserved: 0,
        remaining: 2,
        availableToReserve: 2,
      },
      canStartRating: true,
      paywallRequired: false,
    };
  }
  return accessSnapshotFor(label);
}

const VERIFIED_AT = '2026-09-01T00:00:00.000Z';

function syncBody(label: string): unknown {
  switch (label) {
    case 'premium':
      return {
        billing: {
          premium: true,
          productKey: 'pickle_sensei_pro_yearly',
          expiresAt: null,
          verifiedAt: VERIFIED_AT,
        },
        access: accessBody('premium'),
      };
    case 'free0':
    case 'free2':
      return {
        billing: {
          premium: false,
          productKey: null,
          expiresAt: null,
          verifiedAt: VERIFIED_AT,
        },
        access: accessBody(label),
      };
    case 'mismatch':
      // Server says billing is premium but the access snapshot is free.
      return {
        billing: {
          premium: true,
          productKey: 'pickle_sensei_pro_yearly',
          expiresAt: null,
          verifiedAt: VERIFIED_AT,
        },
        access: accessBody('free0'),
      };
    case 'bad_billing':
      return {
        billing: {
          premium: true,
          productKey: 'pickle_sensei_pro_yearly',
          expiresAt: null,
          verifiedAt: 'not-a-date',
        },
        access: accessBody('premium'),
      };
    default:
      return null;
  }
}

function httpResponse(
  label: string,
  body: unknown,
): { response: unknown; reject: unknown } {
  const ok = (json: unknown) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(json),
  });
  switch (label) {
    case 'malformed':
      return {
        response: {
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('Unexpected token')),
        },
        reject: null,
      };
    case '401':
    case '403':
    case '429':
    case '500':
    case '503':
      return {
        response: {
          ok: false,
          status: Number(label),
          json: () => Promise.resolve({ error: label }),
        },
        reject: null,
      };
    case 'network':
      return {
        response: null,
        reject: new TypeError('Network request failed'),
      };
    default:
      return { response: ok(body), reject: null };
  }
}

function pkg(
  packageType: string,
  identifier: string,
  productId: string,
  price: number,
  extras: Partial<RevenueCatPackageLike['product']> = {},
): RevenueCatPackageLike {
  return {
    identifier,
    packageType,
    product: {
      identifier: productId,
      price,
      priceString: `$${price.toFixed(2)}`,
      pricePerMonthString: packageType === 'LIFETIME' ? null : '$5.00',
      introPrice: null,
      defaultOption: null,
      ...extras,
    },
  };
}

const ANNUAL = pkg('ANNUAL', '$rc_annual', 'pickle_sensei_pro_yearly', 59.99);
const MONTHLY = pkg(
  'MONTHLY',
  '$rc_monthly',
  'pickle_sensei_pro_monthly',
  7.99,
);
const MONTHLY_TRIAL = pkg(
  'MONTHLY',
  '$rc_monthly',
  'pickle_sensei_pro_monthly',
  7.99,
  { introPrice: { price: 0, cycles: 1, period: 'P1W' } },
);
const LIFETIME = pkg(
  'LIFETIME',
  '$rc_lifetime',
  'pickle_sensei_pro_lifetime',
  159.99,
);

function offerings(label: string) {
  const current = (
    annual: RevenueCatPackageLike | null,
    monthly: RevenueCatPackageLike | null,
    lifetime: RevenueCatPackageLike | null,
  ) => ({ current: { identifier: 'default', annual, monthly, lifetime } });
  switch (label) {
    case 'full':
      return current(ANNUAL, MONTHLY, LIFETIME);
    case 'annual_only':
      return current(ANNUAL, null, null);
    case 'lifetime_only':
      return current(null, null, LIFETIME);
    case 'monthly_trial':
      return current(ANNUAL, MONTHLY_TRIAL, null);
    case 'wrong_types':
      // Dashboard misconfiguration: every slot carries the wrong package type.
      return current(MONTHLY, ANNUAL, ANNUAL);
    case 'no_current':
      return { current: null };
    default:
      throw new Error(`unknown offerings outcome ${label}`);
  }
}

function customerInfo(entitled: boolean): RevenueCatCustomerInfoLike {
  return {
    entitlements: {
      active: entitled
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

export interface PendingCall {
  id: number;
  kind: PendingKind;
  depsId: number;
  /** World generation when the call went out (store configuration version
   * proxy — see BillingStressWorld.gen). */
  issuedGen: number;
  issuedStep: number;
  detail: Record<string, unknown>;
  settled: boolean;
  outcome: string | null;
  /** Set by the model when it can attribute the call to a store operation. */
  owner: unknown;
}

export interface SettledCall {
  id: number;
  kind: PendingKind;
  outcome: string;
  stale: boolean;
  issuedStep: number;
  step: number;
}

export interface BearerViolation {
  step: number;
  kind: PendingKind;
  depsUser: string | null;
  sessionUser: string | null;
  sentToken: string | null;
  sessionToken: string | null;
}

export interface DepsConfig {
  canonicalAppUserId: string | null;
  revenueCatPublicSdkKey: string | null;
  apiBaseUrl: string | null;
}

interface Internal extends PendingCall {
  d: Deferred<unknown>;
  apply: (outcome: string) => void;
}

export class BillingStressWorld {
  /** Increments on every configure / clear / reset of the access store — the
   * harness's mirror of `configurationVersion`. */
  gen = 0;
  currentDepsId = 0;
  step = 0;
  pending: Internal[] = [];
  settledLog: SettledCall[] = [];
  bearerViolations: BearerViolation[] = [];
  unexpectedRequests: string[] = [];
  issuedCount = 0;
  sdkState: { configured: boolean; appUserId: string | null } = {
    configured: false,
    appUserId: null,
  };
  onIssued: ((call: PendingCall) => void) | null = null;
  private depsSeq = 0;
  private idSeq = 0;

  pendingKinds(): string[] {
    return this.pending.map(p => `${p.kind}#${p.id}`);
  }

  /**
   * A call is stale when nothing in the CURRENT configuration may react to
   * it. Backend responses are bound to the store version that issued them
   * (`reset()` bumps it). SDK calls belong to the client object, which
   * survives `reset()` — its cached `configure()` promise is what a later
   * purchase/restore on the same deps awaits — so they only go stale when the
   * dependencies themselves are replaced.
   */
  isStale(call: PendingCall): boolean {
    if (call.depsId !== this.currentDepsId) return true;
    return call.kind.startsWith('http.') && call.issuedGen !== this.gen;
  }

  private hold(
    kind: PendingKind,
    depsId: number,
    detail: Record<string, unknown>,
    apply: (outcome: string, d: Deferred<unknown>) => void,
  ): Promise<unknown> {
    const d = deferred<unknown>();
    const call: Internal = {
      id: ++this.idSeq,
      kind,
      depsId,
      issuedGen: this.gen,
      issuedStep: this.step,
      detail,
      settled: false,
      outcome: null,
      owner: null,
      d,
      apply: outcome => apply(outcome, d),
    };
    this.pending.push(call);
    this.issuedCount += 1;
    this.onIssued?.(call);
    return d.promise;
  }

  /** Settles one pending call with a labelled outcome; returns the record. */
  settle(call: PendingCall, outcome: string): SettledCall {
    const internal = this.pending.find(p => p.id === call.id);
    if (!internal) throw new Error(`pending #${call.id} not found`);
    this.pending = this.pending.filter(p => p.id !== call.id);
    internal.settled = true;
    internal.outcome = outcome;
    const record: SettledCall = {
      id: internal.id,
      kind: internal.kind,
      outcome,
      stale: this.isStale(internal),
      issuedStep: internal.issuedStep,
      step: this.step,
    };
    this.settledLog.push(record);
    internal.apply(outcome);
    return record;
  }

  /** Builds the production dependency graph for one sign-in, with this
   * world's SDK + fetch seams injected and the bearer resolved per request
   * through `bearerTokenFor` exactly as authStore.installApiSession does. */
  makeDeps(config: DepsConfig): {
    deps: BillingAccessDependencies;
    depsId: number;
  } {
    const depsId = ++this.depsSeq;
    this.currentDepsId = depsId;
    const user = config.canonicalAppUserId;
    const sdk = this.makeSdk(depsId);
    const fetchFn: BillingFetch = (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const authorization = headers.Authorization ?? headers.authorization;
      const sentToken = authorization?.replace(/^Bearer /, '') ?? null;
      const session = getApiSession();
      const sessionUser = session?.canonicalAppUserId ?? null;
      const sessionToken = session?.bearerToken ?? null;
      if (
        user === null ||
        sessionUser !== user ||
        sentToken === null ||
        sentToken !== sessionToken
      ) {
        this.bearerViolations.push({
          step: this.step,
          kind: input.endsWith('/v1/billing/sync')
            ? 'http.syncBilling'
            : 'http.getAccess',
          depsUser: user,
          sessionUser,
          sentToken,
          sessionToken,
        });
      }
      const method = init?.method ?? 'GET';
      let kind: PendingKind;
      if (input.endsWith('/v1/me/access') && method === 'GET') {
        kind = 'http.getAccess';
      } else if (input.endsWith('/v1/billing/sync') && method === 'POST') {
        kind = 'http.syncBilling';
      } else {
        this.unexpectedRequests.push(`${method} ${input}`);
        return Promise.reject(
          new Error(`unexpected request ${method} ${input}`),
        );
      }
      return this.hold(
        kind,
        depsId,
        { token: sentToken, user },
        (outcome, d) => {
          const body =
            kind === 'http.getAccess' ? accessBody(outcome) : syncBody(outcome);
          const { response, reject } = httpResponse(outcome, body);
          if (reject) d.reject(reject);
          else d.resolve(response);
        },
      ) as Promise<Response>;
    };
    const deps = createBillingAccessDependencies({
      revenueCatPublicSdkKey: config.revenueCatPublicSdkKey,
      canonicalAppUserId: user,
      apiBaseUrl: config.apiBaseUrl,
      get apiToken() {
        return user === null ? null : bearerTokenFor(user);
      },
      fetchFn,
      revenueCatSdk: sdk,
      platform: 'ios',
    });
    return { deps, depsId };
  }

  private makeSdk(depsId: number): RevenueCatSdk {
    const state = this.sdkState;
    return {
      isConfigured: () => Promise.resolve(state.configured),
      configure: configuration =>
        this.hold(
          'sdk.configure',
          depsId,
          { appUserID: configuration.appUserID },
          (outcome, d) => {
            if (outcome === 'ok') {
              state.configured = true;
              state.appUserId = configuration.appUserID;
              d.resolve(undefined);
            } else {
              d.reject(new Error('RevenueCat configure failed'));
            }
          },
        ) as Promise<void>,
      getAppUserID: () => Promise.resolve(state.appUserId ?? ''),
      logIn: appUserID =>
        this.hold('sdk.logIn', depsId, { appUserID }, (outcome, d) => {
          if (outcome === 'ok') {
            state.appUserId = appUserID;
            d.resolve({ created: false });
          } else if (outcome === 'no_bind') {
            d.resolve({ created: false });
          } else {
            d.reject(new Error('RevenueCat logIn failed'));
          }
        }),
      getOfferings: () =>
        this.hold('sdk.getOfferings', depsId, {}, (outcome, d) => {
          if (outcome === 'error') d.reject(new Error('offerings failed'));
          else d.resolve(offerings(outcome));
        }) as ReturnType<RevenueCatSdk['getOfferings']>,
      purchasePackage: aPackage =>
        this.hold(
          'sdk.purchasePackage',
          depsId,
          { productId: aPackage.product.identifier },
          (outcome, d) => {
            switch (outcome) {
              case 'entitled':
                d.resolve({ customerInfo: customerInfo(true) });
                break;
              case 'not_entitled':
                d.resolve({ customerInfo: customerInfo(false) });
                break;
              case 'cancelled':
                d.reject({ userCancelled: true, code: '1' });
                break;
              case 'cancelled_code1':
                d.reject({ code: '1', message: 'Purchase was cancelled.' });
                break;
              default:
                d.reject({ code: '2', message: 'Store problem' });
            }
          },
        ) as ReturnType<RevenueCatSdk['purchasePackage']>,
      restorePurchases: () =>
        this.hold('sdk.restorePurchases', depsId, {}, (outcome, d) => {
          if (outcome === 'error') d.reject(new Error('restore failed'));
          else d.resolve(customerInfo(outcome === 'entitled'));
        }) as Promise<RevenueCatCustomerInfoLike>,
      getCustomerInfo: () =>
        this.hold('sdk.getCustomerInfo', depsId, {}, (outcome, d) => {
          if (outcome === 'error') d.reject(new Error('customer info failed'));
          else d.resolve(customerInfo(outcome === 'entitled'));
        }) as Promise<RevenueCatCustomerInfoLike>,
      checkTrialOrIntroductoryPriceEligibility: productIdentifiers =>
        this.hold(
          'sdk.checkTrial',
          depsId,
          { productIdentifiers },
          (outcome, d) => {
            if (outcome === 'error') {
              d.reject(new Error('eligibility failed'));
              return;
            }
            const status = outcome === 'eligible' ? 2 : 0;
            d.resolve(
              Object.fromEntries(
                productIdentifiers.map(id => [id, { status }]),
              ),
            );
          },
        ) as Promise<Record<string, { status: number }>>,
    };
  }
}
