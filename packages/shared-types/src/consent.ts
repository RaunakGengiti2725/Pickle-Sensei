/**
 * First-party consent domain model (STATUS_BOARD external blocker 3).
 *
 * "Analyze my video" and "use my video to improve models" are separate
 * scopes. Model-training use is an explicit opt-in, never a default, and
 * withdrawal is an append-only state change: the ledger is never rewritten
 * or deleted, status is derived by folding the ledger in order.
 */

export const CONSENT_SCOPES = ["video_analysis", "model_training"] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

export const CONSENT_ACTIONS = ["granted", "withdrawn"] as const;
export type ConsentAction = (typeof CONSENT_ACTIONS)[number];

export const CONSENT_SOURCES = [
  "mobile_settings",
  "onboarding",
  "privacy_center",
  "support",
] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const CONSENT_CAPTURE_MODES = [
  "automatic_pose_trigger",
  "imported_video",
  "all_captures",
] as const;
export type ConsentCaptureMode = (typeof CONSENT_CAPTURE_MODES)[number];

/** Current contract versions; changes re-version, never soften in place. */
export const VIDEO_ANALYSIS_CONSENT_VERSION = "video-analysis-v1";
export const MODEL_TRAINING_CONSENT_VERSION = "model-training-v1";

/**
 * Canonical consent-version naming per scope: `<scope-prefix>-v<major>`.
 * A version string is a contract reference, not free text — a grant that
 * names a string outside this shape references no contract at all and is
 * therefore not a consent decision the ledger can represent.
 */
export const CONSENT_VERSION_PREFIX: Record<ConsentScope, string> = {
  video_analysis: "video-analysis",
  model_training: "model-training",
};

/**
 * Parse the major number out of a scope-canonical consent version.
 * Returns null when the string does not name a contract for that scope
 * (wrong scope prefix, free text, padded/absent major).
 */
export function parseConsentVersionMajor(scope: ConsentScope, version: string): number | null {
  const match = new RegExp(`^${CONSENT_VERSION_PREFIX[scope]}-v(0|[1-9][0-9]*)$`).exec(version);
  if (match === null) return null;
  return Number(match[1]);
}

export type ConsentVersionRejection = "malformed" | "downgrade";

export interface ConsentVersionCheck {
  ok: boolean;
  rejection: ConsentVersionRejection | null;
  message: string | null;
  major: number | null;
}

/**
 * Gate a requested grant version against the scope's naming contract and
 * against the version already granted for that scope.
 *
 * Two rules, neither of which softens an existing contract:
 *  1. the version must name a contract for the scope;
 *  2. a grant may not move the authorizing version DOWN — re-granting under
 *     a superseded (weaker) contract while a higher one is on record is a
 *     downgrade attack, not a consent decision. Upgrades stay open: that is
 *     how re-versioning is supposed to work.
 */
export function checkConsentVersionAcceptable(
  scope: ConsentScope,
  requestedVersion: string,
  latestGrantedVersion: string | null,
): ConsentVersionCheck {
  const major = parseConsentVersionMajor(scope, requestedVersion);
  if (major === null) {
    return {
      ok: false,
      rejection: "malformed",
      message:
        `consentVersion "${requestedVersion}" does not name a ${scope} contract ` +
        `(expected ${CONSENT_VERSION_PREFIX[scope]}-v<major>)`,
      major: null,
    };
  }
  const previous =
    latestGrantedVersion === null ? null : parseConsentVersionMajor(scope, latestGrantedVersion);
  if (previous !== null && major < previous) {
    return {
      ok: false,
      rejection: "downgrade",
      message:
        `consentVersion ${requestedVersion} is a downgrade from the granted ` +
        `${latestGrantedVersion}; consent contracts are re-versioned upward, never downward`,
      major,
    };
  }
  return { ok: true, rejection: null, message: null, major };
}

/**
 * One immutable ledger entry. `subjectPseudonym` is the only identity the
 * ledger carries — the user-id mapping lives in a separate table so the
 * audit trail survives account deletion without remaining identifying.
 */
export interface ConsentRecord {
  id: string;
  subjectPseudonym: string;
  scope: ConsentScope;
  action: ConsentAction;
  consentVersion: string;
  source: ConsentSource;
  /** Device model/platform string, when the client reported one. */
  device: string | null;
  /** Capture mode the grant covers; null on withdrawals. */
  captureMode: ConsentCaptureMode | null;
  /** Declared stroke intent scope for the grant, when narrowed. */
  strokeIntent: string | null;
  recordedAtIso: string;
  /**
   * Ledger sequence number (DB identity). Authoritative ordering: ISO
   * timestamps truncate to milliseconds and can tie, so status derivation
   * prefers seq whenever it is present.
   */
  seq?: number;
}

