import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BallFrameLabel, BallOcclusionState } from "./annotationSchema.js";
import { BALL_HIT_RADIUS, BALL_MATCH_TOLERANCE_MS, type BallPrediction } from "./ballBench.js";
import type { BallTimeline } from "./ballTracker.js";

/**
 * Ball OCCLUSION evaluation harness (wave D).
 *
 * Scores ball tracker output against ALL committed ball gold labels, bucketed
 * by the C04 occlusion states:
 *
 *   OBSERVED            visible gold point — hit / miss / wrong-location.
 *   ENTERING_OCCLUSION  visible gold point (partially hidden) — same scoring,
 *                       reported separately because the slice is harder.
 *   OCCLUDED            the ball is in play but hidden: gold carries NO point.
 *                       The tracker MUST abstain — ANY emitted observation at
 *                       an occluded gold frame is a VIOLATION (a prediction
 *                       presented as an observation). Flagged bridge
 *                       predictions are allowed; canonical observations are not.
 *   REACQUIRED          first clear frame after the occlusion — hit / miss /
 *                       wrong-location.
 *
 * Additional non-occlusion buckets so every committed label is accounted for:
 *   NOT_VISIBLE         ball genuinely absent — emitted point = violation.
 *   UNCERTAIN_EXCLUDED  annotator could not commit — excluded from all rates.
 *
 * Denominators are the committed gold labels; nothing is resampled or
 * reweighted. Sample sizes print first.
 */

export type BallGoldBucket =
  | "OBSERVED"
  | "ENTERING_OCCLUSION"
  | "OCCLUDED"
  | "REACQUIRED"
  | "NOT_VISIBLE"
  | "UNCERTAIN_EXCLUDED";

const STATE_TO_BUCKET: Record<BallOcclusionState, BallGoldBucket> = {
  observed: "OBSERVED",
  entering_occlusion: "ENTERING_OCCLUSION",
  occluded: "OCCLUDED",
  reacquired: "REACQUIRED",
};

/** Bucket a committed gold label. Labels predating the occlusionState schema
 * extension bucket by visibility alone (visible → OBSERVED, occluded →
 * OCCLUDED): the semantics are identical, only the transition detail is
 * missing. */
export function bucketForBallLabel(label: BallFrameLabel): BallGoldBucket {
  if (label.occlusionState !== undefined) return STATE_TO_BUCKET[label.occlusionState];
  switch (label.visibility) {
    case "visible":
      return "OBSERVED";
    case "occluded":
      return "OCCLUDED";
    case "not_visible":
      return "NOT_VISIBLE";
    case "uncertain":
      return "UNCERTAIN_EXCLUDED";
  }
}

export interface BallBucketScore {
  bucket: BallGoldBucket;
  n: number;
  /** Visible buckets (OBSERVED / ENTERING_OCCLUSION / REACQUIRED). */
  hits: number;
  misses: number;
  wrongLocation: number;
  /** Abstention buckets (OCCLUDED / NOT_VISIBLE). */
  abstained: number;
  violations: number;
}

export interface BallOcclusionViolation {
  bucket: BallGoldBucket;
  tMs: number;
  kind:
    "EMITTED_DURING_OCCLUDED_GOLD" | "EMITTED_DURING_NOT_VISIBLE_GOLD" | "UNFLAGGED_BRIDGE_POINT";
  detail: string;
}

export interface BallOcclusionCaseResult {
  caseId: string;
  labeledFrames: number;
  buckets: BallBucketScore[];
  violations: BallOcclusionViolation[];
}

function emptyBucket(bucket: BallGoldBucket): BallBucketScore {
  return { bucket, n: 0, hits: 0, misses: 0, wrongLocation: 0, abstained: 0, violations: 0 };
}

export const BALL_BUCKET_ORDER: readonly BallGoldBucket[] = [
  "OBSERVED",
  "ENTERING_OCCLUSION",
  "OCCLUDED",
  "REACQUIRED",
  "NOT_VISIBLE",
  "UNCERTAIN_EXCLUDED",
];

function nearestPrediction(
  predictions: readonly BallPrediction[],
  tMs: number,
): BallPrediction | null {
  let best: BallPrediction | null = null;
  let bestDelta = Infinity;
  for (const prediction of predictions) {
    const delta = Math.abs(prediction.t - tMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = prediction;
    }
  }
  return best && bestDelta <= BALL_MATCH_TOLERANCE_MS ? best : null;
}

/**
 * Score one case's canonical tracker observations against its committed gold,
 * per occlusion bucket. `predictions` MUST be the canonical (measured)
 * observations only — flagged bridge predictions are checked separately via
 * `timeline` and must never appear here.
 */
