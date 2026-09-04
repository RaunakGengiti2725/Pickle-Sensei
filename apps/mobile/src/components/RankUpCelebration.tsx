import React, { useEffect, useMemo, useState } from 'react';
import {
  AccessibilityInfo,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, {
  Circle,
  Defs,
  Line,
  RadialGradient,
  Stop,
} from 'react-native-svg';
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { PLAYER_RANK_TIERS } from '@pickle/shared-types';
import { Button, useReducedMotion } from '../design/components';
import { color, space, type } from '../design/tokens';
import { formatMatchRatingEstimate } from '../progress/matchRatingEstimate';
import { useRankCelebrationStore } from '../progress/rankCelebration';
import type { RankCelebration } from '../progress/rankCelebration';
import { RankIcon, RANK_TIER_STYLE } from './RankIcon';

/**
 * The rank-shift ceremony (Bronze → … → Diamond). A full-screen, one-time
 * moment in the style of the great promotion screens (Duolingo's league
 * move-up, Liven's sunburst level-up): the old emblem steps aside, the new
 * emblem sweeps in on a spring, a glow ring and spark burst land it, and
 * the rating counts up to its new value over the tier ladder.
 *
 * Rules it never breaks:
 *   - transform/opacity animations only, all interruptible;
 *   - reduced motion renders the same layout at rest, loops and bursts off;
 *   - the ceremony never blocks input — backdrop tap and Continue both end
 *     it immediately;
 *   - shown once per tier change (the store's durable record guarantees it).
 */

const TOP_OF_SCALE = 10;
const EMBLEM_SIZE = 132;
const FROM_EMBLEM_SIZE = 84;
const STAGE_SHIFT = 96;

/** Deterministic spark table: angle°, distance, size, delay ms, round? */
const SPARKS: ReadonlyArray<
  [angle: number, distance: number, size: number, delay: number, round: boolean]
> = [
  [-90, 118, 9, 0, false],
  [-58, 132, 7, 30, true],
  [-24, 112, 8, 60, false],
  [8, 126, 6, 15, true],
  [40, 118, 9, 45, false],
  [72, 134, 7, 75, true],
  [104, 114, 8, 25, false],
  [136, 128, 6, 55, true],
  [168, 118, 8, 40, false],
  [-152, 130, 7, 70, true],
  [-122, 112, 6, 20, false],
  [-172, 124, 9, 50, true],
];

/** Fill fraction (0..1) of one tier segment on the ladder (same math as the
 * PlayerRankCard ladder — both surfaces must always agree visually). */
function segmentFill(rating: number, index: number): number {
  const floor = PLAYER_RANK_TIERS[index]!.minRating;
  const ceiling = PLAYER_RANK_TIERS[index + 1]?.minRating ?? TOP_OF_SCALE;
  if (ceiling <= floor) return rating >= floor ? 1 : 0;
  return Math.max(0, Math.min(1, (rating - floor) / (ceiling - floor)));
}

function Spark(props: {
  angle: number;
  distance: number;
  size: number;
  delay: number;
  round: boolean;
  tint: string;
  reduced: boolean;
}) {
  const progress = useSharedValue(0);

  useEffect(() => {
    if (props.reduced) return;
    progress.value = withDelay(
      820 + props.delay,
      withTiming(1, { duration: 640, easing: Easing.out(Easing.cubic) }),
    );
  }, [progress, props.delay, props.reduced]);

  const angleRad = (props.angle * Math.PI) / 180;
  const style = useAnimatedStyle(() => {
    const travelled = progress.value * props.distance;
    return {
      opacity:
        progress.value <= 0 ? 0 : progress.value >= 1 ? 0 : 1 - progress.value,
      transform: [
        { translateX: Math.cos(angleRad) * travelled },
        { translateY: Math.sin(angleRad) * travelled },
        { scale: 1 - progress.value * 0.55 },
        { rotate: props.round ? '0deg' : '45deg' },
      ],
    };
  });

  if (props.reduced) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.spark,
        {
          width: props.size,
          height: props.size,
          backgroundColor: props.tint,
          borderRadius: props.round ? props.size / 2 : 1.5,
        },
        style,
      ]}
    />
  );
}

