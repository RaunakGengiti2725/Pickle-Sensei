/**
 * Adversarial pass 3 — subsystem `mobile-billing-paywall` (cloud plane).
 *
 * Every scenario drives the REAL PaywallScreen against the REAL accessStore,
 * the REAL RevenueCat client (fake native SDK) and the REAL canonical access
 * API (fake fetch), then asserts rendered copy, accessibility state, store /
 * backend call counts and the access-store state. Nothing here touches
 * production code; the attacks are hostile inputs and hostile timings only.
 *
 * Seeded randomness: the price / period fuzzers use the LCG below with
 * seed `ATTACK_SEED` so a failing case is reproducible from the log line.
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
// Keep the real module behaviour; only count calls into it.
jest.mock('../../src/account/apiSession', () => {
  const actual = jest.requireActual('../../src/account/apiSession');
  return {
    ...actual,
    reportApiUnauthorized: jest.fn(actual.reportApiUnauthorized),
  };
});

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  createBillingAccessDependencies,
  createRevenueCatBillingClient,
  type BillingFetch,
  type RevenueCatCustomerInfoLike,
  type RevenueCatPackageLike,
  type RevenueCatSdk,
} from '../../src/billing';
import {
  clearApiSession,
  establishApiSession,
  reportApiUnauthorized,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectCanStartRating,
  selectPaywallRequired,
  useAccessStore,
} from '../../src/state/accessStore';
import { PaywallScreen } from '../../src/screens/PaywallScreen';
import { BrandSpinner } from '../../src/design/components';

// ─── Seeded randomness ──────────────────────────────────────────────────────

const ATTACK_SEED = 0x5eed0003;

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CANONICAL_USER_ID = '2f1c6c2e-9b7a-4c1e-8f3d-1a2b3c4d5e6f';
const API_BASE_URL = 'https://api.example.test/functions/v1/api';
const PUBLIC_SDK_KEY = 'appl_test_public_key';
const BEARER = 'attack-bearer-token';

const NULL_ACCESS_COPY =
  'Two successful validated ratings are included once your account is verified.';
const VERIFY_FIRST_COPY =
  'Verify this account with the server before starting a purchase.';
const SIGN_IN_EXPIRED_COPY =
  'Your sign-in has expired. Sign in again to check membership access.';
const PURCHASE_PENDING_COPY =
  'The store completed your purchase, but membership verification is still pending. Try Restore purchases.';
const RESTORE_PENDING_COPY =
  'Restored purchases could not be verified yet. Please try again.';
const PURCHASE_FAILED_COPY =
  'The app store could not complete the purchase. Please try again.';

type PackagePeriod = 'ANNUAL' | 'MONTHLY' | 'LIFETIME';

function storePackage(
  period: PackagePeriod,
  options?: {
    price?: number;
    priceString?: string;
    perMonth?: string | null;
    intro?: { price: number; cycles: number; period: string } | null;
  },
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
    packageType: period,
    product: {
      identifier: identifiers.product,
      price: options?.price ?? pricing.price,
      priceString: options?.priceString ?? pricing.priceString,
      pricePerMonthString:
        options && 'perMonth' in options
          ? (options.perMonth ?? null)
          : pricing.perMonth,
      introPrice: options?.intro ?? null,
      defaultOption: null,
    },
  };
}

function premiumCustomerInfo(): RevenueCatCustomerInfoLike {
  return {
    entitlements: {
      active: {
        pickle_sensei_pro: {
          productIdentifier: 'pickle_sensei_pro_annual',
          expirationDate: null,
        },
      },
    },
  };
}

type MockedSdk = {
  [K in keyof RevenueCatSdk]: RevenueCatSdk[K] & jest.Mock;
};

interface FakeSdk {
  sdk: MockedSdk;
  resolvePurchase: (customerInfo?: unknown) => void;
  rejectPurchase: (error: unknown) => void;
  pendingPurchases: () => number;
}

function fakeSdk(options?: {
  annual?: RevenueCatPackageLike | null;
  monthly?: RevenueCatPackageLike | null;
  lifetime?: RevenueCatPackageLike | null;
  deferPurchase?: boolean;
  /** Raw value handed back as `{ customerInfo }` from purchasePackage. */
  purchaseCustomerInfo?: unknown;
  restoreCustomerInfo?: unknown;
  eligibilityStatus?: number;
}): FakeSdk {
  let appUserId = '';
  const settlers: Array<{
    resolve: (value: { customerInfo: RevenueCatCustomerInfoLike }) => void;
    reject: (error: unknown) => void;
  }> = [];
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
      current: {
        identifier: 'default',
        annual:
          options?.annual !== undefined
            ? options.annual
            : storePackage('ANNUAL', {
                intro: { price: 0, cycles: 1, period: 'P7D' },
              }),
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
      if (options?.deferPurchase) {
        return new Promise<{ customerInfo: RevenueCatCustomerInfoLike }>(
          (resolve, reject) => {
            settlers.push({ resolve, reject });
          },
        );
      }
      return Promise.resolve({
        customerInfo: (options && 'purchaseCustomerInfo' in options
          ? options.purchaseCustomerInfo
          : premiumCustomerInfo()) as RevenueCatCustomerInfoLike,
      });
    }),
    restorePurchases: jest.fn(
      async () =>
        (options && 'restoreCustomerInfo' in options
          ? options.restoreCustomerInfo
          : premiumCustomerInfo()) as RevenueCatCustomerInfoLike,
    ),
    getCustomerInfo: jest.fn(async () => ({ entitlements: { active: {} } })),
    checkTrialOrIntroductoryPriceEligibility: jest.fn(async () => ({
      pickle_sensei_pro_annual: { status: options?.eligibilityStatus ?? 2 },
      pickle_sensei_pro_monthly: { status: options?.eligibilityStatus ?? 2 },
    })),
  };
  return {
    sdk,
    resolvePurchase: (customerInfo = premiumCustomerInfo()) => {
      const settle = settlers.shift();
      settle?.resolve({
        customerInfo: customerInfo as RevenueCatCustomerInfoLike,
      });
    },
    rejectPurchase: error => settlers.shift()?.reject(error),
    pendingPurchases: () => settlers.length,
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

interface Route {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Hold the response until `release()` is called. */
  defer?: boolean;
}

interface FakeBackend {
  fetchFn: BillingFetch;
  calls: Array<{ method: string; path: string; authorization: string }>;
  count: (method: 'GET' | 'POST', path: string) => number;
  respond: (
    method: 'GET' | 'POST',
    path: string,
    handler: () => Route | Error,
  ) => void;
  /** Resolves every held response for a route. */
  release: (method: 'GET' | 'POST', path: string) => void;
}

function fakeBackend(initial?: {
  access?: () => Route | Error;
  sync?: () => Route | Error;
}): FakeBackend {
  const handlers = new Map<string, () => Route | Error>();
  handlers.set(
    'GET /v1/me/access',
    initial?.access ?? (() => ({ body: accessPayload(false, 1) })),
  );
  handlers.set(
    'POST /v1/billing/sync',
    initial?.sync ?? (() => ({ body: syncPayload(true) })),
  );
  const held = new Map<string, Array<() => void>>();
  const calls: FakeBackend['calls'] = [];
  const toResponse = (route: Route): Response => {
    const status = route.status ?? 200;
    const headerMap = new Map(
      Object.entries(route.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
      },
      json: async () => {
        if (route.body === undefined) throw new SyntaxError('no body');
        return route.body;
      },
    } as unknown as Response;
  };
  const fetchFn: BillingFetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const path = input.replace(API_BASE_URL, '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path, authorization: headers.Authorization ?? '' });
    const key = `${method} ${path}`;
    const handler = handlers.get(key);
    if (!handler) throw new Error(`unexpected request ${key}`);
    const route = handler();
    if (route instanceof Error) throw route;
    if (route.defer) {
      await new Promise<void>(resolve => {
        const list = held.get(key) ?? [];
        list.push(resolve);
        held.set(key, list);
      });
    }
    return toResponse(route);
  };
  return {
    fetchFn,
    calls,
    count: (method, path) =>
      calls.filter(c => c.method === method && c.path === path).length,
    respond: (method, path, handler) =>
      handlers.set(`${method} ${path}`, handler),
    release: (method, path) => {
      const key = `${method} ${path}`;
      for (const resolve of held.get(key) ?? []) resolve();
      held.set(key, []);
    },
  };
}

function wire(options?: {
  sdk?: FakeSdk;
  backend?: FakeBackend;
  token?: () => string | null;
}) {
  const sdk = options?.sdk ?? fakeSdk();
  const backend = options?.backend ?? fakeBackend();
  const token = options?.token ?? (() => BEARER);
  configureAccessStore(
    createBillingAccessDependencies({
      revenueCatPublicSdkKey: PUBLIC_SDK_KEY,
      canonicalAppUserId: CANONICAL_USER_ID,
      apiBaseUrl: API_BASE_URL,
      get apiToken() {
        return token();
      },
      fetchFn: backend.fetchFn,
      revenueCatSdk: sdk.sdk,
      platform: 'ios',
    }),
  );
  return { sdk, backend };
}

// ─── Render helpers ─────────────────────────────────────────────────────────

async function flush(rounds = 1) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    });
  }
}

