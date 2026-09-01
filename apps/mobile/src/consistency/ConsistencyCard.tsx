import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { PressableScale, RevealFill } from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { flameIntensityForStreak, type ConsistencySnapshot } from './engine';
import { AnimatedFlame } from './FlameIcon';
import { SHIELD_MAX_HELD } from './milestones';
import { plural } from '../util/plural';

/**
 * The CONSISTENCY block of the player hierarchy (skill ⁄ consistency ⁄
 * achievements). Streak, momentum level, shields, and the next reward in
 * one dark card; tapping it opens the full calendar. It never shows rating
 * numbers — discipline and ability stay visually separate systems.
 */
export function ConsistencyCard(props: {
  snapshot: ConsistencySnapshot | null;
  onPress: () => void;
}) {
  const snapshot = props.snapshot;
  const streak = snapshot?.currentStreak ?? 0;
  const momentum = snapshot?.momentum ?? {
    level: 1,
    xpIntoLevel: 0,
    xpForNextLevel: 40,
  };
  const fraction = Math.min(
    1,
    momentum.xpForNextLevel > 0
      ? momentum.xpIntoLevel / momentum.xpForNextLevel
      : 0,
  );
  const statusLine =
    !snapshot || snapshot.totalActivities === 0
      ? 'Your first analysis lights the flame.'
      : snapshot.atRisk
      ? 'No training yet today — one analysis keeps it alive.'
      : snapshot.trainedToday
      ? `Day ${streak} secured · ${snapshot.trainedLast7} of the last 7 days`
      : `You trained ${snapshot?.trainedLast7 ?? 0} of the last 7 days`;

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Consistency. ${streak} ${plural(
        streak,
        'day',
      )} training streak, momentum level ${
        momentum.level
      }. Opens the streak calendar.`}
      onPress={props.onPress}
      style={styles.card}
      testID="consistency-card"
    >
      <LinearGradient
        colors={[color.surfaceDark, '#123125']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.headerRow}>
        <Text style={[type.micro, styles.eyebrow]}>CONSISTENCY</Text>
        <View style={styles.shieldRow}>
          {Array.from({ length: SHIELD_MAX_HELD }, (_, index) => (
            <Icon
              key={index}
              name="shield"
              size={13}
              color={
                index < (snapshot?.shieldsAvailable ?? 0)
                  ? color.mint
                  : color.onDarkFaint
              }
            />
          ))}
        </View>
      </View>
      <View style={styles.mainRow}>
        <View style={styles.flameWrap}>
          <AnimatedFlame
            intensity={flameIntensityForStreak(streak)}
            size={34}
          />
        </View>
        <View style={styles.body}>
          <Text style={[type.h2, styles.streakText]}>
            {streak}{' '}
            <Text style={styles.streakUnit}>{plural(streak, 'day')}</Text>
          </Text>
          <Text style={[type.caption, styles.status]} numberOfLines={1}>
            {statusLine}
          </Text>
        </View>
        <Icon name="chevron" color={color.onDarkFaint} size={16} />
      </View>
      <View style={styles.momentumRow}>
        <Text style={[type.micro, styles.momentumLabel]}>
          MOMENTUM LV {momentum.level}
        </Text>
        <View style={styles.momentumTrack}>
          <RevealFill
            style={[
              styles.momentumFill,
              { width: `${Math.max(4, fraction * 100)}%` },
            ]}
          />
        </View>
        <Text style={[type.micro, styles.momentumXp]}>
          {snapshot?.momentumXp ?? 0} XP
        </Text>
      </View>
      {snapshot?.nextStreakMilestone ? (
        <Text style={[type.micro, styles.nextLine]}>
          NEXT: {snapshot.nextStreakMilestone.title.toUpperCase()} ·{' '}
          {snapshot.nextStreakMilestone.daysAway}{' '}
          {plural(snapshot.nextStreakMilestone.daysAway, 'DAY', 'DAYS')} AWAY
        </Text>
      ) : null}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceDark,
    overflow: 'hidden',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  eyebrow: { color: color.volt },
  shieldRow: { flexDirection: 'row', gap: 4 },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 4,
    marginTop: space.sm + 2,
  },
  flameWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,155,66,0.12)',
  },
  body: { flex: 1, minWidth: 0 },
  streakText: { color: color.onDark },
  streakUnit: { ...type.h3, color: color.onDarkMuted },
  status: { color: color.onDarkSubtle, marginTop: 2 },
  momentumRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.md,
  },
  momentumLabel: { color: color.onDarkMuted, letterSpacing: 0.8 },
  momentumTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.onDarkTint,
    overflow: 'hidden',
  },
  momentumFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: color.volt,
  },
  momentumXp: { color: color.onDarkSubtle, fontVariant: ['tabular-nums'] },
  nextLine: {
    color: color.onDarkFaint,
    marginTop: space.sm + 2,
    letterSpacing: 0.8,
  },
});
