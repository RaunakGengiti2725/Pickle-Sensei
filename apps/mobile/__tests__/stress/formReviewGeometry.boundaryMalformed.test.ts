import {
  REVIEW_SPEEDS,
  TORSO_UNIT_FALLBACK,
  arrowVector,
  clamp01,
  containRect,
  currentStop,
  faultTint,
  heatRampColor,
  heatTint,
  nextAutoPause,
  speedLabel,
  stagePoint,
  torsoUnit,
  type Point,
} from '../../src/review/formReviewGeometry';
import type { ReviewStop } from '../../src/review/formReviewModel';
import {
  PROTO_KEYS,
  ResultTable,
  brokenSummary,
  campaignPlan,
  invariant,
  runCase,
  safeString,
  weirdNumber,
  weirdString,
  type Rng,
} from '../../test-support/stress/reviewMalformed';

/**
 * STRESS · boundary/malformed input · formReviewGeometry.
 *
 * Pure math with a documented degenerate-input contract ("return the full
 * stage so overlays still have a stable frame", "heat ≤ 0 returns onDark",
 * "null only for an empty script"). Every function is driven with NaN /
 * ±Infinity / -0 / overflow / subnormal numbers and prototype-named joint
 * tables; the invariants are: never throws, outputs finite and in range,
 * colours are well-formed CSS strings, stops returned are always members of
 * the input list.
 */

const table = new ResultTable('formReviewGeometry');
const plan = campaignPlan(60);

afterAll(() => {
  table.flush();
});

const RGB = /^rgb\((\d+),(\d+),(\d+)\)$/;
const RGBA = /^rgba\((\d+),(\d+),(\d+),(0(\.\d+)?|1)\)$/;

function num(rng: Rng): number {
  return rng.chance(0.7) ? weirdNumber(rng) : rng.float() * 2000 - 500;
}

function point(rng: Rng): Point {
  return { x: num(rng), y: num(rng) };
}

function stop(rng: Rng, index: number): ReviewStop {
  const startMs = num(rng);
  return {
    id: rng.chance(0.1) ? rng.pick(PROTO_KEYS) : `stop-${index}`,
    phase: 'contact',
    atMs: num(rng),
    startMs,
    endMs: rng.chance(0.5) ? startMs + Math.abs(num(rng)) : num(rng),
    title: 'Contact',
    verdict: 'watch',
    checkpoints: [],
    headline: 'h',
    cue: 'c',
    focusJoints: ['right_wrist'],
    arrow: null,
  };
}

