import {
  validateAnalysisOutcome,
  type IndependentlyVerifiedAnalysisEligibility,
} from "./analysisOutcome.js";
import { isChargeableAnalysis } from "./chargeability.js";
import { fail, failure, ok, type Result } from "./errors.js";
import {
  isVersionedArtifactReference,
  type VersionedArtifactReference,
} from "./techniqueBenchmark.js";

export const OFFLINE_AUTHORIZATION_PROTOCOL_VERSION = "offline-authorization-v1" as const;
export const OFFLINE_DEVICE_CHALLENGE_SCHEMA_VERSION = "offline-device-challenge-v1" as const;
export const OFFLINE_DEVICE_REGISTRATION_SCHEMA_VERSION = "offline-device-registration-v1" as const;
export const OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION = "offline-execution-grant-v1" as const;
export const OFFLINE_SIGNED_GRANT_SCHEMA_VERSION = "offline-signed-execution-grant-v1" as const;
export const OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION = "offline-free-allocation-v1" as const;
export const OFFLINE_PRO_LEASE_SCHEMA_VERSION = "offline-pro-lease-v1" as const;
export const OFFLINE_NATIVE_TIME_SCHEMA_VERSION = "offline-native-time-v1" as const;
export const OFFLINE_TIME_ANCHOR_SCHEMA_VERSION = "offline-time-anchor-v1" as const;
export const OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION = "offline-app-attest-evidence-v1" as const;
export const OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION = "offline-result-receipt-v1" as const;
export const OFFLINE_UNUSED_TICKET_RETURN_SCHEMA_VERSION =
  "offline-unused-ticket-return-v1" as const;
export const OFFLINE_RECONCILIATION_SCHEMA_VERSION = "offline-reconciliation-v1" as const;
export const OFFLINE_AUTHORIZATION_STATUS_SCHEMA_VERSION =
  "offline-authorization-status-v1" as const;
export const OFFLINE_GRANT_AUDIENCE = "urn:pickle-sensei:offline-execution:v1" as const;
export const OFFLINE_GRANT_JWS_TYPE = "pickle-offline-execution-grant+jwt" as const;
export const OFFLINE_PRO_LEASE_MAX_SECONDS = 7 * 24 * 60 * 60;
export const OFFLINE_DEVICE_CHALLENGE_MAX_SECONDS = 300;

export const OFFLINE_AUTHORIZATION_TRUST_BOUNDARY =
  "Shape and binding only, not cryptographic proof or execution/billing authority. Compact transport validation does not decode or verify JWS. An audited ES256 JWS implementation must verify the exact compact bytes and supply their protected header and claims, using independently configured issuer, audience and purpose-scoped allowlisted keys. Independently validate App Attest bytes, environment, challenge/session freshness and replay protection, native time-anchor continuity and monotonic lifecycle evidence. Wire time evidence contains only bounded elapsed intervals between app events and an opaque anchor nonce, never raw or hashed boot identifiers, absolute uptime or Mach ticks. The elapsed interval is an authenticated client claim, not cryptographic UTC; unknown native time authority requires reconciliation and cannot be restored merely from persisted identifiers. Digests must be independently computed from the exact bound bytes; matching caller-supplied strings do not prove them. The independent release authority must approve both outputs; artifact references inherit the enclosing grant expiry and never approve a model themselves. Current-account authentication, uncached live-session/revocation checks, verified store entitlements, identity-lifetime budget allocation, idempotent receipt replay and atomic result/accounting decisions remain server responsibilities. Check accepted receipt identity before fresh-redemption sequence/ledger checks. No validator registers a device, grants premium, releases a ticket or authenticates an API request.";

export const OFFLINE_AUTHORIZATION_API = {
  deviceChallenge: { method: "POST", path: "/v1/offline/devices/challenge" },
  deviceRegistration: { method: "POST", path: "/v1/offline/devices/register" },
  wallet: { method: "POST", path: "/v1/offline/wallet" },
  reconciliation: { method: "POST", path: "/v1/offline/reconcile" },
  resultSync: { method: "POST", path: "/v1/shots:sync" },
} as const;

export const OFFLINE_AUTHORIZATION_API_AUTH = {
  authentication: "current_owner_live_account_session",
  sessionCheck: "uncached_is_api_session_active",
  rateLimit: "current_user",
  offlineGrantAsBearer: false,
} as const;

export const OFFLINE_JWS_REQUIREMENTS = {
  serialization: "compact",
  algorithm: "ES256",
  protectedHeader: "alg_typ_kid_only",
  signature: "base64url_unpadded_64_byte_r_s",
  keyPurpose: "offline_execution_grant",
  numericDate: "integer_seconds_iat_inclusive_exp_exclusive",
} as const;

export const OFFLINE_RECEIPT_DIGEST_CONTRACT = {
  algorithm: "SHA-256",
  outputSerialization: "RFC8785_analysis_outcome",
  grantSerialization: "exact_compact_jws_ascii",
  assertionSerialization: "RFC8785_receipt_without_attestation",
} as const;

export const OFFLINE_FREE_ALLOCATION_POLICY = {
  id: "identity-lifetime-including-legacy-used-v1",
  budgetScope: "sign_in_identity_lifetime",
  usedCount: "includes_legacy_used",
  newConsumptionRule: "prospective_joint_outputs_only",
  reservations: "online_and_outstanding_offline",
  automaticRelease: "never_on_timeout_reinstall_key_replacement_or_account_deletion",
  recovery: "original_installation_proof_or_explicit_support_review",
} as const;

export type OfflineAttestationEnvironment = "production" | "development";

export interface OfflineDeviceChallenge {
  readonly schemaVersion: typeof OFFLINE_DEVICE_CHALLENGE_SCHEMA_VERSION;
  readonly purpose: "register_installation";
  readonly challengeId: string;
  readonly ownerId: string;
  readonly installationKeyId: string;
  readonly sessionId: string;
  readonly nonceBase64Url: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly attestationEnvironment: OfflineAttestationEnvironment;
}

