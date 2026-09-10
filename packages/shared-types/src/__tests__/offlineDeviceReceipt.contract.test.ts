import { describe, expect, it } from "vitest";
import {
  OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
  OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
  OFFLINE_RECONCILIATION_SCHEMA_VERSION,
  OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
  validateOfflineDeviceReceiptShape,
  validateOfflineReconciliationStatus,
  validateOfflineResultReceiptShape,
} from "../index.js";

const OWNER = "12345678-1234-4234-8234-123456789abc";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const RESULT_ID = "7b000000-0404-4000-8000-000000000001";

/** The exact entry apps/mobile/src/data/api.ts `OfflineReceiptSubmission`
 * persists and posts — key set frozen 2026-09-08 (1.0 wire contract). */
function deviceReceipt(): Record<string, unknown> {
  return {
    receiptId: "mobile-receipt-1",
    ownerId: OWNER,
    installationKeyId: "mobile-installation-key",
    grantId: "mobile-grant-1",
    grantJwsSha256: HASH,
    lifecycleSequence: 1,
    ticket: { allocationId: "mobile-allocation", generation: 1, ticketId: "mobile-ticket" },
    operationId: "mobile-operation-1",
    resultId: RESULT_ID,
    fullOutputSha256: OTHER_HASH,
    billingDisposition: "joint_verification_required",
    queuedAt: "2026-09-08T12:00:00.000Z",
  };
}

function fullEvidenceReceipt(): Record<string, unknown> {
  const { queuedAt: _queuedAt, ...bound } = deviceReceipt();
  return {
    schemaVersion: OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
    ...bound,
    nativeTime: {
      schemaVersion: OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
      clock: "ios_mach_continuous_time",
      anchorId: "contract-test-anchor",
      elapsedMs: 60_000,
    },
    attestation: {
      schemaVersion: OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
      format: "apple_app_attest",
      kind: "assertion",
      environment: "production",
      dataBase64Url: "AQIDBA",
      clientDataSha256: HASH,
    },
  };
}

function status(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: OFFLINE_RECONCILIATION_SCHEMA_VERSION,
    ownerId: OWNER,
    receiptId: "mobile-receipt-1",
    ...overrides,
  };
}

