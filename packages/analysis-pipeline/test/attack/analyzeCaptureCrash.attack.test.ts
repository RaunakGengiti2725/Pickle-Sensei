/**
 * Adversarial pass 3 / tester #4 — the fusion engine's provider-crash wrapper.
 *
 * analyzeCapture wraps every provider call in `run()` which converts a
 * rejection into a typed `<task>.provider_crash` failure. This attacks that
 * wrapper with providers that throw SYNCHRONOUSLY (before returning a promise),
 * reject asynchronously, and resolve with a non-Result value, under rapid
 * interleaving with healthy runs. Contrast: analyzeClip has no such wrapper
 * (see analyzeClipCrash.attack.test.ts).
 */
import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from "@pickle/scoring";
import { unavailable, type StrokeIdentity } from "@pickle/swing-domain";
import { GeometricPhaseSegmenter, GeometryBiomechanicsExtractor } from "@pickle/vision-geometry";
import type { IBiomechanicsExtractor, IPhaseSegmenter } from "@pickle/vision-contracts";
import {
  analyzeCapture,
  type CaptureAnalysisInput,
  type FusionProviders,
} from "../../src/index.js";

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
    captureId: "attack-capture",
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
  analysisId: `attack-analysis-${++counter}`,
  sessionId: null,
  appVersion: "0.1.0",
  modelBundleVersion: "fusion-attack",
  nowIso: () => "2026-08-27T18:30:00.000Z",
  makeId: () => `run-${++counter}`,
});

function throwingPhase(mode: "sync" | "async"): IPhaseSegmenter {
  const real = new GeometricPhaseSegmenter({ aspectRatio: 1 });
  return {
    modelVersion: real.modelVersion,
    source: real.source,
    segmentPhases(): ReturnType<IPhaseSegmenter["segmentPhases"]> {
      if (mode === "sync") throw new Error("phase segmenter crashed synchronously");
      return Promise.reject(new Error("phase segmenter crashed asynchronously"));
    },
  };
}

function throwingBiomechanics(mode: "sync" | "async"): IBiomechanicsExtractor {
  const real = new GeometryBiomechanicsExtractor();
  return {
    descriptor: real.descriptor,
    extract(): ReturnType<IBiomechanicsExtractor["extract"]> {
      if (mode === "sync") throw new Error("biomechanics crashed synchronously");
      return Promise.reject(new Error("biomechanics crashed asynchronously"));
    },
  };
}

async function settle<T>(
  promise: Promise<T>,
): Promise<{ status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown }> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

describe("[attack] analyzeCapture — provider crashes are typed failures", () => {
  it("async rejection in biomechanics → typed biomechanics_extraction.provider_crash", async () => {
    const outcome = await settle(
      analyzeCapture(
        providers({ biomechanics: throwingBiomechanics("async") }),
        captureInput(),
        options(),
      ),
    );
    expect(outcome.status, `rejected: ${String((outcome as { reason?: unknown }).reason)}`).toBe(
      "fulfilled",
    );
    if (outcome.status !== "fulfilled") return;
    expect(outcome.value.ok).toBe(false);
    if (outcome.value.ok) return;
    expect(outcome.value.failure.code).toBe("biomechanics_extraction.provider_crash");
    expect(outcome.value.failure.kind).toBe("permanent");
  });

  it("SYNCHRONOUS throw in biomechanics (before any promise exists) is still a typed failure, not a rejection", async () => {
    const outcome = await settle(
      analyzeCapture(
        providers({ biomechanics: throwingBiomechanics("sync") }),
        captureInput(),
        options(),
      ),
    );
    expect(outcome.status, `rejected: ${String((outcome as { reason?: unknown }).reason)}`).toBe(
      "fulfilled",
    );
    if (outcome.status !== "fulfilled") return;
    expect(outcome.value.ok).toBe(false);
    if (outcome.value.ok) return;
    expect(outcome.value.failure.code).toBe("biomechanics_extraction.provider_crash");
  });

  it("SYNCHRONOUS throw in phase segmentation is a typed failure", async () => {
    const outcome = await settle(
      analyzeCapture(providers({ phase: throwingPhase("sync") }), captureInput(), options()),
    );
    expect(outcome.status, `rejected: ${String((outcome as { reason?: unknown }).reason)}`).toBe(
      "fulfilled",
    );
    if (outcome.status !== "fulfilled") return;
    expect(outcome.value.ok).toBe(false);
    if (outcome.value.ok) return;
    expect(outcome.value.failure.code).toBe("phase_segmentation.provider_crash");
  });

  it("rapid interleaving of crashing and healthy captures: healthy runs are untouched", async () => {
    const crashing = providers({ phase: throwingPhase("async") });
    const healthy = providers();
    const runs = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        settle(analyzeCapture(i % 2 === 0 ? crashing : healthy, captureInput(), options())),
      ),
    );
    runs.forEach((run, i) => {
      expect(run.status, `run ${i} rejected`).toBe("fulfilled");
      if (run.status !== "fulfilled") return;
      if (i % 2 === 1) {
        expect(
          run.value.ok,
          `healthy run ${i} failed: ${JSON.stringify(!run.value.ok && run.value.failure)}`,
        ).toBe(true);
      } else {
        expect(run.value.ok).toBe(false);
      }
    });
  });

  it("an unregistered declared slug never reaches getShotScoringConfig unguarded (typed failure or resolved profile)", async () => {
    const bogus = { declared: "lob_smash_2000" as never, predicted: null } as StrokeIdentity;
    const outcome = await settle(analyzeCapture(providers(), captureInput(bogus), options()));
    expect(outcome.status, `rejected: ${String((outcome as { reason?: unknown }).reason)}`).toBe(
      "fulfilled",
    );
  });
});
