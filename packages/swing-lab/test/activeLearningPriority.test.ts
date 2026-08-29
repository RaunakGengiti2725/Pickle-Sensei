import { describe, expect, it } from "vitest";
import {
  BOOST_WEIGHTS,
  computeBoosts,
  deviceProfileKeyFor,
  envelopeBoundaryDimensionsFor,
  featuresForItem,
  prioritizeHardCases,
  scoreItem,
  type HardCaseFeatures,
} from "../src/activeLearningPriority.js";
import type { QueueItemV3, Signal, SignalType } from "../src/labelQueueV3.js";

function makeItem(overrides: Partial<QueueItemV3> & { id: string }): QueueItemV3 {
  return {
    rank: 0,
    kind: "window",
    sessionKey: "dvids-marne-2024",
    split: "dev",
    bundleId: null,
    recordingId: null,
    modalities: ["events"],
    tMs: null,
    frameIdx: null,
    windowMs: null,
    score: 0,
    signals: [],
    instruction: "test",
    rationale: "test",
    ...overrides,
  };
}

function signal(type: SignalType, weight: number): Signal {
  return { type, weight, provenance: { source: "test", metric: "test", value: weight } };
}

/** An easy repetitive example: common stroke, well-covered session and device,
 * mid-envelope, no ambiguity evidence. */
const EASY_FEATURES: HardCaseFeatures = {
  strokeClass: "FOREHAND_VOLLEY",
  strokeLabelCount: 40,
  sessionLabeledItemCount: 30,
  deviceProfileKey: "1920x1080@29.97/h264",
  deviceProfileRecordingCount: 12,
  envelopeBoundaryDimensions: [],
};

const NEUTRAL_FEATURES: HardCaseFeatures = {
  strokeClass: null,
  strokeLabelCount: null,
  sessionLabeledItemCount: 0,
  deviceProfileKey: null,
  deviceProfileRecordingCount: null,
  envelopeBoundaryDimensions: [],
};

describe("computeBoosts", () => {
  it("rare strokes boost more than common strokes", () => {
    const item = makeItem({ id: "a" });
    const rare = computeBoosts(item, {
      ...NEUTRAL_FEATURES,
      strokeClass: "SPEEDUP",
      strokeLabelCount: 0,
    });
    const common = computeBoosts(item, {
      ...NEUTRAL_FEATURES,
      strokeClass: "FOREHAND_VOLLEY",
      strokeLabelCount: 40,
    });
    const rareBoost = rare.find((b) => b.type === "rare_stroke");
    const commonBoost = common.find((b) => b.type === "rare_stroke");
    expect(rareBoost?.contribution).toBe(BOOST_WEIGHTS.rare_stroke.weight);
    expect(commonBoost?.contribution).toBeCloseTo(BOOST_WEIGHTS.rare_stroke.weight / 41);
    expect(rareBoost!.contribution).toBeGreaterThan(commonBoost!.contribution);
  });

  it("new environments boost more than well-covered sessions", () => {
    const item = makeItem({ id: "a" });
    const fresh = computeBoosts(item, { ...NEUTRAL_FEATURES, sessionLabeledItemCount: 0 });
    const covered = computeBoosts(item, { ...NEUTRAL_FEATURES, sessionLabeledItemCount: 30 });
    const freshBoost = fresh.find((b) => b.type === "environment_novelty")!;
    const coveredBoost = covered.find((b) => b.type === "environment_novelty")!;
    expect(freshBoost.contribution).toBeGreaterThan(coveredBoost.contribution);
  });

  it("unseen device profiles boost more than common ones", () => {
    const item = makeItem({ id: "a" });
    const unseen = computeBoosts(item, {
      ...NEUTRAL_FEATURES,
      deviceProfileKey: "640x480@15/mjpeg",
      deviceProfileRecordingCount: 0,
    });
    const common = computeBoosts(item, {
      ...NEUTRAL_FEATURES,
      deviceProfileKey: "1920x1080@29.97/h264",
      deviceProfileRecordingCount: 12,
    });
    expect(unseen.find((b) => b.type === "device_novelty")!.contribution).toBeGreaterThan(
      common.find((b) => b.type === "device_novelty")!.contribution,
    );
  });

  it("envelope-boundary captures boost; mid-envelope captures do not", () => {
    const item = makeItem({ id: "a" });
    const boundary = computeBoosts(item, {
      ...NEUTRAL_FEATURES,
      envelopeBoundaryDimensions: ["resolution", "frame_rate"],
    });
    const mid = computeBoosts(item, { ...NEUTRAL_FEATURES, envelopeBoundaryDimensions: [] });
    expect(boundary.find((b) => b.type === "envelope_boundary")!.contribution).toBe(
      BOOST_WEIGHTS.envelope_boundary.weight,
    );
    expect(mid.find((b) => b.type === "envelope_boundary")).toBeUndefined();
  });

  it("ownership/contact ambiguity evidence boosts; plain event items do not", () => {
    const ambiguous = makeItem({
      id: "a",
      modalities: ["ownership"],
      signals: [signal("ownership_audit_disagreement", 1.0)],
    });
    const plain = makeItem({
      id: "b",
      modalities: ["events"],
      signals: [signal("miner_uncertainty", 0.1)],
    });
    expect(
      computeBoosts(ambiguous, NEUTRAL_FEATURES).find((b) => b.type === "ambiguity")!.contribution,
    ).toBe(BOOST_WEIGHTS.ambiguity.weight);
    expect(computeBoosts(plain, NEUTRAL_FEATURES).find((b) => b.type === "ambiguity")).toBe(
      undefined,
    );
  });
});

