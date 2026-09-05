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
 * Every verdict here fails closed: an ungoverned tier, an unreadable entry,
 * or a successor that does not satisfy the designation rules can only
 * lower the status, never leave it ELIGIBLE.
 */

export const HOLDOUT_LEDGER_PATH = "datasets/holdouts/ledger.json" as const;
export const HOLDOUT_ROTATION_POLICY_VERSION = "holdout-rotation-v1" as const;

export const HOLDOUT_TIERS = ["DEV", "VALIDATION", "LOCKED_TEST", "SHADOW_HOLDOUT"] as const;
export type HoldoutTier = (typeof HOLDOUT_TIERS)[number];

export const HOLDOUT_STATUSES = ["ACTIVE", "RETIRED_TO_REGRESSION"] as const;

/** Only this tier may be designated as a successor: it is the sole tier frozen at zero inspections. */
export const SUCCESSOR_TIER: HoldoutTier = "SHADOW_HOLDOUT";

export function isHoldoutTier(value: unknown): value is HoldoutTier {
  return typeof value === "string" && (HOLDOUT_TIERS as readonly string[]).includes(value);
}

/**
 * Raised by loadHoldoutLedger for every failure mode — missing file,
 * unreadable file, invalid JSON, wrong policy, malformed shape — so callers
 * never see a raw fs/JSON error masquerading as a governance verdict.
 */
export class HoldoutLedgerError extends Error {
  readonly code = "HOLDOUT_LEDGER_INVALID" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(`holdout ledger: ${message}`, options);
    this.name = "HoldoutLedgerError";
  }
}

/**
 * Frozen per-tier inspection budgets (inclusive maximums). DEV and
 * VALIDATION exist for iteration, so their budgets are effectively
 * unbounded; LOCKED_TEST tolerates a small number of audited evaluations;
 * SHADOW_HOLDOUT must never be inspected at all before its freeze.
 */
export const INSPECTION_BUDGETS: Readonly<Record<HoldoutTier, number>> = Object.freeze({
  DEV: Number.POSITIVE_INFINITY,
  VALIDATION: Number.POSITIVE_INFINITY,
  LOCKED_TEST: 3,
  SHADOW_HOLDOUT: 0,
});

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

export type HoldoutStatus = (typeof HOLDOUT_STATUSES)[number];

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

/**
 * INVALID marks an entry the policy cannot govern (ungoverned tier, unknown
 * status, inspections that are not a list). Such an entry has a budget of 0
 * and always blocks certification.
 */
export type HoldoutVerdict = "WITHIN_BUDGET" | "OVER_INSPECTED" | "RETIRED" | "INVALID";

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
  return Array.isArray(entry.inspections) ? entry.inspections.length : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Policy-level problems with one entry: things the ledger shape allows but
 * the rotation policy cannot govern. Each one makes the entry INVALID.
 */
function entryPolicyViolations(entry: HoldoutEntry): string[] {
  const violations: string[] = [];
  if (!isHoldoutTier(entry.tier)) {
    violations.push(
      `${entry.caseId}: tier '${String(entry.tier)}' is not a governed holdout tier (${HOLDOUT_TIERS.join(" | ")}) — no inspection budget exists for it`,
    );
  }
  if (!(HOLDOUT_STATUSES as readonly string[]).includes(entry.status)) {
    violations.push(
      `${entry.caseId}: status '${String(entry.status)}' is not a governed holdout status (${HOLDOUT_STATUSES.join(" | ")})`,
    );
  }
  if (!Array.isArray(entry.inspections)) {
    violations.push(`${entry.caseId}: inspections must be a list of ledger events`);
  }
  if (entry.retirement !== null && !isRecord(entry.retirement)) {
    violations.push(`${entry.caseId}: retirement must be null or a retirement record`);
  }
  return violations;
}

