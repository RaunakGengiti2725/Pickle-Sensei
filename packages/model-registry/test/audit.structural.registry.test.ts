/**
 * Structural audit (pass 1) — ModelRegistry contract probes.
 *
 * Each `it` isolates one suspected defect. A FAILING case here is the
 * evidence for the corresponding finding; a PASSING case is `verified_ok`.
 * Production code is not modified by this audit.
 */
import { describe, expect, it } from "vitest";
import { ModelRegistry, type ModelManifest, type ModelManifestEntry } from "../src/index.js";

const baseEntry = (overrides: Partial<ModelManifestEntry>): ModelManifestEntry => ({
  id: "stroke.audit",
  version: "v1",
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
});

const manifest = (entries: ModelManifestEntry[]): ModelManifest => ({ schemaVersion: 1, entries });

describe("audit: ModelRegistry.fromJson on structurally malformed JSON", () => {
  const isValidationError = (fn: () => unknown): boolean => {
    try {
      fn();
      return false;
    } catch (error) {
      // A TypeError is the runtime tripping over an assumed shape, not a
      // deliberate validation message.
      return !(error instanceof TypeError);
    }
  };

  it("rejects a manifest whose entries key is missing with a validation error, not a TypeError", () => {
    expect(isValidationError(() => ModelRegistry.fromJson('{"schemaVersion":1}'))).toBe(true);
  });

  it("rejects a manifest whose entries is not an array with a validation error, not a TypeError", () => {
    expect(
      isValidationError(() => ModelRegistry.fromJson('{"schemaVersion":1,"entries":{}}')),
    ).toBe(true);
  });

  it("rejects an entry with no supportedPlatforms array with a validation error, not a TypeError", () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      entries: [{ ...baseEntry({}), supportedPlatforms: undefined }],
    });
    expect(isValidationError(() => ModelRegistry.fromJson(json))).toBe(true);
  });

  it("rejects an entry with a null version instead of registering it as id@null", () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      entries: [{ ...baseEntry({}), version: null }],
    });
    expect(() => ModelRegistry.fromJson(json)).toThrow();
  });

  it("rejects an entry with an unknown deploymentStatus instead of storing it", () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      entries: [{ ...baseEntry({}), deploymentStatus: "prod" }],
    });
    expect(() => ModelRegistry.fromJson(json)).toThrow();
  });
});

describe("audit: artifactHash format", () => {
  it("rejects an artifactHash that is not a 64-hex sha256 when an artifactUri is present", () => {
    const entry = baseEntry({
      runtime: "coreml",
      artifactUri: "file:///models/stroke.mlpackage",
      artifactHash: "not-a-hash",
    });
    expect(() => new ModelRegistry(manifest([entry]))).toThrow();
  });

  it("rejects an empty-string artifactHash when an artifactUri is present", () => {
    const entry = baseEntry({
      runtime: "coreml",
      artifactUri: "file:///models/stroke.mlpackage",
      artifactHash: "",
    });
    expect(() => new ModelRegistry(manifest([entry]))).toThrow();
  });
});

describe("audit: rollbackPredecessor graph", () => {
  it("rejects a two-node rollbackPredecessor cycle", () => {
    const a = baseEntry({ version: "v1", rollbackPredecessor: "stroke.audit@v2" });
    const b = baseEntry({
      version: "v2",
      deploymentStatus: "deprecated",
      rollbackPredecessor: "stroke.audit@v1",
    });
    expect(() => new ModelRegistry(manifest([a, b]))).toThrow();
  });
});

describe("audit: production resolution ambiguity", () => {
  it("does not silently pick one of two production entries for the same task/platform", () => {
    const older = baseEntry({ version: "stroke-heuristic-7", promotionDate: "2026-08-01" });
    const newer = baseEntry({ version: "stroke-heuristic-10", promotionDate: "2026-09-01" });
    const registry = new ModelRegistry(manifest([older, newer]));
    // Two live production entries for one task/platform is a manifest
    // contradiction: construction (or resolve) must refuse rather than
    // answer with an arbitrary one.
    let threw = false;
    let resolved: ModelManifestEntry | null = null;
    try {
      resolved = registry.resolve({ task: "stroke_classification", platform: "ios" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(resolved).toBeNull();
  });

  it("numeric-aware sort does not misorder padded vs unpadded free-form versions", () => {
    // Documents the sort behaviour for two differently formatted versions of
    // one lineage. Not a defect claim by itself — the ambiguity test above is.
    const a = baseEntry({ version: "v2" });
    const b = baseEntry({ version: "v10" });
    const registry = new ModelRegistry(manifest([a, b]));
    expect(registry.resolve({ task: "stroke_classification", platform: "ios" })?.version).toBe(
      "v10",
    );
  });
});

describe("audit: registration immutability under mutation of the source manifest", () => {
  it("does not let a caller mutate registered entries through the manifest object it passed in", () => {
    const entry = baseEntry({});
    const source = manifest([entry]);
    const registry = new ModelRegistry(source);
    entry.deploymentStatus = "deprecated";
    expect(registry.resolve({ task: "stroke_classification", platform: "ios" })?.version).toBe(
      "v1",
    );
  });

  it("does not let a caller mutate registered entries through the returned entry object", () => {
    const registry = new ModelRegistry(manifest([baseEntry({})]));
    const resolved = registry.resolve({ task: "stroke_classification", platform: "ios" });
    expect(resolved).not.toBeNull();
    let mutated = false;
    try {
      resolved!.deploymentStatus = "candidate";
      mutated = true;
    } catch {
      // frozen — expected
    }
    if (mutated) {
      expect(registry.resolve({ task: "stroke_classification", platform: "ios" })?.version).toBe(
        "v1",
      );
    }
  });

  it("does not let a caller mutate registered entries through list()", () => {
    const registry = new ModelRegistry(manifest([baseEntry({})]));
    const listed = registry.list();
    let mutated = false;
    try {
      listed[0]!.deploymentStatus = "candidate";
      mutated = true;
    } catch {
      // frozen — expected
    }
    if (mutated) {
      expect(registry.resolve({ task: "stroke_classification", platform: "ios" })?.version).toBe(
        "v1",
      );
    }
  });
});
