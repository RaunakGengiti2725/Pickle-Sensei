import { describe, expect, it } from "vitest";
import { ModelRegistry, type ModelManifest, type ModelManifestEntry } from "../../src/index.js";

/**
 * ADVERSARIAL S2 — rollbackPredecessor cycle.
 *
 * `validateManifest` (registry.ts, private; reached through the ModelRegistry
 * constructor) rejects an UNREGISTERED predecessor and a SELF predecessor.
 * A rollback chain is a linked list that an operator walks backwards when a
 * promotion goes wrong; a 2-cycle A@1 → A@2 → A@1 (or any longer cycle) has
 * no terminal known-good version, so following the chain never terminates.
 * This attack asserts the constructor rejects such a manifest.
 */

const entry = (overrides: Partial<ModelManifestEntry>): ModelManifestEntry => ({
  id: "scorer.cycle",
  version: "1",
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

/** Walks the rollback chain from `start`; returns the visited keys or throws
 * after `limit` hops (the operator-facing consequence of an accepted cycle). */
function walkRollbackChain(registry: ModelRegistry, start: string, limit: number): string[] {
  const visited: string[] = [];
  let current: string | null = start;
  while (current !== null) {
    if (visited.length >= limit) {
      throw new Error(
        `rollback chain did not terminate after ${limit} hops: ${visited.join(" → ")}`,
      );
    }
    visited.push(current);
    const [id, version] = current.split("@") as [string, string];
    const found = registry.byId(id, version);
    current = found?.rollbackPredecessor ?? null;
  }
  return visited;
}

describe("ADVERSARIAL S2: rollbackPredecessor cycles", () => {
  it("rejects the 2-cycle A@1 → A@2 → A@1", () => {
    const manifest: ModelManifest = {
      schemaVersion: 1,
      entries: [
        entry({
          version: "1",
          deploymentStatus: "deprecated",
          rollbackPredecessor: "scorer.cycle@2",
        }),
        entry({
          version: "2",
          deploymentStatus: "production",
          rollbackPredecessor: "scorer.cycle@1",
        }),
      ],
    };
    expect(() => new ModelRegistry(manifest)).toThrow(/cycle|circular|loop/i);
  });

  it("rejects a 3-cycle A@1 → A@2 → A@3 → A@1", () => {
    const manifest: ModelManifest = {
      schemaVersion: 1,
      entries: [
        entry({
          version: "1",
          deploymentStatus: "deprecated",
          rollbackPredecessor: "scorer.cycle@2",
        }),
        entry({
          version: "2",
          deploymentStatus: "deprecated",
          rollbackPredecessor: "scorer.cycle@3",
        }),
        entry({
          version: "3",
          deploymentStatus: "production",
          rollbackPredecessor: "scorer.cycle@1",
        }),
      ],
    };
    expect(() => new ModelRegistry(manifest)).toThrow(/cycle|circular|loop/i);
  });

  it("rejects a cycle reachable from a production entry through a tail (P → A@2 → A@1 → A@2)", () => {
    const manifest: ModelManifest = {
      schemaVersion: 1,
      entries: [
        entry({
          version: "1",
          deploymentStatus: "deprecated",
          rollbackPredecessor: "scorer.cycle@2",
        }),
        entry({
          version: "2",
          deploymentStatus: "deprecated",
          rollbackPredecessor: "scorer.cycle@1",
        }),
        entry({
          version: "3",
          deploymentStatus: "production",
          rollbackPredecessor: "scorer.cycle@2",
        }),
      ],
    };
    expect(() => new ModelRegistry(manifest)).toThrow(/cycle|circular|loop/i);
  });

  it("still accepts a well-formed acyclic chain (control)", () => {
    const manifest: ModelManifest = {
      schemaVersion: 1,
      entries: [
        entry({ version: "1", deploymentStatus: "deprecated", rollbackPredecessor: null }),
        entry({
          version: "2",
          deploymentStatus: "deprecated",
          rollbackPredecessor: "scorer.cycle@1",
        }),
        entry({
          version: "3",
          deploymentStatus: "production",
          rollbackPredecessor: "scorer.cycle@2",
        }),
      ],
    };
    const registry = new ModelRegistry(manifest);
    expect(walkRollbackChain(registry, "scorer.cycle@3", 10)).toEqual([
      "scorer.cycle@3",
      "scorer.cycle@2",
      "scorer.cycle@1",
    ]);
  });

  it("EVIDENCE: if the 2-cycle is accepted, walking the rollback chain never terminates", () => {
    const manifest: ModelManifest = {
      schemaVersion: 1,
      entries: [
        entry({
          version: "1",
          deploymentStatus: "deprecated",
          rollbackPredecessor: "scorer.cycle@2",
        }),
        entry({
          version: "2",
          deploymentStatus: "production",
          rollbackPredecessor: "scorer.cycle@1",
        }),
      ],
    };
    let registry: ModelRegistry | null = null;
    try {
      registry = new ModelRegistry(manifest);
    } catch {
      // Constructor rejected the cycle: the primary assertion above HELD.
      return;
    }
    // Reached only when validation accepted the cycle — document the blast
    // radius: the chain walk is unbounded. This assertion is expected to FAIL
    // on 4d812e1a; a failure here is the BROKEN classification's evidence.
    expect(() => walkRollbackChain(registry!, "scorer.cycle@2", 64)).not.toThrow();
  });
});
