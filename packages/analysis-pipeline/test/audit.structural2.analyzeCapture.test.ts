import { describe, expect, it } from "vitest";
import { fail, failure } from "@pickle/shared-types";
import { generateSwingSequence } from "@pickle/evaluation";
import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  getShotScoringConfig,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from "@pickle/scoring";
import { unavailable, type StrokeIdentity } from "@pickle/swing-domain";
import { GeometricPhaseSegmenter, GeometryBiomechanicsExtractor } from "@pickle/vision-geometry";
import type { IFaultDetector, ITechniqueScorer } from "@pickle/vision-contracts";
import { analyzeCapture, type CaptureAnalysisInput, type FusionProviders } from "../src/index.js";

/**
 * STRUCTURAL AUDIT #2 (pass 1) — analyzeCapture reproducers.
 * Contract under test (analyzeCapture.ts L147–L178 `run`, analyzeCapture.test.ts
 * "crashing provider ⇒ typed failure with recorded ModelRunRecord, never
 * silent success"; "shadow scorers never change the user-facing result").
 */

const TRIGGER_MODEL = {
  providerId: "trigger.temporal-heuristic",
  modelVersion: "temporal-stroke-heuristic-2",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

function providers(overrides: Partial<FusionProviders> = {}): FusionProviders {
  return {
    phase: new GeometricPhaseSegmenter({ aspectRatio: 1 }),
    biomechanics: new GeometryBiomechanicsExtractor(),
    scorer: new Sm1TechniqueScorer(),
    faultDetector: new CheckpointThresholdFaultDetector(),
    uncertainty: new EngineUncertaintyEstimator(),
    coach: new PriorityCoachingRanker(),
    classifier: null,
    shadowScorers: [],
    ...overrides,
  };
}

function captureInput(
  stroke: StrokeIdentity = { declared: "forehand_drive", predicted: null },
): CaptureAnalysisInput {
  const { sequence, window } = generateSwingSequence();
  return {
    captureId: "capture-audit",
    pose: sequence,
    paddle: unavailable("paddle_detector_not_installed"),
    ball: unavailable("ball_tracker_not_installed"),
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.9,
      producedBy: TRIGGER_MODEL,
    },
    stroke,
    handedness: "right",
    cameraView: "side",
    capturedAtIso: "2026-08-27T18:00:00.000Z",
  };
}

let counter = 0;
const options = () => ({
  analysisId: `analysis-${++counter}`,
  sessionId: null,
  appVersion: "0.1.0",
  modelBundleVersion: "fusion-audit",
  nowIso: () => "2026-08-27T18:30:00.000Z",
  makeId: () => `run-${++counter}`,
});

/** A provider whose method throws SYNCHRONOUSLY (a non-async implementation
 * with a bug, or a native bridge that throws on call) instead of returning a
 * rejected promise. The contracts type the method as returning a Promise, so
 * a plain-function implementation is legal TypeScript. */
function syncThrowingScorer(): ITechniqueScorer {
  return {
    descriptor: {
      providerId: "scorer.sync-crash",
      modelVersion: "crash-1",
      runtime: "deterministic",
      executionTarget: "on_device",
      artifactHash: null,
      inputSchemaVersion: 1,
      outputSchemaVersion: 1,
    },
    score: (() => {
      throw new Error("scorer threw synchronously");
    }) as unknown as ITechniqueScorer["score"],
  };
}

async function settle<T>(
  promise: Promise<T>,
): Promise<{ kind: "ok"; value: T } | { kind: "threw"; message: string }> {
  try {
    return { kind: "ok", value: await promise };
  } catch (error) {
    return { kind: "threw", message: error instanceof Error ? error.message : String(error) };
  }
}

