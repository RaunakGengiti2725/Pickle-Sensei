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
 *
 * The ledger is also the single source of truth for which case ids the lab
 * tools must never read, score, or direct labeling effort at:
 * `deriveHeldOutCaseIds` / `loadHeldOutCaseIds` (retired holdouts plus every
 * LOCKED_TEST / SHADOW_HOLDOUT holdout and successor). Tools consume that set
 * instead of hand-copied id lists, so a newly designated successor is
 * protected the moment it lands in the ledger.
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
export const INSPECTION_BUDGETS: Readonly<Record<HoldoutTier, number>> = Object.freeze({
  DEV: Number.POSITIVE_INFINITY,
  VALIDATION: Number.POSITIVE_INFINITY,
  LOCKED_TEST: 3,
  SHADOW_HOLDOUT: 0,
});

export function isHoldoutTier(value: unknown): value is HoldoutTier {
  return typeof value === "string" && (HOLDOUT_TIERS as readonly string[]).includes(value);
}

/** Tiers whose cases are held out of tuning, labeling, and benchmarking. */
export const PROTECTED_TIERS: ReadonlySet<HoldoutTier> = new Set<HoldoutTier>([
  "LOCKED_TEST",
  "SHADOW_HOLDOUT",
]);

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

export const HOLDOUT_STATUSES = ["ACTIVE", "RETIRED_TO_REGRESSION"] as const;
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

export type HoldoutVerdict = "WITHIN_BUDGET" | "OVER_INSPECTED" | "RETIRED" | "INVALID_TIER";

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

export type HoldoutLedgerErrorCode = "MISSING" | "UNPARSABLE" | "MALFORMED";

/** Governance failure of the ledger itself: it cannot be read or is not a ledger. */
export class HoldoutLedgerError extends Error {
  readonly code: HoldoutLedgerErrorCode;
  readonly reasons: readonly string[];

  constructor(code: HoldoutLedgerErrorCode, message: string, reasons: readonly string[] = []) {
    super(message);
    this.name = "HoldoutLedgerError";
    this.code = code;
    this.reasons = reasons;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes].sort();
}

function holdoutEntryProblems(value: unknown, index: number): string[] {
  const where = `holdouts[${index}]`;
  if (!isRecord(value)) return [`${where}: not an object`];
  const problems: string[] = [];
  if (!isNonEmptyString(value.caseId)) problems.push(`${where}: caseId must be a non-empty string`);
  if (!isNonEmptyString(value.tier)) problems.push(`${where}: tier must be a non-empty string`);
  if (!(HOLDOUT_STATUSES as readonly unknown[]).includes(value.status)) {
    problems.push(`${where}: status must be one of ${HOLDOUT_STATUSES.join(", ")}`);
  }
  if (!Array.isArray(value.inspections)) {
    problems.push(`${where}: inspections must be an array of inspection events`);
  } else {
    value.inspections.forEach((event, eventIndex) => {
      if (!isRecord(event)) problems.push(`${where}.inspections[${eventIndex}]: not an object`);
    });
  }
  if (value.retirement !== null) {
    if (!isRecord(value.retirement)) {
      problems.push(`${where}: retirement must be null or a retirement record`);
    } else if (
      value.retirement.successorId !== null &&
      !isNonEmptyString(value.retirement.successorId)
    ) {
      problems.push(`${where}: retirement.successorId must be null or a non-empty string`);
    }
  }
  return problems;
}

function successorProblems(value: unknown, index: number): string[] {
  const where = `successors[${index}]`;
  if (!isRecord(value)) return [`${where}: not an object`];
  const problems: string[] = [];
  if (!isNonEmptyString(value.caseId)) problems.push(`${where}: caseId must be a non-empty string`);
  if (!isNonEmptyString(value.tier)) problems.push(`${where}: tier must be a non-empty string`);
  if (typeof value.labelBlind !== "boolean")
    problems.push(`${where}: labelBlind must be a boolean`);
  if (
    typeof value.inspectionCount !== "number" ||
    !Number.isInteger(value.inspectionCount) ||
    value.inspectionCount < 0
  ) {
    problems.push(`${where}: inspectionCount must be a non-negative integer`);
  }
  if (typeof value.pendingExternal !== "string") {
    problems.push(`${where}: pendingExternal must be a string (empty when nothing is pending)`);
  }
  return problems;
}

export type LedgerValidation =
  { ok: true; ledger: HoldoutLedger } | { ok: false; problems: string[] };

/**
 * Structural validation of a parsed ledger. Anything that fails here is not
 * a ledger under this policy and can never be evaluated — the caller reports
 * NOT_EVALUABLE (or throws HoldoutLedgerError) rather than guessing.
 */
