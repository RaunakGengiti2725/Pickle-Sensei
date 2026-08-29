import type { ShotAnalysis } from "@pickle/shared-types";
import type { StrokeResolution } from "./capture.js";
import type { ModelRunRecord } from "./provenance.js";
import type { AnalysisRunProvenance } from "./runProvenance.js";

/**
 * Versioned analysis record. A capture may accumulate many of these over its
 * lifetime — one per (engine, model set) that ever processed it. Records are
 * immutable; reprocessing appends, never overwrites.
 */

export const ANALYSIS_RECORD_SCHEMA_VERSION = 1 as const;

/** Which modalities the engine actually had for this run. */
export interface ModalityAvailability {
  pose: boolean;
  paddle: boolean;
  ball: boolean;
  court: boolean;
  camera: boolean;
}

/**
 * A traceable link from a coaching claim back to the concrete frames,
 * measurements, and model outputs that produced it.
 */
export interface EvidenceRef {
  /** Machine-readable claim key, e.g. "checkpoint:contact_position". */
  claim: string;
  window: { startMs: number; endMs: number } | null;
  metricKeys: string[];
  /** providerId of the model whose output grounds this claim. */
  producedByProviderId: string;
  confidence: number;
}

export interface DetectedFault {
  /** Stable fault code, e.g. "contact_position.late". */
  code: string;
  checkpoint: string;
  direction: string;
  /** 0..1. */
  severity: number;
  confidence: number;
  evidence: EvidenceRef[];
}

export interface UncertaintySummary {
  /** Overall analysis confidence 0..1. */
  analysisConfidence: number;
  presentation: "normal" | "lower_confidence" | "abstain";
  /** Per-checkpoint confidence, keyed by checkpoint. */
  perCheckpoint: Record<string, number>;
  /** Why confidence is reduced, when it is. */
  limitingFactors: string[];
}

export interface AnalysisRecord {
  schemaVersion: typeof ANALYSIS_RECORD_SCHEMA_VERSION;
  id: string;
  captureId: string;
  createdAtIso: string;
  /** Fusion engine identity, independent of any single model version. */
  engineVersion: string;
  strokeTaxonomyVersion: string;
  strokeResolution: StrokeResolution;
  modalities: ModalityAvailability;
  /** Every model execution that fed this record, with provenance. */
  modelRuns: ModelRunRecord[];
  /**
   * Complete run-level version snapshot (app, pipeline, providers, score,
   * taxonomy, drill mapping, capture envelope, timestamp) — the record must
   * remain explainable from storage alone. Operational metadata: never
   * rendered in the user-facing mobile UI.
   */
  provenance: AnalysisRunProvenance;
  /**
   * The scored result in the shared product shape (versionVector included).
   * Null when the engine abstained before scoring.
   */
  result: ShotAnalysis | null;
  faults: DetectedFault[];
  uncertainty: UncertaintySummary;
  evidence: EvidenceRef[];
  /**
   * Shadow-model outcomes: candidate models run on the same input without
   * affecting the user-facing result, recorded for offline comparison.
   */
  shadow: Array<{
    run: ModelRunRecord;
    overallScore: number | null;
    analysisConfidence: number | null;
  }>;
}
