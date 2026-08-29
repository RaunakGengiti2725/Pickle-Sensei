/**
 * Coach-review types for the admin console.
 *
 * MIRROR of the authoritative schema in packages/swing-lab/src/coachReview.ts
 * (v2). The runtime contract between the two is the emitted JSON under
 * datasets/coach-review/ (queue.json, schema.json, taxonomy, drills): the UI
 * loads those artifacts and REFUSES to operate when schemaVersion differs
 * from EXPECTED_SCHEMA_VERSION, so the mirror cannot silently drift.
 */

export const EXPECTED_SCHEMA_VERSION = 2 as const;

export type QualityValue = 1 | 2 | 3 | 4 | 5;
export type Severity = 1 | 2 | 3;

export interface FaultDefinition {
  id: string;
  name: string;
  description: string;
  observableEvidence: string;
  typicalPhase: "preparation" | "acceleration" | "contact" | "follow_through" | "recovery" | "any";
}

export interface FaultFamily {
  family: string;
  displayName: string;
  faults: FaultDefinition[];
}

export interface FaultTaxonomy {
  version: string;
  status: string;
  strokeTaxonomyVersion: string;
  strokeFamilyByV3Label: Record<string, string>;
  families: FaultFamily[];
}

export interface DrillEntry {
  id: string;
  name: string;
  supportedTechniques: string[];
  validatedFaultMappings: Array<{ faultId: string; evidence: string[] }>;
  description: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  equipment: string[];
  repsOrDuration: string;
  progressions: string[];
  regressions: string[];
  coachProvenance: null | { coachId: string; credentialRef: string; endorsedAtIso: string };
  provenance: string;
  validationStatus: "UNVALIDATED" | "COACH_VALIDATED";
  mediaRefs: string[];
  version: string;
}

export interface DrillLibrary {
  version: string;
  status: string;
  drills: DrillEntry[];
}

export interface QueueItem {
  queueItemId: string;
  eventRef: { caseId: string; eventIndex: number };
  video: string;
  windowMs: { start: number; end: number };
  contactMs: number | null;
  annotatedStrokeV3: string | null;
  strokeFamily: string;
  relevantFaultFamilies: string[];
  bundle: {
    role: string;
    annotatorId: string;
    revision: number;
    analyzable: boolean;
    notAnalyzableReason: string | null;
    annotatorConfidence: number;
    contactUncertainty: string | null;
    phases: Record<string, number | null>;
    eventNote: string | null;
  };
  replayCommand: string;
  reviewTemplate: string;
  requiredReviewsTarget: number;
  existingReviews: string[];
}

export interface QueueManifest {
  schemaVersion: number;
  generatedAtIso: string;
  status: string;
  program: Record<string, string>;
  artifacts: Record<string, string>;
  queue: QueueItem[];
}

export interface SchemaDescriptor {
  schemaVersion: number;
  generatedAtIso: string;
  reviewRecord: {
    typescriptSource: string;
    storage: string;
    reviewIdRule: string;
    requiredFields: string[];
  };
  strokeTaxonomy: { version: string; labels: string[] };
  qualityScale: { id: string; status: string; anchors: Record<string, string> };
  severityScale: Record<string, string>;
  confidenceSemantics: string;
  cannotEvaluateSemantics: string;
  faultTaxonomyVersion: string;
  drillLibraryVersion: string;
}

export interface CoachRegistryEntry {
  coachId: string;
  credentialRef: string;
  status: "active" | "suspended";
  provisionedAtIso: string;
  provisionedBy: string;
}

export interface CoachRegistry {
  schemaVersion: number;
  note: string;
  coaches: CoachRegistryEntry[];
}

export type StrokeConfirmation =
  | { kind: "confirmed"; stroke: string }
  | { kind: "corrected"; stroke: string; note: string }
  | { kind: "cannot_judge"; reason: string };

export interface FaultEntry {
  faultId: string;
  severity: Severity;
  evidence: {
    timestampsMs: number[];
    region: { x: number; y: number; w: number; h: number } | null;
  };
  rationale: string;
}

export interface CoachReview {
  schemaVersion: typeof EXPECTED_SCHEMA_VERSION;
  reviewId: string;
  queueItemId: string;
  coachId: string;
  coachCredentialRef: string;
  eventRef: { caseId: string; eventIndex: number };
  strokeTaxonomyVersion: string;
  faultTaxonomyVersion: string;
  drillLibraryVersion: string | null;
  strokeConfirmation: StrokeConfirmation;
  overallQuality: { scaleId: string; value: QualityValue } | null;
  faults: FaultEntry[];
  drillSuggestions: Array<{ drillId: string | null; freeText: string }>;
  confidence: number;
  cannotEvaluate: { reason: string } | null;
  rationale: string;
  createdAtIso: string;
  submittedAtIso: string;
}

/** A review as returned by GET /api/coach-reviews (real, persisted files) or
 * injected by the synthetic dev fixture (never persisted, always flagged). */
export interface LoadedReview {
  review: CoachReview;
  /** File path for real reviews; "SYNTHETIC-FIXTURE" for dev-mode fixtures. */
  source: string;
  synthetic: boolean;
}

export function queueItemIdFor(caseId: string, eventIndex: number): string {
  return `${caseId}-E${eventIndex + 1}`;
}

export function reviewIdFor(queueItemId: string, coachId: string): string {
  return `${queueItemId}.${coachId}`;
}
