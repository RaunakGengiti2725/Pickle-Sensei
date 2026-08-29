import { describe, expect, it } from "vitest";
import { harvestStageSamples, rebaseManifestPath, REPORT_TIMING_STAGES } from "../src/runCase.js";

describe("harvestStageSamples", () => {
  it("always records e2e plus every present report timing", () => {
    const samples = harvestStageSamples(
      {
        poseExtractMs: 6000,
        playerTrackMs: 150,
        poseDerivativesMs: 40,
        paddleDetectMs: 9000,
        ballTrackMs: 90,
        fusionAnalysisMs: 300,
        paddleDetectViaWorker: 1,
      },
      17250,
      "wm-volley-02",
      "warm",
      2,
    );
    expect(samples[0]).toEqual({
      stage: "e2e",
      caseId: "wm-volley-02",
      phase: "warm",
      iteration: 2,
      wallMs: 17250,
    });
    expect(samples.map((sample) => sample.stage)).toEqual([
      "e2e",
      "poseExtract",
      "playerTrack",
      "poseDerivatives",
      "paddleDetect",
      "ballTrack",
      "fusionAnalysis",
    ]);
  });

  it("harvests the two-pass split timings when --two-pass produced them", () => {
    const samples = harvestStageSamples(
      { paddleDetectMs: 9000, paddleDetectSparseMs: 3000, paddleDetectDenseMs: 6000 },
      17250,
      "afn-sasebo-rally2",
      "warm",
      1,
    );
    expect(samples.map((sample) => sample.stage)).toEqual([
      "e2e",
      "paddleDetect",
      "paddleDetectSparse",
      "paddleDetectDense",
    ]);
  });

  it("skips absent stages — absence is never recorded as 0", () => {
    const samples = harvestStageSamples({}, 100, "a", "cold", 1);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.stage).toBe("e2e");
  });

  it("skips non-timing counters like paddleDetectViaWorker", () => {
    const mapped = REPORT_TIMING_STAGES.map((entry) => entry.reportKey);
    expect(mapped).not.toContain("paddleDetectViaWorker");
    expect(mapped).not.toContain("paddleMergeLinks");
  });
});

describe("rebaseManifestPath", () => {
  it("rebases the canonical Mac's absolute paths onto this checkout", () => {
    expect(
      rebaseManifestPath(
        "/Users/someone/Pickle-Sensei/datasets/paddle-bench/videos/x.mp4",
        "/home/ci/repo/datasets/paddle-bench",
      ),
    ).toBe("/home/ci/repo/datasets/paddle-bench/videos/x.mp4");
  });

  it("throws on paths outside datasets/paddle-bench", () => {
    expect(() => rebaseManifestPath("/tmp/elsewhere/x.mp4", "/home/ci/pb")).toThrow(
      /not under datasets\/paddle-bench/,
    );
  });
});
