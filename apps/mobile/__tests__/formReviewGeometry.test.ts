import type { ReviewStop } from '../src/review/formReviewModel';
import {
  REVIEW_SPEEDS,
  TORSO_UNIT_FALLBACK,
  arrowVector,
  containRect,
  currentStop,
  faultTint,
  heatRampColor,
  heatTint,
  nextAutoPause,
  speedLabel,
  stagePoint,
  torsoUnit,
} from '../src/review/formReviewGeometry';

/**
 * Form review geometry — the pure math between the review script and the
 * screen. Letterboxing, projection, body-scaled glow unit, tints, arrow
 * directions, stop selection and the auto-pause crossing rule are pinned
 * here so the screen can trust them blindly.
 */

function stop(
  id: string,
  atMs: number,
  startMs: number,
  endMs: number,
  overrides: Partial<ReviewStop> = {},
): ReviewStop {
  return {
    id,
    phase: 'contact',
    atMs,
    startMs,
    endMs,
    title: id,
    verdict: 'watch',
    checkpoints: [],
    headline: '',
    cue: '',
    focusJoints: [],
    arrow: null,
    ...overrides,
  };
}

const STOPS: ReviewStop[] = [
  stop('ready', 450, 0, 900),
  stop('prepare', 1200, 900, 1500),
  stop('accelerate', 1700, 1500, 1900),
  stop('contact', 1900, 1880, 1920),
  stop('recover', 2800, 2400, 3200),
];