interface Handlers {
  onClose: jest.Mock;
  onPurchased: jest.Mock;
  onOpenTerms: jest.Mock;
  onOpenPrivacy: jest.Mock;
}

async function renderPaywall() {
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
  await flush(2);
  return { renderer, handlers };
}

async function openPricing(renderer: TestRenderer.ReactTestRenderer) {
  await press(renderer, 'paywall-see-plans');
}

/** Presses the JS handler regardless of `disabled` — the hostile path. */
async function press(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  await act(async () => {
    pressable(renderer, testID).props.onPress();
  });
  await flush();
}

/** Presses only if the host view is enabled (what a real finger can do). */
async function pressIfEnabled(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
): Promise<boolean> {
  const host = nativePressable(renderer, testID);
  if (host.props.accessibilityState?.disabled === true) return false;
  await press(renderer, testID);
  return true;
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

function podiumColumns(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(
      n =>
        typeof n.type === 'string' &&
        typeof n.props.testID === 'string' &&
        n.props.testID.startsWith('paywall-plan-'),
    )
    .map(n => n.props.testID.replace('paywall-plan-', ''));
}

function continueHost(renderer: TestRenderer.ReactTestRenderer) {
  return nativePressable(renderer, 'paywall-continue');
}

function errorCard(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n => n.props.accessibilityLiveRegion === 'assertive',
  );
  return node ?? null;
}

function spinnerCount(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType(BrandSpinner).length;
}

const unmount = (renderer: TestRenderer.ReactTestRenderer) =>
  act(() => renderer.unmount());

const unauthorizedSpy = reportApiUnauthorized as unknown as jest.Mock;

function apiSession(bearerToken = BEARER): ApiSession {
  return {
    apiBaseUrl: API_BASE_URL,
    bearerToken,
    canonicalAppUserId: CANONICAL_USER_ID,
    provider: 'apple',
    refreshToken: 'refresh-token',
    bearerExpiresAtMs: Date.now() + 60_000,
  };
}

beforeEach(() => {
  clearAccessStoreConfiguration();
  clearApiSession();
  setApiUnauthorizedListener(null);
  unauthorizedSpy.mockClear();
});

// ─── S1: three plans, canonicalAccess === null ──────────────────────────────

