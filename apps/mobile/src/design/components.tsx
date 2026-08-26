import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';
import { bandColor, color, radius, space, type } from './tokens';

/** Core design-system components (directive §46). */

export function Button(props: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  testID?: string;
}) {
  const variant = props.variant ?? 'primary';
  const bg =
    variant === 'primary'
      ? color.court
      : variant === 'danger'
        ? color.bad
        : variant === 'secondary'
          ? color.surfaceAlt
          : 'transparent';
  const fg =
    variant === 'primary' || variant === 'danger' ? color.onDark : color.ink;
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: bg,
          opacity: props.disabled ? 0.4 : pressed ? 0.85 : 1,
        },
        variant === 'ghost' && { borderWidth: 1, borderColor: color.line },
      ]}
    >
      <Text style={[type.bodyBold, { color: fg }]}>{props.label}</Text>
    </Pressable>
  );
}

export function Card(props: {
  children: React.ReactNode;
  style?: ViewStyle;
  testID?: string;
}) {
  return (
    <View testID={props.testID} style={[styles.card, props.style]}>
      {props.children}
    </View>
  );
}

export function SectionTitle(props: {
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.sectionTitle}>
      <Text
        style={[
          type.micro,
          { color: color.inkSoft, textTransform: 'uppercase' },
        ]}
      >
        {props.title}
      </Text>
      {props.right}
    </View>
  );
}

/** 0–10 technique score ring; color + label (never color-only, §56). */
export function ScoreRing(props: {
  score: number | null;
  size?: number;
  label?: string;
}) {
  const size = props.size ?? 148;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const fraction = props.score === null ? 0 : Math.min(props.score / 10, 1);
  const ringColor =
    props.score === null
      ? color.inkSoft
      : props.score >= 8
        ? color.good
        : props.score >= 6.5
          ? color.warn
          : color.bad;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color.line}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={ringColor}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${circumference}`}
          strokeDashoffset={circumference * (1 - fraction)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <Text style={[type.display, { color: color.ink, fontSize: size * 0.32 }]}>
        {props.score === null ? '—' : props.score.toFixed(1)}
      </Text>
      {props.label ? (
        <Text style={[type.caption, { color: color.inkSoft }]}>
          {props.label}
        </Text>
      ) : null}
    </View>
  );
}

export function CheckpointRow(props: {
  name: string;
  score: number | null;
  band: 'green' | 'yellow' | 'red' | 'unscored';
  confidence: number;
  onPress?: () => void;
}) {
  const band = props.band;
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole={props.onPress ? 'button' : undefined}
      style={styles.checkpointRow}
    >
      <View style={[styles.bandDot, { backgroundColor: bandColor(band) }]} />
      <Text style={[type.body, { color: color.ink, flex: 1 }]}>
        {props.name}
      </Text>
      {props.confidence < 0.8 && props.score !== null ? (
        <Text
          style={[type.micro, { color: color.inkSoft, marginRight: space.sm }]}
        >
          LOW CONF
        </Text>
      ) : null}
      <Text style={[type.bodyBold, { color: bandColor(band) }]}>
        {props.score === null ? 'not read' : Math.round(props.score)}
      </Text>
    </Pressable>
  );
}

export function TrendChart(props: {
  points: number[];
  height?: number;
  max?: number;
}) {
  const height = props.height ?? 72;
  const width = 300;
  const max = props.max ?? 10;
  if (props.points.length < 2) {
    return (
      <View style={{ height, justifyContent: 'center' }}>
        <Text style={[type.caption, { color: color.inkSoft }]}>
          Not enough data yet.
        </Text>
      </View>
    );
  }
  const step = width / (props.points.length - 1);
  const pts = props.points
    .map((p, i) => `${i * step},${height - (Math.min(p, max) / max) * height}`)
    .join(' ');
  return (
    <Svg width={width} height={height}>
      <Polyline
        points={pts}
        fill="none"
        stroke={color.court}
        strokeWidth={3}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function EmptyState(props: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={styles.stateWrap}>
      <Text style={[type.h2, { color: color.ink, textAlign: 'center' }]}>
        {props.title}
      </Text>
      <Text
        style={[
          type.body,
          { color: color.inkSoft, textAlign: 'center', marginTop: space.sm },
        ]}
      >
        {props.body}
      </Text>
      {props.action ? (
        <View style={{ marginTop: space.lg }}>{props.action}</View>
      ) : null}
    </View>
  );
}

export function ErrorState(props: {
  title: string;
  detail: string;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.stateWrap}>
      <Text style={[type.h2, { color: color.bad, textAlign: 'center' }]}>
        {props.title}
      </Text>
      <Text
        style={[
          type.body,
          { color: color.inkSoft, textAlign: 'center', marginTop: space.sm },
        ]}
      >
        {props.detail}
      </Text>
      {props.onRetry ? (
        <View style={{ marginTop: space.lg }}>
          <Button
            label="Try again"
            onPress={props.onRetry}
            variant="secondary"
          />
        </View>
      ) : null}
    </View>
  );
}

export function LoadingState(props: { label: string }) {
  return (
    <View style={styles.stateWrap}>
      <ActivityIndicator color={color.court} size="large" />
      <Text style={[type.body, { color: color.inkSoft, marginTop: space.md }]}>
        {props.label}
      </Text>
    </View>
  );
}

/** Unmistakable banner whenever data comes from the dev fixture provider (§5). */
export function FixtureBanner() {
  return (
    <View style={styles.fixtureBanner} testID="fixture-banner">
      <Text style={[type.micro, { color: color.onDark }]}>
        DEVELOPMENT FIXTURE — NOT REAL ANALYSIS
      </Text>
    </View>
  );
}

export function Pill(props: {
  label: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const tone = props.tone ?? 'neutral';
  const bg =
    tone === 'good'
      ? '#DCFCE7'
      : tone === 'warn'
        ? '#FEF3C7'
        : tone === 'bad'
          ? '#FEE2E2'
          : color.surfaceAlt;
  const fg =
    tone === 'good'
      ? color.good
      : tone === 'warn'
        ? color.warn
        : tone === 'bad'
          ? color.bad
          : color.inkSoft;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[type.micro, { color: fg }]}>{props.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingVertical: 14,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    padding: space.md,
    borderWidth: 1,
    borderColor: color.line,
  },
  sectionTitle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: space.lg,
    marginBottom: space.sm,
  },
  checkpointRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
    minHeight: 48,
  },
  bandDot: { width: 10, height: 10, borderRadius: 5, marginRight: space.sm },
  stateWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    flex: 1,
  },
  fixtureBanner: {
    backgroundColor: color.fixture,
    paddingVertical: 6,
    alignItems: 'center',
  },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
});
