/**
 * Adversarial pass — mobile-billing-paywall #4 (pass 3/3), plane cloud.
 * Target: src/screens/PaywallScreen.tsx + src/screens/paywallCopy.ts driving
 * the real accessStore and the real createCanonicalAccessClient at 4d812e1a.
 *
 * Assigned scenarios: S3 UI half (mismatched /v1/billing/sync → pending copy,
 * canonicalAccess===null), S8 (Continue then Restore in the same tick),
 * S9 (AppState background/foreground + bearer rotation during a purchase),
 * plus the UI consequence of probe C (Settings-first refresh → paywall
 * without store pricing) and copy/unicode/huge-input attacks.
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
jest.mock('../src/account/apiSession', () => ({
  reportApiUnauthorized: jest.fn(),
}));

import React from 'react';
import { AppState, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  createCanonicalAccessClient,
  type BillingAccessDependencies,
  type BillingFetch,
  type BillingStoreClient,
  type CanonicalAccessState,
  type StoreEntitlementState,
  type StorePlans,
} from '../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
  type AccessOperation,
} from '../src/state/accessStore';
import { PaywallScreen } from '../src/screens/PaywallScreen';
import {
  RATING_CONSUMPTION_RULE,
  freeRatingAllowanceCopy,
} from '../src/screens/paywallCopy';

const BASE = 'https://api.example.test';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const freeAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 1,
    reserved: 0,
    remaining: 1,
    availableToReserve: 1,
  },
  canStartRating: true,
  paywallRequired: false,
};

const exhaustedAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 2,
    reserved: 0,
    remaining: 0,
    availableToReserve: 0,
  },
  canStartRating: false,
  paywallRequired: true,
};

const paidAccess: CanonicalAccessState = {
  premium: true,
  entitlements: ['premium'],
  freeRatings: {
    limit: 2,
    used: 2,
    reserved: 0,
    remaining: 0,
    availableToReserve: 0,
  },
  canStartRating: true,
  paywallRequired: false,
};

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual-plan',
    productId: 'pickle_sensei_pro_annual',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: {
    id: 'monthly-plan',
    productId: 'pickle_sensei_pro_monthly',
    period: 'monthly',
    price: 7.99,
    priceString: '$7.99',
    pricePerMonthString: '$7.99',
    freeTrial: null,
  },
  lifetime: {
    id: 'lifetime-plan',
    productId: 'pickle_sensei_pro_lifetime',
    period: 'lifetime',
    price: 159.99,
    priceString: '$159.99',
    pricePerMonthString: null,
    freeTrial: null,
  },
};

const premiumEntitlement: StoreEntitlementState = {
  premium: true,
  productId: 'pickle_sensei_pro_annual',
  expirationDate: '2027-09-04T00:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

// `access` is deliberately untyped: attack payloads violate the client type.
const syncBody = (billingPremium: boolean, access: unknown) => ({
  billing: {
    premium: billingPremium,
    productKey: billingPremium ? 'pickle_sensei_pro_annual' : null,
    expiresAt: billingPremium ? '2027-09-04T00:00:00.000Z' : null,
    verifiedAt: '2026-09-04T00:00:00.000Z',
  },
  access,
});

type StoreMocks = { [K in keyof BillingStoreClient]: jest.Mock };

function fakeStore(overrides?: Partial<StoreMocks>): StoreMocks {
  return {
    configure: jest.fn(async () => undefined),
    loadPlans: jest.fn(async () => plans),
    purchase: jest.fn(async () => premiumEntitlement),
    restore: jest.fn(async () => premiumEntitlement),
    readEntitlement: jest.fn(async () => ({
      premium: false,
      productId: null,
      expirationDate: null,
    })),
    ...overrides,
  };
}

/** Real HTTP client over a scripted fetch; the token is read per request. */
function realBackend(options: {
  fetchFn: BillingFetch;
  token?: () => string | null;
}) {
  const token = options.token ?? (() => 'bearer-1');
  return createCanonicalAccessClient({
    baseUrl: BASE,
    get token() {
      return token();
    },
    fetchFn: options.fetchFn,
  });
}

