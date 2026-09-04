/**
 * ADVERSARIAL PASS 3 — mobile-billing-paywall (S1, screen layer).
 *
 * PaywallScreen over the REAL access store and the REAL RevenueCat client
 * (SDK mocked). The first load leaves the screen on Retry; between the first
 * load and Retry the SDK's current offering rotates. After Retry the podium,
 * the Continue label and the id handed to purchase() must all come from the
 * fresh plans — never from a plan object captured on the first render.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
  };
});
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
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

import { PaywallScreen } from '../../src/screens/PaywallScreen';
import { PressableScale } from '../../src/design/components';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import {
  createRevenueCatBillingClient,
  type CanonicalAccessState,
  type CanonicalBillingSync,
  type RevenueCatCustomerInfoLike,
  type RevenueCatPackageLike,
  type RevenueCatSdk,
} from '../../src/billing';

const USER = '11111111-1111-4111-8111-111111111111';

function customerInfo(premium: boolean): RevenueCatCustomerInfoLike {
  return {
    entitlements: {
      active: premium
        ? {
            pickle_sensei_pro: {
              productIdentifier: 'pickle_sensei_pro_annual',
              expirationDate: '2027-08-27T00:00:00.000Z',
            },
          }
        : {},
    },
  };
}

type Offering = {
  identifier: string;
  annual: RevenueCatPackageLike | null;
  monthly: RevenueCatPackageLike | null;
  lifetime: RevenueCatPackageLike | null;
};

function pkg(
  period: 'ANNUAL' | 'MONTHLY' | 'LIFETIME',
  suffix: string,
  price: number,
  priceString: string,
  perMonth: string | null,
): RevenueCatPackageLike {
  const base = {
    ANNUAL: { id: '$rc_annual', product: 'pickle_sensei_pro_annual' },
    MONTHLY: { id: '$rc_monthly', product: 'pickle_sensei_pro_monthly' },
    LIFETIME: { id: '$rc_lifetime', product: 'pickle_sensei_pro_lifetime' },
  }[period];
  return {
    identifier: `${base.id}${suffix}`,
    packageType: period,
    product: {
      identifier: `${base.product}${suffix}`,
      price,
      priceString,
      pricePerMonthString: perMonth,
      introPrice: null,
      defaultOption: null,
    },
  };
}

const OFFERING_V1: Offering = {
  identifier: 'default',
  annual: pkg('ANNUAL', '', 59.99, '$59.99', '$5.00'),
  monthly: pkg('MONTHLY', '', 7.99, '$7.99', '$7.99'),
  lifetime: pkg('LIFETIME', '', 159.99, '$159.99', null),
};
const OFFERING_V2: Offering = {
  identifier: 'spring_2026',
  annual: pkg('ANNUAL', '_v2', 49.99, '$49.99', '$4.17'),
  monthly: pkg('MONTHLY', '_v2', 6.99, '$6.99', '$6.99'),
  lifetime: pkg('LIFETIME', '_v2', 129.99, '$129.99', null),
};
const V1_ANNUAL_ID = 'default:annual:$rc_annual:pickle_sensei_pro_annual';
const V2_ANNUAL_ID =
  'spring_2026:annual:$rc_annual_v2:pickle_sensei_pro_annual_v2';
const V2_MONTHLY_ID =
  'spring_2026:monthly:$rc_monthly_v2:pickle_sensei_pro_monthly_v2';

function sdk(initial: Offering) {
  let current: Offering | null = initial;
  const purchased: string[] = [];
  const native: RevenueCatSdk = {
    isConfigured: jest.fn(async () => false),
    configure: jest.fn(async () => undefined),
    getAppUserID: jest.fn(async () => USER),
    logIn: jest.fn(async () => undefined),
    getOfferings: jest.fn(async () => ({ current })),
    purchasePackage: jest.fn(async (aPackage: RevenueCatPackageLike) => {
      purchased.push(aPackage.product.identifier);
      return { customerInfo: customerInfo(true) };
    }),
    restorePurchases: jest.fn(async () => customerInfo(false)),
    getCustomerInfo: jest.fn(async () => customerInfo(false)),
    checkTrialOrIntroductoryPriceEligibility: jest.fn(async () => ({})),
  };
  return {
    native,
    purchased,
    rotate(next: Offering | null) {
      current = next;
    },
  };
}

function freeAccess(used: number): CanonicalAccessState {
  const remaining = 2 - used;
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
      used,
      reserved: 0,
      remaining,
      availableToReserve: remaining,
    },
    canStartRating: remaining > 0,
    paywallRequired: remaining <= 0,
  };
}

function premiumSync(): CanonicalBillingSync {
  return {
    billing: {
      premium: true,
      productKey: 'pickle_sensei_pro_annual',
      expiresAt: null,
      verifiedAt: '2026-09-01T00:00:00.000Z',
    },
    access: {
      premium: true,
      entitlements: ['premium', 'pickle_sensei_pro'],
      freeRatings: {
        limit: 2,
        used: 2,
        reserved: 0,
        remaining: 0,
        availableToReserve: 0,
      },
      canStartRating: true,
      paywallRequired: false,
    },
  };
}

function harness(initial: Offering) {
  const store = sdk(initial);
  const client = createRevenueCatBillingClient(
    { publicSdkKey: 'appl_public', canonicalAppUserId: USER },
    store.native,
    'ios',
  );
  let accessFails = true;
  const backend = {
    getAccess: jest.fn(async () => {
      if (accessFails) throw new Error('offline');
      return freeAccess(2);
    }),
    syncBilling: jest.fn(async () => premiumSync()),
  };
  return {
    ...store,
    backend,
    clients: { store: client, backend },
    setAccessFails(value: boolean) {
      accessFails = value;
    },
  };
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(() => resolve(undefined), 0));
  });
}

async function renderPaywall(onPurchased = jest.fn()) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PaywallScreen
        onClose={jest.fn()}
        onPurchased={onPurchased}
        onOpenTerms={jest.fn()}
        onOpenPrivacy={jest.fn()}
      />,
    );
  });
  mounted.push(renderer);
  await flush();
  return renderer;
}

function pressable(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    n =>
      n.type === PressableScale &&
      n.props.testID === testID &&
      typeof n.props.onPress === 'function',
  );
}

function one(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = pressable(renderer, testID);
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
}

async function press(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  await act(async () => {
    one(renderer, testID).props.onPress();
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

beforeEach(() => {
  act(() => clearAccessStoreConfiguration());
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) act(() => renderer.unmount());
  act(() => clearAccessStoreConfiguration());
});

describe('S1 — PaywallScreen Retry re-reads the selected plan from fresh plans', () => {
  it('after Retry the podium, the Continue label and purchase() all use the rotated offering', async () => {
    const h = harness(OFFERING_V1);
    configureAccessStore(h.clients);
    const onPurchased = jest.fn();
    const paywall = await renderPaywall(onPurchased);

    // First load: plans came back on offering v1, access failed → Retry.
    expect(useAccessStore.getState().status).toBe('error');
    expect(useAccessStore.getState().plans?.annual?.id).toBe(V1_ANNUAL_ID);
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    await press(paywall, 'paywall-see-plans');
    expect(pressable(paywall, 'paywall-retry')).toHaveLength(1);
    const continueV1 = one(paywall, 'paywall-continue');
    expect(continueV1.props.disabled).toBe(true);
    expect(continueV1.props.accessibilityLabel).toBe('Continue · $59.99/yr');
    expect(h.native.getOfferings).toHaveBeenCalledTimes(1);

    // Between the two loads RevenueCat rotates the current offering and the
    // backend comes back.
    h.rotate(OFFERING_V2);
    h.setAccessFails(false);
    await press(paywall, 'paywall-retry');

    expect(h.native.getOfferings).toHaveBeenCalledTimes(2);
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().plans?.offeringId).toBe('spring_2026');
    expect(useAccessStore.getState().plans?.annual?.id).toBe(V2_ANNUAL_ID);
    expect(pressable(paywall, 'paywall-retry')).toHaveLength(0);

    const continueV2 = one(paywall, 'paywall-continue');
    expect(continueV2.props.disabled).toBe(false);
    expect(continueV2.props.accessibilityLabel).toBe('Continue · $49.99/yr');
    expect(allText(paywall)).toContain('$49.99');
    expect(allText(paywall)).not.toContain('$59.99');

    await press(paywall, 'paywall-continue');
    expect(h.purchased).toEqual(['pickle_sensei_pro_annual_v2']);
    expect(h.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(onPurchased).toHaveBeenCalledTimes(1);
  });

  it('a period chosen BEFORE Retry is reset to annual by Retry, and label + purchase id agree on the fresh annual plan (P3 UX note: the monthly choice is discarded)', async () => {
    const h = harness(OFFERING_V1);
    configureAccessStore(h.clients);
    const paywall = await renderPaywall();
    await press(paywall, 'paywall-see-plans');
    await press(paywall, 'paywall-plan-monthly');
    expect(useAccessStore.getState().selectedPeriod).toBe('monthly');
    expect(one(paywall, 'paywall-continue').props.accessibilityLabel).toBe(
      'Continue · $7.99/mo',
    );

    h.rotate(OFFERING_V2);
    h.setAccessFails(false);
    await press(paywall, 'paywall-retry');

    // initialize() resets selectedPeriod to the default ('annual'). The
    // user's monthly choice is lost (P3, UX), but label and purchase id
    // must agree — the screen may never show one plan and buy another.
    expect(useAccessStore.getState().selectedPeriod).toBe('annual');
    expect(one(paywall, 'paywall-continue').props.accessibilityLabel).toBe(
      'Continue · $49.99/yr',
    );
    expect(useAccessStore.getState().plans?.monthly?.id).toBe(V2_MONTHLY_ID);
    await press(paywall, 'paywall-continue');
    expect(h.purchased).toEqual(['pickle_sensei_pro_annual_v2']);
  });

  it('Retry when the rotated offering DROPS a package removes that column and never purchases a vanished plan', async () => {
    const h = harness(OFFERING_V1);
    configureAccessStore(h.clients);
    const paywall = await renderPaywall();
    await press(paywall, 'paywall-see-plans');
    expect(pressable(paywall, 'paywall-plan-lifetime')).toHaveLength(1);
    await press(paywall, 'paywall-plan-lifetime');
    expect(useAccessStore.getState().selectedPeriod).toBe('lifetime');

    h.rotate({ ...OFFERING_V2, lifetime: null });
    h.setAccessFails(false);
    await press(paywall, 'paywall-retry');

    expect(useAccessStore.getState().plans?.lifetime).toBeNull();
    expect(pressable(paywall, 'paywall-plan-lifetime')).toHaveLength(0);
    const cta = one(paywall, 'paywall-continue');
    expect(cta.props.disabled).toBe(false);
    expect(cta.props.accessibilityLabel).not.toContain('$159.99');
    await press(paywall, 'paywall-continue');
    expect(h.purchased).toHaveLength(1);
    expect(h.purchased[0]).not.toBe('pickle_sensei_pro_lifetime');
  });

  it('Retry when the rotated offering has NO current offering leaves Continue disabled and Retry visible (no stale v1 purchase)', async () => {
    const h = harness(OFFERING_V1);
    configureAccessStore(h.clients);
    const paywall = await renderPaywall();
    await press(paywall, 'paywall-see-plans');

    h.rotate(null);
    h.setAccessFails(false);
    await press(paywall, 'paywall-retry');

    expect(useAccessStore.getState().plans).toBeNull();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(2));
    expect(useAccessStore.getState().error?.code).toBe(
      'billing.offerings_unavailable',
    );
    expect(pressable(paywall, 'paywall-retry')).toHaveLength(1);
    const cta = one(paywall, 'paywall-continue');
    expect(cta.props.disabled).toBe(true);
    expect(cta.props.accessibilityLabel).toBe('Store pricing unavailable');
    expect(allText(paywall)).not.toContain('$59.99');
    await act(async () => {
      cta.props.onPress();
    });
    await flush();
    expect(h.purchased).toHaveLength(0);
    expect(h.native.purchasePackage).not.toHaveBeenCalled();
  });

  it('rapid Retry taps (10x) collapse into one in-flight initialize() and end on the freshest offering', async () => {
    const h = harness(OFFERING_V1);
    configureAccessStore(h.clients);
    const paywall = await renderPaywall();
    await press(paywall, 'paywall-see-plans');
    h.rotate(OFFERING_V2);
    h.setAccessFails(false);
    (h.native.getOfferings as jest.Mock).mockClear();

    const retry = one(paywall, 'paywall-retry');
    await act(async () => {
      for (let i = 0; i < 10; i += 1) retry.props.onPress();
    });
    await flush();
    // initialize() returns early while status === 'loading' and Retry is
    // hidden while busy: one offerings read for ten taps.
    expect(h.native.getOfferings).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().plans?.annual?.id).toBe(V2_ANNUAL_ID);
    expect(one(paywall, 'paywall-continue').props.accessibilityLabel).toBe(
      'Continue · $49.99/yr',
    );
  });
});
