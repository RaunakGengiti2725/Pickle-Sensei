import {
  coverTransform,
  viewPointToSourcePoint,
} from '../src/camera/TargetSelector';

/**
 * "Tap yourself" coordinate honesty. The preview renders with
 * resizeMode="cover", which scales the source uniformly and center-crops the
 * overflow — so a raw view-normalized tap is NOT the tapped person's position
 * in the source image. These tests pin the pure inverse transform that turns
 * view taps into SOURCE-normalized seeds (what the native tracker consumes).
 */

describe('coverTransform', () => {
  it('landscape source in a portrait view: scales to height and crops width', () => {
    // 1920x1080 source shown in a 270x480 view.
    const t = coverTransform(
      { width: 270, height: 480 },
      { width: 1920, height: 1080 },
    );
    expect(t.scale).toBeCloseTo(480 / 1080, 12);
    // Scaled width 1920*(480/1080) = 853.33…; the view shows 270 of it.
    expect(t.offsetX).toBeCloseTo((1920 * (480 / 1080) - 270) / 2, 9);
    expect(t.offsetY).toBeCloseTo(0, 12);
  });

  it('portrait source taller than the view: scales to width and crops height', () => {
    const t = coverTransform(
      { width: 300, height: 400 },
      { width: 1080, height: 1920 },
    );
    expect(t.scale).toBeCloseTo(300 / 1080, 12);
    expect(t.offsetX).toBeCloseTo(0, 12);
    expect(t.offsetY).toBeCloseTo((1920 * (300 / 1080) - 400) / 2, 9);
  });

  it('matching aspect ratios: no crop on either axis', () => {
    const t = coverTransform(
      { width: 270, height: 480 },
      { width: 720, height: 1280 },
    );
    expect(t.scale).toBeCloseTo(270 / 720, 12);
    expect(t.offsetX).toBeCloseTo(0, 12);
    expect(t.offsetY).toBeCloseTo(0, 12);
  });
});

describe('viewPointToSourcePoint', () => {
  const view = { width: 270, height: 480 };
  const landscape = { width: 1920, height: 1080 };

  it('maps the view center to the source center (cover crop is centered)', () => {
    const point = viewPointToSourcePoint({ x: 135, y: 240 }, view, landscape);
    expect(point.x).toBeCloseTo(0.5, 12);
    expect(point.y).toBeCloseTo(0.5, 12);
  });

  it('maps the view edges to the visible-crop edges, not the source edges', () => {
    const { scale, offsetX } = coverTransform(view, landscape);
    const left = viewPointToSourcePoint({ x: 0, y: 240 }, view, landscape);
    const right = viewPointToSourcePoint({ x: 270, y: 240 }, view, landscape);
    expect(left.x).toBeCloseTo(offsetX / (landscape.width * scale), 12);
    expect(right.x).toBeCloseTo(
      (270 + offsetX) / (landscape.width * scale),
      12,
    );
    // The crop is symmetric: what is hidden on the left equals the right.
    expect(right.x).toBeCloseTo(1 - left.x, 12);
    // A landscape video in a portrait view hides a large share of each side.
    expect(left.x).toBeGreaterThan(0.3);
    expect(right.x).toBeLessThan(0.7);
  });

  it('round-trips: re-projecting the source point lands on the tapped pixel', () => {
    const tap = { x: 200.5, y: 111.25 };
    const { scale, offsetX, offsetY } = coverTransform(view, landscape);
    const source = viewPointToSourcePoint(tap, view, landscape);
    expect(source.x * landscape.width * scale - offsetX).toBeCloseTo(tap.x, 9);
    expect(source.y * landscape.height * scale - offsetY).toBeCloseTo(tap.y, 9);
  });

  it('crops vertically for a source taller than the view aspect', () => {
    const tallView = { width: 300, height: 400 };
    const portrait = { width: 1080, height: 1920 };
    const top = viewPointToSourcePoint({ x: 150, y: 0 }, tallView, portrait);
    const { scale, offsetY } = coverTransform(tallView, portrait);
    expect(top.x).toBeCloseTo(0.5, 12);
    expect(top.y).toBeCloseTo(offsetY / (portrait.height * scale), 12);
    expect(top.y).toBeGreaterThan(0);
  });

  it('is identical to plain view-normalization when aspects match', () => {
    const sameAspect = { width: 720, height: 1280 };
    const point = viewPointToSourcePoint(
      { x: 0.42 * 270, y: 0.63 * 480 },
      view,
      sameAspect,
    );
    expect(point.x).toBeCloseTo(0.42, 12);
    expect(point.y).toBeCloseTo(0.63, 12);
  });

  it('clamps to [0,1] even for taps outside the layout box', () => {
    const point = viewPointToSourcePoint({ x: -50, y: 9999 }, view, landscape);
    expect(point.x).toBeGreaterThanOrEqual(0);
    expect(point.x).toBeLessThanOrEqual(1);
    expect(point.y).toBeGreaterThanOrEqual(0);
    expect(point.y).toBeLessThanOrEqual(1);
  });

  it('falls back to view-normalization when source dimensions are absent', () => {
    const point = viewPointToSourcePoint({ x: 135, y: 120 }, view, null);
    expect(point.x).toBeCloseTo(0.5, 12);
    expect(point.y).toBeCloseTo(0.25, 12);
  });

  it('never trusts degenerate source dimensions', () => {
    for (const source of [
      { width: 0, height: 1080 },
      { width: 1920, height: 0 },
      { width: -1920, height: 1080 },
      { width: Number.NaN, height: 1080 },
      { width: 1920, height: Number.POSITIVE_INFINITY },
    ]) {
      const point = viewPointToSourcePoint({ x: 135, y: 120 }, view, source);
      // Honest fallback: identical to the no-dimensions behavior.
      expect(point.x).toBeCloseTo(0.5, 12);
      expect(point.y).toBeCloseTo(0.25, 12);
    }
  });
});
