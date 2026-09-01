import { Platform } from 'react-native';
import {
  BillingError,
  type BillingPeriod,
  type BillingStoreClient,
  type FreeTrialDisplay,
  type StoreEntitlementState,
  type StorePlan,
} from './types';

/**
 * The single premium entitlement concept. The RevenueCat dashboard may expose
 * it under either identifier ('pickle_sensei_pro' is current, 'premium' is
 * legacy); holding either one unlocks the same access.
 */
const PREMIUM_ENTITLEMENT = 'pickle_sensei_pro';
const LEGACY_PREMIUM_ENTITLEMENT = 'premium';
const ELIGIBLE_FOR_INTRO_OFFER = 2;

export type BillingPlatform = 'ios' | 'android' | 'other';

export interface RevenueCatPricingPhaseLike {
  billingPeriod: string;
  billingCycleCount: number | null;
  price: { amountMicros: number };
}

export interface RevenueCatPackageLike {
  identifier: string;
  packageType: string;
  product: {
    identifier: string;
    price: number;
    priceString: string;
    pricePerMonthString: string | null;
    introPrice: {
      price: number;
      cycles: number;
      period: string;
    } | null;
    defaultOption: {
      freePhase: RevenueCatPricingPhaseLike | null;
    } | null;
  };
}

export interface RevenueCatCustomerInfoLike {
  entitlements: {
    active: Record<
      string,
      {
        productIdentifier: string;
        expirationDate: string | null;
      }
    >;
  };
}

export interface RevenueCatSdk {
  isConfigured(): Promise<boolean>;
  configure(configuration: {
    apiKey: string;
    appUserID: string;
  }): void | Promise<void>;
  getAppUserID(): Promise<string>;
  logIn(appUserID: string): Promise<unknown>;
  getOfferings(): Promise<{
    current: {
      identifier: string;
      annual: RevenueCatPackageLike | null;
      monthly: RevenueCatPackageLike | null;
      lifetime: RevenueCatPackageLike | null;
    } | null;
  }>;
  purchasePackage(aPackage: RevenueCatPackageLike): Promise<{
    customerInfo: RevenueCatCustomerInfoLike;
  }>;
  restorePurchases(): Promise<RevenueCatCustomerInfoLike>;
  getCustomerInfo(): Promise<RevenueCatCustomerInfoLike>;
  checkTrialOrIntroductoryPriceEligibility(
    productIdentifiers: string[],
  ): Promise<Record<string, { status: number }>>;
}