export function validateHoldoutLedger(input: unknown): LedgerValidation {
  if (!isRecord(input)) {
    return {
      ok: false,
      problems: [
        `ledger must be a JSON object, got ${input === null ? "null" : Array.isArray(input) ? "array" : typeof input}`,
      ],
    };
  }
  const problems: string[] = [];
  if (input.policyVersion !== HOLDOUT_ROTATION_POLICY_VERSION) {
    problems.push(
      `ledger policyVersion '${String(input.policyVersion)}' is not ${HOLDOUT_ROTATION_POLICY_VERSION}`,
    );
  }
  if (!Array.isArray(input.holdouts)) {
    problems.push("ledger holdouts must be an array of holdout entries");
  } else {
    input.holdouts.forEach((entry, index) => problems.push(...holdoutEntryProblems(entry, index)));
  }
  if (!Array.isArray(input.successors)) {
    problems.push("ledger successors must be an array of successor designations");
  } else {
    input.successors.forEach((designation, index) =>
      problems.push(...successorProblems(designation, index)),
    );
  }
  if (problems.length > 0) return { ok: false, problems };

  const ledger = input as unknown as HoldoutLedger;
  for (const id of duplicates(ledger.holdouts.map((entry) => entry.caseId))) {
    problems.push(`holdout case id ${id} appears more than once in the ledger`);
  }
  for (const id of duplicates(ledger.successors.map((designation) => designation.caseId))) {
    problems.push(`successor case id ${id} is designated more than once in the ledger`);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, ledger };
}

export function inspectionCount(entry: HoldoutEntry): number {
  return entry.inspections.length;
}

