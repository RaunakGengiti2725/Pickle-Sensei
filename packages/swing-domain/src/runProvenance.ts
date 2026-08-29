import { fail, failure, ok, type Result } from "@pickle/shared-types";
import type { AnalysisRecord } from "./analysis.js";
import type { ModelRef, ModelRunRecord, ModelTask } from "./provenance.js";

/**
 * Run-level provenance — the complete, self-contained version snapshot every
 * AnalysisRecord carries so a Result remains explainable months later from
 * the stored record alone: no live registry, provider bundle, or code
 * archaeology required.
 *
 * This block is operational/audit metadata. It is stored with the record and
 * readable by lab/admin tooling; it is never rendered in the user-facing
 * mobile UI.
 */

/** Recorded when no capture-envelope verdict was measured for the attempt. */
export const CAPTURE_ENVELOPE_VERSION_NOT_MEASURED = "capture-envelope-not-measured" as const;

/** Recorded when no technique profile resolved, so no drill mapping applies. */
export const DRILL_MAPPING_VERSION_UNRESOLVED = "drill-mapping-profile-unresolved" as const;

export interface AnalysisRunProvenance {
  /** Application build that initiated the run. */
  appVersion: string;
  /** Fusion pipeline identity, e.g. "fusion-1". */
  pipelineVersion: string;
  /**
   * Every distinct provider/model that participated in the run: input
   * producers (pose, paddle, trigger) plus every provider the engine
   * executed. Deduplicated by providerId@modelVersion.
   */
  providerVersions: readonly ModelRef[];
  /**
   * Version of the technique scorer configured for this run (the scorer's
   * descriptor modelVersion). Recorded even when the run abstained before
   * scoring — it identifies the scorer that WOULD have produced the score.
   */
  scoreVersion: string;
  /** Stroke taxonomy the run classified against. */
  taxonomyVersion: string;
  /**
   * Drill mapping version carried by the resolved technique profile, or
   * DRILL_MAPPING_VERSION_UNRESOLVED when no profile resolved.
   */
  drillMappingVersion: string;
  /**
   * Threshold-set version of the capture-envelope verdict measured for the
   * attempt, or CAPTURE_ENVELOPE_VERSION_NOT_MEASURED.
   */
  captureEnvelopeVersion: string;
  /** When this snapshot was recorded — identical to the record's createdAtIso. */
  recordedAtIso: string;
}

/** One model execution, as reconstructed from the stored record. */
export interface ModelExecutionTrace {
  task: ModelTask;
  providerId: string;
  modelVersion: string;
  runtime: string;
  status: ModelRunRecord["status"];
  startedAtIso: string;
  completedAtIso: string;
}

/**
 * Everything needed to explain a Result, reconstructed from a stored
 * AnalysisRecord alone.
 */
export interface AnalysisRunExplanation {
  analysisId: string;
  captureId: string;
  recordedAtIso: string;
  versions: AnalysisRunProvenance;
  executions: readonly ModelExecutionTrace[];
  scored: boolean;
  overallScore: number | null;
}

const PROVENANCE_STRING_FIELDS = [
  "appVersion",
  "pipelineVersion",
  "scoreVersion",
  "taxonomyVersion",
  "drillMappingVersion",
  "captureEnvelopeVersion",
  "recordedAtIso",
] as const;

function providerKey(model: ModelRef): string {
  return `${model.providerId}@${model.modelVersion}`;
}

/**
 * Reconstruct the full explanation of an analysis run from its stored record
 * alone. Fails (never guesses) when the record's provenance is absent or
 * incomplete, or when a recorded model execution is not covered by the
 * provenance snapshot — an old record must either explain itself completely
 * or be reported as unexplainable.
 */
export function explainAnalysisRun(record: AnalysisRecord): Result<AnalysisRunExplanation> {
  // Runtime presence check: records serialized before this field existed
  // arrive typed but without the block. They are honestly unexplainable.
  const provenance = (record as Partial<AnalysisRecord>).provenance;
  if (provenance === undefined || provenance === null) {
    return fail(
      failure(
        "permanent",
        "provenance.missing",
        `Record ${record.id} carries no run provenance; its result cannot be explained from storage alone.`,
      ),
    );
  }
  const empty = PROVENANCE_STRING_FIELDS.filter(
    (field) => typeof provenance[field] !== "string" || provenance[field].length === 0,
  );
  if (empty.length > 0) {
    return fail(
      failure(
        "permanent",
        "provenance.incomplete",
        `Record ${record.id} provenance is missing: ${empty.join(", ")}.`,
      ),
    );
  }
  if (Number.isNaN(Date.parse(provenance.recordedAtIso))) {
    return fail(
      failure(
        "permanent",
        "provenance.invalid_timestamp",
        `Record ${record.id} provenance timestamp "${provenance.recordedAtIso}" is not a valid ISO instant.`,
      ),
    );
  }
  if (!Array.isArray(provenance.providerVersions) || provenance.providerVersions.length === 0) {
    return fail(
      failure(
        "permanent",
        "provenance.no_providers",
        `Record ${record.id} provenance lists no provider versions.`,
      ),
    );
  }

  const known = new Set(provenance.providerVersions.map(providerKey));
  const untracked = record.modelRuns.filter((run) => !known.has(providerKey(run.model)));
  if (untracked.length > 0) {
    return fail(
      failure(
        "permanent",
        "provenance.model_run_untracked",
        `Record ${record.id} has model runs outside the provenance snapshot: ${untracked
          .map((run) => providerKey(run.model))
          .join(", ")}.`,
      ),
    );
  }

  if (record.result) {
    const vector = record.result.versionVector;
    if (vector.appVersion !== provenance.appVersion) {
      return fail(
        failure(
          "permanent",
          "provenance.version_vector_mismatch",
          `Record ${record.id}: result appVersion "${vector.appVersion}" disagrees with provenance appVersion "${provenance.appVersion}".`,
        ),
      );
    }
    if (vector.scoringModelVersion !== provenance.scoreVersion) {
      return fail(
        failure(
          "permanent",
          "provenance.version_vector_mismatch",
          `Record ${record.id}: result scoringModelVersion "${vector.scoringModelVersion}" disagrees with provenance scoreVersion "${provenance.scoreVersion}".`,
        ),
      );
    }
  }

  return ok({
    analysisId: record.id,
    captureId: record.captureId,
    recordedAtIso: provenance.recordedAtIso,
    versions: provenance,
    executions: record.modelRuns.map((run) => ({
      task: run.task,
      providerId: run.model.providerId,
      modelVersion: run.model.modelVersion,
      runtime: run.model.runtime,
      status: run.status,
      startedAtIso: run.startedAtIso,
      completedAtIso: run.completedAtIso,
    })),
    scored: record.result !== null && record.result.resultKind === "scored",
    overallScore: record.result?.overallScore ?? null,
  });
}
