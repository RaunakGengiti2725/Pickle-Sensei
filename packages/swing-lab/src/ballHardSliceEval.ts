import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoseSequence } from "@pickle/swing-domain";
import type { BallFrameLabel } from "./annotationSchema.js";
import type { BallPrediction } from "./ballBench.js";
import {
  aggregateBallOcclusionResults,
  scoreBallOcclusionCase,
  type BallOcclusionCaseResult,
} from "./ballOcclusionBench.js";
import {
  buildBallTracks,
  selectPrimaryBallTrack,
  type BallCandidateFile,
  type BallTimeline,
} from "./ballTracker.js";

/**
 * D2-06 hard-slice ball evaluation (wave E, LINUX-CPU pose-free proxy).
 *
 * Runs the REAL tracker (buildBallTracks → selectPrimaryBallTrack, which
 * links the occlusion timeline) over committed Linux-regenerated motion
 * candidates and scores the canonical observations against the 43 D2-06
 * hard-slice gold labels, per occlusion bucket AND per named hard slice
 * (netCrossing / paddleOcclusion / multiBallBackground / fastBlur /
 * occlusionCycle).
 *
 * Measurement boundary (stated, not hidden):
 * - No pose (Apple Vision is macOS-only): the play-band gate is inert and
 *   the body-occlusion machine has no body region to reason about.
 * - No paddle track: paddle-proximity gates are inert
 *   (paddleTrackExists=false).
 * - Candidate clocks are frame-exact against each label clock; offsets are
 *   declared in the manifest.
 * Denominators are the committed gold labels; nothing is resampled.
 */

interface ManifestWindow {
  startMs: number;
  endMs: number;
  note?: string;
}

interface ManifestCase {
  id: string;
  labels: string;
  candidates: string;
  clockOffsetMs: number;
  clock: string;
  windows: ManifestWindow[];
}

interface Manifest {
  cases: ManifestCase[];
  slices: Record<string, Array<{ case: string; tMs: number[] }>>;
}

const EMPTY_POSE: PoseSequence = {
  schemaVersion: 1,
  format: "pickle.pose-sequence.v1",
  coordinateSystem: "normalized_image_top_left",
  producedBy: {
    providerId: "pose.none-linux-proxy",
    modelVersion: "absent (Apple Vision is macOS-only)",
    runtime: "deterministic",
    executionTarget: "server",
    artifactHash: null,
  },
  video: { width: 1920, height: 1080, fps: 30 },
  frames: [],
};

function shiftClock(file: BallCandidateFile, offsetMs: number): BallCandidateFile {
  if (offsetMs === 0) return file;
  return {
    ...file,
    window: { startMs: file.window.startMs - offsetMs, endMs: file.window.endMs - offsetMs },
    frames: file.frames.map((frame) => ({ ...frame, tMs: frame.tMs - offsetMs })),
  };
}

export interface HardSliceWindowRun {
  window: ManifestWindow;
  status: "tracked" | "untracked";
  reason?: string;
  observationCount: number;
  predictions: BallPrediction[];
  timeline: BallTimeline | null;
}

export function runCaseWindows(
  file: BallCandidateFile,
  windows: readonly ManifestWindow[],
): HardSliceWindowRun[] {
  return windows.map((window) => {
    const { gated, fragments, ablation } = buildBallTracks(file, EMPTY_POSE, window, null);
    const outcome = selectPrimaryBallTrack(gated, ablation, window, {
      paddleTrackExists: false,
      fragments,
    });
    if (outcome.status !== "tracked") {
      return {
        window,
        status: "untracked",
        reason: outcome.reason,
        observationCount: 0,
        predictions: [],
        timeline: null,
      };
    }
    return {
      window,
      status: "tracked",
      observationCount: outcome.track.observations.length,
      predictions: outcome.track.observations.map((observation) => ({
        t: observation.timestampMs,
        x: observation.x,
        y: observation.y,
        conf: observation.confidence,
      })),
      timeline: outcome.timeline,
    };
  });
}

interface SliceRow {
  slice: string;
  n: number;
  hits: number;
  misses: number;
  wrongLocation: number;
  abstained: number;
  violations: number;
  excluded: number;
}

function scoreSlices(
  manifest: Manifest,
  labelsByCase: Map<string, BallFrameLabel[]>,
  predictionsByCase: Map<string, BallPrediction[]>,
  timelineByCase: Map<string, BallTimeline | null>,
): SliceRow[] {
  const rows: SliceRow[] = [];
  for (const [slice, members] of Object.entries(manifest.slices)) {
    const row: SliceRow = {
      slice,
      n: 0,
      hits: 0,
      misses: 0,
      wrongLocation: 0,
      abstained: 0,
      violations: 0,
      excluded: 0,
    };
    for (const member of members) {
      const labels = (labelsByCase.get(member.case) ?? []).filter((label) =>
        member.tMs.includes(label.tMs),
      );
      const result = scoreBallOcclusionCase(
        `${slice}:${member.case}`,
        labels,
        predictionsByCase.get(member.case) ?? [],
        timelineByCase.get(member.case) ?? null,
      );
      for (const bucket of result.buckets) {
        if (bucket.bucket === "UNCERTAIN_EXCLUDED") {
          row.excluded += bucket.n;
          continue;
        }
        row.n += bucket.n;
        row.hits += bucket.hits;
        row.misses += bucket.misses;
        row.wrongLocation += bucket.wrongLocation;
        row.abstained += bucket.abstained;
        row.violations += bucket.violations;
      }
    }
    rows.push(row);
  }
  return rows;
}

