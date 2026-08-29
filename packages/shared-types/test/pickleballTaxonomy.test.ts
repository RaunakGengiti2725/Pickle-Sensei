import { describe, expect, it } from "vitest";
import { PICKLEBALL_TECHNIQUES, STROKE_FAMILIES, type StrokeFamily } from "../src/index.js";

describe("pickleball technique taxonomy", () => {
  it("contains unique canonical technique slugs", () => {
    const slugs = PICKLEBALL_TECHNIQUES.map((technique) => technique.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.length).toBe(61);
  });

  it("covers every declared stroke family", () => {
    const counts = new Map<StrokeFamily, number>();
    for (const technique of PICKLEBALL_TECHNIQUES) {
      counts.set(technique.family, (counts.get(technique.family) ?? 0) + 1);
    }
    for (const family of STROKE_FAMILIES) {
      expect(counts.get(family)).toBeGreaterThan(0);
    }
  });
});