export interface OfflineDeviceChallengeBinding {
  readonly ownerId: string;
  readonly installationKeyId: string;
  readonly sessionId: string;
  readonly attestationEnvironment: OfflineAttestationEnvironment;
  readonly nowEpochSeconds: number;
}

export interface OfflineAppAttestEvidence {
  readonly schemaVersion: typeof OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION;
  readonly format: "apple_app_attest";
  readonly kind: "attestation_object" | "assertion";
  readonly environment: OfflineAttestationEnvironment;
  readonly dataBase64Url: string;
  readonly clientDataSha256: string;
}

export interface OfflineDeviceRegistration {
  readonly schemaVersion: typeof OFFLINE_DEVICE_REGISTRATION_SCHEMA_VERSION;
  readonly challengeId: string;
  readonly installationKeyId: string;
  readonly attestation: OfflineAppAttestEvidence & { readonly kind: "attestation_object" };
}

export interface OfflineSignedExecutionGrant {
  readonly schemaVersion: typeof OFFLINE_SIGNED_GRANT_SCHEMA_VERSION;
  readonly compactJws: string;
}

export interface OfflineGrantProtectedHeader {
  readonly alg: "ES256";
  readonly typ: typeof OFFLINE_GRANT_JWS_TYPE;
  readonly kid: string;
}

export interface OfflineGrantBinding {
  readonly issuer: string;
  readonly allowedKeyIds: readonly string[];
  readonly ownerId: string;
  readonly installationKeyId: string;
}

export interface OfflineReleasedArtifacts {
  readonly policy: Readonly<VersionedArtifactReference>;
  readonly mechanicsModel: Readonly<VersionedArtifactReference>;
  readonly benchmarkModel: Readonly<VersionedArtifactReference>;
}

export interface OfflineFreeTicketAllocation {
  readonly schemaVersion: typeof OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION;
  readonly allocationId: string;
  readonly generation: number;
  readonly ticketIds: readonly string[];
  readonly budgetPolicy: typeof OFFLINE_FREE_ALLOCATION_POLICY.id;
  readonly financialExpiry: "reconciliation_only";
}

export type OfflineProLease = {
  readonly schemaVersion: typeof OFFLINE_PRO_LEASE_SCHEMA_VERSION;
} & (
  | { readonly kind: "subscription"; readonly verifiedEntitlementExpiresAt: number }
  | { readonly kind: "lifetime"; readonly verifiedEntitlementExpiresAt: null }
);

interface OfflineExecutionGrantBase {
  readonly schemaVersion: typeof OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION;
  readonly protocolVersion: typeof OFFLINE_AUTHORIZATION_PROTOCOL_VERSION;
  readonly iss: string;
  readonly aud: typeof OFFLINE_GRANT_AUDIENCE;
  readonly sub: string;
  readonly jti: string;
  readonly installationKeyId: string;
  readonly iat: number;
  readonly exp: number;
  readonly capabilities: readonly ["analyze_joint_output"];
  readonly release: OfflineReleasedArtifacts;
}

export type OfflineExecutionGrantClaims = OfflineExecutionGrantBase &
  (
    | {
        readonly entitlementSource: "identity_lifetime_free";
        readonly allocation: OfflineFreeTicketAllocation;
        readonly lease?: never;
      }
    | {
        readonly entitlementSource: "verified_store";
        readonly lease: OfflineProLease;
        readonly allocation?: never;
      }
  );

export interface OfflineFreeTicketReference {
  readonly allocationId: string;
  readonly generation: number;
  readonly ticketId: string;
}

export interface OfflineNativeTimeEvidence {
  readonly schemaVersion: typeof OFFLINE_NATIVE_TIME_SCHEMA_VERSION;
  readonly clock: "ios_mach_continuous_time";
  readonly anchorId: string;
  readonly elapsedMs: number;
}

export interface OfflineTimeAnchor {
  readonly schemaVersion: typeof OFFLINE_TIME_ANCHOR_SCHEMA_VERSION;
  readonly anchorId: string;
  readonly ownerId: string;
  readonly installationKeyId: string;
  readonly grantId: string;
  readonly serverEpochSeconds: number;
}

interface OfflineReceiptBase {
  readonly receiptId: string;
  readonly ownerId: string;
  readonly installationKeyId: string;
  readonly grantId: string;
  readonly grantJwsSha256: string;
  readonly lifecycleSequence: number;
  readonly nativeTime: OfflineNativeTimeEvidence;
  readonly attestation: OfflineAppAttestEvidence & { readonly kind: "assertion" };
}

export interface OfflineResultReceipt extends OfflineReceiptBase {
  readonly schemaVersion: typeof OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION;
  readonly ticket: OfflineFreeTicketReference | null;
  readonly operationId: string;
  readonly resultId: string;
  readonly fullOutputSha256: string;
  readonly billingDisposition: "joint_verification_required" | "not_chargeable";
}

/** The consumption receipt exactly as the device persists and submits it
 * (apps/mobile `OfflineReceiptSubmission`): owner / installation / grant /
 * ticket / operation / result / output-digest bindings plus the queue
 * instant, with NO native-time or attestation evidence and no server-side
 * settlement fields. It is the 1.0 wire entry of the delayed reconciliation
 * route; the full-evidence `OfflineResultReceipt` stays the v1 result form. */
export interface OfflineDeviceReceipt {
  readonly receiptId: string;
  readonly ownerId: string;
  readonly installationKeyId: string;
  readonly grantId: string;
  readonly grantJwsSha256: string;
  readonly lifecycleSequence: number;
  readonly ticket: OfflineFreeTicketReference | null;
  readonly operationId: string;
  readonly resultId: string;
  readonly fullOutputSha256: string;
  readonly billingDisposition: "joint_verification_required" | "not_chargeable";
  readonly queuedAt: string;
}

