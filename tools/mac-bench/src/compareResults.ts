import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  MAC_BENCH_RESULTS_SCHEMA_VERSION,
  validateMacBenchResults,
  type MacBenchResultsV1,
} from "./resultsSchema.js";

/**
 * compareResults — old vs new mac-bench-results-v1 → regression report.
 *
 *   pnpm --filter @pickle/mac-bench compare -- <old.json> <new.json> [--out <report.json>]
 *
 * WHAT COUNTS AS A REGRESSION (versioned here, not tunable per run):
 *  - CASCADE: any drop in strict survival, usable results, or a per-stage
 *    unconditional/conditional count; any RISE in silent failures. Contract
 *    version changes are flagged as NOT COMPARABLE, never silently compared.
 *  - LATENCY: warm or cold P50/P95 grows by more than
 *    LATENCY_REGRESSION_RATIO AND by more than LATENCY_MIN_DELTA_MS
 *    (both gates — the ratio alone flags noise on tiny stages, the absolute
 *    delta alone flags noise on huge ones).
 *  - PROVENANCE: a dirty working tree on either side is reported as a caveat;
 *    comparisons stay possible but the report says so.
 *
 * The report never averages away a regression: improvements and regressions
 * are listed independently, and ANY regression makes the verdict REGRESSION.
 */

export const LATENCY_REGRESSION_RATIO = 1.1;
export const LATENCY_MIN_DELTA_MS = 50;

export interface ComparisonFinding {
  kind: "cascade" | "latency" | "comparability";
  metric: string;
  oldValue: number | string | null;
  newValue: number | string | null;
  detail: string;
}

export interface ComparisonReport {
  schemaVersion: "mac-bench-compare-v1";
  generatedAtIso: string;
  oldGeneratedAtIso: string;
  newGeneratedAtIso: string;
  oldCommit: string;
  newCommit: string;
  verdict: "OK" | "REGRESSION" | "NOT_COMPARABLE";
  regressions: ComparisonFinding[];
  improvements: ComparisonFinding[];
  caveats: string[];
}

type Percentiles = { p50Ms: number; p95Ms: number } | null;

function latencyFindings(
  stage: string,
  phase: "cold" | "warm",
  oldSummary: Percentiles,
  newSummary: Percentiles,
  regressions: ComparisonFinding[],
  improvements: ComparisonFinding[],
): void {
  if (!oldSummary || !newSummary) return;
  for (const key of ["p50Ms", "p95Ms"] as const) {
    const oldValue = oldSummary[key];
    const newValue = newSummary[key];
    const delta = newValue - oldValue;
    const grewPastRatio =
      oldValue > 0 ? newValue > oldValue * LATENCY_REGRESSION_RATIO : newValue > 0;
    const shrankPastRatio =
      newValue > 0 ? oldValue > newValue * LATENCY_REGRESSION_RATIO : oldValue > 0;
    const metric = `${stage}.${phase}.${key}`;
    if (grewPastRatio && delta > LATENCY_MIN_DELTA_MS) {
      regressions.push({
        kind: "latency",
        metric,
        oldValue,
        newValue,
        detail: `+${delta.toFixed(0)}ms (>${((LATENCY_REGRESSION_RATIO - 1) * 100).toFixed(0)}% and >${LATENCY_MIN_DELTA_MS}ms)`,
      });
    } else if (shrankPastRatio && -delta > LATENCY_MIN_DELTA_MS) {
      improvements.push({
        kind: "latency",
        metric,
        oldValue,
        newValue,
        detail: `${delta.toFixed(0)}ms`,
      });
    }
  }
}

