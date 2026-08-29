// F17 — silent-failure-v1 + coverage/abstention/calibration RERUN on the
// integration branch AFTER all Wave E merges and the stroke-heuristic-4 gates
// (e03, commit 347625a), compared metric-by-metric against the frozen e07
// artifacts (datasets/experiments/wave-e/e07-*.json, computed at base 8fc388e
// BEFORE the Wave E merges landed).
//
// Reuses the e07 instruments unmodified (silentFailureRetro.ts /
// coverageRisk.ts exports); nothing under wave-e/ is rewritten — all rerun
// output lands under wave-f/.
//
// NEW HERE (rerun-only, no contract change): an e05-adjudication sensitivity
// view of the D2-04 ownership calibration. The frozen D2-04 sidecars score
// "correct" as agreement with the ORIGINAL waveC labels; Wave E merged e05's
// append-only correction sets that upheld some audit disagreements. The
// sensitivity view re-scores those upheld slots (audit was right) as correct
// and excludes-with-disclosure slots whose adjudication stayed unresolved or
// partial. The frozen v1 numbers are still reported unchanged.
//
// Run from packages/swing-lab (its tsx + deps):
//   cd packages/swing-lab && npx tsx ../../datasets/experiments/wave-f/f17-rerun.ts
//
// LINUX-CPU artifact-join only: no pipeline stage executed, no run dir
// touched, held-out cases (wm-dink-01, afn-vic-rally1) never parsed — the
// retro instrument filters to split === "development" before parsing.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  areaUnderRiskCoverage,
  calibrationReport,
  coverageRiskCurve,
  type ConfidenceSample,
} from "../../../packages/swing-lab/src/calibration.js";
import {
  loadD204OwnershipAuditDatasets,
  loadW14Datasets,
} from "../../../packages/swing-lab/src/coverageRisk.js";
import { evaluateCommittedRuns } from "../../../packages/swing-lab/src/silentFailureRetro.js";
import { SILENT_FAILURE_CLAIMS } from "../../../packages/swing-lab/src/silentFailure.js";

const REPO_ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");
const EXPERIMENTS = join(REPO_ROOT, "datasets/experiments");
const CASCADE_DIR = join(REPO_ROOT, "datasets/cascade");
const BUNDLES = join(REPO_ROOT, "datasets/paddle-bench/bundles");
const OUT_DIR = join(EXPERIMENTS, "wave-f");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// ---------------------------------------------------------------- retro rerun

interface E07RetroRun {
  file: string;
  developmentTrials: number;
  answeredTrials: number;
  silentFailureTrials: number;
  perClaim: Record<string, Record<string, number>>;
}
interface E07Retro {
  runs: E07RetroRun[];
}

// Empty-row cascade artifacts (e.g. the e06 Linux replay attempt) are skipped
// by evaluateCommittedRuns; count them explicitly so the rerun discloses them.
function countEmptyCascadeRuns(): string[] {
  const empties: string[] = [];
  for (const file of readdirSync(CASCADE_DIR).sort()) {
    if (!/^cascade-\d+\.json$/.test(file)) continue;
    const run = readJson<{ rows?: unknown[] }>(join(CASCADE_DIR, file));
    if ((run.rows ?? []).length === 0) empties.push(file);
  }
  return empties;
}

// ------------------------------------------------------- calibration deltas

interface E07CurveDataset {
  name: string;
  n: number;
  calibration: { ece: number | null };
  aurc: number;
}
interface E07Curves {
  datasets: E07CurveDataset[];
}

// ------------------------------------- e05 adjudication sensitivity (D2-04)

interface AuditFrame {
  audit?: { conf?: number };
  classAgreement?: boolean;
  adjudicationId?: string | null;
}
interface AuditFile {
  captureBundle: string;
  frames: AuditFrame[];
}
interface CorrectionsFile {
  captureBundle: string;
  corrections: Array<{ adjudicationId: string }>;
  noChangeDispositions: Array<{ adjudicationId: string; disposition: string }>;
}

interface SensitivityResult {
  bundle: string;
  n: number;
  upheldFlippedToCorrect: number;
  excludedUnresolvedOrPartial: number;
  samples: ConfidenceSample[];
}

