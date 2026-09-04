/**
 * Adversarial pass 3 — cost model overflow attacks.
 *
 * Attack: scale a usage record by an absurd factor (1e300) and feed it into
 * computeCost. The module promises "integer micro-USD, exact, no
 * floating-point drift" and that "non-finite quantities … throw rather than
 * producing a plausible number". We probe the two ways that promise can leak:
 *  (a) the scaled QUANTITY overflows to Infinity (must throw — guarded);
 *  (b) the quantity stays finite but quantity × rate × 1e6 overflows, or
 *      exceeds 2^53 so the "integer" micro-USD is no longer exact.
 */
import { describe, expect, it } from "vitest";
import {
  COST_COMPONENTS,
  DEFAULT_RATE_CARD,
  ZERO_USAGE,
  computeCost,
  formatMicroUsd,
  scaleUsage,
  addUsage,
} from "../src/costModel.js";

describe("attack3: computeCost with scaleUsage(usage, 1e300)", () => {
  it("throws when the scaled quantity itself overflows to Infinity", () => {
    // 1e10 coach minutes × 1e300 = 1e310 → Infinity.
    const usage = { ...ZERO_USAGE, coach_review: 1e10 };
    const scaled = scaleUsage(usage, 1e300);
    expect(scaled.coach_review).toBe(Number.POSITIVE_INFINITY);
    expect(() => computeCost(scaled, DEFAULT_RATE_CARD)).toThrow(/cost_model\.invalid_quantity/);
  });

  it("throws (not $Infinity) when quantity is finite but quantity×rate×1e6 overflows", () => {
    // 1e5 coach minutes × 1e300 = 1e305 (finite) → microUsd = 1e305 × 1.0 × 1e6 = 1e311 → Infinity.
    const usage = { ...ZERO_USAGE, coach_review: 1e5 };
    const scaled = scaleUsage(usage, 1e300);
    expect(Number.isFinite(scaled.coach_review)).toBe(true);
    let breakdown: ReturnType<typeof computeCost> | null = null;
    let threw = false;
    try {
      breakdown = computeCost(scaled, DEFAULT_RATE_CARD);
    } catch {
      threw = true;
    }
    if (!threw) {
      // Document what actually came back so the failure is self-describing.
      const coach = breakdown!.components.find((c) => c.component === "coach_review")!;
      expect({
        coachMicroUsd: coach.microUsd,
        totalMicroUsd: breakdown!.totalMicroUsd,
        totalUsdFormatted: breakdown!.totalUsdFormatted,
      }).toEqual({
        coachMicroUsd: "finite integer",
        totalMicroUsd: "finite integer",
        totalUsdFormatted: "finite",
      });
    }
    expect(threw).toBe(true);
  });

  it("keeps every microUsd a SAFE integer (exact arithmetic promise)", () => {
    // 1e2 × 1e300 = 1e302 → microUsd 1e308 (finite, but far beyond 2^53).
    const usage = { ...ZERO_USAGE, coach_review: 1e2 };
    const scaled = scaleUsage(usage, 1e300);
    const breakdown = computeCost(scaled, DEFAULT_RATE_CARD);
    for (const c of breakdown.components) {
      expect(Number.isSafeInteger(c.microUsd), `${c.component} microUsd=${c.microUsd}`).toBe(true);
    }
    expect(Number.isSafeInteger(breakdown.totalMicroUsd)).toBe(true);
  });

  it("addUsage of two finite usages that overflows must not yield an Infinity that computeCost silently accepts", () => {
    const a = { ...ZERO_USAGE, bandwidth: 1e308 };
    const b = { ...ZERO_USAGE, bandwidth: 1e308 };
    const sum = addUsage(a, b);
    expect(sum.bandwidth).toBe(Number.POSITIVE_INFINITY);
    expect(() => computeCost(sum, DEFAULT_RATE_CARD)).toThrow(/cost_model\.invalid_quantity/);
  });

  it("scaleUsage rejects non-finite / negative factors but accepts 1e300 (documenting the boundary)", () => {
    expect(() => scaleUsage(ZERO_USAGE, Number.POSITIVE_INFINITY)).toThrow();
    expect(() => scaleUsage(ZERO_USAGE, Number.NaN)).toThrow();
    expect(() => scaleUsage(ZERO_USAGE, -1)).toThrow();
    expect(() => scaleUsage(ZERO_USAGE, 1e300)).not.toThrow();
  });

  it("-0 quantity is accepted and costs $0.000000 (no negative-zero formatting leak)", () => {
    const usage = { ...ZERO_USAGE, storage: -0 };
    const breakdown = computeCost(usage, DEFAULT_RATE_CARD);
    expect(breakdown.totalMicroUsd).toBe(0);
    expect(breakdown.totalUsdFormatted).toBe("$0.000000");
    // Internal -0 is tolerable as long as nothing observable carries a sign.
    for (const c of COST_COMPONENTS) {
      const comp = breakdown.components.find((x) => x.component === c)!;
      expect(JSON.stringify(comp)).not.toMatch(/-0/);
      expect(formatMicroUsd(comp.microUsd)).toBe("$0.000000");
    }
  });
});
