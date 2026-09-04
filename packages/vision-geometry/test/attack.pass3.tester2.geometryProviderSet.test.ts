import { describe, expect, it } from "vitest";
import { generateSwing } from "@pickle/evaluation";
import type { Measurement, PhaseSpan, PoseFrame } from "@pickle/shared-types";
import type { VideoClipRef } from "@pickle/vision-contracts";
import { createGeometryProviderSet } from "../src/index.js";

/**
 * ADVERSARIAL PASS 3 / TESTER #2 — S1: createGeometryProviderSet with
 * degenerate clip dimensions ({width:1080,height:0} and {width:0,height:1920}).
 *
 * Attack surface: index.ts computes
 *   aspectRatio = video.height > 0 ? video.width / video.height : 1
 * which guards a zero HEIGHT (falls back to 1) but not a zero WIDTH
 * (aspectRatio 0 → every landmark x is multiplied by 0 in kinematics.landmark).
 *
 * Tests marked `it.fails` are REPRODUCED DEFECTS at the audited revision: the
 * body states the expected safe behaviour; vitest passes the case only while
 * the defect persists. When production is fixed, drop the `.fails` modifier.
 */

const SWING = generateSwing();

function providersFor(video: { width: number; height: number }) {
  return createGeometryProviderSet({
    poseFrames: SWING.frames,
    poseModelVersion: "apple-vision-bodypose-1",
    trigger: {
      modelVersion: "temporal-stroke-heuristic-2",
      startMs: SWING.window.startMs,
      endMs: SWING.window.endMs,
      peakMotionMs: SWING.window.peakMs,
      confidence: 0.88,
    },
    video,
  });
}

async function runGeometry(video: { width: number; height: number }): Promise<{
  phases: PhaseSpan[] | null;
  phaseError: string | null;
  measurements: Measurement[] | null;
  featureError: string | null;
}> {
  const providers = providersFor(video);
  const clip: VideoClipRef = {
    uri: "attack://clip",
    durationMs: SWING.clip.durationMs,
    fps: SWING.clip.fps,
    width: video.width,
    height: video.height,
  };
  const strokes = await providers.stroke.detectStrokes(clip);
  expect(strokes.ok).toBe(true);
  if (!strokes.ok) throw new Error("unreachable");
  const frames: PoseFrame[] = [...SWING.frames];
  const phases = await providers.phase.segmentPhases(frames, [], strokes.value[0]!);
  if (!phases.ok) {
    return {
      phases: null,
      phaseError: phases.failure.code,
      measurements: null,
      featureError: null,
    };
  }
  const measurements = await providers.features.extractMeasurements({
    poseFrames: frames,
    paddleFrames: [],
    phases: phases.value,
    shotType: "forehand_drive",
    handedness: "right",
    cameraView: "side",
  });
  return {
    phases: phases.value,
    phaseError: null,
    measurements: measurements.ok ? measurements.value : null,
    featureError: measurements.ok ? null : measurements.failure.code,
  };
}

function byKey(measurements: Measurement[]): Map<string, number> {
  return new Map(measurements.map((entry) => [entry.metricKey, entry.value]));
}

const REFERENCE = { width: 1080, height: 1080 };

