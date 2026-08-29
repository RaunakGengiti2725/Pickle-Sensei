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
