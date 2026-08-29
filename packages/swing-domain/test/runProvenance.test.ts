import { describe, expect, it } from "vitest";
import type { ShotAnalysis } from "@pickle/shared-types";
import {
  CAPTURE_ENVELOPE_VERSION_NOT_MEASURED,
  explainAnalysisRun,
  type AnalysisRecord,
  type AnalysisRunProvenance,
  type ModelRunRecord,
} from "../src/index.js";

/**
 * Reconstruction guarantee: a Result stored months ago must be explainable
 * from the persisted AnalysisRecord ALONE — no live model registry, provider
 * bundle, or source archaeology. Records that cannot explain themselves are
 * reported as unexplainable, never guessed at.
 */

// The record below was "stored" on 2026-02-14 — months before this suite
// runs — and everything asserted about it comes from the stored bytes.
const STORED_AT_ISO = "2026-02-14T09:12:33.000Z";

const POSE_MODEL = {
  providerId: "pose.apple-vision",
  modelVersion: "apple-vision-bodypose-1",
  runtime: "vision_framework" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

const SCORER_MODEL = {
  providerId: "scorer.sm-v1",
  modelVersion: "sm-v1",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

const scoringRun: ModelRunRecord = {
  id: "run-scoring-1",
  task: "technique_scoring",
  model: SCORER_MODEL,
  inputSchemaVersion: 1,
  outputSchemaVersion: 1,
  startedAtIso: STORED_AT_ISO,
  completedAtIso: STORED_AT_ISO,
  status: "succeeded",
  failure: null,
};

const provenance: AnalysisRunProvenance = {
  appVersion: "0.1.0",
  pipelineVersion: "fusion-1",
  providerVersions: [POSE_MODEL, SCORER_MODEL],
  scoreVersion: "sm-v1",
  taxonomyVersion: "pickleball-taxonomy-v2",
  drillMappingVersion: "none",
  captureEnvelopeVersion: CAPTURE_ENVELOPE_VERSION_NOT_MEASURED,
  recordedAtIso: STORED_AT_ISO,
};

const storedResult: ShotAnalysis = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  sessionId: null,
  shotType: "dink",
  cameraView: "side",
  handedness: "right",
  capturedAtIso: STORED_AT_ISO,
  timestamps: { startMs: 0, contactMs: 450, endMs: 900 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.2,
  analysisConfidence: 0.85,
  resultKind: "scored",
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: "0.1.0",
    modelBundleVersion: "on-device-fusion-1",
    poseModelVersion: "apple-vision-bodypose-1",
    paddleModelVersion: "paddle-none-0",
    strokeDetectorVersion: "temporal-stroke-heuristic-2",
    phaseModelVersion: "phase-1",
    scoringModelVersion: "sm-v1",
    shotConfigVersion: "dink@1",
  },
  source: "real",
};

function storedRecord(overrides: Partial<AnalysisRecord> = {}): AnalysisRecord {
  const record: AnalysisRecord = {
    schemaVersion: 1,
    id: "analysis-old-1",
    captureId: "capture-old-1",
    createdAtIso: STORED_AT_ISO,
    engineVersion: "fusion-1",
    strokeTaxonomyVersion: "pickleball-taxonomy-v2",
    strokeResolution: { kind: "declared", shotType: "dink" },
    modalities: { pose: true, paddle: false, ball: false, court: false, camera: false },
    modelRuns: [scoringRun],
    provenance,
    result: storedResult,
    faults: [],
    uncertainty: {
      analysisConfidence: 0.85,
      presentation: "normal",
      perCheckpoint: {},
      limitingFactors: [],
    },
    evidence: [],
    shadow: [],
    ...overrides,
  };
  // Serialization round-trip: what the explainer sees is exactly what a
  // months-old database row would deserialize to — nothing held in memory.
  return JSON.parse(JSON.stringify(record)) as AnalysisRecord;
}

describe("explainAnalysisRun — months-old reconstruction from storage alone", () => {
  it("reconstructs the full explanation of a months-old scored record", () => {
    const record = storedRecord();
    const monthsOldMs = Date.now() - Date.parse(record.provenance.recordedAtIso);
    expect(monthsOldMs).toBeGreaterThan(90 * 24 * 60 * 60 * 1000);

    const explained = explainAnalysisRun(record);
    expect(explained.ok).toBe(true);
    if (!explained.ok) return;

    const explanation = explained.value;
    expect(explanation.analysisId).toBe("analysis-old-1");
    expect(explanation.captureId).toBe("capture-old-1");
    expect(explanation.recordedAtIso).toBe(STORED_AT_ISO);
    expect(explanation.scored).toBe(true);
    expect(explanation.overallScore).toBe(7.2);
    // Every requested provenance dimension is answerable from the record.
    expect(explanation.versions.appVersion).toBe("0.1.0");
    expect(explanation.versions.pipelineVersion).toBe("fusion-1");
    expect(explanation.versions.scoreVersion).toBe("sm-v1");
    expect(explanation.versions.taxonomyVersion).toBe("pickleball-taxonomy-v2");
    expect(explanation.versions.drillMappingVersion).toBe("none");
    expect(explanation.versions.captureEnvelopeVersion).toBe(CAPTURE_ENVELOPE_VERSION_NOT_MEASURED);
    expect(explanation.versions.providerVersions.map((m) => m.providerId)).toEqual([
      "pose.apple-vision",
      "scorer.sm-v1",
    ]);
    // Execution trace: which model ran, when, and with what outcome.
    expect(explanation.executions).toEqual([
      {
        task: "technique_scoring",
        providerId: "scorer.sm-v1",
        modelVersion: "sm-v1",
        runtime: "deterministic",
        status: "succeeded",
        startedAtIso: STORED_AT_ISO,
        completedAtIso: STORED_AT_ISO,
      },
    ]);
  });

  it("reconstructs an abstained (result: null) record without inventing a score", () => {
    const explained = explainAnalysisRun(storedRecord({ result: null }));
    expect(explained.ok).toBe(true);
    if (!explained.ok) return;
    expect(explained.value.scored).toBe(false);
    expect(explained.value.overallScore).toBeNull();
  });

  it("reports a pre-provenance record as unexplainable instead of guessing", () => {
    const legacy = storedRecord();
    // Simulate a row serialized before the provenance field existed.
    delete (legacy as Partial<AnalysisRecord>).provenance;
    const explained = explainAnalysisRun(legacy);
    expect(explained.ok).toBe(false);
    if (explained.ok) return;
    expect(explained.failure.code).toBe("provenance.missing");
  });

  it("rejects provenance with an empty required field", () => {
    const explained = explainAnalysisRun(
      storedRecord({ provenance: { ...provenance, drillMappingVersion: "" } }),
    );
    expect(explained.ok).toBe(false);
    if (explained.ok) return;
    expect(explained.failure.code).toBe("provenance.incomplete");
    expect(explained.failure.message).toContain("drillMappingVersion");
  });

  it("rejects provenance whose timestamp is not a valid ISO instant", () => {
    const explained = explainAnalysisRun(
      storedRecord({ provenance: { ...provenance, recordedAtIso: "not-a-timestamp" } }),
    );
    expect(explained.ok).toBe(false);
    if (explained.ok) return;
    expect(explained.failure.code).toBe("provenance.invalid_timestamp");
  });

  it("rejects provenance that lists no provider versions", () => {
    const explained = explainAnalysisRun(
      storedRecord({ provenance: { ...provenance, providerVersions: [] } }),
    );
    expect(explained.ok).toBe(false);
    if (explained.ok) return;
    expect(explained.failure.code).toBe("provenance.no_providers");
  });

  it("rejects a record whose model run is outside the provenance snapshot", () => {
    const explained = explainAnalysisRun(
      storedRecord({
        provenance: { ...provenance, providerVersions: [POSE_MODEL] },
      }),
    );
    expect(explained.ok).toBe(false);
    if (explained.ok) return;
    expect(explained.failure.code).toBe("provenance.model_run_untracked");
    expect(explained.failure.message).toContain("scorer.sm-v1@sm-v1");
  });

  it("rejects a record whose result version vector disagrees with provenance", () => {
    const explained = explainAnalysisRun(
      storedRecord({ provenance: { ...provenance, appVersion: "0.2.0" } }),
    );
    expect(explained.ok).toBe(false);
    if (explained.ok) return;
    expect(explained.failure.code).toBe("provenance.version_vector_mismatch");
  });
});
