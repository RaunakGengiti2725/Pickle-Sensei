/**
 * Adjudication regression (shared-packages-ops SPO-02) — deriveConsentStatus
 * must order seq-less ledger rows by the instant `recordedAtIso` denotes, not
 * by the ISO string's code points. Offset-skewed spellings (`+02:00` vs `Z`)
 * and precision differences (`:00Z` vs `:00.000Z`) must never flip a later
 * withdrawal back to granted.
 */
import { describe, expect, it } from "vitest";
import {
  compareConsentRecords,
  deriveConsentStatus,
  isModelTrainingConsentActive,
  type ConsentRecord,
} from "../src/index.js";

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
    expect(training(records).lastAction).toBe("withdrawn");
    expect(training(records).lastActionAtIso).toBe("2026-01-01T11:00:00Z");
  });

  it("withdrawal 1 ms after the grant, spelled with milliseconds, wins", () => {
    // '.' (0x2E) sorts before 'Z' (0x5A), so '11:00:00.001Z' is ordered BEFORE
    // '11:00:00Z' by localeCompare even though it is 1 ms later.
    const grant = row("granted", "2026-01-01T11:00:00Z");
    const withdrawal = row("withdrawn", "2026-01-01T11:00:00.001Z");
    expect(training([grant, withdrawal]).active).toBe(false);
    expect(training([withdrawal, grant]).active).toBe(false);
    expect(isModelTrainingConsentActive([withdrawal, grant])).toBe(false);
  });

  it("control: seq-bearing rows are ordered by seq regardless of spelling", () => {
    const grant = row("granted", "2026-01-01T12:00:00+02:00", 1);
    const withdrawal = row("withdrawn", "2026-01-01T11:00:00Z", 2);
    expect(training([grant, withdrawal]).active).toBe(false);
    expect(training([withdrawal, grant]).active).toBe(false);
  });

  it("a later RE-GRANT spelled with an offset still wins over an earlier withdrawal", () => {
    // The fix must order by instant in both directions — not simply bias
    // toward withdrawals.
    const withdrawal = row("withdrawn", "2026-01-01T10:00:00Z");
    const regrant = row("granted", "2026-01-01T13:00:00+02:00"); // = 11:00Z, later
    expect(training([withdrawal, regrant]).active).toBe(true);
    expect(training([regrant, withdrawal]).active).toBe(true);
  });

  it("identical instants without seq resolve deterministically and never to granted", () => {
    // Two spellings of the same instant; no seq to break the tie. A tie can
    // only be resolved conservatively: the withdrawal wins in every order.
    const grant = row("granted", "2026-01-01T11:00:00.000Z");
    const withdrawal = row("withdrawn", "2026-01-01T13:00:00+02:00");
    expect(training([grant, withdrawal]).active).toBe(false);
    expect(training([withdrawal, grant]).active).toBe(false);
    expect(compareConsentRecords(grant, withdrawal)).toBeLessThan(0);
    expect(compareConsentRecords(withdrawal, grant)).toBeGreaterThan(0);
  });

  it("comparator is antisymmetric and consistent over every permutation of a 3-row ledger", () => {
    const rows = [
      row("granted", "2026-01-01T12:00:00+02:00"), // 10:00Z
      row("withdrawn", "2026-01-01T11:00:00Z"), // 11:00Z
      row("granted", "2026-01-01T11:00:00.500Z"), // 11:00:00.5Z — latest
    ];
    const permutations: ConsentRecord[][] = [
      [rows[0]!, rows[1]!, rows[2]!],
      [rows[0]!, rows[2]!, rows[1]!],
      [rows[1]!, rows[0]!, rows[2]!],
      [rows[1]!, rows[2]!, rows[0]!],
      [rows[2]!, rows[0]!, rows[1]!],
      [rows[2]!, rows[1]!, rows[0]!],
    ];
    for (const p of permutations) {
      const status = training(p);
      expect(status.active).toBe(true);
      expect(status.lastActionAtIso).toBe("2026-01-01T11:00:00.500Z");
    }
    for (const a of rows) {
      for (const b of rows) {
        expect(Math.sign(compareConsentRecords(a, b))).toBe(-Math.sign(compareConsentRecords(b, a)));
      }
    }
  });
});
