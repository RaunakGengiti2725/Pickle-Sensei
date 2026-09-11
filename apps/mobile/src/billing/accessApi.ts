import {
  BillingError,
  parseBillingTransaction,
  type BillingFulfilmentRequest,
  type BillingFulfilmentVerdict,
  type CanonicalAccessClient,
  type CanonicalAccessState,
  type CanonicalBillingState,
  type CanonicalBillingSync,
} from './types';
import { reportApiUnauthorized } from '../account/apiSession';

export type BillingFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface CanonicalAccessApiConfig {
  baseUrl: string | null | undefined;
  token: string | null | undefined;
  fetchFn?: BillingFetch;
}

export const BILLING_REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function parseAccess(value: unknown): CanonicalAccessState {
  if (!isRecord(value) || !isRecord(value.freeRatings)) {
    throw invalidResponse();
  }
  const freeRatings = value.freeRatings;
  // The allowance is the server's to declare (one since 2026-09-10, two
  // before): any positive integer is accepted and every counter is checked
  // against IT, so a build and a deployment that disagree for a moment render
  // honest copy from `limit` instead of refusing the whole response.
  if (
    typeof value.premium !== 'boolean' ||
    !Array.isArray(value.entitlements) ||
    !value.entitlements.every(item => typeof item === 'string') ||
    typeof value.canStartRating !== 'boolean' ||
    typeof value.paywallRequired !== 'boolean' ||
    !isInteger(freeRatings.limit) ||
    freeRatings.limit < 1 ||
    !isInteger(freeRatings.used) ||
    !isInteger(freeRatings.reserved) ||
    !isInteger(freeRatings.remaining) ||
    !isInteger(freeRatings.availableToReserve)
  ) {
    throw invalidResponse();
  }
  const limit = freeRatings.limit;
  const used = freeRatings.used;
  const reserved = freeRatings.reserved;
  const remaining = freeRatings.remaining;
  const availableToReserve = freeRatings.availableToReserve;
  const premiumEntitlement = value.entitlements.includes('premium');
  const expectedCanStart = value.premium || availableToReserve > 0;
  if (
    used < 0 ||
    used > limit ||
    reserved < 0 ||
    remaining !== limit - used ||
    reserved > remaining ||
    availableToReserve !== remaining - reserved ||
    value.premium !== premiumEntitlement ||
    value.canStartRating !== expectedCanStart ||
    value.paywallRequired !== !expectedCanStart
  ) {
    throw invalidResponse();
  }
  return {
    premium: value.premium,
    entitlements: [...value.entitlements],
    freeRatings: {
      limit,
      used,
      reserved,
      remaining,
      availableToReserve,
    },
    canStartRating: value.canStartRating,
    paywallRequired: value.paywallRequired,
  };
}

function parseBilling(value: unknown): CanonicalBillingState {
  if (
    !isRecord(value) ||
    typeof value.premium !== 'boolean' ||
    !(value.productKey === null || typeof value.productKey === 'string') ||
    !(value.expiresAt === null || isIsoDate(value.expiresAt)) ||
    !isIsoDate(value.verifiedAt)
  ) {
    throw invalidResponse();
  }
  return {
    premium: value.premium,
    productKey: value.productKey,
    expiresAt: value.expiresAt,
    verifiedAt: value.verifiedAt,
  };
}

function invalidResponse(): BillingError {
  return new BillingError(
    'billing.backend_invalid_response',
    'The server returned an invalid membership response.',
    true,
  );
}

function configuredValues(config: CanonicalAccessApiConfig): {
  baseUrl: string;
  token: string;
  fetchFn: BillingFetch;
} {
  const baseUrl = config.baseUrl?.trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new BillingError(
      'billing.backend_unconfigured',
      'The membership API address is not configured in this build.',
      false,
      'missing_api_base_url',
    );
  }
  const token = config.token?.trim();
  if (!token) {
    throw new BillingError(
      'billing.backend_unconfigured',
      'Membership verification is waiting for your account connection. Please try again.',
      true,
      'missing_api_token',
    );
  }
  const fetchFn = config.fetchFn ?? globalThis.fetch;
  if (!fetchFn) {
    throw new BillingError(
      'billing.backend_unconfigured',
      'Network access is unavailable in this build.',
      false,
      'missing_api_base_url',
    );
  }
  return { baseUrl, token, fetchFn };
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw invalidResponse();
  }
}

export function createCanonicalAccessClient(
  config: CanonicalAccessApiConfig,
): CanonicalAccessClient {
  const request = async (
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ) => {
    const values = configuredValues(config);
    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        reject(
          new BillingError(
            'billing.backend_unavailable',
            'Membership verification took too long. Please try again.',
            true,
          ),
        );
        controller.abort();
      }, BILLING_REQUEST_TIMEOUT_MS);
    });
    const fetchAndRead = async () => {
      const response = await values.fetchFn(`${values.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${values.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (timedOut) return undefined;
      if (response.status === 401) {
        reportApiUnauthorized(values.token);
        throw new BillingError(
          'billing.backend_unavailable',
          'Your account connection needs to refresh. Please try verification again.',
          true,
        );
      }
      if (!response.ok) {
        throw new BillingError(
          'billing.backend_unavailable',
          'Membership verification is temporarily unavailable.',
          response.status >= 500 ||
            response.status === 408 ||
            response.status === 429,
        );
      }
      return responseBody(response);
    };
    try {
      return await Promise.race([fetchAndRead(), deadline]);
    } catch (cause) {
      if (cause instanceof BillingError) throw cause;
      throw new BillingError(
        'billing.backend_unavailable',
        'Membership verification is temporarily unavailable.',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    getAccess: async () => parseAccess(await request('/v1/me/access', 'GET')),
    syncBilling: async fulfilmentRequest => {
      const value = await request(
        '/v1/billing/sync',
        'POST',
        fulfilmentRequest ? { fulfilment: fulfilmentRequest } : undefined,
      );
      if (!isRecord(value)) throw invalidResponse();
      const billing = parseBilling(value.billing);
      const access = parseAccess(value.access);
      if (billing.premium !== access.premium) throw invalidResponse();
      const fulfilment =
        value.fulfilment === undefined
          ? undefined
          : parseFulfilment(value.fulfilment, fulfilmentRequest);
      return {
        billing,
        access,
        ...(fulfilment ? { fulfilment } : {}),
      } satisfies CanonicalBillingSync;
    },
  };
}

function parseFulfilment(
  value: unknown,
  request?: BillingFulfilmentRequest,
): BillingFulfilmentVerdict {
  if (!request || !isRecord(value)) throw invalidResponse();
  const transaction = parseBillingTransaction(value.transaction);
  if (
    !transaction ||
    value.pendingId !== request.pendingId ||
    value.attemptId !== request.attemptId ||
    JSON.stringify(transaction) !== JSON.stringify(request.transaction) ||
    typeof value.outcome !== 'string' ||
    !['pending', 'fulfilled', 'expired', 'refunded'].includes(value.outcome) ||
    !isIsoDate(value.verifiedAt) ||
    (value.outcome !== 'pending' &&
      Date.parse(value.verifiedAt) < Date.parse(transaction.purchasedAt))
  )
    throw invalidResponse();
  return {
    ...request,
    transaction,
    outcome: value.outcome as BillingFulfilmentVerdict['outcome'],
    verifiedAt: value.verifiedAt,
  };
}