function dependencies(
  store: StoreMocks,
  backend: BillingAccessDependencies['backend'],
): BillingAccessDependencies {
  return { store: store as unknown as BillingStoreClient, backend };
}

const settle = async (ms = 0) => {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), ms));
  });
};

let mounted: TestRenderer.ReactTestRenderer | null = null;

async function renderPaywall(onPurchased = jest.fn()) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PaywallScreen onClose={jest.fn()} onPurchased={onPurchased} />,
    );
  });
  mounted = renderer;
  await settle();
  return { renderer, onPurchased };
}

/** A failing assertion must not leak the tree into the next test. */
function unmountPaywall() {
  const renderer = mounted;
  mounted = null;
  if (renderer) act(() => renderer.unmount());
}

async function openPricing(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    pressable(renderer, 'paywall-see-plans').props.onPress();
  });
  await settle();
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

function maybePressable(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  return renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
}

function recordOperations(): { ops: AccessOperation[]; stop: () => void } {
  const ops: AccessOperation[] = [useAccessStore.getState().operation];
  const stop = useAccessStore.subscribe(state => {
    if (ops[ops.length - 1] !== state.operation) ops.push(state.operation);
  });
  return { ops, stop };
}

beforeEach(() => {
  clearAccessStoreConfiguration();
  (AppState.addEventListener as jest.Mock).mockClear();
});

afterEach(() => {
  unmountPaywall();
});

afterAll(() => {
  clearAccessStoreConfiguration();
});

