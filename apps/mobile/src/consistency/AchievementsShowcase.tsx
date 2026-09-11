import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { PressableScale } from '../design/components';
import { color, radius, space, type } from '../design/tokens';
import {
  formatDayKey,
  specialistTitle,
  type ConsistencySnapshot,
} from './engine';
import {
  RARITY_LABEL,
  STREAK_MILESTONES,
  VOLUME_ACHIEVEMENTS,
  type AchievementRarity,
} from './milestones';
import { badgeArtFor, MilestoneBadge, RARITY_PALETTE } from './MilestoneBadge';
import { plural } from '../util/plural';

/**
 * The achievement rail. Every badge is its own insignia in its rarity's
 * material (`MilestoneBadge`); locked ones stay visible as charcoal
 * silhouettes with honest progress copy ("13 days away"). The next
 * reachable milestone has a quiet outline, while the selected badge has a
 * flat contextual surface. Tap any badge for its story and a rarity label
 * tinted in the same material.
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
  /** The next milestone the current run reaches — marked by an outline. */
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

/** A short earned-date label keeps the rail focused on training history. */
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
                entry.isNext && !entry.earned
                  ? props.dark
                    ? styles.badgeCellNextDark
                    : styles.badgeCellNext
                  : null,
                selectedId === entry.id
                  ? props.dark
                    ? styles.badgeCellSelectedDark
                    : styles.badgeCellSelected
                  : null,
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
              </View>
              <Text
                numberOfLines={2}
                style={[
                  type.micro,
                  styles.badgeTitle,
                  { color: entry.earned ? fg : fgSoft },
                ]}
              >
                {entry.title}
              </Text>
              <Text
                numberOfLines={2}
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
              testID="achievement-rarity-pill"
            >
              <Text
                style={[
                  type.micro,
                  {
                    color: props.dark
                      ? RARITY_PALETTE[selected.rarity].accent
                      : RARITY_PALETTE[selected.rarity].deep,
                  },
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
    width: 112,
    alignItems: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: 4,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
  badgeCellNext: { borderColor: color.line },
  badgeCellNextDark: { borderColor: color.lineMutedDark },
  badgeCellSelected: {
    backgroundColor: color.inkTint,
    borderColor: color.courtDeep,
  },
  badgeCellSelectedDark: {
    backgroundColor: color.onDarkTintFaint,
    borderColor: color.volt,
  },
  badgeArt: { borderRadius: radius.sm },
  badgeTitle: { marginTop: 7, letterSpacing: 0.4, textAlign: 'center' },
  badgeMeta: { marginTop: 2, letterSpacing: 0.3, textAlign: 'center' },
  detail: {
    marginTop: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  detailDark: {
    backgroundColor: color.inkElevated,
    borderColor: color.lineDark,
  },
  detailHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
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