function Sunburst(props: { tint: string; reduced: boolean }) {
  const spin = useSharedValue(0);

  useEffect(() => {
    if (props.reduced) return;
    spin.value = withRepeat(
      withTiming(360, { duration: 18_000, easing: Easing.linear }),
      -1,
    );
    return () => cancelAnimation(spin);
  }, [spin, props.reduced]);

  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value}deg` }],
  }));

  const rays = useMemo(() => Array.from({ length: 12 }, (_, i) => i * 30), []);
  return (
    <Animated.View pointerEvents="none" style={[styles.sunburst, style]}>
      <Svg width={320} height={320} viewBox="0 0 320 320">
        {rays.map(angle => (
          <Line
            key={angle}
            x1={160}
            y1={160}
            x2={160 + 158 * Math.cos((angle * Math.PI) / 180)}
            y2={160 + 158 * Math.sin((angle * Math.PI) / 180)}
            stroke={props.tint}
            strokeWidth={20}
            strokeLinecap="round"
            opacity={0.05}
          />
        ))}
      </Svg>
    </Animated.View>
  );
}

function RatingCountUp(props: {
  from: number;
  to: number;
  accent: string;
  reduced: boolean;
}) {
  const [value, setValue] = useState(props.reduced ? props.to : props.from);

  useEffect(() => {
    if (props.reduced) {
      setValue(props.to);
      return;
    }
    let frame = 0;
    let startedAt: number | null = null;
    const DELAY = 780;
    const DURATION = 720;
    const tick = (timestamp: number) => {
      if (startedAt === null) startedAt = timestamp;
      const elapsed = timestamp - startedAt - DELAY;
      if (elapsed >= DURATION) {
        setValue(props.to);
        return;
      }
      if (elapsed > 0) {
        const linear = elapsed / DURATION;
        const eased = 1 - Math.pow(1 - linear, 3);
        setValue(props.from + (props.to - props.from) * eased);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [props.from, props.reduced, props.to]);

  return (
    <View style={styles.ratingRow}>
      <Text style={[styles.ratingValue, { color: props.accent }]}>
        {value.toFixed(2)}
      </Text>
      <Text style={[type.caption, styles.ratingScale]}> / 10</Text>
      <Text style={[type.caption, styles.ratingMatchRating]}>
        {' '}
        {formatMatchRatingEstimate(props.to)}
      </Text>
    </View>
  );
}

function CelebrationStage(props: { celebration: RankCelebration }) {
  const { celebration } = props;
  const reduced = useReducedMotion();
  const dismiss = useRankCelebrationStore(s => s.dismiss);
  const tierStyle = RANK_TIER_STYLE[celebration.toTier];
  const placement = celebration.fromTier === null;
  const summary = celebration.summary;

  const backdrop = useSharedValue(reduced ? 1 : 0);
  const eyebrow = useSharedValue(reduced ? 1 : 0);
  const fromShift = useSharedValue(reduced ? 1 : 0);
  const toEntry = useSharedValue(reduced ? 1 : 0);
  const toOpacity = useSharedValue(reduced ? 1 : 0);
  const glow = useSharedValue(reduced ? 1 : 0);
  const headline = useSharedValue(reduced ? 1 : 0);
  const detail = useSharedValue(reduced ? 1 : 0);
  const cta = useSharedValue(reduced ? 1 : 0);
  const ladder = useSharedValue(reduced ? 1 : 0);

  useEffect(() => {
    if (reduced) return;
    const easeOut = Easing.out(Easing.cubic);
    backdrop.value = withTiming(1, { duration: 260, easing: easeOut });
    eyebrow.value = withDelay(
      200,
      withTiming(1, { duration: 250, easing: easeOut }),
    );
    fromShift.value = withDelay(
      350,
      withTiming(1, { duration: 420, easing: Easing.inOut(Easing.cubic) }),
    );
    toOpacity.value = withDelay(
      placement ? 350 : 500,
      withTiming(1, { duration: 240, easing: easeOut }),
    );
    toEntry.value = withDelay(
      placement ? 350 : 500,
      withSpring(1, { damping: 13, stiffness: 130, mass: 0.9 }),
    );
    glow.value = withDelay(
      820,
      withTiming(1, { duration: 520, easing: easeOut }),
    );
    headline.value = withDelay(
      700,
      withTiming(1, { duration: 320, easing: easeOut }),
    );
    ladder.value = withDelay(
      900,
      withTiming(1, { duration: 420, easing: easeOut }),
    );
    detail.value = withDelay(
      1000,
      withTiming(1, { duration: 300, easing: easeOut }),
    );
    cta.value = withDelay(
      1180,
      withTiming(1, { duration: 280, easing: easeOut }),
    );
  }, [
    backdrop,
    cta,
    detail,
    eyebrow,
    fromShift,
    glow,
    headline,
    ladder,
    placement,
    reduced,
    toEntry,
    toOpacity,
  ]);

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

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdrop.value,
  }));
  const eyebrowStyle = useAnimatedStyle(() => ({
    opacity: eyebrow.value,
    transform: [{ translateY: (1 - eyebrow.value) * 10 }],
  }));
  const fromStyle = useAnimatedStyle(() => ({
    opacity: 1 - fromShift.value * 0.66,
    transform: [
      { translateX: -fromShift.value * STAGE_SHIFT },
      { scale: 1 - fromShift.value * 0.34 },
    ],
  }));
  const toStyle = useAnimatedStyle(() => ({
    opacity: toOpacity.value,
    transform: placement
      ? [
          { translateY: (1 - toEntry.value) * 42 },
          { scale: 0.8 + toEntry.value * 0.2 },
        ]
      : [
          { translateX: (1 - toEntry.value) * STAGE_SHIFT },
          { scale: 0.72 + toEntry.value * 0.28 },
        ],
  }));
  const glowStyle = useAnimatedStyle(() => ({
    opacity: glow.value >= 1 ? 0 : 0.55 * (1 - glow.value),
    transform: [{ scale: 0.7 + glow.value * 0.9 }],
  }));
  const headlineStyle = useAnimatedStyle(() => ({
    opacity: headline.value,
    transform: [{ translateY: (1 - headline.value) * 14 }],
  }));
  const detailStyle = useAnimatedStyle(() => ({
    opacity: detail.value,
  }));
  const ctaStyle = useAnimatedStyle(() => ({
    opacity: cta.value,
    transform: [{ translateY: (1 - cta.value) * 12 }],
  }));

  const ladderSegments = PLAYER_RANK_TIERS.map((tier, index) => ({
    key: tier.key,
    fill: segmentFill(summary.rating, index),
    accent: RANK_TIER_STYLE[tier.key].accent,
  }));

  return (
    <View style={styles.root} testID="rank-up-celebration">
      <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss rank celebration"
          onPress={dismiss}
          style={styles.backdrop}
        >
          <Svg width="100%" height="100%">
            <Defs>
              <RadialGradient id="rankGlow" cx="50%" cy="38%" r="65%">
                <Stop
                  offset="0"
                  stopColor={tierStyle.accent}
                  stopOpacity={0.34}
                />
                <Stop
                  offset="0.55"
                  stopColor={tierStyle.deep}
                  stopOpacity={0.2}
                />
                <Stop
                  offset="1"
                  stopColor={color.surfaceDark}
                  stopOpacity={0}
                />
              </RadialGradient>
            </Defs>
            <Circle cx="50%" cy="38%" r="100%" fill="url(#rankGlow)" />
          </Svg>
        </Pressable>
      </Animated.View>

      <View
        accessibilityViewIsModal
        pointerEvents="box-none"
        style={styles.content}
      >
        <Animated.View style={eyebrowStyle}>
          <Text style={[type.micro, styles.eyebrow]}>
            {placement ? 'PLAYER RANK · PLACED' : 'PLAYER RANK · RANK UP'}
          </Text>
        </Animated.View>

        <View style={styles.stage} pointerEvents="none">
          <Sunburst tint={tierStyle.accent} reduced={reduced} />
          <Animated.View style={[styles.glowRing, glowStyle]}>
            <View
              style={[styles.glowRingShape, { borderColor: tierStyle.accent }]}
            />
          </Animated.View>
          {celebration.fromTier ? (
            <Animated.View style={[styles.fromEmblem, fromStyle]}>
              <RankIcon tier={celebration.fromTier} size={FROM_EMBLEM_SIZE} />
            </Animated.View>
          ) : null}
          <Animated.View style={toStyle}>
            <RankIcon tier={celebration.toTier} size={EMBLEM_SIZE} />
          </Animated.View>
          {SPARKS.map(([angle, distance, size, delay, round], index) => (
            <Spark
              key={`${angle}-${distance}`}
              angle={angle}
              distance={distance}
              size={size}
              delay={delay}
              round={round}
              tint={
                index % 3 === 0
                  ? color.volt
                  : index % 3 === 1
                    ? tierStyle.accent
                    : tierStyle.glint
              }
              reduced={reduced}
            />
          ))}
        </View>

        <Animated.View style={[styles.copyBlock, headlineStyle]}>
          <Text style={[type.h1, styles.headline]}>
            {placement
              ? 'You’re on the board.'
              : `${summary.tierLabel} unlocked`}
          </Text>
          <RatingCountUp
            from={celebration.fromRating ?? 0}
            to={summary.rating}
            accent={tierStyle.accent}
            reduced={reduced}
          />
        </Animated.View>

        <View style={styles.ladder}>
          {ladderSegments.map((segment, index) => (
            <View key={segment.key} style={styles.ladderSegment}>
              {segment.fill > 0 ? (
                <LadderFill
                  fill={segment.fill}
                  accent={segment.accent}
                  index={index}
                  progress={ladder}
                  reduced={reduced}
                />
              ) : null}
            </View>
          ))}
        </View>

        <Animated.View style={detailStyle}>
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
        </Animated.View>

        <Animated.View style={[styles.ctaBlock, ctaStyle]}>
          <Button
            label="Continue"
            variant="volt"
            testID="rank-up-continue"
            onPress={dismiss}
          />
        </Animated.View>
      </View>
    </View>
  );
}

/** One ladder segment fill, sweeping left→right with a per-segment stagger
 * driven by the shared ladder progress value. */
function LadderFill(props: {
  fill: number;
  accent: string;
  index: number;
  progress: SharedValue<number>;
  reduced: boolean;
}) {
  const { progress, index, reduced } = props;
  const style = useAnimatedStyle(() => {
    if (reduced) return { transform: [{ scaleX: 1 }] };
    const start = index * 0.12;
    const local = Math.max(
      0,
      Math.min(1, (progress.value - start) / Math.max(0.001, 1 - start)),
    );
    return { transform: [{ scaleX: local }] };
  });
  return (
    <Animated.View
      style={[
        styles.ladderFill,
        { width: `${props.fill * 100}%`, backgroundColor: props.accent },
        style,
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
  root: { flex: 1, backgroundColor: color.overlayDeep },
  backdrop: { flex: 1 },
  content: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  eyebrow: { color: color.volt, textAlign: 'center' },
  stage: {
    width: 320,
    height: 250,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.md,
  },
  sunburst: { position: 'absolute' },
  fromEmblem: { position: 'absolute' },
  glowRing: { position: 'absolute' },
  glowRingShape: {
    width: EMBLEM_SIZE + 36,
    height: EMBLEM_SIZE + 36,
    borderRadius: (EMBLEM_SIZE + 36) / 2,
    borderWidth: 3,
  },
  spark: { position: 'absolute' },
  copyBlock: { alignItems: 'center', marginTop: space.sm },
  headline: { color: color.onDark, textAlign: 'center' },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    marginTop: space.sm,
  },
  ratingValue: {
    ...type.score,
    fontVariant: ['tabular-nums'],
  },
  ratingScale: { color: color.onDarkSubtle },
  ratingMatchRating: { color: color.onDarkFaint },
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
    transformOrigin: 'left',
  },
  detail: {
    color: color.onDarkSubtle,
    textAlign: 'center',
    marginTop: space.md,
  },
  ctaBlock: { alignSelf: 'stretch', marginTop: space.xl },
});
