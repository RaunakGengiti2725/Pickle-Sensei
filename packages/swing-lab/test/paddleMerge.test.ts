import { describe, expect, it } from "vitest";
import { mergePaddleTracklets, type PaddleTrackCandidate } from "../src/index.js";

/** Tracklet with a constant-velocity path, used to build merge scenarios. */
function tracklet(
  trackId: number,
  startMs: number,
  count: number,
  from: { x: number; y: number },
  velocity: { x: number; y: number },
  size = 0.06,
): PaddleTrackCandidate {
  const observations = Array.from({ length: count }, (_, index) => {
    const tMs = startMs + index * 33;
    const x = from.x + (velocity.x * (tMs - startMs)) / 1000;
    const y = from.y + (velocity.y * (tMs - startMs)) / 1000;
    return {
      timestampMs: tMs,
      box: { x: x - size / 2, y: y - size / 2, width: size, height: size },
      center: { x, y },
      detectorScore: 0.5,
      trackId,
      confidence: 0.5,
      nearWrist: true,
    };
  });
  return { trackId, observations, meanScore: 0.5, windowCoverage: 0.2, meanWristDistance: null };
}

const WINDOW = { startMs: 0, endMs: 3000 };

describe("mergePaddleTracklets", () => {
  it("links fragments of one physical paddle across a short gap", () => {
    const a = tracklet(1, 1000, 5, { x: 0.3, y: 0.5 }, { x: 0.4, y: 0 });
    // Continues the same trajectory after a ~130ms hole.
    const b = tracklet(2, 1300, 5, { x: 0.42, y: 0.5 }, { x: 0.4, y: 0 });
    const { merged, links } = mergePaddleTracklets([a, b], WINDOW);
    expect(links).toBe(1);
    expect(merged.length).toBe(1);
    expect(merged[0]!.observations.length).toBe(10);
    // Timestamps stay ordered and no position is invented.
    const times = merged[0]!.observations.map((observation) => observation.timestampMs);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    expect(new Set(times).size).toBe(10);
  });

  it("refuses to merge a distant object moving elsewhere", () => {
    const a = tracklet(1, 1000, 5, { x: 0.3, y: 0.5 }, { x: 0.4, y: 0 });
    const other = tracklet(2, 1300, 5, { x: 0.85, y: 0.2 }, { x: -0.4, y: 0 });
    const { merged, links } = mergePaddleTracklets([a, other], WINDOW);
    expect(links).toBe(0);
    expect(merged.length).toBe(2);
  });

  it("refuses to merge across an implausibly long gap", () => {
    const a = tracklet(1, 1000, 5, { x: 0.3, y: 0.5 }, { x: 0.0, y: 0 });
    const b = tracklet(2, 2200, 5, { x: 0.3, y: 0.5 }, { x: 0.0, y: 0 }); // >500ms later
    const { links } = mergePaddleTracklets([a, b], WINDOW);
    expect(links).toBe(0);
  });

  it("refuses to merge objects of incompatible scale", () => {
    const a = tracklet(1, 1000, 5, { x: 0.3, y: 0.5 }, { x: 0.4, y: 0 }, 0.05);
    const big = tracklet(2, 1300, 5, { x: 0.42, y: 0.5 }, { x: 0.4, y: 0 }, 0.3);
    const { links } = mergePaddleTracklets([a, big], WINDOW);
    expect(links).toBe(0);
  });

  it("never creates a cycle or duplicates observations", () => {
    const a = tracklet(1, 1000, 5, { x: 0.3, y: 0.5 }, { x: 0.4, y: 0 });
    const b = tracklet(2, 1300, 5, { x: 0.42, y: 0.5 }, { x: 0.4, y: 0 });
    const c = tracklet(3, 1600, 5, { x: 0.54, y: 0.5 }, { x: 0.4, y: 0 });
    const { merged } = mergePaddleTracklets([a, b, c], WINDOW);
    const total = merged.reduce((sum, entry) => sum + entry.observations.length, 0);
    expect(total).toBe(15); // every observation survives exactly once
  });
});
