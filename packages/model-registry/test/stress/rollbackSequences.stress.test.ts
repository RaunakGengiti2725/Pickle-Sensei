import { describe, expect, it } from "vitest";
import {
  describeBroken,
  runCampaign,
  stressConfig,
  writeTable,
  type SuiteDefinition,
} from "./harness.js";
import {
  executeRollbackActions,
  generateRollbackActions,
  type RollbackAction,
} from "./rollbackStress.js";

/**
 * Seeded randomized long-run over SubsystemReleaseState / runRollbackDrill
 * (invariants K1–K8 in rollbackStress.ts). Scale via STRESS_ITER / STRESS_SEED;
 * JSON seed→outcome tables are written when STRESS_OUT is set.
 */

export const ROLLBACK_SUITE: SuiteDefinition<RollbackAction> = {
  suite: "rollback-sequences",
  generate: (rng, length) => generateRollbackActions(rng, length),
  execute: executeRollbackActions,
};

/** Same generator with candidates whose `apply` hook throws (near-legal: the live layer refuses the artifact). */
export const ROLLBACK_POISON_SUITE: SuiteDefinition<RollbackAction> = {
  suite: "rollback-sequences-poisoned-apply",
  generate: (rng, length) => generateRollbackActions(rng, length, { poisonChance: 0.08 }),
  execute: executeRollbackActions,
};

describe("SubsystemReleaseState — seeded randomized sequences", () => {
  it("holds K1–K8 on every legal sequence and replays deterministically", () => {
    const config = stressConfig();
    const table = runCampaign(ROLLBACK_SUITE, config);
    const path = writeTable(table);
    const summary =
      `${table.suite}: ${table.sequences} sequences, ${table.stepsExecuted} steps, ` +
      `${table.held} held, ${table.broken} broken, ${table.nondeterministic} nondeterministic` +
      (path === null ? "" : ` → ${path}`);
    expect(table.sequences).toBe(config.iterations);
    expect(table.nondeterministic, summary).toBe(0);
    expect(table.broken, `${summary}\n${describeBroken(table)}`).toBe(0);
  });

  it("K6 pin: a throwing `apply` leaves active() pointing at a version that never went live (every failure is K6, deterministic)", () => {
    const config = stressConfig();
    const table = runCampaign(ROLLBACK_POISON_SUITE, config);
    writeTable(table);
    expect(table.sequences).toBe(config.iterations);
    expect(table.nondeterministic, describeBroken(table)).toBe(0);
    const invariants = new Set(
      table.rows
        .filter((row) => row.outcome === "broken")
        .map((row) => row.failure?.invariant ?? "?"),
    );
    // Every broken row must be attributable to the K6 defect; nothing else may hide behind it.
    expect(
      [...invariants].filter((name) => !name.startsWith("K6_")),
      describeBroken(table),
    ).toEqual([]);
    // The defect reproduces: remove this pin (and flip the expectation) once rollback.ts applies atomically.
    expect(table.broken, "K6 defect no longer reproduces — update the pin").toBeGreaterThan(0);
    for (const row of table.rows) {
      if (row.outcome === "broken") expect(row.minimized?.length, `seed=${row.seed}`).toBe(1);
    }
  });
});
