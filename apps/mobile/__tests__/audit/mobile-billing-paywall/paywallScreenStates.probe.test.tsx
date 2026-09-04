/**
 * Execution-audit probes rendering PaywallScreen through the REAL access
 * store in each data state — loading (hung), backend error, store error,
 * empty offering, missing snapshot, verified member — and asserting what
 * the user can and cannot do in each. Names starting with "OBSERVED:"
 * document audit findings.
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
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  BillingError,
  type BillingAccessDependencies,
  type CanonicalAccessState,
  type CanonicalBillingSync,
  type StoreEntitlementState,
  type StorePlans,
} from '../../../src/billing/types';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../../src/state/accessStore';
import { PressableScale } from '../../../src/design/components';
import {
  PaywallScreen,
  type PaywallScreenProps,
} from '../../../src/screens/PaywallScreen';

const exhausted: CanonicalAccessState = {
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

const oneReserved: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 0,
    reserved: 1,
    remaining: 2,
    availableToReserve: 1,
  },
  canStartRating: true,
  paywallRequired: false,
};

const premium: CanonicalAccessState = {
  premium: true,
  entitlements: ['pickle_sensei_pro', 'premium'],
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

const storeEntitlement: StoreEntitlementState = {
  premium: true,
  productId: 'pickle_sensei_pro_annual',
  expirationDate: null,
};

function sync(access: CanonicalAccessState): CanonicalBillingSync {
  return {
    billing: {
      premium: access.premium,
      productKey: access.premium ? 'pickle_sensei_pro_annual' : null,
      expiresAt: null,
      verifiedAt: '2026-09-01T00:00:00.000Z',
    },
    access,
  };
}

type Deps = {
  store: {
    configure: jest.Mock<Promise<void>, []>;
    loadPlans: jest.Mock<Promise<StorePlans>, []>;
    purchase: jest.Mock<Promise<StoreEntitlementState>, [string]>;
    restore: jest.Mock<Promise<StoreEntitlementState>, []>;
    readEntitlement: jest.Mock<Promise<StoreEntitlementState>, []>;
  };
  backend: {
    getAccess: jest.Mock<Promise<CanonicalAccessState>, []>;
    syncBilling: jest.Mock<Promise<CanonicalBillingSync>, []>;
  };
};

function deps(): Deps & BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn<Promise<StoreEntitlementState>, [string]>(
        async () => storeEntitlement,
      ),
      restore: jest.fn(async () => storeEntitlement),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(async () => exhausted),
      syncBilling: jest.fn(async () => sync(premium)),
    },
  };
}

const never = <T,>() => new Promise<T>(() => undefined);

function props(): PaywallScreenProps & {
  onClose: jest.Mock;
  onPurchased: jest.Mock;
} {
  return { onClose: jest.fn(), onPurchased: jest.fn() };
}

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

async function render(screenProps: PaywallScreenProps) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<PaywallScreen {...screenProps} />);
  });
  await flush();
  return renderer;
}

async function openPricing(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    byTestId(renderer, 'paywall-see-plans').props.onPress();
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

function byTestId(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.type === PressableScale &&
      n.props.testID === testID &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
}

function maybeByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  return renderer.root.findAll(
    n => n.type === PressableScale && n.props.testID === testID,
  );
}

function byLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n => n.type === PressableScale && n.props.accessibilityLabel === label,
  );
  if (!node) throw new Error(`No pressable labelled ${label}`);
  return node;
}

function progressBars(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    n => n.props.accessibilityRole === 'progressbar',
  );
}

afterEach(async () => {
  await act(async () => {
    clearAccessStoreConfiguration();
  });
});

describe('loading', () => {
  test('OBSERVED: while the access request hangs, pricing shows a spinner with NO retry; Continue disabled; only Close/Restore/Back remain', async () => {
    const d = deps();
    d.backend.getAccess.mockImplementation(() => never());
    d.store.loadPlans.mockImplementation(() => never());
    await act(async () => {
      configureAccessStore(d);
    });
    const renderer = await render(props());
    expect(useAccessStore.getState().status).toBe('loading');
    await openPricing(renderer);
    expect(progressBars(renderer).length).toBeGreaterThan(0);
    expect(allText(renderer)).toContain('Loading secure store pricing…');
    expect(maybeByTestId(renderer, 'paywall-retry')).toHaveLength(0);
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(
      byTestId(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe('Store pricing unavailable');
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(false);
    expect(
      byLabel(renderer, 'Close membership offer').props.onPress,
    ).toBeDefined();
    // Plans arrive but access never does: still loading, still no retry.
    await act(async () => {
      renderer.unmount();
    });
  });

  test('value page while loading uses the fail-closed "once your account is verified" allowance copy', async () => {
    const d = deps();
    d.backend.getAccess.mockImplementation(() => never());
    await act(async () => {
      configureAccessStore(d);
    });
    const renderer = await render(props());
    expect(allText(renderer)).toContain(
      'Two successful validated ratings are included once your account is verified.',
    );
    await act(async () => {
      renderer.unmount();
    });
  });
});

describe('backend error (fail closed)', () => {
  test('backend down + plans loaded: prices shown, Continue disabled, Try again visible, error copy visible', async () => {
    const d = deps();
    d.backend.getAccess.mockRejectedValue(
      new BillingError(
        'billing.backend_unavailable',
        'Membership verification is temporarily unavailable.',
        true,
      ),
    );
    await act(async () => {
      configureAccessStore(d);
    });
    const renderer = await render(props());
    await openPricing(renderer);
    const text = allText(renderer);
    expect(text).toContain('$59.99');
    expect(text).toContain(
      'Membership verification is temporarily unavailable.',
    );
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(
      byTestId(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe('Continue · $59.99/yr');
    expect(maybeByTestId(renderer, 'paywall-retry')).toHaveLength(1);
    // Retry recovers when the backend returns
    d.backend.getAccess.mockResolvedValue(exhausted);
    await act(async () => {
      byTestId(renderer, 'paywall-retry').props.onPress();
    });
    await flush();
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);
    expect(maybeByTestId(renderer, 'paywall-retry')).toHaveLength(0);
    await act(async () => {
      renderer.unmount();
    });
  });

  test('OBSERVED: a paid member whose refresh fails transiently is shown the purchase paywall (not the member page) until retry', async () => {
    const d = deps();
    d.backend.getAccess.mockResolvedValueOnce(premium);
    await act(async () => {
      configureAccessStore(d);
    });
    const renderer = await render(props());
    expect(allText(renderer)).toContain('MEMBERSHIP VERIFIED');
    d.backend.getAccess.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await useAccessStore.getState().refreshAccess();
    });
    await flush();
    const text = allText(renderer);
    expect(text).not.toContain('MEMBERSHIP VERIFIED');
    expect(text).toContain('See membership plans');
    await act(async () => {
      renderer.unmount();
    });
  });
});

describe('store error / empty offering', () => {
  test('store unavailable + backend ok: allowance copy intact, "Store pricing is unavailable", Continue disabled, Restore enabled', async () => {
    const d = deps();
    d.store.loadPlans.mockRejectedValue(
      new BillingError(
        'billing.offerings_unavailable',
        'Membership pricing is unavailable from the app store right now.',
        true,
      ),
    );
    d.backend.getAccess.mockResolvedValue(oneReserved);
    await act(async () => {
      configureAccessStore(d);
    });
    const renderer = await render(props());
    expect(allText(renderer)).toContain(
      '2 free ratings remain, but 1 capture is still being finalized.',
    );
    await openPricing(renderer);
    const text = allText(renderer);
    expect(text).toContain('Store pricing is unavailable');
    expect(text).not.toMatch(/\$\d/);
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(false);
    expect(maybeByTestId(renderer, 'paywall-retry')).toHaveLength(1);
    await act(async () => {
      renderer.unmount();
    });
  });

  test('offering with only lifetime: lifetime pre-selected, one-time-purchase legal line, no renewal copy', async () => {
    const d = deps();
    d.store.loadPlans.mockResolvedValue({
      offeringId: 'default',
      annual: null,
      monthly: null,
      lifetime: plans.lifetime,
    });
    await act(async () => {
      configureAccessStore(d);
    });
    const renderer = await render(props());
    await openPricing(renderer);
    const text = allText(renderer);
    expect(useAccessStore.getState().selectedPeriod).toBe('lifetime');
    expect(text).toContain(
      '$159.99 one-time purchase. Not a subscription — no renewal.',
    );
    expect(text).not.toContain('automatically renewing');
    expect(
      byTestId(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe('Continue · $159.99 once');
    await act(async () => {
      renderer.unmount();
    });
  });

  test('annual with a store-verified free trial: CTA "Start free trial" and legal line names the trial', async () => {
    const d = deps();
    d.store.loadPlans.mockResolvedValue({
      ...plans,
      annual: {
        ...plans.annual!,
        freeTrial: { label: '7-day free trial', periodIso8601: 'P7D' },
      },
    });
    await act(async () => {
      configureAccessStore(d);
    });
    const renderer = await render(props());
    await openPricing(renderer);
    const text = allText(renderer);
    expect(
      byTestId(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe('Start free trial');
    expect(text).toContain(
      'After the 7-day free trial, $59.99 per year, automatically renewing until canceled.',
    );
    await act(async () => {
      renderer.unmount();
    });
  });
});

describe('purchase outcomes on screen', () => {
  test('purchase verified premium → onPurchased once, member page rendered', async () => {
    const d = deps();
    await act(async () => {
      configureAccessStore(d);
    });
    const p = props();
    const renderer = await render(p);
    await openPricing(renderer);
    await act(async () => {
      byTestId(renderer, 'paywall-continue').props.onPress();
    });
    await flush();
    expect(p.onPurchased).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('MEMBERSHIP VERIFIED');
    await act(async () => {
      renderer.unmount();
    });
  });

  test('purchase completes at the store but the backend verification throws → error copy, onPurchased NOT called, Continue disabled until retry', async () => {
    const d = deps();
    d.backend.syncBilling.mockRejectedValueOnce(new Error('sync down'));
    await act(async () => {
      configureAccessStore(d);
    });
    const p = props();
    const renderer = await render(p);
    await openPricing(renderer);
    await act(async () => {
      byTestId(renderer, 'paywall-continue').props.onPress();
    });
    await flush();
    expect(p.onPurchased).not.toHaveBeenCalled();
    const text = allText(renderer);
    expect(text).toContain(
      'The store completed your purchase, but membership verification is still pending. Try Restore purchases.',
    );
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(maybeByTestId(renderer, 'paywall-retry')).toHaveLength(1);
    await act(async () => {
      renderer.unmount();
    });
  });

  test('restore with no membership → non-retryable message, allowance kept, onPurchased NOT called', async () => {
    const d = deps();
    d.backend.syncBilling.mockResolvedValueOnce(sync(exhausted));
    await act(async () => {
      configureAccessStore(d);
    });
    const p = props();
    const renderer = await render(p);
    await openPricing(renderer);
    await act(async () => {
      byTestId(renderer, 'paywall-restore').props.onPress();
    });
    await flush();
    expect(p.onPurchased).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain(
      'No active Pickle Sensei membership was found for this store account.',
    );
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);
    await act(async () => {
      renderer.unmount();
    });
  });
});

describe('copy compliance', () => {
  test('no forbidden terms on either page in any state', async () => {
    // Savings badges ("SAVE 37%") are price-derived from store data and
    // allowed; the rule forbids ACCURACY percentages and equivalence claims.
    const forbidden =
      /Android|Google Play|guest|Live Court|DUPR|SwingVision|PB Vision|Selkirk|JOOLA|accura|\d+\s?%\s*(accura|precise|correct)|AI coach|best (coach|app)|#1/i;
    const d = deps();
    await act(async () => {
      configureAccessStore(d);
    });
    const renderer = await render(props());
    expect(allText(renderer)).not.toMatch(forbidden);
    await openPricing(renderer);
    expect(allText(renderer)).not.toMatch(forbidden);
    await act(async () => {
      renderer.unmount();
    });
  });
});
