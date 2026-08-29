import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";

/**
 * I14 fresh-holdout rotation governance.
 *
 * A holdout only measures generalization while nobody has looked at it.
 * Every inspection — a human viewing frames, a committed label, a failure
 * dossier, or repeated benchmark evaluation with threshold iteration —
 * leaks information into development and erodes the holdout's evidential
 * value. This module makes that erosion explicit and enforceable:
 *
 *  - every governed case carries a tier (DEV / VALIDATION / LOCKED_TEST /
 *    SHADOW_HOLDOUT) with a frozen per-tier inspection budget,
 *  - every inspection is a ledger event with kind, date, workstream, and
 *    artifact evidence (no anonymous count bumps),
 *  - a holdout whose inspection count exceeds its tier budget is
 *    OVER_INSPECTED and MUST be retired into the regression suite —
 *    it can never again back a certification claim,
 *  - certification claims are blocked until every retired holdout has a
 *    designated chronological successor that is itself uninspected and
 *    label-blind, and at least one such successor exists.
 *
 * The ledger (datasets/holdouts/ledger.json) is data, not code: this module
 * never fabricates events, and the checker treats a missing or malformed
 * ledger as NOT_EVALUABLE, which blocks certification exactly like FAIL.
 */

export const HOLDOUT_LEDGER_PATH = "datasets/holdouts/ledger.json" as const;
export const HOLDOUT_ROTATION_POLICY_VERSION = "holdout-rotation-v1" as const;

export const HOLDOUT_TIERS = ["DEV", "VALIDATION", "LOCKED_TEST", "SHADOW_HOLDOUT"] as const;
export type HoldoutTier = (typeof HOLDOUT_TIERS)[number];

/**
 * Frozen per-tier inspection budgets (inclusive maximums). DEV and
 * VALIDATION exist for iteration, so their budgets are effectively
 * unbounded; LOCKED_TEST tolerates a small number of audited evaluations;
 * SHADOW_HOLDOUT must never be inspected at all before its freeze.
 */
export const INSPECTION_BUDGETS: Readonly<Record<HoldoutTier, number>> = {
  DEV: Number.POSITIVE_INFINITY,
  VALIDATION: Number.POSITIVE_INFINITY,
  LOCKED_TEST: 3,
  SHADOW_HOLDOUT: 0,
};

export const INSPECTION_KINDS = [
  "human_frame_review",
  "committed_label",
  "failure_dossier",
  "benchmark_evaluation",
  "threshold_iteration",
] as const;
export type InspectionKind = (typeof INSPECTION_KINDS)[number];

export interface InspectionEvent {
  kind: InspectionKind;
  dateIso: string;
  workstream: string;
  /** Repo-relative artifact path(s) or evidence description proving the event. */
  evidence: string;
  /** For benchmark_evaluation events: how many distinct artifact files reference the case. */
  artifactFileCount?: number;
}

export type HoldoutStatus = "ACTIVE" | "RETIRED_TO_REGRESSION";

export interface RetirementRecord {
  dateIso: string;
  workstream: string;
  reason: string;
  /** Where the retired case now lives as a regression fixture. */
  regressionRole: string;
  /** Case id of the designated chronological successor, if one exists. */
  successorId: string | null;
}

export interface HoldoutEntry {
  caseId: string;
  tier: HoldoutTier;
  status: HoldoutStatus;
  firstHeldOutAtIso: string;
  inspections: InspectionEvent[];
  retirement: RetirementRecord | null;
  notes: string;
}

export interface SuccessorDesignation {
  caseId: string;
  tier: HoldoutTier;
  designatedAtIso: string;
  /** Deterministic, content-blind rule used to pick this successor. */
  designationRule: string;
  /** Registry section proving the clip is still label-blind. */
  registryRef: string;
  labelBlind: boolean;
  inspectionCount: number;
  /** What must still happen before this successor can back a certification. */
  pendingExternal: string;
}

export interface HoldoutLedger {
  schemaVersion: number;
  policyVersion: string;
  generatedAtIso: string;
  holdouts: HoldoutEntry[];
  successors: SuccessorDesignation[];
}

export type HoldoutVerdict = "WITHIN_BUDGET" | "OVER_INSPECTED" | "RETIRED";

