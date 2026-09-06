import { describe, expect, it } from "vitest";
import { sha256Hex, type Motion3DArtifact, type Motion3DJoint } from "@pickle/swing-domain";
import {
  buildMotion3DAnalysis,
  isVerifiedMotion3DAnalysis,
  motion3DAngle,
  parseMotion3DAnalysis,
  summarizeMotion3D,
} from "../src/motion3dAnalysis.js";

function softwareFixture(): Motion3DArtifact {
  const joint = (name: Motion3DJoint["name"], x: number, y: number, z: number): Motion3DJoint => ({
    name,
    x,
    y,
    z,
    imageX: 0.5,
    imageY: 0.5,
    confidence: null,
    visibility2D: 0.8,
  });
  return {
    schemaVersion: 1,
    format: "pickle.motion-3d.v1",
    role: "reconstructed_estimate",
    coordinateSystem: "vision_root_relative",
    axes: "right_handed_y_up",
    units: "vision_estimated_meters",
    imageCoordinates: "normalized_image_top_left",
    uncertainty: "uncalibrated",
    temporalProcessing: "none",
    source: {
      captureId: "software-fixture",
      videoSha256: "a".repeat(64),
      videoByteLength: 1234,
      width: 1080,
      height: 1920,
      durationMs: 1000,
      nominalFrameRate: 30,
      preferredTransform: [1, 0, 0, 1, 0, 0],
      orientationPolicy: "preferred_track_transform_applied",
      mirroring: "as_encoded",
    },
    estimator: {
      providerId: "pose.apple-vision-3d",
      revision: 1,
      osVersion: "software-test-only",
      modelAsset: "os_managed",
      modelAssetSha256: null,
      configurationVersion: "apple-vision-3d-raw-1",
      maxSampleRate: 30,
    },
    frames: [0, 1].map((i) => ({
      frameIndex: i,
      timestampMs: (i * 1000) / 30,
      ptsValue: i,
      ptsTimescale: 30,
      segmentId: 0,
      status: "estimated",
      observationConfidence: 1,
      height: { source: "reference", meters: 1.8 },
      cameraOriginMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3, 1],
      joints: [
        joint("root", 0, 0, 0),
        joint("left_shoulder", 0, 1, 0),
        joint("left_elbow", 0, 0, 0),
        joint("left_wrist", 0, 0, 1),
      ],
    })),
  };
}

function input(artifact = softwareFixture()) {
  const artifactJson = JSON.stringify(artifact);
  return {
    id: "analysis-software-fixture",
    captureId: "software-fixture",
    createdAtIso: "2026-09-05T12:00:00.000Z",
    capturedAtIso: "2026-09-05T11:00:00.000Z",
    declaredStroke: null,
    handedness: "left" as const,
    artifactJson,
    artifactSha256: sha256Hex(artifactJson),
  };
}

