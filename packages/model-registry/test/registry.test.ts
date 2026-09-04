import { describe, expect, it } from "vitest";
import { SHOT_TYPES } from "@pickle/shared-types";
import {
  DEFAULT_MODEL_MANIFEST,
  ModelRegistry,
  ModelRegistryValidationError,
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
    const learned = scorerEntry({
      id: "scorer.learned",
      version: "sm-v9",
      runtime: "coreml",
      artifactHash: "a".repeat(64),
      artifactUri: "https://models.example/sm-v9.mlmodelc",
      deploymentStatus: "production",
    });
    // Retiring sm-v1 is a status flip; the promoted entry is then the ONLY
    // production entry for the task and resolves without any ordering rule.
    const registry = new ModelRegistry({
      schemaVersion: 1,
      entries: [scorerEntry({ deploymentStatus: "deprecated" }), learned],
    });
    expect(registry.resolve({ task: "technique_scoring", platform: "ios" })?.version).toBe("sm-v9");
    // Leaving both in production is ambiguous and must never be settled by
    // string order of the version labels.
    expect(
      () => new ModelRegistry({ schemaVersion: 1, entries: [scorerEntry({}), learned] }),
    ).toThrow(/production/);
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
      ["target_player_tracking", "server", "player-track-1"],
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
    // (Registered as a candidate: a second production entry for the same
    // task/platform would be ambiguous and is rejected — see ADJ-04 below.)
    const next = registry.withEntry(
      scorerEntry({ version: "sm-v2", deploymentStatus: "candidate" }),
    );
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

describe("ModelRegistry validation hardening (ADJ-04)", () => {
  const loose = (manifest: unknown): ModelManifest => manifest as ModelManifest;
  const validationErrorFor = (build: () => unknown): ModelRegistryValidationError => {
    let caught: unknown = null;
    try {
      build();
    } catch (error) {
      caught = error;
    }
    expect(caught, "expected the manifest to be rejected").not.toBeNull();
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(caught).toBeInstanceOf(ModelRegistryValidationError);
    expect(caught).toBeInstanceOf(Error);
    return caught as ModelRegistryValidationError;
  };

  it("rejects a manifest whose entries are not an array with a validation error, not a TypeError", () => {
    for (const json of [
      '{"entries":null}',
      '{"schemaVersion":1,"entries":null}',
      '{"schemaVersion":1,"entries":{}}',
      '{"schemaVersion":1}',
      "null",
      "[]",
      '"manifest"',
    ]) {
      const error = validationErrorFor(() => ModelRegistry.fromJson(json));
      expect(error.message, json).toMatch(/entries|manifest must be an object/);
      expect(error.name).toBe("ModelRegistryValidationError");
    }
    expect(validationErrorFor(() => ModelRegistry.fromJson('{"entries":null}')).message).toMatch(
      /entries/,
    );
    expect(
      validationErrorFor(() => new ModelRegistry(loose({ schemaVersion: 1, entries: {} }))).message,
    ).toMatch(/entries/);
    // Malformed JSON text is a manifest problem too, not a bare SyntaxError.
    expect(validationErrorFor(() => ModelRegistry.fromJson("{not json")).message).toMatch(/JSON/);
  });

  it("rejects entries with missing or mistyped fields by name", () => {
    const { supportedPlatforms: _dropped, ...withoutPlatforms } = scorerEntry({});
    expect(
      validationErrorFor(
        () => new ModelRegistry(loose({ schemaVersion: 1, entries: [withoutPlatforms] })),
      ).message,
    ).toMatch(/supportedPlatforms/);
    expect(
      validationErrorFor(
        () =>
          new ModelRegistry(
            loose({ schemaVersion: 1, entries: [{ ...scorerEntry({}), version: 7 }] }),
          ),
      ).message,
    ).toMatch(/version/);
    expect(
      validationErrorFor(
        () =>
          new ModelRegistry(
            loose({ schemaVersion: 1, entries: [{ ...scorerEntry({}), version: null }] }),
          ),
      ).message,
    ).toMatch(/version/);
    expect(
      validationErrorFor(() => new ModelRegistry(loose({ schemaVersion: 1, entries: [null] })))
        .message,
    ).toMatch(/entries\[0\]/);
    expect(
      validationErrorFor(() => new ModelRegistry(loose({ schemaVersion: 1, entries: ["x"] })))
        .message,
    ).toMatch(/entries\[0\]/);
    for (const [field, value] of [
      ["task", "mind_reading"],
      ["runtime", "magic"],
      ["executionTarget", "cloud"],
      ["deploymentStatus", "live"],
      ["supportedPlatforms", ["web"]],
      ["supportedPlatforms", ["ios", "ios"]],
      ["supportedPlatforms", "ios"],
      ["supportedStrokes", ["smash"]],
      ["supportedStrokes", "any"],
      ["inputSchemaVersion", 0],
      ["outputSchemaVersion", 1.5],
      ["runtimeRequirements", "ios-vision-framework"],
      ["runtimeRequirements", [1]],
      ["notes", null],
      ["metrics", { accuracy: "high" }],
      ["splits", { train: "t", validation: "v" }],
      ["promotionDate", "yesterday"],
      ["artifactUri", ""],
      ["license", 7],
      ["commit", ""],
    ] as const) {
      const error = validationErrorFor(
        () =>
          new ModelRegistry(
            loose({
              schemaVersion: 1,
              entries: [
                {
                  ...scorerEntry({
                    trainingDatasetVersion: "ds@v1",
                    evaluationDatasetVersion: "ds@v1",
                  }),
                  [field]: value,
                },
              ],
            }),
          ),
      );
      expect(error.message, `${field}=${JSON.stringify(value)}`).toContain(field);
    }
    // Unknown keys are typos until proven otherwise.
    expect(
      validationErrorFor(
        () =>
          new ModelRegistry(
            loose({
              schemaVersion: 1,
              entries: [{ ...scorerEntry({}), supportedPlatform: ["ios"] }],
            }),
          ),
      ).message,
    ).toMatch(/supportedPlatform\b/);
  });

  it("reports every problem of a broken manifest at once", () => {
    const error = validationErrorFor(
      () =>
        new ModelRegistry(
          loose({
            schemaVersion: 1,
            entries: [
              { ...scorerEntry({}), supportedStrokes: [] },
              { ...scorerEntry({ id: "scorer.other" }), version: 3 },
            ],
          }),
        ),
    );
    expect(error.problems.length).toBeGreaterThanOrEqual(2);
    expect(error.message).toMatch(/supportedStrokes/);
    expect(error.message).toMatch(/version/);
  });

  it("requires supportedStrokes to name at least one stroke or 'all'", () => {
    expect(
      validationErrorFor(
        () =>
          new ModelRegistry({ schemaVersion: 1, entries: [scorerEntry({ supportedStrokes: [] })] }),
      ).message,
    ).toMatch(/supportedStrokes/);
    expect(
      validationErrorFor(
        () =>
          new ModelRegistry({
            schemaVersion: 1,
            entries: [scorerEntry({ supportedStrokes: ["dink", "dink"] })],
          }),
      ).message,
    ).toMatch(/supportedStrokes/);
    const registry = new ModelRegistry({
      schemaVersion: 1,
      entries: [scorerEntry({ supportedStrokes: ["dink"] })],
    });
    expect(
      registry.resolve({ task: "technique_scoring", platform: "ios", stroke: "dink" })?.id,
    ).toBe("scorer.sm-v1");
    expect(
      registry.resolve({ task: "technique_scoring", platform: "ios", stroke: "serve" }),
    ).toBeNull();
  });

  it("requires artifactHash to be a lowercase 64-hex sha256 whenever an artifact is declared", () => {
    const uri = "https://models.example/sm-v9.mlmodelc";
    for (const bad of [
      "not-a-hash",
      "",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      `${"a".repeat(63)}g`,
      `sha256:${"a".repeat(64)}`,
      ` ${"a".repeat(64)}`,
    ]) {
      const error = validationErrorFor(
        () =>
          new ModelRegistry({
            schemaVersion: 1,
            entries: [scorerEntry({ artifactUri: uri, artifactHash: bad })],
          }),
      );
      expect(error.message, JSON.stringify(bad)).toMatch(/artifactHash/);
    }
    // A malformed hash is wrong even for a built-in artifact with no URI.
    expect(
      validationErrorFor(
        () =>
          new ModelRegistry({
            schemaVersion: 1,
            entries: [scorerEntry({ artifactHash: "deadbeef" })],
          }),
      ).message,
    ).toMatch(/artifactHash/);
    expect(
      validationErrorFor(
        () =>
          new ModelRegistry(
            loose({ schemaVersion: 1, entries: [{ ...scorerEntry({}), artifactHash: 42 }] }),
          ),
      ).message,
    ).toMatch(/artifactHash/);
    const ok = new ModelRegistry({
      schemaVersion: 1,
      entries: [scorerEntry({ artifactUri: uri, artifactHash: "0123456789abcdef".repeat(4) })],
    });
    expect(ok.byId("scorer.sm-v1", "sm-v1")?.artifactHash).toBe("0123456789abcdef".repeat(4));
  });

  it("refuses two production entries that could answer the same resolve() query", () => {
    const second = scorerEntry({ id: "scorer.other", version: "sm-v1b" });
    for (const entries of [
      [scorerEntry({}), second],
      // Version labels that string-sort either way — order must never decide.
      [scorerEntry({ version: "sm-v10" }), scorerEntry({ id: "scorer.z", version: "sm-v2" })],
      [scorerEntry({ version: "sm-v2" }), scorerEntry({ id: "scorer.z", version: "sm-v10" })],
      // Overlap through a shared platform in a wider platform list.
      [
        scorerEntry({ supportedPlatforms: ["ios", "android"] }),
        scorerEntry({ id: "scorer.other", supportedPlatforms: ["android", "server"] }),
      ],
      // Overlap through a shared stroke: "all" overlaps every explicit list.
      [scorerEntry({}), scorerEntry({ id: "scorer.dink", supportedStrokes: ["dink"] })],
      [
        scorerEntry({ supportedStrokes: ["dink", "serve"] }),
        scorerEntry({ id: "scorer.dink", supportedStrokes: ["serve", "volley"] }),
      ],
    ]) {
      const error = validationErrorFor(() => new ModelRegistry({ schemaVersion: 1, entries }));
      expect(error.message).toMatch(/production/);
      expect(error.message).toMatch(/technique_scoring/);
    }
    // Disjoint coverage is a legitimate split, not ambiguity.
    const split = new ModelRegistry({
      schemaVersion: 1,
      entries: [
        scorerEntry({ supportedStrokes: ["dink"] }),
        scorerEntry({ id: "scorer.drive", supportedStrokes: ["forehand_drive"] }),
        scorerEntry({ id: "scorer.android", supportedPlatforms: ["android"] }),
        scorerEntry({ id: "scorer.shadow", version: "sm-v2rc1", deploymentStatus: "shadow" }),
        scorerEntry({ id: "scorer.old", version: "sm-v0", deploymentStatus: "deprecated" }),
        scorerEntry({ id: "scorer.older", version: "sm-v0a", deploymentStatus: "deprecated" }),
      ],
    });
    expect(split.resolve({ task: "technique_scoring", platform: "ios", stroke: "dink" })?.id).toBe(
      "scorer.sm-v1",
    );
    expect(
      split.resolve({ task: "technique_scoring", platform: "ios", stroke: "forehand_drive" })?.id,
    ).toBe("scorer.drive");
    expect(split.resolve({ task: "technique_scoring", platform: "android" })?.id).toBe(
      "scorer.android",
    );
    // A stroke-less query over per-stroke production entries has no single
    // answer; that is reported, never picked by string order.
    expect(() => split.resolve({ task: "technique_scoring", platform: "ios" })).toThrow(
      /ambiguous/i,
    );
    // Multiple deprecated/shadow entries per task remain legal (history).
    expect(
      split.resolve({ task: "technique_scoring", platform: "ios", status: "deprecated" }),
    ).not.toBeNull();
    // withEntry() runs the same guard.
    const one = new ModelRegistry({ schemaVersion: 1, entries: [scorerEntry({})] });
    expect(() => one.withEntry(second)).toThrow(/production/);
  });

  it("rejects rollbackPredecessor cycles of any length", () => {
    const a = scorerEntry({
      id: "scorer.a",
      version: "v1",
      deploymentStatus: "deprecated",
      rollbackPredecessor: "scorer.b@v1",
    });
    const b = scorerEntry({
      id: "scorer.b",
      version: "v1",
      deploymentStatus: "deprecated",
      rollbackPredecessor: "scorer.a@v1",
    });
    expect(
      validationErrorFor(() => new ModelRegistry({ schemaVersion: 1, entries: [a, b] })).message,
    ).toMatch(/cycle/);
    const c = scorerEntry({
      id: "scorer.c",
      version: "v1",
      deploymentStatus: "deprecated",
      rollbackPredecessor: "scorer.a@v1",
    });
    expect(
      validationErrorFor(
        () =>
          new ModelRegistry({
            schemaVersion: 1,
            entries: [a, { ...b, rollbackPredecessor: "scorer.c@v1" }, c],
          }),
      ).message,
    ).toMatch(/cycle/);
    // A cycle reachable from a production entry is caught as well.
    expect(
      validationErrorFor(
        () =>
          new ModelRegistry({
            schemaVersion: 1,
            entries: [
              scorerEntry({ rollbackPredecessor: "scorer.a@v1" }),
              a,
              { ...b, rollbackPredecessor: "scorer.c@v1" },
              c,
            ],
          }),
      ).message,
    ).toMatch(/cycle/);
    // An acyclic chain is fine.
    const chain = new ModelRegistry({
      schemaVersion: 1,
      entries: [
        scorerEntry({ rollbackPredecessor: "scorer.a@v1" }),
        a,
        { ...b, rollbackPredecessor: "scorer.c@v1" },
        { ...c, rollbackPredecessor: null },
      ],
    });
    expect(chain.byId("scorer.c", "v1")?.rollbackPredecessor).toBeNull();
  });

  it("is immune to mutation of the input manifest and of returned entries", () => {
    const manifest: ModelManifest = { schemaVersion: 1, entries: [scorerEntry({})] };
    const registry = new ModelRegistry(manifest);
    const before = registry.resolve({ task: "technique_scoring", platform: "ios" });
    expect(before?.version).toBe("sm-v1");

    // Caller keeps mutating the object it passed in.
    manifest.entries.push(scorerEntry({ id: "scorer.sneaky", version: "sm-v99" }));
    manifest.entries[0]!.deploymentStatus = "deprecated";
    manifest.entries[0]!.supportedPlatforms.push("server");
    manifest.entries[0]!.version = "sm-v0";
    expect(registry.resolve({ task: "technique_scoring", platform: "ios" })?.version).toBe("sm-v1");
    expect(registry.resolve({ task: "technique_scoring", platform: "server" })).toBeNull();
    expect(registry.list()).toHaveLength(1);

    // Returned entries are deep-frozen: nothing reachable from them is writable.
    for (const entry of [
      before!,
      registry.list()[0]!,
      registry.byId("scorer.sm-v1", "sm-v1")!,
      registry.list("technique_scoring")[0]!,
    ]) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.supportedPlatforms)).toBe(true);
      expect(Object.isFrozen(entry.runtimeRequirements)).toBe(true);
      expect(() => {
        (entry as { deploymentStatus: string }).deploymentStatus = "deprecated";
      }).toThrow(TypeError);
      expect(() => {
        (entry.supportedPlatforms as string[]).push("server");
      }).toThrow(TypeError);
    }
    expect(registry.resolve({ task: "technique_scoring", platform: "ios" })?.deploymentStatus).toBe(
      "production",
    );
    // Nested lineage objects are frozen too.
    const lineage = new ModelRegistry({
      schemaVersion: 1,
      entries: [
        scorerEntry({
          trainingDatasetVersion: "ds@v1",
          evaluationDatasetVersion: "ds@v1",
          splits: { train: "t", validation: "v", test: "x" },
          metrics: { agreement: 0.5 },
        }),
      ],
    }).byId("scorer.sm-v1", "sm-v1")!;
    expect(Object.isFrozen(lineage.splits)).toBe(true);
    expect(Object.isFrozen(lineage.metrics)).toBe(true);
    // The array returned by list() is a fresh copy each call.
    const listed = registry.list();
    listed.length = 0;
    expect(registry.list()).toHaveLength(1);
    // The input manifest itself is left alone (not frozen behind the caller's back).
    expect(Object.isFrozen(manifest)).toBe(false);
  });

  it("rejects near-duplicate ids and versions that differ only by case or whitespace", () => {
    for (const pair of [
      [scorerEntry({}), scorerEntry({ version: "SM-V1" })],
      [scorerEntry({}), scorerEntry({ id: "Scorer.SM-v1" })],
    ]) {
      const error = validationErrorFor(
        () => new ModelRegistry({ schemaVersion: 1, entries: pair }),
      );
      expect(error.message).toMatch(/Duplicate|differ only/);
    }
    for (const version of ["sm-v1 ", " sm-v1", "sm v1", "sm-v1\n", "   "]) {
      expect(
        validationErrorFor(
          () => new ModelRegistry({ schemaVersion: 1, entries: [scorerEntry({ version })] }),
        ).message,
        JSON.stringify(version),
      ).toMatch(/version/);
    }
    for (const id of ["", " scorer", "scorer x", "scorer@1"]) {
      expect(
        validationErrorFor(
          () => new ModelRegistry({ schemaVersion: 1, entries: [scorerEntry({ id })] }),
        ).message,
        JSON.stringify(id),
      ).toMatch(/\bid\b/);
    }
    for (const alias of ["Latest", " latest ", "stable", "main", "master", "default", "nightly"]) {
      expect(
        validationErrorFor(
          () => new ModelRegistry({ schemaVersion: 1, entries: [scorerEntry({ version: alias })] }),
        ).message,
        JSON.stringify(alias),
      ).toMatch(/version alias/);
    }
  });

  it("keeps the shipped manifest valid under the stricter guard", () => {
    expect(() => new ModelRegistry(DEFAULT_MODEL_MANIFEST)).not.toThrow();
    expect(() => ModelRegistry.fromJson(JSON.stringify(DEFAULT_MODEL_MANIFEST))).not.toThrow();
    expect(ModelRegistry.fromJson(JSON.stringify(DEFAULT_MODEL_MANIFEST)).list()).toHaveLength(
      DEFAULT_MODEL_MANIFEST.entries.length,
    );
  });
});