export interface OfflineUnusedTicketReturn extends OfflineReceiptBase {
  readonly schemaVersion: typeof OFFLINE_UNUSED_TICKET_RETURN_SCHEMA_VERSION;
  readonly ticket: OfflineFreeTicketReference;
  readonly terminalState: "returned";
}

export interface OfflineReceiptBinding {
  readonly grant: OfflineExecutionGrantClaims;
  readonly grantJwsSha256: string;
  readonly currentOwnerId: string;
  readonly timeAnchor: OfflineTimeAnchor;
  readonly attestationEnvironment: OfflineAttestationEnvironment;
  readonly clientDataSha256: string;
  readonly lastAcceptedLifecycleSequence: number;
}

export interface OfflineResultBinding {
  readonly outcome: unknown;
  readonly fullOutputSha256: string;
  readonly analysisEligibility: IndependentlyVerifiedAnalysisEligibility | null;
}

export type OfflineReconciliationStatus = {
  readonly schemaVersion: typeof OFFLINE_RECONCILIATION_SCHEMA_VERSION;
  readonly ownerId: string;
  readonly receiptId: string;
} & (
  | { readonly status: "pending"; readonly financialDisposition: "reserved" | "not_applicable" }
  | {
      readonly status: "result_recorded";
      readonly resultId: string;
      readonly financialDisposition: "consumed" | "reserved" | "not_applicable";
    }
  | { readonly status: "unused_ticket_returned"; readonly financialDisposition: "returned" }
  | {
      readonly status: "reconciliation_required";
      readonly reasonCode:
        | "evidence_missing"
        | "evidence_ambiguous"
        | "conflicting_receipt"
        | "owner_mismatch"
        | "account_deleted"
        | "grant_revoked";
      readonly financialDisposition: "reserved" | "not_applicable";
    }
  | {
      readonly status: "support_review_required";
      readonly reasonCode: "original_installation_lost";
      readonly financialDisposition: "reserved" | "not_applicable";
    }
);

export type OfflineAuthorizationStatus = {
  readonly schemaVersion: typeof OFFLINE_AUTHORIZATION_STATUS_SCHEMA_VERSION;
} & (
  | { readonly status: "signed_out" | "unregistered" | "entitlement_verification_required" }
  | {
      readonly status: "unsupported";
      readonly reasonCode:
        "simulator" | "platform" | "app_attest_unavailable" | "model_unavailable";
    }
  | {
      readonly status: "unattested";
      readonly reasonCode:
        "attestation_pending" | "attestation_rejected" | "attestation_service_unavailable";
    }
  | { readonly status: "expired" | "grant_verification_required"; readonly grantId: string }
  | {
      readonly status: "reconciliation_required";
      readonly reasonCode:
        | "untrusted_time"
        | "original_installation_lost"
        | "ambiguous_spend"
        | "owner_changed"
        | "grant_revoked";
    }
);

const RECEIPT_BASE_FIELDS = [
  "schemaVersion",
  "receiptId",
  "ownerId",
  "installationKeyId",
  "grantId",
  "grantJwsSha256",
  "ticket",
  "lifecycleSequence",
  "nativeTime",
  "attestation",
] as const;
const DEVICE_RECEIPT_FIELDS = [
  "receiptId",
  "ownerId",
  "installationKeyId",
  "grantId",
  "grantJwsSha256",
  "lifecycleSequence",
  "ticket",
  "operationId",
  "resultId",
  "fullOutputSha256",
  "billingDisposition",
  "queuedAt",
] as const;
const MAX_UNIX_SECONDS = 253_402_300_799;

export function validateOfflineDeviceChallenge(
  raw: unknown,
  expected: OfflineDeviceChallengeBinding,
): Result<OfflineDeviceChallenge> {
  if (
    !isRecord(raw) ||
    !hasExactFields(raw, [
      "schemaVersion",
      "purpose",
      "challengeId",
      "ownerId",
      "installationKeyId",
      "sessionId",
      "nonceBase64Url",
      "issuedAt",
      "expiresAt",
      "attestationEnvironment",
    ]) ||
    raw.schemaVersion !== OFFLINE_DEVICE_CHALLENGE_SCHEMA_VERSION ||
    raw.purpose !== "register_installation" ||
    !isIdentifier(raw.challengeId) ||
    !isCanonicalOwner(raw.ownerId) ||
    !isIdentifier(raw.installationKeyId) ||
    !isCanonicalOwner(raw.sessionId) ||
    !isBase64Url(raw.nonceBase64Url, 43) ||
    raw.nonceBase64Url.length !== 43 ||
    !isUnixSeconds(raw.issuedAt) ||
    !isUnixSeconds(raw.expiresAt) ||
    raw.expiresAt <= raw.issuedAt ||
    raw.expiresAt - raw.issuedAt > OFFLINE_DEVICE_CHALLENGE_MAX_SECONDS ||
    !isAttestationEnvironment(raw.attestationEnvironment) ||
    !isRecord(expected) ||
    !hasExactFields(expected, [
      "ownerId",
      "installationKeyId",
      "sessionId",
      "attestationEnvironment",
      "nowEpochSeconds",
    ]) ||
    !isUnixSeconds(expected.nowEpochSeconds) ||
    raw.ownerId !== expected.ownerId ||
    raw.installationKeyId !== expected.installationKeyId ||
    raw.sessionId !== expected.sessionId ||
    raw.attestationEnvironment !== expected.attestationEnvironment ||
    expected.nowEpochSeconds < raw.issuedAt ||
    expected.nowEpochSeconds >= raw.expiresAt
  ) {
    return invalid(
      "device_challenge",
      "Require a fresh, versioned account/session/installation-bound registration challenge.",
    );
  }
  return ok(immutableCopy(raw as unknown as OfflineDeviceChallenge));
}

