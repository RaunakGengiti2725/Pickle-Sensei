import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { evaluateCaptureEnvelope, type CaptureEnvelopeMeasurements } from "./envelope.js";
import { measureClip, type MeasureWindow } from "./clipProbe.js";
import { CAPTURE_ENVELOPE_THRESHOLDS_VERSION } from "./thresholds.js";

/**
 * E15: run the capture-envelope evaluator over every usable-rights clip whose
 * media is present on disk, join the verdicts against downstream-analysis
 * ground truth, and emit the confusion matrix.
 *
 * Units:
 *  - committed paddle-bench bundle clips  → cascade outcome ground truth
 *  - corpus recordings (sha-verified re-downloads) → per-scene ground truth
 *    from datasets/corpus/events + datasets/corpus/failure-queue.json
 *  - fresh-candidates and OOD negatives   → measured, NO ground truth
 *    (reported as unlabeled slices, excluded from the matrix)
 *
 * Held-out cases wm-dink-01 and afn-vic-rally1 are excluded entirely: their
 * clips are never opened, measured, or evaluated here.
 *
 * Usage: pnpm --filter @pickle/capture-envelope eval:corpus
 * Output: datasets/experiments/wave-e/e15-envelope-corpus-measurements.json
 */

const repoRoot = resolve(import.meta.dirname, "../../..");
const outDir = join(repoRoot, "datasets", "experiments", "wave-e");

const HELD_OUT_CASES = new Set(["wm-dink-01", "afn-vic-rally1"]);
const HELD_OUT_RECORDINGS = new Set(["rec-7d396a6d6566", "rec-024decaeb66e"]);

/** Downstream failure kinds caused by scene CONTENT (OOD segments inside
 * b-roll), which a capture-quality envelope is not expected to predict. */
const CONTENT_FAILURE_KINDS = new Set(["NO_PEOPLE", "STATIC_HUMAN_GRAPHIC", "SCENE_CHURN"]);

interface RecordingRecord {
  recordingId: string;
  sourceId: string;
  path: string;
  sha256: string;
  sessionKey: string;
  derivedFrom?: unknown[];
}

interface FailureItem {
  recordingId: string;
  sceneIndex: number;
  windowMs: { start: number; end: number };
  kind: string;
  severity: number;
}

interface MinedEvent {
  recordingId: string;
  sceneIndex: number;
  sceneStartMs: number;
  sceneEndMs: number;
  tier: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

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
    denoiseSurvivalRatio: round(m.denoiseSurvivalRatio, 4),
    clippedPixelFraction: round(m.clippedPixelFraction, 4),
    contrastNormalizedFrameDiff: round(m.contrastNormalizedFrameDiff, 4),
    frameIntervalCv: round(m.frameIntervalCv, 4),
  };
}

interface Unit {
  unitId: string;
  kind: "bundle_clip" | "corpus_scene" | "corpus_recording" | "fresh_candidate" | "ood_negative";
  clip: string;
  sessionKey: string;
  window: MeasureWindow | null;
  groundTruth: "GOOD" | "FAILED" | "UNLABELED";
  groundTruthBasis: string;
  contentFailureOnly: boolean;
  shaVerified: boolean | null;
}

const units: Unit[] = [];

// ── 1. committed bundle clips with cascade ground truth ──────────────────
const bundlesDir = join(repoRoot, "datasets", "paddle-bench", "bundles");
const cascadeDir = join(repoRoot, "datasets", "cascade");
const cascadeFiles = readdirSync(cascadeDir)
  .filter((name) => name.startsWith("cascade-") && name.endsWith(".json"))
  .sort();
const latestCascade = readJson<{
  rows: Array<{ caseId: string; split: string; conditionalReached: string }>;
}>(join(cascadeDir, cascadeFiles[cascadeFiles.length - 1]!));
const cascadeByCase = new Map(latestCascade.rows.map((row) => [row.caseId, row]));

for (const entry of readdirSync(bundlesDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || HELD_OUT_CASES.has(entry.name)) continue;
  const clipPath = join(bundlesDir, entry.name, "clip.mp4");
  if (!existsSync(clipPath)) continue;
  const cascade = cascadeByCase.get(entry.name);
  units.push({
    unitId: `bundle:${entry.name}`,
    kind: "bundle_clip",
    clip: `datasets/paddle-bench/bundles/${entry.name}/clip.mp4`,
    sessionKey: entry.name.startsWith("afn-sasebo") ? "afn-sasebo-2025" : `bundle-${entry.name}`,
    window: null,
    groundTruth: cascade
      ? cascade.conditionalReached === "COMPLETE"
        ? "GOOD"
        : "FAILED"
      : "UNLABELED",
    groundTruthBasis: cascade
      ? `latest cascade run ${cascadeFiles[cascadeFiles.length - 1]}: ${cascade.conditionalReached}`
      : "no cascade row",
    contentFailureOnly: false,
    shaVerified: null,
  });
}