describe('S1: three plans with canonicalAccess === null', () => {
  it('lets every podium column select its period while Continue stays disabled behind the verify-first copy', async () => {
    const backend = fakeBackend({
      access: () => new Error('network unreachable'),
    });
    const { sdk } = wire({ backend });
    const { renderer, handlers } = await renderPaywall();
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(useAccessStore.getState().plans).not.toBeNull();
    await openPricing(renderer);

    expect(podiumColumns(renderer).sort()).toEqual([
      'annual',
      'lifetime',
      'monthly',
    ]);
    expect(allText(renderer)).toContain(NULL_ACCESS_COPY);

    // Each press flips selection in the store AND on the host a11y state; the
    // Continue button never enables. Order chosen to cross every transition.
    const order = [
      'monthly',
      'lifetime',
      'annual',
      'monthly',
      'annual',
    ] as const;
    const labels: string[] = [];
    for (const period of order) {
      await press(renderer, `paywall-plan-${period}`);
      expect(useAccessStore.getState().selectedPeriod).toBe(period);
      for (const column of ['monthly', 'annual', 'lifetime'] as const) {
        expect(
          nativePressable(renderer, `paywall-plan-${column}`).props
            .accessibilityState?.selected,
        ).toBe(column === period);
      }
      const host = continueHost(renderer);
      expect(host.props.accessibilityState?.disabled).toBe(true);
      labels.push(host.props.accessibilityLabel);
    }
    expect(labels).toEqual([
      'Continue · $7.99/mo',
      'Continue · $159.99 once',
      'Start free trial',
      'Continue · $7.99/mo',
      'Start free trial',
    ]);

    // A real finger cannot press a disabled Continue.
    expect(await pressIfEnabled(renderer, 'paywall-continue')).toBe(false);
    expect(sdk.sdk.purchasePackage).not.toHaveBeenCalled();

    // Even the hostile bypass (assistive tech firing onPress) is fail-closed:
    // the store refuses with the verify-first copy and never reaches StoreKit.
    await press(renderer, 'paywall-continue');
    expect(sdk.sdk.purchasePackage).not.toHaveBeenCalled();
    expect(backend.count('POST', '/v1/billing/sync')).toBe(0);
    expect(useAccessStore.getState().error?.message).toBe(VERIFY_FIRST_COPY);
    expect(useAccessStore.getState().error?.retryable).toBe(true);
    expect(errorCard(renderer)?.props.accessibilityHint).toBe(
      VERIFY_FIRST_COPY,
    );
    expect(continueHost(renderer).props.accessibilityState?.disabled).toBe(
      true,
    );
    expect(handlers.onPurchased).not.toHaveBeenCalled();

    // The escape hatch is visible and one tap = one access request.
    const accessBefore = backend.count('GET', '/v1/me/access');
    backend.respond('GET', '/v1/me/access', () => ({
      body: accessPayload(false, 1),
    }));
    await press(renderer, 'paywall-retry');
    expect(backend.count('GET', '/v1/me/access')).toBe(accessBefore + 1);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(false);
    expect(continueHost(renderer).props.accessibilityState?.disabled).toBe(
      false,
    );
    await unmount(renderer);
  });

  it('rapid Try-again taps while the access request hangs issue exactly one request', async () => {
    const backend = fakeBackend({
      access: () => new Error('network unreachable'),
    });
    wire({ backend });
    const { renderer } = await renderPaywall();
    await openPricing(renderer);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();

    backend.respond('GET', '/v1/me/access', () => ({
      body: accessPayload(false, 1),
      defer: true,
    }));
    const before = backend.count('GET', '/v1/me/access');
    await act(async () => {
      for (let i = 0; i < 7; i += 1) {
        pressable(renderer, 'paywall-retry').props.onPress();
      }
    });
    await flush();
    expect(backend.count('GET', '/v1/me/access')).toBe(before + 1);
    backend.release('GET', '/v1/me/access');
    await flush(2);
    expect(useAccessStore.getState().status).toBe('ready');
    expect(
      useAccessStore.getState().canonicalAccess?.freeRatings.remaining,
    ).toBe(1);
    await unmount(renderer);
  });
});

// ─── S2: 401 from /v1/me/access while a purchase is in flight ───────────────

