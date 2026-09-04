import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
 * SPO-01 regression: the consent gate on the OPERATOR path (intakeClip + the
 * CLI) must be able to require a signed export (contract v2) and a ledger
 * watermark. `loadConsentLedger` already implements both defences
 * (consentExport.redteam.test.ts); this file pins that they are reachable
 * from the documented intake procedure and that the CLI cannot silently
 * swallow the flags that switch them on.
 *
 * ALL fixtures are SYNTHETIC: ffmpeg lavfi testsrc2 clips generated in
 * tmpdir and consent rows whose pseudonyms are prefixed
 * `SYNTHETIC-TEST-FIXTURE`. Nothing here may ever be copied under datasets/.
 */

const SUBJECT = "SYNTHETIC-TEST-FIXTURE.spo01-subject";
const KEY = "SYNTHETIC-TEST-FIXTURE.spo01-signing-key";
const OPERATOR = "SYNTHETIC-TEST-FIXTURE.operator-spo01";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const require = createRequire(import.meta.url);

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
  return {
    ...base,
    exportVersion: CONSENT_LEDGER_EXPORT_VERSION_V2,
    signature: {
      alg: "HMAC-SHA256",
      keyId: "spo01-test-k1",
      value: createHmac("sha256", key)
        .update(canonicalConsentExportSigningPayload(header))
        .digest("hex"),
    },
    records,
  };
}

