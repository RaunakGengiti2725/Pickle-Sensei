import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Measurement } from "@pickle/shared-types";
import { scoreShot, getShotScoringConfig, bandFor } from "@pickle/scoring";
import type { ShotTypeSlug } from "@pickle/shared-types";
import { REPO_ROOT } from "./engine/corpus.js";
import { HELD_OUT_CASE_IDS } from "./coachGates.js";

/**
 * SCORE STABILITY PROBE — formula-level diagnostic for gate S6
 * (coach-gates-frozen-v1). Run: pnpm lab:score-stability
 *
 * WHAT THIS IS: the sm-v1 score formula (packages/scoring) replayed on real,
 * non-held-out measurement data with MODELED measurement-space perturbations
 * approximating what compression / crop / brightness / camera motion /
 * frame-rate changes do to pose-derived measurements. Deterministic (seeded).
 *
 * WHAT THIS IS NOT: video-level evidence. Real S6 evidence requires
 * re-encoding the same physical stroke video and re-running the full
 * pipeline (pose extraction is Mac/Apple-Vision-gated). This probe satisfies
 * NO gate; instability found here is honest evidence of formula fragility,
 * and stability here proves nothing about the pipeline.
 */

/** xorshift32 — deterministic, reproducible trials. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

interface PerturbationModel {
  id: string;
  video: string;
  /** How the video perturbation is modeled in measurement space. */
  model: string;
  valueNoiseFrac: number;
  confidenceDropFrac: number;
}

/** Measurement-space models of the S6 video perturbations. Magnitudes are
 * engineering estimates, stated as such; they are NOT measured transfer
 * functions (measuring them is exactly the Mac-gated work S6 demands). */
export const PERTURBATION_MODELS: PerturbationModel[] = [
  {
    id: "compression",
    video: "re-encode CRF 23→35",
    model: "pose jitter from block artifacts: ±2% value noise, −10% confidence",
    valueNoiseFrac: 0.02,
    confidenceDropFrac: 0.1,
  },
  {
    id: "crop",
    video: "center crop up to 10%",
    model: "normalization-frame shift: ±5% value noise on ratio/normalized metrics, −5% confidence",
    valueNoiseFrac: 0.05,
    confidenceDropFrac: 0.05,
  },
  {
    id: "brightness",
    video: "brightness ±20%",
    model: "detector confidence loss dominates: ±1% value noise, −15% confidence",
    valueNoiseFrac: 0.01,
    confidenceDropFrac: 0.15,
  },
  {
    id: "camera_motion",
    video: "synthetic shake within capture envelope",
    model: "frame-to-frame keypoint jitter: ±4% value noise, −10% confidence",
    valueNoiseFrac: 0.04,
    confidenceDropFrac: 0.1,
  },
  {
    id: "frame_rate",
    video: "60→30fps downsample",
    model: "temporal metrics coarsen: ±3% value noise, −8% confidence",
    valueNoiseFrac: 0.03,
    confidenceDropFrac: 0.08,
  },
];

export interface StabilityTrialSummary {
  perturbationId: string;
  trials: number;
  scoredTrials: number;
  abstainedTrials: number;
  baselineScore: number | null;
  medianAbsDelta: number | null;
  p95AbsDelta: number | null;
  maxAbsDelta: number | null;
  bandFlipRate: number | null;
  abstentionFlipRate: number;
}

export function perturbMeasurements(
  measurements: Measurement[],
  model: PerturbationModel,
  rng: () => number,
): Measurement[] {
  return measurements.map((m) => {
    const noise = (rng() * 2 - 1) * model.valueNoiseFrac;
    const confScale = 1 - rng() * model.confidenceDropFrac;
    return {
      ...m,
      value: m.value * (1 + noise),
      confidence: Math.max(0, Math.min(1, m.confidence * confScale)),
    };
  });
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[index] ?? null;
}

