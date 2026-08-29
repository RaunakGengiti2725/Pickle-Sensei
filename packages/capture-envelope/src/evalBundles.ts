import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { evaluateCaptureEnvelope, type CaptureEnvelopeMeasurements } from "./envelope.js";
import { measureClip, SAMPLE_FPS, SAMPLE_WIDTH } from "./clipProbe.js";
import { CAPTURE_ENVELOPE_THRESHOLDS_VERSION } from "./thresholds.js";

/**
 * Runs the CPU clip prober over every committed paddle-bench bundle clip and
 * records real measured envelope values + verdicts. Output:
 * datasets/experiments/wave-c/c12-envelope-measurements.json
 *
 * Usage: pnpm --filter @pickle/capture-envelope eval:bundles
 */

const repoRoot = resolve(import.meta.dirname, "../../..");
const bundlesDir = join(repoRoot, "datasets", "paddle-bench", "bundles");
const outDir = join(repoRoot, "datasets", "experiments", "wave-c");

function round(value: number | null, digits: number): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundMeasurements(m: CaptureEnvelopeMeasurements): CaptureEnvelopeMeasurements {
  return {
    ...m,
    avgFrameRateFps: round(m.avgFrameRateFps, 3),
    brightnessMeanLuma: round(m.brightnessMeanLuma, 2),
    brightnessStdLuma: round(m.brightnessStdLuma, 2),
    laplacianVarianceMedian: round(m.laplacianVarianceMedian, 2),
    meanAbsFrameDiff: round(m.meanAbsFrameDiff, 3),
  };
}

const allBundles = readdirSync(bundlesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const cases = allBundles.filter((name) => existsSync(join(bundlesDir, name, "clip.mp4")));
const missingClips = allBundles.filter((name) => !existsSync(join(bundlesDir, name, "clip.mp4")));

const perClip = cases.map((caseId) => {
  const clipPath = join(bundlesDir, caseId, "clip.mp4");
  const measurements = roundMeasurements(measureClip(clipPath));
  const verdict = evaluateCaptureEnvelope(measurements);
  process.stderr.write(`${caseId}: overall ${verdict.overall}\n`);
  return {
    caseId,
    clip: `datasets/paddle-bench/bundles/${caseId}/clip.mp4`,
    measurements,
    verdict,
  };
});

const ffmpegVersion = execSync("ffmpeg -version").toString().split("\n")[0] ?? "unknown";

const report = {
  experiment: "C12 capture-envelope measurements on committed paddle-bench bundle clips",
  generatedBy: "packages/capture-envelope/src/evalBundles.ts",
  date: new Date().toISOString().slice(0, 10),
  thresholdsVersion: CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
  provisionalNote:
    "All thresholds are PROVISIONAL starting hypotheses; verdict columns show what the v0.1 constants say about real measured values, not a validated envelope.",
  method: {
    tooling: ffmpegVersion,
    videoStats: "ffprobe stream width/height/avg_frame_rate/duration",
    sampling: `ffmpeg fps=${SAMPLE_FPS}, scale=${SAMPLE_WIDTH}:-2, format=gray, rawvideo`,
    motionBlurProxy: "median per-frame variance of 4-neighbor Laplacian on sampled frames",
    cameraMotionProxy: "mean absolute per-pixel luma diff between consecutive sampled frames",
    poseDimensions:
      "player_pixel_height and player_visibility are NOT measured here (pose extraction is macOS-only); reported NOT_MEASURED, never fabricated",
  },
  bundleCount: allBundles.length,
  clipCount: perClip.length,
  missingClips,
  missingClipsNote:
    missingClips.length > 0
      ? "These bundles have annotations only; their clips are not committed (corpus media is gitignored/re-derivable) so no envelope was measured for them."
      : null,
  perClip,
};

mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "c12-envelope-measurements.json");
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
process.stderr.write(`wrote ${outPath} (${perClip.length} clips)\n`);
