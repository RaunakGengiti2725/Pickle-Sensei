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
 * never fabricates events. Every verdict fails closed, in three layers:
 *
 *  1. structure — `decodeHoldoutLedger` turns untrusted JSON into a typed
 *     ledger or a list of defects; a defective, empty or foreign-policy
 *     ledger is NOT_EVALUABLE (loading it throws a `HoldoutLedgerError`),
 *     which blocks certification exactly like FAIL,
 *  2. tier policy — budgets are looked up through the closed tier list, so
 *     a tier the policy does not govern has no budget to be within and is
 *     UNGOVERNED_TIER (a violation), never WITHIN_BUDGET,
 *  3. designation graph — `auditSuccessorDesignations` checks the
 *     retired→successor edges: a successor must be a designated
 *     SHADOW_HOLDOUT, distinct from the holdout it replaces, not itself a
 *     retired or inspected holdout, and named by at most one retiree.
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

export type HoldoutVerdict = "WITHIN_BUDGET" | "OVER_INSPECTED" | "RETIRED" | "UNGOVERNED_TIER";

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

export type HoldoutLedgerErrorCode =
  "LEDGER_UNREADABLE" | "LEDGER_UNPARSEABLE" | "LEDGER_MALFORMED" | "LEDGER_POLICY_MISMATCH";

export class HoldoutLedgerError extends Error {
  readonly code: HoldoutLedgerErrorCode;
  readonly defects: readonly string[];

  constructor(
    code: HoldoutLedgerErrorCode,
    message: string,
    options: { defects?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "HoldoutLedgerError";
    this.code = code;
    this.defects = options.defects ?? [];
  }
}

export type HoldoutLedgerDecodeResult =
  { ok: true; ledger: HoldoutLedger } | { ok: false; defects: string[] };

export function isHoldoutTier(value: unknown): value is HoldoutTier {
  return typeof value === "string" && (HOLDOUT_TIERS as readonly string[]).includes(value);
}

const HOLDOUT_STATUSES: readonly HoldoutStatus[] = ["ACTIVE", "RETIRED_TO_REGRESSION"];

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defect(path: string, problem: string): string {
  return `holdout ledger: ${path} ${problem}`;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  defects: string[],
  nonEmpty = false,
): void {
  const value = record[key];
  const field = path ? `${path}.${key}` : key;
  if (typeof value !== "string") {
    defects.push(defect(field, `must be a string (got ${describeType(value)})`));
  } else if (nonEmpty && value.trim().length === 0) {
    defects.push(defect(field, "must not be empty"));
  }
}

function requireOneOf(
  record: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly string[],
  defects: string[],
): void {
  const value = record[key];
  if (typeof value !== "string" || !allowed.includes(value)) {
    defects.push(
      defect(
        `${path}.${key}`,
        `must be one of ${allowed.join(" | ")} (got ${JSON.stringify(value)})`,
      ),
    );
  }
}

function requireBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
  defects: string[],
): void {
  const value = record[key];
  if (typeof value !== "boolean") {
    defects.push(defect(`${path}.${key}`, `must be a boolean (got ${describeType(value)})`));
  }
}

function requireCount(
  record: Record<string, unknown>,
  key: string,
  path: string,
  defects: string[],
  min: number,
): void {
  const value = record[key];
  const field = path ? `${path}.${key}` : key;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    defects.push(defect(field, `must be an integer >= ${min} (got ${JSON.stringify(value)})`));
  }
}

function requireArray(value: unknown, path: string, defects: string[]): value is unknown[] {
  if (!Array.isArray(value)) {
    defects.push(defect(path, `must be an array (got ${describeType(value)})`));
    return false;
  }
  return true;
}

function decodeInspection(value: unknown, path: string, defects: string[]): void {
  if (!isRecord(value)) {
    defects.push(defect(path, `must be an inspection event object (got ${describeType(value)})`));
    return;
  }
  requireOneOf(value, "kind", path, INSPECTION_KINDS, defects);
  requireString(value, "dateIso", path, defects, true);
  requireString(value, "workstream", path, defects);
  requireString(value, "evidence", path, defects);
  if (value.artifactFileCount !== undefined) {
    requireCount(value, "artifactFileCount", path, defects, 0);
  }
}

