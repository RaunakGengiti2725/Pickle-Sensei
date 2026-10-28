import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Card } from '../design/components';
import { color, space, type } from '../design/tokens';
import { getApiSession } from '../account/apiSession';
import type { RealAnalysisFact } from '../data/repository';
import {
  fetchPlayerRank,
  resolvePlayerRank,
  type ServerPlayerRank,
} from '../progress/playerRank';
import { useRankCelebrationStore } from '../progress/rankCelebration';
import {
  DUPR_LABEL,
  formatDupr,
  formatDuprDistance,
  formatTechniqueScore,
} from '../progress/duprEstimate';
import { RankIcon } from './RankIcon';

/**
 * The player's personal rank (Bronze → Silver → Gold → Platinum → Diamond).
 * Not a leaderboard — it never compares users. The rating is form-weighted:
 * each technique is scored from its most recent analyses (newest heaviest),
 * and techniques blend by evidence — so training visibly moves it.
 *
 * Self-contained on purpose: it takes the already-loaded local analysis
 * facts and fetches the account-saved rank itself, so the host screen only
 * renders `<PlayerRankCard facts={facts} />`.
 *
 * Every figure prints as an estimated DUPR (D-046) — the headline rating
 * with its "/10" reading beneath and the distance to the next tier — while
 * the tier math stays on the 0–10 rating. The host page carries the DUPR
 * disclaimer.
 */

export function PlayerRankCard(props: {
  facts: RealAnalysisFact[];
  /** Told whether the card shows an estimated rating (local or account),
   * so the host can keep the estimate disclaimer on screen with it. */
  onRatingShown?: (shown: boolean) => void;
}) {
  // Large text: the rating drops below the tier row so the tier name keeps
  // the card's full width.
  const stacked = useWindowDimensions().fontScale > 1.3;
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

  // Rank-shift ceremony: report every resolved rank; the store compares it
  // to the account's durable record and celebrates upward moves once.
  const maybeCelebrate = useRankCelebrationStore(s => s.maybeCelebrate);
  useEffect(() => {
    if (resolved) void maybeCelebrate(resolved.summary);
  }, [maybeCelebrate, resolved]);

  const { onRatingShown } = props;
  useEffect(() => {
    onRatingShown?.(resolved !== null);
  }, [onRatingShown, resolved]);

  if (!resolved) {
    return (
      <Card tone="dark" style={styles.card} testID="player-rank-card">
        <Text style={[type.micro, styles.eyebrow]}>PLAYER RANK</Text>
        <View style={styles.tierRow}>
          <RankIcon tier={null} size={46} />
          <View style={styles.flex}>
            <Text style={[type.h3, { color: color.onDark }]}>Unranked</Text>
            <Text style={[type.caption, styles.tierDetail]}>
              Your first scored analysis places you.
            </Text>
          </View>
        </View>
      </Card>
    );
  }

  const { summary } = resolved;
  const techniqueNoun =
    summary.techniqueCount === 1 ? 'technique' : 'techniques';
  const rating = (
    <View
      style={[styles.ratingWrap, stacked && styles.ratingStacked]}
      testID="player-rank-card-rating"
    >
      <Text style={styles.rating}>
        {formatDupr(summary.rating)}
        <Text style={[type.caption, styles.ratingScale]}>
          {` ${DUPR_LABEL}`}
        </Text>
      </Text>
      <Text style={[type.micro, styles.ratingTechnique]}>
        {formatTechniqueScore(summary.rating, 2)}
      </Text>
    </View>
  );

  return (
    <Card tone="dark" style={styles.card} testID="player-rank-card">
      <Text style={[type.micro, styles.eyebrow]}>PLAYER RANK</Text>
      <View
        accessible
        accessibilityLabel={`Player rank ${summary.tierLabel} ${
          summary.divisionLabel
        }. Estimated DUPR ${formatDupr(
          summary.rating,
        )}, technique rating ${summary.rating.toFixed(
          2,
        )} out of 10, from your current form across ${
          summary.techniqueCount
        } ${techniqueNoun}.`}
      >
        <View style={styles.tierRow}>
          <RankIcon tier={summary.tier} division={summary.division} size={52} />
          <View style={styles.flex}>
            <Text style={[type.h2, { color: color.onDark }]}>
              {summary.tierLabel}{' '}
              <Text style={{ color: color.onDarkMuted }}>
                {summary.divisionLabel}
              </Text>
            </Text>
            <Text style={[type.caption, styles.tierDetail]}>
              {summary.nextTier
                ? `${formatDuprDistance(
                    summary.rating,
                    summary.nextTier.minRating,
                  )} to ${summary.nextTier.label}`
                : 'Top tier — every new analysis defends it.'}
            </Text>
          </View>
          {stacked ? null : rating}
        </View>
        {stacked ? rating : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: {
    marginTop: space.md,
    backgroundColor: color.inkElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
  },
  eyebrow: { color: color.volt },
  ratingWrap: { alignItems: 'flex-end' },
  ratingStacked: { alignItems: 'flex-start', marginTop: space.md },
  rating: {
    ...type.score,
    color: color.onDark,
  },
  ratingScale: { color: color.onDarkSubtle },
  ratingTechnique: {
    color: color.onDarkFaint,
    fontVariant: ['tabular-nums'],
  },
  tierRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 4,
    marginTop: space.md,
  },
  tierDetail: { color: color.onDarkSubtle, marginTop: 2 },
});
