import { describe, expect, it } from "vitest";
import type { Measurement } from "@pickle/shared-types";
import type { BallObservation, PoseSequence } from "@pickle/swing-domain";
import type { StrokeEvent } from "@pickle/vision-contracts";
import { generateSwing, generateSwingSequence } from "@pickle/evaluation";
import { PoseGeometryFeatureExtractor } from "../../src/featureExtractor.js";
import { GeometricPhaseSegmenter } from "../../src/phaseSegmenter.js";
import { classifyStroke, estimateContact } from "../../src/index.js";

/**
 * ADJUDICATION — pkg-vision-geometry @ 4d812e1a.
 *
 * Independent reproductions of the auditor findings that were CONFIRMED.
 * Every test asserts the SAFE (expected) behaviour, so on the audited
 * revision each one FAILS; a fix is complete when this file is green without
 * any assertion being weakened. Inputs are all finite and structurally valid
 * (they survive `parsePoseSequence`), i.e. reachable from the shipping path.
 */

const TORSO = new Set(["left_shoulder", "right_shoulder", "left_hip", "right_hip"]);

function withTorsoAt(
  sequence: PoseSequence,
  aroundMs: number,
  mutate: (mark: PoseSequence["frames"][number]["landmarks"][number]) => typeof mark,
): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map((frame) =>
      Math.abs(frame.timestampMs - aroundMs) > 40
        ? frame
        : {
            ...frame,
            landmarks: frame.landmarks.map((mark) => (TORSO.has(mark.name) ? mutate(mark) : mark)),
          },
    ),
  };
}

describe("ADJ-VG-01 classifyStroke: visibility-0 torso landmarks must not define the midline", () => {
  const { sequence, window } = generateSwingSequence();
  // Exactly the shipping call shape (apps/mobile/src/vision/providers.ts):
  // no paddle, no speed series, reference = event peak.
  const classify = (seq: PoseSequence) =>
    classifyStroke({
      sequence: seq,
      window: { startMs: window.startMs, endMs: window.endMs },
      contactMs: null,
      eventPeakMs: window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: null,
    });

  it("control: fully measured torso commits FOREHAND", () => {
    expect(classify(sequence).label).toBe("FOREHAND");
  });

  it("visibility-0 torso at the reference frame abstains (same as an absent torso)", () => {
    const unmeasured = withTorsoAt(sequence, window.peakMs, (mark) => ({ ...mark, visibility: 0 }));
    const absent = withTorsoAt(sequence, window.peakMs, (mark) => ({
      ...mark,
      name: `${mark.name}_removed` as typeof mark.name,
    }));
    expect(classify(absent).label).toBe("UNKNOWN"); // precondition: absence abstains
    const prediction = classify(unmeasured);
    expect(prediction.label, JSON.stringify(prediction)).toBe("UNKNOWN");
  });

  it("visibility-0 torso coordinates must not be able to flip the committed side", () => {
    // Same invisible landmarks, but their (unmeasured) x is dragged to the
    // far right so the midline crosses the wrist. A gated classifier is
    // indifferent to invisible coordinates; the baseline flips the label.
    const shifted = withTorsoAt(sequence, window.peakMs, (mark) => ({
      ...mark,
      x: Math.min(0.99, mark.x + 0.45),
      visibility: 0,
    }));
    const prediction = classify(shifted);
    expect(prediction.label, JSON.stringify(prediction)).not.toBe("BACKHAND");
  });
});

