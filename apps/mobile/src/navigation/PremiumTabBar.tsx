import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { HostInstance } from 'react-native';
import type { NavigationProp } from '@react-navigation/native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Icon, type IconName } from '../design/icons';
import { useReducedMotion } from '../design/components';
import { color, radius, shadow, space, type } from '../design/tokens';
import { useAccessStore } from '../state/accessStore';
import { useAuthStore } from '../auth/authStore';
import { useWalkthroughTarget } from '../walkthrough/targets';
import type { MainTabParams, RootStackParams } from './params';
import {
  TAB_BAR_ACTION_RISE,
  TAB_BAR_HEIGHT,
  tabBarDockedFrame,
  tabBarFloatingFrame,
  tabBarRowBottom,
} from './tabBarLayout';
import { useTabBarDocked } from './tabBarDock';

const ACTION_SIZE = 68;
/** The Coach button's bottom edge, measured up from the tab row's bottom. */
const ACTION_BOTTOM = TAB_BAR_HEIGHT + TAB_BAR_ACTION_RISE - ACTION_SIZE;
/** Floating ↔ docked: one strong ease-out, the same language as the menu. */
const DOCK_DURATION = 240;
/** A plain number the frame worklet can capture (not the StyleSheet module). */
const HAIRLINE = StyleSheet.hairlineWidth;
/** The card's floating shadow → the docked bar's faint upward rule. */
const FLOATING_SHADOW = {
  opacity: shadow.floating.shadowOpacity,
  radius: shadow.floating.shadowRadius,
  offsetY: shadow.floating.shadowOffset.height,
  elevation: shadow.floating.elevation,
};
const DOCKED_SHADOW = {
  opacity: 0.055,
  radius: 20,
  offsetY: -8,
  elevation: 14,
};

function mix(from: number, to: number, t: number): number {
  'worklet';
  // Two-sided lerp: exact at both ends, so a settled bar sits on the frame.
  return from * (1 - t) + to * t;
}

const TAB_META: Record<keyof MainTabParams, { label: string; icon: IconName }> =
  {
    Home: { label: 'Home', icon: 'home' },
    Library: { label: 'Library', icon: 'library' },
    Add: { label: 'Coach', icon: 'plus' },
    Performance: { label: 'Progress', icon: 'progress' },
    Settings: { label: 'Settings', icon: 'settings' },
  };

type CoachAction = {
  title: string;
  detail: string;
  icon: IconName;
  accent: string;
  onPress: () => void;
};

function CoachActionRow(props: {
  action: CoachAction;
  index: number;
  progress: SharedValue<number>;
  reducedMotion: boolean;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    const entry = 0.16 + props.index * 0.09;
    return {
      opacity: interpolate(props.progress.value, [0, entry, 1], [0, 0, 1]),
      transform: [
        {
          translateY: interpolate(
            props.progress.value,
            [0, 1],
            [20 + props.index * 7, 0],
          ),
        },
        {
          scale: interpolate(props.progress.value, [0, 1], [0.96, 1]),
        },
      ],
    };
  });

  return (
    <Animated.View style={[styles.actionRowWrap, animatedStyle]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.action.title}
        accessibilityHint={props.action.detail}
        onPress={props.action.onPress}
        style={({ pressed }) => [
          styles.actionRow,
          pressed &&
            (props.reducedMotion
              ? styles.actionRowPressedReduced
              : styles.actionRowPressed),
        ]}
      >
        <View
          style={[styles.actionIcon, { backgroundColor: props.action.accent }]}
        >
          <Icon name={props.action.icon} color={color.ink} size={21} />
        </View>
        <View style={styles.actionCopy}>
          <Text style={[type.bodyBold, styles.actionTitle]}>
            {props.action.title}
          </Text>
          <Text style={[type.caption, styles.actionDetail]}>
            {props.action.detail}
          </Text>
        </View>
        <Icon name="arrow" color={color.inkSoft} size={19} />
      </Pressable>
    </Animated.View>
  );
}

