import type { ReviewArrow, ReviewStop } from './formReviewModel';

/**
 * FORM REVIEW geometry — the pure math between the review script and the
 * screen: letterbox fitting, normalized→stage projection, the body-scaled
 * glow unit, the heat/fault tints, arrow directions, stop selection and the
 * auto-pause crossing rule. No React, no IO, so jest pins every branch.
 *
 * Color math mirrors the native PoseOverlayView (heatStops ramp and
 * glowRadiusUnit) so the replay exoskeleton reads exactly like the live
 * camera overlay the player just saw.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// ─── Fitting and projection ─────────────────────────────────────────────────

/**
 * Letterbox fit of `video` inside `stage`, centered (the rect the native
 * player's 'contain' mode actually paints). Degenerate inputs — a
 * non-positive or non-finite dimension on either side — return the full
 * stage so overlays still have a stable frame to live in.
 */
export function containRect(stage: Size, video: Size): Rect {
  const stageWidth = positive(stage.width) ? stage.width : 0;
  const stageHeight = positive(stage.height) ? stage.height : 0;
  const full: Rect = { x: 0, y: 0, width: stageWidth, height: stageHeight };
  if (stageWidth === 0 || stageHeight === 0) return full;
  if (!positive(video.width) || !positive(video.height)) return full;
  const scale = Math.min(stageWidth / video.width, stageHeight / video.height);
  const width = video.width * scale;
  const height = video.height * scale;
  return {
    x: (stageWidth - width) / 2,
    y: (stageHeight - height) / 2,
    width,
    height,
  };
}

/** Normalized landmark (top-left origin, 0..1) → stage pixels inside rect. */
export function stagePoint(rect: Rect, landmark: Point): Point {
  return {
    x: rect.x + landmark.x * rect.width,
    y: rect.y + landmark.y * rect.height,
  };
}

// ─── Body scale ─────────────────────────────────────────────────────────────

/** Glow unit when the torso is not fully visible (native fallback). */
export const TORSO_UNIT_FALLBACK = 15;

/**
 * Glow radius unit from the observed torso extent (shoulder midpoint → hip
 * midpoint, in stage px): clamp(length × 0.17, 9, 30). Mirrors the native
 * PoseOverlayView.glowRadiusUnit so the aura hugs the athlete at any
 * distance; 15 when any of the four torso joints is missing.
 */
export function torsoUnit(points: Partial<Record<string, Point>>): number {
  const ls = points['left_shoulder'];
  const rs = points['right_shoulder'];
  const lh = points['left_hip'];
  const rh = points['right_hip'];
  if (!ls || !rs || !lh || !rh) return TORSO_UNIT_FALLBACK;
  const shoulderMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const hipMid = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const length = Math.hypot(hipMid.x - shoulderMid.x, hipMid.y - shoulderMid.y);
  if (!Number.isFinite(length)) return TORSO_UNIT_FALLBACK;
  return Math.min(30, Math.max(9, length * 0.17));
}

// ─── Tints ──────────────────────────────────────────────────────────────────

type Rgb = readonly [number, number, number];

const ON_DARK_HEX = '#F8FAF5';
const ON_DARK: Rgb = [248, 250, 245];
const WARN: Rgb = [168, 100, 22];
export const FLAME_HEX = '#FF9B42';
const FLAME: Rgb = [255, 155, 66];
export const VOLT_HEX = '#D7FA45';

