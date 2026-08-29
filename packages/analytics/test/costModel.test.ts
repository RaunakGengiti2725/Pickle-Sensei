import { describe, expect, it } from "vitest";
import {
  COST_COMPONENTS,
  COST_COMPONENT_UNITS,
  COST_OPTIMIZATION_CATALOG,
  DEFAULT_RATE_CARD,
  ZERO_USAGE,
  addUsage,
  computeCost,
  formatMicroUsd,
  scaleUsage,
  suggestOptimizations,
  type RateCard,
  type UsageQuantities,
} from "../src/costModel.js";

const FLAT_RATE_CARD: RateCard = Object.fromEntries(
  COST_COMPONENTS.map((component) => [
    component,
    { usdPerUnit: 0.000001, provenance: "assumption" as const, source: "test" },
  ]),
) as RateCard;

describe("computeCost", () => {
  it("is deterministic: identical inputs produce identical integer micro-USD", () => {
    const usage: UsageQuantities = {
      ...ZERO_USAGE,
      server_cpu: 1234.56,
      storage: 987654321,
      bandwidth: 3428062,
    };
    const a = computeCost(usage, DEFAULT_RATE_CARD);
    const b = computeCost(usage, DEFAULT_RATE_CARD);
    expect(a).toEqual(b);
    expect(Number.isInteger(a.totalMicroUsd)).toBe(true);
    for (const c of a.components) expect(Number.isInteger(c.microUsd)).toBe(true);
  });

  it("totals are the exact integer sum of component costs", () => {
    const usage: UsageQuantities = {
      device_compute: 1,
      server_cpu: 2,
      server_gpu: 3,
      storage: 4,
      bandwidth: 5,
      media_processing: 6,
      coach_review: 7,
    };
    const breakdown = computeCost(usage, FLAT_RATE_CARD);
    const sum = breakdown.components.reduce((acc, c) => acc + c.microUsd, 0);
    expect(breakdown.totalMicroUsd).toBe(sum);
  });

  it("covers every component with its declared unit and provenance", () => {
    const breakdown = computeCost(ZERO_USAGE, DEFAULT_RATE_CARD);
    expect(breakdown.components.map((c) => c.component)).toEqual([...COST_COMPONENTS]);
    for (const c of breakdown.components) {
      expect(c.unit).toBe(COST_COMPONENT_UNITS[c.component]);
      expect(c.provenance).toBe(DEFAULT_RATE_CARD[c.component].provenance);
    }
    expect(breakdown.totalMicroUsd).toBe(0);
    expect(breakdown.totalUsdFormatted).toBe("$0.000000");
  });

  it("prices known quantities against the default rate card exactly", () => {
    // 1 vCPU-hour of server CPU = $0.04 = 40,000 micro-USD.
    const cpuHour = computeCost({ ...ZERO_USAGE, server_cpu: 3_600_000 }, DEFAULT_RATE_CARD);
    expect(cpuHour.totalMicroUsd).toBe(40_000);
    // 1 GiB-month of storage = $0.023 = 23,000 micro-USD.
    const gibMonth = computeCost({ ...ZERO_USAGE, storage: 1_073_741_824 }, DEFAULT_RATE_CARD);
    expect(gibMonth.totalMicroUsd).toBe(23_000);
    // 1 coach-review minute = $1.00 (assumption rate).
    const coachMinute = computeCost({ ...ZERO_USAGE, coach_review: 1 }, DEFAULT_RATE_CARD);
    expect(coachMinute.totalMicroUsd).toBe(1_000_000);
    // Device compute is zero marginal operator cost.
    const device = computeCost({ ...ZERO_USAGE, device_compute: 1_000_000 }, DEFAULT_RATE_CARD);
    expect(device.totalMicroUsd).toBe(0);
  });

  it("rejects negative and non-finite quantities instead of guessing", () => {
    expect(() => computeCost({ ...ZERO_USAGE, server_cpu: -1 }, DEFAULT_RATE_CARD)).toThrow(
      "cost_model.invalid_quantity",
    );
    expect(() => computeCost({ ...ZERO_USAGE, storage: Number.NaN }, DEFAULT_RATE_CARD)).toThrow(
      "cost_model.invalid_quantity",
    );
  });
});

describe("usage arithmetic", () => {
  it("addUsage sums element-wise and scaleUsage multiplies element-wise", () => {
    const a: UsageQuantities = { ...ZERO_USAGE, server_cpu: 10, bandwidth: 100 };
    const b: UsageQuantities = { ...ZERO_USAGE, server_cpu: 5, storage: 7 };
    const sum = addUsage(a, b);
    expect(sum.server_cpu).toBe(15);
    expect(sum.bandwidth).toBe(100);
    expect(sum.storage).toBe(7);
    const scaled = scaleUsage(a, 3);
    expect(scaled.server_cpu).toBe(30);
    expect(scaled.bandwidth).toBe(300);
  });

  it("scaleUsage rejects negative factors", () => {
    expect(() => scaleUsage(ZERO_USAGE, -2)).toThrow("cost_model.invalid_scale_factor");
  });
});

describe("rate card honesty", () => {
  it("every default rate declares provenance and a source", () => {
    for (const component of COST_COMPONENTS) {
      const rate = DEFAULT_RATE_CARD[component];
      expect(rate.source.length).toBeGreaterThan(0);
      expect(["public_list_price_estimate", "assumption", "not_applicable"]).toContain(
        rate.provenance,
      );
    }
  });

  it("coach review is an explicit assumption, never a list price", () => {
    expect(DEFAULT_RATE_CARD.coach_review.provenance).toBe("assumption");
  });
});

describe("optimization suggestions", () => {
  it("every catalog entry preserves core correctness", () => {
    for (const s of COST_OPTIMIZATION_CATALOG) {
      expect(s.preservesCoreCorrectness).toBe(true);
      expect(s.rationale.length).toBeGreaterThan(0);
    }
  });

  it("never suggests weakening accuracy, thresholds, or review scope", () => {
    const forbidden =
      /(lower|loosen|relax|weaken|reduce).*(accuracy|recall|precision|threshold|gate|review scope)/i;
    for (const s of COST_OPTIMIZATION_CATALOG) {
      expect(forbidden.test(s.suggestion)).toBe(false);
    }
  });

  it("orders suggestions by descending cost share and skips zero-cost components", () => {
    const usage: UsageQuantities = {
      ...ZERO_USAGE,
      storage: 10 * 1_073_741_824, // $0.23
      bandwidth: 1_073_741_824, // $0.09
    };
    const suggestions = suggestOptimizations(computeCost(usage, DEFAULT_RATE_CARD));
    expect(suggestions.length).toBe(2);
    expect(suggestions[0]?.targetComponent).toBe("storage");
    expect(suggestions[1]?.targetComponent).toBe("bandwidth");
  });
});

describe("formatMicroUsd", () => {
  it("formats integer micro-USD as USD", () => {
    expect(formatMicroUsd(1_234_567)).toBe("$1.234567");
    expect(formatMicroUsd(0)).toBe("$0.000000");
  });
});
