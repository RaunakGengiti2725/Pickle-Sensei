/**
 * Floating tab bar geometry: the bar (PremiumTabBar) and the tab screens
 * (Home, Library, Progress, Settings) both read `src/navigation/tabBarLayout`,
 * so these numbers are the contract that keeps the last row of every page
 * settling above the bar instead of underneath it.
 */
let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
}));

import React from 'react';
import { Platform, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  TAB_BAR_ACTION_RISE,
  TAB_BAR_HEIGHT,
  TAB_BAR_SIDE_INSET,
  tabBarBottomOffset,
  tabBarContentInset,
  tabBarDockedFrame,
  tabBarFloatingFrame,
  tabBarFootprint,
  tabBarRowBottom,
  useTabBarContentInset,
} from '../src/navigation/tabBarLayout';
import { radius, space } from '../src/design/tokens';

function Probe() {
  return <Text>{useTabBarContentInset()}</Text>;
}

describe('tabBarLayout', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('iOS: rests just above the home indicator — 20 on Face ID phones, 12 without one', () => {
    expect(tabBarBottomOffset(0)).toBe(12);
    expect(tabBarBottomOffset(20)).toBe(12);
    expect(tabBarBottomOffset(34)).toBe(20);
  });

  it('Android: rests just above the navigation band, which it cannot dip into', () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    expect(tabBarBottomOffset(0)).toBe(12);
    // Gesture pill inset.
    expect(tabBarBottomOffset(24)).toBe(32);
    // 3-button navigation bar.
    expect(tabBarBottomOffset(48)).toBe(56);
  });

  it('keeps the bar at 70 tall with 16 side gaps and a 24 Coach rise', () => {
    expect(TAB_BAR_HEIGHT).toBe(70);
    expect(TAB_BAR_SIDE_INSET).toBe(16);
    expect(TAB_BAR_ACTION_RISE).toBe(24);
  });

  it.each([0, 12, 34, 48])(
    'footprint and content inset clear the bar in both frames (%s inset)',
    bottom => {
      const lift = tabBarBottomOffset(bottom);
      expect(tabBarRowBottom(bottom, false)).toBe(lift);
      expect(tabBarRowBottom(bottom, true)).toBe(bottom);
      expect(tabBarFootprint(bottom)).toBe(lift + TAB_BAR_HEIGHT);
      expect(tabBarFootprint(bottom, true)).toBe(bottom + TAB_BAR_HEIGHT);
      // Clears the Coach button's rise above whichever frame reaches higher,
      // with a breath of surface to spare.
      const tallest = Math.max(
        tabBarFootprint(bottom),
        tabBarFootprint(bottom, true),
      );
      expect(tabBarContentInset(bottom)).toBe(
        tallest + TAB_BAR_ACTION_RISE + space.sm,
      );
      expect(tabBarContentInset(bottom)).toBeGreaterThan(
        tabBarFootprint(bottom) + TAB_BAR_ACTION_RISE,
      );
      expect(tabBarContentInset(bottom)).toBeGreaterThan(
        tabBarFootprint(bottom, true) + TAB_BAR_ACTION_RISE,
      );
    },
  );

  it('on a Face ID phone the card dips into the inset, so the docked bar is the taller frame', () => {
    expect(tabBarFootprint(34)).toBe(90);
    expect(tabBarFootprint(34, true)).toBe(104);
    expect(tabBarContentInset(34)).toBe(136);
    // Without an inset the card is the taller frame.
    expect(tabBarFootprint(0)).toBe(82);
    expect(tabBarFootprint(0, true)).toBe(70);
    expect(tabBarContentInset(0)).toBe(114);
  });

  it.each([
    { bottom: 0, left: 0, right: 0 },
    { bottom: 34, left: 0, right: 0 },
    { bottom: 21, left: 44, right: 44 },
  ])('defines the floating card and the docked bar for %o', insets => {
    expect(tabBarFloatingFrame(insets)).toEqual({
      bottom: tabBarBottomOffset(insets.bottom),
      left: TAB_BAR_SIDE_INSET + insets.left,
      right: TAB_BAR_SIDE_INSET + insets.right,
      height: TAB_BAR_HEIGHT,
      paddingBottom: 0,
      borderRadius: radius.lg,
    });
    // Docked is the bar exactly as it sat before it floated.
    expect(tabBarDockedFrame(insets)).toEqual({
      bottom: 0,
      left: 0,
      right: 0,
      height: TAB_BAR_HEIGHT + insets.bottom,
      paddingBottom: insets.bottom,
      borderRadius: 0,
    });
  });

  it('useTabBarContentInset follows the device bottom inset', () => {
    mockInsets = { top: 59, bottom: 34, left: 0, right: 0 };
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Probe />);
    });
    expect(renderer.root.findByType(Text).props.children).toBe(136);
    mockInsets = { top: 20, bottom: 0, left: 0, right: 0 };
    act(() => renderer.update(<Probe />));
    expect(renderer.root.findByType(Text).props.children).toBe(114);
    act(() => renderer.unmount());
  });
});
