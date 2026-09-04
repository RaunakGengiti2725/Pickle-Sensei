import { describe, expect, it } from "vitest";
import { SHOT_TYPES } from "@pickle/shared-types";
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
  commit: null,
  splits: null,
  metrics: null,
  supportedCaptureEnvelope: null,
  calibrationVersion: null,
  runtimeRequirements: [],
  promotionDate: null,
  rollbackPredecessor: null,
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
    expect(entry?.version).toBe("stroke-heuristic-7");
    expect(entry?.runtime).toBe("deterministic");
    // The notes must keep the honesty ceiling explicit: no L3 without bounce.
    expect(entry?.notes).toContain("L3 needs bounce observation");
  });

  it("resolves technique scoring for every stroke — no unreleased techniques", () => {
    const registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);
    for (const stroke of SHOT_TYPES) {
      expect(
        registry.resolve({ task: "technique_scoring", platform: "ios", stroke })?.version,
        `technique_scoring must resolve for "${stroke}"`,
      ).toBe("sm-v1");
      expect(
        registry.resolve({ task: "technique_scoring", platform: "android", stroke })?.version,
        `technique_scoring must resolve for "${stroke}" on android`,
      ).toBe("sm-v1");
    }
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

  it("registers every named production pipeline component with a concrete version", () => {
    const registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);
    const expected: Array<[Parameters<ModelRegistry["resolve"]>[0]["task"], string, string]> = [
      ["target_player_tracking", "server", "player-track-1.1"],
      ["stroke_event_detection", "server", "stroke-event-1"],
      ["paddle_detection", "server", "dfine-medium-coco@transformers"],
      ["paddle_tracking", "server", "paddle-track-2"],
      ["paddle_ownership", "server", "paddle-track-2"],
      ["paddle_selection", "server", "paddle-track-2"],
      ["paddle_track_merge", "server", "paddle-track-2"],
      ["ball_detection", "server", "ball-candidate-gate-1"],
      ["ball_tracking", "server", "ball-track-2"],
      ["contact_estimation", "server", "contact-evidence-4.4"],
      ["phase_segmentation", "ios", "phase-geometry-1"],
      ["stroke_classification", "ios", "stroke-heuristic-7"],
      ["stroke_auto_resolution", "ios", "fusion-1"],
      ["capture_completion", "ios", "capture-completion-params-v1"],
    ];
    for (const [task, platform, version] of expected) {
      const entry = registry.resolve({ task, platform: platform as "ios" | "server" });
      expect(entry, `no production entry for ${task}`).not.toBeNull();
      expect(entry!.version).toBe(version);
    }
  });

  it("keeps flag-gated ownership components out of production", () => {
    // ownership-guard-v1 and ownership-posterior-v1 are OFF by default in
    // the shipping pipeline; the registry must say candidate, not production.
    const registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);
    expect(registry.byId("paddle.ownership-guard", "ownership-guard-v1")?.deploymentStatus).toBe(
      "candidate",
    );
    expect(
      registry.byId("contact.ownership-posterior", "ownership-posterior-v1")?.deploymentStatus,
    ).toBe("candidate");
  });

  it("seeds no fabricated lineage: no metrics, splits, or calibration without a real dataset", () => {
    for (const entry of DEFAULT_MODEL_MANIFEST.entries) {
      expect(entry.metrics, `${entry.id}@${entry.version} claims metrics`).toBeNull();
      expect(entry.splits, `${entry.id}@${entry.version} claims splits`).toBeNull();
      expect(
        entry.calibrationVersion,
        `${entry.id}@${entry.version} claims calibration`,
      ).toBeNull();
      expect(
        entry.promotionDate,
        `${entry.id}@${entry.version} claims an unrecorded promotion date`,
      ).toBeNull();
    }
  });

  it("forbids anonymous version aliases", () => {
    for (const alias of ["latest", "LATEST", "current", "head", ""]) {
      expect(
        () =>
          new ModelRegistry({
            schemaVersion: 1,
            entries: [scorerEntry({ id: "scorer.alias", version: alias })],
          }),
        `alias "${alias}" was accepted`,
      ).toThrow(/version alias/);
    }
  });

  it("byId requires an explicit version — there is no anonymous latest", () => {
    const registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);
    expect(registry.byId("scorer.sm-v1", "sm-v1")?.task).toBe("technique_scoring");
    expect(registry.byId("scorer.sm-v1", "latest")).toBeNull();
    expect(registry.byId("scorer.sm-v1", "")).toBeNull();
  });

  it("registered artifacts are immutable — no in-place overwrite, ever", () => {
    const registry = new ModelRegistry({ schemaVersion: 1, entries: [scorerEntry({})] });
    // Overwriting with DIFFERENT content is rejected.
    expect(() => registry.withEntry(scorerEntry({ notes: "silently retuned" }))).toThrow(
      /immutable/,
    );
    // Overwriting with IDENTICAL content is rejected too: re-registration
    // is always a version bump, never a rewrite.
    expect(() => registry.withEntry(scorerEntry({}))).toThrow(/immutable/);
    // Appending a NEW version returns a new registry; the original is untouched.
    const next = registry.withEntry(scorerEntry({ version: "sm-v2" }));
    expect(next.byId("scorer.sm-v1", "sm-v2")).not.toBeNull();
    expect(registry.byId("scorer.sm-v1", "sm-v2")).toBeNull();
  });

  it("validates rollback predecessors against the manifest", () => {
    expect(
      () =>
        new ModelRegistry({
          schemaVersion: 1,
          entries: [scorerEntry({ rollbackPredecessor: "scorer.sm-v0@sm-v0" })],
        }),
    ).toThrow(/not registered/);
    expect(
      () =>
        new ModelRegistry({
          schemaVersion: 1,
          entries: [scorerEntry({ rollbackPredecessor: "scorer.sm-v1@sm-v1" })],
        }),
    ).toThrow(/own rollback predecessor/);
    // The default manifest's only rollback edge points at a registered entry.
    const registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);
    const v7 = registry.byId("stroke.heuristic-hierarchical", "stroke-heuristic-7");
    expect(v7?.rollbackPredecessor).toBe("stroke.heuristic-hierarchical@stroke-heuristic-5");
    expect(
      registry.byId("stroke.heuristic-hierarchical", "stroke-heuristic-5")?.deploymentStatus,
    ).toBe("deprecated");
  });

  it("couples splits to a training dataset and metrics to an eval dataset", () => {
    expect(
      () =>
        new ModelRegistry({
          schemaVersion: 1,
          entries: [
            scorerEntry({
              splits: { train: "t", validation: "v", test: "x" },
              trainingDatasetVersion: null,
            }),
          ],
        }),
    ).toThrow(/training dataset/);
    expect(
      () =>
        new ModelRegistry({
          schemaVersion: 1,
          entries: [scorerEntry({ metrics: { accuracy: 0.9 }, evaluationDatasetVersion: null })],
        }),
    ).toThrow(/evaluation dataset/);
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