export function validateOfflineDeviceRegistration(
  raw: unknown,
  challenge: unknown,
  expected: OfflineDeviceChallengeBinding,
  independentlyComputedClientDataSha256: string,
): Result<OfflineDeviceRegistration> {
  const parsed = validateOfflineDeviceChallenge(challenge, expected);
  if (!parsed.ok) return parsed;
  if (
    !isRecord(raw) ||
    !hasExactFields(raw, ["schemaVersion", "challengeId", "installationKeyId", "attestation"]) ||
    raw.schemaVersion !== OFFLINE_DEVICE_REGISTRATION_SCHEMA_VERSION ||
    raw.challengeId !== parsed.value.challengeId ||
    raw.installationKeyId !== parsed.value.installationKeyId ||
    !isAppAttestEvidence(raw.attestation, "attestation_object") ||
    raw.attestation.environment !== parsed.value.attestationEnvironment ||
    !isSha256(independentlyComputedClientDataSha256) ||
    raw.attestation.clientDataSha256 !== independentlyComputedClientDataSha256
  ) {
    return invalid(
      "device_registration",
      "Require matching challenge and App Attest evidence bindings; evidence is not verified here.",
    );
  }
  return ok(immutableCopy(raw as unknown as OfflineDeviceRegistration));
}

export function validateOfflineSignedGrantShape(raw: unknown): Result<OfflineSignedExecutionGrant> {
  if (
    !isRecord(raw) ||
    !hasExactFields(raw, ["schemaVersion", "compactJws"]) ||
    raw.schemaVersion !== OFFLINE_SIGNED_GRANT_SCHEMA_VERSION ||
    typeof raw.compactJws !== "string" ||
    raw.compactJws.length > 16_384
  ) {
    return invalid(
      "signed_grant_shape",
      "Require a versioned compact JWS transport, not detached claims or an API bearer.",
    );
  }
  const segments = raw.compactJws.split(".");
  if (
    segments.length !== 3 ||
    !isBase64Url(segments[0], 1024) ||
    !isBase64Url(segments[1], 15_272) ||
    !isBase64Url(segments[2], 86) ||
    segments[2].length !== 86
  ) {
    return invalid(
      "compact_jws_shape",
      "Require three unpadded base64url segments and a 64-byte ES256 R||S signature shape.",
    );
  }
  return ok(immutableCopy(raw as unknown as OfflineSignedExecutionGrant));
}

export function validateOfflineExecutionGrantMetadata(
  protectedHeader: unknown,
  claims: unknown,
  expected: OfflineGrantBinding,
): Result<OfflineExecutionGrantClaims> {
  if (
    !isRecord(protectedHeader) ||
    !hasExactFields(protectedHeader, ["alg", "typ", "kid"]) ||
    protectedHeader.alg !== "ES256" ||
    protectedHeader.typ !== OFFLINE_GRANT_JWS_TYPE ||
    !isIdentifier(protectedHeader.kid) ||
    !isRecord(expected) ||
    !hasExactFields(expected, ["issuer", "allowedKeyIds", "ownerId", "installationKeyId"]) ||
    !isIdentifier(expected.issuer) ||
    !isCanonicalOwner(expected.ownerId) ||
    !isIdentifier(expected.installationKeyId) ||
    !isUniqueIdentifiers(expected.allowedKeyIds, 32) ||
    !expected.allowedKeyIds.includes(protectedHeader.kid) ||
    !isExecutionGrantClaims(claims) ||
    claims.iss !== expected.issuer ||
    claims.sub !== expected.ownerId ||
    claims.installationKeyId !== expected.installationKeyId
  ) {
    return invalid(
      "grant_metadata",
      "Require known ES256 protected metadata and exact issuer/audience/key/owner/installation claim bindings.",
    );
  }
  return ok(immutableCopy(claims));
}

export function validateOfflineFreeTicketAllocation(
  raw: unknown,
): Result<OfflineFreeTicketAllocation> {
  if (!isFreeTicketAllocation(raw)) {
    return invalid(
      "free_allocation",
      "Require unique identity-lifetime tickets, preserving legacy usage and reservation until reconciliation.",
    );
  }
  return ok(immutableCopy(raw));
}

export function validateOfflineResultReceiptShape(raw: unknown): Result<OfflineResultReceipt> {
  if (
    !isRecord(raw) ||
    !hasExactFields(raw, [
      ...RECEIPT_BASE_FIELDS,
      "operationId",
      "resultId",
      "fullOutputSha256",
      "billingDisposition",
    ]) ||
    raw.schemaVersion !== OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION ||
    !isReceiptBase(raw) ||
    (raw.ticket !== null && !isTicketReference(raw.ticket)) ||
    !isIdentifier(raw.operationId) ||
    !isIdentifier(raw.resultId) ||
    !isSha256(raw.fullOutputSha256) ||
    (raw.billingDisposition !== "joint_verification_required" &&
      raw.billingDisposition !== "not_chargeable")
  ) {
    return invalid(
      "result_receipt_shape",
      "Require an immutable owner/device/grant/operation/result/digest receipt with explicit native evidence.",
    );
  }
  return ok(immutableCopy(raw as unknown as OfflineResultReceipt));
}

export function validateOfflineDeviceReceiptShape(raw: unknown): Result<OfflineDeviceReceipt> {
  if (
    !isRecord(raw) ||
    !hasExactFields(raw, DEVICE_RECEIPT_FIELDS) ||
    !isIdentifier(raw.receiptId) ||
    !isCanonicalOwner(raw.ownerId) ||
    !isIdentifier(raw.installationKeyId) ||
    !isIdentifier(raw.grantId) ||
    !isSha256(raw.grantJwsSha256) ||
    !isPositiveSequence(raw.lifecycleSequence) ||
    (raw.ticket !== null && !isTicketReference(raw.ticket)) ||
    !isIdentifier(raw.operationId) ||
    !isIdentifier(raw.resultId) ||
    !isSha256(raw.fullOutputSha256) ||
    (raw.billingDisposition !== "joint_verification_required" &&
      raw.billingDisposition !== "not_chargeable") ||
    !isIsoInstant(raw.queuedAt)
  ) {
    return invalid(
      "device_receipt_shape",
      "Require the device's immutable owner/installation/grant/ticket/operation/result/digest receipt with its queue instant and nothing else.",
    );
  }
  return ok(immutableCopy(raw as unknown as OfflineDeviceReceipt));
}

