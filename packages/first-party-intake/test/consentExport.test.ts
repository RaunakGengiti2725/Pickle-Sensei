import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CONSENT_LEDGER_EXPORT_VERSION,
  canonicalConsentRecordsJson,
  type ConsentLedgerExport,
  type ConsentRecord,
} from "@pickle/shared-types";
import { checkConsentForSubject, loadConsentLedger } from "../src/index.js";

/**
 * Consent-ledger export envelope parsing and integrity verification (wave E
 * e21). ALL fixtures are SYNTHETIC: pseudonyms are prefixed
 * `SYNTHETIC-TEST-FIXTURE` and nothing here may ever be copied under
 * datasets/.
 */

const SUBJECT = "SYNTHETIC-TEST-FIXTURE.export-subject";

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
    seq: 1,
    ...overrides,
  };
}

function envelope(records: ConsentRecord[]): ConsentLedgerExport {
  return {
    exportVersion: CONSENT_LEDGER_EXPORT_VERSION,
    exportedAtIso: "2026-08-29T00:00:01.000Z",
    subjectPseudonym: SUBJECT,
    recordCount: records.length,
    maxSeq: records.length > 0 ? (records.at(-1)!.seq ?? null) : null,
    recordsSha256: createHash("sha256").update(canonicalConsentRecordsJson(records)).digest("hex"),
    records,
  };
}

let dir: string;

function write(body: unknown): string {
  const path = join(dir, `ledger-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "consent-export-test-"));
});

describe("consent ledger export envelope", () => {
  const grantVideo = record({ scope: "video_analysis", consentVersion: "video-analysis-v1" });
  const grantTraining = record({ seq: 2 });
  const withdrawal = record({ action: "withdrawn", seq: 3 });

  it("a valid envelope loads and authorizes an actively consented subject", () => {
    const records = loadConsentLedger(write(envelope([grantVideo, grantTraining])));
    expect(records).toHaveLength(2);
    const check = checkConsentForSubject(records, SUBJECT);
    expect(check.ok).toBe(true);
    expect(check.modelTrainingConsentVersion).toBe("model-training-v1");
  });

  it("a valid envelope with a trailing withdrawal denies model training", () => {
    const records = loadConsentLedger(write(envelope([grantVideo, grantTraining, withdrawal])));
    const check = checkConsentForSubject(records, SUBJECT);
    expect(check.ok).toBe(false);
    expect(check.modelTrainingActive).toBe(false);
  });

  it("an empty ledger envelope loads but never authorizes anyone", () => {
    const records = loadConsentLedger(write(envelope([])));
    expect(records).toHaveLength(0);
    expect(checkConsentForSubject(records, SUBJECT).ok).toBe(false);
  });

  it("rejects a tampered record (hash mismatch)", () => {
    const body = envelope([grantVideo, grantTraining, withdrawal]);
    body.records = [grantVideo, grantTraining, record({ action: "granted", seq: 3 })];
    expect(() => loadConsentLedger(write(body))).toThrow(/recordsSha256/);
  });

  it("rejects a truncated export (recordCount and hash mismatch)", () => {
    const body = envelope([grantVideo, grantTraining, withdrawal]);
    body.records = body.records.slice(0, 2);
    expect(() => loadConsentLedger(write(body))).toThrow(/failed integrity verification/);
  });

  it("rejects records not strictly ordered by seq", () => {
    const shuffled = [grantTraining, grantVideo, withdrawal];
    const body = envelope(shuffled);
    expect(() => loadConsentLedger(write(body))).toThrow(/seq/);
  });

  it("rejects an envelope whose maxSeq disagrees with the records", () => {
    const body = envelope([grantVideo, grantTraining]);
    body.maxSeq = 99;
    expect(() => loadConsentLedger(write(body))).toThrow(/maxSeq/);
  });

  it("rejects records missing seq inside an envelope", () => {
    const noSeq = { ...record({}) };
    delete (noSeq as { seq?: number }).seq;
    const body = envelope([noSeq]);
    body.maxSeq = null;
    expect(() => loadConsentLedger(write(body))).toThrow(/seq/);
  });

  it("rejects an unknown exportVersion instead of guessing", () => {
    const body = envelope([grantVideo]) as unknown as Record<string, unknown>;
    body.exportVersion = "consent-ledger-export-v999";
    expect(() => loadConsentLedger(write(body))).toThrow(/exportVersion/);
  });

  it("rejects an envelope containing another subject's records", () => {
    const foreign = record({ subjectPseudonym: "SYNTHETIC-TEST-FIXTURE.other", seq: 2 });
    const body = envelope([grantVideo, foreign]);
    expect(() => loadConsentLedger(write(body))).toThrow(/subject/);
  });

  it("still accepts the legacy bare-array ledger shape", () => {
    const records = loadConsentLedger(write([grantVideo, grantTraining]));
    expect(records).toHaveLength(2);
    expect(checkConsentForSubject(records, SUBJECT).ok).toBe(true);
  });

  it("rejects JSON that is neither an array nor an envelope", () => {
    expect(() => loadConsentLedger(write({ notRecords: [] }))).toThrow(/must be a JSON array/);
  });
});
