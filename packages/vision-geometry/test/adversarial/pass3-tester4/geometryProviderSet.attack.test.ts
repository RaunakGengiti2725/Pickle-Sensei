import { describe, expect, it } from "vitest";
import { analyzeClip } from "@pickle/analysis-pipeline";
import { generateSwing } from "@pickle/evaluation";
import type { Measurement, PhaseSpan } from "@pickle/shared-types";
import type { VideoClipRef } from "@pickle/vision-contracts";
import { createGeometryProviderSet, GEOMETRY_BUNDLE_VERSION } from "../../../src/index.js";
import { nonFiniteMeasurements } from "./support/attackFixtures.js";

/**
 * ADVERSARIAL PASS 3 / TESTER 4 — S3: createGeometryProviderSet with
 * non-finite clip dimensions ({width:NaN,height:1920}, {width:Infinity,...},
 * and the height-side equivalents). The assigned assertion is that every
 * landmark-derived metric is OMITTED by the non-finite filter rather than a
 * NaN reaching Measurement.value. The suite also follows the degenerate
 * provider set through the real `analyzeClip` orchestration to see what the
 * product would actually persist.
 *
 * `it.fails` = reproduced BROKEN expectation; the `observed:` case that
 * follows pins the actual behaviour as evidence.
 */

const SWING = generateSwing();

const OPTIONS = {
  analysisId: "attack-tester4",
  sessionId: null,
  shotType: "forehand_drive" as const,
  handedness: "right" as const,
  cameraView: "side" as const,
  appVersion: "0.0.0-attack",
  modelBundleVersion: GEOMETRY_BUNDLE_VERSION,
  capturedAtIso: "2026-09-04T00:00:00.000Z",
};

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

function clipFor(video: { width: number; height: number }): VideoClipRef {
  return {
    uri: "attack://tester4",
    durationMs: SWING.clip.durationMs,
    fps: SWING.clip.fps,
    width: video.width,
    height: video.height,
  };
}

async function runStages(video: { width: number; height: number }): Promise<{
  phases: PhaseSpan[] | null;
  phaseFailure: string | null;
  measurements: Measurement[] | null;
  featureFailure: string | null;
}> {
  const providers = providersFor(video);
  const strokes = await providers.stroke.detectStrokes(clipFor(video));
  if (!strokes.ok) throw new Error(`stroke detector failed: ${strokes.failure.code}`);
  const phases = await providers.phase.segmentPhases(SWING.frames, [], strokes.value[0]!);
  if (!phases.ok) {
    return {
      phases: null,
      phaseFailure: phases.failure.code,
      measurements: null,
      featureFailure: null,
    };
  }
  const measurements = await providers.features.extractMeasurements({
    poseFrames: SWING.frames,
    paddleFrames: [],
    phases: phases.value,
    shotType: "forehand_drive",
    handedness: "right",
    cameraView: "side",
  });
  return {
    phases: phases.value,
    phaseFailure: null,
    measurements: measurements.ok ? measurements.value : null,
    featureFailure: measurements.ok ? null : measurements.failure.code,
  };
}

const LANDMARK_DERIVED_X_METRICS = [
  "stance_width_ratio",
  "knee_flexion_deg",
  "shoulder_turn_deg",
  "paddle_set_forward_norm",
  "backswing_length_norm",
  "weight_transfer_norm",
  "path_low_to_high_slope",
  "contact_forward_of_hip_norm",
  "wrist_angle_variance_deg",
  "follow_through_length_norm",
];

/** aspectRatio = width/height is NaN for each of these. */
const NAN_ASPECT_VIDEOS = [
  { width: Number.NaN, height: 1920 },
  { width: Number.POSITIVE_INFINITY, height: 1920 },
  { width: Number.NEGATIVE_INFINITY, height: 1920 },
];

/** `height > 0` is false for NaN, so this one falls back to aspect 1 (see S5). */
const NAN_HEIGHT_VIDEO = { width: 1080, height: Number.NaN };

/** aspectRatio = 1080/Infinity = 0: finite, so the non-finite filter never fires. */
const ZERO_ASPECT_VIDEO = { width: 1080, height: Number.POSITIVE_INFINITY };

