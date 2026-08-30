import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import type { PlayerRankTierKey } from '@pickle/shared-types';

/**
 * Video-game style rank emblems — one REAL, distinct icon per tier, with an
 * escalating silhouette (medal → hex badge → star shield → crest → cut gem):
 *
 *   bronze    round medal with a single chevron
 *   silver    hexagonal badge with a double chevron
 *   gold      shield carrying a five-point star
 *   platinum  pointed crest carrying a four-point sparkle
 *   diamond   brilliant-cut gem with crown facets
 *
 * `tier: null` renders the muted unranked emblem. Pure SVG, no assets.
 */

export const RANK_TIER_STYLE: Record<
  PlayerRankTierKey,
  { accent: string; deep: string; glint: string; tint: string }
> = {
  bronze: {
    accent: '#D08A4E',
    deep: '#3D2415',
    glint: '#F2B984',
    tint: 'rgba(208,138,78,0.16)',
  },
  silver: {
    accent: '#C3CFD6',
    deep: '#2E373D',
    glint: '#E8F1F5',
    tint: 'rgba(195,207,214,0.16)',
  },
  gold: {
    accent: '#E8C25C',
    deep: '#3F3110',
    glint: '#F7E3A1',
    tint: 'rgba(232,194,92,0.16)',
  },
  platinum: {
    accent: '#8FE6D9',
    deep: '#0F3B34',
    glint: '#D3FFF6',
    tint: 'rgba(143,230,217,0.16)',
  },
  diamond: {
    accent: '#9CC8FF',
    deep: '#14304A',
    glint: '#DCEDFF',
    tint: 'rgba(156,200,255,0.18)',
  },
};

const UNRANKED = {
  accent: '#819087',
  deep: 'rgba(255,255,255,0.08)',
} as const;