describe("prioritizeHardCases", () => {
  it("ranks easy repetitive examples below informative ones on every axis", () => {
    const easy = scoreItem(
      makeItem({
        id: "easy/common-volley-repeat",
        signals: [signal("miner_uncertainty", 0.7 * 0.1)],
      }),
      EASY_FEATURES,
    );
    const disagreement = scoreItem(
      makeItem({
        id: "informative/audit-disagreement",
        modalities: ["ownership"],
        signals: [signal("ownership_audit_disagreement", 1.0)],
      }),
      EASY_FEATURES,
    );
    const uncertain = scoreItem(
      makeItem({
        id: "informative/high-uncertainty",
        signals: [signal("miner_uncertainty", 0.7 * 0.95)],
      }),
      EASY_FEATURES,
    );
    const rareStroke = scoreItem(
      makeItem({
        id: "informative/rare-stroke",
        signals: [signal("miner_uncertainty", 0.7 * 0.1)],
      }),
      { ...EASY_FEATURES, strokeClass: "SPEEDUP", strokeLabelCount: 0 },
    );
    const newEnvironment = scoreItem(
      makeItem({
        id: "informative/new-environment",
        sessionKey: "fresh-court-2026",
        signals: [signal("miner_uncertainty", 0.7 * 0.1)],
      }),
      { ...EASY_FEATURES, sessionLabeledItemCount: 0, deviceProfileRecordingCount: 0 },
    );
    const envelopeBoundary = scoreItem(
      makeItem({
        id: "informative/envelope-boundary",
        signals: [signal("miner_uncertainty", 0.7 * 0.1)],
      }),
      { ...EASY_FEATURES, envelopeBoundaryDimensions: ["resolution", "frame_rate"] },
    );
    const ood = scoreItem(
      makeItem({
        id: "informative/ood-boundary",
        sessionKey: "ood/negatives",
        signals: [signal("ood_boundary", 0.8)],
      }),
      NEUTRAL_FEATURES,
    );
    const contactAmbiguity = scoreItem(
      makeItem({
        id: "informative/contact-ambiguity",
        modalities: ["contact"],
        signals: [signal("hard_slice", 0.8)],
      }),
      EASY_FEATURES,
    );

    const ranked = prioritizeHardCases([
      easy,
      disagreement,
      uncertain,
      rareStroke,
      newEnvironment,
      envelopeBoundary,
      ood,
      contactAmbiguity,
    ]);
    const easyRank = ranked.find((item) => item.id === easy.id)!.rank;
    for (const informative of [
      disagreement,
      uncertain,
      rareStroke,
      newEnvironment,
      envelopeBoundary,
      ood,
      contactAmbiguity,
    ]) {
      expect(ranked.find((item) => item.id === informative.id)!.rank).toBeLessThan(easyRank);
    }
    expect(easyRank).toBe(ranked.length);
  });

  it("is deterministic: identical inputs produce identical order, ties break by id", () => {
    const a = scoreItem(makeItem({ id: "tie/a", signals: [signal("hard_slice", 0.8)] }), {
      ...NEUTRAL_FEATURES,
      sessionLabeledItemCount: 5,
    });
    const b = scoreItem(makeItem({ id: "tie/b", signals: [signal("hard_slice", 0.8)] }), {
      ...NEUTRAL_FEATURES,
      sessionLabeledItemCount: 5,
    });
    const first = prioritizeHardCases([b, a]);
    const second = prioritizeHardCases([a, b]);
    expect(first.map((item) => item.id)).toEqual(["tie/a", "tie/b"]);
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
  });

  it("enforces the per-session cap for queue diversity", () => {
    const items = ["s1/a", "s1/b", "s1/c", "s2/a"].map((id) =>
      scoreItem(
        makeItem({ id, sessionKey: id.split("/")[0]!, signals: [signal("hard_slice", 0.8)] }),
        NEUTRAL_FEATURES,
      ),
    );
    const ranked = prioritizeHardCases(items, { perSessionCap: 2 });
    expect(ranked.filter((item) => item.sessionKey === "s1")).toHaveLength(2);
    expect(ranked.filter((item) => item.sessionKey === "s2")).toHaveLength(1);
  });

  it("throws on held-out bundles and non-dev/val splits instead of silently skipping", () => {
    const heldOut = scoreItem(
      makeItem({ id: "leak/held-out", bundleId: "wm-dink-01", signals: [] }),
      NEUTRAL_FEATURES,
    );
    expect(() => prioritizeHardCases([heldOut])).toThrow(/held-out/);
    const lockedTest = scoreItem(
      makeItem({
        id: "leak/locked",
        split: "locked_test" as unknown as "dev",
        signals: [],
      }),
      NEUTRAL_FEATURES,
    );
    expect(() => prioritizeHardCases([lockedTest])).toThrow(/split/);
  });
});

