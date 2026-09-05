/**
 * Round-2 UI-level adversarial reproductions for MBP-1 through the paywall's
 * "Continue" (purchaseSelected) button — the path the original cluster names
 * (Settings useFocusEffect → refreshAccess() → Membership → purchase).
 *
 * Every assertion is the EXPECTED behaviour: the screen the user sees after
 * the App Store sheet closes must be the one the backend verified, no matter
 * when the older GET /v1/me/access settles, and how (success or failure).
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
  StorePlans,
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectCanStartRating,
  selectHasPremium,
  selectPaywallRequired,
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

const paidAccess: CanonicalAccessState = {
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
    productId: 'pickle_sensei_pro_yearly',
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
  lifetime: null,
};

const syncedPaid = {
  billing: {
    premium: true,
    productKey: 'pickle_sensei_pro_yearly',
    expiresAt: '2027-09-04T00:00:00.000Z',
    verifiedAt: '2026-09-04T00:00:00.000Z',
  },
  access: paidAccess,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () =>
  act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });

function dependencies(): BillingAccessDependencies {
  const entitlement = {
    premium: true,
    productId: 'pickle_sensei_pro_yearly',
    expirationDate: '2027-09-04T00:00:00.000Z',
  };
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async () => entitlement),
      restore: jest.fn(async () => entitlement),
      readEntitlement: jest.fn(async () => entitlement),
    },
    backend: {
      getAccess: jest.fn(async () => freeAccess),
      syncBilling: jest.fn(async () => syncedPaid),
    },
  };
}

/** Fires refreshAccess() the way a Settings focus / Analyze unmount would. */
function startRefresh(): Promise<boolean> {
  let read!: Promise<boolean>;
  act(() => {
    read = useAccessStore.getState().refreshAccess();
  });
  return read;
}

function pressable(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
}

function hasLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return (
    renderer.root.findAll(n => n.props.accessibilityLabel === label).length > 0
  );
}

function screenState(renderer: TestRenderer.ReactTestRenderer) {
  const state = useAccessStore.getState();
  return {
    canonicalAccess: state.canonicalAccess,
    status: state.status,
    premium: selectHasPremium(state),
    canStartRating: selectCanStartRating(state),
    paywallRequired: selectPaywallRequired(state),
    membershipVerifiedScreen: hasLabel(renderer, 'Continue coaching'),
    errorCode: state.error?.code ?? null,
  };
}

const premiumScreen = {
  canonicalAccess: paidAccess,
  status: 'ready',
  premium: true,
  canStartRating: true,
  paywallRequired: false,
  membershipVerifiedScreen: true,
  errorCode: null,
};

/** Paywall opened from Settings → Membership with plans + free access loaded. */
async function openPaywall(clients: BillingAccessDependencies) {
  configureAccessStore(clients);
  await useAccessStore.getState().initialize();
  expect(useAccessStore.getState().plans).toEqual(plans);
  expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess);

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
  return { renderer, onPurchased };
}

beforeEach(() => {
  clearAccessStoreConfiguration();
});

it('Settings focus refresh stalls, user taps Continue and the backend verifies premium: the stale GET SUCCESS must not revert the verified screen', async () => {
  const clients = dependencies();
  const { renderer, onPurchased } = await openPaywall(clients);

  // Settings useFocusEffect fired refreshAccess() just before Membership
  // opened; the GET is on a slow link.
  const stalledGet = deferred<CanonicalAccessState>();
  (clients.backend.getAccess as jest.Mock).mockImplementationOnce(
    () => stalledGet.promise,
  );
  const staleRefresh = startRefresh();
  await flush();
  expect(useAccessStore.getState().status).toBe('loading');

  const cta = pressable(renderer, 'paywall-continue');
  expect(cta.props.disabled).toBe(false);
  await act(async () => {
    cta.props.onPress();
  });
  await flush();
  expect(onPurchased).toHaveBeenCalledTimes(1);
  expect(screenState(renderer)).toEqual(premiumScreen);

  stalledGet.resolve(freeAccess);
  await expect(staleRefresh).resolves.toBe(true);
  await flush();
  expect(screenState(renderer)).toEqual(premiumScreen);
  act(() => renderer.unmount());
});