export function evaluateHoldout(entry: HoldoutEntry): HoldoutEvaluation {
  const count = inspectionCount(entry);
  if (!isHoldoutTier(entry.tier)) {
    return {
      caseId: entry.caseId,
      tier: entry.tier,
      status: entry.status,
      inspectionCount: count,
      budget: Number.NaN,
      verdict: "INVALID_TIER",
      violations: [
        `${entry.caseId}: tier '${String(entry.tier)}' is not one of ${HOLDOUT_TIERS.join(", ")} — no inspection budget exists for it, so it cannot back a certification claim`,
      ],
    };
  }
  const budget = INSPECTION_BUDGETS[entry.tier];
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
 *  1. a structurally valid ledger under this policy with at least one holdout
 *     (anything else is NOT_EVALUABLE — never ELIGIBLE),
 *  2. every holdout on a known tier and no ACTIVE holdout over its budget,
 *  3. every retired holdout names a designated successor,
 *  4. every designated successor is a SHADOW_HOLDOUT that is label-blind with
 *     zero inspections, distinct from the retiree it succeeds, not shared
 *     between retirees, and not itself a retired holdout,
 *  5. at least one successor designation exists once any holdout retired.
 * Anything pendingExternal on a successor keeps the status BLOCKED — the
 * successor exists on paper but has not yet passed the acquisition
 * front-door freeze, so no certification may cite it.
 */
export function evaluateCertificationReadiness(input: unknown): CertificationReadiness {
  const validation = validateHoldoutLedger(input);
  if (!validation.ok) {
    return { status: "NOT_EVALUABLE", reasons: validation.problems, holdouts: [] };
  }
  const ledger = validation.ledger;
  if (ledger.holdouts.length === 0) {
    return {
      status: "NOT_EVALUABLE",
      reasons: [
        "ledger declares no holdouts — there is nothing a certification claim could be measured against",
      ],
      holdouts: [],
    };
  }

  const evaluations = ledger.holdouts.map(evaluateHoldout);
  const reasons: string[] = [];

  for (const evaluation of evaluations) {
    reasons.push(...evaluation.violations);
  }

  const successorsById = new Map(ledger.successors.map((s) => [s.caseId, s]));
  const retired = ledger.holdouts.filter((h) => h.status === "RETIRED_TO_REGRESSION");
  const retiredIds = new Set(retired.map((entry) => entry.caseId));
  const retireesBySuccessor = new Map<string, string[]>();
  for (const entry of retired) {
    const successorId = entry.retirement?.successorId ?? null;
    if (successorId) {
      retireesBySuccessor.set(successorId, [
        ...(retireesBySuccessor.get(successorId) ?? []),
        entry.caseId,
      ]);
    }
  }
  for (const [successorId, retirees] of retireesBySuccessor) {
    if (retirees.length > 1) {
      reasons.push(
        `successor ${successorId} is shared by ${retirees.length} retired holdouts (${retirees.join(", ")}) — one successor cannot serve more than one retiree`,
      );
    }
  }

  for (const entry of retired) {
    const successorId = entry.retirement?.successorId ?? null;
    if (!successorId) {
      reasons.push(
        `${entry.caseId}: retired without a designated chronological successor — a new holdout must be created before certification claims`,
      );
      continue;
    }
    if (successorId === entry.caseId) {
      reasons.push(
        `${entry.caseId}: names itself as its own successor — a retired holdout cannot succeed itself`,
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
    if (retiredIds.has(successor.caseId)) {
      reasons.push(
        `successor ${successor.caseId} is itself a retired holdout — a contaminated case cannot succeed ${entry.caseId}`,
      );
    }
    if (successor.tier !== "SHADOW_HOLDOUT") {
      reasons.push(
        `successor ${successor.caseId} is tier ${String(successor.tier)} — a successor must be SHADOW_HOLDOUT until its freeze`,
      );
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

/**
 * Loads and validates the ledger. A file that is absent, not JSON, or not a
 * ledger under this policy raises HoldoutLedgerError (MISSING / UNPARSABLE /
 * MALFORMED) naming the ledger path, so callers can report NOT_EVALUABLE
 * instead of leaking a raw ENOENT or SyntaxError.
 */
export function loadHoldoutLedger(repoRoot: string = REPO_ROOT): HoldoutLedger {
  const ledgerPath = join(repoRoot, HOLDOUT_LEDGER_PATH);
  let raw: string;
  try {
    raw = readFileSync(ledgerPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    throw new HoldoutLedgerError(
      "MISSING",
      `holdout ledger ${HOLDOUT_LEDGER_PATH} is missing under ${repoRoot} (${code}) — certification is NOT_EVALUABLE without it`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new HoldoutLedgerError(
      "UNPARSABLE",
      `holdout ledger ${HOLDOUT_LEDGER_PATH} is not valid JSON: ${error.message}`,
    );
  }
  const validation = validateHoldoutLedger(parsed);
  if (!validation.ok) {
    throw new HoldoutLedgerError(
      "MALFORMED",
      `holdout ledger ${HOLDOUT_LEDGER_PATH} is not a ${HOLDOUT_ROTATION_POLICY_VERSION} ledger: ${validation.problems.join("; ")}`,
      validation.problems,
    );
  }
  return validation.ledger;
}

/** Certification readiness of the committed ledger; a missing or malformed ledger is NOT_EVALUABLE. */
export function loadCertificationReadiness(repoRoot: string = REPO_ROOT): CertificationReadiness {
  let ledger: HoldoutLedger;
  try {
    ledger = loadHoldoutLedger(repoRoot);
  } catch (error) {
    if (!(error instanceof HoldoutLedgerError)) throw error;
    return { status: "NOT_EVALUABLE", reasons: [error.message, ...error.reasons], holdouts: [] };
  }
  return evaluateCertificationReadiness(ledger);
}

export interface HeldOutCaseIds {
  /** Retired holdouts: contaminated, regression fixtures only — never tuned or labeled against. */
  retired: ReadonlySet<string>;
  /** ACTIVE LOCKED_TEST / SHADOW_HOLDOUT holdouts and LOCKED_TEST / SHADOW_HOLDOUT successors. */
  protected: ReadonlySet<string>;
  /** Union of the two: every case id no lab tool may read, score, or queue. */
  all: ReadonlySet<string>;
}

/**
 * The single ledger-derived held-out set. Retired holdouts stay excluded
 * (their labels leaked into development), and every LOCKED_TEST or
 * SHADOW_HOLDOUT case — active holdout or designated successor — is protected
 * because one benchmark evaluation or label already spends its budget.
 * DEV / VALIDATION cases are not held out.
 */
export function deriveHeldOutCaseIds(ledger: HoldoutLedger): HeldOutCaseIds {
  const validation = validateHoldoutLedger(ledger);
  if (!validation.ok) {
    throw new HoldoutLedgerError(
      "MALFORMED",
      `cannot derive held-out case ids from a malformed ledger: ${validation.problems.join("; ")}`,
      validation.problems,
    );
  }
  const retired = new Set<string>();
  const protectedIds = new Set<string>();
  for (const entry of validation.ledger.holdouts) {
    if (entry.status === "RETIRED_TO_REGRESSION") retired.add(entry.caseId);
    else if (isHoldoutTier(entry.tier) && PROTECTED_TIERS.has(entry.tier)) {
      protectedIds.add(entry.caseId);
    }
  }
  for (const designation of validation.ledger.successors) {
    if (isHoldoutTier(designation.tier) && PROTECTED_TIERS.has(designation.tier)) {
      protectedIds.add(designation.caseId);
    }
  }
  return { retired, protected: protectedIds, all: new Set([...retired, ...protectedIds]) };
}

export function loadHeldOutCaseIds(repoRoot: string = REPO_ROOT): HeldOutCaseIds {
  return deriveHeldOutCaseIds(loadHoldoutLedger(repoRoot));
}
