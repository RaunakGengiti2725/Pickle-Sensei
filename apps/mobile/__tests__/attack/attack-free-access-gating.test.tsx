/**
 * ADVERSARIAL PASS 3 — mobile-billing-paywall (S5).
 *
 * store.configure() FAILS (RevenueCat cannot start) while the canonical
 * backend says one free rating can still be reserved. The free allowance is
 * server-authoritative: the PremiumTabBar camera/import actions must open
 * Analyze (never the Paywall), and Settings must word the ledger from the
 * server ("1 free rating left"). Runs the REAL access store and REAL auth
 * store under both screens.
 */
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  const AnimatedView = (props: Record<string, unknown>) =>
    React.createElement(View, props);
  return {
    __esModule: true,
    default: {
      View: AnimatedView,
      createAnimatedComponent:
        (Component: React.ComponentType<Record<string, unknown>>) =>
        (props: Record<string, unknown>) =>
          React.createElement(Component, props),
    },
    Easing: { out: (fn: unknown) => fn, cubic: () => 0 },
    interpolate: () => 0,
    useAnimatedStyle: (updater: () => object) => updater(),
    useSharedValue: (init: unknown) => ({ value: init }),
    withTiming: (toValue: unknown) => toValue,
  };
});
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => insets,
    initialWindowMetrics: null,
  };
});
jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));
const mockSettingsNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockSettingsNavigate }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => callback(), [callback]);
  },
}));

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';
import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useConsentStore } from '../../src/state/consentStore';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import {
  BillingError,
  type BillingAccessDependencies,
  type CanonicalAccessState,
} from '../../src/billing';

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

