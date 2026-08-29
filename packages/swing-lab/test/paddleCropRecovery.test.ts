import { describe, expect, it } from "vitest";
import {
  admitCropDetections,
  bridgeTrackedEstimates,
  buildPaddleTracks,
  CROP_RECOVERY_GATES,
  isFpFamily,
  mergeCropDetectionsIntoFile,
  paddleLostFrameTimes,
  planWristCropRects,
  type CropDetectionFrame,
  type RawPaddleDetectionFile,
} from "../src/index.js";
import type { PaddleTrackCandidate, TrackedPaddleObservation } from "../src/paddleTracker.js";

const VIDEO = { path: "test.mp4", width: 1000, height: 1000, fps: 50, durationMs: 4000 };
const FRAME_MS = 1000 / VIDEO.fps;

function detectionFile(frames: RawPaddleDetectionFile["frames"]): RawPaddleDetectionFile {
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
    video: VIDEO,
    window: { startMs: 0, endMs: VIDEO.durationMs },
    timing: {
      modelLoadSec: 0,
      framesProcessed: frames.length,
      inferenceSecTotal: 0,
      inferenceMsPerFrame: 0,
      wallSecTotal: 0,
    },
    frames,
  };
}

function observation(
  timestampMs: number,
  center: { x: number; y: number },
  overrides: Partial<TrackedPaddleObservation> = {},
): TrackedPaddleObservation {
  const box = { x: center.x - 0.03, y: center.y - 0.04, width: 0.06, height: 0.08 };
  return {
    timestampMs,
    box,
    center,
    detectorScore: 0.6,
    trackId: 1,
    confidence: 0.6,
    nearWrist: true,
    ...overrides,
  };
}

/** Wrist series with one wrist at a fixed spot per frame. */
function wristsAt(
  point: { x: number; y: number },
  timestamps: readonly number[],
): Array<{ timestampMs: number; wrists: Array<{ x: number; y: number }> }> {
  return timestamps.map((timestampMs) => ({ timestampMs, wrists: [point] }));
}

describe("crop-candidate gating (detection-source provenance)", () => {
  it("crop detections NEVER seed tracks, even at high score", () => {
    const frames: RawPaddleDetectionFile["frames"] = [];
    for (let index = 0; index < 20; index += 1) {
      frames.push({
        tMs: index * FRAME_MS,
        detections: [
          { box: [400, 400, 460, 480], score: 0.95, label: "tennis racket", source: "crop" },
        ],
        extras: [],
      });
    }
    const file = detectionFile(frames);
    expect(buildPaddleTracks(file, file.window).length).toBe(0);
  });

  it("crop detections EXTEND an existing full-frame track and carry source", () => {
    const frames: RawPaddleDetectionFile["frames"] = [];
    for (let index = 0; index < 20; index += 1) {
      const cx = 400 + index * 2;
      const isCropFrame = index >= 10;
      frames.push({
        tMs: index * FRAME_MS,
        detections: [
          {
            box: [cx - 30, 370, cx + 30, 450],
            score: isCropFrame ? 0.2 : 0.7,
            label: "tennis racket",
            ...(isCropFrame ? { source: "crop" as const } : {}),
          },
        ],
        extras: [],
      });
    }
    const file = detectionFile(frames);
    const tracks = buildPaddleTracks(file, file.window);
    expect(tracks.length).toBe(1);
    expect(tracks[0]!.observations.length).toBe(20);
    const cropObservations = tracks[0]!.observations.filter((entry) => entry.source === "crop");
    expect(cropObservations.length).toBe(10);
    expect(tracks[0]!.observations.filter((entry) => entry.source === undefined).length).toBe(10);
  });
});

