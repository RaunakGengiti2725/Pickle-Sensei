import { describe, expect, it } from "vitest";
import {
  ANALYSIS_ELIGIBILITY_INPUT_SCHEMA_VERSION,
  ANALYSIS_OUTCOME_SCHEMA_VERSION,
  MECHANICS_OUTPUT_SCHEMA_VERSION,
  type AnalysisOutcome,
  type IndependentlyVerifiedAnalysisEligibility,
} from "../src/analysisOutcome.js";
import {
  TECHNIQUE_BENCHMARK_INTERPRETATION,
  TECHNIQUE_BENCHMARK_SCALE,
  TECHNIQUE_BENCHMARK_SCHEMA_VERSION,
  type NumericalOutputLineage,
} from "../src/techniqueBenchmark.js";
import {
  OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
  OFFLINE_AUTHORIZATION_API,
  OFFLINE_AUTHORIZATION_API_AUTH,
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_AUTHORIZATION_STATUS_SCHEMA_VERSION,
  OFFLINE_AUTHORIZATION_TRUST_BOUNDARY,
  OFFLINE_DEVICE_CHALLENGE_SCHEMA_VERSION,
  OFFLINE_DEVICE_REGISTRATION_SCHEMA_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_FREE_ALLOCATION_POLICY,
  OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_GRANT_JWS_TYPE,
  OFFLINE_JWS_REQUIREMENTS,
  OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
  OFFLINE_PRO_LEASE_MAX_SECONDS,
  OFFLINE_PRO_LEASE_SCHEMA_VERSION,
  OFFLINE_RECEIPT_DIGEST_CONTRACT,
  OFFLINE_RECONCILIATION_SCHEMA_VERSION,
  OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
  OFFLINE_TIME_ANCHOR_SCHEMA_VERSION,
  OFFLINE_UNUSED_TICKET_RETURN_SCHEMA_VERSION,
  validateOfflineAuthorizationStatus,
  validateOfflineDeviceChallenge,
  validateOfflineDeviceRegistration,
  validateOfflineExecutionGrantMetadata,
  validateOfflineFreeTicketAllocation,
  validateOfflineReconciliationStatus,
  validateOfflineResultReceiptBinding,
  validateOfflineResultReceiptShape,
  validateOfflineSignedGrantShape,
  validateOfflineUnusedTicketReturnBinding,
  type OfflineDeviceChallengeBinding,
  type OfflineExecutionGrantClaims,
  type OfflineGrantBinding,
  type OfflineReceiptBinding,
  type OfflineResultBinding,
} from "../src/offlineAuthorization.js";

const OWNER = "12345678-1234-4234-8234-123456789abc";
const OTHER_OWNER = "87654321-4321-4321-8321-cba987654321";
const SESSION = "11111111-1111-4111-8111-111111111111";
const NOW = 1_788_000_000;
const KEY = "contract-test-installation-key";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const INVALID_TIMES = [
  NaN,
  Infinity,
  -Infinity,
  -1,
  -0,
  1.5,
  "1788000000",
  null,
  253402300800,
  Number.MAX_SAFE_INTEGER + 1,
];

function grantBinding(): OfflineGrantBinding {
  return {
    issuer: "https://contract-test.invalid/offline",
    allowedKeyIds: ["contract-test-offline-signing-key", "contract-test-rotated-signing-key"],
    ownerId: OWNER,
    installationKeyId: KEY,
  };
}

function header() {
  return { alg: "ES256", typ: OFFLINE_GRANT_JWS_TYPE, kid: "contract-test-offline-signing-key" };
}

function allocation() {
  return {
    schemaVersion: OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
    allocationId: "contract-test-allocation",
    generation: 1,
    ticketIds: ["contract-test-ticket"],
    budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
    financialExpiry: "reconciliation_only" as const,
  };
}

function grant(): Extract<
  OfflineExecutionGrantClaims,
  { entitlementSource: "identity_lifetime_free" }
> {
  return {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: grantBinding().issuer,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: OWNER,
    jti: "contract-test-grant",
    installationKeyId: KEY,
    iat: NOW,
    exp: NOW + OFFLINE_PRO_LEASE_MAX_SECONDS,
    capabilities: ["analyze_joint_output"],
    release: {
      policy: { version: "contract-test-policy", sha256: "f".repeat(64) },
      mechanicsModel: { version: "contract-test-mechanics-model", sha256: "c".repeat(64) },
      benchmarkModel: { version: "contract-test-benchmark-model", sha256: "d".repeat(64) },
    },
    entitlementSource: "identity_lifetime_free",
    allocation: allocation(),
  };
}

function proGrant(
  kind: "subscription" | "lifetime" = "subscription",
): Extract<OfflineExecutionGrantClaims, { entitlementSource: "verified_store" }> {
  const { allocation: _allocation, ...base } = grant();
  return {
    ...base,
    entitlementSource: "verified_store",
    lease:
      kind === "subscription"
        ? {
            schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
            kind,
            verifiedEntitlementExpiresAt: NOW + OFFLINE_PRO_LEASE_MAX_SECONDS * 2,
          }
        : {
            schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
            kind,
            verifiedEntitlementExpiresAt: null,
          },
  };
}

function challengeBinding(): OfflineDeviceChallengeBinding {
  return {
    ownerId: OWNER,
    installationKeyId: KEY,
    sessionId: SESSION,
    attestationEnvironment: "production",
    nowEpochSeconds: NOW + 1,
  };
}

