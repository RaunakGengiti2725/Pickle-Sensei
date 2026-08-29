/**
 * wave-g/g18-fresh-footage window probe: re-run the pose-free OOD gate over
 * 10 s windows of two of the newly acquired clips (yt-tuKiznvDJ4E, which
 * contains extended full-frame face close-ups between rallies, and
 * yt-jkiAWFrdc-g, which contains talking-to-camera instructional segments)
 * to measure whether content-level non-play windows inside an in-envelope
 * clip pass the pose-free gate.
 *
 * Windows are transient re-encodes under /tmp (not committed); the measured
 * results are recorded in g18-fresh-footage-window-measurements.json.
 *
 * Usage: pnpm --filter @pickle/swing-lab exec tsx ../../datasets/experiments/wave-g/g18-window-probe.ts <windowsDir>
 */

import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateFrameAnalyzability, FRAME_ANALYZABILITY_VERSION } from "@pickle/vision-geometry";
import { preAnalysisGate, PRE_ANALYSIS_GATE_VERSION } from "@pickle/analysis-pipeline";
import { extractFrameStats } from "../../../packages/swing-lab/src/frameStats.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const windowsDir = process.argv[2];
if (!windowsDir) throw new Error("usage: g18-window-probe.ts <windowsDir>");

const files = readdirSync(windowsDir)
  .filter((f) => f.endsWith(".mp4"))
  .sort();

const measurements = files.map((file) => {
  const stats = extractFrameStats(join(windowsDir, file));
  const frame = evaluateFrameAnalyzability(stats);
  const gate = preAnalysisGate({ frame, pose: null, poseQuality: null });
  return {
    window: file,
    frameCount: stats.frameCount,
    frameAnalyzable: frame.analyzable,
    frameReasons: frame.reasons,
    gateOk: gate.ok,
    gateFailureKind: gate.ok ? null : gate.failure.kind,
    notEvaluated: gate.ok ? gate.value.notEvaluated : [],
  };
});

const out = {
  workstream: "wave-g/g18-fresh-footage",
  measuredAt: new Date().toISOString().slice(0, 10),
  method:
    "10s windows re-encoded from the two committed clips (ffmpeg -ss <start> -t 10, libx264 crf22); pose-free extractFrameStats -> evaluateFrameAnalyzability -> preAnalysisGate({pose:null})",
  frameAnalyzabilityVersion: FRAME_ANALYZABILITY_VERSION,
  preAnalysisGateVersion: PRE_ANALYSIS_GATE_VERSION,
  measurements,
};

const outPath = join(
  repoRoot,
  "datasets",
  "experiments",
  "wave-g",
  "g18-fresh-footage-window-measurements.json",
);
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
for (const m of measurements) {
  console.log(`${m.window}: gateOk=${m.gateOk} reasons=${JSON.stringify(m.frameReasons)}`);
}