describe('S2: HTTP 401 on /v1/me/access during an in-flight purchase', () => {
  it('reports the rejected bearer exactly once and still honours the purchase sync that lands afterwards', async () => {
    const backend = fakeBackend();
    const sdk = fakeSdk({ deferPurchase: true });
    wire({ sdk, backend });
    const listener = jest.fn();
    establishApiSession(apiSession());
    setApiUnauthorizedListener(listener);

    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    expect(continueHost(renderer).props.accessibilityState?.disabled).toBe(
      false,
    );
    await press(renderer, 'paywall-continue');
    expect(sdk.sdk.purchasePackage).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().operation).toBe('purchasing');

    // Something else (Settings focus) refreshes access mid-purchase and the
    // server now says 401.
    backend.respond('GET', '/v1/me/access', () => ({
      status: 401,
      body: { error: 'unauthorized' },
    }));
    let refreshed: boolean | null = null;
    await act(async () => {
      refreshed = await useAccessStore.getState().refreshAccess();
    });
    await flush();
    expect(refreshed).toBe(false);
    expect(unauthorizedSpy).toHaveBeenCalledTimes(1);
    expect(unauthorizedSpy).toHaveBeenCalledWith(BEARER);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().error?.message).toBe(SIGN_IN_EXPIRED_COPY);
    expect(useAccessStore.getState().error?.retryable).toBe(false);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    // The purchase is still owned by the store: nothing was dropped or reset.
    expect(useAccessStore.getState().operation).toBe('purchasing');
    expect(spinnerCount(renderer)).toBeGreaterThan(0);

    // StoreKit completes; the sync (with a rotated bearer) lands premium.
    await act(async () => {
      sdk.resolvePurchase();
    });
    await flush(2);
    expect(backend.count('POST', '/v1/billing/sync')).toBe(1);
    expect(useAccessStore.getState().operation).toBe('idle');
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    expect(useAccessStore.getState().error).toBeNull();
    expect(handlers.onPurchased).toHaveBeenCalledTimes(1);
    // No second unauthorized report leaked out of the purchase path.
    expect(unauthorizedSpy).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });

  it('when the purchase sync itself is 401 the report fires once per rejected request and the purchase is dropped without onPurchased', async () => {
    const backend = fakeBackend();
    const sdk = fakeSdk({ deferPurchase: true });
    wire({ sdk, backend });
    const listener = jest.fn();
    establishApiSession(apiSession());
    setApiUnauthorizedListener(listener);

    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    await press(renderer, 'paywall-continue');
    backend.respond('GET', '/v1/me/access', () => ({ status: 401 }));
    backend.respond('POST', '/v1/billing/sync', () => ({ status: 401 }));
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    await act(async () => {
      sdk.resolvePurchase();
    });
    await flush(2);

    expect(unauthorizedSpy).toHaveBeenCalledTimes(2);
    expect(unauthorizedSpy.mock.calls).toEqual([[BEARER], [BEARER]]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(handlers.onPurchased).not.toHaveBeenCalled();
    const state = useAccessStore.getState();
    expect(state.operation).toBe('idle');
    expect(state.canonicalAccess).toBeNull();
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    // OBSERVATION (not an assertion failure): the purchase path discards the
    // 401 cause and shows the generic "Try Restore purchases" copy rather than
    // the sign-in-expired copy the refresh path shows for the same 401.
    expect(state.error?.message).toBe(PURCHASE_PENDING_COPY);
    expect(state.error?.message).not.toBe(SIGN_IN_EXPIRED_COPY);
    await unmount(renderer);
  });

  it('a 401 for a bearer that has already rotated is NOT reported to the listener', async () => {
    const backend = fakeBackend({
      access: () => ({ status: 401 }),
    });
    let token = BEARER;
    wire({ backend, token: () => token });
    const listener = jest.fn();
    establishApiSession(apiSession('rotated-bearer'));
    setApiUnauthorizedListener(listener);
    token = BEARER; // the client still sends the stale bearer
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    expect(unauthorizedSpy).toHaveBeenCalledTimes(1);
    expect(unauthorizedSpy).toHaveBeenCalledWith(BEARER);
    expect(listener).not.toHaveBeenCalled();
  });

  it('signing out (dependencies cleared) while StoreKit is open drops the purchase result and never syncs', async () => {
    const backend = fakeBackend();
    const sdk = fakeSdk({ deferPurchase: true });
    wire({ sdk, backend });
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    await press(renderer, 'paywall-continue');
    expect(useAccessStore.getState().operation).toBe('purchasing');

    await act(async () => {
      clearAccessStoreConfiguration();
    });
    await act(async () => {
      sdk.resolvePurchase();
    });
    await flush(2);
    expect(backend.count('POST', '/v1/billing/sync')).toBe(0);
    expect(handlers.onPurchased).not.toHaveBeenCalled();
    const state = useAccessStore.getState();
    expect(state.operation).toBe('idle');
    expect(state.canonicalAccess).toBeNull();
    // The mounted screen re-initialises against no dependencies: honest
    // "not connected" state, no premium, no purchase leakage.
    expect(state.status).toBe('unconfigured');
    expect(state.error?.code).toBe('billing.unconfigured');
    expect(state.plans).toBeNull();
    await unmount(renderer);
  });

  it('a stale purchase sync that resolves after re-configuration cannot unlock the new account', async () => {
    const backendA = fakeBackend({
      sync: () => ({ body: syncPayload(true), defer: true }),
    });
    const sdkA = fakeSdk();
    wire({ sdk: sdkA, backend: backendA });
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    await press(renderer, 'paywall-continue');
    expect(backendA.count('POST', '/v1/billing/sync')).toBe(1);
    expect(useAccessStore.getState().operation).toBe('purchasing');

    // Account switch: new dependencies, fresh state.
    const backendB = fakeBackend();
    await act(async () => {
      clearAccessStoreConfiguration();
      wire({ sdk: fakeSdk(), backend: backendB });
      await useAccessStore.getState().initialize();
    });
    await flush();
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(false);

    await act(async () => {
      backendA.release('POST', '/v1/billing/sync');
    });
    await flush(2);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(false);
    expect(handlers.onPurchased).not.toHaveBeenCalled();
    await unmount(renderer);
  });
});

// ─── S3: 429 + Retry-After on /v1/billing/sync after a store purchase ───────

