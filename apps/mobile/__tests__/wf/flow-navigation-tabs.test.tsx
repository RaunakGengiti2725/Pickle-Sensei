/**
 * navigation-tabs workflow: drives PremiumTabBar as a user would — the four
 * regular tabs, the center COACH action portal (open, cancel via backdrop /
 * overlay button / Android back, each action), and the rating-flow gate the
 * actions run through (local-only → ConnectAccount, no access → Paywall,
 * access → Analyze), including the double-tap and failure branches.
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
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockAccess: {
  canonicalAccess: { canStartRating: boolean } | null;
  status: 'idle' | 'loading' | 'ready' | 'unconfigured' | 'error';
  initialize: jest.Mock<Promise<void>, []>;
} = {
  canonicalAccess: { canStartRating: true },
  status: 'ready',
  initialize: jest.fn(async () => {}),
};
const mockAuth: { session: { localOnly: boolean } | null } = {
  session: { localOnly: false },
};
jest.mock('../../src/state/accessStore', () => ({
  useAccessStore: { getState: () => mockAccess },
}));
jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: { getState: () => mockAuth },
}));

import React from 'react';
import { Modal, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';
import type { MainTabParams } from '../../src/navigation/params';

const TAB_ROUTES: (keyof MainTabParams)[] = [
  'Home',
  'Library',
  'Add',
  'Performance',
  'Settings',
];

const mockRootNavigate = jest.fn();
const mockTabNavigate = jest.fn();
const mockEmit = jest.fn<{ defaultPrevented: boolean }, [unknown]>(() => ({
  defaultPrevented: false,
}));

function makeProps(index = 0): BottomTabBarProps {
  return {
    state: {
      index,
      routes: TAB_ROUTES.map(name => ({ key: `${name}-1`, name })),
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

function renderBar(index = 0) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<PremiumTabBar {...makeProps(index)} />);
  });
  return renderer;
}

type Node = TestRenderer.ReactTestInstance;

function pressables(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
}

function findPressable(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): Node {
  const [node] = pressables(renderer, label);
  if (!node) throw new Error(`No pressable labeled ${label}`);
  return node;
}

async function press(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
  pick: (nodes: Node[]) => Node | undefined = nodes => nodes[0],
) {
  const node = pick(pressables(renderer, label));
  if (!node) throw new Error(`No pressable labeled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
}

async function flushCloseAnimation() {
  await act(async () => {
    jest.advanceTimersByTime(400);
  });
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function menu(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType(Modal);
}

describe('navigation-tabs: PremiumTabBar regular tabs', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRootNavigate.mockClear();
    mockTabNavigate.mockClear();
    mockEmit.mockClear();
    mockAccess.canonicalAccess = { canStartRating: true };
    mockAccess.status = 'ready';
    mockAccess.initialize = jest.fn(async () => {});
    mockAuth.session = { localOnly: false };
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders every MainTabParams route as a labelled tab with a selected state, plus the COACH portal', () => {
    const renderer = renderBar(0);
    const tabs = renderer.root.findAll(
      n =>
        n.props.accessibilityRole === 'tab' &&
        typeof n.props.onPress === 'function',
    );
    expect(tabs.map(n => n.props.accessibilityLabel)).toEqual([
      'Home',
      'Library',
      'Progress',
      'Settings',
    ]);
    expect(tabs.map(n => n.props.accessibilityState)).toEqual([
      { selected: true },
      { selected: false },
      { selected: false },
      { selected: false },
    ]);
    // The Add route renders as the COACH button, never as a navigable tab.
    const coach = findPressable(renderer, 'Open coach actions');
    expect(coach.props.accessibilityRole).toBe('button');
    expect(coach.props.accessibilityState).toEqual({ expanded: false });
    expect(allText(renderer)).toContain('COACH');
    expect(menu(renderer).props.visible).toBe(false);
    act(() => renderer.unmount());
  });

  it.each([
    ['Library', 'Library'],
    ['Progress', 'Performance'],
    ['Settings', 'Settings'],
  ])(
    'tapping the %s tab emits tabPress then navigates to the %s tab route',
    async (label, routeName) => {
      const renderer = renderBar(0);
      await press(renderer, label);
      expect(mockEmit).toHaveBeenCalledWith({
        type: 'tabPress',
        target: `${routeName}-1`,
        canPreventDefault: true,
      });
      expect(mockTabNavigate).toHaveBeenCalledTimes(1);
      expect(mockTabNavigate).toHaveBeenCalledWith(routeName, undefined);
      expect(mockRootNavigate).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    },
  );

  it('re-tapping the focused tab emits tabPress but does not navigate', async () => {
    const renderer = renderBar(TAB_ROUTES.indexOf('Settings'));
    await press(renderer, 'Settings');
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockTabNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('honors a defaultPrevented tabPress (screen-owned press handling)', async () => {
    mockEmit.mockImplementationOnce(() => ({ defaultPrevented: true }));
    const renderer = renderBar(0);
    await press(renderer, 'Library');
    expect(mockTabNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('long-pressing a tab emits tabLongPress for its route key', async () => {
    const renderer = renderBar(0);
    const node = findPressable(renderer, 'Progress');
    await act(async () => {
      node.props.onLongPress();
    });
    expect(mockEmit).toHaveBeenCalledWith({
      type: 'tabLongPress',
      target: 'Performance-1',
    });
    expect(mockTabNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

describe('navigation-tabs: COACH action portal open / cancel', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRootNavigate.mockClear();
    mockTabNavigate.mockClear();
    mockEmit.mockClear();
    mockAccess.canonicalAccess = { canStartRating: true };
    mockAccess.status = 'ready';
    mockAccess.initialize = jest.fn(async () => {});
    mockAuth.session = { localOnly: false };
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens the menu with three accessible actions and flips the button to "Close coach actions" (expanded)', async () => {
    const renderer = renderBar();
    await press(renderer, 'Open coach actions');
    expect(menu(renderer).props.visible).toBe(true);
    // Both the in-bar button and the overlay copy now read as close/expanded;
    // the backdrop is a plain dismiss button.
    const closers = pressables(renderer, 'Close coach actions');
    expect(closers.length).toBeGreaterThanOrEqual(3);
    for (const node of closers) {
      expect(node.props.accessibilityRole).toBe('button');
    }
    expect(
      closers.filter(n => n.props.accessibilityState !== undefined),
    ).toHaveLength(2);
    for (const node of closers.filter(
      n => n.props.accessibilityState !== undefined,
    )) {
      expect(node.props.accessibilityState).toEqual({ expanded: true });
    }
    const actions = ['Auto Analyze', 'Import Video', 'Drill Library'].map(
      label => findPressable(renderer, label),
    );
    for (const action of actions) {
      expect(action.props.accessibilityRole).toBe('button');
      expect(typeof action.props.accessibilityHint).toBe('string');
    }
    const copy = allText(renderer);
    expect(copy).toContain('Auto capture · validated scores only');
    expect(copy).toContain('Choose a real clip from this phone');
    expect(copy).toContain('Guided drills you can search');
    expect(copy).not.toContain('Live Court');
    act(() => renderer.unmount());
  });

  it('cancel via the in-bar COACH button closes without navigating', async () => {
    const renderer = renderBar();
    await press(renderer, 'Open coach actions');
    // The in-bar instance is the first "Close coach actions" button.
    await press(renderer, 'Close coach actions', nodes =>
      nodes.find(n => n.props.accessibilityRole === 'button'),
    );
    await flushCloseAnimation();
    expect(menu(renderer).props.visible).toBe(false);
    expect(findPressable(renderer, 'Open coach actions')).toBeTruthy();
    expect(mockRootNavigate).not.toHaveBeenCalled();
    expect(mockTabNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('cancel via the backdrop closes without navigating', async () => {
    const renderer = renderBar();
    await press(renderer, 'Open coach actions');
    await press(renderer, 'Close coach actions', nodes =>
      nodes.find(n => n.props.accessibilityState === undefined),
    );
    await flushCloseAnimation();
    expect(menu(renderer).props.visible).toBe(false);
    expect(mockRootNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('cancel via the overlay close button (last close control) closes without navigating', async () => {
    const renderer = renderBar();
    await press(renderer, 'Open coach actions');
    await press(renderer, 'Close coach actions', nodes => nodes.at(-1));
    await flushCloseAnimation();
    expect(menu(renderer).props.visible).toBe(false);
    expect(mockRootNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('Android hardware back (Modal onRequestClose) dismisses the menu', async () => {
    const renderer = renderBar();
    await press(renderer, 'Open coach actions');
    await act(async () => {
      menu(renderer).props.onRequestClose();
    });
    await flushCloseAnimation();
    expect(menu(renderer).props.visible).toBe(false);
    expect(mockRootNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('re-opening during the close animation cancels the pending close', async () => {
    const renderer = renderBar();
    await press(renderer, 'Open coach actions');
    await press(renderer, 'Close coach actions', nodes =>
      nodes.find(n => n.props.accessibilityRole === 'button'),
    );
    // Before the 210ms close timer fires, the user taps COACH again.
    await press(renderer, 'Open coach actions');
    await flushCloseAnimation();
    expect(menu(renderer).props.visible).toBe(true);
    expect(pressables(renderer, 'Close coach actions').length).toBeGreaterThan(
      0,
    );
    act(() => renderer.unmount());
  });

  it('unmounting mid-close clears the timer (no setState on an unmounted bar)', async () => {
    const renderer = renderBar();
    await press(renderer, 'Open coach actions');
    await press(renderer, 'Drill Library');
    act(() => renderer.unmount());
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await flushCloseAnimation();
    expect(errorSpy).not.toHaveBeenCalled();
    // The deferred action is dropped with the bar — nothing navigates blind.
    expect(mockRootNavigate).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('navigation-tabs: COACH actions route through the rating gate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRootNavigate.mockClear();
    mockTabNavigate.mockClear();
    mockEmit.mockClear();
    mockAccess.canonicalAccess = { canStartRating: true };
    mockAccess.status = 'ready';
    mockAccess.initialize = jest.fn(async () => {});
    mockAuth.session = { localOnly: false };
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('Auto Analyze → Analyze { source: camera } on the ROOT navigator after the close animation', async () => {
    const renderer = renderBar();
    await press(renderer, 'Open coach actions');
    await press(renderer, 'Auto Analyze');
    expect(mockRootNavigate).not.toHaveBeenCalled();
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    expect(mockTabNavigate).not.toHaveBeenCalled();
    expect(menu(renderer).props.visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('Import Video → Analyze { source: library }', async () => {
    const renderer = renderBar();
    await press(renderer, 'Open coach actions');
    await press(renderer, 'Import Video');
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
      source: 'library',
    });
    act(() => renderer.unmount());
  });

  it('Drill Library → DrillLibrary with no params', async () => {
    const renderer = renderBar();
    await press(renderer, 'Open coach actions');
    await press(renderer, 'Drill Library');
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('DrillLibrary');
    expect(mockAccess.initialize).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('local-only session: capture actions route to ConnectAccount, never Analyze/Paywall', async () => {
    mockAuth.session = { localOnly: true };
    mockAccess.canonicalAccess = null;
    const renderer = renderBar();
    await press(renderer, 'Open coach actions');
    await press(renderer, 'Auto Analyze');
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('ConnectAccount');
    expect(mockAccess.initialize).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('no cached access: routes to the Analyze gate without awaiting initialize() (the route resolves access)', async () => {
    mockAccess.canonicalAccess = null;
    mockAccess.status = 'idle';
    const renderer = renderBar();
    await press(renderer, 'Open coach actions');
    await press(renderer, 'Import Video');
    await flushCloseAnimation();
    expect(mockAccess.initialize).not.toHaveBeenCalled();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
      source: 'library',
    });
    act(() => renderer.unmount());
  });

  it('no rating entitlement: routes to Paywall { source: rating }', async () => {
    mockAccess.canonicalAccess = { canStartRating: false };
    const renderer = renderBar();
    await press(renderer, 'Open coach actions');
    await press(renderer, 'Auto Analyze');
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Paywall', {
      source: 'rating',
    });
    act(() => renderer.unmount());
  });

  it('access check failed (status error, access null): still lands on Paywall, no dead end', async () => {
    mockAccess.canonicalAccess = null;
    mockAccess.status = 'error';
    const renderer = renderBar();
    await press(renderer, 'Open coach actions');
    await press(renderer, 'Auto Analyze');
    await flushCloseAnimation();
    expect(mockAccess.initialize).not.toHaveBeenCalled();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Paywall', {
      source: 'rating',
    });
    act(() => renderer.unmount());
  });

  it('double-tapping an action during the close animation navigates exactly once', async () => {
    const renderer = renderBar();
    await press(renderer, 'Open coach actions');
    await press(renderer, 'Auto Analyze');
    await press(renderer, 'Auto Analyze');
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Analyze', {
      source: 'camera',
    });
    act(() => renderer.unmount());
  });

  it('tapping a second action during the close animation runs only the last one', async () => {
    const renderer = renderBar();
    await press(renderer, 'Open coach actions');
    await press(renderer, 'Auto Analyze');
    await press(renderer, 'Drill Library');
    await flushCloseAnimation();
    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('DrillLibrary');
    act(() => renderer.unmount());
  });

  it('a missing parent navigator never throws (actions are no-ops, not crashes)', async () => {
    const props = makeProps();
    (props.navigation as unknown as { getParent: () => undefined }).getParent =
      () => undefined;
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<PremiumTabBar {...props} />);
    });
    await press(renderer, 'Open coach actions');
    await press(renderer, 'Drill Library');
    await expect(flushCloseAnimation()).resolves.toBeUndefined();
    expect(mockRootNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