export function validateOfflineResultReceiptBinding(
  raw: unknown,
  expected: OfflineReceiptBinding,
  result: OfflineResultBinding,
): Result<OfflineResultReceipt> {
  const parsed = validateOfflineResultReceiptShape(raw);
  if (!parsed.ok) return parsed;
  const receipt = parsed.value;
  if (
    !receiptMatchesBinding(receipt, expected, true) ||
    !isRecord(result) ||
    !hasExactFields(result, ["outcome", "fullOutputSha256", "analysisEligibility"]) ||
    !isSha256(result.fullOutputSha256) ||
    receipt.fullOutputSha256 !== result.fullOutputSha256
  ) {
    return invalid(
      "result_receipt_binding",
      "Require original grant, ticket, native execution evidence and independently computed complete-output digest bindings.",
    );
  }
  const outcome = validateAnalysisOutcome(result.outcome);
  if (
    !outcome.ok ||
    outcome.value.source !== "real" ||
    outcome.value.publication.status !== "durably_published" ||
    outcome.value.ownerId !== receipt.ownerId ||
    outcome.value.operationId !== receipt.operationId ||
    outcome.value.analysisId !== receipt.resultId ||
    outcome.value.billingDisposition !== receipt.billingDisposition
  ) {
    return invalid(
      "result_outcome_binding",
      "Require the original durably published shared outcome and its exact non-chargeable or joint-verification disposition.",
    );
  }
  const { mechanics, benchmark } = outcome.value;
  const release = expected.grant.release;
  if (
    (mechanics.status === "validated_score" &&
      (!artifactsEqual(mechanics.lineage.model, release.mechanicsModel) ||
        !artifactsEqual(mechanics.lineage.policy, release.policy))) ||
    (benchmark.status === "validated_range" &&
      (!artifactsEqual(benchmark.lineage.model, release.benchmarkModel) ||
        !artifactsEqual(benchmark.lineage.policy, release.policy))) ||
    (outcome.value.status === "complete" &&
      !isChargeableAnalysis(outcome.value, result.analysisEligibility))
  ) {
    return invalid(
      "joint_output_binding",
      "Require the shared joint-output eligibility predicate and matching grant model/policy references; never infer independent approval.",
    );
  }
  return parsed;
}

export function validateOfflineUnusedTicketReturnShape(
  raw: unknown,
): Result<OfflineUnusedTicketReturn> {
  if (
    !isRecord(raw) ||
    !hasExactFields(raw, [...RECEIPT_BASE_FIELDS, "terminalState"]) ||
    raw.schemaVersion !== OFFLINE_UNUSED_TICKET_RETURN_SCHEMA_VERSION ||
    !isReceiptBase(raw) ||
    !isTicketReference(raw.ticket) ||
    raw.terminalState !== "returned"
  ) {
    return invalid(
      "unused_ticket_return_shape",
      "Require a terminal returned-ticket statement with original allocation identity and native evidence, never a result or timeout refund.",
    );
  }
  return ok(immutableCopy(raw as unknown as OfflineUnusedTicketReturn));
}

export function validateOfflineUnusedTicketReturnBinding(
  raw: unknown,
  expected: OfflineReceiptBinding,
): Result<OfflineUnusedTicketReturn> {
  const parsed = validateOfflineUnusedTicketReturnShape(raw);
  if (!parsed.ok) return parsed;
  if (!receiptMatchesBinding(parsed.value, expected, false)) {
    return invalid(
      "unused_ticket_return_binding",
      "Require original owner/installation/grant/ticket, monotonic lifecycle and return-proof bindings; no allocation is released here.",
    );
  }
  return parsed;
}

export function validateOfflineReconciliationStatus(
  raw: unknown,
  originalReceipt: unknown,
): Result<OfflineReconciliationStatus> {
  const resultReceipt = validateOfflineResultReceiptShape(originalReceipt);
  const unusedReturn = resultReceipt.ok
    ? resultReceipt
    : validateOfflineUnusedTicketReturnShape(originalReceipt);
  const parsed = unusedReturn.ok
    ? unusedReturn
    : validateOfflineDeviceReceiptShape(originalReceipt);
  if (
    !parsed.ok ||
    !isRecord(raw) ||
    raw.schemaVersion !== OFFLINE_RECONCILIATION_SCHEMA_VERSION ||
    raw.ownerId !== parsed.value.ownerId ||
    raw.receiptId !== parsed.value.receiptId
  ) {
    return invalid(
      "reconciliation_binding",
      "Require a versioned status for the same original owner and immutable receipt.",
    );
  }
  const receipt = parsed.value;
  const base = ["schemaVersion", "ownerId", "receiptId", "status", "financialDisposition"];
  const held = receipt.ticket === null ? "not_applicable" : "reserved";
  let valid = false;
  if (raw.status === "pending") {
    valid = hasExactFields(raw, base) && raw.financialDisposition === held;
  } else if (raw.status === "result_recorded" && "resultId" in receipt) {
    const disposition =
      receipt.ticket === null
        ? "not_applicable"
        : receipt.billingDisposition === "joint_verification_required"
          ? "consumed"
          : "reserved";
    valid =
      hasExactFields(raw, [...base, "resultId"]) &&
      raw.resultId === receipt.resultId &&
      raw.financialDisposition === disposition;
  } else if (raw.status === "unused_ticket_returned" && "terminalState" in receipt) {
    valid = hasExactFields(raw, base) && raw.financialDisposition === "returned";
  } else if (raw.status === "reconciliation_required") {
    valid =
      hasExactFields(raw, [...base, "reasonCode"]) &&
      raw.financialDisposition === held &&
      isOneOf(raw.reasonCode, [
        "evidence_missing",
        "evidence_ambiguous",
        "conflicting_receipt",
        "owner_mismatch",
        "account_deleted",
        "grant_revoked",
      ]);
  } else if (raw.status === "support_review_required") {
    valid =
      hasExactFields(raw, [...base, "reasonCode"]) &&
      raw.financialDisposition === held &&
      raw.reasonCode === "original_installation_lost";
  }
  if (!valid) {
    return invalid(
      "reconciliation_disposition",
      "Pending, ambiguous and partial free work stays reserved; only the matching result or terminal return can change its declared disposition.",
    );
  }
  return ok(immutableCopy(raw as unknown as OfflineReconciliationStatus));
}

