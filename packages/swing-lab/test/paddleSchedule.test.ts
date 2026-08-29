import { describe, expect, it } from "vitest";
import {
  DEFAULT_TWO_PASS_CONFIG,
  mergePaddleDetectionFiles,
  planTwoPassSchedule,
  type TwoPassScheduleInput,
} from "../src/paddleSchedule.js";
import type { PaddleTrackCandidate, RawPaddleDetectionFile } from "../src/paddleTracker.js";

/**
 * Pure-plan tests: the scheduler sees only sparse-pass artifacts, so every
 * densification trigger (event peak, uncertainty, speed change, missing
 * frames) can be exercised with synthetic inputs on Linux.
 */

const SPAN = { startMs: 0, endMs: 3000 };
const FRAME_MS = 20; // 50fps

function track(
  timestamps: number[],
  options: { confidence?: number; trackId?: number } = {},
): PaddleTrackCandidate {
  return {
    trackId: options.trackId ?? 1,
    observations: timestamps.map((tMs) => ({
      timestampMs: tMs,
      box: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 },
      center: { x: 0.45, y: 0.45 },
      detectorScore: 0.6,
      trackId: options.trackId ?? 1,
      confidence: options.confidence ?? 0.8,
      nearWrist: true,
    })),
    meanScore: 0.6,
    windowCoverage: 0.9,
    meanWristDistance: 0.05,
  };
}

function planInput(overrides: Partial<TwoPassScheduleInput> = {}): TwoPassScheduleInput {
  return {
    detectSpan: SPAN,
    frameIntervalMs: FRAME_MS,
    primaryTrack: null,
    paddleSpeeds: null,
    eventPeaksMs: [],
    ...overrides,
  };
}

function detsFile(
  tMsList: number[],
  options: { framesProcessed?: number; score?: number } = {},
): RawPaddleDetectionFile {
  return {
    schemaVersion: 1,
    detector: {
      modelId: "test",
      version: "test",
      license: "Apache-2.0",
      device: "cpu",
      proxyLabels: ["tennis racket"],
      proxyNote: "",
      scoreFloor: 0.08,
    },
    video: { path: "test.mp4", width: 1000, height: 1000, fps: 50, durationMs: 4000 },
    window: { startMs: SPAN.startMs, endMs: SPAN.endMs },
    timing: {
      modelLoadSec: 0,
      framesProcessed: options.framesProcessed ?? tMsList.length,
      inferenceSecTotal: tMsList.length * 0.1,
      inferenceMsPerFrame: 100,
      wallSecTotal: tMsList.length * 0.1,
    },
    frames: tMsList.map((tMs) => ({
      tMs,
      detections: [
        { box: [400, 400, 100, 100], score: options.score ?? 0.5, label: "tennis racket" },
      ],
      extras: [],
    })),
  };
}

