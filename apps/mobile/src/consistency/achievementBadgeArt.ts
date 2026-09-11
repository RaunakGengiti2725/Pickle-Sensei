/**
 * Achievement badge geometry — pure data, no React, no colors. Every badge
 * is composed on a 96×96 canvas from flat shapes painted with one of six
 * NAMED tones the renderer resolves against the rarity's material
 * (`design/tokens.ts achievementRarity`, or `achievementLocked` while the
 * badge is unearned):
 *
 *   deep    shadow facet / rim      bright  brightest edge, sparks, numerals
 *   base    body of the plate       mark    the engraved emblem
 *   light   lit facet / bevel       plaque  the ribbon banner the numeral sits on
 *
 * Ten badges, one per achievement, each its OWN silhouette and emblem —
 * no two share a plate:
 *
 *   streak.1    First Spark      coin                single flame + sparks
 *   streak.3    Kindling         ember tile          three flames
 *   streak.7    Week One         heater shield       shield flame (the Streak Shield)
 *   streak.14   Fortnight Form   twelve-lobe rosette crossed paddles + ball
 *   streak.30   30 Day Club      laurel medallion    two laurel branches + star
 *   streak.60   Sixty Deep       hexagonal seal      comet
 *   streak.100  Century Club     crowned shield      apex crown + star
 *   streak.365  Eternal Flame    winged crest        phoenix flame + embers
 *   volume.sessions100  100 Sessions  ribboned medal   check mark
 *   volume.specialist   Specialist    target rings     paddle on the bull
 *
 * The one shared element is the ribbon banner across the lower plate: an ink
 * band with pointed ends that carries the earned value in bright numerals,
 * so "30" on the badge is the "30 Day Club" of the copy. First Spark has no
 * value and no banner — its flame sits at the centre of the coin.
 *
 * LAYOUT CONTRACT (every badge, checked by hand against its own geometry):
 *   - the banner lies wholly INSIDE the plate's face (the `base` shape),
 *     ≥ 2 units from its edge — it never crosses the rim or the silhouette;
 *   - the emblem stops ≥ 3 units above the banner and ≥ 3 units clear of the
 *     bevel highlights; sparks and embers are ≥ 2 units from anything;
 *   - each banner is wide enough for its own numeral in every size role the
 *     renderer uses at the default font scale — 3-digit banners ≥ 52 units,
 *     2-digit ≥ 40, 1-digit ≥ 32 — so the digits sit with ≥ 3 units either
 *     side (Manrope Bold digits are ≤ 0.66 em wide, 0.72 em tall);
 *   - nothing is drawn outside 0–96 on either axis.
 */

export const ACHIEVEMENT_BADGE_VIEWBOX = '0 0 96 96';

/** One key per badge design — the motif each achievement is drawn as. */
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

export const BADGE_GLYPHS: readonly BadgeGlyph[] = [
  'spark',
  'triFlame',
  'shieldFlame',
  'paddles',
  'laurel',
  'comet',
  'crown',
  'phoenix',
  'medal',
  'target',
];

export type BadgePaint =
  'deep' | 'base' | 'light' | 'bright' | 'mark' | 'plaque';

interface StrokeOptions {
  stroke?: BadgePaint;
  width?: number;
  cap?: 'round' | 'butt';
  join?: 'round' | 'miter';
}

export type BadgeShape =
  | ({
      kind: 'path';
      d: string;
      fill?: BadgePaint;
      transform?: string;
    } & StrokeOptions)
  | ({
      kind: 'circle';
      cx: number;
      cy: number;
      r: number;
      fill?: BadgePaint;
    } & StrokeOptions)
  | ({
      kind: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      rx?: number;
      fill?: BadgePaint;
    } & StrokeOptions);

/** The flat body of a badge's ribbon banner, in canvas units — the numeral
 * is centred on it. The pointed ends extend `BANNER_POINT` beyond it. */
