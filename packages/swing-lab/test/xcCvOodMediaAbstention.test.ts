/**
 * Role `cv-failure-detection-abstention` — media plane (pose-free, Linux).
 *
 * Runs the committed OOD corpus (datasets/ood: tennis, table tennis, squash,
 * badminton, racquetball, crowd, interview, title card, empty court, plus
 * the derived still/graphic/corrupt/truncated/extreme-aspect probes) through
 *   (a) the library pose-free gate `evaluateFrameAnalyzability` →
 *       `preAnalysisGate` (via the existing `measureOodCorpusWaveE`), and
 *   (b) the SAME capture-envelope evaluation the shipping app performs at
 *       analysis time (apps/mobile/src/camera/captureEnvelope.ts
 *       `attemptCaptureEnvelope`: real resolution / fps / duration, every
 *       proxy and pose dimension NOT_MEASURED).
 *
 * (a) is what the library COULD refuse; (b) is what the app actually
 * checks. Rows where (a) refuses and (b) permits are the gap. Nothing here
 * runs Apple Vision — pose-conditioned signals are `notEvaluated` by
 * construction and are recorded as such, never as a pass.
 *
 * Artifacts: artifacts/xc-cv-abstention/ood-media.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateCaptureEnvelope } from "@pickle/capture-envelope";
import { measureOodCorpusWaveE } from "../src/oodGateWaveE.js";
import { extractFrameStats } from "../src/frameStats.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT_DIR = join(root, "artifacts", "xc-cv-abstention");

interface MediaRow {
  id: string;
  category: string;
  path: string;
  frameCount: number;
  durationMs: number;
  source: { width: number; height: number; fps: number | null } | null;
  libraryGate: {
    frameAnalyzable: boolean;
    frameReasons: string[];
    gateOk: boolean;
    gateFailureCode: string | null;
    notEvaluated: string[];
  };
  /** Mobile attempt-time envelope: config values only, everything else NOT_MEASURED. */
  mobileAttemptEnvelope: {
    overall: string;
    overallWithCoverage: string;
    notMeasured: string[];
    degradedOrUnsupported: string[];
  };
  /** Library refuses, shipping envelope permits. */
  gap: boolean;
}

describe("OOD media through the pose-free gate vs the shipping attempt envelope", () => {
  it("records every committed OOD item and the library/app gap", { timeout: 900_000 }, () => {
    const started = Date.now();
    const measurements = measureOodCorpusWaveE();
    const rows: MediaRow[] = measurements.map((m) => {
      const stats = extractFrameStats(join(root, m.path));
      const source = stats.source
        ? {
            width: stats.source.width,
            height: stats.source.height,
            fps:
              stats.frameCount > 0 && stats.durationMs > 0
                ? (stats.frameCount * 1000) / stats.durationMs
                : null,
          }
        : null;
      const envelope = evaluateCaptureEnvelope({
        frameWidthPx: source?.width ?? null,
        frameHeightPx: source?.height ?? null,
        avgFrameRateFps: source?.fps ?? null,
        brightnessMeanLuma: null,
        brightnessStdLuma: null,
        laplacianVarianceMedian: null,
        meanAbsFrameDiff: null,
        denoiseSurvivalRatio: null,
        clippedPixelFraction: null,
        contrastNormalizedFrameDiff: null,
        frameIntervalCv: null,
        clipDurationMs: stats.durationMs > 0 ? stats.durationMs : null,
        playerPixelHeightFraction: null,
        playerMeanJointVisibility: null,
      });
      const permitted = envelope.overall !== "UNSUPPORTED";
      return {
        id: m.id,
        category: m.category,
        path: m.path,
        frameCount: m.frameCount,
        durationMs: m.durationMs,
        source,
        libraryGate: {
          frameAnalyzable: m.frameAnalyzable,
          frameReasons: m.frameReasons,
          gateOk: m.gateOk,
          gateFailureCode: m.gateFailureCode,
          notEvaluated: m.notEvaluated,
        },
        mobileAttemptEnvelope: {
          overall: envelope.overall,
          overallWithCoverage: envelope.overallWithCoverage,
          notMeasured: envelope.notMeasured,
          degradedOrUnsupported: envelope.dimensions
            .filter((d) => d.status === "DEGRADED" || d.status === "UNSUPPORTED")
            .map((d) => `${d.dimension}:${d.status}`),
        },
        gap: !m.gateOk && permitted,
      };
    });
    mkdirSync(OUT_DIR, { recursive: true });
    const summary = {
      generatedAtIso: new Date().toISOString(),
      wallMs: Date.now() - started,
      heap: process.memoryUsage(),
      rows: rows.length,
      libraryRefused: rows.filter((r) => !r.libraryGate.gateOk).length,
      libraryPassedThrough: rows.filter((r) => r.libraryGate.gateOk).map((r) => r.id),
      mobileAttemptBlocked: rows
        .filter((r) => r.mobileAttemptEnvelope.overall === "UNSUPPORTED")
        .map((r) => r.id),
      gapIds: rows.filter((r) => r.gap).map((r) => r.id),
      planes:
        "Linux only: ffmpeg frame stats + TypeScript gates. Apple Vision / on-device quality emitter NOT exercised.",
    };
    writeFileSync(join(OUT_DIR, "ood-media.json"), JSON.stringify({ summary, rows }, null, 2));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Pose-conditioned signals are never claimed on Linux.
      expect(row.libraryGate.gateOk ? row.libraryGate.notEvaluated.length : 1).toBeGreaterThan(0);
    }
  });
});