function challenge() {
  return {
    schemaVersion: OFFLINE_DEVICE_CHALLENGE_SCHEMA_VERSION,
    purpose: "register_installation" as const,
    challengeId: "contract-test-challenge",
    ownerId: OWNER,
    installationKeyId: KEY,
    sessionId: SESSION,
    nonceBase64Url: "A".repeat(43),
    issuedAt: NOW,
    expiresAt: NOW + 300,
    attestationEnvironment: "production" as const,
  };
}

function attestation(kind: "attestation_object" | "assertion" = "assertion") {
  return {
    schemaVersion: OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
    format: "apple_app_attest" as const,
    kind,
    environment: "production" as const,
    dataBase64Url: "AQIDBA",
    clientDataSha256: HASH,
  };
}

function registration() {
  return {
    schemaVersion: OFFLINE_DEVICE_REGISTRATION_SCHEMA_VERSION,
    challengeId: challenge().challengeId,
    installationKeyId: KEY,
    attestation: attestation("attestation_object"),
  };
}

function lineage(output: "mechanics" | "benchmark"): NumericalOutputLineage {
  return {
    pipeline: { version: "contract-test-pipeline", sha256: HASH },
    definition: { version: `contract-test-${output}-definition`, sha256: HASH },
    model: grant().release[output === "mechanics" ? "mechanicsModel" : "benchmarkModel"],
    preprocessing: { version: "contract-test-preprocessing", sha256: HASH },
    calibration: { version: `contract-test-${output}-calibration`, sha256: HASH },
    policy: grant().release.policy,
    dataset: { version: "contract-test-dataset", sha256: HASH },
    validationReport: { version: `contract-test-${output}-report`, sha256: HASH },
    supportedDomain: { version: "contract-test-domain", sha256: HASH },
  };
}

function outcome(): Extract<AnalysisOutcome, { status: "complete" }> {
  return {
    schemaVersion: ANALYSIS_OUTCOME_SCHEMA_VERSION,
    analysisId: "contract-test-result",
    operationId: "contract-test-operation",
    ownerId: OWNER,
    captureId: "contract-test-capture",
    inputSha256: HASH,
    source: "real",
    status: "complete",
    billingDisposition: "joint_verification_required",
    publication: {
      status: "durably_published",
      publicationId: "contract-test-publication",
      publishedAtIso: "2026-08-29T12:00:00.000Z",
    },
    mechanics: {
      schemaVersion: MECHANICS_OUTPUT_SCHEMA_VERSION,
      scale: "mechanics_0_10",
      status: "validated_score",
      score: 7,
      lineage: lineage("mechanics"),
    },
    benchmark: {
      schemaVersion: TECHNIQUE_BENCHMARK_SCHEMA_VERSION,
      interpretation: TECHNIQUE_BENCHMARK_INTERPRETATION,
      scale: TECHNIQUE_BENCHMARK_SCALE,
      status: "validated_range",
      interval: { lower: 3.5, upper: 4 },
      uncertainty: {
        kind: "calibrated_prediction_interval",
        nominalCoverage: 0.9,
        coverageScope: "marginal",
        calibrationUnit: "player_session",
      },
      lineage: lineage("benchmark"),
    },
  };
}

function eligibility(): IndependentlyVerifiedAnalysisEligibility {
  return {
    schemaVersion: ANALYSIS_ELIGIBILITY_INPUT_SCHEMA_VERSION,
    verificationSource: "independent_release_authority_and_owner_ledger",
    binding: {
      analysisId: outcome().analysisId,
      operationId: outcome().operationId,
      ownerId: OWNER,
      captureId: outcome().captureId,
      inputSha256: HASH,
      publicationId: "contract-test-publication",
    },
    publicationState: "both_outputs_durably_published_once",
    creditState: "unconsumed",
    releaseEligibility: {
      status: "eligible",
      mechanics: { lineage: lineage("mechanics") },
      benchmark: {
        lineage: lineage("benchmark"),
        uncertainty: outcome().benchmark.uncertainty,
        maximumIntervalWidth: 1,
        boundaryStep: 0.5,
        supportedIntervals: [{ lower: 3, upper: 4.5 }],
      },
    },
  };
}

function receipt() {
  return {
    schemaVersion: OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
    receiptId: "contract-test-receipt",
    ownerId: OWNER,
    installationKeyId: KEY,
    grantId: grant().jti,
    grantJwsSha256: HASH,
    ticket: {
      allocationId: allocation().allocationId,
      generation: 1,
      ticketId: allocation().ticketIds[0]!,
    },
    operationId: outcome().operationId,
    resultId: outcome().analysisId,
    fullOutputSha256: HASH,
    billingDisposition: "joint_verification_required" as const,
    lifecycleSequence: 2,
    nativeTime: {
      schemaVersion: OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
      clock: "ios_mach_continuous_time" as const,
      anchorId: "contract-test-anchor",
      elapsedMs: 60_000,
    },
    attestation: attestation(),
  };
}

function receiptBinding(
  selectedGrant: OfflineExecutionGrantClaims = grant(),
): OfflineReceiptBinding {
  return {
    grant: selectedGrant,
    grantJwsSha256: HASH,
    currentOwnerId: OWNER,
    attestationEnvironment: "production",
    clientDataSha256: HASH,
    lastAcceptedLifecycleSequence: 1,
    timeAnchor: {
      schemaVersion: OFFLINE_TIME_ANCHOR_SCHEMA_VERSION,
      anchorId: "contract-test-anchor",
      ownerId: OWNER,
      installationKeyId: KEY,
      grantId: selectedGrant.jti,
      serverEpochSeconds: NOW,
    },
  };
}

function resultBinding(): OfflineResultBinding {
  return { outcome: outcome(), fullOutputSha256: HASH, analysisEligibility: eligibility() };
}