const isMain = process.argv[1]?.endsWith("ballHardSliceEval.ts");
if (isMain) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const experimentDir = join(repoRoot, "datasets/experiments/wave-e/e12-ball-hard-slices");
  const manifest = JSON.parse(
    readFileSync(join(experimentDir, "manifest.json"), "utf8"),
  ) as Manifest & { labels: { annotatorId: string } };
  const outPath = process.argv[2] ? resolve(process.argv[2]) : null;
  if (outPath === join(experimentDir, "manifest.json")) {
    throw new Error("refusing to overwrite the manifest; pass a report path");
  }

  const labelsByCase = new Map<string, BallFrameLabel[]>();
  const predictionsByCase = new Map<string, BallPrediction[]>();
  const timelineByCase = new Map<string, BallTimeline | null>();
  const caseResults: BallOcclusionCaseResult[] = [];
  const report: Record<string, unknown> = {};

  console.log("═".repeat(72));
  console.log("E12 BALL HARD-SLICE EVAL — D2-06 gold (LINUX-CPU pose-free proxy)");
  console.log("═".repeat(72));

  for (const benchCase of manifest.cases) {
    const labelsPath = resolve(experimentDir, benchCase.labels);
    const annotation = JSON.parse(readFileSync(labelsPath, "utf8")) as {
      annotatorId?: string;
      ballFrames?: BallFrameLabel[];
    };
    const labels = annotation.ballFrames ?? [];
    labelsByCase.set(benchCase.id, labels);

    const rawFile = JSON.parse(
      readFileSync(resolve(experimentDir, benchCase.candidates), "utf8"),
    ) as BallCandidateFile;
    const file = shiftClock(rawFile, benchCase.clockOffsetMs);
    const runs = runCaseWindows(file, benchCase.windows);
    const predictions = runs.flatMap((run) => run.predictions);
    predictionsByCase.set(benchCase.id, predictions);
    // Bridge honesty is checked per window run; the case-level timeline used
    // for slice scoring is the first tracked window's (single-window cases).
    timelineByCase.set(benchCase.id, runs.find((run) => run.timeline)?.timeline ?? null);

    console.log(
      `\n${benchCase.id} — ${labels.length} labels, ${benchCase.windows.length} window(s)`,
    );
    for (const run of runs) {
      const label =
        run.status === "tracked"
          ? `tracked, ${run.observationCount} observations`
          : `untracked (${run.reason})`;
      console.log(`  window ${run.window.startMs}-${run.window.endMs}ms: ${label}`);
    }
    const result = scoreBallOcclusionCase(benchCase.id, labels, predictions, null);
    for (const run of runs) {
      if (!run.timeline) continue;
      const bridgeCheck = scoreBallOcclusionCase(benchCase.id, [], run.predictions, run.timeline);
      result.violations.push(...bridgeCheck.violations);
    }
    caseResults.push(result);
    for (const bucket of result.buckets) {
      if (bucket.n === 0) continue;
      const line =
        bucket.bucket === "OCCLUDED" || bucket.bucket === "NOT_VISIBLE"
          ? `abstained ${bucket.abstained}/${bucket.n} · VIOLATIONS ${bucket.violations}`
          : `hits ${bucket.hits}/${bucket.n} · miss ${bucket.misses} · wrongLoc ${bucket.wrongLocation}`;
      console.log(`  ${bucket.bucket}: ${line}`);
    }
    for (const violation of result.violations) {
      console.log(`  VIOLATION [${violation.kind}]: ${violation.detail}`);
    }
    report[benchCase.id] = {
      windows: runs.map((run) => ({
        window: run.window,
        status: run.status,
        reason: run.reason,
        observationCount: run.observationCount,
      })),
      buckets: result.buckets.filter((bucket) => bucket.n > 0),
      violations: result.violations,
    };
  }

  console.log(`\n${"─".repeat(72)}`);
  console.log("PER-BUCKET AGGREGATE (all 43 D2-06 labels):");
  const aggregate = aggregateBallOcclusionResults(caseResults);
  for (const bucket of aggregate) {
    if (bucket.n === 0) continue;
    const line =
      bucket.bucket === "OCCLUDED" || bucket.bucket === "NOT_VISIBLE"
        ? `abstained ${bucket.abstained}/${bucket.n} · VIOLATIONS ${bucket.violations}`
        : `hits ${bucket.hits}/${bucket.n} · miss ${bucket.misses} · wrongLoc ${bucket.wrongLocation}`;
    console.log(`  ${bucket.bucket}: n=${bucket.n} · ${line}`);
  }

  console.log(`\n${"─".repeat(72)}`);
  console.log("PER-SLICE QUALITY (D2-06 hardSliceCoverage groups):");
  const sliceRows = scoreSlices(manifest, labelsByCase, predictionsByCase, timelineByCase);
  for (const row of sliceRows) {
    console.log(
      `  ${row.slice}: n=${row.n} hits ${row.hits} miss ${row.misses} wrongLoc ${row.wrongLocation}` +
        ` abstained ${row.abstained} violations ${row.violations}` +
        (row.excluded > 0 ? ` (uncertain excluded ${row.excluded})` : ""),
    );
  }

  if (outPath) {
    report["aggregate"] = aggregate.filter((bucket) => bucket.n > 0);
    report["slices"] = sliceRows;
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nreport written to ${outPath}`);
  }
}
