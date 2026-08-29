// F16 Linux-proxy replay wrapper: runs the committed-data stroke heuristic
// bench (wave-E e03, LINUX-CPU, NOT the canonical Mac cascade) and persists
// the full report as a wave-g artifact.
//
//   cd packages/swing-lab && npx tsx ../../datasets/experiments/wave-g/g16-stroke-bench-run.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runStrokeHeuristicBench } from "../../../packages/swing-lab/src/strokeHeuristicBench.js";

const ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");
const OUT_DIR = join(ROOT, "datasets/experiments/wave-g");

const report = runStrokeHeuristicBench();
mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, "g16-stroke-bench-replay.json");
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`overall: ${JSON.stringify(report.overall)}`);
console.log(`evaluable: ${report.evaluableLabels}/${report.goldLabelsTotal}`);
console.log(`written: ${outPath}`);