describe('formReviewGeometry · boundary/malformed campaigns', () => {
  it('fit/projection/body-scale never throw and keep a stable finite frame', () => {
    for (let i = 0; i < plan.iterations; i += 1) {
      runCase(table, 'fitAndProject', plan.seedAt(i), (rng, log) => {
        const stage = { width: num(rng), height: num(rng) };
        const video = { width: num(rng), height: num(rng) };
        log.push(`stage=${safeString(stage)}`, `video=${safeString(video)}`);
        const rect = containRect(stage, video);
        for (const [k, v] of Object.entries(rect)) {
          invariant(
            Number.isFinite(v),
            `containRect.${k} finite (got ${String(v)}) for ${safeString(video)} in ${safeString(stage)}`,
          );
        }
        invariant(
          rect.width >= 0 && rect.height >= 0,
          'containRect non-negative',
        );
        const stageW =
          Number.isFinite(stage.width) && stage.width > 0 ? stage.width : 0;
        const stageH =
          Number.isFinite(stage.height) && stage.height > 0 ? stage.height : 0;
        invariant(
          rect.width <= stageW * (1 + 1e-9) &&
            rect.height <= stageH * (1 + 1e-9),
          `containRect fits inside stage (${safeString(rect)})`,
        );
        invariant(
          rect.x >= -1e-6 && rect.y >= -1e-6,
          `containRect origin inside stage (${safeString(rect)})`,
        );
        const projected = stagePoint(rect, point(rng));
        invariant(
          typeof projected.x === 'number' && typeof projected.y === 'number',
          'stagePoint returns numbers',
        );
        const unit = torsoUnit({
          left_shoulder: rng.chance(0.85) ? point(rng) : undefined,
          right_shoulder: rng.chance(0.85) ? point(rng) : undefined,
          left_hip: rng.chance(0.85) ? point(rng) : undefined,
          right_hip: rng.chance(0.85) ? point(rng) : undefined,
          [weirdString(rng)]: point(rng),
        });
        invariant(
          unit === TORSO_UNIT_FALLBACK ||
            (Number.isFinite(unit) && unit >= 9 && unit <= 30),
          `torsoUnit in [9,30] or fallback (got ${String(unit)})`,
        );
        invariant(
          torsoUnit(
            Object.fromEntries(PROTO_KEYS.map(k => [k, point(rng)])) as Record<
              string,
              Point
            >,
          ) === TORSO_UNIT_FALLBACK,
          'torsoUnit ignores prototype-named joints',
        );
      });
    }
    expect(brokenSummary(table)).toBe(`0 broken of ${table.records.length}`);
  });

  it('tints are well-formed and clamp01 stays in [0,1] for every numeric edge', () => {
    const before = table.records.length;
    for (let i = 0; i < plan.iterations; i += 1) {
      runCase(table, 'tints', plan.seedAt(i, 0x7177), (rng, log) => {
        const heat = num(rng);
        log.push(`heat=${String(heat)}`);
        const c = clamp01(heat);
        invariant(
          c >= 0 && c <= 1 && !Number.isNaN(c),
          `clamp01(${heat}) in [0,1]`,
        );
        invariant(
          heat >= 0 && heat <= 1 ? c === heat : true,
          'clamp01 identity inside range',
        );
        const ramp = heatRampColor(heat);
        invariant(
          ramp.length === 3 &&
            ramp.every(v => Number.isFinite(v) && v >= 0 && v <= 255),
          `heatRampColor(${heat}) rgb in range (got ${safeString(ramp)})`,
        );
        const tint = heatTint(heat);
        invariant(
          tint === '#F8FAF5' || RGB.test(tint),
          `heatTint(${heat}) well-formed (got ${tint})`,
        );
        invariant(
          c === 0 ? tint === '#F8FAF5' : tint !== '#F8FAF5',
          `heatTint(${heat}) onDark iff heat ≤ 0/NaN`,
        );
        const fault = faultTint(heat);
        const match = RGBA.exec(fault);
        invariant(
          match !== null,
          `faultTint(${heat}) well-formed (got ${fault})`,
        );
        const alpha = Number(match![4]);
        invariant(
          alpha >= 0.18 - 1e-9 && alpha <= 0.48 + 1e-9,
          `faultTint alpha in [0.18,0.48] (got ${alpha})`,
        );
        for (const channel of [1, 2, 3]) {
          const v = Number(match![channel]);
          invariant(
            v >= 0 && v <= 255,
            `faultTint channel ${channel} in range`,
          );
        }
      });
    }
    expect(brokenSummary(table.since(before))).toBe(
      `0 broken of ${table.records.length - before}`,
    );
  });

  it('arrowVector / currentStop / nextAutoPause / speedLabel never throw and stay within their inputs', () => {
    const before = table.records.length;
    for (let i = 0; i < plan.iterations; i += 1) {
      runCase(table, 'stopsAndArrows', plan.seedAt(i, 0x5a5a), (rng, log) => {
        const direction = rng.pick([
          'up',
          'down',
          'forward',
          'back',
          'wider',
          'narrower',
          'steadier',
          ...PROTO_KEYS,
          '',
          'UP',
        ]);
        // `facing` is only ever produced by facingSign() (always ±1), so the
        // unit-vector contract is asserted for those; other values only
        // have to not throw.
        const facing = rng.pick([1, -1, 0, NaN, 2] as const);
        log.push(`direction=${direction}`, `facing=${String(facing)}`);
        const vector = arrowVector(
          direction as never,
          facing as never,
          point(rng),
          num(rng),
        );
        if (vector !== null) {
          invariant(
            typeof vector.dx === 'number' && typeof vector.dy === 'number',
            'arrowVector returns numeric components',
          );
          if (facing === 1 || facing === -1) {
            invariant(
              Math.abs(Math.hypot(vector.dx, vector.dy) - 1) < 1e-9,
              `arrowVector(${direction}) is a unit vector (got ${safeString(vector)})`,
            );
          }
        } else {
          invariant(
            !['up', 'down', 'forward', 'back', 'wider', 'narrower'].includes(
              direction,
            ),
            `arrowVector(${direction}) must not be null`,
          );
        }

        const count = rng.pick([0, 1, 2, 5, 40]);
        const stops: ReviewStop[] = [];
        for (let s = 0; s < count; s += 1) stops.push(stop(rng, s));
        log.push(`stops=${count}`);
        const t = num(rng);
        const current = currentStop(stops, t);
        invariant(
          count === 0 ? current === null : current !== null,
          `currentStop null iff empty (count=${count}, t=${t})`,
        );
        invariant(
          current === null || stops.includes(current),
          'currentStop returns a member of the list',
        );
        const visited = new Set<string>();
        if (rng.chance(0.5) && stops.length > 0)
          visited.add(rng.pick(stops).id);
        const previous = num(rng);
        const now = num(rng);
        const next = nextAutoPause(stops, previous, now, visited);
        if (next !== null) {
          invariant(stops.includes(next), 'nextAutoPause returns a member');
          invariant(!visited.has(next.id), 'nextAutoPause skips visited ids');
          invariant(
            next.atMs > previous && next.atMs <= now,
            `nextAutoPause crossing rule (${previous} < ${next.atMs} <= ${now})`,
          );
          invariant(
            Number.isFinite(previous) && Number.isFinite(now),
            'nextAutoPause null when the tick is non-finite',
          );
        }
        const rate = rng.pick([...REVIEW_SPEEDS, num(rng)]);
        const label = speedLabel(rate);
        invariant(
          typeof label === 'string' && label.endsWith('×'),
          `speedLabel(${rate}) labelled`,
        );
      });
    }
    expect(brokenSummary(table.since(before))).toBe(
      `0 broken of ${table.records.length - before}`,
    );
  });
});

describe('formReviewGeometry · pinned boundary probes', () => {
  it('containRect keeps a finite frame for subnormal (positive, finite) video dimensions', () => {
    const rect = containRect(
      { width: 390, height: 844 },
      { width: Number.MIN_VALUE, height: Number.MIN_VALUE },
    );
    expect(Object.values(rect).every(Number.isFinite)).toBe(true);
    expect(rect.width).toBeLessThanOrEqual(390);
    expect(rect.height).toBeLessThanOrEqual(844);
  });

  it('containRect returns the full stage for NaN / Infinity / -0 video dimensions', () => {
    for (const bad of [NaN, Infinity, -Infinity, -0, 0, -1]) {
      expect(
        containRect({ width: 390, height: 844 }, { width: bad, height: 100 }),
      ).toEqual({
        x: 0,
        y: 0,
        width: 390,
        height: 844,
      });
    }
  });

  it('clamp01 maps -0, NaN and ±Infinity into [0,1]', () => {
    expect(Object.is(clamp01(-0), -0) || clamp01(-0) === 0).toBe(true);
    // Documented contract: non-finite → 0 (not "nearest bound").
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
    expect(heatTint(-0)).toBe('#F8FAF5');
  });
});
