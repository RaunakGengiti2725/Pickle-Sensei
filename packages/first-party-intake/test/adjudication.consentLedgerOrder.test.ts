import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ConsentRecord } from "@pickle/shared-types";
import { checkConsentForSubject, loadConsentLedger } from "../src/index.js";

/**
 * SPO-02 consumer-side regression: a legacy bare-array ledger (no seq) must
 * fold by the instant each row denotes, and a row whose `seq` is not an
 * integer must be rejected at parse time instead of silently degrading to
 * timestamp ordering. ALL fixtures are SYNTHETIC (`SYNTHETIC-TEST-FIXTURE`).
 */

const SUBJECT = "SYNTHETIC-TEST-FIXTURE.legacy-subject";

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
    recordedAtIso: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

let dir: string;

function write(body: unknown): string {
  const path = join(dir, `ledger-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "consent-legacy-order-test-"));
});

describe("legacy bare-array consent ledgers fold by instant", () => {
  const grantVideo = row({
    id: "r1",
    scope: "video_analysis",
    consentVersion: "video-analysis-v1",
    recordedAtIso: "2026-01-01T09:00:00Z",
  });

  it("an offset-spelled grant that predates a UTC withdrawal does NOT authorize intake", () => {
    const ledger = [
      grantVideo,
      row({
        id: "r3",
        action: "withdrawn",
        captureMode: null,
        recordedAtIso: "2026-01-01T11:00:00Z",
      }),
      row({ id: "r2", recordedAtIso: "2026-01-01T12:00:00+02:00" }), // = 10:00Z, earlier
    ];
    const result = checkConsentForSubject(loadConsentLedger(write(ledger)), SUBJECT);
    expect(result.ok).toBe(false);
    expect(result.modelTrainingActive).toBe(false);
    expect(result.videoAnalysisActive).toBe(true);
  });

  it("a millisecond-precision withdrawal 1 ms after a second-precision grant wins", () => {
    const ledger = [
      grantVideo,
      row({ id: "r2", recordedAtIso: "2026-01-01T11:00:00Z" }),
      row({
        id: "r3",
        action: "withdrawn",
        captureMode: null,
        recordedAtIso: "2026-01-01T11:00:00.001Z",
      }),
    ];
    const result = checkConsentForSubject(loadConsentLedger(write(ledger)), SUBJECT);
    expect(result.ok).toBe(false);
    expect(result.modelTrainingActive).toBe(false);
  });

  it("rejects bare-array rows whose seq is not an integer", () => {
    for (const seq of ["7", 1.5, null, Number.NaN]) {
      const ledger = [grantVideo, { ...row({ id: "r2" }), seq }];
      expect(() => loadConsentLedger(write(ledger))).toThrow(/seq/);
    }
  });
});
