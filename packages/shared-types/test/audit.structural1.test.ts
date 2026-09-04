import { describe, expect, it } from "vitest";
import {
  deriveConsentStatus,
  isModelTrainingConsentActive,
  resolveTechniqueIntent,
  type ConsentRecord,
} from "../src/index.js";

/**
 * STRUCTURAL AUDIT (shared-packages-ops, pass 1). Each `it` encodes the
 * documented contract; a failing case on the audited baseline is a finding,
 * a passing case is verified-good evidence. No production code is changed by
 * this file.
 */

function record(overrides: Partial<ConsentRecord>): ConsentRecord {
  return {
    id: "SYNTHETIC-TEST-FIXTURE.record",
    subjectPseudonym: "SYNTHETIC-TEST-FIXTURE.subject",
    scope: "model_training",
    action: "granted",
    consentVersion: "model-training-v1",
    source: "privacy_center",
    device: null,
    captureMode: "all_captures",
    strokeIntent: null,
    recordedAtIso: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("audit: resolveTechniqueIntent side grammar", () => {
  it("an utterance naming BOTH sides must not resolve confidently to one side", () => {
    // Contract (techniqueIntent.ts doc comment): "Genuinely ambiguous phrases
    // return the narrowed option set for the UI to disambiguate — never a
    // silent guess."
    for (const text of [
      "forehand and backhand drive",
      "backhand or forehand drive",
      "my forehand dink and my backhand dink",
      "fh bh volley",
    ]) {
      const resolution = resolveTechniqueIntent(text);
      expect(resolution.status, `"${text}" -> ${JSON.stringify(resolution)}`).toBe("ambiguous");
    }
  });

  it("side detection is order-independent (forehand-first and backhand-first agree)", () => {
    const a = resolveTechniqueIntent("forehand backhand drive");
    const b = resolveTechniqueIntent("backhand forehand drive");
    expect(a).toEqual(b);
  });
});

describe("audit: deriveConsentStatus ordering without seq", () => {
  it("a later withdrawal recorded with a different UTC offset still wins", () => {
    // Grant at 12:00+05:00 == 07:00Z; withdrawal at 09:00Z is two hours LATER
    // in real time. "withdraw wins" must hold regardless of offset notation.
    const records: ConsentRecord[] = [
      record({ id: "g", action: "granted", recordedAtIso: "2026-08-01T12:00:00.000+05:00" }),
      record({
        id: "w",
        action: "withdrawn",
        captureMode: null,
        recordedAtIso: "2026-08-01T09:00:00.000Z",
      }),
    ];
    const status = deriveConsentStatus(records).find((s) => s.scope === "model_training");
    expect(status?.lastAction).toBe("withdrawn");
    expect(status?.active).toBe(false);
    expect(isModelTrainingConsentActive(records)).toBe(false);
  });

  it("a later withdrawal written without fractional seconds still wins", () => {
    // "2026-08-01T10:00:00Z" (withdraw, later) vs "2026-08-01T09:59:59.999Z"
    // (grant, earlier) — same instant ordering under Date.parse; lexical order
    // is the same here, so this case documents the boundary that DOES hold.
    const records: ConsentRecord[] = [
      record({ id: "g", action: "granted", recordedAtIso: "2026-08-01T09:59:59.999Z" }),
      record({
        id: "w",
        action: "withdrawn",
        captureMode: null,
        recordedAtIso: "2026-08-01T10:00:00Z",
      }),
    ];
    expect(isModelTrainingConsentActive(records)).toBe(false);
  });

  it("seq is authoritative when present on every record, even against timestamps", () => {
    const records: ConsentRecord[] = [
      record({ id: "g", seq: 2, action: "granted", recordedAtIso: "2026-08-01T00:00:00.000Z" }),
      record({
        id: "w",
        seq: 1,
        action: "withdrawn",
        captureMode: null,
        recordedAtIso: "2026-08-02T00:00:00.000Z",
      }),
    ];
    expect(isModelTrainingConsentActive(records)).toBe(true);
  });
});
