import { describe, expect, it } from "vitest";
import {
  interpolateWrist,
  matchTrack,
  MIN_VELOCITY_STEPS,
  pearson,
  synchronyAtLag,
  SYNCHRONY_CASES,
  type WristSample,
} from "../src/ownershipSynchrony.js";
import type { PaddleTrackCandidate } from "../src/paddleTracker.js";
import type { PlayerTrack } from "../src/playerTracker.js";

/**
 * Synthetic-trajectory tests for the synchrony math. Real numbers come from
 * the committed-data measurement (pnpm own:synchrony).
 */

describe("pearson", () => {
  it("is 1 for identical series and -1 for negated series", () => {
    const a = [0.1, 0.3, 0.2, 0.5, 0.4];
    expect(pearson(a, a)).toBeCloseTo(1, 10);
    expect(
      pearson(
        a,
        a.map((value) => -value),
      ),
    ).toBeCloseTo(-1, 10);
  });

  it("is null on constant series (zero variance)", () => {
    expect(pearson([1, 1, 1], [0.2, 0.4, 0.6])).toBeNull();
  });
});

function playerFrames(
  samples: Array<{ tMs: number; x: number; y: number; v?: number }>,
): PlayerTrack["frames"] {
  return samples.map((sample) => ({
    timestampMs: sample.tMs,
    confidence: 1,
    joints: [{ n: "right_wrist", x: sample.x, y: sample.y, v: sample.v ?? 1 }],
    torsoMid: { x: 0.5, y: 0.5 },
    torsoSpan: 0.2,
  }));
}

describe("interpolateWrist", () => {
  const frames = playerFrames([
    { tMs: 0, x: 0.1, y: 0.2 },
    { tMs: 40, x: 0.3, y: 0.4 },
  ]);

  it("interpolates linearly between flanking frames", () => {
    const wrist = interpolateWrist(frames, "right_wrist", 20);
    expect(wrist).not.toBeNull();
    expect(wrist!.x).toBeCloseTo(0.2, 10);
    expect(wrist!.y).toBeCloseTo(0.3, 10);
  });

  it("returns null when flanking frames exceed the interpolation gap", () => {
    const sparse = playerFrames([
      { tMs: 0, x: 0.1, y: 0.2 },
      { tMs: 500, x: 0.3, y: 0.4 },
    ]);
    expect(interpolateWrist(sparse, "right_wrist", 250)).toBeNull();
  });

  it("ignores joints below the visibility floor", () => {
    const invisible = playerFrames([
      { tMs: 0, x: 0.1, y: 0.2, v: 0.05 },
      { tMs: 40, x: 0.3, y: 0.4, v: 0.05 },
    ]);
    expect(interpolateWrist(invisible, "right_wrist", 20)).toBeNull();
  });
});

describe("synchronyAtLag", () => {
  it("scores near 1 when the paddle moves with the wrist and near -1 against", () => {
    const paddle: WristSample[] = [];
    const withSamples: Array<{ tMs: number; x: number; y: number }> = [];
    const againstSamples: Array<{ tMs: number; x: number; y: number }> = [];
    for (let index = 0; index <= MIN_VELOCITY_STEPS + 2; index += 1) {
      const tMs = index * 33;
      const x = 0.3 + 0.1 * Math.sin(index / 2);
      const y = 0.5 + 0.08 * Math.cos(index / 3);
      paddle.push({ tMs, point: { x, y } });
      withSamples.push({ tMs, x: x + 0.05, y: y + 0.02 });
      againstSamples.push({ tMs, x: 1 - x, y: 1 - y });
    }
    const withWrist = synchronyAtLag(paddle, playerFrames(withSamples), "right_wrist", 0);
    const againstWrist = synchronyAtLag(paddle, playerFrames(againstSamples), "right_wrist", 0);
    expect(withWrist).not.toBeNull();
    expect(withWrist!.score).toBeGreaterThan(0.95);
    expect(againstWrist).not.toBeNull();
    expect(againstWrist!.score).toBeLessThan(-0.95);
  });

  it("abstains below the minimum aligned-step floor", () => {
    const paddle: WristSample[] = [
      { tMs: 0, point: { x: 0.3, y: 0.5 } },
      { tMs: 33, point: { x: 0.31, y: 0.5 } },
      { tMs: 66, point: { x: 0.33, y: 0.51 } },
    ];
    const frames = playerFrames([
      { tMs: 0, x: 0.35, y: 0.5 },
      { tMs: 33, x: 0.36, y: 0.5 },
      { tMs: 66, x: 0.38, y: 0.51 },
    ]);
    expect(synchronyAtLag(paddle, frames, "right_wrist", 0)).toBeNull();
  });
});

describe("matchTrack", () => {
  const track = (trackId: number, samples: Array<{ tMs: number; x: number; y: number }>) =>
    ({
      trackId,
      observations: samples.map((sample) => ({
        timestampMs: sample.tMs,
        box: { x: sample.x - 0.01, y: sample.y - 0.01, width: 0.02, height: 0.02 },
        center: { x: sample.x, y: sample.y },
        detectorScore: 0.8,
        trackId,
        confidence: 0.5,
        nearWrist: false,
      })),
      meanScore: 0.8,
      windowCoverage: 0.5,
      meanWristDistance: null,
    }) satisfies PaddleTrackCandidate;

  const tracks = [
    track(1, [{ tMs: 1000, x: 0.2, y: 0.3 }]),
    track(2, [{ tMs: 1000, x: 0.6, y: 0.7 }]),
  ];

  it("matches the nearest track within tolerance", () => {
    expect(matchTrack(tracks, 1010, { x: 0.21, y: 0.31 })?.trackId).toBe(1);
    expect(matchTrack(tracks, 1010, { x: 0.61, y: 0.69 })?.trackId).toBe(2);
  });

  it("returns null outside the time or distance gates", () => {
    expect(matchTrack(tracks, 2000, { x: 0.2, y: 0.3 })).toBeNull();
    expect(matchTrack(tracks, 1000, { x: 0.4, y: 0.5 })).toBeNull();
  });
});

describe("holdout discipline", () => {
  it("never registers the held-out cases", () => {
    expect(Object.keys(SYNCHRONY_CASES)).not.toContain("wm-dink-01");
    expect(Object.keys(SYNCHRONY_CASES)).not.toContain("afn-vic-rally1");
  });
});
