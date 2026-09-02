import { createCanonicalAccessClient } from './accessApi';
import { createRevenueCatBillingClient } from './revenueCatClient';
import type { BillingPlatform, RevenueCatSdk } from './revenueCatClient';
import type { BillingFetch } from './accessApi';
import type { BillingAccessDependencies } from './types';

export * from './types';
export * from './accessApi';
export * from './revenueCatClient';

export interface BillingAccessConfig {
  revenueCatPublicSdkKey: string | null | undefined;
  /** Canonical UUID from the backend account response; never an auth subject. */
  canonicalAppUserId: string | null | undefined;
  apiBaseUrl: string | null | undefined;
  /** Read on every backend request (a getter here keeps following a rotating
   * access token), never captured at construction. */
  apiToken: string | null | undefined;
  fetchFn?: BillingFetch;
  revenueCatSdk?: RevenueCatSdk;
  platform?: BillingPlatform;
}

export function createBillingAccessDependencies(
  config: BillingAccessConfig,
): BillingAccessDependencies {
  return {
    store: createRevenueCatBillingClient(
      {
        publicSdkKey: config.revenueCatPublicSdkKey,
        canonicalAppUserId: config.canonicalAppUserId,
      },
      config.revenueCatSdk,
      config.platform,
    ),
    backend: createCanonicalAccessClient({
      baseUrl: config.apiBaseUrl,
      get token() {
        return config.apiToken;
      },
      fetchFn: config.fetchFn,
    }),
  };
}