function unusedReturn() {
  const {
    operationId: _operation,
    resultId: _result,
    fullOutputSha256: _output,
    billingDisposition: _billing,
    ...base
  } = receipt();
  return {
    ...base,
    schemaVersion: OFFLINE_UNUSED_TICKET_RETURN_SCHEMA_VERSION,
    terminalState: "returned" as const,
  };
}

function reconciliation() {
  return {
    schemaVersion: OFFLINE_RECONCILIATION_SCHEMA_VERSION,
    ownerId: OWNER,
    receiptId: receipt().receiptId,
    status: "pending",
    financialDisposition: "reserved",
  };
}

describe("W04 protocol and narrow API contract, not implemented routes", () => {
  it("pins fresh-session protected paths and reuses shot sync for canonical results", () => {
    expect(OFFLINE_AUTHORIZATION_API).toEqual({
      deviceChallenge: { method: "POST", path: "/v1/offline/devices/challenge" },
      deviceRegistration: { method: "POST", path: "/v1/offline/devices/register" },
      wallet: { method: "POST", path: "/v1/offline/wallet" },
      reconciliation: { method: "POST", path: "/v1/offline/reconcile" },
      resultSync: { method: "POST", path: "/v1/shots:sync" },
    });
    expect(OFFLINE_AUTHORIZATION_API_AUTH).toEqual({
      authentication: "current_owner_live_account_session",
      sessionCheck: "uncached_is_api_session_active",
      rateLimit: "current_user",
      offlineGrantAsBearer: false,
    });
    expect(OFFLINE_AUTHORIZATION_PROTOCOL_VERSION).toBe("offline-authorization-v1");
    expect(OFFLINE_AUTHORIZATION_TRUST_BOUNDARY).toContain("not cryptographic proof");
    expect(OFFLINE_AUTHORIZATION_TRUST_BOUNDARY).toContain("independent release authority");
    expect(OFFLINE_JWS_REQUIREMENTS).toEqual({
      serialization: "compact",
      algorithm: "ES256",
      protectedHeader: "alg_typ_kid_only",
      signature: "base64url_unpadded_64_byte_r_s",
      keyPurpose: "offline_execution_grant",
      numericDate: "integer_seconds_iat_inclusive_exp_exclusive",
    });
    expect(OFFLINE_RECEIPT_DIGEST_CONTRACT).toEqual({
      algorithm: "SHA-256",
      outputSerialization: "RFC8785_analysis_outcome",
      grantSerialization: "exact_compact_jws_ascii",
      assertionSerialization: "RFC8785_receipt_without_attestation",
    });
  });

  it("keeps legacy used rights spent and execution expiry separate from allocation disposition", () => {
    expect(OFFLINE_FREE_ALLOCATION_POLICY).toEqual({
      id: "identity-lifetime-including-legacy-used-v1",
      budgetScope: "sign_in_identity_lifetime",
      usedCount: "includes_legacy_used",
      newConsumptionRule: "prospective_joint_outputs_only",
      reservations: "online_and_outstanding_offline",
      automaticRelease: "never_on_timeout_reinstall_key_replacement_or_account_deletion",
      recovery: "original_installation_proof_or_explicit_support_review",
    });
    expect(validateOfflineFreeTicketAllocation(allocation()).ok).toBe(true);
    for (const patch of [
      { expiresAt: NOW + 1 },
      { financialExpiry: NOW + 1 },
      { financialExpiry: "execution_expiry" },
      { budgetPolicy: "recompute_legacy_from_benchmark" },
      { available: true },
    ]) {
      expect(validateOfflineFreeTicketAllocation({ ...allocation(), ...patch }).ok).toBe(false);
    }
  });
});

describe("device challenges and registration evidence", () => {
  it("binds a short-lived challenge to the current account, session, installation and environment", () => {
    expect(validateOfflineDeviceChallenge(challenge(), challengeBinding()).ok).toBe(true);
    expect(
      validateOfflineDeviceRegistration(registration(), challenge(), challengeBinding(), HASH).ok,
    ).toBe(true);
    for (const patch of [
      { ownerId: OTHER_OWNER },
      { sessionId: OTHER_OWNER },
      { installationKeyId: "another-key" },
      { attestationEnvironment: "development" },
      { purpose: "authorize_api" },
      { schemaVersion: "offline-device-challenge-v2" },
      { expiresAt: NOW + 301 },
      { issuedAt: NOW + 2 },
      { expiresAt: NOW + 1 },
      { nonceBase64Url: "short" },
    ]) {
      expect(
        validateOfflineDeviceChallenge({ ...challenge(), ...patch }, challengeBinding()).ok,
      ).toBe(false);
    }
  });

  it.each(INVALID_TIMES)("refuses unsafe challenge timestamps %s without coercion", (time) => {
    for (const field of ["issuedAt", "expiresAt"]) {
      expect(
        validateOfflineDeviceChallenge({ ...challenge(), [field]: time }, challengeBinding()).ok,
      ).toBe(false);
    }
    expect(
      validateOfflineDeviceChallenge(challenge(), {
        ...challengeBinding(),
        nowEpochSeconds: time,
      } as OfflineDeviceChallengeBinding).ok,
    ).toBe(false);
  });

  it("does not treat evidence shape as attestation verification or a reusable challenge", () => {
    for (const patch of [
      { challengeId: "other" },
      { installationKeyId: "other" },
      { schemaVersion: "v2" },
      { verified: true },
      { attestation: { ...attestation("attestation_object"), kind: "assertion" } },
      { attestation: { ...attestation("attestation_object"), environment: "development" } },
      { attestation: { ...attestation("attestation_object"), clientDataSha256: OTHER_HASH } },
      { attestation: { ...attestation("attestation_object"), schemaVersion: "future" } },
      { attestation: { ...attestation("attestation_object"), format: "keychain_uuid" } },
      { attestation: { ...attestation("attestation_object"), dataBase64Url: "AQIDBA==" } },
    ]) {
      expect(
        validateOfflineDeviceRegistration(
          { ...registration(), ...patch },
          challenge(),
          challengeBinding(),
          HASH,
        ).ok,
      ).toBe(false);
    }
    expect(
      validateOfflineDeviceRegistration(
        registration(),
        challenge(),
        { ...challengeBinding(), nowEpochSeconds: NOW + 300 },
        HASH,
      ).ok,
    ).toBe(false);
  });
});

