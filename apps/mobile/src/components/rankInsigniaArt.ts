import type {
  PlayerRankDivision,
  PlayerRankTierKey,
} from '@pickle/shared-types';

/**
 * Rank insignia geometry — pure data, no React, no colors. Every badge is
 * composed on a 64×64 canvas from flat shapes painted with one of five
 * NAMED tones that the renderer resolves against the tier's material:
 *
 *   deep    shadow facet / rim       light   lit facet / bevel
 *   base    body of the plate        bright  brightest edge, numerals
 *   ink     engraved marks and the numeral plaque
 *
 * Fifteen badges (five tiers × divisions III → II → I) share one grammar:
 *
 *   tier      plate silhouette    engraved mark   division wings
 *   bronze    round medal         single chevron  sergeant stripes
 *   silver    hexagonal plate     rising arrow    angular blades
 *   gold      heater shield       five-point star laurel leaves
 *   platinum  pointed crest       upright lozenge swept wings
 *   diamond   cut gem             faceted body    crystal shards
 *
 * Division III is the bare plate over the numeral plaque; II adds one wing
 * each side; I adds a second, longer wing each side and the crown at the
 * apex — ornament grows as the player climbs, and the plaque always shows
 * the numeral the text uses, so "Gold II" on the badge is "Gold II" in
 * the copy. Without a division the plate alone is returned (tier marks in
 * lists), cropped by `RANK_TIER_MARK_VIEWBOX`.
 */

/** The full badge spans y 1–56 (crown to plaque); the box centres it. */
export const RANK_BADGE_VIEWBOX = '0 -3.5 64 64';

/** Crops a division-less tier mark to its plate (x 11–53, y 9–51). */
export const RANK_TIER_MARK_VIEWBOX = '7 5 50 50';

export type InsigniaPaint = 'deep' | 'base' | 'light' | 'bright' | 'ink';

interface StrokeOptions {
  stroke?: InsigniaPaint;
  width?: number;
  cap?: 'round' | 'butt';
  join?: 'round' | 'miter';
}

export type InsigniaShape =
  | ({ kind: 'path'; d: string; fill?: InsigniaPaint } & StrokeOptions)
  | ({
      kind: 'circle';
      cx: number;
      cy: number;
      r: number;
      fill?: InsigniaPaint;
    } & StrokeOptions)
  | ({
      kind: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      rx?: number;
      fill?: InsigniaPaint;
    } & StrokeOptions);

type Point = readonly [number, number];

