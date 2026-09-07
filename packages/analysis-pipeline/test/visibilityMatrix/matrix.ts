import { runCase, type CaseResult } from "./runner.js";
import { buildCase, SCENARIOS, type Expectation } from "./scenarios.js";

/**
 * Matrix driver: every scenario × seeds 1..N, with a per-scenario summary
 * table. Output is plain JSON so a failing (scenarioId, seed) can be rebuilt
 * with buildCase() and replayed exactly.
 */

export interface ScenarioSummary {
  scenarioId: string;
  description: string;
  expectation: Expectation;
  cases: number;
  outcomes: Record<string, number>;
  presentations: Record<string, number>;
  failureCodes: Record<string, number>;
  poseQualityRejects: number;
  poseQualityReasons: Record<string, number>;
  preGateRejects: number;
  preGateReasons: Record<string, number>;
  violations: Record<string, number>;
  violatingSeeds: number[];
  diagnostics: Record<string, number>;
  scoreDelta: { n: number; meanAbs: number; max: number; maxSeed: number } | null;
  contactShiftMs: { n: number; meanAbs: number; max: number; maxSeed: number } | null;
  /** Per metric: deviation from the same seed's clean reference measurement. */
  metricRelDeviation: Record<string, { n: number; mean: number; max: number; maxSeed: number }>;
  /** Per metric: error against synthetic ground truth where the generator defines one. */
  metricRelErrorVsTruth: Record<string, { n: number; mean: number; max: number; maxSeed: number }>;
}

export interface MatrixReport {
  version: "visibility-matrix-1";
  plane: "linux_replay_proxy";
  seedsPerScenario: number;
  totalCases: number;
  totalViolations: number;
  violationsByKind: Record<string, number>;
  diagnosticsByKind: Record<string, number>;
  runtime: {
    node: string;
    durationMs: number;
    heapUsedBeforeMb: number;
    heapUsedAfterMb: number;
    heapUsedPeakMb: number;
    rssAfterMb: number;
    meanCaseMs: number;
    maxCaseMs: number;
  };
  scenarios: ScenarioSummary[];
  cases: CaseResult[];
}