describe("ES256 compact JWS transport shape and separately decoded metadata binding", () => {
  it("accepts only a versioned compact shape, without pretending placeholder signature bytes are verified", () => {
    const value = {
      schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
      compactJws: `e30.e30.${"A".repeat(86)}`,
    };
    expect(validateOfflineSignedGrantShape(value)).toEqual({ ok: true, value });
    for (const compactJws of [
      "",
      "e30.e30",
      `e30..${"A".repeat(86)}`,
      `e30.e30.${"A".repeat(85)}`,
      `e30.e30.${"A".repeat(85)}B`,
      `e30=.e30.${"A".repeat(86)}`,
      `${value.compactJws}.extra`,
      `${value.compactJws} `,
    ]) {
      expect(validateOfflineSignedGrantShape({ ...value, compactJws }).ok).toBe(false);
    }
    expect(validateOfflineSignedGrantShape({ ...value, schemaVersion: "future" }).ok).toBe(false);
    expect(validateOfflineSignedGrantShape({ ...value, claims: grant() }).ok).toBe(false);
    expect(validateOfflineExecutionGrantMetadata({}, {}, grantBinding()).ok).toBe(false);
  });

  it("binds exact issuer, scoped audience, allowlisted signing key, canonical owner and installation", () => {
    expect(validateOfflineExecutionGrantMetadata(header(), grant(), grantBinding()).ok).toBe(true);
    expect(
      validateOfflineExecutionGrantMetadata(
        { ...header(), kid: "contract-test-rotated-signing-key" },
        grant(),
        grantBinding(),
      ).ok,
    ).toBe(true);
    for (const patch of [
      { alg: "none" },
      { alg: "HS256" },
      { alg: "ES384" },
      { alg: "es256" },
      { typ: "JWT" },
      { kid: "contract-test-offline-signing-key-extra" },
      { kid: "unknown" },
      { crit: [] },
      { b64: false },
      { jwk: {} },
      { jku: "https://contract-test.invalid/key" },
      { privateKey: undefined },
    ]) {
      expect(
        validateOfflineExecutionGrantMetadata({ ...header(), ...patch }, grant(), grantBinding())
          .ok,
      ).toBe(false);
    }
    for (const patch of [
      { iss: `${grant().iss}/` },
      { aud: "authenticated" },
      { aud: [OFFLINE_GRANT_AUDIENCE] },
      { sub: OTHER_OWNER },
      { sub: OWNER.toUpperCase() },
      { sub: "device-guest" },
      { sub: ` ${OWNER}` },
      { installationKeyId: "new-installation" },
      { schemaVersion: "future" },
      { protocolVersion: "future" },
      { capabilities: ["api:* "] },
      { capabilities: [] },
      { capabilities: ["analyze_joint_output", "analyze_joint_output"] },
    ]) {
      expect(
        validateOfflineExecutionGrantMetadata(header(), { ...grant(), ...patch }, grantBinding())
          .ok,
      ).toBe(false);
    }
    for (const allowedKeyIds of [[], ["*"], [header().kid, header().kid], [header().kid, ""]]) {
      expect(
        validateOfflineExecutionGrantMetadata(header(), grant(), {
          ...grantBinding(),
          allowedKeyIds,
        }).ok,
      ).toBe(false);
    }
  });

  it("preserves opaque App Attest installation key IDs, including base64 punctuation", () => {
    for (const installationKeyId of [
      `/${"A".repeat(42)}=`,
      `+${"A".repeat(42)}=`,
      "_installation-key",
    ]) {
      expect(
        validateOfflineExecutionGrantMetadata(
          header(),
          { ...grant(), installationKeyId },
          { ...grantBinding(), installationKeyId },
        ).ok,
      ).toBe(true);
      expect(
        validateOfflineDeviceChallenge(
          { ...challenge(), installationKeyId },
          { ...challengeBinding(), installationKeyId },
        ).ok,
      ).toBe(true);
    }
  });

  it("rejects accessor discriminants without evaluating caller code", () => {
    let reads = 0;
    const getter = {
      enumerable: true,
      get: () => {
        reads += 1;
        return "unregistered";
      },
    };
    const untrustedGrant = Object.defineProperty(grant(), "entitlementSource", getter);
    const untrustedStatus = Object.defineProperty(
      { schemaVersion: OFFLINE_AUTHORIZATION_STATUS_SCHEMA_VERSION },
      "status",
      getter,
    );
    const untrustedReconciliation = Object.defineProperty(
      reconciliation(),
      "schemaVersion",
      getter,
    );
    expect(validateOfflineExecutionGrantMetadata(header(), untrustedGrant, grantBinding()).ok).toBe(
      false,
    );
    expect(validateOfflineAuthorizationStatus(untrustedStatus).ok).toBe(false);
    expect(validateOfflineReconciliationStatus(untrustedReconciliation, receipt()).ok).toBe(false);
    expect(reads).toBe(0);
  });

  it.each(INVALID_TIMES)("rejects unsafe grant NumericDate %s", (time) => {
    for (const field of ["iat", "exp"]) {
      expect(
        validateOfflineExecutionGrantMetadata(
          header(),
          { ...grant(), [field]: time },
          grantBinding(),
        ).ok,
      ).toBe(false);
    }
  });

  it("requires both model references and the shared release policy without inventing an approval registry", () => {
    for (const key of ["policy", "mechanicsModel", "benchmarkModel"] as const) {
      for (const artifact of [
        null,
        { version: "", sha256: HASH },
        { version: "contract-test-only", sha256: "bad" },
        { version: "contract-test-only", sha256: HASH, approved: true },
      ]) {
        expect(
          validateOfflineExecutionGrantMetadata(
            header(),
            { ...grant(), release: { ...grant().release, [key]: artifact } },
            grantBinding(),
          ).ok,
        ).toBe(false);
      }
    }
    expect(
      validateOfflineExecutionGrantMetadata(
        header(),
        { ...grant(), release: { ...grant().release, expiresAt: grant().exp + 1 } },
        grantBinding(),
      ).ok,
    ).toBe(false);
    expect(
      validateOfflineExecutionGrantMetadata(header(), { ...grant(), exp: NOW }, grantBinding()).ok,
    ).toBe(false);
    expect(
      validateOfflineExecutionGrantMetadata(header(), { ...grant(), premium: true }, grantBinding())
        .ok,
    ).toBe(false);
  });

  it("rejects empty, duplicated, sparse, decorated or conflicting free allocations", () => {
    for (const patch of [
      { ticketIds: [] },
      { ticketIds: ["same", "same"] },
      { ticketIds: ["one", "two", "three"] },
      { ticketIds: new Array(1) },
      { ticketIds: Object.assign(["one"], { available: true }) },
      { generation: 0 },
      { generation: 1.5 },
      { generation: Number.MAX_SAFE_INTEGER + 1 },
      { schemaVersion: "future" },
    ]) {
      expect(validateOfflineFreeTicketAllocation({ ...allocation(), ...patch }).ok).toBe(false);
    }
    expect(
      validateOfflineExecutionGrantMetadata(
        header(),
        { ...grant(), lease: proGrant().lease },
        grantBinding(),
      ).ok,
    ).toBe(false);
    expect(
      validateOfflineExecutionGrantMetadata(
        header(),
        { ...proGrant(), allocation: allocation() },
        grantBinding(),
      ).ok,
    ).toBe(false);
    expect(
      validateOfflineExecutionGrantMetadata(
        header(),
        { ...grant(), entitlementSource: "billing_pending" },
        grantBinding(),
      ).ok,
    ).toBe(false);
  });

  it("caps Pro at the earlier of seven days and verified subscription expiry, including lifetime", () => {
    expect(OFFLINE_PRO_LEASE_MAX_SECONDS).toBe(7 * 24 * 60 * 60);
    for (const kind of ["subscription", "lifetime"] as const) {
      expect(
        validateOfflineExecutionGrantMetadata(header(), proGrant(kind), grantBinding()).ok,
      ).toBe(true);
      expect(
        validateOfflineExecutionGrantMetadata(
          header(),
          { ...proGrant(kind), exp: NOW + OFFLINE_PRO_LEASE_MAX_SECONDS + 1 },
          grantBinding(),
        ).ok,
      ).toBe(false);
    }
    const shortLease = {
      ...proGrant(),
      exp: NOW + 60,
      lease: { ...proGrant().lease, kind: "subscription", verifiedEntitlementExpiresAt: NOW + 60 },
    };
    expect(validateOfflineExecutionGrantMetadata(header(), shortLease, grantBinding()).ok).toBe(
      true,
    );
    expect(
      validateOfflineExecutionGrantMetadata(
        header(),
        { ...shortLease, exp: NOW + 61 },
        grantBinding(),
      ).ok,
    ).toBe(false);
    for (const patch of [
      { kind: "subscription", verifiedEntitlementExpiresAt: null },
      { kind: "lifetime", verifiedEntitlementExpiresAt: NOW + 60 },
      { kind: "pending" },
      { verified: true },
      { schemaVersion: "future" },
      ...INVALID_TIMES.map((verifiedEntitlementExpiresAt) => ({ verifiedEntitlementExpiresAt })),
      { verifiedEntitlementExpiresAt: NOW },
    ]) {
      expect(
        validateOfflineExecutionGrantMetadata(
          header(),
          { ...proGrant(), lease: { ...proGrant().lease, ...patch } },
          grantBinding(),
        ).ok,
      ).toBe(false);
    }
  });
});

