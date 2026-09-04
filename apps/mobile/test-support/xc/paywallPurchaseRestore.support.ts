/**
 * Shared helpers for the `journey-paywall-purchase-restore` adversarial
 * harness. Nothing in here calls `jest.mock` — each suite declares its own
 * module seams so hoisting stays local to the test file.
 *
 *  - `Prng`: seeded, replayable randomness (mulberry32). Every scenario
 *    records its seed so a failure can be re-run bit-for-bit.
 *  - `installMockPurchases` / `purchasesMock`: a stand-in for the
 *    `react-native-purchases` DEFAULT export (the `Purchases` static class)
 *    with a StoreKit-authentication ledger. Every SDK entry point that would
 *    put the App Store sign-in / payment sheet on screen on a device
 *    (`purchasePackage`, `restorePurchases`, `syncPurchases`, …) appends to
 *    `storeKitAuth`; everything else (`configure`, `getOfferings`,
 *    `getCustomerInfo`, …) is recorded in `calls` only. Purchase / restore
 *    outcomes are scripted per call (success, cancel in the SDK's exact error
 *    shape, coded StoreKit errors, non-object rejections, lagging RC
 *    backend).
 *  - `FakeAccessBackend`: the Edge Function's `GET /v1/me/access` and
 *    `POST /v1/billing/sync` with the real response invariants
 *    (`accessApi.parseAccess`), bearer validation, a RevenueCat-REST truth
 *    table the mock SDK writes into, a persisted `billing_entitlements`
 *    verdict, and per-route fault injection.
 *  - `writeArtifact`: raw JSON evidence under
 *    `artifacts/xc-journey-paywall-purchase-restore/` (or `$XC_ARTIFACT_DIR`).
 */
// The mobile tsconfig has no node types; reach node the way the other
// __tests__ do (typed `require`, ambient declarations).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage: () => {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
  };
};
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
  readFileSync: (file: string, encoding: string) => string;
  existsSync: (file: string) => boolean;
  readdirSync: (dir: string) => string[];
  statSync: (file: string) => { isDirectory(): boolean };
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

// ─── Seeded randomness ───────────────────────────────────────────────────────