/** Native heatStops: teal → mint → volt → flame at 0 / .35 / .7 / 1. */
const HEAT_STOPS: ReadonlyArray<readonly [number, Rgb]> = [
  [0, [26, 166, 138]],
  [0.35, [83, 217, 155]],
  [0.7, [215, 250, 69]],
  [1, [255, 155, 66]],
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(from: Rgb, to: Rgb, t: number): Rgb {
  return [
    lerp(from[0], to[0], t),
    lerp(from[1], to[1], t),
    lerp(from[2], to[2], t),
  ];
}

function rgbString(rgb: Rgb): string {
  return `rgb(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])})`;
}

/** Piecewise-linear ramp over HEAT_STOPS, exactly like native heatColor. */
export function heatRampColor(heat: number): Rgb {
  const t = clamp01(heat);
  for (let index = 1; index < HEAT_STOPS.length; index += 1) {
    const to = HEAT_STOPS[index];
    const from = HEAT_STOPS[index - 1];
    if (!to || !from || t > to[0]) continue;
    const span = Math.max(to[0] - from[0], 0.0001);
    return mix(from[1], to[1], (t - from[0]) / span);
  }
  const last = HEAT_STOPS[HEAT_STOPS.length - 1];
  return last ? last[1] : FLAME;
}

/**
 * Bone/joint tint: onDark mixed toward the heat ramp color by `heat`, so a
 * cold bone is the plain exoskeleton white and a hot one glows flame.
 * heat ≤ 0 returns the onDark token literally.
 */
export function heatTint(heat: number): string {
  const t = clamp01(heat);
  if (t === 0) return ON_DARK_HEX;
  return rgbString(mix(ON_DARK, heatRampColor(t), t));
}

/**
 * FAULT tint (not speed): warn → flame as heat rises, translucent by design
 * — alpha 0.18 + 0.30·heat — so the body stays visible under the region.
 */
export function faultTint(heat: number): string {
  const t = clamp01(heat);
  const [r, g, b] = mix(WARN, FLAME, t);
  const alpha = Math.round((0.18 + 0.3 * t) * 1000) / 1000;
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
}

// ─── Arrows ─────────────────────────────────────────────────────────────────

export interface Vector {
  dx: number;
  dy: number;
}

/**
 * Unit vector for an arrow's body-relative direction in stage space (y down):
 * up/down are vertical; forward/back follow the measured facing; wider/
 * narrower push the joint away from / toward the body center (a joint
 * exactly on the center line goes image-right); 'steadier' has no direction
 * and is drawn as a dashed ring instead → null.
 */
export function arrowVector(
  direction: ReviewArrow['direction'],
  facing: 1 | -1,
  joint: Point,
  bodyCenterX: number,
): Vector | null {
  switch (direction) {
    case 'up':
      return { dx: 0, dy: -1 };
    case 'down':
      return { dx: 0, dy: 1 };
    case 'forward':
      return { dx: facing, dy: 0 };
    case 'back':
      return { dx: -facing, dy: 0 };
    case 'wider': {
      const side = joint.x - bodyCenterX;
      return { dx: side < 0 ? -1 : 1, dy: 0 };
    }
    case 'narrower': {
      const side = joint.x - bodyCenterX;
      return { dx: side < 0 ? 1 : -1, dy: 0 };
    }
    case 'steadier':
    default:
      return null;
  }
}

// ─── Stops ──────────────────────────────────────────────────────────────────

/**
 * The stop to show at replay time tMs: a stop whose measured span contains
 * tMs (when spans overlap, the one whose checkpoint moment is nearest); else
 * the latest stop already passed (atMs ≤ tMs); else the first stop. Null
 * only for an empty script.
 */
export function currentStop(
  stops: readonly ReviewStop[],
  tMs: number,
): ReviewStop | null {
  if (stops.length === 0) return null;
  const t = Number.isFinite(tMs) ? tMs : 0;
  let containing: ReviewStop | null = null;
  for (const stop of stops) {
    if (!(t >= stop.startMs && t <= stop.endMs)) continue;
    if (
      containing === null ||
      Math.abs(stop.atMs - t) < Math.abs(containing.atMs - t)
    ) {
      containing = stop;
    }
  }
  if (containing) return containing;
  let passed: ReviewStop | null = null;
  for (const stop of stops) {
    if (stop.atMs <= t && (passed === null || stop.atMs >= passed.atMs)) {
      passed = stop;
    }
  }
  return passed ?? stops[0] ?? null;
}

/**
 * Auto-pause rule: the earliest unvisited stop whose checkpoint moment was
 * crossed by this progress tick (previousMs < atMs ≤ nowMs). A stop exactly
 * at previousMs was already handled by the tick that reached it; visited
 * stops never fire twice in one pass.
 */
export function nextAutoPause(
  stops: readonly ReviewStop[],
  previousMs: number,
  nowMs: number,
  visited: ReadonlySet<string>,
): ReviewStop | null {
  if (!Number.isFinite(previousMs) || !Number.isFinite(nowMs)) return null;
  let next: ReviewStop | null = null;
  for (const stop of stops) {
    if (visited.has(stop.id)) continue;
    if (!(stop.atMs > previousMs && stop.atMs <= nowMs)) continue;
    if (next === null || stop.atMs < next.atMs) next = stop;
  }
  return next;
}

// ─── Speed ──────────────────────────────────────────────────────────────────

/** Slow-motion steps the speed chip cycles through, real time first. */
export const REVIEW_SPEEDS: readonly number[] = [1, 0.5, 0.25];

export function speedLabel(rate: number): string {
  if (rate === 1) return '1×';
  if (rate === 0.5) return '½×';
  if (rate === 0.25) return '¼×';
  return `${rate}×`;
}
