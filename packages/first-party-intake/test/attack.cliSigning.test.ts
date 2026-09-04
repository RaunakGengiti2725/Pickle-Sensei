import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { loadConsentLedger } from "../src/index.js";

/**
 * Adversarial pass (shared-packages-ops #2, pass 3): run the REAL intake CLI
 * (src/cli.ts via tsx) against consent-export envelopes and record exit
 * codes. The question under attack: when the intake host is *supposed* to
 * require a signed (v2) export, can the CLI be made to enforce that?
 *
 * VERIFIED by this file: the CLI has no flag, env var, or config path that
 * reaches `loadConsentLedger(path, { signingKey })`; `intakeClip()` calls it
 * with no options. Unknown flags are silently swallowed by `parseArgs`.
 *
 * ALL fixtures are SYNTHETIC (ffmpeg lavfi testsrc2; pseudonyms prefixed
 * `SYNTHETIC-TEST-FIXTURE`). Nothing here is corpus data.
 */

const SUBJECT = "SYNTHETIC-TEST-FIXTURE.cli-subject";
const KEY = "SYNTHETIC-TEST-FIXTURE.signing-key-never-a-real-secret";
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG_ROOT, "src", "cli.ts");
const TSX = join(PKG_ROOT, "node_modules", ".bin", "tsx");

let dir: string;
let clip: string;
let metaPath: string;

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

