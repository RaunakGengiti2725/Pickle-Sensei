/**
 * Adversarial harness for the committed Linux regression baseline.
 *
 * Every scenario starts from a deep clone of `datasets/reports/regression/baseline.json`,
 * applies ONE named mutation (recorded in the scenario so it is replayable), re-derives
 * `summary.metrics` through `flattenBenchMetrics` so the candidate still validates, and
 * runs `compareSummaries` against the committed tolerances. A scenario passes when the
 * comparator's exit code and metric status equal what a gate that "cannot be gamed"
 * must produce.
 *
 * Run standalone (writes `scenarios.json` + `summary.json` and a few candidate files that
 * are also pushed through the real `bench:compare` CLI):
 *
 *   packages/evaluation/node_modules/.bin/tsx \
 *     packages/evaluation/test/harness/baselineIntegrityHarness.ts --out /tmp/adv
 *
 * Read-only with respect to the repository: it never writes under `datasets/` or
 * `packages/evaluation`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REGRESSION_CONTRACT_VERSION,
  compareSummaries,
  flattenBenchMetrics,
  validateRegressionSummary,
  validateToleranceConfig,
  type BenchRecord,
  type CompareReport,
  type MetricComparisonStatus,
  type RegressionSummary,
  type ToleranceConfig,
} from "../../src/index.js";

export const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIR = resolve(HARNESS_DIR, "..", "..");
export const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
export const BASELINE_PATH = join(REPO_ROOT, "datasets/reports/regression/baseline.json");
export const TOLERANCES_PATH = join(PACKAGE_DIR, "regression.tolerances.json");
export const CLI_PATH = join(PACKAGE_DIR, "src/regression/cli.ts");
export const TSX_BIN = join(PACKAGE_DIR, "node_modules/.bin/tsx");

export function loadCommittedBaseline(): RegressionSummary {
  const validated = validateRegressionSummary(JSON.parse(readFileSync(BASELINE_PATH, "utf8")));
  if (!validated.ok) throw new Error(`${BASELINE_PATH}: ${validated.failure.message}`);
  return validated.value;
}

export function loadCommittedTolerances(): ToleranceConfig {
  const validated = validateToleranceConfig(JSON.parse(readFileSync(TOLERANCES_PATH, "utf8")));
  if (!validated.ok) throw new Error(`${TOLERANCES_PATH}: ${validated.failure.message}`);
  return validated.value;
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Split a flattened key into its bench id and the bench-local metric name. */
export function splitMetricKey(
  key: string,
  summary: RegressionSummary,
): { benchId: string; metric: string } {
  for (const bench of summary.benches) {
    const prefix = `${bench.id}.`;
    if (key.startsWith(prefix) && Object.hasOwn(bench.metrics, key.slice(prefix.length))) {
      return { benchId: bench.id, metric: key.slice(prefix.length) };
    }
  }
  throw new Error(`metric key ${key} does not belong to any bench in the summary`);
}

/**
 * Smallest movement the bench can actually produce for this metric: benches emit
 * integer counts or `round3()`-ed ratios / medians, so a one-count or one-milli
 * step is the finest real change a code regression can cause.
 */