export interface HoldoutEvaluation {
  caseId: string;
  tier: HoldoutTier;
  status: HoldoutStatus;
  inspectionCount: number;
  budget: number;
  verdict: HoldoutVerdict;
  /** Violations that make the entry non-compliant with rotation policy. */
  violations: string[];
}

export type CertificationStatus = "ELIGIBLE" | "BLOCKED" | "NOT_EVALUABLE";

export interface CertificationReadiness {
  status: CertificationStatus;
  reasons: string[];
  holdouts: HoldoutEvaluation[];
}

export function inspectionCount(entry: HoldoutEntry): number {
  return entry.inspections.length;
}

export function evaluateHoldout(entry: HoldoutEntry): HoldoutEvaluation {
  const budget = INSPECTION_BUDGETS[entry.tier];
  const count = inspectionCount(entry);
  const overBudget = count > budget;
  const violations: string[] = [];
  let verdict: HoldoutVerdict;
  if (entry.status === "RETIRED_TO_REGRESSION") {
    verdict = "RETIRED";
    if (!entry.retirement) {
      violations.push(`${entry.caseId}: retired status without a retirement record`);
    }
  } else if (overBudget) {
    verdict = "OVER_INSPECTED";
    violations.push(
      `${entry.caseId}: ${count} inspections exceed the ${entry.tier} budget of ${budget} — must be retired to regression before any certification claim`,
    );
  } else {
    verdict = "WITHIN_BUDGET";
  }
  return {
    caseId: entry.caseId,
    tier: entry.tier,
    status: entry.status,
    inspectionCount: count,
    budget,
    verdict,
    violations,
  };
}

/**
 * Certification claims require:
 *  1. no ACTIVE holdout over its inspection budget,
 *  2. every retired holdout names a designated successor,
 *  3. every designated successor is label-blind with zero inspections,
 *  4. at least one successor designation exists once any holdout retired.
 * Anything pendingExternal on a successor keeps the status BLOCKED — the
 * successor exists on paper but has not yet passed the acquisition
 * front-door freeze, so no certification may cite it.
 */
export function evaluateCertificationReadiness(ledger: HoldoutLedger): CertificationReadiness {
  const evaluations = ledger.holdouts.map(evaluateHoldout);
  const reasons: string[] = [];

  for (const evaluation of evaluations) {
    reasons.push(...evaluation.violations);
  }

  const successorsById = new Map(ledger.successors.map((s) => [s.caseId, s]));
  const retired = ledger.holdouts.filter((h) => h.status === "RETIRED_TO_REGRESSION");
  for (const entry of retired) {
    const successorId = entry.retirement?.successorId ?? null;
    if (!successorId) {
      reasons.push(
        `${entry.caseId}: retired without a designated chronological successor — a new holdout must be created before certification claims`,
      );
      continue;
    }
    const successor = successorsById.get(successorId);
    if (!successor) {
      reasons.push(
        `${entry.caseId}: names successor ${successorId} but no successor designation exists in the ledger`,
      );
      continue;
    }
    if (!successor.labelBlind) {
      reasons.push(`successor ${successor.caseId} is not label-blind — contaminated, cannot serve`);
    }
    if (successor.inspectionCount !== 0) {
      reasons.push(
        `successor ${successor.caseId} has ${successor.inspectionCount} inspections — a successor must start uninspected`,
      );
    }
    if (successor.pendingExternal.trim().length > 0) {
      reasons.push(
        `successor ${successor.caseId} pending external step before it can back certification: ${successor.pendingExternal}`,
      );
    }
  }

  if (retired.length > 0 && ledger.successors.length === 0) {
    reasons.push("holdouts were retired but no successor designations exist in the ledger");
  }

  return {
    status: reasons.length === 0 ? "ELIGIBLE" : "BLOCKED",
    reasons,
    holdouts: evaluations,
  };
}

export function loadHoldoutLedger(repoRoot: string = REPO_ROOT): HoldoutLedger {
  const raw = readFileSync(join(repoRoot, HOLDOUT_LEDGER_PATH), "utf8");
  const parsed = JSON.parse(raw) as HoldoutLedger;
  if (parsed.policyVersion !== HOLDOUT_ROTATION_POLICY_VERSION) {
    throw new Error(
      `holdout ledger policyVersion '${parsed.policyVersion}' does not match ${HOLDOUT_ROTATION_POLICY_VERSION}`,
    );
  }
  return parsed;
}
