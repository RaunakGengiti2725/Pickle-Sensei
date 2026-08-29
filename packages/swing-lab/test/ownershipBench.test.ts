import { describe, expect, it } from "vitest";
import {
  applyOwnershipCorrections,
  bucketsFromNote,
  pickIncumbent,
  pickWristDistanceOnly,
  pickTargetGeometry,
  pickTemporalContinuity,
  scoreMethod,
  type AnnotationPass,
  type DualFrame,
  type OwnershipCorrectionSet,
  type PoseContext,
} from "../src/ownershipBench.js";

/**
 * Synthetic DualFrames with known geometry: these verify the harness's pick
 * and scoring math, not real-footage accuracy. Real numbers come from the
 * committed-data benchmark (pnpm ownership:bench).
 */

const pose = (over: Partial<PoseContext> = {}): PoseContext => ({
  targetWrists: [{ x: 0.3, y: 0.5 }],
  otherWrists: [{ x: 0.7, y: 0.5 }],
  torsoMid: { x: 0.3, y: 0.4 },
  torsoSpan: 0.2,
  videoH: 1080,
  ...over,
});

const frame = (over: Partial<DualFrame> = {}): DualFrame => ({
  caseId: "synthetic",
  group: "synthetic-group",
  split: "dev",
  tMs: 0,
  candidates: [
    { point: { x: 0.32, y: 0.52 }, owner: "target", annotatorId: "t" },
    { point: { x: 0.68, y: 0.52 }, owner: "other", annotatorId: "t" },
  ],
  buckets: ["clean"],
  pose: pose(),
  ...over,
});

describe("bucketsFromNote", () => {
  it("maps note phrases to buckets", () => {
    expect(bucketsFromNote("edge-on blade, dark paddle, motion blur, behind net post", 2)).toEqual([
      "blur",
      "dark_on_dark",
      "edge_on",
      "net_post_occlusion",
    ]);
  });
  it("adds multi_paddle at 3+ candidates and clean when nothing matches", () => {
    expect(bucketsFromNote(undefined, 3)).toEqual(["multi_paddle"]);
    expect(bucketsFromNote("nothing notable", 2)).toEqual(["clean"]);
  });
});

describe("pickIncumbent", () => {
  it("abstains without pose", () => {
    expect(pickIncumbent(frame({ pose: null })).index).toBeNull();
  });
  it("picks the target-adjacent candidate and vetoes the other-owned one", () => {
    expect(pickIncumbent(frame()).index).toBe(0);
  });
  it("abstains when every candidate is decisively other-owned", () => {
    const f = frame({
      candidates: [{ point: { x: 0.69, y: 0.5 }, owner: "other", annotatorId: "t" }],
    });
    expect(pickIncumbent(f).index).toBeNull();
  });
});

describe("pickWristDistanceOnly", () => {
  it("has no other-wrist veto: picks nearest target wrist even when other-owned", () => {
    const f = frame({
      candidates: [{ point: { x: 0.69, y: 0.5 }, owner: "other", annotatorId: "t" }],
    });
    expect(pickWristDistanceOnly(f).index).toBe(0);
    expect(pickIncumbent(f).index).toBeNull();
  });
});

describe("pickTargetGeometry", () => {
  it("prefers the candidate nearest the target torso", () => {
    expect(pickTargetGeometry(frame()).index).toBe(0);
  });
  it("abstains on degenerate torso span", () => {
    expect(pickTargetGeometry(frame({ pose: pose({ torsoSpan: 0 }) })).index).toBeNull();
  });
});

describe("pickTemporalContinuity", () => {
  it("seeds the first frame and then follows the previous pick", () => {
    const f1 = frame({ tMs: 0 });
    const f2 = frame({
      tMs: 100,
      candidates: [
        { point: { x: 0.33, y: 0.53 }, owner: "target", annotatorId: "t" },
        { point: { x: 0.9, y: 0.9 }, owner: "other", annotatorId: "t" },
      ],
    });
    const picks = pickTemporalContinuity([f1, f2]);
    expect(picks[0]!.seeded).toBe(true);
    expect(picks[1]).toMatchObject({ seeded: false, index: 0 });
  });
  it("falls back to a disclosed gold seed when pose is absent", () => {
    const picks = pickTemporalContinuity([frame({ pose: null })]);
    expect(picks[0]).toMatchObject({ seeded: true, seedSource: "gold" });
  });
});

