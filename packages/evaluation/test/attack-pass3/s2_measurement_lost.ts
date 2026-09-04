/**
 * S2 — candidate metric null while baseline numeric.
 *   guarded metric        → status measurement_lost, failing, exit 1
 *   informational metric  → status measurement_lost, NOT failing, exit 0
 *
 * Extra twists exercised here:
 *   - null only in the flattened view (bench view still numeric) → the schema
 *     must reject the candidate (exit 2) instead of silently comparing.
 *   - ALL guarded metrics of one bench nulled at once → still exit 1 and every
 *     one of them listed.
 *   - baseline null / candidate numeric (newly_measured) must NOT fail.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASELINE,
  TOLERANCES,
  check,
  cli,
  ensureOutDir,
  finish,
  readJson,
  writeJson,
  type Check,
} from "./harness.js";

interface Summary {
  benches: { id: string; metrics: Record<string, number | null> }[];
  metrics: Record<string, number | null>;
}
interface Tolerances {
  metrics: Record<string, { direction: string }>;
}
interface Report {
  exitCode: number;
  counts: Record<string, number>;
  metrics: { metric: string; status: string; failing: boolean }[];
  regressions: string[];
  warnings: string[];
}

const startedAtIso = new Date().toISOString();
const checks: Check[] = [];
const outDir = join(ensureOutDir(), "s2");
const baseline = readJson<Summary>(BASELINE);
const tolerances = readJson<Tolerances>(TOLERANCES);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function setMetric(
  summary: Summary,
  flatKey: string,
  value: number | null,
  alsoBenchView = true,
): void {
  summary.metrics[flatKey] = value;
  if (!alsoBenchView) return;
  const bench = summary.benches.find((entry) => flatKey.startsWith(`${entry.id}.`));
  if (!bench) throw new Error(`no bench for ${flatKey}`);
  bench.metrics[flatKey.slice(bench.id.length + 1)] = value;
}

function compare(candidatePath: string, label: string) {
  const result = cli(["compare", BASELINE, candidatePath, "--json"]);
  writeFileSync(join(outDir, `${label}.stdout.log`), result.stdout);
  writeFileSync(join(outDir, `${label}.stderr.log`), result.stderr);
  let report: Report | null = null;
  try {
    report = JSON.parse(result.stdout) as Report;
  } catch {
    report = null;
  }
  return { result, report };
}

const guardedKeys = Object.entries(tolerances.metrics)
  .filter(([key, entry]) => entry.direction !== "informational" && baseline.metrics[key] !== null)
  .map(([key]) => key);
const informationalKeys = Object.entries(tolerances.metrics)
  .filter(([key, entry]) => entry.direction === "informational" && baseline.metrics[key] !== null)
  .map(([key]) => key);

const guardedKey = guardedKeys.includes("contact_replay.median_error_ms")
  ? "contact_replay.median_error_ms"
  : guardedKeys[0]!;
const informationalKey = informationalKeys.includes("contact_replay.target_events")
  ? "contact_replay.target_events"
  : informationalKeys[0]!;

// (a) guarded → null
{
  const cand = clone(baseline);
  setMetric(cand, guardedKey, null);
  const path = join(outDir, "guarded-null.json");
  writeJson(path, cand);
  const { result, report } = compare(path, "guarded-null");
  const row = report?.metrics.find((entry) => entry.metric === guardedKey);
  check(
    checks,
    `guarded ${guardedKey} → null is measurement_lost + failing`,
    row?.status === "measurement_lost" && row.failing === true,
    `status=${row?.status} failing=${row?.failing}`,
    "status=measurement_lost failing=true",
  );
  check(
    checks,
    "guarded null → exit 1",
    result.exitCode === 1,
    `exit ${result.exitCode}`,
    "exit 1",
  );
  check(
    checks,
    "guarded null → listed in regressions[]",
    (report?.regressions ?? []).some((line) => line.includes(guardedKey)),
    JSON.stringify(report?.regressions ?? []),
    `mentions ${guardedKey}`,
  );
}

// (b) informational → null
{
  const cand = clone(baseline);
  setMetric(cand, informationalKey, null);
  const path = join(outDir, "informational-null.json");
  writeJson(path, cand);
  const { result, report } = compare(path, "informational-null");
  const row = report?.metrics.find((entry) => entry.metric === informationalKey);
  check(
    checks,
    `informational ${informationalKey} → null is measurement_lost but NOT failing`,
    row?.status === "measurement_lost" && row.failing === false,
    `status=${row?.status} failing=${row?.failing}`,
    "status=measurement_lost failing=false",
  );
  check(
    checks,
    "informational null → exit 0",
    result.exitCode === 0,
    `exit ${result.exitCode}`,
    "exit 0",
  );
  check(
    checks,
    "informational null still surfaces as a warning (not silent)",
    (report?.warnings ?? []).some((line) => line.includes(informationalKey)),
    JSON.stringify(report?.warnings ?? []),
    `a warning mentions ${informationalKey}`,
  );
}

// (c) null ONLY in the flattened view → schema must reject (exit 2)
{
  const cand = clone(baseline);
  setMetric(cand, guardedKey, null, false);
  const path = join(outDir, "flat-only-null.json");
  writeJson(path, cand);
  const { result } = compare(path, "flat-only-null");
  check(
    checks,
    "null only in flattened metrics view → rejected as invalid candidate",
    result.exitCode === 2 && /summary_metrics_mismatch|flattened/.test(result.stderr),
    `exit ${result.exitCode}: ${result.stderr.trim().split("\n")[0]}`,
    "exit 2 with summary_metrics_mismatch",
  );
}

// (d) every guarded metric nulled → exit 1, all listed
{
  const cand = clone(baseline);
  for (const key of guardedKeys) setMetric(cand, key, null);
  const path = join(outDir, "all-guarded-null.json");
  writeJson(path, cand);
  const { result, report } = compare(path, "all-guarded-null");
  const lost =
    report?.metrics.filter((entry) => entry.status === "measurement_lost" && entry.failing) ?? [];
  check(
    checks,
    `all ${guardedKeys.length} guarded metrics null → every one failing`,
    result.exitCode === 1 && lost.length === guardedKeys.length,
    `exit ${result.exitCode}, failing measurement_lost=${lost.length}`,
    `exit 1, failing measurement_lost=${guardedKeys.length}`,
  );
}

// (e) baseline null, candidate numeric → newly_measured, not failing
{
  const base = clone(baseline);
  setMetric(base, guardedKey, null);
  const basePath = join(outDir, "baseline-null.json");
  writeJson(basePath, base);
  const result = cli(["compare", basePath, BASELINE, "--json"]);
  const report = JSON.parse(result.stdout) as Report;
  const row = report.metrics.find((entry) => entry.metric === guardedKey);
  check(
    checks,
    "baseline null → candidate numeric is newly_measured, exit 0",
    result.exitCode === 0 && row?.status === "newly_measured" && row.failing === false,
    `exit ${result.exitCode} status=${row?.status} failing=${row?.failing}`,
    "exit 0 status=newly_measured failing=false",
  );
}

finish("s2_measurement_lost", startedAtIso, checks, {
  guardedKey,
  informationalKey,
  guardedCount: guardedKeys.length,
  informationalCount: informationalKeys.length,
  outDir,
});
