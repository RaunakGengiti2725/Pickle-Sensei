/**
 * Scroll-driven docking for the tab bar.
 *
 * The bar floats while a page scrolls and LATCHES onto the bottom of the
 * screen once the page's end is reached (the docked frame in
 * `tabBarLayout.ts`). Each tab screen feeds its scroll view's metrics in
 * through `useTabScrollDock(tab)`; the bar reads the FOCUSED tab's verdict
 * through `useTabBarDocked(tab)` and animates between the two frames. A page
 * that cannot scroll has no end to reach and keeps the floating bar.
 *
 * The latch has hysteresis: it closes within a few points of the end and
 * opens only once the page has scrolled a clear distance back up, so finger
 * jitter at the bottom (or the rubber-band settling) never shakes the bar
 * loose and back.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from 'react-native';
import { create } from 'zustand';
import { space } from '../design/tokens';
import type { MainTabParams } from './params';

export type TabName = keyof MainTabParams;

/** Within this distance of the page's end the bar latches on... */
export const TAB_BAR_DOCK_DISTANCE = space.sm;
/** ...and it lets go only once the page has scrolled this far back up. */
export const TAB_BAR_UNDOCK_DISTANCE = space.xl;

export interface ScrollMetrics {
  offset: number;
  contentHeight: number;
  viewportHeight: number;
}

interface TabBarDockState {
  docked: Partial<Record<TabName, boolean>>;
  setDocked: (tab: TabName, docked: boolean) => void;
}

export const useTabBarDockStore = create<TabBarDockState>(set => ({
  docked: {},
  setDocked: (tab, docked) =>
    set(state =>
      state.docked[tab] === docked
        ? state
        : { docked: { ...state.docked, [tab]: docked } },
    ),
}));

/** Whether the bar should sit docked while `tab` is the focused tab. */
export function useTabBarDocked(tab: TabName): boolean {
  return useTabBarDockStore(state => state.docked[tab] === true);
}

/** The latch: decides from the scroll metrics, `wasDocked` supplying the hysteresis. */
export function resolveDocked(
  metrics: ScrollMetrics,
  wasDocked: boolean,
): boolean {
  const range = metrics.contentHeight - metrics.viewportHeight;
  if (range <= 1) return false;
  const distance = range - metrics.offset;
  return (
    distance <= (wasDocked ? TAB_BAR_UNDOCK_DISTANCE : TAB_BAR_DOCK_DISTANCE)
  );
}

const EMPTY: ScrollMetrics = { offset: 0, contentHeight: 0, viewportHeight: 0 };

/**
 * Spread the result onto the tab screen's main ScrollView / FlatList. The
 * callback ref notices the scroll view leaving (a loading or error state
 * taking its place) and releases the latch, so a stale verdict never keeps
 * the bar docked over a page that has no end on screen.
 */
export function useTabScrollDock(tab: TabName) {
  const setDocked = useTabBarDockStore(state => state.setDocked);
  const metrics = useRef<ScrollMetrics>(EMPTY);
  const evaluate = useCallback(() => {
    const wasDocked = useTabBarDockStore.getState().docked[tab] === true;
    setDocked(tab, resolveDocked(metrics.current, wasDocked));
  }, [setDocked, tab]);

  useEffect(() => () => setDocked(tab, false), [setDocked, tab]);

  return useMemo(
    () => ({
      ref: (node: unknown) => {
        if (node !== null) return;
        metrics.current = EMPTY;
        setDocked(tab, false);
      },
      scrollEventThrottle: 16,
      onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, contentSize, layoutMeasurement } =
          event.nativeEvent;
        metrics.current = {
          offset: contentOffset.y,
          contentHeight: contentSize.height,
          viewportHeight: layoutMeasurement.height,
        };
        evaluate();
      },
      onLayout: (event: LayoutChangeEvent) => {
        metrics.current = {
          ...metrics.current,
          viewportHeight: event.nativeEvent.layout.height,
        };
        evaluate();
      },
      onContentSizeChange: (_width: number, height: number) => {
        metrics.current = { ...metrics.current, contentHeight: height };
        evaluate();
      },
    }),
    [evaluate, setDocked, tab],
  );
}
