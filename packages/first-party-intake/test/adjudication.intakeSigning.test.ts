import { spawnSync } from "node:child_process";
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
import { intakeClip, loadConsentLedger } from "../src/index.js";

/**
 * SPO-01 regression: the signed-export / watermark defences in consentRef.ts
 * must be reachable from the OPERATOR path (intakeClip + the CLI), not only
 * from a direct loadConsentLedger call. Without that wiring a host that has
 * been provisioned with the export signing key still accepts a v1 export
 * whose withdrawal row was stripped and rehashed, and accepts a genuinely
 * signed but stale pre-withdrawal export.
 *
 * ALL fixtures are SYNTHETIC: pseudonyms are prefixed `SYNTHETIC-TEST-FIXTURE`
 * and nothing here may ever be copied under datasets/.
 */

const SUBJECT = "SYNTHETIC-TEST-FIXTURE.spo01-subject";
const KEY = "SYNTHETIC-TEST-FIXTURE.spo01-signing-key";
const OPERATOR = "SYNTHETIC-TEST-FIXTURE.operator-01";
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const TSX = join(import.meta.dirname, "..", "node_modules", ".bin", "tsx");

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
  const value = createHmac("sha256", key)
    .update(canonicalConsentExportSigningPayload(header))
    .digest("hex");
  return {
    ...base,
    exportVersion: CONSENT_LEDGER_EXPORT_VERSION_V2,
    signature: { alg: "HMAC-SHA256", keyId: "spo01-test-k1", value },
    records,
  };
}

const CAPTURE_META = {
  clipId: "SYNTHETIC-TEST-FIXTURE.clip-spo01",
  athleteId: "SYNTHETIC-TEST-FIXTURE.athlete-01",
  athleteGroupId: "SYNTHETIC-TEST-FIXTURE.group-01",
  sessionId: "SYNTHETIC-TEST-FIXTURE.session-01",
  recordedAt: "2026-08-15T10:00:00.000Z",
  capture: {
    cameraView: "rear",
    environment: "outdoor",
    lighting: "daylight",
    deviceClass: "synthetic-lavfi-generator",
    handedness: "unknown",
    skillBand: "unknown",
    ageBand: "withheld",
    adaptivePlay: false,
    bystanderState: "none",
  },
};

let dir: string;
let clipPath: string;
let metaPath: string;
let strippedV1Path: string;
let staleSignedPath: string;
let currentSignedPath: string;

