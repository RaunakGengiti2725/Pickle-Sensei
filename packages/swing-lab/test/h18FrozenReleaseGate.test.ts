import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * FROZEN RELEASE GATE — release-gate-g6-calibration-v1.
 *
 * The Gate 6 (calibration / silent failure) GO/NO-GO thresholds were frozen
 * BEFORE the final holdout evaluation. This test pins the exact bytes of the
 * frozen document: any in-place edit — including a softened threshold, a
 * relaxed denominator rule, or a reworded noGoTrigger — fails certification.
 * Changes require a NEW version file (…-v2.json) created before the final
 * holdout evaluation begins; this pin never moves.
 */
const GATE_PATH = join(
  import.meta.dirname,
  "../../../datasets/experiments/wave-h/h18-frozen-release-gate-g6-v1.json",
);

const FROZEN_SHA256 = "db73409ca1fba65c19a1f0d19bee6822955a0235716fae553f428465c5c7ff7c";

describe("h18 frozen release gate (release-gate-g6-calibration-v1)", () => {
  it("bytes are frozen (sha256 pinned)", () => {
    const digest = createHash("sha256").update(readFileSync(GATE_PATH)).digest("hex");
    expect(digest).toBe(FROZEN_SHA256);
  });

  it("declares itself frozen before the final holdout evaluation", () => {
    const gate = JSON.parse(readFileSync(GATE_PATH, "utf8")) as {
      gate: string;
      status: string;
      frozenBeforeFinalHoldoutEvaluation: boolean;
      denominatorRules: string[];
      goCriteria: Record<string, { requirement: string }>;
      verdictRule: string;
    };
    expect(gate.gate).toBe("release-gate-g6-calibration-v1");
    expect(gate.status).toBe("FROZEN");
    expect(gate.frozenBeforeFinalHoldoutEvaluation).toBe(true);
    expect(gate.denominatorRules.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(gate.goCriteria)).toEqual([
      "G6-1_silentFailureAnswered",
      "G6-2_fabricatedContact",
      "G6-3_coverageFloor",
      "G6-4_usableResultFloor",
      "G6-5_confidenceRouting",
      "G6-6_calibrationRegression",
    ]);
    expect(gate.verdictRule).toContain("NO-GO");
  });
});