describe('S3 (UI half) — mismatched /v1/billing/sync shows pending copy with canonicalAccess===null', () => {
  it('restore → sync returns billing.premium:true / access.premium:false → pending copy, no unlock', async () => {
    const fetchFn = jest.fn(async (input: string) =>
      input.endsWith('/v1/billing/sync')
        ? jsonResponse(syncBody(true, exhaustedAccess))
        : jsonResponse(exhaustedAccess),
    );
    const store = fakeStore();
    configureAccessStore(dependencies(store, realBackend({ fetchFn })));
    const { renderer, onPurchased } = await renderPaywall();
    await openPricing(renderer);
    expect(allText(renderer)).toContain(
      freeRatingAllowanceCopy(exhaustedAccess),
    );

    await act(async () => {
      pressable(renderer, 'paywall-restore').props.onPress();
    });
    await settle();

    const state = useAccessStore.getState();
    expect(store.restore).toHaveBeenCalledTimes(1);
    expect(state.canonicalAccess).toBeNull();
    expect(state.status).toBe('error');
    expect(state.operation).toBe('idle');
    expect(state.error).toMatchObject({
      code: 'billing.backend_verification_pending',
      retryable: true,
    });
    expect(onPurchased).not.toHaveBeenCalled();

    const copy = allText(renderer);
    expect(copy).toContain(
      'Restored purchases could not be verified yet. Please try again.',
    );
    expect(copy).toContain(freeRatingAllowanceCopy(null));
    expect(copy).not.toContain('MEMBERSHIP VERIFIED');
    expect(pressable(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(pressable(renderer, 'paywall-retry')).toBeTruthy();
    unmountPaywall();
  });

  it('purchase → mismatched sync → purchase-pending copy, Continue disabled, no onPurchased', async () => {
    const fetchFn = jest.fn(async (input: string) =>
      input.endsWith('/v1/billing/sync')
        ? jsonResponse(syncBody(true, freeAccess))
        : jsonResponse(freeAccess),
    );
    const store = fakeStore();
    configureAccessStore(dependencies(store, realBackend({ fetchFn })));
    const { renderer, onPurchased } = await renderPaywall();
    await openPricing(renderer);
    await act(async () => {
      pressable(renderer, 'paywall-continue').props.onPress();
    });
    await settle();
    expect(store.purchase).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(useAccessStore.getState().error).toMatchObject({
      code: 'billing.backend_verification_pending',
    });
    expect(allText(renderer)).toContain(
      'The store completed your purchase, but membership verification is still pending. Try Restore purchases.',
    );
    expect(pressable(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(pressable(renderer, 'paywall-restore').props.disabled).toBe(false);
    expect(onPurchased).not.toHaveBeenCalled();
    unmountPaywall();
  });

  it('a sync whose access widens the free limit to 3 is rejected the same way', async () => {
    const widened = {
      ...exhaustedAccess,
      freeRatings: {
        limit: 3,
        used: 2,
        reserved: 0,
        remaining: 1,
        availableToReserve: 1,
      },
      canStartRating: true,
      paywallRequired: false,
    };
    const fetchFn = jest.fn(async (input: string) =>
      input.endsWith('/v1/billing/sync')
        ? jsonResponse(syncBody(false, widened))
        : jsonResponse(exhaustedAccess),
    );
    configureAccessStore(dependencies(fakeStore(), realBackend({ fetchFn })));
    const { renderer } = await renderPaywall();
    await openPricing(renderer);
    await act(async () => {
      pressable(renderer, 'paywall-restore').props.onPress();
    });
    await settle();
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    expect(allText(renderer)).not.toContain('3 free ratings');
    expect(allText(renderer)).toContain(freeRatingAllowanceCopy(null));
    unmountPaywall();
  });
});

describe('S8 — Continue then Restore in the same tick', () => {
  it('exactly one store call, operation never goes purchasing → restoring', async () => {
    const purchase = deferred<StoreEntitlementState>();
    const store = fakeStore({ purchase: jest.fn(() => purchase.promise) });
    const fetchFn = jest.fn(async (input: string) =>
      input.endsWith('/v1/billing/sync')
        ? jsonResponse(syncBody(true, paidAccess))
        : jsonResponse(freeAccess),
    );
    configureAccessStore(dependencies(store, realBackend({ fetchFn })));
    const { renderer, onPurchased } = await renderPaywall();
    await openPricing(renderer);
    const { ops, stop } = recordOperations();

    await act(async () => {
      // Both presses in ONE tick: the Restore button has not re-rendered as
      // disabled yet, so only the store's operation guard can stop it.
      pressable(renderer, 'paywall-continue').props.onPress();
      pressable(renderer, 'paywall-restore').props.onPress();
    });
    await settle();
    expect(store.purchase).toHaveBeenCalledTimes(1);
    expect(store.restore).toHaveBeenCalledTimes(0);
    expect(useAccessStore.getState().operation).toBe('purchasing');
    expect(pressable(renderer, 'paywall-restore').props.disabled).toBe(true);
    expect(pressable(renderer, 'paywall-continue').props.disabled).toBe(true);

    purchase.resolve(premiumEntitlement);
    await settle();
    stop();
    expect(ops).toEqual(['idle', 'purchasing', 'idle']);
    expect(ops).not.toContain('restoring');
    expect(
      fetchFn.mock.calls.filter(([u]) => u.endsWith('/v1/billing/sync')),
    ).toHaveLength(1);
    expect(onPurchased).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess).toEqual(paidAccess);
    unmountPaywall();
  });

  it('Restore then Continue in the same tick → exactly one restore, no purchase', async () => {
    const restore = deferred<StoreEntitlementState>();
    const store = fakeStore({ restore: jest.fn(() => restore.promise) });
    const fetchFn = jest.fn(async (input: string) =>
      input.endsWith('/v1/billing/sync')
        ? jsonResponse(syncBody(true, paidAccess))
        : jsonResponse(freeAccess),
    );
    configureAccessStore(dependencies(store, realBackend({ fetchFn })));
    const { renderer, onPurchased } = await renderPaywall();
    await openPricing(renderer);
    const { ops, stop } = recordOperations();
    await act(async () => {
      pressable(renderer, 'paywall-restore').props.onPress();
      pressable(renderer, 'paywall-continue').props.onPress();
      pressable(renderer, 'paywall-restore').props.onPress();
    });
    await settle();
    expect(store.restore).toHaveBeenCalledTimes(1);
    expect(store.purchase).not.toHaveBeenCalled();
    restore.resolve(premiumEntitlement);
    await settle();
    stop();
    expect(ops).toEqual(['idle', 'restoring', 'idle']);
    expect(onPurchased).toHaveBeenCalledTimes(1);
    unmountPaywall();
  });

  it('Continue ×10 across ticks while the sheet is open → one purchase, one sync, one onPurchased', async () => {
    const purchase = deferred<StoreEntitlementState>();
    const store = fakeStore({ purchase: jest.fn(() => purchase.promise) });
    const fetchFn = jest.fn(async (input: string) =>
      input.endsWith('/v1/billing/sync')
        ? jsonResponse(syncBody(true, paidAccess))
        : jsonResponse(freeAccess),
    );
    configureAccessStore(dependencies(store, realBackend({ fetchFn })));
    const { renderer, onPurchased } = await renderPaywall();
    await openPricing(renderer);
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        pressable(renderer, 'paywall-continue').props.onPress();
      });
    }
    purchase.resolve(premiumEntitlement);
    await settle();
    expect(store.purchase).toHaveBeenCalledTimes(1);
    expect(
      fetchFn.mock.calls.filter(([u]) => u.endsWith('/v1/billing/sync')),
    ).toHaveLength(1);
    expect(onPurchased).toHaveBeenCalledTimes(1);
    unmountPaywall();
  });
});