describe("immutable original-operation/result receipts", () => {
  it("validates bindings only and returns an immutable detached snapshot", () => {
    const raw = receipt();
    const before = JSON.stringify(raw);
    const parsed = validateOfflineResultReceiptBinding(raw, receiptBinding(), resultBinding());
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(raw)).toBe(before);
    if (!parsed.ok) throw new Error("contract fixture rejected");
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.ticket)).toBe(true);
    expect(Object.isFrozen(parsed.value.nativeTime)).toBe(true);
    raw.operationId = "later-operation";
    raw.nativeTime.elapsedMs = 999;
    expect(parsed.value.operationId).toBe(outcome().operationId);
    expect(parsed.value.nativeTime.elapsedMs).toBe(60_000);
    expect(
      validateOfflineResultReceiptBinding(parsed.value, receiptBinding(), resultBinding()).ok,
    ).toBe(true);
  });

  it("checks owner, device, grant bytes, allocation generation, operation, result and complete-output digest", () => {
    for (const patch of [
      { ownerId: OTHER_OWNER },
      { installationKeyId: "replacement-key" },
      { grantId: "other-grant" },
      { grantJwsSha256: OTHER_HASH },
      { operationId: "other-operation" },
      { resultId: "other-result" },
      { fullOutputSha256: OTHER_HASH },
      { ticket: null },
      { ticket: { ...receipt().ticket, ticketId: "other-ticket" } },
      { ticket: { ...receipt().ticket, allocationId: "other-allocation" } },
      { ticket: { ...receipt().ticket, generation: 2 } },
      { schemaVersion: "future" },
      { outcome: outcome() },
      { verified: true },
      { refreshToken: undefined },
    ]) {
      expect(
        validateOfflineResultReceiptBinding(
          { ...receipt(), ...patch },
          receiptBinding(),
          resultBinding(),
        ).ok,
      ).toBe(false);
    }
    expect(
      validateOfflineResultReceiptBinding(
        receipt(),
        { ...receiptBinding(), currentOwnerId: OTHER_OWNER },
        resultBinding(),
      ).ok,
    ).toBe(false);
    expect(
      validateOfflineResultReceiptBinding(receipt(), receiptBinding(), {
        ...resultBinding(),
        fullOutputSha256: OTHER_HASH,
      }).ok,
    ).toBe(false);
    expect(
      validateOfflineResultReceiptBinding(receipt(), receiptBinding(proGrant()), resultBinding())
        .ok,
    ).toBe(false);
    expect(
      validateOfflineResultReceiptBinding(
        { ...receipt(), ticket: null },
        receiptBinding(proGrant()),
        resultBinding(),
      ).ok,
    ).toBe(true);
  });

  it("reuses the shared joint-output release/ledger predicate, not just a complete tag", () => {
    expect(
      validateOfflineResultReceiptBinding(receipt(), receiptBinding(), {
        ...resultBinding(),
        analysisEligibility: null,
      }).ok,
    ).toBe(false);
    for (const patch of [
      { creditState: "already_consumed" },
      { publicationState: "not_verified" },
      { verificationSource: "client_payload" },
      { releaseEligibility: { status: "eligible" } },
    ]) {
      expect(
        validateOfflineResultReceiptBinding(receipt(), receiptBinding(), {
          ...resultBinding(),
          analysisEligibility: {
            ...eligibility(),
            ...patch,
          } as IndependentlyVerifiedAnalysisEligibility,
        }).ok,
      ).toBe(false);
    }
    const unsupported = eligibility();
    if (unsupported.releaseEligibility.status !== "eligible") throw new Error("contract fixture");
    unsupported.releaseEligibility.benchmark.supportedIntervals = [{ lower: 4, upper: 5 }];
    expect(
      validateOfflineResultReceiptBinding(receipt(), receiptBinding(), {
        ...resultBinding(),
        analysisEligibility: unsupported,
      }).ok,
    ).toBe(false);
    for (const output of ["mechanics", "benchmark"] as const) {
      const differentRelease = grant();
      const key = output === "mechanics" ? "mechanicsModel" : "benchmarkModel";
      const changed = {
        ...differentRelease,
        release: {
          ...differentRelease.release,
          [key]: { ...differentRelease.release[key], sha256: OTHER_HASH },
        },
      };
      expect(
        validateOfflineResultReceiptBinding(receipt(), receiptBinding(changed), resultBinding()).ok,
      ).toBe(false);
    }
  });

  it("preserves either partial output without spending or releasing the same free ticket", () => {
    const withheldMechanics = {
      schemaVersion: MECHANICS_OUTPUT_SCHEMA_VERSION,
      scale: "mechanics_0_10",
      status: "blocked_validation",
      reasonCodes: ["validation_not_approved"],
    };
    const withheldBenchmark = {
      schemaVersion: TECHNIQUE_BENCHMARK_SCHEMA_VERSION,
      scale: TECHNIQUE_BENCHMARK_SCALE,
      interpretation: TECHNIQUE_BENCHMARK_INTERPRETATION,
      status: "blocked_validation",
      reasonCodes: ["validation_not_approved"],
    };
    for (const outputs of [
      { mechanics: outcome().mechanics, benchmark: withheldBenchmark },
      { mechanics: withheldMechanics, benchmark: outcome().benchmark },
      { mechanics: withheldMechanics, benchmark: withheldBenchmark },
    ]) {
      const status =
        outputs.mechanics === withheldMechanics && outputs.benchmark === withheldBenchmark
          ? "abstained"
          : "partial";
      const partial = { ...outcome(), ...outputs, status, billingDisposition: "not_chargeable" };
      const localReceipt = { ...receipt(), billingDisposition: "not_chargeable" };
      const binding = { outcome: partial, fullOutputSha256: HASH, analysisEligibility: null };
      expect(validateOfflineResultReceiptBinding(localReceipt, receiptBinding(), binding).ok).toBe(
        true,
      );
      expect(validateOfflineResultReceiptBinding(receipt(), receiptBinding(), binding).ok).toBe(
        false,
      );
      expect(
        validateOfflineResultReceiptBinding(localReceipt, receiptBinding(), {
          ...binding,
          outcome: {
            ...partial,
            status: "complete",
            billingDisposition: "joint_verification_required",
          },
        }).ok,
      ).toBe(false);
      expect(
        validateOfflineReconciliationStatus(
          { ...reconciliation(), status: "result_recorded", resultId: receipt().resultId },
          localReceipt,
        ).ok,
      ).toBe(true);
      expect(
        validateOfflineReconciliationStatus(
          {
            ...reconciliation(),
            status: "result_recorded",
            resultId: receipt().resultId,
            financialDisposition: "consumed",
          },
          localReceipt,
        ).ok,
      ).toBe(false);
    }
  });

  it("transmits only app-event elapsed time, with no device boot or uptime signals", () => {
    const nativeTime = {
      schemaVersion: OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
      clock: "ios_mach_continuous_time" as const,
      anchorId: "contract-test-anchor",
      elapsedMs: 60_000,
    };
    expect(validateOfflineResultReceiptShape({ ...receipt(), nativeTime }).ok).toBe(true);
    for (const extra of [
      { bootSessionId: "contract-test-boot" },
      { bootUuid: "device-boot" },
      { bootHash: HASH },
      { bootCount: 2 },
      { systemUptimeMs: 100_000 },
      { machTicks: 1234 },
      { bootEpochSeconds: NOW },
    ]) {
      expect(
        validateOfflineResultReceiptShape({ ...receipt(), nativeTime: { ...nativeTime, ...extra } })
          .ok,
      ).toBe(false);
      const binding = receiptBinding();
      expect(
        validateOfflineResultReceiptBinding(
          receipt(),
          { ...binding, timeAnchor: { ...binding.timeAnchor, ...extra } },
          resultBinding(),
        ).ok,
      ).toBe(false);
    }
  });

  it("checks versioned native anchor/time and assertion evidence, not arbitrary client wall time", () => {
    for (const patch of [
      { schemaVersion: "future" },
      { clock: "Date.now" },
      { anchorId: "other-anchor" },
      { bootSessionId: "after-reboot" },
      { elapsedMs: -1 },
      { elapsedMs: NaN },
      { elapsedMs: Infinity },
      { elapsedMs: "60000" },
      { elapsedMs: Number.MAX_SAFE_INTEGER + 1 },
      { elapsedMs: OFFLINE_PRO_LEASE_MAX_SECONDS * 1000 },
      { executedAtIso: "2026-08-29T12:00:00.000Z" },
    ]) {
      expect(
        validateOfflineResultReceiptBinding(
          { ...receipt(), nativeTime: { ...receipt().nativeTime, ...patch } },
          receiptBinding(),
          resultBinding(),
        ).ok,
      ).toBe(false);
    }
    for (const patch of [
      { schemaVersion: "future" },
      { kind: "attestation_object" },
      { format: "unverified_uuid" },
      { environment: "development" },
      { clientDataSha256: OTHER_HASH },
      { dataBase64Url: "" },
      { verified: true },
    ]) {
      expect(
        validateOfflineResultReceiptBinding(
          { ...receipt(), attestation: { ...attestation(), ...patch } },
          receiptBinding(),
          resultBinding(),
        ).ok,
      ).toBe(false);
    }
    for (const patch of [
      { ownerId: OTHER_OWNER },
      { installationKeyId: "other" },
      { grantId: "other" },
      { serverEpochSeconds: NOW - 1 },
      { serverEpochSeconds: grant().exp },
      { serverEpochSeconds: NaN },
      { schemaVersion: "future" },
    ]) {
      expect(
        validateOfflineResultReceiptBinding(
          receipt(),
          {
            ...receiptBinding(),
            timeAnchor: { ...receiptBinding().timeAnchor, ...patch },
          } as OfflineReceiptBinding,
          resultBinding(),
        ).ok,
      ).toBe(false);
    }
    for (const lifecycleSequence of [0, 1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        validateOfflineResultReceiptBinding(
          { ...receipt(), lifecycleSequence },
          receiptBinding(),
          resultBinding(),
        ).ok,
      ).toBe(false);
    }
  });

  it("uses authorization at execution, including the last millisecond, not upload time or the old 24-hour permit", () => {
    const expiredAtUpload = proGrant();
    const atEnd = {
      ...receipt(),
      ticket: null,
      nativeTime: { ...receipt().nativeTime, elapsedMs: OFFLINE_PRO_LEASE_MAX_SECONDS * 1000 - 1 },
    };
    expect(
      validateOfflineResultReceiptBinding(atEnd, receiptBinding(expiredAtUpload), resultBinding())
        .ok,
    ).toBe(true);
    expect(
      validateOfflineResultReceiptBinding(
        {
          ...atEnd,
          nativeTime: { ...atEnd.nativeTime, elapsedMs: OFFLINE_PRO_LEASE_MAX_SECONDS * 1000 },
        },
        receiptBinding(expiredAtUpload),
        resultBinding(),
      ).ok,
    ).toBe(false);
    expect(
      validateOfflineResultReceiptBinding(
        { ...atEnd, uploadedAt: expiredAtUpload.exp + 30 * 86400 },
        receiptBinding(expiredAtUpload),
        resultBinding(),
      ).ok,
    ).toBe(false);
  });

  it("rejects non-JSON shapes, hidden fields, accessors and sparse decorated capabilities", () => {
    for (const value of [
      null,
      [],
      new Date(),
      Object.assign(Object.create({ inherited: true }), receipt()),
      { ...receipt(), [Symbol("hidden")]: true },
      Object.defineProperty(receipt(), "ownerId", { get: () => OWNER }),
      Object.defineProperty(receipt(), "hidden", { value: true }),
    ]) {
      expect(validateOfflineResultReceiptShape(value).ok).toBe(false);
    }
    expect(
      validateOfflineExecutionGrantMetadata(
        header(),
        { ...grant(), capabilities: new Array(1) },
        grantBinding(),
      ).ok,
    ).toBe(false);
    expect(
      validateOfflineExecutionGrantMetadata(
        header(),
        { ...grant(), capabilities: Object.assign(["analyze_joint_output"], { bearer: true }) },
        grantBinding(),
      ).ok,
    ).toBe(false);
  });
});

