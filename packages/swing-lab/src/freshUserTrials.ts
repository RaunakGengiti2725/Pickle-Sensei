import {
  SILENT_FAILURE_EVENT_KINDS,
  validateEvaluationTrial,
  type EvaluationTrialRecord,
  type SilentFailureEventKind,
} from "@pickle/shared-types";
import { detectTriageSignals, type TriageSignalSummary } from "./triageSignals.js";

/**
 * FRESH-USER TRIAL ANALYSIS — the evaluation-pipeline end of the on-device
 * telemetry path (Wave G2 h07).
 *
 * Trials arrive from devices carrying CLAIMS and abstentions only. Humans
 * label each claimed trial against gold (same discipline as
 * silentFailure.ts); this module then counts the six explicit silent-failure
 * event kinds — never an aggregate accuracy that hides them — and derives
 * learning-curve independence coverage (users / sessions / courts / devices
 * / events) so "it works" claims are tied to genuinely independent evidence.
 *
 * Held-out cases never enter this path: trials come from live devices, not
 * the corpus; the frozen-test discipline lives in the runbook.
 */

/** Human label for ONE claim of ONE trial, produced against gold off-device. */
export type TrialClaimLabel = "correct" | "wrong" | "abstained" | "unverifiable" | "not_labeled";

export const LABELABLE_CLAIMS = [
  "targetLock",
  "eventSelection",
  "strokeLabel",
  "contactMarker",
  "phaseRender",
] as const;
export type LabelableClaim = (typeof LABELABLE_CLAIMS)[number];

/** Which silent-failure event a wrong PRESENTED claim produces. */
export const CLAIM_TO_EVENT: Record<LabelableClaim, SilentFailureEventKind> = {
  targetLock: "WRONG_TARGET",
  eventSelection: "WRONG_EVENT",
  strokeLabel: "WRONG_STROKE",
  contactMarker: "FALSE_CONTACT",
  phaseRender: "IMPOSSIBLE_PHASE",
};

export interface TrialLabel {
  trialId: string;
  /** Human labeler identity — required; anonymous labels are rejected. */
  labelerId: string;
  labeledAtIso: string;
  claims: Record<LabelableClaim, TrialClaimLabel>;
}

export interface TrialIngestResult {
  accepted: EvaluationTrialRecord[];
  rejected: Array<{ index: number; errors: string[] }>;
}

/** Structural ingest: invalid records are rejected with reasons, never
 * repaired. Duplicate trialIds keep the first occurrence only. */
export function ingestTrials(records: unknown[]): TrialIngestResult {
  const accepted: EvaluationTrialRecord[] = [];
  const rejected: Array<{ index: number; errors: string[] }> = [];
  const seen = new Set<string>();
  records.forEach((record, index) => {
    const verdict = validateEvaluationTrial(record);
    if (!verdict.ok) {
      rejected.push({ index, errors: verdict.errors });
      return;
    }
    const trial = record as EvaluationTrialRecord;
    if (seen.has(trial.trialId)) {
      rejected.push({ index, errors: ["trialId: duplicate"] });
      return;
    }
    seen.add(trial.trialId);
    accepted.push(trial);
  });
  return { accepted, rejected };
}

export interface SilentFailureCounts {
  /** Per explicit event kind — never collapsed into one number. */
  byEvent: Record<SilentFailureEventKind, number>;
  /** Denominators per claim: how many trials PRESENTED the claim and were
   * labeled (correct + wrong). Abstentions/unverifiable are excluded. */
  labeledPresentedByClaim: Record<LabelableClaim, number>;
  trialsLabeled: number;
  trialsUnlabeled: number;
}

/**
 * Count explicit silent-failure events from human labels.
 *
 * Rules:
 * - Only claims the device recorded as "presented" can silent-fail; an
 *   abstention is never a failure.
 * - "unverifiable" and "not_labeled" claims enter NO denominator.
 * - FALSE_HIGH_CONFIDENCE_RESULT is the product-level compound: a Result
 *   presented at normal confidence in a trial where any material claim was
 *   labeled wrong.
 */
