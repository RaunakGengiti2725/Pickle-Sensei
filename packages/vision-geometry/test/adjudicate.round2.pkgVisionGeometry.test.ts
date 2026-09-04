import { describe, expect, it } from "vitest";
import { analyzeClip } from "@pickle/analysis-pipeline";
import { generateSwing, generateSwingSequence } from "@pickle/evaluation";
import type { PoseFrame } from "@pickle/shared-types";
import type { PoseSequence } from "@pickle/swing-domain";
import type { VideoClipRef } from "@pickle/vision-contracts";
import {
  GEOMETRY_BUNDLE_VERSION,
  classifyStroke,
  createGeometryProviderSet,
} from "../src/index.js";

/**
 * ADJUDICATION round 2 — pkg-vision-geometry at 4d812e1a (VG-7, VG-8).
 *
 * Adjudicator-authored reproductions, converted from "observed defect"
 * assertions into the DESIRED behaviour the acceptance criteria demand:
 *
 * - VG-8: a ground line is measured from ankles or not at all. With ankles
 *   never present, `contact_height_ratio` is omitted (never computed against
 *   a defaulted y=1 ground under source:"real"); the measured control still
 *   reproduces the constructed 0.40.
 * - VG-7: torso landmarks below the visibility floor at the reference frame
 *   cannot define the midline. Moving visibility-0 torso joints from one side
 *   of the wrist to the other must never flip a committed side — both ghost
 *   placements abstain with a torso-unmeasured limiting factor.
 */

const OPTIONS = {
  analysisId: "adjudicate-round2",
  sessionId: null,
  shotType: "forehand_drive" as const,
  handedness: "right" as const,
  cameraView: "side" as const,
  appVersion: "0.1.0",
  modelBundleVersion: GEOMETRY_BUNDLE_VERSION,
  capturedAtIso: "2026-09-04T12:00:00.000Z",
};

async function analyzeSwing(mutate: (frames: PoseFrame[]) => PoseFrame[]) {
  const swing = generateSwing();
  const clip: VideoClipRef = {
    uri: swing.clip.uri,
    durationMs: swing.clip.durationMs,
    fps: swing.clip.fps,
    width: 1080,
    height: 1080,
  };
  const providers = createGeometryProviderSet({
    poseFrames: mutate(swing.frames.map((f) => ({ ...f, landmarks: [...f.landmarks] }))),
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

// ─────────────────────────────────────────────────────────────────────────────
// VG-8 — ground line must be measured from ankles, never defaulted to y=1
// ─────────────────────────────────────────────────────────────────────────────
describe("VG-8 featureExtractor: contact_height_ratio is only reported against a measured ground line", () => {
  it("with ankles never present, contact_height_ratio is omitted (or the analysis fails typed); the measured control still reports 0.40", async () => {
    const control = await analyzeSwing((frames) => frames);
    const noAnkles = await analyzeSwing((frames) =>
      frames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.filter(
          (m) => m.name !== "left_ankle" && m.name !== "right_ankle",
        ),
      })),
    );
    expect(control.ok).toBe(true);
    if (!control.ok) return;
    const truth = control.value.measurements.find((m) => m.metricKey === "contact_height_ratio");
    expect(truth).toBeDefined();
    expect(truth!.source).toBe("real");
    // Synthetic truth contactHeightRatio = 0.4; the measured control reproduces it exactly.
    expect(Math.abs(truth!.value - 0.4)).toBeLessThanOrEqual(1e-6);

    if (noAnkles.ok) {
      const ghost = noAnkles.value.measurements.find((m) => m.metricKey === "contact_height_ratio");
      console.log(
        `[VG-8] contact_height_ratio measured=${truth!.value.toFixed(4)} noAnkles=${ghost ? ghost.value.toFixed(4) : "<omitted>"}`,
      );
      expect(ghost).toBeUndefined();
      // Metrics that do not depend on the ground line are still measured.
      const keys = noAnkles.value.measurements.map((m) => m.metricKey);
      expect(keys).toContain("contact_forward_of_hip_norm");
      expect(keys).toContain("shoulder_turn_deg");
    } else {
      console.log(`[VG-8] noAnkles → typed failure ${JSON.stringify(noAnkles.failure)}`);
      expect(noAnkles.failure.kind).toBe("low_confidence");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VG-7 — classifyStroke: visibility-0 torso landmarks must not define the midline
// ─────────────────────────────────────────────────────────────────────────────
function withUnmeasuredTorsoAt(
  sequence: PoseSequence,
  tMs: number,
  torsoCenterX: number,
): PoseSequence {
  const nearest = sequence.frames.reduce((best, f) =>
    Math.abs(f.timestampMs - tMs) < Math.abs(best.timestampMs - tMs) ? f : best,
  );
  const torso = new Set(["left_shoulder", "right_shoulder", "left_hip", "right_hip"]);
  return {
    ...sequence,
    frames: sequence.frames.map((frame) =>
      frame === nearest
        ? {
            ...frame,
            landmarks: frame.landmarks.map((m) =>
              torso.has(m.name)
                ? {
                    ...m,
                    x: torsoCenterX + (m.name.startsWith("left") ? -0.06 : 0.06),
                    y: m.name.endsWith("hip") ? 0.7 : 0.5,
                    visibility: 0,
                  }
                : m,
            ),
          }
        : frame,
    ),
  };
}

describe("VG-7 classifyStroke: unmeasured (visibility 0) torso at the reference frame abstains", () => {
  const { sequence, window } = generateSwingSequence();
  const args = {
    window: { startMs: window.startMs, endMs: window.endMs },
    contactMs: window.peakMs,
    handedness: "right" as const,
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds: null,
  };

  it("control: measured torso → FOREHAND committed", () => {
    const p = classifyStroke({ sequence, ...args });
    expect(p.label).toBe("FOREHAND");
    expect(p.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("both ghost torso placements (left / right of the wrist) yield UNKNOWN with a torso-unmeasured limiting factor", () => {
    const wristX = sequence.frames
      .reduce((best, f) =>
        Math.abs(f.timestampMs - window.peakMs) < Math.abs(best.timestampMs - window.peakMs)
          ? f
          : best,
      )
      .landmarks.find((m) => m.name === "right_wrist")!.x;
    const left = classifyStroke({
      sequence: withUnmeasuredTorsoAt(sequence, window.peakMs, wristX - 0.25),
      ...args,
    });
    const right = classifyStroke({
      sequence: withUnmeasuredTorsoAt(sequence, window.peakMs, wristX + 0.25),
      ...args,
    });
    console.log(
      `[VG-7] ghost torso left-of-wrist → ${left.label}@${left.confidence}; right-of-wrist → ${right.label}@${right.confidence}`,
    );
    for (const prediction of [left, right]) {
      expect(prediction.label).toBe("UNKNOWN");
      expect(prediction.leaf).toBe("UNKNOWN");
      expect(prediction.limitingFactors.some((factor) => /torso.*unmeasured/.test(factor))).toBe(
        true,
      );
      expect(Number.isFinite(prediction.confidence)).toBe(true);
    }
    expect(left.label).toBe(right.label);
  });
});