describe("envelope + device feature extraction", () => {
  it("classifies a degraded-band probe as an envelope boundary and mid-envelope as none", () => {
    expect(
      envelopeBoundaryDimensionsFor({
        durationMs: 5000,
        fps: 18,
        width: 960,
        height: 540,
        videoCodec: "h264",
      }),
    ).toEqual(["resolution", "frame_rate"]);
    expect(
      envelopeBoundaryDimensionsFor({
        durationMs: 5000,
        fps: 29.97,
        width: 1920,
        height: 1080,
        videoCodec: "h264",
      }),
    ).toEqual([]);
  });

  it("builds a device profile key from the probe", () => {
    expect(
      deviceProfileKeyFor({
        durationMs: 5000,
        fps: 29.97,
        width: 1920,
        height: 1080,
        videoCodec: "h264",
      }),
    ).toBe("1920x1080@29.97/h264");
  });
});

describe("featuresForItem", () => {
  it("resolves features from committed context maps without fabricating missing signals", () => {
    const item = makeItem({
      id: "f/1",
      bundleId: "wavea-944403-smash",
      recordingId: "rec-1",
      sessionKey: "dvids-marne-2024",
    });
    const features = featuresForItem(item, {
      strokeByBundle: new Map([["wavea-944403-smash", "BACKHAND_VOLLEY"]]),
      strokeCounts: new Map([["BACKHAND_VOLLEY", 2]]),
      sessionLabelCounts: new Map([["dvids-marne-2024", 7]]),
      recordingsById: new Map([
        [
          "rec-1",
          {
            recordingId: "rec-1",
            sessionKey: "dvids-marne-2024",
            probe: { durationMs: 5000, fps: 29.97, width: 1920, height: 1080, videoCodec: "h264" },
          },
        ],
      ]),
      profileCounts: new Map([["1920x1080@29.97/h264", 9]]),
    });
    expect(features).toEqual({
      strokeClass: "BACKHAND_VOLLEY",
      strokeLabelCount: 2,
      sessionLabeledItemCount: 7,
      deviceProfileKey: "1920x1080@29.97/h264",
      deviceProfileRecordingCount: 9,
      envelopeBoundaryDimensions: [],
    });
    const noRecording = featuresForItem(makeItem({ id: "f/2" }), {
      strokeByBundle: new Map(),
      strokeCounts: new Map(),
      sessionLabelCounts: new Map(),
      recordingsById: new Map(),
      profileCounts: new Map(),
    });
    expect(noRecording.strokeClass).toBeNull();
    expect(noRecording.strokeLabelCount).toBeNull();
    expect(noRecording.deviceProfileKey).toBeNull();
    expect(noRecording.envelopeBoundaryDimensions).toEqual([]);
  });
});