function d204Sensitivity(): SensitivityResult[] {
  const results: SensitivityResult[] = [];
  for (const bundle of readdirSync(BUNDLES).sort()) {
    const auditPath = join(
      BUNDLES,
      bundle,
      "annotation/devin-visual-v4-waveD2-ownership-audit.json",
    );
    const corrPath = join(
      BUNDLES,
      bundle,
      "annotation/devin-visual-v4-waveE-ownership-corrections.json",
    );
    if (!existsSync(auditPath)) continue;
    const audit = readJson<AuditFile>(auditPath);
    const upheld = new Set<string>();
    const openDispositions = new Set<string>();
    if (existsSync(corrPath)) {
      const corr = readJson<CorrectionsFile>(corrPath);
      for (const record of corr.corrections) upheld.add(record.adjudicationId);
      for (const record of corr.noChangeDispositions) {
        if (
          record.disposition === "unresolved-classification" ||
          record.disposition === "partial-no-correction"
        ) {
          openDispositions.add(record.adjudicationId);
        }
      }
    }
    const samples: ConfidenceSample[] = [];
    let flipped = 0;
    let excluded = 0;
    for (const frame of audit.frames) {
      const confidence = frame.audit?.conf;
      if (confidence === undefined || frame.classAgreement === undefined) continue;
      const adjudicationId = frame.adjudicationId ?? null;
      if (adjudicationId !== null && openDispositions.has(adjudicationId)) {
        excluded += 1; // adjudication still open — excluded-with-disclosure
        continue;
      }
      let correct = frame.classAgreement;
      if (!correct && adjudicationId !== null && upheld.has(adjudicationId)) {
        correct = true; // e05 upheld the auditor: post-correction labels agree with the audit
        flipped += 1;
      }
      samples.push({ confidence, correct });
    }
    results.push({
      bundle: audit.captureBundle,
      n: samples.length,
      upheldFlippedToCorrect: flipped,
      excludedUnresolvedOrPartial: excluded,
      samples,
    });
  }
  return results;
}

// -------------------------------------------------------------------- main

const retroRuns = evaluateCommittedRuns();
const emptyRuns = countEmptyCascadeRuns();
const e07Retro = readJson<E07Retro>(join(EXPERIMENTS, "wave-e/e07-silent-failure-retro.json"));
const e07ByFile = new Map(e07Retro.runs.map((run) => [run.file, run]));

const retroComparison = retroRuns.map((run) => {
  const baseline = e07ByFile.get(run.file);
  return {
    file: run.file,
    developmentTrials: run.developmentTrials,
    answeredTrials: run.answeredTrials,
    silentFailureTrials: run.silentFailureTrials,
    perClaimSilentFailures: Object.fromEntries(
      SILENT_FAILURE_CLAIMS.map((claim) => [claim, run.perClaim[claim].silent_failure]),
    ),
    inE07: baseline !== undefined,
    deltaSilentFailureTrials:
      baseline === undefined ? null : run.silentFailureTrials - baseline.silentFailureTrials,
    deltaAnsweredTrials:
      baseline === undefined ? null : run.answeredTrials - baseline.answeredTrials,
  };
});

const curveDatasets = [...loadW14Datasets(), ...loadD204OwnershipAuditDatasets()];
const e07Curves = readJson<E07Curves>(join(EXPERIMENTS, "wave-e/e07-coverage-risk.json"));
const e07CurveByName = new Map(e07Curves.datasets.map((dataset) => [dataset.name, dataset]));

const curveComparison = curveDatasets.map((dataset) => {
  const calibration = calibrationReport(dataset.samples, { nBins: 10 });
  const aurc = areaUnderRiskCoverage(dataset.samples);
  const baseline = e07CurveByName.get(dataset.name);
  return {
    name: dataset.name,
    provenance: dataset.provenance,
    n: dataset.samples.length,
    nCorrect: dataset.samples.filter((sample) => sample.correct).length,
    ece10: calibration.ece,
    aurc,
    curve: coverageRiskCurve(dataset.samples),
    inE07: baseline !== undefined,
    deltaN: baseline === undefined ? null : dataset.samples.length - baseline.n,
    deltaEce10:
      baseline === undefined || baseline.calibration.ece === null || calibration.ece === null
        ? null
        : calibration.ece - baseline.calibration.ece,
    deltaAurc: baseline === undefined ? null : aurc - baseline.aurc,
  };
});