describe('S3: HTTP 429 Retry-After: 30 on /v1/billing/sync after purchase', () => {
  it('surfaces retryable backend_verification_pending, never calls onPurchased, and repeated taps do not storm the backend', async () => {
    const backend = fakeBackend({
      sync: () => ({
        status: 429,
        headers: { 'Retry-After': '30' },
        body: { error: 'rate_limited' },
      }),
    });
    const sdk = fakeSdk();
    wire({ sdk, backend });
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    expect(
      useAccessStore.getState().canonicalAccess?.freeRatings.remaining,
    ).toBe(1);

    await press(renderer, 'paywall-continue');
    expect(sdk.sdk.purchasePackage).toHaveBeenCalledTimes(1);
    expect(backend.count('POST', '/v1/billing/sync')).toBe(1);
    const state = useAccessStore.getState();
    expect(state.operation).toBe('idle');
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    expect(state.error?.retryable).toBe(true);
    expect(state.error?.message).toBe(PURCHASE_PENDING_COPY);
    expect(handlers.onPurchased).not.toHaveBeenCalled();
    expect(errorCard(renderer)?.props.accessibilityHint).toBe(
      PURCHASE_PENDING_COPY,
    );
    expect(spinnerCount(renderer)).toBe(0);

    // OBSERVATION: the 429 erased the verified free allowance the user had
    // BEFORE tapping Continue (canonicalAccess → null → fail closed).
    expect(state.canonicalAccess).toBeNull();
    expect(selectCanStartRating(state)).toBe(false);
    expect(selectPaywallRequired(state)).toBe(true);
    expect(continueHost(renderer).props.accessibilityState?.disabled).toBe(
      true,
    );

    // Rapid repeated taps on Continue: a real finger is blocked (disabled),
    // and the bypass never re-enters StoreKit nor hits the backend again.
    for (let i = 0; i < 5; i += 1) {
      expect(await pressIfEnabled(renderer, 'paywall-continue')).toBe(false);
    }
    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        pressable(renderer, 'paywall-continue').props.onPress();
      }
    });
    await flush();
    expect(sdk.sdk.purchasePackage).toHaveBeenCalledTimes(1);
    expect(backend.count('POST', '/v1/billing/sync')).toBe(1);

    // The copy points at Restore: N taps = exactly N restore + N sync calls,
    // no background retries, no exponential storm.
    const taps = 4;
    for (let i = 0; i < taps; i += 1) {
      expect(await pressIfEnabled(renderer, 'paywall-restore')).toBe(true);
    }
    expect(sdk.sdk.restorePurchases).toHaveBeenCalledTimes(taps);
    expect(backend.count('POST', '/v1/billing/sync')).toBe(1 + taps);
    expect(useAccessStore.getState().error?.message).toBe(RESTORE_PENDING_COPY);
    await flush(5);
    expect(backend.count('POST', '/v1/billing/sync')).toBe(1 + taps);
    expect(handlers.onPurchased).not.toHaveBeenCalled();

    // Recovery once the limiter lifts: one Restore unlocks.
    backend.respond('POST', '/v1/billing/sync', () => ({
      body: syncPayload(true),
    }));
    await press(renderer, 'paywall-restore');
    expect(handlers.onPurchased).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    await unmount(renderer);
  });

  it('five synchronous Continue taps while a sync is held produce one purchase and one sync', async () => {
    const backend = fakeBackend({
      sync: () => ({
        status: 429,
        headers: { 'Retry-After': '30' },
        defer: true,
      }),
    });
    const sdk = fakeSdk();
    wire({ sdk, backend });
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        pressable(renderer, 'paywall-continue').props.onPress();
      }
    });
    await flush();
    expect(sdk.sdk.purchasePackage).toHaveBeenCalledTimes(1);
    expect(backend.count('POST', '/v1/billing/sync')).toBe(1);
    expect(continueHost(renderer).props.accessibilityState?.disabled).toBe(
      true,
    );
    await act(async () => {
      backend.release('POST', '/v1/billing/sync');
    });
    await flush(2);
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.backend_verification_pending',
    );
    expect(handlers.onPurchased).not.toHaveBeenCalled();
    await unmount(renderer);
  });
});

// ─── S4: hostile introPrice.period strings ──────────────────────────────────

describe('S4: hostile trial periods with eligibility 2', () => {
  it("'P1M2W' (compound ISO duration) falls back to explicit standard pricing — no trial claim, no 'Start free trial'", async () => {
    const sdk = fakeSdk({
      annual: storePackage('ANNUAL', {
        intro: { price: 0, cycles: 1, period: 'P1M2W' },
      }),
    });
    wire({ sdk });
    const { renderer } = await renderPaywall();
    await openPricing(renderer);
    const plans = useAccessStore.getState().plans;
    expect(plans?.annual?.freeTrial).toBeNull();
    const host = continueHost(renderer);
    expect(host.props.accessibilityLabel).toBe('Continue · $59.99/yr');
    expect(host.props.accessibilityState?.disabled).toBe(false);
    const copy = allText(renderer);
    expect(copy).not.toMatch(/free trial/i);
    expect(copy).toContain(
      '$59.99 per year, automatically renewing until canceled.',
    );
    expect(copy).not.toMatch(/NaN|undefined|null/);
    await unmount(renderer);
  });

  it("lowercase 'p7d' is normalised and the CTA reads 'Start free trial' with a 7-day label", async () => {
    const sdk = fakeSdk({
      annual: storePackage('ANNUAL', {
        intro: { price: 0, cycles: 1, period: 'p7d' },
      }),
    });
    wire({ sdk });
    const { renderer } = await renderPaywall();
    await openPricing(renderer);
    const plans = useAccessStore.getState().plans;
    expect(plans?.annual?.freeTrial).toEqual({
      periodIso8601: 'P7D',
      label: '7-day free trial',
    });
    expect(continueHost(renderer).props.accessibilityLabel).toBe(
      'Start free trial',
    );
    expect(allText(renderer)).toContain(
      'After the 7-day free trial, $59.99 per year, automatically renewing until canceled.',
    );
    await unmount(renderer);
  });

  it('every hostile period either yields a well-formed trial label or an explicit no-trial fallback (fuzz, seeded)', async () => {
    const random = lcg(ATTACK_SEED);
    const alphabet = 'PpTt0123456789DWMYdwmy -+.\u0661\u0662\u200b\n';
    const fuzzed = Array.from({ length: 40 }, () =>
      Array.from(
        { length: 1 + Math.floor(random() * 6) },
        () => alphabet[Math.floor(random() * alphabet.length)],
      ).join(''),
    );
    const hostile = [
      'P1M2W',
      'p7d',
      'PT7D',
      'P-7D',
      'P7',
      '7D',
      'P07D',
      'P0D',
      'P1Y',
      ' P7D',
      'P7D\n',
      'P99999999999999999999D',
      'P١٤D',
      'P7D\u200b',
      '',
      ...fuzzed,
    ];
    const cyclesCases = [1, 0, -1, 1.5, 3, Number.MAX_SAFE_INTEGER, NaN];
    const seen: string[] = [];
    for (const period of hostile) {
      for (const cycles of cyclesCases) {
        const sdk = fakeSdk({
          annual: storePackage('ANNUAL', {
            intro: { price: 0, cycles, period },
          }),
        });
        const store = createRevenueCatBillingClient(
          {
            publicSdkKey: PUBLIC_SDK_KEY,
            canonicalAppUserId: CANONICAL_USER_ID,
          },
          sdk.sdk,
          'ios',
        );
        const plans = await store.loadPlans();
        const trial = plans.annual?.freeTrial ?? null;
        const tag = `${JSON.stringify(period)} x${cycles}`;
        if (trial) {
          expect([tag, trial.label]).toEqual([
            tag,
            expect.stringMatching(
              /^[1-9]\d*-(day|week|month|year) free trial$/,
            ),
          ]);
          expect([tag, trial.periodIso8601]).toEqual([
            tag,
            expect.stringMatching(/^P[1-9]\d*[DWMY]$/),
          ]);
          seen.push(`${tag} => ${trial.label}`);
        } else {
          seen.push(`${tag} => (no trial)`);
        }
      }
    }
    // Sanity on the fixed cases (documents the actual fallback table).
    expect(seen).toContain('"P1M2W" x1 => (no trial)');
    expect(seen).toContain('"p7d" x1 => 7-day free trial');
    expect(seen).toContain('"P07D" x1 => 7-day free trial');
    expect(seen).toContain('"P0D" x1 => (no trial)');
    expect(seen).toContain('"P1Y" x3 => 3-year free trial');
    expect(seen).toContain('"P99999999999999999999D" x1 => (no trial)');
    expect(seen).toContain('"P7D\\n" x1 => (no trial)');
    expect(seen).toContain('"p7d" x0 => (no trial)');
    expect(seen).toContain('"p7d" x1.5 => (no trial)');
    expect(seen).toContain('"p7d" xNaN => (no trial)');
    expect(seen).toContain('"P١٤D" x1 => (no trial)');
  });

  it('cycles multiply the period: P1W × 3 cycles is a 3-week free trial', async () => {
    const sdk = fakeSdk({
      annual: storePackage('ANNUAL', {
        intro: { price: 0, cycles: 3, period: 'P1W' },
      }),
    });
    wire({ sdk });
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    expect(useAccessStore.getState().plans?.annual?.freeTrial).toEqual({
      periodIso8601: 'P3W',
      label: '3-week free trial',
    });
  });

  it('an ineligible (status 0) or unknown (eligibility throws) account never sees a trial claim', async () => {
    for (const eligibilityStatus of [0, 1, 3, -1, Number.NaN]) {
      clearAccessStoreConfiguration();
      const sdk = fakeSdk({ eligibilityStatus });
      wire({ sdk });
      await act(async () => {
        await useAccessStore.getState().initialize();
      });
      expect(useAccessStore.getState().plans?.annual?.freeTrial).toBeNull();
    }
    clearAccessStoreConfiguration();
    const throwing = fakeSdk();
    throwing.sdk.checkTrialOrIntroductoryPriceEligibility.mockRejectedValue(
      new Error('eligibility unavailable'),
    );
    wire({ sdk: throwing });
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    expect(useAccessStore.getState().plans?.annual?.freeTrial).toBeNull();
    expect(useAccessStore.getState().status).toBe('ready');
  });
});

