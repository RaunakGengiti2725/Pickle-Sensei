import { describe, expect, it } from "vitest";
import {
  checkConsentVersionAcceptable,
  deriveConsentStatus,
  parseConsentVersionMajor,
  isModelTrainingConsentActive,
  type ConsentRecord,
} from "../src/index.js";

/**
 * Wave D3 red-team regression tests (D3-08, C10 consent architecture).
 * Break RT-B2: status derivation must not depend on millisecond-truncated
 * timestamps — a withdraw recorded in the same millisecond as a grant (or
 * records handed over in arbitrary array order) must still resolve to the
 * ledger-sequence-latest action. Absence of records stays default-deny.
 */

function rec(partial: Partial<ConsentRecord> & Pick<ConsentRecord, "action">): ConsentRecord {
  return {
    id: partial.id ?? "00000000-0000-4000-8000-000000000001",
    subjectPseudonym: "00000000-0000-4000-8000-0000000000aa",
    scope: partial.scope ?? "model_training",
    action: partial.action,
    consentVersion: partial.consentVersion ?? "model-training-v1",
    source: "mobile_settings",
    device: null,
    captureMode: partial.action === "granted" ? "all_captures" : null,
    strokeIntent: null,
    recordedAtIso: partial.recordedAtIso ?? "2026-08-29T00:00:00.000Z",
    seq: partial.seq,
  };
}

describe("consent status derivation under adversarial ordering (synthetic fixtures)", () => {
  it("same-millisecond grant then withdraw resolves to withdrawn regardless of array order", () => {
    const grant = rec({
      action: "granted",
      recordedAtIso: "2026-08-29T00:00:00.123Z",
      seq: 1,
      id: "00000000-0000-4000-8000-000000000001",
    });
    const withdraw = rec({
      action: "withdrawn",
      recordedAtIso: "2026-08-29T00:00:00.123Z",
      seq: 2,
      id: "00000000-0000-4000-8000-000000000002",
    });
    // Adversarial: withdraw first in the array, timestamps tie at ms precision.
    const status = deriveConsentStatus([withdraw, grant]).find(
      (s) => s.scope === "model_training",
    )!;
    expect(status.active).toBe(false);
    expect(status.lastAction).toBe("withdrawn");
    expect(isModelTrainingConsentActive([withdraw, grant])).toBe(false);
  });

  it("out-of-order arrays with distinct timestamps still fold to the latest action", () => {
    const grant = rec({ action: "granted", recordedAtIso: "2026-08-29T00:00:01.000Z", seq: 3 });
    const withdraw = rec({
      action: "withdrawn",
      recordedAtIso: "2026-08-29T00:00:02.000Z",
      seq: 4,
    });
    expect(isModelTrainingConsentActive([withdraw, grant])).toBe(false);
    expect(isModelTrainingConsentActive([grant, withdraw])).toBe(false);
  });

  it("records without seq fall back to timestamp ordering (legacy payloads)", () => {
    const grant = rec({ action: "granted", recordedAtIso: "2026-08-29T00:00:01.000Z" });
    const withdraw = rec({ action: "withdrawn", recordedAtIso: "2026-08-29T00:00:02.000Z" });
    expect(isModelTrainingConsentActive([withdraw, grant])).toBe(false);
  });

  it("absence of any record is NEVER consent (default deny)", () => {
    expect(isModelTrainingConsentActive([])).toBe(false);
    for (const s of deriveConsentStatus([])) expect(s.active).toBe(false);
  });
});

/**
 * Wave F f23: consent-version abuse. A version string is a contract
 * reference, not free text — and a re-grant may never move the authorizing
 * contract downward.
 */
describe("consent version acceptance (f23)", () => {
  it("rejects strings that name no contract for the scope", () => {
    for (const v of ["totally-made-up-v9", "model-training", "model-training-v", "", "  "]) {
      const check = checkConsentVersionAcceptable("model_training", v, null);
      expect(check.ok).toBe(false);
      expect(check.rejection).toBe("malformed");
    }
  });

  it("rejects the other scope's contract, in both directions", () => {
    expect(checkConsentVersionAcceptable("model_training", "video-analysis-v1", null).ok).toBe(
      false,
    );
    expect(checkConsentVersionAcceptable("video_analysis", "model-training-v1", null).ok).toBe(
      false,
    );
  });

  it("rejects a downgrade below the granted contract but allows upgrades and re-grants", () => {
    const downgrade = checkConsentVersionAcceptable(
      "model_training",
      "model-training-v1",
      "model-training-v2",
    );
    expect(downgrade.ok).toBe(false);
    expect(downgrade.rejection).toBe("downgrade");
    expect(
      checkConsentVersionAcceptable("model_training", "model-training-v3", "model-training-v2").ok,
    ).toBe(true);
    expect(
      checkConsentVersionAcceptable("model_training", "model-training-v2", "model-training-v2").ok,
    ).toBe(true);
  });

  it("compares majors numerically, not lexically (v10 is above v9)", () => {
    expect(parseConsentVersionMajor("model_training", "model-training-v10")).toBe(10);
    expect(
      checkConsentVersionAcceptable("model_training", "model-training-v10", "model-training-v9").ok,
    ).toBe(true);
    expect(
      checkConsentVersionAcceptable("model_training", "model-training-v9", "model-training-v10").ok,
    ).toBe(false);
  });

  it("a first grant with no prior version is accepted when well-formed", () => {
    expect(checkConsentVersionAcceptable("video_analysis", "video-analysis-v1", null).ok).toBe(
      true,
    );
  });
});