const sensitivity = d204Sensitivity();
const sensitivityPooledSamples = sensitivity.flatMap((entry) => entry.samples);
const sensitivityReport = {
  provenance:
    "SENSITIVITY VIEW, not a replacement: D2-04 audit slots re-scored against the post-e05 adjudicated labels (waveE-ownership-corrections sidecars). Upheld adjudications flip the auditor's disagreement to correct; unresolved/partial adjudications are excluded-with-disclosure. The frozen v1 proxy (agreement with original waveC labels) is reported unchanged above.",
  perBundle: sensitivity.map((entry) => ({
    bundle: entry.bundle,
    n: entry.n,
    upheldFlippedToCorrect: entry.upheldFlippedToCorrect,
    excludedUnresolvedOrPartial: entry.excludedUnresolvedOrPartial,
    nCorrect: entry.samples.filter((sample) => sample.correct).length,
    ece10: calibrationReport(entry.samples, { nBins: 10 }).ece,
    aurc: areaUnderRiskCoverage(entry.samples),
  })),
  pooled: {
    n: sensitivityPooledSamples.length,
    nCorrect: sensitivityPooledSamples.filter((sample) => sample.correct).length,
    upheldFlippedToCorrect: sensitivity.reduce(
      (sum, entry) => sum + entry.upheldFlippedToCorrect,
      0,
    ),
    excludedUnresolvedOrPartial: sensitivity.reduce(
      (sum, entry) => sum + entry.excludedUnresolvedOrPartial,
      0,
    ),
    ece10: calibrationReport(sensitivityPooledSamples, { nBins: 10 }).ece,
    aurc: areaUnderRiskCoverage(sensitivityPooledSamples),
    caveat: "pooled across 3 bundles — samples cluster by bundle/video, not i.i.d.",
  },
};

const report = {
  generatedAtIso: new Date().toISOString(),
  workstream: "f17-silent-failure-rerun",
  headDescription:
    "integration branch AFTER all Wave E merges + stroke-heuristic-4 gates (e03, 347625a); e07 baseline artifacts were computed at pre-Wave-E-merge base 8fc388e",
  retro: {
    contract:
      "silent-failure-v1.1 (unchanged; retrospective re-derivation, development split only)",
    runs: retroComparison,
    emptyRunsSkipped: emptyRuns,
    heldOut: "wm-dink-01 and afn-vic-rally1 excluded by split filter before any parsing",
  },
  coverageRisk: {
    caveat:
      "confidences are annotator self-reports; correctness is an inter-annotator agreement proxy, not gold; model-confidence curves require canonical run dirs, absent on this box",
    datasets: curveComparison,
  },
  d204PostAdjudicationSensitivity: sensitivityReport,
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, "f17-rerun-report.json");
writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log("═".repeat(78));
console.log("F17 retro silent-failure-v1.1 rerun vs e07 (development split only)");
console.log("  run file                          silentFail/answered  Δfail  Δanswered");
for (const run of retroComparison) {
  console.log(
    `  ${run.file.padEnd(34)} ${run.silentFailureTrials}/${run.answeredTrials} of ${run.developmentTrials} dev   ${String(run.deltaSilentFailureTrials ?? "NEW").padStart(4)} ${String(run.deltaAnsweredTrials ?? "NEW").padStart(9)}`,
  );
}
console.log(`  empty cascade artifacts skipped: ${emptyRuns.join(", ") || "none"}`);
console.log("═".repeat(78));
console.log("F17 coverage/risk rerun vs e07");
console.log(
  "  dataset                                            n    ECE10    AURC     ΔECE10   ΔAURC",
);
for (const dataset of curveComparison) {
  const ece = dataset.ece10 === null ? "REFUSED" : dataset.ece10.toFixed(4);
  const dEce =
    dataset.deltaEce10 === null ? (dataset.inE07 ? "n/a" : "NEW") : dataset.deltaEce10.toFixed(4);
  const dAurc =
    dataset.deltaAurc === null ? (dataset.inE07 ? "n/a" : "NEW") : dataset.deltaAurc.toFixed(4);
  console.log(
    `  ${dataset.name.padEnd(50)} ${String(dataset.n).padStart(3)} ${ece.padStart(8)} ${dataset.aurc.toFixed(4).padStart(8)} ${dEce.padStart(8)} ${dAurc.padStart(8)}`,
  );
}
console.log("═".repeat(78));
console.log("D2-04 post-e05-adjudication sensitivity (correctness vs corrected labels)");
for (const entry of sensitivityReport.perBundle) {
  const ece = entry.ece10 === null ? "REFUSED" : entry.ece10.toFixed(4);
  console.log(
    `  ${entry.bundle.padEnd(24)} n=${entry.n} correct=${entry.nCorrect} flipped=${entry.upheldFlippedToCorrect} excluded=${entry.excludedUnresolvedOrPartial} ECE10=${ece} AURC=${entry.aurc.toFixed(4)}`,
  );
}
const pooled = sensitivityReport.pooled;
console.log(
  `  POOLED                   n=${pooled.n} correct=${pooled.nCorrect} flipped=${pooled.upheldFlippedToCorrect} excluded=${pooled.excludedUnresolvedOrPartial} ECE10=${pooled.ece10 === null ? "REFUSED" : pooled.ece10.toFixed(4)} AURC=${pooled.aurc.toFixed(4)}`,
);
console.log(`written: ${outPath.replace(`${REPO_ROOT}/`, "")}`);
