import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONSENT_LEDGER_EXPORT_VERSION,
  canonicalConsentRecordsJson,
  type ConsentRecord,
} from "@pickle/shared-types";
import { checkConsentForSubject, loadConsentLedger } from "../src/index.js";

/**
 * Structural audit #2 (shared-packages-ops) — reproducing tests for the
 * consent-ledger loading path used by first-party intake. ALL fixtures are
 * SYNTHETIC (`SYNTHETIC-TEST-FIXTURE` pseudonyms); nothing here may be copied
 * under datasets/.
 */

const SUBJECT = "SYNTHETIC-TEST-FIXTURE.audit-subject";

function record(overrides: Partial<ConsentRecord>): ConsentRecord {
  return {
    id: "SYNTHETIC-TEST-FIXTURE.record",
    subjectPseudonym: SUBJECT,
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

function write(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-consent-"));
  const path = join(dir, "ledger.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("AUDIT bare-array ledger: withdrawal must win by capture instant, not by string order", () => {
  it("a later UTC withdrawal whose ISO string sorts before an offset-bearing grant still revokes", () => {
    const grant = record({
      id: "SYNTHETIC-TEST-FIXTURE.g",
      recordedAtIso: "2026-08-29T02:00:00.000+05:00", // == 2026-08-28T21:00:00Z
    });
    const withdrawal = record({
      id: "SYNTHETIC-TEST-FIXTURE.w",
      action: "withdrawn",
      recordedAtIso: "2026-08-28T23:00:00.000Z", // 2h AFTER the grant
    });
    const video = record({
      id: "SYNTHETIC-TEST-FIXTURE.v",
      scope: "video_analysis",
      consentVersion: "video-analysis-v1",
    });
    expect(Date.parse(withdrawal.recordedAtIso)).toBeGreaterThan(Date.parse(grant.recordedAtIso));

    // Bare arrays are accepted without seq (no signing key configured).
    const ledger = loadConsentLedger(write([video, grant, withdrawal]));
    const check = checkConsentForSubject(ledger, SUBJECT);
    expect(check.modelTrainingActive, check.errors.join("; ")).toBe(false);
    expect(check.ok).toBe(false);
  });
});

describe("AUDIT export envelope: seq must be a finite integer, not merely 'present'", () => {
  it("a record with seq: null is rejected as missing seq", () => {
    const rows = [record({ id: "SYNTHETIC-TEST-FIXTURE.n" })] as unknown as Array<
      Record<string, unknown>
    >;
    rows[0]!["seq"] = null;
    const records = rows as unknown as ConsentRecord[];
    const envelope = {
      exportVersion: CONSENT_LEDGER_EXPORT_VERSION,
      exportedAtIso: "2026-08-29T00:00:00.000Z",
      subjectPseudonym: SUBJECT,
      recordCount: 1,
      maxSeq: null,
      recordsSha256: createHash("sha256")
        .update(canonicalConsentRecordsJson(records))
        .digest("hex"),
      records,
    };
    expect(() => loadConsentLedger(write(envelope))).toThrow(/seq/);
  });
});
