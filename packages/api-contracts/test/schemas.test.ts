import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, ShotSyncPayload, ShotsSyncRequest } from "../src/index.js";

const validShot = {
  id: "1f0e8c1a-2b3c-4d5e-8f90-abcdefabcdef",
  sessionId: null,
  shotType: "forehand_drive",
  cameraView: "side",
  capturedAt: "2026-08-26T18:00:00.000Z",
  timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
  overallScore: 7.4,
  confidence: 0.91,
  resultKind: "scored",
  source: "real",
  phases: [{ key: "contact", startMs: 1000, representativeMs: 1040, endMs: 1090, confidence: 0.9 }],
  checkpoints: [
    {
      key: "contact_position",
      score: 58,
      confidence: 0.94,
      band: "red",
      direction: "late",
      severity: 0.42,
      applicable: true,
    },
  ],
  versionVector: {
    appVersion: "0.1.0",
    modelBundleVersion: "fixture-1",
    poseModelVersion: "fixture-1",
    paddleModelVersion: "fixture-1",
    strokeDetectorVersion: "fixture-1",
    phaseModelVersion: "fixture-1",
    scoringModelVersion: "sm-v1",
    shotConfigVersion: "forehand_drive@1",
  },
};

describe("ShotSyncPayload (canonical, spec p. 21)", () => {
  it("accepts a valid payload", () => {
    expect(ShotSyncPayload.safeParse(validShot).success).toBe(true);
  });

  it("rejects a missing version vector — score versioning is mandatory", () => {
    const { versionVector: _vv, ...withoutVersions } = validShot;
    expect(ShotSyncPayload.safeParse(withoutVersions).success).toBe(false);
  });

  it("rejects out-of-range scores and unknown shot types", () => {
    expect(ShotSyncPayload.safeParse({ ...validShot, overallScore: 11 }).success).toBe(false);
    expect(ShotSyncPayload.safeParse({ ...validShot, shotType: "smash" }).success).toBe(false);
  });

  it("requires a low-confidence result to be representable (null score allowed)", () => {
    const lowConfidence = {
      ...validShot,
      overallScore: null,
      resultKind: "low_confidence",
      confidence: 0.4,
    };
    expect(ShotSyncPayload.safeParse(lowConfidence).success).toBe(true);
  });

  it("caps sync batches at 200", () => {
    const batch = { shots: Array.from({ length: 201 }, () => validShot) };
    expect(ShotsSyncRequest.safeParse(batch).success).toBe(false);
  });
});

describe("OpenAPI generation", () => {
  it("produces a 3.1 document with the implemented routes", () => {
    const doc = buildOpenApiDocument("0.1.0") as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(["/v1/health", "/v1/catalog/shot-types", "/v1/shots:sync"]),
    );
  });
});
