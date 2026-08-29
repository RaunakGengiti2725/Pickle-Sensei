import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CONSENT_LEDGER_EXPORT_VERSION,
  CONSENT_LEDGER_EXPORT_VERSION_V2,
  canonicalConsentExportSigningPayload,
  canonicalConsentRecordsJson,
  type ConsentLedgerExportV2,
  type ConsentRecord,
} from "@pickle/shared-types";
import { checkConsentForSubject, loadConsentLedger } from "../src/index.js";

/**
 * Wave F f23 export-tampering red team. The v1 envelope's integrity fields
 * are corruption-evident only: an attacker who edits the file can drop the
 * trailing withdrawal and recompute recordCount / maxSeq / recordsSha256, and
 * the result verifies. Two defences are exercised here:
 *   - export contract v2's keyed signature (tamper-evidence), including the
 *     refusal to accept an unsigned envelope when a key is configured;
 *   - a per-subject maxSeq watermark, which catches replay of an OLD but
 *     internally valid export taken before a withdrawal.
 *
 * ALL fixtures are SYNTHETIC: pseudonyms are prefixed
 * `SYNTHETIC-TEST-FIXTURE` and nothing here may ever be copied under
 * datasets/.
 */

const SUBJECT = "SYNTHETIC-TEST-FIXTURE.abuse-subject";
const KEY = "SYNTHETIC-TEST-FIXTURE.signing-key";

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

function v1Envelope(records: ConsentRecord[]): Record<string, unknown> {
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

function sign(header: Omit<ConsentLedgerExportV2, "records" | "signature">, key: string): string {
  return createHmac("sha256", key)
    .update(canonicalConsentExportSigningPayload(header))
    .digest("hex");
}

function v2Envelope(records: ConsentRecord[], key = KEY): Record<string, unknown> {
  const base = v1Envelope(records);
  const header: Omit<ConsentLedgerExportV2, "records" | "signature"> = {
    exportVersion: CONSENT_LEDGER_EXPORT_VERSION_V2,
    exportedAtIso: base.exportedAtIso as string,
    subjectPseudonym: base.subjectPseudonym as string,
    recordCount: base.recordCount as number,
    maxSeq: base.maxSeq as number | null,
    recordsSha256: base.recordsSha256 as string,
  };
  return {
    ...base,
    exportVersion: CONSENT_LEDGER_EXPORT_VERSION_V2,
    signature: { alg: "HMAC-SHA256", keyId: "f23-test-k1", value: sign(header, key) },
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
  dir = mkdtempSync(join(tmpdir(), "consent-export-redteam-"));
});

describe("consent ledger export tampering (Wave F f23)", () => {
  const grantVideo = record({ scope: "video_analysis", consentVersion: "video-analysis-v1" });
  const grantTraining = record({ seq: 2 });
  const withdrawal = record({ action: "withdrawn", seq: 3 });
  const full = [grantVideo, grantTraining, withdrawal];

  it("F23-5a: BREAK — a withdrawal dropped and rehashed passes v1 integrity checks", () => {
    // Documented negative for the unsigned contract: every v1 integrity field
    // is recomputable by whoever holds the file.
    const forged = v1Envelope([grantVideo, grantTraining]);
    const records = loadConsentLedger(write(forged));
    expect(records).toHaveLength(2);
    expect(checkConsentForSubject(records, SUBJECT).modelTrainingActive).toBe(true);
  });

  it("F23-5b: the same forgery fails once the host verifies the v2 signature", () => {
    const signed = v2Envelope(full);
    expect(loadConsentLedger(write(signed), { signingKey: KEY })).toHaveLength(3);

    const forged = v2Envelope([grantVideo, grantTraining], "attacker-key");
    expect(() => loadConsentLedger(write(forged), { signingKey: KEY })).toThrow(
      /signature does not verify/,
    );

    // Keeping the genuine signature while editing the records fails too: the
    // signature covers recordsSha256, which the edit invalidates.
    const spliced = v2Envelope(full);
    spliced.records = [grantVideo, grantTraining];
    spliced.recordCount = 2;
    spliced.maxSeq = 2;
    spliced.recordsSha256 = createHash("sha256")
      .update(canonicalConsentRecordsJson([grantVideo, grantTraining]))
      .digest("hex");
    expect(() => loadConsentLedger(write(spliced), { signingKey: KEY })).toThrow(
      /signature does not verify/,
    );
  });

  it("F23-5c: a configured host refuses signature downgrade to v1 or a bare array", () => {
    expect(() => loadConsentLedger(write(v1Envelope(full)), { signingKey: KEY })).toThrow(
      /signature downgrade/,
    );
    expect(() => loadConsentLedger(write(full), { signingKey: KEY })).toThrow(/signing key/);
  });

  it("F23-5d: replaying a pre-withdrawal export is caught by the maxSeq watermark", () => {
    const current = v2Envelope(full);
    expect(loadConsentLedger(write(current), { signingKey: KEY, minMaxSeq: 3 })).toHaveLength(3);

    // Genuine, correctly signed, internally consistent — but taken before the
    // withdrawal. Without the watermark it authorizes training.
    const stale = v2Envelope([grantVideo, grantTraining]);
    expect(loadConsentLedger(write(stale), { signingKey: KEY })).toHaveLength(2);
    expect(() => loadConsentLedger(write(stale), { signingKey: KEY, minMaxSeq: 3 })).toThrow(
      /stale export replay/,
    );
  });

  it("F23-5e: v2 envelopes still get every v1 integrity check", () => {
    const badHash = v2Envelope(full);
    badHash.recordsSha256 = "0".repeat(64);
    expect(() => loadConsentLedger(write(badHash))).toThrow(/recordsSha256/);
    const badOrder = v2Envelope([grantTraining, grantVideo, withdrawal]);
    expect(() => loadConsentLedger(write(badOrder))).toThrow(/seq/);
  });
});