export class Prng {
  private state: number;

  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** [0, 1) */
  next(): number {
    let t = (this.state += 0x6d2b79f5) >>> 0;
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

// ─── Constants shared with production code (asserted, not imported) ─────────

export const CANONICAL_USER_A = '11111111-1111-4111-8111-111111111111';
export const CANONICAL_USER_B = '22222222-2222-4222-8222-222222222222';
export const PUBLIC_SDK_KEY = 'appl_xcJourneyPublicKeyNotASecret';
export const API_BASE_URL = 'https://api.xc-journey.test';
export const PREMIUM_ENTITLEMENT = 'pickle_sensei_pro';
export const LEGACY_PREMIUM_ENTITLEMENT = 'premium';

/** The ONLY paywall controls allowed to put the App Store sheet on screen. */
export const STOREKIT_BUTTON_TEST_IDS = [
  'paywall-continue',
  'paywall-restore',
] as const;

/** Every paywall control that must NEVER reach StoreKit auth. */
export const NON_STOREKIT_BUTTON_TEST_IDS = [
  'paywall-see-plans',
  'paywall-back',
  'paywall-retry',
  'paywall-plan-monthly',
  'paywall-plan-annual',
  'paywall-plan-lifetime',
] as const;

/** react-native-purchases 10.x `PURCHASES_ERROR_CODE` string values. */
export const RC_ERROR_CODES = {
  UNKNOWN_ERROR: '0',
  PURCHASE_CANCELLED_ERROR: '1',
  STORE_PROBLEM_ERROR: '2',
  PURCHASE_NOT_ALLOWED_ERROR: '3',
  PURCHASE_INVALID_ERROR: '4',
  PRODUCT_NOT_AVAILABLE_FOR_PURCHASE_ERROR: '5',
  PRODUCT_ALREADY_PURCHASED_ERROR: '6',
  RECEIPT_ALREADY_IN_USE_ERROR: '7',
  INVALID_RECEIPT_ERROR: '8',
  MISSING_RECEIPT_FILE_ERROR: '9',
  NETWORK_ERROR: '10',
  INVALID_CREDENTIALS_ERROR: '11',
  UNEXPECTED_BACKEND_RESPONSE_ERROR: '12',
  RECEIPT_IN_USE_BY_OTHER_SUBSCRIBER_ERROR: '13',
  INVALID_APP_USER_ID_ERROR: '14',
  OPERATION_ALREADY_IN_PROGRESS_ERROR: '15',
  UNKNOWN_BACKEND_ERROR: '16',
  INVALID_APPLE_SUBSCRIPTION_KEY_ERROR: '17',
  INELIGIBLE_ERROR: '18',
  INSUFFICIENT_PERMISSIONS_ERROR: '19',
  PAYMENT_PENDING_ERROR: '20',
  INVALID_SUBSCRIBER_ATTRIBUTES_ERROR: '21',
  LOG_OUT_ANONYMOUS_USER_ERROR: '22',
  CONFIGURATION_ERROR: '23',
  UNSUPPORTED_ERROR: '24',
  EMPTY_SUBSCRIBER_ATTRIBUTES_ERROR: '25',
  PRODUCT_DISCOUNT_MISSING_IDENTIFIER_ERROR: '26',
  PRODUCT_DISCOUNT_MISSING_SUBSCRIPTION_GROUP_IDENTIFIER_ERROR: '28',
  CUSTOMER_INFO_ERROR: '29',
  SYSTEM_INFO_ERROR: '30',
  BEGIN_REFUND_REQUEST_ERROR: '31',
  PRODUCT_REQUEST_TIMED_OUT_ERROR: '32',
  API_ENDPOINT_BLOCKED: '33',
  INVALID_PROMOTIONAL_OFFER_ERROR: '34',
  OFFLINE_CONNECTION_ERROR: '35',
} as const;

export type RcErrorName = keyof typeof RC_ERROR_CODES;

/** Copy that `docs/APP_STORE_SUBMISSION.md` forbids anywhere user-facing. */
export const FORBIDDEN_COPY = [
  'Android',
  'Google Play',
  'guest mode',
  'Live Court',
  'DUPR',
  'SwingVision',
  'PB Vision',
  'Selkirk',
  'JOOLA',
  '% accurate',
  '% accuracy',
  'as good as a coach',
  'replaces your coach',
  'world-class',
  '#1',
] as const;

// ─── RevenueCat SDK mock ─────────────────────────────────────────────────────

export interface RcEntitlement {
  productIdentifier: string;
  expirationDate: string | null;
}

export interface RcCustomerInfo {
  originalAppUserId: string;
  entitlements: {
    active: Record<string, RcEntitlement>;
    all: Record<string, RcEntitlement>;
  };
}

export interface RcPackage {
  identifier: string;
  packageType: string;
  product: {
    identifier: string;
    price: number;
    priceString: string;
    pricePerMonthString: string | null;
    currencyCode: string;
    introPrice: { price: number; cycles: number; period: string } | null;
    defaultOption: null;
  };
}

export interface RcOffering {
  identifier: string;
  annual: RcPackage | null;
  monthly: RcPackage | null;
  lifetime: RcPackage | null;
}

/** The SDK's `PurchasesError` shape (fields the JS layer populates). */
export interface RcErrorLike {
  code: string;
  message: string;
  readableErrorCode: string;
  underlyingErrorMessage: string;
  userCancelled: boolean | null;
}

export type PurchaseOutcome =
  | {
      kind: 'success';
      entitlementId?: string;
      expirationDate?: string | null;
      /** RevenueCat's backend has not folded the receipt yet: the SDK still
       * returns the entitlement, but the REST verdict stays premium:false. */
      rcBackendLag?: boolean;
    }
  | {
      kind: 'success_no_entitlement';
    }
  | {
      kind: 'cancel';
      /** Which cancel signal(s) the rejection carries. */
      shape: 'both' | 'userCancelled_only' | 'code_only';
    }
  | { kind: 'error'; error: RcErrorName; userCancelled?: boolean | null }
  | { kind: 'reject_string'; value: string }
  | { kind: 'reject_null' }
  | { kind: 'hang' }
  /** Blocks until `gate` settles, then behaves like its resolved outcome —
   * lets a test sign out / switch accounts while StoreKit is "open". */
  | { kind: 'await'; gate: Promise<PurchaseOutcome> };

export type RestoreOutcome =
  | { kind: 'success' }
  | { kind: 'cancel' }
  | { kind: 'error'; error: RcErrorName }
  | { kind: 'reject_string'; value: string }
  | { kind: 'hang' };

export type StoreKitAuthApi =
  | 'purchasePackage'
  | 'purchaseProduct'
  | 'purchaseStoreProduct'
  | 'purchaseDiscountedPackage'
  | 'purchaseDiscountedProduct'
  | 'purchaseSubscriptionOption'
  | 'restorePurchases'
  | 'syncPurchases'
  | 'syncPurchasesForResult'
  | 'presentCodeRedemptionSheet';

export interface StoreKitAuthEntry {
  n: number;
  api: StoreKitAuthApi;
  appUserID: string | null;
  detail: string;
}

export interface SdkCall {
  n: number;
  api: string;
  args: unknown;
}

export interface MockPurchasesState {
  configured: boolean;
  appUserID: string | null;
  apiKey: string | null;
  calls: SdkCall[];
  storeKitAuth: StoreKitAuthEntry[];
  /** `null` → `getOfferings().current === null`. */
  offering: RcOffering | null;
  offeringsFault: RcErrorName | null;
  purchaseQueue: PurchaseOutcome[];
  restoreQueue: RestoreOutcome[];
  /** Entitlements the STORE ACCOUNT (Apple ID) holds — what a restore finds. */
  storeAccount: Record<string, RcEntitlement>;
  /** Behaves like the real SDK on `configure` when already configured. */
  configureThrowsWhenConfigured: boolean;
  logInFault: RcErrorName | null;
  /** Hook the fake backend registers so a StoreKit success reaches the
   * "RevenueCat REST" truth table (unless `rcBackendLag`). */
  onReceipt:
    | ((appUserID: string, entitlements: Record<string, RcEntitlement>) => void)
    | null;
}

const READABLE_MESSAGES: Partial<Record<RcErrorName, string>> = {
  PURCHASE_CANCELLED_ERROR: 'Purchase was cancelled.',
  STORE_PROBLEM_ERROR: 'There was a problem with the App Store.',
  PURCHASE_NOT_ALLOWED_ERROR:
    'The device or user is not allowed to make the purchase.',
  PRODUCT_ALREADY_PURCHASED_ERROR:
    'This product is already active for the user.',
  NETWORK_ERROR: 'Error performing request.',
  PAYMENT_PENDING_ERROR: 'The payment is pending.',
  OFFLINE_CONNECTION_ERROR:
    'Error performing request because the internet connection appears to be offline.',
  PRODUCT_NOT_AVAILABLE_FOR_PURCHASE_ERROR:
    'The product is not available for purchase.',
};

export function rcError(
  name: RcErrorName,
  userCancelled: boolean | null = null,
): RcErrorLike {
  const code = RC_ERROR_CODES[name];
  return {
    code,
    message: READABLE_MESSAGES[name] ?? `RevenueCat error ${name}`,
    readableErrorCode: name,
    underlyingErrorMessage: '',
    userCancelled:
      userCancelled ?? code === RC_ERROR_CODES.PURCHASE_CANCELLED_ERROR,
  };
}

function freshState(): MockPurchasesState {
  return {
    configured: false,
    appUserID: null,
    apiKey: null,
    calls: [],
    storeKitAuth: [],
    offering: null,
    offeringsFault: null,
    purchaseQueue: [],
    restoreQueue: [],
    storeAccount: {},
    configureThrowsWhenConfigured: false,
    logInFault: null,
    onReceipt: null,
  };
}

/** Module singleton shared between the `jest.mock` factory and the suite. */
export const purchasesMock: { state: MockPurchasesState } = {
  state: freshState(),
};

export function resetPurchasesMock(): MockPurchasesState {
  purchasesMock.state = freshState();
  return purchasesMock.state;
}

function customerInfo(state: MockPurchasesState): RcCustomerInfo {
  const active: Record<string, RcEntitlement> = {};
  for (const [id, entitlement] of Object.entries(state.storeAccount)) {
    const expired =
      entitlement.expirationDate !== null &&
      Date.parse(entitlement.expirationDate) <= Date.now();
    if (!expired) active[id] = { ...entitlement };
  }
  return {
    originalAppUserId: state.appUserID ?? '$RCAnonymousID:mock',
    entitlements: { active, all: { ...state.storeAccount } },
  };
}

function record(state: MockPurchasesState, api: string, args: unknown): void {
  state.calls.push({ n: state.calls.length + 1, api, args });
}

function recordStoreKitAuth(
  state: MockPurchasesState,
  api: StoreKitAuthApi,
  detail: string,
): void {
  state.storeKitAuth.push({
    n: state.storeKitAuth.length + 1,
    api,
    appUserID: state.appUserID,
    detail,
  });
}

const never = () => new Promise<never>(() => undefined);

/**
 * Builds the module object `jest.mock('react-native-purchases', factory)`
 * should return. Mirrors the static-class surface of the real SDK that the
 * app (and any future caller) could reach; unknown methods are absent on
 * purpose so a new production call site fails loudly here.
 */
export function installMockPurchases(): {
  __esModule: true;
  default: Record<string, (...args: unknown[]) => unknown>;
  PURCHASES_ERROR_CODE: typeof RC_ERROR_CODES;
} {
  const s = () => purchasesMock.state;

  const purchaseLike = async (
    api: StoreKitAuthApi,
    detail: string,
    aPackage: unknown,
  ) => {
    const state = s();
    record(state, api, aPackage);
    recordStoreKitAuth(state, api, detail);
    let outcome: PurchaseOutcome = state.purchaseQueue.shift() ?? {
      kind: 'success',
    };
    while (outcome.kind === 'await') outcome = await outcome.gate;
    switch (outcome.kind) {
      case 'success': {
        const entitlementId = outcome.entitlementId ?? PREMIUM_ENTITLEMENT;
        const pkg = aPackage as RcPackage | undefined;
        const granted: RcEntitlement = {
          productIdentifier: pkg?.product.identifier ?? 'unknown_product',
          expirationDate:
            outcome.expirationDate === undefined
              ? pkg?.packageType === 'LIFETIME'
                ? null
                : new Date(Date.now() + 86_400_000).toISOString()
              : outcome.expirationDate,
        };
        state.storeAccount[entitlementId] = granted;
        if (!outcome.rcBackendLag && state.appUserID) {
          state.onReceipt?.(state.appUserID, { [entitlementId]: granted });
        }
        return { customerInfo: customerInfo(state) };
      }
      case 'success_no_entitlement':
        return { customerInfo: customerInfo(state) };
      case 'cancel': {
        const error = rcError('PURCHASE_CANCELLED_ERROR', true);
        if (outcome.shape === 'userCancelled_only') {
          throw { ...error, code: RC_ERROR_CODES.UNKNOWN_ERROR };
        }
        if (outcome.shape === 'code_only')
          throw { ...error, userCancelled: null };
        throw error;
      }
      case 'error':
        throw rcError(outcome.error, outcome.userCancelled ?? false);
      case 'reject_string':
        throw outcome.value;
      case 'reject_null':
        throw null;
      case 'hang':
        return never();
    }
  };

  const restoreLike = async (api: StoreKitAuthApi, detail: string) => {
    const state = s();
    record(state, api, undefined);
    recordStoreKitAuth(state, api, detail);
    const outcome = state.restoreQueue.shift() ?? { kind: 'success' };
    switch (outcome.kind) {
      case 'success': {
        const info = customerInfo(state);
        if (state.appUserID)
          state.onReceipt?.(state.appUserID, info.entitlements.active);
        return info;
      }
      case 'cancel':
        throw rcError('PURCHASE_CANCELLED_ERROR', true);
      case 'error':
        throw rcError(outcome.error, false);
      case 'reject_string':
        throw outcome.value;
      case 'hang':
        return never();
    }
  };

  const Purchases: Record<string, (...args: unknown[]) => unknown> = {
    isConfigured: async () => {
      record(s(), 'isConfigured', undefined);
      return s().configured;
    },
    configure: (configuration: unknown) => {
      const state = s();
      record(state, 'configure', configuration);
      if (state.configured && state.configureThrowsWhenConfigured) {
        throw new Error(
          'Purchases instance already set. Did you mean to configure two Purchases objects?',
        );
      }
      const cfg = configuration as {
        apiKey: string;
        appUserID?: string | null;
      };
      state.configured = true;
      state.apiKey = cfg.apiKey;
      state.appUserID = cfg.appUserID ?? '$RCAnonymousID:mock';
    },
    getAppUserID: async () => {
      const state = s();
      record(state, 'getAppUserID', undefined);
      if (!state.configured)
        throw new Error(
          'There is no singleton instance. Make sure you configure Purchases before trying to get the default instance.',
        );
      return state.appUserID;
    },
    logIn: async (appUserID: unknown) => {
      const state = s();
      record(state, 'logIn', appUserID);
      if (state.logInFault) throw rcError(state.logInFault, false);
      const created = state.appUserID !== appUserID;
      state.appUserID = String(appUserID);
      return { customerInfo: customerInfo(state), created };
    },
    logOut: async () => {
      const state = s();
      record(state, 'logOut', undefined);
      state.appUserID = '$RCAnonymousID:mock';
      return customerInfo(state);
    },
    getOfferings: async () => {
      const state = s();
      record(state, 'getOfferings', undefined);
      if (state.offeringsFault) throw rcError(state.offeringsFault, false);
      return {
        current: state.offering,
        all: state.offering
          ? { [state.offering.identifier]: state.offering }
          : {},
      };
    },
    getCustomerInfo: async () => {
      record(s(), 'getCustomerInfo', undefined);
      return customerInfo(s());
    },
    checkTrialOrIntroductoryPriceEligibility: async (ids: unknown) => {
      record(s(), 'checkTrialOrIntroductoryPriceEligibility', ids);
      const out: Record<string, { status: number; description: string }> = {};
      for (const id of ids as string[])
        out[id] = { status: 2, description: 'eligible' };
      return out;
    },
    purchasePackage: (aPackage: unknown) =>
      purchaseLike(
        'purchasePackage',
        `package=${(aPackage as RcPackage | undefined)?.identifier ?? '?'}`,
        aPackage,
      ),
    purchaseProduct: (productId: unknown) =>
      purchaseLike(
        'purchaseProduct',
        `product=${String(productId)}`,
        undefined,
      ),
    purchaseStoreProduct: (_product: unknown) =>
      purchaseLike('purchaseStoreProduct', 'storeProduct', undefined),
    purchaseDiscountedPackage: (aPackage: unknown) =>
      purchaseLike('purchaseDiscountedPackage', 'discountedPackage', aPackage),
    purchaseDiscountedProduct: () =>
      purchaseLike('purchaseDiscountedProduct', 'discountedProduct', undefined),
    purchaseSubscriptionOption: () =>
      purchaseLike(
        'purchaseSubscriptionOption',
        'subscriptionOption',
        undefined,
      ),
    restorePurchases: () => restoreLike('restorePurchases', 'restore'),
    syncPurchases: () => restoreLike('syncPurchases', 'sync'),
    syncPurchasesForResult: () =>
      restoreLike('syncPurchasesForResult', 'syncForResult'),
    presentCodeRedemptionSheet: async () => {
      record(s(), 'presentCodeRedemptionSheet', undefined);
      recordStoreKitAuth(s(), 'presentCodeRedemptionSheet', 'codeRedemption');
    },
    setLogLevel: async () => {
      record(s(), 'setLogLevel', undefined);
    },
    addCustomerInfoUpdateListener: () => {
      record(s(), 'addCustomerInfoUpdateListener', undefined);
    },
    removeCustomerInfoUpdateListener: () => {
      record(s(), 'removeCustomerInfoUpdateListener', undefined);
      return true;
    },
  };

  return {
    __esModule: true,
    default: Purchases,
    PURCHASES_ERROR_CODE: RC_ERROR_CODES,
  };
}

// ─── Offerings generators ────────────────────────────────────────────────────

export interface Storefront {
  currencyCode: string;
  format: (amount: number) => string;
}

/** Store-formatted price strings in several locales — the app must echo these
 * verbatim and never re-format, round, or substitute a USD target. */
export const STOREFRONTS: readonly Storefront[] = [
  { currencyCode: 'USD', format: amount => `$${amount.toFixed(2)}` },
  {
    currencyCode: 'EUR',
    format: amount => `${amount.toFixed(2).replace('.', ',')} €`,
  },
  { currencyCode: 'GBP', format: amount => `£${amount.toFixed(2)}` },
  {
    currencyCode: 'JPY',
    format: amount => `¥${Math.round(amount).toLocaleString('en-US')}`,
  },
  { currencyCode: 'INR', format: amount => `₹${amount.toFixed(2)}` },
  {
    currencyCode: 'BRL',
    format: amount => `R$ ${amount.toFixed(2).replace('.', ',')}`,
  },
  { currencyCode: 'CHF', format: amount => `CHF ${amount.toFixed(2)}` },
  {
    currencyCode: 'KRW',
    format: amount => `₩${Math.round(amount).toLocaleString('en-US')}`,
  },
];

export function makePackage(
  packageType: 'MONTHLY' | 'ANNUAL' | 'LIFETIME',
  productId: string,
  price: number,
  storefront: Storefront,
  options?: { introPeriod?: string | null; identifier?: string },
): RcPackage {
  const perMonth =
    packageType === 'ANNUAL'
      ? storefront.format(price / 12)
      : packageType === 'MONTHLY'
        ? storefront.format(price)
        : null;
  return {
    identifier:
      options?.identifier ??
      (packageType === 'MONTHLY'
        ? '$rc_monthly'
        : packageType === 'ANNUAL'
          ? '$rc_annual'
          : '$rc_lifetime'),
    packageType,
    product: {
      identifier: productId,
      price,
      priceString: storefront.format(price),
      pricePerMonthString: perMonth,
      currencyCode: storefront.currencyCode,
      introPrice: options?.introPeriod
        ? { price: 0, cycles: 1, period: options.introPeriod }
        : null,
      defaultOption: null,
    },
  };
}

/** The dossier's target price points as a US storefront would return them. */
export function targetOffering(): RcOffering {
  const usd = STOREFRONTS[0]!;
  return {
    identifier: 'default',
    monthly: makePackage('MONTHLY', 'pickle_sensei_pro_monthly', 7.99, usd),
    annual: makePackage('ANNUAL', 'pickle_sensei_pro_yearly', 59.99, usd),
    lifetime: makePackage(
      'LIFETIME',
      'pickle_sensei_pro_lifetime',
      159.99,
      usd,
    ),
  };
}

export interface RandomOfferingRecord {
  seed: number;
  currencyCode: string;
  monthly: { price: number; priceString: string } | null;
  annual: {
    price: number;
    priceString: string;
    perMonth: string | null;
  } | null;
  lifetime: { price: number; priceString: string } | null;
  introPeriod: string | null;
}

/** A randomized but internally consistent storefront offering. Prices are
 * deliberately NOT the dossier targets so any hard-coded "$7.99 / $59.99 /
 * $159.99" leaking into the UI is caught. */
export function randomOffering(prng: Prng): {
  offering: RcOffering;
  record: RandomOfferingRecord;
} {
  const storefront = prng.pick(STOREFRONTS);
  const zeroDecimals =
    storefront.currencyCode === 'JPY' || storefront.currencyCode === 'KRW';
  const scale = zeroDecimals ? 150 : 1;
  const monthlyPrice = zeroDecimals
    ? Math.round((1 + prng.int(30)) * scale)
    : Number((0.99 + prng.int(3000) / 100).toFixed(2));
  // Annual anywhere from 40% to 130% of 12× monthly, so the SAVE chip is
  // exercised both present and absent.
  const annualPrice = zeroDecimals
    ? Math.round(monthlyPrice * 12 * (0.4 + prng.next() * 0.9))
    : Number((monthlyPrice * 12 * (0.4 + prng.next() * 0.9)).toFixed(2));
  const lifetimePrice = zeroDecimals
    ? Math.round(annualPrice * (1.5 + prng.next() * 3))
    : Number((annualPrice * (1.5 + prng.next() * 3)).toFixed(2));
  const introPeriod = prng.chance(0.3)
    ? prng.pick(['P3D', 'P1W', 'P2W', 'P1M'])
    : null;
  const includeMonthly = prng.chance(0.9);
  const includeAnnual = prng.chance(0.9);
  const includeLifetime =
    prng.chance(0.85) || (!includeMonthly && !includeAnnual);
  const monthly = includeMonthly
    ? makePackage(
        'MONTHLY',
        `xc_monthly_${prng.int(1e6)}`,
        monthlyPrice,
        storefront,
      )
    : null;
  const annual = includeAnnual
    ? makePackage(
        'ANNUAL',
        `xc_annual_${prng.int(1e6)}`,
        annualPrice,
        storefront,
        { introPeriod },
      )
    : null;
  const lifetime = includeLifetime
    ? makePackage(
        'LIFETIME',
        `xc_lifetime_${prng.int(1e6)}`,
        lifetimePrice,
        storefront,
      )
    : null;
  return {
    offering: {
      identifier: `offering_${prng.int(1e5)}`,
      monthly,
      annual,
      lifetime,
    },
    record: {
      seed: prng.seed,
      currencyCode: storefront.currencyCode,
      monthly: monthly
        ? {
            price: monthly.product.price,
            priceString: monthly.product.priceString,
          }
        : null,
      annual: annual
        ? {
            price: annual.product.price,
            priceString: annual.product.priceString,
            perMonth: annual.product.pricePerMonthString,
          }
        : null,
      lifetime: lifetime
        ? {
            price: lifetime.product.price,
            priceString: lifetime.product.priceString,
          }
        : null,
      introPeriod,
    },
  };
}

/** Dossier target prices as literal strings — must never appear unless the
 * store returned exactly them. */
export const TARGET_PRICE_LITERALS = [
  '$7.99',
  '$59.99',
  '$159.99',
  '7.99',
  '59.99',
  '159.99',
] as const;

// ─── Fake canonical-access backend ───────────────────────────────────────────

export type Fault =
  | { kind: 'status'; status: number; body?: unknown }
  | { kind: 'network' }
  | { kind: 'hang' }
  | { kind: 'malformed' }
  | { kind: 'delay'; ms: number }
  | { kind: 'inconsistent_premium' }
  | { kind: 'bad_arithmetic' };

export type BackendRoute = 'access' | 'sync';

export interface BackendCall {
  n: number;
  route: BackendRoute | 'unknown';
  method: string;
  url: string;
  bearer: string | null;
  outcome: string;
}

export interface CanonicalAccessPayload {
  premium: boolean;
  entitlements: string[];
  freeRatings: {
    limit: 2;
    used: number;
    reserved: number;
    remaining: number;
    availableToReserve: number;
  };
  canStartRating: boolean;
  paywallRequired: boolean;
}

export interface UserLedger {
  used: number;
  reserved: number;
}

export class FakeAccessBackend {
  readonly calls: BackendCall[] = [];
  /** Bearer → canonical user id. Rotate by adding/removing entries. */
  readonly bearers = new Map<string, string>();
  /** Free-rating ledger per canonical user. */
  readonly ledgers = new Map<string, UserLedger>();
  /** "RevenueCat REST" truth: what `verifyRevenueCatSubscriber` would read. */
  readonly rcSubscribers = new Map<string, Record<string, RcEntitlement>>();
  /** `billing_entitlements` — persisted verified verdict per user. */
  readonly persistedVerdicts = new Map<
    string,
    {
      premium: boolean;
      productKey: string | null;
      expiresAt: string | null;
      verifiedAt: string;
    }
  >();
  readonly faults: Partial<Record<BackendRoute, Fault[]>> = {};
  /** RevenueCat REST unreachable → sync answers 502 billing_unavailable. */
  rcRestDown = false;
  private clock = 1_756_800_000_000;

  constructor(readonly baseUrl: string = API_BASE_URL) {}

  now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  /** Wire the mock SDK so StoreKit successes land in the RC truth table. */
  attachSdk(state: MockPurchasesState): void {
    state.onReceipt = (appUserID, entitlements) => {
      const current = this.rcSubscribers.get(appUserID) ?? {};
      this.rcSubscribers.set(appUserID, { ...current, ...entitlements });
    };
  }

  fault(route: BackendRoute, fault: Fault): void {
    (this.faults[route] ??= []).push(fault);
  }

  callsTo(route: BackendRoute): BackendCall[] {
    return this.calls.filter(call => call.route === route);
  }

  private ledger(userId: string): UserLedger {
    let ledger = this.ledgers.get(userId);
    if (!ledger) {
      ledger = { used: 0, reserved: 0 };
      this.ledgers.set(userId, ledger);
    }
    return ledger;
  }

  private verdict(userId: string) {
    const entitlements = this.rcSubscribers.get(userId) ?? {};
    let premium = false;
    let productKey: string | null = null;
    let expiresAt: string | null = null;
    const active: string[] = [];
    for (const name of [PREMIUM_ENTITLEMENT, LEGACY_PREMIUM_ENTITLEMENT]) {
      const entitlement = entitlements[name];
      if (!entitlement) continue;
      const isActive =
        entitlement.expirationDate === null ||
        Date.parse(entitlement.expirationDate) > Date.now();
      if (!isActive) continue;
      active.push(name);
      if (!premium) {
        premium = true;
        productKey = entitlement.productIdentifier;
        expiresAt = entitlement.expirationDate;
      }
    }
    return { premium, productKey, expiresAt, activeEntitlements: active };
  }

  accessPayload(userId: string, premium: boolean): CanonicalAccessPayload {
    const ledger = this.ledger(userId);
    const remaining = 2 - ledger.used;
    const availableToReserve = remaining - ledger.reserved;
    const canStartRating = premium || availableToReserve > 0;
    return {
      premium,
      entitlements: premium ? ['premium', PREMIUM_ENTITLEMENT] : [],
      freeRatings: {
        limit: 2,
        used: ledger.used,
        reserved: ledger.reserved,
        remaining,
        availableToReserve,
      },
      canStartRating,
      paywallRequired: !canStartRating,
    };
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  private routeOf(url: string, method: string): BackendRoute | 'unknown' {
    const pathname = url.startsWith(this.baseUrl)
      ? url.slice(this.baseUrl.length)
      : url;
    if (pathname === '/v1/me/access' && method === 'GET') return 'access';
    if (pathname === '/v1/billing/sync' && method === 'POST') return 'sync';
    return 'unknown';
  }

  readonly fetch = async (
    input: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authorization =
      headers.Authorization ?? headers.authorization ?? null;
    const bearer = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : null;
    const route = this.routeOf(input, method);
    const call: BackendCall = {
      n: this.calls.length + 1,
      route,
      method,
      url: input,
      bearer,
      outcome: '',
    };
    this.calls.push(call);

    if (route === 'unknown') {
      call.outcome = '404';
      return this.json(404, { error: { code: 'not_found' } });
    }

    const fault = this.faults[route]?.shift();
    if (fault) {
      call.outcome = `fault:${fault.kind}`;
      switch (fault.kind) {
        case 'network':
          throw new TypeError('Network request failed');
        case 'hang':
          return never();
        case 'status':
          return this.json(
            fault.status,
            fault.body ?? { error: { code: `fault_${fault.status}` } },
          );
        case 'malformed':
          return new Response('<html>not json</html>', { status: 200 });
        case 'delay':
          await new Promise<void>(resolve =>
            setTimeout(() => resolve(), fault.ms),
          );
          break;
        case 'inconsistent_premium': {
          const userId = bearer ? this.bearers.get(bearer) : undefined;
          if (!userId) break;
          const access = this.accessPayload(userId, false);
          return this.json(200, {
            billing: {
              premium: true,
              productKey: 'x',
              expiresAt: null,
              verifiedAt: this.now(),
            },
            access,
          });
        }
        case 'bad_arithmetic': {
          const userId = bearer ? this.bearers.get(bearer) : undefined;
          if (!userId) break;
          const access = this.accessPayload(userId, false);
          access.freeRatings.remaining = 5;
          return this.json(
            200,
            route === 'access'
              ? access
              : {
                  billing: {
                    premium: false,
                    productKey: null,
                    expiresAt: null,
                    verifiedAt: this.now(),
                  },
                  access,
                },
          );
        }
      }
    }

    const userId = bearer ? this.bearers.get(bearer) : undefined;
    if (!userId) {
      call.outcome = '401';
      return this.json(401, { error: { code: 'unauthorized' } });
    }

    if (route === 'access') {
      const persisted = this.persistedVerdicts.get(userId);
      const premium = persisted
        ? persisted.premium &&
          (persisted.expiresAt === null ||
            Date.parse(persisted.expiresAt) > Date.now())
        : false;
      call.outcome = `200 premium=${premium}`;
      return this.json(200, this.accessPayload(userId, premium));
    }

    if (this.rcRestDown) {
      call.outcome = '502 billing_unavailable';
      return this.json(502, {
        error: {
          code: 'billing_unavailable',
          message:
            'The billing provider could not be reached to verify membership. Try again shortly.',
        },
      });
    }
    const verdict = this.verdict(userId);
    const verifiedAt = this.now();
    this.persistedVerdicts.set(userId, {
      premium: verdict.premium,
      productKey: verdict.productKey,
      expiresAt: verdict.expiresAt,
      verifiedAt,
    });
    call.outcome = `200 premium=${verdict.premium}`;
    return this.json(200, {
      billing: {
        premium: verdict.premium,
        productKey: verdict.productKey,
        expiresAt: verdict.expiresAt,
        verifiedAt,
      },
      access: this.accessPayload(userId, verdict.premium),
    });
  };
}

// ─── Artifacts ───────────────────────────────────────────────────────────────

export const ARTIFACT_DIR: string =
  process.env.XC_ARTIFACT_DIR ??
  path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'artifacts',
    'xc-journey-paywall-purchase-restore',
  );

export function writeArtifact(name: string, data: unknown): string {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

export function heapSnapshot(): { heapUsedMb: number; rssMb: number } {
  const usage = process.memoryUsage();
  return {
    heapUsedMb: Number((usage.heapUsed / 1_048_576).toFixed(1)),
    rssMb: Number((usage.rss / 1_048_576).toFixed(1)),
  };
}

/** Recursively list source files (for the static import-site pins). */
export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

export function readSource(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

export function sourceRoot(): string {
  return path.resolve(__dirname, '..', '..', 'src');
}

export function fileExists(file: string): boolean {
  return fs.existsSync(file);
}

/** Every forbidden dossier term present in a rendered-text blob. */
export function forbiddenCopyIn(text: string): string[] {
  const lower = text.toLowerCase();
  return FORBIDDEN_COPY.filter(term => lower.includes(term.toLowerCase()));
}
