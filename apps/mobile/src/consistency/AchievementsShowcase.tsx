import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { PressableScale, useReducedMotion } from '../design/components';
import { color, radius, space, type } from '../design/tokens';
import { specialistTitle, type ConsistencySnapshot } from './engine';
import {
  RARITY_LABEL,
  STREAK_MILESTONES,
  VOLUME_ACHIEVEMENTS,
  type AchievementRarity,
} from './milestones';
import { badgeArtFor, MilestoneBadge, RARITY_PALETTE } from './MilestoneBadge';
import { plural } from '../util/plural';

/**
 * The trophy rail. Earned badges shine in their rarity colors; locked ones
 * stay visible as charcoal silhouettes with honest progress copy ("13 days
 * away") — seeing the exact shape of Century Club is the advertisement, and
 * a slow shimmer on the NEXT reachable milestone keeps it wanted without a
 * single popup. Tap any badge for its story.
 */

interface ShowcaseEntry {
  id: string;
  title: string;
  blurb: string;
  reward: string;
  rarity: AchievementRarity;
  earned: boolean;
  earnedOnDay: string | null;
  progressLabel: string | null;
  /** The next milestone the current run reaches — wears the shimmer. */
  isNext: boolean;
}

function buildEntries(snapshot: ConsistencySnapshot): ShowcaseEntry[] {
  const earnedById = new Map(snapshot.earned.map(e => [e.id, e]));
  const entries: ShowcaseEntry[] = STREAK_MILESTONES.map(milestone => {
    const earned = earnedById.get(milestone.id);
    const daysAway = milestone.days - snapshot.currentStreak;
    return {
      id: milestone.id,
      title: milestone.title,
      blurb: milestone.blurb,
      reward: milestone.reward,
      rarity: milestone.rarity,
      earned: Boolean(earned),
      earnedOnDay: earned?.earnedOnDay ?? null,
      progressLabel: earned
        ? null
        : `${daysAway} ${plural(daysAway, 'day')} away`,
      isNext: snapshot.nextStreakMilestone?.id === milestone.id,
    };
  });
  const sessions = earnedById.get(VOLUME_ACHIEVEMENTS.sessions100.id);
  entries.push({
    id: VOLUME_ACHIEVEMENTS.sessions100.id,
    title: VOLUME_ACHIEVEMENTS.sessions100.title,
    blurb: VOLUME_ACHIEVEMENTS.sessions100.blurb,
    reward: VOLUME_ACHIEVEMENTS.sessions100.reward,
    rarity: VOLUME_ACHIEVEMENTS.sessions100.rarity,
    earned: Boolean(sessions),
    earnedOnDay: sessions?.earnedOnDay ?? null,
    progressLabel: sessions
      ? null
      : `${snapshot.totalActivities} of ${VOLUME_ACHIEVEMENTS.sessions100.threshold}`,
    isNext: false,
  });
  const specialist = earnedById.get(VOLUME_ACHIEVEMENTS.specialist.id);
  entries.push({
    id: VOLUME_ACHIEVEMENTS.specialist.id,
    title: specialist?.detail
      ? specialistTitle(specialist.detail)
      : VOLUME_ACHIEVEMENTS.specialist.title,
    blurb: VOLUME_ACHIEVEMENTS.specialist.blurb,
    reward: VOLUME_ACHIEVEMENTS.specialist.reward,
    rarity: VOLUME_ACHIEVEMENTS.specialist.rarity,
    earned: Boolean(specialist),
    earnedOnDay: specialist?.earnedOnDay ?? null,
    progressLabel: specialist ? null : '25 scored on one stroke',
    isNext: false,
  });
  return entries;
}

/** Slow diagonal gloss sweep — the "look at me" on the next milestone. */
function Shimmer(props: { active: boolean }) {
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);
  const run = props.active && !reduced;

  useEffect(() => {
    if (!run) {
      progress.value = 0;
      return;
    }
    progress.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.quad) }),
        withDelay(2200, withTiming(0, { duration: 0 })),
      ),
      -1,
    );
    return () => cancelAnimation(progress);
  }, [progress, run]);

  const style = useAnimatedStyle(() => ({
    opacity: progress.value <= 0 || progress.value >= 1 ? 0 : 0.5,
    transform: [
      { translateX: -60 + progress.value * 150 },
      { rotate: '18deg' },
    ],
  }));

  if (!run) return null;
  return <Animated.View pointerEvents="none" style={[styles.shimmer, style]} />;
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Formats a YYYY-MM-DD engine day key in the device locale. The key is a
 * calendar day, not an instant, so it is formatted as that day in UTC —
 * never as an instant read back through the device zone, which names the
 * neighbouring day at large offsets. Returns the key itself when it is not a
 * valid day.
 */
