import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConsentRecord } from "@pickle/shared-types";
import { intakeClip } from "../src/index.js";
import type { IntakeRecord } from "../src/intake.js";
import {
  CORPUS_CASES,
  generateCorpus,
  hasFfmpeg,
  type GeneratedCase,
} from "../../capture-envelope/test/xcMatrixMedia2/corpus.js";

/**
 * xc-matrix-media-2 — first-party intake under adversarial media.
 *
 * ALL fixtures are SYNTHETIC (ffmpeg lavfi + byte surgery, generated at test
 * time in tmpdir). Consent rows use `SYNTHETIC-TEST-FIXTURE` pseudonyms.
 * Nothing here touches datasets/.
 *
 * The corpus is fed through `intakeClip` and every case must resolve to a
 * typed IntakeRecord — never a thrown exception. Rows are written to
 * `artifacts/xc-matrix-media-2/<run>/intake-matrix.json`.
 *
 * KNOWN FINDINGS pinned below (documented, not silently accepted):
 *  - extreme aspect ratios (short side rounds to 0 sample px) OOM-abort the
 *    process inside `extractSampledGrayFrames` — `intakeClip`'s try/catch
 *    cannot observe it, so it is exercised in a child process here.
 *  - a faststart mp4 whose mdat is cut in half still yields status ACCEPTED
 *    with the moov-declared duration (3.0 s) and packet count in the
 *    manifest draft, even though only ~half the frames are decodable.
 */

const SYNTH_SUBJECT = "SYNTHETIC-TEST-FIXTURE.xc-media2-subject";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir =
  process.env["XC_MEDIA2_OUT"] ?? join(repoRoot, "artifacts", "xc-matrix-media-2", runStamp);

const LEDGER: ConsentRecord[] = [
  {
    id: "SYNTHETIC-TEST-FIXTURE.xc1",
    subjectPseudonym: SYNTH_SUBJECT,
    scope: "video_analysis",
    action: "granted",
    consentVersion: "video-analysis-v1",
    source: "privacy_center",
    device: null,
    captureMode: "all_captures",
    strokeIntent: null,
    recordedAtIso: "2026-08-01T00:00:00.000Z",
  },
  {
    id: "SYNTHETIC-TEST-FIXTURE.xc2",
    subjectPseudonym: SYNTH_SUBJECT,
    scope: "model_training",
    action: "granted",
    consentVersion: "model-training-v1",
    source: "privacy_center",
    device: null,
    captureMode: "all_captures",
    strokeIntent: null,
    recordedAtIso: "2026-08-01T00:01:00.000Z",
  },
];