const CAPTURE_META = {
  clipId: "SYNTHETIC-TEST-FIXTURE.clip-spo01",
  athleteId: "SYNTHETIC-TEST-FIXTURE.athlete-spo01",
  athleteGroupId: "SYNTHETIC-TEST-FIXTURE.group-spo01",
  sessionId: "SYNTHETIC-TEST-FIXTURE.session-spo01",
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

function write(name: string, body: unknown): string {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

function baseInput(consentLedgerPath: string) {
  return {
    clipPath,
    consentLedgerPath,
    subjectPseudonym: SUBJECT,
    captureMetaPath: metaPath,
    operatorId: OPERATOR,
  };
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(
    process.execPath,
    [require.resolve("tsx/cli"), join(pkgRoot, "src/cli.ts"), ...args],
    { cwd: pkgRoot, encoding: "utf8" },
  );
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "first-party-intake-spo01-"));
  clipPath = join(dir, "synthetic-good.mp4");
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
    clipPath,
  ]);
  if (res.error) throw new Error(`ffmpeg unavailable: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`ffmpeg fixture failed: ${res.stderr.toString()}`);
  metaPath = write("capture-meta", CAPTURE_META);
});

describe("SPO-01: operator intake path can require a signed, fresh consent ledger", () => {
  const grantVideo = record({ scope: "video_analysis", consentVersion: "video-analysis-v1" });
  const grantTraining = record({ seq: 2 });
  const withdrawal = record({ action: "withdrawn", seq: 3 });
  const full = [grantVideo, grantTraining, withdrawal];
  // Attacker forgery: withdrawal dropped, v1 integrity fields recomputed.
  const forged = () => v1Envelope([grantVideo, grantTraining]);
  // Genuine, correctly signed, but taken before the withdrawal was recorded.
  const stale = () => v2Envelope([grantVideo, grantTraining]);

  it("control: loadConsentLedger refuses the forged v1 export when a key is configured", () => {
    expect(() => loadConsentLedger(write("control-forged", forged()), { signingKey: KEY })).toThrow(
      /signature downgrade/,
    );
    expect(loadConsentLedger(write("control-forged-unkeyed", forged()))).toHaveLength(2);
  });

  it("intakeClip with consentSigningKey REJECTS the stripped-withdrawal v1 export and never leaks the key", () => {
    const rejected = intakeClip({
      ...baseInput(write("intake-forged", forged())),
      consentSigningKey: KEY,
    });
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.manifestDraft).toBeNull();
    expect(rejected.consent.ok).toBe(false);
    expect(rejected.reasons.join("\n")).toMatch(/signature downgrade/);
    expect(rejected.consentLedger.signatureVerified).toBe(false);
    expect(JSON.stringify(rejected)).not.toContain(KEY);

    // The genuine signed export that still carries the withdrawal is rejected
    // for the right reason: the consent fold, not the signature.
    const current = intakeClip({
      ...baseInput(write("intake-current", v2Envelope(full))),
      consentSigningKey: KEY,
    });
    expect(current.status).toBe("REJECTED");
    expect(current.reasons.join("\n")).toMatch(/model_training consent is not active/);
    expect(current.reasons.join("\n")).not.toMatch(/signature/);
    expect(current.consentLedger).toEqual({ signatureVerified: true, maxSeq: 3, watermark: null });

    // A signed export whose subject is fully consented is ACCEPTED, and the
    // record states that the signature was actually verified.
    const accepted = intakeClip({
      ...baseInput(write("intake-signed-ok", stale())),
      consentSigningKey: KEY,
    });
    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.consentLedger).toEqual({ signatureVerified: true, maxSeq: 2, watermark: null });
    expect(accepted.manifestDraft?.consentReference.exportSignatureVerified).toBe(true);
    expect(accepted.manifestDraft?.consentReference.ledgerMaxSeq).toBe(2);
    expect(JSON.stringify(accepted)).not.toContain(KEY);

    // A signing key alone (bare array export) is a downgrade too.
    const bare = intakeClip({
      ...baseInput(write("intake-bare", full)),
      consentSigningKey: KEY,
    });
    expect(bare.status).toBe("REJECTED");
    expect(bare.reasons.join("\n")).toMatch(/signing key/);
  });

  it("intakeClip with consentMinMaxSeq REJECTS a validly signed export that predates the withdrawal", () => {
    const stalePath = write("intake-stale", stale());
    const replayed = intakeClip({
      ...baseInput(stalePath),
      consentSigningKey: KEY,
      consentMinMaxSeq: 3,
    });
    expect(replayed.status).toBe("REJECTED");
    expect(replayed.manifestDraft).toBeNull();
    expect(replayed.reasons.join("\n")).toMatch(/stale export replay/);
    expect(replayed.consentLedger.watermark).toBe(3);

    // Same export, watermark it satisfies: accepted, and the record reports
    // the export's own maxSeq so the operator can advance the watermark.
    const fresh = intakeClip({
      ...baseInput(stalePath),
      consentSigningKey: KEY,
      consentMinMaxSeq: 2,
    });
    expect(fresh.status).toBe("ACCEPTED");
    expect(fresh.consentLedger).toEqual({ signatureVerified: true, maxSeq: 2, watermark: 2 });

    // A watermark that cannot be compared must not silently disable the
    // check (NaN < n is false): it is an invocation error, not a pass.
    expect(() =>
      intakeClip({ ...baseInput(stalePath), consentSigningKey: KEY, consentMinMaxSeq: Number.NaN }),
    ).toThrow(/consentMinMaxSeq/);
    expect(() =>
      intakeClip({ ...baseInput(stalePath), consentSigningKey: KEY, consentMinMaxSeq: -1 }),
    ).toThrow(/consentMinMaxSeq/);
    expect(() => intakeClip({ ...baseInput(stalePath), consentSigningKey: "" })).toThrow(
      /consentSigningKey/,
    );
  });

  it("CLI forwards --signing-key / --min-max-seq and exits 2 with usage on unknown flags", () => {
    const forgedPath = write("cli-forged", forged());
    const stalePath = write("cli-stale", stale());
    const common = [
      "--clip",
      clipPath,
      "--consent-ledger",
      forgedPath,
      "--subject",
      SUBJECT,
      "--capture-meta",
      metaPath,
      "--operator",
      OPERATOR,
    ];

    // Unkeyed host: the forgery is ACCEPTED (documented v1 limitation).
    const unkeyed = runCli(common);
    expect(unkeyed.status).toBe(0);
    expect(unkeyed.stderr).toContain("intake status: ACCEPTED");

    // Keyed host: the same file is REJECTED (exit 1) with the reason on stderr.
    const outPath = join(dir, "cli-forged-record.json");
    const keyed = runCli([...common, "--signing-key", KEY, "--out", outPath]);
    expect(keyed.status).toBe(1);
    expect(keyed.stderr).toContain("intake status: REJECTED");
    expect(keyed.stderr).toMatch(/signature downgrade/);
    expect(keyed.stdout).not.toContain(KEY);
    const written = JSON.parse(readFileSync(outPath, "utf8")) as { status: string };
    expect(written.status).toBe("REJECTED");

    // Watermark: a genuine but stale export is REJECTED (exit 1).
    const staleArgs = common.map((a) => (a === forgedPath ? stalePath : a));
    const replayed = runCli([...staleArgs, "--signing-key", KEY, "--min-max-seq", "3"]);
    expect(replayed.status).toBe(1);
    expect(replayed.stderr).toMatch(/stale export replay/);
    const fresh = runCli([...staleArgs, "--signing-key", KEY, "--min-max-seq", "2"]);
    expect(fresh.status).toBe(0);
    expect(fresh.stderr).toContain("intake status: ACCEPTED");

    // Unknown flags are never swallowed: exit 2 + usage on stderr, no record.
    const typo = runCli([...common, "--signing-kye", KEY]);
    expect(typo.status).toBe(2);
    expect(typo.stderr).toMatch(/unknown flag --signing-kye/);
    expect(typo.stderr).toMatch(/^usage: intake/m);
    expect(typo.stdout).toBe("");

    // A non-integer watermark is an invocation error, not a disabled check.
    const badSeq = runCli([...staleArgs, "--signing-key", KEY, "--min-max-seq", "three"]);
    expect(badSeq.status).toBe(2);
    expect(badSeq.stderr).toMatch(/--min-max-seq/);
    expect(badSeq.stderr).toMatch(/^usage: intake/m);

    // A flag whose value was forgotten must not swallow the next flag as its value.
    const swallowed = runCli([...common, "--signing-key", "--min-max-seq", "2"]);
    expect(swallowed.status).toBe(2);
    expect(swallowed.stderr).toMatch(/--signing-key requires a value/);

    // The key can be read from a file (trailing newline tolerated) so it never
    // has to appear in argv; the file path is the documented operator form.
    const keyFile = join(dir, "signing-key.txt");
    writeFileSync(keyFile, `${KEY}\n`);
    const fromFile = runCli([...common, "--signing-key-file", keyFile]);
    expect(fromFile.status).toBe(1);
    expect(fromFile.stderr).toMatch(/signature downgrade/);
    const both = runCli([...common, "--signing-key", KEY, "--signing-key-file", keyFile]);
    expect(both.status).toBe(2);
    expect(both.stderr).toMatch(/mutually exclusive/);

    // --help (referenced by FIRST_PARTY_CAPTURE_PROTOCOL.md) prints usage on stdout, exit 0.
    const help = runCli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^usage: intake/);
    expect(help.stdout).toContain("--signing-key-file");
    expect(help.stdout).toContain("--min-max-seq");
  });
});