export function formatDayKey(
  day: string,
  options: Pick<Intl.DateTimeFormatOptions, 'weekday' | 'month' | 'day'>,
): string {
  const match = DAY_KEY.exec(day);
  if (!match) return day;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const dayOfMonth = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (
    Number.isNaN(utc.getTime()) ||
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== dayOfMonth
  ) {
    return day;
  }
  return utc.toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
}

function formatEarnedDay(day: string): string {
  return formatDayKey(day, { month: 'short', day: 'numeric' });
}

export function AchievementsShowcase(props: {
  snapshot: ConsistencySnapshot;
  dark?: boolean;
}) {
  const entries = useMemo(() => buildEntries(props.snapshot), [props.snapshot]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = entries.find(entry => entry.id === selectedId) ?? null;
  const fg = props.dark ? color.onDark : color.ink;
  const fgSoft = props.dark ? color.onDarkSubtle : color.inkSoft;
  const earnedCount = entries.filter(entry => entry.earned).length;

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rail}
        accessibilityLabel={`Achievements: ${earnedCount} of ${entries.length} earned.`}
      >
        {entries.map(entry => {
          const art = badgeArtFor(entry.id);
          return (
            <PressableScale
              key={entry.id}
              accessibilityLabel={`${entry.title}. ${
                entry.earned
                  ? `Earned ${
                      entry.earnedOnDay
                        ? formatEarnedDay(entry.earnedOnDay)
                        : ''
                    }`
                  : `Locked. ${entry.progressLabel ?? ''}`
              }`}
              accessibilityState={{ selected: selectedId === entry.id }}
              onPress={() =>
                setSelectedId(current =>
                  current === entry.id ? null : entry.id,
                )
              }
              style={[
                styles.badgeCell,
                selectedId === entry.id && styles.badgeCellSelected,
              ]}
            >
              <View style={styles.badgeArt}>
                <MilestoneBadge
                  glyph={art.glyph}
                  {...(art.value !== undefined ? { value: art.value } : {})}
                  rarity={entry.rarity}
                  earned={entry.earned}
                  size={64}
                />
                <Shimmer active={entry.isNext && !entry.earned} />
              </View>
              <Text
                numberOfLines={1}
                style={[
                  type.micro,
                  styles.badgeTitle,
                  { color: entry.earned ? fg : fgSoft },
                ]}
              >
                {entry.title}
              </Text>
              <Text
                numberOfLines={1}
                style={[type.micro, styles.badgeMeta, { color: fgSoft }]}
              >
                {entry.earned
                  ? entry.earnedOnDay
                    ? formatEarnedDay(entry.earnedOnDay)
                    : 'Earned'
                  : entry.progressLabel}
              </Text>
            </PressableScale>
          );
        })}
      </ScrollView>
      {selected ? (
        <View
          style={[styles.detail, props.dark && styles.detailDark]}
          accessibilityLiveRegion="polite"
        >
          <View style={styles.detailHeader}>
            <Text style={[type.bodyBold, { color: fg }]}>{selected.title}</Text>
            <View
              style={[
                styles.rarityPill,
                { backgroundColor: RARITY_PALETTE[selected.rarity].tint },
              ]}
            >
              <Text
                style={[
                  type.micro,
                  { color: RARITY_PALETTE[selected.rarity].accent },
                ]}
              >
                {RARITY_LABEL[selected.rarity].toUpperCase()}
              </Text>
            </View>
          </View>
          <Text style={[type.caption, { color: fgSoft, marginTop: 3 }]}>
            {selected.blurb}
          </Text>
          <Text style={[type.caption, styles.detailReward, { color: fg }]}>
            {selected.earned ? 'Unlocked' : 'Unlocks'}: {selected.reward}
            {!selected.earned && selected.progressLabel
              ? ` · ${selected.progressLabel}`
              : ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { gap: space.sm + 2, paddingVertical: 2, paddingRight: space.md },
  badgeCell: {
    width: 92,
    alignItems: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: 4,
    borderRadius: radius.md,
  },
  badgeCellSelected: { backgroundColor: color.inkTint },
  badgeArt: { borderRadius: radius.sm, overflow: 'hidden' },
  badgeTitle: { marginTop: 7, letterSpacing: 0.4 },
  badgeMeta: { marginTop: 2, fontSize: 10, letterSpacing: 0.3 },
  shimmer: {
    position: 'absolute',
    top: -12,
    bottom: -12,
    width: 26,
    backgroundColor: 'rgba(255,255,255,0.6)',
  },
  detail: {
    marginTop: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surfaceAlt,
  },
  detailDark: { backgroundColor: color.onDarkTint },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  rarityPill: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  detailReward: { marginTop: space.sm },
});
