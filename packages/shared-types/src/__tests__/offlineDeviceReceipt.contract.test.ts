// W04-04 — the 1.0 receipt wire contract. The shipping app persists and
// submits OfflineReceiptSubmission (apps/mobile/src/data/api.ts): the result
// receipt's identity and bindings plus `queuedAt`, with NO nativeTime and NO
// attestation. `validateOfflineDeviceReceiptShape` must accept exactly that
// and nothing else, while the full-evidence result-receipt validator keeps
// its v1 contract untouched.
import { describe, expect, it } from "vitest";
import {
  OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
  OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
  OFFLINE_RECONCILIATION_SCHEMA_VERSION,
  OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
  type OfflineDeviceReceipt,
  type OfflineResultReceipt,
  validateOfflineDeviceReceiptShape,
  validateOfflineReconciliationStatus,
  validateOfflineResultReceiptShape,
} from "../offlineAuthorization.js";

const OWNER = "aaaaaaaa-0404-4000-8000-000000000001";

/** Exactly what the mobile outbox sends: OfflineReceiptSubmission minus the
 * device-local `settlement`/`settledAt` fields the transport strips. */
function deviceReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receiptId: "receipt-1",
    ownerId: OWNER,
    installationKeyId: "ios-installation-w04-04",
    grantId: "64444444-4444-4444-8444-444444444444",
    grantJwsSha256: "a".repeat(64),
    lifecycleSequence: 1,
    ticket: {
      allocationId: "64444444-4444-4444-8444-444444444444",
      generation: 3,
      ticketId: "65555555-5555-4555-8555-555555555551",
    },
    operationId: "operation-1",
    resultId: "70000001-0404-4000-8000-000000000001",
    fullOutputSha256: "b".repeat(64),
    billingDisposition: "joint_verification_required",
    queuedAt: "2026-09-08T10:00:00.000Z",
    ...overrides,
  };
}

const nativeTime = {
  schemaVersion: OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
  clock: "ios_mach_continuous_time",
  anchorId: "anchor-w04-04",
  elapsedMs: 120_000,
};
const attestation = {
  schemaVersion: OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
  format: "apple_app_attest",
  kind: "assertion",
  environment: "production",
  dataBase64Url: "QUJDRA",
  clientDataSha256: "c".repeat(64),
};

/** The full-evidence v1 result receipt (nativeTime + App Attest assertion). */
function fullEvidenceReceipt(): Record<string, unknown> {
  const { queuedAt: _queuedAt, ...device } = deviceReceipt();
  return {
    schemaVersion: OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
    ...device,
    nativeTime,
    attestation,
  };
}

function expectDeviceInvalid(raw: unknown): void {
  const parsed = validateOfflineDeviceReceiptShape(raw);
  expect(parsed.ok).toBe(false);
  if (!parsed.ok)
    expect(parsed.failure.code).toBe("offline_authorization.invalid_device_receipt_shape");
}

