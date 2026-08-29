/**
 * g08-f22-evidence: HUMAN label schema for the label-dependent F22 bypass
 * families. This file defines the ONLY truth format for those families.
 *
 * Tier rules (non-negotiable):
 *  - Machine-proposed review-pack candidates are Tier-C and are NEVER truth.
 *  - Only records in the label file with annotatorKind "human" count toward
 *    any gate metric. Records with annotatorKind "machine" are rejected by
 *    validation — machines must not write this file.
 *  - The label file is append-only; corrections are new versioned records
 *    with `supersedesLabelId`, never edits or deletions.
 */

export const G08_LABEL_SCHEMA_VERSION = "g08-f22-evidence-labels-v1";

export const G08_BYPASS_FAMILIES = [
  "blur_masked_by_noise",
  "bimodal_exposure",
  "strobing_exposure",
  "upscaled_content",
  "tiny_subject",
  "camera_shake",
] as const;
export type G08BypassFamily = (typeof G08_BYPASS_FAMILIES)[number];

/**
 * Human capture-quality judgment of the window, on the axis the envelope
 * checker is supposed to protect:
 *  - SAFE: capture quality supports downstream stroke analysis.
 *  - DEGRADED: analysis plausible but with visibly reduced fidelity; the
 *    checker should warn (DEGRADED), not pass silently.
 *  - UNSAFE: capture quality cannot support trustworthy analysis; the
 *    checker must not report SUPPORTED.
 *  - AMBIGUOUS: the human cannot decide from the window alone. AMBIGUOUS is
 *    an honest abstention — it is counted and reported, never dropped and
 *    never folded into another class.
 */
export const G08_CAPTURE_LABELS = ["SAFE", "DEGRADED", "UNSAFE", "AMBIGUOUS"] as const;
export type G08CaptureLabel = (typeof G08_CAPTURE_LABELS)[number];

/**
 * Downstream outcome for the SAME window, when a downstream analysis run
 * exists for it:
 *  - USABLE: analysis produced a usable result (usable-result-v1 sense).
 *  - DEGRADED_RESULT: analysis completed but with disclosed reduced quality.
 *  - UNUSABLE_DISCLOSED: analysis failed or abstained AND said so.
 *  - SILENT_FAILURE: analysis reported confident output that is wrong
 *    (silent-failure-v1 sense).
 *  - NOT_RUN: no downstream run exists for this window. NOT_RUN windows are
 *    excluded from downstream-conditioned metrics but still count for
 *    capture-label metrics.
 */
export const G08_DOWNSTREAM_OUTCOMES = [
  "USABLE",
  "DEGRADED_RESULT",
  "UNUSABLE_DISCLOSED",
  "SILENT_FAILURE",
  "NOT_RUN",
] as const;
export type G08DownstreamOutcome = (typeof G08_DOWNSTREAM_OUTCOMES)[number];

export interface G08LabelRecord {
  /** Unique id, e.g. "g08-label-0001". */
  labelId: string;
  /** Review-pack candidate this label answers (candidateId), or null when
   * the human labeled a window outside the pack (window fields required). */
  candidateId: string | null;
  /** Repo-relative clip path. */
  clip: string;
  /** Window inside the clip. */
  windowMs: { startMs: number; durationMs: number };
  /** Session grouping key — windows from one session are NOT independent. */
  sessionKey: string;
  /** Bypass family this label is evidence for. */
  family: G08BypassFamily;
  capture: G08CaptureLabel;
  downstream: G08DownstreamOutcome;
  /** Must be "human". Machine records are invalid in this file. */
  annotatorKind: "human";
  /** Stable annotator identifier (initials or handle), never empty. */
  annotator: string;
  labeledAtIso: string;
  /** Free-text basis for the judgment. Required for UNSAFE and AMBIGUOUS. */
  notes: string;
  /** Set when this record corrects an earlier one (append-only versioning). */
  supersedesLabelId?: string;
}

export interface G08LabelFile {
  schemaVersion: typeof G08_LABEL_SCHEMA_VERSION;
  /** Statement of what human process produced the labels (or why empty). */
  provenance: string;
  labels: G08LabelRecord[];
}

export interface G08ValidationResult {
  valid: boolean;
  errors: string[];
  /** Effective records after applying supersedes chains (latest wins). */
  effective: G08LabelRecord[];
}