describe("S3 createGeometryProviderSet with non-finite clip dimensions", () => {
  it("control: {1080x1920} yields 6 phases and ≥ 10 finite measurements", async () => {
    const run = await runStages({ width: 1080, height: 1920 });
    expect(run.phases?.length).toBe(6);
    expect(run.measurements?.length ?? 0).toBeGreaterThanOrEqual(10);
    expect(nonFiniteMeasurements(run.measurements ?? [])).toEqual([]);
  });

  for (const video of [...NAN_ASPECT_VIDEOS, ZERO_ASPECT_VIDEO, NAN_HEIGHT_VIDEO]) {
    const label = `{width:${String(video.width)},height:${String(video.height)}}`;

    it(`${label}: no NaN/Infinity ever reaches Measurement.value or .confidence`, async () => {
      const run = await runStages(video);
      expect(nonFiniteMeasurements(run.measurements ?? [])).toEqual([]);
    });
  }

  it("{width:1080,height:NaN}: falls back to aspect 1 — byte-identical to a 1080x1080 clip", async () => {
    const nanHeight = await runStages(NAN_HEIGHT_VIDEO);
    const square = await runStages({ width: 1080, height: 1080 });
    expect(JSON.stringify(nanHeight)).toBe(JSON.stringify(square));
  });

  for (const video of NAN_ASPECT_VIDEOS) {
    const label = `{width:${String(video.width)},height:${String(video.height)}}`;
    it(`${label}: every x-dependent landmark-derived metric is omitted by the non-finite filter`, async () => {
      const run = await runStages(video);
      const keys = new Set((run.measurements ?? []).map((entry) => entry.metricKey));
      for (const metric of LANDMARK_DERIVED_X_METRICS) {
        expect(keys.has(metric), `${metric} present under ${label}`).toBe(false);
      }
    });
  }

  it("NaN-aspect videos: phase bounds stay finite", async () => {
    for (const video of NAN_ASPECT_VIDEOS) {
      const run = await runStages(video);
      for (const phase of run.phases ?? []) {
        expect(Number.isFinite(phase.startMs), phase.key).toBe(true);
        expect(Number.isFinite(phase.endMs), phase.key).toBe(true);
        expect(Number.isFinite(phase.representativeMs), phase.key).toBe(true);
        expect(Number.isFinite(phase.confidence), phase.key).toBe(true);
      }
    }
  });

  it.fails(
    "{width:NaN,height:1920} should be rejected (typed failure) or fall back to aspect 1 — not proceed with NaN geometry",
    async () => {
      const run = await runStages({ width: Number.NaN, height: 1920 });
      const reference = await runStages({ width: 1080, height: 1920 });
      const rejected = run.phaseFailure !== null || run.featureFailure !== null;
      const parity = JSON.stringify(run.measurements) === JSON.stringify(reference.measurements);
      expect(rejected || parity).toBe(true);
    },
  );

  it("observed: NaN width → ok() phases with contact at 17ms (reference 1033ms) and an ok() 2-metric feature set {contact_height_ratio, recovery_time_ms=20} marked source:'real' (evidence for the finding above)", async () => {
    const run = await runStages({ width: Number.NaN, height: 1920 });
    const reference = await runStages({ width: 1080, height: 1920 });
    expect(run.phaseFailure).toBeNull();
    expect(run.featureFailure).toBeNull();
    const keys = (run.measurements ?? []).map((entry) => entry.metricKey).sort();
    expect(keys).toEqual(["contact_height_ratio", "recovery_time_ms"]);
    expect(run.measurements!.every((entry) => entry.source === "real")).toBe(true);
    const contact = run.phases!.find((phase) => phase.key === "contact")!;
    const referenceContact = reference.phases!.find((phase) => phase.key === "contact")!;
    expect(referenceContact.representativeMs).toBeGreaterThan(900);
    expect(contact.representativeMs).toBeLessThan(100);
  });

  it.fails(
    "{width:1080,height:Infinity} (aspect 0) must be rejected or fall back to aspect 1 — not produce a SCORED analysis from collapsed-x geometry",
    async () => {
      const result = await analyzeClip(
        providersFor(ZERO_ASPECT_VIDEO),
        clipFor(ZERO_ASPECT_VIDEO),
        OPTIONS,
      );
      const reference = await analyzeClip(
        providersFor({ width: 1080, height: 1920 }),
        clipFor({ width: 1080, height: 1920 }),
        OPTIONS,
      );
      if (!result.ok) {
        expect(result.failure.kind).toBe("low_confidence");
        return;
      }
      expect(result.value.resultKind).not.toBe("scored");
      expect(JSON.stringify(result.value.measurements)).toBe(
        JSON.stringify(reference.ok ? reference.value.measurements : null),
      );
    },
  );

  it("observed: height Infinity → aspect 0 → resultKind 'scored', overallScore 6.9 (reference 8.6), analysisConfidence identical to the reference, with stance_width_ratio=0, knee_flexion_deg=0, shoulder_turn_deg=90, wrist_angle_variance_deg=0 all source:'real' (evidence for the P1 above)", async () => {
    const result = await analyzeClip(
      providersFor(ZERO_ASPECT_VIDEO),
      clipFor(ZERO_ASPECT_VIDEO),
      OPTIONS,
    );
    const reference = await analyzeClip(
      providersFor({ width: 1080, height: 1920 }),
      clipFor({ width: 1080, height: 1920 }),
      OPTIONS,
    );
    expect(result.ok && reference.ok).toBe(true);
    if (!result.ok || !reference.ok) return;
    expect(result.value.resultKind).toBe("scored");
    expect(reference.value.resultKind).toBe("scored");
    expect(result.value.overallScore).not.toBeNull();
    expect(result.value.overallScore!).toBeLessThan(reference.value.overallScore!);
    expect(result.value.analysisConfidence).toBe(reference.value.analysisConfidence);
    const byKey = new Map(result.value.measurements.map((entry) => [entry.metricKey, entry]));
    expect(byKey.get("stance_width_ratio")!.value).toBe(0);
    expect(byKey.get("knee_flexion_deg")!.value).toBe(0);
    expect(byKey.get("shoulder_turn_deg")!.value).toBe(90);
    expect(byKey.get("wrist_angle_variance_deg")!.value).toBe(0);
    expect(byKey.get("contact_forward_of_hip_norm")!.value).toBe(0);
    expect(result.value.measurements.every((entry) => entry.source === "real")).toBe(true);
    // Same collapsed geometry as {width:0,height:1920} (tester #2's S1): both are aspect 0.
    const widthZero = await analyzeClip(
      providersFor({ width: 0, height: 1920 }),
      clipFor({ width: 0, height: 1920 }),
      OPTIONS,
    );
    expect(widthZero.ok).toBe(true);
    if (!widthZero.ok) return;
    expect(JSON.stringify(widthZero.value.measurements)).toBe(
      JSON.stringify(result.value.measurements),
    );
  });

  it.fails(
    "end to end: analyzeClip over {width:NaN,height:1920} must not persist a scored/low_confidence ShotAnalysis built from NaN geometry",
    async () => {
      const video = { width: Number.NaN, height: 1920 };
      const result = await analyzeClip(providersFor(video), clipFor(video), OPTIONS);
      expect(result.ok).toBe(false);
    },
  );

  it("observed: analyzeClip over NaN width returns ok() with resultKind low_confidence (abstention) — phases and 2 measurements are persisted, analysisConfidence 0.19 (evidence for the finding above)", async () => {
    const video = { width: Number.NaN, height: 1920 };
    const result = await analyzeClip(providersFor(video), clipFor(video), OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resultKind).toBe("low_confidence");
    expect(result.value.measurements.length).toBe(2);
    expect(result.value.analysisConfidence).toBeLessThan(0.2);
    expect(nonFiniteMeasurements(result.value.measurements)).toEqual([]);
    expect(Number.isFinite(result.value.analysisConfidence)).toBe(true);
    expect(result.value.overallScore).toBeNull();
  });

  it("end to end: analyzeClip over every NaN-aspect video (±Infinity width, NaN height) never yields resultKind 'scored'", async () => {
    for (const video of NAN_ASPECT_VIDEOS) {
      const result = await analyzeClip(providersFor(video), clipFor(video), OPTIONS);
      if (!result.ok) {
        expect(result.failure.kind).toBe("low_confidence");
        continue;
      }
      expect(result.value.resultKind, JSON.stringify(video)).not.toBe("scored");
      expect(nonFiniteMeasurements(result.value.measurements)).toEqual([]);
    }
  });

  it("rapid interleaved repeats: 40 concurrent NaN-width runs are byte-identical (deterministic, no shared mutable state)", async () => {
    const video = { width: Number.NaN, height: 1920 };
    const runs = await Promise.all(
      Array.from({ length: 40 }, () =>
        analyzeClip(providersFor(video), clipFor(video), OPTIONS).then((result) =>
          JSON.stringify(result),
        ),
      ),
    );
    expect(new Set(runs).size).toBe(1);
  });

  it("the same provider set is reusable: a second analyzeClip call on one NaN-width set equals the first", async () => {
    const video = { width: Number.NaN, height: 1920 };
    const providers = providersFor(video);
    const first = JSON.stringify(await analyzeClip(providers, clipFor(video), OPTIONS));
    const second = JSON.stringify(await analyzeClip(providers, clipFor(video), OPTIONS));
    expect(second).toBe(first);
  });
});
