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
