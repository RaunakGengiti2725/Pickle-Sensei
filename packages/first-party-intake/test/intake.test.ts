import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConsentRecord } from "@pickle/shared-types";
import { checkConsentForSubject, intakeClip, loadConsentLedger } from "../src/index.js";

/**
 * ALL fixtures in this file are SYNTHETIC. Clips are ffmpeg lavfi noise
 * (no camera, no athlete, no court); consent rows use pseudonyms prefixed
 * `SYNTHETIC-TEST-FIXTURE`. Nothing here is corpus data and nothing here
 * may ever be copied under datasets/.
 */

const SYNTH_SUBJECT = "SYNTHETIC-TEST-FIXTURE.subject-01";
const SYNTH_WITHDRAWN = "SYNTHETIC-TEST-FIXTURE.subject-02-withdrawn";
const SYNTH_NO_TRAINING = "SYNTHETIC-TEST-FIXTURE.subject-03-analysis-only";

let dir: string;
let goodClip: string;
let lowResClip: string;
let ledgerPath: string;
let metaPath: string;

function makeClip(path: string, size: string, fps: number, seconds: number): void {
  const res = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=gray:s=${size}:r=${fps},noise=alls=60:allf=u`,
    "-t",
    String(seconds),
    "-pix_fmt",
    "yuv420p",
    "-y",
    path,
  ]);
  if (res.error) throw new Error(`ffmpeg unavailable: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`ffmpeg fixture failed: ${res.stderr.toString()}`);
}

function consentRow(overrides: Partial<ConsentRecord>): ConsentRecord {
  return {
    id: "SYNTHETIC-TEST-FIXTURE.record",
    subjectPseudonym: SYNTH_SUBJECT,
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

const LEDGER: ConsentRecord[] = [
  consentRow({ id: "SYNTHETIC-TEST-FIXTURE.r1" }),
  consentRow({
    id: "SYNTHETIC-TEST-FIXTURE.r2",
    scope: "model_training",
    consentVersion: "model-training-v1",
    recordedAtIso: "2026-08-01T00:01:00.000Z",
  }),
  consentRow({ id: "SYNTHETIC-TEST-FIXTURE.r3", subjectPseudonym: SYNTH_WITHDRAWN }),
  consentRow({
    id: "SYNTHETIC-TEST-FIXTURE.r4",
    subjectPseudonym: SYNTH_WITHDRAWN,
    scope: "model_training",
    consentVersion: "model-training-v1",
    recordedAtIso: "2026-08-01T00:01:00.000Z",
  }),
  consentRow({
    id: "SYNTHETIC-TEST-FIXTURE.r5",
    subjectPseudonym: SYNTH_WITHDRAWN,
    scope: "model_training",
    action: "withdrawn",
    consentVersion: "model-training-v1",
    recordedAtIso: "2026-08-02T00:00:00.000Z",
  }),
  consentRow({ id: "SYNTHETIC-TEST-FIXTURE.r6", subjectPseudonym: SYNTH_NO_TRAINING }),
];

const CAPTURE_META = {
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
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "first-party-intake-test-"));
  goodClip = join(dir, "synthetic-good.mp4");
  lowResClip = join(dir, "synthetic-lowres.mp4");
  makeClip(goodClip, "1280x720", 30, 3);
  makeClip(lowResClip, "320x240", 30, 3);
  ledgerPath = join(dir, "synthetic-consent-ledger.json");
  writeFileSync(ledgerPath, JSON.stringify(LEDGER, null, 2));
  metaPath = join(dir, "synthetic-capture-meta.json");
  writeFileSync(metaPath, JSON.stringify(CAPTURE_META, null, 2));
});

afterAll(() => {
  // Fixtures live in tmpdir only; nothing is written into the repository.
});