describe('S9 — AppState background/foreground during purchaseSelected', () => {
  function fireAppState(next: 'active' | 'background' | 'inactive') {
    for (const [event, listener] of (AppState.addEventListener as jest.Mock)
      .mock.calls as Array<[string, (state: string) => void]>) {
      if (event === 'change') listener(next);
    }
  }

  it('toggling AppState mid-purchase yields exactly one syncBilling and one onPurchased', async () => {
    const purchase = deferred<StoreEntitlementState>();
    const store = fakeStore({ purchase: jest.fn(() => purchase.promise) });
    const fetchFn = jest.fn(async (input: string) =>
      input.endsWith('/v1/billing/sync')
        ? jsonResponse(syncBody(true, paidAccess))
        : jsonResponse(freeAccess),
    );
    configureAccessStore(dependencies(store, realBackend({ fetchFn })));
    const { renderer, onPurchased } = await renderPaywall();
    await openPricing(renderer);
    await act(async () => {
      pressable(renderer, 'paywall-continue').props.onPress();
    });
    await settle();
    expect(useAccessStore.getState().operation).toBe('purchasing');

    await act(async () => {
      fireAppState('inactive');
      fireAppState('background');
    });
    await settle(5);
    await act(async () => {
      fireAppState('active');
    });
    await settle(5);
    expect(useAccessStore.getState().operation).toBe('purchasing');
    expect(store.purchase).toHaveBeenCalledTimes(1);

    purchase.resolve(premiumEntitlement);
    await settle();
    await act(async () => {
      fireAppState('background');
      fireAppState('active');
    });
    await settle(5);

    const syncCalls = fetchFn.mock.calls.filter(([u]) =>
      u.endsWith('/v1/billing/sync'),
    );
    expect(syncCalls).toHaveLength(1);
    expect(onPurchased).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState()).toMatchObject({
      operation: 'idle',
      status: 'ready',
      canonicalAccess: paidAccess,
      error: null,
    });
    expect(allText(renderer)).toContain('MEMBERSHIP VERIFIED');
    unmountPaywall();
  });

  it('billing registers no AppState listener of its own (no automatic restore/sync on foreground)', async () => {
    configureAccessStore(
      dependencies(
        fakeStore(),
        realBackend({ fetchFn: async () => jsonResponse(freeAccess) }),
      ),
    );
    const { renderer } = await renderPaywall();
    await openPricing(renderer);
    const listeners = (AppState.addEventListener as jest.Mock).mock.calls;
    expect(listeners).toHaveLength(0);
    unmountPaywall();
  });

  it('a bearer rotated on foreground mid-purchase is used by the post-purchase sync', async () => {
    let token = 'bearer-before-background';
    const purchase = deferred<StoreEntitlementState>();
    const store = fakeStore({ purchase: jest.fn(() => purchase.promise) });
    const auths: string[] = [];
    const fetchFn: BillingFetch = async (input, init) => {
      auths.push(
        `${input.endsWith('/v1/billing/sync') ? 'sync' : 'get'} ${
          (init?.headers as Record<string, string>).Authorization
        }`,
      );
      return input.endsWith('/v1/billing/sync')
        ? jsonResponse(syncBody(true, paidAccess))
        : jsonResponse(freeAccess);
    };
    configureAccessStore(
      dependencies(store, realBackend({ fetchFn, token: () => token })),
    );
    const { renderer, onPurchased } = await renderPaywall();
    await openPricing(renderer);
    await act(async () => {
      pressable(renderer, 'paywall-continue').props.onPress();
    });
    await settle();
    // Foreground → sessionKeeper rotates the bearer (establishApiSession),
    // which the billing client observes through its token getter.
    token = 'bearer-after-foreground';
    purchase.resolve(premiumEntitlement);
    await settle();
    expect(auths).toEqual([
      'get Bearer bearer-before-background',
      'sync Bearer bearer-after-foreground',
    ]);
    expect(onPurchased).toHaveBeenCalledTimes(1);
    unmountPaywall();
  });

  it('a bearer that expires to null mid-purchase fails closed as verification pending', async () => {
    let token: string | null = 'bearer-1';
    const purchase = deferred<StoreEntitlementState>();
    const store = fakeStore({ purchase: jest.fn(() => purchase.promise) });
    const fetchFn = jest.fn(async () => jsonResponse(freeAccess));
    configureAccessStore(
      dependencies(store, realBackend({ fetchFn, token: () => token })),
    );
    const { renderer, onPurchased } = await renderPaywall();
    await openPricing(renderer);
    await act(async () => {
      pressable(renderer, 'paywall-continue').props.onPress();
    });
    await settle();
    token = null;
    purchase.resolve(premiumEntitlement);
    await settle();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onPurchased).not.toHaveBeenCalled();
    expect(useAccessStore.getState()).toMatchObject({
      canonicalAccess: null,
      status: 'error',
      error: { code: 'billing.backend_verification_pending' },
    });
    unmountPaywall();
  });
});