export function runStabilityProbe(
  shotType: ShotTypeSlug,
  measurements: Measurement[],
  trialsPerPerturbation = 200,
): {
  baseline: { score: number | null; confidence: number; presentation: string };
  summaries: StabilityTrialSummary[];
} {
  const config = getShotScoringConfig(shotType);
  const baseline = scoreShot(config, measurements);
  const baselineBand = bandFor(baseline.overallScore === null ? null : baseline.overallScore * 10);
  const baselineAbstained = baseline.presentation === "abstain";

  const summaries: StabilityTrialSummary[] = [];
  for (const [index, model] of PERTURBATION_MODELS.entries()) {
    const rng = makeRng(0xc0ac4 + index * 7919);
    const deltas: number[] = [];
    let bandFlips = 0;
    let abstentionFlips = 0;
    let scoredTrials = 0;
    let abstainedTrials = 0;
    for (let t = 0; t < trialsPerPerturbation; t++) {
      const outcome = scoreShot(config, perturbMeasurements(measurements, model, rng));
      const abstained = outcome.presentation === "abstain";
      if (abstained) abstainedTrials += 1;
      if (abstained !== baselineAbstained) abstentionFlips += 1;
      if (!abstained && baseline.overallScore !== null && outcome.overallScore !== null) {
        scoredTrials += 1;
        deltas.push(Math.abs(outcome.overallScore - baseline.overallScore));
        if (bandFor(outcome.overallScore * 10) !== baselineBand) bandFlips += 1;
      }
    }
    deltas.sort((a, b) => a - b);
    summaries.push({
      perturbationId: model.id,
      trials: trialsPerPerturbation,
      scoredTrials,
      abstainedTrials,
      baselineScore: baseline.overallScore,
      medianAbsDelta: quantile(deltas, 0.5),
      p95AbsDelta: quantile(deltas, 0.95),
      maxAbsDelta: deltas.length > 0 ? deltas[deltas.length - 1]! : null,
      bandFlipRate: scoredTrials > 0 ? bandFlips / scoredTrials : null,
      abstentionFlipRate: abstentionFlips / trialsPerPerturbation,
    });
  }

  return {
    baseline: {
      score: baseline.overallScore,
      confidence: baseline.analysisConfidence,
      presentation: baseline.presentation,
    },
    summaries,
  };
}

/** The only real (non-synthetic) replayable measurement set in the repo:
 * a full pipeline run over case afn-sasebo-rally1 (non-held-out). */
const REAL_MEASUREMENT_SOURCES: Array<{ caseId: string; report: string; resultPath: string[] }> = [
  {
    caseId: "afn-sasebo-rally1",
    report:
      "datasets/ball-bench/failures/PADDLE_WRONG_RACKET_LIKE_OBJECT-afn-sasebo-rally1/report.json",
    resultPath: ["outcome", "record", "result"],
  },
];

const isMain = process.argv[1]?.endsWith("scoreStability.ts");
if (isMain) {
  const runs: object[] = [];
  for (const source of REAL_MEASUREMENT_SOURCES) {
    if ((HELD_OUT_CASE_IDS as readonly string[]).includes(source.caseId)) {
      throw new Error(`held-out case ${source.caseId} must never enter this probe`);
    }
    let node: unknown = JSON.parse(readFileSync(join(REPO_ROOT, source.report), "utf8"));
    for (const key of source.resultPath) node = (node as Record<string, unknown>)[key];
    const result = node as {
      shotType: ShotTypeSlug;
      measurements: Measurement[];
      analysisConfidence: number;
    };
    const probe = runStabilityProbe(result.shotType, result.measurements);
    runs.push({
      caseId: source.caseId,
      report: source.report,
      shotType: result.shotType,
      variant: "as-recorded (real pipeline confidences)",
      measurementCount: result.measurements.length,
      ...probe,
    });

    // The as-recorded run abstains at baseline (real confidence 0.59 is below
    // the abstention floor), which is itself evidence the abstention gate
    // works — but it never exercises the scored regime of the formula. Probe
    // that regime with a SYNTHETIC variant: real measurement VALUES, all
    // confidences raised to 0.95. Labeled synthetic; satisfies nothing.
    const confidenceRaised = result.measurements.map((m) => ({ ...m, confidence: 0.95 }));
    const raisedProbe = runStabilityProbe(result.shotType, confidenceRaised);
    runs.push({
      caseId: source.caseId,
      report: source.report,
      shotType: result.shotType,
      variant:
        "SYNTHETIC confidence-raised (real values, confidences forced to 0.95) — probes the scored regime of the formula only",
      measurementCount: confidenceRaised.length,
      ...raisedProbe,
    });
  }

  const out = {
    probeId: "h04-score-stability-formula-probe-v1",
    generatedAtIso: new Date().toISOString(),
    honesty: {
      evidenceClass:
        "FORMULA-LEVEL DIAGNOSTIC ONLY — modeled measurement-space perturbations over the sm-v1 formula; satisfies NO video-level gate (coach-gates-frozen-v1 S6 requires real re-encodes through the full Mac-gated pipeline)",
      dataProvenance:
        "real pipeline measurements from the single replayable non-held-out run in-repo (afn-sasebo-rally1); held-out cases wm-dink-01 and afn-vic-rally1 excluded by construction",
      perturbationProvenance:
        "measurement-space noise/confidence models are engineering estimates, not measured transfer functions",
    },
    s6ThresholdsForReference: {
      maxMedianAbsDelta: 0.5,
      maxP95AbsDelta: 1.0,
      maxBandFlipRate: 0.05,
      maxAbstentionFlipRate: 0.05,
    },
    runs,
  };
  const outDir = join(REPO_ROOT, "datasets/experiments/wave-g2");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "h04-score-stability-report.json");
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
  console.log(`→ ${outPath}`);
}
