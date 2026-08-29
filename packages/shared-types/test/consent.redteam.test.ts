import { describe, expect, it } from "vitest";
import {
  deriveConsentStatus,
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
