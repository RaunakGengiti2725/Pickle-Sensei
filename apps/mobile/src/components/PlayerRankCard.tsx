import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PLAYER_RANK_TIERS } from '@pickle/shared-types';
import { Card } from '../design/components';
import { color, radius, space, type } from '../design/tokens';
import { getApiSession } from '../account/apiSession';
import type { RealAnalysisFact } from '../data/repository';
import {
  fetchPlayerRank,
  resolvePlayerRank,
  type ServerPlayerRank,
} from '../progress/playerRank';
import { RankIcon, RANK_TIER_STYLE } from './RankIcon';

/**
 * The player's personal rank (Bronze → Silver → Gold → Platinum → Diamond).
 * Not a leaderboard — it never compares users. The rating is the average of
 * each technique's LATEST scored analysis, so every analysis moves it.
 *
 * Self-contained on purpose: it takes the already-loaded local analysis
 * facts and fetches the account-saved rank itself, so the host screen only
 * renders `<PlayerRankCard facts={facts} />`.
 */

const TOP_OF_SCALE = 10;

/** Fill fraction (0..1) of one tier segment on the ladder. */
function segmentFill(rating: number, index: number): number {
  const floor = PLAYER_RANK_TIERS[index]!.minRating;
  const ceiling = PLAYER_RANK_TIERS[index + 1]?.minRating ?? TOP_OF_SCALE;
  if (ceiling <= floor) return rating >= floor ? 1 : 0;
  return Math.max(0, Math.min(1, (rating - floor) / (ceiling - floor)));
}

export function PlayerRankCard(props: { facts: RealAnalysisFact[] }) {
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
        // Offline or server trouble: the locally computed rank stands in;
        // nothing is invented.
        if (active) setServerRank(null);
      });
    return () => {
      active = false;
    };
  }, [props.facts]);

  const resolved = useMemo(
    () => resolvePlayerRank(props.facts, serverRank),
    [props.facts, serverRank],
  );

  if (!resolved) {
    return (
      <Card tone="dark" style={styles.card} testID="player-rank-card">
        <View style={styles.headerRow}>
          <Text style={[type.micro, styles.eyebrow]}>PLAYER RANK</Text>
        </View>
        <View style={styles.unrankedRow}>
          <RankIcon tier={null} size={46} />
          <View style={styles.flex}>
            <Text style={[type.h3, { color: color.onDark }]}>Unranked</Text>
            <Text style={[type.caption, styles.unrankedCopy]}>
              Your first scored analysis places you. Each technique’s latest
              score counts toward your rank.
            </Text>
          </View>
        </View>
      </Card>
    );
  }

  const { summary, source } = resolved;
  const tierStyle = RANK_TIER_STYLE[summary.tier];
  const techniqueNoun =
    summary.techniqueCount === 1 ? 'technique' : 'techniques';
  const sourceNote =
    source === 'account'
      ? 'Saved to your account.'
      : 'Computed on this device — syncs to your account automatically.';

  return (
    <Card tone="dark" style={styles.card} testID="player-rank-card">
      <View style={styles.headerRow}>
        <Text style={[type.micro, styles.eyebrow]}>PLAYER RANK</Text>
        <View style={styles.ratingWrap}>
          <Text style={[styles.rating, { color: tierStyle.accent }]}>
            {summary.rating.toFixed(2)}
          </Text>
          <Text style={[type.caption, styles.ratingScale]}>/ 10</Text>
        </View>
      </View>

      <View
        accessibilityLabel={`Player rank ${summary.tierLabel}. Rating ${summary.rating.toFixed(
          2,
        )} out of 10, averaged from your latest score in ${
          summary.techniqueCount
        } ${techniqueNoun}.`}
        style={styles.tierRow}
      >
        <RankIcon tier={summary.tier} size={52} />
        <View style={styles.flex}>
          <Text style={[type.h2, { color: color.onDark }]}>
            {summary.tierLabel}
          </Text>
          <Text style={[type.caption, styles.tierDetail]}>
            {summary.nextTier
              ? `${summary.nextTier.pointsNeeded.toFixed(2)} to ${
                  summary.nextTier.label
                }`
              : 'Top tier — every new analysis defends it.'}
          </Text>
        </View>
      </View>

      <View
        accessibilityLabel={`Rank ladder position: ${summary.tierLabel}`}
        style={styles.ladder}
      >
        {PLAYER_RANK_TIERS.map((tier, index) => {
          const fill = segmentFill(summary.rating, index);
          return (
            <View key={tier.key} style={styles.ladderSegment}>
              {fill > 0 ? (
                <View
                  style={[
                    styles.ladderFill,
                    {
                      width: `${fill * 100}%`,
                      backgroundColor: RANK_TIER_STYLE[tier.key].accent,
                    },
                  ]}
                />
              ) : null}
            </View>
          );
        })}
      </View>

      <View style={styles.techniqueWrap}>
        {summary.techniques.map(technique => (
          <View key={technique.shotType} style={styles.techniqueChip}>
            <Text style={[type.micro, styles.techniqueChipLabel]}>
              {technique.shotType.replace(/_/g, ' ')}{' '}
              {technique.score.toFixed(1)}
            </Text>
          </View>
        ))}
      </View>

      <Text style={[type.caption, styles.formulaNote]}>
        Average of your latest score in {summary.techniqueCount} {techniqueNoun}{' '}
        · every analysis moves it. {sourceNote}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { marginTop: space.md },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  eyebrow: { color: color.volt },
  ratingWrap: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  rating: {
    ...type.h2,
    fontVariant: ['tabular-nums'],
  },
  ratingScale: { color: color.onDarkSubtle },
  tierRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 4,
    marginTop: space.md,
  },
  tierDetail: { color: color.onDarkSubtle, marginTop: 2 },
  ladder: {
    flexDirection: 'row',
    gap: 5,
    marginTop: space.md,
  },
  ladderSegment: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.onDarkTint,
    overflow: 'hidden',
  },
  ladderFill: { height: '100%', borderRadius: 3 },
  techniqueWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: space.md,
  },
  techniqueChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: color.onDarkTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineMutedDark,
  },
  techniqueChipLabel: {
    color: color.onDark,
    letterSpacing: 0.4,
    textTransform: 'capitalize',
  },
  formulaNote: { color: color.onDarkSubtle, marginTop: space.md },
  unrankedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 4,
    marginTop: space.md,
  },
  unrankedCopy: { color: color.onDarkSubtle, marginTop: 2 },
});
