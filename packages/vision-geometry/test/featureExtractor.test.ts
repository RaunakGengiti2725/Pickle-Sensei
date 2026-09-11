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

async function phaseFixture() {
  const swing = generateSwing();
  const phases = await new GeometricPhaseSegmenter({ aspectRatio: 1 }).segmentPhases(
    swing.frames,
    [],
    {
      startMs: swing.window.startMs,
      endMs: swing.window.endMs,
      contactMs: swing.window.peakMs,
      shotTypeHypothesis: null,
      confidence: 0.9,
    },
  );
  expect(phases.ok).toBe(true);
  if (!phases.ok) throw new Error("phase fixture unavailable");
  return {
    poseFrames: swing.frames,
    paddleFrames: [],
    phases: phases.value,
    shotType: "forehand_drive" as const,
    handedness: "right" as const,
    cameraView: "side" as const,
  };
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
      // positive; a generated phase endpoint is not observed return-to-ready evidence.
      const slope = byKey.get("path_low_to_high_slope");
      expect(slope, "path_low_to_high_slope missing").toBeDefined();
      expect(slope!.value).toBeGreaterThan(0);

      expect(byKey.get("recovery_time_ms")).toBeUndefined();

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

  it("does not turn a supplied recovery span into an observed return-to-ready measurement", async () => {
    const input = await phaseFixture();
    const startMs = input.phases.at(-1)!.endMs;
    const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements({
      ...input,
      phases: [
        ...input.phases,
        {
          key: "recover",
          startMs,
          endMs: startMs + 1000,
          representativeMs: startMs + 500,
          confidence: 1,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.some((measurement) => measurement.metricKey === "recovery_time_ms")).toBe(
        false,
      );
  });

  it.each(["ready", "prepare", "follow_through", "recover"] as const)(
    "keeps independent measurements when %s was not observed",
    async (missing) => {
      const input = await phaseFixture();
      const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements(
        {
          ...input,
          phases: input.phases.filter((phase) => phase.key !== missing),
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const keys = result.value.map((measurement) => measurement.metricKey);
      expect(keys).toContain("contact_height_ratio");
      expect(keys).not.toContain("recovery_time_ms");
      const omitted =
        missing === "ready"
          ? ["stance_width_ratio", "knee_flexion_deg", "paddle_ready_height_ratio"]
          : missing === "prepare"
            ? [
                "shoulder_turn_deg",
                "paddle_set_height_ratio",
                "paddle_set_forward_norm",
                "backswing_length_norm",
              ]
            : missing === "follow_through"
              ? ["follow_through_length_norm", "wrist_angle_variance_deg"]
              : [];
      for (const key of omitted) expect(keys).not.toContain(key);
    },
  );

  it("does not borrow a ready pose from outside the supplied observed phase", async () => {
    const input = await phaseFixture();
    const ready = input.phases.find((phase) => phase.key === "ready")!;
    const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements({
      ...input,
      poseFrames: input.poseFrames.filter((frame) => frame.timestampMs > ready.endMs),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.some((measurement) => measurement.metricKey === "contact_height_ratio"),
    ).toBe(true);
    expect(result.value.some((measurement) => measurement.metricKey === "stance_width_ratio")).toBe(
      false,
    );
  });

  it("does not substitute a different frame for an unobserved contact-proxy timestamp", async () => {
    const input = await phaseFixture();
    const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements({
      ...input,
      phases: input.phases.map((phase) =>
        phase.key === "contact"
          ? { ...phase, representativeMs: phase.representativeMs + 0.1 }
          : phase,
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = result.value.map((measurement) => measurement.metricKey);
    expect(keys).toContain("stance_width_ratio");
    expect(keys).not.toContain("contact_height_ratio");
    expect(keys).not.toContain("contact_forward_of_hip_norm");
  });

  it("omits ground-relative height when no ankle ground reference was observed", async () => {
    const input = await phaseFixture();
    const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements({
      ...input,
      poseFrames: input.poseFrames.map((frame) => ({
        ...frame,
        landmarks: frame.landmarks.filter((point) => !point.name.endsWith("ankle")),
      })),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.some((measurement) => measurement.metricKey === "contact_forward_of_hip_norm"),
    ).toBe(true);
    expect(
      result.value.some((measurement) => measurement.metricKey === "contact_height_ratio"),
    ).toBe(false);
  });

  it("does not invent horizontal forward direction from poses outside acceleration", async () => {
    const input = await phaseFixture();
    const accelerate = input.phases.find((phase) => phase.key === "accelerate")!;
    const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements({
      ...input,
      poseFrames: input.poseFrames.filter(
        (frame) => frame.timestampMs < accelerate.startMs || frame.timestampMs > accelerate.endMs,
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = result.value.map((measurement) => measurement.metricKey);
    expect(keys).toContain("contact_height_ratio");
    expect(keys).not.toContain("contact_forward_of_hip_norm");
    expect(keys).not.toContain("paddle_set_forward_norm");
    expect(keys).not.toContain("weight_transfer_norm");
  });

  it("keeps body normalization independent of padding outside the selected phases", async () => {
    const input = await phaseFixture();
    const extractor = new PoseGeometryFeatureExtractor({ aspectRatio: 1 });
    const expected = await extractor.extractMeasurements(input);
    const lastTimestamp = input.poseFrames.at(-1)!.timestampMs;
    const padding = input.poseFrames.flatMap((frame, index) =>
      [0, 1].map((copy) => ({
        ...frame,
        timestampMs: lastTimestamp + 1000 + index * 40 + copy * 20,
        landmarks: frame.landmarks.map((landmark) => ({ ...landmark, y: landmark.y * 0.5 })),
      })),
    );
    const actual = await extractor.extractMeasurements({
      ...input,
      poseFrames: [...input.poseFrames, ...padding],
    });
    expect(actual).toEqual(expected);
  });

  it("is deterministic across repeated runs", async () => {
    const first = await measure({});
    const second = await measure({});
    expect([...second.byKey.entries()]).toEqual([...first.byKey.entries()]);
  });

  describe("degrades instead of refusing (features-geometry-3)", () => {
    it("still measures a read whose segmenter emitted no accelerate span", async () => {
      // Regression: a live swing ended in "Acceleration and contact-proxy
      // observations are required" — the whole read was refused because one
      // phase was absent. The neighbouring phase stands in at reduced
      // confidence and every independent metric is still reported.
      const input = await phaseFixture();
      const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements(
        {
          ...input,
          phases: input.phases.filter((phase) => phase.key !== "accelerate"),
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const keys = result.value.map((measurement) => measurement.metricKey);
      expect(keys).toContain("stance_width_ratio");
      expect(keys).toContain("contact_height_ratio");
      expect(keys).toContain("follow_through_length_norm");
      expect(result.value.length).toBeGreaterThanOrEqual(8);
    });

    it("still measures a read whose segmenter emitted neither accelerate nor contact", async () => {
      const input = await phaseFixture();
      const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements(
        {
          ...input,
          phases: input.phases.filter(
            (phase) => phase.key !== "accelerate" && phase.key !== "contact",
          ),
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const keys = result.value.map((measurement) => measurement.metricKey);
      expect(keys).toContain("stance_width_ratio");
      expect(keys).toContain("knee_flexion_deg");
      expect(keys).toContain("shoulder_turn_deg");
      expect(keys).toContain("backswing_length_norm");
    });

    it("refuses only when no phase at all was observed", async () => {
      const input = await phaseFixture();
      const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements(
        { ...input, phases: [] },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("features.missing_phase");
    });

    it("normalizes by the torso measured elsewhere in the recording when the stroke window hides it", async () => {
      const input = await phaseFixture();
      const spanStart = Math.min(...input.phases.map((phase) => phase.startMs));
      const spanEnd = Math.max(...input.phases.map((phase) => phase.endMs));
      const shouldersHidden = input.poseFrames.map((frame) =>
        frame.timestampMs >= spanStart && frame.timestampMs <= spanEnd
          ? {
              ...frame,
              landmarks: frame.landmarks.filter((point) => !point.name.endsWith("shoulder")),
            }
          : frame,
      );
      // The stroke window itself never shows a torso: only frames before the
      // ready phase do. Body-relative metrics that need no shoulder are
      // still reported, normalized by that measured torso.
      const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements(
        { ...input, poseFrames: shouldersHidden },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const keys = result.value.map((measurement) => measurement.metricKey);
      expect(keys).toContain("knee_flexion_deg");
      expect(keys).toContain("paddle_ready_height_ratio");
      expect(keys).toContain("backswing_length_norm");
      expect(keys).toContain("contact_forward_of_hip_norm");
      expect(keys).not.toContain("shoulder_turn_deg");
      expect(keys).not.toContain("contact_height_ratio");
    });

    it("refuses only when the torso was never measured anywhere", async () => {
      const input = await phaseFixture();
      const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements(
        {
          ...input,
          poseFrames: input.poseFrames.map((frame) => ({
            ...frame,
            landmarks: frame.landmarks.filter((point) => !point.name.endsWith("hip")),
          })),
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("features.torso_not_measured");
    });

    it("reads the forward direction from the first and last visible wrist of the run-up when the boundary frames hide it", async () => {
      const input = await phaseFixture();
      const accelerate = input.phases.find((phase) => phase.key === "accelerate")!;
      const contact = input.phases.find((phase) => phase.key === "contact")!;
      const boundaryHidden = input.poseFrames.map((frame) =>
        frame.timestampMs === accelerate.startMs || frame.timestampMs === contact.representativeMs
          ? {
              ...frame,
              landmarks: frame.landmarks.filter((point) => !point.name.endsWith("wrist")),
            }
          : frame,
      );
      const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements(
        { ...input, poseFrames: boundaryHidden },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const keys = result.value.map((measurement) => measurement.metricKey);
      // Metrics measured AT the hidden frames stay unobserved (no wrist
      // there); the direction-dependent weight transfer, which needs only
      // the hips at those frames plus a forward direction, is still measured
      // from the visible run-up wrists.
      expect(keys).toContain("weight_transfer_norm");
      expect(keys).not.toContain("contact_forward_of_hip_norm");
      expect(keys).not.toContain("paddle_set_forward_norm");
    });
  });
});