describe('containRect', () => {
  it('letterboxes a portrait video inside a wider stage (pillarbox, centered)', () => {
    const rect = containRect(
      { width: 400, height: 400 },
      { width: 1080, height: 1920 },
    );
    expect(rect.height).toBeCloseTo(400);
    expect(rect.width).toBeCloseTo(225);
    expect(rect.x).toBeCloseTo(87.5);
    expect(rect.y).toBeCloseTo(0);
  });

  it('letterboxes a landscape video inside a taller stage (bars top and bottom)', () => {
    const rect = containRect(
      { width: 360, height: 640 },
      { width: 1920, height: 1080 },
    );
    expect(rect.width).toBeCloseTo(360);
    expect(rect.height).toBeCloseTo(202.5);
    expect(rect.x).toBeCloseTo(0);
    expect(rect.y).toBeCloseTo((640 - 202.5) / 2);
  });

  it('fills the stage exactly when aspect ratios match', () => {
    expect(
      containRect({ width: 180, height: 320 }, { width: 1080, height: 1920 }),
    ).toEqual({ x: 0, y: 0, width: 180, height: 320 });
  });

  it('degenerate video or stage dimensions fall back to the full stage', () => {
    expect(
      containRect({ width: 300, height: 500 }, { width: 0, height: 1920 }),
    ).toEqual({ x: 0, y: 0, width: 300, height: 500 });
    expect(
      containRect(
        { width: 300, height: 500 },
        { width: Number.NaN, height: 1 },
      ),
    ).toEqual({ x: 0, y: 0, width: 300, height: 500 });
    expect(
      containRect({ width: 0, height: 500 }, { width: 1080, height: 1920 }),
    ).toEqual({ x: 0, y: 0, width: 0, height: 500 });
    expect(
      containRect(
        { width: Number.POSITIVE_INFINITY, height: -3 },
        { width: 1080, height: 1920 },
      ),
    ).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('stagePoint', () => {
  it('projects a normalized top-left landmark into the rect', () => {
    const rect = { x: 50, y: 20, width: 200, height: 400 };
    expect(stagePoint(rect, { x: 0, y: 0 })).toEqual({ x: 50, y: 20 });
    expect(stagePoint(rect, { x: 1, y: 1 })).toEqual({ x: 250, y: 420 });
    expect(stagePoint(rect, { x: 0.5, y: 0.25 })).toEqual({ x: 150, y: 120 });
  });
});

describe('torsoUnit', () => {
  const torso = (length: number) => ({
    left_shoulder: { x: 90, y: 100 },
    right_shoulder: { x: 110, y: 100 },
    left_hip: { x: 92, y: 100 + length },
    right_hip: { x: 108, y: 100 + length },
  });

  it('is 17% of the shoulder-mid → hip-mid length, clamped to 9..30', () => {
    expect(torsoUnit(torso(100))).toBeCloseTo(17);
    expect(torsoUnit(torso(20))).toBe(9);
    expect(torsoUnit(torso(400))).toBe(30);
  });

  it('falls back to 15 when any torso joint is missing', () => {
    const { right_hip: _dropped, ...partial } = torso(100);
    expect(torsoUnit(partial)).toBe(TORSO_UNIT_FALLBACK);
    expect(torsoUnit({})).toBe(15);
  });
});

describe('heat tints', () => {
  it('heatTint: cold is the onDark token, hot is flame, in between mixes', () => {
    expect(heatTint(0)).toBe('#F8FAF5');
    expect(heatTint(-1)).toBe('#F8FAF5');
    expect(heatTint(Number.NaN)).toBe('#F8FAF5');
    expect(heatTint(1)).toBe('rgb(255,155,66)');
    expect(heatTint(2)).toBe('rgb(255,155,66)');
    const mid = heatTint(0.5);
    expect(mid).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    expect(mid).not.toBe('#F8FAF5');
    expect(mid).not.toBe('rgb(255,155,66)');
  });

  it('heatRampColor hits the native stops exactly', () => {
    const rounded = (heat: number) =>
      heatRampColor(heat).map(channel => Math.round(channel));
    expect(rounded(0)).toEqual([26, 166, 138]);
    expect(rounded(0.35)).toEqual([83, 217, 155]);
    expect(rounded(0.7)).toEqual([215, 250, 69]);
    expect(rounded(1)).toEqual([255, 155, 66]);
  });

  it('faultTint: warn at 0 with alpha .18, flame at 1 with alpha .48', () => {
    expect(faultTint(0)).toBe('rgba(168,100,22,0.18)');
    expect(faultTint(1)).toBe('rgba(255,155,66,0.48)');
    expect(faultTint(0.5)).toBe('rgba(212,128,44,0.33)');
  });
});

describe('arrowVector', () => {
  const joint = { x: 120, y: 200 };
  const center = 100;

  it('up / down are vertical regardless of facing', () => {
    expect(arrowVector('up', 1, joint, center)).toEqual({ dx: 0, dy: -1 });
    expect(arrowVector('up', -1, joint, center)).toEqual({ dx: 0, dy: -1 });
    expect(arrowVector('down', 1, joint, center)).toEqual({ dx: 0, dy: 1 });
    expect(arrowVector('down', -1, joint, center)).toEqual({ dx: 0, dy: 1 });
  });

  it('forward / back follow the measured facing', () => {
    expect(arrowVector('forward', 1, joint, center)).toEqual({ dx: 1, dy: 0 });
    expect(arrowVector('forward', -1, joint, center)).toEqual({
      dx: -1,
      dy: 0,
    });
    expect(arrowVector('back', 1, joint, center)).toEqual({ dx: -1, dy: 0 });
    expect(arrowVector('back', -1, joint, center)).toEqual({ dx: 1, dy: 0 });
  });

  it('wider pushes away from the body center, narrower toward it', () => {
    expect(arrowVector('wider', 1, joint, center)).toEqual({ dx: 1, dy: 0 });
    expect(arrowVector('wider', -1, { x: 80, y: 0 }, center)).toEqual({
      dx: -1,
      dy: 0,
    });
    expect(arrowVector('narrower', 1, joint, center)).toEqual({
      dx: -1,
      dy: 0,
    });
    expect(arrowVector('narrower', 1, { x: 80, y: 0 }, center)).toEqual({
      dx: 1,
      dy: 0,
    });
    // On the center line: wider goes image-right, narrower image-left.
    expect(arrowVector('wider', -1, { x: 100, y: 0 }, center)).toEqual({
      dx: 1,
      dy: 0,
    });
    expect(arrowVector('narrower', -1, { x: 100, y: 0 }, center)).toEqual({
      dx: -1,
      dy: 0,
    });
  });

  it('steadier has no direction (drawn as a ring)', () => {
    expect(arrowVector('steadier', 1, joint, center)).toBeNull();
    expect(arrowVector('steadier', -1, joint, center)).toBeNull();
  });
});

describe('currentStop', () => {
  it('returns the stop whose span contains the time', () => {
    expect(currentStop(STOPS, 1000)?.id).toBe('prepare');
    expect(currentStop(STOPS, 0)?.id).toBe('ready');
    expect(currentStop(STOPS, 3200)?.id).toBe('recover');
  });

  it('prefers the nearest checkpoint moment when spans overlap', () => {
    // 1890 sits in both accelerate (1500–1900) and contact (1880–1920).
    expect(currentStop(STOPS, 1890)?.id).toBe('contact');
    expect(currentStop(STOPS, 1881)?.id).toBe('contact');
  });

  it('falls back to the latest passed stop in a gap, then to the first stop', () => {
    expect(currentStop(STOPS, 2000)?.id).toBe('contact');
    expect(currentStop(STOPS, 2399)?.id).toBe('contact');
    expect(currentStop(STOPS, 99_999)?.id).toBe('recover');
    expect(currentStop(STOPS.slice(1), 100)?.id).toBe('prepare');
    expect(currentStop(STOPS, -50)?.id).toBe('ready');
  });

  it('null only for an empty script; non-finite time reads as 0', () => {
    expect(currentStop([], 1000)).toBeNull();
    expect(currentStop(STOPS, Number.NaN)?.id).toBe('ready');
  });
});

describe('nextAutoPause', () => {
  it('fires for the earliest unvisited stop crossed by a tick', () => {
    expect(nextAutoPause(STOPS, 400, 500, new Set())?.id).toBe('ready');
    // A big tick that jumps two stops pauses at the earlier one first.
    expect(nextAutoPause(STOPS, 1000, 1800, new Set())?.id).toBe('prepare');
    expect(nextAutoPause(STOPS, 1000, 1800, new Set(['prepare']))?.id).toBe(
      'accelerate',
    );
  });

  it('is inclusive at nowMs and exclusive at previousMs (no double fire)', () => {
    expect(nextAutoPause(STOPS, 1899, 1900, new Set())?.id).toBe('contact');
    // The tick that starts exactly at the checkpoint already handled it.
    expect(nextAutoPause(STOPS, 1900, 1910, new Set())).toBeNull();
    // Resuming from a pause at atMs never re-fires that stop.
    expect(nextAutoPause(STOPS, 1900, 1950, new Set(['contact']))).toBeNull();
  });

  it('never fires a visited stop, on a backwards tick, or on non-finite input', () => {
    const visited = new Set(STOPS.map(entry => entry.id));
    expect(nextAutoPause(STOPS, 0, 5000, visited)).toBeNull();
    expect(nextAutoPause(STOPS, 2000, 1000, new Set())).toBeNull();
    expect(nextAutoPause(STOPS, Number.NaN, 1000, new Set())).toBeNull();
    expect(nextAutoPause([], 0, 5000, new Set())).toBeNull();
  });

  it('one full pass fires each stop exactly once, in order', () => {
    const visited = new Set<string>();
    const fired: string[] = [];
    let previous = 0;
    for (let now = 33; now <= 3300; now += 33) {
      let next = nextAutoPause(STOPS, previous, now, visited);
      while (next) {
        fired.push(next.id);
        visited.add(next.id);
        next = nextAutoPause(STOPS, previous, now, visited);
      }
      previous = now;
    }
    expect(fired).toEqual([
      'ready',
      'prepare',
      'accelerate',
      'contact',
      'recover',
    ]);
  });
});

describe('speed', () => {
  it('labels the review speeds with fraction glyphs', () => {
    expect(REVIEW_SPEEDS).toEqual([1, 0.5, 0.25]);
    expect(speedLabel(1)).toBe('1×');
    expect(speedLabel(0.5)).toBe('½×');
    expect(speedLabel(0.25)).toBe('¼×');
    expect(speedLabel(0.75)).toBe('0.75×');
  });
});
