import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { extname, join, relative, sep } from "node:path";
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

/**
 * A ledger read from disk by `loadHoldoutLedger` remembers which repo root
 * it came from, so the committed-artifact cross-check can scan that same
 * tree without the caller having to thread the path through.
 */
export interface LoadedHoldoutLedger extends HoldoutLedger {
  readonly sourceRepoRoot: string;
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

/** Committed files under datasets/ that name a case the ledger claims is uninspected. */
export interface ArtifactExposure {
  caseId: string;
  /** Repo-relative paths, sorted, deduplicated. */
  files: string[];
}

export interface CertificationReadiness {
  status: CertificationStatus;
  reasons: string[];
  holdouts: HoldoutEvaluation[];
  /**
   * Which repo tree (if any) was scanned for artifacts contradicting a
   * successor's self-declared inspectionCount, and what was found. `repoRoot`
   * is null when the ledger was built in memory and no `repoRoot` option was
   * passed — the self-declared counts were then taken at face value.
   */
  artifactScan: { repoRoot: string | null; exposures: ArtifactExposure[] };
}

export interface CertificationOptions {
  /**
   * Repo root whose datasets/ tree is scanned for committed artifacts naming
   * a successor. Defaults to the root a `loadHoldoutLedger` ledger came from.
   * Pass `null` to skip the scan explicitly.
   */
  repoRoot?: string | null;
}

/* ------------------------------------------------------------------------ *
 * Typed governance errors
 * ------------------------------------------------------------------------ */

export type HoldoutLedgerErrorCode =
  "LEDGER_MISSING" | "LEDGER_UNREADABLE" | "LEDGER_NOT_JSON" | "LEDGER_MALFORMED" | "ENTRY_INVALID";

/**
 * Every failure to obtain or interpret the ledger surfaces as this error
 * (never a raw fs ENOENT or JSON SyntaxError), so callers can map it to the
 * NOT_EVALUABLE governance verdict instead of a runtime crash.
 */
export class HoldoutLedgerError extends Error {
  readonly code: HoldoutLedgerErrorCode;
  readonly problems: readonly string[];

