import { beforeAll, describe, expect, it } from "vitest";
import { fail, failure, ok, type ShotTypeSlug } from "@pickle/shared-types";
import type { ITechniqueScorer, VideoClipRef, VisionProviderSet } from "@pickle/vision-contracts";
import { generateSwingSequence } from "@pickle/evaluation";
import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from "@pickle/scoring";
import { unavailable } from "@pickle/swing-domain";
import { GeometricPhaseSegmenter, GeometryBiomechanicsExtractor } from "@pickle/vision-geometry";
import { createFixtureVisionProviderSet } from "../../vision-contracts/test/support/fixtureProvider.js";
import {
  analyzeCapture,
  analyzeClip,
  type CaptureAnalysisInput,
  type FusionProviders,
} from "../src/index.js";

/**
 * STRUCTURAL AUDIT #1 (pass 1/3) — orchestration error-handling probes for
 * analyzeClip (legacy clip path) and analyzeCapture (fusion path).
 *
 * Invariant under test (mapper + module docs): a provider failure of ANY
 * shape (typed failure, rejection, synchronous throw) becomes a typed
 * `Result` failure; the orchestrator never rejects and never fabricates.
 */

const clip: VideoClipRef = {
  uri: "fixture://audit-clip",
  durationMs: 2400,
  fps: 30,
  width: 720,
  height: 1280,
};

function clipOptions(shotType: ShotTypeSlug) {
  return {
    analysisId: "3b9f2b60-1111-4222-8333-444455556666",
    sessionId: null,
    shotType,
    handedness: "right" as const,
    cameraView: "side" as const,
    appVersion: "0.1.0",
    modelBundleVersion: "fixture-1",
    capturedAtIso: "2026-08-26T18:00:00.000Z",
  };
}

beforeAll(() => {
  process.env["PICKLE_ENV"] = "development";
});