export function validateOfflineAuthorizationStatus(
  raw: unknown,
): Result<OfflineAuthorizationStatus> {
  if (!isRecord(raw) || raw.schemaVersion !== OFFLINE_AUTHORIZATION_STATUS_SCHEMA_VERSION) {
    return invalid(
      "authorization_status",
      "Require an explicit versioned verification/access state, not a premium fallback.",
    );
  }
  const base = ["schemaVersion", "status"];
  let valid = false;
  if (isOneOf(raw.status, ["signed_out", "unregistered", "entitlement_verification_required"])) {
    valid = hasExactFields(raw, base);
  } else if (isOneOf(raw.status, ["expired", "grant_verification_required"])) {
    valid = hasExactFields(raw, [...base, "grantId"]) && isIdentifier(raw.grantId);
  } else if (raw.status === "unsupported") {
    valid =
      hasExactFields(raw, [...base, "reasonCode"]) &&
      isOneOf(raw.reasonCode, [
        "simulator",
        "platform",
        "app_attest_unavailable",
        "model_unavailable",
      ]);
  } else if (raw.status === "unattested") {
    valid =
      hasExactFields(raw, [...base, "reasonCode"]) &&
      isOneOf(raw.reasonCode, [
        "attestation_pending",
        "attestation_rejected",
        "attestation_service_unavailable",
      ]);
  } else if (raw.status === "reconciliation_required") {
    valid =
      hasExactFields(raw, [...base, "reasonCode"]) &&
      isOneOf(raw.reasonCode, [
        "untrusted_time",
        "original_installation_lost",
        "ambiguous_spend",
        "owner_changed",
        "grant_revoked",
      ]);
  }
  if (!valid) {
    return invalid(
      "authorization_status_fields",
      "Require declared state-specific fields; a schema check cannot authorize offline execution.",
    );
  }
  return ok(immutableCopy(raw as unknown as OfflineAuthorizationStatus));
}

function isExecutionGrantClaims(value: unknown): value is OfflineExecutionGrantClaims {
  if (!isRecord(value)) return false;
  const base = [
    "schemaVersion",
    "protocolVersion",
    "iss",
    "aud",
    "sub",
    "jti",
    "installationKeyId",
    "iat",
    "exp",
    "capabilities",
    "release",
    "entitlementSource",
  ];
  if (
    !hasExactFields(value, [
      ...base,
      value.entitlementSource === "identity_lifetime_free" ? "allocation" : "lease",
    ]) ||
    value.schemaVersion !== OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION ||
    value.protocolVersion !== OFFLINE_AUTHORIZATION_PROTOCOL_VERSION ||
    !isIdentifier(value.iss) ||
    value.aud !== OFFLINE_GRANT_AUDIENCE ||
    !isCanonicalOwner(value.sub) ||
    !isIdentifier(value.jti) ||
    !isIdentifier(value.installationKeyId) ||
    !isUnixSeconds(value.iat) ||
    !isUnixSeconds(value.exp) ||
    value.exp <= value.iat ||
    !isDenseArray(value.capabilities, (capability) => capability === "analyze_joint_output", 1) ||
    !isReleasedArtifacts(value.release)
  ) {
    return false;
  }
  if (value.entitlementSource === "identity_lifetime_free")
    return isFreeTicketAllocation(value.allocation);
  return (
    value.entitlementSource === "verified_store" && isProLease(value.lease, value.iat, value.exp)
  );
}

function isFreeTicketAllocation(value: unknown): value is OfflineFreeTicketAllocation {
  return (
    isRecord(value) &&
    hasExactFields(value, [
      "schemaVersion",
      "allocationId",
      "generation",
      "ticketIds",
      "budgetPolicy",
      "financialExpiry",
    ]) &&
    value.schemaVersion === OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION &&
    isIdentifier(value.allocationId) &&
    isPositiveSequence(value.generation) &&
    isUniqueIdentifiers(value.ticketIds, 2) &&
    value.budgetPolicy === OFFLINE_FREE_ALLOCATION_POLICY.id &&
    value.financialExpiry === "reconciliation_only"
  );
}

function isProLease(value: unknown, issuedAt: number, expiresAt: number): value is OfflineProLease {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["schemaVersion", "kind", "verifiedEntitlementExpiresAt"]) ||
    value.schemaVersion !== OFFLINE_PRO_LEASE_SCHEMA_VERSION ||
    expiresAt - issuedAt > OFFLINE_PRO_LEASE_MAX_SECONDS
  ) {
    return false;
  }
  return value.kind === "lifetime"
    ? value.verifiedEntitlementExpiresAt === null
    : value.kind === "subscription" &&
        isUnixSeconds(value.verifiedEntitlementExpiresAt) &&
        value.verifiedEntitlementExpiresAt > issuedAt &&
        expiresAt <= value.verifiedEntitlementExpiresAt;
}