export function compareResults(
  oldResults: MacBenchResultsV1,
  newResults: MacBenchResultsV1,
): ComparisonReport {
  const regressions: ComparisonFinding[] = [];
  const improvements: ComparisonFinding[] = [];
  const caveats: string[] = [];
  let notComparable = false;

  if (
    oldResults.schemaVersion !== MAC_BENCH_RESULTS_SCHEMA_VERSION ||
    newResults.schemaVersion !== MAC_BENCH_RESULTS_SCHEMA_VERSION
  ) {
    notComparable = true;
    regressions.push({
      kind: "comparability",
      metric: "schemaVersion",
      oldValue: oldResults.schemaVersion,
      newValue: newResults.schemaVersion,
      detail: "schema versions must both be mac-bench-results-v1",
    });
  }

  if (oldResults.provenance.dirtyWorkingTree) {
    caveats.push("old run had a dirty working tree — not reproducible from its commit alone");
  }
  if (newResults.provenance.dirtyWorkingTree) {
    caveats.push("new run had a dirty working tree — not reproducible from its commit alone");
  }

  const oldCases = [...oldResults.plan.caseIds].sort().join(",");
  const newCases = [...newResults.plan.caseIds].sort().join(",");
  if (oldCases !== newCases) {
    caveats.push(
      `case lists differ (old: ${oldCases} · new: ${newCases}) — cascade counts are not like-for-like`,
    );
  }

  // ── Cascade ────────────────────────────────────────────────────────────
  if (oldResults.cascade && newResults.cascade) {
    const oldCascade = oldResults.cascade;
    const newCascade = newResults.cascade;
    if (oldCascade.usableResult.contractVersion !== newCascade.usableResult.contractVersion) {
      notComparable = true;
      regressions.push({
        kind: "comparability",
        metric: "usableResult.contractVersion",
        oldValue: oldCascade.usableResult.contractVersion,
        newValue: newCascade.usableResult.contractVersion,
        detail: "usable-result contract re-versioned — usable counts are not comparable",
      });
    }
    if (oldCascade.silentFailure.contractVersion !== newCascade.silentFailure.contractVersion) {
      notComparable = true;
      regressions.push({
        kind: "comparability",
        metric: "silentFailure.contractVersion",
        oldValue: oldCascade.silentFailure.contractVersion,
        newValue: newCascade.silentFailure.contractVersion,
        detail: "silent-failure contract re-versioned — silent-failure counts are not comparable",
      });
    }

    if (!notComparable) {
      const counters: Array<{
        metric: string;
        oldValue: number;
        newValue: number;
        higherIsBetter: boolean;
      }> = [
        {
          metric: "strictSurvival.survived",
          oldValue: oldCascade.strictSurvival.survived,
          newValue: newCascade.strictSurvival.survived,
          higherIsBetter: true,
        },
        {
          metric: "usableResult.usable",
          oldValue: oldCascade.usableResult.usable,
          newValue: newCascade.usableResult.usable,
          higherIsBetter: true,
        },
        {
          metric: "silentFailure.silentFailures",
          oldValue: oldCascade.silentFailure.silentFailures,
          newValue: newCascade.silentFailure.silentFailures,
          higherIsBetter: false,
        },
      ];
      for (const stage of Object.keys(oldCascade.unconditionalPass)) {
        const newCount = newCascade.unconditionalPass[stage];
        const oldCount = oldCascade.unconditionalPass[stage];
        if (newCount !== undefined && oldCount !== undefined) {
          counters.push({
            metric: `unconditionalPass.${stage}`,
            oldValue: oldCount,
            newValue: newCount,
            higherIsBetter: true,
          });
        }
      }
      for (const stage of Object.keys(oldCascade.conditionalSurvival)) {
        const newCount = newCascade.conditionalSurvival[stage];
        const oldCount = oldCascade.conditionalSurvival[stage];
        if (newCount !== undefined && oldCount !== undefined) {
          counters.push({
            metric: `conditionalSurvival.${stage}`,
            oldValue: oldCount,
            newValue: newCount,
            higherIsBetter: true,
          });
        }
      }
      for (const counter of counters) {
        const worsened = counter.higherIsBetter
          ? counter.newValue < counter.oldValue
          : counter.newValue > counter.oldValue;
        const bettered = counter.higherIsBetter
          ? counter.newValue > counter.oldValue
          : counter.newValue < counter.oldValue;
        const finding: ComparisonFinding = {
          kind: "cascade",
          metric: counter.metric,
          oldValue: counter.oldValue,
          newValue: counter.newValue,
          detail: `${counter.oldValue} → ${counter.newValue}`,
        };
        if (worsened) regressions.push(finding);
        else if (bettered) improvements.push(finding);
      }
    }
  } else if (oldResults.cascade || newResults.cascade) {
    caveats.push(
      `cascade measured on only one side (old: ${oldResults.cascade ? "yes" : "no"} · new: ${newResults.cascade ? "yes" : "no"}) — no cascade comparison made`,
    );
  } else {
    caveats.push("cascade unmeasured on both sides — no cascade comparison made");
  }

  // ── Latency ────────────────────────────────────────────────────────────
  const newStages = new Map(newResults.stages.map((stage) => [stage.stage, stage]));
  for (const oldStage of oldResults.stages) {
    const newStage = newStages.get(oldStage.stage);
    if (!newStage) {
      caveats.push(
        `stage '${oldStage.stage}' present only in the old run — no latency comparison for it`,
      );
      continue;
    }
    latencyFindings(
      oldStage.stage,
      "cold",
      oldStage.cold,
      newStage.cold,
      regressions,
      improvements,
    );
    latencyFindings(
      oldStage.stage,
      "warm",
      oldStage.warm,
      newStage.warm,
      regressions,
      improvements,
    );
  }
  for (const newStage of newResults.stages) {
    if (!oldResults.stages.some((stage) => stage.stage === newStage.stage)) {
      caveats.push(
        `stage '${newStage.stage}' present only in the new run — no latency comparison for it`,
      );
    }
  }

  return {
    schemaVersion: "mac-bench-compare-v1",
    generatedAtIso: new Date().toISOString(),
    oldGeneratedAtIso: oldResults.generatedAtIso,
    newGeneratedAtIso: newResults.generatedAtIso,
    oldCommit: oldResults.provenance.gitCommit,
    newCommit: newResults.provenance.gitCommit,
    verdict: notComparable ? "NOT_COMPARABLE" : regressions.length > 0 ? "REGRESSION" : "OK",
    regressions,
    improvements,
    caveats,
  };
}