export function scoreBallOcclusionCase(
  caseId: string,
  labels: readonly BallFrameLabel[],
  predictions: readonly BallPrediction[],
  timeline: BallTimeline | null = null,
): BallOcclusionCaseResult {
  const buckets = new Map<BallGoldBucket, BallBucketScore>(
    BALL_BUCKET_ORDER.map((bucket) => [bucket, emptyBucket(bucket)]),
  );
  const violations: BallOcclusionViolation[] = [];

  for (const label of labels) {
    const bucket = bucketForBallLabel(label);
    const score = buckets.get(bucket)!;
    score.n += 1;
    if (bucket === "UNCERTAIN_EXCLUDED") continue;
    const prediction = nearestPrediction(predictions, label.tMs);
    if (bucket === "OCCLUDED" || bucket === "NOT_VISIBLE") {
      if (prediction) {
        score.violations += 1;
        violations.push({
          bucket,
          tMs: label.tMs,
          kind:
            bucket === "OCCLUDED"
              ? "EMITTED_DURING_OCCLUDED_GOLD"
              : "EMITTED_DURING_NOT_VISIBLE_GOLD",
          detail: `observation at ${prediction.t}ms (${prediction.x.toFixed(3)},${prediction.y.toFixed(3)}) within ${BALL_MATCH_TOLERANCE_MS}ms of ${bucket} gold ${label.tMs}ms`,
        });
      } else {
        score.abstained += 1;
      }
      continue;
    }
    if (!prediction) {
      score.misses += 1;
      continue;
    }
    const error = Math.hypot(prediction.x - label.point!.x, prediction.y - label.point!.y);
    if (error <= BALL_HIT_RADIUS) score.hits += 1;
    else score.wrongLocation += 1;
  }

  // Bridge honesty: every bridge point must be flagged predicted and must not
  // coincide with a canonical observation timestamp (a prediction presented
  // as an observation).
  if (timeline) {
    const observedTimestamps = new Set(predictions.map((prediction) => Math.round(prediction.t)));
    for (const point of timeline.bridge) {
      const flagged = (point as { predicted?: boolean }).predicted === true;
      if (!flagged || observedTimestamps.has(Math.round(point.t))) {
        violations.push({
          bucket: "OCCLUDED",
          tMs: point.t,
          kind: "UNFLAGGED_BRIDGE_POINT",
          detail: flagged
            ? `bridge prediction at ${point.t}ms collides with a canonical observation timestamp`
            : `bridge point at ${point.t}ms is not flagged predicted`,
        });
      }
    }
  }

  return {
    caseId,
    labeledFrames: labels.length,
    buckets: BALL_BUCKET_ORDER.map((bucket) => buckets.get(bucket)!),
    violations,
  };
}

/** Sum per-bucket scores across cases (denominator = committed labels). */
export function aggregateBallOcclusionResults(
  results: readonly BallOcclusionCaseResult[],
): BallBucketScore[] {
  const totals = new Map<BallGoldBucket, BallBucketScore>(
    BALL_BUCKET_ORDER.map((bucket) => [bucket, emptyBucket(bucket)]),
  );
  for (const result of results) {
    for (const score of result.buckets) {
      const total = totals.get(score.bucket)!;
      total.n += score.n;
      total.hits += score.hits;
      total.misses += score.misses;
      total.wrongLocation += score.wrongLocation;
      total.abstained += score.abstained;
      total.violations += score.violations;
    }
  }
  return BALL_BUCKET_ORDER.map((bucket) => totals.get(bucket)!);
}

// ── CLI ────────────────────────────────────────────────────────────────────
//
// Walks EVERY committed annotation file under datasets/paddle-bench/bundles,
// prints the full gold census per bucket, and scores the cases whose run
// dirs actually contain ball debug artifacts (via ball-bench.json runDir).
// Missing artifacts are reported as ARTIFACTS_ABSENT, never guessed:
// canonical run regeneration is macOS-only.

interface AnnotationFileWithBalls {
  bundleId: string;
  file: string;
  annotatorId: string;
  labels: BallFrameLabel[];
}

export function collectCommittedBallLabels(bundlesDir: string): AnnotationFileWithBalls[] {
  const found: AnnotationFileWithBalls[] = [];
  for (const bundleId of readdirSync(bundlesDir).sort()) {
    const annotationDir = join(bundlesDir, bundleId, "annotation");
    if (!existsSync(annotationDir)) continue;
    for (const name of readdirSync(annotationDir).sort()) {
      if (!name.endsWith(".json")) continue;
      const file = join(annotationDir, name);
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        annotatorId?: string;
        ballFrames?: BallFrameLabel[];
      };
      if (!parsed.ballFrames || parsed.ballFrames.length === 0) continue;
      found.push({
        bundleId,
        file,
        annotatorId: parsed.annotatorId ?? "unknown",
        labels: parsed.ballFrames,
      });
    }
  }
  return found;
}

