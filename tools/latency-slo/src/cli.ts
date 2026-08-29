/**
 * latency-slo CLI.
 *
 *   report  --bench <bench-results.json> --out <report.json>
 *           Ingest a Linux latency-bench artifact and write a sliced SLO
 *           report (LINUX_BENCH_NOT_DEVICE provenance).
 *
 *   compare --baseline <report.json> --current <report.json> [--out <file>]
 *           Compare two reports with the frozen regression-alert config.
 *           Exits 1 when any ALERT-severity finding exists (WARNINGs exit 0).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import process from "node:process";

import { generateSloReport, type LatencySloReport } from "./generateSloReport.js";
import { ingestLinuxBenchResults } from "./ingestLinuxBench.js";
import { compareSloReports } from "./regressionAlerts.js";

function argValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  return value === undefined ? null : value;
}

function requireArg(args: readonly string[], flag: string): string {
  const value = argValue(args, flag);
  if (value === null) {
    throw new Error(`missing required argument ${flag}`);
  }
  return value;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function runReport(args: readonly string[]): number {
  const benchPath = requireArg(args, "--bench");
  const outPath = requireArg(args, "--out");
  const sourceFile = relative(process.cwd(), benchPath);
  const { records, skippedNonZeroExit } = ingestLinuxBenchResults(readJson(benchPath), sourceFile);
  const report = generateSloReport(records);
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `latency-slo report: ${records.length} records ` +
      `(${skippedNonZeroExit} non-zero-exit runs skipped), ` +
      `${report.slices.length} slices -> ${outPath}`,
  );
  console.log(`device evidence: ${report.deviceEvidence}`);
  if (report.linuxNotDeviceDisclaimer !== null) {
    console.log(`DISCLAIMER: ${report.linuxNotDeviceDisclaimer}`);
  }
  return 0;
}

function runCompare(args: readonly string[]): number {
  const baseline = readJson(requireArg(args, "--baseline")) as LatencySloReport;
  const current = readJson(requireArg(args, "--current")) as LatencySloReport;
  const comparison = compareSloReports(baseline, current);
  const outPath = argValue(args, "--out");
  if (outPath !== null) {
    writeFileSync(outPath, `${JSON.stringify(comparison, null, 2)}\n`);
  }
  const alertCount = comparison.alerts.filter((alert) => alert.severity === "ALERT").length;
  const warningCount = comparison.alerts.length - alertCount;
  console.log(
    `latency-slo compare: ${alertCount} alert(s), ${warningCount} warning(s), ` +
      `${comparison.cleanSliceKeys.length} clean slice(s)`,
  );
  for (const alert of comparison.alerts) {
    console.log(`[${alert.severity}] ${alert.kind} ${alert.sliceKey}: ${alert.detail}`);
  }
  return alertCount > 0 ? 1 : 0;
}

function main(): number {
  const [command, ...args] = process.argv.slice(2);
  if (command === "report") return runReport(args);
  if (command === "compare") return runCompare(args);
  console.error("usage: slo <report|compare> ...");
  return 2;
}

process.exitCode = main();