const FAMILY_SET = new Set<string>(G08_BYPASS_FAMILIES);
const CAPTURE_SET = new Set<string>(G08_CAPTURE_LABELS);
const OUTCOME_SET = new Set<string>(G08_DOWNSTREAM_OUTCOMES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateG08LabelFile(data: unknown): G08ValidationResult {
  const errors: string[] = [];
  if (!isRecord(data)) {
    return { valid: false, errors: ["label file is not an object"], effective: [] };
  }
  if (data.schemaVersion !== G08_LABEL_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be "${G08_LABEL_SCHEMA_VERSION}", got ${JSON.stringify(data.schemaVersion)}`,
    );
  }
  if (typeof data.provenance !== "string" || data.provenance.length === 0) {
    errors.push("provenance must be a non-empty string");
  }
  if (!Array.isArray(data.labels)) {
    errors.push("labels must be an array");
    return { valid: false, errors, effective: [] };
  }

  const seenIds = new Set<string>();
  const records: G08LabelRecord[] = [];
  data.labels.forEach((raw, index) => {
    const at = `labels[${index}]`;
    if (!isRecord(raw)) {
      errors.push(`${at}: not an object`);
      return;
    }
    if (typeof raw.labelId !== "string" || raw.labelId.length === 0) {
      errors.push(`${at}: labelId must be a non-empty string`);
      return;
    }
    if (seenIds.has(raw.labelId)) errors.push(`${at}: duplicate labelId ${raw.labelId}`);
    seenIds.add(raw.labelId);
    if (raw.candidateId !== null && typeof raw.candidateId !== "string") {
      errors.push(`${at}: candidateId must be a string or null`);
    }
    if (typeof raw.clip !== "string" || raw.clip.length === 0) {
      errors.push(`${at}: clip must be a non-empty repo-relative path`);
    }
    const win = raw.windowMs;
    if (
      !isRecord(win) ||
      typeof win.startMs !== "number" ||
      win.startMs < 0 ||
      typeof win.durationMs !== "number" ||
      win.durationMs <= 0
    ) {
      errors.push(`${at}: windowMs must be { startMs >= 0, durationMs > 0 }`);
    }
    if (typeof raw.sessionKey !== "string" || raw.sessionKey.length === 0) {
      errors.push(`${at}: sessionKey must be a non-empty string`);
    }
    if (typeof raw.family !== "string" || !FAMILY_SET.has(raw.family)) {
      errors.push(`${at}: family must be one of ${G08_BYPASS_FAMILIES.join(", ")}`);
    }
    if (typeof raw.capture !== "string" || !CAPTURE_SET.has(raw.capture)) {
      errors.push(`${at}: capture must be one of ${G08_CAPTURE_LABELS.join(", ")}`);
    }
    if (typeof raw.downstream !== "string" || !OUTCOME_SET.has(raw.downstream)) {
      errors.push(`${at}: downstream must be one of ${G08_DOWNSTREAM_OUTCOMES.join(", ")}`);
    }
    if (raw.annotatorKind !== "human") {
      errors.push(
        `${at}: annotatorKind must be "human" — machine-proposed labels are Tier-C and may not be written to this file`,
      );
    }
    if (typeof raw.annotator !== "string" || raw.annotator.length === 0) {
      errors.push(`${at}: annotator must be a non-empty string`);
    }
    if (typeof raw.labeledAtIso !== "string" || Number.isNaN(Date.parse(raw.labeledAtIso))) {
      errors.push(`${at}: labeledAtIso must be a parseable ISO date string`);
    }
    if (typeof raw.notes !== "string") {
      errors.push(`${at}: notes must be a string`);
    } else if (
      (raw.capture === "UNSAFE" || raw.capture === "AMBIGUOUS") &&
      raw.notes.trim().length === 0
    ) {
      errors.push(`${at}: notes are required for UNSAFE and AMBIGUOUS labels`);
    }
    if (raw.supersedesLabelId !== undefined && typeof raw.supersedesLabelId !== "string") {
      errors.push(`${at}: supersedesLabelId must be a string when present`);
    }
    if (errors.length === 0 || !errors.some((e) => e.startsWith(at))) {
      records.push(raw as unknown as G08LabelRecord);
    }
  });

  for (const record of records) {
    if (record.supersedesLabelId !== undefined && !seenIds.has(record.supersedesLabelId)) {
      errors.push(
        `label ${record.labelId}: supersedesLabelId ${record.supersedesLabelId} does not exist in this file`,
      );
    }
  }

  const superseded = new Set(
    records.map((r) => r.supersedesLabelId).filter((id): id is string => id !== undefined),
  );
  const effective = records.filter((r) => !superseded.has(r.labelId));

  return { valid: errors.length === 0, errors, effective };
}
