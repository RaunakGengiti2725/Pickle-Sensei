import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_MANIFEST, ModelRegistry } from "@pickle/model-registry";
import { STROKE_HEURISTIC_VERSION } from "../src/index.js";

/**
 * Provenance drift guard: the model registry is the version the fusion
 * engine writes into every Result's modelRuns for stroke_classification,
 * while the classifier stamps STROKE_HEURISTIC_VERSION into each prediction.
 * If the two ever disagree, analysis records carry contradictory provenance
 * (wave-h gate 14 finding: the registry sat at stroke-heuristic-1 while the
 * live classifier was stroke-heuristic-6). A classifier version bump must
 * update the manifest in the same change.
 */
describe("model registry ↔ classifier provenance parity", () => {
  it("registry stroke_classification version matches the live classifier version", () => {
    const registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);
    for (const platform of ["ios", "android", "server"] as const) {
      const entry = registry.resolve({ task: "stroke_classification", platform });
      expect(entry, `no production stroke_classification entry for ${platform}`).not.toBeNull();
      // STROKE_HEURISTIC_VERSION carries a calibration suffix, e.g.
      // "stroke-heuristic-6 (uncalibrated)"; the registry stores the bare
      // version identifier that suffix qualifies.
      expect(entry!.version).toBe(STROKE_HEURISTIC_VERSION.split(" ")[0]);
    }
  });
});
