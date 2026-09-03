import React, { useEffect, useMemo } from 'react';
import {
  AccessibilityInfo,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Svg, {
  Circle,
  Defs,
  Line,
  Polygon,
  RadialGradient,
  Stop,
} from 'react-native-svg';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Button, useReducedMotion } from '../design/components';
import { color, radius, space, type } from '../design/tokens';
import { badgeArtFor, MilestoneBadge, RARITY_PALETTE } from './MilestoneBadge';
import { specialistTitle } from './engine';
import { RARITY_LABEL, VOLUME_ACHIEVEMENTS } from './milestones';
import { useConsistencyStore } from './store';
import type { ConsistencyCelebration } from './store';
import { plural } from '../util/plural';

/**
 * The milestone ceremony — the consistency system's RankUpCelebration.
 * A trophy-room reveal in the style of the great streak apps (Runna's
 * spotlight medal, Duolingo's milestone bursts): the stage lights come up,
 * the badge drops in on a spring, sparks land it, and for epic-and-up
 * milestones confetti rains once from the top of the screen.
 *
 * Same rules the rank ceremony never breaks:
 *   - transform/opacity only, everything interruptible;
 *   - reduced motion renders the final layout at rest (no loops, no rain);
 *   - never blocks input — backdrop tap and Continue both end it;
 *   - shown once per milestone (the store's durable ledger guarantees it).
 */

const BADGE_SIZE = 148;

/** Deterministic spark burst: angle°, distance, size, delay ms, round? */
const SPARKS: ReadonlyArray<
  [angle: number, distance: number, size: number, delay: number, round: boolean]
> = [
  [-90, 122, 9, 0, false],
  [-56, 136, 7, 30, true],
  [-22, 116, 8, 60, false],
  [10, 130, 6, 15, true],
  [42, 122, 9, 45, false],
  [74, 138, 7, 75, true],
  [106, 118, 8, 25, false],
  [138, 132, 6, 55, true],
  [170, 122, 8, 40, false],
  [-150, 134, 7, 70, true],
  [-120, 116, 6, 20, false],
  [-170, 128, 9, 50, true],
];

/** Deterministic confetti: xFraction, delay ms, fall ms, size, palette slot,
 * spin turns, horizontal drift px. */
const CONFETTI: ReadonlyArray<
  [
    x: number,
    delay: number,
    fall: number,
    size: number,
    slot: number,
    spin: number,
    drift: number,
  ]
> = [
  [0.06, 0, 1500, 9, 0, 2.5, 26],
  [0.14, 180, 1750, 7, 1, -3, -18],
  [0.22, 60, 1600, 8, 2, 2, 22],
  [0.3, 260, 1850, 6, 3, -2.5, -24],
  [0.38, 120, 1550, 9, 1, 3, 18],
  [0.46, 320, 1900, 7, 0, -2, -16],
  [0.54, 40, 1650, 8, 2, 2.5, 24],
  [0.62, 240, 1800, 6, 3, -3, -20],
  [0.7, 100, 1600, 9, 0, 2, 18],
  [0.78, 300, 1900, 7, 1, -2.5, -26],
  [0.86, 160, 1700, 8, 2, 3, 20],
  [0.94, 20, 1550, 6, 3, -2, -14],
  [0.1, 420, 2000, 7, 2, 2.5, 16],
  [0.26, 500, 2100, 8, 0, -2, -22],
  [0.42, 460, 1950, 6, 1, 3, 26],
  [0.58, 540, 2050, 9, 3, -2.5, -18],
  [0.74, 480, 2000, 7, 0, 2, 20],
  [0.9, 560, 2150, 8, 1, -3, -24],
] as const;

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
      640 + props.delay,
      withTiming(1, { duration: 620, easing: Easing.out(Easing.cubic) }),
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

function ConfettiPiece(props: {
  x: number;
  delay: number;
  fall: number;
  size: number;
  tint: string;
  spin: number;
  drift: number;
  screenWidth: number;
  screenHeight: number;
  reduced: boolean;
}) {
  const progress = useSharedValue(0);

  useEffect(() => {
    if (props.reduced) return;
    progress.value = withDelay(
      420 + props.delay,
      withTiming(1, { duration: props.fall, easing: Easing.in(Easing.quad) }),
    );
  }, [progress, props.delay, props.fall, props.reduced]);

  const style = useAnimatedStyle(() => ({
    opacity:
      progress.value <= 0
        ? 0
        : progress.value >= 0.92
          ? (1 - progress.value) / 0.08
          : 1,
    transform: [
      { translateY: -40 + progress.value * (props.screenHeight * 0.72) },
      {
        translateX: Math.sin(progress.value * Math.PI * 2) * props.drift,
      },
      { rotate: `${progress.value * props.spin * 360}deg` },
      { rotateX: `${progress.value * props.spin * 540}deg` },
    ],
  }));

  if (props.reduced) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.confetti,
        {
          left: props.x * props.screenWidth,
          width: props.size,
          height: props.size * 1.6,
          backgroundColor: props.tint,
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
      withTiming(360, { duration: 20_000, easing: Easing.linear }),
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
      <Svg width={340} height={340} viewBox="0 0 340 340">
        {rays.map(angle => (
          <Line
            key={angle}
            x1={170}
            y1={170}
            x2={170 + 168 * Math.cos((angle * Math.PI) / 180)}
            y2={170 + 168 * Math.sin((angle * Math.PI) / 180)}
            stroke={props.tint}
            strokeWidth={22}
            strokeLinecap="round"
            opacity={0.06}
          />
        ))}
      </Svg>
    </Animated.View>
  );
}

