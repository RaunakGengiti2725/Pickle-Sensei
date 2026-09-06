import React from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, G, Path } from 'react-native-svg';
import { color, radius, space, type } from '../design/tokens';
import type { AchievementRarity } from './milestones';

/**
 * Milestone insignia — the identity marks of the streak system. A flat
 * hexagonal plate holds a distinct training motif and the earned value;
 * rarity is named by the surrounding label rather than a separate palette
 * or surface treatment.
 *
 * Locked badges render as charcoal silhouettes with a dashed ring — visible
 * on purpose. Seeing the shape of what you have not earned yet is the
 * entire advertisement.
 *
 * Pure SVG + one RN Text overlay (crisper numerals than SVG text and it
 * inherits the app's Manrope). No image assets.
 */

const EARNED_PALETTE = {
  accent: color.volt,
  deep: color.inkElevated,
  tint: color.voltTint,
};

export const RARITY_PALETTE: Record<
  AchievementRarity,
  { accent: string; deep: string; tint: string }
> = {
  common: EARNED_PALETTE,
  uncommon: EARNED_PALETTE,
  rare: EARNED_PALETTE,
  epic: EARNED_PALETTE,
  legendary: EARNED_PALETTE,
  mythic: EARNED_PALETTE,
};

const LOCKED = {
  accent: color.onDarkFaint,
  deep: color.inkElevated,
} as const;

/** Hexagonal shield, pointed top/bottom, in a 96×96 viewBox. */
const HEX_PATH = 'M48 4 L86 26 V70 L48 92 L10 70 V26 Z';

export type BadgeGlyph =
  | 'spark'
  | 'triFlame'
  | 'shieldFlame'
  | 'paddles'
  | 'laurel'
  | 'comet'
  | 'crown'
  | 'phoenix'
  | 'medal'
  | 'target';