describe("AUDIT analyzeCapture — provider crash containment", () => {
  it("F2-A: a user-facing scorer that throws synchronously yields a typed failure with a recorded ModelRunRecord, not a rejected analyzeCapture()", async () => {
    const outcome = await settle(
      analyzeCapture(providers({ scorer: syncThrowingScorer() }), captureInput(), options()),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.value.ok).toBe(false);
    if (outcome.value.ok) return;
    expect(outcome.value.failure.code).toBe("technique_scoring.provider_crash");
  });

  it("F2-B: a SHADOW scorer that throws synchronously must never change the user-facing result", async () => {
    const baseline = await analyzeCapture(providers(), captureInput(), options());
    expect(baseline.ok).toBe(true);
    const outcome = await settle(
      analyzeCapture(
        providers({ shadowScorers: [syncThrowingScorer()] }),
        captureInput(),
        options(),
      ),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok" || !baseline.ok) return;
    expect(outcome.value.ok).toBe(true);
    if (!outcome.value.ok) return;
    expect(outcome.value.value.result?.overallScore).toBe(baseline.value.result?.overallScore);
    expect(outcome.value.value.shadow).toHaveLength(1);
    expect(outcome.value.value.shadow[0]!.overallScore).toBeNull();
    expect(outcome.value.value.shadow[0]!.run.status).toBe("failed");
  });

  it("F2-C: an ASYNC-rejecting shadow scorer never changes the user-facing result (verified invariant)", async () => {
    const baseline = await analyzeCapture(providers(), captureInput(), options());
    const rejecting: ITechniqueScorer = {
      ...syncThrowingScorer(),
      score: async () => {
        throw new Error("shadow rejected");
      },
    };
    const result = await analyzeCapture(
      providers({ shadowScorers: [rejecting] }),
      captureInput(),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || !baseline.ok) return;
    expect(result.value.result?.overallScore).toBe(baseline.value.result?.overallScore);
    expect(result.value.shadow[0]!.run.status).toBe("failed");
  });
});

describe("AUDIT analyzeCapture — partial-failure honesty", () => {
  it("F2-D: a failed fault detector must be surfaced on the record (limitingFactors), not silently rendered as 'no faults'", async () => {
    const failingDetector: IFaultDetector = {
      descriptor: new CheckpointThresholdFaultDetector().descriptor,
      detectFaults: async () =>
        fail(failure("permanent", "faults.model_unavailable", "Fault model failed to load.")),
    };
    const result = await analyzeCapture(
      providers({ faultDetector: failingDetector }),
      captureInput(),
      options(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.value;
    const faultRun = record.modelRuns.find((run) => run.task === "fault_detection");
    expect(faultRun?.status).toBe("failed");
    expect(record.faults).toEqual([]);
    console.log(
      JSON.stringify({
        audit: "F2-D fault detector failed",
        resultKind: record.result?.resultKind,
        faults: record.faults,
        limitingFactors: record.uncertainty.limitingFactors,
      }),
    );
    // The record's honesty surface for degraded analysis is
    // uncertainty.limitingFactors (analyzeCapture.ts L56–L59). An empty
    // faults list with no limiting factor is indistinguishable from "no
    // faults found".
    expect(record.uncertainty.limitingFactors.some((factor) => /fault/i.test(factor))).toBe(true);
  });

  it("F2-E: a never-settling phase segmenter must not hang analyzeCapture() forever (no timeout/cancellation seam)", async () => {
    const hanging = providers({
      phase: {
        modelVersion: "hang-1",
        segmentPhases: () => new Promise(() => {}),
      } as unknown as FusionProviders["phase"],
    });
    const raced = await Promise.race([
      analyzeCapture(hanging, captureInput(), options()).then(() => "SETTLED" as const),
      new Promise<"HUNG">((resolve) => setTimeout(() => resolve("HUNG"), 300)),
    ]);
    expect(raced).toBe("SETTLED");
  });
});

describe("AUDIT analyzeCapture — provenance coherence", () => {
  it("F2-F: versionVector.shotConfigVersion equals the scoring config's own shotConfigVersion (verified invariant on sm-v1; hard-coded `${shotType}@1` at analyzeCapture.ts L444)", async () => {
    const result = await analyzeCapture(providers(), captureInput(), options());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result?.versionVector.shotConfigVersion).toBe(
      getShotScoringConfig("forehand_drive").shotConfigVersion,
    );
  });
});