function CoachActionButton(props: {
  progress: SharedValue<number>;
  onPress: () => void;
  open: boolean;
  largeContentViewer: boolean;
  overlay?: boolean;
  bottom?: number;
  /** Walkthrough anchor — set on the in-bar instance only, so the spotlight
   * measures the resting Coach button, never the overlay copy. */
  innerRef?: React.Ref<HostInstance>;
}) {
  const { progress } = props;
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      {
        rotate: `${interpolate(progress.value, [0, 1], [0, 45])}deg`,
      },
      {
        scale: interpolate(progress.value, [0, 1], [1, 1.04]),
      },
    ],
  }));

  return (
    <Pressable
      ref={props.innerRef}
      accessibilityRole="button"
      accessibilityLabel={
        props.open ? 'Close coach actions' : 'Open coach actions'
      }
      accessibilityState={{ expanded: props.open }}
      accessibilityShowsLargeContentViewer={props.largeContentViewer}
      accessibilityLargeContentTitle="Coach"
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.actionButtonPressable,
        props.overlay && styles.overlayActionButton,
        props.bottom !== undefined && { bottom: props.bottom },
        pressed && { opacity: 0.9 },
      ]}
    >
      <Animated.View style={[styles.actionButtonRing, animatedStyle]}>
        <View style={styles.actionButton}>
          <Icon name="plus" color={color.ink} size={30} strokeWidth={2.25} />
        </View>
      </Animated.View>
    </Pressable>
  );
}