// ─── S5: lifetime-only offering ─────────────────────────────────────────────

describe('S5: current offering with only a lifetime package', () => {
  it('renders one podium column, no savings badge, no /mo, and Continue reads the one-time price', async () => {
    const sdk = fakeSdk({ annual: null, monthly: null });
    wire({ sdk });
    const { renderer } = await renderPaywall();
    await openPricing(renderer);

    const state = useAccessStore.getState();
    expect(state.plans).toEqual(
      expect.objectContaining({ annual: null, monthly: null }),
    );
    expect(state.plans?.lifetime?.period).toBe('lifetime');
    expect(state.selectedPeriod).toBe('lifetime');

    expect(podiumColumns(renderer)).toEqual(['lifetime']);
    const copy = allText(renderer);
    expect(copy).not.toMatch(/SAVE/);
    expect(copy).not.toMatch(/BEST VALUE/);
    expect(copy).not.toContain('/mo');
    expect(copy).not.toMatch(/free trial/i);
    expect(copy).toContain('PAY ONCE');
    expect(copy).toContain(
      '$159.99 one-time purchase. Not a subscription — no renewal.',
    );
    const host = continueHost(renderer);
    expect(host.props.accessibilityLabel).toBe('Continue · $159.99 once');
    expect(host.props.accessibilityState?.disabled).toBe(false);

    // Selecting a period the offering does not carry is a no-op.
    await act(async () => {
      useAccessStore.getState().selectPeriod('annual');
      useAccessStore.getState().selectPeriod('monthly');
    });
    expect(useAccessStore.getState().selectedPeriod).toBe('lifetime');
    expect(
      nativePressable(renderer, 'paywall-plan-lifetime').props
        .accessibilityState?.selected,
    ).toBe(true);
    await unmount(renderer);
  });

  it('a lifetime package that smuggles an introPrice still gets no trial claim', async () => {
    const sdk = fakeSdk({
      annual: null,
      monthly: null,
      lifetime: storePackage('LIFETIME', {
        intro: { price: 0, cycles: 1, period: 'P7D' },
        perMonth: '$13.33',
      }),
    });
    wire({ sdk });
    const { renderer } = await renderPaywall();
    await openPricing(renderer);
    expect(useAccessStore.getState().plans?.lifetime?.freeTrial).toBeNull();
    expect(useAccessStore.getState().plans?.lifetime?.pricePerMonthString).toBe(
      null,
    );
    expect(continueHost(renderer).props.accessibilityLabel).toBe(
      'Continue · $159.99 once',
    );
    expect(allText(renderer)).not.toContain('/mo');
    await unmount(renderer);
  });
});

// ─── S6: annual dearer than 12 × monthly ────────────────────────────────────