describe("terminal unused-ticket returns and truthful reconciliation", () => {
  it("requires original installation proof and monotonic generation/sequence, even after execution expiry", () => {
    expect(validateOfflineUnusedTicketReturnBinding(unusedReturn(), receiptBinding()).ok).toBe(
      true,
    );
    expect(
      validateOfflineUnusedTicketReturnBinding(
        {
          ...unusedReturn(),
          nativeTime: {
            ...unusedReturn().nativeTime,
            elapsedMs: (OFFLINE_PRO_LEASE_MAX_SECONDS + 86400) * 1000,
          },
        },
        receiptBinding(),
      ).ok,
    ).toBe(true);
    for (const patch of [
      { terminalState: "available" },
      { terminalState: "spent" },
      { schemaVersion: "future" },
      { ownerId: OTHER_OWNER },
      { installationKeyId: "new-install" },
      { grantId: "other" },
      { grantJwsSha256: OTHER_HASH },
      { lifecycleSequence: 1 },
      { ticket: null },
      { ticket: { ...receipt().ticket, generation: 0 } },
      { ticket: { ...receipt().ticket, generation: 2 } },
      { resultId: outcome().analysisId },
      { expiresAt: NOW },
      { proof: "verified" },
    ]) {
      expect(
        validateOfflineUnusedTicketReturnBinding({ ...unusedReturn(), ...patch }, receiptBinding())
          .ok,
      ).toBe(false);
    }
    expect(
      validateOfflineUnusedTicketReturnBinding(unusedReturn(), receiptBinding(proGrant())).ok,
    ).toBe(false);
    expect(
      validateOfflineUnusedTicketReturnBinding(unusedReturn(), {
        ...receiptBinding(),
        currentOwnerId: OTHER_OWNER,
      }).ok,
    ).toBe(false);
  });

  it("keeps unresolved free allocations reserved and acknowledges only the matching immutable receipt", () => {
    expect(validateOfflineReconciliationStatus(reconciliation(), receipt()).ok).toBe(true);
    for (const reasonCode of [
      "evidence_missing",
      "evidence_ambiguous",
      "conflicting_receipt",
      "owner_mismatch",
      "account_deleted",
      "grant_revoked",
    ]) {
      expect(
        validateOfflineReconciliationStatus(
          { ...reconciliation(), status: "reconciliation_required", reasonCode },
          receipt(),
        ).ok,
      ).toBe(true);
    }
    expect(
      validateOfflineReconciliationStatus(
        {
          ...reconciliation(),
          status: "support_review_required",
          reasonCode: "original_installation_lost",
        },
        receipt(),
      ).ok,
    ).toBe(true);
    expect(
      validateOfflineReconciliationStatus(
        {
          ...reconciliation(),
          status: "result_recorded",
          resultId: receipt().resultId,
          financialDisposition: "consumed",
        },
        receipt(),
      ).ok,
    ).toBe(true);
    expect(
      validateOfflineReconciliationStatus(
        { ...reconciliation(), status: "unused_ticket_returned", financialDisposition: "returned" },
        unusedReturn(),
      ).ok,
    ).toBe(true);
    expect(
      validateOfflineReconciliationStatus(
        { ...reconciliation(), financialDisposition: "not_applicable" },
        { ...receipt(), ticket: null },
      ).ok,
    ).toBe(true);
    for (const patch of [
      { financialDisposition: "returned" },
      { financialDisposition: "expired" },
      { financialDisposition: "available" },
      { financialDisposition: "consumed" },
      { ownerId: OTHER_OWNER },
      { receiptId: "other-receipt" },
      { schemaVersion: "future" },
      { status: "reconciliation_required", reasonCode: "automatically_refunded" },
      { status: "unused_ticket_returned", financialDisposition: "returned" },
      { status: "result_recorded", resultId: "different-result", financialDisposition: "consumed" },
    ]) {
      expect(
        validateOfflineReconciliationStatus({ ...reconciliation(), ...patch }, receipt()).ok,
      ).toBe(false);
    }
  });

  it("represents unsupported, unregistered, unattested, expired and reconciliation-required states without a premium fallback", () => {
    const states = [
      { status: "signed_out" },
      { status: "unregistered" },
      { status: "unsupported", reasonCode: "simulator" },
      { status: "unsupported", reasonCode: "platform" },
      { status: "unsupported", reasonCode: "model_unavailable" },
      { status: "unattested", reasonCode: "attestation_pending" },
      { status: "unattested", reasonCode: "attestation_service_unavailable" },
      { status: "unattested", reasonCode: "attestation_rejected" },
      { status: "grant_verification_required", grantId: grant().jti },
      { status: "entitlement_verification_required" },
      { status: "expired", grantId: grant().jti },
      { status: "reconciliation_required", reasonCode: "untrusted_time" },
      { status: "reconciliation_required", reasonCode: "original_installation_lost" },
      { status: "reconciliation_required", reasonCode: "ambiguous_spend" },
      { status: "reconciliation_required", reasonCode: "grant_revoked" },
    ];
    for (const state of states) {
      const value = { schemaVersion: OFFLINE_AUTHORIZATION_STATUS_SCHEMA_VERSION, ...state };
      expect(validateOfflineAuthorizationStatus(value).ok).toBe(true);
      expect(validateOfflineAuthorizationStatus({ ...value, premium: true }).ok).toBe(false);
      expect(validateOfflineAuthorizationStatus({ ...value, schemaVersion: "future" }).ok).toBe(
        false,
      );
    }
    expect(
      validateOfflineAuthorizationStatus({
        schemaVersion: OFFLINE_AUTHORIZATION_STATUS_SCHEMA_VERSION,
        status: "offline_authorized",
        verified: true,
      }).ok,
    ).toBe(false);
  });
});