export function minimalUnit(value: number): number {
  return Number.isInteger(value) ? 1 : 0.001;
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export type ScenarioKind =
  | "bad_unit"
  | "good_unit"
  | "measurement_lost"
  | "drop_metric"
  | "bench_failed"
  | "bench_missing"
  | "informational_shift"
  | "flatten_tamper"
  | "new_metric"
  | "contract_mismatch"
  | "dirty_confound"
  | "dataset_confound"
  | "identity_only";

export interface Scenario {
  id: string;
  kind: ScenarioKind;
  /** Exact, replayable description of the mutation applied to a clone of the baseline. */
  mutation: Record<string, string | number | null | boolean>;
  expectedExit: 0 | 1 | 2 | 3;
  /** Status the mutated metric must receive (single-metric scenarios). */
  expectedStatus: MetricComparisonStatus | null;
  /** Statuses every compared metric may take (whole-document scenarios). */
  allowedStatuses: readonly MetricComparisonStatus[] | null;
  /** Whether the mutation must be reported as a failing (gate-blocking) change. */
  mustFail: boolean;
}

export interface ScenarioResult extends Scenario {
  actualExit: number;
  actualStatus: MetricComparisonStatus | null;
  /** Distinct statuses observed across all compared metrics. */
  observedStatuses: MetricComparisonStatus[];
  failing: boolean | null;
  warnings: string[];
  pass: boolean;
}

export interface PreparedScenario {
  scenario: Scenario;
  /** Raw candidate document (may be intentionally invalid for `flatten_tamper`). */
  candidate: unknown;
}

function benchOf(summary: RegressionSummary, benchId: string): BenchRecord {
  const bench = summary.benches.find((entry) => entry.id === benchId);
  if (!bench) throw new Error(`bench ${benchId} missing`);
  return bench;
}

function refreshFlattened(summary: RegressionSummary): RegressionSummary {
  summary.metrics = flattenBenchMetrics(summary.benches);
  return summary;
}

function candidateShell(baseline: RegressionSummary): RegressionSummary {
  const candidate = clone(baseline);
  candidate.runId = "adversarial";
  candidate.generatedAtIso = "2026-09-04T00:00:00.000Z";
  return candidate;
}

/**
 * Builds the full scenario matrix from the committed baseline + tolerances. Every
 * guarded metric gets four scenarios (bad step, good step, null, dropped key); the
 * rest are structural probes on the comparator.
 */
export function buildScenarios(
  baseline: RegressionSummary,
  config: ToleranceConfig,
): PreparedScenario[] {
  const prepared: PreparedScenario[] = [];
  const push = (scenario: Scenario, candidate: unknown): void => {
    prepared.push({ scenario, candidate });
  };

  const guarded = Object.entries(config.metrics).filter(
    ([, tolerance]) => tolerance.direction !== "informational",
  );
  const informational = Object.entries(config.metrics).filter(
    ([, tolerance]) => tolerance.direction === "informational",
  );

  for (const [key, tolerance] of guarded) {
    const base = baseline.metrics[key];
    if (typeof base !== "number") continue; // null-in-baseline is reported separately
    const { benchId, metric } = splitMetricKey(key, baseline);
    const unit = minimalUnit(base);
    const sign = tolerance.direction === "higher_is_better" ? -1 : 1;
    const bad = round3(base + sign * unit);
    const good = round3(base - sign * unit);

    const badCandidate = candidateShell(baseline);
    benchOf(badCandidate, benchId).metrics[metric] = bad;
    push(
      {
        id: `bad_unit:${key}`,
        kind: "bad_unit",
        mutation: { benchId, metric, from: base, to: bad, direction: tolerance.direction },
        expectedExit: 1,
        expectedStatus: "regressed",
        allowedStatuses: null,
        mustFail: true,
      },
      refreshFlattened(badCandidate),
    );

    const goodCandidate = candidateShell(baseline);
    benchOf(goodCandidate, benchId).metrics[metric] = good;
    push(
      {
        id: `good_unit:${key}`,
        kind: "good_unit",
        mutation: { benchId, metric, from: base, to: good, direction: tolerance.direction },
        expectedExit: 0,
        expectedStatus: "improved",
        allowedStatuses: null,
        mustFail: false,
      },
      refreshFlattened(goodCandidate),
    );

    const lostCandidate = candidateShell(baseline);
    benchOf(lostCandidate, benchId).metrics[metric] = null;
    push(
      {
        id: `measurement_lost:${key}`,
        kind: "measurement_lost",
        mutation: { benchId, metric, from: base, to: null },
        expectedExit: 1,
        expectedStatus: "measurement_lost",
        allowedStatuses: null,
        mustFail: true,
      },
      refreshFlattened(lostCandidate),
    );

    const droppedCandidate = candidateShell(baseline);
    delete benchOf(droppedCandidate, benchId).metrics[metric];
    push(
      {
        id: `drop_metric:${key}`,
        kind: "drop_metric",
        mutation: { benchId, metric, from: base, to: "<key removed>" },
        expectedExit: 1,
        expectedStatus: "missing_in_candidate",
        allowedStatuses: null,
        mustFail: true,
      },
      refreshFlattened(droppedCandidate),
    );
  }

  for (const bench of baseline.benches) {
    const failed = candidateShell(baseline);
    const target = benchOf(failed, bench.id);
    target.status = "failed";
    target.exitCode = bench.kind === "subprocess" ? 1 : null;
    target.error = "adversarial: bench crashed";
    target.metrics = {};
    push(
      {
        id: `bench_failed:${bench.id}`,
        kind: "bench_failed",
        mutation: {
          benchId: bench.id,
          status: "failed",
          metricsDropped: Object.keys(bench.metrics).length,
        },
        expectedExit: 1,
        expectedStatus: null,
        allowedStatuses: null,
        mustFail: true,
      },
      refreshFlattened(failed),
    );

    const missing = candidateShell(baseline);
    missing.benches = missing.benches.filter((entry) => entry.id !== bench.id);
    push(
      {
        id: `bench_missing:${bench.id}`,
        kind: "bench_missing",
        mutation: { benchId: bench.id, removed: true },
        expectedExit: 1,
        expectedStatus: null,
        allowedStatuses: null,
        mustFail: true,
      },
      refreshFlattened(missing),
    );
  }

  // Every informational metric moved at once: by design this must NOT fail (documents
  // exactly how much of the surface is unguarded).
  const infoShift = candidateShell(baseline);
  for (const [key] of informational) {
    const base = baseline.metrics[key];
    if (typeof base !== "number") continue;
    const { benchId, metric } = splitMetricKey(key, baseline);
    benchOf(infoShift, benchId).metrics[metric] = round3(base + minimalUnit(base));
  }
  push(
    {
      id: "informational_shift:all",
      kind: "informational_shift",
      mutation: { metricsMoved: informational.length, step: "+1 unit each" },
      expectedExit: 0,
      expectedStatus: null,
      allowedStatuses: ["informational", "unchanged"],
      mustFail: false,
    },
    refreshFlattened(infoShift),
  );

  // Hand-editing the flattened table without touching benches must be rejected by the
  // schema validator (the CLI exits 2 before comparing).
  const tampered = candidateShell(baseline);
  const [firstGuardedKey] = guarded[0] ?? [];
  if (firstGuardedKey && typeof tampered.metrics[firstGuardedKey] === "number") {
    tampered.metrics[firstGuardedKey] = (tampered.metrics[firstGuardedKey] as number) + 1;
  }
  push(
    {
      id: "flatten_tamper:summary.metrics",
      kind: "flatten_tamper",
      mutation: { metric: firstGuardedKey ?? "", edited: "summary.metrics only" },
      expectedExit: 2,
      expectedStatus: null,
      allowedStatuses: null,
      mustFail: true,
    },
    tampered,
  );

  // A metric the baseline never had: documents that `unlistedMetricPolicy: fail` does
  // not apply until the baseline is regenerated (status missing_in_baseline).
  const extra = candidateShell(baseline);
  benchOf(extra, "coach_gates").metrics.brand_new_metric = 1;
  push(
    {
      id: "new_metric:coach_gates.brand_new_metric",
      kind: "new_metric",
      mutation: { benchId: "coach_gates", metric: "brand_new_metric", to: 1 },
      expectedExit: 0,
      expectedStatus: "missing_in_baseline",
      allowedStatuses: null,
      mustFail: false,
    },
    refreshFlattened(extra),
  );

  const contract = candidateShell(baseline);
  (contract as { contractVersion: number }).contractVersion = REGRESSION_CONTRACT_VERSION + 1;
  push(
    {
      id: "contract_mismatch:contractVersion",
      kind: "contract_mismatch",
      mutation: { contractVersion: REGRESSION_CONTRACT_VERSION + 1 },
      expectedExit: 3,
      expectedStatus: null,
      allowedStatuses: null,
      mustFail: true,
    },
    contract,
  );

  // Confounds are warnings, not failures (documented comparator design).
  const dirty = candidateShell(baseline);
  dirty.provenance.gitDirty = true;
  push(
    {
      id: "dirty_confound:provenance.gitDirty",
      kind: "dirty_confound",
      mutation: { gitDirty: true },
      expectedExit: 0,
      expectedStatus: null,
      allowedStatuses: ["unchanged", "informational"],
      mustFail: false,
    },
    dirty,
  );

  const dataset = candidateShell(baseline);
  dataset.provenance.datasetsTreeSha = "0000000000000000000000000000000000000000";
  push(
    {
      id: "dataset_confound:provenance.datasetsTreeSha",
      kind: "dataset_confound",
      mutation: { datasetsTreeSha: "0000000000000000000000000000000000000000" },
      expectedExit: 0,
      expectedStatus: null,
      allowedStatuses: ["unchanged", "informational"],
      mustFail: false,
    },
    dataset,
  );

  const identity = candidateShell(baseline);
  identity.provenance.gitSha = "1111111111111111111111111111111111111111";
  push(
    {
      id: "identity_only:provenance.gitSha",
      kind: "identity_only",
      mutation: { gitSha: "1111111111111111111111111111111111111111" },
      expectedExit: 0,
      expectedStatus: null,
      allowedStatuses: ["unchanged", "informational"],
      mustFail: false,
    },
    identity,
  );

  return prepared;
}

function mutatedKey(scenario: Scenario): string | null {
  return typeof scenario.mutation.benchId === "string" &&
    typeof scenario.mutation.metric === "string"
    ? `${scenario.mutation.benchId}.${scenario.mutation.metric}`
    : null;
}

function observedStatuses(report: CompareReport): MetricComparisonStatus[] {
  return [...new Set(report.metrics.map((metric) => metric.status))].sort();
}

/** Runs one prepared scenario in-process through the validator + comparator. */
export function runScenario(
  baseline: RegressionSummary,
  config: ToleranceConfig,
  prepared: PreparedScenario,
): ScenarioResult {
  const { scenario } = prepared;
  const validated = validateRegressionSummary(prepared.candidate);
  if (!validated.ok) {
    const actualExit = 2;
    return {
      ...scenario,
      actualExit,
      actualStatus: null,
      observedStatuses: [],
      failing: null,
      warnings: [validated.failure.message],
      pass: actualExit === scenario.expectedExit,
    };
  }
  const report = compareSummaries(baseline, validated.value, config);
  const key = mutatedKey(scenario);
  const row = key === null ? undefined : report.metrics.find((metric) => metric.metric === key);
  const actualStatus = row?.status ?? null;
  const failing = row?.failing ?? null;
  const statuses = observedStatuses(report);
  const exitMatches = report.exitCode === scenario.expectedExit;
  const statusMatches =
    scenario.expectedStatus === null ? true : actualStatus === scenario.expectedStatus;
  const allowed = scenario.allowedStatuses;
  const allowedMatches =
    allowed === null ? true : statuses.every((status) => allowed.includes(status));
  const failingMatches = failing === null ? true : failing === scenario.mustFail;
  return {
    ...scenario,
    actualExit: report.exitCode,
    actualStatus,
    observedStatuses: statuses,
    failing,
    warnings: report.warnings,
    pass: exitMatches && statusMatches && allowedMatches && failingMatches,
  };
}

export function runAllScenarios(
  baseline: RegressionSummary,
  config: ToleranceConfig,
): ScenarioResult[] {
  return buildScenarios(baseline, config).map((prepared) =>
    runScenario(baseline, config, prepared),
  );
}

export interface CliReplay {
  scenarioId: string;
  candidatePath: string;
  command: string[];
  exitCode: number;
  stderr: string;
}

/**
 * Pushes a handful of representative candidates through the real `bench:compare` CLI
 * (same code path as CI) so the exit codes are proven end to end, not only in-process.
 */
export function replayThroughCli(
  outDir: string,
  prepared: PreparedScenario[],
  ids: readonly string[],
): CliReplay[] {
  if (!existsSync(TSX_BIN)) throw new Error(`${TSX_BIN} missing — run pnpm install first`);
  const replays: CliReplay[] = [];
  for (const id of ids) {
    const entry = prepared.find((candidate) => candidate.scenario.id === id);
    if (!entry) throw new Error(`unknown scenario ${id}`);
    const candidatePath = join(outDir, `${id.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
    writeFileSync(candidatePath, `${JSON.stringify(entry.candidate, null, 2)}\n`);
    const command = [TSX_BIN, CLI_PATH, "compare", BASELINE_PATH, candidatePath, "--json"];
    const result = spawnSync(command[0]!, command.slice(1), {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    if (result.error) throw result.error;
    writeFileSync(candidatePath.replace(/\.json$/, ".compare.json"), result.stdout);
    replays.push({
      scenarioId: id,
      candidatePath,
      command,
      exitCode: result.status ?? -1,
      stderr: result.stderr,
    });
  }
  return replays;
}

export const CLI_REPLAY_IDS = [
  "bad_unit:contact_replay.estimated",
  "bad_unit:ball_hard_slice.bucket.occluded.violations",
  "measurement_lost:event_recall.recall",
  "drop_metric:coach_gates.gates_pass",
  "bench_failed:ownership_dual_frame",
  "informational_shift:all",
  "flatten_tamper:summary.metrics",
  "new_metric:coach_gates.brand_new_metric",
  "contract_mismatch:contractVersion",
  "dirty_confound:provenance.gitDirty",
  "identity_only:provenance.gitSha",
] as const;

function parseOut(argv: string[]): string {
  const index = argv.indexOf("--out");
  if (index === -1 || !argv[index + 1]) {
    throw new Error("usage: baselineIntegrityHarness.ts --out <dir>");
  }
  return resolve(argv[index + 1]!);
}

export function main(argv: string[]): number {
  const outDir = parseOut(argv);
  mkdirSync(outDir, { recursive: true });
  const baseline = loadCommittedBaseline();
  const config = loadCommittedTolerances();
  const prepared = buildScenarios(baseline, config);
  const results = prepared.map((entry) => runScenario(baseline, config, entry));
  const replays = replayThroughCli(outDir, prepared, CLI_REPLAY_IDS);

  const failures = results.filter((result) => !result.pass);
  const byKind: Record<string, { total: number; pass: number }> = {};
  for (const result of results) {
    const bucket = (byKind[result.kind] ??= { total: 0, pass: 0 });
    bucket.total += 1;
    if (result.pass) bucket.pass += 1;
  }
  const cliMismatches = replays.filter((replay) => {
    const expected = results.find((result) => result.id === replay.scenarioId)?.expectedExit;
    return expected !== replay.exitCode;
  });

  const summary = {
    baselinePath: BASELINE_PATH,
    tolerancesPath: TOLERANCES_PATH,
    baselineGitSha: baseline.provenance.gitSha,
    baselineGitDirty: baseline.provenance.gitDirty,
    metricsTotal: Object.keys(baseline.metrics).length,
    guardedMetrics: Object.values(config.metrics).filter(
      (tolerance) => tolerance.direction !== "informational",
    ).length,
    informationalMetrics: Object.values(config.metrics).filter(
      (tolerance) => tolerance.direction === "informational",
    ).length,
    nullMetrics: Object.entries(baseline.metrics)
      .filter(([, value]) => value === null)
      .map(([key]) => key),
    scenarios: results.length,
    passed: results.length - failures.length,
    failed: failures.map((result) => result.id),
    byKind,
    cliReplays: replays.map((replay) => ({
      scenarioId: replay.scenarioId,
      exitCode: replay.exitCode,
      candidatePath: replay.candidatePath,
    })),
    cliMismatches: cliMismatches.map((replay) => replay.scenarioId),
    node: process.version,
  };
  writeFileSync(join(outDir, "scenarios.json"), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.error(
    `harness: ${summary.passed}/${summary.scenarios} scenarios behaved as required; ` +
      `${replays.length} CLI replays (${cliMismatches.length} mismatches); wrote ${outDir}`,
  );
  return failures.length === 0 && cliMismatches.length === 0 ? 0 : 1;
}

const isMain = process.argv[1]?.endsWith("baselineIntegrityHarness.ts") === true;
if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}
