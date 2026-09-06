import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import type { PlayerRankTierKey } from '@pickle/shared-types';
import { color } from '../design/tokens';

/**
 * Flat rank insignia — one distinct geometric mark per tier, with a
 * recognizable silhouette (round badge → hexagon → shield → crest → diamond):
 *
 *   bronze    round badge with a single chevron
 *   silver    hexagonal badge with a double chevron
 *   gold      shield carrying three bars
 *   platinum  pointed crest carrying an upright lozenge
 *   diamond   diamond carrying a square
 *
 * `tier: null` renders the muted unranked emblem. Pure SVG, no assets.
 */

const RANK_BADGE_STYLE = {
  accent: color.volt,
  deep: color.inkElevated,
  tint: color.voltTint,
};

export const RANK_TIER_STYLE: Record<
  PlayerRankTierKey,
  { accent: string; deep: string; tint: string }
> = {
  bronze: RANK_BADGE_STYLE,
  silver: RANK_BADGE_STYLE,
  gold: RANK_BADGE_STYLE,
  platinum: RANK_BADGE_STYLE,
  diamond: RANK_BADGE_STYLE,
};

const UNRANKED = {
  accent: color.onDarkFaint,
  deep: color.inkElevated,
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
        <Path
          d="M18 24 H30"
          stroke={UNRANKED.accent}
          strokeWidth={2.2}
          strokeLinecap="round"
        />
      </Svg>
    );
  }

  const palette = RANK_TIER_STYLE[props.tier];
  switch (props.tier) {
    case 'bronze':
      return (
        <Svg {...shared} accessibilityLabel="Bronze rank emblem">
          <Circle
            cx={24}
            cy={24}
            r={18}
            fill={palette.deep}
            stroke={palette.accent}
            strokeWidth={2.2}
          />
          <Path
            d="M16 21 L24 28 L32 21"
            fill="none"
            stroke={palette.accent}
            strokeWidth={2.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      );
    case 'silver':
      return (
        <Svg {...shared} accessibilityLabel="Silver rank emblem">
          <Path
            d="M24 4 L41 14 V34 L24 44 L7 34 V14 Z"
            fill={palette.deep}
            stroke={palette.accent}
            strokeWidth={2.2}
            strokeLinejoin="round"
          />
          <Path
            d="M16 17 L24 24 L32 17 M16 25 L24 32 L32 25"
            fill="none"
            stroke={palette.accent}
            strokeWidth={2.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      );
    case 'gold':
      return (
        <Svg {...shared} accessibilityLabel="Gold rank emblem">
          <Path
            d="M24 4 L41 10 V23 C41 33.5 34 41 24 44 C14 41 7 33.5 7 23 V10 Z"
            fill={palette.deep}
            stroke={palette.accent}
            strokeWidth={2.2}
            strokeLinejoin="round"
          />
          <Path
            d="M16 17 H32 M18 24 H30 M20 31 H28"
            fill="none"
            stroke={palette.accent}
            strokeWidth={2.6}
            strokeLinecap="round"
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
            strokeWidth={2.2}
            strokeLinejoin="round"
          />
          <Path
            d="M24 13 L31 24 L24 35 L17 24 Z"
            fill="none"
            stroke={palette.accent}
            strokeWidth={2.6}
            strokeLinejoin="round"
          />
        </Svg>
      );
    case 'diamond':
      return (
        <Svg {...shared} accessibilityLabel="Diamond rank emblem">
          <Path
            d="M24 3 L44 24 L24 45 L4 24 Z"
            fill={palette.deep}
            stroke={palette.accent}
            strokeWidth={2.2}
            strokeLinejoin="round"
          />
          <Path
            d="M18 18 H30 V30 H18 Z"
            fill="none"
            stroke={palette.accent}
            strokeWidth={2.6}
            strokeLinejoin="round"
          />
        </Svg>
      );
  }
}