export interface BadgePlaque {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const BANNER_POINT = 4;

type Point = readonly [number, number];

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

/** Regular polygon with `sides`, first vertex straight up. */
function regular(cx: number, cy: number, r: number, sides: number): string {
  const points: Point[] = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / sides;
    points.push([
      round(cx + r * Math.cos(angle)),
      round(cy + r * Math.sin(angle)),
    ]);
  }
  return polygon(points);
}

/** A scalloped rosette: `lobes` outward bumps around a circle of radius r
 * (the bumps reach r × 1.16). */
function rosette(cx: number, cy: number, r: number, lobes: number): string {
  const bump = r * 1.16;
  let d = '';
  for (let index = 0; index < lobes; index += 1) {
    const a0 = -Math.PI / 2 + (index * 2 * Math.PI) / lobes;
    const a1 = a0 + Math.PI / lobes;
    const a2 = a0 + (2 * Math.PI) / lobes;
    const start = `${round(cx + r * Math.cos(a0))} ${round(cy + r * Math.sin(a0))}`;
    const control = `${round(cx + bump * Math.cos(a1))} ${round(cy + bump * Math.sin(a1))}`;
    const end = `${round(cx + r * Math.cos(a2))} ${round(cy + r * Math.sin(a2))}`;
    d += index === 0 ? `M${start} ` : '';
    d += `Q${control} ${end} `;
  }
  return `${d}Z`;
}

/**
 * The streak flame (FlameIcon's outer silhouette, a 24-unit drawing) placed
 * so its bounding box (x 5–15.8, y 2.8–21.6) is centred at (cx, cy) and
 * `height` units tall; its width is 0.574 × height.
 */
const FLAME_D =
  'M13.2 2.8c.7 3.5-1.6 4.8-2.7 6.4-.9 1.3-.8 2.7.3 3.7-.1-2.3 1.5-3.4 3-4.4.2 2 2.9 3.6 2.9 6.8 0 3.3-2.2 5.7-5.2 5.7s-5.3-2.3-5.3-5.6c0-4 3.2-6.2 7-12.6Z';
const FLAME_BOX = { x: 5, y: 2.8, w: 10.8, h: 18.8 } as const;

function flame(cx: number, cy: number, height: number): BadgeShape {
  const scale = height / FLAME_BOX.h;
  const tx = round(cx - (FLAME_BOX.x + FLAME_BOX.w / 2) * scale);
  const ty = round(cy - (FLAME_BOX.y + FLAME_BOX.h / 2) * scale);
  return {
    kind: 'path',
    d: FLAME_D,
    fill: 'mark',
    transform: `translate(${tx} ${ty}) scale(${round(scale)})`,
  };
}

/** The ribbon banner for a plaque rect: an ink band with pointed ends. */
function banner(plaque: BadgePlaque): BadgeShape {
  const midY = plaque.y + plaque.h / 2;
  return {
    kind: 'path',
    d: polygon([
      [plaque.x, plaque.y],
      [plaque.x + plaque.w, plaque.y],
      [plaque.x + plaque.w + BANNER_POINT, midY],
      [plaque.x + plaque.w, plaque.y + plaque.h],
      [plaque.x, plaque.y + plaque.h],
      [plaque.x - BANNER_POINT, midY],
    ]),
    fill: 'plaque',
    stroke: 'light',
    width: 1.4,
    join: 'round',
  };
}

/** A lit facet along the upper-left inner edge — the bevel every plate
 * wears, cut to its own silhouette and kept clear of its emblem. */
function bevel(d: string, width = 2.6): BadgeShape {
  return {
    kind: 'path',
    d,
    stroke: 'light',
    width,
    cap: 'round',
    join: 'round',
  };
}

/** The thin bright edge on the upper-right, answering the bevel. */
function edgeLight(d: string): BadgeShape {
  return {
    kind: 'path',
    d,
    stroke: 'bright',
    width: 1.4,
    cap: 'round',
    join: 'round',
  };
}