export interface RevenueCatBillingConfig {
  publicSdkKey: string | null | undefined;
  /** The canonical `app_user.id` UUID returned by this app's backend. */
  canonicalAppUserId: string | null | undefined;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function configuredValues(config: RevenueCatBillingConfig): {
  publicSdkKey: string;
  canonicalAppUserId: string;
} {
  const publicSdkKey = config.publicSdkKey?.trim();
  if (!publicSdkKey) {
    throw new BillingError(
      'billing.unconfigured',
      'RevenueCat is not configured in this build.',
      false,
      'missing_public_sdk_key',
    );
  }
  if (/^sk_/i.test(publicSdkKey)) {
    throw new BillingError(
      'billing.unconfigured',
      'A RevenueCat secret key cannot be used in the mobile app.',
      false,
      'secret_key_supplied_to_client',
    );
  }

  const canonicalAppUserId = config.canonicalAppUserId?.trim();
  if (!canonicalAppUserId) {
    throw new BillingError(
      'billing.unconfigured',
      'Billing needs the canonical account ID returned by the backend.',
      false,
      'missing_canonical_app_user_id',
    );
  }
  if (!UUID_PATTERN.test(canonicalAppUserId)) {
    throw new BillingError(
      'billing.unconfigured',
      'Billing rejected a non-canonical account identifier.',
      false,
      'invalid_canonical_app_user_id',
    );
  }
  return { publicSdkKey, canonicalAppUserId };
}

async function loadNativeSdk(): Promise<RevenueCatSdk> {
  const module = await import('react-native-purchases');
  return module.default as unknown as RevenueCatSdk;
}

function currentPlatform(): BillingPlatform {
  if (Platform.OS === 'ios' || Platform.OS === 'android') return Platform.OS;
  return 'other';
}

function entitlementFrom(
  customerInfo: RevenueCatCustomerInfoLike,
): StoreEntitlementState {
  const active = customerInfo.entitlements.active;
  const entitlement =
    active[PREMIUM_ENTITLEMENT] ?? active[LEGACY_PREMIUM_ENTITLEMENT];
  return {
    premium: Boolean(entitlement),
    productId: entitlement?.productIdentifier ?? null,
    expirationDate: entitlement?.expirationDate ?? null,
  };
}

function totalTrialPeriod(
  period: string,
  cycles: number | null,
): string | null {
  const parsed = /^P(\d+)([DWMY])$/.exec(period.toUpperCase());
  if (!parsed) return null;
  const units = Number(parsed[1]);
  const repetitions = cycles ?? 1;
  if (!Number.isSafeInteger(units) || units <= 0) return null;
  if (!Number.isSafeInteger(repetitions) || repetitions <= 0) return null;
  return `P${units * repetitions}${parsed[2]}`;
}

function trialLabel(periodIso8601: string): string | null {
  const parsed = /^P(\d+)([DWMY])$/.exec(periodIso8601);
  if (!parsed) return null;
  const count = Number(parsed[1]);
  const unitKey = parsed[2] as 'D' | 'W' | 'M' | 'Y';
  const unit = {
    D: 'day',
    W: 'week',
    M: 'month',
    Y: 'year',
  }[unitKey];
  if (!unit || !Number.isSafeInteger(count) || count <= 0) return null;
  return `${count}-${unit} free trial`;
}

function freeTrialDisplay(
  periodIso8601: string | null,
): FreeTrialDisplay | null {
  if (!periodIso8601) return null;
  const label = trialLabel(periodIso8601);
  return label ? { label, periodIso8601 } : null;
}

function isCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { userCancelled?: unknown; code?: unknown };
  return candidate.userCancelled === true || candidate.code === '1';
}

function purchaseError(error: unknown): BillingError {
  if (isCancellation(error)) {
    return new BillingError(
      'billing.purchase_cancelled',
      'Purchase canceled.',
      false,
    );
  }
  return new BillingError(
    'billing.purchase_failed',
    'The app store could not complete the purchase. Please try again.',
    true,
  );
}

