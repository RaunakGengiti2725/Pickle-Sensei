import { describe, expect, it } from "vitest";
import {
  generateSwingSequence,
  spearmanCorrelation,
  type BenchmarkReport,
  type SwingTruth,
} from "@pickle/evaluation";
import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from "@pickle/scoring";
import { analyzeCapture } from "@pickle/analysis-pipeline";
import { unavailable } from "@pickle/swing-domain";
import { GeometricPhaseSegmenter, GeometryBiomechanicsExtractor } from "../src/index.js";

/**
 * Scoring ordering benchmark — synthetic provenance. Constructs swings whose
 * execution quality is ordered BY CONSTRUCTION (each step degrades one or
 * more sm-v1 target metrics further) and requires the scoring stack's rank
 * order to agree. This validates ordering behavior of the pipeline; it is
 * NOT a claim of coach agreement — that requires expert-rated first-party
 * benchmarks, which do not exist yet.
 */

const ORDERED_QUALITY: Array<{ caseId: string; rank: number; truth: Partial<SwingTruth> }> = [
  { caseId: "textbook", rank: 4, truth: {} },
  // Each step degrades by clearly more than the score's one-decimal
  // resolution, so the constructed ordering is unambiguous ground truth.
  {
    caseId: "shallow-knees-short-turn",
    rank: 3,
    truth: { kneeFlexionDeg: 8, shoulderTurnDeg: 22 },
  },
  {
    caseId: "cramped-and-stiff",
    rank: 2,
    truth: { kneeFlexionDeg: 6, stanceWidthRatio: 0.7, shoulderTurnDeg: 15 },
  },
  {
    caseId: "late-flat-and-stiff",
    rank: 1,
    truth: {
      kneeFlexionDeg: 3,
      stanceWidthRatio: 0.55,
      shoulderTurnDeg: 4,
      contactForwardNorm: -0.05,
      swingDipNorm: 0,
      backswingLengthNorm: 1.9,
    },
  },
];

describe("scoring ordering benchmark (synthetic v1)", () => {
  it("ranks constructed execution quality in the right order", async () => {
    const providers = {
      phase: new GeometricPhaseSegmenter({ aspectRatio: 1 }),
      biomechanics: new GeometryBiomechanicsExtractor(),
      scorer: new Sm1TechniqueScorer(),
      faultDetector: new CheckpointThresholdFaultDetector(),
      uncertainty: new EngineUncertaintyEstimator(),
      coach: new PriorityCoachingRanker(),
      classifier: null,
      shadowScorers: [],
    };

    const pairs = [];
    const abstained: string[] = [];
    let runCounter = 0;
    for (const benchCase of ORDERED_QUALITY) {
      const { sequence, window } = generateSwingSequence(benchCase.truth);
      const record = await analyzeCapture(
        providers,
        {
          captureId: `bench-${benchCase.caseId}`,
          pose: sequence,
          paddle: unavailable("paddle_detector_not_installed"),
          ball: unavailable("ball_tracker_not_installed"),
          trigger: {
            startMs: window.startMs,
            endMs: window.endMs,
            peakMotionMs: window.peakMs,
            confidence: 0.9,
            producedBy: {
              providerId: "trigger.temporal-heuristic",
              modelVersion: "temporal-stroke-heuristic-2",
              runtime: "deterministic",
              executionTarget: "on_device",
              artifactHash: null,
            },
          },
          stroke: { declared: "forehand_drive", predicted: null },
          handedness: "right",
          cameraView: "side",
          capturedAtIso: "2026-08-27T18:00:00.000Z",
        },
        {
          analysisId: `bench-analysis-${++runCounter}`,
          sessionId: null,
          appVersion: "0.1.0",
          modelBundleVersion: "eval",
          nowIso: () => new Date().toISOString(),
          makeId: () => `bench-run-${++runCounter}`,
        },
      );
      if (!record.ok || record.value.result?.overallScore == null) {
        abstained.push(benchCase.caseId);
        continue;
      }
      pairs.push({ truth: benchCase.rank, predicted: record.value.result.overallScore });
    }

    const rankCorrelation = spearmanCorrelation(pairs);
    const report: BenchmarkReport = {
      benchmark: {
        id: "scoring-ordering-synthetic",
        version: "1",
        task: "technique_scoring",
        provenance: "synthetic",
        caseCount: ORDERED_QUALITY.length,
        notes:
          "Constructed quality ordering. Validates rank behavior only — coach agreement requires first-party expert benchmarks.",
      },
      evaluatedAtIso: new Date().toISOString(),
      subject: "scorer.sm-v1@sm-v1 (full fusion path)",
      metrics: {
        spearmanRankCorrelation: rankCorrelation,
        abstainRate: abstained.length / ORDERED_QUALITY.length,
      },
      abstainedCaseIds: abstained,
    };
    console.log(JSON.stringify(report, null, 2));

    expect(rankCorrelation).not.toBeNull();
    expect(rankCorrelation!).toBeGreaterThanOrEqual(0.99);
    expect(report.metrics["abstainRate"]).toBe(0);
  });
});
