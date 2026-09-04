import { describe, expect, it } from "vitest";
import {
  ModelRegistry,
  SubsystemReleaseState,
  runRollbackDrill,
  type ModelManifest,
  type ModelManifestEntry,
} from "../../src/index.js";

/**
 * Adversarial pass 3 (tester #4) — model-registry attacks S1, S2, S5.
 * Each `it` states the contract under attack; a failing assertion here is
 * the BROKEN evidence for the finding, not a test to be weakened.
 */

const entry = (overrides: Partial<ModelManifestEntry>): ModelManifestEntry => ({
  id: "stroke.heuristic-hierarchical",
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
  notes: "",
  ...overrides,
});

const manifestOf = (...entries: ModelManifestEntry[]): ModelManifest => ({
  schemaVersion: 1,
  entries,
});

describe("S1 — artifactHash must be a real SHA-256 when an artifactUri is set", () => {
  const withUri = (artifactHash: string | null) =>
    entry({
      id: "scorer.learned",
      version: "sm-v9",
      runtime: "coreml",
      artifactUri: "https://models.example/sm-v9.mlmodelc",
      artifactHash,
    });

  it("control: a well-formed 64-hex hash is accepted", () => {
    expect(() => new ModelRegistry(manifestOf(withUri("a".repeat(64))))).not.toThrow();
  });

  it("control: a null hash with a URI is rejected (existing check)", () => {
    expect(() => new ModelRegistry(manifestOf(withUri(null)))).toThrow(/no artifact hash/);
  });

  it.each([
    ["not-a-hash", "plain word"],
    ["", "empty string"],
    ["A".repeat(64), "upper-case hex (datasetRelease requires lower-case)"],
    ["a".repeat(63), "63 hex chars"],
    ["a".repeat(65), "65 hex chars"],
    ["sha256:" + "a".repeat(64), "prefixed digest"],
    ["z".repeat(64), "64 non-hex chars"],
    [" " + "a".repeat(63), "leading whitespace"],
    ["\u0430".repeat(64), "64 Cyrillic 'а' (unicode homoglyph of a)"],
  ])("rejects artifactHash %j (%s) — datasetRelease enforces /^[0-9a-f]{64}$/", (hash) => {
    expect(() => new ModelRegistry(manifestOf(withUri(hash)))).toThrow();
  });

  it("rejects via fromJson too (the manifest-file load path)", () => {
    const json = JSON.stringify(manifestOf(withUri("not-a-hash")));
    expect(() => ModelRegistry.fromJson(json)).toThrow();
  });

  it("rejects via withEntry too (the append path)", () => {
    const registry = new ModelRegistry(manifestOf());
    expect(() => registry.withEntry(withUri("not-a-hash"))).toThrow();
  });
});

describe("S2 — resolve() must follow promotion intent, not localeCompare ordering", () => {
  // Two production entries for the same task/platform. Intent is explicit:
  // "stroke-heuristic-10" was promoted LATER and names "v9" as its rollback
  // predecessor. "v9" > "stroke-heuristic-10" under localeCompare ('v' > 's').
  const predecessor = entry({
    version: "v9",
    promotionDate: "2026-01-15",
  });
  const successor = entry({
    version: "stroke-heuristic-10",
    promotionDate: "2026-08-01",
    rollbackPredecessor: "stroke.heuristic-hierarchical@v9",
  });

  it("control: localeCompare really orders 'v9' above 'stroke-heuristic-10'", () => {
    expect("v9".localeCompare("stroke-heuristic-10", undefined, { numeric: true })).toBeGreaterThan(
      0,
    );
  });

  it("resolves to the promoted successor (later promotionDate, names the other as predecessor)", () => {
    const registry = new ModelRegistry(manifestOf(predecessor, successor));
    const resolved = registry.resolve({ task: "stroke_classification", platform: "ios" });
    expect(resolved?.version).toBe("stroke-heuristic-10");
  });

  it("is independent of registration order", () => {
    const registry = new ModelRegistry(manifestOf(successor, predecessor));
    const resolved = registry.resolve({ task: "stroke_classification", platform: "ios" });
    expect(resolved?.version).toBe("stroke-heuristic-10");
  });

  it("never returns an entry that another production entry names as its rollback predecessor", () => {
    const registry = new ModelRegistry(manifestOf(predecessor, successor));
    const resolved = registry.resolve({ task: "stroke_classification", platform: "ios" });
    const supersededVersions = registry
      .list("stroke_classification")
      .flatMap((e) => (e.rollbackPredecessor ? [e.rollbackPredecessor.split("@")[1]] : []));
    expect(supersededVersions).toContain("v9");
    expect(supersededVersions).not.toContain(resolved?.version);
  });

  it("with no lineage and no dates at all, two production entries are ambiguous — not silently ordered by string", () => {
    // Neither promotionDate nor rollbackPredecessor: there is NO promotion
    // intent to read. A registry that returns one of them by string sort
    // fabricates a choice. Either reject at construction or return null.
    const a = entry({ version: "v9" });
    const b = entry({ version: "stroke-heuristic-10" });
    let registry: ModelRegistry | null = null;
    try {
      registry = new ModelRegistry(manifestOf(a, b));
    } catch {
      registry = null;
    }
    if (registry !== null) {
      expect(registry.resolve({ task: "stroke_classification", platform: "ios" })).toBeNull();
    }
  });
});