describe("validateOfflineDeviceReceiptShape — the mobile OfflineReceiptSubmission", () => {
  it("accepts the exact device receipt and returns an immutable copy", () => {
    const raw = deviceReceipt();
    const parsed = validateOfflineDeviceReceiptShape(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const receipt: OfflineDeviceReceipt = parsed.value;
    expect(receipt).toEqual(raw);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.ticket)).toBe(true);
    expect(receipt).not.toBe(raw);
  });

  it("accepts a Pro (no-ticket) receipt and a not_chargeable abstention", () => {
    expect(validateOfflineDeviceReceiptShape(deviceReceipt({ ticket: null })).ok).toBe(true);
    expect(
      validateOfflineDeviceReceiptShape(deviceReceipt({ billingDisposition: "not_chargeable" })).ok,
    ).toBe(true);
  });

  it("rejects a receipt missing any of its twelve fields", () => {
    for (const field of Object.keys(deviceReceipt())) {
      const raw = deviceReceipt();
      delete raw[field];
      expectDeviceInvalid(raw);
    }
  });

  it("rejects extra fields — including the device-local settlement columns", () => {
    expectDeviceInvalid(deviceReceipt({ extra: true }));
    expectDeviceInvalid(deviceReceipt({ settlement: null }));
    expectDeviceInvalid(deviceReceipt({ settledAt: null }));
    expectDeviceInvalid(deviceReceipt({ schemaVersion: OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION }));
  });

  it("rejects an explicit nativeTime or attestation — the 1.0 device does not render either", () => {
    expectDeviceInvalid(deviceReceipt({ nativeTime }));
    expectDeviceInvalid(deviceReceipt({ attestation }));
    expectDeviceInvalid(deviceReceipt({ nativeTime, attestation }));
    expectDeviceInvalid(deviceReceipt({ nativeTime: null }));
    expectDeviceInvalid(deviceReceipt({ attestation: undefined }));
    expectDeviceInvalid(fullEvidenceReceipt());
  });

  it("validates every identity and binding the settlement rests on", () => {
    expectDeviceInvalid(deviceReceipt({ receiptId: 42 }));
    expectDeviceInvalid(deviceReceipt({ receiptId: "" }));
    expectDeviceInvalid(deviceReceipt({ receiptId: "x".repeat(129) }));
    expectDeviceInvalid(deviceReceipt({ ownerId: "not-a-uuid" }));
    expectDeviceInvalid(deviceReceipt({ ownerId: OWNER.toUpperCase() }));
    expectDeviceInvalid(deviceReceipt({ installationKeyId: "has space" }));
    expectDeviceInvalid(deviceReceipt({ grantId: "" }));
    expectDeviceInvalid(deviceReceipt({ grantJwsSha256: "A".repeat(64) }));
    expectDeviceInvalid(deviceReceipt({ grantJwsSha256: "a".repeat(63) }));
    expectDeviceInvalid(deviceReceipt({ lifecycleSequence: 0 }));
    expectDeviceInvalid(deviceReceipt({ lifecycleSequence: 1.5 }));
    expectDeviceInvalid(deviceReceipt({ lifecycleSequence: "1" }));
    expectDeviceInvalid(deviceReceipt({ ticket: undefined }));
    expectDeviceInvalid(deviceReceipt({ ticket: {} }));
    expectDeviceInvalid(
      deviceReceipt({
        ticket: { allocationId: "a", generation: 0, ticketId: "t" },
      }),
    );
    expectDeviceInvalid(
      deviceReceipt({
        ticket: { allocationId: "a", generation: 1, ticketId: "t", extra: 1 },
      }),
    );
    expectDeviceInvalid(deviceReceipt({ operationId: null }));
    expectDeviceInvalid(deviceReceipt({ resultId: "" }));
    expectDeviceInvalid(deviceReceipt({ fullOutputSha256: "b".repeat(65) }));
    expectDeviceInvalid(deviceReceipt({ billingDisposition: "chargeable" }));
    expectDeviceInvalid(deviceReceipt({ billingDisposition: null }));
  });

  it("requires queuedAt to be an ISO-8601 UTC instant", () => {
    expect(
      validateOfflineDeviceReceiptShape(deviceReceipt({ queuedAt: "2026-09-08T10:00:00Z" })).ok,
    ).toBe(true);
    expect(
      validateOfflineDeviceReceiptShape(deviceReceipt({ queuedAt: new Date(0).toISOString() })).ok,
    ).toBe(true);
    expectDeviceInvalid(deviceReceipt({ queuedAt: "" }));
    expectDeviceInvalid(deviceReceipt({ queuedAt: 1_757_325_600_000 }));
    expectDeviceInvalid(deviceReceipt({ queuedAt: "2026-09-08 10:00:00" }));
    expectDeviceInvalid(deviceReceipt({ queuedAt: "2026-09-08T10:00:00+02:00" }));
    expectDeviceInvalid(deviceReceipt({ queuedAt: "2026-13-40T10:00:00.000Z" }));
    expectDeviceInvalid(deviceReceipt({ queuedAt: null }));
  });

  it("rejects non-objects, arrays and prototype-carrying values", () => {
    expectDeviceInvalid(null);
    expectDeviceInvalid(undefined);
    expectDeviceInvalid("receipt");
    expectDeviceInvalid([deviceReceipt()]);
    expectDeviceInvalid(Object.assign(Object.create({ receiptId: "proto" }), deviceReceipt()));
  });
});

