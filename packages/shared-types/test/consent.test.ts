import { describe, expect, it } from "vitest";
import {
  deriveConsentStatus,
  isModelTrainingConsentActive,
  type ConsentRecord,
} from "../src/consent.js";

function record(overrides: Partial<ConsentRecord>): ConsentRecord {
  return {
    id: "r1",
    subjectPseudonym: "p1",
    scope: "model_training",
    action: "granted",
    consentVersion: "model-training-v1",
    source: "mobile_settings",
    device: null,
    captureMode: "all_captures",
    strokeIntent: null,
    recordedAtIso: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("consent ledger fold", () => {
  it("defaults every scope to NOT consented with an empty ledger", () => {
    const status = deriveConsentStatus([]);
    expect(status).toHaveLength(3);
    for (const s of status) {
      expect(s.active).toBe(false);
      expect(s.lastAction).toBeNull();
    }
    expect(isModelTrainingConsentActive([])).toBe(false);
  });

  it("grant then withdraw leaves the scope inactive but keeps the trail", () => {
    const ledger = [
      record({ id: "r1", recordedAtIso: "2026-08-29T00:00:00.000Z" }),
      record({
        id: "r2",
        action: "withdrawn",
        captureMode: null,
        recordedAtIso: "2026-08-29T01:00:00.000Z",
      }),
    ];
    const training = deriveConsentStatus(ledger).find((s) => s.scope === "model_training")!;
    expect(training.active).toBe(false);
    expect(training.lastAction).toBe("withdrawn");
    expect(training.lastActionAtIso).toBe("2026-08-29T01:00:00.000Z");
  });

  it("re-grant after withdrawal reactivates with the new version", () => {
    const ledger = [
      record({ id: "r1", recordedAtIso: "2026-08-29T00:00:00.000Z" }),
      record({
        id: "r2",
        action: "withdrawn",
        recordedAtIso: "2026-08-29T01:00:00.000Z",
      }),
      record({
        id: "r3",
        consentVersion: "model-training-v2",
        recordedAtIso: "2026-08-29T02:00:00.000Z",
      }),
    ];
    const training = deriveConsentStatus(ledger).find((s) => s.scope === "model_training")!;
    expect(training.active).toBe(true);
    expect(training.consentVersion).toBe("model-training-v2");
    expect(isModelTrainingConsentActive(ledger)).toBe(true);
  });

  it("scopes are independent: video_analysis grant never implies model_training", () => {
    const ledger = [record({ scope: "video_analysis", consentVersion: "video-analysis-v1" })];
    const status = deriveConsentStatus(ledger);
    expect(status.find((s) => s.scope === "video_analysis")!.active).toBe(true);
    expect(status.find((s) => s.scope === "model_training")!.active).toBe(false);
  });
});
