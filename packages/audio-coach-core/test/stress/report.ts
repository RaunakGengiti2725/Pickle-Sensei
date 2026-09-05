import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  minimizeSequence,
  runSequence,
  type CampaignSummary,
  type SequenceResult,
  type SessionEndResult,
} from "./campaign.js";

/**
 * Writes the campaign evidence package (seed → outcome table, minimized
 * failing sequences, flake rates) to STRESS_OUT. Pure file output; nothing
 * here influences the assertions in the test file.
 */
/** JSON.stringify that keeps hostile NaN/±Infinity readable instead of nulling them. */
function stringify(value: unknown, indent: number): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? `__${String(v)}__` : v),
    indent,
  );
}

export interface FlakeReport {
  engine: SequenceResult["engine"];
  mode: SequenceResult["mode"];
  seed: number;
  reruns: number;
  brokenRuns: number;
  rate: number;
}

export function flakeRate(row: SequenceResult, reruns = 10): FlakeReport {
  let brokenRuns = 0;
  for (let i = 0; i < reruns; i += 1) {
    if (runSequence(row.engine, row.mode, row.seed).outcome === "BROKEN") brokenRuns += 1;
  }
  return {
    engine: row.engine,
    mode: row.mode,
    seed: row.seed,
    reruns,
    brokenRuns,
    rate: brokenRuns / reruns,
  };
}

export function writeReport(
  outDir: string,
  campaigns: readonly CampaignSummary[],
  sessionEnd: readonly SessionEndResult[],
  meta: Record<string, unknown>,
): void {
  mkdirSync(outDir, { recursive: true });

  const table = campaigns.flatMap((c) =>
    c.rows.map((r) => ({
      engine: r.engine,
      mode: r.mode,
      seed: r.seed,
      length: r.length,
      defaultRules: r.defaultRules,
      outcome: r.outcome,
      deterministic: r.deterministic,
      roundTripStable: r.roundTripStable,
      threw: r.threw,
      hard: r.hardViolations.map((v) => `${v.step}:${v.invariant}`),
      advisory: r.advisoryViolations.map((v) => `${v.step}:${v.invariant}`),
      categories: r.categories,
    })),
  );
  writeFileSync(join(outDir, "seed-results.json"), stringify(table, 1));

  const sessionTable = sessionEnd.map((r) => ({
    mode: r.mode,
    seed: r.seed,
    input: r.input,
    line: r.line,
    outcome: r.violations.some((v) => v.strength === "hard")
      ? "BROKEN"
      : r.violations.length > 0
        ? "ADVISORY"
        : "HELD",
    violations: r.violations,
  }));
  writeFileSync(join(outDir, "session-end-results.json"), stringify(sessionTable, 1));

  const broken = campaigns.flatMap((c) => c.rows.filter((r) => r.outcome === "BROKEN"));
  const minimized = broken.flatMap((row) => {
    const invariants = [...new Set(row.hardViolations.map((v) => v.invariant))];
    return invariants.map((invariant) => ({
      engine: row.engine,
      mode: row.mode,
      seed: row.seed,
      invariant,
      minimized: minimizeSequence(row.engine, row.mode, row.seed, invariant),
    }));
  });
  writeFileSync(join(outDir, "minimized-failures.json"), stringify(minimized, 1));

  const flakes = broken.map((row) => flakeRate(row));
  writeFileSync(join(outDir, "flake-rates.json"), stringify(flakes, 1));

  const advisory = campaigns.flatMap((c) =>
    c.rows
      .filter((r) => r.advisoryViolations.length > 0)
      .map((r) => ({
        engine: r.engine,
        mode: r.mode,
        seed: r.seed,
        advisory: r.advisoryViolations,
      })),
  );
  writeFileSync(join(outDir, "advisory-violations.json"), stringify(advisory, 1));

  const summary = {
    ...meta,
    campaigns: campaigns.map(({ rows: _rows, ...rest }) => rest),
    sessionEnd: {
      rows: sessionEnd.length,
      broken: sessionTable.filter((r) => r.outcome === "BROKEN").length,
      advisory: sessionTable.filter((r) => r.outcome === "ADVISORY").length,
    },
    totals: {
      sequences: campaigns.reduce((n, c) => n + c.sequences, 0) + sessionEnd.length,
      engineSteps: campaigns.reduce((n, c) => n + c.steps, 0),
      broken: broken.length,
      advisory: advisory.length,
      minimized: minimized.length,
    },
  };
  writeFileSync(join(outDir, "summary.json"), stringify(summary, 2));
}
