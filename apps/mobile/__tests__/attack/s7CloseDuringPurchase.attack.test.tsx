/**
 * ADVERSARIAL S7 (probe A) — close the paywall while a purchase is in
 * flight, unmount, then let the purchase + backend verification succeed.
 * `onPurchased` must NOT fire for an unmounted screen.
 *
 * Why it matters (RootNavigator.tsx:84-85): both `onClose` and `onPurchased`
 * are `navigation.goBack()`. A late `onPurchased` after the user already
 * closed the offer is a SECOND goBack — it pops the screen that opened the
 * paywall (e.g. Analyze) as well.
 *
 * Attack: PaywallScreen (pricing page) → Continue with store.purchase parked
 * → "Close membership offer" pressed while operation === 'purchasing' →
 * renderer.unmount() → purchase resolves → syncBilling resolves premium.
 *
 * `it.failing` encodes the EXPECTED contract: it passes today only because
 * the assertion fails (jest reports it as passing-while-failing) and will
 * flip red the moment the screen guards `onPurchased` — flip it to `it` then.
 * The companion `it` pins the OBSERVED behaviour so the count is on record.
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
import TestRenderer, { act } from 'react-test-renderer';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  CanonicalBillingSync,
  StorePlans,
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { PaywallScreen } from '../../src/screens/PaywallScreen';

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
};
const premiumSync: CanonicalBillingSync = {
  billing: {
    premium: true,
    productKey: 'pickle_sensei_pro_annual',
    expiresAt: '2099-01-01T00:00:00.000Z',
    verifiedAt: '2026-09-04T12:00:00.000Z',
  },
  access: premiumAccess,
};
const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'default:annual:$rc_annual:pickle_sensei_pro_annual',
    productId: 'pickle_sensei_pro_annual',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: null,
  lifetime: null,
};

interface Gate {
  release(): void;
  promise: Promise<void>;
}
function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>(r => (release = r));
  return { release, promise };
}

function deps(purchaseGate: Gate, syncGate: Gate): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async () => {
        await purchaseGate.promise;
        return {
          premium: true,
          productId: 'pickle_sensei_pro_annual',
          expirationDate: null,
        };
      }),
      restore: jest.fn(async () => {
        await purchaseGate.promise;
        return {
          premium: true,
          productId: 'pickle_sensei_pro_annual',
          expirationDate: null,
        };
      }),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(async () => freeAccess),
      syncBilling: jest.fn(async () => {
        await syncGate.promise;
        return premiumSync;
      }),
    },
  };
}

const flush = () =>
  act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });

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

/** Drives: mount → pricing → Continue (parked) → Close → unmount → resolve. */
async function closeMidPurchase(options: {
  via: 'paywall-continue' | 'paywall-restore';
}) {
  const purchaseGate = gate();
  const syncGate = gate();
  const dependencies = deps(purchaseGate, syncGate);
  configureAccessStore(dependencies);
  const onClose = jest.fn();
  const onPurchased = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PaywallScreen onClose={onClose} onPurchased={onPurchased} />,
    );
  });
  await flush();
  await act(async () => {
    pressable(renderer, 'paywall-see-plans').props.onPress();
  });
  await flush();

  await act(async () => {
    pressable(renderer, options.via).props.onPress();
  });
  await flush();
  const expectedOp =
    options.via === 'paywall-continue' ? 'purchasing' : 'restoring';
  expect(useAccessStore.getState().operation).toBe(expectedOp);

  const close = byLabel(renderer, 'Close membership offer');
  // The close control is NOT disabled while busy (Continue/Restore are).
  expect(close.props.disabled).toBeUndefined();
  await act(async () => {
    close.props.onPress();
  });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(useAccessStore.getState().operation).toBe(expectedOp);

  await act(async () => {
    renderer.unmount();
  });
  expect(onPurchased).not.toHaveBeenCalled();

  purchaseGate.release();
  await flush();
  syncGate.release();
  await flush();
  await flush();

  expect(dependencies.backend.syncBilling).toHaveBeenCalledTimes(1);
  expect(useAccessStore.getState().operation).toBe('idle');
  expect(useAccessStore.getState().canonicalAccess?.premium).toBe(true);
  return { onClose, onPurchased };
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

