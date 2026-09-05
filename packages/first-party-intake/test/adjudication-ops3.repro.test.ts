import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CONSENT_LEDGER_EXPORT_VERSION_V2,
  canonicalConsentExportSigningPayload,
  canonicalConsentRecordsJson,
  type ConsentLedgerExportV2,
  type ConsentRecord,
} from "@pickle/shared-types";
import { intakeClip, loadConsentLedger } from "../src/index.js";

/**
 * Adjudication repro (stress area packages-ops-3, baseline 1fb0efd7).
 * Root cause: `loadConsentLedger` verifies the v2 HMAC only when the caller
 * passes `{ signingKey }`, but `intakeClip` calls it with no options and the
 * intake CLI exposes no signing-key argument — so the intake host (named in
 * shared-types/consent.ts as one of the two HMAC consumers) has NO way to
 * enforce signatures. A v2 envelope signed with an attacker's key, whose
 * records omit a withdrawal, passes intake as ACCEPTED.
 *
 * Replayed from origin/devin/stress-pkg-ops-bundle-boundary-malformed
 * (first-party-intake boundaryMalformed.stress.test.ts, seed 0xf1a74a11):
 * forged-signature consent export accepted by intakeClip.
 *
 * ALL fixtures are SYNTHETIC (`SYNTHETIC-TEST-FIXTURE` pseudonyms, lavfi
 * clips); nothing here may ever be copied under datasets/.
 *
 * The first test documents the observed baseline behaviour; the last two
 * assert the EXPECTED contract and therefore FAIL on 1fb0efd7.
 */

const SUBJECT = "SYNTHETIC-TEST-FIXTURE.adjudicate-subject";
const REAL_KEY = "SYNTHETIC-TEST-FIXTURE.host-signing-key";
const ATTACKER_KEY = "SYNTHETIC-TEST-FIXTURE.attacker-key";

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

function v2Envelope(records: ConsentRecord[], key: string): Record<string, unknown> {
  const header: Omit<ConsentLedgerExportV2, "records" | "signature"> = {
    exportVersion: CONSENT_LEDGER_EXPORT_VERSION_V2,
    exportedAtIso: "2026-08-29T00:00:01.000Z",
    subjectPseudonym: SUBJECT,
    recordCount: records.length,
    maxSeq: records.length > 0 ? (records.at(-1)!.seq ?? null) : null,
    recordsSha256: createHash("sha256").update(canonicalConsentRecordsJson(records)).digest("hex"),
  };
  const value = createHmac("sha256", key)
    .update(canonicalConsentExportSigningPayload(header))
    .digest("hex");
  return { ...header, signature: { alg: "HMAC-SHA256", keyId: "adjudicate-k1", value }, records };
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

const CAPTURE_META = {
  clipId: "SYNTHETIC-TEST-FIXTURE.clip-adjudicate",
  athleteId: "SYNTHETIC-TEST-FIXTURE.athlete-adjudicate",
  athleteGroupId: "SYNTHETIC-TEST-FIXTURE.group-adjudicate",
  sessionId: "SYNTHETIC-TEST-FIXTURE.session-adjudicate",
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
let clip: string;
let meta: string;
let forgedLedger: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "intake-adjudicate-"));
  clip = join(dir, "synthetic.mp4");
  makeClip(clip);
  meta = join(dir, "capture-meta.json");
  writeFileSync(meta, JSON.stringify(CAPTURE_META));

  const grantVideo = record({
    scope: "video_analysis",
    consentVersion: "video-analysis-v1",
    seq: 1,
  });
  const grantTraining = record({ seq: 2 });
  // The genuine ledger ends with a withdrawal; the forgery drops it and re-signs with the attacker's key.
  forgedLedger = join(dir, "forged-v2-ledger.json");
  writeFileSync(
    forgedLedger,
    JSON.stringify(v2Envelope([grantVideo, grantTraining], ATTACKER_KEY)),
  );
});

describe("first-party-intake: v2 consent export signatures must be enforceable at intake", () => {
  it("baseline: loadConsentLedger with the host key rejects the forgery (verification code exists)", () => {
    expect(() => loadConsentLedger(forgedLedger, { signingKey: REAL_KEY })).toThrow(
      /signature does not verify/,
    );
  });

  it("intakeClip must not ACCEPT a v2 export whose signature was never verified against a host key", () => {
    const result = intakeClip({
      clipPath: clip,
      consentLedgerPath: forgedLedger,
      subjectPseudonym: SUBJECT,
      captureMetaPath: meta,
      operatorId: "SYNTHETIC-TEST-FIXTURE.operator",
    });
    expect(result.status).toBe("REJECTED");
  });

  it("the intake CLI does not exit 0 (ACCEPTED) for a v2 export it could not verify", () => {
    const pkgRoot = join(__dirname, "..");
    const res = spawnSync(
      join(pkgRoot, "node_modules/.bin/tsx"),
      [
        join(pkgRoot, "src/cli.ts"),
        "--clip",
        clip,
        "--consent-ledger",
        forgedLedger,
        "--subject",
        SUBJECT,
        "--capture-meta",
        meta,
        "--operator",
        "SYNTHETIC-TEST-FIXTURE.operator",
      ],
      { cwd: pkgRoot, encoding: "utf8" },
    );
    const parsed = JSON.parse(res.stdout) as { status?: string };
    expect({ exit: res.status, status: parsed.status }).not.toEqual({
      exit: 0,
      status: "ACCEPTED",
    });
  });
});