function write(name: string, body: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

function makeClip(path: string): void {
  const res = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=30",
    "-t",
    "3",
    "-pix_fmt",
    "yuv420p",
    "-y",
    path,
  ]);
  if (res.error) throw new Error(`ffmpeg unavailable: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`ffmpeg fixture failed: ${res.stderr.toString()}`);
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(TSX, [CLI, ...args], { encoding: "utf8" });
  if (res.error) throw new Error(`cli spawn failed: ${res.error.message}`);
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const grantVideo = record({ scope: "video_analysis", consentVersion: "video-analysis-v1" });
const grantTraining = record({ seq: 2 });
const withdrawal = record({ action: "withdrawn", seq: 3 });
const full = [grantVideo, grantTraining, withdrawal];
const preWithdrawal = [grantVideo, grantTraining];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "spo01-intake-signing-"));
  clipPath = join(dir, "synthetic-good.mp4");
  makeClip(clipPath);
  metaPath = write("synthetic-capture-meta.json", CAPTURE_META);
  // Attack 1: withdrawal row dropped, integrity fields recomputed, served as v1.
  strippedV1Path = write("stripped-v1.json", v1Envelope(preWithdrawal));
  // Attack 2: genuine signature, internally consistent, but predates the withdrawal.
  staleSignedPath = write("stale-v2.json", v2Envelope(preWithdrawal));
  // The honest current export (signed, includes the withdrawal).
  currentSignedPath = write("current-v2.json", v2Envelope(full));
});

describe("SPO-01: intake consent gate can require a signed, fresh ledger", () => {
  it("control: loadConsentLedger with a signing key refuses the stripped v1 export", () => {
    expect(() => loadConsentLedger(strippedV1Path, { signingKey: KEY })).toThrow(
      /signature downgrade/,
    );
    expect(loadConsentLedger(currentSignedPath, { signingKey: KEY, minMaxSeq: 3 })).toHaveLength(3);
  });

  it("intakeClip with consentSigningKey REJECTS a v1 export (signature downgrade)", () => {
    const record = intakeClip({
      clipPath,
      consentLedgerPath: strippedV1Path,
      subjectPseudonym: SUBJECT,
      captureMetaPath: metaPath,
      operatorId: OPERATOR,
      consentSigningKey: KEY,
    });
    expect(record.status).toBe("REJECTED");
    expect(record.manifestDraft).toBeNull();
    expect(record.consent.ok).toBe(false);
    expect(record.reasons.join("\n")).toMatch(/signature downgrade/);

    // Same key against the honest signed export still authorizes: the gate is
    // a real verification, not a blanket refusal.
    const honest = intakeClip({
      clipPath,
      consentLedgerPath: currentSignedPath,
      subjectPseudonym: SUBJECT,
      captureMetaPath: metaPath,
      operatorId: OPERATOR,
      consentSigningKey: KEY,
    });
    // The honest ledger carries the withdrawal, so consent (not the ledger) fails.
    expect(honest.status).toBe("REJECTED");
    expect(honest.reasons.join("\n")).not.toMatch(/signature|integrity/);
    expect(honest.reasons.join("\n")).toMatch(/model_training consent is not active/);
  });

  it("intakeClip with consentMinMaxSeq REJECTS a validly signed stale export (replay)", () => {
    const withoutWatermark = intakeClip({
      clipPath,
      consentLedgerPath: staleSignedPath,
      subjectPseudonym: SUBJECT,
      captureMetaPath: metaPath,
      operatorId: OPERATOR,
      consentSigningKey: KEY,
    });
    expect(withoutWatermark.status).toBe("ACCEPTED");

    const record = intakeClip({
      clipPath,
      consentLedgerPath: staleSignedPath,
      subjectPseudonym: SUBJECT,
      captureMetaPath: metaPath,
      operatorId: OPERATOR,
      consentSigningKey: KEY,
      consentMinMaxSeq: 3,
    });
    expect(record.status).toBe("REJECTED");
    expect(record.manifestDraft).toBeNull();
    expect(record.reasons.join("\n")).toMatch(/stale export replay/);
  });

  it("CLI parses --signing-key / --min-max-seq, forwards them, and rejects unknown flags", () => {
    const base = [
      "--clip",
      clipPath,
      "--subject",
      SUBJECT,
      "--capture-meta",
      metaPath,
      "--operator",
      OPERATOR,
    ];

    const downgraded = runCli([...base, "--consent-ledger", strippedV1Path, "--signing-key", KEY]);
    expect(downgraded.status).toBe(1);
    expect(downgraded.stderr).toMatch(/intake status: REJECTED/);
    expect(downgraded.stderr).toMatch(/signature downgrade/);

    const stale = runCli([
      ...base,
      "--consent-ledger",
      staleSignedPath,
      "--signing-key",
      KEY,
      "--min-max-seq",
      "3",
    ]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/intake status: REJECTED/);
    expect(stale.stderr).toMatch(/stale export replay/);

    // Same stale export, watermark not yet advanced: still accepted (control),
    // proving the flag itself is what flips the verdict.
    const accepted = runCli([...base, "--consent-ledger", staleSignedPath, "--signing-key", KEY]);
    expect(accepted.status).toBe(0);
    expect(accepted.stderr).toMatch(/intake status: ACCEPTED/);

    const unknownFlag = runCli([...base, "--consent-ledger", staleSignedPath, "--signin-key", KEY]);
    expect(unknownFlag.status).toBe(2);
    expect(unknownFlag.stderr).toMatch(/usage: intake/);
    expect(unknownFlag.stderr).toMatch(/--signin-key/);
    expect(unknownFlag.stdout).toBe("");

    const badWatermark = runCli([
      ...base,
      "--consent-ledger",
      staleSignedPath,
      "--min-max-seq",
      "three",
    ]);
    expect(badWatermark.status).toBe(2);
    expect(badWatermark.stderr).toMatch(/usage: intake/);
  });
});