describe("3D estimated geometry, not coaching or accuracy validation", () => {
  it("calculates an interior angle using depth, not the 2D projection", () => {
    expect(motion3DAngle(softwareFixture().frames[0]!, "left_elbow")).toBeCloseTo(90, 10);
  });

  it("does not invent measurements for missing joints or zero-length limbs", () => {
    const frame = softwareFixture().frames[0]!;
    expect(motion3DAngle(frame, "right_elbow")).toBeNull();
    frame.joints.find((joint) => joint.name === "left_wrist")!.z = 0;
    expect(motion3DAngle(frame, "left_elbow")).toBeNull();
  });

  it("preserves estimated angles under rigid transforms and uniform scale", () => {
    const frame = softwareFixture().frames[0]!;
    const transformed = {
      ...frame,
      joints: frame.joints.map((p) => ({ ...p, x: 2 * p.z + 3, y: 2 * p.y - 4, z: -2 * p.x + 5 })),
    };
    expect(motion3DAngle(transformed, "left_elbow")).toBeCloseTo(
      motion3DAngle(frame, "left_elbow")!,
      10,
    );
  });

  it("reports supported samples and scale provenance, not a confidence percentage", () => {
    const summary = summarizeMotion3D(softwareFixture());
    expect(summary).toMatchObject({
      sampleCount: 2,
      estimatedFrameCount: 2,
      referenceScaleUsed: true,
      continuitySegments: 1,
    });
    expect(summary.angleRanges).toEqual([
      { joint: "left_elbow", minDegrees: 90, maxDegrees: 90, sampleCount: 2 },
    ]);
    expect(summary).not.toHaveProperty("accuracy");
    expect(summary).not.toHaveProperty("score");
  });

  it("keeps gaps and ambiguous athletes out of the estimate denominator", () => {
    const artifact = softwareFixture();
    artifact.frames[1] = {
      ...artifact.frames[1]!,
      status: "multiple_people",
      joints: [],
      height: null,
      observationConfidence: null,
      cameraOriginMatrix: null,
    };
    expect(summarizeMotion3D(artifact)).toMatchObject({
      sampleCount: 2,
      estimatedFrameCount: 1,
      multiplePersonFrameCount: 1,
    });
  });

  it("creates one unscored, uncoached development analysis from verified bytes", () => {
    const result = buildMotion3DAnalysis(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.record.capabilities).toEqual({
      visualization: "development_only",
      comparison: "blocked",
      coaching: "blocked",
      correction: "blocked",
      scoring: "blocked",
    });
    expect(result.value.record).not.toHaveProperty("overallScore");
    expect(result.value.record).not.toHaveProperty("priorityFix");
    expect(result.value.record).not.toHaveProperty("reference");
    expect(result.value.record).not.toHaveProperty("modelledCorrection");
  });

  it("brands only deeply immutable verified objects for safe persistence reuse", () => {
    const result = buildMotion3DAnalysis(input());
    if (!result.ok) throw new Error(result.failure.message);
    expect(isVerifiedMotion3DAnalysis(result.value)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.record.capabilities)).toBe(true);
    expect(Object.isFrozen(result.value.artifact.frames[0]!.joints[0])).toBe(true);
    expect(isVerifiedMotion3DAnalysis(JSON.parse(JSON.stringify(result.value)))).toBe(false);
  });

  it("retains historical display rounding instead of discarding verified motion", () => {
    const artifact = softwareFixture();
    for (const frame of artifact.frames) {
      const wrist = frame.joints.find((joint) => joint.name === "left_wrist")!;
      wrist.x = Math.sin((89.95 * Math.PI) / 180);
      wrist.y = Math.cos((89.95 * Math.PI) / 180);
      wrist.z = 0;
    }
    const result = buildMotion3DAnalysis(input(artifact));
    if (!result.ok) throw new Error(result.failure.message);
    const stored = JSON.parse(JSON.stringify(result.value.record));
    const alternate = stored.summary.angleRanges[0].minDegrees === 90 ? 89.9 : 90;
    stored.summary.angleRanges[0].minDegrees = alternate;
    stored.summary.angleRanges[0].maxDegrees = alternate;
    const restored = parseMotion3DAnalysis(JSON.stringify(stored), result.value.artifactJson);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.value.record.summary).toEqual(stored.summary);
    stored.summary.angleRanges[0].minDegrees -= 1;
    expect(parseMotion3DAnalysis(JSON.stringify(stored), result.value.artifactJson).ok).toBe(false);
  });

  it("is deterministic for identical bytes and run metadata", () => {
    expect(buildMotion3DAnalysis(input())).toEqual(buildMotion3DAnalysis(input()));
  });

  it("requires matching capture identity and an exact artifact digest", () => {
    expect(buildMotion3DAnalysis({ ...input(), captureId: "different-capture" }).ok).toBe(false);
    expect(buildMotion3DAnalysis({ ...input(), artifactSha256: "b".repeat(64) }).ok).toBe(false);
  });

  it("round-trips a historical record without consulting today's rollout flag", () => {
    const result = buildMotion3DAnalysis(input());
    if (!result.ok) throw new Error(result.failure.message);
    expect(
      parseMotion3DAnalysis(JSON.stringify(result.value.record), result.value.artifactJson),
    ).toEqual(result);
  });

  it("refuses unknown versions, altered summaries, approved capabilities, and scores on historical reads", () => {
    const result = buildMotion3DAnalysis(input());
    if (!result.ok) throw new Error(result.failure.message);
    for (const change of [
      { schemaVersion: 2 },
      { purpose: "production" },
      { geometryVersion: "future" },
      { overallScore: 9.7 },
      { summary: { ...result.value.record.summary, estimatedFrameCount: 200 } },
      { capabilities: { ...result.value.record.capabilities, coaching: "approved" } },
      { sourceVideoSha256: "b".repeat(64) },
    ]) {
      expect(
        parseMotion3DAnalysis(
          JSON.stringify({ ...result.value.record, ...change }),
          result.value.artifactJson,
        ).ok,
      ).toBe(false);
    }
  });
});
