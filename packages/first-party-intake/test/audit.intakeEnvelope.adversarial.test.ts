/**
 * Audit harness (execution pass 2, shared-packages-ops). New file only; no
 * production code changed. `it.fails` cases pin REPRODUCED defects — they
 * pass while the defect exists and start failing once it is fixed.
 *
 * ALL fixtures are SYNTHETIC (ffmpeg lavfi testsrc2 clips, pseudonyms
 * prefixed `SYNTHETIC-TEST-FIXTURE`). Nothing here may be copied under
 * datasets/.
 */
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
import { intakeClip, loadConsentLedger, type IntakeInput } from "../src/index.js";

const SUBJECT = "SYNTHETIC-TEST-FIXTURE.audit-subject";
const KEY = "SYNTHETIC-TEST-FIXTURE.audit-signing-key";

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
    signature: { alg: "HMAC-SHA256", keyId: "audit-k1", value },
    records,
  };
}

const grantVideo = row({
  id: "SYNTHETIC-TEST-FIXTURE.r1",
  scope: "video_analysis",
  consentVersion: "video-analysis-v1",
  seq: 1,
});
const grantTraining = row({ id: "SYNTHETIC-TEST-FIXTURE.r2", seq: 2 });
const withdrawTraining = row({
  id: "SYNTHETIC-TEST-FIXTURE.r3",
  action: "withdrawn",
  recordedAtIso: "2026-08-30T00:00:00.000Z",
  seq: 3,
});

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
  dir = mkdtempSync(join(tmpdir(), "audit-intake-envelope-"));
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

describe("audit: intakeClip does not reach the signed/watermarked ledger defences", () => {
  it("precondition: the full signed ledger (grant, grant, withdrawal) is REJECTED — training consent withdrawn", () => {
    const full = write("full-v2.json", v2Envelope([grantVideo, grantTraining, withdrawTraining]));
    expect(intakeClip(input(full)).status).toBe("REJECTED");
  });

  it.fails(
    "FINDING: a stale pre-withdrawal export (internally valid, signed) is ACCEPTED by intakeClip — no watermark can be supplied",
    () => {
      const stale = write("stale-v2.json", v2Envelope([grantVideo, grantTraining]));
      // The library-level defence exists and rejects it when a watermark is given …
      expect(() => loadConsentLedger(stale, { signingKey: KEY, minMaxSeq: 3 })).toThrow(
        /stale export replay/,
      );
      // … but IntakeInput has no way to pass it, so intake accepts.
      expect(intakeClip(input(stale)).status).toBe("REJECTED");
    },
  );

  it.fails(
    "FINDING: an UNSIGNED v1 envelope with the withdrawal dropped and rehashed is ACCEPTED by intakeClip — no signing key can be supplied",
    () => {
      const forged = write("forged-v1.json", v1Envelope([grantVideo, grantTraining]));
      expect(() => loadConsentLedger(forged, { signingKey: KEY })).toThrow(/signature downgrade/);
      expect(intakeClip(input(forged)).status).toBe("REJECTED");
    },
  );

  it("evidence: IntakeInput carries no signingKey / minMaxSeq and intakeClip accepts both tampered ledgers", () => {
    const keys = Object.keys(input("x")).sort();
    expect(keys).toEqual([
      "captureMetaPath",
      "clipPath",
      "consentLedgerPath",
      "operatorId",
      "subjectPseudonym",
    ]);
    const stale = write("stale-v2b.json", v2Envelope([grantVideo, grantTraining]));
    const forged = write("forged-v1b.json", v1Envelope([grantVideo, grantTraining]));
    expect(intakeClip(input(stale)).status).not.toBe("REJECTED");
    expect(intakeClip(input(forged)).status).not.toBe("REJECTED");
  });

  it("evidence: the operator CLI has no --signing-key / --min-max-seq flag and exits 0 on the forged v1 export", () => {
    const forged = write("forged-v1-cli.json", v1Envelope([grantVideo, grantTraining]));
    const run = (extra: string[]) =>
      spawnSync(
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
          ...extra,
        ],
        { encoding: "utf8" },
      );
    const plain = run([]);
    expect(plain.status).toBe(0);
    expect(plain.stderr).toContain("intake status: ACCEPTED");
    // Unknown flags are silently ignored (parseArgs stores any `--x v` pair),
    // so an operator who *thinks* they enabled signature checking gets the same
    // ACCEPTED verdict with no warning.
    const withFlag = run(["--signing-key", KEY, "--min-max-seq", "3"]);
    expect(withFlag.status).toBe(0);
    expect(withFlag.stderr).toContain("intake status: ACCEPTED");
    expect(withFlag.stderr).not.toMatch(/unknown|unrecognized|signing/i);
  });

  it.fails(
    "FINDING: the CLI accepts and silently drops unknown flags instead of exiting 2 with usage",
    () => {
      const forged = write("forged-v1-cli2.json", v1Envelope([grantVideo, grantTraining]));
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
          "--not-a-real-flag",
          "1",
        ],
        { encoding: "utf8" },
      );
      expect(res.status).toBe(2);
    },
  );

  it("holds: tampered envelopes that break integrity fields are rejected by intakeClip (exception path)", () => {
    const env = v2Envelope([grantVideo, grantTraining, withdrawTraining]);
    const truncated = write("truncated.json", { ...env, records: [grantVideo, grantTraining] });
    expect(() => intakeClip(input(truncated))).toThrow(/integrity verification/);
    const badSeq = write("badseq.json", v1Envelope([grantTraining, grantVideo]));
    expect(() => intakeClip(input(badSeq))).toThrow(/not strictly ordered by seq/);
    const otherSubject = write("othersubject.json", {
      ...v1Envelope([grantVideo, grantTraining]),
      subjectPseudonym: "SYNTHETIC-TEST-FIXTURE.someone-else",
    });
    expect(() => intakeClip(input(otherSubject))).toThrow(/subject other than/);
  });
});
