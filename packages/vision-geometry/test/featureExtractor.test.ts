import { describe, expect, it } from "vitest";
import type { Measurement } from "@pickle/shared-types";
import type { StrokeEvent } from "@pickle/vision-contracts";
import { PoseGeometryFeatureExtractor } from "../src/featureExtractor.js";
import { GeometricPhaseSegmenter } from "../src/phaseSegmenter.js";
import { DEFAULT_TRUTH, generateSwing, mirrorFrames, type SwingTruth } from "@pickle/evaluation";

/**
 * Ground-truth validation: every athlete profile is a parametric skeleton
 * whose true geometry is known by construction, so measured values are
 * asserted against truth with explicit tolerances.
 */

const ATHLETES: Array<{ name: string; truth: Partial<SwingTruth> }> = [
  { name: "baseline right-hander", truth: {} },
  {
    name: "tall wide-stance player",
    truth: {
      torsoLength: 0.26,
      stanceWidthRatio: 1.6,
      kneeFlexionDeg: 22,
      contactForwardNorm: 0.35,
    },
  },
  {
    name: "compact deep-knee player",
    truth: {
      torsoLength: 0.16,
      stanceWidthRatio: 1.1,
      kneeFlexionDeg: 42,
      contactHeightRatio: 0.3,
    },
  },
  {
    name: "left-hander",
    truth: { handed: "left", kneeFlexionDeg: 35, contactForwardNorm: 0.5 },
  },
];

async function measure(truthOverrides: Partial<SwingTruth>): Promise<{
  truth: SwingTruth;
  byKey: Map<string, Measurement>;
}> {
  const truth: SwingTruth = { ...DEFAULT_TRUTH, ...truthOverrides };
  const swing = generateSwing(truthOverrides);
  const stroke: StrokeEvent = {
    startMs: swing.window.startMs,
    endMs: swing.window.endMs,
    contactMs: swing.window.peakMs,
    shotTypeHypothesis: null,
    confidence: 0.9,
  };
  const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
  const phases = await segmenter.segmentPhases(swing.frames, [], stroke);
  expect(phases.ok).toBe(true);
  if (!phases.ok) throw new Error("phase segmentation failed");

  const extractor = new PoseGeometryFeatureExtractor({ aspectRatio: 1 });
  const measured = await extractor.extractMeasurements({
    poseFrames: swing.frames,
    paddleFrames: [],
    phases: phases.value,
    shotType: "forehand_drive",
    handedness: truth.handed,
    cameraView: "side",
  });
  expect(measured.ok).toBe(true);
  if (!measured.ok) throw new Error("feature extraction failed");
  return { truth, byKey: new Map(measured.value.map((entry) => [entry.metricKey, entry])) };
}

describe("PoseGeometryFeatureExtractor ground-truth accuracy", () => {
  for (const athlete of ATHLETES) {
    it(`measures ${athlete.name} within tolerance of constructed truth`, async () => {
      const { truth, byKey } = await measure(athlete.truth);

      const stance = byKey.get("stance_width_ratio");
      expect(stance, "stance_width_ratio missing").toBeDefined();
      expect(stance!.value).toBeCloseTo(truth.stanceWidthRatio, 1);

      const knee = byKey.get("knee_flexion_deg");
      expect(knee, "knee_flexion_deg missing").toBeDefined();
      expect(Math.abs(knee!.value - truth.kneeFlexionDeg)).toBeLessThanOrEqual(2);

      const turn = byKey.get("shoulder_turn_deg");
      expect(turn, "shoulder_turn_deg missing").toBeDefined();
      expect(Math.abs(turn!.value - truth.shoulderTurnDeg)).toBeLessThanOrEqual(4);

      const contactForward = byKey.get("contact_forward_of_hip_norm");
      expect(contactForward, "contact_forward_of_hip_norm missing").toBeDefined();
      expect(Math.abs(contactForward!.value - truth.contactForwardNorm)).toBeLessThanOrEqual(0.06);

      const contactHeight = byKey.get("contact_height_ratio");
      expect(contactHeight, "contact_height_ratio missing").toBeDefined();
      expect(Math.abs(contactHeight!.value - truth.contactHeightRatio)).toBeLessThanOrEqual(0.06);

      const backswing = byKey.get("backswing_length_norm");
      expect(backswing, "backswing_length_norm missing").toBeDefined();
      expect(Math.abs(backswing!.value - truth.backswingLengthNorm)).toBeLessThanOrEqual(0.15);

      // The constructed swing dips then rises into contact: slope must be
      // positive, and recovery time must match the constructed recover phase.
      const slope = byKey.get("path_low_to_high_slope");
      expect(slope, "path_low_to_high_slope missing").toBeDefined();
      expect(slope!.value).toBeGreaterThan(0);

      const recovery = byKey.get("recovery_time_ms");
      expect(recovery, "recovery_time_ms missing").toBeDefined();
      expect(recovery!.value).toBeGreaterThan(0);
      expect(recovery!.value).toBeLessThanOrEqual(truth.recoverMs + truth.followMs);

      // A stationary lower body means near-zero weight transfer — the
      // generator holds hips fixed, so measured transfer must be ~0.
      const transfer = byKey.get("weight_transfer_norm");
      expect(transfer, "weight_transfer_norm missing").toBeDefined();
      expect(Math.abs(transfer!.value)).toBeLessThanOrEqual(0.05);

      // Every reported measurement declares provenance and sane confidence.
      for (const entry of byKey.values()) {
        expect(entry.source).toBe("real");
        expect(entry.confidence).toBeGreaterThan(0);
        expect(entry.confidence).toBeLessThanOrEqual(1);
      }

      // Paddle-proxy metrics carry reduced confidence relative to direct ones.
      const proxy = byKey.get("paddle_ready_height_ratio");
      expect(proxy, "paddle_ready_height_ratio missing").toBeDefined();
      expect(proxy!.confidence).toBeLessThan(stance!.confidence);
    });
  }

  it("produces mirror-consistent measurements for a mirrored left-hander", async () => {
    const right = await measure({ handed: "right" });
    const swing = generateSwing({ handed: "right" });
    const mirrored = mirrorFrames(swing.frames);
    const stroke: StrokeEvent = {
      startMs: swing.window.startMs,
      endMs: swing.window.endMs,
      contactMs: swing.window.peakMs,
      shotTypeHypothesis: null,
      confidence: 0.9,
    };
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const phases = await segmenter.segmentPhases(mirrored, [], stroke);
    expect(phases.ok).toBe(true);
    if (!phases.ok) return;
    const extractor = new PoseGeometryFeatureExtractor({ aspectRatio: 1 });
    const measured = await extractor.extractMeasurements({
      poseFrames: mirrored,
      paddleFrames: [],
      phases: phases.value,
      shotType: "forehand_drive",
      handedness: "left",
      cameraView: "side",
    });
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    const mirroredByKey = new Map(measured.value.map((entry) => [entry.metricKey, entry]));
    for (const [key, entry] of right.byKey) {
      const twin = mirroredByKey.get(key);
      expect(twin, `${key} missing in mirrored run`).toBeDefined();
      expect(Math.abs(twin!.value - entry.value)).toBeLessThanOrEqual(
        Math.max(0.02, Math.abs(entry.value) * 0.02),
      );
    }
  });

  it("is deterministic across repeated runs", async () => {
    const first = await measure({});
    const second = await measure({});
    expect([...second.byKey.entries()]).toEqual([...first.byKey.entries()]);
  });
});