describe("audit: analyzeClip never rejects", () => {
  it("a rejecting stroke detector becomes a typed failure", async () => {
    const providers: VisionProviderSet = {
      ...createFixtureVisionProviderSet("forehand_drive"),
      stroke: {
        modelVersion: "audit-rejecting",
        source: "fixture",
        detectStrokes: async () => {
          throw new Error("native bridge lost");
        },
      },
    };
    const settled = await analyzeClip(providers, clip, clipOptions("forehand_drive")).then(
      (result) => ({ status: "resolved" as const, result }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    expect(settled.status).toBe("resolved");
    if (settled.status !== "resolved") return;
    expect(settled.result.ok).toBe(false);
  });

  it("pose + paddle both rejecting (Promise.all) becomes a typed failure", async () => {
    const providers: VisionProviderSet = {
      ...createFixtureVisionProviderSet("forehand_drive"),
      pose: {
        modelVersion: "audit-rejecting",
        source: "fixture",
        extractPose: () => Promise.reject(new Error("pose crashed")),
      },
      paddle: {
        modelVersion: "audit-rejecting",
        source: "fixture",
        detectPaddle: () => Promise.reject(new Error("paddle crashed")),
      },
    };
    const settled = await analyzeClip(providers, clip, clipOptions("forehand_drive")).then(
      (result) => ({ status: "resolved" as const, result }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    expect(settled.status).toBe("resolved");
  });

  it("a shot type without a scoring config becomes a typed failure, not a thrown Error", async () => {
    // Runtime slugs come from persisted captures / server payloads; the
    // scoring registry is the terminal authority and must refuse typed-ly.
    // The feature extractor is stubbed to be slug-agnostic so the probe
    // reaches the scoring registry (the fixture extractor refuses earlier).
    const unknownSlug = "audit_unknown_stroke" as ShotTypeSlug;
    const providers: VisionProviderSet = {
      ...createFixtureVisionProviderSet("forehand_drive"),
      features: { version: "audit-any-slug", extractMeasurements: async () => ok([]) },
    };
    const settled = await analyzeClip(providers, clip, clipOptions(unknownSlug)).then(
      (result) => ({ status: "resolved" as const, result }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    expect(settled.status).toBe("resolved");
    if (settled.status !== "resolved") return;
    expect(settled.result.ok).toBe(false);
  });
});

const TRIGGER_MODEL = {
  providerId: "trigger.temporal-heuristic",
  modelVersion: "temporal-stroke-heuristic-2",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

function fusionProviders(overrides: Partial<FusionProviders> = {}): FusionProviders {
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

function captureInput(): CaptureAnalysisInput {
  const { sequence, window } = generateSwingSequence();
  return {
    captureId: "audit-capture",
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
    stroke: { declared: "forehand_drive", predicted: null },
    handedness: "right",
    cameraView: "side",
    capturedAtIso: "2026-08-27T18:00:00.000Z",
  };
}

let counter = 0;
const captureOptions = () => ({
  analysisId: `audit-analysis-${++counter}`,
  sessionId: null,
  appVersion: "0.1.0",
  modelBundleVersion: "fusion-audit",
  nowIso: () => "2026-08-27T18:30:00.000Z",
  makeId: () => `audit-run-${++counter}`,
});

describe("audit: analyzeCapture provider crash handling covers every crash shape", () => {
  it("a provider that throws SYNCHRONOUSLY (non-async method) is a typed provider_crash with a ModelRunRecord", async () => {
    const syncCrash: ITechniqueScorer = {
      descriptor: {
        providerId: "scorer.sync-crash",
        modelVersion: "0",
        runtime: "coreml",
        executionTarget: "on_device",
        artifactHash: null,
        inputSchemaVersion: 1,
        outputSchemaVersion: 1,
      },
      // Declared as returning a Promise, but a native bridge shim can throw
      // before a promise exists (TurboModule arg validation, JSI exception).
      score: (): ReturnType<ITechniqueScorer["score"]> => {
        throw new Error("JSI exception before promise creation");
      },
    };
    const settled = await analyzeCapture(
      fusionProviders({ scorer: syncCrash }),
      captureInput(),
      captureOptions(),
    ).then(
      (result) => ({ status: "resolved" as const, result }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    expect(settled.status).toBe("resolved");
    if (settled.status !== "resolved") return;
    expect(settled.result.ok).toBe(false);
    if (settled.result.ok) return;
    expect(settled.result.failure.code).toBe("technique_scoring.provider_crash");
  });

  it("a provider that returns a typed failure keeps working as the baseline (control)", async () => {
    const typed: ITechniqueScorer = {
      descriptor: {
        providerId: "scorer.typed",
        modelVersion: "0",
        runtime: "coreml",
        executionTarget: "on_device",
        artifactHash: null,
        inputSchemaVersion: 1,
        outputSchemaVersion: 1,
      },
      score: async () => fail(failure("permanent", "scoring.model_load_failed", "control")),
    };
    const result = await analyzeCapture(
      fusionProviders({ scorer: typed }),
      captureInput(),
      captureOptions(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("scoring.model_load_failed");
  });

  it("a never-settling provider cannot hang the capture analysis (bounded wait or abort signal)", async () => {
    const hangs: ITechniqueScorer = {
      descriptor: {
        providerId: "scorer.hangs",
        modelVersion: "0",
        runtime: "coreml",
        executionTarget: "on_device",
        artifactHash: null,
        inputSchemaVersion: 1,
        outputSchemaVersion: 1,
      },
      score: () => new Promise<never>(() => {}),
    };
    const outcome = await Promise.race([
      analyzeCapture(fusionProviders({ scorer: hangs }), captureInput(), captureOptions()).then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 500)),
    ]);
    // No timeout option / AbortSignal exists on the analyzeCapture contract,
    // so a stalled native provider stalls the whole capture forever.
    expect(outcome).toBe("settled");
  });

  it("control: a healthy pose-only run still succeeds under the audit harness", async () => {
    const result = await analyzeCapture(fusionProviders(), captureInput(), captureOptions());
    expect(result.ok).toBe(true);
  });
});