describe('probe C (UI) — paywall opened after a Settings-first refreshAccess()', () => {
  it('shows store pricing after the store was refreshed but never initialized', async () => {
    const store = fakeStore();
    configureAccessStore(
      dependencies(
        store,
        realBackend({ fetchFn: async () => jsonResponse(freeAccess) }),
      ),
    );
    // SettingsScreen useFocusEffect on a cold start (status 'idle').
    await useAccessStore.getState().refreshAccess();
    expect(useAccessStore.getState().status).toBe('ready');

    const { renderer } = await renderPaywall();
    await openPricing(renderer);
    const copy = allText(renderer);
    expect(store.loadPlans).toHaveBeenCalled();
    expect(useAccessStore.getState().plans).not.toBeNull();
    expect(copy).not.toContain('Store pricing is unavailable');
    expect(copy).toContain('$59.99');
    expect(pressable(renderer, 'paywall-continue').props.disabled).toBe(false);
    unmountPaywall();
  });

  it('control: the manual retry control on that screen does run initialize() and recovers pricing', async () => {
    const store = fakeStore();
    configureAccessStore(
      dependencies(
        store,
        realBackend({ fetchFn: async () => jsonResponse(freeAccess) }),
      ),
    );
    await useAccessStore.getState().refreshAccess();
    const { renderer } = await renderPaywall();
    await openPricing(renderer);
    expect(allText(renderer)).toContain('Store pricing is unavailable');
    await act(async () => {
      pressable(renderer, 'paywall-retry').props.onPress();
    });
    await settle();
    expect(store.loadPlans).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().plans).not.toBeNull();
    expect(allText(renderer)).toContain('$59.99');
    unmountPaywall();
  });
});

