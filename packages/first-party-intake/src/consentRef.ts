import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CONSENT_ACTIONS,
  CONSENT_LEDGER_EXPORT_VERSION,
  CONSENT_SCOPES,
  CONSENT_SOURCES,
  canonicalConsentRecordsJson,
  deriveConsentStatus,
  type ConsentRecord,
} from "@pickle/shared-types";

/**
 * Consent-reference validation for first-party intake (wired to C10).
 *
 * The intake host holds an exported append-only consent ledger: either the
 * versioned export envelope served by GET /v1/me/consent/export (preferred —
 * its integrity fields are verified here before the records are trusted) or
 * a bare JSON array of ConsentRecord rows (legacy). A clip may pass intake
 * only when the referenced subject pseudonym has ACTIVE grants for BOTH
 * scopes: `video_analysis` and `model_training`. Absence of a record means
 * NOT consented — the default is always off.
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

function parseRecords(parsed: unknown[], ledgerPath: string): ConsentRecord[] {
  const errors: string[] = [];
  const records = parsed.filter((row, index): row is ConsentRecord =>
    isConsentRecord(row, index, errors),
  );
  if (errors.length > 0) {
    throw new Error(`consent ledger ${ledgerPath} is malformed:\n${errors.join("\n")}`);
  }
  return records;
}

/**
 * Verify the integrity fields of an export envelope against its records.
 * Throws on any mismatch: a tampered, truncated, or reordered export must
 * never silently authorize intake.
 */
function verifyExportEnvelope(
  envelope: Record<string, unknown>,
  records: ConsentRecord[],
  ledgerPath: string,
): void {
  const problems: string[] = [];
  if (envelope.exportVersion !== CONSENT_LEDGER_EXPORT_VERSION) {
    problems.push(
      `unknown exportVersion ${String(envelope.exportVersion)} ` +
        `(expected ${CONSENT_LEDGER_EXPORT_VERSION})`,
    );
  }
  if (envelope.recordCount !== records.length) {
    problems.push(
      `recordCount ${String(envelope.recordCount)} does not match records.length ${records.length}`,
    );
  }
  const seqs = records.map((r) => r.seq);
  if (seqs.some((s) => s === undefined)) {
    problems.push("every exported record must carry seq");
  } else {
    const nums = seqs as number[];
    if (nums.some((s, i) => i > 0 && s <= nums[i - 1]!)) {
      problems.push("records are not strictly ordered by seq");
    }
    const expectedMax = nums.length > 0 ? nums[nums.length - 1]! : null;
    if (envelope.maxSeq !== expectedMax) {
      problems.push(`maxSeq ${String(envelope.maxSeq)} does not match last seq ${expectedMax}`);
    }
  }
  const digest = createHash("sha256").update(canonicalConsentRecordsJson(records)).digest("hex");
  if (envelope.recordsSha256 !== digest) {
    problems.push(
      `recordsSha256 ${String(envelope.recordsSha256)} does not match computed ${digest}`,
    );
  }
  const subjects = new Set(records.map((r) => r.subjectPseudonym));
  if (typeof envelope.subjectPseudonym !== "string" || envelope.subjectPseudonym.length === 0) {
    problems.push("subjectPseudonym missing");
  } else if (subjects.size > 0 && (subjects.size > 1 || !subjects.has(envelope.subjectPseudonym))) {
    problems.push("records reference a subject other than the envelope's subjectPseudonym");
  }
  if (problems.length > 0) {
    throw new Error(
      `consent ledger export ${ledgerPath} failed integrity verification:\n${problems.join("\n")}`,
    );
  }
}

/**
 * Parse an exported consent ledger file: an export envelope (integrity
 * verified) or a bare JSON array of rows. Throws on malformed JSON/shape
 * and on any envelope integrity failure.
 */
export function loadConsentLedger(ledgerPath: string): ConsentRecord[] {
  const raw = readFileSync(ledgerPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return parseRecords(parsed, ledgerPath);
  }
  if (typeof parsed === "object" && parsed !== null) {
    const envelope = parsed as Record<string, unknown>;
    if (Array.isArray(envelope.records)) {
      const records = parseRecords(envelope.records, ledgerPath);
      verifyExportEnvelope(envelope, records, ledgerPath);
      return records;
    }
  }
  throw new Error(
    `consent ledger ${ledgerPath} must be a JSON array of ConsentRecord rows ` +
      "or a consent-ledger-export envelope",
  );
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