export function RankIcon(props: {
  tier: PlayerRankTierKey | null;
  size?: number;
}) {
  const size = props.size ?? 44;
  const shared = { width: size, height: size, viewBox: '0 0 48 48' } as const;

  if (props.tier === null) {
    return (
      <Svg {...shared} accessibilityLabel="Unranked emblem">
        <Path
          d="M24 5 L40 11 V23.5 C40 33.5 33.2 40.8 24 44 C14.8 40.8 8 33.5 8 23.5 V11 Z"
          fill={UNRANKED.deep}
          stroke={UNRANKED.accent}
          strokeWidth={2.2}
          strokeLinejoin="round"
        />
        <Circle cx={24} cy={24} r={3.2} fill={UNRANKED.accent} />
      </Svg>
    );
  }

  const palette = RANK_TIER_STYLE[props.tier];
  switch (props.tier) {
    case 'bronze':
      return (
        <Svg {...shared} accessibilityLabel="Bronze rank emblem">
          <Rect
            x={19.5}
            y={3.5}
            width={9}
            height={8}
            rx={3}
            fill={palette.deep}
            stroke={palette.accent}
            strokeWidth={2.2}
          />
          <Circle
            cx={24}
            cy={27}
            r={16}
            fill={palette.deep}
            stroke={palette.accent}
            strokeWidth={2.5}
          />
          <Circle
            cx={24}
            cy={27}
            r={11.5}
            fill="none"
            stroke={palette.accent}
            strokeWidth={1.4}
            opacity={0.45}
          />
          <Path
            d="M17 24.5 L24 31 L31 24.5"
            fill="none"
            stroke={palette.accent}
            strokeWidth={3.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Path
            d="M13.5 18.5 C15.5 15.5 18 13.6 21 12.8"
            fill="none"
            stroke={palette.glint}
            strokeWidth={1.6}
            strokeLinecap="round"
            opacity={0.85}
          />
        </Svg>
      );
    case 'silver':
      return (
        <Svg {...shared} accessibilityLabel="Silver rank emblem">
          <Path
            d="M24 3.5 L41 13.5 V32.5 L24 42.5 L7 32.5 V13.5 Z"
            fill={palette.deep}
            stroke={palette.accent}
            strokeWidth={2.5}
            strokeLinejoin="round"
          />
          <Path
            d="M24 8.5 L36.8 16 V30 L24 37.5 L11.2 30 V16 Z"
            fill="none"
            stroke={palette.accent}
            strokeWidth={1.3}
            opacity={0.4}
            strokeLinejoin="round"
          />
          <Path
            d="M16.5 18.5 L24 25 L31.5 18.5"
            fill="none"
            stroke={palette.accent}
            strokeWidth={3.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Path
            d="M16.5 26.5 L24 33 L31.5 26.5"
            fill="none"
            stroke={palette.accent}
            strokeWidth={3.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.6}
          />
          <Path
            d="M11 12.5 L18 8.5"
            stroke={palette.glint}
            strokeWidth={1.6}
            strokeLinecap="round"
            opacity={0.85}
          />
        </Svg>
      );
    case 'gold':
      return (
        <Svg {...shared} accessibilityLabel="Gold rank emblem">
          <Path
            d="M24 3.5 L41 9.5 V23 C41 33.5 34 41.2 24 44.5 C14 41.2 7 33.5 7 23 V9.5 Z"
            fill={palette.deep}
            stroke={palette.accent}
            strokeWidth={2.5}
            strokeLinejoin="round"
          />
          <Path
            d="M24 8.2 L36.8 12.7 V23 C36.8 30.9 31.6 36.9 24 39.9 C16.4 36.9 11.2 30.9 11.2 23 V12.7 Z"
            fill="none"
            stroke={palette.accent}
            strokeWidth={1.3}
            opacity={0.4}
            strokeLinejoin="round"
          />
          <Path
            d="M24 13.5 L26.47 19.6 L33.03 20.06 L27.99 24.3 L29.59 30.69 L24 27.2 L18.41 30.69 L20.01 24.3 L14.97 20.06 L21.53 19.6 Z"
            fill={palette.accent}
            strokeLinejoin="round"
          />
          <Path
            d="M12 9.5 L19 7"
            stroke={palette.glint}
            strokeWidth={1.6}
            strokeLinecap="round"
            opacity={0.85}
          />
        </Svg>
      );
    case 'platinum':
      return (
        <Svg {...shared} accessibilityLabel="Platinum rank emblem">
          <Path
            d="M24 3 L40 12 L36 34 L24 45 L12 34 L8 12 Z"
            fill={palette.deep}
            stroke={palette.accent}
            strokeWidth={2.5}
            strokeLinejoin="round"
          />
          <Path
            d="M24 8 L35.5 14.5 L32.4 31.5 L24 39.2 L15.6 31.5 L12.5 14.5 Z"
            fill="none"
            stroke={palette.accent}
            strokeWidth={1.3}
            opacity={0.45}
            strokeLinejoin="round"
          />
          <Path
            d="M24 13 C25.4 19.6 26.9 21.1 33.5 22.5 C26.9 23.9 25.4 25.4 24 32 C22.6 25.4 21.1 23.9 14.5 22.5 C21.1 21.1 22.6 19.6 24 13 Z"
            fill={palette.accent}
          />
          <Path
            d="M11.5 10.5 L18 6.8"
            stroke={palette.glint}
            strokeWidth={1.6}
            strokeLinecap="round"
            opacity={0.9}
          />
        </Svg>
      );
    case 'diamond':
      return (
        <Svg {...shared} accessibilityLabel="Diamond rank emblem">
          <Path
            d="M24 5 L38.5 15.5 L24 43 L9.5 15.5 Z"
            fill={palette.deep}
            stroke={palette.accent}
            strokeWidth={2.5}
            strokeLinejoin="round"
          />
          <Path
            d="M9.5 15.5 H38.5 M24 5 L16.5 15.5 L24 43 M24 5 L31.5 15.5 L24 43"
            fill="none"
            stroke={palette.accent}
            strokeWidth={1.6}
            opacity={0.75}
            strokeLinejoin="round"
          />
          <Path
            d="M13 12.5 L19.5 7.8"
            stroke={palette.glint}
            strokeWidth={1.7}
            strokeLinecap="round"
            opacity={0.95}
          />
          <Circle cx={30.6} cy={10.4} r={1.5} fill={palette.glint} />
        </Svg>
      );
  }
}