// ── 2. corpus recordings (sha-verified re-downloads) per scene ───────────
const recordings = readJson<RecordingRecord[]>(
  join(repoRoot, "datasets", "corpus", "recordings.json"),
);
const rederivationPath = join(outDir, "e15-media-rederivation.json");
const rederivation = existsSync(rederivationPath)
  ? readJson<{ results: Array<{ recordingId: string; shaVerified?: boolean }> }>(rederivationPath)
  : { results: [] };
const shaByRecording = new Map(
  rederivation.results.map((r) => [r.recordingId, r.shaVerified ?? null]),
);

const failureQueue = readJson<{ items: FailureItem[] }>(
  join(repoRoot, "datasets", "corpus", "failure-queue.json"),
);
const eventsDir = join(repoRoot, "datasets", "corpus", "events");

for (const recording of recordings) {
  if (HELD_OUT_RECORDINGS.has(recording.recordingId)) continue;
  const mediaPath = join(repoRoot, recording.path);
  if (!existsSync(mediaPath)) continue;
  const shaVerified = shaByRecording.get(recording.recordingId) ?? null;

  const scenes = new Map<
    number,
    { startMs: number; endMs: number; eventCount: number; failureKinds: string[] }
  >();
  const eventsPath = join(eventsDir, `${recording.recordingId}.jsonl`);
  if (existsSync(eventsPath)) {
    for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as MinedEvent;
      const scene = scenes.get(event.sceneIndex) ?? {
        startMs: event.sceneStartMs,
        endMs: event.sceneEndMs,
        eventCount: 0,
        failureKinds: [],
      };
      scene.eventCount += 1;
      scenes.set(event.sceneIndex, scene);
    }
  }
  for (const item of failureQueue.items) {
    if (item.recordingId !== recording.recordingId) continue;
    const scene = scenes.get(item.sceneIndex) ?? {
      startMs: item.windowMs.start,
      endMs: item.windowMs.end,
      eventCount: 0,
      failureKinds: [],
    };
    scene.startMs = Math.min(scene.startMs, item.windowMs.start);
    scene.endMs = Math.max(scene.endMs, item.windowMs.end);
    scene.failureKinds.push(item.kind);
    scenes.set(item.sceneIndex, scene);
  }

  if (scenes.size === 0) {
    units.push({
      unitId: `recording:${recording.recordingId}`,
      kind: "corpus_recording",
      clip: recording.path,
      sessionKey: recording.sessionKey,
      window: null,
      groundTruth: "UNLABELED",
      groundTruthBasis: "no mined events and no failure-queue entries",
      contentFailureOnly: false,
      shaVerified,
    });
    continue;
  }
  for (const [sceneIndex, scene] of [...scenes.entries()].sort((a, b) => a[0] - b[0])) {
    const failed = scene.failureKinds.length > 0;
    const contentOnly =
      failed && scene.failureKinds.every((kind) => CONTENT_FAILURE_KINDS.has(kind));
    units.push({
      unitId: `scene:${recording.recordingId}:s${sceneIndex}`,
      kind: "corpus_scene",
      clip: recording.path,
      sessionKey: recording.sessionKey,
      window: { startMs: scene.startMs, durationMs: scene.endMs - scene.startMs },
      groundTruth: failed ? "FAILED" : scene.eventCount > 0 ? "GOOD" : "UNLABELED",
      groundTruthBasis: failed
        ? `failure-queue kinds: ${[...new Set(scene.failureKinds)].join(",")}`
        : scene.eventCount > 0
          ? `${scene.eventCount} mined events, no failure-queue entry`
          : "scene visible to miner but produced neither events nor failures",
      contentFailureOnly: contentOnly,
      shaVerified,
    });
  }
}

// ── 3. fresh candidates + OOD negatives (measured, unlabeled slices) ─────
const freshDir = join(repoRoot, "datasets", "pickleball", "fresh-candidates");
if (existsSync(freshDir)) {
  for (const name of readdirSync(freshDir)
    .filter((n) => n.endsWith(".mp4"))
    .sort()) {
    units.push({
      unitId: `fresh:${name.replace(/\.mp4$/, "")}`,
      kind: "fresh_candidate",
      clip: `datasets/pickleball/fresh-candidates/${name}`,
      sessionKey: `fresh-${name}`,
      window: null,
      groundTruth: "UNLABELED",
      groundTruthBasis: "label-blind holdout pool; never analyzed downstream",
      contentFailureOnly: false,
      shaVerified: null,
    });
  }
}
const oodDir = join(repoRoot, "datasets", "ood", "negatives");
if (existsSync(oodDir)) {
  for (const name of readdirSync(oodDir)
    .filter((n) => n.endsWith(".mp4"))
    .sort()) {
    units.push({
      unitId: `ood:${name.replace(/\.mp4$/, "")}`,
      kind: "ood_negative",
      clip: `datasets/ood/negatives/${name}`,
      sessionKey: `ood-${name}`,
      window: null,
      groundTruth: "UNLABELED",
      groundTruthBasis:
        "OOD content negative: downstream failure is content-driven by design, not capture-quality-driven; excluded from the envelope confusion matrix",
      contentFailureOnly: false,
      shaVerified: null,
    });
  }
}

