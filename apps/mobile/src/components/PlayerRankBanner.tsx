import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {
  PLAYER_RANK_TIERS,
  RANK_CONFIDENCE_CAP,
  RANK_FORM_WINDOW,
} from '@pickle/shared-types';
import { useReducedMotion } from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { getApiSession } from '../account/apiSession';
import { formatDuprEstimate } from '../progress/duprEstimate';
import {
  fetchPlayerRank,
  resolvePlayerRank,
  type PlayerRankFactLike,
  type ServerPlayerRank,
} from '../progress/playerRank';
import { useRankCelebrationStore } from '../progress/rankCelebration';
import { flameIntensityForStreak } from '../consistency/engine';
import { AnimatedFlame } from '../consistency/FlameIcon';
import { RankIcon, RANK_TIER_STYLE } from './RankIcon';
import { plural } from '../util/plural';

/**
 * Home-page rank banner: the player's tier emblem, rating, and training
 * streak in one glanceable strip. Tapping the banner no longer leaves the
 * page — the banner unfolds in place with a brief transition, showing
 * the full tier ladder, the player's division, every contributing
 * technique, and how the form-weighted rating works. Tap again to fold it
 * away. The streak block is its own press target (→ the Consistency page).
 *
 * Data rules are unchanged from PlayerRankCard: account-saved rank when it
 * has seen the most evidence, local compute otherwise; no rank is ever
 * invented for an unranked player.
 */

const TOP_OF_SCALE = 10;
const FOLD_AWAY_MS = 180;

/** Fill fraction (0..1) of one tier segment on the ladder (same math as
 * PlayerRankCard / RankUpCelebration — every ladder must agree). */
function segmentFill(rating: number, index: number): number {
  const floor = PLAYER_RANK_TIERS[index]!.minRating;
  const ceiling = PLAYER_RANK_TIERS[index + 1]?.minRating ?? TOP_OF_SCALE;
  if (ceiling <= floor) return rating >= floor ? 1 : 0;
  return Math.max(0, Math.min(1, (rating - floor) / (ceiling - floor)));
}

function tierRangeLabel(index: number): string {
  const floor = PLAYER_RANK_TIERS[index]!.minRating;
  const ceiling = PLAYER_RANK_TIERS[index + 1]?.minRating ?? null;
  return ceiling === null
    ? `${floor.toFixed(1)}+`
    : `${floor.toFixed(1)} – ${(ceiling - 0.01).toFixed(2)}`;
}