function bump(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

interface Stat {
  n: number;
  mean: number;
  max: number;
  maxSeed: number;
}

function stat(values: ReadonlyArray<{ value: number; seed: number }>): Stat | null {
  if (values.length === 0) return null;
  let max = values[0] ?? { value: 0, seed: 0 };
  for (const entry of values) if (entry.value > max.value) max = entry;
  return {
    n: values.length,
    mean: values.reduce((total, entry) => total + entry.value, 0) / values.length,
    max: max.value,
    maxSeed: max.seed,
  };
}

const toMb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

export function summarize(
  scenarioId: string,
  description: string,
  expectation: Expectation,
  cases: readonly CaseResult[],
): ScenarioSummary {
  const summary: ScenarioSummary = {
    scenarioId,
    description,
    expectation,
    cases: cases.length,
    outcomes: {},
    presentations: {},
    failureCodes: {},
    poseQualityRejects: 0,
    poseQualityReasons: {},
    preGateRejects: 0,
    preGateReasons: {},
    violations: {},
    violatingSeeds: [],
    diagnostics: {},
    scoreDelta: null,
    contactShiftMs: null,
    metricRelDeviation: {},
    metricRelErrorVsTruth: {},
  };
  const deltas: Array<{ value: number; seed: number }> = [];
  const shifts: Array<{ value: number; seed: number }> = [];
  const deviations = new Map<string, Array<{ value: number; seed: number }>>();
  const truthErrors = new Map<string, Array<{ value: number; seed: number }>>();
  for (const result of cases) {
    bump(summary.outcomes, result.fusion.kind);
    if (result.fusion.kind === "scored") bump(summary.presentations, result.fusion.presentation);
    if (result.fusion.kind === "failed") bump(summary.failureCodes, result.fusion.code);
    if (!result.quality.analyzable) summary.poseQualityRejects += 1;
    for (const reason of result.quality.reasons) bump(summary.poseQualityReasons, reason);
    if (!result.preGate.analyzable) summary.preGateRejects += 1;
    for (const reason of result.preGate.reasons) bump(summary.preGateReasons, reason);
    for (const violation of result.violations) bump(summary.violations, violation);
    if (result.violations.length > 0) summary.violatingSeeds.push(result.seed);
    for (const diagnostic of result.diagnostics) bump(summary.diagnostics, diagnostic);
    if (result.scoreDelta !== null) {
      deltas.push({ value: Math.abs(result.scoreDelta), seed: result.seed });
    }
    if (result.contactShiftMs !== null) {
      shifts.push({ value: Math.abs(result.contactShiftMs), seed: result.seed });
    }
    for (const error of result.metricErrors) {
      if (error.relDeviation !== null) {
        const list = deviations.get(error.metricKey) ?? [];
        list.push({ value: error.relDeviation, seed: result.seed });
        deviations.set(error.metricKey, list);
      }
      if (error.relErrorVsTruth !== null) {
        const list = truthErrors.get(error.metricKey) ?? [];
        list.push({ value: error.relErrorVsTruth, seed: result.seed });
        truthErrors.set(error.metricKey, list);
      }
    }
  }
  const deltaStat = stat(deltas);
  if (deltaStat) {
    summary.scoreDelta = {
      n: deltaStat.n,
      meanAbs: deltaStat.mean,
      max: deltaStat.max,
      maxSeed: deltaStat.maxSeed,
    };
  }
  const shiftStat = stat(shifts);
  if (shiftStat) {
    summary.contactShiftMs = {
      n: shiftStat.n,
      meanAbs: shiftStat.mean,
      max: shiftStat.max,
      maxSeed: shiftStat.maxSeed,
    };
  }
  for (const [metricKey, list] of deviations) {
    const value = stat(list);
    if (value) summary.metricRelDeviation[metricKey] = value;
  }
  for (const [metricKey, list] of truthErrors) {
    const value = stat(list);
    if (value) summary.metricRelErrorVsTruth[metricKey] = value;
  }
  return summary;
}

export async function runMatrix(seedsPerScenario: number): Promise<MatrixReport> {
  const startedAt = performance.now();
  const heapBefore = process.memoryUsage().heapUsed;
  let heapPeak = heapBefore;
  const cases: CaseResult[] = [];
  const scenarios: ScenarioSummary[] = [];
  for (const definition of SCENARIOS) {
    const results: CaseResult[] = [];
    for (let seed = 1; seed <= seedsPerScenario; seed += 1) {
      results.push(await runCase(buildCase(definition, seed)));
      heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
    }
    scenarios.push(
      summarize(definition.id, definition.description, definition.expectation, results),
    );
    cases.push(...results);
  }
  const violationsByKind: Record<string, number> = {};
  const diagnosticsByKind: Record<string, number> = {};
  for (const result of cases) {
    for (const violation of result.violations) bump(violationsByKind, violation);
    for (const diagnostic of result.diagnostics) bump(diagnosticsByKind, diagnostic);
  }
  const after = process.memoryUsage();
  return {
    version: "visibility-matrix-1",
    plane: "linux_replay_proxy",
    seedsPerScenario,
    totalCases: cases.length,
    totalViolations: cases.reduce((total, result) => total + result.violations.length, 0),
    violationsByKind,
    diagnosticsByKind,
    runtime: {
      node: process.version,
      durationMs: Math.round(performance.now() - startedAt),
      heapUsedBeforeMb: toMb(heapBefore),
      heapUsedAfterMb: toMb(after.heapUsed),
      heapUsedPeakMb: toMb(heapPeak),
      rssAfterMb: toMb(after.rss),
      meanCaseMs:
        cases.length > 0
          ? cases.reduce((total, result) => total + result.durationMs, 0) / cases.length
          : 0,
      maxCaseMs: cases.reduce((max, result) => Math.max(max, result.durationMs), 0),
    },
    scenarios,
    cases,
  };
}