describe("PoseGeometryFeatureExtractor ground line (VG-8)", () => {
  // The ground line is measured from the ankle pair or not at all: a metric
  // whose joints were never measured is OMITTED (module contract), never
  // computed against a defaulted image-bottom ground under source:"real".
  async function measureWithout(names: ReadonlySet<string>) {
    const swing = generateSwing();
    const frames = swing.frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.filter((mark) => !names.has(mark.name)),
    }));
    const stroke: StrokeEvent = {
      startMs: swing.window.startMs,
      endMs: swing.window.endMs,
      contactMs: swing.window.peakMs,
      shotTypeHypothesis: null,
      confidence: 0.9,
    };
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const phases = await segmenter.segmentPhases(frames, [], stroke);
    expect(phases.ok).toBe(true);
    if (!phases.ok) throw new Error("phase segmentation failed");
    const extractor = new PoseGeometryFeatureExtractor({ aspectRatio: 1 });
    return extractor.extractMeasurements({
      poseFrames: frames,
      paddleFrames: [],
      phases: phases.value,
      shotType: "forehand_drive",
      handedness: "right",
      cameraView: "side",
    });
  }

  it("control: with ankles measured, contact_height_ratio reproduces the constructed 0.40", async () => {
    const { byKey } = await measure({});
    const contactHeight = byKey.get("contact_height_ratio");
    expect(contactHeight).toBeDefined();
    expect(Math.abs(contactHeight!.value - DEFAULT_TRUTH.contactHeightRatio)).toBeLessThanOrEqual(
      1e-6,
    );
  });

  it("with ankles never present, contact_height_ratio is omitted and the other metrics survive", async () => {
    const measured = await measureWithout(new Set(["left_ankle", "right_ankle"]));
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    const byKey = new Map(measured.value.map((entry) => [entry.metricKey, entry]));
    expect(byKey.has("contact_height_ratio")).toBe(false);
    // Ankle-free metrics are still measured against truth.
    const contactForward = byKey.get("contact_forward_of_hip_norm");
    expect(contactForward, "contact_forward_of_hip_norm missing").toBeDefined();
    expect(Math.abs(contactForward!.value - DEFAULT_TRUTH.contactForwardNorm)).toBeLessThanOrEqual(
      0.06,
    );
    expect(byKey.get("shoulder_turn_deg"), "shoulder_turn_deg missing").toBeDefined();
    expect(byKey.get("backswing_length_norm"), "backswing_length_norm missing").toBeDefined();
    for (const entry of byKey.values()) {
      expect(entry.source).toBe("real");
      expect(Number.isFinite(entry.value)).toBe(true);
    }
  });

  it("a single measured ankle is not a ground line", async () => {
    const measured = await measureWithout(new Set(["left_ankle"]));
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(measured.value.some((entry) => entry.metricKey === "contact_height_ratio")).toBe(false);
  });
});
