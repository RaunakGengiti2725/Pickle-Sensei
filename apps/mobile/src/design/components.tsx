import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  type AccessibilityRole,
  type AccessibilityState,
  Animated,
  Easing,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Polyline,
  Stop,
} from 'react-native-svg';
import Reanimated, {
  Easing as ReanimatedEasing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { bandColor, color, radius, shadow, space, type } from './tokens';
import { Icon, type IconName } from './icons';

const AnimatedCircle = Reanimated.createAnimatedComponent(Circle);

let reducedMotionValue = false;
let reducedMotionStarted = false;
const reducedMotionListeners = new Set<(value: boolean) => void>();

function setReducedMotion(value: boolean) {
  reducedMotionValue = value;
  reducedMotionListeners.forEach(listener => listener(value));
}

function startReducedMotionObserver() {
  if (reducedMotionStarted) return;
  reducedMotionStarted = true;
  void AccessibilityInfo.isReduceMotionEnabled().then(setReducedMotion);
  AccessibilityInfo.addEventListener('reduceMotionChanged', setReducedMotion);
}

export function useReducedMotion() {
  const [reduced, setReduced] = useState(reducedMotionValue);

  useEffect(() => {
    startReducedMotionObserver();
    reducedMotionListeners.add(setReduced);
    return () => {
      reducedMotionListeners.delete(setReduced);
    };
  }, []);

  return reduced;
}

export function PressableScale(props: {
  children: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityLiveRegion?: 'none' | 'polite' | 'assertive';
  accessibilityState?: AccessibilityState;
  accessibilityRole?: AccessibilityRole;
  testID?: string;
  hitSlop?: number;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const reduced = useReducedMotion();

  const animate = (toValue: number, duration: number) => {
    if (reduced) return;
    Animated.timing(scale, {
      toValue,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  };

  return (
    <Animated.View
      style={[
        styles.pressableContainer,
        props.containerStyle,
        { transform: [{ scale }] },
      ]}
    >
      <Pressable
        testID={props.testID}
        accessibilityRole={props.accessibilityRole ?? 'button'}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityHint={props.accessibilityHint}
        accessibilityLiveRegion={props.accessibilityLiveRegion}
        accessibilityState={{
          ...props.accessibilityState,
          disabled: props.disabled,
        }}
        disabled={props.disabled}
        hitSlop={props.hitSlop}
        onPress={props.onPress}
        onPressIn={() => animate(0.975, 110)}
        onPressOut={() => animate(1, 150)}
        style={({ pressed }) => [
          styles.pressableBase,
          props.style,
          { opacity: props.disabled ? 0.42 : pressed ? 0.92 : 1 },
        ]}
      >
        {props.children}
      </Pressable>
    </Animated.View>
  );
}

/** Branded motion indicator: a partial court-green/volt orbit instead of the
 * platform activity wheel. It only animates for real in-progress work and
 * becomes a static progress mark when Reduce Motion is enabled. */
export function BrandSpinner(props: {
  size?: number;
  color?: string;
  trackColor?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const spin = useRef(new Animated.Value(0)).current;
  const size = props.size ?? 24;
  const stroke = Math.max(2.5, size * 0.12);
  const ringRadius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * ringRadius;

  useEffect(() => {
    // Jest's fake-timer assertions should observe the feature's timers, not
    // an ornamental infinite animation. The native app still animates.
    const nodeEnv = (
      globalThis as typeof globalThis & {
        process?: { env?: { NODE_ENV?: string } };
      }
    ).process?.env?.NODE_ENV;
    if (reduced || nodeEnv === 'test') {
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1_100,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, spin]);

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <Animated.View
      accessible={Boolean(props.accessibilityLabel)}
      accessibilityRole={props.accessibilityLabel ? 'progressbar' : undefined}
      accessibilityLabel={props.accessibilityLabel}
      style={[
        { width: size, height: size, transform: [{ rotate }] },
        props.style,
      ]}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={ringRadius}
          fill="none"
          stroke={props.trackColor ?? color.line}
          strokeWidth={stroke}
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={ringRadius}
          fill="none"
          stroke={props.color ?? color.court}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * 0.64} ${circumference * 0.36}`}
        />
      </Svg>
    </Animated.View>
  );
}

/** Brand-owned switch with the same semantics and 44pt target as a native
 * switch, but the court/volt treatment used throughout Pickle Sensei. */
export function BrandToggle(props: {
  label: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(props.value ? 1 : 0)).current;

  useEffect(() => {
    if (reduced) {
      progress.setValue(props.value ? 1 : 0);
      return;
    }
    Animated.timing(progress, {
      toValue: props.value ? 1 : 0,
      duration: 190,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [progress, props.value, reduced]);

  return (
    <PressableScale
      accessibilityRole="switch"
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.value, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => props.onValueChange(!props.value)}
      testID={props.testID}
      hitSlop={5}
      containerStyle={styles.toggleContainer}
      style={[styles.toggle, props.value ? styles.toggleOn : styles.toggleOff]}
    >
      <Animated.View
        style={[
          styles.toggleKnob,
          {
            transform: [
              {
                translateX: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, 22],
                }),
              },
            ],
          },
        ]}
      />
    </PressableScale>
  );
}

export function Page(props: {
  children: React.ReactNode;
  dark?: boolean;
  scroll?: boolean;
  edges?: Edge[];
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const backgroundColor = props.dark ? color.surfaceDark : color.surface;
  const content = props.scroll ? (
    <ScrollView
      testID={props.testID}
      style={{ flex: 1 }}
      contentContainerStyle={[styles.pageContent, props.contentStyle]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {props.children}
    </ScrollView>
  ) : (
    <View
      testID={props.testID}
      style={[styles.pageContent, props.contentStyle]}
    >
      {props.children}
    </View>
  );

  return (
    <SafeAreaView
      edges={props.edges ?? ['top', 'left', 'right']}
      style={[styles.page, { backgroundColor }]}
    >
      <StatusBar barStyle={props.dark ? 'light-content' : 'dark-content'} />
      {content}
    </SafeAreaView>
  );
}

const BRAND_MARK = require('../../assets/brand/pickle-mark.png');

export function BrandMark(props: {
  compact?: boolean;
  light?: boolean;
  size?: number;
  tint?: string;
}) {
  const size = props.size ?? 32;
  const fg = props.tint ?? (props.light ? color.onDark : color.ink);
  return (
    <View
      style={styles.brandRow}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Pickle Sensei"
    >
      <Image
        source={BRAND_MARK}
        resizeMode="contain"
        style={{ width: size, height: size, tintColor: fg }}
      />
      {!props.compact && (
        <Text style={[styles.wordmark, { color: fg }]}>Pickle Sensei</Text>
      )}
    </View>
  );
}

export function ScreenHeader(props: {
  title?: string;
  eyebrow?: string;
  onBack?: () => void;
  onClose?: () => void;
  right?: React.ReactNode;
  dark?: boolean;
}) {
  const fg = props.dark ? color.onDark : color.ink;
  const action = props.onBack ?? props.onClose;
  const icon: IconName = props.onBack ? 'back' : 'close';
  return (
    <View style={styles.screenHeader}>
      <View style={styles.headerSide}>
        {action ? (
          <PressableScale
            onPress={action}
            accessibilityLabel={props.onBack ? 'Back' : 'Close'}
            hitSlop={8}
            containerStyle={styles.headerActionContainer}
            style={[styles.iconButton, props.dark && styles.iconButtonDark]}
          >
            <Icon name={icon} size={20} color={fg} />
          </PressableScale>
        ) : null}
      </View>
      <View style={styles.headerCenter}>
        {props.eyebrow ? (
          <Text
            style={[
              type.micro,
              { color: props.dark ? color.onDarkSubtle : color.inkSoft },
            ]}
          >
            {props.eyebrow.toUpperCase()}
          </Text>
        ) : null}
        {props.title ? (
          <Text numberOfLines={1} style={[type.h3, { color: fg }]}>
            {props.title}
          </Text>
        ) : null}
      </View>
      <View style={[styles.headerSide, { alignItems: 'flex-end' }]}>
        {props.right}
      </View>
    </View>
  );
}

export function Button(props: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'volt' | 'dark';
  disabled?: boolean;
  testID?: string;
  icon?: IconName;
  compact?: boolean;
}) {
  const variant = props.variant ?? 'primary';
  const palette = {
    primary: { bg: color.court, fg: color.onDark, border: color.court },
    secondary: {
      bg: color.surfaceElevated,
      fg: color.ink,
      border: color.line,
    },
    ghost: { bg: 'transparent', fg: color.ink, border: color.line },
    danger: { bg: color.badSoft, fg: color.bad, border: color.badSoft },
    volt: { bg: color.volt, fg: color.onVolt, border: color.volt },
    dark: { bg: color.ink, fg: color.onDark, border: color.ink },
  }[variant];

  return (
    <PressableScale
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[
        styles.button,
        props.compact && styles.buttonCompact,
        {
          backgroundColor: palette.bg,
          borderColor: palette.border,
        },
      ]}
    >
      <View style={styles.buttonContent}>
        {props.icon ? (
          <Icon name={props.icon} size={18} color={palette.fg} />
        ) : null}
        <Text style={[type.bodyBold, { color: palette.fg }]}>
          {props.label}
        </Text>
        {variant === 'primary' || variant === 'volt' || variant === 'dark' ? (
          <Icon name="arrow" size={18} color={palette.fg} />
        ) : null}
      </View>
    </PressableScale>
  );
}

export interface BrandDialogAction {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'volt' | 'dark';
  disabled?: boolean;
}

/** Product-owned confirmation/notice surface for in-app decisions. System
 * permission, StoreKit, and provider-auth sheets remain system-owned. */
export function BrandDialog(props: {
  visible: boolean;
  title: string;
  detail: string;
  actions: readonly BrandDialogAction[];
  onDismiss?: () => void;
  tone?: 'neutral' | 'danger' | 'success';
  eyebrow?: string;
  testID?: string;
}) {
  const tone = props.tone ?? 'neutral';
  const palette = {
    neutral: {
      soft: color.courtSoft,
      accent: color.court,
      icon: 'shield' as IconName,
    },
    danger: {
      soft: color.badSoft,
      accent: color.bad,
      icon: 'close' as IconName,
    },
    success: {
      soft: color.voltSoft,
      accent: color.courtDeep,
      icon: 'check' as IconName,
    },
  }[tone];

  const dismissible = Boolean(props.onDismiss);
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="fade"
      onRequestClose={props.onDismiss}
    >
      <View style={styles.dialogRoot}>
        <Pressable
          accessible={false}
          disabled={!dismissible}
          onPress={props.onDismiss}
          style={StyleSheet.absoluteFill}
        />
        <View
          accessibilityViewIsModal
          testID={props.testID}
          style={styles.dialogCard}
        >
          <View style={styles.dialogTopRow}>
            <View
              style={[styles.dialogGlyph, { backgroundColor: palette.soft }]}
            >
              <Icon name={palette.icon} size={21} color={palette.accent} />
            </View>
            {dismissible ? (
              <PressableScale
                accessibilityLabel="Close dialog"
                onPress={props.onDismiss}
                containerStyle={styles.dialogCloseContainer}
                style={styles.dialogClose}
              >
                <Icon name="close" size={18} color={color.ink} />
              </PressableScale>
            ) : null}
          </View>
          {props.eyebrow ? (
            <Text
              style={[
                type.micro,
                styles.dialogEyebrow,
                { color: palette.accent },
              ]}
            >
              {props.eyebrow.toUpperCase()}
            </Text>
          ) : null}
          <Text style={[type.h1, styles.dialogTitle]}>{props.title}</Text>
          <Text style={[type.body, styles.dialogDetail]}>{props.detail}</Text>
          <View style={styles.dialogActions}>
            {props.actions.map(action => (
              <Button
                key={action.label}
                label={action.label}
                variant={action.variant}
                disabled={action.disabled}
                onPress={action.onPress}
              />
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function Card(props: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  tone?: 'light' | 'dark' | 'court' | 'soft';
  padded?: boolean;
}) {
  const tone = props.tone ?? 'light';
  return (
    <View
      testID={props.testID}
      style={[
        styles.card,
        tone === 'dark' && styles.cardDark,
        tone === 'court' && styles.cardCourt,
        tone === 'soft' && styles.cardSoft,
        props.padded === false && { padding: 0 },
        props.style,
      ]}
    >
      {props.children}
    </View>
  );
}

export function SectionTitle(props: {
  title: string;
  right?: React.ReactNode;
  dark?: boolean;
}) {
  return (
    <View style={styles.sectionTitle}>
      <Text style={[type.h3, { color: props.dark ? color.onDark : color.ink }]}>
        {props.title}
      </Text>
      {props.right}
    </View>
  );
}

const SCORE_RING_SWEEP_MS = 900;

/** 0–10 technique score ring; color and label are never color-only. The arc
 * sweeps in and the number counts up once on mount (the score-reveal moment);
 * reduced motion renders the final state immediately. */
export function ScoreRing(props: {
  score: number | null;
  size?: number;
  label?: string;
  dark?: boolean;
  accent?: string;
}) {
  const size = props.size ?? 154;
  const stroke = Math.max(8, size * 0.065);
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const fraction = props.score === null ? 0 : Math.min(props.score / 10, 1);
  const accent = props.accent ?? color.volt;
  const fg = props.dark ? color.onDark : color.ink;
  const track = props.dark ? color.lineDark : color.line;
  const reduced = useReducedMotion();
  const animate = !reduced && props.score !== null;

  const sweep = useSharedValue(animate ? 0 : fraction);
  useEffect(() => {
    if (!animate) {
      sweep.value = fraction;
      return;
    }
    sweep.value = withTiming(fraction, {
      duration: SCORE_RING_SWEEP_MS,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
  }, [animate, fraction, sweep]);
  const sweepProps = useAnimatedProps(() => ({
    strokeDashoffset: circumference * (1 - sweep.value),
  }));

  // The number rides the same easing as the arc so both land together.
  const [displayScore, setDisplayScore] = useState(animate ? 0 : props.score);
  useEffect(() => {
    if (!animate || props.score === null) {
      setDisplayScore(props.score);
      return;
    }
    const target = props.score;
    let frame = 0;
    let startedAt: number | null = null;
    const tick = (timestamp: number) => {
      if (startedAt === null) startedAt = timestamp;
      const linear = Math.min(1, (timestamp - startedAt) / SCORE_RING_SWEEP_MS);
      const eased = 1 - Math.pow(1 - linear, 3);
      setDisplayScore(target * eased);
      if (linear < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [animate, props.score]);

  const scoreText =
    props.score === null ? '—' : (displayScore ?? props.score).toFixed(1);

  return (
    <View
      accessibilityLabel={
        props.score === null
          ? 'No technique score yet'
          : `Technique score ${props.score.toFixed(1)} out of 10`
      }
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="scoreGradient" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={color.volt} />
            <Stop offset="1" stopColor={accent} />
          </LinearGradient>
        </Defs>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={track}
          strokeWidth={stroke}
          fill="none"
        />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="url(#scoreGradient)"
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${circumference}`}
          animatedProps={sweepProps}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <Text
        style={[
          type.display,
          { color: fg, fontSize: size * 0.29, lineHeight: size * 0.33 },
        ]}
      >
        {scoreText}
      </Text>
      {props.label ? (
        <Text
          style={[
            type.caption,
            {
              color: props.dark ? color.onDarkSubtle : color.inkSoft,
              textAlign: 'center',
            },
          ]}
        >
          {props.label}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Bar fill that sweeps in from the left once on mount (transform-only: the
 * final width is laid out immediately, so nothing shifts and the resting
 * rounded corners are exact). Reduced motion renders at rest.
 */
export function RevealFill(props: {
  style?: StyleProp<ViewStyle>;
  delay?: number;
  testID?: string;
}) {
  const reduced = useReducedMotion();
  const progress = useSharedValue(reduced ? 1 : 0);

  useEffect(() => {
    if (reduced) {
      progress.value = 1;
      return;
    }
    progress.value = withDelay(
      props.delay ?? 0,
      withTiming(1, {
        duration: 520,
        easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
      }),
    );
  }, [progress, props.delay, reduced]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: progress.value }],
  }));

  return (
    <Reanimated.View
      testID={props.testID}
      style={[styles.revealFill, props.style, animatedStyle]}
    />
  );
}

export function CheckpointRow(props: {
  name: string;
  score: number | null;
  band: 'green' | 'yellow' | 'red' | 'unscored';
  onPress?: () => void;
  /** Stagger offset (ms) for the bar's one-time reveal sweep. */
  revealDelay?: number;
}) {
  const value =
    props.score === null ? 0 : Math.max(0, Math.min(100, props.score));
  const bar = bandColor(props.band);
  const accessibilityLabel = `${props.name}, ${
    props.score === null ? 'not read' : `${Math.round(props.score)} out of 100`
  }`;
  const body = (
    <>
      <View style={styles.checkpointTop}>
        <Text style={[type.bodyBold, { color: color.ink, flex: 1 }]}>
          {props.name}
        </Text>
        <Text style={[type.h3, { color: bar, fontVariant: ['tabular-nums'] }]}>
          {props.score === null ? '—' : Math.round(props.score)}
        </Text>
      </View>
      <View style={styles.metricTrack}>
        <RevealFill
          delay={props.revealDelay}
          style={[
            styles.metricFill,
            { width: `${value}%`, backgroundColor: bar },
          ]}
        />
      </View>
    </>
  );
  if (!props.onPress) {
    return (
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={accessibilityLabel}
        style={[styles.pressableBase, styles.checkpointRow]}
      >
        {body}
      </View>
    );
  }
  return (
    <PressableScale
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={styles.checkpointRow}
    >
      {body}
    </PressableScale>
  );
}

export function TrendChart(props: {
  points: number[];
  height?: number;
  max?: number;
  width?: number;
  dark?: boolean;
}) {
  const height = props.height ?? 92;
  const width = props.width ?? 310;
  const max = props.max ?? 10;
  const line = props.dark ? color.volt : color.court;
  const muted = props.dark ? color.onDarkSubtle : color.inkSoft;
  const geometry = useMemo(() => {
    if (props.points.length < 2) return null;
    const step = width / (props.points.length - 1);
    const pts = props.points
      .map(
        (p, i) =>
          `${i * step},${height - (Math.min(p, max) / max) * (height - 8) - 4}`,
      )
      .join(' ');
    return { pts, area: `0,${height} ${pts} ${width},${height}` };
  }, [height, max, props.points, width]);

  if (!geometry) {
    return (
      <View style={{ height, justifyContent: 'center' }}>
        <Text style={[type.caption, { color: muted }]}>
          Your trend appears after two scored reps.
        </Text>
      </View>
    );
  }

  return (
    <Svg
      width={width}
      height={height}
      accessibilityLabel="Technique score trend"
    >
      <Defs>
        <LinearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={line} stopOpacity="0.2" />
          <Stop offset="1" stopColor={line} stopOpacity="0" />
        </LinearGradient>
      </Defs>
      <Polyline points={geometry.area} fill="url(#trendFill)" stroke="none" />
      <Polyline
        points={geometry.pts}
        fill="none"
        stroke={line}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function EmptyState(props: {
  title: string;
  body: string;
  action?: React.ReactNode;
  dark?: boolean;
}) {
  return (
    <View style={styles.stateWrap}>
      <View style={[styles.emptyGlyph, props.dark && styles.emptyGlyphDark]}>
        <Icon
          name="spark"
          color={props.dark ? color.volt : color.court}
          size={24}
        />
      </View>
      <Text
        style={[
          type.h2,
          {
            color: props.dark ? color.onDark : color.ink,
            textAlign: 'center',
            marginTop: space.md,
          },
        ]}
      >
        {props.title}
      </Text>
      <Text
        style={[
          type.body,
          {
            color: props.dark ? color.onDarkSubtle : color.inkSoft,
            textAlign: 'center',
            marginTop: space.sm,
            maxWidth: 300,
          },
        ]}
      >
        {props.body}
      </Text>
      {props.action ? (
        <View style={{ marginTop: space.lg, alignSelf: 'stretch' }}>
          {props.action}
        </View>
      ) : null}
    </View>
  );
}

export function ErrorState(props: {
  title: string;
  detail: string;
  onRetry?: () => void;
  retryLabel?: string;
  dark?: boolean;
}) {
  return (
    <SafeAreaView
      style={[
        styles.page,
        { backgroundColor: props.dark ? color.surfaceDark : color.surface },
      ]}
    >
      <View
        accessibilityLiveRegion="assertive"
        accessibilityRole="alert"
        style={styles.stateWrap}
      >
        <View style={[styles.emptyGlyph, { backgroundColor: color.badSoft }]}>
          <Icon name="close" color={color.bad} size={22} />
        </View>
        <Text
          style={[
            type.h2,
            {
              color: props.dark ? color.onDark : color.ink,
              textAlign: 'center',
              marginTop: space.md,
            },
          ]}
        >
          {props.title}
        </Text>
        <Text
          style={[
            type.body,
            {
              color: props.dark ? color.onDarkSubtle : color.inkSoft,
              textAlign: 'center',
              marginTop: space.sm,
              maxWidth: 310,
            },
          ]}
        >
          {props.detail}
        </Text>
        {props.onRetry ? (
          <View style={{ marginTop: space.lg, alignSelf: 'stretch' }}>
            <Button
              label={props.retryLabel ?? 'Try again'}
              onPress={props.onRetry}
              variant="secondary"
            />
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

export function LoadingState(props: { label: string; dark?: boolean }) {
  const bg = props.dark ? color.surfaceDark : color.surface;
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${props.label}. Keep Pickle Sensei open.`}
      style={[styles.stateWrap, { backgroundColor: bg }]}
    >
      <View
        style={[
          styles.loadingRing,
          props.dark && { borderColor: color.lineDark },
        ]}
      >
        <BrandSpinner
          color={props.dark ? color.volt : color.court}
          trackColor={props.dark ? color.lineDark : color.line}
          size={24}
        />
      </View>
      <Text
        style={[
          type.bodyBold,
          { color: props.dark ? color.onDark : color.ink, marginTop: space.md },
        ]}
      >
        {props.label}
      </Text>
      <Text
        style={[
          type.caption,
          {
            color: props.dark ? color.onDarkSubtle : color.inkSoft,
            marginTop: space.xs,
          },
        ]}
      >
        Keep Pickle Sensei open.
      </Text>
    </View>
  );
}

export function Pill(props: {
  label: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'volt' | 'dark';
}) {
  const tone = props.tone ?? 'neutral';
  const palette = {
    neutral: { bg: color.surfaceAlt, fg: color.inkSoft },
    good: { bg: color.goodSoft, fg: color.good },
    warn: { bg: color.warnSoft, fg: color.warn },
    bad: { bg: color.badSoft, fg: color.bad },
    volt: { bg: color.volt, fg: color.onVolt },
    dark: { bg: color.inkElevated, fg: color.onDark },
  }[tone];
  return (
    <View style={[styles.pill, { backgroundColor: palette.bg }]}>
      <Text numberOfLines={1} style={[type.micro, { color: palette.fg }]}>
        {props.label}
      </Text>
    </View>
  );
}

export function Stat(props: {
  value: string;
  label: string;
  dark?: boolean;
  accent?: boolean;
}) {
  return (
    <View style={styles.stat}>
      <Text
        style={[
          type.score,
          {
            color: props.accent
              ? props.dark
                ? color.volt
                : color.court
              : props.dark
                ? color.onDark
                : color.ink,
          },
        ]}
      >
        {props.value}
      </Text>
      <Text
        style={[
          type.caption,
          {
            color: props.dark ? color.onDarkSubtle : color.inkSoft,
            marginTop: 2,
          },
        ]}
      >
        {props.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  pageContent: { flexGrow: 1 },
  pressableContainer: { alignSelf: 'stretch' },
  pressableBase: { justifyContent: 'center' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  wordmark: { ...type.h3 },
  screenHeader: {
    minHeight: 52,
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerSide: { width: 44, justifyContent: 'center' },
  headerCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerActionContainer: { width: 44, alignSelf: 'center' },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonDark: {
    backgroundColor: color.inkElevated,
    borderColor: color.lineDark,
  },
  button: {
    minHeight: 56,
    borderRadius: radius.pill,
    borderWidth: 1,
    overflow: 'hidden',
  },
  buttonCompact: { minHeight: 46 },
  buttonContent: {
    minHeight: 54,
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  dialogRoot: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: space.lg,
    backgroundColor: color.overlayStrong,
  },
  dialogCard: {
    width: '100%',
    maxWidth: 380,
    padding: space.lg,
    borderRadius: radius.xl,
    backgroundColor: color.surface,
    ...shadow.floating,
  },
  dialogTopRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dialogGlyph: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialogCloseContainer: { width: 44, alignSelf: 'center' },
  dialogClose: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    backgroundColor: color.surfaceElevated,
  },
  dialogEyebrow: { marginTop: space.lg },
  dialogTitle: { color: color.ink, marginTop: space.sm },
  dialogDetail: { color: color.inkSoft, marginTop: space.sm },
  dialogActions: { gap: 10, marginTop: space.xl },
  card: {
    backgroundColor: color.surfaceElevated,
    borderRadius: radius.lg,
    padding: space.lg,
    ...shadow.soft,
  },
  cardDark: { backgroundColor: color.inkElevated, shadowOpacity: 0 },
  cardCourt: { backgroundColor: color.courtDeep, shadowOpacity: 0 },
  cardSoft: { backgroundColor: color.surfaceAlt, shadowOpacity: 0 },
  sectionTitle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: space.xl,
    marginBottom: space.md,
  },
  checkpointRow: {
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  checkpointTop: { flexDirection: 'row', alignItems: 'center' },
  metricTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: color.surfaceAlt,
    overflow: 'hidden',
    marginTop: 9,
  },
  metricFill: { height: 4, borderRadius: 2 },
  revealFill: { transformOrigin: 'left' },
  stateWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    flex: 1,
  },
  emptyGlyph: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.courtSoft,
  },
  emptyGlyphDark: { backgroundColor: color.inkElevated },
  loadingRing: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleContainer: {
    width: 54,
    height: 44,
    alignSelf: 'center',
    justifyContent: 'center',
  },
  toggle: {
    width: 54,
    height: 34,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 3,
    alignItems: 'flex-start',
  },
  toggleOff: {
    backgroundColor: color.surfaceAlt,
    borderColor: color.line,
  },
  toggleOn: {
    backgroundColor: color.court,
    borderColor: color.court,
  },
  toggleKnob: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: color.surfaceElevated,
    shadowColor: color.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 4,
    elevation: 2,
  },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
    flexShrink: 1,
  },
  stat: { flex: 1 },
});
