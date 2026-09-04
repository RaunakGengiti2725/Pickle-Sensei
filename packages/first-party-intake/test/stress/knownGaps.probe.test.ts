import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONSENT_LEDGER_EXPORT_VERSION_V2,
  canonicalConsentRecordsJson,
  type ConsentRecord,
} from "@pickle/shared-types";
import { intakeClip, loadConsentLedger } from "../../src/index.js";
import { SeededRng } from "../../../../tools/stress/leakHarness.js";

/**
 * KNOWN GAP probes surfaced by the long-run-leak stress campaign. Each `it.fails`
 * documents behaviour the stress model considers BROKEN; when the gap is
 * fixed the probe starts passing, vitest reports it as a failure, and the
 * probe must be flipped to a plain `it(...)` (which then pins the fix).
 *
 * Gap: `intakeClip()` (and therefore the intake CLI) calls
 * `loadConsentLedger(path)` with no `ConsentLedgerVerifyOptions`, so the
 * v2 signature / replay-watermark verification that `loadConsentLedger`
 * implements is unreachable from the intake path. A v2 export whose
 * signature is forged is ACCEPTED by intake while the loader itself
 * rejects it when a signing key is supplied.
 */

const SEED = 0xf1a7_4a11;
const SIGNING_KEY = "SYNTHETIC-TEST-FIXTURE.signing-key";
const SUBJECT = "SYNTHETIC-TEST-FIXTURE.subject-0";

let dir: string;
let clip: string;
let ledger: string;
let meta: string;

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

function grantedRecords(): ConsentRecord[] {
  const base = 1_754_000_000_000;
  return (["video_analysis", "model_training"] as const).map((scope, index) => ({
    id: `SYNTHETIC-TEST-FIXTURE.record-${index}`,
    subjectPseudonym: SUBJECT,
    scope,
    action: "granted",
    consentVersion: `${scope.replace("_", "-")}-v1`,
    source: "privacy_center",
    device: null,
    captureMode: "all_captures",
    strokeIntent: null,
    recordedAtIso: new Date(base + index * 60_000).toISOString(),
    seq: index + 1,
  }));
}

/** v2 signed export whose signature is seeded garbage — every byte of the body is otherwise valid. */
function forgedV2Envelope(records: ConsentRecord[]): string {
  const rng = new SeededRng(SEED);
  return JSON.stringify({
    exportVersion: CONSENT_LEDGER_EXPORT_VERSION_V2,
    exportedAtIso: "2026-09-01T00:00:00.000Z",
    subjectPseudonym: SUBJECT,
    recordCount: records.length,
    maxSeq: records.at(-1)?.seq ?? null,
    recordsSha256: createHash("sha256").update(canonicalConsentRecordsJson(records)).digest("hex"),
    signature: { alg: "HMAC-SHA256", keyId: "synthetic", value: rng.hex(64) },
    records,
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "first-party-intake-gaps-"));
  clip = join(dir, "synthetic-good.mp4");
  ledger = join(dir, "forged-v2-ledger.json");
  meta = join(dir, "meta.json");
  makeClip(clip);
  writeFileSync(ledger, forgedV2Envelope(grantedRecords()));
  writeFileSync(
    meta,
    JSON.stringify({
      clipId: "SYNTHETIC-TEST-FIXTURE.clip-gap-01",
      athleteId: "SYNTHETIC-TEST-FIXTURE.athlete-01",
      athleteGroupId: "SYNTHETIC-TEST-FIXTURE.group-01",
      sessionId: "SYNTHETIC-TEST-FIXTURE.session-01",
      recordedAt: "2026-09-01T00:00:00.000Z",
      capture: {
        cameraView: "dominant_side",
        environment: "indoor",
        lighting: "daylight",
        deviceClass: "synthetic-lavfi-generator",
        handedness: "right",
        skillBand: "intermediate",
        ageBand: "adult_18_34",
        adaptivePlay: false,
        bystanderState: "none",
      },
    }),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("first-party-intake known gaps (seed 0xf1a74a11)", () => {
  it("precondition: loadConsentLedger itself refuses the forged v2 signature when a key is configured", () => {
    expect(() => loadConsentLedger(ledger, { signingKey: SIGNING_KEY })).toThrow(/signature/);
  });

  it.fails(
    "KNOWN GAP: intakeClip should refuse a v2 export whose signature does not verify (currently ACCEPTED — no signing key reaches loadConsentLedger)",
    () => {
      const record = intakeClip({
        clipPath: clip,
        consentLedgerPath: ledger,
        subjectPseudonym: SUBJECT,
        captureMetaPath: meta,
        operatorId: "SYNTHETIC-TEST-FIXTURE.operator-01",
      });
      expect(record.status).toBe("REJECTED");
    },
  );
});
