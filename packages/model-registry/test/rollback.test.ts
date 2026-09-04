import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_MANIFEST,
  ModelRegistry,
  runRollbackDrill,
  SubsystemReleaseState,
  type ModelManifest,
  type ModelManifestEntry,
  type RollbackJournalEntry,
} from "../src/index.js";

/**
 * i06-rollback-drill: unit coverage of the release-state controller plus a
 * real drill against model-bundle selection (the actual DEFAULT_MODEL_MANIFEST
 * versus a deliberately bad candidate manifest). All measured durations here
 * are in-process Linux test-environment numbers, not production rollback
 * times.
 */

const badPoseEntry: ModelManifestEntry = {
  id: "pose.broken-candidate",
  version: "broken-pose-99",
  task: "pose_estimation",
  runtime: "onnx",
  executionTarget: "on_device",
  deploymentStatus: "production",
  supportedPlatforms: ["ios", "android"],
  supportedStrokes: "all",
  inputSchemaVersion: 1,
  outputSchemaVersion: 1,
  artifactHash: "0".repeat(64),
  artifactUri: "https://example.invalid/broken-pose-99.onnx",
  trainingDatasetVersion: null,
  evaluationDatasetVersion: null,
  commit: null,
  splits: null,
  metrics: null,
  supportedCaptureEnvelope: null,
  calibrationVersion: null,
  runtimeRequirements: [],
  promotionDate: null,
  rollbackPredecessor: null,
  license: null,
  notes: "Deliberately bad drill candidate — never ship.",
};

const badManifest: ModelManifest = {
  schemaVersion: 1,
  entries: [badPoseEntry],
};

describe("SubsystemReleaseState", () => {
  it("refuses to roll back before a known-good version is recorded", () => {
    const state = new SubsystemReleaseState<string>({
      subsystem: "example",
      initial: { version: "v1", artifact: "a" },
      apply: () => {},
    });
    expect(() => state.rollback()).toThrow(/no known-good version recorded/);
  });

  it("refuses to record known-good while disabled", () => {
    const state = new SubsystemReleaseState<string>({
      subsystem: "example",
      initial: { version: "v1", artifact: "a" },
      apply: () => {},
    });
    state.disable();
    expect(() => state.recordKnownGood()).toThrow(/cannot record known-good while disabled/);
  });

  it("journals every transition append-only with versions and durations", () => {
    let tick = 0;
    const state = new SubsystemReleaseState<string>({
      subsystem: "example",
      initial: { version: "v1", artifact: "a" },
      apply: () => {},
      clock: () => (tick += 5),
    });
    state.recordKnownGood();
    state.activate({ version: "v2", artifact: "b" });
    state.disable();
    state.rollback();
    const actions = state.journal().map((entry: RollbackJournalEntry) => entry.action);
    expect(actions).toEqual(["record_known_good", "activate", "disable", "rollback"]);
    const rollbackEntry = state.journal()[3]!;
    expect(rollbackEntry.fromVersion).toBeNull();
    expect(rollbackEntry.toVersion).toBe("v1");
    expect(rollbackEntry.durationMs).toBe(5);
    expect(state.journal().every((entry) => entry.outcome === "applied")).toBe(true);
  });
});