/**
 * An upright pickleball paddle drawn at x = 48: an oval face whose centre is
 * (48, faceY) and a rounded handle running down to handleEnd. Rotated into
 * place by the badge that wears it.
 */
function paddle(
  faceY: number,
  faceRx: number,
  faceRy: number,
  handleEnd: number,
): string {
  const top = faceY - faceRy;
  const neck = faceY + faceRy * 0.72;
  const k = 0.5523; // circular-arc Bézier constant
  return [
    `M48 ${round(top)}`,
    `C${round(48 + faceRx * k)} ${round(top)} ${round(48 + faceRx)} ${round(faceY - faceRy * k)} ${round(48 + faceRx)} ${faceY}`,
    `C${round(48 + faceRx)} ${round(faceY + faceRy * 0.55)} ${round(48 + faceRx * 0.6)} ${round(neck)} ${round(48 + 2)} ${round(neck + 1)}`,
    `L50 ${round(handleEnd - 1.5)} A1.8 1.8 0 0 1 46 ${round(handleEnd - 1.5)}`,
    `L46 ${round(neck + 1)}`,
    `C${round(48 - faceRx * 0.6)} ${round(neck)} ${round(48 - faceRx)} ${round(faceY + faceRy * 0.55)} ${round(48 - faceRx)} ${faceY}`,
    `C${round(48 - faceRx)} ${round(faceY - faceRy * k)} ${round(48 - faceRx * k)} ${round(top)} 48 ${round(top)} Z`,
  ].join(' ');
}

interface BadgeArt {
  /** Back-to-front shapes of the plate and its emblem (no banner). */
  shapes: readonly BadgeShape[];
  /** Where the numeral banner sits; null for a badge without a value. */
  plaque: BadgePlaque | null;
  /** Index of the silhouette — the outermost plate a locked preview
   * outlines with a dashed rim. Wings and ribbon tails sit behind it. */
  silhouette: number;
}

// ── First Spark · coin ──────────────────────────────────────────────────────
// Rim r 42 / face r 36.5 about (48,48). Flame 40 tall centred on the face;
// sparks sit between the flame and the bevel arcs (r 34), never on either.
const COIN: BadgeArt = {
  shapes: [
    { kind: 'circle', cx: 48, cy: 48, r: 42, fill: 'deep' },
    { kind: 'circle', cx: 48, cy: 48, r: 36.5, fill: 'base' },
    bevel('M14.5 55 A34 34 0 0 1 40 15.5'),
    edgeLight('M56 14 A34.5 34.5 0 0 1 71 22'),
    flame(48, 49, 40),
    { kind: 'circle', cx: 65, cy: 27, r: 2.4, fill: 'bright' },
    { kind: 'circle', cx: 33, cy: 23, r: 1.7, fill: 'bright' },
    { kind: 'circle', cx: 69, cy: 41, r: 1.4, fill: 'bright' },
  ],
  plaque: null,
  silhouette: 0,
};

// ── Kindling · ember tile ───────────────────────────────────────────────────
// Rim 9–87 × 6–90, face 14.5–81.5 × 11.5–84.5. Banner 22–74 × 54–78 (points
// to 18/78). Three flames end at y 48, 6 above the banner.
const EMBER_TILE: BadgeArt = {
  shapes: [
    { kind: 'rect', x: 9, y: 6, w: 78, h: 84, rx: 18, fill: 'deep' },
    { kind: 'rect', x: 14.5, y: 11.5, w: 67, h: 73, rx: 13.5, fill: 'base' },
    bevel('M18 48 V25.5 A11 11 0 0 1 29 14.5 H44'),
    edgeLight('M56 14.5 H67 A11 11 0 0 1 78 25.5'),
    flame(30, 39, 18),
    flame(66, 39, 18),
    flame(48, 32, 30),
  ],
  plaque: { x: 22, y: 54, w: 52, h: 24 },
  silhouette: 0,
};

