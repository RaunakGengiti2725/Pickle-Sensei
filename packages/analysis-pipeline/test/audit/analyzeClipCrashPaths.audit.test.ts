import { beforeAll, describe, expect, it } from "vitest";
import { ok } from "@pickle/shared-types";
import type { VideoClipRef, VisionProviderSet } from "@pickle/vision-contracts";
import { GeometricPhaseSegmenter, PoseGeometryFeatureExtractor } from "@pickle/vision-geometry";
import { createFixtureVisionProviderSet } from "../../../vision-contracts/test/support/fixtureProvider.js";
import { analyzeClip } from "../../src/index.js";

/**
 * EXECUTION AUDIT HARNESS (pkg-analysis-pipeline, pass 2) — analyzeClip.
 * New file only. analyzeCapture documents "a crashing provider is a failure,
 * never silent success" and wraps throws into typed failures. analyzeClip is
 * the legacy live per-clip orchestrator over the same provider contracts;
 * these cases check whether it honours the same crash contract and the
 * empty-stroke path.
 */

const clip: VideoClipRef = {
  uri: "fixture://forehand-demo",
  durationMs: 2400,
  fps: 30,
  width: 720,
  height: 1280,
};

const options = {
  analysisId: "3b9f2b60-1111-4222-8333-444455556666",
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

type Settled =
  | { threw: false; result: Awaited<ReturnType<typeof analyzeClip>> }
  | { threw: true; error: unknown };

async function settle(providers: VisionProviderSet): Promise<Settled> {
  return analyzeClip(providers, clip, options).then(
    (result) => ({ threw: false as const, result }),
    (error: unknown) => ({ threw: true as const, error }),
  );
}

describe("AUDIT analyzeClip — provider crashes must surface as typed failures, not rejections", () => {
  it("pose provider throws → typed failure (no raw rejection escapes the orchestrator)", async () => {
    const base = createFixtureVisionProviderSet("forehand_drive");
    const providers: VisionProviderSet = {
      ...base,
      pose: {
        ...base.pose,
        extractPose: async () => {
          throw new Error("pose bridge died");
        },
      },
    };
    const outcome = await settle(providers);
    expect(outcome.threw).toBe(false);
    if (outcome.threw) return;
    expect(outcome.result.ok).toBe(false);
  });

  it("stroke detector throws → typed failure (no raw rejection escapes the orchestrator)", async () => {
    const base = createFixtureVisionProviderSet("forehand_drive");
    const providers: VisionProviderSet = {
      ...base,
      stroke: {
        ...base.stroke,
        detectStrokes: async () => {
          throw new Error("stroke detector died");
        },
      },
    };
    const outcome = await settle(providers);
    expect(outcome.threw).toBe(false);
    if (outcome.threw) return;
    expect(outcome.result.ok).toBe(false);
  });

  it("phase segmenter throws → typed failure (no raw rejection escapes the orchestrator)", async () => {
    const base = createFixtureVisionProviderSet("forehand_drive");
    const providers: VisionProviderSet = {
      ...base,
      phase: {
        ...base.phase,
        segmentPhases: async () => {
          throw new Error("segmenter died");
        },
      },
    };
    const outcome = await settle(providers);
    expect(outcome.threw).toBe(false);
    if (outcome.threw) return;
    expect(outcome.result.ok).toBe(false);
  });
});

describe("AUDIT analyzeClip — empty / partial provider outputs", () => {
  it("no strokes detected → analysis.no_stroke_detected (low_confidence)", async () => {
    const base = createFixtureVisionProviderSet("forehand_drive");
    const providers: VisionProviderSet = {
      ...base,
      stroke: { ...base.stroke, detectStrokes: async () => ok([]) },
    };
    const result = await analyzeClip(providers, clip, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("analysis.no_stroke_detected");
    expect(result.failure.kind).toBe("low_confidence");
  });

  it("pose provider returns zero frames + REAL geometry segmenter/extractor → typed low_confidence failure", async () => {
    const base = createFixtureVisionProviderSet("forehand_drive");
    const providers: VisionProviderSet = {
      ...base,
      pose: { ...base.pose, extractPose: async () => ok([]) },
      phase: new GeometricPhaseSegmenter({ aspectRatio: 1 }),
      features: new PoseGeometryFeatureExtractor({ aspectRatio: 1 }),
    };
    const outcome = await settle(providers);
    expect(outcome.threw).toBe(false);
    if (outcome.threw) return;
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) return;
    expect(outcome.result.failure.kind).toBe("low_confidence");
    expect(outcome.result.failure.code).toBe("phase.too_few_pose_frames");
  });

  it("INFO: analyzeClip has no empty-pose guard of its own — with pose-agnostic providers zero frames still score", async () => {
    // analyzeCapture rejects an empty pose sequence before any provider runs
    // (fusion.empty_pose_sequence). analyzeClip delegates that check to the
    // phase segmenter. Documented, not asserted as a defect: the shipped
    // geometry segmenter does guard it (previous case).
    const base = createFixtureVisionProviderSet("forehand_drive");
    const providers: VisionProviderSet = {
      ...base,
      pose: { ...base.pose, extractPose: async () => ok([]) },
    };
    const result = await analyzeClip(providers, clip, options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resultKind).toBe("scored");
  });

  it("feature extractor returns zero measurements → abstention (no numeric grade)", async () => {
    const base = createFixtureVisionProviderSet("forehand_drive");
    const providers: VisionProviderSet = {
      ...base,
      features: { ...base.features, extractMeasurements: async () => ok([]) },
    };
    const result = await analyzeClip(providers, clip, options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resultKind).toBe("low_confidence");
    expect(result.value.overallScore).toBeNull();
    expect(result.value.priorityFix).toBeNull();
  });
});