describe('S6: annual.price > 12 × monthly.price', () => {
  async function savingsChip(annualPrice: number, monthlyPrice: number) {
    clearAccessStoreConfiguration();
    const sdk = fakeSdk({
      annual: storePackage('ANNUAL', {
        price: annualPrice,
        priceString: `$${annualPrice.toFixed(2)}`,
        perMonth: `$${(annualPrice / 12).toFixed(2)}`,
      }),
      monthly: storePackage('MONTHLY', {
        price: monthlyPrice,
        priceString: `$${monthlyPrice.toFixed(2)}`,
      }),
    });
    wire({ sdk });
    const { renderer } = await renderPaywall();
    await openPricing(renderer);
    const copy = allText(renderer);
    await unmount(renderer);
    return copy.match(/SAVE[^%]*%/g) ?? [];
  }

  it('never renders a negative or zero savings label', async () => {
    expect(await savingsChip(99.99, 7.99)).toEqual([]);
    expect(await savingsChip(95.88, 7.99)).toEqual([]);
    expect(await savingsChip(95.87, 7.99)).toEqual([]); // rounds to 0%
    expect(await savingsChip(59.99, 7.99)).toEqual(['SAVE 37%']);
    expect(await savingsChip(0.01, 7.99)).toEqual(['SAVE 100%']);
  });

  it('seeded price fuzz: any rendered SAVE label is an integer in 1..100 with no minus sign', async () => {
    const random = lcg(ATTACK_SEED ^ 0x600d);
    const log: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      const monthly = Math.round(random() * 5000) / 100;
      const annual = Math.round(random() * 40000) / 100;
      const chips = await savingsChip(annual, monthly);
      log.push(
        `annual=${annual} monthly=${monthly} => ${JSON.stringify(chips)}`,
      );
      for (const chip of chips) {
        expect([log.at(-1), chip]).toEqual([
          log.at(-1),
          expect.stringMatching(/^SAVE (?:[1-9]\d?|100)%$/),
        ]);
      }
      if (annual >= monthly * 12 || monthly <= 0) {
        expect([log.at(-1), chips]).toEqual([log.at(-1), []]);
      }
    }
    expect(log).toHaveLength(14);
  });

  it('a zero or negative monthly price disables the savings maths instead of dividing by zero', async () => {
    expect(await savingsChip(59.99, 0)).toEqual([]);
    expect(await savingsChip(59.99, -7.99)).toEqual([]);
  });
});

// ─── S7: purchasePackage resolves with entitlements:{} ──────────────────────

describe('S7: purchasePackage resolves with a malformed customerInfo', () => {
  const malformed: Array<[string, unknown]> = [
    ['entitlements:{}', { entitlements: {} }],
    ['entitlements.active:null', { entitlements: { active: null } }],
    ['{}', {}],
    ['null', null],
    ['undefined', undefined],
  ];

  for (const [name, customerInfo] of malformed) {
    it(`customerInfo=${name} surfaces purchase_failed copy with no raw TypeError and leaves the UI usable`, async () => {
      const backend = fakeBackend();
      const sdk = fakeSdk({ purchaseCustomerInfo: customerInfo });
      wire({ sdk, backend });
      const { renderer, handlers } = await renderPaywall();
      await openPricing(renderer);
      await press(renderer, 'paywall-continue');

      expect(sdk.sdk.purchasePackage).toHaveBeenCalledTimes(1);
      const state = useAccessStore.getState();
      expect(state.operation).toBe('idle');
      expect(state.error?.code).toBe('billing.purchase_failed');
      expect(state.error?.retryable).toBe(true);
      expect(state.error?.message).toBe(PURCHASE_FAILED_COPY);
      expect(state.error?.message).not.toMatch(
        /TypeError|Cannot read|undefined|null/,
      );
      expect(errorCard(renderer)?.props.accessibilityHint).toBe(
        PURCHASE_FAILED_COPY,
      );
      expect(allText(renderer)).not.toMatch(/TypeError|Cannot read propert/);
      expect(handlers.onPurchased).not.toHaveBeenCalled();
      // The verified free allowance loaded before the tap is untouched.
      expect(state.canonicalAccess?.freeRatings.remaining).toBe(1);
      expect(continueHost(renderer).props.accessibilityState?.disabled).toBe(
        false,
      );
      expect(spinnerCount(renderer)).toBe(0);
      // OBSERVATION: StoreKit DID resolve the purchase, yet the backend is
      // never asked to verify it — the copy tells the user to try again.
      expect(backend.count('POST', '/v1/billing/sync')).toBe(0);
      await unmount(renderer);
    });
  }

  it('restorePurchases resolving with entitlements:{} surfaces restore_failed without a TypeError', async () => {
    const backend = fakeBackend();
    const sdk = fakeSdk({ restoreCustomerInfo: { entitlements: {} } });
    wire({ sdk, backend });
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    await press(renderer, 'paywall-restore');
    const state = useAccessStore.getState();
    expect(state.operation).toBe('idle');
    expect(state.error?.code).toBe('billing.restore_failed');
    expect(state.error?.message).not.toMatch(/TypeError|Cannot read/);
    expect(handlers.onPurchased).not.toHaveBeenCalled();
    expect(backend.count('POST', '/v1/billing/sync')).toBe(0);
    await unmount(renderer);
  });

  it('a well-formed but non-premium customerInfo still reaches the backend, which decides', async () => {
    const backend = fakeBackend();
    const sdk = fakeSdk({
      purchaseCustomerInfo: { entitlements: { active: {} } },
    });
    wire({ sdk, backend });
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    await press(renderer, 'paywall-continue');
    expect(backend.count('POST', '/v1/billing/sync')).toBe(1);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    expect(handlers.onPurchased).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });
});

// ─── Extras: interleavings, corrupt state, unicode, huge inputs ─────────────

