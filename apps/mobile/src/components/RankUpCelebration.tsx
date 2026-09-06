import React, { useEffect } from 'react';
import {
  AccessibilityInfo,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { PLAYER_RANK_TIERS } from '@pickle/shared-types';
import { Button, useReducedMotion } from '../design/components';
import { useReliableSafeAreaInsets } from '../design/safeArea';
import { color, space, type } from '../design/tokens';
import { formatDuprEstimate } from '../progress/duprEstimate';
import { useRankCelebrationStore } from '../progress/rankCelebration';
import type { RankCelebration } from '../progress/rankCelebration';
import { RankIcon, RANK_TIER_STYLE } from './RankIcon';

/**
 * The rank-shift ceremony (Bronze → … → Diamond). A full-screen, one-time
 * acknowledgment of the player's earned rank. The previous and new
 * insignia share a flat stage; the exact rating and tier ladder are
 * visible together after one brief entry transition, with no ongoing
 * ornament or change to the earned facts.
 *
 * Rules it never breaks:
 *   - transform/opacity animations only, all interruptible;
 *   - reduced motion renders the same layout at rest, without a transition;
 *   - the ceremony never blocks input — backdrop tap and Continue both end
 *     it immediately;
 *   - shown once per tier change (the store's durable record guarantees it).
 */

const TOP_OF_SCALE = 10;
const EMBLEM_SIZE = 132;
const FROM_EMBLEM_SIZE = 84;

/** Brief entry for the earned rank; no ongoing motion. */
const ENTRY_MS = 220;

/** Fill fraction (0..1) of one tier segment on the ladder (same math as the
 * PlayerRankCard ladder — both surfaces must always agree visually). */
function segmentFill(rating: number, index: number): number {
  const floor = PLAYER_RANK_TIERS[index]!.minRating;
  const ceiling = PLAYER_RANK_TIERS[index + 1]?.minRating ?? TOP_OF_SCALE;
  if (ceiling <= floor) return rating >= floor ? 1 : 0;
  return Math.max(0, Math.min(1, (rating - floor) / (ceiling - floor)));
}

function CelebrationStage(props: { celebration: RankCelebration }) {
  const { celebration } = props;
  const reduced = useReducedMotion();
  const { fontScale, height } = useWindowDimensions();
  const insets = useReliableSafeAreaInsets();
  const scrollable = fontScale >= 1.5 || height < 600;
  const dismiss = useRankCelebrationStore(s => s.dismiss);
  const placement = celebration.fromTier === null;
  const summary = celebration.summary;
  const entry = useSharedValue(reduced ? 1 : 0);

  useEffect(() => {
    entry.value = reduced
      ? 1
      : withTiming(1, {
          duration: ENTRY_MS,
          easing: Easing.out(Easing.cubic),
        });
    return () => cancelAnimation(entry);
  }, [entry, reduced]);

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(
      placement
        ? `You are on the board: ${
            summary.tierLabel
          }. Rating ${summary.rating.toFixed(2)} out of 10.`
        : `Rank up: ${summary.tierLabel}. Rating ${summary.rating.toFixed(
            2,
          )} out of 10.`,
    );
  }, [placement, summary]);

  const entryStyle = useAnimatedStyle(() => ({
    opacity: entry.value,
    transform: [{ translateY: (1 - entry.value) * 8 }],
  }));

  const ladderSegments = PLAYER_RANK_TIERS.map((tier, index) => ({
    key: tier.key,
    fill: segmentFill(summary.rating, index),
    accent: RANK_TIER_STYLE[tier.key].accent,
  }));

  const facts = (
    <>
      <Text style={[type.micro, styles.eyebrow]}>
        {placement ? 'PLAYER RANK · PLACED' : 'PLAYER RANK · RANK UP'}
      </Text>

      <View style={styles.stage} pointerEvents="none">
        {celebration.fromTier ? (
          <View style={styles.fromEmblem}>
            <RankIcon tier={celebration.fromTier} size={FROM_EMBLEM_SIZE} />
          </View>
        ) : null}
        <RankIcon tier={celebration.toTier} size={EMBLEM_SIZE} />
      </View>

      <View style={styles.copyBlock}>
        <Text style={[type.h1, styles.headline]}>
          {placement ? 'You’re on the board.' : `${summary.tierLabel} unlocked`}
        </Text>
        <View style={styles.ratingRow}>
          <Text style={styles.ratingValue}>{summary.rating.toFixed(2)}</Text>
          <Text style={[type.caption, styles.ratingScale]}> / 10</Text>
          <Text style={[type.caption, styles.ratingDupr]}>
            {' '}
            {formatDuprEstimate(summary.rating)}
          </Text>
        </View>
      </View>

      <View style={styles.ladder}>
        {ladderSegments.map(segment => (
          <View key={segment.key} style={styles.ladderSegment}>
            {segment.fill > 0 ? (
              <LadderFill fill={segment.fill} accent={segment.accent} />
            ) : null}
          </View>
        ))}
      </View>

      <Text style={[type.caption, styles.detail]}>
        {placement
          ? `Your current form across ${summary.techniqueCount} ${
              summary.techniqueCount === 1 ? 'technique' : 'techniques'
            } — recent swings count most.`
          : summary.nextTier
            ? `${summary.nextTier.pointsNeeded.toFixed(2)} to ${
                summary.nextTier.label
              }. Every analysis moves it.`
            : 'Top tier — every new analysis defends it.'}
      </Text>
    </>
  );

  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
      testID="rank-up-celebration"
    >
      <StatusBar barStyle="light-content" />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss rank celebration"
        onPress={dismiss}
        style={StyleSheet.absoluteFill}
      />

      <Animated.View
        accessibilityViewIsModal
        pointerEvents="box-none"
        style={[
          styles.content,
          scrollable && styles.contentScrollable,
          entryStyle,
        ]}
      >
        {scrollable ? (
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            bounces={false}
            contentInsetAdjustmentBehavior="never"
            automaticallyAdjustContentInsets={false}
          >
            {facts}
          </ScrollView>
        ) : (
          facts
        )}
        <View
          style={[styles.ctaBlock, scrollable && styles.ctaBlockScrollable]}
        >
          <Button
            label="Continue"
            variant="volt"
            testID="rank-up-continue"
            onPress={dismiss}
          />
        </View>
      </Animated.View>
    </View>
  );
}

