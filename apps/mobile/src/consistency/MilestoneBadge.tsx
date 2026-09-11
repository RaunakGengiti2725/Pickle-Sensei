import React from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import {
  achievementLocked,
  achievementRarity,
  color,
  radius,
  space,
  type,
} from '../design/tokens';
import type { AchievementRarity } from './milestones';
import {
  ACHIEVEMENT_BADGE_VIEWBOX,
  achievementBadgePlaque,
  achievementBadgeShapes,
  achievementSilhouetteIndex,
  type BadgeGlyph,
  type BadgePaint,
  type BadgeShape,
} from './achievementBadgeArt';

export type { BadgeGlyph } from './achievementBadgeArt';

/**
 * Milestone insignia — the identity marks of the streak system. Every
 * achievement has its OWN badge (`achievementBadgeArt.ts`: coin, ember
 * tile, shield, rosette, laurel medallion, hex seal, crowned crest, winged
 * crest, ribboned medal, target), cast in the flat four-tone material of
 * its RARITY (`design/tokens.ts achievementRarity`: chalk → court → volt →
 * violet → flame → ember). No gradients, shadows or particles — facets do
 * the work, exactly like the rank insignia.
 *
 * Locked badges render the same shapes in charcoal with a dashed rim —
 * visible on purpose. Seeing the shape of what you have not earned yet is
 * the entire advertisement.
 *
 * The earned value ("30" for 30 days, "100" for volume) is one RN Text laid
 * over the badge's own ribbon banner (crisper numerals than SVG text, and it
 * inherits the app's Manrope and the user's font scale). The fit is checked
 * against the banner with Manrope Bold's real digit widths; when the scaled
 * numeral no longer fits it flows onto a plaque BELOW the art instead of
 * shrinking, clipping or crossing the banner's ends — the number is the point.
 */

const CANVAS = 96;

type Material = {
  deep: string;
  base: string;
  light: string;
  bright: string;
  accent: string;
  tint: string;
};

export const RARITY_PALETTE: Record<
  AchievementRarity,
  { accent: string; deep: string; tint: string }
> = {
  common: achievementRarity.common,
  uncommon: achievementRarity.uncommon,
  rare: achievementRarity.rare,
  epic: achievementRarity.epic,
  legendary: achievementRarity.legendary,
  mythic: achievementRarity.mythic,
};

/** Resolves a named tone against the badge's material and state. */
export function badgePaint(
  paint: BadgePaint,
  material: Material,
  earned: boolean,
): string {
  switch (paint) {
    case 'mark':
      return earned ? color.surfaceDark : material.accent;
    case 'plaque':
      return earned ? color.surfaceDark : material.deep;
    default:
      return material[paint];
  }
}

/** Dashed rim a locked preview draws around its silhouette. */
export const LOCKED_RIM = { width: 2.4, dash: '7 5' } as const;

function Shape(props: {
  shape: BadgeShape;
  material: Material;
  earned: boolean;
  lockedRim: boolean;
}) {
  const { shape, material, earned } = props;
  const fill = shape.fill ? badgePaint(shape.fill, material, earned) : 'none';
  const stroke = props.lockedRim
    ? material.accent
    : shape.stroke
      ? badgePaint(shape.stroke, material, earned)
      : undefined;
  const strokeWidth = props.lockedRim ? LOCKED_RIM.width : shape.width;
  const common = {
    fill,
    stroke,
    strokeWidth,
    strokeLinecap: shape.cap,
    strokeLinejoin: shape.join,
    strokeDasharray: props.lockedRim ? LOCKED_RIM.dash : undefined,
  };
  switch (shape.kind) {
    case 'circle':
      return <Circle cx={shape.cx} cy={shape.cy} r={shape.r} {...common} />;
    case 'rect':
      return (
        <Rect
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          rx={shape.rx}
          {...common}
        />
      );
    default:
      return <Path d={shape.d} transform={shape.transform} {...common} />;
  }
}

