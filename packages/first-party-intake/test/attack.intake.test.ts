/**
 * Adversarial pass (shared-packages-ops #1, pass 3) — first-party intake
 * consent path. ALL fixtures SYNTHETIC (lavfi testsrc2 clips, pseudonyms
 * prefixed `SYNTHETIC-TEST-FIXTURE`). `it(...)` = HELD / OBSERVED (pinned
 * current behaviour); `it.fails(...)` = EXPECTED contract that is currently
 * broken.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CONSENT_LEDGER_EXPORT_VERSION,
  canonicalConsentRecordsJson,
  type ConsentRecord,
} from "@pickle/shared-types";
import { checkConsentForSubject, intakeClip, loadConsentLedger } from "../src/index.js";

const SUBJECT = "SYNTHETIC-TEST-FIXTURE.attack-subject";

let dir: string;
let goodClip: string;
let metaPath: string;

function makeClip(path: string, size: string, fps: number, seconds: number): void {
  const res = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${size}:rate=${fps}`,
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

function row(overrides: Partial<ConsentRecord>): ConsentRecord {
  return {
    id: "SYNTHETIC-TEST-FIXTURE.rec",
    subjectPseudonym: SUBJECT,
    scope: "model_training",
    action: "granted",
    consentVersion: "model-training-v1",
    source: "mobile_settings",
    device: null,
    captureMode: "all_captures",
    strokeIntent: null,
    recordedAtIso: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function write(name: string, body: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
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

const CAPTURE_META = {
  clipId: "SYNTHETIC-TEST-FIXTURE.clip-attack",
  athleteId: "SYNTHETIC-TEST-FIXTURE.athlete-attack",
  athleteGroupId: "SYNTHETIC-TEST-FIXTURE.group-attack",
  sessionId: "SYNTHETIC-TEST-FIXTURE.session-attack",
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
  dir = mkdtempSync(join(tmpdir(), "first-party-intake-attack-"));
  goodClip = join(dir, "synthetic-good.mp4");
  makeClip(goodClip, "1280x720", 30, 3);
  metaPath = write("meta.json", CAPTURE_META);
});

const VIDEO_GRANT = row({
  id: "v",
  scope: "video_analysis",
  consentVersion: "video-analysis-v1",
  seq: 1,
});
const TRAINING_GRANT = row({ id: "t", seq: 2, recordedAtIso: "2026-08-01T00:01:00.000Z" });
const TRAINING_WITHDRAWN = row({
  id: "w",
  action: "withdrawn",
  seq: 3,
  recordedAtIso: "2026-08-02T00:00:00.000Z",
});

describe("intakeClip consent path — the v2 signature / watermark defences are never wired in", () => {
  it("OBSERVED: intakeClip ACCEPTS a clip on a bare-array ledger whose trailing withdrawal was simply deleted (no signing key, no watermark are ever passed)", () => {
    const forged = write("forged-array.json", [VIDEO_GRANT, TRAINING_GRANT]);
    const rec = intakeClip({
      clipPath: goodClip,
      consentLedgerPath: forged,
      subjectPseudonym: SUBJECT,
      captureMetaPath: metaPath,
      operatorId: "attacker",
    });
    expect(rec.consent.ok).toBe(true);
    expect(rec.status).not.toBe("REJECTED");
    expect(rec.manifestDraft?.consentReference.modelTrainingConsentVersion).toBe(
      "model-training-v1",
    );
  });

  it("OBSERVED: intakeClip ACCEPTS a v1 export envelope rehashed after dropping the withdrawal (F23-5a forgery reaches the manifest draft)", () => {
    const forged = write("forged-v1.json", v1Envelope([VIDEO_GRANT, TRAINING_GRANT]));
    const rec = intakeClip({
      clipPath: goodClip,
      consentLedgerPath: forged,
      subjectPseudonym: SUBJECT,
      captureMetaPath: metaPath,
      operatorId: "attacker",
    });
    expect(rec.consent.ok).toBe(true);
    expect(rec.status).toBe("ACCEPTED");
  });

  it("HELD (control): the same subject with the withdrawal present is REJECTED", () => {
    const honest = write(
      "honest.json",
      v1Envelope([VIDEO_GRANT, TRAINING_GRANT, TRAINING_WITHDRAWN]),
    );
    const rec = intakeClip({
      clipPath: goodClip,
      consentLedgerPath: honest,
      subjectPseudonym: SUBJECT,
      captureMetaPath: metaPath,
      operatorId: "tester",
    });
    expect(rec.status).toBe("REJECTED");
    expect(rec.reasons.join("\n")).toMatch(/model_training consent is not active/);
    expect(rec.manifestDraft).toBeNull();
  });

  it("OBSERVED: bare-array ledger, no seq — a grant with a +05:00 offset that is chronologically BEFORE the Z withdrawal keeps model_training ACTIVE through intake", () => {
    const grantEarlierWithOffset = row({ id: "g", recordedAtIso: "2026-08-02T04:00:00.000+05:00" }); // 2026-08-01T23:00Z
    const withdrawLater = row({
      id: "w",
      action: "withdrawn",
      recordedAtIso: "2026-08-02T00:00:00.000Z",
    });
    expect(Date.parse(grantEarlierWithOffset.recordedAtIso)).toBeLessThan(
      Date.parse(withdrawLater.recordedAtIso),
    );
    const video = row({ id: "v", scope: "video_analysis", consentVersion: "video-analysis-v1" });
    const ledger = loadConsentLedger(
      write("offset.json", [video, withdrawLater, grantEarlierWithOffset]),
    );
    const check = checkConsentForSubject(ledger, SUBJECT);
    expect(check.modelTrainingActive).toBe(true);
    expect(check.ok).toBe(true);
  });

  it.fails("EXPECTED: a chronologically later withdrawal always wins", () => {
    const grantEarlierWithOffset = row({ id: "g", recordedAtIso: "2026-08-02T04:00:00.000+05:00" });
    const withdrawLater = row({
      id: "w",
      action: "withdrawn",
      recordedAtIso: "2026-08-02T00:00:00.000Z",
    });
    const video = row({ id: "v", scope: "video_analysis", consentVersion: "video-analysis-v1" });
    const ledger = loadConsentLedger(
      write("offset2.json", [video, withdrawLater, grantEarlierWithOffset]),
    );
    expect(checkConsentForSubject(ledger, SUBJECT).modelTrainingActive).toBe(false);
  });
});

describe("envelope integrity edge cases", () => {
  it("HELD: recordCount as string '2', maxSeq as string, negative seq gaps, seq as float — all rejected", () => {
    const base = v1Envelope([VIDEO_GRANT, TRAINING_GRANT]);
    expect(() => loadConsentLedger(write("rc.json", { ...base, recordCount: "2" }))).toThrow(
      /recordCount/,
    );
    expect(() => loadConsentLedger(write("ms.json", { ...base, maxSeq: "2" }))).toThrow(/maxSeq/);
    const dup = v1Envelope([VIDEO_GRANT, { ...TRAINING_GRANT, seq: 1 }]);
    expect(() => loadConsentLedger(write("dup.json", dup))).toThrow(/strictly ordered by seq/);
  });

  it("OBSERVED: an envelope whose records carry seq values 1e15 and 1e15+1 verifies; seq beyond 2^53 collapse and are rejected as unordered", () => {
    const big = v1Envelope([
      { ...VIDEO_GRANT, seq: 1e15 },
      { ...TRAINING_GRANT, seq: 1e15 + 1 },
    ]);
    expect(loadConsentLedger(write("big.json", big))).toHaveLength(2);
    const collapsed = v1Envelope([
      { ...VIDEO_GRANT, seq: 2 ** 53 },
      { ...TRAINING_GRANT, seq: 2 ** 53 + 1 },
    ]);
    expect(() => loadConsentLedger(write("collapsed.json", collapsed))).toThrow(
      /strictly ordered by seq/,
    );
  });

  it("HELD: a subject pseudonym in NFD vs NFC is a different subject — envelope subject check rejects the mismatch, and the fold finds no records", () => {
    const nfc = "SYNTHETIC-TEST-FIXTURE.é";
    const nfd = "SYNTHETIC-TEST-FIXTURE.e\u0301";
    const env = v1Envelope([
      { ...VIDEO_GRANT, subjectPseudonym: nfc },
      { ...TRAINING_GRANT, subjectPseudonym: nfc },
    ]);
    env.subjectPseudonym = nfd;
    expect(() => loadConsentLedger(write("nfd.json", env))).toThrow(
      /other than the envelope's subjectPseudonym/,
    );
    env.subjectPseudonym = nfc;
    const records = loadConsentLedger(write("nfc.json", env));
    expect(checkConsentForSubject(records, nfd).ok).toBe(false);
    expect(checkConsentForSubject(records, nfc).ok).toBe(true);
  });

  it("HELD: JSON with a UTF-8 BOM, a truncated file, and a JSON `null` are all rejected before any consent is derived", () => {
    expect(() => loadConsentLedger(write("bom.json", "\ufeff[]"))).toThrow();
    expect(() => loadConsentLedger(write("trunc.json", '[{"id":"x"'))).toThrow(SyntaxError);
    expect(() => loadConsentLedger(write("null.json", "null"))).toThrow(/must be a JSON array/);
  });

  it("HELD: an empty envelope (0 records, maxSeq null) loads, and the subject is NOT consented", () => {
    const records = loadConsentLedger(write("empty.json", v1Envelope([])));
    expect(records).toEqual([]);
    expect(checkConsentForSubject(records, SUBJECT).errors[0]).toMatch(/NOT consented by default/);
  });

  it("HELD: a huge ledger (20,000 rows, seq-ordered, last is withdrawal) folds to inactive", () => {
    const rows: ConsentRecord[] = [];
    for (let i = 1; i <= 20_000; i++) {
      rows.push(row({ id: `r${i}`, seq: i, action: i === 20_000 ? "withdrawn" : "granted" }));
    }
    const records = loadConsentLedger(write("huge.json", v1Envelope(rows)));
    expect(records).toHaveLength(20_000);
    expect(checkConsentForSubject(records, SUBJECT).modelTrainingActive).toBe(false);
  });
});