describe("consent reference validation (C10 wiring)", () => {
  it("accepts a subject with active video_analysis AND model_training grants", () => {
    const result = checkConsentForSubject(loadConsentLedger(ledgerPath), SYNTH_SUBJECT);
    expect(result.ok).toBe(true);
    expect(result.modelTrainingActive).toBe(true);
    expect(result.modelTrainingConsentVersion).toBe("model-training-v1");
  });

  it("rejects an unknown subject: absence of records means NOT consented", () => {
    const result = checkConsentForSubject(
      loadConsentLedger(ledgerPath),
      "SYNTHETIC-TEST-FIXTURE.subject-unknown",
    );
    expect(result.ok).toBe(false);
    expect(result.subjectRecordCount).toBe(0);
  });

  it("rejects a subject whose model_training grant was withdrawn (ledger fold)", () => {
    const result = checkConsentForSubject(loadConsentLedger(ledgerPath), SYNTH_WITHDRAWN);
    expect(result.ok).toBe(false);
    expect(result.videoAnalysisActive).toBe(true);
    expect(result.modelTrainingActive).toBe(false);
  });

  it("rejects a subject with only video_analysis: training is opt-in, never a default", () => {
    const result = checkConsentForSubject(loadConsentLedger(ledgerPath), SYNTH_NO_TRAINING);
    expect(result.ok).toBe(false);
    expect(result.modelTrainingActive).toBe(false);
  });

  it("refuses a malformed ledger instead of skipping bad rows", () => {
    const badPath = join(dir, "synthetic-bad-ledger.json");
    writeFileSync(badPath, JSON.stringify([{ id: "x" }]));
    expect(() => loadConsentLedger(badPath)).toThrow(/malformed/);
  });
});

describe("intakeClip", () => {
  it("accepts a supported synthetic clip with active consent and drafts the manifest entry", () => {
    const record = intakeClip({
      clipPath: goodClip,
      consentLedgerPath: ledgerPath,
      subjectPseudonym: SYNTH_SUBJECT,
      captureMetaPath: metaPath,
      operatorId: "SYNTHETIC-TEST-FIXTURE.operator-01",
    });
    expect(record.status).toBe("ACCEPTED");
    expect(record.envelope?.overall).toBe("SUPPORTED");
    // Pose-gated dimensions are honestly unmeasured at intake, never fabricated.
    expect(record.envelope?.notMeasured).toEqual(["player_pixel_height", "player_visibility"]);
    const draft = record.manifestDraft;
    expect(draft).not.toBeNull();
    expect(draft?.rawAsset.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(draft?.rawAsset.widthPx).toBe(1280);
    expect(draft?.rawAsset.heightPx).toBe(720);
    expect(draft?.rawAsset.frameCount).toBe(90);
    expect(draft?.capture.sourceKind).toBe("consented_first_party_capture");
    expect(draft?.consentReference.modelTrainingConsentVersion).toBe("model-training-v1");
    // The draft never claims snapshot eligibility.
    expect(draft?.pendingBeforeSnapshot.join(" ")).toContain("approved_for_snapshot");
  });

  it("rejects a clip whose envelope is UNSUPPORTED (320x240 short side below 480)", () => {
    const record = intakeClip({
      clipPath: lowResClip,
      consentLedgerPath: ledgerPath,
      subjectPseudonym: SYNTH_SUBJECT,
      captureMetaPath: metaPath,
      operatorId: "SYNTHETIC-TEST-FIXTURE.operator-01",
    });
    expect(record.status).toBe("REJECTED");
    expect(record.manifestDraft).toBeNull();
    expect(record.reasons.join(" ")).toContain("resolution");
  });

  it("rejects a good clip when the subject lacks an active model_training grant", () => {
    const record = intakeClip({
      clipPath: goodClip,
      consentLedgerPath: ledgerPath,
      subjectPseudonym: SYNTH_WITHDRAWN,
      captureMetaPath: metaPath,
      operatorId: "SYNTHETIC-TEST-FIXTURE.operator-01",
    });
    expect(record.status).toBe("REJECTED");
    expect(record.manifestDraft).toBeNull();
    expect(record.reasons.join(" ")).toContain("model_training");
  });

  it("throws on invalid capture metadata (bad enum) instead of drafting a wrong record", () => {
    const badMetaPath = join(dir, "synthetic-bad-meta.json");
    writeFileSync(
      badMetaPath,
      JSON.stringify({
        ...CAPTURE_META,
        capture: { ...CAPTURE_META.capture, cameraView: "drone" },
      }),
    );
    expect(() =>
      intakeClip({
        clipPath: goodClip,
        consentLedgerPath: ledgerPath,
        subjectPseudonym: SYNTH_SUBJECT,
        captureMetaPath: badMetaPath,
        operatorId: "SYNTHETIC-TEST-FIXTURE.operator-01",
      }),
    ).toThrow(/cameraView/);
  });
});