// ── Week One · heater shield ────────────────────────────────────────────────
// Straight flanks to y 51 keep the lower face wide: the face edge is at
// x ≈ 67.5 by y 74 and ≈ 77.5 by y 62, so the banner 32–64 × 50–74 (points
// 28/68 at y 62) clears it by ≥ 3.5. Flame 28 tall at (48,33): 3.4 under
// the bevel, 3 above the banner.
const HEATER_SHIELD: BadgeArt = {
  shapes: [
    {
      kind: 'path',
      d: 'M48 5 L86 15 V52 C86 70 70 83 48 92 C26 83 10 70 10 52 V15 Z',
      fill: 'deep',
    },
    {
      kind: 'path',
      d: 'M48 11 L80 19.5 V51 C80 66 67 76.5 48 85 C29 76.5 16 66 16 51 V19.5 Z',
      fill: 'base',
    },
    bevel('M19 42 V22 L48 14.1 L59 17'),
    edgeLight('M69 19.7 L77 21.8 V32'),
    flame(48, 33, 28),
  ],
  plaque: { x: 32, y: 50, w: 32, h: 24 },
  silhouette: 0,
};

// ── Fortnight Form · rosette ────────────────────────────────────────────────
// Rosette r 38.5 (lobes to 44.7) / face r 33.5 about (48,47). Banner
// 28–68 × 50–72: its corners are 2.3 inside the face, its points (24/72 at
// y 61) 6.4 inside. The paddles cross at (48,36) — faces 3.4 apart and 3.1
// inside the face's top, handles running 10 past the crossing to end 4.3
// above the banner — over the ball (r 3 at (48,44)), 3 clear of each handle.
// The highlights are short side arcs so the faces never touch them.
const ROSETTE: BadgeArt = {
  shapes: [
    { kind: 'path', d: rosette(48, 47, 38.5, 12), fill: 'deep' },
    { kind: 'circle', cx: 48, cy: 47, r: 33.5, fill: 'base' },
    bevel('M19.5 57 A31 31 0 0 1 24 30'),
    edgeLight('M72 30 A31 31 0 0 1 76.5 57'),
    {
      kind: 'path',
      d: paddle(22, 6.4, 7.8, 46),
      fill: 'mark',
      transform: 'rotate(-38 48 36)',
    },
    {
      kind: 'path',
      d: paddle(22, 6.4, 7.8, 46),
      fill: 'mark',
      transform: 'rotate(38 48 36)',
    },
    { kind: 'circle', cx: 48, cy: 44, r: 3, fill: 'bright' },
    { kind: 'circle', cx: 48, cy: 44, r: 1.1, fill: 'mark' },
  ],
  plaque: { x: 28, y: 50, w: 40, h: 22 },
  silhouette: 0,
};

/** One laurel branch on the left of the medallion; `flip` mirrors it. Every
 * point stays ≤ 31 from the medallion's centre (the rim ring is at 39). */
function laurel(flip: boolean): BadgeShape[] {
  const x = (value: number) => round(flip ? 96 - value : value);
  const stem: BadgeShape = {
    kind: 'path',
    d: `M${x(29)} 47 C${x(21)} 40 ${x(22)} 26 ${x(34)} 20`,
    stroke: 'mark',
    width: 2.4,
    cap: 'round',
  };
  // Each leaf: base on the stem → tip, bulging ±3.6 either side of its axis.
  const leafAnchors: ReadonlyArray<readonly [number, number, number, number]> =
    [
      [27, 46, 37, 41],
      [24, 38, 35, 33],
      [24, 30, 36, 26],
      [28, 23, 37, 20.5],
    ];
  const leaves: BadgeShape[] = leafAnchors.map(([bx, by, tx, ty]) => {
    const dx = tx - bx;
    const dy = ty - by;
    const length = Math.hypot(dx, dy);
    const nx = (-dy / length) * 3.6;
    const ny = (dx / length) * 3.6;
    const mx = (bx + tx) / 2;
    const my = (by + ty) / 2;
    return {
      kind: 'path',
      d: `M${x(bx)} ${by} Q${x(round(mx + nx))} ${round(my + ny)} ${x(tx)} ${ty} Q${x(round(mx - nx))} ${round(my - ny)} ${x(bx)} ${by} Z`,
      fill: 'mark',
    };
  });
  return [stem, ...leaves];
}

