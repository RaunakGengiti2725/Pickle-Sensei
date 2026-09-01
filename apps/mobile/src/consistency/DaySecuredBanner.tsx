import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useReducedMotion } from '../design/components';
import { color, radius, shadow, space, type } from '../design/tokens';
import { flameIntensityForStreak } from './engine';
import { AnimatedFlame } from './FlameIcon';
import { useConsistencyStore } from './store';
import { plural } from '../util/plural';

/**
 * "Day 18 secured 🔥" — the immediate payoff after the first meaningful
 * training of the day. Springs up from the bottom of the result screen,
 * holds just long enough to read, and slides away on its own. Shows at most
 * once per day (the store's durable marker), and only for the day it names.
 */

const HOLD_MS = 3600;

export function DaySecuredBanner() {
  const consumeDaySecured = useConsistencyStore(s => s.consumeDaySecured);
  const pending = useConsistencyStore(s => s.daySecured);
  const [moment, setMoment] = useState<ReturnType<
    typeof consumeDaySecured
  > | null>(null);
  const [done, setDone] = useState(false);
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const entry = useSharedValue(0);

  useEffect(() => {
    if (done || moment || !pending) return;
    const consumed = consumeDaySecured();
    if (consumed) setMoment(consumed);
  }, [consumeDaySecured, done, moment, pending]);

  useEffect(() => {
    if (!moment) return;
    if (reduced) {
      entry.value = 1;
      const timeout = setTimeout(() => setDone(true), HOLD_MS);
      return () => clearTimeout(timeout);
    }
    entry.value = withSequence(
      withSpring(1, { damping: 14, stiffness: 160, mass: 0.8 }),
      withDelay(
        HOLD_MS,
        withTiming(
          0,
          { duration: 260, easing: Easing.in(Easing.quad) },
          finished => {
            if (finished) runOnJS(setDone)(true);
          },
        ),
      ),
    );
  }, [entry, moment, reduced]);

  const entryStyle = useAnimatedStyle(() => ({
    opacity: entry.value,
    transform: [{ translateY: (1 - entry.value) * 64 }],
  }));

  if (!moment || done) return null;

  const nextLine = moment.nextMilestone
    ? `Next: ${moment.nextMilestone.title} — ${
        moment.nextMilestone.daysAway
      } ${plural(moment.nextMilestone.daysAway, 'day')} away`
    : null;

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`Day ${moment.streak} secured. Plus ${
        moment.xpToday
      } momentum XP.${nextLine ? ` ${nextLine}.` : ''}`}
      style={[styles.banner, { bottom: insets.bottom + space.lg }, entryStyle]}
      testID="day-secured-banner"
    >
      <View style={styles.flameWrap}>
        <AnimatedFlame
          intensity={flameIntensityForStreak(moment.streak)}
          size={26}
        />
      </View>
      <View style={styles.body}>
        <Text style={[type.bodyBold, styles.title]}>
          Day {moment.streak} secured
        </Text>
        <Text style={[type.caption, styles.meta]} numberOfLines={1}>
          +{moment.xpToday} Momentum XP{nextLine ? ` · ${nextLine}` : ''}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    ...shadow.floating,
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    backgroundColor: color.inkElevated,
    borderRadius: radius.md,
    paddingVertical: space.sm + 4,
    paddingHorizontal: space.md,
  },
  flameWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,155,66,0.14)',
  },
  body: { flex: 1, minWidth: 0 },
  title: { color: color.onDark },
  meta: { color: color.onDarkMuted, marginTop: 1 },
});
