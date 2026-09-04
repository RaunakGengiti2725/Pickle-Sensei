import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PaddleFrameLabel } from "./annotationSchema.js";
import {
  benchExcludedCaseIds,
  HOLDOUT_LEDGER_PATH,
  loadHoldoutLedger,
  type HoldoutLedger,
} from "./holdoutRotation.js";

/**
 * REAL paddle benchmark scoring: human center-point labels vs the tracker's
 * observations. Point-based ground truth supports detection rate and center
 * error (no IoU without boxes — not claimed). Sample sizes print first;
 * a tiny benchmark must look tiny.
 */

export const PADDLE_HIT_RADIUS = 0.08; // normalized units ≈ paddle diameter
export const MATCH_TOLERANCE_MS = 40;

export interface PaddlePrediction {
  t: number;
  x: number; // box top-left
  y: number;
  w: number;
  h: number;
  conf: number;
}

export interface PaddleBenchCaseResult {
  caseId: string;
  labeledFrames: number;
  visibleFrames: number;
  occludedOrAbsentFrames: number;
  hits: number;
  misses: number;
  wrongLocation: number;
  falsePositives: number;
  correctRejections: number;
  precision: number | null;
  recall: number | null;
  meanCenterErrorNorm: number | null;
  medianCenterErrorNorm: number | null;
}

export function scorePaddleCase(
  caseId: string,
  labels: readonly PaddleFrameLabel[],
  predictions: readonly PaddlePrediction[],
): PaddleBenchCaseResult {
  let hits = 0;
  let misses = 0;
  let wrongLocation = 0;
  let falsePositives = 0;
  let correctRejections = 0;
  const errors: number[] = [];
  let visibleFrames = 0;

  for (const label of labels) {
    const prediction = nearestPrediction(predictions, label.tMs);
    if (label.visibility === "visible") {
      visibleFrames += 1;
      if (!prediction) {
        misses += 1;
        continue;
      }
      const error = Math.hypot(
        prediction.x + prediction.w / 2 - label.point!.x,
        prediction.y + prediction.h / 2 - label.point!.y,
      );
      if (error <= PADDLE_HIT_RADIUS) {
        hits += 1;
        errors.push(error);
      } else {
        wrongLocation += 1;
      }
    } else if (prediction) {
      falsePositives += 1;
    } else {
      correctRejections += 1;
    }
  }

  const claimed = hits + wrongLocation + falsePositives;
  errors.sort((a, b) => a - b);
  return {
    caseId,
    labeledFrames: labels.length,
    visibleFrames,
    occludedOrAbsentFrames: labels.length - visibleFrames,
    hits,
    misses,
    wrongLocation,
    falsePositives,
    correctRejections,
    precision: claimed > 0 ? hits / claimed : null,
    recall: visibleFrames > 0 ? hits / visibleFrames : null,
    meanCenterErrorNorm:
      errors.length > 0 ? errors.reduce((total, value) => total + value, 0) / errors.length : null,
    medianCenterErrorNorm: errors.length > 0 ? errors[Math.floor(errors.length / 2)]! : null,
  };
}

function nearestPrediction(
  predictions: readonly PaddlePrediction[],
  tMs: number,
): PaddlePrediction | null {
  let best: PaddlePrediction | null = null;
  let bestDelta = Infinity;
  for (const prediction of predictions) {
    const delta = Math.abs(prediction.t - tMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = prediction;
    }
  }
  return best && bestDelta <= MATCH_TOLERANCE_MS ? best : null;
}

// ── CLI ────────────────────────────────────────────────────────────────────

export interface BenchManifest {
  schemaVersion: 1;
  provenance: string;
  coverageGaps?: string[];
  cases: Array<{
    id: string;
    video: string;
    labels: string; // annotation JSON with paddleFrames
    runDir: string; // lab:analyze output dir containing debug.json
    sourceKey?: string;
    sessionKey?: string;
  }>;
}

/**
 * Manifest cases the holdout ledger forbids scoring: designated SHADOW_HOLDOUT
 * successors (and any zero-budget ACTIVE holdout). Returns one message per
 * offending case, naming the case and the ledger; empty when the manifest is
 * clean. The CLI refuses the whole manifest on any hit — a successor scored
 * once as a dev case is contaminated for good.
 */