const CAPTURE_META = {
  clipId: "SYNTHETIC-TEST-FIXTURE.xc-media2-clip",
  athleteId: "SYNTHETIC-TEST-FIXTURE.athlete-xc",
  athleteGroupId: "SYNTHETIC-TEST-FIXTURE.group-xc",
  sessionId: "SYNTHETIC-TEST-FIXTURE.session-xc",
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

interface IntakeRow {
  id: string;
  category: GeneratedCase["category"];
  expected: GeneratedCase["expected"];
  sha256: string;
  recipe: string;
  outcome: "record" | "threw" | "child_crash" | "child_timeout";
  status: IntakeRecord["status"] | null;
  reasons: string[];
  manifestDurationMs: number | null;
  manifestFrameCount: number | null;
  measuredDurationMs: number | null;
  envelopeOverall: string | null;
  envelopeCoverage: string | null;
  wallMs: number;
  error: string | null;
}

/** Cases that are known to abort the host process (OOM) — run in a child. */
const CHILD_ISOLATED = new Set(["extreme_aspect_1000x2", "extreme_aspect_2x1000"]);

let dir: string;
let ledgerPath: string;
let metaPath: string;
let cases: GeneratedCase[] = [];
const rows: IntakeRow[] = [];

const enabled = hasFfmpeg();

beforeAll(() => {
  if (!enabled) return;
  dir = mkdtempSync(join(tmpdir(), "xc-media2-intake-"));
  ledgerPath = join(dir, "ledger.json");
  metaPath = join(dir, "meta.json");
  writeFileSync(ledgerPath, JSON.stringify(LEDGER, null, 2));
  writeFileSync(metaPath, JSON.stringify(CAPTURE_META, null, 2));
  cases = generateCorpus(join(dir, "corpus")).cases;
  mkdirSync(outDir, { recursive: true });
}, 180_000);

afterAll(() => {
  if (!enabled) return;
  writeFileSync(
    join(outDir, "intake-matrix.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2),
  );
  rmSync(dir, { recursive: true, force: true });
});

function runIntake(c: GeneratedCase): IntakeRow {
  const t0 = Date.now();
  const base = {
    id: c.id,
    category: c.category,
    expected: c.expected,
    sha256: c.sha256,
    recipe: c.recipe,
  };
  if (CHILD_ISOLATED.has(c.id)) {
    const script = `
      import { intakeClip } from ${JSON.stringify(join(here, "..", "src", "index.ts"))};
      const r = intakeClip({ clipPath: ${JSON.stringify(c.path)}, captureMetaPath: ${JSON.stringify(metaPath)}, consentLedgerPath: ${JSON.stringify(ledgerPath)}, subjectPseudonym: ${JSON.stringify(SYNTH_SUBJECT)}, operatorId: "xc" });
      process.stdout.write(JSON.stringify(r));
    `;
    const res = spawnSync(
      process.execPath,
      ["--max-old-space-size=512", "--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: join(here, ".."),
        encoding: "utf8",
        timeout: 60_000,
        killSignal: "SIGKILL",
      },
    );
    const wallMs = Date.now() - t0;
    const timedOut = (res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    let rec: IntakeRecord | null = null;
    try {
      rec = res.stdout ? (JSON.parse(res.stdout) as IntakeRecord) : null;
    } catch {
      rec = null;
    }
    if (timedOut || rec === null) {
      return {
        ...base,
        outcome: timedOut ? "child_timeout" : "child_crash",
        status: null,
        reasons: [],
        manifestDurationMs: null,
        manifestFrameCount: null,
        measuredDurationMs: null,
        envelopeOverall: null,
        envelopeCoverage: null,
        wallMs,
        error: `exit=${res.status} signal=${res.signal} stderr=${(res.stderr ?? "").slice(-400)}`,
      };
    }
    return recordRow(base, rec, wallMs);
  }
  try {
    const rec = intakeClip({
      clipPath: c.path,
      captureMetaPath: metaPath,
      consentLedgerPath: ledgerPath,
      subjectPseudonym: SYNTH_SUBJECT,
      operatorId: "xc-matrix-media-2",
    });
    return recordRow(base, rec, Date.now() - t0);
  } catch (error) {
    return {
      ...base,
      outcome: "threw",
      status: null,
      reasons: [],
      manifestDurationMs: null,
      manifestFrameCount: null,
      measuredDurationMs: null,
      envelopeOverall: null,
      envelopeCoverage: null,
      wallMs: Date.now() - t0,
      error: String((error as Error).message ?? error).slice(0, 500),
    };
  }
}

function recordRow(
  base: Pick<IntakeRow, "id" | "category" | "expected" | "sha256" | "recipe">,
  rec: IntakeRecord,
  wallMs: number,
): IntakeRow {
  return {
    ...base,
    outcome: "record",
    status: rec.status,
    reasons: rec.reasons,
    manifestDurationMs: rec.manifestDraft?.rawAsset.durationMs ?? null,
    manifestFrameCount: rec.manifestDraft?.rawAsset.frameCount ?? null,
    measuredDurationMs: rec.measurements?.clipDurationMs ?? null,
    envelopeOverall: rec.envelope?.overall ?? null,
    envelopeCoverage: rec.envelope?.overallWithCoverage ?? null,
    wallMs,
    error: null,
  };
}

describe.skipIf(!enabled)(
  "xc-matrix-media-2: first-party intake over the adversarial corpus",
  () => {
    it("corpus definition covers every required adversarial family", () => {
      const cats = new Set(CORPUS_CASES.map((c) => c.category));
      for (const required of [
        "corrupted",
        "truncated",
        "wrong_extension",
        "unsupported_codec",
        "missing_audio",
        "unusual_metadata",
      ]) {
        expect(cats.has(required as GeneratedCase["category"])).toBe(true);
      }
    });

    it("every in-process case resolves to a typed IntakeRecord (never throws)", () => {
      for (const c of cases) rows.push(runIntake(c));
      const threw = rows.filter((r) => r.outcome === "threw");
      expect(threw.map((r) => `${r.id}: ${r.error}`)).toEqual([]);
    }, 240_000);

    it("typed_reject inputs (junk, truncated moov, audio-only, text/wav/raw) are REJECTED with a measurement-failure reason", () => {
      const rejects = rows.filter(
        (r) => r.expected === "typed_reject" && !CHILD_ISOLATED.has(r.id),
      );
      expect(rejects.length).toBeGreaterThan(5);
      for (const r of rejects) {
        // trunc_moovlast_tail_100b: ffprobe 4.4 tolerates the missing tail (only udta/free was cut);
        // record what happened rather than force the expectation.
        if (r.id === "trunc_moovlast_tail_100b") continue;
        expect(r.status, r.id).toBe("REJECTED");
        expect(
          r.reasons.some((x) => x.startsWith("envelope measurement failed")),
          `${r.id}: ${r.reasons.join(" | ")}`,
        ).toBe(true);
      }
    });

    it("zeroed mdat (intact index, undecodable samples) is REJECTED, not accepted on metadata alone", () => {
      const r = rows.find((x) => x.id === "mdat_zeroed_moov_intact")!;
      expect(r.status).toBe("REJECTED");
    });

    it("unknown video fourcc (intact container, no decoder) is REJECTED", () => {
      const r = rows.find((x) => x.id === "avc1_fourcc_patched")!;
      expect(r.status).toBe("REJECTED");
    });

    it("stills / single-frame / sub-second 'videos' are REJECTED on clip_duration", () => {
      for (const id of ["png_as_mp4", "jpeg_as_mp4", "single_frame"]) {
        const r = rows.find((x) => x.id === id)!;
        expect(r.status, id).toBe("REJECTED");
        expect(r.reasons.join(" "), id).toContain("clip_duration");
      }
    });

    it("well-formed clips are ACCEPTED regardless of extension or audio presence", () => {
      for (const id of [
        "base_720p30_aac",
        "mp4_as_txt",
        "mp4_as_mov",
        "video_only_no_audio",
        "silent_audio_track",
        "audio_stream_truncated",
        "junk_tail_1mib",
      ]) {
        const r = rows.find((x) => x.id === id)!;
        expect(r.status, id).toBe("ACCEPTED");
        expect(r.manifestDurationMs, id).toBe(3000);
      }
    });

    it("KNOWN FINDING: half-truncated faststart mp4 is ACCEPTED with the moov-declared 3.0 s duration while only ~half the frames exist", () => {
      const r = rows.find((x) => x.id === "trunc_faststart_50pct")!;
      // Documents current behaviour. If this flips to REJECTED (or the manifest
      // duration starts reflecting decodable content) the finding is fixed —
      // update the assertion and close the finding.
      expect(r.status).toBe("ACCEPTED");
      expect(r.envelopeOverall).toBe("SUPPORTED");
      expect(r.manifestDurationMs).toBe(3000);
      expect(r.measuredDurationMs).toBe(3000);
      // Packet count reflects the bytes that actually survived the cut …
      expect(r.manifestFrameCount).not.toBeNull();
      expect(r.manifestFrameCount!).toBeLessThan(60);
      // … so the manifest is internally inconsistent: frames/fps disagrees with durationMs by > 1 s.
      const impliedMs = (r.manifestFrameCount! / 30) * 1000;
      expect(Math.abs(impliedMs - r.manifestDurationMs!)).toBeGreaterThan(1000);
    });

    it("KNOWN FINDING: extreme aspect ratio clips abort the intake PROCESS (OOM in extractSampledGrayFrames) instead of a typed REJECTED", () => {
      for (const id of CHILD_ISOLATED) {
        const r = rows.find((x) => x.id === id)!;
        expect(r.outcome, `${id}: ${r.error}`).toBe("child_crash");
        expect(r.error, id).toContain("signal=SIGABRT");
      }
    });
  },
);