export function PlayerRankBanner(props: {
  shots: readonly PlayerRankFactLike[];
  streakDays: number;
  streakAtRisk?: boolean;
  onPressStreak?: () => void;
}) {
  const [serverRank, setServerRank] = useState<ServerPlayerRank | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [foldOutMounted, setFoldOutMounted] = useState(false);
  const foldAwayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduced = useReducedMotion();
  const largeText = useWindowDimensions().fontScale >= 1.5;

  useEffect(
    () => () => {
      if (foldAwayTimer.current) clearTimeout(foldAwayTimer.current);
    },
    [],
  );

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

  // Rank-shift ceremony: report every resolved rank; the store compares it
  // to the account's durable record and celebrates upward moves once.
  const maybeCelebrate = useRankCelebrationStore(s => s.maybeCelebrate);
  useEffect(() => {
    if (resolved) void maybeCelebrate(resolved.summary);
  }, [maybeCelebrate, resolved]);

  const summary = resolved?.summary ?? null;
  const accent = summary
    ? RANK_TIER_STYLE[summary.tier].accent
    : color.onDarkSubtle;

  // ---- Tap choreography: brief unfold, with no ongoing motion. ------------
  const unfold = useSharedValue(0);

  const toggle = () => {
    const opening = !expanded;
    setExpanded(opening);
    if (foldAwayTimer.current) {
      clearTimeout(foldAwayTimer.current);
      foldAwayTimer.current = null;
    }
    if (opening) setFoldOutMounted(true);
    if (reduced) {
      unfold.value = opening ? 1 : 0;
      if (!opening) setFoldOutMounted(false);
      return;
    }
    if (opening) {
      unfold.value = withTiming(1, {
        duration: 220,
        easing: Easing.out(Easing.cubic),
      });
    } else {
      unfold.value = withTiming(0, {
        duration: FOLD_AWAY_MS,
        easing: Easing.in(Easing.quad),
      });
      foldAwayTimer.current = setTimeout(() => {
        foldAwayTimer.current = null;
        setFoldOutMounted(false);
      }, FOLD_AWAY_MS);
    }
  };

  const unfoldStyle = useAnimatedStyle(() => ({
    opacity: unfold.value,
    transform: [{ translateY: (1 - unfold.value) * -8 }],
  }));
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${unfold.value * 90}deg` }],
  }));

  const best = summary?.techniques[0] ?? null;
  const detailLine = summary
    ? `Best: ${
        best
          ? `${best.shotType.replace(/_/g, ' ')} ${best.score.toFixed(1)}`
          : '—'
      }${
        summary.nextTier
          ? ` · ${summary.nextTier.pointsNeeded.toFixed(2)} to ${
              summary.nextTier.label
            }`
          : ' · Top tier'
      }`
    : 'Your first scored analysis places you.';
  const rankLabel = summary
    ? `Player rank ${summary.tierLabel} ${
        summary.divisionLabel
      }, rating ${summary.rating.toFixed(2)} out of 10.`
    : 'Player rank: unranked.';
  const intensity = flameIntensityForStreak(props.streakDays);

  return (
    <View style={styles.banner} testID="player-rank-banner">
      <View style={[styles.row, largeText && styles.rowStacked]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${rankLabel} ${detailLine}`}
          accessibilityHint={
            expanded
              ? 'Collapses the rank details.'
              : 'Opens the rank details in place.'
          }
          accessibilityState={{ expanded }}
          onPress={toggle}
          style={[styles.mainPress, largeText && styles.mainPressStacked]}
          testID="player-rank-banner-toggle"
        >
          <RankIcon tier={summary?.tier ?? null} size={46} />
          <View style={[styles.body, largeText && styles.bodyStacked]}>
            <Text style={[type.micro, styles.eyebrow]}>PLAYER RANK</Text>
            <View style={[styles.tierRow, largeText && styles.tierRowStacked]}>
              <Text style={[type.h3, styles.tierLabel]}>
                {summary
                  ? `${summary.tierLabel} ${summary.divisionLabel}`
                  : 'Unranked'}
              </Text>
              {summary ? (
                <Text style={[type.bodyBold, { color: color.onDark }]}>
                  {summary.rating.toFixed(2)}
                  <Text style={[type.micro, styles.ratingScale]}>
                    {' /10 '}
                    {formatDuprEstimate(summary.rating)}
                  </Text>
                </Text>
              ) : null}
            </View>
            <Text
              style={[type.caption, styles.detail]}
              numberOfLines={largeText ? undefined : 1}
            >
              {detailLine}
            </Text>
          </View>
          <Animated.View
            style={[chevronStyle, largeText && styles.chevronStacked]}
          >
            <Icon name="chevron" color={color.onDarkFaint} size={16} />
          </Animated.View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.streakDays} ${plural(
            props.streakDays,
            'day',
          )} training streak${
            props.streakAtRisk ? ', at risk — no training yet today' : ''
          }. Opens the consistency calendar.`}
          disabled={!props.onPressStreak}
          onPress={props.onPressStreak}
          style={[styles.streakBlock, largeText && styles.streakBlockStacked]}
          testID="player-rank-banner-streak"
        >
          <View style={styles.streakTop}>
            <AnimatedFlame intensity={intensity} size={18} dark />
            <Text style={styles.streakCount}>{props.streakDays}</Text>
          </View>
          <Text
            style={[
              styles.streakLabel,
              props.streakAtRisk && props.streakDays > 0
                ? styles.streakLabelAtRisk
                : null,
            ]}
          >
            {props.streakAtRisk && props.streakDays > 0
              ? 'KEEP IT ALIVE'
              : 'DAY STREAK'}
          </Text>
        </Pressable>
      </View>

      {foldOutMounted ? (
        <Animated.View
          pointerEvents={expanded ? 'auto' : 'none'}
          style={[styles.expanded, unfoldStyle]}
          testID="player-rank-banner-fold-out"
        >
          <View style={styles.divider} />
          {summary ? (
            <>
              <View style={styles.ladder}>
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
              {PLAYER_RANK_TIERS.map((tier, index) => {
                const active = tier.key === summary.tier;
                return (
                  <View
                    key={tier.key}
                    style={[
                      styles.tierListRow,
                      active && styles.tierListRowActive,
                    ]}
                  >
                    <RankIcon tier={tier.key} size={26} />
                    <Text
                      style={[
                        type.caption,
                        styles.tierListLabel,
                        active && styles.tierListLabelActive,
                      ]}
                    >
                      {tier.label}
                    </Text>
                    <Text style={[type.micro, styles.tierListRange]}>
                      {tierRangeLabel(index)}
                    </Text>
                    {active ? (
                      <View
                        style={[styles.youPill, { backgroundColor: accent }]}
                      >
                        <Text style={[type.micro, styles.youPillText]}>
                          YOU · {summary.divisionLabel}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                );
              })}
              <View style={styles.techniqueWrap}>
                {summary.techniques.slice(0, 6).map(technique => (
                  <View key={technique.shotType} style={styles.techniqueChip}>
                    <Text style={[type.micro, styles.techniqueChipLabel]}>
                      {technique.shotType.replace(/_/g, ' ')}{' '}
                      {technique.score.toFixed(1)}
                    </Text>
                  </View>
                ))}
              </View>
              <Text style={[type.caption, styles.formulaNote]}>
                Current form: your last {RANK_FORM_WINDOW} swings of each stroke
                set its score — newest count most. Strokes with more evidence
                weigh more (up to {RANK_CONFIDENCE_CAP} analyses each).{' '}
                {summary.nextTier
                  ? `${summary.nextTier.pointsNeeded.toFixed(2)} to ${
                      summary.nextTier.label
                    }.`
                  : 'Top tier — every new analysis defends it.'}
              </Text>
            </>
          ) : (
            <Text style={[type.caption, styles.formulaNote]}>
              Complete one scored stroke analysis and your placement appears
              here — the ladder runs Bronze → Silver → Gold → Platinum →
              Diamond, each with divisions III → I.
            </Text>
          )}
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginTop: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.inkElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: space.md,
    gap: space.sm,
  },
  rowStacked: { flexDirection: 'column', alignItems: 'stretch' },
  mainPress: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 4,
  },
  mainPressStacked: {
    flex: 0,
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  chevronStacked: { position: 'absolute', right: 0, top: space.md },
  body: { flex: 1, minWidth: 0 },
  bodyStacked: { flex: 0, alignSelf: 'stretch' },
  eyebrow: { color: color.volt },
  tierRow: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: space.xxs,
    marginTop: 2,
  },
  tierRowStacked: { flexDirection: 'column', alignItems: 'stretch' },
  tierLabel: { color: color.onDark, flexShrink: 1 },
  ratingScale: { color: color.onDarkSubtle },
  detail: { color: color.onDarkSubtle, marginTop: 2 },
  streakBlock: {
    alignItems: 'center',
    flexShrink: 0,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: color.onDarkTint,
  },
  streakBlockStacked: { minHeight: 44, maxWidth: '100%' },
  streakTop: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  streakCount: {
    ...type.h3,
    color: color.onDark,
    fontVariant: ['tabular-nums'],
  },
  streakLabel: {
    ...type.micro,
    color: color.onDarkMuted,
    letterSpacing: 0.5,
    marginTop: 1,
  },
  streakLabelAtRisk: { color: color.flame },
  expanded: {
    paddingHorizontal: space.md,
    paddingBottom: space.md,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.lineMutedDark,
    marginBottom: space.md,
  },
  ladder: { flexDirection: 'row', gap: 5, marginBottom: space.sm },
  ladderSegment: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.onDarkTint,
    overflow: 'hidden',
  },
  ladderFill: { height: '100%', borderRadius: 3 },
  tierListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: radius.sm,
  },
  tierListRowActive: { backgroundColor: color.onDarkTint },
  tierListLabel: { color: color.onDarkMuted, flex: 1 },
  tierListLabelActive: { color: color.onDark },
  tierListRange: {
    color: color.onDarkMuted,
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.4,
  },
  youPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  youPillText: { color: color.surfaceDark, letterSpacing: 0.6 },
  techniqueWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: space.sm + 2,
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
  formulaNote: { color: color.onDarkSubtle, marginTop: space.sm + 2 },
});