export function evaluateHoldout(entry: HoldoutEntry): HoldoutEvaluation {
  const violations = entryPolicyViolations(entry);
  const count = inspectionCount(entry);
  if (violations.length > 0) {
    return {
      caseId: entry.caseId,
      tier: entry.tier,
      status: entry.status,
      inspectionCount: count,
      budget: 0,
      verdict: "INVALID",
      violations,
    };
  }
  const budget = INSPECTION_BUDGETS[entry.tier];
  const overBudget = count > budget;
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
 * Shape problems that make a value unusable as a ledger at all. Anything
 * listed here means the policy cannot be evaluated — the caller must report
 * NOT_EVALUABLE (or refuse to load), never ELIGIBLE.
 */
export function holdoutLedgerShapeProblems(value: unknown): string[] {
  if (!isRecord(value)) {
    return ["ledger must be a JSON object"];
  }
  const problems: string[] = [];
  if (value.policyVersion !== HOLDOUT_ROTATION_POLICY_VERSION) {
    problems.push(
      `policyVersion '${String(value.policyVersion)}' does not match ${HOLDOUT_ROTATION_POLICY_VERSION}`,
    );
  }
  if (!Array.isArray(value.holdouts)) {
    problems.push("holdouts must be an array of holdout entries");
  } else {
    value.holdouts.forEach((entry, index) => {
      if (!isRecord(entry) || typeof entry.caseId !== "string" || entry.caseId.length === 0) {
        problems.push(`holdouts[${index}] must be an object with a non-empty caseId`);
      } else if (!Array.isArray(entry.inspections)) {
        problems.push(`holdouts[${index}] (${entry.caseId}) must list its inspections as an array`);
      }
    });
  }
  if (!Array.isArray(value.successors)) {
    problems.push("successors must be an array of successor designations");
  } else {
    value.successors.forEach((designation, index) => {
      if (
        !isRecord(designation) ||
        typeof designation.caseId !== "string" ||
        designation.caseId.length === 0
      ) {
        problems.push(`successors[${index}] must be an object with a non-empty caseId`);
      }
    });
  }
  return problems;
}

/**
 * Certification claims require:
 *  1. a readable ledger that governs at least one holdout,
 *  2. every holdout on a governed tier and within its inspection budget
 *     (or honestly retired),
 *  3. every retired holdout names a designated successor that exists, is a
 *     SHADOW_HOLDOUT, is label-blind with zero inspections, is not the
 *     retired case itself, is not a retired holdout, and is claimed by no
 *     other retired holdout,
 *  4. at least one successor designation exists once any holdout retired.
 * Anything pendingExternal on a successor keeps the status BLOCKED — the
 * successor exists on paper but has not yet passed the acquisition
 * front-door freeze, so no certification may cite it.
 */
export function evaluateCertificationReadiness(ledger: HoldoutLedger): CertificationReadiness {
  const shapeProblems = holdoutLedgerShapeProblems(ledger);
  if (shapeProblems.length > 0) {
    return {
      status: "NOT_EVALUABLE",
      reasons: shapeProblems.map((problem) => `holdout ledger is malformed: ${problem}`),
      holdouts: [],
    };
  }
  if (ledger.holdouts.length === 0) {
    return {
      status: "NOT_EVALUABLE",
      reasons: [
        "holdout ledger governs no holdouts — there is no held-out evidence a certification claim could rest on",
      ],
      holdouts: [],
    };
  }

  const evaluations = ledger.holdouts.map(evaluateHoldout);
  const reasons: string[] = [];

  for (const evaluation of evaluations) {
    reasons.push(...evaluation.violations);
  }

  const holdoutsById = new Map<string, HoldoutEntry>();
  for (const entry of ledger.holdouts) {
    if (holdoutsById.has(entry.caseId)) {
      reasons.push(`${entry.caseId}: listed more than once among the holdouts`);
    }
    holdoutsById.set(entry.caseId, entry);
  }

  const successorsById = new Map<string, SuccessorDesignation>();
  for (const designation of ledger.successors) {
    if (successorsById.has(designation.caseId)) {
      reasons.push(`successor ${designation.caseId}: designated more than once`);
    }
    successorsById.set(designation.caseId, designation);
  }

  const retired = ledger.holdouts.filter((h) => h.status === "RETIRED_TO_REGRESSION");
  const claimants = new Map<string, string[]>();
  for (const entry of retired) {
    const successorId = isRecord(entry.retirement) ? entry.retirement.successorId : null;
    if (typeof successorId !== "string" || successorId.length === 0) {
      reasons.push(
        `${entry.caseId}: retired without a designated chronological successor — a new holdout must be created before certification claims`,
      );
      continue;
    }
    claimants.set(successorId, [...(claimants.get(successorId) ?? []), entry.caseId]);
    if (successorId === entry.caseId) {
      reasons.push(
        `${entry.caseId}: names itself as its successor — a retired holdout can never succeed itself`,
      );
    }
    const successor = successorsById.get(successorId);
    if (!successor) {
      reasons.push(
        `${entry.caseId}: names successor ${successorId} but no successor designation exists in the ledger`,
      );
      continue;
    }
    if (successor.tier !== SUCCESSOR_TIER) {
      reasons.push(
        `successor ${successor.caseId} is tier '${String(successor.tier)}' — only ${SUCCESSOR_TIER} may serve as a successor`,
      );
    }
    const asHoldout = holdoutsById.get(successor.caseId);
    if (asHoldout && asHoldout.status === "RETIRED_TO_REGRESSION") {
      reasons.push(
        `${entry.caseId}: names successor ${successor.caseId}, which is itself a retired (contaminated) holdout`,
      );
    } else if (asHoldout && inspectionCount(asHoldout) > 0) {
      reasons.push(
        `${entry.caseId}: names successor ${successor.caseId}, which already has ${inspectionCount(asHoldout)} recorded inspections as a holdout`,
      );
    }
    if (successor.labelBlind !== true) {
      reasons.push(`successor ${successor.caseId} is not label-blind — contaminated, cannot serve`);
    }
    if (successor.inspectionCount !== 0) {
      reasons.push(
        `successor ${successor.caseId} has ${successor.inspectionCount} inspections — a successor must start uninspected`,
      );
    }
    if (typeof successor.pendingExternal !== "string") {
      reasons.push(
        `successor ${successor.caseId} has no pendingExternal statement — cannot prove the external step is complete`,
      );
    } else if (successor.pendingExternal.trim().length > 0) {
      reasons.push(
        `successor ${successor.caseId} pending external step before it can back certification: ${successor.pendingExternal}`,
      );
    }
  }

  for (const [successorId, holdoutIds] of claimants) {
    if (holdoutIds.length > 1) {
      reasons.push(
        `successor ${successorId} is claimed by ${holdoutIds.length} retired holdouts (${holdoutIds.join(", ")}) — each retired holdout needs its own successor`,
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
  const path = join(repoRoot, HOLDOUT_LEDGER_PATH);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new HoldoutLedgerError(`cannot read ${path} (${describeError(error)})`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HoldoutLedgerError(`${path} is not valid JSON (${describeError(error)})`, {
      cause: error,
    });
  }
  const problems = holdoutLedgerShapeProblems(parsed);
  if (problems.length > 0) {
    throw new HoldoutLedgerError(`${path} is malformed: ${problems.join("; ")}`);
  }
  return parsed as HoldoutLedger;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