describe("SubsystemReleaseState transition integrity (ADJ-05)", () => {
  /** apply() that refuses one version — the live side never receives it. */
  function stateRejecting(rejectVersion: string, clock?: () => number) {
    const applied: Array<string | null> = [];
    const state = new SubsystemReleaseState<string>({
      subsystem: "example",
      initial: { version: "v1", artifact: "a" },
      apply: (_artifact, version) => {
        if (version === rejectVersion) {
          throw new Error(`live side refused ${version}`);
        }
        applied.push(version);
      },
      ...(clock ? { clock } : {}),
    });
    return { state, applied };
  }

  it("activate() whose apply() throws keeps the previous version active and journals the failure", () => {
    const { state, applied } = stateRejecting("v2");
    expect(() => state.activate({ version: "v2", artifact: "b" })).toThrow(/refused v2/);

    expect(state.active()?.version).toBe("v1");
    expect(state.active()?.artifact).toBe("a");
    expect(applied).toEqual(["v1"]);

    const failed = state.journal().at(-1)!;
    expect(failed.action).toBe("activate");
    expect(failed.fromVersion).toBe("v1");
    expect(failed.toVersion).toBe("v2");
    expect(failed.outcome).toBe("failed");
    expect(failed.error).toMatch(/refused v2/);

    state.disable();
    const disabled = state.journal().at(-1)!;
    expect(disabled.action).toBe("disable");
    expect(disabled.fromVersion).toBe("v1");
    expect(disabled.toVersion).toBeNull();
    expect(disabled.outcome).toBe("applied");
    expect(state.active()).toBeNull();
    expect(applied).toEqual(["v1", null]);
  });

  it("disable() whose apply() throws keeps the subsystem in service and journals the failure", () => {
    const applied: Array<string | null> = [];
    const state = new SubsystemReleaseState<string>({
      subsystem: "example",
      initial: { version: "v1", artifact: "a" },
      apply: (_artifact, version) => {
        if (version === null) {
          throw new Error("kill switch unavailable");
        }
        applied.push(version);
      },
    });
    expect(() => state.disable()).toThrow(/kill switch unavailable/);
    expect(state.active()?.version).toBe("v1");
    const failed = state.journal().at(-1)!;
    expect(failed).toMatchObject({
      action: "disable",
      fromVersion: "v1",
      toVersion: null,
      outcome: "failed",
    });
    // Still in service: recording known-good is allowed and describes v1.
    state.recordKnownGood();
    expect(state.knownGood()?.version).toBe("v1");
  });

  it("rollback() whose apply() throws keeps the current state and journals the failure", () => {
    // v1 is applied through the constructor before the rejection is armed —
    // reject it only on the way back.
    let rejectV1 = false;
    const rejecting = new SubsystemReleaseState<string>({
      subsystem: "example",
      initial: { version: "v1", artifact: "a" },
      apply: (_artifact, version) => {
        if (rejectV1 && version === "v1") {
          throw new Error("v1 artifact missing");
        }
      },
    });
    rejecting.recordKnownGood();
    rejecting.activate({ version: "v2", artifact: "b" });
    rejectV1 = true;
    expect(() => rejecting.rollback()).toThrow(/v1 artifact missing/);
    expect(rejecting.active()?.version).toBe("v2");
    expect(rejecting.knownGood()?.version).toBe("v1");
    expect(rejecting.journal().at(-1)).toMatchObject({
      action: "rollback",
      fromVersion: "v2",
      toVersion: "v1",
      outcome: "failed",
    });
  });

  it("stamps every journal entry (including failures) with the injected clock", () => {
    const { state } = stateRejecting("v2", () => 1_000);
    state.recordKnownGood();
    expect(() => state.activate({ version: "v2", artifact: "b" })).toThrow();
    state.activate({ version: "v3", artifact: "c" });
    state.disable();
    state.rollback();
    const entries = state.journal();
    expect(entries.map((entry) => entry.action)).toEqual([
      "record_known_good",
      "activate",
      "activate",
      "disable",
      "rollback",
    ]);
    expect(entries.map((entry) => entry.outcome)).toEqual([
      "applied",
      "failed",
      "applied",
      "applied",
      "applied",
    ]);
    for (const entry of entries) {
      expect(entry.atEpochMs).toBe(1_000);
      expect(entry.durationMs).toBe(0);
    }
  });

  it("only the default clock may read the wall clock (structural pin)", () => {
    const source = readFileSync(new URL("../src/rollback.ts", import.meta.url), "utf8");
    const lines = source.split("\n").filter((line) => line.includes("Date.now"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^const defaultClock: DurationClock = \(\) => Date\.now\(\);$/);
  });

  it("journal() is a snapshot: mutating a returned entry does not alter the journal", () => {
    const state = new SubsystemReleaseState<string>({
      subsystem: "example",
      initial: { version: "v1", artifact: "a" },
      apply: () => {},
    });
    state.recordKnownGood();
    const first = state.journal()[0]!;
    first.toVersion = "x";
    first.action = "rollback";
    expect(state.journal()[0]).toMatchObject({ action: "record_known_good", toVersion: "v1" });
    const snapshot = state.journal() as RollbackJournalEntry[];
    snapshot.length = 0;
    expect(state.journal()).toHaveLength(1);
  });

  it("knownGood()/active() are snapshots: caller-owned objects are never aliased", () => {
    const initial = { version: "v1", artifact: "a" };
    const state = new SubsystemReleaseState<string>({
      subsystem: "example",
      initial,
      apply: () => {},
    });
    initial.version = "tampered-initial";
    expect(state.active()?.version).toBe("v1");

    const candidate = { version: "v2", artifact: "b" };
    state.activate(candidate);
    state.recordKnownGood();
    candidate.version = "tampered-candidate";
    expect(state.active()?.version).toBe("v2");
    expect(state.knownGood()?.version).toBe("v2");

    const known = state.knownGood()!;
    known.version = "tampered-known-good";
    expect(state.knownGood()?.version).toBe("v2");
    const active = state.active()!;
    active.version = "tampered-active";
    expect(state.active()?.version).toBe("v2");

    state.disable();
    state.rollback();
    expect(state.active()?.version).toBe("v2");
    expect(state.journal().at(-1)).toMatchObject({ action: "rollback", toVersion: "v2" });
  });
});

describe("runRollbackDrill candidate validation (ADJ-05)", () => {
  function liveState() {
    let live: string | null = null;
    const state = new SubsystemReleaseState<string>({
      subsystem: "example",
      initial: { version: "v1", artifact: "a" },
      apply: (artifact) => {
        live = artifact;
      },
    });
    return {
      state,
      verify: {
        knownGoodLive: () => live === "a",
        badLive: () => live === "bad",
      },
    };
  }

  it("rejects the active artifact itself as the bad candidate", () => {
    const { state, verify } = liveState();
    expect(() => runRollbackDrill(state, state.active()!, verify)).toThrow(
      /bad candidate version "v1" is already the active version/,
    );
    expect(state.journal()).toHaveLength(0);
    expect(state.knownGood()).toBeNull();
  });

  it("rejects a bad candidate whose version equals the active version", () => {
    const { state, verify } = liveState();
    expect(() => runRollbackDrill(state, { version: "v1", artifact: "bad" }, verify)).toThrow(
      /bad candidate version "v1" is already the active version/,
    );
    expect(state.journal()).toHaveLength(0);
    expect(state.active()?.artifact).toBe("a");
  });

  it("a drill whose bad candidate cannot be applied leaves known-good live and journaled", () => {
    let live: string | null = "a";
    const state = new SubsystemReleaseState<string>({
      subsystem: "example",
      initial: { version: "v1", artifact: "a" },
      apply: (artifact, version) => {
        if (version === "v99-bad") {
          throw new Error("candidate artifact failed to load");
        }
        live = artifact;
      },
    });
    expect(() =>
      runRollbackDrill(
        state,
        { version: "v99-bad", artifact: "bad" },
        { knownGoodLive: () => live === "a", badLive: () => live === "bad" },
      ),
    ).toThrow(/candidate artifact failed to load/);
    expect(live).toBe("a");
    expect(state.active()?.version).toBe("v1");
    expect(state.journal().map((entry) => [entry.action, entry.outcome])).toEqual([
      ["record_known_good", "applied"],
      ["activate", "failed"],
    ]);
  });
});

describe("model bundle selection rollback drill (linux-test measurement)", () => {
  it("kill switch removes resolution; rollback restores DEFAULT_MODEL_MANIFEST behavior", () => {
    // Live selection: the registry the (simulated) app resolves through.
    let liveRegistry: ModelRegistry | null = null;
    const resolvePoseId = (): string | null =>
      liveRegistry?.resolve({ task: "pose_estimation", platform: "ios" })?.id ?? null;

    const state = new SubsystemReleaseState<ModelManifest>({
      subsystem: "model-bundle",
      initial: { version: "default-manifest-1", artifact: DEFAULT_MODEL_MANIFEST },
      apply: (manifest) => {
        liveRegistry = manifest === null ? null : new ModelRegistry(manifest);
      },
    });

    const result = runRollbackDrill(
      state,
      { version: "broken-manifest-99", artifact: badManifest },
      {
        knownGoodLive: () => resolvePoseId() === "pose.apple-vision",
        badLive: () => resolvePoseId() === "pose.broken-candidate",
      },
    );

    expect(result.badWasLive).toBe(true);
    expect(result.recovered).toBe(true);
    expect(result.environment).toBe("linux-test");
    expect(result.knownGoodVersion).toBe("default-manifest-1");
    expect(result.timeToDisableMs).toBeGreaterThanOrEqual(0);
    expect(result.timeToRollbackMs).toBeGreaterThanOrEqual(0);
    // After the drill, live behavior is the known-good manifest again.
    expect(resolvePoseId()).toBe("pose.apple-vision");
  });

  it("drill aborts if the pre-drill state does not match known-good behavior", () => {
    const state = new SubsystemReleaseState<ModelManifest>({
      subsystem: "model-bundle",
      initial: { version: "default-manifest-1", artifact: DEFAULT_MODEL_MANIFEST },
      apply: () => {},
    });
    expect(() =>
      runRollbackDrill(
        state,
        { version: "broken-manifest-99", artifact: badManifest },
        { knownGoodLive: () => false, badLive: () => true },
      ),
    ).toThrow(/pre-drill state does not match known-good behavior/);
  });
});