// ── 30 Day Club · laurel medallion ──────────────────────────────────────────
// Rim r 42 / face r 36.5 about (48,46), with a bright ring in the rim
// instead of a bevel so the branches own the upper face. Banner 28–68 ×
// 52–74: corners 2.1 inside the face, points (24/72 at y 63) 7 inside. Star
// r 9 at (48,26); the stems end 3.8 short of it and start 3.8 above the
// banner; every leaf tip keeps ≥ 3 from the star.
const LAUREL_MEDALLION: BadgeArt = {
  shapes: [
    { kind: 'circle', cx: 48, cy: 46, r: 42, fill: 'deep' },
    { kind: 'circle', cx: 48, cy: 46, r: 36.5, fill: 'base' },
    {
      kind: 'circle',
      cx: 48,
      cy: 46,
      r: 39.4,
      stroke: 'light',
      width: 1.2,
    },
    ...laurel(false),
    ...laurel(true),
    { kind: 'path', d: star(48, 26, 9, 3.8), fill: 'mark' },
    { kind: 'path', d: star(48, 26, 4, 1.7), fill: 'bright' },
  ],
  plaque: { x: 28, y: 52, w: 40, h: 22 },
  silhouette: 0,
};

// ── Sixty Deep · hexagonal seal ─────────────────────────────────────────────
// Hex r 44 / face r 38 about (48,48); the face's lower edges run from
// (80.9,67) to (48,86), so the banner 26–70 × 50–72 (points 22/74 at y 61)
// keeps ≥ 2.2 from the face everywhere. Comet head r 9 at (56,28), 2.6
// inside the face's upper-right edge; the trails end ≥ 3 short of the head
// (stroke included), run ≥ 4.4 apart and stop ≥ 3.7 above the banner.
const HEX_SEAL: BadgeArt = {
  shapes: [
    { kind: 'path', d: regular(48, 48, 44, 6), fill: 'deep' },
    { kind: 'path', d: regular(48, 48, 38, 6), fill: 'base' },
    bevel('M17.6 44 V30.5 L48 13'),
    edgeLight('M78.4 31.5 V44'),
    {
      kind: 'path',
      d: 'M24 44 L43 32',
      stroke: 'mark',
      width: 3.2,
      cap: 'round',
    },
    {
      kind: 'path',
      d: 'M24 35 L40 25',
      stroke: 'mark',
      width: 2.6,
      cap: 'round',
    },
    {
      kind: 'path',
      d: 'M34 45 L48 39.5',
      stroke: 'mark',
      width: 2.6,
      cap: 'round',
    },
    { kind: 'circle', cx: 56, cy: 28, r: 9, fill: 'mark' },
    { kind: 'circle', cx: 59, cy: 25, r: 3, fill: 'bright' },
  ],
  plaque: { x: 26, y: 50, w: 44, h: 22 },
  silhouette: 0,
};

