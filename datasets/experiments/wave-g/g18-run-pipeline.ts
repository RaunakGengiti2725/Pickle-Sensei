/**
 * wave-g/g18-fresh-footage: run every Linux-replayable pipeline stage over the
 * six clips acquired by this workstream (registered 2026-08-29 under
 * datasets/pickleball/fresh-candidates/) and record per-clip verdicts.
 *
 * Stages (pose-free; Apple-Vision pose extraction is macOS-only and honestly
 * NOT run here):
 *   1. capture-envelope: measureClip -> evaluateCaptureEnvelope
 *      (thresholds v0.1 remain UNVALIDATED per e15/f18 scientific negatives;
 *      statuses are reported with that caveat, never as capture-quality truth)
 *   2. OOD pre-analysis gate: extractFrameStats -> evaluateFrameAnalyzability
 *      -> preAnalysisGate({ frame, pose: null, poseQuality: null })
 *
 * Held-out cases wm-dink-01 and afn-vic-rally1 are not touched.
 *
 * Usage: pnpm --filter @pickle/swing-lab exec tsx ../../datasets/experiments/wave-g/g18-run-pipeline.ts
 * Output: datasets/experiments/wave-g/g18-fresh-footage-measurements.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateCaptureEnvelope,
  measureClip,
  CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
} from "../../../packages/capture-envelope/src/index.js";
import { evaluateFrameAnalyzability, FRAME_ANALYZABILITY_VERSION } from "@pickle/vision-geometry";
import { preAnalysisGate, PRE_ANALYSIS_GATE_VERSION } from "@pickle/analysis-pipeline";
import { extractFrameStats } from "../../../packages/swing-lab/src/frameStats.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const G18_IDS = [
  "yt-CWqy7OtTpe4",
  "yt-HlnDVB6hl4E",
  "yt-tuKiznvDJ4E",
  "yt-pZou8Mtcu3g",
  "yt-jkiAWFrdc-g",
  "yt-DD7uDPi_PJg",
];

interface RegistryItem {
  id: string;
  path: string;
  media: { sha256: string };
}

const registry = JSON.parse(
  readFileSync(join(repoRoot, "datasets", "pickleball", "registry.json"), "utf8"),
) as { freshCandidates: { items: RegistryItem[] } };

const items = registry.freshCandidates.items.filter((i) => G18_IDS.includes(i.id));
if (items.length !== G18_IDS.length) {
  throw new Error(`expected ${G18_IDS.length} registered g18 clips, found ${items.length}`);
}

const measurements = items.map((item) => {
  const clipPath = join(repoRoot, item.path);

  const envelopeMeasurements = measureClip(clipPath);
  const envelope = evaluateCaptureEnvelope(envelopeMeasurements);

  const stats = extractFrameStats(clipPath);
  const frame = evaluateFrameAnalyzability(stats);
  const gate = preAnalysisGate({ frame, pose: null, poseQuality: null });

  return {
    id: item.id,
    path: item.path,
    sha256: item.media.sha256,
    captureEnvelope: {
      measurements: envelopeMeasurements,
      verdict: envelope,
    },
    oodGate: {
      frameCount: stats.frameCount,
      durationMs: stats.durationMs,
      frameAnalyzable: frame.analyzable,
      frameReasons: frame.reasons,
      gateOk: gate.ok,
      gateFailureKind: gate.ok ? null : gate.failure.kind,
      gateFailureCode: gate.ok ? null : gate.failure.code,
      notEvaluated: gate.ok ? gate.value.notEvaluated : [],
    },
  };
});

const out = {
  workstream: "wave-g/g18-fresh-footage",
  measuredAt: new Date().toISOString().slice(0, 10),
  environment:
    "Linux CPU; ffmpeg decode; pose extraction unavailable (Apple Vision is macOS-only), so pose-derived envelope dimensions are NOT_MEASURED and pose-conditioned gate signals are notEvaluated by construction",
  captureEnvelopeThresholdsVersion: CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
  captureEnvelopeThresholdsCaveat:
    "Envelope thresholds v0.1 remain UNVALIDATED (e15 and f18 corpus re-derivations both failed to validate them - preserved scientific negatives). Statuses below are threshold classifications, not validated capture-quality truth.",
  frameAnalyzabilityVersion: FRAME_ANALYZABILITY_VERSION,
  preAnalysisGateVersion: PRE_ANALYSIS_GATE_VERSION,
  heldOutStatement:
    "Held-out cases wm-dink-01 and afn-vic-rally1 were not read, listed, or referenced. All six clips are newly acquired label-blind fresh candidates.",
  measurements,
};

const outPath = join(
  repoRoot,
  "datasets",
  "experiments",
  "wave-g",
  "g18-fresh-footage-measurements.json",
);
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${outPath}`);
for (const m of measurements) {
  console.log(
    `${m.id}: envelope=${m.captureEnvelope.verdict.overall ?? JSON.stringify(m.captureEnvelope.verdict).slice(0, 60)} gateOk=${m.oodGate.gateOk} frameAnalyzable=${m.oodGate.frameAnalyzable}`,
  );
}
