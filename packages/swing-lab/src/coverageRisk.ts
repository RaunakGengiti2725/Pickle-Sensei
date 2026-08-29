import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import {
  areaUnderRiskCoverage,
  coverageRiskCurve,
  expectedCalibrationError,
  reliabilityBins,
  type ConfidenceSample,
} from "./calibration.js";

/**
 * Coverage-vs-risk + reliability report over the COMMITTED experiment
 * artifacts that carry per-case confidences (W14 blind-overlap files).
 *
 *   npx tsx src/coverageRisk.ts        (swing-lab)  ·  pnpm --filter @pickle/swing-lab risk:curves
 *
 * PROVENANCE (stated per dataset, never blended):
 *   - "correct" here means AGREEMENT WITH THE PRIMARY ANNOTATOR in the W14
 *     blind overlap — an inter-annotator proxy, NOT gold and NOT a model
 *     prediction. These are the only committed artifacts pairing a per-case
 *     confidence with an independent correctness signal on this box
 *     (canonical run dirs with model confidences are absent on Linux).
 *   - n is small (12 TA verdicts, 31 ownership boxes); curves are exact over
 *     these samples but are NOT stable population estimates.
 */

const EXPERIMENTS = join(REPO_ROOT, "datasets/experiments");

interface TaOverlap {
  verdicts: Array<{ caseId: string; verdict: string; confidence: number }>;
}
interface OwnershipOverlap {
  verdicts: Array<{
    caseId: string;
    tMs: number;
    boxes: Record<string, { class: string; confidence: number }>;
  }>;
}
interface Agreement {
  ta: { disagreements: Array<{ caseId: string }> };
  ownership: { disagreements: Array<{ frame: string }> };
}

export interface NamedDataset {
  name: string;
  provenance: string;
  samples: ConfidenceSample[];
}

export function loadW14Datasets(experimentsDir = EXPERIMENTS): NamedDataset[] {
  const agreement = JSON.parse(
    readFileSync(join(experimentsDir, "wave-b/W14-overlap/agreement.json"), "utf8"),
  ) as Agreement;

  const ta = JSON.parse(
    readFileSync(join(experimentsDir, "wave-b/W14-overlap/ta-overlap.json"), "utf8"),
  ) as TaOverlap;
  const taDisagree = new Set(agreement.ta.disagreements.map((entry) => entry.caseId));
  const taSamples = ta.verdicts.map((verdict) => ({
    confidence: verdict.confidence,
    correct: !taDisagree.has(verdict.caseId),
  }));

  const ownership = JSON.parse(
    readFileSync(join(experimentsDir, "wave-b/W14-overlap/ownership-overlap.json"), "utf8"),
  ) as OwnershipOverlap;
  // Frames like "afn-sasebo-rally2 @2204 box2 (red)"; entries marked SUB-CLASS
  // only agreed at 3-class and are not 3-class disagreements.
  const ownershipDisagree = new Set<string>();
  for (const entry of agreement.ownership.disagreements) {
    if (entry.frame.includes("SUB-CLASS only")) continue;
    const match = entry.frame.match(/^(\S+) @(\d+) box(\d+)/);
    if (!match) throw new Error(`unparseable ownership disagreement frame: ${entry.frame}`);
    ownershipDisagree.add(`${match[1]}@${match[2]}#${match[3]}`);
  }
  const ownershipSamples: ConfidenceSample[] = [];
  for (const frame of ownership.verdicts) {
    for (const [index, box] of Object.entries(frame.boxes)) {
      ownershipSamples.push({
        confidence: box.confidence,
        correct: !ownershipDisagree.has(`${frame.caseId}@${frame.tMs}#${index}`),
      });
    }
  }

  return [
    {
      name: "W14 TA blind overlap (n=12 verdicts)",
      provenance:
        "committed artifact wave-b/W14-overlap/ta-overlap.json; correct = 3-class agreement with primary annotator (agreement.json) — inter-annotator proxy, not gold",
      samples: taSamples,
    },
    {
      name: "W14 ownership blind overlap (n=31 boxes)",
      provenance:
        "committed artifact wave-b/W14-overlap/ownership-overlap.json; correct = 3-class agreement with primary annotator (agreement.json) — inter-annotator proxy, not gold",
      samples: ownershipSamples,
    },
  ];
}

const isMain = process.argv[1]?.endsWith("coverageRisk.ts");
if (isMain) {
  const datasets = loadW14Datasets();
  const report = {
    generatedAtIso: new Date().toISOString(),
    caveat:
      "confidences are annotator self-reports; correctness is agreement with the primary annotator (proxy). Model-confidence curves require canonical run dirs, absent on this box.",
    datasets: datasets.map((dataset) => ({
      name: dataset.name,
      provenance: dataset.provenance,
      n: dataset.samples.length,
      ece10: expectedCalibrationError(dataset.samples, 10),
      aurc: areaUnderRiskCoverage(dataset.samples),
      reliabilityBins: reliabilityBins(dataset.samples, 10).filter((bin) => bin.count > 0),
      coverageRiskCurve: coverageRiskCurve(dataset.samples),
    })),
  };
  const outDir = join(EXPERIMENTS, "wave-c");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "c11-coverage-risk.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  for (const dataset of report.datasets) {
    console.log("═".repeat(74));
    console.log(dataset.name);
    console.log(`  provenance: ${dataset.provenance}`);
    console.log(
      `  n=${dataset.n} · ECE(10 bins)=${dataset.ece10.toFixed(4)} · AURC=${dataset.aurc.toFixed(4)}`,
    );
    console.log("  threshold  coverage  risk      answered  wrong");
    for (const point of dataset.coverageRiskCurve) {
      console.log(
        `  ${point.threshold.toFixed(2).padStart(9)} ${point.coverage.toFixed(3).padStart(9)} ${point.risk
          .toFixed(3)
          .padStart(
            9,
          )} ${String(point.nAnswered).padStart(9)} ${String(point.nWrongAnswered).padStart(6)}`,
      );
    }
  }
  console.log(`written: ${outPath.replace(`${REPO_ROOT}/`, "")}`);
}
