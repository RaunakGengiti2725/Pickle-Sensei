/**
 * INT-release-config adversary — RevenueCat public key selection per build.
 *
 * Attacked head: 30a4065036a917514fb4984fde73f87867f38619.
 *
 * AGENTS.md "Billing": iOS uses the PRODUCTION App Store public key
 * (`appl_…`); Android uses the Test Store key (`test_…`, simulated). This file
 * attacks the selection in runtimeConfig.ts under each Platform.OS and the
 * billing client's acceptance of a key that belongs to the wrong store for
 * the platform it runs on (a Test Store key in the iOS build would configure
 * simulated purchases in a StoreKit app — free entitlements, no charge).
 *
 *   cd apps/mobile && npx jest --ci __tests__/adv/revenueCatKeySelection.adv.test.ts
 */

import { Platform } from 'react-native';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import {
  createRevenueCatBillingClient,
  type RevenueCatSdk,
} from '../../src/billing/revenueCatClient';

declare const require: (id: string) => unknown;
declare const __dirname: string;
const fs = require('fs') as {
  readFileSync: (p: string, encoding: 'utf8') => string;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
};

const dossier = fs.readFileSync(
  path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'docs',
    'APP_STORE_SUBMISSION.md',
  ),
  'utf8',
);
const dossierIosKey = dossier.match(
  /iOS public SDK key `(appl_[A-Za-z0-9]+)` \(production\)/,
)?.[1];

const CANONICAL_ID = '0f7d5b3a-6c5e-4c4b-9c2a-1e2f3a4b5c6d';

function withPlatform<T>(os: string, body: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  try {
    return body();
  } finally {
    if (descriptor) Object.defineProperty(Platform, 'OS', descriptor);
  }
}

function recordingSdk(): { sdk: RevenueCatSdk; configuredWith: string[] } {
  const configuredWith: string[] = [];
  let configured = false;
  const sdk: RevenueCatSdk = {
    isConfigured: async () => configured,
    configure: ({ apiKey }) => {
      configured = true;
      configuredWith.push(apiKey);
    },
    getAppUserID: async () => CANONICAL_ID,
    logIn: async () => undefined,
    getOfferings: async () => ({ current: null }),
    purchasePackage: async () => {
      throw new Error('not reached');
    },
    restorePurchases: async () => ({ entitlements: { active: {} } }),
    getCustomerInfo: async () => ({ entitlements: { active: {} } }),
    checkTrialOrIntroductoryPriceEligibility: async () => ({}),
  };
  return { sdk, configuredWith };
}

describe('K1 runtimeConfig selects the store key by Platform.OS', () => {
  test('iOS resolves the production App Store key the dossier names', () => {
    expect(dossierIosKey).toBeDefined();
    const key = withPlatform(
      'ios',
      () => getRuntimePublicConfig().revenueCatPublicSdkKey,
    );
    expect(key).toMatch(/^appl_[A-Za-z0-9]{20,}$/);
    expect(key).toBe(dossierIosKey);
  });

  test('Android resolves a Test Store key, never the App Store key', () => {
    const key = withPlatform(
      'android',
      () => getRuntimePublicConfig().revenueCatPublicSdkKey,
    );
    expect(key).toMatch(/^test_[A-Za-z0-9]{20,}$/);
    expect(key).not.toBe(dossierIosKey);
  });

  test('unsupported platforms resolve no key (billing.unconfigured, not a wrong store)', () => {
    for (const os of ['web', 'windows', 'macos', 'harmony']) {
      expect(
        withPlatform(os, () => getRuntimePublicConfig().revenueCatPublicSdkKey),
      ).toBeNull();
    }
  });

  test('the rest of the public config is platform independent', () => {
    const ios = withPlatform('ios', () => getRuntimePublicConfig());
    const android = withPlatform('android', () => getRuntimePublicConfig());
    expect(ios.appVersion).toBe(android.appVersion);
    expect(ios.appStoreId).toBe(android.appStoreId);
    expect(ios.apiBaseUrl).toBe(android.apiBaseUrl);
    expect(ios.legalPrivacyUrl).toBe(android.legalPrivacyUrl);
    expect(ios.legalTermsUrl).toBe(android.legalTermsUrl);
  });
});

describe('K2 the billing client refuses a key that belongs to another store', () => {
  test('a secret key is refused on every platform (control)', async () => {
    for (const platform of ['ios', 'android', 'other'] as const) {
      const { sdk, configuredWith } = recordingSdk();
      const client = createRevenueCatBillingClient(
        {
          publicSdkKey: 'sk_secret_never_in_the_app',
          canonicalAppUserId: CANONICAL_ID,
        },
        sdk,
        platform,
      );
      await expect(client.configure()).rejects.toMatchObject({
        code: 'billing.unconfigured',
      });
      expect(configuredWith).toEqual([]);
    }
  });

  test('the production App Store key configures the iOS build (control)', async () => {
    const { sdk, configuredWith } = recordingSdk();
    const client = createRevenueCatBillingClient(
      { publicSdkKey: dossierIosKey, canonicalAppUserId: CANONICAL_ID },
      sdk,
      'ios',
    );
    await client.configure();
    expect(configuredWith).toEqual([dossierIosKey]);
  });

  test('a Test Store key (`test_…`) on iOS is refused before the SDK is configured', async () => {
    // The Android constant is a Test Store key; if it ever reached the iOS
    // build (copy/paste, wrong ternary branch), StoreKit would be replaced by
    // RevenueCat's simulated store and every "purchase" would be free.
    const { sdk, configuredWith } = recordingSdk();
    const client = createRevenueCatBillingClient(
      {
        publicSdkKey: 'test_KoDgUCMwMgtQnAruBvqBwvmByQk',
        canonicalAppUserId: CANONICAL_ID,
      },
      sdk,
      'ios',
    );
    await expect(client.configure()).rejects.toMatchObject({
      code: 'billing.unconfigured',
    });
    expect(configuredWith).toEqual([]);
  });

  test('a Google Play key (`goog_…`) on iOS is refused before the SDK is configured', async () => {
    const { sdk, configuredWith } = recordingSdk();
    const client = createRevenueCatBillingClient(
      {
        publicSdkKey: 'goog_NotTheAppStoreKeyAtAll0123456',
        canonicalAppUserId: CANONICAL_ID,
      },
      sdk,
      'ios',
    );
    await expect(client.configure()).rejects.toMatchObject({
      code: 'billing.unconfigured',
    });
    expect(configuredWith).toEqual([]);
  });

  test('an App Store key (`appl_…`) on Android is refused before the SDK is configured', async () => {
    const { sdk, configuredWith } = recordingSdk();
    const client = createRevenueCatBillingClient(
      { publicSdkKey: dossierIosKey, canonicalAppUserId: CANONICAL_ID },
      sdk,
      'android',
    );
    await expect(client.configure()).rejects.toMatchObject({
      code: 'billing.unconfigured',
    });
    expect(configuredWith).toEqual([]);
  });
});