/** One flat ladder segment fill, showing the exact earned fraction
 * without a separate animation or stagger. */
function LadderFill(props: { fill: number; accent: string }) {
  return (
    <View
      style={[
        styles.ladderFill,
        { width: `${props.fill * 100}%`, backgroundColor: props.accent },
      ]}
    />
  );
}

export function RankUpCelebration() {
  const celebration = useRankCelebrationStore(s => s.current);
  const dismiss = useRankCelebrationStore(s => s.dismiss);

  return (
    <Modal
      visible={celebration !== null}
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={dismiss}
    >
      {celebration ? (
        <CelebrationStage
          key={`${celebration.fromTier ?? 'placement'}-${celebration.toTier}`}
          celebration={celebration}
        />
      ) : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.surfaceDark },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  contentScrollable: {
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    paddingVertical: space.md,
  },
  scroll: { flex: 1, minHeight: 0 },
  scrollContent: { alignItems: 'center', paddingBottom: space.md },
  eyebrow: { color: color.volt, textAlign: 'center' },
  stage: {
    alignSelf: 'stretch',
    minHeight: 180,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    marginTop: space.md,
  },
  fromEmblem: { opacity: 0.5 },
  copyBlock: {
    alignSelf: 'stretch',
    alignItems: 'center',
    marginTop: space.sm,
  },
  headline: { color: color.onDark, textAlign: 'center', maxWidth: '100%' },
  ratingRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'center',
    marginTop: space.sm,
  },
  ratingValue: { ...type.score, color: color.onDark },
  ratingScale: { color: color.onDarkSubtle },
  ratingDupr: { color: color.onDarkFaint },
  ladder: {
    flexDirection: 'row',
    gap: 5,
    marginTop: space.lg,
    alignSelf: 'stretch',
  },
  ladderSegment: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.onDarkTint,
    overflow: 'hidden',
  },
  ladderFill: {
    height: '100%',
    borderRadius: 3,
  },
  detail: {
    color: color.onDarkSubtle,
    textAlign: 'center',
    marginTop: space.md,
  },
  ctaBlock: { alignSelf: 'stretch', marginTop: space.xl },
  ctaBlockScrollable: { flexShrink: 0, marginTop: space.md },
});
