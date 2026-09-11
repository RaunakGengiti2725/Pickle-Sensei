import type { PendingFulfilmentStorage } from './pendingFulfilment';

export type BillingPeriod = 'annual' | 'monthly' | 'lifetime';

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
  lifetime: StorePlan | null;
}

export interface StoreEntitlementState {
  premium: boolean;
  productId: string | null;
  expirationDate: string | null;
  transaction?: BillingTransactionEvidence;
}

/** Identifiers only: never retain receipt, purchase token, signature or session. */
export interface BillingTransactionEvidence {
  productId: string;
  transactionId: string;
  purchasedAt: string;
}

export function parseBillingTransaction(
  value: unknown,
): BillingTransactionEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const identifier = (id: unknown): id is string =>
    typeof id === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(id);
  if (
    !identifier(row.productId) ||
    !identifier(row.transactionId) ||
    typeof row.purchasedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      row.purchasedAt,
    ) ||
    !Number.isFinite(Date.parse(row.purchasedAt))
  )
    return null;
  return {
    productId: row.productId,
    transactionId: row.transactionId,
    purchasedAt: new Date(row.purchasedAt).toISOString(),
  };
}

export interface BillingFulfilmentRequest {
  pendingId: string;
  attemptId: string;
  transaction: BillingTransactionEvidence;
}

export interface BillingFulfilmentVerdict extends BillingFulfilmentRequest {
  outcome: 'pending' | 'fulfilled' | 'expired' | 'refunded';
  verifiedAt: string;
}

export interface CanonicalAccessState {
  premium: boolean;
  entitlements: string[];
  freeRatings: {
    /** The server-declared lifetime allowance (one since 2026-09-10). */
    limit: number;
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
  fulfilment?: BillingFulfilmentVerdict;
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
  | 'billing.backend_verification_pending'
  | 'billing.purchase_settled';

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
  invalidatePendingOperations?(): void;
  configure(): Promise<void>;
  loadPlans(): Promise<StorePlans>;
  purchase(planId: string): Promise<StoreEntitlementState>;
  restore(): Promise<StoreEntitlementState>;
  readEntitlement(): Promise<StoreEntitlementState>;
}

export interface CanonicalAccessClient {
  getAccess(): Promise<CanonicalAccessState>;
  syncBilling(
    fulfilment?: BillingFulfilmentRequest,
  ): Promise<CanonicalBillingSync>;
}

export interface BillingAccessDependencies {
  canonicalAppUserId?: string | null;
  pendingFulfilmentStorage?: PendingFulfilmentStorage;
  store: BillingStoreClient;
  backend: CanonicalAccessClient;
}
