import { readFileSync } from "node:fs";
import {
  CONSENT_ACTIONS,
  CONSENT_SCOPES,
  CONSENT_SOURCES,
  deriveConsentStatus,
  type ConsentRecord,
} from "@pickle/shared-types";

/**
 * Consent-reference validation for first-party intake (wired to C10).
 *
 * The intake host holds an exported append-only consent ledger (JSON array of
 * ConsentRecord rows, the same shape the consent API serves). A clip may pass
 * intake only when the referenced subject pseudonym has ACTIVE grants for
 * BOTH scopes: `video_analysis` and `model_training`. Absence of a record
 * means NOT consented — the default is always off.
 */

export interface ConsentCheckResult {
  ok: boolean;
  subjectPseudonym: string;
  /** Ledger rows found for the subject (all scopes). */
  subjectRecordCount: number;
  videoAnalysisActive: boolean;
  modelTrainingActive: boolean;
  /** Consent version of the latest model_training grant, when active. */
  modelTrainingConsentVersion: string | null;
  errors: string[];
}

function isConsentRecord(row: unknown, index: number, errors: string[]): row is ConsentRecord {
  if (typeof row !== "object" || row === null) {
    errors.push(`ledger[${index}]: not an object`);
    return false;
  }
  const r = row as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof r.id !== "string" || r.id.length === 0) problems.push("id");
  if (typeof r.subjectPseudonym !== "string" || r.subjectPseudonym.length === 0) {
    problems.push("subjectPseudonym");
  }
  if (!CONSENT_SCOPES.includes(r.scope as (typeof CONSENT_SCOPES)[number])) {
    problems.push("scope");
  }
  if (!CONSENT_ACTIONS.includes(r.action as (typeof CONSENT_ACTIONS)[number])) {
    problems.push("action");
  }
  if (typeof r.consentVersion !== "string" || r.consentVersion.length === 0) {
    problems.push("consentVersion");
  }
  if (!CONSENT_SOURCES.includes(r.source as (typeof CONSENT_SOURCES)[number])) {
    problems.push("source");
  }
  if (typeof r.recordedAtIso !== "string" || Number.isNaN(Date.parse(r.recordedAtIso))) {
    problems.push("recordedAtIso");
  }
  if (problems.length > 0) {
    errors.push(`ledger[${index}]: invalid or missing field(s): ${problems.join(", ")}`);
    return false;
  }
  return true;
}

/** Parse an exported consent ledger file. Throws on malformed JSON/shape. */
export function loadConsentLedger(ledgerPath: string): ConsentRecord[] {
  const raw = readFileSync(ledgerPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`consent ledger ${ledgerPath} must be a JSON array of ConsentRecord rows`);
  }
  const errors: string[] = [];
  const records = parsed.filter((row, index): row is ConsentRecord =>
    isConsentRecord(row, index, errors),
  );
  if (errors.length > 0) {
    throw new Error(`consent ledger ${ledgerPath} is malformed:\n${errors.join("\n")}`);
  }
  return records;
}

export function checkConsentForSubject(
  ledger: readonly ConsentRecord[],
  subjectPseudonym: string,
): ConsentCheckResult {
  const errors: string[] = [];
  const subjectRecords = ledger.filter((r) => r.subjectPseudonym === subjectPseudonym);
  const status = deriveConsentStatus(subjectRecords);
  const videoAnalysis = status.find((s) => s.scope === "video_analysis");
  const modelTraining = status.find((s) => s.scope === "model_training");
  const videoAnalysisActive = videoAnalysis?.active ?? false;
  const modelTrainingActive = modelTraining?.active ?? false;

  if (subjectRecords.length === 0) {
    errors.push(`no consent records for subject ${subjectPseudonym} — NOT consented by default`);
  } else {
    if (!videoAnalysisActive) {
      errors.push(`video_analysis consent is not active for ${subjectPseudonym}`);
    }
    if (!modelTrainingActive) {
      errors.push(
        `model_training consent is not active for ${subjectPseudonym} — ` +
          `model-training use is an explicit opt-in, never a default`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    subjectPseudonym,
    subjectRecordCount: subjectRecords.length,
    videoAnalysisActive,
    modelTrainingActive,
    modelTrainingConsentVersion: modelTrainingActive
      ? (modelTraining?.consentVersion ?? null)
      : null,
    errors,
  };
}
