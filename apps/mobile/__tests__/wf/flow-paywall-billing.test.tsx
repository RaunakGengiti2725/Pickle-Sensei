/**
 * End-to-end paywall + billing flow, driven the way a user drives it: the
 * real PaywallScreen renders against the real accessStore, the real
 * RevenueCat client (fake native SDK) and the real canonical access API
 * (fake fetch). Every scenario presses rendered controls and asserts the
 * copy, the enabled/disabled state, the accessibility props, and that no
 * branch (cancel, store failure, backend outage, verification pending)
 * dead-ends or spins forever.
 */
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
}));
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});

import React from 'react';
import { ActivityIndicator, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  BillingError,
  createBillingAccessDependencies,
  createRevenueCatBillingClient,
  type BillingFetch,
  type RevenueCatPackageLike,
  type RevenueCatSdk,
} from '../../src/billing';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { PaywallScreen } from '../../src/screens/PaywallScreen';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CANONICAL_USER_ID = '2f1c6c2e-9b7a-4c1e-8f3d-1a2b3c4d5e6f';
const API_BASE_URL = 'https://api.example.test/functions/v1/api';
const PUBLIC_SDK_KEY = 'appl_test_public_key';
const BEARER = 'apple-id-token';

type Entitlement = 'pickle_sensei_pro' | 'premium';

function storePackage(
  period: 'ANNUAL' | 'MONTHLY' | 'LIFETIME',
  options?: { trial?: boolean; packageType?: string },
): RevenueCatPackageLike {
  const identifiers = {
    ANNUAL: { pkg: '$rc_annual', product: 'pickle_sensei_pro_annual' },
    MONTHLY: { pkg: '$rc_monthly', product: 'pickle_sensei_pro_monthly' },
    LIFETIME: { pkg: '$rc_lifetime', product: 'pickle_sensei_pro_lifetime' },
  }[period];
  const pricing = {
    ANNUAL: { price: 59.99, priceString: '$59.99', perMonth: '$5.00' },
    MONTHLY: { price: 7.99, priceString: '$7.99', perMonth: '$7.99' },
    LIFETIME: { price: 159.99, priceString: '$159.99', perMonth: null },
  }[period];
  return {
    identifier: identifiers.pkg,
    packageType: options?.packageType ?? period,
    product: {
      identifier: identifiers.product,
      price: pricing.price,
      priceString: pricing.priceString,
      pricePerMonthString: pricing.perMonth,
      introPrice: options?.trial
        ? { price: 0, cycles: 1, period: 'P7D' }
        : null,
      defaultOption: null,
    },
  };
}

function customerInfo(premium: boolean, entitlement: Entitlement) {
  return {
    entitlements: {
      active: premium
        ? {
            [entitlement]: {
              productIdentifier: 'pickle_sensei_pro_annual',
              expirationDate: null,
            },
          }
        : {},
    },
  };
}

type MockedSdk = {
  [K in keyof RevenueCatSdk]: RevenueCatSdk[K] & jest.Mock;
};

interface FakeSdk {
  sdk: MockedSdk;
  /** Resolves the in-flight purchasePackage call. */
  resolvePurchase: (premium?: boolean) => void;
  rejectPurchase: (error: unknown) => void;
}

