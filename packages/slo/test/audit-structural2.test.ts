import { describe, expect, it } from "vitest";
import { LatencyWindow } from "../src/index.js";

/**
 * Structural audit #2 (shared-packages-ops) — reproducing test for
 * LatencyWindow.percentile input validation.
 */

describe("AUDIT LatencyWindow.percentile: an invalid p must not masquerade as 'no samples'", () => {
  it("percentile(NaN) on a populated window throws like other out-of-range p values", () => {
    const window = new LatencyWindow(10);
    for (const ms of [10, 20, 30, 40, 50]) window.record(ms);
    expect(() => window.percentile(0)).toThrow(); // documented behaviour for invalid p
    expect(() => window.percentile(Number.NaN)).toThrow();
  });
});