describe("ADJ-VG-02 estimateContact: visibility-0 wrists must not supply ball-proximity evidence", () => {
  const { sequence, window } = generateSwingSequence();
  const baseWindow = { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs };
  // A ball that turns far from the player (x≈0.1 while the wrists live at
  // x≈0.55–0.6): with an honest ownership gate this is "away from target".
  const FAR_X = 0.1;
  const ball: BallObservation[] = Array.from({ length: 12 }, (_, index) => {
    const t = window.peakMs - 180 + index * 30;
    const before = t <= window.peakMs;
    return {
      frameIndex: index,
      timestampMs: t,
      x: before
        ? FAR_X - 0.15 + 0.15 * ((t - (window.peakMs - 180)) / 180)
        : FAR_X + ((t - window.peakMs) / 180) * 0.3,
      y: 0.6,
      confidence: 0.8,
    };
  });
  const ghost: PoseSequence = {
    ...sequence,
    frames: sequence.frames.map((frame) =>
      Math.abs(frame.timestampMs - window.peakMs) > 100
        ? frame
        : {
            ...frame,
            landmarks: frame.landmarks.map((mark) =>
              mark.name === "left_wrist" ? { ...mark, x: FAR_X, y: 0.6, visibility: 0 } : mark,
            ),
          },
    ),
  };

  it("control: a far ball turn is not confirmed by a measured wrist", () => {
    const control = estimateContact({ sequence, window: baseWindow, ballObservations: ball });
    expect(control.status).toBe("estimated");
    if (control.status !== "estimated") return;
    expect(control.ballConfirmed).toBe(false);
  });

  it("a visibility-0 wrist placed on the ball turn must not change the verdict", () => {
    const control = estimateContact({ sequence, window: baseWindow, ballObservations: ball });
    const attacked = estimateContact({
      sequence: ghost,
      window: baseWindow,
      ballObservations: ball,
    });
    expect(attacked.status).toBe("estimated");
    if (attacked.status !== "estimated" || control.status !== "estimated") return;
    expect(attacked.ballConfirmed, JSON.stringify(attacked)).toBe(false);
    expect(attacked.supportingEvidence.map((s) => s.signal)).toEqual(
      control.supportingEvidence.map((s) => s.signal),
    );
    expect(attacked.confidence).toBe(control.confidence);
  });
});

async function measureWith(
  frames: ReturnType<typeof generateSwing>["frames"],
  stroke: StrokeEvent,
): Promise<{
  phases: Awaited<ReturnType<GeometricPhaseSegmenter["segmentPhases"]>>;
  byKey: Map<string, Measurement>;
}> {
  const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
  const phases = await segmenter.segmentPhases(frames, [], stroke);
  expect(phases.ok).toBe(true);
  if (!phases.ok) throw new Error("phase segmentation failed");
  const extractor = new PoseGeometryFeatureExtractor({ aspectRatio: 1 });
  const measured = await extractor.extractMeasurements({
    poseFrames: frames,
    paddleFrames: [],
    phases: phases.value,
    shotType: "forehand_drive",
    handedness: "right",
    cameraView: "side",
  });
  expect(measured.ok).toBe(true);
  if (!measured.ok) throw new Error("feature extraction failed");
  return { phases, byKey: new Map(measured.value.map((entry) => [entry.metricKey, entry])) };
}

describe("ADJ-VG-03 featureExtractor: contact_height_ratio needs a MEASURED ground line", () => {
  const swing = generateSwing();
  const stroke: StrokeEvent = {
    startMs: swing.window.startMs,
    endMs: swing.window.endMs,
    contactMs: swing.window.peakMs,
    shotTypeHypothesis: null,
    confidence: 0.9,
  };

  it("control: with ankles measured the ratio is emitted", async () => {
    const { byKey } = await measureWith(swing.frames, stroke);
    expect(byKey.get("contact_height_ratio")).toBeDefined();
  });

  it("with no ankle ever measured (knee-up framing) the ratio is withheld, not computed from the image bottom", async () => {
    const kneeUp = swing.frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.filter((mark) => !mark.name.endsWith("ankle")),
    }));
    const { byKey } = await measureWith(kneeUp, stroke);
    expect(byKey.get("stance_width_ratio")).toBeUndefined(); // ankle-dependent, correctly withheld
    const ratio = byKey.get("contact_height_ratio");
    expect(ratio, JSON.stringify(ratio)).toBeUndefined();
  });
});

describe("ADJ-VG-04 phaseSegmenter/featureExtractor: outer spans echo the requested window, inflating recovery_time_ms", () => {
  const swing = generateSwing();
  const lastFrameMs = swing.frames[swing.frames.length - 1]!.timestampMs;
  // Imported-clip shape (runCaptureAnalysis.ts): window = whole clip, here a
  // 60 s clip whose measured pose frames stop after the ~1.6 s swing.
  const imported: StrokeEvent = {
    startMs: 0,
    endMs: 60_000,
    contactMs: null,
    shotTypeHypothesis: null,
    confidence: 1,
  };

  it("recover.endMs is bounded by the last measured frame", async () => {
    const { phases } = await measureWith(swing.frames, imported);
    if (!phases.ok) return;
    const recover = phases.value.find((span) => span.key === "recover")!;
    expect(recover.endMs, JSON.stringify(recover)).toBeLessThanOrEqual(lastFrameMs);
  });

  it("recovery_time_ms cannot exceed the measured pose coverage", async () => {
    const { byKey } = await measureWith(swing.frames, imported);
    const recovery = byKey.get("recovery_time_ms");
    expect(recovery).toBeDefined();
    expect(recovery!.value, JSON.stringify(recovery)).toBeLessThanOrEqual(lastFrameMs);
  });
});