it('Settings focus refresh stalls, user taps Continue and the backend verifies premium: the stale GET FAILURE must not fail-close the verified screen', async () => {
  const clients = dependencies();
  const { renderer, onPurchased } = await openPaywall(clients);

  const stalledGet = deferred<CanonicalAccessState>();
  (clients.backend.getAccess as jest.Mock).mockImplementationOnce(
    () => stalledGet.promise,
  );
  const staleRefresh = startRefresh();
  await flush();

  await act(async () => {
    pressable(renderer, 'paywall-continue').props.onPress();
  });
  await flush();
  expect(onPurchased).toHaveBeenCalledTimes(1);
  expect(screenState(renderer)).toEqual(premiumScreen);

  stalledGet.reject(new Error('request timed out'));
  await expect(staleRefresh).resolves.toBe(true);
  await flush();
  expect(screenState(renderer)).toEqual(premiumScreen);
  act(() => renderer.unmount());
});

it('Continue whose backend sync FAILS is the newest operation: a stale GET that saw premium must not flip the paywall to the verified screen', async () => {
  const clients = dependencies();
  const { renderer, onPurchased } = await openPaywall(clients);
  (clients.backend.syncBilling as jest.Mock).mockRejectedValueOnce(
    new Error('502 bad gateway'),
  );

  const stalledGet = deferred<CanonicalAccessState>();
  (clients.backend.getAccess as jest.Mock).mockImplementationOnce(
    () => stalledGet.promise,
  );
  const staleRefresh = startRefresh();
  await flush();

  await act(async () => {
    pressable(renderer, 'paywall-continue').props.onPress();
  });
  await flush();
  expect(onPurchased).not.toHaveBeenCalled();
  const failedClosed = screenState(renderer);
  expect(failedClosed).toMatchObject({
    canonicalAccess: null,
    status: 'error',
    premium: false,
    paywallRequired: true,
    membershipVerifiedScreen: false,
    errorCode: 'billing.backend_verification_pending',
  });

  stalledGet.resolve(paidAccess);
  await expect(staleRefresh).resolves.toBe(false);
  await flush();
  expect(screenState(renderer)).toEqual(failedClosed);
  act(() => renderer.unmount());
});

it('Two Settings visits (two stalled GETs) bracket the purchase: neither the pre-purchase read nor the pre-commit read reverts the verified screen; a post-commit read applies', async () => {
  const clients = dependencies();
  const { renderer, onPurchased } = await openPaywall(clients);

  const g1 = deferred<CanonicalAccessState>();
  const g2 = deferred<CanonicalAccessState>();
  const g3 = deferred<CanonicalAccessState>();
  const stalledSync = deferred<typeof syncedPaid>();
  (clients.backend.getAccess as jest.Mock)
    .mockImplementationOnce(() => g1.promise)
    .mockImplementationOnce(() => g2.promise)
    .mockImplementationOnce(() => g3.promise);
  (clients.backend.syncBilling as jest.Mock).mockImplementationOnce(
    () => stalledSync.promise,
  );

  const r1 = startRefresh();
  await flush();
  await act(async () => {
    pressable(renderer, 'paywall-continue').props.onPress();
  });
  await flush();
  expect(useAccessStore.getState().operation).toBe('purchasing');
  // AnalyzeScreen-style unmount refresh is not gated on status.
  const r2 = startRefresh();
  await flush();

  stalledSync.resolve(syncedPaid);
  await flush();
  expect(onPurchased).toHaveBeenCalledTimes(1);
  expect(screenState(renderer)).toEqual(premiumScreen);

  g2.resolve(freeAccess);
  g1.resolve(freeAccess);
  await expect(Promise.all([r1, r2])).resolves.toEqual([true, true]);
  await flush();
  expect(screenState(renderer)).toEqual(premiumScreen);

  // A read issued AFTER the commit is newer than the commit and applies.
  const r3 = startRefresh();
  await flush();
  await act(async () => {
    g3.resolve(freeAccess);
    await expect(r3).resolves.toBe(true);
  });
  await flush();
  expect(screenState(renderer)).toMatchObject({
    canonicalAccess: freeAccess,
    premium: false,
    membershipVerifiedScreen: false,
  });
  act(() => renderer.unmount());
});