function loadResults(path: string): MacBenchResultsV1 {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const errors = validateMacBenchResults(parsed);
  if (errors.length > 0) {
    throw new Error(
      `${path} is not a valid mac-bench-results-v1 document:\n  ${errors.join("\n  ")}`,
    );
  }
  return parsed as MacBenchResultsV1;
}

const isMain = process.argv[1]?.endsWith("compareResults.ts");
if (isMain) {
  const argv = process.argv.slice(2);
  const positional = argv.filter(
    (argument, index) => !argument.startsWith("--") && argv[index - 1] !== "--out",
  );
  const oldPath = positional[0];
  const newPath = positional[1];
  if (!oldPath || !newPath) {
    console.error(
      "usage: compareResults <old-results.json> <new-results.json> [--out <report.json>]",
    );
    process.exit(2);
  }
  const report = compareResults(loadResults(oldPath), loadResults(newPath));

  console.log(`VERDICT: ${report.verdict}`);
  for (const finding of report.regressions) {
    console.log(`  ✗ ${finding.metric}: ${finding.detail}`);
  }
  for (const finding of report.improvements) {
    console.log(`  ✓ ${finding.metric}: ${finding.detail}`);
  }
  for (const caveat of report.caveats) {
    console.log(`  ! ${caveat}`);
  }

  const outIndex = argv.indexOf("--out");
  const outPath = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`written: ${outPath}`);
  }
  if (report.verdict !== "OK") process.exit(1);
}
