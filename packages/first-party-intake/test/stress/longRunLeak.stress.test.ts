import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONSENT_ACTIONS,
  CONSENT_LEDGER_EXPORT_VERSION,
  CONSENT_LEDGER_EXPORT_VERSION_V2,
  CONSENT_SCOPES,
  CONSENT_SOURCES,
  canonicalConsentExportSigningPayload,
  canonicalConsentRecordsJson,
  type ConsentRecord,
  type ConsentScope,
} from "@pickle/shared-types";
import {
  AGE_BANDS,
  BYSTANDER_STATES,
  CAMERA_VIEWS,
  ENVIRONMENTS,
  HANDEDNESS,
  LIGHTING,
  SKILL_BANDS,
  checkConsentForSubject,
  intakeClip,
  loadCaptureMeta,
  loadConsentLedger,
  type IntakeStatus,
} from "../../src/index.js";
import {
  SeededRng,
  type IterationOutcome,
  digestOf,
  nonFinitePaths,
  nondeterministicSeeds,
  runLeakCampaign,
  stressIterations,
  summarizeReport,
  writeReportIfRequested,
} from "../../../../tools/stress/leakHarness.js";

/**
 * LONG-RUN LEAK lens for @pickle/first-party-intake. ALL fixtures are
 * SYNTHETIC (ffmpeg lavfi test patterns, `SYNTHETIC-TEST-FIXTURE` pseudonyms)
 * and live in tmpdir only. Every iteration writes a seeded consent ledger
 * (bare array, v1 envelope, signed v2 envelope, or a tampered variant) plus a
 * seeded capture-metadata file, then checks the loaders/consent fold against
 * an independent reference model. Every FFMPEG_EVERY-th iteration also runs
 * the full `intakeClip` (ffprobe/ffmpeg subprocesses) so stale child-process
 * handles would show up in the resource snapshots. STRESS_ITER=500 for the
 * full campaign. `intakeClip` is synchronous with no cancellation surface, so
 * cancellation is not applicable here.
 */

const ITER = stressIterations(60);
const FFMPEG_EVERY = ITER >= 200 ? 5 : 10;
const BASE_SEED = 0xf1a7_0001;
const SIGNING_KEY = "SYNTHETIC-TEST-FIXTURE.signing-key";

let dir: string;
let goodClip: string;
let shortClip: string;
let lowResClip: string;

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

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "first-party-intake-stress-"));
  goodClip = join(dir, "synthetic-good.mp4");
  shortClip = join(dir, "synthetic-short.mp4");
  lowResClip = join(dir, "synthetic-lowres.mp4");
  makeClip(goodClip, "1280x720", 30, 3);
  makeClip(shortClip, "1280x720", 30, 1.5);
  makeClip(lowResClip, "320x240", 30, 3);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

type LedgerShape = "bare" | "v1" | "v2" | "v1-bad-count" | "v1-bad-digest" | "v2-bad-signature";
const LEDGER_SHAPES: readonly LedgerShape[] = [
  "bare",
  "v1",
  "v2",
  "v1-bad-count",
  "v1-bad-digest",
  "v2-bad-signature",
];

function subjectName(i: number): string {
  return `SYNTHETIC-TEST-FIXTURE.subject-${i}`;
}

function seededRecords(rng: SeededRng, subjects: number, singleSubject: boolean): ConsentRecord[] {
  const records: ConsentRecord[] = [];
  let ms = 1_754_000_000_000 + rng.int(0, 1_000_000);
  const count = rng.int(1, 14);
  for (let i = 0; i < count; i += 1) {
    ms += rng.int(1000, 3_600_000);
    const scope = rng.pick(CONSENT_SCOPES);
    const action = rng.chance(0.7) ? "granted" : rng.pick(CONSENT_ACTIONS);
    records.push({
      id: `SYNTHETIC-TEST-FIXTURE.record-${i}`,
      subjectPseudonym: subjectName(singleSubject ? 0 : rng.int(0, subjects - 1)),
      scope,
      action,
      consentVersion: `${scope.replace("_", "-")}-v${rng.int(1, 2)}`,
      source: rng.pick(CONSENT_SOURCES),
      device: rng.chance(0.5) ? null : "synthetic-device",
      captureMode: action === "granted" ? "all_captures" : null,
      strokeIntent: null,
      recordedAtIso: new Date(ms).toISOString(),
      seq: i + 1,
    });
  }
  return records;
}

