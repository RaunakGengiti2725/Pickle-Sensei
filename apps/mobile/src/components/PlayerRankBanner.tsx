import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { PressableScale } from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { getApiSession } from '../account/apiSession';
import {
  fetchPlayerRank,
  resolvePlayerRank,
  type PlayerRankFactLike,
  type ServerPlayerRank,
} from '../progress/playerRank';
import { RankIcon, RANK_TIER_STYLE } from './RankIcon';

/**
 * Home-page rank banner: the player's tier emblem, rating, capture streak,
 * and current best technique in one glanceable strip. Same data rules as
 * PlayerRankCard — the rank is the average of each technique's latest scored
 * analysis (account-saved state when it has seen the most evidence, local
 * compute otherwise), and no rank is ever invented for an unranked player.
 */
export function PlayerRankBanner(props: {
  shots: readonly PlayerRankFactLike[];
  streakDays: number;
  onPress?: () => void;
}) {
  const [serverRank, setServerRank] = useState<ServerPlayerRank | null>(null);

  useEffect(() => {
    let active = true;
    const session = getApiSession();
    if (!session) {
      setServerRank(null);
      return;
    }
    void fetchPlayerRank(session)
      .then(rank => {
        if (active) setServerRank(rank);
      })
      .catch(() => {
        // Offline or server trouble: the locally computed rank stands in.
        if (active) setServerRank(null);
      });
    return () => {
      active = false;
    };
  }, [props.shots]);

  const resolved = useMemo(
    () => resolvePlayerRank(props.shots, serverRank),
    [props.shots, serverRank],
  );

  const summary = resolved?.summary ?? null;
  const accent = summary
    ? RANK_TIER_STYLE[summary.tier].accent
    : color.onDarkSubtle;
  const best = summary?.techniques[0] ?? null;
  const detailLine = summary
    ? `Best: ${best ? `${best.shotType.replace(/_/g, ' ')} ${best.score.toFixed(1)}` : '—'}${
        summary.nextTier
          ? ` · ${summary.nextTier.pointsNeeded.toFixed(2)} to ${summary.nextTier.label}`
          : ' · Top tier'
      }`
    : 'Your first scored analysis places you.';
  const rankLabel = summary
    ? `Player rank ${summary.tierLabel}, rating ${summary.rating.toFixed(2)} out of 10.`
    : 'Player rank: unranked.';

  return (
    <PressableScale
      {...(props.onPress
        ? { onPress: props.onPress, accessibilityRole: 'button' as const }
        : {})}
      accessibilityLabel={`${rankLabel} ${props.streakDays} day capture streak. ${detailLine}`}
      style={styles.banner}
      testID="player-rank-banner"
    >
      <LinearGradient
        colors={[color.courtDeep, color.surfaceDark]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />
      <RankIcon tier={summary?.tier ?? null} size={46} />
      <View style={styles.body}>
        <Text style={[type.micro, styles.eyebrow]}>PLAYER RANK</Text>
        <View style={styles.tierRow}>
          <Text style={[type.h3, styles.tierLabel]} numberOfLines={1}>
            {summary ? summary.tierLabel : 'Unranked'}
          </Text>
          {summary ? (
            <Text style={[type.bodyBold, { color: accent }]}>
              {summary.rating.toFixed(2)}
              <Text style={[type.micro, styles.ratingScale]}> /10</Text>
            </Text>
          ) : null}
        </View>
        <Text style={[type.caption, styles.detail]} numberOfLines={1}>
          {detailLine}
        </Text>
      </View>
      <View style={styles.streakBlock}>
        <View style={styles.streakTop}>
          <Icon name="flame" color={color.flame} size={16} />
          <Text style={styles.streakCount}>{props.streakDays}</Text>
        </View>
        <Text style={styles.streakLabel}>DAY STREAK</Text>
      </View>
      {props.onPress ? (
        <Icon name="chevron" color={color.onDarkFaint} size={16} />
      ) : null}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 4,
    marginTop: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceDark,
    overflow: 'hidden',
  },
  body: { flex: 1, minWidth: 0 },
  eyebrow: { color: color.volt },
  tierRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginTop: 2,
  },
  tierLabel: { color: color.onDark, flexShrink: 1 },
  ratingScale: { color: color.onDarkSubtle },
  detail: { color: color.onDarkSubtle, marginTop: 2 },
  streakBlock: { alignItems: 'center', flexShrink: 0 },
  streakTop: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  streakCount: {
    ...type.h3,
    color: color.onDark,
    fontVariant: ['tabular-nums'],
  },
  streakLabel: {
    ...type.micro,
    color: color.onDarkFaint,
    fontSize: 9,
    letterSpacing: 0.5,
    marginTop: 1,
  },
});
