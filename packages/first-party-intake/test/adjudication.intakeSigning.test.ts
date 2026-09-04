/**
 * Adjudication repro (shared-packages-ops) — intake consent gate cannot be
 * made tamper-evident.
 *
 * loadConsentLedger() implements v2 HMAC verification and a maxSeq watermark,
 * but IntakeInput / intakeClip() / the operator CLI never pass those options.
 * A v1 export with the withdrawal row stripped and recordsSha256 recomputed
 * is therefore ACCEPTED, and `--signing-key` on the CLI is silently ignored.
 * The three non-control tests FAIL on 4d812e1a.
 */
import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONSENT_LEDGER_EXPORT_VERSION,
  CONSENT_LEDGER_EXPORT_VERSION_V2,
  canonicalConsentExportSigningPayload,
  canonicalConsentRecordsJson,
  type ConsentLedgerExportV2,
  type ConsentRecord,
} from "@pickle/shared-types";
import { beforeAll, describe, expect, it } from "vitest";
import { intakeClip, loadConsentLedger, type IntakeInput } from "../src/index.js";

const SUBJECT = "SYNTHETIC-TEST-FIXTURE.subject";
const KEY = "SYNTHETIC-TEST-FIXTURE.signing-key";

function row(overrides: Partial<ConsentRecord>): ConsentRecord {
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

const grantVideo = row({
  id: "r1",
  scope: "video_analysis",
  consentVersion: "video-analysis-v1",
  seq: 1,
});
const grantTraining = row({ id: "r2", seq: 2 });
const withdrawTraining = row({
  id: "r3",
  action: "withdrawn",
  recordedAtIso: "2026-08-30T00:00:00.000Z",
  seq: 3,
});

function v1Envelope(records: ConsentRecord[]): Record<string, unknown> {
  return {
    exportVersion: CONSENT_LEDGER_EXPORT_VERSION,
    exportedAtIso: "2026-08-30T00:00:01.000Z",
    subjectPseudonym: SUBJECT,
    recordCount: records.length,
    maxSeq: records.at(-1)?.seq ?? null,
    recordsSha256: createHash("sha256").update(canonicalConsentRecordsJson(records)).digest("hex"),
    records,
  };
}

function v2Envelope(records: ConsentRecord[], key: string): Record<string, unknown> {
  const base = v1Envelope(records);
  const header: Omit<ConsentLedgerExportV2, "records" | "signature"> = {
    exportVersion: CONSENT_LEDGER_EXPORT_VERSION_V2,
    exportedAtIso: base.exportedAtIso as string,
    subjectPseudonym: SUBJECT,
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
    signature: { alg: "HMAC-SHA256", keyId: "adj-k1", value },
  };
}

let dir: string;
let clip: string;
let meta: string;

function write(name: string, body: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

function input(ledgerPath: string): IntakeInput {
  return {
    clipPath: clip,
    consentLedgerPath: ledgerPath,
    subjectPseudonym: SUBJECT,
    captureMetaPath: meta,
    operatorId: "SYNTHETIC-TEST-FIXTURE.operator",
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "adjudication-intake-"));
  clip = join(dir, "synthetic.mp4");
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
    clip,
  ]);
  if (res.error) throw new Error(`ffmpeg unavailable: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`ffmpeg fixture failed: ${res.stderr.toString()}`);
  meta = write("meta.json", {
    clipId: "SYNTHETIC-TEST-FIXTURE.clip-01",
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
  });
});

describe("adjudication: intake consent gate must be able to require a signed, fresh export", () => {
  it("control: the library rejects the forged v1 export when a signing key IS passed", () => {
    const forged = write("forged-v1.json", v1Envelope([grantVideo, grantTraining]));
    expect(() => loadConsentLedger(forged, { signingKey: KEY })).toThrow(/signature downgrade/);
    const full = write("full-v1.json", v1Envelope([grantVideo, grantTraining, withdrawTraining]));
    expect(intakeClip(input(full)).status).toBe("REJECTED");
  });

  it("intakeClip can be given the signing key and then REJECTS the forged v1 export", () => {
    const forged = write("forged-v1-b.json", v1Envelope([grantVideo, grantTraining]));
    const withKey = { ...input(forged), consentSigningKey: KEY } as IntakeInput;
    // Either the option is honoured (REJECTED) or unknown fields are refused —
    // silently ACCEPTING a subject whose withdrawal was stripped is the defect.
    expect(intakeClip(withKey).status).toBe("REJECTED");
  });

  it("intakeClip can be given a ledger watermark and REJECTS a stale signed export", () => {
    const stale = write("stale-v2.json", v2Envelope([grantVideo, grantTraining], KEY));
    const withWatermark = {
      ...input(stale),
      consentSigningKey: KEY,
      consentMinMaxSeq: 3,
    } as IntakeInput;
    expect(intakeClip(withWatermark).status).toBe("REJECTED");
  });

  it("the operator CLI refuses unknown flags (exit 2) instead of swallowing --signing-key", () => {
    const forged = write("forged-v1-cli.json", v1Envelope([grantVideo, grantTraining]));
    const res = spawnSync(
      join(process.cwd(), "node_modules", ".bin", "tsx"),
      [
        join(process.cwd(), "src", "cli.ts"),
        "--clip",
        clip,
        "--consent-ledger",
        forged,
        "--subject",
        SUBJECT,
        "--capture-meta",
        meta,
        "--operator",
        "SYNTHETIC-TEST-FIXTURE.operator",
        "--signing-key",
        KEY,
      ],
      { encoding: "utf8" },
    );
    expect(res.stderr).not.toContain("intake status: ACCEPTED");
    expect(res.status).not.toBe(0);
  });
});