function decodeRetirement(value: unknown, path: string, defects: string[]): void {
  if (value === null) return;
  if (!isRecord(value)) {
    defects.push(defect(path, `must be null or a retirement record (got ${describeType(value)})`));
    return;
  }
  requireString(value, "dateIso", path, defects, true);
  requireString(value, "workstream", path, defects);
  requireString(value, "reason", path, defects);
  requireString(value, "regressionRole", path, defects);
  if (value.successorId !== null) {
    requireString(value, "successorId", path, defects, true);
  }
}

function decodeHoldoutEntry(value: unknown, path: string, defects: string[]): void {
  if (!isRecord(value)) {
    defects.push(defect(path, `must be a holdout entry object (got ${describeType(value)})`));
    return;
  }
  requireString(value, "caseId", path, defects, true);
  requireString(value, "tier", path, defects, true);
  requireOneOf(value, "status", path, HOLDOUT_STATUSES, defects);
  requireString(value, "firstHeldOutAtIso", path, defects, true);
  if (requireArray(value.inspections, `${path}.inspections`, defects)) {
    value.inspections.forEach((inspection, index) =>
      decodeInspection(inspection, `${path}.inspections[${index}]`, defects),
    );
  }
  if (!("retirement" in value)) {
    defects.push(defect(`${path}.retirement`, "must be null or a retirement record (missing)"));
  } else {
    decodeRetirement(value.retirement, `${path}.retirement`, defects);
  }
  requireString(value, "notes", path, defects);
}

function decodeSuccessor(value: unknown, path: string, defects: string[]): void {
  if (!isRecord(value)) {
    defects.push(
      defect(path, `must be a successor designation object (got ${describeType(value)})`),
    );
    return;
  }
  requireString(value, "caseId", path, defects, true);
  requireString(value, "tier", path, defects, true);
  requireString(value, "designatedAtIso", path, defects, true);
  requireString(value, "designationRule", path, defects);
  requireString(value, "registryRef", path, defects);
  requireBoolean(value, "labelBlind", path, defects);
  requireCount(value, "inspectionCount", path, defects, 0);
  requireString(value, "pendingExternal", path, defects);
}

function requireUniqueCaseIds(items: unknown[], path: string, defects: string[]): void {
  const seen = new Map<string, number>();
  for (const item of items) {
    if (isRecord(item) && typeof item.caseId === "string") {
      seen.set(item.caseId, (seen.get(item.caseId) ?? 0) + 1);
    }
  }
  for (const [caseId, count] of seen) {
    if (count > 1) {
      defects.push(
        defect(path, `declares case id '${caseId}' ${count} times — case ids must be unique`),
      );
    }
  }
}

/**
 * Structural decoder for untrusted ledger JSON. Only shape is checked here
 * (types, required fields, closed enums, unique case ids); whether a tier is
 * governed or a successor qualifies is policy and is answered by
 * `evaluateHoldout` / `auditSuccessorDesignations` so it can surface as a
 * BLOCKED reason rather than hide behind NOT_EVALUABLE. Unknown extra keys
 * (e.g. provenance notes) are allowed.
 */
export function decodeHoldoutLedger(input: unknown): HoldoutLedgerDecodeResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      defects: [defect("ledger", `must be a JSON object (got ${describeType(input)})`)],
    };
  }
  const defects: string[] = [];
  requireCount(input, "schemaVersion", "", defects, 1);
  requireString(input, "policyVersion", "", defects, true);
  requireString(input, "generatedAtIso", "", defects, true);
  if (requireArray(input.holdouts, "holdouts", defects)) {
    input.holdouts.forEach((entry, index) =>
      decodeHoldoutEntry(entry, `holdouts[${index}]`, defects),
    );
    requireUniqueCaseIds(input.holdouts, "holdouts", defects);
  }
  if (requireArray(input.successors, "successors", defects)) {
    input.successors.forEach((designation, index) =>
      decodeSuccessor(designation, `successors[${index}]`, defects),
    );
    requireUniqueCaseIds(input.successors, "successors", defects);
  }
  if (defects.length > 0) return { ok: false, defects };
  // Shape is verified above; `tier` is a string whose governed-ness is a
  // policy question left to evaluateHoldout / auditSuccessorDesignations.
  return { ok: true, ledger: input as unknown as HoldoutLedger };
}

