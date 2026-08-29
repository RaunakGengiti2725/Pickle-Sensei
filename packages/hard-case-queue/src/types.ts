/**
 * Production hard-case queue (Wave I, workstream i10-hard-case-queue).
 *
 * A hard case is a single production incident worth human attention: a user
 * complaint, a shadow/champion disagreement, an abstention where none was
 * expected, a capture-envelope failure, a red-team finding, an anomaly.
 * The queue guarantees that once a report is ingested it can never be
 * silently dropped: every ingest is either a new entry, a merge into an
 * existing entry (dedup), or a regression reopen of a resolved entry — and
 * the ledger accounts for all three.
 */

/** Where a hard-case report came from. */
export const HARD_CASE_SOURCES = [
  "user_feedback",
  "shadow_disagreement",
  "model_disagreement",
  "high_uncertainty",
  "unexpected_abstention",
  "capture_envelope_failure",
  "coach_disagreement",
  "red_team",
  "anomaly",
] as const;
export type HardCaseSource = (typeof HARD_CASE_SOURCES)[number];

/**
 * Which subsystem a case is routed to. TARGET/EVENT/PADDLE/OWNERSHIP/BALL/
 * CONTACT/PHASE/STROKE/AUTO are the analysis-cascade stages; CAPTURE covers
 * the capture envelope, SESSION covers session assembly/certification,
 * COACHING covers feedback/drill output, OTHER is the explicit triage bucket
 * for cases that cannot be routed yet (never a reason to drop).
 */
export const HARD_CASE_CATEGORIES = [
  "TARGET",
  "EVENT",
  "PADDLE",
  "OWNERSHIP",
  "BALL",
  "CONTACT",
  "PHASE",
  "STROKE",
  "AUTO",
  "CAPTURE",
  "SESSION",
  "COACHING",
  "OTHER",
] as const;
export type HardCaseCategory = (typeof HARD_CASE_CATEGORIES)[number];

/** Lifecycle: new → triaged → in-review → resolved | regression. */
export const HARD_CASE_STATES = ["new", "triaged", "in-review", "resolved", "regression"] as const;
export type HardCaseState = (typeof HARD_CASE_STATES)[number];

export const HARD_CASE_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type HardCaseSeverity = (typeof HARD_CASE_SEVERITIES)[number];

/** One piece of evidence attached to a case; append-only, never rewritten. */
export interface HardCaseEvidence {
  source: HardCaseSource;
  /** Committed artifact / telemetry record / feedback id backing this report. */
  ref: string;
  detail: string;
  observedAtIso: string;
}

/**
 * A raw report submitted to the queue. `subjectKey` identifies WHAT failed
 * (recordingId, sessionKey, bundleId, trialId, …) and drives dedup together
 * with source + category; two reports about the same subject from the same
 * source for the same subsystem are one case.
 */
export interface HardCaseReport {
  source: HardCaseSource;
  subjectKey: string;
  severity: HardCaseSeverity;
  evidence: HardCaseEvidence;
  /** Optional explicit routing override (validated, never coerced). */
  categoryHint?: HardCaseCategory;
  /** Optional cascade-stage name from telemetry (e.g. "TARGET", "BALL"). */
  stageHint?: string;
}

export interface HardCaseEntry {
  id: string;
  fingerprint: string;
  source: HardCaseSource;
  category: HardCaseCategory;
  subjectKey: string;
  state: HardCaseState;
  /** Highest severity seen across all merged reports. */
  severity: HardCaseSeverity;
  occurrenceCount: number;
  evidence: HardCaseEvidence[];
  createdAtIso: string;
  updatedAtIso: string;
  /** Times this case recurred after being resolved. */
  regressionCount: number;
  history: HardCaseTransitionRecord[];
}

export interface HardCaseTransitionRecord {
  from: HardCaseState;
  to: HardCaseState;
  actor: string;
  note: string;
  atIso: string;
}

export type IngestOutcome = "created" | "merged" | "regression_reopened";

/** Append-only persistence events; a queue is the replay of its log. */
export type HardCaseEvent =
  | {
      seq: number;
      type: "ingested";
      atIso: string;
      report: HardCaseReport;
      outcome: IngestOutcome;
      entryId: string;
    }
  | {
      seq: number;
      type: "transitioned";
      atIso: string;
      entryId: string;
      from: HardCaseState;
      to: HardCaseState;
      actor: string;
      note: string;
    };

/** Accounting ledger: ingested must equal created + merged + reopened. */
export interface HardCaseLedger {
  ingested: number;
  created: number;
  merged: number;
  regressionReopened: number;
}
