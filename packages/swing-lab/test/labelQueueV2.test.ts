import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACQUISITION_COSTS,
  HELD_OUT_BUNDLES,
  MODALITY_IMPACTS,
  SLICE_BOOSTS,
  bucketThinness,
  buildQueue,
  countBundleLabels,
  scoreBucket,
  type BundleModalityCount,
} from "../src/labelQueueV2.js";

function makeFixtureBundles(): string {
  const root = join(tmpdir(), `label-queue-fixture-${process.pid}-${Date.now()}`);
  const write = (bundleId: string, file: string, content: object) => {
    const dir = join(root, bundleId, "annotation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), JSON.stringify(content));
  };
  write("afn-sasebo-rally1", "devin-visual-v1.json", {
    eventLabels: [{ contactMs: 2900 }, { contactMs: null }],
    ballFrames: [{}],
    paddleFrames: [{}, {}],
    otherPaddleFrames: [{}],
    annotatedStrokeV3: "BACKHAND_VOLLEY",
  });
  write("wavea-944403-dink", "devin-visual-v2-wave-a.json", {
    eventLabels: [{ contactMs: 100 }],
    ballFrames: [],
    paddleFrames: [],
    otherPaddleFrames: [],
    annotatedStrokeV3: null,
  });
  // Held-out bundles must be ignored even if present on disk.
  write("wm-dink-01", "devin-visual-v1.json", {
    eventLabels: [{ contactMs: 1 }],
    ballFrames: [{}],
  });
  write("afn-vic-rally1", "devin-visual-v1.json", { eventLabels: [{ contactMs: 1 }] });
  return root;
}

describe("bucketThinness", () => {
  it("is 1 for empty buckets and decays with count", () => {
    expect(bucketThinness(0)).toBe(1);
    expect(bucketThinness(1)).toBe(0.5);
    expect(bucketThinness(9)).toBe(0.1);
  });
});

describe("countBundleLabels", () => {
  it("counts per modality and never includes held-out bundles", () => {
    const counts = countBundleLabels(makeFixtureBundles());
    const bundles = new Set(counts.map((c) => c.bundleId));
    for (const heldOut of HELD_OUT_BUNDLES) expect(bundles.has(heldOut)).toBe(false);
    const get = (bundleId: string, modality: string) =>
      counts.find((c) => c.bundleId === bundleId && c.modality === modality)?.labelCount;
    expect(get("afn-sasebo-rally1", "events")).toBe(2);
    expect(get("afn-sasebo-rally1", "contact")).toBe(1); // null contactMs is not a contact label
    expect(get("afn-sasebo-rally1", "ownership")).toBe(3);
    expect(get("afn-sasebo-rally1", "ball")).toBe(1);
    expect(get("afn-sasebo-rally1", "stroke")).toBe(1);
    expect(get("wavea-944403-dink", "stroke")).toBe(0);
  });
});

describe("scoreBucket", () => {
  const count: BundleModalityCount = {
    bundleId: "afn-sasebo-rally2",
    modality: "ball",
    labelCount: 4,
    sourceFiles: ["fixture"],
  };
  it("computes thinness × impact × boosts ÷ cost with provenance attached", () => {
    const item = scoreBucket(count, MODALITY_IMPACTS, ACQUISITION_COSTS, SLICE_BOOSTS);
    const boost = SLICE_BOOSTS.find((b) => b.id === "rally2-ball-body-overlap");
    expect(boost).toBeDefined();
    expect(item.score).toBeCloseTo(((1 / 5) * 0.7 * 2) / 1, 10);
    expect(item.boosts.map((b) => b.id)).toContain("rally2-ball-body-overlap");
    expect(item.scoreInputs.impact.provenance.length).toBeGreaterThan(0);
    expect(item.reasoning).toContain("BALL_BODY_OVERLAP");
  });
  it("applies no boost to unnamed buckets", () => {
    const item = scoreBucket(
      { ...count, bundleId: "wavea-marne-dig" },
      MODALITY_IMPACTS,
      ACQUISITION_COSTS,
      SLICE_BOOSTS,
    );
    expect(item.boosts).toEqual([]);
    expect(item.score).toBeCloseTo(((1 / 5) * 0.7) / 1, 10);
  });
});

describe("buildQueue", () => {
  it("is deterministic: identical output across runs, sorted, ranked 1..n", () => {
    const dir = makeFixtureBundles();
    const first = buildQueue(dir);
    const second = buildQueue(dir);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.items.map((i) => i.rank)).toEqual(first.items.map((_, index) => index + 1));
    for (let index = 1; index < first.items.length; index += 1) {
      const previous = first.items[index - 1];
      const current = first.items[index];
      if (!previous || !current) throw new Error("missing item");
      expect(
        previous.score > current.score ||
          (previous.score === current.score && previous.id < current.id),
      ).toBe(true);
    }
  });
  it("never emits items for held-out bundles and respects topN", () => {
    const queue = buildQueue(makeFixtureBundles(), 5);
    expect(queue.items.length).toBeLessThanOrEqual(5);
    for (const item of queue.items) {
      expect((HELD_OUT_BUNDLES as readonly string[]).includes(item.bundleId)).toBe(false);
    }
  });
  it("every item carries provenance for every score input", () => {
    const queue = buildQueue(makeFixtureBundles());
    for (const item of queue.items) {
      expect(item.scoreInputs.thinness.countSources.length).toBeGreaterThan(0);
      expect(item.scoreInputs.impact.provenance.length).toBeGreaterThan(0);
      expect(item.scoreInputs.cost.rationale.length).toBeGreaterThan(0);
      for (const boost of item.scoreInputs.boosts)
        expect(boost.provenance.source.length).toBeGreaterThan(0);
      expect(item.reasoning.length).toBeGreaterThan(40);
    }
  });
});
