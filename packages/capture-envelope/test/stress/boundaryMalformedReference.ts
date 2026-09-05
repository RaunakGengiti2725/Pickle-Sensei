import {
  G08_BYPASS_FAMILIES,
  G08_CAPTURE_LABELS,
  G08_DOWNSTREAM_OUTCOMES,
  G08_LABEL_SCHEMA_VERSION,
} from "../../src/g08LabelSchema.js";

/**
 * Independent reference model of the g08 label-file contract, written from
 * the documented rules in g08LabelSchema.ts (field comments + validator
 * messages) rather than from the validator's code. Where the reference is
 * STRICTER than the implementation the difference is a candidate finding:
 *   - windowMs numbers must be finite (a JSON `1e400` literal parses to
 *     Infinity and is otherwise handed to ffmpeg as `-t Infinity`);
 *   - `clip` is documented as a repo-relative path, so absolute paths,
 *     `..` segments, backslashes and NUL bytes are rejected;
 *   - a record may not supersede itself and supersession may not form a
 *     cycle (both silently erase human labels from `effective`).
 */

export type ReferenceDeviation =
  "window-nonfinite" | "clip-not-repo-relative" | "supersede-self-or-cycle";

export interface ReferenceVerdict {
  valid: boolean;
  /** Stricter-than-implementation checks that failed. */
  strictOnly: ReferenceDeviation[];
  /** Whether the implementation-equivalent rules alone would accept the file. */
  lenientValid: boolean;
  effectiveIds: string[];
}

const FAMILY = new Set<string>(G08_BYPASS_FAMILIES);
const CAPTURE = new Set<string>(G08_CAPTURE_LABELS);
const OUTCOME = new Set<string>(G08_DOWNSTREAM_OUTCOMES);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isRepoRelativePath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.includes("\u0000") || path.includes("\\")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return false;
  }
  return !path.split("/").some((segment) => segment === "..");
}

export function referenceValidate(data: unknown): ReferenceVerdict {
  const strictOnly = new Set<ReferenceDeviation>();
  let lenientErrors = 0;
  if (!isPlainRecord(data)) {
    return { valid: false, strictOnly: [], lenientValid: false, effectiveIds: [] };
  }
  if (data.schemaVersion !== G08_LABEL_SCHEMA_VERSION) lenientErrors += 1;
  if (!nonEmptyString(data.provenance)) lenientErrors += 1;
  if (!Array.isArray(data.labels)) {
    return { valid: false, strictOnly: [], lenientValid: false, effectiveIds: [] };
  }

  const seen = new Set<string>();
  const accepted: Array<{ labelId: string; supersedes: string | undefined }> = [];
  data.labels.forEach((raw: unknown) => {
    if (!isPlainRecord(raw)) {
      lenientErrors += 1;
      return;
    }
    if (!nonEmptyString(raw.labelId)) {
      lenientErrors += 1;
      return;
    }
    let recordErrors = 0;
    if (seen.has(raw.labelId)) recordErrors += 1;
    seen.add(raw.labelId);
    if (raw.candidateId !== null && typeof raw.candidateId !== "string") recordErrors += 1;
    if (!nonEmptyString(raw.clip)) recordErrors += 1;
    else if (!isRepoRelativePath(raw.clip)) strictOnly.add("clip-not-repo-relative");
    const win = raw.windowMs;
    if (
      !isPlainRecord(win) ||
      typeof win.startMs !== "number" ||
      win.startMs < 0 ||
      typeof win.durationMs !== "number" ||
      win.durationMs <= 0
    ) {
      recordErrors += 1;
    } else if (!Number.isFinite(win.startMs) || !Number.isFinite(win.durationMs)) {
      strictOnly.add("window-nonfinite");
    }
    if (!nonEmptyString(raw.sessionKey)) recordErrors += 1;
    if (typeof raw.family !== "string" || !FAMILY.has(raw.family)) recordErrors += 1;
    if (typeof raw.capture !== "string" || !CAPTURE.has(raw.capture)) recordErrors += 1;
    if (typeof raw.downstream !== "string" || !OUTCOME.has(raw.downstream)) recordErrors += 1;
    if (raw.annotatorKind !== "human") recordErrors += 1;
    if (!nonEmptyString(raw.annotator)) recordErrors += 1;
    if (typeof raw.labeledAtIso !== "string" || Number.isNaN(Date.parse(raw.labeledAtIso))) {
      recordErrors += 1;
    }
    if (typeof raw.notes !== "string") recordErrors += 1;
    else if (
      (raw.capture === "UNSAFE" || raw.capture === "AMBIGUOUS") &&
      raw.notes.trim().length === 0
    ) {
      recordErrors += 1;
    }
    if (raw.supersedesLabelId !== undefined && typeof raw.supersedesLabelId !== "string") {
      recordErrors += 1;
    }
    lenientErrors += recordErrors;
    if (recordErrors === 0) {
      accepted.push({
        labelId: raw.labelId,
        supersedes: typeof raw.supersedesLabelId === "string" ? raw.supersedesLabelId : undefined,
      });
    }
  });

  for (const record of accepted) {
    if (record.supersedes !== undefined && !seen.has(record.supersedes)) lenientErrors += 1;
  }

  const supersedesOf = new Map(accepted.map((r) => [r.labelId, r.supersedes] as const));
  for (const record of accepted) {
    const visited = new Set<string>([record.labelId]);
    let cursor = record.supersedes;
    while (cursor !== undefined) {
      if (visited.has(cursor)) {
        strictOnly.add("supersede-self-or-cycle");
        break;
      }
      visited.add(cursor);
      cursor = supersedesOf.get(cursor);
    }
  }

  const superseded = new Set(
    accepted.map((r) => r.supersedes).filter((id): id is string => id !== undefined),
  );
  const lenientValid = lenientErrors === 0;
  return {
    valid: lenientValid && strictOnly.size === 0,
    strictOnly: [...strictOnly].sort(),
    lenientValid,
    effectiveIds: accepted.filter((r) => !superseded.has(r.labelId)).map((r) => r.labelId),
  };
}
