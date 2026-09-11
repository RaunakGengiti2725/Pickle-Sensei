import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import {
  PLAYER_RANK_TIERS,
  type PlayerRankDivision,
  type PlayerRankDivisionLabel,
  type PlayerRankTierKey,
} from '@pickle/shared-types';
import { color, rankTier } from '../design/tokens';
import {
  RANK_BADGE_VIEWBOX,
  RANK_TIER_MARK_VIEWBOX,
  rankInsigniaShapes,
  type InsigniaPaint,
  type InsigniaShape,
} from './rankInsigniaArt';

/**
 * Rank insignia. Every tier has its own material (copper, steel, gold,
 * ice, sapphire — flat four-tone facets, no gradients) and silhouette, and
 * every division within a tier is its own badge: III is the bare plate,
 * II wears wings, I wears the full wings and the crown. The geometry lives
 * in `rankInsigniaArt.ts`; this component only paints it.
 *
 *   <RankIcon tier="gold" division={2} />   the Gold II badge
 *   <RankIcon tier="gold" />                the Gold tier mark (plate only)
 *   <RankIcon tier={null} />                the muted unranked emblem
 *
 * Pure SVG, no assets.
 */

export const RANK_TIER_STYLE: Record<
  PlayerRankTierKey,
  {
    accent: string;
    deep: string;
    base: string;
    light: string;
    bright: string;
    tint: string;
  }
> = rankTier;

const UNRANKED = {
  accent: color.onDarkFaint,
  deep: color.inkElevated,
} as const;

const DIVISION_LABEL: Record<PlayerRankDivision, PlayerRankDivisionLabel> = {
  1: 'I',
  2: 'II',
  3: 'III',
};

function tierLabel(tier: PlayerRankTierKey): string {
  return PLAYER_RANK_TIERS.find(candidate => candidate.key === tier)!.label;
}

function paintFor(tier: PlayerRankTierKey): Record<InsigniaPaint, string> {
  const material = rankTier[tier];
  return {
    deep: material.deep,
    base: material.base,
    light: material.light,
    bright: material.bright,
    ink: color.ink,
  };
}

function renderShape(
  shape: InsigniaShape,
  paint: Record<InsigniaPaint, string>,
  key: number,
) {
  const common = {
    key,
    fill: shape.fill ? paint[shape.fill] : 'none',
    stroke: shape.stroke ? paint[shape.stroke] : undefined,
    strokeWidth: shape.stroke ? shape.width : undefined,
    strokeLinecap: shape.cap,
    strokeLinejoin: shape.join,
  };
  switch (shape.kind) {
    case 'path':
      return <Path {...common} d={shape.d} />;
    case 'circle':
      return <Circle {...common} cx={shape.cx} cy={shape.cy} r={shape.r} />;
    case 'rect':
      return (
        <Rect
          {...common}
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          rx={shape.rx}
        />
      );
  }
}

export function RankIcon(props: {
  tier: PlayerRankTierKey | null;
  /** The player's division inside the tier; omit for the plain tier mark. */
  division?: PlayerRankDivision | null;
  size?: number;
}) {
  const size = props.size ?? 44;

  if (props.tier === null) {
    return (
      <Svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        accessibilityLabel="Unranked emblem"
      >
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

  const division = props.division ?? null;
  const paint = paintFor(props.tier);
  const label =
    division === null
      ? `${tierLabel(props.tier)} rank emblem`
      : `${tierLabel(props.tier)} ${DIVISION_LABEL[division]} rank emblem`;

  return (
    <Svg
      width={size}
      height={size}
      viewBox={division === null ? RANK_TIER_MARK_VIEWBOX : RANK_BADGE_VIEWBOX}
      accessibilityLabel={label}
    >
      {rankInsigniaShapes(props.tier, division).map((shape, index) =>
        renderShape(shape, paint, index),
      )}
    </Svg>
  );
}