/** Independent fold: last record per scope wins, ordered by seq. */
function referenceActive(
  records: readonly ConsentRecord[],
  subject: string,
  scope: ConsentScope,
): boolean {
  const own = records
    .filter((r) => r.subjectPseudonym === subject && r.scope === scope)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return own.at(-1)?.action === "granted";
}

function writeLedger(
  path: string,
  records: ConsentRecord[],
  shape: LedgerShape,
  rng: SeededRng,
): void {
  if (shape === "bare") {
    writeFileSync(path, JSON.stringify(records));
    return;
  }
  const recordsSha256 = createHash("sha256")
    .update(canonicalConsentRecordsJson(records))
    .digest("hex");
  const header = {
    exportVersion: shape.startsWith("v2")
      ? CONSENT_LEDGER_EXPORT_VERSION_V2
      : CONSENT_LEDGER_EXPORT_VERSION,
    exportedAtIso: "2026-09-01T00:00:00.000Z",
    subjectPseudonym: subjectName(0),
    recordCount: shape === "v1-bad-count" ? records.length + rng.int(1, 3) : records.length,
    maxSeq: records.at(-1)?.seq ?? null,
    recordsSha256: shape === "v1-bad-digest" ? rng.hex(64) : recordsSha256,
  };
  const signature = createHmac("sha256", SIGNING_KEY)
    .update(canonicalConsentExportSigningPayload(header))
    .digest("hex");
  const envelope = shape.startsWith("v2")
    ? {
        ...header,
        signature: {
          alg: "HMAC-SHA256",
          keyId: "synthetic",
          value: shape === "v2-bad-signature" ? rng.hex(64) : signature,
        },
        records,
      }
    : { ...header, records };
  writeFileSync(path, JSON.stringify(envelope));
}

interface MetaCase {
  meta: Record<string, unknown>;
  valid: boolean;
  label: string;
}

function seededMeta(rng: SeededRng, seed: number): MetaCase {
  const meta: Record<string, unknown> = {
    clipId: `SYNTHETIC-TEST-FIXTURE.clip-${seed.toString(16)}`,
    athleteId: "SYNTHETIC-TEST-FIXTURE.athlete-01",
    athleteGroupId: "SYNTHETIC-TEST-FIXTURE.group-01",
    sessionId: `SYNTHETIC-TEST-FIXTURE.session-${rng.int(0, 99)}`,
    recordedAt: new Date(1_755_000_000_000 + rng.int(0, 1_000_000_000)).toISOString(),
    capture: {
      cameraView: rng.pick(CAMERA_VIEWS),
      environment: rng.pick(ENVIRONMENTS),
      lighting: rng.pick(LIGHTING),
      deviceClass: "synthetic-lavfi-generator",
      handedness: rng.pick(HANDEDNESS),
      skillBand: rng.pick(SKILL_BANDS),
      ageBand: rng.pick(AGE_BANDS),
      adaptivePlay: rng.chance(0.5),
      bystanderState: rng.pick(BYSTANDER_STATES),
    },
  };
  if (rng.chance(0.75)) return { meta, valid: true, label: "meta-valid" };
  const capture = meta.capture as Record<string, unknown>;
  const breakage = rng.int(0, 5);
  switch (breakage) {
    case 0:
      meta.clipId = "short";
      break;
    case 1:
      meta.recordedAt = "yesterday";
      break;
    case 2:
      capture.cameraView = "selfie";
      break;
    case 3:
      capture.adaptivePlay = "no";
      break;
    case 4:
      capture.deviceClass = "";
      break;
    default:
      delete meta.capture;
  }
  return { meta, valid: false, label: `meta-broken-${breakage}` };
}

