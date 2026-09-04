/**
 * Structural audit #2 — compile-time probe for the one unsafe cast in the
 * billing scope: revenueCatClient.ts:138 does
 * `module.default as unknown as RevenueCatSdk`, so tsc never compares the
 * client's hand-written SDK view against the installed react-native-purchases
 * types. This file does that comparison. It lives OUTSIDE the app tsconfig
 * `include` on purpose (it is expected to FAIL on the audited baseline) and
 * is checked with:
 *
 *   cd apps/mobile && npx tsc --noEmit -p audit-probes/billing-structural2/tsconfig.json
 *
 * exit 0  → the client's RevenueCatSdk view matches the installed SDK types
 * exit 2  → a field the client reads has a different shape in the real SDK
 */
import type Purchases from 'react-native-purchases';
import type { RevenueCatSdk } from '../../src/billing/revenueCatClient';

declare const nativeSdk: typeof Purchases;

export function nativeSdkAsClientView(): RevenueCatSdk {
  const clientView: RevenueCatSdk = nativeSdk;
  return clientView;
}

type Offerings = Awaited<ReturnType<typeof Purchases.getOfferings>>;
type Pkg = NonNullable<NonNullable<Offerings['current']>['annual']>;
type Product = Pkg['product'];

export const productFieldsRead: Array<keyof Product> = [
  'identifier',
  'price',
  'priceString',
  'pricePerMonthString',
  'introPrice',
  'defaultOption',
];

type CustomerInfo = Awaited<ReturnType<typeof Purchases.getCustomerInfo>>;
export const entitlementFieldsRead: Array<keyof CustomerInfo['entitlements']> =
  ['active'];