function fakeSdk(options?: {
  entitlement?: Entitlement;
  annual?: RevenueCatPackageLike | null;
  monthly?: RevenueCatPackageLike | null;
  lifetime?: RevenueCatPackageLike | null;
  offerings?: 'none';
  deferPurchase?: boolean;
  purchaseError?: unknown;
  restoreError?: unknown;
  restorePremium?: boolean;
  trialEligible?: boolean;
}): FakeSdk {
  const entitlement = options?.entitlement ?? 'pickle_sensei_pro';
  let appUserId = '';
  let settle: {
    resolve: (value: { customerInfo: ReturnType<typeof customerInfo> }) => void;
    reject: (error: unknown) => void;
  } | null = null;
  const sdk: MockedSdk = {
    isConfigured: jest.fn(async () => false),
    configure: jest.fn(async (input: { appUserID: string }) => {
      appUserId = input.appUserID;
    }),
    getAppUserID: jest.fn(async () => appUserId),
    logIn: jest.fn(async (id: string) => {
      appUserId = id;
    }),
    getOfferings: jest.fn(async () => ({
      current:
        options?.offerings === 'none'
          ? null
          : {
              identifier: 'default',
              annual:
                options?.annual !== undefined
                  ? options.annual
                  : storePackage('ANNUAL', { trial: true }),
              monthly:
                options?.monthly !== undefined
                  ? options.monthly
                  : storePackage('MONTHLY'),
              lifetime:
                options?.lifetime !== undefined
                  ? options.lifetime
                  : storePackage('LIFETIME'),
            },
    })),
    purchasePackage: jest.fn(() => {
      if (options?.purchaseError) return Promise.reject(options.purchaseError);
      if (options?.deferPurchase) {
        return new Promise<{ customerInfo: ReturnType<typeof customerInfo> }>(
          (resolve, reject) => {
            settle = { resolve, reject };
          },
        );
      }
      return Promise.resolve({ customerInfo: customerInfo(true, entitlement) });
    }),
    restorePurchases: jest.fn(async () => {
      if (options?.restoreError) throw options.restoreError;
      return customerInfo(options?.restorePremium ?? true, entitlement);
    }),
    getCustomerInfo: jest.fn(async () => customerInfo(false, entitlement)),
    checkTrialOrIntroductoryPriceEligibility: jest.fn(async () => ({
      pickle_sensei_pro_annual: {
        status: options?.trialEligible === false ? 0 : 2,
      },
    })),
  };
  return {
    sdk,
    resolvePurchase: (premium = true) =>
      settle?.resolve({ customerInfo: customerInfo(premium, entitlement) }),
    rejectPurchase: error => settle?.reject(error),
  };
}

function accessPayload(premium: boolean, used = 2) {
  const remaining = 2 - used;
  return {
    premium,
    entitlements: premium ? ['premium', 'pickle_sensei_pro'] : [],
    freeRatings: {
      limit: 2,
      used,
      reserved: 0,
      remaining,
      availableToReserve: remaining,
    },
    canStartRating: premium || remaining > 0,
    paywallRequired: !(premium || remaining > 0),
  };
}

function syncPayload(premium: boolean) {
  return {
    billing: {
      premium,
      productKey: premium ? 'pickle_sensei_pro_annual' : null,
      expiresAt: null,
      verifiedAt: '2026-09-01T00:00:00.000Z',
    },
    access: accessPayload(premium),
  };
}

type Route = { method: string; path: string; body: unknown; status?: number };

interface FakeBackend {
  fetchFn: BillingFetch;
  calls: Array<{ method: string; path: string; authorization: string }>;
  /** Replace the handler for a route on the fly (e.g. after Retry). */
  respond: (
    method: 'GET' | 'POST',
    path: string,
    handler: () => Route | Error,
  ) => void;
}

function fakeBackend(initial?: {
  access?: () => Route | Error;
  sync?: () => Route | Error;
}): FakeBackend {
  const handlers = new Map<string, () => Route | Error>();
  handlers.set(
    'GET /v1/me/access',
    initial?.access ??
      (() => ({
        method: 'GET',
        path: '/v1/me/access',
        body: accessPayload(false),
      })),
  );
  handlers.set(
    'POST /v1/billing/sync',
    initial?.sync ??
      (() => ({
        method: 'POST',
        path: '/v1/billing/sync',
        body: syncPayload(true),
      })),
  );
  const calls: FakeBackend['calls'] = [];
  const fetchFn: BillingFetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const path = input.replace(API_BASE_URL, '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path, authorization: headers.Authorization ?? '' });
    const handler = handlers.get(`${method} ${path}`);
    if (!handler) throw new Error(`unexpected request ${method} ${path}`);
    const route = handler();
    if (route instanceof Error) throw route;
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.body,
    } as unknown as Response;
  };
  return {
    fetchFn,
    calls,
    respond: (method, path, handler) =>
      handlers.set(`${method} ${path}`, handler),
  };
}

function wire(options?: {
  sdk?: FakeSdk;
  backend?: FakeBackend;
  publicSdkKey?: string | null;
}) {
  const sdk = options?.sdk ?? fakeSdk();
  const backend = options?.backend ?? fakeBackend();
  configureAccessStore(
    createBillingAccessDependencies({
      revenueCatPublicSdkKey:
        options && 'publicSdkKey' in options
          ? options.publicSdkKey
          : PUBLIC_SDK_KEY,
      canonicalAppUserId: CANONICAL_USER_ID,
      apiBaseUrl: API_BASE_URL,
      apiToken: BEARER,
      fetchFn: backend.fetchFn,
      revenueCatSdk: sdk.sdk,
      platform: 'ios',
    }),
  );
  return { sdk, backend };
}

