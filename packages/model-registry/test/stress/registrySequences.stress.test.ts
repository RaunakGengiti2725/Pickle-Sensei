import { describe, expect, it } from "vitest";
import {
  describeBroken,
  runCampaign,
  stressConfig,
  writeTable,
  type SuiteDefinition,
} from "./harness.js";
import {
  executeRegistryActions,
  generateRegistryActions,
  type RegistryAction,
} from "./registryStress.js";

/**
 * Seeded randomized long-run over ModelRegistry (invariants R1–R8 in
 * registryStress.ts). Every sequence is replayed twice from its seed and the
 * traces must be identical. Scale via STRESS_ITER / STRESS_SEED; the JSON
 * seed→outcome table is written when STRESS_OUT is set.
 */

export const REGISTRY_SUITE: SuiteDefinition<RegistryAction> = {
  suite: "registry-sequences",
  generate: generateRegistryActions,
  execute: executeRegistryActions,
};

describe("ModelRegistry — seeded randomized sequences", () => {
  it("holds R1–R8 on every generated sequence and replays deterministically", () => {
    const config = stressConfig();
    const table = runCampaign(REGISTRY_SUITE, config);
    const path = writeTable(table);
    const summary =
      `${table.suite}: ${table.sequences} sequences, ${table.stepsExecuted} steps, ` +
      `${table.held} held, ${table.broken} broken, ${table.nondeterministic} nondeterministic` +
      (path === null ? "" : ` → ${path}`);
    expect(table.sequences).toBe(config.iterations);
    expect(table.nondeterministic, summary).toBe(0);
    expect(table.broken, `${summary}\n${describeBroken(table)}`).toBe(0);
  });
});
