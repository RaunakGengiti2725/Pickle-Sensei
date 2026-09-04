import { Platform } from 'react-native';

/**
 * Public, build-time runtime configuration.
 *
 * These values are intentionally checked in. They are not secrets: the
 * production API origin, App Store id, RevenueCat public SDK keys, and OAuth
 * client IDs are public configuration, and the default build is the shipping
 * build. `pnpm release:check` asserts API_BASE_URL and APP_STORE_ID agree with
 * infra/release/release-manifest.json. Setting a value to null (local-first
 * development) produces an explicit not-configured state; the app never
 * substitutes a demo server or identity.
 */
export interface RuntimePublicConfig {
  apiBaseUrl: string | null;
  revenueCatPublicSdkKey: string | null;
  googleIosClientId: string | null;
  googleWebClientId: string | null;
  appVersion: string;
  /** Public legal pages served by the API function (supabase/functions/api/
   * legal.ts). The paywall (App Review 3.1.2) and the App Store listing point
   * here. Null only when the API origin itself is unconfigured. */
  legalPrivacyUrl: string | null;
  legalTermsUrl: string | null;
  /** Numeric Apple app id (App Store Connect → App Information → Apple ID),
   * e.g. "6743210987". Null until the App Store record exists. */
  appStoreId: string | null;
  /** Deep link straight to the App Store write-review page. Settings' "Rate
   * Pickle Sensei" row prefers it over the OS-throttled in-app sheet; null
   * whenever appStoreId is unset. */
  appStoreWriteReviewUrl: string | null;
}

// Supabase Edge Function implementing /v1/account/bootstrap (supabase/README.md).
const API_BASE_URL: string | null =
  'https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api';
// iOS: the PRODUCTION App Store public SDK key (RevenueCat → Project
// settings → API keys → App Store app). Purchases go through real StoreKit:
// sandbox Apple IDs in dev/TestFlight, real money in App Store builds.
const REVENUECAT_IOS_PUBLIC_SDK_KEY: string | null =
  'appl_twORWAKcOeYuEFbvZGOUjnWDrAl';
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ Android still uses the RevenueCat TEST STORE key (simulated purchases,
// no real money). Android is not shipping yet; swap to the goog_… key from
// RevenueCat → Project settings → API keys before any Play submission.
// ─────────────────────────────────────────────────────────────────────────────
const REVENUECAT_ANDROID_PUBLIC_SDK_KEY: string | null =
  'test_KoDgUCMwMgtQnAruBvqBwvmByQk';
// iOS OAuth client (Google Cloud Console → Credentials → OAuth client → iOS,
// bundle id com.picklesensei). Its REVERSED form must also be the
// CFBundleURLSchemes entry in Info.plist.
const GOOGLE_IOS_CLIENT_ID: string | null =
  '278019487172-ku9j3985cijj4e636t7s7efn8r1vsu8m.apps.googleusercontent.com';
// Web OAuth client — must match the Client ID configured on the Supabase
// Google provider (the ID token audience the backend verifies).
const GOOGLE_WEB_CLIENT_ID: string | null =
  '278019487172-crj0b3oig508i5e5dlqgfno275i9nes1.apps.googleusercontent.com';

/** Keep this aligned with MARKETING_VERSION/versionName for each release. */
const APP_VERSION = '1.0';

// Numeric Apple app id from App Store Connect (App Information → General →
// Apple ID). Settings' "Rate Pickle Sensei" row uses it for the direct
// write-review deep link.
const APP_STORE_ID: string | null = '6806918402';

export function getRuntimePublicConfig(): RuntimePublicConfig {
  const revenueCatPublicSdkKey =
    Platform.OS === 'ios'
      ? REVENUECAT_IOS_PUBLIC_SDK_KEY
      : Platform.OS === 'android'
        ? REVENUECAT_ANDROID_PUBLIC_SDK_KEY
        : null;

  return {
    apiBaseUrl: API_BASE_URL,
    revenueCatPublicSdkKey,
    googleIosClientId: GOOGLE_IOS_CLIENT_ID,
    googleWebClientId: GOOGLE_WEB_CLIENT_ID,
    appVersion: APP_VERSION,
    legalPrivacyUrl: API_BASE_URL ? `${API_BASE_URL}/privacy` : null,
    legalTermsUrl: API_BASE_URL ? `${API_BASE_URL}/terms` : null,
    appStoreId: APP_STORE_ID,
    appStoreWriteReviewUrl: APP_STORE_ID
      ? `https://apps.apple.com/app/id${APP_STORE_ID}?action=write-review`
      : null,
  };
}
