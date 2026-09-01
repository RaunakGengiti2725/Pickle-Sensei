import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Path,
  Stop,
} from 'react-native-svg';
import { color, font } from '../design/tokens';
import type { AchievementRarity } from './milestones';

/**
 * Milestone medallions — the collectible identity artwork of the streak
 * system (hex-shield silhouette in the Strava/Garmin trophy-case language,
 * escalating rarity palettes so a Century Club badge is unmistakably more
 * precious than a 3-day Kindling).
 *
 * Locked badges render as charcoal silhouettes with a dashed ring — visible
 * on purpose. Seeing the shape of what you have not earned yet is the
 * entire advertisement.
 *
 * Pure SVG + one RN Text overlay (crisper numerals than SVG text and it
 * inherits the app's Manrope). No image assets.
 */

export const RARITY_PALETTE: Record<
  AchievementRarity,
  { accent: string; deep: string; glint: string; tint: string }
> = {
  common: {
    accent: '#D08A4E',
    deep: '#3D2415',
    glint: '#F2B984',
    tint: 'rgba(208,138,78,0.16)',
  },
  uncommon: {
    accent: '#53D99B',
    deep: '#0F3B2E',
    glint: '#B5F3D6',
    tint: 'rgba(83,217,155,0.16)',
  },
  rare: {
    accent: '#9CC8FF',
    deep: '#14304A',
    glint: '#DCEDFF',
    tint: 'rgba(156,200,255,0.16)',
  },
  epic: {
    accent: '#C9A6FF',
    deep: '#2B1D4A',
    glint: '#EADDFF',
    tint: 'rgba(201,166,255,0.18)',
  },
  legendary: {
    accent: '#E8C25C',
    deep: '#3F3110',
    glint: '#F7E3A1',
    tint: 'rgba(232,194,92,0.2)',
  },
  mythic: {
    accent: '#D7FA45',
    deep: '#071710',
    glint: '#8FE6D9',
    tint: 'rgba(215,250,69,0.2)',
  },
};

const LOCKED = {
  accent: '#5C6862',
  deep: '#131F1A',
  glint: '#77837C',
} as const;

/** Hexagonal shield, pointed top/bottom, in a 96×96 viewBox. */
const HEX_PATH = 'M48 4 L86 26 V70 L48 92 L10 70 V26 Z';
const HEX_INNER = 'M48 12 L79 30 V66 L48 84 L17 66 V30 Z';

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