function intakeIteration(seed: number, iteration: number): IterationOutcome {
  const rng = new SeededRng(seed);
  const problems: string[] = [];
  const tag = seed.toString(16);
  const ledgerPath = join(dir, `ledger-${tag}.json`);
  const metaPath = join(dir, `meta-${tag}.json`);
  const shape = rng.pick(LEDGER_SHAPES);
  const records = seededRecords(rng, 3, shape !== "bare");
  writeLedger(ledgerPath, records, shape, rng);
  const subject = rng.chance(0.85) ? subjectName(rng.int(0, 2)) : subjectName(99);
  const expectVideo = referenceActive(records, subject, "video_analysis");
  const expectTraining = referenceActive(records, subject, "model_training");
  const subjectCount = records.filter((r) => r.subjectPseudonym === subject).length;
  const expectOk = subjectCount > 0 && expectVideo && expectTraining;
  const tampered =
    shape.endsWith("-count") || shape.endsWith("-digest") || shape.endsWith("-signature");

  let consentOutcome: string;
  const verifyOptions = shape.startsWith("v2") ? { signingKey: SIGNING_KEY } : undefined;
  try {
    const ledger = loadConsentLedger(ledgerPath, verifyOptions);
    if (tampered) problems.push(`${shape}: tampered ledger loaded`);
    if (ledger.length !== records.length) problems.push("ledger length");
    const check = checkConsentForSubject(ledger, subject);
    if (check.ok !== expectOk) problems.push(`consent ok=${check.ok}, model ${expectOk}`);
    if (check.videoAnalysisActive !== expectVideo) problems.push("videoAnalysisActive");
    if (check.modelTrainingActive !== expectTraining) problems.push("modelTrainingActive");
    if (check.subjectRecordCount !== subjectCount) problems.push("subjectRecordCount");
    if (check.ok && check.modelTrainingConsentVersion === null) problems.push("ok without version");
    if (!check.ok && check.errors.length === 0) problems.push("rejected without reasons");
    consentOutcome = check.ok ? "consent-ok" : "consent-refused";
    if (shape === "v2") {
      // A signed export must be refused when a signing key is configured and
      // the file is unsigned (downgrade), and when the watermark moved on.
      try {
        loadConsentLedger(ledgerPath, { signingKey: SIGNING_KEY, minMaxSeq: records.length + 1 });
        problems.push("stale export replay accepted");
      } catch (error) {
        if (!/stale export replay/.test(String(error))) problems.push(`replay: ${String(error)}`);
      }
    }
    if (shape === "v1" || shape === "bare") {
      try {
        loadConsentLedger(ledgerPath, { signingKey: SIGNING_KEY });
        problems.push("unsigned ledger accepted with signing key configured");
      } catch (error) {
        if (!/signing key|signed export/.test(String(error)))
          problems.push(`downgrade: ${String(error)}`);
      }
    }
  } catch (error) {
    if (!tampered) problems.push(`${shape}: valid ledger refused: ${String(error)}`);
    else if (!/integrity verification/.test(String(error)))
      problems.push(`tampered: ${String(error)}`);
    consentOutcome = "ledger-refused";
  }

  const metaCase = seededMeta(rng, seed);
  writeFileSync(metaPath, JSON.stringify(metaCase.meta));
  let metaLoaded = false;
  try {
    const meta = loadCaptureMeta(metaPath);
    metaLoaded = true;
    if (!metaCase.valid) problems.push(`${metaCase.label} accepted`);
    if (digestOf(meta) !== digestOf(metaCase.meta)) problems.push("meta not preserved");
  } catch (error) {
    if (metaCase.valid) problems.push(`valid meta refused: ${String(error)}`);
    else if (!/is invalid/.test(String(error))) problems.push(`meta error: ${String(error)}`);
  }

  let intakeStatus: IntakeStatus | "skipped" | "threw" = "skipped";
  let record: unknown = null;
  if (iteration >= 0 && iteration % FFMPEG_EVERY === 0 && !tampered && metaLoaded) {
    const clip = rng.pick([goodClip, goodClip, shortClip, lowResClip]);
    const expected: IntakeStatus = !expectOk
      ? "REJECTED"
      : clip === lowResClip
        ? "REJECTED"
        : clip === shortClip
          ? "ACCEPTED_DEGRADED"
          : "ACCEPTED";
    try {
      const result = intakeClip({
        clipPath: clip,
        consentLedgerPath: ledgerPath,
        subjectPseudonym: subject,
        captureMetaPath: metaPath,
        operatorId: "SYNTHETIC-TEST-FIXTURE.operator-01",
      });
      intakeStatus = result.status;
      if (result.status !== expected) {
        problems.push(
          `intake ${result.status}, expected ${expected}: ${result.reasons.join(" | ")}`,
        );
      }
      if ((result.manifestDraft === null) !== (result.status === "REJECTED")) {
        problems.push("manifestDraft presence disagrees with status");
      }
      if (result.status === "REJECTED" && result.reasons.length === 0)
        problems.push("REJECTED without reasons");
      if (result.manifestDraft !== null) {
        const draft = result.manifestDraft;
        if (!/^[a-f0-9]{64}$/.test(draft.rawAsset.sha256)) problems.push("rawAsset sha256");
        if (draft.rawAsset.widthPx !== 1280 || draft.rawAsset.heightPx !== 720)
          problems.push("dimensions");
        if (draft.rawAsset.frameCount === null || draft.rawAsset.frameCount <= 0)
          problems.push("frameCount");
        if (draft.consentReference.modelTrainingConsentVersion === null)
          problems.push("draft without version");
        if (draft.clipId !== metaCase.meta.clipId) problems.push("draft clipId");
      }
      problems.push(...nonFinitePaths(result, "intake"));
      const { intakeAtIso: _wallClock, ...stable } = result;
      record = stable;
    } catch (error) {
      intakeStatus = "threw";
      problems.push(`intakeClip threw: ${String(error)}`);
    }
  }

  if (problems.length > 0) throw new Error(problems.join("; "));
  return {
    outcome: `${shape}/${consentOutcome}/${metaCase.valid ? "meta-ok" : "meta-refused"}/${intakeStatus}`,
    digest: digestOf({ shape, subject, expectOk, meta: metaCase.meta, record }),
    retainables: [records, metaCase.meta],
    detail: { shape, subject, records: records.length, intakeStatus },
  };
}