export function createRevenueCatBillingClient(
  config: RevenueCatBillingConfig,
  injectedSdk?: RevenueCatSdk,
  injectedPlatform?: BillingPlatform,
): BillingStoreClient {
  let sdkPromise: Promise<RevenueCatSdk> | null = null;
  let configurationPromise: Promise<void> | null = null;
  const packageByPlanId = new Map<string, RevenueCatPackageLike>();

  const sdk = () => {
    sdkPromise ??= injectedSdk ? Promise.resolve(injectedSdk) : loadNativeSdk();
    return sdkPromise;
  };

  const configure = async () => {
    if (configurationPromise) return configurationPromise;
    configurationPromise = (async () => {
      const values = configuredValues(config);
      const native = await sdk();
      if (!(await native.isConfigured())) {
        await native.configure({
          apiKey: values.publicSdkKey,
          appUserID: values.canonicalAppUserId,
        });
      } else if ((await native.getAppUserID()) !== values.canonicalAppUserId) {
        await native.logIn(values.canonicalAppUserId);
      }
      if ((await native.getAppUserID()) !== values.canonicalAppUserId) {
        throw new BillingError(
          'billing.unconfigured',
          'RevenueCat could not bind to the canonical account ID.',
          false,
          'invalid_canonical_app_user_id',
        );
      }
    })();
    try {
      await configurationPromise;
    } catch (error) {
      configurationPromise = null;
      throw error;
    }
  };

  const detectTrial = async (
    aPackage: RevenueCatPackageLike,
  ): Promise<FreeTrialDisplay | null> => {
    const platform = injectedPlatform ?? currentPlatform();
    if (platform === 'android') {
      const freePhase = aPackage.product.defaultOption?.freePhase;
      if (!freePhase || freePhase.price.amountMicros !== 0) return null;
      return freeTrialDisplay(
        totalTrialPeriod(freePhase.billingPeriod, freePhase.billingCycleCount),
      );
    }
    if (platform !== 'ios') return null;
    const intro = aPackage.product.introPrice;
    if (!intro || intro.price !== 0) return null;
    try {
      const eligibility = await (
        await sdk()
      ).checkTrialOrIntroductoryPriceEligibility([aPackage.product.identifier]);
      if (
        eligibility[aPackage.product.identifier]?.status !==
        ELIGIBLE_FOR_INTRO_OFFER
      ) {
        return null;
      }
      return freeTrialDisplay(totalTrialPeriod(intro.period, intro.cycles));
    } catch {
      // Unknown eligibility must render standard pricing, never a trial claim.
      return null;
    }
  };

  const normalizePlan = async (
    offeringId: string,
    period: BillingPeriod,
    aPackage: RevenueCatPackageLike | null,
  ): Promise<StorePlan | null> => {
    const expectedPackageType =
      period === 'annual'
        ? 'ANNUAL'
        : period === 'lifetime'
          ? 'LIFETIME'
          : 'MONTHLY';
    if (!aPackage || aPackage.packageType !== expectedPackageType) return null;
    const product = aPackage.product;
    if (
      !product.identifier ||
      !Number.isFinite(product.price) ||
      product.price < 0 ||
      !product.priceString
    ) {
      return null;
    }
    const id = `${offeringId}:${period}:${aPackage.identifier}:${product.identifier}`;
    packageByPlanId.set(id, aPackage);
    // A lifetime product is a one-time purchase: it has no per-month price
    // and can never carry an introductory free trial.
    return {
      id,
      productId: product.identifier,
      period,
      price: product.price,
      priceString: product.priceString,
      pricePerMonthString:
        period === 'lifetime' ? null : product.pricePerMonthString || null,
      freeTrial: period === 'lifetime' ? null : await detectTrial(aPackage),
    };
  };

  return {
    configure,

    loadPlans: async () => {
      await configure();
      const offering = (await (await sdk()).getOfferings()).current;
      if (!offering) {
        throw new BillingError(
          'billing.offerings_unavailable',
          'Membership pricing is unavailable from the app store right now.',
          true,
        );
      }
      packageByPlanId.clear();
      const [annual, monthly, lifetime] = await Promise.all([
        normalizePlan(offering.identifier, 'annual', offering.annual),
        normalizePlan(offering.identifier, 'monthly', offering.monthly),
        normalizePlan(offering.identifier, 'lifetime', offering.lifetime),
      ]);
      if (!annual && !monthly && !lifetime) {
        throw new BillingError(
          'billing.offerings_unavailable',
          'Annual, monthly, and lifetime membership plans are unavailable from the app store.',
          true,
        );
      }
      return { offeringId: offering.identifier, annual, monthly, lifetime };
    },

    purchase: async planId => {
      await configure();
      const aPackage = packageByPlanId.get(planId);
      if (!aPackage) {
        throw new BillingError(
          'billing.offerings_unavailable',
          'That store plan is no longer available. Refresh pricing and try again.',
          true,
        );
      }
      try {
        const result = await (await sdk()).purchasePackage(aPackage);
        return entitlementFrom(result.customerInfo);
      } catch (error) {
        throw purchaseError(error);
      }
    },

    restore: async () => {
      await configure();
      try {
        return entitlementFrom(await (await sdk()).restorePurchases());
      } catch {
        throw new BillingError(
          'billing.restore_failed',
          'The app store could not restore purchases. Please try again.',
          true,
        );
      }
    },

    readEntitlement: async () => {
      await configure();
      return entitlementFrom(await (await sdk()).getCustomerInfo());
    },
  };
}