function isReleasedArtifacts(value: unknown): value is OfflineReleasedArtifacts {
  return (
    isRecord(value) &&
    hasExactFields(value, ["policy", "mechanicsModel", "benchmarkModel"]) &&
    [value.policy, value.mechanicsModel, value.benchmarkModel].every(
      (artifact) =>
        isRecord(artifact) &&
        hasExactFields(artifact, ["version", "sha256"]) &&
        isVersionedArtifactReference(artifact),
    )
  );
}

function isReceiptBase(value: Record<string, unknown>): boolean {
  return (
    isIdentifier(value.receiptId) &&
    isCanonicalOwner(value.ownerId) &&
    isIdentifier(value.installationKeyId) &&
    isIdentifier(value.grantId) &&
    isSha256(value.grantJwsSha256) &&
    isPositiveSequence(value.lifecycleSequence) &&
    isNativeTimeEvidence(value.nativeTime) &&
    isAppAttestEvidence(value.attestation, "assertion")
  );
}

/** The `Date#toISOString` grammar the device stamps `queuedAt` with. */
function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  return (
    match !== null &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`
  );
}

function isTicketReference(value: unknown): value is OfflineFreeTicketReference {
  return (
    isRecord(value) &&
    hasExactFields(value, ["allocationId", "generation", "ticketId"]) &&
    isIdentifier(value.allocationId) &&
    isPositiveSequence(value.generation) &&
    isIdentifier(value.ticketId)
  );
}

function isNativeTimeEvidence(value: unknown): value is OfflineNativeTimeEvidence {
  return (
    isRecord(value) &&
    hasExactFields(value, ["schemaVersion", "clock", "anchorId", "elapsedMs"]) &&
    value.schemaVersion === OFFLINE_NATIVE_TIME_SCHEMA_VERSION &&
    value.clock === "ios_mach_continuous_time" &&
    isIdentifier(value.anchorId) &&
    isNonnegativeInteger(value.elapsedMs)
  );
}

function isTimeAnchor(value: unknown): value is OfflineTimeAnchor {
  return (
    isRecord(value) &&
    hasExactFields(value, [
      "schemaVersion",
      "anchorId",
      "ownerId",
      "installationKeyId",
      "grantId",
      "serverEpochSeconds",
    ]) &&
    value.schemaVersion === OFFLINE_TIME_ANCHOR_SCHEMA_VERSION &&
    isIdentifier(value.anchorId) &&
    isCanonicalOwner(value.ownerId) &&
    isIdentifier(value.installationKeyId) &&
    isIdentifier(value.grantId) &&
    isUnixSeconds(value.serverEpochSeconds)
  );
}

function isAppAttestEvidence(
  value: unknown,
  kind: OfflineAppAttestEvidence["kind"],
): value is OfflineAppAttestEvidence {
  return (
    isRecord(value) &&
    hasExactFields(value, [
      "schemaVersion",
      "format",
      "kind",
      "environment",
      "dataBase64Url",
      "clientDataSha256",
    ]) &&
    value.schemaVersion === OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION &&
    value.format === "apple_app_attest" &&
    value.kind === kind &&
    isAttestationEnvironment(value.environment) &&
    isBase64Url(value.dataBase64Url, 65_536) &&
    isSha256(value.clientDataSha256)
  );
}

function receiptMatchesBinding(
  receipt: OfflineResultReceipt | OfflineUnusedTicketReturn,
  expected: OfflineReceiptBinding,
  requireExecutionWindow: boolean,
): boolean {
  if (
    !isRecord(expected) ||
    !hasExactFields(expected, [
      "grant",
      "grantJwsSha256",
      "currentOwnerId",
      "timeAnchor",
      "attestationEnvironment",
      "clientDataSha256",
      "lastAcceptedLifecycleSequence",
    ]) ||
    !isExecutionGrantClaims(expected.grant) ||
    !isSha256(expected.grantJwsSha256) ||
    !isCanonicalOwner(expected.currentOwnerId) ||
    !isAttestationEnvironment(expected.attestationEnvironment) ||
    !isSha256(expected.clientDataSha256) ||
    !isNonnegativeInteger(expected.lastAcceptedLifecycleSequence) ||
    !isTimeAnchor(expected.timeAnchor)
  ) {
    return false;
  }
  const grant = expected.grant;
  const anchor = expected.timeAnchor;
  const time = receipt.nativeTime;
  if (
    receipt.ownerId !== expected.currentOwnerId ||
    receipt.ownerId !== grant.sub ||
    receipt.installationKeyId !== grant.installationKeyId ||
    receipt.grantId !== grant.jti ||
    receipt.grantJwsSha256 !== expected.grantJwsSha256 ||
    receipt.lifecycleSequence <= expected.lastAcceptedLifecycleSequence ||
    receipt.attestation.environment !== expected.attestationEnvironment ||
    receipt.attestation.clientDataSha256 !== expected.clientDataSha256 ||
    anchor.ownerId !== grant.sub ||
    anchor.installationKeyId !== grant.installationKeyId ||
    anchor.grantId !== grant.jti ||
    anchor.anchorId !== time.anchorId ||
    anchor.serverEpochSeconds < grant.iat ||
    anchor.serverEpochSeconds >= grant.exp ||
    time.elapsedMs > (MAX_UNIX_SECONDS - anchor.serverEpochSeconds) * 1000 ||
    (requireExecutionWindow && time.elapsedMs >= (grant.exp - anchor.serverEpochSeconds) * 1000)
  ) {
    return false;
  }
  if (grant.entitlementSource === "verified_store") return receipt.ticket === null;
  return (
    receipt.ticket !== null &&
    receipt.ticket.allocationId === grant.allocation.allocationId &&
    receipt.ticket.generation === grant.allocation.generation &&
    grant.allocation.ticketIds.includes(receipt.ticket.ticketId)
  );
}

function artifactsEqual(
  left: Readonly<VersionedArtifactReference>,
  right: Readonly<VersionedArtifactReference>,
): boolean {
  return left.version === right.version && left.sha256 === right.sha256;
}

function isAttestationEnvironment(value: unknown): value is OfflineAttestationEnvironment {
  return value === "production" || value === "development";
}

function isCanonicalOwner(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:/+=-]{1,128}$/.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isBase64Url(value: unknown, maximumLength: number): value is string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > maximumLength ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    return false;
  const remainder = value.length % 4;
  if (remainder === 1) return false;
  if (remainder === 2) return /[AQgw]$/.test(value);
  if (remainder === 3) return /[AEIMQUYcgkosw048]$/.test(value);
  return true;
}

function isNonnegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

function isPositiveSequence(value: unknown): value is number {
  return isNonnegativeInteger(value) && value > 0;
}

function isUnixSeconds(value: unknown): value is number {
  return isNonnegativeInteger(value) && value <= MAX_UNIX_SECONDS;
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function isDenseArray(
  value: unknown,
  predicate: (item: unknown) => boolean,
  maximumLength: number,
): value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length === 0 ||
    value.length > maximumLength ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return false;
  for (let index = 0; index < value.length; index += 1) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !("value" in property) || !property.enumerable || !predicate(property.value))
      return false;
  }
  return true;
}

function isUniqueIdentifiers(value: unknown, maximumLength: number): value is string[] {
  return isDenseArray(value, isIdentifier, maximumLength) && new Set(value).size === value.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Reflect.ownKeys(value).every((key) => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key === "string" &&
        property !== undefined &&
        "value" in property &&
        property.enumerable === true
      );
    })
  );
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === fields.length &&
    keys.every((key) => {
      if (typeof key !== "string" || !fields.includes(key)) return false;
      const property = Object.getOwnPropertyDescriptor(value, key);
      return property !== undefined && "value" in property && property.enumerable === true;
    })
  );
}

function immutableCopy<T>(value: T): T {
  if (Array.isArray(value))
    return Object.freeze(value.map((item: unknown) => immutableCopy(item))) as T;
  if (isRecord(value))
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableCopy(item)])),
    ) as T;
  return value;
}

function invalid(code: string, message: string): Result<never> {
  return fail(failure("permanent", `offline_authorization.invalid_${code}`, message));
}

// ---------------------------------------------------------------------------
// Delayed reconciliation batches (POST /v1/offline/receipts, 1.0 wire contract)
// ---------------------------------------------------------------------------

/** The route reads at most this many bytes of request JSON per POST and
 * answers 413 `OFFLINE_RECEIPT_BATCH_TOO_LARGE_CODE` above it. */
export const OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES = 2_000_000;
/** The route decides at most this many NEW receipts per POST; entries past
 * the budget are answered `pending` and must be presented again. */
export const OFFLINE_RECEIPT_BATCH_MAX_ENTRIES = 250;
export const OFFLINE_RECEIPT_BATCH_TOO_LARGE_CODE = "offline.batch_too_large" as const;

export interface OfflineReceiptBatchLimits {
  readonly maxBodyBytes: number;
  readonly maxEntries: number;
}

export const OFFLINE_RECEIPT_BATCH_LIMITS: OfflineReceiptBatchLimits = Object.freeze({
  maxBodyBytes: OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES,
  maxEntries: OFFLINE_RECEIPT_BATCH_MAX_ENTRIES,
});

export interface OfflineReceiptBatchPlan<T> {
  /** Requests to send in order; each fits both limits, entries keep queue order. */
  readonly batches: readonly (readonly T[])[];
  /** Entries that exceed `maxBodyBytes` alone and can never be delivered as one request. */
  readonly oversized: readonly T[];
}

// `JSON.stringify({ receipts: [a, b] })` is `{"receipts":[` a `,` b `]}`.
const BATCH_ENVELOPE_BYTES = '{"receipts":[]}'.length;

/** Splits a receipt queue into the requests the route accepts: every batch
 * is at most `maxEntries` entries and its exact wire body
 * (`JSON.stringify({ receipts: batch })`, UTF-8) is at most `maxBodyBytes`.
 * Queue order is preserved and every entry appears exactly once, in a batch
 * or in `oversized`. Batches are filled greedily, so a drain never sends a
 * request the route would refuse for size or leave undecided for budget. */
export function planOfflineReceiptBatches<T>(
  entries: readonly T[],
  limits: OfflineReceiptBatchLimits = OFFLINE_RECEIPT_BATCH_LIMITS,
): OfflineReceiptBatchPlan<T> {
  if (!Number.isInteger(limits.maxBodyBytes) || limits.maxBodyBytes <= BATCH_ENVELOPE_BYTES)
    throw new RangeError("maxBodyBytes must be an integer larger than the empty batch envelope");
  if (!Number.isInteger(limits.maxEntries) || limits.maxEntries < 1)
    throw new RangeError("maxEntries must be a positive integer");
  const batches: T[][] = [];
  const oversized: T[] = [];
  let current: T[] = [];
  let currentBytes = BATCH_ENVELOPE_BYTES;
  for (const entry of entries) {
    const entryBytes = utf8ByteLength(JSON.stringify(entry) ?? "null");
    if (BATCH_ENVELOPE_BYTES + entryBytes > limits.maxBodyBytes) {
      oversized.push(entry);
      continue;
    }
    const separator = current.length === 0 ? 0 : 1;
    if (
      current.length >= limits.maxEntries ||
      currentBytes + separator + entryBytes > limits.maxBodyBytes
    ) {
      batches.push(current);
      current = [];
      currentBytes = BATCH_ENVELOPE_BYTES;
    }
    currentBytes += (current.length === 0 ? 0 : 1) + entryBytes;
    current.push(entry);
  }
  if (current.length > 0) batches.push(current);
  return { batches, oversized };
}

/** UTF-8 length of `text` as `fetch` encodes a string body (well-formed
 * JSON.stringify output never contains lone surrogates; one is counted as
 * the 3-byte replacement the encoder emits). */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
