import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BallFrameLabel } from "./annotationSchema.js";

/**
 * REAL ball benchmark scoring + contact-timing evaluation.
 *
 * Ball labels: human center points with visible / occluded / not_visible /
 * uncertain states. `uncertain` frames are EXCLUDED from precision/recall.
 * Contact labels carry annotator uncertainty; timing error is reported in
 * frames and milliseconds. Sample sizes print first.
 */

export const BALL_HIT_RADIUS = 0.05; // normalized ≈ 2–3 ball diameters
export const BALL_MATCH_TOLERANCE_MS = 40;

export interface BallPrediction {
  t: number;
  x: number;
  y: number;
  conf: number;
}

export interface BallBenchCaseResult {
  caseId: string;
  labeledFrames: number;
  visibleFrames: number;
  uncertainExcluded: number;
  hits: number;
  misses: number;
  wrongLocation: number;
  falsePositives: number;
  correctRejections: number;
  precision: number | null;
  recall: number | null;
  meanCenterErrorNorm: number | null;
  medianCenterErrorNorm: number | null;
  medianCenterErrorPx: number | null;
}

export function scoreBallCase(
  caseId: string,
  labels: readonly BallFrameLabel[],
  predictions: readonly BallPrediction[],
  videoWidthPx: number,
): BallBenchCaseResult {
  let hits = 0;
  let misses = 0;
  let wrongLocation = 0;
  let falsePositives = 0;
  let correctRejections = 0;
  let uncertainExcluded = 0;
  let visibleFrames = 0;
  const errors: number[] = [];

  for (const label of labels) {
    const prediction = nearestBallPrediction(predictions, label.tMs);
    if (label.visibility === "uncertain") {
      uncertainExcluded += 1;
      continue;
    }
    if (label.visibility === "visible") {
      visibleFrames += 1;
      if (!prediction) {
        misses += 1;
        continue;
      }
      const error = Math.hypot(prediction.x - label.point!.x, prediction.y - label.point!.y);
      if (error <= BALL_HIT_RADIUS) {
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
  const median = errors.length > 0 ? errors[Math.floor(errors.length / 2)]! : null;
  return {
    caseId,
    labeledFrames: labels.length,
    visibleFrames,
    uncertainExcluded,
    hits,
    misses,
    wrongLocation,
    falsePositives,
    correctRejections,
    precision: claimed > 0 ? hits / claimed : null,
    recall: visibleFrames > 0 ? hits / visibleFrames : null,
    meanCenterErrorNorm:
      errors.length > 0 ? errors.reduce((total, value) => total + value, 0) / errors.length : null,
    medianCenterErrorNorm: median,
    medianCenterErrorPx: median !== null ? median * videoWidthPx : null,
  };
}

export interface ContactBenchResult {
  caseId: string;
  labelMs: number;
  labelUncertainty: string;
  estimatedMs: number | null;
  absErrorMs: number | null;
  absErrorFrames: number | null;
  ballConfirmed: boolean | null;
  paddleConfirmed: boolean | null;
}

export function scoreContactCase(
  caseId: string,
  labelMs: number,
  labelUncertainty: string,
  fps: number,
  contact: { tMs: number; ballConfirmed: boolean; paddleConfirmed: boolean } | null,
): ContactBenchResult {
  return {
    caseId,
    labelMs,
    labelUncertainty,
    estimatedMs: contact?.tMs ?? null,
    absErrorMs: contact ? Math.abs(contact.tMs - labelMs) : null,
    absErrorFrames: contact ? Math.abs(contact.tMs - labelMs) / (1000 / fps) : null,
    ballConfirmed: contact?.ballConfirmed ?? null,
    paddleConfirmed: contact?.paddleConfirmed ?? null,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith("ballBench.ts");
if (isMain) {
  const manifestPath = resolve(
    process.argv[2] ??
      join(dirname(fileURLToPath(import.meta.url)), "../../../datasets/ball-bench/ball-bench.json"),
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    provenance: string;
    coverageGaps?: string[];
    cases: Array<{
      id: string;
      video: string;
      fps: number;
      resolution: string;
      labels: string;
      runDir: string;
      sourceKey?: string;
      sessionKey?: string;
    }>;
  };
  const baseDir = dirname(manifestPath);
  if (manifest.provenance === "synthetic") {
    console.error("ball-bench refuses synthetic provenance.");
    process.exit(1);
  }
  const results: BallBenchCaseResult[] = [];
  const contacts: ContactBenchResult[] = [];
  const ablations: Array<{ caseId: string; ablation: Record<string, number> }> = [];
  const reacquisitions: Array<{ caseId: string; states: string; reacquisition: string }> = [];
  const annotators = new Set<string>();

  for (const benchCase of manifest.cases) {
    const labelsPath = resolve(baseDir, benchCase.labels);
    const debugPath = resolve(baseDir, benchCase.runDir, "debug.json");
    const reportPath = resolve(baseDir, benchCase.runDir, "report.json");
    if (!existsSync(labelsPath) || !existsSync(debugPath)) {
      console.error(`case ${benchCase.id}: missing artifacts; run lab:analyze first`);
      continue;
    }
    const annotation = JSON.parse(readFileSync(labelsPath, "utf8")) as {
      annotatorId?: string;
      ballFrames?: BallFrameLabel[];
      phases?: { contactMs?: number | null };
      contactUncertainty?: string | null;
    };
    if (annotation.annotatorId) annotators.add(annotation.annotatorId);
    const debug = JSON.parse(readFileSync(debugPath, "utf8")) as {
      ballTrack: { observations: BallPrediction[] } | null;
      contactInfo: { tMs: number; ballConfirmed: boolean; paddleConfirmed: boolean } | null;
    };
    const widthPx = Number(benchCase.resolution.split("x")[0] ?? 1000);
    results.push(
      scoreBallCase(
        benchCase.id,
        annotation.ballFrames ?? [],
        debug.ballTrack?.observations ?? [],
        widthPx,
      ),
    );
    if (annotation.phases?.contactMs != null) {
      contacts.push(
        scoreContactCase(
          benchCase.id,
          annotation.phases.contactMs,
          annotation.contactUncertainty ?? "unspecified",
          benchCase.fps,
          debug.contactInfo,
        ),
      );
    }
    if (existsSync(reportPath)) {
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        ballStage?: {
          ablation?: Record<string, number>;
          timeline?: { states: string[]; reacquisition: string };
        };
      };
      if (report.ballStage?.ablation) {
        ablations.push({ caseId: benchCase.id, ablation: report.ballStage.ablation });
      }
      if (report.ballStage?.timeline) {
        reacquisitions.push({
          caseId: benchCase.id,
          states: report.ballStage.timeline.states.join(" → "),
          reacquisition: report.ballStage.timeline.reacquisition,
        });
      }
    }
  }

  const totalLabeled = results.reduce((total, result) => total + result.labeledFrames, 0);
  console.log("═".repeat(66));
  console.log(`REAL BALL BENCHMARK [provenance: ${manifest.provenance}]`);
  console.log(
    `videos: ${results.length} · annotated frames: ${totalLabeled} · annotators: ${annotators.size}`,
  );
  console.log("SAMPLE SIZE WARNING: metrics below are only as strong as these counts.");
  console.log("═".repeat(66));
  for (const result of results) {
    console.log(
      `${result.caseId}: labeled ${result.labeledFrames} (visible ${result.visibleFrames}, ` +
        `uncertain-excluded ${result.uncertainExcluded}) · hits ${result.hits} · miss ${result.misses} · ` +
        `wrongLoc ${result.wrongLocation} · FP ${result.falsePositives} · ` +
        `P ${fmt(result.precision)} · R ${fmt(result.recall)} · ` +
        `median err ${fmt(result.medianCenterErrorNorm, 3)} (${fmt(result.medianCenterErrorPx, 0)}px)`,
    );
  }
  console.log("─".repeat(66));
  console.log("TEMPORAL ABLATION (per case):");
  for (const { caseId, ablation } of ablations) {
    console.log(
      `${caseId}: raw ${Number(ablation["stageA_rawCandidatesPerSec"]).toFixed(0)}/s → ` +
        `associated ${ablation["stageB_tracks"]} tracks (${Number(ablation["stageB_trackedObsPerSec"]).toFixed(0)} obs/s) → ` +
        `gated ${ablation["stageC_tracks"]} tracks (${Number(ablation["stageC_trackedObsPerSec"]).toFixed(0)} obs/s)`,
    );
  }
  console.log("─".repeat(66));
  console.log("OCCLUSION / REACQUISITION (per case):");
  for (const entry of reacquisitions) {
    console.log(`${entry.caseId}: ${entry.states}`);
    console.log(`  ${entry.reacquisition}`);
  }
  console.log("─".repeat(66));
  console.log("CONTACT TIMING (vs human label):");
  for (const contact of contacts) {
    console.log(
      `${contact.caseId}: label ${contact.labelMs}ms (${contact.labelUncertainty}) · ` +
        (contact.estimatedMs !== null
          ? `estimate ${contact.estimatedMs}ms · |err| ${contact.absErrorMs}ms = ${contact.absErrorFrames?.toFixed(1)} frames · ` +
            `ball ${contact.ballConfirmed ? "✓" : "✗"} paddle ${contact.paddleConfirmed ? "✓" : "✗"}`
          : "ABSTAINED"),
    );
  }
  const withEstimate = contacts.filter((contact) => contact.absErrorFrames !== null);
  if (contacts.length > 0) {
    const within1 = withEstimate.filter((contact) => contact.absErrorFrames! <= 1).length;
    const within2 = withEstimate.filter((contact) => contact.absErrorFrames! <= 2).length;
    const errors = withEstimate.map((contact) => contact.absErrorMs!).sort((a, b) => a - b);
    const median = errors.length > 0 ? errors[Math.floor(errors.length / 2)]! : null;
    console.log(
      `contact summary: n=${contacts.length} · abstained ${contacts.length - withEstimate.length} · ` +
        `median |err| ${median ?? "n/a"}ms · within 1 frame ${within1}/${withEstimate.length} · ` +
        `within 2 frames ${within2}/${withEstimate.length}`,
    );
    // Confidence classes are NOT equivalent; report them separately.
    const byClass = new Map<string, ContactBenchResult[]>();
    for (const contact of withEstimate) {
      const key = contact.ballConfirmed && contact.paddleConfirmed
        ? "BALL+PADDLE"
        : contact.paddleConfirmed
          ? "PADDLE ONLY"
          : contact.ballConfirmed
            ? "BALL ONLY"
            : "MOTION ONLY";
      byClass.set(key, [...(byClass.get(key) ?? []), contact]);
    }
    for (const [klass, classContacts] of byClass) {
      const classErrors = classContacts.map((c) => c.absErrorMs!).sort((a, b) => a - b);
      console.log(
        `  ${klass}: n=${classContacts.length} · median |err| ${classErrors[Math.floor(classErrors.length / 2)]}ms`,
      );
    }
  }
  const sources = new Map<string, BallBenchCaseResult[]>();
  for (const [index, benchCase] of manifest.cases.entries()) {
    const result = results[index];
    if (!result) continue;
    const key = benchCase.sourceKey ?? "unspecified";
    sources.set(key, [...(sources.get(key) ?? []), result]);
  }
  console.log("─".repeat(66));
  console.log("BY SOURCE RECORDING:");
  for (const [source, sourceResults] of sources) {
    const h = sourceResults.reduce((total, result) => total + result.hits, 0);
    const c = sourceResults.reduce(
      (total, result) => total + result.hits + result.wrongLocation + result.falsePositives,
      0,
    );
    const v = sourceResults.reduce((total, result) => total + result.visibleFrames, 0);
    console.log(
      `  ${source}: cases ${sourceResults.length} · P ${fmt(c > 0 ? h / c : null)} · R ${fmt(v > 0 ? h / v : null)} (${v} visible frames)`,
    );
  }
  if (sources.size === 1) {
    console.log("  WARNING: single-source benchmark — results may not generalize.");
  }
  for (const gap of manifest.coverageGaps ?? []) {
    console.log(`  coverage gap: ${gap}`);
  }
  const outDir = join(baseDir, "results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `ball-bench-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify({ manifest: manifestPath, results, contacts, ablations }, null, 2));
  console.log(`written: ${outPath}`);
}

function nearestBallPrediction(
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

function fmt(value: number | null, digits = 2): string {
  return value === null ? "n/a" : value.toFixed(digits);
}
