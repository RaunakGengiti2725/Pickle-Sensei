import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_MANIFEST,
  ModelRegistry,
  type ModelManifest,
  type ModelManifestEntry,
} from "../src/index.js";

const scorerEntry = (overrides: Partial<ModelManifestEntry>): ModelManifestEntry => ({
  id: "scorer.sm-v1",
  version: "sm-v1",
  task: "technique_scoring",
  runtime: "deterministic",
  executionTarget: "on_device",
  deploymentStatus: "production",
  supportedPlatforms: ["ios"],
  supportedStrokes: "all",
  inputSchemaVersion: 1,
  outputSchemaVersion: 1,
  artifactHash: null,
  artifactUri: null,
  trainingDatasetVersion: null,
  evaluationDatasetVersion: null,
  license: null,
  notes: "",
  ...overrides,
});

describe("ModelRegistry", () => {
  it("resolves the default manifest's production providers per platform", () => {
    const registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);
    expect(registry.resolve({ task: "pose_estimation", platform: "ios" })?.id).toBe(
      "pose.apple-vision",
    );
    expect(registry.resolve({ task: "pose_estimation", platform: "android" })?.id).toBe(
      "pose.mediapipe",
    );
    expect(
      registry.resolve({ task: "technique_scoring", platform: "ios", stroke: "forehand_drive" })
        ?.version,
    ).toBe("sm-v1");
  });

  it("returns null for genuinely absent tasks — no guessing, no fabrication", () => {
    const registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);
    expect(registry.resolve({ task: "ball_tracking", platform: "ios" })).toBeNull();
    expect(registry.resolve({ task: "paddle_detection", platform: "ios" })).toBeNull();
    expect(registry.resolve({ task: "temporal_encoding", platform: "ios" })).toBeNull();
    expect(registry.resolve({ task: "court_detection", platform: "ios" })).toBeNull();
  });

  it("registers the hierarchical stroke heuristic for AUTO DETECT (W4)", () => {
    // stroke_classification stopped being an absent task when the ported
    // heuristic shipped; its manifest entry is the provenance record the
    // fusion engine's declared-null route depends on.
    const registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);
    const entry = registry.resolve({ task: "stroke_classification", platform: "ios" });
    expect(entry?.id).toBe("stroke.heuristic-hierarchical");
    expect(entry?.version).toBe("stroke-heuristic-6");
    expect(entry?.runtime).toBe("deterministic");
    // The notes must keep the honesty ceiling explicit: no L3 without bounce.
    expect(entry?.notes).toContain("L3 needs bounce observation");
  });

  it("respects stroke support boundaries", () => {
    const registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);
    expect(
      registry.resolve({ task: "technique_scoring", platform: "ios", stroke: "overhead" }),
    ).toBeNull();
  });

  it("model replacement is a manifest change, not a code change", () => {
    const manifest: ModelManifest = {
      schemaVersion: 1,
      entries: [
        scorerEntry({}),
        scorerEntry({
          id: "scorer.learned",
          version: "sm-v9",
          runtime: "coreml",
          artifactHash: "a".repeat(64),
          artifactUri: "https://models.example/sm-v9.mlmodelc",
          deploymentStatus: "production",
        }),
      ],
    };
    const registry = new ModelRegistry(manifest);
    // Highest-version production entry wins; retiring sm-v1 is a status flip.
    expect(registry.resolve({ task: "technique_scoring", platform: "ios" })?.version).toBe("sm-v9");
  });

  it("keeps shadow candidates separate from production", () => {
    const manifest: ModelManifest = {
      schemaVersion: 1,
      entries: [
        scorerEntry({}),
        scorerEntry({ id: "scorer.candidate", version: "sm-v2rc1", deploymentStatus: "shadow" }),
      ],
    };
    const registry = new ModelRegistry(manifest);
    expect(registry.resolve({ task: "technique_scoring", platform: "ios" })?.id).toBe(
      "scorer.sm-v1",
    );
    expect(registry.shadowFor({ task: "technique_scoring", platform: "ios" })?.id).toBe(
      "scorer.candidate",
    );
  });

  it("rejects malformed manifests", () => {
    expect(
      () =>
        new ModelRegistry({
          schemaVersion: 1,
          entries: [scorerEntry({}), scorerEntry({})],
        }),
    ).toThrow(/Duplicate/);
    expect(
      () =>
        new ModelRegistry({
          schemaVersion: 1,
          entries: [scorerEntry({ artifactUri: "https://x", artifactHash: null })],
        }),
    ).toThrow(/artifact hash/);
    expect(() => ModelRegistry.fromJson('{"schemaVersion":9,"entries":[]}')).toThrow(
      /schema version/,
    );
  });
});