describe("validateOfflineResultReceiptShape — the full-evidence v1 receipt stays intact", () => {
  it("still accepts the full-evidence result receipt", () => {
    const parsed = validateOfflineResultReceiptShape(fullEvidenceReceipt());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const receipt: OfflineResultReceipt = parsed.value;
    expect(receipt.schemaVersion).toBe(OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION);
    expect(receipt.nativeTime).toEqual(nativeTime);
    expect(receipt.attestation).toEqual(attestation);
  });

  it("still refuses the bare device receipt and a full-evidence receipt with queuedAt", () => {
    const bare = validateOfflineResultReceiptShape(deviceReceipt());
    expect(bare.ok).toBe(false);
    if (!bare.ok)
      expect(bare.failure.code).toBe("offline_authorization.invalid_result_receipt_shape");
    expect(
      validateOfflineResultReceiptShape({
        ...fullEvidenceReceipt(),
        queuedAt: "2026-09-08T10:00:00.000Z",
      }).ok,
    ).toBe(false);
    expect(
      validateOfflineResultReceiptShape({ ...fullEvidenceReceipt(), attestation: undefined }).ok,
    ).toBe(false);
  });
});

describe("validateOfflineReconciliationStatus binds to either receipt form", () => {
  const status = (receipt: Record<string, unknown>, extra: Record<string, unknown>) => ({
    schemaVersion: OFFLINE_RECONCILIATION_SCHEMA_VERSION,
    ownerId: receipt.ownerId,
    receiptId: receipt.receiptId,
    ...extra,
  });

  it("accepts a consumed result_recorded for the device receipt and the full-evidence receipt alike", () => {
    for (const receipt of [deviceReceipt(), fullEvidenceReceipt()]) {
      const recorded = validateOfflineReconciliationStatus(
        status(receipt, {
          status: "result_recorded",
          resultId: receipt.resultId,
          financialDisposition: "consumed",
        }),
        receipt,
      );
      expect(recorded.ok).toBe(true);
      const held = validateOfflineReconciliationStatus(
        status(receipt, {
          status: "reconciliation_required",
          reasonCode: "conflicting_receipt",
          financialDisposition: "reserved",
        }),
        receipt,
      );
      expect(held.ok).toBe(true);
      const pending = validateOfflineReconciliationStatus(
        status(receipt, { status: "pending", financialDisposition: "reserved" }),
        receipt,
      );
      expect(pending.ok).toBe(true);
    }
  });

  it("keeps the device receipt's financial semantics: no ticket → not_applicable, abstention → reserved", () => {
    const pro = deviceReceipt({ ticket: null });
    expect(
      validateOfflineReconciliationStatus(
        status(pro, {
          status: "result_recorded",
          resultId: pro.resultId,
          financialDisposition: "not_applicable",
        }),
        pro,
      ).ok,
    ).toBe(true);
    expect(
      validateOfflineReconciliationStatus(
        status(pro, {
          status: "result_recorded",
          resultId: pro.resultId,
          financialDisposition: "consumed",
        }),
        pro,
      ).ok,
    ).toBe(false);
    const abstention = deviceReceipt({ billingDisposition: "not_chargeable" });
    expect(
      validateOfflineReconciliationStatus(
        status(abstention, {
          status: "result_recorded",
          resultId: abstention.resultId,
          financialDisposition: "reserved",
        }),
        abstention,
      ).ok,
    ).toBe(true);
    expect(
      validateOfflineReconciliationStatus(
        status(abstention, {
          status: "result_recorded",
          resultId: abstention.resultId,
          financialDisposition: "consumed",
        }),
        abstention,
      ).ok,
    ).toBe(false);
  });

  it("refuses a status for a receipt that is neither form", () => {
    const receipt = deviceReceipt({ nativeTime });
    const parsed = validateOfflineReconciliationStatus(
      status(receipt, {
        status: "result_recorded",
        resultId: receipt.resultId,
        financialDisposition: "consumed",
      }),
      receipt,
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok)
      expect(parsed.failure.code).toBe("offline_authorization.invalid_reconciliation_binding");
  });
});
