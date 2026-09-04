import { describe, expect, it } from "vitest";
import { ModelRegistry, type ModelManifestEntry } from "../../src/index.js";
import { SHOT_TYPES } from "@pickle/shared-types";

/**
 * Adversarial pass 3 (tester #3) — S7: `supportedStrokes: []`.
 *
 * Assigned checks:
 *   - resolve({task, platform, stroke}) against an entry whose
 *     supportedStrokes is [] must NEVER match for any stroke.
 *   - the stroke-less query DOES match (the stroke filter short-circuits on
 *     `query.stroke === undefined`).
 *   - decide whether an empty stroke list should fail manifest validation.
 *
 * Decision encoded below: an entry that supports NO stroke is as unusable as
 * one that supports no platform (which validateManifest already rejects), and
 * the stroke-less/stroked asymmetry means the same registry answers
 * "production scorer exists" and "production scorer does not exist" for the
 * same task depending only on whether the caller passed a stroke. The
 * `describe("S7 decision")` block asserts the strict behaviour; failing there
 * is the BROKEN evidence for the P3 finding.
 */

const entry = (overrides: Partial<ModelManifestEntry>): ModelManifestEntry => ({
  id: "scorer.no-strokes",
  version: "ns-v1",
  task: "technique_scoring",
  runtime: "deterministic",
  executionTarget: "on_device",
  deploymentStatus: "production",
  supportedPlatforms: ["ios"],
  supportedStrokes: [],
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

const registryWith = (e: ModelManifestEntry) =>
  new ModelRegistry({ schemaVersion: 1, entries: [e] });

describe("S7 — resolve() against supportedStrokes: []", () => {
  it("never matches a stroked query, for every stroke in the taxonomy", () => {
    const registry = registryWith(entry({}));
    for (const stroke of SHOT_TYPES) {
      expect(
        registry.resolve({ task: "technique_scoring", platform: "ios", stroke }),
        `stroke=${stroke}`,
      ).toBeNull();
    }
  });

  it("does match the stroke-less query (documented asymmetry)", () => {
    const registry = registryWith(entry({}));
    const hit = registry.resolve({ task: "technique_scoring", platform: "ios" });
    expect(hit?.version).toBe("ns-v1");
  });

  it("shadowFor() has the same asymmetry", () => {
    const registry = registryWith(entry({ deploymentStatus: "shadow" }));
    expect(registry.shadowFor({ task: "technique_scoring", platform: "ios" })?.version).toBe(
      "ns-v1",
    );
    for (const stroke of SHOT_TYPES) {
      expect(registry.shadowFor({ task: "technique_scoring", platform: "ios", stroke })).toBeNull();
    }
  });

  it("an empty-stroke entry can out-rank a real 'all' entry for stroke-less queries while being invisible for stroked ones", () => {
    const registry = new ModelRegistry({
      schemaVersion: 1,
      entries: [
        entry({ id: "scorer.real", version: "sm-v1", supportedStrokes: "all" }),
        // Higher version, but supports nothing.
        entry({ id: "scorer.ghost", version: "sm-v2", supportedStrokes: [] }),
      ],
    });
    expect(registry.resolve({ task: "technique_scoring", platform: "ios" })?.id).toBe(
      "scorer.ghost",
    );
    expect(
      registry.resolve({ task: "technique_scoring", platform: "ios", stroke: SHOT_TYPES[0] })?.id,
    ).toBe("scorer.real");
  });
});

describe("S7 decision — an empty supportedStrokes list should fail manifest validation", () => {
  it("control: supportedPlatforms: [] is rejected today", () => {
    expect(() => registryWith(entry({ supportedPlatforms: [], supportedStrokes: "all" }))).toThrow(
      /supports no platforms/,
    );
  });

  it("supportedStrokes: [] should be rejected the same way (currently accepted)", () => {
    expect(() => registryWith(entry({ supportedStrokes: [] }))).toThrow();
  });

  it("withEntry() should reject supportedStrokes: [] too", () => {
    const registry = new ModelRegistry({ schemaVersion: 1, entries: [] });
    expect(() => registry.withEntry(entry({ supportedStrokes: [] }))).toThrow();
  });

  it("fromJson() should reject supportedStrokes: [] too", () => {
    const json = JSON.stringify({ schemaVersion: 1, entries: [entry({ supportedStrokes: [] })] });
    expect(() => ModelRegistry.fromJson(json)).toThrow();
  });
});
