/**
 * COACH action portal (PremiumTabBar center button) driven as a user would:
 * open, cancel via backdrop / overlay button / re-tap, and every action —
 * including the access branches behind Auto Analyze and Import Video
 * (local-only session, free allowance, exhausted allowance, backend failure,
 * unconfigured billing) — against the REAL access store with fake billing
 * clients. Tab buttons are asserted for role/selected state and navigation.
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
}));

const mockAuthState = {
  session: { localOnly: false } as { localOnly: boolean },
};
jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: { getState: () => mockAuthState },
}));

import React from 'react';
import { Modal, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  StorePlans,
} from '../../src/billing/types';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';
import { hasWalkthroughTarget } from '../../src/walkthrough/targets';

const mockRootNavigate = jest.fn();
const mockTabNavigate = jest.fn();
const mockEmit = jest.fn(() => ({ defaultPrevented: false }));

const freeAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 0,
    reserved: 0,
    remaining: 2,
    availableToReserve: 2,
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

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual',
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

function billing(
  getAccess: () => Promise<CanonicalAccessState>,
): BillingAccessDependencies {
  return {
    store: {
      configure: async () => undefined,
      loadPlans: async () => plans,
      purchase: async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      }),
      restore: async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      }),
      readEntitlement: async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      }),
    },
    backend: {
      getAccess,
      syncBilling: async () => {
        throw new Error('not used');
      },
    },
  };
}

function makeProps(focusedIndex = 0): BottomTabBarProps {
  return {
    state: {
      index: focusedIndex,
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

function renderBar(focusedIndex = 0) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <PremiumTabBar {...makeProps(focusedIndex)} />,
    );
  });
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function pressables(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
  which = 0,
) {
  const node = pressables(renderer, label)[which];
  if (!node) throw new Error(`No pressable labeled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
}

function menuVisible(renderer: TestRenderer.ReactTestRenderer): boolean {
  return renderer.root.findByType(Modal).props.visible === true;
}

async function flushCloseAnimation() {
  await act(async () => {
    jest.advanceTimersByTime(400);
  });
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('COACH portal — open and cancel', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRootNavigate.mockClear();
    mockTabNavigate.mockClear();
    mockEmit.mockClear();
    mockAuthState.session = { localOnly: false };
    clearAccessStoreConfiguration();
  });
  afterEach(() => {
    jest.useRealTimers();
    clearAccessStoreConfiguration();
  });

  it('center button is a labeled, expandable button that registers the walkthrough anchor', () => {
    const renderer = renderBar();
    const [fab] = pressables(renderer, 'Open coach actions');
    expect(fab).toBeDefined();
    expect(fab!.props.accessibilityRole).toBe('button');
    expect(fab!.props.accessibilityState).toEqual({ expanded: false });
    expect(menuVisible(renderer)).toBe(false);
    expect(allText(renderer)).toContain('COACH');
    expect(hasWalkthroughTarget('coach-fab')).toBe(true);
    expect(hasWalkthroughTarget('tab-library')).toBe(true);
    expect(hasWalkthroughTarget('tab-progress')).toBe(true);
    act(() => renderer.unmount());
    expect(hasWalkthroughTarget('coach-fab')).toBe(false);
  });

  it('opens the menu with exactly three labeled actions and hints', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    expect(menuVisible(renderer)).toBe(true);
    const [fab] = pressables(renderer, 'Close coach actions');
    expect(fab!.props.accessibilityState).toEqual({ expanded: true });
    for (const [title, detail] of [
      ['Auto Analyze', 'Auto capture · validated scores only'],
      ['Import Video', 'Choose a real clip from this phone'],
      ['Drill Library', 'Guided drills you can search'],
    ]) {
      const [row] = pressables(renderer, title!);
      expect(row).toBeDefined();
      expect(row!.props.accessibilityRole).toBe('button');
      expect(row!.props.accessibilityHint).toBe(detail);
    }
    expect(allText(renderer)).not.toContain('Live Court');
    act(() => renderer.unmount());
  });

  it('backdrop tap cancels without navigating', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    // Backdrop scrim + the overlay copy of the Coach button both close.
    expect(
      pressables(renderer, 'Close coach actions').length,
    ).toBeGreaterThanOrEqual(2);
    await pressByLabel(renderer, 'Close coach actions', 1);
    await flushCloseAnimation();
    expect(menuVisible(renderer)).toBe(false);
    expect(mockRootNavigate).not.toHaveBeenCalled();
    expect(mockTabNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('re-tapping the center button closes and hardware back closes too', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Close coach actions', 0);
    await flushCloseAnimation();
    expect(menuVisible(renderer)).toBe(false);

    await pressByLabel(renderer, 'Open coach actions');
    await act(async () => {
      renderer.root.findByType(Modal).props.onRequestClose();
    });
    await flushCloseAnimation();
    expect(menuVisible(renderer)).toBe(false);
    expect(mockRootNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('reopening during the close animation cancels the pending close', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Close coach actions', 0);
    await pressByLabel(renderer, 'Open coach actions');
    await flushCloseAnimation();
    expect(menuVisible(renderer)).toBe(true);
    act(() => renderer.unmount());
  });

  it('unmounting mid-close never fires the deferred action', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Drill Library');
    act(() => renderer.unmount());
    await flushCloseAnimation();
    expect(mockRootNavigate).not.toHaveBeenCalled();
  });
});

describe('COACH portal — actions', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRootNavigate.mockClear();
    mockTabNavigate.mockClear();
    mockEmit.mockClear();
    mockAuthState.session = { localOnly: false };
    clearAccessStoreConfiguration();
  });
  afterEach(() => {
    jest.useRealTimers();
    clearAccessStoreConfiguration();
  });

  it('Drill Library navigates once, after the close animation, and closes the menu', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Drill Library');
    expect(mockRootNavigate).not.toHaveBeenCalled();
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('DrillLibrary');
    expect(menuVisible(renderer)).toBe(false);
    act(() => renderer.unmount());
  });

  it('double-tapping an action navigates exactly once', async () => {
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    const [row] = pressables(renderer, 'Drill Library');
    await act(async () => {
      row!.props.onPress();
      row!.props.onPress();
    });
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('Auto Analyze / Import Video route a local-only session to ConnectAccount without touching billing', async () => {
    mockAuthState.session = { localOnly: true };
    const getAccess = jest.fn(async () => freeAccess);
    configureAccessStore(billing(getAccess));
    const renderer = renderBar();

    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Auto Analyze');
    await flushCloseAnimation();
    await flushMicrotasks();
    expect(mockRootNavigate).toHaveBeenCalledWith('ConnectAccount');

    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Import Video');
    await flushCloseAnimation();
    await flushMicrotasks();
    expect(mockRootNavigate).toHaveBeenCalledTimes(2);
    expect(mockRootNavigate).toHaveBeenLastCalledWith('ConnectAccount');
    expect(getAccess).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('Auto Analyze with a free allowance initializes access once and opens Analyze(camera)', async () => {
    const getAccess = jest.fn(async () => freeAccess);
    configureAccessStore(billing(getAccess));
    expect(useAccessStore.getState().canonicalAccess).toBeNull();
    const renderer = renderBar();

    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Auto Analyze');
    await flushCloseAnimation();
    await flushMicrotasks();
    expect(getAccess).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().status).toBe('ready');
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });

    // Second use reuses the cached access — no second network round trip.
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Import Video');
    await flushCloseAnimation();
    await flushMicrotasks();
    expect(getAccess).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenLastCalledWith('Analyze', {
      source: 'library',
    });
    act(() => renderer.unmount());
  });

  it('exhausted free allowance routes to Paywall(rating)', async () => {
    configureAccessStore(billing(async () => exhaustedAccess));
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Import Video');
    await flushCloseAnimation();
    await flushMicrotasks();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Paywall', {
      source: 'rating',
    });
    act(() => renderer.unmount());
  });

  it('access backend failure fails closed to the Paywall (never a silent no-op, never Analyze)', async () => {
    configureAccessStore(
      billing(async () => {
        throw new Error('offline');
      }),
    );
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Auto Analyze');
    await flushCloseAnimation();
    await flushMicrotasks();
    expect(useAccessStore.getState().status).toBe('error');
    expect(useAccessStore.getState().error?.message).toBe(
      'Membership verification is temporarily unavailable.',
    );
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Paywall', {
      source: 'rating',
    });
    act(() => renderer.unmount());
  });

  it('unconfigured billing (no clients) still resolves to the Paywall instead of hanging', async () => {
    clearAccessStoreConfiguration();
    const renderer = renderBar();
    await pressByLabel(renderer, 'Open coach actions');
    await pressByLabel(renderer, 'Auto Analyze');
    await flushCloseAnimation();
    await flushMicrotasks();
    expect(useAccessStore.getState().status).toBe('unconfigured');
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Paywall', {
      source: 'rating',
    });
    act(() => renderer.unmount());
  });
});

describe('COACH portal — regular tabs', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRootNavigate.mockClear();
    mockTabNavigate.mockClear();
    mockEmit.mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('tabs expose role=tab with the focused one selected and navigate on press', async () => {
    const renderer = renderBar(0);
    const tabs = renderer.root.findAll(
      n =>
        n.props.accessibilityRole === 'tab' &&
        typeof n.props.onPress === 'function',
    );
    expect(tabs.map(t => t.props.accessibilityLabel)).toEqual([
      'Home',
      'Library',
      'Progress',
      'Settings',
    ]);
    expect(tabs[0]!.props.accessibilityState).toEqual({ selected: true });
    expect(tabs[1]!.props.accessibilityState).toEqual({ selected: false });

    await pressByLabel(renderer, 'Library');
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tabPress', target: 'Library-1' }),
    );
    expect(mockTabNavigate).toHaveBeenCalledWith('Library', undefined);

    // Pressing the already-focused tab emits tabPress but does not re-navigate.
    await pressByLabel(renderer, 'Home');
    expect(mockTabNavigate).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('a prevented tabPress does not navigate', async () => {
    mockEmit.mockReturnValueOnce({ defaultPrevented: true });
    const renderer = renderBar(0);
    await pressByLabel(renderer, 'Settings');
    expect(mockTabNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