// ── measure + verdict ─────────────────────────────────────────────────────
const perUnit = units.map((unit) => {
  const clipPath = join(repoRoot, unit.clip);
  const measurements = roundMeasurements(measureClip(clipPath, unit.window ?? undefined));
  const verdict = evaluateCaptureEnvelope(measurements);
  process.stderr.write(`${unit.unitId}: ${verdict.overall} (gt ${unit.groundTruth})\n`);
  return { ...unit, measurements, verdict };
});

// ── confusion matrices ────────────────────────────────────────────────────
interface MatrixCell {
  predictedFlagged_actualFailed: string[];
  predictedFlagged_actualGood: string[];
  predictedPass_actualFailed: string[];
  predictedPass_actualGood: string[];
}

function confusionMatrix(rows: typeof perUnit): MatrixCell {
  const cell: MatrixCell = {
    predictedFlagged_actualFailed: [],
    predictedFlagged_actualGood: [],
    predictedPass_actualFailed: [],
    predictedPass_actualGood: [],
  };
  for (const row of rows) {
    if (row.groundTruth === "UNLABELED") continue;
    const flagged = row.verdict.overall !== "SUPPORTED";
    const failed = row.groundTruth === "FAILED";
    if (flagged && failed) cell.predictedFlagged_actualFailed.push(row.unitId);
    else if (flagged && !failed) cell.predictedFlagged_actualGood.push(row.unitId);
    else if (!flagged && failed) cell.predictedPass_actualFailed.push(row.unitId);
    else cell.predictedPass_actualGood.push(row.unitId);
  }
  return cell;
}

function summarize(cell: MatrixCell) {
  return {
    predictedFlagged_actualFailed: cell.predictedFlagged_actualFailed.length,
    predictedFlagged_actualGood: cell.predictedFlagged_actualGood.length,
    predictedPass_actualFailed: cell.predictedPass_actualFailed.length,
    predictedPass_actualGood: cell.predictedPass_actualGood.length,
  };
}

const labeled = perUnit.filter((row) => row.groundTruth !== "UNLABELED");
const allMatrix = confusionMatrix(labeled);
const captureOnlyMatrix = confusionMatrix(labeled.filter((row) => !row.contentFailureOnly));

const ffmpegVersion = execSync("ffmpeg -version").toString().split("\n")[0] ?? "unknown";

const report = {
  experiment:
    "E15 capture-envelope threshold validation: envelope verdicts vs downstream-analysis ground truth over every usable-rights clip with media on this machine",
  generatedBy: "packages/capture-envelope/src/evalCorpus.ts",
  date: new Date().toISOString().slice(0, 10),
  commit: execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim(),
  thresholdsVersion: CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
  method: {
    tooling: ffmpegVersion,
    groundTruth: [
      "bundle clips: latest cascade run conditionalReached (COMPLETE=GOOD else FAILED)",
      "corpus scenes: failure-queue entry present=FAILED; mined events and no failure=GOOD; else UNLABELED",
      "fresh candidates / OOD negatives: UNLABELED (never analyzed downstream / content negatives)",
    ],
    grouping:
      "units carry sessionKey; corpus scenes group by recording session, never random frames",
    heldOut: "wm-dink-01 and afn-vic-rally1 excluded entirely (never measured here)",
    windowedMeasurement:
      "corpus scenes measured with ffmpeg -ss/-t on the scene window; clip_duration = scene length; timing CV from packets inside the window",
  },
  unitCounts: {
    total: perUnit.length,
    labeled: labeled.length,
    unlabeled: perUnit.length - labeled.length,
    byKind: perUnit.reduce<Record<string, number>>((acc, row) => {
      acc[row.kind] = (acc[row.kind] ?? 0) + 1;
      return acc;
    }, {}),
  },
  confusionMatrix: {
    definition:
      "predictedFlagged = overall DEGRADED or UNSUPPORTED; predictedPass = overall SUPPORTED; actualFailed = downstream ground truth FAILED",
    allLabeledUnits: { counts: summarize(allMatrix), units: allMatrix },
    excludingContentOnlyFailures: {
      note: "drops units whose ONLY downstream failures are content-driven (NO_PEOPLE / STATIC_HUMAN_GRAPHIC / SCENE_CHURN) — a capture-quality envelope is not expected to catch those",
      counts: summarize(captureOnlyMatrix),
      units: captureOnlyMatrix,
    },
  },
  perUnit,
};

mkdirSync(outDir, { recursive: true });
const versionSlug = CAPTURE_ENVELOPE_THRESHOLDS_VERSION.replace(
  /^capture-envelope-thresholds-/,
  "",
).replace(/-provisional$/, "");
const outPath = join(outDir, `e15-envelope-corpus-measurements-${versionSlug}.json`);
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
process.stderr.write(`wrote ${outPath} (${perUnit.length} units, ${labeled.length} labeled)\n`);
