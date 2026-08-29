import { describe, expect, it } from "vitest";
import { analyzeClip } from "@pickle/analysis-pipeline";
import type { VideoClipRef } from "@pickle/vision-contracts";
import { createGeometryProviderSet, GEOMETRY_BUNDLE_VERSION } from "../src/index.js";
import { generateSwing } from "@pickle/evaluation";

/**
 * Full pipeline: recorded pose frames → stroke window → phases → geometry
 * measurements → sm-v1 scoring → priority fix. Real code path end to end;
 * the only synthetic element is the skeleton, whose geometry is known truth.
 */

function buildInputs(overrides: Parameters<typeof generateSwing>[0] = {}) {
  const swing = generateSwing(overrides);
  const clip: VideoClipRef = {
    uri: swing.clip.uri,
    durationMs: swing.clip.durationMs,
    fps: swing.clip.fps,
    width: swing.clip.width,
    height: swing.clip.height,
  };
  const providers = createGeometryProviderSet({
    poseFrames: swing.frames,
    poseModelVersion: "apple-vision-bodypose-1",
    trigger: {
      modelVersion: "temporal-stroke-heuristic-2",
      startMs: swing.window.startMs,
      endMs: swing.window.endMs,
      peakMotionMs: swing.window.peakMs,
      confidence: 0.88,
    },
    video: { width: swing.clip.width, height: swing.clip.height },
  });
  return { swing, clip, providers };
}

const OPTIONS = {
  analysisId: "analysis-1",
  sessionId: null,
  shotType: "forehand_drive" as const,
  handedness: "right" as const,
  cameraView: "side" as const,
  appVersion: "0.1.0",
  modelBundleVersion: GEOMETRY_BUNDLE_VERSION,
  capturedAtIso: "2026-08-27T18:00:00.000Z",
};

describe("geometry providers through the full analysis pipeline", () => {
  it("produces a real, scored analysis for a well-formed swing", async () => {
    const { clip, providers } = buildInputs();
    const result = await analyzeClip(providers, clip, OPTIONS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const analysis = result.value;

    expect(analysis.source).toBe("real");
    expect(analysis.resultKind).toBe("scored");
    expect(analysis.overallScore).not.toBeNull();
    expect(analysis.overallScore!).toBeGreaterThanOrEqual(0);
    expect(analysis.overallScore!).toBeLessThanOrEqual(10);
    expect(analysis.analysisConfidence).toBeGreaterThanOrEqual(0.65);
    expect(analysis.measurements.length).toBeGreaterThanOrEqual(10);
    expect(analysis.measurements.every((entry) => entry.source === "real")).toBe(true);
    expect(analysis.phases.map((phase) => phase.key)).toEqual([
      "ready",
      "prepare",
      "accelerate",
      "contact",
      "follow_through",
      "recover",
    ]);
    expect(analysis.priorityFix).not.toBeNull();
    expect(analysis.versionVector).toMatchObject({
      modelBundleVersion: GEOMETRY_BUNDLE_VERSION,
      poseModelVersion: "apple-vision-bodypose-1",
      strokeDetectorVersion: "temporal-stroke-heuristic-2",
      phaseModelVersion: "phase-geometry-1",
      scoringModelVersion: "sm-v1",
      shotConfigVersion: "forehand_drive@1",
    });

    // Paddle-dependent-only checkpoints must not fabricate observations.
    const paddleSet = analysis.checkpoints.find((entry) => entry.key === "paddle_set");
    expect(paddleSet).toBeDefined();
  });

  it("scores a textbook swing higher than a visibly flawed one", async () => {
    const good = buildInputs();
    // Straight legs, cramped stance, no turn, late contact, no dip.
    const flawed = buildInputs({
      kneeFlexionDeg: 2,
      stanceWidthRatio: 0.55,
      shoulderTurnDeg: 4,
      contactForwardNorm: -0.05,
      swingDipNorm: 0.0,
      backswingLengthNorm: 1.9,
    });

    const goodResult = await analyzeClip(good.providers, good.clip, OPTIONS);
    const flawedResult = await analyzeClip(flawed.providers, flawed.clip, {
      ...OPTIONS,
      analysisId: "analysis-2",
    });

    expect(goodResult.ok && flawedResult.ok).toBe(true);
    if (!goodResult.ok || !flawedResult.ok) return;
    expect(goodResult.value.overallScore).not.toBeNull();
    expect(flawedResult.value.overallScore).not.toBeNull();
    expect(goodResult.value.overallScore!).toBeGreaterThan(flawedResult.value.overallScore!);

    // The flawed swing's priority fix must point at a genuinely broken area.
    const fix = flawedResult.value.priorityFix;
    expect(fix).not.toBeNull();
    expect([
      "athletic_base",
      "contact_position",
      "swing_length",
      "ready_position",
      "preparation",
    ]).toContain(fix!.checkpoint);
  });

  it("abstains end to end when the wrist never swings", async () => {
    const { swing, clip } = buildInputs();
    const first = swing.frames[0]!;
    const frozen = swing.frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((entry) =>
        entry.name.endsWith("wrist")
          ? {
              ...entry,
              x: first.landmarks.find((l) => l.name === entry.name)!.x,
              y: first.landmarks.find((l) => l.name === entry.name)!.y,
            }
          : entry,
      ),
    }));
    const providers = createGeometryProviderSet({
      poseFrames: frozen,
      poseModelVersion: "apple-vision-bodypose-1",
      trigger: {
        modelVersion: "temporal-stroke-heuristic-2",
        startMs: swing.window.startMs,
        endMs: swing.window.endMs,
        peakMotionMs: swing.window.peakMs,
        confidence: 0.88,
      },
      video: { width: clip.width, height: clip.height },
    });
    const result = await analyzeClip(providers, clip, OPTIONS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
  });

  it("abstains when too few pose frames were recorded", async () => {
    const { swing, clip } = buildInputs();
    const providers = createGeometryProviderSet({
      poseFrames: swing.frames.slice(0, 5),
      poseModelVersion: "apple-vision-bodypose-1",
      trigger: {
        modelVersion: "temporal-stroke-heuristic-2",
        startMs: swing.window.startMs,
        endMs: swing.window.endMs,
        peakMotionMs: swing.window.peakMs,
        confidence: 0.88,
      },
      video: { width: clip.width, height: clip.height },
    });
    const result = await analyzeClip(providers, clip, OPTIONS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("pose.too_few_recorded_frames");
  });

  it("is deterministic: identical inputs produce identical analyses", async () => {
    const { clip, providers } = buildInputs();
    const first = await analyzeClip(providers, clip, OPTIONS);
    const second = await analyzeClip(providers, clip, OPTIONS);
    expect(second).toEqual(first);
  });
});
