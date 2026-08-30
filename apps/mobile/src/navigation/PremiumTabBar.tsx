import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { NavigationProp } from '@react-navigation/native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import LinearGradient from 'react-native-linear-gradient';
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
import type { MainTabParams, RootStackParams } from './params';

const BAR_HEIGHT = 70;
const ACTION_SIZE = 68;
const ACTION_RISE = 24;

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
          pressed && styles.actionRowPressed,
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
          <Text numberOfLines={1} style={[type.caption, styles.actionDetail]}>
            {props.action.detail}
          </Text>
        </View>
        <Icon name="arrow" color={color.inkSoft} size={19} />
      </Pressable>
    </Animated.View>
  );
}

function GradientActionButton(props: {
  progress: SharedValue<number>;
  onPress: () => void;
  open: boolean;
  overlay?: boolean;
  bottom?: number;
}) {
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      {
        rotate: `${interpolate(props.progress.value, [0, 1], [0, 45])}deg`,
      },
      {
        scale: interpolate(props.progress.value, [0, 1], [1, 1.04]),
      },
    ],
  }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        props.open ? 'Close coach actions' : 'Open coach actions'
      }
      accessibilityState={{ expanded: props.open }}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.gradientButtonPressable,
        props.overlay && styles.overlayActionButton,
        props.bottom !== undefined && { bottom: props.bottom },
        pressed && { opacity: 0.9 },
      ]}
    >
      <Animated.View style={[styles.gradientButtonRing, animatedStyle]}>
        <LinearGradient
          colors={[color.volt, color.mint]}
          start={{ x: 0.08, y: 0.05 }}
          end={{ x: 0.95, y: 1 }}
          style={styles.gradientButton}
        >
          <Icon name="plus" color={color.ink} size={30} strokeWidth={2.25} />
        </LinearGradient>
      </Animated.View>
    </Pressable>
  );
}

