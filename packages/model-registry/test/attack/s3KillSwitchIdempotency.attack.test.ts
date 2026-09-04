import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_MANIFEST,
  ModelRegistry,
  SubsystemReleaseState,
  type ModelManifest,
} from "../../src/index.js";

/**
 * ADVERSARIAL S3 — kill-switch idempotency.
 *
 * An operator under pressure double-fires the kill switch (two `disable()`
 * calls back to back, possibly from two terminals), then rolls back. The
 * controller must: journal exactly one `disable` entry per call (append-only
 * audit — neither collapsed nor duplicated), keep the subsystem out of
 * service between the calls, and restore known-good behaviour on rollback
 * with a single `rollback` entry. The live behaviour is observed through a
 * real ModelRegistry resolution, not through the controller's own getters.
 */

function liveHarness() {
  let liveRegistry: ModelRegistry | null = null;
  const applyCalls: Array<{ version: string | null; artifactIsNull: boolean }> = [];
  const state = new SubsystemReleaseState<ModelManifest>({
    subsystem: "model-bundle",
    initial: { version: "default-manifest-1", artifact: DEFAULT_MODEL_MANIFEST },
    apply: (manifest, version) => {
      applyCalls.push({ version, artifactIsNull: manifest === null });
      liveRegistry = manifest === null ? null : new ModelRegistry(manifest);
    },
  });
  // The constructor applies the initial artifact once (rollback.ts L63).
  expect(applyCalls).toEqual([{ version: "default-manifest-1", artifactIsNull: false }]);
  applyCalls.length = 0;
  const resolvePoseId = (): string | null =>
    liveRegistry?.resolve({ task: "pose_estimation", platform: "ios" })?.id ?? null;
  return { state, applyCalls, resolvePoseId };
}

describe("ADVERSARIAL S3: disable() twice then rollback()", () => {
  it("journals one disable entry per call, keeps service off between them, and rollback restores behaviour", () => {
    const { state, applyCalls, resolvePoseId } = liveHarness();
    state.recordKnownGood();
    expect(resolvePoseId()).toBe("pose.apple-vision");

    const firstDisableMs = state.disable();
    expect(resolvePoseId()).toBeNull();
    expect(state.active()).toBeNull();
    const secondDisableMs = state.disable();
    expect(resolvePoseId()).toBeNull();
    expect(state.active()).toBeNull();
    expect(firstDisableMs).toBeGreaterThanOrEqual(0);
    expect(secondDisableMs).toBeGreaterThanOrEqual(0);

    const disables = state.journal().filter((entry) => entry.action === "disable");
    expect(disables.length).toBe(2);
    // First disable transitions from the active version; the second is a
    // no-op transition null → null but is still recorded (audit trail).
    expect(disables[0]!.fromVersion).toBe("default-manifest-1");
    expect(disables[0]!.toVersion).toBeNull();
    expect(disables[1]!.fromVersion).toBeNull();
    expect(disables[1]!.toVersion).toBeNull();
    // Each disable reached the live side exactly once.
    expect(applyCalls.filter((call) => call.artifactIsNull)).toHaveLength(2);

    const rollbackMs = state.rollback();
    expect(rollbackMs).toBeGreaterThanOrEqual(0);
    expect(resolvePoseId()).toBe("pose.apple-vision");
    expect(state.active()?.version).toBe("default-manifest-1");
    expect(state.active()?.artifact).toBe(DEFAULT_MODEL_MANIFEST);

    const actions = state.journal().map((entry) => entry.action);
    expect(actions).toEqual(["record_known_good", "disable", "disable", "rollback"]);
    const rollbackEntry = state.journal()[3]!;
    expect(rollbackEntry.fromVersion).toBeNull();
    expect(rollbackEntry.toVersion).toBe("default-manifest-1");
    expect(applyCalls.at(-1)).toEqual({ version: "default-manifest-1", artifactIsNull: false });
  });

  it("rapid repeat: N disables produce exactly N journal entries and N apply(null) calls", () => {
    const { state, applyCalls, resolvePoseId } = liveHarness();
    state.recordKnownGood();
    const n = 50;
    for (let index = 0; index < n; index += 1) state.disable();
    expect(state.journal().filter((entry) => entry.action === "disable")).toHaveLength(n);
    expect(applyCalls.filter((call) => call.artifactIsNull)).toHaveLength(n);
    expect(resolvePoseId()).toBeNull();
    state.rollback();
    expect(resolvePoseId()).toBe("pose.apple-vision");
    expect(state.journal()).toHaveLength(n + 2);
  });

  it("disable → rollback → disable → rollback: known-good survives repeated cycles unchanged", () => {
    const { state, resolvePoseId } = liveHarness();
    state.recordKnownGood();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      state.disable();
      state.disable();
      expect(resolvePoseId()).toBeNull();
      state.rollback();
      expect(resolvePoseId()).toBe("pose.apple-vision");
      expect(state.knownGood()?.version).toBe("default-manifest-1");
    }
    const actions = state.journal().map((entry) => entry.action);
    expect(actions.filter((action) => action === "disable")).toHaveLength(10);
    expect(actions.filter((action) => action === "rollback")).toHaveLength(5);
  });

  it("recordKnownGood is refused while disabled, even after a double disable", () => {
    const { state } = liveHarness();
    state.recordKnownGood();
    state.disable();
    state.disable();
    expect(() => state.recordKnownGood()).toThrow(/cannot record known-good while disabled/);
    // Known-good is unchanged; rollback still works.
    expect(state.knownGood()?.version).toBe("default-manifest-1");
    expect(() => state.rollback()).not.toThrow();
  });

  it("journal is append-only: the array returned before the second disable does not change", () => {
    const { state } = liveHarness();
    state.recordKnownGood();
    state.disable();
    const before = state.journal();
    const snapshot = JSON.parse(JSON.stringify(before)) as unknown[];
    state.disable();
    // Either a defensive copy (unchanged) or a frozen live view — in both
    // cases the entries seen before must be identical afterwards.
    expect(JSON.parse(JSON.stringify(before.slice(0, snapshot.length)))).toEqual(snapshot);
    expect(state.journal().length).toBe(snapshot.length + 1);
  });
});