const GRANTS: ConsentRecord[] = [
  record({
    id: "SYNTHETIC-TEST-FIXTURE.r1",
    scope: "video_analysis",
    consentVersion: "video-analysis-v1",
    seq: 1,
  }),
  record({ id: "SYNTHETIC-TEST-FIXTURE.r2", scope: "model_training", seq: 2 }),
];
const WITHDRAWAL: ConsentRecord = record({
  id: "SYNTHETIC-TEST-FIXTURE.r3",
  scope: "model_training",
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
  return {
    ...base,
    ...header,
    signature: {
      alg: "hmac-sha256",
      keyId: "synthetic-k1",
      value: createHmac("sha256", key)
        .update(canonicalConsentExportSigningPayload(header))
        .digest("hex"),
    },
  };
}

function writeJson(name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
  argv: string[];
}

function runCli(extraArgs: string[], ledgerPath: string, env: NodeJS.ProcessEnv = {}): CliRun {
  const argv = [
    CLI,
    "--clip",
    clip,
    "--consent-ledger",
    ledgerPath,
    "--subject",
    SUBJECT,
    "--capture-meta",
    metaPath,
    "--operator",
    "SYNTHETIC-TEST-FIXTURE.operator",
    ...extraArgs,
  ];
  const res = spawnSync(TSX, argv, {
    cwd: PKG_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, argv };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "first-party-intake-attack-"));
  clip = join(dir, "synthetic.mp4");
  const ff = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=30",
    "-t",
    "2",
    "-pix_fmt",
    "yuv420p",
    "-y",
    clip,
  ]);
  if (ff.error) throw new Error(`ffmpeg unavailable: ${ff.error.message}`);
  if (ff.status !== 0) throw new Error(`ffmpeg fixture failed: ${ff.stderr.toString()}`);
  metaPath = writeJson("capture-meta.json", {
    clipId: "SYNTHETIC-TEST-FIXTURE.clip-attack",
    athleteId: "SYNTHETIC-TEST-FIXTURE.athlete",
    athleteGroupId: "SYNTHETIC-TEST-FIXTURE.group",
    sessionId: "SYNTHETIC-TEST-FIXTURE.session",
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

describe("attack: intake CLI cannot require a signed (v2) consent export", () => {
  it("VERIFIED: cli.ts exposes only clip/consent-ledger/subject/capture-meta/operator/out — no signing flag", () => {
    const source = readFileSync(CLI, "utf8");
    const intakeSource = readFileSync(join(PKG_ROOT, "src", "intake.ts"), "utf8");
    for (const name of ["signing", "require-v2", "signature", "SIGNING", "process.env"]) {
      expect(source.includes(name), `cli.ts must not mention ${name} (it does not today)`).toBe(
        false,
      );
      expect(intakeSource.includes(name), `intake.ts must not mention ${name}`).toBe(false);
    }
    expect(intakeSource).toMatch(/loadConsentLedger\(input\.consentLedgerPath\)/);
  });

  it("FINDING: unsigned v1 envelope is ACCEPTED (exit 0) — there is no way to demand v2 from the CLI", () => {
    const ledger = writeJson("ledger-v1.json", v1Envelope(GRANTS));
    const run = runCli([], ledger);
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout) as { status: string };
    expect(out.status).toBe("ACCEPTED");
  });

  it("FINDING: `--signing-key <k>` and `--require-v2 true` are silently swallowed by parseArgs and change nothing (still exit 0)", () => {
    const ledger = writeJson("ledger-v1b.json", v1Envelope(GRANTS));
    for (const flags of [
      ["--signing-key", KEY],
      ["--require-v2", "true"],
      ["--require-signature", "1"],
    ]) {
      const run = runCli(flags, ledger);
      expect(run.status, `flags=${flags.join(" ")} stderr=${run.stderr}`).toBe(0);
      expect(run.stderr).not.toMatch(/usage:/);
      expect(run.stderr).not.toMatch(/sign/i);
    }
  });

  it("FINDING: CONSENT_EXPORT_SIGNING_KEY / PICKLE_CONSENT_SIGNING_KEY env vars are ignored (exit 0 on unsigned v1)", () => {
    const ledger = writeJson("ledger-v1c.json", v1Envelope(GRANTS));
    const run = runCli([], ledger, {
      CONSENT_EXPORT_SIGNING_KEY: KEY,
      PICKLE_CONSENT_SIGNING_KEY: KEY,
      CONSENT_LEDGER_SIGNING_KEY: KEY,
    });
    expect(run.status).toBe(0);
  });

  it("FINDING: withdrawal stripped from a v1 export + recomputed hash → CLI ACCEPTS a subject who withdrew model_training (exit 0)", () => {
    // Honest export includes the withdrawal → REJECTED (exit 1).
    const honest = writeJson("ledger-honest.json", v1Envelope([...GRANTS, WITHDRAWAL]));
    const honestRun = runCli([], honest);
    expect(honestRun.status).toBe(1);
    expect(honestRun.stderr).toMatch(/model_training consent is not active/);

    // Attacker drops the withdrawal and recomputes recordCount/maxSeq/sha.
    // v1 is corruption-evident only — this verifies and the CLI accepts.
    const forged = writeJson("ledger-forged.json", v1Envelope(GRANTS));
    const forgedRun = runCli([], forged);
    expect(forgedRun.status).toBe(0);
    expect((JSON.parse(forgedRun.stdout) as { status: string }).status).toBe("ACCEPTED");
  });

  it("HELD: the library CAN refuse the same forged v1 export when a signing key is passed — the gap is CLI wiring, not the verifier", () => {
    const forged = join(dir, "ledger-forged.json");
    expect(() => loadConsentLedger(forged, { signingKey: KEY })).toThrow(
      /refusing signature downgrade/,
    );
    expect(() => loadConsentLedger(forged, { minMaxSeq: 3 })).toThrow(/stale export replay/);
  });

  it("HELD: a v2 envelope with a valid signature is accepted by the CLI (exit 0) and, with a wrong key, rejected by the library", () => {
    const v2 = writeJson("ledger-v2.json", v2Envelope(GRANTS));
    expect(runCli([], v2).status).toBe(0);
    expect(() => loadConsentLedger(v2, { signingKey: KEY })).not.toThrow();
    expect(() => loadConsentLedger(v2, { signingKey: `${KEY}-wrong` })).toThrow(
      /signature does not verify/,
    );
  });

  it("FINDING: a v2 envelope whose signature has been zeroed still passes the CLI (exit 0) — signature is never checked without a key", () => {
    const tampered = v2Envelope(GRANTS) as { signature: { value: string } };
    tampered.signature.value = "0".repeat(64);
    const path = writeJson("ledger-v2-badsig.json", tampered);
    expect(runCli([], path).status).toBe(0);
    expect(() => loadConsentLedger(path)).not.toThrow();
    expect(() => loadConsentLedger(path, { signingKey: KEY })).toThrow(/signature does not verify/);
  });
});

describe("attack: CLI argument parsing edges", () => {
  it("HELD: missing required flag → usage + exit 2; odd argv → exit 2", () => {
    const res = spawnSync(TSX, [CLI, "--clip", clip], { cwd: PKG_ROOT, encoding: "utf8" });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/usage:/);
    const odd = spawnSync(TSX, [CLI, "--clip"], { cwd: PKG_ROOT, encoding: "utf8" });
    expect(odd.status).toBe(2);
  });

  it("HELD: malformed ledger JSON / bare array with a bad row → exit 2, not 0", () => {
    const badJson = join(dir, "bad.json");
    writeFileSync(badJson, "{ not json");
    expect(runCli([], badJson).status).toBe(2);
    const badRow = writeJson("bad-row.json", [{ id: "x" }]);
    expect(runCli([], badRow).status).toBe(2);
  });

  it("HELD: v1 envelope with recordCount off by one, or reordered seq, or foreign subject → exit 2", () => {
    const off = v1Envelope(GRANTS);
    off.recordCount = 3;
    expect(runCli([], writeJson("off.json", off)).status).toBe(2);
    const reordered = v1Envelope([GRANTS[1]!, GRANTS[0]!]);
    expect(runCli([], writeJson("reordered.json", reordered)).status).toBe(2);
    const foreign = v1Envelope(GRANTS);
    foreign.subjectPseudonym = "SYNTHETIC-TEST-FIXTURE.someone-else";
    expect(runCli([], writeJson("foreign.json", foreign)).status).toBe(2);
  });

  it("HELD: a subject with unicode look-alike pseudonym (Cyrillic 'с') is NOT the consented subject → exit 1", () => {
    const ledger = writeJson("ledger-uni.json", v1Envelope(GRANTS));
    const lookalike = SUBJECT.replace("cli-subject", "\u0441li-subject");
    expect(lookalike).not.toBe(SUBJECT);
    const argv = [
      CLI,
      "--clip",
      clip,
      "--consent-ledger",
      ledger,
      "--subject",
      lookalike,
      "--capture-meta",
      metaPath,
      "--operator",
      "op",
    ];
    const res = spawnSync(TSX, argv, { cwd: PKG_ROOT, encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/NOT consented by default/);
  });

  it("FINDING (P3): a repeated flag silently takes the LAST value (`--subject A --subject B` → B)", () => {
    const ledger = writeJson("ledger-dup.json", v1Envelope(GRANTS));
    const run = runCli(["--subject", "SYNTHETIC-TEST-FIXTURE.nobody"], ledger);
    // Our base argv already carries --subject SUBJECT; the trailing override wins.
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/nobody/);
  });

  it("HELD: --out to an unwritable path → exit 2 (permission denial surfaces, record not silently lost)", () => {
    const ledger = writeJson("ledger-out.json", v1Envelope(GRANTS));
    const run = runCli(["--out", "/proc/definitely-not-writable/record.json"], ledger);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/intake failed/);
  });
});