describe('S7 close + unmount during a pending purchase', () => {
  it.failing(
    'EXPECTED (currently BROKEN): onPurchased is not called after the paywall was closed and unmounted',
    async () => {
      const { onPurchased } = await closeMidPurchase({
        via: 'paywall-continue',
      });
      expect(onPurchased).not.toHaveBeenCalled();
    },
  );

  it('OBSERVED on 4d812e1a: onPurchased fires once after unmount → with RootNavigator wiring that is a 2nd goBack()', async () => {
    const { onClose, onPurchased } = await closeMidPurchase({
      via: 'paywall-continue',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPurchased).toHaveBeenCalledTimes(1);
    // Order on record: close first, then the late purchased callback.
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
      onPurchased.mock.invocationCallOrder[0] ?? Number.NaN,
    );
  });

  it.failing(
    'EXPECTED (currently BROKEN): same contract for Restore purchases',
    async () => {
      const { onPurchased } = await closeMidPurchase({
        via: 'paywall-restore',
      });
      expect(onPurchased).not.toHaveBeenCalled();
    },
  );

  it('OBSERVED on 4d812e1a: Restore path also fires onPurchased after unmount', async () => {
    const { onPurchased } = await closeMidPurchase({ via: 'paywall-restore' });
    expect(onPurchased).toHaveBeenCalledTimes(1);
  });

  it('HELD: sign-out (clearAccessStoreConfiguration) during the pending purchase suppresses the late callback', async () => {
    const purchaseGate = gate();
    const syncGate = gate();
    const dependencies = deps(purchaseGate, syncGate);
    configureAccessStore(dependencies);
    const onPurchased = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <PaywallScreen onClose={jest.fn()} onPurchased={onPurchased} />,
      );
    });
    await flush();
    await act(async () => {
      pressable(renderer, 'paywall-see-plans').props.onPress();
    });
    await flush();
    await act(async () => {
      pressable(renderer, 'paywall-continue').props.onPress();
    });
    await flush();
    await act(async () => {
      clearAccessStoreConfiguration(); // configurationVersion bump
    });
    await act(async () => {
      renderer.unmount();
    });
    purchaseGate.release();
    syncGate.release();
    await flush();
    await flush();
    expect(onPurchased).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
  });

  it('HELD: while purchasing, Continue and Restore are disabled and a 2nd Continue press is a no-op (purchase ×1)', async () => {
    const purchaseGate = gate();
    const syncGate = gate();
    const dependencies = deps(purchaseGate, syncGate);
    configureAccessStore(dependencies);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<PaywallScreen onClose={jest.fn()} />);
    });
    await flush();
    await act(async () => {
      pressable(renderer, 'paywall-see-plans').props.onPress();
    });
    await flush();
    const continueButton = pressable(renderer, 'paywall-continue');
    await act(async () => {
      continueButton.props.onPress();
      continueButton.props.onPress(); // queued double-tap before re-render
      continueButton.props.onPress();
    });
    await flush();
    expect(dependencies.store.purchase).toHaveBeenCalledTimes(1);
    expect(pressable(renderer, 'paywall-continue').props.disabled).toBe(true);
    expect(pressable(renderer, 'paywall-restore').props.disabled).toBe(true);
    await act(async () => {
      pressable(renderer, 'paywall-restore').props.onPress(); // disabled, but call the handler anyway
    });
    expect(dependencies.store.restore).not.toHaveBeenCalled();
    purchaseGate.release();
    syncGate.release();
    await flush();
    await flush();
    await act(async () => {
      renderer.unmount();
    });
  });
});
