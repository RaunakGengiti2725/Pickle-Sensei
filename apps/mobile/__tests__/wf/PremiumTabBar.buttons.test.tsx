/**
 * Button ledger for `src/navigation/PremiumTabBar.tsx`.
 *
 * Every pressable the tab bar renders — the four tab items (press + long
 * press), the in-bar Coach FAB, the overlay Coach FAB, the backdrop, the
 * Modal's hardware-back handler and the three coach action rows — is pressed
 * here through `props.onPress()` and its real observable effect is asserted:
 * the tab navigator `emit`/`navigate` calls, the root-stack `navigate` calls
 * (route + params), the access-store `initialize()` call and the menu
 * open/close state.
 */
// The official react-native-reanimated/mock pulls in react-native-worklets'
// native initializers, which cannot load under jest; this minimal manual
// mock covers exactly the APIs the tab bar uses.
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
    Easing: {
      out: (fn: unknown) => fn,
      cubic: () => 0,
    },
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
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 12, left: 0, right: 0 }),
}));

// Mutable store doubles: the tab bar reads both stores lazily through
// getState() inside the capture actions, so each test shapes them directly.
const mockAccessState: {
  status: string;
  canonicalAccess: { canStartRating: boolean } | null;
  initialize: jest.Mock<Promise<void>, []>;
} = {
  status: 'idle',
  canonicalAccess: { canStartRating: true },
  initialize: jest.fn(async () => {}),
};
const mockAuthState: { session: { localOnly: boolean } | null } = {
  session: { localOnly: false },
};
jest.mock('../../src/state/accessStore', () => ({
  useAccessStore: { getState: () => mockAccessState },
}));
jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: { getState: () => mockAuthState },
}));

import React from 'react';
import { Modal, Pressable } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';

const mockRootNavigate = jest.fn();
const mockTabNavigate = jest.fn();
const mockEmit = jest.fn((): { defaultPrevented: boolean } => ({
  defaultPrevented: false,
}));

const ROUTES = [
  { key: 'Home-1', name: 'Home' },
  { key: 'Library-1', name: 'Library' },
  { key: 'Add-1', name: 'Add' },
  { key: 'Performance-1', name: 'Performance', params: { focus: 'x' } },
  { key: 'Settings-1', name: 'Settings' },
];

function makeProps(
  overrides: { index?: number; parent?: unknown } = {},
): BottomTabBarProps {
  return {
    state: { index: overrides.index ?? 0, routes: ROUTES },
    navigation: {
      emit: mockEmit,
      navigate: mockTabNavigate,
      getParent: () =>
        'parent' in overrides
          ? overrides.parent
          : { navigate: mockRootNavigate },
    },
    descriptors: {},
    insets: { top: 0, bottom: 12, left: 0, right: 0 },
  } as unknown as BottomTabBarProps;
}

function renderBar(overrides?: { index?: number; parent?: unknown }) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<PremiumTabBar {...makeProps(overrides)} />);
  });
  return renderer;
}

// react-test-renderer matches the component INSIDE React.memo, not the memo
// wrapper `Pressable` itself exports.
const PressableInner = (Pressable as unknown as { type: React.ComponentType })
  .type;

function pressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType(PressableInner);
}

function findByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const nodes = pressables(renderer).filter(
    n => n.props.accessibilityLabel === label,
  );
  if (nodes.length === 0) throw new Error(`No pressable labeled ${label}`);
  return nodes;
}

async function press(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
  which = 0,
) {
  const node = findByLabel(renderer, label)[which];
  if (!node) throw new Error(`No pressable #${which} labeled ${label}`);
  expect(typeof node.props.onPress).toBe('function');
  await act(async () => {
    node.props.onPress();
  });
}

function modal(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType(Modal);
}

async function flushCloseAnimation() {
  await act(async () => {
    jest.advanceTimersByTime(400);
  });
}

async function openMenu(renderer: TestRenderer.ReactTestRenderer) {
  await press(renderer, 'Open coach actions');
  expect(modal(renderer).props.visible).toBe(true);
}