function CelebrationStage(props: { celebration: ConsistencyCelebration }) {
  const { celebration } = props;
  const reduced = useReducedMotion();
  const dismiss = useConsistencyStore(s => s.dismissCelebration);
  const palette = RARITY_PALETTE[celebration.rarity];
  const art = badgeArtFor(celebration.achievementId);
  const { width, height } = useWindowDimensions();
  const grand =
    celebration.rarity === 'epic' ||
    celebration.rarity === 'legendary' ||
    celebration.rarity === 'mythic';

  const backdrop = useSharedValue(reduced ? 1 : 0);
  const spotlight = useSharedValue(reduced ? 1 : 0);
  const eyebrow = useSharedValue(reduced ? 1 : 0);
  const badgeEntry = useSharedValue(reduced ? 1 : 0);
  const badgeOpacity = useSharedValue(reduced ? 1 : 0);
  const glow = useSharedValue(reduced ? 1 : 0);
  const headline = useSharedValue(reduced ? 1 : 0);
  const rewardEntry = useSharedValue(reduced ? 1 : 0);
  const cta = useSharedValue(reduced ? 1 : 0);

  useEffect(() => {
    if (reduced) return;
    const easeOut = Easing.out(Easing.cubic);
    backdrop.value = withTiming(1, { duration: 240, easing: easeOut });
    spotlight.value = withDelay(
      120,
      withTiming(1, { duration: 420, easing: easeOut }),
    );
    eyebrow.value = withDelay(
      180,
      withTiming(1, { duration: 260, easing: easeOut }),
    );
    badgeOpacity.value = withDelay(
      300,
      withTiming(1, { duration: 200, easing: easeOut }),
    );
    badgeEntry.value = withDelay(
      300,
      withSpring(1, { damping: 12, stiffness: 140, mass: 0.9 }),
    );
    glow.value = withDelay(
      640,
      withTiming(1, { duration: 520, easing: easeOut }),
    );
    headline.value = withDelay(
      560,
      withTiming(1, { duration: 320, easing: easeOut }),
    );
    rewardEntry.value = withDelay(
      820,
      withTiming(1, { duration: 300, easing: easeOut }),
    );
    cta.value = withDelay(
      1040,
      withTiming(1, { duration: 280, easing: easeOut }),
    );
  }, [
    backdrop,
    badgeEntry,
    badgeOpacity,
    cta,
    eyebrow,
    glow,
    headline,
    reduced,
    rewardEntry,
    spotlight,
  ]);

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

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));
  const spotlightStyle = useAnimatedStyle(() => ({
    opacity: spotlight.value * 0.9,
    transform: [{ scaleY: 0.6 + spotlight.value * 0.4 }],
  }));
  const eyebrowStyle = useAnimatedStyle(() => ({
    opacity: eyebrow.value,
    transform: [{ translateY: (1 - eyebrow.value) * 10 }],
  }));
  const badgeStyle = useAnimatedStyle(() => ({
    opacity: badgeOpacity.value,
    transform: [
      { translateY: (1 - badgeEntry.value) * -64 },
      { scale: 0.6 + badgeEntry.value * 0.4 },
    ],
  }));
  const glowStyle = useAnimatedStyle(() => ({
    opacity: glow.value >= 1 ? 0 : 0.6 * (1 - glow.value),
    transform: [{ scale: 0.72 + glow.value * 0.85 }],
  }));
  const headlineStyle = useAnimatedStyle(() => ({
    opacity: headline.value,
    transform: [{ translateY: (1 - headline.value) * 14 }],
  }));
  const rewardStyle = useAnimatedStyle(() => ({
    opacity: rewardEntry.value,
    transform: [{ scale: 0.92 + rewardEntry.value * 0.08 }],
  }));
  const ctaStyle = useAnimatedStyle(() => ({
    opacity: cta.value,
    transform: [{ translateY: (1 - cta.value) * 12 }],
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

  return (
    <View style={styles.root} testID="streak-celebration">
      <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss milestone celebration"
          onPress={dismiss}
          style={styles.backdrop}
        >
          <Svg width="100%" height="100%">
            <Defs>
              <RadialGradient id="streakGlow" cx="50%" cy="34%" r="70%">
                <Stop offset="0" stopColor={palette.accent} stopOpacity={0.3} />
                <Stop
                  offset="0.55"
                  stopColor={palette.deep}
                  stopOpacity={0.24}
                />
                <Stop
                  offset="1"
                  stopColor={color.surfaceDark}
                  stopOpacity={0}
                />
              </RadialGradient>
            </Defs>
            <Circle cx="50%" cy="34%" r="100%" fill="url(#streakGlow)" />
          </Svg>
        </Pressable>
      </Animated.View>

      {/* Spotlight cone from the top — the trophy-room light. */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, spotlightStyle]}
      >
        <Svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`}>
          <Defs>
            <RadialGradient id="spotCone" cx="50%" cy="0%" r="80%">
              <Stop offset="0" stopColor={palette.glint} stopOpacity={0.2} />
              <Stop offset="1" stopColor={palette.glint} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Polygon
            points={`${width * 0.42},0 ${width * 0.58},0 ${width * 0.86},${
              height * 0.62
            } ${width * 0.14},${height * 0.62}`}
            fill="url(#spotCone)"
          />
        </Svg>
      </Animated.View>

      {grand
        ? CONFETTI.map(([x, delay, fall, size, slot, spin, drift], index) => (
            <ConfettiPiece
              key={index}
              x={x}
              delay={delay}
              fall={fall}
              size={size}
              tint={
                slot === 0
                  ? palette.accent
                  : slot === 1
                    ? palette.glint
                    : slot === 2
                      ? color.volt
                      : color.mint
              }
              spin={spin}
              drift={drift}
              screenWidth={width}
              screenHeight={height}
              reduced={reduced}
            />
          ))
        : null}

      <View
        accessibilityViewIsModal
        pointerEvents="box-none"
        style={styles.content}
      >
        <Animated.View style={eyebrowStyle}>
          <Text style={[type.micro, styles.eyebrow]}>
            {celebration.kind === 'streak'
              ? `STREAK MILESTONE · ${RARITY_LABEL[
                  celebration.rarity
                ].toUpperCase()}`
              : `ACHIEVEMENT · ${RARITY_LABEL[
                  celebration.rarity
                ].toUpperCase()}`}
          </Text>
        </Animated.View>

        <View style={styles.stage} pointerEvents="none">
          <Sunburst tint={palette.accent} reduced={reduced} />
          <Animated.View style={[styles.glowRing, glowStyle]}>
            <View
              style={[styles.glowRingShape, { borderColor: palette.accent }]}
            />
          </Animated.View>
          <Animated.View style={badgeStyle}>
            <MilestoneBadge
              glyph={art.glyph}
              {...(art.value !== undefined ? { value: art.value } : {})}
              rarity={celebration.rarity}
              earned
              size={BADGE_SIZE}
            />
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
                    ? palette.accent
                    : palette.glint
              }
              reduced={reduced}
            />
          ))}
        </View>

        <Animated.View style={[styles.copyBlock, headlineStyle]}>
          <Text style={[type.h1, styles.headline]}>{title}</Text>
          <Text style={[type.body, styles.blurb]}>{celebration.blurb}</Text>
          <Text style={[type.caption, styles.streakLine]}>{streakLine}</Text>
        </Animated.View>

        <Animated.View style={[styles.rewardPill, rewardStyle]}>
          <View
            style={[styles.rewardDot, { backgroundColor: palette.accent }]}
          />
          <Text style={[type.caption, styles.rewardText]}>
            {celebration.reward}
          </Text>
        </Animated.View>

        <Animated.View style={[styles.ctaBlock, ctaStyle]}>
          <Button
            label="Keep training"
            variant="volt"
            testID="streak-celebration-continue"
            onPress={dismiss}
          />
        </Animated.View>
      </View>
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
    height: 236,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.md,
  },
  sunburst: { position: 'absolute' },
  glowRing: { position: 'absolute' },
  glowRingShape: {
    width: BADGE_SIZE + 40,
    height: BADGE_SIZE + 40,
    borderRadius: (BADGE_SIZE + 40) / 2,
    borderWidth: 3,
  },
  spark: { position: 'absolute' },
  confetti: { position: 'absolute', top: 0, borderRadius: 2 },
  copyBlock: { alignItems: 'center', marginTop: space.sm },
  headline: { color: color.onDark, textAlign: 'center' },
  blurb: {
    color: color.onDarkMuted,
    textAlign: 'center',
    marginTop: space.sm,
    maxWidth: 300,
  },
  streakLine: { color: color.onDarkSubtle, marginTop: space.sm },
  rewardPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: space.lg,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    borderRadius: radius.pill,
    backgroundColor: color.onDarkTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineMutedDark,
  },
  rewardDot: { width: 8, height: 8, borderRadius: 4 },
  rewardText: { color: color.onDark, letterSpacing: 0.3 },
  ctaBlock: { alignSelf: 'stretch', marginTop: space.xl },
});