describe("planTwoPassSchedule", () => {
  it("plans no dense regions when the sparse pass is clean and eventless", () => {
    // Full-coverage confident track spanning the whole span, steady speed.
    const timestamps: number[] = [];
    for (let tMs = SPAN.startMs; tMs <= SPAN.endMs; tMs += FRAME_MS * 3) timestamps.push(tMs);
    const schedule = planTwoPassSchedule(
      planInput({
        primaryTrack: track(timestamps),
        paddleSpeeds: timestamps.slice(1).map((tMs) => ({ timestampMs: tMs, value: 1 })),
      }),
    );
    expect(schedule.denseRegions).toEqual([]);
    expect(schedule.planned.denseOnlyFrames).toBe(0);
    expect(schedule.planned.totalFrames).toBe(schedule.planned.sparseFrames);
  });

  it("densifies around the event peak with the configured pad", () => {
    const schedule = planTwoPassSchedule(planInput({ eventPeaksMs: [1500] }));
    expect(schedule.denseRegions).toHaveLength(1);
    const region = schedule.denseRegions[0]!;
    expect(region.reasons).toEqual(["event_peak"]);
    expect(region.startMs).toBeLessThanOrEqual(1500 - DEFAULT_TWO_PASS_CONFIG.eventPeakPadMs);
    expect(region.endMs).toBeGreaterThanOrEqual(1500 + DEFAULT_TWO_PASS_CONFIG.eventPeakPadMs);
  });

  it("clamps dense regions to the detect span", () => {
    const schedule = planTwoPassSchedule(planInput({ eventPeaksMs: [50, 2980] }));
    for (const region of schedule.denseRegions) {
      expect(region.startMs).toBeGreaterThanOrEqual(SPAN.startMs);
      expect(region.endMs).toBeLessThanOrEqual(SPAN.endMs);
    }
  });

  it("flags track birth/death inside the span as uncertainty", () => {
    // Track exists only in the middle of the span: both ends are anchors.
    const timestamps: number[] = [];
    for (let tMs = 1200; tMs <= 1800; tMs += FRAME_MS * 3) timestamps.push(tMs);
    const schedule = planTwoPassSchedule(planInput({ primaryTrack: track(timestamps) }));
    expect(schedule.denseRegions.length).toBeGreaterThanOrEqual(1);
    expect(
      schedule.denseRegions.every((region) => region.reasons.includes("track_uncertainty")),
    ).toBe(true);
  });

  it("flags low-confidence observations as uncertainty", () => {
    const timestamps: number[] = [];
    for (let tMs = SPAN.startMs; tMs <= SPAN.endMs; tMs += FRAME_MS * 3) timestamps.push(tMs);
    const confident = track(timestamps, { confidence: 0.9 });
    confident.observations[20]!.confidence = 0.1;
    const schedule = planTwoPassSchedule(planInput({ primaryTrack: confident }));
    const anchorMs = confident.observations[20]!.timestampMs;
    const covering = schedule.denseRegions.find(
      (region) => region.startMs <= anchorMs && region.endMs >= anchorMs,
    );
    expect(covering).toBeDefined();
    expect(covering!.reasons).toContain("track_uncertainty");
  });

  it("flags high paddle-speed change", () => {
    const speeds = [];
    for (let tMs = 0; tMs <= 3000; tMs += 60) {
      speeds.push({ timestampMs: tMs, value: tMs === 1500 ? 50 : 1 + (tMs % 120 === 0 ? 0.1 : 0) });
    }
    const schedule = planTwoPassSchedule(planInput({ paddleSpeeds: speeds }));
    const covering = schedule.denseRegions.find(
      (region) => region.startMs <= 1500 && region.endMs >= 1500,
    );
    expect(covering).toBeDefined();
    expect(covering!.reasons).toContain("paddle_speed_change");
  });

  it("flags coverage holes as missing frames", () => {
    // stride-3 grid with a 600ms hole in the middle.
    const timestamps: number[] = [];
    for (let tMs = SPAN.startMs; tMs <= SPAN.endMs; tMs += FRAME_MS * 3) {
      if (tMs > 1200 && tMs < 1800) continue;
      timestamps.push(tMs);
    }
    const schedule = planTwoPassSchedule(planInput({ primaryTrack: track(timestamps) }));
    const hole = schedule.denseRegions.find(
      (region) => region.startMs <= 1300 && region.endMs >= 1700,
    );
    expect(hole).toBeDefined();
    expect(hole!.reasons).toContain("missing_frames");
  });

  it("merges overlapping regions and unions reasons", () => {
    const schedule = planTwoPassSchedule(
      planInput({
        eventPeaksMs: [1500],
        primaryTrack: track([1400, 1460], { confidence: 0.1 }),
      }),
    );
    expect(schedule.denseRegions).toHaveLength(1);
    const region = schedule.denseRegions[0]!;
    expect(region.reasons).toContain("event_peak");
    expect(region.reasons).toContain("track_uncertainty");
  });

  it("always plans fewer total frames than the full scan when dense regions are partial", () => {
    const schedule = planTwoPassSchedule(planInput({ eventPeaksMs: [1500] }));
    expect(schedule.planned.totalFrames).toBeLessThan(schedule.planned.fullScanFrames);
    expect(schedule.planned.sparseFrames).toBeLessThan(schedule.planned.fullScanFrames);
  });
});

describe("mergePaddleDetectionFiles", () => {
  const schedule = planTwoPassSchedule(planInput({ eventPeaksMs: [1500] }));

  it("prefers the dense copy on grid-slot collisions and sorts by tMs", () => {
    const sparse = detsFile([0, 60, 120, 1500, 2940]);
    const dense = detsFile([1440, 1460, 1480, 1500, 1520], { score: 0.9 });
    const merged = mergePaddleDetectionFiles(sparse, [dense], schedule);
    const tMsList = merged.file.frames.map((frame) => frame.tMs);
    expect(tMsList).toEqual([...tMsList].sort((a, b) => a - b));
    expect(new Set(tMsList).size).toBe(tMsList.length);
    const at1500 = merged.file.frames.find((frame) => frame.tMs === 1500)!;
    expect(at1500.detections[0]!.score).toBe(0.9);
    expect(merged.passes.find((record) => record.tMs === 1500)!.pass).toBe("dense");
  });

  it("accumulates timing across passes", () => {
    const sparse = detsFile([0, 60], { framesProcessed: 2 });
    const dense = detsFile([1500, 1520], { framesProcessed: 2 });
    const merged = mergePaddleDetectionFiles(sparse, [dense], schedule);
    expect(merged.file.timing.framesProcessed).toBe(4);
  });

  it("records every merged frame's pass provenance", () => {
    const sparse = detsFile([0, 60, 120]);
    const dense = detsFile([1500, 1520]);
    const merged = mergePaddleDetectionFiles(sparse, [dense], schedule);
    expect(merged.passes).toHaveLength(merged.file.frames.length);
    expect(merged.passes.filter((record) => record.pass === "dense")).toHaveLength(2);
    expect(merged.passes.filter((record) => record.pass === "sparse")).toHaveLength(3);
  });
});
