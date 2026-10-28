import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PressableScale } from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import {
  dayFromOrdinal,
  dayOrdinal,
  flameIntensityForStreak,
  type ConsistencySnapshot,
} from './engine';
import { AnimatedFlame } from './FlameIcon';
import { plural } from '../util/plural';

/**
 * The streak card on Progress: the current run, one status line and the
 * last seven days as dots; tapping it opens the full calendar (momentum,
 * shields and milestones live there). It never shows rating numbers —
 * discipline and ability stay visually separate systems.
 */

const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;

type WeekDayState = 'trained' | 'shielded' | 'rest';

/** The device's calendar day, for the moment before a snapshot exists. */
function deviceDay(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    '0',
  )}-${String(now.getDate()).padStart(2, '0')}`;
}

/** The last seven calendar days, oldest first, ending on the snapshot's day. */
export function lastSevenDays(snapshot: ConsistencySnapshot | null): Array<{
  day: string;
  letter: string;
  state: WeekDayState;
  today: boolean;
}> {
  const last = dayOrdinal(snapshot?.asOfDay ?? deviceDay());
  return Array.from({ length: 7 }, (_, index) => {
    const day = dayFromOrdinal(last - 6 + index);
    const entry = snapshot?.days[day];
    return {
      day,
      letter: WEEKDAY_LETTERS[new Date(`${day}T12:00:00Z`).getUTCDay()]!,
      state: entry ? (entry.shielded ? 'shielded' : 'trained') : 'rest',
      today: index === 6,
    };
  });
}

export function ConsistencyCard(props: {
  snapshot: ConsistencySnapshot | null;
  onPress: () => void;
}) {
  const snapshot = props.snapshot;
  const streak = snapshot?.currentStreak ?? 0;
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
      accessibilityLabel={`Streak: ${streak} ${plural(
        streak,
        'day',
      )}. Opens the streak calendar.`}
      onPress={props.onPress}
      style={styles.card}
      testID="consistency-card"
    >
      <View style={styles.mainRow}>
        <View style={styles.flameWrap}>
          <AnimatedFlame
            intensity={flameIntensityForStreak(streak)}
            size={30}
          />
        </View>
        <View style={styles.body}>
          <Text style={[type.h2, styles.streakText]}>
            {streak > 0 ? `${streak}-day streak` : 'No streak yet'}
          </Text>
          <Text style={[type.caption, styles.status]}>{statusLine}</Text>
        </View>
        <Icon name="chevron" color={color.inkSoft} size={16} />
      </View>
      <View style={styles.week} testID="consistency-week">
        {lastSevenDays(snapshot).map(day => (
          <View key={day.day} style={styles.weekDay}>
            <View
              style={[
                styles.dot,
                day.state === 'trained' && styles.dotTrained,
                day.state === 'shielded' && styles.dotShielded,
                day.today && day.state === 'rest' && styles.dotToday,
              ]}
              testID={`consistency-day-${day.state}`}
            >
              {day.state === 'trained' ? (
                <Icon
                  name="check"
                  size={14}
                  color={color.onDark}
                  strokeWidth={2.6}
                />
              ) : day.state === 'shielded' ? (
                <Icon name="shield" size={13} color={color.court} />
              ) : null}
            </View>
            <Text
              style={[
                type.micro,
                styles.weekLetter,
                day.today && styles.weekLetterToday,
              ]}
            >
              {day.letter}
            </Text>
          </View>
        ))}
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 4,
  },
  flameWrap: {
    width: 48,
    height: 48,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.flameTint,
  },
  body: { flex: 1, minWidth: 0 },
  streakText: { color: color.ink },
  status: { color: color.inkSoft, marginTop: 2 },
  week: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.md,
    paddingHorizontal: space.xs,
  },
  weekDay: { alignItems: 'center', gap: 6 },
  dot: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceAlt,
  },
  dotTrained: { backgroundColor: color.court },
  dotShielded: { backgroundColor: color.courtSoft },
  dotToday: { borderWidth: 1.5, borderColor: color.court },
  weekLetter: { color: color.inkSoft },
  weekLetterToday: { color: color.ink },
});