describe('PremiumTabBar button ledger', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRootNavigate.mockClear();
    mockTabNavigate.mockClear();
    mockEmit.mockClear();
    mockEmit.mockImplementation(() => ({ defaultPrevented: false }));
    mockAccessState.status = 'idle';
    mockAccessState.canonicalAccess = { canStartRating: true };
    mockAccessState.initialize = jest.fn(async () => {});
    mockAuthState.session = { localOnly: false };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('enumeration', () => {
    it('renders exactly four tab items plus the Coach FAB in the bar, all wired and labelled', () => {
      const renderer = renderBar();
      const bar = pressables(renderer);
      expect(bar).toHaveLength(5);
      for (const node of bar) {
        expect(typeof node.props.onPress).toBe('function');
        expect(typeof node.props.accessibilityLabel).toBe('string');
        expect(node.props.accessibilityRole).toBeDefined();
      }
      const tabs = bar.filter(n => n.props.accessibilityRole === 'tab');
      expect(tabs.map(n => n.props.accessibilityLabel)).toEqual([
        'Home',
        'Library',
        'Progress',
        'Settings',
      ]);
      for (const tab of tabs) {
        expect(typeof tab.props.onLongPress).toBe('function');
      }
      const fab = findByLabel(renderer, 'Open coach actions');
      expect(fab).toHaveLength(1);
      expect(fab[0]?.props.accessibilityRole).toBe('button');
      expect(fab[0]?.props.accessibilityState).toEqual({ expanded: false });
      // The menu is not mounted until the FAB is pressed.
      expect(modal(renderer).props.visible).toBe(false);
      act(() => renderer.unmount());
    });

    it('renders the overlay FAB, the backdrop and three action rows once the menu is open', async () => {
      const renderer = renderBar();
      await openMenu(renderer);
      const all = pressables(renderer);
      // 5 bar pressables + backdrop + 3 rows + overlay FAB.
      expect(all).toHaveLength(10);
      for (const node of all) {
        expect(typeof node.props.onPress).toBe('function');
        expect(typeof node.props.accessibilityLabel).toBe('string');
      }
      const rows = all.filter(n => n.props.accessibilityRole === 'button');
      expect(rows.map(n => n.props.accessibilityLabel)).toEqual([
        'Close coach actions',
        'Auto Analyze',
        'Import Video',
        'Drill Library',
        'Close coach actions',
      ]);
      // Both FAB copies report the expanded state while open.
      const closeButtons = findByLabel(renderer, 'Close coach actions');
      expect(closeButtons).toHaveLength(3);
      const backdrop = closeButtons.find(
        n => n.props.accessibilityRole === undefined,
      );
      expect(backdrop).toBeDefined();
      // WF-ISSUE: Backdrop dismiss pressable has no accessibilityRole
      // expect(backdrop?.props.accessibilityRole).toBe('button');
      for (const fab of closeButtons.filter(
        n => n.props.accessibilityRole === 'button',
      )) {
        expect(fab.props.accessibilityState).toEqual({ expanded: true });
      }
      // Tab hit targets clear 44pt.
      for (const tab of all.filter(n => n.props.accessibilityRole === 'tab')) {
        const style = tab.props.style({ pressed: false });
        const flat = Object.assign({}, ...style.filter(Boolean));
        expect(flat.minHeight).toBeGreaterThanOrEqual(44);
      }
      act(() => renderer.unmount());
    });
  });

  describe('tab items', () => {
    it.each([
      ['Library', 'Library-1', 'Library', undefined],
      ['Progress', 'Performance-1', 'Performance', { focus: 'x' }],
      ['Settings', 'Settings-1', 'Settings', undefined],
    ])(
      '%s -> emits tabPress for its route key then navigates with the route params',
      async (label, key, routeName, params) => {
        const renderer = renderBar({ index: 0 });
        await press(renderer, label);
        expect(mockEmit).toHaveBeenCalledWith({
          type: 'tabPress',
          target: key,
          canPreventDefault: true,
        });
        expect(mockTabNavigate).toHaveBeenCalledTimes(1);
        expect(mockTabNavigate).toHaveBeenCalledWith(routeName, params);
        expect(mockRootNavigate).not.toHaveBeenCalled();
        act(() => renderer.unmount());
      },
    );

    it('Home -> pressing the focused tab emits tabPress but does not re-navigate', async () => {
      const renderer = renderBar({ index: 0 });
      const [home] = findByLabel(renderer, 'Home');
      expect(home?.props.accessibilityState).toEqual({ selected: true });
      await press(renderer, 'Home');
      expect(mockEmit).toHaveBeenCalledWith({
        type: 'tabPress',
        target: 'Home-1',
        canPreventDefault: true,
      });
      expect(mockTabNavigate).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('marks only the focused route as selected', () => {
      const renderer = renderBar({ index: 3 });
      const selected = pressables(renderer)
        .filter(n => n.props.accessibilityRole === 'tab')
        .filter(n => n.props.accessibilityState?.selected === true)
        .map(n => n.props.accessibilityLabel);
      expect(selected).toEqual(['Progress']);
      act(() => renderer.unmount());
    });

    it('honours a listener that prevents the default tabPress', async () => {
      mockEmit.mockImplementation(() => ({ defaultPrevented: true }));
      const renderer = renderBar({ index: 0 });
      await press(renderer, 'Settings');
      expect(mockEmit).toHaveBeenCalledTimes(1);
      expect(mockTabNavigate).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it.each([
      ['Home', 'Home-1'],
      ['Library', 'Library-1'],
      ['Progress', 'Performance-1'],
      ['Settings', 'Settings-1'],
    ])('%s long press -> emits tabLongPress for %s', async (label, key) => {
      const renderer = renderBar();
      const [tab] = findByLabel(renderer, label);
      await act(async () => {
        tab?.props.onLongPress();
      });
      expect(mockEmit).toHaveBeenCalledTimes(1);
      expect(mockEmit).toHaveBeenCalledWith({
        type: 'tabLongPress',
        target: key,
      });
      expect(mockTabNavigate).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });
  });

  describe('Coach FAB and menu dismissal', () => {
    it('in-bar FAB -> opens the menu and flips its label/expanded state', async () => {
      const renderer = renderBar();
      await openMenu(renderer);
      const inBar = pressables(renderer)[2];
      expect(inBar?.props.accessibilityLabel).toBe('Close coach actions');
      expect(inBar?.props.accessibilityState).toEqual({ expanded: true });
      act(() => renderer.unmount());
    });

    it('in-bar FAB (open) -> closes the menu after the exit animation', async () => {
      const renderer = renderBar();
      await openMenu(renderer);
      await press(renderer, 'Close coach actions', 0);
      // The Modal stays mounted during the fade so the rows can animate out…
      expect(modal(renderer).props.visible).toBe(true);
      expect(pressables(renderer)[2]?.props.accessibilityLabel).toBe(
        'Open coach actions',
      );
      await flushCloseAnimation();
      // …then unmounts, restoring the resting FAB.
      expect(modal(renderer).props.visible).toBe(false);
      expect(pressables(renderer)).toHaveLength(5);
      expect(mockRootNavigate).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('backdrop -> closes the menu without navigating', async () => {
      const renderer = renderBar();
      await openMenu(renderer);
      const backdrop = findByLabel(renderer, 'Close coach actions').find(
        n => n.props.accessibilityRole === undefined,
      );
      await act(async () => {
        backdrop?.props.onPress();
      });
      await flushCloseAnimation();
      expect(modal(renderer).props.visible).toBe(false);
      expect(mockRootNavigate).not.toHaveBeenCalled();
      expect(mockTabNavigate).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('overlay FAB -> closes the menu without navigating', async () => {
      const renderer = renderBar();
      await openMenu(renderer);
      const overlayFab = findByLabel(renderer, 'Close coach actions').filter(
        n => n.props.accessibilityRole === 'button',
      )[1];
      expect(overlayFab).toBeDefined();
      await act(async () => {
        overlayFab?.props.onPress();
      });
      await flushCloseAnimation();
      expect(modal(renderer).props.visible).toBe(false);
      expect(mockRootNavigate).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('Modal onRequestClose (hardware back) -> closes the menu', async () => {
      const renderer = renderBar();
      await openMenu(renderer);
      await act(async () => {
        modal(renderer).props.onRequestClose();
      });
      await flushCloseAnimation();
      expect(modal(renderer).props.visible).toBe(false);
      act(() => renderer.unmount());
    });

    it('re-opening during the exit animation cancels the pending close', async () => {
      const renderer = renderBar();
      await openMenu(renderer);
      await press(renderer, 'Close coach actions', 0);
      // In-bar FAB now reads "Open" again while the modal fades.
      await press(renderer, 'Open coach actions');
      await flushCloseAnimation();
      expect(modal(renderer).props.visible).toBe(true);
      expect(pressables(renderer)).toHaveLength(10);
      act(() => renderer.unmount());
    });

    it('unmounting mid-close clears the timer without throwing', async () => {
      const renderer = renderBar();
      await openMenu(renderer);
      await press(renderer, 'Drill Library');
      act(() => renderer.unmount());
      expect(() => jest.runOnlyPendingTimers()).not.toThrow();
      expect(mockRootNavigate).not.toHaveBeenCalled();
    });
  });

  describe('coach action rows', () => {
    it('Auto Analyze -> Analyze { source: camera } on the root stack after the close animation', async () => {
      const renderer = renderBar();
      await openMenu(renderer);
      await press(renderer, 'Auto Analyze');
      expect(mockRootNavigate).not.toHaveBeenCalled();
      await flushCloseAnimation();
      expect(modal(renderer).props.visible).toBe(false);
      expect(mockRootNavigate).toHaveBeenCalledTimes(1);
      expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
        source: 'camera',
      });
      expect(mockAccessState.initialize).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('Import Video -> Analyze { source: library } on the root stack', async () => {
      const renderer = renderBar();
      await openMenu(renderer);
      await press(renderer, 'Import Video');
      await flushCloseAnimation();
      expect(mockRootNavigate).toHaveBeenCalledTimes(1);
      expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
        source: 'library',
      });
      act(() => renderer.unmount());
    });

    it('Drill Library -> DrillLibrary on the root stack', async () => {
      const renderer = renderBar();
      await openMenu(renderer);
      await press(renderer, 'Drill Library');
      await flushCloseAnimation();
      expect(mockRootNavigate).toHaveBeenCalledTimes(1);
      expect(mockRootNavigate).toHaveBeenCalledWith('DrillLibrary');
      expect(mockAccessState.initialize).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('double-tapping an action row runs it once', async () => {
      const renderer = renderBar();
      await openMenu(renderer);
      await press(renderer, 'Auto Analyze');
      await press(renderer, 'Auto Analyze');
      await flushCloseAnimation();
      expect(mockRootNavigate).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });

    it.each([
      ['Auto Analyze', 'camera'],
      ['Import Video', 'library'],
    ])(
      '%s -> ConnectAccount for a local-only (guest) session, without touching access',
      async label => {
        mockAuthState.session = { localOnly: true };
        mockAccessState.canonicalAccess = null;
        const renderer = renderBar();
        await openMenu(renderer);
        await press(renderer, label);
        await flushCloseAnimation();
        expect(mockRootNavigate).toHaveBeenCalledTimes(1);
        expect(mockRootNavigate).toHaveBeenCalledWith('ConnectAccount');
        expect(mockAccessState.initialize).not.toHaveBeenCalled();
        act(() => renderer.unmount());
      },
    );

    it('Auto Analyze -> resolves access lazily, then Analyze when the allowance permits', async () => {
      mockAccessState.canonicalAccess = null;
      mockAccessState.initialize = jest.fn(async () => {
        mockAccessState.canonicalAccess = { canStartRating: true };
      });
      const renderer = renderBar();
      await openMenu(renderer);
      await press(renderer, 'Auto Analyze');
      await flushCloseAnimation();
      expect(mockAccessState.initialize).toHaveBeenCalledTimes(1);
      expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
        source: 'camera',
      });
      act(() => renderer.unmount());
    });

    it('Auto Analyze -> Paywall { source: rating } when the allowance is exhausted', async () => {
      mockAccessState.canonicalAccess = { canStartRating: false };
      const renderer = renderBar();
      await openMenu(renderer);
      await press(renderer, 'Auto Analyze');
      await flushCloseAnimation();
      expect(mockRootNavigate).toHaveBeenCalledTimes(1);
      expect(mockRootNavigate).toHaveBeenCalledWith('Paywall', {
        source: 'rating',
      });
      act(() => renderer.unmount());
    });

    it('Import Video -> Paywall (its own retry surface) when access cannot be verified', async () => {
      // accessStore.initialize never rejects: a failed backend read leaves
      // canonicalAccess null and stores the error copy for the Paywall.
      mockAccessState.canonicalAccess = null;
      mockAccessState.initialize = jest.fn(async () => {
        mockAccessState.status = 'error';
      });
      const renderer = renderBar();
      await openMenu(renderer);
      await press(renderer, 'Import Video');
      await flushCloseAnimation();
      expect(mockAccessState.initialize).toHaveBeenCalledTimes(1);
      expect(mockRootNavigate).toHaveBeenCalledTimes(1);
      expect(mockRootNavigate).toHaveBeenCalledWith('Paywall', {
        source: 'rating',
      });
      act(() => renderer.unmount());
    });

    it('does not throw when the tab navigator has no parent stack', async () => {
      const renderer = renderBar({ parent: undefined });
      await openMenu(renderer);
      await press(renderer, 'Drill Library');
      await expect(flushCloseAnimation()).resolves.toBeUndefined();
      expect(mockRootNavigate).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });
  });

  describe('confirmed defects (assertions skipped, see WF-ISSUE)', () => {
    it('a dismiss tap during the exit animation must not drop the chosen action', async () => {
      const renderer = renderBar();
      await openMenu(renderer);
      await press(renderer, 'Drill Library');
      // Second tap lands on the still-mounted backdrop before the 210ms close
      // timer fires (a double tap whose second touch misses the fading row).
      const backdrop = findByLabel(renderer, 'Close coach actions').find(
        n => n.props.accessibilityRole === undefined,
      );
      await act(async () => {
        backdrop?.props.onPress();
      });
      await flushCloseAnimation();
      expect(modal(renderer).props.visible).toBe(false);
      // WF-ISSUE: Dismiss tap during the close animation silently drops the pending coach action
      // expect(mockRootNavigate).toHaveBeenCalledWith('DrillLibrary');
      act(() => renderer.unmount());
    });

    it('a repeat tap while access is still loading must not send a free-allowance user to the Paywall', async () => {
      mockAccessState.canonicalAccess = null;
      let settleFirstLoad!: () => void;
      const firstLoad = new Promise<void>(resolve => {
        settleFirstLoad = resolve;
      });
      // Mirrors accessStore.initialize: a concurrent call while status is
      // 'loading' returns immediately without waiting for the in-flight load.
      mockAccessState.initialize = jest.fn(async () => {
        if (mockAccessState.status === 'loading') return;
        mockAccessState.status = 'loading';
        await firstLoad;
        mockAccessState.canonicalAccess = { canStartRating: true };
        mockAccessState.status = 'ready';
      });
      const renderer = renderBar();
      await openMenu(renderer);
      await press(renderer, 'Auto Analyze');
      await flushCloseAnimation();
      // Nothing visible happens while the first load is in flight, so the
      // user taps again.
      expect(mockRootNavigate).not.toHaveBeenCalled();
      await openMenu(renderer);
      await press(renderer, 'Auto Analyze');
      await flushCloseAnimation();
      expect(mockAccessState.initialize).toHaveBeenCalledTimes(2);
      // WF-ISSUE: Capture actions give no pending feedback and a repeat tap during access loading misroutes to the Paywall
      // expect(mockRootNavigate).not.toHaveBeenCalledWith('Paywall', { source: 'rating' });
      await act(async () => {
        settleFirstLoad();
      });
      expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
        source: 'camera',
      });
      act(() => renderer.unmount());
    });
  });
});
