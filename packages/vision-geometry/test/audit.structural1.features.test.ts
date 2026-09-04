import { describe, expect, it } from "vitest";
import { analyzeClip } from "@pickle/analysis-pipeline";
import type { PoseFrame } from "@pickle/shared-types";
import type { VideoClipRef } from "@pickle/vision-contracts";
import { generateSwing } from "@pickle/evaluation";
import { createGeometryProviderSet, GEOMETRY_BUNDLE_VERSION } from "../src/index.js";

/**
 * Structural audit (pass 1) — end-to-end measurement honesty.
 *
 * featureExtractor.ts documents: "Heights use the measured ankle line as
 * ground" and "if a joint is missing the metric is omitted". These tests
 * feed the real pipeline degraded pose data (ankles never measured; a single
 * NaN coordinate; NaN visibility) and require every REPORTED measurement to
 * be finite and to have been measured, never defaulted.
 */

const OPTIONS = {
  analysisId: "audit-features",
  sessionId: null,
  shotType: "forehand_drive" as const,
  handedness: "right" as const,
  cameraView: "side" as const,
  appVersion: "0.1.0",
  modelBundleVersion: GEOMETRY_BUNDLE_VERSION,
  capturedAtIso: "2026-08-27T18:00:00.000Z",
};

async function analyze(mutate: (frames: PoseFrame[]) => PoseFrame[]) {
  const swing = generateSwing();
  const clip: VideoClipRef = {
    uri: swing.clip.uri,
    durationMs: swing.clip.durationMs,
    fps: swing.clip.fps,
    width: 1080,
    height: 1080,
  };
  const providers = createGeometryProviderSet({
    poseFrames: mutate(
      swing.frames.map((frame) => ({ ...frame, landmarks: [...frame.landmarks] })),
    ),
    poseModelVersion: "apple-vision-bodypose-1",
    trigger: {
      modelVersion: "temporal-stroke-heuristic-2",
      startMs: swing.window.startMs,
      endMs: swing.window.endMs,
      peakMotionMs: swing.window.peakMs,
      confidence: 0.88,
    },
    video: { width: 1080, height: 1080 },
  });
  return analyzeClip(providers, clip, OPTIONS);
}

describe("audit: ground line must be measured, not defaulted", () => {
  it("control: full skeleton reports contact_height_ratio", async () => {
    const result = await analyze((frames) => frames);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ratio = result.value.measurements.find((m) => m.metricKey === "contact_height_ratio");
    expect(ratio).toBeDefined();
  });

  it("with no ankle ever measured, contact_height_ratio is omitted or equals the measured value", async () => {
    const control = await analyze((frames) => frames);
    const noAnkles = await analyze((frames) =>
      frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.filter(
          (mark) => mark.name !== "left_ankle" && mark.name !== "right_ankle",
        ),
      })),
    );
    expect(control.ok).toBe(true);
    if (!control.ok) return;
    const truth = control.value.measurements.find((m) => m.metricKey === "contact_height_ratio");
    expect(truth).toBeDefined();
    if (!noAnkles.ok) return; // typed abstention is honest
    const reported = noAnkles.value.measurements.find(
      (m) => m.metricKey === "contact_height_ratio",
    );
    if (reported === undefined) return; // omitted is honest
    // Reported as a "real" measurement → it must be the measured value, not
    // a value computed against a ground line nobody measured.
    // The control reproduces the constructed 0.40 to ~1e-14, so any drift
    // here is the ground line, not numeric noise.
    expect(reported.source).toBe("real");
    expect(Math.abs(reported.value - truth!.value)).toBeLessThanOrEqual(0.02);
  });
});

describe("audit: non-finite landmark data never reaches a reported measurement", () => {
  it("a single NaN wrist x at the contact frame yields finite measurements or a typed failure", async () => {
    const result = await analyze((frames) => {
      const swing = generateSwing();
      const index = frames.findIndex((frame) => frame.timestampMs >= swing.window.peakMs);
      const frame = frames[index]!;
      frame.landmarks = frame.landmarks.map((mark) =>
        mark.name === "right_wrist" ? { ...mark, x: Number.NaN } : mark,
      );
      return frames;
    });
    if (!result.ok) {
      expect(result.failure.kind).toBe("low_confidence");
      return;
    }
    for (const measurement of result.value.measurements) {
      expect(Number.isFinite(measurement.value)).toBe(true);
      expect(Number.isFinite(measurement.confidence)).toBe(true);
    }
    for (const phase of result.value.phases) {
      expect(Number.isFinite(phase.startMs)).toBe(true);
      expect(Number.isFinite(phase.endMs)).toBe(true);
    }
    if (result.value.resultKind === "scored") {
      expect(Number.isFinite(result.value.overallScore)).toBe(true);
    }
  });

  it("NaN visibility on every wrist sample is treated as unmeasured (abstain), not as measured", async () => {
    const result = await analyze((frames) =>
      frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.map((mark) =>
          mark.name === "right_wrist" || mark.name === "left_wrist"
            ? { ...mark, visibility: Number.NaN }
            : mark,
        ),
      })),
    );
    // Wrist confidence is unknown for the entire clip. The honest outcomes
    // are a typed failure or a non-scored result; a confident score whose
    // wrist metrics carry NaN confidence is neither.
    if (result.ok) {
      for (const measurement of result.value.measurements) {
        expect(Number.isFinite(measurement.confidence)).toBe(true);
      }
      expect(result.value.resultKind).not.toBe("scored");
    } else {
      expect(result.failure.kind).toBe("low_confidence");
    }
  });
});