const CANVAS = 64;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function polygon(points: readonly Point[]): string {
  return (
    points
      .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x} ${y}`)
      .join(' ') + ' Z'
  );
}

/** Maps every x coordinate, so one drawing yields both wings. */
type XMap = (x: number) => number;
const asIs: XMap = x => x;
const mirrored: XMap = x => round(CANVAS - x);

/** A wing drawn for the LEFT side; the renderer mirrors it for the right. */
interface Wing {
  d: (x: XMap) => string;
  fill: InsigniaPaint;
}

function blade(points: readonly Point[], fill: InsigniaPaint): Wing {
  return {
    d: x => polygon(points.map(([px, py]) => [x(px), py] as const)),
    fill,
  };
}

/** Five-point star, apex up, as a closed path. */
function star(cx: number, cy: number, outer: number, inner: number): string {
  const points: Point[] = [];
  for (let index = 0; index < 10; index += 1) {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    points.push([
      round(cx + radius * Math.cos(angle)),
      round(cy + radius * Math.sin(angle)),
    ]);
  }
  return polygon(points);
}

interface TierArt {
  /** The plate: rim, face, bevel and engraved mark, back to front. */
  plate: readonly InsigniaShape[];
  /** Left-side wings; the right side is mirrored. `second` is worn from
   * division II up, `first` is added at division I. */
  wings: { second: readonly Wing[]; first: readonly Wing[] };
}

const TIER_ART: Record<PlayerRankTierKey, TierArt> = {
  bronze: {
    plate: [
      { kind: 'circle', cx: 32, cy: 30, r: 21, fill: 'deep' },
      { kind: 'circle', cx: 32, cy: 30, r: 17.5, fill: 'base' },
      {
        kind: 'path',
        d: 'M14 34.8 A18.6 18.6 0 0 1 36.8 12',
        stroke: 'light',
        width: 2.2,
        cap: 'round',
      },
      {
        kind: 'path',
        d: 'M23 34 L32 25 L41 34',
        stroke: 'ink',
        width: 4.6,
        cap: 'round',
        join: 'round',
      },
    ],
    // Sergeant stripes: slanted bars rising away from the medal.
    wings: {
      second: [
        blade(
          [
            [15, 31],
            [4, 25],
            [4, 20.5],
            [15, 26.5],
          ],
          'light',
        ),
      ],
      first: [
        blade(
          [
            [15, 40],
            [3, 34],
            [3, 29.5],
            [15, 35.5],
          ],
          'base',
        ),
      ],
    },
  },
  silver: {
    plate: [
      {
        kind: 'path',
        d: 'M32 9 L50.2 19.5 V40.5 L32 51 L13.8 40.5 V19.5 Z',
        fill: 'deep',
      },
      {
        kind: 'path',
        d: 'M32 12.5 L47.2 21.3 V38.8 L32 47.5 L16.8 38.8 V21.3 Z',
        fill: 'base',
      },
      {
        kind: 'path',
        d: 'M15.9 37 V20.7 L32 11.4 L40 16',
        stroke: 'light',
        width: 2.2,
        cap: 'round',
        join: 'round',
      },
      {
        kind: 'path',
        d: 'M24 31 L32 23 L40 31 M32 23 V38',
        stroke: 'ink',
        width: 4.4,
        cap: 'round',
        join: 'round',
      },
    ],
    // Angular blades, cut like the plate's own edges.
    wings: {
      second: [
        blade(
          [
            [15, 38],
            [4, 26],
            [7, 20],
            [16, 30],
          ],
          'light',
        ),
      ],
      first: [
        blade(
          [
            [14, 45],
            [2, 34],
            [3, 28],
            [14, 38],
          ],
          'base',
        ),
      ],
    },
  },
  gold: {
    plate: [
      {
        kind: 'path',
        d: 'M32 9 L51 15 V28 C51 39 43.5 46.5 32 51 C20.5 46.5 13 39 13 28 V15 Z',
        fill: 'deep',
      },
      {
        kind: 'path',
        d: 'M32 12.8 L47.6 17.7 V28 C47.6 37.2 41.6 43.2 32 47.2 C22.4 43.2 16.4 37.2 16.4 28 V17.7 Z',
        fill: 'base',
      },
      {
        kind: 'path',
        d: 'M15 32 V16.6 L32 11.2 L41 14',
        stroke: 'light',
        width: 2.2,
        cap: 'round',
        join: 'round',
      },
      { kind: 'path', d: star(32, 29.5, 10.5, 4.4), fill: 'ink' },
    ],
    // Laurel leaves curling up from the shield's base.
    wings: {
      second: [
        {
          d: x =>
            `M${x(15)} 41 Q${x(2.5)} 37 ${x(4.5)} 22 Q${x(14)} 28 ${x(15)} 41 Z`,
          fill: 'light',
        },
      ],
      first: [
        {
          d: x =>
            `M${x(19)} 48 Q${x(4)} 48 ${x(1.5)} 34 Q${x(14)} 37 ${x(19)} 48 Z`,
          fill: 'base',
        },
      ],
    },
  },
  platinum: {
    plate: [
      {
        kind: 'path',
        d: 'M32 9 L50 16 L46.5 38 L32 51 L17.5 38 L14 16 Z',
        fill: 'deep',
      },
      {
        kind: 'path',
        d: 'M32 13 L46.2 18.5 L43.3 36.3 L32 46.5 L20.7 36.3 L17.8 18.5 Z',
        fill: 'base',
      },
      {
        kind: 'path',
        d: 'M16.5 30 L15.6 17.2 L32 10.9 L40 14',
        stroke: 'light',
        width: 2.2,
        cap: 'round',
        join: 'round',
      },
      {
        kind: 'path',
        d: 'M32 20 L39.5 30 L32 40 L24.5 30 Z',
        stroke: 'ink',
        width: 4,
        join: 'round',
      },
    ],
    // Long swept wings, the crest's own angles carried outward.
    wings: {
      second: [
        blade(
          [
            [15, 36],
            [2, 24],
            [5, 20],
            [16, 28],
          ],
          'light',
        ),
      ],
      first: [
        blade(
          [
            [14, 44],
            [1, 34],
            [1.5, 28],
            [14, 36],
          ],
          'base',
        ),
      ],
    },
  },
  diamond: {
    plate: [
      { kind: 'path', d: 'M21 9 H43 L53 21 L32 51 L11 21 Z', fill: 'deep' },
      {
        kind: 'path',
        d: 'M22.6 12.2 H41.4 L49 21.6 L32 46.4 L15 21.6 Z',
        fill: 'base',
      },
      { kind: 'path', d: 'M22.6 12.2 H41.4 L36.4 21.6 H27.6 Z', fill: 'light' },
      { kind: 'path', d: 'M22.6 12.2 L27.6 21.6 H15 Z', fill: 'bright' },
      { kind: 'path', d: 'M36.4 21.6 H49 L32 46.4 Z', fill: 'deep' },
      { kind: 'path', d: 'M15 21.6 H49', stroke: 'bright', width: 1.4 },
      {
        kind: 'path',
        d: 'M26 27.5 L27 30 L29.5 31 L27 32 L26 34.5 L25 32 L22.5 31 L25 30 Z',
        fill: 'bright',
      },
    ],
    // Crystal shards orbiting the gem.
    wings: {
      second: [
        blade(
          [
            [14, 34],
            [7, 24],
            [4, 30],
            [9, 38],
          ],
          'light',
        ),
      ],
      first: [
        blade(
          [
            [11, 44],
            [4, 36],
            [1, 42],
            [6, 50],
          ],
          'base',
        ),
      ],
    },
  },
};

/** Numeral plaque under the plate: an ink name-plate with a metal edge. */
const PLAQUE: InsigniaShape = {
  kind: 'rect',
  x: 21,
  y: 46,
  w: 22,
  h: 10,
  rx: 3,
  fill: 'ink',
  stroke: 'light',
  width: 1.4,
};

/** Roman numeral as bars, centred on the plaque: III = 3 bars … I = 1. */
const NUMERAL_BARS: Record<PlayerRankDivision, readonly number[]> = {
  1: [30.5],
  2: [27.6, 33.4],
  3: [24.6, 30.5, 36.4],
};

/** Division I only: the crown at the apex of the plate. */
const CROWN: InsigniaShape = {
  kind: 'path',
  d: 'M25 9.5 L26.8 3 L30 7 L32 1 L34 7 L37.2 3 L39 9.5 Z',
  fill: 'bright',
};

function numeral(division: PlayerRankDivision): InsigniaShape[] {
  return NUMERAL_BARS[division].map(x => ({
    kind: 'rect',
    x,
    y: 48.2,
    w: 3,
    h: 5.6,
    rx: 0.6,
    fill: 'bright',
  }));
}

function bothSides(set: readonly Wing[]): InsigniaShape[] {
  return set.flatMap(({ d, fill }) => [
    { kind: 'path', d: d(asIs), fill },
    { kind: 'path', d: d(mirrored), fill },
  ]);
}

/**
 * The ordered shapes (back to front) of one insignia. `division: null`
 * returns the plate alone — the tier mark used in lists and ladders.
 */
export function rankInsigniaShapes(
  tier: PlayerRankTierKey,
  division: PlayerRankDivision | null,
): InsigniaShape[] {
  const art = TIER_ART[tier];
  if (division === null) return [...art.plate];
  return [
    ...(division <= 2 ? bothSides(art.wings.second) : []),
    ...(division === 1 ? bothSides(art.wings.first) : []),
    ...art.plate,
    PLAQUE,
    ...numeral(division),
    ...(division === 1 ? [CROWN] : []),
  ];
}