// ── Century Club · crowned shield ───────────────────────────────────────────
// Straight flanks to y 74, then the point at (48,93); face 16–80 wide down
// to y 70.3, then ≥ 76.6 at y 72. Banner 22–74 × 48–72 (points 18/78 at
// y 60) is ≥ 2 inside the face. Crown 3–22 rests on the apex; its band
// covers the rim there on purpose, and both highlights stop ≥ 3.6 short of
// it. Star r 8.5 at (48,36): 3.4 under the band, 3.5 above the banner.
const CROWNED_SHIELD: BadgeArt = {
  shapes: [
    { kind: 'path', d: 'M48 12 L86 22 V74 L48 93 L10 74 V22 Z', fill: 'deep' },
    {
      kind: 'path',
      d: 'M48 18.2 L80 26.6 V70.3 L48 86.3 L16 70.3 V26.6 Z',
      fill: 'base',
    },
    bevel('M19 42 V29.6 L29 26.9'),
    edgeLight('M67 26.9 L77 29.6 V40'),
    {
      kind: 'path',
      d: 'M33 22 L30 7 L38 13.5 L48 3 L58 13.5 L66 7 L63 22 Z',
      fill: 'bright',
    },
    { kind: 'rect', x: 33, y: 20.5, w: 30, h: 3.6, rx: 1, fill: 'deep' },
    { kind: 'path', d: star(48, 36, 8.5, 3.6), fill: 'mark' },
    { kind: 'path', d: star(48, 36, 3.6, 1.6), fill: 'bright' },
  ],
  plaque: { x: 22, y: 48, w: 52, h: 24 },
  silhouette: 0,
};

/** A phoenix wing behind the crest's flank; `flip` mirrors it. The blades
 * tuck under the body (which starts at x 10) and sit clear of each other. */
function wing(flip: boolean): BadgeShape[] {
  const x = (value: number) => round(flip ? 96 - value : value);
  return [
    {
      kind: 'path',
      d: polygon([
        [x(14), 34],
        [x(2), 20],
        [x(3), 38],
        [x(14), 44],
      ]),
      fill: 'light',
    },
    {
      kind: 'path',
      d: polygon([
        [x(14), 47],
        [x(1), 43],
        [x(6), 58],
        [x(14), 58],
      ]),
      fill: 'base',
    },
  ];
}

// ── Eternal Flame · winged crest ────────────────────────────────────────────
// Body 10–86 wide with straight flanks to y 72; face 16–80 down to y 68.4.
// Banner 22–74 × 45–69 (points 18/78 at y 57) is 2 inside the face; the
// flame (23 tall at (48,30)) stops 3.5 above it and 3.9 under the bevel;
// the embers keep ≥ 4.6 from the flame, both highlights and the banner.
const WINGED_CREST: BadgeArt = {
  shapes: [
    ...wing(false),
    ...wing(true),
    { kind: 'path', d: 'M48 4 L86 14 V72 L48 92 L10 72 V14 Z', fill: 'deep' },
    {
      kind: 'path',
      d: 'M48 10.2 L80 18.6 V68.4 L48 85.2 L16 68.4 V18.6 Z',
      fill: 'base',
    },
    bevel('M19 40 V21 L48 13.3 L58 15.9'),
    edgeLight('M66 18 L77 20.9 V30'),
    flame(48, 30, 23),
    { kind: 'circle', cx: 64, cy: 27, r: 2, fill: 'bright' },
    { kind: 'circle', cx: 33, cy: 27, r: 1.6, fill: 'bright' },
    { kind: 'circle', cx: 65, cy: 39, r: 1.4, fill: 'bright' },
  ],
  plaque: { x: 22, y: 45, w: 52, h: 24 },
  silhouette: 4,
};