/** Manrope Bold metrics (measured from the bundled font): the cap height
 * and each digit's advance, in em — the numeral's real footprint. */
const DIGIT_HEIGHT_EM = 0.72;
const DIGIT_ADVANCE_EM: Record<string, number> = {
  '0': 0.658,
  '1': 0.438,
  '2': 0.596,
  '3': 0.582,
  '4': 0.609,
  '5': 0.586,
  '6': 0.622,
  '7': 0.533,
  '8': 0.613,
  '9': 0.622,
};

/** The type roles a badge numeral can wear, by badge size. */
type NumeralRole = (typeof type)['micro' | 'h3' | 'score'];

/** Width of a numeral in points for a type role at the given font scale. */
export function numeralWidth(
  value: string,
  role: NumeralRole,
  fontScale: number,
): number {
  const advances = [...value].reduce(
    (sum, digit) => sum + (DIGIT_ADVANCE_EM[digit] ?? DIGIT_ADVANCE_EM['0']!),
    0,
  );
  return (
    advances * role.fontSize * fontScale +
    role.letterSpacing * Math.max(0, value.length - 1)
  );
}

/** Margin the numeral keeps from the banner's flat ends, in canvas units. */
const NUMERAL_SIDE_MARGIN = 2;

export function MilestoneBadge(props: {
  glyph: BadgeGlyph;
  /** Big earned value, e.g. "30" for 30 days or "100" for volume. */
  value?: string;
  rarity: AchievementRarity;
  earned: boolean;
  size?: number;
}) {
  const size = props.size ?? 72;
  const { fontScale } = useWindowDimensions();
  const material: Material = props.earned
    ? achievementRarity[props.rarity]
    : achievementLocked;
  const valueType =
    size >= 120 ? type.score : size >= 64 ? type.h3 : type.micro;
  const unit = size / CANVAS;
  const plaque = props.value ? achievementBadgePlaque(props.glyph) : null;
  const plaqueWidth = (plaque?.w ?? 0) * unit;
  const plaqueHeight = (plaque?.h ?? 0) * unit;
  const digitHeight = valueType.fontSize * fontScale * DIGIT_HEIGHT_EM;
  const valueWidth = props.value
    ? numeralWidth(props.value, valueType, fontScale)
    : 0;
  // The banner is the numeral's home; when the scaled digits would touch its
  // ends or outgrow its height, the number moves onto a plaque under the art
  // and the banner is not drawn.
  const stackedValue =
    Boolean(props.value) &&
    (plaque === null ||
      digitHeight > plaqueHeight - unit ||
      valueWidth > plaqueWidth - 2 * NUMERAL_SIDE_MARGIN * unit);
  const shapes = achievementBadgeShapes(
    props.glyph,
    Boolean(props.value) && !stackedValue,
  );
  const silhouette = achievementSilhouetteIndex(props.glyph);
  const valueColor = props.earned ? material.bright : material.accent;

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
      <Svg
        width={size}
        height={size}
        viewBox={ACHIEVEMENT_BADGE_VIEWBOX}
        testID="milestone-badge-art"
      >
        {shapes.map((shape, index) => (
          <Shape
            key={index}
            shape={shape}
            material={material}
            earned={props.earned}
            lockedRim={!props.earned && index === silhouette}
          />
        ))}
      </Svg>
      {props.value ? (
        <View
          pointerEvents="none"
          testID="milestone-value"
          style={
            stackedValue
              ? styles.stackedValue
              : [
                  styles.valueWrap,
                  {
                    left: plaque!.x * unit,
                    top: plaque!.y * unit,
                    width: plaqueWidth,
                    height: plaqueHeight,
                  },
                ]
          }
        >
          <Text style={[valueType, styles.value, { color: valueColor }]}>
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
    backgroundColor: color.inkElevated,
  },
  valueWrap: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: {
    maxWidth: '100%',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.5,
    includeFontPadding: false,
  },
});

/** Milestone id → its badge artwork (the motif key and the earned value). */
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