export function PremiumTabBar(props: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(0);
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const motionDuration = reducedMotion ? 1 : 210;
  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
  }));

  useEffect(() => {
    progress.value = withTiming(menuOpen ? 1 : 0, {
      duration: motionDuration,
      easing: Easing.out(Easing.cubic),
    });
  }, [menuOpen, motionDuration, progress]);

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
    setMenuVisible(true);
    setMenuOpen(true);
  }, []);

  const closeMenu = useCallback(
    (after?: () => void) => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      setMenuOpen(false);
      closeTimer.current = setTimeout(() => {
        closeTimer.current = null;
        setMenuVisible(false);
        after?.();
      }, motionDuration);
    },
    [motionDuration],
  );

  const rootNavigation =
    props.navigation.getParent<NavigationProp<RootStackParams>>();

  const openRatingFlow = useCallback(
    async (source: 'camera' | 'library') => {
      if (useAuthStore.getState().session?.localOnly) {
        rootNavigation?.navigate('ConnectAccount');
        return;
      }
      let access = useAccessStore.getState().canonicalAccess;
      if (!access) {
        await useAccessStore.getState().initialize();
        access = useAccessStore.getState().canonicalAccess;
      }
      if (access?.canStartRating) {
        rootNavigation?.navigate('Analyze', { source });
        return;
      }
      rootNavigation?.navigate('Paywall', { source: 'rating' });
    },
    [rootNavigation],
  );

  const openLiveCourt = useCallback(async () => {
    if (useAuthStore.getState().session?.localOnly) {
      rootNavigation?.navigate('ConnectAccount');
      return;
    }
    let access = useAccessStore.getState().canonicalAccess;
    if (!access) {
      await useAccessStore.getState().initialize();
      access = useAccessStore.getState().canonicalAccess;
    }
    if (access?.canStartRating) {
      rootNavigation?.navigate('LiveCourt');
      return;
    }
    rootNavigation?.navigate('Paywall', { source: 'live_court' });
  }, [rootNavigation]);

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
      onPress: () => runAction(() => void openRatingFlow('camera')),
    },
    {
      title: 'Live Court',
      detail: 'Checks camera + model availability',
      icon: 'court',
      accent: color.mint,
      onPress: () => runAction(() => void openLiveCourt()),
    },
    {
      title: 'Import Video',
      detail: 'Choose a real clip from this phone',
      icon: 'upload',
      accent: color.flame,
      onPress: () => runAction(() => void openRatingFlow('library')),
    },
    {
      title: 'Drill Library',
      detail: 'Guided drills you can search',
      icon: 'library',
      accent: color.courtSoft,
      onPress: () =>
        runAction(() => rootNavigation?.navigate('DrillLibrary')),
    },
  ];

  return (
    <>
      <View
        style={[
          styles.bar,
          { height: BAR_HEIGHT + insets.bottom, paddingBottom: insets.bottom },
        ]}
      >
        <View style={styles.barContent}>
          {props.state.routes.map((route, index) => {
            const name = route.name as keyof MainTabParams;
            const meta = TAB_META[name];
            if (name === 'Add') {
              return (
                <View key={route.key} style={styles.centerSlot}>
                  <GradientActionButton
                    progress={progress}
                    open={menuOpen}
                    onPress={menuOpen ? () => closeMenu() : openMenu}
                  />
                  <Text style={[type.micro, styles.centerLabel]}>COACH</Text>
                </View>
              );
            }

            const isFocused = props.state.index === index;
            const tint = isFocused ? color.court : color.inkSoft;
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
                accessibilityRole="tab"
                accessibilityLabel={meta.label}
                accessibilityState={{ selected: isFocused }}
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
      </View>

      <Modal
        animationType="none"
        onRequestClose={() => closeMenu()}
        statusBarTranslucent
        transparent
        visible={menuVisible}
      >
        <View style={styles.modal}>
          <Animated.View
            style={[
              styles.backdrop,
              { bottom: BAR_HEIGHT + insets.bottom },
              backdropAnimatedStyle,
            ]}
          >
            <Pressable
              accessibilityLabel="Close coach actions"
              onPress={() => closeMenu()}
              style={styles.backdropPressable}
            />
          </Animated.View>
          <View
            pointerEvents="box-none"
            style={[
              styles.actions,
              { bottom: insets.bottom + BAR_HEIGHT + space.xl },
            ]}
          >
            {actions.map((action, index) => (
              <CoachActionRow
                action={action}
                index={index}
                key={action.title}
                progress={progress}
              />
            ))}
          </View>
          <GradientActionButton
            bottom={insets.bottom + 26}
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
  bar: {
    backgroundColor: color.tabBar,
    borderTopColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    shadowColor: color.shadow,
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.055,
    shadowRadius: 20,
    elevation: 14,
  },
  barContent: {
    height: BAR_HEIGHT,
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
  tabIconActive: { backgroundColor: color.courtSoft },
  tabLabel: {
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.1,
  },
  tabLabelActive: { letterSpacing: 0 },
  centerSlot: {
    flex: 1,
    minWidth: 68,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 7,
  },
  gradientButtonPressable: {
    position: 'absolute',
    top: -ACTION_RISE,
    width: ACTION_SIZE,
    height: ACTION_SIZE,
    borderRadius: ACTION_SIZE / 2,
  },
  gradientButtonRing: {
    width: ACTION_SIZE,
    height: ACTION_SIZE,
    padding: 5,
    borderRadius: ACTION_SIZE / 2,
    backgroundColor: color.tabBar,
    ...shadow.floating,
  },
  gradientButton: {
    flex: 1,
    borderRadius: ACTION_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: 'rgba(7,23,16,0.08)',
    borderWidth: StyleSheet.hairlineWidth,
  },
  centerLabel: {
    color: color.courtDeep,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.65,
  },
  modal: { flex: 1 },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: color.overlayStrong,
  },
  backdropPressable: { flex: 1 },
  actions: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: space.lg,
  },
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
  actionIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionCopy: { flex: 1 },
  actionTitle: { color: color.ink },
  actionDetail: { color: color.inkSoft, marginTop: 1 },
  overlayActionButton: {
    top: undefined,
    bottom: 26,
    left: '50%',
    marginLeft: -ACTION_SIZE / 2,
  },
});
