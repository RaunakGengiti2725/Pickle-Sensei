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
import { Button, useReducedMotion } from '../design/components';
import { useReliableSafeAreaInsets } from '../design/safeArea';
import { color, radius, space, type } from '../design/tokens';
import { badgeArtFor, MilestoneBadge } from './MilestoneBadge';
import { specialistTitle } from './engine';
import { RARITY_LABEL, VOLUME_ACHIEVEMENTS } from './milestones';
import { useConsistencyStore } from './store';
import type { ConsistencyCelebration } from './store';
import { plural } from '../util/plural';

/**
 * The milestone ceremony — the consistency system's RankUpCelebration.
 * A brief acknowledgment on a flat stage: the badge, rarity label,
 * training facts, and earned reward appear together. Every milestone
 * uses the same restrained entry, so the accomplishment is carried by
 * its actual value and identity rather than extra ornament.
 *
 * Same rules the rank ceremony never breaks:
 *   - transform/opacity only, everything interruptible;
 *   - reduced motion renders the final layout at rest (no transition);
 *   - never blocks input — backdrop tap and Continue both end it;
 *   - shown once per milestone (the store's durable ledger guarantees it).
 */

const BADGE_SIZE = 148;

/** Brief entry duration for the milestone acknowledgment. */
const ENTRY_MS = 220;

/** A small vertical offset accompanies the entry fade, with the final
 * layout used immediately when reduced motion is enabled. */
const ENTRY_DISTANCE = 8;

function CelebrationStage(props: { celebration: ConsistencyCelebration }) {
  const { celebration } = props;
  const reduced = useReducedMotion();
  const { fontScale, height } = useWindowDimensions();
  const insets = useReliableSafeAreaInsets();
  const scrollable = fontScale >= 1.5 || height < 600;
  const dismiss = useConsistencyStore(s => s.dismissCelebration);
  const art = badgeArtFor(celebration.achievementId);
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

  const title =
    celebration.kind === 'volume' &&
    celebration.achievementId === VOLUME_ACHIEVEMENTS.specialist.id &&
    celebration.detail
      ? specialistTitle(celebration.detail)
      : celebration.title;

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(
      celebration.kind === 'streak'
        ? `Milestone unlocked: ${title}. ${celebration.value} ${plural(
            celebration.value,
            'day',
          )} of training. Reward: ${celebration.reward}.`
        : `Achievement unlocked: ${title}. ${celebration.reward}.`,
    );
  }, [celebration, title]);

  const entryStyle = useAnimatedStyle(() => ({
    opacity: entry.value,
    transform: [{ translateY: (1 - entry.value) * ENTRY_DISTANCE }],
  }));

  const streakLine =
    celebration.kind === 'streak'
      ? `${celebration.value} ${plural(
          celebration.value,
          'day',
          'days',
        )} of real training`
      : celebration.detail
        ? `25 scored ${celebration.detail} analyses`
        : `${celebration.value} training activities logged`;

  const facts = (
    <>
      <Text style={[type.micro, styles.eyebrow]}>
        {celebration.kind === 'streak'
          ? `STREAK MILESTONE · ${RARITY_LABEL[
              celebration.rarity
            ].toUpperCase()}`
          : `ACHIEVEMENT · ${RARITY_LABEL[celebration.rarity].toUpperCase()}`}
      </Text>

      <View style={styles.stage} pointerEvents="none">
        <MilestoneBadge
          glyph={art.glyph}
          {...(art.value !== undefined ? { value: art.value } : {})}
          rarity={celebration.rarity}
          earned
          size={BADGE_SIZE}
        />
      </View>

      <View style={styles.copyBlock}>
        <Text style={[type.h1, styles.headline]}>{title}</Text>
        <Text style={[type.body, styles.blurb]}>{celebration.blurb}</Text>
        <Text style={[type.caption, styles.streakLine]}>{streakLine}</Text>
      </View>

      <View style={styles.rewardPill}>
        <Text style={[type.caption, styles.rewardText]}>
          {celebration.reward}
        </Text>
      </View>
    </>
  );

  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
      testID="streak-celebration"
    >
      <StatusBar barStyle="light-content" />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss milestone celebration"
        onPress={dismiss}
        style={StyleSheet.absoluteFill}
      />

      {/* Earned facts share one flat stage and one brief entry. */}
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
            label="Keep training"
            variant="volt"
            testID="streak-celebration-continue"
            onPress={dismiss}
          />
        </View>
      </Animated.View>
    </View>
  );
}

export function StreakCelebration() {
  const celebration = useConsistencyStore(s => s.celebration);
  const dismiss = useConsistencyStore(s => s.dismissCelebration);

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
          key={celebration.achievementId}
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
    minHeight: 188,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.md,
  },
  copyBlock: {
    alignSelf: 'stretch',
    alignItems: 'center',
    marginTop: space.sm,
  },
  headline: { color: color.onDark, textAlign: 'center', maxWidth: '100%' },
  blurb: {
    color: color.onDarkMuted,
    textAlign: 'center',
    marginTop: space.sm,
    maxWidth: 300,
  },
  streakLine: {
    color: color.onDarkSubtle,
    textAlign: 'center',
    marginTop: space.sm,
  },
  rewardPill: {
    marginTop: space.lg,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    borderRadius: radius.sm,
    backgroundColor: color.inkElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
  },
  rewardText: { color: color.onDark, letterSpacing: 0.3, textAlign: 'center' },
  ctaBlock: { alignSelf: 'stretch', marginTop: space.xl },
  ctaBlockScrollable: { flexShrink: 0, marginTop: space.md },
});
