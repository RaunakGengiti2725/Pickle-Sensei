import type { Severity } from "./severity.js";

/**
 * Typed incident records. An incident is an append-only history: the current
 * state is derived from the ordered timeline, and evidence entries are never
 * removed or rewritten.
 */

export const FAILURE_CLASSES = [
  "confident_wrong_coaching_at_scale",
  "privacy_breach",
  "data_corruption",
  "queue_stall",
  "camera_regression",
  "other",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * Response steps. Each severity requires an ordered subset of these
 * (see stateMachine.ts). "declared" is the initial state, "closed" terminal.
 */
export const RESPONSE_STEPS = [
  "declared",
  "rollout_halted",
  "feature_disabled",
  "rolled_back",
  "evidence_preserved",
  "investigating",
  "fix_in_progress",
  "validating",
  "postmortem",
  "closed",
] as const;
export type ResponseStep = (typeof RESPONSE_STEPS)[number];

export const DETECTION_SOURCES = [
  "monitoring_alert",
  "release_gate",
  "user_report",
  "coach_report",
  "internal_review",
  "red_team",
] as const;
export type DetectionSource = (typeof DETECTION_SOURCES)[number];

export interface EvidenceEntry {
  /** ISO-8601 UTC timestamp of when the evidence was captured. */
  capturedAt: string;
  /** What the evidence is — a log excerpt, query result, artifact path, metric snapshot. */
  description: string;
  /** Where the raw evidence lives (path, URL, ticket id); null when inline in description. */
  location: string | null;
}

export interface TimelineEntry {
  /** ISO-8601 UTC timestamp of when the step was completed. */
  at: string;
  step: ResponseStep;
  /** Who performed the step. */
  actor: string;
  /** What was actually done — commands run, flags flipped, versions rolled back to. */
  note: string;
}

export interface Incident {
  id: string;
  severity: Severity;
  failureClass: FailureClass;
  title: string;
  detectionSource: DetectionSource;
  /** ISO-8601 UTC timestamp of first detection. */
  detectedAt: string;
  /** Affected surface: feature flag keys, model ids, endpoints, tables. */
  affectedSurfaces: string[];
  /** Ordered, append-only record of completed response steps. */
  timeline: TimelineEntry[];
  /** Append-only evidence log; entries are added, never mutated. */
  evidence: EvidenceEntry[];
  /** Path or URL of the postmortem document; null until written. */
  postmortemRef: string | null;
}

export interface DeclareIncidentInput {
  id: string;
  severity: Severity;
  failureClass: FailureClass;
  title: string;
  detectionSource: DetectionSource;
  detectedAt: string;
  affectedSurfaces: string[];
  declaredBy: string;
  note: string;
}

export function declareIncident(input: DeclareIncidentInput): Incident {
  return {
    id: input.id,
    severity: input.severity,
    failureClass: input.failureClass,
    title: input.title,
    detectionSource: input.detectionSource,
    detectedAt: input.detectedAt,
    affectedSurfaces: [...input.affectedSurfaces],
    timeline: [
      { at: input.detectedAt, step: "declared", actor: input.declaredBy, note: input.note },
    ],
    evidence: [],
    postmortemRef: null,
  };
}

export function currentStep(incident: Incident): ResponseStep {
  const last = incident.timeline[incident.timeline.length - 1];
  if (!last) throw new Error(`incident ${incident.id} has an empty timeline`);
  return last.step;
}

export function addEvidence(incident: Incident, entry: EvidenceEntry): Incident {
  return { ...incident, evidence: [...incident.evidence, entry] };
}
