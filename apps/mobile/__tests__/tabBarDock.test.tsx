/**
 * The tab bar's scroll latch (`src/navigation/tabBarDock.ts`): the bar floats
 * while a page scrolls and docks onto the bottom of the screen once the
 * focused page's end is reached. These tests pin the latch's decision — its
 * hysteresis, that a page which cannot scroll never docks — and the hook the
 * tab screens spread onto their ScrollView / FlatList.
 */
import React from 'react';
import { ScrollView } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  TAB_BAR_DOCK_DISTANCE,
  TAB_BAR_UNDOCK_DISTANCE,
  resolveDocked,
  useTabBarDockStore,
  useTabScrollDock,
} from '../src/navigation/tabBarDock';
import { space } from '../src/design/tokens';

function scrollEvent(offset: number, contentHeight: number, viewport: number) {
  return {
    nativeEvent: {
      contentOffset: { x: 0, y: offset },
      contentSize: { width: 393, height: contentHeight },
      layoutMeasurement: { width: 393, height: viewport },
    },
  } as unknown as Parameters<
    ReturnType<typeof useTabScrollDock>['onScroll']
  >[0];
}

function layoutEvent(height: number) {
  return {
    nativeEvent: { layout: { x: 0, y: 0, width: 393, height } },
  } as unknown as Parameters<
    ReturnType<typeof useTabScrollDock>['onLayout']
  >[0];
}

function HomeList({ mounted = true }: { mounted?: boolean }) {
  const dock = useTabScrollDock('Home');
  return mounted ? <ScrollView {...dock} /> : null;
}

const docked = () => useTabBarDockStore.getState().docked;

describe('resolveDocked', () => {
  it('closes within a few points of the end and opens only a clear distance back up', () => {
    expect(TAB_BAR_DOCK_DISTANCE).toBe(space.sm);
    expect(TAB_BAR_UNDOCK_DISTANCE).toBe(space.xl);
    const page = { contentHeight: 2000, viewportHeight: 800 };
    const end = page.contentHeight - page.viewportHeight;
    // Floating: still 9 from the end → stays floating; 8 → latches.
    expect(resolveDocked({ ...page, offset: end - 9 }, false)).toBe(false);
    expect(resolveDocked({ ...page, offset: end - 8 }, false)).toBe(true);
    // The rubber band past the end counts as the end.
    expect(resolveDocked({ ...page, offset: end + 60 }, false)).toBe(true);
    // Docked: jitter within 32 of the end keeps the latch; 33 releases it.
    expect(resolveDocked({ ...page, offset: end - 32 }, true)).toBe(true);
    expect(resolveDocked({ ...page, offset: end - 33 }, true)).toBe(false);
  });

  it('never docks a page that cannot scroll — there is no end to reach', () => {
    expect(
      resolveDocked(
        { offset: 0, contentHeight: 600, viewportHeight: 800 },
        false,
      ),
    ).toBe(false);
    expect(
      resolveDocked(
        { offset: 0, contentHeight: 800, viewportHeight: 800 },
        true,
      ),
    ).toBe(false);
    expect(
      resolveDocked({ offset: 0, contentHeight: 0, viewportHeight: 0 }, false),
    ).toBe(false);
  });
});

describe('useTabScrollDock', () => {
  beforeEach(() => {
    useTabBarDockStore.setState({ docked: {} });
  });

  it('feeds the scroll view metrics into the focused tab latch and releases it on the way back up', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<HomeList />);
    });
    const list = renderer.root.findByType(ScrollView).props;
    expect(list.scrollEventThrottle).toBe(16);
    act(() => list.onLayout(layoutEvent(800)));
    act(() => list.onContentSizeChange(393, 2000));
    expect(docked().Home).toBe(false);
    act(() => list.onScroll(scrollEvent(1195, 2000, 800)));
    expect(docked().Home).toBe(true);
    // Scrolling back within the hysteresis band keeps the bar docked...
    act(() => list.onScroll(scrollEvent(1170, 2000, 800)));
    expect(docked().Home).toBe(true);
    // ...a clear scroll up lets it float again.
    act(() => list.onScroll(scrollEvent(1100, 2000, 800)));
    expect(docked().Home).toBe(false);
    // Content growing under a docked bar (a list loading more) re-evaluates.
    act(() => list.onScroll(scrollEvent(1200, 2000, 800)));
    expect(docked().Home).toBe(true);
    act(() => list.onContentSizeChange(393, 2600));
    expect(docked().Home).toBe(false);
    act(() => renderer.unmount());
    expect(docked().Home).toBe(false);
  });

  it('releases the latch when the scroll view leaves (a loading or error state replaces it)', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<HomeList />);
    });
    const list = renderer.root.findByType(ScrollView).props;
    act(() => list.onScroll(scrollEvent(1200, 2000, 800)));
    expect(docked().Home).toBe(true);
    act(() => renderer.update(<HomeList mounted={false} />));
    expect(docked().Home).toBe(false);
    act(() => renderer.unmount());
  });

  it('keeps one latch per tab', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<HomeList />);
    });
    const list = renderer.root.findByType(ScrollView).props;
    act(() => list.onScroll(scrollEvent(1200, 2000, 800)));
    expect(docked()).toEqual({ Home: true });
    act(() => useTabBarDockStore.getState().setDocked('Library', true));
    expect(docked()).toEqual({ Home: true, Library: true });
    act(() => renderer.unmount());
    expect(docked()).toEqual({ Home: false, Library: true });
  });
});
