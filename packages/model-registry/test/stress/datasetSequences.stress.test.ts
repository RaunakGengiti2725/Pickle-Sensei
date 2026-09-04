import { describe, expect, it } from "vitest";
import {
  executeDatasetActions,
  generateDatasetActions,
  type DatasetAction,
} from "./datasetStress.js";
import {
  describeBroken,
  runCampaign,
  stressConfig,
  writeTable,
  type SuiteDefinition,
} from "./harness.js";

/**
 * Seeded randomized long-run over dataset-release validation, DatasetReleaseIndex
 * and auditModelDatasetLineage (invariants D1–D7 in datasetStress.ts). Scale via
 * STRESS_ITER / STRESS_SEED; JSON seed→outcome tables are written when STRESS_OUT
 * is set.
 */

export const DATASET_SUITE: SuiteDefinition<DatasetAction> = {
  suite: "dataset-release-sequences",
  generate: (rng, length) => generateDatasetActions(rng, length),
  execute: executeDatasetActions(false),
};

/** Adds the two strict mutations (±Infinity statistic, substring leakage finding). */
export const DATASET_STRICT_SUITE: SuiteDefinition<DatasetAction> = {
  suite: "dataset-release-sequences-strict",
  generate: (rng, length) => generateDatasetActions(rng, length, { strict: true }),
  execute: executeDatasetActions(true),
};

describe("dataset releases — seeded randomized sequences", () => {
  it("holds D1–D5 on every generated sequence and replays deterministically", () => {
    const config = stressConfig();
    const table = runCampaign(DATASET_SUITE, config);
    const path = writeTable(table);
    const summary =
      `${table.suite}: ${table.sequences} sequences, ${table.stepsExecuted} steps, ` +
      `${table.held} held, ${table.broken} broken, ${table.nondeterministic} nondeterministic` +
      (path === null ? "" : ` → ${path}`);
    expect(table.sequences).toBe(config.iterations);
    expect(table.nondeterministic, summary).toBe(0);
    expect(table.broken, `${summary}\n${describeBroken(table)}`).toBe(0);
  });

  it("D6/D7 pin: ±Infinity statistics and substring-matched leakage findings are accepted (every failure is D1 accept-invalid, deterministic)", () => {
    const config = stressConfig();
    const table = runCampaign(DATASET_STRICT_SUITE, config);
    writeTable(table);
    expect(table.sequences).toBe(config.iterations);
    expect(table.nondeterministic, describeBroken(table)).toBe(0);
    const broken = table.rows.filter((row) => row.outcome === "broken");
    const invariants = new Set(broken.map((row) => row.failure?.invariant ?? "?"));
    // Only "accepted an invalid manifest" failures may appear, and only for the two strict rules.
    expect(
      [...invariants].filter(
        (name) => name !== "D1_accepts_invalid_manifest" && name !== "D2_register_accepts_invalid",
      ),
      describeBroken(table),
    ).toEqual([]);
    for (const row of broken) {
      expect(row.failure?.detail, `seed=${row.seed}`).toMatch(
        /^(model=\[|expected rejection for )(infinite_statistic|unrecorded_leakage)\b/,
      );
      expect(row.minimized?.length, `seed=${row.seed}`).toBe(1);
    }
    // The defects reproduce: remove this pin once datasetRelease.ts rejects them.
    expect(table.broken, "D6/D7 defects no longer reproduce — update the pin").toBeGreaterThan(0);
  });
});