function freeAccess(
  used: number,
  reserved = 0,
  premium = false,
): CanonicalAccessState {
  const remaining = 2 - used;
  const availableToReserve = remaining - reserved;
  const canStartRating = premium || availableToReserve > 0;
  return {
    premium,
    entitlements: premium ? ['premium'] : [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

type Deps = BillingAccessDependencies & {
  store: { configure: jest.Mock; loadPlans: jest.Mock };
  backend: { getAccess: jest.Mock };
};

function storeDownDeps(
  getAccess: () => Promise<CanonicalAccessState>,
  configureError: unknown = new BillingError(
    'billing.unconfigured',
    'RevenueCat could not start in this build.',
    false,
  ),
): Deps {
  return {
    store: {
      configure: jest.fn(async () => {
        throw configureError;
      }),
      loadPlans: jest.fn(async () => {
        throw new Error('loadPlans must not run when configure failed');
      }),
      purchase: jest.fn(),
      restore: jest.fn(),
      readEntitlement: jest.fn(),
    },
    backend: { getAccess: jest.fn(getAccess), syncBilling: jest.fn() },
  };
}

const mockRootNavigate = jest.fn();
const mockTabNavigate = jest.fn();
const mockEmit = jest.fn(() => ({ defaultPrevented: false }));

function tabBarProps(): BottomTabBarProps {
  return {
    state: {
      index: 0,
      routes: [
        { key: 'Home-1', name: 'Home' },
        { key: 'Library-1', name: 'Library' },
        { key: 'Add-1', name: 'Add' },
        { key: 'Performance-1', name: 'Performance' },
        { key: 'Settings-1', name: 'Settings' },
      ],
    },
    navigation: {
      emit: mockEmit,
      navigate: mockTabNavigate,
      getParent: () => ({ navigate: mockRootNavigate }),
    },
    descriptors: {},
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  } as unknown as BottomTabBarProps;
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  mounted.push(renderer);
  return renderer;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labeled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
}

async function settleTabBarClose() {
  await act(async () => {
    jest.advanceTimersByTime(400);
  });
}

function membershipValue(renderer: TestRenderer.ReactTestRenderer): string {
  const rows = renderer.root.findAll(
    node =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Pickle Sensei Pro, ') &&
      typeof node.props.onPress === 'function',
  );
  expect(rows.length).toBeGreaterThan(0);
  return String(rows[0]!.props.accessibilityLabel).replace(
    'Pickle Sensei Pro, ',
    '',
  );
}

beforeEach(() => {
  act(() => clearAccessStoreConfiguration());
  useAuthStore.setState({ session: syncedSession });
  useConsentStore.setState({
    availability: 'signed_out',
    modelTrainingActive: false,
    hydrate: jest.fn(() => Promise.resolve()),
  });
  mockRootNavigate.mockClear();
  mockTabNavigate.mockClear();
  mockSettingsNavigate.mockClear();
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) act(() => renderer.unmount());
  jest.useRealTimers();
});

describe('S5 — store.configure() fails, server grants 1 reservable free rating', () => {
  it('initialize() keeps the free allowance and marks the store unconfigured (plans null, loadPlans never attempted)', async () => {
    const clients = storeDownDeps(async () => freeAccess(1));
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    const state = useAccessStore.getState();
    expect(state.status).toBe('unconfigured');
    expect(state.plans).toBeNull();
    expect(state.canonicalAccess).toEqual(freeAccess(1));
    expect(state.canonicalAccess?.canStartRating).toBe(true);
    expect(state.error?.code).toBe('billing.unconfigured');
    expect(clients.store.loadPlans).not.toHaveBeenCalled();
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
  });

  it('PremiumTabBar camera and import open Analyze — never the Paywall — after the store failed to configure', async () => {
    jest.useFakeTimers();
    const clients = storeDownDeps(async () => freeAccess(1));
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    const bar = render(<PremiumTabBar {...tabBarProps()} />);
    await pressByLabel(bar, 'Open coach actions');
    await pressByLabel(bar, 'Auto Analyze');
    await settleTabBarClose();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenLastCalledWith('Analyze', {
      source: 'camera',
    });

    await pressByLabel(bar, 'Open coach actions');
    await pressByLabel(bar, 'Import Video');
    await settleTabBarClose();
    expect(mockRootNavigate).toHaveBeenCalledTimes(2);
    expect(mockRootNavigate).toHaveBeenLastCalledWith('Analyze', {
      source: 'library',
    });
    expect(
      mockRootNavigate.mock.calls.filter(([route]) => route === 'Paywall'),
    ).toHaveLength(0);
  });

  it('the SAME store failure with the allowance used up routes to the Paywall (the gate is the server ledger, not the store)', async () => {
    jest.useFakeTimers();
    const clients = storeDownDeps(async () => freeAccess(2));
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().status).toBe('unconfigured');

    const bar = render(<PremiumTabBar {...tabBarProps()} />);
    await pressByLabel(bar, 'Open coach actions');
    await pressByLabel(bar, 'Auto Analyze');
    await settleTabBarClose();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenLastCalledWith('Paywall', {
      source: 'rating',
    });
  });

  it('camera pressed BEFORE initialize() settles (status loading, no snapshot) is not paywalled', async () => {
    jest.useFakeTimers();
    let resolveAccess!: (value: CanonicalAccessState) => void;
    const clients = storeDownDeps(
      () =>
        new Promise<CanonicalAccessState>(resolve => {
          resolveAccess = resolve;
        }),
    );
    configureAccessStore(clients);
    const init = useAccessStore.getState().initialize();
    await flush();
    expect(useAccessStore.getState().status).toBe('loading');

    const bar = render(<PremiumTabBar {...tabBarProps()} />);
    await pressByLabel(bar, 'Open coach actions');
    await pressByLabel(bar, 'Auto Analyze');
    await settleTabBarClose();
    // Analyze's route gate decides once the ledger lands; the tab bar must
    // not pre-empt it with a Paywall.
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenLastCalledWith('Analyze', {
      source: 'camera',
    });
    resolveAccess(freeAccess(1));
    await init;
    expect(useAccessStore.getState().canonicalAccess?.canStartRating).toBe(
      true,
    );
  });

  it('a local-only guest is sent to ConnectAccount regardless of store or ledger', async () => {
    jest.useFakeTimers();
    const clients = storeDownDeps(async () => freeAccess(1));
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    useAuthStore.setState({
      session: {
        provider: 'guest',
        subject: 'local-only',
        canonicalAppUserId: null,
        localOnly: true,
        displayName: null,
        email: null,
      },
    });
    const bar = render(<PremiumTabBar {...tabBarProps()} />);
    await pressByLabel(bar, 'Open coach actions');
    await pressByLabel(bar, 'Auto Analyze');
    await settleTabBarClose();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenLastCalledWith('ConnectAccount');
  });

  it('Settings shows exactly "1 free rating left" after the store failed to configure', async () => {
    const clients = storeDownDeps(async () => freeAccess(1));
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().status).toBe('unconfigured');

    const settings = render(<SettingsScreen />);
    await flush();
    // initialize() + the focus re-read.
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(2);
    expect(membershipValue(settings)).toBe('1 free rating left');
    // The focus re-read never re-attempts store configuration.
    expect(clients.store.configure).toHaveBeenCalledTimes(1);
    expect(clients.store.loadPlans).not.toHaveBeenCalled();
    // refreshAccess() reports the ledger as ready; the store stays unusable
    // (plans null) so the Paywall would show its Retry, not a purchase.
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().plans).toBeNull();
  });

  it('Settings wording follows availableToReserve, not remaining, when the store is down', async () => {
    // remaining 1 but reserved 1: nothing can be started.
    const clients = storeDownDeps(async () => freeAccess(1, 1));
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    const settings = render(<SettingsScreen />);
    await flush();
    expect(membershipValue(settings)).toBe('Upgrade required');
  });

  it('Settings and the tab bar agree when the ledger flips between visits (1 left → used up)', async () => {
    jest.useFakeTimers();
    let ledger = freeAccess(1);
    const clients = storeDownDeps(async () => ledger);
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();

    const settings = render(<SettingsScreen />);
    await flush();
    expect(membershipValue(settings)).toBe('1 free rating left');

    // The second rating scores elsewhere and syncs; Settings is re-focused.
    ledger = freeAccess(2);
    act(() => settings.unmount());
    mounted.splice(mounted.indexOf(settings), 1);
    const settingsAgain = render(<SettingsScreen />);
    await flush();
    expect(membershipValue(settingsAgain)).toBe('Upgrade required');

    const bar = render(<PremiumTabBar {...tabBarProps()} />);
    await pressByLabel(bar, 'Open coach actions');
    await pressByLabel(bar, 'Auto Analyze');
    await settleTabBarClose();
    expect(mockRootNavigate).toHaveBeenLastCalledWith('Paywall', {
      source: 'rating',
    });
  });

  it('a non-BillingError configure() rejection (native throw / unicode / huge message) is contained the same way', async () => {
    const weird = new Error(`${'🥒'.repeat(4096)} \u0000 ${'x'.repeat(65536)}`);
    const clients = storeDownDeps(async () => freeAccess(1), weird);
    configureAccessStore(clients);
    await useAccessStore.getState().initialize();
    const state = useAccessStore.getState();
    expect(state.status).toBe('unconfigured');
    expect(state.error?.code).toBe('billing.unconfigured');
    expect(state.canonicalAccess?.canStartRating).toBe(true);
    // The user-facing message is the store's canned copy, not the raw throw.
    expect(state.error?.message).toBe(
      'RevenueCat could not start in this build.',
    );
  });
});