describe("crop admission gates", () => {
  const wrist = { x: 0.4, y: 0.4 };
  const wrists = wristsAt(wrist, [0]);
  const near = (score: number): CropDetectionFrame => ({
    tMs: 0,
    detections: [{ box: [370, 370, 430, 450], score, label: "tennis racket", source: "crop" }],
  });

  it("admits a plausible near-wrist crop detection at the 0.08 floor", () => {
    const result = admitCropDetections([near(0.09)], wrists, VIDEO);
    expect(result.admitted.length).toBe(1);
    expect(result.admitted[0]!.detections[0]!.source).toBe("crop");
  });

  it("rejects below the existing 0.08 floor", () => {
    const result = admitCropDetections([near(0.05)], wrists, VIDEO);
    expect(result.admitted.length).toBe(0);
    expect(result.rejectedBelowFloor).toBe(1);
  });

  it("rejects crop boxes far from every conditioning wrist", () => {
    const far: CropDetectionFrame = {
      tMs: 0,
      detections: [
        { box: [800, 800, 860, 880], score: 0.9, label: "tennis racket", source: "crop" },
      ],
    };
    const result = admitCropDetections([far], wrists, VIDEO);
    expect(result.admitted.length).toBe(0);
    expect(result.rejectedFarFromWrist).toBe(1);
  });

  it("suppresses the court-line sliver FP family (extreme aspect ratio)", () => {
    const courtLine: CropDetectionFrame = {
      tMs: 0,
      detections: [
        // 300x20px sliver crossing the wrist neighborhood at the measured
        // ~0.53 conf — stronger than true edge-on recoveries, so the score
        // floor cannot gate it.
        { box: [300, 400, 600, 420], score: 0.53, label: "tennis racket", source: "crop" },
      ],
    };
    const result = admitCropDetections([courtLine], wrists, VIDEO);
    expect(result.admitted.length).toBe(0);
    expect(result.rejectedFpFamily).toBe(1);
  });

  it("suppresses the shorts/leg FP family (box hanging below the wrist)", () => {
    const leg: CropDetectionFrame = {
      tMs: 0,
      detections: [
        // Box top well below the wrist at y=0.4 (thigh region), inside the
        // wrist gate radius, at the measured 0.53 conf.
        { box: [380, 480, 440, 560], score: 0.53, label: "tennis racket", source: "crop" },
      ],
    };
    const result = admitCropDetections([leg], wrists, VIDEO);
    expect(result.admitted.length).toBe(0);
    expect(result.rejectedFpFamily).toBe(1);
  });

  it("isFpFamily keeps a normal in-hand paddle box", () => {
    expect(isFpFamily({ x: 0.37, y: 0.37, width: 0.06, height: 0.08 }, [wrist])).toBe(false);
  });
});

describe("TRACKED_ESTIMATE bridging", () => {
  const at = (frame: number, x: number) => observation(frame * FRAME_MS, { x, y: 0.4 });

  it("bridges a 1-frame hole with flagged interpolated estimates", () => {
    const bridged = bridgeTrackedEstimates([at(0, 0.4), at(2, 0.44)], FRAME_MS);
    expect(bridged.length).toBe(3);
    const estimate = bridged[1]!;
    expect(estimate.source).toBe("tracked_estimate");
    expect(estimate.detectorScore).toBe(0);
    expect(estimate.center.x).toBeCloseTo(0.42, 5);
    expect(estimate.timestampMs).toBe(Math.round(1 * FRAME_MS));
  });

  it("bridges a 2-frame hole", () => {
    const bridged = bridgeTrackedEstimates([at(0, 0.4), at(3, 0.46)], FRAME_MS);
    expect(bridged.length).toBe(4);
    expect(bridged.filter((entry) => entry.source === "tracked_estimate").length).toBe(2);
  });

  it("REFUSES to bridge holes of 3+ frames — the hole stays a hole", () => {
    const bridged = bridgeTrackedEstimates([at(0, 0.4), at(4, 0.48)], FRAME_MS);
    expect(bridged.length).toBe(2);
    expect(bridged.every((entry) => entry.source !== "tracked_estimate")).toBe(true);
  });

  it("never flags measured observations", () => {
    const bridged = bridgeTrackedEstimates([at(0, 0.4), at(1, 0.42), at(2, 0.44)], FRAME_MS);
    expect(bridged.length).toBe(3);
    expect(bridged.every((entry) => entry.source === undefined)).toBe(true);
  });
});

describe("paddle-lost neighborhood + crop planning", () => {
  it("finds only uncovered in-window frames", () => {
    const frameTimes = [0, 20, 40, 60, 80];
    const candidate: PaddleTrackCandidate = {
      trackId: 1,
      observations: [observation(0, { x: 0.4, y: 0.4 }), observation(20, { x: 0.41, y: 0.4 })],
      meanScore: 0.6,
      windowCoverage: 0.5,
      meanWristDistance: 0.05,
    };
    const lost = paddleLostFrameTimes(frameTimes, [candidate], { startMs: 0, endMs: 60 }, 20);
    expect(lost).toEqual([40, 60]);
  });

  it("plans both scales around BOTH wrists (handedness never trusted)", () => {
    const wrists = [
      {
        timestampMs: 40,
        wrists: [
          { x: 0.4, y: 0.4 },
          { x: 0.6, y: 0.5 },
        ],
      },
    ];
    const plan = planWristCropRects([40], wrists, VIDEO);
    expect(plan.length).toBe(1);
    expect(plan[0]!.rects.length).toBe(CROP_RECOVERY_GATES.cropScalesPx.length * 2);
    const sizes = plan[0]!.rects.map((rect) => rect.x1 - rect.x0);
    expect(sizes).toContain(256);
  });

  it("merged crop detections land on their frames tagged as crop", () => {
    const file = detectionFile([
      { tMs: 0, detections: [], extras: [] },
      { tMs: 20, detections: [], extras: [] },
    ]);
    const merged = mergeCropDetectionsIntoFile(file, [
      {
        tMs: 20,
        detections: [
          { box: [370, 370, 430, 450], score: 0.2, label: "tennis racket", source: "crop" },
        ],
      },
    ]);
    expect(merged.frames[1]!.detections.length).toBe(1);
    expect(merged.frames[1]!.detections[0]!.source).toBe("crop");
    expect(file.frames[1]!.detections.length).toBe(0);
  });
});