describe("W04-04 device receipt (mobile OfflineReceiptSubmission) shape", () => {
  it("accepts the exact mobile submission and freezes an immutable copy", () => {
    const parsed = validateOfflineDeviceReceiptShape(deviceReceipt());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(deviceReceipt());
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.ticket)).toBe(true);
    expect(Object.keys(parsed.value)).toEqual([
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
    ]);
  });

  it("accepts a Pro lease receipt (ticket null) and a recorded abstention", () => {
    expect(validateOfflineDeviceReceiptShape({ ...deviceReceipt(), ticket: null }).ok).toBe(true);
    expect(
      validateOfflineDeviceReceiptShape({
        ...deviceReceipt(),
        billingDisposition: "not_chargeable",
      }).ok,
    ).toBe(true);
  });

  it("refuses every server-side or full-evidence field the device never sends", () => {
    const full = fullEvidenceReceipt();
    for (const [field, value] of [
      ["schemaVersion", OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION],
      ["nativeTime", full.nativeTime],
      ["attestation", full.attestation],
      ["settlement", { status: "pending", financialDisposition: "reserved" }],
      ["settledAt", "2026-09-08T12:00:01.000Z"],
      ["extra", true],
    ] as const) {
      const rejected = validateOfflineDeviceReceiptShape({ ...deviceReceipt(), [field]: value });
      expect(rejected.ok, field).toBe(false);
      if (!rejected.ok) {
        expect(rejected.failure.code).toBe("offline_authorization.invalid_device_receipt_shape");
      }
    }
    expect(validateOfflineDeviceReceiptShape(fullEvidenceReceipt()).ok).toBe(false);
  });

  it("refuses a missing field, a malformed binding and a non-ISO queue instant", () => {
    for (const field of Object.keys(deviceReceipt())) {
      const { [field]: _dropped, ...missing } = deviceReceipt();
      expect(validateOfflineDeviceReceiptShape(missing).ok, `missing ${field}`).toBe(false);
    }
    for (const bad of [
      { receiptId: "" },
      { receiptId: "x".repeat(129) },
      { ownerId: "not-a-uuid" },
      { installationKeyId: 7 },
      { grantId: null },
      { grantJwsSha256: HASH.toUpperCase() },
      { grantJwsSha256: HASH.slice(1) },
      { lifecycleSequence: 0 },
      { lifecycleSequence: 1.5 },
      { lifecycleSequence: "1" },
      { ticket: {} },
      { ticket: { allocationId: "a", generation: 0, ticketId: "t" } },
      { ticket: { allocationId: "a", generation: 1, ticketId: "t", extra: 1 } },
      { operationId: "has space" },
      { resultId: "" },
      { fullOutputSha256: "zz" },
      { billingDisposition: "consumed" },
      { billingDisposition: "not_applicable" },
      { queuedAt: 1_788_000_000 },
      { queuedAt: "2026-09-08T12:00:00" },
      { queuedAt: "2026-09-08T12:00:00+02:00" },
      { queuedAt: "2026-13-08T12:00:00.000Z" },
      { queuedAt: "not-a-date" },
    ]) {
      expect(
        validateOfflineDeviceReceiptShape({ ...deviceReceipt(), ...bad }).ok,
        JSON.stringify(bad),
      ).toBe(false);
    }
    for (const notARecord of [null, undefined, "receipt", 1, [], [deviceReceipt()]]) {
      expect(validateOfflineDeviceReceiptShape(notARecord).ok).toBe(false);
    }
  });

  it("keeps the v1 full-evidence result receipt validator intact", () => {
    expect(validateOfflineResultReceiptShape(fullEvidenceReceipt()).ok).toBe(true);
    expect(validateOfflineResultReceiptShape(deviceReceipt()).ok).toBe(false);
    expect(
      validateOfflineResultReceiptShape({
        ...fullEvidenceReceipt(),
        queuedAt: "2026-09-08T12:00:00.000Z",
      }).ok,
    ).toBe(false);
    const { nativeTime: _nativeTime, ...withoutTime } = fullEvidenceReceipt();
    expect(validateOfflineResultReceiptShape(withoutTime).ok).toBe(false);
  });

  it("checks the route's reconciliation verdict against the device receipt it answers", () => {
    const receipt = deviceReceipt();
    expect(
      validateOfflineReconciliationStatus(
        status({ status: "pending", financialDisposition: "reserved" }),
        receipt,
      ).ok,
    ).toBe(true);
    expect(
      validateOfflineReconciliationStatus(
        status({
          status: "result_recorded",
          resultId: RESULT_ID,
          financialDisposition: "consumed",
        }),
        receipt,
      ).ok,
    ).toBe(true);
    expect(
      validateOfflineReconciliationStatus(
        status({
          status: "reconciliation_required",
          reasonCode: "conflicting_receipt",
          financialDisposition: "reserved",
        }),
        receipt,
      ).ok,
    ).toBe(true);
    // A verdict that names a different result, consumes an abstention or a
    // lease, or pairs a ticket with not_applicable is not this receipt's.
    expect(
      validateOfflineReconciliationStatus(
        status({
          status: "result_recorded",
          resultId: "7b000000-0404-4000-8000-000000000002",
          financialDisposition: "consumed",
        }),
        receipt,
      ).ok,
    ).toBe(false);
    expect(
      validateOfflineReconciliationStatus(
        status({
          status: "result_recorded",
          resultId: RESULT_ID,
          financialDisposition: "consumed",
        }),
        { ...receipt, billingDisposition: "not_chargeable" },
      ).ok,
    ).toBe(false);
    expect(
      validateOfflineReconciliationStatus(
        status({
          status: "result_recorded",
          resultId: RESULT_ID,
          financialDisposition: "consumed",
        }),
        { ...receipt, ticket: null },
      ).ok,
    ).toBe(false);
    expect(
      validateOfflineReconciliationStatus(
        status({
          status: "result_recorded",
          resultId: RESULT_ID,
          financialDisposition: "not_applicable",
        }),
        { ...receipt, ticket: null },
      ).ok,
    ).toBe(true);
    expect(
      validateOfflineReconciliationStatus(
        status({ status: "pending", financialDisposition: "not_applicable" }),
        receipt,
      ).ok,
    ).toBe(false);
    expect(
      validateOfflineReconciliationStatus(
        status({ status: "unused_ticket_returned", financialDisposition: "returned" }),
        receipt,
      ).ok,
    ).toBe(false);
  });
});
