import { beforeAll, describe, expect, it } from "vitest";
import type { VideoClipRef, VisionProviderSet } from "@pickle/vision-contracts";
import { createFixtureVisionProviderSet } from "../../vision-contracts/test/support/fixtureProvider.js";
import { analyzeClip } from "../src/index.js";

/**
 * ADJUDICATION REPRO (area pkg-analysis-pipeline, baseline 4d812e1a).
 * Asserts the EXPECTED Result-typed contract; a failure at the baseline is
 * the reproduction. Fixture providers only (clearly labelled fixtures).
 */

const clip: VideoClipRef = {
  uri: "fixture://forehand-demo",
  durationMs: 2400,
  fps: 30,
  width: 720,
  height: 1280,
};

const options = {
  analysisId: "adj-clip-analysis",
  sessionId: null,
  shotType: "forehand_drive" as const,
  handedness: "right" as const,
  cameraView: "side" as const,
  appVersion: "0.1.0",
  modelBundleVersion: "fixture-1",
  capturedAtIso: "2026-08-26T18:00:00.000Z",
};

beforeAll(() => {
  process.env["PICKLE_ENV"] = "development";
});

describe("ADJ-AP-007 analyzeClip must return a typed failure when a provider rejects", () => {
  it("stroke detector rejection becomes a Result failure, never an escaping rejection", async () => {
    const base = createFixtureVisionProviderSet("forehand_drive");
    const providers: VisionProviderSet = {
      ...base,
      stroke: {
        ...base.stroke,
        detectStrokes: async () => {
          throw new Error("native_stroke_detector_crashed");
        },
      },
    };
    const settled = await analyzeClip(providers, clip, options).then(
      (result) => ({ kind: "returned" as const, result }),
      (error: unknown) => ({ kind: "rejected" as const, error: String(error) }),
    );
    console.log("ADJ-AP-007 analyzeClip settled:", JSON.stringify(settled));
    expect(settled.kind).toBe("returned");
    if (settled.kind !== "returned") return;
    expect(settled.result.ok).toBe(false);
  });
});