function policyVersionDefect(ledger: HoldoutLedger): string | null {
  if (ledger.policyVersion === HOLDOUT_ROTATION_POLICY_VERSION) return null;
  return `holdout ledger policyVersion '${ledger.policyVersion}' does not match ${HOLDOUT_ROTATION_POLICY_VERSION} — it cannot be evaluated under this policy`;
}

export function inspectionCount(entry: HoldoutEntry): number {
  return entry.inspections.length;
}

export function evaluateHoldout(entry: HoldoutEntry): HoldoutEvaluation {
  const defects: string[] = [];
  decodeHoldoutEntry(entry, "holdout", defects);
  if (defects.length > 0) {
    throw new HoldoutLedgerError(
      "LEDGER_MALFORMED",
      `holdout ledger entry is malformed: ${defects.join("; ")}`,
      { defects },
    );
  }
  const count = inspectionCount(entry);
  if (!isHoldoutTier(entry.tier)) {
    return {
      caseId: entry.caseId,
      tier: entry.tier,
      status: entry.status,
      inspectionCount: count,
      budget: 0,
      verdict: "UNGOVERNED_TIER",
      violations: [
        `${entry.caseId}: tier '${String(entry.tier)}' is not a governed tier (${HOLDOUT_TIERS.join(" | ")}) — no inspection budget exists for it, so it can never back a certification claim`,
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

function auditDesignation(
  successor: SuccessorDesignation,
  asHoldout: HoldoutEntry | undefined,
): string[] {
  const findings: string[] = [];
  if (successor.tier !== "SHADOW_HOLDOUT") {
    findings.push(
      `successor ${successor.caseId}: tier '${String(successor.tier)}' is not SHADOW_HOLDOUT — only a shadow holdout may succeed a retired holdout`,
    );
  }
  if (!successor.labelBlind) {
    findings.push(`successor ${successor.caseId} is not label-blind — contaminated, cannot serve`);
  }
  if (successor.inspectionCount !== 0) {
    findings.push(
      `successor ${successor.caseId} has ${successor.inspectionCount} inspections — a successor must start uninspected`,
    );
  }
  if (successor.pendingExternal.trim().length > 0) {
    findings.push(
      `successor ${successor.caseId} pending external step before it can back certification: ${successor.pendingExternal}`,
    );
  }
  if (asHoldout) {
    if (asHoldout.status === "RETIRED_TO_REGRESSION") {
      findings.push(
        `successor ${successor.caseId} is itself a retired (contaminated) holdout — cannot serve as anyone's successor`,
      );
    } else if (asHoldout.tier !== "SHADOW_HOLDOUT") {
      findings.push(
        `successor ${successor.caseId} is registered as an ACTIVE ${String(asHoldout.tier)} holdout — a successor must be a shadow holdout`,
      );
    } else if (inspectionCount(asHoldout) !== 0) {
      findings.push(
        `successor ${successor.caseId} has ${inspectionCount(asHoldout)} recorded inspections in the holdout ledger — a successor must start uninspected`,
      );
    }
  }
  return findings;
}

/**
 * Designation-graph audit over retired→successor edges. Every finding names
 * the offending case id. Expects a structurally decoded ledger.
 */
export function auditSuccessorDesignations(ledger: HoldoutLedger): string[] {
  const findings: string[] = [];
  const holdoutsById = new Map(ledger.holdouts.map((h) => [h.caseId, h]));
  const successorsById = new Map(ledger.successors.map((s) => [s.caseId, s]));
  const retired = ledger.holdouts.filter((h) => h.status === "RETIRED_TO_REGRESSION");
  const claimants = new Map<string, string[]>();

  for (const entry of retired) {
    const successorId = entry.retirement?.successorId ?? null;
    if (!successorId) {
      findings.push(
        `${entry.caseId}: retired without a designated chronological successor — a new holdout must be created before certification claims`,
      );
      continue;
    }
    claimants.set(successorId, [...(claimants.get(successorId) ?? []), entry.caseId]);
    if (successorId === entry.caseId) {
      findings.push(
        `${entry.caseId}: names itself as its own successor — a retired (contaminated) case can never succeed itself`,
      );
      continue;
    }
    if (!successorsById.has(successorId)) {
      findings.push(
        `${entry.caseId}: names successor ${successorId} but no successor designation exists in the ledger`,
      );
    }
  }

  for (const [successorId, retirees] of claimants) {
    if (retirees.length > 1) {
      findings.push(
        `successor ${successorId} is claimed by ${retirees.length} retired holdouts (${retirees.join(", ")}) — a successor replaces exactly one retired holdout`,
      );
    }
  }

  for (const successor of ledger.successors) {
    findings.push(...auditDesignation(successor, holdoutsById.get(successor.caseId)));
  }

  if (retired.length > 0 && ledger.successors.length === 0) {
    findings.push("holdouts were retired but no successor designations exist in the ledger");
  }

  return findings;
}

function notEvaluable(reasons: string[]): CertificationReadiness {
  return { status: "NOT_EVALUABLE", reasons, holdouts: [] };
}

/**
 * Certification claims require:
 *  1. a structurally valid ledger under this policy that governs at least
 *     one holdout (otherwise NOT_EVALUABLE — there is nothing to certify
 *     against),
 *  2. every holdout on a governed tier and no ACTIVE holdout over its
 *     inspection budget,
 *  3. every retired holdout names a designated successor that exists, is a
 *     SHADOW_HOLDOUT, is not the retiree itself, is not a retired or
 *     inspected holdout, and is named by no other retiree,
 *  4. every designated successor is label-blind with zero inspections,
 *  5. at least one successor designation exists once any holdout retired.
 * Anything pendingExternal on a successor keeps the status BLOCKED — the
 * successor exists on paper but has not yet passed the acquisition
 * front-door freeze, so no certification may cite it.
 */
export function evaluateCertificationReadiness(ledger: HoldoutLedger): CertificationReadiness {
  const decoded = decodeHoldoutLedger(ledger);
  if (!decoded.ok) return notEvaluable(decoded.defects);
  const policyDefect = policyVersionDefect(decoded.ledger);
  if (policyDefect) return notEvaluable([policyDefect]);
  if (decoded.ledger.holdouts.length === 0) {
    return notEvaluable([
      "holdout ledger governs no holdouts — there is nothing a certification claim could be measured against; register at least one holdout first",
    ]);
  }

  const evaluations = decoded.ledger.holdouts.map(evaluateHoldout);
  const reasons = evaluations.flatMap((evaluation) => evaluation.violations);
  reasons.push(...auditSuccessorDesignations(decoded.ledger));

  return {
    status: reasons.length === 0 ? "ELIGIBLE" : "BLOCKED",
    reasons,
    holdouts: evaluations,
  };
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function loadHoldoutLedger(repoRoot: string = REPO_ROOT): HoldoutLedger {
  const path = join(repoRoot, HOLDOUT_LEDGER_PATH);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new HoldoutLedgerError(
      "LEDGER_UNREADABLE",
      `holdout ledger could not be read at ${path}: ${describeCause(cause)}`,
      { cause },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new HoldoutLedgerError(
      "LEDGER_UNPARSEABLE",
      `holdout ledger at ${path} is not valid JSON: ${describeCause(cause)}`,
      { cause },
    );
  }
  const decoded = decodeHoldoutLedger(parsed);
  if (!decoded.ok) {
    throw new HoldoutLedgerError(
      "LEDGER_MALFORMED",
      `holdout ledger at ${path} is malformed: ${decoded.defects.join("; ")}`,
      { defects: decoded.defects },
    );
  }
  const policyDefect = policyVersionDefect(decoded.ledger);
  if (policyDefect) throw new HoldoutLedgerError("LEDGER_POLICY_MISMATCH", policyDefect);
  return decoded.ledger;
}