describe('extra — copy, unicode and huge inputs on the pricing page', () => {
  it('a 10k-character unicode priceString renders once and never becomes an estimate', async () => {
    const huge = '🥒'.repeat(5_000) + '€59,99';
    const weirdPlans: StorePlans = {
      ...plans,
      annual: {
        ...plans.annual!,
        priceString: huge,
        pricePerMonthString: null,
      },
      monthly: null,
      lifetime: null,
    };
    const store = fakeStore({ loadPlans: jest.fn(async () => weirdPlans) });
    configureAccessStore(
      dependencies(
        store,
        realBackend({ fetchFn: async () => jsonResponse(freeAccess) }),
      ),
    );
    const { renderer } = await renderPaywall();
    await openPricing(renderer);
    const copy = allText(renderer);
    expect(copy).toContain(huge);
    expect(copy).not.toMatch(/\$\d/);
    expect(
      pressable(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe(`Continue · ${huge}/yr`);
    unmountPaywall();
  });

  it('pricing/value copy never carries forbidden store-listing terms', async () => {
    configureAccessStore(
      dependencies(
        fakeStore(),
        realBackend({ fetchFn: async () => jsonResponse(freeAccess) }),
      ),
    );
    const { renderer } = await renderPaywall();
    const valueCopy = allText(renderer);
    await openPricing(renderer);
    const pricingCopy = allText(renderer);
    const forbidden =
      /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?% accur|best app|#1|number one|replaces? (a|your) coach/i;
    expect(valueCopy).not.toMatch(forbidden);
    expect(pricingCopy).not.toMatch(forbidden);
    expect(valueCopy).toContain(RATING_CONSUMPTION_RULE);
    unmountPaywall();
  });

  it('a premium user never sees the pricing page or a purchase control', async () => {
    const fetchFn = jest.fn(async () => jsonResponse(paidAccess));
    const store = fakeStore();
    configureAccessStore(dependencies(store, realBackend({ fetchFn })));
    const { renderer } = await renderPaywall();
    const copy = allText(renderer);
    expect(copy).toContain('MEMBERSHIP VERIFIED');
    expect(maybePressable(renderer, 'paywall-see-plans')).toHaveLength(0);
    expect(maybePressable(renderer, 'paywall-continue')).toHaveLength(0);
    expect(maybePressable(renderer, 'paywall-restore')).toHaveLength(0);
    expect(copy).not.toContain('$');
    unmountPaywall();
  });

  it('a stale free GET landing after purchase must not flip the verified screen back to the paywall (probe B, UI)', async () => {
    const staleGet = deferred<Response>();
    let getCount = 0;
    const fetchFn = jest.fn(async (input: string) => {
      if (input.endsWith('/v1/billing/sync')) {
        return jsonResponse(syncBody(true, paidAccess));
      }
      getCount += 1;
      return getCount === 1 ? jsonResponse(freeAccess) : staleGet.promise;
    });
    const store = fakeStore();
    configureAccessStore(dependencies(store, realBackend({ fetchFn })));
    const { renderer, onPurchased } = await renderPaywall();
    await openPricing(renderer);
    // AnalyzeScreen unmount / Settings focus → refreshAccess() on a slow link.
    let refreshing!: Promise<boolean>;
    await act(async () => {
      refreshing = useAccessStore.getState().refreshAccess();
    });
    await settle();
    // Continue is still enabled while the refresh is in flight.
    expect(pressable(renderer, 'paywall-continue').props.disabled).toBe(false);
    await act(async () => {
      pressable(renderer, 'paywall-continue').props.onPress();
    });
    await settle();
    expect(onPurchased).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('MEMBERSHIP VERIFIED');

    staleGet.resolve(jsonResponse(freeAccess));
    await act(async () => {
      await refreshing;
    });
    await settle();
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    expect(allText(renderer)).toContain('MEMBERSHIP VERIFIED');
    unmountPaywall();
  });
});