const isMain = process.argv[1]?.endsWith("ballOcclusionBench.ts");
if (isMain) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const bundlesDir = join(repoRoot, "datasets/paddle-bench/bundles");
  const manifestPath = join(repoRoot, "datasets/ball-bench/ball-bench.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    provenance: string;
    cases: Array<{ id: string; labels: string; runDir: string; role?: string }>;
  };
  if (manifest.provenance === "synthetic") {
    console.error("ball-occlusion-bench refuses synthetic provenance.");
    process.exit(1);
  }
  const annotationFiles = collectCommittedBallLabels(bundlesDir);

  console.log("═".repeat(72));
  console.log("BALL OCCLUSION BENCH — committed gold census (ALL annotation files)");
  console.log("═".repeat(72));
  const censusResults = annotationFiles.map((entry) =>
    scoreBallOcclusionCase(`${entry.bundleId}/${entry.annotatorId}`, entry.labels, [], null),
  );
  for (const entry of annotationFiles) {
    const census = scoreBallOcclusionCase(entry.bundleId, entry.labels, [], null);
    const parts = census.buckets
      .filter((score) => score.n > 0)
      .map((score) => `${score.bucket} ${score.n}`)
      .join(" · ");
    console.log(
      `${entry.bundleId} [${entry.annotatorId}]: ${entry.labels.length} labels — ${parts}`,
    );
  }
  const census = aggregateBallOcclusionResults(censusResults);
  const totalLabels = census.reduce((total, score) => total + score.n, 0);
  console.log("─".repeat(72));
  console.log(`TOTAL committed gold ball labels: ${totalLabels}`);
  for (const score of census) {
    if (score.n > 0) console.log(`  ${score.bucket}: n=${score.n}`);
  }

  console.log("─".repeat(72));
  console.log("TRACKER OUTPUT SCORING (only where committed run artifacts exist):");
  const manifestDir = dirname(manifestPath);
  const scored: BallOcclusionCaseResult[] = [];
  const absent: string[] = [];
  for (const benchCase of manifest.cases) {
    const labelsPath = resolve(manifestDir, benchCase.labels);
    const debugPath = resolve(manifestDir, benchCase.runDir, "debug.json");
    if (!existsSync(labelsPath) || !existsSync(debugPath)) {
      absent.push(benchCase.id);
      continue;
    }
    const annotation = JSON.parse(readFileSync(labelsPath, "utf8")) as {
      ballFrames?: BallFrameLabel[];
    };
    const debug = JSON.parse(readFileSync(debugPath, "utf8")) as {
      ballTrack: { observations: BallPrediction[] } | null;
      ballTimeline?: BallTimeline | null;
    };
    const result = scoreBallOcclusionCase(
      benchCase.id,
      annotation.ballFrames ?? [],
      debug.ballTrack?.observations ?? [],
      debug.ballTimeline ?? null,
    );
    scored.push(result);
    for (const score of result.buckets) {
      if (score.n === 0) continue;
      const line =
        score.bucket === "OCCLUDED" || score.bucket === "NOT_VISIBLE"
          ? `abstained ${score.abstained}/${score.n} · VIOLATIONS ${score.violations}`
          : `hits ${score.hits}/${score.n} · miss ${score.misses} · wrongLoc ${score.wrongLocation}`;
      console.log(`  ${benchCase.id} ${score.bucket}: ${line}`);
    }
    for (const violation of result.violations) {
      console.log(`  ${benchCase.id} VIOLATION [${violation.kind}]: ${violation.detail}`);
    }
  }
  if (scored.length > 0) {
    console.log("  PER-BUCKET AGGREGATE (scored cases only):");
    for (const score of aggregateBallOcclusionResults(scored)) {
      if (score.n === 0) continue;
      const line =
        score.bucket === "OCCLUDED" || score.bucket === "NOT_VISIBLE"
          ? `abstained ${score.abstained}/${score.n} · VIOLATIONS ${score.violations}`
          : `hits ${score.hits}/${score.n} · miss ${score.misses} · wrongLoc ${score.wrongLocation}`;
      console.log(`    ${score.bucket}: ${line}`);
    }
  } else {
    console.log("  (no case scored — see ARTIFACTS_ABSENT below)");
  }
  if (absent.length > 0) {
    console.log(
      `  ARTIFACTS_ABSENT (${absent.length} cases; run dirs are gitignored / lack ball debug; ` +
        "regeneration is macOS-only via pnpm lab:regen): " +
        absent.join(", "),
    );
  }
  console.log("─".repeat(72));
  console.log(
    "Tracker LOGIC coverage on this platform lives in the replay/unit fixtures: " +
      "packages/swing-lab/test/ballOcclusionBench.test.ts",
  );
}
