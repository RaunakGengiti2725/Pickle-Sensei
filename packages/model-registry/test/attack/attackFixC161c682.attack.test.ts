/**
 * Adversarial tests against the MR-01/MR-02 fix (candidate c161c682).
 *
 * Every test here FAILS on c161c682 and documents a concrete gap in the
 * changed code. Baseline (4d812e1a) behaviour is stated per test so the
 * integrator can tell regressions from residual bugs.
 */
import { describe, expect, it } from "vitest";
import { ModelRegistry, SubsystemReleaseState, type ModelManifestEntry } from "../../src/index.js";

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

const manifest = (...entries: ModelManifestEntry[]) => ({ schemaVersion: 1 as const, entries });
const query = { task: "stroke_classification" as const, platform: "ios" as const };

/** Resolve, folding an AMBIGUOUS throw into null — both are acceptable outcomes. */
function resolveOrNull(registry: ModelRegistry): ModelManifestEntry | null {
  try {
    return registry.resolve(query);
  } catch {
    return null;
  }
}

describe("MR-01 residual: two production entries with no promotion intent are still silently ranked", () => {
  // Baseline 4d812e1a: same behaviour (localeCompare numeric) — residual bug, not a regression.
  it("same id, versions v9/v10, no promotionDate, no rollbackPredecessor → must not pick one", () => {
    const registry = new ModelRegistry(
      manifest(entry({ version: "v9" }), entry({ version: "v10" })),
    );
    expect(resolveOrNull(registry)).toBeNull();
  });

  it("registration order does not create promotion intent either", () => {
    const registry = new ModelRegistry(
      manifest(entry({ version: "v10" }), entry({ version: "v9" })),
    );
    expect(resolveOrNull(registry)).toBeNull();
  });

  it("different ids whose versions happen to share a stem are not versions of one another", () => {
    const registry = new ModelRegistry(
      manifest(entry({ id: "stroke.a", version: "v1" }), entry({ id: "stroke.b", version: "v2" })),
    );
    expect(resolveOrNull(registry)).toBeNull();
  });
});

describe("MR-02 regression: re-entrant apply() leaves active() describing a version that is not live", () => {
  // Baseline 4d812e1a: activeState was assigned BEFORE apply(), so the inner
  // activation's commit survived and active() === live (v3). The candidate's
  // post-apply commit overwrites the inner commit with the outer candidate.
  it("apply() that activates a fallback must not leave the outer candidate reported as active", () => {
    let live: string | null = null;
    const state: SubsystemReleaseState<string> = new SubsystemReleaseState<string>({
      subsystem: "attack",
      initial: { version: "v1", artifact: "v1" },
      apply: (artifact) => {
        live = artifact;
        if (artifact === "v2") state.activate({ version: "v3", artifact: "v3" });
      },
      clock: () => 0,
    });

    // Acceptable outcomes: refuse re-entrancy (throw) or commit consistently.
    // Unacceptable: active() !== live.
    try {
      state.activate({ version: "v2", artifact: "v2" });
    } catch {
      // refusing re-entrancy is fine as long as active() still matches live
    }
    expect(state.active()?.version).toBe(live);
  });
});

describe("MR-02 gap: an async apply() that rejects is committed and journaled as applied", () => {
  // Baseline 4d812e1a: same (state committed, rejection unobserved) — not a
  // regression, but the STATE CONTRACT added by the fix ("commits only after
  // apply has returned; when apply throws the controller keeps its previous
  // state") does not hold for the async callbacks the `=> void` signature accepts.
  it("rejected apply must not become the active version", async () => {
    let live: string | null = "v1";
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const state = new SubsystemReleaseState<string>({
        subsystem: "attack",
        initial: { version: "v1", artifact: "v1" },
        apply: async (artifact: string | null) => {
          if (artifact === "bad") throw new Error("boom");
          live = artifact;
        },
        clock: () => 0,
      });

      let threw = false;
      try {
        state.activate({ version: "bad", artifact: "bad" });
      } catch {
        threw = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(live).toBe("v1");
      // Either the controller refuses async apply (throws synchronously) or it
      // must not report a version that never went live.
      expect(threw || state.active()?.version === "v1").toBe(true);
      expect(state.journal().some((j) => j.toVersion === "bad" && j.outcome === "applied")).toBe(
        false,
      );
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
