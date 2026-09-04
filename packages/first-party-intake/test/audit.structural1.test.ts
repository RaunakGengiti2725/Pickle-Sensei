import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ConsentRecord } from "@pickle/shared-types";
import { checkConsentForSubject, loadConsentLedger } from "../src/index.js";

/**
 * STRUCTURAL AUDIT (shared-packages-ops, pass 1). SYNTHETIC fixtures only.
 * Encodes the intake consent contract; failures on the audited baseline are
 * findings, passes are verified-good evidence.
 */

const SUBJECT = "SYNTHETIC-TEST-FIXTURE.audit-subject";

function row(overrides: Partial<ConsentRecord>): ConsentRecord {
  return {
    id: "SYNTHETIC-TEST-FIXTURE.audit-record",
    subjectPseudonym: SUBJECT,
    scope: "video_analysis",
    action: "granted",
    consentVersion: "video-analysis-v1",
    source: "privacy_center",
    device: null,
    captureMode: "all_captures",
    strokeIntent: null,
    recordedAtIso: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function writeLedger(records: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-intake-"));
  const path = join(dir, "ledger.json");
  writeFileSync(path, JSON.stringify(records));
  return path;
}

describe("audit: bare-array consent ledger (seq-less records)", () => {
  it("a subject who WITHDREW model_training later (offset timestamp) is not consented", () => {
    // Grant recorded as 12:00+05:00 (07:00Z); withdrawal recorded at 09:00Z,
    // i.e. two hours after the grant. Intake must refuse the clip.
    const ledgerPath = writeLedger([
      row({ id: "SYNTHETIC-TEST-FIXTURE.a1" }),
      row({
        id: "SYNTHETIC-TEST-FIXTURE.a2",
        scope: "model_training",
        consentVersion: "model-training-v1",
        recordedAtIso: "2026-08-01T12:00:00.000+05:00",
      }),
      row({
        id: "SYNTHETIC-TEST-FIXTURE.a3",
        scope: "model_training",
        consentVersion: "model-training-v1",
        action: "withdrawn",
        captureMode: null,
        recordedAtIso: "2026-08-01T09:00:00.000Z",
      }),
    ]);
    const ledger = loadConsentLedger(ledgerPath);
    const result = checkConsentForSubject(ledger, SUBJECT);
    expect(result.modelTrainingActive).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("bare arrays are rejected once a signing key is configured (downgrade resistance)", () => {
    const ledgerPath = writeLedger([row({})]);
    expect(() => loadConsentLedger(ledgerPath, { signingKey: "k" })).toThrow(/signing key/);
  });

  it("records with non-parseable timestamps are rejected loudly", () => {
    const ledgerPath = writeLedger([row({ recordedAtIso: "yesterday" })]);
    expect(() => loadConsentLedger(ledgerPath)).toThrow(/recordedAtIso/);
  });
});

describe("audit: CLI surface for v2 export protections", () => {
  const cliSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts"),
    "utf8",
  );
  const intakeSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "intake.ts"),
    "utf8",
  );

  it("the CLI exposes a way to require signed (v2) consent exports", () => {
    // loadConsentLedger's signingKey/minMaxSeq protections exist, but an
    // operator can only reach them if the CLI/intakeClip surface them.
    expect(cliSource).toMatch(/signing-?key/i);
  });

  it("intakeClip forwards ledger verification options to loadConsentLedger", () => {
    expect(intakeSource).toMatch(/loadConsentLedger\([^)]*,\s*\S/);
  });
});