describe("S5 — runRollbackDrill rejects a bad candidate with the active version", () => {
  interface Cfg {
    threshold: number;
  }

  function freshState(): { state: SubsystemReleaseState<Cfg>; live: () => Cfg | null } {
    let live: Cfg | null = null;
    const state = new SubsystemReleaseState<Cfg>({
      subsystem: "attack-drill",
      initial: { version: "v1", artifact: { threshold: 0.5 } },
      apply: (artifact) => {
        live = artifact;
      },
      clock: () => 0,
    });
    return { state, live: () => live };
  }

  it("control: a distinct bad version runs the drill end to end", () => {
    const { state, live } = freshState();
    const result = runRollbackDrill(
      state,
      { version: "v2-bad", artifact: { threshold: 99 } },
      {
        knownGoodLive: () => live()?.threshold === 0.5,
        badLive: () => live()?.threshold === 99,
      },
    );
    expect(result.recovered).toBe(true);
    expect(result.badWasLive).toBe(true);
    expect(result.knownGoodVersion).not.toBe(result.badVersion);
  });

  it("throws when badCandidate.version === active.version (same version, different artifact)", () => {
    const { state, live } = freshState();
    expect(() =>
      runRollbackDrill(
        state,
        { version: "v1", artifact: { threshold: 99 } },
        {
          knownGoodLive: () => live()?.threshold === 0.5,
          badLive: () => live()?.threshold === 99,
        },
      ),
    ).toThrow();
    // And the state must be untouched: no known-good recorded, nothing
    // activated, live behaviour still the original.
    expect(state.journal()).toHaveLength(0);
    expect(live()?.threshold).toBe(0.5);
  });

  it("throws when badCandidate is the very same object as the active artifact", () => {
    const { state, live } = freshState();
    const active = state.active()!;
    expect(() =>
      runRollbackDrill(state, active, {
        knownGoodLive: () => live()?.threshold === 0.5,
        badLive: () => live()?.threshold === 0.5,
      }),
    ).toThrow();
  });

  it("throws when the versions differ only by trailing whitespace / unicode case", () => {
    for (const version of ["v1 ", " v1", "V1", "v\u0661"]) {
      const { state, live } = freshState();
      let threw = false;
      let result: ReturnType<typeof runRollbackDrill> | null = null;
      try {
        result = runRollbackDrill(
          state,
          { version, artifact: { threshold: 99 } },
          {
            knownGoodLive: () => live()?.threshold === 0.5,
            badLive: () => live()?.threshold === 99,
          },
        );
      } catch {
        threw = true;
      }
      // Either rejected, or an honest drill where the reported versions are
      // visibly different strings. Not both-equal-after-trim silently.
      if (!threw) {
        expect(result!.badVersion).toBe(version);
        expect(result!.knownGoodVersion).toBe("v1");
      }
    }
  });
});
