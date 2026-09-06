import { describe, expect, it } from "vitest";
import { parseMotion3D, type Motion3DArtifactV2 } from "../src/motion3d.js";

function softwareFixture(): Motion3DArtifactV2 {
  return {
    schemaVersion: 2,
    format: "pickle.motion-3d.v2",
    role: "reconstructed_estimate",
    coordinateSystem: "vision_root_relative",
    axes: "right_handed_y_up",
    units: "vision_estimated_meters",
    imageCoordinates: "normalized_image_top_left",
    uncertainty: "uncalibrated",
    temporalProcessing: "none",
    source: {
      captureId: "software-associated-fixture", videoSha256: "a".repeat(64), videoByteLength: 1000,
      width: 1080, height: 1920, durationMs: 1000, nominalFrameRate: 30,
      preferredTransform: [1, 0, 0, 1, 0, 0], orientationPolicy: "preferred_track_transform_applied", mirroring: "as_encoded",
    },
    estimator: {
      providerId: "pose.apple-vision-3d", revision: 1, osVersion: "software-test-only", modelAsset: "os_managed",
      modelAssetSha256: null, configurationVersion: "apple-vision-3d-associated-2", maxSampleRate: 30,
    },
    identityPolicy: {
      version: "motion-target-association-1", selection: "automatic_prominence", seed: null,
      crossRecordIdentity: "unverified", residualUnit: "torso_spans", parameters: { matchRadius: 0.12, projectionLimit: 0.3 },
    },
    frames: [0, 1].map(i => ({
      frameIndex: i, timestampMs: i * 1000 / 30, ptsValue: i, ptsTimescale: 30, segmentId: 0,
      status: "estimated", observationConfidence: 1, height: { meters: 1.8, source: "reference" },
      cameraOriginMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1],
      joints: [{ name: "root", x: 0, y: 0, z: 0, imageX: 0.5, imageY: 0.5, confidence: null, visibility2D: null }],
      association: { status: "matched", trackId: 1, candidateCount: 2, selectedCandidate: 0, commonJoints: 8,
        reprojectionError: 0.05, runnerUpError: 1, continuity: i === 0 ? "initial" : "continuous" },
    })),
  };
}

const parse = (value: unknown) => parseMotion3D(JSON.stringify(value));

describe("versioned 3D association contract, software fixtures only", () => {
  it("retains source bytes metadata, exact times, and uncalibrated association diagnostics", () => {
    const fixture = softwareFixture();
    const result = parse(fixture);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(fixture);
  });

  it.each(["ambiguous", "wrong_player", "target_lost", "insufficient_support", "not_selected"] as const)(
    "never admits %s estimates into the accepted motion channel", status => {
      const fixture = softwareFixture();
      fixture.frames[0]!.association.status = status;
      expect(parse(fixture).ok).toBe(false);
    },
  );

  it("preserves rejected intervals without geometry and requires a continuity break", () => {
    const fixture = softwareFixture();
    fixture.frames[0] = { ...fixture.frames[0]!, status: "multiple_people", joints: [], height: null, cameraOriginMatrix: null, observationConfidence: null,
      association: { status: "ambiguous", trackId: null, candidateCount: 2, selectedCandidate: null, commonJoints: 0, reprojectionError: null, runnerUpError: null, continuity: "broken" } };
    fixture.frames[1]!.segmentId = 1;
    expect(parse(fixture).ok).toBe(true);
  });

  it("rejects ties, missing projection support and unrelated target switches", () => {
    const tie = softwareFixture();
    tie.frames[0]!.association.runnerUpError = 0.05;
    expect(parse(tie).ok).toBe(false);
    const support = softwareFixture();
    support.frames[0]!.association.commonJoints = 0;
    expect(parse(support).ok).toBe(false);
    const switched = softwareFixture();
    switched.frames[1]!.association.trackId = 2;
    expect(parse(switched).ok).toBe(false);
  });

  it("does not promote capture tracking into verified cross-record athlete identity", () => {
    const fixture = softwareFixture();
    const raw = JSON.parse(JSON.stringify(fixture));
    raw.identityPolicy.crossRecordIdentity = "verified";
    expect(parse(raw).ok).toBe(false);
    raw.identityPolicy.crossRecordIdentity = "unverified";
    raw.frames[0].association.confidence = 0.99;
    expect(parse(raw).ok).toBe(false);
  });

  it("rejects missing, malformed, or relabelled identity contracts", () => {
    for (const mutate of [
      (raw: Record<string, any>) => { delete raw.identityPolicy; },
      (raw: Record<string, any>) => { delete raw.frames[0].association; },
      (raw: Record<string, any>) => { raw.estimator.configurationVersion = "apple-vision-3d-raw-1"; },
      (raw: Record<string, any>) => { raw.identityPolicy.parameters.matchRadius = -1; },
      (raw: Record<string, any>) => { raw.identityPolicy.version = "unknown"; },
    ]) {
      const raw = JSON.parse(JSON.stringify(softwareFixture()));
      mutate(raw);
      expect(parse(raw).ok).toBe(false);
    }
  });

  it("requires explicit seeds to identify an actual source time, not a wall-clock timestamp", () => {
    const fixture = softwareFixture();
    fixture.identityPolicy.selection = "explicit_seed";
    fixture.identityPolicy.seed = { x: 0.5, y: 0.5, timestampMs: 0 };
    expect(parse(fixture).ok).toBe(true);
    fixture.identityPolicy.seed.timestampMs = 50;
    expect(parse(fixture).ok).toBe(false);
    fixture.identityPolicy.seed.timestampMs = Date.now();
    expect(parse(fixture).ok).toBe(false);
  });
});
