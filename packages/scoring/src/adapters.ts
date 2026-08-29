import type {
  CheckpointScore,
  Measurement,
  PriorityFix,
  Result,
  ShotTypeSlug,
} from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";
import type { DetectedFault, UncertaintySummary } from "@pickle/swing-domain";
import type {
  ICoachingRanker,
  IFaultDetector,
  ITechniqueScorer,
  IUncertaintyEstimator,
  ProviderDescriptor,
} from "@pickle/vision-contracts";
import { getShotScoringConfig } from "./config/v1.js";
import { scoreShot } from "./engine.js";
import { selectPriorityFix } from "./priority.js";
import type { CheckpointResultDetail } from "./types.js";

/**
 * sm-v1 decomposed into the four fusion contracts it was implicitly serving:
 * technique scoring, fault detection, uncertainty estimation, and coaching
 * ranking. Each is now independently replaceable — a learned scorer can take
 * `scorer.sm-v1`'s slot while this coaching ranker stays, or vice versa —
 * without touching capture, storage, or the result system.
 */

interface Sm1Internal {
  checkpointResults: CheckpointResultDetail[];
  shotType: ShotTypeSlug;
}

function isSm1Internal(value: unknown): value is Sm1Internal {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Sm1Internal).checkpointResults)
  );
}

const descriptor = (providerId: string, modelVersion: string): ProviderDescriptor => ({
  providerId,
  modelVersion,
  runtime: "deterministic",
  executionTarget: "on_device",
  artifactHash: null,
  inputSchemaVersion: 1,
  outputSchemaVersion: 1,
});

export class Sm1TechniqueScorer implements ITechniqueScorer {
  public readonly descriptor = descriptor("scorer.sm-v1", "sm-v1");

  public async score(input: {
    shotType: ShotTypeSlug;
    measurements: Measurement[];
    embedding: unknown;
  }): ReturnType<ITechniqueScorer["score"]> {
    let config;
    try {
      config = getShotScoringConfig(input.shotType);
    } catch {
      return fail(
        failure(
          "unsupported_device",
          "scoring.unsupported_stroke",
          `No scoring configuration exists for stroke "${input.shotType}".`,
        ),
      );
    }
    const outcome = scoreShot(config, input.measurements);
    const internal: Sm1Internal = {
      checkpointResults: outcome.checkpointResults,
      shotType: input.shotType,
    };
    return ok({
      overallScore: outcome.overallScore,
      checkpoints: outcome.checkpoints,
      analysisConfidence: outcome.analysisConfidence,
      presentation: outcome.presentation,
      guidance: outcome.guidance,
      checkpointEvidence: outcome.checkpointResults.map((detail) => ({
        checkpoint: detail.key,
        metricKeys: detail.metricDetails.map((metric) => metric.metricKey),
      })),
      internal,
    });
  }
}

export class CheckpointThresholdFaultDetector implements IFaultDetector {
  public readonly descriptor = descriptor("faults.checkpoint-threshold", "faults-v1");

  /** Checkpoints scoring below this are reported as faults. */
  private readonly faultScoreThreshold = 65;

  public async detectFaults(input: {
    shotType: ShotTypeSlug;
    checkpoints: CheckpointScore[];
    scorerInternal: unknown;
  }): Promise<Result<DetectedFault[]>> {
    const faults: DetectedFault[] = [];
    for (const checkpoint of input.checkpoints) {
      if (checkpoint.score === null || checkpoint.score >= this.faultScoreThreshold) continue;
      faults.push({
        code: `${checkpoint.key}.${checkpoint.direction}`,
        checkpoint: checkpoint.key,
        direction: checkpoint.direction,
        severity: checkpoint.severity,
        confidence: checkpoint.confidence,
        evidence: [
          {
            claim: `checkpoint:${checkpoint.key}`,
            window: null,
            metricKeys: metricKeysFor(input.scorerInternal, checkpoint.key),
            producedByProviderId: "scorer.sm-v1",
            confidence: checkpoint.confidence,
          },
        ],
      });
    }
    return ok(faults);
  }
}

function metricKeysFor(internal: unknown, checkpoint: string): string[] {
  if (!isSm1Internal(internal)) return [];
  const detail = internal.checkpointResults.find((entry) => entry.key === checkpoint);
  return detail ? detail.metricDetails.map((metric) => metric.metricKey) : [];
}

export class EngineUncertaintyEstimator implements IUncertaintyEstimator {
  public readonly descriptor = descriptor("uncertainty.engine", "uncertainty-v1");

  public async estimate(input: {
    checkpoints: CheckpointScore[];
    analysisConfidence: number;
    presentation: "normal" | "lower_confidence" | "abstain";
    modalitiesUsed: { pose: boolean; paddle: boolean; ball: boolean; court: boolean };
  }): Promise<Result<UncertaintySummary>> {
    const limitingFactors: string[] = [];
    if (!input.modalitiesUsed.paddle) {
      limitingFactors.push("paddle_track_unavailable");
    }
    if (!input.modalitiesUsed.ball) {
      limitingFactors.push("ball_track_unavailable");
    }
    if (!input.modalitiesUsed.court) {
      limitingFactors.push("court_geometry_unavailable");
    }
    // "Unobserved" means no metric was measured (confidence 0) — distinct
    // from checkpoints that WERE measured but had their scores withheld by
    // an abstention, which is reported once as a threshold factor.
    for (const checkpoint of input.checkpoints) {
      if (checkpoint.applicable && checkpoint.confidence === 0) {
        limitingFactors.push(`checkpoint_unobserved:${checkpoint.key}`);
      }
    }
    if (
      input.presentation === "abstain" &&
      input.checkpoints.some((checkpoint) => checkpoint.confidence > 0)
    ) {
      limitingFactors.push("analysis_confidence_below_threshold");
    }
    const perCheckpoint: Record<string, number> = {};
    for (const checkpoint of input.checkpoints) {
      perCheckpoint[checkpoint.key] = checkpoint.confidence;
    }
    return ok({
      analysisConfidence: input.analysisConfidence,
      presentation: input.presentation,
      perCheckpoint,
      limitingFactors,
    });
  }
}

export class PriorityCoachingRanker implements ICoachingRanker {
  public readonly descriptor = descriptor("coach.priority", "priority-v1");

  public async rank(input: {
    shotType: ShotTypeSlug;
    scorerInternal: unknown;
    focusCheckpoint?: string;
  }): Promise<Result<PriorityFix | null>> {
    if (!isSm1Internal(input.scorerInternal)) {
      return fail(
        failure(
          "permanent",
          "coaching.incompatible_scorer_internal",
          "This coaching ranker requires sm-v1 checkpoint detail. Pair it with a compatible scorer or replace both.",
        ),
      );
    }
    const config = getShotScoringConfig(input.shotType);
    const fix = selectPriorityFix(
      config,
      input.scorerInternal.checkpointResults,
      input.focusCheckpoint
        ? { focusCheckpoint: input.focusCheckpoint as PriorityFix["checkpoint"] }
        : {},
    );
    return ok(fix);
  }
}
