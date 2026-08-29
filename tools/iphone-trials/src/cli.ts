/**
 * Report CLI: reads a directory of pickle.iphone-trial.v1 JSON files plus the
 * device matrix and writes an iphone-trial-report-v1 document.
 *
 * Usage:
 *   pnpm --filter @pickle/iphone-trials report -- \
 *     [--trials <dir>] [--matrix <file>] [--out <file>]
 *
 * Defaults: --trials tools/iphone-trials/trials (created empty on first run),
 * --matrix tools/iphone-trials/device-matrix.json,
 * --out tools/iphone-trials/reports/iphone-trial-report-<unix-ms>.json.
 *
 * Exit code 1 when any trial file is invalid (the report still lists the
 * errors); 0 otherwise — an empty trials dir is a VALID state that produces a
 * BLOCKED_EXTERNAL report.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateTrialReport } from "./generateReport.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv: readonly string[]): {
  trialsDir: string;
  matrixPath: string;
  outPath: string;
} {
  let trialsDir = join(packageRoot, "trials");
  let matrixPath = join(packageRoot, "device-matrix.json");
  let outPath = join(packageRoot, "reports", `iphone-trial-report-${Date.now()}.json`);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--") continue;
    const value = argv[i + 1];
    if (flag === "--trials" && value !== undefined) {
      trialsDir = resolve(value);
      i += 1;
    } else if (flag === "--matrix" && value !== undefined) {
      matrixPath = resolve(value);
      i += 1;
    } else if (flag === "--out" && value !== undefined) {
      outPath = resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown or valueless flag: ${flag}`);
    }
  }
  return { trialsDir, matrixPath, outPath };
}

function main(): void {
  const { trialsDir, matrixPath, outPath } = parseArgs(process.argv.slice(2));
  mkdirSync(trialsDir, { recursive: true });
  const matrix: unknown = JSON.parse(readFileSync(matrixPath, "utf8"));
  const fileNames = readdirSync(trialsDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const trialFiles = fileNames.map((fileName) => ({
    fileName,
    data: JSON.parse(readFileSync(join(trialsDir, fileName), "utf8")) as unknown,
  }));
  const report = generateTrialReport({
    matrix,
    trialFiles,
    generatedAtIso: new Date().toISOString(),
  });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(
    `iphone-trial-report: ${report.totals.filesRead} file(s) read, ` +
      `${report.totals.deviceMeasurementTrials} device trial(s), ` +
      `${report.totals.sampleFixtureTrials} sample fixture(s), ` +
      `${report.totals.invalidFiles} invalid -> ${outPath}`,
  );
  console.error(`verdict: ${report.verdict}`);
  if (report.totals.invalidFiles > 0) {
    for (const invalid of report.invalidFiles) {
      console.error(`INVALID ${invalid.fileName}:`);
      for (const error of invalid.errors) console.error(`  - ${error}`);
    }
    process.exitCode = 1;
  }
}

main();