/** Small geometric motifs, drawn for a 96-unit canvas centered ~ (48, 34). */
function Glyph(props: { glyph: BadgeGlyph; accent: string }) {
  const { accent } = props;
  switch (props.glyph) {
    case 'spark':
      return (
        <Path
          d="M49 19 C50 28 38 31 38 39 C38 45 42 49 48 49 C55 49 59 44 59 38 C59 31 53 28 53 25 C50 28 47 31 47 36 C42 31 48 27 49 19 Z"
          fill={accent}
        />
      );
    case 'triFlame':
      return (
        <>
          <Path
            d="M39 26c.3 2.4-1.4 3.4-2.2 4.7-.9 1.5-.4 3.3 1 4.3 1.5 1 3.6.6 4.6-1 1.7-2.8-.9-4.9-3.4-8Z"
            fill={accent}
          />
          <Path
            d="M57 26c.3 2.4-1.4 3.4-2.2 4.7-.9 1.5-.4 3.3 1 4.3 1.5 1 3.6.6 4.6-1 1.7-2.8-.9-4.9-3.4-8Z"
            fill={accent}
          />
          <Path
            d="M48 18c.5 3.6-2 5.1-3.3 7-1.3 2-.7 4.7 1.4 6.1 2.2 1.5 5.2.9 6.6-1.4 2.4-4-1.2-7-4.7-11.7Z"
            fill={accent}
          />
        </>
      );
    case 'shieldFlame':
      return (
        <>
          <Path
            d="M48 17 L61 22 V32 C61 40 55.5 45.5 48 48 C40.5 45.5 35 40 35 32 V22 Z"
            fill="none"
            stroke={accent}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <Path
            d="M48 24c.4 2.8-1.5 4-2.5 5.4-1 1.5-.5 3.6 1 4.7 1.7 1.1 4 .6 5.1-1.1 1.8-3-1-5.4-3.6-9Z"
            fill={accent}
          />
        </>
      );
    case 'paddles':
      return (
        <>
          <Path
            d="M36 20c5 0 8.5 3.6 8.5 8 0 3.4-2 6.2-5 7.3l-1.6 8.2a1.8 1.8 0 0 1-3.5-.7l1.7-8.1c-2.2-1.6-3.6-4.1-3.6-6.7 0-4.4 1.5-8 3.5-8Z"
            fill={accent}
            transform="rotate(-18 40 32)"
          />
          <Path
            d="M60 20c-5 0-8.5 3.6-8.5 8 0 3.4 2 6.2 5 7.3l1.6 8.2a1.8 1.8 0 0 0 3.5-.7l-1.7-8.1c2.2-1.6 3.6-4.1 3.6-6.7 0-4.4-1.5-8-3.5-8Z"
            fill={accent}
            transform="rotate(18 56 32)"
          />
          <Circle cx={48} cy={22} r={3.4} fill={accent} />
        </>
      );
    case 'laurel':
      return (
        <>
          <Path
            d="M32 24 V36 L39 44 M64 24 V36 L57 44 M32 29 L27 25 M32 35 L27 32 M36 40 L30 40 M64 29 L69 25 M64 35 L69 32 M60 40 L66 40"
            fill="none"
            stroke={accent}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Path
            d="M42 31 L47 36 L55 25"
            fill="none"
            stroke={accent}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case 'comet':
      return (
        <>
          <Path
            d="M30 44 L46 34 M27 37 L42 28 M36 49 L52 41"
            stroke={accent}
            strokeWidth={3}
            strokeLinecap="round"
          />
          <Circle cx={58} cy={28} r={8} fill={accent} />
        </>
      );
    case 'crown':
      return (
        <>
          <Path
            d="M33 42 L30 24 L40 32 L48 20 L56 32 L66 24 L63 42 Z"
            fill="none"
            stroke={accent}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <Path
            d="M33 47 H63"
            stroke={accent}
            strokeWidth={3}
            strokeLinecap="round"
          />
        </>
      );
    case 'phoenix':
      return (
        <Path
          d="M48 20 V46 M48 35 L29 22 L34 36 L48 46 L62 36 L67 22 Z"
          fill="none"
          stroke={accent}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case 'medal':
      return (
        <>
          <Path
            d="M41 18 L48 30 L55 18"
            fill="none"
            stroke={accent}
            strokeWidth={3.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Circle
            cx={48}
            cy={36}
            r={11}
            fill="none"
            stroke={accent}
            strokeWidth={3.2}
          />
          <Circle cx={48} cy={36} r={4.4} fill={accent} />
        </>
      );
    case 'target':
      return (
        <>
          <Circle
            cx={48}
            cy={33}
            r={13}
            fill="none"
            stroke={accent}
            strokeWidth={3}
          />
          <Circle
            cx={48}
            cy={33}
            r={6.5}
            fill="none"
            stroke={accent}
            strokeWidth={2.6}
          />
          <Circle cx={48} cy={33} r={2.2} fill={accent} />
        </>
      );
  }
}

export function MilestoneBadge(props: {
  glyph: BadgeGlyph;
  /** Big center value, e.g. "30" for 30 days or "100" for volume. */
  value?: string;
  rarity: AchievementRarity;
  earned: boolean;
  size?: number;
}) {
  const size = props.size ?? 72;
  const { fontScale } = useWindowDimensions();
  const palette = props.earned ? RARITY_PALETTE[props.rarity] : LOCKED;
  const valueType =
    size >= 120 ? type.score : size >= 64 ? type.h3 : type.micro;
  const compact = size < 120;
  const motifBottom = ((compact ? 50.5 * 0.85 - 2 : 50.5) * size) / 96;
  const valueWidth =
    (props.value?.length ?? 0) * valueType.fontSize * fontScale * 0.65;
  const stackedValue =
    Boolean(props.value) &&
    (valueType.lineHeight * fontScale > size * 0.83 - motifBottom - space.xxs ||
      valueWidth > size * 0.62);
  return (
    <View
      style={
        stackedValue
          ? [
              styles.stackedBadge,
              { width: Math.max(size, valueWidth + space.md) },
            ]
          : { width: size, height: size }
      }
    >
      <Svg width={size} height={size} viewBox="0 0 96 96">
        <Path
          d={HEX_PATH}
          fill={palette.deep}
          stroke={palette.accent}
          strokeWidth={props.earned ? 3 : 2.5}
          strokeLinejoin="round"
          strokeDasharray={props.earned ? undefined : '7 5'}
        />
        <G
          testID="milestone-glyph"
          transform={
            props.value
              ? stackedValue
                ? 'translate(0 14)'
                : compact
                  ? 'translate(7.2 -2) scale(0.85)'
                  : undefined
              : undefined
          }
        >
          <Glyph glyph={props.glyph} accent={palette.accent} />
        </G>
      </Svg>
      {props.value ? (
        <View
          pointerEvents="none"
          testID="milestone-value"
          style={
            stackedValue
              ? [styles.stackedValue, { backgroundColor: palette.deep }]
              : styles.valueWrap
          }
        >
          <Text style={[valueType, styles.value, { color: palette.accent }]}>
            {props.value}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stackedBadge: { maxWidth: '100%', alignItems: 'center' },
  stackedValue: {
    alignSelf: 'stretch',
    alignItems: 'center',
    marginTop: space.xxs,
    padding: space.xs,
    borderRadius: radius.xs,
  },
  valueWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: '17%',
  },
  value: {
    maxWidth: '100%',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.5,
  },
});

/** Milestone id → its badge artwork. */
export function badgeArtFor(achievementId: string): {
  glyph: BadgeGlyph;
  value?: string;
} {
  switch (achievementId) {
    case 'streak.1':
      return { glyph: 'spark' };
    case 'streak.3':
      return { glyph: 'triFlame', value: '3' };
    case 'streak.7':
      return { glyph: 'shieldFlame', value: '7' };
    case 'streak.14':
      return { glyph: 'paddles', value: '14' };
    case 'streak.30':
      return { glyph: 'laurel', value: '30' };
    case 'streak.60':
      return { glyph: 'comet', value: '60' };
    case 'streak.100':
      return { glyph: 'crown', value: '100' };
    case 'streak.365':
      return { glyph: 'phoenix', value: '365' };
    case 'volume.sessions100':
      return { glyph: 'medal', value: '100' };
    case 'volume.specialist':
      return { glyph: 'target', value: '25' };
    default:
      return { glyph: 'spark' };
  }
}
