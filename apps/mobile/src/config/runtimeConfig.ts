import { Platform } from 'react-native';

/**
 * Public, build-time runtime configuration.
 *
 * These values are intentionally checked in and null by default. They are not
 * secrets. A release build must supply the public API origin, the appropriate
 * RevenueCat public SDK key, and its OAuth client IDs before synced accounts
 * or purchases can start. Leaving a value null produces an explicit
 * not-configured state; the app never substitutes a demo server or identity.
 */
export interface RuntimePublicConfig {
  apiBaseUrl: string | null;
  revenueCatPublicSdkKey: string | null;
  googleIosClientId: string | null;
  googleWebClientId: string | null;
  appVersion: string;
}

// Supabase Edge Function implementing /v1/account/bootstrap (supabase/README.md).
const API_BASE_URL: string | null =
  'https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api';
const REVENUECAT_IOS_PUBLIC_SDK_KEY: string | null = null;
const REVENUECAT_ANDROID_PUBLIC_SDK_KEY: string | null = null;
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
  };
}
