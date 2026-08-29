import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CONSENT_ACTIONS,
  CONSENT_LEDGER_EXPORT_VERSION,
  CONSENT_LEDGER_EXPORT_VERSION_V2,
  CONSENT_SCOPES,
  CONSENT_SOURCES,
  canonicalConsentExportSigningPayload,
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
  options?: ConsentLedgerVerifyOptions,
): void {
  const problems: string[] = [];
  const version = envelope.exportVersion;
  if (version !== CONSENT_LEDGER_EXPORT_VERSION && version !== CONSENT_LEDGER_EXPORT_VERSION_V2) {
    problems.push(
      `unknown exportVersion ${String(version)} ` +
        `(expected ${CONSENT_LEDGER_EXPORT_VERSION} or ${CONSENT_LEDGER_EXPORT_VERSION_V2})`,
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
  if (options?.signingKey !== undefined) {
    // A host provisioned with the signing key never accepts an unsigned
    // envelope: stripping the signature (serving v1 instead of v2) would
    // otherwise be a silent downgrade to hash-only integrity, which anyone
    // who can edit the file can recompute.
    if (version !== CONSENT_LEDGER_EXPORT_VERSION_V2) {
      problems.push(
        "signing key is configured but the export is unsigned " +
          `(${String(version)}); refusing signature downgrade`,
      );
    } else {
      const signature = envelope.signature as Record<string, unknown> | undefined;
      const value = typeof signature?.value === "string" ? signature.value : "";
      const expected = createHmac("sha256", options.signingKey)
        .update(
          canonicalConsentExportSigningPayload({
            exportVersion: CONSENT_LEDGER_EXPORT_VERSION_V2,
            exportedAtIso: String(envelope.exportedAtIso),
            subjectPseudonym: String(envelope.subjectPseudonym),
            recordCount: Number(envelope.recordCount),
            maxSeq: envelope.maxSeq === null ? null : Number(envelope.maxSeq),
            recordsSha256: String(envelope.recordsSha256),
          }),
        )
        .digest("hex");
      const valueBuf = Buffer.from(value, "utf8");
      const expectedBuf = Buffer.from(expected, "utf8");
      if (valueBuf.length !== expectedBuf.length || !timingSafeEqual(valueBuf, expectedBuf)) {
        problems.push("export signature does not verify against the configured signing key");
      }
    }
  }
  if (options?.minMaxSeq !== undefined) {
    // Replay/rollback detection: an export is a snapshot, so an attacker can
    // present an old-but-internally-valid envelope taken before a withdrawal.
    // The host pins the highest maxSeq it has already accepted for the
    // subject; the ledger is append-only, so maxSeq may only move forward.
    const maxSeq = envelope.maxSeq === null ? 0 : Number(envelope.maxSeq);
    if (!Number.isFinite(maxSeq) || maxSeq < options.minMaxSeq) {
      problems.push(
        `export maxSeq ${String(envelope.maxSeq)} is behind the already-seen ` +
          `ledger watermark ${options.minMaxSeq}; stale export replay`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `consent ledger export ${ledgerPath} failed integrity verification:\n${problems.join("\n")}`,
    );
  }
}

export interface ConsentLedgerVerifyOptions {
  /** HMAC key for export contract v2. When set, unsigned (v1) envelopes and
   * bad signatures are rejected outright. */
  signingKey?: string;
  /** Highest export maxSeq this host has previously accepted for the
   * subject. Envelopes behind it are stale replays and are rejected. */
  minMaxSeq?: number;
}

/**
 * Parse an exported consent ledger file: an export envelope (integrity
 * verified) or a bare JSON array of rows. Throws on malformed JSON/shape
 * and on any envelope integrity failure.
 */
export function loadConsentLedger(
  ledgerPath: string,
  options?: ConsentLedgerVerifyOptions,
): ConsentRecord[] {
  const raw = readFileSync(ledgerPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    if (options?.signingKey !== undefined) {
      throw new Error(
        `consent ledger ${ledgerPath} is a bare record array but a signing key ` +
          "is configured; only signed export envelopes are accepted",
      );
    }
    return parseRecords(parsed, ledgerPath);
  }
  if (typeof parsed === "object" && parsed !== null) {
    const envelope = parsed as Record<string, unknown>;
    if (Array.isArray(envelope.records)) {
      const records = parseRecords(envelope.records, ledgerPath);
      verifyExportEnvelope(envelope, records, ledgerPath, options);
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
