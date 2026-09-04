/**
 * Adjudication repro (shared-packages-ops) — deriveConsentStatus ordering.
 *
 * Expected behaviour is asserted; the two non-control tests FAIL on 4d812e1a
 * because seq-less rows are ordered by String.prototype.localeCompare on the
 * ISO string instead of by the instant it denotes.
 */
import { describe, expect, it } from "vitest";
import { deriveConsentStatus, type ConsentRecord } from "../src/index.js";

const SUBJECT = "SYNTHETIC-TEST-FIXTURE.subject";

function row(action: "granted" | "withdrawn", recordedAtIso: string, seq?: number): ConsentRecord {
  return {
    id: `${action}-${recordedAtIso}-${seq ?? "noseq"}`,
    subjectPseudonym: SUBJECT,
    scope: "model_training",
    action,
    consentVersion: "model-training-v1",
    source: "mobile_settings",
    device: null,
    captureMode: action === "granted" ? "all_captures" : null,
    strokeIntent: null,
    recordedAtIso,
    ...(seq === undefined ? {} : { seq }),
  };
}

const training = (records: ConsentRecord[]) =>
  deriveConsentStatus(records).find((s) => s.scope === "model_training")!;

describe("adjudication: deriveConsentStatus orders seq-less rows by instant, not by string", () => {
  it("grant @12:00+02:00 (=10:00Z) then withdrawal @11:00Z → NOT active", () => {
    const records = [
      row("granted", "2026-01-01T12:00:00+02:00"),
      row("withdrawn", "2026-01-01T11:00:00Z"),
    ];
    expect(training(records).active).toBe(false);
    expect(training([...records].reverse()).active).toBe(false);
  });

  it("withdrawal 1 ms after the grant, spelled with milliseconds, wins", () => {
    // '.' (0x2E) sorts before 'Z' (0x5A), so '11:00:00.001Z' is ordered BEFORE
    // '11:00:00Z' even though it is 1 ms later.
    const grant = row("granted", "2026-01-01T11:00:00Z");
    const withdrawal = row("withdrawn", "2026-01-01T11:00:00.001Z");
    expect(training([grant, withdrawal]).active).toBe(false);
    expect(training([withdrawal, grant]).active).toBe(false);
  });

  it("control: seq-bearing rows are ordered by seq regardless of spelling", () => {
    const grant = row("granted", "2026-01-01T12:00:00+02:00", 1);
    const withdrawal = row("withdrawn", "2026-01-01T11:00:00Z", 2);
    expect(training([grant, withdrawal]).active).toBe(false);
    expect(training([withdrawal, grant]).active).toBe(false);
  });
});
