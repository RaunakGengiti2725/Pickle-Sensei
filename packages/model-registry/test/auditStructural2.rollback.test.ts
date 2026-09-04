import { describe, expect, it } from "vitest";
import { SubsystemReleaseState } from "../src/index.js";

/**
 * Structural audit (pass 1, auditor #2) — SubsystemReleaseState under a
 * throwing `apply`. The module doc says `apply` is "the ONLY path by which a
 * selection change reaches live behavior" and that "every transition is
 * journaled". These tests check that the controller's recorded state cannot
 * disagree with live behaviour when `apply` rejects a candidate. A FAILING
 * test here is a reproduced finding on 4d812e1a.
 */

type Live = { version: string | null };

function makeState(options: { rejectVersion: string; clock?: () => number }) {
  const live: Live = { version: null };
  const apply = (_artifact: string | null, version: string | null) => {
    if (version === options.rejectVersion) {
      throw new Error(`apply refused ${version}`);
    }
    live.version = version;
  };
  const initial = { version: "good", artifact: "good-artifact" };
  const state = options.clock
    ? new SubsystemReleaseState<string>({
        subsystem: "audit",
        initial,
        apply,
        clock: options.clock,
      })
    : new SubsystemReleaseState<string>({ subsystem: "audit", initial, apply });
  return { state, live };
}

describe("audit: apply() throwing during activate", () => {
  it("leaves active() equal to the version that is actually live", () => {
    const { state, live } = makeState({ rejectVersion: "bad" });
    state.recordKnownGood();
    expect(() => state.activate({ version: "bad", artifact: "bad-artifact" })).toThrow(
      /apply refused/,
    );
    expect(live.version).toBe("good");
    expect(state.active()?.version).toBe(live.version);
  });

  it("journals the failed transition (or nothing) rather than losing it silently", () => {
    const { state } = makeState({ rejectVersion: "bad" });
    state.recordKnownGood();
    const before = state.journal().length;
    try {
      state.activate({ version: "bad", artifact: "bad-artifact" });
    } catch {
      // expected
    }
    const after = state.journal();
    // Either an explicit failure record exists, or the state was not
    // mutated at all. What must NOT happen: state mutated + no journal.
    const mutated = state.active()?.version !== "good";
    expect(mutated && after.length === before).toBe(false);
  });

  it("a later disable() records fromVersion = the version that was really live", () => {
    const { state, live } = makeState({ rejectVersion: "bad" });
    state.recordKnownGood();
    try {
      state.activate({ version: "bad", artifact: "bad-artifact" });
    } catch {
      // expected
    }
    state.disable();
    const last = state.journal().at(-1);
    expect(last?.action).toBe("disable");
    expect(live.version).toBeNull();
    expect(last?.fromVersion).toBe("good");
  });
});

describe("audit: apply() throwing during rollback", () => {
  it("does not report the known-good version as active when apply() failed to restore it", () => {
    const live: Live = { version: null };
    let refuseGood = false;
    const state = new SubsystemReleaseState<string>({
      subsystem: "audit",
      initial: { version: "good", artifact: "good-artifact" },
      apply: (_artifact, version) => {
        if (refuseGood && version === "good") throw new Error("restore failed");
        live.version = version;
      },
    });
    state.recordKnownGood();
    state.activate({ version: "bad", artifact: "bad-artifact" });
    expect(live.version).toBe("bad");
    refuseGood = true;
    expect(() => state.rollback()).toThrow(/restore failed/);
    // Live behaviour is still the bad candidate; the controller must not
    // claim otherwise — a drill would read `recovered` from active().
    expect(live.version).toBe("bad");
    expect(state.active()?.version).toBe("bad");
  });
});

describe("audit: injected clock", () => {
  it("journal atEpochMs comes from the injected clock (deterministic tests)", () => {
    let now = 1_000;
    const { state } = makeState({ rejectVersion: "never", clock: () => now });
    now = 5_000;
    state.recordKnownGood();
    now = 9_000;
    state.activate({ version: "next", artifact: "next-artifact" });
    const [recorded, activated] = state.journal();
    expect(recorded?.atEpochMs).toBe(5_000);
    expect(activated?.atEpochMs).toBe(9_000);
  });

  it("the initial activation performed by the constructor is journaled ('every transition is journaled')", () => {
    const { state } = makeState({ rejectVersion: "never" });
    expect(state.journal().some((e) => e.action === "activate" && e.toVersion === "good")).toBe(
      true,
    );
  });
});