// ─── Render helpers ─────────────────────────────────────────────────────────

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

interface Handlers {
  onClose: jest.Mock;
  onPurchased: jest.Mock;
  onOpenTerms: jest.Mock;
  onOpenPrivacy: jest.Mock;
}

async function renderPaywall(options?: { settle?: boolean }) {
  const handlers: Handlers = {
    onClose: jest.fn(),
    onPurchased: jest.fn(),
    onOpenTerms: jest.fn(),
    onOpenPrivacy: jest.fn(),
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<PaywallScreen {...handlers} />);
  });
  if (options?.settle !== false) await flush();
  return { renderer, handlers };
}

async function openPricing(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    pressable(renderer, 'paywall-see-plans').props.onPress();
  });
  await flush();
}

async function press(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  await act(async () => {
    pressable(renderer, testID).props.onPress();
  });
  await flush();
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function pressable(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
}

function byLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labelled ${label}`);
  return node;
}

/** The host view the Pressable renders (what assistive tech actually sees). */
function nativePressable(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === testID,
  );
  if (!node) throw new Error(`No host node with testID ${testID}`);
  return node;
}

function hostNodesLabelled(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  return renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.accessibilityLabel === label,
  );
}

function hasTestId(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(n => n.props.testID === testID).length > 0;
}

function spinnerCount(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType(ActivityIndicator).length;
}

function progressbars(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    n => n.props.accessibilityRole === 'progressbar',
  );
}

function errorCard(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n => n.props.accessibilityLiveRegion === 'assertive',
  );
  return node ?? null;
}

const unmount = (renderer: TestRenderer.ReactTestRenderer) =>
  act(() => renderer.unmount());

beforeEach(() => {
  clearAccessStoreConfiguration();
});

// ─── Static invariants (AGENTS.md billing + App Review 3.1.2) ───────────────

describe('paywall-billing: configuration invariants', () => {
  it('legal links resolve to the public API /terms and /privacy routes', () => {
    const config = getRuntimePublicConfig();
    expect(config.apiBaseUrl).toBeTruthy();
    expect(config.legalTermsUrl).toBe(`${config.apiBaseUrl}/terms`);
    expect(config.legalPrivacyUrl).toBe(`${config.apiBaseUrl}/privacy`);
  });

  it('ships an App Store (appl_) public key on iOS, never a secret key', () => {
    const key = getRuntimePublicConfig().revenueCatPublicSdkKey;
    expect(key).toMatch(/^appl_/);
    expect(key).not.toMatch(/^sk_/i);
  });

  it('shows no store price in the UI copy that is not returned by the store', async () => {
    wire();
    const { renderer } = await renderPaywall();
    expect(allText(renderer)).not.toContain('$');
    await openPricing(renderer);
    const copy = allText(renderer);
    // Only store-returned strings from the fake offering appear.
    for (const price of copy.match(/\$[0-9.]+/g) ?? []) {
      expect(['$7.99', '$59.99', '$159.99', '$5.00']).toContain(price);
    }
    unmount(renderer);
  });
});

describe('paywall-billing: RevenueCat client invariants', () => {
  it('rejects a non-canonical (non-UUID) app user id before touching the SDK', async () => {
    const { sdk } = fakeSdk();
    const client = createRevenueCatBillingClient(
      { publicSdkKey: PUBLIC_SDK_KEY, canonicalAppUserId: 'apple:001234' },
      sdk,
      'ios',
    );
    await expect(client.configure()).rejects.toMatchObject({
      code: 'billing.unconfigured',
      unconfiguredReason: 'invalid_canonical_app_user_id',
    });
    expect(sdk.configure).not.toHaveBeenCalled();
  });

  it('binds RevenueCat to the canonical backend UUID (configure + logIn)', async () => {
    const { sdk } = fakeSdk();
    sdk.isConfigured.mockResolvedValueOnce(true);
    sdk.getAppUserID.mockResolvedValueOnce('$RCAnonymousID:abc');
    const client = createRevenueCatBillingClient(
      { publicSdkKey: PUBLIC_SDK_KEY, canonicalAppUserId: CANONICAL_USER_ID },
      sdk,
      'ios',
    );
    await client.configure();
    expect(sdk.logIn).toHaveBeenCalledWith(CANONICAL_USER_ID);
  });

  it('drops packages whose type is not the standard MONTHLY/ANNUAL/LIFETIME', async () => {
    const { sdk } = fakeSdk({
      annual: storePackage('ANNUAL', { packageType: 'CUSTOM' }),
      lifetime: null,
    });
    const client = createRevenueCatBillingClient(
      { publicSdkKey: PUBLIC_SDK_KEY, canonicalAppUserId: CANONICAL_USER_ID },
      sdk,
      'ios',
    );
    const plans = await client.loadPlans();
    expect(plans.annual).toBeNull();
    expect(plans.lifetime).toBeNull();
    expect(plans.monthly?.priceString).toBe('$7.99');
  });

  it('honors both entitlement ids (pickle_sensei_pro and legacy premium)', async () => {
    for (const entitlement of ['pickle_sensei_pro', 'premium'] as const) {
      const { sdk } = fakeSdk({ entitlement });
      const client = createRevenueCatBillingClient(
        { publicSdkKey: PUBLIC_SDK_KEY, canonicalAppUserId: CANONICAL_USER_ID },
        sdk,
        'ios',
      );
      await expect(client.restore()).resolves.toMatchObject({ premium: true });
    }
  });

  it('maps a user cancellation to billing.purchase_cancelled, other errors to purchase_failed', async () => {
    for (const cancel of [{ code: '1' }, { userCancelled: true }]) {
      const { sdk } = fakeSdk({ purchaseError: cancel });
      const client = createRevenueCatBillingClient(
        { publicSdkKey: PUBLIC_SDK_KEY, canonicalAppUserId: CANONICAL_USER_ID },
        sdk,
        'ios',
      );
      const plans = await client.loadPlans();
      await expect(client.purchase(plans.annual!.id)).rejects.toMatchObject({
        code: 'billing.purchase_cancelled',
        retryable: false,
      });
    }
    const { sdk } = fakeSdk({ purchaseError: { code: '10' } });
    const client = createRevenueCatBillingClient(
      { publicSdkKey: PUBLIC_SDK_KEY, canonicalAppUserId: CANONICAL_USER_ID },
      sdk,
      'ios',
    );
    const plans = await client.loadPlans();
    await expect(client.purchase(plans.annual!.id)).rejects.toMatchObject({
      code: 'billing.purchase_failed',
      retryable: true,
    });
  });

  it('shows a trial only when the store says the user is eligible', async () => {
    const eligible = createRevenueCatBillingClient(
      { publicSdkKey: PUBLIC_SDK_KEY, canonicalAppUserId: CANONICAL_USER_ID },
      fakeSdk().sdk,
      'ios',
    );
    expect((await eligible.loadPlans()).annual?.freeTrial).toEqual({
      label: '7-day free trial',
      periodIso8601: 'P7D',
    });
    const ineligible = createRevenueCatBillingClient(
      { publicSdkKey: PUBLIC_SDK_KEY, canonicalAppUserId: CANONICAL_USER_ID },
      fakeSdk({ trialEligible: false }).sdk,
      'ios',
    );
    expect((await ineligible.loadPlans()).annual?.freeTrial).toBeNull();
  });
});

// ─── Rendered flow ──────────────────────────────────────────────────────────

describe('paywall-billing: value page', () => {
  it('Close is wired and labelled on the value page; step dots announce 1 of 2', async () => {
    wire();
    const { renderer, handlers } = await renderPaywall();
    const close = byLabel(renderer, 'Close membership offer');
    await act(async () => {
      close.props.onPress();
    });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(hostNodesLabelled(renderer, 'Step 1 of 2')).toHaveLength(1);
    expect(
      pressable(renderer, 'paywall-see-plans').props.accessibilityLabel,
    ).toBe('See membership plans');
    unmount(renderer);
  });

  it('states the real free allowance from the server, not a placeholder', async () => {
    wire({
      backend: fakeBackend({
        access: () => ({
          method: 'GET',
          path: '/v1/me/access',
          body: accessPayload(false, 1),
        }),
      }),
    });
    const { renderer } = await renderPaywall();
    expect(allText(renderer)).toContain(
      '1 of your 2 lifetime free ratings remain.',
    );
    unmount(renderer);
  });
});

describe('paywall-billing: pricing page controls', () => {
  it('sends the canonical bearer to the backend and loads store prices', async () => {
    const { backend, sdk } = wire();
    const { renderer } = await renderPaywall();
    await openPricing(renderer);

    expect(backend.calls[0]).toEqual({
      method: 'GET',
      path: '/v1/me/access',
      authorization: `Bearer ${BEARER}`,
    });
    expect(sdk.sdk.configure).toHaveBeenCalledWith({
      apiKey: PUBLIC_SDK_KEY,
      appUserID: CANONICAL_USER_ID,
    });
    const copy = allText(renderer);
    expect(copy).toContain('$7.99');
    expect(copy).toContain('$59.99');
    expect(copy).toContain('$159.99');
    expect(progressbars(renderer)).toHaveLength(0);
    unmount(renderer);
  });

  it('selects monthly / annual / lifetime with selected a11y state and CTA copy', async () => {
    wire();
    const { renderer } = await renderPaywall();
    await openPricing(renderer);

    // Annual is pre-selected with a trial CTA.
    expect(
      pressable(renderer, 'paywall-plan-annual').props.accessibilityState,
    ).toEqual({ selected: true });
    expect(
      pressable(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe('Start free trial');

    await press(renderer, 'paywall-plan-monthly');
    expect(
      pressable(renderer, 'paywall-plan-monthly').props.accessibilityState,
    ).toEqual({ selected: true });
    expect(
      pressable(renderer, 'paywall-plan-annual').props.accessibilityState,
    ).toEqual({ selected: false });
    expect(
      pressable(renderer, 'paywall-plan-monthly').props.accessibilityLabel,
    ).toBe('Monthly membership, $7.99 per month, selected');
    expect(
      pressable(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe('Continue · $7.99/mo');
    expect(allText(renderer)).toContain(
      'Monthly · $7.99 per month, auto-renews. Cancel anytime.',
    );

    await press(renderer, 'paywall-plan-lifetime');
    expect(
      pressable(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe('Continue · $159.99 once');
    expect(allText(renderer)).toContain(
      '$159.99 one-time purchase. Not a subscription — no renewal.',
    );

    await press(renderer, 'paywall-plan-annual');
    expect(
      pressable(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe('Start free trial');
    expect(allText(renderer)).toContain(
      'After the 7-day free trial, $59.99 per year, automatically renewing until canceled.',
    );
    unmount(renderer);
  });

  it('Terms and Privacy are links with wired handlers; Close and Back are labelled', async () => {
    wire();
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);

    const terms = byLabel(renderer, 'Terms of use');
    const privacy = byLabel(renderer, 'Privacy policy');
    expect(terms.props.accessibilityRole).toBe('link');
    expect(privacy.props.accessibilityRole).toBe('link');
    await act(async () => {
      terms.props.onPress();
      privacy.props.onPress();
    });
    expect(handlers.onOpenTerms).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenPrivacy).toHaveBeenCalledTimes(1);

    expect(hostNodesLabelled(renderer, 'Step 2 of 2')).toHaveLength(1);
    expect(pressable(renderer, 'paywall-back').props.accessibilityLabel).toBe(
      'Back to membership benefits',
    );
    await act(async () => {
      byLabel(renderer, 'Close membership offer').props.onPress();
    });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    unmount(renderer);
  });

  it('omits legal links only when no handler is supplied (never a dead link)', async () => {
    wire();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<PaywallScreen onClose={jest.fn()} />);
    });
    await flush();
    await openPricing(renderer);
    expect(
      renderer.root.findAll(n => n.props.accessibilityRole === 'link'),
    ).toHaveLength(0);
    unmount(renderer);
  });
});

describe('paywall-billing: purchase', () => {
  it('purchases the selected monthly package, syncs with the backend, then unlocks', async () => {
    const { sdk, backend } = wire();
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    await press(renderer, 'paywall-plan-monthly');
    await press(renderer, 'paywall-continue');

    expect(sdk.sdk.purchasePackage).toHaveBeenCalledTimes(1);
    expect(sdk.sdk.purchasePackage.mock.calls[0]?.[0]).toMatchObject({
      packageType: 'MONTHLY',
      product: { identifier: 'pickle_sensei_pro_monthly' },
    });
    expect(backend.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/me/access',
      'POST /v1/billing/sync',
    ]);
    expect(handlers.onPurchased).toHaveBeenCalledTimes(1);

    // Entitlement refreshed from the server: premium view, no pricing controls.
    const state = useAccessStore.getState();
    expect(state.canonicalAccess?.premium).toBe(true);
    expect(state.operation).toBe('idle');
    expect(state.error).toBeNull();
    const copy = allText(renderer);
    expect(copy).toContain('MEMBERSHIP VERIFIED');
    expect(hasTestId(renderer, 'paywall-continue')).toBe(false);
    await act(async () => {
      byLabel(renderer, 'Continue coaching').props.onPress();
    });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    unmount(renderer);
  });

  it('never unlocks on store state alone: backend says not premium → pending copy, no callback', async () => {
    const { backend } = wire({
      backend: fakeBackend({
        sync: () => ({
          method: 'POST',
          path: '/v1/billing/sync',
          body: syncPayload(false),
        }),
      }),
    });
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    await press(renderer, 'paywall-continue');

    expect(backend.calls).toHaveLength(2);
    expect(handlers.onPurchased).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(false);
    const card = errorCard(renderer);
    expect(card?.props.accessibilityHint).toBe(
      'The store completed your purchase, but membership verification is still pending. Try Restore purchases.',
    );
    expect(allText(renderer)).toContain(
      'membership verification is still pending',
    );
    // Not a dead end: Restore (the copy's suggested path) and Continue are
    // both enabled again; the server verdict is kept, not erased.
    expect(pressable(renderer, 'paywall-restore').props.disabled).toBe(false);
    expect(pressable(renderer, 'paywall-continue').props.disabled).toBe(false);
    expect(spinnerCount(renderer)).toBe(0);
    unmount(renderer);
  });

  it('backend outage after a completed store purchase → pending copy, Restore path stays open', async () => {
    wire({
      backend: fakeBackend({
        sync: () => new Error('offline'),
      }),
    });
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    await press(renderer, 'paywall-continue');

    expect(handlers.onPurchased).not.toHaveBeenCalled();
    expect(useAccessStore.getState().status).toBe('error');
    expect(useAccessStore.getState().operation).toBe('idle');
    expect(errorCard(renderer)?.props.accessibilityHint).toContain(
      'Try Restore purchases',
    );
    expect(pressable(renderer, 'paywall-restore').props.disabled).toBe(false);
    expect(pressable(renderer, 'paywall-retry').props.disabled).toBe(false);
    expect(spinnerCount(renderer)).toBe(0);
    unmount(renderer);
  });

  it('user cancels the store sheet → silent return, controls re-enabled, no error card', async () => {
    const { backend } = wire({
      sdk: fakeSdk({ purchaseError: { code: '1', userCancelled: true } }),
    });
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    await press(renderer, 'paywall-continue');

    expect(handlers.onPurchased).not.toHaveBeenCalled();
    expect(errorCard(renderer)).toBeNull();
    expect(useAccessStore.getState()).toMatchObject({
      operation: 'idle',
      error: null,
      status: 'ready',
    });
    expect(pressable(renderer, 'paywall-continue').props.disabled).toBe(false);
    expect(pressable(renderer, 'paywall-restore').props.disabled).toBe(false);
    expect(spinnerCount(renderer)).toBe(0);
    // No backend sync attempted for a cancelled purchase.
    expect(backend.calls.map(c => c.path)).toEqual(['/v1/me/access']);
    unmount(renderer);
  });

  it('store failure (e.g. offline) → honest failure copy, dismissible, controls re-enabled', async () => {
    wire({ sdk: fakeSdk({ purchaseError: { code: '10' } }) });
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    await press(renderer, 'paywall-continue');

    expect(handlers.onPurchased).not.toHaveBeenCalled();
    const card = errorCard(renderer);
    expect(card?.props.accessibilityLabel).toBe('Dismiss membership message');
    expect(card?.props.accessibilityHint).toBe(
      'The app store could not complete the purchase. Please try again.',
    );
    expect(pressable(renderer, 'paywall-continue').props.disabled).toBe(false);
    expect(spinnerCount(renderer)).toBe(0);

    await act(async () => {
      card!.props.onPress();
    });
    expect(errorCard(renderer)).toBeNull();
    unmount(renderer);
  });

  it('double-tap protection: a second Continue while purchasing is a no-op', async () => {
    const sdk = fakeSdk({ deferPurchase: true });
    const { backend } = wire({ sdk });
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);

    await act(async () => {
      pressable(renderer, 'paywall-continue').props.onPress();
    });
    await flush();
    // In flight: spinner shown, Continue + Restore + Retry(none) disabled.
    expect(useAccessStore.getState().operation).toBe('purchasing');
    expect(pressable(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(
      nativePressable(renderer, 'paywall-continue').props.accessibilityState,
    ).toEqual({ disabled: true });
    expect(pressable(renderer, 'paywall-restore').props.disabled).toBe(true);
    expect(
      nativePressable(renderer, 'paywall-restore').props.accessibilityState,
    ).toEqual({ disabled: true });
    expect(spinnerCount(renderer)).toBe(1);

    // Even bypassing the disabled prop, the store guard rejects re-entry.
    await act(async () => {
      pressable(renderer, 'paywall-continue').props.onPress();
      pressable(renderer, 'paywall-restore').props.onPress();
    });
    await flush();
    expect(sdk.sdk.purchasePackage).toHaveBeenCalledTimes(1);
    expect(sdk.sdk.restorePurchases).not.toHaveBeenCalled();

    await act(async () => {
      sdk.resolvePurchase();
    });
    await flush();
    expect(
      backend.calls.filter(c => c.path === '/v1/billing/sync'),
    ).toHaveLength(1);
    expect(handlers.onPurchased).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().operation).toBe('idle');
    unmount(renderer);
  });

  it('Continue is disabled (not hidden) when the server has not verified the account', async () => {
    const backend = fakeBackend({
      access: () => new Error('offline'),
    });
    const { sdk } = wire({ backend });
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);

    const continueButton = pressable(renderer, 'paywall-continue');
    expect(continueButton.props.disabled).toBe(true);
    expect(continueButton.props.accessibilityLabel).toBe('Start free trial');
    expect(errorCard(renderer)?.props.accessibilityHint).toBe(
      'Membership verification is temporarily unavailable.',
    );
    expect(progressbars(renderer)).toHaveLength(0);
    // Pressing anyway (bypassing disabled) never reaches the store.
    await press(renderer, 'paywall-continue');
    expect(sdk.sdk.purchasePackage).not.toHaveBeenCalled();
    expect(handlers.onPurchased).not.toHaveBeenCalled();

    // Retry recovers once the backend answers.
    backend.respond('GET', '/v1/me/access', () => ({
      method: 'GET',
      path: '/v1/me/access',
      body: accessPayload(false),
    }));
    await press(renderer, 'paywall-retry');
    expect(pressable(renderer, 'paywall-continue').props.disabled).toBe(false);
    expect(errorCard(renderer)).toBeNull();
    expect(hasTestId(renderer, 'paywall-retry')).toBe(false);
    unmount(renderer);
  });
});

describe('paywall-billing: restore', () => {
  it('Restore verifies with the backend and unlocks only on a premium verdict', async () => {
    const { sdk, backend } = wire();
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    await press(renderer, 'paywall-restore');

    expect(sdk.sdk.restorePurchases).toHaveBeenCalledTimes(1);
    expect(backend.calls.map(c => c.path)).toEqual([
      '/v1/me/access',
      '/v1/billing/sync',
    ]);
    expect(handlers.onPurchased).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('Your full court is open.');
    unmount(renderer);
  });

  it('Restore with nothing to restore → honest copy, no unlock, controls re-enabled', async () => {
    wire({
      sdk: fakeSdk({ restorePremium: false }),
      backend: fakeBackend({
        sync: () => ({
          method: 'POST',
          path: '/v1/billing/sync',
          body: syncPayload(false),
        }),
      }),
    });
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    await press(renderer, 'paywall-restore');

    expect(handlers.onPurchased).not.toHaveBeenCalled();
    expect(errorCard(renderer)?.props.accessibilityHint).toBe(
      'No active Pickle Sensei membership was found for this store account.',
    );
    expect(useAccessStore.getState()).toMatchObject({
      status: 'ready',
      operation: 'idle',
    });
    expect(pressable(renderer, 'paywall-continue').props.disabled).toBe(false);
    expect(pressable(renderer, 'paywall-restore').props.disabled).toBe(false);
    expect(spinnerCount(renderer)).toBe(0);
    unmount(renderer);
  });

  it('Restore store failure → failure copy; Restore backend failure → retryable pending copy', async () => {
    wire({ sdk: fakeSdk({ restoreError: new Error('store down') }) });
    let { renderer } = await renderPaywall();
    await openPricing(renderer);
    await press(renderer, 'paywall-restore');
    expect(errorCard(renderer)?.props.accessibilityHint).toBe(
      'The app store could not restore purchases. Please try again.',
    );
    expect(pressable(renderer, 'paywall-restore').props.disabled).toBe(false);
    unmount(renderer);

    clearAccessStoreConfiguration();
    wire({ backend: fakeBackend({ sync: () => new Error('offline') }) });
    ({ renderer } = await renderPaywall());
    await openPricing(renderer);
    await press(renderer, 'paywall-restore');
    expect(errorCard(renderer)?.props.accessibilityHint).toBe(
      'Restored purchases could not be verified yet. Please try again.',
    );
    expect(pressable(renderer, 'paywall-restore').props.disabled).toBe(false);
    expect(hasTestId(renderer, 'paywall-retry')).toBe(true);
    expect(spinnerCount(renderer)).toBe(0);
    unmount(renderer);
  });
});

describe('paywall-billing: store unavailable / unconfigured / loading', () => {
  it('RevenueCat unconfigured (no public key) → honest no-pricing card, retry, free allowance intact', async () => {
    wire({ publicSdkKey: null });
    const { renderer } = await renderPaywall();
    await openPricing(renderer);

    const state = useAccessStore.getState();
    expect(state.status).toBe('unconfigured');
    expect(state.canonicalAccess).not.toBeNull();
    const copy = allText(renderer);
    expect(copy).toContain('Store pricing is unavailable');
    expect(copy).not.toContain('$');
    expect(errorCard(renderer)?.props.accessibilityHint).toBe(
      'RevenueCat is not configured in this build.',
    );
    expect(pressable(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(
      pressable(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe('Store pricing unavailable');
    expect(hasTestId(renderer, 'paywall-retry')).toBe(true);
    expect(progressbars(renderer)).toHaveLength(0);
    unmount(renderer);
  });

  it('empty current offering → offerings_unavailable copy and retry, never an invented price', async () => {
    wire({ sdk: fakeSdk({ offerings: 'none' }) });
    const { renderer } = await renderPaywall();
    await openPricing(renderer);
    expect(useAccessStore.getState().error).toMatchObject({
      code: 'billing.offerings_unavailable',
      retryable: true,
    });
    expect(allText(renderer)).not.toContain('$');
    expect(hasTestId(renderer, 'paywall-retry')).toBe(true);
    unmount(renderer);
  });

  it('loading pricing shows a labelled progressbar and resolves (no infinite spinner)', async () => {
    let releaseAccess!: () => void;
    const backend = fakeBackend();
    const gate = new Promise<void>(resolve => {
      releaseAccess = resolve;
    });
    const slowFetch: BillingFetch = async (input, init) => {
      if (input.endsWith('/v1/me/access')) await gate;
      return backend.fetchFn(input, init);
    };
    configureAccessStore(
      createBillingAccessDependencies({
        revenueCatPublicSdkKey: PUBLIC_SDK_KEY,
        canonicalAppUserId: CANONICAL_USER_ID,
        apiBaseUrl: API_BASE_URL,
        apiToken: BEARER,
        fetchFn: slowFetch,
        revenueCatSdk: fakeSdk().sdk,
        platform: 'ios',
      }),
    );
    const { renderer } = await renderPaywall({ settle: false });
    await openPricing(renderer);

    expect(useAccessStore.getState().status).toBe('loading');
    const [bar] = progressbars(renderer);
    expect(bar?.props.accessibilityLabel).toBe('Loading App Store pricing');
    expect(pressable(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(hasTestId(renderer, 'paywall-retry')).toBe(false);

    await act(async () => {
      releaseAccess();
    });
    await flush();
    expect(useAccessStore.getState().status).toBe('ready');
    expect(progressbars(renderer)).toHaveLength(0);
    expect(pressable(renderer, 'paywall-continue').props.disabled).toBe(false);
    unmount(renderer);
  });

  it('a stale result from a superseded account never lands after sign-out', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const backend = fakeBackend();
    configureAccessStore(
      createBillingAccessDependencies({
        revenueCatPublicSdkKey: PUBLIC_SDK_KEY,
        canonicalAppUserId: CANONICAL_USER_ID,
        apiBaseUrl: API_BASE_URL,
        apiToken: BEARER,
        fetchFn: async (input, init) => {
          await gate;
          return backend.fetchFn(input, init);
        },
        revenueCatSdk: fakeSdk().sdk,
        platform: 'ios',
      }),
    );
    const pending = useAccessStore.getState().initialize();
    clearAccessStoreConfiguration();
    release();
    await pending;
    expect(useAccessStore.getState()).toMatchObject({
      status: 'idle',
      canonicalAccess: null,
      plans: null,
    });
  });
});

describe('paywall-billing: BillingError surface', () => {
  it('toState carries code, message and retryable for the UI', () => {
    const state = new BillingError(
      'billing.purchase_failed',
      'x',
      true,
    ).toState();
    expect(state).toMatchObject({
      code: 'billing.purchase_failed',
      message: 'x',
      retryable: true,
    });
  });
});
