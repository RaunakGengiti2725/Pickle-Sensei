/**
 * Adversarial pass 3 — end-to-end: a bare (unsigned, seq-less) consent
 * ledger whose timestamps carry different UTC offsets. The withdrawal is
 * chronologically LATER than the grant, so intake must refuse the subject.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkConsentForSubject, loadConsentLedger } from "../src/index.js";

const SUBJECT = "subj-skew";

function row(action: "granted" | "withdrawn", scope: string, recordedAtIso: string) {
  return {
    id: `${scope}-${action}-${recordedAtIso}`,
    subjectPseudonym: SUBJECT,
    scope,
    action,
    consentVersion: `${scope}-v1`,
    source: "mobile_settings",
    device: null,
    captureMode: action === "granted" ? "all_captures" : null,
    strokeIntent: null,
    recordedAtIso,
  };
}

describe("attack3: bare ledger with offset-skewed timestamps", () => {
  it("model_training granted@12:00+02:00 (10:00Z) then withdrawn@11:00Z → intake refuses", () => {
    const dir = mkdtempSync(join(tmpdir(), "attack3-consent-"));
    const path = join(dir, "ledger.json");
    writeFileSync(
      path,
      JSON.stringify([
        row("granted", "video_analysis", "2026-01-01T09:00:00Z"),
        row("granted", "model_training", "2026-01-01T12:00:00+02:00"),
        row("withdrawn", "model_training", "2026-01-01T11:00:00Z"),
      ]),
    );
    const records = loadConsentLedger(path);
    expect(records).toHaveLength(3);
    const result = checkConsentForSubject(records, SUBJECT);
    expect(result.modelTrainingActive, JSON.stringify(result)).toBe(false);
    expect(result.ok).toBe(false);
  });
});