export function countSilentFailures(
  trials: EvaluationTrialRecord[],
  labels: TrialLabel[],
): SilentFailureCounts {
  const byId = new Map(labels.map((label) => [label.trialId, label]));
  const byEvent = Object.fromEntries(SILENT_FAILURE_EVENT_KINDS.map((kind) => [kind, 0])) as Record<
    SilentFailureEventKind,
    number
  >;
  const labeledPresentedByClaim = Object.fromEntries(
    LABELABLE_CLAIMS.map((claim) => [claim, 0]),
  ) as Record<LabelableClaim, number>;
  let trialsLabeled = 0;
  let trialsUnlabeled = 0;

  for (const trial of trials) {
    const label = byId.get(trial.trialId);
    if (!label || !label.labelerId) {
      trialsUnlabeled++;
      continue;
    }
    trialsLabeled++;
    let anyWrong = false;
    for (const claim of LABELABLE_CLAIMS) {
      if (trial.claims[claim].status !== "presented") continue;
      const verdict = label.claims[claim];
      if (verdict === "correct" || verdict === "wrong") {
        labeledPresentedByClaim[claim]++;
      }
      if (verdict === "wrong") {
        byEvent[CLAIM_TO_EVENT[claim]]++;
        anyWrong = true;
      }
    }
    if (
      anyWrong &&
      trial.claims.resultScore.status === "presented" &&
      trial.claims.resultScore.presentation === "normal"
    ) {
      byEvent.FALSE_HIGH_CONFIDENCE_RESULT++;
    }
  }
  return { byEvent, labeledPresentedByClaim, trialsLabeled, trialsUnlabeled };
}

export interface IndependenceCoverage {
  /** Distinct non-null values per dimension. Null values are counted as
   * unknown, never merged into one pseudo-identity. */
  users: number;
  sessions: number;
  courts: number;
  devices: number;
  /** Total trial events. */
  events: number;
  unknown: { users: number; sessions: number; courts: number; devices: number };
}

/** Independence coverage for learning-curve honesty: how many genuinely
 * distinct users/sessions/courts/devices the trial evidence spans. */
export function independenceCoverage(trials: EvaluationTrialRecord[]): IndependenceCoverage {
  const users = new Set<string>();
  const sessions = new Set<string>();
  const courts = new Set<string>();
  const devices = new Set<string>();
  const unknown = { users: 0, sessions: 0, courts: 0, devices: 0 };
  for (const trial of trials) {
    const { userPseudonym, sessionId, courtId, deviceModel } = trial.dims;
    if (userPseudonym === null) unknown.users++;
    else users.add(userPseudonym);
    if (sessionId === null) unknown.sessions++;
    else sessions.add(sessionId);
    if (courtId === null) unknown.courts++;
    else courts.add(courtId);
    if (deviceModel === null) unknown.devices++;
    else devices.add(deviceModel);
  }
  return {
    users: users.size,
    sessions: sessions.size,
    courts: courts.size,
    devices: devices.size,
    events: trials.length,
    unknown,
  };
}

export interface FreshUserReport {
  generatedAtIso: string;
  trialCount: number;
  outcomes: Record<string, number>;
  silentFailures: SilentFailureCounts;
  /** Machine-detected inconsistency signals routed to human triage. Never
   * labels, never verdicts, never merged into silentFailures. */
  triage: TriageSignalSummary;
  coverage: IndependenceCoverage;
  userFlagCounts: Record<string, number>;
}

/** One honest report per labeling pass: explicit failure counts, coverage,
 * and outcome mix — no single aggregate accuracy anywhere. */
export function buildFreshUserReport(
  trials: EvaluationTrialRecord[],
  labels: TrialLabel[],
  nowIso: () => string = () => new Date().toISOString(),
): FreshUserReport {
  const outcomes: Record<string, number> = {};
  const userFlagCounts: Record<string, number> = {};
  for (const trial of trials) {
    outcomes[trial.outcomeKind] = (outcomes[trial.outcomeKind] ?? 0) + 1;
    for (const flag of trial.userFlags) {
      userFlagCounts[flag] = (userFlagCounts[flag] ?? 0) + 1;
    }
  }
  return {
    generatedAtIso: nowIso(),
    trialCount: trials.length,
    outcomes,
    silentFailures: countSilentFailures(trials, labels),
    triage: detectTriageSignals(trials),
    coverage: independenceCoverage(trials),
    userFlagCounts,
  };
}
