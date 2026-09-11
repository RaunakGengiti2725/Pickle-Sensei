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
import {
  fetchPlayerRank,
  resolvePlayerRank,
  type PlayerRankFactLike,
  type ServerPlayerRank,
} from '../progress/playerRank';
import { useRankCelebrationStore } from '../progress/rankCelebration';
import {
  DUPR_ESTIMATE_NOTE,
  DUPR_LABEL,
  duprFromScore,
  formatDupr,
  formatDuprDistance,
  formatTechniqueScore,
} from '../progress/duprEstimate';
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
 *
 * Every rating figure here is printed as an estimated DUPR (D-046): the
 * headline rating (with its "/10" reading beneath), the tier ranges, the
 * distance to the next tier and the per-technique chips. The tier math
 * itself stays on the 0–10 rating; only the display converts.
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

/** The tier's DUPR band, e.g. "4.10 – 4.99" or "6.50+" for the top tier. */
export function tierRangeLabel(index: number): string {
  const floor = PLAYER_RANK_TIERS[index]!.minRating;
  const ceiling = PLAYER_RANK_TIERS[index + 1]?.minRating ?? null;
  return ceiling === null
    ? `${formatDupr(floor)}+`
    : `${formatDupr(floor)} – ${(duprFromScore(ceiling) - 0.01).toFixed(2)}`;
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
  const { width, fontScale } = useWindowDimensions();
  const stacked = fontScale >= 1.5 || width / fontScale < 360;

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
          ? `${best.shotType.replace(/_/g, ' ')} ${formatDupr(best.score)}`
          : '—'
      }${
        summary.nextTier
          ? ` · ${formatDuprDistance(
              summary.rating,
              summary.nextTier.minRating,
            )} to ${summary.nextTier.label}`
          : ' · Top tier'
      }`
    : 'Your first scored analysis places you.';
  const rankLabel = summary
    ? `Player rank ${summary.tierLabel} ${
        summary.divisionLabel
      }, estimated DUPR ${formatDupr(
        summary.rating,
      )}, technique rating ${summary.rating.toFixed(2)} out of 10.`
    : 'Player rank: unranked.';
  const intensity = flameIntensityForStreak(props.streakDays);

  return (
    <View style={styles.banner} testID="player-rank-banner">
      <View
        style={[styles.row, stacked && styles.rowStacked]}
        testID="player-rank-banner-row"
      >
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
          style={[styles.mainPress, stacked && styles.mainPressStacked]}
          testID="player-rank-banner-toggle"
        >
          <View style={stacked && styles.emblemStacked}>
            <RankIcon
              tier={summary?.tier ?? null}
              division={summary?.division ?? null}
              size={46}
            />
          </View>
          <View
            style={[styles.body, stacked && styles.bodyStacked]}
            testID="player-rank-banner-body"
          >
            <Text style={[type.micro, styles.eyebrow]}>PLAYER RANK</Text>
            <View
              style={[styles.tierRow, stacked && styles.tierRowStacked]}
              testID="player-rank-banner-tier"
            >
              <Text style={[type.h3, styles.tierLabel]}>
                {summary
                  ? `${summary.tierLabel} ${summary.divisionLabel}`
                  : 'Unranked'}
              </Text>
              {summary ? (
                <View style={styles.ratingBlock}>
                  <Text
                    style={[
                      type.bodyBold,
                      styles.rating,
                      { color: color.onDark },
                    ]}
                    accessibilityLabel={`Estimated DUPR ${formatDupr(
                      summary.rating,
                    )}, technique rating ${summary.rating.toFixed(
                      2,
                    )} out of 10`}
                    testID="player-rank-banner-rating"
                  >
                    {formatDupr(summary.rating)}
                    <Text style={[type.micro, styles.ratingScale]}>
                      {` ${DUPR_LABEL}`}
                    </Text>
                  </Text>
                  <Text
                    style={[type.micro, styles.ratingTechnique]}
                    testID="player-rank-banner-technique-rating"
                  >
                    {formatTechniqueScore(summary.rating, 2)}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text style={[type.caption, styles.detail]}>{detailLine}</Text>
          </View>
          <Animated.View
            style={[chevronStyle, stacked && styles.chevronStacked]}
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
          style={[styles.streakBlock, stacked && styles.streakBlockStacked]}
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
                      stacked && styles.tierListRowStacked,
                    ]}
                    testID={`player-rank-banner-tier-${tier.key}`}
                  >
                    <RankIcon tier={tier.key} size={26} />
                    <Text
                      style={[
                        type.caption,
                        styles.tierListLabel,
                        active && styles.tierListLabelActive,
                        stacked && styles.tierListLabelStacked,
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
                      {formatDupr(technique.score)}
                    </Text>
                  </View>
                ))}
              </View>
              <Text style={[type.caption, styles.formulaNote]}>
                Current form: your last {RANK_FORM_WINDOW} swings of each stroke
                set its score — newest count most. Strokes with more evidence
                weigh more (up to {RANK_CONFIDENCE_CAP} analyses each).{' '}
                {summary.nextTier
                  ? `${formatDuprDistance(
                      summary.rating,
                      summary.nextTier.minRating,
                    )} to ${summary.nextTier.label}.`
                  : 'Top tier — every new analysis defends it.'}
              </Text>
              <Text
                style={[type.caption, styles.formulaNote]}
                testID="player-rank-banner-dupr-note"
              >
                {DUPR_ESTIMATE_NOTE}
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
    flexWrap: 'wrap',
    alignItems: 'center',
    padding: space.md,
    gap: space.sm,
  },
  rowStacked: {
    flexDirection: 'column',
    flexWrap: 'nowrap',
    alignItems: 'stretch',
  },
  mainPress: {
    minHeight: 44,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 200,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 4,
  },
  mainPressStacked: {
    width: '100%',
    flexBasis: 'auto',
    flexGrow: 0,
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  emblemStacked: { alignSelf: 'flex-start' },
  chevronStacked: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 44,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, minWidth: 0 },
  bodyStacked: { flex: 0, width: '100%' },
  eyebrow: { color: color.volt },
  tierRow: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: space.xxs,
    marginTop: 2,
  },
  tierRowStacked: { flexDirection: 'column', alignItems: 'stretch' },
  tierLabel: { color: color.onDark, flexShrink: 1, maxWidth: '100%' },
  ratingBlock: { alignItems: 'flex-start', maxWidth: '100%' },
  rating: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '100%',
    fontVariant: ['tabular-nums'],
  },
  ratingScale: { color: color.onDarkSubtle },
  ratingTechnique: {
    color: color.onDarkFaint,
    fontVariant: ['tabular-nums'],
  },
  detail: { color: color.onDarkSubtle, marginTop: 2 },
  streakBlock: {
    minHeight: 44,
    maxWidth: '100%',
    alignItems: 'center',
    marginLeft: 'auto',
    flexShrink: 0,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: color.onDarkTint,
  },
  streakBlockStacked: { width: '100%', marginLeft: 0 },
  streakTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    maxWidth: '100%',
  },
  streakCount: {
    ...type.h3,
    color: color.onDark,
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
    minWidth: 0,
  },
  streakLabel: {
    ...type.micro,
    color: color.onDarkMuted,
    letterSpacing: 0.5,
    marginTop: 1,
    textAlign: 'center',
    maxWidth: '100%',
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
  tierListRowStacked: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space.xs,
  },
  tierListLabel: { color: color.onDarkMuted, flex: 1 },
  tierListLabelActive: { color: color.onDark },
  tierListLabelStacked: { flex: 0 },
  tierListRange: {
    color: color.onDarkMuted,
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.4,
    maxWidth: '100%',
  },
  youPill: {
    maxWidth: '100%',
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
    maxWidth: '100%',
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