export interface ConsentScopeStatus {
  scope: ConsentScope;
  /** Derived: last ledger action for the scope is `granted`. */
  active: boolean;
  consentVersion: string | null;
  lastAction: ConsentAction | null;
  lastActionAtIso: string | null;
}

/**
 * Fold the append-only ledger into per-scope status. Absence of any record
 * means NOT consented — the default is always off.
 */
export function deriveConsentStatus(records: readonly ConsentRecord[]): ConsentScopeStatus[] {
  const ordered = [...records].sort((a, b) => {
    if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) return a.seq - b.seq;
    return a.recordedAtIso.localeCompare(b.recordedAtIso);
  });
  return CONSENT_SCOPES.map((scope) => {
    const last = ordered.filter((r) => r.scope === scope).at(-1) ?? null;
    return {
      scope,
      active: last?.action === "granted",
      consentVersion: last?.consentVersion ?? null,
      lastAction: last?.action ?? null,
      lastActionAtIso: last?.recordedAtIso ?? null,
    };
  });
}

export function isModelTrainingConsentActive(records: readonly ConsentRecord[]): boolean {
  return deriveConsentStatus(records).find((s) => s.scope === "model_training")?.active ?? false;
}

/**
 * Consent ledger export contract. The API serves a subject's full ledger in
 * this envelope; intake hosts verify the integrity fields before trusting the
 * records. Versioned like every consent contract: changes re-version.
 */
export const CONSENT_LEDGER_EXPORT_VERSION = "consent-ledger-export-v1";

export interface ConsentLedgerExport {
  exportVersion: string;
  exportedAtIso: string;
  subjectPseudonym: string;
  /** Must equal records.length. */
  recordCount: number;
  /** Highest seq in records; null when the ledger is empty. */
  maxSeq: number | null;
  /** sha256 hex of canonicalConsentRecordsJson(records). */
  recordsSha256: string;
  records: ConsentRecord[];
}

/**
 * Deterministic serialization of ledger records for export hashing: fixed
 * key order, seq normalized to null when absent. Both the exporter and the
 * verifier must hash exactly this string.
 */
export function canonicalConsentRecordsJson(records: readonly ConsentRecord[]): string {
  return JSON.stringify(
    records.map((r) => ({
      id: r.id,
      subjectPseudonym: r.subjectPseudonym,
      scope: r.scope,
      action: r.action,
      consentVersion: r.consentVersion,
      source: r.source,
      device: r.device,
      captureMode: r.captureMode,
      strokeIntent: r.strokeIntent,
      recordedAtIso: r.recordedAtIso,
      seq: r.seq ?? null,
    })),
  );
}

/**
 * Export contract v2. v1's integrity fields (recordCount / maxSeq /
 * recordsSha256) are *corruption*-evident only: anyone who can edit the file
 * can drop a trailing withdrawal and recompute all three. v2 adds a keyed
 * signature over the envelope header so an export is *tamper*-evident; v1 is
 * kept intact and unsoftened for consumers that have no key material.
 */
export const CONSENT_LEDGER_EXPORT_VERSION_V2 = "consent-ledger-export-v2";

export const CONSENT_LEDGER_EXPORT_VERSIONS = [
  CONSENT_LEDGER_EXPORT_VERSION,
  CONSENT_LEDGER_EXPORT_VERSION_V2,
] as const;

export interface ConsentLedgerExportSignature {
  alg: "HMAC-SHA256";
  keyId: string;
  /** Hex HMAC over canonicalConsentExportSigningPayload(envelope). */
  value: string;
}

export interface ConsentLedgerExportV2 extends Omit<ConsentLedgerExport, "exportVersion"> {
  exportVersion: typeof CONSENT_LEDGER_EXPORT_VERSION_V2;
  signature: ConsentLedgerExportSignature;
}

/**
 * Deterministic signing payload: the envelope header, which already binds the
 * records through recordsSha256. Signer and verifier must build exactly this
 * string. Key material never appears here — HMAC computation lives in the
 * Node-only consumers (API export route, intake host).
 */
export function canonicalConsentExportSigningPayload(header: {
  exportVersion: string;
  exportedAtIso: string;
  subjectPseudonym: string;
  recordCount: number;
  maxSeq: number | null;
  recordsSha256: string;
}): string {
  return JSON.stringify({
    exportVersion: header.exportVersion,
    exportedAtIso: header.exportedAtIso,
    subjectPseudonym: header.subjectPseudonym,
    recordCount: header.recordCount,
    maxSeq: header.maxSeq,
    recordsSha256: header.recordsSha256,
  });
}