describe(
  "first-party-intake long-run leak (seeded, one process)",
  { timeout: 30_000 + ITER * 400 },
  () => {
    it(`loads ${ITER} seeded ledgers/metadata (full intake every ${FFMPEG_EVERY}th) without retaining any`, async () => {
      const report = await runLeakCampaign({
        name: "first-party-intake.lifecycle",
        baseSeed: BASE_SEED,
        iterations: ITER,
        run: intakeIteration,
      });
      const path = writeReportIfRequested(report);
      console.log(summarizeReport(report), path ?? "");

      expect(report.gcForced).toBe(true);
      expect(report.iterations).toBe(ITER);
      expect(report.failures).toEqual([]);
      expect(report.retained.maxAtAnyCheckpoint).toBe(0);
      // Subprocesses are spawned synchronously; none may outlive its iteration.
      expect(report.handles.grown).toEqual({});
      expect(report.handles.final.activeResources["ChildProcess"] ?? 0).toBe(0);
      const intakes = report.rows.filter((r) => !r.outcome.endsWith("/skipped")).length;
      console.log(`[first-party-intake.lifecycle] full intakeClip runs=${intakes}`);
      expect(intakes).toBeGreaterThan(0);
      if (ITER >= 200) {
        expect(report.heap.monotoneIncreasing && report.heap.slopePctPer100 > 5).toBe(false);
      }
    });

    it("same seed → identical consent/metadata verdicts", () => {
      const seeds = Array.from({ length: Math.min(ITER, 25) }, (_, i) => BASE_SEED + i);
      expect(nondeterministicSeeds(seeds, (seed) => intakeIteration(seed, -1))).toEqual([]);
    });
  },
);
