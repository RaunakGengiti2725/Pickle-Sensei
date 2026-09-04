import { afterEach, describe, expect, it, vi } from "vitest";
import { SubsystemReleaseState, runRollbackDrill } from "../../src/index.js";

/**
 * Adversarial pass 3 (tester #3) — S1: journal timestamp determinism.
 *
 * Contract under attack: `SubsystemReleaseState` accepts an injectable
 * `clock`; a drill run with a fake clock must be fully deterministic,
 * including the journal's `atEpochMs`. A failing assertion here is BROKEN
 * evidence for the finding, not a test to be weakened.
 *
 * Seed: the fake clock is a fixed arithmetic sequence (start 1_700_000_000_000,
 * step 5 ms) so every run produces byte-identical journals.
 */

const CLOCK_START = 1_700_000_000_000;
const CLOCK_STEP = 5;

function fakeClock(): { clock: () => number; ticks: () => number[] } {
  let t = CLOCK_START;
  const observed: number[] = [];
  return {
    clock: () => {
      observed.push(t);
      const now = t;
      t += CLOCK_STEP;
      return now;
    },
    ticks: () => [...observed],
  };
}

function build(clock: () => number) {
  let live = "";
  const state = new SubsystemReleaseState<string>({
    subsystem: "s1-clock",
    initial: { version: "good", artifact: "good" },
    apply: (artifact) => {
      live = artifact ?? "";
    },
    clock,
  });
  return {
    state,
    run: () =>
      runRollbackDrill(
        state,
        { version: "bad", artifact: "bad" },
        { knownGoodLive: () => live === "good", badLive: () => live === "bad" },
      ),
  };
}

describe("S1 — journal atEpochMs must come from the injected clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("control: durationMs already honours the injected clock", () => {
    const { clock } = fakeClock();
    const { state, run } = build(clock);
    run();
    const durations = state.journal().map((e) => e.durationMs);
    // record_known_good logs 0; activate/disable/rollback each consume 2 ticks.
    expect(durations).toEqual([0, CLOCK_STEP, CLOCK_STEP, CLOCK_STEP]);
  });

  it("two drills with identical fake clocks produce identical journals (atEpochMs included)", () => {
    const a = build(fakeClock().clock);
    const b = build(fakeClock().clock);
    a.run();
    // Real wall clock advances between the two drills; a deterministic
    // journal must not notice.
    const spin = Date.now() + 15;
    while (Date.now() < spin) {
      /* busy-wait ≥15 ms so Date.now() differs between the two runs */
    }
    b.run();
    expect(b.state.journal()).toEqual(a.state.journal());
  });

  it("atEpochMs values are drawn from the injected clock's tick sequence", () => {
    const { clock, ticks } = fakeClock();
    const { state, run } = build(clock);
    run();
    const observedTicks = new Set(ticks());
    for (const entry of state.journal()) {
      expect(
        observedTicks.has(entry.atEpochMs),
        `${entry.action}: atEpochMs=${entry.atEpochMs} was never returned by the injected clock (ticks=${[...observedTicks].join(",")})`,
      ).toBe(true);
    }
  });

  it("clock skew: a frozen wall clock must not leak into the journal when a clock is injected", () => {
    // Simulate a skewed/frozen system clock. If atEpochMs came from the
    // injected clock the frozen wall clock would be invisible.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("1999-12-31T23:59:59.000Z"));
    const { clock } = fakeClock();
    const { state, run } = build(clock);
    run();
    const frozenWall = new Date("1999-12-31T23:59:59.000Z").getTime();
    for (const entry of state.journal()) {
      expect(entry.atEpochMs, `${entry.action} took atEpochMs from Date.now()`).not.toBe(
        frozenWall,
      );
    }
  });

  it("documented mixed-clock symptom: atEpochMs deltas contradict durationMs under a fake clock", () => {
    // With a stepping fake clock, consecutive entries are ≥ CLOCK_STEP*2 ms
    // apart in "clock time". If atEpochMs came from Date.now() the deltas
    // collapse to ~0 and a drill report reads as if every step happened at
    // the same instant while claiming non-zero durations.
    const { clock } = fakeClock();
    const { state, run } = build(clock);
    run();
    const journal = state.journal();
    expect(journal.length).toBeGreaterThan(1);
    journal.slice(1).forEach((entry, index) => {
      const previous = journal[index];
      if (previous === undefined) throw new Error(`journal[${index}] missing`);
      const delta = entry.atEpochMs - previous.atEpochMs;
      expect(delta, `entry ${index + 1} (${entry.action}) atEpochMs delta`).toBeGreaterThanOrEqual(
        entry.durationMs,
      );
      expect(delta).toBeGreaterThan(0);
    });
  });
});
