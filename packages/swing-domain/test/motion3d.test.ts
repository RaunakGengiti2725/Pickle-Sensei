import { describe, expect, it } from "vitest";
import { parseMotion3D, type Motion3DArtifact } from "../src/motion3d.js";

function softwareFixture(): Motion3DArtifact {
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
      captureId: "software-fixture-capture",
      videoSha256: "a".repeat(64),
      videoByteLength: 1000,
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
    frames: [0, 1, 2].map((i) => ({
      frameIndex: i,
      timestampMs: (i * 1000) / 30,
      ptsValue: i,
      ptsTimescale: 30,
      segmentId: 0,
      status: "estimated",
      observationConfidence: 1,
      height: { meters: 1.8, source: "reference" },
      cameraOriginMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1],
      joints: [
        {
          name: "root",
          x: 0,
          y: 0,
          z: 0,
          imageX: 0.5,
          imageY: 0.5,
          confidence: null,
          visibility2D: null,
        },
        {
          name: "left_shoulder",
          x: -0.2,
          y: 0.5,
          z: 0.1,
          imageX: 0.4,
          imageY: 0.3,
          confidence: null,
          visibility2D: 0.8,
        },
        {
          name: "left_elbow",
          x: -0.3,
          y: 0.2,
          z: 0.2,
          imageX: 0.3,
          imageY: 0.4,
          confidence: null,
          visibility2D: 0.7,
        },
      ],
    })),
  };
}

const parse = (value: unknown) => parseMotion3D(JSON.stringify(value));

describe("3D artifact wire contract (software fixtures, not accuracy evidence)", () => {
  it("round-trips raw estimates and their unavailable uncertainty without promoting confidence", () => {
    const fixture = softwareFixture();
    const result = parse(fixture);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(fixture);
  });

  it.each(["observed", "modelled_correction", "reference", "software_fixture"])(
    "rejects the %s role on the actual reconstruction ingress",
    (role) => expect(parse({ ...softwareFixture(), role }).ok).toBe(false),
  );

  it.each([2, 0, "1", null])("rejects unsupported schema %s", (schemaVersion) => {
    expect(parse({ ...softwareFixture(), schemaVersion }).ok).toBe(false);
  });

  it.each([
    { coordinateSystem: "world" },
    { units: "meters" },
    { axes: "left_handed" },
    { uncertainty: "calibrated" },
    { temporalProcessing: "smoothed" },
    { format: "pickle.pose-sequence.v1" },
    { overallScore: 9.8 },
  ])("refuses relabelled or unknown contract fields %s", (change) => {
    expect(parse({ ...softwareFixture(), ...change }).ok).toBe(false);
  });

  it("retains reference height as reference, not calibrated body size", () => {
    const fixture = softwareFixture();
    const result = parse(fixture);
    expect(result.ok && result.value.frames[0]?.height?.source).toBe("reference");
    fixture.frames[0]!.height!.meters = 1.7;
    expect(parse(fixture).ok).toBe(false);
  });

  it("rejects non-finite values, duplicate joints and unknown joints", () => {
    for (const value of [null, "0", Infinity, -Infinity, NaN]) {
      const fixture = softwareFixture();
      (fixture.frames[0]!.joints[0] as unknown as Record<string, unknown>)["z"] = value;
      expect(parse(fixture).ok).toBe(false);
    }
    const duplicate = softwareFixture();
    duplicate.frames[0]!.joints.push({ ...duplicate.frames[0]!.joints[0]! });
    expect(parse(duplicate).ok).toBe(false);
    const unknown = softwareFixture();
    (unknown.frames[0]!.joints[0] as unknown as Record<string, unknown>)["name"] = "paddle_face";
    expect(parse(unknown).ok).toBe(false);
  });

  it("never turns image visibility into 3D accuracy", () => {
    const fixture = softwareFixture();
    (fixture.frames[0]!.joints[0] as unknown as Record<string, unknown>)["confidence"] = 0.99;
    expect(parse(fixture).ok).toBe(false);
  });

  it("rejects duplicate or reordered source frames and timestamps", () => {
    const timestamp = softwareFixture();
    timestamp.frames[1]!.timestampMs = 0;
    expect(parse(timestamp).ok).toBe(false);
    const index = softwareFixture();
    index.frames[1]!.frameIndex = 0;
    expect(parse(index).ok).toBe(false);
    const reversed = softwareFixture();
    reversed.frames.reverse();
    expect(parse(reversed).ok).toBe(false);
  });

  it("requires frame times to agree with original PTS rather than invented sampling times", () => {
    const fixture = softwareFixture();
    fixture.frames[1]!.timestampMs += 10;
    expect(parse(fixture).ok).toBe(false);
    fixture.frames[1]!.timestampMs -= 10;
    fixture.frames[1]!.ptsTimescale = 0;
    expect(parse(fixture).ok).toBe(false);
  });

  it("accepts missing/ambiguous observations only with no invented joints", () => {
    const fixture = softwareFixture();
    fixture.frames[1] = {
      ...fixture.frames[1]!,
      status: "multiple_people",
      joints: [],
      height: null,
      cameraOriginMatrix: null,
      observationConfidence: null,
    };
    fixture.frames[2]!.segmentId = 1;
    expect(parse(fixture).ok).toBe(true);
    fixture.frames[1].joints = softwareFixture().frames[0]!.joints;
    expect(parse(fixture).ok).toBe(false);
  });

  it("requires a new continuity segment after an unobserved interval", () => {
    const fixture = softwareFixture();
    fixture.frames[1] = {
      ...fixture.frames[1]!,
      status: "no_person",
      joints: [],
      height: null,
      cameraOriginMatrix: null,
      observationConfidence: null,
    };
    expect(parse(fixture).ok).toBe(false);
  });

  it("rejects source mismatch and missing content lineage", () => {
    const fixture = softwareFixture();
    fixture.source.videoSha256 = "not-a-digest";
    expect(parse(fixture).ok).toBe(false);
    fixture.source.videoSha256 = "a".repeat(64);
    fixture.frames[2]!.timestampMs = 1001;
    fixture.frames[2]!.ptsValue = 1001;
    fixture.frames[2]!.ptsTimescale = 1000;
    expect(parse(fixture).ok).toBe(false);
  });

  it("rejects unbounded arrays and malformed roots before interpretation", () => {
    for (const value of [null, [], 1, "motion", {}]) expect(parse(value).ok).toBe(false);
    expect(parseMotion3D("not json").ok).toBe(false);
    const fixture = softwareFixture();
    fixture.frames = Array.from({ length: 1801 }, () => fixture.frames[0]!);
    expect(parse(fixture).ok).toBe(false);
  });
});