describe('extra: interleavings and hostile store strings', () => {
  it('switching the podium while StoreKit is open purchases the ORIGINAL plan and the summary tracks the new one', async () => {
    const sdk = fakeSdk({ deferPurchase: true });
    wire({ sdk });
    const { renderer } = await renderPaywall();
    await openPricing(renderer);
    expect(useAccessStore.getState().selectedPeriod).toBe('annual');
    await press(renderer, 'paywall-continue');
    const purchased = sdk.sdk.purchasePackage.mock.calls[0]?.[0] as
      RevenueCatPackageLike | undefined;
    expect(purchased?.packageType).toBe('ANNUAL');

    // Columns are NOT disabled during a purchase.
    expect(
      nativePressable(renderer, 'paywall-plan-lifetime').props
        .accessibilityState?.disabled,
    ).not.toBe(true);
    await press(renderer, 'paywall-plan-lifetime');
    expect(useAccessStore.getState().selectedPeriod).toBe('lifetime');
    // While the annual purchase sheet is open the screen now describes the
    // lifetime plan under the spinner.
    expect(allText(renderer)).toContain(
      '$159.99 one-time purchase. Not a subscription — no renewal.',
    );
    expect(spinnerCount(renderer)).toBeGreaterThan(0);

    await act(async () => {
      sdk.resolvePurchase();
    });
    await flush(2);
    expect(sdk.sdk.purchasePackage).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    await unmount(renderer);
  });

  it('initialize() during an in-flight purchase resets operation to idle and lets a second purchase start (store-level guard gap)', async () => {
    const sdk = fakeSdk({ deferPurchase: true });
    wire({ sdk });
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    void useAccessStore.getState().purchaseSelected();
    await flush();
    expect(useAccessStore.getState().operation).toBe('purchasing');
    expect(sdk.pendingPurchases()).toBe(1);

    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    expect(useAccessStore.getState().operation).toBe('idle');
    void useAccessStore.getState().purchaseSelected();
    await flush();
    expect(sdk.sdk.purchasePackage).toHaveBeenCalledTimes(2);
    expect(sdk.pendingPurchases()).toBe(2);
    await act(async () => {
      sdk.resolvePurchase();
      sdk.resolvePurchase();
    });
    await flush(2);
    expect(useAccessStore.getState().operation).toBe('idle');
  });

  it('the paywall Try-again control is disabled during a purchase, so the UI never reaches that gap', async () => {
    const backend = fakeBackend({
      access: () => new Error('offline'),
    });
    const sdk = fakeSdk({ deferPurchase: true });
    wire({ sdk, backend });
    const { renderer } = await renderPaywall();
    await openPricing(renderer);
    backend.respond('GET', '/v1/me/access', () => ({
      body: accessPayload(false, 1),
    }));
    await press(renderer, 'paywall-retry');
    await press(renderer, 'paywall-continue');
    expect(useAccessStore.getState().operation).toBe('purchasing');
    // Retry is only visible while access is null / plans missing; both are
    // present now, so there is no Try-again control to press at all.
    expect(
      renderer.root.findAll(n => n.props.testID === 'paywall-retry'),
    ).toHaveLength(0);
    await act(async () => {
      sdk.resolvePurchase();
    });
    await flush(2);
    await unmount(renderer);
  });

  it('unicode, RTL, zero-width and huge price strings render verbatim in the CTA without crashing', async () => {
    const random = lcg(ATTACK_SEED ^ 0xfeed);
    const glyphs = 'ابتث€¥₹₩$0123456789.,\u200b\u202e😀🏓\u0301';
    const huge = Array.from(
      { length: 5000 },
      () => glyphs[Math.floor(random() * glyphs.length)],
    ).join('');
    const sdk = fakeSdk({
      annual: storePackage('ANNUAL', {
        priceString: huge,
        perMonth: '\u202e00.5$\u202c',
        intro: null,
      }),
      monthly: storePackage('MONTHLY', { priceString: '₹٧٫٩٩' }),
      lifetime: storePackage('LIFETIME', { priceString: '😀'.repeat(200) }),
    });
    wire({ sdk });
    const { renderer } = await renderPaywall();
    await openPricing(renderer);
    expect(continueHost(renderer).props.accessibilityLabel).toBe(
      `Continue · ${huge}/yr`,
    );
    await press(renderer, 'paywall-plan-monthly');
    expect(continueHost(renderer).props.accessibilityLabel).toBe(
      'Continue · ₹٧٫٩٩/mo',
    );
    await press(renderer, 'paywall-plan-lifetime');
    expect(continueHost(renderer).props.accessibilityLabel).toBe(
      `Continue · ${'😀'.repeat(200)} once`,
    );
    expect(useAccessStore.getState().error).toBeNull();
    await unmount(renderer);
  });

  it('a sync body with a mismatched billing/access premium pair is rejected as invalid and never unlocks', async () => {
    const backend = fakeBackend({
      sync: () => ({
        body: {
          billing: {
            premium: true,
            productKey: 'pickle_sensei_pro_annual',
            expiresAt: null,
            verifiedAt: '2026-09-01T00:00:00.000Z',
          },
          access: accessPayload(false, 2),
        },
      }),
    });
    const sdk = fakeSdk();
    wire({ sdk, backend });
    const { renderer, handlers } = await renderPaywall();
    await openPricing(renderer);
    await press(renderer, 'paywall-continue');
    expect(handlers.onPurchased).not.toHaveBeenCalled();
    const state = useAccessStore.getState();
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    expect(state.canonicalAccess).toBeNull();
    expect(selectPaywallRequired(state)).toBe(true);
    await unmount(renderer);
  });

  it('a 429 on /v1/me/access at launch is retryable, shows Try again, and one tap recovers', async () => {
    let limited = true;
    const backend = fakeBackend({
      access: () =>
        limited
          ? { status: 429, headers: { 'Retry-After': '30' } }
          : { body: accessPayload(false, 0) },
    });
    wire({ backend });
    const { renderer } = await renderPaywall();
    await openPricing(renderer);
    const state = useAccessStore.getState();
    expect(state.status).toBe('error');
    expect(state.error?.code).toBe('billing.backend_unavailable');
    expect(state.error?.retryable).toBe(true);
    expect(state.canonicalAccess).toBeNull();
    expect(continueHost(renderer).props.accessibilityState?.disabled).toBe(
      true,
    );
    limited = false;
    await press(renderer, 'paywall-retry');
    expect(
      useAccessStore.getState().canonicalAccess?.freeRatings.remaining,
    ).toBe(2);
    expect(continueHost(renderer).props.accessibilityState?.disabled).toBe(
      false,
    );
    await unmount(renderer);
  });
});