export function PremiumTabBar(props: BottomTabBarProps) {
  // Match the upstream iOS tab pattern: only fixed labels opt out of scaling,
  // with the full title available through the native large-content viewer.
  const largeContentViewer =
    Platform.OS === 'ios' && parseInt(Platform.Version, 10) >= 13;
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  // The bar floats while the focused page scrolls and docks — full width,
  // flush with the screen — once that page's end is reached. The Coach menu
  // and the overlay copy of its button anchor to whichever frame it is in.
  const focusedTab = (props.state.routes[props.state.index]?.name ??
    'Home') as keyof MainTabParams;
  const docked = useTabBarDocked(focusedTab);
  const rowBottom = tabBarRowBottom(insets.bottom, docked);
  const actionsBottom = rowBottom + TAB_BAR_HEIGHT + space.xl;
  const actionsMaxHeight = Math.max(
    0,
    windowHeight - insets.top - space.md - actionsBottom,
  );
  const reducedMotion = useReducedMotion();
  // Walkthrough anchors: the spotlight tour measures these live views.
  const coachFabTarget = useWalkthroughTarget('coach-fab');
  const libraryTabTarget = useWalkthroughTarget('tab-library');
  const progressTabTarget = useWalkthroughTarget('tab-progress');
  const progress = useSharedValue(0);
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAction = useRef<(() => void) | null>(null);
  const motionDuration = reducedMotion ? 1 : 210;
  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
  }));

  // 0 = floating card, 1 = docked bar. Layout props animate on the UI thread
  // and retarget mid-flight, so a scroll that crosses the latch twice in
  // quick succession never snaps or restarts.
  const dock = useSharedValue(docked ? 1 : 0);
  const floating = useMemo(() => tabBarFloatingFrame(insets), [insets]);
  const landed = useMemo(() => tabBarDockedFrame(insets), [insets]);
  useEffect(() => {
    const target = docked ? 1 : 0;
    dock.value = reducedMotion
      ? target
      : withTiming(target, {
          duration: DOCK_DURATION,
          easing: Easing.out(Easing.cubic),
        });
  }, [dock, docked, reducedMotion]);
  const frameStyle = useAnimatedStyle(() => {
    const t = dock.value;
    // The card's edge folds into the docked bar's single top rule halfway.
    const sideRule = t < 0.5 ? HAIRLINE : 0;
    return {
      bottom: mix(floating.bottom, landed.bottom, t),
      left: mix(floating.left, landed.left, t),
      right: mix(floating.right, landed.right, t),
      height: mix(floating.height, landed.height, t),
      paddingBottom: mix(floating.paddingBottom, landed.paddingBottom, t),
      borderRadius: mix(floating.borderRadius, landed.borderRadius, t),
      borderLeftWidth: sideRule,
      borderRightWidth: sideRule,
      borderBottomWidth: sideRule,
      shadowOpacity: mix(FLOATING_SHADOW.opacity, DOCKED_SHADOW.opacity, t),
      shadowRadius: mix(FLOATING_SHADOW.radius, DOCKED_SHADOW.radius, t),
      shadowOffset: {
        width: 0,
        height: mix(FLOATING_SHADOW.offsetY, DOCKED_SHADOW.offsetY, t),
      },
      elevation: mix(FLOATING_SHADOW.elevation, DOCKED_SHADOW.elevation, t),
    };
  }, [floating, landed]);

  useEffect(() => {
    progress.value = reducedMotion
      ? menuOpen
        ? 1
        : 0
      : withTiming(menuOpen ? 1 : 0, {
          duration: motionDuration,
          easing: Easing.out(Easing.cubic),
        });
  }, [menuOpen, motionDuration, progress, reducedMotion]);

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  const openMenu = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    pendingAction.current = null;
    setMenuVisible(true);
    setMenuOpen(true);
  }, []);

  const closeMenu = useCallback(
    (after?: () => void) => {
      if (after) pendingAction.current = after;
      if (closeTimer.current) return;
      setMenuOpen(false);
      closeTimer.current = setTimeout(() => {
        closeTimer.current = null;
        const action = pendingAction.current;
        pendingAction.current = null;
        setMenuVisible(false);
        action?.();
      }, motionDuration);
    },
    [motionDuration],
  );

  const rootNavigation =
    props.navigation.getParent<NavigationProp<RootStackParams>>();

  const openRatingFlow = useCallback(
    (source: 'camera' | 'library') => {
      if (useAuthStore.getState().session?.localOnly) {
        rootNavigation?.navigate('ConnectAccount');
        return;
      }
      const { canonicalAccess, status } = useAccessStore.getState();
      if (
        !canonicalAccess?.canStartRating &&
        (canonicalAccess !== null ||
          status === 'ready' ||
          status === 'unconfigured' ||
          status === 'error')
      ) {
        rootNavigation?.navigate('Paywall', { source: 'rating' });
        return;
      }
      rootNavigation?.navigate('Analyze', { source });
    },
    [rootNavigation],
  );

  const runAction = useCallback(
    (action: () => void) => closeMenu(action),
    [closeMenu],
  );

  const actions: CoachAction[] = [
    {
      title: 'Auto Analyze',
      detail: 'Auto capture · validated scores only',
      icon: 'camera',
      accent: color.volt,
      onPress: () => runAction(() => openRatingFlow('camera')),
    },
    {
      title: 'Import Video',
      detail: 'Choose a real clip from this phone',
      icon: 'upload',
      accent: color.surfaceAlt,
      onPress: () => runAction(() => openRatingFlow('library')),
    },
    {
      title: 'Drill Library',
      detail: 'Guided drills you can search',
      icon: 'library',
      accent: color.surfaceAlt,
      onPress: () => runAction(() => rootNavigation?.navigate('DrillLibrary')),
    },
  ];

  return (
    <>
      <Animated.View testID="premium-tab-bar" style={[styles.bar, frameStyle]}>
        <View style={styles.barContent}>
          {props.state.routes.map((route, index) => {
            const name = route.name as keyof MainTabParams;
            const meta = TAB_META[name];
            if (name === 'Add') {
              return (
                <View key={route.key} style={styles.centerSlot}>
                  <CoachActionButton
                    innerRef={coachFabTarget}
                    largeContentViewer={largeContentViewer}
                    progress={progress}
                    open={menuOpen}
                    onPress={menuOpen ? () => closeMenu() : openMenu}
                  />
                  <Text
                    allowFontScaling={!largeContentViewer}
                    numberOfLines={1}
                    style={[type.micro, styles.centerLabel]}
                  >
                    COACH
                  </Text>
                </View>
              );
            }

            const isFocused = props.state.index === index;
            const tint = isFocused ? color.ink : color.inkSoft;
            const onPress = () => {
              const event = props.navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!isFocused && !event.defaultPrevented) {
                props.navigation.navigate(route.name, route.params);
              }
            };

            return (
              <Pressable
                key={route.key}
                ref={
                  name === 'Library'
                    ? libraryTabTarget
                    : name === 'Performance'
                      ? progressTabTarget
                      : undefined
                }
                accessibilityRole={Platform.OS === 'ios' ? 'button' : 'tab'}
                accessibilityLabel={meta.label}
                accessibilityState={{ selected: isFocused }}
                accessibilityShowsLargeContentViewer={largeContentViewer}
                accessibilityLargeContentTitle={meta.label}
                onLongPress={() =>
                  props.navigation.emit({
                    type: 'tabLongPress',
                    target: route.key,
                  })
                }
                onPress={onPress}
                style={({ pressed }) => [
                  styles.tab,
                  pressed && { opacity: 0.68 },
                ]}
              >
                <View
                  style={[styles.tabIcon, isFocused && styles.tabIconActive]}
                >
                  <Icon
                    name={meta.icon}
                    color={tint}
                    size={21}
                    strokeWidth={2}
                  />
                </View>
                <Text
                  allowFontScaling={!largeContentViewer}
                  numberOfLines={1}
                  style={[
                    type.micro,
                    styles.tabLabel,
                    { color: tint },
                    isFocused && styles.tabLabelActive,
                  ]}
                >
                  {meta.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Animated.View>

      <Modal
        animationType="none"
        onRequestClose={() => closeMenu()}
        statusBarTranslucent
        transparent
        visible={menuVisible}
      >
        <View style={styles.modal}>
          <Animated.View style={[styles.backdrop, backdropAnimatedStyle]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close coach actions"
              onPress={() => closeMenu()}
              style={styles.backdropPressable}
            />
          </Animated.View>
          <View
            pointerEvents="box-none"
            testID="coach-actions-panel"
            style={[
              styles.actions,
              { bottom: actionsBottom, maxHeight: actionsMaxHeight },
            ]}
          >
            <ScrollView
              testID="coach-actions-scroll"
              style={styles.actionsScroll}
              contentContainerStyle={styles.actionsContent}
              contentInsetAdjustmentBehavior="never"
              keyboardShouldPersistTaps="handled"
              bounces={false}
              removeClippedSubviews={false}
            >
              {actions.map((action, index) => (
                <CoachActionRow
                  action={action}
                  index={index}
                  key={action.title}
                  progress={progress}
                  reducedMotion={reducedMotion}
                />
              ))}
            </ScrollView>
          </View>
          <CoachActionButton
            bottom={rowBottom + ACTION_BOTTOM}
            largeContentViewer={largeContentViewer}
            overlay
            progress={progress}
            open
            onPress={() => closeMenu()}
          />
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  // Position, corner radius, side rules and shadow come from `frameStyle`,
  // which animates between `tabBarFloatingFrame` and `tabBarDockedFrame`.
  bar: {
    position: 'absolute',
    backgroundColor: color.tabBar,
    borderColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    shadowColor: color.shadow,
  },
  barContent: {
    height: TAB_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingHorizontal: 6,
  },
  tab: {
    flex: 1,
    minWidth: 52,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingTop: 4,
  },
  tabIcon: {
    width: 32,
    height: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabIconActive: { backgroundColor: color.surfaceAlt },
  tabLabel: { letterSpacing: 0.1 },
  tabLabelActive: { letterSpacing: 0 },
  centerSlot: {
    flex: 1,
    minWidth: 68,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 7,
  },
  actionButtonPressable: {
    position: 'absolute',
    top: -TAB_BAR_ACTION_RISE,
    width: ACTION_SIZE,
    height: ACTION_SIZE,
    borderRadius: ACTION_SIZE / 2,
  },
  actionButtonRing: {
    width: ACTION_SIZE,
    height: ACTION_SIZE,
    padding: 5,
    borderRadius: ACTION_SIZE / 2,
    backgroundColor: color.tabBar,
  },
  actionButton: {
    flex: 1,
    borderRadius: ACTION_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.volt,
    borderColor: color.inkTint,
    borderWidth: StyleSheet.hairlineWidth,
  },
  centerLabel: {
    color: color.ink,
    letterSpacing: 0.65,
  },
  modal: { flex: 1 },
  // Covers the floating bar too: with surface showing around the bar, a scrim
  // that stopped at its top edge would leave an undimmed band at the bottom.
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.overlayStrong,
  },
  backdropPressable: { flex: 1 },
  actions: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: space.lg,
  },
  actionsScroll: {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
    width: '100%',
    maxWidth: 380,
  },
  actionsContent: { gap: 10, alignItems: 'center' },
  actionRowWrap: { width: '100%', maxWidth: 380 },
  actionRow: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    ...shadow.floating,
  },
  actionRowPressed: { opacity: 0.9, transform: [{ scale: 0.99 }] },
  actionRowPressedReduced: { opacity: 0.9 },
  actionIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionCopy: { flex: 1, minWidth: 0 },
  actionTitle: { color: color.ink },
  actionDetail: { color: color.inkSoft, marginTop: 1 },
  overlayActionButton: {
    top: undefined,
    left: '50%',
    marginLeft: -ACTION_SIZE / 2,
  },
});
