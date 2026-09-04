/**
 * Proves the leak detector fires: a unit that deliberately retains memory,
 * leaves a timer and a process listener behind, and replays
 * non-deterministically must be reported as leaking / mismatching, and a
 * clean unit must not.
 */
import { describe, expect, it } from "vitest";
import {
  findNonFinite,
  iterationSeed,
  lcg,
  runLongRunCampaign,
  type StressUnit,
} from "./leakHarness.js";

const ITERATIONS = 60;
const CHECKPOINT_EVERY = 10;

describe("leak harness self-test", () => {
  it("reports a retaining unit with dangling timer + listener as leaking", async () => {
    // Plain JS objects (not ArrayBuffers) so the growth lands in heapUsed.
    const retained: Array<Array<{ seed: number; index: number }>> = [];
    const timers: NodeJS.Timeout[] = [];
    const listeners: Array<() => void> = [];
    let calls = 0;
    const previousMaxListeners = process.getMaxListeners();
    process.setMaxListeners(ITERATIONS + 20);
    const leaky: StressUnit = {
      id: "self-test-leaky",
      iterate(seed) {
        calls += 1;
        retained.push(Array.from({ length: 8_192 }, (_, index) => ({ seed, index })));
        timers.push(setTimeout(() => {}, 3_600_000));
        const listener = () => {};
        listeners.push(listener);
        process.on("SIGTERM", listener);
        return { output: { seed, calls }, abstained: false, violations: [], nonFinite: [] };
      },
    };
    try {
      const report = await runLongRunCampaign(leaky, {
        iterations: ITERATIONS,
        campaignSeed: 7,
        checkpointEvery: CHECKPOINT_EVERY,
        replaySeeds: 3,
      });
      expect(report.executed).toBe(ITERATIONS);
      expect(report.heap.verdict).toBe("leak");
      expect(report.heap.monotone).toBe(true);
      expect(report.heap.slopePctPer100).toBeGreaterThan(5);
      expect(report.resources.verdict).toBe("leaked");
      expect(report.resources.leaked["resource.Timeout"]).toBeGreaterThanOrEqual(ITERATIONS);
      expect(report.resources.leaked["listener.process.SIGTERM"]).toBeGreaterThanOrEqual(
        ITERATIONS,
      );
      // `calls` is in the output, so replaying a seed hashes differently.
      expect(report.determinism.verdict).toBe("mismatch");
      expect(report.determinism.mismatches).toHaveLength(3);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      for (const listener of listeners) process.off("SIGTERM", listener);
      process.setMaxListeners(previousMaxListeners);
      retained.length = 0;
    }
  });

  it("reports a clean deterministic unit as ok and flags NaN/Infinity outputs", async () => {
    const clean: StressUnit = {
      id: "self-test-clean",
      iterate(seed) {
        const rand = lcg(seed);
        const output = { seed, value: rand(), ratio: seed % 7 === 0 ? Number.NaN : 1 };
        return {
          output,
          abstained: seed % 2 === 0,
          violations: [],
          nonFinite: findNonFinite(output),
        };
      },
    };
    const report = await runLongRunCampaign(clean, {
      iterations: ITERATIONS,
      campaignSeed: 11,
      checkpointEvery: CHECKPOINT_EVERY,
      replaySeeds: 5,
    });
    expect(report.executed).toBe(ITERATIONS);
    expect(report.heap.verdict).toBe("ok");
    expect(report.resources.verdict).toBe("ok");
    expect(report.time.verdict).toBe("ok");
    expect(report.determinism.verdict).toBe("ok");
    expect(report.abstentionRate).toBeGreaterThan(0);
    expect(report.abstentionRate).toBeLessThan(1);
    const nanRows = report.rows.filter((row) => row.outcome === "fail");
    expect(nanRows.length).toBe(report.rows.filter((row) => row.seed % 7 === 0).length);
    for (const row of nanRows) expect(row.detail).toContain("non_finite:$.ratio");
  });

  it("derives replayable 32-bit iteration seeds", () => {
    const a = iterationSeed(20260904, 0);
    const b = iterationSeed(20260904, 1);
    expect(a).not.toBe(b);
    expect(iterationSeed(20260904, 0)).toBe(a);
    expect(Number.isInteger(a) && a >= 0 && a <= 0xffff_ffff).toBe(true);
  });
});
