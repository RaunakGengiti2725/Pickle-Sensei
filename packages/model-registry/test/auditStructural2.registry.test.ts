import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_MANIFEST,
  ModelRegistry,
  type ModelManifestEntry,
  type Platform,
} from "../src/index.js";

/**
 * Structural audit (pass 1, auditor #2) — ModelRegistry input hardening.
 *
 * Each test asserts the behaviour the module's own docs/invariants promise
 * ("every resolution returns one exact id@version or null", "validation
 * rejects malformed manifests"). A FAILING test here is a reproduced
 * finding on 4d812e1a, not a regression to fix in this file.
 */

function entry(overrides: Partial<ModelManifestEntry>): ModelManifestEntry {
  return {
    id: "audit.model",
    version: "1.0.0",
    task: "stroke_classification",
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
    notes: "audit fixture",
    ...overrides,
  };
}

describe("audit: fromJson rejects structurally malformed manifests with a validation error", () => {
  const cases: Array<[string, string]> = [
    ["entries is null", '{"schemaVersion":1,"entries":null}'],
    ["entries is an object", '{"schemaVersion":1,"entries":{}}'],
    [
      "entry missing supportedPlatforms",
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          { id: "x", version: "1", task: "stroke_classification", deploymentStatus: "production" },
        ],
      }),
    ],
    [
      "entry version is a number",
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            id: "x",
            version: 7,
            task: "stroke_classification",
            deploymentStatus: "production",
            supportedPlatforms: ["ios"],
          },
        ],
      }),
    ],
    ["top level is an array", "[]"],
    ["top level is null", "null"],
  ];

  for (const [label, json] of cases) {
    it(`${label}: throws an Error that is not a raw TypeError`, () => {
      let thrown: unknown = null;
      try {
        ModelRegistry.fromJson(json);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(TypeError);
    });
  }

  it("an entry lacking the nullable fields is accepted but must then resolve safely", () => {
    // artifactUri/artifactHash/rollbackPredecessor/... are `undefined`, not
    // `null`, when the JSON omits them. `undefined !== null` makes the
    // "URI without hash" guard misfire in both directions.
    const json = JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          id: "x",
          version: "1",
          task: "stroke_classification",
          deploymentStatus: "production",
          supportedPlatforms: ["ios"],
          supportedStrokes: "all",
          artifactUri: "https://example.invalid/model.mlmodelc",
          // artifactHash omitted entirely
          rollbackPredecessor: null,
          splits: null,
          metrics: null,
        },
      ],
    });
    expect(() => ModelRegistry.fromJson(json)).toThrow(/artifact hash/);
  });
});

describe("audit: artifact hash shape", () => {
  it("rejects an artifactHash that is not 64 lowercase hex chars (datasetRelease enforces this; registry does not)", () => {
    expect(
      () =>
        new ModelRegistry({
          schemaVersion: 1,
          entries: [
            entry({ artifactUri: "https://example.invalid/m.bin", artifactHash: "not-a-sha256" }),
          ],
        }),
    ).toThrow(/hash/);
  });
});

describe("audit: rollbackPredecessor cycles", () => {
  it("rejects a two-entry rollback cycle A→B→A", () => {
    expect(
      () =>
        new ModelRegistry({
          schemaVersion: 1,
          entries: [
            entry({
              id: "a",
              version: "1",
              rollbackPredecessor: "b@1",
              deploymentStatus: "deprecated",
            }),
            entry({ id: "b", version: "1", rollbackPredecessor: "a@1" }),
          ],
        }),
    ).toThrow(/cycle|predecessor/i);
  });
});

describe("audit: production resolution uniqueness", () => {
  it("default manifest has at most one production entry per task/platform (verified_ok candidate)", () => {
    const registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);
    const seen = new Map<string, string[]>();
    for (const e of registry.list()) {
      if (e.deploymentStatus !== "production") continue;
      for (const platform of e.supportedPlatforms) {
        const key = `${e.task}/${platform}`;
        seen.set(key, [...(seen.get(key) ?? []), `${e.id}@${e.version}`]);
      }
    }
    for (const [key, ids] of seen) {
      expect(ids, key).toHaveLength(1);
    }
  });

  it("a manifest with two production entries for one task/platform is rejected instead of silently string-sorted", () => {
    // Promotion of a new implementation without demoting the old one: the
    // registry must not pick a winner by localeCompare on unrelated
    // version strings.
    const build = () =>
      new ModelRegistry({
        schemaVersion: 1,
        entries: [
          entry({
            id: "stroke.heuristic-hierarchical",
            version: "stroke-heuristic-7",
            promotionDate: "2026-08-01",
          }),
          entry({ id: "stroke.tcn", version: "1.0.0", promotionDate: "2026-09-01" }),
        ],
      });
    expect(build).toThrow(/production/i);
  });

  it("if two production entries ARE accepted, the newer promotion wins (documents the actual tiebreak)", () => {
    let registry: ModelRegistry;
    try {
      registry = new ModelRegistry({
        schemaVersion: 1,
        entries: [
          entry({
            id: "stroke.heuristic-hierarchical",
            version: "stroke-heuristic-7",
            promotionDate: "2026-08-01",
          }),
          entry({ id: "stroke.tcn", version: "1.0.0", promotionDate: "2026-09-01" }),
        ],
      });
    } catch {
      return; // previous test covers the strict behaviour
    }
    const resolved = registry.resolve({
      task: "stroke_classification" as ModelManifestEntry["task"],
      platform: "ios" as Platform,
    });
    expect(resolved?.id).toBe("stroke.tcn");
  });
});
