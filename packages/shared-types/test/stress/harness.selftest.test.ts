import { describe, expect, it } from "vitest";
import {
  MAX_SEQUENCE_LENGTH,
  MIN_SEQUENCE_LENGTH,
  check,
  makeRng,
  replaySeed,
  runStressCampaign,
  sequenceSeed,
  type StressCampaign,
} from "./harness.js";

/**
 * The stress harness must itself be trustworthy: it has to catch a planted
 * violation, minimize it to the offending actions, replay it from the seed,
 * measure flakiness, and flag a non-deterministic unit. A harness that
 * cannot fail would make every "held" campaign meaningless.
 */

type Action = { kind: "inc"; by: number } | { kind: "reset" };

function counterCampaign(faulty: boolean): StressCampaign<Action, { total: number }> {
  return {
    name: `selftest-${faulty ? "faulty" : "sound"}`,
    init: () => ({ total: 0 }),
    genAction: (rng) => (rng.chance(0.2) ? { kind: "reset" } : { kind: "inc", by: rng.int(1, 9) }),
    step(model, action) {
      if (action.kind === "reset") model.total = 0;
      else model.total += action.by;
      // Planted bug: the "unit" overflows past 30.
      check(!faulty || model.total <= 30, "total-bounded", () => `total=${model.total}`);
      return String(model.total);
    },
  };
}

describe("stress harness self-test", () => {
  it("derives reproducible seeds and sequence lengths inside the 5-60 band", async () => {
    expect(sequenceSeed(1, 0)).toBe(sequenceSeed(1, 0));
    expect(sequenceSeed(1, 0)).not.toBe(sequenceSeed(1, 1));
    const report = await runStressCampaign(counterCampaign(false), { iterations: 50, baseSeed: 7 });
    expect(report.held).toBe(50);
    expect(report.sequenceLength.min).toBeGreaterThanOrEqual(MIN_SEQUENCE_LENGTH);
    expect(report.sequenceLength.max).toBeLessThanOrEqual(MAX_SEQUENCE_LENGTH);
    expect(report.stepsExecuted).toBe(report.rows.reduce((sum, row) => sum + row.length, 0));
  });

  it("catches, minimizes and replays a planted invariant violation", async () => {
    const report = await runStressCampaign(counterCampaign(true), { iterations: 40, baseSeed: 7 });
    expect(report.broken.length).toBeGreaterThan(0);
    expect(report.nondeterministic).toEqual([]);
    for (const row of report.rows.filter((r) => r.outcome === "broken")) {
      expect(row.failure?.invariant).toBe("total-bounded");
      expect(row.minimized).toBeDefined();
      expect(row.minimized!.length).toBeLessThanOrEqual(row.length);
      // Minimal witness: only increments, summing to just over the bound.
      const actions = row.minimized!.actions as Action[];
      expect(actions.every((a) => a.kind === "inc")).toBe(true);
      const total = actions.reduce((sum, a) => sum + (a.kind === "inc" ? a.by : 0), 0);
      expect(total).toBeGreaterThan(30);
      expect(total).toBeLessThanOrEqual(39);
      expect(row.flakyRate).toBe(1);
      const replay = replaySeed(counterCampaign(true), row.seed);
      expect(replay.failure).toEqual(row.failure);
    }
  });

  it("flags a unit whose trace differs between two replays of the same seed", async () => {
    let calls = 0;
    const flaky: StressCampaign<Action, { total: number }> = {
      name: "selftest-nondeterministic",
      init: () => ({ total: 0 }),
      genAction: (rng) => ({ kind: "inc", by: rng.int(1, 3) }),
      step(model, action) {
        calls += 1;
        model.total += action.kind === "inc" ? action.by : 0;
        return `${model.total}:${calls > 1_000_000 ? "x" : Math.floor(calls / 7)}`;
      },
    };
    const report = await runStressCampaign(flaky, { iterations: 3, baseSeed: 3 });
    expect(report.nondeterministic.length).toBeGreaterThan(0);
    expect(report.rows.some((row) => row.traceDivergence !== undefined)).toBe(true);
  });

  it("rng is a pure function of its seed", () => {
    const a = makeRng(123);
    const b = makeRng(123);
    const seqA = Array.from({ length: 20 }, () => a.int(0, 1000));
    const seqB = Array.from({ length: 20 }, () => b.int(0, 1000));
    expect(seqA).toEqual(seqB);
    expect(
      makeRng(5)
        .permutation(6)
        .sort((x, y) => x - y),
    ).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
