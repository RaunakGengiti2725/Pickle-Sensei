import { describe, expect, it } from "vitest";
import {
  SubsystemReleaseState,
  runRollbackDrill,
  type VersionedArtifact,
} from "../../src/index.js";

/**
 * Adversarial pass 3 (tester #3) — S2: failure atomicity of `activate`.
 *
 * Contract under attack: `apply` is documented as "the ONLY path by which a
 * selection change reaches live behavior". If `apply` throws, the change did
 * NOT reach live behaviour, so the controller's `active()` must still report
 * the previous (known-good) version and the journal must not record a
 * successful/partial `activate`. A failing assertion is BROKEN evidence.
 */

const GOOD: VersionedArtifact<string> = { version: "good-v1", artifact: "good" };
const BAD: VersionedArtifact<string> = { version: "bad-v99", artifact: "bad" };

function buildThrowingOnBad() {
  let live = "";
  const applied: Array<string | null> = [];
  const state = new SubsystemReleaseState<string>({
    subsystem: "s2-throwing-apply",
    initial: GOOD,
    apply: (artifact, version) => {
      if (version === BAD.version) {
        throw new Error(`refusing to load ${version}`);
      }
      applied.push(version);
      live = artifact ?? "";
    },
    clock: (() => {
      let t = 0;
      return () => (t += 1);
    })(),
  });
  return {
    state,
    liveVersion: () => live,
    applied,
    drill: () =>
      runRollbackDrill(state, BAD, {
        knownGoodLive: () => live === GOOD.artifact,
        badLive: () => live === BAD.artifact,
      }),
  };
}

describe("S2 — apply() throws on the bad candidate inside runRollbackDrill", () => {
  it("control: the drill surfaces the apply failure to the caller", () => {
    const { drill } = buildThrowingOnBad();
    expect(drill).toThrow(/refusing to load bad-v99/);
  });

  it("active() still equals known-good after the failed activate", () => {
    const { state, drill, liveVersion } = buildThrowingOnBad();
    expect(drill).toThrow();
    // Live behaviour never changed …
    expect(liveVersion()).toBe(GOOD.artifact);
    // … so the controller must not claim the bad candidate is in service.
    expect(state.active()?.version).toBe(GOOD.version);
    expect(state.active()).toEqual(state.knownGood());
  });

  it("journal has no partial activate entry for the failed candidate", () => {
    const { state, drill } = buildThrowingOnBad();
    expect(drill).toThrow();
    const journal = state.journal();
    expect(journal.map((e) => e.action)).toEqual(["record_known_good"]);
    expect(journal.some((e) => e.action === "activate")).toBe(false);
    expect(journal.some((e) => e.toVersion === BAD.version)).toBe(false);
  });

  it("corrupt-state follow-up: recordKnownGood() after a failed activate must not bless the never-live candidate", () => {
    const { state, drill, liveVersion } = buildThrowingOnBad();
    expect(drill).toThrow();
    // An operator (or a retrying drill) marks "whatever is active" as
    // known-good. Live behaviour is still `good`, so known-good must stay good.
    state.recordKnownGood();
    expect(liveVersion()).toBe(GOOD.artifact);
    expect(state.knownGood()?.version).toBe(GOOD.version);
  });

  it("recovery: rollback() after the failed activate restores known-good and journals it from the real live version", () => {
    const { state, drill, applied } = buildThrowingOnBad();
    expect(drill).toThrow();
    state.rollback();
    expect(state.active()?.version).toBe(GOOD.version);
    const last = state.journal().at(-1);
    expect(last?.action).toBe("rollback");
    // The bad candidate was never live, so the journal must not say we rolled
    // back *from* it.
    expect(last?.fromVersion).toBe(GOOD.version);
    expect(applied.filter((v) => v === GOOD.version).length).toBeGreaterThanOrEqual(2);
  });

  it("disable() whose apply throws must not report the subsystem as disabled", () => {
    let live: string | null = "good";
    const state = new SubsystemReleaseState<string>({
      subsystem: "s2-throwing-disable",
      initial: GOOD,
      apply: (artifact) => {
        if (artifact === null) throw new Error("kill switch backend unavailable");
        live = artifact;
      },
    });
    expect(() => state.disable()).toThrow(/kill switch backend unavailable/);
    expect(live).toBe("good");
    expect(
      state.active()?.version,
      "controller reports disabled while live still serves good",
    ).toBe(GOOD.version);
    expect(state.journal().some((e) => e.action === "disable")).toBe(false);
  });

  it("rapid repeats: 50 failed activates never drift active() away from live", () => {
    const { state, liveVersion } = buildThrowingOnBad();
    state.recordKnownGood();
    for (let i = 0; i < 50; i += 1) {
      expect(() => state.activate({ ...BAD, version: BAD.version })).toThrow();
    }
    expect(liveVersion()).toBe(GOOD.artifact);
    expect(state.active()?.version).toBe(GOOD.version);
    expect(state.journal().filter((e) => e.action === "activate")).toHaveLength(0);
  });
});
