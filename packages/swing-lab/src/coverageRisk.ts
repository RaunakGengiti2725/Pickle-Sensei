import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import {
  areaUnderRiskCoverage,
  calibrationReport,
  coverageRiskCurve,
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

const BUNDLES = join(REPO_ROOT, "datasets/paddle-bench/bundles");

interface D204AuditFile {
  captureBundle: string;
  frames: Array<{
    audit?: { conf?: number };
    classAgreement?: boolean;
  }>;
}

/**
 * D2-04 blind ownership audit (Wave D2): per-slot annotator confidences with
 * class agreement against the committed waveC ownership labels — the same
 * inter-annotator-proxy correctness signal as W14 (NOT gold, NOT a model).
 * Grouped by capture bundle (independent source), plus a pooled dataset.
 */
export function loadD204OwnershipAuditDatasets(bundlesDir = BUNDLES): NamedDataset[] {
  const perBundle: Array<{ bundle: string; samples: ConfidenceSample[] }> = [];
  for (const bundle of readdirSync(bundlesDir).sort()) {
    const auditPath = join(
      bundlesDir,
      bundle,
      "annotation/devin-visual-v4-waveD2-ownership-audit.json",
    );
    if (!existsSync(auditPath)) continue;
    const audit = JSON.parse(readFileSync(auditPath, "utf8")) as D204AuditFile;
    const samples: ConfidenceSample[] = [];
    for (const frame of audit.frames) {
      const confidence = frame.audit?.conf;
      if (confidence === undefined || frame.classAgreement === undefined) continue;
      samples.push({ confidence, correct: frame.classAgreement });
    }
    if (samples.length > 0) perBundle.push({ bundle: audit.captureBundle, samples });
  }
  const provenanceBase =
    "committed D2-04 audit sidecars bundles/*/annotation/devin-visual-v4-waveD2-ownership-audit.json; correct = 3-class agreement with the committed waveC ownership labels — inter-annotator proxy, not gold";
  const pooled: NamedDataset = {
    name: `D2-04 ownership audit pooled (n=${perBundle.reduce((sum, entry) => sum + entry.samples.length, 0)} slots, ${perBundle.length} bundles)`,
    provenance: `${provenanceBase}; POOLED across bundles — samples cluster by bundle/video, not i.i.d.`,
    samples: perBundle.flatMap((entry) => entry.samples),
  };
  const grouped = perBundle.map((entry) => ({
    name: `D2-04 ownership audit — ${entry.bundle} (n=${entry.samples.length} slots)`,
    provenance: `${provenanceBase}; single bundle ${entry.bundle}`,
    samples: entry.samples,
  }));
  return [pooled, ...grouped];
}

const isMain = process.argv[1]?.endsWith("coverageRisk.ts");
if (isMain) {
  const datasets = [...loadW14Datasets(), ...loadD204OwnershipAuditDatasets()];
  const report = {
    generatedAtIso: new Date().toISOString(),
    caveat:
      "confidences are annotator self-reports; correctness is agreement with the primary annotator (proxy). Model-confidence curves require canonical run dirs, absent on this box.",
    datasets: datasets.map((dataset) => ({
      name: dataset.name,
      provenance: dataset.provenance,
      n: dataset.samples.length,
      calibration: calibrationReport(dataset.samples, { nBins: 10 }),
      aurc: areaUnderRiskCoverage(dataset.samples),
      reliabilityBins: reliabilityBins(dataset.samples, 10).filter((bin) => bin.count > 0),
      coverageRiskCurve: coverageRiskCurve(dataset.samples),
    })),
  };
  // Wave C's c11-coverage-risk.json stays frozen as the baseline; recomputed
  // curves land in the wave-e artifact.
  const outDir = join(EXPERIMENTS, "wave-e");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "e07-coverage-risk.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  for (const dataset of report.datasets) {
    console.log("═".repeat(74));
    console.log(dataset.name);
    console.log(`  provenance: ${dataset.provenance}`);
    const eceText =
      dataset.calibration.ece === null
        ? `REFUSED (n=${dataset.calibration.n} < floor ${dataset.calibration.minSamples})`
        : dataset.calibration.ece.toFixed(4);
    console.log(`  n=${dataset.n} · ECE(10 bins)=${eceText} · AURC=${dataset.aurc.toFixed(4)}`);
    for (const flag of dataset.calibration.flags) console.log(`  FLAG: ${flag}`);
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
