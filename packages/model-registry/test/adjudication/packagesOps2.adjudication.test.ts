import { describe, expect, it } from "vitest";
import { SubsystemReleaseState } from "../../src/rollback.js";
import {
  validateDatasetReleaseManifest,
  type DatasetReleaseManifest,
} from "../../src/datasetRelease.js";
import { ModelRegistry, type ModelManifest } from "../../src/registry.js";

/**
 * Independent adjudication replays for stress area packages-ops-2
 * (model-registry). Each `it` asserts the DESIRED behaviour, so it is red
 * while the defect is present. Run with
 * `pnpm --filter @pickle/model-registry test -- test/adjudication`.
 */

describe("ADJ-M1: SubsystemReleaseState commits state before apply() succeeds", () => {
  it("a candidate whose apply() throws must leave active() and the journal unchanged", () => {
    let live = "v1";
    const state = new SubsystemReleaseState<string>({
      subsystem: "adj",
      initial: { version: "v1", artifact: "v1" },
      apply: (artifact) => {
        if (artifact === "poison") throw new Error("live layer refused artifact");
        live = artifact ?? "disabled";
      },
      clock: () => 0,
    });
    expect(() => state.activate({ version: "v2", artifact: "poison" })).toThrow(/refused/);
    expect(live).toBe("v1");
    expect(state.active()?.version).toBe("v1");
    expect(state.journal().map((e) => e.action)).toEqual([]);
  });
});

describe("ADJ-M3: validateDatasetReleaseManifest is documented never to throw", () => {
  it("returns problems (not a TypeError) when components is missing", () => {
    const payload = {
      schemaVersion: 1,
      components: undefined,
    } as unknown as DatasetReleaseManifest;
    expect(() => validateDatasetReleaseManifest(payload)).not.toThrow();
  });
});

describe("ADJ-M4/M5: ModelRegistry rejects shape-malformed manifests with a typed Error", () => {
  it("entry without version is rejected with an Error that is not a TypeError", () => {
    const manifest = {
      schemaVersion: 1,
      entries: [{ id: "x", deploymentStatus: "production", supportedPlatforms: ["ios"] }],
    } as unknown as ModelManifest;
    let thrown: unknown;
    try {
      new ModelRegistry(manifest);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TypeError);
  });
});
