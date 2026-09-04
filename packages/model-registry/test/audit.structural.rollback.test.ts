/**
 * Structural audit (pass 1) — SubsystemReleaseState lifecycle probes.
 *
 * A FAILING case is the evidence for a finding; a PASSING case is
 * `verified_ok`. Production code is not modified by this audit.
 */
import { describe, expect, it } from "vitest";
import { SubsystemReleaseState } from "../src/index.js";

interface Bundle {
  name: string;
}

const bundle = (version: string) => ({ artifact: { name: version }, version });

function harness(options: { failOn?: (version: string | null) => boolean } = {}) {
  let live: string | null = null;
  let tick = 1_000;
  const state = new SubsystemReleaseState<Bundle>({
    subsystem: "audit",
    initial: bundle("good"),
    apply: (_artifact, version) => {
      if (options.failOn?.(version)) throw new Error(`apply failed for ${String(version)}`);
      live = version;
    },
    clock: () => (tick += 7),
  });
  return { state, live: () => live };
}

describe("audit: activeState vs live behaviour when apply() throws", () => {
  it("activate() that throws leaves active() equal to the still-live version", () => {
    const { state, live } = harness({ failOn: (v) => v === "bad" });
    state.recordKnownGood();
    expect(() => state.activate(bundle("bad"))).toThrow();
    expect(live()).toBe("good");
    expect(state.active()?.version ?? null).toBe(live());
  });

  it("activate() that throws is journaled (no silent state transition)", () => {
    const { state } = harness({ failOn: (v) => v === "bad" });
    const before = state.journal().length;
    expect(() => state.activate(bundle("bad"))).toThrow();
    expect(state.journal().length).toBeGreaterThan(before);
  });

  it("disable() that throws does not report the subsystem as disabled while it is still live", () => {
    const { state, live } = harness({ failOn: (v) => v === null });
    expect(() => state.disable()).toThrow();
    expect(live()).toBe("good");
    expect(state.active()?.version ?? null).toBe("good");
  });

  it("rollback() that throws does not report the known-good version as active", () => {
    let allowKg = true;
    let live: string | null = null;
    const state = new SubsystemReleaseState<Bundle>({
      subsystem: "audit",
      initial: bundle("kg"),
      apply: (_a, version) => {
        if (version === "kg" && !allowKg) throw new Error("apply failed");
        live = version;
      },
    });
    state.recordKnownGood();
    state.activate(bundle("next"));
    allowKg = false;
    expect(() => state.rollback()).toThrow();
    expect(live).toBe("next");
    expect(state.active()?.version ?? null).toBe(live);
  });

  it("after a failed activate(), rollback() still restores the known-good live behaviour", () => {
    // Recoverability: even if state diverged, the operator's escape hatch
    // must still land on the known-good artifact in live behaviour.
    const { state, live } = harness({ failOn: (v) => v === "bad" });
    state.recordKnownGood();
    expect(() => state.activate(bundle("bad"))).toThrow();
    state.rollback();
    expect(live()).toBe("good");
    expect(state.active()?.version).toBe("good");
  });
});

describe("audit: injected clock governs journal timestamps", () => {
  it("journal atEpochMs comes from the injected clock, not Date.now()", () => {
    const fixed = 5_000_000;
    const state = new SubsystemReleaseState<Bundle>({
      subsystem: "audit",
      initial: bundle("a"),
      apply: () => undefined,
      clock: () => fixed,
    });
    state.activate(bundle("b"));
    const entry = state.journal()[0]!;
    expect(entry.atEpochMs).toBe(fixed);
  });
});

describe("audit: journal append-only via returned array", () => {
  it("mutating the array returned by journal() does not alter the internal journal", () => {
    const { state } = harness();
    state.activate(bundle("a"));
    const copy = state.journal() as unknown as unknown[];
    copy.length = 0;
    expect(state.journal().length).toBe(1);
  });

  it("mutating an entry returned by journal() does not alter the internal journal", () => {
    const { state } = harness();
    state.activate(bundle("a"));
    const copy = state.journal();
    let mutated = false;
    try {
      (copy[0] as { toVersion: string | null }).toVersion = "tampered";
      mutated = true;
    } catch {
      // frozen — expected
    }
    if (mutated) expect(state.journal()[0]!.toVersion).toBe("a");
  });
});

describe("audit: known-good vs active aliasing", () => {
  it("recordKnownGood snapshot is not affected by later mutation of the candidate object", () => {
    const { state } = harness();
    const candidate = bundle("a");
    state.activate(candidate);
    state.recordKnownGood();
    candidate.version = "tampered";
    expect(state.knownGood()?.version).toBe("a");
  });

  it("constructor initial artifact is applied exactly once and not journaled as an activate", () => {
    const applied: Array<string | null> = [];
    const state = new SubsystemReleaseState<Bundle>({
      subsystem: "audit",
      initial: bundle("init"),
      apply: (_a, v) => {
        applied.push(v);
      },
    });
    expect(applied).toEqual(["init"]);
    expect(state.journal()).toEqual([]);
  });
});