  constructor(
    code: HoldoutLedgerErrorCode,
    message: string,
    problems: readonly string[] = [],
    cause?: unknown,
  ) {
    super(problems.length > 0 ? `${message}: ${problems.join("; ")}` : message, { cause });
    this.name = "HoldoutLedgerError";
    this.code = code;
    this.problems = [...problems];
  }
}

/* ------------------------------------------------------------------------ *
 * Shape validation — the ledger is untrusted data
 * ------------------------------------------------------------------------ */

export const HOLDOUT_LEDGER_SCHEMA_VERSION = 1 as const;
export const HOLDOUT_STATUSES = ["ACTIVE", "RETIRED_TO_REGRESSION"] as const;

export function isHoldoutTier(value: unknown): value is HoldoutTier {
  return typeof value === "string" && (HOLDOUT_TIERS as readonly string[]).includes(value);
}

function isHoldoutStatus(value: unknown): value is HoldoutStatus {
  return typeof value === "string" && (HOLDOUT_STATUSES as readonly string[]).includes(value);
}

function isInspectionKind(value: unknown): value is InspectionKind {
  return typeof value === "string" && (INSPECTION_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateInspectionEvent(raw: unknown, path: string): string[] {
  if (!isRecord(raw))
    return [`${path}: expected an inspection event object, got ${describeValue(raw)}`];
  const problems: string[] = [];
  if (!isInspectionKind(raw.kind)) {
    problems.push(
      `${path}.kind: '${String(raw.kind)}' is not one of ${INSPECTION_KINDS.join("|")}`,
    );
  }
  for (const field of ["dateIso", "workstream", "evidence"] as const) {
    if (typeof raw[field] !== "string") {
      problems.push(`${path}.${field}: expected a string, got ${describeValue(raw[field])}`);
    }
  }
  if (raw.artifactFileCount !== undefined && !Number.isInteger(raw.artifactFileCount)) {
    problems.push(`${path}.artifactFileCount: expected an integer when present`);
  }
  return problems;
}

/** Shape problems for one holdout entry (empty array = well-formed). */
export function validateHoldoutEntry(raw: unknown, path = "holdout"): string[] {
  if (!isRecord(raw))
    return [`${path}: expected a holdout entry object, got ${describeValue(raw)}`];
  const problems: string[] = [];
  const label = isNonEmptyString(raw.caseId) ? `${path}(${raw.caseId})` : path;
  if (!isNonEmptyString(raw.caseId)) problems.push(`${path}.caseId: expected a non-empty string`);
  if (!isHoldoutTier(raw.tier)) {
    problems.push(
      `${label}.tier: '${String(raw.tier)}' is not a known tier (${HOLDOUT_TIERS.join("|")}) — no inspection budget exists for it`,
    );
  }
  if (!isHoldoutStatus(raw.status)) {
    problems.push(
      `${label}.status: '${String(raw.status)}' is not one of ${HOLDOUT_STATUSES.join("|")}`,
    );
  }
  if (typeof raw.firstHeldOutAtIso !== "string") {
    problems.push(`${label}.firstHeldOutAtIso: expected a string`);
  }
  if (!Array.isArray(raw.inspections)) {
    problems.push(`${label}.inspections: expected an array, got ${describeValue(raw.inspections)}`);
  } else {
    raw.inspections.forEach((event, index) => {
      problems.push(...validateInspectionEvent(event, `${label}.inspections[${index}]`));
    });
  }
  if (raw.retirement !== null) {
    if (!isRecord(raw.retirement)) {
      problems.push(
        `${label}.retirement: expected null or a retirement record, got ${describeValue(raw.retirement)}`,
      );
    } else {
      for (const field of ["dateIso", "workstream", "reason", "regressionRole"] as const) {
        if (typeof raw.retirement[field] !== "string") {
          problems.push(`${label}.retirement.${field}: expected a string`);
        }
      }
      const successorId = raw.retirement.successorId;
      if (successorId !== null && !isNonEmptyString(successorId)) {
        problems.push(`${label}.retirement.successorId: expected null or a non-empty string`);
      }
    }
  }
  if (typeof raw.notes !== "string") problems.push(`${label}.notes: expected a string`);
  return problems;
}

/** Shape problems for one successor designation (empty array = well-formed). */
export function validateSuccessorDesignation(raw: unknown, path = "successor"): string[] {
  if (!isRecord(raw)) {
    return [`${path}: expected a successor designation object, got ${describeValue(raw)}`];
  }
  const problems: string[] = [];
  const label = isNonEmptyString(raw.caseId) ? `${path}(${raw.caseId})` : path;
  if (!isNonEmptyString(raw.caseId)) problems.push(`${path}.caseId: expected a non-empty string`);
  if (!isHoldoutTier(raw.tier)) {
    problems.push(
      `${label}.tier: '${String(raw.tier)}' is not a known tier (${HOLDOUT_TIERS.join("|")})`,
    );
  }
  for (const field of [
    "designatedAtIso",
    "designationRule",
    "registryRef",
    "pendingExternal",
  ] as const) {
    if (typeof raw[field] !== "string") {
      problems.push(`${label}.${field}: expected a string, got ${describeValue(raw[field])}`);
    }
  }
  if (typeof raw.labelBlind !== "boolean") {
    problems.push(`${label}.labelBlind: expected a boolean, got ${describeValue(raw.labelBlind)}`);
  }
  if (!Number.isInteger(raw.inspectionCount) || (raw.inspectionCount as number) < 0) {
    problems.push(
      `${label}.inspectionCount: expected a non-negative integer, got ${String(raw.inspectionCount)}`,
    );
  }
  return problems;
}

/**
 * Structural problems that make a ledger un-evaluable (empty array = the
 * value is a well-formed `HoldoutLedger`). Semantic problems — over-budget
 * holdouts, bad successors — are `evaluateCertificationReadiness` reasons,
 * not shape problems.
 */
export function validateHoldoutLedger(raw: unknown): string[] {
  if (!isRecord(raw)) {
    return [
      `ledger: expected an object with schemaVersion, policyVersion, holdouts and successors, got ${describeValue(raw)}`,
    ];
  }
  const problems: string[] = [];
  if (raw.schemaVersion !== HOLDOUT_LEDGER_SCHEMA_VERSION) {
    problems.push(
      `ledger.schemaVersion: expected ${HOLDOUT_LEDGER_SCHEMA_VERSION}, got ${String(raw.schemaVersion)}`,
    );
  }
  if (raw.policyVersion !== HOLDOUT_ROTATION_POLICY_VERSION) {
    problems.push(
      `ledger.policyVersion: '${String(raw.policyVersion)}' does not match ${HOLDOUT_ROTATION_POLICY_VERSION}`,
    );
  }
  if (typeof raw.generatedAtIso !== "string") {
    problems.push(`ledger.generatedAtIso: expected a string`);
  }
  if (!Array.isArray(raw.holdouts)) {
    problems.push(`ledger.holdouts: expected an array, got ${describeValue(raw.holdouts)}`);
  } else {
    raw.holdouts.forEach((entry, index) => {
      problems.push(...validateHoldoutEntry(entry, `ledger.holdouts[${index}]`));
    });
  }
  if (!Array.isArray(raw.successors)) {
    problems.push(`ledger.successors: expected an array, got ${describeValue(raw.successors)}`);
  } else {
    raw.successors.forEach((designation, index) => {
      problems.push(...validateSuccessorDesignation(designation, `ledger.successors[${index}]`));
    });
  }
  return problems;
}

export function isHoldoutLedger(raw: unknown): raw is HoldoutLedger {
  return validateHoldoutLedger(raw).length === 0;
}

function sourceRepoRootOf(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const root = input.sourceRepoRoot;
  return typeof root === "string" && root.length > 0 ? root : null;
}

/* ------------------------------------------------------------------------ *
 * Per-holdout evaluation
 * ------------------------------------------------------------------------ */

export function inspectionCount(entry: HoldoutEntry): number {
  return entry.inspections.length;
}

/**
 * Evaluates one holdout against its frozen tier budget. Throws a typed
 * `HoldoutLedgerError` (code ENTRY_INVALID) for an entry with an unknown
 * tier or malformed shape — an undefined budget must never compare as
 * "within budget".
 */
export function evaluateHoldout(entry: HoldoutEntry): HoldoutEvaluation {
  const problems = validateHoldoutEntry(entry);
  if (problems.length > 0) {
    throw new HoldoutLedgerError(
      "ENTRY_INVALID",
      "holdout entry cannot be evaluated against a budget",
      problems,
    );
  }
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

/* ------------------------------------------------------------------------ *
 * Ledger-derived exclusion sets
 * ------------------------------------------------------------------------ */

/**
 * Every case the ledger governs as held out: all holdout entries (ACTIVE or
 * retired — a retired holdout is a regression fixture, still never a dev
 * case) plus every designated successor whose tier budget is zero. This is
 * the one list lab tooling should consult instead of a static literal.
 */
export function heldOutCaseIds(ledger: HoldoutLedger): string[] {
  const ids = new Set<string>();
  for (const holdout of ledger.holdouts) ids.add(holdout.caseId);
  for (const designated of ledger.successors) {
    if (INSPECTION_BUDGETS[designated.tier] === 0) ids.add(designated.caseId);
  }
  return [...ids].sort();
}

/**
 * Cases that no benchmark, gate suite, or measurement script may score at
 * all: designated successors and ACTIVE holdouts whose inspection budget is
 * zero. Retired holdouts are excluded from this list on purpose — they keep
 * running as pinned regression fixtures (their results just cannot back a
 * certification claim).
 */
export function benchExcludedCaseIds(ledger: HoldoutLedger): string[] {
  const ids = new Set<string>();
  for (const holdout of ledger.holdouts) {
    if (holdout.status === "ACTIVE" && INSPECTION_BUDGETS[holdout.tier] === 0) {
      ids.add(holdout.caseId);
    }
  }
  for (const designated of ledger.successors) {
    if (INSPECTION_BUDGETS[designated.tier] === 0) ids.add(designated.caseId);
  }
  return [...ids].sort();
}

/* ------------------------------------------------------------------------ *
 * Committed-artifact cross-check
 * ------------------------------------------------------------------------ */

const ARTIFACT_SCAN_ROOT = "datasets" as const;
const RELEASE_SNAPSHOT_ROOT = "datasets/releases" as const;
const ARTIFACT_SCAN_MAX_BYTES = 64 * 1024 * 1024;
/** Raw media/model payloads: their existence is acquisition, not inspection. */
const MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".mkv",
  ".webm",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".wav",
  ".mp3",
  ".m4a",
  ".pt",
  ".pth",
  ".onnx",
  ".tflite",
  ".mlmodel",
  ".bin",
  ".npy",
  ".npz",
  ".zip",
  ".gz",
  ".tar",
  ".pdf",
]);

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/**
 * Walks `<repoRoot>/datasets` and reports, per case id, every committed
 * artifact that names it: a directory or text file whose path contains the
 * id, or a text file whose contents mention it. Exempt: the holdout ledger
 * itself, any `exemptPaths` (a successor's own registry entry is its
 * designation, not an inspection), verbatim copies of those files inside a
 * dataset release snapshot (same repo-relative suffix under
 * `datasets/releases/<release>/artifacts/`), and raw media files.
 */
export function scanCommittedArtifactExposure(
  repoRoot: string,
  caseIds: readonly string[],
  exemptPaths: readonly string[] = [],
): Map<string, string[]> {
  const found = new Map<string, Set<string>>(caseIds.map((id) => [id, new Set<string>()]));
  const ids = caseIds.filter((id) => id.length > 0);
  if (ids.length === 0) return new Map();
  const exempt = new Set(
    [HOLDOUT_LEDGER_PATH, ...exemptPaths].map((p) => toPosix(p).replace(/^\.\//, "")),
  );
  const isExempt = (rel: string): boolean => {
    if (exempt.has(rel)) return true;
    if (!rel.startsWith(`${RELEASE_SNAPSHOT_ROOT}/`)) return false;
    return [...exempt].some((path) =>
      rel.endsWith(`/artifacts/${path.replace(new RegExp(`^${ARTIFACT_SCAN_ROOT}/`), "")}`),
    );
  };
  const scanRoot = join(repoRoot, ARTIFACT_SCAN_ROOT);
  if (!existsSync(scanRoot)) return new Map([...found].map(([id, set]) => [id, [...set].sort()]));

  const record = (id: string, relPath: string): void => {
    found.get(id)?.add(relPath);
  };
  const visit = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = toPosix(relative(repoRoot, full));
      if (isExempt(rel)) continue;
      if (entry.isDirectory()) {
        for (const id of ids) if (entry.name.includes(id)) record(id, rel);
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (MEDIA_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      for (const id of ids) if (entry.name.includes(id)) record(id, rel);
      let size: number;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (size === 0 || size > ARTIFACT_SCAN_MAX_BYTES) continue;
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      for (const id of ids) if (text.includes(id)) record(id, rel);
    }
  };
  visit(scanRoot);
  return new Map([...found].map(([id, set]) => [id, [...set].sort()]));
}

function registryPathOf(designated: SuccessorDesignation): string | null {
  const [path] = designated.registryRef.split("#");
  return path && path.includes("/") ? path : null;
}

/* ------------------------------------------------------------------------ *
 * Certification readiness
 * ------------------------------------------------------------------------ */

function notEvaluable(reasons: string[], repoRoot: string | null): CertificationReadiness {
  return {
    status: "NOT_EVALUABLE",
    reasons,
    holdouts: [],
    artifactScan: { repoRoot, exposures: [] },
  };
}

/**
 * Certification claims require:
 *  1. a well-formed ledger that governs at least one holdout — anything
 *     else (missing/malformed/empty ledger, unknown tier) is NOT_EVALUABLE,
 *     which blocks certification exactly like FAIL,
 *  2. no ACTIVE holdout over its inspection budget,
 *  3. every retired holdout names a designated successor that exists
 *     exactly once, is SHADOW_HOLDOUT, is not the retired holdout itself,
 *     is not any retired holdout, is not shared with another retired
 *     holdout, and does not contradict an inspected holdout entry,
 *  4. every designated successor is label-blind with zero inspections,
 *     and no committed datasets/ artifact names it (a self-declared zero is
 *     cross-checked against the tree the ledger came from),
 *  5. at least one successor designation exists once any holdout retired.
 * Anything pendingExternal on a successor keeps the status BLOCKED — the
 * successor exists on paper but has not yet passed the acquisition
 * front-door freeze, so no certification may cite it.
 *
 * `input` is deliberately `unknown`: the ledger is data, and a shape the
 * evaluator cannot interpret must yield NOT_EVALUABLE, never a TypeError.
 */
export function evaluateCertificationReadiness(
  input: unknown,
  options: CertificationOptions = {},
): CertificationReadiness {
  const repoRoot = options.repoRoot === undefined ? sourceRepoRootOf(input) : options.repoRoot;

  const problems = validateHoldoutLedger(input);
  if (problems.length > 0) {
    return notEvaluable(
      [`ledger is malformed and cannot be evaluated (${problems.length} problem(s))`, ...problems],
      repoRoot,
    );
  }
  const ledger = input as HoldoutLedger;
  if (ledger.holdouts.length === 0) {
    return notEvaluable(
      [
        "ledger governs no holdouts — there is nothing to certify against; an empty ledger cannot be ELIGIBLE",
      ],
      repoRoot,
    );
  }

  const evaluations = ledger.holdouts.map(evaluateHoldout);
  const reasons: string[] = [];
  for (const evaluation of evaluations) reasons.push(...evaluation.violations);

  const holdoutsById = new Map<string, HoldoutEntry[]>();
  for (const holdout of ledger.holdouts) {
    holdoutsById.set(holdout.caseId, [...(holdoutsById.get(holdout.caseId) ?? []), holdout]);
  }
  for (const [caseId, entries] of holdoutsById) {
    if (entries.length > 1) {
      reasons.push(
        `${caseId}: appears ${entries.length} times in ledger.holdouts — ambiguous entry`,
      );
    }
  }

  const designationsById = new Map<string, SuccessorDesignation[]>();
  for (const designated of ledger.successors) {
    designationsById.set(designated.caseId, [
      ...(designationsById.get(designated.caseId) ?? []),
      designated,
    ]);
  }
  for (const [caseId, designations] of designationsById) {
    if (designations.length > 1) {
      reasons.push(
        `successor ${caseId}: designated ${designations.length} times — duplicate designations are ambiguous and cannot serve`,
      );
    }
  }

  const retired = ledger.holdouts.filter((h) => h.status === "RETIRED_TO_REGRESSION");
  const retiredIds = new Set(retired.map((h) => h.caseId));
  const claimants = new Map<string, string[]>();
  for (const entry of retired) {
    const successorId = entry.retirement?.successorId ?? null;
    if (successorId)
      claimants.set(successorId, [...(claimants.get(successorId) ?? []), entry.caseId]);
  }
  for (const [successorId, holders] of claimants) {
    if (holders.length > 1) {
      reasons.push(
        `successor ${successorId} is claimed by ${holders.length} retired holdouts (${holders.join(", ")}) — a successor must be uniquely assigned`,
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
        `${entry.caseId}: names itself as its own successor — a retired (contaminated) holdout cannot succeed itself`,
      );
      continue;
    }
    if (retiredIds.has(successorId)) {
      reasons.push(
        `${entry.caseId}: names successor ${successorId}, which is itself a retired (contaminated) holdout and cannot serve`,
      );
      continue;
    }
    const designations = designationsById.get(successorId) ?? [];
    if (designations.length === 0) {
      reasons.push(
        `${entry.caseId}: names successor ${successorId} but no successor designation exists in the ledger`,
      );
      continue;
    }
    for (const successor of designations) {
      if (successor.tier !== "SHADOW_HOLDOUT") {
        reasons.push(
          `successor ${successor.caseId} has tier ${successor.tier} — a successor must be SHADOW_HOLDOUT (inspection budget 0)`,
        );
      }
      if (!successor.labelBlind) {
        reasons.push(
          `successor ${successor.caseId} is not label-blind — contaminated, cannot serve`,
        );
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
      for (const shadow of holdoutsById.get(successor.caseId) ?? []) {
        const inspected = inspectionCount(shadow);
        if (inspected > 0 || shadow.tier !== successor.tier || shadow.status !== "ACTIVE") {
          reasons.push(
            `successor ${successor.caseId} contradicts its own holdout entry (tier ${shadow.tier}, status ${shadow.status}, ${inspected} recorded inspections) — the designation's inspectionCount ${successor.inspectionCount} cannot be trusted`,
          );
        }
      }
    }
  }

  if (retired.length > 0 && ledger.successors.length === 0) {
    reasons.push("holdouts were retired but no successor designations exist in the ledger");
  }

  const exposures: ArtifactExposure[] = [];
  if (repoRoot !== null) {
    const zeroBudget = ledger.successors.filter((s) => INSPECTION_BUDGETS[s.tier] === 0);
    const exempt = zeroBudget.map(registryPathOf).filter((path): path is string => path !== null);
    const scanned = scanCommittedArtifactExposure(
      repoRoot,
      [...new Set(zeroBudget.map((s) => s.caseId))],
      exempt,
    );
    for (const [caseId, files] of scanned) {
      if (files.length === 0) continue;
      exposures.push({ caseId, files });
      const declared = zeroBudget
        .filter((s) => s.caseId === caseId)
        .map((s) => s.inspectionCount)
        .join("/");
      const shown = files.slice(0, 6).join(", ");
      const more = files.length > 6 ? `, … ${files.length - 6} more` : "";
      reasons.push(
        `successor ${caseId}: self-declared inspectionCount ${declared} is contradicted by ${files.length} committed artifact(s) under ${ARTIFACT_SCAN_ROOT}/ that name it (${shown}${more}) — record the inspections with cited evidence or remove the exposure before any certification claim`,
      );
    }
  }

  return {
    status: reasons.length === 0 ? "ELIGIBLE" : "BLOCKED",
    reasons,
    holdouts: evaluations,
    artifactScan: { repoRoot, exposures },
  };
}

/* ------------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------------ */

/**
 * Reads and validates `datasets/holdouts/ledger.json` under `repoRoot`.
 * Throws `HoldoutLedgerError` (LEDGER_MISSING / LEDGER_UNREADABLE /
 * LEDGER_NOT_JSON / LEDGER_MALFORMED) — never a raw ENOENT or SyntaxError.
 * Use `certificationReadinessForRepo` when the NOT_EVALUABLE verdict is
 * wanted instead of an exception.
 */
export function loadHoldoutLedger(repoRoot: string = REPO_ROOT): LoadedHoldoutLedger {
  const path = join(repoRoot, HOLDOUT_LEDGER_PATH);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new HoldoutLedgerError(
        "LEDGER_MISSING",
        `holdout ledger ${HOLDOUT_LEDGER_PATH} is missing under ${repoRoot} — certification is NOT_EVALUABLE`,
        [],
        error,
      );
    }
    throw new HoldoutLedgerError(
      "LEDGER_UNREADABLE",
      `holdout ledger ${HOLDOUT_LEDGER_PATH} could not be read under ${repoRoot} (${code ?? "unknown error"}) — certification is NOT_EVALUABLE`,
      [],
      error,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HoldoutLedgerError(
      "LEDGER_NOT_JSON",
      `holdout ledger ${HOLDOUT_LEDGER_PATH} is not valid JSON (${(error as Error).message}) — certification is NOT_EVALUABLE`,
      [],
      error,
    );
  }
  const problems = validateHoldoutLedger(parsed);
  if (problems.length > 0) {
    throw new HoldoutLedgerError(
      "LEDGER_MALFORMED",
      `holdout ledger ${HOLDOUT_LEDGER_PATH} is malformed — certification is NOT_EVALUABLE`,
      problems,
    );
  }
  const ledger = parsed as HoldoutLedger;
  return { ...ledger, sourceRepoRoot: repoRoot };
}

/**
 * The non-throwing governance entry point: a missing, unreadable, non-JSON,
 * or malformed ledger is reported as NOT_EVALUABLE with the typed error's
 * message as the reason; a well-formed ledger is evaluated against the
 * same repo tree it was loaded from.
 */
export function certificationReadinessForRepo(
  repoRoot: string = REPO_ROOT,
): CertificationReadiness {
  let ledger: LoadedHoldoutLedger;
  try {
    ledger = loadHoldoutLedger(repoRoot);
  } catch (error) {
    if (error instanceof HoldoutLedgerError) {
      return notEvaluable([`[${error.code}] ${error.message}`], repoRoot);
    }
    throw error;
  }
  return evaluateCertificationReadiness(ledger, { repoRoot });
}