describe("scoreMethod", () => {
  const frames = [
    frame({ tMs: 0 }),
    frame({ tMs: 100, buckets: ["edge_on"] }),
    frame({ tMs: 200, pose: null }),
  ];
  it("counts abstentions as not-correct and tracks buckets/groups", () => {
    const picks = [
      { index: 0, reason: "" },
      { index: 1, reason: "" },
      { index: null, reason: "" },
    ];
    const report = scoreMethod("b1_wrist_distance_only", frames, picks);
    expect(report.scoredFrames).toBe(3);
    expect(report.correct).toBe(1);
    expect(report.abstained).toBe(1);
    expect(report.accuracy).toBeCloseTo(1 / 3);
    expect(report.accuracyWhenAnswering).toBe(0.5);
    expect(report.coverage).toBeCloseTo(2 / 3);
    expect(report.byBucket.edge_on).toMatchObject({ n: 1, correct: 0, smallN: true });
    expect(report.byGroup["synthetic-group"]!.n).toBe(3);
    expect(report.failures).toHaveLength(2);
  });
  it("pose subset drops frames without pose and seed frames never score", () => {
    const picks = [
      { index: 0, reason: "", seeded: true },
      { index: 0, reason: "", seeded: false },
      { index: 0, reason: "", seeded: false },
    ];
    const report = scoreMethod("b3_temporal_continuity", frames, picks, "pose");
    expect(report.scoredFrames).toBe(1);
    expect(report.correct).toBe(1);
  });
});

describe("applyOwnershipCorrections", () => {
  const passes = (): AnnotationPass[] => [
    {
      annotatorId: "waveC",
      paddleFrames: [{ tMs: 100, point: { x: 0.3, y: 0.54 }, visibility: "visible" }],
      otherPaddleFrames: [{ tMs: 100, point: { x: 0.7, y: 0.4 }, visibility: "visible" }],
    },
  ];
  const set = (corrections: OwnershipCorrectionSet["corrections"]): OwnershipCorrectionSet => ({
    kind: "ownership-correction-set",
    captureBundle: "synthetic",
    annotatorId: "waveE",
    corrections,
  });
  it("supersedes a matching point in place without touching others", () => {
    const input = passes();
    const application = applyOwnershipCorrections(input, [
      set([
        {
          adjudicationId: "ADJ-1",
          tMs: 100,
          owner: "target",
          action: "supersede-point",
          originalPoint: { x: 0.3, y: 0.54 },
          point: { x: 0.29, y: 0.45 },
        },
      ]),
    ]);
    expect(application).toEqual({ superseded: 1, added: 0, unmatched: [] });
    expect(input[0]!.paddleFrames[0]!.point).toEqual({ x: 0.29, y: 0.45 });
    expect(input[0]!.otherPaddleFrames[0]!.point).toEqual({ x: 0.7, y: 0.4 });
  });
  it("adds visible frames under the correction set's annotatorId", () => {
    const input = passes();
    const application = applyOwnershipCorrections(input, [
      set([
        {
          adjudicationId: "ADJ-2",
          tMs: 100,
          owner: "other",
          action: "add-visible",
          point: { x: 0.65, y: 0.51 },
        },
      ]),
    ]);
    expect(application).toEqual({ superseded: 0, added: 1, unmatched: [] });
    expect(input).toHaveLength(2);
    expect(input[1]!.annotatorId).toBe("waveE");
    expect(input[1]!.otherPaddleFrames).toEqual([
      { tMs: 100, point: { x: 0.65, y: 0.51 }, visibility: "visible" },
    ]);
  });
  it("reports supersede corrections whose original cannot be located", () => {
    const input = passes();
    const application = applyOwnershipCorrections(input, [
      set([
        {
          adjudicationId: "ADJ-3",
          tMs: 100,
          owner: "target",
          action: "supersede-point",
          originalPoint: { x: 0.9, y: 0.9 },
          point: { x: 0.5, y: 0.5 },
        },
      ]),
    ]);
    expect(application).toEqual({ superseded: 0, added: 0, unmatched: ["ADJ-3"] });
    expect(input[0]!.paddleFrames[0]!.point).toEqual({ x: 0.3, y: 0.54 });
  });
});