// ── 100 Sessions · ribboned medal ───────────────────────────────────────────
// Disc r 40 / face r 34.5 about (48,50); the ribbon tails (y 2–18) sit
// behind it. Banner 22–74 × 47–69: corners 2.3 inside the face, points
// (18/78 at y 58) 3.5 inside. Check mark 4.5 above the banner and 4.4
// clear of the edge-light arc (r 32).
const RIBBONED_MEDAL: BadgeArt = {
  shapes: [
    {
      kind: 'path',
      d: polygon([
        [27, 2],
        [45, 2],
        [43, 18],
        [31, 18],
      ]),
      fill: 'deep',
    },
    {
      kind: 'path',
      d: polygon([
        [51, 2],
        [69, 2],
        [65, 18],
        [53, 18],
      ]),
      fill: 'deep',
    },
    {
      kind: 'path',
      d: polygon([
        [33, 2],
        [39, 2],
        [37.5, 18],
        [34, 18],
      ]),
      fill: 'light',
    },
    {
      kind: 'path',
      d: polygon([
        [57, 2],
        [63, 2],
        [62, 18],
        [58.5, 18],
      ]),
      fill: 'light',
    },
    { kind: 'circle', cx: 48, cy: 50, r: 40, fill: 'deep' },
    { kind: 'circle', cx: 48, cy: 50, r: 34.5, fill: 'base' },
    bevel('M18 60 A32 32 0 0 1 40 19'),
    edgeLight('M56 19 A32 32 0 0 1 70 26.5'),
    {
      kind: 'path',
      d: 'M37 33 L44 40 L56 27',
      stroke: 'mark',
      width: 5,
      cap: 'round',
      join: 'round',
    },
  ],
  plaque: { x: 22, y: 47, w: 52, h: 22 },
  silhouette: 4,
};

// ── Specialist · target rings ───────────────────────────────────────────────
// Rings about (48,41): 40 / 33 / 26 / 19 / 12. Banner 30–66 × 52–74 lies
// over the lower rings, 2.4 inside the outer ring at its corners. The paddle
// lies across the target with its face (7.6 × 9.8) on the bull, 3.3 above
// the banner; the handle runs left and a little up, ending 11 inside the
// outer ring.
const TARGET_RINGS: BadgeArt = {
  shapes: [
    { kind: 'circle', cx: 48, cy: 41, r: 40, fill: 'deep' },
    { kind: 'circle', cx: 48, cy: 41, r: 33, fill: 'light' },
    { kind: 'circle', cx: 48, cy: 41, r: 26, fill: 'base' },
    { kind: 'circle', cx: 48, cy: 41, r: 19, fill: 'light' },
    { kind: 'circle', cx: 48, cy: 41, r: 12, fill: 'base' },
    {
      kind: 'path',
      d: paddle(41, 7.6, 9.8, 70),
      fill: 'mark',
      transform: 'rotate(100 48 41)',
    },
    { kind: 'circle', cx: 48, cy: 41, r: 2.6, fill: 'bright' },
  ],
  plaque: { x: 30, y: 52, w: 36, h: 22 },
  silhouette: 0,
};

const BADGE_ART: Record<BadgeGlyph, BadgeArt> = {
  spark: COIN,
  triFlame: EMBER_TILE,
  shieldFlame: HEATER_SHIELD,
  paddles: ROSETTE,
  laurel: LAUREL_MEDALLION,
  comet: HEX_SEAL,
  crown: CROWNED_SHIELD,
  phoenix: WINGED_CREST,
  medal: RIBBONED_MEDAL,
  target: TARGET_RINGS,
};

/**
 * The ordered shapes (back to front) of one badge. With a value the ribbon
 * banner is laid over the lower face for the numeral the renderer draws on
 * top; without one the plate stands alone.
 */
export function achievementBadgeShapes(
  glyph: BadgeGlyph,
  withValue: boolean,
): BadgeShape[] {
  const art = BADGE_ART[glyph];
  return withValue && art.plaque
    ? [...art.shapes, banner(art.plaque)]
    : [...art.shapes];
}

/** The banner rect the numeral is centred on, or null for a badge that
 * carries no value (First Spark). */
export function achievementBadgePlaque(glyph: BadgeGlyph): BadgePlaque | null {
  return BADGE_ART[glyph].plaque;
}

/** Index of the shape that IS the silhouette (the outermost plate) — the
 * one a locked preview outlines with a dashed rim. */
export function achievementSilhouetteIndex(glyph: BadgeGlyph): number {
  return BADGE_ART[glyph].silhouette;
}