export function ledgerExclusionViolations(
  manifest: Pick<BenchManifest, "cases">,
  ledger: HoldoutLedger,
): string[] {
  const excluded = new Set(benchExcludedCaseIds(ledger));
  const successors = new Set(ledger.successors.map((designated) => designated.caseId));
  const violations: string[] = [];
  for (const benchCase of manifest.cases) {
    if (!excluded.has(benchCase.id)) continue;
    const role = successors.has(benchCase.id)
      ? "a designated SHADOW_HOLDOUT successor"
      : "a zero-budget ACTIVE holdout";
    violations.push(
      `case ${benchCase.id} is ${role} in ${HOLDOUT_LEDGER_PATH} — inspection budget 0, it must not be scored by paddle-bench`,
    );
  }
  return violations;
}

const isMain = process.argv[1]?.endsWith("paddleBench.ts");
if (isMain) {
  const manifestPath = resolve(
    process.argv[2] ??
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../datasets/paddle-bench/paddle-bench.json",
      ),
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BenchManifest;
  const baseDir = dirname(manifestPath);
  if (manifest.provenance === "synthetic") {
    console.error("paddle-bench refuses synthetic provenance; this benchmark is for REAL footage.");
    process.exit(1);
  }
  const exclusionViolations = ledgerExclusionViolations(manifest, loadHoldoutLedger());
  if (exclusionViolations.length > 0) {
    console.error(
      `paddle-bench refuses ${manifestPath}: ${exclusionViolations.length} case(s) are excluded by ${HOLDOUT_LEDGER_PATH}`,
    );
    for (const violation of exclusionViolations) console.error(`  ${violation}`);
    process.exit(1);
  }
  const results: PaddleBenchCaseResult[] = [];
  const annotators = new Set<string>();
  let wrongPlayerChecks = 0;
  let wrongPlayerSelections = 0;
  const sourceOf = new Map<string, string>();
  for (const benchCase of manifest.cases) {
    sourceOf.set(benchCase.id, benchCase.sourceKey ?? "unspecified");
  }
  for (const benchCase of manifest.cases) {
    const labelsPath = resolve(baseDir, benchCase.labels);
    const debugPath = resolve(baseDir, benchCase.runDir, "debug.json");
    if (!existsSync(labelsPath) || !existsSync(debugPath)) {
      console.error(
        `case ${benchCase.id}: missing ${!existsSync(labelsPath) ? labelsPath : debugPath}`,
      );
      continue;
    }
    const annotation = JSON.parse(readFileSync(labelsPath, "utf8")) as {
      annotatorId?: string;
      paddleFrames?: PaddleFrameLabel[];
      otherPaddleFrames?: PaddleFrameLabel[];
    };
    if (annotation.annotatorId) annotators.add(annotation.annotatorId);
    const debug = JSON.parse(readFileSync(debugPath, "utf8")) as {
      paddle: { observations: PaddlePrediction[] } | null;
    };
    results.push(
      scorePaddleCase(
        benchCase.id,
        annotation.paddleFrames ?? [],
        debug.paddle?.observations ?? [],
      ),
    );
    // Wrong-player check: on frames where BOTH target and other paddle are
    // labeled visible, is the prediction closer to the other player's paddle?
    for (const other of annotation.otherPaddleFrames ?? []) {
      if (other.visibility !== "visible") continue;
      const target = (annotation.paddleFrames ?? []).find(
        (frame) => Math.abs(frame.tMs - other.tMs) < 20 && frame.visibility === "visible",
      );
      if (!target) continue;
      wrongPlayerChecks += 1;
      const prediction = (debug.paddle?.observations ?? [])
        .filter((observation) => Math.abs(observation.t - other.tMs) <= MATCH_TOLERANCE_MS)
        .sort((a, b) => Math.abs(a.t - other.tMs) - Math.abs(b.t - other.tMs))[0];
      if (!prediction) continue;
      const dTarget = Math.hypot(
        prediction.x + prediction.w / 2 - target.point!.x,
        prediction.y + prediction.h / 2 - target.point!.y,
      );
      const dOther = Math.hypot(
        prediction.x + prediction.w / 2 - other.point!.x,
        prediction.y + prediction.h / 2 - other.point!.y,
      );
      if (dOther < dTarget) wrongPlayerSelections += 1;
    }
  }

  const totals = results.reduce(
    (accumulator, result) => ({
      labeled: accumulator.labeled + result.labeledFrames,
      visible: accumulator.visible + result.visibleFrames,
      hits: accumulator.hits + result.hits,
      misses: accumulator.misses + result.misses,
      wrong: accumulator.wrong + result.wrongLocation,
      fps: accumulator.fps + result.falsePositives,
    }),
    { labeled: 0, visible: 0, hits: 0, misses: 0, wrong: 0, fps: 0 },
  );
  const claimed = totals.hits + totals.wrong + totals.fps;

  console.log("═".repeat(64));
  console.log(`REAL PADDLE BENCHMARK [provenance: ${manifest.provenance}]`);
  console.log(
    `videos: ${results.length} · annotated frames: ${totals.labeled} · annotators: ${annotators.size}`,
  );
  console.log("SAMPLE SIZE WARNING: metrics below are only as strong as these counts.");
  console.log("═".repeat(64));
  for (const result of results) {
    console.log(
      `${result.caseId}: labeled ${result.labeledFrames} (visible ${result.visibleFrames}) · ` +
        `hits ${result.hits} · miss ${result.misses} · wrongLoc ${result.wrongLocation} · ` +
        `FP ${result.falsePositives} · P ${fmt(result.precision)} · R ${fmt(result.recall)} · ` +
        `median err ${fmt(result.medianCenterErrorNorm, 3)}`,
    );
  }
  console.log("─".repeat(64));
  // Per-source breakdown: a strong aggregate hiding one failed source is
  // unacceptable; single-source results must announce themselves.
  const sources = new Map<string, PaddleBenchCaseResult[]>();
  for (const result of results) {
    const key = sourceOf.get(result.caseId) ?? "unspecified";
    sources.set(key, [...(sources.get(key) ?? []), result]);
  }
  console.log("BY SOURCE RECORDING:");
  for (const [source, sourceResults] of sources) {
    const h = sourceResults.reduce((total, result) => total + result.hits, 0);
    const c = sourceResults.reduce(
      (total, result) => total + result.hits + result.wrongLocation + result.falsePositives,
      0,
    );
    const v = sourceResults.reduce((total, result) => total + result.visibleFrames, 0);
    console.log(
      `  ${source}: cases ${sourceResults.length} · P ${fmt(c > 0 ? h / c : null)} · R ${fmt(v > 0 ? h / v : null)} ` +
        `(${v} visible frames)`,
    );
  }
  if (sources.size === 1) {
    console.log("  WARNING: single-source benchmark — results may not generalize.");
  }
  console.log("─".repeat(64));
  console.log(
    `AGGREGATE: precision ${fmt(claimed > 0 ? totals.hits / claimed : null)} · ` +
      `recall ${fmt(totals.visible > 0 ? totals.hits / totals.visible : null)} ` +
      `(hit radius ${PADDLE_HIT_RADIUS} normalized, match tolerance ±${MATCH_TOLERANCE_MS}ms)`,
  );
  console.log(
    `WRONG-PLAYER PADDLE: ${wrongPlayerSelections}/${wrongPlayerChecks} dual-labeled frames chose the other player's paddle` +
      (wrongPlayerChecks === 0 ? " (no dual-labeled frames yet)" : ""),
  );
  for (const gap of manifest.coverageGaps ?? []) {
    console.log(`  coverage gap: ${gap}`);
  }
  const outPath = join(baseDir, "results", `paddle-bench-${Date.now()}.json`);
  try {
    writeFileSync(outPath, JSON.stringify({ manifest: manifestPath, results }, null, 2));
    console.log(`written: ${outPath}`);
  } catch {
    // results dir may not exist yet; the printed report is the artifact
  }
}

function fmt(value: number | null, digits = 2): string {
  return value === null ? "n/a" : value.toFixed(digits);
}
