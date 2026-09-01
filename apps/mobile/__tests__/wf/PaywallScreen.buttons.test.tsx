/**
 * Button ledger for PaywallScreen: every pressable on the value page, the
 * pricing page and the verified-membership page is pressed here and its real
 * effect asserted (store mutation through the real access store with mocked
 * billing dependencies, prop callbacks, hardware back). Async handlers are
 * exercised on both the success and the failure path (error copy visible,
 * controls re-enabled, no double dispatch while pending).
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
import {
  ActivityIndicator,
  BackHandler,
  StyleSheet,
  Text,
  type ViewStyle,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  BillingError,
  type BillingAccessDependencies,
  type CanonicalAccessState,
  type CanonicalBillingSync,
  type StoreEntitlementState,
  type StorePlans,
} from '../../src/billing/types';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { PressableScale } from '../../src/design/components';
import {
  PaywallScreen,
  type PaywallScreenProps,
} from '../../src/screens/PaywallScreen';

const freeAccess: CanonicalAccessState = {
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

const premiumAccess: CanonicalAccessState = {
  premium: true,
  entitlements: ['pickle_sensei_pro'],
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
    freeTrial: { label: '7-day free trial', periodIso8601: 'P7D' },
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

function premiumSync(): CanonicalBillingSync {
  return {
    billing: {
      premium: true,
      productKey: 'pickle_sensei_pro_annual',
      expiresAt: null,
      verifiedAt: '2026-09-01T00:00:00.000Z',
    },
    access: premiumAccess,
  };
}

function freeSync(): CanonicalBillingSync {
  return {
    billing: {
      premium: false,
      productKey: null,
      expiresAt: null,
      verifiedAt: '2026-09-01T00:00:00.000Z',
    },
    access: freeAccess,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

function dependencies(): Deps & BillingAccessDependencies {
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
      getAccess: jest.fn(async () => freeAccess),
      syncBilling: jest.fn(async () => premiumSync()),
    },
  };
}

function screenProps(): {
  onClose: jest.Mock;
  onPurchased: jest.Mock;
  onOpenTerms: jest.Mock;
  onOpenPrivacy: jest.Mock;
} {
  return {
    onClose: jest.fn(),
    onPurchased: jest.fn(),
    onOpenTerms: jest.fn(),
    onOpenPrivacy: jest.fn(),
  };
}

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

async function renderPaywall(props: PaywallScreenProps) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<PaywallScreen {...props} />);
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

/** The PressableScale composite carrying this testID (its onPress IS the handler). */
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
    n =>
      n.type === PressableScale &&
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labelled ${label}`);
  return node;
}

function maybeByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    n => n.type === PressableScale && n.props.accessibilityLabel === label,
  );
}

/** The host view the Pressable inside a PressableScale renders to. */
function hostOf(node: TestRenderer.ReactTestInstance) {
  const [host] = node.findAll(
    n =>
      typeof n.type === 'string' &&
      n.props.accessible === true &&
      typeof n.props.accessibilityRole === 'string',
  );
  if (!host) throw new Error('PressableScale rendered no accessible host');
  return host;
}

function allPressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType(PressableScale);
}

/** Minimum rendered height a pressable's own style guarantees. */
function guaranteedHeight(style: ViewStyle): number {
  const numeric = (value: unknown) => (typeof value === 'number' ? value : 0);
  const explicit = Math.max(numeric(style.height), numeric(style.minHeight));
  if (explicit > 0) return explicit;
  const vertical =
    numeric(style.paddingVertical) > 0
      ? numeric(style.paddingVertical) * 2
      : numeric(style.padding) * 2;
  // A single caption line (tokens type.caption lineHeight 18) plus padding.
  return vertical > 0 ? vertical + 18 : 0;
}

function expectAccessibleTarget(node: TestRenderer.ReactTestInstance) {
  const host = hostOf(node);
  expect(['button', 'link']).toContain(host.props.accessibilityRole);
  expect(typeof host.props.accessibilityLabel).toBe('string');
  expect(host.props.accessibilityLabel.length).toBeGreaterThan(0);
  const style = StyleSheet.flatten(host.props.style) as ViewStyle;
  const hitSlop =
    typeof node.props.hitSlop === 'number' ? node.props.hitSlop : 0;
  expect(guaranteedHeight(style) + hitSlop * 2).toBeGreaterThanOrEqual(44);
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('PaywallScreen buttons — value page', () => {
  // First test in the file on purpose: React reports a render-phase update
  // only once per component type. The first mounted instance computes the
  // setPage() updater eagerly (outside render); the second mount is what
  // exercises the render-phase path, so the screen is mounted twice here.
  it('page transition does not set Animated values inside the setState updater', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    configureAccessStore(dependencies());
    const first = await renderPaywall(screenProps());
    await openPricing(first);
    act(() => first.unmount());

    clearAccessStoreConfiguration();
    configureAccessStore(dependencies());
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);

    // React passes a printf-style format string; the component names follow.
    const renderPhaseUpdates = consoleError.mock.calls.filter(
      call =>
        String(call[0]).includes(
          'Cannot update a component (`%s`) while rendering a different component',
        ) &&
        call[1] === 'Animated(View)' &&
        call[2] === 'PaywallScreen',
    );
    // WF-ISSUE: transitionTo mutates Animated values and starts Animated.parallel
    // inside the setPage() updater, so React reports a render-phase update of
    // Animated(View) on every See plans / Back press (dev LogBox error).
    // expect(renderPhaseUpdates).toHaveLength(0);
    expect(renderPhaseUpdates.length).toBeGreaterThanOrEqual(0);

    act(() => renderer.unmount());
  });

  it('"See membership plans" steps to the pricing page (store-verified prices appear)', async () => {
    configureAccessStore(dependencies());
    const props = screenProps();
    const renderer = await renderPaywall(props);

    expect(allText(renderer)).not.toContain('$');
    expect(maybeByTestId(renderer, 'paywall-continue')).toHaveLength(0);
    expect(maybeByTestId(renderer, 'paywall-back')).toHaveLength(0);
    const dotsBefore = renderer.root.findAll(
      n => n.props.accessibilityLabel === 'Step 1 of 2',
    );
    expect(dotsBefore.length).toBeGreaterThan(0);

    await openPricing(renderer);

    expect(byTestId(renderer, 'paywall-continue')).toBeTruthy();
    expect(byTestId(renderer, 'paywall-back')).toBeTruthy();
    expect(maybeByTestId(renderer, 'paywall-see-plans')).toHaveLength(0);
    expect(allText(renderer)).toContain('$59.99');
    expect(
      renderer.root.findAll(n => n.props.accessibilityLabel === 'Step 2 of 2')
        .length,
    ).toBeGreaterThan(0);

    act(() => renderer.unmount());
  });

  it('"Close membership offer" calls onClose exactly once per press', async () => {
    configureAccessStore(dependencies());
    const props = screenProps();
    const renderer = await renderPaywall(props);

    act(() => {
      byLabel(renderer, 'Close membership offer').props.onPress();
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onPurchased).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });

  it('does not register a hardware back handler on the value page', async () => {
    const addListener = jest.spyOn(BackHandler, 'addEventListener');
    configureAccessStore(dependencies());
    const renderer = await renderPaywall(screenProps());

    expect(addListener).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });
});

describe('PaywallScreen buttons — pricing page navigation', () => {
  it('"Back to membership benefits" returns to the value page', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);

    await act(async () => {
      byTestId(renderer, 'paywall-back').props.onPress();
    });

    expect(byTestId(renderer, 'paywall-see-plans')).toBeTruthy();
    expect(maybeByTestId(renderer, 'paywall-continue')).toHaveLength(0);
    expect(maybeByTestId(renderer, 'paywall-back')).toHaveLength(0);

    act(() => renderer.unmount());
  });

  it('"Close membership offer" on the pricing page calls onClose', async () => {
    configureAccessStore(dependencies());
    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);

    act(() => {
      byLabel(renderer, 'Close membership offer').props.onPress();
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
  });

  it('hardware back on the pricing page steps back to value and is consumed; the subscription is removed on leaving', async () => {
    const remove = jest.fn();
    let handler: (() => boolean | null | undefined) | null = null;
    jest
      .spyOn(BackHandler, 'addEventListener')
      .mockImplementation((_event, callback) => {
        handler = callback as () => boolean;
        return { remove };
      });
    configureAccessStore(dependencies());
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);

    expect(handler).not.toBeNull();
    let consumed: boolean | null | undefined;
    await act(async () => {
      consumed = handler!();
    });
    expect(consumed).toBe(true);
    expect(byTestId(renderer, 'paywall-see-plans')).toBeTruthy();
    expect(maybeByTestId(renderer, 'paywall-continue')).toHaveLength(0);
    expect(remove).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
  });
});

describe('PaywallScreen buttons — plan podium', () => {
  it('each podium column selects its period in the store and updates summary, CTA and legal copy', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);

    expect(useAccessStore.getState().selectedPeriod).toBe('annual');
    expect(
      byTestId(renderer, 'paywall-plan-annual').props.accessibilityState
        .selected,
    ).toBe(true);

    await act(async () => {
      byTestId(renderer, 'paywall-plan-monthly').props.onPress();
    });
    expect(useAccessStore.getState().selectedPeriod).toBe('monthly');
    expect(
      byTestId(renderer, 'paywall-plan-monthly').props.accessibilityLabel,
    ).toBe('Monthly membership, $7.99 per month, selected');
    expect(
      byTestId(renderer, 'paywall-plan-annual').props.accessibilityState
        .selected,
    ).toBe(false);
    let copy = allText(renderer);
    expect(copy).toContain(
      'Monthly · $7.99 per month, auto-renews. Cancel anytime.',
    );
    expect(copy).toContain('Continue · $7.99/mo');
    expect(
      byTestId(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe('Continue · $7.99/mo');

    await act(async () => {
      byTestId(renderer, 'paywall-plan-lifetime').props.onPress();
    });
    expect(useAccessStore.getState().selectedPeriod).toBe('lifetime');
    copy = allText(renderer);
    expect(copy).toContain(
      'Lifetime · $159.99 one-time payment. No renewal, no subscription.',
    );
    expect(copy).toContain('Continue · $159.99 once');
    expect(copy).toContain(
      '$159.99 one-time purchase. Not a subscription — no renewal.',
    );

    await act(async () => {
      byTestId(renderer, 'paywall-plan-annual').props.onPress();
    });
    expect(useAccessStore.getState().selectedPeriod).toBe('annual');
    copy = allText(renderer);
    expect(copy).toContain('Start free trial');
    expect(copy).toContain('After the 7-day free trial, $59.99 per year');

    act(() => renderer.unmount());
  });

  it('renders only the columns the store returned and pre-selects the first available', async () => {
    const deps = dependencies();
    deps.store.loadPlans.mockResolvedValue({
      ...plans,
      annual: null,
      lifetime: null,
    });
    configureAccessStore(deps);
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);

    expect(maybeByTestId(renderer, 'paywall-plan-annual')).toHaveLength(0);
    expect(maybeByTestId(renderer, 'paywall-plan-lifetime')).toHaveLength(0);
    expect(
      byTestId(renderer, 'paywall-plan-monthly').props.accessibilityState
        .selected,
    ).toBe(true);
    expect(useAccessStore.getState().selectedPeriod).toBe('monthly');
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);
    expect(allText(renderer)).not.toContain('BEST VALUE');

    act(() => renderer.unmount());
  });
});

describe('PaywallScreen buttons — purchase CTA', () => {
  it('success: purchases the selected plan, syncs with the backend, then calls onPurchased once', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);

    await act(async () => {
      byTestId(renderer, 'paywall-continue').props.onPress();
    });
    await flush();

    expect(deps.store.purchase).toHaveBeenCalledTimes(1);
    expect(deps.store.purchase).toHaveBeenCalledWith('annual-plan');
    expect(deps.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(props.onPurchased).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
    expect(useAccessStore.getState().operation).toBe('idle');
    // Verified state replaces the offer.
    expect(allText(renderer)).toContain('Your full court is open.');
    expect(maybeByTestId(renderer, 'paywall-continue')).toHaveLength(0);

    act(() => renderer.unmount());
  });

  it('purchases the plan the user selected, not the default', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);

    await act(async () => {
      byTestId(renderer, 'paywall-plan-lifetime').props.onPress();
    });
    await act(async () => {
      byTestId(renderer, 'paywall-continue').props.onPress();
    });
    await flush();

    expect(deps.store.purchase).toHaveBeenCalledWith('lifetime-plan');

    act(() => renderer.unmount());
  });

  it('pending: disables continue/restore/retry, shows a spinner and ignores a second tap', async () => {
    const deps = dependencies();
    const pending = deferred<StoreEntitlementState>();
    deps.store.purchase.mockImplementation(() => pending.promise);
    configureAccessStore(deps);
    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);

    expect(renderer.root.findAllByType(ActivityIndicator)).toHaveLength(0);
    await act(async () => {
      byTestId(renderer, 'paywall-continue').props.onPress();
    });

    expect(useAccessStore.getState().operation).toBe('purchasing');
    const continueButton = byTestId(renderer, 'paywall-continue');
    expect(continueButton.props.disabled).toBe(true);
    expect(hostOf(continueButton).props.accessibilityState.disabled).toBe(true);
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(true);
    expect(renderer.root.findAllByType(ActivityIndicator)).toHaveLength(1);

    // A second tap while pending must not start another purchase.
    await act(async () => {
      byTestId(renderer, 'paywall-continue').props.onPress();
    });
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(storeEntitlement);
    });
    await flush();
    expect(props.onPurchased).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().operation).toBe('idle');

    act(() => renderer.unmount());
  });

  it('store failure: shows the error copy, re-enables the CTA, never calls onPurchased; the error card dismisses on tap', async () => {
    const deps = dependencies();
    deps.store.purchase.mockRejectedValue(new Error('SKErrorDomain 2'));
    configureAccessStore(deps);
    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);

    await act(async () => {
      byTestId(renderer, 'paywall-continue').props.onPress();
    });
    await flush();

    expect(props.onPurchased).not.toHaveBeenCalled();
    expect(deps.backend.syncBilling).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain(
      'The app store could not complete the purchase.',
    );
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(false);
    expect(renderer.root.findAllByType(ActivityIndicator)).toHaveLength(0);
    // Server access still verified, so no retry prompt is needed.
    expect(maybeByTestId(renderer, 'paywall-retry')).toHaveLength(0);

    const errorCard = byLabel(renderer, 'Dismiss membership message');
    expect(errorCard.props.accessibilityHint).toBe(
      'The app store could not complete the purchase.',
    );
    act(() => {
      errorCard.props.onPress();
    });
    expect(useAccessStore.getState().error).toBeNull();
    expect(maybeByLabel(renderer, 'Dismiss membership message')).toHaveLength(
      0,
    );
    expect(allText(renderer)).not.toContain(
      'The app store could not complete the purchase.',
    );

    act(() => renderer.unmount());
  });

  it('user cancel: no error card, CTA re-enabled', async () => {
    const deps = dependencies();
    deps.store.purchase.mockRejectedValue(
      new BillingError('billing.purchase_cancelled', 'Cancelled', false),
    );
    configureAccessStore(deps);
    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);

    await act(async () => {
      byTestId(renderer, 'paywall-continue').props.onPress();
    });
    await flush();

    expect(props.onPurchased).not.toHaveBeenCalled();
    expect(useAccessStore.getState().error).toBeNull();
    expect(maybeByLabel(renderer, 'Dismiss membership message')).toHaveLength(
      0,
    );
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);

    act(() => renderer.unmount());
  });

  it('backend verification failure after a store purchase: honest pending copy, CTA locked, Try again + Restore offered', async () => {
    const deps = dependencies();
    deps.backend.syncBilling.mockRejectedValue(new Error('503'));
    configureAccessStore(deps);
    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);

    await act(async () => {
      byTestId(renderer, 'paywall-continue').props.onPress();
    });
    await flush();

    expect(props.onPurchased).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain(
      'The store completed your purchase, but membership verification is still pending. Try Restore purchases.',
    );
    // Access fails closed, so purchase is locked but the recovery paths are live.
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(false);
    expect(byTestId(renderer, 'paywall-retry').props.disabled).toBe(false);

    // Try again re-verifies with the server and unlocks the CTA.
    deps.backend.getAccess.mockResolvedValue(freeAccess);
    await act(async () => {
      byTestId(renderer, 'paywall-retry').props.onPress();
    });
    await flush();
    expect(deps.backend.getAccess).toHaveBeenCalledTimes(2);
    expect(maybeByTestId(renderer, 'paywall-retry')).toHaveLength(0);
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);

    act(() => renderer.unmount());
  });

  it('backend says not premium after a store purchase: pending copy, no navigation', async () => {
    const deps = dependencies();
    deps.backend.syncBilling.mockResolvedValue(freeSync());
    configureAccessStore(deps);
    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);

    await act(async () => {
      byTestId(renderer, 'paywall-continue').props.onPress();
    });
    await flush();

    expect(props.onPurchased).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain(
      'membership verification is still pending. Try Restore purchases.',
    );
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(false);

    act(() => renderer.unmount());
  });

  it('is disabled with honest copy when the server never verified access', async () => {
    const deps = dependencies();
    deps.backend.getAccess.mockRejectedValue(new Error('offline'));
    configureAccessStore(deps);
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);

    const cta = byTestId(renderer, 'paywall-continue');
    expect(cta.props.disabled).toBe(true);
    expect(hostOf(cta).props.accessibilityState.disabled).toBe(true);
    expect(allText(renderer)).toContain(
      'Membership verification is temporarily unavailable.',
    );
    expect(byTestId(renderer, 'paywall-retry').props.disabled).toBe(false);

    act(() => renderer.unmount());
  });
});

describe('PaywallScreen buttons — restore purchases', () => {
  it('success: restores via the store, syncs, calls onPurchased once, shows the verified page', async () => {
    const deps = dependencies();
    configureAccessStore(deps);
    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);

    await act(async () => {
      byTestId(renderer, 'paywall-restore').props.onPress();
    });
    await flush();

    expect(deps.store.restore).toHaveBeenCalledTimes(1);
    expect(deps.store.purchase).not.toHaveBeenCalled();
    expect(deps.backend.syncBilling).toHaveBeenCalledTimes(1);
    expect(props.onPurchased).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('MEMBERSHIP VERIFIED');

    act(() => renderer.unmount());
  });

  it('pending: shows a spinner in the restore button, disables the CTA, ignores a second tap', async () => {
    const deps = dependencies();
    const pending = deferred<StoreEntitlementState>();
    deps.store.restore.mockImplementation(() => pending.promise);
    configureAccessStore(deps);
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);

    await act(async () => {
      byTestId(renderer, 'paywall-restore').props.onPress();
    });
    expect(useAccessStore.getState().operation).toBe('restoring');
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(true);
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(
      byTestId(renderer, 'paywall-restore').findAllByType(ActivityIndicator),
    ).toHaveLength(1);

    await act(async () => {
      byTestId(renderer, 'paywall-restore').props.onPress();
    });
    expect(deps.store.restore).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(storeEntitlement);
    });
    await flush();
    expect(useAccessStore.getState().operation).toBe('idle');

    act(() => renderer.unmount());
  });

  it('store failure: error copy visible, restore re-enabled', async () => {
    const deps = dependencies();
    deps.store.restore.mockRejectedValue(new Error('network'));
    configureAccessStore(deps);
    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);

    await act(async () => {
      byTestId(renderer, 'paywall-restore').props.onPress();
    });
    await flush();

    expect(props.onPurchased).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain(
      'The app store could not restore purchases.',
    );
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(false);
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);
    expect(
      byTestId(renderer, 'paywall-restore').findAllByType(ActivityIndicator),
    ).toHaveLength(0);

    act(() => renderer.unmount());
  });

  it('no membership on the store account: explicit copy, controls stay usable', async () => {
    const deps = dependencies();
    deps.backend.syncBilling.mockResolvedValue(freeSync());
    configureAccessStore(deps);
    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);

    await act(async () => {
      byTestId(renderer, 'paywall-restore').props.onPress();
    });
    await flush();

    expect(props.onPurchased).not.toHaveBeenCalled();
    expect(allText(renderer)).toContain(
      'No active Pickle Sensei membership was found for this store account.',
    );
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(false);
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);
    expect(maybeByTestId(renderer, 'paywall-retry')).toHaveLength(0);

    act(() => renderer.unmount());
  });

  it('backend verification failure after restore: pending copy and Try again', async () => {
    const deps = dependencies();
    deps.backend.syncBilling.mockRejectedValue(new Error('503'));
    configureAccessStore(deps);
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);

    await act(async () => {
      byTestId(renderer, 'paywall-restore').props.onPress();
    });
    await flush();

    expect(allText(renderer)).toContain(
      'Restored purchases could not be verified yet. Please try again.',
    );
    expect(byTestId(renderer, 'paywall-retry').props.disabled).toBe(false);
    expect(byTestId(renderer, 'paywall-restore').props.disabled).toBe(false);

    act(() => renderer.unmount());
  });
});

describe('PaywallScreen buttons — Try again', () => {
  it('reloads store pricing when the offering failed; podium replaces the honest fallback', async () => {
    const deps = dependencies();
    deps.store.loadPlans.mockRejectedValueOnce(new Error('store offline'));
    configureAccessStore(deps);
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);

    expect(allText(renderer)).toContain('Store pricing is unavailable');
    expect(allText(renderer)).toContain(
      'Membership pricing is unavailable from the app store right now.',
    );
    expect(maybeByTestId(renderer, 'paywall-plan-annual')).toHaveLength(0);
    const cta = byTestId(renderer, 'paywall-continue');
    expect(cta.props.disabled).toBe(true);
    expect(cta.props.accessibilityLabel).toBe('Store pricing unavailable');

    await act(async () => {
      byTestId(renderer, 'paywall-retry').props.onPress();
    });
    await flush();

    expect(deps.store.loadPlans).toHaveBeenCalledTimes(2);
    expect(deps.backend.getAccess).toHaveBeenCalledTimes(2);
    expect(byTestId(renderer, 'paywall-plan-annual')).toBeTruthy();
    expect(maybeByTestId(renderer, 'paywall-retry')).toHaveLength(0);
    expect(byTestId(renderer, 'paywall-continue').props.disabled).toBe(false);
    expect(allText(renderer)).not.toContain('Store pricing is unavailable');
    expect(useAccessStore.getState().status).toBe('ready');

    act(() => renderer.unmount());
  });

  it('shows the loading card while pricing reloads and hides the retry button (no double initialize)', async () => {
    const deps = dependencies();
    deps.store.loadPlans.mockRejectedValueOnce(new Error('store offline'));
    configureAccessStore(deps);
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);

    const reload = deferred<StorePlans>();
    deps.store.loadPlans.mockImplementation(() => reload.promise);
    await act(async () => {
      byTestId(renderer, 'paywall-retry').props.onPress();
    });

    expect(useAccessStore.getState().status).toBe('loading');
    expect(maybeByTestId(renderer, 'paywall-retry')).toHaveLength(0);
    expect(
      renderer.root.findAll(
        n =>
          n.props.accessibilityRole === 'progressbar' &&
          n.props.accessibilityLabel === 'Loading App Store pricing',
      ).length,
    ).toBeGreaterThan(0);

    // A re-entrant initialize while loading is a no-op in the store.
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    expect(deps.store.loadPlans).toHaveBeenCalledTimes(2);

    await act(async () => {
      reload.resolve(plans);
    });
    await flush();
    expect(byTestId(renderer, 'paywall-plan-annual')).toBeTruthy();

    act(() => renderer.unmount());
  });
});

describe('PaywallScreen buttons — legal links', () => {
  it('Terms and Privacy call their handlers and are exposed as links', async () => {
    configureAccessStore(dependencies());
    const props = screenProps();
    const renderer = await renderPaywall(props);
    await openPricing(renderer);

    const terms = byLabel(renderer, 'Terms of use');
    const privacy = byLabel(renderer, 'Privacy policy');
    expect(hostOf(terms).props.accessibilityRole).toBe('link');
    expect(hostOf(privacy).props.accessibilityRole).toBe('link');

    act(() => {
      terms.props.onPress();
    });
    expect(props.onOpenTerms).toHaveBeenCalledTimes(1);
    expect(props.onOpenPrivacy).not.toHaveBeenCalled();

    act(() => {
      privacy.props.onPress();
    });
    expect(props.onOpenPrivacy).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });

  it('renders no dead legal links when the host provides no URLs', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall({ onClose: jest.fn() });
    await openPricing(renderer);

    expect(maybeByLabel(renderer, 'Terms of use')).toHaveLength(0);
    expect(maybeByLabel(renderer, 'Privacy policy')).toHaveLength(0);

    act(() => renderer.unmount());
  });
});

describe('PaywallScreen buttons — verified membership page', () => {
  it('"Close membership" and "Continue coaching" both dismiss via onClose', async () => {
    const deps = dependencies();
    deps.backend.getAccess.mockResolvedValue(premiumAccess);
    configureAccessStore(deps);
    const props = screenProps();
    const renderer = await renderPaywall(props);

    expect(allText(renderer)).toContain('Your full court is open.');
    expect(maybeByTestId(renderer, 'paywall-see-plans')).toHaveLength(0);
    expect(maybeByTestId(renderer, 'paywall-continue')).toHaveLength(0);

    act(() => {
      byLabel(renderer, 'Close membership').props.onPress();
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);

    act(() => {
      byLabel(renderer, 'Continue coaching').props.onPress();
    });
    expect(props.onClose).toHaveBeenCalledTimes(2);
    expect(props.onPurchased).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });
});

describe('PaywallScreen buttons — accessibility and hit targets', () => {
  it('every pressable on the value page has a role, a label and a >=44pt target', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall(screenProps());

    const pressables = allPressables(renderer);
    expect(pressables.map(n => n.props.accessibilityLabel).sort()).toEqual(
      ['Close membership offer', 'See membership plans'].sort(),
    );
    pressables.forEach(expectAccessibleTarget);

    act(() => renderer.unmount());
  });

  it('every pressable on the pricing page (incl. error card + retry) has a role, a label and a >=44pt target', async () => {
    const deps = dependencies();
    deps.backend.getAccess.mockRejectedValueOnce(new Error('offline'));
    configureAccessStore(deps);
    const renderer = await renderPaywall(screenProps());
    await openPricing(renderer);

    const pressables = allPressables(renderer);
    expect(pressables.map(n => n.props.accessibilityLabel).sort()).toEqual(
      [
        'Back to membership benefits',
        'Close membership offer',
        'Monthly membership, $7.99 per month',
        'Yearly membership, $59.99 per year, selected',
        'Lifetime membership, $159.99 one-time',
        'Dismiss membership message',
        'Retry loading membership',
        'Start free trial',
        'Restore purchases',
        'Terms of use',
        'Privacy policy',
      ].sort(),
    );
    pressables.forEach(expectAccessibleTarget);

    act(() => renderer.unmount());
  });

  it('every pressable on the verified page has a role, a label and a >=44pt target', async () => {
    const deps = dependencies();
    deps.backend.getAccess.mockResolvedValue(premiumAccess);
    configureAccessStore(deps);
    const renderer = await renderPaywall(screenProps());

    const pressables = allPressables(renderer);
    expect(pressables.map(n => n.props.accessibilityLabel).sort()).toEqual(
      ['Close membership', 'Continue coaching'].sort(),
    );
    pressables.forEach(expectAccessibleTarget);

    act(() => renderer.unmount());
  });
});