/** Small stylized motifs, drawn for a 96-unit canvas centered ~ (48, 34). */
function Glyph(props: { glyph: BadgeGlyph; accent: string; glint: string }) {
  const { accent, glint } = props;
  switch (props.glyph) {
    case 'spark':
      return (
        <Path
          d="M48 20 L51 31 L62 34 L51 37 L48 48 L45 37 L34 34 L45 31 Z"
          fill={accent}
        />
      );
    case 'triFlame':
      return (
        <>
          <Path
            d="M39 26c.3 2.4-1.4 3.4-2.2 4.7-.9 1.5-.4 3.3 1 4.3 1.5 1 3.6.6 4.6-1 1.7-2.8-.9-4.9-3.4-8Z"
            fill={accent}
            opacity={0.75}
          />
          <Path
            d="M57 26c.3 2.4-1.4 3.4-2.2 4.7-.9 1.5-.4 3.3 1 4.3 1.5 1 3.6.6 4.6-1 1.7-2.8-.9-4.9-3.4-8Z"
            fill={accent}
            opacity={0.75}
          />
          <Path
            d="M48 18c.5 3.6-2 5.1-3.3 7-1.3 2-.7 4.7 1.4 6.1 2.2 1.5 5.2.9 6.6-1.4 2.4-4-1.2-7-4.7-11.7Z"
            fill={glint}
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
            fill={glint}
          />
        </>
      );
    case 'paddles':
      return (
        <>
          <Path
            d="M36 20c5 0 8.5 3.6 8.5 8 0 3.4-2 6.2-5 7.3l-1.6 8.2a1.8 1.8 0 0 1-3.5-.7l1.7-8.1c-2.2-1.6-3.6-4.1-3.6-6.7 0-4.4 1.5-8 3.5-8Z"
            fill={accent}
            opacity={0.8}
            transform="rotate(-18 40 32)"
          />
          <Path
            d="M60 20c-5 0-8.5 3.6-8.5 8 0 3.4 2 6.2 5 7.3l1.6 8.2a1.8 1.8 0 0 0 3.5-.7l-1.7-8.1c2.2-1.6 3.6-4.1 3.6-6.7 0-4.4-1.5-8-3.5-8Z"
            fill={glint}
            opacity={0.95}
            transform="rotate(18 56 32)"
          />
          <Circle cx={48} cy={22} r={3.4} fill={accent} />
        </>
      );
    case 'laurel':
      return (
        <>
          <Path
            d="M32 24c-2 8 0 16 6 21"
            fill="none"
            stroke={accent}
            strokeWidth={3}
            strokeLinecap="round"
          />
          <Path
            d="M64 24c2 8 0 16-6 21"
            fill="none"
            stroke={accent}
            strokeWidth={3}
            strokeLinecap="round"
          />
          <Path
            d="M33 29l-5-2M34 35l-5 0M37 41l-4 3"
            stroke={accent}
            strokeWidth={2.4}
            strokeLinecap="round"
          />
          <Path
            d="M63 29l5-2M62 35l5 0M59 41l4 3"
            stroke={accent}
            strokeWidth={2.4}
            strokeLinecap="round"
          />
          <Path
            d="M48 20 L50.5 27.5 L58 28 L52.5 32.5 L54.5 40 L48 35.8 L41.5 40 L43.5 32.5 L38 28 L45.5 27.5 Z"
            fill={glint}
          />
        </>
      );
    case 'comet':
      return (
        <>
          <Path
            d="M30 44 L52 30 M27 37 L45 26 M36 49 L54 38"
            stroke={accent}
            strokeWidth={3}
            strokeLinecap="round"
            opacity={0.7}
          />
          <Circle cx={58} cy={28} r={8} fill={glint} />
          <Circle cx={55} cy={25} r={2.4} fill={accent} opacity={0.6} />
        </>
      );
    case 'crown':
      return (
        <>
          <Path
            d="M33 42 L30 24 L40 32 L48 20 L56 32 L66 24 L63 42 Z"
            fill={accent}
          />
          <Path
            d="M33 46 H63"
            stroke={glint}
            strokeWidth={3.4}
            strokeLinecap="round"
          />
          <Circle cx={48} cy={31} r={2.6} fill={glint} />
        </>
      );
    case 'phoenix':
      return (
        <>
          {Array.from({ length: 8 }, (_, i) => {
            const angle = (i * 45 * Math.PI) / 180;
            return (
              <Path
                key={i}
                d={`M${48 + Math.cos(angle) * 12} ${
                  34 + Math.sin(angle) * 12
                } L${48 + Math.cos(angle) * 21} ${34 + Math.sin(angle) * 21}`}
                stroke={i % 2 === 0 ? accent : glint}
                strokeWidth={3}
                strokeLinecap="round"
              />
            );
          })}
          <Circle cx={48} cy={34} r={8.5} fill={glint} />
          <Path
            d="M48 27c.3 2.4-1.3 3.3-2 4.5-.8 1.3-.4 3 .9 3.9 1.4 1 3.3.5 4.2-.9 1.6-2.6-.8-4.6-3.1-7.5Z"
            fill={accent}
          />
        </>
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
            stroke={glint}
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
            stroke={glint}
            strokeWidth={2.6}
          />
          <Circle cx={48} cy={33} r={2.2} fill={glint} />
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
  const palette = props.earned ? RARITY_PALETTE[props.rarity] : LOCKED;
  const gradientId = `badge-${props.rarity}-${props.earned ? 'on' : 'off'}`;
  const valueSize = size * (props.value && props.value.length > 2 ? 0.2 : 0.24);
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 96 96">
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={palette.deep} />
            <Stop offset="1" stopColor={props.earned ? '#0B1B14' : '#0C1511'} />
          </LinearGradient>
        </Defs>
        <Path
          d={HEX_PATH}
          fill={`url(#${gradientId})`}
          stroke={palette.accent}
          strokeWidth={props.earned ? 4 : 3}
          strokeLinejoin="round"
          strokeDasharray={props.earned ? undefined : '7 5'}
        />
        <Path
          d={HEX_INNER}
          fill="none"
          stroke={palette.accent}
          strokeWidth={1.4}
          opacity={props.earned ? 0.4 : 0.25}
          strokeLinejoin="round"
        />
        {props.earned ? (
          <Path
            d="M20 22 L34 13"
            stroke={palette.glint}
            strokeWidth={2.4}
            strokeLinecap="round"
            opacity={0.9}
          />
        ) : null}
        <Glyph
          glyph={props.glyph}
          accent={props.earned ? palette.accent : LOCKED.accent}
          glint={props.earned ? palette.glint : LOCKED.glint}
        />
      </Svg>
      {props.value ? (
        <View pointerEvents="none" style={styles.valueWrap}>
          <Text
            style={[
              styles.value,
              {
                fontSize: valueSize,
                color: props.earned ? color.onDark : LOCKED.glint,
              },
            ]}
          >
            {props.value}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
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
    fontFamily: font.bold,
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
