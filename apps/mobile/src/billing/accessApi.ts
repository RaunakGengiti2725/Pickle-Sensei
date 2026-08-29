import {
  BillingError,
  type CanonicalAccessClient,
  type CanonicalAccessState,
  type CanonicalBillingState,
  type CanonicalBillingSync,
} from './types';

export type BillingFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface CanonicalAccessApiConfig {
  baseUrl: string | null | undefined;
  token: string | null | undefined;
  fetchFn?: BillingFetch;
}

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
  if (
    typeof value.premium !== 'boolean' ||
    !Array.isArray(value.entitlements) ||
    !value.entitlements.every(item => typeof item === 'string') ||
    typeof value.canStartRating !== 'boolean' ||
    typeof value.paywallRequired !== 'boolean' ||
    freeRatings.limit !== 2 ||
    !isInteger(freeRatings.used) ||
    !isInteger(freeRatings.reserved) ||
    !isInteger(freeRatings.remaining) ||
    !isInteger(freeRatings.availableToReserve)
  ) {
    throw invalidResponse();
  }
  const used = freeRatings.used;
  const reserved = freeRatings.reserved;
  const remaining = freeRatings.remaining;
  const availableToReserve = freeRatings.availableToReserve;
  const premiumEntitlement = value.entitlements.includes('premium');
  const expectedCanStart = value.premium || availableToReserve > 0;
  if (
    used < 0 ||
    used > 2 ||
    reserved < 0 ||
    remaining !== 2 - used ||
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
      limit: 2,
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
      'Sign in before checking membership access.',
      false,
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
  const request = async (path: string, method: 'GET' | 'POST') => {
    const values = configuredValues(config);
    let response: Response;
    try {
      response = await values.fetchFn(`${values.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${values.token}`,
        },
      });
    } catch {
      throw new BillingError(
        'billing.backend_unavailable',
        'Membership verification is temporarily unavailable.',
        true,
      );
    }
    if (!response.ok) {
      throw new BillingError(
        'billing.backend_unavailable',
        'Membership verification is temporarily unavailable.',
        response.status >= 500 || response.status === 429,
      );
    }
    return responseBody(response);
  };

  return {
    getAccess: async () => parseAccess(await request('/v1/me/access', 'GET')),
    syncBilling: async () => {
      const value = await request('/v1/billing/sync', 'POST');
      if (!isRecord(value)) throw invalidResponse();
      const billing = parseBilling(value.billing);
      const access = parseAccess(value.access);
      if (billing.premium !== access.premium) throw invalidResponse();
      return { billing, access } satisfies CanonicalBillingSync;
    },
  };
}