describe("S1 createGeometryProviderSet with degenerate video dimensions", () => {
  it("control: reference dims (1080x1080) produce 6 phases and ≥10 finite measurements", async () => {
    const result = await runGeometry(REFERENCE);
    expect(result.phaseError).toBeNull();
    expect(result.phases!.map((phase) => phase.key)).toEqual([
      "ready",
      "prepare",
      "accelerate",
      "contact",
      "follow_through",
      "recover",
    ]);
    expect(result.measurements!.length).toBeGreaterThanOrEqual(10);
    for (const entry of result.measurements!) expect(Number.isFinite(entry.value)).toBe(true);
  });

  it("{width:1080,height:0}: no NaN/Infinity anywhere in phases or measurements (guard falls back to aspect 1)", async () => {
    const result = await runGeometry({ width: 1080, height: 0 });
    expect(result.phaseError).toBeNull();
    for (const phase of result.phases!) {
      expect(Number.isFinite(phase.startMs)).toBe(true);
      expect(Number.isFinite(phase.endMs)).toBe(true);
      expect(Number.isFinite(phase.representativeMs)).toBe(true);
    }
    expect(result.measurements).not.toBeNull();
    for (const entry of result.measurements!) {
      expect(Number.isFinite(entry.value), entry.metricKey).toBe(true);
      expect(Number.isFinite(entry.confidence), entry.metricKey).toBe(true);
    }
    // The fallback is aspect 1, so a square reference clip is byte-identical.
    const reference = await runGeometry(REFERENCE);
    expect(JSON.stringify(result)).toBe(JSON.stringify(reference));
  });

  it("{width:0,height:1920}: no NaN/Infinity anywhere in phases or measurements", async () => {
    const result = await runGeometry({ width: 0, height: 1920 });
    expect(result.phaseError).toBeNull();
    for (const phase of result.phases!) {
      expect(Number.isFinite(phase.startMs)).toBe(true);
      expect(Number.isFinite(phase.endMs)).toBe(true);
      expect(Number.isFinite(phase.representativeMs)).toBe(true);
    }
    expect(result.measurements).not.toBeNull();
    for (const entry of result.measurements!) {
      expect(Number.isFinite(entry.value), entry.metricKey).toBe(true);
      expect(Number.isFinite(entry.confidence), entry.metricKey).toBe(true);
    }
  });

  it.fails(
    "{width:0,height:1920} (aspectRatio 0) must abstain or match the reference geometry — not emit collapsed 'real' measurements",
    async () => {
      const degenerate = await runGeometry({ width: 0, height: 1920 });
      if (degenerate.phaseError !== null || degenerate.featureError !== null) return; // typed abstention is acceptable
      const reference = byKey((await runGeometry(REFERENCE)).measurements!);
      const collapsed = byKey(degenerate.measurements!);
      // Horizontal-extent metrics cannot legitimately read 0 for a swing whose
      // reference stance is 1.35 shoulder widths and whose knees flex 30°.
      for (const key of ["stance_width_ratio", "knee_flexion_deg", "contact_forward_of_hip_norm"]) {
        expect(collapsed.get(key), key).toBeCloseTo(reference.get(key)!, 1);
      }
    },
  );

  it("observed: aspectRatio 0 collapses every horizontal measurement to 0 / 90° and shifts the contact phase (evidence for the finding above)", async () => {
    const degenerate = await runGeometry({ width: 0, height: 1920 });
    const reference = await runGeometry(REFERENCE);
    const collapsed = byKey(degenerate.measurements!);
    const expected = byKey(reference.measurements!);
    expect(expected.get("stance_width_ratio")).toBeGreaterThan(1);
    expect(collapsed.get("stance_width_ratio")).toBe(0);
    expect(expected.get("knee_flexion_deg")).toBeGreaterThan(20);
    expect(collapsed.get("knee_flexion_deg")).toBe(0);
    expect(collapsed.get("shoulder_turn_deg")).toBe(90);
    expect(collapsed.get("contact_forward_of_hip_norm")).toBe(0);
    expect(collapsed.get("wrist_angle_variance_deg")).toBe(0);
    // Every collapsed measurement is still tagged as a real measurement.
    expect(degenerate.measurements!.every((entry) => entry.source === "real")).toBe(true);
    const contactRef = reference.phases!.find((phase) => phase.key === "contact")!;
    const contactDeg = degenerate.phases!.find((phase) => phase.key === "contact")!;
    expect(Math.abs(contactDeg.startMs - contactRef.startMs)).toBeGreaterThan(30);
  });

  it("{width:0,height:0}: no NaN/Infinity (both guards collapse to aspect 1)", async () => {
    const result = await runGeometry({ width: 0, height: 0 });
    expect(result.phaseError).toBeNull();
    for (const entry of result.measurements!) {
      expect(Number.isFinite(entry.value), entry.metricKey).toBe(true);
    }
  });

  for (const video of [
    { width: Number.NaN, height: 1920 },
    { width: 1080, height: Number.NaN },
    { width: -1080, height: 1920 },
    { width: 1080, height: -1920 },
    { width: Number.POSITIVE_INFINITY, height: 1920 },
    { width: 1080, height: Number.POSITIVE_INFINITY },
  ]) {
    it(`hostile dims ${JSON.stringify(video)}: never a NaN/Infinity measurement or phase bound`, async () => {
      const result = await runGeometry(video);
      for (const phase of result.phases ?? []) {
        expect(Number.isFinite(phase.startMs)).toBe(true);
        expect(Number.isFinite(phase.endMs)).toBe(true);
        expect(Number.isFinite(phase.representativeMs)).toBe(true);
      }
      for (const entry of result.measurements ?? []) {
        expect(Number.isFinite(entry.value), entry.metricKey).toBe(true);
        expect(Number.isFinite(entry.confidence), entry.metricKey).toBe(true);
      }
    });
  }

  it.fails(
    "{width:NaN,height:1920} (aspectRatio NaN) must abstain — not segment a contact phase at the first sample",
    async () => {
      const result = await runGeometry({ width: Number.NaN, height: 1920 });
      if (result.phaseError !== null) return; // typed abstention is acceptable
      const reference = await runGeometry(REFERENCE);
      const contactRef = reference.phases!.find((phase) => phase.key === "contact")!;
      const contact = result.phases!.find((phase) => phase.key === "contact")!;
      expect(Math.abs(contact.representativeMs - contactRef.representativeMs)).toBeLessThanOrEqual(
        60,
      );
    },
  );

  it("observed: aspectRatio NaN yields ok() phases with contact ~1s early and an ok() 2-measurement feature set (evidence for the finding above)", async () => {
    const result = await runGeometry({ width: Number.NaN, height: 1920 });
    expect(result.phaseError).toBeNull();
    expect(result.featureError).toBeNull();
    const contact = result.phases!.find((phase) => phase.key === "contact")!;
    expect(contact.representativeMs).toBeLessThan(100);
    expect(SWING.window.peakMs).toBeGreaterThan(1000);
    expect(result.measurements!.length).toBeLessThanOrEqual(2);
  });

  it("rapid repeats: 50 provider sets over the same degenerate dims are byte-identical (deterministic)", async () => {
    const first = JSON.stringify(await runGeometry({ width: 0, height: 1920 }));
    const results = await Promise.all(
      Array.from({ length: 50 }, () => runGeometry({ width: 0, height: 1920 })),
    );
    for (const result of results) expect(JSON.stringify(result)).toBe(first);
  });
});
