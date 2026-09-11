/**
 * Tab bar geometry — the one place the bar's two frames are defined.
 *
 * The bar is positioned absolutely over the tab screens and has two resting
 * states. While a page scrolls it FLOATS: a rounded card a little above the
 * home indicator with surface showing around it. Once the page's end is
 * reached it DOCKS — latches onto the bottom of the screen as the bar always
 * used to sit: full width, square, flush, stretched under the home indicator
 * (`tabBarDock.ts` decides which; the bar animates between them). Because it
 * takes no layout room in either state, every tab screen reserves
 * `useTabBarContentInset()` at the bottom of its scroll content so the last
 * row settles above the bar (and the Coach button riding on it) instead of
 * underneath. The bar and the screens both read these numbers, so the two
 * can never disagree about where the bar is.
 */
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, space } from '../design/tokens';

export const TAB_BAR_HEIGHT = 70;
/** Gap between the floating bar and the left/right screen edges. */
export const TAB_BAR_SIDE_INSET = space.md;
/** How far the Coach button rises above the bar's top edge. */
export const TAB_BAR_ACTION_RISE = 24;
/**
 * iOS: the home indicator is a transparent overlay the system's own floating
 * bars sit close above, so the card dips this far into its 34pt inset — its
 * bottom edge 20 above the screen edge on Face ID phones.
 */
export const TAB_BAR_INDICATOR_DIP = 14;
/** The card never comes closer than this to the screen edge. */
export const TAB_BAR_MIN_LIFT = 12;
/** Android: the navigation band (gesture pill or 3-button bar) is a
 * system-owned strip the card cannot dip into; it rests this far above it. */
export const TAB_BAR_ANDROID_LIFT = space.sm;

export interface TabBarInsets {
  bottom: number;
  left: number;
  right: number;
}

/** The box the bar's outer view occupies, in either state. */
export interface TabBarFrame {
  bottom: number;
  left: number;
  right: number;
  height: number;
  paddingBottom: number;
  borderRadius: number;
}

/**
 * Gap between the floating bar's bottom edge and the bottom of the screen:
 * just above the home indicator on iOS (20 on Face ID phones, 12 on phones
 * without one), just above the navigation band on Android.
 */
export function tabBarBottomOffset(bottomInset: number): number {
  return Math.max(
    Platform.OS === 'android'
      ? bottomInset + TAB_BAR_ANDROID_LIFT
      : bottomInset - TAB_BAR_INDICATOR_DIP,
    TAB_BAR_MIN_LIFT,
  );
}

/** Screen bottom → bottom edge of the 70pt tab row, in either state. */
export function tabBarRowBottom(bottomInset: number, docked: boolean): number {
  return docked ? bottomInset : tabBarBottomOffset(bottomInset);
}

/** Screen bottom → bar top: the footprint the bar occupies over a screen. */
export function tabBarFootprint(bottomInset: number, docked = false): number {
  return tabBarRowBottom(bottomInset, docked) + TAB_BAR_HEIGHT;
}

/** Floating: the rounded card, 16 off each side, lifted above the inset. */
export function tabBarFloatingFrame(insets: TabBarInsets): TabBarFrame {
  return {
    bottom: tabBarBottomOffset(insets.bottom),
    left: TAB_BAR_SIDE_INSET + insets.left,
    right: TAB_BAR_SIDE_INSET + insets.right,
    height: TAB_BAR_HEIGHT,
    paddingBottom: 0,
    borderRadius: radius.lg,
  };
}

/** Docked: full width, square, flush — the bar as it sat before it floated. */
export function tabBarDockedFrame(insets: TabBarInsets): TabBarFrame {
  return {
    bottom: 0,
    left: 0,
    right: 0,
    height: TAB_BAR_HEIGHT + insets.bottom,
    paddingBottom: insets.bottom,
    borderRadius: 0,
  };
}

/**
 * Bottom padding a tab screen adds to its scroll content so the page ends
 * above the bar and the Coach button with a breath of surface. Sized for
 * whichever frame reaches higher (the docked bar on Face ID phones, where the
 * card dips into the inset; the card elsewhere), so it clears the bar in both.
 */
export function tabBarContentInset(bottomInset: number): number {
  return (
    Math.max(tabBarFootprint(bottomInset), tabBarFootprint(bottomInset, true)) +
    TAB_BAR_ACTION_RISE +
    space.sm
  );
}

export function useTabBarContentInset(): number {
  return tabBarContentInset(useSafeAreaInsets().bottom);
}
