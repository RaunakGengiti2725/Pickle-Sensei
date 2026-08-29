export type BillingPeriod = 'annual' | 'monthly';

export interface FreeTrialDisplay {
  /** Store-confirmed localized duration, for example "7-day free trial". */
  label: string;
  periodIso8601: string;
}

export interface StorePlan {
  id: string;
  productId: string;
  period: BillingPeriod;
  price: number;
  priceString: string;
  pricePerMonthString: string | null;
  freeTrial: FreeTrialDisplay | null;
}

export interface StorePlans {
  offeringId: string;
  annual: StorePlan | null;
  monthly: StorePlan | null;
}

export interface StoreEntitlementState {
  premium: boolean;
  productId: string | null;
  expirationDate: string | null;
}

export interface CanonicalAccessState {
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

export interface CanonicalBillingState {
  premium: boolean;
  productKey: string | null;
  expiresAt: string | null;
  verifiedAt: string;
}

export interface CanonicalBillingSync {
  billing: CanonicalBillingState;
  access: CanonicalAccessState;
}

export type BillingUnconfiguredReason =
  | 'missing_public_sdk_key'
  | 'missing_canonical_app_user_id'
  | 'invalid_canonical_app_user_id'
  | 'secret_key_supplied_to_client'
  | 'missing_api_base_url'
  | 'missing_api_token';

export type BillingErrorCode =
  | 'billing.unconfigured'
  | 'billing.offerings_unavailable'
  | 'billing.purchase_cancelled'
  | 'billing.purchase_failed'
  | 'billing.restore_failed'
  | 'billing.backend_unconfigured'
  | 'billing.backend_unavailable'
  | 'billing.backend_invalid_response'
  | 'billing.backend_verification_pending';

export interface BillingErrorState {
  code: BillingErrorCode;
  message: string;
  retryable: boolean;
  unconfiguredReason?: BillingUnconfiguredReason;
}

export class BillingError extends Error {
  constructor(
    readonly code: BillingErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly unconfiguredReason?: BillingUnconfiguredReason,
  ) {
    super(message);
  }

  toState(): BillingErrorState {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.unconfiguredReason
        ? { unconfiguredReason: this.unconfiguredReason }
        : {}),
    };
  }
}

export interface BillingStoreClient {
  configure(): Promise<void>;
  loadPlans(): Promise<StorePlans>;
  purchase(planId: string): Promise<StoreEntitlementState>;
  restore(): Promise<StoreEntitlementState>;
  readEntitlement(): Promise<StoreEntitlementState>;
}

export interface CanonicalAccessClient {
  getAccess(): Promise<CanonicalAccessState>;
  syncBilling(): Promise<CanonicalBillingSync>;
}

export interface BillingAccessDependencies {
  store: BillingStoreClient;
  backend: CanonicalAccessClient;
}
